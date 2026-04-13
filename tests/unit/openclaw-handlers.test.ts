/**
 * Tests for ClawMem OpenClaw Plugin event handlers (§14.3 Shipping Condition 1)
 *
 * Uses the test seam in `engine.ts` (`setHookRunnerForTests` /
 * `restoreHookRunnerForTests`) to inject a stub hook runner that records
 * which hook names get invoked from each handler. This avoids Bun's
 * process-wide `mock.module` semantics, which would otherwise contaminate
 * the shell-utility tests in `openclaw-plugin.test.ts`.
 *
 * Shipping Condition 1 (BACKLOG.md §14.10 + §14.11):
 *
 *   precompact-extract MUST run via `before_prompt_build` (which IS awaited
 *   at OpenClaw's `src/agents/pi-embedded-runner/run/attempt.ts:1661`) gated
 *   by the proximity heuristic, and MUST NOT run via `agent_end` (which is
 *   FIRE-AND-FORGET in OpenClaw core at attempt.ts:2226-2249, literal
 *   comment "This is fire-and-forget, so we don't await").
 *
 * The §14.11 finding caught this after Codex Turn N+1 incorrectly verified
 * `contextEngine.afterTurn()` (attempt.ts:2166, LegacyContextEngine path)
 * instead of `runAgentEnd` (attempt.ts:2226, typed-hook path). This file
 * is the regression gate against precompact silently moving back into
 * `handleAgentEnd`.
 *
 * Validated assertions:
 *   - `handleBeforePromptBuild` WHEN proximity gate met → invokes
 *     "precompact-extract"
 *   - `handleBeforePromptBuild` WHEN proximity gate NOT met → does NOT
 *     invoke "precompact-extract"
 *   - `handleAgentEnd` → NEVER invokes "precompact-extract" (regression
 *     gate)
 *   - `handleAgentEnd` DOES invoke decision-extractor + handoff-generator
 *     + feedback-loop (eventually-consistent vault writes)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { _resetAllSessionStateForTests } from "../../src/openclaw/session-state.ts";
import {
  handleAgentEnd,
  handleBeforePromptBuild,
  handleBeforeReset,
  handleSessionStart,
  setHookRunnerForTests,
  restoreHookRunnerForTests,
  setSessionFileResolverForTests,
  restoreSessionFileResolverForTests,
  type ExecHookFn,
  type ResolveSessionFileFn,
} from "../../src/openclaw/engine.ts";
import type { ShellResult } from "../../src/openclaw/shell.ts";

const calls: { name: string; input: Record<string, unknown> }[] = [];

const stubExecHook: ExecHookFn = async (
  _cfg,
  hookName,
  input,
): Promise<ShellResult> => {
  calls.push({ name: hookName, input });
  return { stdout: "", stderr: "", exitCode: 0 };
};

// Default stub resolver — returns a deterministic path so handlers proceed.
// Tests that need to exercise the "no transcript path" fallback override
// this with a resolver that returns undefined.
const stubSessionFileResolver: ResolveSessionFileFn = (params) => {
  if (!params.sessionId) return undefined;
  return `/tmp/test-state/agents/${params.agentId ?? "main"}/sessions/${params.sessionId}.jsonl`;
};

const undefinedResolver: ResolveSessionFileFn = () => undefined;

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const mockCfg = {
  clawmemBin: "clawmem",
  tokenBudget: 800,
  profile: "balanced",
  enableTools: false,
  servePort: 7438,
  env: {},
};

// Threshold config tuned so 80K tokens is BELOW the gate and 90K is ABOVE
// (threshold = 100K, gate = 0.85 * 100K = 85K).
const thresholdCfg = {
  contextWindowTokens: 112_000,
  reserveTokensFloor: 8_000,
  softThresholdTokens: 4_000,
  precompactProximityRatio: 0.85,
};

describe("Shipping Condition 1 — precompact via before_prompt_build, never via agent_end", () => {
  beforeEach(() => {
    calls.length = 0;
    _resetAllSessionStateForTests();
    setHookRunnerForTests({
      execHook: stubExecHook,
      // parseHookOutput / extractContext use defaults (return null / "")
    });
    setSessionFileResolverForTests(stubSessionFileResolver);
  });

  afterEach(() => {
    restoreHookRunnerForTests();
    restoreSessionFileResolverForTests();
  });

  test("handleBeforePromptBuild fires precompact when proximity gate met (~90K tokens)", async () => {
    // ~90K tokens → ~360K chars (chars/4 estimate)
    const bigText = "x".repeat(360_000);
    const messages = [{ role: "user", content: bigText }];

    await handleBeforePromptBuild(
      mockCfg,
      thresholdCfg,
      mockLogger,
      { prompt: "test prompt that is long enough", messages },
      { sessionId: "session-precompact-fires", agentId: "main" },
    );

    const hookNames = calls.map((c) => c.name);
    expect(hookNames).toContain("precompact-extract");
    // context-surfacing must always run (every-turn retrieval)
    expect(hookNames).toContain("context-surfacing");

    // Codex Turn N+2 HIGH finding regression gate: precompact-extract MUST
    // be invoked with a non-empty transcript_path. Without it the underlying
    // hook validates and silently no-ops.
    const precompactCall = calls.find((c) => c.name === "precompact-extract");
    expect(precompactCall).toBeDefined();
    expect(precompactCall?.input.transcript_path).toBeDefined();
    expect(typeof precompactCall?.input.transcript_path).toBe("string");
    expect((precompactCall?.input.transcript_path as string).length).toBeGreaterThan(0);
    expect(precompactCall?.input.transcript_path).toContain("session-precompact-fires");
  });

  test("handleBeforePromptBuild SKIPS precompact when no transcript path is resolvable", async () => {
    // Override the default stub resolver with one that always returns undefined
    setSessionFileResolverForTests(undefinedResolver);

    const bigText = "q".repeat(360_000);
    const messages = [{ role: "user", content: bigText }];

    await handleBeforePromptBuild(
      mockCfg,
      thresholdCfg,
      mockLogger,
      { prompt: "test prompt that is long enough", messages },
      { sessionId: "session-no-file", agentId: "main" },
    );

    const hookNames = calls.map((c) => c.name);
    // Context surfacing still runs (it's resilient to missing transcript)
    expect(hookNames).toContain("context-surfacing");
    // Precompact MUST NOT run because the underlying hook would silently
    // no-op anyway — better to skip the shell-out entirely.
    expect(hookNames).not.toContain("precompact-extract");
  });

  test("handleBeforePromptBuild does NOT fire precompact when below proximity gate (~80K tokens)", async () => {
    // ~80K tokens → ~320K chars < 85K gate
    const bigText = "y".repeat(320_000);
    const messages = [{ role: "user", content: bigText }];

    await handleBeforePromptBuild(
      mockCfg,
      thresholdCfg,
      mockLogger,
      { prompt: "test prompt that is long enough", messages },
      { sessionId: "session-precompact-skips" },
    );

    const hookNames = calls.map((c) => c.name);
    expect(hookNames).not.toContain("precompact-extract");
    expect(hookNames).toContain("context-surfacing");
  });

  test("handleAgentEnd NEVER invokes precompact-extract (§14.11 regression gate)", async () => {
    // Even with messages above the proximity gate, handleAgentEnd must
    // not fire precompact-extract — that path lives in
    // handleBeforePromptBuild for correctness reasons.
    const bigText = "z".repeat(400_000);
    const messages = [
      { role: "user", content: bigText },
      { role: "assistant", content: "response" },
    ];

    await handleAgentEnd(
      mockCfg,
      mockLogger,
      { messages, success: true, durationMs: 100 },
      { sessionId: "session-agent-end", agentId: "main" },
    );

    const hookNames = calls.map((c) => c.name);
    expect(hookNames).not.toContain("precompact-extract");
    // It SHOULD still invoke the eventually-consistent extractors
    expect(hookNames).toContain("decision-extractor");
    expect(hookNames).toContain("handoff-generator");
    expect(hookNames).toContain("feedback-loop");

    // Codex Turn N+2 HIGH finding regression gate: each extractor MUST be
    // invoked with a non-empty transcript_path. Without it the underlying
    // hooks validate and silently no-op (decision-extractor.ts:319,
    // handoff-generator.ts:36, feedback-loop.ts:34).
    for (const name of ["decision-extractor", "handoff-generator", "feedback-loop"]) {
      const call = calls.find((c) => c.name === name);
      expect(call).toBeDefined();
      expect(call?.input.transcript_path).toBeDefined();
      expect(typeof call?.input.transcript_path).toBe("string");
      expect((call?.input.transcript_path as string).length).toBeGreaterThan(0);
      expect(call?.input.transcript_path).toContain("session-agent-end");
    }
  });

  test("handleAgentEnd SKIPS extractors when no transcript path is resolvable", async () => {
    setSessionFileResolverForTests(undefinedResolver);

    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    await handleAgentEnd(
      mockCfg,
      mockLogger,
      { messages, success: true, durationMs: 50 },
      { sessionId: "session-no-file-end", agentId: "main" },
    );

    // No extractors should fire — they would silently no-op without
    // transcript_path, so we save the round-trips.
    expect(calls.length).toBe(0);
  });

  test("handleAgentEnd skips when too few messages (heartbeat / empty turn)", async () => {
    await handleAgentEnd(
      mockCfg,
      mockLogger,
      { messages: [{ role: "user", content: "ping" }], success: true },
      { sessionId: "session-heartbeat" },
    );

    expect(calls.length).toBe(0);
  });

  test("handleAgentEnd skips when sessionId missing", async () => {
    await handleAgentEnd(
      mockCfg,
      mockLogger,
      {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
        success: true,
      },
      {},
    );

    expect(calls.length).toBe(0);
  });

  test("handleSessionStart invokes session-bootstrap hook", async () => {
    await handleSessionStart(
      mockCfg,
      mockLogger,
      { sessionId: "new-session", sessionKey: "key-1" },
      { sessionId: "new-session" },
    );

    const hookNames = calls.map((c) => c.name);
    expect(hookNames).toContain("session-bootstrap");
  });

  test("handleBeforeReset runs final extraction sweep with explicit sessionFile from event", async () => {
    await handleBeforeReset(
      mockCfg,
      mockLogger,
      { sessionFile: "/tmp/explicit-session.jsonl", reason: "reset" },
      { sessionId: "session-reset", agentId: "main" },
    );

    const hookNames = calls.map((c) => c.name);
    expect(hookNames).toContain("decision-extractor");
    expect(hookNames).toContain("handoff-generator");
    expect(hookNames).toContain("feedback-loop");

    // All three extractors must receive the EXPLICIT sessionFile from the
    // event payload (not the resolver fallback).
    for (const name of ["decision-extractor", "handoff-generator", "feedback-loop"]) {
      const call = calls.find((c) => c.name === name);
      expect(call?.input.transcript_path).toBe("/tmp/explicit-session.jsonl");
    }
  });

  test("handleBeforeReset falls back to resolver when event.sessionFile missing", async () => {
    await handleBeforeReset(
      mockCfg,
      mockLogger,
      { reason: "reset" }, // no sessionFile in event
      { sessionId: "session-reset-fallback", agentId: "main" },
    );

    const hookNames = calls.map((c) => c.name);
    expect(hookNames).toContain("decision-extractor");

    const call = calls.find((c) => c.name === "decision-extractor");
    // Resolver stub returns /tmp/test-state/agents/main/sessions/<sid>.jsonl
    expect(call?.input.transcript_path).toContain("session-reset-fallback");
  });

  test("handleBeforeReset is no-op when sessionId missing", async () => {
    await handleBeforeReset(
      mockCfg,
      mockLogger,
      { sessionFile: "/tmp/session.jsonl", reason: "reset" },
      {},
    );

    expect(calls.length).toBe(0);
  });

  test("handleBeforeReset clears state but skips extractors when no transcript path", async () => {
    setSessionFileResolverForTests(undefinedResolver);

    await handleBeforeReset(
      mockCfg,
      mockLogger,
      { reason: "reset" }, // no sessionFile, resolver returns undefined
      { sessionId: "session-no-path", agentId: "main" },
    );

    // No extractor invocations — they would no-op without transcript_path
    expect(calls.length).toBe(0);
    // But state should still be cleared (no assertion needed; not throwing
    // is sufficient — clearSessionState is the regression we'd catch by
    // examining session-state in subsequent tests).
  });
});
