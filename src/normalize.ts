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

export type Message = { role: "user" | "assistant"; content: string };

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
};

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

    if (msgType === "human" || msgType === "user") {
      const text = extractContent(message.content);
      if (text) messages.push({ role: "user", content: text });
    } else if (msgType === "assistant") {
      const text = extractContent(message.content);
      if (text) messages.push({ role: "assistant", content: text });
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

    if (payload.type === "user_message") messages.push({ role: "user", content: text });
    else if (payload.type === "agent_message") messages.push({ role: "assistant", content: text });
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
        if ((role === "user" || role === "human") && text) messages.push({ role: "user", content: text });
        else if ((role === "assistant" || role === "ai") && text) messages.push({ role: "assistant", content: text });
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
    if ((role === "user" || role === "human") && text) messages.push({ role: "user", content: text });
    else if ((role === "assistant" || role === "ai") && text) messages.push({ role: "assistant", content: text });
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
    const node = (mapping as any)[currentId];
    if (node?.message) {
      const role = node.message.author?.role ?? "";
      const content = node.message.content;
      const parts = content?.parts ?? [];
      const text = parts.filter((p: any) => typeof p === "string").join(" ").trim();
      if (role === "user" && text) messages.push({ role: "user", content: text });
      else if (role === "assistant" && text) messages.push({ role: "assistant", content: text });
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
  const speakerList = [...speakers];
  const roleMap: Record<string, "user" | "assistant"> = {
    [speakerList[0]]: "user",
    [speakerList[1]]: "assistant",
  };

  for (const item of data) {
    if (typeof item !== "object" || item?.type !== "message") continue;
    const userId = item.user ?? item.username ?? "";
    const text = (item.text ?? "").trim();
    if (!text || !roleMap[userId]) continue;
    messages.push({ role: roleMap[userId], content: text });
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
    if (messages[i].role !== "user") continue;

    const userMsg = messages[i].content;
    // Collect ALL consecutive assistant messages (handles split replies)
    const assistantParts: string[] = [];
    while (i + 1 < messages.length && messages[i + 1].role === "assistant") {
      assistantParts.push(messages[i + 1].content);
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
      });
    }
  }

  return chunks;
}

function extractExchangeTitle(userMessage: string, index: number): string {
  // Use the first line/sentence of the user message, capped at 80 chars
  const firstLine = userMessage.split("\n")[0].trim();
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
