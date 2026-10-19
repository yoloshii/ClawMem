/**
 * 76.3 `clawmem repair entities` — repairs links written before the 76.1 resolver fix.
 *
 * Bugs these tests catch (each describe names its design rule):
 * - a dry run that writes, or plans across two snapshots;
 * - a link moved without proof (R3 duplicates, R4 type drift), or an unproven link turned into R2 by a planned mint;
 * - a resolution copy that answers unlike the vault, before or after mints; planner statistics ignored;
 * - an order other than the sighting order (UTC instant, evidence first, row id, subject first);
 * - a hold that leaves a held item's mint in the plan; a held triple altered;
 * - survivor allocation that loses evidence, duplicates a key, or re-points the unchanged part of a split;
 * - evidence collapse keeping the wrong row; mention collapse losing the right text;
 * - apply writing anything after a refusal; restore reverting changes that later activity built on.
 */

import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync, statSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, type Store } from "../../src/store.ts";
import { seedDocuments } from "../helpers/test-store.ts";
import { makeEntityId, enrichDocumentEntities, computeEntityEdges, ENTITY_IDF_SPECIFICITY_THRESHOLD } from "../../src/entity.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import {
  planEntityRepair,
  dryRunEntityRepair,
  applyEntityRepair,
  restoreEntityRepair,
  sightingInstant,
  EntityRepairRefusal,
  type EntityRepairPlan,
} from "../../src/entity-repair.ts";

// =============================================================================
// Fixtures
// =============================================================================

const dirs: string[] = [];
const open: Store[] = [];
afterEach(() => {
  for (const s of open.splice(0)) {
    try { s.db.close(); } catch { /* closed by the test */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// One schema, made once: a new store costs about a second, opening a copy of an initialized one a few milliseconds.
let template: { dir: string; path: string } | null = null;
function templatePath(): string {
  if (!template) {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-763-tpl-"));
    const path = join(dir, "template.sqlite");
    const s = createStore(path);
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    s.db.close();
    template = { dir, path };
  }
  return template.path;
}
afterAll(() => {
  if (template) rmSync(template.dir, { recursive: true, force: true });
});

interface V {
  path: string;
  store: Store;
  db: Database;
  doc: (name: string, body?: string) => number;
}

function vault(): V {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-763-"));
  dirs.push(dir);
  const path = join(dir, "vault.sqlite");
  copyFileSync(templatePath(), path);
  const store = createStore(path);
  open.push(store);
  let n = 0;
  return {
    path,
    store,
    db: store.db,
    doc: (name, body = `notes on ${name}`) => seedDocuments(store, [{ path: `notes/${name}-${++n}.md`, title: name, body }])[0]!,
  };
}

/** An entity as ensureEntityCanonical mints one: its node and its lowercased FTS row. */
function entity(db: Database, name: string, type: string, opts: { id?: string; vault?: string } = {}): string {
  const vaultName = opts.vault ?? "default";
  const id = opts.id ?? makeEntityId(name, type, vaultName);
  db.prepare(`
    INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
    VALUES (?, ?, ?, NULL, datetime('now'), 0, datetime('now'), ?)
  `).run(id, type, name, vaultName);
  db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`).run(id, name.toLowerCase(), type);
  return id;
}

/** A fact as insertObservationTriples writes it: the triple (or a sighting of an open one) plus its evidence row. */
function fact(v: V, s: string, sText: string, p: string, o: string, oText: string, opts: { doc?: number; at?: string } = {}): number {
  const text = `${sText} ${p} ${oText}`;
  const id = v.store.addTriple(s, p, o, null, { sourceDocId: opts.doc, sourceFact: text });
  if (opts.at) v.db.prepare(`UPDATE entity_triple_provenance SET created_at = ? WHERE triple_id = ? AND source_fact = ?`).run(opts.at, id, text);
  return id;
}

/** A second open triple with an existing key (addTriple would sight the first instead). */
function duplicateTriple(v: V, s: string, p: string, o: string, sText: string, oText: string, at = "2026-10-01T09:00:00.000Z"): number {
  const r = v.db.prepare(`
    INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, confidence, source_fact, created_at)
    VALUES (?, ?, ?, 1.0, ?, ?)
  `).run(s, p, o, `${sText} ${p} ${oText}`, at);
  const id = Number(r.lastInsertRowid);
  v.db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, NULL, ?, ?)`).run(id, `${sText} ${p} ${oText}`, at);
  return id;
}

function mention(db: Database, e: string, doc: number, text: string | null, at: string | null = "2026-10-01 10:00:00"): number {
  return Number(db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, ?, ?)`).run(e, doc, text, at).lastInsertRowid);
}

function setCount(db: Database, e: string, n: number): void {
  db.prepare(`UPDATE entity_nodes SET mention_count = ? WHERE entity_id = ?`).run(n, e);
}

function cooc(db: Database, a: string, b: string, n: number): void {
  const [x, y] = [a, b].sort();
  db.prepare(`INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES (?, ?, ?, '2026-10-01 10:00:00')`).run(x!, y!, n);
}

const tripleOf = (db: Database, id: number) =>
  db.prepare(`SELECT subject_entity_id AS s, predicate AS p, object_entity_id AS o, valid_to AS vt, confidence AS c, source_fact AS f FROM entity_triples WHERE id = ?`).get(id) as
    { s: string; p: string; o: string | null; vt: string | null; c: number; f: string } | null;
const evidenceOf = (db: Database, tripleId: number) =>
  (db.prepare(`SELECT id FROM entity_triple_provenance WHERE triple_id = ? ORDER BY id`).all(tripleId) as { id: number }[]).map(r => r.id);
const mentionsOf = (db: Database, doc: number) =>
  db.prepare(`SELECT entity_id AS e, mention_text AS t FROM entity_mentions WHERE doc_id = ? ORDER BY entity_id`).all(doc) as { e: string; t: string | null }[];
const countOf = (db: Database, e: string) => (db.prepare(`SELECT mention_count AS n FROM entity_nodes WHERE entity_id = ?`).get(e) as { n: number } | null)?.n ?? null;
const exists = (db: Database, e: string) => !!db.prepare(`SELECT 1 FROM entity_nodes WHERE entity_id = ?`).get(e);
const ftsRows = (db: Database, e: string) => (db.prepare(`SELECT COUNT(*) AS n FROM entities_fts WHERE entity_id = ?`).get(e) as { n: number }).n;
const hasLog = (db: Database) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'entity_repair_log'`).get();
const holdOf = (plan: EntityRepairPlan, owner: string) => plan.holds.find(([o]) => o === owner)?.[1];

const TABLES = ["entity_nodes", "entities_fts", "entity_mentions", "entity_cooccurrences", "entity_triples", "entity_triple_provenance", "memory_relations"];
const dump = (db: Database) => JSON.stringify(TABLES.map(t => db.prepare(`SELECT rowid AS _rowid, * FROM ${t} ORDER BY rowid`).all()));
/** Rows as restore promises them: equal values, mention rowids aside. */
const restorable = (db: Database) => JSON.stringify([
  db.prepare(`SELECT * FROM entity_triples ORDER BY id`).all(),
  db.prepare(`SELECT * FROM entity_triple_provenance ORDER BY id`).all(),
  db.prepare(`SELECT entity_id, doc_id, mention_text, created_at FROM entity_mentions ORDER BY entity_id, doc_id`).all(),
  db.prepare(`SELECT * FROM entity_cooccurrences ORDER BY entity_a, entity_b`).all(),
  db.prepare(`SELECT entity_id, entity_type, name, mention_count, canonical_id, vault FROM entity_nodes ORDER BY entity_id`).all(),
  db.prepare(`SELECT entity_id, name, entity_type FROM entities_fts ORDER BY entity_id, name`).all(),
]);

function plan(v: V): EntityRepairPlan {
  return dryRunEntityRepair(v.path);
}

/** The common R1 case: "Node 200" written into Node 202. */
function nodeFixture(v: V) {
  const n202 = entity(v.db, "Node 202", "service");
  const linux = entity(v.db, "Linux", "concept");
  const d = v.doc("ops");
  const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: d });
  return { n202, linux, d, t, n200: makeEntityId("Node 200", "service") };
}

// =============================================================================
// 1. Dry run: one snapshot, nothing written
// =============================================================================

describe("dry run", () => {
  it("leaves every table, the vault file's bytes and its mtime unchanged", () => {
    const v = vault();
    nodeFixture(v);
    v.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = dump(v.db);
    const bytes = readFileSync(v.path);
    const mtime = statSync(v.path).mtimeMs;
    const p = plan(v);
    expect(p.answers.length).toBe(1);
    expect(dump(v.db)).toBe(before);
    expect(readFileSync(v.path).equals(bytes)).toBe(true);
    expect(statSync(v.path).mtimeMs).toBe(mtime);
  });

  it("refuses a vault whose evidence backfill has not run, and touches nothing", () => {
    const v = vault();
    nodeFixture(v);
    v.db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, source_fact) VALUES (?, 'uses', ?, NULL)`)
      .run(makeEntityId("Node 202", "service"), makeEntityId("Linux", "concept"));
    const before = dump(v.db);
    expect(() => plan(v)).toThrow(/evidence/);
    expect(dump(v.db)).toBe(before);
  });

  it("plans from one snapshot while another connection writes", () => {
    const v = vault();
    const { n202, linux } = nodeFixture(v);
    const ro = new Database(v.path, { readonly: true });
    try {
      ro.exec("BEGIN");
      ro.prepare(`SELECT 1 FROM entity_nodes LIMIT 1`).get();
      fact(v, n202, "Node 201", "runs_on", linux, "Linux", { doc: v.doc("later") }); // committed by the writer meanwhile
      const p = planEntityRepair(ro);
      ro.exec("ROLLBACK");
      expect(p.answers.map(a => a.item.surface)).toEqual(["Node 200"]);
    } finally {
      ro.close();
    }
    expect(plan(v).answers.map(a => a.item.surface).sort()).toEqual(["Node 200", "Node 201"]);
  });
});

// =============================================================================
// 2. Scope: R1 and R2 move; R3 and R4 are counted and left
// =============================================================================

describe("scope", () => {
  it("re-points R1 to a mint and R2 to the existing exact name; R3 and R4 stay; a planned mint never makes a later R4 an R2", () => {
    const v = vault();
    const { t, n200 } = nodeFixture(v);
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const redisOld = entity(v.db, "Redis", "tool");
    const redisNew = entity(v.db, "Redis", "service"); // a same-name duplicate in the bucket: R3
    const kafkaesque = entity(v.db, "Kafkaesque", "concept");
    const cluster = entity(v.db, "Node 200 Cluster", "service");
    const [d2, d3, d4, d5] = [v.doc("a"), v.doc("b"), v.doc("c"), v.doc("e")];
    mention(v.db, atlasCore, d2, "Atlas");
    mention(v.db, redisNew, d3, "Redis");
    mention(v.db, kafkaesque, d4, "Kafka");
    mention(v.db, cluster, d5, "Node 200");

    const p = plan(v);
    expect(p.counts.r1).toBe(1);
    expect(p.counts.r2).toBe(1);
    expect(p.counts.r3).toBe(1);
    expect(p.counts.r4).toBe(2); // "Kafka" and the second "Node 200"
    // sighting order: the mention (2026-10-01) precedes the fact's evidence, which addTriple stamps now
    expect(p.answers.map(a => [a.item.surface, a.to, a.minted])).toEqual([["Atlas", atlas, false], ["Node 200", n200, true]]);

    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(tripleOf(v.db, t)!.s).toBe(n200);
    expect(mentionsOf(v.db, d2)).toEqual([{ e: atlas, t: "Atlas" }]);
    expect(mentionsOf(v.db, d3)).toEqual([{ e: redisNew, t: "Redis" }]);
    expect(mentionsOf(v.db, d4)).toEqual([{ e: kafkaesque, t: "Kafka" }]);
    expect(mentionsOf(v.db, d5)).toEqual([{ e: cluster, t: "Node 200" }]); // the mint "Node 200" exists now; this link is not R2
    expect(redisOld).not.toBe(redisNew);
  });
});

// =============================================================================
// 3. The resolution copy and apply's per-answer check
// =============================================================================

describe("resolution copy", () => {
  it("refuses the plan when the copy answers an item unlike the vault", () => {
    const v = vault();
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    mention(v.db, atlasCore, v.doc("a"), "Atlas");
    const ro = new Database(v.path, { readonly: true });
    try {
      ro.exec("BEGIN");
      expect(() => planEntityRepair(ro, { testHooks: { onCopy: copy => copy.prepare(`DELETE FROM entity_nodes WHERE entity_id = ?`).run(atlas) } }))
        .toThrow(EntityRepairRefusal);
      ro.exec("ROLLBACK");
    } finally {
      ro.close();
    }
  });

  it("keeps rowid order: of two exact names in the bucket the older wins, on the copy as on the vault", () => {
    const v = vault();
    const older = entity(v.db, "Mercury", "tool");
    entity(v.db, "Mercury", "project");
    const wrong = entity(v.db, "Mercury 3", "tool");
    mention(v.db, wrong, v.doc("m"), "Mercury");
    expect(plan(v).answers.map(a => a.to)).toEqual([older]);
  });

  it("refuses a vault with planner statistics for entity_nodes, dry run and apply", () => {
    const v = vault();
    nodeFixture(v);
    v.db.exec("ANALYZE");
    expect((v.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl = 'entity_nodes'`).get() as { n: number }).n).toBeGreaterThan(0);
    expect(() => plan(v)).toThrow(/planner-statistics/);
    expect(() => applyEntityRepair(new Database(v.path))).toThrow(/planner-statistics/);
    expect(hasLog(v.db)).toBe(false);
  });

  it("reuses an orphan FTS row with the same name and type, never adding a second", () => {
    const v = vault();
    const { n200 } = nodeFixture(v);
    v.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, 'node 200', 'service')`).run(n200);
    const p = plan(v);
    expect(p.mints.map(m => m.id)).toEqual([n200]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(exists(v.db, n200)).toBe(true);
    expect(ftsRows(v.db, n200)).toBe(1);
  });

  it("holds an item whose minted id already has an FTS row with another name", () => {
    const v = vault();
    const { n200, t } = nodeFixture(v);
    v.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, 'something else', 'service')`).run(n200);
    const p = plan(v);
    expect(holdOf(p, `T${t}`)).toBe("fts-row-mismatch");
    expect(p.mints).toEqual([]);
  });

  it("apply refuses, writing nothing, when the vault answers an item unlike the plan", () => {
    const v = vault();
    const { n200 } = nodeFixture(v);
    const before = dump(v.db);
    expect(() => applyEntityRepair(new Database(v.path), {
      testHooks: { afterPlan: p => { p.answers[0]!.minted = false; p.answers[0]!.to = makeEntityId("Linux", "concept"); } },
    })).toThrow(/no longer resolves/);
    expect(exists(v.db, n200)).toBe(false);
    expect(hasLog(v.db)).toBe(false);
    expect(dump(v.db)).toBe(before);
  });

  it("apply refuses after a mint is written, and the mint goes with the rollback", () => {
    const v = vault();
    const { n200 } = nodeFixture(v); // its evidence is stamped now: the first answer, a mint
    entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    mention(v.db, atlasCore, v.doc("a"), "Atlas", "2099-01-01 00:00:00"); // the second answer, after the mint
    const before = dump(v.db);
    let shape = false;
    expect(() => applyEntityRepair(new Database(v.path), {
      testHooks: {
        afterPlan: p => {
          shape = p.answers.length === 2 && p.answers[0]!.minted && p.answers[1]!.item.surface === "Atlas";
          p.answers[1]!.to = atlasCore;
        },
      },
    })).toThrow(/no longer resolves/);
    expect(shape).toBe(true);
    expect(exists(v.db, n200)).toBe(false);
    expect(ftsRows(v.db, n200)).toBe(0);
    expect(hasLog(v.db)).toBe(false);
    expect(dump(v.db)).toBe(before);
  });
});

// =============================================================================
// 4. Sighting order and sequential resolution
// =============================================================================

describe("sighting order", () => {
  it("parses SQLite and ISO times as UTC instants; a missing or unparseable time sorts last", () => {
    expect(sightingInstant("2026-10-11 18:00:00")).toBeGreaterThan(sightingInstant("2026-10-11T08:00:00.000Z"));
    expect(sightingInstant("2026-10-11 08:00:00")).toBe(sightingInstant("2026-10-11T08:00:00Z"));
    expect(sightingInstant(null)).toBe(Infinity);
    expect(sightingInstant("yesterday")).toBe(Infinity);
  });

  it("orders items by instant, evidence before mention, row id, subject before object", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const n302 = entity(v.db, "Node 302", "service");
    const d = v.doc("o");
    fact(v, n202, "Node 200", "pairs_with", n302, "Node 300", { doc: d, at: "2026-10-11T08:00:00.000Z" });
    mention(v.db, n202, v.doc("m1"), "Node 200", "2026-10-11 18:00:00");
    mention(v.db, n302, v.doc("m2"), "Node 300", "2026-10-11 18:00:00");
    mention(v.db, n302, v.doc("m3"), "Node 301", null);
    const keys = plan(v).items.map(i => [i.kind, i.side, i.surface]);
    expect(keys).toEqual([[0, 0, "Node 200"], [0, 1, "Node 300"], [1, 0, "Node 200"], [1, 0, "Node 300"], [1, 0, "Node 301"]]);
  });

  it("mints a surface once across the tech types, with the first item's type", () => {
    const v = vault();
    const h7 = entity(v.db, "Hydra 7", "project");
    const h8 = entity(v.db, "Hydra 8", "concept");
    const linux = entity(v.db, "Linux", "concept");
    fact(v, h7, "Hydra 9", "runs_on", linux, "Linux", { doc: v.doc("a"), at: "2026-10-01T08:00:00.000Z" });
    mention(v.db, h8, v.doc("b"), "Hydra 9", "2026-10-02 08:00:00");
    const p = plan(v);
    expect(p.mints.map(m => [m.id, m.type])).toEqual([[makeEntityId("Hydra 9", "project"), "project"]]);
    expect(new Set(p.answers.map(a => a.to)).size).toBe(1);
  });

  it("resolves a later item to an earlier mint as the real resolver would (fuzzy, same digits)", () => {
    const v = vault();
    const w201 = entity(v.db, "Worker Node 201", "service");
    const d = v.doc("w");
    mention(v.db, w201, d, "Worker Node 200", "2026-10-01 08:00:00");
    mention(v.db, w201, v.doc("w2"), "Workers Node 200", "2026-10-02 08:00:00");
    const p = plan(v);
    expect(p.mints.map(m => m.name)).toEqual(["Worker Node 200"]);
    expect(p.answers[1]!.to).toBe(p.mints[0]!.id);
    expect(p.answers[1]!.fuzzy).toBe(true);
  });

  it("holds a slug collision with an existing entity and with an earlier mint", () => {
    const v = vault();
    entity(v.db, "C++ 200", "tool"); // slug default:tool:c_200
    const c201 = entity(v.db, "C# 201", "tool");
    const dA = v.doc("a");
    mention(v.db, c201, dA, "C# 200");
    let p = plan(v);
    expect(holdOf(p, `M${dA}:${c201}`)).toBe("slug-collision");

    const w = vault();
    const k201 = entity(w.db, "K 201", "tool");
    const [x, y] = [w.doc("x"), w.doc("y")];
    mention(w.db, k201, x, "C# 200", "2026-10-01 08:00:00");
    mention(w.db, k201, y, "C++ 200", "2026-10-02 08:00:00");
    p = plan(w);
    expect(p.mints.map(m => m.name)).toEqual(["C# 200"]);
    expect(holdOf(p, `M${y}:${k201}`)).toBe("slug-collision");
  });
});

describe("sequential resolution", () => {
  it("a later item sees an earlier mint: a closer minted name beats an older snapshot match (Omega/Alpha)", () => {
    const v = vault();
    const omega = entity(v.db, "Omega Node 300", "tool");
    const wrong = entity(v.db, "Omega Node 301", "tool");
    mention(v.db, wrong, v.doc("a"), "Alpha Node 300", "2026-10-01 08:00:00"); // 0.714 to Omega: mints
    mention(v.db, wrong, v.doc("b"), "Alpga Node 300", "2026-10-02 08:00:00"); // 0.786 to Omega, 0.929 to the mint
    const p = plan(v);
    expect(p.mints.map(m => m.name)).toEqual(["Alpha Node 300"]);
    expect(p.answers[1]!.to).toBe(p.mints[0]!.id);
    expect(p.answers[1]!.to).not.toBe(omega);
  });

  it("a mint is found only the way the resolver finds it: Catherine never reaches a minted Katherine", () => {
    const v = vault();
    const k2 = entity(v.db, "Katherine 2", "person");
    const c2 = entity(v.db, "Catherine 2", "person");
    mention(v.db, k2, v.doc("a"), "Katherine", "2026-10-01 08:00:00");
    mention(v.db, c2, v.doc("b"), "Catherine", "2026-10-02 08:00:00");
    const p = plan(v);
    expect(p.mints.map(m => m.name)).toEqual(["Katherine", "Catherine"]);
  });

  it("a mint that fills the FTS pool hides the prefix supplement from a later item, exactly as on the vault", () => {
    const v = vault();
    for (let i = 1; i <= 19; i++) entity(v.db, `Worker ${i}`, "tool");
    const workers = entity(v.db, "Workers", "tool");
    const n5 = entity(v.db, "Node 5", "tool");
    const n6 = entity(v.db, "Node 6", "tool");
    mention(v.db, n5, v.doc("a"), "Worker 999", "2026-10-01 08:00:00");
    mention(v.db, n6, v.doc("b"), "Worker", "2026-10-02 08:00:00");
    const p = plan(v);
    // before the mint "worker" reaches Workers through the prefix supplement; after it, 20 exact-token rows fill the pool
    expect(p.mints.map(m => m.name)).toEqual(["Worker 999", "Worker"]);
    expect(p.answers.some(a => a.to === workers)).toBe(false);
    const r = applyEntityRepair(new Database(v.path), { expect: p.digest }); // apply's per-answer check agrees on the vault
    expect(r.written.mints).toBe(2);
  });

  it("an orphan FTS row for a planned mint is reused, so the prefix candidate stays reachable (76.6)", () => {
    const v = vault();
    for (let i = 1; i <= 18; i++) entity(v.db, `Worker ${i}`, "tool");
    const workers = entity(v.db, "Workers", "tool");
    const n5 = entity(v.db, "Node 5", "tool");
    const n6 = entity(v.db, "Node 6", "tool");
    const w999 = makeEntityId("Worker 999", "tool");
    v.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, 'worker 999', 'tool')`).run(w999);
    mention(v.db, n5, v.doc("a"), "Worker 999", "2026-10-01 08:00:00");
    mention(v.db, n6, v.doc("b"), "Worker", "2026-10-02 08:00:00");
    const p = plan(v);
    expect(p.answers.map(a => [a.to, a.minted])).toEqual([[w999, true], [workers, false]]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(ftsRows(v.db, w999)).toBe(1);
  });
});

// =============================================================================
// 5. Holds
// =============================================================================

describe("holds", () => {
  it("cross-bucket: the surface names an entity of another bucket exactly", () => {
    const v = vault();
    entity(v.db, "Mercury 2", "person");
    const m3 = entity(v.db, "Mercury 3", "tool");
    const d = v.doc("x");
    mention(v.db, m3, d, "Mercury 2");
    expect(holdOf(plan(v), `M${d}:${m3}`)).toBe("cross-bucket");
  });

  it("alias-only: the FTS row that matched names another entity", () => {
    const v = vault();
    const base = entity(v.db, "Delta Base", "tool");
    v.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, 'delta 7', 'tool')`).run(base);
    const d8 = entity(v.db, "Delta 8", "tool");
    const d = v.doc("x");
    mention(v.db, d8, d, "Delta 7");
    expect(holdOf(plan(v), `M${d}:${d8}`)).toBe("alias-only");
  });

  it("resolver-still-linked: today's resolver still answers the linked entity", () => {
    const v = vault();
    const n22 = entity(v.db, "Node 22", "service");
    v.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, 'node 2', 'service')`).run(n22);
    const d = v.doc("x");
    mention(v.db, n22, d, "Node 2");
    expect(holdOf(plan(v), `M${d}:${n22}`)).toBe("resolver-still-linked");
  });

  it("predicate twice: a fact whose split is ambiguous holds its triple", () => {
    const v = vault();
    const t9 = entity(v.db, "Tool 9", "tool");
    const t2 = entity(v.db, "Tool 2", "tool");
    const t = fact(v, t9, "Tool 1 uses", "uses", t2, "Tool 2", { doc: v.doc("x") });
    expect(holdOf(plan(v), `T${t}`)).toBe("predicate-twice");
  });

  it("a triple whose object is held after its subject minted: the re-run drops that mint, and a later item that used it mints its own", () => {
    const v = vault();
    entity(v.db, "C++ 300", "tool");
    const g6 = entity(v.db, "Gamma 6", "tool");
    const g7 = entity(v.db, "Gamma 7", "tool");
    const c301 = entity(v.db, "C# 301", "tool");
    const t = fact(v, g6, "Gamma 5", "links", c301, "C# 300", { doc: v.doc("x"), at: "2026-10-01T08:00:00.000Z" });
    const d = v.doc("later");
    mention(v.db, g7, d, "Gamma 5", "2026-10-02 08:00:00"); // the first run resolves it to the triple's mint
    const p = plan(v);
    expect(holdOf(p, `T${t}`)).toBe("slug-collision");
    expect(p.runs).toBe(2);
    const g5 = makeEntityId("Gamma 5", "tool");
    expect(p.mints.map(m => m.id)).toEqual([g5]);
    expect(p.answers.map(a => [a.item.key, a.to, a.minted])).toEqual([[`M${d}:${g7}`, g5, true]]);
  });

  it("counts only the links acted on; the held triples and mentions apart", () => {
    const v = vault();
    entity(v.db, "C++ 300", "tool");
    const g6 = entity(v.db, "Gamma 6", "tool");
    const c301 = entity(v.db, "C# 301", "tool");
    fact(v, g6, "Gamma 5", "links", c301, "C# 300", { doc: v.doc("x") });
    const { counts } = plan(v);
    expect([counts.r1, counts.r2, counts.held]).toEqual([0, 0, 1]); // one triple held, its two R1 links not acted on
  });

  it("alias-only: the guard reads the entity's own name as the resolver does, lowercased and untrimmed", () => {
    const v = vault();
    const padded = entity(v.db, "Node 200    ", "service");
    v.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, 'nodee 200', 'service')`).run(padded); // an alias row
    const n201 = entity(v.db, "Node 201", "service");
    const d = v.doc("x");
    mention(v.db, n201, d, "Nodee 200"); // the alias answers it; "node 200    " itself is 0.58 from it, under the bar
    expect(holdOf(plan(v), `M${d}:${n201}`)).toBe("alias-only");
  });
});

// =============================================================================
// 6–7. Allocation and evidence collapse
// =============================================================================

describe("allocation", () => {
  it("a triple splitting into two new keys keeps its id for the earlier one and gets one new triple", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("a"), at: "2026-10-01T08:00:00.000Z" });
    fact(v, n202, "Node 201", "runs_on", linux, "Linux", { doc: v.doc("b"), at: "2026-10-02T08:00:00.000Z" });
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor])).toEqual([["repoint", t], ["new", null]]);
    const r = applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(tripleOf(v.db, t)!.s).toBe(makeEntityId("Node 200", "service"));
    const fresh = v.db.prepare(`SELECT id FROM entity_triples WHERE subject_entity_id = ?`).get(makeEntityId("Node 201", "service")) as { id: number };
    expect(evidenceOf(v.db, t).length).toBe(1);
    expect(evidenceOf(v.db, fresh.id).length).toBe(1);
    expect(r.newTriples).toEqual([{ group: 1, id: fresh.id }]); // the report names the id the new triple got
  });

  it("the unchanged part of a split keeps the id and key even when the changed evidence comes first", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("a"), at: "2026-10-01T08:00:00.000Z" });
    fact(v, n202, "Node 202", "runs_on", linux, "Linux", { doc: v.doc("b"), at: "2026-10-02T08:00:00.000Z" });
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor])).toEqual([["new", null], ["keep", t]]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(tripleOf(v.db, t)!.s).toBe(n202);
  });

  it("merges into an untouched triple that already carries the key", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const u = fact(v, n200, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("u") });
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("t") });
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor])).toEqual([["merge", u]]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(tripleOf(v.db, t)).toBeNull();
    expect(evidenceOf(v.db, u).length).toBe(2);
  });

  it("holds a group whose key only a held triple carries, leaving the held triple untouched", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const h = fact(v, n200, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("h") });
    v.db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, NULL, 'Node 201 runs_on runs_on Linux', '2026-10-01T08:00:00.000Z')`).run(h);
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("t") });
    const p = plan(v);
    expect(holdOf(p, `T${h}`)).toBe("predicate-twice");
    expect(holdOf(p, `T${t}`)).toBe("key-of-held-triple");
    expect(p.groups).toEqual([]);
  });

  it("merges into the untouched carrier when a held triple carries the same key", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const h = fact(v, n200, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("h") });
    v.db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, NULL, 'Node 201 runs_on runs_on Linux', '2026-10-01T08:00:00.000Z')`).run(h);
    const u = duplicateTriple(v, n200, "runs_on", linux, "Node 200", "Linux");
    fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("t") });
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor])).toEqual([["merge", u]]);
  });

  it("an unchanged group keeps its own member though a held duplicate carries its key", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("a"), at: "2026-10-01T08:00:00.000Z" });
    fact(v, n202, "Node 202", "runs_on", linux, "Linux", { doc: v.doc("b"), at: "2026-10-02T08:00:00.000Z" });
    const h = duplicateTriple(v, n202, "runs_on", linux, "Node 202", "Linux");
    v.db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, NULL, 'Node 203 runs_on runs_on Linux', '2026-10-01T08:00:00.000Z')`).run(h);
    const p = plan(v);
    expect(holdOf(p, `T${h}`)).toBe("predicate-twice");
    expect(holdOf(p, `T${t}`)).toBeUndefined();
    expect(p.groups.find(g => g.action === "keep")?.survivor).toBe(t);
  });

  // One open triple per subject, predicate and object, as addTriple keeps it: grouping by the full key keeps validity
  // apart, and a group that would add a second open triple for a key is held
  const validFrom = (db: Database, id: number, at: string) => db.prepare(`UPDATE entity_triples SET valid_from = ? WHERE id = ?`).run(at, id);

  it("holds a repaired triple that would open beside an untouched one differing only in valid_from", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    fact(v, n200, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("u") });
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("t") });
    validFrom(v.db, t, "2026-01-01");
    const p = plan(v);
    expect(holdOf(p, `T${t}`)).toBe("open-key-taken");
    expect(p.groups).toEqual([]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(tripleOf(v.db, t)!.s).toBe(n202);
  });

  it("holds both of two repaired triples that would open on one key with different valid_from", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const linux = entity(v.db, "Linux", "concept");
    const t1 = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("a") });
    const t2 = fact(v, n203, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("b") });
    validFrom(v.db, t1, "2026-01-01");
    validFrom(v.db, t2, "2026-02-01");
    const p = plan(v);
    expect([holdOf(p, `T${t1}`), holdOf(p, `T${t2}`)]).toEqual(["open-key-taken", "open-key-taken"]);
    expect([p.groups, p.mints]).toEqual([[], []]);
  });

  it("a held triple keeps its key occupied: the triple chained onto that key is held in the next run", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const n205 = entity(v.db, "Node 205", "service");
    const linux = entity(v.db, "Linux", "concept");
    const t1 = fact(v, n200, "Node 202", "runs_on", linux, "Linux", { doc: v.doc("a") }); // moves onto t2's key
    const t2 = fact(v, n202, "Node 205", "runs_on", linux, "Linux", { doc: v.doc("b") }); // moves on, to Node 205
    validFrom(v.db, t2, "2026-04-01");
    const u = duplicateTriple(v, n205, "runs_on", linux, "Node 205", "Linux");
    validFrom(v.db, u, "2026-03-01"); // t2 would open beside it
    const p = plan(v);
    expect([holdOf(p, `T${t2}`), holdOf(p, `T${t1}`), p.runs]).toEqual(["open-key-taken", "open-key-taken", 3]);
    expect(p.groups).toEqual([]);
  });

  it("swaps a two-triple cycle on full keys, and the restore swaps it back", () => {
    const v = vault();
    const orion = entity(v.db, "Orion", "project");
    const lyra = entity(v.db, "Lyra", "project");
    const linux = entity(v.db, "Linux", "concept");
    const a = fact(v, orion, "Lyra", "runs_on", linux, "Linux", { doc: v.doc("a") });
    const b = fact(v, lyra, "Orion", "runs_on", linux, "Linux", { doc: v.doc("b") });
    const before = restorable(v.db);
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor, g.key])).toEqual([
      ["repoint", a, [lyra, "runs_on", linux, null, null, null]], // b's whole key before the repair, validity included
      ["repoint", b, [orion, "runs_on", linux, null, null, null]],
    ]);
    const r = applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect([tripleOf(v.db, a)!.s, tripleOf(v.db, b)!.s]).toEqual([lyra, orion]);
    expect(restoreEntityRepair(new Database(v.path), r.opId).kept).toEqual([]);
    expect(restorable(v.db)).toBe(before);
  });

  it("a re-pointed closed triple keeps its validity", () => {
    const v = vault();
    const { t, n200 } = nodeFixture(v);
    v.db.prepare(`UPDATE entity_triples SET valid_to = '2026-09-30' WHERE id = ?`).run(t);
    const p = plan(v);
    expect(p.groups.map(g => g.key[5])).toEqual(["2026-09-30"]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(tripleOf(v.db, t)).toMatchObject({ s: n200, vt: "2026-09-30" });
  });

  it("a chain: one triple moves onto a second's old key while the second moves on; the restore reverses both", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const n205 = entity(v.db, "Node 205", "service");
    const linux = entity(v.db, "Linux", "concept");
    const t1 = fact(v, n200, "Node 202", "runs_on", linux, "Linux", { doc: v.doc("a") });
    const t2 = fact(v, n202, "Node 205", "runs_on", linux, "Linux", { doc: v.doc("b") });
    const before = restorable(v.db);
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor, g.key[0]])).toEqual([["repoint", t1, n202], ["repoint", t2, n205]]);
    const r = applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect([tripleOf(v.db, t1)!.s, tripleOf(v.db, t2)!.s]).toEqual([n202, n205]);
    expect(restoreEntityRepair(new Database(v.path), r.opId).kept).toEqual([]);
    expect(restorable(v.db)).toBe(before);
  });

  /**
   * Two equal evidence rows (one document, one fact) on two triples, landing in two final groups: sequential resolution
   * sends T1's early "Alpga Node 300" to Omega Node 300; a mint in between sends T2's later one to Alpha Node 300.
   */
  function crossingFixture(v: V) {
    const omega300 = entity(v.db, "Omega Node 300", "service");
    const omega301 = entity(v.db, "Omega Node 301", "service");
    const omega303 = entity(v.db, "Omega Node 303", "service");
    const alpha301 = entity(v.db, "Alpha Node 301", "service");
    const linux = entity(v.db, "Linux", "concept");
    const d = v.doc("shared");
    const t1 = fact(v, omega301, "Omega Node 301", "runs_on", linux, "Linux", { doc: v.doc("a"), at: "2026-10-01T07:00:00.000Z" });
    fact(v, omega301, "Alpga Node 300", "runs_on", linux, "Linux", { doc: d, at: "2026-10-01T08:00:00.000Z" });
    mention(v.db, alpha301, v.doc("m"), "Alpha Node 300", "2026-10-01 09:00:00"); // mints Alpha Node 300
    const t2 = fact(v, omega303, "Omega Node 300", "runs_on", linux, "Linux", { doc: v.doc("b"), at: "2026-10-01T11:00:00.000Z" });
    fact(v, omega303, "Alpga Node 300", "runs_on", linux, "Linux", { doc: d, at: "2026-10-01T10:00:00.000Z" });
    return { omega300, omega301, alpha300: makeEntityId("Alpha Node 300", "service"), t1, t2 };
  }
  const factsOn = (db: Database, id: number) =>
    (db.prepare(`SELECT source_fact AS f FROM entity_triple_provenance WHERE triple_id = ? ORDER BY id`).all(id) as { f: string }[]).map(x => x.f);

  it("a row moves onto a triple an equal row has yet to leave: every moving row leaves before any arrives", () => {
    const v = vault();
    const { omega300, omega301, alpha300, t1, t2 } = crossingFixture(v);
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor, g.key[0]])).toEqual([["keep", t1, omega301], ["repoint", t2, omega300], ["new", null, alpha300]]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    const n = (v.db.prepare(`SELECT id FROM entity_triples WHERE subject_entity_id = ?`).get(alpha300) as { id: number }).id;
    expect(factsOn(v.db, t1)).toEqual(["Omega Node 301 runs_on Linux"]);
    expect(factsOn(v.db, t2)).toEqual(["Alpga Node 300 runs_on Linux", "Omega Node 300 runs_on Linux"]);
    expect(factsOn(v.db, n)).toEqual(["Alpga Node 300 runs_on Linux"]);
  });

  it("the restore moves them back whatever the logged order: every row leaves before any arrives", () => {
    const v = vault();
    const { t1 } = crossingFixture(v);
    const before = restorable(v.db);
    const r = applyEntityRepair(new Database(v.path));
    // log T1's row (moved onto T2) last: undone in log order, T2's equal row would come back while T1's still sits there
    const moves = v.db.prepare(`SELECT id, old_row FROM entity_repair_log WHERE op_id = ? AND action = 'evidence-move' ORDER BY id`).all(r.opId) as { id: number; old_row: string }[];
    const fromT1 = moves.find(m => (JSON.parse(m.old_row) as { triple_id: number }).triple_id === t1)!;
    v.db.prepare(`UPDATE entity_repair_log SET id = (SELECT MAX(id) + 1 FROM entity_repair_log) WHERE id = ?`).run(fromT1.id);
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept).toEqual([]);
    expect(restorable(v.db)).toBe(before);
  });

  it("collapses equal evidence to the earliest sighting; the survivor takes its inline fields and the highest confidence", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const linux = entity(v.db, "Linux", "concept");
    const d = v.doc("same");
    const t1 = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: d, at: "2026-10-02T08:00:00.000Z" });
    const t2 = fact(v, n203, "Node 200", "runs_on", linux, "Linux", { doc: d, at: "2026-10-01T08:00:00.000Z" });
    v.db.prepare(`UPDATE entity_triples SET confidence = 0.7 WHERE id = ?`).run(t1);
    v.db.prepare(`UPDATE entity_triples SET confidence = 0.9 WHERE id = ?`).run(t2);
    const e2 = evidenceOf(v.db, t2)[0]!;
    const p = plan(v);
    expect(p.groups.map(g => [g.action, g.survivor])).toEqual([["repoint", t2]]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(tripleOf(v.db, t1)).toBeNull();
    expect(evidenceOf(v.db, t2)).toEqual([e2]);
    expect(tripleOf(v.db, t2)!.c).toBe(0.9);
    expect(v.db.prepare(`SELECT created_at AS at FROM entity_triples WHERE id = ?`).get(t2)).toEqual({ at: "2026-10-01T08:00:00.000Z" });
  });
});

// =============================================================================
// 8. Mentions
// =============================================================================

describe("mentions", () => {
  it("converges two rows on one mint: the earliest incoming row's text wins; counts and pairs change once", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const linux = entity(v.db, "Linux", "concept");
    const d = v.doc("x");
    mention(v.db, n202, d, "Node 200", "2026-10-02 08:00:00");
    mention(v.db, n203, d, "node 200", "2026-10-01 08:00:00");
    mention(v.db, linux, d, "Linux");
    setCount(v.db, n202, 3);
    setCount(v.db, n203, 1);
    setCount(v.db, linux, 5);
    cooc(v.db, n202, n203, 1);
    cooc(v.db, n202, linux, 2);
    cooc(v.db, n203, linux, 1);
    const p = plan(v);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    const n200 = makeEntityId("Node 200", "service");
    // the earliest incoming row (Node 203's, 2026-10-01) mints with its own text and keeps it at the destination
    expect(mentionsOf(v.db, d)).toEqual([{ e: n200, t: "node 200" }, { e: linux, t: "Linux" }].sort((a, b) => (a.e < b.e ? -1 : 1)));
    expect(p.mints.map(m => m.name)).toEqual(["node 200"]);
    expect([countOf(v.db, n200), countOf(v.db, n202), countOf(v.db, n203), countOf(v.db, linux)]).toEqual([1, 2, 0, 5]);
    const pairs = v.db.prepare(`SELECT entity_a || '|' || entity_b AS k, count FROM entity_cooccurrences ORDER BY k`).all();
    expect(pairs).toEqual([
      { k: [n200, linux].sort().join("|"), count: 1 },
      { k: [n202, linux].sort().join("|"), count: 1 },
    ].sort((a, b) => (a.k < b.k ? -1 : 1)));
  });

  it("a destination's staying row wins: the incoming row is dropped, nothing inserted", () => {
    const v = vault();
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const d = v.doc("x");
    mention(v.db, atlas, d, "Atlas");
    mention(v.db, atlasCore, d, "Atlas");
    const p = plan(v);
    expect(p.mentionDocs[0]!.inserts).toEqual([]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(mentionsOf(v.db, d)).toEqual([{ e: atlas, t: "Atlas" }]);
  });

  it("a chain (Rack 302's row says Rack 300, Rack 305's row says Rack 302) ends with the right text at each destination", () => {
    const v = vault();
    const rack300 = entity(v.db, "Rack 300", "location");
    const rack302 = entity(v.db, "Rack 302", "location");
    const rack305 = entity(v.db, "Rack 305", "location");
    const d = v.doc("x");
    mention(v.db, rack302, d, "Rack 300");
    mention(v.db, rack305, d, "Rack 302");
    applyEntityRepair(new Database(v.path), { expect: plan(v).digest });
    expect(mentionsOf(v.db, d)).toEqual([{ e: rack300, t: "Rack 300" }, { e: rack302, t: "Rack 302" }]);
    expect(exists(v.db, rack305)).toBe(true);
  });

  it("a two-row cycle writes without a key conflict; winners get fresh rowids in the original order", () => {
    const v = vault();
    const orion = entity(v.db, "Orion", "project");
    const lyra = entity(v.db, "Lyra", "project");
    const d = v.doc("x");
    mention(v.db, orion, d, "Lyra");
    mention(v.db, lyra, d, "Orion");
    const p = plan(v);
    expect(p.mentionDocs[0]!.after).toEqual([lyra, orion]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(mentionsOf(v.db, d)).toEqual([{ e: lyra, t: "Lyra" }, { e: orion, t: "Orion" }].sort((a, b) => (a.e < b.e ? -1 : 1)));
  });

  it("reports, without keeping, a mention whose document still names the old entity", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const d = v.doc("x", "Node 200 replaced Node 202 last week.");
    mention(v.db, n202, d, "Node 200");
    const p = plan(v);
    expect(p.mentionDocs[0]!.mayAlsoMention).toEqual([n202]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(mentionsOf(v.db, d)).toEqual([{ e: makeEntityId("Node 200", "service"), t: "Node 200" }]);
  });

  /** D1 {Orion, Linux} becomes {Lyra, Linux} and D2 {Lyra, Linux} becomes {Orion, Linux}: one document drops each pair, the other makes it again. */
  function exchangeFixture(v: V) {
    const orion = entity(v.db, "Orion", "project");
    const lyra = entity(v.db, "Lyra", "project");
    const linux = entity(v.db, "Linux", "concept");
    const [d1, d2] = [v.doc("d1"), v.doc("d2")];
    mention(v.db, orion, d1, "Lyra");
    mention(v.db, linux, d1, "Linux");
    mention(v.db, lyra, d2, "Orion");
    mention(v.db, linux, d2, "Linux");
    setCount(v.db, orion, 1);
    setCount(v.db, lyra, 1);
    setCount(v.db, linux, 2);
    cooc(v.db, orion, linux, 1);
    cooc(v.db, lyra, linux, 1);
    return { orion, lyra, linux, d1, d2 };
  }
  const pairRow = (db: Database, a: string, b: string) =>
    db.prepare(`SELECT count, last_cooccurred AS at FROM entity_cooccurrences WHERE entity_a = ? AND entity_b = ?`).get(...([a, b].sort() as [string, string])) as { count: number; at: string | null } | null;

  it("a cross-document exchange keeps each pair's last_cooccurred, and the restore gives every row back", () => {
    const v = vault();
    const { orion, lyra, linux } = exchangeFixture(v);
    const before = restorable(v.db);
    const r = applyEntityRepair(new Database(v.path));
    expect(pairRow(v.db, orion, linux)).toEqual({ count: 1, at: "2026-10-01 10:00:00" });
    expect(pairRow(v.db, lyra, linux)).toEqual({ count: 1, at: "2026-10-01 10:00:00" });
    expect(restoreEntityRepair(new Database(v.path), r.opId).kept).toEqual([]);
    expect(restorable(v.db)).toBe(before);
  });

  it("a pair with no last_cooccurred keeps none through the exchange, the round trip and a partial restore", () => {
    for (const partial of [false, true]) {
      const v = vault();
      const { orion, linux, d1, d2 } = exchangeFixture(v);
      v.db.prepare(`UPDATE entity_cooccurrences SET last_cooccurred = NULL WHERE entity_a = ? AND entity_b = ?`).run(...([orion, linux].sort() as [string, string]));
      const before = restorable(v.db);
      const r = applyEntityRepair(new Database(v.path));
      expect(pairRow(v.db, orion, linux)).toEqual({ count: 1, at: null }); // deleted by D1, made again by D2
      if (partial) mention(v.db, entity(v.db, "Hermes", "tool"), d2, "Hermes"); // D2 re-extracted: its component stays
      const back = restoreEntityRepair(new Database(v.path), r.opId);
      if (partial) {
        expect(back.restored).toEqual([`M${d1}`]);
        expect(pairRow(v.db, orion, linux)).toEqual({ count: 2, at: null });
      } else {
        expect(back.kept).toEqual([]);
        expect(restorable(v.db)).toBe(before);
      }
    }
  });

  it("a partial restore of an exchange raises a pair with its time from before the repair", () => {
    const v = vault();
    const { orion, lyra, linux, d1, d2 } = exchangeFixture(v);
    const r = applyEntityRepair(new Database(v.path));
    mention(v.db, entity(v.db, "Hermes", "tool"), d2, "Hermes"); // D2 re-extracted: its component stays
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.restored).toEqual([`M${d1}`]);
    expect(pairRow(v.db, orion, linux)).toEqual({ count: 2, at: "2026-10-01 10:00:00" }); // D1 and D2 both name Orion again
    expect(pairRow(v.db, lyra, linux)).toBeNull();
  });
});

// =============================================================================
// 10. Apply
// =============================================================================

describe("apply", () => {
  it("refuses a vault needing the backfill, writing nothing", () => {
    const v = vault();
    nodeFixture(v);
    v.db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id) VALUES (?, 'uses', ?)`)
      .run(makeEntityId("Node 202", "service"), makeEntityId("Linux", "concept"));
    const before = dump(v.db);
    expect(() => applyEntityRepair(new Database(v.path))).toThrow(/evidence/);
    expect(dump(v.db)).toBe(before);
    expect(hasLog(v.db)).toBe(false);
  });

  it("an --expect mismatch writes nothing, not even the log table", () => {
    const v = vault();
    nodeFixture(v);
    const before = dump(v.db);
    expect(() => applyEntityRepair(new Database(v.path), { expect: "0".repeat(64) })).toThrow(/digest/);
    expect(dump(v.db)).toBe(before);
    expect(hasLog(v.db)).toBe(false);
  });

  it("the digest ignores activity elsewhere in the vault and follows the repair's decisions", () => {
    const v = vault();
    const { n202, linux } = nodeFixture(v);
    const first = plan(v).digest;
    entity(v.db, "Unrelated", "concept");
    mention(v.db, linux, v.doc("other"), "Linux");
    expect(plan(v).digest).toBe(first);
    fact(v, n202, "Node 201", "runs_on", linux, "Linux", { doc: v.doc("new") });
    expect(plan(v).digest).not.toBe(first);
  });

  it("the digest binds the stored times that order the plan and each repaired link's old endpoint", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const linux = entity(v.db, "Linux", "concept");
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("a"), at: "2026-10-01T08:00:00.000Z" });
    fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("b"), at: "2026-10-02T08:00:00.000Z" });
    const first = plan(v).digest;
    // the later evidence row's time moves; the order does not
    v.db.prepare(`UPDATE entity_triple_provenance SET created_at = '2026-10-03T08:00:00.000Z' WHERE triple_id = ? AND created_at = '2026-10-02T08:00:00.000Z'`).run(t);
    const second = plan(v).digest;
    expect(second).not.toBe(first);
    // the same facts written into another wrong entity: the same answers and allocation, another change
    v.db.prepare(`UPDATE entity_triples SET subject_entity_id = ? WHERE id = ?`).run(n203, t);
    expect(plan(v).digest).not.toBe(second);
  });

  it("the digest binds a collapsing mention's time", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const d = v.doc("x");
    mention(v.db, n202, d, "Node 200", "2026-10-02 08:00:00"); // the loser: the later incoming row
    mention(v.db, n203, d, "node 200", "2026-10-01 08:00:00");
    const first = plan(v).digest;
    v.db.prepare(`UPDATE entity_mentions SET created_at = '2026-10-03 08:00:00' WHERE entity_id = ? AND doc_id = ?`).run(n202, d);
    expect(plan(v).digest).not.toBe(first);
  });
});

// =============================================================================
// 11. Restore
// =============================================================================

describe("restore", () => {
  function richFixture(v: V) {
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const [a, b, c] = [v.doc("a"), v.doc("b"), v.doc("c")];
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: a, at: "2026-10-01T08:00:00.000Z" });
    fact(v, n202, "Node 201", "runs_on", linux, "Linux", { doc: b, at: "2026-10-02T08:00:00.000Z" });
    mention(v.db, atlasCore, c, "Atlas");
    mention(v.db, linux, c, "Linux");
    setCount(v.db, atlasCore, 1);
    setCount(v.db, linux, 1);
    cooc(v.db, atlasCore, linux, 1);
    return { n202, linux, atlas, atlasCore, a, b, c, t };
  }

  it("round trip: every touched table equals its pre-apply rows; unreferenced mints go with their FTS rows", () => {
    const v = vault();
    richFixture(v);
    const before = restorable(v.db);
    const r = applyEntityRepair(new Database(v.path));
    expect(restorable(v.db)).not.toBe(before);
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept).toEqual([]);
    expect(back.mintsDeleted.sort()).toEqual([makeEntityId("Node 200", "service"), makeEntityId("Node 201", "service")].sort());
    expect(restorable(v.db)).toBe(before);
  });

  it("a later sighting on one split child keeps the whole triple component", () => {
    const v = vault();
    const { linux, c } = richFixture(v);
    const r = applyEntityRepair(new Database(v.path));
    const n201 = makeEntityId("Node 201", "service");
    fact(v, n201, "Node 201", "runs_on", linux, "Linux", { doc: v.doc("later") });
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept.map(k => k.comp)).toHaveLength(1);
    expect(back.restored).toEqual([`M${c}`]);
    expect(exists(v.db, n201)).toBe(true); // still referenced
  });

  it("two repaired triples sharing one mint: a later sighting on one keeps it, the other still restores", () => {
    const v = vault();
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const linux = entity(v.db, "Linux", "concept");
    const docker = entity(v.db, "Docker", "tool");
    const t1 = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("a") });
    const t2 = fact(v, n203, "Node 200", "uses", docker, "Docker", { doc: v.doc("b") });
    const r = applyEntityRepair(new Database(v.path));
    const n200 = makeEntityId("Node 200", "service");
    fact(v, n200, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("later") });
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.restored).toEqual([`T${t2}`]);
    expect(back.kept.map(k => k.comp)).toEqual([`T${t1}`]);
    expect(tripleOf(v.db, t2)!.s).toBe(n203);
    expect(exists(v.db, n200)).toBe(true);
  });

  it("counts reverse by delta after later counting", () => {
    const v = vault();
    const { atlas, atlasCore } = richFixture(v);
    const r = applyEntityRepair(new Database(v.path));
    expect(countOf(v.db, atlas)).toBe(1);
    v.db.prepare(`UPDATE entity_nodes SET mention_count = mention_count + 4 WHERE entity_id = ?`).run(atlas); // later enrichment elsewhere
    restoreEntityRepair(new Database(v.path), r.opId);
    expect(countOf(v.db, atlas)).toBe(4);
    expect(countOf(v.db, atlasCore)).toBe(1);
  });

  it("keeps a mint that another node's canonical_id names", () => {
    const v = vault();
    nodeFixture(v);
    const r = applyEntityRepair(new Database(v.path));
    const n200 = makeEntityId("Node 200", "service");
    entity(v.db, "Node Two Hundred", "service");
    v.db.prepare(`UPDATE entity_nodes SET canonical_id = ? WHERE entity_id = ?`).run(n200, makeEntityId("Node Two Hundred", "service"));
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.mintsKept).toEqual([n200]);
    expect(exists(v.db, n200)).toBe(true);
  });

  it("restores a two-row mention cycle", () => {
    const v = vault();
    const orion = entity(v.db, "Orion", "project");
    const lyra = entity(v.db, "Lyra", "project");
    const d = v.doc("x");
    mention(v.db, orion, d, "Lyra");
    mention(v.db, lyra, d, "Orion");
    const before = restorable(v.db);
    const r = applyEntityRepair(new Database(v.path));
    restoreEntityRepair(new Database(v.path), r.opId);
    expect(restorable(v.db)).toBe(before);
  });

  it("a later re-extraction of a repaired document keeps that document's component", () => {
    const v = vault();
    const { c } = richFixture(v);
    const r = applyEntityRepair(new Database(v.path));
    mention(v.db, entity(v.db, "Hermes", "tool"), c, "Hermes"); // a later extraction adds an entity
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept.map(k => k.comp)).toEqual([`M${c}`]);
  });

  it("a mention collapsed into a staying row, then the document re-extracted with no entities: nothing is resurrected", () => {
    const v = vault();
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const d = v.doc("x");
    mention(v.db, atlas, d, "Atlas");
    mention(v.db, atlasCore, d, "Atlas");
    const r = applyEntityRepair(new Database(v.path));
    v.db.prepare(`DELETE FROM entity_mentions WHERE doc_id = ?`).run(d); // re-extraction found no entities
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept.map(k => k.comp)).toEqual([`M${d}`]);
    expect(mentionsOf(v.db, d)).toEqual([]);
  });

  it("a merge carrier the repair left unchanged, closed afterwards: its component stays as the repair left it", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const u = fact(v, n200, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("u"), at: "2026-10-01T08:00:00.000Z" });
    v.db.prepare(`UPDATE entity_triples SET created_at = '2026-10-01T08:00:00.000Z' WHERE id = ?`).run(u); // its inline fields are already the earliest
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("t"), at: "2026-10-02T08:00:00.000Z" });
    const r = applyEntityRepair(new Database(v.path));
    expect(r.written.triplesUpdated).toBe(0); // the carrier's own row did not change
    v.store.invalidateTriple(n200, "runs_on", linux, null, "2026-10-12");
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept.map(k => k.comp)).toEqual([`T${u}`]);
    expect(tripleOf(v.db, t)).toBeNull();
    expect(tripleOf(v.db, u)!.vt).toBe("2026-10-12");
  });

  // One open triple per subject, predicate and object, as addTriple keeps it: a restore never gives a key back beside a
  // triple that took it since
  const openCarriers = (db: Database, s: string, p: string, o: string) =>
    (db.prepare(`SELECT id FROM entity_triples WHERE subject_entity_id = ? AND predicate = ? AND object_entity_id = ? AND valid_to IS NULL ORDER BY id`).all(s, p, o) as { id: number }[]).map(r => r.id);

  it("a fact about the old entity recorded after the apply: the restore keeps the group, one open triple per key", () => {
    const v = vault();
    const { t, n202, linux, n200 } = nodeFixture(v);
    const r = applyEntityRepair(new Database(v.path));
    const later = fact(v, n202, "Node 202", "runs_on", linux, "Linux", { doc: v.doc("later") }); // t left that key: a new triple
    expect(later).not.toBe(t);
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept.map(k => k.comp)).toEqual([`T${t}`]);
    expect(back.kept[0]!.why).toMatch(/two open triples/);
    expect(openCarriers(v.db, n202, "runs_on", linux)).toEqual([later]);
    expect(tripleOf(v.db, t)!.s).toBe(n200);
  });

  it("an open swap with one side kept by a later sighting: the other side is kept too", () => {
    const v = vault();
    const orion = entity(v.db, "Orion", "project");
    const lyra = entity(v.db, "Lyra", "project");
    const linux = entity(v.db, "Linux", "concept");
    const a = fact(v, orion, "Lyra", "runs_on", linux, "Linux", { doc: v.doc("a") });
    const b = fact(v, lyra, "Orion", "runs_on", linux, "Linux", { doc: v.doc("b") });
    const r = applyEntityRepair(new Database(v.path));
    fact(v, orion, "Orion", "runs_on", linux, "Linux", { doc: v.doc("later") }); // sighted on b, which now holds that key
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept.map(k => k.comp).sort()).toEqual([`T${a}`, `T${b}`].sort());
    expect(openCarriers(v.db, orion, "runs_on", linux)).toEqual([b]);
    expect(openCarriers(v.db, lyra, "runs_on", linux)).toEqual([a]);
  });

  it("a key two open triples held before the apply: the restore gives it back to both", () => {
    const v = vault();
    const { t, n202, linux } = nodeFixture(v);
    const u = duplicateTriple(v, n202, "runs_on", linux, "Node 202", "Linux"); // an untouched second holder of t's key
    const before = restorable(v.db);
    const r = applyEntityRepair(new Database(v.path));
    expect(openCarriers(v.db, n202, "runs_on", linux)).toEqual([u]);
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept).toEqual([]);
    expect(openCarriers(v.db, n202, "runs_on", linux)).toEqual([t, u]);
    expect(restorable(v.db)).toBe(before);
  });

  it("a merged triple's key taken by a fact recorded after the apply: the restore keeps that group", () => {
    const v = vault();
    const n200 = entity(v.db, "Node 200", "service");
    const n202 = entity(v.db, "Node 202", "service");
    const linux = entity(v.db, "Linux", "concept");
    const u = fact(v, n200, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("u") });
    const t = fact(v, n202, "Node 200", "runs_on", linux, "Linux", { doc: v.doc("t") });
    const r = applyEntityRepair(new Database(v.path));
    expect(tripleOf(v.db, t)).toBeNull(); // merged into u
    const later = fact(v, n202, "Node 202", "runs_on", linux, "Linux", { doc: v.doc("later") });
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept.map(k => k.comp)).toEqual([`T${u}`]);
    expect(tripleOf(v.db, t)).toBeNull();
    expect(openCarriers(v.db, n202, "runs_on", linux)).toEqual([later]);
  });

  it("a rowid reused after the apply blocks nothing; the restored rows get fresh rowids", () => {
    const v = vault();
    entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const d = v.doc("x");
    const rid = mention(v.db, atlasCore, d, "Atlas");
    mention(v.db, atlasCore, v.doc("later"), "Atlas Core"); // a higher rowid: the apply's insert cannot take the freed one
    const r = applyEntityRepair(new Database(v.path));
    expect(v.db.prepare(`SELECT 1 FROM entity_mentions WHERE rowid = ?`).get(rid)).toBeNull();
    const other = v.doc("other");
    v.db.prepare(`INSERT INTO entity_mentions (rowid, entity_id, doc_id, mention_text, created_at) VALUES (?, ?, ?, 'Atlas Core', '2026-10-03 10:00:00')`).run(rid, atlasCore, other); // later activity takes the freed rowid
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept).toEqual([]);
    expect(mentionsOf(v.db, d)).toEqual([{ e: atlasCore, t: "Atlas" }]);
    expect(mentionsOf(v.db, other)).toEqual([{ e: atlasCore, t: "Atlas Core" }]);
  });
});

// =============================================================================
// 9. Entity edges: the links the repair justifies (pair rule), stale links reported
// =============================================================================

/** Rare entities need a corpus: IDF = ln((active + 1) / (df + 1)) clears 3.0 at df 2 from 60 active documents. */
function corpus(v: V, n: number): void {
  v.db.transaction(() => {
    seedDocuments(v.store, Array.from({ length: n }, (_, i) => ({ path: `filler/${i}.md`, title: `Filler ${i}`, body: `filler ${i}` })));
  })();
}
const activeDocs = (db: Database) => (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE active = 1`).get() as { n: number }).n;
const edgeRow = (db: Database, s: number, t2: number) =>
  db.prepare(`SELECT weight, metadata FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'entity'`).get(s, t2) as { weight: number; metadata: string } | null;
const enrichmentWeight = (idf: number, shared: number) => Math.min(1.0, 0.3 + 0.12 * idf + Math.min(0.15, 0.05 * (shared - 1)));

describe("entity edges", () => {
  it("adds the link a newly shared entity justifies, with enrichment's weight and metadata", () => {
    const v = vault();
    corpus(v, 60);
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const target = v.doc("t");
    const d = v.doc("d");
    mention(v.db, atlas, target, "Atlas");
    mention(v.db, atlasCore, d, "Atlas");
    const p = plan(v);
    expect(p.edges.map(e => [e.source, e.target, e.entity])).toEqual([[d, target, atlas]]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    const row = edgeRow(v.db, d, target)!;
    expect(JSON.parse(row.metadata)).toEqual({ entity: atlas, shared: 1 });
    expect(row.weight).toBeCloseTo(enrichmentWeight(Math.log((activeDocs(v.db) + 1) / 3), 1), 12);
  });

  it("adds no link the pair's previously shared entities justify on their own, or also qualify", () => {
    const v = vault();
    corpus(v, 80); // Linux is in three documents: ln(84/4) > 3
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const linux = entity(v.db, "Linux", "concept");
    const [t1, t2, d] = [v.doc("t1"), v.doc("t2"), v.doc("d")];
    mention(v.db, linux, t1, "Linux"); // t1 shares only the unchanged Linux with d
    mention(v.db, linux, t2, "Linux"); // t2 shares Linux and, after the repair, Atlas
    mention(v.db, atlas, t2, "Atlas");
    mention(v.db, linux, d, "Linux");
    mention(v.db, atlasCore, d, "Atlas");
    expect(Math.log((activeDocs(v.db) + 1) / 4)).toBeGreaterThan(ENTITY_IDF_SPECIFICITY_THRESHOLD); // Linux qualifies
    const p = plan(v);
    expect(p.edges).toEqual([]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    // not vacuous: enrichment's unfiltered rule links d to both
    expect(computeEntityEdges(v.db, d, [linux, atlas]).map(e => e.targetDocId).sort((x, y) => x - y)).toEqual([t1, t2]);
    expect(v.db.prepare(`SELECT COUNT(*) AS n FROM memory_relations WHERE relation_type = 'entity'`).get()).toEqual({ n: 0 });
  });

  it("crossed gains: each document gains the other's entity → one link, from the higher id", () => {
    const v = vault();
    corpus(v, 60);
    const xenon = entity(v.db, "Xenon", "project");
    const xenonCore = entity(v.db, "Xenon Core", "project");
    const yarrow = entity(v.db, "Yarrow", "project");
    const yarrowCore = entity(v.db, "Yarrow Core", "project");
    const a = v.doc("a");
    const b = v.doc("b");
    mention(v.db, xenon, a, "Xenon");
    mention(v.db, yarrowCore, a, "Yarrow");
    mention(v.db, yarrow, b, "Yarrow");
    mention(v.db, xenonCore, b, "Xenon");
    const p = plan(v);
    expect(p.edges.map(e => [e.source, e.target, e.entity, e.shared])).toEqual([[b, a, yarrow, 2]]);
  });

  it("a pair newly sharing a minted entity gets one link; a reverse row, an inactive source or an inactive end get none", () => {
    const v = vault();
    corpus(v, 60);
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const [d1, d2] = [v.doc("d1"), v.doc("d2")];
    mention(v.db, n202, d1, "Node 200");
    mention(v.db, n203, d2, "Node 200");
    const n200 = makeEntityId("Node 200", "service");
    expect(plan(v).edges.map(e => [e.source, e.target, e.entity])).toEqual([[d2, d1, n200]]);

    v.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at) VALUES (?, ?, 'entity', 0.5, '{}', datetime('now'))`).run(d1, d2);
    expect(plan(v).edges).toEqual([]);
    v.db.prepare(`DELETE FROM memory_relations WHERE source_id = ? AND target_id = ?`).run(d1, d2);

    v.db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(d2);
    expect(plan(v).edges).toEqual([]); // d2 is no source, and no candidate for d1
  });

  it("apply rolls back, writing nothing, when the links it computes on the vault differ from its plan", () => {
    const v = vault();
    corpus(v, 60);
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const target = v.doc("t");
    const d = v.doc("d");
    mention(v.db, atlas, target, "Atlas");
    mention(v.db, atlasCore, d, "Atlas");
    const before = dump(v.db);
    expect(() => applyEntityRepair(new Database(v.path), { testHooks: { afterPlan: p => { p.edges[0]!.weight += 0.01; } } }))
      .toThrow(/links no longer match/);
    expect(dump(v.db)).toBe(before);
  });

  it("reports a stale link with the entity its ends still share, and one with none; deletes neither", () => {
    const v = vault();
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const linux = entity(v.db, "Linux", "concept");
    const [t1, t2, d] = [v.doc("t1"), v.doc("t2"), v.doc("d")];
    mention(v.db, atlasCore, t1, "Atlas Core");
    mention(v.db, linux, t1, "Linux");
    mention(v.db, atlasCore, t2, "Atlas Core");
    mention(v.db, atlasCore, d, "Atlas");
    mention(v.db, linux, d, "Linux");
    const meta = JSON.stringify({ entity: atlasCore, shared: 1 });
    v.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at) VALUES (?, ?, 'entity', 0.7, ?, datetime('now'))`).run(d, t1, meta);
    v.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at) VALUES (?, ?, 'entity', 0.7, ?, datetime('now'))`).run(t2, d, meta);
    const p = plan(v);
    expect(p.staleEdges.map(e => [e.source, e.target, e.stillShared])).toEqual([[d, t1, [linux]], [t2, d, []]]);
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(edgeRow(v.db, d, t1)).not.toBeNull();
    expect(edgeRow(v.db, t2, d)).not.toBeNull();
    expect(atlas).not.toBe(atlasCore);
  });

  it("a legacy-artifact document gets no link, though a repaired document beside it does", () => {
    const v = vault();
    corpus(v, 80); // three documents will mention Atlas: ln(84 / 4) clears 3.0
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const target = v.doc("t");
    const [artifact] = seedDocuments(v.store, [{
      path: "precompact-state.md",
      title: "precompact-state",
      body: "# Pre-Compaction State\n\n_Extracted 2026-10-01T08:00:00 before auto-compaction. This is authoritative._\n\nnotes",
    }]);
    const d = v.doc("d");
    mention(v.db, atlas, target, "Atlas");
    mention(v.db, atlasCore, artifact!, "Atlas");
    mention(v.db, atlasCore, d, "Atlas");
    const p = plan(v);
    expect(p.mentionDocs.map(m => m.doc)).toEqual([artifact!, d]);
    expect(p.edges.map(e => [e.source, e.target, e.entity])).toEqual([[d, target, atlas]]);
  });

  it("a stale link between two repaired documents is reported once", () => {
    const v = vault();
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const [d1, d2] = [v.doc("d1"), v.doc("d2")];
    mention(v.db, atlasCore, d1, "Atlas");
    mention(v.db, atlasCore, d2, "Atlas");
    v.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at) VALUES (?, ?, 'entity', 0.7, ?, datetime('now'))`)
      .run(d1, d2, JSON.stringify({ entity: atlasCore, shared: 1 }));
    expect(plan(v).staleEdges.map(e => [e.source, e.target, e.entity, e.stillShared])).toEqual([[d1, d2, atlasCore, [atlas]]]);
  });

  it("enrichment writes its edges through the helper with the same weight and metadata", async () => {
    const v = vault();
    corpus(v, 60);
    const zen = entity(v.db, "ZanzibarProtocol", "project");
    const [partner, enriched] = [v.doc("p"), v.doc("e")];
    mention(v.db, zen, partner, "ZanzibarProtocol");
    const llm = createMockLLM();
    llm.generate.mockResolvedValue({ text: JSON.stringify([{ name: "ZanzibarProtocol", type: "project" }]), model: "mock", done: true });
    await enrichDocumentEntities(v.db as any, llm as any, enriched);
    const row = edgeRow(v.db, enriched, partner)!;
    expect(JSON.parse(row.metadata)).toEqual({ entity: zen, shared: 1 });
    expect(row.weight).toBeCloseTo(enrichmentWeight(Math.log((activeDocs(v.db) + 1) / 3), 1), 12);
  });
});

describe("--expect and the links", () => {
  function linkFixture(v: V, fillers: number) {
    corpus(v, fillers);
    const atlas = entity(v.db, "Atlas", "project");
    const atlasCore = entity(v.db, "Atlas Core", "project");
    const target = v.doc("t");
    const d = v.doc("d");
    mention(v.db, atlas, target, "Atlas");
    mention(v.db, atlasCore, d, "Atlas");
    return { atlas, target, d };
  }

  it("a document saved in between that only moves weights: --expect matches and the link gets the new weight", () => {
    const v = vault();
    const { target, d } = linkFixture(v, 60);
    const p = plan(v);
    v.doc("unrelated");
    applyEntityRepair(new Database(v.path), { expect: p.digest });
    expect(edgeRow(v.db, d, target)!.weight).toBeCloseTo(enrichmentWeight(Math.log((activeDocs(v.db) + 1) / 3), 1), 12);
    expect(edgeRow(v.db, d, target)!.weight).not.toBe(p.edges[0]!.weight);
  });

  it("a document saved in between that names a gained entity changes the link set: --expect fails", () => {
    const v = vault();
    const { atlas } = linkFixture(v, 60);
    const p = plan(v);
    mention(v.db, atlas, v.doc("new"), "Atlas");
    expect(() => applyEntityRepair(new Database(v.path), { expect: p.digest })).toThrow(/digest/);
  });

  it("a document saved in between that moves an IDF across the threshold: --expect fails", () => {
    const v = vault();
    linkFixture(v, 57); // 59 active: ln(60/3) < 3, no link
    const p = plan(v);
    expect(p.edges).toEqual([]);
    v.doc("one more"); // 60 active: ln(61/3) > 3
    expect(() => applyEntityRepair(new Database(v.path), { expect: p.digest })).toThrow(/digest/);
  });
});

describe("restore and the links", () => {
  it("keeps the added links and the mints they name; a raised weight blocks nothing", () => {
    const v = vault();
    corpus(v, 60);
    const n202 = entity(v.db, "Node 202", "service");
    const n203 = entity(v.db, "Node 203", "service");
    const [d1, d2] = [v.doc("d1"), v.doc("d2")];
    mention(v.db, n202, d1, "Node 200");
    mention(v.db, n203, d2, "Node 200");
    const r = applyEntityRepair(new Database(v.path));
    expect(r.written.edgesAdded).toBe(1);
    v.db.prepare(`UPDATE memory_relations SET weight = 0.99 WHERE source_id = ? AND target_id = ?`).run(d2, d1); // synthesis raised it
    const back = restoreEntityRepair(new Database(v.path), r.opId);
    expect(back.kept).toEqual([]);
    expect(back.edgesKept).toBe(1);
    const n200 = makeEntityId("Node 200", "service");
    expect(back.mintsKept).toEqual([n200]);
    expect(mentionsOf(v.db, d1)).toEqual([{ e: n202, t: "Node 200" }]);
    expect(edgeRow(v.db, d2, d1)).not.toBeNull();
  });
});
