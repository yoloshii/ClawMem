/**
 * BACKLOG 82.3, D7 — stored identifiers that start with a byte-order mark: FOUND AND REPORTED, never repaired.
 *
 * Such a value can exist without any special writer: a path that began with TWO marks was stored with one by every
 * version before 82.3. Nothing in ClawMem reads such a value specially, and nothing rewrites, moves or deletes its
 * row because of the mark (operator ruling D8 = C). A consumer that binds it again is stopped by the guard
 * (`BomLeadingTextError`). This module is the POINTER to those rows: `clawmem doctor` prints what it finds.
 *
 * It is best effort, and says so: a column this list lacks, an untyped log column that holds a serialised row, and a
 * value inside JSON are not seen. The guarantee is the guard, which sees every binding.
 */
import type { Database } from "bun:sqlite";

/**
 * How a column's value is built, which decides WHAT is tested:
 *  - `plain` — the value is one identifier: the whole value is tested;
 *  - `collection/path` — the collection stands before the FIRST slash and the path is everything after it; its
 *    reader binds those two, so those two are tested (a mark after a LATER slash is inside a sound path);
 *  - `unknown-composite` — a value made of parts whose encoding this list does not know: a mark at the start, or
 *    after any slash, is reported as an UNCONFIRMED candidate, to be checked before any cleanup.
 */
export type IdentifierEncoding = "plain" | "collection/path" | "unknown-composite";
export type IdentifierColumn = { table: string; column: string; encoding: IdentifierEncoding };

const plain = (table: string, ...columns: string[]): IdentifierColumn[] => columns.map(column => ({ table, column, encoding: "plain" }));

/** The identifier columns of this version's schema. A table a vault does not have is skipped by the scan. */
export const IDENTIFIER_COLUMNS: readonly IdentifierColumn[] = Object.freeze([
  // a document: its collection, its path, its derived key
  ...plain("documents", "collection", "path", "topic_key"),
  ...plain("consolidated_observations", "collection"),
  ...plain("session_docs", "session_id", "transcript_key", "path"),
  // sessions, transcripts and the keys derived from them
  ...plain("session_log", "session_id"),
  { table: "session_log", column: "handoff_path", encoding: "collection/path" },
  ...plain("session_transcripts", "session_id", "transcript_key", "transcript_path", "session_key"),
  ...plain("context_usage", "session_id", "transcript_key", "session_key", "dedupe_key"),
  ...plain("recall_events", "session_id", "dedupe_key"),
  ...plain("compaction_state", "session_id"),
  ...plain("stop_cursors", "session_id", "transcript_key", "transcript_path"),
  ...plain("stop_items", "session_id", "transcript_key"),
  ...plain("stop_retries", "session_id", "transcript_key", "transcript_path", "range_key"),
  ...plain("hermes_marks", "session_id", "transcript_key"),
  ...plain("hermes_scan", "session_id", "transcript_key"),
  ...plain("judge_deferred", "session_id"),
  ...plain("causal_due", "session_id", "transcript_key", "range_key", "run_key"),
  ...plain("causal_runs", "run_key", "session_id"),
  ...plain("causal_witness_sightings", "run_key"),
  ...plain("retired_causal_edges", "retired_run_key"),
  // the stored model name
  ...plain("content_vectors", "model"),
  ...plain("causal_runs", "model"),
  ...plain("causal_witness_sightings", "model_identity"),
  ...plain("judge_runs", "session_id", "model"),
  // entities
  ...plain("entity_nodes", "entity_id", "vault"),
  ...plain("entities_fts", "entity_id"),
  ...plain("entity_cooccurrences", "entity_a", "entity_b"),
  // a session's registration; the repair logs' copied row keys (an id, or two ids joined: encoding not confirmed)
  ...plain("registration", "session_id"),
  { table: "entity_repair_log", column: "row_key", encoding: "unknown-composite" },
  { table: "counter_repair_log", column: "row_key", encoding: "unknown-composite" },
  ...plain("entity_mentions", "entity_id"),
  ...plain("entity_triples", "subject_entity_id", "object_entity_id"),
  // display paths (`collection/path`) kept as references to a document
  ...plain("feedback_ledger", "vault"),
  { table: "feedback_ledger", column: "display_path", encoding: "collection/path" },
  { table: "utility_signals", column: "path", encoding: "collection/path" },
  // composites whose encoding was not confirmed for this list
  { table: "co_activations", column: "doc_a", encoding: "unknown-composite" },
  { table: "co_activations", column: "doc_b", encoding: "unknown-composite" },
]);

const MARK_BYTES = `X'EFBBBF', X'EFBFBE'`;
/**
 * SQL that is 1 for a value led by U+FEFF or U+FFFE and 0 for U+FFFD or a plain value; for the empty string and for
 * NULL it is NULL — so in a `WHERE` it selects exactly the marked rows. (`unicode()` cannot do this: it reads a
 * stored U+FFFE as 65533, the same as U+FFFD.)
 */
export const MARK_PREDICATE = (expr: string): string => `substr(CAST(${expr} AS BLOB), 1, 3) IN (${MARK_BYTES})`;
/** The same test on what follows the FIRST slash of the value. */
const PATH_PREDICATE = (expr: string): string =>
  `(instr(CAST(${expr} AS BLOB), X'2F') > 0 AND substr(CAST(${expr} AS BLOB), instr(CAST(${expr} AS BLOB), X'2F') + 1, 3) IN (${MARK_BYTES}))`;
/** A mark after ANY slash: for a composite of unknown encoding only. */
const ANY_SLASH_PREDICATE = (expr: string): string =>
  `(instr(CAST(${expr} AS BLOB), X'2FEFBBBF') > 0 OR instr(CAST(${expr} AS BLOB), X'2FEFBFBE') > 0)`;

export type MarkedIdentifier = {
  table: string;
  column: string;
  rowid: number;
  /** What starts with the mark: the whole value (for a composite: its collection), or the path after the first slash. */
  component: "whole" | "path";
  /** The value's bytes in hex — the first 64, with `truncated` set when there are more. */
  hex: string;
  truncated: boolean;
  /** False for a composite of unknown encoding: a candidate to check before any cleanup. */
  confirmed: boolean;
  /**
   * Rulings 71 A, 72 A: true when no reader binds the value again — an identifier of an INACTIVE document (a search,
   * a hook and `update` read active rows only; a restore makes it active, and the next scan counts it again), or a
   * value of an `INERT_COLUMNS` column. Still listed, as a record; it alone does not fail the check.
   */
  inert: boolean;
};

export type MarkedIdentifierScan = {
  found: MarkedIdentifier[];
  /** Listed tables this vault does not have (some are created only when a feature first runs). */
  skippedTables: string[];
  /** True when a column held more marked rows than `limitPerColumn`: the list is then not complete. */
  limited: boolean;
  /** Every marked row of every column, counted apart from the display cap (Codex T1 P1): actionable and inert. */
  counts: { live: number; inert: number };
};

const HEX_BYTES = 64;
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * The stored identifiers that start with a byte-order mark. Read-only: SELECT statements on the caller's handle,
 * which may be a read-only one. At most `limitPerColumn` rows per column (default 50).
 */
/**
 * Columns whose STORED values no reader binds again in a refusable way (rulings 71 A, 72 A, 73 A). `any`: a stored
 * session id (a session is read by the current session's id, checked at the boundary). `path`: a value every reader
 * binds WHOLE — a feedback-ledger display path, the utility-signal path copied from it, a repair log's row key — is
 * inert only when its mark comes AFTER the slash (not refused, stored exactly); one that STARTS with a mark would be
 * refused when bound whole, so it is counted.
 */
const INERT_COLUMNS = new Map<string, "any" | "path">([
  ["session_log.session_id", "any"],
  ["feedback_ledger.display_path", "path"], ["utility_signals.path", "path"],
  ["counter_repair_log.row_key", "path"], ["entity_repair_log.row_key", "path"],
]);

export function scanMarkedIdentifiers(db: Database, opts: { limitPerColumn?: number } = {}): MarkedIdentifierScan {
  const limit = opts.limitPerColumn ?? 50;
  const found: MarkedIdentifier[] = [];
  const skipped = new Set<string>();
  let limited = false;
  const counts = { live: 0, inert: 0 };
  const columnsOf = new Map<string, Set<string> | null>();
  const columns = (table: string): Set<string> | null => {
    if (!columnsOf.has(table)) {
      const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
      columnsOf.set(table, rows.length === 0 ? null : new Set(rows.map(r => r.name)));
    }
    return columnsOf.get(table)!;
  };

  for (const entry of IDENTIFIER_COLUMNS) {
    const cols = columns(entry.table);
    if (cols === null) { skipped.add(entry.table); continue; }
    if (!cols.has(entry.column)) continue;                               // an older vault without this column
    const col = quote(entry.column);
    const whole = MARK_PREDICATE(col);
    const other = entry.encoding === "collection/path" ? PATH_PREDICATE(col)
      : entry.encoding === "unknown-composite" ? ANY_SLASH_PREDICATE(col) : null;
    const where = other ? `(${whole}) OR ${other}` : whole;
    // the inert rule of rulings 71 A–73 A as SQL, so the counts and the order need no display cut (Codex T1 P1)
    const kind = INERT_COLUMNS.get(`${entry.table}.${entry.column}`);
    const inertParts = [
      ...(entry.table === "documents" && cols.has("active") ? ["active = 0"] : []),
      ...(kind === "any" ? ["1"] : kind === "path" ? [`COALESCE((${whole}), 0) <> 1`] : []),
    ];
    const inertExpr = inertParts.length > 0 ? `(${inertParts.join(" OR ")})` : "0";
    const tally = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN ${inertExpr} THEN 1 ELSE 0 END), 0) AS inert FROM ${quote(entry.table)} WHERE ${where}`,
    ).get() as { n: number; inert: number };
    counts.inert += tally.inert;
    counts.live += tally.n - tally.inert;
    if (tally.n > limit) limited = true;
    const rows = db.prepare(
      `SELECT rowid AS rid, (${whole}) AS at_start, hex(substr(CAST(${col} AS BLOB), 1, ${HEX_BYTES})) AS head,
              length(CAST(${col} AS BLOB)) AS bytes, ${entry.table === "documents" && cols.has("active") ? "active" : "NULL"} AS act,
              (CASE WHEN ${inertExpr} THEN 1 ELSE 0 END) AS inert_first
       FROM ${quote(entry.table)} WHERE ${where} ORDER BY inert_first, rowid LIMIT ${limit}`,
    ).all() as { rid: number; at_start: number | null; head: string; bytes: number; act: number | null; inert_first: number }[];
    for (const row of rows) {
      found.push({
        table: entry.table, column: entry.column, rowid: row.rid,
        component: row.at_start === 1 ? "whole" : "path",
        hex: row.head, truncated: row.bytes > HEX_BYTES,
        confirmed: entry.encoding !== "unknown-composite",
        inert: (entry.table === "documents" && row.act === 0)
          || INERT_COLUMNS.get(`${entry.table}.${entry.column}`) === "any"
          || (INERT_COLUMNS.get(`${entry.table}.${entry.column}`) === "path" && row.at_start !== 1),
      });
    }
  }
  return { found, skippedTables: [...skipped].sort(), limited, counts };
}

/**
 * The doctor's block: one headline, then one line per row. `ok` is false while a value that is NOT inert is listed
 * (ruling 71 A: inert values stay listed, as a record, and do not fail the check).
 */
export function describeMarkedIdentifiers(scan: MarkedIdentifierScan): { ok: boolean; lines: string[] } {
  if (scan.counts.live + scan.counts.inert === 0) {
    return { ok: true, lines: ["none starts with a byte-order mark (the listed identifier columns were read; a value inside JSON or in an unlisted column is not seen)"] };
  }
  // the verdict and the counts come from every row (Codex T1 P1); only the list below is cut
  const { live, inert } = scan.counts;
  const lines = [live > 0
    ? `${live} stored value(s) start with a byte-order mark — results may be INCOMPLETE while any is listed: ` +
      `a call that binds such a value again is refused. Nothing is repaired automatically; see "Stored identifiers that start with a byte-order mark" in docs/troubleshooting.md.` +
      (inert > 0 ? ` ${inert} more are inert (kept as a record).` : "")
    : `${inert} stored value(s) start with a byte-order mark, all inert — kept as a record; no reader binds them again. ` +
      `See "Stored identifiers that start with a byte-order mark" in docs/troubleshooting.md.`];
  for (const f of scan.found) {
    lines.push(`${f.table} rowid ${f.rowid} column ${f.column}${f.component === "path" ? " (the path after the first slash)" : ""}: ` +
      `hex ${f.hex}${f.truncated ? "…" : ""}${f.inert ? "  [inert — kept as a record]" : ""}` +
      `${f.confirmed ? "" : "  [UNCONFIRMED — the encoding of this column is not known to the list; check before any cleanup]"}`);
  }
  if (scan.limited) lines.push("more rows exist than are listed here (the list is cut per column; the counts above cover every row, and actionable rows are listed first)");
  return { ok: live === 0, lines };
}
