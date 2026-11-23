/**
 * Origin-aware reconciliation — DB-born rows must survive filesystem-absence reconciliation.
 *
 * The absence reconciler treated EVERY active row in a collection as filesystem-owned: any
 * stored path missing from disk was deactivated 'absent'. Rows created directly in the DB
 * (hooks via insertDocument/saveMemory, beads sync, REST) have no backing file BY DESIGN,
 * so sharing a collection with filesystem indexing deactivated them on every pass —
 * measured in one production vault: 2,430 of 2,437 DB-born rows inactive. `documents.origin`
 * now records the lifecycle owner ('fs' | 'api'; NULL = ambiguous legacy, exempt), and the
 * reconciler enumerates only origin='fs'.
 *
 * House discipline: assertions are on rows, never on the shape of the source.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "fs";
import { createStore, getReconcilableDocumentPaths, type Store } from "../../src/store.ts";
import { indexCollection, hashContent } from "../../src/indexer.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

import { seedContent } from "../helpers/seed-content.ts";
const ROOT = "/tmp/clawmem-origin-reconciliation-test";
const CONTENT = `${ROOT}/content`;
const DB = `${ROOT}/vault.sqlite`;

/** Enrichment is unavailable in every case below — the realistic no-GPU condition. */
const deadLlm = {
  embed: async () => { throw new Error("no embedding endpoint in test"); },
  query: async () => null,
  expandQuery: async () => [],
} as any;

let store: Store;

const writeDoc = (name: string, body: string) => writeFileSync(`${CONTENT}/${name}`, body);
const reindex = () => indexCollection(store, "docs", CONTENT, "**/*.md");

const rowOf = (path: string) =>
  store.db.prepare("SELECT id, active, origin, deactivated_reason FROM documents WHERE collection = 'docs' AND path = ?")
    .get(path) as { id: number; active: number; origin: string | null; deactivated_reason: string | null } | undefined;

/** A hook-style DB-born row in the SAME collection the filesystem indexer reconciles. */
function seedDbBorn(path: string): void {
  const body = `# ${path}\n\nDB-born row with no file behind it.\n`;
  const hash = hashContent(body + path);
  const now = new Date().toISOString();
  seedContent(store.db, hash, body, now);
  store.insertDocument("docs", path, path, hash, now, now); // origin defaults to 'api'
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(CONTENT, { recursive: true });
  setDefaultLlamaCpp(deadLlm);
  store = createStore(DB);
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Origin stamping
// ---------------------------------------------------------------------------

describe("origin stamping", () => {
  it("filesystem rows get 'fs'; DB-born insertDocument rows get 'api'", async () => {
    writeDoc("file.md", "# F\n\nbody\n");
    await reindex();
    seedDbBorn("hooks/obs-1.md");

    expect(rowOf("file.md")!.origin).toBe("fs");
    expect(rowOf("hooks/obs-1.md")!.origin).toBe("api");
  });

  it("saveMemory rows are 'api'", () => {
    const r = store.saveMemory({
      collection: "docs",
      path: "mem/note-1.md",
      title: "note",
      body: "agent memory body",
      contentType: "observation",
    });
    const row = store.db.prepare("SELECT origin FROM documents WHERE id = ?")
      .get(r.docId) as { origin: string | null };
    expect(row.origin).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation exemption — the fix itself
// ---------------------------------------------------------------------------

describe("reconciliation exempts DB-born rows", () => {
  it("a DB-born row in a filesystem collection survives every reconciliation pass", async () => {
    writeDoc("file.md", "# F\n\nbody\n");
    await reindex();
    seedDbBorn("hooks/obs-1.md");

    await reindex(); // pass with the file still present
    expect(rowOf("hooks/obs-1.md")!.active).toBe(1);

    unlinkSync(`${CONTENT}/file.md`);
    await reindex(); // pass that deactivates the vanished FILE row

    // The file row reconciles; the DB-born row must not.
    expect(rowOf("file.md")!.active).toBe(0);
    expect(rowOf("file.md")!.deactivated_reason).toBe("absent");
    expect(rowOf("hooks/obs-1.md")!.active).toBe(1);
    expect(rowOf("hooks/obs-1.md")!.deactivated_reason).toBeNull();
  });

  it("fs rows still reconcile: absent deactivates, return reactivates, origin survives the round trip", async () => {
    writeDoc("cycle.md", "# C\n\nbody\n");
    await reindex();

    unlinkSync(`${CONTENT}/cycle.md`);
    await reindex();
    expect(rowOf("cycle.md")!.active).toBe(0);
    expect(rowOf("cycle.md")!.deactivated_reason).toBe("absent");

    writeDoc("cycle.md", "# C\n\nbody\n");
    await reindex();
    expect(rowOf("cycle.md")!.active).toBe(1);
    expect(rowOf("cycle.md")!.origin).toBe("fs");

    // A reactivated row must remain reconcilable — a mutant that stamped 'api' on
    // reactivation would pass everything above and fail here.
    unlinkSync(`${CONTENT}/cycle.md`);
    await reindex();
    expect(rowOf("cycle.md")!.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy NULL-origin rows — adoption-on-touch + fail-safe exemption
// ---------------------------------------------------------------------------

describe("legacy NULL-origin rows", () => {
  it("a NULL-origin row with an UNCHANGED file heals to 'fs' on the next pass — no backfill exists", async () => {
    // Kills the unchanged-path mutant: the content never changes, so ONLY the unchanged
    // short-circuit's own adoption stamp can heal the row. Also proves no open-time
    // backfill stamps it (content_hash proves nothing — mined imports write it too).
    writeDoc("old.md", "# O\n\nbody\n");
    await reindex();
    store.db.prepare("UPDATE documents SET origin = NULL WHERE collection = 'docs' AND path = 'old.md'").run();

    store.close();
    store = createStore(DB); // reopen: migration runs; NO backfill may stamp anything
    expect(rowOf("old.md")!.origin).toBeNull();

    await reindex();         // unchanged file → adoption happens on the touch path
    expect(rowOf("old.md")!.origin).toBe("fs");
  });

  it("ambiguous NULL-origin rows (no content_hash) stay NULL and are never deactivated", async () => {
    writeDoc("file.md", "# F\n\nbody\n");
    await reindex();

    // A pre-content_hash row whose file is already gone: nothing proves 'fs', so the
    // backfill must NOT stamp it and the reconciler must leave it alone (fail-safe).
    const body = "# legacy\n\nold row\n";
    const hash = hashContent(body);
    const now = new Date().toISOString();
    seedContent(store.db, hash, body, now);
    store.insertDocument("docs", "legacy.md", "legacy", hash, now, now);
    store.db.prepare("UPDATE documents SET origin = NULL, content_hash = NULL WHERE collection = 'docs' AND path = 'legacy.md'").run();

    store.close();
    store = createStore(DB);
    expect(rowOf("legacy.md")!.origin).toBeNull();

    await reindex();
    expect(rowOf("legacy.md")!.active).toBe(1);
    expect(rowOf("legacy.md")!.deactivated_reason).toBeNull();
  });

  it("a pre-migration absent row returns with origin 'fs' and stays reconcilable", async () => {
    // Kills the stamp-deletion mutant: the row starts NULL-origin while INACTIVE, so only
    // the reactivation path's own `origin = ?` assignment can make it 'fs'.
    writeDoc("legacy-cycle.md", "# L\n\nbody\n");
    await reindex();
    unlinkSync(`${CONTENT}/legacy-cycle.md`);
    await reindex();
    expect(rowOf("legacy-cycle.md")!.active).toBe(0);
    store.db.prepare("UPDATE documents SET origin = NULL WHERE collection = 'docs' AND path = 'legacy-cycle.md'").run();

    writeDoc("legacy-cycle.md", "# L\n\nbody\n");
    await reindex();
    expect(rowOf("legacy-cycle.md")!.active).toBe(1);
    expect(rowOf("legacy-cycle.md")!.origin).toBe("fs");

    unlinkSync(`${CONTENT}/legacy-cycle.md`);
    await reindex();
    expect(rowOf("legacy-cycle.md")!.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-migration schema — the enumeration fails SAFE, never wide
// ---------------------------------------------------------------------------

describe("pre-migration schema fails safe", () => {
  it("without the origin column, reconciliation enumerates NOTHING, then heals after reopen + reindex", async () => {
    writeDoc("proven.md", "# P\n\nbody\n");
    await reindex();
    seedDbBorn("hooks/obs-2.md"); // DB-born: content_hash NULL

    // Simulate the pre-migration schema (SQLite >= 3.35 supports DROP COLUMN).
    store.db.exec("ALTER TABLE documents DROP COLUMN origin");

    // Fail-safe means fail-CLOSED here: no inference fallback exists (content_hash proves
    // nothing about ownership), so nothing is reconcilable until the migration lands.
    expect(getReconcilableDocumentPaths(store.db, "docs")).toEqual([]);

    // Reopen: the migration re-adds the column; everything is NULL (no backfill). The next
    // index pass adopts the present file as 'fs'; the DB-born row stays NULL and exempt —
    // the real upgrade path for old vaults.
    store.close();
    store = createStore(DB);
    expect(rowOf("proven.md")!.origin).toBeNull();
    await reindex();
    expect(rowOf("proven.md")!.origin).toBe("fs");
    expect(rowOf("hooks/obs-2.md")!.origin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveMemory ownership boundary
// ---------------------------------------------------------------------------

describe("saveMemory ownership boundary", () => {
  it("rejects a path collision with a filesystem-owned row, leaving row AND content untouched", async () => {
    writeDoc("owned.md", "# Owned\n\nfile body\n");
    await reindex();
    const before = rowOf("owned.md")!;
    const contentBefore = (store.db.prepare("SELECT COUNT(*) n FROM content").get() as { n: number }).n;

    expect(() => store.saveMemory({
      collection: "docs",
      path: "owned.md",
      title: "takeover",
      body: "api body",
      contentType: "observation",
    })).toThrow(/filesystem-owned/);

    const after = store.db.prepare("SELECT origin, title, active FROM documents WHERE id = ?")
      .get(before.id) as { origin: string | null; title: string; active: number };
    expect(after.origin).toBe("fs");
    expect(after.title).not.toBe("takeover");
    expect(after.active).toBe(1);

    // The rejection happens BEFORE any write: no orphaned content row may be left behind.
    const contentAfter = (store.db.prepare("SELECT COUNT(*) n FROM content").get() as { n: number }).n;
    expect(contentAfter).toBe(contentBefore);
  });

  it("rejects a path occupied by an INACTIVE document without leaking content", () => {
    // The inactive row still holds UNIQUE(collection, path); a blind insert would orphan the
    // content row on the rethrow. The preflight must reject BEFORE any write — and never
    // resurrect a lifecycle decision (§55.6 D9).
    seedDbBorn("mem/gone.md");
    store.deactivateDocument("docs", "mem/gone.md", "forget");
    const before = (store.db.prepare("SELECT COUNT(*) n FROM content").get() as { n: number }).n;

    expect(() => store.saveMemory({
      collection: "docs",
      path: "mem/gone.md",
      title: "resurrect",
      body: "should not land anywhere",
      contentType: "observation",
    })).toThrow(/inactive document/);

    expect(rowOf("mem/gone.md")!.active).toBe(0);
    const after = (store.db.prepare("SELECT COUNT(*) n FROM content").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("dedup adopts a NULL-origin candidate as 'api'", () => {
    // Same content within the window dedups to the earlier row; the counter update is a
    // touch, so it must stamp the legacy NULL row 'api'.
    const p = {
      collection: "docs", path: "mem/d1.md", title: "d",
      body: "identical dedup body", contentType: "observation",
    };
    store.saveMemory(p);
    store.db.prepare("UPDATE documents SET origin = NULL WHERE collection = 'docs' AND path = 'mem/d1.md'").run();

    const r = store.saveMemory({ ...p, path: "mem/d2.md" });
    expect(r.action).toBe("deduplicated");
    const row = store.db.prepare("SELECT origin FROM documents WHERE collection = 'docs' AND path = 'mem/d1.md'")
      .get() as { origin: string | null };
    expect(row.origin).toBe("api");
  });

  it("never dedups against a row the filesystem has claimed", () => {
    // Observable contract of the ownership-conditional dedup: once a row is 'fs', identical
    // content within the window must land as a NEW document, and the fs row's counters and
    // origin stay untouched. (The microsecond SELECT→UPDATE interleave is single-connection
    // untestable; the conditional WHERE covers it by construction.)
    const p = {
      collection: "docs", path: "mem/r1.md", title: "r",
      body: "race-window body", contentType: "observation",
    };
    store.saveMemory(p);
    store.db.prepare("UPDATE documents SET origin = 'fs' WHERE collection = 'docs' AND path = 'mem/r1.md'").run();

    const r = store.saveMemory({ ...p, path: "mem/r2.md" });
    expect(r.action).toBe("inserted");
    const fsRow = store.db.prepare("SELECT origin, duplicate_count FROM documents WHERE collection = 'docs' AND path = 'mem/r1.md'")
      .get() as { origin: string | null; duplicate_count: number };
    expect(fsRow.origin).toBe("fs");
    expect(fsRow.duplicate_count).toBe(1);
  });

  it("a legacy mined-shape row (NULL origin, content_hash set) is claimable by saveMemory", () => {
    // The exact shape codex measured live: 1,353 conversations rows, DB-born via mine,
    // carrying content_hash. Ownership must NOT be inferred from content_hash — the row is
    // claimable, and saveMemory's touch stamps it 'api'.
    seedDbBorn("mined/conv_0001.md");
    store.db.prepare("UPDATE documents SET origin = NULL, content_hash = 'deadbeef' WHERE collection = 'docs' AND path = 'mined/conv_0001.md'").run();

    const r = store.saveMemory({
      collection: "docs",
      path: "mined/conv_0001.md",
      title: "synthesized",
      body: "synthesis over a mined conversation",
      contentType: "observation",
    });
    expect(r.action).toBe("updated");
    const row = store.db.prepare("SELECT origin FROM documents WHERE collection = 'docs' AND path = 'mined/conv_0001.md'")
      .get() as { origin: string | null };
    expect(row.origin).toBe("api");
  });

  it("updates an API row on collision and stamps a legacy NULL-origin row 'api'", () => {
    // Legacy shape: NULL origin, NULL content_hash — nothing proves filesystem ownership,
    // and saveMemory touching it IS proof of API ownership.
    seedDbBorn("mem/topic.md");
    store.db.prepare("UPDATE documents SET origin = NULL WHERE collection = 'docs' AND path = 'mem/topic.md'").run();

    const r = store.saveMemory({
      collection: "docs",
      path: "mem/topic.md",
      title: "updated",
      body: "new api body",
      contentType: "observation",
    });
    expect(r.action).toBe("updated");
    const row = store.db.prepare("SELECT origin FROM documents WHERE collection = 'docs' AND path = 'mem/topic.md'")
      .get() as { origin: string | null };
    expect(row.origin).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// importMode — additive DB-born ingest (`clawmem mine`) through the pipeline
// ---------------------------------------------------------------------------

describe("importMode: additive DB-born ingest", () => {
  const STAGE_A = `${ROOT}/stage-a`;
  const STAGE_B = `${ROOT}/stage-b`;
  const minedRow = (path: string) =>
    store.db.prepare("SELECT active, origin, deactivated_reason FROM documents WHERE collection = 'mined' AND path = ?")
      .get(path) as { active: number; origin: string | null; deactivated_reason: string | null } | undefined;
  const mineInto = (dir: string) => indexCollection(store, "mined", dir, "**/*.md", { importMode: true });

  it("stamps rows 'api', skips reconciliation, and keeps prior batches across imports", async () => {
    mkdirSync(STAGE_A, { recursive: true });
    writeFileSync(`${STAGE_A}/chunk_0001.md`, "# c1\n\nfirst batch\n");
    await mineInto(STAGE_A);
    expect(minedRow("chunk_0001.md")!.origin).toBe("api");

    // Second import into the SAME collection from a staging root that does NOT contain the
    // first batch — the defect this mode closes: batch one must survive.
    mkdirSync(STAGE_B, { recursive: true });
    writeFileSync(`${STAGE_B}/chunk_0002.md`, "# c2\n\nsecond batch\n");
    await mineInto(STAGE_B);
    expect(minedRow("chunk_0001.md")!.active).toBe(1);
    expect(minedRow("chunk_0001.md")!.deactivated_reason).toBeNull();
    expect(minedRow("chunk_0002.md")!.origin).toBe("api");
  });

  it("a changed re-import keeps origin 'api' through the update path", async () => {
    mkdirSync(STAGE_A, { recursive: true });
    writeFileSync(`${STAGE_A}/chunk_0001.md`, "# c1\n\nfirst body\n");
    await mineInto(STAGE_A);
    writeFileSync(`${STAGE_A}/chunk_0001.md`, "# c1\n\nCHANGED body\n");
    await mineInto(STAGE_A); // update path must not flip the row to 'fs'
    expect(minedRow("chunk_0001.md")!.origin).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// Indexer ownership-collision boundary — no silent takeover in EITHER direction
// ---------------------------------------------------------------------------

describe("indexer ownership-collision boundary", () => {
  it("importMode never takes over a filesystem-owned path", async () => {
    writeDoc("shared.md", "# S\n\nfs body\n");
    await reindex(); // 'fs'-owned row in docs

    // An import into the SAME collection whose staging root collides on the path, with
    // CHANGED content — the takeover vector: the changed-update path must skip, not stamp.
    const STAGE = `${ROOT}/stage-collide`;
    mkdirSync(STAGE, { recursive: true });
    writeFileSync(`${STAGE}/shared.md`, "# S\n\nIMPORT body\n");
    await indexCollection(store, "docs", STAGE, "**/*.md", { importMode: true });

    const row = rowOf("shared.md")!;
    expect(row.origin).toBe("fs");
    expect(row.active).toBe(1);
    // Content untouched: the stored body is still the filesystem one.
    const body = store.db.prepare(
      "SELECT c.doc FROM documents d JOIN content c ON c.hash = d.hash WHERE d.id = ?"
    ).get(row.id) as { doc: string };
    expect(body.doc).toContain("fs body");
    expect(body.doc).not.toContain("IMPORT body");
  });

  it("filesystem indexing never takes over an ACTIVE API-owned path", async () => {
    seedDbBorn("api-owned.md");                     // active 'api' row at a file-shaped path
    writeDoc("api-owned.md", "# F\n\nfile body\n"); // a real file appears at that path
    await reindex();

    expect(rowOf("api-owned.md")!.origin).toBe("api"); // not adopted, not flipped
    expect(rowOf("api-owned.md")!.active).toBe(1);
    const n = (store.db.prepare("SELECT COUNT(*) n FROM documents WHERE collection = 'docs' AND path = 'api-owned.md'")
      .get() as { n: number }).n;
    expect(n).toBe(1);                                 // no shadow second row
  });

  it("an INACTIVE API-owned row is neither reactivated nor shadowed by a colliding file", async () => {
    // Legacy-damage shape: an api row absence-deactivated by the pre-fix reconciler.
    seedDbBorn("api-inactive.md");
    store.deactivateDocument("docs", "api-inactive.md", "absent");
    writeDoc("api-inactive.md", "# F\n\nfile body\n");
    await reindex();

    const row = rowOf("api-inactive.md")!;
    expect(row.active).toBe(0);                        // not silently reactivated as fs
    expect(row.origin).toBe("api");
    const n = (store.db.prepare("SELECT COUNT(*) n FROM documents WHERE collection = 'docs' AND path = 'api-inactive.md'")
      .get() as { n: number }).n;
    expect(n).toBe(1);                                 // and no duplicate insert
  });
});
