import { describe, it, expect, beforeEach } from "bun:test";

/**
 * Tests for recall tracking (v0.7.0):
 * 1. hashQuery utility
 * 2. writeRecallEvents — direct write with doc_id resolution
 * 3. Store: recall_events + recall_stats schema and methods
 * 4. Scoring formulas: diversityScore, spacingScore
 * 5. Negative signal tracking (surfaced but not referenced)
 * 6. Session-scoped reference marking (latest event only)
 * 7. Lifecycle integration: active-doc scoping, collection/path in output
 * 8. contradict_confidence migration on memory_relations
 */

import { hashQuery, writeRecallEvents } from "../../src/recall-buffer.ts";
import { createStore, type RecallStatsRow } from "../../src/store.ts";
import {
  segmentTranscriptIntoTurns,
  attributeRecallReferences,
} from "../../src/recall-attribution.ts";

// ─── Test Helpers ───────────────────────────────────────────────────

/** Insert test documents with required FK (content table) */
function insertTestDocs(store: ReturnType<typeof createStore>, count: number = 3) {
  const docs = [
    { hash: "hash1", path: "doc1.md", title: "Doc One" },
    { hash: "hash2", path: "doc2.md", title: "Doc Two" },
    { hash: "hash3", path: "doc3.md", title: "Doc Three" },
  ].slice(0, count);

  for (const d of docs) {
    store.db.prepare(
      `INSERT INTO content (hash, doc, created_at) VALUES (?, ?, '2026-04-01')`
    ).run(d.hash, `# ${d.title}`);
    store.db.prepare(
      `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', ?, ?, ?, '2026-04-01', '2026-04-01', 1)`
    ).run(d.path, d.title, d.hash);
  }
}

// ─── hashQuery ──────────────────────────────────────────────────────

describe("hashQuery", () => {
  it("produces 12-char hex", () => {
    const h = hashQuery("test query");
    expect(h).toHaveLength(12);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is case-insensitive", () => {
    expect(hashQuery("Test Query")).toBe(hashQuery("test query"));
  });

  it("trims whitespace", () => {
    expect(hashQuery("  test query  ")).toBe(hashQuery("test query"));
  });
});

// ─── writeRecallEvents (direct write) ───────────────────────────────

describe("writeRecallEvents", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore(":memory:");
    insertTestDocs(store, 3);
  });

  it("resolves displayPath to doc_id and inserts", () => {
    const count = writeRecallEvents(store, "s1", "qhash1", [
      { displayPath: "notes/doc1.md", searchScore: 0.8 },
      { displayPath: "notes/doc2.md", searchScore: 0.6 },
    ]);
    expect(count).toBe(2);

    const rows = store.db.prepare("SELECT * FROM recall_events ORDER BY doc_id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].doc_id).toBe(1);
    expect(rows[0].query_hash).toBe("qhash1");
    expect(rows[0].was_referenced).toBe(0);
    expect(rows[1].doc_id).toBe(2);
  });

  it("skips unresolvable displayPaths silently", () => {
    const count = writeRecallEvents(store, "s1", "qhash1", [
      { displayPath: "notes/doc1.md", searchScore: 0.8 },
      { displayPath: "notes/nonexistent.md", searchScore: 0.5 },
      { displayPath: "notes/doc2.md", searchScore: 0.6 },
    ]);
    expect(count).toBe(2); // nonexistent skipped
  });

  it("returns 0 for empty docs", () => {
    expect(writeRecallEvents(store, "s1", "qh", [])).toBe(0);
  });

  it("returns 0 for empty sessionId", () => {
    expect(writeRecallEvents(store, "", "qh", [{ displayPath: "notes/doc1.md", searchScore: 0.5 }])).toBe(0);
  });

  it("handles all unresolvable docs gracefully", () => {
    const count = writeRecallEvents(store, "s1", "qh", [
      { displayPath: "bogus/nope.md", searchScore: 0.5 },
    ]);
    expect(count).toBe(0);
  });
});

// ─── Store: schema + methods ────────────────────────────────────────

describe("recall tracking store", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore(":memory:");
    insertTestDocs(store, 3);
  });

  it("recall_events table exists", () => {
    const tables = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recall_events'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("recall_stats table exists", () => {
    const tables = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recall_stats'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("contradict_confidence column exists on memory_relations", () => {
    const cols = store.db.prepare("PRAGMA table_info(memory_relations)").all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain("contradict_confidence");
  });

  it("insertRecallEvents tracks was_referenced flag", () => {
    store.insertRecallEvents([
      { docId: 1, queryHash: "aa", searchScore: 0.8, sessionId: "s1", wasReferenced: true },
      { docId: 2, queryHash: "aa", searchScore: 0.6, sessionId: "s1", wasReferenced: false },
    ]);
    const rows = store.db.prepare("SELECT doc_id, was_referenced FROM recall_events ORDER BY doc_id").all() as any[];
    expect(rows[0].was_referenced).toBe(1);
    expect(rows[1].was_referenced).toBe(0);
  });

  it("getRecallStats returns null for unknown doc", () => {
    expect(store.getRecallStats(999)).toBeNull();
  });
});

// ─── Session-scoped reference marking (Finding 1 fix) ──────────────

describe("markRecallEventsReferenced (latest-only)", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore(":memory:");
    insertTestDocs(store, 1);
  });

  it("marks only the latest event per doc, not all session events", () => {
    // Simulate doc1 surfaced across 3 prompts in one session
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const ts = new Date(now.getTime() + i * 60000).toISOString();
      store.db.prepare(
        `INSERT INTO recall_events (doc_id, query_hash, search_score, session_id, surfaced_at, was_referenced) VALUES (1, ?, 0.5, 's1', ?, 0)`
      ).run(`q${i}`, ts);
    }

    // Mark doc1 as referenced — should only flip the latest event
    store.markRecallEventsReferenced("s1", [1]);

    const rows = store.db.prepare(
      "SELECT id, was_referenced FROM recall_events ORDER BY surfaced_at"
    ).all() as any[];

    expect(rows).toHaveLength(3);
    expect(rows[0].was_referenced).toBe(0); // oldest — NOT marked
    expect(rows[1].was_referenced).toBe(0); // middle — NOT marked
    expect(rows[2].was_referenced).toBe(1); // latest — marked
  });

  it("does not cross-contaminate sessions", () => {
    store.insertRecallEvents([
      { docId: 1, queryHash: "aa", searchScore: 0.8, sessionId: "s1" },
      { docId: 1, queryHash: "bb", searchScore: 0.7, sessionId: "s2" },
    ]);

    store.markRecallEventsReferenced("s1", [1]);

    const rows = store.db.prepare(
      "SELECT session_id, was_referenced FROM recall_events ORDER BY id"
    ).all() as any[];
    expect(rows[0].was_referenced).toBe(1); // s1 — marked
    expect(rows[1].was_referenced).toBe(0); // s2 — not touched
  });
});

// ─── Recall Stats Computation ───────────────────────────────────────

describe("recall stats recomputation", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore(":memory:");
    insertTestDocs(store, 1);
  });

  it("returns 0 with no events", () => {
    expect(store.recomputeRecallStats()).toBe(0);
  });

  it("computes basic counts", () => {
    store.insertRecallEvents([
      { docId: 1, queryHash: "aabb", searchScore: 0.8, sessionId: "s1" },
      { docId: 1, queryHash: "ccdd", searchScore: 0.6, sessionId: "s1" },
      { docId: 1, queryHash: "aabb", searchScore: 0.7, sessionId: "s2" },
    ]);

    store.recomputeRecallStats();
    const stats = store.getRecallStats(1);
    expect(stats).not.toBeNull();
    expect(stats!.recallCount).toBe(3);
    expect(stats!.uniqueQueries).toBe(2);
    expect(stats!.totalScore).toBeCloseTo(2.1);
    expect(stats!.maxScore).toBeCloseTo(0.8);
  });

  it("tracks negative signals correctly", () => {
    store.insertRecallEvents([
      { docId: 1, queryHash: "aa", searchScore: 0.8, sessionId: "s1", wasReferenced: true },
      { docId: 1, queryHash: "bb", searchScore: 0.6, sessionId: "s1", wasReferenced: false },
      { docId: 1, queryHash: "cc", searchScore: 0.5, sessionId: "s2", wasReferenced: false },
    ]);

    store.recomputeRecallStats();
    const stats = store.getRecallStats(1);
    expect(stats!.negativeCount).toBe(2);
  });

  it("getRecallStatsAll filters by minRecallCount and joins active docs", () => {
    store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES ('hash2', '# Doc Two', '2026-04-01')`).run();
    store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', 'doc2.md', 'Doc Two', 'hash2', '2026-04-01', '2026-04-01', 1)`).run();

    store.insertRecallEvents([
      { docId: 1, queryHash: "aa", searchScore: 0.8, sessionId: "s1" },
      { docId: 1, queryHash: "bb", searchScore: 0.6, sessionId: "s2" },
      { docId: 1, queryHash: "cc", searchScore: 0.5, sessionId: "s3" },
      { docId: 2, queryHash: "aa", searchScore: 0.4, sessionId: "s1" },
    ]);

    store.recomputeRecallStats();

    const filtered = store.getRecallStatsAll(3);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.docId).toBe(1);
    // Should include collection/path/title from JOIN
    expect(filtered[0]!.collection).toBe("notes");
    expect(filtered[0]!.path).toBe("doc1.md");
    expect(filtered[0]!.title).toBe("Doc One");
  });

  it("getRecallStatsAll excludes inactive docs", () => {
    store.insertRecallEvents([
      { docId: 1, queryHash: "aa", searchScore: 0.8, sessionId: "s1" },
    ]);
    store.recomputeRecallStats();

    // Deactivate the doc
    store.db.prepare("UPDATE documents SET active = 0 WHERE id = 1").run();

    const stats = store.getRecallStatsAll(1);
    expect(stats).toHaveLength(0);
  });
});

// ─── Diversity + Spacing Scores ─────────────────────────────────────

describe("diversity and spacing scores", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore(":memory:");
    insertTestDocs(store, 1);
  });

  it("diversityScore scales with distinct queries", () => {
    // 1 unique query → max(1,1)/5 = 0.2
    store.insertRecallEvents([
      { docId: 1, queryHash: "same", searchScore: 0.8, sessionId: "s1" },
      { docId: 1, queryHash: "same", searchScore: 0.7, sessionId: "s2" },
    ]);
    store.recomputeRecallStats();
    expect(store.getRecallStats(1)!.diversityScore).toBeCloseTo(0.2);
  });

  it("diversityScore caps at 1.0 for 5+ queries", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      docId: 1, queryHash: `q${i}`, searchScore: 0.5, sessionId: "s1",
    }));
    store.insertRecallEvents(events);
    store.recomputeRecallStats();
    expect(store.getRecallStats(1)!.diversityScore).toBe(1.0);
  });

  it("spacingScore is 0.2 baseline for single day", () => {
    store.insertRecallEvents([
      { docId: 1, queryHash: "q1", searchScore: 0.8, sessionId: "s1" },
      { docId: 1, queryHash: "q2", searchScore: 0.7, sessionId: "s1" },
    ]);
    store.recomputeRecallStats();
    expect(store.getRecallStats(1)!.spacingScore).toBeCloseTo(0.2);
  });

  it("spacingScore increases with multi-day spread", () => {
    const now = new Date();
    for (const d of [0, 2, 5, 7]) {
      const dt = new Date(now);
      dt.setDate(dt.getDate() - d);
      store.db.prepare(
        `INSERT INTO recall_events (doc_id, query_hash, search_score, session_id, surfaced_at, was_referenced) VALUES (1, ?, 0.5, 's1', ?, 0)`
      ).run(`q${d}`, dt.toISOString());
    }
    store.recomputeRecallStats();
    const stats = store.getRecallStats(1);
    expect(stats!.spacingScore).toBeGreaterThan(0.4);
    expect(stats!.recallDays).toBe(4);
  });

  it("spacingScore capped at 1.0", () => {
    const now = new Date();
    for (let d = 0; d < 15; d += 2) {
      const dt = new Date(now);
      dt.setDate(dt.getDate() - d);
      store.db.prepare(
        `INSERT INTO recall_events (doc_id, query_hash, search_score, session_id, surfaced_at, was_referenced) VALUES (1, ?, 0.5, 's1', ?, 0)`
      ).run(`q${d}`, dt.toISOString());
    }
    store.recomputeRecallStats();
    expect(store.getRecallStats(1)!.spacingScore).toBeLessThanOrEqual(1.0);
  });
});

// ─── Transcript Segmentation ────────────────────────────────────────

describe("segmentTranscriptIntoTurns", () => {
  it("segments user-assistant pairs into turns", () => {
    const turns = segmentTranscriptIntoTurns([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what is doc1?" },
      { role: "assistant", content: "doc1.md is about testing" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.userText).toBe("hello");
    expect(turns[0]!.assistantText).toBe("hi there");
    expect(turns[1]!.userText).toBe("what is doc1?");
    expect(turns[1]!.assistantText).toBe("doc1.md is about testing");
  });

  it("concatenates multiple assistant messages in one turn", () => {
    const turns = segmentTranscriptIntoTurns([
      { role: "user", content: "query" },
      { role: "assistant", content: "part 1" },
      { role: "assistant", content: "part 2" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.assistantText).toBe("part 1\npart 2");
  });

  it("ignores system messages", () => {
    const turns = segmentTranscriptIntoTurns([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe("hello");
  });

  it("handles empty input", () => {
    expect(segmentTranscriptIntoTurns([])).toHaveLength(0);
  });
});

// ─── Per-turn Attribution via attributeRecallReferences ─────────────

describe("attributeRecallReferences (per-turn)", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore(":memory:");
    insertTestDocs(store, 2);
  });

  it("turn_index and usage_id columns exist on recall_events", () => {
    const cols = store.db.prepare("PRAGMA table_info(recall_events)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain("usage_id");
    expect(names).toContain("turn_index");
  });

  it("turn_index column exists on context_usage", () => {
    const cols = store.db.prepare("PRAGMA table_info(context_usage)").all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain("turn_index");
  });

  it("doc cited in turn 1 only — turn 1 marked, turn 2 not", () => {
    // Turn 0: doc1 injected, assistant cites it
    const u0 = store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:00:00Z",
      hookName: "context-surfacing", injectedPaths: ["notes/doc1.md"],
      estimatedTokens: 100, wasReferenced: 0, turnIndex: 0,
    });
    store.insertRecallEvents([
      { docId: 1, queryHash: "q0", searchScore: 0.8, sessionId: "s1", usageId: u0, turnIndex: 0 },
    ]);

    // Turn 1: doc1 injected again, assistant does NOT cite it
    const u1 = store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:05:00Z",
      hookName: "context-surfacing", injectedPaths: ["notes/doc1.md"],
      estimatedTokens: 100, wasReferenced: 0, turnIndex: 1,
    });
    store.insertRecallEvents([
      { docId: 1, queryHash: "q1", searchScore: 0.6, sessionId: "s1", usageId: u1, turnIndex: 1 },
    ]);

    // Transcript: turn 0 cites doc1.md, turn 1 does not
    const turns = [
      { userText: "tell me about doc1", assistantText: "notes/doc1.md contains testing info" },
      { userText: "what about doc2?", assistantText: "I don't have info on doc2" },
    ];

    const usages = store.getUsageForSession("s1");
    attributeRecallReferences(store, "s1", usages, turns);

    const events = store.db.prepare(
      "SELECT turn_index, was_referenced FROM recall_events WHERE doc_id = 1 ORDER BY turn_index"
    ).all() as any[];

    expect(events).toHaveLength(2);
    expect(events[0].turn_index).toBe(0);
    expect(events[0].was_referenced).toBe(1); // turn 0 — cited
    expect(events[1].turn_index).toBe(1);
    expect(events[1].was_referenced).toBe(0); // turn 1 — NOT cited
  });

  it("doc cited in turn 2 only — turn 1 not marked, turn 2 marked", () => {
    const u0 = store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:00:00Z",
      hookName: "context-surfacing", injectedPaths: ["notes/doc1.md"],
      estimatedTokens: 100, wasReferenced: 0, turnIndex: 0,
    });
    store.insertRecallEvents([
      { docId: 1, queryHash: "q0", searchScore: 0.8, sessionId: "s1", usageId: u0, turnIndex: 0 },
    ]);

    const u1 = store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:05:00Z",
      hookName: "context-surfacing", injectedPaths: ["notes/doc1.md"],
      estimatedTokens: 100, wasReferenced: 0, turnIndex: 1,
    });
    store.insertRecallEvents([
      { docId: 1, queryHash: "q1", searchScore: 0.6, sessionId: "s1", usageId: u1, turnIndex: 1 },
    ]);

    const turns = [
      { userText: "hello", assistantText: "how can I help?" },
      { userText: "tell me about doc1", assistantText: "doc1.md contains testing info" },
    ];

    attributeRecallReferences(store, "s1", store.getUsageForSession("s1"), turns);

    const events = store.db.prepare(
      "SELECT turn_index, was_referenced FROM recall_events WHERE doc_id = 1 ORDER BY turn_index"
    ).all() as any[];

    expect(events[0].was_referenced).toBe(0); // turn 0 — NOT cited
    expect(events[1].was_referenced).toBe(1); // turn 1 — cited
  });

  it("two docs in one turn, only one referenced", () => {
    const u0 = store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:00:00Z",
      hookName: "context-surfacing", injectedPaths: ["notes/doc1.md", "notes/doc2.md"],
      estimatedTokens: 100, wasReferenced: 0, turnIndex: 0,
    });
    store.insertRecallEvents([
      { docId: 1, queryHash: "q0", searchScore: 0.8, sessionId: "s1", usageId: u0, turnIndex: 0 },
      { docId: 2, queryHash: "q0", searchScore: 0.6, sessionId: "s1", usageId: u0, turnIndex: 0 },
    ]);

    const turns = [
      { userText: "what do I know?", assistantText: "Based on doc1.md, you have testing notes" },
    ];

    attributeRecallReferences(store, "s1", store.getUsageForSession("s1"), turns);

    const e1 = store.db.prepare("SELECT was_referenced FROM recall_events WHERE doc_id = 1").get() as any;
    const e2 = store.db.prepare("SELECT was_referenced FROM recall_events WHERE doc_id = 2").get() as any;

    expect(e1.was_referenced).toBe(1); // doc1 cited
    expect(e2.was_referenced).toBe(0); // doc2 NOT cited
  });

  it("empty injected_paths turn does not crash", () => {
    store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:00:00Z",
      hookName: "context-surfacing", injectedPaths: [],
      estimatedTokens: 0, wasReferenced: 0, turnIndex: 0,
    });

    const turns = [{ userText: "hello", assistantText: "hi" }];

    // Should not throw
    attributeRecallReferences(store, "s1", store.getUsageForSession("s1"), turns);
  });

  it("turn_index drift: empty turn 0, injected turn 1 — correct alignment", () => {
    // Turn 0: no context injected (empty paths, logged for alignment)
    store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:00:00Z",
      hookName: "context-surfacing", injectedPaths: [],
      estimatedTokens: 0, wasReferenced: 0, turnIndex: 0,
    });

    // Turn 1: doc1 injected and cited
    const u1 = store.insertUsage({
      sessionId: "s1", timestamp: "2026-04-08T10:05:00Z",
      hookName: "context-surfacing", injectedPaths: ["notes/doc1.md"],
      estimatedTokens: 100, wasReferenced: 0, turnIndex: 1,
    });
    store.insertRecallEvents([
      { docId: 1, queryHash: "q1", searchScore: 0.8, sessionId: "s1", usageId: u1, turnIndex: 1 },
    ]);

    // Transcript: turn 0 is a greeting (no context), turn 1 cites doc1
    const turns = [
      { userText: "hello", assistantText: "hi there" },
      { userText: "tell me about doc1", assistantText: "notes/doc1.md has the info" },
    ];

    attributeRecallReferences(store, "s1", store.getUsageForSession("s1"), turns);

    const events = store.db.prepare(
      "SELECT turn_index, was_referenced FROM recall_events WHERE doc_id = 1"
    ).all() as any[];

    expect(events).toHaveLength(1);
    expect(events[0].turn_index).toBe(1);
    expect(events[0].was_referenced).toBe(1); // correctly attributed to turn 1
  });
});
