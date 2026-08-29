#!/usr/bin/env bun
/**
 * ClawMem MCP Server - Model Context Protocol server
 *
 * Exposes ClawMem search and document retrieval as MCP tools and resources.
 * Includes all QMD tools + SAME memory tools (find_similar, session_log, reindex, index_stats).
 * Documents are accessible via clawmem:// URIs.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createStore,
  resolveStore,
  extractSnippet,
  extractIntentTerms,
  INTENT_CHUNK_WEIGHT,
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_MULTI_GET_MAX_BYTES,
  rethrowIfFatalVectorError,
  type Store,
  type SearchResult,
  type CausalEdgeRecord,
  type EvolutionEntry,
  type FactWitness,
  type CrossAgentFact,
} from "./store.ts";
import { capCausalWire } from "./causal-reader.ts";
import {
  applyCompositeScoring,
  hasRecencyIntent,
  QUERY_WEIGHTS,
  type EnrichedResult,
  type CoActivationFn,
} from "./memory.ts";
import { enrichResults, reciprocalRankFusion, toRanked, blendRerank, hasStrongFtsSignal, ftsBypassEnabled, attachRrfScores, type RankedResult } from "./search-utils.ts";
import { selectScoringRegime, rankRawPrimary, VECTOR_SCORE_BASIS, FTS_SCORE_BASIS, COMPOSITE_SCORE_BASIS } from "./scoring-regime.ts";
import { applyMMRDiversity } from "./mmr.ts";
import { indexCollection, type IndexStats } from "./indexer.ts";
import { listCollections } from "./collections.ts";
import { decomposeQuery, extractTemporalConstraint, type IntentType } from "./intent.ts";
import { runCausalRetrieval, hasCausalSignal, hasTimelineSignal, type CausalAssociation } from "./causal-retrieval.ts";
import { getDefaultLlamaCpp } from "./llm.ts";
import { startConsolidationWorker, stopConsolidationWorker } from "./consolidation.ts";
import {
  parseHeavyLaneConfigFromEnv,
  startHeavyMaintenanceWorker,
} from "./maintenance.ts";
import { listVaults, loadVaultConfig } from "./config.ts";
import { getEntityGraphNeighbors, searchEntities, ensureEntityCanonical } from "./entity.ts";

// =============================================================================
// Reranker fallback telemetry
// =============================================================================

// blendRerank silently degrades to RRF order when the reranker is degenerate (the deprecated
// zerank-2 GGUF emitted ~1e-11 scores that contributed nothing at weight 0.9). This surfaces that
// otherwise-invisible regression. Rate-limited to at most one stderr line per minute; the running
// count is included so a persistent failure is obvious. Run `clawmem doctor` for the full probe.
let rerankFallbackCount = 0;
let lastRerankFallbackWarnAt = 0;
function onRerankFallback(reason: string): void {
  rerankFallbackCount++;
  const now = Date.now();
  if (now - lastRerankFallbackWarnAt > 60_000) {
    lastRerankFallbackWarnAt = now;
    console.error(`[clawmem] reranker degraded → RRF fallback (${reason}); ${rerankFallbackCount} occurrence(s) this process. Run 'clawmem doctor' to check the reranker.`);
  }
}

// =============================================================================
// Types
// =============================================================================

type SearchResultItem = {
  docid: string;
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
  contentType?: string;
  compositeScore?: number;
};

type StatusResult = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: {
    name: string;
    path: string;
    pattern: string;
    documents: number;
    lastUpdated: string;
  }[];
};

// =============================================================================
// Helpers
// =============================================================================

function encodeClawmemPath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/** Split text into overlapping windows for intent-aware chunk selection */
function splitIntoWindows(text: string, windowSize: number, overlap = 200): string[] {
  const windows: string[] = [];
  for (let i = 0; i < text.length; i += windowSize - overlap) {
    windows.push(text.slice(i, i + windowSize));
    if (i + windowSize >= text.length) break;
  }
  return windows.length > 0 ? windows : [text];
}

/** Classify query into retrieval mode based on signal patterns */
// =============================================================================
// Retrieval visibility policy (VSEARCH-TRUST-HARDENING (b))
// =============================================================================

// System-internal collections excluded from MCP retrieval by default. Hook precedent:
// FILTERED_PATHS in context-surfacing. Opt-ins: the includeInternal param, or an explicit
// collection filter naming an internal collection.
const INTERNAL_COLLECTIONS = ["_clawmem"];

function resolveExcludedCollections(includeInternal: boolean | undefined, collections?: string[]): string[] | undefined {
  if (includeInternal) return undefined;
  if (collections && collections.some(c => INTERNAL_COLLECTIONS.includes(c))) return undefined;
  return INTERNAL_COLLECTIONS;
}

type DegradedLeg = { leg: string; reason: "excluded-dominant" | "cap-truncation" };

// Only excluded-dominant carries the includeInternal advice — cap-truncation must stay
// truthful when the shortfall is dedup-driven (T5-M2).
function degradedGuidanceText(legs: DegradedLeg[]): string {
  const anyExcludedDominant = legs.some(l => l.reason === "excluded-dominant");
  return anyExcludedDominant
    ? "Note: nearest-neighbor region dominated by excluded internal docs — pass includeInternal:true or refine the query."
    : "Note: vector results truncated at the scan cap.";
}

function classifyRetrievalMode(query: string): "keyword" | "semantic" | "causal" | "timeline" | "discovery" | "complex" | "hybrid" {
  const q = query.toLowerCase();

  // Timeline (highest precision signals — check first). Shared signal source with the REST
  // classifier (causal-retrieval.ts) so the two never drift again.
  if (hasTimelineSignal(q)) return "timeline";

  // Causal
  if (hasCausalSignal(q)) return "causal";

  // Discovery
  if (/\b(similar to|related to|what else|what other|reminds? me of|like this|comparable|neighbors)\b/i.test(q)) return "discovery";

  // Complex multi-topic
  if (/\band\s+(?:also|what|how|why)\b/i.test(q) || /\?.*\?/.test(q) || /\b(?:additionally|as well as|along with)\b/i.test(q) || /\bboth\s+.+\s+and\s+/i.test(q)) return "complex";

  // Keyword: short + contains specific identifiers/codes/paths
  if (q.length < 50 && (/[A-Z][A-Z0-9_]{2,}/.test(query) || /[\w-]+\.\w{2,4}\b/.test(q.trim()) || /\b(config|setting|error|path|file|port|url)\b/i.test(q))) return "keyword";

  // Semantic: conceptual/explanatory
  if (/\b(how does|explain|concept|overview|understand|meaning of|what is the purpose)\b/i.test(q)) return "semantic";

  return "hybrid";
}

function formatSearchSummary(results: SearchResultItem[], query: string): string {
  if (results.length === 0) return `No results found for "${query}"`;
  const lines = [`Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n`];
  for (const r of results) {
    const scoreStr = r.compositeScore !== undefined
      ? `${Math.round(r.compositeScore * 100)}%`
      : `${Math.round(r.score * 100)}%`;
    const typeTag = r.contentType && r.contentType !== "note" ? ` [${r.contentType}]` : "";
    lines.push(`${r.docid} ${scoreStr} ${r.file} - ${r.title}${typeTag}`);
  }
  return lines.join('\n');
}

function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

// =============================================================================
// MCP Server
// =============================================================================

/**
 * Build the fully-registered MCP server WITHOUT connecting a transport.
 * Extracted from startMcpServer so tests can drive the real tool handlers over an
 * in-memory transport (route-level regressions for visibility exclusion + degraded
 * markers). Returns the server plus a close() that releases every store handle.
 */
export function buildMcpServer(): { server: McpServer; store: Store; closeAllStores: () => void } {
  const store = createStore(undefined, { busyTimeout: 5000 });

  // Vault store cache: prevents connection churn, closed on shutdown
  const vaultStoreCache = new Map<string, Store>();

  function getStore(vault?: string): Store {
    if (!vault) return store;
    const cached = vaultStoreCache.get(vault);
    if (cached) return cached;
    const s = resolveStore(vault, { busyTimeout: 5000 });
    vaultStoreCache.set(vault, s);
    return s;
  }

  function closeAllStores(): void {
    for (const [, s] of vaultStoreCache) {
      try { s.close(); } catch {}
    }
    vaultStoreCache.clear();
    try { store.close(); } catch {}
  }

  const server = new McpServer({
    name: "clawmem",
    version: "0.1.0",
  });

  // ---------------------------------------------------------------------------
  // Tool: __IMPORTANT (workflow instructions)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "__IMPORTANT",
    {
      title: "READ THIS FIRST: Memory search workflow",
      description: "Instructions for efficient memory search. Read this before searching.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: `## ClawMem Search Workflow

PREFERRED: Use memory_retrieve(query) — auto-routes to the right backend.

If calling tools directly, match query type to tool:

  "why did we decide X"         → intent_search(query)     NOT query()
  "what happened last session"  → session_log()             NOT query()
  "what else relates to X"      → find_similar(file)        NOT query()
  complex multi-topic           → query_plan(query)         NOT query()
  general recall                → query(query, compact=true)
  keyword spot check            → search(query, compact=true)
  conceptual/fuzzy              → vsearch(query, compact=true)

WRONG: query("why did we choose PostgreSQL", compact=true)
RIGHT: intent_search("why did we choose PostgreSQL")
RIGHT: memory_retrieve("why did we choose PostgreSQL")

WRONG: query("what happened last session", compact=true)
RIGHT: session_log(limit=5)
RIGHT: memory_retrieve("what happened last session")

After search: multi_get("path1,path2") for full content of top hits.
Only escalate when injected <vault-context> is insufficient.` }]
    })
  );

  // ---------------------------------------------------------------------------
  // Tool: memory_retrieve (Meta-tool — auto-routing single entry point)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "memory_retrieve",
    {
      title: "Smart Memory Retrieve (Auto-Routing)",
      description: `Unified memory retrieval — classifies your query and routes to the optimal search backend automatically. Use this instead of choosing between search/vsearch/query/intent_search.

Auto-routing:
- "why did we decide X" → causal graph traversal
- "what happened last session" → session history
- "what else relates to X" → vector neighbors
- Complex multi-topic → parallel decomposition
- General recall → full hybrid search

This is the recommended entry point for ALL memory queries.`,
      inputSchema: {
        query: z.string().describe("Your question or search query"),
        mode: z.enum(["auto", "keyword", "semantic", "causal", "timeline", "discovery", "complex", "hybrid"]).optional().default("auto").describe("Override auto-detection: keyword=BM25, semantic=vector, causal=graph traversal, timeline=session history, discovery=similar docs, complex=multi-topic, hybrid=full pipeline"),
        limit: z.number().optional().default(10),
        compact: z.boolean().optional().default(true),
        includeInternal: z.boolean().optional().default(false).describe("Include system-internal _clawmem docs (observations/deductions) — excluded by default"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, mode, limit, compact, includeInternal, vault }) => {
      const store = getStore(vault);
      const effectiveMode = mode === "auto" ? classifyRetrievalMode(query) : mode;
      const lim = limit || 10;
      const excl = resolveExcludedCollections(includeInternal);
      const degradedLegs: DegradedLeg[] = [];

      // --- Timeline mode → session log ---
      if (effectiveMode === "timeline") {
        const sessions = store.getRecentSessions(lim);
        if (sessions.length === 0) {
          return { content: [{ type: "text", text: `[routed: timeline] No sessions tracked yet.` }] };
        }
        const lines = [`[routed: timeline] Recent sessions:\n`];
        for (const sess of sessions) {
          const duration = sess.endedAt
            ? `${Math.round((new Date(sess.endedAt).getTime() - new Date(sess.startedAt).getTime()) / 60000)}min`
            : "active";
          lines.push(`${sess.sessionId.slice(0, 8)} ${sess.startedAt} (${duration})`);
          if (sess.handoffPath) lines.push(`  Handoff: ${sess.handoffPath}`);
          if (sess.summary) lines.push(`  ${sess.summary.slice(0, 100)}`);
          if (sess.filesChanged.length > 0) lines.push(`  Files: ${sess.filesChanged.slice(0, 5).join(", ")}`);
        }
        return { content: [{ type: "text", text: lines.join('\n') }], structuredContent: { mode: effectiveMode, sessions } };
      }

      // --- Causal mode → shared intent-aware causal pipeline (v0.32.0) ---
      // Same pipeline as intent_search, differing only in eligibility (default-filtered) and
      // the WHY observation lane; entity expansion stays off (legacy stage, intent_search-only).
      if (effectiveMode === "causal") {
        const llm = getDefaultLlamaCpp();
        const { intent, results: causalResults, associations, degraded } = await runCausalRetrieval(store, llm, query, {
          stages: { traversal: true, mpfp: true, entityExpansion: false, rerank: true, causalOneHop: true },
          baseEligibility: { excludeCollections: excl },
          whyObservationLane: true,
        });
        // Causal mode reports the flat single-vector degraded shape per the documented
        // contract (T8-M5), not the multi-leg degradedLegs aggregate.
        const causalDegraded: DegradedLeg | undefined = degraded.length > 0
          ? { leg: degraded[0]!.leg, reason: degraded[0]!.reason }
          : undefined;

        const enriched = enrichResults(store, causalResults, query);
        const scored = applyCompositeScoring(enriched, query).slice(0, lim);
        const items = scored.map(r => {
          const causal = associations.get(r.filepath);
          return {
            docid: `#${r.docid}`, path: r.displayPath, title: r.title,
            score: Math.round(r.compositeScore * 100) / 100,
            snippet: (r.body || "").substring(0, 150), content_type: r.contentType,
            ...(causal ? { causal } : {}),
          };
        });
        const causalDegradedFields = causalDegraded ? { degraded: true as const, degradedReason: causalDegraded.reason } : {};
        const degradedNote = causalDegraded ? `\n${degradedGuidanceText([causalDegraded])}` : "";
        return {
          content: [{ type: "text", text: `[routed: causal, intent: ${intent.intent}] ${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}${degradedNote}` }],
          structuredContent: { mode: effectiveMode, intent, results: items, ...causalDegradedFields },
        };
      }

      // --- Complex mode → query decomposition (multi-leg: per-clause degraded aggregation, T6-M1) ---
      if (effectiveMode === "complex") {
        const llm = getDefaultLlamaCpp();
        const clauses = await decomposeQuery(query, llm, store.db);
        const allResults: SearchResult[] = [];
        let clauseIdx = 0;
        for (const clause of clauses.sort((a, b) => a.priority - b.priority)) {
          const clauseExcl = resolveExcludedCollections(includeInternal, clause.collections);
          let results: SearchResult[] = [];
          if (clause.type === 'bm25') results = store.searchFTS(clause.query, 20, undefined, clause.collections, undefined, clauseExcl);
          else if (clause.type === 'vector') {
            try {
              const det = await store.searchVecDetailed(clause.query, DEFAULT_EMBED_MODEL, 20, { collections: clause.collections, excludeCollections: clauseExcl });
              results = det.results;
              if (det.degraded && det.degradedReason) degradedLegs.push({ leg: `complex:clause${clauseIdx}:vector`, reason: det.degradedReason });
            } catch (e) { rethrowIfFatalVectorError(e); /* */ }
          }
          else if (clause.type === 'graph') { results = store.searchFTS(clause.query, 15, undefined, clause.collections, undefined, clauseExcl); }
          allResults.push(...results);
          clauseIdx++;
        }
        const seen = new Set<string>();
        const deduped = allResults.filter(r => { if (seen.has(r.filepath)) return false; seen.add(r.filepath); return true; });
        const enriched = enrichResults(store, deduped, query);
        const scored = applyCompositeScoring(enriched, query).slice(0, lim);
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round(r.compositeScore * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType,
        }));
        const degradedNote = degradedLegs.length > 0 ? `\n${degradedGuidanceText(degradedLegs)}` : "";
        return {
          content: [{ type: "text", text: `[routed: complex, ${clauses.length} clauses] ${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}${degradedNote}` }],
          structuredContent: { mode: effectiveMode, clauses: clauses.length, results: items, ...(degradedLegs.length > 0 ? { degraded: true, degradedLegs } : {}) },
        };
      }

      // --- Keyword / Semantic / Discovery / Hybrid modes ---
      let results: SearchResult[] = [];
      let singleLegDegraded: DegradedLeg | undefined;
      // semantic/discovery: the raw regime applies ONLY to results the vector leg actually
      // served — the FTS fallback's scores are not cosine, so it keeps composite scoring.
      let vectorLegServed = false;
      if (effectiveMode === "keyword") {
        results = store.searchFTS(query, lim, undefined, undefined, undefined, excl);
      } else if (effectiveMode === "semantic" || effectiveMode === "discovery") {
        try {
          const det = await store.searchVecDetailed(query, DEFAULT_EMBED_MODEL, lim, { excludeCollections: excl });
          results = det.results;
          vectorLegServed = true;
          if (det.degraded && det.degradedReason) singleLegDegraded = { leg: `${effectiveMode}:vector`, reason: det.degradedReason };
        } catch (e) { rethrowIfFatalVectorError(e); results = store.searchFTS(query, lim, undefined, undefined, undefined, excl); }
      } else {
        // Hybrid: BM25 + vector + RRF
        const bm25 = store.searchFTS(query, 30, undefined, undefined, undefined, excl);
        let vec: SearchResult[] = [];
        try {
          const det = await store.searchVecDetailed(query, DEFAULT_EMBED_MODEL, 30, { excludeCollections: excl });
          vec = det.results;
          if (det.degraded && det.degradedReason) singleLegDegraded = { leg: "hybrid:vector", reason: det.degradedReason };
        } catch (e) { rethrowIfFatalVectorError(e); /* */ }
        if (vec.length > 0) {
          const fusedRanked = reciprocalRankFusion([bm25.map(toRanked), vec.map(toRanked)], [1.0, 1.0]);
          results = attachRrfScores(fusedRanked, [...bm25, ...vec]);
        } else {
          results = bm25;
        }
      }

      const enriched = enrichResults(store, results, query);
      // v0.22.0 two-regime scoring (VSEARCH-RAW-PRIMARY-DESIGN.md R1/R4): vector-served
      // semantic/discovery results on non-recency queries rank by raw cosine (metadata
      // breaks exact ties only). Keyword/hybrid modes and the FTS fallback keep composite —
      // their scores are not cosine, so the raw contract cannot hold there.
      const rawRegime = vectorLegServed
        && (effectiveMode === "semantic" || effectiveMode === "discovery")
        && selectScoringRegime(query) === "raw";
      const retrieveScoreBasis = rawRegime ? VECTOR_SCORE_BASIS : COMPOSITE_SCORE_BASIS;
      const scored = rawRegime
        ? rankRawPrimary(enriched, query).slice(0, lim)
        : applyCompositeScoring(enriched, query).slice(0, lim);
      const modeDegraded = singleLegDegraded ? { degraded: true as const, degradedReason: singleLegDegraded.reason } : {};
      const modeDegradedNote = singleLegDegraded ? `\n${degradedGuidanceText([singleLegDegraded])}` : "";
      if (compact) {
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round(r.compositeScore * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType,
        }));
        return {
          content: [{ type: "text", text: `[routed: ${effectiveMode}] ${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}${modeDegradedNote}` }],
          structuredContent: { mode: effectiveMode, results: items, scoreBasis: retrieveScoreBasis, ...modeDegraded },
        };
      }
      const items: SearchResultItem[] = scored.map(r => {
        const { line, snippet } = extractSnippet(r.body || "", query, 300, r.chunkPos);
        return {
          docid: `#${r.docid}`, file: r.displayPath, title: r.title,
          score: r.score, compositeScore: Math.round(r.compositeScore * 100) / 100,
          contentType: r.contentType, context: store.getContextForFile(r.filepath),
          snippet: addLineNumbers(snippet, line),
        };
      });
      return {
        content: [{ type: "text", text: `[routed: ${effectiveMode}] ${formatSearchSummary(items, query)}${modeDegradedNote}` }],
        structuredContent: { mode: effectiveMode, results: items, scoreBasis: retrieveScoreBasis, ...modeDegraded },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Resource: clawmem://{path}
  // ---------------------------------------------------------------------------

  server.registerResource(
    "document",
    new ResourceTemplate("clawmem://{+path}", { list: undefined }),
    {
      title: "ClawMem Document",
      description: "A document from your ClawMem knowledge base.",
      mimeType: "text/markdown",
    },
    async (uri, { path }) => {
      const pathStr = Array.isArray(path) ? path.join('/') : (path || '');
      const decodedPath = decodeURIComponent(pathStr);
      const parts = decodedPath.split('/');
      const collection = parts[0] || '';
      const relativePath = parts.slice(1).join('/');

      let doc = store.db.prepare(`
        SELECT d.collection, d.path, d.title, c.doc as body
        FROM documents d JOIN content c ON c.hash = d.hash
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
      `).get(collection, relativePath) as { collection: string; path: string; title: string; body: string } | null;

      if (!doc) {
        doc = store.db.prepare(`
          SELECT d.collection, d.path, d.title, c.doc as body
          FROM documents d JOIN content c ON c.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1 LIMIT 1
        `).get(`%${relativePath}`) as typeof doc;
      }

      if (!doc) {
        return { contents: [{ uri: uri.href, text: `Document not found: ${decodedPath}` }] };
      }

      const virtualPath = `clawmem://${doc.collection}/${doc.path}`;
      const context = store.getContextForFile(virtualPath);
      let text = addLineNumbers(doc.body);
      if (context) text = `<!-- Context: ${context} -->\n\n` + text;

      return {
        contents: [{
          uri: uri.href,
          name: `${doc.collection}/${doc.path}`,
          title: doc.title || doc.path,
          mimeType: "text/markdown",
          text,
        }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: search (BM25 — raw-transform ranking; composite on recency intent)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "search",
    {
      title: "Search (BM25 + Memory)",
      description: "Keyword (BM25) search for exact term lookup. Use for config names, error codes, specific filenames. DO NOT use for 'why' questions (use intent_search) or cross-session queries (use session_log). Prefer memory_retrieve for auto-routing.",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z.number().optional().default(10),
        minScore: z.number().optional().describe("Score floor. Non-recency queries filter the RAW FTS score, the monotonic |bm25|/(1+|bm25|) transform (default: no filter; explicit 0 honored). Recency-intent queries keep the composite-scale default 0."),
        collection: z.string().optional().describe("Filter to collection (single name or comma-separated)"),
        compact: z.boolean().optional().default(false).describe("Return compact results (id, path, title, score, snippet) instead of full content"),
        includeInternal: z.boolean().optional().default(false).describe("Include system-internal _clawmem docs (observations/deductions) — excluded by default"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, minScore, collection, compact, includeInternal, vault }) => {
      const store = getStore(vault);
      const collections = collection
        ? collection.split(",").map(c => c.trim()).filter(Boolean)
        : undefined;
      const excl = resolveExcludedCollections(includeInternal, collections);
      const results = store.searchFTS(query, limit || 10, undefined, collections, undefined, excl);

      const coFn = (path: string) => store.getCoActivated(path);
      const enriched = enrichResults(store, results, query);
      // v0.24.0 two-regime scoring (S49-JUDGED-EVAL-DESIGN.md, SWITCH verdict): non-recency
      // queries rank by the raw FTS transform — metadata (incl. pin) breaks exact score
      // ties only, and minScore (if given) filters the raw score with NO default floor.
      // Recency-intent queries keep the pre-v0.24.0 composite behavior including its
      // default-0 floor.
      const regime = selectScoringRegime(query);
      const sScoreBasis = regime === "raw" ? FTS_SCORE_BASIS : COMPOSITE_SCORE_BASIS;
      const scored = regime === "raw"
        ? rankRawPrimary(enriched, query, coFn).filter(r => minScore === undefined || r.compositeScore >= minScore)
        : applyCompositeScoring(enriched, query, coFn).filter(r => r.compositeScore >= (minScore || 0));

      if (compact) {
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
          authored_at: r.authoredAt ?? null,
          fragment: r.fragmentType ? { type: r.fragmentType, label: r.fragmentLabel } : undefined,
        }));
        return { content: [{ type: "text", text: formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query) }], structuredContent: { results: items, scoreBasis: sScoreBasis } };
      }

      const filtered: SearchResultItem[] = scored.map(r => {
        const { line, snippet } = extractSnippet(r.body || "", query, 300, r.chunkPos);
        return {
          docid: `#${r.docid}`,
          file: r.displayPath,
          title: r.title,
          score: r.score,
          compositeScore: Math.round(r.compositeScore * 100) / 100,
          contentType: r.contentType,
          context: store.getContextForFile(r.filepath),
          snippet: addLineNumbers(snippet, line),
        };
      });

      return {
        content: [{ type: "text", text: formatSearchSummary(filtered, query) }],
        structuredContent: { results: filtered, scoreBasis: sScoreBasis },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: vsearch (Vector + composite)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vsearch",
    {
      title: "Vector Search (Semantic + Memory)",
      description: "Vector similarity search for conceptual/fuzzy matching. Use when exact keywords are unknown. DO NOT use for causal 'why' questions (use intent_search) or session history (use session_log). Prefer memory_retrieve for auto-routing.",
      inputSchema: {
        query: z.string().describe("Natural language query"),
        limit: z.number().optional().default(10),
        minScore: z.number().optional().describe("Score floor. Non-recency queries filter the RAW cosine score (default: no filter; explicit 0 honored; cosine values are embedding-model-specific). Recency-intent queries keep the composite-scale default 0.3."),
        collection: z.string().optional().describe("Filter to collection (single name or comma-separated)"),
        compact: z.boolean().optional().default(false).describe("Return compact results (id, path, title, score, snippet) instead of full content"),
        includeInternal: z.boolean().optional().default(false).describe("Include system-internal _clawmem docs (observations/deductions) — excluded by default"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, minScore, collection, compact, includeInternal, vault }) => {
      const store = getStore(vault);
      const tableExists = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
      if (!tableExists) {
        return { content: [{ type: "text", text: "Vector index not found. Run 'clawmem embed' first." }], isError: true };
      }

      const collections = collection
        ? collection.split(",").map(c => c.trim()).filter(Boolean)
        : undefined;
      const excl = resolveExcludedCollections(includeInternal, collections);
      const det = await store.searchVecDetailed(query, DEFAULT_EMBED_MODEL, limit || 10, { collections, excludeCollections: excl });
      const results = det.results;
      const vsDegraded = det.degraded && det.degradedReason ? { degraded: true as const, degradedReason: det.degradedReason } : {};
      const vsDegradedNote = det.degraded && det.degradedReason ? `\n${degradedGuidanceText([{ leg: "vsearch", reason: det.degradedReason }])}` : "";

      const coFn = (path: string) => store.getCoActivated(path);
      const enriched = enrichResults(store, results, query);
      // v0.22.0 two-regime scoring (VSEARCH-RAW-PRIMARY-DESIGN.md R1–R4): non-recency
      // queries rank by raw cosine — metadata (incl. pin) breaks exact score ties only,
      // and minScore (if given) filters the raw score with NO default floor. Recency-intent
      // queries keep the pre-v0.22.0 composite behavior including its 0.3 default.
      const regime = selectScoringRegime(query);
      const vsScoreBasis = regime === "raw" ? VECTOR_SCORE_BASIS : COMPOSITE_SCORE_BASIS;
      const scored = regime === "raw"
        ? rankRawPrimary(enriched, query, coFn).filter(r => minScore === undefined || r.compositeScore >= minScore)
        // Recency branch preserves v0.21 semantics EXACTLY, including `||`: an explicit
        // minScore of 0 still applies the 0.3 composite floor (R4 unchanged-recency contract).
        : applyCompositeScoring(enriched, query, coFn).filter(r => r.compositeScore >= (minScore || 0.3));

      if (compact) {
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
          authored_at: r.authoredAt ?? null,
          fragment: r.fragmentType ? { type: r.fragmentType, label: r.fragmentLabel } : undefined,
        }));
        return { content: [{ type: "text", text: `${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}${vsDegradedNote}` }], structuredContent: { results: items, scoreBasis: vsScoreBasis, ...vsDegraded } };
      }

      const items: SearchResultItem[] = scored.map(r => {
        const { line, snippet } = extractSnippet(r.body || "", query, 300, r.chunkPos);
        return {
          docid: `#${r.docid}`,
          file: r.displayPath,
          title: r.title,
          score: r.score,
          compositeScore: Math.round(r.compositeScore * 100) / 100,
          contentType: r.contentType,
          context: store.getContextForFile(r.filepath),
          snippet: addLineNumbers(snippet, line),
        };
      });

      return {
        content: [{ type: "text", text: `${formatSearchSummary(items, query)}${vsDegradedNote}` }],
        structuredContent: { results: items, scoreBasis: vsScoreBasis, ...vsDegraded },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: query (Hybrid + rerank + composite)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "query",
    {
      title: "Hybrid Query (Best Quality)",
      description: "Full hybrid search (BM25 + vector + rerank). General-purpose — use when query type is unclear. WRONG: query('why did we decide X') — use intent_search instead. WRONG: query('what happened last session') — use session_log instead. Prefer memory_retrieve for auto-routing.",
      inputSchema: {
        query: z.string().describe("Natural language query"),
        limit: z.number().optional().default(10),
        minScore: z.number().optional().default(0),
        collection: z.string().optional().describe("Filter to collection (single name or comma-separated)"),
        compact: z.boolean().optional().default(false).describe("Return compact results (id, path, title, score, snippet) instead of full content"),
        diverse: z.boolean().optional().default(true).describe("Apply MMR diversity filter to reduce near-duplicate results"),
        intent: z.string().optional().describe("Domain intent hint for disambiguation — steers expansion, reranking, chunk selection, and snippet extraction"),
        candidateLimit: z.number().optional().default(30).describe("Max candidates reaching the reranker (default 30)"),
        includeInternal: z.boolean().optional().default(false).describe("Include system-internal _clawmem docs (observations/deductions) — excluded by default"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, minScore, collection, compact, diverse, intent, candidateLimit, includeInternal, vault }) => {
      const store = getStore(vault);
      const candLimit = candidateLimit || 30;
      const rankedLists: RankedResult[][] = [];
      const docidMap = new Map<string, string>();
      const degradedLegs: DegradedLeg[] = [];
      const hasVectors = !!store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();

      // Step 0: Temporal constraint extraction (pure regex, ~0ms)
      const dateRange = extractTemporalConstraint(query) || undefined;

      // Step 1: BM25 probe — skip expensive LLM expansion if strong signal
      const collections = collection
        ? collection.split(",").map(c => c.trim()).filter(Boolean)
        : undefined;
      const excl = resolveExcludedCollections(includeInternal, collections);
      const initialFts = store.searchFTS(query, 20, undefined, collections, dateRange, excl);
      // When intent is provided, disable strong-signal bypass — the obvious BM25
      // match may not be what the caller wants (e.g. "performance" with intent "web page load times")
      const hasStrongSignal = !intent && ftsBypassEnabled() && hasStrongFtsSignal(initialFts);

      // Step 2: Query expansion (skipped if strong signal). Typed routing —
      // original → BOTH FTS + vector (2× RRF anchor), lex → FTS only, vec/hyde → vector only.
      const expanded = hasStrongSignal
        ? []
        : await store.expandQuery(query, DEFAULT_QUERY_MODEL, intent);

      // Original query — both backends, pushed FIRST so the positional 2× weight
      // below lands on exactly the original's lists.
      if (initialFts.length > 0) {
        for (const r of initialFts) docidMap.set(r.filepath, r.docid);
        rankedLists.push(initialFts.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
      }
      if (hasVectors) {
        const det = await store.searchVecDetailed(query, DEFAULT_EMBED_MODEL, 20, { collections, dateRange, excludeCollections: excl });
        if (det.degraded && det.degradedReason) degradedLegs.push({ leg: "vector:original", reason: det.degradedReason });
        if (det.results.length > 0) {
          for (const r of det.results) docidMap.set(r.filepath, r.docid);
          rankedLists.push(det.results.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
        }
      }
      // Lists contributed by the original query — these get the 2× RRF weight.
      const numOriginalLists = rankedLists.length;

      // Typed expansions — route by type: lex → FTS, vec/hyde → vector.
      let expansionIdx = 0;
      for (const eq of expanded) {
        if (eq.type === 'lex') {
          const ftsResults = store.searchFTS(eq.query, 20, undefined, collections, dateRange, excl);
          if (ftsResults.length > 0) {
            for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
            rankedLists.push(ftsResults.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
          }
        } else if (hasVectors) {
          const det = await store.searchVecDetailed(eq.query, DEFAULT_EMBED_MODEL, 20, { collections, dateRange, excludeCollections: excl });
          if (det.degraded && det.degradedReason) degradedLegs.push({ leg: `vector:expansion${expansionIdx}`, reason: det.degradedReason });
          if (det.results.length > 0) {
            for (const r of det.results) docidMap.set(r.filepath, r.docid);
            rankedLists.push(det.results.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
          }
        }
        expansionIdx++;
      }

      // Step 2b: Temporal proximity channel (if dateRange detected)
      // Scores documents by closeness to query's temporal center — distinct from dateRange WHERE filter
      if (dateRange) {
        const centerMs = (new Date(dateRange.start).getTime() + new Date(dateRange.end).getTime()) / 2;
        const rangeMs = Math.max(new Date(dateRange.end).getTime() - new Date(dateRange.start).getTime(), 86400000);
        const temporalExclSql = excl && excl.length > 0
          ? ` AND d.collection NOT IN (${excl.map(() => '?').join(',')})`
          : "";
        // §51.1: the proximity channel measures content time — authorship when
        // known, filing time otherwise — in the WHERE, the ORDER, and the
        // proximity math itself.
        const temporalDocs = store.db.prepare(`
          SELECT 'clawmem://' || d.collection || '/' || d.path as filepath,
                 d.collection || '/' || d.path as displayPath,
                 d.title, COALESCE(d.authored_at, d.modified_at) as effective_at
          FROM documents d
          WHERE d.active = 1 AND d.invalidated_at IS NULL AND COALESCE(d.authored_at, d.modified_at) >= ? AND COALESCE(d.authored_at, d.modified_at) <= ?${temporalExclSql}
          ORDER BY COALESCE(d.authored_at, d.modified_at) DESC LIMIT 30
        `).all(dateRange.start, dateRange.end, ...(excl ?? [])) as { filepath: string; displayPath: string; title: string; effective_at: string }[];

        if (temporalDocs.length > 0) {
          const temporalRanked: RankedResult[] = temporalDocs.map(d => {
            const docMs = new Date(d.effective_at).getTime();
            const proximity = 1.0 - Math.min(1.0, Math.abs(docMs - centerMs) / rangeMs);
            return { file: d.filepath, displayPath: d.displayPath, title: d.title, body: "", score: proximity };
          });
          rankedLists.push(temporalRanked);
        }
      }

      // Step 2c: Graph retrieval channel (if entity signals detected in query)
      const entitySignals = /\b(who|person|team|project|service|tool|@\w+|#\w+|VM \d|what.*about)\b/i.test(query);
      if (entitySignals && initialFts.length > 0) {
        // Get doc IDs from top BM25 seeds for 1-hop entity walk
        const seedDocIds = initialFts.slice(0, 5).map(r => {
          const row = store.db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1 LIMIT 1`).get(r.hash) as { id: number } | undefined;
          return row?.id;
        }).filter((id): id is number => id !== undefined);

        if (seedDocIds.length > 0) {
          const entityNeighbors = getEntityGraphNeighbors(store.db, seedDocIds, 20);
          if (entityNeighbors.length > 0) {
            const graphRanked: RankedResult[] = entityNeighbors.map(en => {
              const doc = store.db.prepare(`
                SELECT d.collection, d.path, d.title, c.doc as body
                FROM documents d LEFT JOIN content c ON c.hash = d.hash
                WHERE d.id = ? AND d.active = 1 AND d.invalidated_at IS NULL LIMIT 1
              `).get(en.docId) as { collection: string; path: string; title: string; body: string | null } | undefined;
              if (!doc) return null;
              if (excl && excl.includes(doc.collection)) return null;
              return {
                file: `clawmem://${doc.collection}/${doc.path}`,
                displayPath: `${doc.collection}/${doc.path}`,
                title: doc.title,
                body: doc.body?.slice(0, 200) || "",
                score: en.score,
              };
            }).filter((r): r is RankedResult => r !== null);
            if (graphRanked.length > 0) rankedLists.push(graphRanked);
          }
        }
      }

      // Weight: the original query's lists (pushed first) get 2×; expansion, temporal,
      // and entity legs get 1×. numOriginalLists (computed above) is the actual count
      // the original contributed — robust to an empty BM25 or vector leg.
      const weights = rankedLists.map((_, i) => i < numOriginalLists ? 2.0 : 1.0);
      const fused = reciprocalRankFusion(rankedLists, weights);
      const candidates = fused.slice(0, candLimit);

      // Step 3: Intent-aware chunk selection for reranking
      const intentTerms = intent ? extractIntentTerms(intent) : [];
      const chunksToRerank = candidates.map(c => {
        let text = c.body.slice(0, 4000);
        // When intent is provided, select the chunk with highest intent+query relevance
        if (intentTerms.length > 0 && c.body.length > 4000) {
          const chunks = splitIntoWindows(c.body, 4000);
          let bestChunk = chunks[0]!;
          let bestScore = -1;
          const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
          for (const chunk of chunks) {
            const lower = chunk.toLowerCase();
            let score = 0;
            for (const term of queryTerms) { if (lower.includes(term)) score += 1.0; }
            for (const term of intentTerms) { if (lower.includes(term)) score += INTENT_CHUNK_WEIGHT; }
            if (score > bestScore) { bestScore = score; bestChunk = chunk; }
          }
          text = bestChunk;
        }
        return { file: c.file, text };
      });

      let reranked: { file: string; score: number }[] = [];
      try {
        reranked = await store.rerank(query, chunksToRerank, DEFAULT_RERANK_MODEL, intent);
      } catch {
        reranked = []; // reranker unavailable → blendRerank falls back to pure RRF order
      }

      const candidateMap = new Map(candidates.map(c => [c.file, c]));

      // Blend the reranker (dominant signal) with a thin normalized-RRF tiebreaker; falls back
      // to pure RRF order when the reranker is unavailable / all-zero. See blendRerank: the
      // prior w·(1/rrfRank) blend made RRF rank-1 immovable by the reranker. Harness-validated
      // 2026-06-25 (NL+KW known-item recall): lifts recall@1-5 + MRR@10 with no material pooled
      // recall@10 regression.
      const blended = blendRerank(candidates, reranked, { onFallback: onRerankFallback });

      // Map to SearchResults for composite scoring — hydrate from DB when needed
      const allSearchResults = [...store.searchFTS(query, 30)];
      const resultMap = new Map(allSearchResults.map(r => [r.filepath, r]));
      const searchResults = blended
        .map(b => {
          const existing = resultMap.get(b.file);
          if (existing) return { ...existing, score: b.score, filepath: b.file } as SearchResult;
          // Hydrate candidates not in BM25 results (vec-only, temporal, entity-graph hits)
          const candidate = candidateMap.get(b.file);
          if (candidate) {
            const doc = store.db.prepare(`
              SELECT d.hash, d.collection, d.path, d.title, d.modified_at, c.doc as body
              FROM documents d LEFT JOIN content c ON c.hash = d.hash
              WHERE 'clawmem://' || d.collection || '/' || d.path = ? AND d.active = 1 AND d.invalidated_at IS NULL LIMIT 1
            `).get(b.file) as { hash: string; collection: string; path: string; title: string; modified_at: string; body: string | null } | undefined;
            if (doc) {
              return {
                filepath: b.file,
                displayPath: `${doc.collection}/${doc.path}`,
                title: doc.title,
                hash: doc.hash,
                docid: doc.hash.slice(0, 6),
                collectionName: doc.collection,
                modifiedAt: doc.modified_at || "",
                bodyLength: doc.body?.length || 0,
                body: doc.body || "",
                context: null,
                score: b.score,
                source: "vec" as const,
              } satisfies SearchResult;
            }
          }
          return null;
        })
        .filter((r): r is SearchResult => r !== null);

      const coFn = (path: string) => store.getCoActivated(path);
      const enriched = enrichResults(store, searchResults, query);
      // Phase B (§11.12): the `query` tool's hybrid+rerank pipeline uses QUERY_WEIGHTS (search 0.70) —
      // the eval-validated re-weight. Recency intent still wins RECENCY_WEIGHTS by construction
      // (applyCompositeScoring ignores options.weights when hasRecencyIntent(query) and !forceWeights).
      let scored = applyCompositeScoring(enriched, query, coFn, { weights: QUERY_WEIGHTS })
        .filter(r => r.compositeScore >= (minScore || 0));
      if (diverse !== false) scored = applyMMRDiversity(scored);
      scored = scored.slice(0, limit || 10);

      // Multi-leg degraded aggregation (T5-M1): route marker = any(leg), per-leg reasons retained.
      const queryDegraded = degradedLegs.length > 0 ? { degraded: true as const, degradedLegs } : {};
      const queryDegradedNote = degradedLegs.length > 0 ? `\n${degradedGuidanceText(degradedLegs)}` : "";

      if (compact) {
        const items = scored.map(r => ({
          docid: `#${docidMap.get(r.filepath) || r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
          authored_at: r.authoredAt ?? null,
          fragment: r.fragmentType ? { type: r.fragmentType, label: r.fragmentLabel } : undefined,
        }));
        return { content: [{ type: "text", text: `${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}${queryDegradedNote}` }], structuredContent: { results: items, ...queryDegraded } };
      }

      const items: SearchResultItem[] = scored.map(r => {
        const { line, snippet } = extractSnippet(r.body || "", query, 300, r.chunkPos, intent);
        return {
          docid: `#${docidMap.get(r.filepath) || r.docid}`,
          file: r.displayPath,
          title: r.title,
          score: r.score,
          compositeScore: Math.round(r.compositeScore * 100) / 100,
          contentType: r.contentType,
          context: store.getContextForFile(r.filepath),
          snippet: addLineNumbers(snippet, line),
        };
      });

      return {
        content: [{ type: "text", text: `${formatSearchSummary(items, query)}${queryDegradedNote}` }],
        structuredContent: { results: items, ...queryDegraded },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Lifecycle search helpers — resilient candidate finding for pin/snooze/forget
  // ---------------------------------------------------------------------------

  type LifecycleCandidate = {
    displayPath: string;
    title: string;
    score: number;
    source: "path" | "fts" | "title" | "vec";
  };

  const STOPWORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
    "and", "or", "not", "no", "but", "if", "then", "so", "do", "did",
    "has", "have", "had", "it", "its", "this", "that", "my", "our",
  ]);

  /**
   * Cascading search for lifecycle mutations: path match → BM25 → title overlap → vector.
   * Returns ranked candidates. Never returns wrong results silently.
   */
  async function findMemoryCandidates(
    store: Store,
    query: string,
    limit: number = 5
  ): Promise<LifecycleCandidate[]> {
    // 1. Exact path match (handles queries like "stack/research/foo.md")
    if (query.includes("/") || query.endsWith(".md")) {
      const normalized = query.replace(/^\//, "");
      const pathHits = store.db.prepare(`
        SELECT collection || '/' || path as displayPath, title
        FROM documents WHERE active = 1 AND invalidated_at IS NULL
        AND (path LIKE ? OR collection || '/' || path LIKE ?)
        LIMIT ?
      `).all(`%${normalized}%`, `%${normalized}%`, limit) as { displayPath: string; title: string }[];
      if (pathHits.length > 0) {
        return pathHits.map((h, i) => ({ ...h, score: 1.0 - i * 0.05, source: "path" as const }));
      }
    }

    // 2. BM25 full-text search (fast, exact terms)
    const ftsResults = store.searchFTS(query, limit);
    if (ftsResults.length > 0) {
      return ftsResults.map(r => ({
        displayPath: r.displayPath,
        title: r.title,
        score: r.score,
        source: "fts" as const,
      }));
    }

    // 3. Title-token overlap (catches BM25 failures from too many AND'd terms)
    const tokens = query.toLowerCase().split(/\s+/)
      .filter(w => w.length >= 2 && !STOPWORDS.has(w))
      .map(w => w.replace(/[^a-z0-9]/g, ""))
      .filter(w => w.length >= 2);

    if (tokens.length > 0) {
      const minMatch = Math.max(2, Math.ceil(tokens.length / 2));
      const titleHits = store.db.prepare(`
        SELECT displayPath, title, match_count FROM (
          SELECT collection || '/' || path as displayPath, title, modified_at,
            ${tokens.map(() => `(CASE WHEN LOWER(title) LIKE ? THEN 1 ELSE 0 END)`).join(" + ")} as match_count
          FROM documents
          WHERE active = 1 AND invalidated_at IS NULL
        ) WHERE match_count >= ?
        ORDER BY match_count DESC, modified_at DESC
        LIMIT ?
      `).all(...tokens.map(t => `%${t}%`), minMatch, limit) as { displayPath: string; title: string; match_count: number }[];

      if (titleHits.length > 0) {
        return titleHits.map(h => ({
          displayPath: h.displayPath,
          title: h.title,
          score: h.match_count / tokens.length,
          source: "title" as const,
        }));
      }
    }

    // 4. Vector search fallback (semantic similarity)
    try {
      const llm = getDefaultLlamaCpp();
      if (llm) {
        const vecResults = await store.searchVec(query, DEFAULT_EMBED_MODEL, limit);
        if (vecResults.length > 0) {
          return vecResults.map(r => ({
            displayPath: r.displayPath,
            title: r.title,
            score: r.score,
            source: "vec" as const,
          }));
        }
      }
    } catch (e) {
      rethrowIfFatalVectorError(e);
      // Vector search unavailable — degrade gracefully
    }

    return [];
  }

  /**
   * Select a single target from candidates, or return an ambiguity message.
   * Stricter confidence requirement for destructive ops (forget).
   */
  function selectLifecycleTarget(
    candidates: LifecycleCandidate[],
    query: string,
    destructive: boolean = false
  ): { target: LifecycleCandidate } | { ambiguous: string } | { notFound: string } {
    if (candidates.length === 0) {
      return { notFound: `No matching memory found for "${query}"` };
    }

    const top = candidates[0]!;

    // Clear winner: high score OR significant gap to #2. The gap clause requires an
    // actual #2 to gap against — a lone weak candidate must not qualify (destructive
    // ops would otherwise auto-select a garbage single match).
    const gap = candidates.length > 1 ? top.score - candidates[1]!.score : 1.0;
    const confident = top.score >= 0.7 || (candidates.length > 1 && gap >= 0.2);

    // For destructive ops (forget), require higher confidence
    if (destructive && !confident) {
      const list = candidates.slice(0, 3).map((c, i) =>
        `${i + 1}. ${c.displayPath} — "${c.title}" (${c.source}, score: ${c.score.toFixed(2)})`
      ).join("\n");
      return { ambiguous: `Multiple possible matches. Please be more specific or use a path:\n${list}` };
    }

    // For non-destructive ops (pin/snooze), accept top hit if any candidates exist
    if (!confident && candidates.length > 1) {
      // Low confidence but not destructive — take top hit but warn
      return { target: top };
    }

    return { target: top };
  }

  // ---------------------------------------------------------------------------
  // Tool: memory_forget
  // ---------------------------------------------------------------------------

  server.registerTool(
    "memory_forget",
    {
      title: "Forget Memory",
      description: "Remove a memory by searching for the closest match and deactivating it.",
      inputSchema: {
        query: z.string().describe("What to forget — searches for the closest match"),
        confirm: z.boolean().optional().default(true).describe("If true, deactivates the best match. If false, just shows what would be forgotten."),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, confirm, vault }) => {
      const s = getStore(vault);
      const candidates = await findMemoryCandidates(s, query, 5);
      const selection = selectLifecycleTarget(candidates, query, true); // destructive = true

      if ("notFound" in selection) {
        return { content: [{ type: "text", text: selection.notFound }] };
      }
      if ("ambiguous" in selection) {
        return { content: [{ type: "text", text: selection.ambiguous }] };
      }

      const best = selection.target;
      const parts = best.displayPath.split("/");
      const collection = parts[0]!;
      const path = parts.slice(1).join("/");

      if (!confirm) {
        return {
          content: [{ type: "text", text: `Would forget: ${best.displayPath} — "${best.title}" (${best.source}, score ${Math.round(best.score * 100)}%)` }],
          structuredContent: { path: best.displayPath, title: best.title, score: best.score, action: "preview" },
        };
      }

      s.deactivateDocument(collection, path, "forget");

      s.insertUsage({
        sessionId: "mcp-forget",
        timestamp: new Date().toISOString(),
        hookName: "memory_forget",
        injectedPaths: [best.displayPath],
        estimatedTokens: 0,
        wasReferenced: 0,
      });

      return {
        content: [{ type: "text", text: `Forgotten: ${best.displayPath} — "${best.title}"` }],
        structuredContent: { path: best.displayPath, title: best.title, action: "deactivated" },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: profile
  // ---------------------------------------------------------------------------

  server.registerTool(
    "profile",
    {
      title: "User Profile",
      description: "Get the current user profile (static facts + dynamic context). Rebuild if stale.",
      inputSchema: {
        rebuild: z.boolean().optional().default(false).describe("Force rebuild the profile"),
      },
    },
    async ({ rebuild }) => {
      const { getProfile: gp, updateProfile: up, isProfileStale: ips } = await import("./profile.ts");

      if (rebuild || ips(store)) {
        up(store);
      }

      const profile = gp(store);
      if (!profile) {
        return { content: [{ type: "text", text: "No profile available. Try: profile(rebuild=true)" }] };
      }

      const lines: string[] = [];
      if (profile.static.length > 0) {
        lines.push("## Known Context");
        for (const f of profile.static) lines.push(`- ${f}`);
      }
      if (profile.dynamic.length > 0) {
        lines.push("", "## Current Focus");
        for (const d of profile.dynamic) lines.push(`- ${d}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") || "Profile is empty." }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get (Retrieve document)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get",
    {
      title: "Get Document",
      description: "Retrieve document by file path or docid.",
      inputSchema: {
        file: z.string().describe("File path or docid (#abc123)"),
        fromLine: z.number().optional(),
        maxLines: z.number().optional(),
        lineNumbers: z.boolean().optional().default(false),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ file, fromLine, maxLines, lineNumbers, vault }) => {
      const store = getStore(vault);
      let parsedFromLine = fromLine;
      let lookup = file;
      const colonMatch = lookup.match(/:(\d+)$/);
      if (colonMatch?.[1] && parsedFromLine === undefined) {
        parsedFromLine = parseInt(colonMatch[1], 10);
        lookup = lookup.slice(0, -colonMatch[0].length);
      }

      const result = store.findDocument(lookup, { includeBody: false });
      if ("error" in result) {
        let msg = `Document not found: ${file}`;
        if (result.similarFiles.length > 0) {
          msg += `\n\nDid you mean?\n${result.similarFiles.map(s => `  - ${s}`).join('\n')}`;
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }

      const body = store.getDocumentBody(result, parsedFromLine, maxLines) ?? "";
      let text = body;
      if (lineNumbers) text = addLineNumbers(text, parsedFromLine || 1);
      if (result.context) text = `<!-- Context: ${result.context} -->\n\n` + text;

      return {
        content: [{
          type: "resource",
          resource: {
            uri: `clawmem://${encodeClawmemPath(result.displayPath)}`,
            name: result.displayPath,
            title: result.title,
            mimeType: "text/markdown",
            text,
          },
        }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: multi_get (Retrieve multiple documents)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "multi_get",
    {
      title: "Multi-Get Documents",
      description: "Retrieve multiple documents by glob pattern or comma-separated list.",
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated paths"),
        maxLines: z.number().optional(),
        maxBytes: z.number().optional().default(10240),
        lineNumbers: z.boolean().optional().default(false),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ pattern, maxLines, maxBytes, lineNumbers, vault }) => {
      const store = getStore(vault);
      const { docs, errors } = store.findDocuments(pattern, { includeBody: true, maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES });
      if (docs.length === 0 && errors.length === 0) {
        return { content: [{ type: "text", text: `No files matched: ${pattern}` }], isError: true };
      }

      const content: any[] = [];
      if (errors.length > 0) content.push({ type: "text", text: `Errors:\n${errors.join('\n')}` });

      for (const result of docs) {
        if (result.skipped) {
          content.push({ type: "text", text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}]` });
          continue;
        }
        let text = result.doc.body || "";
        if (maxLines !== undefined) {
          const lines = text.split("\n");
          text = lines.slice(0, maxLines).join("\n");
          if (lines.length > maxLines) text += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
        }
        if (lineNumbers) text = addLineNumbers(text);
        if (result.doc.context) text = `<!-- Context: ${result.doc.context} -->\n\n` + text;

        content.push({
          type: "resource",
          resource: {
            uri: `clawmem://${encodeClawmemPath(result.doc.displayPath)}`,
            name: result.doc.displayPath,
            title: result.doc.title,
            mimeType: "text/markdown",
            text,
          },
        });
      }
      return { content };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: status
  // ---------------------------------------------------------------------------

  server.registerTool(
    "status",
    {
      title: "Index Status",
      description: "Show ClawMem index status with content type distribution.",
      inputSchema: {
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ vault }) => {
      const store = getStore(vault);
      const status: StatusResult = store.getStatus();

      // Add content type distribution
      const typeCounts = store.db.prepare(`
        SELECT content_type, COUNT(*) as count FROM documents WHERE active = 1 GROUP BY content_type ORDER BY count DESC
      `).all() as { content_type: string; count: number }[];

      const summary = [
        `ClawMem Index Status:`,
        `  Total documents: ${status.totalDocuments}`,
        `  Needs embedding: ${status.needsEmbedding}`,
        `  Vector index: ${status.hasVectorIndex ? 'yes' : 'no'}`,
        `  Collections: ${status.collections.length}`,
      ];
      for (const col of status.collections) {
        summary.push(`    - ${col.name}: ${col.path} (${col.documents} docs)`);
      }
      if (typeCounts.length > 0) {
        summary.push(`  Content types:`);
        for (const t of typeCounts) {
          summary.push(`    - ${t.content_type}: ${t.count}`);
        }
      }

      return {
        content: [{ type: "text", text: summary.join('\n') }],
        structuredContent: { ...status, contentTypes: typeCounts },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: find_similar (NEW - SAME)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "find_similar",
    {
      title: "Find Similar Notes",
      description: "USE THIS for 'what else relates to X', 'show me similar docs'. Finds k-NN vector neighbors of a reference document — discovers connections beyond keyword overlap that search/query cannot find.",
      inputSchema: {
        file: z.string().describe("Path of reference document"),
        limit: z.number().optional().default(5),
        includeInternal: z.boolean().optional().default(false).describe("Include system-internal _clawmem docs — excluded by default (auto-included when the REFERENCE doc is itself internal)"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ file, limit, includeInternal, vault }) => {
      const store = getStore(vault);
      const tableExists = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
      if (!tableExists) {
        return { content: [{ type: "text", text: "Vector index not found. Run 'clawmem embed' first." }], isError: true };
      }

      // Get the reference document's body
      const result = store.findDocument(file, { includeBody: false });
      if ("error" in result) {
        return { content: [{ type: "text", text: `Document not found: ${file}` }], isError: true };
      }

      const body = store.getDocumentBody(result) ?? "";
      const title = result.title || file;

      // Internal-reference auto-exception (T2-M7): exploring FROM an internal doc is an
      // explicit ask for the internal space — include internal neighbors.
      const refIsInternal = INTERNAL_COLLECTIONS.includes(result.collectionName);
      const excl = resolveExcludedCollections(includeInternal || refIsInternal);

      // Use the document's content as the search query
      const queryText = `${title}\n${body.slice(0, 1000)}`;
      const det = await store.searchVecDetailed(queryText, DEFAULT_EMBED_MODEL, (limit || 5) + 1, { excludeCollections: excl });

      // Filter out the reference document itself
      const similar = det.results
        .filter(r => r.filepath !== result.filepath)
        .slice(0, limit || 5);
      const fsDegraded = det.degraded && det.degradedReason ? { degraded: true as const, degradedReason: det.degradedReason } : {};
      const fsDegradedNote = det.degraded && det.degradedReason ? `\n${degradedGuidanceText([{ leg: "find_similar", reason: det.degradedReason }])}` : "";

      const items: SearchResultItem[] = similar.map(r => {
        const { line, snippet } = extractSnippet(r.body || "", title, 200);
        return {
          docid: `#${r.docid}`,
          file: r.displayPath,
          title: r.title,
          score: Math.round(r.score * 100) / 100,
          context: store.getContextForFile(r.filepath),
          snippet: addLineNumbers(snippet, line),
        };
      });

      return {
        content: [{ type: "text", text: `${items.length} similar to "${title}":\n${items.map(i => `  ${i.file} (${Math.round(i.score * 100)}%)`).join('\n')}${fsDegradedNote}` }],
        structuredContent: { reference: file, results: items, ...fsDegraded },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: reindex (NEW - SAME)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "reindex",
    {
      title: "Re-index Collections",
      description: "Trigger a re-scan of all collections. Detects new, changed, and deleted documents.",
      inputSchema: {
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ vault }) => {
      const store = getStore(vault);
      const collections = listCollections();
      const totalStats: IndexStats = { added: 0, updated: 0, unchanged: 0, removed: 0, dated: 0, enrichAttempted: 0, enrichStored: 0 };

      for (const col of collections) {
        const stats = await indexCollection(store, col.name, col.path, col.pattern);
        totalStats.added += stats.added;
        totalStats.updated += stats.updated;
        totalStats.unchanged += stats.unchanged;
        totalStats.removed += stats.removed;
        totalStats.dated += stats.dated;
        totalStats.enrichAttempted += stats.enrichAttempted;
        totalStats.enrichStored += stats.enrichStored;
      }

      // Issue #24: surface enrichment productivity in the summary — a run where
      // every enrichment produced nothing must not read as an unqualified success.
      const enrichNote = totalStats.enrichAttempted === 0
        ? ""
        : totalStats.enrichStored === totalStats.enrichAttempted
          ? `, ✎${totalStats.enrichStored}/${totalStats.enrichAttempted} notes`
          : `, ✎${totalStats.enrichStored}/${totalStats.enrichAttempted} notes (${totalStats.enrichAttempted - totalStats.enrichStored} produced nothing — LLM endpoint problem? run 'clawmem doctor')`;
      const summary = `Reindex complete: +${totalStats.added} added, ~${totalStats.updated} updated, =${totalStats.unchanged} unchanged, -${totalStats.removed} removed${enrichNote}`;
      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: { ...totalStats } as Record<string, unknown>,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: index_stats (NEW - SAME)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "index_stats",
    {
      title: "Index Statistics",
      description: "Detailed index statistics with content type distribution, staleness info, and memory health.",
      inputSchema: {
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ vault }) => {
      const store = getStore(vault);
      const status = store.getStatus();
      const typeCounts = store.db.prepare(
        `SELECT content_type, COUNT(*) as count FROM documents WHERE active = 1 GROUP BY content_type ORDER BY count DESC`
      ).all() as { content_type: string; count: number }[];

      const staleCount = store.db.prepare(
        `SELECT COUNT(*) as count FROM documents WHERE active = 1 AND review_by IS NOT NULL AND review_by <= ?`
      ).get(new Date().toISOString()) as { count: number };

      const recentSessions = store.getRecentSessions(5);
      const avgAccessCount = store.db.prepare(
        `SELECT AVG(access_count) as avg FROM documents WHERE active = 1`
      ).get() as { avg: number | null };

      const stats = {
        totalDocuments: status.totalDocuments,
        needsEmbedding: status.needsEmbedding,
        hasVectorIndex: status.hasVectorIndex,
        collections: status.collections.length,
        contentTypes: typeCounts,
        staleDocuments: staleCount.count,
        recentSessions: recentSessions.length,
        avgAccessCount: Math.round((avgAccessCount.avg ?? 0) * 100) / 100,
      };

      const summary = [
        `Index Statistics:`,
        `  Documents: ${stats.totalDocuments} (${stats.needsEmbedding} need embedding)`,
        `  Stale documents: ${stats.staleDocuments}`,
        `  Recent sessions: ${stats.recentSessions}`,
        `  Avg access count: ${stats.avgAccessCount}`,
        `  Content types:`,
        ...typeCounts.map(t => `    ${t.content_type}: ${t.count}`),
      ];

      return {
        content: [{ type: "text", text: summary.join('\n') }],
        structuredContent: stats,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: memory_stats (v0.36.0 — deterministic lifecycle/ranking-metadata aggregates)
  // ---------------------------------------------------------------------------

  const round3 = (n: number | null | undefined): number | null =>
    n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000;
  const orNA = (n: number | null | undefined): string =>
    n === null || n === undefined ? "n/a" : String(n);
  // Structured unknown-vault error (Source 57 contract: available-name errors for
  // collection AND vault args). Returns null when the vault resolves.
  const unknownVaultError = (vault: string | undefined) => {
    if (vault === undefined) return null;
    const availableVaults = listVaults();
    if (availableVaults.includes(vault)) return null;
    return {
      content: [{ type: "text" as const, text: `Unknown vault "${vault}". Available: ${availableVaults.join(", ") || "(none)"}` }],
      structuredContent: { error: "unknown_vault", requested: vault, available: availableVaults } as Record<string, unknown>,
      isError: true,
    };
  };

  server.registerTool(
    "memory_stats",
    {
      title: "Memory Statistics (lifecycle + ranking metadata)",
      description: "Deterministic SQL aggregates per collection: counts by active state, origin×active lifecycle cross-tabs, deactivation reasons, pinned counts, accrual rates (7d/30d), created-at span, and ranking-metadata distributions (access_count, confidence, quality, effective-time age — mean/median/min/max) over ACTIVE rows. Complements index_stats (embedding coverage / content types). Includes system collections — nothing is filtered. Read-only.",
      inputSchema: {
        collection: z.string().optional().describe("Restrict to one collection; an unknown name returns the available list"),
        vault: z.string().optional().describe("Named vault (omit for default vault); an unknown name returns the available list"),
      },
    },
    async ({ collection, vault }) => {
      const vaultErr = unknownVaultError(vault);
      if (vaultErr) return vaultErr;
      const store = getStore(vault);
      // Fail-loud contract (no partial stats): any SQL error below propagates to the
      // MCP error surface — a stats tool that silently drops a section reports a
      // smaller vault as if it were the whole truth.
      const available = (store.db.prepare(
        `SELECT DISTINCT collection FROM documents ORDER BY collection`
      ).all() as { collection: string }[]).map(r => r.collection);

      if (collection !== undefined && !available.includes(collection)) {
        return {
          content: [{ type: "text", text: `Unknown collection "${collection}". Available: ${available.join(", ") || "(none)"}` }],
          structuredContent: { error: "unknown_collection", requested: collection, available } as Record<string, unknown>,
          isError: true,
        };
      }

      const where = collection !== undefined ? "WHERE collection = ?" : "";
      const params: string[] = collection !== undefined ? [collection] : [];
      const nowMs = Date.now();
      const cut7 = new Date(nowMs - 7 * 86400_000).toISOString();
      const cut30 = new Date(nowMs - 30 * 86400_000).toISOString();
      // Effective-time age (days) per §51.1: authored_at ?? modified_at — the same axis
      // recency ranking decays on. julianday('now') keeps the whole expression in SQL.
      const EFF_AGE = `julianday('now') - julianday(COALESCE(authored_at, modified_at))`;

      type StatsRow = {
        collection: string; total: number; active: number; inactive: number;
        fs_active: number; fs_inactive: number; api_active: number; api_inactive: number;
        legacy_active: number; legacy_inactive: number; pinned: number;
        created_7d: number; created_30d: number; first_created: string | null; last_created: string | null;
        access_max: number | null; access_mean: number | null; access_min: number | null; access_nonzero: number;
        confidence_mean: number | null; confidence_min: number | null; confidence_max: number | null;
        quality_mean: number | null; quality_min: number | null; quality_max: number | null;
        eff_age_mean: number | null; eff_age_min: number | null; eff_age_max: number | null;
      };
      // Counts and cross-tabs cover ALL rows; distribution aggregates (access/confidence/
      // quality/effective age) cover ACTIVE rows only — ranking never sees inactive rows,
      // so mixing them in would misstate the live corpus the scorer operates on.
      const rows = store.db.prepare(`
        SELECT collection,
               COUNT(*) AS total,
               SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS inactive,
               SUM(CASE WHEN origin = 'fs' AND active = 1 THEN 1 ELSE 0 END) AS fs_active,
               SUM(CASE WHEN origin = 'fs' AND active = 0 THEN 1 ELSE 0 END) AS fs_inactive,
               SUM(CASE WHEN origin = 'api' AND active = 1 THEN 1 ELSE 0 END) AS api_active,
               SUM(CASE WHEN origin = 'api' AND active = 0 THEN 1 ELSE 0 END) AS api_inactive,
               SUM(CASE WHEN origin IS NULL AND active = 1 THEN 1 ELSE 0 END) AS legacy_active,
               SUM(CASE WHEN origin IS NULL AND active = 0 THEN 1 ELSE 0 END) AS legacy_inactive,
               SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS pinned,
               SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS created_7d,
               SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS created_30d,
               MIN(created_at) AS first_created,
               MAX(created_at) AS last_created,
               MAX(CASE WHEN active = 1 THEN access_count END) AS access_max,
               AVG(CASE WHEN active = 1 THEN access_count END) AS access_mean,
               MIN(CASE WHEN active = 1 THEN access_count END) AS access_min,
               SUM(CASE WHEN active = 1 AND access_count > 0 THEN 1 ELSE 0 END) AS access_nonzero,
               AVG(CASE WHEN active = 1 THEN confidence END) AS confidence_mean,
               MIN(CASE WHEN active = 1 THEN confidence END) AS confidence_min,
               MAX(CASE WHEN active = 1 THEN confidence END) AS confidence_max,
               AVG(CASE WHEN active = 1 THEN quality_score END) AS quality_mean,
               MIN(CASE WHEN active = 1 THEN quality_score END) AS quality_min,
               MAX(CASE WHEN active = 1 THEN quality_score END) AS quality_max,
               AVG(CASE WHEN active = 1 THEN ${EFF_AGE} END) AS eff_age_mean,
               MIN(CASE WHEN active = 1 THEN ${EFF_AGE} END) AS eff_age_min,
               MAX(CASE WHEN active = 1 THEN ${EFF_AGE} END) AS eff_age_max
        FROM documents ${where}
        GROUP BY collection
        ORDER BY total DESC
      `).all(cut7, cut30, ...params) as StatsRow[];

      // Medians over ACTIVE rows, per collection and per metric. (cnt+1)/2 and (cnt+2)/2
      // under integer division select the middle row (odd) or middle pair (even).
      // `expr` values are the fixed literals below — never caller input.
      const medianOf = (expr: string): Map<string, number> => new Map(
        (store.db.prepare(`
          WITH ranked AS (
            SELECT collection, ${expr} AS v,
                   ROW_NUMBER() OVER (PARTITION BY collection ORDER BY ${expr}) AS rn,
                   COUNT(*) OVER (PARTITION BY collection) AS cnt
            FROM documents ${where ? where + " AND active = 1" : "WHERE active = 1"}
          )
          SELECT collection, AVG(v) AS median
          FROM ranked
          WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
          GROUP BY collection
        `).all(...params) as { collection: string; median: number }[]).map(m => [m.collection, m.median])
      );
      const medAccess = medianOf("access_count");
      const medConfidence = medianOf("confidence");
      const medQuality = medianOf("quality_score");
      const medEffAge = medianOf(EFF_AGE);

      const reasons = store.db.prepare(`
        SELECT deactivated_reason AS reason, COUNT(*) AS count
        FROM documents ${where ? where + " AND active = 0" : "WHERE active = 0"}
        GROUP BY deactivated_reason
        ORDER BY count DESC
      `).all(...params) as { reason: string | null; count: number }[];

      const collectionsOut = rows.map(r => ({
        collection: r.collection,
        total: r.total,
        active: r.active,
        inactive: r.inactive,
        origins: {
          fs: { total: r.fs_active + r.fs_inactive, active: r.fs_active, inactive: r.fs_inactive },
          api: { total: r.api_active + r.api_inactive, active: r.api_active, inactive: r.api_inactive },
          legacy: { total: r.legacy_active + r.legacy_inactive, active: r.legacy_active, inactive: r.legacy_inactive },
        },
        pinned: r.pinned,
        accrual: { created7d: r.created_7d, created30d: r.created_30d },
        span: { firstCreated: r.first_created, lastCreated: r.last_created },
        accessCount: {
          max: r.access_max, mean: round3(r.access_mean), min: r.access_min,
          median: round3(medAccess.get(r.collection) ?? null), nonzero: r.access_nonzero,
        },
        confidence: {
          mean: round3(r.confidence_mean), median: round3(medConfidence.get(r.collection) ?? null),
          min: round3(r.confidence_min), max: round3(r.confidence_max),
        },
        quality: {
          mean: round3(r.quality_mean), median: round3(medQuality.get(r.collection) ?? null),
          min: round3(r.quality_min), max: round3(r.quality_max),
        },
        effectiveAgeDays: {
          mean: round3(r.eff_age_mean), median: round3(medEffAge.get(r.collection) ?? null),
          min: round3(r.eff_age_min), max: round3(r.eff_age_max),
        },
      }));

      const lines = [
        `Memory statistics${vault ? ` (vault: ${vault})` : ""}${collection ? ` — collection ${collection}` : ` — ${collectionsOut.length} collection(s)`}:`,
        ...collectionsOut.map(c =>
          `  ${c.collection}: ${c.active}/${c.total} active (fs ${c.origins.fs.active}+${c.origins.fs.inactive}, api ${c.origins.api.active}+${c.origins.api.inactive}, legacy ${c.origins.legacy.active}+${c.origins.legacy.inactive}; active+inactive)` +
          `${c.pinned ? `, pinned ${c.pinned}` : ""}, +${c.accrual.created7d}/7d +${c.accrual.created30d}/30d` +
          `, access max ${orNA(c.accessCount.max)} med ${orNA(c.accessCount.median)} mean ${orNA(c.accessCount.mean)} (nonzero ${c.accessCount.nonzero})` +
          `, eff-age med ${orNA(c.effectiveAgeDays.median)}d`
        ),
        ...(reasons.length ? [
          `  Deactivation reasons:`,
          ...reasons.map(x => `    ${x.reason ?? "(null — pre-v0.31.0)"}: ${x.count}`),
        ] : []),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          vault: vault ?? "default",
          generatedAt: new Date(nowMs).toISOString(),
          collections: collectionsOut,
          deactivationReasons: reasons,
        } as Record<string, unknown>,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: memory_rank (v0.36.0 — composite ranking explanation)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "memory_rank",
    {
      title: "Ranking Explanation (composite breakdown)",
      description: "Deterministic ranking diagnostic: runs the real FTS + composite scoring pipeline for a query and returns each result's per-factor breakdown (weights, recency, confidence blend, quality/length/frequency multipliers, pin and co-activation deltas) plus raw-vs-composite rank shifts (positive shift = composite promoted the doc). Output is the UNION of the composite top-limit and the raw top-limit, so raw winners demoted out of the composite view stay visible. FTS-only candidates — no vector or LLM stage. Read-only.",
      inputSchema: {
        query: z.string().describe("Query to explain ranking for"),
        limit: z.number().int().min(1).max(50).optional().default(10).describe("Results to explain per view (1-50)"),
        collection: z.string().optional().describe("Filter to collection (single name or comma-separated)"),
        weightProfile: z.enum(["default", "query"]).optional().default("default").describe("Composite weights to explain: 'default' = hook/memory_retrieve (0.50/0.25/0.25), 'query' = the query tool's (0.70/0.15/0.15). Recency-intent queries use the recency weights regardless, as in production."),
        includeInternal: z.boolean().optional().default(false).describe("Include system-internal _clawmem docs (observations/deductions) — excluded by default"),
        vault: z.string().optional().describe("Named vault (omit for default vault); an unknown name returns the available list"),
      },
    },
    async ({ query, limit, collection, weightProfile, includeInternal, vault }) => {
      const vaultErr = unknownVaultError(vault);
      if (vaultErr) return vaultErr;
      const store = getStore(vault);
      const lim = limit ?? 10;
      const collections = collection
        ? collection.split(",").map(c => c.trim()).filter(Boolean)
        : undefined;
      const excl = resolveExcludedCollections(includeInternal, collections);
      // Wider candidate pool than `limit` so raw-vs-composite rank shifts stay visible
      // when the two orderings diverge deep into the pool.
      const candidateN = Math.min(Math.max(lim * 3, 30), 100);
      const results = store.searchFTS(query, candidateN, undefined, collections, undefined, excl);
      const enriched = enrichResults(store, results, query);
      const coFn = (path: string) => store.getCoActivated(path);
      const scored = applyCompositeScoring(enriched, query, coFn, {
        explain: true,
        weights: weightProfile === "query" ? QUERY_WEIGHTS : undefined,
      });

      // Raw ordering = production `search`'s non-recency ordering (rankRawPrimary),
      // including its tie contract (pin → legacy composite → path) — NOT a re-sort of
      // the composite-ordered array, which would let exact raw ties inherit composite
      // order. Ranks are keyed by filepath: docids are content-hash prefixes, so
      // identical-content documents at different paths share a docid and would
      // overwrite each other's rank.
      const rawRanked = rankRawPrimary(enriched, query, coFn);
      const rawRankByPath = new Map<string, number>();
      rawRanked.forEach((r, i) => rawRankByPath.set(r.filepath, i + 1));

      const recencyIntent = hasRecencyIntent(query);
      // Union view (relevance-inversion visibility): the composite top-limit PLUS any
      // raw-top-limit doc the composite ordering pushed below the cutoff — the demoted
      // raw winner is the central defect signature and must not vanish from the report.
      const inRawTop = new Set(rawRanked.slice(0, lim).map(r => r.filepath));
      const selected: { r: (typeof scored)[number]; compositeRank: number; demotedRawWinner: boolean }[] = [];
      scored.forEach((r, i) => {
        if (i < lim) selected.push({ r, compositeRank: i + 1, demotedRawWinner: false });
        else if (inRawTop.has(r.filepath)) selected.push({ r, compositeRank: i + 1, demotedRawWinner: true });
      });

      const items = selected.map(({ r, compositeRank, demotedRawWinner }) => ({
        docid: `#${r.docid}`,
        path: r.displayPath,
        title: r.title,
        contentType: r.contentType,
        pinned: r.pinned,
        searchScore: round3(r.score),
        compositeScore: round3(r.compositeScore),
        compositeRank,
        rawRank: rawRankByPath.get(r.filepath)!,
        rankShift: rawRankByPath.get(r.filepath)! - compositeRank,
        demotedRawWinner,
        breakdown: r.rankBreakdown,
      }));

      const lines = [
        `Ranking explanation for "${query}" (${scored.length} candidate(s), showing ${items.length} = composite top ${Math.min(lim, scored.length)} ∪ demoted raw winners; weights: ${recencyIntent ? "recency-intent" : weightProfile}):`,
        ...items.map(it => {
          const b = it.breakdown!;
          const parts = [
            `search ${it.searchScore}`,
            `recency ${round3(b.recencyScore)}`,
            `conf ${round3(b.blendedConfidence)}`,
            `×q ${round3(b.qualityMultiplier)}`,
            `×len ${round3(b.lengthFactor)}${b.lengthFloorApplied ? "(floor)" : ""}`,
          ];
          if (b.frequencyBoostMultiplier !== 1) parts.push(`×freq ${round3(b.frequencyBoostMultiplier)}`);
          if (b.canonicalMultiplier !== 1) parts.push(`×canon ${round3(b.canonicalMultiplier)}`);
          // Any nonzero pin delta renders — a NEGATIVE delta is the pin-cap clamp
          // (RANKING-DEFECT-HANDOFF §Addendum) and hiding it would bury the inversion.
          if (b.pinBoost !== 0) parts.push(`pinΔ ${round3(b.pinBoost)}`);
          if (b.coActivationMultiplier !== 1) parts.push(`×co ${round3(b.coActivationMultiplier)}`);
          const shift = it.rankShift === 0 ? "" : ` (raw #${it.rawRank}, shift ${it.rankShift > 0 ? "+" : ""}${it.rankShift})`;
          const demoted = it.demotedRawWinner ? " ⚠ demoted raw winner" : "";
          return `  #${it.compositeRank} ${it.path} — composite ${it.compositeScore}${shift}${demoted} [${parts.join(", ")}]`;
        }),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          query,
          recencyIntent,
          weightProfile: recencyIntent ? "recency" : weightProfile,
          scoreBasis: "composite-explain",
          view: "composite-top ∪ raw-top",
          candidateCount: scored.length,
          results: items,
        } as Record<string, unknown>,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: session_log (NEW - SAME)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "session_log",
    {
      title: "Session Log",
      description: "USE THIS when user references prior sessions: 'last time', 'yesterday', 'what happened', 'what did we do'. Returns session history with handoffs and file changes. DO NOT use query() for cross-session questions — this tool has session-specific data that search cannot find.",
      inputSchema: {
        limit: z.number().optional().default(10),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ limit, vault }) => {
      const store = getStore(vault);
      const sessions = store.getRecentSessions(limit || 10);
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: "No sessions tracked yet." }] };
      }

      const lines: string[] = [];
      for (const s of sessions) {
        const duration = s.endedAt
          ? `${Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60000)}min`
          : "active";
        lines.push(`${s.sessionId.slice(0, 8)} ${s.startedAt} (${duration})`);
        if (s.handoffPath) lines.push(`  Handoff: ${s.handoffPath}`);
        if (s.summary) lines.push(`  ${s.summary.slice(0, 100)}`);
        if (s.filesChanged.length > 0) lines.push(`  Files: ${s.filesChanged.slice(0, 5).join(", ")}`);
      }

      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: { sessions },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: beads_sync
  // ---------------------------------------------------------------------------

  server.registerTool(
    "beads_sync",
    {
      title: "Sync Beads Issues",
      description: "Sync Beads issues from Dolt backend (bd CLI) into ClawMem search index. Queries live Dolt database — no stale JSONL dependency.",
      inputSchema: {
        project_path: z.string().optional().describe("Path to project with .beads/ directory (default: cwd)"),
      },
    },
    async ({ project_path }) => {
      const cwd = project_path || process.cwd();
      const projectDir = store.detectBeadsProject(cwd);

      if (!projectDir) {
        return {
          content: [{ type: "text", text: "No Beads project found. Expected .beads/ directory in project path." }],
        };
      }

      try {
        const result = await store.syncBeadsIssues(projectDir);

        // A-MEM enrichment for newly created docs (generates semantic/entity edges)
        if (result.newDocIds.length > 0) {
          try {
            const llm = getDefaultLlamaCpp();
            for (const docId of result.newDocIds) {
              await store.postIndexEnrich(llm, docId, true);
            }
          } catch (enrichErr) {
            console.error(`[beads] A-MEM enrichment failed (non-fatal):`, enrichErr);
          }
        }

        return {
          content: [{
            type: "text",
            text: `Beads sync complete:\n  - ${result.created} new issues indexed\n  - ${result.synced} existing issues updated\n  - ${result.newDocIds.length} docs enriched with A-MEM\n  - Total: ${result.created + result.synced} issues`,
          }],
          structuredContent: { ...result, project_dir: projectDir },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Beads sync failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: build_graphs
  // ---------------------------------------------------------------------------

  server.registerTool(
    "build_graphs",
    {
      title: "Build Memory Graphs",
      description: "Build temporal and semantic graphs for MAGMA multi-graph memory. Run after indexing documents.",
      inputSchema: {
        graph_types: z.array(z.enum(['temporal', 'semantic', 'all'])).optional().default(['all']),
        semantic_threshold: z.number().optional().default(0.7).describe("Similarity threshold for semantic edges (0.0-1.0)"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ graph_types, semantic_threshold, vault }) => {
      const store = getStore(vault);
      const types = graph_types || ['all'];
      const shouldBuildTemporal = types.includes('temporal') || types.includes('all');
      const shouldBuildSemantic = types.includes('semantic') || types.includes('all');

      const results: { temporal?: number; semantic?: number; temporalTotal?: number; semanticTotal?: number } = {};

      if (shouldBuildTemporal) {
        results.temporal = store.buildTemporalBackbone();
      }

      if (shouldBuildSemantic) {
        results.semantic = await store.buildSemanticGraph(semantic_threshold);
      }

      // The builders count rows SQLite actually inserted, so a second idempotent build
      // legitimately reports 0 new edges while the graph is fully populated. Report the
      // standing total alongside, or "0 edges" reads as "the graph is empty".
      //
      // Counts only edges whose BOTH endpoints are active — the same population the builders
      // operate on. Shared with the REST endpoint via the store so the two cannot drift.
      const totalFor = (t: string) => store.countActiveRelations(t);

      const lines = [];
      if (results.temporal !== undefined) {
        results.temporalTotal = totalFor("temporal");
        lines.push(`Temporal graph: ${results.temporal} new edge(s), ${results.temporalTotal} total`);
      }
      if (results.semantic !== undefined) {
        results.semanticTotal = totalFor("semantic");
        lines.push(`Semantic graph: ${results.semantic} new edge(s), ${results.semanticTotal} total`);
      }

      return {
        content: [{
          type: "text",
          text: `Graph building complete:\n  ${lines.join('\n  ')}`,
        }],
        structuredContent: results,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: intent_search
  // ---------------------------------------------------------------------------

  server.registerTool(
    "intent_search",
    {
      title: "Intent-Aware Search",
      description: "USE THIS for 'why did we decide X', 'what caused Y', 'who worked on Z'. Classifies intent (WHY/WHEN/ENTITY) and traverses causal + semantic graph edges. Returns decision chains that query() CANNOT find. If asking about reasons, causes, decisions, or entities — this tool, not query().",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z.number().optional().default(10),
        force_intent: z.enum(['WHY', 'WHEN', 'ENTITY', 'WHAT']).optional().describe("Override automatic intent detection"),
        enable_graph_traversal: z.boolean().optional().default(true).describe("Enable multi-hop graph expansion"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, force_intent, enable_graph_traversal, vault }) => {
      const store = getStore(vault);
      const llm = getDefaultLlamaCpp();

      // Shared intent-aware causal pipeline (v0.32.0) — unfiltered by design (system memory is
      // this tool's substrate; docs/reference/mcp-tools.md), so no observation lane: its anchors
      // already reach _clawmem. enable_graph_traversal=false disables EVERY graph stage
      // (adaptive, MPFP, entity expansion, causal one-hop); anchor search + rerank remain.
      const graphOn = enable_graph_traversal !== false;
      const { intent, results: pipelineResults, associations } = await runCausalRetrieval(store, llm, query, {
        forceIntent: force_intent as IntentType | undefined,
        stages: { traversal: graphOn, mpfp: graphOn, entityExpansion: graphOn, rerank: true, causalOneHop: graphOn },
        baseEligibility: {},
        whyObservationLane: false,
      });
      const expanded = pipelineResults;

      // Composite scoring
      const enriched = enrichResults(store, expanded, query);

      const scored = applyCompositeScoring(enriched, query);

      // Format results — one-hop causal hits carry their associations (anchor + direction)
      const results = scored.slice(0, limit || 10).map(r => {
        const causal = associations.get(r.filepath);
        return {
          docid: r.docid,
          file: r.filepath,
          title: r.title,
          score: r.score,
          compositeScore: r.compositeScore,
          context: r.context,
          snippet: r.body?.slice(0, 300) || '',
          contentType: r.contentType,
          ...(causal ? { causal } : {}),
        };
      });

      return {
        content: [{
          type: "text",
          text: `Intent: ${intent.intent} (${Math.round(intent.confidence * 100)}% confidence)\n\n${formatSearchSummary(results, query)}`,
        }],
        structuredContent: {
          intent: intent.intent,
          confidence: intent.confidence,
          results,
        },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: query_plan (Multi-Query Decomposition)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "query_plan",
    {
      title: "Query Plan (Multi-Query Decomposition)",
      description: "USE THIS for complex multi-topic queries ('tell me about X and also Y', 'compare A with B in the context of C'). Decomposes into parallel typed retrieval clauses. DO NOT use query() for multi-topic — it searches as one blob. This tool splits topics and routes each optimally.",
      inputSchema: {
        query: z.string().describe("Complex or multi-topic query"),
        limit: z.number().optional().default(10),
        compact: z.boolean().optional().default(true).describe("Return compact results"),
        includeInternal: z.boolean().optional().default(false).describe("Include system-internal _clawmem docs (observations/deductions) — excluded by default"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, compact, includeInternal, vault }) => {
      const store = getStore(vault);
      const llm = getDefaultLlamaCpp();

      // Decompose query into typed clauses
      const clauses = await decomposeQuery(query, llm, store.db);

      // Sort by priority and execute each clause
      const sortedClauses = [...clauses].sort((a, b) => a.priority - b.priority);
      const allResults: SearchResult[] = [];
      const clauseDetails: { type: string; query: string; priority: number; resultCount: number }[] = [];
      const degradedLegs: DegradedLeg[] = [];

      let clauseIdx = 0;
      const planAssociations = new Map<string, CausalAssociation[]>();
      for (const clause of sortedClauses) {
        const clauseExcl = resolveExcludedCollections(includeInternal, clause.collections);
        let results: SearchResult[] = [];
        if (clause.type === 'bm25') {
          results = store.searchFTS(clause.query, 20, undefined, clause.collections, undefined, clauseExcl);
        } else if (clause.type === 'vector') {
          const det = await store.searchVecDetailed(clause.query, DEFAULT_EMBED_MODEL, 20, { collections: clause.collections, excludeCollections: clauseExcl });
          results = det.results;
          if (det.degraded && det.degradedReason) degradedLegs.push({ leg: `clause${clauseIdx}:vector`, reason: det.degradedReason });
        } else if (clause.type === 'graph') {
          // Graph clause → shared causal pipeline (v0.32.0), keeping this site's bounded
          // variant: traversal + one-hop only, smaller budgets, no MPFP/entity/rerank
          // (the plan-level RRF below does the final ranking). clause.collections now
          // constrain traversal too, not just anchors.
          const { results: graphResults, degraded: graphDegraded, associations: graphAssociations } = await runCausalRetrieval(store, llm, clause.query, {
            stages: { traversal: true, mpfp: false, entityExpansion: false, rerank: false, causalOneHop: true },
            budgets: { anchorLimit: 15, seedCount: 5, traversalBeam: 3, traversalBudget: 15 },
            baseEligibility: { allowCollections: clause.collections, excludeCollections: clauseExcl },
            whyObservationLane: true,
          });
          for (const d of graphDegraded) degradedLegs.push({ leg: `clause${clauseIdx}:graph:${d.leg.replace(/^causal:/, "")}`, reason: d.reason });
          // One-hop associations survive clause merging and reach the final items (T6-F10).
          for (const [fp, assoc] of graphAssociations) {
            const existing = planAssociations.get(fp) ?? [];
            for (const a of assoc) {
              if (!existing.some(e => e.anchorDocid === a.anchorDocid && e.direction === a.direction)) existing.push(a);
            }
            planAssociations.set(fp, existing);
          }
          results = graphResults;
        }
        clauseDetails.push({ type: clause.type, query: clause.query, priority: clause.priority, resultCount: results.length });
        allResults.push(...results);
        clauseIdx++;
      }

      // Deduplicate by filepath, keeping highest score
      const deduped = new Map<string, SearchResult>();
      for (const r of allResults) {
        const existing = deduped.get(r.filepath);
        if (!existing || r.score > existing.score) deduped.set(r.filepath, r);
      }

      // RRF merge across clauses for final ranking
      const clauseLists = sortedClauses.map((clause, idx) => {
        const start = sortedClauses.slice(0, idx).reduce((sum, c, i) => sum + clauseDetails[i]!.resultCount, 0);
        const end = start + clauseDetails[idx]!.resultCount;
        return allResults.slice(start, end).map(toRanked);
      });
      const finalRanked = reciprocalRankFusion(clauseLists, sortedClauses.map(c => 6 - c.priority));

      // Map back to SearchResults
      const resultMap = new Map([...deduped.values()].map(r => [r.filepath, r]));
      const finalResults = finalRanked
        .map(fr => { const r = resultMap.get(fr.file); return r ? { ...r, score: fr.score } : null; })
        .filter((r): r is SearchResult => r !== null);

      const enriched = enrichResults(store, finalResults, query);
      const coFn: CoActivationFn = (path) => store.getCoActivated(path);
      const scored = applyCompositeScoring(enriched, query, coFn).slice(0, limit || 10);

      const planSummary = clauseDetails.map(c => `  ${c.type}(p${c.priority}): "${c.query}" → ${c.resultCount} results`).join("\n");
      const planDegraded = degradedLegs.length > 0 ? { degraded: true as const, degradedLegs } : {};
      const planDegradedNote = degradedLegs.length > 0 ? `\n${degradedGuidanceText(degradedLegs)}` : "";

      if (compact) {
        const items = scored.map(r => {
          const causal = planAssociations.get(r.filepath);
          return {
            docid: `#${r.docid}`, path: r.displayPath, title: r.title,
            score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
            snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
            authored_at: r.authoredAt ?? null,
            ...(causal ? { causal } : {}),
          };
        });
        return {
          content: [{ type: "text", text: `Query Plan (${sortedClauses.length} clauses):\n${planSummary}\n\n${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}${planDegradedNote}` }],
          structuredContent: { plan: clauseDetails, results: items, ...planDegraded },
        };
      }

      const items = scored.map(r => {
        const causal = planAssociations.get(r.filepath);
        return {
          docid: r.docid, file: r.filepath, title: r.title, score: r.score,
          compositeScore: r.compositeScore, context: r.context, snippet: r.body?.slice(0, 300) || '', contentType: r.contentType,
          ...(causal ? { causal } : {}),
        };
      });
      return {
        content: [{ type: "text", text: `Query Plan (${sortedClauses.length} clauses):\n${planSummary}\n\n${formatSearchSummary(items, query)}${planDegradedNote}` }],
        structuredContent: { plan: clauseDetails, results: items, ...planDegraded },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: find_causal_links (A-MEM)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "find_causal_links",
    {
      title: "Find Causal Links",
      description: "USE THIS to trace causal evidence: 'what led to X', 'what did X cause'. Returns directed causal edge records — invariant sourceDocId/targetDocId plus separate traversal depth/direction — each carrying up to 3 fact-pair witnesses with reasoning. Evidence-preserving edge traversal; multi-hop CHAIN quality is experimental (depth > 1 records are per-edge evidence, not a verified chain).",
      inputSchema: {
        docid: z.string().describe("Document ID (e.g., '#a1b2c3' — a 6-64 char hex hash prefix)"),
        direction: z.enum(['causes', 'caused_by', 'both']).optional().default('both').describe("Direction: 'causes' (outbound), 'caused_by' (inbound), or 'both'"),
        depth: z.number().optional().default(5).describe("Maximum traversal depth (1-10)"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ docid, direction, depth, vault }) => {
      const store = getStore(vault);
      // s342 D4: EVERY exit of this tool — errors included — is byte-bounded.
      // The caller-controlled docid is display-bounded before it is echoed.
      const docidEcho = docid.slice(0, 256);
      // Resolve docid to document
      const resolved = store.findDocumentByDocid(docid);
      if (!resolved) {
        return {
          content: [{ type: "text", text: `Document not found: ${docidEcho}` }],
        };
      }

      // Get the numeric docId. s342: anchor eligibility — the reader enforces
      // `active = 1 AND invalidated_at IS NULL` on the anchor and on every
      // recursive expansion, so an invalidated anchor resolves to nothing here.
      const doc = store.db.prepare(`
        SELECT id, title, collection, path
        FROM documents
        WHERE hash = ? AND active = 1 AND invalidated_at IS NULL
        LIMIT 1
      `).get(resolved.hash) as { id: number; title: string; collection: string; path: string } | undefined;

      if (!doc) {
        return {
          content: [{ type: "text", text: `Document not found: ${docidEcho}` }],
        };
      }

      // Evidence-preserving directed edge traversal (s342 reader)
      const { edges, truncated } = store.findCausalLinks(doc.id, direction, depth);

      // EVERY result shape — including zero edges — goes through the wire cap:
      // both representations are built from ONE retained edge set and capped
      // together as the complete serialized result (CAUSAL_READER_MAX_BYTES).
      // Base fields are display-bounded so the empty response always fits, and
      // the overflow envelope backstops the ceiling unconditionally.
      const anchorTitle = doc.title.slice(0, 300);
      const anchorPath = `${doc.collection}/${doc.path}`.slice(0, 600);
      type CausalToolResult = {
        content: Array<{ type: "text"; text: string }>;
        structuredContent: {
          source?: { id: number; title: string; filepath: string };
          direction: typeof direction;
          links: CausalEdgeRecord[];
          truncated: boolean;
          overflow?: boolean;
        };
      };
      return capCausalWire<CausalToolResult>(edges, truncated, (kept: CausalEdgeRecord[], isTruncated: boolean) => {
        const lines = kept.length === 0
          ? [
              isTruncated
                ? `Causal edges exist for "${anchorTitle}" (${direction}) but none fit the response ceiling.`
                : `No causal links found for "${anchorTitle}" (${direction})`,
            ]
          : [
              `"${anchorTitle}" has ${kept.length} causal edge(s) (${direction})` +
              `${isTruncated ? ' [truncated]' : ''}:\n`,
            ];
        for (const edge of kept) {
          const pct = Math.round(edge.weight * 100);
          const arrow = edge.direction === 'causes' ? '→' : '←';
          lines.push(
            `[depth ${edge.depth}] ${arrow} ${pct}% ${edge.title} (${edge.filepath}) ` +
            `— edge ${edge.sourceDocId}→${edge.targetDocId}, ${edge.evidenceCount} witness(es)` +
            `${edge.legacy ? ' [legacy]' : ''}`,
          );
          for (const w of edge.witnesses) {
            lines.push(`    · [${w.sourceFactOrdinal}→${w.targetFactOrdinal}] ${Math.round(w.confidence * 100)}% ${w.reasoning}`);
          }
        }
        return {
          content: [{ type: "text", text: lines.join('\n') }],
          structuredContent: {
            source: {
              id: doc.id,
              title: anchorTitle,
              filepath: anchorPath,
            },
            direction,
            links: kept,
            truncated: isTruncated,
          },
        };
      }, () => ({
        content: [{ type: "text", text: "Causal response exceeds the reader byte ceiling even with zero edges — refine the request." }],
        structuredContent: { direction, links: [], truncated: true, overflow: true },
      }));
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: kg_query (SPO Knowledge Graph)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "kg_query",
    {
      title: "Knowledge Graph Query",
      description: "Query the knowledge graph for an entity's relationships. Returns structured facts with temporal validity (valid_from/valid_to). Use for 'what does X relate to?', 'what was true about X on date Y?', 'who/what is connected to X?'. Accepts an entity name (e.g. 'ClawMem') OR a canonical entity ID in the form 'vault:type:slug' (e.g. 'default:service:clawmem').",
      inputSchema: {
        entity: z.string().describe("Entity name or canonical ID ('vault:type:slug') to query"),
        as_of: z.string().optional().describe("Date filter (YYYY-MM-DD) — only facts valid at this date"),
        direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both").describe("Relationship direction"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ entity, as_of, direction, vault }) => {
      const store = getStore(vault);

      // Canonical IDs look like `vault:type:slug` — accept them directly so callers
      // that already resolved an entity can round-trip its ID without losing it to
      // a name-search fallback that would never match.
      const CANONICAL_ID_RE = /^[a-z][a-z0-9-]*:[a-z_]+:[a-z0-9_]+$/;

      const entityResults = store.searchEntities(entity, 1);
      let entityId: string;
      if (entityResults.length > 0) {
        entityId = entityResults[0]!.entity_id;
      } else if (CANONICAL_ID_RE.test(entity)) {
        entityId = entity; // caller passed a canonical ID directly
      } else {
        const stats = store.getTripleStats();
        return {
          content: [{ type: "text", text: `No entity found matching "${entity}". The KG has ${stats.totalTriples} total triples (${stats.currentFacts} current). Try a shorter/broader name, or pass a canonical ID in the form 'vault:type:slug'.` }],
        };
      }

      const triples = store.queryEntityTriples(entityId, { asOf: as_of, direction, includeProvenance: true, provenanceLimit: 5 });
      const stats = store.getTripleStats();

      if (triples.length === 0) {
        return {
          content: [{ type: "text", text: `No knowledge graph facts found for "${entity}" (resolved to ${entityId}). The KG has ${stats.totalTriples} total triples (${stats.currentFacts} current).` }],
        };
      }

      const lines = [`Knowledge graph for "${entity}" (${triples.length} fact${triples.length === 1 ? '' : 's'}):\n`];

      for (const t of triples) {
        const validity = t.current ? "current" : `ended ${t.validTo}`;
        const from = t.validFrom ? ` (since ${t.validFrom})` : "";
        const conf = Math.round(t.confidence * 100);
        // Evidence summary (v0.32.0): count of UNIQUE evidence sources plus a bounded source
        // list. Evidence with no source document renders as `unattributed`, never null/null.
        let evidence = "";
        const count = t.evidenceCount ?? 0;
        if (count > 0 && t.sources && t.sources.length > 0) {
          // Repeated paths stay repeated (same doc, different facts): the `+M more` remainder is
          // computed from the rows actually shown, so deduping the display would misreport it.
          const shown = t.sources.map(s => (s.docId != null && s.collection && s.path) ? `${s.collection}/${s.path}` : "unattributed");
          const more = count - t.sources.length;
          evidence = ` [evidence ×${count}; sources: ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}]`;
        }
        lines.push(`[${t.direction}] ${t.subject} → ${t.predicate} → ${t.object}${from} [${validity}, ${conf}%]${evidence}`);
      }

      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: {
          entity,
          direction,
          as_of: as_of ?? null,
          facts: triples,
          stats,
        },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: memory_evolution_status (A-MEM)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "memory_evolution_status",
    {
      title: "Memory Evolution Status",
      description: "Get the evolution timeline for a memory document, showing how its keywords and context have changed over time based on new evidence.",
      inputSchema: {
        docid: z.string().describe("Document ID (e.g., '#a1b2c3' — a 6-64 char hex hash prefix)"),
        limit: z.number().optional().default(10).describe("Maximum number of evolution entries to return (1-100)"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ docid, limit, vault }) => {
      const store = getStore(vault);
      // Resolve docid to document
      const resolved = store.findDocumentByDocid(docid);
      if (!resolved) {
        return {
          content: [{ type: "text", text: `Document not found: ${docid}` }],
        };
      }

      // Get the numeric docId
      const doc = store.db.prepare(`
        SELECT id, title, collection, path
        FROM documents
        WHERE hash = ? AND active = 1
        LIMIT 1
      `).get(resolved.hash) as { id: number; title: string; collection: string; path: string } | undefined;

      if (!doc) {
        return {
          content: [{ type: "text", text: `Document not found: ${docid}` }],
        };
      }

      // Get evolution timeline
      const timeline = store.getEvolutionTimeline(doc.id, limit);

      if (timeline.length === 0) {
        return {
          content: [{ type: "text", text: `No evolution history found for "${doc.title}"` }],
          structuredContent: { document: doc, timeline: [] },
        };
      }

      // Format summary
      const lines = [`Evolution timeline for "${doc.title}" (${timeline.length} version${timeline.length === 1 ? '' : 's'}):\n`];

      for (const entry of timeline) {
        lines.push(`\nVersion ${entry.version} (${entry.createdAt})`);
        lines.push(`Triggered by: ${entry.triggeredBy.title} (${entry.triggeredBy.filepath})`);

        // Keywords delta
        if (entry.previousKeywords || entry.newKeywords) {
          const prev = entry.previousKeywords?.join(', ') || 'none';
          const next = entry.newKeywords?.join(', ') || 'none';
          lines.push(`Keywords: ${prev} → ${next}`);
        }

        // Context delta
        if (entry.previousContext || entry.newContext) {
          const prevCtx = entry.previousContext || 'none';
          const newCtx = entry.newContext || 'none';
          const prevPreview = prevCtx.substring(0, 50) + (prevCtx.length > 50 ? '...' : '');
          const newPreview = newCtx.substring(0, 50) + (newCtx.length > 50 ? '...' : '');
          lines.push(`Context: ${prevPreview} → ${newPreview}`);
        }

        // Reasoning
        if (entry.reasoning) {
          lines.push(`Reasoning: ${entry.reasoning}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: {
          document: {
            id: doc.id,
            title: doc.title,
            filepath: `${doc.collection}/${doc.path}`,
          },
          timeline: timeline.map(e => ({
            version: e.version,
            triggeredBy: {
              id: e.triggeredBy.docId,
              title: e.triggeredBy.title,
              filepath: e.triggeredBy.filepath,
            },
            previousKeywords: e.previousKeywords,
            newKeywords: e.newKeywords,
            previousContext: e.previousContext,
            newContext: e.newContext,
            reasoning: e.reasoning,
            createdAt: e.createdAt,
          })),
        },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: timeline (Engram integration)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "timeline",
    {
      title: "Document Timeline",
      description: "Show the temporal neighborhood around a document — what was created/modified before and after it. Token-efficient progressive disclosure: search → timeline (context) → get (full content). Use after finding a document via search to understand what happened around it.",
      inputSchema: {
        docid: z.string().describe("Document ID (e.g., '#a1b2c3' — a 6-64 char hex hash prefix)"),
        before: z.number().optional().default(5).describe("Number of documents to show before the focus (1-20)"),
        after: z.number().optional().default(5).describe("Number of documents to show after the focus (1-20)"),
        same_collection: z.boolean().optional().default(false).describe("Constrain to same collection (like session scoping)"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ docid, before, after, same_collection, vault }) => {
      const store = getStore(vault);
      // Resolve docid to numeric ID
      const resolved = store.findDocumentByDocid(docid);
      if (!resolved) {
        return { content: [{ type: "text", text: `Document not found: ${docid}` }] };
      }

      const doc = store.db.prepare(`
        SELECT id, title, collection, path FROM documents WHERE hash = ? AND active = 1 LIMIT 1
      `).get(resolved.hash) as { id: number; title: string; collection: string; path: string } | undefined;

      if (!doc) {
        return { content: [{ type: "text", text: `Document not found: ${docid}` }] };
      }

      try {
        const result = store.timeline(doc.id, { before, after, sameCollection: same_collection });

        const lines: string[] = [];

        // Session info if available
        if (result.sessionId) {
          lines.push(`Session: ${result.sessionId}${result.sessionSummary ? ` — ${result.sessionSummary}` : ""}`);
          lines.push("");
        }

        lines.push(`Total documents in scope: ${result.totalInRange}`);
        lines.push("");

        // Before
        if (result.before.length > 0) {
          lines.push("─── BEFORE ───");
          for (const e of result.before) {
            lines.push(`  [${e.contentType}] ${e.collection}/${e.path} (${e.modifiedAt.slice(0, 16)})`);
          }
          lines.push("");
        }

        // Focus
        lines.push("─── FOCUS ───");
        lines.push(`→ [${result.focus.contentType}] ${result.focus.collection}/${result.focus.path} (${result.focus.modifiedAt.slice(0, 16)}) ← you are here`);
        lines.push("");

        // After
        if (result.after.length > 0) {
          lines.push("─── AFTER ───");
          for (const e of result.after) {
            lines.push(`  [${e.contentType}] ${e.collection}/${e.path} (${e.modifiedAt.slice(0, 16)})`);
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: result,
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Timeline error: ${err.message}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: memory_pin
  // ---------------------------------------------------------------------------

  server.registerTool(
    "memory_pin",
    {
      title: "Pin/Unpin Memory",
      description: "Pin a memory for permanent prioritization (+0.3 boost). USE PROACTIVELY when: user states a persistent constraint, makes an architecture decision, or corrects a misconception. Don't wait for curator — pin critical decisions immediately.",
      inputSchema: {
        query: z.string().describe("Search query to find the memory to pin/unpin"),
        unpin: z.boolean().optional().default(false).describe("Set true to unpin"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, unpin, vault }) => {
      const s = getStore(vault);
      const candidates = await findMemoryCandidates(s, query);
      const selection = selectLifecycleTarget(candidates, query);

      if ("notFound" in selection) {
        return { content: [{ type: "text", text: selection.notFound }], isError: true };
      }
      if ("ambiguous" in selection) {
        return { content: [{ type: "text", text: selection.ambiguous }], isError: true };
      }

      const r = selection.target;
      const parts = r.displayPath.split("/");
      const collection = parts[0]!;
      const path = parts.slice(1).join("/");
      const doc = s.findActiveDocument(collection, path);
      if (!doc) {
        return { content: [{ type: "text", text: "Document not found." }], isError: true };
      }
      s.pinDocument(collection, path, !unpin);
      s.insertUsage({
        sessionId: "mcp-pin",
        timestamp: new Date().toISOString(),
        hookName: "memory_pin",
        injectedPaths: [r.displayPath],
        estimatedTokens: 0,
        wasReferenced: 0,
      });
      const action = unpin ? "Unpinned" : "Pinned";
      return { content: [{ type: "text", text: `${action}: ${r.displayPath} (${r.title})` }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: memory_snooze
  // ---------------------------------------------------------------------------

  server.registerTool(
    "memory_snooze",
    {
      title: "Snooze Memory",
      description: "Temporarily hide a memory from context surfacing. USE PROACTIVELY when vault-context repeatedly surfaces irrelevant content — snooze it for 30 days instead of ignoring it. Reduces noise for future sessions.",
      inputSchema: {
        query: z.string().describe("Search query to find the memory to snooze"),
        until: z.string().optional().describe("ISO date to snooze until (e.g. 2026-03-01). Omit to unsnooze."),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, until, vault }) => {
      const s = getStore(vault);
      const candidates = await findMemoryCandidates(s, query);
      const selection = selectLifecycleTarget(candidates, query);

      if ("notFound" in selection) {
        return { content: [{ type: "text", text: selection.notFound }], isError: true };
      }
      if ("ambiguous" in selection) {
        return { content: [{ type: "text", text: selection.ambiguous }], isError: true };
      }

      const r = selection.target;
      const parts = r.displayPath.split("/");
      const collection = parts[0]!;
      const path = parts.slice(1).join("/");
      const doc = s.findActiveDocument(collection, path);
      if (!doc) {
        return { content: [{ type: "text", text: "Document not found." }], isError: true };
      }
      s.snoozeDocument(collection, path, until || null);
      s.insertUsage({
        sessionId: "mcp-snooze",
        timestamp: new Date().toISOString(),
        hookName: "memory_snooze",
        injectedPaths: [r.displayPath],
        estimatedTokens: 0,
        wasReferenced: 0,
      });
      const msg = until
        ? `Snoozed until ${until}: ${r.displayPath}`
        : `Unsnoozed: ${r.displayPath}`;
      return { content: [{ type: "text", text: msg }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: lifecycle_status
  // ---------------------------------------------------------------------------

  server.registerTool(
    "lifecycle_status",
    {
      title: "Lifecycle Status",
      description: "Show document lifecycle statistics: active, archived, forgotten, pinned, snoozed counts and policy summary.",
      inputSchema: {
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ vault }) => {
      const store = getStore(vault);
      const stats = store.getLifecycleStats();
      const { loadConfig } = await import("./collections.ts");
      const config = loadConfig();
      const policy = config.lifecycle;

      // Recall tracking summary
      const recallStats = store.getRecallStatsAll(1);
      const highDiversity = recallStats.filter(r => r.diversityScore >= 0.4 && r.spacingScore >= 0.5 && r.recallCount >= 3);
      const highNoise = recallStats.filter(r => r.recallCount >= 5 && r.negativeCount > r.recallCount * 0.8);

      const lines = [
        `Active: ${stats.active}`,
        `Archived (auto): ${stats.archived}`,
        `Forgotten (manual): ${stats.forgotten}`,
        `Pinned: ${stats.pinned}`,
        `Snoozed: ${stats.snoozed}`,
        `Never accessed: ${stats.neverAccessed}`,
        `Oldest access: ${stats.oldestAccess?.slice(0, 10) || "n/a"}`,
        "",
        `Recall tracking: ${recallStats.length} docs tracked`,
        `  Pin candidates (high diversity+spacing): ${highDiversity.length}`,
        `  Snooze candidates (surfaced often, rarely referenced): ${highNoise.length}`,
        "",
        `Policy: ${policy ? `archive after ${policy.archive_after_days}d, purge after ${policy.purge_after_days ?? "never"}, dry_run=${policy.dry_run}` : "none configured"}`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: lifecycle_sweep
  // ---------------------------------------------------------------------------

  server.registerTool(
    "lifecycle_sweep",
    {
      title: "Lifecycle Sweep",
      description: "Run lifecycle policies: archive stale documents. Archives only — never deletes; archival is reversible via lifecycle_restore. Defaults to dry_run (preview only).",
      inputSchema: {
        dry_run: z.boolean().optional().default(true).describe("Preview what would be archived without acting"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ dry_run, vault }) => {
      const store = getStore(vault);
      const { loadConfig } = await import("./collections.ts");
      const config = loadConfig();
      const policy = config.lifecycle;
      if (!policy) {
        return { content: [{ type: "text", text: "No lifecycle policy configured in config.yaml" }] };
      }

      const candidates = store.getArchiveCandidates(policy);

      if (dry_run) {
        const lines = candidates.map(c =>
          `- ${c.collection}/${c.path} (${c.content_type}, modified ${c.modified_at.slice(0, 10)}, accessed ${c.last_accessed_at?.slice(0, 10) || "never"})`
        );

        // Recall-based recommendations
        const recallStats = store.getRecallStatsAll(3);
        const pinCandidates = recallStats.filter(r => r.diversityScore >= 0.4 && r.spacingScore >= 0.5 && r.recallCount >= 3);
        const snoozeCandidates = recallStats.filter(r => r.recallCount >= 5 && r.negativeCount > r.recallCount * 0.8);

        const recallLines: string[] = [];
        if (pinCandidates.length > 0) {
          recallLines.push("", "Pin candidates (high diversity, multi-day spread, recall≥3):");
          for (const r of pinCandidates.slice(0, 5)) {
            const label = r.collection && r.path ? `${r.collection}/${r.path}` : `doc#${r.docId}`;
            recallLines.push(`  - ${label} (recalls=${r.recallCount}, queries=${r.uniqueQueries}, days=${r.recallDays}, diversity=${r.diversityScore.toFixed(2)}, spacing=${r.spacingScore.toFixed(2)})`);
          }
        }
        if (snoozeCandidates.length > 0) {
          recallLines.push("", "Snooze candidates (surfaced often, rarely referenced):");
          for (const r of snoozeCandidates.slice(0, 5)) {
            const label = r.collection && r.path ? `${r.collection}/${r.path}` : `doc#${r.docId}`;
            recallLines.push(`  - ${label} (recalls=${r.recallCount}, referenced=${r.recallCount - r.negativeCount}, noise_ratio=${(r.negativeCount / r.recallCount * 100).toFixed(0)}%)`);
          }
        }

        return { content: [{ type: "text", text: `Would archive ${candidates.length} document(s) (reversible via lifecycle_restore; nothing is deleted):\n${lines.join("\n") || "(none)"}${recallLines.join("\n")}` }] };
      }

      // Archival only. ClawMem no longer physically deletes document rows from any code
      // path — see the retention note in src/store.ts. Archival is reversible via
      // lifecycle_restore, so this tool has no unrecoverable effect.
      const archived = store.archiveDocuments(candidates.map(c => c.id));

      const purgeNote = policy.purge_after_days
        ? `\n\nNote: purge_after_days=${policy.purge_after_days} is set but INERT — ClawMem no ` +
          `longer deletes rows. Archived documents remain restorable via lifecycle_restore.`
        : "";

      return { content: [{ type: "text", text: `Lifecycle sweep: archived ${archived} document(s). Nothing was deleted.${purgeNote}` }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: lifecycle_restore
  // ---------------------------------------------------------------------------

  server.registerTool(
    "lifecycle_restore",
    {
      title: "Restore Archived Documents",
      description: "Restore documents that were auto-archived by lifecycle policies. Does NOT restore manually forgotten documents.",
      inputSchema: {
        query: z.string().optional().describe("Search archived docs by keyword to find what to restore"),
        collection: z.string().optional().describe("Restore all archived docs from a specific collection"),
        all: z.boolean().optional().default(false).describe("Restore ALL archived documents"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, collection, all, vault }) => {
      const store = getStore(vault);
      if (query) {
        const results = store.searchArchived(query, 20);

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No archived documents match that query." }] };
        }

        const restored = store.restoreArchivedDocuments({ ids: results.map(r => r.id) });
        const lines = results.map(r => `- [${r.score.toFixed(3)}] ${r.collection}/${r.path} (archived ${r.archived_at?.slice(0, 10)})`);
        return { content: [{ type: "text", text: `Restored ${restored}:\n${lines.join("\n")}` }] };
      }

      if (collection) {
        const restored = store.restoreArchivedDocuments({ collection });
        return { content: [{ type: "text", text: `Restored ${restored} documents from collection "${collection}"` }] };
      }

      if (all) {
        const restored = store.restoreArchivedDocuments({});
        return { content: [{ type: "text", text: `Restored ${restored} archived documents` }] };
      }

      return { content: [{ type: "text", text: "Specify query, collection, or all=true" }], isError: true };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: list_vaults
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_vaults",
    {
      title: "List Configured Vaults",
      description: "Show all configured vault names and their SQLite paths. Returns empty if running in single-vault mode (default).",
      inputSchema: {},
    },
    async () => {
      const vaults = listVaults();
      if (vaults.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No named vaults configured (single-vault mode). Add vaults via config.yaml or CLAWMEM_VAULTS env var.",
          }],
        };
      }

      const config = loadVaultConfig();
      const lines = vaults.map(name => `  ${name}: ${config.vaults[name]}`);
      return {
        content: [{ type: "text", text: `Configured vaults (${vaults.length}):\n${lines.join('\n')}` }],
        structuredContent: { vaults: config.vaults },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: vault_sync
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vault_sync",
    {
      title: "Sync Content to Vault",
      description: "Index markdown documents from a directory into a named vault. Use to populate a vault with content from a specific path.",
      inputSchema: {
        vault: z.string().describe("Target vault name (must be configured in config.yaml or CLAWMEM_VAULTS)"),
        content_root: z.string().describe("Directory path to index markdown files from"),
        pattern: z.string().optional().default("**/*.md").describe("Glob pattern (default: **/*.md)"),
        collection_name: z.string().optional().describe("Collection name in the vault. Defaults to vault name."),
      },
    },
    async ({ vault, content_root, pattern, collection_name }) => {
      const s = getStore(vault);
      const root = content_root.replace(/^~/, process.env.HOME || "/tmp");
      const collName = collection_name || vault;

      // Validate content_root — reject sensitive paths
      const { resolve: resolvePath } = await import("path");
      const resolvedRoot = resolvePath(root);
      const DENIED_PREFIXES = ["/etc/", "/root/", "/var/", "/proc/", "/sys/", "/dev/"];
      const DENIED_PATTERNS = [".ssh", ".gnupg", ".env", "credentials", "secrets", ".aws", ".kube"];
      if (DENIED_PREFIXES.some(p => resolvedRoot.startsWith(p)) ||
          DENIED_PATTERNS.some(p => resolvedRoot.includes(p))) {
        return {
          content: [{ type: "text", text: `Vault sync denied: "${resolvedRoot}" is in a restricted path` }],
          isError: true,
        };
      }

      try {
        const stats = await indexCollection(s, collName, root, pattern || "**/*.md");
        // Issue #24 (codex turn-2 finding 3): the user-facing summary must not
        // read as unqualified success when every note write produced nothing.
        const noteLine = stats.enrichAttempted === 0
          ? ""
          : stats.enrichStored === stats.enrichAttempted
            ? `\n  Notes: ${stats.enrichStored}/${stats.enrichAttempted} stored`
            : `\n  Notes: ${stats.enrichStored}/${stats.enrichAttempted} stored (${stats.enrichAttempted - stats.enrichStored} produced nothing — LLM endpoint problem? run 'clawmem doctor')`;
        return {
          content: [{
            type: "text",
            text: `Synced to vault "${vault}":\n  Collection: ${collName}\n  Root: ${root}\n  Added: ${stats.added}\n  Updated: ${stats.updated}\n  Deleted: ${stats.removed}${noteLine}`,
          }],
          structuredContent: { vault, collection: collName, ...stats },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Vault sync failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: diary_write
  // ---------------------------------------------------------------------------

  server.registerTool(
    "diary_write",
    {
      title: "Write Diary Entry",
      description: "Write to the agent's diary. Use for recording important events, decisions, or observations in environments without hook support. Entries are stored as memories and are searchable.",
      inputSchema: {
        entry: z.string().describe("Diary entry text"),
        topic: z.string().optional().default("general").describe("Topic tag (e.g., 'technical', 'user_facts', 'session')"),
        agent: z.string().optional().default("agent").describe("Agent name writing the entry"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ entry, topic, agent, vault }) => {
      const store = getStore(vault);
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
      const ms = String(now.getMilliseconds()).padStart(3, "0");
      const diaryPath = `diary/${dateStr}-${timeStr}${ms}-${topic}.md`;
      const body = `---\ntitle: "${entry.slice(0, 80).replace(/"/g, '\\"')}"\ncontent_type: note\ntags: [diary, ${topic}]\ndomain: "${agent}"\n---\n\n${entry}`;

      const result = store.saveMemory({
        collection: "_clawmem",
        path: diaryPath,
        title: entry.slice(0, 80),
        body,
        contentType: "note",
        confidence: 0.7,
        semanticPayload: `${diaryPath}::${entry}`,
      });

      return {
        content: [{ type: "text", text: `Diary entry saved (${result.action}, doc #${result.docId})` }],
        structuredContent: { action: result.action, docId: result.docId, path: diaryPath },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: diary_read
  // ---------------------------------------------------------------------------

  server.registerTool(
    "diary_read",
    {
      title: "Read Diary Entries",
      description: "Read recent diary entries. Use to review past observations and events recorded by the agent.",
      inputSchema: {
        last_n: z.number().optional().default(10).describe("Number of recent entries to return"),
        agent: z.string().optional().describe("Filter by agent name"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ last_n, agent, vault }) => {
      const store = getStore(vault);
      const params: any[] = [];
      let agentFilter = "";
      if (agent) {
        agentFilter = "AND d.domain = ?";
        params.push(agent);
      }
      params.push(last_n);

      const rows = store.db.prepare(`
        SELECT d.id, d.path, d.title, d.modified_at as modifiedAt, d.domain
        FROM documents d
        WHERE d.active = 1 AND d.collection = '_clawmem' AND d.path LIKE 'diary/%'
        ${agentFilter}
        ORDER BY d.modified_at DESC
        LIMIT ?
      `).all(...params) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No diary entries found." }] };
      }

      const lines = [`Diary (${rows.length} entries):\n`];
      for (const row of rows) {
        const agentLabel = row.domain ? ` [${row.domain}]` : "";
        lines.push(`${row.modifiedAt.slice(0, 16)}${agentLabel} ${row.title}`);
      }

      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: { entries: rows },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Cross-Agent Memory tools (cross-agent memory PR)
  // ---------------------------------------------------------------------------
  //
  // These three tools turn ClawMem from a passive archive into an active shared
  // memory: an agent that learns something writes a signed, witnessed fact into
  // the knowledge graph and every other agent can see it with full attribution.
  // Facts store WHO wrote them (agentId), from WHICH session (sessionId), WHEN
  // (timestamp), HOW (source), HOW confident (0..1), and for HOW LONG
  // (valid_from / valid_to -> natural decay / obsolescence).

  /** Resolve-or-create a canonical entity id from a `name[:type]` spec. */
  function resolveFactEntity(name: string, expectedType: string | undefined, vault: string): string {
    // Already a canonical id (vault:type:slug)? Use as-is.
    if (/^[a-z][a-z0-9-]*:[a-z_]+:[a-z0-9_]+$/.test(name)) return name;
    // Try resolving against existing entities by name first (keeps typing stable).
    const existing = store.db
      .prepare(`SELECT entity_id FROM entity_nodes WHERE name = ? AND vault = ? LIMIT 1`)
      .get(name, vault ?? "default") as { entity_id: string } | undefined;
    if (existing) return existing.entity_id;
    return ensureEntityCanonical(store.db, name, expectedType ?? "concept", vault ?? "default");
  }

  // -------------------------------------------------------------------------
  // Tool: fact_write
  // -------------------------------------------------------------------------
  server.registerTool(
    "fact_write",
    {
      title: "Write Cross-Agent Fact",
      description:
        "Actively write a learned fact into the cross-agent knowledge graph. The fact is signed with your agentId, sessionId, timestamp, source, and a confidence score; every other agent sharing the vault can read it via fact_query_cross_agent or kg_query (and, if enabled, receive it through the context-injection layer). Unlike document indexing this records a first-class witnessed fact. Use when you discover or confirm something other agents should know without rediscovering it (server status, decisions, project-to-infrastructure bindings).",
      inputSchema: {
        subject: z.string().describe("Subject entity: a name (e.g. 'server:ema5-db') or canonical entity id ('default:service:ema5-db')."),
        predicate: z.string().describe("Predicate / relation (e.g. 'status', 'uses_infrastructure'). Lowercased; spaces become underscores."),
        object: z.string().describe("Object entity or literal value (e.g. 'down', or a canonical id)."),
        subject_type: z.string().optional().describe("Entity type for the subject if it does not yet exist (e.g. 'server', 'project'). Defaults to 'concept'."),
        object_type: z.string().optional().describe("Entity type for the object if it does not yet exist. Defaults to 'concept'."),
        witness: z.object({
          agentId: z.string().describe("Your agent identifier (e.g. 'max', 'scout', 'lex')."),
          sessionId: z.string().optional().describe("The session you learned this in (e.g. 'abc-123')."),
          timestamp: z.string().optional().describe("ISO 8601 timestamp of the observation. Defaults to now."),
          source: z.string().optional().describe("How the fact was observed (e.g. 'direct_observation', 'verification', 'document')."),
        }).describe("Attribution for this fact: who wrote it, from which session, when, and how."),
        confidence: z.number().min(0).max(1).optional().default(0.9).describe("Confidence 0..1 for the fact. Default 0.9."),
        valid_from: z.string().optional().describe("ISO date/timestamp the fact becomes valid. Defaults to now."),
        valid_to: z.string().optional().describe("ISO date/timestamp when the fact expires (null = never expires). Enables decay / obsolescence."),
        tags: z.array(z.string()).optional().describe("Free-form labels, e.g. ['infra', 'ema5']."),
        vault: z.string().optional().describe("Named vault (omit for default vault)."),
      },
    },
    async ({ subject, predicate, object, subject_type, object_type, witness, confidence, valid_from, valid_to, tags, vault }) => {
      const store = getStore(vault);
      const subjId = resolveFactEntity(subject, subject_type, vault ?? "default");
      const objId = resolveFactEntity(object, object_type, vault ?? "default");
      const pred = predicate.toLowerCase().replace(/\s+/g, "_");
      const now = new Date().toISOString();
      const w: FactWitness = {
        agentId: witness.agentId,
        sessionId: witness.sessionId,
        timestamp: witness.timestamp ?? now,
        source: witness.source,
      };
      // Cross-agent write: append=true so a DIFFERENT agent's higher-confidence fact on the
      // same subject+predicate is never clobbered (divergence/evolution is kept as versions).
      const tripleId = store.addTriple(subjId, pred, objId, null, {
        validFrom: valid_from ?? now,
        validTo: valid_to,
        confidence: confidence ?? 0.9,
        witness: w,
        tags,
        append: true,
      });
      const summary = `Fact written (#${tripleId}): ${subject} → ${pred} → ${object} (conf ${(confidence ?? 0.9).toFixed(2)}, by ${w.agentId}${w.sessionId ? " @ " + w.sessionId : ""}, ${w.timestamp})${valid_to ? `, valid_to ${valid_to}` : ""}`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: {
          id: tripleId,
          subject,
          subjectEntityId: subjId,
          predicate: pred,
          object,
          objectEntityId: objId,
          confidence: confidence ?? 0.9,
          witness: w,
          validFrom: valid_from ?? now,
          validTo: valid_to ?? null,
          tags: tags ?? [],
        },
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: fact_link
  // -------------------------------------------------------------------------
  server.registerTool(
    "fact_link",
    {
      title: "Link Two Entities",
      description:
        "Create a semantic relation between two entities in the cross-agent graph, e.g. 'this project uses that server' or 'this skill belongs to that agent'. Backed by the same signed-witness fact machinery as fact_write, but expressed as a directed relation from entity A to entity B. Use for cross-domain reference (projects→servers, people→projects, skills→agents).",
      inputSchema: {
        from: z.string().describe("Source entity (name or canonical id), e.g. 'project:ema5'."),
        relation: z.string().describe("Directed relation name, e.g. 'uses_infrastructure'. Lowercased; spaces become underscores."),
        to: z.string().describe("Target entity (name or canonical id), e.g. 'server:ema5-plc-db'."),
        from_type: z.string().optional().describe("Entity type for `from` if new. Defaults to 'concept'."),
        to_type: z.string().optional().describe("Entity type for `to` if new. Defaults to 'concept'."),
        witness: z.object({
          agentId: z.string().describe("Agent creating the link."),
          sessionId: z.string().optional(),
          timestamp: z.string().optional(),
          source: z.string().optional().describe("Observation method."),
        }).describe("Attribution for the link."),
        confidence: z.number().min(0).max(1).optional().default(0.9).describe("Confidence 0..1. Default 0.9."),
        valid_to: z.string().optional().describe("Optional expiry (ISO)."),
        tags: z.array(z.string()).optional().describe("Free-form labels."),
        vault: z.string().optional().describe("Named vault (omit for default vault)."),
      },
    },
    async ({ from, relation, to, from_type, to_type, witness, confidence, valid_to, tags, vault }) => {
      const store = getStore(vault);
      const fromId = resolveFactEntity(from, from_type, vault ?? "default");
      const toId = resolveFactEntity(to, to_type, vault ?? "default");
      const rel = relation.toLowerCase().replace(/\s+/g, "_");
      const now = new Date().toISOString();
      const w: FactWitness = {
        agentId: witness.agentId,
        sessionId: witness.sessionId,
        timestamp: witness.timestamp ?? now,
        source: witness.source,
      };
      const tripleId = store.addTriple(fromId, rel, toId, null, {
        validFrom: now,
        validTo: valid_to,
        confidence: confidence ?? 0.9,
        witness: w,
        tags,
        append: true,
      });
      return {
        content: [{ type: "text", text: `Link created (#${tripleId}): ${from} --${rel}--> ${to} (by ${w.agentId}, conf ${(confidence ?? 0.9).toFixed(2)})` }],
        structuredContent: { id: tripleId, from, fromEntityId: fromId, relation: rel, to, toEntityId: toId, confidence: confidence ?? 0.9, witness: w, validTo: valid_to ?? null, tags: tags ?? [] },
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: fact_query_cross_agent
  // -------------------------------------------------------------------------
  server.registerTool(
    "fact_query_cross_agent",
    {
      title: "Query Cross-Agent Facts",
      description:
        "Query witnessed facts across agents. Filter by subject/predicate/object (each accepts '*' wildcard), minimum confidence, writer agent(s), session(s), and write time ('since'). Optionally resolve conflicts by collapsing divergent witnesses to the most recent fact per subject/predicate/object above the confidence floor. Use this to learn what OTHER agents know about an entity instead of rediscovering it.",
      inputSchema: {
        subject: z.string().optional().describe("Subject entity (name or canonical id). '*' or omit = any."),
        predicate: z.string().optional().describe("Predicate / relation. '*' or omit = any."),
        object: z.string().optional().describe("Object entity or literal. '*' or omit = any."),
        since: z.string().optional().describe("ISO timestamp — only facts written on/after this time."),
        min_confidence: z.number().min(0).max(1).optional().default(0.7).describe("Lower bound (inclusive) on confidence. Default 0.7."),
        written_by: z.array(z.string()).optional().describe("Restrict to facts written by these agents (e.g. ['max', 'scout'])."),
        session_ids: z.array(z.string()).optional().describe("Restrict to facts written from these sessions."),
        resolve_conflicts: z.boolean().optional().default(false).describe("If true, merge facts that differ only by witness to the most recent with confidence >= threshold."),
        limit: z.number().min(1).max(200).optional().default(50).describe("Max facts returned. Default 50."),
        vault: z.string().optional().describe("Named vault (omit for default vault)."),
      },
    },
    async ({ subject, predicate, object, since, min_confidence, written_by, session_ids, resolve_conflicts, limit, vault }) => {
      const store = getStore(vault);
      const facts: CrossAgentFact[] = store.queryCrossAgentFacts({
        subject: subject ?? "*",
        predicate: predicate ?? "*",
        object: object ?? "*",
        since,
        minConfidence: min_confidence ?? 0.7,
        writtenBy: written_by,
        sessionIds: session_ids,
        resolveConflicts: resolve_conflicts ?? false,
        limit,
        vault: vault ?? "default",
      });
      if (facts.length === 0) {
        return {
          content: [{ type: "text", text: `No cross-agent facts matched the given filters.` }],
          structuredContent: { count: 0, facts: [] },
        };
      }
      const lines = [`Cross-agent facts (${facts.length}):\n`];
      for (const f of facts) {
        const validity = f.validTo ? `valid_to ${f.validTo}` : f.current ? "current" : "ended";
        const author = f.agentId ? `written_by ${f.agentId}${f.sessionId ? " @ " + f.sessionId : ""} at ${f.writtenAt ?? "?"}` : "unattributed";
        const conf = Math.round(f.confidence * 100);
        lines.push(`[${conf}%] ${f.subject} → ${f.predicate} → ${f.object} — ${author} (${validity})`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { count: facts.length, facts },
      };
    }
  );

  return { server, store, closeAllStores };
}

export async function startMcpServer(): Promise<void> {
  const { server, store, closeAllStores } = buildMcpServer();

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ---------------------------------------------------------------------------
  // Shutdown wiring + Workers
  // ---------------------------------------------------------------------------

  // v0.8.2 Codex Turn 2 fix: register signal handlers BEFORE any worker
  // startup, mirroring the same null-handle capture pattern that cmdWatch
  // uses. The handler is the only thing that suppresses Node's default
  // signal action (terminate), so a SIGTERM arriving in the brief window
  // between worker startup and `process.on(...)` registration would
  // exit-143 the process and skip the async drain entirely, leaking any
  // lease the worker had just acquired. Capturing `stopHeavyLane` as a
  // mutable closure variable lets the registration happen before the
  // worker is actually created — the handler reads whatever value is
  // bound at the moment a signal arrives.
  let stopHeavyLane: (() => Promise<void>) | null = null;

  // Signal handlers for graceful shutdown. async stop sequence: both
  // worker stops await any in-flight tick before resolving so the store
  // is not closed underneath a mid-tick worker. Bounded waits inside the
  // stop functions guarantee the handler cannot wedge indefinitely.
  const shutdownMcp = async (signal: string) => {
    console.error(`\n[mcp] Received ${signal}, shutting down...`);
    if (stopHeavyLane) {
      await stopHeavyLane();
      stopHeavyLane = null;
    }
    await stopConsolidationWorker();
    closeAllStores();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdownMcp("SIGINT"); });
  process.on("SIGTERM", () => { void shutdownMcp("SIGTERM"); });

  // Start consolidation worker if enabled
  if (Bun.env.CLAWMEM_ENABLE_CONSOLIDATION === "true") {
    const llm = getDefaultLlamaCpp();
    const intervalMs = parseInt(Bun.env.CLAWMEM_CONSOLIDATION_INTERVAL || "300000", 10);
    startConsolidationWorker(store, llm, intervalMs);
  }

  // v0.8.0 Ext 5: Start heavy-maintenance worker if enabled. Runs on a
  // longer interval than the light lane, only inside a configurable quiet
  // window, and gated by context_usage query-rate so interactive sessions
  // are never starved. Off by default.
  //
  // v0.8.2: warn when this lane is enabled on a stdio MCP host. Per-session
  // MCPs spawned by Claude Code die with the session, which means the
  // configured quiet window may never see a live worker if no Claude Code
  // session is open at that time. The watcher service (`clawmem watch`) is
  // the canonical long-lived host for the heavy lane as of v0.8.2 — see
  // docs/concepts/architecture.md and docs/guides/upgrading.md for the
  // dual-host rationale.
  if (Bun.env.CLAWMEM_HEAVY_LANE === "true") {
    console.error(
      "[mcp] WARNING: CLAWMEM_HEAVY_LANE=true on a stdio MCP host. " +
        "Per-session MCPs are short-lived; the configured quiet window may " +
        "never see a live worker. As of v0.8.2 the canonical heavy-lane host " +
        "is `clawmem watch` (e.g. systemd user unit clawmem-watcher.service). " +
        "Set the same env var on the watcher service for reliable operation.",
    );
    const llm = getDefaultLlamaCpp();
    stopHeavyLane = startHeavyMaintenanceWorker(store, llm, parseHeavyLaneConfigFromEnv());
  }
}

if (import.meta.main) {
  startMcpServer().catch(console.error);
}
