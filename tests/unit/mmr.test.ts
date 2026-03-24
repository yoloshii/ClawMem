import { describe, it, expect } from "bun:test";
import { applyMMRDiversity } from "../../src/mmr.ts";
import type { ScoredResult } from "../../src/memory.ts";

function makeScoredResult(overrides: Partial<ScoredResult> & { filepath: string; body: string; compositeScore: number }): ScoredResult {
  return {
    displayPath: overrides.filepath,
    title: overrides.title || "Test",
    score: overrides.score || 0.5,
    contentType: "note",
    modifiedAt: "2026-01-01",
    accessCount: 0,
    confidence: 0.5,
    qualityScore: 0.5,
    pinned: false,
    context: null,
    hash: "abc",
    docid: "1",
    collectionName: "test",
    bodyLength: overrides.body.length,
    source: "fts" as const,
    recencyScore: 0.8,
    duplicateCount: 1,
    revisionCount: 1,
    ...overrides,
  };
}

describe("applyMMRDiversity", () => {
  it("returns empty array for empty input", () => {
    expect(applyMMRDiversity([])).toEqual([]);
  });

  it("returns single result unchanged", () => {
    const r = makeScoredResult({ filepath: "a.md", body: "hello world", compositeScore: 0.9 });
    expect(applyMMRDiversity([r])).toEqual([r]);
  });

  it("returns two results unchanged", () => {
    const results = [
      makeScoredResult({ filepath: "a.md", body: "hello world", compositeScore: 0.9 }),
      makeScoredResult({ filepath: "b.md", body: "goodbye world", compositeScore: 0.8 }),
    ];
    expect(applyMMRDiversity(results)).toEqual(results);
  });

  it("demotes near-duplicate results to end", () => {
    const results = [
      makeScoredResult({ filepath: "a.md", body: "the quick brown fox jumps over the lazy dog", compositeScore: 0.9 }),
      makeScoredResult({ filepath: "b.md", body: "the quick brown fox jumps over the lazy dog again", compositeScore: 0.85 }),
      makeScoredResult({ filepath: "c.md", body: "completely different content about databases and indexing", compositeScore: 0.8 }),
    ];
    const diversified = applyMMRDiversity(results);
    // c.md should be promoted above b.md because b.md is too similar to a.md
    expect(diversified[0]!.filepath).toBe("a.md");
    expect(diversified[1]!.filepath).toBe("c.md");
    expect(diversified[2]!.filepath).toBe("b.md");
  });

  it("preserves order when results are diverse", () => {
    const results = [
      makeScoredResult({ filepath: "a.md", body: "machine learning algorithms for classification", compositeScore: 0.9 }),
      makeScoredResult({ filepath: "b.md", body: "database indexing strategies for performance", compositeScore: 0.85 }),
      makeScoredResult({ filepath: "c.md", body: "frontend react component architecture patterns", compositeScore: 0.8 }),
    ];
    const diversified = applyMMRDiversity(results);
    expect(diversified.map(r => r.filepath)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("respects custom similarity threshold", () => {
    const results = [
      makeScoredResult({ filepath: "a.md", body: "the quick brown fox jumps", compositeScore: 0.9 }),
      makeScoredResult({ filepath: "b.md", body: "the quick brown fox leaps", compositeScore: 0.85 }),
      makeScoredResult({ filepath: "c.md", body: "something else entirely", compositeScore: 0.8 }),
    ];
    // With a very high threshold, nothing should be demoted
    const lenient = applyMMRDiversity(results, 0.99);
    expect(lenient.map(r => r.filepath)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("keeps all results (demotes, does not remove)", () => {
    const results = [
      makeScoredResult({ filepath: "a.md", body: "identical content about testing", compositeScore: 0.9 }),
      makeScoredResult({ filepath: "b.md", body: "identical content about testing", compositeScore: 0.85 }),
      makeScoredResult({ filepath: "c.md", body: "identical content about testing", compositeScore: 0.8 }),
    ];
    const diversified = applyMMRDiversity(results);
    expect(diversified).toHaveLength(3);
    // First one stays, others are deferred
    expect(diversified[0]!.filepath).toBe("a.md");
  });
});
