/**
 * BACKLOG 82.3, Codex T1 S1, operator ruling 82 A — the entity repair and stored text that is not valid UTF-8.
 *
 * Bun reads a TEXT value whose bytes are not valid UTF-8 LOSSILY: Bun 1.3.14 reads a short value as the empty string and
 * a longer one with U+FFFD in place of the bad bytes; Bun 1.4.2 reads both with U+FFFD. Either way it does not read back as its bytes.
 * Older versions could store such bytes: their string binding of a value that started with U+FFFE stored every later
 * code unit byte-swapped, and a swapped code unit can be a lone surrogate (U+FFFE + U+00D8 was stored as `EDA080`).
 * The repair copies, compares and restores rows through strings, so such a value would be written back changed (a short
 * one empty) while the repair reported success. Its dry run, apply and restore therefore REFUSE while any text value in the tables they read
 * or write does not read back as its own bytes, and name the table, column and row; nothing is written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore } from "../../src/store.ts";
import { openDatabase, type GuardedDatabase } from "../../src/sqlite-guard.ts";
import { applyEntityRepair, dryRunEntityRepair, restoreEntityRepair, EntityRepairRefusal } from "../../src/entity-repair.ts";
import { makeEntityId } from "../../src/entity.ts";
import { normalizedContent } from "../../src/text-policy.ts";

/** What the old binding stored for U+FFFE + U+00D8: one lone surrogate, as SQLite writes it. */
const LEGACY_SURROGATE = Buffer.from("EDA080", "hex");
const withBad = (text: string) => Buffer.concat([Buffer.from(text, "utf-8"), LEGACY_SURROGATE]);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A vault with a repair to make: two triples that collapse (T1 deleted, restored later) and one mention that moves. */
function repairVault() {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-82a-")); dirs.push(dir);
  const path = join(dir, "vault.sqlite");
  const store = createStore(path);
  const db = store.db;
  const node = (name: string, type: string) => {
    const id = makeEntityId(name, type, "default");
    db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
                VALUES (?, ?, ?, NULL, datetime('now'), 0, datetime('now'), 'default')`).run(id, type, name);
    db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`).run(id, name.toLowerCase(), type);
    return id;
  };
  const doc = (p: string, body: string) => {
    const { body: b, hash } = normalizedContent(body);
    store.insertContent(hash, b, "2026-10-01T00:00:00.000Z");
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', ?, 't', ?, '2026-10-01', '2026-10-01', 1)`).run(p, hash);
    return { id: (db.prepare(`SELECT id FROM documents WHERE path = ?`).get(p) as { id: number }).id, hash };
  };
  const n202 = node("Node 202", "service");
  const n203 = node("Node 203", "service");
  const linux = node("Linux", "concept");
  node("Atlas", "project");
  const atlasCore = node("Atlas Core", "project");
  const d = doc("same.md", "notes on the same document");
  const fact = "Node 200 runs_on Linux";
  const t1 = Number(db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, confidence, source_doc_id, source_fact, created_at)
                                VALUES (?, 'runs_on', ?, 0.7, ?, ?, '2026-10-02T08:00:00.000Z')`).run(n202, linux, d.id, fact).lastInsertRowid);
  db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, ?, ?, '2026-10-02T08:00:00.000Z')`).run(t1, d.id, fact);
  const t2 = Number(db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, confidence, source_doc_id, source_fact, created_at)
                                VALUES (?, 'runs_on', ?, 0.9, ?, ?, '2026-10-01T08:00:00.000Z')`).run(n203, linux, d.id, fact).lastInsertRowid);
  db.prepare(`INSERT INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at) VALUES (?, ?, ?, '2026-10-01T08:00:00.000Z')`).run(t2, d.id, fact);
  const c = doc("atlas.md", "the atlas project ships monthly");
  db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, 'Atlas', '2026-10-01 10:00:00')`).run(atlasCore, c.id);
  db.prepare(`UPDATE entity_nodes SET mention_count = 1 WHERE entity_id = ?`).run(atlasCore);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();
  return { path, t1, t2, mentionDoc: c };
}

/** Store raw bytes as TEXT in one cell. A raw handle: the test writes the legacy form older versions left. */
function plant(path: string, sql: string, ...args: unknown[]): void {
  const { Database } = require("bun:sqlite");
  const db = new Database(path);
  try { db.prepare(sql).run(...args); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
}

const TABLES = ["entity_nodes", "entities_fts", "entity_mentions", "entity_cooccurrences", "entity_triples", "entity_triple_provenance", "memory_relations", "documents", "content"];
const dumpHex = (path: string) => {
  const db: GuardedDatabase = openDatabase(path, { readonly: true });
  try {
    return JSON.stringify(TABLES.map(t => {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
      const list = cols.map(c => `typeof(${c}) || ':' || coalesce(hex(${c}), '')`).join(" || '|' || ");
      return [t, (db.prepare(`SELECT ${list} AS r FROM ${t} ORDER BY rowid`).all() as { r: string }[]).map(x => x.r)];
    }));
  } finally { db.close(); }
};
const hasLog = (path: string) => {
  const db = openDatabase(path, { readonly: true });
  try { return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'entity_repair_log'`).get(); } finally { db.close(); }
};
const refusalOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof EntityRepairRefusal) return e.message; throw e; }
  throw new Error("no refusal");
};

describe("82 A: the entity repair refuses stored text that does not read back as its own bytes", () => {
  test("control: the fixture has a repair to make, and dry run → apply → restore round-trips byte for byte", () => {
    const v = repairVault();
    const before = dumpHex(v.path);
    const plan = dryRunEntityRepair(v.path);
    expect(plan.groups.length).toBeGreaterThan(0);
    expect(plan.mentionDocs.map(m => m.doc)).toContain(v.mentionDoc.id);
    const applied = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), { expect: plan.digest });
    const back = restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), applied.opId);
    expect(back.kept).toEqual([]);
    const after = JSON.parse(dumpHex(v.path)) as [string, string[]][];
    const was = JSON.parse(before) as [string, string[]][];
    for (const t of ["entity_triples", "entity_triple_provenance", "entity_nodes"]) {
      expect(after.find(([n]) => n === t), t).toEqual(was.find(([n]) => n === t));
    }
  });

  test("the legacy bytes (a short value) do not read back as their own bytes (the fact this rests on, on any Bun)", () => {
    const v = repairVault();
    plant(v.path, `UPDATE entity_triples SET source_fact = CAST(? AS TEXT) WHERE id = ?`, LEGACY_SURROGATE, v.t1);
    const db = openDatabase(v.path, { readonly: true });
    try {
      const r = db.prepare(`SELECT source_fact AS f, hex(source_fact) AS h FROM entity_triples WHERE id = ?`).get(v.t1) as { f: string; h: string };
      expect(r.h).toBe("EDA080");
      expect(Buffer.from(r.f, "utf-8").toString("hex").toUpperCase()).not.toBe("EDA080");   // "" on Bun 1.3.14, U+FFFD on 1.4.2
    } finally { db.close(); }
  });

  test("a triple's source_fact holding them: dry run and apply refuse, naming the table, column and row; nothing written", () => {
    const v = repairVault();
    plant(v.path, `UPDATE entity_triples SET source_fact = CAST(? AS TEXT) WHERE id = ?`, LEGACY_SURROGATE, v.t1);
    const before = dumpHex(v.path);
    const dry = refusalOf(() => dryRunEntityRepair(v.path));
    expect(dry).toContain(`entity_triples.source_fact rowid ${v.t1}`);
    expect(dry).toMatch(/^1 stored text value /);
    expect(dry).toContain("nothing written");
    const apply = refusalOf(() => applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false })));
    expect(apply).toContain(`entity_triples.source_fact rowid ${v.t1}`);
    expect(dumpHex(v.path)).toBe(before);
    expect(hasLog(v.path)).toBe(false);
  });

  test("the bytes in the middle of a value (not only the whole value) are found too, in an evidence row", () => {
    const v = repairVault();
    plant(v.path, `UPDATE entity_triple_provenance SET source_fact = CAST(? AS TEXT) WHERE triple_id = ?`, withBad("Node 200 runs_on Linux"), v.t2);
    const msg = refusalOf(() => dryRunEntityRepair(v.path));
    expect(msg).toContain("entity_triple_provenance.source_fact rowid");
  });

  test.each([
    ["entity_nodes.description", `UPDATE entity_nodes SET description = CAST(? AS TEXT) WHERE name = 'Linux'`],
    ["entity_mentions.mention_text", `UPDATE entity_mentions SET mention_text = CAST(? AS TEXT)`],
    ["entity_cooccurrences.last_cooccurred", `INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES ('a', 'b', 1, CAST(? AS TEXT))`],
    ["memory_relations.metadata", `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at) VALUES (1, 2, 'entity', 0.5, CAST(? AS TEXT), '2026-10-01')`],
  ])("%s holding them: the dry run refuses", (where, sql) => {
    const v = repairVault();
    plant(v.path, sql, LEGACY_SURROGATE);
    expect(refusalOf(() => dryRunEntityRepair(v.path))).toContain(where);
  });

  test("the body of a document whose mentions the repair re-reads: refused, naming the document", () => {
    const v = repairVault();
    plant(v.path, `UPDATE content SET doc = CAST(? AS TEXT) WHERE hash = ?`, withBad("the atlas project ships monthly"), v.mentionDoc.hash);
    const msg = refusalOf(() => dryRunEntityRepair(v.path));
    expect(msg).toContain(`document ${v.mentionDoc.id}`);
  });

  test("the body of a document the repair never reads does not stop it", () => {
    const v = repairVault();
    const store = createStore(v.path);
    const { body, hash } = normalizedContent("unrelated note");
    store.insertContent(hash, body, "2026-10-01T00:00:00.000Z");
    store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('notes', 'other.md', 't', ?, '2026-10-01', '2026-10-01', 1)`).run(hash);
    store.close();
    plant(v.path, `UPDATE content SET doc = CAST(? AS TEXT) WHERE hash = ?`, LEGACY_SURROGATE, hash);
    expect(dryRunEntityRepair(v.path).groups.length).toBeGreaterThan(0);
  });

  test("restore: such bytes arriving after the apply stop the restore; nothing changed", () => {
    const v = repairVault();
    const applied = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }));
    plant(v.path, `UPDATE entity_triple_provenance SET source_fact = CAST(? AS TEXT) WHERE triple_id = ?`, LEGACY_SURROGATE, v.t2);
    const before = dumpHex(v.path);
    const msg = refusalOf(() => restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), applied.opId));
    expect(msg).toContain("entity_triple_provenance.source_fact rowid");
    expect(dumpHex(v.path)).toBe(before);
  });

  test("the count covers every value; the list stops at its limit and says so", () => {
    const v = repairVault();
    plant(v.path, `UPDATE entity_triples SET source_fact = CAST(? AS TEXT)`, LEGACY_SURROGATE);
    plant(v.path, `UPDATE entity_triple_provenance SET source_fact = CAST(? AS TEXT)`, LEGACY_SURROGATE);
    plant(v.path, `UPDATE entity_nodes SET description = CAST(? AS TEXT)`, LEGACY_SURROGATE);   // 5 nodes
    const msg = refusalOf(() => dryRunEntityRepair(v.path));
    expect(msg).toMatch(/^9 stored text values /);
    expect(msg).toContain("and 4 more");
  });

  test("a LONGER value with such bytes reads lossily, not as empty text — and is refused all the same (85 A correction)", () => {
    const v = repairVault();
    plant(v.path, `UPDATE entity_triples SET source_fact = CAST(? AS TEXT) WHERE id = ?`, Buffer.concat([Buffer.from("A".repeat(64)), LEGACY_SURROGATE, Buffer.from("B")]), v.t1);
    const db = openDatabase(v.path, { readonly: true });
    try { expect((db.prepare(`SELECT source_fact AS f FROM entity_triples WHERE id = ?`).get(v.t1) as { f: string }).f.length).toBeGreaterThan(64); } finally { db.close(); }
    expect(refusalOf(() => dryRunEntityRepair(v.path))).toContain(`entity_triples.source_fact rowid ${v.t1}`);
  });

  test("85 A: an unreadable row in an OLDER op's log blocks only that op's restore — a new apply and its restore succeed", () => {
    const v = repairVault();
    const old = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }));
    restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), old.opId);         // the vault is back: a repair to make again
    plant(v.path, `UPDATE entity_repair_log SET old_row = CAST(? AS TEXT) WHERE id = (SELECT MIN(id) FROM entity_repair_log WHERE op_id = ? AND old_row IS NOT NULL)`, LEGACY_SURROGATE, old.opId);
    expect(dryRunEntityRepair(v.path).groups.length).toBeGreaterThan(0);                              // the dry run does not read the log
    const next = applyEntityRepair(openDatabase(v.path, { readwrite: true, create: false }));
    expect(restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), next.opId).kept).toEqual([]);
    expect(refusalOf(() => restoreEntityRepair(openDatabase(v.path, { readwrite: true, create: false }), old.opId))).toContain("entity_repair_log.old_row rowid");
  });
});
