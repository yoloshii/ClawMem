// Phase-B seam: optional { weights, now, forceWeights } on applyCompositeScoring.
// Pins the two fidelity gates + the recency-preserving weights semantics codex required
// ([H4] two-gate fidelity, [H5] recency intent preserved, [t2:L6] clock injection).
import { test, expect, setSystemTime } from "bun:test";
import { applyCompositeScoring, QUERY_WEIGHTS, DEFAULT_WEIGHTS, type EnrichedResult } from "../../src/memory.ts";

const FREEZE = new Date("2026-06-25T00:00:00Z");

function mkDoc(overrides: Partial<EnrichedResult> = {}): EnrichedResult {
  return {
    filepath: "clawmem://col/a.md",
    displayPath: "col/a.md",
    title: "A",
    score: 0.8,
    contentType: "note",
    modifiedAt: FREEZE.toISOString(),
    accessCount: 0,
    confidence: 0.5,
    qualityScore: 0.5,
    pinned: false,
    context: null,
    hash: "abc123",
    docid: "abc123",
    collectionName: "col",
    bodyLength: 500,
    source: "fts",
    duplicateCount: 1,
    revisionCount: 1,
    ...overrides,
  };
}

const twoDocs = () => [
  mkDoc(),
  mkDoc({ filepath: "clawmem://col/b.md", displayPath: "col/b.md", docid: "def456", hash: "def456", score: 0.6 }),
];
const HI = { search: 0.9, recency: 0.05, confidence: 0.05 };

// [t2:L6] / Gate B — explicit injected `now` is deterministic across calls.
test("seam: injected now → deterministic output", () => {
  const a = applyCompositeScoring(twoDocs(), "find something", undefined, { now: FREEZE });
  const b = applyCompositeScoring(twoDocs(), "find something", undefined, { now: FREEZE });
  expect(a.map(r => r.compositeScore)).toEqual(b.map(r => r.compositeScore));
});

// [H4] Gate A — no-options call ≡ {now} call under a frozen clock (default path uses new Date()).
test("seam: no-options ≡ {now} under frozen clock (default behavior preserved)", () => {
  setSystemTime(FREEZE);
  try {
    const def = applyCompositeScoring(twoDocs(), "find something");
    const inj = applyCompositeScoring(twoDocs(), "find something", undefined, { now: FREEZE });
    expect(def.map(r => r.compositeScore)).toEqual(inj.map(r => r.compositeScore));
  } finally {
    setSystemTime(); // reset
  }
});

// [H5] non-recency query — a weights override replaces DEFAULT_WEIGHTS.
test("seam: weights override applies for a non-recency query", () => {
  const q = "find the thing about X";
  const base = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE });
  const hi = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE, weights: HI });
  expect(hi[0]!.compositeScore).not.toEqual(base[0]!.compositeScore);
});

// [H5] recency-intent query — weights override is IGNORED (RECENCY_WEIGHTS kept) without forceWeights.
test("seam: recency intent keeps RECENCY_WEIGHTS despite a weights override", () => {
  const q = "what did we work on recently"; // matches /\brecent(ly)?\b/
  const overridden = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE, weights: HI });
  const recencyBaseline = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE });
  expect(overridden.map(r => r.compositeScore)).toEqual(recencyBaseline.map(r => r.compositeScore));
});

// [H5] forceWeights — applies `weights` even under recency intent.
test("seam: forceWeights applies weights even under recency intent", () => {
  const q = "what did we work on recently";
  const forced = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE, forceWeights: true, weights: HI });
  const recencyBaseline = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE });
  expect(forced[0]!.compositeScore).not.toEqual(recencyBaseline[0]!.compositeScore);
});

// --- Phase B §11.12: QUERY_WEIGHTS (the eval-validated query-tool re-weight, search 0.70) ---
const OLD = new Date("2026-01-01T00:00:00Z").toISOString(); // ~175d before FREEZE → low recency

// The shipped constant value + normalization (search+recency+confidence == 1).
test("QUERY_WEIGHTS: value is {0.70,0.15,0.15} and normalized", () => {
  expect(QUERY_WEIGHTS).toEqual({ search: 0.7, recency: 0.15, confidence: 0.15 });
  const sum = QUERY_WEIGHTS.search + QUERY_WEIGHTS.recency + QUERY_WEIGHTS.confidence;
  expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
});

// Direction of the re-weight: a strong-search / weak-recency doc scores HIGHER under QUERY_WEIGHTS
// than under DEFAULT_WEIGHTS (more mass on its strong topical signal). Catches a regression that
// silently reverts the query tool to DEFAULT_WEIGHTS.
test("QUERY_WEIGHTS lifts a high-search/old doc vs DEFAULT (non-recency query)", () => {
  const q = "find the design doc about the composite scorer";
  const hiSearchOld = [mkDoc({ score: 0.95, modifiedAt: OLD })];
  const qw = applyCompositeScoring(hiSearchOld, q, undefined, { now: FREEZE, weights: QUERY_WEIGHTS });
  const def = applyCompositeScoring(hiSearchOld, q, undefined, { now: FREEZE, weights: DEFAULT_WEIGHTS });
  expect(qw[0]!.compositeScore).toBeGreaterThan(def[0]!.compositeScore);
});

// Mirror: a weak-search / strong-recency doc scores LOWER under QUERY_WEIGHTS than DEFAULT.
test("QUERY_WEIGHTS de-weights a low-search/new doc vs DEFAULT (non-recency query)", () => {
  const q = "find the design doc about the composite scorer";
  const loSearchNew = [mkDoc({ score: 0.2, modifiedAt: FREEZE.toISOString() })];
  const qw = applyCompositeScoring(loSearchNew, q, undefined, { now: FREEZE, weights: QUERY_WEIGHTS });
  const def = applyCompositeScoring(loSearchNew, q, undefined, { now: FREEZE, weights: DEFAULT_WEIGHTS });
  expect(qw[0]!.compositeScore).toBeLessThan(def[0]!.compositeScore);
});

// The shipped contract: under recency intent the query tool's QUERY_WEIGHTS is IGNORED — RECENCY_WEIGHTS
// wins (forceWeights is never set in mcp.ts). This is the freshness-preserving guarantee the eval relied on.
test("QUERY_WEIGHTS is ignored under recency intent (query-tool contract)", () => {
  const q = "what did we work on recently";
  const qw = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE, weights: QUERY_WEIGHTS });
  const recencyBaseline = applyCompositeScoring(twoDocs(), q, undefined, { now: FREEZE });
  expect(qw.map(r => r.compositeScore)).toEqual(recencyBaseline.map(r => r.compositeScore));
});
