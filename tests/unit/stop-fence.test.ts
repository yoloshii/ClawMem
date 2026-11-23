/**
 * 62.1 D9/D10: the stop-pipeline schema migration and the writer fence (design tests 17, 18, 56).
 *
 * Baseline (8e2579a): none of the 62.1 tables, stamp columns or triggers exist, so an older ClawMem's Stop hooks keep
 * re-incrementing counters and overwriting the session documents after the upgrade (CM-02, CM-07). Each "baseline
 * writer" below is the exact statement 8e2579a runs; on a migrated vault it must be ignored and logged, and every
 * new-code writer of the same rows must still land.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { logInjection } from "../../src/hooks.ts";

import { seedContent } from "../helpers/seed-content.ts";
// The objects the migration adds (design D9, D10; IMPL-PLAN step (a)).
const STOP_TABLES = [
  "utility_signals", "feedback_ledger", "feedback_turns", "stop_cursors", "stop_retries", "stop_items", "session_docs",
  "session_transcripts", "causal_due", "judge_deferred", "judge_pair_verdicts", "legacy_writer_log",
  "counter_repair_log", "recovered_antipattern_bodies",
];
const STOP_COLUMNS: Record<string, string[]> = {
  context_usage: ["prompt_sha", "transcript_key", "host", "session_key", "writer_stamp", "source_usage_id"],
  documents: ["counter_stamp", "doc_stamp", "access_grace_until"],
  memory_relations: ["stamp"],
  co_activations: ["stamp"],
  utility_signals: ["stamp"],
};
const SCHEMA_MARKER = "stop-pipeline:schema-v1";
const USAGE_WATERMARK = "stop-pipeline:usage-watermark";

const NOW = () => new Date().toISOString();

// ─── The baseline's writers, verbatim from 8e2579a ─────────────────────────────────────────────────────────────────
const baseline = {
  /** store.ts incrementAccessCountFn */
  incrementAccessCount(db: Database, paths: string[]) {
    db.prepare(`
    UPDATE documents SET access_count = access_count + 1, last_accessed_at = ?
    WHERE active = 1 AND (collection || '/' || path) IN (${paths.map(() => "?").join(",")})
  `).run(NOW(), ...paths);
  },
  /** store.ts initializeDatabase: the last_accessed_at backfill */
  backfillLastAccessed(db: Database) {
    db.exec(`UPDATE documents SET last_accessed_at = modified_at WHERE last_accessed_at IS NULL`);
  },
  /** store.ts insertRelation (the CM-19 sum) */
  insertRelation(db: Database, from: number, to: number, relType: string, weight = 1.0) {
    db.prepare(`
        INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET
          weight = weight + excluded.weight,
          created_at = excluded.created_at
      `).run(from, to, relType, weight, NOW());
  },
  /** store.ts recordCoActivation (one pair) */
  recordCoActivation(db: Database, a: string, b: string) {
    db.prepare(`
        INSERT INTO co_activations (doc_a, doc_b, count, last_seen)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(doc_a, doc_b) DO UPDATE SET
          count = count + 1,
          last_seen = excluded.last_seen
      `).run(a, b, NOW());
  },
  /** feedback-loop.ts trackUtilitySignals (lazy CREATE + upsert) */
  trackUtility(db: Database, path: string, referenced: 0 | 1) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS utility_signals (
      path TEXT NOT NULL,
      surfaced_count INTEGER NOT NULL DEFAULT 0,
      referenced_count INTEGER NOT NULL DEFAULT 0,
      last_surfaced TEXT,
      last_referenced TEXT,
      PRIMARY KEY (path)
    )
  `);
    const now = NOW();
    db.prepare(`
    INSERT INTO utility_signals (path, surfaced_count, referenced_count, last_surfaced, last_referenced)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      surfaced_count = surfaced_count + 1,
      referenced_count = referenced_count + ?,
      last_surfaced = ?,
      last_referenced = CASE WHEN ? > 0 THEN ? ELSE last_referenced END
  `).run(path, referenced, now, referenced > 0 ? now : null, referenced, now, referenced, now);
  },
  /** decision-extractor.ts: the decision/antipattern merge UPDATE */
  mergeUpdate(db: Database, docId: number, hash: string) {
    const ts = NOW();
    db.prepare(
      "UPDATE documents SET hash = ?, modified_at = ?, revision_count = revision_count + 1, last_seen_at = ? WHERE id = ?"
    ).run(hash, ts, ts, docId);
  },
  /** store.ts saveMemory: the insert of its write phase */
  saveMemoryInsert(db: Database, path: string, hash: string, contentType: string) {
    const now = NOW();
    db.prepare(`
        INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active,
                               content_type, confidence, quality_score, normalized_hash,
                               duplicate_count, revision_count, last_seen_at, topic_key, authored_at,
                               origin)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'api')
      `).run("_clawmem", path, "Title", hash, now, now, contentType, 0.85, 0.5, `norm-${hash}`, now, null, null);
  },
  /** store.ts saveMemory: the same-path update */
  saveMemoryUpdate(db: Database, docId: number, hash: string, contentType: string) {
    const now = NOW();
    db.prepare(`
            UPDATE documents
            SET hash = ?, title = ?, modified_at = ?, content_type = ?,
                confidence = ?, quality_score = ?, normalized_hash = ?,
                revision_count = revision_count + 1, last_seen_at = ?, origin = 'api'
            WHERE id = ?
          `).run(hash, "Title", now, contentType, 0.85, 0.5, `norm-${hash}`, now, docId);
  },
  /** store.ts insertDocument (persistObservationDoc's insert: no content_type, typed afterwards) */
  insertDocument(db: Database, collection: string, path: string, hash: string) {
    const now = NOW();
    db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, origin)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(collection, path, "Observation", hash, now, now, "api");
  },
  /** hooks.ts wasPromptSeenRecently: the hook_dedupe write for a NEW prompt */
  hookDedupe(db: Database, hash: string) {
    db.prepare(`
      INSERT INTO hook_dedupe (hook_name, prompt_hash, prompt_preview, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(hook_name, prompt_hash) DO UPDATE SET
        prompt_preview = excluded.prompt_preview,
        last_seen_at = excluded.last_seen_at
    `).run("context-surfacing", hash, "a new prompt", NOW());
  },
  /** hooks.ts logInjection + store.ts insertUsageFn (query_text shape): returns the usage id, or -1 on a throw */
  logInjection(db: Database, sessionId: string, queryText: string): number {
    try {
      db.prepare(`
      INSERT INTO context_usage
        (session_id, timestamp, hook_name, injected_paths, estimated_tokens, was_referenced, turn_index, query_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, NOW(), "context-surfacing", "[]", 0, 0, 0, queryText);
      const row = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
      return row.id;
    } catch {
      return -1;
    }
  },
  /** store.ts insertUsageFn: the drainer's keyed mirror insert */
  insertMirror(db: Database, sessionId: string, dedupeKey: string) {
    db.prepare(`
      INSERT OR IGNORE INTO context_usage
        (session_id, timestamp, hook_name, injected_paths, estimated_tokens, was_referenced, turn_index, query_text, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, NOW(), "context-surfacing", "[]", 0, 0, 0, null, dedupeKey);
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
function tableNames(db: Database): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(r => r.name));
}
function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name));
}
function flag(db: Database, name: string): string | null {
  return (db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(name) as { value: string } | null)?.value ?? null;
}
function legacyLogCount(db: Database): number {
  return (db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM legacy_writer_log`).get() as { n: number }).n;
}
function docRow(db: Database, collection: string, path: string) {
  return db.prepare(`SELECT id, hash, content_type, access_count, last_accessed_at FROM documents WHERE collection = ? AND path = ?`)
    .get(collection, path) as { id: number; hash: string; content_type: string; access_count: number; last_accessed_at: string | null } | null;
}
function addContent(db: Database, body: string): string {
  const hash = `h-${Bun.hash(body).toString(16)}-${Math.random().toString(36).slice(2, 8)}`;
  seedContent(db, hash, body, NOW());
  return hash;
}
async function readyOf(db: Database): Promise<boolean> {
  const mod = await import("../../src/stop-schema.ts");
  return mod.stopPipelineReady(db);
}

/**
 * Take a vault back to its pre-62.1 shape: fence triggers, the new tables and the stamp columns dropped, markers
 * removed, `utility_signals` re-created the way the baseline feedback-loop creates it (lazily, no stamp).
 */
function downgradeToBaseline(db: Database): void {
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%legacy_writer_log%'`)
    .all() as { name: string }[];
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  for (const [table, cols] of Object.entries(STOP_COLUMNS)) {
    if (table === "utility_signals") continue;
    const present = columnNames(db, table);
    const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`)
      .all(table) as { name: string; sql: string }[];
    for (const ix of indexes) if (cols.some(c => ix.sql.includes(c))) db.exec(`DROP INDEX "${ix.name}"`);
    for (const c of cols) if (present.has(c)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${c}`);
  }
  for (const t of STOP_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.exec(`DELETE FROM vault_flags WHERE flag LIKE 'stop-pipeline:%'`);
  baseline.trackUtility(db, "notes/legacy.md", 0);   // the lazily created, stamp-less table
}

const tmpDirs: string[] = [];
function tmpVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-621-fence-"));
  tmpDirs.push(dir);
  return join(dir, "index.sqlite");
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ─── D10 migration (test 18) ───────────────────────────────────────────────────────────────────────────────────────
describe("D10 stop-pipeline migration", () => {
  it("a fresh vault gets every table, stamp column, marker and a zero usage watermark", async () => {
    const store = createTestStore();
    const tables = tableNames(store.db);
    for (const t of STOP_TABLES) expect(tables.has(t)).toBe(true);
    for (const [table, cols] of Object.entries(STOP_COLUMNS)) {
      const present = columnNames(store.db, table);
      for (const c of cols) expect(`${table}.${c}:${present.has(c)}`).toBe(`${table}.${c}:true`);
    }
    expect(flag(store.db, SCHEMA_MARKER)).not.toBeNull();
    expect(flag(store.db, USAGE_WATERMARK)).toBe("0");
    expect(await readyOf(store.db)).toBe(true);
  });

  it("a pre-upgrade vault damaged by the baseline hooks is migrated in place, keeping its data", async () => {
    const path = tmpVault();
    const s1 = createStore(path);
    downgradeToBaseline(s1.db);
    const [a, b] = [addContent(s1.db, "a"), addContent(s1.db, "b")];
    baseline.insertDocument(s1.db, "notes", "a.md", a);
    baseline.insertDocument(s1.db, "notes", "b.md", b);
    const ida = docRow(s1.db, "notes", "a.md")!.id;
    const idb = docRow(s1.db, "notes", "b.md")!.id;
    for (let i = 0; i < 3; i++) baseline.insertRelation(s1.db, ida, idb, "usage");
    baseline.recordCoActivation(s1.db, "notes/a.md", "notes/b.md");
    for (let i = 0; i < 3; i++) baseline.logInjection(s1.db, "sess-old", `prompt ${i}`);
    const maxUsage = (s1.db.prepare(`SELECT MAX(id) AS m FROM context_usage`).get() as { m: number }).m;
    addContent(s1.db, "# Antipatterns 2026-09-01\n\n- **Avoid:** an orphaned body");
    s1.close();

    const s2 = createStore(path);
    const tables = tableNames(s2.db);
    for (const t of STOP_TABLES) expect(tables.has(t)).toBe(true);
    for (const [table, cols] of Object.entries(STOP_COLUMNS)) {
      const present = columnNames(s2.db, table);
      for (const c of cols) expect(`${table}.${c}:${present.has(c)}`).toBe(`${table}.${c}:true`);
    }
    expect(flag(s2.db, USAGE_WATERMARK)).toBe(String(maxUsage));
    expect(await readyOf(s2.db)).toBe(true);
    // Nothing is repaired or lost by the migration itself (the recompute is a separate, reviewable step).
    expect((s2.db.prepare(`SELECT weight FROM memory_relations WHERE relation_type = 'usage'`).get() as { weight: number }).weight).toBe(3);
    expect((s2.db.prepare(`SELECT count FROM co_activations`).get() as { count: number }).count).toBe(1);
    expect((s2.db.prepare(`SELECT surfaced_count FROM utility_signals WHERE path = 'notes/legacy.md'`).get() as { surfaced_count: number }).surfaced_count).toBe(1);
    expect((s2.db.prepare(`SELECT COUNT(*) AS n FROM context_usage`).get() as { n: number }).n).toBe(3);
    s2.close();
  });

  it("the usage watermark is recorded once: later rows and later opens never move it", () => {
    const path = tmpVault();
    const s1 = createStore(path);
    expect(flag(s1.db, USAGE_WATERMARK)).toBe("0");
    s1.insertUsage({ sessionId: "s", timestamp: NOW(), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0 });
    s1.close();
    const s2 = createStore(path);
    expect(flag(s2.db, USAGE_WATERMARK)).toBe("0");
    s2.close();
  });

  it("an already-migrated vault opens without taking the write lock (read-guarded)", async () => {
    const path = tmpVault();
    createStore(path).close();
    const holder = new Database(path);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      const s = createStore(path, { busyTimeout: 50 });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(await readyOf(s.db)).toBe(true);
      s.close();
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("a migration that cannot commit leaves the store open but not ready, logs loudly, and the next open retries", async () => {
    const path = tmpVault();
    const s0 = createStore(path);
    downgradeToBaseline(s0.db);
    s0.close();

    const holder = new Database(path);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const warnings: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let s1: Store;
    try {
      s1 = createStore(path, { busyTimeout: 50 });
    } finally {
      console.error = origError;
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(await readyOf(s1!.db)).toBe(false);
    expect(warnings.some(w => /stop-pipeline/i.test(w))).toBe(true);
    expect(tableNames(s1!.db).has("stop_cursors")).toBe(false);   // nothing of the transaction remains
    s1!.close();

    const s2 = createStore(path);
    expect(await readyOf(s2.db)).toBe(true);
    expect(tableNames(s2.db).has("stop_cursors")).toBe(true);
    s2.close();
  });
});

// ─── D9 fence: baseline writers are ignored and logged (test 17) ───────────────────────────────────────────────────
describe("D9 fence blocks the baseline's Stop-hook writers on a migrated vault", () => {
  function fixture() {
    const store = createTestStore();
    const db = store.db;
    const [ha, hb] = [addContent(db, "note a"), addContent(db, "note b")];
    store.insertDocument("notes", "a.md", "Note A", ha, NOW(), NOW());
    store.insertDocument("notes", "b.md", "Note B", hb, NOW(), NOW());
    return { store, db, a: docRow(db, "notes", "a.md")!, b: docRow(db, "notes", "b.md")! };
  }

  it("the counter statement (access_count, last_accessed_at) is ignored and logged", () => {
    const { db, a } = fixture();
    baseline.incrementAccessCount(db, ["notes/a.md", "notes/b.md"]);
    expect(docRow(db, "notes", "a.md")!.access_count).toBe(a.access_count);
    expect(docRow(db, "notes", "a.md")!.last_accessed_at).toBe(a.last_accessed_at);
    expect(legacyLogCount(db)).toBeGreaterThanOrEqual(2);   // one per row the statement tried to change
  });

  it("the last_accessed_at backfill is ignored and logged", () => {
    const { db } = fixture();
    db.prepare(`UPDATE documents SET last_accessed_at = NULL, counter_stamp = 'test-reset' WHERE path = 'a.md'`).run();
    baseline.backfillLastAccessed(db);
    expect(docRow(db, "notes", "a.md")!.last_accessed_at).toBeNull();
    expect(legacyLogCount(db)).toBeGreaterThan(0);
  });

  it("the usage-relation insert and its summing upsert are ignored and logged; other relation types are not fenced", () => {
    const { store, db, a, b } = fixture();
    baseline.insertRelation(db, a.id, b.id, "usage");
    expect(db.prepare(`SELECT 1 FROM memory_relations WHERE relation_type = 'usage'`).get()).toBeNull();
    store.insertRelation(a.id, b.id, "usage");               // a new-code row exists …
    baseline.insertRelation(db, a.id, b.id, "usage", 5);      // … and the baseline upsert cannot add to it
    expect((db.prepare(`SELECT weight FROM memory_relations WHERE relation_type = 'usage'`).get() as { weight: number }).weight).toBe(1);
    expect(legacyLogCount(db)).toBe(2);
    baseline.insertRelation(db, a.id, b.id, "semantic", 0.4);
    expect((db.prepare(`SELECT weight FROM memory_relations WHERE relation_type = 'semantic'`).get() as { weight: number }).weight).toBeCloseTo(0.4, 10);
    expect(legacyLogCount(db)).toBe(2);
  });

  it("the co-activation upsert is ignored and logged, on insert and on conflict", () => {
    const { store, db } = fixture();
    baseline.recordCoActivation(db, "notes/a.md", "notes/b.md");
    expect(db.prepare(`SELECT 1 FROM co_activations`).get()).toBeNull();
    store.recordCoActivation(["notes/a.md", "notes/b.md"]);
    baseline.recordCoActivation(db, "notes/a.md", "notes/b.md");
    expect((db.prepare(`SELECT count FROM co_activations`).get() as { count: number }).count).toBe(1);
    expect(legacyLogCount(db)).toBe(2);
  });

  it("the utility-signal upsert (with its lazy CREATE) is ignored and logged", () => {
    const { db } = fixture();
    baseline.trackUtility(db, "notes/a.md", 1);
    expect(db.prepare(`SELECT 1 FROM utility_signals WHERE path = 'notes/a.md'`).get()).toBeNull();
    expect(legacyLogCount(db)).toBe(1);
  });

  it("the antipattern/decision merge UPDATE cannot overwrite a session document (CM-07)", () => {
    const { store, db } = fixture();
    const body = "# Antipatterns 2026-09-30\n\n- **Avoid:** turn one";
    store.saveMemory({ collection: "_clawmem", path: "antipatterns/2026-09-30-abcd1234.md", title: "Antipatterns", body, contentType: "antipattern" });
    const before = docRow(db, "_clawmem", "antipatterns/2026-09-30-abcd1234.md")!;
    baseline.mergeUpdate(db, before.id, addContent(db, "# Antipatterns 2026-09-30\n\n- **Avoid:** only the last window"));
    expect(docRow(db, "_clawmem", "antipatterns/2026-09-30-abcd1234.md")!.hash).toBe(before.hash);
    expect(legacyLogCount(db)).toBe(1);
  });

  it("saveMemory's insert and same-path update at a protected path are ignored and logged", () => {
    const { store, db } = fixture();
    baseline.saveMemoryInsert(db, "decisions/2026-09-30-new00000.md", addContent(db, "d1"), "decision");
    expect(docRow(db, "_clawmem", "decisions/2026-09-30-new00000.md")).toBeNull();

    store.saveMemory({ collection: "_clawmem", path: "handoffs/2026-09-30-abcd1234.md", title: "Handoff", body: "h1", contentType: "handoff" });
    const before = docRow(db, "_clawmem", "handoffs/2026-09-30-abcd1234.md")!;
    // At an existing path the baseline's insert is ignored before the UNIQUE check (no error, no overwrite) …
    expect(() => baseline.saveMemoryInsert(db, "handoffs/2026-09-30-abcd1234.md", addContent(db, "h2"), "handoff")).not.toThrow();
    // … and its same-path update is ignored too.
    baseline.saveMemoryUpdate(db, before.id, addContent(db, "h3"), "handoff");
    expect(docRow(db, "_clawmem", "handoffs/2026-09-30-abcd1234.md")!.hash).toBe(before.hash);
    expect(legacyLogCount(db)).toBe(3);
  });

  it("persistObservationDoc's type-less insert is ignored; its follow-up typing UPDATE matches nothing", () => {
    const { db } = fixture();
    baseline.insertDocument(db, "_clawmem", "observations/2026-09-30-abcd1234-decision-0badf00d.md", addContent(db, "obs"));
    expect(docRow(db, "_clawmem", "observations/2026-09-30-abcd1234-decision-0badf00d.md")).toBeNull();
    expect(legacyLogCount(db)).toBe(1);
  });

  it("other _clawmem paths are not fenced (synthesized facts, notes)", () => {
    const { db } = fixture();
    baseline.insertDocument(db, "_clawmem", "synthesized/fact-1.md", addContent(db, "fact"));
    expect(docRow(db, "_clawmem", "synthesized/fact-1.md")).not.toBeNull();
    expect(legacyLogCount(db)).toBe(0);
  });
});

// ─── D9 fence: every new-code writer of the fenced rows passes (C3) ─────────────────────────────────────────────────
describe("D9 fence lets every new-code writer through", () => {
  it("counters, relations, co-activations and usage rows written by this version land and log nothing", () => {
    const store = createTestStore();
    const db = store.db;
    store.insertDocument("notes", "a.md", "Note A", addContent(db, "a"), NOW(), NOW());
    store.insertDocument("notes", "b.md", "Note B", addContent(db, "b"), NOW(), NOW());
    const a = docRow(db, "notes", "a.md")!;
    const b = docRow(db, "notes", "b.md")!;

    store.incrementAccessCount(["notes/a.md"]);
    store.incrementAccessCount(["notes/a.md"]);
    expect(docRow(db, "notes", "a.md")!.access_count).toBe(a.access_count + 2);

    store.insertRelation(a.id, b.id, "usage");
    store.insertRelation(a.id, b.id, "usage", 0.5);
    expect((db.prepare(`SELECT weight FROM memory_relations WHERE relation_type = 'usage'`).get() as { weight: number }).weight).toBe(1);

    store.recordCoActivation(["notes/a.md", "notes/b.md"]);
    store.recordCoActivation(["notes/a.md", "notes/b.md"]);
    expect((db.prepare(`SELECT count FROM co_activations`).get() as { count: number }).count).toBe(2);

    const u1 = store.insertUsage({ sessionId: "s", timestamp: NOW(), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, queryText: "q" });
    const u2 = store.insertUsage({ sessionId: "s", timestamp: NOW(), hookName: "context-surfacing", injectedPaths: ["notes/a.md"], estimatedTokens: 5, wasReferenced: 0, dedupeKey: "mirror-1" });
    const u3 = store.insertUsage({ sessionId: "s", timestamp: NOW(), hookName: "context-surfacing", injectedPaths: ["notes/a.md"], estimatedTokens: 5, wasReferenced: 0, dedupeKey: "mirror-1" });
    expect(u1).toBeGreaterThan(0);
    expect(u2).toBeGreaterThan(0);
    expect(u3).toBe(u2);   // the keyed re-insert still reuses the mirror
    expect(logInjection(store, "s", "session-bootstrap", ["notes/a.md", "notes/b.md"], 10)).toBeGreaterThan(0);
    const unstamped = db.prepare(`SELECT COUNT(*) AS n FROM context_usage WHERE writer_stamp IS NULL`).get() as { n: number };
    expect(unstamped.n).toBe(0);

    expect(legacyLogCount(db)).toBe(0);
  });

  it("logInjection records no injection-time co-activations for any hook (BUILD-5 extended)", () => {
    const store = createTestStore();
    logInjection(store, "s", "session-bootstrap", ["notes/a.md", "notes/b.md", "notes/c.md"], 10);
    logInjection(store, "s", "staleness-check", ["notes/a.md", "notes/b.md"], 10);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM co_activations`).get() as { n: number }).n).toBe(0);
  });

  it("session documents written by this version (saveMemory, insertDocument, updateDocument, reactivateDocument) land", () => {
    const store = createTestStore();
    const db = store.db;
    const r1 = store.saveMemory({ collection: "_clawmem", path: "decisions/2026-09-30-abcd1234.md", title: "Decisions", body: "d1", contentType: "decision" });
    expect(r1.action).toBe("inserted");
    const r2 = store.saveMemory({ collection: "_clawmem", path: "decisions/2026-09-30-abcd1234.md", title: "Decisions", body: "d1 then d2, a longer body", contentType: "decision" });
    expect(r2.action).toBe("updated");

    const obsPath = "observations/2026-09-30-abcd1234-decision-0badf00d.md";
    store.insertDocument("_clawmem", obsPath, "Obs", addContent(db, "obs"), NOW(), NOW());
    const obs = docRow(db, "_clawmem", obsPath)!;
    expect(obs).not.toBeNull();
    const newHash = addContent(db, "obs revised");
    store.updateDocument(obs.id, "Obs", newHash, NOW());
    expect(docRow(db, "_clawmem", obsPath)!.hash).toBe(newHash);

    db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'absent' WHERE id = ?`).run(obs.id);
    const back = addContent(db, "obs back");
    expect(store.reactivateDocument(obs.id, "Obs", back, NOW())).toBe(true);
    expect(docRow(db, "_clawmem", obsPath)!.hash).toBe(back);

    expect(legacyLogCount(db)).toBe(0);
  });

  it("the open-time last_accessed_at backfill of this version passes the fence", () => {
    const path = tmpVault();
    const s1 = createStore(path);
    s1.insertDocument("notes", "a.md", "Note A", addContent(s1.db, "a"), NOW(), NOW());
    s1.db.prepare(`UPDATE documents SET last_accessed_at = NULL, counter_stamp = 'test-reset' WHERE path = 'a.md'`).run();
    s1.close();
    const s2 = createStore(path);
    expect(docRow(s2.db, "notes", "a.md")!.last_accessed_at).not.toBeNull();
    expect(legacyLogCount(s2.db)).toBe(0);
    s2.close();
  });
});

// ─── rev 21/22 usage-row trigger (test 56) ─────────────────────────────────────────────────────────────────────────
describe("D9 usage-row trigger fails an older surfacing hook closed (RAISE(FAIL))", () => {
  it("the baseline surfacing sequence (new prompt → hook_dedupe row → unstamped usage insert) injects nothing", () => {
    const store = createTestStore();
    const db = store.db;
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM context_usage`).get() as { n: number }).n;
    baseline.hookDedupe(db, "prompt-hash-new");
    // An IGNOREd insert would leave the hook_dedupe row's id in last_insert_rowid() and pass the alignment check.
    expect(baseline.logInjection(db, "sess-old", "a new prompt")).toBe(-1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM context_usage`).get() as { n: number }).n).toBe(before);
    const log = db.prepare(`SELECT surface, count FROM legacy_writer_log`).all() as { surface: string; count: number }[];
    expect(log.length).toBe(1);   // the trigger's log write survives the failed statement
    expect(log[0]!.count).toBe(1);
  });

  it("an older drainer's keyed mirror insert fails too (OR IGNORE does not swallow the trigger)", () => {
    const store = createTestStore();
    expect(() => baseline.insertMirror(store.db, "sess-old", "mirror-legacy")).toThrow();
    expect(store.db.prepare(`SELECT 1 FROM context_usage WHERE dedupe_key = 'mirror-legacy'`).get()).toBeNull();
  });
});
