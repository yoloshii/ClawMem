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
import { writeRecallEvents, hashQuery } from "../recall-buffer.ts";

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

// Ext 6a: Context instruction + relationship snippets
// The instruction is ALWAYS prepended when the hook emits context — it frames
// the surfaced facts as background knowledge the agent already holds, reducing
// prompt-level ambiguity. Relationship snippets are fetched from the vault
// knowledge graph for edges where BOTH endpoints are in the surfaced doc set.
const INSTRUCTION_TEXT = "Treat the following as background facts you already know unless the user corrects them.";
const INSTRUCTION_XML = `<instruction>${INSTRUCTION_TEXT}</instruction>`;
const INSTRUCTION_TOKEN_COST = estimateTokens(INSTRUCTION_XML);
const RELATIONSHIPS_XML_OVERHEAD_TOKENS = estimateTokens("<relationships>\n\n</relationships>");
const MAX_RELATION_SNIPPETS = 10;

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

  // Compute turn_index FIRST, before any early returns.
  // Every transcript-visible early return must log an empty context_usage row
  // to keep turn_index aligned with transcript turns for per-turn attribution.
  if (input.sessionId) {
    try {
      let turnIndex = 0;
      try {
        const existing = store.db.prepare(
          `SELECT COUNT(*) as cnt FROM context_usage WHERE session_id = ? AND hook_name = 'context-surfacing'`
        ).get(input.sessionId) as { cnt: number };
        turnIndex = existing.cnt;
      } catch { /* fallback to 0 */ }
      (input as any)._turnIndex = turnIndex;
    } catch { /* non-fatal */ }
  }

  if (!prompt || prompt.length < MIN_PROMPT_LENGTH) {
    logEmptyTurn(store, input);
    return makeEmptyOutput("context-surfacing");
  }

  // Bound query length to prevent DoS on search indices
  if (prompt.length > MAX_QUERY_LENGTH) prompt = prompt.slice(0, MAX_QUERY_LENGTH);

  // Skip slash commands — log empty turn for alignment
  if (prompt.startsWith("/")) {
    logEmptyTurn(store, input);
    return makeEmptyOutput("context-surfacing");
  }

  // Adaptive retrieval gate: skip greetings, shell commands, affirmations, etc.
  if (shouldSkipRetrieval(prompt)) {
    logEmptyTurn(store, input);
    return makeEmptyOutput("context-surfacing");
  }

  // Heartbeat / duplicate suppression (IO4) — NOT transcript-visible user turns
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

  if (results.length === 0) { logEmptyTurn(store, input); return makeEmptyOutput("context-surfacing"); }

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

  if (results.length === 0) { logEmptyTurn(store, input); return makeEmptyOutput("context-surfacing"); }

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

  if (results.length === 0) { logEmptyTurn(store, input); return makeEmptyOutput("context-surfacing"); }

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
    if (bestScore < profile.activationFloor) { logEmptyTurn(store, input); return makeEmptyOutput("context-surfacing"); }

    const adaptiveMin = Math.max(bestScore * profile.minScoreRatio, profile.absoluteFloor);
    scored = allScored.filter(r => r.compositeScore >= adaptiveMin);
  } else {
    // Legacy absolute threshold (backward compat)
    scored = allScored.filter(r => r.compositeScore >= minScore);
  }

  if (scored.length === 0) { logEmptyTurn(store, input); return makeEmptyOutput("context-surfacing"); }

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

  // Build context within token budget (profile-driven).
  // Ext 6a: Reserve budget for the always-on instruction line so the final
  // vault-context payload stays within `tokenBudget`. Relations are layered
  // in afterward using whatever budget remains and are the first thing
  // truncated when the payload would overflow.
  const factsBudget = Math.max(0, tokenBudget - INSTRUCTION_TOKEN_COST);
  const { context, paths, tokens } = buildContext(scored, prompt, factsBudget);

  if (!context) {
    logEmptyTurn(store, input);
    return makeEmptyOutput("context-surfacing");
  }

  // Use pre-computed turn_index from top of function
  if (input.sessionId) {
    const turnIndex = (input as any)._turnIndex ?? 0;

    // Log the injection — returns usage_id for recall event linkage
    const usageId = logInjection(store, input.sessionId, "context-surfacing", paths, tokens, turnIndex);

    // Record recall events ONLY for docs that made it into the injected context
    // (post-budget). Docs trimmed by token budget were never seen by the model.
    // Each event links to its context_usage row via usage_id + turn_index.
    // Multi-vault: route docs to origin vault's store. Mirror context_usage there too.
    try {
      const qHash = hashQuery(prompt);
      const injectedSet = new Set(paths);
      const injectedScored = scored.filter(r => injectedSet.has(r.displayPath));

      // Group by vault origin (undefined = general vault)
      const byVault = new Map<string | undefined, typeof injectedScored>();
      for (const r of injectedScored) {
        const vault = (r as any)._fromVault as string | undefined;
        let group = byVault.get(vault);
        if (!group) { group = []; byVault.set(vault, group); }
        group.push(r);
      }

      const validUsageId = usageId > 0 ? usageId : undefined;
      for (const [vault, docs] of byVault) {
        const mappedDocs = docs.map(r => ({ displayPath: r.displayPath, searchScore: r.compositeScore }));
        if (!vault) {
          writeRecallEvents(store, input.sessionId, qHash, mappedDocs, validUsageId, turnIndex);
        } else {
          try {
            const vaultStore = resolveStore(vault);
            // Mirror context_usage row into named vault for correct FK + attribution
            const vaultPaths = docs.map(r => r.displayPath);
            const vaultUsageId = vaultStore.insertUsage({
              sessionId: input.sessionId,
              timestamp: new Date().toISOString(),
              hookName: "context-surfacing",
              injectedPaths: vaultPaths,
              estimatedTokens: 0,
              wasReferenced: 0,
              turnIndex,
            });
            writeRecallEvents(vaultStore, input.sessionId, qHash, mappedDocs, vaultUsageId > 0 ? vaultUsageId : undefined, turnIndex);
          } catch { /* vault unavailable — skip */ }
        }
      }
    } catch {
      // Non-critical — don't block context surfacing on recall tracking errors
    }
  }

  // Routing hint: detect query intent signals and prepend a tool routing directive
  // This makes routing instructions salient at the moment of tool selection (per research)
  const routingHint = detectRoutingHint(prompt);

  // Memory nudge: periodically remind agent to use lifecycle tools
  const nudge = NUDGE_INTERVAL > 0 ? shouldNudge(store) : null;

  // Ext 6a: Enrich vault-context with instruction framing + optional
  // relationship snippets sourced from memory_relations. Only edges where
  // BOTH endpoints are in the surfaced doc set are included. The relations
  // block is the first thing dropped when the payload would overflow budget.
  //
  // Budget accounting (Turn 11 fix): `tokens` from buildContext only sums per-
  // entry bodies and misses both the `<facts>...</facts>` wrapper and the
  // `\n\n---\n\n` separators between entries. Compute the wrapped-facts cost
  // directly from the rendered string so the relationships block can never
  // push the final `<vault-context>` inner payload past `tokenBudget`.
  const surfacedDocIds = lookupSurfacedDocIds(store, paths);
  const relationSnippets = fetchRelationSnippets(store, surfacedDocIds);
  const factsBlockXml = `<facts>\n${context}\n</facts>`;
  const factsWrappedTokens = estimateTokens(factsBlockXml);
  const relationBudget = Math.max(
    0,
    tokenBudget - INSTRUCTION_TOKEN_COST - factsWrappedTokens
  );
  const vaultInner = buildVaultContextInner(context, relationSnippets, relationBudget);

  const parts: string[] = [];
  if (routingHint) parts.push(`<vault-routing>${routingHint}</vault-routing>`);
  parts.push(`<vault-context>\n${vaultInner}\n</vault-context>`);
  if (nudge) parts.push(`<vault-nudge>${NUDGE_TEXT}</vault-nudge>`);

  return makeContextOutput("context-surfacing", parts.join("\n"));
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Log an empty context_usage row for a skipped turn.
 * Keeps turn_index aligned with transcript turns so per-turn recall
 * attribution doesn't drift when some prompts are gated.
 */
function logEmptyTurn(store: Store, input: HookInput): void {
  if (!input.sessionId) return;
  try {
    const turnIndex = (input as any)._turnIndex ?? 0;
    logInjection(store, input.sessionId, "context-surfacing", [], 0, turnIndex);
  } catch { /* non-fatal */ }
}

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

// =============================================================================
// Ext 6a: Relationship snippets + instruction framing
// =============================================================================

/**
 * Relationship snippet derived from a memory_relations edge whose source and
 * target are both active documents currently surfaced by the context hook.
 */
export interface RelationSnippet {
  sourceTitle: string;
  targetTitle: string;
  relationType: string;
}

/**
 * Resolve surfaced display paths back to document ids so the relation query
 * can filter memory_relations edges to the surfaced set. Silently drops paths
 * that don't match an active row in the general vault (e.g. skill-vault paths
 * or deactivated docs) — fail-open, never throws.
 */
export function lookupSurfacedDocIds(
  store: Store,
  displayPaths: string[]
): number[] {
  if (displayPaths.length === 0) return [];
  try {
    const placeholders = displayPaths.map(() => "?").join(",");
    const rows = store.db
      .prepare(
        `SELECT id FROM documents
         WHERE active = 1
           AND (collection || '/' || path) IN (${placeholders})`
      )
      .all(...displayPaths) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * Fetch relationship snippets for edges where BOTH endpoints are in the
 * surfaced doc set. Returns an empty list on empty input, zero/one surfaced
 * docs, self-loops, or any DB error (fail-open, never throws). Results are
 * ordered by relation weight DESC then recency so the most salient edges
 * survive budget truncation.
 */
export function fetchRelationSnippets(
  store: Store,
  surfacedDocIds: number[],
  limit: number = MAX_RELATION_SNIPPETS
): RelationSnippet[] {
  if (surfacedDocIds.length < 2) return [];
  try {
    const placeholders = surfacedDocIds.map(() => "?").join(",");
    const rows = store.db
      .prepare(
        `SELECT mr.relation_type,
                ds.title AS source_title,
                dt.title AS target_title
         FROM memory_relations mr
         JOIN documents ds ON ds.id = mr.source_id AND ds.active = 1
         JOIN documents dt ON dt.id = mr.target_id AND dt.active = 1
         WHERE mr.source_id IN (${placeholders})
           AND mr.target_id IN (${placeholders})
           AND mr.source_id != mr.target_id
         ORDER BY mr.weight DESC, mr.created_at DESC
         LIMIT ?`
      )
      .all(...surfacedDocIds, ...surfacedDocIds, limit) as Array<{
      relation_type: string;
      source_title: string;
      target_title: string;
    }>;
    return rows.map((r) => ({
      sourceTitle: r.source_title,
      targetTitle: r.target_title,
      relationType: r.relation_type,
    }));
  } catch {
    return [];
  }
}

/**
 * Render relationship snippets as bullet lines, sanitizing titles to block
 * prompt-injection via metadata fields. Lines that become filtered-content
 * markers after sanitization are dropped.
 */
export function renderRelationshipLines(
  relations: RelationSnippet[]
): string[] {
  const FILTERED = "[content filtered for security]";
  const out: string[] = [];
  for (const r of relations) {
    const src = sanitizeSnippet(r.sourceTitle);
    const tgt = sanitizeSnippet(r.targetTitle);
    if (src === FILTERED || tgt === FILTERED) continue;
    out.push(`- ${src} --[${r.relationType}]--> ${tgt}`);
  }
  return out;
}

/**
 * Assemble the inner body of <vault-context>: always instruction + facts,
 * optionally relationships when at least one line fits in the remaining
 * budget. Relationships are the first thing dropped — if the relationships
 * XML wrapper alone would exceed `remainingBudgetTokens`, the whole block
 * is omitted rather than emitting an empty wrapper.
 */
export function buildVaultContextInner(
  factsBlock: string,
  relations: RelationSnippet[],
  remainingBudgetTokens: number
): string {
  const lines: string[] = [];
  lines.push(INSTRUCTION_XML);
  lines.push(`<facts>\n${factsBlock}\n</facts>`);

  if (relations.length === 0 || remainingBudgetTokens <= 0) {
    return lines.join("\n");
  }

  const relationLines = renderRelationshipLines(relations);
  if (relationLines.length === 0) return lines.join("\n");

  // The XML wrapper itself consumes tokens — if there's no room for even one
  // line on top of the wrapper, drop the block entirely.
  const fittedLines: string[] = [];
  let used = RELATIONSHIPS_XML_OVERHEAD_TOKENS;
  for (const line of relationLines) {
    const lineTokens = estimateTokens(line + "\n");
    if (used + lineTokens > remainingBudgetTokens) break;
    fittedLines.push(line);
    used += lineTokens;
  }
  if (fittedLines.length === 0) return lines.join("\n");

  lines.push(`<relationships>\n${fittedLines.join("\n")}\n</relationships>`);
  return lines.join("\n");
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
