/**
 * BACKLOG 82.2, D3 — the canary cannot pass a non-finite number, and a malformed battery is a RESULT, not an exception.
 * Outcomes, in this order: `malformed` (an answered probe was refused, or the answered probes disagree on dimension
 * or model) → `unavailable` (a probe did not answer; says how many did) → failed → passed.
 * Each test fails on v0.43.6.
 */
import { describe, it, expect } from "bun:test";
import { createHash } from "crypto";
import {
  runCanaryBattery, canaryProbeInputs, canaryGate, canaryFailures, cosineSim, runSampledVectorValidation,
  CANARY_DRIFT_FLOOR, type CanaryOutcome,
} from "../../src/canary.ts";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { VecPoisonError, EmbedEnvelopeError } from "../../src/vector-guard.ts";
import { hashContent } from "../../src/indexer.ts";
import { formatDocForEmbedding } from "../../src/llm.ts";

import { seedContent } from "../helpers/seed-content.ts";
function healthy(text: string): { embedding: Float32Array; model: string } {
  let bucket = 0;
  for (const [id, t] of canaryProbeInputs()) if (t === text) { bucket = id === "unrel" ? 1 : id.startsWith("rel") ? 2 : 3; break; }
  const jitter = (createHash("sha256").update(text).digest()[0]! / 255) * 0.05;
  const base = bucket === 1 ? [0, 1, 0, 0] : bucket === 2 ? [1, 0, 0, 0] : [0.9, 0, 0.45, 0];
  return { embedding: new Float32Array([base[0]! + jitter, base[1]!, base[2]!, base[3]! + jitter * 0.5]), model: "fake" };
}
const total = canaryProbeInputs().size;
/** An embedder that behaves as `nth(n)` says for the n-th probe (1-based), healthy otherwise. */
const scripted = (nth: (n: number, text: string) => unknown | "healthy") => {
  let n = 0;
  return async (text: string) => { n++; const r = nth(n, text); if (r === "healthy") return healthy(text); if (r instanceof Error) throw r; return r as never; };
};
const kind = (o: CanaryOutcome) => "malformed" in o ? "malformed" : "unavailable" in o ? "unavailable" : o.pass ? "passed" : "failed";

describe("runCanaryBattery — three outcomes, a fixed order", () => {
  it("a probe answer the validator refuses is `malformed` — a raw poisoned array, or the typed error from llm.ts", async () => {
    for (const bad of [
      { embedding: [null, 1, 0, 0], model: "fake" },
      { embedding: [0, 0, 0, 0], model: "fake" },
      { embedding: new Float32Array([NaN, 1, 0, 0]), model: "fake" },
      new VecPoisonError("non-number", "endpoint", { context: "probe" }),
      new EmbedEnvelopeError("no data array", { context: "probe" }),
    ]) {
      const out = await runCanaryBattery(scripted(n => (n === 3 ? bad : "healthy")), () => null);
      expect(kind(out)).toBe("malformed");
      if (!("malformed" in out)) throw new Error("unreachable");
      expect(out.pass).toBe(false);
      expect(out.reason).toContain("unrel");            // the third probe, named
      expect(Object.keys(out.margins)).toEqual([]);     // no margin is computed for it
    }
  });

  it("healthy answers, then no answer → `unavailable`, with how many answered and their one (dimension, model)", async () => {
    for (const silent of [null, new Error("connect ECONNREFUSED")]) {
      const out = await runCanaryBattery(scripted(n => (n <= 3 ? "healthy" : silent)), () => null);
      expect(kind(out)).toBe("unavailable");
      if (!("unavailable" in out)) throw new Error("unreachable");
      expect([out.answered, out.total]).toEqual([3, total]);
      expect(out.binding).toEqual({ dim: 4, model: "fake" });
      expect(out.reason).toContain(`3 of ${total}`);
    }
    const none = await runCanaryBattery(async () => null, () => null);
    if (!("unavailable" in none)) throw new Error("unreachable");
    expect([none.answered, none.binding]).toEqual([0, null]);
  });

  it("a refused answer, then no answer → `malformed` (a timeout cannot hide it)", async () => {
    const out = await runCanaryBattery(scripted(n => (n === 1 ? "healthy" : n === 2 ? { embedding: [1, "x", 0, 0], model: "fake" } : null)), () => null);
    expect(kind(out)).toBe("malformed");
  });

  it("two answers of different dimensions (or models), then no answer → `malformed`", async () => {
    const dims = await runCanaryBattery(scripted(n => (n === 1 ? "healthy" : n === 2 ? { embedding: new Float32Array(8).fill(1), model: "fake" } : null)), () => null);
    expect(kind(dims)).toBe("malformed");
    const models = await runCanaryBattery(scripted((n, t) => (n === 1 ? "healthy" : n === 2 ? { ...healthy(t), model: "other" } : null)), () => null);
    expect(kind(models)).toBe("malformed");
  });

  it("a COMPLETE battery with mixed dimensions keeps the structured failure (no throw) and computes no margin", async () => {
    let n = 0;
    const out = await runCanaryBattery(async () => (++n % 2 === 0
      ? { embedding: new Float32Array(4).fill(1), model: "model-a" }
      : { embedding: new Float32Array(8).fill(1), model: "model-b" }), () => null);
    expect(kind(out)).toBe("malformed");
    if (!("malformed" in out)) throw new Error("unreachable");
    expect(out.pass).toBe(false);
    expect(out.failures.some(f => f.includes("mixed dimensions"))).toBe(true);
    expect(Object.keys(out.margins)).toEqual([]);
  });

  it("a healthy battery still passes, and a collapsed one still fails (not malformed)", async () => {
    expect(kind(await runCanaryBattery(async t => healthy(t), () => null))).toBe("passed");
    expect(kind(await runCanaryBattery(async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: "fake" }), () => null))).toBe("failed");
  });

  it("a plain number array from a fake embedder is validated and accepted", async () => {
    const out = await runCanaryBattery(async t => ({ embedding: Array.from(healthy(t).embedding), model: "fake" }), () => null);
    expect(kind(out)).toBe("passed");
  });
});

describe("canaryFailures — a non-finite number never passes", () => {
  const vectors = new Map<string, Float32Array>([["rel_a", new Float32Array([1, 0])]]);
  it("four NaN margins are four failures (NaN < floor is false)", () => {
    const f = canaryFailures({ m_rel: NaN, m_echo: NaN, m_term: NaN, m_trunc: NaN }, vectors, null);
    expect(f.length).toBe(4);
    expect(f.every(line => line.includes("not finite"))).toBe(true);
    expect(canaryFailures({ m_rel: Infinity }, vectors, null).length).toBe(1);
    expect(canaryFailures({ m_rel: 0.5 }, vectors, null)).toEqual([]);
  });
  it("a NaN drift similarity is a failure (NaN < floor is false)", () => {
    const f = canaryFailures({ m_rel: 0.5 }, vectors, { probes: new Map([["rel_a", new Float32Array([1, 0])]]), pairMargins: { m_rel: 0.5 } }, () => NaN);
    expect(f.some(line => line.startsWith("drift:rel_a") && line.includes("not finite"))).toBe(true);
    expect(CANARY_DRIFT_FLOOR).toBe(0.98);
  });
  it("a baseline margin that is not finite cannot set the floor", () => {
    const f = canaryFailures({ m_rel: 0.05 }, vectors, { probes: new Map(), pairMargins: { m_rel: NaN } });
    expect(f.length).toBe(1);   // judged against the absolute floor, not skipped
  });
});

describe("cosineSim", () => {
  it("throws on a length difference instead of reading the shorter length", () => {
    expect(() => cosineSim(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toThrow();
    expect(cosineSim(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1);
  });
});

describe("canaryGate — `malformed` always aborts", () => {
  const malformed = { malformed: true as const, reason: "probe 'unrel' returned a malformed vector", answered: 2, total, pass: false as const, failures: ["x"], margins: {}, vectors: new Map(), profileKey: "", driftChecked: false };
  it("no flag overrides a malformed battery", () => {
    for (const force of [false, true]) for (const forceGeometry of [false, true]) {
      const gate = canaryGate(malformed, { force, forceGeometry });
      expect(gate.action).toBe("abort");
      expect(gate.reason).toContain("malformed");
    }
  });
  it("--force-geometry still overrides `failed` and `unavailable`", () => {
    const failed = { pass: false, failures: ["m_rel low"], margins: {}, vectors: new Map(), profileKey: "p", driftChecked: false };
    const unavailable = { unavailable: true as const, reason: "down", answered: 0, total, binding: null };
    expect(canaryGate(failed, { force: true, forceGeometry: true }).action).toBe("warn");
    expect(canaryGate(unavailable, { force: true, forceGeometry: true }).action).toBe("warn");
    expect(canaryGate(unavailable, { force: true, forceGeometry: false }).action).toBe("abort");
  });
});

describe("sampled validation — a refused response is the ENDPOINT's failure; a refused stored row is the ROW's", () => {
  function seedEmbedded(store: Store, path: string, body: string, vector: Float32Array): string {
    const hash = hashContent(body + "user" + path);
    const now = new Date().toISOString();
    seedContent(store.db, hash, body, now);
    store.insertDocument("user", path, path, hash, now, now);
    store.markEmbedSynced(hash);
    store.ensureVecTable(2);
    const text = formatDocForEmbedding(body, path);
    store.insertEmbedding(hash, 0, 0, vector, "fake", now, "full", undefined, canonicalDocId("user", path), undefined, createHash("sha256").update(text, "utf8").digest("hex"));
    return hash;
  }

  it("a `[null, 1]` fresh response against a stored `[0, 1]` is `refusedFresh`, not `validated`", async () => {
    // On v0.43.6 the response converts to [0, 1], compares equal to the stored row, and the row is VALIDATED.
    for (const fresh of [
      async () => ({ embedding: [null, 1] as unknown as number[], model: "fake" }),
      async () => { throw new VecPoisonError("non-number", "endpoint", { context: "x" }); },
    ]) {
      const store = createStore(":memory:");
      seedEmbedded(store, "a.md", "document a", new Float32Array([0, 1]));
      const r = await runSampledVectorValidation(store, fresh as never);
      expect(r.refusedFresh).toBe(1);
      expect(r.validated).toBe(0);
      expect(r.definitiveFailures.some(f => f.startsWith("endpoint:"))).toBe(true);
    }
  });

  it("a stored vector that is not usable is a definitive failure of the row, and no embed call is spent on it", async () => {
    const store = createStore(":memory:");
    const hash = seedEmbedded(store, "a.md", "document a", new Float32Array([0, 1]));
    // Poison the stored row behind the store's back (raw SQL: the backstop refuses it through the API).
    store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_0`);
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array([1e38, 0]));
    let calls = 0;
    const r = await runSampledVectorValidation(store, async () => { calls++; return { embedding: new Float32Array([0, 1]), model: "fake" }; });
    expect(r.validated).toBe(0);
    expect(r.definitiveFailures.some(f => f.startsWith("stored-vector:") && f.includes("a.md"))).toBe(true);
    expect(calls).toBe(0);
  });

  it("a healthy row and a healthy response still validate", async () => {
    const store = createStore(":memory:");
    seedEmbedded(store, "a.md", "document a", new Float32Array([0, 1]));
    const r = await runSampledVectorValidation(store, async () => ({ embedding: new Float32Array([0, 1]), model: "fake" }));
    expect([r.validated, r.refusedFresh, r.definitiveFailures.length]).toEqual([1, 0, 0]);
  });
});
