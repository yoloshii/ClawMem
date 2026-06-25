/**
 * ClawMem Search Utilities — Shared enrichment and fusion functions
 *
 * Consolidates duplicated code from clawmem.ts, mcp.ts, and context-surfacing.ts.
 */

import type { Store, SearchResult } from "./store.ts";
import type { EnrichedResult } from "./memory.ts";

// =============================================================================
// Result Enrichment
// =============================================================================

/**
 * Join search results with SAME metadata from the documents table.
 * Adds content_type, modified_at, access_count, confidence to each result.
 */
export function enrichResults(
  store: Store,
  results: SearchResult[],
  _query: string
): EnrichedResult[] {
  return results.map(r => {
    const row = store.db.prepare(`
      SELECT content_type, modified_at, access_count, confidence, domain, workstream, tags,
             quality_score, pinned, last_accessed_at, duplicate_count, revision_count
      FROM documents
      WHERE active = 1 AND (collection || '/' || path) = ?
      LIMIT 1
    `).get(r.displayPath) as any | null;

    return {
      ...r,
      contentType: row?.content_type ?? "note",
      modifiedAt: row?.modified_at ?? r.modifiedAt,
      accessCount: row?.access_count ?? 0,
      confidence: row?.confidence ?? 0.5,
      qualityScore: row?.quality_score ?? 0.5,
      pinned: !!(row?.pinned),
      lastAccessedAt: row?.last_accessed_at ?? null,
      duplicateCount: row?.duplicate_count ?? 1,
      revisionCount: row?.revision_count ?? 1,
    } as EnrichedResult;
  });
}

// =============================================================================
// Ranked Result Type (for RRF)
// =============================================================================

export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
};

// =============================================================================
// Reciprocal Rank Fusion
// =============================================================================

/**
 * Merge multiple ranked result lists using Reciprocal Rank Fusion.
 * k=60 is the standard RRF constant. Top-rank bonuses reward results
 * that appear at rank 0 (+0.05) or rank 1-2 (+0.02).
 */
export function reciprocalRankFusion(
  resultLists: RankedResult[][],
  weights: number[],
  k: number = 60
): RankedResult[] {
  // Validate weights match result lists when explicitly provided
  if (weights.length > 0 && weights.length !== resultLists.length) {
    throw new Error(
      `weights length (${weights.length}) must match resultLists length (${resultLists.length})`
    );
  }

  // Validate k is finite and positive
  if (!Number.isFinite(k) || k <= 0) k = 60;

  // Validate all weights are finite and non-negative
  for (let w = 0; w < weights.length; w++) {
    if (!Number.isFinite(weights[w]) || weights[w]! < 0) {
      weights[w] = 1;
    }
  }

  const scores = new Map<string, { score: number; result: RankedResult }>();

  for (let i = 0; i < resultLists.length; i++) {
    const list = resultLists[i]!;
    const weight = weights[i] ?? 1;
    if (weight === 0) continue; // Skip zero-weight lists entirely
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank]!;
      const existing = scores.get(r.file);
      const rrfScore = weight / (k + rank + 1);
      const bonus = rank === 0 ? 0.05 : rank <= 2 ? 0.02 : 0;
      const total = rrfScore + bonus;

      if (existing) {
        existing.score += total;
      } else {
        scores.set(r.file, { score: total, result: r });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(v => ({ ...v.result, score: v.score }));
}

// =============================================================================
// Rerank / RRF Score Blend
// =============================================================================

/**
 * Blend a cross-encoder reranker's scores with the upstream RRF ranking.
 *
 * The reranker is the dominant relevance signal; normalized RRF contributes a thin tiebreaker.
 * An earlier blend used `w·(1/rrfRank)` with `w≥0.75` on the top tier, which made RRF rank-1
 * mathematically immovable by the reranker (0.75·(1/1) exceeds any rank-2 ceiling) — the
 * reranker could never promote the best document to the top. This blend normalizes the RRF
 * score to [0,1] and gives the reranker the dominant weight, so a strong rerank score CAN
 * promote a doc over RRF #1. Harness-validated 2026-06-25 against NL+KW known-item recall:
 * lifts recall@1-5 and MRR@10 with no material pooled recall@10 regression.
 *
 * Falls back to pure RRF order when the reranker is unavailable or returned no usable signal
 * (empty, or all-zero — e.g. a total remote+local failure). Maps over `candidates` (not the
 * rerank output) so partial rerank coverage can never drop a candidate; an unscored doc takes
 * rerank score 0 (so it sorts on its thin `(1-rerankWeight)·rrfNorm` term) and unscored docs
 * preserve their relative RRF order among themselves.
 *
 * @param candidates - RRF-ordered candidates; `score` is the RRF fusion score (positive).
 * @param reranked - reranker output `{file, score in [0,1]}`; may be empty/partial/all-zero.
 * @param rerankWeight - weight on the reranker term (default 0.9; `1-rerankWeight` on RRF).
 * @returns candidates re-scored and sorted by blended score descending.
 */
export function blendRerank(
  candidates: { file: string; score: number }[],
  reranked: { file: string; score: number }[],
  rerankWeight: number = 0.9
): { file: string; score: number }[] {
  const rerankScoreMap = new Map(reranked.map(r => [r.file, r.score]));
  const rerankUsable = reranked.length > 0 && reranked.some(r => Number.isFinite(r.score) && r.score > 0);
  const maxRrf = candidates.reduce((m, c) => Math.max(m, c.score), 0) || 1;
  return candidates
    .map(c => {
      const rrfNorm = c.score / maxRrf; // [0,1]
      if (!rerankUsable) return { file: c.file, score: rrfNorm };
      const rr = rerankScoreMap.get(c.file);
      const rerankScore = Number.isFinite(rr) ? (rr as number) : 0;
      return { file: c.file, score: (1 - rerankWeight) * rrfNorm + rerankWeight * rerankScore };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Convert a SearchResult to a RankedResult for use in RRF.
 */
export function toRanked(r: SearchResult): RankedResult {
  return {
    file: r.filepath,
    displayPath: r.displayPath,
    title: r.title,
    body: r.body || "",
    score: r.score,
  };
}
