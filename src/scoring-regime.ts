/**
 * Centralized scoring-regime selection for the MCP direct retrieval routes
 * (vector routes v0.22.0; FTS `search` route v0.24.0).
 *
 * Two regimes:
 *
 *   "raw"               — non-recency queries on the evidenced raw routes (`vsearch`,
 *                         `memory_retrieve` semantic/discovery, `search`): results rank
 *                         by the RAW channel score DESC — vector cosine on the vector
 *                         routes (scoreBasis "vector-cosine"), the monotonic BM25
 *                         transform on the FTS route (scoreBasis "fts-bm25"). Document
 *                         metadata — including pin — participates ONLY inside groups of
 *                         exactly-equal raw scores. Raw scores are channel-specific and
 *                         not comparable to composite scores or across channels.
 *
 *   "recency-composite" — hasRecencyIntent(query): the pre-v0.22.0 composite behavior,
 *                         unchanged (RECENCY_WEIGHTS blend, multipliers, pin boost,
 *                         contentType priority sort, composite-scale minScore default).
 *
 * Measured basis (BACKLOG Source 48): raw cosine ranked 16/19 judged targets #1
 * (MRR 0.912) where the composite stack ranked 1/19 (MRR 0.307) and filtered 14/19
 * below the old composite minScore — every metadata signal large enough to matter is
 * larger than the 0.03–0.10 raw margins that separate right answers from wrong ones,
 * so metadata may only ever break exact raw-score ties on these routes.
 * FTS basis (BACKLOG Source 49.2, judged keyword eval 2026-07-11): raw-FTS-primary
 * MRR 0.848 vs shipped composite 0.415 over 43 judged targets (held-out 0.875 vs
 * 0.335, composite hit@1 0/20) — composite lost even on the composite-favorable
 * fresh-among-many shape (0.348 vs 0.801).
 */
import {
  applyCompositeScoring,
  hasRecencyIntent,
  type EnrichedResult,
  type ScoredResult,
  type CoActivationFn,
  type CompositeScoringOptions,
} from "./memory.ts";

/** Reported score basis for raw-regime results on the vector routes: raw cosine. */
export const VECTOR_SCORE_BASIS = "vector-cosine" as const;
/** Reported score basis for raw-regime results on the FTS route (v0.24.0): the
 *  monotonic |bm25|/(1+|bm25|) transform. */
export const FTS_SCORE_BASIS = "fts-bm25" as const;
/** Reported score basis for composite-scored results. */
export const COMPOSITE_SCORE_BASIS = "composite" as const;

export type ScoringRegime = "raw" | "recency-composite";

/** One switch point for the raw-route regime decision (design R4). */
export function selectScoringRegime(query: string): ScoringRegime {
  return hasRecencyIntent(query) ? "recency-composite" : "raw";
}

/**
 * Raw-primary ranking (design R1/R2): raw channel score DESC; within a group of
 * exactly-equal raw scores the deterministic tie order is pinned DESC, then legacy
 * composite DESC, then displayPath ASC. `compositeScore` on the returned rows carries
 * the RAW score — vector cosine on the vector routes, the monotonic BM25 transform on
 * the FTS route. Exact transformed-score ties are legitimate relevance-equivalent
 * groups on both channels.
 *
 * Callers gate on selectScoringRegime() first — this ranker is only meaningful for
 * non-recency queries (the legacy composite computed here for tie keys therefore never
 * takes the RECENCY_WEIGHTS branch). Inputs are document-unique on these routes
 * (searchVecDetailed and searchFTS both hydrate one row per document).
 *
 * `options.now` flows to the tie-key composite so frozen-clock evaluation (the v0.22.0
 * acceptance bundle) is bit-reproducible.
 */
export function rankRawPrimary(
  results: EnrichedResult[],
  query: string,
  coActivationFn?: CoActivationFn,
  options?: CompositeScoringOptions
): ScoredResult[] {
  const legacy = applyCompositeScoring(results, query, coActivationFn, options);
  const legacyByPath = new Map(legacy.map(s => [s.filepath, s]));
  const ranked = results.map(r => {
    const l = legacyByPath.get(r.filepath) ?? ({ ...r, compositeScore: r.score, recencyScore: 0 } as ScoredResult);
    return { row: { ...l, compositeScore: r.score } as ScoredResult, legacyComposite: l.compositeScore };
  });
  ranked.sort((a, b) => {
    if (b.row.compositeScore !== a.row.compositeScore) return b.row.compositeScore - a.row.compositeScore;
    const pinDelta = (b.row.pinned ? 1 : 0) - (a.row.pinned ? 1 : 0);
    if (pinDelta !== 0) return pinDelta;
    if (b.legacyComposite !== a.legacyComposite) return b.legacyComposite - a.legacyComposite;
    return a.row.displayPath < b.row.displayPath ? -1 : a.row.displayPath > b.row.displayPath ? 1 : 0;
  });
  return ranked.map(r => r.row);
}
