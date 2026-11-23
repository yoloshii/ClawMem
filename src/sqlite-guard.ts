/**
 * BACKLOG 82.3, D6 — every database handle is a guarded one.
 *
 * SQLite stores a string bound with a leading U+FEFF without that character, and one with a leading U+FFFE with its
 * bytes read the other way round: the stored text is not the text that was bound, and a lookup with the same value
 * finds the altered row. The guard refuses such a binding, fail closed: a string parameter whose first code unit is
 * U+FEFF or U+FFFE throws `BomLeadingTextError` before any statement runs.
 *
 * `openDatabase` is the ONE place a handle is made. It returns a `GuardedDatabase`, a subclass of `bun:sqlite`'s
 * `Database` that checks the parameters of `run`, `exec`, `prepare` and `query`, and guards each statement IN
 * PLACE: the statement is the object Bun made, with its six binding methods replaced on the instance. Parameters
 * are bound from a validated SNAPSHOT, so what was checked is what is bound.
 */
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";

/** The first code unit that is refused: U+FEFF, or U+FFFE (its bytes swapped). */
type Mark = 0xfeff | 0xfffe;

/**
 * The guard's refusal. It means a writer missed its normalisation, or a consumer bound again an identifier that is
 * already stored with a leading mark. What is guaranteed is that the refused binding did not run.
 */
export class BomLeadingTextError extends Error {
  constructor(
    /** The mark the string starts with. */
    public readonly first: Mark,
    /** The first 60 characters of the statement. */
    public readonly sql: string,
    /** The position (from 0) or the name of the parameter. */
    public readonly parameter: number | string,
  ) {
    super(`a bound string starts with U+${first.toString(16).toUpperCase()} (parameter ${String(parameter)} of: ${sql}). ` +
      `SQLite would store it altered, so the statement did not run. 'clawmem doctor' lists stored values that start with such a mark.`);
    this.name = "BomLeadingTextError";
  }
}

/** True for the length of the self-check: its deliberate refusals write no warning and do not spend the flag. */
let selfChecking = false;
/** One warning per process, at the first REAL refusal — written here, so a catch above cannot suppress it. */
let warned = false;

function refuse(first: Mark, sql: string, parameter: number | string): never {
  const err = new BomLeadingTextError(first, sql.slice(0, 60), parameter);
  if (!selfChecking && !warned) {
    warned = true;
    try {
      process.stderr.write(`[clawmem] A statement was refused: a bound string starts with a byte-order mark (U+${first.toString(16).toUpperCase()}). ` +
        `Results of this process may be incomplete. Run 'clawmem doctor' to list stored values that start with such a mark.\n`);
    } catch { /* stderr is closed: the doctor and the scan stay the signals */ }
  }
  throw err;
}

/**
 * BACKLOG 82.3, D7 — the binding census (TESTS ONLY). With `CLAWMEM_TEST_BINDING_CENSUS=1` and a file named in
 * `CLAWMEM_TEST_BINDING_CENSUS_FILE`, every distinct pair (statement, parameter) through which a STRING is bound is
 * appended to that file, one JSON line each, by every process of the run, with the ORIGIN of the binding: `src`
 * when the code that made the binding call is under `src/`, `test` when it is a test's own SQL (a seed), `other`
 * otherwise — so a column written only by a test's seed does not count as written by ClawMem. The origin is read
 * at each binding call, not when the statement is prepared: `query` returns one cached statement to every caller of
 * the same SQL text.
 * `scripts/check-binding-census.ts` compares a recording with `tests/binding-census.json`. Off (the default) this
 * is one comparison with `null` per bound string and per prepared statement.
 */
const censusFile: string | null =
  process.env.CLAWMEM_TEST_BINDING_CENSUS === "1" && process.env.CLAWMEM_TEST_BINDING_CENSUS_FILE
    ? process.env.CLAWMEM_TEST_BINDING_CENSUS_FILE : null;
const censusSeen = new Set<string>();

/**
 * A statement as the census names it: white space collapsed. A READING statement also has each run of `?, ?, …`
 * written once (an `IN` list of any length is one pair per position). A WRITING statement (INSERT / REPLACE /
 * UPDATE — operator ruling 49 A) keeps every placeholder: its census maps each one to the column it writes, and a
 * folded `VALUES (?, …)` would no longer say which column a parameter feeds.
 */
export function censusStatement(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return /^(INSERT|REPLACE|UPDATE)\b/i.test(flat) ? flat : flat.replace(/\?(\s*,\s*\?)+/g, "?, …");
}

export type CensusOrigin = "src" | "test" | "other";

/** Where the statement comes from: the first stack frame outside this module. Census mode only. */
export function censusOriginOf(stack: string | undefined): CensusOrigin {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    if (line.includes("sqlite-guard.ts") || !line.includes("/")) continue;
    if (line.includes("/node_modules/")) continue;
    if (/\/tests?\//.test(line)) return "test";
    if (line.includes("/src/")) return "src";
    return "other";
  }
  return "other";
}
const censusOrigin = (): CensusOrigin | null => (censusFile === null ? null : censusOriginOf(new Error().stack));

function censusRecord(sql: string, parameter: number | string, origin: CensusOrigin | null): void {
  const statement = censusStatement(sql);
  const key = JSON.stringify([statement, parameter, origin ?? "other"]);
  if (censusSeen.has(key)) return;
  censusSeen.add(key);
  try { appendFileSync(censusFile!, key + "\n"); } catch { /* the census file is gone: the comparison will say so */ }
}

/**
 * A text value bound as BYTES (`CAST(? AS TEXT)` of its UTF-8, `src/stored-copy.ts`): the guard does not walk a blob,
 * so the stored-copy helper reports each such slot to the census itself. Off, this does nothing.
 */
export function censusNoteBytes(sql: string, parameter: number | string): void {
  if (censusFile !== null) censusRecord(sql, parameter, censusOrigin());
}

function checkString(value: string, sql: string, parameter: number | string, origin: CensusOrigin | null): void {
  if (censusFile !== null) censusRecord(sql, parameter, origin);
  const first = value.charCodeAt(0);
  if (first === 0xfeff || first === 0xfffe) refuse(first, sql, parameter);
}

/**
 * The arguments a binding call passes on, built from what was checked. A string is checked. An array is copied
 * element by element, each read once. Typed arrays and buffers are passed as they are — blobs are not text. An
 * object of named parameters is copied from its OWN property descriptors, enumerable or not; an accessor property,
 * or an object that is neither plain nor null-prototype, is a programming error (`TypeError`).
 */
function snapshot(args: readonly unknown[], sql: string, origin: CensusOrigin | null): unknown[] {
  const out = new Array<unknown>(args.length);
  for (let i = 0; i < args.length; i++) out[i] = snapshotOne(args[i], sql, i, origin);
  return out;
}

function snapshotOne(arg: unknown, sql: string, index: number, origin: CensusOrigin | null): unknown {
  if (typeof arg === "string") { checkString(arg, sql, index, origin); return arg; }
  if (arg === null || typeof arg !== "object") return arg;
  if (ArrayBuffer.isView(arg) || arg instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && arg instanceof SharedArrayBuffer)) return arg;
  if (Array.isArray(arg)) {
    const copy = new Array<unknown>(arg.length);
    for (let i = 0; i < arg.length; i++) {
      const value: unknown = arg[i];
      if (typeof value === "string") checkString(value, sql, i, origin);
      copy[i] = value;
    }
    return copy;
  }
  const proto = Object.getPrototypeOf(arg);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("sqlite guard: named parameters must be a plain object (a class instance was bound)");
  }
  const copy: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(arg)) {
    const descriptor = Object.getOwnPropertyDescriptor(arg, name)!;
    if (!("value" in descriptor)) throw new TypeError(`sqlite guard: named parameter ${name} is an accessor property`);
    const value: unknown = descriptor.value;
    if (typeof value === "string") checkString(value, sql, name, origin);
    copy[name] = value;
  }
  return copy;
}

const BINDING_METHODS = ["run", "get", "all", "values", "iterate", "raw"] as const;
/** Statements already guarded: the cached statement `query` returns again is not guarded twice. */
const guarded = new WeakSet<object>();

/** Guard a statement in place and return it — the same object. */
function guardStatement<S extends object>(statement: S, sql: string): S {
  if (guarded.has(statement)) return statement;
  const st = statement as Record<string, unknown>;
  for (const method of BINDING_METHODS) {
    const original = st[method];
    if (typeof original !== "function") continue;       // the self-check names a method this runtime lacks
    st[method] = function (...args: unknown[]) {
      return (original as (...a: unknown[]) => unknown).apply(statement, snapshot(args, sql, censusOrigin()));
    };
  }
  // `as()` and `safeIntegers()` return a statement (the same instance on Bun 1.3.14): whatever comes back is guarded.
  for (const method of ["as", "safeIntegers"] as const) {
    const original = st[method];
    if (typeof original !== "function") continue;
    st[method] = function (...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(statement, args);
      return result !== null && typeof result === "object" ? guardStatement(result, sql) : result;
    };
  }
  guarded.add(statement);
  return statement;
}

export class GuardedDatabase extends Database {
  // The signatures are Bun's; the bodies check, then delegate with the snapshot.
  override run(sql: string, ...params: any[]): any {
    return (super.run as (...a: unknown[]) => unknown)(sql, ...snapshot(params, sql, censusOrigin()));
  }

  override exec(sql: string, ...params: any[]): any {
    return (super.exec as (...a: unknown[]) => unknown)(sql, ...snapshot(params, sql, censusOrigin()));
  }

  override prepare(sql: string, ...params: any[]): any {
    return guardStatement((super.prepare as (...a: unknown[]) => object)(sql, ...snapshot(params, sql, censusOrigin())), sql);
  }

  override query(sql: string, ...params: any[]): any {
    return guardStatement((super.query as (...a: unknown[]) => object)(sql, ...snapshot(params, sql, censusOrigin())), sql);
  }
}

/**
 * The lowest Bun the release names: the lowest version the whole suite was RUN on and passed. Statements have no
 * `raw` before Bun 1.2.21 (1.2.0 and 1.2.20 were run: the self-check refuses them). Bun 1.2.21 passes the self-check,
 * but the suite does not pass on it (2026-11-21: 10 failures in 3 test files); no version between 1.2.21 and 1.3.14
 * was run.
 */
export const MINIMUM_BUN = "1.3.14";
const PROBE = String.fromCharCode(0xfeff) + "self-check";

/**
 * Prove the guard on a scratch database: for `db.run`, `db.exec`, `prepare(sql, params)` and a statement's six
 * methods, an ordinary call must SUCCEED with the expected result and a mark-led string must throw
 * `BomLeadingTextError` — that class, not any error. `as()`, `safeIntegers()`, `finalize()` and `close()` must work
 * on a guarded statement. Anything else throws, naming the method: on such a runtime no database is opened.
 */
export function guardSelfCheck(db: Database = new GuardedDatabase(":memory:")): void {
  const fail = (method: string, why: string): never => {
    throw new Error(`sqlite guard self-check failed at ${method}: ${why}. This runtime (Bun ${typeof Bun !== "undefined" ? Bun.version : "?"}) ` +
      `cannot open a vault safely; ClawMem needs Bun ${MINIMUM_BUN} or newer.`);
  };
  const ordinary = <T>(method: string, call: () => T, ok: (out: T) => boolean): void => {
    let out: T;
    try { out = call(); } catch (e) { return fail(method, `an ordinary call threw (${(e as Error).message})`); }
    if (!ok(out)) fail(method, "an ordinary call returned an unexpected result");
  };
  const mark = (method: string, call: () => unknown): void => {
    try {
      const out = call();
      if (out !== null && typeof out === "object" && typeof (out as Iterator<unknown>).next === "function") (out as Iterator<unknown>).next();
    } catch (e) {
      if (e instanceof BomLeadingTextError) return;
      return fail(method, `a mark-led string raised ${(e as Error)?.name ?? "an error"} and not BomLeadingTextError`);
    }
    fail(method, "a mark-led string was bound");
  };
  const any = db as any;
  selfChecking = true;
  try {
    ordinary("db.exec", () => any.exec("CREATE TABLE guard_check (v TEXT)"), () => true);
    ordinary("db.run", () => any.run("INSERT INTO guard_check (v) VALUES (?)", ["ok"]), (r: any) => r?.changes === 1);
    mark("db.run", () => any.run("INSERT INTO guard_check (v) VALUES (?)", [PROBE]));
    ordinary("db.exec", () => any.exec("INSERT INTO guard_check (v) VALUES (?)", ["ok-exec"]), (r: any) => r?.changes === 1);
    mark("db.exec", () => any.exec("INSERT INTO guard_check (v) VALUES (?)", [PROBE]));
    ordinary("db.prepare", () => any.prepare("SELECT v FROM guard_check WHERE v = ?", ["ok"]).get(), (r: any) => r?.v === "ok");
    mark("db.prepare", () => any.prepare("SELECT v FROM guard_check WHERE v = ?", [PROBE]));
    const select = "SELECT v FROM guard_check WHERE v = ?";
    const rows: Record<string, (out: any) => boolean> = {
      get: out => out?.v === "ok",
      all: out => Array.isArray(out) && out.length === 1 && out[0]?.v === "ok",
      values: out => Array.isArray(out) && out.length === 1 && out[0]?.[0] === "ok",
      iterate: out => { const got = [...out]; return got.length === 1 && got[0]?.v === "ok"; },
      raw: out => Array.isArray(out) && out.length === 1,
    };
    for (const [method, ok] of Object.entries(rows)) {
      ordinary(`statement.${method}`, () => any.prepare(select)[method]("ok"), ok);
      mark(`statement.${method}`, () => any.prepare(select)[method](PROBE));
    }
    ordinary("statement.run", () => any.prepare("INSERT INTO guard_check (v) VALUES (?)").run("ok-run"), (r: any) => r?.changes === 1);
    mark("statement.run", () => any.prepare("INSERT INTO guard_check (v) VALUES (?)").run(PROBE));
    class Row { v!: string; }
    ordinary("statement.as", () => any.prepare(select).as(Row).get("ok"), (r: any) => r instanceof Row && r.v === "ok");
    mark("statement.as", () => any.prepare(select).as(Row).get(PROBE));
    ordinary("statement.safeIntegers", () => any.prepare(select).safeIntegers(true).get("ok"), (r: any) => r?.v === "ok");
    mark("statement.safeIntegers", () => any.prepare(select).safeIntegers(true).get(PROBE));
    ordinary("statement.finalize", () => { const st = any.prepare(select); st.finalize(); return true; }, () => true);
    ordinary("db.close", () => { any.close(); return true; }, () => true);
  } finally {
    selfChecking = false;
  }
}

let checked = false;
/** The ONE place a database handle is made. The caller's options are passed through unchanged. */
export function openDatabase(path: string, options?: ConstructorParameters<typeof Database>[1]): GuardedDatabase {
  if (!checked) {
    guardSelfCheck();                                   // throws on a runtime the guard does not hold on: nothing is opened
    checked = true;
  }
  return options === undefined ? new GuardedDatabase(path) : new GuardedDatabase(path, options);
}
