/**
 * Contradiction-aware merge gate (Ext 2).
 *
 * LLM-first contradiction check with heuristic fallback. Returns a
 * structured `ContradictionResult` that downstream merge code uses to
 * decide whether to merge, supersede, or link two observations.
 *
 * Flow:
 *   1. `llmContradictionCheck`  — structured LLM classification; returns
 *      null on LLM cooldown, network failure, malformed JSON, or missing
 *      `contradictory` field.
 *   2. `heuristicContradictionCheck` — deterministic signal on
 *      negation asymmetry or number/date mismatch. Used as fallback when
 *      the LLM path returns null.
 *   3. `checkContradiction` — orchestrator. Runs LLM first, falls back
 *      to heuristic on null. Never throws. Always returns a usable
 *      `ContradictionResult`.
 *
 * Adapted from Thoth `tools/memory_tool.py:111-184` contradiction-check
 * pattern (THOTH_EXTRACTION_PLAN.md Extraction 2).
 *
 * Reuses the A-MEM convention relation type `'contradicts'` (plural) —
 * see P0 taxonomy guard at `tests/unit/contradict-taxonomy.test.ts`.
 */

import type { LLM } from "./llm.ts";
import { extractJsonFromLLM } from "./amem.ts";

// =============================================================================
// Types
// =============================================================================

export type ContradictionSource = "llm" | "heuristic" | "unknown";

export interface ContradictionResult {
  contradictory: boolean;
  confidence: number; // 0.0 - 1.0
  reason?: string;
  source: ContradictionSource;
}

/**
 * Phase-2 contradiction handling policy. `link` (default) preserves
 * both rows as active and sets `invalidated_by` as a backlink for
 * operator queries. `supersede` additionally sets `invalidated_at` on
 * the old row so it stops surfacing in active recalls.
 */
export type ContradictionPolicy = "link" | "supersede";

export function resolveContradictionPolicy(): ContradictionPolicy {
  const raw = process.env.CLAWMEM_CONTRADICTION_POLICY;
  if (raw === "supersede") return "supersede";
  return "link"; // default
}

/**
 * Minimum LLM contradiction confidence to act on. Lower scores are
 * treated as inconclusive and the merge proceeds (conservative: only
 * block merges on clear contradictions). Overridable via
 * `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE` env var (0.0 - 1.0).
 */
export const CONTRADICTION_MIN_CONFIDENCE = parseEnvFloat(
  "CLAWMEM_CONTRADICTION_MIN_CONFIDENCE",
  0.5
);

function parseEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

// =============================================================================
// Heuristic contradiction detection (deterministic, no LLM)
// =============================================================================

/**
 * Deterministic heuristic contradiction check.
 *
 * Signals:
 *  - **Negation asymmetry:** one side has an explicit negation token
 *    (`not`, `never`, `no`, `didn't`, etc.) and the other doesn't.
 *  - **Number/date mismatch:** both sides cite numbers or dates but the
 *    sets have no shared values.
 *
 * Intentionally conservative: returns `contradictory=false,
 * confidence=0` when no signal is found, leaving the decision to the
 * LLM or the caller's default.
 */
export function heuristicContradictionCheck(
  a: string,
  b: string
): ContradictionResult {
  const negA = hasNegation(a);
  const negB = hasNegation(b);

  // Negation asymmetry: one side explicitly negates, the other doesn't
  if (negA !== negB) {
    return {
      contradictory: true,
      confidence: 0.6,
      reason: "negation asymmetry — one statement has explicit negation",
      source: "heuristic",
    };
  }

  const numsA = extractNumbers(a);
  const numsB = extractNumbers(b);

  // Number/date mismatch: both cite numbers but no shared values
  if (numsA.length > 0 && numsB.length > 0) {
    const setA = new Set(numsA);
    const setB = new Set(numsB);
    const shared = [...setA].filter((n) => setB.has(n));
    if (shared.length === 0) {
      return {
        contradictory: true,
        confidence: 0.5,
        reason: `number/date mismatch (A=${numsA.join(",")} B=${numsB.join(",")})`,
        source: "heuristic",
      };
    }
  }

  // No heuristic signal
  return {
    contradictory: false,
    confidence: 0.0,
    reason: "no heuristic signal",
    source: "heuristic",
  };
}

/**
 * Extract standalone integers, decimals, and ISO-ish dates from a
 * string as a normalized set of numeric tokens.
 */
function extractNumbers(s: string): string[] {
  // Matches: integers, decimals (1.5, 1,000), ISO dates (2026-04-10),
  // US dates (04/10/2026), version strings (v0.7.1 → 0.7.1)
  const matches = s.match(/\b\d{1,5}(?:[.,/-]\d{1,5}){0,2}\b/g) || [];
  return matches.map((m) => m.replace(/,/g, ""));
}

/**
 * Return true if the string contains an explicit negation token.
 * Matches English contractions (didn't, won't, cannot, etc.) plus
 * bare negations (not, never, no).
 */
function hasNegation(s: string): boolean {
  return /\b(not|never|no|don['\u2019]t|didn['\u2019]t|won['\u2019]t|cannot|can['\u2019]t|wasn['\u2019]t|isn['\u2019]t|aren['\u2019]t|weren['\u2019]t|shouldn['\u2019]t|couldn['\u2019]t|wouldn['\u2019]t)\b/i.test(
    s
  );
}

// =============================================================================
// LLM-based contradiction detection
// =============================================================================

const CONTRADICTION_PROMPT_TEMPLATE = `You are a logic checker. Determine whether two statements contradict each other.

Statement A: {A}

Statement B: {B}{CONTEXT}

A contradiction exists if one statement directly denies the other, or if both cannot be true at the same time. Subtle differences in specificity (e.g. "Bob" vs "Bob Smith") are NOT contradictions. Different dates, counts, outcomes, or decisions on the same subject ARE contradictions.

Respond with ONLY a JSON object:
{"contradictory": true|false, "confidence": 0.0-1.0, "reason": "brief explanation"}

Do not include any other text. /no_think`;

/**
 * LLM-based contradiction classifier.
 *
 * Returns `null` on any of:
 *  - LLM generate call throws
 *  - LLM returns null (cooldown, timeout, remote LLM down)
 *  - LLM returns text but JSON extraction fails
 *  - Parsed JSON is missing a boolean `contradictory` field
 *
 * Callers should fall back to the heuristic path on null.
 */
export async function llmContradictionCheck(
  llm: LLM,
  a: string,
  b: string,
  context?: string
): Promise<ContradictionResult | null> {
  const prompt = CONTRADICTION_PROMPT_TEMPLATE.replace("{A}", a)
    .replace("{B}", b)
    .replace("{CONTEXT}", context ? `\n\nContext:\n${context}` : "");

  let result;
  try {
    result = await llm.generate(prompt, { temperature: 0.2, maxTokens: 150 });
  } catch {
    return null;
  }

  if (!result?.text) return null;

  const parsed = extractJsonFromLLM(result.text) as {
    contradictory?: unknown;
    confidence?: unknown;
    reason?: unknown;
  } | null;

  if (!parsed || typeof parsed.contradictory !== "boolean") return null;

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

  return {
    contradictory: parsed.contradictory,
    confidence,
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    source: "llm",
  };
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Orchestrated contradiction check.
 *
 * 1. Try LLM path; if it returns a usable result, use it.
 * 2. Otherwise fall back to the deterministic heuristic.
 *
 * Never throws. Always returns a `ContradictionResult`. When the
 * result's `source` is `heuristic` and `contradictory=false`, the
 * caller knows the check is inconclusive and should proceed with the
 * default merge path.
 */
export async function checkContradiction(
  llm: LLM,
  a: string,
  b: string,
  context?: string
): Promise<ContradictionResult> {
  const llmResult = await llmContradictionCheck(llm, a, b, context);
  if (llmResult) return llmResult;
  return heuristicContradictionCheck(a, b);
}

/**
 * Apply the `CONTRADICTION_MIN_CONFIDENCE` threshold to a
 * `ContradictionResult` — returns true iff the result claims a
 * contradiction AND meets the confidence floor.
 *
 * Callers use this to decide whether to block a merge. Keeping the
 * threshold check centralized means operators can tune via env var
 * without touching the merge code.
 */
export function isActionableContradiction(result: ContradictionResult): boolean {
  return (
    result.contradictory === true &&
    result.confidence >= CONTRADICTION_MIN_CONFIDENCE
  );
}
