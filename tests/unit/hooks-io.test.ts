import { describe, it, expect, beforeEach } from "bun:test";
import {
  makeContextOutput,
  makeEmptyOutput,
  estimateTokens,
  smartTruncate,
  isHeartbeatPrompt,
  wasPromptSeenRecently,
} from "../../src/hooks.ts";
import { createTestStore } from "../helpers/test-store.ts";

// ─── makeContextOutput ──────────────────────────────────────────────

describe("makeContextOutput", () => {
  it("returns hookSpecificOutput for context-surfacing", () => {
    const output = makeContextOutput("context-surfacing", "<vault-context>test</vault-context>");
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput!.additionalContext).toContain("test");
  });

  it("returns hookSpecificOutput for postcompact-inject", () => {
    const output = makeContextOutput("postcompact-inject", "<vault-postcompact>data</vault-postcompact>");
    expect(output.hookSpecificOutput).toBeDefined();
  });
});

describe("makeEmptyOutput", () => {
  it("returns a valid HookOutput", () => {
    const output = makeEmptyOutput();
    expect(output).toBeDefined();
    expect(output.continue).toBe(true);
  });

  it("returns empty output with hook name", () => {
    const output = makeEmptyOutput("context-surfacing");
    expect(output.continue).toBe(true);
  });
});

// ─── estimateTokens ─────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    const text = "x".repeat(400);
    const tokens = estimateTokens(text);
    expect(tokens).toBeCloseTo(100, -1); // ~100 tokens ± 10
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

// ─── smartTruncate ──────────────────────────────────────────────────

describe("smartTruncate", () => {
  it("returns original text when under limit", () => {
    expect(smartTruncate("short text", 100)).toBe("short text");
  });

  it("truncates long text", () => {
    const long = "word ".repeat(100);
    const truncated = smartTruncate(long, 50);
    expect(truncated.length).toBeLessThanOrEqual(55); // some buffer for ellipsis
  });

  it("breaks at word boundary with ellipsis", () => {
    const text = "hello world this is a test sentence";
    const truncated = smartTruncate(text, 15);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

// ─── isHeartbeatPrompt ──────────────────────────────────────────────

describe("isHeartbeatPrompt", () => {
  it("returns true for 'ping'", () => {
    expect(isHeartbeatPrompt("ping")).toBe(true);
  });

  it("returns true for 'heartbeat'", () => {
    expect(isHeartbeatPrompt("heartbeat")).toBe(true);
  });

  it("returns true for empty prompt", () => {
    expect(isHeartbeatPrompt("")).toBe(true);
  });

  it("returns true for slash commands", () => {
    expect(isHeartbeatPrompt("/compact")).toBe(true);
    expect(isHeartbeatPrompt("/memory")).toBe(true);
  });

  it("returns false for real queries", () => {
    expect(isHeartbeatPrompt("explain the architecture")).toBe(false);
    expect(isHeartbeatPrompt("fix the authentication bug")).toBe(false);
  });
});

// ─── wasPromptSeenRecently ──────────────────────────────────────────

describe("wasPromptSeenRecently", () => {
  it("returns false on first submission", () => {
    const store = createTestStore();
    expect(wasPromptSeenRecently(store, "context-surfacing", "unique query 1")).toBe(false);
  });

  it("returns true on duplicate within window", () => {
    const store = createTestStore();
    wasPromptSeenRecently(store, "context-surfacing", "duplicate query");
    expect(wasPromptSeenRecently(store, "context-surfacing", "duplicate query")).toBe(true);
  });

  it("returns false for different queries", () => {
    const store = createTestStore();
    wasPromptSeenRecently(store, "context-surfacing", "query A");
    expect(wasPromptSeenRecently(store, "context-surfacing", "query B")).toBe(false);
  });
});
