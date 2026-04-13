/**
 * Hook-level integration tests for §11.4 — Session-scoped topic boost.
 *
 * Per Codex §11.4 code review Turn 1 (2026-04-13): pure-helper tests
 * missed the zero-matching-docs fail-open regression. These integration
 * tests drive the real `contextSurfacing(store, input)` handler end to
 * end and lock in the two guarantees Codex called out:
 *
 *   1. No topic vs a non-matching topic → byte-identical output
 *      (fail-open contract: "topic set + zero matching docs → proceed
 *      with the normal results")
 *
 *   2. A matching topic CHANGES the output compared to the no-topic
 *      baseline on the same seeded store, so we can prove the boost
 *      actually has an effect at the hook level and is not just a
 *      unit-test-only behavior (below-threshold rescue at minimum).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { createTestStore } from "../helpers/test-store.ts";
import {
  insertContent,
  insertDocument,
  type Store,
} from "../../src/store.ts";

// =============================================================================
// Hermetic env setup
// =============================================================================
//
// Each test gets a fresh tmp dir for the focus file root (so no leak
// from other tests on the same host), dedupe is disabled so repeated
// prompts actually re-invoke the full hook, the memory nudge is disabled
// so outputs are deterministic, and any pre-existing CLAWMEM_SESSION_FOCUS
// env var is cleared to avoid masking the topic-via-file behavior.
// =============================================================================

let TMP_ROOT: string;
let ORIG_FOCUS_ROOT: string | undefined;
let ORIG_SESSION_FOCUS: string | undefined;
let ORIG_DEDUP_WINDOW: string | undefined;
let ORIG_NUDGE: string | undefined;

beforeEach(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "clawmem-topic-boost-intg-"));
  ORIG_FOCUS_ROOT = process.env.CLAWMEM_FOCUS_ROOT;
  process.env.CLAWMEM_FOCUS_ROOT = TMP_ROOT;
  ORIG_SESSION_FOCUS = process.env.CLAWMEM_SESSION_FOCUS;
  delete process.env.CLAWMEM_SESSION_FOCUS;
  ORIG_DEDUP_WINDOW = process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
  process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  ORIG_NUDGE = process.env.CLAWMEM_NUDGE_INTERVAL;
  process.env.CLAWMEM_NUDGE_INTERVAL = "0";
});

afterEach(() => {
  if (ORIG_FOCUS_ROOT === undefined) delete process.env.CLAWMEM_FOCUS_ROOT;
  else process.env.CLAWMEM_FOCUS_ROOT = ORIG_FOCUS_ROOT;
  if (ORIG_SESSION_FOCUS === undefined) delete process.env.CLAWMEM_SESSION_FOCUS;
  else process.env.CLAWMEM_SESSION_FOCUS = ORIG_SESSION_FOCUS;
  if (ORIG_DEDUP_WINDOW === undefined) delete process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
  else process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = ORIG_DEDUP_WINDOW;
  if (ORIG_NUDGE === undefined) delete process.env.CLAWMEM_NUDGE_INTERVAL;
  else process.env.CLAWMEM_NUDGE_INTERVAL = ORIG_NUDGE;
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// =============================================================================
// Seed helper
// =============================================================================

function seedDoc(
  store: Store,
  path: string,
  title: string,
  body: string,
  opts: { confidence?: number; qualityScore?: number; contentType?: string } = {},
): void {
  const now = new Date().toISOString();
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  insertContent(store.db, hash, body, now);
  insertDocument(store.db, "test", path, title, hash, now, now);
  const row = store.db
    .prepare(
      `SELECT id FROM documents WHERE collection = 'test' AND path = ? AND active = 1`,
    )
    .get(path) as { id: number };
  const conf = opts.confidence ?? 0.9;
  const qs = opts.qualityScore ?? 0.8;
  const ct = opts.contentType ?? "decision";
  store.db
    .prepare(
      `UPDATE documents SET content_type = ?, confidence = ?, quality_score = ? WHERE id = ?`,
    )
    .run(ct, conf, qs, row.id);
}

function additionalContext(output: unknown): string {
  // HookOutput → hookSpecificOutput.additionalContext
  return (
    (output as { hookSpecificOutput?: { additionalContext?: string } })
      ?.hookSpecificOutput?.additionalContext ?? ""
  );
}

// =============================================================================
// Tests
// =============================================================================

describe("§11.4 topic boost — hook-level integration", () => {
  it("zero-match fail-open: non-matching topic produces byte-identical output to no topic", async () => {
    const store = createTestStore();
    // Seed three docs with keyword-dense bodies so FTS matches the
    // short keyword prompt below. Topic "nonexistent-topic-foobar-xyz"
    // must not appear in any title, path, or body — guaranteeing zero
    // matches at the boost stage.
    seedDoc(store, "auth.md", "Authentication", "authentication pipeline design and login flow");
    seedDoc(store, "db.md", "Database schema", "primary database structure and tables");
    seedDoc(store, "refunds.md", "Payment refunds", "refund payment backend logic");

    // Short, keyword-dense prompt so FTS5 query builder returns hits
    // reliably from the in-memory test store (long natural-language
    // prompts can produce empty FTS results on small seeded stores).
    const prompt = "authentication pipeline design";

    // Call 1: no topic
    const outNoTopic = await contextSurfacing(store, {
      prompt,
      sessionId: "sess-no-topic",
    } as any);

    // Call 2: non-matching topic via env var (debug override path)
    process.env.CLAWMEM_SESSION_FOCUS = "nonexistent-topic-foobar-xyz";
    const outNonMatch = await contextSurfacing(store, {
      prompt,
      sessionId: "sess-nonmatch-topic",
    } as any);
    delete process.env.CLAWMEM_SESSION_FOCUS;

    const ctxNoTopic = additionalContext(outNoTopic);
    const ctxNonMatch = additionalContext(outNonMatch);

    // Baseline sanity: the hook actually produced some context.
    expect(ctxNoTopic.length).toBeGreaterThan(0);
    // CRITICAL: non-matching topic must NOT change ranking / filtering.
    // This is the fail-open contract Codex locked in on §11.4 Turn 1.
    expect(ctxNonMatch).toBe(ctxNoTopic);
  });

  it("zero-match fail-open: surfaced doc set is preserved when the non-matching topic would otherwise uniformly demote", async () => {
    const store = createTestStore();
    // Seed multiple docs whose bodies contain the FTS query tokens so
    // FTS returns a multi-result set. Prompt is ≥ 20 chars (the hook's
    // MIN_PROMPT_LENGTH) and short enough to be FTS-friendly.
    seedDoc(store, "auth.md", "Authentication pipeline", "authentication pipeline design primary flow");
    seedDoc(store, "build.md", "Build pipeline", "build process pipeline design primary steps");
    seedDoc(store, "data.md", "Data pipeline", "data pipeline design primary etl");

    const prompt = "pipeline design primary";

    const outNoTopic = await contextSurfacing(store, { prompt, sessionId: "s1" } as any);

    // Topic has literally nothing in common with ANY seeded doc
    process.env.CLAWMEM_SESSION_FOCUS = "zzz-alien-topic-qqq";
    const outNonMatch = await contextSurfacing(store, { prompt, sessionId: "s2" } as any);
    delete process.env.CLAWMEM_SESSION_FOCUS;

    const ctxA = additionalContext(outNoTopic);
    const ctxB = additionalContext(outNonMatch);

    expect(ctxA.length).toBeGreaterThan(0);
    // Byte-equality — the strongest form of "preserved surfaced set"
    expect(ctxB).toBe(ctxA);
  });

  it("matching topic CHANGES the output compared to the no-topic baseline on the same seeded store", async () => {
    const store = createTestStore();
    // Seed multiple docs that all share the query tokens so they ALL
    // surface via FTS. The topic "authentication" matches auth.md only
    // (via its title + body); the other two do not. With a topic set,
    // the boost re-weights auth.md higher and demotes the other two,
    // shifting the serialized string relative to the no-topic baseline.
    seedDoc(store, "auth.md", "Authentication pipeline", "authentication pipeline design primary login tokens");
    seedDoc(store, "build.md", "Build pipeline", "build process pipeline design primary ci runner");
    seedDoc(store, "data.md", "Data pipeline", "data pipeline design primary etl steps");

    const prompt = "pipeline design primary";

    const outNoTopic = await contextSurfacing(store, { prompt, sessionId: "s-no" } as any);

    // Set a topic that matches auth.md directly via title + body.
    process.env.CLAWMEM_SESSION_FOCUS = "authentication";
    const outWithTopic = await contextSurfacing(store, { prompt, sessionId: "s-with" } as any);
    delete process.env.CLAWMEM_SESSION_FOCUS;

    const ctxNoTopic = additionalContext(outNoTopic);
    const ctxWithTopic = additionalContext(outWithTopic);

    // Both calls must produce context. They should NOT be byte-identical,
    // proving the topic boost has an observable effect at the hook level.
    expect(ctxNoTopic.length).toBeGreaterThan(0);
    expect(ctxWithTopic.length).toBeGreaterThan(0);
    expect(ctxWithTopic).not.toBe(ctxNoTopic);
  });
});
