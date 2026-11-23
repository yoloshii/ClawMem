/**
 * BACKLOG 82.2, D5 — `repairVectors`, the engine of `clawmem repair vectors`.
 *  VECTORS: a stored vector that is not usable is deleted with its metadata row, and every ACTIVE document row of
 *  its hash is set to be embedded again; nothing else of a document row changes. Each candidate is examined again
 *  under the write lock. Each page is one transaction that first asserts the embedding lease.
 *  RELATIONS: a similarity relation whose stored weight is not a cosine similarity is deleted; a negative one inside
 *  the range is kept and counted; other relation types are not touched.
 *  The dry run describes every change `run` would make and changes nothing.
 */
import { describe, it, expect } from "bun:test";
import { createStore, getHashesNeedingFragments, buildSemanticGraphDetailed, type Store } from "../../src/store.ts";
import { acquireWorkerLease } from "../../src/worker-lease.ts";
import { repairVectors } from "../../src/vector-health.ts";
import { SemanticThresholdError } from "../../src/relation-weight.ts";
import { BAD, HEALTHY, addDocument, hashOf, keyOf, memoryVault, setVector, now } from "../helpers/vector-health-vault.ts";

const snapshot = (store: Store) => ({
  vectors: store.db.prepare(`SELECT hash_seq, hex(embedding) AS e FROM vectors_vec ORDER BY hash_seq`).all(),
  metadata: store.db.prepare(`SELECT * FROM content_vectors ORDER BY hash, seq`).all(),
  documents: store.db.prepare(`SELECT * FROM documents ORDER BY id`).all(),
  relations: store.db.prepare(`SELECT * FROM memory_relations ORDER BY source_id, target_id, relation_type`).all(),
});
const hasVector = (store: Store, key: string) => !!store.db.prepare(`SELECT 1 FROM vectors_vec WHERE hash_seq = ?`).get(key);
const hasMetadata = (store: Store, name: string, seq = 0) =>
  !!store.db.prepare(`SELECT 1 FROM content_vectors WHERE hash = ? AND seq = ?`).get(hashOf(name), seq);
const embedState = (store: Store, id: number) =>
  store.db.prepare(`SELECT embed_state, embed_attempts, embed_error FROM documents WHERE id = ?`).get(id) as { embed_state: string; embed_attempts: number; embed_error: string | null };
function relate(store: Store, source: number, target: number, type: string, weight: unknown, metadata: string | null = null): void {
  store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(source, target, type, weight as never, metadata, now());
}
const weights = (store: Store, type = "semantic") =>
  (store.db.prepare(`SELECT weight FROM memory_relations WHERE relation_type = ? ORDER BY weight`).all(type) as { weight: number }[]).map(r => r.weight);
function lease(store: Store) {
  const got = acquireWorkerLease(store, "embedding", 60_000);
  if (!got.acquired || !got.token) throw new Error("no lease");
  return { workerName: "embedding", token: got.token };
}

describe("the dry run", () => {
  it("a healthy vault: both phases have nothing to do, exit 0", () => {
    const { store, ids } = memoryVault({ a: [HEALTHY], b: [HEALTHY] });
    relate(store, ids.a!, ids.b!, "semantic", 0.9);
    const report = repairVectors(store.db, { run: false });
    expect(report.exit).toBe(0);
    expect(report.vectors).toMatchObject({ status: "nothing", bad: 0, deleted: 0 });
    expect(report.relations).toMatchObject({ status: "nothing", invalid: 0, deleted: 0 });
  });

  it("describes every change of both phases, changes nothing, exit 1", () => {
    const { store, ids } = memoryVault({ good: [HEALTHY], zero: [BAD.zero], mixed: [HEALTHY, BAD.nan] });
    addDocument(store, "zero", [], "alias");                                 // a second active row of the same hash
    relate(store, ids.good!, ids.zero!, "semantic", Infinity);
    relate(store, ids.good!, ids.mixed!, "semantic", 0.8);                   // in range, of a document to be repaired
    relate(store, ids.zero!, ids.good!, "semantic", -0.5);
    const before = snapshot(store);
    const report = repairVectors(store.db, { run: false });
    expect(snapshot(store)).toEqual(before);
    expect(report.run).toBe(false);
    expect(report.exit).toBe(1);
    expect(report.vectors.status).toBe("pending");
    expect(report.vectors.bad).toBe(2);
    expect(report.vectors.byKind).toMatchObject({ "unsupported-norm": 1, "non-finite": 1 });
    expect(report.vectors.list.map(f => f.hashSeq).sort()).toEqual([keyOf("zero"), keyOf("mixed", 1)].sort());
    expect(report.vectors.documentsReset).toBe(3);                           // zero, its alias, mixed
    expect(report.vectors.deleted).toBe(0);
    expect(report.relations.status).toBe("pending");
    expect(report.relations.invalid).toBe(1);
    expect(report.relations.list).toEqual([{ sourceId: ids.good!, targetId: ids.zero!, weight: "Infinity" }]);
    expect(report.relations.negativeKept).toBe(1);
    expect(report.relations.unresolved).toBe(2);                             // 0.8 and -0.5 touch a document to be repaired
  });

  it("exits 1 when only a bad relation exists — no bad vector", () => {
    const { store, ids } = memoryVault({ a: [HEALTHY], b: [HEALTHY] });
    relate(store, ids.a!, ids.b!, "semantic", 1.15);
    const report = repairVectors(store.db, { run: false });
    expect(report.vectors.status).toBe("nothing");
    expect(report.relations).toMatchObject({ status: "pending", invalid: 1 });
    expect(report.exit).toBe(1);
  });

  it("caps the lists and keeps the totals", () => {
    const docs: Record<string, number[][]> = {};
    for (let i = 0; i < 5; i++) docs[`z${i}`] = [[...BAD.zero]];
    const { store } = memoryVault(docs);
    const report = repairVectors(store.db, { run: false, listCap: 2 });
    expect(report.vectors.bad).toBe(5);
    expect(report.vectors.list.length).toBe(2);
  });
});

describe("run: the vector phase", () => {
  it("deletes both rows of a bad vector and resets every active document row of its hash — nothing else", () => {
    const { store, ids } = memoryVault({ good: [HEALTHY], zero: [BAD.zero] });
    const alias = addDocument(store, "zero", [], "alias");
    const gone = addDocument(store, "zero", [], "gone");
    store.db.prepare(`UPDATE documents SET active = 0, embed_state = 'failed', embed_attempts = 2, embed_error = 'old' WHERE id = ?`).run(gone);
    store.db.prepare(`UPDATE documents SET embed_state = 'failed', embed_attempts = 3, embed_error = 'gave up' WHERE id = ?`).run(alias);
    const rest = (id: number) => {
      const row = store.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as Record<string, unknown>;
      delete row.embed_state; delete row.embed_attempts; delete row.embed_error;
      return row;
    };
    const before = { zero: rest(ids.zero!), alias: rest(alias), good: store.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(ids.good!) };

    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store) });
    expect(report.exit).toBe(0);
    expect(report.vectors).toMatchObject({ status: "completed", bad: 1, deleted: 1, kept: 0, documentsReset: 2 });
    expect(hasVector(store, keyOf("zero"))).toBe(false);
    expect(hasMetadata(store, "zero")).toBe(false);
    expect(hasVector(store, keyOf("good"))).toBe(true);
    expect(hasMetadata(store, "good")).toBe(true);
    for (const id of [ids.zero!, alias]) expect(embedState(store, id)).toEqual({ embed_state: "pending", embed_attempts: 0, embed_error: null });
    expect(embedState(store, gone)).toEqual({ embed_state: "failed", embed_attempts: 2, embed_error: "old" });   // inactive: untouched
    expect(rest(ids.zero!)).toEqual(before.zero);
    expect(rest(alias)).toEqual(before.alias);
    expect(store.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(ids.good!)).toEqual(before.good);
    // and a second run has nothing to do
    expect(repairVectors(store.db, { run: false }).exit).toBe(0);
  });

  it("a synced document with a bad later fragment and a healthy first one IS in the next worklist", () => {
    const { store } = memoryVault({ mixed: [HEALTHY, BAD.subnormal], good: [HEALTHY, HEALTHY] });
    for (const name of ["mixed", "good"]) {
      store.db.prepare(`UPDATE content_vectors SET fragment_type = 'full' WHERE hash = ?`).run(hashOf(name));
    }
    const due = () => getHashesNeedingFragments(store.db).map(r => r.hash);
    expect(due()).toEqual([]);                                               // before: the bad fragment is invisible to the worklist
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store) });
    expect(report.vectors.deleted).toBe(1);
    expect(hasVector(store, keyOf("mixed", 0))).toBe(true);                  // the healthy fragment stays
    expect(hasVector(store, keyOf("mixed", 1))).toBe(false);
    expect(due()).toEqual([hashOf("mixed")]);
  });

  it("removes a bad vector row that has no metadata row", () => {
    const { store } = memoryVault({ good: [HEALTHY] });
    setVector(store, "stray-bad_0", BAD.zero);
    setVector(store, "stray-good_0", HEALTHY);
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store) });
    expect(report.vectors).toMatchObject({ status: "completed", deleted: 1 });
    expect(hasVector(store, "stray-bad_0")).toBe(false);
    expect(hasVector(store, "stray-good_0")).toBe(true);                     // a healthy orphan is not this command's subject
  });

  it("a vector replaced between the scan and the delete is kept", () => {
    const { store, ids } = memoryVault({ zero: [BAD.zero] });
    const report = repairVectors(store.db, {
      run: true, leaseGuard: lease(store),
      hooks: { beforeWrite: () => setVector(store, keyOf("zero"), HEALTHY) },     // an embed replaced it meanwhile
    });
    expect(report.vectors).toMatchObject({ status: "completed", deleted: 0, kept: 1, documentsReset: 0 });
    expect(hasVector(store, keyOf("zero"))).toBe(true);
    expect(hasMetadata(store, "zero")).toBe(true);
    expect(embedState(store, ids.zero!).embed_state).toBe("synced");
    expect(report.exit).toBe(0);
  });

  it("`limit` bounds the rows DELETED: one of two is deleted, the relation phase does not run, exit 1", () => {
    const { store, ids } = memoryVault({ a: [BAD.zero], b: [BAD.nan], good: [HEALTHY] });
    relate(store, ids.good!, ids.a!, "semantic", Infinity);
    const guard = lease(store);
    const report = repairVectors(store.db, { run: true, limit: 1, leaseGuard: guard });
    expect(report.vectors).toMatchObject({ status: "stopped-by-limit", bad: 2, deleted: 1 });
    expect([hasVector(store, keyOf("a")), hasVector(store, keyOf("b"))].filter(Boolean).length).toBe(1);
    expect(report.relations.status).toBe("not-run");
    expect(weights(store)).toEqual([Infinity]);                              // untouched
    expect(report.exit).toBe(1);
    // a limit the work fits in completes
    const second = repairVectors(store.db, { run: true, limit: 5, leaseGuard: guard });
    expect(second.vectors).toMatchObject({ status: "completed", deleted: 1 });
    expect(second.relations).toMatchObject({ status: "completed", deleted: 1 });
    expect(second.exit).toBe(0);
  });

  it("a run without the lease changes nothing: the lease is asserted inside each page's transaction", () => {
    const { store } = memoryVault({ zero: [BAD.zero] });
    const before = snapshot(store);
    const report = repairVectors(store.db, { run: true, leaseGuard: { workerName: "embedding", token: "not-the-holder" } });
    expect(snapshot(store)).toEqual(before);
    expect(report.vectors.status).toBe("failed");
    expect(report.vectors.error).toMatch(/lease/i);
    expect(report.relations.status).toBe("not-run");
    expect(report.exit).toBe(1);
    expect(() => repairVectors(store.db, { run: true })).toThrow(/lease/i);     // `run` is never unfenced
  });

  it("keeps the lease alive at every page of keys — also on a long stretch with nothing to repair", () => {
    const docs: Record<string, number[][]> = {};
    for (let i = 0; i < 6; i++) docs[`ok${i}`] = [HEALTHY];
    const { store } = memoryVault(docs);
    let renewals = 0;
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store), pageSize: 2, renew: () => { renewals++; return true; } });
    expect(report.exit).toBe(0);
    expect(renewals).toBeGreaterThanOrEqual(4);                              // three pages of keys, then the pass for orphans and the relations
    // a dry run holds no lease and renews nothing
    renewals = 0;
    repairVectors(store.db, { run: false, pageSize: 2, renew: () => { renewals++; return true; } });
    expect(renewals).toBe(0);
  });

  it("a renewal that fails stops the run before its page: nothing more is deleted", () => {
    const { store } = memoryVault({ a: [BAD.zero], b: [BAD.zero], c: [BAD.zero] });
    let renewals = 0;
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store), pageSize: 1, renew: () => ++renewals < 2 });
    expect(report.vectors).toMatchObject({ status: "failed", deleted: 1, error: "lost the embedding lease" });
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM vectors_vec`).get() as { n: number }).n).toBe(2);
    expect(report.relations.status).toBe("not-run");
    expect(report.exit).toBe(1);
  });

  it("lease loss rolls back its page: the pages before it stay committed", () => {
    const { store } = memoryVault({ a: [BAD.zero], b: [BAD.zero], c: [BAD.zero] });
    const guard = lease(store);
    let writes = 0;
    const report = repairVectors(store.db, {
      run: true, leaseGuard: guard, pageSize: 1,
      hooks: { beforeWrite: () => {
        if (++writes === 2) store.db.prepare(`UPDATE worker_leases SET lease_token = 'another-holder' WHERE worker_name = 'embedding'`).run();
      } },
    });
    expect(report.vectors).toMatchObject({ status: "failed", deleted: 1 });
    expect(report.vectors.error).toMatch(/lease/i);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM vectors_vec`).get() as { n: number }).n).toBe(2);
    expect(report.relations.status).toBe("not-run");
    expect(report.exit).toBe(1);
  });

  it("an error inside the second page rolls that page back and reports the first page's work", () => {
    const { store } = memoryVault({ a: [BAD.zero], b: [BAD.zero], c: [BAD.zero], d: [BAD.zero] });
    let deletes = 0;
    const report = repairVectors(store.db, {
      run: true, leaseGuard: lease(store), pageSize: 2,
      hooks: { afterDelete: () => { if (++deletes === 3) throw new Error("vec0: simulated extension error"); } },
    });
    // page 1 deleted two; page 2 deleted one, then failed: that one is back
    expect(report.vectors).toMatchObject({ status: "failed", deleted: 2 });
    expect(report.vectors.error).toContain("simulated extension error");
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM vectors_vec`).get() as { n: number }).n).toBe(2);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get() as { n: number }).n).toBe(2);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE embed_state = 'pending'`).get() as { n: number }).n).toBe(2);
    expect(report.relations.status).toBe("not-run");
    expect(report.exit).toBe(1);
  });
});

describe("run: the relation phase", () => {
  function vaultWithRelations() {
    const v = memoryVault({ a: [HEALTHY], b: [HEALTHY], c: [HEALTHY], d: [HEALTHY], e: [HEALTHY], f: [HEALTHY], g: [HEALTHY], h: [HEALTHY] });
    const { store, ids } = v;
    relate(store, ids.a!, ids.b!, "semantic", Infinity);
    relate(store, ids.a!, ids.c!, "semantic", 1.15);
    relate(store, ids.a!, ids.d!, "semantic", -1.2);
    relate(store, ids.a!, ids.e!, "semantic", 1.000000002048);              // two healthy collinear vectors, as v0.43.6 stored it
    relate(store, ids.a!, ids.f!, "semantic", -0.7071);                      // two healthy vectors that point apart
    relate(store, ids.a!, ids.g!, "semantic", 0.83);
    relate(store, ids.b!, ids.a!, "semantic", 1.0, JSON.stringify({ origin: "beads", dep_type: "related" }));
    relate(store, ids.a!, ids.h!, "semantic", 1.5, JSON.stringify({ reasoning: "judged by a model" }));   // not the link builder's
    relate(store, ids.b!, ids.c!, "causal", Infinity);
    relate(store, ids.b!, ids.d!, "causal", 0.9);
    relate(store, ids.b!, ids.e!, "temporal", 7);
    return v;
  }

  it("removes the weights that are no cosine similarity and keeps everything else", () => {
    const { store } = vaultWithRelations();
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store) });
    expect(report.vectors.status).toBe("nothing");
    expect(report.relations).toMatchObject({ status: "completed", invalid: 3, deleted: 3, negativeKept: 1, otherOriginOutOfRange: 1 });
    expect(weights(store)).toEqual([-0.7071, 0.83, 1.0, 1.000000002048, 1.5]);
    expect(weights(store, "causal")).toEqual([0.9, Infinity]);
    expect(weights(store, "temporal")).toEqual([7]);
    expect(report.exit).toBe(0);
    expect(repairVectors(store.db, { run: false }).exit).toBe(0);
  });

  it("a weight that is NULL or text is not a similarity", () => {
    const { store, ids } = memoryVault({ a: [HEALTHY], b: [HEALTHY], c: [HEALTHY] });
    relate(store, ids.a!, ids.b!, "semantic", null);
    relate(store, ids.a!, ids.c!, "semantic", "not a number");
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store) });
    expect(report.relations).toMatchObject({ invalid: 2, deleted: 2 });
    expect(weights(store)).toEqual([]);
  });

  it("pages by key: a page size of one deletes each invalid row once", () => {
    const { store } = vaultWithRelations();
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store), pageSize: 1 });
    expect(report.relations).toMatchObject({ status: "completed", deleted: 3, negativeKept: 1 });
    expect(weights(store)).toEqual([-0.7071, 0.83, 1.0, 1.000000002048, 1.5]);
  });

  it("reports the in-range relations of the documents it repaired, per document, and leaves them", () => {
    const { store, ids } = memoryVault({ zero: [BAD.zero], other: [BAD.nan], a: [HEALTHY], b: [HEALTHY] });
    relate(store, ids.a!, ids.zero!, "semantic", 0.9);
    relate(store, ids.zero!, ids.b!, "semantic", 0.8);
    relate(store, ids.zero!, ids.other!, "semantic", 0.7);                   // touches two repaired documents: counted once in the total
    relate(store, ids.a!, ids.b!, "semantic", 0.6);                          // touches none
    relate(store, ids.b!, ids.zero!, "semantic", 1.0, JSON.stringify({ origin: "beads", dep_type: "related" }));   // the bridge: never counted
    const report = repairVectors(store.db, { run: true, leaseGuard: lease(store) });
    expect(report.vectors).toMatchObject({ status: "completed", deleted: 2, documentsReset: 2 });
    expect(report.relations).toMatchObject({ status: "nothing", deleted: 0, unresolved: 3 });   // nothing to delete; what stays is reported
    expect(report.relations.unresolvedByDocument).toEqual([
      { id: ids.zero!, relations: 3 }, { id: ids.other!, relations: 1 },
    ]);
    expect(weights(store).length).toBe(5);
  });

  it("the relation page asserts the lease inside its transaction: a lease lost before it deletes nothing", () => {
    const { store, ids } = memoryVault({ a: [HEALTHY], b: [HEALTHY], c: [HEALTHY] });
    relate(store, ids.a!, ids.b!, "semantic", Infinity);
    relate(store, ids.a!, ids.c!, "semantic", 7);
    const report = repairVectors(store.db, {
      run: true, leaseGuard: lease(store),
      hooks: { beforeWrite: phase => {
        if (phase === "relations") store.db.prepare(`UPDATE worker_leases SET lease_token = 'another-holder' WHERE worker_name = 'embedding'`).run();
      } },
    });
    expect(report.relations).toMatchObject({ status: "failed", deleted: 0 });
    expect(report.relations.error).toMatch(/lease/i);
    expect(weights(store).length).toBe(2);
    expect(report.exit).toBe(1);
  });

  it("an error inside the second page of relations rolls that page back; the vector phase's work stays", () => {
    const { store, ids } = memoryVault({ zero: [BAD.zero], a: [HEALTHY], b: [HEALTHY], c: [HEALTHY] });
    relate(store, ids.a!, ids.b!, "semantic", Infinity);
    relate(store, ids.a!, ids.c!, "semantic", 7);
    let deletes = 0;
    const report = repairVectors(store.db, {
      run: true, leaseGuard: lease(store), pageSize: 1,
      hooks: { afterDelete: phase => { if (phase === "relations" && ++deletes === 2) throw new Error("disk I/O error"); } },
    });
    expect(report.vectors).toMatchObject({ status: "completed", deleted: 1 });
    expect(report.relations).toMatchObject({ status: "failed", deleted: 1 });
    expect(report.relations.error).toContain("disk I/O error");
    expect(weights(store).length).toBe(1);
    expect(report.exit).toBe(1);
  });
});

describe("the link builder's threshold has its documented domain", () => {
  it("refuses a threshold outside [0, 1] and builds nothing", async () => {
    for (const threshold of [-0.9, 1.5, NaN, Infinity, -0.0001, 1.0001]) {
      const { store } = memoryVault({ a: [[1, 0]], b: [[1, 0.01]], far: [[-1, 0]] });
      await expect(buildSemanticGraphDetailed(store.db, threshold)).rejects.toBeInstanceOf(SemanticThresholdError);
      await expect(store.buildSemanticGraph(threshold)).rejects.toBeInstanceOf(SemanticThresholdError);
      expect(weights(store)).toEqual([]);
    }
  });

  it("accepts the ends of the domain", async () => {
    const { store } = memoryVault({ a: [[1, 0]], b: [[1, 0.01]], far: [[-1, 0]] });
    expect((await buildSemanticGraphDetailed(store.db, 1)).edges).toBe(0);
    expect((await buildSemanticGraphDetailed(store.db, 0)).edges).toBeGreaterThan(0);
    for (const w of weights(store)) expect(w).toBeGreaterThanOrEqual(0);     // no new negative weight is stored
  });
});

describe("a store opened on a file", () => {
  it("runs the same repair", () => {
    const store = createStore(":memory:");
    expect(repairVectors(store.db, { run: false })).toMatchObject({ exit: 0 });   // no vector table: nothing to do
  });
});
