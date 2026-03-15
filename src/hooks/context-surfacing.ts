/**
 * Context Surfacing Hook - UserPromptSubmit
 *
 * Fires on every user message. Searches the vault for relevant context,
 * applies SAME composite scoring, enforces a token budget, and injects
 * the most relevant notes as additional context for Claude.
 */

import type { Store, SearchResult } from "../store.ts";
import { DEFAULT_EMBED_MODEL, extractSnippet } from "../store.ts";
import type { HookInput, HookOutput } from "../hooks.ts";
import {
  makeContextOutput,
  makeEmptyOutput,
  smartTruncate,
  estimateTokens,
  logInjection,
  isHeartbeatPrompt,
  wasPromptSeenRecently,
} from "../hooks.ts";
import {
  applyCompositeScoring,
  hasRecencyIntent,
  inferMemoryType,
  type EnrichedResult,
  type ScoredResult,
} from "../memory.ts";
import { enrichResults } from "../search-utils.ts";
import { sanitizeSnippet } from "../promptguard.ts";
import { shouldSkipRetrieval, isRetrievedNoise } from "../retrieval-gate.ts";
import { MAX_QUERY_LENGTH } from "../limits.ts";
import { getActiveProfile } from "../config.ts";

// =============================================================================
// Config
// =============================================================================

// Profile-driven defaults (overridden by CLAWMEM_PROFILE env var)
const DEFAULT_TOKEN_BUDGET = 800;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0.45;
const MIN_COMPOSITE_SCORE_RECENCY = 0.35;
const MIN_PROMPT_LENGTH = 20;

// Tiered injection: HOT gets full snippets, WARM gets shorter, COLD gets title-only
function getTierConfig(score: number): { snippetLen: number; showMeta: boolean; tier: string } {
  if (score > 0.8) return { snippetLen: 300, showMeta: true, tier: "HOT" };
  if (score > 0.6) return { snippetLen: 150, showMeta: false, tier: "WARM" };
  return { snippetLen: 0, showMeta: false, tier: "COLD" };
}

// Directories to never surface
const FILTERED_PATHS = ["_PRIVATE/", "experiments/", "_clawmem/"];

// File path patterns to extract from prompts (E13: file-aware UserPromptSubmit)
const FILE_PATH_RE = /(?:^|\s)((?:\/[\w.@-]+)+(?:\.\w+)?|[\w.@-]+\.(?:ts|js|py|md|sh|yaml|yml|json|toml|rs|go|tsx|jsx|css|html))\b/g;

// =============================================================================
// Handler
// =============================================================================

export async function contextSurfacing(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  let prompt = input.prompt?.trim();
  if (!prompt || prompt.length < MIN_PROMPT_LENGTH) return makeEmptyOutput("context-surfacing");

  // Bound query length to prevent DoS on search indices
  if (prompt.length > MAX_QUERY_LENGTH) prompt = prompt.slice(0, MAX_QUERY_LENGTH);

  // Skip slash commands
  if (prompt.startsWith("/")) return makeEmptyOutput("context-surfacing");

  // Adaptive retrieval gate: skip greetings, shell commands, affirmations, etc.
  if (shouldSkipRetrieval(prompt)) return makeEmptyOutput("context-surfacing");

  // Heartbeat / duplicate suppression (IO4)
  if (isHeartbeatPrompt(prompt)) return makeEmptyOutput("context-surfacing");
  if (wasPromptSeenRecently(store, "context-surfacing", prompt)) {
    return makeEmptyOutput("context-surfacing");
  }

  // Load active performance profile
  const profile = getActiveProfile();
  const maxResults = profile.maxResults;
  const tokenBudget = profile.tokenBudget;

  const isRecency = hasRecencyIntent(prompt);
  const minScore = isRecency ? MIN_COMPOSITE_SCORE_RECENCY : profile.minScore;

  // Search: try vector first (if profile allows), fall back to BM25
  // When vector succeeds, also supplement with FTS for keyword-exact recall
  let results: SearchResult[] = [];
  if (profile.useVector) {
    try {
      const vectorPromise = store.searchVec(prompt, DEFAULT_EMBED_MODEL, maxResults);
      const timeoutPromise = new Promise<SearchResult[]>((_, reject) =>
        setTimeout(() => reject(new Error("vector timeout")), profile.vectorTimeout)
      );
      results = await Promise.race([vectorPromise, timeoutPromise]);
    } catch {
      // Vector search unavailable, timed out, or errored — fall back to BM25
    }
  }

  if (results.length === 0) {
    results = store.searchFTS(prompt, maxResults);
  } else {
    // Supplement vector results with FTS for keyword-exact matches (<10ms)
    const seen = new Set(results.map(r => r.filepath));
    const ftsSupplemental = store.searchFTS(prompt, 5);
    for (const r of ftsSupplemental) {
      if (!seen.has(r.filepath)) {
        seen.add(r.filepath);
        results.push(r);
      }
    }
  }

  // File-aware supplemental search (E13): extract file paths/names from prompt
  // and run targeted FTS queries to surface file-specific vault context
  const fileMatches = [...prompt.matchAll(FILE_PATH_RE)].map(m => m[1]!.trim()).filter(Boolean);
  if (fileMatches.length > 0) {
    const seen = new Set(results.map(r => r.filepath));
    for (const fp of fileMatches.slice(0, 3)) {
      try {
        const fileResults = store.searchFTS(fp, 2);
        for (const r of fileResults) {
          if (!seen.has(r.filepath)) {
            seen.add(r.filepath);
            results.push(r);
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  if (results.length === 0) return makeEmptyOutput("context-surfacing");

  // Filter out private/excluded paths
  results = results.filter(r =>
    !FILTERED_PATHS.some(p => r.displayPath.includes(p))
  );

  if (results.length === 0) return makeEmptyOutput("context-surfacing");

  // Filter out snoozed documents
  const now = new Date();
  results = results.filter(r => {
    const parsed = r.filepath.startsWith('clawmem://') ? r.filepath.replace(/^clawmem:\/\/[^/]+\/?/, '') : r.filepath;
    const doc = store.findActiveDocument(r.collectionName, parsed);
    if (!doc) return true;
    if (doc.snoozed_until && new Date(doc.snoozed_until) > now) return false;
    return true;
  });

  if (results.length === 0) return makeEmptyOutput("context-surfacing");

  // Deduplicate by filepath (keep best score per path)
  const deduped = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = deduped.get(r.filepath);
    if (!existing || r.score > existing.score) {
      deduped.set(r.filepath, r);
    }
  }
  results = [...deduped.values()];

  // Filter out noise results (agent denials, too-short snippets) before enrichment
  results = results.filter(r => !r.body || !isRetrievedNoise(r.body));

  // Enrich with SAME metadata
  const enriched = enrichResults(store, results, prompt);

  // Apply composite scoring
  const scored = applyCompositeScoring(enriched, prompt)
    .filter(r => r.compositeScore >= minScore);

  if (scored.length === 0) return makeEmptyOutput("context-surfacing");

  // Spreading activation (E11): boost results co-activated with top HOT results
  if (scored.length > 3) {
    const hotPaths = scored.slice(0, 3)
      .filter(r => r.compositeScore > 0.8)
      .map(r => r.displayPath);

    for (const hotPath of hotPaths) {
      try {
        const coActs = store.getCoActivated(hotPath, 3);
        for (const ca of coActs) {
          const existing = scored.find(r => r.displayPath === ca.path);
          if (existing && existing.compositeScore <= 0.8) {
            existing.compositeScore += Math.min(0.2, 0.1 * Math.min(ca.count, 2));
          }
        }
      } catch {
        // co_activations table may not exist yet
      }
    }
    scored.sort((a, b) => b.compositeScore - a.compositeScore);
  }

  // Memory type diversification (E10): ensure procedural results aren't crowded out
  if (scored.length > 3) {
    const top3Types = scored.slice(0, 3).map(r => inferMemoryType(r.displayPath, r.contentType, r.body));
    const hasProc = top3Types.includes("procedural");
    if (!hasProc) {
      const procIdx = scored.findIndex(r => inferMemoryType(r.displayPath, r.contentType, r.body) === "procedural");
      if (procIdx > 3) {
        const [proc] = scored.splice(procIdx, 1);
        scored.splice(3, 0, proc!);
      }
    }
  }

  // Build context within token budget (profile-driven)
  const { context, paths, tokens } = buildContext(scored, prompt, tokenBudget);

  if (!context) return makeEmptyOutput("context-surfacing");

  // Log the injection
  if (input.sessionId) {
    logInjection(store, input.sessionId, "context-surfacing", paths, tokens);
  }

  // Routing hint: detect query intent signals and prepend a tool routing directive
  const routingHint = detectRoutingHint(prompt);

  return makeContextOutput(
    "context-surfacing",
    routingHint
      ? `<vault-routing>${routingHint}</vault-routing>\n<vault-context>\n${context}\n</vault-context>`
      : `<vault-context>\n${context}\n</vault-context>`
  );
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Detect causal/temporal/discovery signals in the prompt and return a
 * routing hint that makes the correct tool choice salient at the moment
 * of tool selection. Returns null for general queries (no hint needed).
 */
function detectRoutingHint(prompt: string): string | null {
  const q = prompt.toLowerCase();

  if (/\b(last session|yesterday|prior session|previous session|last time we|handoff|what happened last|what did we do|cross.session|earlier today|what we discussed|when we last)\b/i.test(q)) {
    return "If searching memory for this: use session_log or memory_retrieve, NOT query.";
  }

  if (/\b(why did|why was|why were|what caused|what led to|reason for|decided to|decision about|trade.?off|instead of|chose to)\b/i.test(q) || /^why\b/i.test(q)) {
    return "If searching memory for this: use intent_search or memory_retrieve, NOT query.";
  }

  if (/\b(similar to|related to|what else|what other|reminds? me of|like this)\b/i.test(q)) {
    return "If searching memory for this: use find_similar or memory_retrieve, NOT query.";
  }

  return null;
}

function buildContext(
  scored: ScoredResult[],
  query: string,
  budget: number = DEFAULT_TOKEN_BUDGET
): { context: string; paths: string[]; tokens: number } {
  const lines: string[] = [];
  const paths: string[] = [];
  let totalTokens = 0;

  for (const r of scored) {
    if (totalTokens >= budget) break;

    // Tiered injection: allocate snippet length by composite score
    const tier = getTierConfig(r.compositeScore);

    // Sanitize title and displayPath to prevent injection via metadata fields
    const safeTitle = sanitizeSnippet(r.title);
    const safePath = sanitizeSnippet(r.displayPath);
    if (safeTitle === "[content filtered for security]" || safePath === "[content filtered for security]") continue;

    const typeTag = r.contentType !== "note" ? ` (${r.contentType})` : "";
    let entry: string;

    if (tier.snippetLen > 0) {
      // HOT or WARM: include snippet
      const bodyStr = r.body || "";
      const sanitized = sanitizeSnippet(bodyStr);
      if (sanitized === "[content filtered for security]") continue;

      const snippet = smartTruncate(
        extractSnippet(sanitized, query, tier.snippetLen, r.chunkPos).snippet,
        tier.snippetLen
      );
      entry = `**${safeTitle}**${typeTag}\n${safePath}\n${snippet}`;
    } else {
      // COLD: title + path only, no snippet
      entry = `**${safeTitle}**${typeTag}\n${safePath}`;
    }

    const entryTokens = estimateTokens(entry);
    if (totalTokens + entryTokens > budget && lines.length > 0) break;

    lines.push(entry);
    paths.push(r.displayPath);
    totalTokens += entryTokens;
  }

  return {
    context: lines.join("\n\n---\n\n"),
    paths,
    tokens: totalTokens,
  };
}
