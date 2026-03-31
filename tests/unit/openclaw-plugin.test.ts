/**
 * Tests for ClawMem OpenClaw Plugin
 *
 * Unit tests for the plugin adapter — shell utilities, engine lifecycle,
 * config resolution. Does not require a running ClawMem instance.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { resolveClawMemBin, parseHookOutput, extractContext } from "../../src/openclaw/shell.ts";
import { ClawMemContextEngine } from "../../src/openclaw/engine.ts";
import type { ClawMemConfig } from "../../src/openclaw/shell.ts";

// =============================================================================
// Shell Utilities
// =============================================================================

describe("resolveClawMemBin", () => {
  test("returns configured path if it exists", () => {
    // The bin/clawmem script exists in the repo
    const result = resolveClawMemBin(
      `${import.meta.dir}/../../bin/clawmem`
    );
    expect(result).toContain("bin/clawmem");
  });

  test("falls back to 'clawmem' if no configured path", () => {
    const result = resolveClawMemBin("/nonexistent/path/clawmem");
    // Should either find a real path or fall back to "clawmem"
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
// ContextEngine
// =============================================================================

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const mockConfig: ClawMemConfig = {
  clawmemBin: "clawmem",
  tokenBudget: 800,
  profile: "balanced",
  enableTools: true,
  servePort: 7438,
  env: {},
};

describe("ClawMemContextEngine", () => {
  let engine: ClawMemContextEngine;

  beforeEach(() => {
    engine = new ClawMemContextEngine(mockConfig, mockLogger);
  });

  test("has correct engine info", () => {
    expect(engine.info.id).toBe("clawmem");
    expect(engine.info.name).toBe("ClawMem Memory System");
    expect(engine.info.ownsCompaction).toBe(false);
  });

  test("ingest returns not ingested (no-op)", async () => {
    const result = await engine.ingest({
      sessionId: "test-session",
      message: { role: "user", content: "hello" },
    });
    expect(result.ingested).toBe(false);
  });

  test("assemble is pass-through", async () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await engine.assemble({
      sessionId: "test-session",
      messages,
      tokenBudget: 4000,
    });
    expect(result.messages).toBe(messages); // Same reference — pass-through
    expect(result.estimatedTokens).toBe(0);
  });

  test("compact delegates to runtime (fails gracefully without OpenClaw SDK)", async () => {
    // Without OpenClaw SDK, delegateCompactionToRuntime import fails → fail-safe
    const result = await engine.compact({
      sessionId: "test-session",
      sessionFile: "/tmp/nonexistent.jsonl",
    });
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("delegation-failed");
  });

  test("takeBootstrapContext returns undefined when no cached context", () => {
    expect(engine.takeBootstrapContext("nonexistent")).toBeUndefined();
  });

  test("clearSession removes cached bootstrap context", async () => {
    // bootstrap() will fail to shell out but won't cache anything
    await engine.bootstrap({
      sessionId: "test-1",
      sessionFile: "/tmp/nonexistent.jsonl",
    });
    // No context cached (hook failed), but clearSession should not throw
    engine.clearSession("test-1");
    expect(engine.takeBootstrapContext("test-1")).toBeUndefined();
  });

  test("dispose clears all state", async () => {
    await engine.bootstrap({
      sessionId: "test-1",
      sessionFile: "/tmp/nonexistent.jsonl",
    });
    await engine.dispose();
    expect(engine.takeBootstrapContext("test-1")).toBeUndefined();
  });

  test("afterTurn skips heartbeat turns", async () => {
    // Should not throw even with invalid config
    await engine.afterTurn({
      sessionId: "test-1",
      sessionFile: "/tmp/nonexistent.jsonl",
      messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }],
      prePromptMessageCount: 0,
      isHeartbeat: true,
    });
    // No assertion needed — just verifying it doesn't throw
  });

  test("afterTurn skips when too few new messages", async () => {
    await engine.afterTurn({
      sessionId: "test-1",
      sessionFile: "/tmp/nonexistent.jsonl",
      messages: [{ role: "user" }],
      prePromptMessageCount: 0,
    });
    // No assertion needed
  });
});

// =============================================================================
// Plugin Config
// =============================================================================

describe("plugin config", () => {
  test("plugin.json is valid JSON", async () => {
    const file = Bun.file(`${import.meta.dir}/../../src/openclaw/plugin.json`);
    const content = await file.json();
    expect(content.id).toBe("clawmem");
    expect(content.kind).toBe("context-engine");
    expect(content.configSchema).toBeDefined();
    expect(content.configSchema.properties.clawmemBin).toBeDefined();
    expect(content.configSchema.properties.tokenBudget).toBeDefined();
    expect(content.configSchema.properties.profile).toBeDefined();
  });
});
