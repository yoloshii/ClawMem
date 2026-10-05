/**
 * 62.1 D2: the durable transcript cursor of each Stop hook, per (session id, hook, transcript key).
 *
 * A hook reads the transcript DELTA from its cursor's byte offset — complete lines only, at most 64 MB per run — and
 * advances the cursor only through what it actually processed, by a compare-and-swap on the position it read from
 * (inside its Phase B transaction). Before a cursor is trusted, the file is checked to be the one it was taken on:
 * the same (dev, ino), the same first line, a size at least the offset, and the line ending at the offset hashing to
 * the recorded tail. Any mismatch — a replaced, truncated or rewritten transcript — re-anchors at the current turn with
 * `anchor_epoch + 1`, so every identity derived from a range (D3 `range_key`, D5 digest keys) changes with the file's
 * generation. Without a cursor (a hook's first Stop, or the first after the upgrade) the read anchors at the current
 * turn's start: history before the upgrade is not replayed. (A Hermes transcript begun after the upgrade is the
 * exception: it starts at its first line, `freshStart`.)
 *
 * The local-command rule of `readTranscriptTurns` holds across batches: a built-in command's record is followed by its
 * local output, so a command record whose successor has not been read yet is held back — the read ends before it.
 * 72.4: a turn opens at a human line or at an opening notice (`opensTurn`), and a command record its writer marked as
 * opening a turn (`turnOrigin: "human"`) is a prompt command, never held back.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "fs";
import { createHash, type Hash } from "crypto";
import type { Database } from "bun:sqlite";
import {
  classifyTranscriptRow,
  opensTurn,
  renderTranscriptContent,
  LOCAL_COMMAND_OUTPUT_RE,
  type TranscriptNotice,
  type TranscriptTurnKind,
} from "./hooks.ts";
import { parseEntryTime, type StopHost } from "./stop-pairing.ts";
import { lastChanges, STOP_SCHEMA_MARKER } from "./stop-schema.ts";
import { isExpired, type MonoDeadline } from "./clock.ts";

/** The most bytes of complete lines one read returns (D2). */
export const STOP_READ_MAX_BYTES = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The tail hash of an empty processed prefix (a cursor at offset 0). */
export const EMPTY_LINE_SHA = sha256("");

export type TranscriptToolUse = { name: string; input: Record<string, unknown> };

export type TranscriptLine = {
  /** Byte offset of the line's first byte, and of the byte after its '\n'. */
  start: number;
  end: number;
  /** sha256 of the line's bytes, '\n' excluded. */
  sha: string;
  /** The entry's timestamp in epoch ms (the line's own, else its message's); null when it carries none. */
  ts: number | null;
  kind: TranscriptTurnKind;
  /** Human: the typed text (a prompt command's task, "/name" without arguments); assistant: its text blocks; notice: its label. */
  text: string;
  /** The message content rendered as text (tool calls and results included); a notice: its label only. */
  rendered: string;
  /** A slash-command record, with or without arguments (whether it is a turn depends on its successor). */
  command?: true;
  /** A slash command without arguments ("/name"): it opens a turn but holds no request content (72.4). */
  bareCommand?: true;
  /**
   * A command record its writer marked as opening a turn (`turnOrigin: "human"`): a prompt command, so it is never held
   * back waiting for its successor (72.4). Local output after it still demotes it.
   */
  promptCommand?: true;
  /** Input the user did not type as a turn-opening prompt (72.4): a task's notice, a peer's message, queued input. */
  notice?: TranscriptNotice;
  /** Assistant tool calls (name + input), for digests (files touched). */
  toolUses?: TranscriptToolUse[];
  /** A line larger than one read's bound, passed over unparsed so the cursor can advance. */
  oversized?: true;
  /**
   * Local-command output that classifies a preceding command record: an oversized line whose kept prefix shows it
   * (T26 #3), or a `system`/`local_command` row (newer writers, 72.4).
   */
  localOutput?: true;
  /**
   * Claude Code's record that a turn ended: the Stop hooks' summary (a `stop_hook_summary` WITHOUT a `hookLabel` —
   * tool hooks' summaries carry "PreToolUse" / "PostToolUse", T26 #1) or a `turn_duration` entry. Written even when a
   * Stop hook died (T25 #1).
   */
  stopMarker?: true;
  /**
   * On a Hermes user line: the prefetch the plugin handed this turn — the id of the context-surfacing row whose context
   * it was (null: none, e.g. a late result it dropped) and when the hand-over happened (T29). Absent when the plugin
   * made no prefetch call for the turn (Hermes skips trivial prompts) or could not match the call to the turn.
   */
  delivery?: { usageId: number | null; at: number | null };
  /**
   * The Hermes plugin's record that a prefetch's row is settled without a recipient turn: `dropped` (never handed
   * over) or `unresolved` (handed over, to a turn that cannot be proved). Identified by the row's id (T30).
   */
  prefetchOutcome?: { usageId: number; outcome: "dropped" | "unresolved" };
};

/** The `type` of the Hermes plugin's prefetch-outcome lines (src/hermes/__init__.py `_record_outcome`). */
export const HERMES_OUTCOME_TYPE = "clawmem-prefetch-outcome";

export type LineRead = {
  lines: TranscriptLine[];
  /** Offset after the last returned line — where the next read starts (a held-back command record starts here). */
  next: number;
  /** True when the read stopped at the end of complete lines rather than at its byte bound. */
  eof: boolean;
  /** True when it stopped at its byte bound: more complete lines follow `next` (T23 #3 — a turn larger than one read). */
  bounded: boolean;
};

type RawLine = { start: number; end: number; bytes: Buffer | null; sha: string; prefix?: Buffer };

/** Bytes of an oversized line kept for classification (T26 #3). */
const OVERSIZED_PREFIX_BYTES = 64 * 1024;
/** Local-command output at the start of a message's content, in raw JSON (whitespace escaped or not). */
const LOCAL_OUTPUT_JSON_RE = /"(?:content|text)"\s*:\s*"(?:\\[nrt]|\s)*<local-command-(?:stdout|stderr)>/;

/**
 * The TOP-LEVEL string fields named in `keys`, read from the first bytes of a JSON object (an oversized line's prefix)
 * as far as they reach: nested values are skipped whole, and a field the prefix cuts off is not read. Keys and values
 * are decoded as JSON strings (`"sys\u0074em"` reads `system`, as the parsed classifier sees it — codex CODE T2-1); a
 * token that does not decode ends the scan.
 */
function topLevelStringFields(json: string, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const n = json.length;
  let i = 0;
  const ws = () => { while (i < n && /\s/.test(json[i]!)) i++; };
  /** Move `i` past the string whose opening quote is at `i`; false when the prefix ends inside it. */
  const pass = (): boolean => {
    i++;
    while (i < n) {
      const c = json[i]!;
      if (c === "\\") { i += 2; continue; }
      i++;
      if (c === '"') return true;
    }
    return false;
  };
  /** The decoded string whose opening quote is at `i`, leaving `i` past it; null when it is cut off or does not decode. */
  const str = (): string | null => {
    const from = i;
    if (!pass()) return null;
    try {
      const v: unknown = JSON.parse(json.slice(from, i));
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  /** Skip the value at `i`; false when the prefix ends inside it. */
  const skip = (): boolean => {
    if (json[i] === '"') return pass();
    if (json[i] === "{" || json[i] === "[") {
      let depth = 0;
      while (i < n) {
        const c = json[i]!;
        if (c === '"') { if (!pass()) return false; continue; }
        i++;
        if (c === "{" || c === "[") depth++;
        else if ((c === "}" || c === "]") && --depth === 0) return true;
      }
      return false;
    }
    while (i < n && !/[,}\]\s]/.test(json[i]!)) i++;
    return i < n;
  };
  ws();
  if (json[i] !== "{") return out;
  i++;
  while (true) {
    ws();
    if (json[i] !== '"') return out;
    const key = str();
    ws();
    if (key === null || json[i] !== ":") return out;
    i++;
    ws();
    if (json[i] === '"' && keys.includes(key)) {
      const value = str();
      if (value === null) return out;
      out.set(key, value);
    } else if (!skip()) return out;
    ws();
    if (json[i] !== ",") return out;
    i++;
  }
}

/**
 * An oversized line's prefix shows a built-in command's output: a user row whose content starts with
 * `<local-command-stdout|stderr>`, or a top-level `system`/`local_command` envelope whatever its content (codex CODE
 * T1-2; P18: Claude Code writes `type` and `subtype` before `content`, and 22 of 60 such rows are unwrapped).
 */
function prefixShowsLocalOutput(prefix: string): boolean {
  if (LOCAL_OUTPUT_JSON_RE.test(prefix)) return true;
  const f = topLevelStringFields(prefix, ["type", "subtype"]);
  return f.get("type") === "system" && f.get("subtype") === "local_command";
}

function scanRawLines(fd: number, from: number, limit: number, maxBytes: number): { lines: RawLine[]; next: number; eof: boolean } {
  const lines: RawLine[] = [];
  const buf = Buffer.allocUnsafe(CHUNK);
  // The line being assembled: its parts, or — once it outgrows one read's bound — only a running hash of it.
  const cur = { start: from, parts: [] as Buffer[], len: 0, big: null as Hash | null, prefix: undefined as Buffer | undefined };
  const add = (b: Buffer) => {
    if (cur.big) { cur.big.update(b); return; }
    cur.parts.push(Buffer.from(b));
    cur.len += b.length;
    if (cur.len > maxBytes) {
      cur.prefix = Buffer.concat(cur.parts, cur.len).subarray(0, OVERSIZED_PREFIX_BYTES);
      cur.big = createHash("sha256");
      for (const p of cur.parts) cur.big.update(p);
      cur.parts = [];
      cur.len = 0;
    }
  };
  let pos = from;
  let total = 0;
  while (pos < limit) {
    const n = readSync(fd, buf, 0, Math.min(CHUNK, limit - pos), pos);
    if (n <= 0) break;
    let i = 0;
    while (i < n) {
      const rel = buf.subarray(i, n).indexOf(0x0a);
      if (rel < 0) { add(buf.subarray(i, n)); break; }
      add(buf.subarray(i, i + rel));
      const end = pos + i + rel + 1;
      const len = end - cur.start;
      if (total + len > maxBytes && lines.length > 0) return { lines, next: cur.start, eof: false };
      if (cur.big) {
        lines.push({ start: cur.start, end, bytes: null, sha: cur.big.digest("hex"), prefix: cur.prefix });
      } else {
        const bytes = Buffer.concat(cur.parts, cur.len);
        lines.push({ start: cur.start, end, bytes, sha: sha256(bytes) });
      }
      total += len;
      cur.start = end;
      cur.parts = [];
      cur.len = 0;
      cur.big = null;
      cur.prefix = undefined;
      i += rel + 1;
      if (total >= maxBytes) return { lines, next: cur.start, eof: cur.start >= limit };
    }
    pos += n;
  }
  return { lines, next: cur.start, eof: true };   // trailing bytes without '\n' are an incomplete line: not read
}

function classifyRawLine(raw: RawLine): TranscriptLine {
  const base = { start: raw.start, end: raw.end, sha: raw.sha };
  if (!raw.bytes) {
    const local = raw.prefix !== undefined && prefixShowsLocalOutput(raw.prefix.toString("utf8"));
    return { ...base, ts: null, kind: "meta", text: "", rendered: "", oversized: true, ...(local ? { localOutput: true as const } : {}) };
  }
  let entry: any;
  try {
    entry = JSON.parse(raw.bytes.toString("utf8"));
  } catch {
    return { ...base, ts: null, kind: "meta", text: "", rendered: "" };
  }
  const msg = entry?.message ?? entry;
  const ts = parseEntryTime(entry?.timestamp) ?? parseEntryTime(msg?.timestamp);
  // A subagent's (sidechain) marker ends the subagent's turn, never the main one; a tool hook's summary ends nothing.
  if (entry?.type === "system" && entry.isSidechain !== true
    && ((entry.subtype === "stop_hook_summary" && entry.hookLabel === undefined) || entry.subtype === "turn_duration")) {
    return { ...base, ts, kind: "meta", text: "", rendered: "", stopMarker: true };
  }
  if (entry?.type === HERMES_OUTCOME_TYPE) {
    const id = entry.usage_id;
    const outcome = entry.outcome === "dropped" || entry.outcome === "unresolved" ? entry.outcome : null;
    const line: TranscriptLine = { ...base, ts, kind: "meta", text: "", rendered: "" };
    if (Number.isInteger(id) && id > 0 && outcome) line.prefetchOutcome = { usageId: id, outcome };
    return line;
  }
  const c = classifyTranscriptRow(entry);
  if (!c) return { ...base, ts, kind: "meta", text: "", rendered: "" };
  const { kind, text } = c;
  // A notice is rendered as its label only (72.4 §3.3): no consumer sees a peer's body or a task's output.
  const rendered = kind === "notice" ? text : c.localOutput ? "" : renderTranscriptContent(msg.content);
  const line: TranscriptLine = { ...base, ts, kind, text, rendered };
  if (c.command) line.command = true;
  if (c.bareCommand) line.bareCommand = true;
  if (c.promptCommand) line.promptCommand = true;
  if (c.notice) line.notice = c.notice;
  if (c.localOutput) line.localOutput = true;
  const d = entry?.clawmem_delivery;
  if (kind === "human" && d && typeof d === "object") {
    const id = d.usage_id;
    line.delivery = { usageId: Number.isInteger(id) && id > 0 ? id : null, at: parseEntryTime(d.at) };
  }
  if (kind === "assistant" && Array.isArray(msg.content)) {
    const uses = msg.content
      .filter((b: any) => b && b.type === "tool_use" && typeof b.name === "string")
      .map((b: any) => ({ name: b.name as string, input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown> }));
    if (uses.length > 0) line.toolUses = uses;
  }
  return line;
}

/** A command record whose successor shows local-command output is a built-in's: a setting change, not a turn. */
function demoteCommand(l: TranscriptLine): void {
  l.kind = "meta";
  l.text = "";
  delete l.command;
  delete l.bareCommand;
}

const showsLocalOutput = (next: TranscriptLine) => LOCAL_COMMAND_OUTPUT_RE.test(next.rendered) || next.localOutput === true;

/**
 * Read the complete lines of a transcript from `from` (a line start), classified, at most `maxBytes` of them, and not
 * past `to` when given. A command record followed by local-command output is meta (a setting change, not a task); a
 * command record whose successor is not read yet is held back (`next` stops before it) unless
 * `releaseTrailingCommand` says its turn is known to be over. A read that stopped at its byte bound right after a
 * command record peeks at its successor whatever `releaseTrailingCommand` says (72.4 (e)). A prompt command its writer
 * marked as opening a turn is never held back (no successor needed); local output after it still demotes it.
 */
export function readLines(
  path: string,
  from: number,
  opts?: { maxBytes?: number; to?: number; releaseTrailingCommand?: boolean },
): LineRead {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const limit = Math.min(size, opts?.to ?? size);
    const scanned = scanRawLines(fd, from, limit, opts?.maxBytes ?? STOP_READ_MAX_BYTES);
    const lines = scanned.lines.map(classifyRawLine);
    for (let i = 0; i < lines.length - 1; i++) {
      const l = lines[i]!;
      if (l.command && showsLocalOutput(lines[i + 1]!)) demoteCommand(l);
    }
    const last = lines.at(-1);
    if (last?.command) {
      if (scanned.eof) {
        if (!opts?.releaseTrailingCommand && !last.promptCommand) {
          lines.pop();   // its successor is not written yet: held back until it is
          return { lines, next: last.start, eof: false, bounded: false };
        }
      } else {
        // The read stopped at its byte bound right after the command record: classify it by peeking at its successor
        // (as the first line of a read, an oversized successor is passed over as metadata) instead of holding it back —
        // holding it would leave `next` where the read started, and a stream would read the same bytes for ever (T25 #5).
        // Whatever `releaseTrailingCommand` says: the successor exists, so the record is classified, not released (72.4 (e)).
        const raw = scanRawLines(fd, last.end, limit, opts?.maxBytes ?? STOP_READ_MAX_BYTES).lines[0];
        const peek = raw ? classifyRawLine(raw) : null;
        if (peek && showsLocalOutput(peek)) demoteCommand(last);
      }
    }
    return { lines, next: scanned.next, eof: scanned.eof, bounded: !scanned.eof };
  } finally {
    closeSync(fd);
  }
}

export type TurnSegment = {
  /** Index (into the lines read) of the turn's opening line when it is a human line (typed); null otherwise. */
  humanIndex: number | null;
  /**
   * Index of the line that opened the turn — a human line or an opening notice (72.4); null = the lines continue a
   * turn whose opener precedes the read.
   */
  openIndex: number | null;
  start: number;
  end: number;
  lines: TranscriptLine[];
  /** True when a later opening line follows it in the read, or it is the trailing turn and the caller knows it is over (a Stop). */
  complete: boolean;
};

/** Split lines into turns at opening lines: human lines and opening notices (72.4). */
export function segmentTurns(lines: TranscriptLine[], opts: { trailingComplete: boolean }): TurnSegment[] {
  const segs: TurnSegment[] = [];
  let cur: TurnSegment | null = null;
  lines.forEach((l, i) => {
    const opens = opensTurn(l);
    if (opens || cur === null) {
      if (cur) cur.complete = true;
      cur = { humanIndex: l.kind === "human" ? i : null, openIndex: opens ? i : null, start: l.start, end: l.end, lines: [], complete: false };
      segs.push(cur);
    }
    cur.lines.push(l);
    cur.end = l.end;
  });
  const lastSeg = segs.at(-1);
  if (lastSeg) lastSeg.complete = opts.trailingComplete;
  return segs;
}

export type FileIdentity = { dev: number; ino: number; size: number; firstLineSha: string };

/** The transcript's identity: (dev, ino), size and its first line's hash. Null when it cannot be read. */
export function transcriptFileIdentity(path: string): FileIdentity | null {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino, size: st.size, firstLineSha: firstLineSha(path) };
  } catch {
    return null;
  }
}

/** sha256 of the file's first complete line (EMPTY_LINE_SHA while it has none). */
function firstLineSha(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const hash = createHash("sha256");
    for (let p = 0; p < size; p += CHUNK) {
      const chunk = readAt(fd, p, Math.min(CHUNK, size - p));
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0) { hash.update(chunk.subarray(0, nl)); return hash.digest("hex"); }
      hash.update(chunk);
    }
    return EMPTY_LINE_SHA;
  } finally {
    closeSync(fd);
  }
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const out = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, out, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return out.subarray(0, got);
}

/** sha256 of the line that ends exactly at `offset` ('\n' at offset - 1); EMPTY_LINE_SHA at 0; null when offset is no line end. */
export function lineShaEndingAt(path: string, offset: number): string | null {
  if (offset === 0) return EMPTY_LINE_SHA;
  const fd = openSync(path, "r");
  try {
    if (offset > fstatSync(fd).size || readAt(fd, offset - 1, 1)[0] !== 0x0a) return null;
    let start = 0;
    let pos = offset - 1;
    while (pos > 0) {
      const from = Math.max(0, pos - CHUNK);
      const chunk = readAt(fd, from, pos - from);
      const nl = chunk.lastIndexOf(0x0a);
      if (nl >= 0) { start = from + nl + 1; break; }
      pos = from;
    }
    const hash = createHash("sha256");
    for (let p = start; p < offset - 1; p += CHUNK) hash.update(readAt(fd, p, Math.min(CHUNK, offset - 1 - p)));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** sha256 of the bytes [from, to): a quarantined range's integrity check before a replay (D3). Null on a short file. */
export function rangeSha(path: string, from: number, to: number): string | null {
  const fd = openSync(path, "r");
  try {
    if (to > fstatSync(fd).size || from > to) return null;
    const hash = createHash("sha256");
    for (let p = from; p < to; p += CHUNK) hash.update(readAt(fd, p, Math.min(CHUNK, to - p)));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** The start of the line that ends at `hi` (a line start, > 0): the byte after the last '\n' before `hi - 1`, else 0. */
function prevLineStart(path: string, hi: number): number {
  const fd = openSync(path, "r");
  try {
    let pos = hi - 1;
    while (pos > 0) {
      const from = Math.max(0, pos - CHUNK);
      const chunk = readAt(fd, from, pos - from);
      const nl = chunk.lastIndexOf(0x0a);
      if (nl >= 0) return from + nl + 1;
      pos = from;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

function nextLineStart(path: string, pos: number): number {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    for (let p = pos; p < size; p += CHUNK) {
      const chunk = readAt(fd, p, Math.min(CHUNK, size - p));
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0) return p + nl + 1;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

export type StreamEnd = {
  /** The offset after the last line visited (a line `visit` stopped at is NOT consumed: `next` is its start). */
  next: number;
  /** The stream reached the end of complete lines (or `to`). */
  eof: boolean;
  /** `visit` returned false. */
  stopped: boolean;
  /** The deadline passed before the end. */
  expired: boolean;
};

/**
 * Stream a transcript's lines from `from` (a line start) in reads of at most `maxBytes`, calling `visit` for each line,
 * until `visit` returns false, the end of complete lines (or `to`), or `deadline`. Memory is one read, whatever the
 * length streamed (T24 #1/#5): a caller keeps only what it accumulates.
 */
export function streamLines(
  path: string,
  from: number,
  visit: (l: TranscriptLine) => boolean | void,
  opts?: { maxBytes?: number; to?: number; deadline?: MonoDeadline; releaseTrailingCommand?: boolean },
): StreamEnd {
  let pos = from;
  for (;;) {
    if (opts?.deadline && isExpired(opts.deadline)) return { next: pos, eof: false, stopped: false, expired: true };
    const r = readLines(path, pos, { maxBytes: opts?.maxBytes, to: opts?.to, releaseTrailingCommand: opts?.releaseTrailingCommand });
    for (const l of r.lines) {
      if (visit(l) === false) return { next: l.start, eof: false, stopped: true, expired: false };
    }
    pos = r.next;
    if (!r.bounded) return { next: pos, eof: r.eof, stopped: false, expired: false };
  }
}

/** Bytes a backward scan reads per step (plus the one line past it that classifies a command record at its end). */
const BACK_CHUNK = 16 * 1024 * 1024;

/**
 * The last line satisfying `pred`, scanning back from the end in bounded steps (T24: memory is one step, never the
 * whole tail — a huge current turn used to be read into memory in one piece). `tailNext`: where a forward read of the
 * file's tail stops (the end of its complete lines, before a held-back command record).
 */
function lastLineWhere(path: string, pred: (l: TranscriptLine) => boolean, releaseTrailingCommand: boolean): { line: TranscriptLine | null; tailNext: number } {
  const size = statSync(path).size;
  let hi = size;
  let tailNext = -1;
  while (hi > 0) {
    // Each step covers at least the line that ends at `hi` — a line longer than the step included (T25 #4) — so `hi`
    // strictly decreases.
    const lo = hi > BACK_CHUNK ? Math.min(nextLineStart(path, hi - BACK_CHUNK), prevLineStart(path, hi)) : 0;
    if (lo >= hi) throw new Error(`transcript scan made no progress at offset ${hi}`);
    const to = hi >= size ? size : nextLineStart(path, hi);
    const read = readLines(path, lo, { to, maxBytes: STOP_READ_MAX_BYTES + (to - lo), releaseTrailingCommand: hi >= size ? releaseTrailingCommand : true });
    if (tailNext < 0) tailNext = read.next;
    for (let i = read.lines.length - 1; i >= 0; i--) {
      const l = read.lines[i]!;
      if (l.start >= hi) continue;   // the lookahead line: it only classifies the step's last line
      if (pred(l)) return { line: l, tailNext };
    }
    if (lo === 0) break;
    hi = lo;
  }
  return { line: null, tailNext: tailNext < 0 ? 0 : tailNext };
}

/**
 * The start of the current turn: the last human line (the local-command rule applied), or the last opening notice that
 * an assistant line follows — an opener nothing has answered yet never moves the anchor past the last answered turn
 * (72.4 F1). A transcript with neither anchors after its last complete line — nothing before the anchor is processed.
 */
export function currentTurnStart(path: string): number {
  let answered = false;   // the scan runs backwards: an assistant line has been seen after the line in hand
  const r = lastLineWhere(path, l => {
    if (l.kind === "human") return true;
    if (answered && opensTurn(l)) return true;
    if (l.kind === "assistant") answered = true;
    return false;
  }, false);
  return r.line ? r.line.start : r.tailNext;
}

/**
 * Where a read covering a turn at time `t` must start (D6 attribution): the start of the last human line whose
 * timestamp is at or before `t` — Claude Code's own human entry (H.ts <= U.ts), or for OpenClaw (U.ts <= H.ts) the
 * previous turn's, so E_prev is covered too — else the file start.
 */
export function humanLineAtOrBefore(path: string, t: number): number {
  return lastLineWhere(path, l => l.kind === "human" && l.ts !== null && l.ts <= t, true).line?.start ?? 0;
}

export type StopCursor = {
  sessionId: string;
  hook: string;
  transcriptKey: string;
  transcriptPath: string;
  fileDev: number | null;
  fileIno: number | null;
  firstLineSha: string;
  anchorEpoch: number;
  nextDigestSeq: number;
  byteOffset: number;
  tailSha: string;
  turnStartOffset: number | null;
  humanTurns: number;
  summaryThrough: number | null;
  lastOutputAt: string | null;
};

export function readStopCursor(db: Database, sessionId: string, hook: string, transcriptKey: string): StopCursor | null {
  const r = db.prepare(
    `SELECT session_id, hook, transcript_key, transcript_path, file_dev, file_ino, first_line_sha, anchor_epoch,
            next_digest_seq, byte_offset, tail_sha, turn_start_offset, human_turns, summary_through, last_output_at
     FROM stop_cursors WHERE session_id = ? AND hook = ? AND transcript_key = ?`
  ).get(sessionId, hook, transcriptKey) as Record<string, any> | null;
  if (!r) return null;
  return {
    sessionId: r.session_id, hook: r.hook, transcriptKey: r.transcript_key, transcriptPath: r.transcript_path,
    fileDev: r.file_dev, fileIno: r.file_ino, firstLineSha: r.first_line_sha, anchorEpoch: r.anchor_epoch,
    nextDigestSeq: r.next_digest_seq, byteOffset: r.byte_offset, tailSha: r.tail_sha, turnStartOffset: r.turn_start_offset,
    humanTurns: r.human_turns, summaryThrough: r.summary_through, lastOutputAt: r.last_output_at,
  };
}

export type CursorStart = {
  /** The cursor as read — the CAS operand of this hook's Phase B (null: none yet). */
  cursor: StopCursor | null;
  start: number;
  anchorEpoch: number;
  reason: "cursor" | "fresh" | "re-anchor";
  /** What failed the identity check, on a re-anchor. */
  detail?: string;
  file: FileIdentity;
};

/** The first entry time of a transcript (its first timestamped line within the first 64 KB), epoch ms; null if none. */
function transcriptBeganAt(path: string): number | null {
  try {
    for (const l of readLines(path, 0, { maxBytes: 64 * 1024, releaseTrailingCommand: true }).lines) if (l.ts !== null) return l.ts;
  } catch { /* unreadable: undecidable */ }
  return null;
}

/**
 * Where a hook with no cursor starts: the current turn, so pre-upgrade history is not replayed — except for a Hermes
 * transcript begun after the stop pipeline was installed on this vault, which starts at its first line. The plugin
 * writes that file itself, one turn at a time, so nothing has processed any of it: a first pass that ran late or
 * failed would otherwise skip the turns before it (T28 #1). Claude Code keeps the current-turn rule, since a
 * `--fork-session` transcript opens with copies of its source session's entries under their original timestamps.
 */
function freshStart(db: Database, path: string, host: StopHost | undefined): number {
  if (host === "hermes") {
    const flag = db.prepare(`SELECT updated_at FROM vault_flags WHERE flag = ?`).get(STOP_SCHEMA_MARKER) as { updated_at: string | null } | null;
    const installedAt = flag?.updated_at ? Date.parse(flag.updated_at) : NaN;
    const began = transcriptBeganAt(path);
    if (Number.isFinite(installedAt) && began !== null && began >= installedAt) return 0;
  }
  return currentTurnStart(path);
}

/** Where this hook's read of the transcript starts (null when the file cannot be read). */
export function resolveCursorStart(
  db: Database, sessionId: string, hook: string, transcriptKey: string, path: string, opts?: { host?: StopHost },
): CursorStart | null {
  const file = transcriptFileIdentity(path);
  if (!file) return null;
  const cursor = readStopCursor(db, sessionId, hook, transcriptKey);
  if (!cursor) return { cursor: null, start: freshStart(db, path, opts?.host), anchorEpoch: 0, reason: "fresh", file };
  const detail =
    cursor.fileDev !== null && cursor.fileIno !== null && (cursor.fileDev !== file.dev || cursor.fileIno !== file.ino) ? "file identity (dev, ino)"
    : cursor.firstLineSha !== file.firstLineSha ? "first line"
    : file.size < cursor.byteOffset ? "truncated"
    : lineShaEndingAt(path, cursor.byteOffset) !== cursor.tailSha ? "line at the cursor"
    : null;
  if (!detail) return { cursor, start: cursor.byteOffset, anchorEpoch: cursor.anchorEpoch, reason: "cursor", file };
  return { cursor, start: currentTurnStart(path), anchorEpoch: cursor.anchorEpoch + 1, reason: "re-anchor", detail, file };
}

export type CursorAdvance = {
  transcriptPath: string;
  file: FileIdentity;
  anchorEpoch: number;
  byteOffset: number;
  tailSha: string;
  turnStartOffset: number | null;
  humanTurns: number;
  /** The handoff digest counter after this write (D5); omitted = unchanged (1 for a new cursor). */
  nextDigestSeq?: number;
};

/**
 * Advance a hook's cursor from the position it was read at (`prev`) — call inside the Phase B transaction. False when
 * another writer moved it first (the caller rolls back and discards its work). Only the position columns are written
 * and compared; the handoff summary watermark (D5) has its own CAS.
 */
export function casAdvanceCursor(
  db: Database,
  sessionId: string,
  hook: string,
  transcriptKey: string,
  prev: StopCursor | null,
  next: CursorAdvance,
): boolean {
  const seq = next.nextDigestSeq ?? prev?.nextDigestSeq ?? 1;
  if (!prev) {
    db.prepare(
      `INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, file_dev, file_ino, first_line_sha,
         anchor_epoch, next_digest_seq, byte_offset, tail_sha, turn_start_offset, human_turns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, hook, transcript_key) DO NOTHING`
    ).run(sessionId, hook, transcriptKey, next.transcriptPath, next.file.dev, next.file.ino, next.file.firstLineSha,
      next.anchorEpoch, seq, next.byteOffset, next.tailSha, next.turnStartOffset, next.humanTurns);
    return lastChanges(db) === 1;
  }
  db.prepare(
    `UPDATE stop_cursors SET transcript_path = ?, file_dev = ?, file_ino = ?, first_line_sha = ?, anchor_epoch = ?,
       next_digest_seq = ?, byte_offset = ?, tail_sha = ?, turn_start_offset = ?, human_turns = ?
     WHERE session_id = ? AND hook = ? AND transcript_key = ?
       AND byte_offset = ? AND anchor_epoch = ? AND tail_sha = ? AND next_digest_seq = ? AND turn_start_offset IS ?`
  ).run(next.transcriptPath, next.file.dev, next.file.ino, next.file.firstLineSha, next.anchorEpoch, seq, next.byteOffset,
    next.tailSha, next.turnStartOffset, next.humanTurns, sessionId, hook, transcriptKey,
    prev.byteOffset, prev.anchorEpoch, prev.tailSha, prev.nextDigestSeq, prev.turnStartOffset);
  return lastChanges(db) === 1;
}
