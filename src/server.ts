/**
 * ClawMem HTTP REST API Server
 *
 * REST interface over ClawMem's search, retrieval, and lifecycle operations.
 * Modeled after Engram's server.go — simple JSON handlers, localhost-only by default.
 *
 * Usage:
 *   clawmem serve [--port 7438] [--host 127.0.0.1]
 *
 * All endpoints require Bearer token auth when CLAWMEM_API_TOKEN is set.
 */

import type { Server } from "bun";
import type { Store, SearchResult, TimelineResult } from "./store.ts";
import { enrichResults } from "./search-utils.ts";
import { applyCompositeScoring, type EnrichedResult } from "./memory.ts";
import { applyMMRDiversity } from "./mmr.ts";
import { listCollections } from "./collections.ts";
import { classifyIntent, type IntentType } from "./intent.ts";
import { getDefaultLlamaCpp } from "./llm.ts";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  extractSnippet,
} from "./store.ts";

// =============================================================================
// Types
// =============================================================================

type RouteHandler = (req: Request, url: URL, store: Store) => Promise<Response> | Response;

// =============================================================================
// Auth
// =============================================================================

const API_TOKEN = process.env.CLAWMEM_API_TOKEN || null;

function checkAuth(req: Request): Response | null {
  if (!API_TOKEN) return null; // No token configured — open access
  const auth = req.headers.get("authorization");
  if (!auth || auth !== `Bearer ${API_TOKEN}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  return null;
}

// =============================================================================
// JSON Helpers
// =============================================================================

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "http://localhost:*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function jsonError(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

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
    } catch {
      results = store.searchFTS(query, limit * 2, undefined, collections);
    }
  } else {
    // hybrid — BM25 + vector
    const ftsResults = store.searchFTS(query, limit * 2, undefined, collections);
    let vecResults: SearchResult[] = [];
    try {
      vecResults = await store.searchVec(query, DEFAULT_EMBED_MODEL, limit * 2, undefined, collections);
    } catch { /* vector unavailable */ }
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

  return jsonResponse({
    pattern,
    count: docs.length,
    errors,
    documents: docs.map(d => ({
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

  const resolved = store.findDocumentByDocid(docid);
  if (!resolved) return jsonError(`Document not found: ${docid}`, 404);

  const doc = store.db.prepare(
    "SELECT id FROM documents WHERE hash = ? AND active = 1 LIMIT 1"
  ).get(resolved.hash) as { id: number } | undefined;
  if (!doc) return jsonError(`Document not found: ${docid}`, 404);

  const direction = (queryParam(url, "direction", "both") as "causes" | "caused_by" | "both") || "both";
  const depth = queryInt(url, "depth", 5);

  const links = store.findCausalLinks(doc.id, direction, depth);
  return jsonResponse({ docid, direction, depth, count: links.length, links });
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

  const until = body?.unsnooze ? null : (body?.until ?? new Date(Date.now() + 30 * 86400000).toISOString());
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

  store.deactivateDocument(doc.collection, doc.path);
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

  for (const coll of targetCollections) {
    const stats = await indexCollection(store, coll.name, coll.path, coll.pattern);
    totalAdded += stats.added;
    totalUpdated += stats.updated;
    totalRemoved += stats.removed;
  }

  return jsonResponse({
    collections: targetCollections.length,
    added: totalAdded,
    updated: totalUpdated,
    removed: totalRemoved,
  });
}

// --- Export ---

function handleExport(_req: Request, _url: URL, store: Store): Response {
  const docs = store.db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, d.content_type, d.confidence,
           d.access_count, d.quality_score, d.pinned, d.created_at, d.modified_at,
           d.duplicate_count, d.revision_count, d.topic_key, d.normalized_hash,
           c.doc as body
    FROM documents d
    JOIN content c ON c.hash = d.hash
    WHERE d.active = 1
    ORDER BY d.collection, d.path
  `).all() as any[];

  return jsonResponse({
    version: "1.0.0",
    exported_at: new Date().toISOString(),
    count: docs.length,
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

  return jsonResponse({ temporal: temporalEdges, semantic: semanticEdges });
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

  // Search
  { method: "POST", pattern: /^\/search$/,                 handler: handleSearch },

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

export function startServer(store: Store, port: number = 7438, host: string = "127.0.0.1"): Server {
  return Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      // Auth check
      const authError = checkAuth(req);
      if (authError) return authError;

      // Route matching
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
    },
  });
}
