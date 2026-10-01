/**
 * Local Observer Agent - Structured observation extraction using local GGUF model
 *
 * Uses Qwen3-1.7B (already loaded for query expansion) with XML-formatted prompts
 * to extract structured observations and session summaries from transcripts.
 * Falls back gracefully when model is unavailable.
 */

import { createHash } from "crypto";
import type { TranscriptMessage } from "./hooks.ts";
import {
  monoNow, deadlineAfter, duration, remainingForTimeout, evidenceMs, elapsed, timeoutSignal,
  type DurationMs, type MonoDeadline,
} from "./clock.ts";
import {
  getDefaultLlamaCpp, budgetLayerOf, fingerprintVerdict, type BudgetLlm, type LlmBackendId, type LlmCapacity, type ChatTokenCount,
  type OverheadStore,
} from "./llm.ts";
import { withRetryAndFeedback, type RetryLlm } from "./llm-retry.ts";
import { isSchemaPlaceholder } from "./schema-placeholder.ts";
import { MAX_LLM_GENERATE_TIMEOUT_MS } from "./limits.ts";

// =============================================================================
// Types
// =============================================================================

export type Observation = {
  type: "decision" | "bugfix" | "feature" | "refactor" | "discovery" | "change" | "preference" | "milestone" | "problem";
  title: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  triples?: ParsedTriple[];
};

export type ParsedTriple = {
  subject: string;
  predicate: string;
  object: string;
};

export type SessionSummary = {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
};

// =============================================================================
// Config
// =============================================================================

const MAX_TRANSCRIPT_MESSAGES = 100;
const MAX_USER_MSG_CHARS = 200;
const MAX_ASSISTANT_MSG_CHARS = 500;
const MAX_TRANSCRIPT_TOKENS = 2000;
const GENERATION_MAX_TOKENS = 2000;
const GENERATION_TEMPERATURE = 0.3;

// =============================================================================
// System Prompts
// =============================================================================

const OBSERVATION_SYSTEM_PROMPT = `You are an observer analyzing a coding session transcript. Extract structured observations.
For each significant action, decision, or discovery, output an <observation> XML element with the structure below.

Structure:
<observation>
  <type>...</type>
  <title>...</title>
  <facts>
    <fact>...</fact>
  </facts>
  <triples>
    <triple>
      <subject>...</subject>
      <predicate>...</predicate>
      <object>...</object>
    </triple>
  </triples>
  <narrative>...</narrative>
  <concepts>
    <concept>...</concept>
  </concepts>
  <files_read><file>...</file></files_read>
  <files_modified><file>...</file></files_modified>
</observation>

Field rules:
- <type>: one of decision, bugfix, feature, refactor, discovery, change, preference, milestone, problem
- <title>: brief descriptive title, max 80 chars
- <facts>: 1-5 <fact> elements, each a standalone atomic claim about what happened or what is true (concrete, specific, no schema placeholders or template text)
- <triples>: 0-3 <triple> elements for structural relationships between named entities (see predicate vocabulary below). Omit entirely if no relational claims apply. Do NOT emit triples for descriptive facts — only for explicit S-P-O relations.
- <narrative>: 2-3 sentences explaining WHY something was done, not just WHAT
- <concepts>: 0-3 <concept> elements from: how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off
- <files_read>, <files_modified>: only files explicitly mentioned in the transcript

Predicate vocabulary (use EXACTLY these predicates in <predicate>, nothing else):
- adopted, migrated_to — switching to a new tool/framework/approach
- deployed_to, runs_on — where something runs
- replaced — when one thing supersedes another
- depends_on, integrates_with, uses — structural dependencies
- prefers, avoids — user preferences (use for <subject>user</subject>)
- caused_by, resolved_by — causal relationships between problems and fixes
- owned_by — responsibility / ownership

<subject> and <object> must be short canonical entity names (2-80 chars). No sentences. No placeholder text. If you cannot fit a claim into this vocabulary, keep it in <facts> instead and omit the triple.

Observation rules:
- Output 1-{N} observations, focusing on the MOST significant events
- If no significant observations, output nothing
- Never use schema example text or template placeholders in <fact>, <subject>, or <object> — emit only real content extracted from the transcript

Type guidance:
- preference: user expresses a preference, habit, or way of working (e.g., "don't use subagents for this", "I prefer single PRs")
- milestone: significant completion point, version release, deployment, or phase transition
- problem: persistent issue, recurring bug, architectural limitation, or unresolved blocker`;

const SUMMARY_SYSTEM_PROMPT = `You are a session summarizer. Analyze this coding session transcript and output a structured summary.

<summary>
  <request>What the user originally asked for (1-2 sentences)</request>
  <investigated>What was explored or researched (1-2 sentences)</investigated>
  <learned>Key insights or discoveries (1-2 sentences)</learned>
  <completed>What was actually accomplished (1-2 sentences)</completed>
  <next_steps>What should happen next (1-2 sentences)</next_steps>
</summary>

Rules:
- Be concise and specific
- Focus on outcomes, not process
- If a section has nothing relevant, write "None"`;

// =============================================================================
// Transcript Preparation — Priority-Based Formatting
//
// Priority levels (lower = more important):
//   P0 — First user message (original request)
//   P1 — Last assistant message (final response)
//   P2 — Tool calls + tool errors
//   P3 — Other user/assistant messages
//   P4 — System messages
// =============================================================================

const P_USER_INSTRUCTION = 0;
const P_FINAL_RESPONSE = 1;
const P_TOOL_ACTIVITY = 2;
const P_CONVERSATION = 3;
const P_SYSTEM = 4;

export type PrioritizedMessage = {
  priority: number;
  index: number;  // original position for chronological reassembly
  role: string;
  content: string;
};

function isToolContent(content: string): boolean {
  return content.includes("[tool_use") || content.includes("[tool_result");
}

export function classifyMessages(messages: TranscriptMessage[]): PrioritizedMessage[] {
  const classified: PrioritizedMessage[] = [];
  let firstUserSeen = false;

  // Find last assistant message that is NOT a tool message (real final response)
  const lastRealAssistantIdx = messages.reduce(
    (last, m, i) => (m.role === "assistant" && !isToolContent(m.content)) ? i : last, -1
  );

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    let priority: number;

    // Tool content check first — tool messages in assistant role stay P2
    if (isToolContent(msg.content)) {
      priority = P_TOOL_ACTIVITY;
    } else if (msg.role === "user" && !firstUserSeen) {
      priority = P_USER_INSTRUCTION;
      firstUserSeen = true;
    } else if (msg.role === "assistant" && i === lastRealAssistantIdx) {
      priority = P_FINAL_RESPONSE;
    } else if (msg.role === "system") {
      priority = P_SYSTEM;
    } else {
      priority = P_CONVERSATION;
    }

    classified.push({ priority, index: i, role: msg.role, content: msg.content });
  }

  return classified;
}

/**
 * The transcript as the observer reads it, at most `charBudget` characters (~4 per token). v0.41.1: the budget is
 * the caller's — the observer gives its transcript what the CONTEXT section leaves of the render budget.
 */
export function prepareTranscript(messages: TranscriptMessage[], charBudget: number = MAX_TRANSCRIPT_TOKENS * 4): string {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);

  const classified = classifyMessages(recent);

  // Phase 1: Critical (P0 + P1) — always included, truncated to per-role limits
  const critical = classified.filter(m => m.priority <= P_FINAL_RESPONSE);
  const criticalLines = critical.map(m => {
    const maxChars = m.role === "user" ? MAX_USER_MSG_CHARS * 2 : MAX_ASSISTANT_MSG_CHARS * 2;
    const content = m.content.length > maxChars ? m.content.slice(0, maxChars) + "..." : m.content;
    return { ...m, content, formatted: `[${m.role}]: ${content}` };
  });
  let used = criticalLines.reduce((sum, l) => sum + l.formatted.length + 1, 0);

  // Phase 2: Tool activity (P2) — budget-allocated, truncate to fit (not drop)
  const toolMsgs = classified.filter(m => m.priority === P_TOOL_ACTIVITY);
  const toolLines: typeof criticalLines = [];
  for (const m of toolMsgs) {
    if (used >= charBudget) break;
    const remaining = charBudget - used;
    const prefix = `[${m.role}]: `;
    const overhead = prefix.length + 1; // +1 for newline join
    if (remaining <= overhead + 20) break; // not enough room for meaningful content
    const contentBudget = Math.min(500, remaining - overhead);
    const content = m.content.length > contentBudget
      ? m.content.slice(0, contentBudget - 3) + "..."
      : m.content;
    const formatted = `${prefix}${content}`;
    toolLines.push({ ...m, content, formatted });
    used += formatted.length + 1;
  }

  // Phase 3: Conversation (P3) — fills remaining budget
  const convMsgs = classified.filter(m => m.priority === P_CONVERSATION);
  const convLines: typeof criticalLines = [];
  for (const m of convMsgs) {
    if (used >= charBudget) break;
    const maxChars = m.role === "user" ? MAX_USER_MSG_CHARS : MAX_ASSISTANT_MSG_CHARS;
    const content = m.content.length > maxChars ? m.content.slice(0, maxChars) + "..." : m.content;
    const formatted = `[${m.role}]: ${content}`;
    if (used + formatted.length + 1 <= charBudget) {
      convLines.push({ ...m, content, formatted });
      used += formatted.length + 1;
    }
  }

  // Reassemble in chronological order
  const all = [...criticalLines, ...toolLines, ...convLines];
  all.sort((a, b) => a.index - b.index);

  // Phase 1 is kept whatever the budget; under a budget smaller than it (the CONTEXT's share), the latest text is.
  const out = all.map(l => l.formatted).join("\n");
  if (out.length <= charBudget) return out;
  const tail = out.slice(out.length - charBudget + 1);
  return "…" + (LOW_SURROGATE_FIRST.test(tail) ? tail.slice(1) : tail);
}

/** A cut must not leave half of a surrogate pair: llama-server refuses a lone surrogate in the request (HTTP 500). */
const LOW_SURROGATE_FIRST = /^[\uDC00-\uDFFF]/;
const HIGH_SURROGATE_LAST = /[\uD800-\uDBFF]$/;

// =============================================================================
// XML Parsers
// =============================================================================

const VALID_OBSERVATION_TYPES = new Set([
  "decision", "bugfix", "feature", "refactor", "discovery", "change",
  "preference", "milestone", "problem",
]);

const VALID_CONCEPTS = new Set([
  "how-it-works", "why-it-exists", "what-changed", "problem-solution",
  "gotcha", "pattern", "trade-off",
]);

// Canonical SPO predicate vocabulary — parser rejects anything outside this set.
// Must stay in sync with the predicate list in OBSERVATION_SYSTEM_PROMPT.
export const VALID_PREDICATES = new Set([
  "adopted", "migrated_to",
  "deployed_to", "runs_on",
  "replaced",
  "depends_on", "integrates_with", "uses",
  "prefers", "avoids",
  "caused_by", "resolved_by",
  "owned_by",
]);

// Predicates whose <object> should be stored as a literal (not resolved to an entity).
export const LITERAL_PREDICATES = new Set(["prefers", "avoids"]);

// Anti-parrot residue guard (SCHEMA_PLACEHOLDER_STRINGS / isMarkerOnly / isSchemaPlaceholder)
// now lives in ./schema-placeholder.ts, shared with the consolidation + conversation-synthesis
// extraction paths. Imported at the top of this file.

export function parseObservationXml(xml: string): Observation | null {
  const typeMatch = xml.match(/<type>\s*(.*?)\s*<\/type>/s);
  const titleMatch = xml.match(/<title>\s*(.*?)\s*<\/title>/s);
  const narrativeMatch = xml.match(/<narrative>\s*(.*?)\s*<\/narrative>/s);

  if (!typeMatch?.[1] || !titleMatch?.[1]) return null;

  const type = typeMatch[1].trim().toLowerCase();
  if (!VALID_OBSERVATION_TYPES.has(type)) return null;

  const rawTitle = titleMatch[1].trim();
  if (isSchemaPlaceholder(rawTitle)) return null;

  const facts = extractMultiple(xml, "fact")
    .filter(f => f.length >= 5)
    .filter(f => !isSchemaPlaceholder(f));

  const concepts = extractMultiple(xml, "concept")
    .filter(c => VALID_CONCEPTS.has(c.toLowerCase()))
    .map(c => c.toLowerCase());
  const filesRead = extractMultiple(xml, "file", "files_read");
  const filesModified = extractMultiple(xml, "file", "files_modified");

  // Parse triples (Fix A): strict validation against canonical predicate vocabulary.
  // Missing/malformed triples are silently dropped — fail-closed on ambiguity.
  const triples = extractTriples(xml);

  return {
    type: type as Observation["type"],
    title: rawTitle.slice(0, 80),
    facts,
    narrative: narrativeMatch?.[1]?.trim() || "",
    concepts,
    filesRead,
    filesModified,
    triples: triples.length > 0 ? triples : undefined,
  };
}

function extractTriples(xml: string): ParsedTriple[] {
  const parentMatch = xml.match(/<triples>([\s\S]*?)<\/triples>/s);
  if (!parentMatch?.[1]) return [];

  const blockRegex = /<triple>([\s\S]*?)<\/triple>/g;
  const results: ParsedTriple[] = [];
  let match;
  while ((match = blockRegex.exec(parentMatch[1])) !== null) {
    const block = match[1] ?? "";
    const subject = block.match(/<subject>\s*(.*?)\s*<\/subject>/s)?.[1]?.trim();
    const rawPredicate = block.match(/<predicate>\s*(.*?)\s*<\/predicate>/s)?.[1]?.trim();
    const object = block.match(/<object>\s*(.*?)\s*<\/object>/s)?.[1]?.trim();

    if (!subject || !rawPredicate || !object) continue;

    const predicate = rawPredicate.toLowerCase().replace(/\s+/g, "_");
    if (!VALID_PREDICATES.has(predicate)) continue;

    // Length bounds — guards against sentence-shaped subjects/objects that the
    // regex-era tests expected. Subject and object should be short canonical names.
    if (subject.length < 2 || subject.length > 80) continue;
    if (object.length < 2 || object.length > 120) continue;

    // Identifier scope: a subject/object is an entity name or literal value, not an
    // assertion — `${HOME}` is a legitimate object of `uses` / `depends_on` / `prefers`.
    if (isSchemaPlaceholder(subject, undefined, "identifier") ||
        isSchemaPlaceholder(object, undefined, "identifier")) continue;

    results.push({ subject, predicate, object });

    if (results.length >= 5) break; // cap per observation
  }
  return results;
}

export function parseSummaryXml(xml: string): SessionSummary | null {
  const request = extractSingle(xml, "request");
  const investigated = extractSingle(xml, "investigated");
  const learned = extractSingle(xml, "learned");
  const completed = extractSingle(xml, "completed");
  const nextSteps = extractSingle(xml, "next_steps");

  if (!request && !completed) return null;

  return {
    request: request || "Unknown",
    investigated: investigated || "None",
    learned: learned || "None",
    completed: completed || "None",
    nextSteps: nextSteps || "None",
  };
}

function extractSingle(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, "s"));
  return match?.[1]?.trim() || null;
}

function extractMultiple(xml: string, tag: string, parentTag?: string): string[] {
  let scope = xml;
  if (parentTag) {
    const parentMatch = xml.match(new RegExp(`<${parentTag}>([\\s\\S]*?)</${parentTag}>`, "s"));
    if (!parentMatch?.[1]) return [];
    scope = parentMatch[1];
  }

  const results: string[] = [];
  const regex = new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, "gs");
  let match;
  while ((match = regex.exec(scope)) !== null) {
    const text = match[1]?.trim();
    if (text) results.push(text);
  }
  return results;
}

// =============================================================================
// Core Extraction Functions
// =============================================================================

/** The observer's outcome for one batch (62.1 D3): only `ok` and `empty` may commit a range's effects. */
export type ObservationResult =
  | { status: "ok"; observations: Observation[] }
  | { status: "empty" }
  | { status: "retryable"; reason: string };

/** What the batch must not re-extract (62.1 D4): the turns just before it and this session's recorded titles. */
export type ObservationContext = { priorMessages: TranscriptMessage[]; recordedTitles: string[] };

/** A valid empty completion ("If no significant observations, output nothing"), passed through the retry helper. */
const EMPTY_COMPLETION = "\u0000observer:empty-completion\u0000";
/** A reply with no observation blocks and no markup, short enough to be a plain "nothing" rather than lost output. */
const PLAIN_NOTHING_MAX_CHARS = 300;

/**
 * The CONTEXT section's share of the render budget (v0.41.1). The section is at most this long, the transcript gets the
 * rest, and batches are packed to leave it (stop-extract.ts), so CONTEXT + transcript stay within
 * OBSERVER_MAX_RENDER_CHARS — the prompt v0.40 sent at its largest, which the documented `-c 4096` was sized for.
 */
export const OBSERVER_CONTEXT_MAX_CHARS = 2_000;
/**
 * A retry's feedback block (llm-retry.ts: its fixed lines, the parse error, up to 500 characters of the response) and
 * the blank line before it, at most (805 with the observer's longest error). A retry takes it out of the transcript's
 * budget, so every attempt stays within OBSERVER_MAX_RENDER_CHARS (v0.41.1).
 */
export const OBSERVER_RETRY_FEEDBACK_MAX_CHARS = 850;
/** What a batch leaves of the render budget: the CONTEXT and a retry's feedback, so it reaches the model whole on every attempt. */
export const OBSERVER_BATCH_RESERVED_CHARS = OBSERVER_CONTEXT_MAX_CHARS + OBSERVER_RETRY_FEEDBACK_MAX_CHARS;
/** Within it: the prior turns' text, the titles' lines, and one title's length. Headers take ~100 more (1,901 at most in all). */
const CONTEXT_PRIOR_CHARS = 1_100;
const CONTEXT_TITLES_CHARS = 700;
const CONTEXT_TITLE_CHARS = 100;

function renderContextSection(ctx: ObservationContext | undefined): string {
  if (!ctx || (ctx.priorMessages.length === 0 && ctx.recordedTitles.length === 0)) return "";
  const lines = ["--- CONTEXT (already recorded — do not extract) ---"];
  if (ctx.priorMessages.length > 0) lines.push(prepareTranscript(ctx.priorMessages, CONTEXT_PRIOR_CHARS));
  // The newest titles that fit (the list is oldest first), kept in that order.
  const titles: string[] = [];
  let used = 0;
  for (let i = ctx.recordedTitles.length - 1; i >= 0; i--) {
    const t = ctx.recordedTitles[i]!;
    const head = t.slice(0, CONTEXT_TITLE_CHARS - 1);
    const line = `- ${t.length > CONTEXT_TITLE_CHARS ? (HIGH_SURROGATE_LAST.test(head) ? head.slice(0, -1) : head) + "…" : t}`;
    if (used + line.length + 1 > CONTEXT_TITLES_CHARS) break;
    titles.unshift(line);
    used += line.length + 1;
  }
  if (titles.length > 0) lines.push("Already recorded observations:", ...titles);
  lines.push("--- END CONTEXT ---", "");
  return lines.join("\n") + "\n";
}

/**
 * A COMPLETE observer reply (the server's `finish_reason: "stop"`) as observations (62.1 D3): the observation blocks,
 * or a plain short "nothing" (no markup, ≤ PLAIN_NOTHING_MAX_CHARS) as `[]`, or a parse error. v0.41.2: never applied
 * to a reply the server cut (`finish: "length"`) — a cut reply is never `[]` (design §1.4, P2).
 */
export function parseObservationReply(text: string): { ok: true; value: Observation[] } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, value: [] };
  const observations: Observation[] = [];
  let blocks = 0;
  const regex = /<observation>([\s\S]*?)<\/observation>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks++;
    const obs = parseObservationXml(match[1]!);
    if (obs) observations.push(obs);
  }
  if (observations.length > 0) return { ok: true, value: observations };
  if (blocks === 0 && !/[<>]/.test(text) && text.trim().length <= PLAIN_NOTHING_MAX_CHARS) return { ok: true, value: [] };
  return {
    ok: false,
    error:
      blocks === 0
        ? "No <observation>...</observation> blocks found in the response. Wrap each observation in <observation> tags."
        : `Found ${blocks} <observation> block(s) but none contained the required fields. Each block needs valid <type>, <content>, and the documented child tags.`,
  };
}

// =============================================================================
// v0.41.2 (BACKLOG 68.5): the observer's token budget and windows — DESIGN-v0412.md §1.3–§1.4
// =============================================================================

/** Bump with any change to `parseObservationXml` / `parseObservationReply` (a checkpoint's contract includes it). */
export const OBSERVER_PARSER_VERSION = 2;
/** Bump with any change to how the windows are assembled that the contract's hashed strings would not show. */
export const OBSERVER_CONTRACT_VERSION = 1;
/** E3: one observation's reply ran 360 tokens. */
const OBSERVATION_REPLY_TOKENS = 360;
const REPLY_FLOOR_TOKENS = 768;
/** A window must carry at least this much transcript after the fixed part and the CONTEXT. */
const MIN_TRANSCRIPT_TOKENS = 512;
/** At most this many model calls per invocation (windows, halvings, format retries). */
export const MAX_OBSERVER_CALLS = 6;
/** The causal writer's floor and reserve (`src/causal-writer.ts` CAUSAL_MIN_BUDGET_MS / PERSIST_RESERVE_MS). */
const CALL_FLOOR_MS = 3_000;
const CALL_RESERVE_MS = 2_000;
/** The first estimate of one observer call, counting included; replaced by the process's measured mean. */
const DEFAULT_CALL_MS = 4_000;
/** How much of the previous window's tail window k > 1 shows as EARLIER text. */
const EARLIER_CHARS = 1_100;

const EARLIER_HEADER =
  "--- EARLIER IN THIS EXCHANGE (read it to interpret the transcript; extract an observation only when its key evidence is in the TRANSCRIPT section) ---";
const RECORDED_HEADER = "--- ALREADY RECORDED (do not repeat) ---";
const CONTEXT_END = "--- END CONTEXT ---";
const TRANSCRIPT_OPEN = "--- TRANSCRIPT ---";
const TRANSCRIPT_CLOSE = "--- END TRANSCRIPT ---\n\nExtract observations:";

/** The reply room the observer reserves at a context of `nCtx` tokens (design §1.3). */
export function observerReplyReserve(nCtx: number): number {
  return Math.min(GENERATION_MAX_TOKENS, Math.max(REPLY_FLOOR_TOKENS, Math.floor(0.4 * nCtx)));
}

/** How many observations the prompt asks for, aligned to the reply room (design §1.3). */
export function observerRequestedCount(reserve: number): number {
  return Math.min(5, Math.max(1, Math.floor((reserve - 64) / OBSERVATION_REPLY_TOKENS)));
}

/** The observer's system prompt asking for 1–`n` observations. */
export function observationSystemPrompt(n: number): string {
  return OBSERVATION_SYSTEM_PROMPT.replace("{N}", String(n));
}

/**
 * What the contract hashes (design §1.4): every static string the windows assemble — the system prompt, the CONTEXT /
 * EARLIER / ALREADY RECORDED sections and markers, the format-retry feedback — and every window-policy constant,
 * the CONTEXT's sizes included.
 */
export function observerContractInputs(): Record<string, unknown> {
  return {
    contract: OBSERVER_CONTRACT_VERSION, parser: OBSERVER_PARSER_VERSION, system: OBSERVATION_SYSTEM_PROMPT,
    sections: [EARLIER_HEADER, RECORDED_HEADER, CONTEXT_END, TRANSCRIPT_OPEN, TRANSCRIPT_CLOSE, "--- CONTEXT (already recorded — do not extract) ---", "Already recorded observations:"],
    feedback: [...FORMAT_FEEDBACK_LINES, FORMAT_FEEDBACK_EXCERPT_CHARS],
    policy: {
      replyFloor: REPLY_FLOOR_TOKENS, replyShare: 0.4, replyMax: GENERATION_MAX_TOKENS, perObservation: OBSERVATION_REPLY_TOKENS,
      minTranscript: MIN_TRANSCRIPT_TOKENS, maxCalls: MAX_OBSERVER_CALLS, earlierChars: EARLIER_CHARS,
      contextMaxChars: OBSERVER_CONTEXT_MAX_CHARS, contextPriorChars: CONTEXT_PRIOR_CHARS, contextTitlesChars: CONTEXT_TITLES_CHARS,
      contextTitleChars: CONTEXT_TITLE_CHARS, plainNothingMaxChars: PLAIN_NOTHING_MAX_CHARS,
    },
  };
}

/** A checkpoint written under another contract is never resumed (design §1.4). */
export function observerContract(): string {
  return createHash("sha256").update(JSON.stringify(observerContractInputs())).digest("hex");
}

/** One rendered transcript line, with the turn it belongs to. */
export type ObserverLine = { text: string; turn: number; opening: boolean };

/** A cut must not leave half of a surrogate pair (llama-server answers HTTP 500 to a lone surrogate). */
function cutAt(text: string, max: number): string {
  const head = text.slice(0, max);
  return HIGH_SURROGATE_LAST.test(head) ? head.slice(0, -1) : head;
}

/**
 * The unit's messages as the observer reads them — classified and capped exactly as `prepareTranscript` and
 * `observerRenderChars` cap each message — but with NO overall budget cut: one line per message, in order (design §1.4).
 */
export function renderObserverLines(messages: TranscriptMessage[]): ObserverLine[] {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const out: ObserverLine[] = [];
  for (const m of classifyMessages(recent)) {
    if (m.priority === P_SYSTEM) continue;
    const cap = m.priority <= P_FINAL_RESPONSE
      ? (m.role === "user" ? MAX_USER_MSG_CHARS * 2 : MAX_ASSISTANT_MSG_CHARS * 2)
      : m.priority === P_TOOL_ACTIVITY ? 500 : (m.role === "user" ? MAX_USER_MSG_CHARS : MAX_ASSISTANT_MSG_CHARS);
    const content = m.content.length > cap ? cutAt(m.content, cap) + "..." : m.content;
    const src = recent[m.index]!;
    out.push({ text: `[${m.role}]: ${content}`, turn: src.turn ?? 0, opening: src.opening === true });
  }
  return out;
}

/** sha256 of the rendered lines — a checkpoint resumes only over the same lines. */
export function observerLinesSha(lines: readonly ObserverLine[]): string {
  return createHash("sha256").update(lines.map(l => l.text).join("\n")).digest("hex");
}

/** Progress a window run has made (and a checkpoint stores). */
export type WindowProgress = { doneThroughLine: number; observations: Observation[]; titles: string[] };

export type WindowedResult =
  | { status: "ok"; observations: Observation[]; totalLines: number }
  | { status: "empty"; totalLines: number }
  | { status: "retryable"; reason: string }
  /** The call budget or the deadline ran out with lines left; the caller's checkpoint holds the progress. */
  | { status: "partial"; doneThroughLine: number; totalLines: number }
  /** The pinned backend could not be reached; `calls` = the model calls this invocation made. */
  | { status: "unavailable"; doneThroughLine: number; totalLines: number; calls: number }
  /** The server behind the backend changed during the invocation (verified fingerprints differ); the caller resets. */
  | { status: "server_changed" }
  /** The server could not be verified (its `/props` stopped answering); the caller keeps the progress and waits. */
  | { status: "unverified"; doneThroughLine: number; totalLines: number }
  /** `onProgress` lost its compare-and-swap: another processor got ahead. */
  | { status: "overtaken" };

/** The observer's measured call time is the mean of its latest this-many calls (codex T12-5: a window, not a decay). */
export const OBSERVER_CALL_SAMPLES = 50;
let callMeanMs = DEFAULT_CALL_MS;
let recentCalls: number[] = [];
let unpersisted: number[] = [];

/** The process's measured mean observer call (counting included) — the worker sizes its continuation slice by it. */
export function observerCallMeanMs(): number {
  return callMeanMs;
}

/** The mean of the latest OBSERVER_CALL_SAMPLES calls, and how many calls it covers. */
export function observerCallStats(): { meanMs: number; samples: number } {
  return { meanMs: callMeanMs, samples: recentCalls.length };
}

/** The calls measured since the last take (the latest OBSERVER_CALL_SAMPLES) — the Stop pipeline adds them to the vault's record. */
export function takeObserverCallSamples(): number[] {
  const taken = unpersisted;
  unpersisted = [];
  return taken;
}

export function resetObserverCallStatsForTest(): void {
  callMeanMs = DEFAULT_CALL_MS;
  recentCalls = [];
  unpersisted = [];
}

/** One model call that answered (codex T11-4: per call, not per window), with the counting that prepared it. */
function noteCall(ms: number): void {
  recentCalls = [...recentCalls, ms].slice(-OBSERVER_CALL_SAMPLES);
  callMeanMs = recentCalls.reduce((sum, x) => sum + x, 0) / recentCalls.length;
  unpersisted = [...unpersisted, ms].slice(-OBSERVER_CALL_SAMPLES);
}

function remainingMs(deadline: MonoDeadline): number {
  const left = remainingForTimeout(deadline);
  return left === null ? 0 : evidenceMs(left);
}

/** The model calls one invocation may make before `deadline` (design §1.4). */
export function observerCallBudget(deadline: MonoDeadline, maxCalls: number = MAX_OBSERVER_CALLS): number {
  const avail = remainingMs(deadline) - CALL_RESERVE_MS - CALL_FLOOR_MS;
  return Math.max(0, Math.min(maxCalls, Math.floor(avail / callMeanMs)));
}

/** The newest titles that fit, oldest first, as CONTEXT lines (today's rendering). */
function titleLines(titles: readonly string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = titles.length - 1; i >= 0; i--) {
    const t = titles[i]!;
    const head = cutAt(t, CONTEXT_TITLE_CHARS - 1);
    const line = `- ${t.length > CONTEXT_TITLE_CHARS ? head + "…" : t}`;
    if (used + line.length + 1 > CONTEXT_TITLES_CHARS) break;
    out.unshift(line);
    used += line.length + 1;
  }
  return out;
}

/** Window k > 1's CONTEXT candidates, fullest first (design §1.4): EARLIER (+ anchor) + ALREADY RECORDED, reduced. */
function laterWindowContexts(earlier: readonly ObserverLine[], anchor: string | null, recorded: readonly string[]): string[] {
  const tail: string[] = [];
  let used = 0;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const t = earlier[i]!.text;
    if (used + t.length + 1 > EARLIER_CHARS) break;
    tail.unshift(t);
    used += t.length + 1;
  }
  const titles = titleLines(recorded);
  const build = (earlierLines: string[], withTitles: boolean): string => {
    const parts: string[] = [];
    if (earlierLines.length > 0) parts.push(EARLIER_HEADER, ...earlierLines);
    if (withTitles && titles.length > 0) parts.push(RECORDED_HEADER, ...titles);
    return parts.length === 0 ? "" : [...parts, CONTEXT_END, ""].join("\n") + "\n";
  };
  const anchorLines = anchor !== null && !tail.includes(anchor) ? [anchor] : [];
  return [build([...anchorLines, ...tail], true), build(anchorLines, true), build([], true), ""];
}

/** Window 1's CONTEXT candidates, fullest first: today's section, then titles only, then none. */
function firstWindowContexts(ctx: ObservationContext | undefined): string[] {
  if (!ctx) return [""];
  return [renderContextSection(ctx), renderContextSection({ priorMessages: [], recordedTitles: ctx.recordedTitles }), ""];
}

function windowPrompt(n: number, context: string, lines: readonly ObserverLine[], feedback?: string): string {
  const body = `${observationSystemPrompt(n)}\n\n${context}${TRANSCRIPT_OPEN}\n${lines.map(l => l.text).join("\n")}\n${TRANSCRIPT_CLOSE}`;
  return feedback ? `${body}\n\n${feedback}` : body;
}

const FORMAT_FEEDBACK_LINES = [
  "The previous response did not match the expected structure.", "Error:", "Previous response (first 500 chars):",
  "Return only the expected structure this time.",
] as const;
const FORMAT_FEEDBACK_EXCERPT_CHARS = 500;

function formatFeedback(error: string, reply: string): string {
  const [head, label, excerpt, tail] = FORMAT_FEEDBACK_LINES;
  return [head, label, error, "", excerpt, cutAt(reply, FORMAT_FEEDBACK_EXCERPT_CHARS), "", tail].join("\n");
}

type FittedWindow = { end: number; prompt: string; count: ChatTokenCount };

/**
 * Fit the next window from `start` (design §1.3–§1.4): pick the fullest CONTEXT that leaves MIN_TRANSCRIPT_TOKENS, then
 * the most whole turns whose ASSEMBLED prompt fits B (counted, never summed); a turn is cut between messages only when
 * it alone exceeds a window. `{capacity}` when even one line, or the fixed part, cannot fit.
 */
async function fitWindow(a: {
  lines: readonly ObserverLine[]; start: number; maxLines: number; n: number; contexts: readonly string[];
  budget: number; feedback?: string; count: (prompt: string) => Promise<ChatTokenCount>; nCtx: number; source: string;
}): Promise<FittedWindow | { capacity: string }> {
  let context: string | null = null;
  let fixed: ChatTokenCount | null = null;
  for (const c of a.contexts) {
    const f = await a.count(windowPrompt(a.n, c, [], a.feedback));
    if (f.tokens + f.margin + MIN_TRANSCRIPT_TOKENS <= a.budget) { context = c; fixed = f; break; }
    fixed = f;
  }
  if (context === null || fixed === null) {
    const need = (fixed?.tokens ?? 0) + (fixed?.margin ?? 0) + MIN_TRANSCRIPT_TOKENS;
    return { capacity: `capacity: the observer's prompt needs ${need} tokens; the context is ${a.nCtx} (${a.source})` };
  }
  const last = Math.min(a.lines.length, a.start + Math.max(1, a.maxLines));
  const fits = (c: ChatTokenCount) => c.tokens + c.margin <= a.budget;
  const at = async (end: number): Promise<FittedWindow> => {
    const prompt = windowPrompt(a.n, context!, a.lines.slice(a.start, end), a.feedback);
    return { end, prompt, count: await a.count(prompt) };
  };
  let w = await at(last);
  if (fits(w.count)) return w;
  let smallestFailed = last;
  // Guess from this window's own density, prefer the last turn boundary at or before the guess, then shrink.
  const perLine = Math.max(1, (w.count.tokens - fixed.tokens) / (last - a.start));
  let end = a.start + Math.max(1, Math.min(last - a.start - 1, Math.floor(((a.budget - fixed.tokens - fixed.margin) / perLine) * 0.9)));
  for (let tries = 0; tries < 5; tries++) {
    let snap = end;
    while (snap > a.start + 1 && a.lines[snap]?.turn === a.lines[snap - 1]?.turn) snap--;
    if (snap > a.start && a.lines[snap]?.turn !== a.lines[snap - 1]?.turn) end = snap;
    w = await at(end);
    if (fits(w.count)) return w;
    smallestFailed = Math.min(smallestFailed, end);
    if (end - a.start <= 1) break;
    end = a.start + Math.max(1, Math.floor((end - a.start) * 0.7));
  }
  // codex T11-1: the guesses failed (skewed lines: one large line among many small ones). A line that fits alone is
  // never a capacity limit: test it, then binary-search the largest window below the smallest failure.
  const one = w.end === a.start + 1 ? w : await at(a.start + 1);
  if (!fits(one.count)) {
    const allowance = a.budget - fixed.tokens - fixed.margin;
    return { capacity: `capacity: one message needs ${one.count.tokens - fixed.tokens} tokens; a window holds ${allowance}` };
  }
  let lo = a.start + 1;
  let best = one;
  let hi = smallestFailed;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const m = await at(mid);
    if (fits(m.count)) { lo = mid; best = m; } else hi = mid;
  }
  // Whole turns where the window holds a turn boundary — the one right after the first line included — otherwise the
  // turn alone exceeds a window and is cut (codex T12-2). A boundary window counted here is sent only if it fits.
  for (let bnd = lo; bnd > a.start; bnd--) {
    if (a.lines[bnd]?.turn === a.lines[bnd - 1]?.turn) continue;
    if (bnd === lo) return best;
    if (bnd === a.start + 1) return one;
    const snapped = await at(bnd);
    if (fits(snapped.count)) return snapped;
  }
  return best;
}

/**
 * Extract a unit's observations in windows (design §1.3–§1.4). Each window's prompt + the reply reserve fits the
 * backend's context, read FRESH before every call (retries included) and checked against the server the run is pinned
 * to; a cut reply (`finish: "length"`) is never `empty` — the window is halved; a reply that did not finish as an
 * answer is retryable; one format retry per window, its feedback inside the window's budget. Progress goes to
 * `onProgress` after every completed window (the caller's durable checkpoint); `resume` continues from one.
 */
export async function extractObservationsWindowed(
  messages: TranscriptMessage[],
  opts: {
    llm: BudgetLlm; backend: LlmBackendId; deadline: MonoDeadline; context?: ObservationContext;
    resume?: WindowProgress; onProgress?: (p: WindowProgress) => boolean | Promise<boolean>;
    overheadStore?: OverheadStore; maxCalls?: number;
    /** The server the run (or its checkpoint) is pinned to; without one, the first capacity read pins it. */
    expectFingerprint?: string; expectStrength?: LlmCapacity["fingerprintStrength"];
  },
): Promise<WindowedResult> {
  const lines = renderObserverLines(messages);
  const total = lines.length;
  let pos = opts.resume?.doneThroughLine ?? 0;
  const observations: Observation[] = [...(opts.resume?.observations ?? [])];
  const produced: string[] = [...(opts.resume?.titles ?? [])];
  if (pos >= total) return observations.length > 0 ? { status: "ok", observations, totalLines: total } : { status: "empty", totalLines: total };
  let calls = observerCallBudget(opts.deadline, opts.maxCalls);
  let made = 0;
  let maxLines = Number.POSITIVE_INFINITY;
  let pinned = opts.expectFingerprint !== undefined
    ? { fingerprint: opts.expectFingerprint, strength: opts.expectStrength ?? ("strong" as const) }
    : null;
  let sinceCall = monoNow();

  type Budget = { cap: LlmCapacity; reserve: number; n: number; budget: number; count: (prompt: string) => Promise<ChatTokenCount> };
  /** The capacity, read FRESH (design §1.2) and checked against the pin; `override` = a validated oversize's n_ctx. */
  const readBudget = async (override?: number): Promise<Budget | "changed" | "unverified"> => {
    const read = await opts.llm.llmCapacity(opts.backend, { deadline: opts.deadline });
    if (pinned) {
      const verdict = fingerprintVerdict(pinned, read);
      if (verdict !== "same") return verdict;
    } else {
      pinned = { fingerprint: read.fingerprint, strength: read.fingerprintStrength };
    }
    const cap = override !== undefined && override < read.nCtx ? { ...read, nCtx: override } : read;
    const reserve = observerReplyReserve(cap.nCtx);
    return {
      cap, reserve, n: observerRequestedCount(reserve), budget: cap.nCtx - reserve,
      count: (prompt: string) => opts.llm.countChatTokens(opts.llm.outboundChatContent(prompt, opts.backend), cap, {
        deadline: opts.deadline, overheadStore: opts.overheadStore,
      }),
    };
  };
  const partial = (): WindowedResult => ({ status: "partial", doneThroughLine: pos, totalLines: total });
  const notSame = (v: "changed" | "unverified"): WindowedResult =>
    v === "changed" ? { status: "server_changed" } : { status: "unverified", doneThroughLine: pos, totalLines: total };

  while (pos < total) {
    if (calls <= 0 || remainingMs(opts.deadline) < CALL_FLOOR_MS + CALL_RESERVE_MS) return partial();
    let b = await readBudget();
    if (typeof b === "string") return notSame(b);
    const anchorOf = (start: number): string | null => {
      const t = lines[start]?.turn;
      if (start === 0 || t === undefined || lines[start - 1]?.turn !== t) return null;
      for (let i = start - 1; i >= 0; i--) if (lines[i]!.turn === t && lines[i]!.opening) return lines[i]!.text;
      return null;
    };
    const recorded = [...(opts.context?.recordedTitles ?? []), ...produced];
    const contexts = pos === 0 ? firstWindowContexts(opts.context) : laterWindowContexts(lines.slice(0, pos), anchorOf(pos), recorded);
    let feedback: string | undefined;
    const fit = (bb: Budget) => fitWindow({
      lines, start: pos, maxLines, n: bb.n, contexts, budget: bb.budget, feedback, count: bb.count, nCtx: bb.cap.nCtx, source: bb.cap.source,
    });
    let fitted = await fit(b);
    if ("capacity" in fitted) return { status: "retryable", reason: fitted.capacity };

    let correctedOnce = false;
    let formatRetried = false;
    let override: number | undefined;
    let retry: "format" | "resize" | null = null;
    for (;;) {
      if (calls <= 0 || remainingMs(opts.deadline) < CALL_FLOOR_MS + CALL_RESERVE_MS) return partial();
      if (retry !== null) {
        // Every retry reads the capacity again (design §1.2) and re-fits to it.
        const nb = await readBudget(override);
        if (typeof nb === "string") return notSame(nb);
        b = nb;
        const refit = await fit(b);
        if ("capacity" in refit) return { status: "retryable", reason: retry === "format" ? "no parseable response within the budget" : refit.capacity };
        fitted = refit;
      }
      calls--;
      made++;
      const maxTokens = Math.max(1, Math.min(GENERATION_MAX_TOKENS, b.cap.nCtx - fitted.count.tokens - fitted.count.margin));
      const reply = await opts.llm.generateDetailed(fitted.prompt, {
        maxTokens, temperature: GENERATION_TEMPERATURE, signal: timeoutSignal(opts.deadline) ?? undefined, backend: opts.backend,
      });
      if (reply.ok) noteCall(evidenceMs(elapsed(sinceCall)));
      sinceCall = monoNow();
      if (!reply.ok && reply.reason === "context_exceeded") {
        // A validated oversize: the count that fed this prompt was low — a measured overhead behind it is stale (§1.2).
        if (fitted.count.method === "content") opts.llm.invalidateOverhead?.(b.cap.fingerprint, opts.overheadStore);
        if (!correctedOnce && typeof reply.promptTokens === "number") {
          // Re-size once from the server's own count and n_ctx (design §1.2): this window's lines scaled to the room left.
          correctedOnce = true;
          override = reply.nCtx;
          const nCtx = reply.nCtx ?? b.cap.nCtx;
          const room = nCtx - observerReplyReserve(nCtx) - fitted.count.margin;
          const scale = Math.max(0.1, Math.min(0.9, room / reply.promptTokens));
          maxLines = Math.max(1, Math.floor((fitted.end - pos) * scale));
          retry = "resize";
          continue;
        }
      }
      if (!reply.ok) {
        if (reply.reason === "unavailable" || reply.reason === "aborted") return { status: "unavailable", doneThroughLine: pos, totalLines: total, calls: made };
        return { status: "retryable", reason: reply.reason === "context_exceeded" ? "context exceeded after a corrected window" : "model unavailable" };
      }
      if (reply.finish === "length") {
        // A cut reply is never success (P2): halve the window and redo it; one line still cut is a capacity limit.
        const size = fitted.end - pos;
        if (size <= 1) return { status: "retryable", reason: `capacity: one message's observations exceed the ${b.reserve}-token reply` };
        maxLines = Math.max(1, Math.floor(size / 2));
        feedback = undefined;
        retry = "resize";
        continue;
      }
      // codex T11-2: only a reply that finished as an answer is parsed (design §1.4) — never read as "nothing".
      if (reply.finish !== "stop") return { status: "retryable", reason: "the model's reply did not finish as an answer" };
      const parsed = parseObservationReply(reply.text);
      if (parsed.ok) {
        observations.push(...parsed.value);
        produced.push(...parsed.value.map(o => o.title));
        break;
      }
      if (formatRetried) return { status: "retryable", reason: "no parseable response within the budget" };
      // One format retry: its feedback comes out of THIS window's budget (the same lines, re-fitted, re-counted).
      formatRetried = true;
      feedback = formatFeedback(parsed.error, reply.text);
      maxLines = fitted.end - pos;
      retry = "format";
    }
    pos = fitted.end;
    maxLines = Number.POSITIVE_INFINITY;
    if (opts.onProgress && pos < total) {
      const kept = await opts.onProgress({ doneThroughLine: pos, observations: [...observations], titles: [...produced] });
      if (!kept) return { status: "overtaken" };
    }
  }
  return observations.length > 0 ? { status: "ok", observations, totalLines: total } : { status: "empty", totalLines: total };
}

/**
 * Extract observations from one batch, reporting WHY it has none (62.1 D3): `empty` is a valid model answer with
 * nothing to record; `retryable` is a failure (model unavailable, timeout, output that never parses, a capacity limit)
 * that must not commit the batch. v0.41.2: one invocation of the windowed extractor on the active backend, no
 * checkpoint — the Stop pipeline calls `extractObservationsWindowed` itself. Admission is the caller's.
 */
export async function extractObservationsResult(
  messages: TranscriptMessage[],
  opts?: { timeoutMs?: DurationMs; context?: ObservationContext },
): Promise<ObservationResult> {
  const llm = budgetLayerOf(getDefaultLlamaCpp());
  const backend = llm.activeLlmBackend();
  if (!backend) return { status: "retryable", reason: "model unavailable" };
  const deadline = deadlineAfter(monoNow(), opts?.timeoutMs ?? duration(MAX_LLM_GENERATE_TIMEOUT_MS));
  const r = await extractObservationsWindowed(messages, { llm, backend, deadline, context: opts?.context });
  if (r.status === "ok") return { status: "ok", observations: r.observations };
  if (r.status === "empty") return { status: "empty" };
  if (r.status === "retryable") return { status: "retryable", reason: r.reason };
  if (r.status === "partial") return { status: "retryable", reason: `observer budget exhausted (${r.doneThroughLine}/${r.totalLines} lines)` };
  if (r.status === "unverified" || r.status === "server_changed") return { status: "retryable", reason: "the LLM server changed or could not be verified" };
  return { status: "retryable", reason: "model unavailable" };
}

/** The pre-62.1 form: observations, or [] for anything else (below 4 messages, empty, or failed). */
export async function extractObservations(
  messages: TranscriptMessage[],
  /** s342 D2: the Stop handler threads its remaining whole-handler budget here
   *  so extraction cannot outlive `CLAWMEM_STOP_BUDGET_MS`. Omitted → the
   *  retry helper's default wall-clock cap applies (non-hook callers). */
  opts?: { timeoutMs?: DurationMs }
): Promise<Observation[]> {
  if (messages.length < 4) return [];
  const r = await extractObservationsResult(messages, opts);
  return r.status === "ok" ? r.observations : [];
}

/**
 * The characters `prepareTranscript` would render for these messages before its overall budget applies (62.1 D4
 * batch packing): each message capped as the observer caps it, one line each.
 */
export function observerRenderChars(messages: TranscriptMessage[]): number {
  let total = 0;
  for (const m of classifyMessages(messages.slice(-MAX_TRANSCRIPT_MESSAGES))) {
    const cap = m.priority <= P_FINAL_RESPONSE
      ? (m.role === "user" ? MAX_USER_MSG_CHARS * 2 : MAX_ASSISTANT_MSG_CHARS * 2)
      : m.priority === P_TOOL_ACTIVITY ? 500 : (m.role === "user" ? MAX_USER_MSG_CHARS : MAX_ASSISTANT_MSG_CHARS);
    const content = m.content.length > cap ? m.content.slice(0, cap) + "..." : m.content;
    total += `[${m.role}]: ${content}`.length + 1;
  }
  return total;
}

/** The observer's input bounds a batch must fit (62.1 D4). */
export const OBSERVER_MAX_MESSAGES = MAX_TRANSCRIPT_MESSAGES;
export const OBSERVER_MAX_RENDER_CHARS = MAX_TRANSCRIPT_TOKENS * 4;

/** One turn as the summary step sees it (62.1 D5 digests). */
export type TurnDigestText = { request: string; outcome: string; files: string[] };

/** The summary's outcome for one batch (62.1 D5): `retryable` changes nothing but the audit. */
export type SummaryResult = { status: "ok"; summary: SessionSummary } | { status: "retryable"; reason: string };

/** v0.41.2 (design §1.5): a digest's file list renders at most this many paths. */
const DIGEST_FILES_RENDERED = 10;

/** A digest as one prompt line (also the unit the summary batches are packed by). */
export function renderDigestLine(d: TurnDigestText, n: number): string {
  const files = d.files.length > DIGEST_FILES_RENDERED
    ? `${d.files.slice(0, DIGEST_FILES_RENDERED).join(", ")} (+${d.files.length - DIGEST_FILES_RENDERED} more)`
    : d.files.join(", ");
  return `${n}. Request: ${d.request || "(continued turn)"} | Outcome: ${d.outcome || "(none)"}${d.files.length > 0 ? ` | Files: ${files}` : ""}`;
}

/** v0.41.2 (design §1.5): a stored summary's field bounds — the request, and each other field. */
const SUMMARY_REQUEST_CHARS = 600;
const SUMMARY_FIELD_CHARS = 800;

/**
 * A summary within its field bounds (design §1.5): applied when a summary is stored — the incremental step's merged
 * result (the preserved request + the new fields) included — and when an older stored one is rendered.
 */
export function capSummary(s: SessionSummary): SessionSummary {
  const cap = (t: string, n: number) => (t.length > n ? cutAt(t, n - 1) + "…" : t);
  return {
    request: cap(s.request, SUMMARY_REQUEST_CHARS), investigated: cap(s.investigated, SUMMARY_FIELD_CHARS),
    learned: cap(s.learned, SUMMARY_FIELD_CHARS), completed: cap(s.completed, SUMMARY_FIELD_CHARS),
    nextSteps: cap(s.nextSteps, SUMMARY_FIELD_CHARS),
  };
}

/** A summary as prompt text (the previous summary an incremental call carries), within its field bounds. */
export function renderSummaryText(s: SessionSummary): string {
  const c = capSummary(s);
  return [
    `Request: ${c.request}`, `Investigated: ${c.investigated}`, `Learned: ${c.learned}`,
    `Completed: ${c.completed}`, `Next steps: ${c.nextSteps}`,
  ].join("\n");
}

const INCREMENTAL_SUMMARY_NOTE = `You are given the summary of the session so far (when there is one), the turns since it (oldest first), and the text of the latest of those turns. Output the updated summary of the WHOLE session so far, in the same format.`;

function parseSummaryResponse(text: string): { ok: true; value: SessionSummary } | { ok: false; error: string } {
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (!summaryMatch?.[1]) {
    return { ok: false, error: "No <summary>...</summary> block found in the response. Wrap the summary in <summary> tags." };
  }
  const summary = parseSummaryXml(summaryMatch[1]);
  if (!summary) return { ok: false, error: "A <summary> block was found but its child tags were missing or invalid." };
  return { ok: true, value: summary };
}

function incrementalSummaryPrompt(previous: SessionSummary | null, digests: readonly TurnDigestText[], recentText: string, feedback?: string): string {
  const parts = [SUMMARY_SYSTEM_PROMPT, "", INCREMENTAL_SUMMARY_NOTE, ""];
  if (previous) parts.push("--- PREVIOUS SUMMARY ---", renderSummaryText(previous), "--- END PREVIOUS SUMMARY ---", "");
  parts.push("--- NEW TURNS (oldest first) ---", ...digests.map((d, i) => renderDigestLine(d, i + 1)), "--- END NEW TURNS ---", "");
  if (recentText) parts.push("--- RECENT TRANSCRIPT ---", recentText, "--- END RECENT TRANSCRIPT ---", "");
  parts.push("Generate the updated summary:");
  if (feedback) parts.push("", feedback);
  return parts.join("\n");
}

/** v0.41.2: the summary's reply room. */
const SUMMARY_REPLY_TOKENS = 500;
const SUMMARY_BREVITY = "Your previous summary was cut off before it ended. Keep each field under 120 words.";

export type FittedSummaryResult =
  | { status: "ok"; summary: SessionSummary; digestsUsed: number }
  | { status: "retryable"; reason: string };

/**
 * 62.1 D5 + v0.41.2 §1.5: the previous summary + the first digests that fit + the recent text → the updated summary,
 * with its prompt + a 500-token reply inside the backend's context (read fresh). Over budget: the recent text goes
 * first, then digests from the end (at least one stays; `digestsUsed` tells the caller how far its watermark moves);
 * one digest still over → `capacity:`. A cut reply gets one brevity retry, a parse failure one feedback retry — both
 * rebuilt within the budget. The stored result is bounded (`capSummary`); the opening request survives.
 */
export async function extractSummaryFitted(
  previous: SessionSummary | null,
  digests: readonly TurnDigestText[],
  recentText: string,
  opts: { deadline: MonoDeadline; llm?: BudgetLlm; overheadStore?: OverheadStore },
): Promise<FittedSummaryResult> {
  const llm = opts.llm ?? budgetLayerOf(getDefaultLlamaCpp());
  const backend = llm.activeLlmBackend();
  if (!backend) return { status: "retryable", reason: "model unavailable" };
  if (digests.length === 0) return { status: "retryable", reason: "no digests to summarise" };
  if (remainingMs(opts.deadline) < CALL_FLOOR_MS + CALL_RESERVE_MS) return { status: "retryable", reason: "budget below the summary floor" };
  let used = digests.length;
  let recent = recentText;
  let feedback: string | undefined;
  let pin: { fingerprint: string; strength: LlmCapacity["fingerprintStrength"] } | null = null;
  // The capacity, read FRESH before every call (design §1.2), and the largest prompt that fits it.
  const fit = async (): Promise<{ prompt: string; count: ChatTokenCount; cap: LlmCapacity } | string> => {
    const cap = await llm.llmCapacity(backend, { deadline: opts.deadline });
    if (pin && fingerprintVerdict(pin, cap) !== "same") return "the LLM server changed or could not be verified";
    pin ??= { fingerprint: cap.fingerprint, strength: cap.fingerprintStrength };
    const budget = cap.nCtx - SUMMARY_REPLY_TOKENS;
    for (;;) {
      const prompt = incrementalSummaryPrompt(previous, digests.slice(0, used), recent, feedback);
      const c = await llm.countChatTokens(llm.outboundChatContent(prompt, backend), cap, { deadline: opts.deadline, overheadStore: opts.overheadStore });
      if (c.tokens + c.margin <= budget) return { prompt, count: c, cap };
      if (recent) { recent = ""; continue; }
      if (used > 1) { used = Math.max(1, Math.floor(used * 0.7)); continue; }
      return feedback === undefined
        ? `capacity: one digest's summary prompt does not fit the context of ${cap.nCtx} (${cap.source})`
        : `capacity: the summary retry does not fit the context of ${cap.nCtx} (${cap.source})`;
    }
  };
  let fitted = await fit();
  if (typeof fitted === "string") return { status: "retryable", reason: fitted };
  let cutOnce = false;
  let formatOnce = false;
  for (;;) {
    if (remainingMs(opts.deadline) < CALL_FLOOR_MS + CALL_RESERVE_MS) return { status: "retryable", reason: "budget below the summary floor" };
    const maxTokens = Math.max(1, Math.min(SUMMARY_REPLY_TOKENS, fitted.cap.nCtx - fitted.count.tokens - fitted.count.margin));
    const r = await llm.generateDetailed(fitted.prompt, {
      maxTokens, temperature: GENERATION_TEMPERATURE, signal: timeoutSignal(opts.deadline) ?? undefined, backend,
    });
    if (!r.ok) {
      if (r.reason === "context_exceeded" && fitted.count.method === "content") llm.invalidateOverhead?.(fitted.cap.fingerprint, opts.overheadStore);
      return { status: "retryable", reason: r.reason === "context_exceeded" ? "capacity: the summary prompt exceeded the context" : "model unavailable" };
    }
    if (r.finish === "length") {
      if (cutOnce) return { status: "retryable", reason: "the summary reply was cut twice" };
      cutOnce = true;
      feedback = SUMMARY_BREVITY;
    } else if (r.finish !== "stop") {
      return { status: "retryable", reason: "the model's summary reply did not finish as an answer" };
    } else {
      const parsed = parseSummaryResponse(r.text);
      if (parsed.ok) {
        const keep = previous && previous.request !== "Unknown" && previous.request !== "None" ? previous.request : null;
        return { status: "ok", summary: capSummary(keep ? { ...parsed.value, request: keep } : parsed.value), digestsUsed: used };
      }
      if (formatOnce) return { status: "retryable", reason: "no parseable response within the budget" };
      formatOnce = true;
      feedback = formatFeedback(parsed.error, r.text);
    }
    fitted = await fit();
    if (typeof fitted === "string") return { status: "retryable", reason: fitted };
  }
}

/**
 * 62.1 D5 (honcho's incremental summarizer, `summarizer.py:390-433`): the previous summary + the digests of the turns
 * since it + the recent text → the updated summary. v0.41.2: `extractSummaryFitted` with every digest required — a batch
 * that only fits in part is `retryable` here (the Stop pipeline calls `extractSummaryFitted` and moves its watermark by
 * `digestsUsed`).
 */
export async function extractSummaryIncremental(
  previous: SessionSummary | null,
  digests: readonly TurnDigestText[],
  recentText: string,
  opts?: { timeoutMs?: DurationMs },
): Promise<SummaryResult> {
  const deadline = deadlineAfter(monoNow(), opts?.timeoutMs ?? duration(MAX_LLM_GENERATE_TIMEOUT_MS));
  const r = await extractSummaryFitted(previous, digests, recentText, { deadline });
  if (r.status === "retryable") return r;
  if (r.digestsUsed < digests.length) return { status: "retryable", reason: `capacity: ${r.digestsUsed} of ${digests.length} digests fit the context` };
  return { status: "ok", summary: r.summary };
}

export async function extractSummary(
  messages: TranscriptMessage[]
): Promise<SessionSummary | null> {
  if (messages.length < 4) return null;

  const transcript = prepareTranscript(messages);
  const prompt = `${SUMMARY_SYSTEM_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---\n\nGenerate summary:`;

  return withRetryAndFeedback<SessionSummary>({
    initialPrompt: prompt,
    llm: getDefaultLlamaCpp(),
    maxTokens: 500,
    temperature: GENERATION_TEMPERATURE,
    label: "observer.extractSummary",
    parse: parseSummaryResponse,
  });
}
