/**
 * ClawMem Store - Core data access and retrieval functions
 *
 * Forked from QMD store with SAME agent memory extensions:
 * - Extended documents table (domain, workstream, tags, content_type, confidence, access_count)
 * - Session tracking (session_log table)
 * - Context usage tracking (context_usage table)
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
 */

import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { realpathSync, existsSync } from "node:fs";
import * as sqliteVec from "sqlite-vec";
import {
  LlamaCpp,
  getDefaultLlamaCpp,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  sanitizeExpandedQueries,
  expansionFallback,
  isFallbackExpansion,
  type RerankDocument,
} from "./llm.ts";
import { normalizeIsoTimestamp } from "./normalize.ts";
import {
  findContextForPath as collectionsFindContextForPath,
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  listAllContexts as collectionsListAllContexts,
  getCollection,
  listCollections as collectionsListCollections,
  addCollection as collectionsAddCollection,
  renameCollection as collectionsRenameCollection,
  setGlobalContext,
  loadConfig as collectionsLoadConfig,
  type NamedCollection,
} from "./collections.ts";
import { getVaultPath } from "./config.ts";
import {
  queryBeadsList,
  formatBeadsIssueAsMarkdown,
  detectBeadsProject,
  type BeadsIssue,
} from "./beads.ts";
import {
  constructMemoryNote,
  storeMemoryNote,
  generateMemoryLinks,
  evolveMemories,
  postIndexEnrich,
  type EnrichOutcome,
} from "./amem.ts";
import { parseLegacyEdgeWitness } from "./causal-reader.ts";
import {
  enrichDocumentEntities,
  searchEntities,
  getEntityGraphNeighbors,
} from "./entity.ts";

// =============================================================================
// Configuration
// =============================================================================

const HOME = Bun.env.HOME || "/tmp";
export const DEFAULT_EMBED_MODEL = "granite";
export const DEFAULT_RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-q8_0";
export const DEFAULT_QUERY_MODEL = "tobil/qmd-query-expansion-1.7B";
export const DEFAULT_GLOB = "**/*.md";
export const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024; // 10KB

// Chunking: 800 tokens per chunk with 15% overlap
export const CHUNK_SIZE_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = Math.floor(CHUNK_SIZE_TOKENS * 0.15);  // 120 tokens (15% overlap)
// Fallback char-based approximation for sync chunking (~4 chars per token)
export const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * 4;  // 3200 chars
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4;  // 480 chars

// =============================================================================
// Path utilities
// =============================================================================

export function homedir(): string {
  return HOME;
}

export function resolve(...paths: string[]): string {
  if (paths.length === 0) {
    throw new Error("resolve: at least one path segment is required");
  }
  let result = paths[0]!.startsWith('/') ? '' : Bun.env.PWD || process.cwd();
  for (const p of paths) {
    if (p.startsWith('/')) {
      result = p;
    } else {
      result = result + '/' + p;
    }
  }
  const parts = result.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') normalized.pop();
    else if (part !== '.') normalized.push(part);
  }
  return '/' + normalized.join('/');
}

// Flag to indicate production mode (set by qmd.ts at startup)
let _productionMode = false;

export function enableProductionMode(): void {
  _productionMode = true;
}

export function getDefaultDbPath(indexName: string = "index"): string {
  // Always allow override via INDEX_PATH (for testing)
  if (Bun.env.INDEX_PATH) {
    return Bun.env.INDEX_PATH;
  }

  // In non-production mode (tests), require explicit path
  if (!_productionMode) {
    throw new Error(
      "Database path not set. Tests must set INDEX_PATH env var or use createStore() with explicit path. " +
      "This prevents tests from accidentally writing to the global index."
    );
  }

  const cacheDir = Bun.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const clawmemCacheDir = resolve(cacheDir, "clawmem");
  try { Bun.spawnSync(["mkdir", "-p", clawmemCacheDir]); } catch { }
  return resolve(clawmemCacheDir, `${indexName}.sqlite`);
}

export function getPwd(): string {
  return process.env.PWD || process.cwd();
}

export function getRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// =============================================================================
// Virtual Path Utilities (clawmem://)
// =============================================================================

export type VirtualPath = {
  collectionName: string;
  path: string;  // relative path within collection
};

/**
 * Normalize explicit virtual path formats to standard clawmem:// format.
 * Only handles paths that are already explicitly virtual:
 * - clawmem://collection/path.md (already normalized)
 * - clawmem:////collection/path.md (extra slashes - normalize)
 * - //collection/path.md (missing clawmem: prefix - add it)
 *
 * Does NOT handle:
 * - collection/path.md (bare paths - could be filesystem relative)
 * - :linenum suffix (should be parsed separately before calling this)
 */
export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  // Handle clawmem:// with extra slashes: clawmem:////collection/path -> clawmem://collection/path
  if (path.startsWith('clawmem:')) {
    // Remove clawmem: prefix and normalize slashes
    // "clawmem:".length === 8
    path = path.slice(8);
    // Remove leading slashes and re-add exactly two
    path = path.replace(/^\/+/, '');
    // Collapse any internal multiple slashes to single
    path = path.replace(/\/\/+/g, '/');
    return `clawmem://${path}`;
  }

  // Handle //collection/path (missing clawmem: prefix)
  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `clawmem://${path}`;
  }

  // Return as-is for other cases (filesystem paths, docids, bare collection/path, etc.)
  return path;
}

/**
 * Parse a virtual path like "clawmem://collection-name/path/to/file.md"
 * into its components.
 * Also supports collection root: "clawmem://collection-name/" or "clawmem://collection-name"
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  // Normalize the path first
  const normalized = normalizeVirtualPath(virtualPath);

  // Match: clawmem://collection-name[/optional-path]
  // Allows: clawmem://name, clawmem://name/, clawmem://name/path
  const match = normalized.match(/^clawmem:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  return {
    collectionName: match[1],
    path: match[2] ?? '',  // Empty string for collection root
  };
}

/**
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string): string {
  return `clawmem://${collectionName}/${path}`;
}

/**
 * Check if a path is explicitly a virtual path.
 * Only recognizes explicit virtual path formats:
 * - clawmem://collection/path.md
 * - //collection/path.md
 *
 * Does NOT consider bare collection/path.md as virtual - that should be
 * handled separately by checking if the first component is a collection name.
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  // Explicit clawmem:// prefix (with any number of slashes)
  if (trimmed.startsWith('clawmem:')) return true;

  // //collection/path format (missing clawmem: prefix)
  if (trimmed.startsWith('//')) return true;

  return false;
}

/**
 * Resolve a virtual path to absolute filesystem path.
 */
export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getCollectionByName(db, parsed.collectionName);
  if (!coll) return null;

  return resolve(coll.pwd, parsed.path);
}

/**
 * Convert an absolute filesystem path to a virtual path.
 * Returns null if the file is not in any indexed collection.
 */
export function toVirtualPath(db: Database, absolutePath: string): string | null {
  // Get all collections from YAML config
  const collections = collectionsListCollections();

  // Find which collection this absolute path belongs to
  for (const coll of collections) {
    if (absolutePath.startsWith(coll.path + '/') || absolutePath === coll.path) {
      // Extract relative path
      const relativePath = absolutePath.startsWith(coll.path + '/')
        ? absolutePath.slice(coll.path.length + 1)
        : '';

      // Verify this document exists in the database
      const doc = db.prepare(`
        SELECT d.path
        FROM documents d
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
        LIMIT 1
      `).get(coll.name, relativePath) as { path: string } | null;

      if (doc) {
        return buildVirtualPath(coll.name, relativePath);
      }
    }
  }

  return null;
}

// =============================================================================
// Database initialization
// =============================================================================

// On macOS, Apple's built-in libsqlite3 — which Bun uses by default — is
// compiled WITHOUT extension-loading support, so sqliteVec.load() fails with
// "This build of sqlite3 does not support dynamic extension loading" (Issue #20).
// Point Bun at an extension-capable SQLite (Homebrew's) via setCustomSQLite()
// BEFORE the first Database is opened. setCustomSQLite() must receive a path
// that EXISTS — an invalid path hard-crashes Bun (oven-sh/bun#18811) — so every
// candidate is existence-checked first. The resolved path (or null) is recorded
// so loadVecExtension() can emit an actionable error when no extension-capable
// SQLite is installed, instead of the cryptic extension-loading failure.

/** macOS only: the extension-capable SQLite activated via setCustomSQLite, or null if none was found. */
let macosCustomSqlitePath: string | null = null;

if (process.platform === "darwin") {
  const candidates = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Homebrew (Apple Silicon)
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",    // Homebrew (Intel)
  ];
  // For a non-standard Homebrew prefix, ask brew directly — but only when the
  // standard paths are absent, so the common case pays no subprocess cost.
  if (!candidates.some(p => existsSync(p))) {
    try {
      const brew = Bun.spawnSync(["brew", "--prefix", "sqlite"], { stdout: "pipe", stderr: "ignore" });
      const prefix = brew.success ? brew.stdout.toString().trim() : "";
      if (prefix) candidates.push(`${prefix}/lib/libsqlite3.dylib`);
    } catch { /* brew not installed — nothing more to probe */ }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      Database.setCustomSQLite(candidate);
      macosCustomSqlitePath = candidate;
      break;
    } catch { /* not usable — try the next candidate */ }
  }
}

/**
 * Translate a sqlite-vec load failure into an actionable error on macOS, where
 * the default system SQLite cannot load extensions (Issue #20). Pure + exported
 * for tests: pass `platform` / `foundPath` explicitly to exercise either branch.
 * Non-macOS, or any unrelated error, is returned unchanged.
 */
export function explainVecLoadError(
  err: unknown,
  platform: string = process.platform,
  foundPath: string | null = macosCustomSqlitePath,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const isExtensionError = /does not support dynamic extension loading/i.test(original.message);
  if (platform !== "darwin" || !isExtensionError) return original;

  const detail = foundPath === null
    ? "No Homebrew SQLite was found at the standard locations (/opt/homebrew or /usr/local)."
    : `A custom SQLite was set from ${foundPath}, but it still cannot load extensions — try 'brew reinstall sqlite'.`;
  return new Error(
    "ClawMem could not load the sqlite-vec extension: macOS's built-in SQLite is " +
    "compiled without extension support.\n" +
    "Fix: install an extension-capable SQLite with Homebrew, then re-run:\n" +
    "    brew install sqlite\n" +
    `${detail}\n` +
    "More detail: docs/troubleshooting.md (\"Bun runtime\" -> sqlite-vec on macOS), Yoloshii/ClawMem#20.\n" +
    `Original error: ${original.message}`,
  );
}

/** Load the sqlite-vec extension, surfacing an actionable error on macOS (Issue #20). */
function loadVecExtension(db: Database): void {
  try {
    sqliteVec.load(db);
  } catch (err) {
    throw explainVecLoadError(err);
  }
}

function initializeDatabase(db: Database, busyTimeoutMs: number = 15000): void {
  // Set busy_timeout FIRST so subsequent PRAGMAs (journal_mode in particular,
  // which acquires a write lock when switching or initializing WAL state) wait
  // instead of returning SQLITE_BUSY when concurrent Stop hooks
  // (decision-extractor, handoff-generator, feedback-loop) — and the parallel
  // before_reset hook fan-out in src/openclaw/engine.ts — open the DB
  // simultaneously. busy_timeout is a connection-level setting that only
  // governs *subsequent* statements (default busy handler is NULL → SQLITE_BUSY
  // returns immediately), so it must precede the contending PRAGMAs. The init
  // busy_timeout defaults to 15s (well within the 30s Stop hook timeout) but is
  // capped to the caller's opts.busyTimeout — hook opens pass 5000 so init cannot
  // wait out the 8-15s UserPromptSubmit budget. createStore() resets to operational
  // value (5000ms or opts.busyTimeout) after DDL completes. Issue #13.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  loadVecExtension(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Extended with SAME agent memory metadata columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      domain TEXT,
      workstream TEXT,
      tags TEXT,
      content_type TEXT NOT NULL DEFAULT 'note',
      review_by TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      origin TEXT,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  // Migration: add SAME columns to existing databases
  const docCols = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
  const colNames = new Set(docCols.map(c => c.name));
  const migrations: [string, string][] = [
    ["domain", "ALTER TABLE documents ADD COLUMN domain TEXT"],
    ["workstream", "ALTER TABLE documents ADD COLUMN workstream TEXT"],
    ["tags", "ALTER TABLE documents ADD COLUMN tags TEXT"],
    ["content_type", "ALTER TABLE documents ADD COLUMN content_type TEXT NOT NULL DEFAULT 'note'"],
    ["review_by", "ALTER TABLE documents ADD COLUMN review_by TEXT"],
    ["confidence", "ALTER TABLE documents ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5"],
    ["access_count", "ALTER TABLE documents ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0"],
    ["content_hash", "ALTER TABLE documents ADD COLUMN content_hash TEXT"],
    ["quality_score", "ALTER TABLE documents ADD COLUMN quality_score REAL NOT NULL DEFAULT 0.5"],
    ["pinned", "ALTER TABLE documents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"],
    ["snoozed_until", "ALTER TABLE documents ADD COLUMN snoozed_until TEXT"],
    ["last_accessed_at", "ALTER TABLE documents ADD COLUMN last_accessed_at TEXT"],
    ["archived_at", "ALTER TABLE documents ADD COLUMN archived_at TEXT"],
    ["memory_type", "ALTER TABLE documents ADD COLUMN memory_type TEXT DEFAULT 'semantic'"],
    // Engram integration: dedup + topic key columns
    ["normalized_hash", "ALTER TABLE documents ADD COLUMN normalized_hash TEXT"],
    ["duplicate_count", "ALTER TABLE documents ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 1"],
    ["last_seen_at", "ALTER TABLE documents ADD COLUMN last_seen_at TEXT"],
    ["topic_key", "ALTER TABLE documents ADD COLUMN topic_key TEXT"],
    ["revision_count", "ALTER TABLE documents ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 1"],
    ["authored_at", "ALTER TABLE documents ADD COLUMN authored_at TEXT"],
    // §55.6 D9: WHY a row was deactivated. `active` is written by three unrelated owners —
    // absence reconciliation, forget, and archival — and the indexer used to reactivate all
    // three indiscriminately, so a forget on a file-backed document was silently undone by
    // the next reindex. NULL = legacy row (pre-migration), treated as 'absent'.
    ["deactivated_reason", "ALTER TABLE documents ADD COLUMN deactivated_reason TEXT"],
    // Origin-aware reconciliation: WHO owns the row's lifecycle. 'fs' = created/maintained
    // by the filesystem indexer (reconciled against disk); 'api' = DB-born (hooks,
    // saveMemory, beads sync, REST) — these have no backing file BY DESIGN, so the absence
    // reconciler must never deactivate them. NULL = ambiguous legacy row; exempt, adopted by
    // the next writer to TOUCH it (indexer → 'fs', saveMemory → 'api'), never inferred —
    // content_hash proves nothing about ownership (mined imports write it too).
    ["origin", "ALTER TABLE documents ADD COLUMN origin TEXT"],
  ];
  for (const [col, sql] of migrations) {
    if (!colNames.has(col)) {
      try { db.exec(sql); } catch { /* column may already exist */ }
    }
  }

  // The loop above swallows every ALTER error, so a real failure (SQLITE_BUSY, disk) is
  // indistinguishable from "already there" — and the follow-up query would then raise
  // `no such column`, which the handler below treats as benign. Check explicitly instead,
  // or a genuinely failed migration ships as silence.
  const hasDeactivationReason = (
    db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]
  ).some(c => c.name === "deactivated_reason");
  if (!hasDeactivationReason) {
    console.warn(
      `[clawmem] could not add the deactivated_reason column on this open. Forget and archival ` +
      `remain reversible by indexing until it succeeds; it is retried on the next open.`,
    );
  }

  // §55.6 D9 migration. Both halves are read-guarded so an already-migrated DB takes NO
  // write lock here (same reason as the last_accessed_at backfill below).
  try {
    if (!hasDeactivationReason) throw new Error("deactivated_reason column absent");
    // (a) Backfill provenance for rows archival already marked. Legacy rows deactivated by
    //     forget are indistinguishable from absence at this point, so they stay NULL and keep
    //     today's reactivate-on-return behaviour rather than being stranded — from here
    //     forward, forget is durable.
    const needsReasonBackfill = db.prepare(
      `SELECT 1 FROM documents WHERE active = 0 AND archived_at IS NOT NULL AND deactivated_reason IS NULL LIMIT 1`
    ).get();
    if (needsReasonBackfill) {
      db.exec(`UPDATE documents SET deactivated_reason = 'archive' WHERE active = 0 AND archived_at IS NOT NULL AND deactivated_reason IS NULL`);
    }
    // (b) REPAIR, not merely prevent: released versions could reactivate an archived row while
    //     leaving archived_at set — an internally inconsistent state with no legitimate meaning.
    //     Restore those to a consistent archived state and report, since silently re-archiving
    //     rows a user may have been reading would be its own surprise.
    //
    //     Count and update run in ONE transaction: two processes opening the store concurrently
    //     would otherwise both read the same count while only one performed the repair, and the
    //     loser would report a repair it did not make.
    const repaired = db.transaction(() => {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM documents WHERE active = 1 AND archived_at IS NOT NULL`
      ).get() as { n: number } | undefined;
      const n = row?.n ?? 0;
      if (n > 0) {
        db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'archive' WHERE active = 1 AND archived_at IS NOT NULL`).run();
      }
      return n;
    })();
    if (repaired > 0) {
      console.warn(
        `[clawmem] repaired ${repaired} archived document(s) that a previous reindex had ` +
        `reactivated while still marked archived. Use lifecycle_restore to bring any of them back.`,
      );
    }
  } catch (err) {
    // Do NOT fail open silently. A read-only handle or a pre-migration schema is expected and
    // benign; anything else (SQLITE_BUSY, a genuine SQL fault) means this process is running
    // WITHOUT the migration, and the user needs to know rather than discovering it as behaviour.
    const msg = err instanceof Error ? err.message : String(err);
    // A missing column is NOT benign here — it is already reported above with its own message,
    // so absorbing it a second time would double-report; anything else that is not a read-only
    // handle or a pre-migration table is a real failure the user must see.
    const alreadyReported = /deactivated_reason column absent/.test(msg);
    const benign = alreadyReported || /readonly|read-only|no such table/i.test(msg);
    if (!benign) {
      console.warn(
        `[clawmem] deactivation-provenance migration did not run on this open (${msg}). ` +
        `Forget/archive may still be reversible by indexing until it succeeds; it is retried on ` +
        `the next open.`,
      );
    }
  }

  // Backfill last_accessed_at from modified_at for existing docs.
  // Guarded by a read first: on an already-backfilled DB the UPDATE is skipped, so a writable
  // open takes NO write lock here and cannot wait on busy_timeout under concurrent writers.
  // (The unconditional UPDATE previously ran on EVERY writable open — including the
  // context-surfacing UserPromptSubmit hook — and could block up to busy_timeout when another
  // process held the write lock, pushing the hook past its 8-15s deadline.)
  try {
    const needsBackfill = db.prepare(`SELECT 1 FROM documents WHERE last_accessed_at IS NULL LIMIT 1`).get();
    if (needsBackfill) {
      db.exec(`UPDATE documents SET last_accessed_at = modified_at WHERE last_accessed_at IS NULL`);
    }
  } catch { /* ignore if already backfilled */ }

  // Origin migration verification. Verified explicitly like deactivated_reason above: the
  // migration loop swallows ALTER errors, and reconciliation semantics must never silently
  // depend on a column that never arrived. There is deliberately NO content_hash-based
  // backfill: mined imports (`clawmem mine`) also write content_hash through the indexing
  // pipeline, so its presence proves nothing about ownership — a backfill would mis-stamp
  // DB-born imports as 'fs' (1,353 such rows measured in one live vault). Legacy rows stay
  // NULL (exempt) and are adopted by the next writer to TOUCH them: the indexer stamps its
  // origin on every path including unchanged files; saveMemory stamps 'api'.
  const hasOrigin = (
    db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]
  ).some(c => c.name === "origin");
  if (!hasOrigin) {
    console.warn(
      `[clawmem] could not add the origin column on this open. Filesystem-absence ` +
      `reconciliation is disabled until it succeeds; it is retried on the next open.`,
    );
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);

  // Engram integration: indexes for dedup, topic key, timeline
  // Re-check columns after migration (handles concurrent processes where ALTER TABLE
  // may race with PRAGMA table_info snapshot taken earlier)
  const postMigrationCols = new Set(
    (db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map(c => c.name)
  );
  if (postMigrationCols.has("normalized_hash")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_dedup ON documents(collection, content_type, normalized_hash, created_at DESC) WHERE active = 1 AND normalized_hash IS NOT NULL`);
  }
  if (postMigrationCols.has("topic_key")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_topic_key ON documents(topic_key, collection) WHERE active = 1 AND topic_key IS NOT NULL`);
  }
  // Timeline indexes use existing columns (modified_at, id) — always safe
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_timeline ON documents(modified_at, id) WHERE active = 1`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_timeline_coll ON documents(collection, modified_at, id) WHERE active = 1`);
  // §51.1: temporal predicates filter on effective time (authorship when known, filing time otherwise)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_effective_time ON documents(COALESCE(authored_at, modified_at)) WHERE active = 1`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.exec(`DROP TABLE IF EXISTS content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Geometry-canary baseline (VSEARCH-TRUST-HARDENING (d)): per-profile probe vectors +
  // measured pair-margins from the last healthy embed run. NOT content_vectors — canary
  // probes must never pollute retrieval.
  db.exec(`
    CREATE TABLE IF NOT EXISTS embed_canary (
      probe_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      embedding BLOB NOT NULL,
      pair_margins TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (probe_id, profile_key)
    )
  `);

  // Durable vault health flags (T8-M1): e.g. embed_geometry_taint — a detected mid-run
  // geometry change must survive the process so doctor stays nonzero until a verified
  // full rebuild clears it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_flags (
      flag TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  // SAME: Session tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_log (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      handoff_path TEXT,
      machine TEXT,
      files_changed TEXT,
      summary TEXT
    )
  `);

  // SAME: Context usage tracking (feedback loop)
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      hook_name TEXT NOT NULL,
      injected_paths TEXT NOT NULL DEFAULT '[]',
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      was_referenced INTEGER NOT NULL DEFAULT 0,
      turn_index INTEGER NOT NULL DEFAULT 0,
      query_text TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_context_usage_session ON context_usage(session_id)`);

  // Migration: add turn_index to existing context_usage
  let cuCols = db.prepare("PRAGMA table_info(context_usage)").all() as { name: string }[];
  if (!cuCols.some(c => c.name === "turn_index")) {
    try { db.exec(`ALTER TABLE context_usage ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
    cuCols = db.prepare("PRAGMA table_info(context_usage)").all() as { name: string }[];
  }

  // v0.8.1 Ext 6b: add nullable query_text column to existing context_usage
  // so multi-turn lookback can persist the raw prompt alongside turn_index.
  // The column is nullable and defaults to NULL — pre-migration rows are
  // treated as "no prior query" by buildMultiTurnSurfacingQuery, preserving
  // the current-prompt-only fallback for any session that predates v0.8.1.
  if (!cuCols.some(c => c.name === "query_text")) {
    try { db.exec(`ALTER TABLE context_usage ADD COLUMN query_text TEXT`); } catch { /* exists */ }
  }
  // Cache the column presence for insertUsageFn so it can build the INSERT
  // statement without running PRAGMA table_info on every write path.
  contextUsageHasQueryTextCache.set(
    db,
    db.prepare("PRAGMA table_info(context_usage)")
      .all()
      .some((c) => (c as { name: string }).name === "query_text"),
  );

  // Hook prompt dedupe: suppress duplicate/heartbeat prompts to reduce GPU churn.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hook_dedupe (
      hook_name TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_preview TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (hook_name, prompt_hash)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hook_dedupe_last_seen ON hook_dedupe(last_seen_at)`);

  // Co-activation tracking: documents accessed together in the same injection
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_activations (
      doc_a TEXT NOT NULL,
      doc_b TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (doc_a, doc_b)
    )
  `);

  // Migration: add fragment columns to content_vectors
  const cvCols = db.prepare("PRAGMA table_info(content_vectors)").all() as { name: string }[];
  const cvColNames = new Set(cvCols.map(c => c.name));
  const cvMigrations: [string, string][] = [
    ["fragment_type", "ALTER TABLE content_vectors ADD COLUMN fragment_type TEXT"],
    ["fragment_label", "ALTER TABLE content_vectors ADD COLUMN fragment_label TEXT"],
    ["canonical_id", "ALTER TABLE content_vectors ADD COLUMN canonical_id TEXT"],
    // Embed-input fingerprint (VSEARCH-TRUST-HARDENING (d).4 / T4-M2): SHA-256 over the
    // UTF-8 bytes of the exact final formatDocForEmbedding(...) string. Rows without it
    // (legacy) are title-unverifiable at doctor time until their next re-embed.
    ["embed_input_fp", "ALTER TABLE content_vectors ADD COLUMN embed_input_fp TEXT"],
  ];
  for (const [col, sql] of cvMigrations) {
    if (!cvColNames.has(col)) {
      try { db.exec(sql); } catch { /* column may already exist */ }
    }
  }

  // Migration: add observation columns to documents
  const obsMigrations: [string, string][] = [
    ["observation_type", "ALTER TABLE documents ADD COLUMN observation_type TEXT"],
    ["facts", "ALTER TABLE documents ADD COLUMN facts TEXT"],
    ["narrative", "ALTER TABLE documents ADD COLUMN narrative TEXT"],
    ["concepts", "ALTER TABLE documents ADD COLUMN concepts TEXT"],
    ["files_read", "ALTER TABLE documents ADD COLUMN files_read TEXT"],
    ["files_modified", "ALTER TABLE documents ADD COLUMN files_modified TEXT"],
    ["skill_name", "ALTER TABLE documents ADD COLUMN skill_name TEXT"],
    ["obs_quality_score", "ALTER TABLE documents ADD COLUMN obs_quality_score REAL"],
    ["failure_reason", "ALTER TABLE documents ADD COLUMN failure_reason TEXT"],
    ["source_doc_ids", "ALTER TABLE documents ADD COLUMN source_doc_ids TEXT"],
    ["embed_state", "ALTER TABLE documents ADD COLUMN embed_state TEXT DEFAULT 'pending'"],
    ["embed_error", "ALTER TABLE documents ADD COLUMN embed_error TEXT"],
    ["embed_attempts", "ALTER TABLE documents ADD COLUMN embed_attempts INTEGER DEFAULT 0"],
  ];
  for (const [col, sql] of obsMigrations) {
    if (!colNames.has(col)) {
      try { db.exec(sql); } catch { /* column may already exist */ }
    }
  }

  // Centralize the embed-lifecycle reset on content change: ANY path that updates
  // documents.hash (updateDocument, reactivateDocument, indexer reactivation,
  // decision/antipattern merges, saveMemory, beads sync, …) gets the doc's embed
  // state reset, so the new content is re-embedded with a fresh retry budget and is
  // never excluded by the OLD content's exhausted embed_attempts. One trigger covers
  // every caller (codex HIGH, INCIDENT-2026-06-22). It fires only on an actual change
  // (`IS NOT` is null-safe) and does not touch hash, so it cannot recurse. Created
  // right after the embed_* column migrations above, so the columns it references
  // exist. NOT wrapped in try/catch: a creation failure means this load-bearing
  // reset is silently absent, so let it surface loudly rather than hide a footgun.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS reset_embed_on_hash_change
    AFTER UPDATE OF hash ON documents
    FOR EACH ROW WHEN OLD.hash IS NOT NEW.hash
    BEGIN
      UPDATE documents SET embed_state = 'pending', embed_attempts = 0, embed_error = NULL WHERE id = NEW.id;
    END;
  `);

  // Migration: add A-MEM columns to documents
  const amemMigrations: [string, string][] = [
    ["amem_keywords", "ALTER TABLE documents ADD COLUMN amem_keywords TEXT"],
    ["amem_tags", "ALTER TABLE documents ADD COLUMN amem_tags TEXT"],
    ["amem_context", "ALTER TABLE documents ADD COLUMN amem_context TEXT"],
  ];
  for (const [col, sql] of amemMigrations) {
    if (!colNames.has(col)) {
      try { db.exec(sql); } catch { /* column may already exist */ }
    }
  }

  // Migration: observation invalidation columns (Pattern I)
  const invalidationMigrations: [string, string][] = [
    ["invalidated_at", "ALTER TABLE documents ADD COLUMN invalidated_at TEXT"],
    ["invalidated_by", "ALTER TABLE documents ADD COLUMN invalidated_by INTEGER"],
    ["superseded_by", "ALTER TABLE documents ADD COLUMN superseded_by INTEGER"],
  ];
  for (const [col, sql] of invalidationMigrations) {
    if (!colNames.has(col)) {
      try { db.exec(sql); } catch { /* column may already exist */ }
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_invalidated ON documents(invalidated_at) WHERE invalidated_at IS NOT NULL`);

  // Beads integration tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS beads_issues (
      beads_id TEXT PRIMARY KEY,
      doc_id INTEGER,
      issue_type TEXT,
      status TEXT,
      priority INTEGER,
      tags TEXT,
      assignee TEXT,
      parent_id TEXT,
      created_at TEXT,
      closed_at TEXT,
      last_synced_at TEXT,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_beads_status ON beads_issues(status, priority)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_beads_parent ON beads_issues(parent_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS beads_dependencies (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      dep_type TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY (source_id, target_id, dep_type),
      FOREIGN KEY (source_id) REFERENCES beads_issues(beads_id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES beads_issues(beads_id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_beads_deps_target ON beads_dependencies(target_id, dep_type)`);

  // MAGMA: Multi-graph relational memory
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      metadata TEXT,
      created_at TEXT,
      PRIMARY KEY (source_id, target_id, relation_type),
      FOREIGN KEY (source_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_id, relation_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_id, relation_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_weight ON memory_relations(weight DESC) WHERE weight > 0.5`);
  // MPFP composite index for efficient neighbor loading (GPT 5.4 recommendation)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_mpfp ON memory_relations(source_id, relation_type, weight DESC, target_id)`);

  // s342 causal writer (C4′): per-invocation audit runs. run_key is UNIQUE NOT
  // NULL so a key collision fails loudly BEFORE inference results are written.
  db.exec(`
    CREATE TABLE IF NOT EXISTS causal_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_key TEXT NOT NULL UNIQUE,
      session_id TEXT,
      source TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT,
      prompt_version TEXT,
      prompt_sha256 TEXT,
      response_sha256 TEXT,
      outcome TEXT NOT NULL,
      new_doc_count INTEGER NOT NULL DEFAULT 0,
      window_doc_count INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      admitted_count INTEGER NOT NULL DEFAULT 0,
      edges_written INTEGER NOT NULL DEFAULT 0,
      edges_refused INTEGER NOT NULL DEFAULT 0,
      edges_errored INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_causal_runs_ts ON causal_runs(started_at DESC, id DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS causal_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES causal_runs(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('document','pair','write')),
      event_type TEXT NOT NULL,
      source_doc_id INTEGER,
      target_doc_id INTEGER,
      source_fact_ordinal INTEGER,
      target_fact_ordinal INTEGER,
      confidence REAL,
      detail TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_causal_run_events_run ON causal_run_events(run_id, id)`);

  // s342: append-only fact-pair witness sightings on causal edges. Identity is
  // the ORDINAL pair (facts are display snapshots); a live row must carry
  // visible evidence + full attribution; legacy rows (ordinals = -1) keep their
  // explicitly different compatibility contract. Witnesses are dependent
  // evidence of the edge — the composite FK cascades with it, never a second
  // lifecycle identity. Audit retention deletes runs only: run_id detaches via
  // SET NULL while denormalized model/prompt/run_key attribution survives.
  db.exec(`
    CREATE TABLE IF NOT EXISTS causal_witness_sightings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'causal' CHECK (relation_type = 'causal'),
      source_fact_ordinal INTEGER NOT NULL,
      target_fact_ordinal INTEGER NOT NULL,
      source_fact TEXT,
      target_fact TEXT,
      reasoning TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
      model_identity TEXT NOT NULL DEFAULT '',
      prompt_version TEXT NOT NULL DEFAULT '',
      run_key TEXT NOT NULL,
      run_id INTEGER REFERENCES causal_runs(id) ON DELETE SET NULL,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      CHECK ((legacy = 0 AND source_fact_ordinal >= 0 AND target_fact_ordinal >= 0)
          OR (legacy = 1 AND source_fact_ordinal = -1 AND target_fact_ordinal = -1)),
      CHECK (legacy = 1 OR (length(COALESCE(source_fact,'')) > 0
                        AND length(COALESCE(target_fact,'')) > 0
                        AND length(reasoning) > 0
                        AND length(model_identity) > 0
                        AND length(prompt_version) > 0
                        AND length(run_key) > 0)),
      FOREIGN KEY (source_id, target_id, relation_type)
        REFERENCES memory_relations(source_id, target_id, relation_type) ON DELETE CASCADE
    )
  `);
  // ONE live sighting per (edge, ordinal pair, invocation); recurrence across
  // runs APPENDS under its own run_key. Plain columns — a valid targeted
  // ON CONFLICT target for the partial-index upsert.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cws_live ON causal_witness_sightings
    (source_id, target_id, source_fact_ordinal, target_fact_ordinal, run_key)
    WHERE legacy = 0`);
  // EXACTLY ONE legacy row per physical edge — repeated materialization throws.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cws_one_legacy ON causal_witness_sightings
    (source_id, target_id) WHERE legacy = 1`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cws_edge ON causal_witness_sightings
    (source_id, target_id, confidence DESC, created_at DESC, id DESC)`);

  // s342: NON-PRUNED archive for operator-retired causal edges — the supported,
  // reversible restoration path (`clawmem migrate causal-witnesses --restore-edge`).
  // Full row image, no FKs: the archive must survive everything, including audit
  // retention. An archive table (vs a retired_at column) keeps every existing
  // graph reader predicate unchanged.
  db.exec(`
    CREATE TABLE IF NOT EXISTS retired_causal_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL,
      metadata TEXT,
      created_at TEXT,
      contradict_confidence REAL,
      retired_at TEXT NOT NULL,
      retired_run_key TEXT NOT NULL,
      operator_note TEXT,
      fingerprint TEXT NOT NULL
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_retired_causal_edge ON retired_causal_edges
    (source_id, target_id, relation_type)`);

  // A-MEM: Memory evolution tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_evolution (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      triggered_by INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      previous_keywords TEXT,
      new_keywords TEXT,
      previous_context TEXT,
      new_context TEXT,
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (memory_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (triggered_by) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_evolution_memory_id ON memory_evolution(memory_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_evolution_triggered_by ON memory_evolution(triggered_by)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_evolution_created_at ON memory_evolution(created_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_nodes (
      entity_id TEXT PRIMARY KEY,
      entity_type TEXT,
      name TEXT,
      description TEXT,
      created_at TEXT,
      mention_count INTEGER DEFAULT 0,
      last_seen TEXT,
      canonical_id TEXT,
      vault TEXT DEFAULT 'default'
    )
  `);

  // Migrate existing entity_nodes tables (add new columns if missing)
  try { db.exec(`ALTER TABLE entity_nodes ADD COLUMN mention_count INTEGER DEFAULT 0`); } catch { /* column exists */ }
  try { db.exec(`ALTER TABLE entity_nodes ADD COLUMN last_seen TEXT`); } catch { /* column exists */ }
  try { db.exec(`ALTER TABLE entity_nodes ADD COLUMN canonical_id TEXT`); } catch { /* column exists */ }
  try { db.exec(`ALTER TABLE entity_nodes ADD COLUMN vault TEXT DEFAULT 'default'`); } catch { /* column exists */ }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_type ON entity_nodes(entity_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_vault ON entity_nodes(vault)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_mentions ON entity_nodes(mention_count DESC)`);
  // §11.1 (v0.9.0): expression index backing the `LOWER(name) IN (...) AND vault = ?`
  // batch lookup used by the context-surfacing entity-detection hot path.
  // Without this index the batch query devolves into a full scan on large vaults.
  // Idempotent via IF NOT EXISTS — existing vaults pick it up on next open.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_lower_name ON entity_nodes(LOWER(name), vault)`);

  // Entity mentions: entity ↔ document junction table
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_mentions (
      entity_id TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      mention_text TEXT,
      created_at TEXT,
      PRIMARY KEY (entity_id, doc_id),
      FOREIGN KEY (entity_id) REFERENCES entity_nodes(entity_id) ON DELETE CASCADE,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_mentions_doc ON entity_mentions(doc_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id)`);

  // Entity co-occurrences: pairs of entities appearing in the same document
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_cooccurrences (
      entity_a TEXT NOT NULL,
      entity_b TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      last_cooccurred TEXT,
      PRIMARY KEY (entity_a, entity_b)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_cooccurrences_a ON entity_cooccurrences(entity_a)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_cooccurrences_b ON entity_cooccurrences(entity_b)`);

  // SPO knowledge graph: temporal entity-relationship triples
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_triples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_entity_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_entity_id TEXT,
      object_literal TEXT,
      valid_from TEXT,
      valid_to TEXT,
      confidence REAL DEFAULT 1.0,
      source_doc_id INTEGER,
      source_fact TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (subject_entity_id) REFERENCES entity_nodes(entity_id),
      FOREIGN KEY (object_entity_id) REFERENCES entity_nodes(entity_id),
      FOREIGN KEY (source_doc_id) REFERENCES documents(id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_triples_subject ON entity_triples(subject_entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_triples_object ON entity_triples(object_entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_triples_predicate ON entity_triples(predicate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_triples_valid ON entity_triples(valid_from, valid_to)`);

  // Cross-agent fact witness columns (v0.38.0, cross-agent memory PR).
  // A fact written by an agent carries explicit attribution (WHO wrote it, from
  // WHICH session, HOW it was observed, WHEN) so other agents can weigh its
  // trustworthiness. `tags` is a JSON array of free-form labels. Migrations are
  // idempotent via try/catch so existing vaults pick the columns up on next open.
  for (const col of ["agent_id", "session_id", "source_type", "written_at", "tags"]) {
    try { db.exec(`ALTER TABLE entity_triples ADD COLUMN ${col} TEXT`); } catch { /* column exists */ }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_triples_written_at ON entity_triples(written_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_triples_agent ON entity_triples(agent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_triples_session ON entity_triples(session_id)`);


  // Per-source evidence for SPO triples (v0.32.0). One row per distinct
  // (triple, source_doc, source_fact) — the base row's inline source_doc_id/source_fact stay
  // frozen as the first sighting. Uniqueness is null-normalized: a plain UNIQUE treats NULLs as
  // distinct, which would let unattributed evidence duplicate unboundedly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_triple_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      triple_id INTEGER NOT NULL REFERENCES entity_triples(id),
      source_doc_id INTEGER REFERENCES documents(id),
      source_fact TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_etp_evidence ON entity_triple_provenance
    (triple_id, COALESCE(source_doc_id, -1), COALESCE(source_fact, ''))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_etp_triple_recent ON entity_triple_provenance
    (triple_id, created_at DESC, id DESC)`);
  // Idempotent backfill, READ-GUARDED (v0.16.0 discipline: a writable open on a healthy DB
  // must not wait on busy_timeout) — the INSERT runs only when at least one triple still lacks
  // a provenance row, so steady-state opens perform zero writes here. EVERY legacy triple gets
  // a row: one whose inline evidence is entirely NULL gets a single unattributed row (the
  // null-normalized unique index caps it at one), so evidenceCount is honest for legacy facts.
  const needsEvidenceBackfill = db.prepare(`
    SELECT 1 FROM entity_triples t
    WHERE NOT EXISTS (SELECT 1 FROM entity_triple_provenance p WHERE p.triple_id = t.id)
    LIMIT 1
  `).get();
  if (needsEvidenceBackfill) {
    db.exec(`
      INSERT OR IGNORE INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at)
      SELECT id, source_doc_id, source_fact, COALESCE(created_at, datetime('now'))
      FROM entity_triples
    `);
  }

  // Entity FTS5 for fuzzy name lookup
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(entity_id, name, entity_type)`);

  // Entity enrichment state: tracks what input was used for extraction (idempotent --enrich)
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_enrichment_state (
      doc_id INTEGER PRIMARY KEY,
      input_hash TEXT NOT NULL,
      enriched_at TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  // 3-tier consolidation: observations synthesized from clusters of related facts
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidated_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation TEXT NOT NULL,
      proof_count INTEGER NOT NULL DEFAULT 1,
      source_doc_ids TEXT NOT NULL DEFAULT '[]',
      trend TEXT NOT NULL DEFAULT 'NEW',
      status TEXT NOT NULL DEFAULT 'active',
      invalidated_at TEXT,
      invalidated_by INTEGER,
      superseded_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      collection TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_consolidated_obs_status ON consolidated_observations(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consolidated_obs_trend ON consolidated_observations(trend)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consolidated_obs_proof ON consolidated_observations(proof_count DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_classifications (
      query_hash TEXT PRIMARY KEY,
      query_text TEXT,
      intent TEXT,
      confidence REAL,
      temporal_start TEXT,
      temporal_end TEXT,
      cached_at TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_intent_cache_time ON intent_classifications(cached_at)`);

  // Recall tracking: append-only event log for every doc surfaced by retrieval
  // usage_id is informational (no FK) — links to context_usage.id in the same vault
  // but may reference a different vault's row in cross-vault scenarios.
  // Cross-vault linkage uses session_id + turn_index instead.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      query_hash TEXT NOT NULL,
      search_score REAL NOT NULL,
      session_id TEXT NOT NULL,
      usage_id INTEGER,
      turn_index INTEGER NOT NULL DEFAULT 0,
      surfaced_at TEXT NOT NULL DEFAULT (datetime('now')),
      was_referenced INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);
  // Migration: add usage_id + turn_index columns to existing recall_events tables
  const reCols = db.prepare("PRAGMA table_info(recall_events)").all() as { name: string }[];
  const reColNames = new Set(reCols.map(c => c.name));
  if (!reColNames.has("usage_id")) {
    try { db.exec(`ALTER TABLE recall_events ADD COLUMN usage_id INTEGER`); } catch { /* exists */ }
  }
  if (!reColNames.has("turn_index")) {
    try { db.exec(`ALTER TABLE recall_events ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_events_usage ON recall_events(usage_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_events_doc ON recall_events(doc_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_events_session ON recall_events(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_events_surfaced ON recall_events(surfaced_at)`);

  // Recall stats: derived summary recomputed by background worker
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_stats (
      doc_id INTEGER PRIMARY KEY,
      recall_count INTEGER NOT NULL DEFAULT 0,
      unique_queries INTEGER NOT NULL DEFAULT 0,
      recall_days INTEGER NOT NULL DEFAULT 0,
      total_score REAL NOT NULL DEFAULT 0,
      max_score REAL NOT NULL DEFAULT 0,
      first_recalled_at TEXT,
      last_recalled_at TEXT,
      diversity_score REAL NOT NULL DEFAULT 0,
      spacing_score REAL NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  // Migration: add contradict_confidence to memory_relations
  const mrCols = db.prepare("PRAGMA table_info(memory_relations)").all() as { name: string }[];
  const mrColNames = new Set(mrCols.map(c => c.name));
  if (!mrColNames.has("contradict_confidence")) {
    try { db.exec(`ALTER TABLE memory_relations ADD COLUMN contradict_confidence REAL`); } catch { /* column exists */ }
  }

  // v0.8.0 Ext 5: Heavy maintenance lane journal. Every scheduled attempt
  // writes one row — including skips — so operators can reconstruct why a
  // lane did or did not run on any tick.
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      selected_count INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      null_call_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      metrics_json TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_maintenance_runs_lane_started ON maintenance_runs(lane, started_at DESC)`);

  // v0.8.0 Ext 5: DB-backed worker lease table for multi-process exclusivity
  // on the heavy lane. Lease holders fence via random token; expired leases
  // are reclaimed via atomic upsert inside a transaction.
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_leases (
      worker_name TEXT PRIMARY KEY,
      lease_token TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  // v0.29.0: durable contradiction-judge audit. One judge_runs row per evaluation
  // (a provider-failure→heuristic fallback is TWO rows linked by fallback_from_run_id,
  // pruned as a unit via the self-FK cascade); judge_events carries per-verdict /
  // per-reject / per-error facts. Interactive hosts do not persist hook stderr, so
  // these rows are the only durable evidence erosion calibration can read.
  db.exec(`
    CREATE TABLE IF NOT EXISTS judge_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT,
      consumer TEXT NOT NULL,
      lane TEXT NOT NULL,
      model TEXT,
      endpoint TEXT,
      prompt_version TEXT,
      new_fact_count INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      response_sha256 TEXT,
      outcome TEXT NOT NULL,
      fallback_from_run_id INTEGER REFERENCES judge_runs(id) ON DELETE CASCADE,
      entries_admitted INTEGER NOT NULL DEFAULT 0,
      entries_rejected INTEGER NOT NULL DEFAULT 0,
      entries_duplicate INTEGER NOT NULL DEFAULT 0,
      entries_inconsistent INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_judge_runs_consumer_ts ON judge_runs(consumer, ts DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_judge_runs_fallback ON judge_runs(fallback_from_run_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS judge_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES judge_runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      new_idx INTEGER,
      old_idx INTEGER,
      new_ref TEXT,
      old_ref TEXT,
      relation TEXT,
      confidence REAL,
      reasoning_head TEXT,
      reason_code TEXT,
      action TEXT,
      evidence_head TEXT,
      score_before REAL,
      score_after REAL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_judge_events_run ON judge_events(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_judge_events_action ON judge_events(action)`);
}


// v0.8.1 Ext 6b: per-database cache for the query_text column presence on
// context_usage. Set once at migration time so insertUsageFn can pick the
// correct INSERT shape without running PRAGMA on every write. Falls back
// to `false` (safe — equivalent to pre-migration behavior) when absent.
const contextUsageHasQueryTextCache = new WeakMap<Database, boolean>();

/**
 * Fatal, non-recoverable vector-store errors. These abort the embed run rather
 * than being swallowed as per-fragment failures. A dimension/schema mismatch must
 * NEVER silently drop an existing table — the only path that clears vectors is the
 * explicit clearAllEmbeddings (gated behind `embed --force`). See
 * INCIDENT-2026-06-22 §12 + EMBED-LEASE-RENEWAL-DESIGN.md.
 */
export class FatalVectorError extends Error {}

/**
 * Rethrow a fatal vector error (dimension / model / schema mismatch) so a searchVec() fallback
 * catch surfaces it instead of silently degrading to BM25. Transient conditions (timeout, absent
 * vectors) are NOT FatalVectorError and remain swallowed by the caller, as before. Apply this at the
 * FTS-fallback catch sites that wrap searchVec.
 */
export function rethrowIfFatalVectorError(e: unknown): void {
  if (e instanceof FatalVectorError) throw e;
}

export class VecDimensionMismatchError extends FatalVectorError {
  constructor(public readonly existingDim: number, public readonly requestedDim: number) {
    super(`Embedding dimension changed: vectors_vec is float[${existingDim}] but the model now returns float[${requestedDim}]. Run 'clawmem embed --force' to clear and rebuild the full vault.`);
    this.name = "VecDimensionMismatchError";
  }
}

export class VecSchemaError extends FatalVectorError {
  constructor(message: string) {
    super(message);
    this.name = "VecSchemaError";
  }
}

export class VecModelMismatchError extends FatalVectorError {
  constructor(public readonly expectedModel: string, public readonly actualModel: string) {
    super(`Embedding model changed mid-run: the vault is being built with "${expectedModel}" but the endpoint now returns "${actualModel}". Mixing different models in one vector space (even at the same dimension) makes cosine similarity meaningless. Run 'clawmem embed --force' to rebuild with the current model.`);
    this.name = "VecModelMismatchError";
  }
}

/**
 * Read-path sibling of VecModelMismatchError. VecModelMismatchError fires only mid-embed-run; this
 * one fires on the QUERY path when the vault's stored vectors were embedded with one model but the
 * active embedding endpoint now returns a different model at the SAME dimension (so the dimension
 * guard cannot catch it). Matching the new model's query vector against the old model's stored
 * vectors is cosine-meaningless, so searchVec throws this rather than serving corrupted results.
 */
export class VecReadModelMismatchError extends FatalVectorError {
  constructor(public readonly storedModels: string[], public readonly activeModel: string) {
    super(`Embedding model mismatch on the query path: the vault's vectors were embedded with ${storedModels.map(m => `"${m}"`).join(", ")} but the active embedding endpoint now returns "${activeModel}". At the same dimension the dimension guard cannot catch this, and matching the new model's query vector against the old model's stored vectors makes cosine similarity meaningless. Run 'clawmem embed --force' to rebuild the vault with the current model.`);
    this.name = "VecReadModelMismatchError";
  }
}

// Fail-open surfacing for a read-path model mismatch: warn LOUDLY once per process, then let the
// caller degrade to BM25. For hooks that MUST NOT throw — context-surfacing (UserPromptSubmit) and
// the Stop hooks (decision-extractor) — a throwing hook breaks that turn. Explicit query paths use
// rethrowIfFatalVectorError instead. The once-flag is process-global so the warning fires exactly
// once no matter which hook trips it first.
let _warnedVectorModelMismatch = false;
export function warnOnceOnVectorModelMismatch(e: unknown): void {
  if (e instanceof VecReadModelMismatchError && !_warnedVectorModelMismatch) {
    _warnedVectorModelMismatch = true;
    console.warn(`[clawmem] ${e.message}`);
  }
}

// A FatalVectorError so it propagates out of the per-fragment catch and aborts the
// embed run. Thrown both by cmdEmbed (between fragments) and INSIDE insertEmbedding's
// write transaction (atomic lease-token fence) when the lease was reclaimed.
export class EmbedLeaseLostError extends FatalVectorError {
  constructor() {
    super("Embedding lease lost (another embed process took over). Re-run 'clawmem embed'.");
    this.name = "EmbedLeaseLostError";
  }
}

/** A held embedding-lease identity, passed into vector mutations so each can verify
 *  ownership before mutating — a process that lost the lease cannot wipe/recreate/write
 *  the vector store under the new holder. */
export type LeaseGuard = { workerName: string; token: string };

// =============================================================================
// Cross-agent fact witness + triple write options (cross-agent memory PR)
// =============================================================================

/** Who wrote an agent fact, and how — attribution for cross-agent trust. */
export interface FactWitness {
  /** Agent that learned/wrote the fact (e.g. "max", "scout"). */
  agentId: string;
  /** Session the fact was learned in, when known. */
  sessionId?: string;
  /** ISO timestamp of the observation. Defaults to write time. */
  timestamp?: string;
  /** How it was observed (e.g. "direct_observation", "document", "verification"). */
  source?: string;
}

/** Options passed through to `Store.addTriple` / the fact-writing tools. */
export interface AddTripleOptions {
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  sourceDocId?: number;
  sourceFact?: string;
  /** Cross-agent attribution for the fact. */
  witness?: FactWitness;
  /** Explicit witness timestamp (falls back to options.witness.timestamp). */
  writtenAt?: string;
  /** Free-form JSON-serializable tag array ([]TEXT, stored as JSON). */
  tags?: string[];
  /** When true, ALWAYS insert a fresh triple row instead of deduping onto an
   *  existing current triple — required so multiple agents can hold divergent
   *  or evolving opinions on the same subject+predicate without clobbering. */
  append?: boolean;
}

/** A single cross-agent fact row returned by `queryCrossAgentFacts`. */
export interface CrossAgentFact {
  id: number;
  subject: string;
  subjectEntityId: string;
  predicate: string;
  object: string;
  objectEntityId: string | null;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  current: boolean;
  writtenAt: string | null;
  agentId: string | null;
  sessionId: string | null;
  sourceType: string | null;
  tags: string[] | null;
}

/** Filters for `Store.queryCrossAgentFacts`. All string fields accept "*" as a wildcard. */
export interface CrossAgentQuery {
  subject?: string;
  predicate?: string;
  object?: string;
  /** ISO timestamp — only facts written on/after this time are returned. */
  since?: string;
  /** Lower bound (inclusive) on confidence, 0..1. */
  minConfidence?: number;
  /** Restrict to facts written by these agents ("*" or omitted = any). */
  writtenBy?: string[];
  /** Restrict to facts written from one of these sessions. */
  sessionIds?: string[];
  /** If true, merge arcs with different witnesses taking the most recent fact
   *  per (subject, predicate, object) with confidence >= minConfidence. */
  resolveConflicts?: boolean;
  /** Max rows returned. Default 50. */
  limit?: number;
  vault?: string;
}

/**
 * Throw EmbedLeaseLostError if the caller no longer holds the named lease. Call as the
 * FIRST statement inside a write transaction (before any mutation), so the check and
 * the writes are atomic under SQLite's single-writer serialization — no other holder
 * can interleave a reclaim between the check and the mutation. No-op when leaseGuard
 * is omitted (non-embed callers).
 */
function assertLeaseHeld(db: Database, leaseGuard?: LeaseGuard): void {
  if (!leaseGuard) return;
  const row = db.prepare(`SELECT lease_token FROM worker_leases WHERE worker_name = ?`).get(leaseGuard.workerName) as { lease_token: string } | null;
  if (!row || row.lease_token !== leaseGuard.token) {
    throw new EmbedLeaseLostError();
  }
}

/**
 * Single source of truth for vectors_vec schema validation. Reads the table DDL
 * and returns:
 *   - null      → table ABSENT
 *   - <integer> → table VALID (vec0 schema: hash_seq + float[N] + cosine); the N
 *   - throws VecSchemaError → table PRESENT but its schema is unexpected
 *     (missing float[N], hash_seq, or distance_metric=cosine; malformed/legacy DDL).
 * No caching: a stale per-process dim cache could bypass this validation when
 * another process changed the table. The embed lease serializes embeds, and the
 * old cache fast-path is removed so validation is unconditional on every call.
 * Case-insensitive, whitespace-tolerant.
 */
function readVecTableDim(db: Database): number | null {
  const info = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (!info) return null;
  const m = info.sql.match(/float\s*\[\s*(\d+)\s*\]/i);
  const hasHashSeq = /\bhash_seq\b/i.test(info.sql);
  const hasCosine = /distance_metric\s*=\s*cosine/i.test(info.sql);
  if (!m || !hasHashSeq || !hasCosine) {
    throw new VecSchemaError(`vectors_vec exists but its schema is unexpected (need hash_seq + float[N] + distance_metric=cosine): ${info.sql}`);
  }
  return parseInt(m[1]!, 10);
}

function ensureVecTableInternal(db: Database, dimensions: number, leaseGuard?: LeaseGuard): void {
  const existing = readVecTableDim(db); // null=absent, N=valid, throws VecSchemaError if malformed
  if (existing !== null) {
    // NEVER drop an existing table on a dimension mismatch — that silently destroys
    // the vault's vectors while the metadata-based worklist skips the now-vectorless
    // docs (INCIDENT-2026-06-22). Throw; the run aborts. Clear+rebuild happens only
    // via clearAllEmbeddings (`embed --force`).
    if (existing !== dimensions) throw new VecDimensionMismatchError(existing, dimensions);
    return; // exists at the right dim + valid schema → nothing to do
  }
  // Table absent → create it ATOMICALLY. The lease assertion, a RE-CHECK of absence,
  // and the CREATE run in ONE immediate-write-lock transaction, so no other process
  // can clear/recreate between the check and the CREATE (closes the TOCTOU): a process
  // that lost its lease cannot create an empty table at the wrong dimension under the
  // new holder, and two creators cannot race. (vec0 CREATE works inside a transaction.)
  db.transaction(() => {
    assertLeaseHeld(db, leaseGuard);
    const recheck = readVecTableDim(db);
    if (recheck !== null) {
      // Another holder created it while we waited for the write lock.
      if (recheck !== dimensions) throw new VecDimensionMismatchError(recheck, dimensions);
      return;
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
  }).immediate();
}

/**
 * Public accessor for the vectors_vec dimension. Returns null if absent, the
 * integer dimension if valid, or throws VecSchemaError if the table exists with
 * a malformed/unexpected schema (see readVecTableDim).
 */
export function getVecTableDim(db: Database): number | null {
  return readVecTableDim(db);
}

/**
 * Prewarm the sqlite-vec payload into OS page cache with a single brute-force MATCH using a ZERO
 * query vector. Decoupled from the embedding server on purpose — it works when the embed server is
 * down at boot or CLAWMEM_NO_LOCAL_MODELS=true, unlike a searchVec()-based prewarm (which embeds
 * first and would silently no-op). Returns true ONLY if a scan actually ran (a vector table with a
 * known dimension exists), so callers never log a false-positive "warmed". The k-NN MATCH is
 * brute-force, so it touches every vector chunk — exactly the payload we want cache-resident.
 */
export function prewarmVectors(db: Database): boolean {
  const dim = getVecTableDim(db);
  if (!dim || dim <= 0) return false;
  const zero = new Float32Array(dim);
  db.prepare(`SELECT hash_seq FROM vectors_vec WHERE embedding MATCH ? AND k = ?`).all(zero, 1);
  return true;
}

/**
 * Keep the sqlite-vec payload resident in the OS page cache by re-running the brute-force
 * prewarm on an interval. The one-shot prewarm at watcher startup warms the cache ONCE; on a
 * long-running host under memory pressure the kernel can evict the (potentially ~1.5 GB) vector
 * payload between hook calls, and the next cold SYNCHRONOUS MATCH in the context-surfacing hook
 * path can then blow the 8-15s hook budget (bun:sqlite exposes no interrupt, so an in-flight
 * scan cannot be abandoned). Re-touching the pages biases the kernel LRU toward keeping them
 * resident — a PROBABILITY reduction, NOT a hard cap. The hard cap (moving the blocking scan off
 * the hook's event loop so its deadline can fire) is the deferred BACKLOG Source 46 daemon.
 *
 * Best-effort: never throws; a per-tick failure is swallowed so the timer keeps running. Returns
 * the interval handle (the caller MUST clear it on shutdown) or null when disabled (intervalMs
 * <= 0 or non-finite). The handle is unref'd so it never by itself keeps the process alive.
 * `onPrewarm(ran)` is an optional observability hook fired after each attempt — `ran` is whether
 * a scan actually executed (i.e. a dimensioned vector table exists).
 */
export function startPeriodicPrewarm(
  db: Database,
  intervalMs: number,
  onPrewarm?: (ran: boolean) => void,
): ReturnType<typeof setInterval> | null {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(() => {
    let ran = false;
    try { ran = prewarmVectors(db); } catch { /* best-effort: unexpected SQL error */ }
    if (onPrewarm) { try { onPrewarm(ran); } catch { /* observer must never break the timer */ } }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Floor for the periodic re-prewarm interval. Below this, a large-vault (~1.5 GB) brute-force scan
 *  runs near-continuously and can saturate the watcher event loop + I/O, so any smaller positive
 *  request is clamped UP to this value. */
export const PREWARM_MIN_INTERVAL_MS = 60_000;
/** Default periodic re-prewarm interval when CLAWMEM_PREWARM_INTERVAL_MS is unset or unparseable. */
export const PREWARM_DEFAULT_INTERVAL_MS = 600_000;

/**
 * Resolve the raw CLAWMEM_PREWARM_INTERVAL_MS env value into a SAFE interval for the watcher. This
 * policy is kept OUT of the permissive `startPeriodicPrewarm` mechanism (so unit tests can still use
 * tiny intervals) and applied only on the production env path.
 *   - unset / empty / unparseable → default (600000). Garbage must NOT silently disable the
 *     mitigation, nor be read as a tiny interval.
 *   - exactly 0 → 0 (the documented off switch; `startPeriodicPrewarm` then returns null).
 *   - negative → default (nonsensical; neither an intentional disable nor a fast loop).
 *   - 0 < n < floor → clamped UP to the 60s floor. Prevents the near-continuous scan loop that e.g.
 *     "1" or "1e3" would otherwise schedule. NOTE: `Number("1e3") === 1000` whereas
 *     `parseInt("1e3", 10) === 1`, so `Number()` is used deliberately (parseInt silently truncates
 *     at the "e").
 *   - n >= floor → floored to an integer and used as-is.
 */
export function resolvePrewarmIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return PREWARM_DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return PREWARM_DEFAULT_INTERVAL_MS;
  if (n === 0) return 0;
  if (n < 0) return PREWARM_DEFAULT_INTERVAL_MS;
  return Math.max(PREWARM_MIN_INTERVAL_MS, Math.floor(n));
}

/**
 * The DISTINCT non-empty embedding models stored in the vault (empty array if no
 * embeddings exist). Used to detect model drift BETWEEN runs — a different model at
 * the SAME dimension produces a heterogeneous vector space that dimension checks
 * cannot catch. Returning ALL distinct models (not just the majority) lets callers
 * also detect an ALREADY-heterogeneous vault (length > 1) instead of hiding the
 * minority behind a majority match. The implicit embed path aborts and requires
 * `embed --force` on any drift.
 */
export function getVecModels(db: Database): string[] {
  // Join to ACTIVE documents so stale/orphaned content_vectors rows (an obsolete
  // model on an inactive hash, not yet cleaned) cannot trigger a permanent
  // "mixed models" abort that would block the very cleanup that removes them.
  const rows = db.prepare(
    `SELECT DISTINCT cv.model
     FROM content_vectors cv
     JOIN documents d ON d.hash = cv.hash AND d.active = 1
     WHERE cv.model IS NOT NULL AND cv.model != ''
     ORDER BY cv.model`
  ).all() as { model: string }[];
  return rows.map(r => r.model);
}

// =============================================================================
// Store Factory
// =============================================================================

export type Store = {
  db: Database;
  dbPath: string;
  close: () => void;
  ensureVecTable: (dimensions: number, leaseGuard?: LeaseGuard) => void;
  getVecTableDim: () => number | null;
  getVecModels: () => string[];

  // Index health
  getHashesNeedingEmbedding: () => number;
  getIndexHealth: () => IndexHealthInfo;
  getStatus: () => IndexStatus;

  // Caching
  getCacheKey: typeof getCacheKey;
  getCachedResult: (cacheKey: string) => string | null;
  setCachedResult: (cacheKey: string, result: string) => void;
  clearCache: () => void;

  // Cleanup and maintenance
  deleteLLMCache: () => number;
  cleanupOrphanedContent: () => number;
  vacuumDatabase: () => void;

  // Context
  getContextForFile: (filepath: string) => string | null;
  getContextForPath: (collectionName: string, path: string) => string | null;
  getCollectionByName: (name: string) => { name: string; pwd: string; glob_pattern: string } | null;
  getCollectionsWithoutContext: () => { name: string; pwd: string; doc_count: number }[];
  getTopLevelPathsWithoutContext: (collectionName: string) => string[];

  // Virtual paths
  parseVirtualPath: typeof parseVirtualPath;
  buildVirtualPath: typeof buildVirtualPath;
  isVirtualPath: typeof isVirtualPath;
  resolveVirtualPath: (virtualPath: string) => string | null;
  toVirtualPath: (absolutePath: string) => string | null;

  // Search
  searchFTS: (query: string, limit?: number, collectionId?: number, collections?: string[], dateRange?: { start: string; end: string }, excludeCollections?: string[], opts?: { observationsOnly?: boolean }) => SearchResult[];
  searchVec: (query: string, model: string, limit?: number, collectionId?: number, collections?: string[], dateRange?: { start: string; end: string }, deadlineMs?: number) => Promise<SearchResult[]>;
  searchVecDetailed: (query: string, model: string, limit?: number, opts?: VecSearchDetailedOpts) => Promise<VecSearchDetailedResult>;

  // Query expansion & reranking
  expandQuery: (query: string, model?: string, intent?: string) => Promise<ExpandedQuery[]>;
  rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string, options?: RerankProbeOptions) => Promise<{ file: string; score: number }[]>;

  // Document retrieval
  findDocument: (filename: string, options?: { includeBody?: boolean }) => DocumentResult | DocumentNotFound;
  getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => string | null;
  findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => { docs: MultiGetResult[]; errors: string[] };

  // Fuzzy matching and docid lookup
  findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => string[];
  matchFilesByGlob: (pattern: string) => { filepath: string; displayPath: string; bodyLength: number }[];
  findDocumentByDocid: (docid: string) => { filepath: string; hash: string } | null;

  // Document indexing operations
  insertContent: (hash: string, content: string, createdAt: string) => void;
  insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string, origin?: DocumentOrigin) => void;
  findActiveDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string; pinned: number; snoozed_until: string | null; confidence: number } | null;
  findAnyDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string; active: number } | null;
  reactivateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => boolean;
  updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => void;
  updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => void;
  deactivateDocument: (collectionName: string, path: string, reason: DeactivationReason) => void;
  getActiveDocumentPaths: (collectionName: string) => string[];
  getReconcilableDocumentPaths: (collectionName: string) => string[];

  // Vector/embedding operations
  getHashesForEmbedding: () => { hash: string; body: string; path: string }[];
  getHashesNeedingFragments: () => { hash: string; body: string; path: string; title: string; collection: string }[];
  clearAllEmbeddings: (leaseGuard?: LeaseGuard) => void;
  getVectorConsistency: () => { cvCount: number; vvCount: number; cvMissingVv: number; vvOrphan: number; pending: number };
  insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string, fragmentType?: string, fragmentLabel?: string, canonicalId?: string, leaseGuard?: LeaseGuard, embedInputFp?: string) => void;
  cleanStaleEmbeddings: (leaseGuard?: LeaseGuard) => number;
  saveCanaryBaseline: (profileKey: string, probes: { probeId: string; embedding: Float32Array }[], pairMargins: Record<string, number>, leaseGuard?: LeaseGuard) => void;
  getCanaryBaseline: (profileKey: string) => { probes: Map<string, Float32Array>; pairMargins: Record<string, number>; embeddedAt: string } | null;
  setVaultFlag: (flag: string, value: string, leaseGuard?: LeaseGuard) => void;
  getVaultFlag: (flag: string) => string | null;
  clearVaultFlag: (flag: string, leaseGuard?: LeaseGuard) => void;

  // SAME: Observation metadata
  updateObservationFields: (docPath: string, collectionName: string, fields: { observation_type?: string; facts?: string; narrative?: string; concepts?: string; files_read?: string; files_modified?: string }) => void;

  // SAME: Session tracking
  insertSession: (sessionId: string, startedAt: string, machine?: string) => void;
  updateSession: (sessionId: string, updates: { endedAt?: string; handoffPath?: string; filesChanged?: string[]; summary?: string }) => void;
  getSession: (sessionId: string) => SessionRecord | null;
  getRecentSessions: (limit: number) => SessionRecord[];

  // SAME: Context usage tracking
  insertUsage: (usage: UsageRecord) => number;
  getUsageForSession: (sessionId: string) => UsageRow[];
  markUsageReferenced: (id: number) => void;

  // SAME: Document metadata operations
  updateDocumentMeta: (docId: number, meta: { domain?: string; workstream?: string; tags?: string; content_type?: string; review_by?: string; confidence?: number; quality_score?: number; authored_at?: string | null }) => void;
  incrementAccessCount: (paths: string[]) => void;
  getDocumentsByType: (contentType: string, limit?: number, opts?: { orderBy?: "operational" | "effective" }) => DocumentRow[];
  getStaleDocuments: (beforeDate: string) => DocumentRow[];
  pinDocument: (collection: string, path: string, pinned: boolean) => void;
  snoozeDocument: (collection: string, path: string, until: string | null) => void;

  // Embed state tracking
  markEmbedStart: (hash: string, leaseGuard?: LeaseGuard) => void;
  markEmbedSynced: (hash: string, leaseGuard?: LeaseGuard) => void;
  markEmbedFailed: (hash: string, error: string, leaseGuard?: LeaseGuard) => void;
  getEmbedStats: () => { pending: number; synced: number; failed: number };

  // Beads integration
  syncBeadsIssues: (projectDir: string) => Promise<{ synced: number; created: number; newDocIds: number[] }>;
  detectBeadsProject: (cwd: string) => string | null;

  // MAGMA graph building
  buildTemporalBackbone: () => number;
  countActiveRelations: (relationType: string) => number;
  buildSemanticGraph: (threshold?: number) => Promise<number>;

  // A-MEM: Self-Evolving Memory
  constructMemoryNote: (llm: any, docId: number) => Promise<any>;
  storeMemoryNote: (docId: number, note: any) => boolean;
  generateMemoryLinks: (llm: any, docId: number, kNeighbors?: number) => Promise<number>;
  evolveMemories: (llm: any, memoryId: number, triggeredBy: number) => Promise<boolean>;
  postIndexEnrich: (llm: any, docId: number, isNew: boolean) => Promise<EnrichOutcome>;
  findCausalLinks: (docId: number, direction?: 'causes' | 'caused_by' | 'both', maxDepth?: number) => CausalEdgesResult;
  getEvolutionTimeline: (docId: number, limit?: number) => EvolutionEntry[];

  // Entity resolution + co-occurrence
  enrichDocumentEntities: (llm: any, docId: number, vault?: string) => Promise<number>;
  searchEntities: (query: string, limit?: number) => { entity_id: string; name: string; type: string; mention_count: number; cooccurrence_count: number }[];
  getEntityGraphNeighbors: (seedDocIds: number[], limit?: number) => { docId: number; score: number; viaEntity: string }[];

  // SPO knowledge graph
  addTriple: (subjectEntityId: string, predicate: string, objectEntityId: string | null, objectLiteral: string | null, options?: AddTripleOptions) => number;
  invalidateTriple: (subjectEntityId: string, predicate: string, objectEntityId: string | null, objectLiteral: string | null, endedDate?: string) => number;
  queryEntityTriples: (entityId: string, options?: { asOf?: string; direction?: "outgoing" | "incoming" | "both"; includeProvenance?: boolean; provenanceLimit?: number }) => { id: number; direction: string; subject: string; predicate: string; object: string; validFrom: string | null; validTo: string | null; confidence: number; current: boolean; evidenceCount?: number; sources?: { docId: number | null; collection: string | null; path: string | null; fact: string | null; at: string }[] }[];
  getTripleStats: () => { totalTriples: number; currentFacts: number; expiredFacts: number; predicateTypes: string[] };
  queryCrossAgentFacts: (query: CrossAgentQuery) => CrossAgentFact[];
  // Recall tracking
  insertRecallEvents: (events: { docId: number; queryHash: string; searchScore: number; sessionId: string; usageId?: number; turnIndex?: number; wasReferenced?: boolean }[]) => number;
  recomputeRecallStats: () => number;
  getRecallStats: (docId: number) => RecallStatsRow | null;
  getRecallStatsAll: (minRecallCount?: number) => RecallStatsRow[];
  markRecallEventsReferenced: (sessionId: string, docIds: number[]) => void;

  // Co-activation tracking
  recordCoActivation: (paths: string[]) => void;
  getCoActivated: (path: string, limit?: number) => { path: string; count: number }[];

  // Usage relation tracking
  insertRelation: (fromDoc: number, toDoc: number, relType: string, weight?: number) => void;

  // Engram integration: unified save API for hook-generated memories
  saveMemory: (params: SaveMemoryParams) => SaveMemoryResult;
  hashNormalized: typeof hashNormalized;

  // Engram integration: temporal timeline
  timeline: (docId: number, options?: { before?: number; after?: number; sameCollection?: boolean }) => TimelineResult;

  // Document archival & lifecycle
  archiveDocuments: (ids: number[]) => number;
  getArchiveCandidates: (policy: import("./collections.ts").LifecyclePolicy) => { id: number; collection: string; path: string; title: string; modified_at: string; last_accessed_at: string | null; content_type: string }[];
  restoreArchivedDocuments: (filter: { ids?: number[]; collection?: string; sinceDate?: string }) => number;
  getLifecycleStats: () => { active: number; archived: number; forgotten: number; pinned: number; snoozed: number; neverAccessed: number; oldestAccess: string | null };
  searchArchived: (query: string, limit?: number) => { id: number; collection: string; path: string; title: string; archived_at: string; score: number }[];
};

/**
 * Create a new store instance with the given database path.
 * If no path is provided, uses the default path (~/.cache/qmd/index.sqlite).
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Store instance with all methods bound to the database
 */
export function createStore(dbPath?: string, opts?: { readonly?: boolean; busyTimeout?: number }): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = opts?.readonly
    ? new Database(resolvedPath, { readonly: true })
    : new Database(resolvedPath);
  if (!opts?.readonly) {
    initializeDatabase(db, opts?.busyTimeout ?? 15000);
  } else {
    // Readonly: set busy_timeout FIRST so the journal_mode PRAGMA below
    // doesn't race when concurrent processes open the DB. PRAGMA
    // journal_mode=WAL can contend when switching or initializing WAL
    // state, even on readonly handles. Public-API hardening — no
    // production caller in this repo currently passes readonly:true,
    // but the ordering invariant should hold regardless. Issue #13.
    db.exec(`PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}`);
    loadVecExtension(db);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA query_only = ON");
  }
  // For the writable branch: initializeDatabase() set opts.busyTimeout (default 15000) during DDL —
  // reset to operational value here. For readonly: already set inside the
  // branch above; this assignment is a no-op rewrite to the same value.
  db.exec(`PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}`);

  return {
    db,
    dbPath: resolvedPath,
    close: () => db.close(),
    ensureVecTable: (dimensions: number, leaseGuard?: LeaseGuard) => ensureVecTableInternal(db, dimensions, leaseGuard),
    getVecTableDim: () => getVecTableDim(db),
    getVecModels: () => getVecModels(db),

    // Index health
    getHashesNeedingEmbedding: () => getHashesNeedingEmbedding(db),
    getIndexHealth: () => getIndexHealth(db),
    getStatus: () => getStatus(db),

    // Caching
    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    // Cleanup and maintenance
    deleteLLMCache: () => deleteLLMCache(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    vacuumDatabase: () => vacuumDatabase(db),

    // Context
    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    // Virtual paths
    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    // Search
    searchFTS: (query: string, limit?: number, collectionId?: number, collections?: string[], dateRange?: { start: string; end: string }, excludeCollections?: string[], opts?: { observationsOnly?: boolean }) => searchFTS(db, query, limit, collectionId, collections, dateRange, excludeCollections, opts),
    searchVec: (query: string, model: string, limit?: number, collectionId?: number, collections?: string[], dateRange?: { start: string; end: string }, deadlineMs?: number) => searchVec(db, query, model, limit, collectionId, collections, dateRange, deadlineMs),
    searchVecDetailed: (query: string, model: string, limit?: number, opts?: VecSearchDetailedOpts) => searchVecDetailed(db, query, model, limit, opts),

    // Query expansion & reranking
    expandQuery: (query: string, model?: string, intent?: string) => expandQuery(query, model, db, intent),
    rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string, options?: RerankProbeOptions) => rerank(query, documents, model, db, intent, options),

    // Document retrieval
    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    // Fuzzy matching and docid lookup
    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    // Document indexing operations
    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string, origin?: DocumentOrigin) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt, origin),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    findAnyDocument: (collectionName: string, path: string) => findAnyDocument(db, collectionName, path),
    reactivateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => reactivateDocument(db, documentId, title, hash, modifiedAt),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string, reason: DeactivationReason) => deactivateDocument(db, collectionName, path, reason),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),
    getReconcilableDocumentPaths: (collectionName: string) => getReconcilableDocumentPaths(db, collectionName),

    // Vector/embedding operations
    getHashesForEmbedding: () => getHashesForEmbedding(db),
    getHashesNeedingFragments: () => getHashesNeedingFragments(db),
    clearAllEmbeddings: (leaseGuard?: LeaseGuard) => clearAllEmbeddings(db, leaseGuard),
    getVectorConsistency: () => getVectorConsistency(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string, fragmentType?: string, fragmentLabel?: string, canonicalId?: string, leaseGuard?: LeaseGuard, embedInputFp?: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt, fragmentType, fragmentLabel, canonicalId, leaseGuard, embedInputFp),
    cleanStaleEmbeddings: (leaseGuard?: LeaseGuard) => cleanStaleEmbeddings(db, leaseGuard),
    saveCanaryBaseline: (profileKey: string, probes: { probeId: string; embedding: Float32Array }[], pairMargins: Record<string, number>, leaseGuard?: LeaseGuard) => {
      const marginsJson = JSON.stringify(pairMargins);
      const now = new Date().toISOString();
      db.transaction(() => {
        assertLeaseHeld(db, leaseGuard);
        db.prepare(`DELETE FROM embed_canary WHERE profile_key = ?`).run(profileKey);
        const ins = db.prepare(`INSERT INTO embed_canary (probe_id, profile_key, embedding, pair_margins, embedded_at) VALUES (?, ?, ?, ?, ?)`);
        for (const p of probes) {
          ins.run(p.probeId, profileKey, new Uint8Array(p.embedding.buffer.slice(p.embedding.byteOffset, p.embedding.byteOffset + p.embedding.byteLength)), marginsJson, now);
        }
      }).immediate();
    },
    getCanaryBaseline: (profileKey: string) => {
      const rows = db.prepare(`SELECT probe_id, embedding, pair_margins, embedded_at FROM embed_canary WHERE profile_key = ?`).all(profileKey) as { probe_id: string; embedding: Uint8Array; pair_margins: string; embedded_at: string }[];
      if (rows.length === 0) return null;
      const probes = new Map<string, Float32Array>();
      for (const r of rows) {
        const buf = new Uint8Array(r.embedding);
        probes.set(r.probe_id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
      }
      let pairMargins: Record<string, number> = {};
      try { pairMargins = JSON.parse(rows[0]!.pair_margins); } catch { /* malformed → empty */ }
      return { probes, pairMargins, embeddedAt: rows[0]!.embedded_at };
    },
    // Lease-fenced (T9-M4): a holder reclaimed during an async end probe must not set or
    // clear taint written by its successor — ownership check and mutation share one txn.
    setVaultFlag: (flag: string, value: string, leaseGuard?: LeaseGuard) => {
      db.transaction(() => {
        assertLeaseHeld(db, leaseGuard);
        db.prepare(`INSERT OR REPLACE INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)`).run(flag, value, new Date().toISOString());
      }).immediate();
    },
    getVaultFlag: (flag: string) => {
      const row = db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(flag) as { value: string } | undefined;
      return row?.value ?? null;
    },
    clearVaultFlag: (flag: string, leaseGuard?: LeaseGuard) => {
      db.transaction(() => {
        assertLeaseHeld(db, leaseGuard);
        db.prepare(`DELETE FROM vault_flags WHERE flag = ?`).run(flag);
      }).immediate();
    },

    // SAME: Observation metadata
    updateObservationFields: (docPath: string, collectionName: string, fields) => updateObservationFieldsFn(db, docPath, collectionName, fields),

    // SAME: Session tracking
    insertSession: (sessionId: string, startedAt: string, machine?: string) => insertSessionFn(db, sessionId, startedAt, machine),
    updateSession: (sessionId: string, updates) => updateSessionFn(db, sessionId, updates),
    getSession: (sessionId: string) => getSessionFn(db, sessionId),
    getRecentSessions: (limit: number) => getRecentSessionsFn(db, limit),

    // SAME: Context usage tracking
    insertUsage: (usage: UsageRecord) => insertUsageFn(db, usage) as number,
    getUsageForSession: (sessionId: string) => getUsageForSessionFn(db, sessionId),
    markUsageReferenced: (id: number) => markUsageReferencedFn(db, id),

    // SAME: Document metadata operations
    updateDocumentMeta: (docId: number, meta) => updateDocumentMetaFn(db, docId, meta),
    incrementAccessCount: (paths: string[]) => incrementAccessCountFn(db, paths),
    getDocumentsByType: (contentType: string, limit?: number, opts?: { orderBy?: "operational" | "effective" }) => getDocumentsByTypeFn(db, contentType, limit, opts),
    getStaleDocuments: (beforeDate: string) => getStaleDocumentsFn(db, beforeDate),
    pinDocument: (collection: string, path: string, pinned: boolean) => pinDocumentFn(db, collection, path, pinned),
    snoozeDocument: (collection: string, path: string, until: string | null) => snoozeDocumentFn(db, collection, path, until),

    // Embed state tracking — lease-fenced (VSEARCH-TRUST-HARDENING (f).5): the ownership
    // check and the state write share one transaction, so a reclaimed old holder cannot
    // overwrite a successor's document state after its last fragment.
    markEmbedStart: (hash: string, leaseGuard?: LeaseGuard) => {
      // Increment embed_attempts exactly ONCE per attempt, at the start, and set
      // 'pending' so a crash mid-document leaves the doc retryable (and selected by
      // getHashesNeedingFragments). The completion setters below are state-only — no
      // further increment — so a start + a failure for the same attempt cannot
      // double-count the retry budget.
      db.transaction(() => {
        assertLeaseHeld(db, leaseGuard);
        db.prepare(`UPDATE documents SET embed_state = 'pending', embed_error = NULL, embed_attempts = COALESCE(embed_attempts, 0) + 1 WHERE hash = ? AND active = 1`).run(hash);
      }).immediate();
    },
    markEmbedSynced: (hash: string, leaseGuard?: LeaseGuard) => {
      // Success resets the retry budget: embed_attempts counts CONSECUTIVE failures
      // of the current content, so a successful (re-)embed must clear it — otherwise
      // a doc re-embedded many times (repeated content edits) accumulates attempts
      // and is wrongly excluded by the worklist's `embed_attempts < 3` guard.
      db.transaction(() => {
        assertLeaseHeld(db, leaseGuard);
        db.prepare(`UPDATE documents SET embed_state = 'synced', embed_attempts = 0, embed_error = NULL WHERE hash = ? AND active = 1`).run(hash);
      }).immediate();
    },
    markEmbedFailed: (hash: string, error: string, leaseGuard?: LeaseGuard) => {
      db.transaction(() => {
        assertLeaseHeld(db, leaseGuard);
        db.prepare(`UPDATE documents SET embed_state = 'failed', embed_error = ? WHERE hash = ? AND active = 1`).run(error, hash);
      }).immediate();
    },
    getEmbedStats: () => {
      const stats = db.prepare(`
        SELECT
          SUM(CASE WHEN embed_state = 'pending' OR embed_state IS NULL THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN embed_state = 'synced' THEN 1 ELSE 0 END) as synced,
          SUM(CASE WHEN embed_state = 'failed' THEN 1 ELSE 0 END) as failed
        FROM documents WHERE active = 1
      `).get() as { pending: number; synced: number; failed: number };
      return { pending: stats.pending || 0, synced: stats.synced || 0, failed: stats.failed || 0 };
    },

    // Beads integration
    syncBeadsIssues: (projectDir: string) => syncBeadsIssues(db, projectDir),
    detectBeadsProject,

    // MAGMA graph building
    buildTemporalBackbone: () => buildTemporalBackbone(db),
    countActiveRelations: (relationType: string) => countActiveRelations(db, relationType),
    buildSemanticGraph: (threshold?: number) => buildSemanticGraph(db, threshold),

    // A-MEM: Self-Evolving Memory
    constructMemoryNote: (llm: any, docId: number) => constructMemoryNote({ db, dbPath: resolvedPath } as Store, llm, docId),
    storeMemoryNote: (docId: number, note: any) => storeMemoryNote({ db, dbPath: resolvedPath } as Store, docId, note),
    generateMemoryLinks: (llm: any, docId: number, kNeighbors?: number) => generateMemoryLinks({ db, dbPath: resolvedPath } as Store, llm, docId, kNeighbors),
    evolveMemories: (llm: any, memoryId: number, triggeredBy: number) => evolveMemories({ db, dbPath: resolvedPath } as Store, llm, memoryId, triggeredBy),
    postIndexEnrich: (llm: any, docId: number, isNew: boolean) => postIndexEnrich({ db, dbPath: resolvedPath } as Store, llm, docId, isNew),
    findCausalLinks: (docId: number, direction?: 'causes' | 'caused_by' | 'both', maxDepth?: number) => findCausalLinks(db, docId, direction, maxDepth),
    getEvolutionTimeline: (docId: number, limit?: number) => getEvolutionTimeline(db, docId, limit),

    // Entity resolution + co-occurrence
    enrichDocumentEntities: (llm: any, docId: number, vault?: string) => enrichDocumentEntities(db, llm, docId, vault),
    searchEntities: (query: string, limit?: number) => searchEntities(db, query, limit),
    getEntityGraphNeighbors: (seedDocIds: number[], limit?: number) => getEntityGraphNeighbors(db, seedDocIds, limit),

    // SPO knowledge graph
    addTriple: (subjectEntityId: string, predicate: string, objectEntityId: string | null, objectLiteral: string | null, options?: AddTripleOptions): number => {
      const pred = predicate.toLowerCase().replace(/\s+/g, "_");
      const now = new Date().toISOString();
      const objClause = objectEntityId
        ? "object_entity_id = ? AND object_literal IS NULL"
        : "object_entity_id IS NULL AND object_literal = ?";
      const objParam = objectEntityId ?? objectLiteral;
      const writtenAt = options?.writtenAt ?? options?.witness?.timestamp ?? now;
      const tagsJson = options?.tags && Array.isArray(options.tags) ? JSON.stringify(options.tags) : null;
      // Evidence rides in the same transaction as the base row — a triple must never exist
      // without a provenance row. An entirely-unattributed sighting still writes its
      // null-normalized row (the unique index collapses repeats to one), so evidenceCount
      // stays honest rather than under-reporting unattributed corroboration as zero.
      const insertEvidence = (tripleId: number) => {
        db.prepare(`
          INSERT OR IGNORE INTO entity_triple_provenance (triple_id, source_doc_id, source_fact, created_at)
          VALUES (?, ?, ?, ?)
        `).run(tripleId, options?.sourceDocId ?? null, options?.sourceFact ?? null, writtenAt);
      };
      const txn = db.transaction(() => {
        // Cross-agent append mode (fact_write): always write a NEW triple row so multiple
        // witnesses may disagree / evolve on the same subject+predicate without clobbering
        // each other. The default (append !== true) keeps the legacy dedup behaviour: it
        // reuses an existing current triple and merely adds provenance evidence, matching
        // the pre-PR contract exactly.
        if (options?.append !== true) {
          const existing = db.prepare(
            `SELECT id FROM entity_triples WHERE subject_entity_id = ? AND predicate = ? AND ${objClause} AND valid_to IS NULL`
          ).get(subjectEntityId, pred, objParam) as { id: number } | null;
          if (existing) {
            insertEvidence(existing.id);
            return existing.id;
          }
        }

        const result = db.prepare(`
          INSERT INTO entity_triples (subject_entity_id, predicate, object_entity_id, object_literal, valid_from, valid_to, confidence, source_doc_id, source_fact, created_at, agent_id, session_id, source_type, written_at, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          subjectEntityId, pred, objectEntityId, objectLiteral,
          options?.validFrom ?? null, options?.validTo ?? null,
          options?.confidence ?? 1.0, options?.sourceDocId ?? null,
          options?.sourceFact ?? null, writtenAt,
          options?.witness?.agentId ?? null, options?.witness?.sessionId ?? null,
          options?.witness?.source ?? null, writtenAt, tagsJson
        );
        const tripleId = Number(result.lastInsertRowid);
        insertEvidence(tripleId);
        return tripleId;
      });
      return txn.immediate() as number;
    },

    invalidateTriple: (subjectEntityId: string, predicate: string, objectEntityId: string | null, objectLiteral: string | null, endedDate?: string) => {
      const pred = predicate.toLowerCase().replace(/\s+/g, "_");
      const ended = endedDate || new Date().toISOString().slice(0, 10);
      const objClause = objectEntityId
        ? "object_entity_id = ? AND object_literal IS NULL"
        : "object_entity_id IS NULL AND object_literal = ?";
      const objParam = objectEntityId ?? objectLiteral;
      const result = db.prepare(
        `UPDATE entity_triples SET valid_to = ? WHERE subject_entity_id = ? AND predicate = ? AND ${objClause} AND valid_to IS NULL`
      ).run(ended, subjectEntityId, pred, objParam);
      return result.changes;
    },

    queryEntityTriples: (entityId: string, options?: { asOf?: string; direction?: "outgoing" | "incoming" | "both"; includeProvenance?: boolean; provenanceLimit?: number }) => {
      const direction = options?.direction ?? "both";
      const asOf = options?.asOf;
      const results: { id: number; direction: string; subject: string; predicate: string; object: string; validFrom: string | null; validTo: string | null; confidence: number; current: boolean; evidenceCount?: number; sources?: { docId: number | null; collection: string | null; path: string | null; fact: string | null; at: string }[] }[] = [];

      if (direction === "outgoing" || direction === "both") {
        let query = `SELECT t.id, t.predicate, t.object_entity_id, t.object_literal, t.valid_from, t.valid_to, t.confidence,
                      COALESCE(s.name, t.subject_entity_id) as sub_name, COALESCE(o.name, t.object_literal, t.object_entity_id) as obj_name
                     FROM entity_triples t
                     LEFT JOIN entity_nodes s ON t.subject_entity_id = s.entity_id
                     LEFT JOIN entity_nodes o ON t.object_entity_id = o.entity_id
                     WHERE t.subject_entity_id = ?`;
        const params: any[] = [entityId];
        if (asOf) {
          query += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)";
          params.push(asOf, asOf);
        }
        for (const row of db.prepare(query).all(...params) as any[]) {
          results.push({ id: row.id, direction: "outgoing", subject: row.sub_name, predicate: row.predicate, object: row.obj_name, validFrom: row.valid_from, validTo: row.valid_to, confidence: row.confidence, current: row.valid_to === null });
        }
      }

      if (direction === "incoming" || direction === "both") {
        let query = `SELECT t.id, t.predicate, t.valid_from, t.valid_to, t.confidence,
                      COALESCE(s.name, t.subject_entity_id) as sub_name, COALESCE(o.name, t.object_literal, t.object_entity_id) as obj_name
                     FROM entity_triples t
                     LEFT JOIN entity_nodes s ON t.subject_entity_id = s.entity_id
                     LEFT JOIN entity_nodes o ON t.object_entity_id = o.entity_id
                     WHERE t.object_entity_id = ?`;
        const params: any[] = [entityId];
        if (asOf) {
          query += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)";
          params.push(asOf, asOf);
        }
        for (const row of db.prepare(query).all(...params) as any[]) {
          results.push({ id: row.id, direction: "incoming", subject: row.sub_name, predicate: row.predicate, object: row.obj_name, validFrom: row.valid_from, validTo: row.valid_to, confidence: row.confidence, current: row.valid_to === null });
        }
      }

      // Provenance is OPT-IN: the context-surfacing hook calls this per detected prompt entity
      // and discards evidence fields — the default path must not pay these two queries.
      if (options?.includeProvenance && results.length > 0) {
        const provLimit = Math.max(1, options.provenanceLimit ?? 5);
        const tripleIds = [...new Set(results.map(r => r.id))];
        const ph = tripleIds.map(() => "?").join(",");
        const counts = new Map<number, number>();
        for (const row of db.prepare(
          `SELECT triple_id, COUNT(*) AS n FROM entity_triple_provenance WHERE triple_id IN (${ph}) GROUP BY triple_id`
        ).all(...tripleIds) as { triple_id: number; n: number }[]) {
          counts.set(row.triple_id, row.n);
        }
        const sourcesByTriple = new Map<number, { docId: number | null; collection: string | null; path: string | null; fact: string | null; at: string }[]>();
        for (const row of db.prepare(`
          SELECT triple_id, source_doc_id, source_fact, created_at, collection, path FROM (
            SELECT p.triple_id, p.source_doc_id, p.source_fact, p.created_at,
                   d.collection AS collection, d.path AS path,
                   ROW_NUMBER() OVER (PARTITION BY p.triple_id ORDER BY p.created_at DESC, p.id DESC) AS rn
            FROM entity_triple_provenance p
            LEFT JOIN documents d ON d.id = p.source_doc_id
            WHERE p.triple_id IN (${ph})
          ) WHERE rn <= ? ORDER BY triple_id, rn
        `).all(...tripleIds, provLimit) as { triple_id: number; source_doc_id: number | null; source_fact: string | null; created_at: string; collection: string | null; path: string | null }[]) {
          const list = sourcesByTriple.get(row.triple_id) ?? [];
          list.push({ docId: row.source_doc_id, collection: row.collection, path: row.path, fact: row.source_fact, at: row.created_at });
          sourcesByTriple.set(row.triple_id, list);
        }
        for (const r of results) {
          r.evidenceCount = counts.get(r.id) ?? 0;
          r.sources = sourcesByTriple.get(r.id) ?? [];
        }
      }

      return results;
    },

    getTripleStats: () => {
      const total = (db.prepare("SELECT COUNT(*) as n FROM entity_triples").get() as any).n;
      const current = (db.prepare("SELECT COUNT(*) as n FROM entity_triples WHERE valid_to IS NULL").get() as any).n;
      const predicates = db.prepare("SELECT DISTINCT predicate FROM entity_triples ORDER BY predicate").all().map((r: any) => r.predicate);
      return { totalTriples: total, currentFacts: current, expiredFacts: total - current, predicateTypes: predicates };
    },

    /**
     * Cross-agent fact query. Returns facts carrying witness attribution, filterable by
     * subject/predicate/object (each accepts "*"), writer agent(s), session(s), write time
     * (`since`), and confidence. Feeds `fact_query_cross_agent` (MCP) and the optional
     * context-injection layer. When `resolveConflicts` is true, arcs that differ only by
     * witness are merged to the most recent fact (confidence >= minConfidence) per
     * subject/predicate/object — divergence collapse, not deletion.
     */
    queryCrossAgentFacts: (query: CrossAgentQuery): CrossAgentFact[] => {
      const where: string[] = [];
      const params: any[] = [];

      if (query.subject && query.subject !== "*") {
        const sRes = db.prepare("SELECT entity_id FROM entity_nodes WHERE name = ? OR entity_id = ? LIMIT 1").get(query.subject, query.subject) as { entity_id: string } | undefined;
        if (sRes) {
          where.push("t.subject_entity_id = ?");
          params.push(sRes.entity_id);
        } else {
          return [];
        }
      }

      const isWild = (v?: string) => !v || v === "*";
      if (!isWild(query.predicate)) { where.push("LOWER(t.predicate) = LOWER(?)"); params.push(query.predicate!.toLowerCase().replace(/\s+/g, "_")); }
      if (!isWild(query.object)) {
        const obj = query.object as string;
        const oRes = db.prepare("SELECT entity_id FROM entity_nodes WHERE name = ? OR entity_id = ? LIMIT 1").get(obj, obj) as { entity_id: string } | undefined;
        if (oRes) {
          where.push("t.object_entity_id = ?");
          params.push(oRes.entity_id);
        } else {
          where.push("(LOWER(COALESCE(t.object_literal,'')) = LOWER(?) OR EXISTS (SELECT 1 FROM entity_nodes eo WHERE eo.entity_id = t.object_entity_id AND (eo.name = ? OR eo.entity_id = ?)))");
          params.push(obj, obj, obj);
        }
      }
      if (query.since) { where.push("COALESCE(t.written_at, t.created_at) >= ?"); params.push(query.since); }
      if (query.minConfidence != null) { where.push("t.confidence >= ?"); params.push(query.minConfidence); }
      if (query.writtenBy && query.writtenBy.length > 0 && !query.writtenBy.includes("*")) {
        where.push(`t.agent_id IN (${query.writtenBy.map(() => "?").join(",")})`);
        params.push(...query.writtenBy);
      }
      if (query.sessionIds && query.sessionIds.length > 0 && !query.sessionIds.includes("*")) {
        where.push(`t.session_id IN (${query.sessionIds.map(() => "?").join(",")})`);
        params.push(...query.sessionIds);
      }

      const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
      const sql = `
        SELECT t.id, COALESCE(s.name, t.subject_entity_id) AS subject_name, t.subject_entity_id,
               t.predicate, COALESCE(o.name, t.object_literal, t.object_entity_id) AS object_name,
               t.object_entity_id, t.valid_from, t.valid_to, t.confidence,
               COALESCE(t.written_at, t.created_at) AS written_at,
               t.agent_id, t.session_id, t.source_type, t.tags
        FROM entity_triples t
        LEFT JOIN entity_nodes s ON s.entity_id = t.subject_entity_id
        LEFT JOIN entity_nodes o ON o.entity_id = t.object_entity_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY COALESCE(t.written_at, t.created_at) DESC, t.id DESC
        LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as any[];
      const out: CrossAgentFact[] = rows.map((r: any) => ({
        id: r.id,
        subject: r.subject_name,
        subjectEntityId: r.subject_entity_id,
        predicate: r.predicate,
        object: r.object_name,
        objectEntityId: r.object_entity_id ?? null,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        confidence: r.confidence,
        current: r.valid_to === null,
        writtenAt: r.written_at ?? null,
        agentId: r.agent_id ?? null,
        sessionId: r.session_id ?? null,
        sourceType: r.source_type ?? null,
        tags: r.tags ? (() => { try { return JSON.parse(r.tags); } catch { return null; } })() : null,
      }));

      if (query.resolveConflicts) {
        const minConf = query.minConfidence ?? 0;
        const byKey = new Map<string, CrossAgentFact>();
        for (const f of out) {
          if (f.validTo !== null) continue; // only merge current facts
          const key = `${f.subjectEntityId}\u0000${f.predicate}\u0000${f.objectEntityId ?? f.object}`;
          const prev = byKey.get(key);
          if (!prev) { byKey.set(key, f); continue; }
          if (f.confidence >= minConf && (f.writtenAt ?? "") >= (prev.writtenAt ?? "")) {
            byKey.set(key, f);
          }
        }
        return Array.from(byKey.values()).sort((a, b) => (b.writtenAt ?? "").localeCompare(a.writtenAt ?? ""));
      }
      return out;
    },

    // Co-activation tracking
    // Recall tracking: batch insert surfacing events
    insertRecallEvents: (events: { docId: number; queryHash: string; searchScore: number; sessionId: string; usageId?: number; turnIndex?: number; wasReferenced?: boolean }[]) => {
      if (events.length === 0) return 0;
      const stmt = db.prepare(`
        INSERT INTO recall_events (doc_id, query_hash, search_score, session_id, usage_id, turn_index, surfaced_at, was_referenced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        for (const e of events) {
          stmt.run(e.docId, e.queryHash, e.searchScore, e.sessionId, e.usageId ?? null, e.turnIndex ?? 0, now, e.wasReferenced ? 1 : 0);
        }
      });
      tx();
      return events.length;
    },

    // Recall tracking: recompute derived stats from events
    // Uses SQL GROUP BY for aggregation (O(1) queries), then JS for diversity/spacing formulas
    recomputeRecallStats: () => {
      const aggregated = db.prepare(`
        SELECT
          doc_id,
          COUNT(*) AS recall_count,
          COUNT(DISTINCT query_hash) AS unique_queries,
          COUNT(DISTINCT date(surfaced_at, 'utc')) AS recall_days,
          SUM(search_score) AS total_score,
          MAX(search_score) AS max_score,
          SUM(CASE WHEN was_referenced = 0 THEN 1 ELSE 0 END) AS negative_count,
          MIN(surfaced_at) AS first_recalled_at,
          MAX(surfaced_at) AS last_recalled_at,
          GROUP_CONCAT(DISTINCT date(surfaced_at, 'utc')) AS day_list
        FROM recall_events
        GROUP BY doc_id
      `).all() as {
        doc_id: number; recall_count: number; unique_queries: number; recall_days: number;
        total_score: number; max_score: number; negative_count: number;
        first_recalled_at: string; last_recalled_at: string; day_list: string;
      }[];

      if (aggregated.length === 0) return 0;

      const upsert = db.prepare(`
        INSERT INTO recall_stats (doc_id, recall_count, unique_queries, recall_days, total_score, max_score,
          first_recalled_at, last_recalled_at, diversity_score, spacing_score, negative_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          recall_count = excluded.recall_count,
          unique_queries = excluded.unique_queries,
          recall_days = excluded.recall_days,
          total_score = excluded.total_score,
          max_score = excluded.max_score,
          first_recalled_at = excluded.first_recalled_at,
          last_recalled_at = excluded.last_recalled_at,
          diversity_score = excluded.diversity_score,
          spacing_score = excluded.spacing_score,
          negative_count = excluded.negative_count,
          updated_at = excluded.updated_at
      `);

      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        for (const row of aggregated) {
          // Diversity: clamped max(uniqueQueries, recallDays) / 5
          const diversityScore = Math.min(1, Math.max(row.unique_queries, row.recall_days) / 5);

          // Spacing: multi-day spread
          let spacingScore = 0;
          if (row.recall_days > 1 && row.day_list) {
            const days = row.day_list.split(",").sort();
            const spacing = Math.min(1, Math.log1p(days.length - 1) / Math.log1p(4));
            const firstDay = new Date(days[0]! + "T00:00:00Z").getTime();
            const lastDay = new Date(days[days.length - 1]! + "T00:00:00Z").getTime();
            const spanDays = Math.max(0, (lastDay - firstDay) / (24 * 60 * 60 * 1000));
            const span = Math.min(1, spanDays / 7);
            spacingScore = Math.min(1, 0.55 * spacing + 0.45 * span);
          } else if (row.recall_days === 1) {
            spacingScore = 0.2;
          }

          upsert.run(
            row.doc_id, row.recall_count, row.unique_queries, row.recall_days,
            row.total_score, row.max_score,
            row.first_recalled_at, row.last_recalled_at,
            diversityScore, spacingScore, row.negative_count, now
          );
        }
      });
      tx();
      return aggregated.length;
    },

    getRecallStats: (docId: number) => {
      const row = db.prepare(`SELECT * FROM recall_stats WHERE doc_id = ?`).get(docId) as any;
      if (!row) return null;
      return {
        docId: row.doc_id,
        recallCount: row.recall_count,
        uniqueQueries: row.unique_queries,
        recallDays: row.recall_days,
        totalScore: row.total_score,
        maxScore: row.max_score,
        firstRecalledAt: row.first_recalled_at,
        lastRecalledAt: row.last_recalled_at,
        diversityScore: row.diversity_score,
        spacingScore: row.spacing_score,
        negativeCount: row.negative_count,
        updatedAt: row.updated_at,
      } as RecallStatsRow;
    },

    getRecallStatsAll: (minRecallCount: number = 1) => {
      return (db.prepare(`
        SELECT rs.*, d.collection, d.path, d.title
        FROM recall_stats rs
        JOIN documents d ON rs.doc_id = d.id
        WHERE rs.recall_count >= ? AND d.active = 1
        ORDER BY rs.recall_count DESC
      `).all(minRecallCount) as any[]).map(row => ({
        docId: row.doc_id,
        recallCount: row.recall_count,
        uniqueQueries: row.unique_queries,
        recallDays: row.recall_days,
        totalScore: row.total_score,
        maxScore: row.max_score,
        firstRecalledAt: row.first_recalled_at,
        lastRecalledAt: row.last_recalled_at,
        diversityScore: row.diversity_score,
        spacingScore: row.spacing_score,
        negativeCount: row.negative_count,
        updatedAt: row.updated_at,
        collection: row.collection,
        path: row.path,
        title: row.title,
      } as RecallStatsRow));
    },

    markRecallEventsReferenced: (sessionId: string, docIds: number[]) => {
      if (docIds.length === 0) return;
      // Mark only the LATEST event per doc in this session, not all events.
      // This preserves negative signals: if a doc was surfaced across 5 prompts
      // but only cited once, 4 events stay was_referenced=0 (genuine negatives).
      const stmt = db.prepare(`
        UPDATE recall_events SET was_referenced = 1
        WHERE id = (
          SELECT id FROM recall_events
          WHERE session_id = ? AND doc_id = ?
          ORDER BY surfaced_at DESC
          LIMIT 1
        )
      `);
      const tx = db.transaction(() => {
        for (const docId of docIds) {
          stmt.run(sessionId, docId);
        }
      });
      tx();
    },

    recordCoActivation: (paths: string[]) => {
      if (paths.length < 2) return;
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO co_activations (doc_a, doc_b, count, last_seen)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(doc_a, doc_b) DO UPDATE SET
          count = count + 1,
          last_seen = excluded.last_seen
      `);
      // Record all pairs (order-independent: always store sorted)
      for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
          const sorted = [paths[i]!, paths[j]!].sort();
          stmt.run(sorted[0]!, sorted[1]!, now);
        }
      }
    },
    getCoActivated: (path: string, limit: number = 5) => {
      return db.prepare(`
        SELECT
          CASE WHEN doc_a = ? THEN doc_b ELSE doc_a END as path,
          count
        FROM co_activations
        WHERE doc_a = ? OR doc_b = ?
        ORDER BY count DESC
        LIMIT ?
      `).all(path, path, path, limit) as { path: string; count: number }[];
    },

    // Usage relation tracking — records relations between documents
    insertRelation: (fromDoc: number, toDoc: number, relType: string, weight: number = 1.0) => {
      // v0.8.3 (§1.3): reject self-loops at the API boundary. A document
      // relating to itself has no informational value for graph traversal
      // and would pollute intent_search/find_similar neighborhoods.
      if (fromDoc === toDoc) return;
      db.prepare(`
        INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET
          weight = weight + excluded.weight,
          created_at = excluded.created_at
      `).run(fromDoc, toDoc, relType, weight, new Date().toISOString());
    },

    // Engram integration: unified save API for hook-generated memories
    saveMemory: (params: SaveMemoryParams) => saveMemory(db, params),
    hashNormalized,

    // Engram integration: temporal timeline
    timeline: (docId: number, options?) => timeline(db, docId, options),

    // Document archival — deactivates documents by ID
    archiveDocuments: (ids: number[]) => {
      if (ids.length === 0) return 0;
      const now = new Date().toISOString();
      const placeholders = ids.map(() => "?").join(",");
      // `result.changes` is NOT the number of documents archived: the `documents_fts`
      // triggers fire on this UPDATE and their shadow-table writes inflate the count
      // (3 documents reported as 16). Count the matching rows explicitly, in the same
      // transaction, so the number returned is the outcome rather than a side-effect total.
      return db.transaction(() => {
        const row = db.prepare(`
          SELECT COUNT(*) AS n FROM documents WHERE id IN (${placeholders}) AND active = 1
        `).get(...ids) as { n: number } | undefined;
        db.prepare(`
          UPDATE documents SET active = 0, archived_at = ?, deactivated_reason = 'archive'
          WHERE id IN (${placeholders}) AND active = 1
        `).run(now, ...ids);
        return row?.n ?? 0;
      })();
    },

    // Lifecycle management
    getArchiveCandidates: (policy) => getArchiveCandidatesFn(db, policy),
    restoreArchivedDocuments: (filter) => restoreArchivedDocumentsFn(db, filter),
    getLifecycleStats: () => getLifecycleStatsFn(db),
    searchArchived: (query, limit?) => searchArchivedFn(db, query, limit),
  };
}

// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Unified document result type with all metadata.
 * Body is optional - use getDocumentBody() to load it separately if needed.
 */
export type DocumentResult = {
  filepath: string;           // Full filesystem path
  displayPath: string;        // Short display path (e.g., "docs/readme.md")
  title: string;              // Document title (from first heading or filename)
  context: string | null;     // Folder context description if configured
  hash: string;               // Content hash for caching/change detection
  docid: string;              // Short docid (first 6 chars of hash) for quick reference
  collectionName: string;     // Parent collection name
  modifiedAt: string;         // Last modification timestamp
  bodyLength: number;         // Body length in bytes (useful before loading)
  body?: string;              // Document body (optional, load with getDocumentBody)
};

/**
 * Extract short docid from a full hash (first 6 characters).
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

/**
 * Handelize a filename to be more token-friendly.
 * - Convert triple underscore `___` to `/` (folder separator)
 * - Convert to lowercase
 * - Replace sequences of non-word chars (except /) with single dash
 * - Remove leading/trailing dashes from path segments
 * - Preserve folder structure (a/b/c/d.md stays structured)
 * - Preserve file extension
 */
export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  // Check for paths that are just extensions or only dots/special chars
  // A valid path must have at least one letter or digit (including Unicode)
  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')       // Triple underscore becomes folder separator
    .toLowerCase()
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;

      if (isLastSegment) {
        // For the filename (last segment), preserve the extension
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;

        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}]+/gu, '-')  // Replace non-letter/digit chars with dash
          .replace(/^-+|-+$/g, ''); // Remove leading/trailing dashes

        return cleanedName + ext;
      } else {
        // For directories, just clean normally
        return segment
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}

/**
 * Search result extends DocumentResult with score and source info
 */
export type SearchResult = DocumentResult & {
  score: number;              // Relevance score (0-1)
  source: "fts" | "vec";      // Search source (full-text or vector)
  chunkPos?: number;          // Character position of matching chunk (for vector search)
  fragmentType?: string;      // Fragment type (section, list, code, frontmatter, fact, narrative)
  fragmentLabel?: string;     // Fragment label (heading text, fm key, etc.)
};

/**
 * Ranked result for RRF fusion (simplified, used internally)
 */
export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
};

/**
 * Error result when document is not found
 */
export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};

/**
 * Result from multi-get operations
 */
export type MultiGetResult = {
  doc: DocumentResult;
  skipped: false;
} | {
  doc: Pick<DocumentResult, "filepath" | "displayPath">;
  skipped: true;
  skipReason: string;
};

export type CollectionInfo = {
  name: string;
  path: string;
  pattern: string;
  documents: number;
  lastUpdated: string;
};

export type IndexStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: CollectionInfo[];
};

// =============================================================================
// SAME: Agent Memory Types
// =============================================================================

export type SessionRecord = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  handoffPath: string | null;
  machine: string | null;
  filesChanged: string[];
  summary: string | null;
};

export type UsageRecord = {
  sessionId: string;
  timestamp: string;
  hookName: string;
  injectedPaths: string[];
  estimatedTokens: number;
  wasReferenced: number;
  turnIndex?: number;
  /**
   * v0.8.1 Ext 6b: raw user prompt for this turn. Written when the caller
   * wants the row to be usable for multi-turn lookback retrieval. Persisted
   * via `insertUsageFn` only when the `query_text` column is present on
   * `context_usage` (pre-migration stores degrade to "no prior query").
   */
  queryText?: string;
};

export type UsageRow = {
  id: number;
  sessionId: string;
  timestamp: string;
  hookName: string;
  injectedPaths: string;
  estimatedTokens: number;
  wasReferenced: number;
  turnIndex: number;
};

export type RecallStatsRow = {
  docId: number;
  recallCount: number;
  uniqueQueries: number;
  recallDays: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: string | null;
  lastRecalledAt: string | null;
  diversityScore: number;
  spacingScore: number;
  negativeCount: number;
  updatedAt: string;
  // Joined from documents (only populated by getRecallStatsAll)
  collection?: string;
  path?: string;
  title?: string;
};

export type DocumentRow = {
  id: number;
  collection: string;
  path: string;
  title: string;
  hash: string;
  modifiedAt: string;
  authoredAt: string | null;  // §51.1: authorship time; null = unknown
  effectiveAt: string;        // §51.1: COALESCE(authored_at, modified_at) — content time
  domain: string | null;
  workstream: string | null;
  tags: string | null;
  contentType: string;
  reviewBy: string | null;
  confidence: number;
  accessCount: number;
  bodyLength: number;
  pinned: number;
};

// =============================================================================
// Index health
// =============================================================================

export function getHashesNeedingEmbedding(db: Database): number {
  const result = db.prepare(`
    SELECT COUNT(DISTINCT d.hash) as count
    FROM documents d
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
  `).get() as { count: number };
  return result.count;
}

export type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};

export function getIndexHealth(db: Database): IndexHealthInfo {
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const totalDocs = (db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number }).count;

  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };
  let daysStale: number | null = null;
  if (mostRecent?.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    daysStale = Math.floor((Date.now() - lastUpdate.getTime()) / (24 * 60 * 60 * 1000));
  }

  return { needsEmbedding, totalDocs, daysStale };
}

// =============================================================================
// Caching
// =============================================================================

export function getCacheKey(url: string, body: object): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(url);
  hash.update(JSON.stringify(body));
  return hash.digest("hex");
}

export function getCachedResult(db: Database, cacheKey: string): string | null {
  const row = db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(cacheKey) as { result: string } | null;
  return row?.result || null;
}

export function setCachedResult(db: Database, cacheKey: string, result: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, result, created_at) VALUES (?, ?, ?)`).run(cacheKey, result, now);
  if (Math.random() < 0.01) {
    db.exec(`DELETE FROM llm_cache WHERE hash NOT IN (SELECT hash FROM llm_cache ORDER BY created_at DESC LIMIT 1000)`);
  }
}

export function clearCache(db: Database): void {
  db.exec(`DELETE FROM llm_cache`);
}

// =============================================================================
// Cleanup and maintenance operations
// =============================================================================

/**
 * Delete cached LLM API responses.
 * Returns the number of cached responses deleted.
 */
export function deleteLLMCache(db: Database): number {
  const result = db.prepare(`DELETE FROM llm_cache`).run();
  return result.changes;
}

// NOTE: `deleteInactiveDocuments` was removed in v0.30.0. It ran
// `DELETE FROM documents WHERE active = 0` — strictly broader than the retention purge,
// since it destroyed every inactive row (archived AND forgotten) with no age restriction
// and no authorization. It had no callers, but sat on the public `Store` interface, so any
// holder of a store could invoke it. Deactivation must stay reversible; see the retention
// note on the removed purge helper below.

/**
 * Remove content rows that no document references at all.
 *
 * The predicate must consider EVERY document, not just active ones. `documents.hash` is
 * `ON DELETE CASCADE` on `content(hash)`, so deleting content still referenced by an
 * archived or forgotten document destroys that document row too — a hard delete reached
 * indirectly, which is exactly what the retention rule forbids. Scoping to `active = 1`
 * did that: one archived document plus a cleanup call left zero documents.
 *
 * With the predicate below no cascade is possible, because nothing references the rows it
 * removes. Returns the number of orphaned content rows deleted.
 */
export function cleanupOrphanedContent(db: Database): number {
  const result = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents)
  `).run();
  return result.changes;
}

// (Removed cleanupOrphanedVectors — an exposed, unfenced, non-transactional vector
// mutation with no production caller. Use cleanStaleEmbeddings, which is lease-fenced
// and atomic. See INCIDENT-2026-06-22 / codex review.)

/**
 * Run VACUUM to reclaim unused space in the database.
 * This operation rebuilds the database file to eliminate fragmentation.
 */
export function vacuumDatabase(db: Database): void {
  db.exec(`VACUUM`);
}

// =============================================================================
// Canonical Document Identity
// =============================================================================

/**
 * Deterministic document identity hash: hash(collection + "/" + path).
 * Stable across content changes — tracks document identity, not content.
 */
export function canonicalDocId(collection: string, path: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(collection + "/" + path);
  return h.digest("hex").slice(0, 16);
}

/**
 * Remove stale embeddings: content_vectors rows whose hash no longer belongs
 * to any active document. Also cleans the corresponding vectors_vec rows.
 * Returns the number of stale embeddings removed.
 */
export function cleanStaleEmbeddings(db: Database, leaseGuard?: LeaseGuard): number {
  // Atomic + lease-fenced: the ownership check and the deletes share one transaction
  // so a process that lost its lease cannot delete vectors out from under the new holder.
  return db.transaction(() => {
    assertLeaseHeld(db, leaseGuard);
    // Find orphaned hashes in content_vectors that have no active document
    const staleRows = db.prepare(`
      SELECT DISTINCT cv.hash
      FROM content_vectors cv
      LEFT JOIN documents d ON d.hash = cv.hash AND d.active = 1
      WHERE d.id IS NULL
    `).all() as { hash: string }[];

    if (staleRows.length === 0) return 0;

    const staleHashes = staleRows.map(r => r.hash);

    // Get all hash_seq keys for stale rows to clean vectors_vec
    const placeholders = staleHashes.map(() => '?').join(',');
    const staleVecKeys = db.prepare(`
      SELECT hash || '_' || seq as hash_seq FROM content_vectors WHERE hash IN (${placeholders})
    `).all(...staleHashes) as { hash_seq: string }[];

    // Delete from vectors_vec
    if (staleVecKeys.length > 0) {
      const vecPlaceholders = staleVecKeys.map(() => '?').join(',');
      db.prepare(`DELETE FROM vectors_vec WHERE hash_seq IN (${vecPlaceholders})`).run(...staleVecKeys.map(r => r.hash_seq));
    }

    // Delete from content_vectors
    db.prepare(`DELETE FROM content_vectors WHERE hash IN (${placeholders})`).run(...staleHashes);

    return staleVecKeys.length;
  }).immediate(); // immediate write lock: assert ownership under the lock before the deletes
}

// =============================================================================
// Document helpers
// =============================================================================

export async function hashContent(content: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(content);
  return hash.digest("hex");
}

export function extractTitle(content: string, filename: string): string {
  const match = content.match(/^##?\s+(.+)$/m);
  if (match) {
    const title = (match[1] ?? "").trim();
    if (title === "📝 Notes" || title === "Notes") {
      const nextMatch = content.match(/^##\s+(.+)$/m);
      if (nextMatch?.[1]) return nextMatch[1].trim();
    }
    return title;
  }
  return filename.replace(/\.md$/, "").split("/").pop() || filename;
}

// =============================================================================
// Document indexing operations
// =============================================================================

/**
 * Insert content into the content table (content-addressable storage).
 * Uses INSERT OR IGNORE so duplicate hashes are skipped.
 */
export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
}

/**
 * Insert a new document into the documents table.
 */
/**
 * Who owns a document row's lifecycle (origin-aware reconciliation).
 * 'fs'  — created/maintained by the filesystem indexer; reconciled against disk.
 * 'api' — DB-born (hooks, saveMemory, beads sync, REST); no backing file BY DESIGN, so
 *         filesystem absence means nothing and the reconciler must never deactivate it.
 * NULL  — ambiguous legacy row (pre-migration); exempt from reconciliation, adopted by the
 *         next writer to touch it (indexer → 'fs', saveMemory → 'api'). Never inferred.
 */
export type DocumentOrigin = "fs" | "api";

export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string,
  origin: DocumentOrigin = "api"
): void {
  // Guard: gray-matter can coerce YAML values to Date/boolean/null — SQLite rejects these
  const safeTitle = (typeof title === "string") ? title : String(title ?? "Untitled");
  // origin defaults to 'api': a caller this parameter has not reached yet becomes exempt
  // from filesystem reconciliation — stale-active at worst, never a destroyed DB-born row.
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, origin)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(collectionName, path, safeTitle, hash, createdAt, modifiedAt, origin);
}

// =============================================================================
// Engram Integration: Dedup Hash & Unified Save API
// =============================================================================

/**
 * Compute a normalized hash for dedup comparison.
 * Lowercases, collapses whitespace, trims — so cosmetic formatting changes
 * don't create false negatives.
 */
export function hashNormalized(content: string): string {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(normalized);
  return hasher.digest("hex");
}

/**
 * Parameters for the unified saveMemory API.
 * Used by hooks (decision-extractor, handoff-generator) to write
 * agent-generated observations with dedup protection.
 */
export type SaveMemoryParams = {
  collection: string;
  path: string;
  title: string;
  body: string;
  contentType: string;
  confidence?: number;
  qualityScore?: number;
  /** Stable semantic payload for dedup hashing. If omitted, uses body. */
  semanticPayload?: string;
  /** Topic key for future upsert support (Phase 2). */
  topicKey?: string;
  /**
   * §51.1: when the content was originally written (UTC ISO), as opposed to
   * created_at/modified_at which stay filing/update time. Validated strictly;
   * invalid values are treated as absent. Advances monotonically on dedup and
   * path-conflict updates (a newer repeated assertion moves it forward;
   * reprocessing older evidence never regresses it).
   */
  authoredAt?: string;
};

export type SaveMemoryResult = {
  action: 'inserted' | 'deduplicated' | 'updated';
  docId: number;
  duplicateCount?: number;
  revisionCount?: number;
};

/**
 * Unified save API for agent-generated memories (hook output).
 *
 * Dedup logic (from Engram's AddObservation pattern):
 * 1. Compute normalized_hash from semanticPayload (or body)
 * 2. Check dedup window: same normalized_hash + collection + content_type
 *    within DEDUP_WINDOW_MINUTES → increment duplicate_count, skip insert
 * 3. Otherwise insert new document with metadata
 *
 * This function does NOT apply to file-backed indexing (indexer.ts).
 * File-backed docs use the existing insertDocument/updateDocument path
 * which preserves path-based identity.
 */
const DEDUP_WINDOW_MINUTES = 30;

export function saveMemory(db: Database, params: SaveMemoryParams): SaveMemoryResult {
  const now = new Date().toISOString();
  const authoredAt = normalizeIsoTimestamp(params.authoredAt);
  const payload = params.semanticPayload || params.body;
  const normHash = hashNormalized(payload);
  const bodyHasher = new Bun.CryptoHasher("sha256");
  bodyHasher.update(params.body);
  const bodyHash = bodyHasher.digest("hex");

  // --- Ownership + lifecycle preflight (before ANY write, including dedup's counters) ---
  // Rejecting later would leak writes: an orphaned content row on a rejected insert, or a
  // dedup counter bump on a row the caller had no claim to. Rules: an ACTIVE
  // filesystem-owned row is never overwritten (this function's contract excludes file-backed
  // indexing — API content masquerading as the unchanged file would never be re-read past
  // the indexer's content-hash short-circuit, and file removal would absence-deactivate it).
  // An INACTIVE row at the path is a lifecycle state — forget/archive are memory decisions
  // (§55.6 D9) and an absence-deactivated row's recovery is a deliberate operation — so it
  // is neither overwritten nor resurrected; it also occupies UNIQUE(collection, path), where
  // a blind insert would orphan the content row on the rethrow. NULL-origin ACTIVE rows are
  // claimable — saveMemory touching one IS the proof of API ownership; content_hash proves
  // nothing (mined imports write it too).
  const pathRow = db.prepare(
    `SELECT origin, active, deactivated_reason FROM documents WHERE collection = ? AND path = ?`
  ).get(params.collection, params.path) as
    { origin: string | null; active: number; deactivated_reason: string | null } | null;
  if (pathRow) {
    if (pathRow.active === 1 && pathRow.origin === "fs") {
      throw new Error(
        `saveMemory: path collision with a filesystem-owned document ` +
        `(${params.collection}/${params.path}) — refusing to overwrite. ` +
        `Write API memories to a path the filesystem indexer does not own.`,
      );
    }
    if (pathRow.active === 0) {
      throw new Error(
        `saveMemory: path is occupied by an inactive document ` +
        `(${params.collection}/${params.path}, deactivated_reason=${pathRow.deactivated_reason ?? "null"}) — ` +
        `lifecycle decisions are not overwritten. Write to a new path, or restore the ` +
        `document deliberately first.`,
      );
    }
  }

  // --- Dedup check: same normalized_hash within window ---
  // Candidates are restricted to API-claimable rows: a filesystem-owned row is never a dedup
  // target (it also never carries a normalized_hash today — belt and suspenders), and a
  // NULL-origin candidate is adopted 'api' by the counter update (touch-adoption).
  const dedupRow = db.prepare(`
    SELECT id, duplicate_count
    FROM documents
    WHERE active = 1
      AND collection = ?
      AND content_type = ?
      AND normalized_hash = ?
      AND (origin IS NULL OR origin = 'api')
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    params.collection,
    params.contentType,
    normHash,
    `-${DEDUP_WINDOW_MINUTES} minutes`
  ) as { id: number; duplicate_count: number } | null;

  if (dedupRow) {
    // Increment duplicate_count and update last_seen_at. §51.1: a validated
    // incoming authorship advances authored_at monotonically (CASE, not scalar
    // MAX — MAX(NULL, x) is NULL in SQLite and could never populate an
    // initially unknown row); absent incoming leaves the column untouched.
    //
    // The UPDATE re-checks ownership ATOMICALLY: between the SELECT above and this
    // statement, another process (the indexer) may adopt a NULL candidate as 'fs' —
    // stamping 'api' over that fresh declaration would be a silent ownership overwrite.
    // Zero changes means the candidate was claimed mid-flight; the call falls through to
    // the transactional write phase, which revalidates the requested path (insert, an
    // API-owned update, or rejection via the conflict handling).
    let dedupChanges: number;
    if (authoredAt) {
      dedupChanges = db.prepare(`
        UPDATE documents
        SET duplicate_count = duplicate_count + 1,
            last_seen_at = ?,
            origin = 'api',
            authored_at = CASE WHEN authored_at IS NULL OR authored_at < ? THEN ? ELSE authored_at END
        WHERE id = ? AND active = 1 AND (origin IS NULL OR origin = 'api')
      `).run(now, authoredAt, authoredAt, dedupRow.id).changes;
    } else {
      dedupChanges = db.prepare(`
        UPDATE documents
        SET duplicate_count = duplicate_count + 1,
            last_seen_at = ?,
            origin = 'api'
        WHERE id = ? AND active = 1 AND (origin IS NULL OR origin = 'api')
      `).run(now, dedupRow.id).changes;
    }

    if (dedupChanges > 0) {
      return {
        action: 'deduplicated',
        docId: dedupRow.id,
        duplicateCount: dedupRow.duplicate_count + 1,
      };
    }
    // Candidate lost to a concurrent ownership claim — fall through to the write phase.
  }

  // --- Write phase (transactional) ---
  // Content insert + document insert + the conflict path run in ONE transaction, so a race
  // rejection (the indexer claiming the path between preflight and insert) rolls the content
  // row back instead of leaking an orphan. Bun's Database.transaction nests via savepoints,
  // so a caller-held transaction is safe.
  const writePhase = db.transaction((): SaveMemoryResult => {
    // Store content
    db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
      .run(bodyHash, params.body, now);

    // Insert document row
    try {
      db.prepare(`
        INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active,
                               content_type, confidence, quality_score, normalized_hash,
                               duplicate_count, revision_count, last_seen_at, topic_key, authored_at,
                               origin)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'api')
      `).run(
        params.collection,
        params.path,
        params.title,
        bodyHash,
        now,
        now,
        params.contentType,
        params.confidence ?? 0.5,
        params.qualityScore ?? 0.5,
        normHash,
        now,
        params.topicKey ?? null,
        authoredAt,
      );
    } catch (err: any) {
      // UNIQUE(collection, path) conflict — update existing row
      if (err?.message?.includes("UNIQUE constraint")) {
        const existing = db.prepare(
          "SELECT id, origin FROM documents WHERE collection = ? AND path = ? AND active = 1"
        ).get(params.collection, params.path) as { id: number; origin: string | null } | null;

        if (existing) {
          // Race guard for the ownership preflight above: the indexer may have claimed this
          // path between the preflight and the insert. Same rule — an explicit 'fs' owner is
          // never overwritten (the throw rolls this transaction back, content row included);
          // NULL stays claimable and the update below stamps 'api'.
          if (existing.origin === "fs") {
            throw new Error(
              `saveMemory: path collision with a filesystem-owned document ` +
              `(${params.collection}/${params.path}) — refusing to overwrite. ` +
              `Write API memories to a path the filesystem indexer does not own.`,
            );
          }
          // §51.1: same monotonic authored_at advancement as the dedup branch. The update
          // also stamps origin='api': saveMemory touching the row IS proof of API ownership,
          // healing legacy NULL-origin rows on their next write.
          const authoredSet = authoredAt
            ? ", authored_at = CASE WHEN authored_at IS NULL OR authored_at < ? THEN ? ELSE authored_at END"
            : "";
          const updateVals: (string | number | null)[] = [
            bodyHash, params.title, now, params.contentType,
            params.confidence ?? 0.5, params.qualityScore ?? 0.5, normHash,
            now,
          ];
          if (authoredAt) updateVals.push(authoredAt, authoredAt);
          updateVals.push(existing.id);
          db.prepare(`
            UPDATE documents
            SET hash = ?, title = ?, modified_at = ?, content_type = ?,
                confidence = ?, quality_score = ?, normalized_hash = ?,
                revision_count = revision_count + 1, last_seen_at = ?, origin = 'api'${authoredSet}
            WHERE id = ?
          `).run(...updateVals);

          const updated = db.prepare("SELECT revision_count FROM documents WHERE id = ?")
            .get(existing.id) as { revision_count: number } | null;

          return {
            action: 'updated',
            docId: existing.id,
            revisionCount: updated?.revision_count ?? 1,
          };
        }
      }
      throw err;
    }

    // Get the inserted row ID
    const newDoc = db.prepare(
      "SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1"
    ).get(params.collection, params.path) as { id: number } | null;

    return {
      action: 'inserted',
      docId: newDoc?.id ?? -1,
    };
  });
  return writePhase();
}

// =============================================================================
// Engram Integration: Timeline
// =============================================================================

export type TimelineEntry = {
  id: number;
  collection: string;
  path: string;
  title: string;
  contentType: string;
  modifiedAt: string;
  isFocus: boolean;
};

export type TimelineResult = {
  focus: TimelineEntry;
  before: TimelineEntry[];
  after: TimelineEntry[];
  totalInRange: number;
  sessionId?: string;
  sessionSummary?: string;
};

/**
 * Get the temporal neighborhood around a document.
 * Returns N documents before and after the focus, ordered by (modified_at, id).
 * Optionally constrained to the same collection (like Engram's session scoping).
 */
export function timeline(
  db: Database,
  docId: number,
  options?: { before?: number; after?: number; sameCollection?: boolean }
): TimelineResult {
  const before = options?.before ?? 5;
  const after = options?.after ?? 5;
  const sameCollection = options?.sameCollection ?? false;

  // 1. Get focus document
  const focusRow = db.prepare(`
    SELECT id, collection, path, title, content_type, modified_at
    FROM documents WHERE id = ? AND active = 1
  `).get(docId) as { id: number; collection: string; path: string; title: string; content_type: string; modified_at: string } | null;

  if (!focusRow) {
    throw new Error(`Timeline: document #${docId} not found or inactive`);
  }

  const focus: TimelineEntry = {
    id: focusRow.id,
    collection: focusRow.collection,
    path: focusRow.path,
    title: focusRow.title,
    contentType: focusRow.content_type,
    modifiedAt: focusRow.modified_at,
    isFocus: true,
  };

  // 2. Build collection filter (split queries per Codex review — avoid OR NULL in WHERE)
  const collFilter = sameCollection ? "AND collection = ?" : "";
  const collArgs = sameCollection ? [focusRow.collection] : [];

  // 3. Before: documents modified before focus, closest first, compound ordering
  const beforeRows = db.prepare(`
    SELECT id, collection, path, title, content_type, modified_at
    FROM documents
    WHERE active = 1
      AND (modified_at < ? OR (modified_at = ? AND id < ?))
      ${collFilter}
    ORDER BY modified_at DESC, id DESC
    LIMIT ?
  `).all(focusRow.modified_at, focusRow.modified_at, focusRow.id, ...collArgs, before) as typeof focusRow[];

  // Reverse to chronological order (oldest first)
  beforeRows.reverse();

  // 4. After: documents modified after focus, closest first
  const afterRows = db.prepare(`
    SELECT id, collection, path, title, content_type, modified_at
    FROM documents
    WHERE active = 1
      AND (modified_at > ? OR (modified_at = ? AND id > ?))
      ${collFilter}
    ORDER BY modified_at ASC, id ASC
    LIMIT ?
  `).all(focusRow.modified_at, focusRow.modified_at, focusRow.id, ...collArgs, after) as typeof focusRow[];

  // 5. Count total in range (same collection or all)
  const countSql = sameCollection
    ? "SELECT COUNT(*) as cnt FROM documents WHERE active = 1 AND collection = ?"
    : "SELECT COUNT(*) as cnt FROM documents WHERE active = 1";
  const countRow = (sameCollection
    ? db.prepare(countSql).get(focusRow.collection)
    : db.prepare(countSql).get()
  ) as { cnt: number };

  // 6. Session correlation: check if focus falls within a tracked session
  const sessionRow = db.prepare(`
    SELECT session_id, summary FROM session_log
    WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
    LIMIT 1
  `).get(focusRow.modified_at, focusRow.modified_at) as { session_id: string; summary: string | null } | null;

  const toEntry = (r: typeof focusRow): TimelineEntry => ({
    id: r.id, collection: r.collection, path: r.path,
    title: r.title, contentType: r.content_type,
    modifiedAt: r.modified_at, isFocus: false,
  });

  return {
    focus,
    before: beforeRows.map(toEntry),
    after: afterRows.map(toEntry),
    totalInRange: countRow.cnt,
    sessionId: sessionRow?.session_id,
    sessionSummary: sessionRow?.summary ?? undefined,
  };
}

/**
 * Find an active document by collection name and path.
 */
export function findActiveDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string; pinned: number; snoozed_until: string | null; confidence: number } | null {
  return db.prepare(`
    SELECT id, hash, title, pinned, snoozed_until, confidence FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as { id: number; hash: string; title: string; pinned: number; snoozed_until: string | null; confidence: number } | null;
}

/**
 * Find a document by collection and path, regardless of active status.
 * Used to detect inactive rows that block re-insertion (UNIQUE constraint).
 */
export function findAnyDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string; active: number } | null {
  return db.prepare(`
    SELECT id, hash, title, active FROM documents
    WHERE collection = ? AND path = ?
  `).get(collectionName, path) as { id: number; hash: string; title: string; active: number } | null;
}

/**
 * Reactivate an inactive document with updated content.
 */
export function reactivateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string
): boolean {
  const safeTitle = (typeof title === "string") ? title : String(title ?? "Untitled");
  // The reset_embed_on_hash_change trigger resets embed_state/attempts/error iff the
  // hash actually changes, so re-adding unchanged content preserves its valid vectors.
  //
  // §55.6 D9: every successful active=1 writer clears the deactivation provenance — but this
  // generic reactivator must not overrule a lifecycle decision. `updateProfile` calls it on any
  // inactive profile row during a routine `clawmem update` (src/profile.ts), so without the
  // predicate a forgotten profile came back on the next index — and an archived one came back
  // still carrying `archived_at`, recreating the exact inconsistent state the migration repairs.
  // Restoring an archived document is `restoreArchivedDocuments`' job, not this function's.
  const result = db.prepare(
    `UPDATE documents SET active = 1, title = ?, hash = ?, modified_at = ?, deactivated_reason = NULL
     WHERE id = ? AND (deactivated_reason IS NULL OR deactivated_reason = 'absent')`,
  ).run(safeTitle, hash, modifiedAt, documentId);
  return result.changes > 0;
}

/**
 * Update the title and modified_at timestamp for a document.
 */
export function updateDocumentTitle(
  db: Database,
  documentId: number,
  title: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, modified_at = ? WHERE id = ?`)
    .run(title, modifiedAt, documentId);
}

/**
 * Update an existing document's hash, title, and modified_at timestamp.
 * Used when content changes but the file path stays the same.
 */
export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string
): void {
  const safeTitle = (typeof title === "string") ? title : String(title ?? "Untitled");
  // The reset_embed_on_hash_change trigger resets embed_state/attempts/error when the
  // hash actually changes, so this only needs to set the content fields.
  db.prepare(`UPDATE documents SET title = ?, hash = ?, modified_at = ? WHERE id = ?`)
    .run(safeTitle, hash, modifiedAt, documentId);
}

/**
 * Why a document was deactivated (§55.6 D9). Only `'absent'` is reversible by the indexer;
 * `'forget'` and `'archive'` are lifecycle decisions it must never undo.
 */
export type DeactivationReason = "absent" | "forget" | "archive";

/**
 * Deactivate a document (mark as inactive but don't delete).
 *
 * `reason` is required because this one function serves two unrelated owners — the indexer's
 * absence loop and the MCP/REST forget path — and the indexer's reactivate branch keys on it.
 * Defaulting it would silently re-open the bug it exists to close.
 */
export function deactivateDocument(
  db: Database,
  collectionName: string,
  path: string,
  reason: DeactivationReason,
): void {
  db.prepare(`UPDATE documents SET active = 0, deactivated_reason = ? WHERE collection = ? AND path = ? AND active = 1`)
    .run(reason, collectionName, path);
}

/**
 * Get all active document paths for a collection.
 */
export function getActiveDocumentPaths(db: Database, collectionName: string): string[] {
  const rows = db.prepare(`
    SELECT path FROM documents WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];
  return rows.map(r => r.path);
}

/**
 * Paths eligible for filesystem-absence reconciliation: active rows the filesystem indexer
 * owns (origin = 'fs'). DB-born rows (origin = 'api' — hooks, saveMemory, beads, REST) have
 * no backing file BY DESIGN; treating their absence from disk as deletion destroyed
 * hook-written memories (measured in one production vault: 2,430 of 2,437 DB-born rows
 * deactivated). NULL-origin legacy rows are exempt too — fail-safe.
 *
 * Failure posture is fail-SAFE: on a pre-migration schema (the one error this function
 * recognizes) it returns NO paths — reconciliation simply does not run until the migration
 * lands, and the open-time warning reports that state. There is no inference fallback:
 * content_hash proves nothing about ownership (mined imports write it too). Every other
 * error propagates (the caller's transaction rolls back); no failure may widen the
 * enumeration.
 */
export function getReconcilableDocumentPaths(db: Database, collectionName: string): string[] {
  try {
    const rows = db.prepare(`
      SELECT path FROM documents WHERE collection = ? AND active = 1 AND origin = 'fs'
    `).all(collectionName) as { path: string }[];
    return rows.map(r => r.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such column.*origin/i.test(msg)) throw err;
    return [];
  }
}

export { formatQueryForEmbedding, formatDocForEmbedding };

export function chunkDocument(content: string, maxChars: number = CHUNK_SIZE_CHARS, overlapChars: number = CHUNK_OVERLAP_CHARS): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }];
  }

  const chunks: { text: string; pos: number }[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    // Calculate end position for this chunk
    let endPos = Math.min(charPos + maxChars, content.length);

    // If not at the end, try to find a good break point
    if (endPos < content.length) {
      const slice = content.slice(charPos, endPos);

      // Look for break points in the last 30% of the chunk
      const searchStart = Math.floor(slice.length * 0.7);
      const searchSlice = slice.slice(searchStart);

      // Priority: paragraph > sentence > line > word
      let breakOffset = -1;
      const paragraphBreak = searchSlice.lastIndexOf('\n\n');
      if (paragraphBreak >= 0) {
        breakOffset = searchStart + paragraphBreak + 2;
      } else {
        const sentenceEnd = Math.max(
          searchSlice.lastIndexOf('. '),
          searchSlice.lastIndexOf('.\n'),
          searchSlice.lastIndexOf('? '),
          searchSlice.lastIndexOf('?\n'),
          searchSlice.lastIndexOf('! '),
          searchSlice.lastIndexOf('!\n')
        );
        if (sentenceEnd >= 0) {
          breakOffset = searchStart + sentenceEnd + 2;
        } else {
          const lineBreak = searchSlice.lastIndexOf('\n');
          if (lineBreak >= 0) {
            breakOffset = searchStart + lineBreak + 1;
          } else {
            const spaceBreak = searchSlice.lastIndexOf(' ');
            if (spaceBreak >= 0) {
              breakOffset = searchStart + spaceBreak + 1;
            }
          }
        }
      }

      if (breakOffset > 0) {
        endPos = charPos + breakOffset;
      }
    }

    // Ensure we make progress
    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });

    // Move forward, but overlap with previous chunk
    // For last chunk, don't overlap (just go to the end)
    if (endPos >= content.length) {
      break;
    }
    charPos = endPos - overlapChars;
    const lastChunkPos = chunks.at(-1)!.pos;
    if (charPos <= lastChunkPos) {
      // Prevent infinite loop - move forward at least a bit
      charPos = endPos;
    }
  }

  return chunks;
}

/**
 * Chunk a document by actual token count using the LLM tokenizer.
 * More accurate than character-based chunking but requires async.
 */
export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS
): Promise<{ text: string; pos: number; tokens: number }[]> {
  const llm = getDefaultLlamaCpp();

  // Tokenize once upfront
  const allTokens = await llm.tokenize(content);
  const totalTokens = allTokens.length;

  if (totalTokens <= maxTokens) {
    return [{ text: content, pos: 0, tokens: totalTokens }];
  }

  const chunks: { text: string; pos: number; tokens: number }[] = [];
  const step = maxTokens - overlapTokens;
  const avgCharsPerToken = content.length / totalTokens;
  let tokenPos = 0;

  while (tokenPos < totalTokens) {
    const chunkEnd = Math.min(tokenPos + maxTokens, totalTokens);
    const chunkTokens = allTokens.slice(tokenPos, chunkEnd);
    let chunkText = await llm.detokenize(chunkTokens);

    // Find a good break point if not at end of document
    if (chunkEnd < totalTokens) {
      const searchStart = Math.floor(chunkText.length * 0.7);
      const searchSlice = chunkText.slice(searchStart);

      let breakOffset = -1;
      const paragraphBreak = searchSlice.lastIndexOf('\n\n');
      if (paragraphBreak >= 0) {
        breakOffset = paragraphBreak + 2;
      } else {
        const sentenceEnd = Math.max(
          searchSlice.lastIndexOf('. '),
          searchSlice.lastIndexOf('.\n'),
          searchSlice.lastIndexOf('? '),
          searchSlice.lastIndexOf('?\n'),
          searchSlice.lastIndexOf('! '),
          searchSlice.lastIndexOf('!\n')
        );
        if (sentenceEnd >= 0) {
          breakOffset = sentenceEnd + 2;
        } else {
          const lineBreak = searchSlice.lastIndexOf('\n');
          if (lineBreak >= 0) {
            breakOffset = lineBreak + 1;
          }
        }
      }

      if (breakOffset >= 0) {
        chunkText = chunkText.slice(0, searchStart + breakOffset);
      }
    }

    // Approximate character position based on token position
    const charPos = Math.floor(tokenPos * avgCharsPerToken);
    chunks.push({ text: chunkText, pos: charPos, tokens: chunkTokens.length });

    // Move forward
    if (chunkEnd >= totalTokens) break;

    // Advance by step tokens (maxTokens - overlap)
    tokenPos += step;
  }

  return chunks;
}

// =============================================================================
// Fuzzy matching
// =============================================================================

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

/**
 * Find a document by its short docid (first 6 characters of hash).
 * Returns the document's virtual path if found, null otherwise.
 * If multiple documents match the same short hash (collision), returns the first one.
 */
export function findDocumentByDocid(db: Database, docid: string): { filepath: string; hash: string } | null {
  // Normalize: remove leading # if present
  const shortHash = docid.startsWith('#') ? docid.slice(1) : docid;

  // Structural validation BEFORE the value reaches LIKE: a docid is a hex
  // prefix of a sha256 hash, 6–64 chars (the documented short-docid contract).
  // Anything else returns not-found — this closes real holes on EVERY docid
  // surface (destructive REST forget included): `_`/`%` are LIKE wildcards
  // that matched arbitrary documents, a 1-char prefix is ambiguity-by-design,
  // and an unbounded value made SQLite's LIKE throw ("pattern too complex")
  // instead of answering.
  if (!/^[0-9a-fA-F]{6,64}$/.test(shortHash)) return null;

  // Look up documents where hash starts with the short hash
  const doc = db.prepare(`
    SELECT 'clawmem://' || d.collection || '/' || d.path as filepath, d.hash
    FROM documents d
    WHERE d.hash LIKE ? AND d.active = 1
    LIMIT 1
  `).get(`${shortHash}%`) as { filepath: string; hash: string } | null;

  return doc;
}

export function findSimilarFiles(db: Database, query: string, maxDistance: number = 3, limit: number = 5): string[] {
  const allFiles = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.active = 1
  `).all() as { path: string }[];
  const queryLower = query.toLowerCase();
  const scored = allFiles
    .map(f => ({ path: f.path, dist: levenshtein(f.path.toLowerCase(), queryLower) }))
    .filter(f => f.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
  return scored.map(f => f.path);
}

export function matchFilesByGlob(db: Database, pattern: string): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db.prepare(`
    SELECT
      'clawmem://' || d.collection || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { virtual_path: string; body_length: number; path: string; collection: string }[];

  const glob = new Glob(pattern);
  return allFiles
    .filter(f => glob.match(f.virtual_path) || glob.match(f.path))
    .map(f => ({
      filepath: f.virtual_path,  // Virtual path for precise lookup
      displayPath: f.path,        // Relative path for display
      bodyLength: f.body_length
    }));
}

// =============================================================================
// Context
// =============================================================================

/**
 * Get context for a file path using hierarchical inheritance.
 * Contexts are collection-scoped and inherit from parent directories.
 * For example, context at "/talks" applies to "/talks/2024/keynote.md".
 *
 * @param db Database instance (unused - kept for compatibility)
 * @param collectionName Collection name
 * @param path Relative path within the collection
 * @returns Context string or null if no context is defined
 */
export function getContextForPath(db: Database, collectionName: string, path: string): string | null {
  const config = collectionsLoadConfig();
  const coll = getCollection(collectionName);

  if (!coll) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  if (config.global_context) {
    contexts.push(config.global_context);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

/**
 * Get context for a file path (virtual or filesystem).
 * Resolves the collection and relative path using the YAML collections config.
 */
export function getContextForFile(db: Database, filepath: string): string | null {
  // Handle undefined or null filepath
  if (!filepath) return null;

  // Get all collections from YAML config
  const collections = collectionsListCollections();
  const config = collectionsLoadConfig();

  // Parse virtual path format: clawmem://collection/path
  let collectionName: string | null = null;
  let relativePath: string | null = null;

  const parsedVirtual = filepath.startsWith('clawmem://') ? parseVirtualPath(filepath) : null;
  if (parsedVirtual) {
    collectionName = parsedVirtual.collectionName;
    relativePath = parsedVirtual.path;
  } else {
    // Filesystem path: find which collection this absolute path belongs to
    for (const coll of collections) {
      // Skip collections with missing paths
      if (!coll || !coll.path) continue;

      if (filepath.startsWith(coll.path + '/') || filepath === coll.path) {
        collectionName = coll.name;
        // Extract relative path
        relativePath = filepath.startsWith(coll.path + '/')
          ? filepath.slice(coll.path.length + 1)
          : '';
        break;
      }
    }

    if (!collectionName || relativePath === null) return null;
  }

  // Get the collection from config
  const coll = getCollection(collectionName);
  if (!coll) return null;

  // Verify this document exists in the database
  const doc = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
    LIMIT 1
  `).get(collectionName, relativePath) as { path: string } | null;

  if (!doc) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  if (config.global_context) {
    contexts.push(config.global_context);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

/**
 * Get collection by name from YAML config.
 * Returns collection metadata from ~/.config/qmd/index.yml
 */
export function getCollectionByName(db: Database, name: string): { name: string; pwd: string; glob_pattern: string } | null {
  const collection = getCollection(name);
  if (!collection) return null;

  return {
    name: collection.name,
    pwd: collection.path,
    glob_pattern: collection.pattern,
  };
}

/**
 * List all collections with document counts from database.
 * Merges YAML config with database statistics.
 */
export function listCollections(db: Database): { name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null }[] {
  const collections = collectionsListCollections();

  // Get document counts from database for each collection
  const result = collections.map(coll => {
    const stats = db.prepare(`
      SELECT
        COUNT(d.id) as doc_count,
        SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active_count,
        MAX(d.modified_at) as last_modified
      FROM documents d
      WHERE d.collection = ?
    `).get(coll.name) as { doc_count: number; active_count: number; last_modified: string | null } | null;

    return {
      name: coll.name,
      pwd: coll.path,
      glob_pattern: coll.pattern,
      doc_count: stats?.doc_count || 0,
      active_count: stats?.active_count || 0,
      last_modified: stats?.last_modified || null,
    };
  });

  return result;
}

/**
 * NOTE: the store-level `removeCollection` was removed in v0.30.0. It ran
 * `DELETE FROM documents WHERE collection = ?` — an unauthorized hard delete of an entire
 * collection's documents. It had no callers: `clawmem collection remove` goes through
 * `collections.ts`'s `removeCollection`, which edits the YAML config only and leaves the
 * indexed rows to deactivate on the next update. That is the reversible path and remains
 * the only one. Do not reintroduce a row-destroying variant here.
 */

/**
 * Rename a collection.
 * Updates both YAML config and database documents table.
 */
export function renameCollection(db: Database, oldName: string, newName: string): void {
  // Update all documents with the new collection name in database
  db.prepare(`UPDATE documents SET collection = ? WHERE collection = ?`)
    .run(newName, oldName);

  // Rename in YAML config
  collectionsRenameCollection(oldName, newName);
}

// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * Delete a context for a specific collection and path prefix.
 * Returns the number of contexts deleted.
 */
export function deleteContext(db: Database, collectionName: string, pathPrefix: string): number {
  // Use collections.ts to remove context
  const success = collectionsRemoveContext(collectionName, pathPrefix);
  return success ? 1 : 0;
}

/**
 * Delete all global contexts (contexts with empty path_prefix).
 * Returns the number of contexts deleted.
 */
export function deleteGlobalContexts(db: Database): number {
  let deletedCount = 0;

  // Remove global context
  setGlobalContext(undefined);
  deletedCount++;

  // Remove root context (empty string) from all collections
  const collections = collectionsListCollections();
  for (const coll of collections) {
    const success = collectionsRemoveContext(coll.name, '');
    if (success) {
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * List all contexts, grouped by collection.
 * Returns contexts ordered by collection name, then by path prefix length (longest first).
 */
export function listPathContexts(db: Database): { collection_name: string; path_prefix: string; context: string }[] {
  const allContexts = collectionsListAllContexts();

  // Convert to expected format and sort
  return allContexts.map(ctx => ({
    collection_name: ctx.collection,
    path_prefix: ctx.path,
    context: ctx.context,
  })).sort((a, b) => {
    // Sort by collection name first
    if (a.collection_name !== b.collection_name) {
      return a.collection_name.localeCompare(b.collection_name);
    }
    // Then by path prefix length (longest first)
    if (a.path_prefix.length !== b.path_prefix.length) {
      return b.path_prefix.length - a.path_prefix.length;
    }
    // Then alphabetically
    return a.path_prefix.localeCompare(b.path_prefix);
  });
}

/**
 * Get all collections (name only - from YAML config).
 */
export function getAllCollections(db: Database): { name: string }[] {
  const collections = collectionsListCollections();
  return collections.map(c => ({ name: c.name }));
}

/**
 * Check which collections don't have any context defined.
 * Returns collections that have no context entries at all (not even root context).
 */
export function getCollectionsWithoutContext(db: Database): { name: string; pwd: string; doc_count: number }[] {
  // Get all collections from YAML config
  const yamlCollections = collectionsListCollections();

  // Filter to those without context
  const collectionsWithoutContext: { name: string; pwd: string; doc_count: number }[] = [];

  for (const coll of yamlCollections) {
    // Check if collection has any context
    if (!coll.context || Object.keys(coll.context).length === 0) {
      // Get doc count from database
      const stats = db.prepare(`
        SELECT COUNT(d.id) as doc_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { doc_count: number } | null;

      collectionsWithoutContext.push({
        name: coll.name,
        pwd: coll.path,
        doc_count: stats?.doc_count || 0,
      });
    }
  }

  return collectionsWithoutContext.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get top-level directories in a collection that don't have context.
 * Useful for suggesting where context might be needed.
 */
export function getTopLevelPathsWithoutContext(db: Database, collectionName: string): string[] {
  // Get all paths in the collection from database
  const paths = db.prepare(`
    SELECT DISTINCT path FROM documents
    WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];

  // Get existing contexts for this collection from YAML
  const yamlColl = getCollection(collectionName);
  if (!yamlColl) return [];

  const contextPrefixes = new Set<string>();
  if (yamlColl.context) {
    for (const prefix of Object.keys(yamlColl.context)) {
      contextPrefixes.add(prefix);
    }
  }

  // Extract top-level directories (first path component)
  const topLevelDirs = new Set<string>();
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const dir = parts[0];
      if (dir) topLevelDirs.add(dir);
    }
  }

  // Filter out directories that already have context (exact or parent)
  const missing: string[] = [];
  for (const dir of topLevelDirs) {
    let hasContext = false;

    // Check if this dir or any parent has context
    for (const prefix of contextPrefixes) {
      if (prefix === '' || prefix === dir || dir.startsWith(prefix + '/')) {
        hasContext = true;
        break;
      }
    }

    if (!hasContext) {
      missing.push(dir);
    }
  }

  return missing.sort();
}

// =============================================================================
// FTS Search
// =============================================================================

// Split on any run of non-token chars so query tokenization mirrors the FTS
// index tokenizer (unicode61) which treats _ - . / ' and all punctuation as
// token boundaries. Stripping the separators (the old behavior) concatenated
// word-parts into a token that was never indexed — e.g. "before_compaction"
// became "beforecompaction" and matched nothing. Shared with entities_fts in
// entity.ts. Must stay a hoisted `function` declaration: entity.ts imports it
// across the store<->entity module cycle, which only resolves for hoisted
// bindings (it is called at runtime, never at module-eval time).
export function tokenizeForFTS5(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 0);
}

function buildFTS5Query(query: string): string | null {
  const terms = tokenizeForFTS5(query);
  if (terms.length === 0) return null;
  if (terms.length === 1) return `"${terms[0]}"*`;
  return terms.map(t => `"${t}"*`).join(' AND ');
}

/**
 * Convert an FTS5 bm25() value into a stable [0,1) relevance score where higher is better.
 *
 * FTS5's bm25() is negative-is-better: it returns -1 × the BM25 score, so it is ≤ 0 for
 * every match. The transform is per-row and monotonic in match strength (|bm25|/(1+|bm25|))
 * with no per-query normalization, so cross-query comparisons, minScore filters, and the
 * strong-signal bypass all stay meaningful. A hypothetical positive input clamps to 0
 * rather than inverting the ordering.
 */
export function ftsScoreFromBm25(bm25Score: number): number {
  const m = Math.max(0, -bm25Score);
  return m / (1 + m);
}

export function searchFTS(db: Database, query: string, limit: number = 20, collectionId?: number, collections?: string[], dateRange?: { start: string; end: string }, excludeCollections?: string[], opts?: { observationsOnly?: boolean }): SearchResult[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  let sql = `
    SELECT
      'clawmem://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      content.doc as body,
      d.hash,
      d.modified_at,
      bm25(documents_fts, 10.0, 1.0) as bm25_score
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    JOIN content ON content.hash = d.hash
    WHERE documents_fts MATCH ? AND d.active = 1 AND d.invalidated_at IS NULL
  `;
  const params: (string | number)[] = [ftsQuery];

  if (collections && collections.length > 0) {
    // SQL-level collection filtering — avoids full-table scan + post-filter
    const placeholders = collections.map(() => '?').join(',');
    sql += ` AND d.collection IN (${placeholders})`;
    params.push(...collections);
  } else if (collectionId) {
    // Legacy parameter — kept for backward compatibility
    sql += ` AND d.collection = ?`;
    params.push(String(collectionId));
  }

  // Temporal filter: restrict to date range (UTC ISO timestamps from extractTemporalConstraint).
  // §51.1: content-time predicate — authorship when known, filing time otherwise.
  if (dateRange) {
    sql += ` AND COALESCE(d.authored_at, d.modified_at) >= ? AND COALESCE(d.authored_at, d.modified_at) <= ?`;
    params.push(dateRange.start, dateRange.end);
  }

  // Visibility exclusion (VSEARCH-TRUST-HARDENING (b).1): excluded collections never enter
  // the candidate pool, so `limit` is satisfied with allowed content by construction.
  if (excludeCollections && excludeCollections.length > 0) {
    const exPlaceholders = excludeCollections.map(() => '?').join(',');
    sql += ` AND d.collection NOT IN (${exPlaceholders})`;
    params.push(...excludeCollections);
  }

  // WHY observation lane (v0.32.0): the structural predicate is applied IN the candidate
  // selection, so `limit` is satisfied with eligible observation documents by construction —
  // a post-filter over a fixed overfetch could be starved by higher-ranked non-observation
  // internal artifacts.
  if (opts?.observationsOnly) {
    sql += ` AND d.path LIKE 'observations/%' AND d.observation_type IS NOT NULL`;
  }

  // bm25 lower is better; sort ascending.
  sql += ` ORDER BY bm25_score ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as { filepath: string; display_path: string; title: string; body: string; hash: string; modified_at: string; bm25_score: number }[];
  return rows.map(row => {
    const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
    const score = ftsScoreFromBm25(row.bm25_score);
    return {
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName,
      modifiedAt: row.modified_at || "",
      bodyLength: row.body.length,
      body: row.body,
      context: getContextForFile(db, row.filepath),
      score,
      source: "fts" as const,
    };
  });
}

// =============================================================================
// Vector Search
// =============================================================================

// W1 read-path model-consistency cache, keyed on SQLite's `data_version` so a CROSS-PROCESS vault
// rebuild invalidates a stale OK verdict. `data_version` changes whenever ANOTHER connection commits
// (e.g. a separate `clawmem embed --force` process re-embeds with a different model) — exactly the
// multi-process staleness case — and is a cheap header read (no scan), unlike the getVecModels()
// DISTINCT+JOIN it guards. Same-connection writes don't bump it, but in-process model swaps are
// already blocked by the embed-time VecModelMismatchError / clearAllEmbeddings drop.
const verifiedQueryEmbedModels = new WeakMap<Database, { dataVersion: number; model: string }>();

/**
 * Guard the query path against a same-dimension embedding-model swap. Compares the ENDPOINT-returned
 * model (NOT the caller's DEFAULT_EMBED_MODEL arg, which is a local alias unrelated to what the
 * endpoint actually serves) against the models the vault's active vectors were embedded with. The
 * vault is consistent ONLY when it holds EXACTLY ONE model equal to the endpoint's — a heterogeneous
 * vault (length > 1) is cosine-corrupt even if the endpoint matches one of the models, because the
 * other model's vectors still pollute the space. Throws VecReadModelMismatchError otherwise; no-ops
 * when the vault has no vectors yet.
 */
function assertQueryEmbedModelConsistent(db: Database, endpointModel: string): void {
  const dataVersion = (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  const cached = verifiedQueryEmbedModels.get(db);
  if (cached && cached.dataVersion === dataVersion && cached.model === endpointModel) return;

  const storedModels = getVecModels(db);
  if (storedModels.length === 0) return; // nothing embedded yet — nothing to be inconsistent with

  if (!(storedModels.length === 1 && storedModels[0] === endpointModel)) {
    throw new VecReadModelMismatchError(storedModels, endpointModel);
  }

  // Consistent — memoize under the current data_version. A cross-process rebuild bumps data_version,
  // invalidating this entry so the next query re-reads content_vectors.
  verifiedQueryEmbedModels.set(db, { dataVersion, model: endpointModel });
}

// Step 1 of vector search — the expensive, off-loadable half: embed the query, guard the wall-clock
// deadline, then run the SYNCHRONOUS sqlite-vec MATCH. Returns raw {hash_seq, distance} hits;
// collection/date filtering is a Step-2 concern. Split out (BACKLOG Source 46) so the vector-query
// daemon can run JUST this half on the long-lived watcher — keeping the blocking MATCH off the hook's
// event loop — while the hook hydrates locally via hydrateVecResults(). In-process searchVec() below
// composes the two, so its public contract is unchanged.
export async function searchVecMatch(db: Database, query: string, model: string, limit: number = 20, deadlineMs?: number): Promise<{ hash_seq: string; distance: number }[]> {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) return [];

  const embedResult = await getEmbedding(query, model, true, deadlineMs);
  if (!embedResult) return [];

  // W1: read-path embedding-model consistency gate + dimension check via the SHARED guard
  // (same guard the eval-only precomputed-vector entry runs — the two paths cannot diverge).
  // On a same-dimension model swap this throws VecReadModelMismatchError rather than serving
  // cosine-meaningless results. Cached per (db, model) — the DISTINCT runs at most once per
  // model per process.
  assertQueryVectorCompatible(db, embedResult.model, embedResult.embedding.length);

  const embedding = embedResult.embedding;

  // Guard-defect fix: the caller's Promise.race(vectorTimeout) cannot interrupt the SYNCHRONOUS
  // sqlite-vec MATCH below (bun:sqlite blocks the event loop) and does NOT cancel this promise.
  // If the wall-clock budget already elapsed during the async embed above, bail here so a
  // timed-out vector leg cannot resume and re-block the hook after it fell back to FTS.
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) return [];

  // IMPORTANT: We use a two-step query approach here because sqlite-vec virtual tables
  // hang indefinitely when combined with JOINs in the same query. Do NOT try to
  // "optimize" this by combining into a single query with JOINs - it will break.
  // See: https://github.com/tobi/qmd/pull/23

  // Step 1: Get vector matches from sqlite-vec (no JOINs allowed)
  return db.prepare(`
    SELECT hash_seq, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(embedding), limit * 3) as { hash_seq: string; distance: number }[];
}

// Step 2 of vector search — the cheap, local half: hydrate raw {hash_seq, distance} hits into
// SearchResult[] via indexed JOINs, collection/date filtering, and per-doc dedup. Pure primary-key
// SQLite lookups — safe to run in the short-lived hook process even when Step 1 ran in the daemon.
export function hydrateVecResults(db: Database, vecResults: { hash_seq: string; distance: number }[], limit: number = 20, collectionId?: number, collections?: string[], dateRange?: { start: string; end: string }): SearchResult[] {
  if (vecResults.length === 0) return [];

  // Step 2: Get chunk info and document data
  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));

  // Build query for document lookup (includes fragment metadata)
  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT
      cv.hash || '_' || cv.seq as hash_seq,
      cv.hash,
      cv.pos,
      cv.fragment_type,
      cv.fragment_label,
      'clawmem://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      d.modified_at,
      content.doc as body
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1 AND d.invalidated_at IS NULL
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];

  if (collections && collections.length > 0) {
    const colPlaceholders = collections.map(() => '?').join(',');
    docSql += ` AND d.collection IN (${colPlaceholders})`;
    params.push(...collections);
  } else if (collectionId) {
    docSql += ` AND d.collection = ?`;
    params.push(String(collectionId));
  }

  // Temporal filter: restrict to date range (UTC ISO timestamps from extractTemporalConstraint).
  // §51.1: content-time predicate — authorship when known, filing time otherwise.
  if (dateRange) {
    docSql += ` AND COALESCE(d.authored_at, d.modified_at) >= ? AND COALESCE(d.authored_at, d.modified_at) <= ?`;
    params.push(dateRange.start, dateRange.end);
  }

  const docRows = db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; filepath: string;
    display_path: string; title: string; body: string; modified_at: string;
    fragment_type: string | null; fragment_label: string | null;
  }[];

  // Combine with distances and dedupe by filepath (keep best-scoring fragment per doc)
  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => {
      const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
      return {
        filepath: row.filepath,
        displayPath: row.display_path,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName,
        modifiedAt: row.modified_at || "",
        bodyLength: row.body.length,
        body: row.body,
        context: getContextForFile(db, row.filepath),
        score: 1 - bestDist,  // Cosine similarity = 1 - cosine distance
        source: "vec" as const,
        chunkPos: row.pos,
        fragmentType: row.fragment_type ?? undefined,
        fragmentLabel: row.fragment_label ?? undefined,
      };
    });
}

// In-process vector search — Step 1 (MATCH) + Step 2 (hydrate) composed. Public contract unchanged;
// the daemon-backed hook path (context-surfacing) instead calls searchVecMatch (in the daemon) +
// hydrateVecResults (locally), so the blocking MATCH never runs on the hook's event loop.
export async function searchVec(db: Database, query: string, model: string, limit: number = 20, collectionId?: number, collections?: string[], dateRange?: { start: string; end: string }, deadlineMs?: number): Promise<SearchResult[]> {
  const vecResults = await searchVecMatch(db, query, model, limit, deadlineMs);
  return hydrateVecResults(db, vecResults, limit, collectionId, collections, dateRange);
}

// =============================================================================
// Detailed vector search — visibility exclusion + escalation (VSEARCH-TRUST-HARDENING (b).1)
// =============================================================================

/**
 * Shared query-vector compatibility guard — model consistency (W1) + dimension-vs-table
 * validation, called by BOTH the production embed path and the eval-only precomputed-vector
 * entry so the two can never diverge (design (e), T4-M4).
 */
function assertQueryVectorCompatible(db: Database, endpointModel: string, dim: number): void {
  assertQueryEmbedModelConsistent(db, endpointModel);
  const tableDim = getVecTableDim(db);
  if (tableDim !== null && tableDim !== dim) throw new VecDimensionMismatchError(tableDim, dim);
}

export interface VecSearchDetailedOpts {
  collectionId?: number;
  collections?: string[];
  excludeCollections?: string[];
  dateRange?: { start: string; end: string };
  deadlineMs?: number;
  /** Override the hard MATCH-depth cap (default 4096). Primarily for tests. */
  escalationCap?: number;
  /** WHY observation lane (v0.32.0): restrict candidates to `_clawmem` observation documents
   * (path 'observations/%' + observation_type set) inside the hydration SQL, so the escalation
   * loop fills `limit` with eligible observations by construction. */
  observationsOnly?: boolean;
}

export interface VecSearchDetailedResult {
  results: SearchResult[];
  degraded: boolean;
  degradedReason?: "excluded-dominant" | "cap-truncation";
  scannedFragments: number;
  excludedDocsSeen: number;
}

// Hard MATCH-depth cap for exclusion escalation. Exhausting a 60k+ table per query is a
// hot-path perf cliff; past this the result carries an explicit degraded marker instead.
const VEC_ESCALATION_HARD_CAP = 4096;

// Hydration + visibility classification for one escalation round. Include-collections and
// dateRange are SQL predicates (a row failing them was never a candidate); EXCLUSION is
// classified in JS because the excluded-doc count is part of the degraded contract (T5-M2).
function hydrateVecResultsClassified(
  db: Database,
  vecResults: { hash_seq: string; distance: number }[],
  limit: number,
  opts: VecSearchDetailedOpts,
  exclude: Set<string>
): { results: SearchResult[]; allowedDocs: number; excludedDocsSeen: number } {
  if (vecResults.length === 0) return { results: [], allowedDocs: 0, excludedDocsSeen: 0 };

  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));
  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT
      cv.hash || '_' || cv.seq as hash_seq,
      cv.hash,
      cv.pos,
      cv.fragment_type,
      cv.fragment_label,
      d.collection,
      'clawmem://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      d.modified_at,
      content.doc as body
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1 AND d.invalidated_at IS NULL
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];

  if (opts.collections && opts.collections.length > 0) {
    const colPlaceholders = opts.collections.map(() => '?').join(',');
    docSql += ` AND d.collection IN (${colPlaceholders})`;
    params.push(...opts.collections);
  } else if (opts.collectionId) {
    docSql += ` AND d.collection = ?`;
    params.push(String(opts.collectionId));
  }
  if (opts.dateRange) {
    // §51.1: content-time predicate — authorship when known, filing time otherwise.
    docSql += ` AND COALESCE(d.authored_at, d.modified_at) >= ? AND COALESCE(d.authored_at, d.modified_at) <= ?`;
    params.push(opts.dateRange.start, opts.dateRange.end);
  }
  if (opts.observationsOnly) {
    docSql += ` AND d.path LIKE 'observations/%' AND d.observation_type IS NOT NULL`;
  }

  const docRows = db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; collection: string; filepath: string;
    display_path: string; title: string; body: string; modified_at: string;
    fragment_type: string | null; fragment_label: string | null;
  }[];

  const excludedDocs = new Set<string>();
  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    if (exclude.has(row.collection)) {
      excludedDocs.add(row.filepath);
      continue;
    }
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  const results = Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => ({
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName: row.collection,
      modifiedAt: row.modified_at || "",
      bodyLength: row.body.length,
      body: row.body,
      context: getContextForFile(db, row.filepath),
      score: 1 - bestDist,
      source: "vec" as const,
      chunkPos: row.pos,
      fragmentType: row.fragment_type ?? undefined,
      fragmentLabel: row.fragment_label ?? undefined,
    }));

  return { results, allowedDocs: seen.size, excludedDocsSeen: excludedDocs.size };
}

/**
 * Eval-only + internal core: detailed vector search from a PRECOMPUTED query vector.
 * Runs the SAME shared compatibility guard as the production path (T3-M2/T4-M4) — the
 * endpointModel MUST come from the actual embed response that produced the vector.
 * Synchronous (MATCH + hydration only); writes nothing.
 */
export function searchVecDetailedWithVector(
  db: Database,
  queryVec: { embedding: Float32Array; endpointModel: string },
  limit: number = 20,
  opts: VecSearchDetailedOpts = {}
): VecSearchDetailedResult {
  const empty: VecSearchDetailedResult = { results: [], degraded: false, scannedFragments: 0, excludedDocsSeen: 0 };
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) return empty;

  assertQueryVectorCompatible(db, queryVec.endpointModel, queryVec.embedding.length);

  const exclude = new Set(opts.excludeCollections ?? []);
  const tableRows = (db.prepare(`SELECT count(*) as c FROM vectors_vec`).get() as { c: number }).c;
  if (tableRows === 0) return empty;
  const hardCap = opts.escalationCap ?? VEC_ESCALATION_HARD_CAP;
  const effectiveCap = Math.min(hardCap, tableRows);

  const matchStmt = db.prepare(`SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? AND k = ?`);

  let k = Math.min(limit * 3, effectiveCap);
  let raw: { hash_seq: string; distance: number }[] = [];
  let classified: ReturnType<typeof hydrateVecResultsClassified> = { results: [], allowedDocs: 0, excludedDocsSeen: 0 };

  // Escalation loop (filtering callers only): grow MATCH depth x3 until `limit` allowed
  // DOCUMENTS (post-dedup) hydrate, the effective cap is hit, or the deadline passes.
  // `observationsOnly` filters in the hydration SQL exactly like a collection exclusion does,
  // so it engages the same escalation — otherwise nearer non-observation internals could
  // starve the observation lane out of its first limit*3 raw candidates. Without any
  // filtering this runs exactly once at limit*3 — today's semantics.
  const filteringActive = exclude.size > 0 || !!opts.observationsOnly;
  for (;;) {
    raw = matchStmt.all(queryVec.embedding, k) as { hash_seq: string; distance: number }[];
    classified = hydrateVecResultsClassified(db, raw, limit, opts, exclude);
    const done =
      !filteringActive ||
      classified.allowedDocs >= limit ||
      k >= effectiveCap ||
      raw.length < k || // MATCH returned fewer than requested: table exhausted below k
      (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs);
    if (done) break;
    k = Math.min(k * 3, effectiveCap);
  }

  // Degraded contract (T4-M1 + T5-M2): only the HARD cap preventing an exhaustive scan
  // counts — scanning the whole (sub-cap) table is ordinary corpus exhaustion, no marker.
  const scannedFragments = raw.length;
  let degraded = false;
  let degradedReason: VecSearchDetailedResult["degradedReason"];
  const underfilled = classified.allowedDocs < limit;
  const hardCapPreventedExhaustion = tableRows > hardCap && k >= hardCap;
  if (filteringActive && underfilled && hardCapPreventedExhaustion) {
    degraded = true;
    degradedReason = classified.excludedDocsSeen >= (limit - classified.allowedDocs)
      ? "excluded-dominant"
      : "cap-truncation";
  }

  return {
    results: classified.results,
    degraded,
    degradedReason,
    scannedFragments,
    excludedDocsSeen: classified.excludedDocsSeen,
  };
}

/**
 * Detailed vector search — embeds the query, then delegates to the precomputed-vector core.
 * The entry for every exclusion-enabled caller; carries the FULL searchVec parameter surface
 * (collections / collectionId / dateRange / deadlineMs) so temporal RRF is never contaminated
 * by dropped filters (T6-H2).
 */
export async function searchVecDetailed(
  db: Database,
  query: string,
  model: string,
  limit: number = 20,
  opts: VecSearchDetailedOpts = {}
): Promise<VecSearchDetailedResult> {
  const empty: VecSearchDetailedResult = { results: [], degraded: false, scannedFragments: 0, excludedDocsSeen: 0 };
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) return empty;

  const embedResult = await getEmbedding(query, model, true, opts.deadlineMs);
  if (!embedResult) return empty;
  if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) return empty;

  return searchVecDetailedWithVector(
    db,
    { embedding: new Float32Array(embedResult.embedding), endpointModel: embedResult.model },
    limit,
    opts
  );
}

// =============================================================================
// Embeddings
// =============================================================================

async function getEmbedding(text: string, model: string, isQuery: boolean, deadlineMs?: number): Promise<{ embedding: number[]; model: string } | null> {
  const llm = getDefaultLlamaCpp();
  // Format text using the appropriate prompt template
  const formattedText = isQuery ? formatQueryForEmbedding(text) : formatDocForEmbedding(text);
  // B4: bound the remote embed fetch + its 429 backoff to the caller's wall-clock
  // deadline. Under the context-surfacing hook's Promise.race the abandoned embed
  // promise otherwise keeps its fetch + retry sleeps running; AbortSignal.timeout
  // actually cancels them, so a slow/rate-limited embed can no longer outlive the
  // hook budget.
  let signal: AbortSignal | undefined;
  if (deadlineMs !== undefined) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return null; // deadline already elapsed — skip the embed entirely
    signal = AbortSignal.timeout(remaining);
  }
  const result = await llm.embed(formattedText, { model, isQuery, signal });
  if (!result?.embedding) return null;
  return { embedding: result.embedding, model: result.model };
}

/**
 * Get all unique content hashes that need embeddings (from active documents).
 * Returns hash, document body, and a sample path for display purposes.
 */
export function getHashesForEmbedding(db: Database): { hash: string; body: string; path: string }[] {
  return db.prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
  `).all() as { hash: string; body: string; path: string }[];
}

/**
 * Get all unique content hashes that need fragment-level embeddings.
 * Returns hashes that have no content_vectors row with fragment_type set.
 */
export function getHashesNeedingFragments(db: Database): { hash: string; body: string; path: string; title: string; collection: string }[] {
  // Select docs that either have no fragments at all OR are missing the primary (seq=0) fragment.
  // The seq=0 embedding is critical — surprisal scoring, semantic graph, and health checks depend on it.
  // Also retry docs left 'pending' (crash mid-doc) or 'failed' (partial fragment failure) so partial
  // embeds are not permanently silent — bounded by embed_attempts < 3. The OR-branch is parenthesized
  // so embed_attempts < 3 and d.active = 1 always apply to every selected row (SQL precedence).
  // The (collection, path, title) tuple must be ONE REAL document row (T9-M1): independent
  // MIN() per column can synthesize a tuple belonging to no document, which then produces a
  // canonicalDocId that matches nothing at doctor time. min(collection||'/'||path) picks a
  // deterministic real alias; the correlated join recovers that row's actual columns.
  return db.prepare(`
    SELECT g.hash, c.doc as body, d.path as path, d.title as title, d.collection as collection
    FROM (
      SELECT dd.hash, MIN(dd.collection || '/' || dd.path) as canon_key
      FROM documents dd
      LEFT JOIN content_vectors v ON dd.hash = v.hash AND v.fragment_type IS NOT NULL
      LEFT JOIN content_vectors v0 ON dd.hash = v0.hash AND v0.seq = 0
      WHERE dd.active = 1
        AND COALESCE(dd.embed_attempts, 0) < 3
        AND ((v.hash IS NULL OR v0.hash IS NULL) OR dd.embed_state IN ('pending', 'failed'))
      GROUP BY dd.hash
    ) g
    JOIN documents d ON d.hash = g.hash AND d.active = 1 AND (d.collection || '/' || d.path) = g.canon_key
    JOIN content c ON g.hash = c.hash
  `).all() as { hash: string; body: string; path: string; title: string; collection: string }[];
}

/**
 * Clear all embeddings from the database (force re-index).
 * Deletes all rows from content_vectors and drops the vectors_vec table.
 */
export function clearAllEmbeddings(db: Database, leaseGuard?: LeaseGuard): void {
  // Atomic: the lease check + DELETE content_vectors + DROP vectors_vec + reset
  // embed_state all commit together. The in-transaction assertLeaseHeld means a
  // `--force` process that lost its lease during the endpoint probe cannot wipe the
  // vault out from under the new holder (the destructive op is the highest-risk
  // mutation, so it MUST be fenced). A crash/concurrent reader never observes a
  // half-cleared state.
  db.transaction(() => {
    assertLeaseHeld(db, leaseGuard);
    db.exec(`DELETE FROM content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
    // Reset embed state so failed docs get retried after force re-embed
    try { db.exec(`UPDATE documents SET embed_state = 'pending', embed_error = NULL, embed_attempts = 0 WHERE active = 1`); } catch { /* column may not exist yet */ }
  }).immediate(); // immediate write lock: assert ownership under the lock before this destructive op
}

/**
 * Vault-wide content_vectors ↔ vectors_vec consistency snapshot for `doctor`.
 * Computes BOTH key-set differences (not just counts — one missing + one orphan
 * cancel in a count check) under a single read transaction so both scans see the
 * same committed snapshot. Any nonzero cvMissingVv / vvOrphan is an invariant
 * violation (every content_vectors row must have a vectors_vec entry and vice-versa).
 * `pending` is reported separately (pending docs are in neither table, so they are
 * not a desync). See INCIDENT-2026-06-22 §12.
 */
export function getVectorConsistency(db: Database): {
  cvCount: number; vvCount: number; cvMissingVv: number; vvOrphan: number; pending: number;
} {
  return db.transaction(() => {
    const cvKeys = new Set<string>(
      (db.prepare(`SELECT hash || '_' || seq AS k FROM content_vectors`).all() as { k: string }[]).map(r => r.k)
    );
    let vvKeys = new Set<string>();
    try {
      vvKeys = new Set<string>(
        (db.prepare(`SELECT hash_seq FROM vectors_vec`).all() as { hash_seq: string }[]).map(r => r.hash_seq)
      );
    } catch { /* vectors_vec absent → empty set (cvMissingVv will surface it) */ }
    let cvMissingVv = 0;
    for (const k of cvKeys) if (!vvKeys.has(k)) cvMissingVv++;
    let vvOrphan = 0;
    for (const k of vvKeys) if (!cvKeys.has(k)) vvOrphan++;
    const pending = (db.prepare(
      `SELECT COUNT(*) AS n FROM documents WHERE active = 1 AND (embed_state = 'pending' OR embed_state IS NULL)`
    ).get() as { n: number }).n;
    return { cvCount: cvKeys.size, vvCount: vvKeys.size, cvMissingVv, vvOrphan, pending };
  })();
}

/**
 * Insert a single embedding into both content_vectors and vectors_vec tables.
 * The hash_seq key is formatted as "hash_seq" for the vectors_vec table.
 */
export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string,
  fragmentType?: string,
  fragmentLabel?: string,
  canonicalId?: string,
  leaseGuard?: LeaseGuard,
  embedInputFp?: string
): void {
  const hashSeq = `${hash}_${seq}`;
  // Atomic vec0 + metadata write: the DELETE (vec0's "upsert" — no INSERT OR
  // REPLACE on vec0), the vector INSERT, and the content_vectors UPSERT commit
  // together, so an interruption can never leave a vector without its metadata
  // row or vice-versa (the cv↔vv invariant the doctor check enforces).
  // ensureVecTable is always called before this and now throws (never drops)
  // on a dimension mismatch, so vectors_vec reliably exists here — the old
  // DELETE error-suppression for the "table missing mid-migration" case is gone.
  //
  // leaseGuard (optional): an in-transaction embedding-lease fence. The token
  // check and the writes share ONE transaction, so a process that lost the lease
  // while awaiting the model (between its loop-level leaseLost check and this
  // write) cannot commit a stale vector — SQLite serializes the transaction, so
  // no other holder can interleave a reclaim between the check and the INSERTs.
  db.transaction(() => {
    assertLeaseHeld(db, leaseGuard);
    db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(hashSeq);
    db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(hashSeq, embedding);
    db.prepare(
      `INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at, fragment_type, fragment_label, canonical_id, embed_input_fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hash, seq, pos, model, embeddedAt, fragmentType ?? null, fragmentLabel ?? null, canonicalId ?? null, embedInputFp ?? null);
  }).immediate(); // immediate write lock: the lease assert reads under the lock, so a lost-lease write can't slip through
}

// =============================================================================
// Query expansion
// =============================================================================

/**
 * A typed query-expansion result. Decoupled from llm.ts's internal Queryable —
 * same information, but store.ts owns its own public API type and field name.
 *
 * Routing contract (every consumer MUST honor it):
 *   - lex  → FTS (BM25) only
 *   - vec  → vector only
 *   - hyde → vector only (hypothetical-document embedding)
 * The original query is searched on BOTH backends and is NOT included here —
 * callers add it explicitly with the 2× RRF anchor weight.
 */
export type ExpandedQuery = {
  type: 'lex' | 'vec' | 'hyde';
  query: string;
};

// Cache version + provider fingerprint for query expansion. Bumping the version
// invalidates every stale entry automatically: old newline-format and pre-terse-
// prompt garbage simply never hit again and age out of llm_cache via LRU (no manual
// purge). The provider fingerprint will distinguish qmd from a future zegen lex
// provider (P4) so a provider swap also invalidates the cache by construction.
const EXPAND_CACHE_VERSION = "v3-qmd-terse-typed";
const EXPAND_PROVIDER_FINGERPRINT = "qmd-terse";

/**
 * The EXACT llm_cache key expandQuery(query, model, intent) reads and writes.
 * Exported for eval harnesses (S49.3 freeze protocol): delete/verify expansion
 * cache rows without replicating the private key construction — the version and
 * provider fingerprint stay in one place.
 */
export function expandQueryCacheKey(query: string, model: string = DEFAULT_QUERY_MODEL, intent?: string): string {
  return getCacheKey(`expandQuery:${EXPAND_CACHE_VERSION}`, {
    query,
    model,
    provider: EXPAND_PROVIDER_FINGERPRINT,
    ...(intent && { intent }),
  });
}

export async function expandQuery(query: string, model: string = DEFAULT_QUERY_MODEL, db: Database, intent?: string): Promise<ExpandedQuery[]> {
  // Typed-JSON cache. Versioned key (include intent + provider fingerprint).
  const cacheKey = expandQueryCacheKey(query, model, intent);
  const cached = getCachedResult(db, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      // Accept ONLY a fully-valid, already-clean typed payload. A shape error on ANY
      // element, an empty array, or anything sanitization would drop/rewrite → treat
      // the entry as stale and re-expand (never return partial or dirty cached data).
      if (Array.isArray(parsed) && parsed.length > 0
        && parsed.every(r => r !== null && typeof r === "object"
          && typeof (r as Record<string, unknown>).query === "string"
          && ((r as Record<string, unknown>).type === "lex"
            || (r as Record<string, unknown>).type === "vec"
            || (r as Record<string, unknown>).type === "hyde"))) {
        const rows = parsed as Array<{ type: ExpandedQuery["type"]; query: string }>;
        const sanitized = sanitizeExpandedQueries(rows.map(r => ({ type: r.type, text: r.query })));
        const clean = sanitized.length === rows.length
          && sanitized.every((s, i) => s.type === rows[i]!.type && s.text === rows[i]!.query);
        if (clean) return rows;
      }
    } catch {
      // Malformed JSON — fall through and re-expand.
    }
  }

  const llm = getDefaultLlamaCpp();
  // Note: LlamaCpp uses a hardcoded model; the model parameter is ignored here.
  // Pass intent to steer expansion when provided.
  const results = await llm.expandQuery(query, { intent });

  // Defense-in-depth: re-run the shared guard (also covers the local GBNF path and
  // any future provider), then drop entries that just echo the original query.
  // llm.expandQuery substitutes its OWN typed fallback on any generation failure
  // (remote-empty, cooldown under NO_LOCAL_MODELS, local parse-empty/error). Detect
  // that leaked fallback AND the all-junk case, and return an expansions-only set
  // that is NOT cached — a transient failure must not poison the cache or break the
  // "expansions only, original excluded" contract.
  const cleaned = sanitizeExpandedQueries(results).filter(r => r.text !== query);
  if (cleaned.length === 0 || isFallbackExpansion(results, query)) {
    return expansionFallback(query)
      .filter(r => r.text !== query)   // expansions-only per the ExpandedQuery contract
      .map(r => ({ type: r.type, query: r.text }));
  }

  const expanded: ExpandedQuery[] = cleaned.map(r => ({ type: r.type, query: r.text }));
  setCachedResult(db, cacheKey, JSON.stringify(expanded));
  return expanded;
}

// =============================================================================
// Reranking
// =============================================================================

/** Options for the reranker health probe. Production query/hook callers omit all of these. */
export type RerankProbeOptions = {
  /** Skip the rerank cache entirely — forces a live endpoint call (health probes). */
  noCache?: boolean;
  /** Throw RerankCoverageError if any input doc was not scored by the reranker (checked before zero-fill). */
  requireLiveCoverage?: boolean;
  /** Abort signal for the remote fetch. */
  signal?: AbortSignal;
  /** Convenience: derive AbortSignal.timeout(timeoutMs) for the remote fetch when no signal is given. */
  timeoutMs?: number;
};

/** Thrown by rerank() when requireLiveCoverage is set and the reranker did not score every input doc. */
export class RerankCoverageError extends Error {
  constructor(public readonly missing: string[]) {
    super(`rerank coverage incomplete: ${missing.length} document(s) not scored by the reranker`);
    this.name = "RerankCoverageError";
  }
}

/**
 * Thrown by rerank() when requireLiveCoverage is set and the reranker's raw response violates the
 * coverage contract: wrong result count, duplicate/out-of-range index, or a non-finite score. A
 * malformed-but-responding reranker is exactly the failure a health probe must catch — it must not
 * be silently accepted (and a duplicate index can otherwise leave a doc unscored, or an out-of-range
 * index can crash the score apply).
 */
export class RerankMalformedResponseError extends Error {
  constructor(public readonly problems: string[]) {
    super(`rerank response malformed: ${problems.join("; ")}`);
    this.name = "RerankMalformedResponseError";
  }
}

export async function rerank(query: string, documents: { file: string; text: string }[], model: string = DEFAULT_RERANK_MODEL, db: Database, intent?: string, options?: RerankProbeOptions): Promise<{ file: string; score: number }[]> {
  // Prepend intent to rerank query so the reranker scores with domain context
  const rerankQuery = intent ? `${intent}\n\n${query}` : query;
  const noCache = options?.noCache === true;
  // Health probes thread a timeout to the remote fetch (the production path is otherwise untimed).
  const fetchSignal = options?.signal ?? (options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined);

  // Deduplicate identical chunk texts — same content from different files shares a single score
  const textToFiles = new Map<string, string[]>();
  const uniqueDocs: RerankDocument[] = [];
  for (const doc of documents) {
    const existing = textToFiles.get(doc.text);
    if (existing) {
      existing.push(doc.file);
    } else {
      textToFiles.set(doc.text, [doc.file]);
      uniqueDocs.push(doc);
    }
  }

  const cachedResults: Map<string, number> = new Map();
  const uncachedDocs: RerankDocument[] = [];

  // Check cache for each unique document. noCache (health probes) skips the cache entirely so the
  // call always exercises the live endpoint — a cached probe would mask an endpoint silently
  // reverted to a broken reranker.
  if (noCache) {
    for (const doc of uniqueDocs) uncachedDocs.push({ file: doc.file, text: doc.text });
  } else {
    for (const doc of uniqueDocs) {
      const cacheKey = getCacheKey("rerank", { query: rerankQuery, file: doc.file, model });
      const cached = getCachedResult(db, cacheKey);
      if (cached !== null) {
        const score = parseFloat(cached);
        // Apply score to all files sharing this text
        for (const file of textToFiles.get(doc.text)!) cachedResults.set(file, score);
      } else {
        uncachedDocs.push({ file: doc.file, text: doc.text });
      }
    }
  }

  // Rerank uncached documents (remote GPU preferred, local node-llama-cpp fallback)
  // Cap parallelism at 4 to prevent VRAM exhaustion
  if (uncachedDocs.length > 0) {
    const rerankUrl = Bun.env.CLAWMEM_RERANK_URL;
    const rerankApiKey = Bun.env.CLAWMEM_RERANK_API_KEY;
    let scored = false;

    // Try remote GPU reranker first
    // Truncate to ~400 chars per doc to fit within server's 512-token context
    // (query + document must fit in one pair; ~2 chars/token for mixed content)
    if (rerankUrl) {
      // Independent of the embed/LLM keys — the rerank endpoint may be a different
      // authenticated host. Sent as Authorization: Bearer when CLAWMEM_RERANK_API_KEY is set.
      const rerankHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (rerankApiKey) rerankHeaders["Authorization"] = `Bearer ${rerankApiKey}`;
      try {
        // Process in batches of 4 to prevent VRAM exhaustion
        for (let i = 0; i < uncachedDocs.length; i += 4) {
          const batch = uncachedDocs.slice(i, i + 4);
          const resp = await fetch(`${rerankUrl}/v1/rerank`, {
            method: "POST",
            headers: rerankHeaders,
            body: JSON.stringify({
              query: rerankQuery,
              documents: batch.map(d => d.text.slice(0, 400)),
            }),
            signal: fetchSignal,
          });
          if (resp.ok) {
            let data: { results: { index: number; relevance_score: number }[] };
            try {
              data = await resp.json() as { results: { index: number; relevance_score: number }[] };
            } catch {
              // Invalid JSON from a 200 response. For a probe this is a malformed remote → surface it;
              // for production treat it like a transport failure and fall through to local.
              if (options?.requireLiveCoverage) throw new RerankMalformedResponseError(["response body is not valid JSON"]);
              break;
            }
            // Strict contract for health probes: a results array of exactly batch.length, each with a
            // unique in-range integer index and a finite numeric score. A malformed-but-responding
            // reranker (including a null/primitive body) must surface, not be silently accepted.
            if (options?.requireLiveCoverage) {
              const problems: string[] = [];
              if (data === null || typeof data !== "object" || !Array.isArray(data.results)) {
                problems.push("response is not an object with a results array");
              } else {
                if (data.results.length !== batch.length) {
                  problems.push(`batch expected ${batch.length} results, got ${data.results.length}`);
                }
                const seen = new Set<number>();
                for (const r of data.results) {
                  if (!Number.isInteger(r?.index) || r.index < 0 || r.index >= batch.length) problems.push(`index ${r?.index} out of range`);
                  else if (seen.has(r.index)) problems.push(`duplicate index ${r.index}`);
                  else seen.add(r.index);
                  if (typeof r?.relevance_score !== "number" || !Number.isFinite(r.relevance_score)) problems.push(`non-finite score at index ${r?.index}`);
                }
              }
              if (problems.length > 0) throw new RerankMalformedResponseError(problems);
            }
            // Defensive (all callers): guard a non-array body, and skip out-of-range/non-finite entries
            // so a malformed response can never crash the score apply or store garbage. Under
            // requireLiveCoverage the strict check above has already thrown; here a skipped entry just
            // leaves the doc unscored (→ coverage error for probes, → zero-fill for production).
            for (const r of (Array.isArray(data?.results) ? data.results : [])) {
              const doc = batch[r.index];
              if (!doc || typeof r.relevance_score !== "number" || !Number.isFinite(r.relevance_score)) continue;
              if (!noCache) {
                const cacheKey = getCacheKey("rerank", { query: rerankQuery, file: doc.file, model });
                setCachedResult(db, cacheKey, r.relevance_score.toString());
              }
              // Apply score to all files sharing this text
              for (const file of textToFiles.get(doc.text)!) cachedResults.set(file, r.relevance_score);
            }
          } else {
            break; // Remote failed mid-batch, fall through to local
          }
        }
        scored = cachedResults.size > 0;
      } catch (e) {
        // Network/transport failure → fall through to local. But a malformed-response error (only
        // raised under requireLiveCoverage) is a probe FINDING about the remote endpoint — propagate
        // it instead of masking it with the local fallback.
        if (e instanceof RerankMalformedResponseError) throw e;
      }
    }

    // Fallback to local node-llama-cpp
    if (!scored) {
      const remaining = uncachedDocs.filter(d => !cachedResults.has(d.file));
      if (remaining.length > 0) {
        const llm = getDefaultLlamaCpp();
        const rerankResult = await llm.rerank(rerankQuery, remaining, { model });
        for (const result of rerankResult.results) {
          const doc = remaining.find(d => d.file === result.file);
          if (!noCache) {
            const cacheKey = getCacheKey("rerank", { query: rerankQuery, file: result.file, model });
            setCachedResult(db, cacheKey, result.score.toString());
          }
          // Apply score to all files sharing this text
          if (doc) {
            for (const file of textToFiles.get(doc.text)!) cachedResults.set(file, result.score);
          } else {
            cachedResults.set(result.file, result.score);
          }
        }
      }
    }
  }

  // Coverage check BEFORE the zero-fill below (health probes only, via requireLiveCoverage).
  // After the map, an omitted score and a true 0 are indistinguishable, so a partial endpoint
  // would otherwise look fully covered. See RERANKER-HEALTH-GUARD-DESIGN.md §5 (H1/M4).
  if (options?.requireLiveCoverage) {
    const missing = documents.filter(doc => !cachedResults.has(doc.file)).map(doc => doc.file);
    if (missing.length > 0) throw new RerankCoverageError(missing);
  }

  // Return all results sorted by score
  return documents
    .map(doc => ({ file: doc.file, score: cachedResults.get(doc.file) || 0 }))
    .sort((a, b) => b.score - a.score);
}

// =============================================================================
// Document retrieval
// =============================================================================

type DbDocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  path: string;
  modified_at: string;
  body_length: number;
  body?: string;
};

/**
 * Find a document by filename/path, docid (#hash), or with fuzzy matching.
 * Returns document metadata without body by default.
 *
 * Supports:
 * - Virtual paths: clawmem://collection/path/to/file.md
 * - Absolute paths: /path/to/file.md
 * - Relative paths: path/to/file.md
 * - Short docid: #abc123 (first 6 chars of hash)
 */
export function findDocument(db: Database, filename: string, options: { includeBody?: boolean } = {}): DocumentResult | DocumentNotFound {
  let filepath = filename;
  const colonMatch = filepath.match(/:(\d+)$/);
  if (colonMatch) {
    filepath = filepath.slice(0, -colonMatch[0].length);
  }

  // Check if this is a docid lookup (#hash or just 6-char hex)
  if (filepath.startsWith('#') || /^[a-f0-9]{6}$/i.test(filepath)) {
    const docidMatch = findDocumentByDocid(db, filepath);
    if (docidMatch) {
      filepath = docidMatch.filepath;
    } else {
      return { error: "not_found", query: filename, similarFiles: [] };
    }
  }

  if (filepath.startsWith('~/')) {
    filepath = homedir() + filepath.slice(1);
  }

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;

  // Build computed columns
  // Note: absoluteFilepath is computed from YAML collections after query
  const selectCols = `
    'clawmem://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  // Try to match by virtual path first
  let doc = db.prepare(`
    SELECT ${selectCols}
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE 'clawmem://' || d.collection || '/' || d.path = ? AND d.active = 1
  `).get(filepath) as DbDocRow | null;

  // Try fuzzy match by virtual path
  if (!doc) {
    doc = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'clawmem://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
      LIMIT 1
    `).get(`%${filepath}`) as DbDocRow | null;
  }

  // Try to match by absolute path (requires looking up collection paths from YAML)
  if (!doc && !filepath.startsWith('clawmem://')) {
    const collections = collectionsListCollections();
    for (const coll of collections) {
      let relativePath: string | null = null;

      // If filepath is absolute and starts with collection path, extract relative part
      if (filepath.startsWith(coll.path + '/')) {
        relativePath = filepath.slice(coll.path.length + 1);
      }
      // Otherwise treat filepath as relative to collection
      else if (!filepath.startsWith('/')) {
        relativePath = filepath;
      }

      if (relativePath) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as DbDocRow | null;
        if (doc) break;
      }
    }
  }

  if (!doc) {
    const similar = findSimilarFiles(db, filepath, 5, 5);
    return { error: "not_found", query: filename, similarFiles: similar };
  }

  // Get context using virtual path
  const virtualPath = doc.virtual_path || `clawmem://${doc.collection}/${doc.display_path}`;
  const context = getContextForFile(db, virtualPath);

  return {
    filepath: virtualPath,
    displayPath: doc.display_path,
    title: doc.title,
    context,
    hash: doc.hash,
    docid: getDocid(doc.hash),
    collectionName: doc.collection,
    modifiedAt: doc.modified_at,
    bodyLength: doc.body_length,
    ...(options.includeBody && doc.body !== undefined && { body: doc.body }),
  };
}

/**
 * Get the body content for a document
 * Optionally slice by line range
 */
export function getDocumentBody(db: Database, doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number): string | null {
  const filepath = doc.filepath;

  // Try to resolve document by filepath (absolute or virtual)
  let row: { body: string } | null = null;

  // Try virtual path first
  if (filepath.startsWith('clawmem://')) {
    row = db.prepare(`
      SELECT content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'clawmem://' || d.collection || '/' || d.path = ? AND d.active = 1
    `).get(filepath) as { body: string } | null;
  }

  // Try absolute path by looking up in YAML collections
  if (!row) {
    const collections = collectionsListCollections();
    for (const coll of collections) {
      if (filepath.startsWith(coll.path + '/')) {
        const relativePath = filepath.slice(coll.path.length + 1);
        row = db.prepare(`
          SELECT content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as { body: string } | null;
        if (row) break;
      }
    }
  }

  // Try collection/path format (e.g., "_clawmem/decisions/foo.md")
  if (!row) {
    const slashIdx = filepath.indexOf('/');
    if (slashIdx > 0) {
      const collection = filepath.slice(0, slashIdx);
      const path = filepath.slice(slashIdx + 1);
      row = db.prepare(`
        SELECT content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
      `).get(collection, path) as { body: string } | null;
    }
  }

  if (!row) return null;

  let body = row.body;
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = body.split('\n');
    const start = (fromLine || 1) - 1;
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    body = lines.slice(start, end).join('\n');
  }

  return body;
}

/**
 * Find multiple documents by glob pattern or comma-separated list
 * Returns documents without body by default (use getDocumentBody to load)
 */
export function findDocuments(
  db: Database,
  pattern: string,
  options: { includeBody?: boolean; maxBytes?: number } = {}
): { docs: MultiGetResult[]; errors: string[] } {
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?');
  const errors: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES;

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;
  const selectCols = `
    'clawmem://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  let fileRows: DbDocRow[];

  if (isCommaSeparated) {
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    fileRows = [];
    for (const name of names) {
      let doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE 'clawmem://' || d.collection || '/' || d.path = ? AND d.active = 1
      `).get(name) as DbDocRow | null;
      if (!doc) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE 'clawmem://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${name}`) as DbDocRow | null;
      }
      if (doc) {
        fileRows.push(doc);
      } else {
        const similar = findSimilarFiles(db, name, 5, 3);
        let msg = `File not found: ${name}`;
        if (similar.length > 0) {
          msg += ` (did you mean: ${similar.join(', ')}?)`;
        }
        errors.push(msg);
      }
    }
  } else {
    // Glob pattern match
    const matched = matchFilesByGlob(db, pattern);
    if (matched.length === 0) {
      errors.push(`No files matched pattern: ${pattern}`);
      return { docs: [], errors };
    }
    const virtualPaths = matched.map(m => m.filepath);
    const placeholders = virtualPaths.map(() => '?').join(',');
    fileRows = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'clawmem://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
    `).all(...virtualPaths) as DbDocRow[];
  }

  const results: MultiGetResult[] = [];

  for (const row of fileRows) {
    // Get context using virtual path
    const virtualPath = row.virtual_path || `clawmem://${row.collection}/${row.display_path}`;
    const context = getContextForFile(db, virtualPath);

    if (row.body_length > maxBytes) {
      results.push({
        doc: { filepath: virtualPath, displayPath: row.display_path },
        skipped: true,
        skipReason: `File too large (${Math.round(row.body_length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
      });
      continue;
    }

    results.push({
      doc: {
        filepath: virtualPath,
        displayPath: row.display_path,
        title: row.title || row.display_path.split('/').pop() || row.display_path,
        context,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: row.collection,
        modifiedAt: row.modified_at,
        bodyLength: row.body_length,
        ...(options.includeBody && row.body !== undefined && { body: row.body }),
      },
      skipped: false,
    });
  }

  return { docs: results, errors };
}

// =============================================================================
// Status
// =============================================================================

export function getStatus(db: Database): IndexStatus {
  // Load collections from YAML
  const yamlCollections = collectionsListCollections();

  // Get document counts and last update times for each collection
  const collections = yamlCollections.map(col => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as active_count,
        MAX(modified_at) as last_doc_update
      FROM documents
      WHERE collection = ? AND active = 1
    `).get(col.name) as { active_count: number; last_doc_update: string | null };

    return {
      name: col.name,
      path: col.path,
      pattern: col.pattern,
      documents: stats.active_count,
      lastUpdated: stats.last_doc_update || new Date().toISOString(),
    };
  });

  // Sort by last update time (most recent first)
  collections.sort((a, b) => {
    if (!a.lastUpdated) return 1;
    if (!b.lastUpdated) return -1;
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });

  const totalDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const hasVectors = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();

  return {
    totalDocuments: totalDocs,
    needsEmbedding,
    hasVectorIndex: hasVectors,
    collections,
  };
}

// =============================================================================
// Snippet extraction
// =============================================================================

export type SnippetResult = {
  line: number;           // 1-indexed line number of best match
  snippet: string;        // The snippet text with diff-style header
  linesBefore: number;    // Lines in document before snippet
  linesAfter: number;     // Lines in document after snippet
  snippetLines: number;   // Number of lines in snippet
};

// Stop words filtered from intent strings before tokenization
const INTENT_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "about", "how",
  "what", "when", "where", "which", "who", "whom", "why", "this", "that",
  "these", "those", "it", "its", "not", "no", "so", "if", "then", "than",
]);

/** Weight for intent terms relative to query terms (1.0) in snippet scoring */
const INTENT_SNIPPET_WEIGHT = 0.3;

/** Weight for intent terms relative to query terms (1.0) in chunk selection */
export const INTENT_CHUNK_WEIGHT = 0.5;

/**
 * Extract meaningful terms from an intent string, filtering stop words and punctuation.
 */
export function extractIntentTerms(intent: string): string[] {
  return intent.toLowerCase().split(/\s+/)
    .filter(w => w.length > 1 && !INTENT_STOP_WORDS.has(w))
    .map(w => w.replace(/[^a-z0-9-]/g, ""))
    .filter(w => w.length > 1);
}

export function extractSnippet(body: string, query: string, maxLen = 500, chunkPos?: number, intent?: string): SnippetResult {
  const totalLines = body.split('\n').length;
  let searchBody = body;
  let lineOffset = 0;

  if (chunkPos && chunkPos > 0) {
    const contextStart = Math.max(0, chunkPos - 100);
    const contextEnd = Math.min(body.length, chunkPos + maxLen + 100);
    searchBody = body.slice(contextStart, contextEnd);
    if (contextStart > 0) {
      lineOffset = body.slice(0, contextStart).split('\n').length - 1;
    }
  }

  const lines = searchBody.split('\n');
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  let bestLine = 0, bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? "").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lineLower.includes(term)) score++;
    }
    // Intent terms nudge snippet selection toward intent-relevant lines
    for (const term of intentTerms) {
      if (lineLower.includes(term)) score += INTENT_SNIPPET_WEIGHT;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 3);
  const snippetLines = lines.slice(start, end);
  let snippetText = snippetLines.join('\n');

  // If we focused on a chunk window and it produced an empty/whitespace-only snippet,
  // fall back to a full-document snippet so we always show something useful.
  if (chunkPos && chunkPos > 0 && snippetText.trim().length === 0) {
    return extractSnippet(body, query, maxLen, undefined, intent);
  }

  if (snippetText.length > maxLen) snippetText = snippetText.substring(0, maxLen - 3) + "...";

  const absoluteStart = lineOffset + start + 1; // 1-indexed
  const snippetLineCount = snippetLines.length;
  const linesBefore = absoluteStart - 1;
  const linesAfter = totalLines - (absoluteStart + snippetLineCount - 1);

  // Format with diff-style header: @@ -start,count @@ (linesBefore before, linesAfter after)
  const header = `@@ -${absoluteStart},${snippetLineCount} @@ (${linesBefore} before, ${linesAfter} after)`;
  const snippet = `${header}\n${snippetText}`;

  return {
    line: lineOffset + bestLine + 1,
    snippet,
    linesBefore,
    linesAfter,
    snippetLines: snippetLineCount,
  };
}

// =============================================================================
// SAME: Session Tracking
// =============================================================================

function insertSessionFn(db: Database, sessionId: string, startedAt: string, machine?: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO session_log (session_id, started_at, machine)
    VALUES (?, ?, ?)
  `).run(sessionId, startedAt, machine ?? null);
}

function updateSessionFn(db: Database, sessionId: string, updates: { endedAt?: string; handoffPath?: string; filesChanged?: string[]; summary?: string }): void {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (updates.endedAt !== undefined) { sets.push("ended_at = ?"); vals.push(updates.endedAt); }
  if (updates.handoffPath !== undefined) { sets.push("handoff_path = ?"); vals.push(updates.handoffPath); }
  if (updates.filesChanged !== undefined) { sets.push("files_changed = ?"); vals.push(JSON.stringify(updates.filesChanged)); }
  if (updates.summary !== undefined) { sets.push("summary = ?"); vals.push(updates.summary); }
  if (sets.length === 0) return;
  vals.push(sessionId);
  db.prepare(`UPDATE session_log SET ${sets.join(", ")} WHERE session_id = ?`).run(...vals);
}

function getSessionFn(db: Database, sessionId: string): SessionRecord | null {
  const row = db.prepare(`SELECT * FROM session_log WHERE session_id = ?`).get(sessionId) as any;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    handoffPath: row.handoff_path,
    machine: row.machine,
    filesChanged: row.files_changed ? JSON.parse(row.files_changed) : [],
    summary: row.summary,
  };
}

function getRecentSessionsFn(db: Database, limit: number): SessionRecord[] {
  const rows = db.prepare(`SELECT * FROM session_log ORDER BY started_at DESC LIMIT ?`).all(limit) as any[];
  return rows.map(row => ({
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    handoffPath: row.handoff_path,
    machine: row.machine,
    filesChanged: row.files_changed ? JSON.parse(row.files_changed) : [],
    summary: row.summary,
  }));
}

// =============================================================================
// SAME: Context Usage Tracking
// =============================================================================

function insertUsageFn(db: Database, usage: UsageRecord): number {
  // v0.8.1 Ext 6b: write query_text when the column is present AND the
  // caller provided one. The column presence is cached at migration time
  // in contextUsageHasQueryTextCache — missing entries default to false
  // so ad-hoc DBs constructed outside createStore() degrade gracefully
  // to the pre-v0.8.1 INSERT shape.
  const hasQueryText = contextUsageHasQueryTextCache.get(db) ?? false;
  if (hasQueryText) {
    db.prepare(`
      INSERT INTO context_usage
        (session_id, timestamp, hook_name, injected_paths, estimated_tokens, was_referenced, turn_index, query_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usage.sessionId,
      usage.timestamp,
      usage.hookName,
      JSON.stringify(usage.injectedPaths),
      usage.estimatedTokens,
      usage.wasReferenced,
      usage.turnIndex ?? 0,
      usage.queryText ?? null,
    );
  } else {
    db.prepare(`
      INSERT INTO context_usage (session_id, timestamp, hook_name, injected_paths, estimated_tokens, was_referenced, turn_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(usage.sessionId, usage.timestamp, usage.hookName, JSON.stringify(usage.injectedPaths), usage.estimatedTokens, usage.wasReferenced, usage.turnIndex ?? 0);
  }
  // Return the rowid of the just-inserted row for recall event linkage
  const row = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

function getUsageForSessionFn(db: Database, sessionId: string): UsageRow[] {
  return db.prepare(`
    SELECT id, session_id AS sessionId, timestamp, hook_name AS hookName,
           injected_paths AS injectedPaths, estimated_tokens AS estimatedTokens,
           was_referenced AS wasReferenced, turn_index AS turnIndex
    FROM context_usage WHERE session_id = ? ORDER BY turn_index, timestamp
  `).all(sessionId) as UsageRow[];
}

function markUsageReferencedFn(db: Database, id: number): void {
  db.prepare(`UPDATE context_usage SET was_referenced = 1 WHERE id = ?`).run(id);
}

// =============================================================================
// SAME: Document Metadata Operations
// =============================================================================

function updateDocumentMetaFn(db: Database, docId: number, meta: { domain?: string; workstream?: string; tags?: string; content_type?: string; review_by?: string; confidence?: number; quality_score?: number; authored_at?: string | null }): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (meta.domain !== undefined) { sets.push("domain = ?"); vals.push(meta.domain); }
  if (meta.workstream !== undefined) { sets.push("workstream = ?"); vals.push(meta.workstream); }
  if (meta.tags !== undefined) { sets.push("tags = ?"); vals.push(meta.tags); }
  if (meta.content_type !== undefined) { sets.push("content_type = ?"); vals.push(meta.content_type); }
  if (meta.review_by !== undefined) { sets.push("review_by = ?"); vals.push(meta.review_by); }
  if (meta.confidence !== undefined) { sets.push("confidence = ?"); vals.push(meta.confidence); }
  if (meta.quality_score !== undefined) { sets.push("quality_score = ?"); vals.push(meta.quality_score); }
  // §51.1: undefined = leave untouched; explicit null = CLEAR (file-backed
  // frontmatter is authoritative — a removed/invalid authored_at clears the row).
  if (meta.authored_at !== undefined) { sets.push("authored_at = ?"); vals.push(meta.authored_at); }
  if (sets.length === 0) return;
  vals.push(docId);
  db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

function pinDocumentFn(db: Database, collection: string, path: string, pinned: boolean): void {
  db.prepare(
    "UPDATE documents SET pinned = ? WHERE collection = ? AND path = ? AND active = 1"
  ).run(pinned ? 1 : 0, collection, path);
}

function snoozeDocumentFn(db: Database, collection: string, path: string, until: string | null): void {
  db.prepare(
    "UPDATE documents SET snoozed_until = ? WHERE collection = ? AND path = ? AND active = 1"
  ).run(until, collection, path);
}

function incrementAccessCountFn(db: Database, paths: string[]): void {
  if (paths.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = paths.map(() => "?").join(",");
  db.prepare(`
    UPDATE documents SET access_count = access_count + 1, last_accessed_at = ?
    WHERE active = 1 AND (collection || '/' || path) IN (${placeholders})
  `).run(now, ...paths);
}

function getDocumentsByTypeFn(db: Database, contentType: string, limit: number = 10, opts?: { orderBy?: "operational" | "effective" }): DocumentRow[] {
  // §51.1 D13: "effective" orders/limits by content time (authorship when known).
  // Content-currency callers must use the returned effectiveAt — not modifiedAt —
  // for ordering, cutoff filtering, and displayed dates. Default stays operational.
  const orderExpr = opts?.orderBy === "effective"
    ? "COALESCE(d.authored_at, d.modified_at)"
    : "d.modified_at";
  return db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, d.hash, d.modified_at as modifiedAt,
           d.authored_at as authoredAt,
           COALESCE(d.authored_at, d.modified_at) as effectiveAt,
           d.domain, d.workstream, d.tags, d.content_type as contentType,
           d.review_by as reviewBy, d.confidence, d.access_count as accessCount,
           LENGTH(c.doc) as bodyLength, d.pinned
    FROM documents d
    JOIN content c ON c.hash = d.hash
    WHERE d.active = 1 AND d.content_type = ?
    ORDER BY ${orderExpr} DESC
    LIMIT ?
  `).all(contentType, limit) as DocumentRow[];
}

function updateObservationFieldsFn(
  db: Database,
  docPath: string,
  collectionName: string,
  fields: { observation_type?: string; facts?: string; narrative?: string; concepts?: string; files_read?: string; files_modified?: string; skill_name?: string; quality_score?: string; failure_reason?: string }
): void {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (fields.observation_type !== undefined) { sets.push("observation_type = ?"); vals.push(fields.observation_type); }
  if (fields.facts !== undefined) { sets.push("facts = ?"); vals.push(fields.facts); }
  if (fields.narrative !== undefined) { sets.push("narrative = ?"); vals.push(fields.narrative); }
  if (fields.concepts !== undefined) { sets.push("concepts = ?"); vals.push(fields.concepts); }
  if (fields.files_read !== undefined) { sets.push("files_read = ?"); vals.push(fields.files_read); }
  if (fields.files_modified !== undefined) { sets.push("files_modified = ?"); vals.push(fields.files_modified); }
  if (fields.skill_name !== undefined) { sets.push("skill_name = ?"); vals.push(fields.skill_name); }
  if (fields.quality_score !== undefined) { sets.push("obs_quality_score = ?"); vals.push(fields.quality_score); }
  if (fields.failure_reason !== undefined) { sets.push("failure_reason = ?"); vals.push(fields.failure_reason); }
  if (sets.length === 0) return;
  vals.push(collectionName, docPath);
  db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE collection = ? AND path = ? AND active = 1`).run(...vals);
}

function getStaleDocumentsFn(db: Database, beforeDate: string): DocumentRow[] {
  // Staleness review stays on operational time (§51.1) — authoredAt/effectiveAt
  // are hydrated only so the returned rows satisfy the DocumentRow contract.
  return db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, d.hash, d.modified_at as modifiedAt,
           d.authored_at as authoredAt,
           COALESCE(d.authored_at, d.modified_at) as effectiveAt,
           d.domain, d.workstream, d.tags, d.content_type as contentType,
           d.review_by as reviewBy, d.confidence, d.access_count as accessCount,
           LENGTH(c.doc) as bodyLength
    FROM documents d
    JOIN content c ON c.hash = d.hash
    WHERE d.active = 1 AND d.review_by IS NOT NULL AND d.review_by != '' AND d.review_by <= ?
    ORDER BY d.review_by ASC
  `).all(beforeDate) as DocumentRow[];
}

// =============================================================================
// Beads Integration
// =============================================================================

/**
 * Sync Beads issues from .beads/beads.jsonl into ClawMem.
 * Returns count of synced and newly created issues.
 */
export async function syncBeadsIssues(
  db: Database,
  projectDir: string
): Promise<{ synced: number; created: number; newDocIds: number[] }> {
  const issues = queryBeadsList(projectDir);
  if (issues.length === 0) {
    console.warn(`[beads] No issues returned from bd list in ${projectDir}`);
    return { synced: 0, created: 0, newDocIds: [] };
  }

  let synced = 0;
  let created = 0;
  const newDocIds: number[] = [];

  for (const issue of issues) {
    const docPath = `_clawmem/beads/${issue.id}.md`;
    const docBody = formatBeadsIssueAsMarkdown(issue);
    const hash = await hashContent(docBody);

    const existingDoc = findActiveDocument(db, 'beads', docPath);

    if (existingDoc) {
      if (existingDoc.hash !== hash) {
        insertContent(db, hash, docBody, new Date().toISOString());
        db.prepare(`UPDATE documents SET hash = ?, modified_at = ? WHERE id = ?`)
          .run(hash, new Date().toISOString(), existingDoc.id);
      }

      db.prepare(`
        UPDATE beads_issues
        SET status = ?, priority = ?, assignee = ?, last_synced_at = ?
        WHERE beads_id = ?
      `).run(
        issue.status,
        issue.priority,
        issue.assignee || null,
        new Date().toISOString(),
        issue.id
      );
      synced++;
    } else {
      insertContent(db, hash, docBody, issue.created_at);
      insertDocument(db, 'beads', docPath, issue.title, hash, issue.created_at, issue.created_at);

      const newDoc = findActiveDocument(db, 'beads', docPath);
      if (!newDoc) {
        console.warn(`[beads] Failed to insert document for ${issue.id}`);
        continue;
      }

      db.prepare(`
        INSERT INTO beads_issues (
          beads_id, doc_id, issue_type, status, priority, tags,
          assignee, parent_id, created_at, closed_at, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        issue.id,
        newDoc.id,
        issue.type || issue.issue_type || "task",
        issue.status,
        issue.priority,
        JSON.stringify(issue.labels || issue.tags || []),
        issue.assignee || null,
        issue.parent || null,
        issue.created_at,
        issue.closed_at || null,
        new Date().toISOString()
      );

      newDocIds.push(newDoc.id);
      created++;
    }
  }

  // Second pass: insert all dependencies from Dolt (richer than legacy blocks-only)
  for (const issue of issues) {
    if (!issue.dependencies || issue.dependencies.length === 0) continue;
    for (const dep of issue.dependencies) {
      db.prepare(`
        INSERT OR IGNORE INTO beads_dependencies (source_id, target_id, dep_type, created_at)
        VALUES (?, ?, ?, ?)
      `).run(dep.issue_id, dep.depends_on_id, dep.type, dep.created_at || new Date().toISOString());
    }
  }

  // Third pass: bridge beads_dependencies → memory_relations for MAGMA graph traversal
  const depTypeMap: Record<string, string> = {
    'blocks': 'causal',
    'conditional-blocks': 'causal',
    'waits-for': 'causal',
    'caused-by': 'causal',
    'discovered-from': 'supporting',
    'supersedes': 'supporting',
    'duplicates': 'supporting',
    'relates-to': 'semantic',
    'related': 'semantic',
    'parent-child': 'semantic',
  };

  const allDeps = db.prepare(`SELECT source_id, target_id, dep_type FROM beads_dependencies`).all() as {
    source_id: string; target_id: string; dep_type: string;
  }[];

  for (const dep of allDeps) {
    const relationType = depTypeMap[dep.dep_type] || 'semantic';

    const sourceRow = db.prepare(`SELECT doc_id FROM beads_issues WHERE beads_id = ?`).get(dep.source_id) as { doc_id: number } | undefined;
    const targetRow = db.prepare(`SELECT doc_id FROM beads_issues WHERE beads_id = ?`).get(dep.target_id) as { doc_id: number } | undefined;

    if (sourceRow && targetRow) {
      // v0.8.3 (§1.3): mirror of insertRelation self-loop guard. Beads can
      // theoretically express a self-dependency (e.g. a `relates-to` edge
      // from an issue to itself); skip those before they land in the graph.
      if (sourceRow.doc_id === targetRow.doc_id) continue;
      db.prepare(`
        INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
        VALUES (?, ?, ?, 1.0, ?, ?)
      `).run(
        sourceRow.doc_id,
        targetRow.doc_id,
        relationType,
        JSON.stringify({ origin: 'beads', dep_type: dep.dep_type }),
        new Date().toISOString()
      );
    }
  }

  return { synced, created, newDocIds };
}

/**
 * Export for MCP tool registration.
 */
export { detectBeadsProject };

// =============================================================================
// MAGMA Graph Building
// =============================================================================

/**
 * Build temporal backbone - connect documents in chronological order.
 * Returns number of edges created.
 */
/**
 * Count edges of one relation type whose BOTH endpoints are still active.
 *
 * The graph builders only ever operate on active documents, so a raw `COUNT(*)` over
 * `memory_relations` reports edges the live graph no longer contains — deactivating one
 * endpoint left the reported total unchanged while the active graph had shrunk. Counting the
 * same population the builders work on is what makes "N new, M total" internally consistent.
 *
 * Lives here rather than inline at each caller so the MCP tool and the REST endpoint cannot
 * drift apart: they previously carried separate copies of this query.
 */
export function countActiveRelations(db: Database, relationType: string): number {
  return (db.prepare(
    `SELECT COUNT(*) c FROM memory_relations r
       JOIN documents src ON src.id = r.source_id AND src.active = 1
       JOIN documents tgt ON tgt.id = r.target_id AND tgt.active = 1
     WHERE r.relation_type = ?`,
  ).get(relationType) as { c: number }).c;
}

export function buildTemporalBackbone(db: Database): number {
  // Get all documents ordered by creation time
  const docs = db.prepare(`
    SELECT id, created_at, modified_at
    FROM documents
    WHERE active = 1
    ORDER BY created_at ASC
  `).all() as { id: number; created_at: string; modified_at: string }[];

  let edges = 0;

  // Create temporal edges between consecutive documents
  for (let i = 1; i < docs.length; i++) {
    const prev = docs[i - 1]!;
    const curr = docs[i]!;

    // Count rows SQLite actually wrote — `INSERT OR IGNORE` suppresses conflicts,
    // so an attempt counter reports edges that were never persisted.
    edges += db.prepare(`
      INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
      VALUES (?, ?, 'temporal', 1.0, ?)
    `).run(prev.id, curr.id, new Date().toISOString()).changes;
  }

  return edges;
}

/**
 * Build semantic graph from existing embeddings.
 * Connects documents with similarity > threshold.
 * Returns number of edges created.
 */
export async function buildSemanticGraph(
  db: Database,
  threshold: number = 0.7
): Promise<number> {
  // Query all documents with embeddings
  const docs = db.prepare(`
    SELECT DISTINCT d.id, d.hash
    FROM documents d
    JOIN content_vectors cv ON d.hash = cv.hash
    WHERE d.active = 1 AND cv.seq = 0
  `).all() as { id: number; hash: string }[];

  let edges = 0;

  // For each document, find similar neighbors
  for (let i = 0; i < docs.length; i++) {
    const doc1 = docs[i]!;

    // Find similar documents above threshold
    const similar = db.prepare(`
      SELECT
        d2.id as target_id,
        vec_distance_cosine(v1.embedding, v2.embedding) as distance
      FROM vectors_vec v1, vectors_vec v2
      JOIN documents d2 ON v2.hash_seq = d2.hash || '_0'
      WHERE v1.hash_seq = ? || '_0'
        AND d2.id != ?
        AND d2.active = 1
        AND vec_distance_cosine(v1.embedding, v2.embedding) < ?
      ORDER BY distance
      LIMIT 10
    `).all(doc1.hash, doc1.id, 1 - threshold) as { target_id: number; distance: number }[];

    for (const sim of similar) {
      const similarity = 1 - sim.distance;
      // Count rows SQLite actually wrote, matching buildTemporalBackbone — the two
      // counters feed one `build_graphs` response and must report the same unit.
      edges += db.prepare(`
        INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
        VALUES (?, ?, 'semantic', ?, ?)
      `).run(doc1.id, sim.target_id, similarity, new Date().toISOString()).changes;
    }
  }

  return edges;
}

// =============================================================================
// A-MEM: Causal Graph Traversal
// =============================================================================

/** One projected fact-pair witness on a causal edge (s342). Legacy witnesses
 *  (ordinals = -1) carry pre-cut evidence whose fact ordinals are unknowable. */
export type CausalWitness = {
  sourceFactOrdinal: number;
  targetFactOrdinal: number;
  sourceFact: string | null;
  targetFact: string | null;
  reasoning: string;
  confidence: number;
  /** created_at of the max-confidence sighting for this ordinal pair. */
  strongestAt: string;
  /** most recent sighting created_at for this ordinal pair — distinct from strongestAt. */
  lastSeenAt: string;
  legacy: boolean;
};

/** Directed causal edge record: invariant physical edge identity
 *  (sourceDocId → targetDocId) with traversal provenance kept SEPARATE
 *  (predecessorDocId/depth/direction) — consumers never invert fields. */
export type CausalEdgeRecord = {
  sourceDocId: number;
  targetDocId: number;
  /** The far endpoint this hop reached (== targetDocId outbound, sourceDocId inbound). */
  docId: number;
  title: string;
  filepath: string;
  predecessorDocId: number;
  depth: number;
  direction: 'causes' | 'caused_by';
  weight: number;
  /** Distinct ordinal-pair witnesses on this edge (witnesses lists the top 3). */
  evidenceCount: number;
  witnesses: CausalWitness[];
  /** true when witnesses were synthesized in-memory from pre-cut edge metadata. */
  legacy: boolean;
};

export type CausalEdgesResult = { edges: CausalEdgeRecord[]; truncated: boolean };

/** Combined budget across BOTH directions; the reader fetches budget+1 per
 *  direction as an overflow probe so `truncated` is truthful. */
export const CAUSAL_READER_MAX_EDGES = 50;
export const CAUSAL_READER_MAX_WITNESSES = 3;

type RawEdge = {
  sourceDocId: number;
  targetDocId: number;
  docId: number;
  title: string;
  filepath: string;
  predecessorDocId: number;
  depth: number;
  direction: 'causes' | 'caused_by';
  weight: number;
  metadata: string | null;
  edgeCreatedAt: string | null;
};

/** Deterministic total order for results AND truncation:
 *  (depth, weight DESC, sourceDocId, targetDocId, direction). */
function compareCausalEdges(a: RawEdge, b: RawEdge): number {
  return a.depth - b.depth
    || b.weight - a.weight
    || a.sourceDocId - b.sourceDocId
    || a.targetDocId - b.targetDocId
    || a.direction.localeCompare(b.direction);
}

/** Iterative bounded traversal, level-synchronous across BOTH directions so the
 *  retained set is the globally-first `probeLimit` edges under the reader's
 *  total order — (depth, weight DESC, sourceDocId, targetDocId, direction) —
 *  never an ID-arrival-order sample of one direction. Per level, each
 *  direction's SQL contributes its top `remaining` edges by weight (sufficient:
 *  the global top-R at one depth needs at most R from either direction), the
 *  level competes as one pool, and only KEPT edges extend the next frontier —
 *  a dropped edge never sponsors deeper traversal it wouldn't explain.
 *
 *  Eligibility (`active = 1 AND invalidated_at IS NULL`) is enforced on EVERY
 *  expansion, so an invalidated document stops traversal through it — never
 *  just hidden from output. Each node expands at most once per direction
 *  (cycle-safe); distinct edges all surface, so diamond paths keep every real
 *  edge. Titles are display-bounded so base responses stay under the wire
 *  ceiling by construction. */
function collectCausalEdges(
  db: Database,
  anchorId: number,
  dirs: Array<'causes' | 'caused_by'>,
  maxDepth: number,
  probeLimit: number,
): RawEdge[] {
  const edges: RawEdge[] = [];
  const seen = new Set<string>();
  const state = dirs.map(dir => ({
    dir,
    frontier: [anchorId] as number[],
    expanded: new Set<number>([anchorId]),
  }));

  for (let depth = 1; depth <= maxDepth && edges.length < probeLimit; depth++) {
    const remaining = probeLimit - edges.length;
    const level: RawEdge[] = [];
    for (const st of state) {
      if (st.frontier.length === 0) continue;
      const outbound = st.dir === 'causes';
      const nearCol = outbound ? 'source_id' : 'target_id';
      const farCol = outbound ? 'target_id' : 'source_id';
      const placeholders = st.frontier.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT mr.source_id, mr.target_id, mr.weight, mr.metadata,
                mr.created_at AS edge_created_at,
                d.title, d.collection || '/' || d.path AS filepath
         FROM memory_relations mr
         JOIN documents d ON d.id = mr.${farCol}
         WHERE mr.${nearCol} IN (${placeholders})
           AND mr.relation_type = 'causal'
           AND d.active = 1 AND d.invalidated_at IS NULL
         ORDER BY COALESCE(mr.weight, 1.0) DESC, mr.source_id, mr.target_id
         LIMIT ?`,
      ).all(...st.frontier, remaining) as Array<{
        source_id: number; target_id: number; weight: number | null;
        metadata: string | null; edge_created_at: string | null;
        title: string; filepath: string;
      }>;
      for (const row of rows) {
        const far = outbound ? row.target_id : row.source_id;
        const near = outbound ? row.source_id : row.target_id;
        level.push({
          sourceDocId: row.source_id,
          targetDocId: row.target_id,
          docId: far,
          title: row.title.slice(0, 300),
          filepath: row.filepath,
          predecessorDocId: near,
          depth,
          direction: st.dir,
          weight: row.weight ?? 1.0,
          metadata: row.metadata,
          edgeCreatedAt: row.edge_created_at,
        });
      }
    }

    // One pool per level: both directions compete under the total order.
    level.sort(compareCausalEdges);
    const kept: RawEdge[] = [];
    for (const e of level) {
      if (edges.length + kept.length >= probeLimit) break;
      const key = `${e.sourceDocId}:${e.targetDocId}:${e.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(e);
    }
    edges.push(...kept);

    let anyFrontier = false;
    for (const st of state) {
      const next: number[] = [];
      for (const e of kept) {
        if (e.direction !== st.dir) continue;
        if (!st.expanded.has(e.docId)) {
          st.expanded.add(e.docId);
          next.push(e.docId);
        }
      }
      next.sort((a, b) => a - b);
      st.frontier = next;
      if (next.length > 0) anyFrontier = true;
    }
    if (!anyFrontier) break;
  }
  return edges;
}

type ProjectedWitnessRow = {
  source_id: number; target_id: number;
  source_fact_ordinal: number; target_fact_ordinal: number;
  source_fact: string | null; target_fact: string | null;
  reasoning: string; confidence: number; legacy: number;
  created_at: string; last_seen_at: string;
  pair_rank: number; evidence_count: number;
};

/** SQL-side witness projection: per ordinal pair the max-confidence sighting
 *  wins (tie → latest created_at, then highest id), pairs rank by projected
 *  confidence, and only the top CAUSAL_READER_MAX_WITNESSES rows per edge —
 *  plus an honest per-edge evidence_count — cross into JS. Sightings are
 *  append-only forever (recurrence appends by design), so the reader must
 *  never hydrate an edge's complete history into memory. */
function projectedWitnessSql(edgeTupleCount: number): string {
  const valueTuples = Array.from({ length: edgeTupleCount }, () => '(?, ?)').join(',');
  return `
    WITH pair_proj AS (
      SELECT source_id, target_id, source_fact_ordinal, target_fact_ordinal,
             source_fact, target_fact, reasoning, confidence, legacy, created_at,
             ROW_NUMBER() OVER (
               PARTITION BY source_id, target_id, source_fact_ordinal, target_fact_ordinal
               ORDER BY confidence DESC, created_at DESC, id DESC) AS rn,
             MAX(created_at) OVER (
               PARTITION BY source_id, target_id, source_fact_ordinal, target_fact_ordinal) AS last_seen_at
      FROM causal_witness_sightings
      WHERE (source_id, target_id) IN (VALUES ${valueTuples})
    ),
    ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY source_id, target_id
               ORDER BY confidence DESC, source_fact_ordinal, target_fact_ordinal) AS pair_rank,
             COUNT(*) OVER (PARTITION BY source_id, target_id) AS evidence_count
      FROM pair_proj WHERE rn = 1
    )
    SELECT source_id, target_id, source_fact_ordinal, target_fact_ordinal,
           source_fact, target_fact, reasoning, confidence, legacy, created_at,
           last_seen_at, pair_rank, evidence_count
    FROM ranked WHERE pair_rank <= ${CAUSAL_READER_MAX_WITNESSES}`;
}

/** Lazy read-through for untouched pre-cut edges: synthesize one legacy display
 *  witness — via the SAME validity rule the writer and census apply
 *  (`parseLegacyEdgeWitness`), so no surface calls an edge valid that another
 *  refuses. Never written; invalid evidence yields NO witness. */
function synthesizeLegacyWitness(edge: RawEdge): CausalWitness | null {
  const parsed = parseLegacyEdgeWitness({ weight: edge.weight, metadata: edge.metadata });
  if (!parsed) return null;
  return {
    sourceFactOrdinal: -1,
    targetFactOrdinal: -1,
    sourceFact: parsed.sourceFact,
    targetFact: parsed.targetFact,
    reasoning: parsed.reasoning,
    confidence: parsed.confidence,
    strongestAt: edge.edgeCreatedAt ?? '',
    lastSeenAt: edge.edgeCreatedAt ?? '',
    legacy: true,
  };
}

/**
 * s342 causal reader: evidence-preserving directed edge traversal.
 *
 * Returns directed edge records — invariant sourceDocId/targetDocId with
 * traversal predecessor/depth/direction separate — each carrying up to
 * CAUSAL_READER_MAX_WITNESSES projected fact-pair witnesses. One combined
 * CAUSAL_READER_MAX_EDGES budget spans both directions, with an overflow probe
 * for a truthful `truncated` flag. Multi-hop CHAIN quality is explicitly
 * experimental (canon fence): depth > 1 records are per-edge evidence, never a
 * verified chain.
 */
export function findCausalLinks(
  db: Database,
  docId: number,
  direction: 'causes' | 'caused_by' | 'both' = 'both',
  maxDepth: number = 5
): CausalEdgesResult {
  if (maxDepth < 1) maxDepth = 1;
  if (maxDepth > 10) maxDepth = 10;

  // Anchor eligibility: an inactive or invalidated anchor yields nothing.
  const anchor = db.prepare(
    `SELECT 1 FROM documents WHERE id = ? AND active = 1 AND invalidated_at IS NULL`,
  ).get(docId);
  if (!anchor) return { edges: [], truncated: false };

  const probeLimit = CAUSAL_READER_MAX_EDGES + 1;
  const dirs: Array<'causes' | 'caused_by'> =
    direction === 'both' ? ['causes', 'caused_by'] : [direction];

  const collected = collectCausalEdges(db, docId, dirs, maxDepth, probeLimit);
  collected.sort(compareCausalEdges);
  const truncated = collected.length > CAUSAL_READER_MAX_EDGES;
  const kept = truncated ? collected.slice(0, CAUSAL_READER_MAX_EDGES) : collected;

  // Witness hydration: ONE query over the retained edge set, projected in SQL —
  // at most CAUSAL_READER_MAX_WITNESSES rows per edge reach JS regardless of
  // how many sightings history has accumulated.
  const witnessesByEdge = new Map<string, ProjectedWitnessRow[]>();
  const distinctEdges = [...new Map(kept.map(e => [`${e.sourceDocId}:${e.targetDocId}`, e])).values()];
  if (distinctEdges.length > 0) {
    const params = distinctEdges.flatMap(e => [e.sourceDocId, e.targetDocId]);
    const rows = db.prepare(projectedWitnessSql(distinctEdges.length)).all(...params) as ProjectedWitnessRow[];
    for (const row of rows) {
      const key = `${row.source_id}:${row.target_id}`;
      const list = witnessesByEdge.get(key) ?? [];
      list.push(row);
      witnessesByEdge.set(key, list);
    }
  }

  const edges: CausalEdgeRecord[] = kept.map(edge => {
    const projected = witnessesByEdge.get(`${edge.sourceDocId}:${edge.targetDocId}`);
    if (projected && projected.length > 0) {
      projected.sort((a, b) => a.pair_rank - b.pair_rank);
      return {
        sourceDocId: edge.sourceDocId,
        targetDocId: edge.targetDocId,
        docId: edge.docId,
        title: edge.title,
        filepath: edge.filepath,
        predecessorDocId: edge.predecessorDocId,
        depth: edge.depth,
        direction: edge.direction,
        weight: edge.weight,
        evidenceCount: projected[0]!.evidence_count,
        witnesses: projected.map(w => ({
          sourceFactOrdinal: w.source_fact_ordinal,
          targetFactOrdinal: w.target_fact_ordinal,
          sourceFact: w.source_fact,
          targetFact: w.target_fact,
          reasoning: w.reasoning,
          confidence: w.confidence,
          strongestAt: w.created_at,
          lastSeenAt: w.last_seen_at,
          legacy: w.legacy === 1,
        })),
        legacy: false,
      };
    }
    const synthesized = synthesizeLegacyWitness(edge);
    return {
      sourceDocId: edge.sourceDocId,
      targetDocId: edge.targetDocId,
      docId: edge.docId,
      title: edge.title,
      filepath: edge.filepath,
      predecessorDocId: edge.predecessorDocId,
      depth: edge.depth,
      direction: edge.direction,
      weight: edge.weight,
      evidenceCount: synthesized ? 1 : 0,
      witnesses: synthesized ? [synthesized] : [],
      legacy: true,
    };
  });

  return { edges, truncated };
}

// =============================================================================
// A-MEM: Memory Evolution Timeline
// =============================================================================

export type EvolutionEntry = {
  version: number;
  triggeredBy: {
    docId: number;
    title: string;
    filepath: string;
  };
  previousKeywords: string[] | null;
  newKeywords: string[] | null;
  previousContext: string | null;
  newContext: string | null;
  reasoning: string | null;
  createdAt: string;
};

export function getEvolutionTimeline(
  db: Database,
  docId: number,
  limit: number = 10
): EvolutionEntry[] {
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  const query = `
    SELECT
      e.version,
      e.triggered_by,
      d.title as trigger_title,
      d.collection || '/' || d.path as trigger_filepath,
      e.previous_keywords,
      e.new_keywords,
      e.previous_context,
      e.new_context,
      e.reasoning,
      e.created_at
    FROM memory_evolution e
    JOIN documents d ON d.id = e.triggered_by
    WHERE e.memory_id = ?
      AND d.active = 1
    ORDER BY e.created_at DESC
    LIMIT ?
  `;

  const rows = db.prepare(query).all(docId, limit) as Array<{
    version: number;
    triggered_by: number;
    trigger_title: string;
    trigger_filepath: string;
    previous_keywords: string | null;
    new_keywords: string | null;
    previous_context: string | null;
    new_context: string | null;
    reasoning: string | null;
    created_at: string;
  }>;

  return rows.map(row => {
    // Parse JSON keywords if present
    let prevKeywords: string[] | null = null;
    let newKeywords: string[] | null = null;

    try {
      prevKeywords = row.previous_keywords ? JSON.parse(row.previous_keywords) : null;
    } catch (e) {
      console.error('[amem] Failed to parse previous_keywords:', e);
    }

    try {
      newKeywords = row.new_keywords ? JSON.parse(row.new_keywords) : null;
    } catch (e) {
      console.error('[amem] Failed to parse new_keywords:', e);
    }

    return {
      version: row.version,
      triggeredBy: {
        docId: row.triggered_by,
        title: row.trigger_title,
        filepath: row.trigger_filepath,
      },
      previousKeywords: prevKeywords,
      newKeywords: newKeywords,
      previousContext: row.previous_context,
      newContext: row.new_context,
      reasoning: row.reasoning,
      createdAt: row.created_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle management functions
// ---------------------------------------------------------------------------

function getArchiveCandidatesFn(
  db: Database,
  policy: import("./collections.ts").LifecyclePolicy
): { id: number; collection: string; path: string; title: string; modified_at: string; last_accessed_at: string | null; content_type: string }[] {
  const now = new Date();
  const defaultDays = policy.archive_after_days;

  const rows = db.prepare(`
    SELECT id, collection, path, title, modified_at, last_accessed_at, content_type
    FROM documents
    WHERE active = 1 AND pinned = 0
      AND (snoozed_until IS NULL OR snoozed_until = '' OR snoozed_until <= ?)
  `).all(now.toISOString()) as any[];

  const candidates: any[] = [];
  for (const row of rows) {
    if (policy.exempt_collections.includes(row.collection)) continue;

    const typeOverride = policy.type_overrides[row.content_type];
    if (typeOverride === null) continue;
    const thresholdDays = typeOverride ?? defaultDays;

    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - thresholdDays);
    const cutoffStr = cutoff.toISOString();

    const modifiedStale = row.modified_at <= cutoffStr;
    const accessedStale = !row.last_accessed_at || row.last_accessed_at <= cutoffStr;

    if (modifiedStale && accessedStale) {
      candidates.push(row);
    }
  }

  return candidates;
}

function restoreArchivedDocumentsFn(
  db: Database,
  filter: { ids?: number[]; collection?: string; sinceDate?: string }
): number {
  let where = "WHERE active = 0 AND archived_at IS NOT NULL";
  const params: any[] = [];

  if (filter.ids?.length) {
    const placeholders = filter.ids.map(() => "?").join(",");
    where += ` AND id IN (${placeholders})`;
    params.push(...filter.ids);
  }
  if (filter.collection) {
    where += " AND collection = ?";
    params.push(filter.collection);
  }
  if (filter.sinceDate) {
    where += " AND archived_at >= ?";
    params.push(filter.sinceDate);
  }

  // Same trigger-inflation problem as archiveDocuments: `.changes` counts the
  // `documents_fts` shadow writes too. Count the matching rows explicitly instead.
  return db.transaction(() => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM documents ${where}`)
      .get(...params) as { n: number } | undefined;
    db.prepare(`UPDATE documents SET active = 1, archived_at = NULL, deactivated_reason = NULL ${where}`).run(...params);
    return row?.n ?? 0;
  })();
}

// NOTE: `purgeArchivedDocumentsFn` was removed in v0.30.0. It ran
// `DELETE FROM documents WHERE active = 0 AND archived_at <= ?` — the only operation in
// ClawMem that destroyed a row rather than deactivating it, and therefore the only one
// with no restore path. It was reachable from an agent-invoked MCP tool, from an
// unattended SessionStart hook, and from the CLI.
//
// ClawMem no longer physically deletes document rows from ANY code path. Retention is
// archival, which `restoreArchivedDocuments` reverses. Reclaiming disk space is an
// out-of-band operator action on the SQLite file, explicitly outside ClawMem's mutation
// contract — deliberately NOT an affordance this package offers, because any in-process
// or CLI credential is equally available to the coding agent the package serves.
//
// A supported retention design (reversible quarantine with a protected window) is tracked
// separately. Do not reintroduce a hard delete here without it.

function getLifecycleStatsFn(db: Database): {
  active: number; archived: number; forgotten: number;
  pinned: number; snoozed: number;
  neverAccessed: number; oldestAccess: string | null;
} {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN active = 0 AND archived_at IS NOT NULL THEN 1 ELSE 0 END) as archived,
      SUM(CASE WHEN active = 0 AND archived_at IS NULL THEN 1 ELSE 0 END) as forgotten,
      SUM(CASE WHEN active = 1 AND pinned = 1 THEN 1 ELSE 0 END) as pinned,
      SUM(CASE WHEN active = 1 AND snoozed_until IS NOT NULL AND snoozed_until > datetime('now') THEN 1 ELSE 0 END) as snoozed,
      SUM(CASE WHEN active = 1 AND last_accessed_at IS NULL THEN 1 ELSE 0 END) as neverAccessed,
      MIN(CASE WHEN active = 1 AND last_accessed_at IS NOT NULL THEN last_accessed_at END) as oldestAccess
    FROM documents
  `).get() as any;

  return {
    active: row?.active ?? 0,
    archived: row?.archived ?? 0,
    forgotten: row?.forgotten ?? 0,
    pinned: row?.pinned ?? 0,
    snoozed: row?.snoozed ?? 0,
    neverAccessed: row?.neverAccessed ?? 0,
    oldestAccess: row?.oldestAccess ?? null,
  };
}

function searchArchivedFn(
  db: Database,
  query: string,
  limit: number = 20
): { id: number; collection: string; path: string; title: string; archived_at: string; score: number }[] {
  const likePattern = `%${query}%`;
  const rows = db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, d.archived_at
    FROM documents d
    LEFT JOIN content c ON c.hash = d.hash
    WHERE d.active = 0 AND d.archived_at IS NOT NULL
      AND (d.title LIKE ? OR d.path LIKE ? OR d.collection LIKE ? OR c.doc LIKE ?)
    LIMIT ?
  `).all(likePattern, likePattern, likePattern, likePattern, limit) as any[];

  return rows.map((r: any) => ({
    id: r.id, collection: r.collection, path: r.path, title: r.title,
    archived_at: r.archived_at, score: 1.0,
  }));
}

// =============================================================================
// Vault-aware store resolution
// =============================================================================

/**
 * Resolve a store by vault name. If no vault is specified, returns the default store.
 * Named vaults are configured via config.yaml or CLAWMEM_VAULTS env var.
 *
 * @param vault  - Named vault (e.g., "work", "personal"). Omit for default.
 * @param opts   - Store options (readonly, busyTimeout)
 */
export function resolveStore(
  vault?: string,
  opts?: { readonly?: boolean; busyTimeout?: number }
): Store {
  if (!vault) {
    return createStore(undefined, opts);
  }

  const vaultPath = getVaultPath(vault);
  if (!vaultPath) {
    throw new Error(
      `Unknown vault: "${vault}". Configure it via CLAWMEM_VAULTS env var ` +
      `or in ~/.config/clawmem/config.yaml under "vaults:".`
    );
  }

  return createStore(vaultPath, opts);
}
