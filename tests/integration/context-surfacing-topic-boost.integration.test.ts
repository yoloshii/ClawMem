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
 *   2. (Amended BUILD-5, 2026-08-25) The boost MACHINERY IS REMOVED: since
 *      BUILD-2 the final order is the channel-aware fusion key and since
 *      BUILD-4 admission is judged on that same key, so the stage's only
 *      residual effect was tier depth via the composite multiplier — a
 *      metadata signal crossing presentation, deleted by C5. A matching
 *      topic now changes NOTHING: trace.topicBoost stays null and the
 *      output is byte-identical; sessionTopic itself survives as the
 *      snippet-selection intent (presentation, not ordering).
 *
 * METHODOLOGY — each comparison uses TWO separate, identically-seeded
 * stores (one per call), NOT one store reused across both calls. This is
 * load-bearing: `contextSurfacing` still mutates persistent per-turn
 * state on every invocation (the retrieval-commit context_usage alignment
 * row, t60 F59-2; plus dedupe/seen-prompt records), and turn state feeds
 * later calls (the prior-context leg reads earlier turns' query_text).
 * (Injection-time co-activation and spreading activation were DELETED at
 * BUILD-5, and recall-event bookkeeping now lands via the off-process
 * drainer — but the alignment write alone still makes call-ordinal a
 * confound.) So two calls against the SAME store are not guaranteed
 * byte-comparable regardless of the topic. Two fresh identically-seeded
 * stores isolate the topic as the ONLY difference between the two runs,
 * so byte-equality (or inequality) is attributable to the topic alone.
 *
 * The suite is also fully hermetic: the skill-vault dual-query
 * (`resolveStore("skill")` in the hook) is disabled by pointing
 * CLAWMEM_CONFIG_DIR at an empty tmp dir (no config.yaml → no configured
 * vaults) so the test never reads the operator's real skill vault. A
 * non-hermetic version silently depended on real vault content landing on
 * a token-budget truncation boundary, which is exactly how the latent
 * recall-feedback non-idempotency surfaced as a spurious byte-inequality.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { createTestStore } from "../helpers/test-store.ts";
import {
  insertDocument,
  type Store,
} from "../../src/store.ts";
import { clearConfigCache } from "../../src/config.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";

import { seedContent } from "../helpers/seed-content.ts";
// =============================================================================
// Hermetic env setup
// =============================================================================
//
// Each test gets a fresh tmp dir used as BOTH the focus-file root and the
// config dir. Pointing CLAWMEM_CONFIG_DIR at an empty dir (no config.yaml)
// makes getVaultPath("skill") return undefined, so the hook skips the
// skill-vault dual-query entirely — the suite reads only its own seeded
// in-memory stores. Dedupe is disabled so repeated prompts actually
// re-invoke the full hook, the memory nudge is disabled so outputs are
// deterministic, and any pre-existing CLAWMEM_SESSION_FOCUS / CLAWMEM_VAULTS
// env vars are cleared to avoid masking the topic-via-file behavior or
// re-introducing a configured vault.
// =============================================================================

let TMP_ROOT: string;
let ORIG_FOCUS_ROOT: string | undefined;
let ORIG_CONFIG_DIR: string | undefined;
let ORIG_VAULTS: string | undefined;
let ORIG_SESSION_FOCUS: string | undefined;
let ORIG_DEDUP_WINDOW: string | undefined;
let ORIG_NUDGE: string | undefined;

beforeEach(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "clawmem-topic-boost-intg-"));
  ORIG_FOCUS_ROOT = process.env.CLAWMEM_FOCUS_ROOT;
  process.env.CLAWMEM_FOCUS_ROOT = TMP_ROOT;
  // Hermetic: empty config dir → no configured vaults → skill dual-query off.
  ORIG_CONFIG_DIR = process.env.CLAWMEM_CONFIG_DIR;
  process.env.CLAWMEM_CONFIG_DIR = TMP_ROOT;
  ORIG_VAULTS = process.env.CLAWMEM_VAULTS;
  delete process.env.CLAWMEM_VAULTS;
  clearConfigCache();
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
  if (ORIG_CONFIG_DIR === undefined) delete process.env.CLAWMEM_CONFIG_DIR;
  else process.env.CLAWMEM_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_VAULTS === undefined) delete process.env.CLAWMEM_VAULTS;
  else process.env.CLAWMEM_VAULTS = ORIG_VAULTS;
  clearConfigCache();
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
//
// Fixed timestamp so two separately-seeded stores are byte-for-byte
// identical in every score-affecting field (recency is derived from
// modified_at; a per-call `new Date()` would give the two stores
// infinitesimally different ages).
// =============================================================================

const SEED_TS = "2026-01-01T00:00:00.000Z";

function seedDoc(
  store: Store,
  path: string,
  title: string,
  body: string,
  opts: { confidence?: number; qualityScore?: number; contentType?: string } = {},
): void {
  const hash = `hash_${path}`;
  seedContent(store.db, hash, body, SEED_TS);
  insertDocument(store.db, "test", path, title, hash, SEED_TS, SEED_TS);
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
    // Seed helper applied identically to two fresh stores so the topic is
    // the ONLY difference between the two runs (see METHODOLOGY note above).
    const seed = (store: Store) => {
      seedDoc(store, "auth.md", "Authentication", "authentication pipeline design and login flow");
      seedDoc(store, "db.md", "Database schema", "primary database structure and tables");
      seedDoc(store, "refunds.md", "Payment refunds", "refund payment backend logic");
    };
    const storeNoTopic = createTestStore();
    const storeNonMatch = createTestStore();
    seed(storeNoTopic);
    seed(storeNonMatch);

    // Short, keyword-dense prompt so FTS5 query builder returns hits
    // reliably from the in-memory test store (long natural-language
    // prompts can produce empty FTS results on small seeded stores).
    const prompt = "authentication pipeline design";

    // Call 1: no topic (fresh store)
    const outNoTopic = await contextSurfacing(storeNoTopic, {
      prompt,
      sessionId: "sess-no-topic",
    } as any);

    // Call 2: non-matching topic via env var (debug override path), fresh store
    process.env.CLAWMEM_SESSION_FOCUS = "nonexistent-topic-foobar-xyz";
    const outNonMatch = await contextSurfacing(storeNonMatch, {
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
    // Multiple docs whose bodies contain the FTS query tokens so FTS
    // returns a multi-result set exercising the full threshold +
    // diversification pass. Seeded identically into two fresh stores.
    const seed = (store: Store) => {
      seedDoc(store, "auth.md", "Authentication pipeline", "authentication pipeline design primary flow");
      seedDoc(store, "build.md", "Build pipeline", "build process pipeline design primary steps");
      seedDoc(store, "data.md", "Data pipeline", "data pipeline design primary etl");
    };
    const storeNoTopic = createTestStore();
    const storeNonMatch = createTestStore();
    seed(storeNoTopic);
    seed(storeNonMatch);

    const prompt = "pipeline design primary";

    const outNoTopic = await contextSurfacing(storeNoTopic, { prompt, sessionId: "s1" } as any);

    // Topic has literally nothing in common with ANY seeded doc
    process.env.CLAWMEM_SESSION_FOCUS = "zzz-alien-topic-qqq";
    const outNonMatch = await contextSurfacing(storeNonMatch, { prompt, sessionId: "s2" } as any);
    delete process.env.CLAWMEM_SESSION_FOCUS;

    const ctxA = additionalContext(outNoTopic);
    const ctxB = additionalContext(outNonMatch);

    expect(ctxA.length).toBeGreaterThan(0);
    // Byte-equality — the strongest form of "preserved surfaced set"
    expect(ctxB).toBe(ctxA);
  });

  it("matching topic: the boost machinery is GONE (BUILD-5) — trace.topicBoost stays null, sessionTopic is still resolved, output is byte-identical", async () => {
    // Pre-BUILD-4 this test asserted the boost CHANGES the output bytes;
    // post-BUILD-4 it asserted the boost runs traced but order-inert. Both
    // premises are now removed BY DESIGN: BUILD-5 (C5) deleted the stage
    // outright — its last residual (tier depth via the composite
    // multiplier) was a metadata signal crossing presentation. What must
    // hold NOW: the topic is RESOLVED (trace.sessionTopic — it still feeds
    // snippet-selection intent), no boost record exists, and the output is
    // byte-identical to the no-topic run.
    //
    // Two fresh identically-seeded stores make the topic the ONLY
    // difference: a false positive from the recall-feedback
    // non-idempotency (which would make ANY second call differ, even
    // with no topic) cannot masquerade as a real boost effect here.
    const seed = (store: Store) => {
      seedDoc(store, "auth.md", "Authentication pipeline", "authentication pipeline design primary login tokens");
      seedDoc(store, "build.md", "Build pipeline", "build process pipeline design primary ci runner");
      seedDoc(store, "data.md", "Data pipeline", "data pipeline design primary etl steps");
    };
    const storeNoTopic = createTestStore();
    const storeWithTopic = createTestStore();
    seed(storeNoTopic);
    seed(storeWithTopic);

    const prompt = "pipeline design primary";

    const traceNo = newSurfacingTrace();
    const outNoTopic = await contextSurfacing(storeNoTopic, { prompt, sessionId: "s-no" } as any, { trace: traceNo });

    // Set a topic that matches auth.md directly via title + body.
    process.env.CLAWMEM_SESSION_FOCUS = "authentication";
    const traceWith = newSurfacingTrace();
    const outWithTopic = await contextSurfacing(storeWithTopic, { prompt, sessionId: "s-with" } as any, { trace: traceWith });
    delete process.env.CLAWMEM_SESSION_FOCUS;

    const ctxNoTopic = additionalContext(outNoTopic);
    const ctxWithTopic = additionalContext(outWithTopic);
    expect(ctxNoTopic.length).toBeGreaterThan(0);
    expect(ctxWithTopic.length).toBeGreaterThan(0);

    // BUILD-5: the machinery is deleted — no boost record on EITHER run...
    expect(traceNo.topicBoost).toBeNull();
    expect(traceWith.topicBoost).toBeNull();
    // ...while the topic itself was still resolved (presentation intent)...
    expect(traceWith.sessionTopic).toBe("authentication");
    // ...and the output is fully unchanged: identical set, order, and bytes.
    expect(traceWith.finalPaths).toEqual(traceNo.finalPaths);
    expect(ctxWithTopic).toBe(ctxNoTopic);
  });
});
