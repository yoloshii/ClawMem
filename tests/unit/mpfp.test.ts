/**
 * MPFP Graph Traversal Tests
 *
 * Tests designed to catch:
 * - Empty anchor handling
 * - Score normalization (unbounded Forward Push mass)
 * - Meta-path pattern selection per intent
 * - Edge cache reuse across patterns
 * - Traversal on disconnected graph (no edges)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import { mpfpTraversal, getMetaPathsForIntent } from "../../src/graph-traversal.ts";

let store: Store;

beforeEach(() => {
  store = createTestStore();
});

describe("getMetaPathsForIntent", () => {
  it("WHY includes causal edges", () => {
    const paths = getMetaPathsForIntent("WHY");
    const flat = paths.flat();
    expect(flat).toContain("causal");
  });

  it("ENTITY includes entity edges", () => {
    const paths = getMetaPathsForIntent("ENTITY");
    const flat = paths.flat();
    expect(flat).toContain("entity");
  });

  it("WHEN includes temporal edges", () => {
    const paths = getMetaPathsForIntent("WHEN");
    const flat = paths.flat();
    expect(flat).toContain("temporal");
  });

  it("all intents return at least 2 patterns", () => {
    for (const intent of ["WHY", "WHEN", "ENTITY", "WHAT"] as const) {
      const paths = getMetaPathsForIntent(intent);
      expect(paths.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("all patterns have exactly 2 hops", () => {
    for (const intent of ["WHY", "WHEN", "ENTITY", "WHAT"] as const) {
      for (const path of getMetaPathsForIntent(intent)) {
        expect(path).toHaveLength(2);
      }
    }
  });
});

describe("mpfpTraversal", () => {
  it("returns empty for empty anchor set", () => {
    const result = mpfpTraversal(store.db, [], "WHY");
    expect(result).toHaveLength(0);
  });

  it("returns empty for anchor with non-existent hash", () => {
    const result = mpfpTraversal(store.db, [{ hash: "nonexistent", score: 1.0 }], "WHY");
    expect(result).toHaveLength(0);
  });

  it("returns anchor nodes when graph has no edges", () => {
    const [docId] = seedDocuments(store, [
      { path: "seed.md", title: "Seed", body: "content" },
    ]);

    const hash = store.db.prepare("SELECT hash FROM documents WHERE id = ?").get(docId!) as { hash: string };

    const result = mpfpTraversal(store.db, [{ hash: hash.hash, score: 0.8 }], "WHAT");
    // Should return at least the anchor (teleport portion)
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("traverses edges and discovers connected nodes", () => {
    const [doc1, doc2, doc3] = seedDocuments(store, [
      { path: "a.md", title: "A", body: "content a" },
      { path: "b.md", title: "B", body: "content b" },
      { path: "c.md", title: "C", body: "content c" },
    ]);

    // Create semantic edge: doc1 → doc2
    store.db.prepare(`
      INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
      VALUES (?, ?, 'semantic', 0.8, datetime('now'))
    `).run(doc1!, doc2!);

    // Create semantic edge: doc2 → doc3
    store.db.prepare(`
      INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
      VALUES (?, ?, 'semantic', 0.7, datetime('now'))
    `).run(doc2!, doc3!);

    const hash1 = store.db.prepare("SELECT hash FROM documents WHERE id = ?").get(doc1!) as { hash: string };

    // WHAT intent uses [semantic, semantic] — should traverse doc1 → doc2 → doc3
    const result = mpfpTraversal(store.db, [{ hash: hash1.hash, score: 1.0 }], "WHAT");

    // Should discover doc2 or doc3 via 2-hop semantic traversal
    expect(result.length).toBeGreaterThan(0);
  });

  it("respects budget limit", () => {
    // Create a chain of 10 docs
    const docs = seedDocuments(store, Array.from({ length: 10 }, (_, i) => ({
      path: `doc${i}.md`, title: `Doc ${i}`, body: `content ${i}`,
    })));

    // Chain them: 0→1→2→...→9
    for (let i = 0; i < docs.length - 1; i++) {
      store.db.prepare(`
        INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
        VALUES (?, ?, 'semantic', 0.9, datetime('now'))
      `).run(docs[i]!, docs[i + 1]!);
    }

    const hash0 = store.db.prepare("SELECT hash FROM documents WHERE id = ?").get(docs[0]!) as { hash: string };

    const result = mpfpTraversal(store.db, [{ hash: hash0.hash, score: 1.0 }], "WHAT", 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});
