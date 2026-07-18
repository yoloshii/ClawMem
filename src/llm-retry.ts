/**
 * Retry-with-error-feedback for LLM extraction paths (§13.1, Source 13).
 *
 * ClawMem's extraction surfaces (observer, conversation-synthesis, A-MEM)
 * were single-shot: on a malformed response they failed open to `[]`/`null`
 * with no signal to the model about what went wrong. Small local models miss
 * structured-output requirements often enough that one corrective retry
 * recovers most of those losses.
 *
 * Invariants (borrowed from Volt's llm-map validation loop):
 *  - Retries are STATELESS. Every attempt is a fresh generate() call with a
 *    reconstructed prompt (original prompt + parse error + response excerpt)
 *    — never a conversation continuation, no message-history accumulation.
 *  - One overall timeout budget bounds ALL attempts combined as a HARD
 *    wall-clock deadline: no attempt starts past it, and an in-flight
 *    generate() is raced against it — a backend that ignores the abort
 *    signal cannot hold the helper past the budget.
 *  - Fail-open on exhaustion: terminal failure returns null, which is the
 *    same result callers already handled on single-shot failure — no
 *    regression risk, but the exhaustion is now logged.
 */

import { MAX_LLM_GENERATE_TIMEOUT_MS } from "./limits.ts";
import type { GenerateResult } from "./llm.ts";

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Minimal generate() surface the helper needs — satisfied by LlamaCpp. */
export type RetryLlm = {
  generate(
    prompt: string,
    options: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<GenerateResult | null>;
};

const RESPONSE_EXCERPT_CHARS = 500;

/** Race sentinel: the overall deadline fired while generate() was in flight. */
const DEADLINE_EXPIRED = Symbol("llm-retry-deadline-expired");

export async function withRetryAndFeedback<T>(params: {
  initialPrompt: string;
  parse: (text: string) => ParseOutcome<T>;
  llm: RetryLlm;
  maxTokens: number;
  temperature?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Identifies the call site in the terminal-failure log line. */
  label?: string;
}): Promise<T | null> {
  const maxAttempts = params.maxAttempts ?? 3;
  const timeoutMs = params.timeoutMs ?? MAX_LLM_GENERATE_TIMEOUT_MS;
  const temperature = params.temperature ?? 0.3;
  const label = params.label ?? "llm-retry";

  let prompt = params.initialPrompt;
  let lastError = "timeout budget exhausted before the first attempt";
  let attemptsMade = 0;
  const startTime = Date.now();
  const deadlineAt = startTime + timeoutMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Hard wall-clock bound, part 1: never START an attempt past the deadline.
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    attemptsMade = attempt;

    const controller = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    // Hard wall-clock bound, part 2: at the deadline, abort the signal (an
    // abort-aware backend stops) AND win the race (a signal-ignoring backend
    // cannot hold the helper past the budget).
    const deadline = new Promise<typeof DEADLINE_EXPIRED>((resolve) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        resolve(DEADLINE_EXPIRED);
      }, remaining);
    });
    try {
      const inFlight = params.llm.generate(prompt, {
        maxTokens: params.maxTokens,
        temperature,
        signal: controller.signal,
      });
      const raced = await Promise.race([inFlight, deadline]);
      if (raced === DEADLINE_EXPIRED) {
        // Abandon the aborted call (swallowing its eventual settlement) and
        // terminate — never start another attempt after the deadline.
        inFlight.catch(() => {});
        lastError = `overall timeout of ${timeoutMs}ms exceeded during generate`;
        break;
      }
      const lastResponse = raced?.text ?? "";

      if (lastResponse) {
        const parsed = params.parse(lastResponse);
        if (parsed.ok) return parsed.value;
        lastError = parsed.error;
      } else {
        lastError = "LLM returned an empty response.";
      }

      if (attempt >= maxAttempts) break;

      // Reconstruct the retry prompt with error context — stateless, fresh call.
      prompt = [
        params.initialPrompt,
        "",
        "The previous response did not match the expected structure.",
        "Error:",
        lastError,
        "",
        `Previous response (first ${RESPONSE_EXCERPT_CHARS} chars):`,
        lastResponse.slice(0, RESPONSE_EXCERPT_CHARS),
        "",
        "Return only the expected structure this time.",
      ].join("\n");
    } catch (err) {
      // Abort or transport error — retry with the same prompt (there is no
      // model output to feed back); the loop-top deadline check bounds it.
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) break;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  console.warn(
    `[llm-retry] ${label}: exhausted after ${attemptsMade} attempt(s) / ${Date.now() - startTime}ms — failing open (last error: ${lastError.slice(0, 200)})`,
  );
  return null;
}
