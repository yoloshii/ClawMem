/**
 * BACKLOG 82.3, D7 — the binding census, as operator ruling 49 A scopes it: WRITING statements only (INSERT,
 * REPLACE, UPDATE), classed per table COLUMN. The guard's test recorder (`src/sqlite-guard.ts`, env
 * `CLAWMEM_TEST_BINDING_CENSUS`) writes one JSON line `[statement, parameter]` per distinct string binding; this
 * module maps each WRITING pair to the column its parameter writes, or to the statement's search condition (a
 * `WHERE`, a `FROM`, an `ON CONFLICT` target) — which writes nothing and stays with the guard, as SELECT bindings do.
 *
 * The mapper reads only the statement text. It knows the shapes `src/` uses: `INSERT [OR x] INTO t (cols)
 * VALUES (…)[, (…)]` with an optional upsert clause, `INSERT … (cols) SELECT …`, and `UPDATE [OR x] t SET c = …,
 * … [FROM …] [WHERE …]`. A shape it does not know is reported as such, never guessed.
 */

export type Placeholder = { index: number | string };
export type Target =
  | { kind: "column"; table: string; column: string }
  | { kind: "condition"; table: string }
  | { kind: "unknown"; reason: string };

type Token = { t: "word" | "ident" | "string" | "num" | "punct" | "param"; v: string };

/** Tokens of one statement. Quoted identifiers lose their quotes; a string literal is one token. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { const end = sql.indexOf("*/", i + 2); i = end < 0 ? sql.length : end + 2; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out.push({ t: "string", v: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const j = sql.indexOf(close, i + 1);
      out.push({ t: "ident", v: sql.slice(i + 1, j < 0 ? sql.length : j) }); i = j < 0 ? sql.length : j + 1; continue;
    }
    if (c === "?") {
      let j = i + 1; while (j < sql.length && /[0-9]/.test(sql[j]!)) j++;
      out.push({ t: "param", v: sql.slice(i, j) }); i = j; continue;
    }
    if ((c === "$" || c === ":" || c === "@") && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      let j = i + 1; while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      out.push({ t: "param", v: sql.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1; while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      out.push({ t: "word", v: sql.slice(i, j) }); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1; while (j < sql.length && /[0-9.eE]/.test(sql[j]!)) j++;
      out.push({ t: "num", v: sql.slice(i, j) }); i = j; continue;
    }
    const two = sql.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "==", "||", "->"].includes(two)) { out.push({ t: "punct", v: two }); i += 2; continue; }
    out.push({ t: "punct", v: c }); i++;
  }
  return out;
}

const isWord = (tok: Token | undefined, ...words: string[]) =>
  tok !== undefined && tok.t === "word" && words.includes(tok.v.toUpperCase());

/** True for a statement the 49 A census covers. */
export function isWritingStatement(sql: string): boolean {
  return /^\s*(INSERT|REPLACE|UPDATE)\b/i.test(sql);
}

/**
 * The parameter key of each placeholder token, in order: `?` is numbered from 0 as the recorder numbers
 * positional arguments; `?NNN` is NNN - 1; a named parameter keeps its name (`$a`).
 */
function paramKey(tok: Token, positional: { next: number }): number | string {
  if (tok.v === "?") return positional.next++;
  if (tok.v.startsWith("?")) return Number(tok.v.slice(1)) - 1;
  return tok.v;
}

/** Split tokens [from, to) at top-level commas. */
function splitTop(toks: Token[], from: number, to: number): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0, start = from;
  for (let k = from; k < to; k++) {
    const v = toks[k]!;
    if (v.t === "punct" && v.v === "(") depth++;
    else if (v.t === "punct" && v.v === ")") depth--;
    else if (v.t === "punct" && v.v === "," && depth === 0) { parts.push([start, k]); start = k + 1; }
  }
  if (start < to) parts.push([start, to]);
  return parts;
}

/** Index of the matching `)` for the `(` at `open`. */
function closeOf(toks: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    if (toks[k]!.t === "punct" && toks[k]!.v === "(") depth++;
    else if (toks[k]!.t === "punct" && toks[k]!.v === ")") { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/** First top-level token at or after `from` that is one of `words`; `toks.length` when none. */
function findTop(toks: Token[], from: number, words: string[]): number {
  let depth = 0;
  for (let k = from; k < toks.length; k++) {
    const v = toks[k]!;
    if (v.t === "punct" && v.v === "(") depth++;
    else if (v.t === "punct" && v.v === ")") depth--;
    else if (depth === 0 && isWord(v, ...words)) return k;
  }
  return toks.length;
}

const nameOf = (tok: Token | undefined): string | null =>
  tok && (tok.t === "word" || tok.t === "ident") ? tok.v : null;

/** `[schema.]name` starting at k: the name and the index after it. */
function tableAt(toks: Token[], k: number): { name: string; next: number } | null {
  const first = nameOf(toks[k]);
  if (first === null) return null;
  if (toks[k + 1]?.t === "punct" && toks[k + 1]!.v === "." && nameOf(toks[k + 2]) !== null) {
    return { name: nameOf(toks[k + 2])!, next: k + 3 };
  }
  return { name: first, next: k + 1 };
}

/**
 * Map every placeholder of a writing statement to what it feeds. `columnsOf` answers a table's column order, for
 * an `INSERT` without a column list. Returns the target of each parameter key; a key that occurs more than once
 * (a named parameter used twice) collects every target.
 */
export function mapWritingStatement(sql: string, columnsOf?: (table: string) => string[] | null): Map<number | string, Target[]> {
  const toks = tokenize(sql);
  const result = new Map<number | string, Target[]>();
  const positional = { next: 0 };
  const put = (tok: Token, target: Target) => {
    const key = paramKey(tok, positional);
    const list = result.get(key) ?? [];
    list.push(target);
    result.set(key, list);
  };
  /** Every placeholder in [from, to) feeds `target`. */
  const feed = (from: number, to: number, target: Target) => {
    for (let k = from; k < to; k++) if (toks[k]!.t === "param") put(toks[k]!, target);
  };
  const unknown = (reason: string) => { feed(0, toks.length, { kind: "unknown", reason }); return result; };

  /** `c = expr, …` from `from` to `to`: each expr's placeholders feed column c. */
  const assignments = (table: string, from: number, to: number): boolean => {
    for (const [a, b] of splitTop(toks, from, to)) {
      const col = nameOf(toks[a]);
      if (col === null || !(toks[a + 1]?.t === "punct" && (toks[a + 1]!.v === "=" || toks[a + 1]!.v === "=="))) return false;
      feed(a + 2, b, { kind: "column", table, column: col });
    }
    return true;
  };

  let k = 0;
  if (isWord(toks[0], "UPDATE")) {
    k = 1;
    if (isWord(toks[k], "OR")) k += 2;
    const t = tableAt(toks, k);
    if (t === null) return unknown("no table after UPDATE");
    k = t.next;
    if (isWord(toks[k], "AS")) k += 2; else if (nameOf(toks[k]) !== null && !isWord(toks[k], "SET")) k += 1;
    if (!isWord(toks[k], "SET")) return unknown("no SET");
    const end = findTop(toks, k + 1, ["FROM", "WHERE", "RETURNING"]);
    if (!assignments(t.name, k + 1, end)) return unknown("a SET item that is not `column = expression`");
    feed(end, toks.length, { kind: "condition", table: t.name });
    return result;
  }

  if (!isWord(toks[0], "INSERT", "REPLACE")) return unknown("not a writing statement");
  k = 1;
  if (isWord(toks[k], "OR")) k += 2;
  if (!isWord(toks[k], "INTO")) return unknown("no INTO");
  const t = tableAt(toks, k + 1);
  if (t === null) return unknown("no table after INTO");
  k = t.next;
  if (isWord(toks[k], "AS")) k += 2;
  let columns: string[] | null = null;
  if (toks[k]?.t === "punct" && toks[k]!.v === "(") {
    const close = closeOf(toks, k);
    columns = splitTop(toks, k + 1, close).map(([a, b]) => (b - a === 1 ? nameOf(toks[a]) : null) ?? "?");
    if (columns.includes("?")) return unknown("a column list item that is not a name");
    k = close + 1;
  } else {
    columns = columnsOf?.(t.name) ?? null;
    if (columns === null) return unknown(`INSERT without a column list, and the columns of ${t.name} are not known`);
  }

  // the source of the rows: VALUES tuples, or a SELECT
  let after: number;
  if (isWord(toks[k], "VALUES")) {
    k++;
    while (toks[k]?.t === "punct" && toks[k]!.v === "(") {
      const close = closeOf(toks, k);
      const exprs = splitTop(toks, k + 1, close);
      if (exprs.length !== columns.length) return unknown(`${exprs.length} values for ${columns.length} columns`);
      exprs.forEach(([a, b], i) => feed(a, b, { kind: "column", table: t.name, column: columns![i]! }));
      k = close + 1;
      if (toks[k]?.t === "punct" && toks[k]!.v === ",") k++; else break;
    }
    after = k;
  } else if (isWord(toks[k], "SELECT")) {
    const from = findTop(toks, k + 1, ["FROM", "WHERE", "GROUP", "ORDER", "LIMIT", "ON", "RETURNING"]);
    const exprs = splitTop(toks, k + 1, from);
    if (exprs.length !== columns.length) return unknown(`${exprs.length} selected values for ${columns.length} columns`);
    exprs.forEach(([a, b], i) => feed(a, b, { kind: "column", table: t.name, column: columns![i]! }));
    // the rows' source and condition, up to an upsert clause
    const upsert = findTop(toks, from, ["ON", "RETURNING"]);
    feed(from, upsert, { kind: "condition", table: t.name });
    after = upsert;
  } else if (isWord(toks[k], "DEFAULT")) {
    after = k + 2;
  } else {
    return unknown("neither VALUES nor SELECT");
  }

  // an upsert clause: ON CONFLICT (target) [WHERE …] DO UPDATE SET c = expr, … [WHERE …] | DO NOTHING
  k = after;
  while (isWord(toks[k], "ON")) {
    const doAt = findTop(toks, k, ["DO"]);
    feed(k, doAt, { kind: "condition", table: t.name });
    if (isWord(toks[doAt + 1], "NOTHING")) { k = doAt + 2; continue; }
    if (!(isWord(toks[doAt + 1], "UPDATE") && isWord(toks[doAt + 2], "SET"))) return unknown("an upsert clause it does not know");
    const end = findTop(toks, doAt + 3, ["WHERE", "ON", "RETURNING"]);
    if (!assignments(t.name, doAt + 3, end)) return unknown("an upsert SET item that is not `column = expression`");
    k = end;
    if (isWord(toks[k], "WHERE")) { const next = findTop(toks, k + 1, ["ON", "RETURNING"]); feed(k, next, { kind: "condition", table: t.name }); k = next; }
  }
  feed(k, toks.length, { kind: "condition", table: t.name });     // RETURNING binds nothing; anything left is a condition
  return result;
}

export type CensusPair = [statement: string, parameter: number | string, origin?: "src" | "test" | "other"];

/** The census file: one `[statement, parameter, origin]` per line (an older recording has no origin). */
export function readCensus(text: string): CensusPair[] {
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as CensusPair);
}

export const COLUMN_CLASSES = [
  "constant/generated",   // written only with a value the program makes: a timestamp, an enum, a hash, a key it builds
  "normalised",           // free text: a leading mark is removed before the write (`row` names the D7 table row)
  "identifier",           // refused when led by a mark (D7 identifiers and selectors)
  "json-list",            // `JSON.stringify` output: starts with `[`, `{` or `"`
  "stored-copy",          // copied from one stored row to another as its bytes (`src/stored-copy.ts`)
  "guarded",              // free text written as a string: a mark-led value is refused by the guard (ruling 55 A)
] as const;
export type ColumnClass = (typeof COLUMN_CLASSES)[number];

export type CensusTable = {
  /** `table.column` → its class; a `normalised` column names its row of the D7 table. */
  columns: Record<string, { class: ColumnClass; row?: string; note?: string }>;
};

export type CensusComparison = {
  /** Written columns of vault tables that the table does not class. */
  unclassed: { column: string; statement: string }[];
  /** Classed columns that no recorded binding wrote. */
  unreached: string[];
  /** Writing statements the mapper could not read. */
  unreadable: { statement: string; reason: string }[];
  /** Tables written that a fresh vault does not have (test scaffolding), with their columns. */
  outsideVault: string[];
  /** Every written vault column the run reached from ClawMem's own statements. */
  reached: string[];
  /** Vault columns written ONLY by a test's own SQL (a seed): not counted as reached. */
  testOnly: string[];
};

/**
 * Compare one recorded census with the checked-in table. `vaultColumns(table)` answers the columns of a table a
 * fresh vault has, or null for a table it does not have. A binding in a statement's search condition writes no
 * column and is not compared (it stays with the guard, as SELECT bindings do).
 */
export function compareCensus(
  pairs: CensusPair[],
  table: CensusTable,
  vaultColumns: (table: string) => string[] | null,
): CensusComparison {
  const reached = new Map<string, string>();
  const byTests = new Set<string>();
  const unreadable = new Map<string, string>();
  const outside = new Set<string>();
  const mapped = new Map<string, Map<number | string, Target[]>>();
  for (const [statement, parameter, origin] of pairs) {
    if (!isWritingStatement(statement)) continue;
    if (statement.includes("?, …")) { unreadable.set(statement, "placeholders folded by an older recorder"); continue; }
    let targets = mapped.get(statement);
    if (!targets) { targets = mapWritingStatement(statement, vaultColumns); mapped.set(statement, targets); }
    const list = targets.get(parameter);
    if (!list) { unreadable.set(statement, `parameter ${String(parameter)} has no placeholder`); continue; }
    for (const target of list) {
      if (target.kind === "unknown") { unreadable.set(statement, target.reason); continue; }
      if (target.kind === "condition") continue;
      const cols = vaultColumns(target.table);
      if (cols === null) { outside.add(`${target.table}.${target.column}`); continue; }
      const key = `${target.table}.${target.column}`;
      if (origin === "test") { byTests.add(key); continue; }
      if (!reached.has(key)) reached.set(key, statement);
    }
  }
  const unclassed = [...reached].filter(([c]) => !(c in table.columns)).map(([column, statement]) => ({ column, statement }));
  const unreached = Object.keys(table.columns).filter(c => !reached.has(c)).sort();
  return {
    unclassed: unclassed.sort((a, b) => a.column.localeCompare(b.column)),
    unreached,
    unreadable: [...unreadable].map(([statement, reason]) => ({ statement, reason })),
    outsideVault: [...outside].sort(),
    reached: [...reached.keys()].sort(),
    testOnly: [...byTests].filter(c => !reached.has(c)).sort(),
  };
}

/**
 * The tables ClawMem itself creates: every `CREATE [VIRTUAL] TABLE [IF NOT EXISTS] name` in the given source texts.
 * Some are created only when a feature first runs, so a fresh vault does not have them all; a table no source text
 * creates (a test's scratch table) is not a vault table and its columns are not classed.
 */
export function createdTables(sources: string[]): Set<string> {
  const names = new Set<string>();
  const re = /CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(?:main\.)?["`[]?(?!IF\b)([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const text of sources) for (const m of text.matchAll(re)) names.add(m[1]!);
  return names;
}

/**
 * The columns a source text gives each table it creates: the names in `CREATE TABLE name (…)` (constraints left
 * out) and every `ALTER TABLE name ADD [COLUMN] col`. Used for a table a fresh vault does not have yet.
 */
export function createdColumns(sources: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (t: string, c: string) => { const s = out.get(t) ?? new Set<string>(); s.add(c); out.set(t, s); };
  // The statements sit inside TypeScript strings, so each one is read from where it starts, not as part of the file.
  const starts = /\b(CREATE|ALTER)\s+(?:(?:TEMP|TEMPORARY|VIRTUAL)\s+)*TABLE\b/gi;
  for (const raw of sources) {
    const text = raw.replace(/\$\{[^}]*\}/g, " x ");
    for (const m of text.matchAll(starts)) {
      const toks = tokenize(text.slice(m.index!, m.index! + 4000));
      let j = 1;
      while (isWord(toks[j], "TEMP", "TEMPORARY", "VIRTUAL")) j++;
      j++;                                                           // TABLE
      if (m[1]!.toUpperCase() === "ALTER") {
        const t = tableAt(toks, j);
        if (t === null || !isWord(toks[t.next], "ADD")) continue;
        let c = t.next + 1;
        if (isWord(toks[c], "COLUMN")) c++;
        const name = nameOf(toks[c]);
        if (name) add(t.name, name);
        continue;
      }
      if (isWord(toks[j], "IF")) j += 3;
      const t = tableAt(toks, j);
      if (t === null) continue;
      j = t.next;
      if (isWord(toks[j], "USING")) j += 2;
      if (!(toks[j]?.t === "punct" && toks[j]!.v === "(")) continue;
      const close = closeOf(toks, j);
      if (close < 0) continue;
      for (const [a] of splitTop(toks, j + 1, close)) {
        const name = nameOf(toks[a]);
        if (name && !isWord(toks[a], "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT")) add(t.name, name);
      }
    }
  }
  return out;
}

/** A table's columns: from a fresh vault when it has the table, else from the source text; null when no source creates it. */
export function vaultColumnsOf(fresh: (table: string) => string[], sources: string[]): (table: string) => string[] | null {
  const created = createdTables(sources);
  const fromSource = createdColumns(sources);
  return (table: string) => {
    const cols = fresh(table);
    if (cols.length > 0) return cols;
    if (!created.has(table)) return null;
    return [...(fromSource.get(table) ?? [])];
  };
}
