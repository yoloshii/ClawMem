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
 * user-ROLE entries; only `human` is something the user typed.
 */
export type TranscriptTurnKind = "human" | "assistant" | "tool_result" | "meta";

export type TranscriptTurn = {
  role: string;
  kind: TranscriptTurnKind;
  /**
   * Assistant: text blocks only (no tool_use rendering). Human: the typed text with host-injected
   * context blocks stripped, or "/name args" for a slash command that carries a task. Others: "".
   */
  text: string;
  /** The same entry as `readTranscript` renders it. */
  rendered: string;
  /** Set on a human turn that is a slash command's task ("/name args"). */
  command?: true;
};

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
 * A slash-command record's task: "/name args". `null` = a command record without a task (no
 * arguments, or `/compact`, whose arguments are compaction instructions). Only TOP-LEVEL
 * `command-name` / `command-args` blocks count.
 */
function commandTask(blocks: { tag: string; inner: string }[]): string | null {
  const name = blocks.find(b => b.tag === "command-name")?.inner.trim();
  if (!name || name === "/compact") return null;
  const args = blocks.find(b => b.tag === "command-args")?.inner.trim() ?? "";
  return args ? `${name} ${args}` : null;
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

/** The entry's kind, and for human turns the typed text (injected context blocks stripped). Shared with the 62.1 cursor reader. */
export function classifyTranscriptEntry(entry: any, msg: any): { kind: TranscriptTurnKind; text: string; command?: true } {
  if (msg.role === "assistant") return { kind: "assistant", text: transcriptTextBlocks(msg.content) };
  if (msg.role === "toolResult" || msg.role === "tool") return { kind: "tool_result", text: "" }; // OpenClaw / generic
  if (msg.role !== "user") return { kind: "meta", text: "" };
  if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return { kind: "meta", text: "" };
  if (entry.toolUseResult !== undefined) return { kind: "tool_result", text: "" };
  if (Array.isArray(msg.content) && msg.content.some((b: any) => b && b.type === "tool_result")) {
    return { kind: "tool_result", text: "" };
  }
  const text = transcriptTextBlocks(msg.content);
  if (text.trimStart().startsWith("[Request interrupted by user")) return { kind: "meta", text: "" };
  const blocks = topLevelBlocks(text);
  if (blocks && blocks.every(b => HOST_RECORD_TAGS.has(b.tag))) {
    const task = blocks.some(b => b.tag === "command-name") ? commandTask(blocks) : null;
    return typeof task === "string" ? { kind: "human", text: task, command: true } : { kind: "meta", text: "" };
  }
  return { kind: "human", text: text.replace(INJECTED_BLOCK_RE, "").trim() };
}

/** Claude Code follows a LOCAL (built-in) command's record with its output; a prompt command expands instead. */
export const LOCAL_COMMAND_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>/;

/**
 * Read a transcript as classified turns (62.2, CM-03). The window matches `readTranscript`'s
 * (the last N parsed entries); entries without a role or content are skipped, as there.
 */
export function readTranscriptTurns(transcriptPath: string, lastN: number = 200): TranscriptTurn[] {
  try {
    const turns: TranscriptTurn[] = [];
    for (const line of readTranscriptTailLines(transcriptPath, lastN)) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message ?? entry;
        if (!msg.role || !msg.content) continue;
        const { kind, text, command } = classifyTranscriptEntry(entry, msg);
        const turn: TranscriptTurn = { role: String(msg.role), kind, text, rendered: renderTranscriptContent(msg.content) };
        if (command) turn.command = true;
        turns.push(turn);
      } catch {
        // Skip malformed lines
      }
    }
    // A built-in command (`/model sonnet`) is a setting change, not a task: its record is followed by
    // local-command output. Only prompt commands (skills, custom commands) keep their arguments as a task.
    for (let i = 0; i < turns.length - 1; i++) {
      const t = turns[i]!;
      if (t.command && LOCAL_COMMAND_OUTPUT_RE.test(turns[i + 1]!.rendered)) {
        t.kind = "meta";
        t.text = "";
        delete t.command;
      }
    }
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
