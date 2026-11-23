/**
 * Relation weights are bounded to [0, 1] (62.1 D7, CM-19).
 *
 * `insertRelation` used to upsert `weight = weight + excluded.weight`, so a pair re-recorded on every Stop grew
 * without bound (a live vault held usage edges near 9,000). Writers now clamp their input and keep the larger of
 * the stored and the new weight; every reader clamps on read as well, because rows written before the fix keep
 * their inflated values until the counter repair rebuilds them.
 */

/** The bounded weight a writer may store: non-finite → 1.0, below 0 → 0, above 1 → 1. */
export function clampRelationWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 1.0;
  if (weight < 0) return 0;
  if (weight > 1) return 1;
  return weight;
}

/**
 * SQL for a relation row's weight as readers must see it: NULL → 0, clamped to [0, 1]. Use it in the SELECT list
 * AND in any ORDER BY, so ranking and scoring read the same bounded value.
 */
export function relWeightSql(alias: string): string {
  return `MIN(1.0, MAX(0.0, COALESCE(${alias}.weight, 0.0)))`;
}

/**
 * 82.2 (D5): a similarity relation's weight is a cosine similarity. The stored value is VALID when it is a finite
 * number inside [-1 - 1e-4, 1 + 1e-4] — the range of a cosine similarity with the tolerance of the distance
 * predicate. A little above 1 is ordinary numerical overshoot (two healthy collinear vectors were stored as
 * 1.000000002048 before v0.43.7); a negative value inside the range is two healthy vectors that point apart.
 */
export const SIMILARITY_WEIGHT_TOLERANCE = 1e-4;
export function validSimilarityWeight(weight: unknown): weight is number {
  return typeof weight === "number" && Number.isFinite(weight)
    && weight >= -1 - SIMILARITY_WEIGHT_TOLERANCE && weight <= 1 + SIMILARITY_WEIGHT_TOLERANCE;
}

/** A similarity threshold outside its documented domain [0, 1] (82.2, D5): a typed input error, nothing is built. */
export class SemanticThresholdError extends Error {
  constructor(public readonly threshold: unknown) {
    super(`semantic threshold must be a number in [0, 1] (got ${String(threshold)})`);
    this.name = "SemanticThresholdError";
  }
}
export function assertSemanticThreshold(threshold: unknown): asserts threshold is number {
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new SemanticThresholdError(threshold);
  }
}
