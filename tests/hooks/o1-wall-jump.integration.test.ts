/**
 * O1 §5 — the realtime-STEP injection matrix (O1-DESIGN-monotonic-deadlines.md §5), rebuilt at
 * codex migration review r1 S4.
 *
 * Every deadline in the surfacing handler, the daemon client and the daemon itself is MONOTONIC.
 * A wall-clock step — forward or backward, in the client or in the daemon — must change NO control
 * decision and NO monotonic evidence. Each lock places its step INSIDE a control window — after a
 * deadline was constructed and before a monotonic check decides on it — in the process whose clock
 * is under test:
 *
 *   (1) CLIENT (this process; the peer is a clockless fake socket server):
 *       a. a FORWARD step after the request is sent, before its answer is parsed → still `ok`;
 *       b. a BACKWARD step before the connection opens → the TRANSMITTED budget is the true
 *          remainder, never inflated.
 *   (2) DAEMON — an independently clocked CHILD process (the production eval daemon child), its
 *       wall clock stepped at scan start (CLAWMEM_TEST_WALL_JUMP_AT_SCAN), i.e. between a
 *       request's receipt (its advisory deadline's anchor) and the check-after-scan, while the
 *       client stays unstepped:
 *       a. FORWARD +5 s → a request whose budget is still open is served, never `expired`;
 *       b. BACKWARD −5 s → a request whose budget the scan outlived is `expired`, never served.
 *   (3) HANDLER evidence: a backward step cannot convert a real monotonic overrun into an
 *       ADHERING gate record — `over_ms` stays positive and `clock_skew_ms` names the step.
 *   (4) HANDLER control: a closed work window stays closed when the wall clock says otherwise.
 *
 * Under correct code a step changes nothing, so deleting a step leaves these assertions unchanged —
 * that IS the property. Their SENSITIVITY is proven by mutation: make the control clock follow wall
 * steps — in `src/clock.ts`, have `monoNow()` add `wallJump.deltaMs` once `wallJump.at` has passed
 * (the post-O1 analogue of wall-clock deadlines) — and EVERY lock below fails (recorded with its
 * output in the O1 design doc §7; re-run it after changing this file). The stalls here spin on the
 * RAW `performance.now()`, never `monoNow()`, so that mutation cannot stretch a stall to absorb the
 * step it is meant to expose.
 */
import { stubSearchVec } from "../helpers/vec-stub.ts";
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { daemonVecMatch, vecDaemonSocketPath } from "../../src/vector-daemon.ts";
import { spawnEvalVectorDaemon } from "../../src/eval/vec-daemon-child.ts";
import { monoNow, deadlineAfter, duration, elapsed, evidenceMs, setWallJumpForTest, type MonoInstant } from "../../src/clock.ts";
import { DEADLINE_PROTOCOL } from "../../src/vector-protocol.ts";
import { createStore } from "../../src/store.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import { rawLine } from "./o1-wall-jump.helpers.ts";
import type { Store } from "../../src/store.ts";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAWMEM_PROFILE", "CLAWMEM_HOOK_BUDGET_MS", "CLAWMEM_HOOK_DEDUP_WINDOW_SEC", "CLAWMEM_SURFACE_SECONDARY_VAULTS", "CLAWMEM_VECTOR_DAEMON_REQUIRED", "CLAWMEM_SESSION_FOCUS", "CLAWMEM_VAULTS", "XDG_RUNTIME_DIR", "CLAWMEM_TEST_WALL_JUMP_AT_SCAN", "CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS"];
let runtimeDir: string | null = null;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
  delete process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED;
  delete process.env.CLAWMEM_SESSION_FOCUS;
  delete process.env.CLAWMEM_VAULTS;
  // An isolated socket dir: no watcher daemon of this vault can be found, so the handler locks'
  // primary leg takes the IN-PROCESS path (absent) — deterministic under the stalls below.
  runtimeDir = mkdtempSync(join(tmpdir(), "clawmem-o1-jump-"));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
});
afterEach(() => {
  setWallJumpForTest(null);
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  runtimeDir = null;
});

/** A synchronous stall on the RAW monotonic clock — deliberately NOT `monoNow()` (see the header). */
const busyWaitMs = (ms: number): void => { const until = performance.now() + ms; while (performance.now() < until) { /* spin */ } };

/** A CLOCKLESS fake daemon: records each request line and answers `reply(req)` after `delayMs`. */
function fakeDaemon(sockPath: string, reply: (req: Record<string, unknown>) => unknown, delayMs: number): { requests: Record<string, unknown>[]; stop: () => void } {
  mkdirSync(dirname(sockPath), { recursive: true });
  if (existsSync(sockPath)) rmSync(sockPath, { force: true });
  const requests: Record<string, unknown>[] = [];
  const srv = Bun.listen<{ buf: string }>({
    unix: sockPath,
    socket: {
      open(s) { s.data = { buf: "" }; },
      data(s, d) {
        s.data.buf += d.toString();
        const nl = s.data.buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(s.data.buf.slice(0, nl)) as Record<string, unknown>;
        requests.push(req);
        setTimeout(() => { try { s.write(JSON.stringify(reply(req)) + "\n"); s.end(); } catch { /* closed */ } }, delayMs);
      },
    },
  });
  return { requests, stop() { try { srv.stop(true); } catch { /* stopped */ } rmSync(sockPath, { force: true }); } };
}

function seededStore(): Store {
  const store = createTestStore();
  seedDocuments(store, [
    { path: "m/ib1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants config.yaml deploy.sh", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    { path: "m/ib2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
  ]);
  return store;
}

describe("O1 §5 (1): the CLIENT's monotonic control is unchanged by a wall step in the client", () => {
  it("a FORWARD +5 s step after the request is sent, before its answer is parsed: still `ok` — the pump's monotonic checks never see it", async () => {
    const dbPath = `/tmp/o1-jump-c1a-${process.pid}.sqlite`;
    const fake = fakeDaemon(vecDaemonSocketPath(dbPath), () => ({ results: [{ hash_seq: "h_0", distance: 0 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }), 150);
    try {
      const t0 = monoNow();
      setWallJumpForTest({ at: deadlineAfter(t0, duration(40)) as unknown as MonoInstant, deltaMs: +5000 });
      const oc = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, deadlineAfter(t0, duration(2000)));
      expect(fake.requests.length).toBe(1);
      expect(oc.status).toBe("ok");                       // a wall-following control clock reads 5 s past a 2 s deadline here → `deadline`
      expect(evidenceMs(elapsed(t0))).toBeLessThan(1000);
    } finally { fake.stop(); }
  });

  it("a BACKWARD −5 s step before the connection opens: the TRANSMITTED budget is the true remainder — never inflated by the step", async () => {
    const dbPath = `/tmp/o1-jump-c1b-${process.pid}.sqlite`;
    const fake = fakeDaemon(vecDaemonSocketPath(dbPath), () => ({ results: [], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }), 0);
    try {
      const t0 = monoNow();
      const deadline = deadlineAfter(t0, duration(300));
      setWallJumpForTest({ at: t0, deltaMs: -5000 }); // active from here on: every wall read is 5 s behind
      const oc = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, deadline);
      expect(oc.status).toBe("ok");
      const sent = fake.requests[0]!.remainingBudgetMs as number;
      expect(sent).toBeLessThanOrEqual(300);  // a wall-following control clock transmits ~5300 here
      expect(sent).toBeGreaterThanOrEqual(200);
    } finally { fake.stop(); }
  });
});

describe("O1 §5 (2): the DAEMON's relative expiry is unchanged by a wall step in an independently clocked CHILD daemon", () => {
  /** The production eval daemon child on a fresh working copy (no vector table: the scan returns [] after the seam's 300 ms stall — no embed server), its wall clock stepped by `deltaMs` at every scan start. */
  async function childDaemon(deltaMs: number): Promise<{ dbPath: string; stop: () => Promise<void> }> {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-o1-child-"));
    const dbPath = join(dir, "work.sqlite");
    createStore(dbPath).close();
    process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN = String(deltaMs);
    process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS = "300";
    let d: Awaited<ReturnType<typeof spawnEvalVectorDaemon>>;
    try {
      d = await spawnEvalVectorDaemon(dbPath, { prewarm: "cold", readyTimeoutMs: 30_000 });
    } finally {
      // The child took its own copy of the environment; THIS process stays unstepped.
      delete process.env.CLAWMEM_TEST_WALL_JUMP_AT_SCAN;
      delete process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS;
    }
    return { dbPath, async stop() { await d.stop(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("FORWARD +5 s inside the daemon's window: a request whose budget is still open is SERVED — never `expired`", async () => {
    const child = await childDaemon(+5000);
    try {
      const t0 = monoNow();
      const oc = await daemonVecMatch(child.dbPath, { query: "q", model: "m", limit: 5 }, deadlineAfter(t0, duration(3000)));
      expect(oc.status).toBe("ok");                        // a wall-following daemon: receipt + 3000 < (receipt + 300) + 5000 → `expired` → busy
      expect(evidenceMs(elapsed(t0))).toBeGreaterThanOrEqual(280); // the scan's stall ran (the step landed inside the window)
    } finally { await child.stop(); }
  }, 60_000);

  it("BACKWARD −5 s inside the daemon's window: a request whose budget the scan outlived is `expired` — never served", async () => {
    const child = await childDaemon(-5000);
    try {
      const verdict = JSON.parse(await rawLine(vecDaemonSocketPath(child.dbPath), JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: 100 }) + "\n", 5000));
      expect(verdict).toEqual({ error: "expired" });      // a wall-following daemon: (receipt + 300) − 5000 < receipt + 100 → served
    } finally { await child.stop(); }
  }, 60_000);
});

describe("O1 §5 (3): a BACKWARD step cannot convert a real monotonic overrun into an ADHERING gate record", () => {
  it("the primary leg overruns its 900 ms deadline by ~300 ms while the wall clock steps back 5 s: over_ms stays positive, clock_skew_ms names the step", async () => {
    process.env.CLAWMEM_PROFILE = "balanced"; // vectorTimeout 900
    process.env.CLAWMEM_HOOK_BUDGET_MS = "6000";
    const store = seededStore();
    stubSearchVec(store, async () => {
      // The synchronous scan crosses the leg deadline; the wall clock steps BACK mid-scan.
      setWallJumpForTest({ at: deadlineAfter(monoNow(), duration(100)) as unknown as MonoInstant, deltaMs: -5000 });
      busyWaitMs(1200);
      return [];
    });
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "o1-jump-3" }, { trace });
    const primary = (trace.vectorLegDeadlines ?? []).find(d => d.leg === "primary");
    expect(primary).toBeDefined();
    expect(primary!.over_ms).toBeGreaterThan(150);       // a REAL overrun — a wall-following clock reads ≈ −4700 and ADHERES
    expect(primary!.over_ms).toBeLessThan(1500);
    expect(primary!.mono_elapsed_ms).toBeGreaterThanOrEqual(1150);
    expect(primary!.clock_skew_ms).toBeLessThan(-4500);   // the step is visible from the artifact (§3)
    expect(primary!.budget_ms).toBeLessThanOrEqual(901); // allotted = min(900, work − 50) from the leg start (+ float noise)
    expect(primary!.terminal_kind).toBe("fallback");      // settled on the in-process (absent) path with no hits
    expect(primary!.status).toBe("absent");
  });
});

describe("O1 §5 (4): handler-wide work/reserve decisions are unaffected by a wall step", () => {
  it("the work window closes inside the primary leg; a BACKWARD 5 s step does NOT reopen it — the file-aware leg is still skipped and the handler still finishes inside its budget", async () => {
    process.env.CLAWMEM_PROFILE = "balanced";
    process.env.CLAWMEM_HOOK_BUDGET_MS = "1500"; // work window = 1000 ms
    const store = seededStore();
    const fileSearches: string[] = [];
    const realFts = store.searchFTS.bind(store);
    store.searchFTS = ((query: string, limit: number) => {
      if (query === "config.yaml" || query === "deploy.sh") fileSearches.push(query);
      return realFts(query, limit);
    }) as Store["searchFTS"];
    stubSearchVec(store, async () => {
      setWallJumpForTest({ at: deadlineAfter(monoNow(), duration(100)) as unknown as MonoInstant, deltaMs: -5000 });
      busyWaitMs(1300); // crosses the work deadline (1000) and the vector deadline (min(900, 950))
      return [];
    });
    const trace = newSurfacingTrace();
    const t0 = monoNow();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise config.yaml deploy.sh", sessionId: "o1-jump-4" }, { trace });
    const took = evidenceMs(elapsed(t0));
    expect(fileSearches).toEqual([]);                       // a wall-following clock reopens the window and runs both file-aware searches
    const lanes = new Set(trace.fusion?.lanes.map(l => l.lane) ?? []);
    expect(lanes.has("file-aware")).toBe(false);
    expect(lanes.has("fts-fallback")).toBe(true);          // the candidate floor still delivered
    expect(took).toBeLessThan(1300 + 700);                 // no extra work was admitted after the step
    expect(trace.timings.totalMs!).toBeGreaterThanOrEqual(1250);
  });
});
