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

// ─── searchFTS tokenization (compound / path / apostrophe / 1-char) ──
//
// Bug-first: the index tokenizer (unicode61) splits on _ - . / ' and all
// punctuation, but the query builder USED to strip those separators, which
// concatenated word-parts into tokens that were never indexed (e.g.
// "before_compaction" -> "beforecompaction" -> 0 rows). These assert the
// CORRECT behavior: the query tokenizer mirrors the index by splitting on the
// same boundaries (AND-of-prefixes). Cases (a)(b)(d) fail on the pre-fix code.

describe("searchFTS tokenization", () => {
  it("matches snake_case compound in body (before_compaction)", () => {
    addDoc("hooks.md", "Hooks", "The before_compaction hook is fire-and-forget.");
    const results = searchFTS(store.db, "before_compaction");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("matches compound via AND semantics when parts are non-adjacent", () => {
    addDoc("split.md", "Split", "compaction happens long before the snapshot");
    const results = searchFTS(store.db, "before_compaction");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("matches slash path via the filepath column (src/store.ts)", () => {
    // body deliberately omits the path tokens — the match must come from filepath
    addDoc("src/store.ts", "Module", "documentation goes here");
    const results = searchFTS(store.db, "src/store.ts");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("matches model-id compound with 1-char tokens (q4_k_m)", () => {
    addDoc("models.md", "Models", "the qmd-query-expansion-1.7B-q4_k_m model file");
    const results = searchFTS(store.db, "q4_k_m");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("matches dotted version with 1-char tokens (v0.8.2)", () => {
    addDoc("changelog.md", "Changelog", "released in v0.8.2 with the heavy lane");
    const results = searchFTS(store.db, "v0.8.2");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("still matches apostrophe contraction after the change (don't)", () => {
    addDoc("style.md", "Style", "don't repeat yourself in code");
    const results = searchFTS(store.db, "don't");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("does not throw on FTS5 special characters in the query", () => {
    addDoc("notes.md", "Notes", "some content about parsers and tokens");
    expect(() => searchFTS(store.db, 'content AND "parsers" OR (x)* ^bad:')).not.toThrow();
  });

  it("returns empty (no throw) for a punctuation-only query", () => {
    addDoc("notes.md", "Notes", "some content");
    expect(searchFTS(store.db, "!@#$%^&*()")).toHaveLength(0);
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
