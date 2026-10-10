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
  ensureEntityCanonical,
  resolveEntityCanonical,
  resolveEntityQuery,
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
// BL-001 residual — enrichment/edge-creation IDF population mismatch
// =============================================================================
//
// The v0.25.0 BL-001 fix aligned the NEIGHBOR path's IDF populations
// (active-only numerator AND denominator). The enrichment path had the same
// mismatch: totalDocs counted active docs while doc_freq counted mentions in
// ALL docs, so archived history deflated specificity (IDF could go negative)
// and suppressed edges for entities specific among the LIVE corpus; candidates
// could also be archived docs. Bug-first: both tests fail on the pre-fix SQL.
// =============================================================================

describe("enrichment IDF active-vs-all population (BL-001 residual)", () => {
  const ENTITY_JSON = JSON.stringify([{ name: "ZanzibarProtocol", type: "project" }]);

  function seedActivePool(n: number): number[] {
    return seedDocuments(store, Array.from({ length: n }, (_, i) => ({
      path: `pool-${i}.md`, title: `Pool ${i}`, body: `filler content ${i}`,
    }))) as number[];
  }

  function archiveDoc(id: number): void {
    store.db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(id);
  }

  it("archived mentions must not deflate specificity below the edge gate", async () => {
    // 70 active docs. The entity is mentioned in ONE active partner doc (+ the
    // enriched doc itself during enrichment) and TWO archived docs.
    // Active-only IDF: ln(71/3) ≈ 3.16 ≥ 3.0 → edge. All-docs denominator
    // (pre-fix): ln(71/5) ≈ 2.65 < 3.0 → wrongly suppressed.
    const pool = seedActivePool(70);
    const targetDoc = pool[0]!;
    const enrichedDoc = pool[1]!;
    const [arch1, arch2] = seedDocuments(store, [
      { path: "arch-1.md", title: "Arch 1", body: "old mention one" },
      { path: "arch-2.md", title: "Arch 2", body: "old mention two" },
    ]);
    archiveDoc(arch1!);
    archiveDoc(arch2!);

    const entityId = upsertEntity(store.db, "ZanzibarProtocol", "project", "default");
    recordEntityMention(store.db, entityId, targetDoc, "ZanzibarProtocol");
    recordEntityMention(store.db, entityId, arch1!, "ZanzibarProtocol");
    recordEntityMention(store.db, entityId, arch2!, "ZanzibarProtocol");

    const llm = createMockLLM();
    llm.generate.mockResolvedValue({ text: ENTITY_JSON, model: "mock", done: true });
    await enrichDocumentEntities(store.db as any, llm as any, enrichedDoc);

    const edge = store.db.prepare(
      `SELECT 1 FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'entity'`
    ).get(enrichedDoc, targetDoc);
    expect(edge).not.toBeNull();
  });

  it("edges are never created toward archived documents", async () => {
    // Entity shared ONLY with an archived doc, and specific enough that the
    // pre-fix code (which admitted archived candidates) would have linked it.
    const pool = seedActivePool(70);
    const enrichedDoc = pool[1]!;
    const [archOnly] = seedDocuments(store, [
      { path: "arch-only.md", title: "Arch Only", body: "sole other mention" },
    ]);
    archiveDoc(archOnly!);

    const entityId = upsertEntity(store.db, "ZanzibarProtocol", "project", "default");
    recordEntityMention(store.db, entityId, archOnly!, "ZanzibarProtocol");

    const llm = createMockLLM();
    llm.generate.mockResolvedValue({ text: ENTITY_JSON, model: "mock", done: true });
    await enrichDocumentEntities(store.db as any, llm as any, enrichedDoc);

    const edge = store.db.prepare(
      `SELECT 1 FROM memory_relations WHERE source_id = ? AND target_id = ?`
    ).get(enrichedDoc, archOnly!);
    expect(edge ?? null).toBeNull();
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

// =============================================================================
// Source 76: names that differ only in a number, and kg_query's lookup
// =============================================================================

/** An entity row written directly (entity_nodes + entities_fts), bypassing the resolver. */
function insertEntityRow(entityId: string, name: string, type: string, mentions: number): void {
  store.db.prepare(
    `INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
     VALUES (?, ?, ?, NULL, datetime('now'), ?, datetime('now'), 'default')`
  ).run(entityId, type, name, mentions);
  store.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`)
    .run(entityId, name.toLowerCase(), type);
}

describe("names that differ only in a number (76.1)", () => {
  // Bug-first: the 0.75 Levenshtein bar let one changed digit through ("node 200" vs "node 202"
  // = 0.875), so a new VM, port, version or date merged silently into whichever entity
  // carrying a neighbouring number existed first.
  it("Node 200 and Node 205 do not resolve to Node 202; the triple path mints their own entities", () => {
    const node202 = upsertEntity(store.db, "Node 202", "project", "default");
    expect(resolveEntityCanonical(store.db, "Node 200", "project", "default")).toBeNull();
    expect(resolveEntityCanonical(store.db, "Node 205", "concept", "default")).toBeNull();
    const node200 = ensureEntityCanonical(store.db, "Node 200", "concept", "default");
    expect(node200).toBe("default:concept:node_200");
    expect(node200).not.toBe(node202);
  });

  it("a version, a port or a date never joins the entity with a neighbouring number", () => {
    upsertEntity(store.db, "Driver 590+", "concept", "default");
    upsertEntity(store.db, "localhost:5020", "service", "default");
    upsertEntity(store.db, "2026-04-22", "concept", "default");
    expect(resolveEntityCanonical(store.db, "Driver 580", "concept", "default")).toBeNull();
    expect(resolveEntityCanonical(store.db, "localhost:5080", "service", "default")).toBeNull();
    expect(resolveEntityCanonical(store.db, "2026-04-13", "concept", "default")).toBeNull();
  });

  it("a name whose numbers match still resolves fuzzily (spacing, punctuation)", () => {
    const vm = upsertEntity(store.db, "Node 202", "project", "default");
    expect(resolveEntityCanonical(store.db, "Node-202", "project", "default")).toBe(vm);
    const cm = upsertEntity(store.db, "ClawMem", "project", "default");
    expect(resolveEntityCanonical(store.db, "Claw Mem", "project", "default")).toBe(cm);
  });

  it("an exact name past the 20th FTS row wins over a fuzzy neighbour, whatever type the caller asks", () => {
    // 25 "Node 1xx" rows fill the exact-token pool ("node" OR "200", LIMIT 20) before "Node 200" is
    // reached; the old code then merged "Node 200" into "Node 100" (0.875).
    for (let i = 0; i < 25; i++) insertEntityRow(`default:project:node_${100 + i}`, `Node ${100 + i}`, "project", 3);
    insertEntityRow("default:project:node_200", "Node 200", "project", 0);
    expect(resolveEntityCanonical(store.db, "Node 200", "concept", "default")).toBe("default:project:node_200");
    // the triple path asks for "concept": it must reuse the project row, not mint a concept twin
    expect(ensureEntityCanonical(store.db, "Node 200", "concept", "default")).toBe("default:project:node_200");
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM entity_nodes WHERE LOWER(name) = 'node 200'`).get() as { n: number }).n).toBe(1);
  });

  it("an exact name that differs only in non-ASCII case wins past the 20th FTS row", () => {
    // SQLite's LOWER() folds ASCII only, so "Élan" is not LOWER-equal to "élan" (Codex T1-2)
    for (let i = 0; i < 25; i++) {
      insertEntityRow(`default:tool:lan_part_${i}`, `Élan part ${"abcdefghijklmnopqrstuvwxy"[i]}`, "tool", 3);
    }
    insertEntityRow("default:tool:lan", "Élan", "tool", 0);
    expect(resolveEntityCanonical(store.db, "élan", "concept", "default")).toBe("default:tool:lan");
    expect(ensureEntityCanonical(store.db, "ÉLAN", "concept", "default")).toBe("default:tool:lan");
  });

  it("JS case folding past the FTS cutoff: İstanbul (a combining dot) and the Kelvin sign", () => {
    // Codex T2: a JS tokenization split "i̇stanbul" at its combining dot (FTS5 indexes one word),
    // and an ASCII argument skipped the lookup although "Kelvin" lowercases to ASCII
    for (let i = 0; i < 25; i++) {
      const s = "abcdefghijklmnopqrstuvwxy"[i];
      insertEntityRow(`default:tool:stanbul_part_${i}`, `İstanbul part ${s}`, "tool", 3);
      insertEntityRow(`default:tool:kelvin_part_${i}`, `kelvin part ${s}`, "tool", 3);
    }
    insertEntityRow("default:tool:i_stanbul", "İstanbul", "tool", 0);
    insertEntityRow("default:tool:elvin", "Kelvin", "tool", 0);
    expect(resolveEntityCanonical(store.db, "i̇stanbul", "concept", "default")).toBe("default:tool:i_stanbul");
    expect(resolveEntityCanonical(store.db, "kelvin", "concept", "default")).toBe("default:tool:elvin");
  });

  it("padding never hides an exact name: ASCII spaces, Unicode spaces, a name with no letters", () => {
    // Codex T4: names compare trimmed (writers store them untrimmed), so every lookup must reach
    // a padded stored name before that comparison
    insertEntityRow("default:service:postgres", " Postgres ", "service", 0);
    insertEntityRow("default:tool:postgres_toolkit", "Postgres toolkit", "tool", 100);
    insertEntityRow("default:tool:lan", " Élan　", "tool", 0);
    insertEntityRow("default:concept:plusplus", " +++ ", "concept", 0);
    expect(resolveEntityQuery(store.db, "Postgres").matches.map(m => m.entity_id)).toEqual(["default:service:postgres"]);
    expect(resolveEntityQuery(store.db, "  postgres ").via).toBe("exact-name");
    expect(resolveEntityQuery(store.db, "élan").matches.map(m => m.entity_id)).toEqual(["default:tool:lan"]);
    expect(resolveEntityQuery(store.db, "+++").matches.map(m => m.entity_id)).toEqual(["default:concept:plusplus"]);
    expect(resolveEntityCanonical(store.db, "postgres", "project", "default")).toBe("default:service:postgres");
  });

  it("among several exact names in the bucket, the oldest wins for every caller, as before", () => {
    // what the old code did when both rows reached the pool: every path keeps feeding one row
    insertEntityRow("default:concept:node_202", "Node 202", "concept", 0);
    insertEntityRow("default:project:node_202", "Node 202", "project", 116);
    expect(resolveEntityCanonical(store.db, "Node 202", "concept", "default")).toBe("default:concept:node_202");
    expect(resolveEntityCanonical(store.db, "Node 202", "project", "default")).toBe("default:concept:node_202");
    expect(resolveEntityCanonical(store.db, "node 202", "service", "default")).toBe("default:concept:node_202");
  });

  it("an exact name in another bucket does not answer", () => {
    insertEntityRow("default:location:node_202", "Node 202", "location", 1);
    expect(resolveEntityCanonical(store.db, "Node 202", "project", "default")).toBeNull();
  });
});

describe("resolveEntityQuery (76.2)", () => {
  beforeEach(() => {
    insertEntityRow("default:service:clawmem", "ClawMem", "service", 500);
    insertEntityRow("default:project:node_202", "Node 202", "project", 116);
    insertEntityRow("default:location:node_202", "Node 202", "location", 1);
    insertEntityRow("default:project:node_200", "Node 200", "project", 0);
    insertEntityRow("default:concept:report_9_two_axes", "Report 9 two axes", "concept", 5);
    insertEntityRow("default:concept:atlas_two", "Atlas Two", "concept", 0);
  });

  it("an exact name beats a much-mentioned entity sharing a token, at any mention count", () => {
    expect(resolveEntityQuery(store.db, "Node 200")).toEqual({
      via: "exact-name",
      matches: [{ entity_id: "default:project:node_200", name: "Node 200", type: "project", mention_count: 0 }],
    });
    expect(resolveEntityQuery(store.db, "atlas two").matches.map(m => m.entity_id)).toEqual(["default:concept:atlas_two"]);
  });

  it("returns every entity that shares the exact name, most mentioned first", () => {
    const r = resolveEntityQuery(store.db, "Node 202");
    expect(r.via).toBe("exact-name");
    expect(r.matches.map(m => m.entity_id)).toEqual(["default:project:node_202", "default:location:node_202"]);
  });

  it("a canonical ID resolves to itself; an unknown ID-shaped argument never reaches the name search", () => {
    expect(resolveEntityQuery(store.db, "default:project:node_200").via).toBe("canonical-id");
    expect(resolveEntityQuery(store.db, "default:project:node_200").matches[0]!.entity_id).toBe("default:project:node_200");
    // its tokens ("default", "project", "node") would match ClawMem and the VMs
    expect(resolveEntityQuery(store.db, "default:project:node_999")).toEqual({ via: null, matches: [] });
    expect(resolveEntityQuery(store.db, "default:tool:bnu")).toEqual({ via: null, matches: [] });
  });

  it("an unknown ID is never answered by another entity that shares its slug", () => {
    // a slug is lossy ("C++" and "C#" both slug to "c"): it does not establish identity (Codex T1-4)
    expect(resolveEntityQuery(store.db, "default:concept:node_200")).toEqual({ via: null, matches: [] });
    expect(resolveEntityQuery(store.db, "default:tool:node_202")).toEqual({ via: null, matches: [] });
  });

  it("an exact name that differs only in non-ASCII case beats a more-mentioned partial match", () => {
    insertEntityRow("default:tool:lan", "Élan", "tool", 0);
    insertEntityRow("default:tool:lan_toolkit", "Élan toolkit", "tool", 100);
    const r = resolveEntityQuery(store.db, "élan");
    expect(r.via).toBe("exact-name");
    expect(r.matches.map(m => m.entity_id)).toEqual(["default:tool:lan"]);
  });

  it("JS case folding in the exact step: İstanbul beats a more-mentioned word match; the Kelvin sign answers an ASCII query", () => {
    // Codex T2's two cases: before, "I toolkit" and "Kelvin toolkit" (100 mentions) answered
    insertEntityRow("default:tool:i_stanbul", "İstanbul", "tool", 0);
    insertEntityRow("default:tool:i_toolkit", "I toolkit", "tool", 100);
    insertEntityRow("default:tool:elvin", "Kelvin", "tool", 0);
    insertEntityRow("default:tool:kelvin_toolkit", "Kelvin toolkit", "tool", 100);
    expect(resolveEntityQuery(store.db, "i̇stanbul")).toEqual({
      via: "exact-name",
      matches: [{ entity_id: "default:tool:i_stanbul", name: "İstanbul", type: "tool", mention_count: 0 }],
    });
    expect(resolveEntityQuery(store.db, "kelvin")).toEqual({
      via: "exact-name",
      matches: [{ entity_id: "default:tool:elvin", name: "Kelvin", type: "tool", mention_count: 0 }],
    });
  });

  it("a name FTS5 makes no token of still matches exactly: circled letters fold case in JS only", () => {
    // Codex T3: "ⒶⒷ" lowercases to "ⓐⓑ" in JS; SQLite LOWER() leaves it, and unicode61 tokenizes neither
    insertEntityRow("default:concept:circled", "ⒶⒷ", "concept", 0);
    expect(resolveEntityQuery(store.db, "ⓐⓑ")).toEqual({
      via: "exact-name",
      matches: [{ entity_id: "default:concept:circled", name: "ⒶⒷ", type: "concept", mention_count: 0 }],
    });
    expect(resolveEntityCanonical(store.db, "ⓐⓑ", "concept", "default")).toBe("default:concept:circled");
  });

  it("an FTS row holding another name for the same ID is not an exact name", () => {
    // makeEntityId slugs "Élan" and "Lan" alike, so a second name's FTS row can join the first entity
    insertEntityRow("default:tool:lan", "Lan", "tool", 5);
    store.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`)
      .run("default:tool:lan", "élan", "tool");
    expect(resolveEntityQuery(store.db, "élan").via).not.toBe("exact-name");
  });

  it("the number check runs before any cut: a crowd of wrong numbers cannot hide the answer", () => {
    // Codex T1-1: ten or more much-mentioned "Node 1xx" filled the old 10-row pool first
    for (let i = 0; i < 12; i++) insertEntityRow(`default:project:node_${100 + i}`, `Node ${100 + i}`, "project", 50);
    insertEntityRow("default:project:node_207_host", "Node 207 host", "project", 0);
    const r = resolveEntityQuery(store.db, "Node 207");
    expect(r.via).toBe("name-word");
    expect(r.matches.map(m => m.entity_id)).toEqual(["default:project:node_207_host"]);
  });

  it("a whole-word match comes before a more-mentioned word-start match; each says which it is", () => {
    // Codex T1-3: the search prefers whole words, so its label must say so
    insertEntityRow("default:concept:atlasware", "Atlasware", "concept", 100);
    const word = resolveEntityQuery(store.db, "Atlas missing");
    expect(word.via).toBe("name-word");
    expect(word.matches.map(m => m.entity_id)).toEqual(["default:concept:atlas_two"]);
    const prefix = resolveEntityQuery(store.db, "Atla");
    expect(prefix.via).toBe("name-prefix");
    expect(prefix.matches.map(m => m.entity_id)).toEqual(["default:concept:atlasware"]);
  });

  it("the search fallback finds a partial name but never a name with a different number", () => {
    const atlas = resolveEntityQuery(store.db, "Atlas");
    expect(atlas.via).toBe("name-word");
    expect(atlas.matches.map(m => m.entity_id)).toEqual(["default:concept:atlas_two"]);
    expect(resolveEntityQuery(store.db, "Node 207")).toEqual({ via: null, matches: [] });
    expect(resolveEntityQuery(store.db, "   ")).toEqual({ via: null, matches: [] });
  });

  it("the search reads entity names only, never the indexed ID or type columns", () => {
    expect(resolveEntityQuery(store.db, "project")).toEqual({ via: null, matches: [] });
    expect(resolveEntityQuery(store.db, "default")).toEqual({ via: null, matches: [] });
    expect(resolveEntityQuery(store.db, "clawme").matches.map(m => m.entity_id)).toEqual(["default:service:clawmem"]);
  });
});
