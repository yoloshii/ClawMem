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
  type Store,
  type SearchResult,
  type CausalLink,
  type EvolutionEntry,
} from "./store.ts";
import {
  applyCompositeScoring,
  hasRecencyIntent,
  type EnrichedResult,
  type CoActivationFn,
} from "./memory.ts";
import { enrichResults, reciprocalRankFusion, toRanked, type RankedResult } from "./search-utils.ts";
import { applyMMRDiversity } from "./mmr.ts";
import { indexCollection, type IndexStats } from "./indexer.ts";
import { listCollections } from "./collections.ts";
import { classifyIntent, decomposeQuery, extractTemporalConstraint, type IntentType } from "./intent.ts";
import { adaptiveTraversal, mergeTraversalResults, mpfpTraversal } from "./graph-traversal.ts";
import { getDefaultLlamaCpp } from "./llm.ts";
import { startConsolidationWorker, stopConsolidationWorker } from "./consolidation.ts";
import { listVaults, loadVaultConfig } from "./config.ts";
import { getEntityGraphNeighbors, searchEntities } from "./entity.ts";

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
function classifyRetrievalMode(query: string): "keyword" | "semantic" | "causal" | "timeline" | "discovery" | "complex" | "hybrid" {
  const q = query.toLowerCase();

  // Timeline (highest precision signals — check first)
  if (/\b(last session|yesterday|prior session|previous session|last time we|handoff|what happened last|what did we do|cross.session|earlier today|this morning|what we discussed|when we last)\b/i.test(q)) return "timeline";

  // Causal
  if (/\b(why did|why was|why were|what caused|what led to|reason for|decided to|decision about|trade.?off|instead of|chose to|because we)\b/i.test(q)) return "causal";
  if (/^why\b/i.test(q)) return "causal";

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

export async function startMcpServer(): Promise<void> {
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
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, mode, limit, compact, vault }) => {
      const store = getStore(vault);
      const effectiveMode = mode === "auto" ? classifyRetrievalMode(query) : mode;
      const lim = limit || 10;

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

      // --- Causal mode → intent classification + graph traversal ---
      if (effectiveMode === "causal") {
        const llm = getDefaultLlamaCpp();
        const intent = await classifyIntent(query, llm, store.db);
        const bm25Results = store.searchFTS(query, 30);
        let vecResults: SearchResult[] = [];
        try { vecResults = await store.searchVec(query, DEFAULT_EMBED_MODEL, 30); } catch { /* no vectors */ }
        const rrfWeights = intent.intent === 'WHY' ? [1.0, 1.5] : intent.intent === 'WHEN' ? [1.5, 1.0] : [1.0, 1.0];
        const fusedRanked = reciprocalRankFusion([bm25Results.map(toRanked), vecResults.map(toRanked)], rrfWeights);
        const allSearch = [...bm25Results, ...vecResults];
        let fused: SearchResult[] = fusedRanked.map(fr => {
          const orig = allSearch.find(r => r.filepath === fr.file);
          return orig ? { ...orig, score: fr.score } : null;
        }).filter((r): r is SearchResult => r !== null);

        if (intent.intent === 'WHY' || intent.intent === 'ENTITY') {
          try {
            const anchorEmb = await llm.embed(query);
            if (anchorEmb) {
              const traversed = adaptiveTraversal(store.db, fused.slice(0, 10).map(r => ({ hash: r.hash, score: r.score })), {
                maxDepth: 2, beamWidth: 5, budget: 30,
                intent: intent.intent, queryEmbedding: anchorEmb.embedding,
              });
              const merged = mergeTraversalResults(store.db, fused.map(r => ({ hash: r.hash, score: r.score })), traversed);
              // Hydrate merged results back to SearchResult format
              const fusedMap = new Map(fused.map(r => [r.hash, r]));
              fused = merged.map(m => {
                const orig = fusedMap.get(m.hash);
                if (orig) return { ...orig, score: m.score };
                // Graph-discovered node — hydrate from DB
                const doc = store.db.prepare(`
                  SELECT d.collection, d.path, d.title, d.hash, c.doc as body, d.modified_at
                  FROM documents d
                  LEFT JOIN content c ON c.hash = d.hash
                  WHERE d.hash = ? AND d.active = 1 AND d.invalidated_at IS NULL LIMIT 1
                `).get(m.hash) as { collection: string; path: string; title: string; hash: string; body: string | null; modified_at: string } | undefined;
                if (!doc) return null;
                return {
                  filepath: `clawmem://${doc.collection}/${doc.path}`,
                  displayPath: `${doc.collection}/${doc.path}`,
                  title: doc.title || doc.path.split("/").pop() || "",
                  context: null,
                  hash: doc.hash,
                  docid: doc.hash.slice(0, 6),
                  collectionName: doc.collection,
                  modifiedAt: doc.modified_at || "",
                  bodyLength: doc.body?.length || 0,
                  body: doc.body || "",
                  score: m.score,
                  source: "vec" as const,
                } satisfies SearchResult;
              }).filter((r): r is SearchResult => r !== null);
            }
          } catch { /* graph traversal failed — continue with base results */ }
        }

        const enriched = enrichResults(store, fused, query);
        const scored = applyCompositeScoring(enriched, query).slice(0, lim);
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round(r.compositeScore * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType,
        }));
        return {
          content: [{ type: "text", text: `[routed: causal, intent: ${intent.intent}] ${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}` }],
          structuredContent: { mode: effectiveMode, intent, results: items },
        };
      }

      // --- Complex mode → query decomposition ---
      if (effectiveMode === "complex") {
        const llm = getDefaultLlamaCpp();
        const clauses = await decomposeQuery(query, llm, store.db);
        const allResults: SearchResult[] = [];
        for (const clause of clauses.sort((a, b) => a.priority - b.priority)) {
          let results: SearchResult[] = [];
          if (clause.type === 'bm25') results = store.searchFTS(clause.query, 20, undefined, clause.collections);
          else if (clause.type === 'vector') { try { results = await store.searchVec(clause.query, DEFAULT_EMBED_MODEL, 20, undefined, clause.collections); } catch { /* */ } }
          else if (clause.type === 'graph') { results = store.searchFTS(clause.query, 15, undefined, clause.collections); }
          allResults.push(...results);
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
        return {
          content: [{ type: "text", text: `[routed: complex, ${clauses.length} clauses] ${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}` }],
          structuredContent: { mode: effectiveMode, clauses: clauses.length, results: items },
        };
      }

      // --- Keyword / Semantic / Discovery / Hybrid modes ---
      let results: SearchResult[] = [];
      if (effectiveMode === "keyword") {
        results = store.searchFTS(query, lim);
      } else if (effectiveMode === "semantic" || effectiveMode === "discovery") {
        try { results = await store.searchVec(query, DEFAULT_EMBED_MODEL, lim); } catch { results = store.searchFTS(query, lim); }
      } else {
        // Hybrid: BM25 + vector + RRF
        const bm25 = store.searchFTS(query, 30);
        let vec: SearchResult[] = [];
        try { vec = await store.searchVec(query, DEFAULT_EMBED_MODEL, 30); } catch { /* */ }
        if (vec.length > 0) {
          const fusedRanked = reciprocalRankFusion([bm25.map(toRanked), vec.map(toRanked)], [1.0, 1.0]);
          const allSearch = [...bm25, ...vec];
          results = fusedRanked.map(fr => {
            const orig = allSearch.find(r => r.filepath === fr.file);
            return orig ? { ...orig, score: fr.score } : null;
          }).filter((r): r is SearchResult => r !== null);
        } else {
          results = bm25;
        }
      }

      const enriched = enrichResults(store, results, query);
      const scored = applyCompositeScoring(enriched, query).slice(0, lim);
      if (compact) {
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round(r.compositeScore * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType,
        }));
        return {
          content: [{ type: "text", text: `[routed: ${effectiveMode}] ${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}` }],
          structuredContent: { mode: effectiveMode, results: items },
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
        content: [{ type: "text", text: `[routed: ${effectiveMode}] ${formatSearchSummary(items, query)}` }],
        structuredContent: { mode: effectiveMode, results: items },
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
  // Tool: search (BM25 + composite)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "search",
    {
      title: "Search (BM25 + Memory)",
      description: "Keyword (BM25) search for exact term lookup. Use for config names, error codes, specific filenames. DO NOT use for 'why' questions (use intent_search) or cross-session queries (use session_log). Prefer memory_retrieve for auto-routing.",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z.number().optional().default(10),
        minScore: z.number().optional().default(0),
        collection: z.string().optional().describe("Filter to collection (single name or comma-separated)"),
        compact: z.boolean().optional().default(false).describe("Return compact results (id, path, title, score, snippet) instead of full content"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, minScore, collection, compact, vault }) => {
      const store = getStore(vault);
      const collections = collection
        ? collection.split(",").map(c => c.trim()).filter(Boolean)
        : undefined;
      const results = store.searchFTS(query, limit || 10, undefined, collections);

      const coFn = (path: string) => store.getCoActivated(path);
      const enriched = enrichResults(store, results, query);
      const scored = applyCompositeScoring(enriched, query, coFn)
        .filter(r => r.compositeScore >= (minScore || 0));

      if (compact) {
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
          fragment: r.fragmentType ? { type: r.fragmentType, label: r.fragmentLabel } : undefined,
        }));
        return { content: [{ type: "text", text: formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query) }], structuredContent: { results: items } };
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
        structuredContent: { results: filtered },
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
        minScore: z.number().optional().default(0.3),
        collection: z.string().optional().describe("Filter to collection (single name or comma-separated)"),
        compact: z.boolean().optional().default(false).describe("Return compact results (id, path, title, score, snippet) instead of full content"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, minScore, collection, compact, vault }) => {
      const store = getStore(vault);
      const tableExists = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
      if (!tableExists) {
        return { content: [{ type: "text", text: "Vector index not found. Run 'clawmem embed' first." }], isError: true };
      }

      const collections = collection
        ? collection.split(",").map(c => c.trim()).filter(Boolean)
        : undefined;
      const results = await store.searchVec(query, DEFAULT_EMBED_MODEL, limit || 10, undefined, collections);

      const coFn = (path: string) => store.getCoActivated(path);
      const enriched = enrichResults(store, results, query);
      const scored = applyCompositeScoring(enriched, query, coFn)
        .filter(r => r.compositeScore >= (minScore || 0.3));

      if (compact) {
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
          fragment: r.fragmentType ? { type: r.fragmentType, label: r.fragmentLabel } : undefined,
        }));
        return { content: [{ type: "text", text: formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query) }], structuredContent: { results: items } };
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
        content: [{ type: "text", text: formatSearchSummary(items, query) }],
        structuredContent: { results: items },
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
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, minScore, collection, compact, diverse, intent, candidateLimit, vault }) => {
      const store = getStore(vault);
      const candLimit = candidateLimit || 30;
      const rankedLists: RankedResult[][] = [];
      const docidMap = new Map<string, string>();
      const hasVectors = !!store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();

      // Step 0: Temporal constraint extraction (pure regex, ~0ms)
      const dateRange = extractTemporalConstraint(query) || undefined;

      // Step 1: BM25 probe — skip expensive LLM expansion if strong signal
      const collections = collection
        ? collection.split(",").map(c => c.trim()).filter(Boolean)
        : undefined;
      const initialFts = store.searchFTS(query, 20, undefined, collections, dateRange);
      const topScore = initialFts.length > 0 ? Math.abs(initialFts[0]!.score) : 0;
      const secondScore = initialFts.length > 1 ? Math.abs(initialFts[1]!.score) : 0;
      // When intent is provided, disable strong-signal bypass — the obvious BM25
      // match may not be what the caller wants (e.g. "performance" with intent "web page load times")
      const hasStrongSignal = !intent && initialFts.length > 0
        && topScore >= 0.85 && (topScore - secondScore) >= 0.15;

      // Step 2: Query expansion (skipped if strong signal)
      const queries = hasStrongSignal
        ? [query]
        : await store.expandQuery(query, DEFAULT_QUERY_MODEL, intent);

      for (const q of queries) {
        const ftsResults = q === query ? initialFts : store.searchFTS(q, 20, undefined, collections, dateRange);
        if (ftsResults.length > 0) {
          for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
          rankedLists.push(ftsResults.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
        }
        if (hasVectors) {
          const vecResults = await store.searchVec(q, DEFAULT_EMBED_MODEL, 20, undefined, collections, dateRange);
          if (vecResults.length > 0) {
            for (const r of vecResults) docidMap.set(r.filepath, r.docid);
            rankedLists.push(vecResults.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
          }
        }
      }

      // Step 2b: Temporal proximity channel (if dateRange detected)
      // Scores documents by closeness to query's temporal center — distinct from dateRange WHERE filter
      if (dateRange) {
        const centerMs = (new Date(dateRange.start).getTime() + new Date(dateRange.end).getTime()) / 2;
        const rangeMs = Math.max(new Date(dateRange.end).getTime() - new Date(dateRange.start).getTime(), 86400000);
        const temporalDocs = store.db.prepare(`
          SELECT 'clawmem://' || d.collection || '/' || d.path as filepath,
                 d.collection || '/' || d.path as displayPath,
                 d.title, d.modified_at
          FROM documents d
          WHERE d.active = 1 AND d.invalidated_at IS NULL AND d.modified_at >= ? AND d.modified_at <= ?
          ORDER BY d.modified_at DESC LIMIT 30
        `).all(dateRange.start, dateRange.end) as { filepath: string; displayPath: string; title: string; modified_at: string }[];

        if (temporalDocs.length > 0) {
          const temporalRanked: RankedResult[] = temporalDocs.map(d => {
            const docMs = new Date(d.modified_at).getTime();
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

      // Weight: original query BM25+vec get 2x, expanded queries get 1x, temporal/entity legs get 1x
      const numOriginalLists = hasVectors ? 2 : 1; // first BM25 + first vector from original query
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

      const reranked = await store.rerank(query, chunksToRerank, DEFAULT_RERANK_MODEL, intent);

      const candidateMap = new Map(candidates.map(c => [c.file, c]));
      const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

      // Blend RRF + reranker scores (position-aware)
      const blended = reranked.map(r => {
        const rrfRank = rrfRankMap.get(r.file) || candidates.length;
        const rrfWeight = rrfRank <= 3 ? 0.75 : rrfRank <= 10 ? 0.60 : 0.40;
        const blendedScore = rrfWeight * (1 / rrfRank) + (1 - rrfWeight) * r.score;
        return { file: r.file, score: blendedScore };
      });
      blended.sort((a, b) => b.score - a.score);

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
      let scored = applyCompositeScoring(enriched, query, coFn)
        .filter(r => r.compositeScore >= (minScore || 0));
      if (diverse !== false) scored = applyMMRDiversity(scored);
      scored = scored.slice(0, limit || 10);

      if (compact) {
        const items = scored.map(r => ({
          docid: `#${docidMap.get(r.filepath) || r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
          fragment: r.fragmentType ? { type: r.fragmentType, label: r.fragmentLabel } : undefined,
        }));
        return { content: [{ type: "text", text: formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query) }], structuredContent: { results: items } };
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
        content: [{ type: "text", text: formatSearchSummary(items, query) }],
        structuredContent: { results: items },
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
    } catch {
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

    // Clear winner: high score OR significant gap to #2
    const gap = candidates.length > 1 ? top.score - candidates[1]!.score : 1.0;
    const confident = top.score >= 0.7 || gap >= 0.2;

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

      s.deactivateDocument(collection, path);

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
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ file, limit, vault }) => {
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

      // Use the document's content as the search query
      const queryText = `${title}\n${body.slice(0, 1000)}`;
      const vecResults = await store.searchVec(queryText, DEFAULT_EMBED_MODEL, (limit || 5) + 1);

      // Filter out the reference document itself
      const similar = vecResults
        .filter(r => r.filepath !== result.filepath)
        .slice(0, limit || 5);

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
        content: [{ type: "text", text: `${items.length} similar to "${title}":\n${items.map(i => `  ${i.file} (${Math.round(i.score * 100)}%)`).join('\n')}` }],
        structuredContent: { reference: file, results: items },
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
      const totalStats: IndexStats = { added: 0, updated: 0, unchanged: 0, removed: 0 };

      for (const col of collections) {
        const stats = await indexCollection(store, col.name, col.path, col.pattern);
        totalStats.added += stats.added;
        totalStats.updated += stats.updated;
        totalStats.unchanged += stats.unchanged;
        totalStats.removed += stats.removed;
      }

      const summary = `Reindex complete: +${totalStats.added} added, ~${totalStats.updated} updated, =${totalStats.unchanged} unchanged, -${totalStats.removed} removed`;
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

      const results: { temporal?: number; semantic?: number } = {};

      if (shouldBuildTemporal) {
        results.temporal = store.buildTemporalBackbone();
      }

      if (shouldBuildSemantic) {
        results.semantic = await store.buildSemanticGraph(semantic_threshold);
      }

      const lines = [];
      if (results.temporal !== undefined) lines.push(`Temporal graph: ${results.temporal} edges`);
      if (results.semantic !== undefined) lines.push(`Semantic graph: ${results.semantic} edges`);

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

      // Step 1: Intent classification
      const intent = force_intent
        ? { intent: force_intent as IntentType, confidence: 1.0 }
        : await classifyIntent(query, llm, store.db);

      // Step 1b: Temporal constraint — convert intent's local dates to UTC for search
      // extractTemporalConstraint() already returns UTC; intent classification stores local dates
      const dateRange = (intent.temporal_start && intent.temporal_end)
        ? {
            start: intent.temporal_start.includes('T') ? intent.temporal_start : new Date(intent.temporal_start + 'T00:00:00').toISOString(),
            end: intent.temporal_end.includes('T') ? intent.temporal_end : new Date(intent.temporal_end + 'T23:59:59.999').toISOString(),
          }
        : extractTemporalConstraint(query) || undefined;

      // Step 2: Baseline search (BM25 + Vector) — with temporal filter if detected
      const bm25Results = store.searchFTS(query, 30, undefined, undefined, dateRange);
      const vecResults = await store.searchVec(query, DEFAULT_EMBED_MODEL, 30, undefined, undefined, dateRange);

      // Step 3: Intent-weighted RRF
      const rrfWeights = intent.intent === 'WHEN'
        ? [1.5, 1.0]  // Boost BM25 for temporal (dates in text)
        : intent.intent === 'WHY'
        ? [1.0, 1.5]  // Boost vector for causal (semantic)
        : [1.0, 1.0]; // Balanced

      const fusedRanked = reciprocalRankFusion([bm25Results.map(toRanked), vecResults.map(toRanked)], rrfWeights);

      // Map RRF results back to SearchResult with updated scores
      const allSearchResults = [...bm25Results, ...vecResults];
      const fused: SearchResult[] = fusedRanked.map(fr => {
        const original = allSearchResults.find(r => r.filepath === fr.file);
        return original ? { ...original, score: fr.score } : null;
      }).filter((r): r is SearchResult => r !== null);

      // Step 4: Graph expansion (if enabled and intent allows)
      let expanded = fused;
      if (enable_graph_traversal && (intent.intent === 'WHY' || intent.intent === 'ENTITY')) {
        const anchorEmbeddingResult = await llm.embed(query);
        if (anchorEmbeddingResult) {
          const traversed = adaptiveTraversal(store.db, fused.slice(0, 10).map(r => ({ hash: r.hash, score: r.score })), {
            maxDepth: 2,
            beamWidth: 5,
            budget: 30,
            intent: intent.intent,
            queryEmbedding: anchorEmbeddingResult.embedding,
          });

          // Merge traversed nodes with original results
          const merged = mergeTraversalResults(
            store.db,
            fused.map(r => ({ hash: r.hash, score: r.score })),
            traversed
          );

          // Step 4b: MPFP multi-path traversal (runs intent-specific meta-path patterns)
          const mpfpNodes = mpfpTraversal(
            store.db,
            fused.slice(0, 10).map(r => ({ hash: r.hash, score: r.score })),
            intent.intent,
            20
          );
          // Normalize MPFP scores to [0,1] before merging (raw Forward Push mass is unbounded)
          const maxMpfpScore = mpfpNodes.length > 0 ? Math.max(...mpfpNodes.map(n => n.score)) : 1;
          const mpfpNormalizer = maxMpfpScore > 0 ? 1 / maxMpfpScore : 1;

          // Merge normalized MPFP results into merged array
          for (const node of mpfpNodes) {
            const normalizedScore = node.score * mpfpNormalizer;
            const doc = store.db.prepare(`SELECT hash FROM documents WHERE id = ? AND active = 1 AND invalidated_at IS NULL LIMIT 1`).get(node.docId) as { hash: string } | undefined;
            if (doc) {
              const existing = merged.find(m => m.hash === doc.hash);
              if (existing) {
                existing.score = Math.max(existing.score, normalizedScore * 0.9);
              } else {
                merged.push({ hash: doc.hash, score: normalizedScore * 0.75 });
              }
            }
          }

          // Step 4c: Entity co-occurrence graph expansion (ENTITY intent only)
          if (intent.intent === 'ENTITY') {
            // Get doc IDs from top fused results for entity seed lookup
            const seedDocIds = fused.slice(0, 10).map(r => {
              const row = store.db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1 LIMIT 1`).get(r.hash) as { id: number } | undefined;
              return row?.id;
            }).filter((id): id is number => id !== undefined);

            const entityNeighbors = getEntityGraphNeighbors(store.db, seedDocIds, 15);
            for (const en of entityNeighbors) {
              const doc = store.db.prepare(`SELECT hash FROM documents WHERE id = ? AND active = 1 AND invalidated_at IS NULL LIMIT 1`).get(en.docId) as { hash: string } | undefined;
              if (doc && !merged.some(m => m.hash === doc.hash)) {
                merged.push({ hash: doc.hash, score: en.score * 0.7 }); // Slight discount for entity-graph-only hits
              }
            }
          }

          // Convert back to SearchResult format — hydrate graph-discovered nodes from DB
          expanded = merged.map(m => {
            const original = fused.find(f => f.hash === m.hash);
            if (original) return { ...original, score: m.score };
            // Graph-discovered node not in original fused results — hydrate from DB
            const doc = store.db.prepare(`
              SELECT d.collection, d.path, d.title, d.hash, c.doc as body, d.modified_at
              FROM documents d
              LEFT JOIN content c ON c.hash = d.hash
              WHERE d.hash = ? AND d.active = 1 AND d.invalidated_at IS NULL LIMIT 1
            `).get(m.hash) as { collection: string; path: string; title: string; hash: string; body: string | null; modified_at: string } | undefined;
            if (!doc) return null;
            return {
              filepath: `clawmem://${doc.collection}/${doc.path}`,
              displayPath: `${doc.collection}/${doc.path}`,
              title: doc.title || doc.path.split("/").pop() || "",
              context: null,
              hash: doc.hash,
              docid: doc.hash.slice(0, 6),
              collectionName: doc.collection,
              modifiedAt: doc.modified_at || "",
              bodyLength: doc.body?.length || 0,
              body: doc.body || "",
              score: m.score,
              source: "vec" as const,
            } satisfies SearchResult;
          }).filter((r): r is SearchResult => r !== null);
        }
      }

      // Step 5: Rerank top 30 and blend scores (same pattern as query tool)
      const toRerank = expanded.slice(0, 30);
      const rerankDocs = toRerank.map(r => ({
        file: r.filepath,
        text: r.body?.slice(0, 200) || r.title,
      }));

      const reranked = await store.rerank(query, rerankDocs);

      // Blend original + rerank scores using file-keyed join (matching query tool pattern)
      const rerankMap = new Map(reranked.map(r => [r.file, r.score]));
      const rankMap = new Map(toRerank.map((r, i) => [r.filepath, i + 1]));
      const blendedResults = toRerank.map(r => {
        const rerankScore = rerankMap.get(r.filepath) || 0;
        const rank = rankMap.get(r.filepath) || toRerank.length;
        const origWeight = rank <= 3 ? 0.75 : rank <= 10 ? 0.60 : 0.40;
        const blended = origWeight * r.score + (1 - origWeight) * rerankScore;
        return { ...r, score: blended };
      });
      blendedResults.sort((a, b) => b.score - a.score);

      // Step 6: Composite scoring
      const enriched = enrichResults(store, blendedResults, query);

      const scored = applyCompositeScoring(enriched, query);

      // Format results
      const results = scored.slice(0, limit || 10).map(r => ({
        docid: r.docid,
        file: r.filepath,
        title: r.title,
        score: r.score,
        compositeScore: r.compositeScore,
        context: r.context,
        snippet: r.body?.slice(0, 300) || '',
        contentType: r.contentType,
      }));

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
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ query, limit, compact, vault }) => {
      const store = getStore(vault);
      const llm = getDefaultLlamaCpp();

      // Decompose query into typed clauses
      const clauses = await decomposeQuery(query, llm, store.db);

      // Sort by priority and execute each clause
      const sortedClauses = [...clauses].sort((a, b) => a.priority - b.priority);
      const allResults: SearchResult[] = [];
      const clauseDetails: { type: string; query: string; priority: number; resultCount: number }[] = [];

      for (const clause of sortedClauses) {
        let results: SearchResult[] = [];
        if (clause.type === 'bm25') {
          results = store.searchFTS(clause.query, 20, undefined, clause.collections);
        } else if (clause.type === 'vector') {
          results = await store.searchVec(clause.query, DEFAULT_EMBED_MODEL, 20, undefined, clause.collections);
        } else if (clause.type === 'graph') {
          // Graph clause: run intent_search-style retrieval
          const intent = await classifyIntent(clause.query, llm, store.db);
          const bm25 = store.searchFTS(clause.query, 15, undefined, clause.collections);
          const vec = await store.searchVec(clause.query, DEFAULT_EMBED_MODEL, 15, undefined, clause.collections);
          const fused = reciprocalRankFusion([bm25.map(toRanked), vec.map(toRanked)], [1.0, 1.0]);
          const searchMap = new Map([...bm25, ...vec].map(r => [r.filepath, r]));
          results = fused
            .map(fr => searchMap.get(fr.file))
            .filter((r): r is SearchResult => r !== null);

          // Graph expansion for WHY/ENTITY
          if (intent.intent === 'WHY' || intent.intent === 'ENTITY') {
            const anchorEmb = await llm.embed(clause.query);
            if (anchorEmb) {
              const traversed = adaptiveTraversal(store.db, results.slice(0, 5).map(r => ({ hash: r.hash, score: r.score })), {
                maxDepth: 2, beamWidth: 3, budget: 15, intent: intent.intent, queryEmbedding: anchorEmb.embedding,
              });
              const merged = mergeTraversalResults(store.db, results.map(r => ({ hash: r.hash, score: r.score })), traversed);
              const expandedMap = new Map(results.map(r => [r.hash, r]));
              results = merged.map(m => {
                const existing = expandedMap.get(m.hash);
                if (existing) return { ...existing, score: m.score };
                // Graph-discovered node — hydrate from DB
                const doc = store.db.prepare(`
                  SELECT d.collection, d.path, d.title, d.hash, c.doc as body, d.modified_at
                  FROM documents d
                  LEFT JOIN content c ON c.hash = d.hash
                  WHERE d.hash = ? AND d.active = 1 AND d.invalidated_at IS NULL LIMIT 1
                `).get(m.hash) as { collection: string; path: string; title: string; hash: string; body: string | null; modified_at: string } | undefined;
                if (!doc) return null;
                return {
                  filepath: `clawmem://${doc.collection}/${doc.path}`,
                  displayPath: `${doc.collection}/${doc.path}`,
                  title: doc.title || doc.path.split("/").pop() || "",
                  context: null,
                  hash: doc.hash,
                  docid: doc.hash.slice(0, 6),
                  collectionName: doc.collection,
                  modifiedAt: doc.modified_at || "",
                  bodyLength: doc.body?.length || 0,
                  body: doc.body || "",
                  score: m.score,
                  source: "vec" as const,
                } satisfies SearchResult;
              }).filter((r): r is SearchResult => r !== null);
            }
          }
        }
        clauseDetails.push({ type: clause.type, query: clause.query, priority: clause.priority, resultCount: results.length });
        allResults.push(...results);
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

      if (compact) {
        const items = scored.map(r => ({
          docid: `#${r.docid}`, path: r.displayPath, title: r.title,
          score: Math.round((r.compositeScore ?? r.score) * 100) / 100,
          snippet: (r.body || "").substring(0, 150), content_type: r.contentType, modified_at: r.modifiedAt,
        }));
        return {
          content: [{ type: "text", text: `Query Plan (${sortedClauses.length} clauses):\n${planSummary}\n\n${formatSearchSummary(items.map(i => ({ ...i, file: i.path, compositeScore: i.score, context: null })), query)}` }],
          structuredContent: { plan: clauseDetails, results: items },
        };
      }

      const items = scored.map(r => ({
        docid: r.docid, file: r.filepath, title: r.title, score: r.score,
        compositeScore: r.compositeScore, context: r.context, snippet: r.body?.slice(0, 300) || '', contentType: r.contentType,
      }));
      return {
        content: [{ type: "text", text: `Query Plan (${sortedClauses.length} clauses):\n${planSummary}\n\n${formatSearchSummary(items, query)}` }],
        structuredContent: { plan: clauseDetails, results: items },
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
      description: "USE THIS to trace decision chains: 'what led to X', 'trace how we got from A to B'. Follow up intent_search with this tool on a top result to walk the full causal chain. Returns depth-annotated links with reasoning.",
      inputSchema: {
        docid: z.string().describe("Document ID (e.g., '#123' or path)"),
        direction: z.enum(['causes', 'caused_by', 'both']).optional().default('both').describe("Direction: 'causes' (outbound), 'caused_by' (inbound), or 'both'"),
        depth: z.number().optional().default(5).describe("Maximum traversal depth (1-10)"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ docid, direction, depth, vault }) => {
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

      // Find causal links
      const links = store.findCausalLinks(doc.id, direction, depth);

      if (links.length === 0) {
        return {
          content: [{ type: "text", text: `No causal links found for "${doc.title}" (${direction})` }],
          structuredContent: { source: doc, links: [] },
        };
      }

      // Format summary
      const directionLabel = direction === 'causes' ? 'causes' : direction === 'caused_by' ? 'is caused by' : 'is causally related to';
      const lines = [`"${doc.title}" ${directionLabel} ${links.length} document(s):\n`];

      for (const link of links) {
        const confidence = Math.round(link.weight * 100);
        const reasoning = link.reasoning ? ` - ${link.reasoning}` : '';
        lines.push(`[Depth ${link.depth}] ${confidence}% ${link.title} (${link.filepath})${reasoning}`);
      }

      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: {
          source: {
            id: doc.id,
            title: doc.title,
            filepath: `${doc.collection}/${doc.path}`,
          },
          direction,
          links: links.map(l => ({
            id: l.docId,
            title: l.title,
            filepath: l.filepath,
            depth: l.depth,
            confidence: Math.round(l.weight * 100),
            reasoning: l.reasoning,
          })),
        },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: kg_query (SPO Knowledge Graph)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "kg_query",
    {
      title: "Knowledge Graph Query",
      description: "Query the knowledge graph for an entity's relationships. Returns structured facts with temporal validity (valid_from/valid_to). Use for 'what does X relate to?', 'what was true about X on date Y?', 'who/what is connected to X?'.",
      inputSchema: {
        entity: z.string().describe("Entity name or ID to query"),
        as_of: z.string().optional().describe("Date filter (YYYY-MM-DD) — only facts valid at this date"),
        direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both").describe("Relationship direction"),
        vault: z.string().optional().describe("Named vault (omit for default vault)"),
      },
    },
    async ({ entity, as_of, direction, vault }) => {
      const store = getStore(vault);

      const entityResults = store.searchEntities(entity, 1);
      const entityId = entityResults.length > 0
        ? entityResults[0]!.entity_id
        : entity.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

      const triples = store.queryEntityTriples(entityId, { asOf: as_of, direction });
      const stats = store.getTripleStats();

      if (triples.length === 0) {
        return {
          content: [{ type: "text", text: `No knowledge graph facts found for "${entity}". The KG has ${stats.totalTriples} total triples (${stats.currentFacts} current).` }],
        };
      }

      const lines = [`Knowledge graph for "${entity}" (${triples.length} fact${triples.length === 1 ? '' : 's'}):\n`];

      for (const t of triples) {
        const validity = t.current ? "current" : `ended ${t.validTo}`;
        const from = t.validFrom ? ` (since ${t.validFrom})` : "";
        const conf = Math.round(t.confidence * 100);
        lines.push(`[${t.direction}] ${t.subject} → ${t.predicate} → ${t.object}${from} [${validity}, ${conf}%]`);
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
        docid: z.string().describe("Document ID (e.g., '#123' or path)"),
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
        docid: z.string().describe("Document ID (e.g., '#123' or short hash)"),
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
      description: "Run lifecycle policies: archive stale docs, optionally purge old archives. Defaults to dry_run (preview only).",
      inputSchema: {
        dry_run: z.boolean().optional().default(true).describe("Preview what would be archived/purged without acting"),
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

        return { content: [{ type: "text", text: `Would archive ${candidates.length} document(s):\n${lines.join("\n") || "(none)"}${recallLines.join("\n")}` }] };
      }

      const archived = store.archiveDocuments(candidates.map(c => c.id));
      let purged = 0;
      if (policy.purge_after_days) {
        purged = store.purgeArchivedDocuments(policy.purge_after_days);
      }

      return { content: [{ type: "text", text: `Lifecycle sweep: archived ${archived}, purged ${purged}` }] };
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
        return {
          content: [{
            type: "text",
            text: `Synced to vault "${vault}":\n  Collection: ${collName}\n  Root: ${root}\n  Added: ${stats.added}\n  Updated: ${stats.updated}\n  Deleted: ${stats.removed}`,
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
  // Connect
  // ---------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ---------------------------------------------------------------------------
  // Consolidation Worker
  // ---------------------------------------------------------------------------

  // Start consolidation worker if enabled
  if (Bun.env.CLAWMEM_ENABLE_CONSOLIDATION === "true") {
    const llm = getDefaultLlamaCpp();
    const intervalMs = parseInt(Bun.env.CLAWMEM_CONSOLIDATION_INTERVAL || "300000", 10);
    startConsolidationWorker(store, llm, intervalMs);
  }

  // Signal handlers for graceful shutdown
  process.on("SIGINT", () => {
    console.error("\n[mcp] Received SIGINT, shutting down...");
    stopConsolidationWorker();
    closeAllStores();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.error("\n[mcp] Received SIGTERM, shutting down...");
    stopConsolidationWorker();
    closeAllStores();
    process.exit(0);
  });
}

if (import.meta.main) {
  startMcpServer().catch(console.error);
}
