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
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";
import {
  upsertEntity,
  resolveEntityCanonical,
  recordEntityMention,
  trackCoOccurrences,
  enrichDocumentEntities,
  getEntityGraphNeighbors,
  searchEntities,
  extractEntities,
  entityCapForContentType,
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

describe("entity FTS prefix starvation", () => {
  // Bug-first (codex IMPL T2): the entities_fts query builder prefixed every
  // token (`"${t}"*`). A short/punctuation name like "C++" tokenizes to the
  // 1-char token "c", so the query "c"* prefix-matched every entity whose name
  // begins with c. Because the SQL LIMIT is applied BEFORE Levenshtein ranking,
  // the exact "C++" row was starved out of the candidate pool. Fix: do not
  // prefix 1-char tokens (multi-char prefix recall is retained).
  it("resolveEntityCanonical finds C++ despite many same-prefix entities", () => {
    for (let i = 0; i < 30; i++) upsertEntity(store.db, `Cache${i}`, "tool", "default");
    const cppId = upsertEntity(store.db, "C++", "tool", "default");
    const match = resolveEntityCanonical(store.db, "C++", "tool", "default");
    expect(match).toBe(cppId);
  });

  it("searchEntities surfaces C++, not same-prefix noise", () => {
    // Cache* get a higher mention_count so they out-rank C++ in the
    // ORDER BY mention_count DESC LIMIT — a too-broad prefix would starve C++.
    for (let i = 0; i < 30; i++) {
      upsertEntity(store.db, `Cache${i}`, "tool", "default");
      upsertEntity(store.db, `Cache${i}`, "tool", "default");
    }
    upsertEntity(store.db, "C++", "tool", "default");
    const results = searchEntities(store.db, "C++", 5);
    expect(results.some(r => r.name === "C++")).toBe(true);
  });

  // The 1-char rule alone was insufficient (codex IMPL T3): the same starvation
  // hits short MULTI-char exact names. "Go" -> "go"* matches every "Golang*", so
  // exact "Go" is starved from the LIMIT-20 pool. The exact-first lookup fixes it.
  it("resolveEntityCanonical finds the short multi-char name Go despite same-prefix entities", () => {
    for (let i = 0; i < 30; i++) upsertEntity(store.db, `Golang${i}`, "tool", "default");
    const goId = upsertEntity(store.db, "Go", "tool", "default");
    const match = resolveEntityCanonical(store.db, "Go", "tool", "default");
    expect(match).toBe(goId);
  });

  it("searchEntities surfaces Go, not same-prefix Golang noise", () => {
    for (let i = 0; i < 30; i++) {
      upsertEntity(store.db, `Golang${i}`, "tool", "default");
      upsertEntity(store.db, `Golang${i}`, "tool", "default");
    }
    upsertEntity(store.db, "Go", "tool", "default");
    const results = searchEntities(store.db, "Go", 5);
    expect(results.some(r => r.name === "Go")).toBe(true);
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

  // BL-001 — the neighbor ordering must not reintroduce the hub bias that the
  // edge-creation path's IDF suppression exists to prevent: a ubiquitous hub
  // entity with a high raw co-occurrence count must NOT outrank a specific,
  // low-frequency neighbor.
  it("ranks a specific low-frequency neighbor above a ubiquitous hub (BL-001)", () => {
    // 15 active docs total: 1 seed + 12 hub-mention docs + 2 specific-mention docs.
    const [seedDoc] = seedDocuments(store, [
      { path: "seed.md", title: "Seed", body: "seed doc" },
    ]);
    const hubDocs = seedDocuments(
      store,
      Array.from({ length: 12 }, (_, i) => ({
        path: `hub-${i}.md`,
        title: `Hub ${i}`,
        body: "hub-heavy doc",
      }))
    );
    const specificDocs = seedDocuments(store, [
      { path: "rare-1.md", title: "Rare 1", body: "specific doc" },
      { path: "rare-2.md", title: "Rare 2", body: "specific doc" },
    ]);

    const seedEntity = upsertEntity(store.db, "SeedTopic", "project", "default");
    recordEntityMention(store.db, seedEntity, seedDoc!, "SeedTopic");

    // Hub: mentioned in 12 of 15 docs (low IDF), co-occurs with seed 10 times.
    const hubEntity = upsertEntity(store.db, "HubEverywhere", "tool", "default");
    for (const d of hubDocs) recordEntityMention(store.db, hubEntity, d, "HubEverywhere");
    for (let i = 0; i < 10; i++) trackCoOccurrences(store.db, [seedEntity, hubEntity]);

    // Specific: mentioned in 2 of 15 docs (high IDF), co-occurs with seed twice.
    const specificEntity = upsertEntity(store.db, "RareGem", "tool", "default");
    for (const d of specificDocs) recordEntityMention(store.db, specificEntity, d, "RareGem");
    for (let i = 0; i < 2; i++) trackCoOccurrences(store.db, [seedEntity, specificEntity]);

    const neighbors = getEntityGraphNeighbors(store.db, [seedDoc!]);

    // Both entity families must be represented…
    expect(neighbors.some(n => n.viaEntity === specificEntity)).toBe(true);
    expect(neighbors.some(n => n.viaEntity === hubEntity)).toBe(true);
    // …but the specific neighbor outranks the hub despite the 10-vs-2 raw count.
    expect(neighbors[0]!.viaEntity).toBe(specificEntity);
    const firstHubIdx = neighbors.findIndex(n => n.viaEntity === hubEntity);
    const firstSpecificIdx = neighbors.findIndex(n => n.viaEntity === specificEntity);
    expect(firstSpecificIdx).toBeLessThan(firstHubIdx);
  });

  // BL-001 turn-2 regression: archived mentions must not suppress current
  // specificity or push scores negative — IDF populations are active-only.
  it("archived mentions do not suppress specificity into negative scores (BL-001)", () => {
    const [seedDoc, activeDoc] = seedDocuments(store, [
      { path: "seed.md", title: "Seed", body: "seed doc" },
      { path: "active-rare.md", title: "Active Rare", body: "current doc" },
    ]);
    const archivedDocs = seedDocuments(
      store,
      Array.from({ length: 9 }, (_, i) => ({
        path: `old-${i}.md`,
        title: `Old ${i}`,
        body: "historical doc",
      }))
    );

    const seedEntity = upsertEntity(store.db, "SeedTopic", "project", "default");
    recordEntityMention(store.db, seedEntity, seedDoc!, "SeedTopic");

    // Entity mentioned in 10 docs — but 9 are archived. Active docFreq = 1.
    const entity = upsertEntity(store.db, "OnceCommon", "tool", "default");
    recordEntityMention(store.db, entity, activeDoc!, "OnceCommon");
    for (const d of archivedDocs) recordEntityMention(store.db, entity, d, "OnceCommon");
    const archiveStmt = store.db.prepare("UPDATE documents SET active = 0 WHERE id = ?");
    for (const d of archivedDocs) archiveStmt.run(d);

    trackCoOccurrences(store.db, [seedEntity, entity]);
    trackCoOccurrences(store.db, [seedEntity, entity]);

    const neighbors = getEntityGraphNeighbors(store.db, [seedDoc!]);
    const activeEntry = neighbors.find(n => n.docId === activeDoc!);
    // With all-mentions docFreq (10) vs active totalDocs (2+seed), IDF went
    // negative and this score was negative. Active-only docFreq = 1 keeps it
    // positive.
    expect(activeEntry).toBeDefined();
    expect(activeEntry!.score).toBeGreaterThan(0);
  });

  // BL-001 turn-2 regression: the candidate pool must be scored BEFORE any
  // limit — a specific neighbor ranked below 30 hubs on raw count must still
  // surface (the old SQL `ORDER BY count DESC LIMIT 30` excluded it).
  it("a specific neighbor beyond raw-count rank 30 still surfaces and wins (BL-001)", () => {
    const [seedDoc] = seedDocuments(store, [
      { path: "seed.md", title: "Seed", body: "seed doc" },
    ]);
    const hubDocs = seedDocuments(
      store,
      Array.from({ length: 12 }, (_, i) => ({
        path: `hub-${i}.md`,
        title: `Hub ${i}`,
        body: "hub-heavy doc",
      }))
    );
    const specificDocs = seedDocuments(store, [
      { path: "rare-1.md", title: "Rare 1", body: "specific doc" },
      { path: "rare-2.md", title: "Rare 2", body: "specific doc" },
    ]);

    const seedEntity = upsertEntity(store.db, "SeedTopic", "project", "default");
    recordEntityMention(store.db, seedEntity, seedDoc!, "SeedTopic");

    // 31 hub entities, each mentioned in all 12 hub docs (low IDF) and each
    // co-occurring with the seed at count 10 (fixture shortcut: direct insert
    // with the canonical sorted pair, matching trackCoOccurrences key order).
    const coocStmt = store.db.prepare(
      "INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES (?, ?, ?, datetime('now'))"
    );
    for (let h = 0; h < 31; h++) {
      const hubId = upsertEntity(store.db, `Hub${h}Everywhere`, "tool", "default");
      for (const d of hubDocs) recordEntityMention(store.db, hubId, d, `Hub${h}Everywhere`);
      const pair = [seedEntity, hubId].sort();
      coocStmt.run(pair[0]!, pair[1]!, 10);
    }

    // The specific entity: 2 docs, co-occurrence count 2 — raw rank 32nd.
    const specificEntity = upsertEntity(store.db, "RareGem", "tool", "default");
    for (const d of specificDocs) recordEntityMention(store.db, specificEntity, d, "RareGem");
    const pair = [seedEntity, specificEntity].sort();
    coocStmt.run(pair[0]!, pair[1]!, 2);

    const neighbors = getEntityGraphNeighbors(store.db, [seedDoc!], 50);
    expect(neighbors.some(n => n.viaEntity === specificEntity)).toBe(true);
    expect(neighbors[0]!.viaEntity).toBe(specificEntity);
  });

  // BL-001 turn-2 regression: a document reachable via BOTH a hub and a
  // specific entity must keep the specific (best) path's score and viaEntity,
  // not the first-traversed hub path.
  it("a doc reachable via hub AND specific entity keeps the specific path (BL-001)", () => {
    const [seedDoc, sharedDoc] = seedDocuments(store, [
      { path: "seed.md", title: "Seed", body: "seed doc" },
      { path: "shared.md", title: "Shared", body: "reachable both ways" },
    ]);
    const hubDocs = seedDocuments(
      store,
      Array.from({ length: 11 }, (_, i) => ({
        path: `hub-${i}.md`,
        title: `Hub ${i}`,
        body: "hub-heavy doc",
      }))
    );
    const [rareDoc] = seedDocuments(store, [
      { path: "rare-1.md", title: "Rare 1", body: "specific doc" },
    ]);

    const seedEntity = upsertEntity(store.db, "SeedTopic", "project", "default");
    recordEntityMention(store.db, seedEntity, seedDoc!, "SeedTopic");

    // Hub: 12 docs (11 hub docs + the shared doc), count 10 with seed.
    const hubEntity = upsertEntity(store.db, "HubEverywhere", "tool", "default");
    for (const d of hubDocs) recordEntityMention(store.db, hubEntity, d, "HubEverywhere");
    recordEntityMention(store.db, hubEntity, sharedDoc!, "HubEverywhere");
    for (let i = 0; i < 10; i++) trackCoOccurrences(store.db, [seedEntity, hubEntity]);

    // Specific: 2 docs (rare doc + the shared doc), count 2 with seed.
    const specificEntity = upsertEntity(store.db, "RareGem", "tool", "default");
    recordEntityMention(store.db, specificEntity, rareDoc!, "RareGem");
    recordEntityMention(store.db, specificEntity, sharedDoc!, "RareGem");
    for (let i = 0; i < 2; i++) trackCoOccurrences(store.db, [seedEntity, specificEntity]);

    const neighbors = getEntityGraphNeighbors(store.db, [seedDoc!]);
    const shared = neighbors.find(n => n.docId === sharedDoc!);
    expect(shared).toBeDefined();
    expect(shared!.viaEntity).toBe(specificEntity);
  });

  // BL-001 turn-3 regression: an entity whose mentions are ALL archived must
  // be dropped from the candidate pool entirely — zero active docFreq would
  // otherwise grant it MAXIMUM specificity and let it crowd the cap while
  // hydrating archived doc IDs.
  it("excludes archived-only candidates from the pool and the results (BL-001)", () => {
    const [seedDoc, rareDoc] = seedDocuments(store, [
      { path: "seed.md", title: "Seed", body: "seed doc" },
      { path: "rare-1.md", title: "Rare 1", body: "specific doc" },
    ]);
    const deadDocs = seedDocuments(
      store,
      Array.from({ length: 5 }, (_, i) => ({
        path: `dead-${i}.md`,
        title: `Dead ${i}`,
        body: "archived doc",
      }))
    );

    const seedEntity = upsertEntity(store.db, "SeedTopic", "project", "default");
    recordEntityMention(store.db, seedEntity, seedDoc!, "SeedTopic");

    // Archived-only entity: high co-occurrence count, every mention archived.
    const ghostEntity = upsertEntity(store.db, "GhostEntity", "tool", "default");
    for (const d of deadDocs) recordEntityMention(store.db, ghostEntity, d, "GhostEntity");
    for (let i = 0; i < 10; i++) trackCoOccurrences(store.db, [seedEntity, ghostEntity]);
    const archiveStmt = store.db.prepare("UPDATE documents SET active = 0 WHERE id = ?");
    for (const d of deadDocs) archiveStmt.run(d);

    // Live specific entity with a modest count.
    const specificEntity = upsertEntity(store.db, "RareGem", "tool", "default");
    recordEntityMention(store.db, specificEntity, rareDoc!, "RareGem");
    for (let i = 0; i < 2; i++) trackCoOccurrences(store.db, [seedEntity, specificEntity]);

    const neighbors = getEntityGraphNeighbors(store.db, [seedDoc!]);
    expect(neighbors.some(n => n.viaEntity === specificEntity)).toBe(true);
    expect(neighbors.every(n => n.viaEntity !== ghostEntity)).toBe(true);
    for (const d of deadDocs) {
      expect(neighbors.some(n => n.docId === d)).toBe(false);
    }
  });

  // BL-001 turn-3 regression: the hydration active-guard must sit BEFORE the
  // per-entity LIMIT — with >10 archived mentions inserted ahead of an active
  // one, an after-the-fact filter would return only archived rows and miss
  // the active doc.
  it("hydrates the active doc even when >10 archived mentions precede it (BL-001)", () => {
    const [seedDoc] = seedDocuments(store, [
      { path: "seed.md", title: "Seed", body: "seed doc" },
    ]);
    const oldDocs = seedDocuments(
      store,
      Array.from({ length: 12 }, (_, i) => ({
        path: `old-${i}.md`,
        title: `Old ${i}`,
        body: "archived doc",
      }))
    );
    const [liveDoc] = seedDocuments(store, [
      { path: "live.md", title: "Live", body: "active doc" },
    ]);

    const seedEntity = upsertEntity(store.db, "SeedTopic", "project", "default");
    recordEntityMention(store.db, seedEntity, seedDoc!, "SeedTopic");

    // 12 archived mentions recorded BEFORE the single active mention.
    const entity = upsertEntity(store.db, "MostlyArchived", "tool", "default");
    for (const d of oldDocs) recordEntityMention(store.db, entity, d, "MostlyArchived");
    recordEntityMention(store.db, entity, liveDoc!, "MostlyArchived");
    const archiveStmt = store.db.prepare("UPDATE documents SET active = 0 WHERE id = ?");
    for (const d of oldDocs) archiveStmt.run(d);

    trackCoOccurrences(store.db, [seedEntity, entity]);
    trackCoOccurrences(store.db, [seedEntity, entity]);

    const neighbors = getEntityGraphNeighbors(store.db, [seedDoc!]);
    expect(neighbors.some(n => n.docId === liveDoc!)).toBe(true);
    for (const d of oldDocs) {
      expect(neighbors.some(n => n.docId === d)).toBe(false);
    }
  });
});

// =============================================================================
// §1.5 v0.8.3 — Content-type-aware entity cap
// =============================================================================
//
// Regression guard for v0.8.3 §1.5: the flat `.slice(0, 10)` in extractEntities
// silently dropped legitimate entities on long-form content (research, hub,
// conversation). Replaced with a content-type → cap mapping. Untyped callers
// must still cap at 10 to preserve pre-v0.8.3 behavior.
//
// Pairs with clawmem-v0.8.3-plan.md § "Entity cap mapping (§1.5 specification)"
// =============================================================================

describe("entityCapForContentType (§1.5)", () => {
  it("returns 15 for research content", () => {
    expect(entityCapForContentType("research")).toBe(15);
  });

  it("returns 12 for hub content", () => {
    expect(entityCapForContentType("hub")).toBe(12);
  });

  it("returns 12 for conversation content", () => {
    expect(entityCapForContentType("conversation")).toBe(12);
  });

  it("returns 8 for decision content", () => {
    expect(entityCapForContentType("decision")).toBe(8);
  });

  it("returns 8 for deductive content", () => {
    expect(entityCapForContentType("deductive")).toBe(8);
  });

  it("returns 10 for project content", () => {
    expect(entityCapForContentType("project")).toBe(10);
  });

  it("returns 10 for undefined content type (backward compat default)", () => {
    expect(entityCapForContentType(undefined)).toBe(10);
  });

  it("returns 10 for empty string (falsy default path)", () => {
    expect(entityCapForContentType("")).toBe(10);
  });

  it("returns 10 for unknown content type (fallback)", () => {
    expect(entityCapForContentType("some-made-up-type")).toBe(10);
  });

  // v0.8.3 Codex review turn 23 — normalization fix.
  // DB content_type values are not normalized at the write boundary, so
  // hand-authored frontmatter ("Research", " conversation ", "DECISION")
  // must still resolve to their canonical caps.
  it("normalizes uppercase content type (Research → 15)", () => {
    expect(entityCapForContentType("Research")).toBe(15);
  });

  it("normalizes fully uppercase content type (DECISION → 8)", () => {
    expect(entityCapForContentType("DECISION")).toBe(8);
  });

  it("normalizes mixed-case content type (HuB → 12)", () => {
    expect(entityCapForContentType("HuB")).toBe(12);
  });

  it("trims leading/trailing whitespace", () => {
    expect(entityCapForContentType(" research ")).toBe(15);
    expect(entityCapForContentType("\tconversation\n")).toBe(12);
  });

  it("whitespace-only string falls back to default 10", () => {
    expect(entityCapForContentType("   ")).toBe(10);
  });
});

describe("extractEntities content-type-aware cap (§1.5)", () => {
  // Build a JSON array of N entities that will survive extractEntities filters:
  // - not matching the doc title (similarityRatio < 0.85)
  // - within length bounds (2-100 chars)
  // - valid type from the allowed enum
  // - not in the blocklist ("entity name", "example", "name", etc.)
  // - not ending with a colon
  // - "tool" type avoids the location validation branch
  function buildEntityResponse(count: number): string {
    const entities = Array.from({ length: count }, (_, i) => ({
      name: `Widget${i}Factory`, // distinctive, no collision with title "Doc"
      type: "tool",
    }));
    return JSON.stringify(entities);
  }

  it("research content keeps 15 entities (§1.5 main fix — was 10 in v0.8.2)", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: buildEntityResponse(20),
      model: "mock",
      done: true,
    });

    const result = await extractEntities(llm, "Doc", "content body", "research");
    expect(result).toHaveLength(15);
  });

  it("hub content keeps 12 entities", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: buildEntityResponse(20),
      model: "mock",
      done: true,
    });

    const result = await extractEntities(llm, "Doc", "content body", "hub");
    expect(result).toHaveLength(12);
  });

  it("conversation content keeps 12 entities", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: buildEntityResponse(20),
      model: "mock",
      done: true,
    });

    const result = await extractEntities(llm, "Doc", "content body", "conversation");
    expect(result).toHaveLength(12);
  });

  it("decision content keeps only 8 entities", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: buildEntityResponse(20),
      model: "mock",
      done: true,
    });

    const result = await extractEntities(llm, "Doc", "content body", "decision");
    expect(result).toHaveLength(8);
  });

  it("untyped call keeps exactly 10 entities (pre-v0.8.3 backward-compat)", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: buildEntityResponse(20),
      model: "mock",
      done: true,
    });

    // No contentType argument — this is the regression guard for callers
    // that don't thread content_type through.
    const result = await extractEntities(llm, "Doc", "content body");
    expect(result).toHaveLength(10);
  });

  it("unknown content type falls back to default 10", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: buildEntityResponse(20),
      model: "mock",
      done: true,
    });

    const result = await extractEntities(llm, "Doc", "content body", "not-a-real-type");
    expect(result).toHaveLength(10);
  });

  it("cap does not inflate small lists — 5 entities stays 5 even for research", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: buildEntityResponse(5),
      model: "mock",
      done: true,
    });

    const result = await extractEntities(llm, "Doc", "content body", "research");
    expect(result).toHaveLength(5);
  });

  // v0.8.3 Codex review turn 23 — prompt-shape regression.
  // The post-LLM slice is only half the fix. The prompt string itself must
  // advertise the correct cap, otherwise a compliant model stops at the
  // hardcoded "0-10 entities" even when we'd accept 15, and §1.5 becomes
  // a no-op on long-form content in production.
  describe("prompt embeds the dynamic cap", () => {
    it("research → prompt says 0-15 entities", async () => {
      const llm = createMockLLM();
      llm.generate.mockResolvedValueOnce({
        text: "[]",
        model: "mock",
        done: true,
      });

      await extractEntities(llm, "Doc", "content body", "research");

      const calls = llm.generate.mock.calls;
      expect(calls.length).toBe(1);
      const [renderedPrompt] = calls[0] as [string, unknown];
      expect(renderedPrompt).toContain("0-15 entities");
      expect(renderedPrompt).not.toContain("0-10 entities");
    });

    it("decision → prompt says 0-8 entities", async () => {
      const llm = createMockLLM();
      llm.generate.mockResolvedValueOnce({
        text: "[]",
        model: "mock",
        done: true,
      });

      await extractEntities(llm, "Doc", "content body", "decision");

      const calls = llm.generate.mock.calls;
      const [renderedPrompt] = calls[0] as [string, unknown];
      expect(renderedPrompt).toContain("0-8 entities");
      expect(renderedPrompt).not.toContain("0-10 entities");
    });

    it("untyped → prompt says 0-10 entities (default preserved)", async () => {
      const llm = createMockLLM();
      llm.generate.mockResolvedValueOnce({
        text: "[]",
        model: "mock",
        done: true,
      });

      await extractEntities(llm, "Doc", "content body");

      const calls = llm.generate.mock.calls;
      const [renderedPrompt] = calls[0] as [string, unknown];
      expect(renderedPrompt).toContain("0-10 entities");
    });

    it("uppercase content type normalizes into the prompt cap (Research → 15)", async () => {
      const llm = createMockLLM();
      llm.generate.mockResolvedValueOnce({
        text: "[]",
        model: "mock",
        done: true,
      });

      await extractEntities(llm, "Doc", "content body", "Research");

      const calls = llm.generate.mock.calls;
      const [renderedPrompt] = calls[0] as [string, unknown];
      expect(renderedPrompt).toContain("0-15 entities");
    });
  });
});

// §13.1 — extractEntities rides withRetryAndFeedback: a transient malformed
// response gets a corrective retry instead of silently losing the entities.
describe("extractEntities retry-with-error-feedback (§13.1)", () => {
  const VALID_RESPONSE = JSON.stringify([
    { name: "Widget0Factory", type: "tool" },
    { name: "Widget1Factory", type: "tool" },
  ]);

  it("recovers entities when a malformed response is followed by a valid retry", async () => {
    const llm = createMockLLM();
    llm.generate
      .mockResolvedValueOnce({ text: "no json here at all", model: "mock", done: true })
      .mockResolvedValueOnce({ text: VALID_RESPONSE, model: "mock", done: true });

    const result = await extractEntities(llm, "Doc", "content body");

    expect(result.map((e) => e.name)).toEqual(["Widget0Factory", "Widget1Factory"]);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    const retryPrompt = llm.generate.mock.calls[1]?.[0] as string;
    expect(retryPrompt).toContain("did not match the expected structure");
  });

  it("retries when entries are structurally invalid, then accepts the corrected array", async () => {
    const llm = createMockLLM();
    llm.generate
      .mockResolvedValueOnce({ text: '[{"name": 42, "type": "tool"}]', model: "mock", done: true })
      .mockResolvedValueOnce({ text: VALID_RESPONSE, model: "mock", done: true });

    const result = await extractEntities(llm, "Doc", "content body");

    expect(result).toHaveLength(2);
    expect(llm.generate).toHaveBeenCalledTimes(2);
  });

  it("returns [] after terminal failure (all attempts malformed)", async () => {
    const llm = createMockLLM();
    llm.generate
      .mockResolvedValueOnce({ text: "still not json", model: "mock", done: true })
      .mockResolvedValueOnce({ text: "nope", model: "mock", done: true })
      .mockResolvedValueOnce({ text: "not even close", model: "mock", done: true });

    const result = await extractEntities(llm, "Doc", "content body");

    expect(result).toEqual([]);
    expect(llm.generate).toHaveBeenCalledTimes(3);
  });

  it("treats an empty [] response as valid — no retry burned on it", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({ text: "[]", model: "mock", done: true });

    const result = await extractEntities(llm, "Doc", "content body");

    expect(result).toEqual([]);
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });
});
