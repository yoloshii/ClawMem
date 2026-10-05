/**
 * 62.1 D2-D4: decision-extractor over the transcript DELTA — each range read once, committed once.
 *
 * From the hook's cursor (D2), complete turns are packed in order into batches that fit the observer's input bounds
 * (at least one turn per batch). Each batch is one Phase A → Phase B:
 *  - Phase A (no memory writes): admission (the batch must hold assistant text of 40+ characters or a tool action),
 *    the observer with a CONTEXT section (the two turns before the batch and this session's recorded observation
 *    titles), the regex decisions and antipatterns.
 *  - Phase B (one IMMEDIATE transaction): the cursor must still be where Phase A read it — else the work is
 *    discarded (another writer did it). `ok`/`empty` write the batch's effects (observation documents, triples, items,
 *    the session documents' renders) and advance the cursor past the batch; `retryable` QUARANTINES the range in
 *    `stop_retries` (D3) and advances the cursor, so later turns progress and nothing is dropped.
 * The handler loops batches while the Stop budget allows; unprocessed turns wait for the next Stop.
 */

import { closeSync, existsSync, openSync, readSync } from "fs";
import { createHash, randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { Store } from "./store.ts";
import { cutUnits, opensTurn, type TranscriptMessage } from "./hooks.ts";
import { isoNow } from "./clock.ts";
import {
  monoNow, deadlineAfter, deadlineBefore, remainingForTimeout, shorterThan, duration,
  type MonoDeadline,
} from "./clock.ts";
import { lastChanges, stopPipelineReady, nextRetryAt, RETRY_BACKOFF_MS } from "./stop-schema.ts";
import { judgePhaseA, judgePhaseB, type JudgePrepared } from "./stop-judge.ts";
import { insertCausalMarker } from "./stop-causal.ts";
import { insertJudgeRunBestEffort } from "./judge-audit.ts";
import { stopHostOf, transcriptKey } from "./stop-pairing.ts";
import { locatorPath, registerTranscript } from "./stop-identity.ts";
import {
  readLines, segmentTurns, rangeSha, resolveCursorStart, readStopCursor, casAdvanceCursor, streamLines,
  STOP_READ_MAX_BYTES, type StopCursor, type TranscriptLine, type FileIdentity, type StreamEnd,
} from "./stop-cursor.ts";
import {
  observerRenderChars, OBSERVER_MAX_MESSAGES, OBSERVER_MAX_RENDER_CHARS, OBSERVER_BATCH_RESERVED_CHARS,
  renderObserverLines, observerLinesSha, observerContract, extractObservationsWindowed, takeObserverCallSamples, MAX_OBSERVER_CALLS,
  takeObserverStats, validWindowBound, OBSERVER_STATS_FIELDS,
  OBSERVER_CALL_SAMPLES,
  type Observation, type WindowProgress,
} from "./observer.ts";
import {
  getDefaultLlamaCpp, budgetLayerOf, fingerprintVerdict, type LlmBackendId, type LlmCapacity, type OverheadStore,
} from "./llm.ts";
import {
  checkpointKey, readCheckpoint, checkpointMatches, liveCheckpoint, createCheckpoint, swapCheckpoint, finishCheckpoint,
  type ObserverCheckpoint,
} from "./stop-checkpoint.ts";
import { insertStopItem, itemFingerprint, reconcileSessionDocs } from "./stop-session-docs.ts";
import { PERSIST_RESERVE_MS, CAUSAL_MIN_BUDGET_MS } from "./causal-writer.ts";
import type { ObservationWithDoc } from "./amem.ts";
import { RETRY_DUE_SQL } from "./stop-due.ts";
import {
  persistObservationDoc, insertObservationTriples, extractDecisions, extractAntipatterns, formatObservation,
} from "./hooks/decision-extractor.ts";

export const DECISION_HOOK = "decision-extractor";
const ADMISSION_TEXT_CHARS = 40;
const CONTEXT_PRIOR_TURNS = 2;
const RECORDED_TITLES_MAX = 30;
const DEFAULT_RUN_BUDGET_MS = 30_000;
/** The CONTEXT before a batch is read from at most this far back (it is advisory: "already recorded — do not extract"). */
const CONTEXT_MAX_BYTES = 4 * 1024 * 1024;
/** Characters kept per accumulated message (the observer renders at most 1,000 of one). */
const ACCUMULATED_MESSAGE_CHARS = 2_000;
/**
 * A safety bound on the regex items one streamed stretch keeps (every distinct one below it is kept — the batch path
 * keeps them all too); reaching it is logged, never silent (T25 #3).
 */
const ACCUMULATED_ITEMS_MAX = 2_000;
/** The tools whose calls name the files a turn changed (handoff digests). */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const ACCUMULATED_FILES_MAX = 50;
export { RETRY_BACKOFF_MS };

/**
 * A transcript's lines as the observer's messages: human → user, assistant and tool results as rendered. v0.41.2: each
 * message carries its turn (a human entry after the first message starts the next) and `opening` on the human entry.
 * 72.4: a notice is a user-role message carrying its label (never a peer's body); an opening notice starts a turn.
 */
export function toObserverMessages(lines: readonly TranscriptLine[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let turn = 0;
  for (const l of lines) {
    if (l.kind === "human" || l.kind === "notice") {
      const opening = opensTurn(l);
      if (opening && out.length > 0) turn++;
      out.push({ role: "user", content: l.text, turn, opening });
    }
    else if (l.kind === "assistant") out.push({ role: "assistant", content: l.rendered, turn });
    else if (l.kind === "tool_result") out.push({ role: "user", content: l.rendered, turn });
  }
  return out;
}

/** Admission (D4): the batch holds an assistant message with 40+ characters of text, or a tool action. */
export function admitsBatch(lines: readonly TranscriptLine[]): boolean {
  return lines.some(l => l.kind === "assistant" && (l.text.trim().length >= ADMISSION_TEXT_CHARS || (l.toolUses?.length ?? 0) > 0));
}

/**
 * T24 #1/#5: what the Stop consumers need from lines streamed past one read's bound, kept bounded whatever the length
 * streamed: the first human entry, the first opening entry (72.4: a human line or an opening notice), the last
 * OBSERVER_MAX_MESSAGES observer messages (each capped — the observer
 * renders at most 1,000 characters of one, and only its last 100 messages), admission, the last assistant text, the
 * files the edit tools touched, and the regex decisions/antipatterns (each found in its full message, with the
 * preceding user message as context, as the batch extractors do).
 */
export type LineAccumulator = {
  start: number;
  end: number;
  lines: number;
  /** v0.41.2: the turn the next message belongs to (a human entry after the first message starts the next). */
  turn: number;
  /** The stretch's first human line: the user's typed request. */
  humanText: string | null;
  humanTs: number | null;
  humanStart: number | null;
  /** The stretch's first opening line (72.4): its text — the typed request, or a notice's label — start and time. */
  openText: string | null;
  openStart: number | null;
  openTs: number | null;
  /** That line's observer message as kept (its own turn), and its ordinal among the stretch's messages (CODE T1-3). */
  openMessage: TranscriptMessage | null;
  openOrdinal: number | null;
  firstTs: number | null;
  messages: TranscriptMessage[];
  messageCount: number;
  admits: boolean;
  lastAssistantText: string;
  files: string[];
  decisions: { text: string; context: string }[];
  antipatterns: { text: string; context: string }[];
  lastLineSha: string | null;
  /** A stop marker was read after the stretch's last assistant line (Claude Code: the turn ended, T25 #1). */
  stopMarked: boolean;
  /** The stretch holds an assistant line. */
  answered: boolean;
  /** The stretch holds a human line, assistant text or a tool call: a turn worth a handoff digest (72.4 F4). */
  substantive: boolean;
  /** Keys of the kept regex items (dedup across the stream), and whether the safety bound was reached. */
  itemKeys: Set<string>;
  itemsCapped: boolean;
};

export function newAccumulator(start: number): LineAccumulator {
  return {
    start, end: start, lines: 0, turn: 0, humanText: null, humanTs: null, humanStart: null, openText: null, openStart: null,
    openTs: null, openMessage: null, openOrdinal: null, firstTs: null, messages: [], messageCount: 0, admits: false, lastAssistantText: "", files: [], decisions: [],
    antipatterns: [], lastLineSha: null, stopMarked: false, answered: false, substantive: false, itemKeys: new Set(), itemsCapped: false,
  };
}

function pushUnique(acc: LineAccumulator, kind: "d" | "a", items: { text: string; context: string }[]): void {
  const list = kind === "d" ? acc.decisions : acc.antipatterns;
  for (const it of items) {
    const key = `${kind}:${it.text.slice(0, 80).toLowerCase()}`;
    if (acc.itemKeys.has(key)) continue;
    if (list.length >= ACCUMULATED_ITEMS_MAX) {
      if (!acc.itemsCapped) console.warn(`[decision-extractor] a streamed stretch at ${acc.start} holds over ${ACCUMULATED_ITEMS_MAX} regex items of one kind — later ones not kept`);
      acc.itemsCapped = true;
      continue;
    }
    acc.itemKeys.add(key);
    list.push(it);
  }
}

export function accumulateLine(acc: LineAccumulator, l: TranscriptLine): void {
  if (acc.lines === 0) acc.start = l.start;
  if (l.kind === "human" && acc.humanStart === null) { acc.humanText = l.text; acc.humanTs = l.ts; acc.humanStart = l.start; }
  if (opensTurn(l) && acc.openStart === null) { acc.openText = l.text; acc.openTs = l.ts; acc.openStart = l.start; }
  if (l.kind === "human" || (l.kind === "assistant" && (l.text.trim().length > 0 || (l.toolUses?.length ?? 0) > 0))) acc.substantive = true;
  if (acc.firstTs === null && l.ts !== null) acc.firstTs = l.ts;
  for (const raw of toObserverMessages([l])) {
    if (raw.opening && acc.messageCount > 0) acc.turn++;
    const m: TranscriptMessage = { ...raw, turn: acc.turn };
    if (m.role === "assistant") {
      const recent = [...acc.messages.slice(-3), m];
      pushUnique(acc, "d", extractDecisions(recent).map(d => ({ text: d.text, context: d.context })));
      pushUnique(acc, "a", extractAntipatterns([m]));
    }
    const kept = m.content.length > ACCUMULATED_MESSAGE_CHARS ? { ...m, content: cutUnits(m.content, ACCUMULATED_MESSAGE_CHARS) } : m;
    if (m.opening && acc.openOrdinal === null) { acc.openMessage = kept; acc.openOrdinal = acc.messageCount; }
    acc.messages.push(kept);
    if (acc.messages.length > OBSERVER_MAX_MESSAGES) acc.messages.shift();
    acc.messageCount++;
  }
  if (l.stopMarker && acc.answered) acc.stopMarked = true;   // closes only an answered stretch (T26 #1)
  if (l.kind === "assistant") {
    acc.answered = true;
    acc.stopMarked = false;   // the turn went on past an earlier marker (a Stop hook that blocked)
    if (l.text.trim().length >= ADMISSION_TEXT_CHARS || (l.toolUses?.length ?? 0) > 0) acc.admits = true;
    if (l.text.trim().length > 0) acc.lastAssistantText = l.text;
    for (const u of l.toolUses ?? []) {
      if (!EDIT_TOOLS.has(u.name) || acc.files.length >= ACCUMULATED_FILES_MAX) continue;
      const f = u.input.file_path ?? u.input.notebook_path;
      if (typeof f === "string" && f.length > 0 && f.length < 500 && !acc.files.includes(f)) acc.files.push(f);
    }
  }
  acc.end = l.end;
  acc.lastLineSha = l.sha;
  acc.lines++;
}

/**
 * The observer's messages of an accumulated stretch: its opening line first — the typed request, or a notice's label
 * (72.4 F3) — even when the kept tail dropped it. Restored only when it was dropped, with its own turn (CODE T1-3).
 */
export function accumulatedMessages(acc: LineAccumulator): TranscriptMessage[] {
  if (acc.openMessage !== null && acc.openOrdinal !== null && acc.openOrdinal < accumulatorDropped(acc)) {
    return [acc.openMessage, ...acc.messages.slice(1)];
  }
  return acc.messages;
}

/** v0.41.2: how many messages the accumulator's 100-message tail dropped upstream (T24's bound — reported, unchanged). */
export function accumulatorDropped(acc: LineAccumulator): number {
  return Math.max(0, acc.messageCount - acc.messages.length);
}

/**
 * Stream lines from `from` into an accumulator — through `to`, or (stopAtNextOpening) until the next opening entry — a
 * human line or an opening notice (72.4) — after the first line: one turn, however large, read once in bounded reads
 * and processed as ONE turn (T24 #1). `reachedOpening`: the turn's end was seen.
 */
export function accumulateLines(
  path: string,
  from: number,
  opts: { stopAtNextOpening: boolean; to?: number; maxBytes?: number; deadline?: MonoDeadline; releaseTrailingCommand?: boolean },
): { acc: LineAccumulator; stream: StreamEnd; reachedOpening: boolean } {
  const acc = newAccumulator(from);
  let reachedOpening = false;
  const stream = streamLines(path, from, l => {
    if (opts.stopAtNextOpening && acc.lines > 0 && opensTurn(l)) { reachedOpening = true; return false; }
    accumulateLine(acc, l);
  }, { maxBytes: opts.maxBytes, to: opts.to, deadline: opts.deadline, releaseTrailingCommand: opts.releaseTrailingCommand });
  return { acc, stream, reachedOpening };
}

/** Pack complete turns, in order, into batches within the observer's bounds; at least one turn per batch. */
export function packTurnBatches<T extends { messages: TranscriptMessage[] }>(
  turns: readonly T[],
  bounds: { maxMessages: number; maxChars: number; reservedChars?: number },
): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  const fits = (b: T[]) => {
    const msgs = b.flatMap(t => t.messages);
    return msgs.length <= bounds.maxMessages && observerRenderChars(msgs) + (bounds.reservedChars ?? 0) <= bounds.maxChars;
  };
  for (const t of turns) {
    if (cur.length > 0 && !fits([...cur, t])) { batches.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

type Turn = { lines: TranscriptLine[]; messages: TranscriptMessage[]; start: number; end: number };

/**
 * The lines of the last `n` turns that end at `offset` (the CONTEXT before the first batch), read from at most
 * CONTEXT_MAX_BYTES back: past a huge earlier turn, its tail is the context (it is advisory).
 */
function lastTurnsBefore(path: string, offset: number, n: number): TranscriptLine[] {
  if (offset <= 0) return [];
  const from = offset <= CONTEXT_MAX_BYTES ? 0 : alignToLineStart(path, offset - CONTEXT_MAX_BYTES);
  if (from >= offset) return [];
  const read = readLines(path, from, { to: offset, maxBytes: offset - from, releaseTrailingCommand: true });
  const openings = read.lines.map((l, i) => (opensTurn(l) ? i : -1)).filter(i => i >= 0);
  return read.lines.slice(openings.length >= n ? openings[openings.length - n]! : 0);
}

/** The first line start at or after `pos` (the byte after the first '\n' at or after pos - 1). */
function alignToLineStart(path: string, pos: number): number {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (let p = pos - 1; ; p += buf.length) {
      const n = readSync(fd, buf, 0, buf.length, p);
      if (n <= 0) return p;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) return p + nl + 1;
    }
  } finally {
    closeSync(fd);
  }
}

function recordedTitles(store: Store, sessionId: string, sourceTime: string | null): string[] {
  const sid8 = sessionId.slice(0, 8);
  const rows = store.db.prepare(
    `SELECT title FROM documents WHERE collection = '_clawmem' AND path LIKE 'observations/%' AND path LIKE ? AND active = 1
       ${sourceTime ? "AND created_at <= ?" : ""} ORDER BY created_at DESC LIMIT ?`
  ).all(...[`%-${sid8}-%`, ...(sourceTime ? [sourceTime] : []), RECORDED_TITLES_MAX]) as { title: string }[];
  return rows.map(r => r.title).reverse();
}

export type RangeRef = {
  anchorEpoch: number;
  from: number;
  to: number;
  sha: string;
  key: string;
  sourceTime: string | null;
};

function rangeRefOf(path: string, epoch: number, lines: readonly TranscriptLine[]): RangeRef {
  const from = lines[0]!.start;
  const to = lines.at(-1)!.end;
  const sha = rangeSha(path, from, to)!;
  const first = lines.find(l => opensTurn(l) && l.ts !== null) ?? lines.find(l => l.ts !== null);
  return {
    anchorEpoch: epoch, from, to, sha, key: `${epoch}-${from}-${to}-${sha.slice(0, 16)}`,
    sourceTime: first?.ts != null ? new Date(first.ts).toISOString() : null,
  };
}

export type RegexItems = { decisions: { text: string; context: string }[]; antipatterns: { text: string; context: string }[] };

function regexItemsOf(messages: TranscriptMessage[]): RegexItems {
  return {
    decisions: extractDecisions(messages).map(d => ({ text: d.text, context: d.context })),
    antipatterns: extractAntipatterns(messages),
  };
}

/** The Phase B effects of an `ok`/`empty` batch (inside the transaction). Returns the persisted observations. */
function writeBatchEffects(
  store: Store,
  sessionId: string,
  key: string,
  range: RangeRef,
  observations: Observation[],
  regex: RegexItems,
  now: string,
  replay: boolean,
): ObservationWithDoc[] {
  const db = store.db;
  const dateStr = now.slice(0, 10);
  const persisted: ObservationWithDoc[] = [];
  for (const obs of observations) {
    const wit = persistObservationDoc(store, obs, sessionId, dateStr, now);
    if (!wit) continue;
    if (replay && range.sourceTime) store.updateDocumentMeta(wit.docId, { authored_at: range.sourceTime });   // D3: source time
    persisted.push(wit);
  }
  insertObservationTriples(store, observations, persisted);
  const item = (kind: "decision" | "antipattern", payload: unknown) => insertStopItem(db, {
    sessionId, transcriptKey: key, kind, fp: itemFingerprint(payload), payload,
    anchorEpoch: range.anchorEpoch, rangeFrom: range.from, rangeTo: range.to, rangeSha: range.sha,
  });
  for (const o of observations.filter(o => o.type === "decision")) {
    item("decision", { source: "observer", title: o.title, facts: o.facts, narrative: o.narrative, filesModified: o.filesModified });
  }
  for (const d of regex.decisions) item("decision", { source: "regex", text: d.text, context: d.context });
  for (const a of regex.antipatterns) item("antipattern", { text: a.text, context: a.context });
  reconcileSessionDocs(db, sessionId, key, now);
  return persisted;
}

/**
 * Quarantine a range (inside the Phase B transaction): retried, never skipped. A failure takes `attempts = 1` and the
 * failure backoff; a v0.41.2 continuation (its checkpoint kept) takes `attempts = 0` and is due again in 60 s.
 */
function quarantineRange(store: Store, p: {
  sessionId: string; key: string; path: string; file: FileIdentity; range: RangeRef; reason: string; now: string; continuation?: boolean;
}): void {
  const next = p.continuation ? isoAfter(p.now, CONTINUATION_DELAY_MS) : nextRetryAt(p.now, 1);
  store.db.prepare(
    `INSERT OR IGNORE INTO stop_retries (session_id, transcript_key, hook, transcript_path, file_dev, file_ino, first_line_sha,
       anchor_epoch, from_offset, to_offset, range_key, range_sha, source_time, attempts, last_error, first_failed_at,
       next_retry_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`
  ).run(p.sessionId, p.key, DECISION_HOOK, p.path, p.file.dev, p.file.ino, p.file.firstLineSha, p.range.anchorEpoch,
    p.range.from, p.range.to, p.range.key, p.range.sha, p.range.sourceTime, p.continuation ? 0 : 1, p.reason, p.now, next);
}

/** v0.41.2: the flag that reports the messages a committed range held that the observer could not see. */
export const OBSERVER_DROPPED_FLAG = "observer_accumulator_dropped";
const DROPPED_RING = 50;

/** Add a committed range's unseen messages to OBSERVER_DROPPED_FLAG (inside the Phase B transaction). */
function noteDropped(db: Database, p: { sessionId: string; rangeKey: string; dropped: number; now: string }): void {
  if (p.dropped <= 0) return;
  const row = db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(OBSERVER_DROPPED_FLAG) as { value: string } | null;
  let v: { total: number; ranges: number; recent: { range_key: string; session: string; dropped: number; at: string }[] } = { total: 0, ranges: 0, recent: [] };
  try { if (row) v = { ...v, ...JSON.parse(row.value) }; } catch { /* a malformed value restarts the tally */ }
  v.total += p.dropped;
  v.ranges += 1;
  v.recent = [...(Array.isArray(v.recent) ? v.recent : []), { range_key: p.rangeKey, session: p.sessionId, dropped: p.dropped, at: p.now }].slice(-DROPPED_RING);
  db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(OBSERVER_DROPPED_FLAG, JSON.stringify(v), p.now);
  console.error(`[decision-extractor] range ${p.rangeKey}: ${p.dropped} message(s) beyond the observer's 100-message window were not seen`);
}

class CursorMoved extends Error {}
class ClaimLost extends Error {}

/**
 * A unit's Phase A outcome (62.1 D3 + v0.41.2 §1.4). `ok` / `empty` commit the range; `retryable` quarantines it as a
 * failure (attempts + 1, failure backoff); `continuation` quarantines it with its checkpoint kept and attempts unchanged
 * (`due`: "soon" = in 60 s, "now" = at the next replay); `abandon` decides nothing here — the range was committed by
 * another processor, or another processor is ahead on it.
 */
type UnitOutcome =
  | { status: "ok"; observations: Observation[] }
  | { status: "empty" }
  | { status: "retryable"; reason: string }
  | { status: "continuation"; reason: string; due: "soon" | "now" }
  | { status: "abandon"; committedElsewhere: boolean };

type PhaseAOut = {
  result: UnitOutcome;
  judged: JudgePrepared | null;
  decisionFacts: { obs: Observation; fact: string }[];
  /** Messages the unit held that the observer could not see: T24's accumulator tail + the 100-message render cap. */
  dropped: number;
};

/** The pause before a continuation is due again (the worker's tick). */
const CONTINUATION_DELAY_MS = 60_000;
/** v0.41.2 (codex T11-13): the observer's measured mean call, as the Stop pipeline keeps it for the doctor. */
export const OBSERVER_CALL_MEAN_FLAG = "observer_call_mean";

function isoAfter(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * `vault_flags` as the LLM layer's template-overhead store (design §1.2). v0.41.4: also the observer's shared records
 * (context ceilings, grammar-off records) — each merge one immediate transaction (a savepoint when nested).
 */
function vaultFlagStore(db: Database): OverheadStore {
  const get = (key: string) => (db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(key) as { value: string } | null)?.value ?? null;
  const set = (key: string, value: string) => {
    db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value, isoNow());
  };
  const del = (key: string) => { db.prepare(`DELETE FROM vault_flags WHERE flag = ?`).run(key); };
  return {
    get, set, delete: del,
    update: (key, fn) => db.transaction(() => {
      const old = get(key);
      const next = fn(old);
      if (next === old) return;
      if (next === null) del(key); else set(key, next);
    }).immediate(),
    entries: (prefix) => (db.prepare(`SELECT flag, value FROM vault_flags WHERE flag >= ? AND flag < ? ORDER BY flag`)
      .all(prefix, `${prefix}\uffff`) as { flag: string; value: string }[]).map(r => ({ key: r.flag, value: r.value })),
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
  };
}

/** v0.41.4 (§4.5): what the observer's replies showed, per backend key — what the doctor reports. */
export const OBSERVER_STATS_FLAG = "observer_stats";
/** The record keeps this many backend keys, the latest by `at`. */
const OBSERVER_STATS_BACKENDS = 4;

/**
 * Add the observer statistics this process measured since its last take to OBSERVER_STATS_FLAG (§4.5): per backend
 * key, counts merged as deltas inside one immediate transaction (codex T2-19), the latest 4 keys kept. Best-effort.
 */
export function persistObserverStats(db: Database): void {
  const taken = takeObserverStats();
  const deltas = Object.entries(taken.backends).filter(([, d]) => OBSERVER_STATS_FIELDS.some(f => d[f] > 0));
  if (deltas.length === 0) return;
  try {
    db.transaction(() => {
      const row = db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(OBSERVER_STATS_FLAG) as { value: string } | null;
      let backends: Record<string, Record<string, unknown>> = {};
      try {
        const v = row ? JSON.parse(row.value) as { backends?: unknown } : {};
        if (v.backends && typeof v.backends === "object" && !Array.isArray(v.backends)) backends = v.backends as Record<string, Record<string, unknown>>;
      } catch { /* a malformed value restarts the record */ }
      const now = isoNow();
      for (const [key, d] of deltas) {
        const cur = backends[key] ?? {};
        const merged: Record<string, unknown> = { at: now };
        for (const f of OBSERVER_STATS_FIELDS) merged[f] = (typeof cur[f] === "number" ? cur[f] as number : 0) + d[f];
        backends[key] = merged;
      }
      const kept = Object.entries(backends)
        .sort((a, b) => (Date.parse(String(b[1].at)) || 0) - (Date.parse(String(a[1].at)) || 0))
        .slice(0, OBSERVER_STATS_BACKENDS);
      db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(OBSERVER_STATS_FLAG, JSON.stringify({ backends: Object.fromEntries(kept) }), now);
    }).immediate();
  } catch { /* best-effort: the doctor shows what was persisted before */ }
}

/**
 * Add the observer calls this process measured since its last take to OBSERVER_CALL_MEAN_FLAG (codex T11-13, T12-5):
 * the latest OBSERVER_CALL_SAMPLES calls recorded by every process that runs the observer, and their mean — what the
 * doctor shows. Best-effort.
 */
export function persistObserverCallMean(db: Database): void {
  const taken = takeObserverCallSamples();
  if (taken.length === 0) return;
  try {
    const row = db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(OBSERVER_CALL_MEAN_FLAG) as { value: string } | null;
    let kept: number[] = [];
    try {
      const v = row ? JSON.parse(row.value) as { recent?: unknown } : {};
      if (Array.isArray(v.recent)) kept = v.recent.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0);
    } catch { /* a malformed value restarts the record */ }
    const recent = [...kept, ...taken.map(Math.round)].slice(-OBSERVER_CALL_SAMPLES);
    const ms = Math.round(recent.reduce((sum, x) => sum + x, 0) / recent.length);
    const now = isoNow();
    db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(OBSERVER_CALL_MEAN_FLAG, JSON.stringify({ ms, samples: recent.length, recent, at: now }), now);
  } catch { /* best-effort: the doctor shows "not measured yet" */ }
}

/**
 * Group equal observation bodies before the judge and Phase B (v0.41.2 §1.4): `persistObservationDoc` stores one
 * document per formatted body (the path embeds its hash) and returns null for a repeat, so a repeat's triples and its
 * judge mapping would be lost. One body per group, carrying the union of the members' triples. The date only enters the
 * body's header, so one fixed date for the whole unit leaves equality unchanged.
 */
function groupEqualBodies(observations: Observation[], sessionId: string): Observation[] {
  const byBody = new Map<string, Observation>();
  for (const o of observations) {
    const k = createHash("sha256").update(formatObservation(o, "1970-01-01", sessionId)).digest("hex");
    const kept = byBody.get(k);
    if (!kept) {
      byBody.set(k, { ...o, ...(o.triples ? { triples: [...o.triples] } : {}) });
      continue;
    }
    for (const t of o.triples ?? []) {
      kept.triples ??= [];
      if (!kept.triples.some(x => x.subject === t.subject && x.predicate === t.predicate && x.object === t.object)) kept.triples.push(t);
    }
  }
  return [...byBody.values()];
}

/**
 * The windowed, checkpointed observer for one unit (v0.41.2 §1.4). A matching live checkpoint is resumed on its pinned
 * backend only (unreachable → a continuation, no reset; no longer configured or its server's fingerprint changed →
 * reset); otherwise the unit starts on the active backend and creates its checkpoint. Progress after each window goes
 * through a compare-and-swap; a lost swap abandons the unit to the processor that is ahead.
 */
async function observeUnit(
  store: Store,
  p: {
    sessionId: string; transcriptKey: string; range: RangeRef; messages: TranscriptMessage[]; prior: TranscriptLine[];
    sourceTime: string | null; deadline: MonoDeadline; observerMaxCalls?: number;
  },
): Promise<UnitOutcome> {
  const db = store.db;
  const llm = budgetLayerOf(getDefaultLlamaCpp());
  const lines = renderObserverLines(p.messages);
  const want = {
    sessionId: p.sessionId, transcriptKey: p.transcriptKey, hook: DECISION_HOOK, range: p.range,
    linesSha: observerLinesSha(lines), contract: observerContract(),
  };
  const key = checkpointKey(p.sessionId, p.transcriptKey, DECISION_HOOK, p.range.key);
  const context = { priorMessages: toObserverMessages(p.prior), recordedTitles: recordedTitles(store, p.sessionId, p.sourceTime) };
  const overheadStore = vaultFlagStore(db);
  const rangeOf = { anchorEpoch: p.range.anchorEpoch, from: p.range.from, to: p.range.to, sha: p.range.sha };

  const loaded = readCheckpoint(db, key);
  if (loaded?.value?.state === "done") return { status: "abandon", committedElsewhere: true };
  let raw: string | null = loaded?.raw ?? null;
  let current: ObserverCheckpoint | null = null;
  let resume: WindowProgress | undefined;
  let backend: LlmBackendId | null = null;
  let fingerprint: string | undefined;
  let strength: LlmCapacity["fingerprintStrength"] | undefined;

  if (loaded?.value && checkpointMatches(loaded.value, want)) {
    const c = loaded.value;
    if (llm.isConfiguredBackend(c.backend)) {
      if (!llm.isBackendAvailable(c.backend)) {
        return { status: "continuation", reason: `continuation: ${c.doneThroughLine}/${lines.length} lines — its backend is unavailable`, due: "soon" };
      }
      const cap = await llm.llmCapacity(c.backend, { deadline: p.deadline });   // the fingerprint, read FRESH before a resume
      const verdict = fingerprintVerdict({ fingerprint: c.fingerprint, strength: c.fingerprintStrength }, cap);
      if (verdict === "same") {
        backend = c.backend; fingerprint = c.fingerprint; strength = c.fingerprintStrength; current = c;
        // v0.41.4 §3.3: its window bound rides along; the observer ignores a malformed or foreign one.
        resume = { doneThroughLine: c.doneThroughLine, observations: c.observations, titles: c.titles, windowBound: c.windowBound };
      } else if (verdict === "unverified") {
        // codex T11-3, T13-1: `/props` gave no fingerprint (no answer, an error, a body that is not llama.cpp's, or one
        // without the model, template and build) — the server may be the same one; keep the windows done and wait,
        // however long (as for an unreachable backend). Only a verified differing fingerprint resets the checkpoint.
        return { status: "continuation", reason: `continuation: ${c.doneThroughLine}/${lines.length} lines — its server could not be verified`, due: "soon" };
      }
    }
  }

  // Start (or reset): the active backend, a fresh checkpoint at line 0 — created, or swapped over an invalid row.
  const start = async (): Promise<UnitOutcome | null> => {
    backend = llm.activeLlmBackend();
    if (!backend) return { status: "retryable", reason: "model unavailable" };
    const cap = await llm.llmCapacity(backend, { deadline: p.deadline });
    fingerprint = cap.fingerprint;
    strength = cap.fingerprintStrength;
    const fresh = liveCheckpoint({
      rev: (current?.rev ?? loaded?.value?.rev ?? 0) + 1, sessionId: p.sessionId, transcriptKey: p.transcriptKey, hook: DECISION_HOOK,
      range: rangeOf, linesSha: want.linesSha, contract: want.contract, backend, fingerprint, fingerprintStrength: strength,
      doneThroughLine: 0, observations: [], titles: [],
    });
    const stored = raw === null ? createCheckpoint(db, key, fresh) : swapCheckpoint(db, key, raw, fresh);
    if (stored === null) {
      return { status: "abandon", committedElsewhere: readCheckpoint(db, key)?.value?.state === "done" };
    }
    raw = stored; current = fresh; resume = undefined;
    return null;
  };
  if (!resume) {
    const stop = await start();
    if (stop) return stop;
  }

  const onProgress = (prog: WindowProgress): boolean => {
    if (!current || raw === null) return false;
    // v0.41.4 §3.3: a bound write keeps the line and only ever shrinks the stored bound; an advance drops it.
    const { windowBound: storedBound, ...rest } = current;
    let windowBound: ObserverCheckpoint["windowBound"];
    if (prog.windowBound) {
      if (prog.doneThroughLine !== current.doneThroughLine || prog.windowBound.start !== current.doneThroughLine) return false;
      const prior = validWindowBound(storedBound, current.doneThroughLine);
      windowBound = { start: prog.windowBound.start, maxLines: prior ? Math.min(prior.maxLines, prog.windowBound.maxLines) : prog.windowBound.maxLines };
    }
    const next: ObserverCheckpoint = {
      ...rest, rev: current.rev + 1, doneThroughLine: prog.doneThroughLine, observations: prog.observations, titles: prog.titles, at: isoNow(),
      ...(windowBound ? { windowBound } : {}),
    };
    const stored = swapCheckpoint(db, key, raw, next);
    if (stored === null) return false;
    raw = stored; current = next;
    return true;
  };

  const run = (maxCalls: number) => extractObservationsWindowed(p.messages, {
    llm, backend: backend!, deadline: p.deadline, context, resume, onProgress, overheadStore, expectFingerprint: fingerprint,
    expectStrength: strength, maxCalls,
  });
  const callCap = p.observerMaxCalls ?? MAX_OBSERVER_CALLS;
  let r = await run(callCap);
  if (r.status === "unavailable" && r.doneThroughLine === 0 && !resume) {
    // A unit's first window: re-fit for the next backend (the remote is now in cooldown → local, when allowed) and pin to it.
    // codex T11-14: the fallback gets what this invocation's call cap has left, never a fresh cap.
    const alt = llm.activeLlmBackend();
    if (alt && JSON.stringify(alt) !== JSON.stringify(backend)) {
      const stop = await start();
      if (stop) return stop;
      r = await run(Math.max(0, callCap - r.calls));
    }
  }
  persistObserverCallMean(db);
  persistObserverStats(db);
  switch (r.status) {
    case "ok": return { status: "ok", observations: r.observations };
    case "empty": return { status: "empty" };
    case "retryable": return { status: "retryable", reason: r.reason };
    case "partial": return { status: "continuation", reason: `continuation: ${r.doneThroughLine}/${r.totalLines} lines`, due: "soon" };
    case "unavailable":
      if (r.doneThroughLine > 0 || resume) {
        return { status: "continuation", reason: `continuation: ${r.doneThroughLine}/${r.totalLines} lines — its backend is unavailable`, due: "soon" };
      }
      return { status: "retryable", reason: "model unavailable" };
    case "server_changed": {
      const stop = await start();   // reset now; the next invocation restarts the unit on the server as it is
      return stop ?? { status: "continuation", reason: "continuation: 0 lines — the LLM server changed", due: "soon" };
    }
    case "unverified":
      // codex T11-3: the server stopped answering `/props` mid-run — the progress stays in the checkpoint; retry soon.
      return { status: "continuation", reason: `continuation: ${r.doneThroughLine}/${r.totalLines} lines — its server could not be verified`, due: "soon" };
    case "overtaken": return { status: "abandon", committedElsewhere: readCheckpoint(db, key)?.value?.state === "done" };
  }
}

/**
 * Phase A for one range — admission, the observer (with CONTEXT), the judge's call. No range effects (v0.41.2: the
 * observer's checkpoint is provisional state, not an effect). `null` when the budget does not allow starting it and the
 * caller should stop rather than quarantine (`quarantineIfNoBudget` false).
 */
async function phaseA(
  store: Store,
  p: {
    sessionId: string; transcriptKey: string; range: RangeRef; admits: boolean; messages: TranscriptMessage[];
    prior: TranscriptLine[]; sourceTime: string | null; deadline: MonoDeadline; quarantineIfNoBudget: boolean;
    phaseSkipNotes?: string[]; dropped?: number; observerMaxCalls?: number;
  },
): Promise<PhaseAOut | null> {
  const dropped = (p.dropped ?? 0) + Math.max(0, p.messages.length - OBSERVER_MAX_MESSAGES);
  let result: UnitOutcome;
  if (!p.admits) {
    result = { status: "empty" };
  } else {
    const remaining = remainingForTimeout(deadlineBefore(p.deadline, duration(PERSIST_RESERVE_MS)));
    if (remaining === null || shorterThan(remaining, duration(CAUSAL_MIN_BUDGET_MS))) {
      if (!p.quarantineIfNoBudget) return null;
      p.phaseSkipNotes?.push("observation extraction skipped: Stop budget below the floor — range deferred");
      result = { status: "continuation", reason: "continuation: 0 lines — the budget was below the observer floor", due: "now" };
    } else {
      result = await observeUnit(store, p);
    }
  }
  if (result.status === "ok") result = { status: "ok", observations: groupEqualBodies(result.observations, p.sessionId) };
  // The contradiction judge for the range's decisions (D3): inference only; effects wait for Phase B.
  const decisionFacts = (result.status === "ok" ? result.observations : [])
    .filter(o => o.type === "decision").flatMap(o => o.facts.map(fact => ({ obs: o, fact })));
  let judged: JudgePrepared | null = null;
  if (decisionFacts.length > 0) {
    try {
      judged = await judgePhaseA(store, decisionFacts.map(f => f.fact), p.sessionId, p.deadline, { sourceTime: p.sourceTime });
    } catch (err) {
      console.error(`[decision-extractor] Error in contradiction detection:`, err);
    }
  }
  return { result, judged, decisionFacts, dropped };
}

/** Phase B effects of an `ok`/`empty` range (inside the transaction): documents, items, renders, causal marker, verdicts. */
function commitRangeEffects(
  store: Store,
  p: { sessionId: string; key: string; range: RangeRef; a: PhaseAOut; regex: RegexItems; now: string; replay: boolean },
): ObservationWithDoc[] {
  const observations = p.a.result.status === "ok" ? p.a.result.observations : [];
  const persisted = writeBatchEffects(store, p.sessionId, p.key, p.range, observations, p.regex, p.now, p.replay);
  // D3: the range owes its causal step (Phase C), keyed by the range — at most one run, whatever happens next. A
  // replayed range's window is its source time.
  insertCausalMarker(store, {
    sessionId: p.sessionId, transcriptKey: p.key, rangeKey: p.range.key, obsDocIds: persisted.map(x => x.docId),
    sourceTime: p.range.sourceTime, windowAt: p.replay ? (p.range.sourceTime ?? p.now) : p.now, now: p.now,
  });
  const judged = p.a.judged;
  if (judged) {
    const docOf = new Map(persisted.map(x => [x.facts, x.docId] as const));
    const factDocIds = p.a.decisionFacts.map(f => docOf.get(f.obs.facts) ?? null);
    try {
      const j = judgePhaseB(store, judged, factDocIds, p.sessionId);
      if (j.contradictions > 0) console.error(`[decision-extractor] Found ${j.contradictions} contradiction(s) with prior decisions`);
    } catch (err) {
      // The verdicts' own savepoint rolled back; the range still commits (§J7: an unauditable erosion never lands).
      insertJudgeRunBestEffort(store.db, {
        sessionId: p.sessionId, consumer: "decision-extractor", lane: judged.audit.lane, model: judged.audit.model,
        endpoint: judged.audit.endpoint, promptVersion: judged.audit.promptVersion, newFactCount: judged.newFacts.length,
        candidateCount: judged.candidates.length, responseSha256: judged.audit.responseSha256, outcome: "write_error",
      });
      console.error(`[decision-extractor] contradiction apply FAILED — no verdict applied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return persisted;
}

export type ExtractionArgs = {
  sessionId: string;
  transcriptPath: string;
  host?: string;
  sessionKey?: string;
  /** The Stop handler's whole-handler deadline (monotonic); default: 30 s from now. */
  deadline?: MonoDeadline;
  /** Test seam: stop after this many batches. */
  maxBatches?: number;
  /** Test seam (v0.41.2): the observer's model calls per unit in this invocation (default: its budget, at most 6). */
  observerMaxCalls?: number;
  /** Test seam: runs between a batch's Phase A and its Phase B. */
  beforePhaseB?: () => void;
  phaseSkipNotes?: string[];
  /** Test seam: the read's byte bound (default STOP_READ_MAX_BYTES). */
  readMaxBytes?: number;
  /** Called after each committed batch (Phase C: the causal step owed by that range). */
  afterCommit?: (committed: { range: RangeRef; observations: Observation[]; persisted: ObservationWithDoc[] }) => Promise<void>;
};

export type ExtractionRun = {
  batches: number;
  committed: number;
  quarantined: number;
  discarded: number;
  observations: Observation[];
  persisted: ObservationWithDoc[];
};

/** One unit of work: a batch of complete turns, or one turn too large for a read, streamed whole (T24 #1). */
type Unit = {
  range: RangeRef;
  messages: TranscriptMessage[];
  admits: boolean;
  regex: RegexItems;
  tailSha: string;
  /** The start of the unit's last opening line (the cursor's `turn_start_offset`). */
  lastOpenStart: number | null;
  /** The unit's human lines (the cursor's `human_turns` count). */
  humans: number;
  /** The CONTEXT lines the NEXT unit sees (this unit's last turns). */
  tailLines: TranscriptLine[];
  /** v0.41.2: messages the streamed accumulator dropped upstream (T24's 100-message tail), reported at commit. */
  dropped?: number;
};

function unitOfBatch(path: string, epoch: number, batch: Turn[]): Unit {
  const lines = batch.flatMap(t => t.lines);
  const messages = batch.flatMap((t, i) => t.messages.map(m => ({ ...m, turn: i })));   // v0.41.2: turn = its index in the unit
  const humans = lines.filter(l => l.kind === "human");
  return {
    range: rangeRefOf(path, epoch, lines), messages, admits: admitsBatch(lines), regex: regexItemsOf(messages),
    tailSha: lines.at(-1)!.sha, lastOpenStart: lines.filter(opensTurn).at(-1)?.start ?? null, humans: humans.length,
    tailLines: batch.slice(-CONTEXT_PRIOR_TURNS).flatMap(t => t.lines),
  };
}

function rangeOfAccumulator(path: string, epoch: number, acc: LineAccumulator): RangeRef {
  const sha = rangeSha(path, acc.start, acc.end)!;
  const ts = acc.openTs ?? acc.firstTs;
  return {
    anchorEpoch: epoch, from: acc.start, to: acc.end, sha, key: `${epoch}-${acc.start}-${acc.end}-${sha.slice(0, 16)}`,
    sourceTime: ts !== null ? new Date(ts).toISOString() : null,
  };
}

export async function runDecisionExtraction(store: Store, args: ExtractionArgs): Promise<ExtractionRun> {
  const run: ExtractionRun = { batches: 0, committed: 0, quarantined: 0, discarded: 0, observations: [], persisted: [] };
  const db = store.db;
  const path = locatorPath(args.transcriptPath);
  if (!stopPipelineReady(db) || !path || !existsSync(path)) return run;
  const key = transcriptKey(path);
  registerTranscript(db, args.sessionId, path, stopHostOf(args.host), args.sessionKey ?? null);
  const deadline = args.deadline ?? deadlineAfter(monoNow(), duration(DEFAULT_RUN_BUDGET_MS));

  const start = resolveCursorStart(db, args.sessionId, DECISION_HOOK, key, path, { host: stopHostOf(args.host) });
  if (!start) return run;
  if (start.reason === "re-anchor") {
    console.error(`[decision-extractor] transcript changed under the cursor (${start.detail}) — re-anchored at the current turn (generation ${start.anchorEpoch})`);
  }
  const read = readLines(path, start.start, { maxBytes: args.readMaxBytes });
  const segs = segmentTurns(read.lines, { trailingComplete: read.eof }).filter(s => s.complete);
  let units: Unit[];
  if (segs.length === 0 && read.bounded) {
    // One turn larger than a read (T24 #1): streamed to its end in bounded reads, processed as ONE turn — never as
    // pieces, so its inference sees the turn's end. At a Stop the turn is over at the next opening entry or at the end.
    const big = accumulateLines(path, start.start, { stopAtNextOpening: true, maxBytes: args.readMaxBytes, deadline });
    if (big.stream.expired || !(big.reachedOpening || big.stream.eof) || big.acc.lines === 0) return run;   // redone next Stop
    const acc = big.acc;
    units = [{
      range: rangeOfAccumulator(path, start.anchorEpoch, acc), messages: accumulatedMessages(acc), admits: acc.admits,
      regex: { decisions: acc.decisions, antipatterns: acc.antipatterns }, tailSha: acc.lastLineSha!,
      lastOpenStart: acc.openStart, humans: acc.humanStart !== null ? 1 : 0, tailLines: [], dropped: accumulatorDropped(acc),
    }];
  } else {
    const turns: Turn[] = segs.map(s => ({ lines: s.lines, messages: toObserverMessages(s.lines), start: s.start, end: s.end }));
    if (turns.length === 0) return run;
    // Each batch leaves the CONTEXT's and a retry's share of the render budget (v0.41.1): the observer renders it whole.
    units = packTurnBatches(turns, { maxMessages: OBSERVER_MAX_MESSAGES, maxChars: OBSERVER_MAX_RENDER_CHARS, reservedChars: OBSERVER_BATCH_RESERVED_CHARS })
      .map(batch => unitOfBatch(path, start.anchorEpoch, batch));
  }

  let prior = lastTurnsBefore(path, units[0]!.range.from, CONTEXT_PRIOR_TURNS);
  let cursor: StopCursor | null = start.cursor;
  for (const u of units) {
    if (args.maxBatches !== undefined && run.batches >= args.maxBatches) break;
    const range = u.range;

    // Phase A — inference, no range effects. The first batch of a Stop is always decided (a budget skip quarantines
    // it as a continuation); later batches wait for the next Stop.
    const a = await phaseA(store, {
      sessionId: args.sessionId, transcriptKey: key, range, admits: u.admits, messages: u.messages, prior, sourceTime: null, deadline,
      quarantineIfNoBudget: run.batches === 0, phaseSkipNotes: args.phaseSkipNotes, dropped: u.dropped, observerMaxCalls: args.observerMaxCalls,
    });
    if (!a) break;
    if (a.result.status === "abandon") break;   // v0.41.2: committed, or being worked, by another processor
    run.batches++;
    args.beforePhaseB?.();

    // Phase B — one transaction, CAS on the cursor position Phase A read.
    const now = isoNow();
    let persisted: ObservationWithDoc[] = [];
    try {
      db.transaction(() => {
        if (a.result.status === "retryable" || a.result.status === "continuation") {
          quarantineRange(store, {
            sessionId: args.sessionId, key, path, file: start.file, range, reason: a.result.reason, now,
            continuation: a.result.status === "continuation",
          });
        } else {
          persisted = commitRangeEffects(store, { sessionId: args.sessionId, key, range, a, regex: u.regex, now, replay: false });
          finishCheckpoint(db, checkpointKey(args.sessionId, key, DECISION_HOOK, range.key), { sessionId: args.sessionId, transcriptKey: key, hook: DECISION_HOOK, range });
          noteDropped(db, { sessionId: args.sessionId, rangeKey: range.key, dropped: a.dropped, now });
        }
        const moved = !casAdvanceCursor(db, args.sessionId, DECISION_HOOK, key, cursor, {
          transcriptPath: path, file: start.file, anchorEpoch: start.anchorEpoch, byteOffset: range.to,
          tailSha: u.tailSha, turnStartOffset: u.lastOpenStart ?? cursor?.turnStartOffset ?? null,
          humanTurns: (cursor?.humanTurns ?? 0) + u.humans,
        });
        if (moved) throw new CursorMoved();
      }).immediate();
    } catch (err) {
      if (err instanceof CursorMoved) { run.discarded++; break; }   // another writer committed this range
      throw err;
    }
    cursor = readStopCursor(db, args.sessionId, DECISION_HOOK, key);
    if (a.result.status === "retryable" || a.result.status === "continuation") {
      run.quarantined++;
      break;   // v0.41.2 (T9-1): the loop ends at its first quarantined unit — at most one retry row per Stop
    } else {
      const observations = a.result.status === "ok" ? a.result.observations : [];
      run.committed++;
      run.observations.push(...observations);
      run.persisted.push(...persisted);
      if (args.afterCommit) await args.afterCommit({ range, observations, persisted });
    }
    prior = u.tailLines;
  }
  return run;
}

// ── Replay of quarantined ranges (D3) ───────────────────────────────────────────────────────────────────────────

const LEASE_MS = 5 * 60_000;

type RetryRow = {
  id: number; session_id: string; transcript_key: string; transcript_path: string; anchor_epoch: number;
  from_offset: number; to_offset: number; range_key: string; range_sha: string; source_time: string | null; attempts: number;
};

export type ReplayRun = {
  replayed: number; unavailable: number; rescheduled: number; persisted: ObservationWithDoc[]; ranges: RangeRef[];
  /** v0.41.4 (§7.2): rows claimed and processed, whatever the outcome — `repair stop-queue --run` counts them as progress. */
  attempted: number; attemptedIds: number[];
};

/**
 * Replay due quarantined ranges (later Stops: at most one, inside their budget; the worker: bounded). Each is claimed
 * with a 5-minute lease (a crashed claimant's item is reclaimable after it), its bytes are re-read by its own locator
 * and verified against `range_sha` first — changed bytes → `unavailable`, nothing processed — and its Phase B writes
 * the effects (with the range's SOURCE time) and marks it `done` in one transaction that CAS-checks the claim token.
 * The range is streamed into a bounded accumulator (T24): one read of any size, never all of it in memory.
 */
export async function replayDueRetries(
  store: Store,
  opts: {
    deadline: MonoDeadline; sessionId?: string; limit?: number; beforePhaseB?: () => void; afterClaim?: () => void;
    /** v0.41.2: only continuation rows (the worker's first slice). */
    continuationOnly?: boolean;
    /** Test seam (v0.41.2): the observer's model calls per range in this invocation. */
    observerMaxCalls?: number;
  },
): Promise<ReplayRun> {
  const out: ReplayRun = { replayed: 0, unavailable: 0, rescheduled: 0, persisted: [], ranges: [], attempted: 0, attemptedIds: [] };
  const db = store.db;
  if (!stopPipelineReady(db)) return out;
  const now0 = isoNow();
  const due = db.prepare(
    `SELECT id, session_id, transcript_key, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha, source_time, attempts
     FROM stop_retries WHERE hook = ?
       AND ${RETRY_DUE_SQL}
       ${opts.sessionId ? "AND session_id = ?" : ""}
       ${opts.continuationOnly ? "AND last_error LIKE 'continuation:%'" : ""}
     ORDER BY next_retry_at, id LIMIT ?`
  ).all(...[DECISION_HOOK, now0, now0, ...(opts.sessionId ? [opts.sessionId] : []), opts.limit ?? 1]) as RetryRow[];
  for (const r of due) {
    const token = randomUUID();
    const claimAt = isoNow();
    db.prepare(
      `UPDATE stop_retries SET state = 'claimed', claim_token = ?, lease_expires_at = ?
       WHERE id = ? AND ${RETRY_DUE_SQL}`
    ).run(token, new Date(Date.parse(claimAt) + LEASE_MS).toISOString(), r.id, claimAt, claimAt);
    if (lastChanges(db) !== 1) continue;   // another processor holds it
    opts.afterClaim?.();
    const attempt = () => { out.attempted++; out.attemptedIds.push(r.id); };
    const setState = (sql: string, ...args: (string | number | null)[]) => {
      db.prepare(`UPDATE stop_retries SET ${sql} WHERE id = ? AND claim_token = ?`).run(...args, r.id, token);
      return lastChanges(db) === 1;
    };
    // Integrity first: the range must hold exactly the bytes that failed.
    if (!existsSync(r.transcript_path) || rangeSha(r.transcript_path, r.from_offset, r.to_offset) !== r.range_sha) {
      if (setState(`state = 'unavailable', claim_token = NULL, lease_expires_at = NULL, last_error = 'range bytes changed or transcript gone'`)) out.unavailable++;
      attempt();
      continue;
    }
    const replayRead = accumulateLines(r.transcript_path, r.from_offset, {
      stopAtNextOpening: false, to: r.to_offset, maxBytes: STOP_READ_MAX_BYTES, deadline: opts.deadline, releaseTrailingCommand: true,
    });
    if (replayRead.stream.expired) {
      setState(`state = 'queued', claim_token = NULL, lease_expires_at = NULL`);   // out of budget: due again at once
      break;
    }
    const acc = replayRead.acc;
    const range: RangeRef = { anchorEpoch: r.anchor_epoch, from: r.from_offset, to: r.to_offset, sha: r.range_sha, key: r.range_key, sourceTime: r.source_time };
    const prior = lastTurnsBefore(r.transcript_path, r.from_offset, CONTEXT_PRIOR_TURNS);
    const a = await phaseA(store, {
      sessionId: r.session_id, transcriptKey: r.transcript_key, range, admits: acc.admits, messages: accumulatedMessages(acc), prior,
      sourceTime: r.source_time, deadline: opts.deadline, quarantineIfNoBudget: true, dropped: accumulatorDropped(acc),
      observerMaxCalls: opts.observerMaxCalls,
    });
    if (a!.result.status === "abandon") {
      // v0.41.2: committed by another processor (its tombstone) → this row is done; another processor ahead → due again soon.
      if (a!.result.committedElsewhere) setState(`state = 'done', claim_token = NULL, lease_expires_at = NULL, last_error = 'committed by another processor'`);
      else setState(`state = 'queued', claim_token = NULL, lease_expires_at = NULL, next_retry_at = ?`, isoAfter(isoNow(), CONTINUATION_DELAY_MS));
      out.rescheduled++;
      attempt();
      continue;
    }
    opts.beforePhaseB?.();
    const now = isoNow();
    let persisted: ObservationWithDoc[] = [];
    try {
      db.transaction(() => {
        if (a!.result.status === "retryable") {
          if (!setState(`state = 'queued', claim_token = NULL, lease_expires_at = NULL, attempts = attempts + 1, last_error = ?, next_retry_at = ?`,
            a!.result.reason, nextRetryAt(now, r.attempts + 1))) throw new ClaimLost();
          return;
        }
        if (a!.result.status === "continuation") {
          // v0.41.2: progress kept in the checkpoint, not a failure — attempts unchanged, no failure backoff.
          const due = a!.result.due === "now" ? now : isoAfter(now, CONTINUATION_DELAY_MS);
          if (!setState(`state = 'queued', claim_token = NULL, lease_expires_at = NULL, last_error = ?, next_retry_at = ?`, a!.result.reason, due)) throw new ClaimLost();
          return;
        }
        persisted = commitRangeEffects(store, {
          sessionId: r.session_id, key: r.transcript_key, range, a: a!, regex: { decisions: acc.decisions, antipatterns: acc.antipatterns }, now, replay: true,
        });
        finishCheckpoint(db, checkpointKey(r.session_id, r.transcript_key, DECISION_HOOK, range.key), { sessionId: r.session_id, transcriptKey: r.transcript_key, hook: DECISION_HOOK, range });
        noteDropped(db, { sessionId: r.session_id, rangeKey: range.key, dropped: a!.dropped, now });
        if (!setState(`state = 'done', claim_token = NULL, lease_expires_at = NULL`)) throw new ClaimLost();
      }).immediate();
    } catch (err) {
      if (err instanceof ClaimLost) { attempt(); continue; }   // the lease expired and another processor took it: nothing of ours stands
      throw err;
    }
    attempt();
    if (a!.result.status === "retryable" || a!.result.status === "continuation") { out.rescheduled++; continue; }
    out.replayed++;
    out.persisted.push(...persisted);
    out.ranges.push(range);
  }
  return out;
}
