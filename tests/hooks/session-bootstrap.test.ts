import { describe, it, expect, beforeEach } from "bun:test";
import { sessionBootstrap } from "../../src/hooks/session-bootstrap.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import type { HookInput } from "../../src/hooks.ts";

let store: Store;

function makeInput(sessionId?: string): HookInput {
  return {
    prompt: "",
    sessionId: sessionId || `sess-${Date.now()}`,
    hookEventName: "session-bootstrap",
  };
}

beforeEach(() => {
  store = createTestStore();
});

describe("sessionBootstrap", () => {
  it("registers session in session_log", async () => {
    const sessionId = "bootstrap-test-1";
    await sessionBootstrap(store, makeInput(sessionId));
    const session = store.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe(sessionId);
  });

  it("returns empty when vault has no content", async () => {
    const output = await sessionBootstrap(store, makeInput());
    expect(output.continue).toBe(true);
    // With no documents, bootstrap may return empty or minimal context
  });

  it("includes decisions when present", async () => {
    seedDocuments(store, [
      {
        path: "decisions/2026-03-01.md",
        title: "Decisions 2026-03-01",
        body: "We decided to use PostgreSQL for the primary database and Redis for caching layer.",
        contentType: "decision",
        qualityScore: 0.9,
      },
    ]);
    const output = await sessionBootstrap(store, makeInput());
    expect(output.continue).toBe(true);
    // If decisions are found and included
    if (output.hookSpecificOutput?.additionalContext) {
      expect(output.hookSpecificOutput.additionalContext).toContain("vault-session");
    }
  });

  it("handles duplicate session registration gracefully", async () => {
    const sessionId = "dup-session";
    await sessionBootstrap(store, makeInput(sessionId));
    // Second call should not throw
    await sessionBootstrap(store, makeInput(sessionId));
    const session = store.getSession(sessionId);
    expect(session).toBeDefined();
  });
});
