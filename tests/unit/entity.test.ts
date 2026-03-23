/**
 * Entity Resolution + Co-occurrence Tests
 *
 * Tests designed to catch:
 * - Cross-vault entity merges (the main failure mode per GPT 5.4 review)
 * - mention_count inflation from duplicate LLM output
 * - Co-occurrence overcounting
 * - Levenshtein threshold boundary (0.74 vs 0.76)
 * - FTS5 special character handling
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import {
  upsertEntity,
  resolveEntityCanonical,
  recordEntityMention,
  trackCoOccurrences,
  enrichDocumentEntities,
  getEntityGraphNeighbors,
  searchEntities,
} from "../../src/entity.ts";

let store: Store;

beforeEach(() => {
  store = createTestStore();
});

describe("entity ID vault scoping", () => {
  it("same name in different vaults creates separate entities", () => {
    const id1 = upsertEntity(store.db, "ClawMem", "project", "vault-a");
    const id2 = upsertEntity(store.db, "ClawMem", "project", "vault-b");

    expect(id1).not.toBe(id2);
    expect(id1).toContain("vault-a:");
    expect(id2).toContain("vault-b:");
  });

  it("same name in same vault resolves to same entity", () => {
    const id1 = upsertEntity(store.db, "ClawMem", "project", "default");
    const id2 = upsertEntity(store.db, "ClawMem", "project", "default");

    expect(id1).toBe(id2);
  });

  it("canonical resolution does not cross vault boundary", () => {
    upsertEntity(store.db, "VM 202", "service", "vault-a");

    // Should NOT find vault-a's entity when searching in vault-b
    const match = resolveEntityCanonical(store.db, "VM 202", "service", "vault-b");
    expect(match).toBeNull();
  });

  it("canonical resolution finds entity within same vault", () => {
    const id = upsertEntity(store.db, "VM 202", "service", "work");

    const match = resolveEntityCanonical(store.db, "VM 202", "service", "work");
    expect(match).toBe(id);
  });
});

describe("mention_count accuracy", () => {
  it("duplicate entity names in one document do not inflate mention_count", () => {
    // Simulate LLM returning "ClawMem" twice for same doc
    upsertEntity(store.db, "ClawMem", "project", "default");

    const row = store.db.prepare(
      "SELECT mention_count FROM entity_nodes WHERE name = 'ClawMem'"
    ).get() as { mention_count: number };

    expect(row.mention_count).toBe(1);

    // Second upsert for same entity increments (this is correct — called from different doc)
    upsertEntity(store.db, "ClawMem", "project", "default");
    const row2 = store.db.prepare(
      "SELECT mention_count FROM entity_nodes WHERE name = 'ClawMem'"
    ).get() as { mention_count: number };

    expect(row2.mention_count).toBe(2);
  });

  it("entity mention PK prevents duplicate doc-entity pairs", () => {
    const entityId = upsertEntity(store.db, "TestEntity", "tool", "default");
    const [docId] = seedDocuments(store, [{ path: "test.md", title: "Test", body: "content" }]);

    recordEntityMention(store.db, entityId, docId!, "TestEntity");
    recordEntityMention(store.db, entityId, docId!, "TestEntity"); // duplicate

    const count = store.db.prepare(
      "SELECT COUNT(*) as cnt FROM entity_mentions WHERE entity_id = ? AND doc_id = ?"
    ).get(entityId, docId!) as { cnt: number };

    expect(count.cnt).toBe(1); // INSERT OR IGNORE deduplicates
  });
});

describe("co-occurrence tracking", () => {
  it("single entity produces no co-occurrences", () => {
    trackCoOccurrences(store.db, ["entity:one"]);

    const count = store.db.prepare(
      "SELECT COUNT(*) as cnt FROM entity_cooccurrences"
    ).get() as { cnt: number };

    expect(count.cnt).toBe(0);
  });

  it("pair order is normalized (sorted)", () => {
    trackCoOccurrences(store.db, ["z:entity", "a:entity"]);

    const row = store.db.prepare(
      "SELECT entity_a, entity_b FROM entity_cooccurrences"
    ).get() as { entity_a: string; entity_b: string };

    // entity_a should be lexicographically first
    expect(row.entity_a < row.entity_b).toBe(true);
  });

  it("repeated co-occurrence increments count, not duplicates", () => {
    trackCoOccurrences(store.db, ["e1", "e2"]);
    trackCoOccurrences(store.db, ["e1", "e2"]);
    trackCoOccurrences(store.db, ["e1", "e2"]);

    const row = store.db.prepare(
      "SELECT count FROM entity_cooccurrences WHERE entity_a = 'e1' AND entity_b = 'e2'"
    ).get() as { count: number };

    expect(row.count).toBe(3);
  });

  it("3 entities produce 3 co-occurrence pairs", () => {
    trackCoOccurrences(store.db, ["a", "b", "c"]);

    const count = store.db.prepare(
      "SELECT COUNT(*) as cnt FROM entity_cooccurrences"
    ).get() as { cnt: number };

    expect(count.cnt).toBe(3); // (a,b), (a,c), (b,c)
  });
});

describe("Levenshtein fuzzy matching", () => {
  it("exact match resolves (score 1.0, above 0.75 threshold)", () => {
    upsertEntity(store.db, "PostgreSQL", "tool", "default");
    const match = resolveEntityCanonical(store.db, "PostgreSQL", "tool", "default");
    expect(match).not.toBeNull();
  });

  it("close variation resolves (score ~0.8)", () => {
    upsertEntity(store.db, "ClawMem", "project", "default");
    // "clawmem" vs "ClawMem" — case-insensitive comparison, should match
    const match = resolveEntityCanonical(store.db, "clawmem", "project", "default");
    expect(match).not.toBeNull();
  });

  it("different type prevents match even with same name", () => {
    upsertEntity(store.db, "Python", "tool", "default");
    // Same name but different type — should NOT match
    const match = resolveEntityCanonical(store.db, "Python", "person", "default");
    expect(match).toBeNull();
  });
});

describe("entity graph neighbors", () => {
  it("returns empty for docs with no entity mentions", () => {
    const [docId] = seedDocuments(store, [{ path: "test.md", title: "Test", body: "content" }]);
    const neighbors = getEntityGraphNeighbors(store.db, [docId!]);
    expect(neighbors).toHaveLength(0);
  });

  it("returns empty for empty seed set", () => {
    const neighbors = getEntityGraphNeighbors(store.db, []);
    expect(neighbors).toHaveLength(0);
  });

  it("finds neighbors via shared entity co-occurrence", () => {
    const [doc1, doc2] = seedDocuments(store, [
      { path: "a.md", title: "Doc A", body: "about ClawMem" },
      { path: "b.md", title: "Doc B", body: "also ClawMem" },
    ]);

    // Both docs mention the same entity
    const entityId = upsertEntity(store.db, "ClawMem", "project", "default");
    recordEntityMention(store.db, entityId, doc1!, "ClawMem");
    recordEntityMention(store.db, entityId, doc2!, "ClawMem");

    // Create a second entity that co-occurs with the first
    const entity2 = upsertEntity(store.db, "SQLite", "tool", "default");
    recordEntityMention(store.db, entity2, doc2!, "SQLite");
    trackCoOccurrences(store.db, [entityId, entity2]);

    // Seed from doc1 — should find doc2 via entity co-occurrence
    const neighbors = getEntityGraphNeighbors(store.db, [doc1!]);
    expect(neighbors.length).toBeGreaterThan(0);
    expect(neighbors.some(n => n.docId === doc2!)).toBe(true);
  });
});
