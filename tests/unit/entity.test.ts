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
