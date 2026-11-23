import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStore,
  insertContent,
  insertDocument,
  findActiveDocument,
  findAnyDocument,
  reactivateDocument,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
  handelize,
  normalizeVirtualPath,
  parseVirtualPath,
  buildVirtualPath,
  isVirtualPath,
  extractTitle,
  type Store,
} from "../../src/store.ts";

import { seedContent } from "../helpers/seed-content.ts";
import { normalizedContent } from "../../src/text-policy.ts";
let store: Store;

beforeEach(() => {
  store = createStore(":memory:");
});

// ─── Schema initialization ──────────────────────────────────────────

describe("createStore", () => {
  it("initializes all tables in :memory: database", () => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("documents");
    expect(names).toContain("content");
    expect(names).toContain("session_log");
    expect(names).toContain("co_activations");
    expect(names).toContain("memory_relations");
  });

  it("creates FTS virtual table", () => {
    const fts = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'")
      .all() as { name: string }[];
    expect(fts.length).toBeGreaterThan(0);
  });

  it("runs all migrations without error", () => {
    // If we got here, migrations ran successfully.
    // Verify a migration-added column exists (e.g., memory_type from E10)
    const cols = store.db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("quality_score");
    expect(colNames).toContain("pinned");
    expect(colNames).toContain("snoozed_until");
  });
});

// ─── Document CRUD ──────────────────────────────────────────────────

describe("document CRUD", () => {
  it("insertContent + insertDocument creates doc visible in findActiveDocument", () => {
    // 82.3 D7: this case is about the real writer, so it takes the body and its hash from `normalizedContent`.
    const { body, hash } = normalizedContent("body text");
    insertContent(store.db, hash, body, "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", hash, "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md");
    expect(doc).toBeDefined();
    expect(doc!.title).toBe("Title");
  });

  it("updateDocument changes hash and modifiedAt", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md")!;
    seedContent(store.db, "h2", "new body", "2026-03-02T00:00:00Z");
    updateDocument(store.db, doc.id, "New Title", "h2", "2026-03-02T00:00:00Z");
    const updated = findActiveDocument(store.db, "test", "file.md")!;
    expect(updated.hash).toBe("h2");
    expect(updated.title).toBe("New Title");
  });

  it("deactivateDocument sets active=0 and records why (S55.6 D9)", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    deactivateDocument(store.db, "test", "file.md", "forget");
    const doc = findActiveDocument(store.db, "test", "file.md");
    expect(doc).toBeNull();
    // The reason is not decoration: the indexer's reactivate branch keys on it, and a row
    // deactivated by forget must never be brought back by a later reconciliation.
    const row = store.db.prepare("SELECT deactivated_reason FROM documents WHERE collection = ? AND path = ?")
      .get("test", "file.md") as { deactivated_reason: string | null };
    expect(row.deactivated_reason).toBe("forget");
  });

  it("reactivateDocument re-enables inactive doc", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md")!;
    deactivateDocument(store.db, "test", "file.md", "absent");
    reactivateDocument(store.db, doc.id, "Title", "h1", "2026-03-01T00:00:00Z");
    const reactivated = findActiveDocument(store.db, "test", "file.md");
    expect(reactivated).toBeDefined();
    // Every successful active=1 writer clears the provenance, or a later absence would be
    // mistaken for a still-standing lifecycle decision.
    const row = store.db.prepare("SELECT deactivated_reason FROM documents WHERE id = ?")
      .get(doc.id) as { deactivated_reason: string | null };
    expect(row.deactivated_reason).toBeNull();
  });

  it("findAnyDocument returns inactive documents", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    deactivateDocument(store.db, "test", "file.md", "absent");
    const doc = findAnyDocument(store.db, "test", "file.md");
    expect(doc).toBeDefined();
  });

  it("getActiveDocumentPaths returns only active paths", () => {
    seedContent(store.db, "h1", "body1", "2026-03-01T00:00:00Z");
    seedContent(store.db, "h2", "body2", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "a.md", "A", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "b.md", "B", "h2", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    deactivateDocument(store.db, "test", "b.md", "absent");
    const paths = getActiveDocumentPaths(store.db, "test");
    expect(paths).toContain("a.md");
    expect(paths).not.toContain("b.md");
  });
});

// ─── Document metadata ──────────────────────────────────────────────

describe("document metadata", () => {
  it("updateDocumentMeta sets content_type, confidence, quality_score", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md")!;
    store.updateDocumentMeta(doc.id, {
      content_type: "decision",
      confidence: 0.9,
      quality_score: 0.8,
    });
    const row = store.db.prepare("SELECT content_type, confidence, quality_score FROM documents WHERE id = ?").get(doc.id) as any;
    expect(row.content_type).toBe("decision");
    expect(row.confidence).toBeCloseTo(0.9, 2);
    expect(row.quality_score).toBeCloseTo(0.8, 2);
  });

  it("incrementAccessCount increments for matching paths", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.incrementAccessCount(["test/file.md"]);
    const row = store.db.prepare(
      "SELECT access_count FROM documents WHERE collection = 'test' AND path = 'file.md'"
    ).get() as { access_count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.access_count).toBeGreaterThanOrEqual(1);
  });
});

// ─── Pin/snooze lifecycle ───────────────────────────────────────────

describe("pin/snooze lifecycle", () => {
  it("pinDocument sets pinned=1", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.pinDocument("test", "file.md", true);
    const row = store.db.prepare("SELECT pinned FROM documents WHERE collection = 'test' AND path = 'file.md'").get() as { pinned: number };
    expect(row.pinned).toBe(1);
  });

  it("pinDocument unpin sets pinned=0", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.pinDocument("test", "file.md", true);
    store.pinDocument("test", "file.md", false);
    const row = store.db.prepare("SELECT pinned FROM documents WHERE collection = 'test' AND path = 'file.md'").get() as { pinned: number };
    expect(row.pinned).toBe(0);
  });

  it("snoozeDocument sets snoozed_until date", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.snoozeDocument("test", "file.md", "2026-04-01");
    const row = store.db.prepare("SELECT snoozed_until FROM documents WHERE collection = 'test' AND path = 'file.md'").get() as { snoozed_until: string };
    expect(row.snoozed_until).toBe("2026-04-01");
  });

  it("snoozeDocument with null removes snooze", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.snoozeDocument("test", "file.md", "2026-04-01");
    store.snoozeDocument("test", "file.md", null);
    const row = store.db.prepare("SELECT snoozed_until FROM documents WHERE collection = 'test' AND path = 'file.md'").get() as { snoozed_until: string | null };
    expect(row.snoozed_until).toBeNull();
  });
});

// ─── Co-activation ──────────────────────────────────────────────────

describe("co-activation", () => {
  it("recordCoActivation creates pair entries (sorted order)", () => {
    store.recordCoActivation(["b.md", "a.md"]);
    const rows = store.db.prepare("SELECT doc_a, doc_b FROM co_activations").all() as { doc_a: string; doc_b: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.doc_a).toBe("a.md"); // sorted
    expect(rows[0]!.doc_b).toBe("b.md");
  });

  it("recordCoActivation increments count on repeat", () => {
    store.recordCoActivation(["a.md", "b.md"]);
    store.recordCoActivation(["a.md", "b.md"]);
    const row = store.db.prepare("SELECT count FROM co_activations WHERE doc_a = 'a.md' AND doc_b = 'b.md'").get() as { count: number };
    expect(row.count).toBe(2);
  });

  it("getCoActivated returns top co-activated paths", () => {
    store.recordCoActivation(["a.md", "b.md"]);
    store.recordCoActivation(["a.md", "c.md"]);
    store.recordCoActivation(["a.md", "b.md"]); // b gets count 2
    const results = store.getCoActivated("a.md", 5);
    expect(results.length).toBe(2);
    expect(results[0]!.path).toBe("b.md"); // highest count
    expect(results[0]!.count).toBe(2);
  });

  it("recordCoActivation is atomic — a later-pair failure rolls back the whole batch (BUILD-3d.4 transaction teeth)", () => {
    // recordCoActivation(["a","b","c"]) inserts sorted pairs in order:
    // (a,b), (a,c), (b,c). A trigger that aborts the LAST pair (b,c) proves the
    // batching: under the single-transaction fix the whole call rolls back to 0
    // rows; the pre-fix per-pair autocommit would have committed (a,b)+(a,c)
    // before the abort. This is what the row/count tests above cannot see.
    store.db.exec(`
      CREATE TRIGGER coact_abort_bc BEFORE INSERT ON co_activations
      WHEN NEW.doc_a = 'b.md' AND NEW.doc_b = 'c.md'
      BEGIN SELECT RAISE(ABORT, 'test-injected co_activations failure'); END
    `);
    try {
      expect(() => store.recordCoActivation(["a.md", "b.md", "c.md"])).toThrow();
      const remaining = store.db.prepare("SELECT COUNT(*) AS n FROM co_activations").get() as { n: number };
      expect(remaining.n).toBe(0); // whole transaction rolled back — no committed prefix
    } finally {
      store.db.exec("DROP TRIGGER IF EXISTS coact_abort_bc");
    }
  });

  it("handles multi-path co-activation (3 paths → 3 pairs)", () => {
    store.recordCoActivation(["a.md", "b.md", "c.md"]);
    const count = store.db.prepare("SELECT COUNT(*) as cnt FROM co_activations").get() as { cnt: number };
    expect(count.cnt).toBe(3); // a-b, a-c, b-c
  });
});

// ─── Lifecycle management ───────────────────────────────────────────

describe("lifecycle management", () => {
  it("archiveDocuments sets archived_at and active=0", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md")!;
    store.archiveDocuments([doc.id]);
    const row = store.db.prepare("SELECT active, archived_at FROM documents WHERE id = ?").get(doc.id) as { active: number; archived_at: string | null };
    expect(row.active).toBe(0);
    expect(row.archived_at).toBeDefined();
  });

  it("getLifecycleStats returns correct counts", () => {
    seedContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const stats = store.getLifecycleStats();
    expect(stats).toBeDefined();
    expect(typeof stats.active).toBe("number");
  });

  it("getLifecycleStats: forgotten counts only forget; deactivation_reasons partitions every inactive row", () => {
    const at = "2026-03-01T00:00:00Z";
    const seed = (path: string, active: number, reason: string | null, archivedAt: string | null) => {
      seedContent(store.db, `h-${path}`, `body of ${path}`, at);
      insertDocument(store.db, "test", path, path, `h-${path}`, at, at);
      store.db.prepare(`UPDATE documents SET active = ?, deactivated_reason = ?, archived_at = ? WHERE collection = 'test' AND path = ?`)
        .run(active, reason, archivedAt, path);
    };
    seed("active.md", 1, null, null);
    seed("absent.md", 0, "absent", null);
    seed("forgot.md", 0, "forget", null);
    seed("arch.md", 0, "archive", at);
    seed("arch-legacy.md", 0, null, at);                 // no recorded reason, archived_at set → archive
    seed("legacy.md", 0, null, null);                    // no recorded reason, no archived_at → unknown_legacy
    seed("custom.md", 0, "some-other-reason", null);     // unrecognised reason, no archived_at → unknown_legacy

    const stats = store.getLifecycleStats();
    expect(stats.active).toBe(1);
    expect(stats.archived).toBe(2);
    expect(stats.forgotten).toBe(1);                     // the old count (inactive without archived_at) was 4
    expect(stats.deactivation_reasons).toEqual({ absent: 1, forget: 1, archive: 2, unknown_legacy: 2 });
    const r = stats.deactivation_reasons;
    const inactive = (store.db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE active = 0`).get() as { n: number }).n;
    expect(r.absent + r.forget + r.archive + r.unknown_legacy).toBe(inactive);   // exhaustive and disjoint
  });
});

// ─── Virtual paths ──────────────────────────────────────────────────

describe("virtual paths", () => {
  it("parseVirtualPath extracts collection and path from clawmem:// prefix", () => {
    const vp = parseVirtualPath("clawmem://test/docs/file.md");
    expect(vp).toBeDefined();
    expect(vp!.collectionName).toBe("test");
    expect(vp!.path).toBe("docs/file.md");
  });

  it("parseVirtualPath extracts from // prefix", () => {
    const vp = parseVirtualPath("//test/docs/file.md");
    expect(vp).toBeDefined();
    expect(vp!.collectionName).toBe("test");
    expect(vp!.path).toBe("docs/file.md");
  });

  it("normalizeVirtualPath fixes extra slashes", () => {
    expect(normalizeVirtualPath("clawmem:////test//docs///file.md")).toBe("clawmem://test/docs/file.md");
  });

  it("normalizeVirtualPath is idempotent on clean paths", () => {
    expect(normalizeVirtualPath("clawmem://test/file.md")).toBe("clawmem://test/file.md");
  });

  it("normalizeVirtualPath handles // prefix", () => {
    expect(normalizeVirtualPath("//test/docs/file.md")).toBe("clawmem://test/docs/file.md");
  });

  it("isVirtualPath returns true for clawmem:// prefix", () => {
    expect(isVirtualPath("clawmem://test/file.md")).toBe(true);
    expect(isVirtualPath("/home/user/file.md")).toBe(false);
  });

  it("buildVirtualPath constructs correct format", () => {
    expect(buildVirtualPath("test", "docs/file.md")).toBe("clawmem://test/docs/file.md");
  });
});

// ─── handelize ──────────────────────────────────────────────────────

describe("handelize", () => {
  it("converts triple underscore to slash", () => {
    const result = handelize("docs___file.md");
    expect(result).toContain("/");
  });

  it("lowercases and replaces special chars", () => {
    const result = handelize("My File (v2).md");
    expect(result).toBe(result.toLowerCase());
    expect(result).not.toContain("(");
  });

  it("handles simple paths", () => {
    const result = handelize("simple-file.md");
    expect(result).toBe("simple-file.md");
  });
});

// ─── extractTitle (store version) ───────────────────────────────────

describe("extractTitle (store)", () => {
  it("extracts heading", () => {
    expect(extractTitle("# Hello\nWorld", "file.md")).toBe("Hello");
  });

  it("falls back to filename", () => {
    expect(extractTitle("no heading", "notes.md")).toBe("notes");
  });
});
