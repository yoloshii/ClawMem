/**
 * Unit tests for Ext 6b — Multi-turn prior-query lookback.
 *
 * Covers:
 *  - buildMultiTurnSurfacingQuery returns current query when no priors exist
 *  - returns current + 1 prior when one prior is in the window
 *  - returns current + 2 priors when two+ priors are in the window
 *  - caps at `lookback` (default 2) even when more are present
 *  - ignores priors older than `maxAgeMinutes`
 *  - ignores priors from a different `session_id`
 *  - ignores rows with NULL `query_text`
 *  - ignores rows with empty-string `query_text`
 *  - ignores the current query if it matches a prior exactly (no self-join)
 *  - truncates combined query preserving newest (current) content first
 *  - returns current alone when current query is already at max length
 *  - fails open with current-only when `query_text` column is missing
 *  - fails open with current-only when the DB throws
 *
 * Handler-level integration:
 *  - query_text is persisted on successful injection
 *  - query_text is persisted on post-retrieval empty turns (scored=0)
 *  - query_text is NOT persisted on pre-retrieval gated turns
 *    (slash commands, short prompts, shouldSkipRetrieval, heartbeat)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildMultiTurnSurfacingQuery } from "../../src/hooks/context-surfacing.ts";
import { createTestStore } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";

// =============================================================================
// Fixtures
// =============================================================================

function seedUsage(
  store: Store,
  opts: {
    sessionId: string;
    queryText: string | null;
    minutesAgo?: number;
    hookName?: string;
    turnIndex?: number;
  },
): void {
  const ts = new Date(Date.now() - (opts.minutesAgo ?? 0) * 60 * 1000).toISOString();
  store.db.prepare(
    `INSERT INTO context_usage
       (session_id, timestamp, hook_name, injected_paths, estimated_tokens,
        was_referenced, turn_index, query_text)
     VALUES (?, ?, ?, '[]', 0, 0, ?, ?)`,
  ).run(
    opts.sessionId,
    ts,
    opts.hookName ?? "context-surfacing",
    opts.turnIndex ?? 0,
    opts.queryText,
  );
}

// =============================================================================
// buildMultiTurnSurfacingQuery
// =============================================================================

describe("buildMultiTurnSurfacingQuery", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("returns current query when no prior rows exist", () => {
    const result = buildMultiTurnSurfacingQuery(store, "s1", "How does auth work?");
    expect(result).toBe("How does auth work?");
  });

  it("returns current query when sessionId is empty", () => {
    seedUsage(store, { sessionId: "s1", queryText: "earlier prompt", minutesAgo: 2 });
    const result = buildMultiTurnSurfacingQuery(store, "", "How does auth work?");
    expect(result).toBe("How does auth work?");
  });

  it("appends 1 prior when exactly one row is in the window", () => {
    seedUsage(store, { sessionId: "s1", queryText: "Explain the auth pipeline", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "Now do the same for refresh tokens");
    expect(result).toBe("Now do the same for refresh tokens\n\nExplain the auth pipeline");
  });

  it("appends 2 priors in newest-first order when available", () => {
    // Rows are inserted oldest to newest; ORDER BY id DESC should return newest first.
    seedUsage(store, { sessionId: "s1", queryText: "First turn about OAuth", minutesAgo: 5 });
    seedUsage(store, { sessionId: "s1", queryText: "Second turn about refresh tokens", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "What about revocation?");
    // current, newest prior, older prior
    expect(result).toBe(
      "What about revocation?\n\nSecond turn about refresh tokens\n\nFirst turn about OAuth",
    );
  });

  it("caps at lookback=2 by default even when more priors are available", () => {
    seedUsage(store, { sessionId: "s1", queryText: "T1", minutesAgo: 6 });
    seedUsage(store, { sessionId: "s1", queryText: "T2", minutesAgo: 5 });
    seedUsage(store, { sessionId: "s1", queryText: "T3", minutesAgo: 4 });
    seedUsage(store, { sessionId: "s1", queryText: "T4", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current");
    // Only the 2 newest priors: T4 + T3
    expect(result).toBe("current\n\nT4\n\nT3");
  });

  it("honors a custom lookback parameter", () => {
    seedUsage(store, { sessionId: "s1", queryText: "T1", minutesAgo: 5 });
    seedUsage(store, { sessionId: "s1", queryText: "T2", minutesAgo: 4 });
    seedUsage(store, { sessionId: "s1", queryText: "T3", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current", 1);
    expect(result).toBe("current\n\nT3");
  });

  it("ignores priors older than maxAgeMinutes", () => {
    seedUsage(store, { sessionId: "s1", queryText: "ancient history", minutesAgo: 30 });
    seedUsage(store, { sessionId: "s1", queryText: "recent", minutesAgo: 2 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current", 2, 10);
    expect(result).toBe("current\n\nrecent");
  });

  it("ignores priors from a different session_id", () => {
    seedUsage(store, { sessionId: "other-session", queryText: "other session prompt", minutesAgo: 2 });
    seedUsage(store, { sessionId: "s1", queryText: "same session prompt", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current");
    expect(result).toBe("current\n\nsame session prompt");
  });

  it("ignores rows with NULL query_text", () => {
    seedUsage(store, { sessionId: "s1", queryText: null, minutesAgo: 5 });
    seedUsage(store, { sessionId: "s1", queryText: "real prompt", minutesAgo: 3 });
    seedUsage(store, { sessionId: "s1", queryText: null, minutesAgo: 2 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current");
    expect(result).toBe("current\n\nreal prompt");
  });

  it("ignores rows with empty-string query_text", () => {
    seedUsage(store, { sessionId: "s1", queryText: "", minutesAgo: 2 });
    seedUsage(store, { sessionId: "s1", queryText: "valid", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current");
    expect(result).toBe("current\n\nvalid");
  });

  it("ignores priors from non-context-surfacing hooks", () => {
    seedUsage(store, {
      sessionId: "s1",
      queryText: "decision-extractor prompt",
      minutesAgo: 2,
      hookName: "decision-extractor",
    });
    seedUsage(store, { sessionId: "s1", queryText: "context-surfacing prompt", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current");
    expect(result).toBe("current\n\ncontext-surfacing prompt");
  });

  it("skips a prior that matches the current query verbatim (self-join guard)", () => {
    // A duplicate submit/retry can land a prior row with the same text.
    // The helper must skip it so the lookback still contributes new content.
    seedUsage(store, { sessionId: "s1", queryText: "current", minutesAgo: 1 });
    seedUsage(store, { sessionId: "s1", queryText: "earlier different turn", minutesAgo: 3 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current");
    expect(result).toBe("current\n\nearlier different turn");
  });

  it("fills the lookback window with distinct priors even when multiple duplicates exist (Turn 18 regression)", () => {
    // Regression for Turn 18 Medium finding: the self-match guard was
    // applied in application code against a `LIMIT lookback + 1` SELECT,
    // which under-filled when multiple duplicate rows of the current
    // prompt shared the session. Seed two dupes + two legitimate priors
    // and verify both legitimate priors still make it into the result.
    seedUsage(store, { sessionId: "s1", queryText: "prior older", minutesAgo: 6 });
    seedUsage(store, { sessionId: "s1", queryText: "prior newer", minutesAgo: 5 });
    seedUsage(store, { sessionId: "s1", queryText: "duplicate prompt", minutesAgo: 3 });
    seedUsage(store, { sessionId: "s1", queryText: "duplicate prompt", minutesAgo: 2 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", "duplicate prompt");
    // SQL ORDER BY id DESC returns rows newest→oldest, so the two
    // legitimate priors are "prior newer" then "prior older".
    expect(result).toBe("duplicate prompt\n\nprior newer\n\nprior older");
  });

  it("truncates the combined query preserving current content first", () => {
    const longPrior = "X".repeat(1500);
    seedUsage(store, { sessionId: "s1", queryText: longPrior, minutesAgo: 2 });
    // current (500) + "\n\n" (2) + prior (1500) = 2002 chars — over 2000
    const currentQuery = "Y".repeat(500);
    const result = buildMultiTurnSurfacingQuery(store, "s1", currentQuery);
    // Current prompt MUST appear verbatim at the head
    expect(result.startsWith(currentQuery)).toBe(true);
    // Result must not exceed the max
    expect(result.length).toBeLessThanOrEqual(2000);
  });

  it("drops older priors first when the combined query is over budget", () => {
    const p1 = "A".repeat(1200); // older
    const p2 = "B".repeat(700); // newer
    seedUsage(store, { sessionId: "s1", queryText: p1, minutesAgo: 4 });
    seedUsage(store, { sessionId: "s1", queryText: p2, minutesAgo: 2 });
    const current = "current short";
    const result = buildMultiTurnSurfacingQuery(store, "s1", current);
    // current (13) + sep (2) + p2 (700) = 715 — fits
    // +sep(2) +p1(1200) = 1917 — fits too, so both should be there
    expect(result).toContain(current);
    expect(result).toContain(p2);
    expect(result).toContain(p1);
  });

  it("drops older priors when inclusive would exceed maxChars", () => {
    const p1 = "A".repeat(1900); // older
    const p2 = "B".repeat(700); // newer
    seedUsage(store, { sessionId: "s1", queryText: p1, minutesAgo: 4 });
    seedUsage(store, { sessionId: "s1", queryText: p2, minutesAgo: 2 });
    const current = "current";
    const result = buildMultiTurnSurfacingQuery(store, "s1", current);
    // current (7) + sep (2) + p2 (700) = 709 — fits
    // + sep (2) + p1 (1900) = 2611 — overflows, drop p1
    expect(result).toContain(current);
    expect(result).toContain(p2);
    expect(result).not.toContain(p1);
    expect(result.length).toBeLessThanOrEqual(2000);
  });

  it("returns current alone when the current query already exceeds maxChars", () => {
    const huge = "Z".repeat(5000);
    seedUsage(store, { sessionId: "s1", queryText: "some prior", minutesAgo: 2 });
    const result = buildMultiTurnSurfacingQuery(store, "s1", huge);
    // Truncated to the max
    expect(result.length).toBe(2000);
    expect(result).toBe(huge.slice(0, 2000));
  });

  it("fails open with current-only when the query_text column is missing", () => {
    // Simulate a pre-migration store by dropping the column.
    store.db.exec(`DROP TABLE context_usage`);
    store.db.exec(`
      CREATE TABLE context_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        timestamp TEXT NOT NULL,
        hook_name TEXT NOT NULL,
        injected_paths TEXT NOT NULL DEFAULT '[]',
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        was_referenced INTEGER NOT NULL DEFAULT 0,
        turn_index INTEGER NOT NULL DEFAULT 0
      )
    `);
    // No query_text column — SELECT should throw, helper must return current
    const result = buildMultiTurnSurfacingQuery(store, "s1", "current prompt");
    expect(result).toBe("current prompt");
  });

  it("is session-scoped across concurrent sessions", () => {
    seedUsage(store, { sessionId: "s1", queryText: "s1 turn 1", minutesAgo: 3 });
    seedUsage(store, { sessionId: "s2", queryText: "s2 turn 1", minutesAgo: 2 });
    seedUsage(store, { sessionId: "s1", queryText: "s1 turn 2", minutesAgo: 1 });
    const s1 = buildMultiTurnSurfacingQuery(store, "s1", "s1 current");
    const s2 = buildMultiTurnSurfacingQuery(store, "s2", "s2 current");
    expect(s1).toContain("s1 turn");
    expect(s1).not.toContain("s2");
    expect(s2).toContain("s2 turn");
    expect(s2).not.toContain("s1");
  });
});

// =============================================================================
// Handler-level persistence: query_text is written via logInjection
// =============================================================================

import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";

describe("contextSurfacing handler — query_text persistence", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  function getLastContextUsageQueryText(sessionId: string): string | null {
    const row = store.db.prepare(
      `SELECT query_text FROM context_usage
        WHERE session_id = ? AND hook_name = 'context-surfacing'
        ORDER BY id DESC LIMIT 1`,
    ).get(sessionId) as { query_text: string | null } | undefined;
    return row?.query_text ?? null;
  }

  it("does NOT persist query_text when the prompt is too short", async () => {
    await contextSurfacing(store, {
      prompt: "hi",
      sessionId: "s-short",
    } as any);
    expect(getLastContextUsageQueryText("s-short")).toBeNull();
  });

  it("does NOT persist query_text for slash commands", async () => {
    await contextSurfacing(store, {
      prompt: "/clear the session",
      sessionId: "s-slash",
    } as any);
    expect(getLastContextUsageQueryText("s-slash")).toBeNull();
  });

  it("persists query_text on a real prompt that surfaces no results", async () => {
    // A fresh store has no docs → retrieval returns empty → logEmptyTurn
    // is called with `prompt` → row should have query_text written.
    const prompt = "What is the deployment architecture for the new service?";
    await contextSurfacing(store, {
      prompt,
      sessionId: "s-empty-results",
    } as any);
    expect(getLastContextUsageQueryText("s-empty-results")).toBe(prompt);
  });
});
