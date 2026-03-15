import { describe, it, expect, beforeEach } from "bun:test";
import { createStore, type Store } from "../../src/store.ts";

let store: Store;

beforeEach(() => {
  store = createStore(":memory:");
});

// ─── Session tracking ───────────────────────────────────────────────

describe("session tracking", () => {
  it("insertSession creates session record", () => {
    store.insertSession("sess-1", "2026-03-01T10:00:00Z");
    const session = store.getSession("sess-1");
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("sess-1");
  });

  it("updateSession sets endedAt and summary", () => {
    store.insertSession("sess-1", "2026-03-01T10:00:00Z");
    store.updateSession("sess-1", {
      endedAt: "2026-03-01T11:00:00Z",
      summary: "Fixed bugs",
    });
    const session = store.getSession("sess-1");
    expect(session!.endedAt).toBe("2026-03-01T11:00:00Z");
    expect(session!.summary).toBe("Fixed bugs");
  });

  it("getSession returns full session", () => {
    store.insertSession("sess-1", "2026-03-01T10:00:00Z", "workstation-1");
    const session = store.getSession("sess-1");
    expect(session).toBeDefined();
    expect(session!.startedAt).toBe("2026-03-01T10:00:00Z");
  });

  it("getRecentSessions returns latest N sessions", () => {
    store.insertSession("sess-1", "2026-03-01T10:00:00Z");
    store.insertSession("sess-2", "2026-03-02T10:00:00Z");
    store.insertSession("sess-3", "2026-03-03T10:00:00Z");
    const recent = store.getRecentSessions(2);
    expect(recent).toHaveLength(2);
  });
});

// ─── Context usage ──────────────────────────────────────────────────

describe("context usage", () => {
  it("insertUsage records injection event", () => {
    store.insertSession("sess-1", "2026-03-01T10:00:00Z");
    store.insertUsage({
      sessionId: "sess-1",
      hookName: "context-surfacing",
      injectedPaths: ["test/file.md"],
      estimatedTokens: 100,
      timestamp: "2026-03-01T10:01:00Z",
      wasReferenced: 0,
    });
    const usage = store.getUsageForSession("sess-1");
    expect(usage.length).toBeGreaterThanOrEqual(1);
  });

  it("markUsageReferenced updates was_referenced flag", () => {
    store.insertSession("sess-1", "2026-03-01T10:00:00Z");
    store.insertUsage({
      sessionId: "sess-1",
      hookName: "context-surfacing",
      injectedPaths: ["test/file.md"],
      estimatedTokens: 50,
      timestamp: "2026-03-01T10:01:00Z",
      wasReferenced: 0,
    });
    const usage = store.getUsageForSession("sess-1");
    if (usage.length > 0 && usage[0]!.id) {
      store.markUsageReferenced(usage[0]!.id);
      const updated = store.getUsageForSession("sess-1");
      expect(updated[0]!.wasReferenced).toBe(1);
    }
  });
});
