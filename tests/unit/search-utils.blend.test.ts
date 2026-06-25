import { describe, test, expect } from "bun:test";
import { blendRerank } from "../../src/search-utils.ts";

// candidates carry the RRF fusion score in `score`, RRF-ordered (highest first).
const cand = (file: string, rrfScore: number) => ({ file, score: rrfScore });
const rr = (file: string, score: number) => ({ file, score });

describe("blendRerank", () => {
  test("a strong reranker score promotes a doc above RRF #1", () => {
    // RRF order: a (#1), b (#2). Reranker strongly prefers b.
    const candidates = [cand("a.md", 0.10), cand("b.md", 0.05)];
    const reranked = [rr("a.md", 0.10), rr("b.md", 0.95)];
    const out = blendRerank(candidates, reranked);
    // The whole point of the fix: b can now beat RRF #1. (The old w·(1/rrfRank) blend could not.)
    expect(out[0]!.file).toBe("b.md");
    expect(out[1]!.file).toBe("a.md");
  });

  test("all-zero reranker scores → pure RRF order (total-failure fallback)", () => {
    const candidates = [cand("a.md", 0.10), cand("b.md", 0.05), cand("c.md", 0.02)];
    const reranked = [rr("a.md", 0), rr("b.md", 0), rr("c.md", 0)];
    const out = blendRerank(candidates, reranked);
    expect(out.map(r => r.file)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("empty reranker output → pure RRF order (unavailable fallback)", () => {
    const candidates = [cand("a.md", 0.10), cand("b.md", 0.05)];
    const out = blendRerank(candidates, []);
    expect(out.map(r => r.file)).toEqual(["a.md", "b.md"]);
  });

  test("partial coverage: scored docs rank by reranker; unscored keep relative RRF order below", () => {
    // b is the only doc the reranker scored; a and c come back as 0 (unscored).
    const candidates = [cand("a.md", 0.10), cand("b.md", 0.08), cand("c.md", 0.05)];
    const reranked = [rr("a.md", 0), rr("b.md", 0.9), rr("c.md", 0)];
    const out = blendRerank(candidates, reranked).map(r => r.file);
    expect(out[0]).toBe("b.md");           // scored doc floats to the top
    expect(out.indexOf("a.md")).toBeLessThan(out.indexOf("c.md")); // unscored keep RRF order (a before c)
  });

  test("never drops a candidate missing from the reranker output (maps over candidates)", () => {
    const candidates = [cand("a.md", 0.10), cand("b.md", 0.08), cand("c.md", 0.05)];
    const reranked = [rr("a.md", 0.7), rr("b.md", 0.6)]; // c.md absent entirely
    const out = blendRerank(candidates, reranked);
    expect(out.length).toBe(3);
    expect(out.map(r => r.file).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("rerankWeight controls the blend (higher weight → reranker dominates more)", () => {
    const candidates = [cand("a.md", 0.10), cand("b.md", 0.05)];
    const reranked = [rr("a.md", 0.0), rr("b.md", 0.6)];
    // With a thin RRF weight (default 0.9 on rerank) b should still win on its rerank score.
    expect(blendRerank(candidates, reranked, 0.9)[0]!.file).toBe("b.md");
    // With RRF dominant (0.1 rerank weight) a's RRF #1 lead should hold.
    expect(blendRerank(candidates, reranked, 0.1)[0]!.file).toBe("a.md");
  });

  test("all-zero RRF scores do not produce NaN (maxRrf guard)", () => {
    const candidates = [cand("a.md", 0), cand("b.md", 0)];
    const out = blendRerank(candidates, [rr("a.md", 0.4), rr("b.md", 0.8)]);
    for (const r of out) expect(Number.isFinite(r.score)).toBe(true);
    expect(out[0]!.file).toBe("b.md"); // reranker breaks the tie
  });
});
