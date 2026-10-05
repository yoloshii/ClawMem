/**
 * PreCompact hook — extracts session state before compaction.
 *
 * Reads the uncompressed transcript, extracts the last human request, decisions, open questions and
 * file paths via regex (no LLM calls), and writes them as THIS session's pre-compaction state
 * (`src/compaction-state.ts`). `postcompact-inject` reads it back on the same session's
 * SessionStart(compact) and deletes it.
 *
 * 62.2: through v0.39.1 this wrote one `precompact-state.md` per project directory into Claude Code's
 * auto-memory dir (read by every session there — CM-01), took the last user-ROLE entry (usually a
 * tool result) as the request and mined tool traffic for decisions (CM-03), and re-indexed a
 * collection from inside the hook (CM-04, NEW-2).
 */

import { isoNow } from "../clock.ts";
import {
  type HookInput,
  type HookOutput,
  type TranscriptTurn,
  cutUnits,
  makeEmptyOutput,
  readTranscriptTurns,
  validateTranscriptPath,
  estimateTokens,
} from "../hooks.ts";
import type { Store } from "../store.ts";
import { extractDecisions } from "./decision-extractor.ts";
import {
  type CompactionExtract, beginCompaction, completeCompaction, discardCompactionState, isValidSessionId, registerCompaction,
} from "../compaction-state.ts";

/** Decisions, questions and file paths come from the same recent window as before. */
const RECENT_TURNS = 200;
/** The last human request is searched further back: a long agentic stretch can bury it. */
const REQUEST_SEARCH_TURNS = 2000;

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
// Last human request
// ---------------------------------------------------------------------------

/** A slash command without arguments, as typed (`/pre-compact`). */
const BARE_SLASH_COMMAND_RE = /^\/\S+$/;

/**
 * The words the user typed in a turn: a human line's text, or a prompt typed while the assistant worked (72.4 F2) —
 * never a bare command such as `/pre-compact`, either way. Never a notice's label: a task's or a peer's text is not a
 * request.
 */
function typedWords(t: TranscriptTurn): string {
  if (t.kind === "human") return t.bareCommand ? "" : t.text;
  if (t.kind === "notice" && t.notice?.source === "queued-prompt") {
    const typed = (t.notice.typedText ?? "").trim();
    return BARE_SLASH_COMMAND_RE.test(typed) ? "" : typed;
  }
  return "";
}

/** The last thing the user TYPED (10 or more chars of typed text) — never a tool result, meta entry, harness wrapper or label. */
function getLastHumanRequest(turns: TranscriptTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const typed = typedWords(turns[i]!).trim();
    if (typed.length >= 10) return cutUnits(typed, 500);
  }
  return "";
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
  input: HookInput,
  /**
   * `attempt`: the registration the CLI made BEFORE it opened the vault (null: that registration
   * failed). Omitted, the hook registers here, on the store it was given.
   */
  opts: { attempt?: string | null } = {},
): Promise<HookOutput> {
  // No usable session id → nothing can be scoped to a session, so nothing is written.
  const sessionId = input.sessionId;
  if (!isValidSessionId(sessionId)) return makeEmptyOutput("precompact-extract");

  // FIRST, before reading anything: register a new attempt outside the vault, then open it in the
  // vault. The registration alone makes the session's previous state ineligible, so from here on any
  // failure (a busy vault, an unreadable transcript, nothing to extract, a crash, the host's timeout)
  // leaves NO state — never an earlier compaction's snapshot for SessionStart(compact) to replay — and
  // an older PreCompact that finishes later cannot store over this one.
  const attempt = "attempt" in opts ? opts.attempt : registerCompaction(store, sessionId);
  if (!attempt) {
    // Unregistered: nothing this hook stores could be taken, and what it cannot supersede it clears.
    discardCompactionState(store, sessionId);
    process.stderr.write("precompact-extract: could not register a compaction attempt; nothing stored\n");
    return makeEmptyOutput("precompact-extract");
  }
  if (!beginCompaction(store, sessionId, attempt)) {
    process.stderr.write("precompact-extract: could not open a compaction attempt (vault busy); nothing stored\n");
    return makeEmptyOutput("precompact-extract");
  }

  const transcriptPath = validateTranscriptPath(input.transcriptPath ?? "");
  if (!transcriptPath) return makeEmptyOutput("precompact-extract");

  const turns = readTranscriptTurns(transcriptPath, REQUEST_SEARCH_TURNS);
  const recent = turns.slice(-RECENT_TURNS);

  // Decisions: human prompts, notice labels and assistant PROSE only — tool input and tool output are
  // never mined (CM-03). A decision's context is the preceding user message: the typed prompt, or the
  // label of the notice that started the turn (72.4 F5), never an earlier prompt across that boundary.
  const prose = recent
    .filter(t => t.kind === "human" || t.kind === "notice" || t.kind === "assistant")
    .map(t => ({ role: t.kind === "assistant" ? "assistant" : "user", content: t.text }));
  // Open questions: the user's own words and assistant prose — never a notice's label.
  const questionProse = recent.flatMap(t =>
    t.kind === "assistant" ? [{ role: "assistant", content: t.text }]
    : typedWords(t) ? [{ role: "user", content: typedWords(t) }]
    : []);
  // File paths keep reading the inline rendering, where tool calls carry their file_path.
  const rendered = recent.map(t => ({ role: t.role, content: t.rendered }));

  const lastRequest = getLastHumanRequest(turns);
  const decisions = rankDecisionsByRelevance(extractDecisions(prose), lastRequest);
  const filePaths = extractFilePaths(rendered);
  const openQuestions = extractOpenQuestions(questionProse);

  // Nothing extracted: the attempt stays without a payload, so there is nothing to take.
  if (decisions.length === 0 && !lastRequest && filePaths.length === 0) {
    return makeEmptyOutput("precompact-extract");
  }

  const extract: CompactionExtract = {
    trigger: input.trigger,
    lastRequest,
    decisions: decisions.slice(0, 15).map(d => ({ text: d.text, context: d.context })),
    openQuestions,
    filePaths,
  };
  if (!completeCompaction(store, sessionId, attempt, extract)) {
    // Not stored: a newer PreCompact of this session began meanwhile, or the write failed.
    // The audit row means "a snapshot was stored", so none is written.
    process.stderr.write("precompact-extract: the session's compaction state was not stored\n");
    return makeEmptyOutput("precompact-extract");
  }

  // Audit trail — written only for a stored snapshot
  try {
    store.insertUsage({
      sessionId,
      timestamp: isoNow(),
      hookName: "precompact-extract",
      injectedPaths: [],
      estimatedTokens: estimateTokens(JSON.stringify(extract)),
      wasReferenced: 0,
    });
  } catch {
    // non-critical
  }

  return makeEmptyOutput("precompact-extract");
}
