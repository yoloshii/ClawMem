/**
 * 62.1 D3 (rev 7/8): the causal step, at most once per committed range.
 *
 * Phase B of a committed range whose causal mode is `shadow` or `on` records a `causal_due` marker: the range's stable
 * run key `stop:<session id>:<transcript key>:<range key>`, its observation documents, the mode in force, and the
 * window instant (`window_at`: the commit time, or the source time of a replayed range). Consumers — Phase C of the
 * same Stop, later Stops of the session and the stop-pipeline worker — first RECONCILE in every mode (a marker whose
 * run key already has a `causal_runs` row started before a crash: it is deleted, never re-run); only when the current
 * mode is not `off` do they claim a remaining marker with a 5-minute lease, run the step with the more conservative of
 * the recorded and the current mode (`off < shadow < on`), and delete the marker once a run row exists under its key.
 * The run-row insert failing on the key means the run already started (delete); any other failure releases the claim
 * with backoff. A crash inside a started run is the writer's inherited behaviour, unchanged here.
 */

import { randomUUID } from "crypto";
import type { Store } from "./store.ts";
import { isoNow, type MonoDeadline } from "./clock.ts";
import { lastChanges, nextRetryAt } from "./stop-schema.ts";
import { resolveCausalWriterMode, runCausalStep, type CausalLlm } from "./causal-writer.ts";
import { CAUSAL_DUE_SQL } from "./stop-due.ts";
import type { ObservationWithDoc } from "./amem.ts";

export type CausalMode = "off" | "shadow" | "on";
const MODE_RANK: Record<CausalMode, number> = { off: 0, shadow: 1, on: 2 };
const LEASE_MS = 5 * 60_000;

export function causalRunKey(sessionId: string, transcriptKey: string, rangeKey: string): string {
  return `stop:${sessionId}:${transcriptKey}:${rangeKey}`;
}

/** Phase B: owe the range its causal run (only in shadow/on, only when it persisted observation documents). */
export function insertCausalMarker(
  store: Store,
  p: { sessionId: string; transcriptKey: string; rangeKey: string; obsDocIds: number[]; sourceTime: string | null; windowAt: string; now: string },
): boolean {
  const mode = resolveCausalWriterMode() as CausalMode;
  if (mode === "off" || p.obsDocIds.length === 0) return false;
  store.db.prepare(
    `INSERT OR IGNORE INTO causal_due (session_id, transcript_key, range_key, run_key, obs_doc_ids, source_time, window_at, mode, state, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`
  ).run(p.sessionId, p.transcriptKey, p.rangeKey, causalRunKey(p.sessionId, p.transcriptKey, p.rangeKey),
    JSON.stringify(p.obsDocIds), p.sourceTime, p.windowAt, mode, p.now);
  return lastChanges(store.db) === 1;
}

type Marker = { id: number; session_id: string; run_key: string; obs_doc_ids: string; window_at: string; mode: CausalMode };

/** Delete the markers whose run already started (every mode). Returns how many. */
export function reconcileCausalMarkers(store: Store, sessionId?: string): number {
  store.db.prepare(
    `DELETE FROM causal_due WHERE run_key IN (SELECT run_key FROM causal_runs)${sessionId ? " AND session_id = ?" : ""}`
  ).run(...(sessionId ? [sessionId] : []));
  return lastChanges(store.db);
}

function activeObservations(store: Store, ids: number[]): ObservationWithDoc[] {
  if (ids.length === 0) return [];
  const rows = store.db.prepare(
    `SELECT id, facts, observation_type FROM documents WHERE id IN (${ids.map(() => "?").join(",")}) AND active = 1`
  ).all(...ids) as { id: number; facts: string | null; observation_type: string | null }[];
  return rows.map(r => {
    let facts: string[] = [];
    try { facts = r.facts ? (JSON.parse(r.facts) as string[]) : []; } catch { /* malformed facts → none */ }
    return { docId: r.id, facts, obsType: r.observation_type ?? undefined, triples: [] } as ObservationWithDoc;
  });
}

/**
 * Drain due markers (reconcile first, then claim-run-delete while the mode is not `off`). Filters: a session, and one
 * range (Phase C of the Stop that just committed it). Returns the runs started.
 */
export async function drainCausalMarkers(
  store: Store,
  llm: CausalLlm,
  opts: { deadline: MonoDeadline; sessionId?: string; rangeKey?: string; limit?: number; invalidConfigNotes?: string[]; phaseSkipNotes?: string[] },
): Promise<number> {
  reconcileCausalMarkers(store, opts.sessionId);
  const current = resolveCausalWriterMode() as CausalMode;
  if (current === "off") return 0;   // the markers wait (doctor reports them)
  const now = isoNow();
  const markers = store.db.prepare(
    `SELECT id, session_id, run_key, obs_doc_ids, window_at, mode FROM causal_due
     WHERE ${CAUSAL_DUE_SQL}
       ${opts.sessionId ? "AND session_id = ?" : ""} ${opts.rangeKey ? "AND range_key = ?" : ""}
     ORDER BY id LIMIT ?`
  ).all(...[now, now, ...(opts.sessionId ? [opts.sessionId] : []), ...(opts.rangeKey ? [opts.rangeKey] : []), opts.limit ?? 3]) as Marker[];
  let started = 0;
  for (const m of markers) {
    const token = randomUUID();
    const lease = new Date(Date.parse(isoNow()) + LEASE_MS).toISOString();
    store.db.prepare(
      `UPDATE causal_due SET state = 'claimed', claim_token = ?, lease_expires_at = ?
       WHERE id = ? AND (state = 'queued' OR (state = 'claimed' AND lease_expires_at < ?))`
    ).run(token, lease, m.id, isoNow());
    if (lastChanges(store.db) !== 1) continue;   // another consumer holds it
    const release = (withBackoff: boolean) => store.db.prepare(
      `UPDATE causal_due SET state = 'queued', claim_token = NULL, lease_expires_at = NULL,
         attempts = attempts + ${withBackoff ? 1 : 0}, next_retry_at = ${withBackoff ? "?" : "next_retry_at"}
       WHERE id = ? AND claim_token = ?`
    ).run(...(withBackoff ? [nextRetryAt(isoNow(), 1)] : []), m.id, token);
    const drop = () => store.db.prepare(`DELETE FROM causal_due WHERE id = ? AND claim_token = ?`).run(m.id, token);
    if (store.db.prepare(`SELECT 1 FROM causal_runs WHERE run_key = ?`).get(m.run_key)) { drop(); continue; }
    const effective = MODE_RANK[m.mode] <= MODE_RANK[current] ? m.mode : current;
    if (effective === "off") { release(false); continue; }
    const obs = activeObservations(store, JSON.parse(m.obs_doc_ids) as number[]);
    if (obs.length === 0) {
      console.warn(`[causal] marker ${m.run_key}: its observation documents are no longer active — dropped`);
      drop();
      continue;
    }
    try {
      await runCausalStep(store, llm, {
        sessionId: m.session_id, mode: effective as "shadow" | "on", newObservations: obs, deadline: opts.deadline,
        runKey: m.run_key, windowAt: m.window_at, invalidConfigNotes: opts.invalidConfigNotes, phaseSkipNotes: opts.phaseSkipNotes,
      });
      started++;
      drop();
    } catch (err) {
      if (store.db.prepare(`SELECT 1 FROM causal_runs WHERE run_key = ?`).get(m.run_key)) drop();   // started (or already had)
      else release(true);   // no run recorded (vault busy): retried with backoff
      if (!/UNIQUE/i.test(String(err))) console.warn(`[causal] marker ${m.run_key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return started;
}
