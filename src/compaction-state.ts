/**
 * Session-scoped pre-compaction state (62.2 — CM-01, CM-04, CM-05, NEW-2).
 *
 * `precompact-extract` (PreCompact) stores ONE session's state; `postcompact-inject` (SessionStart,
 * source "compact") takes it for that session only, once.
 *
 * Through v0.39.1 the state was ONE `precompact-state.md` per project directory, written into Claude
 * Code's auto-memory dir and read by any SessionStart: every session in the directory received the
 * last compaction of whichever session compacted most recently, and a PreCompact that extracted
 * nothing left the older file in place to be replayed later.
 *
 * The state lives in the vault's `compaction_state` table, one row per session id. SQLite supplies
 * what a file protocol would have to build: cross-process locking that the OS releases when a process
 * dies, and atomic compare-and-set. One thing the vault cannot supply is a write that succeeds while
 * the vault itself is busy, so each attempt is also REGISTERED outside it:
 *
 *   register  PreCompact's first act, before the vault is even opened: the session's registration, a
 *             row in a small database beside the vault, is replaced (one upsert) with a new attempt
 *             token. From that moment every earlier attempt is ineligible, even when the vault stays
 *             busy, the hook times out or the process dies.
 *   begin     PreCompact's first vault write replaces the session's row with that attempt and no payload,
 *             only while the attempt is still the registered one (checked under the write lock).
 *   complete  After extracting (outside any transaction), the payload is stored only if the row still
 *             carries THIS attempt: an older PreCompact that finishes after a newer one began stores
 *             nothing. A failed or empty extraction leaves the row without a payload: nothing to take.
 *   take      SessionStart(compact) consumes the registration (marks it consumed; the row stays), then
 *             deletes the row carrying the registered attempt whatever its state (`DELETE … RETURNING`,
 *             so of two concurrent takers exactly one gets it). A row still being extracted is deleted
 *             too, so its late completion stores nothing. A row carrying any other attempt is never
 *             taken. Last, the registration is read again: when the session's latest attempt is no
 *             longer the one consumed, a newer PreCompact registered while the delete waited for the
 *             vault (whether or not another take has consumed it since), and nothing is returned.
 *
 * Irreducible residual: a PreCompact whose disk refuses BOTH writes (the registration and the begin)
 * cannot mark anything stale. Then a previous state of the session that no SessionStart took stays
 * takeable until its TTL: no write-side mechanism can act when no write succeeds.
 *
 * Supported-host assumption: Claude Code sends the same `session_id` to PreCompact and to the
 * SessionStart(compact) that follows it. The hooks reference calls it the current session's id on both
 * events; observed pairs in `context_usage` agree. The host sends no compaction id, so a state is
 * bound to its compaction by the registration and a TTL.
 *
 * Every function here is fail-open and never throws.
 */

import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./sqlite-guard.ts";
import { epochMs, epochNow, isoNow } from "./clock.ts";
import { sanitizeSnippet } from "./promptguard.ts";
import type { Store } from "./store.ts";

/** A state older than this is never taken. Observed PreCompact → SessionStart(compact) gaps: 81–107 s. */
export const COMPACTION_STATE_TTL_MS = 15 * 60 * 1000;
/** Rows no SessionStart took (crashed compactions, runtimes that never read back) are swept after this. */
export const COMPACTION_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A createdAt further in the future than this is treated as corrupt. */
const FUTURE_SKEW_MS = 60 * 1000;
/** A payload larger than this is not read. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Session ids longer than this are not accepted (Claude Code's are UUIDs; OpenClaw caps at 128). */
const MAX_SESSION_ID_LEN = 256;

export type CompactionDecision = { text: string; context: string };

export type CompactionState = {
  v: 1;
  sessionId: string;
  createdAt: string;
  trigger?: string;
  lastRequest: string;
  decisions: CompactionDecision[];
  openQuestions: string[];
  filePaths: string[];
};

/** What an extraction produces; `sessionId` and `createdAt` are added when it is stored. */
export type CompactionExtract = Omit<CompactionState, "v" | "sessionId" | "createdAt">;

type Db = Pick<Store, "db">;
/** Where a vault's registrations live: `dbPath` names the vault file, `db` stands in for an in-memory vault. */
type VaultRef = { dbPath: string; db?: Store["db"] };

/** A usable session id: a non-empty string of bounded length. Anything else means "no session". */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_SESSION_ID_LEN;
}

/** The DDL, run by `createStore`. */
export const COMPACTION_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS compaction_state (
    session_id TEXT PRIMARY KEY,
    attempt    TEXT NOT NULL,
    started_at TEXT NOT NULL,
    created_at TEXT,
    payload    TEXT
  )
`;

// ---------------------------------------------------------------------------
// Registration — outside the vault
// ---------------------------------------------------------------------------

/** Stale registrations deleted by one sweep. */
const SWEEP_MAX = 64;

/** In-memory vaults (tests) keep their registrations in memory, per database handle. */
const memoryRegistrations = new WeakMap<object, Map<string, { attempt: string; consumed: boolean }>>();

const isMemoryVault = (dbPath: string) => dbPath === ":memory:" || dbPath.startsWith("file::memory:");

/**
 * The registration database beside the vault file: `<vault>-compaction.sqlite`. It is written only by
 * the two compaction hooks, one small transaction at a time, so vault writers never contend for it.
 */
export function compactionRegistryPath(dbPath: string): string {
  return `${dbPath}-compaction.sqlite`;
}

const REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS registration (
    session_id    TEXT PRIMARY KEY,
    attempt       TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    consumed      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS registration_age ON registration(registered_at);
`;

/** Run `fn` on the vault's registration database, opened for this call and closed after it. */
function withRegistry<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = openDatabase(compactionRegistryPath(dbPath));
  try {
    db.exec(`PRAGMA busy_timeout = 2000`);
    db.exec(REGISTRY_DDL);
    addConsumedColumn(db);
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * A registration database an unreleased build created before `consumed` existed keeps its old table
 * (`CREATE TABLE IF NOT EXISTS` does not alter it): add the column. Every row such a build left is
 * unconsumed, since it deleted a registration when it consumed one. `ALTER TABLE … ADD COLUMN` is atomic;
 * a concurrent caller that added it first makes this one fail harmlessly.
 */
function addConsumedColumn(db: Database): void {
  if ((db.prepare(`PRAGMA table_info(registration)`).all() as { name: string }[]).some(c => c.name === "consumed")) return;
  try {
    db.exec(`ALTER TABLE registration ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0`);
  } catch { /* added concurrently */ }
}

/**
 * PreCompact's first act, before the vault is opened: register a new attempt as the session's latest
 * (one upsert). Returns the attempt token, or null when the id is unusable or the registration could
 * not be written (then this PreCompact must store nothing; its caller still clears the vault row). The
 * same transaction sweeps at most 64 registrations older than the retention window, oldest first
 * through an index: runtimes that never read back (OpenClaw, Hermes) leave one per session.
 */
export function registerCompaction(vault: VaultRef, sessionId: unknown): string | null {
  if (!isValidSessionId(sessionId)) return null;
  const attempt = `${process.pid}-${randomBytes(6).toString("hex")}`;
  if (isMemoryVault(vault.dbPath)) {
    if (!vault.db) return null;
    let m = memoryRegistrations.get(vault.db);
    if (!m) memoryRegistrations.set(vault.db, (m = new Map()));
    m.set(sessionId, { attempt, consumed: false });
    return attempt;
  }
  const cutoff = new Date(epochMs(epochNow()) - COMPACTION_STATE_RETENTION_MS).toISOString();
  try {
    withRegistry(vault.dbPath, db => db.transaction(() => {
      db.prepare(
        `INSERT INTO registration (session_id, attempt, registered_at, consumed) VALUES (?, ?, ?, 0)
         ON CONFLICT(session_id) DO UPDATE SET attempt = excluded.attempt, registered_at = excluded.registered_at,
           consumed = 0`
      ).run(sessionId, attempt, isoNow());
      db.prepare(
        `DELETE FROM registration WHERE rowid IN
           (SELECT rowid FROM registration WHERE registered_at < ? ORDER BY registered_at LIMIT ${SWEEP_MAX})`
      ).run(cutoff);
    }).immediate());
    return attempt;
  } catch {
    return null;
  }
}

/**
 * The session's registered attempt: the token, null when there is none, or undefined when the registration
 * database could not be read. `unconsumed` restricts it to a registration no take has consumed yet (what a
 * begin may still act on); without it, the latest attempt is returned whether consumed or not (what a take
 * compares against). Every caller treats undefined as "not this attempt".
 */
function readRegistration(vault: VaultRef, sessionId: string, opts: { unconsumed: boolean }): string | null | undefined {
  if (isMemoryVault(vault.dbPath)) {
    const r = vault.db ? memoryRegistrations.get(vault.db)?.get(sessionId) : undefined;
    return r && !(opts.unconsumed && r.consumed) ? r.attempt : null;
  }
  try {
    return withRegistry(vault.dbPath, db =>
      (db.prepare(`SELECT attempt FROM registration WHERE session_id = ?${opts.unconsumed ? " AND consumed = 0" : ""}`)
        .get(sessionId) as { attempt: string } | null)?.attempt ?? null);
  } catch {
    return undefined;
  }
}

/**
 * Consume the session's registration in one statement (`UPDATE … RETURNING`): the attempt it named, or null
 * when there was none unconsumed or it could not be read. The row stays, marked consumed, so a later reader
 * still sees which attempt is the session's latest; a register replaces it with a fresh, unconsumed attempt.
 * No take can consume it again.
 */
function consumeRegistration(vault: VaultRef, sessionId: string): string | null {
  if (isMemoryVault(vault.dbPath)) {
    const r = vault.db ? memoryRegistrations.get(vault.db)?.get(sessionId) : undefined;
    if (!r || r.consumed) return null;
    r.consumed = true;
    return r.attempt;
  }
  try {
    return withRegistry(vault.dbPath, db =>
      (db.prepare(`UPDATE registration SET consumed = 1 WHERE session_id = ? AND consumed = 0 RETURNING attempt`)
        .get(sessionId) as { attempt: string } | null)?.attempt ?? null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The vault row
// ---------------------------------------------------------------------------

/**
 * PreCompact's first vault write: replace the session's row with `attempt` and no payload (and sweep
 * rows older than the retention window). Refused unless `attempt` is still the session's registration,
 * checked under the vault's write lock: a PreCompact that a newer one superseded between its
 * registration and its vault open must not replace the newer one's row (every begin takes that lock,
 * so a newer registration either precedes this check or begins after this commit). False when refused
 * or when the write could not be made (e.g. the vault's write lock stayed busy): then nothing may be
 * stored — and the registration already made every earlier attempt ineligible.
 */
export function beginCompaction(store: Db & VaultRef, sessionId: unknown, attempt: string): boolean {
  if (!isValidSessionId(sessionId) || !attempt) return false;
  const now = isoNow();
  const cutoff = new Date(epochMs(epochNow()) - COMPACTION_STATE_RETENTION_MS).toISOString();
  try {
    return store.db.transaction(() => {
      if (readRegistration(store, sessionId, { unconsumed: true }) !== attempt) return false;
      store.db.prepare(`DELETE FROM compaction_state WHERE started_at < ? AND session_id <> ?`).run(cutoff, sessionId);
      store.db.prepare(
        `INSERT INTO compaction_state (session_id, attempt, started_at, created_at, payload) VALUES (?, ?, ?, NULL, NULL)
         ON CONFLICT(session_id) DO UPDATE SET attempt = excluded.attempt, started_at = excluded.started_at,
           created_at = NULL, payload = NULL`
      ).run(sessionId, attempt, now);
      return true;
    }).immediate();
  } catch {
    return false;
  }
}

/** Drop the session's row (a PreCompact that could not register clears what it cannot supersede). */
export function discardCompactionState(store: Db, sessionId: unknown): void {
  if (!isValidSessionId(sessionId)) return;
  try { store.db.prepare(`DELETE FROM compaction_state WHERE session_id = ?`).run(sessionId); } catch { /* fail-open */ }
}

/**
 * Store the extraction for `attempt`. True only when the row still carries this attempt (no newer
 * PreCompact of the session began meanwhile) and the payload was written.
 */
export function completeCompaction(store: Db, sessionId: string, attempt: string, extract: CompactionExtract): boolean {
  if (!isValidSessionId(sessionId)) return false;
  const createdAt = isoNow();
  const state: CompactionState = { v: 1, sessionId, createdAt, ...extract };
  try {
    const row = store.db.prepare(
      `UPDATE compaction_state SET payload = ?, created_at = ? WHERE session_id = ? AND attempt = ? RETURNING session_id`
    ).get(JSON.stringify(state), createdAt, sessionId, attempt) as { session_id: string } | null;
    return !!row;
  } catch {
    return false;
  }
}

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === "string");

/** Parse and validate a stored payload for `sessionId`; null on any defect (the TTL is checked by the caller). */
function parseState(raw: string, sessionId: string): CompactionState | null {
  if (raw.length > MAX_PAYLOAD_BYTES) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object" || o.v !== 1 || o.sessionId !== sessionId) return null;
  if (typeof o.createdAt !== "string" || typeof o.lastRequest !== "string") return null;
  if (!isStringArray(o.openQuestions) || !isStringArray(o.filePaths)) return null;
  if (!Array.isArray(o.decisions) || !o.decisions.every(d =>
    d && typeof (d as CompactionDecision).text === "string" && typeof (d as CompactionDecision).context === "string")) return null;
  return {
    v: 1,
    sessionId,
    createdAt: o.createdAt,
    trigger: typeof o.trigger === "string" ? o.trigger : undefined,
    lastRequest: o.lastRequest,
    decisions: o.decisions as CompactionDecision[],
    openQuestions: o.openQuestions,
    filePaths: o.filePaths,
  };
}

/**
 * SessionStart(compact)'s take. The session's registration is consumed first; then the row carrying
 * the registered attempt is deleted whatever its state (`DELETE … RETURNING`, so of two concurrent
 * takers exactly one gets it). A row still being extracted is deleted too, so its late completion
 * stores nothing. A row carrying any other attempt is never taken: a later PreCompact registered
 * after it (and then failed), or its registration was already consumed; the begin sweep removes it.
 *
 * The two databases take no joint lock, so the registration is read again after the delete. The
 * delete can wait seconds for the vault's write lock, and a PreCompact that registers meanwhile makes
 * the consumed attempt stale even when its own begin then fails on the same busy vault. A consume
 * marks the row instead of deleting it, and only a register replaces its attempt, so the session's
 * latest attempt is still the one consumed exactly when no PreCompact registered since, even one whose
 * registration a second take has already consumed. Otherwise nothing is returned, and neither is
 * anything when the registration cannot be read or is gone. The take therefore holds at the moment of
 * that read: no attempt newer than the one it consumed had been registered by then.
 *
 * Returns null when nothing is registered or matched, the id is unusable, the delete could not be made,
 * a newer registration exists (or cannot be ruled out), or the payload is malformed, written for
 * another session id, older than the TTL, or dated more than 60 s in the future.
 */
export function takeCompactionState(store: Db & VaultRef, sessionId: unknown): CompactionState | null {
  if (!isValidSessionId(sessionId)) return null;
  const registered = consumeRegistration(store, sessionId);
  if (!registered) return null;
  let row: { payload: string | null } | null = null;
  try {
    row = store.db.prepare(
      `DELETE FROM compaction_state WHERE session_id = ? AND attempt = ? RETURNING payload`
    ).get(sessionId, registered) as { payload: string | null } | null;
  } catch {
    return null;
  }
  if (!row || typeof row.payload !== "string") return null;
  if (readRegistration(store, sessionId, { unconsumed: false }) !== registered) return null;
  const state = parseState(row.payload, sessionId);
  if (!state) return null;
  const created = Date.parse(state.createdAt);
  if (!Number.isFinite(created)) return null;
  const age = epochMs(epochNow()) - created;
  if (age > COMPACTION_STATE_TTL_MS || age < -FUTURE_SKEW_MS) return null;
  return state;
}

// ---------------------------------------------------------------------------
// The v0.39.x artifact — recognised by content
// ---------------------------------------------------------------------------

/**
 * The exact header every ClawMem ≤ v0.39.x wrote at the top of `precompact-state.md`. The writer
 * shipped unchanged from 0bfce00 (2026-03-13) through v0.39.1, and no other code path in those
 * versions ever produced this text: only `precompact-extract` wrote it, to a file, which only the
 * indexer read.
 *
 * One test, in two languages: TypeScript here and SQL in the retrieval quarantine below. Both take the
 * body's first 256 characters, remove every CR, and require the LF header as a prefix. (The header is
 * ASCII, so a JS slice and SQLite's character `substr` agree on every body that can match.)
 */
const LEGACY_HEADER_PREFIX_CHARS = 256;
const LEGACY_STATE_HEADER_RE =
  /^# Pre-Compaction State\n\n_Extracted \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} before auto-compaction\. This is authoritative\._\n/;

/** True only for a file named `precompact-state.md` whose body carries that header. */
export function isLegacyPrecompactState(relativePath: string, body: string): boolean {
  const base = relativePath.split("/").pop() ?? "";
  return base === "precompact-state.md"
    && LEGACY_STATE_HEADER_RE.test(String(body ?? "").slice(0, LEGACY_HEADER_PREFIX_CHARS).replace(/\r/g, ""));
}

const LEGACY_HEADER_GLOB =
  `'# Pre-Compaction State' || char(10) || char(10) || ` +
  `'_Extracted [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9] ` +
  `before auto-compaction. This is authoritative._' || char(10) || '*'`;

/**
 * The retrieval quarantine: an SQL predicate that is true for every documents row EXCEPT the legacy
 * artifact (a `precompact-state.md` path whose content carries the header), whatever its origin, its
 * version of origin, or whether any migration ran. Every ranked retrieval path adds it next to its
 * `active = 1 AND invalidated_at IS NULL`: FTS, the vector hydrations, graph traversal, causal
 * retrieval and query's temporal channel. Nothing is deleted or rewritten, so a row stays reachable by
 * deliberate access (get / multi_get by path, lifecycle and forget targets). `doc` is the documents
 * alias; `body` an expression for the row's content when the query already joins it (else a lookup).
 * The CASE keeps the content test off every row whose path is not the artifact's. It reads no column
 * newer than `path` and `hash`, so it holds on every schema version.
 */
export function notLegacyArtifactSql(doc: string, body?: string): string {
  const content = body ?? `(SELECT qc.doc FROM content qc WHERE qc.hash = ${doc}.hash)`;
  return `(CASE WHEN ${doc}.path = 'precompact-state.md' OR substr(${doc}.path, -20) = '/precompact-state.md'
    THEN coalesce(replace(substr(${content}, 1, ${LEGACY_HEADER_PREFIX_CHARS}), char(13), ''), '') NOT GLOB (${LEGACY_HEADER_GLOB})
    ELSE 1 END)`;
}

/**
 * The indexer's retirement, corroborated by the file: `relativePath` in `collection` is the legacy
 * artifact ON DISK, so the active row at that path is retired when it carries the artifact too and its
 * origin is 'fs' or NULL (pre-v0.34; absence reconciliation never touches those, and the file on disk
 * is the provenance a NULL origin lacks). Reason 'absent', conditional on the verified hash and origin;
 * editing the file into anything else brings the row back. True when a row was retired. (Retrieval
 * never returned the row in the meantime: `notLegacyArtifactSql`.)
 */
export function retireLegacyPrecompactRow(store: Db, collection: string, relativePath: string): boolean {
  try {
    const r = store.db.prepare(
      `SELECT d.id, d.hash, d.origin, c.doc FROM documents d LEFT JOIN content c ON c.hash = d.hash
       WHERE d.collection = ? AND d.path = ? AND d.active = 1`
    ).get(collection, relativePath) as { id: number; hash: string; origin: string | null; doc: string | null } | null;
    if (!r || (r.origin !== null && r.origin !== "fs") || !isLegacyPrecompactState(relativePath, r.doc ?? "")) return false;
    return store.db.prepare(
      `UPDATE documents SET active = 0, deactivated_reason = 'absent'
       WHERE id = ? AND active = 1 AND hash = ? AND (origin IS NULL OR origin = 'fs')`
    ).run(r.id, r.hash).changes > 0;
  } catch {
    return false;
  }
}

/**
 * The stamp this version writes on every evolution entry (`memory_evolution.writer`). An older ClawMem writes
 * none, so an unstamped entry newer than the floor below was written by an older process after the upgrade.
 * A later version must keep stamping (any non-NULL value counts).
 */
export const EVOLUTION_WRITER = "clawmem-0.40";
/** vault_flags: the newest evolution entry when the `writer` column appeared (`fenceEvolutionWriters`). */
export const EVOLUTION_WRITER_FLOOR_FLAG = "amem:evolution-writer-floor";

/** The reason recorded on a reset marker: an evolution entry whose trigger is the note itself. */
export const LEGACY_NOTE_RESET_REASON =
  "reset: this A-MEM note may carry a legacy pre-compaction snapshot's text; it is rebuilt from the document's own text";

/**
 * The evolution-writer fence (62.2, codex T11 #1, T12 #1). The `writer` column and the floor are created in
 * ONE IMMEDIATE transaction, so no entry can land between them: an entry committed before it is the vault's
 * pre-upgrade history (at or below the floor), and one committed after it is above the floor, where an
 * unstamped entry has no author but an older ClawMem. `memory_evolution` is created without the column
 * (store.ts), so a new vault takes the same path. Read-guarded: a vault that has both takes no write lock.
 * Fail-closed: when the transaction cannot commit (a busy vault, a failed write, an insert that silently did
 * not land), nothing of it remains and the error propagates, so the store does not open; the next open tries
 * again. A vault with the column and no floor (only the unreleased rev-12 build, or a hand-deleted flag, leaves
 * one; operator ruling 2026-09-28, T13 #3: documented, not handled further) records the floor at its newest
 * entry.
 */
export function fenceEvolutionWriters(db: Database): void {
  const hasWriter = () =>
    (db.prepare(`PRAGMA table_info(memory_evolution)`).all() as { name: string }[]).some(c => c.name === "writer");
  const hasFloor = () => !!db.prepare(`SELECT 1 FROM vault_flags WHERE flag = ?`).get(EVOLUTION_WRITER_FLOOR_FLAG);
  if (hasWriter() && hasFloor()) return;
  try {
    db.transaction(() => {
      if (!hasWriter()) db.exec(`ALTER TABLE memory_evolution ADD COLUMN writer TEXT`);
      db.prepare(
        `INSERT OR IGNORE INTO vault_flags (flag, value, updated_at) VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM memory_evolution), ?)`
      ).run(EVOLUTION_WRITER_FLOOR_FLAG, isoNow());
      if (!hasFloor()) throw new Error("the floor insert did not land");   // CR-4: the outcome, not the attempt
    }).immediate();
  } catch (err) {
    throw new Error(
      `[clawmem] could not record the evolution-writer floor (${err instanceof Error ? err.message : String(err)}); ` +
      `the vault was not opened. Try again when no other process holds its write lock.`
    );
  }
}

/** SQL: the documents row `t` is the legacy snapshot. The path test comes first, so only its rows reach the content check. */
function isLegacyArtifactSql(t: string): string {
  return `((${t}.path = 'precompact-state.md' OR substr(${t}.path, -20) = '/precompact-state.md') AND NOT ${notLegacyArtifactSql(t)})`;
}

/**
 * SQL: the `memory_evolution` row `r` is a reset marker, recognised by its whole shape: triggered by its own
 * note, carrying exactly the reset reason, and none of an evolution's fields. `evolveMemories` never writes a
 * self-triggered entry, and never one without a new context.
 */
function resetMarkerSql(r: string): string {
  return `(${r}.triggered_by = ${r}.memory_id AND ${r}.reasoning = '${LEGACY_NOTE_RESET_REASON.replace(/'/g, "''")}'
    AND ${r}.new_context IS NULL AND ${r}.new_keywords IS NULL
    AND ${r}.previous_context IS NULL AND ${r}.previous_keywords IS NULL AND ${r}.writer IS NOT NULL)`;
}

/** SQL: the evolution-writer floor; without the flag no entry is above it. */
function writerFloorSql(): string {
  return `COALESCE((SELECT CAST(value AS INTEGER) FROM vault_flags WHERE flag = '${EVOLUTION_WRITER_FLOOR_FLAG}'), 9223372036854775807)`;
}

/**
 * SQL: the `memory_evolution` row `x`, whose trigger is the documents row `t`, may have carried a legacy
 * snapshot's text into its note: (a) the snapshot triggered it, or (b) an older ClawMem wrote it after the
 * upgrade (unstamped, above the floor). An older process reads A-MEM text unguarded, so what it evolved after
 * the upgrade may carry a copy's text in from any note it read, a note it read before a reset included.
 */
function suspectEntrySql(x: string, t: string): string {
  return `(${isLegacyArtifactSql(t)} OR (${x}.writer IS NULL AND ${x}.id > ${writerFloorSql()}))`;
}

/**
 * Ordinary active documents with a suspect evolution entry (`suspectEntrySql`) and no reset marker after it:
 * (a) one a legacy snapshot triggered (active or retired, any origin), reached from the snapshot's own rows
 * — CROSS JOIN fixes that order, so only they reach the content check and the triggered_by index (about
 * 0.2 ms on a 12k-document vault; the planner's own order scanned every evolution entry) — or (b) one an
 * older ClawMem wrote after the upgrade, a primary-key range above the floor. (b) covers every note, one no
 * copy ever touched included (operator ruling 2026-09-28, codex T13 #2: cleared automatically like (a)).
 */
function taintedNotesSql(): string {
  return `
    SELECT DISTINCT s.memory_id AS id
    FROM (
      SELECT e.memory_id, e.id FROM documents t CROSS JOIN memory_evolution e ON e.triggered_by = t.id
      WHERE ${isLegacyArtifactSql("t")}
      UNION ALL
      SELECT u.memory_id, u.id FROM memory_evolution u WHERE u.writer IS NULL AND u.id > ${writerFloorSql()}
    ) s
    CROSS JOIN documents m ON m.id = s.memory_id
    WHERE m.active = 1
      AND ${notLegacyArtifactSql("m")}
      AND NOT EXISTS (
        SELECT 1 FROM memory_evolution r
        WHERE r.memory_id = s.memory_id AND ${resetMarkerSql("r")} AND r.id > s.id
      )`;
}

/**
 * The derived-text repair (62.2, codex T9 #3; operator rulings: reset, and T13 #2: an older ClawMem's
 * post-upgrade evolutions too). A legacy snapshot that ≤ v0.39.x enrichment used as evidence may have written
 * its text into an ordinary document's A-MEM note, and every later evolution carries it forward; an older
 * process still running after the upgrade reads A-MEM text unguarded, so what it evolves may carry it too.
 * Each such note is cleared, so the light-lane backfill rebuilds it from the document's own text (a note indexed
 * from a file also on its next change or `clawmem reindex --enrich`; one hooks or the API wrote has only the
 * backfill, codex T14 #1), and a reset marker (`resetMarkerSql`)
 * is appended to its evolution history; `getEvolutionTimeline` hides everything from a suspect entry up to the
 * next marker. Run on every writable open and at the start of every backfill pass, never from model output:
 * read-guarded, so a vault with nothing to reset performs no write, and a note an older ClawMem taints again is
 * reset again. Fail-open: the read-side guard (`notLegacyTaintedNoteSql`) keeps a note it could not reset
 * unread. Returns the number reset.
 */
export function resetLegacyDerivedNotes(db: Database): number {
  try {
    if (!db.prepare(`${taintedNotesSql()} LIMIT 1`).get()) return 0;
    return db.transaction(() => {
      const ids = (db.prepare(taintedNotesSql()).all() as { id: number }[]).map(r => r.id);
      const clear = db.prepare(`UPDATE documents SET amem_keywords = NULL, amem_tags = NULL, amem_context = NULL WHERE id = ?`);
      const mark = db.prepare(
        `INSERT INTO memory_evolution (memory_id, triggered_by, version, reasoning, writer)
         VALUES (?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM memory_evolution WHERE memory_id = ?), ?, '${EVOLUTION_WRITER}')`
      );
      for (const id of ids) {
        clear.run(id);
        mark.run(id, id, id, LEGACY_NOTE_RESET_REASON);
      }
      return ids.length;
    }).immediate();
  } catch {
    return 0;
  }
}

/**
 * The evolution-history half of the repair: an SQL predicate, true for an entry `e` of `memory_evolution`
 * unless a suspect entry of the same note (`suspectEntrySql`: a legacy snapshot triggered it, or an older
 * ClawMem wrote it after the upgrade) lies at or before it with no reset marker in between (the suspect entry
 * itself included). The marker itself shows.
 */
export function notLegacyTaintedEvolutionSql(e: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM memory_evolution la JOIN documents lt ON lt.id = la.triggered_by
    WHERE la.memory_id = ${e}.memory_id AND la.id <= ${e}.id
      AND ${suspectEntrySql("la", "lt")}
      AND NOT EXISTS (
        SELECT 1 FROM memory_evolution lr
        WHERE lr.memory_id = la.memory_id AND ${resetMarkerSql("lr")} AND lr.id > la.id AND lr.id <= ${e}.id
      )
  )`;
}

/**
 * The read-side half of the repair (codex T10 #1, T11 #1): an SQL predicate, true for the documents row `doc`
 * unless its A-MEM note has a suspect evolution entry (`suspectEntrySql`) with no reset marker since. Every
 * read that hands A-MEM text to a model applies it, so the text is never read, whatever the reset has done: a
 * note an older ClawMem taints after this process opened the vault, one it evolved after a reset from what
 * it read before the reset, or one whose reset failed, reads as having no note until a reset clears it for a
 * rebuild.
 */
export function notLegacyTaintedNoteSql(doc: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM memory_evolution na JOIN documents nt ON nt.id = na.triggered_by
    WHERE na.memory_id = ${doc}.id AND ${suspectEntrySql("na", "nt")}
      AND NOT EXISTS (
        SELECT 1 FROM memory_evolution nr WHERE nr.memory_id = na.memory_id AND ${resetMarkerSql("nr")} AND nr.id > na.id
      )
  )`;
}

// ---------------------------------------------------------------------------
// Rendering — the injected block is reference DATA, never instructions
// ---------------------------------------------------------------------------

/**
 * Neutralise tag-shaped sequences so injected text can neither close the `<vault-postcompact>`
 * wrapper nor forge another one (`<system-reminder>`, `<vault-context>`…). `a < b` is untouched.
 */
export function neutralizeTags(text: string): string {
  return text.replace(/<(\/?[A-Za-z!?])/g, "‹$1");
}

/**
 * The one rendering rule for every dynamic field in `<vault-postcompact>` (captured state, vault
 * titles, paths, snippets): prompt-injection filter (flagged → "[content filtered for security]"),
 * collapsed to ONE line (no forged headings or list items), bounded, tags neutralised.
 */
export function safeInjectText(text: string, maxLen = 500): string {
  const oneLine = sanitizeSnippet(String(text ?? "")).replace(/\s+/g, " ").trim();
  const bounded = oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
  return neutralizeTags(bounded);
}

/** Markdown for the injected state section. Every captured item passes `safeInjectText`. */
export function renderCompactionState(state: CompactionState): string {
  const out: string[] = [
    `## Pre-Compaction State`,
    ``,
    `_Extracted ${safeInjectText(state.createdAt, 30).slice(0, 19)} before compaction (pattern extraction, no model)._`,
    ``,
  ];
  if (state.lastRequest) {
    out.push(`### Last User Request`, ``, safeInjectText(state.lastRequest, 500), ``);
  }
  if (state.decisions.length > 0) {
    out.push(`### Key Decisions This Session`, ``);
    for (const d of state.decisions) {
      out.push(`- ${safeInjectText(d.text, 500)}`);
      if (d.context) out.push(`  > Context: ${safeInjectText(d.context, 150)}`);
    }
    out.push(``);
  }
  if (state.openQuestions.length > 0) {
    out.push(`### Open Questions / Unresolved`, ``);
    for (const q of state.openQuestions) out.push(`- ${safeInjectText(q, 300)}`);
    out.push(``);
  }
  if (state.filePaths.length > 0) {
    out.push(`### Files Touched This Session`, ``);
    for (const p of state.filePaths) out.push(`- ${safeInjectText(p, 300)}`);
    out.push(``);
  }
  return out.join("\n").trim();
}

/**
 * Legacy `precompact-state.md` files a ClawMem ≤ v0.39.x left in Claude Code's per-project memory
 * dirs (`<projectsDir>/<project>/memory/precompact-state.md`), recognised by content, with their
 * modification time. Nothing in this version reads or writes them; a file modified after the vault's
 * retirement ran was written by an older ClawMem process that is still running. Bounded: one readdir
 * of `projectsDir`, at most 1000 entries, reading only the first KB of each candidate.
 */
export function legacyPrecompactStateFiles(projectsDir: string): { path: string; mtimeMs: number }[] {
  const found: { path: string; mtimeMs: number }[] = [];
  try {
    let seen = 0;
    for (const name of fs.readdirSync(projectsDir)) {
      if (++seen > 1000) break;
      const f = path.join(projectsDir, name, "memory", "precompact-state.md");
      try {
        const st = fs.statSync(f);
        if (!st.isFile()) continue;
        const fd = fs.openSync(f, "r");
        try {
          const buf = Buffer.alloc(1024);
          const n = fs.readSync(fd, buf, 0, 1024, 0);
          if (isLegacyPrecompactState("precompact-state.md", buf.subarray(0, n).toString("utf-8"))) {
            found.push({ path: f, mtimeMs: st.mtimeMs });
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch { /* absent or unreadable */ }
    }
  } catch { /* no projects dir */ }
  return found;
}
