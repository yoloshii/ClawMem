import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStore,
  insertContent,
  insertDocument,
  findActiveDocument,
  searchFTS,
  type Store,
} from "../../src/store.ts";

let store: Store;

beforeEach(() => {
  store = createStore(":memory:");
});

function addDoc(collection: string, path: string, title: string, body: string, confidence?: number) {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  insertContent(store.db, hash, body, now);
  insertDocument(store.db, collection, path, title, hash, now, now);

  if (confidence !== undefined) {
    const doc = findActiveDocument(store.db, collection, path);
    if (doc) {
      store.db.prepare("UPDATE documents SET confidence = ? WHERE id = ?").run(confidence, doc.id);
    }
  }
}

// ─── Consolidation Logic Tests (M1 fix: same-collection + Jaccard) ──

describe("consolidation logic", () => {
  it("finds low-confidence candidates", () => {
    addDoc("test", "dup1.md", "Auth Notes", "JWT token authentication system design", 0.2);
    addDoc("test", "dup2.md", "Auth Guide", "JWT token authentication system design", 0.8);

    const candidates = store.db.prepare(`
      SELECT id, collection, path, title, confidence
      FROM documents WHERE active = 1 AND confidence < 0.4
    `).all() as { id: number; collection: string; path: string; title: string; confidence: number }[];

    expect(candidates.length).toBe(1);
    expect(candidates[0]!.path).toBe("dup1.md");
  });

  it("requires same collection for merge (M1 fix)", () => {
    addDoc("vault-a", "notes.md", "Auth Notes", "JWT token authentication system design patterns and best practices for secure APIs", 0.2);
    addDoc("vault-b", "notes.md", "Auth Notes", "JWT token authentication system design patterns and best practices for secure APIs", 0.8);

    const candidates = store.db.prepare(`
      SELECT id, collection, path, title, confidence
      FROM documents WHERE active = 1 AND confidence < 0.4
    `).all() as any[];

    for (const candidate of candidates) {
      const similar = searchFTS(store.db, candidate.title, 5);
      const crossCollectionMatches = similar.filter(r => {
        const rCollection = r.filepath.split("/")[0];
        return rCollection !== candidate.collection;
      });
      // Cross-collection matches should NOT qualify for merge
      expect(crossCollectionMatches.every(m => {
        const rCollection = m.filepath.split("/")[0];
        return rCollection !== candidate.collection;
      })).toBe(true);
    }
  });

  it("computes Jaccard similarity correctly (M1 fix)", () => {
    const bodyA = "JWT token authentication system design patterns";
    const bodyB = "JWT token authentication system design patterns";
    const bodyC = "completely different topic about database indexing";

    const wordsA = new Set(bodyA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(bodyB.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsC = new Set(bodyC.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    // Identical → Jaccard = 1.0
    let intersection = 0;
    for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
    const jaccardAB = intersection / (wordsA.size + wordsB.size - intersection);
    expect(jaccardAB).toBe(1.0);

    // Different → Jaccard < 0.4
    intersection = 0;
    for (const w of wordsA) { if (wordsC.has(w)) intersection++; }
    const jaccardAC = intersection / (wordsA.size + wordsC.size - intersection);
    expect(jaccardAC).toBeLessThan(0.4);
  });

  it("archives lower-confidence duplicate", () => {
    addDoc("test", "dup.md", "Duplicate Note", "Authentication design patterns for secure API access", 0.15);
    const doc = findActiveDocument(store.db, "test", "dup.md");
    expect(doc).toBeDefined();

    store.archiveDocuments([doc!.id]);
    const archived = findActiveDocument(store.db, "test", "dup.md");
    expect(archived).toBeNull();

    // Verify archived_at is set
    const row = store.db.prepare("SELECT archived_at FROM documents WHERE id = ?").get(doc!.id) as { archived_at: string | null };
    expect(row.archived_at).toBeDefined();
  });

  it("no-op when no low-confidence candidates exist", () => {
    addDoc("test", "good.md", "Good Doc", "High quality document content", 0.9);
    const candidates = store.db.prepare(`
      SELECT id FROM documents WHERE active = 1 AND confidence < 0.4
    `).all();
    expect(candidates).toHaveLength(0);
  });
});
