/**
 * Reranker health probe — asserts the reranker DISCRIMINATES, not just that it responds.
 *
 * Background: the deployed zerank-2 GGUF was mis-converted (no score head), so it returned
 * HTTP 200 + valid JSON + finite positive scores (~1e-11) yet ranked near-randomly and silently
 * collapsed the final ranking to RRF. Liveness checks all passed. This probe instead runs a small
 * golden set of same-topic (query, relevant, hard-negative) triples through the LIVE reranker
 * (cache-bypassed) and asserts three things:
 *
 *   1. coverage     — the reranker scored every probe doc (store.rerank throws RerankCoverageError
 *                     otherwise, before its zero-fill would hide an omitted score);
 *   2. calibration  — the best relevant-doc score lands in a sane band (>= CALIB_FLOOR);
 *   3. discrimination — EVERY pair clears score(relevant) - score(hardNegative) >= DISCRIM_MARGIN.
 *
 * See RERANKER-HEALTH-GUARD-DESIGN.md.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_RERANK_MODEL, RerankCoverageError, RerankMalformedResponseError, type Store } from "../store.ts";

// Thresholds — LOCKED from a live zerank-2-seq baseline (2026-06-26, 8-pair golden set):
//   relevant scores 0.9233-0.9700, hard-neg max 0.3120, min margin 0.6417, 0/8 inverted.
//   broken zerank-2 GGUF regime: every score <= 8.03e-7 (32-query probe). 5-6 OOM of separation.
// CALIB_FLOOR is the band that catches the ~0 collapse (kept conservative — the margin does the
// discrimination, so the band must not false-fail a working-but-lower reranker). DISCRIM_MARGIN is
// 2.5x below the live min margin (0.64) so healthy never trips, far above the degenerate ~0.
export const RERANK_CALIB_FLOOR = 0.05; // band: best relevant-doc score across pairs must clear this
export const RERANK_DISCRIM_MARGIN = 0.25; // per-pair: score(relevant) - score(hardNegative) >= this
// Default per-probe-request timeout (the production remote fetch is otherwise untimed; a hung
// reranker must not hang the healthcheck).
export const RERANK_PROBE_TIMEOUT_MS = 10_000;

export interface GoldenTriple {
  query: string;
  relevant: string;
  hardNegative: string;
  note?: string;
}

export interface RerankHealthResult {
  ok: boolean;
  coverageOk: boolean;
  maxScore: number; // best relevant-doc score across pairs (calibration-band input)
  minMargin: number; // smallest (relevant - hardNegative) margin across pairs
  pairsTotal: number;
  pairsScored: number; // pairs where both docs were scored (full coverage)
  failures: string[]; // human-readable failure reasons (empty iff ok)
  thresholds: { calibFloor: number; discrimMargin: number };
}

/** Load the shipped golden set (or an explicit path, for tests). */
export function loadGoldenSet(path?: string): GoldenTriple[] {
  const p = path ?? join(import.meta.dir, "rerank-golden.json");
  const parsed = JSON.parse(readFileSync(p, "utf-8")) as { triples: GoldenTriple[] };
  return parsed.triples;
}

/**
 * Probe the reranker behind `store` for discrimination + calibration. Routes through store.rerank
 * with { noCache, requireLiveCoverage, timeoutMs } so it exercises the FULL production path
 * (remote → local fallback, dedup, intent, 400-char truncation) while bypassing the cache and
 * enforcing live coverage. `store` is structurally typed so tests can pass a fake reranker.
 */
export async function probeRerankHealth(
  store: Pick<Store, "rerank">,
  opts: {
    thresholds?: { calibFloor?: number; discrimMargin?: number };
    timeoutMs?: number;
    model?: string;
    triples?: GoldenTriple[];
  } = {},
): Promise<RerankHealthResult> {
  const calibFloor = opts.thresholds?.calibFloor ?? RERANK_CALIB_FLOOR;
  const discrimMargin = opts.thresholds?.discrimMargin ?? RERANK_DISCRIM_MARGIN;
  const timeoutMs = opts.timeoutMs ?? RERANK_PROBE_TIMEOUT_MS;
  const model = opts.model ?? DEFAULT_RERANK_MODEL;
  const triples = opts.triples ?? loadGoldenSet();

  const failures: string[] = [];
  let maxScore = 0;
  let minMargin = Infinity;
  let pairsScored = 0;

  for (let i = 0; i < triples.length; i++) {
    const t = triples[i]!;
    const relFile = `golden-${i}-rel`;
    const negFile = `golden-${i}-neg`;
    const docs = [
      { file: relFile, text: t.relevant },
      { file: negFile, text: t.hardNegative },
    ];
    const label = `pair ${i} ("${t.query.slice(0, 40)}")`;

    let scored: { file: string; score: number }[];
    try {
      // intent omitted (4th arg undefined); options force a live, coverage-checked call.
      scored = await store.rerank(t.query, docs, model, undefined, {
        noCache: true,
        requireLiveCoverage: true,
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof RerankCoverageError) {
        failures.push(`${label}: coverage — reranker did not score ${err.missing.length} doc(s)`);
      } else if (err instanceof RerankMalformedResponseError) {
        failures.push(`${label}: malformed response — ${err.problems.join("; ")}`);
      } else {
        failures.push(`${label}: probe error — ${(err as Error).message}`);
      }
      continue;
    }

    const scoreMap = new Map(scored.map((s) => [s.file, s.score]));
    const relScore = scoreMap.get(relFile);
    const negScore = scoreMap.get(negFile);
    if (relScore === undefined || negScore === undefined || !Number.isFinite(relScore) || !Number.isFinite(negScore)) {
      // requireLiveCoverage should have thrown already; defensive.
      failures.push(`${label}: missing or non-finite score after rerank`);
      continue;
    }

    pairsScored++;
    maxScore = Math.max(maxScore, relScore);
    const margin = relScore - negScore;
    minMargin = Math.min(minMargin, margin);
    if (margin < discrimMargin) {
      failures.push(
        `${label}: margin ${margin.toFixed(3)} < ${discrimMargin} (rel ${relScore.toFixed(3)} vs neg ${negScore.toFixed(3)})`,
      );
    }
  }

  if (maxScore < calibFloor) {
    failures.push(
      `calibration: max relevant-doc score ${maxScore.toExponential(2)} < floor ${calibFloor} — reranker is inert/degenerate (likely the deprecated zerank-2 GGUF; re-deploy the seq-cls sidecar)`,
    );
  }
  if (minMargin === Infinity) minMargin = 0; // no pair scored

  return {
    ok: failures.length === 0,
    coverageOk: pairsScored === triples.length,
    maxScore,
    minMargin,
    pairsTotal: triples.length,
    pairsScored,
    failures,
    thresholds: { calibFloor, discrimMargin },
  };
}
