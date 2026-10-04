/**
 * ClawMem HTTP REST API Server
 *
 * REST interface over ClawMem's search, retrieval, and lifecycle operations.
 * Modeled after Engram's server.go — simple JSON handlers, localhost-only by default.
 *
 * Usage:
 *   clawmem serve [--port 7438] [--host 127.0.0.1] [--no-token]
 *
 * Every request passes the transport guard first (BACKLOG 62.4, `server-guard.ts`): a foreign Origin or Host is refused,
 * CORS answers an allowed origin exactly, every route needs `Authorization: Bearer <token>` (the token from
 * CLAWMEM_API_TOKEN or the generated token file), and every POST carries a JSON Content-Type. The token stops web pages;
 * it is not authority against a same-user process, which can read it.
 */

import type { Server } from "bun";
import { isoNow, toDate, epochNow, epochAfter, duration } from "./clock.ts";
import type { Store, SearchResult, TimelineResult } from "./store.ts";
import { enrichResults } from "./search-utils.ts";
import { applyCompositeScoring, hasRecencyIntent, type EnrichedResult } from "./memory.ts";
import { applyMMRDiversity } from "./mmr.ts";
import { listCollections } from "./collections.ts";
import { runCausalRetrieval, hasCausalSignal, hasTimelineSignal } from "./causal-retrieval.ts";
import { capCausalWire } from "./causal-reader.ts";
import { getDefaultLlamaCpp } from "./llm.ts";
import { notLegacyArtifactSql } from "./compaction-state.ts";
import {
  checkRequest,
  corsHeaders,
  isJsonContentType,
  preflightHeaders,
  resolveServeGuard,
  resolveServeToken,
  ServeConfigError,
  serveWarnings,
  tokensEqual,
  validToken,
  type ServeGuard,
  type ServeToken,
} from "./server-guard.ts";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  extractSnippet,
  rethrowIfFatalVectorError,
} from "./store.ts";

// =============================================================================
// Types
// =============================================================================

type RouteHandler = (req: Request, url: URL, store: Store) => Promise<Response> | Response;

// =============================================================================
// Auth
// =============================================================================

/** True when `req` carries `Authorization: Bearer <token>` for exactly this token (compared in constant time). */
function authorized(req: Request, token: string): boolean {
  const m = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m !== null && tokensEqual(m[1]!, token);
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="clawmem"' },
  });
}

// =============================================================================
// JSON Helpers
// =============================================================================

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function jsonError(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

/** The JSON body of a POST — the transport guard has already required its JSON Content-Type. */
async function parseBody<T>(req: Request): Promise<T | null> {
  try {
    return await req.json() as T;
  } catch {
    return null;
  }
}

function queryParam(url: URL, key: string, defaultValue?: string): string | undefined {
  return url.searchParams.get(key) ?? defaultValue;
}

function queryInt(url: URL, key: string, defaultValue: number): number {
  const val = url.searchParams.get(key);
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function queryBool(url: URL, key: string, defaultValue: boolean): boolean {
  const val = url.searchParams.get(key);
  if (val === null) return defaultValue;
  return val === "true" || val === "1";
}

// =============================================================================
// Route Handlers
// =============================================================================

// --- Health ---

function handleHealth(_req: Request, _url: URL, store: Store): Response {
  const status = store.getStatus();
  return jsonResponse({
    status: "ok",
    service: "clawmem",
    version: "0.2.0",
    database: store.dbPath,
    documents: status.totalDocuments,
    needsEmbedding: status.needsEmbedding,
    hasVectors: status.hasVectorIndex,
  });
}

// --- Stats ---

function handleStats(_req: Request, _url: URL, store: Store): Response {
  const status = store.getStatus();
  const health = store.getIndexHealth();
  return jsonResponse({
    ...status,
    health,
    collections: status.collections,
  });
}

// --- Unified Search ---

async function handleSearch(req: Request, _url: URL, store: Store): Promise<Response> {
  const body = await parseBody<{
    query: string;
    mode?: "auto" | "keyword" | "semantic" | "hybrid";
    collection?: string;
    compact?: boolean;
    limit?: number;
    intent?: string;
  }>(req);

  if (!body?.query) return jsonError("query is required");

  const query = body.query;
  const mode = body.mode ?? "auto";
  const limit = Math.min(body.limit ?? 10, 50);
  const compact = body.compact ?? true;
  const collections = body.collection ? body.collection.split(",").map(c => c.trim()) : undefined;

  let results: SearchResult[];

  if (mode === "keyword" || (mode === "auto" && query.split(/\s+/).length <= 3)) {
    results = store.searchFTS(query, limit * 2, undefined, collections);
  } else if (mode === "semantic") {
    try {
      results = await store.searchVec(query, DEFAULT_EMBED_MODEL, limit * 2, undefined, collections);
    } catch (e) {
      rethrowIfFatalVectorError(e);
      results = store.searchFTS(query, limit * 2, undefined, collections);
    }
  } else {
    // hybrid — BM25 + vector
    const ftsResults = store.searchFTS(query, limit * 2, undefined, collections);
    let vecResults: SearchResult[] = [];
    try {
      vecResults = await store.searchVec(query, DEFAULT_EMBED_MODEL, limit * 2, undefined, collections);
    } catch (e) { rethrowIfFatalVectorError(e); /* vector unavailable */ }
    // Simple merge — dedupe by filepath, take max score
    const merged = new Map<string, SearchResult>();
    for (const r of [...ftsResults, ...vecResults]) {
      const existing = merged.get(r.filepath);
      if (!existing || r.score > existing.score) {
        merged.set(r.filepath, r);
      }
    }
    results = Array.from(merged.values());
  }

  // Enrich with SAME metadata + composite scoring
  const enriched = enrichResults(store, results, query);
  const scored = applyCompositeScoring(enriched, query, (path) => store.getCoActivated(path));
  const diverse = applyMMRDiversity(scored);
  const final = diverse.slice(0, limit);

  if (compact) {
    return jsonResponse({
      query,
      mode,
      count: final.length,
      results: final.map(r => ({
        docid: r.docid,
        path: r.displayPath,
        title: r.title,
        score: Math.round(r.compositeScore * 1000) / 1000,
        contentType: r.contentType,
        snippet: extractSnippet(r.body || "", query, 200).snippet,
      })),
    });
  }

  return jsonResponse({
    query,
    mode,
    count: final.length,
    results: final.map(r => ({
      docid: r.docid,
      path: r.displayPath,
      title: r.title,
      score: Math.round(r.compositeScore * 1000) / 1000,
      contentType: r.contentType,
      modifiedAt: r.modifiedAt,
      confidence: r.confidence,
      body: r.body,
    })),
  });
}

// --- Document by docid or path ---

function handleGetDocument(_req: Request, url: URL, store: Store): Response {
  const docid = url.pathname.split("/").pop();
  if (!docid) return jsonError("docid is required");

  const result = store.findDocument(docid, { includeBody: true });
  if ("error" in result) {
    return jsonError(`Document not found: ${docid}`, 404);
  }

  return jsonResponse({
    docid: result.docid,
    path: result.displayPath,
    title: result.title,
    collection: result.collectionName,
    modifiedAt: result.modifiedAt,
    bodyLength: result.bodyLength,
    body: result.body,
    context: result.context,
  });
}

// --- Multi-get by pattern ---

function handleGetDocuments(_req: Request, url: URL, store: Store): Response {
  const pattern = queryParam(url, "pattern");
  if (!pattern) return jsonError("pattern query parameter is required");

  const maxBytes = queryInt(url, "max_bytes", 10240);
  const { docs, errors } = store.findDocuments(pattern, { includeBody: true, maxBytes });

  const resolved = docs.filter(d => !d.skipped).map(d => d.doc);
  return jsonResponse({
    pattern,
    count: resolved.length,
    errors,
    documents: resolved.map(d => ({
      docid: d.docid,
      path: d.displayPath,
      title: d.title,
      collection: d.collectionName,
      modifiedAt: d.modifiedAt,
      bodyLength: d.bodyLength,
      body: d.body,
    })),
  });
}

// --- Timeline ---

function handleTimeline(_req: Request, url: URL, store: Store): Response {
  const docid = url.pathname.split("/").pop();
  if (!docid) return jsonError("docid is required");

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docid}`, 404);

  const doc = store.db.prepare(
    "SELECT id FROM documents WHERE hash = ? AND active = 1 LIMIT 1"
  ).get(resolved.hash) as { id: number } | undefined;

  if (!doc) return jsonError(`Document not found: ${docid}`, 404);

  const before = queryInt(url, "before", 5);
  const after = queryInt(url, "after", 5);
  const sameCollection = queryBool(url, "same_collection", false);

  try {
    const result = store.timeline(doc.id, { before, after, sameCollection });
    return jsonResponse(result);
  } catch (err: any) {
    return jsonError(err.message, 404);
  }
}

// --- Sessions ---

function handleSessions(_req: Request, url: URL, store: Store): Response {
  const limit = queryInt(url, "limit", 10);
  const sessions = store.getRecentSessions(limit);
  return jsonResponse({ count: sessions.length, sessions });
}

// --- Collections ---

function handleCollections(_req: Request, _url: URL, store: Store): Response {
  const status = store.getStatus();
  return jsonResponse({
    count: status.collections.length,
    collections: status.collections,
  });
}

// --- Profile ---

function handleProfile(_req: Request, _url: URL, store: Store): Response {
  // Search for profile doc
  const profileResults = store.searchFTS("profile", 1);
  if (profileResults.length === 0) {
    return jsonResponse({ profile: null, message: "No profile found" });
  }
  const body = store.getDocumentBody(profileResults[0]!);
  return jsonResponse({
    path: profileResults[0]!.displayPath,
    body,
  });
}

// --- Causal Links ---

function handleCausalLinks(_req: Request, url: URL, store: Store): Response {
  const docid = url.pathname.split("/").pop();
  if (!docid) return jsonError("docid is required");
  // s342 D4: every exit is byte-bounded — the caller-controlled docid is
  // display-bounded before ANY echo (error bodies included).
  const docidEcho = docid.slice(0, 256);

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docidEcho}`, 404);

  // s342: anchor eligibility — the reader enforces the same predicate on every
  // recursive expansion; an invalidated anchor resolves to nothing here.
  const doc = store.db.prepare(
    "SELECT id FROM documents WHERE hash = ? AND active = 1 AND invalidated_at IS NULL LIMIT 1"
  ).get(resolved.hash) as { id: number } | undefined;
  if (!doc) return jsonError(`Document not found: ${docidEcho}`, 404);

  // Validate against the enum — never echo caller-controlled junk into the body.
  const rawDirection = queryParam(url, "direction", "both") ?? "both";
  if (rawDirection !== "causes" && rawDirection !== "caused_by" && rawDirection !== "both") {
    return jsonError("direction must be causes | caused_by | both");
  }
  const direction = rawDirection as "causes" | "caused_by" | "both";
  const depth = queryInt(url, "depth", 5);

  // Evidence-preserving directed edge records; the COMPLETE body is capped at
  // CAUSAL_READER_MAX_BYTES with whole-edge truncation in the reader's
  // deterministic total order, and the overflow envelope backstops the ceiling
  // unconditionally.
  const { edges, truncated } = store.findCausalLinks(doc.id, direction, depth);
  const body = capCausalWire(edges, truncated, (kept, isTruncated) => ({
    docid: docidEcho, direction, depth, count: kept.length, truncated: isTruncated, links: kept,
  }), () => ({
    docid: docidEcho, direction, depth, count: 0, truncated: true, overflow: true, links: [],
  }));
  return jsonResponse(body);
}

// --- Similar Documents ---

function handleSimilar(_req: Request, url: URL, store: Store): Response {
  const docid = url.pathname.split("/").pop();
  if (!docid) return jsonError("docid is required");

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docid}`, 404);

  const limit = queryInt(url, "limit", 5);
  const similar = store.findSimilarFiles(docid, undefined, limit);

  return jsonResponse({ docid, count: similar.length, similar });
}

// --- Evolution History ---

function handleEvolution(_req: Request, url: URL, store: Store): Response {
  const docid = url.pathname.split("/").pop();
  if (!docid) return jsonError("docid is required");

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docid}`, 404);

  const doc = store.db.prepare(
    "SELECT id, title FROM documents WHERE hash = ? AND active = 1 LIMIT 1"
  ).get(resolved.hash) as { id: number; title: string } | undefined;
  if (!doc) return jsonError(`Document not found: ${docid}`, 404);

  const limit = queryInt(url, "limit", 10);
  const timeline = store.getEvolutionTimeline(doc.id, limit);

  return jsonResponse({ docid, title: doc.title, count: timeline.length, evolution: timeline });
}

// --- Lifecycle Status ---

function handleLifecycleStatus(_req: Request, _url: URL, store: Store): Response {
  const stats = store.getLifecycleStats();
  return jsonResponse(stats);
}

// --- Lifecycle Sweep ---

async function handleLifecycleSweep(req: Request, _url: URL, store: Store): Promise<Response> {
  const body = await parseBody<{ dry_run?: boolean }>(req);
  const dryRun = body?.dry_run ?? true;

  // Load lifecycle policy from config
  const { loadVaultConfig } = await import("./config.ts");
  const config = loadVaultConfig();
  const policy = config.lifecycle
    ?? { archive_after_days: 90, type_overrides: {}, purge_after_days: null, exempt_collections: [], dry_run: dryRun };

  if (!policy) return jsonError("No lifecycle policy configured");

  const candidates = store.getArchiveCandidates(policy);

  if (dryRun) {
    return jsonResponse({
      dry_run: true,
      candidates: candidates.length,
      documents: candidates.map(c => ({
        id: c.id,
        path: `${c.collection}/${c.path}`,
        title: c.title,
        content_type: c.content_type,
        modified_at: c.modified_at,
        last_accessed_at: c.last_accessed_at,
      })),
    });
  }

  const archived = store.archiveDocuments(candidates.map(c => c.id));
  return jsonResponse({ dry_run: false, archived });
}

// --- Lifecycle Restore ---

async function handleLifecycleRestore(req: Request, _url: URL, store: Store): Promise<Response> {
  const body = await parseBody<{ query?: string; collection?: string }>(req);

  const filter: { ids?: number[]; collection?: string; sinceDate?: string } = {};
  if (body?.collection) filter.collection = body.collection;

  const restored = store.restoreArchivedDocuments(filter);
  return jsonResponse({ restored });
}

// --- Pin ---

async function handlePin(req: Request, url: URL, store: Store): Promise<Response> {
  const docid = url.pathname.split("/").slice(-2, -1)[0];
  if (!docid) return jsonError("docid is required");

  const body = await parseBody<{ unpin?: boolean }>(req);
  const unpin = body?.unpin ?? false;

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docid}`, 404);

  const doc = store.db.prepare(
    "SELECT id, collection, path FROM documents WHERE hash = ? AND active = 1 LIMIT 1"
  ).get(resolved.hash) as { id: number; collection: string; path: string } | undefined;
  if (!doc) return jsonError(`Document not found: ${docid}`, 404);

  store.pinDocument(doc.collection, doc.path, !unpin);
  return jsonResponse({ docid, pinned: !unpin });
}

// --- Snooze ---

async function handleSnooze(req: Request, url: URL, store: Store): Promise<Response> {
  const docid = url.pathname.split("/").slice(-2, -1)[0];
  if (!docid) return jsonError("docid is required");

  const body = await parseBody<{ until?: string; unsnooze?: boolean }>(req);

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docid}`, 404);

  const doc = store.db.prepare(
    "SELECT id, collection, path FROM documents WHERE hash = ? AND active = 1 LIMIT 1"
  ).get(resolved.hash) as { id: number; collection: string; path: string } | undefined;
  if (!doc) return jsonError(`Document not found: ${docid}`, 404);

  const until = body?.unsnooze ? null : (body?.until ?? toDate(epochAfter(epochNow(), duration(30 * 86400000))).toISOString());
  store.snoozeDocument(doc.collection, doc.path, until);
  return jsonResponse({ docid, snoozed: !body?.unsnooze, until });
}

// --- Forget ---

async function handleForget(_req: Request, url: URL, store: Store): Promise<Response> {
  const docid = url.pathname.split("/").slice(-2, -1)[0];
  if (!docid) return jsonError("docid is required");

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docid}`, 404);

  const doc = store.db.prepare(
    "SELECT id, collection, path FROM documents WHERE hash = ? AND active = 1 LIMIT 1"
  ).get(resolved.hash) as { id: number; collection: string; path: string } | undefined;
  if (!doc) return jsonError(`Document not found: ${docid}`, 404);

  store.deactivateDocument(doc.collection, doc.path, "forget");
  return jsonResponse({ docid, forgotten: true });
}

// --- Reindex ---

async function handleReindex(req: Request, _url: URL, store: Store): Promise<Response> {
  const body = await parseBody<{ collection?: string }>(req);

  const { indexCollection } = await import("./indexer.ts");
  const collections = listCollections();
  const targetCollections = body?.collection
    ? collections.filter(c => c.name === body.collection)
    : collections;

  if (targetCollections.length === 0) {
    return jsonError(`Collection not found: ${body?.collection}`, 404);
  }

  let totalAdded = 0, totalUpdated = 0, totalRemoved = 0;
  let enrichAttempted = 0, enrichStored = 0;

  for (const coll of targetCollections) {
    const stats = await indexCollection(store, coll.name, coll.path, coll.pattern);
    totalAdded += stats.added;
    totalUpdated += stats.updated;
    totalRemoved += stats.removed;
    enrichAttempted += stats.enrichAttempted;
    enrichStored += stats.enrichStored;
  }

  // Issue #24 (codex turn-2 finding 3): the REST surface must carry the note
  // counters too — a reindex whose every enrichment produced nothing is not an
  // unqualified success, whichever surface invoked it.
  return jsonResponse({
    collections: targetCollections.length,
    added: totalAdded,
    updated: totalUpdated,
    removed: totalRemoved,
    enrichAttempted,
    enrichStored,
  });
}

// --- Export ---

function handleExport(_req: Request, url: URL, store: Store): Response {
  // An export returns the body of every active document, named by nobody, so by default the legacy
  // pre-compaction snapshot is left out, as from a glob (62.2). `?full=true` asks for it explicitly: every
  // active document. (Neither is a backup of the vault: inactive rows and other tables are not exported.)
  // The response counts what the default left out, so the omission is never silent.
  const full = queryBool(url, "full", false);
  const docs = store.db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, d.content_type, d.confidence,
           d.access_count, d.quality_score, d.pinned, d.created_at, d.modified_at,
           d.duplicate_count, d.revision_count, d.topic_key, d.normalized_hash,
           c.doc as body
    FROM documents d
    JOIN content c ON c.hash = d.hash
    WHERE d.active = 1${full ? "" : ` AND ${notLegacyArtifactSql("d", "c.doc")}`}
    ORDER BY d.collection, d.path
  `).all() as any[];
  const excluded = full ? 0 : (store.db.prepare(
    `SELECT COUNT(*) AS n FROM documents d WHERE d.active = 1 AND NOT ${notLegacyArtifactSql("d")}`
  ).get() as { n: number }).n;

  return jsonResponse({
    version: "1.0.0",
    exported_at: isoNow(),
    count: docs.length,
    full,
    legacy_snapshots_excluded: excluded,
    documents: docs,
  });
}

// --- Build Graphs ---

async function handleBuildGraphs(req: Request, _url: URL, store: Store): Promise<Response> {
  const body = await parseBody<{ temporal?: boolean; semantic?: boolean }>(req);
  const doTemporal = body?.temporal ?? true;
  const doSemantic = body?.semantic ?? true;

  let temporalEdges = 0, semanticEdges = 0;

  if (doTemporal) {
    temporalEdges = store.buildTemporalBackbone();
  }
  if (doSemantic) {
    semanticEdges = await store.buildSemanticGraph();
  }

  // Same COUNTING semantics as the MCP `build_graphs` tool: the builders count rows actually
  // inserted, so an idempotent rebuild legitimately returns 0 new edges. Report the standing
  // totals alongside, or a caller reads "0" as "the graph is empty".
  //
  // The response SHAPE deliberately differs from MCP and always carries all four keys. That
  // is this endpoint's pre-existing contract — it emitted both `temporal` and `semantic`
  // unconditionally before totals existed — whereas the MCP tool includes only the graph
  // types that were requested. Narrowing REST to match would break existing callers; the
  // difference is stated here rather than papered over.
  //
  // Counts only edges whose BOTH endpoints are active — the same population the builders
  // operate on. Shared with the MCP tool via the store so the two cannot drift.
  const totalFor = (t: string) => store.countActiveRelations(t);

  return jsonResponse({
    temporal: temporalEdges,
    semantic: semanticEdges,
    temporalTotal: totalFor("temporal"),
    semanticTotal: totalFor("semantic"),
  });
}

// --- Unified Retrieve (mirrors memory_retrieve from MCP) ---

function classifyRetrievalMode(query: string): "keyword" | "semantic" | "causal" | "timeline" | "hybrid" {
  const q = query.toLowerCase();
  // Shared signal source with the MCP classifier (causal-retrieval.ts). The REST copy used to
  // recognize neither "why were" nor "because we", so those queries never routed causal here.
  if (hasTimelineSignal(q)) return "timeline";
  if (hasCausalSignal(q)) return "causal";
  if (q.length < 50 && (/[A-Z][A-Z0-9_]{2,}/.test(query) || /[\w-]+\.\w{2,4}\b/.test(q.trim()))) return "keyword";
  if (/\b(how does|explain|concept|overview|understand|what is the purpose)\b/i.test(q)) return "semantic";
  return "hybrid";
}

async function handleRetrieve(req: Request, _url: URL, store: Store): Promise<Response> {
  const body = await parseBody<{
    query: string;
    mode?: "auto" | "keyword" | "semantic" | "causal" | "timeline" | "hybrid";
    collection?: string;
    compact?: boolean;
    limit?: number;
  }>(req);

  if (!body?.query) return jsonError("query is required");

  const query = body.query;
  const requestedMode = body.mode ?? "auto";
  const mode = requestedMode === "auto" ? classifyRetrievalMode(query) : requestedMode;
  const limit = Math.min(body.limit ?? 10, 50);
  const compact = body.compact ?? true;
  const collections = body.collection ? body.collection.split(",").map(c => c.trim()) : undefined;

  let results: SearchResult[];

  if (mode === "timeline") {
    // Delegate to session log
    const sessions = store.getRecentSessions(limit);
    const lines = sessions.map(s => {
      const dur = s.endedAt
        ? `${Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60000)}min`
        : "active";
      return `${s.sessionId.slice(0, 8)} ${s.startedAt} (${dur})${s.summary ? " — " + s.summary.slice(0, 100) : ""}`;
    });
    return jsonResponse({ query, mode: "timeline", count: sessions.length, results: lines });
  }

  if (mode === "causal") {
    // Shared intent-aware causal pipeline (v0.32.0). REST's shipped posture is preserved as an
    // EXPLICIT allowAll policy — nothing is internally filtered here, matching every other REST
    // mode. The graph stages (adaptive traversal, MPFP, causal one-hop, rerank) are NEW REST
    // capability, documented in docs/reference/rest-api.md; entity expansion stays off — its
    // only home is direct intent_search. A REST-wide visibility option is a later slice.
    const llm = getDefaultLlamaCpp();
    const causal = await runCausalRetrieval(store, llm, query, {
      stages: { traversal: true, mpfp: true, entityExpansion: false, rerank: true, causalOneHop: true },
      baseEligibility: { allowCollections: collections },
      whyObservationLane: false,
    });
    results = causal.results;
  } else if (mode === "keyword") {
    results = store.searchFTS(query, limit * 2, undefined, collections);
  } else if (mode === "semantic") {
    try {
      results = await store.searchVec(query, DEFAULT_EMBED_MODEL, limit * 2, undefined, collections);
    } catch (e) {
      rethrowIfFatalVectorError(e);
      results = store.searchFTS(query, limit * 2, undefined, collections);
    }
  } else {
    // hybrid
    const fts = store.searchFTS(query, limit * 2, undefined, collections);
    let vec: SearchResult[] = [];
    try {
      vec = await store.searchVec(query, DEFAULT_EMBED_MODEL, limit * 2, undefined, collections);
    } catch (e) { rethrowIfFatalVectorError(e); /* vector unavailable */ }
    const merged = new Map<string, SearchResult>();
    for (const r of [...fts, ...vec]) {
      const existing = merged.get(r.filepath);
      if (!existing || r.score > existing.score) merged.set(r.filepath, r);
    }
    results = Array.from(merged.values());
  }

  const enriched = enrichResults(store, results, query);
  const scored = applyCompositeScoring(enriched, query, (path) => store.getCoActivated(path));
  const diverse = applyMMRDiversity(scored);
  const final = diverse.slice(0, limit);

  if (compact) {
    return jsonResponse({
      query, mode, count: final.length,
      results: final.map(r => ({
        docid: r.docid, path: r.displayPath, title: r.title,
        score: Math.round(r.compositeScore * 1000) / 1000,
        contentType: r.contentType,
        snippet: extractSnippet(r.body || "", query, 200).snippet,
      })),
    });
  }

  return jsonResponse({
    query, mode, count: final.length,
    results: final.map(r => ({
      docid: r.docid, path: r.displayPath, title: r.title,
      score: Math.round(r.compositeScore * 1000) / 1000,
      contentType: r.contentType, modifiedAt: r.modifiedAt,
      confidence: r.confidence, body: r.body,
    })),
  });
}

// =============================================================================
// Router
// =============================================================================

type Route = {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
};

const routes: Route[] = [
  // Health & Stats
  { method: "GET",  pattern: /^\/health$/,                 handler: handleHealth },
  { method: "GET",  pattern: /^\/stats$/,                  handler: handleStats },

  // Search & Retrieve
  { method: "POST", pattern: /^\/search$/,                 handler: handleSearch },
  { method: "POST", pattern: /^\/retrieve$/,               handler: handleRetrieve },

  // Documents
  { method: "GET",  pattern: /^\/documents$/,              handler: handleGetDocuments },
  { method: "GET",  pattern: /^\/documents\/([^/]+)$/,     handler: handleGetDocument },

  // Timeline
  { method: "GET",  pattern: /^\/timeline\/([^/]+)$/,      handler: handleTimeline },

  // Sessions
  { method: "GET",  pattern: /^\/sessions$/,               handler: handleSessions },

  // Collections
  { method: "GET",  pattern: /^\/collections$/,            handler: handleCollections },

  // Profile
  { method: "GET",  pattern: /^\/profile$/,                handler: handleProfile },

  // Graph
  { method: "GET",  pattern: /^\/graph\/causal\/([^/]+)$/, handler: handleCausalLinks },
  { method: "GET",  pattern: /^\/graph\/similar\/([^/]+)$/,handler: handleSimilar },
  { method: "GET",  pattern: /^\/graph\/evolution\/([^/]+)$/,handler: handleEvolution },

  // Lifecycle
  { method: "GET",  pattern: /^\/lifecycle\/status$/,      handler: handleLifecycleStatus },
  { method: "POST", pattern: /^\/lifecycle\/sweep$/,       handler: handleLifecycleSweep },
  { method: "POST", pattern: /^\/lifecycle\/restore$/,     handler: handleLifecycleRestore },

  // Document mutations
  { method: "POST", pattern: /^\/documents\/([^/]+)\/pin$/,    handler: handlePin },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/snooze$/, handler: handleSnooze },
  { method: "POST", pattern: /^\/documents\/([^/]+)\/forget$/, handler: handleForget },

  // Maintenance
  { method: "POST", pattern: /^\/reindex$/,                handler: handleReindex },
  { method: "POST", pattern: /^\/graphs\/build$/,          handler: handleBuildGraphs },

  // Export
  { method: "GET",  pattern: /^\/export$/,                 handler: handleExport },
];

function matchRoute(method: string, pathname: string): RouteHandler | null {
  for (const route of routes) {
    if (route.method === method && route.pattern.test(pathname)) {
      return route.handler;
    }
  }
  return null;
}

// =============================================================================
// Server
// =============================================================================

export type ServeOptions = {
  /**
   * The token every request must carry: a string, or what `resolveServeToken` returned (its file feeds the startup
   * warnings). Absent: CLAWMEM_API_TOKEN, else the token file (created on first use).
   */
  token?: string | ServeToken;
  /** Serve with no token (`clawmem serve --no-token`). Refused unless the bind is loopback; the guard stays on. */
  noToken?: boolean;
  /** Where the token file lives; defaults to CLAWMEM_CONFIG_DIR or ~/.config/clawmem. */
  configDir?: string;
  /** Extra Host names (else CLAWMEM_ALLOWED_HOSTS) and browser origins (else CLAWMEM_ALLOWED_ORIGINS) to accept. */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  env?: Record<string, string | undefined>;
};

/**
 * Starts the REST server. The guard and the token are resolved before it binds, so a configuration it refuses throws
 * ServeConfigError (whose message never holds a token) instead of serving; what the configuration leaves open is
 * logged as a warning on stderr.
 */
export function startServer(store: Store, port: number = 7438, host: string = "127.0.0.1", opts: ServeOptions = {}) {
  const env = opts.env ?? process.env;
  const guard = resolveServeGuard({ host, env, allowedHosts: opts.allowedHosts, allowedOrigins: opts.allowedOrigins });
  if (opts.noToken && !guard.loopbackBind) {
    throw new ServeConfigError(`--no-token is refused on a non-loopback bind (${host}): there the token is the only gate`);
  }
  let token: string | null = null;
  let tokenFile: string | null = null;
  if (!opts.noToken) {
    const given = typeof opts.token === "string" ? { token: opts.token } : opts.token;
    if (given !== undefined && !validToken(given.token)) throw new ServeConfigError("the token option is not a valid token");
    const resolved: { token: string; source?: string; path?: string } = given ?? resolveServeToken({ env, configDir: opts.configDir });
    token = resolved.token;
    tokenFile = resolved.source === "file" ? resolved.path ?? null : null;
  }
  for (const w of serveWarnings({ host, guard, noToken: token === null, tokenFile })) console.warn(`[clawmem-server] warning: ${w}`);
  return Bun.serve({
    port,
    hostname: host,
    fetch: (req) => handleRequest(req, store, guard, token),
  });
}

/** L1 (Origin, Host) → an OPTIONS answer (L2) → L3 (the token) → L4 (JSON bodies) → the route, with exact CORS. */
async function handleRequest(req: Request, store: Store, guard: ServeGuard, token: string | null): Promise<Response> {
  const verdict = checkRequest({ origin: req.headers.get("origin"), host: req.headers.get("host") }, guard);
  if (!verdict.ok) return jsonError(`Forbidden: ${verdict.reason}`, 403);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: verdict.origin ? preflightHeaders(verdict.origin) : {} });
  }
  const res = await route(req, store, token);
  if (verdict.origin) for (const [k, v] of Object.entries(corsHeaders(verdict.origin))) res.headers.set(k, v);
  return res;
}

async function route(req: Request, store: Store, token: string | null): Promise<Response> {
  if (token !== null && !authorized(req, token)) return unauthorized();
  if (req.method === "POST" && !isJsonContentType(req.headers.get("content-type"))) {
    return jsonError("Content-Type must be application/json", 415);
  }
  // A request with no Host header (HTTP/1.0) arrives with a relative URL.
  const url = new URL(req.url, "http://localhost");
  const handler = matchRoute(req.method, url.pathname);
  if (!handler) {
    return jsonError(`Not found: ${req.method} ${url.pathname}`, 404);
  }

  try {
    return await handler(req, url, store);
  } catch (err: any) {
    console.error(`[clawmem-server] ${req.method} ${url.pathname} error:`, err);
    return jsonError(`Internal error: ${err.message}`, 500);
  }
}
