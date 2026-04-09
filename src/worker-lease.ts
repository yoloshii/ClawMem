/**
 * ClawMem Worker Lease (v0.8.0 Ext 5)
 *
 * DB-backed exclusive lease for heavy-lane workers. Uses the `worker_leases`
 * table (schema in store.ts) instead of module globals so multiple processes
 * sharing a vault cannot run heavy maintenance concurrently.
 *
 * Lease lifecycle:
 *   1. acquireWorkerLease inserts or reclaims an expired row via transaction
 *      and returns a random fencing token on success.
 *   2. The holder runs its work.
 *   3. releaseWorkerLease deletes the row only if the caller's token matches,
 *      so a lease reclaimed by another worker after TTL expiry cannot be
 *      torn down by the original holder.
 *
 * withWorkerLease wraps acquire/release around a callback; failure to acquire
 * is a silent no-op (returns `{acquired: false}`) — callers should log a
 * `skipped` journal row with reason `lease_unavailable`.
 */

import { randomBytes } from "node:crypto";
import type { Store } from "./store.ts";

export interface LeaseAcquireResult {
  acquired: boolean;
  token?: string;
  expiresAt?: string;
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function futureIso(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

/**
 * Attempt to acquire an exclusive lease on `workerName` for `ttlMs`.
 *
 * Returns `{acquired: true, token, expiresAt}` on success, or
 * `{acquired: false}` if another worker holds a live (non-expired) lease.
 *
 * Race-safe under multi-process contention: uses a single
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= ?` statement
 * so the "no row → insert" and "expired row → update" paths cannot
 * both fire for two concurrent callers. SQLite's changes() reports 1
 * iff THIS call either inserted a fresh row or reclaimed an expired row;
 * 0 means a live lease was held by someone else.
 *
 * Any SQLITE_BUSY / constraint failure is translated to
 * `{ acquired: false }` so the advertised non-throw contract holds for
 * callers that are layering `shouldRunHeavyMaintenance` above this.
 */
export function acquireWorkerLease(
  store: Store,
  workerName: string,
  ttlMs: number,
  now: Date = new Date(),
): LeaseAcquireResult {
  if (ttlMs <= 0) {
    throw new Error(`acquireWorkerLease: ttlMs must be positive, got ${ttlMs}`);
  }
  const token = randomBytes(16).toString("hex");
  const acquiredAt = nowIso(now);
  const expiresAt = futureIso(now, ttlMs);

  try {
    // Single-statement atomic acquire. The WHERE on the UPDATE clause
    // only reclaims when the existing lease has expired (its expires_at
    // <= our acquired_at); otherwise the ON CONFLICT DO UPDATE becomes
    // a no-op and SQLite reports changes=0.
    const result = store.db.prepare(
      `INSERT INTO worker_leases
         (worker_name, lease_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(worker_name) DO UPDATE SET
         lease_token = excluded.lease_token,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at
       WHERE worker_leases.expires_at <= excluded.acquired_at`,
    ).run(workerName, token, acquiredAt, expiresAt);

    if (result.changes === 0) {
      return { acquired: false };
    }
    return { acquired: true, token, expiresAt };
  } catch (err) {
    // Defensive fallback: any unexpected DB error (SQLITE_BUSY under
    // extreme contention, constraint error from schema drift, etc.) is
    // translated to a lease-unavailable result instead of bubbling up,
    // so heavy-maintenance callers always get a deterministic
    // "skipped/lease_unavailable" journal row.
    console.error(
      `[worker-lease] acquire error for ${workerName}: ${(err as Error).message}`,
    );
    return { acquired: false };
  }
}

/**
 * Release a lease if the caller's token still matches. Returns `true` if
 * the lease was owned and deleted, `false` if a different token held it
 * (e.g., TTL expired and another worker reclaimed).
 */
export function releaseWorkerLease(
  store: Store,
  workerName: string,
  token: string,
): boolean {
  const result = store.db.prepare(
    `DELETE FROM worker_leases WHERE worker_name = ? AND lease_token = ?`,
  ).run(workerName, token);
  return result.changes > 0;
}

/**
 * Run `fn` under an exclusive lease on `workerName`. If the lease cannot
 * be acquired, returns `{acquired: false}` without invoking `fn`. The
 * lease is always released in a `finally` block, even if `fn` throws.
 *
 * Rethrows any error from `fn` — callers are responsible for translating
 * exceptions into journal rows.
 */
export async function withWorkerLease<T>(
  store: Store,
  workerName: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ acquired: boolean; result?: T }> {
  const lease = acquireWorkerLease(store, workerName, ttlMs);
  if (!lease.acquired || !lease.token) {
    return { acquired: false };
  }
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    releaseWorkerLease(store, workerName, lease.token);
  }
}
