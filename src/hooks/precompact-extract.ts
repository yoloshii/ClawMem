/**
 * PreCompact hook — extracts session state before auto-compaction.
 *
 * Reads the full uncompressed transcript, extracts decisions and working
 * state via regex (no LLM calls), and writes a handoff file to Claude Code's
 * auto-memory directory. This file survives compaction and is automatically
 * reloaded by Claude Code.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  type HookInput,
  type HookOutput,
  makeEmptyOutput,
  readTranscript,
  validateTranscriptPath,
  estimateTokens,
} from "../hooks.ts";
import type { Store } from "../store.ts";
import { extractDecisions } from "./decision-extractor.ts";
import { indexCollection } from "../indexer.ts";
import { loadConfig } from "../collections.ts";

// ---------------------------------------------------------------------------
// Auto-memory path discovery
// ---------------------------------------------------------------------------

function getAutoMemoryDir(transcriptPath?: string): string | null {
  // Best source: derive from transcript_path which is already
  // ~/.claude/projects/<project-dir>/<session>.jsonl
  if (transcriptPath) {
    const projectDir = resolve(transcriptPath, "..");
    const memDir = join(projectDir, "memory");
    if (existsSync(memDir)) return memDir;
    // Create it if the project dir exists
    if (existsSync(projectDir)) {
      try {
        mkdirSync(memDir, { recursive: true });
        return memDir;
      } catch { /* fall through */ }
    }
  }

  // Fallback: CWD-based lookup
  const cwd = process.cwd();
  const sanitized = cwd.replace(/\//g, "-").replace(/^-/, "");
  const memDir = join(
    process.env.HOME || "/tmp",
    ".claude",
    "projects",
    sanitized,
    "memory"
  );
  if (existsSync(memDir)) return memDir;

  return null;
}

// ---------------------------------------------------------------------------
// File path extraction from transcript
// ---------------------------------------------------------------------------

const FILE_OP_PATTERNS = [
  /(?:Read|Edit|Write|NotebookEdit)\s+(?:tool\s+)?(?:on\s+)?['"`]?([/~][^\s'"`,;]+)/gi,
  /file_path['":\s]+([/~][^\s'"`,;]+)/gi,
  /(?:Created|Modified|Wrote|Updated|Edited)\s+['"`]?([/~][^\s'"`,;]+)/gi,
];

function extractFilePaths(messages: { role: string; content: string }[]): string[] {
  const paths = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const pattern of FILE_OP_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(msg.content)) !== null) {
        const p = match[1]!;
        if (p.length > 10 && p.length < 300 && !p.includes("*")) {
          paths.add(p);
        }
      }
    }
  }

  return [...paths].slice(0, 30); // cap at 30
}

// ---------------------------------------------------------------------------
// Last user request extraction
// ---------------------------------------------------------------------------

function getLastUserRequest(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "user" && msg.content.length > 10) {
      return msg.content.slice(0, 500);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Tool output pruning — strip verbose tool results from messages
// ---------------------------------------------------------------------------

/**
 * Prune verbose tool output blocks from message content.
 * Keeps tool invocation lines but strips their large result payloads.
 */
function pruneToolOutputs(content: string): string {
  // Strip Read/Grep/Glob/Bash tool result blocks (multi-line outputs)
  let pruned = content;

  // Remove large indented tool output blocks (lines starting with spaces/tabs after tool mention)
  pruned = pruned.replace(
    /(?:Result of (?:calling |)(?:the )?(?:Read|Grep|Glob|Bash|Write|Edit|NotebookEdit) tool[^\n]*\n)(?:[ \t]+[^\n]*\n)*/gi,
    ""
  );

  // Remove file content dumps (numbered lines like "     1→...")
  pruned = pruned.replace(/(?:^ *\d+→[^\n]*\n){5,}/gm, "[file content pruned]\n");

  return pruned;
}

// ---------------------------------------------------------------------------
// Open question extraction (simple heuristics)
// ---------------------------------------------------------------------------

const QUESTION_PATTERNS = [
  /\b(?:should we|do you want|which (?:approach|option)|how should|what about)\b[^.!]*\?/gi,
  /\b(?:TODO|FIXME|HACK|open question|unresolved|needs?\s+(?:investigation|decision))\b[^.!]*/gi,
];

function extractOpenQuestions(messages: { role: string; content: string }[]): string[] {
  const questions: string[] = [];
  const seen = new Set<string>();

  // Look at last 20 messages for recency
  const recent = messages.slice(-20);

  for (const msg of recent) {
    for (const pattern of QUESTION_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(msg.content)) !== null) {
        const q = match[0].trim();
        const key = q.slice(0, 60).toLowerCase();
        if (!seen.has(key) && q.length > 15 && q.length < 300) {
          seen.add(key);
          questions.push(q);
        }
      }
    }
  }

  return questions.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Query-aware decision ranking (E9)
// ---------------------------------------------------------------------------

/**
 * Rank decisions by relevance to the last user request.
 * Decisions mentioning terms from the active task get priority.
 */
function rankDecisionsByRelevance(
  decisions: { text: string; context: string }[],
  lastRequest: string
): { text: string; context: string }[] {
  if (!lastRequest || decisions.length <= 1) return decisions;

  const queryTerms = lastRequest
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 3);

  if (queryTerms.length === 0) return decisions;

  return [...decisions].sort((a, b) => {
    const aText = a.text.toLowerCase();
    const bText = b.text.toLowerCase();
    const aScore = queryTerms.filter(t => aText.includes(t)).length;
    const bScore = queryTerms.filter(t => bText.includes(t)).length;
    return bScore - aScore;
  });
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

export async function precompactExtract(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  const transcriptPath = validateTranscriptPath(input.transcriptPath ?? "");
  if (!transcriptPath) {
    return makeEmptyOutput("precompact-extract");
  }

  const messages = readTranscript(transcriptPath, 200);
  if (messages.length === 0) {
    return makeEmptyOutput("precompact-extract");
  }

  // Prune verbose tool outputs before extraction (keeps messages focused)
  const prunedMessages = messages.map(m => ({
    ...m,
    content: m.role === "assistant" ? pruneToolOutputs(m.content) : m.content,
  }));

  // Extract components (use pruned messages for decisions/questions, raw for file paths)
  let decisions = extractDecisions(prunedMessages);
  const lastRequest = getLastUserRequest(messages); // raw — need full user request
  const filePaths = extractFilePaths(messages); // raw — need exact paths
  const openQuestions = extractOpenQuestions(prunedMessages);

  // Query-aware ranking: prioritize decisions relevant to the active task (E9)
  decisions = rankDecisionsByRelevance(decisions, lastRequest);

  // Skip if nothing meaningful extracted
  if (decisions.length === 0 && !lastRequest && filePaths.length === 0) {
    return makeEmptyOutput("precompact-extract");
  }

  // Build the handoff document
  const now = new Date().toISOString();
  const sections: string[] = [
    `# Pre-Compaction State`,
    ``,
    `_Extracted ${now.slice(0, 19)} before auto-compaction. This is authoritative._`,
    ``,
  ];

  if (lastRequest) {
    sections.push(`## Last User Request`, ``, lastRequest, ``);
  }

  if (decisions.length > 0) {
    sections.push(`## Key Decisions This Session`, ``);
    for (const d of decisions.slice(0, 15)) {
      sections.push(`- ${d.text}`);
      if (d.context) {
        sections.push(`  > Context: ${d.context.slice(0, 150)}`);
      }
    }
    sections.push(``);
  }

  if (openQuestions.length > 0) {
    sections.push(`## Open Questions / Unresolved`, ``);
    for (const q of openQuestions) {
      sections.push(`- ${q}`);
    }
    sections.push(``);
  }

  if (filePaths.length > 0) {
    sections.push(`## Files Modified This Session`, ``);
    for (const p of filePaths) {
      sections.push(`- ${p}`);
    }
    sections.push(``);
  }

  const content = sections.join("\n");

  // Write to auto-memory
  const memDir = getAutoMemoryDir(input.transcriptPath);
  if (memDir) {
    const statePath = join(memDir, "precompact-state.md");
    try {
      writeFileSync(statePath, content, "utf-8");
    } catch (e) {
      process.stderr.write(`precompact-extract: failed to write state: ${e}\n`);
    }

    // Reindex the auto-memory collection so extracted memories are immediately searchable
    try {
      const config = loadConfig();
      const collectionsMap = config.collections || {};
      // Find collection covering this memory dir
      const memEntry = Object.entries(collectionsMap).find(([, c]) =>
        memDir.startsWith(c.path) || c.path.startsWith(memDir)
      );
      if (memEntry) {
        const [colName, col] = memEntry;
        await indexCollection(store, colName, col.path, col.pattern || "**/*.md");
      }
    } catch (e) {
      process.stderr.write(`precompact-extract: archive reindex failed (non-fatal): ${e}\n`);
    }
  }

  // Audit trail
  try {
    store.insertUsage({
      sessionId: input.sessionId || "unknown",
      timestamp: now,
      hookName: "precompact-extract",
      injectedPaths: [],
      estimatedTokens: estimateTokens(content),
      wasReferenced: 0,
    });
  } catch {
    // non-critical
  }

  return makeEmptyOutput("precompact-extract");
}
