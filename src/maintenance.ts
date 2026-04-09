/**
 * ClawMem Heavy Maintenance Lane (v0.8.0 Ext 5)
 *
 * A second, longer-interval consolidation worker that runs during configured
 * quiet windows with stale-first batching, DB-backed exclusivity via
 * worker_leases, and journal rows in `maintenance_runs` for every attempt.
 *
 * Keeps Phase 2/3 consolidation + deductive synthesis running on large vaults
 * without competing for CPU/GPU against the interactive light lane that
 * ticks every 5 minutes. Off by default — enabled via `CLAWMEM_HEAVY_LANE=true`
 * next to the existing light-lane `CLAWMEM_ENABLE_CONSOLIDATION` flag.
 *
 * Design notes:
 *  - Uses existing `context_usage` telemetry for query-rate gating. No new
 *    `query_activity` table — we count rows where `timestamp > -10 minutes`.
 *  - Stale-first selection prefers docs whose `recall_stats.last_recalled_at`
 *    is oldest/null, falling back to `documents.last_accessed_at` / `modified_at`.
 *  - Optional surprisal selector reuses `computeSurprisalScores` to bubble up
 *    high-anomaly observations for curator-style runs.
 *  - Every scheduled attempt writes a `maintenance_runs` row so operators can
 *    reconstruct the decision without reading worker logs.
 */

import type { Store } from "./store.ts";
import type { LlamaCpp } from "./llm.ts";
import {
  consolidateObservations,
  generateDeductiveObservations,
  computeSurprisalScores,
  type DeductiveSynthesisStats,
} from "./consolidation.ts";
import { withWorkerLease } from "./worker-lease.ts";

// =============================================================================
// Config
// =============================================================================

export interface HeavyMaintenanceConfig {
  /** Interval between heavy-lane ticks in milliseconds (default 30 min). */
  intervalMs?: number;
  /** Start hour (0-23) of the quiet window; null/undefined = no window. */
  windowStartHour?: number | null;
  /** End hour (0-23, exclusive) of the quiet window; null/undefined = no window. */
  windowEndHour?: number | null;
  /** Max context_usage rows in the last 10 min before the lane skips (default 30). */
  maxContextUsagesPer10m?: number;
  /** Batch size for Phase 2 consolidation (default 100). */
  staleObservationLimit?: number;
  /** Batch size for Phase 3 deductive synthesis (default 40). */
  staleDeductiveLimit?: number;
  /** When true, use computeSurprisalScores to select batches for Phase 2. */
  useSurprisalSelector?: boolean;
  /** Worker lease TTL in ms (default 10 min — covers worst-case run time). */
  leaseTtlMs?: number;
  /** Worker lease name. Override only in tests (default "heavy-maintenance"). */
  workerName?: string;
  /** Clock injection for unit tests — defaults to `() => new Date()`. */
  clock?: () => Date;
}

// Vault scoping note: the heavy lane operates on whatever Store it is handed
// — createStore(path) maps 1:1 to a single SQLite vault, so context_usage
// and recall_stats reads are implicitly vault-scoped via `store.db`. Multi-
// vault mode is out of scope for v0.8.0 and would require extending this
// config with an explicit vault list plus a per-vault lease name.

const DEFAULT_CONFIG: Required<Omit<HeavyMaintenanceConfig, "workerName" | "clock">> = {
  intervalMs: 30 * 60 * 1000,
  windowStartHour: null,
  windowEndHour: null,
  maxContextUsagesPer10m: 30,
  staleObservationLimit: 100,
  staleDeductiveLimit: 40,
  useSurprisalSelector: false,
  leaseTtlMs: 10 * 60 * 1000,
};

const DEFAULT_WORKER_NAME = "heavy-maintenance";

// =============================================================================
// Journal helpers
// =============================================================================

export type MaintenanceStatus = "started" | "skipped" | "completed" | "failed";

export interface MaintenanceRunSummary {
  id: number;
  lane: string;
  phase: string;
  status: MaintenanceStatus;
  reason: string | null;
  selected_count: number;
  processed_count: number;
  created_count: number;
  updated_count: number;
  rejected_count: number;
  null_call_count: number;
  started_at: string;
  finished_at: string | null;
  metrics_json: string | null;
}

export function insertMaintenanceRun(
  store: Store,
  row: {
    lane: string;
    phase: string;
    status: MaintenanceStatus;
    reason?: string | null;
    selectedCount?: number;
    processedCount?: number;
    createdCount?: number;
    updatedCount?: number;
    rejectedCount?: number;
    nullCallCount?: number;
    startedAt?: string;
    finishedAt?: string | null;
    metrics?: Record<string, unknown> | null;
  },
): number {
  const startedAt = row.startedAt ?? new Date().toISOString();
  const result = store.db.prepare(
    `INSERT INTO maintenance_runs
      (lane, phase, status, reason, selected_count, processed_count,
       created_count, updated_count, rejected_count, null_call_count,
       started_at, finished_at, metrics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.lane,
    row.phase,
    row.status,
    row.reason ?? null,
    row.selectedCount ?? 0,
    row.processedCount ?? 0,
    row.createdCount ?? 0,
    row.updatedCount ?? 0,
    row.rejectedCount ?? 0,
    row.nullCallCount ?? 0,
    startedAt,
    row.finishedAt ?? null,
    row.metrics ? JSON.stringify(row.metrics) : null,
  );
  return Number(result.lastInsertRowid);
}

function finalizeMaintenanceRun(
  store: Store,
  id: number,
  patch: {
    status: MaintenanceStatus;
    reason?: string | null;
    selectedCount?: number;
    processedCount?: number;
    createdCount?: number;
    updatedCount?: number;
    rejectedCount?: number;
    nullCallCount?: number;
    finishedAt?: string;
    metrics?: Record<string, unknown> | null;
  },
): void {
  store.db.prepare(
    `UPDATE maintenance_runs
        SET status = ?, reason = ?,
            selected_count = ?, processed_count = ?,
            created_count = ?, updated_count = ?,
            rejected_count = ?, null_call_count = ?,
            finished_at = ?, metrics_json = ?
      WHERE id = ?`,
  ).run(
    patch.status,
    patch.reason ?? null,
    patch.selectedCount ?? 0,
    patch.processedCount ?? 0,
    patch.createdCount ?? 0,
    patch.updatedCount ?? 0,
    patch.rejectedCount ?? 0,
    patch.nullCallCount ?? 0,
    patch.finishedAt ?? new Date().toISOString(),
    patch.metrics ? JSON.stringify(patch.metrics) : null,
    id,
  );
}

// =============================================================================
// Gating logic
// =============================================================================

/**
 * True when `now` falls inside [windowStartHour, windowEndHour). Both nulls
 * mean "always in window". Handles midnight wraparound (e.g., 22→6) by
 * accepting either hour >= start OR hour < end.
 */
export function isInQuietWindow(
  now: Date,
  windowStartHour: number | null | undefined,
  windowEndHour: number | null | undefined,
): boolean {
  if (windowStartHour == null || windowEndHour == null) return true;
  if (windowStartHour < 0 || windowStartHour > 23 || windowEndHour < 0 || windowEndHour > 23) {
    throw new Error(
      `isInQuietWindow: hours must be 0-23, got start=${windowStartHour} end=${windowEndHour}`,
    );
  }
  if (windowStartHour === windowEndHour) return false; // empty window
  const hour = now.getHours();
  if (windowStartHour < windowEndHour) {
    return hour >= windowStartHour && hour < windowEndHour;
  }
  // Wraps midnight
  return hour >= windowStartHour || hour < windowEndHour;
}

/**
 * Count context_usage rows in the last `minutes` minutes. Used as a proxy
 * for "how busy is the interactive light lane right now" — replaces the
 * `query_activity` table that Turn 2 of Ext 5 proposed.
 *
 * The cutoff is computed in JS as an ISO 8601 string and bound as a
 * parameter instead of using `datetime('now', '-N minutes')`. SQLite's
 * `datetime()` returns a space-separated format (`YYYY-MM-DD HH:MM:SS`)
 * while `context_usage.timestamp` is written in ISO 8601 with a T
 * separator; lexicographic comparison across those two formats is wrong
 * (space < T sorts ALL ISO rows as "newer" than any datetime() result).
 */
export function countRecentContextUsages(
  store: Store,
  minutes: number = 10,
): number {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const row = store.db.prepare(
    `SELECT COUNT(*) AS cnt FROM context_usage WHERE timestamp > ?`,
  ).get(cutoff) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Decide whether the heavy lane should run on this tick. Returns the
 * reason for skipping so the journal row can record it.
 */
export function shouldRunHeavyMaintenance(
  store: Store,
  now: Date,
  cfg: HeavyMaintenanceConfig = {},
): { run: boolean; reason?: string } {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  if (!isInQuietWindow(now, merged.windowStartHour, merged.windowEndHour)) {
    return { run: false, reason: "outside_window" };
  }
  const usages = countRecentContextUsages(store, 10);
  if (usages > merged.maxContextUsagesPer10m) {
    return { run: false, reason: "query_rate_high" };
  }
  return { run: true };
}

// =============================================================================
// Stale-first selection helpers
// =============================================================================

/**
 * Select up to `limit` observation doc IDs ordered by stale-first:
 * least-recently-recalled (recall_stats.last_recalled_at ASC, NULL first)
 * with documents.last_accessed_at as a fallback when recall_stats is empty.
 *
 * Used by tests and operators who want to inspect the heavy-lane batch
 * without actually running Phase 2. The real Phase 2 SQL inside
 * `consolidateObservations` applies its own stale-first ordering when
 * `staleOnly: true` is passed.
 */
export function selectStaleObservationBatch(
  store: Store,
  limit: number,
): number[] {
  const rows = store.db.prepare(
    `SELECT d.id FROM documents d
       LEFT JOIN recall_stats rs ON rs.doc_id = d.id
       WHERE d.active = 1
         AND d.content_type = 'observation'
       ORDER BY
         COALESCE(rs.last_recalled_at, d.last_accessed_at, d.modified_at) ASC,
         d.modified_at ASC
       LIMIT ?`,
  ).all(limit) as { id: number }[];
  return rows.map(r => r.id);
}

/**
 * Select up to `limit` decision/preference/milestone/problem doc IDs
 * ordered by stale-first for Phase 3 deductive synthesis.
 */
export function selectStaleDeductiveBatch(
  store: Store,
  limit: number,
): number[] {
  const DEDUCTIVE_TYPES = ["decision", "preference", "milestone", "problem"];
  const placeholders = DEDUCTIVE_TYPES.map(() => "?").join(",");
  const rows = store.db.prepare(
    `SELECT d.id FROM documents d
       LEFT JOIN recall_stats rs ON rs.doc_id = d.id
       WHERE d.active = 1
         AND d.content_type IN (${placeholders})
       ORDER BY
         COALESCE(rs.last_recalled_at, d.last_accessed_at, d.modified_at) ASC,
         d.modified_at ASC
       LIMIT ?`,
  ).all(...DEDUCTIVE_TYPES, limit) as { id: number }[];
  return rows.map(r => r.id);
}

/**
 * Select up to `limit` observation doc IDs ranked by surprisal score
 * (k-NN average neighbor distance — higher = more anomalous). Wraps
 * `computeSurprisalScores` so the heavy lane can swap in anomaly-first
 * selection via `useSurprisalSelector: true`.
 */
export function selectSurprisingObservationBatch(
  store: Store,
  limit: number,
): number[] {
  const results = computeSurprisalScores(store, { limit });
  return results.map(r => r.docId);
}

// =============================================================================
// Worker topology
// =============================================================================

let heavyTimer: Timer | null = null;
let heavyRunning = false;

/**
 * Run a single heavy-lane tick: gate check → worker lease → Phase 2 → Phase 3
 * → journal row. Exported for tests and for manual invocation via a future
 * `clawmem heavy-lane --once` CLI flag.
 */
export async function runHeavyMaintenanceTick(
  store: Store,
  llm: LlamaCpp,
  cfg: HeavyMaintenanceConfig = {},
): Promise<MaintenanceRunSummary[]> {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  const workerName = cfg.workerName ?? DEFAULT_WORKER_NAME;
  const clock = cfg.clock ?? (() => new Date());
  const results: MaintenanceRunSummary[] = [];

  const now = clock();
  const gate = shouldRunHeavyMaintenance(store, now, cfg);
  if (!gate.run) {
    const skippedId = insertMaintenanceRun(store, {
      lane: "heavy",
      phase: "gate",
      status: "skipped",
      reason: gate.reason ?? "unknown",
      finishedAt: new Date().toISOString(),
    });
    results.push(loadMaintenanceRun(store, skippedId));
    return results;
  }

  const lease = await withWorkerLease(
    store,
    workerName,
    merged.leaseTtlMs,
    async () => {
      // Phase 2 — consolidation
      const phase2Id = insertMaintenanceRun(store, {
        lane: "heavy",
        phase: "consolidate",
        status: "started",
      });
      try {
        // Surprisal selector path: compute anomaly-first candidate ids up
        // front, then plumb them into consolidateObservations via
        // candidateIds. When the surprisal backend returns empty (no
        // embeddings, small vault, k-NN unavailable), fall through to
        // stale-first ordering so the heavy lane still does useful work.
        let candidateIds: number[] | undefined;
        let selectorUsed: "stale-first" | "surprisal" | "surprisal-fallback-stale";
        if (merged.useSurprisalSelector) {
          candidateIds = selectSurprisingObservationBatch(
            store,
            merged.staleObservationLimit,
          );
          if (candidateIds.length === 0) {
            // Nothing surprising — degrade to stale-first so the lane
            // does not become a no-op on vaults without embeddings.
            candidateIds = undefined;
            selectorUsed = "surprisal-fallback-stale";
          } else {
            selectorUsed = "surprisal";
          }
        } else {
          selectorUsed = "stale-first";
        }

        await consolidateObservations(store, llm, {
          maxDocs: merged.staleObservationLimit,
          guarded: true,
          staleOnly: selectorUsed !== "surprisal",
          candidateIds,
        });
        finalizeMaintenanceRun(store, phase2Id, {
          status: "completed",
          selectedCount: candidateIds
            ? candidateIds.length
            : merged.staleObservationLimit,
          metrics: {
            selector: selectorUsed,
            ...(candidateIds ? { candidateCount: candidateIds.length } : {}),
          },
        });
      } catch (err) {
        finalizeMaintenanceRun(store, phase2Id, {
          status: "failed",
          reason: "phase2_exception",
          metrics: { error: (err as Error).message },
        });
      }
      results.push(loadMaintenanceRun(store, phase2Id));

      // Phase 3 — deductive synthesis
      const phase3Id = insertMaintenanceRun(store, {
        lane: "heavy",
        phase: "deductive",
        status: "started",
      });
      try {
        const stats: DeductiveSynthesisStats = await generateDeductiveObservations(
          store,
          llm,
          {
            maxRecent: merged.staleDeductiveLimit,
            guarded: true,
            staleOnly: true,
          },
        );
        finalizeMaintenanceRun(store, phase3Id, {
          status: "completed",
          selectedCount: stats.considered,
          processedCount: stats.drafted,
          createdCount: stats.created,
          rejectedCount: stats.rejected,
          nullCallCount: stats.nullCalls,
          metrics: {
            accepted: stats.accepted,
            contaminationRejects: stats.contaminationRejects,
            invalidIndexRejects: stats.invalidIndexRejects,
            unsupportedRejects: stats.unsupportedRejects,
            emptyRejects: stats.emptyRejects,
            dedupSkipped: stats.dedupSkipped,
            validatorFallbackAccepts: stats.validatorFallbackAccepts,
          },
        });
      } catch (err) {
        finalizeMaintenanceRun(store, phase3Id, {
          status: "failed",
          reason: "phase3_exception",
          metrics: { error: (err as Error).message },
        });
      }
      results.push(loadMaintenanceRun(store, phase3Id));
    },
  );

  if (!lease.acquired) {
    const skippedId = insertMaintenanceRun(store, {
      lane: "heavy",
      phase: "gate",
      status: "skipped",
      reason: "lease_unavailable",
      finishedAt: new Date().toISOString(),
    });
    results.push(loadMaintenanceRun(store, skippedId));
  }

  return results;
}

function loadMaintenanceRun(store: Store, id: number): MaintenanceRunSummary {
  const row = store.db.prepare(
    `SELECT id, lane, phase, status, reason, selected_count, processed_count,
            created_count, updated_count, rejected_count, null_call_count,
            started_at, finished_at, metrics_json
       FROM maintenance_runs WHERE id = ?`,
  ).get(id) as MaintenanceRunSummary | undefined;
  if (!row) {
    throw new Error(`loadMaintenanceRun: row ${id} not found`);
  }
  return row;
}

/**
 * Start the heavy-maintenance worker loop. Fire-and-forget — returns a stop
 * function the caller can invoke on process shutdown. Off by default — the
 * caller decides whether to start it via `CLAWMEM_HEAVY_LANE=true` or equivalent.
 *
 * A reentrancy guard prevents overlapping ticks if a prior tick is still
 * running when the next interval fires. Separate from the DB-backed lease,
 * which prevents overlap across processes.
 */
export function startHeavyMaintenanceWorker(
  store: Store,
  llm: LlamaCpp,
  cfg: HeavyMaintenanceConfig = {},
): () => void {
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  // Clamp interval to minimum 30 seconds so buggy configs can't pin the CPU.
  const interval = Math.max(30_000, merged.intervalMs);

  console.log(
    `[heavy-lane] Starting worker (interval=${interval}ms, ` +
      `window=${merged.windowStartHour ?? "always"}-${merged.windowEndHour ?? "always"}, ` +
      `maxUsagesPer10m=${merged.maxContextUsagesPer10m})`,
  );

  heavyTimer = setInterval(async () => {
    if (heavyRunning) {
      console.log("[heavy-lane] Skipping tick (still running)");
      return;
    }
    heavyRunning = true;
    try {
      await runHeavyMaintenanceTick(store, llm, cfg);
    } catch (err) {
      console.error("[heavy-lane] Tick failed:", err);
    } finally {
      heavyRunning = false;
    }
  }, interval);
  heavyTimer.unref();

  return () => {
    if (heavyTimer) {
      clearInterval(heavyTimer);
      heavyTimer = null;
      console.log("[heavy-lane] Worker stopped");
    }
  };
}
