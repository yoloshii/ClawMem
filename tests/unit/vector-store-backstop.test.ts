/**
 * BACKLOG 82.2, D1 — the backstops inside the store: a writer that did not come through `llm.ts` cannot store
 * poison, a refused canary save leaves the previous baseline as it was, and a stored baseline is read strictly.
 * Each test fails on v0.43.6, which stores what it is given.
 */
import { describe, it, expect } from "bun:test";
import { createStore, type Store } from "../../src/store.ts";
import { VecPoisonError } from "../../src/vector-guard.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
function seed(store: Store, path: string, body: string): string {
  const hash = hashContent(body + path);
  const now = new Date().toISOString();
  seedContent(store.db, hash, body, now);
  store.insertDocument("c", path, path, hash, now, now);
  return hash;
}
const dump = (store: Store, table: string) => JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).values());
const now = () => new Date().toISOString();
const poison: [string, Float32Array][] = [
  ["all-zero", new Float32Array([0, 0])],
  ["NaN", new Float32Array([NaN, 1])],
  ["Infinity", new Float32Array([Infinity, 0])],
  ["a norm sqlite-vec cannot compute", new Float32Array([1e38, 0])],
  ["subnormal", new Float32Array([1e-40, 0])],
];

describe("insertEmbedding — the backstop", () => {
  for (const [label, vector] of poison) {
    it(`refuses ${label} and leaves BOTH vector tables as they were, the row it would replace included`, () => {
      const store = createStore(":memory:");
      store.ensureVecTable(2);
      const hash = seed(store, "a.md", "doc a");
      store.insertEmbedding(hash, 0, 1, new Float32Array([1, 0]), "m1", now(), "full", undefined, "c/a.md");
      const before = [dump(store, "content_vectors"), dump(store, "vectors_vec")];
      expect(() => store.insertEmbedding(hash, 0, 1, vector, "m1", now(), "full", undefined, "c/a.md")).toThrow(VecPoisonError);
      expect([dump(store, "content_vectors"), dump(store, "vectors_vec")]).toEqual(before);
      // ...and on an empty vault nothing is written at all.
      const empty = createStore(":memory:");
      empty.ensureVecTable(2);
      const h2 = seed(empty, "b.md", "doc b");
      expect(() => empty.insertEmbedding(h2, 0, 1, vector, "m1", now())).toThrow(VecPoisonError);
      expect(empty.getVectorConsistency().vvCount).toBe(0);
      expect((empty.db.prepare(`SELECT count(*) AS c FROM content_vectors`).get() as { c: number }).c).toBe(0);
    });
  }

  it("refuses an array that is not a Float32Array (a caller that skipped the validator)", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    const hash = seed(store, "a.md", "doc a");
    expect(() => store.insertEmbedding(hash, 0, 1, [null, 1] as unknown as Float32Array, "m1", now())).toThrow(VecPoisonError);
    expect(store.getVectorConsistency().vvCount).toBe(0);
  });

  it("still stores a healthy vector", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(2);
    const hash = seed(store, "a.md", "doc a");
    store.insertEmbedding(hash, 0, 1, new Float32Array([0.6, 0.8]), "m1", now());
    expect(store.getVectorConsistency().vvCount).toBe(1);
  });
});

describe("saveCanaryBaseline — a refused save leaves the previous baseline byte-identical", () => {
  const good = [{ probeId: "rel_a", embedding: new Float32Array([1, 0]) }, { probeId: "rel_b", embedding: new Float32Array([0.6, 0.8]) }];
  const margins = { m_rel: 0.4, m_echo: 0.3 };

  it("a NaN or infinite margin throws before the old baseline is deleted", () => {
    const store = createStore(":memory:");
    store.saveCanaryBaseline("k", good, margins);
    const before = dump(store, "embed_canary");
    for (const bad of [NaN, Infinity, -Infinity, null as unknown as number, "0.4" as unknown as number]) {
      expect(() => store.saveCanaryBaseline("k", good, { ...margins, m_rel: bad })).toThrow(VecPoisonError);
      expect(dump(store, "embed_canary")).toBe(before);
    }
  });

  it("a non-finite or unusable probe throws before the old baseline is deleted", () => {
    const store = createStore(":memory:");
    store.saveCanaryBaseline("k", good, margins);
    const before = dump(store, "embed_canary");
    for (const [, vector] of poison) {
      expect(() => store.saveCanaryBaseline("k", [good[0]!, { probeId: "rel_b", embedding: vector }], margins)).toThrow(VecPoisonError);
      expect(dump(store, "embed_canary")).toBe(before);
    }
  });

  it("a healthy save replaces the baseline and reads back exactly", () => {
    const store = createStore(":memory:");
    store.saveCanaryBaseline("k", good, margins);
    const back = store.getCanaryBaseline("k")!;
    expect(Array.from(back.probes.get("rel_b")!)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(back.pairMargins).toEqual(margins);
  });
});

describe("getCanaryBaseline — a stored baseline is read strictly", () => {
  const row = (store: Store, probe: string, blob: Uint8Array, marginsJson: string) =>
    store.db.prepare(`INSERT INTO embed_canary (probe_id, profile_key, embedding, pair_margins, embedded_at) VALUES (?, ?, ?, ?, ?)`)
      .run(probe, "k", blob, marginsJson, now());
  const blob = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);

  it("refuses a stored probe that is not a usable vector", () => {
    for (const bad of [blob([NaN, 0]), blob([0, 0]), blob([1e38, 0]), new Uint8Array(7)]) {
      const store = createStore(":memory:");
      row(store, "rel_a", bad, `{"m_rel":0.4}`);
      expect(() => store.getCanaryBaseline("k")).toThrow(VecPoisonError);
    }
  });

  it("refuses a stored margin that is not a finite number (JSON `null` is what a NaN was stored as)", () => {
    for (const marginsJson of [`{"m_rel":null}`, `{"m_rel":"0.4"}`, `{"m_rel":1e999}`]) {
      const store = createStore(":memory:");
      row(store, "rel_a", blob([1, 0]), marginsJson);
      expect(() => store.getCanaryBaseline("k")).toThrow(VecPoisonError);
    }
  });

  it("returns null for a profile that has no baseline", () => {
    expect(createStore(":memory:").getCanaryBaseline("none")).toBeNull();
  });
});
