import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, prewarmVectors } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";

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
