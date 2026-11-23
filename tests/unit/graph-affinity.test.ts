/**
 * BACKLOG 82.2, D3 — graph traversal reads a neighbour's stored vector through `storedVector`.
 * Bun returns the blob as a `Uint8Array` (a 4-dimension vector comes back with length 16), and through v0.43.6 the
 * traversal typed it as `Float32Array` without decoding: the lengths never matched, so the semantic affinity of
 * EVERY neighbour was 0, on healthy vectors. The first test fails on v0.43.6.
 */
import { describe, it, expect, spyOn } from "bun:test";
import { createStore, type Store } from "../../src/store.ts";
import { adaptiveTraversal } from "../../src/graph-traversal.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const now = () => new Date().toISOString();
function seedDoc(store: Store, path: string, vector: Float32Array | null): { hash: string; id: number } {
  const body = `body of ${path}`;
  const hash = hashContent(body + path);
  seedContent(store.db, hash, body, now());
  store.insertDocument("user", path, path, hash, now(), now());
  if (vector) { store.ensureVecTable(4); store.insertEmbedding(hash, 0, 0, vector, "m", now(), "full", undefined, `user/${path}`); }
  return { hash, id: (store.db.prepare(`SELECT id FROM documents WHERE hash = ?`).get(hash) as { id: number }).id };
}
function graph(store: Store) {
  const anchor = seedDoc(store, "anchor.md", new Float32Array([1, 0, 0, 0]));
  const near = seedDoc(store, "near.md", new Float32Array([1, 0, 0, 0]));          // cos(query, near) = 1
  const far = seedDoc(store, "far.md", new Float32Array([0, 1, 0, 0]));            // cos(query, far) = 0
  store.db.exec(`CREATE TABLE IF NOT EXISTS memory_relations (source_id INTEGER, target_id INTEGER, relation_type TEXT, weight REAL)`);
  const ins = store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight) VALUES (?, ?, ?, ?)`);
  ins.run(anchor.id, near.id, "semantic", 0.5);
  ins.run(anchor.id, far.id, "semantic", 0.5);
  return { anchor, near, far };
}
const OPTS = { maxDepth: 1, beamWidth: 10, budget: 10, intent: "WHAT" as const, queryEmbedding: [1, 0, 0, 0] };
const scoreOf = (nodes: { docId: number; score: number }[], id: number) => nodes.find(n => n.docId === id)!.score;

describe("graph affinity", () => {
  it("a healthy graph gives a neighbour its real, non-zero affinity", () => {
    const store = createStore(":memory:");
    const { anchor, near, far } = graph(store);
    const nodes = adaptiveTraversal(store.db, [{ hash: anchor.hash, score: 1 }], OPTS);
    const nearScore = scoreOf(nodes, near.id), farScore = scoreOf(nodes, far.id);
    expect(nearScore).toBeGreaterThan(farScore);
    // transition = exp(0.6·structure + 0.4·affinity) · weight: the two differ exactly by the affinity term.
    expect((nearScore - 0.9) / (farScore - 0.9)).toBeCloseTo(Math.exp(0.4), 6);
  });

  it("a corrupt stored vector gives affinity 0 for THAT neighbour, the leg survives, and the process warns once", () => {
    const store = createStore(":memory:");
    const { anchor, near, far } = graph(store);
    // Corrupt `near`'s stored vector behind the store's back (the API's backstop refuses it).
    store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${near.hash}_0`);
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${near.hash}_0`, new Float32Array([1e38, 0, 0, 0]));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const nodes = adaptiveTraversal(store.db, [{ hash: anchor.hash, score: 1 }], OPTS);
      expect(nodes.some(n => n.docId === near.id)).toBe(true);                    // the leg is NOT discarded
      expect(scoreOf(nodes, near.id)).toBeCloseTo(scoreOf(nodes, far.id), 9);     // affinity 0, as for the orthogonal one
      adaptiveTraversal(store.db, [{ hash: anchor.hash, score: 1 }], OPTS);
      const about = warn.mock.calls.filter(c => String(c[0]).includes("stored vector"));
      expect(about.length).toBe(1);
    } finally { warn.mockRestore(); }
  });

  it("a neighbour without a vector, or a query of another dimension, contributes affinity 0 and stays", () => {
    const store = createStore(":memory:");
    const { anchor, near, far } = graph(store);
    const bare = seedDoc(store, "bare.md", null);
    store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight) VALUES (?, ?, ?, ?)`).run(anchor.id, bare.id, "semantic", 0.5);
    const nodes = adaptiveTraversal(store.db, [{ hash: anchor.hash, score: 1 }], OPTS);
    expect(scoreOf(nodes, bare.id)).toBeCloseTo(scoreOf(nodes, far.id), 9);
    const other = adaptiveTraversal(store.db, [{ hash: anchor.hash, score: 1 }], { ...OPTS, queryEmbedding: [1, 0] });
    expect(scoreOf(other, near.id)).toBeCloseTo(scoreOf(other, far.id), 9);
  });
});
