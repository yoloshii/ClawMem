import { describe, it, expect } from "bun:test";

/**
 * VSEARCH-TRUST-HARDENING (b) regressions — visibility exclusion at the store layer
 * and inside graph traversal, plus the degraded-marker contract:
 *   (i)   all initial 3*limit nearest internal → escalation fills `limit`
 *   (ii)  hard-cap exhaustion with exclusion-accounted shortfall → excluded-dominant
 *   (iii) fragment-dedup collapse → post-dedup DOC count drives escalation
 *   (iv)  small-vault plain exhaustion → short list, NO degraded marker
 *   (v)   mixed cause (few internal, shortfall dedup-driven) → cap-truncation
 *   FTS excludeCollections; shared query-vector guard (model + dimension);
 *   traversal-level exclusion incl. beam parity; `latest` recency intent.
 */

import {
  createStore,
  searchVecDetailedWithVector,
  VecDimensionMismatchError,
  VecReadModelMismatchError,
  type Store,
} from "../../src/store.ts";
import { adaptiveTraversal } from "../../src/graph-traversal.ts";
import { hasRecencyIntent } from "../../src/memory.ts";
import { hashContent } from "../../src/indexer.ts";

const MODEL = "test-model";
const DIM = 4;

function seedDoc(store: Store, col: string, path: string, body: string): string {
  const hash = hashContent(body + col + path);
  const now = new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument(col, path, path, hash, now, now);
  return hash;
}

/** Unit vector at an angle from [1,0,0,0] in the xy-plane — cos(query, v) = cos(angle). */
function vecAt(angleRad: number): Float32Array {
  return new Float32Array([Math.cos(angleRad), Math.sin(angleRad), 0, 0]);
}
const QUERY_VEC = vecAt(0);
const qv = { embedding: QUERY_VEC, endpointModel: MODEL };

/** Seed one doc with `frags` fragments at increasing angular distance from the query. */
function seedWithVecs(store: Store, col: string, path: string, baseAngle: number, frags: number, stepRad = 0.001): string {
  const hash = seedDoc(store, col, path, `body of ${col}/${path}`);
  store.ensureVecTable(DIM);
  for (let seq = 0; seq < frags; seq++) {
    store.insertEmbedding(hash, seq, seq, vecAt(baseAngle + seq * stepRad), MODEL, new Date().toISOString(), "section", undefined, `${col}/${path}`);
  }
  return hash;
}

describe("searchFTS excludeCollections", () => {
  it("excluded-collection docs never enter the candidate pool", () => {
    const store = createStore(":memory:");
    seedDoc(store, "_clawmem", "obs/a.md", "sandbox verification policy internal note");
    seedDoc(store, "user", "b.md", "sandbox verification policy user document");
    const all = store.searchFTS("sandbox verification", 10);
    expect(all.length).toBe(2);
    const filtered = store.searchFTS("sandbox verification", 10, undefined, undefined, undefined, ["_clawmem"]);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.collectionName).toBe("user");
  });
});

describe("searchVecDetailedWithVector — shared guard", () => {
  it("throws VecReadModelMismatchError on an endpoint-model mismatch", () => {
    const store = createStore(":memory:");
    seedWithVecs(store, "user", "a.md", 0.2, 1);
    expect(() => searchVecDetailedWithVector(store.db, { embedding: QUERY_VEC, endpointModel: "other-model" }, 5, {}))
      .toThrow(VecReadModelMismatchError);
  });

  it("throws VecDimensionMismatchError on a query-vector dimension mismatch", () => {
    const store = createStore(":memory:");
    seedWithVecs(store, "user", "a.md", 0.2, 1);
    expect(() => searchVecDetailedWithVector(store.db, { embedding: new Float32Array(8), endpointModel: MODEL }, 5, {}))
      .toThrow(VecDimensionMismatchError);
  });
});

describe("vector exclusion escalation (design (b).1)", () => {
  it("(i) all initial 3*limit nearest internal → escalation still fills `limit` user docs", () => {
    const store = createStore(":memory:");
    // 6 internal docs closest (angles 0.01..0.06), 2 user docs further (0.5, 0.6). limit=2 → k starts at 6.
    for (let i = 0; i < 6; i++) seedWithVecs(store, "_clawmem", `obs/i${i}.md`, 0.01 + i * 0.01, 1);
    seedWithVecs(store, "user", "u1.md", 0.5, 1);
    seedWithVecs(store, "user", "u2.md", 0.6, 1);

    const det = searchVecDetailedWithVector(store.db, qv, 2, { excludeCollections: ["_clawmem"] });
    expect(det.results.length).toBe(2);
    expect(det.results.every(r => r.collectionName === "user")).toBe(true);
    expect(det.degraded).toBe(false); // table exhausted below the hard cap → ordinary escalation
  });

  it("(iii) fragment-dedup collapse — post-dedup DOC count drives escalation", () => {
    const store = createStore(":memory:");
    // ONE user doc's 6 fragments are nearest; the second user doc is beyond the initial k=6.
    seedWithVecs(store, "user", "big.md", 0.01, 6);
    seedWithVecs(store, "user", "far.md", 0.7, 1);

    const det = searchVecDetailedWithVector(store.db, qv, 2, { excludeCollections: ["user-nonexistent"] });
    // Exclusion active (nonexistent collection) → escalation loop runs on doc count.
    expect(det.results.length).toBe(2);
    expect(det.results.map(r => r.displayPath).sort()).toEqual(["user/big.md", "user/far.md"]);
  });

  it("(iv) small-vault plain exhaustion → short list, NO degraded marker", () => {
    const store = createStore(":memory:");
    for (let i = 0; i < 3; i++) seedWithVecs(store, "user", `u${i}.md`, 0.1 + i * 0.1, 1);
    const det = searchVecDetailedWithVector(store.db, qv, 10, { excludeCollections: ["_clawmem"] });
    expect(det.results.length).toBe(3);
    expect(det.degraded).toBe(false);
    expect(det.degradedReason).toBeUndefined();
  });

  it("(ii) hard-cap exhaustion with exclusion-accounted shortfall → excluded-dominant + guidance fields", () => {
    const store = createStore(":memory:");
    // Cap 8 (injected), table 20 rows: 8 nearest are DISTINCT internal docs; user docs live beyond the cap.
    for (let i = 0; i < 12; i++) seedWithVecs(store, "_clawmem", `obs/i${i}.md`, 0.01 + i * 0.005, 1);
    for (let i = 0; i < 8; i++) seedWithVecs(store, "user", `u${i}.md`, 1.0 + i * 0.01, 1);

    const det = searchVecDetailedWithVector(store.db, qv, 2, { excludeCollections: ["_clawmem"], escalationCap: 8 });
    expect(det.degraded).toBe(true);
    expect(det.degradedReason).toBe("excluded-dominant");
    expect(det.excludedDocsSeen).toBeGreaterThanOrEqual(2 - det.results.length);
  });

  it("(v) mixed cause — shortfall driven by dedup, not exclusions → cap-truncation", () => {
    const store = createStore(":memory:");
    // Cap 8, table > 8. Nearest 8 = 7 fragments of ONE user doc + 1 internal fragment.
    // limit=3 → allowed=1, shortfall=2, excludedDocsSeen=1 < 2 → cap-truncation.
    seedWithVecs(store, "user", "big.md", 0.01, 7, 0.001);
    seedWithVecs(store, "_clawmem", "obs/one.md", 0.009, 1);
    for (let i = 0; i < 8; i++) seedWithVecs(store, "user", `far${i}.md`, 1.0 + i * 0.01, 1);

    const det = searchVecDetailedWithVector(store.db, qv, 3, { excludeCollections: ["_clawmem"], escalationCap: 8 });
    expect(det.degraded).toBe(true);
    expect(det.degradedReason).toBe("cap-truncation");
  });
});

describe("traversal-level exclusion (design (b).3)", () => {
  function seedGraph(store: Store) {
    store.ensureVecTable(DIM); // getDocEmbedding reads vectors_vec during traversal
    const anchor = seedDoc(store, "user", "anchor.md", "anchor doc");
    const userN = seedDoc(store, "user", "neighbor.md", "user neighbor");
    const internalN = seedDoc(store, "_clawmem", "deductions/d.md", "internal deduction");
    const id = (h: string) => (store.db.prepare(`SELECT id FROM documents WHERE hash = ?`).get(h) as { id: number }).id;
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_relations (source_id INTEGER, target_id INTEGER, relation_type TEXT, weight REAL)`);
    const ins = store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight) VALUES (?, ?, ?, ?)`);
    // Internal neighbor carries a HIGHER weight — without exclusion it wins the beam.
    ins.run(id(anchor), id(internalN), "semantic", 1.0);
    ins.run(id(anchor), id(userN), "semantic", 0.5);
    return { anchor, userN, internalN, id };
  }
  const OPTS = { maxDepth: 1, budget: 10, intent: "WHAT" as const, queryEmbedding: [1, 0, 0, 0] };

  it("excluded neighbors are pruned before beam selection (crowd-out eliminated, not hidden)", () => {
    const store = createStore(":memory:");
    const { anchor, userN, internalN, id } = seedGraph(store);

    // beamWidth=1: without exclusion the internal node takes the only beam slot.
    const without = adaptiveTraversal(store.db, [{ hash: anchor, score: 1 }], { ...OPTS, beamWidth: 1 });
    expect(without.some(n => n.docId === id(internalN))).toBe(true);
    expect(without.some(n => n.docId === id(userN))).toBe(false);

    // With exclusion the internal node neither appears NOR consumes the beam slot —
    // the user neighbor is discovered (beam parity with a vault where internals don't exist).
    const withExcl = adaptiveTraversal(store.db, [{ hash: anchor, score: 1 }], { ...OPTS, beamWidth: 1, excludeCollections: ["_clawmem"] });
    expect(withExcl.some(n => n.docId === id(internalN))).toBe(false);
    expect(withExcl.some(n => n.docId === id(userN))).toBe(true);
  });
});

describe("`latest` recency intent (Turn-1 MEDIUM-3)", () => {
  it("routes 'latest' phrasings to recency intent on all direct tools", () => {
    expect(hasRecencyIntent("latest decisions")).toBe(true);
    expect(hasRecencyIntent("what's the latest on the migration")).toBe(true);
    expect(hasRecencyIntent("relate the seal design to the sandbox profile")).toBe(false);
  });
});
