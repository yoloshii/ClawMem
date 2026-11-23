/**
 * BACKLOG 82.3, D7 — STORED → STORED copies never bind text as a string. A string bound by `bun:sqlite` that starts
 * with U+FEFF or U+FFFE is changed by SQLite (the mark dropped, or every later code unit byte-swapped), and the guard
 * refuses such a binding. A value that is already stored is copied as its bytes instead: written as
 * `CAST(? AS TEXT)` of its UTF-8 bytes — exact for every case, the empty string included — and a blob parameter is
 * not walked by the guard. Values of other types are bound as they are, so a copy keeps each value's SQLite type.
 *
 * A value the caller COMPUTES and writes fresh does not use this module: it goes through the normal guarded binding,
 * and a mark-led one is refused.
 *
 * The binding census cannot see a blob parameter, so each text slot bound here is reported to it by hand.
 */
import type { Database } from "bun:sqlite";
import { censusNoteBytes } from "./sqlite-guard.ts";

const utf8 = new TextEncoder();

/** A stored TEXT value held as its bytes — read with `CAST(col AS BLOB)`, so even bytes that are not UTF-8 survive. */
export class StoredText {
  constructor(readonly bytes: Uint8Array) {}
}

/**
 * Run `sql` with `args`, where each `?T` placeholder is a STORED COPY: a string there is bound as its UTF-8 bytes in
 * `CAST(? AS TEXT)`, anything else (a number, a blob, null) as itself. Plain `?` placeholders keep the normal guarded
 * binding. Positional placeholders only; `args` follows their order.
 */
export function runExact(db: Database, sql: string, args: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint } {
  let i = 0;
  const bound: unknown[] = [];
  const bytesAt: number[] = [];
  const text = sql.replace(/\?T\b|\?/g, (m) => {
    const value = args[i];
    const at = i++;
    if (m === "?T" && (typeof value === "string" || value instanceof StoredText)) {
      bytesAt.push(at);
      bound.push(typeof value === "string" ? utf8.encode(value) : value.bytes);
      return "CAST(? AS TEXT)";
    }
    bound.push(value === undefined ? null : value);
    return "?";
  });
  if (i !== args.length) throw new TypeError(`runExact: ${i} placeholders for ${args.length} values`);
  for (const at of bytesAt) censusNoteBytes(text, at);
  return db.query(text).run(...(bound as any[])) as { changes: number; lastInsertRowid: number | bigint };
}

/** `INSERT INTO table (cols) VALUES (?T, …)`: every value of a stored row copied exactly. */
export function insertExact(db: Database, table: string, cols: readonly string[], values: readonly unknown[]): void {
  if (cols.length !== values.length) throw new TypeError(`insertExact: ${cols.length} columns for ${values.length} values`);
  runExact(db, `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?T").join(", ")})`, values);
}

/**
 * Read `cols` of `table` exactly, rowid order not implied: a TEXT value comes back as a `StoredText` (its bytes), every
 * other value as `bun:sqlite` returns it. `where` is a SQL condition on the table (trusted text, no parameters).
 */
export function selectExact(db: Database, table: string, cols: readonly string[], where = ""): unknown[][] {
  const list = cols.map(c => `typeof(${c}), CASE WHEN typeof(${c}) = 'text' THEN CAST(${c} AS BLOB) ELSE ${c} END`).join(", ");
  const rows = db.prepare(`SELECT ${list} FROM ${table}${where ? ` WHERE ${where}` : ""}`).values() as unknown[][];
  return rows.map(r => cols.map((_, k) => (r[2 * k] === "text" ? new StoredText(r[2 * k + 1] as Uint8Array) : r[2 * k + 1])));
}
