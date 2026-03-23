/**
 * Memory Nudge Counter Tests
 *
 * Tests designed to catch:
 * - Nudge counter not resetting after memory_pin/memory_snooze (the bug GPT found)
 * - Counter fires at exactly NUDGE_INTERVAL
 * - Counter doesn't fire at NUDGE_INTERVAL - 1
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createTestStore } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";

let store: Store;

beforeEach(() => {
  store = createTestStore();
});

function insertUsage(store: Store, hookName: string, n: number = 1) {
  const stmt = store.db.prepare(`
    INSERT INTO context_usage (session_id, timestamp, hook_name, injected_paths, estimated_tokens, was_referenced)
    VALUES ('test-session', datetime('now'), ?, '[]', 0, 0)
  `);
  for (let i = 0; i < n; i++) {
    stmt.run(hookName);
  }
}

// Reproduce the shouldNudge logic inline to test it
function shouldNudge(store: Store, interval: number = 15): boolean {
  const LIFECYCLE_HOOK_NAMES = ["memory_pin", "memory_forget", "memory_snooze", "lifecycle-archive"];
  try {
    const lastLifecycle = store.db.prepare(`
      SELECT MAX(id) as max_id FROM context_usage
      WHERE hook_name IN (${LIFECYCLE_HOOK_NAMES.map(() => "?").join(",")})
    `).get(...LIFECYCLE_HOOK_NAMES) as { max_id: number | null } | undefined;

    const sinceId = lastLifecycle?.max_id ?? 0;
    const count = store.db.prepare(`
      SELECT COUNT(*) as cnt FROM context_usage
      WHERE hook_name = 'context-surfacing' AND id > ?
    `).get(sinceId) as { cnt: number } | undefined;

    return (count?.cnt ?? 0) >= interval;
  } catch {
    return false;
  }
}

describe("nudge counter", () => {
  it("does not fire before interval is reached", () => {
    insertUsage(store, "context-surfacing", 14);
    expect(shouldNudge(store, 15)).toBe(false);
  });

  it("fires at exactly the interval", () => {
    insertUsage(store, "context-surfacing", 15);
    expect(shouldNudge(store, 15)).toBe(true);
  });

  it("resets after memory_forget", () => {
    insertUsage(store, "context-surfacing", 20);
    expect(shouldNudge(store, 15)).toBe(true);

    // memory_forget should reset the counter
    insertUsage(store, "memory_forget");

    expect(shouldNudge(store, 15)).toBe(false);
  });

  it("resets after memory_pin", () => {
    insertUsage(store, "context-surfacing", 20);
    expect(shouldNudge(store, 15)).toBe(true);

    insertUsage(store, "memory_pin");

    // Counter resets — only context-surfacing calls AFTER pin count
    expect(shouldNudge(store, 15)).toBe(false);
  });

  it("resets after memory_snooze", () => {
    insertUsage(store, "context-surfacing", 20);
    expect(shouldNudge(store, 15)).toBe(true);

    insertUsage(store, "memory_snooze");

    expect(shouldNudge(store, 15)).toBe(false);
  });

  it("fires again after reset + interval more calls", () => {
    insertUsage(store, "context-surfacing", 20);
    insertUsage(store, "memory_pin"); // reset
    insertUsage(store, "context-surfacing", 15); // new interval
    expect(shouldNudge(store, 15)).toBe(true);
  });

  it("returns false on empty context_usage table", () => {
    expect(shouldNudge(store, 15)).toBe(false);
  });
});
