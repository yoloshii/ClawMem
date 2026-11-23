/**
 * Subprocess driver for the per-request degeneracy gate at the REAL handler
 * (BUILD-3d). RERANK_DEGENERACY_GATE_ACTIVE is baked into
 * surfacing-fusion.ts at module import, so the gate-off control arm can only
 * be exercised in a fresh process with CLAWMEM_RERANK_DEGENERACY_GATE set by
 * the spawner BEFORE this file's imports resolve. Same store-boundary stub
 * surface as w0-guard-driver.ts; the spawning test parses the single
 * DGDRIVER:: line from stdout.
 *
 * Scenario: full reranker coverage with a CONSTANT score set (spread 0 —
 * the inert regime) over a pool carrying an expansion-only, gate-FAILING
 * candidate.
 *  - default (gate on): the assessment fires and the ACTION discards the
 *    lane -> orderingApplied false, rankingKey "rrf", dropUnarbitrated runs
 *    -> the junk is dropped. Regressing the discard (apply ordering despite
 *    a degenerate verdict) injects it and flips orderingApplied.
 *  - CLAWMEM_RERANK_DEGENERACY_GATE=off (control): the SAME scores are
 *    assessed (shadow — gated:false, degenerate:true still recorded) but
 *    the action is disarmed -> arbitration present -> the junk IS injected.
 *    The toggle is the only difference between the arms.
 */
import { stubSearchVec } from "./vec-stub.ts";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { createTestStore, seedDocuments } from "./test-store.ts";
import type { Store } from "../../src/store.ts";

process.env.CLAWMEM_PROFILE = "deep";
process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
delete process.env.CLAWMEM_SESSION_FOCUS;
delete process.env.CLAWMEM_VAULTS;

const JUNK = "test/m/dg-junk.md";

const store = createTestStore();
seedDocuments(store, [
  { path: "m/ib1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  { path: "m/ib2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  // Expansion-only AND gate-failing: shares NO vocabulary with the prompt,
  // reachable only through the expansion lane below.
  { path: "m/dg-junk.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows and frost dates", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
]);
stubSearchVec(store, async () => []);
store.expandQuery = async () => [{ type: "lex", query: "gardening almanac planting" }] as Awaited<ReturnType<Store["expandQuery"]>>;
// Full coverage, CONSTANT scores: the inert regime — every doc 0.5, spread 0.
store.rerank = async (_q, docs) => docs.map(d => ({ file: d.file, score: 0.5 }));

const trace = newSurfacingTrace();
await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "degeneracy-gate-driver" }, { trace });

console.log("DGDRIVER::" + JSON.stringify({
  gateEnv: process.env.CLAWMEM_RERANK_DEGENERACY_GATE ?? null,
  rerank: trace.rerank ? {
    attempted: trace.rerank.attempted,
    failed: trace.rerank.failed,
    coverageComplete: trace.rerank.coverageComplete,
    orderingApplied: trace.rerank.orderingApplied,
    degeneracy: trace.rerank.degeneracy ?? null,
  } : null,
  rankingKey: trace.rankingKey ?? null,
  finalPaths: trace.finalPaths,
  // BUILD-4 (codex t52-F4 re-pin): the guard-vs-arbitration contrast now
  // lives at the ADMISSION boundary — a guard-dropped doc never reaches
  // admission; an arbitrated one reaches it and is band-rejected there.
  admissionEntries: trace.admission ? [...trace.admission.admitted, ...trace.admission.rejected].map(e => e.displayPath) : null,
  admissionJunk: (() => {
    const j = trace.admission?.rejected.find(e => e.displayPath === "test/m/dg-junk.md");
    return j ? { reason: (j as { reason?: string }).reason ?? null, band: (j as { band?: number }).band ?? null } : null;
  })(),
}));
