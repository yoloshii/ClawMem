/**
 * BACKLOG 82.3, D7 — STORED → STORED copies never bind text as a string (rulings: the design's "stored copies", 53 A).
 * A stored value that starts with U+FEFF or U+FFFE is copied byte for byte — through `src/stored-copy.ts` — by the
 * entity repair's scratch copy (`copyTables`), its apply and its restore, on a GUARDED handle as production opens it.
 * A plain string binding of the same value is refused by the guard (and, unguarded, changed by SQLite).
 *
 * Every marked value is written here as bytes cast to text, and compared as hex. No mark is typed into this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore } from "../../src/store.ts";
import { openDatabase, BomLeadingTextError, type GuardedDatabase } from "../../src/sqlite-guard.ts";
import { insertExact, runExact, selectExact, StoredText } from "../../src/stored-copy.ts";
import { applyEntityRepair, copyTables, dryRunEntityRepair, restoreEntityRepair } from "../../src/entity-repair.ts";
import { makeEntityId } from "../../src/entity.ts";
import { normalizedContent } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];
const bytes = (s: string) => Buffer.from(s, "utf-8");
const hex = (s: string) => bytes(s).toString("hex").toUpperCase();

/** The cases of the design's §1 table, plus the empty string and a mark in the middle. */
const CASES = (m: string) => [m + "needle", m + m + "x", m + String.fromCharCode(0x4e00), m, m + "été", "", "mid" + m + "dle"];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function scratch(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-stored-copy-")); dirs.push(d); return d; }

describe("runExact / insertExact / selectExact", () => {
  test.each(MARKS)("%s: every case is stored byte for byte through a `?T` slot on a guarded handle", (_name, mark) => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    for (const value of CASES(mark)) {
      db.exec("DELETE FROM t");
      insertExact(db, "t", ["v"], [value]);
      expect((db.prepare("SELECT hex(v) AS h, typeof(v) AS ty FROM t").get() as { h: string; ty: string })).toEqual({ h: hex(value), ty: "text" });
    }
  });

  test.each(MARKS)("control: the same value through a plain `?` is refused by the guard — %s", (_name, mark) => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    expect(() => runExact(db, "INSERT INTO t (v) VALUES (?)", [mark + "needle"])).toThrow(BomLeadingTextError);
  });

  test("a copy keeps each value's type: integer, real, blob, null, and text that looks like a number", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (a, b, c, d, e)");
    insertExact(db, "t", ["a", "b", "c", "d", "e"], [42, 1.5, new Uint8Array([1, 2]), null, "42"]);
    expect(db.prepare("SELECT typeof(a) a, typeof(b) b, typeof(c) c, typeof(d) d, typeof(e) e FROM t").get()).toEqual({ a: "integer", b: "real", c: "blob", d: "null", e: "text" });
  });

  test("selectExact reads text as its bytes, so even bytes that are not UTF-8 are copied exactly", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE s (v, n); CREATE TABLE d (v, n)");
    db.prepare("INSERT INTO s (v, n) VALUES (CAST(? AS TEXT), 7)").run(new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x41]));
    const rows = selectExact(db, "s", ["v", "n"]);
    expect(rows[0]![0]).toBeInstanceOf(StoredText);
    for (const r of rows) insertExact(db, "d", ["v", "n"], r);
    expect(db.prepare("SELECT hex(v) h, typeof(v) t, n FROM d").get()).toEqual({ h: "EFBBBFFF41", t: "text", n: 7 });
  });

  test("a value that is not stored text in a `?T` slot, and a placeholder count that does not match, are handled", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (v)");
    runExact(db, "INSERT INTO t (v) VALUES (?T)", [undefined]);
    expect(db.prepare("SELECT typeof(v) t FROM t").get()).toEqual({ t: "null" });
    expect(() => runExact(db, "INSERT INTO t (v) VALUES (?T)", ["a", "b"])).toThrow(/1 placeholders for 2 values/);
  });
});

// --- entity repair on a guarded handle ---------------------------------------------------------------------------

/** A vault with a repair to make, and stored values that start with `mark` in the rows the repair copies. */
function markedVault(mark: string) {
  const dir = scratch();
  const path = join(dir, "vault.sqlite");
  const store = createStore(path);
  const db = store.db;
  const node = (name: string, type: string, description: string | null = null) => {
    const id = makeEntityId(name, type, "default");
    db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
                VALUES (?, ?, ?, CAST(? AS TEXT), datetime('now'), 0, datetime('now'), 'default')`).run(id, type, name, description === null ? null : bytes(description));
    db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`).run(id, name.toLowerCase(), type);
    return id;
  };
  const doc = (p: string, title: string, body: string) => {
    const { body: b, hash } = normalizedContent(body);
    store.insertContent(hash, b, "2026-10-01T00:00:00.000Z");
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', ?, CAST(? AS TEXT), ?, '2026-10-01', '2026-10-01', 1)`)
      .run(p, bytes(title), hash);
    return (db.prepare(`SELECT id FROM documents WHERE path = ?`).get(p) as { id: number }).id;
  };
  // an entity whose stored description starts with the mark: the dry run's scratch copy holds every node
  node("Archive Shelf", "concept", mark + "kept as written");
  const n202 = node("Node 202", "service");
  const n203 = node("Node 203", "service");
  const linux = node("Linux", "concept");
  const d = doc("same.md", mark + "Same document", "notes on the same document");
  // two triples that collapse after the repair: T1 (later) is deleted and restored; its inline source_fact starts
  // with the mark — the survivor keeps T2's, so T1's is copied only into the log and back by the restore
  const fact = "Node 200 runs_on Linux";
  const t1 = Number(db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, confidence, source_doc_id, source_fact, created_at)
                                VALUES (?, 'runs_on', ?, 0.7, ?, CAST(? AS TEXT), '2026-10-02T08:00:00.000Z')`).run(n202, linux, d, bytes(mark + fact)).lastInsertRowid);
  db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, ?, ?, '2026-10-02T08:00:00.000Z')`).run(t1, d, fact);
  const t2 = Number(db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, confidence, source_doc_id, source_fact, created_at)
                                VALUES (?, 'runs_on', ?, 0.9, ?, ?, '2026-10-01T08:00:00.000Z')`).run(n203, linux, d, fact).lastInsertRowid);
  db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, ?, ?, '2026-10-01T08:00:00.000Z')`).run(t2, d, fact);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();
  return { dir, path, t1, t2 };
}

const TABLES = ["entity_nodes", "entities_fts", "entity_mentions", "entity_cooccurrences", "entity_triples", "entity_triple_provenance", "documents", "content"];
/** Every row of the repaired tables, every value as type + hex: what "byte-identical" compares. */
const dumpHex = (db: GuardedDatabase) => TABLES.map(t => {
  const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
  const list = cols.map(c => `typeof(${c}) || ':' || coalesce(hex(${c}), '')`).join(" || '|' || ");
  return [t, (db.prepare(`SELECT ${list} AS r FROM ${t} ORDER BY rowid`).all() as { r: string }[]).map(x => x.r)];
});

describe("entity repair copies stored text exactly, on a guarded handle", () => {
  test.each(MARKS)("copyTables: a scratch copy of tables holding %s-led text is byte-identical", (_name, mark) => {
    const v = markedVault(mark);
    const db = openDatabase(v.path, { readonly: true });
    const copy = copyTables(db, ["entity_nodes", "entity_triples", "documents"]);
    for (const t of ["entity_nodes", "entity_triples", "documents"]) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => `hex(${c.name}) || typeof(${c.name})`).join(" || '|' || ");
      expect(copy.prepare(`SELECT ${cols} AS r FROM ${t} ORDER BY rowid`).all(), t).toEqual(db.prepare(`SELECT ${cols} AS r FROM ${t} ORDER BY rowid`).all());
    }
    copy.close(); db.close();
  });

  test.each(MARKS)("dry run, apply with a collapse, restore — %s-led stored text comes back byte-identical", (_name, mark) => {
    const v = markedVault(mark);
    const before = dumpHex(openDatabase(v.path, { readonly: true }));
    const plan = dryRunEntityRepair(v.path);
    expect(plan.groups.length).toBeGreaterThan(0);
    const applied = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), { expect: plan.digest });
    const mid = openDatabase(v.path, { readonly: true });
    expect(mid.prepare(`SELECT COUNT(*) AS n FROM entity_triples WHERE id = ?`).get(v.t1)).toEqual({ n: 0 });          // T1 collapsed away
    expect((mid.prepare(`SELECT hex(description) AS h FROM entity_nodes WHERE name = 'Archive Shelf'`).get() as { h: string }).h).toBe(hex(mark + "kept as written"));
    mid.close();
    const back = restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), applied.opId);
    expect(back.kept).toEqual([]);
    const after = dumpHex(openDatabase(v.path, { readonly: true }));
    expect(after.find(([t]) => t === "entity_triples")).toEqual(before.find(([t]) => t === "entity_triples"));
    expect(after.find(([t]) => t === "entity_nodes")).toEqual(before.find(([t]) => t === "entity_nodes"));
    expect(after.find(([t]) => t === "documents")).toEqual(before.find(([t]) => t === "documents"));
  });

  test("a file-backed source and an in-memory one copy the same bytes", () => {
    const v = markedVault(FFFE);
    const fileDb = openDatabase(v.path, { readonly: true });
    const mem = copyTables(fileDb, ["entity_triples"]);
    const again = copyTables(mem, ["entity_triples"]);
    const q = `SELECT hex(source_fact) AS h FROM entity_triples ORDER BY rowid`;
    expect(again.prepare(q).all()).toEqual(fileDb.prepare(q).all());
    expect((fileDb.prepare(q).all() as { h: string }[])[0]!.h).toBe(hex(FFFE + "Node 200 runs_on Linux"));
    again.close(); mem.close(); fileDb.close();
  });
});

/**
 * Apply's own copies and restore's statements (ruling 53 A): the repaired rows' TIMES — which the plan only orders by
 * (an unreadable time sorts last) — start with the mark, so every copy of a time must go through a `?T` slot.
 */
function repairVault() {
  const dir = scratch();
  const path = join(dir, "vault.sqlite");
  const store = createStore(path);
  const db = store.db;
  const entity = (name: string, type: string) => {
    const id = makeEntityId(name, type, "default");
    db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
                VALUES (?, ?, ?, NULL, datetime('now'), 0, datetime('now'), 'default')`).run(id, type, name);
    db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`).run(id, name.toLowerCase(), type);
    return id;
  };
  let n = 0;
  const doc = () => {
    const { body, hash } = normalizedContent(`document ${++n}`);
    store.insertContent(hash, body, "2026-10-01T00:00:00.000Z");
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', ?, 'doc', ?, '2026-10-01', '2026-10-01', 1)`).run(`d${n}.md`, hash);
    return (db.prepare(`SELECT max(id) AS id FROM documents`).get() as { id: number }).id;
  };
  return { dir, path, store, db, entity, doc };
}
const at = (mark: string) => bytes(mark + "2026-10-01 10:00:00");

describe("apply's own copies and restore keep stored text exactly (ruling 53 A)", () => {
  test.each(MARKS)("a mention exchange with %s-led times: mention moves and pair inserts, then the restore", (_name, mark) => {
    const v = repairVault();
    const orion = v.entity("Orion", "project"), lyra = v.entity("Lyra", "project"), linux = v.entity("Linux", "concept");
    const [d1, d2] = [v.doc(), v.doc()];
    const mention = (e: string, d: number, text: string) =>
      v.db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, ?, CAST(? AS TEXT))`).run(e, d, text, at(mark));
    mention(orion, d1, "Lyra"); mention(linux, d1, "Linux"); mention(lyra, d2, "Orion"); mention(linux, d2, "Linux");
    v.db.prepare(`UPDATE entity_nodes SET mention_count = CASE entity_id WHEN ? THEN 2 ELSE 1 END`).run(linux);
    for (const [a, b] of [[orion, linux], [lyra, linux]].map(x => x.sort()))
      v.db.prepare(`INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES (?, ?, 1, CAST(? AS TEXT))`).run(a!, b!, at(mark));
    v.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    v.store.close();
    const before = dumpHex(openDatabase(v.path, { readonly: true }));
    const r = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }));
    const mid = openDatabase(v.path, { readonly: true });
    expect(mid.prepare(`SELECT hex(created_at) h FROM entity_mentions GROUP BY h`).all()).toEqual([{ h: hex(mark + "2026-10-01 10:00:00") }]);
    expect(mid.prepare(`SELECT hex(last_cooccurred) h FROM entity_cooccurrences GROUP BY h`).all()).toEqual([{ h: hex(mark + "2026-10-01 10:00:00") }]);
    mid.close();
    expect(restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), r.opId).kept).toEqual([]);
    const after = dumpHex(openDatabase(v.path, { readonly: true }));
    for (const t of ["entity_cooccurrences", "entity_nodes"]) expect(after.find(([x]) => x === t), t).toEqual(before.find(([x]) => x === t));
    const mentions = (d: typeof before) => (d.find(([x]) => x === "entity_mentions")![1] as string[]).slice().sort();
    expect(mentions(after)).toEqual(mentions(before));                                    // rowids aside, as restore promises
  });

  test.each(MARKS)("a re-pointed triple with %s-led times: apply's update and the restore's update copy them", (_name, mark) => {
    const v = repairVault();
    const orion = v.entity("Orion", "project"), lyra = v.entity("Lyra", "project"), linux = v.entity("Linux", "concept");
    const a = v.store.addTriple(orion, "runs_on", linux, null, { sourceDocId: v.doc(), sourceFact: "Lyra runs_on Linux" });
    const b = v.store.addTriple(lyra, "runs_on", linux, null, { sourceDocId: v.doc(), sourceFact: "Orion runs_on Linux" });
    v.db.prepare(`UPDATE entity_triples SET created_at = CAST(? AS TEXT)`).run(at(mark));
    v.db.prepare(`UPDATE entity_triple_provenance SET created_at = CAST(? AS TEXT)`).run(at(mark));
    v.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    v.store.close();
    const before = dumpHex(openDatabase(v.path, { readonly: true }));
    const r = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }));
    const mid = openDatabase(v.path, { readonly: true });
    expect(mid.prepare(`SELECT subject_entity_id s, hex(created_at) h FROM entity_triples ORDER BY id`).all()).toEqual([
      { s: lyra, h: hex(mark + "2026-10-01 10:00:00") }, { s: orion, h: hex(mark + "2026-10-01 10:00:00") },
    ]);
    mid.close();
    expect(restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), r.opId).kept).toEqual([]);
    const after = dumpHex(openDatabase(v.path, { readonly: true }));
    for (const t of ["entity_triples", "entity_triple_provenance"]) expect(after.find(([x]) => x === t), t).toEqual(before.find(([x]) => x === t));
    void a; void b;
  });

  // The moving evidence row's time starts with the mark (an unreadable time sorts last, which still resolves it to the
  // mint): the new triple copies that time. (A mark-led VALIDITY would be refused earlier: the plan looks a triple up
  // by its whole key, a read the guard covers — see the STATUS note for question 54.)
  test.each(MARKS)("a new triple made by the repair copies its source's %s-led time", (_name, mark) => {
    const v = repairVault();
    const omega300 = v.entity("Omega Node 300", "service"), omega301 = v.entity("Omega Node 301", "service");
    v.entity("Omega Node 303", "service");
    const alpha301 = v.entity("Alpha Node 301", "service"), linux = v.entity("Linux", "concept");
    const omega303 = makeEntityId("Omega Node 303", "service", "default");
    const shared = v.doc();
    const fact = (s: string, text: string, d: number, when: string) => {
      const id = v.store.addTriple(s, "runs_on", linux, null, { sourceDocId: d, sourceFact: `${text} runs_on Linux` });
      v.db.prepare(`UPDATE entity_triple_provenance SET created_at = ? WHERE triple_id = ? AND source_fact = ?`).run(when, id, `${text} runs_on Linux`);
      return id;
    };
    fact(omega301, "Omega Node 301", v.doc(), "2026-10-01T07:00:00.000Z");
    fact(omega301, "Alpga Node 300", shared, "2026-10-01T08:00:00.000Z");
    v.db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, 'Alpha Node 300', '2026-10-01 09:00:00')`).run(alpha301, v.doc());
    fact(omega303, "Omega Node 300", v.doc(), "2026-10-01T11:00:00.000Z");
    const t2 = fact(omega303, "Alpga Node 300", shared, "2026-10-01T10:00:00.000Z");
    v.db.prepare(`UPDATE entity_triple_provenance SET created_at = CAST(? AS TEXT) WHERE triple_id = ? AND source_fact = 'Alpga Node 300 runs_on Linux'`).run(at(mark), t2);
    v.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    v.store.close();
    const plan = dryRunEntityRepair(v.path);
    expect(plan.groups.some(g => g.action === "new")).toBe(true);
    const r = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), { expect: plan.digest });
    const alpha300 = makeEntityId("Alpha Node 300", "service", "default");
    const made = openDatabase(v.path, { readonly: true });
    expect(made.prepare(`SELECT hex(created_at) h FROM entity_triples WHERE subject_entity_id = ?`).all(alpha300)).toEqual([{ h: hex(mark + "2026-10-01 10:00:00") }]);
    made.close();
    expect(restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), r.opId).kept).toEqual([]);
    void omega300;
  });
});

describe("ruling 54 A: a triple whose stored KEY text starts with a mark stops the repair before anything is written", () => {
  test.each(MARKS)("%s-led validity: the dry run refuses with the typed error; the vault is unchanged", (_name, mark) => {
    const v = repairVault();
    const orion = v.entity("Orion", "project"), lyra = v.entity("Lyra", "project"), linux = v.entity("Linux", "concept");
    v.store.addTriple(orion, "runs_on", linux, null, { sourceDocId: v.doc(), sourceFact: "Lyra runs_on Linux" });
    v.store.addTriple(lyra, "runs_on", linux, null, { sourceDocId: v.doc(), sourceFact: "Orion runs_on Linux" });
    v.db.prepare(`UPDATE entity_triples SET valid_from = CAST(? AS TEXT)`).run(bytes(mark + "2026-09-01"));
    v.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    v.store.close();
    const before = dumpHex(openDatabase(v.path, { readonly: true }));
    expect(() => dryRunEntityRepair(v.path)).toThrow(BomLeadingTextError);
    expect(() => applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }))).toThrow(BomLeadingTextError);
    expect(dumpHex(openDatabase(v.path, { readonly: true }))).toEqual(before);
  });
});

void copyFileSync;
