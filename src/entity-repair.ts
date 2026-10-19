/**
 * 76.3: `clawmem repair entities` — repair the entity links written before the 76.1 resolver fix.
 *
 * Before v0.43.2 the resolver joined names whose numbers differ ("Node 200" into "Node 202") and, when its FTS
 * candidate pool missed the exactly-named entity, could link a name to a fuzzy neighbour. New links are right; the old
 * ones stay wrong until repaired. The repair moves a link only when its stored text proves it breaks the fixed rule:
 *  - R1: the surface's digit runs differ from the linked entity's name's;
 *  - R2: the surface names another entity in the linked entity's bucket and vault exactly.
 * Same-name duplicates (R3) and type drift (R4) are counted and left alone.
 *
 * Links: triple endpoints (one item per evidence row: `source_fact` = `subject predicate object`) and entity mentions
 * with text. Each item is resolved by the real `resolveEntityCanonical` on an in-memory copy of `entity_nodes` +
 * `entities_fts` (the vault's DDL, rows and rowids), in sighting order, and an unknown surface is minted into the copy
 * with the one mint operation apply also uses. A run that raises a hold is discarded and run again with the hold's
 * owner held; holds only grow. Triples are then regrouped by final key and allocated one-to-one; mentions collapse per
 * document; counts change by delta. The `entity` edges the repaired mentions justify are added (a pair rule over both
 * documents' original and final entity sets); stale ones are reported, never deleted. The plan's digest covers the
 * repair's own decisions and the added edges' ends, never a weight or a report.
 *
 * Dry run: a readonly handle, one read transaction, nothing written. Apply: one `BEGIN IMMEDIATE` transaction that
 * re-plans under the lock, checks `--expect`, re-checks every answer on the vault, then writes every change with an
 * `entity_repair_log` row. `--restore <op>` reverses whole restore components, validating each first. Nothing here
 * initializes a store.
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { isoNow } from "./clock.ts";
import {
  resolveEntityCanonical,
  resolveEntityTypeExact,
  makeEntityId,
  getEntityBucket,
  exactNameRows,
  sameDigitRuns,
  similarityRatio,
  computeEntityEdges,
  writeEntityEdge,
  ENTITY_IDF_SPECIFICITY_THRESHOLD,
} from "./entity.ts";
import { notLegacyArtifactSql } from "./compaction-state.ts";

// =============================================================================
// Types
// =============================================================================

/** A refusal: nothing was written, and the message says why. */
export class EntityRepairRefusal extends Error {}

export type HoldReason =
  | "predicate-twice"
  | "cross-bucket"
  | "no-node"
  | "resolver-still-linked"
  | "alias-only"
  | "slug-collision"
  | "fts-row-mismatch"
  | "key-of-held-triple"
  | "open-key-taken";

/** One link the repair may move: a triple endpoint read from one evidence row, or one mention row. */
export interface RepairItem {
  key: string; // `${evidenceId}:s` | `${evidenceId}:o` | `M${docId}:${entityId}`
  owner: string; // `T${tripleId}` | `M${docId}:${entityId}` — a hold applies to the whole owner
  linked: string;
  type: string; // the linked entity's type: resolution runs with it
  vault: string; // the linked entity's vault column
  surface: string;
  cls: "R1" | "R2";
  at: number; // sighting instant, UTC ms; missing or unparseable → Infinity
  kind: 0 | 1; // 0 evidence, 1 mention: evidence first
  rid: number; // evidence id / mention rowid
  side: 0 | 1; // 0 subject, 1 object: subject first
}

export interface RepairAnswer {
  item: RepairItem;
  to: string;
  minted: boolean; // this answer mints `to`
  fuzzy: boolean; // accepted through the resolver's fuzzy rule, not an exact name
}

export interface RepairMint {
  id: string;
  name: string;
  type: string;
  vault: string;
}

export type TripleKey = [string, string, string | null, string | null, string | null, string | null];

export interface TripleGroup {
  key: TripleKey; // (subject, predicate, object id, object literal, valid_from, valid_to)
  members: number[]; // original triples whose evidence lands here
  action: "keep" | "repoint" | "merge" | "new";
  survivor: number | null; // the triple that carries the group (null: a new triple)
  evidence: { id: number; from: number; keep: boolean; at: string }[]; // keep = false: collapsed into an equal earlier row
  inline: { doc: number | null; fact: string | null; at: string }; // the earliest kept evidence row's
  confidence: number | null;
  origins: { id: number; subject: string; object: string | null }[]; // members' (and a carrier's) endpoints before the repair
  comp: string;
}

export interface MentionRowSnap {
  rid: number;
  entity: string;
  doc: number;
  text: string | null;
  at: string | null;
}

export interface MentionDocPlan {
  doc: number;
  before: string[]; // entities, in rowid order
  after: string[]; // entities, in the order of each winner's original rowid
  deletes: MentionRowSnap[]; // every row that moves
  inserts: { entity: string; text: string | null; at: string | null; fromRid: number }[]; // winners that move
  moves: { rid: number; from: string; to: string; toMint: boolean; fuzzy: boolean }[];
  mayAlsoMention: string[]; // old entities whose name the document's body still contains (report only)
}

export interface StaleEdge {
  source: number;
  target: number;
  entity: string;
  stillShared: string[];
}

/** An `entity` edge the repair adds: enrichment's edge for a repaired document, kept by the pair rule. */
export interface PlannedEdge {
  source: number;
  target: number;
  entity: string; // the recorded entity (`bestEntity`): always one the pair newly shares
  weight: number;
  shared: number;
}

export interface EntityRepairPlan {
  digest: string;
  runs: number;
  items: RepairItem[];
  holds: [string, HoldReason][];
  answers: RepairAnswer[];
  mints: RepairMint[];
  groups: TripleGroup[];
  deletedTriples: { id: number; comp: string }[];
  mentionDocs: MentionDocPlan[];
  edges: PlannedEdge[];
  staleEdges: StaleEdge[];
  counts: {
    r1: number; // R1 links acted on (an accepted answer)
    r2: number;
    held: number; // triples and mentions held, every reason (the holds list); their links are not in r1/r2
    r3: number | null; // null: not computed (apply skips the reports)
    r4: number | null;
    unparseable: number;
    triplesTouched: number;
  };
}

// =============================================================================
// Shared pieces: sighting order, statistics, prerequisites, the copy, the mint operation
// =============================================================================

const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A stored time as a UTC instant. SQLite's `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` (UTC) and `isoNow()` writes
 * `…T…Z`; compared as strings they misorder, so both parse to milliseconds. Missing or unparseable → Infinity: such a
 * row sorts after every timed one.
 */
export function sightingInstant(at: string | null | undefined): number {
  if (!at) return Infinity;
  const iso = SQLITE_UTC.test(at) ? `${at.replace(" ", "T")}Z` : at;
  const ms = ISO_ZONED.test(iso) ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : Infinity;
}

const cmpNum = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const norm = (s: string) => s.trim().toLowerCase();

/** Rows in sqlite_stat1/3/4 for entity_nodes: the resolver's unordered queries could then plan differently on the copy. */
export function plannerStatisticsRows(db: Database): number {
  let n = 0;
  for (const r of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sqlite_stat%'`).all() as { name: string }[]) {
    n += (db.prepare(`SELECT COUNT(*) AS n FROM "${r.name}" WHERE tbl = 'entity_nodes'`).get() as { n: number }).n;
  }
  return n;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  entity_nodes: ["entity_id", "entity_type", "name", "created_at", "mention_count", "last_seen", "canonical_id", "vault"],
  entities_fts: ["entity_id", "name", "entity_type"],
  entity_mentions: ["entity_id", "doc_id", "mention_text", "created_at"],
  entity_cooccurrences: ["entity_a", "entity_b", "count", "last_cooccurred"],
  entity_triples: ["id", "subject_entity_id", "predicate", "object_entity_id", "object_literal", "valid_from", "valid_to", "confidence", "source_doc_id", "source_fact", "created_at"],
  entity_triple_provenance: ["id", "triple_id", "source_doc_id", "source_fact", "created_at"],
  memory_relations: ["source_id", "target_id", "relation_type", "weight", "metadata", "created_at"],
  documents: ["id", "active", "path", "hash"],
  content: ["hash", "doc"],
};

/** Why this vault cannot be repaired yet (an upgrade step it has not run), or null. Reads only. */
export function missingPrerequisite(db: Database): string | null {
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = new Set((db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(c => c.name));
    if (have.size === 0) return `table ${table} is missing`;
    const lacking = cols.filter(c => !have.has(c));
    if (lacking.length > 0) return `${table} lacks ${lacking.join(", ")}`;
  }
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ux_etp_evidence'`).get()) return "index ux_etp_evidence is missing";
  const bare = db.prepare(`
    SELECT 1 FROM entity_triples t
    WHERE NOT EXISTS (SELECT 1 FROM entity_triple_provenance p WHERE p.triple_id = t.id)
    LIMIT 1
  `).get();
  if (bare) return "a triple has no evidence row (the evidence backfill has not run)";
  return null;
}

/** The table's columns, and whether its rowid must be copied explicitly (it is not an INTEGER PRIMARY KEY alias). */
function tableShape(db: Database, table: string): { cols: string[]; explicitRowid: boolean } {
  const info = db.prepare(`SELECT name, type, pk FROM pragma_table_info(?)`).all(table) as { name: string; type: string; pk: number }[];
  const pks = info.filter(c => c.pk > 0);
  const aliased = pks.length === 1 && pks[0]!.type.toUpperCase() === "INTEGER";
  return { cols: info.map(c => c.name), explicitRowid: !aliased };
}

/**
 * An in-memory database holding `tables` as the vault has them: the same DDL (`sqlite_master`), the same indexes, every
 * row with its rowid. `where` narrows a table's rows (a SQL condition on the vault's table).
 */
export function copyTables(src: Database, tables: string[], where: Record<string, string> = {}): Database {
  const dst = new Database(":memory:");
  for (const table of tables) {
    const ddl = src.prepare(`SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'`).get(table) as { sql: string } | null;
    if (!ddl) throw new EntityRepairRefusal(`table ${table} is missing`);
    dst.exec(ddl.sql);
    for (const ix of src.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(table) as { sql: string }[]) {
      dst.exec(ix.sql);
    }
  }
  dst.exec("BEGIN");
  for (const table of tables) {
    const { cols, explicitRowid } = tableShape(src, table);
    const names = explicitRowid ? ["rowid", ...cols] : cols;
    const ins = dst.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
    const filter = where[table] ? ` WHERE ${where[table]}` : "";
    for (const row of src.prepare(`SELECT ${names.join(", ")} FROM ${table}${filter}`).values()) ins.run(...(row as any[]));
  }
  dst.exec("COMMIT");
  return dst;
}

/** entity id → its entities_fts rows (an id can have none, one, or the duplicates 76.6 describes). */
export type FtsBook = Map<string, { name: string; type: string }[]>;

export function readFtsBook(db: Database): FtsBook {
  const book: FtsBook = new Map();
  for (const r of db.prepare(`SELECT entity_id, name, entity_type FROM entities_fts`).all() as { entity_id: string; name: string; entity_type: string }[]) {
    const rows = book.get(r.entity_id);
    if (rows) rows.push({ name: r.name, type: r.entity_type });
    else book.set(r.entity_id, [{ name: r.name, type: r.entity_type }]);
  }
  return book;
}

const cloneBook = (book: FtsBook): FtsBook => new Map([...book].map(([k, v]) => [k, v.map(r => ({ ...r }))]));

/**
 * The ONE mint operation, for the resolution copy and for apply: the entity_nodes row as `ensureEntityCanonical` writes
 * it (mention_count 0), and an entities_fts row with the lowercased name only when the id has none — an existing row
 * with the same name and type is reused, never duplicated (76.6). An id whose existing FTS row holds another name or
 * type is refused: the resolver's join would read that row as this entity.
 */
export function mintEntity(db: Database, fts: FtsBook, m: RepairMint): { ftsRowid: number | null } | "fts-row-mismatch" {
  const lower = m.name.toLowerCase();
  const rows = fts.get(m.id);
  if (rows && rows.some(r => r.name !== lower || r.type !== m.type)) return "fts-row-mismatch";
  db.prepare(`
    INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
    VALUES (?, ?, ?, NULL, datetime('now'), 0, datetime('now'), ?)
  `).run(m.id, m.type, m.name, m.vault);
  if (rows) return { ftsRowid: null };
  const r = db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`).run(m.id, lower, m.type);
  fts.set(m.id, [{ name: lower, type: m.type }]);
  return { ftsRowid: Number(r.lastInsertRowid) };
}

/**
 * The resolver's fuzzy rule, applied to the entity's own name exactly as the resolver applies it to a candidate's:
 * the surface lowercased and trimmed, the name lowercased and never trimmed; same digit runs, similarity at the
 * bucket's bar.
 */
function passesFuzzyRule(surface: string, name: string, type: string): boolean {
  const a = surface.toLowerCase().trim();
  const b = name.toLowerCase();
  return sameDigitRuns(a, b) && similarityRatio(a, b) >= (getEntityBucket(type) === "person" ? 0.65 : 0.75);
}

/** A document's mention rows as a restore witness: every row's entity, text and time, in entity order (no rowids). */
function mentionSet(db: Database, doc: number): unknown[] {
  return db.prepare(`SELECT entity_id, mention_text, created_at FROM entity_mentions WHERE doc_id = ? ORDER BY entity_id`).all(doc);
}

function pairsOf(set: Iterable<string>): Set<string> {
  const ids = [...new Set(set)].sort();
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.add(`${ids[i]}\u0000${ids[j]}`);
  return out;
}

/**
 * The ONE mention write operation (apply and the edge-preview copy): delete every row that moves, then insert each
 * moving winner at its destination with its text and time and a fresh rowid. No statement meets the key of a row still
 * waiting to move. `onWrite` sees each deleted row, then each inserted one.
 */
function writeMentionMoves(
  db: Database,
  p: MentionDocPlan,
  onWrite?: (deleted: MentionRowSnap | null, inserted: MentionDocPlan["inserts"][number] | null) => void,
): void {
  for (const r of p.deletes) {
    const res = db.prepare(`DELETE FROM entity_mentions WHERE rowid = ? AND entity_id = ? AND doc_id = ?`).run(r.rid, r.entity, r.doc);
    if (res.changes !== 1) throw new EntityRepairRefusal(`mention row ${r.rid} changed under the plan — nothing written`);
    onWrite?.(r, null);
  }
  for (const x of p.inserts) {
    db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, ?, ?)`).run(x.entity, p.doc, x.text, x.at);
    onWrite?.(null, x);
  }
}

/**
 * The `entity` edges the repair adds, computed on `work` after the mention writes (the vault under apply's lock, or the
 * dry run's copy). Sources: each repaired document that is active and not the legacy artifact, in descending id
 * order (a fixed priority). For each, enrichment's own edges for its final entity list (in each winner's original
 * rowid order); an edge is kept when the entities the pair newly shares — not mentioned by BOTH documents before the
 * repair — reach the specificity threshold on their own and the ones they shared before do not, and no `entity` row
 * joins the pair in either direction (existing rows read from `existing`, or one added earlier here). The shared
 * entities are candidate-limited as enrichment's are: an entity whose LIMIT 20 candidates miss the target neither
 * qualifies nor disqualifies the edge.
 */
function edgeAdditions(work: Database, existing: Database, mentionDocs: MentionDocPlan[]): PlannedEdge[] {
  const before = new Map(mentionDocs.map(p => [p.doc, new Set(p.before)]));
  const entitiesNow = work.prepare(`SELECT entity_id AS e FROM entity_mentions WHERE doc_id = ?`);
  const originalSet = (doc: number) => before.get(doc) ?? new Set((entitiesNow.all(doc) as { e: string }[]).map(r => r.e));
  const isSource = work.prepare(`SELECT 1 FROM documents d WHERE d.id = ? AND d.active = 1 AND ${notLegacyArtifactSql("d")}`);
  const joinedBefore = existing.prepare(`
    SELECT 1 FROM memory_relations WHERE relation_type = 'entity' AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)) LIMIT 1
  `);
  const added: PlannedEdge[] = [];
  const addedPairs = new Set<string>();
  const maxIdf = (ids: string[], idf: Map<string, number>) => Math.max(-Infinity, ...ids.map(e => idf.get(e) || 0));
  for (const p of [...mentionDocs].sort((a, b) => b.doc - a.doc)) {
    if (!isSource.get(p.doc)) continue;
    const mine = before.get(p.doc)!;
    for (const edge of computeEntityEdges(work, p.doc, p.after)) {
      const theirs = originalSet(edge.targetDocId);
      const previously = edge.sharedEntities.filter(e => mine.has(e) && theirs.has(e));
      const newly = edge.sharedEntities.filter(e => !(mine.has(e) && theirs.has(e)));
      if (maxIdf(newly, edge.idf) < ENTITY_IDF_SPECIFICITY_THRESHOLD) continue;
      if (maxIdf(previously, edge.idf) >= ENTITY_IDF_SPECIFICITY_THRESHOLD) continue;
      const pair = p.doc < edge.targetDocId ? `${p.doc}|${edge.targetDocId}` : `${edge.targetDocId}|${p.doc}`;
      if (addedPairs.has(pair) || joinedBefore.get(p.doc, edge.targetDocId, edge.targetDocId, p.doc)) continue;
      addedPairs.add(pair);
      added.push({ source: p.doc, target: edge.targetDocId, entity: edge.bestEntity, weight: edge.weight, shared: edge.sharedEntities.length });
    }
  }
  return added;
}

const ARTIFACT_PATH = `(path = 'precompact-state.md' OR substr(path, -20) = '/precompact-state.md')`;

/** The edge preview: an in-memory copy of documents + mentions (+ the artifact paths' content) with the planned moves. */
function previewEdgeAdditions(db: Database, mentionDocs: MentionDocPlan[]): PlannedEdge[] {
  if (mentionDocs.length === 0) return [];
  const copy = copyTables(db, ["documents", "entity_mentions", "content"], {
    content: `hash IN (SELECT hash FROM documents WHERE ${ARTIFACT_PATH})`,
  });
  try {
    copy.exec("BEGIN");
    for (const p of mentionDocs) writeMentionMoves(copy, p);
    const edges = edgeAdditions(copy, db, mentionDocs);
    copy.exec("ROLLBACK");
    return edges;
  } finally {
    copy.close();
  }
}

// =============================================================================
// Planner
// =============================================================================

interface NodeSnap {
  name: string;
  type: string | null;
  vault: string;
}
interface TripleSnap {
  id: number;
  subject: string;
  predicate: string;
  object: string | null;
  literal: string | null;
  validFrom: string | null;
  validTo: string | null;
  confidence: number | null;
}
interface EvidenceSnap {
  id: number;
  triple: number;
  doc: number | null;
  fact: string | null;
  at: string;
}

/**
 * The plan for one vault, read inside the caller's transaction (the dry run's read snapshot, or apply's write lock).
 * Throws EntityRepairRefusal when the vault cannot be planned faithfully. `reports` adds the R3/R4 counts, which cost
 * one resolution per unrepaired link and are left out of apply.
 */
export function planEntityRepair(
  db: Database,
  opts: { reports?: boolean; testHooks?: { onCopy?: (copy: Database) => void } } = {},
): EntityRepairPlan {
  const missing = missingPrerequisite(db);
  if (missing) throw new EntityRepairRefusal(`${missing} — open this vault with ClawMem once to finish its upgrade, then run the dry run again`);
  const stats = plannerStatisticsRows(db);
  if (stats > 0) {
    throw new EntityRepairRefusal(
      `the vault holds ${stats} planner-statistics row(s) for entity_nodes (sqlite_stat1/3/4, written by ANALYZE); ` +
      `the repair plans on a copy without them and cannot vouch for the vault's answers — drop those rows first`,
    );
  }

  const nodes = new Map<string, NodeSnap>();
  for (const r of db.prepare(`SELECT entity_id, name, entity_type, vault FROM entity_nodes`).all() as { entity_id: string; name: string | null; entity_type: string | null; vault: string | null }[]) {
    nodes.set(r.entity_id, { name: r.name ?? "", type: r.entity_type, vault: r.vault ?? "default" });
  }
  const triples = new Map<number, TripleSnap>();
  for (const r of db.prepare(`
    SELECT id, subject_entity_id AS subject, predicate, object_entity_id AS object, object_literal AS literal,
           valid_from AS validFrom, valid_to AS validTo, confidence
    FROM entity_triples
  `).all() as TripleSnap[]) triples.set(r.id, r);
  const evidence = db.prepare(`
    SELECT id, triple_id AS triple, source_doc_id AS doc, source_fact AS fact, created_at AS at
    FROM entity_triple_provenance ORDER BY id
  `).all() as EvidenceSnap[];
  const evidenceById = new Map(evidence.map(e => [e.id, e]));
  const evidenceByTriple = new Map<number, EvidenceSnap[]>();
  for (const e of evidence) {
    const list = evidenceByTriple.get(e.triple);
    if (list) list.push(e);
    else evidenceByTriple.set(e.triple, [e]);
  }
  const mentions = db.prepare(`
    SELECT rowid AS rid, entity_id AS entity, doc_id AS doc, mention_text AS text, created_at AS at
    FROM entity_mentions ORDER BY rowid
  `).all() as MentionRowSnap[];

  // ---- items: classify on the snapshot ---------------------------------------------------------------------------
  type Classified = { cls: "R1" | "R2"; node: NodeSnap & { type: string } } | "same" | HoldReason;
  const classify = (surface: string, linked: string): Classified => {
    const node = nodes.get(linked);
    if (!node || !node.type) return "no-node";
    if (norm(surface) === norm(node.name)) return "same";
    const bucket = getEntityBucket(node.type);
    const r1 = !sameDigitRuns(norm(surface), norm(node.name));
    const r2 = !r1 && exactNameRows(db, surface, node.vault).some(r => r.entity_id !== linked && getEntityBucket(r.entity_type) === bucket);
    if (!r1 && !r2) return "same";
    const inferred = resolveEntityTypeExact(db, surface, node.vault);
    if (inferred && getEntityBucket(inferred) !== bucket) return "cross-bucket";
    return { cls: r1 ? "R1" : "R2", node: { ...node, type: node.type } };
  };

  const upfront = new Map<string, HoldReason>();
  const hold = (map: Map<string, HoldReason>, owner: string, why: HoldReason) => {
    if (!map.has(owner)) map.set(owner, why);
  };
  const items: RepairItem[] = [];
  const unrepaired: { surface: string; linked: string; tripleTyped: boolean }[] = [];
  const touched = new Set<number>();
  let unparseable = 0;
  for (const e of evidence) {
    const t = triples.get(e.triple);
    if (!t || !e.fact) continue;
    const needle = ` ${t.predicate} `;
    const splits: number[] = [];
    for (let i = e.fact.indexOf(needle); i >= 0; i = e.fact.indexOf(needle, i + 1)) splits.push(i);
    if (splits.length === 0) {
      unparseable++;
      continue;
    }
    const owner = `T${t.id}`;
    const fact = e.fact;
    if (splits.length > 1) {
      const changes = splits.some(i =>
        classify(fact.slice(0, i), t.subject) !== "same" ||
        (t.object !== null && classify(fact.slice(i + needle.length), t.object) !== "same"));
      if (changes) {
        hold(upfront, owner, "predicate-twice");
        touched.add(t.id);
      }
      continue;
    }
    const at = splits[0]!;
    const sides: [0 | 1, string, string | null][] = [[0, fact.slice(0, at), t.subject], [1, fact.slice(at + needle.length), t.object]];
    for (const [side, surface, linked] of sides) {
      if (linked === null) continue; // a literal object
      const c = classify(surface, linked);
      if (c === "same") {
        unrepaired.push({ surface, linked, tripleTyped: true });
        continue;
      }
      touched.add(t.id);
      if (typeof c === "string") {
        hold(upfront, owner, c);
        continue;
      }
      items.push({
        key: `${e.id}:${side === 0 ? "s" : "o"}`, owner, linked, type: c.node.type, vault: c.node.vault, surface,
        cls: c.cls, at: sightingInstant(e.at), kind: 0, rid: e.id, side,
      });
    }
  }
  for (const m of mentions) {
    if (m.text == null) continue;
    const c = classify(m.text, m.entity);
    if (c === "same") {
      unrepaired.push({ surface: m.text, linked: m.entity, tripleTyped: false });
      continue;
    }
    const owner = `M${m.doc}:${m.entity}`;
    if (typeof c === "string") {
      hold(upfront, owner, c);
      continue;
    }
    items.push({
      key: owner, owner, linked: m.entity, type: c.node.type, vault: c.node.vault, surface: m.text,
      cls: c.cls, at: sightingInstant(m.at), kind: 1, rid: m.rid, side: 0,
    });
  }
  items.sort((a, b) => cmpNum(a.at, b.at) || a.kind - b.kind || a.rid - b.rid || a.side - b.side);
  const evidenceAt = new Map(evidence.map(e => [e.id, sightingInstant(e.at)]));
  const evCmp = (a: number, b: number) => cmpNum(evidenceAt.get(a)!, evidenceAt.get(b)!) || a - b;

  const copy = copyTables(db, ["entity_nodes", "entities_fts"]);
  try {
    opts.testHooks?.onCopy?.(copy);
    // ---- self-check: before any mint, the copy answers every item as the vault does -------------------------------
    for (const it of items) {
      if (resolveEntityCanonical(db, it.surface, it.type, it.vault) !== resolveEntityCanonical(copy, it.surface, it.type, it.vault)) {
        throw new EntityRepairRefusal(`the resolution copy answers "${it.surface}" differently from the vault — nothing planned`);
      }
    }

    // ---- sequential runs until one raises no new hold ---------------------------------------------------------------
    const ftsSnap = readFtsBook(db);
    const copyName = copy.prepare(`SELECT name FROM entity_nodes WHERE entity_id = ?`);
    const held = new Map(upfront);
    const byKeyStmt = db.prepare(`
      SELECT id FROM entity_triples
      WHERE subject_entity_id = ? AND predicate = ? AND object_entity_id IS ? AND object_literal IS ?
        AND valid_from IS ? AND valid_to IS ?
      ORDER BY id
    `);
    let runs = 0;
    let answers: RepairAnswer[] = [];
    let mints: RepairMint[] = [];
    let accepted = new Map<string, RepairAnswer>();
    let allocation: ReturnType<typeof allocate> | null = null;
    for (;;) {
      runs++;
      const fresh = new Map<string, HoldReason>();
      answers = [];
      mints = [];
      accepted = new Map();
      const fts = cloneBook(ftsSnap);
      copy.exec("SAVEPOINT run");
      try {
        for (const it of items) {
          if (held.has(it.owner) || fresh.has(it.owner)) continue;
          const to = resolveEntityCanonical(copy, it.surface, it.type, it.vault);
          if (to === it.linked) {
            hold(fresh, it.owner, "resolver-still-linked");
            continue;
          }
          if (to !== null) {
            const name = (copyName.get(to) as { name: string | null } | null)?.name ?? "";
            const exact = norm(name) === norm(it.surface);
            if (!exact && !passesFuzzyRule(it.surface, name, it.type)) {
              hold(fresh, it.owner, "alias-only");
              continue;
            }
            const a: RepairAnswer = { item: it, to, minted: false, fuzzy: !exact };
            accepted.set(it.key, a);
            answers.push(a);
            continue;
          }
          const id = makeEntityId(it.surface, it.type, it.vault);
          if (copyName.get(id)) {
            hold(fresh, it.owner, "slug-collision");
            continue;
          }
          const m: RepairMint = { id, name: it.surface, type: it.type, vault: it.vault };
          if (mintEntity(copy, fts, m) === "fts-row-mismatch") {
            hold(fresh, it.owner, "fts-row-mismatch");
            continue;
          }
          mints.push(m);
          const a: RepairAnswer = { item: it, to: id, minted: true, fuzzy: false };
          accepted.set(it.key, a);
          answers.push(a);
        }
      } finally {
        copy.exec("ROLLBACK TO run");
        copy.exec("RELEASE run");
      }
      if (fresh.size > 0) {
        for (const [owner, why] of fresh) hold(held, owner, why);
        continue;
      }
      allocation = allocate();
      if (allocation.keyHolds.length > 0) {
        for (const owner of allocation.keyHolds) hold(held, owner, "key-of-held-triple");
        continue;
      }
      const taken = openKeyHolds(allocation);
      if (taken.length > 0) {
        for (const owner of taken) hold(held, owner, "open-key-taken");
        continue;
      }
      break;
    }

    /**
     * One open triple per subject, predicate and object, as addTriple finds one. Grouping by
     * the full key keeps validity apart, so a group can land beside an open triple that differs from it only in
     * valid_from. Every open triple the plan leaves is projected by addTriple's identity — untouched and held triples
     * where they are, each group's carrier at its key (a merge carrier is untouched and counted where it is) — and a key
     * with two or more open carriers, one of them new to that key, holds every group bringing a new carrier there, all
     * its member triples whole. Pre-existing duplicates stay when nothing joins them; a destination the plan vacates
     * (a chain, a swap) takes its new carrier. The run is then discarded, as for any hold.
     */
    function openKeyHolds(alloc: ReturnType<typeof allocate>): string[] {
      const key4 = (s: string, p: string, o: string | null, l: string | null) => JSON.stringify([s, p, o, l]);
      const touched = new Set(alloc.groups.flatMap(g => g.members));
      const carriers = new Map<string, { group: TripleGroup | null; newcomer: boolean }[]>();
      const add = (k: string, c: { group: TripleGroup | null; newcomer: boolean }) => {
        const list = carriers.get(k);
        if (list) list.push(c);
        else carriers.set(k, [c]);
      };
      for (const t of triples.values()) {
        if (!touched.has(t.id) && t.validTo === null) add(key4(t.subject, t.predicate, t.object, t.literal), { group: null, newcomer: false });
      }
      for (const g of alloc.groups) {
        if (g.key[5] !== null || g.action === "merge") continue; // closed: no open key; merge: counted above
        const k = key4(g.key[0], g.key[1], g.key[2], g.key[3]);
        const s = g.survivor === null ? null : triples.get(g.survivor)!;
        add(k, { group: g, newcomer: s === null || s.validTo !== null || key4(s.subject, s.predicate, s.object, s.literal) !== k });
      }
      const owners: string[] = [];
      for (const list of carriers.values()) {
        if (list.length < 2 || !list.some(c => c.newcomer)) continue;
        for (const c of list) if (c.newcomer && c.group) for (const m of c.group.members) owners.push(`T${m}`);
      }
      return owners;
    }

    // Allocation (§ survivor allocation): reserve, then merge into an eligible carrier, then re-point or new.
    function allocate() {
      const acceptedTriples = new Set<number>();
      for (const it of items) if (it.kind === 0 && !held.has(it.owner)) acceptedTriples.add(Number(it.owner.slice(1)));
      const heldTriples = new Set([...held.keys()].filter(o => o.startsWith("T")).map(o => Number(o.slice(1))));
      type Draft = { key: TripleKey; rows: { id: number; from: number }[]; members: Set<number>; first: number };
      const drafts = new Map<string, Draft>();
      for (const e of evidence) {
        if (!acceptedTriples.has(e.triple)) continue;
        const t = triples.get(e.triple)!;
        const s = accepted.get(`${e.id}:s`)?.to ?? t.subject;
        const o = t.object === null ? null : (accepted.get(`${e.id}:o`)?.to ?? t.object);
        const key: TripleKey = [s, t.predicate, o, t.literal, t.validFrom, t.validTo];
        const k = JSON.stringify(key);
        let d = drafts.get(k);
        if (!d) {
          d = { key, rows: [], members: new Set(), first: e.id };
          drafts.set(k, d);
        }
        d.rows.push({ id: e.id, from: t.id });
        d.members.add(t.id);
        if (evCmp(e.id, d.first) < 0) d.first = e.id;
      }
      const order = [...drafts.values()].sort((a, b) => evCmp(a.first, b.first));
      const currentKey = (id: number) => {
        const t = triples.get(id)!;
        return JSON.stringify([t.subject, t.predicate, t.object, t.literal, t.validFrom, t.validTo]);
      };
      const assigned = new Set<number>();
      const decided = new Map<Draft, { action: TripleGroup["action"]; survivor: number | null }>();
      // (a) reserve: a group whose key one of its members already carries keeps that member (lowest such id)
      for (const d of order) {
        const k = JSON.stringify(d.key);
        const m = [...d.members].sort((a, b) => a - b).find(id => !assigned.has(id) && currentKey(id) === k);
        if (m !== undefined) {
          assigned.add(m);
          decided.set(d, { action: "keep", survivor: m });
        }
      }
      // (b) merge into an eligible carrier (untouched by the plan and not held); with none, a held carrier holds the group
      const keyHolds: string[] = [];
      for (const d of order) {
        if (decided.has(d)) continue;
        const carriers = (byKeyStmt.all(...d.key) as { id: number }[]).map(r => r.id);
        const target = carriers.find(id => !acceptedTriples.has(id) && !heldTriples.has(id));
        if (target !== undefined) {
          decided.set(d, { action: "merge", survivor: target });
          continue;
        }
        if (carriers.some(id => heldTriples.has(id))) for (const m of d.members) keyHolds.push(`T${m}`);
      }
      if (keyHolds.length > 0) return { groups: [] as TripleGroup[], deleted: [] as { id: number; comp: string }[], keyHolds };
      // (c) re-point the unassigned member holding the group's earliest evidence; none left → a new triple
      for (const d of order) {
        if (decided.has(d)) continue;
        const m = [...d.rows].sort((a, b) => evCmp(a.id, b.id)).map(r => r.from).find(id => !assigned.has(id));
        if (m !== undefined) {
          assigned.add(m);
          decided.set(d, { action: "repoint", survivor: m });
        } else {
          decided.set(d, { action: "new", survivor: null });
        }
      }
      // restore components: one allocation's triples, joined through every group they share
      const parent = new Map<number, number>();
      const find = (x: number): number => {
        let r = x;
        while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
        parent.set(x, r);
        return r;
      };
      const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
      };
      for (const d of order) {
        const ids = [...d.members];
        const survivor = decided.get(d)!.survivor;
        if (survivor !== null) ids.push(survivor);
        for (const id of ids) find(id);
        for (const id of ids.slice(1)) union(ids[0]!, id);
      }
      const compOf = (id: number) => `T${find(id)}`;
      const groups: TripleGroup[] = order.map(d => {
        const { action, survivor } = decided.get(d)!;
        const rows = [...d.rows];
        if (action === "merge") for (const e of evidenceByTriple.get(survivor!) ?? []) rows.push({ id: e.id, from: survivor! });
        // evidence collapse: rows with the same (source_doc_id, source_fact), null-normalized as ux_etp_evidence, keep the earliest
        const firstOf = new Map<string, number>();
        for (const r of [...rows].sort((a, b) => evCmp(a.id, b.id))) {
          const e = evidenceById.get(r.id)!;
          const k = `${e.doc ?? -1}\u0000${e.fact ?? ""}`;
          if (!firstOf.has(k)) firstOf.set(k, r.id);
        }
        const kept = new Set(firstOf.values());
        const earliest = evidenceById.get([...kept].sort(evCmp)[0]!)!;
        const contributors = new Set([...d.members, ...(survivor !== null ? [survivor] : [])]);
        const confs = [...contributors].map(id => triples.get(id)!.confidence).filter((c): c is number => c !== null);
        return {
          key: d.key,
          members: [...d.members].sort((a, b) => a - b),
          action,
          survivor,
          evidence: rows.sort((a, b) => a.id - b.id).map(r => ({ id: r.id, from: r.from, keep: kept.has(r.id), at: evidenceById.get(r.id)!.at })),
          inline: { doc: earliest.doc, fact: earliest.fact, at: earliest.at },
          confidence: confs.length > 0 ? Math.max(...confs) : null,
          origins: [...contributors].sort((a, b) => a - b).map(id => {
            const t = triples.get(id)!;
            return { id, subject: t.subject, object: t.object };
          }),
          comp: compOf(d.members.values().next().value!),
        };
      });
      const survivors = new Set(groups.map(g => g.survivor).filter((s): s is number => s !== null));
      const deleted = [...acceptedTriples].filter(id => !survivors.has(id)).sort((a, b) => a - b).map(id => ({ id, comp: compOf(id) }));
      return { groups, deleted, keyHolds };
    }

    // ---- mentions: per affected document, destinations and one winner each -----------------------------------------
    const mintIds = new Set(mints.map(m => m.id));
    const docsWithMoves = [...new Set(answers.filter(a => a.item.kind === 1).map(a => Number(a.item.owner.slice(1, a.item.owner.indexOf(":")))))].sort((a, b) => a - b);
    const rowsByDoc = new Map<number, MentionRowSnap[]>();
    for (const m of mentions) {
      const list = rowsByDoc.get(m.doc);
      if (list) list.push(m);
      else rowsByDoc.set(m.doc, [m]);
    }
    const bodyOf = db.prepare(`SELECT c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.id = ?`);
    const mentionDocs: MentionDocPlan[] = docsWithMoves.map(doc => {
      const rows = rowsByDoc.get(doc) ?? [];
      const dest = (r: MentionRowSnap) => accepted.get(`M${doc}:${r.entity}`)?.to ?? r.entity;
      const byDest = new Map<string, MentionRowSnap[]>();
      for (const r of rows) {
        const d = dest(r);
        const list = byDest.get(d);
        if (list) list.push(r);
        else byDest.set(d, [r]);
      }
      const winners = new Map<string, MentionRowSnap>();
      for (const [d, list] of byDest) {
        const staying = list.find(r => r.entity === d);
        winners.set(d, staying ?? [...list].sort((a, b) => cmpNum(sightingInstant(a.at), sightingInstant(b.at)) || a.rid - b.rid)[0]!);
      }
      const movers = rows.filter(r => dest(r) !== r.entity);
      const body = ((bodyOf.get(doc) as { body: string | null } | null)?.body ?? "").toLowerCase();
      const moves = movers.map(r => {
        const a = accepted.get(`M${doc}:${r.entity}`)!;
        return { rid: r.rid, from: r.entity, to: a.to, toMint: mintIds.has(a.to), fuzzy: a.fuzzy };
      });
      return {
        doc,
        before: rows.map(r => r.entity),
        after: [...winners].sort((a, b) => a[1].rid - b[1].rid).map(([d]) => d),
        deletes: movers,
        inserts: [...winners].filter(([d, r]) => r.entity !== d).map(([d, r]) => ({ entity: d, text: r.text, at: r.at, fromRid: r.rid })),
        moves,
        mayAlsoMention: [...new Set(moves.map(mv => mv.from))].filter(e => {
          const name = norm(nodes.get(e)?.name ?? "");
          return name.length > 0 && body.includes(name);
        }),
      };
    });

    // ---- entity edges the repair adds (previewed on a copy; apply computes them on the vault) --------------------------
    const edges = previewEdgeAdditions(db, mentionDocs);

    // ---- stale entity edges (report only): a recorded entity the two ends no longer share --------------------------
    const finalSet = new Map(mentionDocs.map(p => [p.doc, new Set(p.after)]));
    const entitiesOf = db.prepare(`SELECT entity_id AS e FROM entity_mentions WHERE doc_id = ?`);
    const setOf = (doc: number) => finalSet.get(doc) ?? new Set((entitiesOf.all(doc) as { e: string }[]).map(r => r.e));
    const staleEdges: StaleEdge[] = [];
    const seen = new Set<string>();
    const edgesOf = db.prepare(`SELECT source_id AS s, target_id AS t, metadata AS m FROM memory_relations WHERE relation_type = 'entity' AND (source_id = ? OR target_id = ?)`);
    for (const doc of docsWithMoves) {
      for (const r of edgesOf.all(doc, doc) as { s: number; t: number; m: string | null }[]) {
        const k = `${r.s}>${r.t}`;
        if (seen.has(k)) continue;
        seen.add(k);
        let entity: unknown;
        try {
          entity = JSON.parse(r.m ?? "{}").entity;
        } catch {
          entity = undefined;
        }
        if (typeof entity !== "string" || entity.length === 0) continue;
        const a = setOf(r.s);
        const b = setOf(r.t);
        if (a.has(entity) && b.has(entity)) continue;
        staleEdges.push({ source: r.s, target: r.t, entity, stillShared: [...a].filter(x => b.has(x)).sort() });
      }
    }

    // ---- R3/R4: counted, never changed ------------------------------------------------------------------------------
    let r3: number | null = null;
    let r4: number | null = null;
    if (opts.reports) {
      r3 = 0;
      r4 = 0;
      for (const u of unrepaired) {
        const node = nodes.get(u.linked);
        if (!node || !node.type) continue;
        const type = u.tripleTyped ? resolveEntityTypeExact(db, u.surface, node.vault) ?? "concept" : node.type;
        const to = resolveEntityCanonical(db, u.surface, type, node.vault);
        if (to === u.linked) continue;
        if (norm(u.surface) === norm(node.name)) r3++;
        else r4++;
      }
    }

    const alloc = allocation!;
    const plan: Omit<EntityRepairPlan, "digest"> = {
      runs,
      items,
      holds: [...held].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      answers,
      mints,
      groups: alloc.groups,
      deletedTriples: alloc.deleted,
      mentionDocs,
      edges,
      staleEdges,
      counts: {
        r1: answers.filter(a => a.item.cls === "R1").length,
        r2: answers.filter(a => a.item.cls === "R2").length,
        held: held.size,
        r3,
        r4,
        unparseable,
        triplesTouched: touched.size,
      },
    };
    return { ...plan, digest: planDigest(plan) };
  } finally {
    copy.close();
  }
}

/** Count deltas per document, as the plan states them: +1 per entity gained, −1 per entity lost; pairs likewise. */
export function mentionDeltas(p: MentionDocPlan): { counts: [string, number][]; pairs: [string, string, number][] } {
  const before = new Set(p.before);
  const after = new Set(p.after);
  const counts: [string, number][] = [];
  for (const e of [...after].sort()) if (!before.has(e)) counts.push([e, 1]);
  for (const e of [...before].sort()) if (!after.has(e)) counts.push([e, -1]);
  const pb = pairsOf(before);
  const pa = pairsOf(after);
  const pairs: [string, string, number][] = [];
  for (const k of [...pa].sort()) if (!pb.has(k)) pairs.push([...(k.split("\u0000") as [string, string]), 1]);
  for (const k of [...pb].sort()) if (!pa.has(k)) pairs.push([...(k.split("\u0000") as [string, string]), -1]);
  return { counts, pairs };
}

/**
 * SHA-256 of the canonical plan: the repair's own decisions and deltas, the stored values they rest on — each item's
 * old endpoint and sighting time, each affected triple's endpoints before the repair, every grouped evidence row's and
 * every moving mention row's stored time — and each added edge's source, target and recorded entity. Left out: every
 * clock value the repair generates, every edge weight (it follows the active-document count, which every saved document
 * changes), and every report (R3/R4 counts, stale edges, "may also mention").
 */
export function planDigest(plan: Omit<EntityRepairPlan, "digest">): string {
  const canonical = {
    v: 2,
    holds: plan.holds,
    order: plan.items.map(i => [i.key, i.linked, i.at]), // at: the stored time as an instant (missing → null)
    answers: plan.answers.map(a => [a.item.key, a.to, a.minted ? 1 : 0]),
    mints: plan.mints.map(m => [m.id, m.name, m.type, m.vault]),
    triples: plan.groups.map(g => [
      g.action, g.survivor, g.members, g.key,
      g.origins.map(o => [o.id, o.subject, o.object]),
      g.evidence.map(e => [e.id, e.from, e.keep ? 1 : 0, e.at]),
      [g.inline.doc, g.inline.fact, g.inline.at], g.confidence,
    ]),
    deleted: plan.deletedTriples.map(d => d.id),
    mentions: plan.mentionDocs.map(p => [
      p.doc,
      p.deletes.map(r => [r.rid, r.entity, r.at]),
      p.inserts.map(x => [x.entity, x.fromRid, x.text, x.at]),
      mentionDeltas(p).counts,
      mentionDeltas(p).pairs,
    ]),
    edges: plan.edges.map(e => [e.source, e.target, e.entity]), // never the weight: it follows the active-document count
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// =============================================================================
// Dry run
// =============================================================================

/** Plan one vault file without writing: a readonly handle, one read transaction, then ROLLBACK. */
export function dryRunEntityRepair(dbPath: string): EntityRepairPlan {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("BEGIN");
    try {
      db.prepare(`SELECT 1 FROM sqlite_master LIMIT 1`).get(); // the first read pins one snapshot
      return planEntityRepair(db, { reports: true });
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

// =============================================================================
// Apply
// =============================================================================

/** Connection settings only (no store init): wait for the write lock as ClawMem's stores do, and enforce foreign keys. */
const BUSY_TIMEOUT_MS = 5_000;
function writerSettings(db: Database): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON"); // a no-op inside a transaction, so set before BEGIN
}

const LOG_DDL = `
  CREATE TABLE IF NOT EXISTS entity_repair_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op_id TEXT NOT NULL,
    comp TEXT,
    tbl TEXT NOT NULL,
    row_key TEXT NOT NULL,
    action TEXT NOT NULL,
    old_row TEXT,
    new_row TEXT,
    created_at TEXT NOT NULL
  )`;

type Logger = (comp: string | null, tbl: string, rowKey: string, action: string, oldRow: unknown, newRow: unknown) => void;

function repairLogger(db: Database, op: string): Logger {
  const ins = db.prepare(`
    INSERT INTO entity_repair_log (op_id, comp, tbl, row_key, action, old_row, new_row, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = isoNow();
  return (comp, tbl, rowKey, action, oldRow, newRow) => {
    ins.run(op, comp, tbl, rowKey, action, oldRow == null ? null : JSON.stringify(oldRow), newRow == null ? null : JSON.stringify(newRow), now);
  };
}

export interface EntityRepairApplyReport {
  opId: string;
  plan: EntityRepairPlan;
  written: { mints: number; triplesUpdated: number; triplesInserted: number; triplesDeleted: number; evidenceMoved: number; evidenceDeleted: number; mentionsMoved: number; edgesAdded: number };
  newTriples: { group: number; id: number }[]; // the id each "new" group's triple got (group = index into plan.groups)
}

type Row = Record<string, string | number | null>;

/** Insert a whole logged row (every column it carries, its id included). */
function insertRow(db: Database, tbl: string, row: Row): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${tbl} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map(c => row[c] ?? null));
}

/**
 * Apply the plan to one vault, in one transaction on a raw read-write handle the caller opened (no store init). The
 * plan is made again under the write lock; `expect` must equal its digest; every answer is checked on the vault itself,
 * in plan order, each mint written right after its check. Throws EntityRepairRefusal (rolled back) on any refusal.
 */
export function applyEntityRepair(
  db: Database,
  opts: { expect?: string; testHooks?: { afterPlan?: (plan: EntityRepairPlan) => void } } = {},
): EntityRepairApplyReport {
  writerSettings(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planEntityRepair(db);
    if (opts.expect !== undefined && plan.digest !== opts.expect) {
      throw new EntityRepairRefusal(`the plan's digest is ${plan.digest}, not ${opts.expect}: the vault changed since that dry run — nothing written; run the dry run again`);
    }
    opts.testHooks?.afterPlan?.(plan);
    // every answer, checked on the vault in plan order; each mint written by the one mint operation
    const fts = readFtsBook(db);
    const mintFts = new Map<string, number | null>();
    const exists = db.prepare(`SELECT 1 FROM entity_nodes WHERE entity_id = ?`);
    for (const a of plan.answers) {
      const got = resolveEntityCanonical(db, a.item.surface, a.item.type, a.item.vault);
      if (a.minted ? got !== null : got !== a.to) {
        throw new EntityRepairRefusal(`the vault no longer resolves "${a.item.surface}" as planned — nothing written; run the dry run again`);
      }
      if (!a.minted) continue;
      if (exists.get(a.to)) throw new EntityRepairRefusal(`entity ${a.to} already exists on the vault — nothing written; run the dry run again`);
      const r = mintEntity(db, fts, { id: a.to, name: a.item.surface, type: a.item.type, vault: a.item.vault });
      if (r === "fts-row-mismatch") throw new EntityRepairRefusal(`entity ${a.to} has an FTS row with another name or type — nothing written; run the dry run again`);
      mintFts.set(a.to, r.ftsRowid);
    }

    db.exec(LOG_DDL);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_repair_log_op ON entity_repair_log(op_id, comp)`);
    const opId = `er-${isoNow()}`;
    if (db.prepare(`SELECT 1 FROM entity_repair_log WHERE op_id = ? LIMIT 1`).get(opId)) {
      throw new EntityRepairRefusal(`op id ${opId} is already in entity_repair_log — run again`);
    }
    const log = repairLogger(db, opId);
    const written = { mints: 0, triplesUpdated: 0, triplesInserted: 0, triplesDeleted: 0, evidenceMoved: 0, evidenceDeleted: 0, mentionsMoved: 0, edgesAdded: 0 };

    for (const m of plan.mints) {
      const node = db.prepare(`SELECT * FROM entity_nodes WHERE entity_id = ?`).get(m.id) as Row;
      log(null, "entity_nodes", m.id, "mint", null, { ...node, fts_rowid: mintFts.get(m.id) ?? null });
      written.mints++;
    }

    // ---- triples and evidence: rows are logged whole, so a restore puts back exactly what it took ---------------------
    const tripleRow = db.prepare(`SELECT * FROM entity_triples WHERE id = ?`);
    const evidenceRow = db.prepare(`SELECT * FROM entity_triple_provenance WHERE id = ?`);
    // (0) before any triple changes: each key a restore would give back (an open triple re-pointed or removed here) with
    // the open triples holding it now, keyed as addTriple finds one (subject, predicate, object; validity aside). A
    // restore gives a key back only while no other open triple took it since.
    const holders = db.prepare(`
      SELECT id FROM entity_triples
      WHERE subject_entity_id = ? AND predicate = ? AND object_entity_id IS ? AND object_literal IS ? AND valid_to IS NULL
      ORDER BY id
    `);
    const returned = new Map<string, Map<string, (string | number | null)[]>>(); // comp → key json → key
    const giveBack = (comp: string, id: number, next: (string | number | null)[] | null) => {
      const row = tripleRow.get(id) as Row;
      if (row.valid_to !== null) return; // a closed triple holds no open key
      const key = [row.subject_entity_id ?? null, row.predicate ?? null, row.object_entity_id ?? null, row.object_literal ?? null];
      if (next && JSON.stringify(next) === JSON.stringify(key)) return;
      const keys = returned.get(comp) ?? new Map();
      keys.set(JSON.stringify(key), key);
      returned.set(comp, keys);
    };
    for (const g of plan.groups) if (g.action === "repoint") giveBack(g.comp, g.survivor!, [g.key[0], g.key[1], g.key[2], g.key[3]]);
    for (const d of plan.deletedTriples) giveBack(d.comp, d.id, null);
    for (const [comp, keys] of returned) {
      const list = [...keys.values()].map(key => ({ key, holders: (holders.all(...key) as { id: number }[]).map(r => r.id) }));
      log(comp, "entity_triples", comp, "key-holders", null, { keys: list });
    }
    // (1) collapsed rows first, everywhere
    for (const g of plan.groups) {
      for (const e of g.evidence) {
        if (e.keep) continue;
        const old = evidenceRow.get(e.id) as Row;
        db.prepare(`DELETE FROM entity_triple_provenance WHERE id = ?`).run(e.id);
        log(g.comp, "entity_triple_provenance", String(e.id), "evidence-delete", old, null);
        written.evidenceDeleted++;
      }
    }
    // (2) the new triples
    const dest: number[] = []; // per group, the triple that carries it
    const newTriples: { group: number; id: number }[] = [];
    plan.groups.forEach((g, i) => {
      if (g.survivor !== null) {
        dest.push(g.survivor);
        return;
      }
      const r = db.prepare(`
        INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, object_literal, valid_from, valid_to, confidence, source_doc_id, source_fact, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(g.key[0], g.key[1], g.key[2], g.key[3], g.key[4], g.key[5], g.confidence ?? 1.0, g.inline.doc, g.inline.fact, g.inline.at);
      const id = Number(r.lastInsertRowid);
      log(g.comp, "entity_triples", String(id), "triple-insert", null, tripleRow.get(id));
      written.triplesInserted++;
      newTriples.push({ group: i, id });
      dest.push(id);
    });
    // (3) every moving row leaves its triple, then (4) each arrives at its group's triple with its id and every other
    // column unchanged. An equal row (same document and fact) bound for another group can sit on a destination until it
    // moves out, so no row arrives before every row has left.
    const moving: { comp: string; id: number; old: Row; to: number }[] = [];
    plan.groups.forEach((g, i) => {
      for (const e of g.evidence) if (e.keep && e.from !== dest[i]) moving.push({ comp: g.comp, id: e.id, old: evidenceRow.get(e.id) as Row, to: dest[i]! });
    });
    for (const m of moving) db.prepare(`DELETE FROM entity_triple_provenance WHERE id = ?`).run(m.id);
    for (const m of moving) {
      insertRow(db, "entity_triple_provenance", { ...m.old, triple_id: m.to });
      log(m.comp, "entity_triple_provenance", String(m.id), "evidence-move", m.old, evidenceRow.get(m.id));
      written.evidenceMoved++;
    }
    // (5) the surviving triples' own rows
    for (const g of plan.groups) {
      if (g.survivor === null) continue;
      const old = tripleRow.get(g.survivor) as Row;
      const next: Row = {
        ...old,
        subject_entity_id: g.key[0],
        object_entity_id: g.key[2],
        confidence: g.confidence ?? old.confidence ?? null,
        source_doc_id: g.inline.doc,
        source_fact: g.inline.fact,
        created_at: g.inline.at,
      };
      if (Object.keys(old).some(c => next[c] !== old[c])) {
        db.prepare(`
          UPDATE entity_triples SET subject_entity_id = ?, object_entity_id = ?, confidence = ?, source_doc_id = ?, source_fact = ?, created_at = ?
          WHERE id = ?
        `).run(next.subject_entity_id ?? null, next.object_entity_id ?? null, next.confidence ?? null, next.source_doc_id ?? null, next.source_fact ?? null, next.created_at ?? null, g.survivor);
        log(g.comp, "entity_triples", String(g.survivor), "triple-update", old, tripleRow.get(g.survivor));
        written.triplesUpdated++;
      }
    }
    // (6) each carrying triple's final row and evidence set, once every row has moved (a split's later group moves rows
    // OUT): the restore reverses a component only while each still equals this, a carrier the repair left unchanged
    // included
    plan.groups.forEach((g, i) => {
      const id = dest[i]!;
      const ids = (db.prepare(`SELECT id FROM entity_triple_provenance WHERE triple_id = ? ORDER BY id`).all(id) as { id: number }[]).map(r => r.id);
      log(g.comp, "entity_triples", String(id), "evidence-set", null, { triple_id: id, evidence: ids, row: tripleRow.get(id) });
    });
    // (7) the emptied triples
    for (const d of plan.deletedTriples) {
      const old = tripleRow.get(d.id) as Row;
      db.prepare(`DELETE FROM entity_triples WHERE id = ?`).run(d.id);
      log(d.comp, "entity_triples", String(d.id), "triple-delete", old, null);
      written.triplesDeleted++;
    }

    // ---- mentions, then their counts (one restore component per document) --------------------------------------------
    const pairBefore = new Map<string, Row | null>(); // each pair's row as it was before this apply first touched it
    for (const p of plan.mentionDocs) {
      const comp = `M${p.doc}`;
      writeMentionMoves(db, p, (r, x) => {
        if (r) log(comp, "entity_mentions", `${r.entity}\u0000${r.doc}`, "mention-delete", { entity_id: r.entity, doc_id: r.doc, mention_text: r.text, created_at: r.at }, null);
        if (x) log(comp, "entity_mentions", `${x.entity}\u0000${p.doc}`, "mention-insert", null, { entity_id: x.entity, doc_id: p.doc, mention_text: x.text, created_at: x.at });
      });
      written.mentionsMoved += p.moves.length;
      const { counts, pairs } = mentionDeltas(p);
      const countOf = db.prepare(`SELECT mention_count AS n FROM entity_nodes WHERE entity_id = ?`);
      for (const [entity, delta] of counts) {
        const before = (countOf.get(entity) as { n: number | null } | null)?.n ?? 0;
        db.prepare(`UPDATE entity_nodes SET mention_count = MAX(0, COALESCE(mention_count, 0) + ?) WHERE entity_id = ?`).run(delta, entity);
        const after = (countOf.get(entity) as { n: number | null } | null)?.n ?? 0;
        log(comp, "entity_nodes", entity, "count", { mention_count: before }, { mention_count: after });
      }
      const coocRow = db.prepare(`SELECT entity_a, entity_b, count, last_cooccurred FROM entity_cooccurrences WHERE entity_a = ? AND entity_b = ?`);
      for (const [a, b, delta] of pairs) {
        const pair = `${a}\u0000${b}`;
        const old = coocRow.get(a, b) as Row | null;
        if (!pairBefore.has(pair)) pairBefore.set(pair, old);
        if (delta > 0) {
          if (old) db.prepare(`UPDATE entity_cooccurrences SET count = count + 1 WHERE entity_a = ? AND entity_b = ?`).run(a, b);
          else {
            // a pair an earlier document of this apply removed comes back with its own time, NULL included; only a pair
            // the vault never had gets the apply's
            const was = pairBefore.get(pair);
            if (was) db.prepare(`INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES (?, ?, 1, ?)`).run(a, b, was.last_cooccurred ?? null);
            else db.prepare(`INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES (?, ?, 1, datetime('now'))`).run(a, b);
          }
        } else if (old) {
          if (Number(old.count) - 1 <= 0) db.prepare(`DELETE FROM entity_cooccurrences WHERE entity_a = ? AND entity_b = ?`).run(a, b);
          else db.prepare(`UPDATE entity_cooccurrences SET count = count - 1 WHERE entity_a = ? AND entity_b = ?`).run(a, b);
        } else {
          continue; // nothing to lower
        }
        log(comp, "entity_cooccurrences", `${a}\u0000${b}`, "cooc", old, coocRow.get(a, b) ?? null);
      }
      // the document's complete final mention set: restore reverses this component only while the rows still equal it
      log(comp, "entity_mentions", String(p.doc), "mention-set", null, { doc_id: p.doc, rows: mentionSet(db, p.doc) });
    }

    // ---- entity edges: computed on the vault after every mention write; they must equal the plan made under this lock
    const actual = edgeAdditions(db, db, plan.mentionDocs);
    const tuple = (e: PlannedEdge) => JSON.stringify([e.source, e.target, e.entity, e.weight]);
    if (actual.map(tuple).sort().join("\n") !== plan.edges.map(tuple).sort().join("\n")) {
      throw new EntityRepairRefusal(`the vault's links no longer match the plan — nothing written; run the dry run again`);
    }
    const relationRow = db.prepare(`SELECT source_id, target_id, relation_type, weight, metadata, created_at FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'entity'`);
    for (const e of actual) {
      const n = writeEntityEdge(db, e.source, { targetDocId: e.target, sharedEntities: new Array(e.shared).fill(e.entity), idf: new Map(), weight: e.weight, bestEntity: e.entity });
      if (n !== 1) continue;
      log(null, "memory_relations", `${e.source}\u0000${e.target}\u0000entity`, "edge-add", null, relationRow.get(e.source, e.target));
      written.edgesAdded++;
    }

    db.exec("COMMIT");
    return { opId, plan, written, newTriples };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw err;
  }
}

// =============================================================================
// Restore
// =============================================================================

export interface EntityRepairRestoreReport {
  opId: string;
  restored: string[]; // components reversed
  kept: { comp: string; why: string }[]; // components left as the repair wrote them
  mintsDeleted: string[];
  mintsKept: string[];
  edgesKept: number;
}

interface LogRow {
  id: number;
  comp: string | null;
  tbl: string;
  row_key: string;
  action: string;
  old_row: string | null;
  new_row: string | null;
}

/**
 * Reverse one apply, one component at a time: validate everything in the component, then reverse it — or keep the whole
 * component and say why. Count columns reverse by their logged delta. Added edges are never touched. A minted entity
 * goes only when nothing references it. One transaction; foreign keys and non-empty evidence are checked before commit.
 */
export function restoreEntityRepair(db: Database, opId: string): EntityRepairRestoreReport {
  writerSettings(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entity_repair_log'`).get()) {
      throw new EntityRepairRefusal(`no entity_repair_log on this vault`);
    }
    const rows = db.prepare(`SELECT id, comp, tbl, row_key, action, old_row, new_row FROM entity_repair_log WHERE op_id = ? ORDER BY id`).all(opId) as LogRow[];
    if (rows.length === 0) throw new EntityRepairRefusal(`no repair op ${opId} in entity_repair_log`);
    const done = new Set(rows.filter(r => r.action === "restored").map(r => r.comp));
    const parse = (s: string | null) => (s == null ? null : (JSON.parse(s) as Row));
    const out: EntityRepairRestoreReport = { opId, restored: [], kept: [], mintsDeleted: [], mintsKept: [], edgesKept: 0 };
    const byComp = new Map<string, LogRow[]>();
    for (const r of rows) {
      if (r.comp === null || r.action === "restored") continue;
      const list = byComp.get(r.comp);
      if (list) list.push(r);
      else byComp.set(r.comp, [r]);
    }
    const mark = repairLogger(db, opId);
    const tripleRow = db.prepare(`SELECT * FROM entity_triples WHERE id = ?`);
    const evidenceRow = db.prepare(`SELECT * FROM entity_triple_provenance WHERE id = ?`);
    const same = (a: Row | null, b: Row | null) => a !== null && b !== null && Object.keys(b).every(k => a[k] === b[k]);

    // validate every component, then the open-key check over all the triple components that passed, together; only then
    // reverse what is left
    const candidates = new Map<string, LogRow[]>();
    for (const [comp, list] of [...byComp].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (done.has(comp)) continue;
      const why = comp.startsWith("T") ? validateTripleComp(list) : validateMentionComp(list);
      if (why) out.kept.push({ comp, why });
      else candidates.set(comp, list);
    }
    for (const [comp, why] of keyConflicts(candidates)) {
      candidates.delete(comp);
      out.kept.push({ comp, why });
    }
    for (const [comp, list] of candidates) {
      if (comp.startsWith("T")) reverseTripleComp(list);
      else reverseMentionComp(list);
      mark(comp, "entity_repair_log", comp, "restored", null, null);
      out.restored.push(comp);
    }
    out.kept.sort((a, b) => (a.comp < b.comp ? -1 : a.comp > b.comp ? 1 : 0));

    /**
     * One open triple per subject, predicate and object, as addTriple keeps it. A triple component gives a
     * key back when it re-points an open triple or brings back a removed one. With every candidate restored at once —
     * their triples back at their old keys, the triples they inserted gone — each key given back must be held only by
     * open triples that held it before the apply (logged then). A component that gives back a key some other open
     * triple now holds (a fact recorded since, or a triple whose component is kept) is kept; dropping it can leave
     * another component's key taken, so the check repeats until nothing changes.
     */
    function keyConflicts(cands: Map<string, LogRow[]>): [string, string][] {
      type Key = (string | number | null)[];
      const openKey = (row: Row | null): string | null =>
        row && row.valid_to == null ? JSON.stringify([row.subject_entity_id ?? null, row.predicate ?? null, row.object_entity_id ?? null, row.object_literal ?? null]) : null;
      const info = new Map<string, { gives: { k: string; key: Key; before: Set<number>; back: number[] }[]; moves: Map<number, string | null> }>();
      for (const [comp, list] of cands) {
        if (!comp.startsWith("T")) continue;
        const moves = new Map<number, string | null>(); // each triple this component's restore changes → its key afterwards
        for (const r of list) {
          if (r.action === "triple-update" || r.action === "triple-delete") moves.set(Number(r.row_key), openKey(parse(r.old_row)));
          else if (r.action === "triple-insert") moves.set(Number(r.row_key), null);
        }
        const gives = list.filter(r => r.action === "key-holders").flatMap(r =>
          (JSON.parse(r.new_row!) as { keys: { key: Key; holders: number[] }[] }).keys.map(x => {
            const k = JSON.stringify(x.key);
            return { k, key: x.key, before: new Set(x.holders), back: [...moves].filter(([, after]) => after === k).map(([id]) => id) };
          }));
        info.set(comp, { gives, moves });
      }
      const holders = db.prepare(`
        SELECT id FROM entity_triples
        WHERE subject_entity_id = ? AND predicate = ? AND object_entity_id IS ? AND object_literal IS ? AND valid_to IS NULL
      `);
      const now = new Map<string, number[]>();
      const holdersNow = (k: string, key: Key) => {
        if (!now.has(k)) now.set(k, (holders.all(...key) as { id: number }[]).map(r => r.id));
        return now.get(k)!;
      };
      const restoring = new Set(info.keys());
      const conflicts: [string, string][] = [];
      for (;;) {
        const moved = new Map<number, string | null>();
        for (const c of restoring) for (const [id, after] of info.get(c)!.moves) moved.set(id, after);
        const dropped: [string, string][] = [];
        for (const c of restoring) {
          for (const g of info.get(c)!.gives) {
            const after = new Set(holdersNow(g.k, g.key).filter(id => !moved.has(id)));
            for (const [id, k] of moved) if (k === g.k) after.add(id);
            const others = [...after].filter(id => !g.before.has(id)).sort((a, b) => a - b);
            if (others.length === 0) continue;
            dropped.push([c, `restoring it would leave two open triples on one key: #${others.join(", #")} now holds the subject, predicate and object #${g.back.join(", #")} would get back`]);
            break;
          }
        }
        if (dropped.length === 0) return conflicts;
        for (const [c, why] of dropped) {
          restoring.delete(c);
          conflicts.push([c, why]);
        }
      }
    }

    function validateTripleComp(list: LogRow[]): string | null {
      for (const r of list) {
        if (r.action === "triple-insert" || r.action === "triple-update") {
          if (!same(tripleRow.get(Number(r.row_key)) as Row | null, parse(r.new_row))) return `triple ${r.row_key} changed since the repair`;
        } else if (r.action === "evidence-move") {
          if (!same(evidenceRow.get(Number(r.row_key)) as Row | null, parse(r.new_row))) return `evidence ${r.row_key} changed since the repair`;
        } else if (r.action === "evidence-delete") {
          if (evidenceRow.get(Number(r.row_key))) return `evidence ${r.row_key} exists again`;
        } else if (r.action === "triple-delete") {
          if (tripleRow.get(Number(r.row_key))) return `triple ${r.row_key} exists again`;
        } else if (r.action === "evidence-set") {
          const want = parse(r.new_row) as unknown as { evidence: number[]; row: Row };
          if (!same(tripleRow.get(Number(r.row_key)) as Row | null, want.row)) return `triple ${r.row_key} changed since the repair`;
          const have = (db.prepare(`SELECT id FROM entity_triple_provenance WHERE triple_id = ? ORDER BY id`).all(Number(r.row_key)) as { id: number }[]).map(x => x.id);
          if (want.evidence.length !== have.length || want.evidence.some((id, i) => id !== have[i])) return `triple ${r.row_key} has new evidence since the repair`;
        }
      }
      return null;
    }

    function reverseTripleComp(list: LogRow[]): void {
      // the deleted triples first: moved rows return to them
      for (const r of list) if (r.action === "triple-delete") insertRow(db, "entity_triples", parse(r.old_row)!);
      // every moved row leaves, then each returns whole, with the collapsed rows: whatever order the moves were logged
      // in, no row meets an equal one on its way back
      const moved = list.filter(r => r.action === "evidence-move");
      for (const r of moved) db.prepare(`DELETE FROM entity_triple_provenance WHERE id = ?`).run(Number(r.row_key));
      for (const r of moved) insertRow(db, "entity_triple_provenance", parse(r.old_row)!);
      for (const r of list) if (r.action === "evidence-delete") insertRow(db, "entity_triple_provenance", parse(r.old_row)!);
      for (const r of list) {
        if (r.action !== "triple-update") continue;
        const old = parse(r.old_row)!;
        db.prepare(`
          UPDATE entity_triples SET subject_entity_id = ?, object_entity_id = ?, confidence = ?, source_doc_id = ?, source_fact = ?, created_at = ?
          WHERE id = ?
        `).run(old.subject_entity_id ?? null, old.object_entity_id ?? null, old.confidence ?? null, old.source_doc_id ?? null, old.source_fact ?? null, old.created_at ?? null, Number(r.row_key));
      }
      for (const r of list) if (r.action === "triple-insert") db.prepare(`DELETE FROM entity_triples WHERE id = ?`).run(Number(r.row_key));
    }

    function validateMentionComp(list: LogRow[]): string | null {
      const witness = list.find(r => r.action === "mention-set");
      if (!witness) return "no final mention set was logged";
      const want = JSON.parse(witness.new_row!) as { doc_id: number; rows: unknown[] };
      if (JSON.stringify(mentionSet(db, want.doc_id)) !== JSON.stringify(want.rows)) {
        return `document ${want.doc_id}'s mentions changed since the repair`;
      }
      return null;
    }

    function reverseMentionComp(list: LogRow[]): void {
      for (const r of list) {
        if (r.action !== "mention-insert") continue;
        const row = parse(r.new_row)!;
        db.prepare(`DELETE FROM entity_mentions WHERE entity_id = ? AND doc_id = ?`).run(row.entity_id ?? null, row.doc_id ?? null);
      }
      for (const r of list) {
        if (r.action !== "mention-delete") continue;
        const row = parse(r.old_row)!;
        db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, ?, ?)`)
          .run(row.entity_id ?? null, row.doc_id ?? null, row.mention_text ?? null, row.created_at ?? null);
      }
      for (const r of list) {
        if (r.action === "count") {
          const delta = Number(parse(r.new_row)!.mention_count ?? 0) - Number(parse(r.old_row)!.mention_count ?? 0);
          db.prepare(`UPDATE entity_nodes SET mention_count = MAX(0, COALESCE(mention_count, 0) - ?) WHERE entity_id = ?`).run(delta, r.row_key);
        } else if (r.action === "cooc") {
          const [a, b] = r.row_key.split("\u0000") as [string, string];
          const old = parse(r.old_row);
          const next = parse(r.new_row);
          const delta = Number(next?.count ?? 0) - Number(old?.count ?? 0);
          const cur = db.prepare(`SELECT count FROM entity_cooccurrences WHERE entity_a = ? AND entity_b = ?`).get(a, b) as { count: number } | null;
          if (cur) {
            if (cur.count - delta <= 0) db.prepare(`DELETE FROM entity_cooccurrences WHERE entity_a = ? AND entity_b = ?`).run(a, b);
            else db.prepare(`UPDATE entity_cooccurrences SET count = count - ? WHERE entity_a = ? AND entity_b = ?`).run(delta, a, b);
          } else if (-delta > 0) {
            db.prepare(`INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES (?, ?, ?, ?)`)
              .run(a, b, -delta, old?.last_cooccurred ?? null);
          }
        }
      }
    }

    // ---- mints, after every component is decided: deleted only when nothing references them -------------------------
    for (const r of rows) {
      if (r.action !== "mint") continue;
      const id = r.row_key;
      if (out.mintsDeleted.includes(id) || out.mintsKept.includes(id)) continue;
      if (!db.prepare(`SELECT 1 FROM entity_nodes WHERE entity_id = ?`).get(id)) continue;
      const referenced =
        db.prepare(`SELECT 1 FROM entity_triples WHERE subject_entity_id = ? OR object_entity_id = ? LIMIT 1`).get(id, id) ||
        db.prepare(`SELECT 1 FROM entity_mentions WHERE entity_id = ? LIMIT 1`).get(id) ||
        db.prepare(`SELECT 1 FROM entity_cooccurrences WHERE entity_a = ? OR entity_b = ? LIMIT 1`).get(id, id) ||
        db.prepare(`SELECT 1 FROM entity_nodes WHERE canonical_id = ? AND entity_id != ? LIMIT 1`).get(id, id) ||
        db.prepare(`SELECT 1 FROM memory_relations WHERE relation_type = 'entity' AND json_valid(metadata) AND json_extract(metadata, '$.entity') = ? LIMIT 1`).get(id);
      if (referenced) {
        out.mintsKept.push(id);
        continue;
      }
      const ftsRowid = parse(r.new_row)?.fts_rowid;
      if (typeof ftsRowid === "number") db.prepare(`DELETE FROM entities_fts WHERE rowid = ? AND entity_id = ?`).run(ftsRowid, id);
      db.prepare(`DELETE FROM entity_nodes WHERE entity_id = ?`).run(id);
      out.mintsDeleted.push(id);
    }
    out.edgesKept = rows.filter(r => r.action === "edge-add").length;

    // ---- integrity before commit ----------------------------------------------------------------------------------------
    for (const t of ["entity_triples", "entity_triple_provenance", "entity_mentions"]) {
      if ((db.prepare(`SELECT * FROM pragma_foreign_key_check(?)`).all(t) as unknown[]).length > 0) {
        throw new EntityRepairRefusal(`restore would leave a dangling reference in ${t} — rolled back, nothing changed`);
      }
    }
    if (missingPrerequisite(db)) throw new EntityRepairRefusal(`restore would leave a triple without evidence — rolled back, nothing changed`);
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw err;
  }
}
