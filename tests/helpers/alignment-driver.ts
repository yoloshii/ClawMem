/**
 * Subprocess driver for the t60 F59-2 alignment lock: TWO consecutive REAL
 * contextSurfacing turns against ONE file-backed store, with turn 1 forced
 * across the internal deadline by a synchronous busy-wait in the vector leg
 * (event loop blocked — the same pathological overrun as the turn-25 tests),
 * so its post-output bookkeeping HANDOFF is deadline-skipped while the FTS
 * floor still injects. The handler reads CLAWMEM_HOOK_BUDGET_MS on every call
 * (assertHookBudgetConfig); the spawner sets it in this process's environment
 * and nothing here changes it, so both turns share one budget.
 *
 * Emits one ALIGNDRIVER:: JSON line with, per turn: outcome,
 * postOutputSkipped / postOutputMs (RAW trace values — no coalescing, codex
 * F59-3), whether a bookkeeping job was parked, plus the context_usage rows
 * and the prior-lookback view turn 2 actually gets.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextSurfacing, fetchRecentPriorQueries } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { consumePendingSurfacingBookkeeping } from "../../src/hooks/surfacing-bookkeeping.ts";
import { createStore } from "../../src/store.ts";
import { seedDocuments } from "./test-store.ts";

process.env.CLAWMEM_PROFILE = process.env.CLAWMEM_TEST_PROFILE ?? "balanced";
process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
delete process.env.CLAWMEM_SESSION_FOCUS;
delete process.env.CLAWMEM_VAULTS;

const VECTOR_SYNC_DELAY_TURN1_MS = Number(process.env.CLAWMEM_TEST_VECTOR_SYNC_DELAY_TURN1_MS ?? "0");
const SESSION = "alignment-driver";
const PROMPT_1 = "billing invoice export retries enterprise";
const PROMPT_2 = "billing invoice retries dead letter queue handling";

const dir = mkdtempSync(join(tmpdir(), "clawmem-align-"));
const store = createStore(join(dir, "index.sqlite"));
seedDocuments(store, [
  { path: "m/ib1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  { path: "m/ib2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue handling", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
]);

let vecCalls = 0;
store.searchVec = async () => {
  vecCalls++;
  if (vecCalls === 1 && VECTOR_SYNC_DELAY_TURN1_MS > 0) {
    const until = Date.now() + VECTOR_SYNC_DELAY_TURN1_MS;
    while (Date.now() < until) { /* synchronous busy-wait — crosses the internal deadline */ }
  }
  return [];
};

type TurnReport = {
  outcome: string | null;
  postOutputSkipped: boolean | undefined;
  postOutputMs: number | null | undefined;
  jobParked: boolean;
  jobUsageId: number | null;
  finalPaths: string[];
};

async function runTurn(prompt: string): Promise<TurnReport> {
  const trace = newSurfacingTrace();
  await contextSurfacing(store, { prompt, sessionId: SESSION }, { trace });
  const job = consumePendingSurfacingBookkeeping();
  return {
    outcome: trace.outcome,
    postOutputSkipped: trace.timings.postOutputSkipped,
    postOutputMs: trace.timings.postOutputMs,
    jobParked: job !== null,
    jobUsageId: job?.usageId ?? null,
    finalPaths: trace.finalPaths,
  };
}

const turn1 = await runTurn(PROMPT_1);
const turn2 = await runTurn(PROMPT_2);

const rows = store.db.prepare(
  `SELECT id, turn_index, query_text, injected_paths FROM context_usage
    WHERE session_id = ? AND hook_name = 'context-surfacing' ORDER BY id`
).all(SESSION) as { id: number; turn_index: number; query_text: string | null; injected_paths: string }[];

// What turn 3 would see: the prior-context lookback for a follow-up prompt.
const priors = fetchRecentPriorQueries(store, SESSION, "a fresh follow-up question");

console.log("ALIGNDRIVER::" + JSON.stringify({
  budgetEnv: process.env.CLAWMEM_HOOK_BUDGET_MS ?? null,
  turn1,
  turn2,
  rows,
  priors,
}));
