/**
 * ClawMem Hook Runner - stdin/stdout JSON hook dispatch for Claude Code
 *
 * Claude Code hooks send JSON on stdin and expect JSON on stdout.
 * This module provides the I/O layer and dispatches to individual hook handlers.
 */

import type { Store } from "./store.ts";
import { isoNow, toDate, epochNow } from "./clock.ts";
import { createHash } from "node:crypto";
import type { UsageIdentity } from "./stop-identity.ts";
import { promptSha } from "./stop-pairing.ts";

// =============================================================================
// Types
// =============================================================================

export type HookInput = {
  sessionId?: string;
  prompt?: string;
  transcriptPath?: string;
  hookEventName?: string;
  toolInput?: Record<string, unknown>;
  /** SessionStart: "startup" | "resume" | "clear" | "compact" (62.2 — postcompact-inject runs on "compact" only). */
  source?: string;
  /** PreCompact: "manual" | "auto". */
  trigger?: string;
  /** 62.1 D1: the host that spawned the hook — "openclaw" from the OpenClaw plugin; absent = Claude Code. */
  host?: string;
  /** 62.1 D1: OpenClaw's session key, which tells a session's base and topic transcripts apart. */
  sessionKey?: string;
  /** 62.1 D1: context-surfacing registers the transcript locator and returns before any gate, row or retrieval. */
  registerOnly?: boolean;
};

export type HookOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
  };
  /**
   * 62.1 (T29): context-surfacing's usage row, for the Hermes plugin only (`host: "hermes"`). The plugin prefetches
   * for a later turn, and writes this id on the user line of the turn it hands the context to, so the feedback step
   * credits that turn by identity. No other host receives it.
   */
  clawmemUsageId?: number;
};

// =============================================================================
// I/O
// =============================================================================

/**
 * Read hook input from stdin (Claude Code sends JSON with snake_case keys).
 * Maps snake_case → camelCase to match HookInput type.
 */
export async function readHookInput(): Promise<HookInput> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return parseHookInput(Buffer.concat(chunks).toString("utf-8"));
}

/**
 * Decode a hook's stdin JSON. Only the fields named here reach a hook (62.1 D1: `host`, `session_key` and
 * `register_only` are named, so OpenClaw's host identity survives the process boundary).
 */
export function parseHookInput(text: string): HookInput {
  const raw = text.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    return {
      sessionId: parsed.session_id ?? parsed.sessionId,
      prompt: parsed.prompt,
      transcriptPath: parsed.transcript_path ?? parsed.transcriptPath,
      hookEventName: parsed.hook_event_name ?? parsed.hookEventName,
      toolInput: parsed.tool_input ?? parsed.toolInput,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
      trigger: typeof parsed.trigger === "string" ? parsed.trigger : undefined,
      host: str(parsed.host),
      sessionKey: str(parsed.session_key ?? parsed.sessionKey),
      registerOnly: (parsed.register_only ?? parsed.registerOnly) === true,
    };
  } catch {
    return {};
  }
}

/**
 * Write hook output to stdout (Claude Code reads JSON).
 */
export function writeHookOutput(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

/**
 * Map internal hook names → Claude Code event names for hookSpecificOutput.
 * Only UserPromptSubmit and PostToolUse support additionalContext.
 * Stop/SessionStart hooks must NOT include hookSpecificOutput.
 */
const HOOK_EVENT_MAP: Record<string, string | null> = {
  "context-surfacing": "UserPromptSubmit",
  "session-bootstrap": null,       // SessionStart — no hookSpecificOutput
  "staleness-check": null,         // SessionStart — no hookSpecificOutput
  "decision-extractor": null,      // Stop — no hookSpecificOutput
  "handoff-generator": null,       // Stop — no hookSpecificOutput
  "feedback-loop": null,           // Stop — no hookSpecificOutput
  "precompact-extract": null,      // PreCompact — side-effect only, no context injection
  "postcompact-inject": "SessionStart", // SessionStart(compact) — injects additionalContext
  "curator-nudge": "SessionStart",     // SessionStart — surfaces curator report actions
  "pretool-inject": null,          // PreToolUse — disabled (cannot inject additionalContext; E13 folded into context-surfacing)
};

/**
 * Create a successful output with additional context injected into Claude's prompt.
 */
export function makeContextOutput(
  hookName: string,
  context: string
): HookOutput {
  const eventName = HOOK_EVENT_MAP[hookName];
  if (!eventName) {
    // Stop/SessionStart hooks don't support hookSpecificOutput
    return { continue: true, suppressOutput: false };
  }
  return {
    continue: true,
    suppressOutput: false,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

/**
 * Create an empty output (no context to inject).
 */
export function makeEmptyOutput(hookName?: string): HookOutput {
  const eventName = hookName ? HOOK_EVENT_MAP[hookName] : undefined;
  if (hookName && !eventName) {
    // Stop/SessionStart hooks don't support hookSpecificOutput
    return { continue: true, suppressOutput: false };
  }
  return {
    continue: true,
    suppressOutput: false,
    ...(eventName && {
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: "",
      },
    }),
  };
}

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimate token count (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// =============================================================================
// Heartbeat / Dedupe Suppression (IO4)
// =============================================================================

const DEFAULT_HEARTBEAT_SUBSTRINGS = [
  "heartbeat",
  "health check",
  "keepalive",
  "keep-alive",
  "status check",
  "are you alive",
  "still alive",
  "ping",
  "pong",
];

function getHeartbeatSubstrings(): string[] {
  const raw = (Bun.env.CLAWMEM_HEARTBEAT_PATTERNS || "").trim();
  const extra = raw
    ? raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...DEFAULT_HEARTBEAT_SUBSTRINGS, ...extra]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function isHeartbeatPrompt(prompt: string): boolean {
  if (Bun.env.CLAWMEM_DISABLE_HEARTBEAT_SUPPRESSION === "true") return false;
  const p = (prompt || "").trim().toLowerCase();
  if (!p) return true;
  if (p.startsWith("/")) return true;

  // Exact tiny pings.
  if (p === "ping" || p === "pong" || p === "heartbeat") return true;

  // Word-boundary matching, not bare substring inclusion: a bare
  // `includes("ping")` classified every real prompt containing "scoping" /
  // "mapping" / "shipping" / "typing" as a heartbeat, silently dropping that
  // turn's vault context AND its context_usage row (which also broke
  // multi-turn lookback for the turns after it). Found by the BUILD-0 hook
  // replay harness on its first run against a real prompt.
  const subs = getHeartbeatSubstrings();
  return subs.some(s => hasWordBoundedOccurrence(p, s));
}

/** True when `needle` occurs in `haystack` with no letter/digit directly on either side. */
function hasWordBoundedOccurrence(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    if (!isWordChar(haystack[idx - 1]) && !isWordChar(haystack[idx + needle.length])) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

export function wasPromptSeenRecently(store: Store, hookName: string, prompt: string): boolean {
  const windowSecRaw = (Bun.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC || "").trim();
  const windowSec = windowSecRaw ? parseInt(windowSecRaw, 10) : 600;
  if (!Number.isFinite(windowSec) || windowSec <= 0) return false;

  const normalized = (prompt || "").trim();
  if (!normalized) return false;

  const hash = createHash("sha256").update(normalized).digest("hex");
  const now = toDate(epochNow());
  const nowIso = now.toISOString();

  const row = store.db
    .prepare("SELECT last_seen_at FROM hook_dedupe WHERE hook_name = ? AND prompt_hash = ? LIMIT 1")
    .get(hookName, hash) as { last_seen_at: string } | null;

  let recent = false;
  if (row?.last_seen_at) {
    const lastMs = Date.parse(row.last_seen_at);
    if (!Number.isNaN(lastMs)) {
      recent = (now.getTime() - lastMs) < windowSec * 1000;
    }
  }

  const preview = normalized.slice(0, 120);
  // Best-effort dedup bookkeeping. Under writer contention this UPSERT can hit
  // SQLITE_BUSY — especially from the context-surfacing hook, which caps its
  // busy_timeout low (B3) so its own writes cannot stall the tight
  // UserPromptSubmit budget. A failed write only means the next identical
  // prompt won't be suppressed; it is never a reason to throw and abort the
  // hook. The `recent` verdict comes from the READ above (WAL-safe, does not
  // wait on the write lock), so same-prompt dedup still works when the row
  // already exists even if this refresh write is skipped.
  try {
    store.db.prepare(`
      INSERT INTO hook_dedupe (hook_name, prompt_hash, prompt_preview, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(hook_name, prompt_hash) DO UPDATE SET
        prompt_preview = excluded.prompt_preview,
        last_seen_at = excluded.last_seen_at
    `).run(hookName, hash, preview, nowIso);
  } catch {
    /* best-effort: contended/failed dedup write must never abort the hook */
  }

  return recent;
}

// =============================================================================
// Transcript Parsing
// =============================================================================

export type TranscriptMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  /**
   * v0.41.2 (BACKLOG 68.5): the message's turn within its Stop-pipeline unit, and whether it is the human entry that
   * opens that turn — set from the transcript's line kinds (a tool result is `role: "user"` too, so `role` cannot tell
   * them apart). Only the observer's windows read them; every other consumer ignores them.
   */
  turn?: number;
  opening?: boolean;
};

/**
 * The non-empty JSONL lines at the tail of a transcript. Throws on I/O errors (callers catch).
 * Shared by `readTranscript` and `readTranscriptTurns` so both see the same window.
 */
function readTranscriptTailLines(transcriptPath: string, lastN: number): string[] {
  const fs = require("fs");
  const stat = fs.statSync(transcriptPath);
  let content: string;

  // For large transcripts (>10MB), read backwards in chunks until we have enough lines
  if (stat.size > 10 * 1024 * 1024) {
    const chunkSize = 2 * 1024 * 1024; // 2MB chunks
    const maxChunks = 5; // Up to 10MB of tail
    const targetLines = lastN * 3; // Overshoot — not all lines are role messages
    const buffers: Buffer[] = [];
    let totalRead = 0;

    // Accumulate raw Buffers (decode once after assembly to avoid UTF-8 boundary corruption)
    const fd = fs.openSync(transcriptPath, "r");
    try {
      for (let chunk = 0; chunk < maxChunks; chunk++) {
        const readSize = Math.min(chunkSize, stat.size - totalRead);
        if (readSize <= 0) break;
        const offset = Math.max(0, stat.size - totalRead - readSize);
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, offset);
        buffers.unshift(buf);
        totalRead += readSize;

        // Check line count on decoded text to see if we have enough
        const decoded = Buffer.concat(buffers).toString("utf-8");
        if (decoded.split("\n").length >= targetLines) break;
      }
    } finally {
      fs.closeSync(fd);
    }

    const assembled = Buffer.concat(buffers).toString("utf-8");
    // Drop first partial line (we likely started mid-line)
    const firstNewline = assembled.indexOf("\n");
    content = firstNewline > 0 ? assembled.slice(firstNewline + 1) : assembled;
  } else {
    content = fs.readFileSync(transcriptPath, "utf-8");
  }

  return content.split("\n").filter((l: string) => l.trim());
}

/**
 * An entry's content as one string: text blocks verbatim, tool_use / tool_result blocks rendered
 * inline. This is the rendering the Stop hooks consume through `readTranscript`.
 */
export function renderTranscriptContent(content: any): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((b: any) => {
            if (b.type === "text") return b.text;
            if (b.type === "tool_use") return `[tool_use name="${b.name}" id="${b.id}"] ${JSON.stringify(b.input ?? {})}`;
            if (b.type === "tool_result") return `[tool_result id="${b.tool_use_id}"] ${typeof b.content === "string" ? b.content.slice(0, 500) : ""}`;
            return "";
          })
          .filter((s: string) => s)
          .join("\n")
      : JSON.stringify(content);
}

/**
 * Read and parse a Claude Code transcript (.jsonl file).
 * Returns the last N messages.
 */
export function readTranscript(
  transcriptPath: string,
  lastN: number = 200,
  roleFilter?: "user" | "assistant"
): TranscriptMessage[] {
  try {
    const lines = readTranscriptTailLines(transcriptPath, lastN);
    const messages: TranscriptMessage[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Claude Code transcript: {type, message: {role, content}} or flat {role, content}
        const msg = entry.message ?? entry;
        if (msg.role && msg.content) {
          const role = msg.role as TranscriptMessage["role"];
          const text = renderTranscriptContent(msg.content);

          if (!roleFilter || role === roleFilter) {
            messages.push({ role, content: text });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages.slice(-lastN);
  } catch {
    return [];
  }
}

/**
 * What an entry IS, as opposed to its role. Claude Code writes tool results, skill expansions,
 * slash-command records, local-command output, task notifications and compact summaries as
 * user-ROLE entries; only `human` is something the user typed. 72.4: `notice` is input the user did not type as a
 * turn-opening prompt — a background task's notice, another session's message, input received while the model worked.
 */
export type TranscriptTurnKind = "human" | "assistant" | "tool_result" | "meta" | "notice";

/** Where a notice came from (72.4). */
export type NoticeSource = "task" | "peer" | "other" | "queued-prompt" | "queued-unknown";

export type TranscriptNotice = {
  source: NoticeSource;
  /**
   * Whether the notice opens a turn: a row on a writer that records openers by its `turnOrigin`, a row on an older
   * writer by its shape. Input queued while the model worked never opens one.
   */
  opens: boolean;
  /** `queued-prompt` only: the user's own words (the prompt's text blocks, bounded). */
  typedText?: string;
  /**
   * An opening notice ROW only: `promptSha` of the text the prompt hook receives for it — for pairing usage rows with
   * the turn (72.4 F7). Never stored, rendered or logged.
   */
  identitySha?: string;
};

/**
 * Bump with any change to how a transcript row is classified — its kind, whether it opens a turn, its rendering. The
 * observer checkpoint contract and the handoff turn digests carry it, so state derived under an older classifier is
 * re-derived (72.4 §4). v0.43.0: 2.
 */
export const TRANSCRIPT_CLASSIFIER_REVISION = 2;

export type TranscriptTurn = {
  role: string;
  kind: TranscriptTurnKind;
  /**
   * Assistant: text blocks only (no tool_use rendering). Human: the typed text with host-injected
   * context blocks stripped, or "/name args" ("/name" without arguments) for a slash command. Notice: its label.
   * Others: "".
   */
  text: string;
  /** The same entry as `readTranscript` renders it (a notice: its label). */
  rendered: string;
  /** Set on a slash command's record (with or without arguments); whether it is a turn depends on its successor. */
  command?: true;
  /** A slash command without arguments ("/name"): it opens a turn but holds no request content. */
  bareCommand?: true;
  notice?: TranscriptNotice;
  /** A `system`/`local_command` row: a built-in command's output, as newer writers record it. */
  localOutput?: true;
};

/** A turn opens at a human line or at an opening notice (72.4). */
export function opensTurn(l: { kind: TranscriptTurnKind; notice?: TranscriptNotice }): boolean {
  return l.kind === "human" || (l.kind === "notice" && l.notice?.opens === true);
}

/**
 * The top-level blocks of `text` when it is nothing but one or more complete tag-wrapped blocks
 * (whitespace between them); null otherwise. Linear scan, no backtracking regex over user text.
 */
function topLevelBlocks(text: string): { tag: string; inner: string }[] | null {
  const blocks: { tag: string; inner: string }[] = [];
  let i = 0;
  const n = text.length;
  while (true) {
    while (i < n && /\s/.test(text[i]!)) i++;
    if (i >= n) return blocks.length > 0 ? blocks : null;
    const open = /^<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/.exec(text.slice(i, i + 200));
    if (!open) return null;
    const tag = open[1]!;
    const innerStart = i + open[0].length;
    const close = text.indexOf(`</${tag}>`, innerStart);
    if (close < 0) return null;
    blocks.push({ tag, inner: text.slice(innerStart, close) });
    i = close + tag.length + 3;
  }
}

/**
 * The records Claude Code writes as user-role entries on the user's behalf, by their top-level tag:
 * slash-command records, local-command output and its caveat, task notifications, bash-mode I/O,
 * `#` memory input, and system reminders. An entry is a host record only when EVERY top-level block
 * is one of these; anything else (a prompt made of the user's own markup, `<task>…</task>`) is typed
 * text. A wrapper the host introduces later reads as typed text until it is added here.
 */
export const HOST_RECORD_TAGS: ReadonlySet<string> = new Set([
  "command-name", "command-message", "command-args",
  "local-command-stdout", "local-command-stderr", "local-command-caveat",
  "task-notification",
  "bash-input", "bash-stdout", "bash-stderr",
  "user-memory-input",
  "system-reminder",
]);

/**
 * A slash-command record's task: "/name args", or "/name" (bare) for a record without arguments (72.4). `null` = a
 * record without a name, or `/compact`, whose arguments are compaction instructions. Only TOP-LEVEL `command-name` /
 * `command-args` blocks count.
 */
function commandTask(blocks: { tag: string; inner: string }[]): { text: string; bare: boolean } | null {
  const name = blocks.find(b => b.tag === "command-name")?.inner.trim();
  if (!name || name === "/compact") return null;
  const args = blocks.find(b => b.tag === "command-args")?.inner.trim() ?? "";
  return args ? { text: `${name} ${args}`, bare: false } : { text: name, bare: true };
}

/** Context blocks a host may prepend to the user's prompt (ClawMem's own, and system reminders). */
const INJECTED_BLOCK_RE = /<(vault-[a-z-]+|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g;

function transcriptTextBlocks(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

/** What a classifier decided about one transcript row. */
export type EntryClass = {
  kind: TranscriptTurnKind;
  /** Human: the typed text or the command's task; assistant: its text blocks; notice: its label; others: "". */
  text: string;
  command?: true;
  bareCommand?: true;
  /**
   * A command record its writer marked as opening a turn (`turnOrigin: "human"`): a prompt command, never held back
   * waiting for its successor. Local output after it still demotes it.
   */
  promptCommand?: true;
  notice?: TranscriptNotice;
  localOutput?: true;
};

/** Claude Code records which row opens a turn (`turnOrigin`) from this version on (72.4 §1 P3). */
const OPENER_RECORDING_VERSION = [2, 1, 278] as const;
const TURN_ORIGIN_RE = /^[a-z_]{1,40}$/;
/** The fixed text Claude Code puts before another session's `<cross-session-message>` element. */
const PEER_PREAMBLE = "Another Claude session sent a message:";
const PEER_OPEN = "<cross-session-message";
const PEER_CLOSE = "</cross-session-message>";
const TASK_LABEL_CHARS = 300;
const PEER_NAME_CHARS = 80;
const TYPED_TEXT_CHARS = 2_000;

function writerRecordsOpeners(version: unknown): boolean {
  const m = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== OPENER_RECORDING_VERSION[i]) return v[i]! > OPENER_RECORDING_VERSION[i]!;
  return true;
}

function originOf(entry: any): Record<string, any> | null {
  const o = entry?.origin;
  return o && typeof o === "object" && !Array.isArray(o) ? o : null;
}

/** At most `max` UTF-16 units of `text`, one fewer when the cut would leave half of a surrogate pair. */
export function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** Whitespace runs collapsed, at most `max` characters, never ending on half of a surrogate pair. */
function cutText(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : cutUnits(t, max - 1) + "…";
}

/** The `<cross-session-message>` element, opening tag through closing tag: what the prompt hook receives for a peer (§1 P11). */
function peerElement(text: string): string | null {
  const i = text.indexOf(PEER_OPEN);
  if (i < 0 || !/[\s>]/.test(text[i + PEER_OPEN.length] ?? "")) return null;
  const j = text.indexOf(PEER_CLOSE, i);
  return j < 0 ? null : text.slice(i, j + PEER_CLOSE.length);
}

const TASK_OPEN = "<task-notification>";
/** The children a `<task-notification>` element opens with, before any task output (P20: 1,909 of 1,909 elements). */
const TASK_HEADER_TAGS: ReadonlySet<string> = new Set(["task-id", "tool-use-id", "output-file", "status", "summary"]);

/**
 * A task notice's label: the `<status>` and `<summary>` among the element's LEADING header children, never the task's
 * result, event or other output (codex CODE T1-1). The element's inner text must be a sequence of child blocks (P17:
 * every surveyed element is); the first child of any other kind ends the header; a child counts only when it occurs
 * once there. Otherwise it is left out (fail closed).
 */
function taskLabel(text: string): string {
  const start = text.indexOf(TASK_OPEN);
  const end = start < 0 ? -1 : text.indexOf("</task-notification>", start);
  const children = end < 0 ? null : topLevelBlocks(text.slice(start + TASK_OPEN.length, end));
  const header: { tag: string; inner: string }[] = [];
  for (const b of children ?? []) {
    if (!TASK_HEADER_TAGS.has(b.tag)) break;
    header.push(b);
  }
  const child = (tag: string) => {
    const found = header.filter(b => b.tag === tag);
    return found.length === 1 ? found[0]!.inner.replace(/\s+/g, " ").trim() : "";
  };
  const status = cutText(child("status"), 40);
  const summary = child("summary");
  const head = status ? `[background task ${status}]` : "[background task]";
  return cutText(summary ? `${head} ${summary}` : head, TASK_LABEL_CHARS);
}

/** A peer notice's label: who sent it, never the message body, never its socket path. */
function peerLabel(origin: Record<string, any> | null): string {
  if (origin?.handback) return "[message from a background agent]";
  const name = typeof origin?.name === "string" ? cutText(origin.name, PEER_NAME_CHARS) : "";
  return `[message from ${name || "another session"}]`;
}

const noticeClass = (notice: TranscriptNotice, label: string): EntryClass => ({ kind: "notice", text: label, notice });

/**
 * A `queued_command` attachment: input received while the model worked (§3.2 step 5). Never human, never opening. Only
 * an attachment WITHOUT `origin` falls back to `commandMode`; an origin without a valid kind is queued-unknown (CODE T1-6).
 */
function queuedNotice(att: any): EntryClass {
  const origin = originOf(att);
  const kind = typeof origin?.kind === "string" ? origin.kind : null;
  const prompt = att.prompt;
  const text = typeof prompt === "string" ? prompt : Array.isArray(prompt) ? transcriptTextBlocks(prompt) : "";
  if (kind === "task-notification" || (att.origin === undefined && att.commandMode === "task-notification")) {
    return noticeClass({ source: "task", opens: false }, taskLabel(text));
  }
  if (kind === "peer") return noticeClass({ source: "peer", opens: false }, peerLabel(origin));
  if (kind === "human") {
    const typedText = text.trim().length > TYPED_TEXT_CHARS ? cutText(text, TYPED_TEXT_CHARS) : text.trim();
    const label = `[typed while the assistant was working] ${typedText}`.trimEnd();
    return noticeClass({ source: "queued-prompt", opens: false, typedText }, label);
  }
  return noticeClass({ source: "queued-unknown", opens: false }, "[input received while the assistant was working]");
}

/** A row's notice shape without `turnOrigin` (§3.2 steps 3–4), or null. The preamble form needs NO `origin` at all. */
function noticeShape(entry: any, text: string): "task" | "peer" | null {
  const origin = originOf(entry);
  if (origin?.kind === "peer") return "peer";
  if (origin?.kind === "task-notification") return "task";
  if (entry.origin === undefined && entry.isMeta && text.trimStart().startsWith(PEER_PREAMBLE) && peerElement(text) !== null) return "peer";
  const blocks = topLevelBlocks(text);
  if (blocks && blocks.every(b => b.tag === "task-notification")) return "task";
  return null;
}

/** An opening or non-opening notice row: its label, and for an opening row its identity (§3.1). */
function noticeRow(entry: any, text: string, source: "task" | "peer" | "other", opens: boolean, turnOrigin: string | null): EntryClass {
  const label = source === "task" ? taskLabel(text) : source === "peer" ? peerLabel(originOf(entry)) : `[turn started by ${turnOrigin}]`;
  const notice: TranscriptNotice = { source, opens };
  if (opens) notice.identitySha = promptSha((source === "peer" ? peerElement(text) : null) ?? text);
  return noticeClass(notice, label);
}

/**
 * The entry's kind, and its text: for human turns the typed text (injected context blocks stripped), for notices the
 * label. Shared with the 62.1 cursor reader. One executable order, first match wins (72.4 §3.2 step 0):
 *  1. assistant; a tool result (role toolResult/tool, or a user row with `toolUseResult` or tool_result blocks);
 *  2. any other role than user → meta, whatever `turnOrigin` says;
 *  3. hard exclusions → meta: compact summaries, transcript-only rows, plugin rows (ysk notes), an interrupt;
 *  4. a valid `turnOrigin` other than "human" → an opening notice (it overrides the generic `isMeta` gate);
 *  5. no `turnOrigin` at all (a present but invalid one is not absent), notice-shaped → a notice, opening only on a
 *     writer that does not record openers;
 *  6. generic `isMeta` → meta;
 *  7. host records and typed text: a command record → human ("/name args", or bare "/name"), other records → meta.
 */
export function classifyTranscriptEntry(entry: any, msg: any): EntryClass {
  const first = assistantOrToolResult(entry, msg);
  if (first) return first;
  if (msg.role !== "user") return { kind: "meta", text: "" };
  const text = transcriptTextBlocks(msg.content);
  if (entry.isCompactSummary || entry.isVisibleInTranscriptOnly || originOf(entry)?.kind === "plugin") return { kind: "meta", text: "" };
  if (text.trimStart().startsWith("[Request interrupted by user")) return { kind: "meta", text: "" };
  const turnOrigin = typeof entry.turnOrigin === "string" && TURN_ORIGIN_RE.test(entry.turnOrigin) ? entry.turnOrigin : null;
  if (turnOrigin !== null && turnOrigin !== "human") {
    const source = turnOrigin === "task_notification" ? "task" : turnOrigin === "peer" ? "peer" : "other";
    return noticeRow(entry, text, source, true, turnOrigin);
  }
  if (entry.turnOrigin === undefined) {
    const shape = noticeShape(entry, text);
    // A writer that records openers recorded none for this row: it opened no turn (§1 P6b).
    if (shape) return noticeRow(entry, text, shape, !writerRecordsOpeners(entry.version), null);
  }
  if (entry.isMeta) return { kind: "meta", text: "" };
  const blocks = topLevelBlocks(text);
  if (blocks && blocks.every(b => HOST_RECORD_TAGS.has(b.tag))) {
    const task = blocks.some(b => b.tag === "command-name") ? commandTask(blocks) : null;
    if (!task) return { kind: "meta", text: "" };
    const out: EntryClass = { kind: "human", text: task.text, command: true };
    if (task.bare) out.bareCommand = true;
    if (turnOrigin === "human") out.promptCommand = true;
    return out;
  }
  return { kind: "human", text: text.replace(INJECTED_BLOCK_RE, "").trim() };
}

/** §3.2 step 0.1: an assistant message, or a tool result (role toolResult/tool, or a user row carrying one); else null. */
function assistantOrToolResult(entry: any, msg: any): EntryClass | null {
  if (msg.role === "assistant") return { kind: "assistant", text: transcriptTextBlocks(msg.content) };
  if (msg.role === "toolResult" || msg.role === "tool") return { kind: "tool_result", text: "" }; // OpenClaw / generic
  if (msg.role !== "user") return null;
  if (entry.toolUseResult !== undefined) return { kind: "tool_result", text: "" };
  if (Array.isArray(msg.content) && msg.content.some((b: any) => b && b.type === "tool_result")) return { kind: "tool_result", text: "" };
  return null;
}

/**
 * Classify a parsed transcript row, including the rows without a message the readers used to skip (72.4): a
 * `queued_command` attachment, and a `system`/`local_command` row (a built-in command's output). Step 0.1 comes first
 * whatever the envelope (codex CODE T1-5). Null: a row without a role and content that is neither.
 */
export function classifyTranscriptRow(entry: any): EntryClass | null {
  if (!entry || typeof entry !== "object") return null;
  const msg = entry.message ?? entry;
  const hasMessage = !!msg && typeof msg === "object" && !!msg.role && !!msg.content;
  const first = hasMessage ? assistantOrToolResult(entry, msg) : null;
  if (first) return first;
  if (entry.type === "attachment" && entry.attachment && typeof entry.attachment === "object"
    && entry.attachment.type === "queued_command") return queuedNotice(entry.attachment);
  if (entry.type === "system" && entry.subtype === "local_command") return { kind: "meta", text: "", localOutput: true };
  return hasMessage ? classifyTranscriptEntry(entry, msg) : null;
}

/** Claude Code follows a LOCAL (built-in) command's record with its output; a prompt command expands instead. */
export const LOCAL_COMMAND_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>/;

/**
 * Read a transcript as classified turns (62.2, CM-03). The window matches `readTranscript`'s
 * (the last N parsed entries); entries without a role or content are skipped, as there — except, since 72.4, queued
 * input (a notice) and a built-in command's `system`/`local_command` output row (kept as the record's successor).
 */
export function readTranscriptTurns(transcriptPath: string, lastN: number = 200): TranscriptTurn[] {
  try {
    const turns: (TranscriptTurn & { promptCommand?: true })[] = [];
    for (const line of readTranscriptTailLines(transcriptPath, lastN)) {
      try {
        const entry = JSON.parse(line);
        const c = classifyTranscriptRow(entry);
        if (!c) continue;
        const msg = entry.message ?? entry;
        const role = c.kind === "notice" ? "user" : c.localOutput ? "system" : String(msg.role);
        const rendered = c.kind === "notice" ? c.text : c.localOutput ? "" : renderTranscriptContent(msg.content);
        const turn: TranscriptTurn & { promptCommand?: true } = { role, kind: c.kind, text: c.text, rendered };
        if (c.command) turn.command = true;
        if (c.bareCommand) turn.bareCommand = true;
        if (c.promptCommand) turn.promptCommand = true;
        if (c.notice) turn.notice = c.notice;
        if (c.localOutput) turn.localOutput = true;
        turns.push(turn);
      } catch {
        // Skip malformed lines
      }
    }
    // A built-in command (`/model sonnet`) is a setting change, not a task: its record is followed by
    // local-command output. Only prompt commands (skills, custom commands) keep their arguments as a task.
    for (let i = 0; i < turns.length - 1; i++) {
      const t = turns[i]!;
      const next = turns[i + 1]!;
      if (t.command && (LOCAL_COMMAND_OUTPUT_RE.test(next.rendered) || next.localOutput)) {
        t.kind = "meta";
        t.text = "";
        delete t.command;
        delete t.bareCommand;
      }
    }
    for (const t of turns) delete t.promptCommand;
    return turns.slice(-lastN);
  } catch {
    return [];
  }
}

/**
 * Validate a transcript path (security: must be absolute, .jsonl, regular file, <1GB).
 */
export function validateTranscriptPath(path: string | undefined): string | null {
  if (!path) return null;
  if (!require("path").isAbsolute(path)) return null;
  if (!path.endsWith(".jsonl")) return null;

  try {
    const stat = require("fs").statSync(path);
    if (!stat.isFile()) return null;
    if (stat.size > 1024 * 1024 * 1024) return null; // 1GB sanity limit (readTranscript tail-reads large files)
    return path;
  } catch {
    return null;
  }
}

// =============================================================================
// Snippet Helpers
// =============================================================================

/**
 * Smart truncate: break at paragraph → sentence → newline → word boundary.
 */
export function smartTruncate(text: string, maxChars: number = 300): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);

  // Try paragraph break
  const paraIdx = truncated.lastIndexOf("\n\n");
  if (paraIdx > maxChars * 0.5) return truncated.slice(0, paraIdx).trimEnd();

  // Try sentence break
  const sentenceMatch = truncated.match(/^(.+[.!?])\s/s);
  if (sentenceMatch && sentenceMatch[1]!.length > maxChars * 0.5) {
    return sentenceMatch[1]!;
  }

  // Try newline break
  const nlIdx = truncated.lastIndexOf("\n");
  if (nlIdx > maxChars * 0.5) return truncated.slice(0, nlIdx).trimEnd();

  // Try word boundary
  const wordIdx = truncated.lastIndexOf(" ");
  if (wordIdx > maxChars * 0.5) return truncated.slice(0, wordIdx).trimEnd() + "...";

  return truncated.trimEnd() + "...";
}

// =============================================================================
// Logging
// =============================================================================

/**
 * Log a context injection to the usage tracking table.
 *
 * `queryText` (v0.8.1 Ext 6b) is the raw prompt for this turn. Persisted
 * only when the caller passes it — logEmptyTurn-style skip paths omit it
 * so gated turns (slash commands, heartbeats, noise) cannot leak raw
 * prompt text into `context_usage.query_text`. Pre-migration stores
 * transparently drop the column via `insertUsageFn`'s feature-detect.
 *
 * `identity` (62.1 D1): the turn's prompt hash, transcript key, host and session key — context-surfacing passes it
 * on every row it writes, gated rows included (a hash, never raw text); null/absent writes a row without them.
 */
export function logInjection(
  store: Store,
  sessionId: string,
  hookName: string,
  injectedPaths: string[],
  estimatedTokens: number,
  turnIndex?: number,
  queryText?: string,
  identity?: UsageIdentity | null,
): number {
  try {
    const usageId = store.insertUsage({
      sessionId,
      timestamp: isoNow(),
      hookName,
      injectedPaths,
      estimatedTokens,
      wasReferenced: 0,
      turnIndex,
      queryText,
      ...(identity ? {
        promptSha: identity.promptSha,
        transcriptKey: identity.transcriptKey,
        host: identity.host,
        sessionKey: identity.sessionKey,
      } : {}),
    });

    // 62.1 D9: no injection-time co-activations for any hook (BUILD-5 extended). Being shown together is not
    // evidence of use; co_activations holds only verified same-turn co-references (feedback-loop).

    return usageId;
  } catch {
    // Non-fatal: don't crash hook if usage logging fails
    return -1;
  }
}
