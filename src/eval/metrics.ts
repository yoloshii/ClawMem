/**
 * Offline eval harness — pure doc-level metrics (HORMA-1).
 *
 * `E` = resolved gold document ids, `C` = the ordered retrieved document ids
 * from the replayed path. All metrics are SET-based over document identity
 * except MRR, which uses the deduped retrieval ORDER.
 */

import type { DocMetrics } from "./types.ts";

/**
 * Compute doc-level metrics for one example.
 * - jaccard  = |C∩E| / |C∪E|   (HORMA's evidence-overlap J at doc granularity)
 * - precision = |C∩E| / |C|
 * - recall    = |C∩E| / |E|
 * - hit       = 1 if any gold doc retrieved
 * - mrr       = 1 / rank of the first gold hit in the deduped retrieval order
 * Duplicate ids in `retrievedOrdered` are collapsed: they cannot inflate
 * precision's denominator or advance MRR rank.
 */
export function computeDocMetrics(retrievedOrdered: number[], gold: ReadonlySet<number>): DocMetrics {
  const retrievedSet = new Set(retrievedOrdered);
  let hits = 0;
  for (const id of retrievedSet) if (gold.has(id)) hits++;

  const union = retrievedSet.size + gold.size - hits;
  const jaccard = union === 0 ? 0 : hits / union;
  const precision = retrievedSet.size === 0 ? 0 : hits / retrievedSet.size;
  const recall = gold.size === 0 ? 0 : hits / gold.size;
  const hit: 0 | 1 = hits > 0 ? 1 : 0;

  let mrr = 0;
  const seen = new Set<number>();
  for (const id of retrievedOrdered) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (gold.has(id)) {
      mrr = 1 / seen.size;
      break;
    }
  }

  return { jaccard, precision, recall, hit, mrr };
}

/** Arithmetic mean; null for an empty input (aggregate over zero scored examples). */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Nearest-rank p95; null for an empty input. */
export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}
