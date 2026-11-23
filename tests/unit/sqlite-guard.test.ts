/**
 * BACKLOG 82.3, D6 — the guarded database handle.
 *  - A string parameter whose first code unit is U+FEFF or U+FFFE is refused with `BomLeadingTextError`, on every
 *    binding surface: `db.run`, `db.exec`, `prepare(sql, params)`, `query`, and a statement's `run` / `get` / `all` /
 *    `values` / `iterate` / `raw` — positional, array and named.
 *  - A blob is not text and passes; a mark that is not the first code unit passes.
 *  - A statement is guarded IN PLACE: it is the object Bun made, and everything else of it behaves as Bun defines.
 *  - Parameters are bound from a validated SNAPSHOT: what was checked is what is bound.
 *  - The self-check proves the guard on a scratch database, and fails on a runtime where it does not hold.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BomLeadingTextError, GuardedDatabase, guardSelfCheck, openDatabase } from "../../src/sqlite-guard.ts";

const MARK = String.fromCharCode(0xfeff);
const SWAPPED = String.fromCharCode(0xfffe);
const LED = [MARK + "name", SWAPPED + "name", MARK, MARK + MARK + "x"];

function fresh(): GuardedDatabase {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (a TEXT, b TEXT)");
  db.run("INSERT INTO t (a, b) VALUES (?, ?)", ["plain", "row"]);
  return db;
}
const count = (db: Database) => (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
function refused(fn: () => unknown): BomLeadingTextError {
  let caught: unknown;
  try { const out = fn(); if (out && typeof (out as Iterator<unknown>).next === "function") (out as Iterator<unknown>).next(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(BomLeadingTextError);
  return caught as BomLeadingTextError;
}

describe("a mark-led string is refused on every binding surface", () => {
  for (const led of LED) {
    const label = [...led].map(ch => ch.charCodeAt(0).toString(16)).join(" ");
    it(`db.run and db.exec — positional, array and named (${label})`, () => {
      const db = fresh();
      for (const method of ["run", "exec"] as const) {
        refused(() => (db as any)[method]("INSERT INTO t (a, b) VALUES (?, ?)", led, "x"));
        refused(() => (db as any)[method]("INSERT INTO t (a, b) VALUES (?, ?)", "x", led));
        refused(() => (db as any)[method]("INSERT INTO t (a, b) VALUES (?, ?)", ["x", led]));
        refused(() => (db as any)[method]("INSERT INTO t (a, b) VALUES ($a, $b)", { $a: "x", $b: led }));
      }
      expect(count(db)).toBe(1);                                               // nothing was written
    });

    it(`prepare(sql, params) and query (${label})`, () => {
      const db = fresh();
      refused(() => (db as any).prepare("SELECT a FROM t WHERE a = ?", [led]));
      refused(() => (db as any).prepare("SELECT a FROM t WHERE a = ?", led));
      refused(() => (db as any).prepare("SELECT a FROM t WHERE a = $a", { $a: led }));
      refused(() => db.query("SELECT a FROM t WHERE a = ?").get(led));
    });

    it(`a statement's run / get / all / values / iterate / raw — positional, array and named (${label})`, () => {
      const db = fresh();
      for (const method of ["run", "get", "all", "values", "iterate", "raw"] as const) {
        const positional = db.prepare("SELECT a FROM t WHERE a = ? OR b = ?");
        refused(() => (positional as any)[method](led, "x"));
        refused(() => (positional as any)[method]("x", led));
        refused(() => (positional as any)[method](["x", led]));
        const named = db.prepare("SELECT a FROM t WHERE a = $a OR b = $b");
        refused(() => (named as any)[method]({ $a: "x", $b: led }));
      }
      const insert = db.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
      refused(() => insert.run("x", led));
      expect(count(db)).toBe(1);
    });
  }

  it("the error names the mark, the statement and the parameter, and points at the doctor", () => {
    const db = fresh();
    const longSql = "INSERT INTO t (a, b) VALUES (?, ?) /* " + "x".repeat(80) + " */";
    const positional = refused(() => db.run(longSql, ["ok", MARK + "id"]));
    expect(positional.first).toBe(0xfeff);
    expect(positional.parameter).toBe(1);
    expect(positional.sql).toBe(longSql.slice(0, 60));
    expect(positional.message).toContain("clawmem doctor");
    expect(positional.name).toBe("BomLeadingTextError");
    const named = refused(() => db.prepare("SELECT a FROM t WHERE a = $a").get({ $a: SWAPPED + "id" } as never));
    expect(named.first).toBe(0xfffe);
    expect(named.parameter).toBe("$a");
    const spread = refused(() => db.prepare("SELECT a FROM t WHERE a = ? OR b = ?").all("ok", MARK));
    expect(spread.parameter).toBe(1);
  });
});

describe("what is not refused", () => {
  it("a blob with those bytes, and a mark that is not the first code unit", () => {
    const db = fresh();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);                     // the mark in UTF-8, then "A"
    db.run("INSERT INTO t (a, b) VALUES (?, ?)", [bytes, "blob"]);
    db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(Buffer.from(bytes), "buffer");
    db.run("INSERT INTO t (a, b) VALUES (?, ?)", ["mid" + MARK + "dle", "x" + SWAPPED]);
    expect(count(db)).toBe(4);
    const row = db.prepare("SELECT a FROM t WHERE b = ?").get("x" + SWAPPED) as { a: string };
    expect(row.a).toBe("mid" + MARK + "dle");
    // ordinary values of every kind
    db.run("INSERT INTO t (a, b) VALUES (?, ?)", [null, 7]);
    db.run("INSERT INTO t (a, b) VALUES (?, ?)", [1.5, 9n]);
    db.run("INSERT INTO t (a, b) VALUES (?, ?)", ["", true as never]);
    expect(count(db)).toBe(7);
  });
});

describe("a guarded statement is the statement Bun made", () => {
  it("as(Class) rows are instances, safeIntegers, columnNames, finalize, a transaction, close", () => {
    const db = fresh();
    class Row { a!: string; shout() { return this.a.toUpperCase(); } }
    const typed = db.prepare("SELECT a FROM t WHERE a = ?").as(Row);
    const row = typed.get("plain")!;
    expect(row).toBeInstanceOf(Row);
    expect(row.shout()).toBe("PLAIN");
    refused(() => typed.get(MARK + "x"));                                     // still guarded after as()

    const big = (db.prepare("SELECT 9007199254740993 AS n, ? AS s") as any).safeIntegers(true);
    expect(big.get("ok")).toEqual({ n: 9007199254740993n, s: "ok" });
    refused(() => big.get(MARK + "x"));                                       // still guarded after safeIntegers()

    const st = db.prepare("SELECT a, b FROM t WHERE a = ?");
    expect(st.columnNames).toEqual(["a", "b"]);
    expect(st.paramsCount).toBe(1);
    expect(st.all("plain")).toEqual([{ a: "plain", b: "row" }]);
    expect(st.values("plain")).toEqual([["plain", "row"]]);
    expect([...st.iterate("plain")]).toEqual([{ a: "plain", b: "row" }]);
    expect((st as any).raw("plain").length).toBe(1);
    st.finalize();

    const insert = db.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
    const many = db.transaction((rows: string[]) => { for (const r of rows) insert.run(r, "tx"); return rows.length; });
    expect(many(["one", "two"])).toBe(2);
    expect(() => db.transaction(() => { insert.run("three", "tx"); insert.run(MARK + "four", "tx"); })()).toThrow(BomLeadingTextError);
    expect(count(db)).toBe(3);                                                // the refused transaction rolled back whole
    db.close();
  });

  it("db.query returns the same guarded object twice", () => {
    const db = fresh();
    const one = db.query("SELECT a FROM t WHERE a = ?");
    const two = db.query("SELECT a FROM t WHERE a = ?");
    expect(two).toBe(one);
    expect(one.get("plain")).toEqual({ a: "plain" });
    refused(() => two.get(MARK));
  });

  it("query guards its statement itself — also on a runtime where it does not go through prepare", () => {
    const db = fresh();
    (db as any).prepare = function (sql: string, ...params: unknown[]) { return (Database.prototype.prepare as any).call(this, sql, ...params); };
    refused(() => db.query("SELECT a FROM t WHERE b = ?").get(MARK));
  });

  it("a DIFFERENT statement returned by as() is guarded too", () => {
    const db = fresh();
    const sql = "SELECT a FROM t WHERE a = ?";
    const proto = Object.getPrototypeOf(db.prepare(sql));
    const original = proto.as;
    proto.as = function () { return (Database.prototype.prepare as any).call(db, sql); };   // a runtime whose as() makes a new statement
    try {
      class Row { a!: string; }
      const typed = db.prepare(sql).as(Row);
      expect(typed.get("plain")).toEqual({ a: "plain" });
      refused(() => typed.get(MARK));
    } finally { proto.as = original; }
  });

  it("is a subclass instance, and the factory passes the caller's options through", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-823-guard-"));
    try {
      const path = join(dir, "g.sqlite");
      const writer = openDatabase(path);
      expect(writer).toBeInstanceOf(GuardedDatabase);
      expect(writer).toBeInstanceOf(Database);
      writer.exec("CREATE TABLE t (a TEXT, b TEXT)");
      writer.run("INSERT INTO t (a, b) VALUES (?, ?)", ["plain", "row"]);
      writer.close();
      const reader = openDatabase(path, { readonly: true });
      expect(reader.prepare("SELECT a FROM t").get()).toEqual({ a: "plain" });
      expect(() => reader.run("INSERT INTO t (a, b) VALUES (?, ?)", ["no", "write"])).toThrow();   // still read-only
      refused(() => reader.prepare("SELECT a FROM t WHERE a = ?").get(MARK));                        // and still guarded
      reader.close();
      expect(() => openDatabase(join(dir, "absent.sqlite"), { readwrite: true, create: false })).toThrow();   // `create: false` kept
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("parameters are bound from a validated snapshot", () => {
  it("an array changed after iterate() was called binds the values that were checked", () => {
    const db = fresh();
    const params = ["plain"];
    const it = db.prepare("SELECT a FROM t WHERE a = ?").iterate(params as never);
    params[0] = MARK + "swapped-in";                                          // after the check, before the binding
    expect([...it]).toEqual([{ a: "plain" }]);
  });

  it("a getter-backed named parameter and a class instance are refused as programming errors", () => {
    const db = fresh();
    const st = db.prepare("SELECT a FROM t WHERE a = $a");
    let reads = 0;
    const sneaky = { get $a() { return ++reads === 1 ? "plain" : MARK + "second-read"; } };
    expect(() => st.get(sneaky as never)).toThrow(TypeError);
    class Params { $a = "plain"; }
    expect(() => st.get(new Params() as never)).toThrow(TypeError);
    expect(() => db.run("INSERT INTO t (a, b) VALUES ($a, $b)", new Params() as never)).toThrow(TypeError);
    // a null-prototype object of named parameters is a plain container
    const bare = Object.assign(Object.create(null), { $a: "plain" });
    expect(st.get(bare as never)).toEqual({ a: "plain" });
  });

  it("a non-enumerable named parameter with a mark is refused", () => {
    const db = fresh();
    const st = db.prepare("SELECT a FROM t WHERE a = $a");
    const hidden = {};
    Object.defineProperty(hidden, "$a", { value: MARK + "x", enumerable: false });
    refused(() => st.get(hidden as never));
    const fine = {};
    Object.defineProperty(fine, "$a", { value: "plain", enumerable: false });
    expect(st.get(fine as never)).toEqual({ a: "plain" });                     // Bun binds it; so does the guard's copy
  });
});

describe("the self-check", () => {
  it("passes on this runtime, on its own scratch database and on one given to it", () => {
    expect(() => guardSelfCheck()).not.toThrow();
    expect(() => guardSelfCheck(new GuardedDatabase(":memory:"))).not.toThrow();
  });

  it("fails on a method that lets a mark through, and names it", () => {
    const db = new GuardedDatabase(":memory:");
    (db as any).run = function (sql: string, ...params: unknown[]) { return (Database.prototype.run as any).call(this, sql, ...params); };
    expect(() => guardSelfCheck(db)).toThrow(/db\.run/);
    const plain = new Database(":memory:");                                   // no guard at all
    expect(() => guardSelfCheck(plain)).toThrow(/self-check/);
  });

  it("fails on a statement method that lets a mark through", () => {
    const db = new GuardedDatabase(":memory:");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string, ...params: unknown[]) => {
      const st = (prepare as any)(sql, ...params);
      const unguarded = (Database.prototype.prepare as any).call(db, sql);
      st.values = (...args: unknown[]) => unguarded.values(...args);
      return st;
    };
    expect(() => guardSelfCheck(db)).toThrow(/statement\.values/);
  });

  it("fails on a method that throws another error class for a mark", () => {
    const db = new GuardedDatabase(":memory:");
    const exec = db.exec.bind(db);
    (db as any).exec = (sql: string, ...params: unknown[]) => {
      try { return (exec as any)(sql, ...params); } catch (e) { if (e instanceof BomLeadingTextError) throw new RangeError("not the guard's class"); throw e; }
    };
    expect(() => guardSelfCheck(db)).toThrow(/db\.exec/);
  });

  it("fails on a method whose ordinary call fails", () => {
    const db = new GuardedDatabase(":memory:");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string, ...params: unknown[]) => {
      const st = (prepare as any)(sql, ...params);
      st.all = () => { throw new Error("this runtime's statements are sealed"); };
      return st;
    };
    expect(() => guardSelfCheck(db)).toThrow(/statement\.all/);
  });

  it("fails on a method whose ordinary call returns something else", () => {
    const db = new GuardedDatabase(":memory:");
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string, ...params: unknown[]) => {
      const st = (prepare as any)(sql, ...params);
      const get = st.get;
      st.get = (...args: unknown[]) => { get(...args); return { v: "not the row" }; };
      return st;
    };
    expect(() => guardSelfCheck(db)).toThrow(/unexpected result/);
  });

  it("its own deliberate refusals write no warning; the first REAL refusal of a process writes exactly one", () => {
    const script = `
      import { openDatabase, guardSelfCheck } from ${JSON.stringify(join(import.meta.dir, "../../src/sqlite-guard.ts"))};
      const db = openDatabase(":memory:");
      guardSelfCheck();
      db.exec("CREATE TABLE t (a TEXT)");
      process.stderr.write("--after-self-check--\\n");
      for (let i = 0; i < 3; i++) { try { db.run("INSERT INTO t (a) VALUES (?)", [String.fromCharCode(0xfeff) + "x"]); } catch {} }
      try { db.prepare("SELECT a FROM t WHERE a = ?").get(String.fromCharCode(0xfffe)); } catch {}
    `;
    const proc = Bun.spawnSync([process.execPath, "-e", script]);
    const err = proc.stderr.toString();
    const [before, after] = err.split("--after-self-check--\n");
    expect(before).toBe("");
    const lines = (after ?? "").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("clawmem doctor");
    expect(proc.exitCode).toBe(0);
  });
});
