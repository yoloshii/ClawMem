/**
 * 62.1 D5: handoff-generator — two steps per Stop, each with its own Phase B, so a model failure never withholds the
 * deterministic record; and a render-only SessionEnd flush.
 *
 *  - Digest step (no model, first). From the hook's cursor (D2), one digest per turn in
 *    `stop_items(kind='turn-digest')`, keyed by the turn's start (`fp = <anchor_epoch>:<turn start offset>`) and
 *    carrying the turn's byte range: the request (≤ 200 chars), the final assistant paragraph (≤ 300 chars) and the files
 *    its Edit/Write/MultiEdit/NotebookEdit calls touched. A new digest takes `seq` from the cursor's `next_digest_seq`,
 *    which the same Phase B increments, so a `seq` is never reused and follows transcript order across generations.
 *    Rows are never modified: a turn that grew since its digest (a provisional one) has that row deleted and its full
 *    digest inserted with a new `seq`. The Phase B marks the handoff doc `render_needed` and advances the cursor.
 *  - Summary step (model, throttled). The watermark `summary_through` is the `seq` of the last digest a summary
 *    covered. It runs when a digest lies past it AND (3 do, or 30 minutes passed since `last_output_at`, or no summary
 *    exists yet), over ordered batches (the previous summary + the next digests in `seq` order, within the observer's
 *    input bound, + the text of the batch's latest turns that still fit, re-read by byte range and `range_sha`). `ok` →
 *    a Phase B that CAS-checks the watermark, replaces the summary item, advances the watermark, prunes the covered
 *    digests and renders the doc. `retryable` → only the audit columns change: the next attempt resumes at the
 *    watermark, so summaries cover turns in transcript order. The handoff never quarantines.
 *  - SessionEnd flush: reads no transcript and calls no model. It renders the summary + the latest 20 digests past
 *    the watermark (and a count of the earlier ones) with one `upsertSessionDoc`, records `ended_at`, and clears
 *    `render_needed` only when it displayed every digest. The worker (D11) does the uncapped render.
 *
 * A transcript earns a handoff at four messages across its turns (the pre-62.1 `MIN_MESSAGES_FOR_HANDOFF` floor), so
 * a one-exchange session writes no handoff and never displaces the previous session's in the bootstrap.
 */

import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import type { Store } from "./store.ts";
import {
  isoNow, epochNow, epochMs, deadlineBefore, remainingForTimeout, shorterThan, duration, isExpired, type MonoDeadline,
} from "./clock.ts";
import { lastChanges, stopPipelineReady } from "./stop-schema.ts";
import { hostText, stopHostOf, transcriptKey, type StopHost } from "./stop-pairing.ts";
import { locatorPath, registerTranscript } from "./stop-identity.ts";
import {
  readLines, segmentTurns, rangeSha, resolveCursorStart, readStopCursor, casAdvanceCursor, lineShaEndingAt,
  type TranscriptLine, type TurnSegment,
} from "./stop-cursor.ts";
import { accumulateLine, accumulateLines, accumulatedMessages, newAccumulator, type LineAccumulator } from "./stop-extract.ts";
import {
  extractSummaryFitted, observerRenderChars, prepareTranscript, renderDigestLine, renderSummaryText,
  OBSERVER_MAX_RENDER_CHARS, type SessionSummary, type TurnDigestText,
} from "./observer.ts";
import { insertStopItem, markSessionDocRenderNeeded, readSessionDoc, upsertSessionDoc, type SessionDocWrite } from "./stop-session-docs.ts";
import { CAUSAL_MIN_BUDGET_MS, PERSIST_RESERVE_MS } from "./causal-writer.ts";
import type { TranscriptMessage } from "./hooks.ts";

export const HANDOFF_HOOK = "handoff-generator";
/** SessionEnd opens the vault with this busy timeout and works under this deadline, inside Claude Code's 1.5 s cap. */
export const SESSION_END_BUSY_TIMEOUT_MS = 250;
export const SESSION_END_DEADLINE_MS = 1_000;
/** The digests a SessionEnd render displays (a display bound, never a retention bound). */
export const SESSION_END_DISPLAY_DIGESTS = 20;

const DIGEST_REQUEST_CHARS = 200;
const DIGEST_OUTCOME_CHARS = 300;
const DIGEST_FILES_MAX = 50;
const SUMMARY_FILES_MAX = 200;
const SUMMARY_FILES_SHOWN = 20;
const SUMMARY_MIN_DIGESTS = 3;
const SUMMARY_MIN_INTERVAL_MS = 30 * 60_000;
/** Digests a summary batch is packed from, per reload (a batch holds ~15 of them). */
const SUMMARY_PAGE = 200;
const HANDOFF_MIN_MESSAGES = 4;

export type TurnDigest = TurnDigestText & {
  /** The turn's human entry time (ISO), else its first timestamped entry's. */
  at: string | null;
  /** The observer messages the turn holds (the four-message floor). */
  messages: number;
};

export type HandoffSummaryItem = { summary: SessionSummary; files: string[]; through: number };

type StoredDigest = { seq: number; fp: string; rangeFrom: number; rangeTo: number; rangeSha: string; digest: TurnDigest };

class CursorMoved extends Error {}
class WatermarkMoved extends Error {}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

function mergeFiles(into: readonly string[], add: readonly string[], max: number): string[] {
  const out = [...into];
  for (const f of add) {
    if (out.length >= max) break;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** A digest from an accumulated turn (the same fields however the turn was read). */
export function digestOfAccumulator(host: StopHost, acc: LineAccumulator): TurnDigest {
  const paragraphs = acc.lastAssistantText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const ts = acc.humanTs ?? acc.firstTs;
  return {
    request: acc.humanText !== null ? clip(hostText(host, acc.humanText), DIGEST_REQUEST_CHARS) : "",
    outcome: clip(paragraphs.at(-1) ?? "", DIGEST_OUTCOME_CHARS),
    files: acc.files.slice(0, DIGEST_FILES_MAX),
    at: ts !== null ? new Date(ts).toISOString() : null,
    messages: acc.messageCount,
  };
}

/** One turn's digest: its request, its final assistant paragraph, the files its edit tools touched. */
export function digestOf(host: StopHost, lines: readonly TranscriptLine[]): TurnDigest {
  const acc = newAccumulator(lines[0]?.start ?? 0);
  for (const l of lines) accumulateLine(acc, l);
  return digestOfAccumulator(host, acc);
}

/** A turn worth a digest: a request, assistant text or an edit (pure metadata is passed over). */
function substantive(seg: TurnSegment): boolean {
  return seg.lines.some(l => l.kind === "human" || (l.kind === "assistant" && (l.text.trim().length > 0 || (l.toolUses?.length ?? 0) > 0)));
}

/** The digests past `afterSeq` in seq order — the first `limit` of them (all when omitted). */
function storedDigests(db: Database, sessionId: string, key: string, afterSeq: number, limit = -1): StoredDigest[] {
  const rows = db.prepare(
    `SELECT seq, fp, range_from, range_to, range_sha, payload FROM stop_items
     WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' AND seq > ? ORDER BY seq LIMIT ?`
  ).all(sessionId, key, afterSeq, limit) as { seq: number; fp: string; range_from: number; range_to: number; range_sha: string; payload: string }[];
  return rows.map(r => ({ seq: r.seq, fp: r.fp, rangeFrom: r.range_from, rangeTo: r.range_to, rangeSha: r.range_sha, digest: JSON.parse(r.payload) as TurnDigest }));
}

export function readHandoffSummary(db: Database, sessionId: string, key: string): HandoffSummaryItem | null {
  const r = db.prepare(
    `SELECT payload FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff-summary' AND fp = 'current'`
  ).get(sessionId, key) as { payload: string } | null;
  return r ? (JSON.parse(r.payload) as HandoffSummaryItem) : null;
}

/**
 * Whether this transcript has earned a handoff: a summary exists, or its stored digests hold four messages. Bounded
 * (T23 #4): every digest holds at least one message, so the first four decide.
 */
function handoffAdmitted(db: Database, sessionId: string, key: string): boolean {
  if (db.prepare(`SELECT 1 FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff-summary'`).get(sessionId, key)) return true;
  const rows = db.prepare(
    `SELECT COALESCE(json_extract(payload, '$.messages'), 0) AS m FROM stop_items
     WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' ORDER BY seq LIMIT ?`
  ).all(sessionId, key, HANDOFF_MIN_MESSAGES) as { m: number }[];
  return rows.reduce((n, r) => n + r.m, 0) >= HANDOFF_MIN_MESSAGES;
}

// ── Digest step ─────────────────────────────────────────────────────────────────────────────────────────────────

export type DigestArgs = {
  sessionId: string;
  transcriptPath: string;
  host?: string;
  sessionKey?: string;
  /** A Stop: every turn from the cursor is complete. The worker: only turns followed by a later human entry are. */
  atStop: boolean;
  /** Test seam: runs before the Phase B. */
  beforePhaseB?: () => void;
  /** Test seam: the read's byte bound (default STOP_READ_MAX_BYTES). */
  readMaxBytes?: number;
  /** Bounds the stream through a turn larger than one read (the Stop's budget, the worker's tick). */
  deadline?: MonoDeadline;
};

export type DigestRun = {
  transcriptKey: string | null;
  digested: number;
  provisional: number;
  discarded: boolean;
  /** The files the digested turns' edit tools touched. */
  files: string[];
};

/**
 * The digest step. A Stop digests every turn from the cursor and advances past them; the worker digests the turns
 * followed by a later human entry, gives the trailing turn a PROVISIONAL digest and leaves the cursor at its start, so
 * a turn still in progress is digested in full by the next Stop or tick. It fails only on the vault (a cursor moved
 * by another writer → discarded; busy → thrown to the caller), and is redone from the same cursor.
 */
export function runHandoffDigests(store: Store, args: DigestArgs): DigestRun {
  const run: DigestRun = { transcriptKey: null, digested: 0, provisional: 0, discarded: false, files: [] };
  const db = store.db;
  const path = locatorPath(args.transcriptPath);
  if (!stopPipelineReady(db) || !path || !existsSync(path)) return run;
  const key = transcriptKey(path);
  run.transcriptKey = key;
  const host = stopHostOf(args.host);
  registerTranscript(db, args.sessionId, path, host, args.sessionKey ?? null);

  const start = resolveCursorStart(db, args.sessionId, HANDOFF_HOOK, key, path, { host });
  if (!start) return run;
  if (start.reason === "re-anchor") {
    console.error(`[handoff-generator] transcript changed under the cursor (${start.detail}) — re-anchored at the current turn (generation ${start.anchorEpoch})`);
  }
  type Planned = { fp: string; from: number; to: number; sha: string; digest: TurnDigest; provisional: boolean };
  let planned: Planned[];
  let offset: number;
  let tailSha: string | null;
  let turnStartOffset: number | null;
  let humans: number;
  const tailAt = (o: number, lines: readonly TranscriptLine[]) =>
    lines.find(l => l.end === o)?.sha ?? (o === start.start && start.reason === "cursor" ? start.cursor!.tailSha : lineShaEndingAt(path, o)!);
  const read = readLines(path, start.start, { maxBytes: args.readMaxBytes });
  const segs = segmentTurns(read.lines, { trailingComplete: args.atStop && read.eof });
  if (!segs.some(s => s.complete) && read.bounded) {
    // One turn larger than a read (T24 #1): streamed in bounded reads into ONE digest — complete once its end is seen
    // (the next human entry; at a Stop, the end of the file), provisional while it runs (the cursor stays at its start).
    const big = accumulateLines(path, start.start, { stopAtNextHuman: true, maxBytes: args.readMaxBytes, deadline: args.deadline });
    if (big.stream.expired || big.acc.lines === 0) return run;   // redone from the same cursor
    const acc = big.acc;
    const done = big.reachedHuman || (args.atStop && big.stream.eof) || (big.stream.eof && acc.stopMarked);
    if (!done && acc.humanStart === null) return run;
    planned = acc.humanStart !== null || acc.admits ? [{
      fp: `${start.anchorEpoch}:${acc.start}`, from: acc.start, to: acc.end, sha: rangeSha(path, acc.start, acc.end)!,
      digest: digestOfAccumulator(host, acc), provisional: !done,
    }] : [];
    offset = done ? acc.end : acc.start;
    tailSha = done ? acc.lastLineSha! : tailAt(offset, []);
    turnStartOffset = done ? acc.humanStart ?? start.cursor?.turnStartOffset ?? null : acc.start;
    humans = done && acc.humanStart !== null ? 1 : 0;
  } else {
    // A trailing turn a stop marker closed is complete for the worker too (T25 #1: its Stop fired).
    for (const seg of segs) {
      if (seg.complete || !read.eof) continue;
      const lastAssistant = seg.lines.map(l => l.kind === "assistant").lastIndexOf(true);
      if (lastAssistant >= 0 && seg.lines.some((l, i) => l.stopMarker && i > lastAssistant)) seg.complete = true;   // answered, then closed
    }
    const complete = segs.filter(s => s.complete);
    const trailing = !args.atStop ? segs.find(s => !s.complete) : undefined;
    planned = [
      ...complete.map(seg => ({ seg, provisional: false })),
      ...(trailing && trailing.humanIndex !== null ? [{ seg: trailing, provisional: true }] : []),
    ].filter(p => substantive(p.seg)).map(p => ({
      fp: `${start.anchorEpoch}:${p.seg.start}`, from: p.seg.start, to: p.seg.end, sha: rangeSha(path, p.seg.start, p.seg.end)!,
      digest: digestOf(host, p.seg.lines), provisional: p.provisional,
    }));
    // Where the cursor goes: past the complete turns; a turn in progress keeps it at that turn's start.
    const lastComplete = complete.at(-1);
    offset = trailing ? trailing.start : lastComplete ? lastComplete.end : start.start;
    tailSha = tailAt(offset, read.lines);
    const completeHumans = complete.flatMap(s => s.lines.filter(l => l.kind === "human"));
    turnStartOffset = trailing ? trailing.start : completeHumans.at(-1)?.start ?? start.cursor?.turnStartOffset ?? null;
    humans = completeHumans.length;
  }
  if (planned.length === 0 && offset === start.start && start.reason === "cursor") return run;

  args.beforePhaseB?.();
  const now = isoNow();
  let seq = start.cursor?.nextDigestSeq ?? 1;
  let digested = 0;
  let provisional = 0;
  const files: string[] = [];
  try {
    db.transaction(() => {
      let changed = false;
      for (const p of planned) {
        const existing = db.prepare(
          `SELECT range_to, range_sha FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' AND fp = ?`
        ).get(args.sessionId, key, p.fp) as { range_to: number; range_sha: string } | null;
        if (existing && existing.range_to === p.to && existing.range_sha === p.sha) continue;   // unchanged: it stands
        if (existing) {
          db.prepare(`DELETE FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' AND fp = ?`)
            .run(args.sessionId, key, p.fp);
        }
        insertStopItem(db, {
          sessionId: args.sessionId, transcriptKey: key, kind: "turn-digest", fp: p.fp, payload: p.digest,
          anchorEpoch: start.anchorEpoch, rangeFrom: p.from, rangeTo: p.to, rangeSha: p.sha, seq: seq++,
        });
        changed = true;
        digested++;
        if (p.provisional) provisional++;
        files.push(...p.digest.files);
      }
      if (changed && handoffAdmitted(db, args.sessionId, key)) markSessionDocRenderNeeded(db, args.sessionId, key, "handoff", now);
      const moved = !casAdvanceCursor(db, args.sessionId, HANDOFF_HOOK, key, start.cursor, {
        transcriptPath: path, file: start.file, anchorEpoch: start.anchorEpoch, byteOffset: offset, tailSha: tailSha!, turnStartOffset,
        humanTurns: (start.cursor?.humanTurns ?? 0) + humans, nextDigestSeq: seq,
      });
      if (moved) throw new CursorMoved();
    }).immediate();
  } catch (err) {
    if (err instanceof CursorMoved) { run.discarded = true; return run; }   // another writer digested this stretch
    throw err;
  }
  run.digested = digested;
  run.provisional = provisional;
  run.files = mergeFiles([], files, SUMMARY_FILES_MAX);
  return run;
}

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────────────────────

function renderHandoffBody(
  sessionId: string,
  date: string,
  summary: HandoffSummaryItem | null,
  shown: readonly TurnDigest[],
  earlier: number,
): string {
  const s = summary?.summary;
  const lines = [
    `---`, `content_type: handoff`, `tags: [auto-generated${s ? ", observer" : ""}]`, `---`, ``,
    `# Session Handoff — ${date}`, ``, `Session: \`${sessionId.slice(0, 8)}\``, ``,
  ];
  if (s) {
    if (s.request !== "None") lines.push(`## Request`, ``, s.request, ``);
    if (s.investigated !== "None") lines.push(`## What Was Investigated`, ``, s.investigated, ``);
    if (s.learned !== "None") lines.push(`## What Was Learned`, ``, s.learned, ``);
    if (s.completed !== "None") lines.push(`## What Was Done`, ``, s.completed, ``);
    if (summary!.files.length > 0) {
      lines.push(`## Files Changed`, ``, ...summary!.files.slice(0, SUMMARY_FILES_SHOWN).map(f => `- \`${f}\``), ``);
    }
    if (s.nextSteps !== "None") lines.push(`## Next Session Should`, ``, s.nextSteps, ``);
  }
  if (shown.length > 0 || earlier > 0) {
    lines.push(`## Turns after the last summary`, ``);
    if (earlier > 0) lines.push(`_${earlier} earlier turn${earlier === 1 ? "" : "s"} not shown._`, ``);
    for (const d of shown) {
      lines.push(`- **Request:** ${d.request || "(continued turn)"}`);
      if (d.outcome) lines.push(`  **Outcome:** ${d.outcome}`);
      if (d.files.length > 0) lines.push(`  **Files:** ${d.files.map(f => `\`${f}\``).join(", ")}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

export type HandoffRender = { write: SessionDocWrite; complete: boolean };

/**
 * Render one transcript's handoff doc — the summary + the digests past the watermark, the latest `cap` of them
 * (null = all) — inside the caller's transaction. `render_needed` is cleared only by a render that displayed every
 * stored digest. Null when there is nothing to render or the transcript has not earned a handoff.
 */
export function renderHandoffDoc(
  db: Database,
  sessionId: string,
  key: string,
  opts: { cap: number | null; now?: string; endedAt?: string },
): HandoffRender | null {
  if (!handoffAdmitted(db, sessionId, key)) return null;
  const now = opts.now ?? isoNow();
  const summary = readHandoffSummary(db, sessionId, key);
  const watermark = readStopCursor(db, sessionId, HANDOFF_HOOK, key)?.summaryThrough ?? 0;
  // Bounded by the display (T23 #4): a count and the latest `cap` rows, never every stored digest.
  const total = (db.prepare(
    `SELECT COUNT(*) AS n FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' AND seq > ?`
  ).get(sessionId, key, watermark) as { n: number }).n;
  if (!summary && total === 0) return null;
  const shown = opts.cap !== null
    ? (db.prepare(
        `SELECT payload FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' AND seq > ?
         ORDER BY seq DESC LIMIT ?`
      ).all(sessionId, key, watermark, opts.cap) as { payload: string }[]).map(r => JSON.parse(r.payload) as TurnDigest).reverse()
    : storedDigests(db, sessionId, key, watermark).map(d => d.digest);
  const earlier = total - shown.length;
  const date = (readSessionDoc(db, sessionId, key, "handoff")?.createdAt ?? now).slice(0, 10);
  const write = upsertSessionDoc(db, {
    sessionId, transcriptKey: key, kind: "handoff", title: `Handoff ${date}`,
    body: renderHandoffBody(sessionId, date, summary, shown, earlier), now,
  });
  const complete = earlier === 0 && write.action !== "refused-fs" && write.action !== "no-path";
  db.prepare(
    `UPDATE session_docs SET render_needed = ?${opts.endedAt ? ", ended_at = ?" : ""}
     WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff'`
  ).run(...[complete ? 0 : 1, ...(opts.endedAt ? [opts.endedAt] : []), sessionId, key]);
  return { write, complete };
}

// ── Summary step ────────────────────────────────────────────────────────────────────────────────────────────────

/** The next batch past the watermark: at least one digest, then more while the prompt stays inside the bound. */
function packDigestBatch(previous: HandoffSummaryItem | null, pending: readonly StoredDigest[]): { batch: StoredDigest[]; used: number } {
  let used = previous ? renderSummaryText(previous.summary).length : 0;
  const batch: StoredDigest[] = [];
  for (const d of pending) {
    const len = renderDigestLine(d.digest, batch.length + 1).length + 1;
    if (batch.length > 0 && used + len > OBSERVER_MAX_RENDER_CHARS) break;
    batch.push(d);
    used += len;
  }
  return { batch, used };
}

/**
 * The text of the batch's latest turns that still fit, re-read by the digests' byte ranges. A range whose bytes no
 * longer match its `range_sha` (a rewritten or replaced file) contributes its digest only.
 */
function recentTurnText(path: string | null, batch: readonly StoredDigest[], budget: number): string {
  if (!path || !existsSync(path) || budget <= 0) return "";
  let msgs: TranscriptMessage[] = [];
  for (let i = batch.length - 1; i >= 0; i--) {
    const d = batch[i]!;
    if (rangeSha(path, d.rangeFrom, d.rangeTo) !== d.rangeSha) {
      console.error(`[handoff-generator] turn at ${d.fp}: its bytes changed since the digest — summarised from the digest only`);
      continue;
    }
    // Bounded whatever the turn's size (T24): its accumulated messages, never its raw bytes at once.
    const turnRead = accumulateLines(path, d.rangeFrom, { stopAtNextHuman: false, to: d.rangeTo, releaseTrailingCommand: true });
    const next = [...accumulatedMessages(turnRead.acc), ...msgs];
    if (observerRenderChars(next) > budget) break;
    msgs = next;
  }
  return msgs.length > 0 ? prepareTranscript(msgs) : "";
}

function recordSummaryFailure(db: Database, sessionId: string, key: string, reason: string): void {
  try {
    db.prepare(
      `UPDATE stop_cursors SET retry_count = retry_count + 1, last_error = ?, first_failed_at = COALESCE(first_failed_at, ?)
       WHERE session_id = ? AND hook = ? AND transcript_key = ?`
    ).run(`summary: ${reason}`, isoNow(), sessionId, HANDOFF_HOOK, key);
  } catch { /* the audit is best-effort; nothing else changes */ }
}

export type SummaryArgs = {
  sessionId: string;
  transcriptKey: string;
  deadline: MonoDeadline;
  /** Test seam: runs between a batch's Phase A and its Phase B. */
  beforePhaseB?: () => void;
};

export type SummaryRun = { batches: number; committed: number; failed: boolean; discarded: boolean };

/** The summary step: throttled, ordered batches past the watermark, each Phase A → Phase B, while the budget allows. */
export async function runHandoffSummary(store: Store, args: SummaryArgs): Promise<SummaryRun> {
  const run: SummaryRun = { batches: 0, committed: 0, failed: false, discarded: false };
  const db = store.db;
  const { sessionId, transcriptKey: key } = args;
  if (!stopPipelineReady(db)) return run;
  let cursor = readStopCursor(db, sessionId, HANDOFF_HOOK, key);
  if (!cursor || !handoffAdmitted(db, sessionId, key)) return run;
  let pending = storedDigests(db, sessionId, key, cursor.summaryThrough ?? 0, SUMMARY_PAGE);
  if (pending.length === 0) return run;
  const due = pending.length >= SUMMARY_MIN_DIGESTS || !cursor.lastOutputAt
    || epochMs(epochNow()) - Date.parse(cursor.lastOutputAt) >= SUMMARY_MIN_INTERVAL_MS;
  if (!due) return run;

  while (pending.length > 0) {
    const remaining = remainingForTimeout(deadlineBefore(args.deadline, duration(PERSIST_RESERVE_MS)));
    if (remaining === null || shorterThan(remaining, duration(CAUSAL_MIN_BUDGET_MS))) break;
    // Phase A — the model; no memory writes.
    const previous = readHandoffSummary(db, sessionId, key);
    // The character pack is an upper bound; v0.41.2 fits the batch in TOKENS (design §1.5) — the recent text goes
    // first, then digests from the end, and the watermark moves only past the digests the summary used.
    const { batch: packed, used } = packDigestBatch(previous, pending);
    const recent = recentTurnText(cursor.transcriptPath, packed, OBSERVER_MAX_RENDER_CHARS - used);
    run.batches++;
    const r = await extractSummaryFitted(previous?.summary ?? null, packed.map(d => d.digest), recent, { deadline: args.deadline });
    if (r.status === "retryable") {
      recordSummaryFailure(db, sessionId, key, r.reason);
      run.failed = true;
      break;
    }
    const batch = packed.slice(0, r.digestsUsed);
    args.beforePhaseB?.();
    // Phase B — the watermark CAS, the summary, the prune, the render: one transaction.
    const through = batch.at(-1)!.seq;
    const readThrough = cursor.summaryThrough;
    const now = isoNow();
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE stop_cursors SET summary_through = ?, last_output_at = ?, retry_count = 0, last_error = NULL, first_failed_at = NULL
           WHERE session_id = ? AND hook = ? AND transcript_key = ? AND summary_through IS ?`
        ).run(through, now, sessionId, HANDOFF_HOOK, key, readThrough);
        if (lastChanges(db) !== 1) throw new WatermarkMoved();
        const item: HandoffSummaryItem = {
          summary: r.summary,
          files: mergeFiles(previous?.files ?? [], batch.flatMap(d => d.digest.files), SUMMARY_FILES_MAX),
          through,
        };
        db.prepare(`DELETE FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff-summary'`).run(sessionId, key);
        insertStopItem(db, {
          sessionId, transcriptKey: key, kind: "handoff-summary", fp: "current", payload: item,
          anchorEpoch: cursor!.anchorEpoch, seq: through,
        });
        // Rows are immutable: a turn re-digested meanwhile has a new seq past the watermark and is kept.
        db.prepare(`DELETE FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = 'turn-digest' AND seq <= ?`)
          .run(sessionId, key, through);
        renderHandoffDoc(db, sessionId, key, { cap: null, now });
      }).immediate();
    } catch (err) {
      if (err instanceof WatermarkMoved) { run.discarded = true; break; }   // another writer summarised this stretch
      throw err;
    }
    run.committed++;
    cursor = readStopCursor(db, sessionId, HANDOFF_HOOK, key)!;
    pending = storedDigests(db, sessionId, key, cursor.summaryThrough ?? 0, SUMMARY_PAGE);
  }
  return run;
}

// ── SessionEnd ──────────────────────────────────────────────────────────────────────────────────────────────────

export type SessionEndArgs = {
  sessionId: string;
  transcriptPath?: string;
  host?: string;
  sessionKey?: string;
  deadline?: MonoDeadline;
};

/**
 * The SessionEnd flush (render only): per transcript of the session (the one named, else every one it has), the
 * summary + the latest 20 digests past the watermark, when a render is owed; `ended_at` recorded in the same write.
 * A busy vault leaves `render_needed` set for the worker. Returns the transcripts rendered.
 */
export function flushHandoffAtSessionEnd(store: Store, args: SessionEndArgs): { rendered: number; incomplete: number } {
  const out = { rendered: 0, incomplete: 0 };
  const db = store.db;
  if (!args.sessionId || !stopPipelineReady(db)) return out;
  const path = locatorPath(args.transcriptPath);
  if (path && existsSync(path)) registerTranscript(db, args.sessionId, path, stopHostOf(args.host), args.sessionKey ?? null);
  const keys = path ? [transcriptKey(path)] : (db.prepare(
    `SELECT transcript_key FROM session_docs WHERE session_id = ? AND kind = 'handoff'
     UNION SELECT transcript_key FROM stop_cursors WHERE session_id = ? AND hook = ?`
  ).all(args.sessionId, args.sessionId, HANDOFF_HOOK) as { transcript_key: string }[]).map(r => r.transcript_key);
  // One write transaction (a busy vault costs one wait): the session end on the locator — its transcripts'
  // provisional feedback verdicts can become final (T23 #1) — and each transcript's owed render, bounded by its display.
  try {
    db.transaction(() => {
      const now = isoNow();
      db.prepare(`UPDATE session_transcripts SET ended_at = ? WHERE session_id = ?${path ? " AND transcript_key = ?" : ""} AND ended_at IS NULL`)
        .run(...[now, args.sessionId, ...(path ? [transcriptKey(path)] : [])]);
      for (const key of keys) {
        if (args.deadline && isExpired(args.deadline)) break;   // the rest keep their marker for the worker
        const row = readSessionDoc(db, args.sessionId, key, "handoff");
        if (!row) continue;
        if (row.renderNeeded || row.docId === null) {
          const r = renderHandoffDoc(db, args.sessionId, key, { cap: SESSION_END_DISPLAY_DIGESTS, now, endedAt: now });
          if (r) { out.rendered++; if (!r.complete) out.incomplete++; continue; }
        }
        db.prepare(`UPDATE session_docs SET ended_at = ? WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff'`)
          .run(now, args.sessionId, key);
      }
    }).immediate();
  } catch (err) {
    out.rendered = 0;
    out.incomplete = 0;
    console.error(`[handoff-generator] SessionEnd flush skipped (${err instanceof Error ? err.message : String(err)}) — the worker renders it`);
  }
  return out;
}

/** The session_log line for a transcript: its summary's opening request, else its earliest stored digest's. */
export function handoffSessionLine(db: Database, sessionId: string, key: string): { summary: string; files: string[] } | null {
  const s = readHandoffSummary(db, sessionId, key);
  const d = storedDigests(db, sessionId, key, s?.through ?? 0, SUMMARY_PAGE);
  const request = s && s.summary.request !== "Unknown" && s.summary.request !== "None" ? s.summary.request : d[0]?.digest.request ?? "";
  if (!s && d.length === 0) return null;
  return { summary: clip(request, 100), files: mergeFiles(s?.files ?? [], d.flatMap(x => x.digest.files), SUMMARY_FILES_MAX) };
}
