import { describe, it, expect } from "bun:test";

/**
 * v0.22.0 raw-primary regime (VSEARCH-RAW-PRIMARY-DESIGN.md R1/R2/R4):
 * raw cosine is the primary key; metadata — including pin — participates only
 * inside groups of exactly-equal raw scores; recency-intent queries route to the
 * composite regime. These are the constructed-tie units the design's acceptance
 * criteria require (pin wins inside its tie group, never crosses a score boundary).
 */
import { selectScoringRegime, rankRawPrimary, VECTOR_SCORE_BASIS, COMPOSITE_SCORE_BASIS } from "../../src/scoring-regime.ts";
import type { EnrichedResult } from "../../src/memory.ts";

const NOW = new Date("2026-07-10T12:00:00Z");

function er(displayPath: string, score: number, over: Partial<EnrichedResult> = {}): EnrichedResult {
  return {
    filepath: `clawmem://${displayPath}`,
    displayPath,
    title: displayPath,
    score,
    body: "body",
    contentType: "note",
    modifiedAt: "2026-07-01T00:00:00Z",
    accessCount: 0,
    confidence: 0.5,
    qualityScore: 0.5,
    pinned: false,
    context: null,
    hash: displayPath,
    docid: displayPath.slice(0, 6),
    collectionName: displayPath.split("/")[0]!,
    bodyLength: 500,
    source: "vec",
    duplicateCount: 1,
    revisionCount: 1,
    ...over,
  } as EnrichedResult;
}

describe("selectScoringRegime", () => {
  it("routes plain queries to raw", () => {
    expect(selectScoringRegime("foreman seal verification plane profile")).toBe("raw");
    expect(selectScoringRegime("how does the wiki payoff metric work")).toBe("raw");
  });

  it("routes recency-intent queries to recency-composite", () => {
    expect(selectScoringRegime("latest decisions about scoring")).toBe("recency-composite");
    expect(selectScoringRegime("what did we do yesterday")).toBe("recency-composite");
    expect(selectScoringRegime("where we left off with the scoring work")).toBe("recency-composite");
  });

  it("exports distinct score-basis labels", () => {
    expect(VECTOR_SCORE_BASIS).toBe("vector-cosine");
    expect(COMPOSITE_SCORE_BASIS).toBe("composite");
    expect(VECTOR_SCORE_BASIS).not.toBe(COMPOSITE_SCORE_BASIS);
  });
});

describe("rankRawPrimary", () => {
  it("raw score is the primary key — pin/quality/length on a lower-raw doc cannot outrank", () => {
    // The incident shape: a pinned, high-quality, short hub doc vs a long plain true match
    // with a slightly higher raw score. Composite inverts this; raw-primary must not.
    const trueMatch = er("mem/true-match.md", 0.72, { bodyLength: 20000 });
    const hub = er("skills/hub.md", 0.7, { pinned: true, qualityScore: 1.0, accessCount: 6000 });
    const ranked = rankRawPrimary([hub, trueMatch], "plain query", undefined, { now: NOW });
    expect(ranked.map(r => r.displayPath)).toEqual(["mem/true-match.md", "skills/hub.md"]);
    // The reported score IS the raw cosine.
    expect(ranked[0]!.compositeScore).toBe(0.72);
    expect(ranked[1]!.compositeScore).toBe(0.7);
  });

  it("pin wins INSIDE an exact raw-score tie group", () => {
    const a = er("col/a.md", 0.7);
    const b = er("col/b.md", 0.7, { pinned: true });
    const ranked = rankRawPrimary([a, b], "plain query", undefined, { now: NOW });
    expect(ranked.map(r => r.displayPath)).toEqual(["col/b.md", "col/a.md"]);
  });

  it("pin never crosses a raw-score boundary — even an epsilon one", () => {
    const a = er("col/a.md", 0.7000001);
    const b = er("col/b.md", 0.7, { pinned: true, qualityScore: 1.0 });
    const ranked = rankRawPrimary([a, b], "plain query", undefined, { now: NOW });
    expect(ranked[0]!.displayPath).toBe("col/a.md");
  });

  it("ties with identical metadata fall back to displayPath ASC (total determinism)", () => {
    const b = er("col/b.md", 0.7);
    const a = er("col/a.md", 0.7);
    const ranked = rankRawPrimary([b, a], "plain query", undefined, { now: NOW });
    expect(ranked.map(r => r.displayPath)).toEqual(["col/a.md", "col/b.md"]);
    // Input order must not matter.
    const ranked2 = rankRawPrimary([a, b], "plain query", undefined, { now: NOW });
    expect(ranked2.map(r => r.displayPath)).toEqual(["col/a.md", "col/b.md"]);
  });

  it("inside a tie group, legacy composite orders non-pinned candidates deterministically", () => {
    const weak = er("col/weak.md", 0.7, { qualityScore: 0.1 });
    const strong = er("col/strong.md", 0.7, { qualityScore: 1.0 });
    const ranked = rankRawPrimary([weak, strong], "plain query", undefined, { now: NOW });
    expect(ranked.map(r => r.displayPath)).toEqual(["col/strong.md", "col/weak.md"]);
  });

  it("is bit-reproducible under a frozen clock", () => {
    const rows = [er("c/x.md", 0.61), er("c/y.md", 0.61, { pinned: true }), er("c/z.md", 0.8)];
    const r1 = rankRawPrimary(rows, "plain query", undefined, { now: NOW });
    const r2 = rankRawPrimary(rows, "plain query", undefined, { now: NOW });
    expect(r1.map(r => [r.displayPath, r.compositeScore])).toEqual(r2.map(r => [r.displayPath, r.compositeScore]));
  });
});
