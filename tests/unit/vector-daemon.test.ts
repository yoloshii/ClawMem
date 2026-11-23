/**
 * Vector-query daemon (BACKLOG Source 46) — bug-first tests for the socket protocol, single-flight
 * backpressure, deadline-on-receipt, the frame-rejection guards, teardown, and the client's fail-open
 * classification. The Step-1 scan is injected, so these exercise the daemon/IPC logic WITHOUT a live
 * embedding server (they never touch the real sqlite-vec MATCH).
 */
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { stubSearchVec } from "../helpers/vec-stub.ts";
import {
  startVectorDaemon,
  vecDaemonSocketPath,
  daemonVecMatch,
  daemonPing,
  searchVecBounded,
  searchVecDaemonRequired,
  type VectorDaemonHandle,
} from "../../src/vector-daemon.ts";
import { VecReadModelMismatchError, type Store } from "../../src/store.ts";
import { monoNow, deadlineAfter, duration, elapsed } from "../../src/clock.ts";
import { DEADLINE_PROTOCOL, MAX_LEG_BUDGET_MS } from "../../src/vector-protocol.ts";

/** O1: the client's authoritative monotonic deadline, `ms` from now (what every daemonVecMatch call carries). */
const dl = (ms: number) => deadlineAfter(monoNow(), duration(ms));

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

// Like rawRequest, but resolves with EVERYTHING the daemon wrote before it closed the connection —
// for asserting that nothing follows the first frame. Small ASCII payloads only (one write).
function rawRequestAll(sockPath: string, payload: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("rawRequestAll timeout")), timeoutMs);
    const done = () => { clearTimeout(timer); resolve(buf); };
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) { s.write(payload); },
        data(_s, d) { buf += d.toString(); },
        end(s) { done(); s.end(); },
        close() { done(); },
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

  test("serves the injected scan's hits as {results}; the deadline attestation rides ONLY on a request whose budget was enforced (codex migration r1 P2)", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => [{ hash_seq: "h1_0", distance: 0.1 }]);
    expect(handle).not.toBeNull();
    // A raw request WITHOUT remainingBudgetMs ran under no advisory deadline — nothing is attested.
    const resp = await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ query: "q", model: "m", limit: 5 }) + "\n");
    expect(JSON.parse(resp)).toEqual({ results: [{ hash_seq: "h1_0", distance: 0.1 }], vectorFaultProtocol: "vf1" });
    // The same request WITH a budget ran under the advisory deadline — attested.
    const budgeted = await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: 2000 }) + "\n");
    expect(JSON.parse(budgeted)).toEqual({ results: [{ hash_seq: "h1_0", distance: 0.1 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
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
    expect(JSON.parse(await first)).toEqual({ results: [{ hash_seq: "h_0", distance: 0 }], vectorFaultProtocol: "vf1" }); // no budget sent → unattested (P2)
  });

  test("O1 §4 version skew by FIELD PRESENCE: a pre-O1 absolute `deadlineMs` request is refused WITHOUT scanning and without decoding it", async () => {
    const store = fakeStore();
    let scanned = false;
    handle = await startVectorDaemon(store, () => {}, async () => { scanned = true; return []; });
    const sock = vecDaemonSocketPath(store.dbPath);
    // Past, future, or garbage — presence alone is the skew signal; no value is ever a deadline.
    for (const deadlineMs of [Date.now() - 1000, Date.now() + 60_000, "soon", null]) {
      const resp = await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, deadlineMs }) + "\n");
      expect(JSON.parse(resp)).toEqual({ error: "version_skew" });
    }
    expect(scanned).toBe(false);
  });

  test("v0.38.1: the version_skew refusal is LOGGED once per daemon — repeated pre-O1 requests add no line, and neither does a ping or a served request", async () => {
    const store = fakeStore();
    const logs: string[] = [];
    handle = await startVectorDaemon(store, m => logs.push(m), async () => [{ hash_seq: "h_0", distance: 0 }]);
    const sock = vecDaemonSocketPath(store.dbPath);
    const skewLines = (from: string[]) => from.filter(l => l.includes("version_skew"));
    const preO1 = JSON.stringify({ query: "q", model: "m", limit: 5, deadlineMs: 1 }) + "\n";
    // Pre-fix the refusal logged nothing, and the old client falls back to FTS silently, so a
    // mixed-build deployment was invisible on both sides. An old hook sends one of these on every
    // prompt: every one is refused, only the first is logged.
    for (let i = 0; i < 3; i++) expect(JSON.parse(await rawRequest(sock, preO1))).toEqual({ error: "version_skew" });
    expect(skewLines(logs)).toHaveLength(1);
    expect(skewLines(logs)[0]).toContain(sock); // names the socket — a multi-vault host has one watcher per vault
    expect(skewLines(logs)[0]).toContain("pre-v0.38");
    await rawRequest(sock, JSON.stringify({ ping: true }) + "\n");
    expect(JSON.parse(await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5 }) + "\n"))).toEqual({ results: [{ hash_seq: "h_0", distance: 0 }], vectorFaultProtocol: "vf1" });
    expect(skewLines(logs)).toHaveLength(1);
    // Once per DAEMON, not per module: a restarted daemon reports its own first refusal.
    handle!.close();
    const logs2: string[] = [];
    handle = await startVectorDaemon(store, m => logs2.push(m), async () => []);
    expect(JSON.parse(await rawRequest(sock, preO1))).toEqual({ error: "version_skew" });
    expect(skewLines(logs2)).toHaveLength(1);
  });

  test("v0.38.1 (codex r1): a THROWING log sink never touches the answer, and a line the sink refused does not spend the once", async () => {
    const store = fakeStore();
    const logs: string[] = [];
    let skewSinkFailures = 1; // the journal is briefly unwritable for the first refusal
    let scanned = false;
    handle = await startVectorDaemon(store, m => {
      if (m.includes("version_skew") && skewSinkFailures > 0) { skewSinkFailures--; throw new Error("log sink down"); }
      logs.push(m);
    }, async () => { scanned = true; return []; });
    const sock = vecDaemonSocketPath(store.dbPath);
    const preO1 = JSON.stringify({ query: "q", model: "m", limit: 5, deadlineMs: 1 }) + "\n";
    const refusal = JSON.stringify({ error: "version_skew" }) + "\n";
    // The WHOLE stream the daemon wrote before closing: the refusal frame and nothing after it.
    expect(await rawRequestAll(sock, preO1)).toBe(refusal);
    expect(logs.filter(l => l.includes("version_skew"))).toHaveLength(0);
    // The sink recovered: the next refusal is the one logged, and it stays the only one.
    expect(await rawRequestAll(sock, preO1)).toBe(refusal);
    expect(await rawRequestAll(sock, preO1)).toBe(refusal);
    expect(logs.filter(l => l.includes("version_skew"))).toHaveLength(1);
    expect(scanned).toBe(false);
  });

  test("O1 §2 budget validation (t89 P3 convention): a non-integer / < 1 / > MAX_LEG_BUDGET_MS remainingBudgetMs is bad_request BEFORE the scan; the ceiling itself is served", async () => {
    const store = fakeStore();
    let scanned = 0;
    handle = await startVectorDaemon(store, () => {}, async () => { scanned++; return [{ hash_seq: "h_0", distance: 0 }]; });
    const sock = vecDaemonSocketPath(store.dbPath);
    for (const remainingBudgetMs of [0, -5, 0.5, 1.5, MAX_LEG_BUDGET_MS + 1, 1e9]) {
      const resp = await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs }) + "\n");
      expect(JSON.parse(resp)).toEqual({ error: "bad_request" });
    }
    expect(scanned).toBe(0);
    // A string / NaN is a MALFORMED control field (t90 S1), refused before the range check.
    expect(JSON.parse(await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: "soon" }) + "\n"))).toEqual({ error: "malformed" });
    expect(scanned).toBe(0);
    for (const remainingBudgetMs of [1, MAX_LEG_BUDGET_MS]) {
      const resp = await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs }) + "\n");
      expect(JSON.parse(resp)).toEqual({ results: [{ hash_seq: "h_0", distance: 0 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
    }
    expect(scanned).toBe(2);
  });

  test("O1 §2 named regression (transit is no longer deducted): a near-expiry request — the CLIENT cuts on time, and the NEXT request sees the documented `busy` interval while the daemon's scan runs on; never a claim of cancellation", async () => {
    const store = fakeStore();
    let scanStarted!: () => void;
    const started = new Promise<void>((r) => { scanStarted = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handle = await startVectorDaemon(store, () => {}, async () => { scanStarted(); await gate; return [{ hash_seq: "h_0", distance: 0 }]; });
    const t0 = monoNow();
    const cut = daemonVecMatch(store.dbPath, { query: "a", model: "m", limit: 5 }, dl(40));
    await started;
    expect((await cut).status).toBe("deadline");         // the client's own timer ended the leg (codex migration r1 S1: never `error`)
    expect(elapsed(t0)).toBeLessThan(200);                // ...on time
    // The daemon is still inside its uninterruptible scan (transit + one phase, documented):
    const next = await daemonVecMatch(store.dbPath, { query: "b", model: "m", limit: 5 }, dl(500));
    expect(next.status).toBe("busy");
    release();
    await new Promise(r => setTimeout(r, 20));
    const after = await daemonVecMatch(store.dbPath, { query: "c", model: "m", limit: 5 }, dl(500));
    expect(after.status).toBe("ok");
  });

  test("O1 §2 advisory deadline, check-AFTER the scan: a scan that outlives the transmitted budget answers `expired` — no projection, single-flight released", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => { await new Promise(r => setTimeout(r, 80)); return [{ hash_seq: "h_0", distance: 0 }]; });
    const sock = vecDaemonSocketPath(store.dbPath);
    const late = await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: 20 }) + "\n");
    expect(JSON.parse(late)).toEqual({ error: "expired" });
    const ok = await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: 2000 }) + "\n");
    expect(JSON.parse(ok)).toEqual({ results: [{ hash_seq: "h_0", distance: 0 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
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

  test("ping: answered without scanning, naming the DB path + owning pid (codex t76 readiness probe)", async () => {
    const store = fakeStore();
    let scans = 0;
    handle = await startVectorDaemon(store, () => {}, async () => { scans++; return []; });
    const line = await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ ping: true }) + "\n");
    expect(JSON.parse(line)).toEqual({ pong: true, db: store.dbPath, pid: process.pid, protocols: ["hydrated-v1", "deadline-rel-v1", "vf1"] }); // capability attestation (codex t84; O1 §4 activation)
    expect(scans).toBe(0);
    const pong = await daemonPing(store.dbPath, 1000);
    expect(pong).toEqual({ status: "ok", db: store.dbPath, pid: process.pid, protocols: ["hydrated-v1", "deadline-rel-v1", "vf1"] });
    // A ping-shaped frame that is NOT a ping is a normal (malformed) request.
    const notPing = await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ ping: "yes" }) + "\n");
    expect(JSON.parse(notPing)).toEqual({ error: "malformed" });
  });

  test("daemonPing: no socket → absent; a hung listener → error at the deadline", async () => {
    const store = fakeStore();
    expect(await daemonPing(store.dbPath, 200)).toEqual({ status: "absent" });
    // A STALE socket file (exists, nobody listens) is ABSENT too — the refusal
    // arrives before the connection ever opens, and must not read as an error.
    const stale = vecDaemonSocketPath(store.dbPath);
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "");
    try { expect(await daemonPing(store.dbPath, 500)).toEqual({ status: "absent" }); } finally { rmSync(stale, { force: true }); }
    // A pre-v0.38 daemon answers the ping frame with its exact `malformed`
    // refusal → "legacy" (live, unattested); any other reply is an error.
    const legacy = fakeServer(vecDaemonSocketPath(store.dbPath), (s) => { s.write(JSON.stringify({ error: "malformed" }) + "\n"); s.end(); });
    try { expect(await daemonPing(store.dbPath, 500)).toEqual({ status: "legacy" }); } finally { legacy.stop(); }
    const junk = fakeServer(vecDaemonSocketPath(store.dbPath), (s) => { s.write(JSON.stringify({ error: "malformed", extra: 1 }) + "\n"); s.end(); });
    try { expect(await daemonPing(store.dbPath, 500)).toEqual({ status: "error" }); } finally { junk.stop(); }
    const hung = fakeServer(vecDaemonSocketPath(store.dbPath), () => { /* never respond */ });
    try {
      const t0 = Date.now();
      expect(await daemonPing(store.dbPath, 150)).toEqual({ status: "error" });
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally { hung.stop(); }
  });

  test("a STALE socket file (no listener) is bound over — the watcher's daemon must start after a crash (latent Bun.connect data-handler bug, codex t76 arc)", async () => {
    const store = fakeStore();
    const sock = vecDaemonSocketPath(store.dbPath);
    mkdirSync(dirname(sock), { recursive: true });
    writeFileSync(sock, ""); // stale: a file at the socket path with nobody listening
    const logs: string[] = [];
    handle = await startVectorDaemon(store, m => logs.push(m), async () => [{ hash_seq: "h:0", distance: 0.1 }]);
    // Pre-fix: isSocketAlive threw synchronously ("Expected at least data or drain
    // callback"), the catch logged "socket dir prep failed", and startVectorDaemon
    // returned null — the daemon silently never bound after any stale socket.
    expect(handle).not.toBeNull();
    expect(logs.join("\n")).not.toContain("socket dir prep failed");
    expect(await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, dl(1000))).toEqual({ status: "ok", results: [{ hash_seq: "h:0", distance: 0.1 }], vectorFaults: 0 });
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
    const out = await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, dl(1000));
    expect(out.status).toBe("absent");
  });

  test("live daemon → {status:'ok'} carrying the hits", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => [{ hash_seq: "h_0", distance: 0.2 }]);
    const out = await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, dl(1000));
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
    const first = daemonVecMatch(store.dbPath, { query: "a", model: "m", limit: 5 }, dl(2000));
    await started;
    const second = await daemonVecMatch(store.dbPath, { query: "b", model: "m", limit: 5 }, dl(2000));
    expect(second.status).toBe("busy");
    release();
    await first;
  });

  test("zero remaining budget → {status:'deadline'} without re-running in-process (O1: `remainingForTimeout` is null — never a connection)", async () => {
    const store = fakeStore();
    handle = await startVectorDaemon(store, () => {}, async () => [{ hash_seq: "h_0", distance: 0 }]);
    const out = await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, dl(0));
    expect(out.status).toBe("deadline");
  });

  test("O1 §2 sub-millisecond remainder → the client takes the fallback LOCALLY: nothing is transmitted (a request the daemon must reject is never sent)", async () => {
    const store = fakeStore();
    let scans = 0;
    handle = await startVectorDaemon(store, () => {}, async () => { scans++; return [{ hash_seq: "h_0", distance: 0 }]; });
    const out = await daemonVecMatch(store.dbPath, { query: "q", model: "m", limit: 5 }, dl(0.4));
    expect(out.status).toBe("deadline"); // the window closed below one transmissible millisecond — the deadline won
    await new Promise(r => setTimeout(r, 30));
    expect(scans).toBe(0);
  });

  test("codex migration r1 P2: a HYDRATED request without remainingBudgetMs is bad_request BEFORE any scan — hydrated-v1 is served only under an enforced budget, so its attestation is never false", async () => {
    const store = fakeStore();
    let scans = 0;
    handle = await startVectorDaemon(store, () => {}, async () => { scans++; return []; });
    const hydratedNoBudget = { query: "q", model: "m", limit: 5, responseProtocol: "hydrated-v1", presentationQuery: "p", snippetLens: [300, 150], rerankTextLen: 2000, gateTextLen: 4000 };
    expect(JSON.parse(await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify(hydratedNoBudget) + "\n"))).toEqual({ error: "bad_request" });
    expect(scans).toBe(0);
    // The same request WITH a budget is served, and its header attests.
    const served = JSON.parse(await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ ...hydratedNoBudget, remainingBudgetMs: 2000 }) + "\n"));
    expect(served).toEqual({ protocol: "hydrated-v1", count: 0, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
    expect(scans).toBe(1);
  });

  test("codex migration r1 P3: the advisory deadline is anchored at FRAME RECEIPT — server-side decode/validation time is spent INSIDE the budget, never granted on top of it", async () => {
    const store = fakeStore();
    let scans = 0;
    handle = await startVectorDaemon(store, () => {}, async () => { scans++; return [{ hash_seq: "h_0", distance: 0 }]; });
    const sock = vecDaemonSocketPath(store.dbPath);
    process.env.CLAWMEM_TEST_VEC_REQUEST_DECODE_SYNC_DELAY_MS = "150";
    try {
      // 150 ms of server-side decode/validation against a 60 ms budget: anchored at receipt, the
      // window has closed before the scan — `expired`, never scanned. (Anchored after validation,
      // the daemon would grant a fresh 60 ms and scan.)
      expect(JSON.parse(await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: 60 }) + "\n", 3000))).toEqual({ error: "expired" });
      expect(scans).toBe(0);
      // A budget that covers the decode delay is served (the delay is spent, not fatal).
      expect(JSON.parse(await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: 2000 }) + "\n", 3000)))
        .toEqual({ results: [{ hash_seq: "h_0", distance: 0 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
      expect(scans).toBe(1);
    } finally {
      delete process.env.CLAWMEM_TEST_VEC_REQUEST_DECODE_SYNC_DELAY_MS;
    }
  });
});

describe("searchVecBounded routing + client failure modes", () => {
  let handle: VectorDaemonHandle | null = null;
  afterEach(() => { handle?.close(); handle = null; });

  test("onOutcome reports the classified path before any fallback (absent → in-process; ok → daemon)", async () => {
    const store = fakeStore();
    let inproc = 0;
    (store as unknown as { db: unknown }).db = {};
    stubSearchVec(store, async () => { inproc++; return []; });
    const seen: string[] = [];
    await searchVecBounded(store, "q", "m", 5, undefined, undefined, undefined, undefined, s => seen.push(s));
    expect(seen).toEqual(["absent"]);
    expect(inproc).toBe(1);
    // daemon-required NEVER runs the in-process scan on absent — [] + "absent" recorded.
    const seen2: string[] = [];
    const r = await searchVecDaemonRequired(store, "q", "m", 5, undefined, undefined, undefined, undefined, s => seen2.push(s));
    expect(r).toEqual([]);
    expect(seen2).toEqual(["absent"]);
    expect(inproc).toBe(1);
  });

  test("no daemon → routes to the in-process store.searchVec", async () => {
    const sentinel = [{ filepath: "clawmem://c/x.md", score: 0.9 }] as unknown as Awaited<ReturnType<typeof searchVecBounded>>;
    let called = false;
    const store = { dbPath: `/tmp/vd-test-${process.pid}-${seq++}.sqlite` } as unknown as Store;
    stubSearchVec(store, async () => { called = true; return sentinel as never; });
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
      const out = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, dl(1000));
      expect(out.status).toBe("error");
    } finally { srv.stop(); }
  });

  test("daemon closes without responding → {status:'error'}", async () => {
    const dbPath = `/tmp/vd-test-${process.pid}-${seq++}.sqlite`;
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.end(); });
    try {
      const out = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, dl(1000));
      expect(out.status).toBe("error");
    } finally { srv.stop(); }
  });

  test("hung daemon (no response) → {status:'deadline'} at the IPC deadline — the client's timer, never a daemon `error` (codex migration r1 S1)", async () => {
    const dbPath = `/tmp/vd-test-${process.pid}-${seq++}.sqlite`;
    const srv = fakeServer(vecDaemonSocketPath(dbPath), () => { /* receive, never respond */ });
    try {
      const out = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, dl(200));
      expect(out.status).toBe("deadline");
    } finally { srv.stop(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hydrated-v1 wire protocol (codex #28 t86–t88): exact-constant validation,
// byte-accurate framing (UTF-8 bytes, never UTF-16 units), strict decoding
// (invalid UTF-8 fails closed), the incremental yielding client pump with its
// per-entry deadline checks, and the negotiation matrix's raw-hit fallback.
// ─────────────────────────────────────────────────────────────────────────────
import { daemonVecMatch as dvm } from "../../src/vector-daemon.ts";
import { createStore as mkStore, DEFAULT_EMBED_MODEL as EMBED_MODEL } from "../../src/store.ts";
import { seedDocuments as seedDocs } from "../helpers/test-store.ts";
import { HYDRATED_PROTOCOL, HYDRATED_SNIPPET_LENS, HYDRATED_RERANK_TEXT_LEN, HYDRATED_GATE_TEXT_LEN, HYDRATED_MAX_ENTRY_BYTES } from "../../src/vector-protocol.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

describe("hydrated-v1 wire protocol (codex #28 t86–t88)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best-effort */ } } });

  /** Send one framed payload (string or raw bytes), collect ALL response lines until close. */
  function rawRequestAll(sockPath: string, payload: string | Uint8Array, timeoutMs = 5000): Promise<string[]> {
    return new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("rawRequestAll timeout")), timeoutMs);
      Bun.connect<undefined>({
        unix: sockPath,
        socket: {
          open(s) { try { s.write(payload as never); } catch (e) { clearTimeout(timer); reject(e as Error); } },
          data(_s, d) { buf += d.toString(); },
          close() { clearTimeout(timer); resolve(buf.split("\n").filter(Boolean)); },
          error(_s, e) { clearTimeout(timer); reject(e); },
          connectError(_s, e) { clearTimeout(timer); reject(e); },
        },
      }).catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  const hydratedReqLine = (extra: Record<string, unknown> = {}): string => JSON.stringify({
    query: "q", model: EMBED_MODEL, limit: 5, responseProtocol: HYDRATED_PROTOCOL, presentationQuery: "the OAuth rotation query",
    snippetLens: [...HYDRATED_SNIPPET_LENS], rerankTextLen: HYDRATED_RERANK_TEXT_LEN, gateTextLen: HYDRATED_GATE_TEXT_LEN,
    remainingBudgetMs: 2000, // codex migration r1 P2: hydrated-v1 requires an enforced budget — the defect under test must be the ONLY one
    ...extra,
  }) + "\n";

  /** A COMPLETE, validator-passing projected entry (t89 S1) — override fields per test. */
  const makeEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    projected: true, filepath: "clawmem://t/a.md", displayPath: "t/a.md", title: "A doc",
    hash: "abcdef1234", docid: "abcdef", collectionName: "t", modifiedAt: "2026-01-01T00:00:00.000Z",
    bodyLength: 10, context: null, score: 0.5, source: "vec", chunkPos: 0,
    snippets: { 300: "s3", 150: "s1" }, rerankText: "r", noise: false, hasBody: true,
    gateTokens: ["alpha"], sanitizeFiltered: false, ...over,
  });

  test("round trip on a REAL store: header/count + projected entry (non-ASCII bodyLength stays UTF-16) + end line", async () => {
    const dir = mkdtempSync(pjoin(tmpdir(), "vd-hyd-"));
    const store = mkStore(pjoin(dir, "s.sqlite"));
    cleanups.push(() => store.close());
    store.ensureVecTable(4);
    const body = "# Notes\n" + "The OAuth refresh token rotation decision for the auth service. ".repeat(8) + "žluťoučký kůň 認証 ";
    seedDocs(store, [{ path: "memory/n.md", title: "Notes žluť", body, contentType: "note", confidence: 0.7, qualityScore: 0.7 }]);
    const row = store.db.prepare(`SELECT hash FROM documents WHERE path = ? AND active = 1`).get("memory/n.md") as { hash: string };
    store.insertEmbedding(row.hash, 0, 0, new Float32Array([1, 0, 0, 0]), EMBED_MODEL, new Date().toISOString());
    const h = await startVectorDaemon(store, () => {}, async () => [{ hash_seq: `${row.hash}_0`, distance: 0.2 }]);
    cleanups.push(() => h?.close());
    const lines = await rawRequestAll(vecDaemonSocketPath(store.dbPath), hydratedReqLine());
    expect(lines.length).toBe(3);
    const header = JSON.parse(lines[0]!);
    expect(header).toEqual({ protocol: HYDRATED_PROTOCOL, count: 1, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
    const entry = JSON.parse(lines[1]!).entry;
    expect(entry.projected).toBe(true);
    expect(entry.bodyLength).toBe(body.length);                       // UTF-16 code units (t87 F3)
    expect(Buffer.byteLength(body, "utf-8")).not.toBe(body.length);   // the fixture is genuinely multibyte
    expect(entry.rerankText).toBe(body.slice(0, HYDRATED_RERANK_TEXT_LEN));
    expect(Object.keys(entry.snippets).map(Number).sort((a, b) => b - a)).toEqual([...HYDRATED_SNIPPET_LENS]);
    expect(entry.hasBody).toBe(true);
    expect(new Set(entry.gateTokens).size).toBe(entry.gateTokens.length); // deduped
    expect(JSON.parse(lines[2]!)).toEqual({ end: true });
  });

  test("exact-constant validation (t87 F1): wrong snippetLens or a missing presentationQuery is bad_request, never a divergent projection", async () => {
    const store = fakeStore();
    let scans = 0;
    const h = await startVectorDaemon(store, () => {}, async () => { scans++; return []; });
    cleanups.push(() => h?.close());
    const sock = vecDaemonSocketPath(store.dbPath);
    expect(JSON.parse(await rawRequest(sock, hydratedReqLine({ snippetLens: [301, 150] })))).toEqual({ error: "bad_request" });
    expect(JSON.parse(await rawRequest(sock, hydratedReqLine({ rerankTextLen: 1999 })))).toEqual({ error: "bad_request" });
    const noPresentation = JSON.parse(hydratedReqLine());
    delete noPresentation.presentationQuery;
    expect(JSON.parse(await rawRequest(sock, JSON.stringify(noPresentation) + "\n"))).toEqual({ error: "bad_request" });
    expect(scans).toBe(0); // refused BEFORE any scan
  });

  test("invalid UTF-8 in the REQUEST is refused fail-closed (t87 CR-6): bad_request, never U+FFFD-substituted", async () => {
    const store = fakeStore();
    const h = await startVectorDaemon(store, () => {}, async () => []);
    cleanups.push(() => h?.close());
    const enc = new TextEncoder();
    const head = enc.encode('{"query":"');
    const tail = enc.encode('","model":"m","limit":5}\n');
    const payload = new Uint8Array(head.length + 1 + tail.length);
    payload.set(head, 0); payload[head.length] = 0xff; payload.set(tail, head.length + 1);
    const lines = await rawRequestAll(vecDaemonSocketPath(store.dbPath), payload);
    expect(lines).toEqual([JSON.stringify({ error: "bad_request" })]);
  });

  test("O1 §4 supersedes the t84 raw-hit negotiation: a LEGACY daemon answering RAW hits WITHOUT the deadline attestation → `skew` (FTS), never ok — it ran under no deadline", async () => {
    const sock = vecDaemonSocketPath(`/tmp/vd-legacy-${process.pid}.sqlite`);
    const srv = fakeServer(sock, (s) => { s.write(JSON.stringify({ results: [{ hash_seq: "h_0", distance: 0.5 }] }) + "\n"); s.end(); });
    cleanups.push(() => srv.stop());
    const oc = await dvm(`/tmp/vd-legacy-${process.pid}.sqlite`, JSON.parse(hydratedReqLine()), dl(2000));
    expect(oc.status).toBe("skew");
    // The same raw answer WITH the attestation is STILL not an answer to a HYDRATED request (codex migration r2 #1):
    // a deadline attestation does not establish projection capability, and accepting it would hydrate
    // synchronously on the hook's event loop. Capability skew — named — never ok.
    const sock2 = vecDaemonSocketPath(`/tmp/vd-legacy2-${process.pid}.sqlite`);
    const srv2 = fakeServer(sock2, (s) => { s.write(JSON.stringify({ results: [{ hash_seq: "h_0", distance: 0.5 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n"); s.end(); });
    cleanups.push(() => srv2.stop());
    const oc2 = await dvm(`/tmp/vd-legacy2-${process.pid}.sqlite`, JSON.parse(hydratedReqLine()), dl(2000));
    expect(oc2).toEqual({ status: "skew", missing: HYDRATED_PROTOCOL });
    // …whereas an attested raw answer to a RAW request is the legitimate raw-hit path: ok + hits.
    const sock3 = vecDaemonSocketPath(`/tmp/vd-legacy3-${process.pid}.sqlite`);
    const srv3 = fakeServer(sock3, (s) => { s.write(JSON.stringify({ results: [{ hash_seq: "h_0", distance: 0.5 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n"); s.end(); });
    cleanups.push(() => srv3.stop());
    const oc3 = await dvm(`/tmp/vd-legacy3-${process.pid}.sqlite`, { query: "q", model: "m", limit: 5 } as never, dl(2000));
    expect(oc3.status).toBe("ok");
    expect((oc3 as { results: unknown[] }).results).toEqual([{ hash_seq: "h_0", distance: 0.5 }]);
  });

  test("codex migration r2 #1 at the PRODUCTION search path: a hydrated leg answered with attested RAW hits returns [] as `skew` — client-side hydration never runs", async () => {
    const dbPath = `/tmp/vd-r2p1-${process.pid}.sqlite`;
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write(JSON.stringify({ results: [{ hash_seq: "h_0", distance: 0.5 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n"); s.end(); });
    cleanups.push(() => srv.stop());
    let dbTouched = 0;
    const store = { dbPath, get db() { dbTouched++; throw new Error("client-side hydration must not touch the store"); } } as unknown as Store;
    const seen: string[] = [];
    const errSpy = console.error;
    console.error = () => {}; // the once-per-process skew warning
    try {
      const bounded = await searchVecBounded(store, "q", "m", 5, undefined, undefined, undefined, dl(2000), s => seen.push(s), { presentationQuery: "p" });
      const required = await searchVecDaemonRequired(store, "q", "m", 5, undefined, undefined, undefined, dl(2000), s => seen.push(s), { presentationQuery: "p" });
      expect(bounded).toEqual([]);
      expect(required).toEqual([]);
      expect(seen).toEqual(["skew", "skew"]);
      expect(dbTouched).toBe(0); // pre-fix: `ok` → hydrateVecResults(store.db, …) on the hook's loop
    } finally { console.error = errSpy; }
  });

  test("O1 §4: a hydrated header WITHOUT the deadline attestation (pre-O1 daemon) → `skew`, entries never parsed", async () => {
    const dbPath = `/tmp/vd-legacyhdr-${process.pid}.sqlite`;
    const lines = JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: 1 }) + "\n" + JSON.stringify({ entry: makeEntry() }) + "\n" + JSON.stringify({ end: true }) + "\n";
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write(lines); s.end(); });
    cleanups.push(() => srv.stop());
    expect((await dvm(dbPath, JSON.parse(hydratedReqLine()), dl(2000))).status).toBe("skew");
  });

  test("O1 §2: the client transmits `remainingBudgetMs` — an integer in [1, MAX], sampled at write time — and NEVER a `deadlineMs`", async () => {
    const dbPath = `/tmp/vd-wire-${process.pid}.sqlite`;
    const sock = vecDaemonSocketPath(dbPath);
    mkdirSync(dirname(sock), { recursive: true });
    if (existsSync(sock)) rmSync(sock, { force: true });
    let seen: Record<string, unknown> | null = null;
    const srv = Bun.listen<{ buf: string }>({
      unix: sock,
      socket: {
        open(s) { s.data = { buf: "" }; },
        data(s, chunk) {
          s.data.buf += chunk.toString();
          const nl = s.data.buf.indexOf("\n");
          if (nl < 0) return;
          seen = JSON.parse(s.data.buf.slice(0, nl)) as Record<string, unknown>;
          s.write(JSON.stringify({ results: [], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n"); s.end();
        },
      },
    });
    cleanups.push(() => { try { srv.stop(true); } catch { /* stopped */ } try { rmSync(sock, { force: true }); } catch { /* best-effort */ } });
    const oc = await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 }, dl(1500));
    expect(oc.status).toBe("ok");
    const wire = seen as Record<string, unknown> | null;
    expect(wire).not.toBeNull();
    expect("deadlineMs" in wire!).toBe(false);
    const budget = wire!.remainingBudgetMs;
    expect(Number.isInteger(budget)).toBe(true);
    expect(budget as number).toBeGreaterThanOrEqual(1);
    expect(budget as number).toBeLessThanOrEqual(1500);
  });

  test("byte-accurate framing (t87 F3): a code point SPLIT across socket chunks decodes correctly", async () => {
    const dbPath = `/tmp/vd-split-${process.pid}.sqlite`;
    const sock = vecDaemonSocketPath(dbPath);
    const enc = new TextEncoder();
    const entryLine = JSON.stringify({ entry: makeEntry({ title: "žluťoučký kůň 認証" }) });
    const full = enc.encode(JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: 1, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" + entryLine + "\n" + JSON.stringify({ end: true }) + "\n");
    // Split INSIDE the multibyte title (find a byte >= 0x80 and cut mid-sequence).
    let cut = -1;
    for (let i = 0; i < full.length - 1; i++) { if (full[i]! >= 0xc0 && full[i + 1]! >= 0x80) { cut = i + 1; break; } }
    expect(cut).toBeGreaterThan(0);
    const srv = fakeServer(sock, (s) => {
      s.write(full.subarray(0, cut) as never);
      setTimeout(() => { try { s.write(full.subarray(cut) as never); s.end(); } catch { /* closed */ } }, 20);
    });
    cleanups.push(() => srv.stop());
    const oc = await dvm(dbPath, JSON.parse(hydratedReqLine()), dl(3000));
    expect(oc.status).toBe("ok-hydrated");
    expect((oc as { results: { title: string }[] }).results[0]!.title).toBe("žluťoučký kůň 認証");
  });

  test("invalid UTF-8 in a RESPONSE line → error, never substituted (t87 CR-6)", async () => {
    const dbPath = `/tmp/vd-badutf-${process.pid}.sqlite`;
    const sock = vecDaemonSocketPath(dbPath);
    const enc = new TextEncoder();
    const head = enc.encode(JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: 1, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" + '{"entry":{"title":"');
    const tail = enc.encode('"}}\n' + JSON.stringify({ end: true }) + "\n");
    const payload = new Uint8Array(head.length + 1 + tail.length);
    payload.set(head, 0); payload[head.length] = 0xff; payload.set(tail, head.length + 1);
    const srv = fakeServer(sock, (s) => { s.write(payload as never); s.end(); });
    cleanups.push(() => srv.stop());
    const oc = await dvm(dbPath, JSON.parse(hydratedReqLine()), dl(2000));
    expect(oc.status).toBe("error");
  });

  test("byte cap, not char cap (t87 F3): a line under the cap in UTF-16 units but over it in UTF-8 bytes is rejected pre-parse; the same char count in ASCII passes", async () => {
    const mkLines = (fat: string): string =>
      JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: 1, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" +
      JSON.stringify({ entry: makeEntry({ rerankText: fat }) }) + "\n" +
      JSON.stringify({ end: true }) + "\n";
    // ~30k CJK chars ≈ 90 KB UTF-8 (> 64 KiB entry cap) but only ~30k UTF-16 units.
    const cjk = "認".repeat(30_000);
    expect(cjk.length * 3).toBeGreaterThan(HYDRATED_MAX_ENTRY_BYTES);
    const dbBad = `/tmp/vd-bcap-${process.pid}.sqlite`;
    const srvBad = fakeServer(vecDaemonSocketPath(dbBad), (s) => { s.write(mkLines(cjk)); s.end(); });
    cleanups.push(() => srvBad.stop());
    expect((await dvm(dbBad, JSON.parse(hydratedReqLine()), dl(3000))).status).toBe("error");
    const ascii = "a".repeat(30_000); // same char count, ~30 KB — under the byte cap
    const dbOk = `/tmp/vd-bcap-ok-${process.pid}.sqlite`;
    const srvOk = fakeServer(vecDaemonSocketPath(dbOk), (s) => { s.write(mkLines(ascii)); s.end(); });
    cleanups.push(() => srvOk.stop());
    expect((await dvm(dbOk, JSON.parse(hydratedReqLine()), dl(3000))).status).toBe("ok-hydrated");
  });

  test("client maps the daemon's oversized refusal to the DISTINCT oversized outcome (t84)", async () => {
    const dbPath = `/tmp/vd-over-${process.pid}.sqlite`;
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write(JSON.stringify({ error: "oversized" }) + "\n"); s.end(); });
    cleanups.push(() => srv.stop());
    expect((await dvm(dbPath, JSON.parse(hydratedReqLine()), dl(2000))).status).toBe("oversized");
  });

  test("t88 lock (a): an inter-entry (async) stall lets the deadline WIN — later entries are never parsed", async () => {
    const dbPath = `/tmp/vd-inter-${process.pid}.sqlite`;
    const lines =
      JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: 3, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" +
      JSON.stringify({ entry: makeEntry({ docid: "e1" }) }) + "\n" +
      JSON.stringify({ entry: makeEntry({ docid: "e2" }) }) + "\n" +
      JSON.stringify({ entry: makeEntry({ docid: "e3" }) }) + "\n" +
      JSON.stringify({ end: true }) + "\n";
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write(lines); s.end(); });
    cleanups.push(() => srv.stop());
    const errSpy: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errSpy.push(a.join(" ")); };
    process.env.CLAWMEM_TEST_VEC_INTER_ENTRY_ASYNC_DELAY_MS = "300";
    process.env.CLAWMEM_TEST_VEC_PARSE_TRACE = "1";
    try {
      const oc = await dvm(dbPath, JSON.parse(hydratedReqLine()), dl(200));
      expect(oc.status).toBe("deadline"); // the deadline WON (codex migration r1 S1) — never a late ok
      // Only the FIRST line (the header) was parsed before the stall crossed the
      // deadline — the remaining entries were cancelled mid-stream.
      expect(errSpy.filter(l => l.includes("[vec-parse]")).length).toBeLessThanOrEqual(1);
    } finally {
      console.error = origErr;
      delete process.env.CLAWMEM_TEST_VEC_INTER_ENTRY_ASYNC_DELAY_MS;
      delete process.env.CLAWMEM_TEST_VEC_PARSE_TRACE;
    }
  });

  test("t88 lock (c): maximum-size (near-64KiB) entries with NO synthetic stall parse incrementally and the leg ADHERES", async () => {
    const dbPath = `/tmp/vd-max-${process.pid}.sqlite`;
    const fat = "a".repeat(60_000); // entry line ≈ 60 KB < 64 KiB cap
    const lines =
      JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: 3, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" +
      JSON.stringify({ entry: makeEntry({ docid: "m1", rerankText: fat }) }) + "\n" +
      JSON.stringify({ entry: makeEntry({ docid: "m2", rerankText: fat }) }) + "\n" +
      JSON.stringify({ entry: makeEntry({ docid: "m3", rerankText: fat }) }) + "\n" +
      JSON.stringify({ end: true }) + "\n";
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write(lines); s.end(); });
    cleanups.push(() => srv.stop());
    const t0 = monoNow();
    const oc = await dvm(dbPath, JSON.parse(hydratedReqLine()), dl(3000));
    expect(oc.status).toBe("ok-hydrated");
    expect((oc as { results: unknown[] }).results.length).toBe(3);
    expect(elapsed(t0)).toBeLessThan(3000); // adhered with room to spare (monotonic, O1)
  });

  test("hydrated state machine fails closed on a count mismatch (end before all entries)", async () => {
    const dbPath = `/tmp/vd-count-${process.pid}.sqlite`;
    const lines =
      JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: 2, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" +
      JSON.stringify({ entry: makeEntry() }) + "\n" +
      JSON.stringify({ end: true }) + "\n";
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write(lines); s.end(); });
    cleanups.push(() => srv.stop());
    expect((await dvm(dbPath, JSON.parse(hydratedReqLine()), dl(2000))).status).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// t89 remedies: strict wire validation (S1), refused hydrated limits (P3),
// post-scan expiry (P4), byte-accurate ping (S2), health authority tiers (P1).
// ─────────────────────────────────────────────────────────────────────────────
import { vectorDaemonHealth as vdHealth } from "../../src/vector-daemon.ts";

describe("t89 remedies", () => {
  const cleanups2: (() => void)[] = [];
  afterEach(() => { while (cleanups2.length) { try { cleanups2.pop()!(); } catch { /* best-effort */ } } });

  const req = (extra: Record<string, unknown> = {}): Record<string, unknown> => JSON.parse(JSON.stringify({
    query: "q", model: "m", limit: 5, responseProtocol: "hydrated-v1", presentationQuery: "p",
    snippetLens: [300, 150], rerankTextLen: 2000, gateTextLen: 4000,
    remainingBudgetMs: 2000, // codex migration r1 P2: a valid budget, so each refusal below has exactly one cause
    ...extra,
  }));
  const entryOk = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    projected: true, filepath: "clawmem://t/a.md", displayPath: "t/a.md", title: "A",
    hash: "abcdef1234", docid: "abcdef", collectionName: "t", modifiedAt: "2026-01-01T00:00:00.000Z",
    bodyLength: 10, context: null, score: 0.5, source: "vec", chunkPos: 0,
    snippets: { 300: "s3", 150: "s1" }, rerankText: "r", noise: false, hasBody: true,
    gateTokens: ["alpha"], sanitizeFiltered: false, ...over,
  });
  const serveLines = (dbPath: string, lines: string): void => {
    const srv = fakeServer(vecDaemonSocketPath(dbPath), (s) => { s.write(lines); s.end(); });
    cleanups2.push(() => srv.stop());
  };

  test("S1: a malformed RAW hit list is never ok — degrades to error/FTS", async () => {
    const dbPath = `/tmp/vd-s1raw-${process.pid}.sqlite`;
    serveLines(dbPath, JSON.stringify({ results: [{ hash_seq: 7, distance: "x" }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n");
    // A RAW request: the hit-list validation guards the raw-hit path. (To a HYDRATED request any raw answer is
    // refused earlier, as capability skew — codex migration r2 #1.)
    expect((await daemonVecMatch(dbPath, { query: "q", model: "m", limit: 5 } as never, dl(2000))).status).toBe("error");
  });

  test("S1: a hydrated entry missing a required field is never ok-hydrated", async () => {
    const dbPath = `/tmp/vd-s1ent-${process.pid}.sqlite`;
    const bad = entryOk(); delete bad.rerankText;
    serveLines(dbPath,
      JSON.stringify({ protocol: "hydrated-v1", count: 1, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" +
      JSON.stringify({ entry: bad }) + "\n" +
      JSON.stringify({ end: true }) + "\n");
    expect((await daemonVecMatch(dbPath, req() as never, dl(2000))).status).toBe("error");
  });

  test("S1: a hydrated entry with a wrong-typed field (bodyLength string) is never ok-hydrated", async () => {
    const dbPath = `/tmp/vd-s1typ-${process.pid}.sqlite`;
    serveLines(dbPath,
      JSON.stringify({ protocol: "hydrated-v1", count: 1, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" +
      JSON.stringify({ entry: entryOk({ bodyLength: "10" }) }) + "\n" +
      JSON.stringify({ end: true }) + "\n");
    expect((await daemonVecMatch(dbPath, req() as never, dl(2000))).status).toBe("error");
  });

  test("S1: a fractional header count is a malformed peer — error", async () => {
    const dbPath = `/tmp/vd-s1cnt-${process.pid}.sqlite`;
    serveLines(dbPath,
      JSON.stringify({ protocol: "hydrated-v1", count: 1.5, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }) + "\n" +
      JSON.stringify({ entry: entryOk() }) + "\n" +
      JSON.stringify({ end: true }) + "\n");
    expect((await daemonVecMatch(dbPath, req() as never, dl(2000))).status).toBe("error");
  });

  test("S1(server): malformed optional shapes (dateRange, collections) → bad_request before any scan", async () => {
    const store = fakeStore();
    let scans = 0;
    const h = await startVectorDaemon(store, () => {}, async () => { scans++; return []; });
    cleanups2.push(() => h?.close());
    const sock = vecDaemonSocketPath(store.dbPath);
    expect(JSON.parse(await rawRequest(sock, JSON.stringify(req({ dateRange: { start: 5 } })) + "\n"))).toEqual({ error: "bad_request" });
    expect(JSON.parse(await rawRequest(sock, JSON.stringify(req({ collections: ["a", 3] })) + "\n"))).toEqual({ error: "bad_request" });
    expect(JSON.parse(await rawRequest(sock, JSON.stringify(req({ intent: 9 })) + "\n"))).toEqual({ error: "bad_request" });
    expect(scans).toBe(0);
  });

  test("P3: a hydrated limit outside integer [1,16] → bad_request before any scan; 16 is served", async () => {
    const store = fakeStore();
    let scans = 0;
    const h = await startVectorDaemon(store, () => {}, async () => { scans++; return []; });
    cleanups2.push(() => h?.close());
    const sock = vecDaemonSocketPath(store.dbPath);
    for (const limit of [0, 17, 2.5, -1]) {
      expect(JSON.parse(await rawRequest(sock, JSON.stringify(req({ limit })) + "\n"))).toEqual({ error: "bad_request" });
    }
    expect(scans).toBe(0);
    const okLine = await rawRequest(sock, JSON.stringify(req({ limit: 16 })) + "\n");
    expect(JSON.parse(okLine)).toEqual({ protocol: "hydrated-v1", count: 0, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
    expect(scans).toBe(1);
  });

  test("P4: an expired HYDRATED request performs ZERO projection/body work — `expired` before projection, single-flight released", async () => {
    // fakeStore has NO db: if the expiry check were moved below the projection, the
    // projectVecResults call would throw on the missing db and this response would be
    // `internal: …` instead of `expired` — the boundary is proven without a seam.
    const store = fakeStore();
    const h = await startVectorDaemon(store, () => {}, async () => { await new Promise(r => setTimeout(r, 150)); return [{ hash_seq: "h_0", distance: 0 }]; });
    cleanups2.push(() => h?.close());
    const sock = vecDaemonSocketPath(store.dbPath);
    const first = JSON.parse(await rawRequest(sock, JSON.stringify(req({ remainingBudgetMs: 60 })) + "\n", 3000));
    expect(first).toEqual({ error: "expired" });
    // Immediately after: NOT busy — the expired answer released single-flight; a raw
    // request (no projection, no budget) is served normally — and UNATTESTED (codex migration r1 P2).
    const second = JSON.parse(await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5 }) + "\n", 3000));
    expect(second).toEqual({ results: [{ hash_seq: "h_0", distance: 0 }], vectorFaultProtocol: "vf1" });
  });

  test("t90 S1 (O1): a malformed remainingBudgetMs (string) is refused as malformed on BOTH raw and hydrated requests — it never reaches the scan; a `deadlineMs` of any shape is version_skew", async () => {
    const store = fakeStore();
    let scans = 0;
    const h = await startVectorDaemon(store, () => {}, async () => { scans++; return []; });
    cleanups2.push(() => h?.close());
    const sock = vecDaemonSocketPath(store.dbPath);
    expect(JSON.parse(await rawRequest(sock, JSON.stringify({ query: "q", model: "m", limit: 5, remainingBudgetMs: "soon" }) + "\n"))).toEqual({ error: "malformed" });
    expect(JSON.parse(await rawRequest(sock, JSON.stringify(req({ remainingBudgetMs: "soon" })) + "\n"))).toEqual({ error: "malformed" });
    expect(JSON.parse(await rawRequest(sock, JSON.stringify(req({ deadlineMs: "soon" })) + "\n"))).toEqual({ error: "version_skew" });
    expect(scans).toBe(0);
  });

  test("t90 S1: a malformed pong (non-string protocols entry, or fractional pid) is a malformed peer — daemonPing errors, never coerces", async () => {
    const dbPath = `/tmp/vd-badpong-${process.pid}.sqlite`;
    const sock = vecDaemonSocketPath(dbPath);
    const bad1 = fakeServer(sock, (s) => { s.write(JSON.stringify({ pong: true, db: dbPath, pid: 7, protocols: ["hydrated-v1", 9] }) + "\n"); s.end(); });
    const r1 = await daemonPing(dbPath, 2000);
    bad1.stop();
    expect(r1.status).toBe("error");
    const bad2 = fakeServer(sock, (s) => { s.write(JSON.stringify({ pong: true, db: dbPath, pid: 7.5 }) + "\n"); s.end(); });
    const r2 = await daemonPing(dbPath, 2000);
    bad2.stop();
    expect(r2.status).toBe("error");
    // t91: an IMPOSSIBLE owner pid (0 or negative) must never certify attestation.
    const bad3 = fakeServer(sock, (s) => { s.write(JSON.stringify({ pong: true, db: dbPath, pid: 0, protocols: ["hydrated-v1"] }) + "\n"); s.end(); });
    const r3 = await daemonPing(dbPath, 2000);
    bad3.stop();
    expect(r3.status).toBe("error");
    const bad4 = fakeServer(sock, (s) => { s.write(JSON.stringify({ pong: true, db: dbPath, pid: -5, protocols: ["hydrated-v1"] }) + "\n"); s.end(); });
    cleanups2.push(() => bad4.stop());
    expect((await daemonPing(dbPath, 2000)).status).toBe("error");
  });

  test("S2: a multibyte pong (db path) SPLIT across chunks decodes correctly; invalid UTF-8 in a pong is refused", async () => {
    const dbPath = `/tmp/vd-ping-{žluť認証}-${process.pid}.sqlite`;
    const sock = vecDaemonSocketPath(dbPath);
    const enc = new TextEncoder();
    const pongBytes = enc.encode(JSON.stringify({ pong: true, db: dbPath, pid: 4242, protocols: ["hydrated-v1"] }) + "\n");
    let cut = -1;
    for (let i = 0; i < pongBytes.length - 1; i++) { if (pongBytes[i]! >= 0xc0 && pongBytes[i + 1]! >= 0x80) { cut = i + 1; break; } }
    expect(cut).toBeGreaterThan(0);
    const srv = fakeServer(sock, (s) => {
      s.write(pongBytes.subarray(0, cut) as never);
      setTimeout(() => { try { s.write(pongBytes.subarray(cut) as never); s.end(); } catch { /* closed */ } }, 20);
    });
    const pong = await daemonPing(dbPath, 3000);
    srv.stop();
    expect(pong).toEqual({ status: "ok", db: dbPath, pid: 4242, protocols: ["hydrated-v1"] });
    // Invalid UTF-8 pong → error (fail-closed), never a replacement-decoded identity.
    const head = enc.encode('{"pong":true,"db":"');
    const tail = enc.encode(`","pid":1}\n`);
    const badBytes = new Uint8Array(head.length + 1 + tail.length);
    badBytes.set(head, 0); badBytes[head.length] = 0xff; badBytes.set(tail, head.length + 1);
    const srv2 = fakeServer(sock, (s) => { s.write(badBytes as never); s.end(); });
    cleanups2.push(() => srv2.stop());
    expect((await daemonPing(dbPath, 2000)).status).toBe("error");
  });

  test("P1 + O1 §4: an attested pong WITHOUT hydrated-v1 → live-raw; WITH hydrated-v1 but WITHOUT deadline-rel-v1 → still live-raw; WITH both → live", async () => {
    const dbPath = `/tmp/vd-health-${process.pid}.sqlite`;
    const sock = vecDaemonSocketPath(dbPath);
    const raw = fakeServer(sock, (s) => { s.write(JSON.stringify({ pong: true, db: dbPath, pid: 77 }) + "\n"); s.end(); });
    const hRaw = await vdHealth(dbPath, 2000);
    raw.stop();
    expect(hRaw.status).toBe("live-raw");
    const hydratedOnly = fakeServer(sock, (s) => { s.write(JSON.stringify({ pong: true, db: dbPath, pid: 77, protocols: ["hydrated-v1"] }) + "\n"); s.end(); });
    const hHydrated = await vdHealth(dbPath, 2000);
    hydratedOnly.stop();
    expect(hHydrated.status).toBe("live-raw"); // a daemon that ignores the relative budget is not the certified contract
    const full = fakeServer(sock, (s) => { s.write(JSON.stringify({ pong: true, db: dbPath, pid: 77, protocols: ["hydrated-v1", "deadline-rel-v1", "vf1"] }) + "\n"); s.end(); });
    cleanups2.push(() => full.stop());
    expect((await vdHealth(dbPath, 2000)).status).toBe("live");
  });
});
