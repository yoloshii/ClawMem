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
    insertContent(store.db, "h1", "body text", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md");
    expect(doc).toBeDefined();
    expect(doc!.title).toBe("Title");
  });

  it("updateDocument changes hash and modifiedAt", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md")!;
    insertContent(store.db, "h2", "new body", "2026-03-02T00:00:00Z");
    updateDocument(store.db, doc.id, "New Title", "h2", "2026-03-02T00:00:00Z");
    const updated = findActiveDocument(store.db, "test", "file.md")!;
    expect(updated.hash).toBe("h2");
    expect(updated.title).toBe("New Title");
  });

  it("deactivateDocument sets active=0", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    deactivateDocument(store.db, "test", "file.md");
    const doc = findActiveDocument(store.db, "test", "file.md");
    expect(doc).toBeNull();
  });

  it("reactivateDocument re-enables inactive doc", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md")!;
    deactivateDocument(store.db, "test", "file.md");
    reactivateDocument(store.db, doc.id, "Title", "h1", "2026-03-01T00:00:00Z");
    const reactivated = findActiveDocument(store.db, "test", "file.md");
    expect(reactivated).toBeDefined();
  });

  it("findAnyDocument returns inactive documents", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    deactivateDocument(store.db, "test", "file.md");
    const doc = findAnyDocument(store.db, "test", "file.md");
    expect(doc).toBeDefined();
  });

  it("getActiveDocumentPaths returns only active paths", () => {
    insertContent(store.db, "h1", "body1", "2026-03-01T00:00:00Z");
    insertContent(store.db, "h2", "body2", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "a.md", "A", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "b.md", "B", "h2", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    deactivateDocument(store.db, "test", "b.md");
    const paths = getActiveDocumentPaths(store.db, "test");
    expect(paths).toContain("a.md");
    expect(paths).not.toContain("b.md");
  });
});

// ─── Document metadata ──────────────────────────────────────────────

describe("document metadata", () => {
  it("updateDocumentMeta sets content_type, confidence, quality_score", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
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
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
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
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.pinDocument("test", "file.md", true);
    const row = store.db.prepare("SELECT pinned FROM documents WHERE collection = 'test' AND path = 'file.md'").get() as { pinned: number };
    expect(row.pinned).toBe(1);
  });

  it("pinDocument unpin sets pinned=0", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.pinDocument("test", "file.md", true);
    store.pinDocument("test", "file.md", false);
    const row = store.db.prepare("SELECT pinned FROM documents WHERE collection = 'test' AND path = 'file.md'").get() as { pinned: number };
    expect(row.pinned).toBe(0);
  });

  it("snoozeDocument sets snoozed_until date", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    store.snoozeDocument("test", "file.md", "2026-04-01");
    const row = store.db.prepare("SELECT snoozed_until FROM documents WHERE collection = 'test' AND path = 'file.md'").get() as { snoozed_until: string };
    expect(row.snoozed_until).toBe("2026-04-01");
  });

  it("snoozeDocument with null removes snooze", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
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

  it("handles multi-path co-activation (3 paths → 3 pairs)", () => {
    store.recordCoActivation(["a.md", "b.md", "c.md"]);
    const count = store.db.prepare("SELECT COUNT(*) as cnt FROM co_activations").get() as { cnt: number };
    expect(count.cnt).toBe(3); // a-b, a-c, b-c
  });
});

// ─── Lifecycle management ───────────────────────────────────────────

describe("lifecycle management", () => {
  it("archiveDocuments sets archived_at and active=0", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const doc = findActiveDocument(store.db, "test", "file.md")!;
    store.archiveDocuments([doc.id]);
    const row = store.db.prepare("SELECT active, archived_at FROM documents WHERE id = ?").get(doc.id) as { active: number; archived_at: string | null };
    expect(row.active).toBe(0);
    expect(row.archived_at).toBeDefined();
  });

  it("getLifecycleStats returns correct counts", () => {
    insertContent(store.db, "h1", "body", "2026-03-01T00:00:00Z");
    insertDocument(store.db, "test", "file.md", "Title", "h1", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const stats = store.getLifecycleStats();
    expect(stats).toBeDefined();
    expect(typeof stats.active).toBe("number");
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
