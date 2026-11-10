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
import { createHash } from "crypto";
import { join } from "path";
import { DEFAULT_RERANK_MODEL, RerankCoverageError, RerankMalformedResponseError, writeRerankProviderFingerprint, revokeRerankProviderFingerprint, type Store } from "../store.ts";
import type { Database } from "bun:sqlite";
import { duration } from "../clock.ts";

// Thresholds — LOCKED from a live zerank-2-seq baseline (2026-06-26, 8-pair golden set):
//   relevant scores 0.9233-0.9700, hard-neg max 0.3120, min margin 0.6417, 0/8 inverted.
//   broken zerank-2 GGUF regime: every score <= 8.03e-7 (32-query probe). 5-6 OOM of separation.
// CALIB_FLOOR is the band that catches the ~0 collapse (kept conservative — the margin does the
// discrimination, so the band must not false-fail a working-but-lower reranker). DISCRIM_MARGIN is
// 2.5x below the live min margin (0.64) so healthy never trips, far above the degenerate ~0.
export const RERANK_CALIB_FLOOR = 0.05; // band: best relevant-doc score across pairs must clear this
export const RERANK_DISCRIM_MARGIN = 0.25; // per-pair: score(relevant) - score(hardNegative) >= this

/**
 * Per-pair margin actually applied by the probe: `CLAWMEM_RERANK_DISCRIM_MARGIN` (a number in (0, 1)) or
 * the zerank-2 default above. The default is calibrated to zerank-2's spread; rerankers that saturate
 * scores toward the ends (Qwen3-Reranker, bge-reranker) rank correctly but can land a hard negative at
 * 0.86 beside a relevant doc at 1.00 — a margin of 0.14 that is still a correct ordering. A lower margin
 * keeps the guard against the degenerate regimes (inverted order, constant output, collapse to ~0) because
 * those sit at or below zero margin. Invalid values fall back to the default and are never silent about it.
 */
export function rerankDiscrimMargin(raw: string | undefined = Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN): number {
  const t = raw?.trim();
  if (!t) return RERANK_DISCRIM_MARGIN;
  const v = Number(t);
  if (Number.isFinite(v) && v > 0 && v < 1) return v;
  console.error(`[clawmem] ignoring CLAWMEM_RERANK_DISCRIM_MARGIN=${JSON.stringify(t)} (need a number in (0, 1)); using ${RERANK_DISCRIM_MARGIN}`);
  return RERANK_DISCRIM_MARGIN;
}
/**
 * Per-REQUEST spread floor (BUILD-3d) — the probe margin adapted to an
 * unlabeled candidate set. The probe separates labeled relevant/hard-negative
 * pairs by DISCRIM_MARGIN; a live request has no labels, so the only
 * mechanical discrimination signal is the score set's own spread (max - min).
 * The floor is DISCRIM_MARGIN / 5 = 0.05: five orders of magnitude above the
 * documented degenerate regimes (broken GGUF ≤ 8.03e-7; constant output = 0)
 * and 5× below the labeled-pair margin, so a healthy reranker over a MIXED
 * pool never trips. A healthy reranker over a genuinely homogeneous pool MAY
 * trip — that discards a low-information ordering in favor of the failure
 * guard, and every firing is traced (reason recorded) so the judged runs
 * measure the rate instead of assuming it.
 *
 * STATUS (codex turn-40 ruling): 0.05 is a PRE-REGISTERED EXPERIMENTAL
 * threshold, not yet a cross-provider shipping threshold — it is absolute
 * and calibrated from the zerank baseline. The judged runs must measure the
 * FALSE-DISCARD rate before the value ships as policy, and a different
 * supported reranker may need its own calibration.
 */
export const RERANK_REQUEST_SPREAD_FLOOR = RERANK_DISCRIM_MARGIN / 5;
// Default per-probe-request timeout (the production remote fetch is otherwise untimed; a hung
// reranker must not hang the healthcheck).
export const RERANK_PROBE_TIMEOUT_MS = 10_000;

export interface GoldenTriple {
  query: string;
  relevant: string;
  hardNegative: string;
  note?: string;
}

/**
 * Per-request degeneracy verdict over one fully-covered rerank response
 * (BUILD-3d). `reason` when degenerate:
 *   "collapse" — max score below the calibration floor: the ~0 regime of the
 *                mis-converted GGUF (every score ≤ 8.03e-7 in the documented
 *                incident) — the same failure the probe's calibration band
 *                catches, judged per request;
 *   "inert"   — spread (max - min) below the spread floor: (near-)constant
 *               output whose ordering is arbitrary — the failure the probe's
 *               discrimination margin catches, judged per request. A set of
 *               fewer than two finite scores is inert by construction (an
 *               ordering over <2 candidates carries no information).
 *   "invalid" — an empty set or any non-finite score. Cannot arise behind
 *               requireLiveCoverage (the store throws first); the gate fails
 *               closed if it ever does.
 */
export interface RerankDegeneracyAssessment {
  degenerate: boolean;
  reason: "collapse" | "inert" | "invalid" | null;
  maxScore: number;
  spread: number;
  thresholds: { calibFloor: number; spreadFloor: number };
}

/**
 * Assess one request's returned score set for degeneracy (BUILD-3d — the
 * turn-15 F3 direction: ordering trust only behind strict coverage AND
 * degeneracy validation, with the rerank-health discrimination probe as the
 * prior art). The out-of-band probe attests the PROVIDER on a labeled golden
 * set; this judges the SCORE SET a single live request actually returned —
 * an attested provider can still emit a degenerate set for one query/pool,
 * and that residual is what the per-request gate catches. Pure and
 * mechanical: no labels, no thresholds learned from data, no I/O.
 *
 * Deliberately distinct from search-utils' permissive RERANK_DEGENERATE_FLOOR
 * (1e-4): that floor protects the QUERY path's 0.9-dominance score BLEND and
 * only catches the near-zero collapse. The hook path promotes the reranker to
 * the ORDERING ARBITER (BUILD-3), and that trust level demands the probe-bar
 * floors — collapse band AND spread — per request.
 */
export function assessRerankDegeneracy(
  scores: number[],
  thresholds?: { calibFloor?: number; spreadFloor?: number },
): RerankDegeneracyAssessment {
  const calibFloor = thresholds?.calibFloor ?? RERANK_CALIB_FLOOR;
  const spreadFloor = thresholds?.spreadFloor ?? RERANK_REQUEST_SPREAD_FLOOR;
  const t = { calibFloor, spreadFloor };
  if (scores.length === 0 || scores.some(s => !Number.isFinite(s))) {
    return { degenerate: true, reason: "invalid", maxScore: NaN, spread: NaN, thresholds: t };
  }
  const maxScore = Math.max(...scores);
  const spread = maxScore - Math.min(...scores);
  if (maxScore < calibFloor) return { degenerate: true, reason: "collapse", maxScore, spread, thresholds: t };
  if (spread < spreadFloor) return { degenerate: true, reason: "inert", maxScore, spread, thresholds: t };
  return { degenerate: false, reason: null, maxScore, spread, thresholds: t };
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
  /**
   * Behavioral identity of the provider that answered THIS probe, derived
   * from the very scores the health checks validated — same authenticated,
   * coverage-enforced, discrimination-checked requests, not a second
   * unattested call (codex turn-31 finding 1). Null when no pair scored, so
   * an unusable probe can never attest an identity.
   */
  fingerprint: string | null;
}

/**
 * The health check as the PRODUCTION callers run it — `clawmem rerank-health`
 * and `clawmem doctor` both delegate here (codex turn-34 finding 1). It owns
 * the remote-only policy: when a remote endpoint is configured the probe must
 * be about THAT endpoint, so the local fallback is forbidden and a dead
 * remote fails health instead of being rescued by in-process inference.
 * Taking the store as a dependency makes the policy testable with a fake
 * store, without enabling local inference in a test environment.
 */
export async function probeConfiguredRerankHealth(
  store: Pick<Store, "rerank">,
  opts: { timeoutMs?: number; model?: string; triples?: GoldenTriple[]; rerankUrl?: string | undefined } = {},
): Promise<RerankHealthResult> {
  // An explicitly-passed rerankUrl is authoritative (including `undefined`,
  // which means "no remote configured") so the policy is testable without
  // mutating process env.
  const url = ("rerankUrl" in opts ? opts.rerankUrl : Bun.env.CLAWMEM_RERANK_URL)?.trim();
  const { rerankUrl: _ignored, ...rest } = opts;
  return probeRerankHealth(store, { ...rest, ...(url ? { requireRemote: true } : {}) });
}

/**
 * The `clawmem rerank-health` COMMAND workflow — probe under the remote-only
 * policy, then attest or REVOKE the provider identity. Extracted so a test
 * can drive the production workflow itself with an injected store rather than
 * only its policy helper (codex turn-35 finding 1); the CLI does nothing but
 * format what this returns.
 */
export async function runRerankHealthWorkflow(
  store: Pick<Store, "rerank"> & { db: Database },
  opts: { timeoutMs?: number; model?: string; triples?: GoldenTriple[]; rerankUrl?: string | undefined } = {},
): Promise<{ health: RerankHealthResult; attested: string | null; revoked: boolean; revokeError: string | null }> {
  const url = ("rerankUrl" in opts ? opts.rerankUrl : Bun.env.CLAWMEM_RERANK_URL)?.trim();
  const health = await probeConfiguredRerankHealth(store, { ...opts, rerankUrl: url });
  if (!url) return { health, attested: null, revoked: false, revokeError: null };
  if (health.ok && health.fingerprint) {
    writeRerankProviderFingerprint(store.db, url, health.fingerprint);
    return { health, attested: health.fingerprint, revoked: false, revokeError: null };
  }
  try {
    revokeRerankProviderFingerprint(store.db, url);
    return { health, attested: null, revoked: true, revokeError: null };
  } catch (e) {
    return { health, attested: null, revoked: false, revokeError: (e as Error).message };
  }
}

/**
 * The `clawmem doctor` reranker CHECK workflow — probe only, under the same
 * remote-only policy (doctor never attests; it is a read-only health view).
 */
export async function runDoctorRerankCheck(
  store: Pick<Store, "rerank">,
  opts: { timeoutMs?: number; rerankUrl?: string | undefined } = {},
): Promise<RerankHealthResult> {
  return probeConfiguredRerankHealth(store, opts);
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
    /** Forbid the local fallback — set when attesting a REMOTE endpoint so a dead remote cannot be rescued by local inference (codex turn-32 finding 1). */
    requireRemote?: boolean;
  } = {},
): Promise<RerankHealthResult> {
  const calibFloor = opts.thresholds?.calibFloor ?? RERANK_CALIB_FLOOR;
  const discrimMargin = opts.thresholds?.discrimMargin ?? rerankDiscrimMargin();
  const timeoutMs = duration(opts.timeoutMs ?? RERANK_PROBE_TIMEOUT_MS); // O1: a validated construction, not an assertion
  const model = opts.model ?? DEFAULT_RERANK_MODEL;
  const triples = opts.triples ?? loadGoldenSet();

  const failures: string[] = [];
  // Rounded per-pair scores from the VALIDATED probe requests — the material
  // the provider fingerprint is derived from (codex turn-31 finding 1).
  const observed: string[] = [];
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
        ...(opts.requireRemote ? { requireRemote: true } : {}),
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
    observed.push(`${i}:${(scoreMap.get(relFile) ?? NaN).toFixed(6)}:${(scoreMap.get(negFile) ?? NaN).toFixed(6)}`);
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
      `calibration: max relevant-doc score ${maxScore.toExponential(2)} < floor ${calibFloor} — reranker is inert/degenerate (likely a zerank-2 GGUF without its score head; serve the Q8_0 GGUF that carries it, or the seq-cls sidecar)`,
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
    // Derived from the SAME validated responses the checks above ran on:
    // authenticated (store.rerank carries the API key), coverage-enforced,
    // and discrimination-checked. A second unattested HTTP call could have
    // observed a different deployment (codex turn-31 finding 1).
    fingerprint: observed.length > 0
      ? `behavioral:${createHash("sha256").update(observed.join("|")).digest("hex").slice(0, 16)}`
      : null,
  };
}
