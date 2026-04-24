/**
 * Tests for ClawMem OpenClaw Plugin (§14.3 pure-memory migration)
 *
 * After §14.3, the plugin no longer implements ContextEngine — lifecycle
 * work runs through `PluginHookName` event handlers. This file covers the
 * non-mocking unit tests for the migration:
 *
 *   - shell utility helpers (resolveClawMemBin, parseHookOutput,
 *     extractContext) — preserved from prior version
 *   - plugin manifest assertions (Shipping Condition 3 prerequisite)
 *   - compaction-threshold helpers (proximity gate math)
 *   - session-state module (relocated one-shot state)
 *   - setup-time migration text presence (Shipping Condition 2 regression
 *     gate against the migration message disappearing from cmdSetupOpenClaw
 *     and cmdDoctor)
 *
 * The handler tests that REQUIRE mocking shell.ts (Shipping Condition 1
 * regression gate against precompact moving back into agent_end) live in
 * `openclaw-handlers.test.ts` because Bun's `mock.module` is module-level
 * and would otherwise contaminate the shell utility tests in this file.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveClawMemBin, parseHookOutput, extractContext } from "../../src/openclaw/shell.ts";
import {
  estimateTokensFromMessages,
  isWithinPrecompactProximity,
  resolveCompactionThreshold,
  resolveProximityRatio,
  PRECOMPACT_PROXIMITY_RATIO_DEFAULT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_RESERVE_TOKENS_FLOOR,
  DEFAULT_SOFT_THRESHOLD_TOKENS,
} from "../../src/openclaw/compaction-threshold.ts";
import {
  setBootstrapContext,
  takeBootstrapContext,
  markSessionSurfaced,
  isSessionSurfaced,
  clearSessionState,
  _resetAllSessionStateForTests,
} from "../../src/openclaw/session-state.ts";
import {
  buildOpenClawSessionFilePath,
  normalizeAgentId,
  resolveOpenClawSessionFile,
  resolveOpenClawStateDir,
  DEFAULT_AGENT_ID,
} from "../../src/openclaw/transcript-resolver.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

// =============================================================================
// Shell Utilities (preserved from prior version — these never depended on the
// ContextEngine interface and remain valid post-§14.3)
// =============================================================================

describe("resolveClawMemBin", () => {
  test("returns configured path if it exists", () => {
    const result = resolveClawMemBin(`${import.meta.dir}/../../bin/clawmem`);
    expect(result).toContain("bin/clawmem");
  });

  test("falls back to 'clawmem' if no configured path", () => {
    const result = resolveClawMemBin("/nonexistent/path/clawmem");
    expect(typeof result).toBe("string");
  });
});

describe("parseHookOutput", () => {
  test("parses valid JSON", () => {
    const result = parseHookOutput('{"continue":true,"suppressOutput":false}');
    expect(result).toEqual({ continue: true, suppressOutput: false });
  });

  test("returns null for empty string", () => {
    expect(parseHookOutput("")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseHookOutput("not json")).toBeNull();
  });

  test("extracts JSON from mixed output", () => {
    const mixed = 'some stderr leak\n{"continue":true}';
    const result = parseHookOutput(mixed);
    expect(result).toEqual({ continue: true });
  });
});

describe("extractContext", () => {
  test("extracts additionalContext from hookSpecificOutput", () => {
    const output = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "<vault-context>test</vault-context>",
      },
    };
    expect(extractContext(output)).toBe("<vault-context>test</vault-context>");
  });

  test("returns empty string when no hookSpecificOutput", () => {
    expect(extractContext({ continue: true })).toBe("");
  });

  test("returns empty string for null", () => {
    expect(extractContext(null)).toBe("");
  });
});

// =============================================================================
// Plugin manifest — Shipping Condition 3 (loader-gate prerequisite)
// =============================================================================

describe("plugin manifest (§14.3 kind=memory)", () => {
  test("openclaw.plugin.json declares kind=memory", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/openclaw.plugin.json`);
    const content = await file.json();
    expect(content.id).toBe("clawmem");
    // Critical: kind MUST be "memory" so OpenClaw's loader gate at
    // src/plugins/loader.ts:1696 disables ClawMem before register() runs
    // when ClawMem is not the selected memory plugin. Pre-§14.3 value was
    // "context-engine" — regression to that string would silently re-enable
    // ClawMem under any memory plugin owner, violating shipping condition 3.
    expect(content.kind).toBe("memory");
  });

  test("openclaw.plugin.json declares activation onCapabilities for control-plane perf", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/openclaw.plugin.json`);
    const content = await file.json();
    expect(content.activation).toBeDefined();
    expect(Array.isArray(content.activation.onCapabilities)).toBe(true);
    expect(content.activation.onCapabilities).toContain("hook");
    expect(content.activation.onCapabilities).toContain("tool");
  });

  test("openclaw.plugin.json preserves configSchema entries", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/openclaw.plugin.json`);
    const content = await file.json();
    expect(content.configSchema).toBeDefined();
    expect(content.configSchema.properties.clawmemBin).toBeDefined();
    expect(content.configSchema.properties.tokenBudget).toBeDefined();
    expect(content.configSchema.properties.profile).toBeDefined();
  });

  test("openclaw.plugin.json exposes remote LLM config in uiHints and configSchema", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/openclaw.plugin.json`);
    const content = await file.json();
    expect(content.uiHints.gpuLlmModel).toBeDefined();
    expect(content.uiHints.gpuLlmReasoningEffort).toBeDefined();
    expect(content.uiHints.gpuLlmNoThink).toBeDefined();
    expect(content.configSchema.properties.gpuLlmModel).toBeDefined();
    expect(content.configSchema.properties.gpuLlmReasoningEffort).toBeDefined();
    expect(content.configSchema.properties.gpuLlmNoThink).toBeDefined();
    expect(content.configSchema.properties.gpuLlmReasoningEffort.enum).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("openclaw.plugin.json does not imply a default reasoning effort is sent", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/openclaw.plugin.json`);
    const content = await file.json();
    expect(content.uiHints.gpuLlmReasoningEffort.placeholder).toBe("(unset)");
    expect(content.uiHints.gpuLlmReasoningEffort.help).toContain("Optional top-level reasoning_effort");
  });

  test("openclaw index maps remote LLM config to CLAWMEM env vars", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/index.ts`);
    const content = await file.text();
    expect(content).toContain("pluginCfg.gpuLlmModel");
    expect(content).toContain("CLAWMEM_LLM_MODEL");
    expect(content).toContain("pluginCfg.gpuLlmReasoningEffort");
    expect(content).toContain("CLAWMEM_LLM_REASONING_EFFORT");
    expect(content).toContain("pluginCfg.gpuLlmNoThink");
    expect(content).toContain("CLAWMEM_LLM_NO_THINK");
  });
});

// =============================================================================
// Compaction-threshold helpers (proximity gate math)
// =============================================================================

describe("estimateTokensFromMessages", () => {
  test("returns 0 for empty / undefined", () => {
    expect(estimateTokensFromMessages(undefined)).toBe(0);
    expect(estimateTokensFromMessages([])).toBe(0);
  });

  test("estimates from string messages (chars/4)", () => {
    // 16 chars → 4 tokens (rounded up)
    expect(estimateTokensFromMessages(["abcdabcdabcdabcd"])).toBe(4);
  });

  test("estimates from {role, content: string} messages", () => {
    const messages = [
      { role: "user", content: "hello world" }, // 11 chars
      { role: "assistant", content: "hi back" }, // 7 chars
    ];
    // 18 chars total → 5 tokens (ceil)
    expect(estimateTokensFromMessages(messages)).toBe(5);
  });

  test("estimates from content-array messages with text parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "first part 12345" }, // 16 chars
          { type: "text", text: "second part 6789" }, // 16 chars
        ],
      },
    ];
    // 32 chars → 8 tokens
    expect(estimateTokensFromMessages(messages)).toBe(8);
  });

  test("falls back to JSON.stringify length for unknown content shapes", () => {
    const messages = [{ role: "user", content: { weird: "shape" } }];
    expect(estimateTokensFromMessages(messages)).toBeGreaterThan(0);
  });
});

describe("resolveCompactionThreshold", () => {
  test("uses defaults when no overrides provided", () => {
    const t = resolveCompactionThreshold({});
    // 200_000 - 8_000 - 4_000 = 188_000
    expect(t).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS - DEFAULT_RESERVE_TOKENS_FLOOR - DEFAULT_SOFT_THRESHOLD_TOKENS,
    );
  });

  test("applies all three config overrides", () => {
    const t = resolveCompactionThreshold({
      contextWindowTokens: 100_000,
      reserveTokensFloor: 5_000,
      softThresholdTokens: 2_000,
    });
    expect(t).toBe(93_000);
  });

  test("floors at 1_000 to avoid divide-by-zero in the proximity gate", () => {
    const t = resolveCompactionThreshold({
      contextWindowTokens: 1_000,
      reserveTokensFloor: 800,
      softThresholdTokens: 800,
    });
    // 1_000 - 800 - 800 = -600 → floor 1_000
    expect(t).toBe(1_000);
  });
});

describe("resolveProximityRatio", () => {
  test("returns the default when no override", () => {
    delete process.env.CLAWMEM_PRECOMPACT_PROXIMITY_RATIO;
    expect(resolveProximityRatio({})).toBe(PRECOMPACT_PROXIMITY_RATIO_DEFAULT);
  });

  test("respects config override", () => {
    expect(resolveProximityRatio({ precompactProximityRatio: 0.7 })).toBe(0.7);
  });

  test("respects env-var override", () => {
    process.env.CLAWMEM_PRECOMPACT_PROXIMITY_RATIO = "0.65";
    try {
      expect(resolveProximityRatio({})).toBe(0.65);
    } finally {
      delete process.env.CLAWMEM_PRECOMPACT_PROXIMITY_RATIO;
    }
  });

  test("config override wins over env-var override", () => {
    process.env.CLAWMEM_PRECOMPACT_PROXIMITY_RATIO = "0.5";
    try {
      expect(resolveProximityRatio({ precompactProximityRatio: 0.9 })).toBe(0.9);
    } finally {
      delete process.env.CLAWMEM_PRECOMPACT_PROXIMITY_RATIO;
    }
  });

  test("clamps below 0.5 and above 0.95", () => {
    expect(resolveProximityRatio({ precompactProximityRatio: 0.1 })).toBe(0.5);
    expect(resolveProximityRatio({ precompactProximityRatio: 1.5 })).toBe(0.95);
  });
});

describe("isWithinPrecompactProximity (84/85/86% transition)", () => {
  // Codex Turn N+1 demanded explicit test of the proximity boundary.
  const threshold = 100_000;
  const proximityRatio = 0.85;

  test("84% of threshold → below gate (false)", () => {
    expect(
      isWithinPrecompactProximity({
        estimatedTokens: 84_000,
        threshold,
        proximityRatio,
      }),
    ).toBe(false);
  });

  test("85% of threshold → at gate (true, inclusive boundary)", () => {
    expect(
      isWithinPrecompactProximity({
        estimatedTokens: 85_000,
        threshold,
        proximityRatio,
      }),
    ).toBe(true);
  });

  test("86% of threshold → above gate (true)", () => {
    expect(
      isWithinPrecompactProximity({
        estimatedTokens: 86_000,
        threshold,
        proximityRatio,
      }),
    ).toBe(true);
  });
});

// =============================================================================
// Session-state module (relocated from deleted ClawMemContextEngine instance)
// =============================================================================

describe("session-state module", () => {
  beforeEach(() => {
    _resetAllSessionStateForTests();
  });

  test("setBootstrapContext + takeBootstrapContext is one-shot", () => {
    setBootstrapContext("session-A", "<vault-session>cached</vault-session>");
    expect(takeBootstrapContext("session-A")).toBe("<vault-session>cached</vault-session>");
    // Second call returns undefined — one-shot consumption
    expect(takeBootstrapContext("session-A")).toBeUndefined();
  });

  test("takeBootstrapContext returns undefined when no cached context", () => {
    expect(takeBootstrapContext("nonexistent")).toBeUndefined();
  });

  test("markSessionSurfaced + isSessionSurfaced", () => {
    expect(isSessionSurfaced("session-B")).toBe(false);
    markSessionSurfaced("session-B");
    expect(isSessionSurfaced("session-B")).toBe(true);
  });

  test("clearSessionState wipes both bootstrap context and surfaced flag", () => {
    setBootstrapContext("session-C", "ctx");
    markSessionSurfaced("session-C");

    clearSessionState("session-C");

    expect(takeBootstrapContext("session-C")).toBeUndefined();
    expect(isSessionSurfaced("session-C")).toBe(false);
  });

  test("clearSessionState is scoped to a single sessionId", () => {
    setBootstrapContext("session-D", "ctx-D");
    setBootstrapContext("session-E", "ctx-E");
    markSessionSurfaced("session-D");
    markSessionSurfaced("session-E");

    clearSessionState("session-D");

    expect(takeBootstrapContext("session-D")).toBeUndefined();
    expect(isSessionSurfaced("session-D")).toBe(false);
    // session-E should remain intact
    expect(takeBootstrapContext("session-E")).toBe("ctx-E");
    expect(isSessionSurfaced("session-E")).toBe(true);
  });
});

// =============================================================================
// Transcript-path resolver (Codex Turn N+2 fix — closes the HIGH finding that
// the load-bearing precompact path lacked sessionFile)
// =============================================================================

describe("transcript-resolver — resolveOpenClawStateDir", () => {
  test("defaults to ~/.openclaw when no env override", () => {
    const env: NodeJS.ProcessEnv = {};
    const stateDir = resolveOpenClawStateDir(env, () => "/home/test");
    expect(stateDir).toBe("/home/test/.openclaw");
  });

  test("respects OPENCLAW_STATE_DIR override (absolute)", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/var/openclaw-state" };
    const stateDir = resolveOpenClawStateDir(env, () => "/home/test");
    expect(stateDir).toBe("/var/openclaw-state");
  });

  test("respects OPENCLAW_STATE_DIR override (~/path expansion)", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "~/custom-state" };
    const stateDir = resolveOpenClawStateDir(env, () => "/home/test");
    expect(stateDir).toBe("/home/test/custom-state");
  });

  test("respects OPENCLAW_HOME override (legacy alias, appends .openclaw)", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_HOME: "/var/oc-home" };
    const stateDir = resolveOpenClawStateDir(env, () => "/home/test");
    expect(stateDir).toBe("/var/oc-home/.openclaw");
  });

  test("OPENCLAW_STATE_DIR wins over OPENCLAW_HOME", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: "/state-wins",
      OPENCLAW_HOME: "/home-loses",
    };
    const stateDir = resolveOpenClawStateDir(env, () => "/home/test");
    expect(stateDir).toBe("/state-wins");
  });
});

describe("transcript-resolver — buildOpenClawSessionFilePath", () => {
  // Use buildOpenClawSessionFilePath (not resolveOpenClawSessionFile) so
  // the tests don't depend on the file actually existing on disk.

  test("constructs canonical layout: <stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    const path = buildOpenClawSessionFilePath({
      sessionId: "abc123",
      agentId: "myAgent",
      env,
    });
    expect(path).toBe("/test-state/agents/myagent/sessions/abc123.jsonl");
  });

  test("defaults agentId to 'main' when not provided", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    const path = buildOpenClawSessionFilePath({
      sessionId: "abc123",
      env,
    });
    expect(path).toBe(`/test-state/agents/${DEFAULT_AGENT_ID}/sessions/abc123.jsonl`);
  });

  test("returns undefined for invalid sessionId (rejects path traversal)", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    expect(buildOpenClawSessionFilePath({ sessionId: "../etc/passwd", env })).toBeUndefined();
    expect(buildOpenClawSessionFilePath({ sessionId: "with/slash", env })).toBeUndefined();
    expect(buildOpenClawSessionFilePath({ sessionId: "", env })).toBeUndefined();
    expect(buildOpenClawSessionFilePath({ sessionId: "  ", env })).toBeUndefined();
  });

  test("accepts SAFE_SESSION_ID_RE characters: alphanumerics, dot, dash, underscore", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    expect(
      buildOpenClawSessionFilePath({ sessionId: "session.id-123_test", env }),
    ).toBe("/test-state/agents/main/sessions/session.id-123_test.jsonl");
  });

  test("supports topic-scoped transcript filenames (string topicId is URI-encoded)", () => {
    // Codex Turn N+3 HIGH finding regression gate: topic-scoped sessions
    // must produce `<sessionId>-topic-<encodeURIComponent(topicId)>.jsonl`,
    // mirroring openclaw/src/config/sessions/paths.ts:248-251.
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    expect(
      buildOpenClawSessionFilePath({
        sessionId: "abc123",
        topicId: "topic with spaces",
        env,
      }),
    ).toBe("/test-state/agents/main/sessions/abc123-topic-topic%20with%20spaces.jsonl");
  });

  test("supports topic-scoped transcript filenames (numeric topicId)", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    expect(
      buildOpenClawSessionFilePath({
        sessionId: "abc123",
        topicId: 42,
        env,
      }),
    ).toBe("/test-state/agents/main/sessions/abc123-topic-42.jsonl");
  });

  test("empty / undefined topicId falls through to base session filename", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    expect(
      buildOpenClawSessionFilePath({ sessionId: "abc123", topicId: undefined, env }),
    ).toBe("/test-state/agents/main/sessions/abc123.jsonl");
    expect(
      buildOpenClawSessionFilePath({ sessionId: "abc123", topicId: "", env }),
    ).toBe("/test-state/agents/main/sessions/abc123.jsonl");
  });
});

describe("transcript-resolver — normalizeAgentId (faithful mirror of OpenClaw normalizeAgentId)", () => {
  // Codex Turn N+3 HIGH finding regression gates: ClawMem's resolver MUST
  // match OpenClaw's full normalization (NOT just .toLowerCase()), otherwise
  // the produced path diverges from what OpenClaw stores on disk for
  // sessions whose agent id requires sanitization.

  test("empty / whitespace input returns DEFAULT_AGENT_ID 'main'", () => {
    expect(normalizeAgentId(undefined)).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId(null)).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId("")).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId("   ")).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId("\t\n")).toBe(DEFAULT_AGENT_ID);
  });

  test("already-valid lowercase id is returned unchanged", () => {
    expect(normalizeAgentId("main")).toBe("main");
    expect(normalizeAgentId("agent-1")).toBe("agent-1");
    expect(normalizeAgentId("my_agent")).toBe("my_agent");
    expect(normalizeAgentId("a")).toBe("a");
    expect(normalizeAgentId("a1b2c3")).toBe("a1b2c3");
  });

  test("uppercase input is lowercased (case-insensitive validation)", () => {
    expect(normalizeAgentId("MAIN")).toBe("main");
    expect(normalizeAgentId("MyAgent")).toBe("myagent");
    expect(normalizeAgentId("Agent_42")).toBe("agent_42");
  });

  test("invalid characters collapse to '-'", () => {
    expect(normalizeAgentId("agent name")).toBe("agent-name");
    expect(normalizeAgentId("user@host")).toBe("user-host");
    expect(normalizeAgentId("a/b\\c")).toBe("a-b-c");
    expect(normalizeAgentId("a.b.c")).toBe("a-b-c");
    // Multi-char invalid runs collapse to a SINGLE '-'
    expect(normalizeAgentId("a   b")).toBe("a-b");
    expect(normalizeAgentId("a@@@b")).toBe("a-b");
  });

  test("leading and trailing dashes are stripped after sanitization", () => {
    // VALID_ID_RE requires the first char to be alnum, so "---main---"
    // fails validation, goes through the sanitization branch, and the
    // leading + trailing dashes get stripped.
    expect(normalizeAgentId("---main---")).toBe("main");
    // "@@@main@@@" → "---main---" → strip leading + trailing → "main"
    expect(normalizeAgentId("@@@main@@@")).toBe("main");
    // "  agent  " → trimmed first by .trim() then validated
    expect(normalizeAgentId("  myagent  ")).toBe("myagent");
  });

  test("input longer than 64 chars is truncated", () => {
    // 100 valid chars
    const long = "a".repeat(100);
    const result = normalizeAgentId(long);
    // VALID_ID_RE caps at 64 chars total → fails validation → goes through
    // sanitization branch → slice(0, 64)
    expect(result.length).toBe(64);
    expect(result).toBe("a".repeat(64));
  });

  test("input that sanitizes to empty falls back to DEFAULT_AGENT_ID", () => {
    expect(normalizeAgentId("@@@")).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId("---")).toBe(DEFAULT_AGENT_ID);
    expect(normalizeAgentId("///")).toBe(DEFAULT_AGENT_ID);
  });

  test("buildOpenClawSessionFilePath uses normalizeAgentId, not raw lowercase", () => {
    // Regression gate: Codex Turn N+3 caught that our prior version used
    // .toLowerCase() directly. Verify the path now reflects full sanitization.
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/test-state" };
    expect(
      buildOpenClawSessionFilePath({
        sessionId: "session1",
        agentId: "My Agent@2",
        env,
      }),
    ).toBe("/test-state/agents/my-agent-2/sessions/session1.jsonl");
  });
});

// =============================================================================
// Codex Turn N+4 — legacy state-dir fallback + filesystem-backed topic probe
// =============================================================================

describe("transcript-resolver — legacy state-dir fallback (Codex Turn N+4)", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(pathJoin(tmpdir(), "clawmem-resolver-"));
  });

  afterEach(() => {
    if (testHome) {
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures
      }
    }
  });

  test("prefers .openclaw when it exists", () => {
    mkdirSync(pathJoin(testHome, ".openclaw"), { recursive: true });
    mkdirSync(pathJoin(testHome, ".clawdbot"), { recursive: true });

    const stateDir = resolveOpenClawStateDir({}, () => testHome);
    expect(stateDir).toBe(pathJoin(testHome, ".openclaw"));
  });

  test("falls back to legacy .clawdbot when .openclaw is missing but .clawdbot exists", () => {
    // Codex Turn N+4 HIGH regression gate: prior implementation always
    // synthesized .openclaw and never checked .clawdbot. Upgraded-but-not-
    // migrated installs would point at a non-existent path while OpenClaw
    // itself runs from .clawdbot.
    mkdirSync(pathJoin(testHome, ".clawdbot"), { recursive: true });
    // Note: NO .openclaw created

    const stateDir = resolveOpenClawStateDir({}, () => testHome);
    expect(stateDir).toBe(pathJoin(testHome, ".clawdbot"));
  });

  test("synthesizes .openclaw when neither dir exists (first-run case)", () => {
    // Empty home — both dirs absent
    const stateDir = resolveOpenClawStateDir({}, () => testHome);
    expect(stateDir).toBe(pathJoin(testHome, ".openclaw"));
  });

  test("OPENCLAW_STATE_DIR env override skips legacy fallback entirely", () => {
    mkdirSync(pathJoin(testHome, ".clawdbot"), { recursive: true });
    const customStateDir = pathJoin(testHome, "custom-state");
    mkdirSync(customStateDir, { recursive: true });

    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: customStateDir };
    const stateDir = resolveOpenClawStateDir(env, () => testHome);
    expect(stateDir).toBe(customStateDir);
  });

  test("OPENCLAW_TEST_FAST=1 skips existence checks (matches OpenClaw)", () => {
    // Even with .clawdbot present, TEST_FAST should return the synthesized
    // new dir without checking either path.
    mkdirSync(pathJoin(testHome, ".clawdbot"), { recursive: true });
    const env: NodeJS.ProcessEnv = { OPENCLAW_TEST_FAST: "1" };

    const stateDir = resolveOpenClawStateDir(env, () => testHome);
    expect(stateDir).toBe(pathJoin(testHome, ".openclaw"));
  });
});

describe("transcript-resolver — topic-scoped session probe (Codex Turn N+4)", () => {
  let testHome: string;
  let env: NodeJS.ProcessEnv;
  const agentId = "main";

  function sessionsDir(): string {
    return pathJoin(testHome, ".openclaw", "agents", agentId, "sessions");
  }

  beforeEach(() => {
    testHome = mkdtempSync(pathJoin(tmpdir(), "clawmem-resolver-topic-"));
    env = { OPENCLAW_STATE_DIR: pathJoin(testHome, ".openclaw") };
    mkdirSync(sessionsDir(), { recursive: true });
  });

  afterEach(() => {
    if (testHome) {
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  test("returns the base filename when it exists", () => {
    const sessionId = "abc123";
    const baseFile = pathJoin(sessionsDir(), `${sessionId}.jsonl`);
    writeFileSync(baseFile, "{}");

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBe(baseFile);
  });

  test("falls back to single topic-scoped variant when base file missing", () => {
    // Codex Turn N+4 HIGH regression gate: handler call sites do NOT
    // pass topicId (PluginHookName events don't carry it), so the
    // resolver MUST probe the sessions dir for topic-scoped variants
    // when the base file is missing.
    const sessionId = "abc123";
    const topicFile = pathJoin(sessionsDir(), `${sessionId}-topic-foo.jsonl`);
    writeFileSync(topicFile, "{}");
    // Note: NO base file created

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBe(topicFile);
  });

  test("returns undefined when neither base nor any topic variant exists", () => {
    const resolved = resolveOpenClawSessionFile({
      sessionId: "missing",
      agentId,
      env,
    });
    expect(resolved).toBeUndefined();
  });

  test("returns undefined when multiple topic variants exist (ambiguous, no metadata)", () => {
    // 2+ matches → ambiguous; the canonical resolver cannot pick
    // without metadata. Fail-open, caller skips the hook.
    const sessionId = "abc123";
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}-topic-foo.jsonl`), "{}");
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}-topic-bar.jsonl`), "{}");

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBeUndefined();
  });

  test("explicit topicId wins and does NOT fall back to base filename", () => {
    const sessionId = "abc123";
    // Both base and topic-scoped present
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}.jsonl`), "base");
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}-topic-bar.jsonl`), "topic");

    const resolved = resolveOpenClawSessionFile({
      sessionId,
      agentId,
      topicId: "bar",
      env,
    });
    expect(resolved).toBe(pathJoin(sessionsDir(), `${sessionId}-topic-bar.jsonl`));
  });

  test("base + topic coexist WITHOUT sessions.json or topicId → fail-open (Codex Turn N+5 regression gate)", () => {
    // Codex Turn N+5 MEDIUM finding: prior version preferred the base
    // file silently. The fix is to fail-open when the resolver cannot
    // tell which transcript is active.
    const sessionId = "abc123";
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}.jsonl`), "base");
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}-topic-bar.jsonl`), "topic");
    // No sessions.json present, no explicit topicId from caller

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBeUndefined();
  });

  test("explicit topicId returns undefined when that exact file missing (no fallback)", () => {
    const sessionId = "abc123";
    // Base file present but caller asked for a specific topic that doesn't exist
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}.jsonl`), "base");

    const resolved = resolveOpenClawSessionFile({
      sessionId,
      agentId,
      topicId: "nonexistent",
      env,
    });
    expect(resolved).toBeUndefined();
  });

  test("topic probe ignores files that don't end in .jsonl", () => {
    const sessionId = "abc123";
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}-topic-foo.txt`), "noise");
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}-topic-bar.jsonl.bak`), "noise");

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBeUndefined();
  });

  test("topic probe matches only files for the exact sessionId prefix", () => {
    const sessionId = "abc123";
    // Different sessionId with a topic suffix — must NOT be picked up
    writeFileSync(pathJoin(sessionsDir(), `xyz789-topic-foo.jsonl`), "noise");
    // Real match
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}-topic-foo.jsonl`), "real");

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBe(pathJoin(sessionsDir(), `${sessionId}-topic-foo.jsonl`));
  });
});

describe("transcript-resolver — sessions.json authoritative lookup (Codex Turn N+5)", () => {
  let testHome: string;
  let env: NodeJS.ProcessEnv;
  const agentId = "main";

  function sessionsDir(): string {
    return pathJoin(testHome, ".openclaw", "agents", agentId, "sessions");
  }

  function writeStore(entries: Record<string, unknown>): void {
    writeFileSync(pathJoin(sessionsDir(), "sessions.json"), JSON.stringify(entries));
  }

  beforeEach(() => {
    testHome = mkdtempSync(pathJoin(tmpdir(), "clawmem-resolver-store-"));
    env = { OPENCLAW_STATE_DIR: pathJoin(testHome, ".openclaw") };
    mkdirSync(sessionsDir(), { recursive: true });
  });

  afterEach(() => {
    if (testHome) {
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  test("sessions.json with exact sessionKey match wins over filesystem probe", () => {
    const sessionId = "abc123";
    const sessionKey = "agent:main:abc123";

    // Both base and topic-scoped present on disk
    const baseFile = pathJoin(sessionsDir(), `${sessionId}.jsonl`);
    const topicFile = pathJoin(sessionsDir(), `${sessionId}-topic-bar.jsonl`);
    writeFileSync(baseFile, "base");
    writeFileSync(topicFile, "topic");

    // sessions.json says the active transcript is the topic-scoped one
    writeStore({
      [sessionKey]: {
        sessionId,
        sessionFile: `${sessionId}-topic-bar.jsonl`,
      },
    });

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, sessionKey, env });
    // Without sessions.json this would be ambiguous (both files exist).
    // With sessions.json, the resolver picks the one the store says is active.
    expect(resolved).toBe(topicFile);
  });

  test("sessions.json scan-by-sessionId works when sessionKey unknown", () => {
    const sessionId = "abc123";

    const baseFile = pathJoin(sessionsDir(), `${sessionId}.jsonl`);
    const topicFile = pathJoin(sessionsDir(), `${sessionId}-topic-foo.jsonl`);
    writeFileSync(baseFile, "base");
    writeFileSync(topicFile, "topic");

    // Store has the entry under a different key — resolver must scan
    writeStore({
      "some:other:key": { sessionId: "different-session", sessionFile: "noise.jsonl" },
      "agent:main:abc123": { sessionId, sessionFile: `${sessionId}-topic-foo.jsonl` },
    });

    // Caller does NOT pass sessionKey — resolver scans for sessionId match
    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBe(topicFile);
  });

  test("sessions.json with absolute sessionFile path is honored", () => {
    const sessionId = "abc123";
    const sessionKey = "agent:main:abc123";

    // Use a real absolute path inside testHome so existsSync passes
    const absolutePath = pathJoin(testHome, "absolute-transcript.jsonl");
    writeFileSync(absolutePath, "absolute");

    writeStore({
      [sessionKey]: {
        sessionId,
        sessionFile: absolutePath, // absolute, not relative to sessionsDir
      },
    });

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, sessionKey, env });
    expect(resolved).toBe(absolutePath);
  });

  test("sessions.json with stale sessionFile (path doesn't exist) falls through to filesystem fallback", () => {
    const sessionId = "abc123";
    const sessionKey = "agent:main:abc123";

    const baseFile = pathJoin(sessionsDir(), `${sessionId}.jsonl`);
    writeFileSync(baseFile, "base");

    // sessions.json points at a nonexistent file
    writeStore({
      [sessionKey]: {
        sessionId,
        sessionFile: "stale-nonexistent.jsonl",
      },
    });

    // Resolver should NOT return the stale path; should fall through to
    // base filename detection.
    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, sessionKey, env });
    expect(resolved).toBe(baseFile);
  });

  test("malformed sessions.json (invalid JSON) is silently ignored", () => {
    const sessionId = "abc123";
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}.jsonl`), "base");
    writeFileSync(pathJoin(sessionsDir(), "sessions.json"), "{malformed:");

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    // Falls through to filesystem fallback, finds base file
    expect(resolved).toBe(pathJoin(sessionsDir(), `${sessionId}.jsonl`));
  });

  test("missing sessions.json is silently ignored", () => {
    const sessionId = "abc123";
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}.jsonl`), "base");
    // No sessions.json created

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBe(pathJoin(sessionsDir(), `${sessionId}.jsonl`));
  });

  test("empty sessions.json is silently ignored", () => {
    const sessionId = "abc123";
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}.jsonl`), "base");
    writeFileSync(pathJoin(sessionsDir(), "sessions.json"), "");

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBe(pathJoin(sessionsDir(), `${sessionId}.jsonl`));
  });

  test("sessions.json without matching sessionId falls through to filesystem", () => {
    const sessionId = "abc123";
    writeFileSync(pathJoin(sessionsDir(), `${sessionId}.jsonl`), "base");

    writeStore({
      "agent:main:other": { sessionId: "different", sessionFile: "noise.jsonl" },
    });

    const resolved = resolveOpenClawSessionFile({ sessionId, agentId, env });
    expect(resolved).toBe(pathJoin(sessionsDir(), `${sessionId}.jsonl`));
  });

  test("sessions.json disambiguates base+topic coexistence (resolves Codex Turn N+5 ambiguity case)", () => {
    const sessionId = "abc123";
    const sessionKey = "agent:main:abc123";

    // The exact scenario codex flagged: base AND topic coexist
    const baseFile = pathJoin(sessionsDir(), `${sessionId}.jsonl`);
    const topicFile = pathJoin(sessionsDir(), `${sessionId}-topic-active.jsonl`);
    writeFileSync(baseFile, "base");
    writeFileSync(topicFile, "topic");

    // With sessions.json: resolver picks the right one
    writeStore({
      [sessionKey]: {
        sessionId,
        sessionFile: `${sessionId}-topic-active.jsonl`,
      },
    });
    expect(resolveOpenClawSessionFile({ sessionId, agentId, sessionKey, env })).toBe(topicFile);

    // Without sessions.json (delete it): resolver fails-open
    rmSync(pathJoin(sessionsDir(), "sessions.json"));
    expect(resolveOpenClawSessionFile({ sessionId, agentId, sessionKey, env })).toBeUndefined();
  });
});

// =============================================================================
// Shipping Condition 2 — stale contextEngine config migration text presence
// =============================================================================
//
// We can't shell out to a real `openclaw config` command in unit tests, so
// instead validate that the migration messages and helper exist verbatim
// in the source. The full integration check (real openclaw config get →
// set roundtrip) belongs in the integration test suite, but the regression
// gate against the migration text disappearing lives here.

describe("Shipping Condition 2 — setup-time migration text is present", () => {
  test("clawmem.ts cmdSetupOpenClaw includes the migration message", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/clawmem.ts`);
    const content = await file.text();
    // Regression gate: this exact phrase must appear so the user knows the
    // upgrade is happening and what changed. If the message moves, update
    // the substring here — but never delete it without surfacing to the
    // user another way.
    expect(content).toContain("Upgrade migration detected");
    expect(content).toContain("plugins.slots.contextEngine: clawmem → legacy");
    // v0.10.0 next-steps uses `openclaw plugins enable clawmem` (switches the
    // exclusive memory slot + disables memory-core/memory-lancedb in one shot)
    // instead of the older `openclaw config set plugins.slots.memory clawmem`
    // pattern, which failed on v2026.4.11 because the slot validator rejected
    // unregistered plugin ids.
    expect(content).toContain("openclaw plugins enable clawmem");
    expect(content).toContain("plugins.entries.clawmem.config.gpuLlmModel");
    // Dreaming-disable note is also non-negotiable per §14.9
    expect(content).toContain("dreaming.enabled = false");
  });

  test("cmdSetupOpenClaw defaults to copy mode (v2026.4.11+ compat)", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/clawmem.ts`);
    const content = await file.text();
    // OpenClaw v2026.4.11+ discoverInDirectory uses readdirSync({ withFileTypes: true })
    // where symlink.isDirectory() === false, so symlinked plugins are silently
    // skipped. Setup must default to recursive copy and only use symlinks
    // under an opt-in --link flag for dev mode or older OpenClaw versions.
    expect(content).toContain("cpSync(pluginDir, linkPath");
    expect(content).toContain('args.includes("--link")');
  });

  test("src/openclaw/package.json declares openclaw.extensions (v2026.4.11+ discovery gate)", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/package.json`);
    const content = await file.text();
    const pkg = JSON.parse(content);
    // Required by OpenClaw's discoverInDirectory: without a package.json that
    // declares `openclaw.extensions`, the plugin directory is silently skipped
    // during discovery on v2026.4.11+. `openclaw.plugin.json` alone is not enough.
    expect(pkg.type).toBe("module");
    expect(Array.isArray(pkg.openclaw?.extensions)).toBe(true);
    expect(pkg.openclaw.extensions).toContain("./index.ts");
  });

  test("cmdDoctor surfaces stale plugins.slots.contextEngine = clawmem as an issue", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/clawmem.ts`);
    const content = await file.text();
    expect(content).toContain('plugins.slots.contextEngine = "clawmem"');
    // Doctor output must point users at the fix command
    expect(content).toContain("clawmem setup openclaw");
  });

  test("readOpenClawConfigValue helper exists in clawmem.ts", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/clawmem.ts`);
    const content = await file.text();
    expect(content).toContain("function readOpenClawConfigValue");
  });
});
