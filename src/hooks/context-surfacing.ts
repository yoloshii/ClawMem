/**
 * Context Surfacing Hook - UserPromptSubmit
 *
 * Fires on every user message. Searches the vault for relevant context,
 * applies SAME composite scoring, enforces a token budget, and injects
 * the most relevant notes as additional context for Claude.
 */

import type { Store, SearchResult } from "../store.ts";
import { DEFAULT_EMBED_MODEL, DEFAULT_QUERY_MODEL, DEFAULT_RERANK_MODEL, extractSnippet, resolveStore } from "../store.ts";
import { getVaultPath, getActiveProfile } from "../config.ts";
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

// =============================================================================
// Config
// =============================================================================

// Profile-driven defaults (overridden by CLAWMEM_PROFILE env var via E14)
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

// Memory nudge: prompt agent to use lifecycle tools after N prompts without use
const NUDGE_INTERVAL = parseInt(process.env.CLAWMEM_NUDGE_INTERVAL || "15", 10);
const LIFECYCLE_HOOK_NAMES = ["memory_pin", "memory_forget", "memory_snooze", "lifecycle-archive"];
const NUDGE_TEXT = "You haven't managed memory recently. If vault-context is surfacing noise → snooze it. If a critical decision was just made → pin it. If stale knowledge appeared → forget it.";

// File path patterns to extract from prompts (E13 replacement: file-aware UserPromptSubmit)
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

  // Load active performance profile (E14)
  const profile = getActiveProfile();
  const maxResults = profile.maxResults;
  const tokenBudget = profile.tokenBudget;
  const startTime = Date.now();

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

  // Dual-query: also search skill vault if configured (secondary source)
  if (getVaultPath("skill")) {
    try {
      const skillStore = resolveStore("skill");
      const skillResults = skillStore.searchFTS(prompt, 5);
      // Tag skill vault results for identification in output
      for (const r of skillResults) {
        (r as any)._fromVault = "skill";
      }
      results = [...results, ...skillResults];
    } catch {
      // Skill vault unavailable — continue with general results only
    }
  }

  // File-aware supplemental search (E13 replacement): extract file paths/names from prompt
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

  // Budget-aware deep escalation (deep profile only):
  // If the fast path finished quickly and found results, spend remaining time budget
  // on query expansion (discovers new candidates) and cross-encoder reranking (reorders).
  if (profile.deepEscalation && results.length >= 2) {
    const elapsed = Date.now() - startTime;
    if (elapsed < profile.escalationBudgetMs) {
      try {
        // Phase 1: Query expansion — discover candidates BM25+vector missed
        const expanded = await store.expandQuery(prompt, DEFAULT_QUERY_MODEL);
        if (expanded.length > 0) {
          const seen = new Set(results.map(r => r.filepath));
          for (const eq of expanded.slice(0, 3)) {
            if (Date.now() - startTime > 6000) break; // hard stop at 6s
            const ftsExp = store.searchFTS(eq, 5);
            for (const r of ftsExp) {
              if (!seen.has(r.filepath)) {
                seen.add(r.filepath);
                results.push(r);
              }
            }
          }
        }

        // Phase 2: Cross-encoder reranking — reorder with deeper relevance signal
        // Sort by score first so reranking covers the best candidates, not just
        // the first-inserted (expansion hits appended later would otherwise be missed)
        if (Date.now() - startTime < 6000 && results.length >= 3) {
          results.sort((a, b) => b.score - a.score);
          const toRerank = results.slice(0, 15).map(r => ({
            file: r.filepath,
            text: (r.body || "").slice(0, 2000),
          }));
          const reranked = await store.rerank(prompt, toRerank, DEFAULT_RERANK_MODEL);
          if (reranked.length > 0) {
            const rerankedMap = new Map(reranked.map(r => [r.file, r.score]));
            // Blend: 60% original score + 40% reranker score for stability
            for (const r of results) {
              const rerankScore = rerankedMap.get(r.filepath);
              if (rerankScore !== undefined) {
                r.score = 0.6 * r.score + 0.4 * rerankScore;
              }
            }
            results.sort((a, b) => b.score - a.score);
          }
        }
      } catch {
        // Escalation failed (GPU down, timeout, etc.) — continue with fast-path results
      }
    }
  }

  // Filter out private/excluded paths
  results = results.filter(r =>
    !FILTERED_PATHS.some(p => r.displayPath.includes(p))
  );

  if (results.length === 0) return makeEmptyOutput("context-surfacing");

  // Filter out snoozed documents
  const now = new Date();
  results = results.filter(r => {
    // filepath is a virtual path (clawmem://collection/path) but findActiveDocument
    // expects the collection-relative path, not the full virtual path
    const parsed = r.filepath.startsWith('clawmem://') ? r.filepath.replace(/^clawmem:\/\/[^/]+\/?/, '') : r.filepath;
    // Use the correct store for skill-vault results
    const targetStore = (r as any)._fromVault === "skill" ? (() => { try { return resolveStore("skill"); } catch { return store; } })() : store;
    const doc = targetStore.findActiveDocument(r.collectionName, parsed);
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

  // Enrich with SAME metadata — route skill-vault results through their own store
  const generalResults = results.filter(r => !(r as any)._fromVault);
  const skillResults = results.filter(r => (r as any)._fromVault === "skill");
  let enriched = enrichResults(store, generalResults, prompt);
  if (skillResults.length > 0) {
    try {
      const skillStore = resolveStore("skill");
      enriched = [...enriched, ...enrichResults(skillStore, skillResults, prompt)];
    } catch {
      // Skill store unavailable — enrich with general store as fallback
      enriched = [...enriched, ...enrichResults(store, skillResults, prompt)];
    }
  }

  // Apply composite scoring
  const allScored = applyCompositeScoring(enriched, prompt);

  // Threshold filtering — adaptive (ratio-based) or absolute (legacy)
  let scored: typeof allScored;
  if (profile.thresholdMode === "adaptive") {
    // Use max composite score across the set (not positional [0], which may be
    // reordered by recency-intent sorting in applyCompositeScoring)
    const bestScore = allScored.length > 0
      ? Math.max(...allScored.map(r => r.compositeScore))
      : 0;

    // Activation floor: if even the best result is too weak, bail entirely
    if (bestScore < profile.activationFloor) return makeEmptyOutput("context-surfacing");

    const adaptiveMin = Math.max(bestScore * profile.minScoreRatio, profile.absoluteFloor);
    scored = allScored.filter(r => r.compositeScore >= adaptiveMin);
  } else {
    // Legacy absolute threshold (backward compat)
    scored = allScored.filter(r => r.compositeScore >= minScore);
  }

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
            // Boost by 0.1 per co-activation count, capped at +0.2
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
  // If top results are all semantic, promote the best procedural result
  if (scored.length > 3) {
    const top3Types = scored.slice(0, 3).map(r => inferMemoryType(r.displayPath, r.contentType, r.body));
    const hasProc = top3Types.includes("procedural");
    if (!hasProc) {
      const procIdx = scored.findIndex(r => inferMemoryType(r.displayPath, r.contentType, r.body) === "procedural");
      if (procIdx > 3) {
        // Move the best procedural result to position 3
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
  // This makes routing instructions salient at the moment of tool selection (per research)
  const routingHint = detectRoutingHint(prompt);

  // Memory nudge: periodically remind agent to use lifecycle tools
  const nudge = NUDGE_INTERVAL > 0 ? shouldNudge(store) : null;

  const parts: string[] = [];
  if (routingHint) parts.push(`<vault-routing>${routingHint}</vault-routing>`);
  parts.push(`<vault-context>\n${context}\n</vault-context>`);
  if (nudge) parts.push(`<vault-nudge>${NUDGE_TEXT}</vault-nudge>`);

  return makeContextOutput("context-surfacing", parts.join("\n"));
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

  // Timeline/session signals
  if (/\b(last session|yesterday|prior session|previous session|last time we|handoff|what happened last|what did we do|cross.session|earlier today|what we discussed|when we last)\b/i.test(q)) {
    return "If searching memory for this: use session_log or memory_retrieve, NOT query.";
  }

  // Causal signals
  if (/\b(why did|why was|why were|what caused|what led to|reason for|decided to|decision about|trade.?off|instead of|chose to)\b/i.test(q) || /^why\b/i.test(q)) {
    return "If searching memory for this: use intent_search or memory_retrieve, NOT query.";
  }

  // Discovery signals
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

/**
 * Check if the agent should be nudged to use lifecycle tools.
 * Returns true if N+ context-surfacing invocations have occurred since the
 * last lifecycle tool use (memory_pin, memory_forget, memory_snooze).
 */
function shouldNudge(store: Store): boolean {
  try {
    // Count context-surfacing invocations since last lifecycle tool use
    const lastLifecycle = store.db.prepare(`
      SELECT MAX(id) as max_id FROM context_usage
      WHERE hook_name IN (${LIFECYCLE_HOOK_NAMES.map(() => "?").join(",")})
    `).get(...LIFECYCLE_HOOK_NAMES) as { max_id: number | null } | undefined;

    const sinceId = lastLifecycle?.max_id ?? 0;
    const count = store.db.prepare(`
      SELECT COUNT(*) as cnt FROM context_usage
      WHERE hook_name = 'context-surfacing' AND id > ?
    `).get(sinceId) as { cnt: number } | undefined;

    return (count?.cnt ?? 0) >= NUDGE_INTERVAL;
  } catch {
    return false; // DB error — fail silent, no nudge
  }
}
