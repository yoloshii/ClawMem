/**
 * normalize.ts — Conversation format normalizer for ClawMem
 *
 * Converts chat export files into normalized markdown documents suitable for
 * ClawMem's indexing pipeline. Supports:
 *   - Claude Code JSONL sessions
 *   - Claude.ai JSON exports (flat + privacy export)
 *   - ChatGPT conversations.json (mapping tree)
 *   - Slack JSON exports (DMs + channels)
 *   - Plain text with user/assistant markers
 *
 * Each exchange pair (user + assistant) becomes one markdown chunk.
 * Inspired by MemPalace normalize.py, rewritten for TypeScript/Bun.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { basename, extname, join, relative } from "path";

// =============================================================================
// Types
// =============================================================================

export type Message = { role: "user" | "assistant"; content: string; timestamp?: string };

export type NormalizedConversation = {
  source: string;           // original filename
  format: string;           // detected format
  messages: Message[];      // normalized messages
};

export type ConversationChunk = {
  title: string;            // "Exchange N" or extracted topic
  body: string;             // markdown body
  sourcePath: string;       // relative path of source file
  chunkIndex: number;
  authoredAt: string | null; // max message timestamp in this exchange (§51.1 D4); null = unknown
};

// =============================================================================
// Timestamp Adapters (§51.1 D3 — strict per-format; never host-timezone)
// =============================================================================

// RFC3339 with explicit Z or numeric colon offset. Timezone-less values are
// rejected — interpreting them in the host timezone would make mined dates
// machine-dependent.
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// Pure Gregorian arithmetic — Date.UTC maps numeric years 0-99 to 1900-1999,
// which would both corrupt century leap rules here and shift constructed dates.
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/**
 * Strict RFC3339 timestamp (explicit Z or numeric offset) → UTC ISO, else null.
 *
 * The literal wall-clock components are validated as written (Feb 30 is
 * rejected, not normalized) BEFORE the offset is applied — comparing input
 * components against the UTC output would wrongly reject valid offset inputs
 * ("2025-01-01T12:00:00+10:00" legitimately normalizes to 02:00Z).
 */
export function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = RFC3339_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMs = 0;
  const offset = m[8]!;
  if (offset !== "Z" && offset !== "z") {
    const offHour = Number(offset.slice(1, 3));
    const offMin = Number(offset.slice(4, 6));
    if (offHour > 23 || offMin > 59) return null;
    offsetMs = (offset[0] === "-" ? -1 : 1) * (offHour * 3600_000 + offMin * 60_000);
  }
  const fracMs = m[7] ? Math.round(parseFloat(`0${m[7]}`) * 1000) : 0;
  // setUTCFullYear takes years 0-99 literally, unlike Date.UTC's 1900-mapping —
  // "0001-01-01T00:00:00Z" must not silently become 1901.
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  const ms = d.getTime() + fracMs - offsetMs;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

/**
 * Epoch seconds → UTC ISO, else null. The multiplied value must land inside
 * the ECMAScript Date range — finite input alone does not prevent
 * toISOString() from throwing.
 */
export function epochSecondsToIso(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

// Slack `ts`: epoch-seconds string like "1234567890.123456" — exactly 10
// integer digits; anything else is rejected rather than guessed at.
const SLACK_TS_RE = /^\d{10}\.\d+$/;

function slackTsToIso(ts: unknown): string | null {
  if (typeof ts !== "string" || !SLACK_TS_RE.test(ts)) return null;
  return epochSecondsToIso(parseFloat(ts));
}

// =============================================================================
// Format Detection & Normalization
// =============================================================================

const CONVO_EXTENSIONS = new Set([".txt", ".md", ".json", ".jsonl"]);
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".mempalace", ".grepai", "tool-results"]);

export function normalizeFile(filepath: string): NormalizedConversation | null {
  let content: string;
  try {
    content = readFileSync(filepath, "utf-8");
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  const ext = extname(filepath).toLowerCase();

  // Try JSONL formats first (Claude Code, Codex CLI)
  if (ext === ".jsonl" || (content.trim().startsWith("{") && content.includes("\n{"))) {
    const cc = tryClaudeCodeJsonl(content);
    if (cc) return { source: basename(filepath), format: "claude-code", messages: cc };

    const codex = tryCodexJsonl(content);
    if (codex) return { source: basename(filepath), format: "codex-cli", messages: codex };
  }

  // Try JSON formats
  if (ext === ".json" || content.trim().startsWith("{") || content.trim().startsWith("[")) {
    try {
      const data = JSON.parse(content);

      const claude = tryClaudeAiJson(data);
      if (claude) return { source: basename(filepath), format: "claude-ai", messages: claude };

      const chatgpt = tryChatGptJson(data);
      if (chatgpt) return { source: basename(filepath), format: "chatgpt", messages: chatgpt };

      const slack = trySlackJson(data);
      if (slack) return { source: basename(filepath), format: "slack", messages: slack };
    } catch {
      // Not valid JSON
    }
  }

  // Try plain text with user/assistant markers
  const plain = tryPlainText(content);
  if (plain) return { source: basename(filepath), format: "plain-text", messages: plain };

  return null;
}

// =============================================================================
// Format Parsers
// =============================================================================

function tryClaudeCodeJsonl(content: string): Message[] | null {
  const lines = content.trim().split("\n").filter(l => l.trim());
  const messages: Message[] = [];

  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry !== "object" || !entry) continue;

    const msgType = entry.type ?? "";
    const message = entry.message ?? {};
    const ts = normalizeIsoTimestamp(entry.timestamp);

    if (msgType === "human" || msgType === "user") {
      const text = extractContent(message.content);
      if (text) messages.push({ role: "user", content: text, ...(ts ? { timestamp: ts } : {}) });
    } else if (msgType === "assistant") {
      const text = extractContent(message.content);
      if (text) messages.push({ role: "assistant", content: text, ...(ts ? { timestamp: ts } : {}) });
    }
  }

  return messages.length >= 2 ? messages : null;
}

function tryCodexJsonl(content: string): Message[] | null {
  const lines = content.trim().split("\n").filter(l => l.trim());
  const messages: Message[] = [];
  let hasSessionMeta = false;

  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry !== "object" || !entry) continue;

    if (entry.type === "session_meta") { hasSessionMeta = true; continue; }
    if (entry.type !== "event_msg") continue;

    const payload = entry.payload;
    if (typeof payload !== "object" || !payload) continue;

    const text = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!text) continue;

    const ts = normalizeIsoTimestamp(entry.timestamp);
    if (payload.type === "user_message") messages.push({ role: "user", content: text, ...(ts ? { timestamp: ts } : {}) });
    else if (payload.type === "agent_message") messages.push({ role: "assistant", content: text, ...(ts ? { timestamp: ts } : {}) });
  }

  return messages.length >= 2 && hasSessionMeta ? messages : null;
}

function tryClaudeAiJson(data: any): Message[] | null {
  // Privacy export: array of conversation objects with chat_messages
  if (Array.isArray(data) && data.length > 0 && data[0]?.chat_messages) {
    const messages: Message[] = [];
    for (const convo of data) {
      for (const item of convo.chat_messages ?? []) {
        const role = item.role ?? "";
        const text = extractContent(item.content);
        const ts = normalizeIsoTimestamp(item.created_at);
        if ((role === "user" || role === "human") && text) messages.push({ role: "user", content: text, ...(ts ? { timestamp: ts } : {}) });
        else if ((role === "assistant" || role === "ai") && text) messages.push({ role: "assistant", content: text, ...(ts ? { timestamp: ts } : {}) });
      }
    }
    return messages.length >= 2 ? messages : null;
  }

  // Flat messages list or wrapped in { messages: [...] }
  let msgs = data;
  if (typeof data === "object" && !Array.isArray(data)) {
    msgs = data.messages ?? data.chat_messages ?? [];
  }
  if (!Array.isArray(msgs)) return null;

  const messages: Message[] = [];
  for (const item of msgs) {
    if (typeof item !== "object" || !item) continue;
    const role = item.role ?? "";
    const text = extractContent(item.content);
    const ts = normalizeIsoTimestamp(item.created_at);
    if ((role === "user" || role === "human") && text) messages.push({ role: "user", content: text, ...(ts ? { timestamp: ts } : {}) });
    else if ((role === "assistant" || role === "ai") && text) messages.push({ role: "assistant", content: text, ...(ts ? { timestamp: ts } : {}) });
  }
  return messages.length >= 2 ? messages : null;
}

function tryChatGptJson(data: any): Message[] | null {
  if (typeof data !== "object" || !data?.mapping) return null;
  const mapping = data.mapping;
  const messages: Message[] = [];

  // Find root node (parent=null, no message)
  let rootId: string | null = null;
  let fallback: string | null = null;
  for (const [nodeId, node] of Object.entries(mapping) as [string, any][]) {
    if (node.parent === null) {
      if (!node.message) { rootId = nodeId; break; }
      else if (!fallback) fallback = nodeId;
    }
  }
  rootId = rootId ?? fallback;
  if (!rootId) return null;

  // Walk the tree
  let currentId: string | null = rootId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node: any = (mapping as any)[currentId];
    if (node?.message) {
      const role = node.message.author?.role ?? "";
      const content = node.message.content;
      const parts = content?.parts ?? [];
      const text = parts.filter((p: any) => typeof p === "string").join(" ").trim();
      const ts = epochSecondsToIso(node.message.create_time);
      if (role === "user" && text) messages.push({ role: "user", content: text, ...(ts ? { timestamp: ts } : {}) });
      else if (role === "assistant" && text) messages.push({ role: "assistant", content: text, ...(ts ? { timestamp: ts } : {}) });
    }
    currentId = node?.children?.[0] ?? null;
  }
  return messages.length >= 2 ? messages : null;
}

function trySlackJson(data: any): Message[] | null {
  if (!Array.isArray(data)) return null;

  // Count unique speakers — only support 2-party DMs
  const speakers = new Set<string>();
  for (const item of data) {
    if (typeof item !== "object" || item?.type !== "message") continue;
    const userId = item.user ?? item.username ?? "";
    if (userId) speakers.add(userId);
    if (speakers.size > 2) return null; // multi-person channel, unsupported
  }
  if (speakers.size < 2) return null;

  const messages: Message[] = [];
  const [speakerA, speakerB] = [...speakers] as [string, string];
  const roleMap: Record<string, "user" | "assistant"> = {
    [speakerA]: "user",
    [speakerB]: "assistant",
  };

  for (const item of data) {
    if (typeof item !== "object" || item?.type !== "message") continue;
    const userId = item.user ?? item.username ?? "";
    const text = (item.text ?? "").trim();
    if (!text || !roleMap[userId]) continue;
    const ts = slackTsToIso(item.ts);
    messages.push({ role: roleMap[userId], content: text, ...(ts ? { timestamp: ts } : {}) });
  }
  return messages.length >= 2 ? messages : null;
}

function tryPlainText(content: string): Message[] | null {
  const messages: Message[] = [];
  // Only match explicit role prefixes (User:, Human:, Assistant:, etc.)
  // Do NOT match bare blockquotes (> ) — too many false positives with markdown
  const lines = content.split("\n");
  let currentRole: "user" | "assistant" | null = null;
  let currentText: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let newRole: "user" | "assistant" | null = null;

    if (/^(User|Human)\s*:\s*/i.test(trimmed)) {
      newRole = "user";
    } else if (/^(Assistant|AI|Claude|GPT|Bot)\s*:\s*/i.test(trimmed)) {
      newRole = "assistant";
    }

    if (newRole) {
      if (currentRole && currentText.length > 0) {
        const text = currentText.join("\n").trim();
        if (text) messages.push({ role: currentRole, content: text });
      }
      currentRole = newRole;
      // Strip the role prefix
      const cleaned = trimmed.replace(/^(User|Human|Assistant|AI|Claude|GPT|Bot)\s*:\s*/i, "");
      currentText = cleaned ? [cleaned] : [];
    } else if (currentRole) {
      currentText.push(trimmed);
    }
  }

  // Flush last
  if (currentRole && currentText.length > 0) {
    const text = currentText.join("\n").trim();
    if (text) messages.push({ role: currentRole, content: text });
  }

  // Require at least 2 exchanges AND both roles present (prevents false positives)
  const hasUser = messages.some(m => m.role === "user");
  const hasAssistant = messages.some(m => m.role === "assistant");
  return messages.length >= 4 && hasUser && hasAssistant ? messages : null;
}

// =============================================================================
// Content Extraction
// =============================================================================

function extractContent(content: any): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item?.type === "text") return item.text ?? "";
        return "";
      })
      .join(" ")
      .trim();
  }
  if (typeof content === "object" && content) return (content.text ?? "").trim();
  return "";
}

// =============================================================================
// Chunking — Exchange Pairs
// =============================================================================

const MIN_CHUNK_CHARS = 30;

export function chunkConversation(conv: NormalizedConversation): ConversationChunk[] {
  const chunks: ConversationChunk[] = [];
  const { messages, source } = conv;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;

    const userMsg = msg.content;
    // §51.1 D4: authoredAt = max timestamp among THIS exchange's messages only.
    // An exchange with no timestamps stays null — never inherit a transcript-level
    // value (privacy exports flatten multiple conversations into one stream, so a
    // transcript-wide max would cross conversation boundaries).
    const exchangeTimestamps: string[] = [];
    if (msg.timestamp) exchangeTimestamps.push(msg.timestamp);
    // Collect ALL consecutive assistant messages (handles split replies)
    const assistantParts: string[] = [];
    while (i + 1 < messages.length && messages[i + 1]!.role === "assistant") {
      const next = messages[i + 1]!;
      assistantParts.push(next.content);
      if (next.timestamp) exchangeTimestamps.push(next.timestamp);
      i++;
    }
    const assistantMsg = assistantParts.join("\n\n");

    // Build markdown chunk
    const title = extractExchangeTitle(userMsg, chunks.length + 1);
    const body = formatExchangeMarkdown(userMsg, assistantMsg);

    if (body.length >= MIN_CHUNK_CHARS) {
      chunks.push({
        title,
        body,
        sourcePath: source,
        chunkIndex: chunks.length,
        // Normalized toISOString values are uniform-width UTC strings, so the
        // lexicographic max is the chronological max.
        authoredAt: exchangeTimestamps.length > 0
          ? exchangeTimestamps.reduce((a, b) => (b > a ? b : a))
          : null,
      });
    }
  }

  return chunks;
}

function extractExchangeTitle(userMessage: string, index: number): string {
  // Use the first line/sentence of the user message, capped at 80 chars
  const firstLine = userMessage.split("\n")[0]!.trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + "...";
}

function formatExchangeMarkdown(userMsg: string, assistantMsg: string): string {
  const lines: string[] = [];
  lines.push("**User:**", userMsg, "");
  if (assistantMsg) {
    lines.push("**Assistant:**", assistantMsg, "");
  }
  return lines.join("\n");
}

// =============================================================================
// Directory Scanner
// =============================================================================

export function scanConversationDir(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(d, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(entry)) walk(fullPath);
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase();
          if (CONVO_EXTENSIONS.has(ext)) files.push(fullPath);
        }
      } catch { continue; }
    }
  }

  walk(dir);
  return files;
}
