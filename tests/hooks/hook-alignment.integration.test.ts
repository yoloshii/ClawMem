/**
 * BUILD-5 t60 — real-handler locks for codex F59-2 and F59-3.
 *
 * F59-2 (alignment survives a deadline-skip): two consecutive REAL handler
 * turns against ONE store, turn 1 forced across the internal deadline by a
 * synchronous vector-leg busy-wait (subprocess: the spawner sets
 * CLAWMEM_HOOK_BUDGET_MS, which the handler reads on every call, so both
 * turns share one budget). The deadline-skip must lose ONLY the
 * injected-paths/tokens fill-in — never the turn alignment or the prompt
 * history:
 *   - distinct turn indices (0, 1) on the context_usage rows;
 *   - turn 1's prompt available to the prior-context lookback afterwards;
 *   - turn 1's row carries query_text with EMPTY injected_paths (the split).
 *
 * F59-3 (instrumentation is profile-independent and never coalesced): the
 * driver emits trace.timings.postOutputMs / postOutputSkipped RAW. Balanced
 * (non-deep) injected runs must record postOutputMs even though the deep
 * finalization clock never runs; the deadline-skip run must report
 * postOutputSkipped === true with no ?? masking anywhere in the chain.
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";

const DRIVER = join(import.meta.dir, "../helpers/alignment-driver.ts");
const BUDGET_DRIVER = join(import.meta.dir, "../helpers/budget-guard-driver.ts");

type TurnReport = {
  outcome: string | null;
  postOutputSkipped: boolean | undefined;
  postOutputMs: number | null | undefined;
  jobParked: boolean;
  jobUsageId: number | null;
  finalPaths: string[];
};

function runAlignmentDriver(opts: { budget?: string; vectorSyncDelayTurn1Ms?: number; profile?: string }) {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAWMEM_HOOK_BUDGET_MS;
  delete env.CLAWMEM_TEST_VECTOR_SYNC_DELAY_TURN1_MS;
  delete env.CLAWMEM_TEST_PROFILE;
  delete env.CLAWMEM_SESSION_FOCUS;
  delete env.CLAWMEM_VAULTS;
  if (opts.budget) env.CLAWMEM_HOOK_BUDGET_MS = opts.budget;
  if (opts.vectorSyncDelayTurn1Ms !== undefined) env.CLAWMEM_TEST_VECTOR_SYNC_DELAY_TURN1_MS = String(opts.vectorSyncDelayTurn1Ms);
  if (opts.profile) env.CLAWMEM_TEST_PROFILE = opts.profile;
  const proc = Bun.spawnSync([process.execPath, DRIVER], { env, cwd: join(import.meta.dir, "../..") });
  const out = proc.stdout.toString();
  const line = out.split("\n").reverse().find(l => l.startsWith("ALIGNDRIVER::"));
  if (!line) throw new Error(`alignment driver produced no ALIGNDRIVER line (exit ${proc.exitCode}):\n${out}\n${proc.stderr.toString()}`);
  return JSON.parse(line.slice("ALIGNDRIVER::".length)) as {
    budgetEnv: string | null;
    turn1: TurnReport;
    turn2: TurnReport;
    rows: { id: number; turn_index: number; query_text: string | null; injected_paths: string }[];
    priors: string[];
  };
}

describe("t60 F59-2: turn alignment + prompt history survive a deadline-skip (real handler, subprocess)", () => {
  it("two consecutive turns across a deadline-skip: distinct turn indices, turn 1's prompt reaches prior lookback, only the paths fill-in is lost", () => {
    // Budget 3000; turn 1's vector leg busy-waits 3400ms synchronously — the
    // handler is past internalDeadlineAt when the post-output boundary is
    // reached, so the bookkeeping handoff is SKIPPED. The FTS floor still
    // injects (turn-25 contract). Turn 2 runs under the same budget and must
    // NOT skip: it takes ~20ms alone and ~100ms sharing one core four ways,
    // but a loaded full-suite run once stalled it past the former 1000ms
    // budget, so the budget leaves turn 2 that much more room.
    const r = runAlignmentDriver({ budget: "3000", vectorSyncDelayTurn1Ms: 3400 });

    // Turn 1: injected, but the bookkeeping handoff was deadline-skipped.
    expect(r.turn1.outcome).toBe("injected");
    expect(r.turn1.postOutputSkipped).toBe(true);
    expect(r.turn1.jobParked).toBe(false);

    // Turn 2: normal — handoff parked, not skipped. RAW values (F59-3).
    expect(r.turn2.outcome).toBe("injected");
    expect(r.turn2.postOutputSkipped).toBe(false);
    expect(r.turn2.jobParked).toBe(true);
    expect(typeof r.turn2.postOutputMs).toBe("number");
    expect(r.turn2.jobUsageId).toBe(r.rows[1]!.id); // job links to turn 2's alignment row

    // THE ALIGNMENT LOCK: one row per turn, distinct turn indices, both
    // prompts persisted at retrieval commit — including the skipped turn's.
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]!.turn_index).toBe(0);
    expect(r.rows[1]!.turn_index).toBe(1);
    expect(r.rows[0]!.query_text).toBe("billing invoice export retries enterprise");
    expect(r.rows[1]!.query_text).toBe("billing invoice retries dead letter queue handling");

    // The split: the deadline-skip lost ONLY the injected-paths fill-in.
    expect(JSON.parse(r.rows[0]!.injected_paths)).toEqual([]);
    expect(r.turn1.finalPaths.length).toBeGreaterThan(0); // ...though the turn DID inject

    // Turn 1's prompt is available to a later turn's prior-context lookback.
    expect(r.priors).toContain("billing invoice export retries enterprise");
    expect(r.priors).toContain("billing invoice retries dead letter queue handling");
  }, 40_000);

  it("control: with no forced overrun, neither turn skips and both park a bookkeeping job", () => {
    const r = runAlignmentDriver({});
    expect(r.turn1.outcome).toBe("injected");
    expect(r.turn1.postOutputSkipped).toBe(false);
    expect(r.turn1.jobParked).toBe(true);
    expect(typeof r.turn1.postOutputMs).toBe("number");
    expect(r.turn2.postOutputSkipped).toBe(false);
    expect(r.turn2.jobParked).toBe(true);
    expect(r.rows.map(x => x.turn_index)).toEqual([0, 1]);
  }, 40_000);
});

function runBudget(opts?: { profile?: string; focus?: string }) {
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAWMEM_HOOK_BUDGET_MS;
    delete env.CLAWMEM_SESSION_FOCUS;
    delete env.CLAWMEM_VAULTS;
    delete env.CLAWMEM_TEST_RERANK_MODE;
    delete env.CLAWMEM_TEST_EXPAND_HTTP_MODE;
    delete env.CLAWMEM_TEST_FOCUS;
    if (opts?.profile) env.CLAWMEM_TEST_PROFILE = opts.profile; else delete env.CLAWMEM_TEST_PROFILE;
    if (opts?.focus) env.CLAWMEM_TEST_FOCUS = opts.focus;
    env.CLAWMEM_TEST_EXPAND_DELAY_MS = "0";
    const proc = Bun.spawnSync([process.execPath, BUDGET_DRIVER], { env, cwd: join(import.meta.dir, "../..") });
    const out = proc.stdout.toString();
    const line = out.split("\n").reverse().find(l => l.startsWith("BUDGETDRIVER::"));
    if (!line) throw new Error(`driver produced no BUDGETDRIVER line (exit ${proc.exitCode}):\n${out}\n${proc.stderr.toString()}`);
    return JSON.parse(line.slice("BUDGETDRIVER::".length)) as Record<string, unknown>;
}

describe("t60 F59-3: postOutput instrumentation is profile-independent (real handler, subprocess)", () => {
  it("a balanced injected run records postOutputMs even though the deep finalization clock never runs", () => {
    const r = runBudget({ profile: "balanced" });
    expect(r.outcome).toBe("injected");
    // No deep escalation on balanced — the deep-only clock is genuinely absent...
    expect(r.finalizationMsRecorded).toBe(false);
    // ...but the payload boundary is still measured (pre-t60 this was
    // undefined: the assignment lived inside the escalationEndAt branch).
    expect(typeof r.postOutputMs).toBe("number");
    expect(r.postOutputMs as number).toBeGreaterThanOrEqual(0);
    // RAW false from the initialized trace — the driver no longer coalesces,
    // so an uninitialized field would surface as undefined here and fail.
    expect(r.postOutputSkipped).toBe(false);
  }, 40_000);
});

describe("t61 F60-1: a session focus topic never reaches expansion or rerank intent (real deep handler, subprocess)", () => {
  it("with a focus set, expansion and rerank both run WITHOUT intent while the topic itself resolves", () => {
    // Deep profile, default budget: the escalation window is open, so BOTH
    // intent-capable stages run against intent-sensitive stubs. Pre-t61 the
    // resolved focus was threaded as `intent` into store.expandQuery and
    // store.rerank — either capture reading "billing enterprise" turns this
    // red (the mutation proof re-adds sessionTopic at one call site).
    const r = runBudget({ focus: "billing enterprise" });
    expect(r.sessionTopicResolved).toBe("billing enterprise"); // the topic DID resolve (presentation intent survives)
    expect(r.expandCalls as number).toBeGreaterThanOrEqual(1);
    expect(r.expandIntentSeen).toBeNull();  // called WITHOUT intent ("unseen" = never called would also fail)
    expect(r.rerankCalls as number).toBeGreaterThanOrEqual(1);
    expect(r.rerankIntentSeen).toBeNull();
    expect(r.outcome).toBe("injected");
  }, 40_000);
});
