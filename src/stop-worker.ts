/**
 * 62.1 D11: the stop-pipeline worker — the durable consumer, hosted by `clawmem watch`.
 *
 * Every 60 s, under a bounded budget per tick and through the same Phase A/B code as the hooks, it drains what no
 * later Stop will:
 *  - feedback: the open general-vault rows of every registered transcript that is quiet for 10 minutes or whose
 *    session ended (a killed final Stop, a feedback row filled after the last Stop). A verdict is final only on proof
 *    the turn ended — a later turn, a Claude Code stop marker, a Stop, the session's end — never on age; a trailing
 *    turn with a closed pairing window (OpenClaw, Hermes) is credited provisionally meanwhile. A row whose registered
 *    file is gone is closed `unattributable` no sooner than 10 minutes after it; a keyless row waits for its binding
 *    and is never closed here;
 *  - named vaults: each pending mirror takes its slice of the general verdict;
 *  - handoffs (D5): the digest step for a known transcript whose handoff cursor is behind the file after 10 quiet
 *    minutes (the trailing turn provisional), and the uncapped render of a handoff still `render_needed` once its
 *    session ended or has had no new digest for 10 minutes;
 *  - due quarantined ranges (with their Phase C), queued judge deferrals, runnable causal markers.
 * Items are leased or transaction-gated, so a Stop and the worker never both apply one.
 */

import { existsSync, statSync } from "fs";
import type { Database } from "bun:sqlite";
import type { Store } from "./store.ts";
import { isoNow, epochNow, epochMs, monoNow, deadlineAfter, duration, earliest, isExpired, type MonoDeadline } from "./clock.ts";
import { lastChanges, stopPipelineReady } from "./stop-schema.ts";
import { attributeTranscript, applyMirrorSlices, countDueMirrors } from "./stop-feedback.ts";
import { replayDueRetries, DECISION_HOOK } from "./stop-extract.ts";
import { observerCallMeanMs } from "./observer.ts";
import { sweepCheckpoints } from "./stop-checkpoint.ts";
import { rejudgeDeferred } from "./stop-judge.ts";
import { drainCausalMarkers } from "./stop-causal.ts";
import { runHandoffDigests, renderHandoffDoc, HANDOFF_HOOK } from "./stop-handoff.ts";
import { readStopCursor } from "./stop-cursor.ts";
import { resolveCausalWriterMode, type CausalLlm } from "./causal-writer.ts";
import { RETRY_DUE_SQL, RETRY_DUE_AT_SQL, CAUSAL_DUE_SQL, CAUSAL_DUE_AT_SQL, REJUDGE_DUE_SQL, FEEDBACK_OPEN_SQL, RENDER_DUE_SQL, RENDER_LAST_DIGEST_SQL } from "./stop-due.ts";

export const STOP_WORKER_INTERVAL_MS = 60_000;
export const STOP_WORKER_TICK_BUDGET_MS = 25_000;
/** How long a transcript (or a handoff's digests) must be quiet before the worker acts for a missing Stop. */
export const STOP_WORKER_QUIET_MS = 10 * 60_000;
/** v0.41.2: the continuation slice's floor (it grows with the measured observer call, up to the tick budget − 2 s). */
const CONTINUATION_SLICE_MIN_MS = 15_000;

export type WorkerVault = { name: string; store: Store };

export type TickLimits = {
  transcripts: number;
  mirrors: number;
  renders: number;
  replays: number;
  rejudges: number;
  causal: number;
};
const DEFAULT_LIMITS: TickLimits = { transcripts: 50, mirrors: 100, renders: 20, replays: 3, rejudges: 10, causal: 5 };

export type TickReport = {
  attributed: number;
  /** Feedback verdicts made (or revised) provisionally on a quiet transcript. */
  provisional: number;
  unattributable: number;
  mirrors: number;
  digested: number;
  rendered: number;
  replayed: number;
  /** v0.41.4 (§7.2): replay rows claimed and processed this tick, whatever the outcome, and their ids. */
  attempted: number;
  attemptedIds: number[];
  rejudged: number;
  causal: number;
  errors: string[];
};

export type TickOptions = {
  deadline?: MonoDeadline;
  /** Test seam: the reads' byte bound (default STOP_READ_MAX_BYTES). */
  readMaxBytes?: number;
  /** The quiet period (default 10 minutes); `repair stop-queue --run` passes 0 to drain now. */
  quietMs?: number;
  limits?: Partial<TickLimits>;
};

type Locator = { session_id: string; transcript_key: string; transcript_path: string; host: string | null; session_key: string | null; ended_at: string | null };

/** A transcript examined for digest catch-up at (size, mtime) is not re-read until either changes (per vault, in-process). */
const examinedByDb = new WeakMap<object, Map<string, string>>();
/** The same for feedback: a transcript whose open rows made no progress is not re-read until it (or they) change. */
const feedbackMemo = new WeakMap<object, Map<string, string>>();
/** Where each vault's feedback scan resumes (in-process), so blocked groups never keep a due one out (T23 #7). */
const feedbackScanFrom = new WeakMap<object, string>();
const FEEDBACK_SCAN_MAX = 2_000;

function quietFor(path: string, nowMs: number, quietMs: number): { exists: boolean; quiet: boolean; size: number; mtimeMs: number } {
  try {
    const st = statSync(path);
    return { exists: true, quiet: nowMs - st.mtimeMs >= quietMs, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, quiet: false, size: 0, mtimeMs: 0 };
  }
}

function step(report: TickReport, name: string, fn: () => void): void {
  try { fn(); } catch (err) { report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
}

async function stepAsync(report: TickReport, name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
}

/** One tick over the general vault and every named vault. */
export async function runStopWorkerTick(
  general: Store,
  vaults: readonly WorkerVault[],
  llm: CausalLlm,
  opts?: TickOptions,
): Promise<TickReport> {
  const report: TickReport = {
    attributed: 0, provisional: 0, unattributable: 0, mirrors: 0, digested: 0, rendered: 0, replayed: 0, attempted: 0, attemptedIds: [], rejudged: 0,
    causal: 0, errors: [],
  };
  const db = general.db;
  if (!stopPipelineReady(db)) return report;
  const deadline = opts?.deadline ?? deadlineAfter(monoNow(), duration(STOP_WORKER_TICK_BUDGET_MS));
  const quietMs = opts?.quietMs ?? STOP_WORKER_QUIET_MS;
  const limits = { ...DEFAULT_LIMITS, ...opts?.limits };
  const nowMs = epochMs(epochNow());
  const locator = (sessionId: string, key: string) => db.prepare(
    `SELECT session_id, transcript_key, transcript_path, host, session_key, ended_at FROM session_transcripts WHERE session_id = ? AND transcript_key = ?`
  ).get(sessionId, key) as Locator | null;

  // v0.41.2 (BACKLOG 68.5, design §1.4): a due continuation — a held range whose observer checkpoint has progress to
  // resume — runs FIRST, in its own slice, so neither older failed rows nor the other steps starve it; a tick with a
  // responding LLM completes at least one of its windows whenever one observer call fits the slice.
  await stepAsync(report, "continuations", async () => {
    // The replay's own due predicate (codex T11-5): a continuation whose claimant died (its lease expired) is due too.
    const now = isoNow();
    const due = db.prepare(
      `SELECT 1 FROM stop_retries WHERE hook = ? AND last_error LIKE 'continuation:%'
         AND ${RETRY_DUE_SQL} LIMIT 1`
    ).get(DECISION_HOOK, now, now);
    if (!due) return;
    const sliceMs = Math.min(Math.max(2 * observerCallMeanMs() + 5_000, CONTINUATION_SLICE_MIN_MS), STOP_WORKER_TICK_BUDGET_MS - 2_000);
    const sliceEnd = deadlineAfter(monoNow(), duration(sliceMs));
    const replay = await replayDueRetries(general, { deadline: earliest(sliceEnd, deadline), limit: 1, continuationOnly: true });
    report.replayed += replay.replayed;
    report.attempted += replay.attempted;
    report.attemptedIds.push(...replay.attemptedIds);
    for (const r of replay.ranges) {
      report.causal += await drainCausalMarkers(general, llm, { deadline, rangeKey: r.key, limit: 1 });
    }
  });

  // Feedback: the open rows (pending, or provisional) of registered transcripts, paged from where the last tick
  // stopped so live transcripts never keep a quiet one out (T23 #7). A live transcript is skipped: its next Stop
  // attributes it. A quiet one is attributed provisionally — what the trailing turn has written so far — and finally
  // only on evidence that the turn ended: a later human entry, a Stop, or its session's end (SessionEnd / session_end)
  // — never on age alone, since a paused turn can resume (T23 #1, T24 #4).
  step(report, "feedback", () => {
    let memo = feedbackMemo.get(db);
    if (!memo) { memo = new Map(); feedbackMemo.set(db, memo); }
    const startAt = feedbackScanFrom.get(db) ?? "";
    const legs: [string, string | null][] = startAt ? [[startAt, null], ["", startAt]] : [["", null]];
    const page = db.prepare(
      `SELECT u.session_id AS sid, u.transcript_key AS tk, u.session_id || char(0) || u.transcript_key AS k,
         SUM(CASE WHEN f.state = 'pending' THEN 1 ELSE 0 END) AS pend, COUNT(*) AS open
       FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id
       WHERE ${FEEDBACK_OPEN_SQL} AND u.session_id || char(0) || u.transcript_key > ?
       GROUP BY u.session_id, u.transcript_key ORDER BY k LIMIT 200`
    );
    const countsOf = db.prepare(
      `SELECT SUM(CASE WHEN f.state = 'pending' THEN 1 ELSE 0 END) AS pend, COUNT(*) AS open
       FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id
       WHERE ${FEEDBACK_OPEN_SQL} AND u.session_id = ? AND u.transcript_key = ?`
    );
    let processed = 0;
    let scanned = 0;
    let last = startAt;
    let exhausted = true;
    scan: for (const [lo, hi] of legs) {
      let after = lo;
      for (;;) {
        const groups = page.all(after) as { sid: string; tk: string; k: string; pend: number; open: number }[];
        if (groups.length === 0) break;
        for (const g of groups) {
          if (hi !== null && g.k > hi) continue scan;
          after = g.k;
          last = g.k;
          if (++scanned > FEEDBACK_SCAN_MAX || processed >= limits.transcripts || isExpired(deadline)) { exhausted = false; break scan; }
          const loc = locator(g.sid, g.tk);
          if (!loc) continue;   // no locator: unreachable until one registers it (doctor counts these)
          const f = quietFor(loc.transcript_path, nowMs, quietMs);
          if (!f.exists) {
            // The registered file is gone: rows older than the quiet period can never be paired; a provisional verdict
            // is all there will be.
            const cutoff = new Date(nowMs - quietMs).toISOString();
            const now = isoNow();
            db.transaction(() => {
              db.prepare(
                `UPDATE feedback_turns SET state = 'unattributable', reason = 'transcript-gone', updated_at = ?, revision = revision + 1
                 WHERE state = 'pending' AND usage_id IN (
                   SELECT id FROM context_usage WHERE session_id = ? AND transcript_key = ? AND timestamp <= ?)`
              ).run(now, g.sid, g.tk, cutoff);
              report.unattributable += lastChanges(db);
              db.prepare(
                `UPDATE feedback_turns SET reason = NULL, updated_at = ?, revision = revision + 1 WHERE state = 'attributed' AND reason = 'provisional'
                   AND usage_id IN (SELECT id FROM context_usage WHERE session_id = ? AND transcript_key = ?)`
              ).run(now, g.sid, g.tk);
            }).immediate();
            processed++;
            continue;
          }
          const ended = loc.ended_at !== null;
          if (!f.quiet && !ended) continue;   // a live session: its next Stop attributes these rows
          const memoKey = g.k;
          const state = `${f.size}:${f.mtimeMs}:${ended ? 1 : 0}:${g.pend}`;
          if (memo.get(memoKey) === state) continue;   // nothing changed since the last pass over it
          const r = attributeTranscript(general, {
            sessionId: loc.session_id, transcriptPath: loc.transcript_path, host: loc.host ?? undefined,
            sessionKey: loc.session_key ?? undefined, atStop: ended, provisional: true, deadline, readMaxBytes: opts?.readMaxBytes,
          });
          report.attributed += r.attributed;
          report.provisional += r.provisional;
          report.unattributable += r.unattributable;
          // Memoized only after a pass that changed nothing: one that decided rows may have left decidable ones past
          // its page, and the next tick takes them (T34 #1); one that lost a compare-and-set to another pass never is,
          // since that pass may not have finished (T35 #3).
          const counts = countsOf.get(g.sid, g.tk) as { pend: number | null; open: number };
          if (!isExpired(deadline) && !r.retry && (counts.pend ?? 0) === g.pend && counts.open === g.open) {
            memo.set(memoKey, `${f.size}:${f.mtimeMs}:${ended ? 1 : 0}:${g.pend}`);
          }
          processed++;
        }
      }
    }
    feedbackScanFrom.set(db, exhausted ? "" : last);
  });

  // Named vaults: their mirrors' slices of the general verdicts.
  for (const v of vaults) {
    step(report, `mirrors:${v.name}`, () => { report.mirrors += applyMirrorSlices(general, v.store, v.name, { limit: limits.mirrors }); });
  }

  // Handoffs: digest catch-up for a transcript whose handoff cursor is behind after a quiet period.
  step(report, "handoff-digests", () => {
    let examined = examinedByDb.get(db);
    if (!examined) { examined = new Map(); examinedByDb.set(db, examined); }
    const rows = db.prepare(`SELECT session_id, transcript_key, transcript_path, host, session_key, ended_at FROM session_transcripts`).all() as Locator[];
    for (const loc of rows) {
      if (isExpired(deadline)) break;
      const f = quietFor(loc.transcript_path, nowMs, quietMs);
      if (!f.exists || !f.quiet) continue;
      const memoKey = `${loc.session_id}\u0000${loc.transcript_key}`;
      const state = `${f.size}:${f.mtimeMs}`;
      if (examined.get(memoKey) === state) continue;
      // Run the digest step while it progresses (a transcript larger than one read takes several), then remember
      // this file state only when a run made no progress — a cursor still behind stays eligible (T24 #3).
      let digestedHere = 0;
      let settled = false;
      for (let i = 0; i < 50; i++) {
        if (isExpired(deadline)) break;
        const before = readStopCursor(db, loc.session_id, HANDOFF_HOOK, loc.transcript_key);
        if (before && before.byteOffset >= f.size) { settled = true; break; }
        const r = runHandoffDigests(general, {
          sessionId: loc.session_id, transcriptPath: loc.transcript_path, host: loc.host ?? undefined,
          sessionKey: loc.session_key ?? undefined, atStop: false, deadline, readMaxBytes: opts?.readMaxBytes,
        });
        report.digested += r.digested;
        digestedHere += r.digested;
        if (r.discarded) break;   // a Stop is at it: look again next tick
        const after = readStopCursor(db, loc.session_id, HANDOFF_HOOK, loc.transcript_key);
        const moved = (after?.byteOffset ?? -1) !== (before?.byteOffset ?? -1) || (after?.nextDigestSeq ?? 0) !== (before?.nextDigestSeq ?? 0);
        if (!moved) { settled = true; break; }
      }
      if (digestedHere > 0) {
        // The transcript is already quiet, so this is no live session's doc: render it now, uncapped.
        db.transaction(() => {
          const row = db.prepare(`SELECT render_needed FROM session_docs WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff'`)
            .get(loc.session_id, loc.transcript_key) as { render_needed: number } | null;
          if (row?.render_needed === 1 && renderHandoffDoc(db, loc.session_id, loc.transcript_key, { cap: null })) report.rendered++;
        }).immediate();
      }
      if (!settled) continue;
      examined.set(memoKey, state);
    }
  });

  // Handoffs: the uncapped render once the session ended or its digests have been quiet.
  step(report, "handoff-renders", () => {
    const quietSince = new Date(nowMs - quietMs).toISOString();
    const due = db.prepare(
      `SELECT d.session_id, d.transcript_key FROM session_docs d
       WHERE ${RENDER_DUE_SQL}
       LIMIT ?`
    ).all(quietSince, limits.renders) as { session_id: string; transcript_key: string }[];
    for (const r of due) {
      if (isExpired(deadline)) break;
      db.transaction(() => {
        if (renderHandoffDoc(db, r.session_id, r.transcript_key, { cap: null })) report.rendered++;
        else db.prepare(`UPDATE session_docs SET render_needed = 0 WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff'`)
          .run(r.session_id, r.transcript_key);   // nothing renderable (never admitted): no marker left behind
      }).immediate();
    }
  });

  // Model-bearing queues last.
  await stepAsync(report, "replays", async () => {
    const replay = await replayDueRetries(general, { deadline, limit: limits.replays });
    report.replayed += replay.replayed;
    report.attempted += replay.attempted;
    report.attemptedIds.push(...replay.attemptedIds);
    for (const r of replay.ranges) {
      report.causal += await drainCausalMarkers(general, llm, { deadline, rangeKey: r.key, limit: 1 });
    }
  });
  await stepAsync(report, "rejudge", async () => { report.rejudged += await rejudgeDeferred(general, deadline, { limit: limits.rejudges }); });
  await stepAsync(report, "causal", async () => { report.causal += await drainCausalMarkers(general, llm, { deadline, limit: limits.causal }); });
  // v0.41.2: observer checkpoints nothing can resume any more (orphans only — design §1.4).
  step(report, "checkpoint-sweep", () => {
    const swept = sweepCheckpoints(db, nowMs);
    if (swept > 0) console.error(`[watch] stop-pipeline: swept ${swept} orphaned observer checkpoint(s)`);
  });
  return report;
}

export type StopWorkerHandle = { stop: () => Promise<void> };

/**
 * Start the worker loop: `prepare` (the one-time recompute and the antipattern-body preservation) runs first, then a
 * tick every interval, never two at once. `vaults()` is read per tick, so a vault added to the config is picked up.
 */
export function startStopPipelineWorker(
  general: Store,
  vaults: () => WorkerVault[],
  llm: CausalLlm,
  opts?: { intervalMs?: number; prepare?: () => Promise<void>; log?: (msg: string) => void },
): StopWorkerHandle {
  const interval = opts?.intervalMs ?? STOP_WORKER_INTERVAL_MS;
  const log = opts?.log ?? (() => {});
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  const tick = async () => {
    timer = null;
    if (stopped) return;
    running = (async () => {
      try {
        const r = await runStopWorkerTick(general, vaults(), llm);
        const moved = r.attributed + r.provisional + r.unattributable + r.mirrors + r.digested + r.rendered + r.replayed + r.rejudged + r.causal;
        if (moved > 0) {
          log(`[stop-worker] attributed ${r.attributed} (+${r.provisional} provisional), unattributable ${r.unattributable}, mirrors ${r.mirrors}, digested ${r.digested}, rendered ${r.rendered}, replayed ${r.replayed}, rejudged ${r.rejudged}, causal ${r.causal}`);
        }
        for (const e of r.errors) log(`[stop-worker] ${e}`);
      } catch (err) {
        log(`[stop-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    await running;
    running = null;
    if (!stopped) timer = setTimeout(() => { void tick(); }, interval);
  };
  void (async () => {
    if (opts?.prepare) {
      try { await opts.prepare(); } catch (err) { log(`[stop-worker] preparation failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (!stopped) await tick();
  })();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}

/** The general vault's queues, for `repair stop-queue` and doctor. */
export function dismissStopRetry(store: Store, id: number): boolean {
  store.db.prepare(`UPDATE stop_retries SET state = 'dismissed', claim_token = NULL, lease_expires_at = NULL WHERE id = ? AND state IN ('queued', 'claimed', 'unavailable')`).run(id);
  return lastChanges(store.db) === 1;
}

/**
 * v0.41.4 (§7.1): make quarantined ranges due now — `held` (queued rows whose last error is not a continuation) or the
 * given ids — `queued` rows only, at most `limit`, lowest ids first. A claimed row's lease is never touched. Returns the
 * ids rescheduled.
 */
export function retryNowStopRetries(store: Store, select: "held" | readonly number[], limit = 50): number[] {
  const db = store.db;
  const n = Math.floor(limit);
  if (!(n > 0)) return [];
  if (select !== "held" && select.length === 0) return [];
  let ids: number[] = [];
  db.transaction(() => {
    const rows = (select === "held"
      ? db.prepare(`SELECT id FROM stop_retries WHERE state = 'queued' AND (last_error IS NULL OR last_error NOT LIKE 'continuation:%') ORDER BY id LIMIT ?`).all(n)
      : db.prepare(`SELECT id FROM stop_retries WHERE state = 'queued' AND id IN (${select.map(() => "?").join(", ")}) ORDER BY id LIMIT ?`).all(...select, n)
    ) as { id: number }[];
    const now = isoNow();
    const due = db.prepare(`UPDATE stop_retries SET next_retry_at = ? WHERE id = ? AND state = 'queued'`);
    for (const r of rows) { due.run(now, r.id); if (lastChanges(db) === 1) ids.push(r.id); }
  }).immediate();
  return ids;
}

/**
 * v0.41.4 (§7.2; codex T7-10, T8-3): what remains due across the queues a worker tick services, and when the next one
 * not yet due becomes due — counted with the predicates the tick's own steps use (`stop-due.ts`, `mirrorReady`), so the
 * two cannot disagree. `quietMs` is the quiet window the tick ran with (`repair stop-queue --run` runs 0); `vaults` are
 * the named vaults it applied mirrors to. Feedback turns run on no schedule: every open one is examined each tick. The
 * handoff digest catch-up is no queue — each tick re-reads quiet transcripts whose handoff cursor is behind, keeping
 * in-process which made no progress — and is not counted. `--run` does not wait for future-due work.
 */
export function stopQueueNextDue(db: Database, opts?: { quietMs?: number; vaults?: readonly { name: string; store: Store }[] }): string {
  const now = isoNow();
  const quietMs = opts?.quietMs ?? STOP_WORKER_QUIET_MS;
  const quietSince = new Date(epochMs(epochNow()) - quietMs).toISOString();
  const has = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  type Due = { n: number | null; next_at: string | null };
  const line = (label: string, r: Due) => `${label} ${r.next_at ?? "none"}${(r.n ?? 0) > 0 ? ` (${r.n} due now)` : ""}`;
  const parts: string[] = [];
  parts.push(!has("stop_retries") ? "quarantined ranges —" : line("quarantined ranges", db.prepare(
    `SELECT SUM(CASE WHEN ${RETRY_DUE_SQL} THEN 1 ELSE 0 END) AS n, MIN(CASE WHEN NOT ${RETRY_DUE_SQL} THEN ${RETRY_DUE_AT_SQL} END) AS next_at
     FROM stop_retries WHERE hook = ? AND state IN ('queued', 'claimed')`
  ).get(now, now, now, now, DECISION_HOOK) as Due));
  parts.push(!has("feedback_turns") ? "feedback turns —" : `feedback turns ${(db.prepare(
    `SELECT COUNT(*) AS n FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id WHERE ${FEEDBACK_OPEN_SQL}`
  ).get() as { n: number }).n} open`);
  if (opts?.vaults && opts.vaults.length > 0) {
    parts.push(`vault mirrors ${opts.vaults.reduce((n, v) => n + countDueMirrors(db, v.store.db), 0)} due`);
  }
  parts.push(!has("judge_deferred") ? "deferred judge verdicts —" : line("deferred judge verdicts", db.prepare(
    `SELECT SUM(CASE WHEN ${REJUDGE_DUE_SQL} THEN 1 ELSE 0 END) AS n, MIN(CASE WHEN NOT ${REJUDGE_DUE_SQL} THEN next_retry_at END) AS next_at
     FROM judge_deferred WHERE state = 'queued'`
  ).get(now, now) as Due));
  if (!has("causal_due")) parts.push("causal steps —");
  else if (resolveCausalWriterMode() === "off") {
    // The causal step runs only with the writer on: its markers wait (doctor reports them).
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM causal_due WHERE state IN ('queued', 'claimed')`).get() as { n: number }).n;
    parts.push(`causal steps ${n} waiting (CLAWMEM_CAUSAL_WRITER is off)`);
  } else {
    parts.push(line("causal steps", db.prepare(
      `SELECT SUM(CASE WHEN ${CAUSAL_DUE_SQL} THEN 1 ELSE 0 END) AS n, MIN(CASE WHEN NOT ${CAUSAL_DUE_SQL} THEN ${CAUSAL_DUE_AT_SQL} END) AS next_at
       FROM causal_due WHERE state IN ('queued', 'claimed')`
    ).get(now, now, now, now) as Due));
  }
  if (!has("session_docs")) parts.push("handoff renders —");
  else {
    const r = db.prepare(
      `SELECT SUM(CASE WHEN ${RENDER_DUE_SQL} THEN 1 ELSE 0 END) AS n, MIN(CASE WHEN NOT ${RENDER_DUE_SQL} THEN ${RENDER_LAST_DIGEST_SQL} END) AS last
       FROM session_docs d WHERE d.kind = 'handoff' AND d.render_needed = 1`
    ).get(quietSince, quietSince) as { n: number | null; last: string | null };
    parts.push(line("handoff renders", { n: r.n, next_at: r.last ? new Date(Date.parse(r.last) + quietMs).toISOString() : null }));
  }
  return `next due: ${parts.join(" · ")}`;
}

/** How recent causal activity must be to show that some consumer still runs the writer. */
const CAUSAL_ACTIVE_MS = 60 * 60_000;

/**
 * Why dismissing the causal markers is refused, or null. The markers are meant to be dropped only when every consumer
 * keeps the lane off (T28 #11). This process's setting is checked, and so is what the vault shows of the others (T29
 * #9): a marker queued, or a causal run started, in the last hour means a Stop hook or a watcher runs the writer in
 * `shadow`/`on`, and its markers are runnable work.
 */
export function causalDismissRefusal(store: Store): string | null {
  const mode = resolveCausalWriterMode();
  if (mode !== "off") return `CLAWMEM_CAUSAL_WRITER is ${mode} in this process`;
  const since = new Date(epochMs(epochNow()) - CAUSAL_ACTIVE_MS).toISOString();
  const queued = (store.db.prepare(`SELECT MAX(created_at) AS at FROM causal_due WHERE created_at > ?`).get(since) as { at: string | null }).at;
  if (queued) return `a Stop hook queued a causal step at ${queued.slice(0, 16)}, so it runs with the writer on`;
  const hasRuns = !!store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'causal_runs'`).get();
  const ran = hasRuns
    ? (store.db.prepare(`SELECT MAX(started_at) AS at FROM causal_runs WHERE started_at > ?`).get(since) as { at: string | null }).at
    : null;
  if (ran) return `a causal step ran at ${ran.slice(0, 16)}, so a consumer runs the writer`;
  return null;
}

/**
 * Dismiss the causal markers waiting while the writer is off — for an operator who keeps the lane off: they are never
 * run. Refused (null) whenever `causalDismissRefusal` names a reason. The check and the deletion run in one write
 * transaction, and only markers queued before it are deleted, so none queued meanwhile is lost (T30 #6). Claimed
 * markers are left to their claimant. The check cannot see a consumer that runs the writer but has been idle for an
 * hour: the operator switches the writer off for every consumer first (cli.md).
 */
export function dismissCausalMarkers(store: Store): number | null {
  const db = store.db;
  let dismissed: number | null = null;
  db.transaction(() => {
    if (causalDismissRefusal(store) !== null) return;
    db.prepare(`DELETE FROM causal_due WHERE state = 'queued' AND created_at <= ?`).run(isoNow());
    dismissed = lastChanges(db);
  }).immediate();
  return dismissed;
}
