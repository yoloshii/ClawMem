/**
 * Integration tests for v0.8.2 cmdWatch worker hosting (Ext 2 + Ext 3).
 *
 * Codex review of the v0.8.2 design called this lifecycle wiring out as the
 * one place isolated unit + worker integration tests cannot fully protect:
 * the unit tests cover `runConsolidationTick` / `runHeavyMaintenanceTick` in
 * isolation, but they do not exercise the `cmdWatch` startup path that wires
 * `startConsolidationWorker` + `startHeavyMaintenanceWorker` into the
 * long-lived watcher process, nor the SIGTERM/SIGINT shutdown that releases
 * leases before the store is closed.
 *
 * These tests spawn `bun src/clawmem.ts watch` as a real subprocess against
 * a temp vault + temp config dir + temp collection, with short worker
 * intervals and unreachable inference endpoints (so the workers tick but
 * never spend on real LLM calls). They verify:
 *
 *   1. cmdWatch starts both workers when both env vars are set
 *   2. cmdWatch starts only the light lane when only CONSOLIDATION is set
 *   3. cmdWatch starts only the heavy lane when only HEAVY_LANE is set
 *   4. cmdWatch starts neither when no opt-in env vars are set (default)
 *   5. SIGTERM exits cleanly (exit code 0) and releases any held worker leases
 *
 * Test budget: each test spawns a subprocess and waits for the watcher to
 * print its startup banner before terminating it. Total per test ~1-2s.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLAWMEM_ENTRY = join(REPO_ROOT, "src", "clawmem.ts");
const BUN_BIN = process.execPath;

interface WatcherFixture {
  tmpRoot: string;
  configDir: string;
  vaultPath: string;
  cleanup: () => void;
}

/**
 * Build a self-contained watcher fixture: temp config dir with a minimal
 * config.yaml pointing to a temp collection dir, plus a temp vault path.
 * Caller passes `vaultPath` and `configDir` into the spawned subprocess
 * via env vars and gets back a cleanup function that removes everything.
 */
function buildWatcherFixture(): WatcherFixture {
  const tmpRoot = mkdtempSync(join(tmpdir(), "clawmem-cmdwatch-"));
  const configDir = join(tmpRoot, "config");
  const collectionDir = join(tmpRoot, "notes");
  const vaultPath = join(tmpRoot, "index.sqlite");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(collectionDir, { recursive: true });

  // Minimal config.yaml — one collection, no skill vault. cmdWatch dies
  // if collections.length === 0 so this is the smallest viable config.
  const configYaml = [
    "collections:",
    "  notes:",
    `    path: ${collectionDir}`,
    "    pattern: '**/*.md'",
    "",
  ].join("\n");
  writeFileSync(join(configDir, "config.yaml"), configYaml);

  return {
    tmpRoot,
    configDir,
    vaultPath,
    cleanup: () => {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
    },
  };
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `bun src/clawmem.ts watch` with the given env vars layered on top
 * of the current process env. Wait until either (a) `expectStdoutSubstring`
 * appears in stdout, or (b) `bootMs` elapses, then send SIGTERM and wait
 * for the subprocess to exit. Returns the captured exit code and full
 * stdout/stderr buffers.
 *
 * `bootMs` is the maximum time we wait for the watcher to print its
 * startup banner before giving up and SIGTERM-ing anyway. The test still
 * collects whatever stdout/stderr was buffered, so a watcher that crashed
 * during boot can be diagnosed from the captured stderr.
 */
/**
 * Build a fresh env for the spawned watcher that does NOT inherit any
 * CLAWMEM_* or INDEX_PATH variables from the parent test process. Bun
 * auto-loads `.env` from the current directory, so any local override
 * file (e.g. an operator's `.env` enabling the workers) would silently
 * leak into the subprocess and break the "only X is set" tests below.
 * Whitelisting CLAWMEM_* to nothing forces every test to be self-
 * contained on the worker env vars.
 */
function cleanInheritedEnv(): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("CLAWMEM_")) continue;
    if (k === "INDEX_PATH") continue;
    cleaned[k] = v;
  }
  return cleaned;
}

async function spawnAndStop(
  envOverrides: Record<string, string>,
  expectStdoutSubstring: string | null,
  bootMs: number,
  cwd: string,
): Promise<SpawnResult> {
  // IMPORTANT: cwd must NOT be REPO_ROOT. Bun auto-loads `.env` from the
  // current directory at process startup, so spawning from REPO_ROOT would
  // cause the subprocess to silently inherit any operator's local
  // `.env` overrides (e.g. CLAWMEM_HEAVY_LANE=true) and break the
  // "only X is set" tests below. Spawning from a temp dir gives us a
  // clean Bun.env on the subprocess side. The absolute path in
  // CLAWMEM_ENTRY ensures bun can still find clawmem.ts.
  const proc = Bun.spawn([BUN_BIN, CLAWMEM_ENTRY, "watch"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanInheritedEnv(),
      ...envOverrides,
      // Force remote-only mode + unreachable endpoints so workers tick
      // but never download GGUF or contact a real GPU. LLM.generate()
      // returns null on transport failure, which workers handle.
      CLAWMEM_NO_LOCAL_MODELS: "true",
      CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
      CLAWMEM_LLM_URL: "http://127.0.0.1:1",
      CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
      // No color codes — easier to grep stdout
      NO_COLOR: "1",
    },
  });

  let stdoutBuf = "";
  let stderrBuf = "";

  // Async readers so we don't deadlock on a full pipe buffer.
  const stdoutPromise = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutBuf += decoder.decode(value, { stream: true });
    }
  })();
  const stderrPromise = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrBuf += decoder.decode(value, { stream: true });
    }
  })();

  // Poll stdout until either the expected banner appears or bootMs elapses.
  const start = Date.now();
  while (Date.now() - start < bootMs) {
    if (expectStdoutSubstring && stdoutBuf.includes(expectStdoutSubstring)) {
      break;
    }
    if (!expectStdoutSubstring && stdoutBuf.includes("Watching ")) {
      // No specific banner expected — wait for the generic watcher banner
      // so we know cmdWatch has reached the worker startup section.
      break;
    }
    await Bun.sleep(50);
  }

  // Send SIGTERM and give the shutdown handler a moment to run.
  proc.kill("SIGTERM");

  // proc.exited is a Promise<number> that resolves when the subprocess
  // exits. Cap the wait so a hung shutdown does not wedge the test suite.
  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(5000).then(() => null),
  ]);

  // If still alive after 5s, force-kill so the test suite can move on.
  // The test will still fail because exitCode === null.
  if (exitCode === null) {
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  }

  // Drain any final stdout/stderr now that the process has exited.
  await Promise.all([stdoutPromise, stderrPromise]);

  return { exitCode, stdout: stdoutBuf, stderr: stderrBuf };
}

// =============================================================================
// Tests
// =============================================================================

describe("cmdWatch worker hosting (v0.8.2 Ext 2)", () => {
  let fixture: WatcherFixture | null = null;

  afterEach(() => {
    if (fixture) {
      fixture.cleanup();
      fixture = null;
    }
  });

  it("starts both workers when CONSOLIDATION + HEAVY_LANE env vars are set", async () => {
    fixture = buildWatcherFixture();
    const result = await spawnAndStop(
      {
        INDEX_PATH: fixture.vaultPath,
        CLAWMEM_CONFIG_DIR: fixture.configDir,
        CLAWMEM_ENABLE_CONSOLIDATION: "true",
        CLAWMEM_CONSOLIDATION_INTERVAL: "15000",
        CLAWMEM_HEAVY_LANE: "true",
        CLAWMEM_HEAVY_LANE_INTERVAL: "30000",
        // Wide quiet window so the heavy lane gate would pass at any hour
        // (even though we don't wait for an actual tick — banner is enough).
        CLAWMEM_HEAVY_LANE_WINDOW_START: "0",
        CLAWMEM_HEAVY_LANE_WINDOW_END: "23",
      },
      "[watch] Starting heavy maintenance lane worker",
      8000,
      fixture.tmpRoot,
    );

    expect(result.stdout).toContain("[watch] Starting consolidation worker");
    expect(result.stdout).toContain("[watch] Starting heavy maintenance lane worker");
    expect(result.exitCode).toBe(0);
  });

  it("starts only the light lane when only CLAWMEM_ENABLE_CONSOLIDATION=true", async () => {
    fixture = buildWatcherFixture();
    const result = await spawnAndStop(
      {
        INDEX_PATH: fixture.vaultPath,
        CLAWMEM_CONFIG_DIR: fixture.configDir,
        CLAWMEM_ENABLE_CONSOLIDATION: "true",
        CLAWMEM_CONSOLIDATION_INTERVAL: "15000",
      },
      "[watch] Starting consolidation worker",
      8000,
      fixture.tmpRoot,
    );

    expect(result.stdout).toContain("[watch] Starting consolidation worker");
    expect(result.stdout).not.toContain("[watch] Starting heavy maintenance lane worker");
    expect(result.exitCode).toBe(0);
  });

  it("starts only the heavy lane when only CLAWMEM_HEAVY_LANE=true", async () => {
    fixture = buildWatcherFixture();
    const result = await spawnAndStop(
      {
        INDEX_PATH: fixture.vaultPath,
        CLAWMEM_CONFIG_DIR: fixture.configDir,
        CLAWMEM_HEAVY_LANE: "true",
        CLAWMEM_HEAVY_LANE_INTERVAL: "30000",
        CLAWMEM_HEAVY_LANE_WINDOW_START: "0",
        CLAWMEM_HEAVY_LANE_WINDOW_END: "23",
      },
      "[watch] Starting heavy maintenance lane worker",
      8000,
      fixture.tmpRoot,
    );

    expect(result.stdout).not.toContain("[watch] Starting consolidation worker");
    expect(result.stdout).toContain("[watch] Starting heavy maintenance lane worker");
    expect(result.exitCode).toBe(0);
  });

  it("starts neither worker when no opt-in env vars are set (default behavior preserved)", async () => {
    fixture = buildWatcherFixture();
    const result = await spawnAndStop(
      {
        INDEX_PATH: fixture.vaultPath,
        CLAWMEM_CONFIG_DIR: fixture.configDir,
      },
      null, // No specific banner — wait for the generic "Watching ..." line
      8000,
      fixture.tmpRoot,
    );

    expect(result.stdout).toContain("Watching ");
    expect(result.stdout).not.toContain("[watch] Starting consolidation worker");
    expect(result.stdout).not.toContain("[watch] Starting heavy maintenance lane worker");
    expect(result.exitCode).toBe(0);
  });

  it("releases worker leases on SIGTERM shutdown (no stranded leases in worker_leases table)", async () => {
    fixture = buildWatcherFixture();
    const result = await spawnAndStop(
      {
        INDEX_PATH: fixture.vaultPath,
        CLAWMEM_CONFIG_DIR: fixture.configDir,
        CLAWMEM_ENABLE_CONSOLIDATION: "true",
        CLAWMEM_CONSOLIDATION_INTERVAL: "15000",
        CLAWMEM_HEAVY_LANE: "true",
        CLAWMEM_HEAVY_LANE_INTERVAL: "30000",
        CLAWMEM_HEAVY_LANE_WINDOW_START: "0",
        CLAWMEM_HEAVY_LANE_WINDOW_END: "23",
      },
      "[watch] Starting heavy maintenance lane worker",
      8000,
      fixture.tmpRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(fixture.vaultPath)).toBe(true);

    // Open the vault directly and check that no live leases were left
    // behind. Either the table is empty (no tick ran before SIGTERM) or
    // any rows that exist are already expired (TTL < now). A live lease
    // for "light-consolidation" or "heavy-maintenance" with expires_at
    // in the future is the failure mode the lifecycle wiring must avoid.
    const db = new Database(fixture.vaultPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT worker_name, expires_at FROM worker_leases
           WHERE worker_name IN ('light-consolidation', 'heavy-maintenance')`,
        )
        .all() as { worker_name: string; expires_at: string }[];

      const now = new Date().toISOString();
      const liveLeases = rows.filter((r) => r.expires_at > now);
      expect(liveLeases).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// =============================================================================
// Slow path: real heavy-lane tick + lease release (Codex Turn 1 finding)
// =============================================================================
//
// The fast tests above only verify startup banners + clean shutdown — they
// SIGTERM at ~8s, well before the 30s minimum heavy-lane interval clamp in
// maintenance.ts can fire its first tick. Codex's review of v0.8.2 (turn 1)
// flagged this: "test 5 can pass simply because no lease was ever acquired".
//
// This slow case spawns the watcher with CLAWMEM_HEAVY_LANE_INTERVAL set to
// the minimum (30000ms), polls the vault SQLite directly until at least one
// `maintenance_runs` row appears (proving the heavy-lane setInterval fired
// AND completed AND committed its journal), then SIGTERMs and asserts:
//
//   1. Exit code 0 (clean shutdown waited for the in-flight tick)
//   2. >= 1 row in maintenance_runs for lane='heavy' (real tick happened)
//   3. NO live leases in worker_leases (acquired+released cleanly)
//
// Test budget ~35s. Worth the wall time because it is the ONLY automated
// check that the lifecycle wiring (start → tick → SIGTERM → drain → release
// → store close) holds end-to-end against a real subprocess.

describe("cmdWatch worker hosting (v0.8.2 slow path)", () => {
  let fixture: WatcherFixture | null = null;

  afterEach(() => {
    if (fixture) {
      fixture.cleanup();
      fixture = null;
    }
  });

  it(
    "completes at least one real heavy-lane tick, journals it, and releases the lease on SIGTERM",
    async () => {
      fixture = buildWatcherFixture();
      const localFixture = fixture;

      const proc = Bun.spawn(
        [BUN_BIN, CLAWMEM_ENTRY, "watch"],
        {
          cwd: localFixture.tmpRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...cleanInheritedEnv(),
            INDEX_PATH: localFixture.vaultPath,
            CLAWMEM_CONFIG_DIR: localFixture.configDir,
            CLAWMEM_HEAVY_LANE: "true",
            CLAWMEM_HEAVY_LANE_INTERVAL: "30000",
            CLAWMEM_HEAVY_LANE_WINDOW_START: "0",
            CLAWMEM_HEAVY_LANE_WINDOW_END: "23",
            // Force remote-only mode so workers tick but never spend on real LLM.
            CLAWMEM_NO_LOCAL_MODELS: "true",
            CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
            CLAWMEM_LLM_URL: "http://127.0.0.1:1",
            CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
            NO_COLOR: "1",
          },
        },
      );

      let stdoutBuf = "";
      let stderrBuf = "";
      const stdoutPromise = (async () => {
        const decoder = new TextDecoder();
        const reader = proc.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdoutBuf += decoder.decode(value, { stream: true });
        }
      })();
      const stderrPromise = (async () => {
        const decoder = new TextDecoder();
        const reader = proc.stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderrBuf += decoder.decode(value, { stream: true });
        }
      })();

      // Poll the vault SQLite until at least one heavy-lane row appears in
      // maintenance_runs. The first setInterval fire is at t+30s; allow a
      // generous 50s ceiling for slow CI environments.
      const pollDeadline = Date.now() + 50_000;
      let heavyRows: { cnt: number } = { cnt: 0 };
      while (Date.now() < pollDeadline) {
        if (existsSync(localFixture.vaultPath)) {
          try {
            const db = new Database(localFixture.vaultPath, { readonly: true });
            try {
              heavyRows = db
                .prepare(
                  `SELECT COUNT(*) as cnt FROM maintenance_runs WHERE lane = 'heavy'`,
                )
                .get() as { cnt: number };
              if (heavyRows.cnt > 0) {
                db.close();
                break;
              }
            } finally {
              db.close();
            }
          } catch {
            // Table may not exist yet, or vault still being initialized.
          }
        }
        await Bun.sleep(500);
      }

      // SIGTERM and wait for clean exit. The async shutdown closure must
      // drain the in-flight tick (if one is still running) before closing
      // the store. Cap the wait at 35s — the heavy-lane stop drain timeout
      // is 30s, plus 5s of slack for cleanup.
      proc.kill("SIGTERM");
      const exitCode = await Promise.race([
        proc.exited,
        Bun.sleep(35_000).then(() => null),
      ]);
      if (exitCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
      await Promise.all([stdoutPromise, stderrPromise]);

      // Assertions
      expect(heavyRows.cnt).toBeGreaterThan(0);
      expect(exitCode).toBe(0);

      const db = new Database(localFixture.vaultPath, { readonly: true });
      try {
        // Confirm at least one row was actually committed.
        const allRuns = db
          .prepare(
            `SELECT lane, phase, status, reason FROM maintenance_runs WHERE lane = 'heavy' ORDER BY id`,
          )
          .all() as { lane: string; phase: string; status: string; reason: string | null }[];
        expect(allRuns.length).toBeGreaterThan(0);
        // Quiet-window 0..23 + low query rate + clean lease — first attempt
        // should not have skipped on gate or lease. We tolerate any non-skip
        // status because Phase 2/3 may legitimately complete or fail (the
        // unreachable LLM stub means generate() returns null and the workers
        // gracefully degrade; either is a real tick attempt that proves the
        // wiring works).
        const nonGateSkip = allRuns.find((r) => !(r.phase === "gate" && r.status === "skipped"));
        expect(nonGateSkip).toBeDefined();

        // Lease must be released — no live row for heavy-maintenance.
        const liveLeases = db
          .prepare(
            `SELECT worker_name, expires_at FROM worker_leases
             WHERE worker_name = 'heavy-maintenance' AND expires_at > ?`,
          )
          .all(new Date().toISOString()) as { worker_name: string; expires_at: string }[];
        expect(liveLeases).toEqual([]);
      } finally {
        db.close();
      }
    },
    90_000, // overall test timeout: 90s ceiling for poll + drain + exit
  );
});
