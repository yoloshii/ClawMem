/**
 * 62.1 D6: feedback — a turn's membership, written once by the bookkeeping drainer, and its attribution, applied once
 * by a Stop or the stop-pipeline worker.
 *
 * Membership (drainer, one transaction per vault): the general vault's `feedback_ledger` holds the turn's injection
 * MANIFEST — one entry per document rendered into the context, from every vault, with the title as displayed — and
 * each document the general vault owns is counted surfaced once; the turn's `feedback_turns` row starts `pending`. A
 * named vault's mirror row records its general row (`source_usage_id`) and pins its own entries in its own ledger.
 *
 * Attribution: a pending row is paired with its human turn by identity (D1, `pairTurns`), and only once that turn is
 * over; the reference test runs once over the turn's whole manifest (`verifiedReferences`). A verified reference
 * flips its entry's `referenced_at` NULL → now exactly once, and only that flip applies the counters (stamped writes,
 * D9). The row then turns `attributed`; a row whose turn is readable and pairs with no unique row turns
 * `unattributable` — never guessed. A named vault applies the verdicts of its own entries once the general row is
 * terminal, in its own transaction.
 */

import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import type { Store } from "./store.ts";
import { isoNow, type MonoDeadline } from "./clock.ts";
import { freshStamp, lastChanges, stopPipelineReady } from "./stop-schema.ts";
import { pairWindowClosed, pairTurns, parseEntryTime, stopHostOf, transcriptKey, type PairingEntry } from "./stop-pairing.ts";
import { bindKeylessUsageRows, locatorPath, registerTranscript } from "./stop-identity.ts";
import { humanLineAtOrBefore, streamLines } from "./stop-cursor.ts";
import { dropHermesMarks, hermesGeneration, hermesMark, scanHermesTranscript, stillHermesFile, type HermesScan } from "./stop-hermes-scan.ts";
import { verifiedReferences, type ReferenceEntry } from "./recall-attribution.ts";
import { FEEDBACK_OPEN_ROW_SQL } from "./stop-due.ts";

/**
 * One document the renderer accepted into the injected context (the spool job carries these, D6 rev 18), with its
 * document id in its own vault as the hook resolved it before rendering (T23 #2; null from a hook that could not).
 */
export type ManifestItem = { vault: string | null; displayPath: string; displayedTitle: string; docId?: number | null };

const KEY_SEP = "\u0000";
const entryKey = (vault: string, displayPath: string) => `${vault}${KEY_SEP}${displayPath}`;

/**
 * The document a display path names in this vault, whatever its state now: `(collection, path)` is unique and a row is
 * never deleted, so an injected document archived before its job drains keeps its identity (T23 #2).
 */
function resolveDocId(db: Database, displayPath: string): number | null {
  const slash = displayPath.indexOf("/");
  if (slash <= 0) return null;
  const row = db.prepare(`SELECT id FROM documents WHERE collection = ? AND path = ?`)
    .get(displayPath.slice(0, slash), displayPath.slice(slash + 1)) as { id: number } | null;
  return row?.id ?? null;
}

const carriedId = (m: ManifestItem): number | null => (typeof m.docId === "number" && m.docId > 0 ? m.docId : null);

function bumpSurfaced(db: Database, path: string, now: string): void {
  db.prepare(
    `INSERT INTO utility_signals (path, surfaced_count, referenced_count, last_surfaced, stamp) VALUES (?, 1, 0, ?, ?)
     ON CONFLICT(path) DO UPDATE SET surfaced_count = surfaced_count + 1, last_surfaced = excluded.last_surfaced, stamp = excluded.stamp`
  ).run(path, now, freshStamp());
}

function bumpReferenced(db: Database, path: string, now: string): void {
  db.prepare(
    `INSERT INTO utility_signals (path, surfaced_count, referenced_count, last_referenced, stamp) VALUES (?, 0, 1, ?, ?)
     ON CONFLICT(path) DO UPDATE SET referenced_count = referenced_count + 1, last_referenced = excluded.last_referenced, stamp = excluded.stamp`
  ).run(path, now, freshStamp());
}

/** access_count + 1 and last_accessed_at on an ACTIVE document; false when it is no longer active (never credited). */
function bumpAccess(db: Database, docId: number, now: string): boolean {
  db.prepare(
    `UPDATE documents SET access_count = access_count + 1, last_accessed_at = ?, counter_stamp = ? WHERE id = ? AND active = 1`
  ).run(now, freshStamp(), docId);
  return lastChanges(db) === 1;
}

function setTerminal(db: Database, usageId: number, state: "attributed" | "unattributable", reason: string | null, now: string): boolean {
  db.prepare(
    `UPDATE feedback_turns SET state = ?, reason = ?, updated_at = ?, revision = revision + 1 WHERE usage_id = ? AND state = 'pending'`
  ).run(state, reason, now, usageId);
  return lastChanges(db) === 1;
}

// ── Membership (the drainer) ────────────────────────────────────────────────────────────────────────────────────

/**
 * General vault, inside the drainer's transaction for a linked alignment row: the manifest, a surfaced count for each
 * document the general vault owns (once — only a newly inserted entry counts; the injection happened, so it counts
 * whatever the document's state is now), and the turn's pending row. Every entry pins its document id in its own vault
 * (carried by the job; a general entry without one is resolved by path). Credit is decided at attribution: an entry
 * whose document is not active then is never credited (T23 #6).
 */
export function writeGeneralMembership(db: Database, usageId: number, manifest: readonly ManifestItem[]): void {
  const now = isoNow();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO feedback_ledger (usage_id, vault, display_path, vault_doc_id, displayed_title, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const m of manifest) {
    const vault = m.vault ?? "";
    const docId = carriedId(m) ?? (vault === "" ? resolveDocId(db, m.displayPath) : null);
    ins.run(usageId, vault, m.displayPath, docId, m.displayedTitle, now);
    if (lastChanges(db) === 1 && vault === "" && docId !== null) bumpSurfaced(db, m.displayPath, now);
  }
  db.prepare(`INSERT OR IGNORE INTO feedback_turns (usage_id, state, attempts, updated_at) VALUES (?, 'pending', 0, ?)`).run(usageId, now);
}

/**
 * Named vault, inside the vault's transaction, for a NEWLY inserted mirror row: its own entries with their ids pinned
 * in this vault, surfaced counts, and a pending row — or `unattributable` when the mirror has no general row.
 */
export function writeMirrorMembership(db: Database, mirrorId: number, items: readonly ManifestItem[], linked: boolean): void {
  const now = isoNow();
  if (!linked) {
    db.prepare(`INSERT OR IGNORE INTO feedback_turns (usage_id, state, reason, attempts, updated_at) VALUES (?, 'unattributable', 'no-source', 0, ?)`)
      .run(mirrorId, now);
    return;
  }
  const ins = db.prepare(
    `INSERT OR IGNORE INTO feedback_ledger (usage_id, vault, display_path, vault_doc_id, displayed_title, created_at) VALUES (?, '', ?, ?, ?, ?)`
  );
  for (const m of items) {
    const docId = carriedId(m) ?? resolveDocId(db, m.displayPath);
    ins.run(mirrorId, m.displayPath, docId, m.displayedTitle, now);
    if (lastChanges(db) === 1 && docId !== null) bumpSurfaced(db, m.displayPath, now);
  }
  db.prepare(`INSERT OR IGNORE INTO feedback_turns (usage_id, state, attempts, updated_at) VALUES (?, 'pending', 0, ?)`).run(mirrorId, now);
}

/** A row whose job carried no manifest (a pre-upgrade or older writer's): never attributed (D6 rev 20). */
export function markLegacyUsageRow(db: Database, usageId: number): void {
  db.prepare(`INSERT OR IGNORE INTO feedback_turns (usage_id, state, reason, attempts, updated_at) VALUES (?, 'unattributable', 'legacy-job', 0, ?)`)
    .run(usageId, isoNow());
}

/** A recall event written after its entry was already referenced is referenced too (any late event writer). */
export function reconcileReferencedEvents(db: Database, usageId: number): void {
  db.prepare(
    `UPDATE recall_events SET was_referenced = 1
     WHERE usage_id = ? AND was_referenced = 0 AND doc_id IN (
       SELECT vault_doc_id FROM feedback_ledger
       WHERE usage_id = ? AND vault = '' AND referenced_at IS NOT NULL AND vault_doc_id IS NOT NULL)`
  ).run(usageId, usageId);
}

// ── Effects ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Apply one row's verified references in this store (inside its transaction, after its state gate). An entry of THIS
 * store's vault (vault '') is marked referenced only when it can be credited — its pinned document is active now — so
 * `referenced_at` always means "credited" and the repair can rebuild from it (T23 #6); another vault's entry is the
 * verdict that vault applies itself. Each entry flips NULL → now once, whichever pass (provisional or final, Stop or
 * worker) gets there first, and only that flip moves counters. Same-turn pairs are recorded once: the newly credited
 * entries with each other and with those an earlier pass of this row credited (T23 #1). A usage relation runs from the
 * lower document id to the higher one. Returns how many entries were newly referenced.
 */
function applyVerified(store: Store, usageId: number, keys: Iterable<string>, now: string): number {
  const db = store.db;
  const entryOf = db.prepare(`SELECT rowid AS rid, vault_doc_id FROM feedback_ledger WHERE usage_id = ? AND vault = ? AND display_path = ?`);
  const isActive = db.prepare(`SELECT 1 FROM documents WHERE id = ? AND active = 1`);
  const flip = db.prepare(
    `UPDATE feedback_ledger SET referenced_at = ? WHERE usage_id = ? AND vault = ? AND display_path = ? AND referenced_at IS NULL`
  );
  const credited: { rid: number; path: string; docId: number }[] = [];
  let newly = 0;
  for (const k of keys) {
    const sep = k.indexOf(KEY_SEP);
    const vault = k.slice(0, sep);
    const path = k.slice(sep + 1);
    const e = entryOf.get(usageId, vault, path) as { rid: number; vault_doc_id: number | null } | null;
    if (!e) continue;
    if (vault === "" && (e.vault_doc_id === null || !isActive.get(e.vault_doc_id))) continue;   // never credited
    flip.run(now, usageId, vault, path);
    if (lastChanges(db) !== 1) continue;
    newly++;
    if (vault !== "") continue;
    bumpAccess(db, e.vault_doc_id!, now);
    bumpReferenced(db, path, now);
    db.prepare(`UPDATE recall_events SET was_referenced = 1 WHERE usage_id = ? AND doc_id = ?`).run(usageId, e.vault_doc_id);
    credited.push({ rid: e.rid, path, docId: e.vault_doc_id! });
  }
  if (credited.length > 0) {
    const fresh = new Set(credited.map(c => c.rid));
    const earlier = (db.prepare(
      `SELECT rowid AS rid, display_path AS path, vault_doc_id AS docId FROM feedback_ledger
       WHERE usage_id = ? AND vault = '' AND referenced_at IS NOT NULL AND vault_doc_id IS NOT NULL`
    ).all(usageId) as { rid: number; path: string; docId: number }[]).filter(x => !fresh.has(x.rid));
    const all = [...earlier, ...credited].sort((x, y) => x.rid - y.rid);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const x = all[i]!;
        const y = all[j]!;
        if (!fresh.has(x.rid) && !fresh.has(y.rid)) continue;   // an earlier pass recorded this pair
        store.recordCoActivation([x.path, y.path]);
        store.insertRelation(Math.min(x.docId, y.docId), Math.max(x.docId, y.docId), "usage");
      }
    }
  }
  if (newly > 0) store.markUsageReferenced(usageId);
  return newly;
}

// ── Attribution (Stops and the worker) ──────────────────────────────────────────────────────────────────────────

export type AttributionRun = {
  attributed: number; provisional: number; unattributable: number; pending: number; references: number;
  /** Hermes: this pass's scan or verdicts lost a compare-and-set to another pass — the next one must run (T35 #3). */
  retry?: boolean;
};

type PendingRow = { id: number; prompt_sha: string | null; timestamp: string | null };

/** A row that still owes a verdict: pending, or attributed provisionally (the worker, on a quiet transcript). */
const OPEN_ROW = FEEDBACK_OPEN_ROW_SQL;

/** A human entry as pairing sees it, with the offsets of its line (compact: pairing needs no other line). */
type HumanEntry = PairingEntry & { start: number; end: number };

/**
 * Attribute the open general-vault rows of ONE transcript (session id + transcript key). First registers the
 * transcript and binds this session key's keyless rows to it (D1 rev 14). A row's verdict is FINAL once its turn is
 * over: a later human entry follows it, or `atStop` (a Stop, `agent_end`, an ended session) says the trailing turn is.
 * Claude Code's stop marker after the turn (a `stop_hook_summary` / `turn_duration` entry) proves the same as a Stop:
 * the turn ended, even when the Stop hook itself died (T25 #1). `provisional` (the worker, on a transcript quiet for
 * 10 minutes) credits a trailing turn's references written so far and leaves the row open (`attributed`/
 * `provisional`), so a later citation in the same turn is still credited by the pass that finds the turn over (T23 #1)
 * — and only when the pairing's time window is CLOSED, which no later entry can change (T24 #2, T25 #1): OpenClaw's
 * trailing turn qualifies, Claude Code's (open until the next turn) waits for proof of its end. An entry is credited
 * once, whichever pass flips it. On Hermes a row is not paired (`attributeHermes`): it is credited in the turn whose
 * user line carries its id, closed `not-delivered` when the plugin recorded it dropped or unresolved, or — still open
 * when its session ended — closed so then.
 *
 * The read is two bounded streams (T24 #5): the first runs to the end keeping only the human entries (each with the
 * time of the entry before it — all pairing needs) and the latest assistant time — on Hermes, the durable scan instead,
 * which reads only what the transcript gained since the last pass; the second runs through each credited turn and keeps
 * only the manifest keys its assistant text verifies. Memory follows the number of turns, never their
 * bytes; `deadline` bounds the work, and a stream it cuts short decides only the rows whose turns it saw end.
 */
export function attributeTranscript(
  store: Store,
  args: {
    sessionId: string; transcriptPath: string; host?: string; sessionKey?: string; atStop: boolean; provisional?: boolean;
    limit?: number; readMaxBytes?: number; deadline?: MonoDeadline;
    /** Test seams: before the Hermes scan commits, and before the verdicts are applied (another pass acting meanwhile). */
    beforeScanCommit?: () => void;
    beforeVerdict?: () => void;
  },
): AttributionRun {
  const run: AttributionRun = { attributed: 0, provisional: 0, unattributable: 0, pending: 0, references: 0 };
  const db = store.db;
  const path = locatorPath(args.transcriptPath);
  if (!stopPipelineReady(db) || !path || !existsSync(path)) return run;
  const host = stopHostOf(args.host);
  const key = transcriptKey(path);
  registerTranscript(db, args.sessionId, path, host, args.sessionKey ?? null);
  if (args.sessionKey) bindKeylessUsageRows(db, args.sessionId, args.sessionKey, key);

  // Hermes: the durable scan runs first (when a row is open), and the rows it has read about come first in the page, so
  // rows still waiting for a record never keep a decidable one out (T33 #3).
  const hermes = host === "hermes";
  let scan: HermesScan | null = null;
  if (hermes) {
    const open = db.prepare(
      `SELECT 1 FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id
       WHERE ${OPEN_ROW} AND u.session_id = ? AND u.transcript_key = ? LIMIT 1`
    ).get(args.sessionId, key);
    if (!open) return run;
    scan = scanHermesTranscript(db, args.sessionId, key, path, { maxBytes: args.readMaxBytes, deadline: args.deadline, beforeCommit: args.beforeScanCommit });
    if (!scan.committed && scan.file) run.retry = true;
  }
  const marked = `EXISTS (SELECT 1 FROM hermes_marks m WHERE m.session_id = u.session_id AND m.transcript_key = u.transcript_key
     AND m.usage_id = u.id) DESC, `;
  const rows = db.prepare(
    `SELECT u.id, u.prompt_sha, u.timestamp FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id
     WHERE ${OPEN_ROW} AND u.session_id = ? AND u.transcript_key = ? ORDER BY ${hermes ? marked : ""}u.id LIMIT ?`
  ).all(args.sessionId, key, args.limit ?? 50) as PendingRow[];
  if (rows.length === 0) return run;

  const noIdentity: number[] = [];
  const candidates: { id: number; promptSha: string; ts: number }[] = [];
  for (const r of rows) {
    const ts = parseEntryTime(r.timestamp);
    if (!r.prompt_sha || ts === null) noIdentity.push(r.id);
    else candidates.push({ id: r.id, promptSha: r.prompt_sha, ts });
  }

  const toAttribute: { id: number; keys: Set<string>; final: boolean }[] = [];
  const toConclude: { id: number; reason: string }[] = [];
  // Hermes verdicts come from the scan's marks, so they apply only while those marks stand: the scan state's generation
  // and the file are checked again inside the verdict transaction (T34 #3).
  const markedAt = scan ? hermesGeneration(db, args.sessionId, key) : null;
  if (candidates.length > 0 && scan) {
    attributeHermes(db, args, path, key, scan, candidates, toAttribute, toConclude, run);
  } else if (candidates.length > 0) {
    const minTs = Math.min(...candidates.map(c => c.ts));
    // Stream 1: the human entries (and, before each, the entry that precedes it) and the latest assistant time.
    const entries: HumanEntry[] = [];
    const endMarked = new Set<number>();   // human entries whose turn a stop marker closed
    let prev: { ts: number | null } | null = null;
    let lastAssistantTs = -Infinity;
    let lastMarkerTs = -Infinity;
    let answered = false;   // an assistant line since the last human entry: a stop marker closes only an answered turn
    const s1 = streamLines(path, humanLineAtOrBefore(path, minTs), l => {
      if (l.kind === "human") {
        if (prev) entries.push({ kind: "prev", text: "", ts: prev.ts, start: -1, end: -1 });
        entries.push({ kind: "human", text: l.text, ts: l.ts, start: l.start, end: l.end });
        answered = false;
      } else if (l.kind === "assistant") {
        answered = true;
        if (l.ts !== null && l.ts > lastAssistantTs) lastAssistantTs = l.ts;
      } else if (l.stopMarker && answered) {
        if (entries.length > 0) endMarked.add(entries.length - 1);
        if (l.ts !== null && l.ts > lastMarkerTs) lastMarkerTs = l.ts;
      }
      prev = { ts: l.ts };
    }, { maxBytes: args.readMaxBytes, deadline: args.deadline });
    const eof = s1.eof;
    const pairs = pairTurns(host, entries, candidates);
    const humanAt = entries.map((e, i) => (e.kind === "human" ? i : -1)).filter(i => i >= 0);
    const nextHuman = (i: number) => humanAt.find(h => h > i) ?? -1;
    const turnOver = (i: number) => nextHuman(i) >= 0 || endMarked.has(i) || (args.atStop && eof);
    for (const c of candidates) {
      const paired = pairs.get(c.id);
      if (paired !== undefined) {
        const over = turnOver(paired);
        // Provisional credit only where no later entry can change the pairing: a closed pairing window.
        if (!over && !(args.provisional && eof && pairWindowClosed(host, entries, paired))) { run.pending++; continue; }
        const nh = nextHuman(paired);
        const r = turnReferences(db, path, c.id, entries[paired]!.end, nh >= 0 ? entries[nh]!.start : null, args);
        if (r.expired) { run.pending++; continue; }
        toAttribute.push({ id: c.id, keys: r.keys, final: over });
        continue;
      }
      // Unpaired: concluded only when the transcript proves the row's turn is over and readable.
      const concluded = host === "openclaw"
        ? entries.some((e, i) => e.kind === "human" && e.ts !== null && e.ts >= c.ts && turnOver(i))
        : entries.some(e => e.kind === "human" && e.ts !== null && e.ts > c.ts)
          || ((args.atStop && eof) || lastMarkerTs > c.ts) && lastAssistantTs > c.ts;
      if (concluded) toConclude.push({ id: c.id, reason: "no-unique-pair" });
      else run.pending++;
    }
  }

  const now = isoNow();
  const verdict = db.prepare(
    `UPDATE feedback_turns SET state = 'attributed', reason = ?, updated_at = ?, revision = revision + 1
     WHERE usage_id = ? AND ${OPEN_ROW.replaceAll("f.", "")}`
  );
  args.beforeVerdict?.();
  db.transaction(() => {
    if (scan && (hermesGeneration(db, args.sessionId, key) !== markedAt || !stillHermesFile(scan, path))) {
      run.pending += toAttribute.length + toConclude.length;   // the marks moved: the next pass decides from the new ones
      toAttribute.length = 0;
      toConclude.length = 0;
      run.retry = true;
    }
    for (const a of toAttribute) {
      verdict.run(a.final ? null : "provisional", now, a.id);
      if (lastChanges(db) !== 1) continue;   // another processor made it final first
      if (a.final) run.attributed++; else run.provisional++;
      run.references += applyVerified(store, a.id, a.keys, now);
    }
    for (const x of toConclude) if (setTerminal(db, x.id, "unattributable", x.reason, now)) run.unattributable++;
    if (hermes) dropHermesMarks(db, args.sessionId, key, [...toAttribute.filter(a => a.final).map(a => a.id), ...toConclude.map(x => x.id)]);
    for (const id of noIdentity) if (setTerminal(db, id, "unattributable", "no-identity", now)) run.unattributable++;
  }).immediate();
  return run;
}

/**
 * On Hermes a row is not paired: the durable scan (stop-hermes-scan.ts) reads what the transcript gained since the last
 * pass, and a row is credited in the turn whose user line carries its id — over once the next user line is read, or at
 * a Stop at the end of the transcript; the worker credits a trailing recipient provisionally, since no later line can
 * change which turn it is. A row the plugin closed (dropped / unresolved) is `not-delivered`; so is a row still open
 * when its session has ended and the read is complete. No clock or line position decides anything (T29-T32).
 */
function attributeHermes(
  db: Database,
  args: { sessionId: string; atStop: boolean; provisional?: boolean; readMaxBytes?: number; deadline?: MonoDeadline },
  path: string, key: string, scan: HermesScan, candidates: { id: number }[],
  toAttribute: { id: number; keys: Set<string>; final: boolean }[], toConclude: { id: number; reason: string }[],
  run: AttributionRun,
): void {
  const eof = scan.eof;
  const ended = !!(db.prepare(
    `SELECT ended_at FROM session_transcripts WHERE session_id = ? AND transcript_key = ?`
  ).get(args.sessionId, key) as { ended_at: string | null } | null)?.ended_at;
  for (const c of candidates) {
    const m = hermesMark(db, args.sessionId, key, c.id);
    if (m.delivered) {
      const over = m.delivered.next !== null || (args.atStop && eof);
      if (!over && !(args.provisional && eof)) { run.pending++; continue; }
      const r = turnReferences(db, path, c.id, m.delivered.end, m.delivered.next, args);
      // The offsets are the scanned file's: a transcript replaced meanwhile decides nothing this pass.
      if (r.expired || !stillHermesFile(scan, path)) { run.pending++; continue; }
      toAttribute.push({ id: c.id, keys: r.keys, final: over });
    } else if (m.settled || (ended && eof)) {
      toConclude.push({ id: c.id, reason: "not-delivered" });
    } else {
      run.pending++;
    }
  }
}

/**
 * Stream 2: a credited turn's assistant text — from `from` (the end of its user line) to `to` (the next user line) or
 * the end — through the reference test against the row's manifest. Each assistant line is tested together with the
 * tail of the joined text before it — as long as the longest identifier and cut to start at a token — so a title or
 * path split across two messages still matches as in the joined turn text D6 tests (T25 #2), and a token the cut would
 * truncate is never tested.
 */
function turnReferences(
  db: Database, path: string, usageId: number, from: number, to: number | null,
  args: { readMaxBytes?: number; deadline?: MonoDeadline },
): { keys: Set<string>; expired: boolean } {
  const manifest = (db.prepare(
    `SELECT vault, display_path, displayed_title FROM feedback_ledger WHERE usage_id = ?`
  ).all(usageId) as { vault: string; display_path: string; displayed_title: string | null }[])
    .map((e): ReferenceEntry => ({ key: entryKey(e.vault, e.display_path), vault: e.vault, displayPath: e.display_path, displayedTitle: e.displayed_title }));
  const keys = new Set<string>();
  const overlap = manifest.reduce((m, e) => Math.max(m, e.displayPath.length, e.displayedTitle?.length ?? 0), 0) + 64;
  let carry = "";
  const s2 = streamLines(path, from, l => {
    if (l.kind !== "assistant" || !l.text) return;
    for (const k of verifiedReferences(carry ? `${carry}\n${l.text}` : l.text, manifest)) keys.add(k);
    const joined = carry ? `${carry}\n${l.text}` : l.text;
    if (joined.length <= overlap) { carry = joined; return; }
    const tail = joined.slice(-overlap);
    const cut = tail.search(/\s/);
    carry = cut >= 0 ? tail.slice(cut + 1) : "";
  }, { maxBytes: args.readMaxBytes, deadline: args.deadline, ...(to !== null ? { to } : {}) });
  return { keys, expired: s2.expired };
}

/** Where each vault's mirror scan resumes (in-process), so blocked rows never keep a later due one out (T23 #7). */
const mirrorScanFrom = new WeakMap<object, number>();
const MIRROR_SCAN_MAX = 2_000;

/**
 * Whether an open mirror can take its general verdict now: its source is gone (it closes unattributable), or the
 * general row has a verdict this mirror has not taken. Waiting: no general verdict yet, or — for a mirror that already
 * took one — no newer revision of it; the revision is the general row's durable, monotonic verdict counter, never a
 * clock (T25 #6). `applyMirrorSlices` acts on it and the `--run` report counts it (v0.41.4, codex T8-3).
 */
export function mirrorReady(m: { source_usage_id: number | null; m_src: number | null }, g: { state: string; revision: number } | null): boolean {
  if (m.source_usage_id === null) return true;
  return g !== null && g.state !== "pending" && !(m.m_src !== null && m.m_src >= g.revision);
}

/** The open mirrors in a named vault that `applyMirrorSlices` would advance now (the `--run` report; codex T8-3). */
export function countDueMirrors(generalDb: Database, vaultDb: Database): number {
  if (!stopPipelineReady(vaultDb) || !stopPipelineReady(generalDb)) return 0;
  const rows = vaultDb.prepare(
    `SELECT u.source_usage_id, f.source_revision AS m_src FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id WHERE ${OPEN_ROW}`
  ).all() as { source_usage_id: number | null; m_src: number | null }[];
  const generalState = generalDb.prepare(`SELECT state, revision FROM feedback_turns WHERE usage_id = ?`);
  let n = 0;
  for (const r of rows) {
    const g = r.source_usage_id === null ? null : generalState.get(r.source_usage_id) as { state: string; revision: number } | null;
    if (mirrorReady(r, g)) n++;
  }
  return n;
}

/**
 * A named vault applies its slice of the general verdicts: each open mirror (pending, or provisional) whose general row
 * is attributed gets that row's verdicts for this vault's entries, in this vault's own transaction, and takes the
 * general row's finality — a provisional general verdict may still grow, so its mirror stays open and the next pass
 * after the general row moved applies what is new (each entry flips once); an unattributable general row closes it.
 * The scan pages past mirrors still waiting, resuming where the last one stopped (T23 #7). Returns the mirrors advanced.
 */
export function applyMirrorSlices(general: Store, vault: Store, vaultName: string, opts?: { sessionId?: string; limit?: number }): number {
  if (!stopPipelineReady(vault.db) || !stopPipelineReady(general.db)) return 0;
  const limit = opts?.limit ?? 50;
  const page = vault.db.prepare(
    `SELECT u.id, u.source_usage_id, f.reason AS m_reason, f.source_revision AS m_src FROM feedback_turns f JOIN context_usage u ON u.id = f.usage_id
     WHERE ${OPEN_ROW} AND u.id > ?${opts?.sessionId ? " AND u.session_id = ?" : ""} ORDER BY u.id LIMIT 200`
  );
  const generalState = general.db.prepare(`SELECT state, reason, revision FROM feedback_turns WHERE usage_id = ?`);
  const mirrorVerdict = vault.db.prepare(
    `UPDATE feedback_turns SET state = ?, reason = ?, updated_at = ?, source_revision = ?, revision = revision + 1
     WHERE usage_id = ? AND ${OPEN_ROW.replaceAll("f.", "")}`
  );
  const resumeKey = opts?.sessionId ? null : vault.db;
  const startAt = resumeKey ? mirrorScanFrom.get(resumeKey) ?? 0 : 0;
  // Two legs: from the resume position to the end, then from the start up to it.
  const legs: [number, number][] = startAt > 0 ? [[startAt, Number.MAX_SAFE_INTEGER], [0, startAt]] : [[0, Number.MAX_SAFE_INTEGER]];
  let completed = 0;
  let scanned = 0;
  let last = startAt;
  let exhausted = true;
  scan: for (const [lo, hi] of legs) {
    let after = lo;
    for (;;) {
      const rows = page.all(...[after, ...(opts?.sessionId ? [opts.sessionId] : [])]) as { id: number; source_usage_id: number | null; m_reason: string | null; m_src: number | null }[];
      if (rows.length === 0) break;
      for (const r of rows) {
        if (r.id > hi) continue scan;
        after = r.id;
        last = r.id;
        scanned++;
        const now = isoNow();
        if (r.source_usage_id === null) {
          if (setTerminal(vault.db, r.id, "unattributable", "no-source", now)) completed++;
        } else {
          const g = generalState.get(r.source_usage_id) as { state: string; reason: string | null; revision: number } | null;
          if (g !== null && mirrorReady(r, g)) {
            const referenced = g.state === "attributed"
              ? (general.db.prepare(
                  `SELECT display_path FROM feedback_ledger WHERE usage_id = ? AND vault = ? AND referenced_at IS NOT NULL`
                ).all(r.source_usage_id, vaultName) as { display_path: string }[]).map(e => entryKey("", e.display_path))
              : [];
            vault.db.transaction(() => {
              const state = g.state === "attributed" ? "attributed" : "unattributable";
              const reason = state === "attributed" ? g.reason : "source-unattributable";
              mirrorVerdict.run(state, reason, now, g.revision, r.id);
              if (lastChanges(vault.db) !== 1) return;
              completed++;
              if (state === "attributed") applyVerified(vault, r.id, referenced, now);
            }).immediate();
          }
        }
        if (completed >= limit || scanned >= MIRROR_SCAN_MAX) { exhausted = false; break scan; }
      }
    }
  }
  if (resumeKey) mirrorScanFrom.set(resumeKey, exhausted ? 0 : last);
  return completed;
}
