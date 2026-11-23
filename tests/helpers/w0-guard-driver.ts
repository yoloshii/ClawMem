/**
 * Subprocess driver for the zero-weight failure-guard regression test at the
 * REAL handler (codex turn-19 finding 3). RERANK_LANE_WEIGHT is baked into
 * surfacing-fusion.ts at module import, so the w=0 handler path can only be
 * exercised in a fresh process with CLAWMEM_RERANK_LANE_WEIGHT set by the
 * spawner BEFORE this file's imports resolve. Same store-boundary stub
 * surface as hook-lanes.integration.test.ts; the spawning test parses the
 * single W0DRIVER:: line from stdout.
 *
 * Scenario: full reranker coverage over the pool + an expansion-only,
 * gate-FAILING candidate (shares no vocabulary with the prompt).
 *  - weight 0 (lane inert): usable arbitration is absent -> dropUnarbitrated
 *    must run -> the junk is dropped. Regressing the guard to the old
 *    coverage-arbitrates form (skip on rerankBlended alone) injects it.
 *  - default weight (control): usable arbitration present -> guard skipped
 *    -> the junk IS injected (banded last) — proving the pool genuinely
 *    carries it to the guard, so its absence at w=0 is the guard's doing.
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

const JUNK = "test/m/w0-junk.md";

const store = createTestStore();
seedDocuments(store, [
  { path: "m/ib1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  { path: "m/ib2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  // Expansion-only AND gate-failing: shares NO vocabulary with the prompt,
  // reachable only through the expansion lane below.
  { path: "m/w0-junk.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows and frost dates", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
]);
stubSearchVec(store, async () => []);
store.expandQuery = async () => [{ type: "lex", query: "gardening almanac planting" }] as Awaited<ReturnType<Store["expandQuery"]>>;
// Full coverage: the reranker ANSWERS for every doc it is sent, top-ranking
// the junk — coverage is complete whatever the lane weight. endsWith: the
// transmitted id is the scheme-qualified candidateKey, not the bare
// displayPath (a bare compare returns a CONSTANT set, which the BUILD-3d
// degeneracy gate discards).
store.rerank = async (_q, docs) => docs.map(d => ({ file: d.file, score: d.file.endsWith(JUNK) ? 0.99 : 0.5 }));

const trace = newSurfacingTrace();
await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "w0-guard-driver" }, { trace });

console.log("W0DRIVER::" + JSON.stringify({
  weightEnv: process.env.CLAWMEM_RERANK_LANE_WEIGHT ?? null,
  rerank: trace.rerank ? {
    attempted: trace.rerank.attempted,
    failed: trace.rerank.failed,
    coverageComplete: trace.rerank.coverageComplete,
    orderingApplied: trace.rerank.orderingApplied,
  } : null,
  rankingKey: trace.rankingKey ?? null,
  finalPaths: trace.finalPaths,
  // BUILD-4 (codex t52-F4 re-pin): the guard-vs-arbitration contrast now
  // lives at the ADMISSION boundary — a guard-dropped doc never reaches
  // admission; an arbitrated one reaches it and is band-rejected there.
  admissionEntries: trace.admission ? [...trace.admission.admitted, ...trace.admission.rejected].map(e => e.displayPath) : null,
  admissionJunk: (() => {
    const j = trace.admission?.rejected.find(e => e.displayPath === JUNK);
    return j ? { reason: (j as { reason?: string }).reason ?? null, band: (j as { band?: number }).band ?? null } : null;
  })(),
}));
