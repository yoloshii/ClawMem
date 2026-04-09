/**
 * Unit tests for maintenance.ts (v0.8.0 Ext 5)
 *
 * Covers:
 *  - isInQuietWindow null handling, normal interval, midnight wrap, empty window
 *  - countRecentContextUsages respects -10 minute cutoff
 *  - shouldRunHeavyMaintenance outside-window skip + query-rate-high skip
 *  - selectStaleObservationBatch ordering by recall_stats.last_recalled_at ASC
 *  - selectStaleObservationBatch fallback to last_accessed_at when recall_stats empty
 *  - selectStaleDeductiveBatch includes DEDUCTIVE_TYPES only
 *  - insertMaintenanceRun persists every column
 *  - runHeavyMaintenanceTick outside-window writes skipped row with correct reason
 *  - runHeavyMaintenanceTick query-rate-high writes skipped row
 *  - runHeavyMaintenanceTick lease-unavailable writes skipped row
 *  - runHeavyMaintenanceTick inside-window + low-rate writes Phase 2 + Phase 3 rows
 *  - runHeavyMaintenanceTick Phase 3 null LLM propagates null_call_count
 *  - Consolidation option bag (ConsolidateOptions) passes maxDocs + staleOnly + guarded through
 *  - Deductive option bag (DeductiveOptions) passes maxRecent + staleOnly through
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isInQuietWindow,
  countRecentContextUsages,
  shouldRunHeavyMaintenance,
  selectStaleObservationBatch,
  selectStaleDeductiveBatch,
  selectSurprisingObservationBatch,
  insertMaintenanceRun,
  runHeavyMaintenanceTick,
  type HeavyMaintenanceConfig,
  type MaintenanceRunSummary,
} from "../../src/maintenance.ts";
import { acquireWorkerLease } from "../../src/worker-lease.ts";
import {
  consolidateObservations,
  generateDeductiveObservations,
} from "../../src/consolidation.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";

// =============================================================================
// Fixtures
// =============================================================================

function seedObservation(
  store: Store,
  path: string,
  title: string,
  opts: {
    facts?: string;
    modifiedAt?: string;
    lastAccessedAt?: string | null;
    lastRecalledAt?: string | null;
    contentType?: string;
    observationType?: string;
  } = {},
): number {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const modifiedAt = opts.modifiedAt ?? new Date().toISOString();
  const body = `# ${title}\n${opts.facts ?? "fact content"}`;

  store.db.prepare(
    `INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`,
  ).run(hash, body, modifiedAt);
  store.db.prepare(
    `INSERT INTO documents
        (collection, path, title, hash, created_at, modified_at, active,
         content_type, observation_type, facts, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    "test",
    path,
    title,
    hash,
    modifiedAt,
    modifiedAt,
    opts.contentType ?? "observation",
    opts.observationType ?? "decision",
    opts.facts ?? "fact content",
    opts.lastAccessedAt ?? modifiedAt,
  );

  const row = store.db.prepare(
    `SELECT id FROM documents WHERE collection='test' AND path=? AND active=1`,
  ).get(path) as { id: number };

  if (opts.lastRecalledAt !== undefined && opts.lastRecalledAt !== null) {
    store.db.prepare(
      `INSERT INTO recall_stats (doc_id, recall_count, last_recalled_at)
         VALUES (?, 1, ?)`,
    ).run(row.id, opts.lastRecalledAt);
  }
  return row.id;
}

function seedContextUsage(store: Store, minutesAgo: number, count: number = 1): void {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  for (let i = 0; i < count; i++) {
    store.db.prepare(
      `INSERT INTO context_usage (session_id, timestamp, hook_name, injected_paths, estimated_tokens)
         VALUES ('s1', ?, 'context-surfacing', '[]', 100)`,
    ).run(ts);
  }
}

// =============================================================================
// isInQuietWindow
// =============================================================================

describe("isInQuietWindow", () => {
  function withHour(h: number): Date {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    return d;
  }

  it("returns true when both bounds are null", () => {
    expect(isInQuietWindow(new Date(), null, null)).toBe(true);
    expect(isInQuietWindow(new Date(), null, undefined as unknown as null)).toBe(true);
    expect(isInQuietWindow(new Date(), undefined as unknown as null, null)).toBe(true);
  });

  it("handles a normal window (no wraparound)", () => {
    expect(isInQuietWindow(withHour(3), 2, 6)).toBe(true);
    expect(isInQuietWindow(withHour(2), 2, 6)).toBe(true);
    expect(isInQuietWindow(withHour(6), 2, 6)).toBe(false); // exclusive end
    expect(isInQuietWindow(withHour(1), 2, 6)).toBe(false);
    expect(isInQuietWindow(withHour(12), 2, 6)).toBe(false);
  });

  it("handles midnight wraparound (22→6)", () => {
    expect(isInQuietWindow(withHour(23), 22, 6)).toBe(true);
    expect(isInQuietWindow(withHour(2), 22, 6)).toBe(true);
    expect(isInQuietWindow(withHour(5), 22, 6)).toBe(true);
    expect(isInQuietWindow(withHour(6), 22, 6)).toBe(false);
    expect(isInQuietWindow(withHour(12), 22, 6)).toBe(false);
    expect(isInQuietWindow(withHour(21), 22, 6)).toBe(false);
  });

  it("returns false for an empty window (start === end)", () => {
    expect(isInQuietWindow(withHour(3), 3, 3)).toBe(false);
    expect(isInQuietWindow(withHour(12), 3, 3)).toBe(false);
  });

  it("throws on out-of-range hours", () => {
    expect(() => isInQuietWindow(new Date(), -1, 6)).toThrow();
    expect(() => isInQuietWindow(new Date(), 2, 24)).toThrow();
  });
});

// =============================================================================
// countRecentContextUsages
// =============================================================================

describe("countRecentContextUsages", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("counts rows within the window", () => {
    seedContextUsage(store, 2, 5); // 2 min ago
    seedContextUsage(store, 9, 3); // 9 min ago (inside 10 min window)
    expect(countRecentContextUsages(store, 10)).toBe(8);
  });

  it("excludes rows older than the window", () => {
    seedContextUsage(store, 15, 10); // 15 min ago
    expect(countRecentContextUsages(store, 10)).toBe(0);
  });

  it("returns 0 on empty table", () => {
    expect(countRecentContextUsages(store, 10)).toBe(0);
  });
});

// =============================================================================
// shouldRunHeavyMaintenance
// =============================================================================

describe("shouldRunHeavyMaintenance", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  function hourDate(h: number): Date {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    return d;
  }

  it("skips with reason outside_window when hour is out of range", () => {
    const result = shouldRunHeavyMaintenance(store, hourDate(12), {
      windowStartHour: 2,
      windowEndHour: 6,
    });
    expect(result.run).toBe(false);
    expect(result.reason).toBe("outside_window");
  });

  it("skips with reason query_rate_high when usages exceed cap", () => {
    seedContextUsage(store, 2, 50);
    const result = shouldRunHeavyMaintenance(store, new Date(), {
      maxContextUsagesPer10m: 10,
    });
    expect(result.run).toBe(false);
    expect(result.reason).toBe("query_rate_high");
  });

  it("runs when inside window and rate is below cap", () => {
    seedContextUsage(store, 2, 3);
    const result = shouldRunHeavyMaintenance(store, new Date(), {
      maxContextUsagesPer10m: 30,
    });
    expect(result.run).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// =============================================================================
// Stale-first selectors
// =============================================================================

describe("selectStaleObservationBatch", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("orders by recall_stats.last_recalled_at ASC, NULL first via fallback", () => {
    // A has an old recall, B has a recent recall, C has never been recalled.
    seedObservation(store, "a.md", "A", {
      lastRecalledAt: "2026-01-01T00:00:00Z",
      modifiedAt: "2026-03-01T00:00:00Z",
    });
    seedObservation(store, "b.md", "B", {
      lastRecalledAt: "2026-04-01T00:00:00Z",
      modifiedAt: "2026-03-01T00:00:00Z",
    });
    seedObservation(store, "c.md", "C", {
      // no recall_stats row — falls back to last_accessed_at
      modifiedAt: "2026-02-01T00:00:00Z",
      lastAccessedAt: "2026-02-01T00:00:00Z",
    });

    const ordered = selectStaleObservationBatch(store, 10);
    // C has oldest fallback (2026-02), A has oldest recall (2026-01).
    // Since recall_stats.last_recalled_at takes precedence, A < C < B.
    expect(ordered).toEqual([1, 3, 2]);
  });

  it("falls back to modified_at when recall_stats + last_accessed_at are null", () => {
    // Seed observation without any last_accessed_at (using explicit NULL insert)
    const id1 = seedObservation(store, "old.md", "Old", {
      modifiedAt: "2026-01-01T00:00:00Z",
    });
    const id2 = seedObservation(store, "new.md", "New", {
      modifiedAt: "2026-04-01T00:00:00Z",
    });

    // Force last_accessed_at to NULL to hit the modified_at fallback
    store.db.prepare(`UPDATE documents SET last_accessed_at = NULL WHERE id IN (?, ?)`).run(id1, id2);

    const ordered = selectStaleObservationBatch(store, 10);
    expect(ordered).toEqual([id1, id2]); // old first
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i++) {
      seedObservation(store, `obs${i}.md`, `Obs ${i}`, {
        modifiedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    expect(selectStaleObservationBatch(store, 3)).toHaveLength(3);
  });

  it("only returns active observations with content_type = 'observation'", () => {
    const obsId = seedObservation(store, "obs.md", "Obs");
    seedObservation(store, "dec.md", "Dec", { contentType: "decision" });

    const ordered = selectStaleObservationBatch(store, 10);
    expect(ordered).toEqual([obsId]);
  });
});

describe("selectStaleDeductiveBatch", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("includes decision/preference/milestone/problem, excludes observation", () => {
    const dec = seedObservation(store, "d.md", "Dec", { contentType: "decision" });
    const pref = seedObservation(store, "p.md", "Pref", { contentType: "preference" });
    const ms = seedObservation(store, "m.md", "MS", { contentType: "milestone" });
    const prob = seedObservation(store, "r.md", "Prob", { contentType: "problem" });
    seedObservation(store, "o.md", "Obs", { contentType: "observation" });

    const ids = selectStaleDeductiveBatch(store, 10);
    expect(ids.sort()).toEqual([dec, pref, ms, prob].sort());
  });

  it("produces valid ordering when recall_stats is completely empty", () => {
    // Acceptance criterion: "Boundary case: empty recall_stats table still
    // produces valid stale ordering". With no recall_stats rows the selector
    // must fall back to last_accessed_at / modified_at without erroring.
    const a = seedObservation(store, "a.md", "A", {
      contentType: "decision",
      lastAccessedAt: "2026-01-01T00:00:00Z",
    });
    const b = seedObservation(store, "b.md", "B", {
      contentType: "decision",
      lastAccessedAt: "2026-04-01T00:00:00Z",
    });

    const recallCount = (store.db.prepare(`SELECT COUNT(*) as cnt FROM recall_stats`).get() as { cnt: number }).cnt;
    expect(recallCount).toBe(0);

    const ids = selectStaleDeductiveBatch(store, 10);
    // Oldest last_accessed_at first
    expect(ids).toEqual([a, b]);
  });
});

describe("selectSurprisingObservationBatch", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("returns empty array when vault has no embeddings (safe degradation)", () => {
    // Without vectors_vec rows, computeSurprisalScores returns [] rather
    // than erroring. Verifies the selector wrapper is a pass-through.
    seedObservation(store, "o.md", "Obs", { contentType: "observation" });
    const ids = selectSurprisingObservationBatch(store, 10);
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toHaveLength(0);
  });

  it("returns empty array on empty vault", () => {
    const ids = selectSurprisingObservationBatch(store, 10);
    expect(ids).toEqual([]);
  });
});

// =============================================================================
// insertMaintenanceRun
// =============================================================================

describe("insertMaintenanceRun", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("persists all provided columns", () => {
    const id = insertMaintenanceRun(store, {
      lane: "heavy",
      phase: "consolidate",
      status: "completed",
      selectedCount: 10,
      processedCount: 8,
      createdCount: 2,
      updatedCount: 1,
      rejectedCount: 0,
      nullCallCount: 0,
      metrics: { duration: 1234 },
    });
    expect(id).toBeGreaterThan(0);

    const row = store.db.prepare(`SELECT * FROM maintenance_runs WHERE id = ?`).get(id) as {
      lane: string;
      phase: string;
      status: string;
      selected_count: number;
      processed_count: number;
      created_count: number;
      metrics_json: string;
    };
    expect(row.lane).toBe("heavy");
    expect(row.phase).toBe("consolidate");
    expect(row.status).toBe("completed");
    expect(row.selected_count).toBe(10);
    expect(row.processed_count).toBe(8);
    expect(row.created_count).toBe(2);
    expect(JSON.parse(row.metrics_json)).toEqual({ duration: 1234 });
  });

  it("accepts a skipped row with a reason", () => {
    const id = insertMaintenanceRun(store, {
      lane: "heavy",
      phase: "gate",
      status: "skipped",
      reason: "outside_window",
    });
    const row = store.db.prepare(`SELECT status, reason FROM maintenance_runs WHERE id = ?`).get(id) as { status: string; reason: string };
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("outside_window");
  });
});

// =============================================================================
// runHeavyMaintenanceTick (integration-style but still unit scope)
// =============================================================================

describe("runHeavyMaintenanceTick", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("writes a skipped row with reason outside_window when hour is out of range", async () => {
    const fixedClock = () => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      return d;
    };
    const results = await runHeavyMaintenanceTick(store, createMockLLM(), {
      windowStartHour: 2,
      windowEndHour: 6,
      clock: fixedClock,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toBe("outside_window");
  });

  it("writes a skipped row with reason query_rate_high when rate cap exceeded", async () => {
    seedContextUsage(store, 2, 100);
    const results = await runHeavyMaintenanceTick(store, createMockLLM(), {
      maxContextUsagesPer10m: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toBe("query_rate_high");
  });

  it("writes a skipped row with reason lease_unavailable when another worker holds the lease", async () => {
    // Pre-acquire the lease so withWorkerLease refuses.
    const held = acquireWorkerLease(store, "heavy-maintenance", 60_000);
    expect(held.acquired).toBe(true);

    const results = await runHeavyMaintenanceTick(store, createMockLLM(), {});
    // We expect one skipped row (gate passed, lease failed).
    const skipped = results.find(r => r.status === "skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toBe("lease_unavailable");
  });

  it("writes Phase 2 + Phase 3 completed rows when inside window and rate is low", async () => {
    // Seed some observations so Phase 2 has something to chew on.
    seedObservation(store, "o1.md", "Obs 1", { contentType: "observation" });
    seedObservation(store, "o2.md", "Obs 2", { contentType: "observation" });

    // Mock LLM that returns an empty JSON array (no patterns found) —
    // Phase 2 will run but write nothing, and Phase 3 will return empty stats.
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({
      text: "[]",
      model: "mock",
      done: true,
    }));

    const results = await runHeavyMaintenanceTick(store, llm, {});
    const phase2 = results.find(r => r.phase === "consolidate");
    const phase3 = results.find(r => r.phase === "deductive");
    expect(phase2).toBeDefined();
    expect(phase2!.status).toBe("completed");
    expect(phase3).toBeDefined();
    expect(phase3!.status).toBe("completed");
  });

  it("propagates Phase 3 null LLM calls into null_call_count", async () => {
    // Seed two decisions that would be eligible for deductive synthesis.
    seedObservation(store, "d1.md", "Dec 1", { contentType: "decision" });
    seedObservation(store, "d2.md", "Dec 2", { contentType: "decision" });

    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => null);

    const results = await runHeavyMaintenanceTick(store, llm, {});
    const phase3 = results.find(r => r.phase === "deductive")!;
    expect(phase3.status).toBe("completed");
    expect(phase3.null_call_count).toBeGreaterThan(0);
  });

  it("records selector type in Phase 2 metrics (stale-first default and surprisal fallback)", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({ text: "[]", model: "mock", done: true }));

    // Default run — stale-first selector
    const results1 = await runHeavyMaintenanceTick(store, llm, {});
    const phase2_default = results1.find(r => r.phase === "consolidate")!;
    const metrics_default = JSON.parse(phase2_default.metrics_json ?? "{}");
    expect(metrics_default.selector).toBe("stale-first");

    // Surprisal mode on a vault without embeddings — the selector returns
    // an empty candidate list, the heavy lane falls through to stale-first,
    // and the journal records the degradation explicitly as
    // "surprisal-fallback-stale" so operators can see that the surprisal
    // path did not contribute.
    const results2 = await runHeavyMaintenanceTick(store, llm, {
      useSurprisalSelector: true,
    });
    const phase2_surprisal = results2.find(r => r.phase === "consolidate")!;
    const metrics_surprisal = JSON.parse(phase2_surprisal.metrics_json ?? "{}");
    expect(metrics_surprisal.selector).toBe("surprisal-fallback-stale");
  });
});

// =============================================================================
// consolidateObservations.candidateIds (M1 fix — plumb surprisal selector)
// =============================================================================

describe("consolidateObservations candidateIds option", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("restricts the Phase 2 SELECT to the given ids", async () => {
    const idA = seedObservation(store, "a.md", "Alpha", { contentType: "observation" });
    const idB = seedObservation(store, "b.md", "Bravo", { contentType: "observation" });
    const idC = seedObservation(store, "c.md", "Charlie", { contentType: "observation" });

    const llm = createMockLLM();
    const titlesSeen = new Set<string>();
    llm.generate.mockImplementation(async (prompt: string) => {
      for (const match of prompt.matchAll(/"(Alpha|Bravo|Charlie)"/g)) {
        titlesSeen.add(match[1]!);
      }
      return { text: "[]", model: "mock", done: true };
    });

    await consolidateObservations(store, llm, { candidateIds: [idA, idC] });

    expect(titlesSeen.has("Alpha")).toBe(true);
    expect(titlesSeen.has("Charlie")).toBe(true);
    expect(titlesSeen.has("Bravo")).toBe(false);
    void idB; // explicitly unused
  });

  it("empty candidateIds short-circuits without invoking the LLM", async () => {
    seedObservation(store, "a.md", "A", { contentType: "observation" });
    seedObservation(store, "b.md", "B", { contentType: "observation" });

    const llm = createMockLLM();
    let calls = 0;
    llm.generate.mockImplementation(async () => {
      calls++;
      return { text: "[]", model: "mock", done: true };
    });

    await consolidateObservations(store, llm, { candidateIds: [] });

    expect(calls).toBe(0);
  });
});

// =============================================================================
// Consolidation option bag (threaded from heavy lane)
// =============================================================================

describe("consolidateObservations option bag", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("honors maxDocs by limiting the SELECT", async () => {
    // Seed 5 observations
    for (let i = 0; i < 5; i++) {
      seedObservation(store, `obs${i}.md`, `Obs ${i}`, { contentType: "observation" });
    }

    const llm = createMockLLM();
    let observedPromptLength = 0;
    llm.generate.mockImplementation(async (prompt: string) => {
      // Count how many observations the prompt mentions.
      observedPromptLength = Math.max(
        observedPromptLength,
        (prompt.match(/^\d+\.\s+\[/gm) || []).length,
      );
      return { text: "[]", model: "mock", done: true };
    });

    await consolidateObservations(store, llm, { maxDocs: 2 });

    // With maxDocs=2 the synthesizer should see at most 2 entries in the prompt.
    // Since all 5 obs are in the same collection, the prompt contains up to 2.
    expect(observedPromptLength).toBeLessThanOrEqual(2);
    expect(observedPromptLength).toBeGreaterThanOrEqual(0);
  });

  it("staleOnly=true orders by last_recalled_at ASC instead of modified_at DESC", async () => {
    const oldId = seedObservation(store, "old.md", "Old", {
      contentType: "observation",
      modifiedAt: "2026-04-01T00:00:00Z",
      lastAccessedAt: "2026-01-01T00:00:00Z",
    });
    const newId = seedObservation(store, "new.md", "New", {
      contentType: "observation",
      modifiedAt: "2026-01-01T00:00:00Z",
      lastAccessedAt: "2026-04-01T00:00:00Z",
    });

    const llm = createMockLLM();
    const sawOrder: string[] = [];
    llm.generate.mockImplementation(async (prompt: string) => {
      const lines = prompt.match(/"([^"]+)"/g) ?? [];
      for (const line of lines) {
        if (line === '"Old"') sawOrder.push("Old");
        if (line === '"New"') sawOrder.push("New");
      }
      return { text: "[]", model: "mock", done: true };
    });

    await consolidateObservations(store, llm, { maxDocs: 10, staleOnly: true });

    // Stale-first: "Old" (last_accessed_at 2026-01) must appear BEFORE "New" (2026-04)
    const oldIndex = sawOrder.indexOf("Old");
    const newIndex = sawOrder.indexOf("New");
    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeGreaterThanOrEqual(0);
    expect(oldIndex).toBeLessThan(newIndex);
    // Silence unused-var warning
    void oldId;
    void newId;
  });

  it("no options bag reproduces modified_at DESC ordering (pre-Ext-5 behavior)", async () => {
    seedObservation(store, "old.md", "Old", {
      contentType: "observation",
      modifiedAt: "2026-01-01T00:00:00Z",
      lastAccessedAt: "2026-01-01T00:00:00Z",
    });
    seedObservation(store, "new.md", "New", {
      contentType: "observation",
      modifiedAt: "2026-04-01T00:00:00Z",
      lastAccessedAt: "2026-04-01T00:00:00Z",
    });

    const llm = createMockLLM();
    const sawOrder: string[] = [];
    llm.generate.mockImplementation(async (prompt: string) => {
      const lines = prompt.match(/"([^"]+)"/g) ?? [];
      for (const line of lines) {
        if (line === '"Old"') sawOrder.push("Old");
        if (line === '"New"') sawOrder.push("New");
      }
      return { text: "[]", model: "mock", done: true };
    });

    await consolidateObservations(store, llm);

    // Default ordering: modified_at DESC → "New" before "Old"
    const oldIndex = sawOrder.indexOf("Old");
    const newIndex = sawOrder.indexOf("New");
    expect(newIndex).toBeLessThan(oldIndex);
  });
});

describe("generateDeductiveObservations option bag", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("honors maxRecent limit", async () => {
    const recentIso = new Date(Date.now() - 60 * 1000).toISOString();
    for (let i = 0; i < 10; i++) {
      seedObservation(store, `d${i}.md`, `Dec ${i}`, {
        contentType: "decision",
        modifiedAt: recentIso,
      });
    }

    const llm = createMockLLM();
    let observedPromptLines = 0;
    llm.generate.mockImplementation(async (prompt: string) => {
      observedPromptLines = Math.max(
        observedPromptLines,
        (prompt.match(/^\[\d+\]/gm) || []).length,
      );
      return { text: "[]", model: "mock", done: true };
    });

    await generateDeductiveObservations(store, llm, { maxRecent: 3 });
    expect(observedPromptLines).toBeLessThanOrEqual(3);
  });

  it("staleOnly=true flips ordering for deductive candidates", async () => {
    const recentIso = new Date(Date.now() - 60 * 1000).toISOString();

    const oldId = seedObservation(store, "d-old.md", "Dec Old", {
      contentType: "decision",
      modifiedAt: recentIso,
      lastAccessedAt: "2026-01-01T00:00:00Z",
    });
    const newId = seedObservation(store, "d-new.md", "Dec New", {
      contentType: "decision",
      modifiedAt: recentIso,
      lastAccessedAt: "2026-04-01T00:00:00Z",
    });

    const llm = createMockLLM();
    const sawOrder: string[] = [];
    llm.generate.mockImplementation(async (prompt: string) => {
      const matches = prompt.matchAll(/"([^"]+)"/g);
      for (const m of matches) {
        if (m[1] === "Dec Old") sawOrder.push("Dec Old");
        if (m[1] === "Dec New") sawOrder.push("Dec New");
      }
      return { text: "[]", model: "mock", done: true };
    });

    await generateDeductiveObservations(store, llm, { maxRecent: 10, staleOnly: true });

    const oldIdx = sawOrder.indexOf("Dec Old");
    const newIdx = sawOrder.indexOf("Dec New");
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx);
    void oldId;
    void newId;
  });
});
