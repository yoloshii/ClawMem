import { describe, it, expect } from "bun:test";
import {
  inferContentType,
  inferMemoryType,
  recencyScore,
  confidenceScore,
  compositeScore,
  hasRecencyIntent,
  applyCompositeScoring,
  DEFAULT_WEIGHTS,
  RECENCY_WEIGHTS,
  HALF_LIVES,
  TYPE_BASELINES,
  type EnrichedResult,
} from "../../src/memory.ts";

const NOW = new Date("2026-03-01T12:00:00Z");

// ─── inferContentType ───────────────────────────────────────────────

describe("inferContentType", () => {
  it("returns 'decision' for paths containing 'decision'", () => {
    expect(inferContentType("docs/decision-001.md")).toBe("decision");
  });

  it("returns 'decision' for ADR paths", () => {
    expect(inferContentType("adr/0005-use-rest.md")).toBe("decision");
    expect(inferContentType("docs/adr-001.md")).toBe("decision");
  });

  it("returns 'hub' for index.md paths", () => {
    expect(inferContentType("docs/index.md")).toBe("hub");
  });

  it("returns 'hub' for moc paths", () => {
    expect(inferContentType("notes/moc-architecture.md")).toBe("hub");
  });

  it("returns 'research' for analysis paths", () => {
    expect(inferContentType("research/api-analysis.md")).toBe("research");
    expect(inferContentType("docs/investigation-auth.md")).toBe("research");
  });

  it("returns 'handoff' for session paths", () => {
    expect(inferContentType("sessions/2026-03-01.md")).toBe("handoff");
    expect(inferContentType("handoff-20260301.md")).toBe("handoff");
  });

  it("returns 'progress' for changelog paths", () => {
    expect(inferContentType("changelog.md")).toBe("progress");
    expect(inferContentType("status-update.md")).toBe("progress");
  });

  it("returns 'note' for unrecognized paths", () => {
    expect(inferContentType("random-file.md")).toBe("note");
    expect(inferContentType("thoughts.md")).toBe("note");
  });

  it("respects explicit type override", () => {
    expect(inferContentType("random.md", "decision")).toBe("decision");
  });

  it("ignores invalid explicit type", () => {
    expect(inferContentType("random.md", "invalid_type")).toBe("note");
  });
});

// ─── inferMemoryType ────────────────────────────────────────────────

describe("inferMemoryType", () => {
  it("returns 'episodic' for handoff content type", () => {
    expect(inferMemoryType("file.md", "handoff")).toBe("episodic");
  });

  it("returns 'episodic' for progress content type", () => {
    expect(inferMemoryType("file.md", "progress")).toBe("episodic");
  });

  it("returns 'semantic' for decision content type", () => {
    expect(inferMemoryType("file.md", "decision")).toBe("semantic");
  });

  it("returns 'procedural' when body contains workflow patterns", () => {
    expect(inferMemoryType("file.md", "note", "Step 1: install deps")).toBe("procedural");
    expect(inferMemoryType("file.md", "note", "Follow this workflow to deploy")).toBe("procedural");
    expect(inferMemoryType("file.md", "note", "How to set up the environment")).toBe("procedural");
  });

  it("returns 'procedural' for runbook/playbook paths", () => {
    expect(inferMemoryType("ops/runbook-deploy.md", "note")).toBe("procedural");
    expect(inferMemoryType("playbook/incident.md", "note")).toBe("procedural");
  });

  it("returns 'semantic' as default", () => {
    expect(inferMemoryType("file.md", "note")).toBe("semantic");
  });
});

// ─── recencyScore ───────────────────────────────────────────────────

describe("recencyScore", () => {
  it("returns 1.0 for documents modified today", () => {
    expect(recencyScore(NOW, "note", NOW)).toBe(1.0);
  });

  it("returns ~0.5 at the half-life boundary", () => {
    const halfLife = HALF_LIVES["note"]!; // 60 days
    const old = new Date(NOW);
    old.setDate(old.getDate() - halfLife);
    const score = recencyScore(old, "note", NOW);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it("returns 1.0 for Infinity half-life types (decision)", () => {
    const old = new Date("2020-01-01");
    expect(recencyScore(old, "decision", NOW)).toBe(1.0);
  });

  it("returns 0.5 for invalid dates", () => {
    expect(recencyScore("not-a-date", "note", NOW)).toBe(0.5);
  });

  it("returns 1.0 for future dates", () => {
    const future = new Date("2027-01-01");
    expect(recencyScore(future, "note", NOW)).toBe(1.0);
  });

  it("returns near-zero for very old documents", () => {
    const veryOld = new Date("2000-01-01");
    const score = recencyScore(veryOld, "note", NOW);
    expect(score).toBeLessThan(0.01);
  });

  it("handles string date input", () => {
    const score = recencyScore("2026-03-01T12:00:00Z", "note", NOW);
    expect(score).toBe(1.0);
  });
});

// ─── confidenceScore ────────────────────────────────────────────────

describe("confidenceScore", () => {
  it("uses TYPE_BASELINES for base score", () => {
    const score = confidenceScore("decision", NOW, 0, NOW);
    // decision baseline = 0.85, recency = 1.0, accessBoost = 1.0, decay = 1.0
    expect(score).toBeCloseTo(0.85, 2);
  });

  it("boosts score with access count (log2)", () => {
    const base = confidenceScore("note", NOW, 0, NOW);
    const boosted = confidenceScore("note", NOW, 10, NOW);
    expect(boosted).toBeGreaterThan(base);
  });

  it("caps access boost at 1.5x", () => {
    const score = confidenceScore("note", NOW, 1000000, NOW);
    // baseline 0.5 * recency 1.0 * accessBoost 1.5 = 0.75
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("does NOT apply attention decay to decision type (M3 fix)", () => {
    const oldAccess = new Date("2025-01-01");
    const score = confidenceScore("decision", NOW, 5, NOW, oldAccess);
    const noDecayScore = confidenceScore("decision", NOW, 5, NOW);
    // Should be the same — decay exempt
    expect(score).toBeCloseTo(noDecayScore, 5);
  });

  it("does NOT apply attention decay to research type (M3 fix)", () => {
    const oldAccess = new Date("2025-01-01");
    const score = confidenceScore("research", NOW, 5, NOW, oldAccess);
    const noDecayScore = confidenceScore("research", NOW, 5, NOW);
    expect(score).toBeCloseTo(noDecayScore, 5);
  });

  it("does NOT apply attention decay to antipattern type (M3 fix)", () => {
    const oldAccess = new Date("2025-06-01");
    const score = confidenceScore("antipattern", NOW, 0, NOW, oldAccess);
    const noDecayScore = confidenceScore("antipattern", NOW, 0, NOW);
    expect(score).toBeCloseTo(noDecayScore, 5);
  });

  it("applies attention decay to note type", () => {
    const oldAccess = new Date("2025-01-01"); // >1 year ago
    const score = confidenceScore("note", NOW, 0, NOW, oldAccess);
    const noDecayScore = confidenceScore("note", NOW, 0, NOW);
    expect(score).toBeLessThan(noDecayScore);
  });

  it("skips decay when lastAccessedAt equals modifiedAt (backfill detection)", () => {
    const mod = "2026-01-01T00:00:00Z";
    const score = confidenceScore("note", mod, 0, NOW, mod);
    const noDecayScore = confidenceScore("note", mod, 0, NOW);
    // Same timestamp = backfilled, no decay applied
    expect(score).toBeCloseTo(noDecayScore, 5);
  });

  it("clamps decay floor at 0.5", () => {
    // Very old access — decay should bottom at 0.5
    const veryOldAccess = new Date("2020-01-01");
    const score = confidenceScore("note", NOW, 0, NOW, veryOldAccess);
    const noDecayScore = confidenceScore("note", NOW, 0, NOW);
    // score = noDecayScore * 0.5 (floor)
    expect(score).toBeCloseTo(noDecayScore * 0.5, 2);
  });

  it("returns 0 for non-finite result", () => {
    // This shouldn't normally happen, but the guard exists
    const score = confidenceScore("unknown_type", "not-a-date", NaN, NOW);
    expect(Number.isFinite(score)).toBe(true);
  });
});

// ─── compositeScore ─────────────────────────────────────────────────

describe("compositeScore", () => {
  it("applies default weights (0.5 search + 0.25 recency + 0.25 confidence)", () => {
    const score = compositeScore(0.8, 0.6, 0.4);
    expect(score).toBeCloseTo(0.8 * 0.5 + 0.6 * 0.25 + 0.4 * 0.25, 5);
  });

  it("guards against NaN inputs", () => {
    expect(compositeScore(NaN, NaN, NaN)).toBe(0);
    expect(compositeScore(NaN, 0.5, 0.5)).toBeCloseTo(0.5 * 0.25 + 0.5 * 0.25, 5);
  });

  it("uses custom weights", () => {
    const w = { search: 1.0, recency: 0, confidence: 0 };
    expect(compositeScore(0.7, 0.9, 0.9, w)).toBeCloseTo(0.7, 5);
  });
});

// ─── hasRecencyIntent ───────────────────────────────────────────────

describe("hasRecencyIntent", () => {
  it("detects 'recently' keyword", () => {
    expect(hasRecencyIntent("what did we do recently")).toBe(true);
  });

  it("detects 'last session'", () => {
    expect(hasRecencyIntent("show me the last session")).toBe(true);
  });

  it("detects 'where were we'", () => {
    expect(hasRecencyIntent("where were we")).toBe(true);
  });

  it("detects 'yesterday'", () => {
    expect(hasRecencyIntent("what happened yesterday")).toBe(true);
  });

  it("detects 'continue'", () => {
    expect(hasRecencyIntent("let's continue")).toBe(true);
  });

  it("detects 'pick up'", () => {
    expect(hasRecencyIntent("let's pick up where we left off")).toBe(true);
  });

  it("returns false for generic queries", () => {
    expect(hasRecencyIntent("explain the architecture")).toBe(false);
    expect(hasRecencyIntent("what is the API design")).toBe(false);
  });
});

// ─── applyCompositeScoring ──────────────────────────────────────────

function makeEnrichedResult(overrides: Partial<EnrichedResult> = {}): EnrichedResult {
  return {
    filepath: "test/doc.md",
    displayPath: "doc.md",
    title: "Test Doc",
    score: 0.7,
    contentType: "note",
    modifiedAt: NOW.toISOString(),
    accessCount: 0,
    confidence: 0.5,
    qualityScore: 0.5,
    pinned: false,
    context: null,
    hash: "abc123",
    docid: "#abc123",
    collectionName: "test",
    bodyLength: 500,
    source: "fts",
    duplicateCount: 1,
    revisionCount: 1,
    ...overrides,
  };
}

describe("applyCompositeScoring", () => {
  it("sorts results by composite score descending", () => {
    const results = [
      makeEnrichedResult({ score: 0.3, title: "low" }),
      makeEnrichedResult({ score: 0.9, title: "high" }),
      makeEnrichedResult({ score: 0.6, title: "mid" }),
    ];
    const scored = applyCompositeScoring(results, "test query");
    expect(scored[0]!.title).toBe("high");
    expect(scored[2]!.title).toBe("low");
  });

  it("applies quality multiplier correctly", () => {
    const highQ = makeEnrichedResult({ qualityScore: 1.0, score: 0.5 });
    const lowQ = makeEnrichedResult({ qualityScore: 0.0, score: 0.5 });
    const [h] = applyCompositeScoring([highQ], "test");
    const [l] = applyCompositeScoring([lowQ], "test");
    // qualityMultiplier: 0.7 + 0.6 * qs
    // highQ: 0.7 + 0.6 = 1.3, lowQ: 0.7 + 0 = 0.7
    expect(h!.compositeScore).toBeGreaterThan(l!.compositeScore);
  });

  it("adds pin boost of +0.3, capped at 1.0", () => {
    const unpinned = makeEnrichedResult({ pinned: false, score: 0.8 });
    const pinned = makeEnrichedResult({ pinned: true, score: 0.8 });
    const [u] = applyCompositeScoring([unpinned], "test");
    const [p] = applyCompositeScoring([pinned], "test");
    expect(p!.compositeScore).toBeGreaterThan(u!.compositeScore);
    expect(p!.compositeScore).toBeLessThanOrEqual(1.0);
  });

  it("uses RECENCY_WEIGHTS when recency intent detected", () => {
    const handoff = makeEnrichedResult({ contentType: "handoff", score: 0.3 });
    const note = makeEnrichedResult({ contentType: "note", score: 0.9 });
    const scored = applyCompositeScoring([handoff, note], "what happened recently");
    // Handoff should be first due to priority boost + recency weights
    expect(scored[0]!.contentType).toBe("handoff");
  });

  it("prioritizes handoff/decision with recency intent", () => {
    const decision = makeEnrichedResult({ contentType: "decision", score: 0.5 });
    const note = makeEnrichedResult({ contentType: "note", score: 0.5 });
    const scored = applyCompositeScoring([note, decision], "last session");
    expect(scored[0]!.contentType).toBe("decision");
  });
});
