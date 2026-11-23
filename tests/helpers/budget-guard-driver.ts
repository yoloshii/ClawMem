/**
 * Subprocess driver for the BUILD-3a budget/deadline boundary tests at the
 * REAL handler. HOOK_BUDGET_MS is baked at module import, so the budget can
 * only vary in a fresh process with CLAWMEM_HOOK_BUDGET_MS set by the
 * spawner BEFORE imports resolve. The expandQuery stub sleeps
 * CLAWMEM_TEST_EXPAND_DELAY_MS, deterministically consuming budget.
 *
 * Modes (CLAWMEM_TEST_RERANK_MODE):
 *  - "stub" (default): store.rerank replaced by a scoring stub that CAPTURES
 *    the options it receives — the spawning test asserts the production call
 *    supplies a MONOTONIC `deadline` ≈ budget − FINALIZATION_RESERVE from the
 *    driver's own monotonic start (O1; codex turn-23 finding 1: an
 *    options-blind stub let the deadline wiring regress silently).
 *  - "real-http-delay": store.rerank stays REAL; globalThis.fetch is mocked
 *    with an abort-honoring handler that sleeps CLAWMEM_TEST_RERANK_HTTP_
 *    DELAY_MS. The handler's deadline must abort the batch at the window
 *    edge (not the full delay), the disabled local fallback must not run,
 *    and the failure guard must arbitrate.
 * The spawning test parses the single BUDGETDRIVER:: line from stdout.
 */
import { stubSearchVec } from "./vec-stub.ts";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { createTestStore, seedDocuments } from "./test-store.ts";
import type { Store } from "../../src/store.ts";

process.env.CLAWMEM_PROFILE = process.env.CLAWMEM_TEST_PROFILE ?? "deep";
process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
// t61 (codex F60-1): CLAWMEM_TEST_FOCUS sets a session focus topic so the
// spawning test can prove expansion/rerank do NOT receive it as intent.
if (process.env.CLAWMEM_TEST_FOCUS) process.env.CLAWMEM_SESSION_FOCUS = process.env.CLAWMEM_TEST_FOCUS;
else delete process.env.CLAWMEM_SESSION_FOCUS;
delete process.env.CLAWMEM_VAULTS;

const EXPAND_DELAY_MS = Number(process.env.CLAWMEM_TEST_EXPAND_DELAY_MS ?? "0");
const RERANK_MODE = process.env.CLAWMEM_TEST_RERANK_MODE ?? "stub";
// "real-expand-http-delay": store.expandQuery stays REAL and the remote LLM
// fetch is mocked with an abort-honoring delayed handler — proving the
// threaded deadline aborts the transport AND the process exits inside the
// budget (codex turn-24 finding 3: an abandoned race held the process to
// the full delay; the host waits on the process).
const EXPAND_HTTP_MODE = process.env.CLAWMEM_TEST_EXPAND_HTTP_MODE === "real-expand-http-delay";
const EXPAND_HTTP_DELAY_MS = Number(process.env.CLAWMEM_TEST_EXPAND_HTTP_DELAY_MS ?? "2500");
if (EXPAND_HTTP_MODE) {
  process.env.CLAWMEM_LLM_URL = "http://llm.test:1";
  process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
}
const JUNK = "test/m/budget-junk.md";

const store = createTestStore();
seedDocuments(store, [
  { path: "m/ib1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  { path: "m/ib2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  // Expansion-only AND gate-failing — whenever the rerank lane cannot
  // usably arbitrate, the failure guard must drop it.
  { path: "m/budget-junk.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows and frost dates", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
]);
// CLAWMEM_TEST_VECTOR_SYNC_DELAY_MS: a SYNCHRONOUS busy-wait in the vector
// stub — the pathological overrun the race timer cannot interrupt (event
// loop blocked). Exercises the turn-25 F2 skip guards: the window is
// genuinely closed when the candidate legs run, so optional legs skip while
// the primary-FTS floor still produces candidates.
const VECTOR_SYNC_DELAY_MS = Number(process.env.CLAWMEM_TEST_VECTOR_SYNC_DELAY_MS ?? "0");
stubSearchVec(store, async () => {
  if (VECTOR_SYNC_DELAY_MS > 0) {
    const until = Date.now() + VECTOR_SYNC_DELAY_MS;
    while (Date.now() < until) { /* synchronous busy-wait — the race timer cannot fire */ }
  }
  return [];
});
if (EXPAND_HTTP_MODE) {
  // REAL store.expandQuery; the LLM fetch sleeps but honors the abort.
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, EXPAND_HTTP_DELAY_MS);
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "lex: gardening almanac planting\n" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
} else {
  store.expandQuery = async (_q, _model, intent) => {
    expandIntentSeen = intent === undefined ? null : intent;
    expandCalls++;
    if (EXPAND_DELAY_MS > 0) await new Promise(r => setTimeout(r, EXPAND_DELAY_MS));
    return [{ type: "lex", query: "gardening almanac planting" }] as Awaited<ReturnType<Store["expandQuery"]>>;
  };
}

let rerankCalls = 0;
let expandCalls = 0;
// t61 F60-1 capture: null = called WITHOUT intent; undefined-never-called stays "unseen".
let expandIntentSeen: string | null | "unseen" = "unseen";
let rerankIntentSeen: string | null | "unseen" = "unseen";
type RerankOptsSeen = { requireLiveCoverage?: boolean; deadline?: number };
let rerankOpts: RerankOptsSeen | null = null;
// Function-boundary read: rerankOpts is assigned only inside the store.rerank
// closure, so a direct module-tail read is control-flow-narrowed to its
// `null` initializer (chained property access becomes `never`); a call
// boundary makes TS consult the declared type instead.
const seenRerankOpts = (): RerankOptsSeen | null => rerankOpts;
// O1: the handler's deadlines are performance.now()-based, so the driver anchors on the same clock.
const t0 = performance.now();
if (RERANK_MODE === "real-http-delay") {
  // REAL store.rerank against an abort-honoring delayed HTTP mock.
  process.env.CLAWMEM_RERANK_URL = "http://rerank.test:1";
  process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  const HTTP_DELAY_MS = Number(process.env.CLAWMEM_TEST_RERANK_HTTP_DELAY_MS ?? "2500");
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    rerankCalls++;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, HTTP_DELAY_MS);
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
    });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
} else {
  store.rerank = async (_q, docs, _model, _intent, opts) => {
    rerankCalls++;
    rerankIntentSeen = _intent === undefined ? null : _intent;
    rerankOpts = (opts as RerankOptsSeen | undefined) ?? null;
    // endsWith: the transmitted id is the scheme-qualified candidateKey, not
    // the bare displayPath (a bare compare returns a CONSTANT set, which the
    // BUILD-3d degeneracy gate discards).
    return docs.map(d => ({ file: d.file, score: d.file.endsWith(JUNK) ? 0.99 : 0.5 }));
  };
}

// CLAWMEM_TEST_PRIOR_SLOW_FIRST=1 (codex turn-26): the mid-leg-crossing
// regression — TWO seeded priors, an anaphoric prompt (the prior leg
// fires), and a searchFTS wrapper that busy-waits SYNCHRONOUSLY past the
// work deadline on the FIRST prior search. The operation-level rechecks
// must stop the second prior search AND the prior-vector sub-leg.
const PRIOR_SLOW_FIRST = process.env.CLAWMEM_TEST_PRIOR_SLOW_FIRST === "1";
const PRIOR_SLOW_MS = Number(process.env.CLAWMEM_TEST_PRIOR_SLOW_MS ?? "800");
// CLAWMEM_TEST_FILEAWARE_SLOW_FIRST=1 (codex turn-27): the file-aware
// twin of the mid-leg regression — the prompt carries TWO file references,
// the FIRST file-aware FTS search busy-waits past the work deadline, and
// the per-iteration recheck must stop the second.
const FILEAWARE_SLOW_FIRST = process.env.CLAWMEM_TEST_FILEAWARE_SLOW_FIRST === "1";
const FILEAWARE_SLOW_MS = Number(process.env.CLAWMEM_TEST_FILEAWARE_SLOW_MS ?? "800");
const FILE_TOKENS = ["config.yaml", "deploy.sh"];
let priorFtsCalls = 0;
let fileAwareCalls = 0;
let vecCallsTotal = 0;
let prompt = "billing invoice export retries enterprise";
if (FILEAWARE_SLOW_FIRST) {
  prompt = "billing invoice export retries enterprise config.yaml deploy.sh";
  // The current-FTS leg ANDs every prompt token — a doc carrying the file
  // tokens too keeps the floor delivering under this prompt.
  seedDocuments(store, [
    { path: "m/ib3-config.md", title: "billing invoice deployment config", body: "billing invoice export retries enterprise config.yaml deploy.sh deployment configuration", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  ]);
  const realSearchFTS = store.searchFTS.bind(store);
  store.searchFTS = ((query: string, limit: number) => {
    if (FILE_TOKENS.includes(query)) {
      fileAwareCalls++;
      if (fileAwareCalls === 1) {
        const until = Date.now() + FILEAWARE_SLOW_MS;
        while (Date.now() < until) { /* synchronous busy-wait crossing the work deadline */ }
      }
      return [];
    }
    return realSearchFTS(query, limit);
  }) as Store["searchFTS"];
}
if (PRIOR_SLOW_FIRST) {
  process.env.CLAWMEM_PRIOR_VECTOR_INPROC = "1"; // the in-process prior-vector path — its entry recheck is under test
  prompt = "Can you explain that rationale in a bit more depth please";
  const priors = ["the billing invoice export rationale first prior", "the billing invoice retries rationale second prior"];
  for (let i = 0; i < priors.length; i++) {
    store.insertUsage({
      sessionId: "budget-guard-driver", timestamp: new Date(Date.now() - (2 + i) * 60_000).toISOString(),
      hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
      turnIndex: i, queryText: priors[i]!,
    });
  }
  const realSearchFTS = store.searchFTS.bind(store);
  store.searchFTS = ((query: string, limit: number) => {
    if (priors.includes(query)) {
      priorFtsCalls++;
      if (priorFtsCalls === 1) {
        const until = Date.now() + PRIOR_SLOW_MS;
        while (Date.now() < until) { /* synchronous busy-wait crossing the work deadline */ }
      }
      return [];
    }
    return realSearchFTS(query, limit);
  }) as Store["searchFTS"];
  const baseVec = store.searchVec;
  stubSearchVec(store, async (...args: Parameters<Store["searchVec"]>) => {
    vecCallsTotal++;
    return baseVec(...args);
  });
}

const trace = newSurfacingTrace();
await contextSurfacing(store, { prompt, sessionId: "budget-guard-driver" }, { trace });

console.log("BUDGETDRIVER::" + JSON.stringify({
  budgetEnv: process.env.CLAWMEM_HOOK_BUDGET_MS ?? null,
  lanes: trace.fusion?.lanes?.map((l: { lane: string }) => l.lane) ?? null,
  expansionAttempted: trace.expansion?.attempted ?? null,
  priorFtsCalls,
  fileAwareCalls,
  vecCallsTotal,
  priorLegEnabled: trace.priorLeg?.enabled ?? null,
  rerankCalls,
  expandCalls,
  expandIntentSeen,
  rerankIntentSeen,
  sessionTopicResolved: trace.sessionTopic,
  rerankAttempted: trace.rerank?.attempted ?? null,
  rerankFailed: trace.rerank?.failed ?? null,
  rankingKey: trace.rankingKey ?? null,
  finalPaths: trace.finalPaths,
  finalizationMsRecorded: typeof trace.timings.finalizationMs === "number",
  finalizationMs: trace.timings.finalizationMs ?? null,
  finalizationSubstages: trace.timings.finalizationSubstages ?? null,
  // t60 (codex F59-3): NO coalescing — "not measured" must stay visible as
  // undefined (JSON drops the key) instead of masquerading as null/false.
  postOutputMs: trace.timings.postOutputMs,
  postOutputSkipped: trace.timings.postOutputSkipped,
  outcome: trace.outcome,
  requireLiveCoverage: seenRerankOpts()?.requireLiveCoverage ?? null,
  deadlineDeltaMs: typeof seenRerankOpts()?.deadline === "number" ? seenRerankOpts()!.deadline! - t0 : null,
  elapsedMs: performance.now() - t0,
}));
