/**
 * BACKLOG 82.3, D7 — the binding census as operator ruling 49 A scopes it: WRITING statements only, classed per table
 * COLUMN in `tests/binding-census.json`. This file tests the parts that do not need a whole-suite recording: the
 * mapper from a statement's placeholders to the columns they write, the comparison with the table, and the table
 * itself against this version's schema and the doctor's identifier list. The whole-suite comparison is
 * `scripts/check-binding-census.ts` (it runs the suite with the recorder on and fails on an unclassed written
 * column, a classed column no test reaches, or a writing statement the mapper cannot read).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { createStore, type Store } from "../../src/store.ts";
import { IDENTIFIER_COLUMNS } from "../../src/identifier-columns.ts";
import { censusOriginOf, censusStatement } from "../../src/sqlite-guard.ts";
import {
  COLUMN_CLASSES, compareCensus, createdColumns, createdTables, isWritingStatement, mapWritingStatement, readCensus, vaultColumnsOf,
  type CensusTable, type Target,
} from "../helpers/binding-census.ts";

const SRC = new URL("../../src/", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const srcTexts = () => walk(SRC).map(p => readFileSync(p, "utf-8"));

const col = (table: string, column: string): Target => ({ kind: "column", table, column });
const cond = (table: string): Target => ({ kind: "condition", table });
const mapped = (sql: string, columnsOf?: (t: string) => string[] | null) => Object.fromEntries(mapWritingStatement(sql, columnsOf));

describe("the recorder names a writing statement with every placeholder", () => {
  test("a writing statement keeps `?, ?, ?`; a reading statement folds it", () => {
    expect(censusStatement("INSERT INTO t (a, b, c)\n  VALUES (?, ?, ?)")).toBe("INSERT INTO t (a, b, c) VALUES (?, ?, ?)");
    expect(censusStatement("update t set a = ?, b = ? where c in (?, ?)")).toBe("update t set a = ?, b = ? where c in (?, ?)");
    expect(censusStatement("SELECT * FROM t WHERE c IN (?, ?, ?)")).toBe("SELECT * FROM t WHERE c IN (?, …)");
  });
  test("which statements the census covers", () => {
    for (const sql of ["INSERT INTO t (a) VALUES (?)", " insert or ignore into t (a) values (?)", "REPLACE INTO t (a) VALUES (?)", "UPDATE t SET a = ?"]) {
      expect(isWritingStatement(sql)).toBe(true);
    }
    for (const sql of ["SELECT ?", "DELETE FROM t WHERE a = ?", "WITH x AS (SELECT ?) SELECT * FROM x"]) expect(isWritingStatement(sql)).toBe(false);
  });
});

describe("the recorder names where a statement comes from", () => {
  const stack = (...frames: string[]) => ["Error", ...frames.map(f => `    at fn (${f}:1:1)`)].join("\n");
  test("the first frame outside the guard decides: src/, a test, or anything else", () => {
    expect(censusOriginOf(stack("/r/src/sqlite-guard.ts", "/r/src/store.ts", "/r/tests/unit/a.test.ts"))).toBe("src");
    expect(censusOriginOf(stack("/r/src/sqlite-guard.ts", "/r/tests/helpers/seed-content.ts", "/r/src/store.ts"))).toBe("test");
    expect(censusOriginOf(stack("/r/src/sqlite-guard.ts", "/r/node_modules/x/y.js", "/r/scripts/z.ts"))).toBe("other");
    expect(censusOriginOf(undefined)).toBe("other");
  });

  test("through a real recording: ClawMem's statement is `src`, the test's own statement is `test`", () => {
    const dir = `/tmp/clawmem-census-origin-${process.pid}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      const run = Bun.spawnSync(["bun", new URL("../fixtures/census-origin.ts", import.meta.url).pathname, `${dir}/vault.sqlite`], {
        env: { ...process.env, CLAWMEM_TEST_BINDING_CENSUS: "1", CLAWMEM_TEST_BINDING_CENSUS_FILE: `${dir}/census.jsonl` },
        stdout: "pipe", stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const pairs = readCensus(readFileSync(`${dir}/census.jsonl`, "utf-8"));
      const insert = pairs.filter(([s]) => /^INSERT OR IGNORE INTO content \(hash, doc, created_at\)/.test(s));
      expect(insert.map(p => p[2])).toEqual(["src", "src", "src"]);
      const update = pairs.filter(([s]) => s === "UPDATE content SET created_at = ? WHERE hash = ?");
      expect(update.map(p => [p[1], p[2]])).toEqual([[0, "test"], [1, "test"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mapWritingStatement", () => {
  test("INSERT … VALUES: each value's placeholders feed its column; an expression around a placeholder does not hide it", () => {
    expect(mapped("INSERT OR IGNORE INTO documents (collection, path, title, hash) VALUES (?, CAST(? AS TEXT), COALESCE(?, 'x'), ?)")).toEqual({
      0: [col("documents", "collection")], 1: [col("documents", "path")], 2: [col("documents", "title")], 3: [col("documents", "hash")],
    });
  });

  test("several rows of VALUES, a constant among them, and quoted names", () => {
    expect(mapped(`INSERT INTO "main"."t" ("a", [b], \`c\`) VALUES (?, 'k', ?), (?, 'k', ?)`)).toEqual({
      0: [col("t", "a")], 1: [col("t", "c")], 2: [col("t", "a")], 3: [col("t", "c")],
    });
  });

  test("an upsert: its target and WHERE are conditions; DO UPDATE SET items feed their columns", () => {
    expect(mapped("INSERT INTO t (k, v) VALUES (?, ?) ON CONFLICT(k) WHERE k <> ? DO UPDATE SET v = ?, n = n + 1 WHERE t.v <> ?")).toEqual({
      0: [col("t", "k")], 1: [col("t", "v")], 2: [cond("t")], 3: [col("t", "v")], 4: [cond("t")],
    });
    expect(mapped("INSERT INTO t (k) VALUES (?) ON CONFLICT DO NOTHING RETURNING k")).toEqual({ 0: [col("t", "k")] });
  });

  test("INSERT … SELECT: the selected values feed the columns; FROM and WHERE are conditions", () => {
    expect(mapped("INSERT OR IGNORE INTO feedback_turns (usage_id, state, reason, attempts, updated_at) SELECT id, 'unattributable', 'pre-upgrade', 0, ? FROM context_usage WHERE hook_name = 'context-surfacing' AND id > ? AND id <= ?")).toEqual({
      0: [col("feedback_turns", "updated_at")], 1: [cond("feedback_turns")], 2: [cond("feedback_turns")],
    });
  });

  test("UPDATE: SET items feed their columns (a CASE included); FROM and WHERE are conditions", () => {
    expect(mapped("UPDATE OR IGNORE documents AS d SET title = ?, note = CASE WHEN x = ? THEN ? ELSE note END WHERE d.id = ? AND d.collection IN (?, ?)")).toEqual({
      0: [col("documents", "title")], 1: [col("documents", "note")], 2: [col("documents", "note")], 3: [cond("documents")], 4: [cond("documents")], 5: [cond("documents")],
    });
  });

  test("named and numbered parameters; a name used twice collects both targets", () => {
    expect(mapped("INSERT INTO t (a, b) VALUES ($a, $b)")).toEqual({ $a: [col("t", "a")], $b: [col("t", "b")] });
    expect(mapped("UPDATE t SET a = ?2, b = ?1 WHERE c = ?2")).toEqual({ 1: [col("t", "a"), cond("t")], 0: [col("t", "b")] });
  });

  test("an INSERT without a column list uses the table's own column order", () => {
    expect(mapped("INSERT INTO t VALUES (?, ?)", t => (t === "t" ? ["a", "b"] : null))).toEqual({ 0: [col("t", "a")], 1: [col("t", "b")] });
    expect(mapped("INSERT INTO t VALUES (?, ?)")[0]![0]!.kind).toBe("unknown");
  });

  test("a shape it does not know is reported, never guessed", () => {
    expect(mapped("INSERT INTO t (a, b) VALUES (?)")[0]![0]).toEqual({ kind: "unknown", reason: "1 values for 2 columns" });
    expect(mapped("UPDATE t SET (a, b) = (?, ?)")[0]![0]!.kind).toBe("unknown");
    expect(mapped("INSERT INTO t (a) WITH x AS (SELECT ?) SELECT * FROM x")[0]![0]!.kind).toBe("unknown");
  });

  test("a `?` inside a string literal or a comment is not a placeholder", () => {
    expect(mapped("INSERT INTO t (a, b) VALUES ('what?', ?) -- trailing ?\n")).toEqual({ 0: [col("t", "b")] });
    expect(mapped("UPDATE t SET a = /* ? */ ?")).toEqual({ 0: [col("t", "a")] });
  });
});

describe("compareCensus", () => {
  const vault = (t: string) => ({ t: ["a", "b", "k"], u: ["x"] } as Record<string, string[]>)[t] ?? null;
  const table: CensusTable = { columns: { "t.a": { class: "normalised", row: "title" }, "t.b": { class: "identifier" }, "u.x": { class: "constant/generated" } } };

  test("a written column the table does not class fails; a classed column no binding reaches fails", () => {
    const out = compareCensus([
      ["INSERT INTO t (a, k) VALUES (?, ?)", 0],
      ["INSERT INTO t (a, k) VALUES (?, ?)", 1],
      ["UPDATE t SET b = ? WHERE k = ?", 0],
      ["UPDATE t SET b = ? WHERE k = ?", 1],
      ["SELECT * FROM u WHERE x = ?", 0],
    ], table, vault);
    expect(out.unclassed).toEqual([{ column: "t.k", statement: "INSERT INTO t (a, k) VALUES (?, ?)" }]);
    expect(out.unreached).toEqual(["u.x"]);
    expect(out.reached).toEqual(["t.a", "t.b", "t.k"]);
    expect(out.unreadable).toEqual([]);
  });

  test("a table the vault does not have is listed apart; a statement it cannot read, or a folded one, is reported", () => {
    const out = compareCensus([
      ["INSERT INTO scratch (v) VALUES (?)", 0],
      ["INSERT INTO t (a, b) VALUES (?)", 0],
      ["INSERT INTO t (a, b) VALUES (?, …)", 0],
      ["INSERT INTO t (a) VALUES (?)", 3],
    ], table, vault);
    expect(out.outsideVault).toEqual(["scratch.v"]);
    expect(out.unreadable.map(u => u.reason)).toEqual(["1 values for 2 columns", "placeholders folded by an older recorder", "parameter 3 has no placeholder"]);
  });

  test("a column written only by a test's own SQL is not reached; one ClawMem writes too is", () => {
    const out = compareCensus([
      ["INSERT INTO t (a, k) VALUES (?, ?)", 0, "src"],
      ["INSERT INTO t (a, k) VALUES (?, ?)", 1, "test"],
      ["UPDATE t SET b = ? WHERE k = ?", 0, "test"],
      ["UPDATE t SET b = ? WHERE k = ?", 0, "src"],
      ["INSERT INTO u (x) VALUES (?)", 0, "test"],
    ], table, vault);
    expect(out.reached).toEqual(["t.a", "t.b"]);
    expect(out.testOnly).toEqual(["t.k", "u.x"]);
    expect(out.unreached).toEqual(["u.x"]);
    expect(out.unclassed).toEqual([]);
  });
});

describe("which tables are vault tables, and their columns", () => {
  const sources = [
    "db.exec(`CREATE TABLE IF NOT EXISTS lazy_one (id INTEGER PRIMARY KEY, label TEXT NOT NULL, UNIQUE(label))`);",
    'db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS lazy_fts USING fts5(body, title)");',
    "db.exec(`ALTER TABLE lazy_one ADD COLUMN note TEXT`); // a comment: CREATE TABLE IF NOT EXISTS` does not alter it",
    "const name = 'x'; db.exec(`CREATE TABLE ${name} (v TEXT)`);",
  ];
  test("a table any source text creates is a vault table; a comment's words are not a table", () => {
    expect([...createdTables(sources)].sort()).toEqual(["lazy_fts", "lazy_one"]);
  });
  test("columns come from the CREATE statement (constraints left out) and every ALTER … ADD COLUMN", () => {
    const cols = createdColumns(sources);
    expect([...cols.get("lazy_one")!].sort()).toEqual(["id", "label", "note"]);
    expect([...cols.get("lazy_fts")!].sort()).toEqual(["body", "title"]);
  });
  test("a fresh vault's columns win; a table only the source makes gets the source's columns; a scratch table is none", () => {
    const of = vaultColumnsOf(t => (t === "documents" ? ["id", "path"] : []), sources);
    expect(of("documents")).toEqual(["id", "path"]);
    expect(of("lazy_one")!.sort()).toEqual(["id", "label", "note"]);
    expect(of("scratch")).toBeNull();
  });
  test("this version: the tables created only when a feature first runs are found in src/", () => {
    const created = createdTables(srcTexts());
    for (const t of ["documents", "hermes_marks", "judge_runs", "vectors_vec", "guard_check", "session_log"]) expect(created.has(t), t).toBe(true);
  });
});

describe("tests/binding-census.json against this version's schema", () => {
  const ROOT = "/tmp/clawmem-binding-census-test";
  let store: Store;
  let table: CensusTable;
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    store = createStore(`${ROOT}/vault.sqlite`);
    store.ensureVecTable(4);
    table = JSON.parse(readFileSync(new URL("../binding-census.json", import.meta.url), "utf-8")) as CensusTable;
  });
  afterAll(() => { try { store.close(); } catch { /* closed */ } rmSync(ROOT, { recursive: true, force: true }); });

  test("every classed column exists, every class is one of the known classes, and a normalised column names its row", () => {
    const fresh = (t: string) => (store.db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all() as { name: string }[]).map(r => r.name);
    const columnsOf = vaultColumnsOf(fresh, srcTexts());
    for (const [key, entry] of Object.entries(table.columns)) {
      const [t, c] = key.split(".") as [string, string];
      expect(columnsOf(t) ?? [], key).toContain(c);
      expect(COLUMN_CLASSES as readonly string[], key).toContain(entry.class);
      if (entry.class === "normalised") expect(typeof entry.row === "string" && entry.row.length > 0, key).toBe(true);
      if (entry.class === "guarded") expect(typeof entry.note === "string" && entry.note.length > 0, key).toBe(true);
    }
  });

  test("the doctor's identifier list and the census agree: a listed identifier column that is written is classed `identifier`", () => {
    for (const { table: t, column } of IDENTIFIER_COLUMNS) {
      const entry = table.columns[`${t}.${column}`];
      if (entry) expect(`${t}.${column}: ${entry.class}`).toBe(`${t}.${column}: identifier`);
    }
    const listed = new Set(IDENTIFIER_COLUMNS.map(c => `${c.table}.${c.column}`));
    const unlisted = Object.entries(table.columns).filter(([k, e]) => e.class === "identifier" && !listed.has(k)).map(([k]) => k);
    expect(unlisted).toEqual([]);
  });
});
