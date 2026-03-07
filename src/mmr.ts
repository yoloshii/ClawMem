/**
 * MMR (Maximal Marginal Relevance) Diversity Filter
 *
 * Prevents top-k results from being dominated by near-duplicate entries.
 * Uses text-based similarity (word overlap) — no vector lookups needed.
 *
 * Ported from memory-lancedb-pro's applyMMRDiversity(), adapted to use
 * Jaccard similarity on word bigrams instead of cosine on vectors.
 */

import type { ScoredResult } from "./memory.ts";

// =============================================================================
// Text Similarity
// =============================================================================

function extractBigrams(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  // Also add individual words for short texts
  for (const w of words) {
    if (w.length > 3) bigrams.add(w);
  }
  return bigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// =============================================================================
// MMR Diversity Filter
// =============================================================================

/**
 * Greedily select results that are both relevant (high score) and diverse
 * (low textual similarity to already-selected results).
 *
 * Results exceeding the similarity threshold against any selected result
 * are demoted to the end rather than removed entirely.
 *
 * @param results - Pre-sorted by compositeScore descending
 * @param similarityThreshold - Jaccard threshold above which results are demoted (default 0.6)
 * @returns Reordered results with diverse items first, near-duplicates appended
 */
export function applyMMRDiversity(
  results: ScoredResult[],
  similarityThreshold: number = 0.6
): ScoredResult[] {
  if (results.length <= 2) return results;

  const bigramCache = new Map<string, Set<string>>();
  function getBigrams(r: ScoredResult): Set<string> {
    const key = r.filepath;
    let cached = bigramCache.get(key);
    if (!cached) {
      cached = extractBigrams(`${r.title} ${r.body || ""}`);
      bigramCache.set(key, cached);
    }
    return cached;
  }

  const selected: ScoredResult[] = [];
  const deferred: ScoredResult[] = [];

  for (const candidate of results) {
    const candidateBigrams = getBigrams(candidate);

    const tooSimilar = selected.some(s => {
      const sim = jaccardSimilarity(getBigrams(s), candidateBigrams);
      return sim > similarityThreshold;
    });

    if (tooSimilar) {
      deferred.push(candidate);
    } else {
      selected.push(candidate);
    }
  }

  return [...selected, ...deferred];
}
