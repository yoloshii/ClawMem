/**
 * BUILD-5 t60/t61 (codex F59-1/F59-2, F60-2..5): post-output bookkeeping for
 * the context-surfacing hook, moved OFF the hook's blocking lifetime.
 *
 * The split (F59-2 + F60-2): the alignment/query-history context_usage row is
 * written synchronously at retrieval-commit time inside the handler (bounded
 * by the hook process's busy_timeout); when that write fails, the hook FAILS
 * THE INJECTION ("alignment-unavailable") rather than injecting an untracked
 * turn — so every job in this module belongs to a turn whose alignment row
 * exists. What lives here is genuinely optional learning bookkeeping: the
 * injected-paths/tokens UPDATE onto that row, recall events, and the
 * per-vault context_usage mirror.
 *
 * The handoff (F59-1 + F60-4): the handler never touches SQLite or the
 * filesystem after payload assembly — it parks ONE pending job in a module
 * slot. The CLI layer (clawmem.ts cmdHook), AFTER writing the hook output to
 * stdout, hands the job over a PIPE to a detached `clawmem spool-ingest`
 * child and exits; the CHILD persists the job to the spool directory next to
 * the store's database file and then drains. The hook process therefore
 * performs no post-stdout fs or SQLite work at all — a spool/DB stall blocks
 * the child, never hook output or hook exit. Durability window, stated
 * honestly: a job dies with the child if the child is killed BEFORE its
 * spool write lands; once spooled, it survives crashes and is drained by a
 * later turn's child.
 *
 * Idempotency (F60-3): every job carries an immutable jobId; drainer-written
 * recall events carry per-event dedupe keys enforced UNIQUE in storage
 * (INSERT OR IGNORE), so a retry after a partial apply never duplicates
 * events. Application is tracked per UNIT ("update", "general", one per
 * named vault as "vault:<encoded-name>") in the claim file, so retries skip completed units; a job is
 * deleted only when EVERY unit completed. Claims abandoned by a killed
 * drainer are reclaimed when their pid is dead. t62 (codex
 * F61-4): the vault MIRROR insert is idempotent too — it carries a
 * `${jobId}:${vault}:mirror` dedupe key enforced UNIQUE on context_usage,
 * and a retried insert returns the EXISTING mirror row's id — so a crash
 * between the mirror insert and that vault's events duplicates nothing on
 * reclaim.
 *
 * Validation (F60-5): a spooled job must pass the full structural check
 * below before any write; anything else is discarded as poison.
 *
 * Direct callers (the eval harness, tests) bypass the spool: they call
 * consumePendingSurfacingBookkeeping() + applySurfacingBookkeeping()
 * synchronously when they need the end-state, or simply ignore the slot.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { isoNow, epochNow, epochMs } from "../clock.ts";
import { startsWithMark } from "../text-policy.ts";
import { dirname, join } from "node:path";
import type { Store } from "../store.ts";
import { resolveStore } from "../store.ts";
import { writeRecallEvents } from "../recall-buffer.ts";
import { stopPipelineReady } from "../stop-schema.ts";
import {
  markLegacyUsageRow,
  reconcileReferencedEvents,
  writeGeneralMembership,
  writeMirrorMembership,
  type ManifestItem,
} from "../stop-feedback.ts";

export type SurfacingBookkeepingVaultGroup = {
  /** null = the general store the hook ran against; string = named vault (resolveStore). */
  vault: string | null;
  docs: { displayPath: string; searchScore: number }[];
};

export type SurfacingBookkeepingJob = {
  v: 1;
  kind: "surfacing-bookkeeping";
  /** Immutable idempotency identity for this job's writes (F60-3). */
  jobId: string;
  sessionId: string;
  turnIndex: number;
  /** Rowid of the retrieval-commit alignment context_usage row. STRICTLY POSITIVE (t62 validator-enforced) — the hook fails the injection when that insert fails, so no job exists without a row id. */
  usageId: number;
  queryHash: string;
  injectedPaths: string[];
  estimatedTokens: number;
  vaults: SurfacingBookkeepingVaultGroup[];
  /** Units already applied by an earlier (partial) drain of this job — "update", "@general", or a vault name. Maintained by the drainer, absent on a fresh job. t62: validator-enforced unique and a subset of exactly the units this job declares. */
  completedUnits?: string[];
  /** t62 (codex F61-1): outcome of the guarded alignment-row UPDATE, persisted by the drainer once the "update" unit completes. true = the row matched its session/turn identity, recall events may link to usageId; false = deterministic absence — events are written UNLINKED. Absent until the update unit has run. */
  usageLinked?: boolean;
  /** 62.1 D1: the turn's identity (prompt hash, transcript key, host, session key), copied onto each mirror row. Absent on a job from a pre-upgrade hook, or from a vault whose migration was not verified. */
  promptSha?: string;
  transcriptKey?: string;
  host?: string;
  sessionKey?: string;
  /** 62.1 D6 (rev 17/18): the turn's injection manifest — exactly the results the renderer accepted into the context,
   * each with its vault (null = the general store), display path and the title as displayed. Absent on a job from a
   * pre-upgrade or older hook: such a job applies today's units only and its row is never attributed (rev 20). */
  manifest?: ManifestItem[];
};

/**
 * Unit key for a vault group. t63 (codex F62-2): the namespace is TAGGED so
 * a vault whose configured name is "update" or "general" can never collide
 * with the reserved internal units — named vaults live under
 * `vault:<encodeURIComponent(name)>`.
 */
function unitKeyForVault(vault: string | null): string {
  return vault === null ? "general" : `vault:${encodeURIComponent(vault)}`;
}

// ── Structural validation (F60-5) ───────────────────────────────────────────

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/**
 * Full admissibility check for a parsed spool job. Anything failing this is
 * poison: applying it could mutate the wrong usage row, throw-and-retry
 * until expiry, or write malformed attribution.
 */
/**
 * BACKLOG 82.3, D7: the identifier of a job that starts with a byte-order mark — its session id, or the
 * collection or relative path of a display path it names — or null. Such a job can only come from a spool written
 * before the upgrade; it is inadmissible (applying it would bind the mark-led value again, be refused, and be retried on
 * every drain). A display path is bound as two identifiers split at its FIRST slash (`resolveDocId`,
 * src/stop-feedback.ts), so only the start of each can be refused (Codex T1 S4): a mark that starts a deeper segment
 * lies inside the relative path and binds as it is.
 */
export function markedIdentifierInJob(x: unknown): string | null {
  if (typeof x !== "object" || x === null) return null;
  const j = x as Record<string, unknown>;
  const led = (v: unknown) => {
    if (typeof v !== "string") return false;
    const slash = v.indexOf("/");
    return slash < 0 ? startsWithMark(v) : startsWithMark(v.slice(0, slash)) || startsWithMark(v.slice(slash + 1));
  };
  if (typeof j.sessionId === "string" && startsWithMark(j.sessionId)) return "session id";
  if (Array.isArray(j.injectedPaths) && j.injectedPaths.some(led)) return "injected path";
  if (Array.isArray(j.vaults)) for (const g of j.vaults as unknown[]) {
    const docs = (g as { docs?: unknown } | null)?.docs;
    if (Array.isArray(docs) && docs.some(d => led((d as { displayPath?: unknown } | null)?.displayPath))) return "display path";
  }
  if (Array.isArray(j.manifest) && (j.manifest as unknown[]).some(m => led((m as { displayPath?: unknown } | null)?.displayPath))) return "manifest path";
  return null;
}

/** The one line that reports a discarded job naming a mark-led identifier (the value is not printed), or null. */
export function markedJobReport(x: unknown): string | null {
  const marked = markedIdentifierInJob(x);
  if (marked === null) return null;
  const id = (x as { jobId?: unknown }).jobId;
  return `[clawmem] spool: job ${typeof id === "string" ? id.slice(0, 80) : "?"} discarded — its ${marked} starts with a byte-order mark (a spool from before the upgrade).`;
}

export function validateSurfacingBookkeepingJob(x: unknown): x is SurfacingBookkeepingJob {
  if (typeof x !== "object" || x === null) return false;
  const j = x as Record<string, unknown>;
  if (j.v !== 1 || j.kind !== "surfacing-bookkeeping") return false;
  if (markedIdentifierInJob(j) !== null) return false;
  if (!isNonEmptyString(j.jobId) || !isNonEmptyString(j.sessionId) || !isNonEmptyString(j.queryHash)) return false;
  if (!Number.isInteger(j.turnIndex) || (j.turnIndex as number) < 0) return false;
  // t62 (codex F61-2): the contract says the alignment row EXISTS — a job
  // with a non-positive usageId is inadmissible, never a tolerated state.
  if (!Number.isInteger(j.usageId) || (j.usageId as number) <= 0) return false;
  if (!Number.isFinite(j.estimatedTokens) || (j.estimatedTokens as number) < 0) return false;
  if ((j.jobId as string).length > 512 || (j.sessionId as string).length > 512 || (j.queryHash as string).length > 512) return false;
  if (!Array.isArray(j.injectedPaths) || (j.injectedPaths as unknown[]).length > 200) return false;
  if (!(j.injectedPaths as unknown[]).every(x => isNonEmptyString(x) && x.length <= 1024)) return false;
  if (!Array.isArray(j.vaults) || (j.vaults as unknown[]).length > 16) return false;
  const seenVaults = new Set<string>();
  for (const g of j.vaults as unknown[]) {
    if (typeof g !== "object" || g === null) return false;
    const grp = g as Record<string, unknown>;
    if (!(grp.vault === null || isNonEmptyString(grp.vault))) return false;
    const key = unitKeyForVault(grp.vault as string | null);
    if (seenVaults.has(key)) return false; // duplicate vault group — ambiguous units
    seenVaults.add(key);
    if (!Array.isArray(grp.docs) || (grp.docs as unknown[]).length > 200) return false;
    for (const d of grp.docs as unknown[]) {
      if (typeof d !== "object" || d === null) return false;
      const doc = d as Record<string, unknown>;
      if (!isNonEmptyString(doc.displayPath) || doc.displayPath.length > 1024) return false;
      if (typeof doc.searchScore !== "number" || !Number.isFinite(doc.searchScore)) return false;
    }
  }
  // t62 (codex F61-2): completedUnits must be UNIQUE and a subset of exactly
  // the units THIS job declares ("update", "@general", each named vault) —
  // an unknown or duplicated unit could silently skip real work.
  if (j.completedUnits !== undefined) {
    if (!Array.isArray(j.completedUnits) || !(j.completedUnits as unknown[]).every(isNonEmptyString)) return false;
    const admissible = new Set<string>(["update", ...(j.vaults as { vault: string | null }[]).map(g => unitKeyForVault(g.vault))]);
    const seen = new Set<string>();
    for (const u of j.completedUnits as string[]) {
      if (!admissible.has(u) || seen.has(u)) return false;
      seen.add(u);
    }
  }
  if (j.usageLinked !== undefined && typeof j.usageLinked !== "boolean") return false;
  // 62.1 D1: optional identity strings, bounded like the other identifiers.
  for (const k of ["promptSha", "transcriptKey", "host", "sessionKey"] as const) {
    if (j[k] !== undefined && (!isNonEmptyString(j[k]) || (j[k] as string).length > 512)) return false;
  }
  // 62.1 D6: the manifest, bounded like the vault groups.
  if (j.manifest !== undefined) {
    if (!Array.isArray(j.manifest) || (j.manifest as unknown[]).length > 200) return false;
    for (const m of j.manifest as unknown[]) {
      if (typeof m !== "object" || m === null) return false;
      const e = m as Record<string, unknown>;
      if (e.vault !== null && (!isNonEmptyString(e.vault) || e.vault.length > 512)) return false;
      if (!isNonEmptyString(e.displayPath) || e.displayPath.length > 1024) return false;
      if (typeof e.displayedTitle !== "string" || e.displayedTitle.length > 2048) return false;
      if (e.docId !== undefined && e.docId !== null && !(Number.isSafeInteger(e.docId) && (e.docId as number) > 0)) return false;
    }
  }
  // t63/t64 (codex F62-2 + F63-1): the checkpoint state relation —
  // usageLinked exists IFF the update unit has completed, AND every
  // completed EVENT unit implies the update unit completed first. The
  // event-complete/update-incomplete shape is exactly the pre-t63 failure
  // state (events committed unlinked while the update was unsettled) — a
  // retry would skip the completed event unit permanently, so a claim
  // carrying it is poison, never a tolerated legacy.
  const cu = Array.isArray(j.completedUnits) ? (j.completedUnits as string[]) : [];
  const updateDone = cu.includes("update");
  if (updateDone !== (j.usageLinked !== undefined)) return false;
  if (!updateDone && cu.some(u => u !== "update")) return false;
  return true;
}

/**
 * t62/t63 (codex F61-3, F62-3): the pipe handoff to the spool-ingest child
 * is bounded only if the serialized job is — this cap bounds the payload
 * the parent hands off and the bytes the ingest child will accumulate.
 * The parent makes NO kernel-capacity assumption: its write lands in the
 * FileSink's user-space buffer and the flush is raced against a hard
 * timeout (clawmem.ts), so the handoff is time-bounded on ANY host and
 * delivery stays best-effort (the declared durability window). Enforced at
 * BOTH ends: the parent refuses to hand off an oversized job (fail-open —
 * optional learning data is dropped), and the ingest child aborts its
 * stdin read the moment the cap is crossed — never after buffering an
 * unbounded stream.
 */
export const SPOOL_JOB_MAX_BYTES = 32768;

/** Serialize a job for the pipe handoff. Returns null when the job is structurally inadmissible or its serialized form exceeds SPOOL_JOB_MAX_BYTES (drop it — bookkeeping is optional). */
export function serializeSurfacingBookkeepingJob(job: SurfacingBookkeepingJob): string | null {
  if (!validateSurfacingBookkeepingJob(job)) return null;
  const raw = JSON.stringify(job);
  if (Buffer.byteLength(raw, "utf-8") > SPOOL_JOB_MAX_BYTES) return null;
  return raw;
}

// ── In-process handoff slot ─────────────────────────────────────────────────
// One hook invocation per process in production; direct callers overwrite the
// slot per invocation, so it never grows.
let pendingJob: SurfacingBookkeepingJob | null = null;

export function setPendingSurfacingBookkeeping(job: SurfacingBookkeepingJob): void {
  pendingJob = job;
}

/** Take (and clear) the job the last contextSurfacing invocation parked, if any. */
export function consumePendingSurfacingBookkeeping(): SurfacingBookkeepingJob | null {
  const j = pendingJob;
  pendingJob = null;
  return j;
}

// ── The writes (drainer body) ───────────────────────────────────────────────

export type ApplyResult = {
  /** Every unit of the job that is now complete (including previously completed ones carried in). */
  completedUnits: string[];
  /** Units that failed THIS attempt (transient or otherwise) — the job must be retained for retry. */
  failedUnits: string[];
  /** t62 (codex F61-1): the guarded-update outcome — true only when the alignment row matched its identity. Carried into the retained claim so a retry's event units link (or stay unlinked) per the REAL row state, never per a stale id. Undefined only while the update unit has not yet completed. */
  usageLinked?: boolean;
};

/**
 * Apply one job's writes, unit by unit (F60-3):
 *  - "update": the guarded paths/tokens UPDATE onto the alignment row.
 *    A false return (row no longer matches its session/turn identity — e.g.
 *    purged or pre-migration store) is deterministic absence, counted
 *    complete: there is nothing to retry — but the outcome is CAPTURED as
 *    usageLinked (t62 F61-1) and every event unit links only when it is
 *    true; unlinked events carry usage_id NULL.
 *  - "general": recall events into the hook's own store, deduped by
 *    `${jobId}:general:${docId}` keys.
 *  - one unit per named vault ("vault:<encoded-name>"): the context_usage
 *    mirror insert + deduped recall events.
 * Units in job.completedUnits are skipped. Event units run ONLY once the
 * update unit has settled (t63 F62-1) — a thrown update defers them all.
 * NEVER throws for per-unit failures — the caller reads failedUnits and
 * retains the job for retry.
 */
export function applySurfacingBookkeeping(
  store: Store,
  job: SurfacingBookkeepingJob,
  opts?: { vaultBusyTimeout?: number; /** test seam: overrides named-vault store resolution (prod default = resolveStore) */ resolveVaultStore?: (vault: string) => Store }
): ApplyResult {
  const done = new Set(job.completedUnits ?? []);
  const failed: string[] = [];
  const run = (unit: string, fn: () => void): void => {
    if (done.has(unit)) return;
    try { fn(); done.add(unit); } catch { failed.push(unit); }
  };

  // t62 (codex F61-1): linkage follows the GUARDED row-match outcome, never
  // the bare id. Persisted (ApplyResult → retained claim) so retries in a
  // later drainer still link per the real row state.
  let usageLinked: boolean | undefined = job.usageLinked;
  // 62.1 D6: a job carrying a manifest, on a vault whose stop-pipeline migration is verified, applies its general
  // membership in ONE transaction — the guarded fill-in, the manifest, the surfaced counts, the pending row and the
  // general recall events — and completes the "update" and "general" units together. A job WITHOUT the manifest takes
  // today's units; a linked row without a manifest is never attributed (rev 20). A manifest job on a vault whose
  // migration is NOT verified on this connection fails its unit and is retained (T23 #5): the legacy path would
  // consume it for good, and its membership, pending row and surfaced counts would never land.
  const hasManifest = Array.isArray(job.manifest);
  const withManifest = hasManifest && stopPipelineReady(store.db);
  const generalUnit = unitKeyForVault(null);
  const generalGroup = job.vaults.find(g => g.vault === null);
  run("update", () => {
    if (hasManifest && !withManifest) throw new Error("stop-pipeline migration not verified on this connection — the manifest job waits");
    if (!withManifest) {
      usageLinked = job.usageId > 0 && store.updateUsageInjection(job.usageId, job.injectedPaths, job.estimatedTokens, {
        sessionId: job.sessionId,
        turnIndex: job.turnIndex,
      });
      return;
    }
    let linked = false;
    store.db.transaction(() => {
      linked = job.usageId > 0 && store.updateUsageInjection(job.usageId, job.injectedPaths, job.estimatedTokens, {
        sessionId: job.sessionId,
        turnIndex: job.turnIndex,
      });
      if (linked) writeGeneralMembership(store.db, job.usageId, job.manifest!);
      if (generalGroup && !done.has(generalUnit)) {
        writeRecallEvents(store, job.sessionId, job.queryHash, generalGroup.docs, linked ? job.usageId : undefined, job.turnIndex, { dedupeKeyBase: `${job.jobId}:${generalUnit}` });
        if (linked) reconcileReferencedEvents(store.db, job.usageId);
      }
    }).immediate();
    usageLinked = linked;   // assigned only after the commit
    if (generalGroup) done.add(generalUnit);
  });
  if (!withManifest && usageLinked === true && stopPipelineReady(store.db)) {
    try { markLegacyUsageRow(store.db, job.usageId); } catch { /* retried with the job */ }
  }

  // t63 (codex F62-1): event units DEPEND on a settled update outcome. A
  // THROWN update leaves usageLinked undefined — running events then would
  // commit them UNLINKED and mark them complete, so a later retry (update
  // finally succeeding) could never link them. Defer: when the update unit
  // did not complete this pass, every pending event unit is marked failed
  // WITHOUT running, and the whole job retries later.
  const updateSettled = done.has("update");
  const linkId = usageLinked === true ? job.usageId : undefined;
  for (const group of job.vaults) {
    const unit = unitKeyForVault(group.vault);
    if (!updateSettled) {
      if (!done.has(unit)) failed.push(unit); // deferred — never ran
      continue;
    }
    if (group.vault === null) {
      run(unit, () => {
        writeRecallEvents(store, job.sessionId, job.queryHash, group.docs, linkId, job.turnIndex, { dedupeKeyBase: `${job.jobId}:${unit}` });
      });
    } else {
      const vault = group.vault;
      run(unit, () => {
        const vaultStore = opts?.resolveVaultStore ? opts.resolveVaultStore(vault) : resolveStore(vault, { busyTimeout: opts?.vaultBusyTimeout ?? 5000 });
        const vaultReady = stopPipelineReady(vaultStore.db);
        if (hasManifest && !vaultReady) throw new Error(`vault ${vault}: stop-pipeline migration not verified — the manifest unit waits`);
        const dedupeKey = `${job.jobId}:${unit}:mirror`;
        // Mirror context_usage row into the named vault for correct FK +
        // attribution. t62 (F61-4): the dedupe key makes this idempotent —
        // a reclaim after a crash-mid-unit gets the EXISTING mirror row's
        // id back instead of inserting a second one. (t63: keys carry the
        // TAGGED unit name so vault names can never collide with reserved
        // units in the dedupe namespace either.) 62.1 D6: the mirror, its own
        // membership and its recall events commit together in the vault.
        vaultStore.db.transaction(() => {
          const existed = !!vaultStore.db.prepare(`SELECT 1 FROM context_usage WHERE dedupe_key = ?`).get(dedupeKey);
          const vaultUsageId = vaultStore.insertUsage({
            dedupeKey,
            sessionId: job.sessionId,
            timestamp: isoNow(),
            hookName: "context-surfacing",
            injectedPaths: group.docs.map(d => d.displayPath),
            estimatedTokens: 0,
            wasReferenced: 0,
            turnIndex: job.turnIndex,
            promptSha: job.promptSha ?? null,
            transcriptKey: job.transcriptKey ?? null,
            host: job.host ?? null,
            sessionKey: job.sessionKey ?? null,
            sourceUsageId: usageLinked === true ? job.usageId : null,
          });
          if (vaultReady && !existed && vaultUsageId > 0) {
            if (Array.isArray(job.manifest)) {
              writeMirrorMembership(vaultStore.db, vaultUsageId, job.manifest.filter(m => m.vault === vault), usageLinked === true);
            } else {
              markLegacyUsageRow(vaultStore.db, vaultUsageId);
            }
          }
          writeRecallEvents(vaultStore, job.sessionId, job.queryHash, group.docs, vaultUsageId > 0 ? vaultUsageId : undefined, job.turnIndex, { dedupeKeyBase: `${job.jobId}:${unit}` });
          if (vaultReady && vaultUsageId > 0) reconcileReferencedEvents(vaultStore.db, vaultUsageId);
        }).immediate();
      });
    }
  }

  return { completedUnits: [...done], failedUnits: failed, ...(usageLinked !== undefined ? { usageLinked } : {}) };
}

// ── Spool (CLI layer) ───────────────────────────────────────────────────────

/** Spool jobs older than this are discarded unprocessed (stale learning signal). */
export const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function spoolDirForDb(dbPath: string): string {
  return join(dirname(dbPath), "surfacing-spool");
}

let spoolSeq = 0;

/**
 * Persist a job into the spool next to the database file. Bounded fs work
 * (mkdir + tmp write + atomic rename); returns the job file path, or null
 * when the store has no on-disk home (":memory:") or any fs step fails
 * (fail-open — bookkeeping is a learning signal, never output-critical).
 * Runs in the spool-ingest CHILD in production (F60-4) — never in the hook
 * process.
 */
export function writeSurfacingBookkeepingSpoolJob(dbPath: string, job: SurfacingBookkeepingJob): string | null {
  if (!dbPath || dbPath === ":memory:") return null;
  try {
    const dir = spoolDirForDb(dbPath);
    mkdirSync(dir, { recursive: true });
    const name = `${epochMs(epochNow())}-${process.pid}-${spoolSeq++}.json`;
    const tmp = join(dir, `${name}.tmp`);
    const final = join(dir, name);
    writeFileSync(tmp, JSON.stringify(job));
    renameSync(tmp, final);
    return final;
  } catch {
    return null;
  }
}

const CLAIM_RE = /\.json\.claim-(\d+)$/;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM would mean it exists under another uid
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Drain every job file in the store's spool directory.
 *
 * Concurrency: each job is CLAIMED by an atomic rename to
 * `<name>.claim-<pid>` before its writes run — a concurrent drainer's rename
 * throws and it skips the file — so no two live drainers apply one job.
 *
 * Reclaim (F60-3): a `.claim-<pid>` whose pid is DEAD is renamed back to
 * `.json` and processed normally — an abandoned claim is picked up by the
 * next drainer, not left to age out. Live-pid claims are skipped.
 *
 * Outcomes per file:
 *  - fails validateSurfacingBookkeepingJob / unparsable / stale
 *    (> SPOOL_MAX_AGE_MS) → DELETED (poison must not wedge the spool);
 *  - some units failed (DB contention, vault unavailable) → claim renamed
 *    back to `.json` carrying the units that DID complete, for a later
 *    retry that skips them;
 *  - all units complete → deleted; `applied` counts it.
 *  - leftover `.tmp` past the stale age → DELETED.
 */
export function drainSurfacingBookkeepingSpool(
  store: Store,
  opts?: { now?: number; vaultBusyTimeout?: number }
): { applied: number; discarded: number; retained: number } {
  const out = { applied: 0, discarded: 0, retained: 0 };
  const dbPath = store.dbPath;
  if (!dbPath || dbPath === ":memory:") return out;
  const dir = spoolDirForDb(dbPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // no spool dir — nothing pending
  }
  const now = opts?.now ?? epochMs(epochNow());

  // Pass 1 — housekeeping over non-.json entries: reclaim dead-pid claims,
  // reap stale .tmp orphans (and stale claims whose pid probe is unusable).
  for (const name of entries) {
    if (name.endsWith(".json")) continue;
    const file = join(dir, name);
    const claimMatch = name.match(CLAIM_RE);
    if (claimMatch) {
      const pid = Number(claimMatch[1]);
      if (pid !== process.pid && !pidIsAlive(pid)) {
        try { renameSync(file, join(dir, name.replace(CLAIM_RE, ".json"))); continue; } catch { /* fall through to stale check */ }
      }
    }
    try {
      if (now - statSync(file).mtimeMs > SPOOL_MAX_AGE_MS) { unlinkSync(file); out.discarded++; }
    } catch { /* already gone — fine */ }
  }

  // Pass 2 — re-list (reclaims above may have restored .json files).
  let jsonNames: string[];
  try {
    jsonNames = readdirSync(dir).filter(n => n.endsWith(".json")).sort();
  } catch {
    return out;
  }

  for (const name of jsonNames) {
    const file = join(dir, name);
    const claim = `${file}.claim-${process.pid}`;
    try {
      renameSync(file, claim); // atomic claim — a concurrent drainer loses here
    } catch {
      continue; // claimed by another drainer (or already drained)
    }
    let job: SurfacingBookkeepingJob | null = null;
    try {
      const stale = now - statSync(claim).mtimeMs > SPOOL_MAX_AGE_MS;
      if (!stale) {
        const parsed = JSON.parse(readFileSync(claim, "utf-8")) as unknown;
        const report = markedJobReport(parsed);
        if (report !== null) {
          try { process.stderr.write(report + "\n"); } catch { /* stderr closed */ }   // discarded below, reported
        } else if (validateSurfacingBookkeepingJob(parsed)) job = parsed;
      }
    } catch { /* unreadable/unparsable → discard below */ }
    if (!job) {
      try { unlinkSync(claim); out.discarded++; } catch { out.retained++; }
      continue;
    }
    const r = applySurfacingBookkeeping(store, job, { vaultBusyTimeout: opts?.vaultBusyTimeout });
    if (r.failedUnits.length === 0) {
      try { unlinkSync(claim); } catch { /* already gone — fine */ }
      out.applied++;
    } else {
      // Retain for a later drainer, carrying the completed units so the
      // retry (with per-event dedupe keys as the second belt) skips them.
      try {
        writeFileSync(claim, JSON.stringify({ ...job, completedUnits: r.completedUnits, ...(r.usageLinked !== undefined ? { usageLinked: r.usageLinked } : {}) }));
        renameSync(claim, file);
      } catch { /* claim left in place — dead-pid reclaim or stale-age cleanup will handle it */ }
      out.retained++;
    }
  }
  return out;
}
