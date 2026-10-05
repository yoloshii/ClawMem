/**
 * Local Observer Agent - Structured observation extraction using local GGUF model
 *
 * Uses Qwen3-1.7B (already loaded for query expansion) with XML-formatted prompts
 * to extract structured observations and session summaries from transcripts.
 * Falls back gracefully when model is unavailable.
 */

import { createHash } from "crypto";
import { TRANSCRIPT_CLASSIFIER_REVISION, type TranscriptMessage } from "./hooks.ts";
import {
  monoNow, deadlineAfter, duration, remainingForTimeout, evidenceMs, elapsed, timeoutSignal, epochNow, epochMs,
  type DurationMs, type MonoDeadline,
} from "./clock.ts";
import {
  getDefaultLlamaCpp, budgetLayerOf, fingerprintVerdict, type BudgetLlm, type LlmBackendId, type LlmCapacity, type ChatTokenCount,
  type OverheadStore,
} from "./llm.ts";
import { withRetryAndFeedback, type RetryLlm } from "./llm-retry.ts";
import { canonicalizeForMatch } from "./schema-placeholder.ts";
import { MAX_LLM_GENERATE_TIMEOUT_MS } from "./limits.ts";
import {
  OBSERVATION_SYSTEM_PROMPT, OBSERVATION_FEEDBACK_TEXT, OBSERVER_GRAMMAR_VERSION, parseObservationReply, observationFeedback,
  observerFailureClass, observerGrammar, grammarReplyClass, type ParsedReply,
} from "./observer-reply.ts";

// v0.41.4: the reply contract (prompt, parser, feedback, grammar) lives in observer-reply.ts; its public names stay here.
export {
  VALID_PREDICATES, LITERAL_PREDICATES, parseObservationXml, parseObservationReply, parseObservationBlock, observationFeedback,
  observerGrammar, observerFailureClass, decodeObserverEntities, OBSERVER_GRAMMAR_VERSION,
  type BlockRejection, type ReplyFailure, type ParseAdvisories, type GuardDrops, type ParseContext, type ParsedReply,
} from "./observer-reply.ts";

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

/**
 * The CONTEXT section's share of the render budget (v0.41.1). The section is at most this long, the transcript gets the
 * rest, and batches are packed to leave it (stop-extract.ts), so CONTEXT + transcript stay within
 * OBSERVER_MAX_RENDER_CHARS — the prompt v0.40 sent at its largest, which the documented `-c 4096` was sized for.
 */
export const OBSERVER_CONTEXT_MAX_CHARS = 2_000;
/**
 * A retry's feedback block and the blank line before it, at most (v0.41.4: `observationFeedback` — the reply's class,
 * up to three rejected-block lines, the type rule and the `<none/>` line; ~700 characters at most). A retry takes it out
 * of the transcript's budget, so every attempt stays within OBSERVER_MAX_RENDER_CHARS (v0.41.1).
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

// =============================================================================
// v0.41.2 (BACKLOG 68.5): the observer's token budget and windows — DESIGN-v0412.md §1.3–§1.4
// =============================================================================

/** Bump with any change to `parseObservationXml` / `parseObservationReply` (a checkpoint's contract includes it). */
export const OBSERVER_PARSER_VERSION = 3;
/** Bump with any change to how the windows are assembled that the contract's hashed strings would not show. */
export const OBSERVER_CONTRACT_VERSION = 2;
/** v0.41.4 (§3.2): at most this many format retries per window per invocation, each a fresh sample with the feedback. */
export const FORMAT_RETRIES = 2;
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
 * the CONTEXT's sizes included. v0.41.4 (§1.5): the observer's own feedback strings and the grammar too. 72.4 (§4): the
 * transcript classifier's revision — the rendered lines' hash does not cover where turns open, so a checkpoint taken
 * under another classifier restarts its range.
 */
export function observerContractInputs(): Record<string, unknown> {
  return {
    contract: OBSERVER_CONTRACT_VERSION, parser: OBSERVER_PARSER_VERSION, classifier: TRANSCRIPT_CLASSIFIER_REVISION,
    system: OBSERVATION_SYSTEM_PROMPT,
    sections: [EARLIER_HEADER, RECORDED_HEADER, CONTEXT_END, TRANSCRIPT_OPEN, TRANSCRIPT_CLOSE, "--- CONTEXT (already recorded — do not extract) ---", "Already recorded observations:"],
    feedback: OBSERVATION_FEEDBACK_TEXT,
    grammar: { version: OBSERVER_GRAMMAR_VERSION, text: [1, 2, 3, 4, 5].map(observerGrammar) },
    policy: {
      replyFloor: REPLY_FLOOR_TOKENS, replyShare: 0.4, replyMax: GENERATION_MAX_TOKENS, perObservation: OBSERVATION_REPLY_TOKENS,
      minTranscript: MIN_TRANSCRIPT_TOKENS, maxCalls: MAX_OBSERVER_CALLS, earlierChars: EARLIER_CHARS,
      contextMaxChars: OBSERVER_CONTEXT_MAX_CHARS, contextPriorChars: CONTEXT_PRIOR_CHARS, contextTitlesChars: CONTEXT_TITLES_CHARS,
      contextTitleChars: CONTEXT_TITLE_CHARS, formatRetries: FORMAT_RETRIES,
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

/** v0.41.4 (§3.3): a size reduction for the window starting at `start` — at most `maxLines` lines; it only shrinks. */
export type WindowBound = { start: number; maxLines: number };

/** Progress a window run has made (and a checkpoint stores). */
export type WindowProgress = { doneThroughLine: number; observations: Observation[]; titles: string[]; windowBound?: WindowBound };

/** A stored bound if it is well-formed and belongs to the window starting at `pos` — anything else is ignored (§3.3). */
export function validWindowBound(v: unknown, pos: number): WindowBound | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { start, maxLines } = v as Partial<WindowBound>;
  if (!Number.isInteger(start) || !Number.isInteger(maxLines) || (maxLines as number) < 1 || start !== pos) return undefined;
  return { start: start as number, maxLines: maxLines as number };
}

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

/** The handoff summary's format-retry feedback (v0.41.4 §3.1: unchanged, byte for byte; the observer uses `observationFeedback`). */
const FORMAT_FEEDBACK_LINES = [
  "The previous response did not match the expected structure.", "Error:", "Previous response (first 500 chars):",
  "Return only the expected structure this time.",
] as const;
const FORMAT_FEEDBACK_EXCERPT_CHARS = 500;

function formatFeedback(error: string, reply: string): string {
  const [head, label, excerpt, tail] = FORMAT_FEEDBACK_LINES;
  return [head, label, error, "", excerpt, cutAt(reply, FORMAT_FEEDBACK_EXCERPT_CHARS), "", tail].join("\n");
}

type FittedWindow = { end: number; prompt: string; count: ChatTokenCount; context: string };

type FitArgs = {
  lines: readonly ObserverLine[]; start: number; maxLines: number; n: number; contexts: readonly string[];
  budget: number; feedback?: string; count: (prompt: string) => Promise<ChatTokenCount>; nCtx: number; source: string;
};

/**
 * Fit the next window from `start` (design §1.3–§1.4): pick the fullest CONTEXT that leaves MIN_TRANSCRIPT_TOKENS, then
 * the most whole turns whose ASSEMBLED prompt fits B (counted, never summed); a turn is cut between messages only when
 * it alone exceeds a window. When the window's first line does not fit under that context, each smaller one is tried
 * the same way, fullest first (BACKLOG 69.13). `{capacity}` when even one line under the emptiest context, or the fixed
 * part, cannot fit.
 */
async function fitWindow(a: FitArgs): Promise<FittedWindow | { capacity: string }> {
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
  // BACKLOG 69.13: the CONTEXT helps the model read the window; the line is the work. A first line that does not fit
  // under the chosen context is tried under each smaller one, fullest first, before it is held, so the window keeps as
  // much context as fits. A window that fits under the chosen context is the one it always was.
  let fitted = await fitLines(a, context, fixed);
  const tried = new Set([context]);
  for (const c of a.contexts.slice(a.contexts.indexOf(context) + 1)) {
    if (!("capacity" in fitted)) break;
    if (tried.has(c)) continue;
    tried.add(c);
    const f = await a.count(windowPrompt(a.n, c, [], a.feedback));
    if (f.tokens + f.margin + MIN_TRANSCRIPT_TOKENS <= a.budget) fitted = await fitLines(a, c, f);
  }
  return fitted;
}

/** The window from `a.start` under one CONTEXT (`fixed` = its prompt with no lines): `{capacity}` when its first line cannot fit. */
async function fitLines(a: FitArgs, context: string, fixed: ChatTokenCount): Promise<FittedWindow | { capacity: string }> {
  const last = Math.min(a.lines.length, a.start + Math.max(1, a.maxLines));
  const fits = (c: ChatTokenCount) => c.tokens + c.margin <= a.budget;
  const at = async (end: number): Promise<FittedWindow> => {
    const prompt = windowPrompt(a.n, context, a.lines.slice(a.start, end), a.feedback);
    return { end, prompt, count: await a.count(prompt), context };
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

// =============================================================================
// v0.41.4 (BACKLOG 69.3): what persists across invocations — the validated context ceiling (§3.3a), the grammar-off
// record (§4.4) — and the reply statistics the doctor reads (§4.5)
// =============================================================================

/** A validated context ceiling counts for this long after it was established or lowered (§3.3a). */
const CEILING_TTL_MS = 7 * 24 * 3_600_000;
/** Ceiling records kept per backend key, the latest by `at` (§3.3a). */
const CEILING_RECORDS_KEPT = 4;
/** How long a grammar request's HTTP 400 turns the grammar off for its server (§4.4). */
const GRAMMAR_OFF_MS = 24 * 3_600_000;
export const OBSERVER_NCTX_PREFIX = "observer-nctx:";
export const OBSERVER_GRAMMAR_PREFIX = "observer-grammar:";

const wallNow = (): number => epochMs(epochNow());
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The backend a record is about: its request identity (server root + requested model, or the local model file). */
export function observerBackendKey(llm: Pick<BudgetLlm, "requestIdentity">, backend: LlmBackendId): string {
  return sha256(llm.requestIdentity?.(backend) ?? JSON.stringify(backend)).slice(0, 16);
}

/** One record's read-modify-write as plain reads and writes — the caller supplies the atomicity. */
function readModifyWrite(store: OverheadStore, key: string, fn: (old: string | null) => string | null): void {
  const old = store.get(key);
  const next = fn(old);
  if (next === old) return;
  if (next === null) store.delete(key); else store.set(key, next);
}

/**
 * Read-modify-write of one record, atomic where the store can be: its `update` (the Stop pipeline: one immediate
 * transaction), else its `transaction` (codex T7-14), else plain reads and writes (a store with neither is not atomic).
 */
function updateRecord(store: OverheadStore, key: string, fn: (old: string | null) => string | null): void {
  if (store.update) { store.update(key, fn); return; }
  if (store.transaction) { store.transaction(() => readModifyWrite(store, key, fn)); return; }
  readModifyWrite(store, key, fn);
}

type CeilingRecord = { ceiling: number; at: string };
function parseCeiling(raw: string | null): CeilingRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CeilingRecord>;
    if (typeof v.ceiling !== "number" || !Number.isFinite(v.ceiling) || v.ceiling <= 0) return null;
    if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
    return { ceiling: v.ceiling, at: v.at };
  } catch {
    return null;
  }
}
const ceilingLive = (r: CeilingRecord | null, nowMs: number): r is CeilingRecord => r !== null && nowMs - Date.parse(r.at) <= CEILING_TTL_MS;

/**
 * One `/props` value's validated ceiling after a new observation (§3.3a): a stored record older than 7 days counts as
 * absent; otherwise the ceiling becomes the minimum. `at` moves only when the record is created or its ceiling lowered,
 * so low evidence lapses 7 days after it was established and the next oversize re-establishes the current value.
 */
export function mergeContextCeiling(oldRaw: string | null, ceiling: number, nowMs: number): string {
  const old = parseCeiling(oldRaw);
  if (ceilingLive(old, nowMs) && old.ceiling <= ceiling) return oldRaw!;
  return JSON.stringify({ ceiling, at: new Date(nowMs).toISOString() });
}

function ceilingKey(backendKey: string, propsNCtx: number): string {
  return `${OBSERVER_NCTX_PREFIX}${backendKey}:${propsNCtx}`;
}

/** The validated ceiling for the `/props` value just read, if its record is live (§3.3a). Best-effort: null on any error. */
function readContextCeiling(store: OverheadStore | undefined, backendKey: string, propsNCtx: number): number | null {
  if (!store) return null;
  try {
    const r = parseCeiling(store.get(ceilingKey(backendKey, propsNCtx)));
    return ceilingLive(r, wallNow()) ? r.ceiling : null;
  } catch {
    return null;
  }
}

/**
 * Merge a validated oversize's `n_ctx` into its `/props` value's record; keep 4 records per backend (§3.3a): the one
 * just merged and the 3 latest others by `at` — after a backward clock step the record just merged can be the oldest
 * by `at`, and keeping it beside 4 others would hold 5 (codex T7-4). The merge and the pruning share one transaction
 * where the store has one, never nested (codex T7-14).
 */
function recordContextCeiling(store: OverheadStore, backendKey: string, propsNCtx: number, ceiling: number): void {
  const key = ceilingKey(backendKey, propsNCtx);
  const nowMs = wallNow();
  const merge = (old: string | null) => mergeContextCeiling(old, ceiling, nowMs);
  const prune = () => {
    if (!store.entries) return;
    const others = store.entries(`${OBSERVER_NCTX_PREFIX}${backendKey}:`)
      .filter(e => e.key !== key)
      .map(e => ({ key: e.key, at: Date.parse(parseCeiling(e.value)?.at ?? "") || 0 }))
      .sort((x, y) => y.at - x.at);
    for (const r of others.slice(CEILING_RECORDS_KEPT - 1)) store.delete(r.key);
  };
  try {
    if (store.transaction) store.transaction(() => { readModifyWrite(store, key, merge); prune(); });
    else { updateRecord(store, key, merge); prune(); }
  } catch { /* best-effort: the in-invocation override still applies */ }
}

/**
 * §4.4: `offUntil`/`at` are wall-clock (expiry, the doctor); `count` is the generation an obligation's clear compares;
 * `cause` is what the latest refusal was — an HTTP 400 (its cause unconfirmed) or a grammar the in-process model could
 * not compile (codex T7-7) — for the doctor's wording only.
 */
export type GrammarOffCause = "http-400" | "compile";
type GrammarOffRecord = { offUntil: string; at: string; count: number; pending: boolean; cause?: GrammarOffCause };
function parseGrammarOff(raw: string | null): GrammarOffRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GrammarOffRecord>;
    if (typeof v.offUntil !== "string" || Number.isNaN(Date.parse(v.offUntil)) || typeof v.count !== "number" || typeof v.pending !== "boolean") return null;
    const cause = v.cause === "compile" || v.cause === "http-400" ? v.cause : undefined;
    return { offUntil: v.offUntil, at: typeof v.at === "string" ? v.at : v.offUntil, count: v.count, pending: v.pending, ...(cause ? { cause } : {}) };
  } catch {
    return null;
  }
}

/** The grammar-off record's key: the request identity, the server's fingerprint and the grammar's version (§4.4). */
export function observerGrammarKey(llm: Pick<BudgetLlm, "requestIdentity">, backend: LlmBackendId, fingerprint: string): string {
  return `${OBSERVER_GRAMMAR_PREFIX}${sha256(`${llm.requestIdentity?.(backend) ?? JSON.stringify(backend)}|${fingerprint}|${OBSERVER_GRAMMAR_VERSION}`)}`;
}

/** A grammar request refused (§4.4): `offUntil` only extends, `count` + 1 (a generation), an obligation set. */
function recordGrammarOff(store: OverheadStore, key: string, cause: GrammarOffCause): void {
  const nowMs = wallNow();
  try {
    updateRecord(store, key, old => {
      const o = parseGrammarOff(old);
      const until = Math.max(o ? Date.parse(o.offUntil) : 0, nowMs + GRAMMAR_OFF_MS);
      return JSON.stringify({ offUntil: new Date(until).toISOString(), at: new Date(nowMs).toISOString(), count: (o?.count ?? 0) + 1, pending: true, cause });
    });
  } catch { /* best-effort: this invocation stays grammarless regardless */ }
}

/** A grammarless call got an HTTP response: clear the obligation only if no 400 bumped the generation since (T5-1). */
function clearGrammarObligation(store: OverheadStore, key: string, captured: number): void {
  try {
    updateRecord(store, key, old => {
      const o = parseGrammarOff(old);
      if (!o || !o.pending || o.count !== captured) return old;
      return JSON.stringify({ ...o, pending: false });
    });
  } catch { /* best-effort: the obligation stays, the next grammarless response clears it */ }
}

/** What one invocation's replies showed, per backend (§4.5, §5): the Stop pipeline persists it for the doctor. */
export type ObserverStatsDelta = {
  grammarStructural: number; grammarContent: number; grammarRefusals: number; instructionEcho: number; eventDefinitionEcho: number;
  tripleToolId: number; tripleSelf: number; identifierResidue: number; repeatedFact: number;
};
export const OBSERVER_STATS_FIELDS = [
  "grammarStructural", "grammarContent", "grammarRefusals", "instructionEcho", "eventDefinitionEcho", "tripleToolId", "tripleSelf",
  "identifierResidue", "repeatedFact",
] as const satisfies readonly (keyof ObserverStatsDelta)[];
export const emptyObserverStats = (): ObserverStatsDelta => ({
  grammarStructural: 0, grammarContent: 0, grammarRefusals: 0, instructionEcho: 0, eventDefinitionEcho: 0, tripleToolId: 0, tripleSelf: 0,
  identifierResidue: 0, repeatedFact: 0,
});
let pendingStats = new Map<string, ObserverStatsDelta>();

function statsFor(backendKey: string): ObserverStatsDelta {
  let s = pendingStats.get(backendKey);
  if (!s) { s = emptyObserverStats(); pendingStats.set(backendKey, s); }
  return s;
}

function noteParse(stats: ObserverStatsDelta, parsed: ParsedReply, grammarClass: "structural" | "content" | null): void {
  stats.instructionEcho += parsed.advisories.instructionEcho;
  stats.eventDefinitionEcho += parsed.advisories.eventDefinitionEcho;
  stats.tripleToolId += parsed.drops.tripleToolId;
  stats.tripleSelf += parsed.drops.tripleSelf;
  stats.identifierResidue += parsed.drops.identifierResidue;
  stats.repeatedFact += parsed.drops.repeatedFact;
  if (grammarClass === "structural") stats.grammarStructural++;
  else if (grammarClass === "content") stats.grammarContent++;
}

/** The statistics measured since the last take — totals, and per backend key — then reset. */
export function takeObserverStats(): ObserverStatsDelta & { backends: Record<string, ObserverStatsDelta> } {
  const backends = Object.fromEntries(pendingStats);
  pendingStats = new Map();
  const totals = emptyObserverStats();
  for (const s of Object.values(backends)) for (const f of OBSERVER_STATS_FIELDS) totals[f] += s[f];
  return { ...totals, backends };
}

/**
 * Extract a unit's observations in windows (design §1.3–§1.4). Each window's prompt + the reply reserve fits the
 * backend's context, read FRESH before every call (retries included) and checked against the server the run is pinned
 * to; a cut reply (`finish: "length"`) is never `empty` — the window is halved; a reply that did not finish as an
 * answer is retryable. Progress goes to `onProgress` after every completed window (the caller's durable checkpoint);
 * `resume` continues from one.
 *
 * v0.41.4 (DESIGN-v0414.md §3–§4): a window ends inside the invocation that started it. After a reply that needs a
 * retry — unparseable (up to FORMAT_RETRIES, each with `observationFeedback`), cut, a validated oversize, a grammar
 * request's HTTP 400 — every exit before the retry's own reply is `retryable` with that reply's class, never `partial`.
 * A halving or an oversize's correction persists as a shrink-only `windowBound` through `onProgress`; a validated
 * oversize below `/props` also records a context ceiling for that `/props` value. A strong-fingerprint backend gets the
 * GBNF grammar unless `CLAWMEM_OBSERVER_GRAMMAR=off` or its grammar-off record holds.
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
  let pinned = opts.expectFingerprint !== undefined
    ? { fingerprint: opts.expectFingerprint, strength: opts.expectStrength ?? ("strong" as const) }
    : null;
  let sinceCall = monoNow();
  const store = opts.overheadStore;
  const backendKey = observerBackendKey(opts.llm, opts.backend);
  const stats = statsFor(backendKey);
  const grammarOn = (process.env.CLAWMEM_OBSERVER_GRAMMAR ?? "auto").trim().toLowerCase() !== "off";
  /** A grammar request's 400 in THIS invocation: grammarless from here on, whatever the store holds (§4.4). */
  let grammarRefusedHere = false;
  /** The resumed window's persisted bound (§3.3); a malformed or foreign one is ignored. */
  let bound = validWindowBound(opts.resume?.windowBound, pos);

  type Budget = {
    cap: LlmCapacity; propsNCtx: number; reserve: number; n: number; budget: number;
    count: (prompt: string) => Promise<ChatTokenCount>;
  };
  /**
   * The capacity, read FRESH (design §1.2) and checked against the pin. Its context is the least of the `/props` value,
   * that value's live validated ceiling (§3.3a) and `override` (a validated oversize's n_ctx in this invocation).
   */
  const readBudget = async (override?: number): Promise<Budget | "changed" | "unverified"> => {
    const read = await opts.llm.llmCapacity(opts.backend, { deadline: opts.deadline });
    if (pinned) {
      const verdict = fingerprintVerdict(pinned, read);
      if (verdict !== "same") return verdict;
    } else {
      pinned = { fingerprint: read.fingerprint, strength: read.fingerprintStrength };
    }
    let nCtx = read.nCtx;
    const ceiling = readContextCeiling(store, backendKey, read.nCtx);
    if (ceiling !== null && ceiling < nCtx) nCtx = ceiling;
    if (override !== undefined && override < nCtx) nCtx = override;
    const cap = nCtx === read.nCtx ? read : { ...read, nCtx };
    const reserve = observerReplyReserve(cap.nCtx);
    return {
      cap, propsNCtx: read.nCtx, reserve, n: observerRequestedCount(reserve), budget: cap.nCtx - reserve,
      count: (prompt: string) => opts.llm.countChatTokens(opts.llm.outboundChatContent(prompt, opts.backend), cap, {
        deadline: opts.deadline, overheadStore: opts.overheadStore,
      }),
    };
  };
  /** §4.1/§4.4: the grammar for this call, or why not — and, for a grammarless call owed by an obligation, its generation. */
  const selectGrammar = (bb: Budget): { grammar?: string; key: string; captured?: number } => {
    const key = observerGrammarKey(opts.llm, opts.backend, bb.cap.fingerprint);
    let rec: GrammarOffRecord | null = null;
    try { rec = store ? parseGrammarOff(store.get(key)) : null; } catch { rec = null; }
    // A grammarless call owed by an obligation captures its generation whatever made it grammarless — the record, this
    // invocation's own refusal, the fingerprint or the configuration (codex T7-6).
    const captured = rec?.pending ? rec.count : undefined;
    if (!grammarOn || bb.cap.fingerprintStrength !== "strong") return { key, captured };
    if (grammarRefusedHere || (rec !== null && (Date.parse(rec.offUntil) > wallNow() || rec.pending))) return { key, captured };
    return { key, grammar: observerGrammar(bb.n) };
  };
  const partial = (): WindowedResult => ({ status: "partial", doneThroughLine: pos, totalLines: total });
  const retryable = (reason: string): WindowedResult => ({ status: "retryable", reason });
  const notSame = (v: "changed" | "unverified"): WindowedResult =>
    v === "changed" ? { status: "server_changed" } : { status: "unverified", doneThroughLine: pos, totalLines: total };
  /** §3.3: the reduced bound for the window at `pos`, written through the caller's CAS before the smaller window is tried. */
  const persistBound = async (maxLines: number): Promise<boolean> => {
    bound = { start: pos, maxLines: bound?.start === pos ? Math.min(bound.maxLines, maxLines) : maxLines };
    if (!opts.onProgress) return true;
    return await opts.onProgress({ doneThroughLine: pos, observations: [...observations], titles: [...produced], windowBound: bound });
  };

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
    let maxLines = bound?.start === pos ? bound.maxLines : Number.POSITIVE_INFINITY;
    const fit = (bb: Budget) => fitWindow({
      lines, start: pos, maxLines, n: bb.n, contexts, budget: bb.budget, feedback, count: bb.count, nCtx: bb.cap.nCtx, source: bb.cap.source,
    });
    let fitted = await fit(b);

    let correctedOnce = false;
    let formatRetries = 0;
    let override: number | undefined;
    /** §3.2(b): the class of the reply that needs a retry; every exit before the retry's own reply returns it. */
    let pending: string | null = null;
    let retryKind: "format" | "resize" | "grammar" = "resize";
    for (;;) {
      if (calls <= 0 || remainingMs(opts.deadline) < CALL_FLOOR_MS + CALL_RESERVE_MS) return pending !== null ? retryable(pending) : partial();
      if (pending !== null) {
        // Every retry reads the capacity again (design §1.2) and re-fits to it.
        const nb = await readBudget(override);
        if (nb === "changed") return { status: "server_changed" };
        if (nb === "unverified") return retryable(pending);
        b = nb;
        fitted = await fit(b);
      }
      // Reading and counting go over the network: the deadline is checked again after them — before the fit's result is
      // read — and the call's signal is taken once, so an expired deadline neither becomes a call without a timeout
      // (codex T7-13) nor reads as a capacity failure (codex T8-2).
      const signal = remainingMs(opts.deadline) < CALL_FLOOR_MS + CALL_RESERVE_MS ? null : timeoutSignal(opts.deadline);
      if (signal === null) return pending !== null ? retryable(pending) : partial();
      if ("capacity" in fitted) {
        if (pending === null) return retryable(fitted.capacity);
        // §3.2(b): an exit before the retry's own reply keeps that reply's class (codex T7-2); §3.4 names the one case
        // in which the retry itself is what cannot fit — the format retry's feedback.
        return retryable(retryKind === "format" ? `capacity: the format retry's feedback leaves no room (${fitted.capacity.replace(/^capacity: /, "")})` : pending);
      }
      const g = selectGrammar(b);
      calls--;
      made++;
      const maxTokens = Math.max(1, Math.min(GENERATION_MAX_TOKENS, b.cap.nCtx - fitted.count.tokens - fitted.count.margin));
      const reply = await opts.llm.generateDetailed(fitted.prompt, {
        maxTokens, temperature: GENERATION_TEMPERATURE, signal, backend: opts.backend,
        ...(g.grammar !== undefined ? { grammar: g.grammar } : {}),
      });
      if (reply.ok) noteCall(evidenceMs(elapsed(sinceCall)));
      sinceCall = monoNow();
      // §4.4: an owed grammarless request reached the server (any HTTP response, not a transport failure).
      if (store && g.captured !== undefined && (reply.ok || reply.reason === "http" || reply.reason === "context_exceeded")) {
        clearGrammarObligation(store, g.key, g.captured);
      }
      if (!reply.ok && reply.reason === "context_exceeded") {
        // A validated oversize: the count that fed this prompt was low — a measured overhead behind it is stale (§1.2).
        if (fitted.count.method === "content") opts.llm.invalidateOverhead?.(b.cap.fingerprint, opts.overheadStore);
        // §3.3a: the server's own n_ctx below what /props claims — a ceiling for that /props value, for later invocations;
        // every validated oversize counts, not only the one the single correction answers (codex T7-3).
        if (store && typeof reply.nCtx === "number" && reply.nCtx < b.propsNCtx) recordContextCeiling(store, backendKey, b.propsNCtx, reply.nCtx);
        if (!correctedOnce && typeof reply.promptTokens === "number") {
          // Re-size once from the server's own count and n_ctx (design §1.2): this window's lines scaled to the room left.
          correctedOnce = true;
          override = reply.nCtx;
          const nCtx = reply.nCtx ?? b.cap.nCtx;
          const room = nCtx - observerReplyReserve(nCtx) - fitted.count.margin;
          const scale = Math.max(0.1, Math.min(0.9, room / reply.promptTokens));
          maxLines = Math.max(1, Math.floor((fitted.end - pos) * scale));
          if (!(await persistBound(maxLines))) return { status: "overtaken" };
          pending = "capacity: the corrected window was not tried";
          retryKind = "resize";
          continue;
        }
      }
      if (!reply.ok) {
        const compileFailed = reply.reason === "grammar_rejected";
        if (g.grammar !== undefined && (compileFailed || (reply.reason === "http" && reply.status === 400))) {
          // §4.4: a grammar request refused — an HTTP 400 (no cause claimed) or a grammar the in-process model could not
          // compile (codex T7-7) — the grammar-off record at once, then a grammarless retry.
          grammarRefusedHere = true;
          stats.grammarRefusals++;
          if (store) recordGrammarOff(store, g.key, compileFailed ? "compile" : "http-400");
          pending = compileFailed
            ? "grammar: the in-process model could not compile the grammar; the grammarless retry was not reached"
            : "grammar: HTTP 400 on a grammar request; the grammarless retry was not reached";
          retryKind = "grammar";
          continue;
        }
        if (reply.reason === "unavailable" || reply.reason === "aborted") {
          if (pending !== null) return retryable(pending);   // T3b-4: the retry's own call never answered
          return { status: "unavailable", doneThroughLine: pos, totalLines: total, calls: made };
        }
        return retryable(reply.reason === "context_exceeded" ? "context exceeded after a corrected window" : "model unavailable");
      }
      if (reply.finish === "length") {
        // A cut reply is never success (P2): halve the window and redo it; one line still cut is a capacity limit.
        const size = fitted.end - pos;
        if (size <= 1) return retryable(`capacity: one message's observations exceed the ${b.reserve}-token reply`);
        maxLines = Math.max(1, Math.floor(size / 2));
        feedback = undefined;
        if (!(await persistBound(maxLines))) return { status: "overtaken" };
        pending = "capacity: the reply was cut and the halved window was not tried";
        retryKind = "resize";
        continue;
      }
      // codex T11-2: only a reply that finished as an answer is parsed (design §1.4) — never read as "nothing".
      if (reply.finish !== "stop") return retryable("the model's reply did not finish as an answer");
      const evidence = canonicalizeForMatch(`${fitted.context}\n${lines.slice(pos, fitted.end).map(l => l.text).join("\n")}`);
      const parsed = parseObservationReply(reply.text, { evidence });
      noteParse(stats, parsed, g.grammar !== undefined ? grammarReplyClass(parsed, reply.text) : null);
      if (parsed.ok) {
        observations.push(...parsed.value);
        produced.push(...parsed.value.map(o => o.title));
        break;
      }
      const reason = `no parseable response: ${observerFailureClass(parsed.failure)}`;
      if (formatRetries >= FORMAT_RETRIES) return retryable(reason);
      // A format retry: a fresh sample with feedback that names the failing field, out of THIS window's budget.
      formatRetries++;
      feedback = observationFeedback(parsed.failure);
      maxLines = fitted.end - pos;
      pending = reason;
      retryKind = "format";
    }
    pos = fitted.end;
    bound = undefined;
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
