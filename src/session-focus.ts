/**
 * Session-Scoped Focus (§11.4 — v0.9.0)
 *
 * Per-session topic primitive that biases context-surfacing ranking toward
 * docs relevant to the declared working context — WITHOUT persisting any
 * state to SQLite. Intra-session curation that cannot contaminate other
 * sessions.
 *
 * Primary signal: per-session state file at
 *   ~/.cache/clawmem/sessions/<session_id>.focus
 *
 * The env var CLAWMEM_SESSION_FOCUS is a DEBUG-ONLY override: it bypasses
 * the per-session file entirely, and because it is a single process-wide
 * variable it does NOT provide per-session scoping in multi-session host
 * processes (e.g. a long-lived MCP server handling multiple Claude Code
 * sessions). Use the file path for correctness; use the env var for
 * ad-hoc single-session debugging only.
 *
 * All read paths are fail-open. Unreadable, corrupt, empty, missing,
 * invalid-UTF-8, or oversized focus files return undefined and the
 * caller proceeds with baseline ranking (byte-identical to pre-§11.4).
 * The stage must NEVER half-apply a malformed topic.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ScoredResult } from "./memory.ts";

const MAX_TOPIC_LEN = 256;

/**
 * Resolve the root directory for session focus files. Defaults to
 * `~/.cache/clawmem/sessions`, overridable via `CLAWMEM_FOCUS_ROOT`.
 * The override is primarily a test hook (so `bun:test` can redirect
 * writes to a tmp dir) but is also safe to use in production if an
 * operator wants to relocate the focus files out of `$HOME`.
 *
 * Computed lazily on every call so env-var changes in tests take
 * effect without module reload.
 */
export function focusRoot(): string {
  const override = process.env.CLAWMEM_FOCUS_ROOT;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".cache", "clawmem", "sessions");
}

export function focusFilePath(sessionId: string): string {
  return path.join(focusRoot(), `${sessionId}.focus`);
}

/**
 * Read the session focus topic. Returns undefined on any failure:
 * - sessionId missing/empty
 * - file does not exist
 * - file unreadable (permissions, etc.)
 * - file empty or whitespace-only
 * - file exceeds MAX_TOPIC_LEN
 * - file contains invalid UTF-8 (readFileSync throws)
 *
 * Never throws. Caller treats undefined as "no topic set" and skips
 * the boost stage entirely.
 */
export function readSessionFocus(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    const p = focusFilePath(sessionId);
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, { encoding: "utf-8" });
    const topic = raw.trim();
    if (!topic) return undefined;
    if (topic.length > MAX_TOPIC_LEN) return undefined;
    return topic;
  } catch {
    return undefined;
  }
}

/**
 * Write a session focus topic. Creates the sessions directory if needed.
 * Overwrites any existing file. Throws on invalid input or I/O errors
 * (caller surface — CLI command that should fail loudly on misuse).
 */
export function writeSessionFocus(sessionId: string, topic: string): void {
  if (!sessionId || !sessionId.trim()) {
    throw new Error("writeSessionFocus: sessionId required");
  }
  const trimmed = topic.trim();
  if (!trimmed) {
    throw new Error("writeSessionFocus: topic required");
  }
  if (trimmed.length > MAX_TOPIC_LEN) {
    throw new Error(`writeSessionFocus: topic exceeds max length ${MAX_TOPIC_LEN}`);
  }
  fs.mkdirSync(focusRoot(), { recursive: true });
  fs.writeFileSync(focusFilePath(sessionId), trimmed, { encoding: "utf-8" });
}

/**
 * Clear a session focus. No-op if the file does not exist.
 * Never throws (caller is typically "revert ranking to baseline").
 */
export function clearSessionFocus(sessionId: string): void {
  if (!sessionId) return;
  try {
    const p = focusFilePath(sessionId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore — clearing is best-effort */
  }
}

/**
 * Resolve the effective session focus topic by checking the per-session
 * focus file first, then falling back to a provided env-var value (the
 * CLAWMEM_SESSION_FOCUS debug override). Returns undefined when neither
 * yields a valid topic.
 *
 * Precedence is file > env var because the file is the only signal
 * that provides per-session scoping on multi-session host processes.
 * Exposed here (rather than inlined at the call site) so the hook's
 * precedence logic can be unit-tested directly without spinning up a
 * full contextSurfacing invocation.
 *
 * Never throws. Never logs. Every failure path returns undefined and
 * the caller treats that as "no topic set" (byte-identical to
 * pre-§11.4 hook behavior).
 */
export function resolveSessionTopic(
  sessionId: string | undefined,
  envVar: string | undefined
): string | undefined {
  const fromFile = readSessionFocus(sessionId);
  if (fromFile) return fromFile;
  const fromEnv = envVar?.trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

/**
 * Case-insensitive tokenized AND-match against title + displayPath + body.
 * Tokens shorter than 2 chars are dropped (common stopwords and typos).
 * Returns true only if every remaining token appears in the haystack.
 */
function matchesTopic(result: ScoredResult, topic: string): boolean {
  const tokens = topic
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return false;

  const haystack = [
    result.title || "",
    result.displayPath || "",
    (result.body || "").slice(0, 800),
  ]
    .join(" ")
    .toLowerCase();

  return tokens.every(t => haystack.includes(t));
}

export interface TopicBoostOptions {
  /** Multiplier applied to docs whose title/path/body match all topic tokens. Default 1.4. */
  boostFactor?: number;
  /**
   * Multiplier applied to non-matching docs. Default 0.75.
   * Clamped to a 0.5 floor so the boost is a re-ranker, not a hide —
   * non-matching docs are demoted but never suppressed to zero.
   */
  demoteFactor?: number;
}

/**
 * Apply session-topic boost/demote to a scored result set as a POST-COMPOSITE
 * reranking pass. Runs AFTER applyCompositeScoring(...) and BEFORE threshold
 * filtering (the specific architectural placement Codex approved in Turn 1 of
 * the v0.9.0 design review).
 *
 * Behavior:
 *   - Empty/undefined topic → returns input unchanged (no-op, byte-identical).
 *   - Topic present but ZERO docs match → returns input unchanged (no-op).
 *     This is the fail-open contract from the approved §11.4 spec: "topic
 *     set + zero matching docs → proceed with the normal results." Without
 *     this short-circuit, uniformly demoting every doc would push some
 *     below the downstream threshold filter and silently shrink the
 *     result set — a regression vs the no-topic baseline.
 *     (Caught by Codex in §11.4 code review Turn 1, 2026-04-13.)
 *   - Topic present AND at least one match → each result's compositeScore
 *     is multiplied by either boostFactor (matching) or demoteFactor
 *     (non-matching), then results are re-sorted descending.
 *
 * Matching is computed exactly once per result in a pre-pass so the
 * short-circuit can decide without double-evaluating the token match.
 *
 * This is a pure function over the scored set — it does NOT call the DB,
 * does NOT write SQLite state, does NOT touch any lifecycle column.
 * Mutates compositeScore in place (consistent with existing scoring
 * helpers in this codebase; single caller, single thread).
 */
export function applyTopicBoost<T extends ScoredResult>(
  scored: T[],
  topic: string | undefined,
  options: TopicBoostOptions = {}
): T[] {
  if (!topic || !topic.trim()) return scored;
  if (scored.length === 0) return scored;

  const boostFactor = options.boostFactor ?? 1.4;
  const demoteFactor = Math.max(options.demoteFactor ?? 0.75, 0.5);

  // Pre-compute per-result match flags so we can early-return on zero
  // matches without double-evaluating matchesTopic during the mutation
  // pass. Caching is also a (small) perf win for any single call.
  const matches = scored.map(r => matchesTopic(r, topic));
  const anyMatch = matches.some(Boolean);
  if (!anyMatch) return scored; // fail-open: baseline ordering preserved

  for (let i = 0; i < scored.length; i++) {
    const factor = matches[i] ? boostFactor : demoteFactor;
    scored[i]!.compositeScore = scored[i]!.compositeScore * factor;
  }

  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  return scored;
}
