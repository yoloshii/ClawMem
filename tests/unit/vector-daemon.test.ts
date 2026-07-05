/**
 * Vector-query daemon (BACKLOG Source 46) — bug-first tests for the socket protocol, single-flight
 * backpressure, deadline-on-receipt, the frame-rejection guards, teardown, and the client's fail-open
 * classification. The Step-1 scan is injected, so these exercise the daemon/IPC logic WITHOUT a live
 * embedding server (they never touch the real sqlite-vec MATCH).
 */
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import {
  startVectorDaemon,
  vecDaemonSocketPath,
  daemonVecMatch,
  searchVecBounded,
  type VectorDaemonHandle,
} from "../../src/vector-daemon.ts";
import { VecReadModelMismatchError, type Store } from "../../src/store.ts";

let seq = 0;
// Only `.dbPath` is read when a scan is injected — the default scan's `store.db` is never touched.
function fakeStore(): Store {
  return { dbPath: `/tmp/vd-test-${process.pid}-${seq++}.sqlite` } as unknown as Store;
}

// Minimal raw client: send one framed payload, resolve the first newline-terminated response line.
// Handles write backpressure (a large payload can't be written in one call — resume on `drain`), so
// the oversized-frame test actually delivers its >256KB. Payloads here are ASCII, so 1 char == 1 byte.
function rawRequest(sockPath: string, payload: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let offset = 0;
    const timer = setTimeout(() => reject(new Error("rawRequest timeout")), timeoutMs);
    const pump = (s: { write(data: string): number }) => {
      while (offset < payload.length) {
        const n = s.write(payload.slice(offset));
        if (n <= 0) break; // backpressure — resume on drain
        offset += n;
      }
    };
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) { try { pump(s); } catch (e) { clearTimeout(timer); reject(e as Error); } },
        drain(s) { try { pump(s); } catch { /* socket closing after a response — ignore */ } },
        data(s, d) {
          buf += d.toString();
          const nl = buf.indexOf("\n");
          if (nl >= 0) { clearTimeout(timer); resolve(buf.slice(0, nl)); s.end(); }
        },
        error(_s, e) { clearTimeout(timer); reject(e); },
        connectError(_s, e) { clearTimeout(timer); reject(e); },
      },
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// A misbehaving fake daemon: bind a raw listener and react to the client's request with `onData`
// (write garbage, close silently, or never respond) to exercise the client's fail-open classification.
function fakeServer(sockPath: string, onData: (s: Socket<{ buf: string }>) => void): { stop: () => void } {
  mkdirSync(dirname(sockPath), { recursive: true });
  if (existsSync(sockPath)) rmSync(sockPath, { force: true });
  const srv = Bun.listen<{ buf: string }>({
    unix: sockPath,
    socket: { open(s) { s.data = { buf: "" }; }, data(s) { onData(s); } },
  });
  return {
    stop() {
      try { srv.stop(true); } catch { /* already stopped */ }
      try { if (existsSync(sockPath)) rmSync(sockPath, { force: true }); } catch { /* best-effort */ }
    },
  };
}

describe("vecDaemonSocketPath", () => {
  test("deterministic per dbPath; isolated across vaults", () => {
    const a = vecDaemonSocketPath("/x/.cache/clawmem/index.sqlite");
    const a2 = vecDaemonSocketPath("/x/.cache/clawmem/index.sqlite");
    const b = vecDaemonSocketPath("/x/.cache/clawmem/work.sqlite");
    expect(a).toBe(a2);              // same vault → same socket (rendezvous)
    expect(a).not.toBe(b);          // different vault → different socket (no collision)
    expect(a.endsWith(".sock")).toBe(true);
  });
});

describe("vector daemon server", () => {
  let handle: VectorDaemonHandle | null = null;
  afterEach(() => { handle?.close(); handle = null; });

  test("serves the injected scan's hits as {results}", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => [{ hash_seq: "h1_0", distance: 0.1 }]);
    expect(handle).not.toBeNull();
    const resp = await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ query: "q", model: "m", limit: 5 }) + "\n");
    expect(JSON.parse(resp)).toEqual({ results: [{ hash_seq: "h1_0", distance: 0.1 }] });
  });

  test("single-flight: a second request during an in-flight scan gets {error:'busy'}", async () => {
    const store = fakeStore();
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => { signalStarted = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handle = await startVectorDaemon(store, () => {}, async () => { signalStarted(); await gate; return [{ hash_seq: "h_0", distance: 0 }]; });
    const sock = vecDaemonSocketPath(store.dbPath);
    const first = rawRequest(sock, JSON.stringify({ query: "a", model: "m", limit: 5 }) + "\n");
    await started; // deterministic: the daemon sets scanInFlight before the scan fn runs, so it's true now
    const second = await rawRequest(sock, JSON.stringify({ query: "b", model: "m", limit: 5 }) + "\n");
    expect(JSON.parse(second)).toEqual({ error: "busy" });
    release();
    expect(JSON.parse(await first)).toEqual({ results: [{ hash_seq: "h_0", distance: 0 }] });
  });

  test("deadline-on-receipt: an already-expired request is rejected WITHOUT scanning", async () => {
    const store = fakeStore();
    let scanned = false;
    handle = await startVectorDaemon(store, () => {}, async () => { scanned = true; return []; });
    const resp = await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ query: "q", model: "m", limit: 5, deadlineMs: Date.now() - 1000 }) + "\n");
    expect(JSON.parse(resp)).toEqual({ error: "expired" });
    expect(scanned).toBe(false); // the pile-up guard: no wasted scan for a hook that already gave up
  });

  test("malformed JSON → {error:'malformed'}", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => []);
    const resp = await rawRequest(vecDaemonSocketPath(store.dbPath), "this is not json\n");
    expect(JSON.parse(resp)).toEqual({ error: "malformed" });
  });

  test("oversized frame → {error:'oversized'} without scanning", async () => {
    const store = fakeStore();
    let scanned = false;
    handle = await startVectorDaemon(store, () => {}, async () => { scanned = true; return []; });
    const resp = await rawRequest(vecDaemonSocketPath(store.dbPath), "x".repeat(300 * 1024) + "\n");
    expect(JSON.parse(resp)).toEqual({ error: "oversized" });
    expect(scanned).toBe(false);
  });

  test("close() unlinks the socket → the file is gone", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => []);
    const sock = vecDaemonSocketPath(store.dbPath);
    expect(existsSync(sock)).toBe(true);
    handle!.close();
    handle = null;
    expect(existsSync(sock)).toBe(false);
  });
});

describe("daemonVecMatch (hook client fail-open classification)", () => {
  let handle: VectorDaemonHandle | null = null;
  afterEach(() => { handle?.close(); handle = null; });

  test("no socket → {status:'absent'} (hook uses the in-process path)", async () => {
    const store = fakeStore();
    const out = await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, 1000);
    expect(out.status).toBe("absent");
  });

  test("live daemon → {status:'ok'} carrying the hits", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => [{ hash_seq: "h_0", distance: 0.2 }]);
    const out = await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, 1000);
    expect(out.status).toBe("ok");
    if (out.status === "ok") expect(out.results).toEqual([{ hash_seq: "h_0", distance: 0.2 }]);
  });

  test("busy daemon → {status:'busy'} (hook drops to FTS, not the in-process block)", async () => {
    const store = fakeStore();
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => { signalStarted = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handle = await startVectorDaemon(store, () => {}, async () => { signalStarted(); await gate; return []; });
    const first = daemonVecMatch(store.dbPath, { query: "a", model: "m", limit: 5 }, 2000);
    await started;
    const second = await daemonVecMatch(store.dbPath, { query: "b", model: "m", limit: 5 }, 2000);
    expect(second.status).toBe("busy");
    release();
    await first;
  });

  test("zero IPC budget → {status:'error'} without re-running in-process", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => [{ hash_seq: "h_0", distance: 0 }]);
    const out = await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, 0);
    expect(out.status).toBe("error");
  });
});

describe("searchVecBounded routing + client failure modes", () => {
  let handle: VectorDaemonHandle | null = null;
  afterEach(() => { handle?.close(); handle = null; });

  test("no daemon → routes to the in-process store.searchVec", async () => {
    const sentinel = [{ filepath: "clawmem://c/x.md", score: 0.9 }] as unknown as Awaited<ReturnType<typeof searchVecBounded>>;
    let called = false;
    const store = {
      dbPath: `/tmp/vd-test-${process.pid}-${seq++}.sqlite`,
      searchVec: async () => { called = true; return sentinel; },
    } as unknown as Store;
    const out = await searchVecBounded(store, "q", "m", 5);
    expect(called).toBe(true);       // absent socket → in-process path
    expect(out).toBe(sentinel);
  });

  test("daemon read-model-mismatch propagates as VecReadModelMismatchError (so the hook warns once)", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => { throw new VecReadModelMismatchError(["old-model"], "new-model"); });
    await expect(searchVecBounded(store, "q", "m", 5)).rejects.toThrow(VecReadModelMismatchError);
  });

  test("malformed daemon response → {status:'error'}", async () => {
    const dbPath = `/tmp/vd-test-${process.pid}-${seq++}.sqlite`;
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write("not json at all\n"); s.end(); });
    try {
      const out = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, 1000);
      expect(out.status).toBe("error");
    } finally { srv.stop(); }
  });

  test("daemon closes without responding → {status:'error'}", async () => {
    const dbPath = `/tmp/vd-test-${process.pid}-${seq++}.sqlite`;
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.end(); });
    try {
      const out = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, 1000);
      expect(out.status).toBe("error");
    } finally { srv.stop(); }
  });

  test("hung daemon (no response) → {status:'error'} at the IPC deadline", async () => {
    const dbPath = `/tmp/vd-test-${process.pid}-${seq++}.sqlite`;
    const srv = fakeServer(vecDaemonSocketPath(dbPath), () => { /* receive, never respond */ });
    try {
      const out = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, 200);
      expect(out.status).toBe("error");
    } finally { srv.stop(); }
  });
});
