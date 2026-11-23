/**
 * BACKLOG 82.2, D4 — the vector-fault protocol (`vf1`) on the daemon wire. Every scan answer of a current daemon
 * attests that it screened the returned distances and carries the count of rows it dropped; an answer without the
 * attestation is capability skew (the count is unknown, never zero); a query vector the daemon's own embedding
 * refused travels as a typed `vec_poison` frame and comes back as the same error the in-process path throws.
 * On v0.43.6 none of the fields exists: a faulty distance is sent as a hit, and a refused query is `internal: …`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { stubSearchVec } from "../helpers/vec-stub.ts";
import {
  startVectorDaemon, vecDaemonSocketPath, daemonVecMatch, daemonPing, vectorDaemonHealth, searchVecBounded, searchVecDaemonRequired,
  vecPoisonFrame, vecPoisonFromFrame, type VecExecStatus,
} from "../../src/vector-daemon.ts";
import { createStore, type Store } from "../../src/store.ts";
import { VecPoisonError, EmbedEnvelopeError } from "../../src/vector-guard.ts";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { DEADLINE_PROTOCOL, HYDRATED_PROTOCOL, HYDRATED_SNIPPET_LENS, HYDRATED_RERANK_TEXT_LEN, HYDRATED_GATE_TEXT_LEN, VECTOR_FAULT_PROTOCOL } from "../../src/vector-protocol.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const dl = (ms: number) => deadlineAfter(monoNow(), duration(ms));
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best-effort */ } } });

let seq = 0;
const dbPathFor = (tag: string) => `/tmp/vd-fault-${tag}-${process.pid}-${seq++}.sqlite`;
/** A store that is only a path, plus a spy on the in-process search (which a skewed leg must never run). */
function fakeStore(tag: string): { store: Store; inProcess: { calls: number } } {
  const inProcess = { calls: 0 };
  const store = { dbPath: dbPathFor(tag) } as unknown as Store;
  stubSearchVec(store, async () => { inProcess.calls++; return []; });
  return { store, inProcess };
}

function rawRequest(sockPath: string, payload: string, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("rawRequest timeout")), timeoutMs);
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) { s.write(payload); },
        data(_s, d) { buf += d.toString(); },
        close() { clearTimeout(timer); resolve(buf.split("\n").filter(Boolean)); },
        error(_s, e) { clearTimeout(timer); reject(e); },
        connectError(_s, e) { clearTimeout(timer); reject(e); },
      },
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

/** A fake daemon that answers every request with the given lines. */
function serve(dbPath: string, lines: unknown[]): void {
  const sock = vecDaemonSocketPath(dbPath);
  mkdirSync(dirname(sock), { recursive: true });
  if (existsSync(sock)) rmSync(sock, { force: true });
  const srv = Bun.listen<{ buf: string }>({
    unix: sock,
    socket: {
      open(s: Socket<{ buf: string }>) { s.data = { buf: "" }; },
      data(s) { s.write(lines.map(l => JSON.stringify(l) + "\n").join("")); s.end(); },
    },
  });
  cleanups.push(() => { try { srv.stop(true); } catch { /* stopped */ } try { rmSync(sock, { force: true }); } catch { /* gone */ } });
}

const RAW = { query: "q", model: "m", limit: 5 };
const HYDRATED = { ...RAW, responseProtocol: HYDRATED_PROTOCOL, presentationQuery: "q", snippetLens: [...HYDRATED_SNIPPET_LENS], rerankTextLen: HYDRATED_RERANK_TEXT_LEN, gateTextLen: HYDRATED_GATE_TEXT_LEN };
const HIT = { hash_seq: "h_0", distance: 0.25 };
const poison = () => new VecPoisonError("non-finite", "endpoint", { context: "query" }, { elementIndex: 3 });

describe("the daemon answers with its fault count and the vf1 attestation", () => {
  test("raw reply: the count beside the results; a clean scan attests and sends no count", async () => {
    const { store } = fakeStore("raw");
    let scan: unknown = { hits: [HIT], vectorFaults: 2, firstFault: "bad_0", scanned: 3 };
    const daemon = await startVectorDaemon(store, () => {}, async () => scan as never);
    cleanups.push(() => daemon!.close());
    const sock = vecDaemonSocketPath(store.dbPath);
    expect(JSON.parse((await rawRequest(sock, JSON.stringify({ ...RAW, remainingBudgetMs: 2000 }) + "\n"))[0]!))
      .toEqual({ results: [HIT], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1", vectorFaults: 2 });
    expect(await daemonVecMatch(store.dbPath, RAW, dl(2000))).toEqual({ status: "ok", results: [HIT], vectorFaults: 2 });
    scan = { hits: [HIT], vectorFaults: 0, scanned: 1 };
    expect(JSON.parse((await rawRequest(sock, JSON.stringify({ ...RAW, remainingBudgetMs: 2000 }) + "\n"))[0]!))
      .toEqual({ results: [HIT], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" });
    expect(await daemonVecMatch(store.dbPath, RAW, dl(2000))).toEqual({ status: "ok", results: [HIT], vectorFaults: 0 });
  });

  test("a scan that hands over a bare hit list is screened by the daemon: an unusable distance never reaches the wire", async () => {
    const { store } = fakeStore("legacy-scan");
    const daemon = await startVectorDaemon(store, () => {}, async () => [HIT, { hash_seq: "inf_0", distance: -Infinity }, { hash_seq: "null_0", distance: null as never }]);
    cleanups.push(() => daemon!.close());
    expect(await daemonVecMatch(store.dbPath, RAW, dl(2000))).toEqual({ status: "ok", results: [HIT], vectorFaults: 2 });
  });

  test("hydrated reply on a real store: the header carries the count", async () => {
    const path = dbPathFor("hydrated");
    const store = createStore(path);
    cleanups.push(() => { try { store.close(); } catch { /* closed */ } for (const s of ["", "-wal", "-shm"]) { try { rmSync(path + s, { force: true }); } catch { /* gone */ } } });
    store.ensureVecTable(2);
    const hash = hashContent("body one");
    const now = new Date().toISOString();
    seedContent(store.db, hash, "body one", now);
    store.insertDocument("c", "one.md", "one", hash, now, now);
    store.insertEmbedding(hash, 0, 1, new Float32Array([0.6, 0.8]), "m", now);
    const daemon = await startVectorDaemon(store, () => {}, async () => ({ hits: [{ hash_seq: `${hash}_0`, distance: 0.25 }], vectorFaults: 1, firstFault: "bad_0", scanned: 2 }));
    cleanups.push(() => daemon!.close());
    const lines = await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ ...HYDRATED, remainingBudgetMs: 2000 }) + "\n");
    expect(JSON.parse(lines[0]!)).toEqual({ protocol: HYDRATED_PROTOCOL, count: 1, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1", vectorFaults: 1 });
    const outcome = await daemonVecMatch(store.dbPath, HYDRATED, dl(2000));
    expect(outcome.status).toBe("ok-hydrated");
    expect((outcome as { vectorFaults: number }).vectorFaults).toBe(1);
  });

  test("the pong lists vf1, and `live` requires it", async () => {
    const { store } = fakeStore("pong");
    const daemon = await startVectorDaemon(store, () => {}, async () => []);
    cleanups.push(() => daemon!.close());
    const pong = await daemonPing(store.dbPath, 1000);
    expect(pong.status === "ok" && pong.protocols).toEqual([HYDRATED_PROTOCOL, DEADLINE_PROTOCOL, VECTOR_FAULT_PROTOCOL]);
    expect((await vectorDaemonHealth(store.dbPath, 1000)).status).toBe("live");
    // an old daemon: both older protocols, no vf1 — live-raw, the status `vec-daemon-health` exits non-zero for
    const old = dbPathFor("old-pong");
    serve(old, [{ pong: true, db: old, pid: 77, protocols: [HYDRATED_PROTOCOL, DEADLINE_PROTOCOL] }]);
    expect((await vectorDaemonHealth(old, 1000)).status).toBe("live-raw");
  });
});

describe("an answer without the vf1 attestation is skew — the count is unknown, never zero", () => {
  test("raw and hydrated answers of an old daemon are `skew`, naming vf1", async () => {
    const raw = dbPathFor("old-raw");
    serve(raw, [{ results: [HIT], deadlineProtocol: DEADLINE_PROTOCOL }]);
    expect(await daemonVecMatch(raw, RAW, dl(2000))).toEqual({ status: "skew", missing: "vf1" });
    const hyd = dbPathFor("old-hyd");
    serve(hyd, [{ protocol: HYDRATED_PROTOCOL, count: 0, deadlineProtocol: DEADLINE_PROTOCOL }, { end: true }]);
    expect(await daemonVecMatch(hyd, HYDRATED, dl(2000))).toEqual({ status: "skew", missing: "vf1" });
  });

  test("a skewed leg is lexical only: the bounded search returns nothing and NO in-process MATCH runs", async () => {
    for (const search of [searchVecBounded, searchVecDaemonRequired]) {
      const { store, inProcess } = fakeStore("skew-leg");
      serve(store.dbPath, [{ results: [HIT], deadlineProtocol: DEADLINE_PROTOCOL }]);
      const seen: VecExecStatus[] = [];
      expect(await search(store, "q", "m", 5, undefined, undefined, undefined, dl(2000), (status) => { seen.push(status); })).toEqual([]);
      expect(seen).toEqual(["skew"]);
      expect(inProcess.calls).toBe(0);
    }
  });

  test("a count that is not a non-negative integer is a protocol error, and so is an unusable distance from a vf1 daemon", async () => {
    for (const vectorFaults of [-1, 1.5, "2", null]) {
      const raw = dbPathFor("bad-count");
      serve(raw, [{ results: [HIT], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1", vectorFaults }]);
      expect(await daemonVecMatch(raw, RAW, dl(2000))).toEqual({ status: "error" });
      const hyd = dbPathFor("bad-count-h");
      serve(hyd, [{ protocol: HYDRATED_PROTOCOL, count: 0, deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1", vectorFaults }, { end: true }]);
      expect(await daemonVecMatch(hyd, HYDRATED, dl(2000))).toEqual({ status: "error" });
    }
    const far = dbPathFor("bad-distance");
    serve(far, [{ results: [{ hash_seq: "h_0", distance: 2.5 }], deadlineProtocol: DEADLINE_PROTOCOL, vectorFaultProtocol: "vf1" }]);
    expect(await daemonVecMatch(far, RAW, dl(2000))).toEqual({ status: "error" });
  });
});

describe("a query vector the daemon's embedding refused is a typed frame", () => {
  test("the frame carries reason and source and is rebuilt into the same error class", () => {
    const frame = vecPoisonFrame(poison());
    expect(frame).toEqual({ error: "vec_poison", kind: "vector", reason: "non-finite", source: "endpoint", context: "query", elementIndex: 3 });
    const rebuilt = vecPoisonFromFrame(frame);
    expect(rebuilt).toBeInstanceOf(VecPoisonError);
    expect(rebuilt!.message).toBe(poison().message);
    const envelope = vecPoisonFromFrame(vecPoisonFrame(new EmbedEnvelopeError("data is not an array", { context: "query" })));
    expect(envelope).toBeInstanceOf(EmbedEnvelopeError);
    expect((envelope as EmbedEnvelopeError).reason).toBe("data is not an array");
    for (const bad of [{ error: "vec_poison" }, { ...frame, reason: "made-up" }, { ...frame, source: "nowhere" }, { ...frame, kind: "other" }, { ...frame, elementIndex: -1 }, { ...frame, context: 7 }]) {
      expect(vecPoisonFromFrame(bad as Record<string, unknown>)).toBeNull();
    }
  });

  test("daemon → client: `vector-fault`, and both bounded searches throw the typed error with no in-process search", async () => {
    for (const thrown of [poison(), new EmbedEnvelopeError("data is not an array", { context: "query" })]) {
      const { store, inProcess } = fakeStore("poison");
      const daemon = await startVectorDaemon(store, () => {}, async () => { throw thrown; });
      const line = JSON.parse((await rawRequest(vecDaemonSocketPath(store.dbPath), JSON.stringify({ ...RAW, remainingBudgetMs: 2000 }) + "\n"))[0]!);
      expect(line.error).toBe("vec_poison");
      const outcome = await daemonVecMatch(store.dbPath, RAW, dl(2000));
      expect(outcome.status).toBe("vector-fault");
      for (const search of [searchVecBounded, searchVecDaemonRequired]) {
        const seen: VecExecStatus[] = [];
        let caught: unknown;
        try { await search(store, "q", "m", 5, undefined, undefined, undefined, dl(2000), (status) => { seen.push(status); }); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(thrown.constructor as new () => Error);
        expect((caught as Error).message).toBe(thrown.message);
        expect(seen).toEqual(["vector-fault"]);
      }
      expect(inProcess.calls).toBe(0);
      daemon!.close();
    }
  });

  test("a frame that claims vec_poison and cannot be rebuilt is `error`", async () => {
    const path = dbPathFor("bad-frame");
    serve(path, [{ error: "vec_poison", kind: "vector", reason: "made-up", source: "endpoint", context: "query" }]);
    expect(await daemonVecMatch(path, RAW, dl(2000))).toEqual({ status: "error" });
  });
});

describe("the leg recorder gets the fault count of an ok leg", () => {
  test("third argument of the recorder", async () => {
    const { store } = fakeStore("recorder");
    (store as unknown as { db: unknown }).db = createStore(":memory:").db;
    const daemon = await startVectorDaemon(store, () => {}, async () => ({ hits: [], vectorFaults: 4, firstFault: "bad_0", scanned: 4 }));
    cleanups.push(() => daemon!.close());
    const seen: unknown[] = [];
    await searchVecDaemonRequired(store, "q", "m", 5, undefined, undefined, undefined, dl(2000), (status, protocol, vectorFaults) => { seen.push([status, protocol, vectorFaults]); });
    expect(seen).toEqual([["ok", "raw-hit", 4]]);
  });
});
