/**
 * BACKLOG 82.2, D4 — the other readers of stored vectors use the one distance predicate (`usableDistance`):
 * the similarity-link builder (`buildSemanticGraph`), the A-MEM neighbour query (`generateMemoryLinks`) and the
 * surprisal scan (`computeSurprisalScores`). Where a LIMIT applies the query carries `IS NOT NULL`, so a NULL row
 * takes no place; a row SQL returned and the predicate refuses is skipped and counted.
 * Measured on sqlite-vec against `[1, 0]`: `[0, 0]` gives NULL, `[1e-40, 0]` gives -Infinity (it sorts FIRST),
 * `[1e6, 0]` gives -2.048e-9 (healthy; v0.43.6 stores its similarity as 1.000000002048).
 */
import { describe, it, expect } from "bun:test";
import { createStore, buildSemanticGraph, buildSemanticGraphDetailed, type Store } from "../../src/store.ts";
import { generateMemoryLinks } from "../../src/amem.ts";
import { computeSurprisalScores } from "../../src/consolidation.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const now = () => new Date().toISOString();
function seed(store: Store, name: string, vector: number[]): number {
  const body = `body of ${name}`;
  const hash = hashContent(body + name);
  seedContent(store.db, hash, body, now());
  store.insertDocument("c", `${name}.md`, name, hash, now(), now());
  store.insertEmbedding(hash, 0, 0, new Float32Array([0.6, 0.8]), "m1", now());
  store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_0`);
  store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(vector));
  return (store.db.prepare(`SELECT id FROM documents WHERE hash = ?`).get(hash) as { id: number }).id;
}
function vault(vectors: Record<string, number[]>): { store: Store; ids: Record<string, number> } {
  const store = createStore(":memory:");
  store.ensureVecTable(2);
  const ids: Record<string, number> = {};
  for (const [name, vector] of Object.entries(vectors)) ids[name] = seed(store, name, vector);
  return { store, ids };
}
const relations = (store: Store) => store.db.prepare(
  `SELECT source_id, target_id, weight FROM memory_relations WHERE relation_type = 'semantic'`).all() as { source_id: number; target_id: number; weight: number }[];

describe("the similarity-link builder", () => {
  const VECTORS = { a: [1, 0], b: [1, 0.01], far: [0, 1], collinear: [1e6, 0], zero: [0, 0], sub: [1e-40, 0] };

  it("stores no weight that is not a similarity: every weight is finite and inside [-1, 1]", async () => {
    const { store, ids } = vault(VECTORS);
    const built = await buildSemanticGraphDetailed(store.db, 0.7);
    const rows = relations(store);
    expect(rows.length).toBeGreaterThan(0);
    expect(built.edges).toBe(rows.length);
    for (const row of rows) {
      expect(Number.isFinite(row.weight)).toBe(true);
      expect(row.weight).toBeGreaterThanOrEqual(-1);
      expect(row.weight).toBeLessThanOrEqual(1);                 // the collinear pair is stored as 1, not 1.000000002048
    }
    const bad = new Set([ids.zero, ids.sub]);
    expect(rows.filter(row => bad.has(row.source_id) || bad.has(row.target_id))).toEqual([]);
    expect(rows.some(row => row.source_id === ids.a && row.target_id === ids.collinear && row.weight === 1)).toBe(true);
    expect(rows.some(row => row.source_id === ids.a && row.target_id === ids.b)).toBe(true);
    expect(built.vectorFaults).toBeGreaterThan(0);               // the -Infinity rows SQL returned were skipped and counted
  });

  it("a healthy vault counts no fault; `buildSemanticGraph` still returns the number of edges", async () => {
    const first = vault({ a: [1, 0], b: [1, 0.01], far: [0, 1] });
    const built = await buildSemanticGraphDetailed(first.store.db, 0.7);
    expect(built).toEqual({ edges: 2, vectorFaults: 0 });
    const second = vault({ a: [1, 0], b: [1, 0.01], far: [0, 1] });
    expect(await buildSemanticGraph(second.store.db, 0.7)).toBe(2);
    expect(await second.store.buildSemanticGraph(0.7)).toBe(0);  // already there: nothing more was written
  });
});

describe("the A-MEM neighbour query", () => {
  /** The neighbour titles the model was shown, in order. */
  async function shown(vectors: Record<string, number[]>, k: number): Promise<string[]> {
    const { store, ids } = vault(vectors);
    const prompts: string[] = [];
    const llm = { generate: async (prompt: string) => { prompts.push(prompt); return { text: "[]" }; } };
    await generateMemoryLinks(store, llm as never, ids.source!, k);
    expect(prompts.length).toBeGreaterThan(0);
    return [...prompts[0]!.matchAll(/^\d+\. "([^"]+)"/gm)].map(m => m[1]!);
  }

  it("a NULL row takes no place: the list is not shortened", async () => {
    const titles = await shown({ source: [1, 0], n1: [1, 0.01], n2: [1, 0.02], n3: [1, 0.03], zero: [0, 0] }, 3);
    expect(titles).toEqual(["n1", "n2", "n3"]);
  });

  it("a row whose distance is not usable is never shown as a neighbour", async () => {
    const titles = await shown({ source: [1, 0], n1: [1, 0.01], n2: [1, 0.02], n3: [1, 0.03], sub: [1e-40, 0] }, 3);
    expect(titles).not.toContain("sub");
    expect(titles.slice(0, 2)).toEqual(["n1", "n2"]);
  });
});

describe("the surprisal scan", () => {
  it("every score is a finite distance inside [0, 2], with unusable stored vectors in the vault", () => {
    const { store } = vault({ o1: [1, 0], o2: [1, 0.2], o3: [0.5, 1], o4: [0, 1], zero: [0, 0], sub: [1e-40, 0] });
    store.db.exec(`UPDATE documents SET observation_type = 'discovery'`);
    const scores = computeSurprisalScores(store, { k: 2 });
    expect(scores.length).toBeGreaterThan(0);
    for (const score of scores) {
      expect(Number.isFinite(score.avgNeighborDistance)).toBe(true);
      expect(score.avgNeighborDistance).toBeGreaterThanOrEqual(0);
      expect(score.avgNeighborDistance).toBeLessThanOrEqual(2);
    }
    expect(scores.map(s => s.title)).not.toContain("zero");
  });
});
