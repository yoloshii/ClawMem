import { describe, it, expect } from "bun:test";
import { reciprocalRankFusion, type RankedResult } from "../../src/search-utils.ts";

function makeRanked(file: string, score: number = 1.0): RankedResult {
  return {
    file,
    displayPath: file,
    title: file,
    body: `content of ${file}`,
    score,
  };
}

// ─── reciprocalRankFusion ───────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  it("merges two ranked lists with equal weights", () => {
    const list1 = [makeRanked("a.md", 1.0), makeRanked("b.md", 0.8)];
    const list2 = [makeRanked("b.md", 1.0), makeRanked("c.md", 0.8)];
    const fused = reciprocalRankFusion([list1, list2], [1, 1]);
    expect(fused.length).toBeGreaterThanOrEqual(2);
    // b.md appears in both lists, should rank high
    const bResult = fused.find(r => r.file === "b.md");
    expect(bResult).toBeDefined();
  });

  it("deduplicates results by file key", () => {
    const list1 = [makeRanked("same.md", 1.0)];
    const list2 = [makeRanked("same.md", 0.9)];
    const fused = reciprocalRankFusion([list1, list2], [1, 1]);
    const sameCount = fused.filter(r => r.file === "same.md").length;
    expect(sameCount).toBe(1);
  });

  it("sorts by fused score descending", () => {
    const list1 = [makeRanked("a.md", 1.0), makeRanked("b.md", 0.5)];
    const list2 = [makeRanked("b.md", 1.0), makeRanked("a.md", 0.5)];
    const fused = reciprocalRankFusion([list1, list2], [1, 1]);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1]!.score).toBeGreaterThanOrEqual(fused[i]!.score);
    }
  });

  it("handles empty result lists", () => {
    const fused = reciprocalRankFusion([[], []], [1, 1]);
    expect(fused).toHaveLength(0);
  });

  it("handles single list", () => {
    const list = [makeRanked("a.md", 1.0)];
    const fused = reciprocalRankFusion([list], [1]);
    expect(fused).toHaveLength(1);
  });

  it("applies weight multipliers correctly", () => {
    const list1 = [makeRanked("a.md", 1.0)]; // weight 2
    const list2 = [makeRanked("b.md", 1.0)]; // weight 1
    const fused = reciprocalRankFusion([list1, list2], [2, 1]);
    // a.md from list1 (weight 2) should score higher than b.md from list2 (weight 1)
    const aIdx = fused.findIndex(r => r.file === "a.md");
    const bIdx = fused.findIndex(r => r.file === "b.md");
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("gives default weight 1 when weights array is empty", () => {
    const list1 = [makeRanked("a.md")];
    const list2 = [makeRanked("b.md")];
    const fused = reciprocalRankFusion([list1, list2], []);
    expect(fused.length).toBe(2);
  });
});
