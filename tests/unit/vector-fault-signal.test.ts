/**
 * BACKLOG 82.2, D4 — the fault signal of a vector scan. A stored vector whose RETURNED distance is not usable (NULL,
 * an infinity, outside [0, 2]) is dropped and COUNTED; the count travels in the scan's own return value. Measured on
 * sqlite-vec with the query `[1, 0]`: `[1e-40, 0]` and `[1e-30, 0]` return -Infinity (and sort FIRST), `[0, 0]`,
 * `[NaN, 1]` and `[Infinity, 0]` return NULL, `[1e6, 0]` returns -2.048e-9 (healthy), `[-1, 1]` returns 1.7071
 * (healthy, similarity -0.7071), `[1e38, 0]` returns 1 (the stated limit: not detected on the query path).
 * Each "fault" test fails on v0.43.6, which returns the rows with a score of Infinity or reads NULL as 1.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  createStore, hydrateVecResults, projectVecResults, screenVecHits, searchVecDetailedWithVector, searchVecMatch, type Store,
} from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const MODEL = "m1";
const now = () => new Date().toISOString();

/** A document with one stored vector. `raw` vectors go in by SQL, past `insertEmbedding`'s backstop. */
function seed(store: Store, name: string, vector: number[], opts: { raw?: boolean; collection?: string } = {}): string {
  const body = `body of ${name}`;
  const hash = hashContent(body + name);
  seedContent(store.db, hash, body, now());
  store.insertDocument(opts.collection ?? "c", `${name}.md`, name, hash, now(), now());
  store.insertEmbedding(hash, 0, 1, new Float32Array([0.6, 0.8]), MODEL, now());
  if (opts.raw || vector[0] !== 0.6 || vector[1] !== 0.8) {
    store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_0`);
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(vector));
  }
  return `${hash}_0`;
}

function vault(): { store: Store; keys: Record<string, string> } {
  const store = createStore(":memory:");
  store.ensureVecTable(2);
  const keys: Record<string, string> = {};
  for (const [name, vector] of Object.entries({
    near: [1, 0.01], collinear: [1e6, 0], opposing: [-1, 1], limit: [1e38, 0],
    subnormal: [1e-40, 0], tiny: [1e-30, 0], zero: [0, 0], nan: [NaN, 1], inf: [Infinity, 0],
  })) keys[name] = seed(store, name, vector, { raw: true });
  return { store, keys };
}
const FAULTY = ["subnormal", "tiny", "zero", "nan", "inf"];
const query = { embedding: new Float32Array([1, 0]), endpointModel: MODEL };
const finite = (score: number) => Number.isFinite(score) && score >= -1 && score <= 1;

afterEach(() => setDefaultLlamaCpp(null));

describe("screenVecHits — the one place a returned distance is judged", () => {
  it("drops and counts what is not a usable distance, clamps what is inside the tolerance", () => {
    const scan = screenVecHits([
      { hash_seq: "a_0", distance: 0.25 }, { hash_seq: "b_0", distance: -2.048e-9 }, { hash_seq: "c_0", distance: 2.00005 },
      { hash_seq: "d_0", distance: null }, { hash_seq: "e_0", distance: -Infinity }, { hash_seq: "f_0", distance: NaN },
      { hash_seq: "g_0", distance: 2.5 }, { hash_seq: "h_0", distance: -0.5 }, { hash_seq: "i_0", distance: "0.1" },
    ]);
    expect(scan.hits).toEqual([{ hash_seq: "a_0", distance: 0.25 }, { hash_seq: "b_0", distance: 0 }, { hash_seq: "c_0", distance: 2 }]);
    expect(scan.vectorFaults).toBe(6);
    expect(scan.firstFault).toBe("d_0");
    expect(scan.scanned).toBe(9);
  });

  it("a clean scan has no fault and no first fault", () => {
    const scan = screenVecHits([{ hash_seq: "a_0", distance: 1 }]);
    expect(scan).toEqual({ hits: [{ hash_seq: "a_0", distance: 1 }], vectorFaults: 0, scanned: 1 });
  });
});

describe("searchVecMatch — the scan returns its faults with its hits", () => {
  it("returns the healthy hits, the count and the first faulty key; no bare array", async () => {
    const { store, keys } = vault();
    setDefaultLlamaCpp({ embed: async () => ({ embedding: new Float32Array([1, 0]), model: MODEL }) } as never);
    const scan = await searchVecMatch(store.db, "anything", MODEL, 20);
    expect(Array.isArray(scan)).toBe(false);
    expect(scan.hits.map(h => h.hash_seq).sort()).toEqual([keys.near, keys.collinear, keys.opposing, keys.limit].sort() as string[]);
    expect(scan.vectorFaults).toBe(FAULTY.length);
    expect(FAULTY.map(name => keys[name])).toContain(scan.firstFault!);
    expect(scan.scanned).toBe(9);
    // the two healthy edge cases keep their numbers: a tiny negative distance is 0, an opposing pair is above 1
    const byKey = new Map(scan.hits.map(h => [h.hash_seq, h.distance]));
    expect(byKey.get(keys.collinear!)).toBe(0);
    expect(byKey.get(keys.opposing!)).toBeCloseTo(1.7071, 3);
    // the stated limit: this vector cannot be computed against itself, yet its MATCH distance is ordinary
    expect(byKey.get(keys.limit!)).toBe(1);
  });
});

describe("searchVecDetailedWithVector — faults in the detailed result", () => {
  it("no result has a score outside [-1, 1]; the faults are counted and the result is marked", () => {
    const { store } = vault();
    const result = searchVecDetailedWithVector(store.db, query, 20);
    expect(result.results.map(r => r.title).sort()).toEqual(["collinear", "limit", "near", "opposing"]);
    expect(result.results.every(r => finite(r.score))).toBe(true);
    expect(result.results.find(r => r.title === "collinear")!.score).toBe(1);
    expect(result.results.find(r => r.title === "opposing")!.score).toBeCloseTo(-0.7071, 3);
    expect(result.results.find(r => r.title === "limit")!.score).toBe(0);
    expect(result.vectorFaults).toBe(FAULTY.length);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("vector-fault");
    expect(result.scannedFragments).toBe(9);          // the UNFILTERED scan count
  });

  it("a clean vault reports zero faults and is not degraded", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    seed(store, "a", [1, 0.01], { raw: true });
    const result = searchVecDetailedWithVector(store.db, query, 5);
    expect(result.vectorFaults).toBe(0);
    expect(result.degraded).toBe(false);
    expect(result.degradedReason).toBeUndefined();
  });

  it("faulty hits that take the first places are refilled, and the count survives the further rounds", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    for (let i = 0; i < 4; i++) seed(store, `bad${i}`, [1e-40 * (i + 1), 0], { raw: true });   // -Infinity: sorted first
    seed(store, "good", [1, 0.01], { raw: true });
    const result = searchVecDetailedWithVector(store.db, query, 1);      // the first round asks for 3 rows: all faulty
    expect(result.results.map(r => r.title)).toEqual(["good"]);
    expect(result.vectorFaults).toBe(4);
    expect(result.degradedReason).toBe("vector-fault");
  });

  it("the count is sticky across the rounds of an exclusion escalation", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    seed(store, "bad", [1e-40, 0], { raw: true });
    for (let i = 0; i < 6; i++) seed(store, `hidden${i}`, [1, 0.001 * (i + 1)], { raw: true, collection: "hidden" });
    seed(store, "wanted", [1, 0.5], { raw: true });
    const result = searchVecDetailedWithVector(store.db, query, 1, { excludeCollections: ["hidden"] });
    expect(result.results.map(r => r.title)).toEqual(["wanted"]);
    expect(result.vectorFaults).toBe(1);
    expect(result.excludedDocsSeen).toBe(6);
  });

  it("a refill stops at the cap", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    for (let i = 0; i < 7; i++) seed(store, `bad${i}`, [1e-40 * (i + 1), 0], { raw: true });
    seed(store, "good", [1, 0.01], { raw: true });
    const result = searchVecDetailedWithVector(store.db, query, 1, { escalationCap: 3 });
    expect(result.results).toEqual([]);
    expect(result.vectorFaults).toBe(3);
    expect(result.scannedFragments).toBe(3);
  });
});

describe("the hydrate paths never publish a score from an unusable distance", () => {
  it("hydrateVecResults and projectVecResults refuse a hit that was not screened (a programming fault, not a result)", () => {
    const { store, keys } = vault();
    for (const distance of [NaN, -Infinity, 2.5, null as unknown as number]) {
      expect(() => hydrateVecResults(store.db, [{ hash_seq: keys.near!, distance }], 5)).toThrow(/unusable distance/);
      expect(() => projectVecResults(store.db, [{ hash_seq: keys.near!, distance }], {
        limit: 5, presentationQuery: "q", snippetLens: [150], rerankTextLen: 100, gateTextLen: 100, maxSourceBodyBytes: 1e6,
      })).toThrow(/unusable distance/);
    }
    expect(hydrateVecResults(store.db, [{ hash_seq: keys.near!, distance: 0.25 }], 5)[0]!.score).toBe(0.75);
  });
});

describe("plain search (operator rulings 16 B and 18 A)", () => {
  const embedOne = () => setDefaultLlamaCpp({ embed: async () => ({ embedding: new Float32Array([1, 0]), model: MODEL }) } as never);

  function crowded(): Store {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    for (let i = 0; i < 4; i++) seed(store, `bad${i}`, [1e-40 * (i + 1), 0], { raw: true });   // -Infinity: sorted first
    seed(store, "good", [1, 0.01], { raw: true });
    return store;
  }

  it("18 A: a scan that met a fault rescans deeper until it has what a healthy scan would give", async () => {
    const store = crowded();
    embedOne();
    const scan = await searchVecMatch(store.db, "q", MODEL, 1);      // the first MATCH asks for 3 rows: all faulty
    expect(scan.hits.length).toBe(1);
    expect(scan.vectorFaults).toBe(4);
    expect(scan.scanned).toBe(5);
  });

  it("18 A: a healthy vault is scanned once, at three times the limit", async () => {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    for (let i = 0; i < 10; i++) seed(store, `doc${i}`, [1, 0.01 * (i + 1)], { raw: true });
    embedOne();
    const scan = await searchVecMatch(store.db, "q", MODEL, 1);
    expect(scan).toMatchObject({ vectorFaults: 0, scanned: 3 });
    expect(scan.hits.length).toBe(3);
  });

  it("16 B: `searchVecWithFaults` returns the results with the count; `searchVec` keeps its list", async () => {
    const store = crowded();
    embedOne();
    const detailed = await store.searchVecWithFaults("q", MODEL, 1);
    expect(detailed.results.map(r => r.title)).toEqual(["good"]);
    expect(detailed.vectorFaults).toBe(4);
    expect(typeof detailed.firstFault).toBe("string");
    const plain = await store.searchVec("q", MODEL, 1);
    expect(Array.isArray(plain)).toBe(true);
    expect(plain.map(r => r.title)).toEqual(["good"]);
    const clean = createStore(":memory:");
    clean.ensureVecTable(2);
    seed(clean, "only", [1, 0.01], { raw: true });
    expect(await clean.searchVecWithFaults("q", MODEL, 1)).toMatchObject({ vectorFaults: 0 });
  });
});
