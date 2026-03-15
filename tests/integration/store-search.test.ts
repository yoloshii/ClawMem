import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStore,
  insertContent,
  insertDocument,
  searchFTS,
  findDocument,
  type Store,
} from "../../src/store.ts";

let store: Store;

beforeEach(() => {
  store = createStore(":memory:");
});

function addDoc(path: string, title: string, body: string, hash?: string) {
  const h = hash || `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  insertContent(store.db, h, body, now);
  insertDocument(store.db, "test", path, title, h, now, now);
}

// ─── searchFTS ──────────────────────────────────────────────────────

describe("searchFTS", () => {
  it("finds document by title keyword", () => {
    addDoc("architecture.md", "System Architecture Guide", "Describes the system");
    const results = searchFTS(store.db, "architecture");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.title).toContain("Architecture");
  });

  it("finds document by body content", () => {
    addDoc("notes.md", "Notes", "The microservice uses gRPC for communication");
    const results = searchFTS(store.db, "gRPC communication");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for no matches", () => {
    addDoc("notes.md", "Notes", "Some content");
    const results = searchFTS(store.db, "xyznonexistent123");
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      addDoc(`doc${i}.md`, `Doc ${i}`, `Content about testing number ${i}`);
    }
    const results = searchFTS(store.db, "testing", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns score and source='fts'", () => {
    addDoc("file.md", "Test File", "Testing search functionality");
    const results = searchFTS(store.db, "testing");
    if (results.length > 0) {
      expect(results[0]!.source).toBe("fts");
      expect(typeof results[0]!.score).toBe("number");
    }
  });

  it("includes modifiedAt from documents table (not empty string)", () => {
    addDoc("dated.md", "Dated Doc", "Testing date propagation through FTS");
    const results = searchFTS(store.db, "date propagation");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // modifiedAt should be a valid ISO date string, not empty
    expect(results[0]!.modifiedAt).not.toBe("");
    expect(new Date(results[0]!.modifiedAt).getTime()).not.toBeNaN();
  });
});

// ─── findDocument ───────────────────────────────────────────────────

describe("findDocument", () => {
  it("finds by partial path", () => {
    addDoc("docs/guide.md", "Guide", "Some guide");
    const result = findDocument(store.db, "guide.md");
    expect("error" in result).toBe(false);
    expect((result as any).title).toBe("Guide");
  });

  it("returns not_found for missing doc", () => {
    const result = findDocument(store.db, "nonexistent.md");
    expect("error" in result).toBe(true);
    expect((result as any).error).toBe("not_found");
  });
});
