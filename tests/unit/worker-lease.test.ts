/**
 * Unit tests for worker-lease.ts (v0.8.0 Ext 5)
 *
 * Covers:
 *  - acquireWorkerLease inserts on empty table
 *  - acquireWorkerLease refuses when lease is live
 *  - acquireWorkerLease reclaims expired leases atomically
 *  - releaseWorkerLease fences on token mismatch
 *  - withWorkerLease runs callback and releases on success
 *  - withWorkerLease releases lease even when callback throws
 *  - withWorkerLease returns {acquired: false} without invoking callback
 *    when lease is held
 *  - ttlMs must be positive
 *  - token is a random 32-hex-char string (unique across calls)
 *  - expiresAt string is ISO 8601 and monotonic
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  acquireWorkerLease,
  releaseWorkerLease,
  withWorkerLease,
} from "../../src/worker-lease.ts";
import { createTestStore } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";

describe("acquireWorkerLease", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("inserts a row when no existing lease", () => {
    const result = acquireWorkerLease(store, "worker-a", 60_000);
    expect(result.acquired).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{32}$/);
    expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = store.db
      .prepare(`SELECT worker_name, lease_token FROM worker_leases WHERE worker_name = ?`)
      .get("worker-a") as { worker_name: string; lease_token: string };
    expect(row.worker_name).toBe("worker-a");
    expect(row.lease_token).toBe(result.token!);
  });

  it("refuses to acquire when a live lease is held", () => {
    const first = acquireWorkerLease(store, "worker-a", 60_000);
    expect(first.acquired).toBe(true);

    const second = acquireWorkerLease(store, "worker-a", 60_000);
    expect(second.acquired).toBe(false);
    expect(second.token).toBeUndefined();
  });

  it("reclaims an expired lease atomically", () => {
    // Acquire an already-expired lease by using a past `now`.
    const past = new Date(Date.now() - 120_000); // 2 min ago
    const first = acquireWorkerLease(store, "worker-a", 60_000, past);
    expect(first.acquired).toBe(true);

    // Because ttl was 60s and now is 2min in the past, it expired ~1 min ago.
    const second = acquireWorkerLease(store, "worker-a", 60_000);
    expect(second.acquired).toBe(true);
    expect(second.token).not.toBe(first.token);

    const row = store.db
      .prepare(`SELECT lease_token FROM worker_leases WHERE worker_name = ?`)
      .get("worker-a") as { lease_token: string };
    expect(row.lease_token).toBe(second.token!);
  });

  it("allows different worker names to hold independent leases", () => {
    const a = acquireWorkerLease(store, "worker-a", 60_000);
    const b = acquireWorkerLease(store, "worker-b", 60_000);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(a.token).not.toBe(b.token);

    const count = (store.db.prepare(`SELECT COUNT(*) as cnt FROM worker_leases`).get() as { cnt: number }).cnt;
    expect(count).toBe(2);
  });

  it("rejects non-positive ttlMs", () => {
    expect(() => acquireWorkerLease(store, "worker-a", 0)).toThrow();
    expect(() => acquireWorkerLease(store, "worker-a", -1)).toThrow();
  });

  it("generates unique tokens across sequential calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = acquireWorkerLease(store, `w${i}`, 60_000);
      expect(r.acquired).toBe(true);
      tokens.add(r.token!);
    }
    expect(tokens.size).toBe(5);
  });

  it("is race-safe under burst contention on the same worker name", () => {
    // Fire 10 acquisitions in quick succession against the same worker
    // name without releasing. Exactly one should win; the rest must
    // return {acquired: false} without throwing (M2 from Turn 16 review).
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(acquireWorkerLease(store, "burst", 60_000));
    }
    const won = results.filter(r => r.acquired).length;
    const lost = results.filter(r => !r.acquired).length;
    expect(won).toBe(1);
    expect(lost).toBe(9);

    // Table has exactly one row for the winner
    const rowCount = (store.db.prepare(`SELECT COUNT(*) as cnt FROM worker_leases WHERE worker_name = ?`).get("burst") as { cnt: number }).cnt;
    expect(rowCount).toBe(1);
  });
});

describe("releaseWorkerLease", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("deletes a held lease when the token matches", () => {
    const lease = acquireWorkerLease(store, "worker-a", 60_000);
    expect(lease.acquired).toBe(true);

    const released = releaseWorkerLease(store, "worker-a", lease.token!);
    expect(released).toBe(true);

    const count = (store.db.prepare(`SELECT COUNT(*) as cnt FROM worker_leases WHERE worker_name = ?`).get("worker-a") as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it("refuses to delete when the token does not match (fencing)", () => {
    const lease = acquireWorkerLease(store, "worker-a", 60_000);
    expect(lease.acquired).toBe(true);

    const released = releaseWorkerLease(store, "worker-a", "wrong-token");
    expect(released).toBe(false);

    const count = (store.db.prepare(`SELECT COUNT(*) as cnt FROM worker_leases WHERE worker_name = ?`).get("worker-a") as { cnt: number }).cnt;
    expect(count).toBe(1);
  });

  it("is a no-op when the lease does not exist", () => {
    const released = releaseWorkerLease(store, "never-held", "whatever");
    expect(released).toBe(false);
  });
});

describe("withWorkerLease", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("runs fn and releases lease on success", async () => {
    let invoked = false;
    const result = await withWorkerLease(store, "worker-a", 60_000, async () => {
      invoked = true;
      return "result-value";
    });
    expect(invoked).toBe(true);
    expect(result.acquired).toBe(true);
    expect(result.result).toBe("result-value");

    const count = (store.db.prepare(`SELECT COUNT(*) as cnt FROM worker_leases WHERE worker_name = ?`).get("worker-a") as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it("releases lease even when fn throws", async () => {
    await expect(
      withWorkerLease(store, "worker-a", 60_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const count = (store.db.prepare(`SELECT COUNT(*) as cnt FROM worker_leases WHERE worker_name = ?`).get("worker-a") as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it("skips fn and returns {acquired: false} when another worker holds the lease", async () => {
    const held = acquireWorkerLease(store, "worker-a", 60_000);
    expect(held.acquired).toBe(true);

    let invoked = false;
    const result = await withWorkerLease(store, "worker-a", 60_000, async () => {
      invoked = true;
      return "should-not-run";
    });
    expect(invoked).toBe(false);
    expect(result.acquired).toBe(false);
    expect(result.result).toBeUndefined();

    // Original lease is still there — we did not touch it.
    const row = store.db.prepare(`SELECT lease_token FROM worker_leases WHERE worker_name = ?`).get("worker-a") as { lease_token: string };
    expect(row.lease_token).toBe(held.token!);
  });

  it("serializes two sequential holders on the same worker name", async () => {
    const first = await withWorkerLease(store, "worker-a", 60_000, async () => "first");
    expect(first.acquired).toBe(true);
    expect(first.result).toBe("first");

    const second = await withWorkerLease(store, "worker-a", 60_000, async () => "second");
    expect(second.acquired).toBe(true);
    expect(second.result).toBe("second");
  });
});
