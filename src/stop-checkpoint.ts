/**
 * v0.41.2 (BACKLOG 68.5) — durable window checkpoints for the Stop pipeline's observer (DESIGN-v0412.md §1.4).
 *
 * A unit (a batch of whole turns, one turn too large for a read, or a replayed range) that needs more than one observer
 * prompt is extracted in windows; after each completed window its progress is written here as PROVISIONAL state — no
 * range effect, no cursor move — so a later invocation (the next Stop, a replay, the worker's continuation slice)
 * resumes at the line where the last one stopped. Only the unit's terminal Phase B (the one that commits its `ok` /
 * `empty` effects) tombstones the row.
 *
 * Rows live in `vault_flags` (no schema change), keyed `observer-ckpt:<session>|<transcriptKey>|<hook>|<range_key>`.
 * Every write is ONE statement, and every write after `create` is a compare-and-swap on the exact stored value: a
 * concurrent advance, reset or tombstone changes the value, so the slower writer's CAS fails (it then stops working the
 * unit). That enforces the design's transitions — rev, state and forward-only progress — and is strictly stronger.
 */

import type { Database } from "bun:sqlite";
import { isoNow } from "./clock.ts";
import { lastChanges } from "./stop-schema.ts";
import type { LlmBackendId } from "./llm.ts";
import type { Observation, WindowBound } from "./observer.ts";

export const CHECKPOINT_PREFIX = "observer-ckpt:";
const CHECKPOINT_SCHEMA = 1;
/** A tombstone is swept once orphaned and this old. */
const TOMBSTONE_SWEEP_MS = 60 * 60_000;
/** A live checkpoint of a transcript that never got a cursor (a first Stop abandoned) is swept after this long. */
const ABANDONED_FIRST_STOP_MS = 7 * 24 * 60 * 60_000;
/** Where the sweep resumes (a key, not a checkpoint: it does not match CHECKPOINT_PREFIX). */
const SWEEP_CURSOR_FLAG = "observer_ckpt_sweep_cursor";

export type CheckpointRange = { anchorEpoch: number; from: number; to: number; sha: string; key: string };

export type ObserverCheckpoint = {
  schema: number;
  state: "live" | "done";
  rev: number;
  sessionId: string;
  transcriptKey: string;
  hook: string;
  range: { anchorEpoch: number; from: number; to: number; sha: string };
  linesSha: string;
  contract: string;
  backend: LlmBackendId;
  fingerprint: string;
  /** "weak" when the server's `/props` did not answer at the checkpoint's start (codex T11-3). */
  fingerprintStrength: "strong" | "weak";
  doneThroughLine: number;
  observations: Observation[];
  titles: string[];
  /**
   * v0.41.4 (DESIGN-v0414.md §3.3): a size reduction for the window starting at `doneThroughLine` (a cut reply's halving,
   * a validated oversize's correction). Optional — CHECKPOINT_SCHEMA stays 1 and older rows parse unchanged; a malformed
   * one is ignored by the observer, never invalidating the row. Shrink-only; dropped by the swap that advances the line.
   */
  windowBound?: WindowBound;
  at: string;
};

export type LoadedCheckpoint = { raw: string; value: ObserverCheckpoint | null };

export function checkpointKey(sessionId: string, transcriptKey: string, hook: string, rangeKey: string): string {
  return `${CHECKPOINT_PREFIX}${sessionId}|${transcriptKey}|${hook}|${rangeKey}`;
}

/** A stored checkpoint, or null when malformed (the sweep and the doctor skip it; the processor resets it). */
export function parseCheckpoint(raw: string): ObserverCheckpoint | null {
  try {
    const v = JSON.parse(raw) as Partial<ObserverCheckpoint>;
    if (v.schema !== CHECKPOINT_SCHEMA || (v.state !== "live" && v.state !== "done") || typeof v.rev !== "number") return null;
    if (typeof v.sessionId !== "string" || typeof v.transcriptKey !== "string" || typeof v.hook !== "string") return null;
    if (!v.range || typeof v.range.anchorEpoch !== "number" || typeof v.range.from !== "number" || typeof v.range.to !== "number"
      || typeof v.range.sha !== "string") return null;
    if (v.state === "done") return v as ObserverCheckpoint;
    if (typeof v.linesSha !== "string" || typeof v.contract !== "string" || typeof v.fingerprint !== "string") return null;
    if (v.fingerprintStrength !== "strong" && v.fingerprintStrength !== "weak") return null;
    if (!v.backend || (v.backend.kind !== "remote" && v.backend.kind !== "local")) return null;
    if (typeof v.doneThroughLine !== "number" || !Array.isArray(v.observations) || !Array.isArray(v.titles)) return null;
    return v as ObserverCheckpoint;
  } catch {
    return null;
  }
}

/** The row at `key`: its raw value (the CAS operand) and its parse (null when malformed — then only a reset applies). */
export function readCheckpoint(db: Database, key: string): LoadedCheckpoint | null {
  const row = db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(key) as { value: string } | null;
  if (!row) return null;
  return { raw: row.value, value: parseCheckpoint(row.value) };
}

/** Whether `c` is this unit's checkpoint: identity, schema, contract and rendered lines all match (design §1.4). */
export function checkpointMatches(
  c: ObserverCheckpoint,
  want: { sessionId: string; transcriptKey: string; hook: string; range: CheckpointRange; linesSha: string; contract: string },
): boolean {
  return c.state === "live" && c.sessionId === want.sessionId && c.transcriptKey === want.transcriptKey && c.hook === want.hook
    && c.range.from === want.range.from && c.range.to === want.range.to && c.range.sha === want.range.sha
    && c.range.anchorEpoch === want.range.anchorEpoch && c.linesSha === want.linesSha && c.contract === want.contract;
}

export function liveCheckpoint(p: Omit<ObserverCheckpoint, "schema" | "state" | "at">): ObserverCheckpoint {
  return { schema: CHECKPOINT_SCHEMA, state: "live", at: isoNow(), ...p };
}

/** *create*: `INSERT OR IGNORE` — the stored value, or null when a row (live, done or malformed) is already there. */
export function createCheckpoint(db: Database, key: string, c: ObserverCheckpoint): string | null {
  const raw = JSON.stringify(c);
  db.prepare(`INSERT OR IGNORE INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)`).run(key, raw, c.at);
  return lastChanges(db) === 1 ? raw : null;
}

/**
 * *advance* / *reset*: replace the row only if it still holds exactly `oldRaw` — the stored value, or null when another
 * processor changed it (advanced, reset or tombstoned it). The caller writes `rev + 1`; *advance* only with a larger
 * `doneThroughLine`.
 */
export function swapCheckpoint(db: Database, key: string, oldRaw: string, next: ObserverCheckpoint): string | null {
  const raw = JSON.stringify(next);
  db.prepare(`UPDATE vault_flags SET value = ?, updated_at = ? WHERE flag = ? AND value = ?`).run(raw, next.at, key, oldRaw);
  return lastChanges(db) === 1 ? raw : null;
}

/**
 * *finish*: the tombstone, written by the unit's TERMINAL Phase B only (inside its transaction) — unconditionally, since
 * the commit is authoritative. A slower processor's CAS then fails and its `INSERT OR IGNORE` cannot replace it.
 */
export function finishCheckpoint(
  db: Database, key: string, identity: { sessionId: string; transcriptKey: string; hook: string; range: CheckpointRange },
): void {
  const prev = readCheckpoint(db, key);
  const rev = (prev?.value?.rev ?? 0) + 1;
  const at = isoNow();
  const tomb = {
    schema: CHECKPOINT_SCHEMA, state: "done", rev, sessionId: identity.sessionId, transcriptKey: identity.transcriptKey,
    hook: identity.hook, range: { anchorEpoch: identity.range.anchorEpoch, from: identity.range.from, to: identity.range.to, sha: identity.range.sha },
    at,
  };
  db.prepare(
    `INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(tomb), at);
}

/**
 * Whether a queued or claimed `stop_retries` row holds `c`'s range, matched by its FULL identity (codex T12-3): session,
 * transcript, hook, and the range's epoch, offsets and bytes — what its `range_key` encodes. A re-anchored transcript's
 * range at the same offsets and bytes is another range.
 */
export function checkpointHeld(db: Database, c: Pick<ObserverCheckpoint, "sessionId" | "transcriptKey" | "hook" | "range">): boolean {
  return !!db.prepare(
    `SELECT 1 FROM stop_retries WHERE session_id = ? AND transcript_key = ? AND hook = ? AND anchor_epoch = ? AND from_offset = ?
       AND to_offset = ? AND range_sha = ? AND state IN ('queued', 'claimed') LIMIT 1`
  ).get(c.sessionId, c.transcriptKey, c.hook, c.range.anchorEpoch, c.range.from, c.range.to, c.range.sha);
}

/**
 * Whether `c`'s range is behind its transcript's cursor for that hook — the cursor at or past the range's end, or
 * re-anchored to another epoch (its offsets can no longer reach the range) — so no later Stop reaches the range again
 * (codex T13-2). Null when the transcript has no cursor (a first Stop that saved none).
 */
export function checkpointBehindCursor(db: Database, c: Pick<ObserverCheckpoint, "sessionId" | "transcriptKey" | "hook" | "range">): boolean | null {
  const cursor = db.prepare(`SELECT byte_offset, anchor_epoch FROM stop_cursors WHERE session_id = ? AND hook = ? AND transcript_key = ?`)
    .get(c.sessionId, c.hook, c.transcriptKey) as { byte_offset: number; anchor_epoch: number } | null;
  if (!cursor) return null;
  return cursor.anchor_epoch !== c.range.anchorEpoch || cursor.byte_offset >= c.range.to;
}

/**
 * The worker's sweep, orphans only (design §1.4): a row goes only when no queued/claimed `stop_retries` row has its
 * range AND either (a) its transcript's cursor for that hook is at or past the range's end, or (b) it is a tombstone at
 * least TOMBSTONE_SWEEP_MS old, or (c) it is live, older than ABANDONED_FIRST_STOP_MS, and its transcript has no cursor.
 * A cursor re-anchored to another epoch counts as past the range (its offsets can no longer reach it).
 * A missing cursor alone never orphans a live checkpoint (a first Stop has none until its Phase B). Returns the count.
 */
export function sweepCheckpoints(db: Database, nowMs: number, opts: { limit?: number; maxExamined?: number } = {}): number {
  // codex T11-6: pages by key from where the last sweep stopped, so rows that must stay never hide a newer orphan.
  const page = opts.limit ?? 200;
  const maxExamined = opts.maxExamined ?? 2_000;
  let after = (db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(SWEEP_CURSOR_FLAG) as { value: string } | null)?.value ?? "";
  let swept = 0;
  let examined = 0;
  for (;;) {
    const rows = db.prepare(`SELECT flag, value FROM vault_flags WHERE flag LIKE ? AND flag > ? ORDER BY flag LIMIT ?`)
      .all(`${CHECKPOINT_PREFIX}%`, after, page) as { flag: string; value: string }[];
    for (const row of rows) {
      examined++;
      after = row.flag;
      const c = parseCheckpoint(row.value);
      if (!c) continue;   // malformed: left for a reset by the processor that next reaches its unit
      if (checkpointHeld(db, c)) continue;
      const behind = checkpointBehindCursor(db, c);
      const age = nowMs - Date.parse(c.at);
      const orphan = behind === true
        || (c.state === "done" && age >= TOMBSTONE_SWEEP_MS)
        || (c.state === "live" && behind === null && age >= ABANDONED_FIRST_STOP_MS);
      if (!orphan) continue;
      db.prepare(`DELETE FROM vault_flags WHERE flag = ? AND value = ?`).run(row.flag, row.value);
      swept += lastChanges(db);
    }
    if (rows.length < page) { after = ""; break; }   // the end: the next sweep starts over
    if (examined >= maxExamined) break;               // bounded: the next sweep resumes after `after`
  }
  db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(SWEEP_CURSOR_FLAG, after, isoNow());
  return swept;
}
