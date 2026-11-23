/**
 * BACKLOG 82.3, D7 — a vault that holds a legacy row whose path starts with a byte-order mark BESIDE its unmarked
 * twin with a different body (`<mark>a.md` and `a.md`), a marked session id and a marked handoff reference. The marked
 * values are written with the lossless binding (`CAST(? AS TEXT)` of their bytes), as rows from before the guard.
 *
 * With it: a snapshot of every table (text compared by its bytes), a diff, the identity check of the marked row, and
 * the twin check of a reply. No mark is typed into this file.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { canonicalDocId, createStore } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { seedContent } from "./seed-content.ts";

export const MARKS: [string, string][] = [["U+FEFF", String.fromCharCode(0xfeff)], ["U+FFFE", String.fromCharCode(0xfffe)]];
export const BODY_PLAIN = "PLAINTWIN the tank filter is cleaned weekly, says the plain twin.";
export const BODY_MARKED = "MARKEDTWIN the tank filter is cleaned daily, says the marked twin.";
export const QUERY = "tank filter cleaned";
export const VEC_MODEL = "twin-fake";

const bytes = (s: string) => new TextEncoder().encode(s);
export const hexOf = (s: string) => Buffer.from(s, "utf-8").toString("hex").toUpperCase();

export type TwinVault = {
  dir: string; vault: string; cfgDir: string; notes: string; mark: string;
  markedPath: string; plainHash: string; markedHash: string; plainId: number; markedId: number;
  markedSession: string; markedHandoff: string; hasMarkedSession: boolean;
};

export type TwinOptions = {
  /** The collection is in the config (default) — the condition under which its identifiers are bound again. */
  configured?: boolean;
  /** The marked row's origin: "fs" (default) or "api". */
  markedOrigin?: "fs" | "api";
  /** Write the two files to the collection folder too (default true). */
  files?: boolean;
  /** With `files`, write the marked file too (default true). */
  markedFile?: boolean;
  /** Seed the marked rows at all (default true); false gives a healthy vault with the plain twin alone. */
  marked?: boolean;
  /** Seed the marked session id and the marked handoff reference (default true, with `marked`). */
  markedSession?: boolean;
  /** Make both twins observations (a discovery with facts), so the consolidation and deduction passes select them. */
  observation?: boolean;
  /** Days since the documents were modified and last read (default 40: old enough for a 1-day lifecycle policy). */
  ageDays?: number;
  /** Write a lifecycle policy that archives after one day (default true). Without it nothing archives on its own. */
  lifecycle?: boolean;
};

/** The fake embedder for in-process routes: every text sits near both twins. */
export const twinLlm = {
  embed: async () => ({ embedding: new Float32Array([1, 0.05, 0, 0]), model: VEC_MODEL }),
  query: async () => null,
  expandQuery: async () => [],
  generate: async () => null,
} as any;

export function makeTwinVault(mark: string, opts: TwinOptions = {}): TwinVault {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-twin-"));
  const notes = join(dir, "notes");
  const cfgDir = join(dir, "cfg");
  mkdirSync(notes); mkdirSync(cfgDir);
  const collections = opts.configured === false
    ? "collections: {}\n"
    : `collections:\n  notes:\n    path: ${notes}\n    pattern: "**/*.md"\n`;
  const policy = opts.lifecycle === false ? "" : `lifecycle:\n  archive_after_days: 1\n  dry_run: false\n`;
  writeFileSync(join(cfgDir, "config.yaml"), collections + policy);
  const markedPath = mark + "a.md";
  if (opts.files !== false) {
    writeFileSync(join(notes, "a.md"), BODY_PLAIN);
    if (opts.markedFile !== false && opts.marked !== false) writeFileSync(join(notes, markedPath), BODY_MARKED);
  }
  const vault = join(dir, "vault.sqlite");
  const s = createStore(vault);
  const when = new Date(Date.now() - (opts.ageDays ?? 40) * 86400_000).toISOString();
  const plainHash = hashContent(BODY_PLAIN);
  const markedHash = hashContent(BODY_MARKED);
  seedContent(s.db, plainHash, BODY_PLAIN, when);
  seedContent(s.db, markedHash, BODY_MARKED, when);
  s.insertDocument("notes", "a.md", "Plain twin", plainHash, when, when);
  if (opts.marked !== false) s.db.prepare(
    `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, origin, last_accessed_at)
     VALUES ('notes', CAST(? AS TEXT), 'Marked twin', ?, ?, ?, 1, ?, ?)`,
  ).run(bytes(markedPath), markedHash, when, when, opts.markedOrigin ?? "fs", when);
  // A counter write needs a new counter_stamp, or the fence trigger ignores it (stop_fence_doc_counters).
  s.db.prepare(`UPDATE documents SET origin = 'fs', last_accessed_at = ?, counter_stamp = 'twin-seed' WHERE path = 'a.md'`).run(when);
  s.ensureVecTable(4);
  s.insertEmbedding(plainHash, 0, 0, new Float32Array([1, 0, 0, 0]), VEC_MODEL, when, "full", undefined, canonicalDocId("notes", "a.md"));
  if (opts.marked !== false) s.insertEmbedding(markedHash, 0, 0, new Float32Array([0.99, 0.1, 0, 0]), VEC_MODEL, when, "full", undefined, canonicalDocId("notes", markedPath));
  s.db.exec(`UPDATE documents SET embed_state = 'synced'`);
  if (opts.observation) s.db.exec(`UPDATE documents SET content_type = 'observation', observation_type = 'discovery',
    facts = 'The tank filter is cleaned on a schedule. The schedule is kept by the twin.', narrative = 'A narrative about the tank filter.'`);
  const markedSession = mark + "s-1";
  const markedHandoff = "notes/" + markedPath;
  if (opts.marked !== false && opts.markedSession !== false) s.db.prepare(`INSERT INTO session_log (session_id, started_at, handoff_path) VALUES (CAST(? AS TEXT), ?, CAST(? AS TEXT))`)
    .run(bytes(markedSession), when, bytes(markedHandoff));
  const idOf = (hash: string) => (s.db.prepare(`SELECT id FROM documents WHERE hash = ?`).get(hash) as { id: number } | null)?.id ?? -1;
  const out: TwinVault = {
    dir, vault, cfgDir, notes, mark, markedPath, plainHash, markedHash,
    plainId: idOf(plainHash), markedId: idOf(markedHash), markedSession, markedHandoff,
    hasMarkedSession: opts.marked !== false && opts.markedSession !== false,
  };
  s.close();
  return out;
}

/** The environment a child process (CLI, hook) runs this vault with. No model endpoint is reachable. */
export function twinEnv(t: TwinVault): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  Object.assign(env, {
    HOME: t.dir, INDEX_PATH: t.vault, CLAWMEM_CONFIG_DIR: t.cfgDir, XDG_RUNTIME_DIR: t.dir,
    CLAWMEM_NO_LOCAL_MODELS: "true", CLAWMEM_EMBED_URL: "http://127.0.0.1:1", CLAWMEM_LLM_URL: "http://127.0.0.1:1",
    CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
  });
  return env;
}

/** Every table of the vault AND of its compaction registry (`<vault>-compaction.sqlite`, tables prefixed
 *  `registry:`), each row as one string; text is compared by its bytes. Read-only. */
export type Snapshot = Map<string, string[]>;
export function snapshot(path: string): Snapshot {
  const out = snapshotFile(path);
  if (existsSync(path + "-compaction.sqlite")) for (const [k, v] of snapshotFile(path + "-compaction.sqlite")) out.set("registry:" + k, v);
  return out;
}

/** The documents rows by id, every column as text (text by its bytes): what a named write changed, row by row. */
export function documentsById(path: string): Map<number, Record<string, string>> {
  const db = new Database(path, { readonly: true });
  try {
    const cols = (db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(c => c.name);
    const expr = cols.map(c => `CASE typeof("${c}") WHEN 'text' THEN 'T' || hex("${c}") ELSE quote("${c}") END AS "${c}"`).join(", ");
    const out = new Map<number, Record<string, string>>();
    for (const r of db.prepare(`SELECT id AS __id, ${expr} FROM documents`).all() as Record<string, string>[]) out.set(Number(r.__id), r);
    return out;
  } finally { db.close(); }
}
/** Per document id, the columns whose value changed (an id added or removed is listed as `["(row)"]`). */
export function documentChanges(a: Map<number, Record<string, string>>, b: Map<number, Record<string, string>>): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id), y = b.get(id);
    if (!x || !y) { out[id] = ["(row)"]; continue; }
    const cols = Object.keys(x).filter(c => c !== "__id" && x[c] !== y[c]);
    if (cols.length) out[id] = cols.sort();
  }
  return out;
}

function snapshotFile(path: string): Snapshot {
  const db = new Database(path, { readonly: true });
  const out: Snapshot = new Map();
  try {
    const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string; sql: string | null }[];
    for (const { name, sql } of tables) {
      if (sql && /^CREATE VIRTUAL TABLE/i.test(sql)) continue;   // its shadow tables are listed on their own
      const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(c => c.name);
      if (cols.length === 0) continue;
      const expr = cols.map(c => `CASE typeof("${c}") WHEN 'text' THEN 'T' || hex("${c}") WHEN 'blob' THEN 'B' || hex("${c}") ELSE quote("${c}") END`).join(" || '|' || ");
      out.set(name, (db.prepare(`SELECT ${expr} AS r FROM "${name}"`).all() as { r: string }[]).map(r => r.r).sort());
    }
  } finally { db.close(); }
  return out;
}

/** Tables whose rows differ, with the number of rows gone and added. */
export function changedTables(a: Snapshot, b: Snapshot): Record<string, { gone: number; added: number }> {
  const out: Record<string, { gone: number; added: number }> = {};
  for (const t of new Set([...a.keys(), ...b.keys()])) {
    const x = new Set(a.get(t) ?? []), y = new Set(b.get(t) ?? []);
    const gone = [...x].filter(r => !y.has(r)).length, added = [...y].filter(r => !x.has(r)).length;
    if (gone || added) out[t] = { gone, added };
  }
  return out;
}

/**
 * The identity of the marked rows: the marked document is still the row it was (same id, same path bytes, same
 * collection) and names the same body, and the marked session row keeps its id and handoff reference bytes. Its
 * `active`/archive columns may change by a named operation; its identifiers may not.
 */
export function identityOf(t: TwinVault): string {
  const db = new Database(t.vault, { readonly: true });
  try {
    const d = db.prepare(`SELECT id, hex(path) p, hex(collection) c, hash h, (SELECT doc FROM content WHERE content.hash = documents.hash) body
      FROM documents WHERE id = ?`).get(t.markedId) as { id: number; p: string; c: string; h: string; body: string | null } | null;
    const p = db.prepare(`SELECT id, hex(path) p, hash h, (SELECT doc FROM content WHERE content.hash = documents.hash) body FROM documents WHERE id = ?`)
      .get(t.plainId) as { id: number; p: string; h: string; body: string | null } | null;
    const sess = t.hasMarkedSession
      ? db.prepare(`SELECT hex(session_id) s, hex(handoff_path) h FROM session_log WHERE hex(session_id) = ?`).get(hexOf(t.markedSession)) as { s: string; h: string } | null
      : null;
    return JSON.stringify({ marked: d, plain: p, session: sess });
  } finally { db.close(); }
}

export function expectedIdentity(t: TwinVault): string {
  return JSON.stringify({
    marked: { id: t.markedId, p: hexOf(t.markedPath), c: hexOf("notes"), h: t.markedHash, body: BODY_MARKED },
    plain: { id: t.plainId, p: hexOf("a.md"), h: t.plainHash, body: BODY_PLAIN },
    session: t.hasMarkedSession ? { s: hexOf(t.markedSession), h: hexOf(t.markedHandoff) } : null,
  });
}

/**
 * Twin confusion in a reply: a piece of the reply that names `a.md` (no mark) beside anything of the marked twin —
 * its body, its title or its docid (`#` + the first six of its hash) — or the marked path beside anything of the
 * plain twin. A piece is an object of the structured reply, or a line / blank-line block of its text.
 */
export function twinConfusion(reply: unknown, t: Pick<TwinVault, "mark" | "plainHash" | "markedHash">): string[] {
  const found: string[] = [];
  const mark = t.mark;
  const ofMarked = ["MARKEDTWIN", "Marked twin", "#" + t.markedHash.slice(0, 6), t.markedHash];
  const ofPlain = ["PLAINTWIN", "Plain twin", "#" + t.plainHash.slice(0, 6), t.plainHash];
  const check = (piece: string, where: string) => {
    const marked = piece.includes(mark + "a.md");
    const plain = piece.replaceAll(mark + "a.md", "").includes("a.md");
    if (plain && !marked && ofMarked.some(x => piece.includes(x))) found.push(`${where}: a.md with the marked twin's ${ofMarked.find(x => piece.includes(x))}`);
    if (marked && !plain && ofPlain.some(x => piece.includes(x))) found.push(`${where}: the marked path with the plain twin's ${ofPlain.find(x => piece.includes(x))}`);
  };
  const walk = (v: unknown, where: string) => {
    if (typeof v === "string") {
      for (const block of v.split(/\n\s*\n/)) { check(block, where); for (const line of block.split("\n")) check(line, where); }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === "object") {
      const strings = Object.values(v).filter(x => typeof x === "string").join("\n");
      check(strings, where);
      for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    }
  };
  walk(reply, "reply");
  return found;
}
