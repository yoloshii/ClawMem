/**
 * BACKLOG 82.2, D5 — the health of STORED vectors: the doctor's scan, and the engine of `clawmem repair vectors`.
 *
 * A stored vector is HEALTHY when the strict reader accepts its blob (finite elements, the norm interval) AND the
 * native self-distance `vec_distance_cosine(embedding, embedding)` is usable and at most 1e-4 from zero. The first
 * half is what catches a pair of infinities and a subnormal vector, whose self-distance can read 0.
 *
 * `vectors_vec` has no rowid and paging it by `hash_seq` reads the whole table for each page. So the cursor is the
 * ORDINARY table: keys come from `content_vectors` by keyset on its primary key, and each key is examined by a
 * POINT lookup in `vectors_vec`.
 *
 * An error of the extension or the schema while examining is THROWN. It is never a finding and never a reason to
 * delete.
 */
import type { Database } from "bun:sqlite";
import { assertLeaseHeld, getVecTableDim, type LeaseGuard, type Store } from "./store.ts";
import { storedVector, usableSelfDistance, VecPoisonError } from "./vector-guard.ts";
import { validSimilarityWeight } from "./relation-weight.ts";

export type VectorFaultKind = "non-finite" | "unsupported-norm" | "native-uncomputable" | "malformed-blob";
export type VectorHealth = { state: "healthy" } | { state: "bad"; kind: VectorFaultKind } | { state: "absent" };
export interface VectorFinding { hashSeq: string; kind: VectorFaultKind; orphan: boolean }

/** A page of keys: keyset on the primary key of `content_vectors` — no OFFSET, so rows deleted behind the cursor move nothing. */
export const VECTOR_KEY_PAGE_SQL = `SELECT hash, seq FROM content_vectors WHERE (hash, seq) > (?, ?) ORDER BY hash, seq LIMIT ?`;
/** One stored vector and its native self-distance, by its key. */
export const VECTOR_POINT_SQL = `SELECT embedding, vec_distance_cosine(embedding, embedding) AS self FROM vectors_vec WHERE hash_seq = ?`;

export const DOCTOR_VECTOR_SAMPLE = 2000;
const PAGE = 1000;
const LIST_CAP = 50;

const noKinds = (): Record<VectorFaultKind, number> =>
  ({ "non-finite": 0, "unsupported-norm": 0, "native-uncomputable": 0, "malformed-blob": 0 });

/** The kind of fault of one stored vector, or null when it is healthy. `self` is its native self-distance. */
export function classifyStoredVector(blob: unknown, self: unknown, dimensions: number | undefined): VectorFaultKind | null {
  try {
    storedVector(blob, dimensions, { context: "stored vector health" });
  } catch (e) {
    if (!(e instanceof VecPoisonError)) throw e;
    if (e.reason === "non-finite") return "non-finite";
    if (e.reason === "norm") return "unsupported-norm";
    return "malformed-blob";
  }
  return usableSelfDistance(self) ? null : "native-uncomputable";
}

export function examineStoredVector(db: Database, hashSeq: string, dimensions: number | undefined): VectorHealth {
  const row = db.prepare(VECTOR_POINT_SQL).get(hashSeq) as { embedding: unknown; self: unknown } | null;
  if (!row) return { state: "absent" };
  const kind = classifyStoredVector(row.embedding, row.self, dimensions);
  return kind === null ? { state: "healthy" } : { state: "bad", kind };
}

type Key = { hash: string; seq: number };
const keyText = (k: Key) => `${k.hash}_${k.seq}`;
function keyPage(db: Database, after: Key, limit: number): Key[] {
  return db.prepare(VECTOR_KEY_PAGE_SQL).all(after.hash, after.seq, limit) as Key[];
}
/** `hash_seq` is `hash || '_' || seq`: the hash is what stands before the LAST underscore. */
function splitKey(hashSeq: string): { hash: string; seq: number | null } {
  const at = hashSeq.lastIndexOf("_");
  if (at < 0) return { hash: hashSeq, seq: null };
  const seq = Number(hashSeq.slice(at + 1));
  return { hash: hashSeq.slice(0, at), seq: Number.isInteger(seq) ? seq : null };
}
/** The keys of `vectors_vec` that have no `content_vectors` row. ONE pass over the keys alone (no embedding column). */
function orphanKeys(db: Database): string[] {
  const has = db.prepare(`SELECT 1 FROM content_vectors WHERE hash = ? AND seq = ?`);
  const out: string[] = [];
  for (const row of db.prepare(`SELECT hash_seq FROM vectors_vec`).iterate() as Iterable<{ hash_seq: string }>) {
    const { hash, seq } = splitKey(row.hash_seq);
    if (seq === null || !has.get(hash, seq)) out.push(row.hash_seq);
  }
  return out;
}
const count = (db: Database, table: "content_vectors" | "vectors_vec") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Run `fn` inside ONE read transaction, so everything it reads belongs to one state of the database. */
function oneView<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return fn();                    // the caller's transaction is the view
  db.exec("BEGIN");
  try {
    return fn();
  } finally {
    try { db.exec("ROLLBACK"); } catch { /* the transaction is already over */ }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The doctor's scan
// ---------------------------------------------------------------------------------------------------------------

export interface VectorScanOptions {
  /** Examine every key, then find vector rows that have no metadata row. Default: a sample. */
  full?: boolean;
  /** The most keys a sampled run examines (default 2000). */
  sample?: number;
  /** Where a sampled run starts in key order (default: a random place, so runs cover different rows; it wraps). */
  start?: string;
  pageSize?: number;
  listCap?: number;
  /** A seam for tests: called after each page of keys, with the number of pages read so far. */
  betweenPages?: (page: number) => void;
}
export interface VectorScanReport {
  /** `vectors_vec` exists. */
  table: boolean;
  full: boolean;
  /** Rows of `content_vectors` (M). */
  metadataRows: number;
  /** Rows of `vectors_vec`. */
  vectorRows: number;
  /** Stored vectors looked at (N): keys with a vector row or without, and — on a full run — the orphans. */
  examined: number;
  bad: number;
  byKind: Record<VectorFaultKind, number>;
  /** Keys of `content_vectors` that have no vector row. */
  missing: number;
  /** Vector rows that have no `content_vectors` row; null on a sampled run (not looked for). */
  orphans: number | null;
  /** The bad vectors, at most `listCap` of them. */
  findings: VectorFinding[];
}

export function scanVectorHealth(db: Database, opts: VectorScanOptions = {}): VectorScanReport {
  const full = opts.full === true;
  const pageSize = Math.max(1, opts.pageSize ?? PAGE);
  const listCap = opts.listCap ?? LIST_CAP;
  const report: VectorScanReport = {
    table: false, full, metadataRows: 0, vectorRows: 0, examined: 0, bad: 0, byKind: noKinds(), missing: 0,
    orphans: full ? 0 : null, findings: [],
  };
  return oneView(db, () => {
    const dimensions = getVecTableDim(db);              // throws on a vector table of an unexpected schema
    report.metadataRows = count(db, "content_vectors");
    if (dimensions === null) return report;
    report.table = true;
    report.vectorRows = count(db, "vectors_vec");

    const look = (hashSeq: string, orphan: boolean) => {
      report.examined++;
      const health = examineStoredVector(db, hashSeq, dimensions);
      if (health.state === "absent") { report.missing++; return; }
      if (health.state === "healthy") return;
      report.bad++;
      report.byKind[health.kind]++;
      if (report.findings.length < listCap) report.findings.push({ hashSeq, kind: health.kind, orphan });
    };

    const bound = full ? Infinity : Math.max(0, opts.sample ?? DOCTOR_VECTOR_SAMPLE);
    const start = full ? "" : (opts.start ?? randomStart());
    let pages = 0;
    // A sampled run starts at `start` and, when the keys after it run out, goes on from the first key up to `start`.
    const legs: { from: Key; until: string | null }[] = start === "" ? [{ from: { hash: "", seq: -1 }, until: null }]
      : [{ from: { hash: start, seq: -1 }, until: null }, { from: { hash: "", seq: -1 }, until: start }];
    for (const leg of legs) {
      let after = leg.from;
      while (report.examined < bound) {
        const page = keyPage(db, after, Math.min(pageSize, bound - report.examined));
        if (page.length === 0) break;
        let done = false;
        for (const key of page) {
          if (leg.until !== null && key.hash >= leg.until) { done = true; break; }
          look(keyText(key), false);
        }
        after = page[page.length - 1]!;
        opts.betweenPages?.(++pages);
        if (done || page.length < Math.min(pageSize, bound)) break;
      }
    }
    if (full) {
      const orphans = orphanKeys(db);
      report.orphans = orphans.length;
      for (const hashSeq of orphans) look(hashSeq, true);
    }
    return report;
  });
}

function randomStart(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

const kindsText = (byKind: Record<VectorFaultKind, number>) =>
  (Object.entries(byKind) as [VectorFaultKind, number][]).filter(([, n]) => n > 0).map(([kind, n]) => `${kind} ${n}`).join(", ");

/** What the doctor prints for a scan: the first line is the count — "among N examined of M", never the whole vault. */
export function describeVectorScan(report: VectorScanReport): { ok: boolean; lines: string[] } {
  if (!report.table) return { ok: true, lines: ["no vector table: nothing to examine"] };
  const lines = [`${report.bad} bad among ${report.examined} examined of ${report.metadataRows}`
    + (report.bad > 0 ? ` — ${kindsText(report.byKind)}` : "")];
  for (const f of report.findings) lines.push(`${f.hashSeq}  ${f.kind}${f.orphan ? "  (no metadata row)" : ""}`);
  if (report.bad > report.findings.length) lines.push(`… and ${report.bad - report.findings.length} more`);
  if (report.orphans !== null && report.orphans > 0) lines.push(`${report.orphans} orphan vector row(s): a vector with no metadata row`);
  if (report.metadataRows !== report.vectorRows) lines.push(`the row counts differ: ${report.metadataRows} metadata rows, ${report.vectorRows} vector rows`);
  if (!report.full) lines.push(`a sample of at most ${DOCTOR_VECTOR_SAMPLE} keys: 'clawmem doctor --full' examines every stored vector`);
  if (report.bad > 0) lines.push(`'clawmem repair vectors' lists what it would remove; '--run' removes these vectors and schedules their documents for embedding`);
  return { ok: report.bad === 0, lines };
}

/**
 * The stored canary baselines the strict reader refuses (a probe that is not a usable vector, a margin that is not a
 * finite number). An embed run stops at such a baseline; the doctor reports it instead of failing on it.
 */
export function damagedCanaryBaselines(store: Pick<Store, "db" | "getCanaryBaseline">): { profileKey: string; reason: string }[] {
  const out: { profileKey: string; reason: string }[] = [];
  let keys: { profile_key: string }[];
  try {
    keys = store.db.prepare(`SELECT DISTINCT profile_key FROM embed_canary ORDER BY profile_key`).all() as { profile_key: string }[];
  } catch {
    return out;                                         // a vault from before the canary: no baseline to damage
  }
  for (const { profile_key } of keys) {
    try {
      store.getCanaryBaseline(profile_key);
    } catch (e) {
      if (!(e instanceof VecPoisonError)) throw e;
      out.push({ profileKey: profile_key, reason: e.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// repair vectors
// ---------------------------------------------------------------------------------------------------------------

export type RepairPhase = "vectors" | "relations";
export interface VectorRepairOptions {
  /** false: describe every change and make none. true: make them — a lease guard is then required. */
  run: boolean;
  /** The most vector rows a run DELETES (not rows scanned, not rows shown). */
  limit?: number;
  /** The embedding lease this run holds; asserted inside every page's transaction. */
  leaseGuard?: LeaseGuard;
  /** Called before each page to keep the lease alive; false means the lease is lost. */
  renew?: () => boolean;
  pageSize?: number;
  listCap?: number;
  /** Seams for tests. `beforeWrite`: before a page's transaction. `afterDelete`: inside it, after each delete. */
  hooks?: { beforeWrite?: (phase: RepairPhase, page: number) => void; afterDelete?: (phase: RepairPhase, key: string) => void };
}
export interface VectorRepairReport {
  run: boolean;
  vectors: {
    status: "nothing" | "pending" | "completed" | "stopped-by-limit" | "failed";
    /** Stored vectors found not usable. */
    bad: number;
    byKind: Record<VectorFaultKind, number>;
    list: VectorFinding[];
    deleted: number;
    /** Candidates that were healthy when examined again under the write lock (an embed replaced them). */
    kept: number;
    /** Active document rows set to be embedded again (dry run: that would be). */
    documentsReset: number;
    error?: string;
  };
  relations: {
    status: "nothing" | "pending" | "completed" | "not-run" | "failed";
    /** Similarity relations of the link builder whose weight is no cosine similarity. */
    invalid: number;
    list: { sourceId: number; targetId: number; weight: string }[];
    deleted: number;
    /** Negative weights inside the range: kept. */
    negativeKept: number;
    /** Relations of type `semantic` that the link builder did not write and whose weight is outside the range: kept. */
    otherOriginOutOfRange: number;
    /** Valid similarity relations of the documents repaired in this run: they cannot be told from any other, and stay. */
    unresolved: number;
    unresolvedByDocument: { id: number; relations: number }[];
    error?: string;
  };
  exit: 0 | 1;
}

class LeaseLost extends Error {}

export function repairVectors(db: Database, opts: VectorRepairOptions): VectorRepairReport {
  if (opts.run && !opts.leaseGuard) throw new Error("repair vectors: a run needs the embedding lease");
  const pageSize = Math.max(1, opts.pageSize ?? PAGE);
  const listCap = opts.listCap ?? LIST_CAP;
  const report: VectorRepairReport = {
    run: opts.run,
    vectors: { status: "nothing", bad: 0, byKind: noKinds(), list: [], deleted: 0, kept: 0, documentsReset: 0 },
    relations: { status: "nothing", invalid: 0, list: [], deleted: 0, negativeKept: 0, otherOriginOutOfRange: 0, unresolved: 0, unresolvedByDocument: [] },
    exit: 0,
  };
  /** Ids of the document rows repaired (dry run: that would be). */
  const repaired = new Set<number>();

  const work = () => {
    vectorPhase(db, opts, pageSize, listCap, report, repaired);
    const v = report.vectors.status;
    if (v === "stopped-by-limit" || v === "failed") { report.relations.status = "not-run"; return; }
    relationPhase(db, opts, pageSize, listCap, report, repaired);
  };
  if (opts.run) work(); else oneView(db, work);

  const done = (s: string) => s === "nothing" || s === "completed";
  report.exit = done(report.vectors.status) && done(report.relations.status) ? 0 : 1;
  return report;
}

function vectorPhase(db: Database, opts: VectorRepairOptions, pageSize: number, listCap: number, report: VectorRepairReport, repaired: Set<number>): void {
  const v = report.vectors;
  try {
    const dimensions = getVecTableDim(db);
    if (dimensions === null) return;
    const activeRows = db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1`);
    const found = (hashSeq: string, kind: VectorFaultKind, orphan: boolean) => {
      v.bad++;
      v.byKind[kind]++;
      if (v.list.length < listCap) v.list.push({ hashSeq, kind, orphan });
    };
    let page = 0;
    let stopped = false;

    /** One page of candidates. Dry run: count what a run would do. Run: one immediate transaction. */
    const handle = (candidates: { hashSeq: string; kind: VectorFaultKind; orphan: boolean }[]) => {
      if (candidates.length === 0) return;
      page++;
      if (!opts.run) {
        for (const c of candidates) {
          found(c.hashSeq, c.kind, c.orphan);
          for (const row of activeRows.all(splitKey(c.hashSeq).hash) as { id: number }[]) repaired.add(row.id);
        }
        return;
      }
      if (opts.limit !== undefined && v.deleted >= opts.limit) { stopped = true; for (const c of candidates) found(c.hashSeq, c.kind, c.orphan); return; }
      opts.hooks?.beforeWrite?.("vectors", page);
      const pageDeleted: number[] = [];
      let pageKept = 0;
      let deletedHere = 0;
      const pageFound: typeof candidates = [];
      db.transaction(() => {
        assertLeaseHeld(db, opts.leaseGuard);
        for (const c of candidates) {
          // Examined again under the write lock: a vector an embed replaced meanwhile is healthy and is kept.
          const health = examineStoredVector(db, c.hashSeq, dimensions);
          if (health.state !== "bad") { pageKept++; continue; }
          pageFound.push({ ...c, kind: health.kind });
          if (opts.limit !== undefined && v.deleted + deletedHere >= opts.limit) { stopped = true; continue; }
          const { hash, seq } = splitKey(c.hashSeq);
          db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(c.hashSeq);
          if (seq !== null) db.prepare(`DELETE FROM content_vectors WHERE hash = ? AND seq = ?`).run(hash, seq);
          const rows = db.prepare(
            `UPDATE documents SET embed_state = 'pending', embed_attempts = 0, embed_error = NULL WHERE hash = ? AND active = 1 RETURNING id`,
          ).all(hash) as { id: number }[];
          for (const row of rows) pageDeleted.push(row.id);
          deletedHere++;
          opts.hooks?.afterDelete?.("vectors", c.hashSeq);
        }
      }).immediate();
      // The page is committed: only now does it count.
      for (const c of pageFound) found(c.hashSeq, c.kind, c.orphan);
      v.deleted += deletedHere;
      v.kept += pageKept;
      for (const id of pageDeleted) repaired.add(id);
    };

    // The lease is kept alive at EVERY page of keys: a long healthy stretch must not outlast it.
    const alive = () => { if (opts.run && opts.renew && !opts.renew()) throw new LeaseLost(); };
    let after: Key = { hash: "", seq: -1 };
    while (!stopped) {
      alive();
      const keys = keyPage(db, after, pageSize);
      if (keys.length === 0) break;
      const candidates: { hashSeq: string; kind: VectorFaultKind; orphan: boolean }[] = [];
      for (const key of keys) {
        const health = examineStoredVector(db, keyText(key), dimensions);
        if (health.state === "bad") candidates.push({ hashSeq: keyText(key), kind: health.kind, orphan: false });
      }
      after = keys[keys.length - 1]!;
      handle(candidates);
      if (keys.length < pageSize) break;
    }
    if (!stopped) {
      alive();
      const orphans = orphanKeys(db);
      for (let i = 0; i < orphans.length && !stopped; i += pageSize) {
        alive();
        const candidates: { hashSeq: string; kind: VectorFaultKind; orphan: boolean }[] = [];
        for (const hashSeq of orphans.slice(i, i + pageSize)) {
          const health = examineStoredVector(db, hashSeq, dimensions);
          if (health.state === "bad") candidates.push({ hashSeq, kind: health.kind, orphan: true });
        }
        handle(candidates);
      }
    }
    v.documentsReset = repaired.size;
    if (stopped) v.status = "stopped-by-limit";
    else if (!opts.run) v.status = v.bad > 0 ? "pending" : "nothing";
    else v.status = v.bad > 0 || v.kept > 0 ? "completed" : "nothing";
  } catch (e) {
    if (!opts.run) throw e;                             // a dry run that cannot examine is an error, not a report
    v.documentsReset = repaired.size;
    v.status = "failed";
    v.error = e instanceof LeaseLost ? "lost the embedding lease" : (e as Error).message;
  }
}

type RelationRow = { rid: number; source_id: number; target_id: number; weight: unknown; metadata: string | null };

function relationPhase(db: Database, opts: VectorRepairOptions, pageSize: number, listCap: number, report: VectorRepairReport, repaired: Set<number>): void {
  const r = report.relations;
  try {
    // By rowid keyset: `memory_relations` is an ordinary rowid table (its primary key is the triple).
    const pageSql = db.prepare(
      `SELECT rowid AS rid, source_id, target_id, weight, metadata FROM memory_relations
       WHERE relation_type = 'semantic' AND rowid > ? ORDER BY rowid LIMIT ?`);
    let after = 0;
    let page = 0;
    for (;;) {
      let rows: RelationRow[] = [];
      const tally = { invalid: [] as RelationRow[], negative: 0, other: 0 };
      const read = () => {
        rows = pageSql.all(after, pageSize) as RelationRow[];
        for (const row of rows) {
          // The link builder writes no metadata. A row with metadata (the dependency bridge, a link a model judged)
          // carries a weight that is not a cosine similarity of two stored vectors: it is never a candidate.
          if (row.metadata !== null) { if (!validSimilarityWeight(row.weight)) tally.other++; continue; }
          if (!validSimilarityWeight(row.weight)) tally.invalid.push(row);
          else if (row.weight < 0) tally.negative++;
        }
      };
      let deletedHere = 0;
      if (!opts.run) read();
      else {
        if (opts.renew && !opts.renew()) throw new LeaseLost();
        page++;
        opts.hooks?.beforeWrite?.("relations", page);
        db.transaction(() => {
          assertLeaseHeld(db, opts.leaseGuard);
          read();
          for (const row of tally.invalid) {
            db.prepare(`DELETE FROM memory_relations WHERE rowid = ?`).run(row.rid);
            deletedHere++;
            opts.hooks?.afterDelete?.("relations", `${row.source_id}->${row.target_id}`);
          }
        }).immediate();
      }
      // The page is committed (or read): only now does it count.
      r.invalid += tally.invalid.length;
      r.negativeKept += tally.negative;
      r.otherOriginOutOfRange += tally.other;
      r.deleted += deletedHere;
      for (const row of tally.invalid) {
        if (r.list.length < listCap) r.list.push({ sourceId: row.source_id, targetId: row.target_id, weight: String(row.weight) });
      }
      if (rows.length < pageSize) break;
      after = rows[rows.length - 1]!.rid;
    }

    // What stays: valid similarity relations of the documents repaired. Each is counted once in the total.
    const touching = db.prepare(
      `SELECT rowid AS rid, weight FROM memory_relations
       WHERE relation_type = 'semantic' AND metadata IS NULL AND (source_id = ? OR target_id = ?)`);
    const seen = new Set<number>();
    for (const id of repaired) {
      let n = 0;
      for (const row of touching.all(id, id) as { rid: number; weight: unknown }[]) {
        if (!validSimilarityWeight(row.weight)) continue;   // a dry run has not deleted the invalid ones
        n++;
        seen.add(row.rid);
      }
      if (n > 0) r.unresolvedByDocument.push({ id, relations: n });
    }
    r.unresolvedByDocument.sort((x, y) => y.relations - x.relations || x.id - y.id);
    r.unresolvedByDocument.length = Math.min(r.unresolvedByDocument.length, listCap);
    r.unresolved = seen.size;
    if (!opts.run) r.status = r.invalid > 0 ? "pending" : "nothing";
    else r.status = r.invalid > 0 ? "completed" : "nothing";
  } catch (e) {
    if (!opts.run) throw e;
    r.status = "failed";
    r.error = e instanceof LeaseLost ? "lost the embedding lease" : (e as Error).message;
  }
}
