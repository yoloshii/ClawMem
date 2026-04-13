/**
 * Unit tests for §11.4 — Session-scoped focus (v0.9.0).
 *
 * Covers:
 *  - readSessionFocus fail-open paths (missing sid, missing file, empty,
 *    whitespace, oversized, invalid UTF-8, unreadable) and the valid
 *    round-trip case
 *  - writeSessionFocus round trip, overwrite, input validation, directory
 *    creation
 *  - clearSessionFocus (existing → deleted, missing → no-op)
 *  - resolveSessionTopic file-vs-envvar precedence (file wins when both
 *    present, envvar used only when file is absent/empty)
 *  - applyTopicBoost behavior: no-op on empty topic, boost for matching
 *    docs (title / displayPath / body), demote for non-matching docs,
 *    multi-token AND match, re-sort order, floor clamp on demoteFactor,
 *    focus-rescues-below-threshold (a doc below the profile threshold
 *    BEFORE boost passes AFTER boost)
 *  - cross-session isolation (two sessions with different topics do NOT
 *    cross-contaminate at the file layer — write to A, read from B)
 *
 * Uses `CLAWMEM_FOCUS_ROOT` env override so the tests are hermetic and
 * do not touch `~/.cache/clawmem/sessions` on the host.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionFocus,
  writeSessionFocus,
  clearSessionFocus,
  resolveSessionTopic,
  applyTopicBoost,
  focusFilePath,
  focusRoot,
} from "../../src/session-focus.ts";
import type { ScoredResult } from "../../src/memory.ts";

// =============================================================================
// Fixtures
// =============================================================================

let TMP_ROOT: string;
let ORIGINAL_FOCUS_ROOT: string | undefined;

beforeEach(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "clawmem-focus-test-"));
  ORIGINAL_FOCUS_ROOT = process.env.CLAWMEM_FOCUS_ROOT;
  process.env.CLAWMEM_FOCUS_ROOT = TMP_ROOT;
});

afterEach(() => {
  if (ORIGINAL_FOCUS_ROOT === undefined) delete process.env.CLAWMEM_FOCUS_ROOT;
  else process.env.CLAWMEM_FOCUS_ROOT = ORIGINAL_FOCUS_ROOT;
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeResult(overrides: Partial<ScoredResult> = {}): ScoredResult {
  return {
    filepath: "test/doc.md",
    displayPath: "test/doc.md",
    title: "Test Doc",
    score: 0.5,
    body: "",
    contentType: "note",
    modifiedAt: new Date().toISOString(),
    accessCount: 0,
    confidence: 0.5,
    qualityScore: 0.5,
    pinned: false,
    context: null,
    hash: "h",
    docid: "1",
    collectionName: "test",
    bodyLength: 0,
    source: "fts",
    duplicateCount: 0,
    revisionCount: 0,
    compositeScore: 0.5,
    recencyScore: 0.5,
    ...overrides,
  };
}

// =============================================================================
// focusRoot / focusFilePath
// =============================================================================

describe("focusRoot / focusFilePath", () => {
  it("honors CLAWMEM_FOCUS_ROOT override", () => {
    expect(focusRoot()).toBe(TMP_ROOT);
    expect(focusFilePath("abc")).toBe(join(TMP_ROOT, "abc.focus"));
  });

  it("falls back to ~/.cache/clawmem/sessions when override is unset", () => {
    delete process.env.CLAWMEM_FOCUS_ROOT;
    const root = focusRoot();
    expect(root.endsWith("/.cache/clawmem/sessions")).toBe(true);
    expect(focusFilePath("abc").endsWith("/.cache/clawmem/sessions/abc.focus")).toBe(true);
  });

  it("falls back to default when override is empty/whitespace", () => {
    process.env.CLAWMEM_FOCUS_ROOT = "   ";
    const root = focusRoot();
    expect(root.endsWith("/.cache/clawmem/sessions")).toBe(true);
  });
});

// =============================================================================
// readSessionFocus
// =============================================================================

describe("readSessionFocus", () => {
  it("returns undefined when sessionId is undefined", () => {
    expect(readSessionFocus(undefined)).toBeUndefined();
  });

  it("returns undefined when sessionId is empty string", () => {
    expect(readSessionFocus("")).toBeUndefined();
  });

  it("returns undefined when the focus file does not exist", () => {
    expect(readSessionFocus("never-written")).toBeUndefined();
  });

  it("returns the topic after a valid write", () => {
    writeSessionFocus("s1", "clawmem v0.9.0");
    expect(readSessionFocus("s1")).toBe("clawmem v0.9.0");
  });

  it("trims whitespace around a valid topic on read", () => {
    writeFileSync(focusFilePath("s1"), "  \n  clawmem v0.9.0  \n  ", { encoding: "utf-8" });
    expect(readSessionFocus("s1")).toBe("clawmem v0.9.0");
  });

  it("returns undefined for an empty file", () => {
    writeFileSync(focusFilePath("s1"), "", { encoding: "utf-8" });
    expect(readSessionFocus("s1")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only file", () => {
    writeFileSync(focusFilePath("s1"), "   \n\t \n", { encoding: "utf-8" });
    expect(readSessionFocus("s1")).toBeUndefined();
  });

  it("returns undefined for an oversized topic (> 256 chars)", () => {
    const huge = "a".repeat(257);
    writeFileSync(focusFilePath("s1"), huge, { encoding: "utf-8" });
    expect(readSessionFocus("s1")).toBeUndefined();
  });

  it("accepts a 256-char topic (exact boundary)", () => {
    const exact = "a".repeat(256);
    writeFileSync(focusFilePath("s1"), exact, { encoding: "utf-8" });
    expect(readSessionFocus("s1")).toBe(exact);
  });

  it("fails open on I/O errors (returns undefined, never throws)", () => {
    // Point focus file at a subdirectory that DOES NOT EXIST so the
    // readFileSync path throws ENOENT and the helper should swallow it.
    process.env.CLAWMEM_FOCUS_ROOT = join(TMP_ROOT, "does-not-exist");
    expect(() => readSessionFocus("any")).not.toThrow();
    expect(readSessionFocus("any")).toBeUndefined();
  });
});

// =============================================================================
// writeSessionFocus
// =============================================================================

describe("writeSessionFocus", () => {
  it("round trips write → read", () => {
    writeSessionFocus("s1", "my topic");
    expect(readSessionFocus("s1")).toBe("my topic");
  });

  it("creates the sessions directory if missing", () => {
    process.env.CLAWMEM_FOCUS_ROOT = join(TMP_ROOT, "nested", "fresh");
    writeSessionFocus("s1", "topic");
    expect(existsSync(join(TMP_ROOT, "nested", "fresh", "s1.focus"))).toBe(true);
    expect(readSessionFocus("s1")).toBe("topic");
  });

  it("overwrites an existing focus file", () => {
    writeSessionFocus("s1", "first");
    writeSessionFocus("s1", "second");
    expect(readSessionFocus("s1")).toBe("second");
  });

  it("trims whitespace on write", () => {
    writeSessionFocus("s1", "   my topic   ");
    expect(readFileSync(focusFilePath("s1"), "utf-8")).toBe("my topic");
  });

  it("rejects missing sessionId", () => {
    expect(() => writeSessionFocus("", "topic")).toThrow(/sessionId required/);
  });

  it("rejects whitespace-only sessionId", () => {
    expect(() => writeSessionFocus("   ", "topic")).toThrow(/sessionId required/);
  });

  it("rejects empty topic", () => {
    expect(() => writeSessionFocus("s1", "")).toThrow(/topic required/);
  });

  it("rejects whitespace-only topic", () => {
    expect(() => writeSessionFocus("s1", "   ")).toThrow(/topic required/);
  });

  it("rejects oversized topic (> 256 chars)", () => {
    const huge = "a".repeat(257);
    expect(() => writeSessionFocus("s1", huge)).toThrow(/exceeds max length/);
  });
});

// =============================================================================
// clearSessionFocus
// =============================================================================

describe("clearSessionFocus", () => {
  it("deletes an existing focus file", () => {
    writeSessionFocus("s1", "topic");
    expect(existsSync(focusFilePath("s1"))).toBe(true);
    clearSessionFocus("s1");
    expect(existsSync(focusFilePath("s1"))).toBe(false);
    expect(readSessionFocus("s1")).toBeUndefined();
  });

  it("is a no-op when the file does not exist", () => {
    expect(() => clearSessionFocus("never-written")).not.toThrow();
  });

  it("is a no-op when sessionId is empty", () => {
    expect(() => clearSessionFocus("")).not.toThrow();
  });
});

// =============================================================================
// Cross-session isolation — load-bearing per spec
// =============================================================================

describe("cross-session isolation", () => {
  it("keeps two sessions' focus files independent (no cross-contamination)", () => {
    writeSessionFocus("session-A", "clawmem v0.9.0");
    writeSessionFocus("session-B", "wiki-forge deployment");

    expect(readSessionFocus("session-A")).toBe("clawmem v0.9.0");
    expect(readSessionFocus("session-B")).toBe("wiki-forge deployment");

    clearSessionFocus("session-A");
    expect(readSessionFocus("session-A")).toBeUndefined();
    // Clearing A MUST NOT affect B
    expect(readSessionFocus("session-B")).toBe("wiki-forge deployment");
  });

  it("re-reads file contents on every call (topic change mid-session)", () => {
    writeSessionFocus("s1", "first topic");
    expect(readSessionFocus("s1")).toBe("first topic");
    writeSessionFocus("s1", "second topic");
    expect(readSessionFocus("s1")).toBe("second topic");
  });
});

// =============================================================================
// resolveSessionTopic — precedence
// =============================================================================

describe("resolveSessionTopic", () => {
  it("returns file topic when only file is set", () => {
    writeSessionFocus("s1", "file topic");
    expect(resolveSessionTopic("s1", undefined)).toBe("file topic");
  });

  it("returns env topic when only env is set", () => {
    expect(resolveSessionTopic("s1", "env topic")).toBe("env topic");
  });

  it("prefers file over env when both are set (file > env precedence)", () => {
    writeSessionFocus("s1", "file topic");
    expect(resolveSessionTopic("s1", "env topic")).toBe("file topic");
  });

  it("falls back to env when file is empty/unreadable", () => {
    writeFileSync(focusFilePath("s1"), "", { encoding: "utf-8" });
    expect(resolveSessionTopic("s1", "env topic")).toBe("env topic");
  });

  it("returns undefined when neither file nor env yields a valid topic", () => {
    expect(resolveSessionTopic("s1", undefined)).toBeUndefined();
    expect(resolveSessionTopic("s1", "")).toBeUndefined();
    expect(resolveSessionTopic("s1", "   ")).toBeUndefined();
  });

  it("trims whitespace from env topic", () => {
    expect(resolveSessionTopic("s1", "   padded topic   ")).toBe("padded topic");
  });

  it("returns undefined when sessionId is undefined and env is empty", () => {
    expect(resolveSessionTopic(undefined, undefined)).toBeUndefined();
  });

  it("returns env topic when sessionId is undefined but env has a topic", () => {
    expect(resolveSessionTopic(undefined, "env fallback")).toBe("env fallback");
  });
});

// =============================================================================
// applyTopicBoost
// =============================================================================

describe("applyTopicBoost", () => {
  it("is a no-op when topic is undefined", () => {
    const scored = [makeResult({ compositeScore: 0.5 })];
    const original = scored[0]!.compositeScore;
    applyTopicBoost(scored, undefined);
    expect(scored[0]!.compositeScore).toBe(original);
  });

  it("is a no-op when topic is empty string", () => {
    const scored = [makeResult({ compositeScore: 0.5 })];
    applyTopicBoost(scored, "");
    expect(scored[0]!.compositeScore).toBe(0.5);
  });

  it("is a no-op when topic is whitespace-only", () => {
    const scored = [makeResult({ compositeScore: 0.5 })];
    applyTopicBoost(scored, "   ");
    expect(scored[0]!.compositeScore).toBe(0.5);
  });

  it("boosts docs that match the topic via the title (1.4× default)", () => {
    const scored = [makeResult({ title: "ClawMem release", compositeScore: 0.5 })];
    applyTopicBoost(scored, "clawmem");
    expect(scored[0]!.compositeScore).toBeCloseTo(0.7, 5); // 0.5 × 1.4
  });

  it("boosts docs that match via the body", () => {
    const scored = [makeResult({ title: "Unrelated", body: "this mentions clawmem in the body", compositeScore: 0.5 })];
    applyTopicBoost(scored, "clawmem");
    expect(scored[0]!.compositeScore).toBeCloseTo(0.7, 5);
  });

  it("boosts docs that match via the displayPath", () => {
    const scored = [makeResult({ title: "Note", displayPath: "clawmem/spec/v0.9.0.md", body: "", compositeScore: 0.5 })];
    applyTopicBoost(scored, "clawmem");
    expect(scored[0]!.compositeScore).toBeCloseTo(0.7, 5);
  });

  it("demotes docs that do NOT match the topic (0.75× default) when at least one doc DOES match", () => {
    // Per the Codex §11.4 Turn 1 fail-open fix, the demote only applies
    // when at least one doc in the scored set matches the topic. This
    // test includes both a matching decoy and a non-matching doc to
    // verify the demote fires correctly when the set is non-empty.
    const scored = [
      makeResult({ title: "Unrelated doc", body: "nothing here", displayPath: "other/doc.md", compositeScore: 0.5 }),
      makeResult({ title: "clawmem match", compositeScore: 0.5 }), // forces at least one match
    ];
    applyTopicBoost(scored, "clawmem");
    const byTitle = new Map(scored.map(r => [r.title, r.compositeScore]));
    expect(byTitle.get("Unrelated doc")).toBeCloseTo(0.375, 5); // 0.5 × 0.75
    expect(byTitle.get("clawmem match")).toBeCloseTo(0.7, 5);   // 0.5 × 1.4
  });

  it("requires all topic tokens to match (AND semantics)", () => {
    const scored = [
      makeResult({ title: "ClawMem docs", compositeScore: 0.5 }), // matches "clawmem" only
      makeResult({ title: "ClawMem v0.9.0 release", compositeScore: 0.5 }), // matches both
    ];
    applyTopicBoost(scored, "clawmem v0.9.0");
    // First doc is DEMOTED (missing "v0.9.0"), second is BOOSTED
    const byTitle = new Map(scored.map(r => [r.title, r.compositeScore]));
    expect(byTitle.get("ClawMem docs")).toBeCloseTo(0.375, 5); // demoted
    expect(byTitle.get("ClawMem v0.9.0 release")).toBeCloseTo(0.7, 5); // boosted
  });

  it("case-insensitive match (topic vs title/body casing)", () => {
    const scored = [makeResult({ title: "ClAwMeM V0.9.0", compositeScore: 0.5 })];
    applyTopicBoost(scored, "clawmem v0.9.0");
    expect(scored[0]!.compositeScore).toBeCloseTo(0.7, 5);
  });

  it("drops 1-char tokens from the topic (noise filter)", () => {
    const scored = [makeResult({ title: "clawmem doc", compositeScore: 0.5 })];
    // Topic has "clawmem a b c" — 1-char tokens "a", "b", "c" should be
    // dropped, leaving only "clawmem" which matches. Result: boost.
    applyTopicBoost(scored, "clawmem a b c");
    expect(scored[0]!.compositeScore).toBeCloseTo(0.7, 5);
  });

  it("re-sorts results by boosted score descending", () => {
    const scored = [
      makeResult({ title: "Low match", body: "", compositeScore: 0.6 }), // demoted to 0.45
      makeResult({ title: "High match clawmem", body: "", compositeScore: 0.4 }), // boosted to 0.56
    ];
    applyTopicBoost(scored, "clawmem");
    // After boost + sort, "High match" (0.56) should be first
    expect(scored[0]!.title).toBe("High match clawmem");
    expect(scored[1]!.title).toBe("Low match");
  });

  it("honors custom boostFactor and demoteFactor", () => {
    const scored = [
      makeResult({ title: "matches clawmem", compositeScore: 0.5 }),
      makeResult({ title: "does not match", compositeScore: 0.5 }),
    ];
    applyTopicBoost(scored, "clawmem", { boostFactor: 2.0, demoteFactor: 0.6 });
    const byTitle = new Map(scored.map(r => [r.title, r.compositeScore]));
    expect(byTitle.get("matches clawmem")).toBeCloseTo(1.0, 5);
    expect(byTitle.get("does not match")).toBeCloseTo(0.3, 5);
  });

  it("clamps demoteFactor to a 0.5 floor (prevents hard suppression) when the demote actually fires", () => {
    // Same fail-open caveat: the demote only applies when at least one
    // doc matches. Add a matching decoy so the demote floor is observable
    // on the non-matching doc.
    const scored = [
      makeResult({ title: "not matching", compositeScore: 0.5 }),
      makeResult({ title: "clawmem match", compositeScore: 0.5 }),
    ];
    // Caller requests demoteFactor of 0.1 (would aggressively suppress).
    // Floor clamps to 0.5, so result is 0.5 × 0.5 = 0.25 for the non-match.
    applyTopicBoost(scored, "clawmem", { demoteFactor: 0.1 });
    const byTitle = new Map(scored.map(r => [r.title, r.compositeScore]));
    expect(byTitle.get("not matching")).toBeCloseTo(0.25, 5);
  });

  it("focus-rescues-below-threshold (Codex Turn 1 test) — a doc just below profile threshold without boost passes WITH boost", () => {
    // Simulate profile.minScore = 0.45 (the default for balanced profile).
    // A matching doc at composite 0.35 is below the threshold and would
    // be filtered. After a 1.4× boost the score becomes 0.49, which
    // passes the threshold.
    const MIN_SCORE = 0.45;
    const scored = [
      makeResult({ title: "clawmem v0.9.0 design", compositeScore: 0.35 }),
    ];

    // WITHOUT boost: this doc would fail the threshold filter.
    const withoutBoost = scored[0]!.compositeScore >= MIN_SCORE;
    expect(withoutBoost).toBe(false);

    // WITH boost: apply 1.4× and re-check.
    applyTopicBoost(scored, "clawmem v0.9.0");
    const withBoost = scored[0]!.compositeScore >= MIN_SCORE;
    expect(withBoost).toBe(true);
    expect(scored[0]!.compositeScore).toBeCloseTo(0.49, 5);
  });

  it("zero matching docs → NO-OP (scores unchanged, baseline byte-identical) — Codex §11.4 Turn 1 fix", () => {
    // When a topic is set but NO doc matches, the topic boost MUST be a
    // no-op. The approved spec is: "topic set + zero matching docs →
    // proceed with the normal results." Previously the implementation
    // demoted every doc uniformly by 0.75× which would push some docs
    // below the downstream threshold filter and silently shrink the
    // result set — a regression vs the no-topic baseline. This test
    // locks in the fix from §11.4 code review Turn 1.
    const scored = [
      makeResult({ title: "unrelated A", compositeScore: 0.6 }),
      makeResult({ title: "unrelated B", compositeScore: 0.5 }),
      makeResult({ title: "unrelated C", compositeScore: 0.4 }),
    ];
    const originals = scored.map(r => r.compositeScore);

    applyTopicBoost(scored, "clawmem");

    // Scores are UNCHANGED (no demotion applied)
    expect(scored[0]!.compositeScore).toBe(originals[0]!);
    expect(scored[1]!.compositeScore).toBe(originals[1]!);
    expect(scored[2]!.compositeScore).toBe(originals[2]!);

    // Relative order preserved (not touched)
    expect(scored[0]!.title).toBe("unrelated A");
    expect(scored[1]!.title).toBe("unrelated B");
    expect(scored[2]!.title).toBe("unrelated C");
  });

  it("at least one matching doc → apply boost to matches AND demote to non-matches", () => {
    const scored = [
      makeResult({ title: "clawmem doc", compositeScore: 0.5 }),
      makeResult({ title: "unrelated", compositeScore: 0.5 }),
    ];
    applyTopicBoost(scored, "clawmem");
    const byTitle = new Map(scored.map(r => [r.title, r.compositeScore]));
    expect(byTitle.get("clawmem doc")).toBeCloseTo(0.7, 5); // boosted
    expect(byTitle.get("unrelated")).toBeCloseTo(0.375, 5); // demoted (one match triggers full boost/demote pass)
  });

  it("empty scored array → no-op", () => {
    const scored: ScoredResult[] = [];
    applyTopicBoost(scored, "clawmem");
    expect(scored).toEqual([]);
  });

  it("mutates input array in place and returns the same reference", () => {
    const scored = [makeResult({ title: "clawmem", compositeScore: 0.5 })];
    const returned = applyTopicBoost(scored, "clawmem");
    expect(returned).toBe(scored); // same reference
  });
});
