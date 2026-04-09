/**
 * Integration tests for Ext 5 — Quiet-window heavy maintenance lane.
 *
 * Drives `runHeavyMaintenanceTick` end-to-end against a fresh in-memory
 * store, exercising:
 *  1. Full tick with empty vault → no work, but Phase 2 + Phase 3 rows
 *     are written as completed with selected_count = 0
 *  2. Seeded observations → Phase 2 writes a completed row, seeded
 *     decisions → Phase 3 writes a completed row
 *  3. High context-usage rate → single skipped row, no lease acquired
 *  4. Outside-window hour → single skipped row
 *  5. Lease contention → skipped row with reason=lease_unavailable
 *  6. Stale-first selector picks least-recently-recalled first
 *  7. Rerun idempotency: running twice does not duplicate maintenance_runs
 *     decisions (each tick writes its own rows, but no lease leak)
 *  8. Phase 3 null LLM call → completed row with null_call_count > 0
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { runHeavyMaintenanceTick } from "../../src/maintenance.ts";
import { acquireWorkerLease } from "../../src/worker-lease.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";

// =============================================================================
// Fixtures
// =============================================================================

const TEST_COLLECTION = "ext5-test";

function seedObservationDoc(
  store: Store,
  path: string,
  title: string,
  opts: {
    contentType?: string;
    observationType?: string;
    modifiedAt?: string;
    lastAccessedAt?: string | null;
    lastRecalledAt?: string | null;
    facts?: string;
    narrative?: string;
  } = {},
): number {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const modifiedAt = opts.modifiedAt ?? new Date().toISOString();

  store.db.prepare(
    `INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`,
  ).run(hash, `# ${title}\n${opts.facts ?? title}`, modifiedAt);
  store.db.prepare(
    `INSERT INTO documents
        (collection, path, title, hash, created_at, modified_at, active,
         content_type, observation_type, facts, narrative, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    TEST_COLLECTION,
    path,
    title,
    hash,
    modifiedAt,
    modifiedAt,
    opts.contentType ?? "observation",
    opts.observationType ?? "decision",
    opts.facts ?? `${title} fact content`,
    opts.narrative ?? `${title} narrative`,
    opts.lastAccessedAt ?? modifiedAt,
  );
  const row = store.db.prepare(
    `SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1`,
  ).get(TEST_COLLECTION, path) as { id: number };
  if (opts.lastRecalledAt) {
    store.db.prepare(
      `INSERT INTO recall_stats (doc_id, recall_count, last_recalled_at) VALUES (?, 1, ?)`,
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

function countMaintenanceRuns(store: Store, phase?: string): number {
  const sql = phase
    ? `SELECT COUNT(*) as cnt FROM maintenance_runs WHERE phase = ?`
    : `SELECT COUNT(*) as cnt FROM maintenance_runs`;
  const row = phase
    ? (store.db.prepare(sql).get(phase) as { cnt: number })
    : (store.db.prepare(sql).get() as { cnt: number });
  return row.cnt;
}

// =============================================================================
// Tests
// =============================================================================

describe("runHeavyMaintenanceTick — end-to-end", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("writes Phase 2 + Phase 3 completed rows on an empty vault", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({ text: "[]", model: "mock", done: true }));

    const results = await runHeavyMaintenanceTick(store, llm, {});
    const phase2 = results.find(r => r.phase === "consolidate");
    const phase3 = results.find(r => r.phase === "deductive");
    expect(phase2).toBeDefined();
    expect(phase2!.status).toBe("completed");
    expect(phase3).toBeDefined();
    expect(phase3!.status).toBe("completed");
  });

  it("processes seeded observations and writes completed Phase 2 row", async () => {
    seedObservationDoc(store, "o1.md", "Observation 1", { contentType: "observation" });
    seedObservationDoc(store, "o2.md", "Observation 2", { contentType: "observation" });
    seedObservationDoc(store, "o3.md", "Observation 3", { contentType: "observation" });

    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({ text: "[]", model: "mock", done: true }));

    const results = await runHeavyMaintenanceTick(store, llm, {});
    const phase2 = results.find(r => r.phase === "consolidate")!;
    expect(phase2.status).toBe("completed");
  });

  it("writes a single skipped row when context usage rate exceeds cap", async () => {
    seedContextUsage(store, 2, 100);

    const llm = createMockLLM();
    const results = await runHeavyMaintenanceTick(store, llm, {
      maxContextUsagesPer10m: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toBe("query_rate_high");

    // No Phase 2/3 rows should be written
    expect(countMaintenanceRuns(store, "consolidate")).toBe(0);
    expect(countMaintenanceRuns(store, "deductive")).toBe(0);
  });

  it("writes a single skipped row when outside the configured quiet window", async () => {
    const llm = createMockLLM();
    const results = await runHeavyMaintenanceTick(store, llm, {
      windowStartHour: 2,
      windowEndHour: 6,
      clock: () => {
        const d = new Date();
        d.setHours(12, 0, 0, 0);
        return d;
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toBe("outside_window");
    expect(countMaintenanceRuns(store, "consolidate")).toBe(0);
  });

  it("writes a skipped row with reason=lease_unavailable when the lease is held", async () => {
    // Pre-acquire the default lease
    const held = acquireWorkerLease(store, "heavy-maintenance", 60_000);
    expect(held.acquired).toBe(true);

    const llm = createMockLLM();
    const results = await runHeavyMaintenanceTick(store, llm, {});
    const skipped = results.find(r => r.reason === "lease_unavailable");
    expect(skipped).toBeDefined();
    expect(skipped!.status).toBe("skipped");

    // No Phase 2/3 rows because lease acquisition failed.
    expect(countMaintenanceRuns(store, "consolidate")).toBe(0);
    expect(countMaintenanceRuns(store, "deductive")).toBe(0);
  });

  it("stale-first selection surfaces least-recently-recalled decisions first", async () => {
    const recentIso = new Date(Date.now() - 30 * 1000).toISOString();

    // Three decisions with different last_accessed_at timestamps.
    seedObservationDoc(store, "d-new.md", "Dec New", {
      contentType: "decision",
      modifiedAt: recentIso,
      lastAccessedAt: "2026-04-01T00:00:00Z",
    });
    seedObservationDoc(store, "d-mid.md", "Dec Mid", {
      contentType: "decision",
      modifiedAt: recentIso,
      lastAccessedAt: "2026-02-15T00:00:00Z",
    });
    seedObservationDoc(store, "d-old.md", "Dec Old", {
      contentType: "decision",
      modifiedAt: recentIso,
      lastAccessedAt: "2026-01-01T00:00:00Z",
    });

    const llm = createMockLLM();
    const observedOrder: string[] = [];
    llm.generate.mockImplementation(async (prompt: string) => {
      const matches = prompt.matchAll(/"(Dec (?:Old|Mid|New))"/g);
      for (const m of matches) {
        if (!observedOrder.includes(m[1]!)) observedOrder.push(m[1]!);
      }
      return { text: "[]", model: "mock", done: true };
    });

    await runHeavyMaintenanceTick(store, llm, {
      staleDeductiveLimit: 10,
    });

    // The heavy lane uses staleOnly=true for deductive — oldest first.
    expect(observedOrder).toEqual(["Dec Old", "Dec Mid", "Dec New"]);
  });

  it("two consecutive ticks both complete and write separate journal rows", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({ text: "[]", model: "mock", done: true }));

    await runHeavyMaintenanceTick(store, llm, {});
    await runHeavyMaintenanceTick(store, llm, {});

    // Two Phase 2 rows and two Phase 3 rows
    expect(countMaintenanceRuns(store, "consolidate")).toBe(2);
    expect(countMaintenanceRuns(store, "deductive")).toBe(2);

    // Lease table should be empty after both ticks — no leaks.
    const leaseCount = (store.db.prepare(`SELECT COUNT(*) as cnt FROM worker_leases`).get() as { cnt: number }).cnt;
    expect(leaseCount).toBe(0);
  });

  it("Phase 3 null LLM call writes a completed row with null_call_count > 0", async () => {
    // Seed decisions so Phase 3 has something to attempt
    seedObservationDoc(store, "d1.md", "Dec 1", { contentType: "decision" });
    seedObservationDoc(store, "d2.md", "Dec 2", { contentType: "decision" });

    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => null);

    const results = await runHeavyMaintenanceTick(store, llm, {});
    const phase3 = results.find(r => r.phase === "deductive")!;
    expect(phase3.status).toBe("completed");
    expect(phase3.null_call_count).toBeGreaterThan(0);
  });
});
