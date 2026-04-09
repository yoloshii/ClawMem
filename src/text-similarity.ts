/**
 * Text similarity + merge safety gate for consolidation.
 *
 * Prevents semantic collision between topics that share vocabulary but
 * refer to different subjects (e.g., two observations about "Dan" vs
 * "Dad" or "Bob" vs "Rob"). Adds a dual-threshold safety check after
 * the cheap Jaccard candidate-generation step.
 *
 * Entity-aware first: uses `entity_mentions` when both sides have canonical
 * entities resolved. Lexical fallback via proper-noun anchor regex when
 * either side lacks entity state. Strictest default when both sides are
 * empty (no anchors at all).
 *
 * Adapted from Thoth `dream_cycle.py:218-272` subject-name guard
 * (THOTH_EXTRACTION_PLAN.md Extraction 3).
 */

import type { Store } from "./store.ts";

// =============================================================================
// Config — dual-threshold merge safety
// =============================================================================

/**
 * NORMAL threshold: applies when anchor sets are compatible (subset or
 * high overlap — same primary subject) AND the gate is gating on text
 * similarity alone. Overridable via `CLAWMEM_MERGE_SCORE_NORMAL` env var
 * for operator calibration during rollout.
 *
 * ⚠ Threshold is inherited from Thoth's `dream_cycle.py:218-272` guard,
 * which uses Python's `difflib.SequenceMatcher` (character-level LCS).
 * ClawMem uses normalized character 3-gram cosine, which is systematically
 * harsher on benign rephrasings (word-order changes, synonym swaps). A
 * same-meaning paraphrase like "The team migrated auth to OAuth2 last
 * Friday" vs "Last Friday the team completed the auth migration to
 * OAuth2" lands around 0.5 in 3-gram cosine but near 0.85 in
 * SequenceMatcher. Consequence: merges will fragment more than Thoth
 * did. This is the SAFE trade-off — fragmentation > false merges — but
 * operators should tune via env var once they have real data.
 */
export const MERGE_SCORE_NORMAL = parseEnvFloat(
  "CLAWMEM_MERGE_SCORE_NORMAL",
  0.93
);

/**
 * STRICT threshold: applies in the strictest-default path (both sides
 * have zero anchors — no canonical entities, no proper-noun anchors).
 * Overridable via `CLAWMEM_MERGE_SCORE_STRICT`.
 *
 * Non-strictest-default paths use the hard-reject rule on materially
 * different anchors, not this threshold.
 */
export const MERGE_SCORE_STRICT = parseEnvFloat(
  "CLAWMEM_MERGE_SCORE_STRICT",
  0.98
);

function parseEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

// =============================================================================
// Anchor extraction (entity-first, lexical fallback)
// =============================================================================

export type AnchorSource = "entity_mentions" | "lexical_fallback";

export interface ExtractedAnchors {
  entities: string[];
  method: AnchorSource;
}

/**
 * Get canonical entity IDs referenced by a set of source documents.
 * Returns `{ entities: [], method: 'lexical_fallback' }` when no entity
 * mentions exist for any of the given docs — the caller should then
 * fall back to lexical anchor extraction over the raw text.
 */
export function extractSourceDocEntities(
  store: Store,
  sourceDocIds: number[]
): ExtractedAnchors {
  if (sourceDocIds.length === 0) {
    return { entities: [], method: "lexical_fallback" };
  }

  const placeholders = sourceDocIds.map(() => "?").join(",");
  let rows: { entity_id: string }[];
  try {
    rows = store.db
      .prepare(
        `SELECT DISTINCT entity_id FROM entity_mentions WHERE doc_id IN (${placeholders})`
      )
      .all(...sourceDocIds) as { entity_id: string }[];
  } catch {
    return { entities: [], method: "lexical_fallback" };
  }

  if (rows.length === 0) {
    return { entities: [], method: "lexical_fallback" };
  }

  return {
    entities: rows.map((r) => r.entity_id),
    method: "entity_mentions",
  };
}

/**
 * Extract lexical subject anchors from raw text.
 *
 * Heuristic: capitalized tokens that are not common sentence-start words.
 * This is the fallback when `entity_mentions` is empty (the doc has not
 * been through entity enrichment yet, or is from the pre-entity era).
 */
export function extractSubjectAnchorsLexical(text: string): string[] {
  if (!text) return [];

  // Match capitalized tokens: CamelCase, UPPERCASE, Capitalized.
  // Minimum 2 chars to avoid matching stray initials at sentence start.
  const matches = text.match(/\b[A-Z][a-zA-Z0-9]{1,}\b/g) || [];

  // Filter common sentence-start capitalized words that aren't proper nouns
  const stopwords = new Set<string>([
    "the", "a", "an", "this", "that", "these", "those",
    "it", "we", "i", "he", "she", "they", "you", "me", "him", "her", "us", "them",
    "and", "but", "or", "not", "is", "was", "are", "were",
    "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "should", "could", "can",
    "may", "might", "must", "shall",
    "in", "on", "at", "to", "for", "of", "with", "by", "from",
    "if", "then", "else", "when", "while", "where", "how", "why",
    "all", "any", "some", "no", "one", "two",
  ]);

  const normalized = new Set<string>();
  for (const token of matches) {
    const lower = token.toLowerCase();
    if (lower.length >= 2 && !stopwords.has(lower)) {
      normalized.add(lower);
    }
  }

  return [...normalized];
}

// =============================================================================
// Normalized character 3-gram cosine similarity
// =============================================================================

/**
 * Character 3-gram cosine similarity.
 *
 * Robust to word-level permutation and punctuation; catches near-duplicate
 * statements that differ only in wording or whitespace. Returns 0.0..1.0.
 *
 * Chosen over Jaccard (used as the cheap first-stage filter) because
 * 3-gram cosine is tighter on paraphrase detection — it distinguishes
 * "Dan visited Paris" from "Dad visited Paris" while the Jaccard over
 * long-word sets would treat both as near-duplicates.
 */
export function normalizedCosine3Gram(a: string, b: string): number {
  const na = normalizeForTrigram(a);
  const nb = normalizeForTrigram(b);

  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1.0;

  const ta = trigramCounts(na);
  const tb = trigramCounts(nb);

  let dot = 0;
  for (const [gram, count] of ta) {
    const other = tb.get(gram);
    if (other) dot += count * other;
  }

  const ma = magnitude(ta);
  const mb = magnitude(tb);
  if (ma === 0 || mb === 0) return 0;

  return dot / (ma * mb);
}

function normalizeForTrigram(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigramCounts(s: string): Map<string, number> {
  const out = new Map<string, number>();
  if (s.length < 3) {
    out.set(s, 1);
    return out;
  }
  for (let i = 0; i <= s.length - 3; i++) {
    const gram = s.slice(i, i + 3);
    out.set(gram, (out.get(gram) || 0) + 1);
  }
  return out;
}

function magnitude(m: Map<string, number>): number {
  let sum = 0;
  for (const v of m.values()) sum += v * v;
  return Math.sqrt(sum);
}

// =============================================================================
// Anchor set comparison
// =============================================================================

/**
 * Determine whether two anchor sets "materially differ".
 *
 * Rules (all case-insensitive):
 *  1. Either side empty → NOT materially different (caller handles via
 *     strictest-default path).
 *  2. One set is a subset of the other → NOT materially different
 *     (allows `"Bob"` ↔ `"Bob Smith"`).
 *  3. Intersection empty → materially different (`"Dan"` vs `"Dad"`).
 *  4. Partial overlap → materially different when AT MOST half of the
 *     smaller set is shared (boundary `≤ 0.5` treated as material to
 *     fence off primary-subject mismatches like
 *     `[alice, auth-service]` vs `[bob, auth-service]` where the only
 *     shared anchor is the context, not the subject).
 */
export function anchorSetsMateriallyDiffer(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const setA = new Set(a.map((x) => x.toLowerCase()));
  const setB = new Set(b.map((x) => x.toLowerCase()));

  const aSubB = [...setA].every((x) => setB.has(x));
  const bSubA = [...setB].every((x) => setA.has(x));
  if (aSubB || bSubA) return false;

  const intersect = [...setA].filter((x) => setB.has(x));
  if (intersect.length === 0) return true;

  const smaller = Math.min(setA.size, setB.size);
  return intersect.length / smaller <= 0.5;
}

// =============================================================================
// Merge safety gate
// =============================================================================

export type MergeSafetyMethod = "entity_aware" | "lexical_only" | "strictest_default";

export interface MergeSafetyResult {
  accepted: boolean;
  score: number;
  threshold: number;
  reason: string;
  method: MergeSafetyMethod;
}

/**
 * Merge safety gate.
 *
 * Flow:
 *  1. Compute normalized character 3-gram cosine similarity between the
 *     candidate and existing observation texts.
 *  2. Extract anchor sets for both sides. Entity-aware first
 *     (`entity_mentions`), lexical fallback otherwise. If EITHER side
 *     lacks `entity_mentions` coverage, both sides fall back to lexical
 *     so the comparison is apples-to-apples.
 *  3. Decide:
 *      - Both anchor sets empty (strictest default) → accept iff
 *        `score >= MERGE_SCORE_STRICT`.
 *      - Anchors materially differ → **HARD REJECT regardless of text
 *        similarity**. This is the primary safety goal: two observations
 *        whose canonical subjects differ are never the same observation,
 *        even if the LLM emits identical wording. Historically the gate
 *        upgraded to a stricter threshold instead of hard-rejecting, but
 *        that allowed merges at score 1.0 when the LLM emitted templated
 *        text with no subject name.
 *      - Anchors compatible (subset or high overlap) → accept iff
 *        `score >= MERGE_SCORE_NORMAL`.
 */
export function passesMergeSafety(
  store: Store,
  candidateText: string,
  candidateSourceDocIds: number[],
  existingText: string,
  existingSourceDocIds: number[]
): MergeSafetyResult {
  const score = normalizedCosine3Gram(candidateText, existingText);

  const candEnt = extractSourceDocEntities(store, candidateSourceDocIds);
  const existEnt = extractSourceDocEntities(store, existingSourceDocIds);

  // Use entity-aware path only when BOTH sides have entity mentions —
  // otherwise the comparison is apples-to-oranges (one side is a set of
  // canonical IDs, the other is a set of lexical tokens).
  const bothEntity =
    candEnt.method === "entity_mentions" && existEnt.method === "entity_mentions";

  let anchorsA: string[];
  let anchorsB: string[];
  let method: MergeSafetyMethod;

  if (bothEntity) {
    anchorsA = candEnt.entities;
    anchorsB = existEnt.entities;
    method = "entity_aware";
  } else {
    anchorsA = extractSubjectAnchorsLexical(candidateText);
    anchorsB = extractSubjectAnchorsLexical(existingText);
    method = "lexical_only";
  }

  // Strictest default: both sides empty → no subject signal at all
  if (anchorsA.length === 0 && anchorsB.length === 0) {
    const threshold = MERGE_SCORE_STRICT;
    const accepted = score >= threshold;
    return {
      accepted,
      score,
      threshold,
      reason: accepted
        ? `strictest-default met (${score.toFixed(3)} >= ${threshold})`
        : `strictest-default unmet (${score.toFixed(3)} < ${threshold})`,
      method: "strictest_default",
    };
  }

  // Hard reject on materially different anchors — this is the primary
  // safety goal of the extraction. Applies to BOTH entity_aware and
  // lexical_only modes so the policy is uniform.
  if (anchorSetsMateriallyDiffer(anchorsA, anchorsB)) {
    return {
      accepted: false,
      score,
      // Reported threshold is STRICT only for operator logging; the
      // decision was hard-reject, not threshold-gated.
      threshold: MERGE_SCORE_STRICT,
      reason: `${method} materially different anchors — hard reject (score=${score.toFixed(3)})`,
      method,
    };
  }

  // Compatible anchors (subset or high overlap): gate on text similarity
  const threshold = MERGE_SCORE_NORMAL;
  const accepted = score >= threshold;
  return {
    accepted,
    score,
    threshold,
    reason: accepted
      ? `${method} aligned anchors — ${score.toFixed(3)} >= ${threshold}`
      : `${method} aligned anchors — ${score.toFixed(3)} < ${threshold}`,
    method,
  };
}
