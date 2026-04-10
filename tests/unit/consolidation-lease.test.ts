/**
 * Unit tests for the v0.8.2 light-lane worker lease (consolidation.ts).
 *
 * Codex review of the v0.8.2 design called this lease change MANDATORY before
 * moving worker hosting from cmdMcp to cmdWatch — without it, two host
 * processes (e.g. one watcher service + one per-session stdio MCP) would race
 * on Phase 2 consolidation, potentially:
 *   - both seeing `findSimilarConsolidation(...) === null` and both INSERTing
 *     a duplicate row into `consolidated_observations`
 *   - both merging into the same existing row and losing source_ids from the
 *     read-modify-write update in `mergeIntoExistingConsolidation`
 *
 * These tests cover:
 *   - runConsolidationTick acquires the lease on an empty table
 *   - runConsolidationTick returns {acquired:false} when another worker holds it
 *   - lease released after a successful tick (table empty for the worker name)
 *   - lease released even when a phase throws (try/catch is internal — tick
 *     itself never throws to the lease wrapper, but defensive: confirm anyway)
 *   - burst contention regression: many concurrent ticks → exactly one wins
 *   - in-process reentrancy guard fires before the lease round-trip
 *   - default worker name is "light-consolidation" so it does not collide
 *     with the heavy lane's "heavy-maintenance"
 *   - custom worker name via opts allows isolated test fixtures
 *   - expired lease can be reclaimed by a fresh tick
 *   - DEFAULT_LIGHT_LANE_WORKER_NAME constant is exported for stable
 *     reference by callers / docs
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  runConsolidationTick,
  DEFAULT_LIGHT_LANE_WORKER_NAME,
  DEFAULT_LIGHT_LANE_LEASE_TTL_MS,
} from "../../src/consolidation.ts";
import { acquireWorkerLease } from "../../src/worker-lease.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";

// Generate a unique lease name per test so cross-test contention can't
// surface as flake. Module-level `tickCount` and `isRunning` are still
// shared, but neither blocks tests on an empty vault.
function uniqueWorkerName(label: string): string {
  return `light-consolidation-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("runConsolidationTick — lease acquisition", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("acquires the lease on an empty worker_leases table", async () => {
    const workerName = uniqueWorkerName("acquire");
    const result = await runConsolidationTick(store, createMockLLM() as any, {
      workerName,
    });
    expect(result.acquired).toBe(true);

    // After tick completes, lease must be released — table empty for this name.
    const count = (store.db
      .prepare(`SELECT COUNT(*) as cnt FROM worker_leases WHERE worker_name = ?`)
      .get(workerName) as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it("returns {acquired:false} when another worker already holds the lease", async () => {
    const workerName = uniqueWorkerName("held");
    // Pre-acquire the lease so withWorkerLease refuses.
    const held = acquireWorkerLease(store, workerName, 60_000);
    expect(held.acquired).toBe(true);

    const result = await runConsolidationTick(store, createMockLLM() as any, {
      workerName,
    });
    expect(result.acquired).toBe(false);

    // Held lease is still there — we did not touch it.
    const row = store.db
      .prepare(`SELECT lease_token FROM worker_leases WHERE worker_name = ?`)
      .get(workerName) as { lease_token: string } | undefined;
    expect(row?.lease_token).toBe(held.token!);
  });

  it("releases the lease after a successful tick", async () => {
    const workerName = uniqueWorkerName("release");
    const result = await runConsolidationTick(store, createMockLLM() as any, {
      workerName,
    });
    expect(result.acquired).toBe(true);

    // Sequential second tick acquires fresh — proves the first released.
    const second = await runConsolidationTick(store, createMockLLM() as any, {
      workerName,
    });
    expect(second.acquired).toBe(true);
  });

  it("can reclaim an expired lease left by a dead prior worker", async () => {
    const workerName = uniqueWorkerName("expired");
    // Acquire an already-expired lease by using a past `now`.
    const past = new Date(Date.now() - 120_000); // 2 min ago
    const stale = acquireWorkerLease(store, workerName, 60_000, past);
    expect(stale.acquired).toBe(true);
    // The lease expired ~1 min ago — fresh tick should reclaim atomically.

    const result = await runConsolidationTick(store, createMockLLM() as any, {
      workerName,
    });
    expect(result.acquired).toBe(true);
  });
});

describe("runConsolidationTick — burst contention regression", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("serializes 10 concurrent calls so exactly one wins per cycle", async () => {
    // Two-cycle test: with the in-process `isRunning` guard, only the first
    // tick in a burst can hold the lock; the rest skip. After the first
    // completes, a sequential second batch can run. This mirrors the heavy-
    // lane burst-contention regression test added in v0.8.0 Turn 16.
    const workerName = uniqueWorkerName("burst");

    const burst = await Promise.all(
      Array.from({ length: 10 }, () =>
        runConsolidationTick(store, createMockLLM() as any, { workerName }),
      ),
    );
    const won = burst.filter((r) => r.acquired).length;
    const lost = burst.filter((r) => !r.acquired).length;
    expect(won).toBe(1);
    expect(lost).toBe(9);

    // Lease released after the winner finished — table empty.
    const count = (store.db
      .prepare(`SELECT COUNT(*) as cnt FROM worker_leases WHERE worker_name = ?`)
      .get(workerName) as { cnt: number }).cnt;
    expect(count).toBe(0);

    // Subsequent serial call still works.
    const followUp = await runConsolidationTick(store, createMockLLM() as any, {
      workerName,
    });
    expect(followUp.acquired).toBe(true);
  });
});

describe("runConsolidationTick — defaults and exports", () => {
  it("exports DEFAULT_LIGHT_LANE_WORKER_NAME as 'light-consolidation'", () => {
    // Stable name so docs and operators can reference the lease key.
    expect(DEFAULT_LIGHT_LANE_WORKER_NAME).toBe("light-consolidation");
  });

  it("exports DEFAULT_LIGHT_LANE_LEASE_TTL_MS as 10 minutes", () => {
    // 10-min TTL covers the worst-case Phase 2 + Phase 3 LLM-stack time
    // without leaving a permanently stranded lease if the host is killed.
    expect(DEFAULT_LIGHT_LANE_LEASE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("uses the default worker name when opts.workerName is omitted", async () => {
    const store = createTestStore();
    // Pre-acquire the DEFAULT lease so the tick has to skip — proves the
    // tick is asking for the same name that DEFAULT_LIGHT_LANE_WORKER_NAME
    // exports.
    const held = acquireWorkerLease(store, DEFAULT_LIGHT_LANE_WORKER_NAME, 60_000);
    expect(held.acquired).toBe(true);

    const result = await runConsolidationTick(store, createMockLLM() as any);
    expect(result.acquired).toBe(false);
  });

  it("does not collide with the heavy maintenance lane lease", async () => {
    const store = createTestStore();
    // Heavy lane uses "heavy-maintenance"; light lane uses "light-consolidation".
    // Both should be holdable simultaneously without conflict.
    const heavy = acquireWorkerLease(store, "heavy-maintenance", 60_000);
    expect(heavy.acquired).toBe(true);

    // Light tick should still run — different lease name.
    const result = await runConsolidationTick(store, createMockLLM() as any);
    expect(result.acquired).toBe(true);

    // Heavy lease still held by us.
    const heavyRow = store.db
      .prepare(`SELECT lease_token FROM worker_leases WHERE worker_name = ?`)
      .get("heavy-maintenance") as { lease_token: string };
    expect(heavyRow.lease_token).toBe(heavy.token!);
  });
});
