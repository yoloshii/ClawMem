import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, prewarmVectors, startPeriodicPrewarm, resolvePrewarmIntervalMs, PREWARM_MIN_INTERVAL_MS, PREWARM_DEFAULT_INTERVAL_MS, resolveStore } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { wasPromptSeenRecently } from "../../src/hooks.ts";
import { clearConfigCache } from "../../src/config.ts";

/**
 * Regression tests for the context-surfacing UserPromptSubmit hook timing out
 * ("UserPromptSubmit hook timed out after 8s/15s — output discarded").
 *
 * Two structural defects are locked in here:
 *   1. initializeDatabase() ran an UNCONDITIONAL backfill UPDATE on every writable
 *      open, taking a write lock that could block up to busy_timeout (15s) when
 *      another process held the writer lock — on the hook's own critical path.
 *      Fix: guard the backfill behind a read so a healthy DB does no init write.
 *   2. The vector leg's `Promise.race([searchVec(), setTimeout(vectorTimeout)])`
 *      guard is a FALSE SAFETY: searchVec runs a SYNCHRONOUS sqlite-vec scan
 *      (bun:sqlite blocks the event loop), so the setTimeout can never fire while
 *      it runs. Fix: searchVec takes a wall-clock deadline and self-aborts before
 *      the blocking scan. The premise test below proves the guard cannot work.
 *   3. (B3) The hook's OWN best-effort writes ran under the store default
 *      busy_timeout (5000ms). The dedup UPSERT in wasPromptSeenRecently was the
 *      one write NOT wrapped fail-open, so a contended SQLITE_BUSY there aborted
 *      the whole hook EARLY (before search). Fix: the dedup write is fail-open,
 *      and the context-surfacing hook process caps its busy_timeout small
 *      (cmdHook) so contended writes fail fast instead of stalling the budget.
 */

const tmpFiles: string[] = [];
function tmpDbPath(name: string): string {
  const p = join(tmpdir(), `clawmem-httest-${name}-${process.pid}-${Date.now()}-${tmpFiles.length}.sqlite`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(p + suffix); } catch { /* ignore */ } }
  }
});

describe("initializeDatabase — the backfill is read-guarded (Change 1)", () => {
  it("a writable open on a healthy DB does NOT wait on busy_timeout while another writer holds the lock", () => {
    const path = tmpDbPath("backfill");
    // Initialize the schema once (WAL mode persists; backfill runs against 0 docs).
    createStore(path).close();

    // A second connection acquires and holds the write lock.
    const holder = new Database(path);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO content (hash, doc, created_at) VALUES ('h','d','2026-01-01T00:00:00Z')");

    try {
      // Fresh writable open with a 4s init busy_timeout. With the OLD unconditional backfill
      // UPDATE, initializeDatabase would take a write lock and block ~4s (then SQLITE_BUSY).
      // With the read-guarded backfill, the UPDATE is skipped on a healthy DB, so init takes
      // no write lock and the open completes immediately despite the held writer lock.
      const t0 = Date.now();
      let threw = false;
      try {
        createStore(path, { busyTimeout: 4000 }).close();
      } catch {
        threw = true;
      }
      const elapsed = Date.now() - t0;

      expect(threw).toBe(false);            // must NOT SQLITE_BUSY out
      expect(elapsed).toBeLessThan(1500);   // must NOT wait out the 4s busy_timeout
    } finally {
      try { holder.exec("ROLLBACK"); } catch { /* ignore */ }
      holder.close();
    }
  });
});

describe("Promise.race + setTimeout cannot bound a synchronous call (why searchVec needs a deadline — Change 2)", () => {
  it("the timeout does not fire until the synchronous work completes", async () => {
    // Mirrors context-surfacing.ts: an async fn that awaits (embed) then runs a SYNCHRONOUS
    // scan, raced against a setTimeout. The synchronous scan blocks the event loop, so the
    // timer's callback cannot run — the race resolves with the scan's result, not the timeout.
    async function syncVecLike(): Promise<string> {
      await Promise.resolve();                       // the `await getEmbedding()` yield
      const until = Date.now() + 400;
      while (Date.now() < until) { /* synchronous sqlite-vec MATCH blocks the thread */ }
      return "vec-results";
    }

    const t0 = Date.now();
    let outcome: string;
    try {
      outcome = String(await Promise.race([
        syncVecLike(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("vector timeout")), 100)),
      ]));
    } catch {
      outcome = "TIMED_OUT";
    }
    const elapsed = Date.now() - t0;

    expect(outcome).toBe("vec-results");            // the 100ms guard did NOT fire
    expect(elapsed).toBeGreaterThanOrEqual(350);    // it waited out the full 400ms synchronous scan
  });
});

describe("prewarmVectors — embed-independent, honest success (Change 4 fix)", () => {
  it("returns false (no false-positive 'warmed') when there is no vector table", () => {
    const store = createStore(":memory:");
    // A searchVec()-based prewarm would also no-op here, but would still resolve/log success.
    // prewarmVectors must report false so the watcher does not claim a warm that never happened.
    expect(prewarmVectors(store.db)).toBe(false);
    store.close();
  });

  it("returns true by scanning a populated vector table WITHOUT any embed server", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const now = new Date().toISOString();
    const hash = hashContent("doc a" + "a.md");
    store.insertContent(hash, "doc a", now);
    store.insertDocument("c", "a.md", "a.md", hash, now, now);
    store.insertEmbedding(hash, 0, 1, new Float32Array([1, 0, 0, 0]), "m1", now, "full", null, "c/a.md");
    // No CLAWMEM_EMBED_URL and no embed server running: the zero-vector MATCH must still scan and
    // return true. (A searchVec()-based prewarm would fail here because getEmbedding returns null.)
    expect(prewarmVectors(store.db)).toBe(true);
    store.close();
  });
});

describe("startPeriodicPrewarm — periodic re-warm keeps the OS cache hot (B5 Option C)", () => {
  // The watcher's one-shot prewarm warms the OS page cache ONCE. Under memory pressure the kernel
  // can evict the vector payload between hook calls, letting a cold synchronous MATCH creep back
  // into the context-surfacing hook path. A periodic re-touch biases the LRU to keep it resident.
  // These lock in: disabled == no handle/no firing; a real interval fires REPEATEDLY and actually
  // scans; and the handle is cleanly clearable (the watcher shutdown-cleanup contract).
  it("returns null when disabled (intervalMs <= 0) and never fires", async () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    let ticks = 0;
    const timer = startPeriodicPrewarm(store.db, 0, () => { ticks++; });
    expect(timer).toBeNull();                 // disabled → no handle
    await new Promise(r => setTimeout(r, 40));
    expect(ticks).toBe(0);                     // nothing scheduled
    store.close();
  });

  it("treats a non-finite / negative interval as disabled", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    expect(startPeriodicPrewarm(store.db, NaN)).toBeNull();  // parseInt("garbage") → NaN
    expect(startPeriodicPrewarm(store.db, -5)).toBeNull();
    store.close();
  });

  it("fires REPEATEDLY on the interval, actually scans, and STOPS after clearInterval", async () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    // One real vector so prewarmVectors performs an actual scan (ran === true).
    const now = new Date().toISOString();
    const hash = hashContent("doc a" + "a.md");
    store.insertContent(hash, "doc a", now);
    store.insertDocument("c", "a.md", "a.md", hash, now, now);
    store.insertEmbedding(hash, 0, 1, new Float32Array([1, 0, 0, 0]), "m1", now, "full", null, "c/a.md");

    let ticks = 0;
    let lastRan = false;
    const timer = startPeriodicPrewarm(store.db, 15, (ran) => { ticks++; lastRan = ran; });
    expect(timer).not.toBeNull();

    await new Promise(r => setTimeout(r, 90));      // ~6 ticks at 15ms
    const whileActive = ticks;
    // Bug-first: a one-shot (setTimeout) or a stub that never re-fires would leave this <= 1.
    expect(whileActive).toBeGreaterThanOrEqual(2);  // genuinely PERIODIC, not one-shot
    expect(lastRan).toBe(true);                     // it scanned the populated vec table

    clearInterval(timer!);
    const atClear = ticks;
    await new Promise(r => setTimeout(r, 60));
    // Bug-first: a leaked (un-clearable) timer would keep incrementing past shutdown.
    expect(ticks).toBe(atClear);                    // cleanly stoppable == shutdown-safe
    store.close();
  });
});

describe("resolvePrewarmIntervalMs — strict parse + 60s floor (B5 Option C, codex Medium fix)", () => {
  // The watcher env path must not schedule a near-continuous ~1.5 GB scan. Before this fix,
  // parseInt("1e3", 10) === 1 (silent truncation at "e") and CLAWMEM_PREWARM_INTERVAL_MS=1 were
  // both accepted verbatim → a 1ms interval hammering the synchronous vector scan.
  it("returns the default when unset / empty / whitespace / unparseable", () => {
    expect(resolvePrewarmIntervalMs(undefined)).toBe(PREWARM_DEFAULT_INTERVAL_MS);
    expect(resolvePrewarmIntervalMs("")).toBe(PREWARM_DEFAULT_INTERVAL_MS);
    expect(resolvePrewarmIntervalMs("   ")).toBe(PREWARM_DEFAULT_INTERVAL_MS);
    expect(resolvePrewarmIntervalMs("abc")).toBe(PREWARM_DEFAULT_INTERVAL_MS);
    expect(resolvePrewarmIntervalMs("NaN")).toBe(PREWARM_DEFAULT_INTERVAL_MS);
  });

  it("keeps exactly 0 as the disable switch; sends negatives to the default (not a fast loop, not silent-off)", () => {
    expect(resolvePrewarmIntervalMs("0")).toBe(0);
    expect(resolvePrewarmIntervalMs("-5")).toBe(PREWARM_DEFAULT_INTERVAL_MS);
    expect(resolvePrewarmIntervalMs("-60000")).toBe(PREWARM_DEFAULT_INTERVAL_MS);
  });

  it("clamps tiny positives UP to the 60s floor — the pathological near-continuous-scan inputs", () => {
    expect(resolvePrewarmIntervalMs("1")).toBe(PREWARM_MIN_INTERVAL_MS);     // literal 1ms
    expect(resolvePrewarmIntervalMs("1e3")).toBe(PREWARM_MIN_INTERVAL_MS);   // Number()=1000 (parseInt→1); still < floor
    expect(resolvePrewarmIntervalMs("5000")).toBe(PREWARM_MIN_INTERVAL_MS);  // 5s < 60s floor
    expect(resolvePrewarmIntervalMs("59999")).toBe(PREWARM_MIN_INTERVAL_MS);
  });

  it("passes through values at or above the floor, floored to an integer", () => {
    expect(resolvePrewarmIntervalMs("60000")).toBe(60000);                   // exactly the floor
    expect(resolvePrewarmIntervalMs("600000")).toBe(600000);                 // the default value explicitly
    expect(resolvePrewarmIntervalMs("900000")).toBe(900000);
    expect(resolvePrewarmIntervalMs("60000.9")).toBe(60000);                 // floored to int
  });
});

describe("wasPromptSeenRecently — dedup write is fail-open under contention (B3)", () => {
  it("does NOT throw and returns fast when the dedup UPSERT hits a held write lock", () => {
    const path = tmpDbPath("dedup");
    createStore(path).close(); // init schema (hook_dedupe table + WAL mode)

    // Ensure we actually reach the UPSERT: a dedup window of 0 short-circuits
    // before the write (and a sibling test file sets this env to "0").
    const prevWindow = process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
    process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "600";

    // Open the store-under-test BEFORE contention so the open itself never races.
    // Set the small busy_timeout the context-surfacing hook process uses (B3).
    const store = createStore(path, { busyTimeout: 4000 });
    store.db.exec("PRAGMA busy_timeout = 500");

    // A second connection holds the write lock so the dedup UPSERT contends.
    const holder = new Database(path);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO content (hash, doc, created_at) VALUES ('h','d','2026-01-01T00:00:00Z')");

    try {
      const t0 = Date.now();
      let threw = false;
      let result: boolean | undefined;
      try {
        // The SELECT (WAL read) succeeds despite the held write lock; the UPSERT
        // then contends. Bug-first: the OLD unguarded UPSERT throws SQLITE_BUSY
        // here and that propagated out of the hook (aborting it before it could
        // return the surfaced context). The fail-open guard swallows it.
        result = wasPromptSeenRecently(store, "context-surfacing", "a sufficiently long user prompt to dedup");
      } catch {
        threw = true;
      }
      const elapsed = Date.now() - t0;

      expect(threw).toBe(false);           // fail-open: contended dedup write must not throw
      expect(typeof result).toBe("boolean"); // still returns the READ-based verdict
      expect(elapsed).toBeLessThan(1500);   // bounded by the 500ms cap, not the 4000ms default
    } finally {
      if (prevWindow === undefined) delete process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
      else process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = prevWindow;
      try { holder.exec("ROLLBACK"); } catch { /* ignore */ }
      holder.close();
      store.close();
    }
  });
});

describe("resolveStore forwards the busy_timeout cap to a NAMED vault (B3 High-fix)", () => {
  it("a contended write on a skill-vault opened with a small cap fails fast, not at the 5000ms default", () => {
    const path = tmpDbPath("skillvault");
    createStore(path).close(); // init schema (WAL mode)

    // Register the path as a named vault so resolveStore("skilltest") resolves it.
    const prevVaults = process.env.CLAWMEM_VAULTS;
    process.env.CLAWMEM_VAULTS = JSON.stringify({ skilltest: path });
    clearConfigCache();

    // Open the named-vault store the way context-surfacing now does — inheriting
    // the hook's small cap instead of the 5000ms operational default.
    const s = resolveStore("skilltest", { busyTimeout: 500 });

    // A second connection holds the skill-vault writer lock.
    const holder = new Database(path);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO content (hash, doc, created_at) VALUES ('h','d','2026-01-01T00:00:00Z')");

    try {
      const t0 = Date.now();
      let threw = false;
      try {
        // Mirrors the recall mirror write (context-surfacing.ts) that the High
        // finding flagged as still using the 5000ms default.
        s.insertUsage({
          sessionId: "x",
          timestamp: new Date().toISOString(),
          hookName: "context-surfacing",
          injectedPaths: [],
          estimatedTokens: 0,
          wasReferenced: 0,
        });
      } catch {
        threw = true; // SQLITE_BUSY — context-surfacing wraps this fail-open
      }
      const elapsed = Date.now() - t0;

      expect(threw).toBe(true);           // contended write does hit SQLITE_BUSY (caller swallows it)
      expect(elapsed).toBeLessThan(1500); // bounded by the 500ms cap, NOT the 5000ms default
    } finally {
      if (prevVaults === undefined) delete process.env.CLAWMEM_VAULTS;
      else process.env.CLAWMEM_VAULTS = prevVaults;
      clearConfigCache();
      try { holder.exec("ROLLBACK"); } catch { /* ignore */ }
      holder.close();
      s.close();
    }
  });
});
