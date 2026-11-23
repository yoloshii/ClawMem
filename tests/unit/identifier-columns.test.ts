/**
 * BACKLOG 82.3, D7 — the doctor's list of STORED identifiers that start with a byte-order mark. Such a value can
 * exist without any special writer (a path that began with two marks was stored with one), and it is found and
 * reported, never repaired: table, rowid, column, the value in hex.
 *
 * The scan reads a checked-in list of identifier columns (`src/identifier-columns.ts`), tests whole columns with the
 * byte predicate, tests a `collection/path` column on the two components its reader binds, skips a table the vault
 * does not have, and changes nothing. A marked value is written here the only way it can be: bound as BYTES and
 * cast to text (a string parameter is refused by the guard). No mark is typed into this file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { createStore, type Store } from "../../src/store.ts";
import { IDENTIFIER_COLUMNS, MARK_PREDICATE, describeMarkedIdentifiers, scanMarkedIdentifiers } from "../../src/identifier-columns.ts";
import { normalizedContent } from "../../src/text-policy.ts";
import { freshStamp } from "../../src/stop-schema.ts";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { vaultColumnsOf } from "../helpers/binding-census.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const FFFD = String.fromCharCode(0xfffd);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];
const bytes = (text: string) => Buffer.from(text, "utf-8");
const hex = (text: string) => bytes(text).toString("hex").toUpperCase();

const ROOT = "/tmp/clawmem-identifier-columns-test";
const DB = `${ROOT}/vault.sqlite`;
const NOW = "2026-11-22T00:00:00.000Z";
let store: Store;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  store = createStore(DB);
});
afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(ROOT, { recursive: true, force: true });
});

/** A document row whose path is exactly `path`, mark included: the path is bound as bytes. */
function addDocument(collection: string, path: string): number {
  const { body, hash } = normalizedContent(`body of ${hex(path)}`);
  store.insertContent(hash, body, NOW);
  store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, origin)
                    VALUES (?, CAST(? AS TEXT), 'a title', ?, ?, ?, 1, 'fs')`).run(collection, bytes(path), hash, NOW, NOW);
  return (store.db.prepare(`SELECT max(id) AS id FROM documents`).get() as { id: number }).id;
}
function addSession(sessionId: string, handoffPath: string | null): number {
  store.db.prepare(`INSERT INTO session_log (session_id, started_at, handoff_path) VALUES (CAST(? AS TEXT), ?, CAST(? AS TEXT))`)
    .run(bytes(sessionId), NOW, handoffPath === null ? null : bytes(handoffPath));
  return (store.db.prepare(`SELECT max(rowid) AS id FROM session_log`).get() as { id: number }).id;
}

describe("the predicate", () => {
  test("in a WHERE it selects a value led by either mark, and not U+FFFD, a plain value, the empty string or NULL", () => {
    store.db.exec(`CREATE TABLE probe (v TEXT)`);
    const put = store.db.prepare(`INSERT INTO probe (v) VALUES (CAST(? AS TEXT))`);
    for (const v of [FEFF + "a", FFFE + "b", FFFD + "c", "plain", ""]) put.run(bytes(v));
    store.db.exec(`INSERT INTO probe (v) VALUES (NULL)`);
    const rows = store.db.prepare(`SELECT hex(CAST(v AS BLOB)) AS h FROM probe WHERE ${MARK_PREDICATE("v")} ORDER BY rowid`).all() as { h: string }[];
    expect(rows.map(r => r.h)).toEqual([hex(FEFF + "a"), hex(FFFE + "b")]);
  });
});

describe("scanMarkedIdentifiers", () => {
  test("a healthy vault: nothing is listed", () => {
    addDocument("notes", "x.md");
    addSession("sess-plain", "notes/handoff.md");
    expect(scanMarkedIdentifiers(store.db).found).toEqual([]);
  });

  test.each(MARKS)("%s: a document path, a session id, a model name and a composite are each listed with table, rowid, column and hex", (_name, mark) => {
    const docId = addDocument("notes", mark + "a.md");
    const sessionRow = addSession(mark + "sess-1", null);
    const handoffRow = addSession("sess-2", "notes/" + mark + "old.md");
    store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES ('h', 0, 0, CAST(? AS TEXT), ?)`).run(bytes(mark + "model-x"), NOW);
    const vectorRow = (store.db.prepare(`SELECT max(rowid) AS id FROM content_vectors`).get() as { id: number }).id;

    const found = scanMarkedIdentifiers(store.db).found.map(f => ({ table: f.table, column: f.column, rowid: f.rowid, component: f.component, hex: f.hex, confirmed: f.confirmed }));
    expect(found).toContainEqual({ table: "documents", column: "path", rowid: docId, component: "whole", hex: hex(mark + "a.md"), confirmed: true });
    expect(found).toContainEqual({ table: "session_log", column: "session_id", rowid: sessionRow, component: "whole", hex: hex(mark + "sess-1"), confirmed: true });
    expect(found).toContainEqual({ table: "session_log", column: "handoff_path", rowid: handoffRow, component: "path", hex: hex("notes/" + mark + "old.md"), confirmed: true });
    expect(found).toContainEqual({ table: "content_vectors", column: "model", rowid: vectorRow, component: "whole", hex: hex(mark + "model-x"), confirmed: true });
    expect(found.length).toBe(4);
  });

  // Turn 6 finding 4: "separator, then mark" anywhere is not the test. The reader of a `collection/path` value binds
  // the collection (before the FIRST slash) and the path (all after it); both are sound here.
  test.each(MARKS)("%s after a LATER slash of a composite is a sound value and is not listed", (_name, mark) => {
    addSession("sess-1", "notes/subdir/" + mark + "healthy.md");
    addDocument("notes", "subdir/" + mark + "healthy.md");
    expect(scanMarkedIdentifiers(store.db).found).toEqual([]);
    const doc = store.findDocument("notes/subdir/" + mark + "healthy.md");       // its exact lookup works
    expect("error" in doc ? "not found" : doc.displayPath).toBe("notes/subdir/" + mark + "healthy.md");
  });

  test.each(MARKS)("%s leading the COLLECTION of a composite is listed as the whole value", (_name, mark) => {
    const row = addSession("sess-1", mark + "notes/old.md");
    expect(scanMarkedIdentifiers(store.db).found.map(f => [f.table, f.column, f.rowid, f.component])).toEqual([["session_log", "handoff_path", row, "whole"]]);
  });

  test.each(MARKS)("%s in a composite column whose encoding the list does not know: an UNCONFIRMED candidate", (_name, mark) => {
    // the row carries this version's writer stamp: an unstamped insert is dropped by the fence
    store.db.prepare(`INSERT INTO co_activations (doc_a, doc_b, count, last_seen, stamp) VALUES (CAST(? AS TEXT), 'notes/b.md', 1, ?, ?)`)
      .run(bytes("notes/sub/" + mark + "a.md"), NOW, freshStamp());
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM co_activations`).get() as { n: number }).n).toBe(1);
    const found = scanMarkedIdentifiers(store.db).found;
    expect(found.map(f => [f.table, f.column, f.confirmed])).toEqual([["co_activations", "doc_a", false]]);
  });

  test("a table the vault does not have is skipped and named", () => {
    store.db.exec(`DROP TABLE hermes_marks`);
    addDocument("notes", FEFF + "a.md");
    const scan = scanMarkedIdentifiers(store.db);
    expect(scan.skippedTables).toContain("hermes_marks");
    expect(scan.found.map(f => f.table)).toEqual(["documents"]);
  });

  test("it changes nothing: the vault file is byte-identical after a scan on a read-only handle", () => {
    addDocument("notes", FFFE + "a.md");
    addSession(FEFF + "sess-1", "notes/" + FEFF + "old.md");
    store.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    store.close();
    const before = createHash("sha256").update(readFileSync(DB)).digest("hex");
    const reader = createStore(DB, { readonly: true });
    expect(scanMarkedIdentifiers(reader.db).found.length).toBe(3);
    reader.close();
    expect(createHash("sha256").update(readFileSync(DB)).digest("hex")).toBe(before);
    store = createStore(DB);
  });

  test("the list is honest: every listed column exists in this version's schema, and no column is listed twice", () => {
    // a table created only when a feature first runs is read from the CREATE statement under src/
    const SRC = new URL("../../src/", import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
    const columnsOf = vaultColumnsOf(t => (store.db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all() as { name: string }[]).map(c => c.name),
      walk(SRC).map(p => readFileSync(p, "utf-8")));
    const seen = new Set<string>();
    for (const entry of IDENTIFIER_COLUMNS) {
      const cols = columnsOf(entry.table) ?? [];
      expect(cols, `${entry.table}.${entry.column}`).toContain(entry.column);
      const key = `${entry.table}.${entry.column}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    for (const must of ["documents.path", "documents.collection", "session_log.session_id", "session_log.handoff_path", "content_vectors.model", "feedback_ledger.display_path"]) {
      expect(seen.has(must), must).toBe(true);
    }
  });
});

// Ruling 71 A: a listed value that no reader binds again — the path (or another identifier) of an INACTIVE document,
// a stored session id — is INERT: still listed, tagged as kept as a record, and it alone does not fail the check.
describe("inert values (ruling 71 A)", () => {
  test.each(MARKS)("%s: an INACTIVE document's marked path and a marked session id are inert; the check passes", (_name, mark) => {
    const docId = addDocument("notes", mark + "a.md");
    store.db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'forget' WHERE id = ?`).run(docId);
    addSession(mark + "sess-1", null);
    const scan = scanMarkedIdentifiers(store.db);
    expect(scan.found.map(f => [f.table, f.column, f.inert])).toEqual([["documents", "path", true], ["session_log", "session_id", true]]);
    const d = describeMarkedIdentifiers(scan);
    expect(d.ok).toBe(true);
    expect(d.lines[0]).not.toContain("INCOMPLETE");
    expect(d.lines.slice(1).every(l => l.includes("inert"))).toBe(true);
  });

  test.each(MARKS)("%s: an ACTIVE document's marked path and a marked handoff reference are not inert; the check fails", (_name, mark) => {
    addDocument("notes", mark + "a.md");
    addSession("sess-2", "notes/" + mark + "old.md");
    const scan = scanMarkedIdentifiers(store.db);
    expect(scan.found.map(f => f.inert)).toEqual([false, false]);
    const d = describeMarkedIdentifiers(scan);
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toContain("INCOMPLETE");
  });

  test.each(MARKS)("%s: a document made ACTIVE again (a restore) is counted again on the next scan", (_name, mark) => {
    const docId = addDocument("notes", mark + "a.md");
    store.db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(docId);
    expect(describeMarkedIdentifiers(scanMarkedIdentifiers(store.db)).ok).toBe(true);
    store.db.prepare(`UPDATE documents SET active = 1 WHERE id = ?`).run(docId);
    expect(describeMarkedIdentifiers(scanMarkedIdentifiers(store.db)).ok).toBe(false);
  });

  test.each(MARKS)("%s: inert and active together — the headline counts the active ones, and the check fails", (_name, mark) => {
    addSession(mark + "sess-1", null);
    addDocument("notes", mark + "a.md");
    const d = describeMarkedIdentifiers(scanMarkedIdentifiers(store.db));
    expect(d.ok).toBe(false);
    expect(d.lines[0]).toMatch(/^1 stored value/);
  });
});

// Ruling 72 A: a stored feedback-ledger display path, and the utility-signal path the counter recompute copies from it,
// are bound WHOLE by every reader of the stored value (a mark after the slash is not refused and is stored exactly).
describe("inert ledger and signal paths (ruling 72 A)", () => {
  test.each(MARKS)("%s after the slash of a feedback_ledger display path and of a utility_signals path: listed, inert", (_name, mark) => {
    store.db.prepare(`INSERT INTO feedback_ledger (usage_id, vault, display_path, vault_doc_id, displayed_title, created_at)
                      VALUES (1, '', CAST(? AS TEXT), 7, 't', ?)`).run(bytes("notes/" + mark + "a.md"), NOW);
    store.db.prepare(`INSERT INTO utility_signals (path, surfaced_count, referenced_count, stamp) VALUES (CAST(? AS TEXT), 1, 0, ?)`)
      .run(bytes("notes/" + mark + "a.md"), freshStamp());
    const scan = scanMarkedIdentifiers(store.db);
    expect(scan.found.map(f => [f.table, f.column, f.inert])).toEqual([["feedback_ledger", "display_path", true], ["utility_signals", "path", true]]);
    expect(describeMarkedIdentifiers(scan).ok).toBe(true);
  });
});

describe("inert only after the slash (72 A, 73 A)", () => {
  test.each(MARKS)("%s LEADING a ledger display path (a whole binding would be refused) is NOT inert; a repair-log key after the slash is", (_name, mark) => {
    store.db.prepare(`INSERT INTO feedback_ledger (usage_id, vault, display_path, vault_doc_id, displayed_title, created_at)
                      VALUES (1, '', CAST(? AS TEXT), 7, 't', ?)`).run(bytes(mark + "notes/a.md"), NOW);
    store.db.prepare(`INSERT INTO counter_repair_log (op_id, tbl, row_key, col, old_value, created_at)
                      VALUES ('op-1', 'utility_signals', CAST(? AS TEXT), 'path', NULL, ?)`).run(bytes("notes/" + mark + "a.md"), NOW);
    const found = scanMarkedIdentifiers(store.db).found.map(f => [f.table, f.column, f.component, f.inert]);
    expect(found).toContainEqual(["feedback_ledger", "display_path", "whole", false]);
    expect(found).toContainEqual(["counter_repair_log", "row_key", "path", true]);
  });
});
