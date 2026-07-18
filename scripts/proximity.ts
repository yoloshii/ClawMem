/**
 * §51.6 FTS5 proximity-bucket re-rank — ❌ KILLED 2026-07-18 (pre-registered
 * experiment, verdict on the frozen rule; run transcript sha256 49cc4e69b952…
 * in .codex-review/s516-run-unblinded.txt). NEVER wired into production: three
 * gates failed independently — G1 ΔMRR eligible-combined +0.002 (needed
 * ≥ +0.05), G3 held-out REGRESSED (MRR 0.833 → 0.788, hit@1 8 → 7), G7a
 * latency p95 20.94 ms > 20 ms. Mechanism: porter+prefix AND over
 * filepath/title/body already carries the proximity signal, so bucket
 * re-ranking demotes BM25-#1 targets with scattered tokens behind
 * tighter-phrase decoys (~1:1 trade, net-negative held-out). Kept in scripts/
 * scope (excluded from the npm package) as executable negative evidence with
 * its unit matrix; consumed only by eval-keyword-acceptance.ts arm P.
 *
 * Original design (donor: Sibyl-Memory `_proximity_bucket`, sibyl-memory-client
 * client.py — bucket by match tightness, stable-sort by (bucket, prior rank)):
 *
 * Buckets, per candidate row:
 *   0 — the query's effective constraints appear as a contiguous run, in order
 *   1 — every constraint present with min-cover-span ≤ n + PROXIMITY_WINDOW_SLACK
 *   2 — constraints scattered, or at least one absent
 *
 * Reorder-never-drop: the output is a permutation of the input; scores are
 * untouched; queries with fewer than two effective constraints are a no-op.
 *
 * The donor buckets over exact-token positions on CONCATENATED record text,
 * and skips its prefix-search mode entirely. ClawMem's MATCH is `"tok"* AND …`
 * over a `porter unicode61` index (store.ts buildFTS5Query), where FTS5 stems
 * quoted prefix tokens before prefix-matching the stemmed index — so this
 * module diverges from the donor in two deliberate, first-principles ways:
 *
 *  1. Constraints are STEMS with prefix matching (docStem.startsWith(queryStem)),
 *     canonicalized to an ordered antichain: duplicate stems collapse, and a
 *     stem that prefixes a more specific query stem is dropped (its matches are
 *     a superset, so the AND is equivalent without it — e.g. `configure
 *     configurations` stems to one effective constraint and is a no-op). This
 *     keeps the re-ranker reasoning over the constraints the MATCH actually
 *     enforced, never a stricter phantom set.
 *  2. Buckets are computed PER COLUMN (filepath/title/body) and the row takes
 *     the best column's bucket. An FTS AND can match across columns; tokens
 *     split across fields with no single field holding all of them are
 *     "scattered" here, and field boundaries can never fake adjacency the way
 *     donor-style concatenation can.
 *
 * Positions come from a scratch fts5 + fts5vocab('instance') pair on a
 * dedicated in-memory connection created lazily on the first eligible call:
 * SQLite itself supplies unicode61 folding, porter stemming, and per-column
 * token offsets, so bucket semantics cannot drift from the real index's.
 * Scratch writes+reads run inside one synchronous transaction, and ANY oracle
 * failure fails open to the caller's original order — the optional re-ranker
 * must never break `search`.
 */
import { Database } from "bun:sqlite";
import { tokenizeForFTS5 } from "../src/store.ts";

/** Donor constant (`_PROXIMITY_WINDOW_SLACK`), adopted verbatim — not tunable. */
export const PROXIMITY_WINDOW_SLACK = 4;

export type ProximityRow = {
  displayPath: string;
  title?: string | null;
  body?: string | null;
};

export type Bucket = 0 | 1 | 2;
export type ProximityColumn = "filepath" | "title" | "body";
/** Per-row bucket + the column that produced it (null when nothing tighter than scattered). */
export type BucketInfo = { bucket: Bucket; col: ProximityColumn | null };

let oracle: Database | null = null;
function getOracle(): Database {
  if (!oracle) {
    oracle = new Database(":memory:");
    // Candidate rows — same columns + tokenizer as documents_fts (store.ts:546).
    oracle.exec(`CREATE VIRTUAL TABLE px USING fts5(filepath, title, body, tokenize='porter unicode61')`);
    oracle.exec(`CREATE VIRTUAL TABLE pxv USING fts5vocab(px, 'instance')`);
    // Query row lives in its own one-row table so its stem sequence is readable
    // without scanning the candidate index (fts5vocab pushes down term
    // constraints, not doc constraints).
    oracle.exec(`CREATE VIRTUAL TABLE pxq USING fts5(q, tokenize='porter unicode61')`);
    oracle.exec(`CREATE VIRTUAL TABLE pxqv USING fts5vocab(pxq, 'instance')`);
  }
  return oracle;
}

/**
 * TEST-ONLY seam: swap the module oracle (pass a broken/closed Database to
 * fault-inject, null to reset to lazy re-creation). Never call from production
 * code.
 */
export function __proximityOracleForTests(db: Database | null): void {
  oracle = db;
}

const COLS: ProximityColumn[] = ["filepath", "title", "body"];

/**
 * Ordered antichain of effective constraints: stems deduplicated, and any stem
 * that prefixes a DIFFERENT, more specific query stem removed (first-occurrence
 * order preserved). Under `"s"*` AND-semantics a prefix stem's matches are a
 * superset of its extension's, so the shorter constraint is implied.
 */
function canonicalizeStems(stems: string[]): string[] {
  const out: string[] = [];
  for (const s of stems) {
    if (out.includes(s)) continue;
    if (stems.some(t => t !== s && t.startsWith(s))) continue;
    out.push(s);
  }
  return out;
}

/**
 * Stem sequence of the raw query (query order), as the FTS5 tokenizer produces
 * it. Runs inside the caller's transaction.
 */
function queryStems(db: Database, query: string): string[] {
  db.exec(`DELETE FROM pxq`);
  db.prepare(`INSERT INTO pxq(rowid, q) VALUES (1, ?)`).run(query);
  const rows = db.prepare(`SELECT term FROM pxqv ORDER BY offset`).all() as { term: string }[];
  return rows.map(r => r.term);
}

/**
 * Per-doc, per-column, per-constraint match offsets. A doc token at offset o in
 * column c matches constraint s when its stem prefix-extends s — the same
 * predicate FTS5 applied for `"s"*` (probe-verified: quoted prefix tokens are
 * stemmed, then prefix-matched against the stemmed index).
 *
 * The upper bound `s || char(1114111)` is safe: U+10FFFF is not alphanumeric,
 * so unicode61 can never emit it inside a token, and no legal term sorts
 * between every `s`-prefixed term and that bound.
 */
function matchPositions(
  db: Database,
  stems: string[],
  docCount: number
): Map<number, Map<string, Map<string, number[]>>> {
  const scan = db.prepare(
    `SELECT doc, col, offset FROM pxv WHERE term >= ?1 AND term < ?1 || char(1114111) ORDER BY doc, offset`
  );
  const byDoc = new Map<number, Map<string, Map<string, number[]>>>();
  for (let d = 1; d <= docCount; d++) {
    const cols = new Map<string, Map<string, number[]>>();
    for (const c of COLS) cols.set(c, new Map());
    byDoc.set(d, cols);
  }
  for (const s of stems) {
    for (const r of scan.all(s) as { doc: number; col: string; offset: number }[]) {
      const col = byDoc.get(r.doc)?.get(r.col);
      if (!col) continue;
      let list = col.get(s);
      if (!list) col.set(s, (list = []));
      list.push(r.offset);
    }
  }
  return byDoc;
}

/** Smallest window (max−min+1) covering every constraint at least once (donor `_min_cover_span`). */
function minCoverSpan(lists: number[][]): number | null {
  const merged: { pos: number; stem: number }[] = [];
  lists.forEach((list, i) => list.forEach(pos => merged.push({ pos, stem: i })));
  merged.sort((a, b) => a.pos - b.pos);
  if (merged.length === 0) return null;
  const need = lists.length;
  const have = new Map<number, number>();
  let best: number | null = null;
  let left = 0;
  for (let right = 0; right < merged.length; right++) {
    have.set(merged[right]!.stem, (have.get(merged[right]!.stem) ?? 0) + 1);
    while (have.size === need) {
      const width = merged[right]!.pos - merged[left]!.pos + 1;
      if (best === null || width < best) best = width;
      const ls = merged[left]!.stem;
      const n = have.get(ls)! - 1;
      if (n === 0) have.delete(ls);
      else have.set(ls, n);
      left++;
    }
  }
  return best;
}

/** Bucket for one column given its per-constraint offsets. `stems` is the canonical antichain. */
function bucketForColumn(colPos: Map<string, number[]>, stems: string[]): Bucket {
  const lists = stems.map(s => colPos.get(s) ?? []);
  if (lists.some(l => l.length === 0)) return 2; // a required constraint is absent from this column
  // bucket 0: some start p where the i-th constraint matches at p+i, for all i.
  const sets = stems.map((_, i) => new Set(lists[i]));
  for (const p of lists[0]!) {
    let ok = true;
    for (let i = 1; i < stems.length; i++) {
      if (!sets[i]!.has(p + i)) { ok = false; break; }
    }
    if (ok) return 0;
  }
  const span = minCoverSpan(lists);
  if (span !== null && span <= stems.length + PROXIMITY_WINDOW_SLACK) return 1;
  return 2;
}

/**
 * Discriminated outcome of one re-rank attempt:
 *   "applied"        — buckets computed, rows reordered (buckets non-null, INPUT order)
 *   "inapplicable"   — the re-rank does not apply (sub-2-row input, single-token
 *                      query, or fewer than two effective constraints); rows are
 *                      an order-preserving copy
 *   "oracle-failure" — the scratch oracle threw; rows are an order-preserving
 *                      copy (production fail-open) and the oracle was dropped
 *                      for lazy re-creation. The eval harness treats this as
 *                      EVAL INVALID — a failure must never be counted as
 *                      legitimate P≡B behavior.
 */
export type ProximityOutcome<T extends ProximityRow> = {
  status: "applied" | "inapplicable" | "oracle-failure";
  rows: T[];
  buckets: BucketInfo[] | null;
};

/**
 * The single detailed core: one oracle invocation produces BOTH the buckets and
 * the reordered rows (harness and production share this — buckets are never
 * recomputed in a second oracle pass).
 *
 * Callers gate on `selectScoringRegime(query) === "raw"` — recency-composite
 * queries never reach this function.
 */
export function proximityRerankDetailed<T extends ProximityRow>(rows: T[], query: string): ProximityOutcome<T> {
  if (rows.length < 2 || tokenizeForFTS5(query).length < 2)
    return { status: "inapplicable", rows: rows.slice(), buckets: null };
  try {
    const db = getOracle();
    const compute = db.transaction(() => {
      const stems = canonicalizeStems(queryStems(db, query));
      if (stems.length < 2) return null;
      db.exec(`DELETE FROM px`);
      const ins = db.prepare(`INSERT INTO px(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`);
      rows.forEach((r, i) => ins.run(i + 1, r.displayPath, r.title ?? null, r.body ?? null));
      return { stems, positions: matchPositions(db, stems, rows.length) };
    });
    const res = compute() as { stems: string[]; positions: ReturnType<typeof matchPositions> } | null;
    if (!res) return { status: "inapplicable", rows: rows.slice(), buckets: null };
    const buckets = rows.map((_, i): BucketInfo => {
      let bucket: Bucket = 2;
      let col: ProximityColumn | null = null;
      const cols = res.positions.get(i + 1)!;
      for (const c of COLS) {
        const b = bucketForColumn(cols.get(c)!, res.stems);
        if (b < bucket) { bucket = b; col = c; }
        if (bucket === 0) break;
      }
      return { bucket, col: bucket < 2 ? col : null };
    });
    const decorated = rows.map((row, i) => ({ row, bucket: buckets[i]!.bucket, i }));
    decorated.sort((a, b) => (a.bucket - b.bucket) || (a.i - b.i));
    return { status: "applied", rows: decorated.map(d => d.row), buckets };
  } catch {
    // Fail open AND self-heal: drop the (possibly wedged) oracle so the next
    // call lazily recreates it — a transient fault must not disable the
    // re-ranker for the rest of the process.
    try { oracle?.close(); } catch {}
    oracle = null;
    return { status: "oracle-failure", rows: rows.slice(), buckets: null };
  }
}

/**
 * Per-row buckets in INPUT order, or null when buckets were not computed
 * (inapplicable or oracle failure — use `proximityRerankDetailed` when the
 * distinction matters).
 */
export function proximityBuckets(rows: ProximityRow[], query: string): BucketInfo[] | null {
  return proximityRerankDetailed(rows, query).buckets;
}

/**
 * Stable proximity re-rank: sort a raw-ranked candidate list by
 * (bucket asc, prior rank asc). Returns a NEW array; never adds, drops, or
 * rescores a row. No-op (order-preserving copy) when inapplicable or on oracle
 * failure (production fail-open — see `proximityRerankDetailed`).
 */
export function proximityRerank<T extends ProximityRow>(rows: T[], query: string): T[] {
  return proximityRerankDetailed(rows, query).rows;
}
