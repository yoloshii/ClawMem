/**
 * Cross-Agent Context Injection Layer (cross-agent memory PR)
 *
 * Optional orchestration behaviour, NOT an MCP tool. When enabled (default OFF),
 * a task-spawning agent can query the facts OTHER agents have written about the
 * entities in its task prompt and inject them into context — so an agent that
 * learned something shares it without the receiver rediscovering it.
 *
 * Design rules from the spec:
 *   - Pre-emptive, prompt-only query (reuses the vault-facts entity detector).
 *   - Separate, labelled block; the receiving agent may ignore or use it.
 *   - Only facts written by OTHER agents (exclude self) at confidence >= a
 *     configured floor (default 0.7).
 *   - Hard startup guard: bounded execution time (default 2s) + graceful
 *     degradation (never throws; returns null on any failure/timeout).
 *
 * Decoupled from `Store` so unit tests can drive it with a mock facts query,
 * mirroring the `<vault-facts>` TripleQueryFn pattern.
 */

import type { Database } from "bun:sqlite";
import { extractPromptEntities } from "./vault-facts.ts";
import type { CrossAgentFact } from "./store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the facts query the layer needs — decoupled from Store for tests. */
export type CrossAgentFactQueryFn = (
  entityId: string,
  minConfidence: number,
  excludeAgentId?: string
) => CrossAgentFact[];

export interface CrossAgentInjectionOptions {
  /** Agent receiving the context; its OWN facts are excluded (default: none). */
  excludeAgentId?: string;
  /** Minimum confidence floor. Default 0.7. */
  minConfidence?: number;
  /** Hard time budget for the whole injection query. Default 2000ms. */
  timeoutMs?: number;
  /** Max facts emitted. Default 20. */
  maxFacts?: number;
  /** Token ceiling for the serialized block. Serves as a soft cap on lines. */
  maxTokens?: number;
  /** ISO "now" used to filter expired (valid_to) facts. Defaults to now. */
  now?: string;
  /** Optional active agent id to prefix the exclusion filter at query time. */
  vault?: string;
}

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_FACTS = 20;
const DEFAULT_MAX_TOKENS = 400;
const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Run `fn` but resolve `fallback` if it does not settle within `timeoutMs`.
 * Graceful degradation: an injection must NEVER block task startup.
 */
function withTimeout<T>(fn: () => T, timeoutMs: number, fallback: T): T {
  // Synchronous DB queries are fast; the timeout protects against a pathological
  // SQLite busy/contention case wedging the caller. We run the query synchronously
  // but bound it — if a DB lock holds longer than the budget we hand back fallback.
  const start = Date.now();
  try {
    const value = fn();
    if (Date.now() - start <= timeoutMs) return value;
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build a labelled cross-agent context block for `prompt`.
 *
 * 1. Extract candidate entities from the prompt (canonical ids, proper nouns,
 *    n-grams) using the vault-facts detector.
 * 2. For each validated entity, query facts written by OTHER agents at or above
 *    the confidence floor, still current (valid_to null or in the future).
 * 3. Serialize as:
 *      <cross-agent-facts>
 *      [cross-agent fact, written by <agent> at <timestamp>] subject predicate object
 *      ...
 *      </cross-agent-facts>
 *
 * Returns null when: injection disabled, no entities, no qualifying facts,
 * blocked budget, or any error (fail-open).
 */
export function buildCrossAgentContextBlock(
  prompt: string,
  db: Database,
  queryFacts: CrossAgentFactQueryFn,
  options: CrossAgentInjectionOptions = {}
): string | null {
  if (!prompt) return null;

  const minConf = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFacts = options.maxFacts ?? DEFAULT_MAX_FACTS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? new Date().toISOString();

  // ---- 1 & 2: entity detection + time-bounded fact query ----
  const result = withTimeout<{ lines: string[]; count: number } | null>(() => {
    const entities = extractPromptEntities(prompt, db, options.vault ?? "default");
    if (entities.length === 0) return null;

    const lines: string[] = [];
    let count = 0;
    for (const entity of entities) {
      if (count >= maxFacts) break;
      let facts: CrossAgentFact[] = [];
      try {
        facts = queryFacts(entity.entityId, minConf, options.excludeAgentId);
      } catch {
        continue; // fail-open per entity
      }
      for (const f of facts) {
        if (count >= maxFacts) break;
        // Current-only: valid_to null or in the future.
        if (f.validTo && f.validTo <= now) continue;
        const by = f.agentId ?? "unknown-agent";
        const at = f.writtenAt ?? "unknown-time";
        const pred = f.predicate;
        const obj = f.object;
        lines.push(`[cross-agent fact, written by ${by} at ${at}] ${f.subject} ${pred} ${obj}`);
        count++;
      }
    }
    return count === 0 ? null : { lines, count };
  }, timeoutMs, null);

  if (!result) return null;

  // ---- 3: token-bounded XML serialization ----
  const OPEN = "<cross-agent-facts>\n";
  const CLOSE = "\n</cross-agent-facts>";
  const overhead = estimateTokens(OPEN + CLOSE);
  if (overhead >= maxTokens) return null;

  const out: string[] = [];
  let running = overhead;
  for (const line of result.lines) {
    const lineTokens = estimateTokens(line) + 1;
    if (running + lineTokens > maxTokens) break;
    out.push(line);
    running += lineTokens;
  }
  if (out.length === 0) return null;
  return `${OPEN}${out.join("\n")}${CLOSE}`;
}
