/**
 * Unit tests for §11.1 — `<vault-facts>` KG injection (v0.9.0).
 *
 * Covers the full Codex-approved test list from BACKLOG.md §11.1:
 *
 *   - extractCanonicalIds / extractProperNouns / generateNgramCandidates
 *     (pure regex + tokenizer helpers)
 *   - batchLookupNames (index-backed SQL batch query)
 *   - extractPromptEntities (three-path candidate gen, per-path
 *     validate-then-count, 100-cap, cross-path dedup, longer-n-gram
 *     tie-breaker)
 *   - buildVaultFactsBlock (triple serialization, token budget,
 *     truncate-at-boundary, fail-open)
 *
 * Plus the explicit BACKLOG-named tests:
 *
 *   - prompt-only-seeding correctness
 *   - exact-match ambiguity skip (resolveEntityTypeExact returns null)
 *   - noise-prompt (proper-noun-shaped common words that don't exist)
 *   - lowercase/hyphenated candidate recall
 *   - index coverage assertion (PRAGMA index_list on fresh store)
 *   - candidate prioritization correctness (validate-first invariant)
 *   - exact-100 boundary case
 *   - path (c) longer-n-gram tie-breaker
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  extractCanonicalIds,
  extractProperNouns,
  generateNgramCandidates,
  batchLookupNames,
  extractPromptEntities,
  buildVaultFactsBlock,
  type VaultFactsTriple,
  type ValidatedEntity,
  type TripleQueryFn,
} from "../../src/vault-facts.ts";
import { createTestStore } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";

// =============================================================================
// Seed helpers
// =============================================================================

function seedEntity(
  store: Store,
  entityId: string,
  name: string,
  type: string,
  vault: string = "default",
): void {
  // Insert into entity_nodes AND the entities_fts sidecar so that
  // ensureEntityCanonical / resolveEntityCanonical (which use FTS5)
  // can find the seeded entity. Real ClawMem inserts via upsertEntity
  // always populate both; tests that bypass upsertEntity must do the
  // same to get a realistic read surface.
  store.db
    .prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
       VALUES (?, ?, ?, NULL, datetime('now'), 1, datetime('now'), ?)`,
    )
    .run(entityId, type, name, vault);
  try {
    store.db
      .prepare(
        `INSERT OR IGNORE INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`,
      )
      .run(entityId, name.toLowerCase(), type);
  } catch {
    /* fts table may not exist in edge cases */
  }
}

// =============================================================================
// Index coverage assertion (Codex §11.1 Turn 4 addition)
// =============================================================================

describe("v0.9.0 schema migration: idx_entity_nodes_lower_name", () => {
  it("PRAGMA index_list(entity_nodes) returns idx_entity_nodes_lower_name after initStore", () => {
    const store = createTestStore();
    const rows = store.db
      .prepare(`PRAGMA index_list(entity_nodes)`)
      .all() as Array<{ name: string }>;
    const names = rows.map(r => r.name);
    expect(names).toContain("idx_entity_nodes_lower_name");
  });
});

// =============================================================================
// Path (a) — canonical-ID regex
// =============================================================================

describe("extractCanonicalIds", () => {
  it("returns [] on empty prompt", () => {
    expect(extractCanonicalIds("")).toEqual([]);
  });

  it("returns [] when no canonical IDs are present", () => {
    expect(extractCanonicalIds("A prompt with no IDs at all")).toEqual([]);
  });

  it("extracts a single canonical ID", () => {
    expect(extractCanonicalIds("see default:project:clawmem now")).toEqual([
      "default:project:clawmem",
    ]);
  });

  it("extracts multiple canonical IDs", () => {
    const out = extractCanonicalIds("work on default:project:clawmem and skill:tool:forge-stack");
    expect(out).toContain("default:project:clawmem");
    expect(out).toContain("skill:tool:forge-stack");
  });

  it("deduplicates identical IDs preserving first occurrence", () => {
    const out = extractCanonicalIds("default:project:clawmem vs default:project:clawmem");
    expect(out).toEqual(["default:project:clawmem"]);
  });
});

// =============================================================================
// Path (b) — proper-noun extraction
// =============================================================================

describe("extractProperNouns", () => {
  it("returns [] on empty prompt", () => {
    expect(extractProperNouns("")).toEqual([]);
  });

  it("extracts CamelCase proper nouns", () => {
    const out = extractProperNouns("ClawMem depends on Bun and SQLite");
    expect(out).toContain("ClawMem");
    expect(out).toContain("Bun");
    expect(out).toContain("SQLite");
  });

  it("extracts all-caps acronyms", () => {
    const out = extractProperNouns("this uses OAuth and JWT for the API");
    expect(out).toContain("OAuth");
    expect(out).toContain("JWT");
    expect(out).toContain("API");
  });

  it("does NOT extract lowercase technical identifiers", () => {
    const out = extractProperNouns("see clawmem and forge-stack");
    expect(out).not.toContain("clawmem");
    expect(out).not.toContain("forge-stack");
  });

  it("deduplicates repeated proper nouns", () => {
    const out = extractProperNouns("ClawMem ClawMem Bun");
    expect(out.filter(x => x === "ClawMem")).toHaveLength(1);
  });
});

// =============================================================================
// Path (c) — normalized n-gram scan
// =============================================================================

describe("generateNgramCandidates", () => {
  it("returns [] on empty prompt", () => {
    expect(generateNgramCandidates("")).toEqual([]);
  });

  it("generates 1-grams, 2-grams, and 3-grams", () => {
    const out = generateNgramCandidates("a b c");
    const normalized = out.map(g => g.normalized);
    expect(normalized).toContain("a");
    expect(normalized).toContain("b");
    expect(normalized).toContain("c");
    expect(normalized).toContain("a b");
    expect(normalized).toContain("b c");
    expect(normalized).toContain("a b c");
  });

  it("keeps internal hyphens as part of tokens (forge-stack stays one token)", () => {
    const out = generateNgramCandidates("see forge-stack now");
    const normalized = out.map(g => g.normalized);
    expect(normalized).toContain("forge-stack");
    expect(normalized).toContain("see forge-stack");
    expect(normalized).toContain("forge-stack now");
  });

  it("normalizes to lowercase", () => {
    const out = generateNgramCandidates("ClawMem Bun");
    const normalized = out.map(g => g.normalized);
    expect(normalized).toContain("clawmem");
    expect(normalized).toContain("bun");
    expect(normalized).toContain("clawmem bun");
  });

  it("strips surrounding punctuation but preserves internal hyphens", () => {
    const out = generateNgramCandidates("`forge-stack`, (context-surfacing).");
    const normalized = out.map(g => g.normalized);
    expect(normalized).toContain("forge-stack");
    expect(normalized).toContain("context-surfacing");
  });

  it("deduplicates by normalized form", () => {
    const out = generateNgramCandidates("clawmem ClawMem CLAWMEM");
    const normalized = out.map(g => g.normalized);
    // All three 1-grams collapse to the same normalized form
    expect(normalized.filter(n => n === "clawmem")).toHaveLength(1);
  });

  it("caps n-gram length at 3", () => {
    const out = generateNgramCandidates("one two three four five");
    const lengths = out.map(g => g.length);
    expect(Math.max(...lengths)).toBe(3);
  });

  it("tags each candidate with its n-gram length", () => {
    const out = generateNgramCandidates("a b c");
    const ones = out.filter(g => g.length === 1);
    const twos = out.filter(g => g.length === 2);
    const threes = out.filter(g => g.length === 3);
    expect(ones).toHaveLength(3); // a, b, c
    expect(twos).toHaveLength(2); // a b, b c
    expect(threes).toHaveLength(1); // a b c
  });
});

// =============================================================================
// batchLookupNames
// =============================================================================

describe("batchLookupNames", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("returns empty map on empty candidate list", () => {
    const out = batchLookupNames(store.db, [], "default");
    expect(out.size).toBe(0);
  });

  it("finds an existing name via case-insensitive lookup", () => {
    seedEntity(store, "default:project:clawmem", "ClawMem", "project");
    const out = batchLookupNames(store.db, ["clawmem"], "default");
    expect(out.size).toBe(1);
    expect(out.get("clawmem")?.entityId).toBe("default:project:clawmem");
    expect(out.get("clawmem")?.entityType).toBe("project");
  });

  it("finds multiple names in a single batch", () => {
    seedEntity(store, "default:project:clawmem", "ClawMem", "project");
    seedEntity(store, "default:tool:bun", "Bun", "tool");
    const out = batchLookupNames(store.db, ["clawmem", "bun"], "default");
    expect(out.size).toBe(2);
  });

  it("honors vault isolation — entries in other vaults are invisible", () => {
    seedEntity(store, "default:project:clawmem", "ClawMem", "project", "default");
    seedEntity(store, "other:project:clawmem", "ClawMem", "project", "other");
    const out = batchLookupNames(store.db, ["clawmem"], "default");
    expect(out.size).toBe(1);
    expect(out.get("clawmem")?.entityId).toBe("default:project:clawmem");
  });

  it("returns empty map when no candidate matches", () => {
    seedEntity(store, "default:project:clawmem", "ClawMem", "project");
    const out = batchLookupNames(store.db, ["nonexistent", "another-fake"], "default");
    expect(out.size).toBe(0);
  });
});

// =============================================================================
// extractPromptEntities — main three-path orchestration
// =============================================================================

describe("extractPromptEntities", () => {
  let store: Store;
  beforeEach(() => {
    store = createTestStore();
  });

  it("returns [] on empty prompt", () => {
    expect(extractPromptEntities("", store.db)).toEqual([]);
  });

  it("returns [] when prompt has no detectable entities and no matching n-grams", () => {
    const out = extractPromptEntities("a completely generic sentence about nothing", store.db);
    expect(out).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Path (a): Canonical-ID regex
  // -------------------------------------------------------------------------

  it("path (a): extracts a canonical ID when the entity exists in entity_nodes", () => {
    seedEntity(store, "default:project:clawmem", "ClawMem", "project");
    const out = extractPromptEntities(
      "please look up default:project:clawmem for me",
      store.db,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.entityId).toBe("default:project:clawmem");
    expect(out[0]!.sourcePath).toBe("canonical-id");
  });

  it("path (a): skips canonical IDs that do not exist in entity_nodes", () => {
    const out = extractPromptEntities(
      "look up default:project:nonexistent please",
      store.db,
    );
    expect(out).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Path (b): Proper-noun extraction with validate-then-count
  // -------------------------------------------------------------------------

  it("path (b): validates proper nouns via resolveEntityTypeExact and keeps exact-one matches", () => {
    seedEntity(store, "default:project:clawmem", "ClawMem", "project");
    const out = extractPromptEntities("talk about ClawMem today", store.db);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("clawmem");
    expect(out[0]!.type).toBe("project");
    expect(out[0]!.sourcePath).toBe("proper-noun");
  });

  it("path (b): skips proper nouns that do NOT exist in entity_nodes (noise-prompt test)", () => {
    // Seed something else so the DB is non-empty but "Foobar" is absent.
    seedEntity(store, "default:project:clawmem", "ClawMem", "project");
    const out = extractPromptEntities(
      "a Random Foobar thing with Nothing Important",
      store.db,
    );
    // None of the proper-noun-shaped words resolve, so nothing is returned.
    expect(out).toEqual([]);
  });

  it("path (b): skips proper nouns that match multiple entity types (exact-match ambiguity skip)", () => {
    // Seed "Alice" as both a person and a project → resolveEntityTypeExact
    // returns null for multi-type matches.
    seedEntity(store, "default:person:alice", "Alice", "person");
    seedEntity(store, "default:project:alice", "Alice", "project");
    const out = extractPromptEntities("ask Alice about it", store.db);
    expect(out).toEqual([]); // ambiguous → skip per-entity
  });

  // -------------------------------------------------------------------------
  // Path (c): n-gram scan for lowercase/hyphenated vocabulary
  // -------------------------------------------------------------------------

  it("path (c): recalls lowercase entity names via n-gram lookup", () => {
    seedEntity(store, "default:project:clawmem", "clawmem", "project");
    const out = extractPromptEntities("work on clawmem please", store.db);
    expect(out).toHaveLength(1);
    expect(out[0]!.sourcePath).toBe("ngram");
    expect(out[0]!.name).toBe("clawmem");
  });

  it("path (c): recalls hyphenated names (forge-stack stays one token)", () => {
    seedEntity(store, "default:tool:forge-stack", "forge-stack", "tool");
    const out = extractPromptEntities("rebuild forge-stack tonight", store.db);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("forge-stack");
    expect(out[0]!.sourcePath).toBe("ngram");
  });

  it("path (c): lowercase/hyphenated candidate recall (Codex Turn 3)", () => {
    // Seed the classic ClawMem vocabulary lowercase: clawmem, forge-stack, oauth2, vm 202.
    seedEntity(store, "default:project:clawmem", "clawmem", "project");
    seedEntity(store, "default:tool:forge-stack", "forge-stack", "tool");
    seedEntity(store, "default:tool:oauth2", "oauth2", "tool");
    seedEntity(store, "default:host:vm-202", "vm 202", "host");

    const out = extractPromptEntities(
      "deploy clawmem on forge-stack using oauth2 on vm 202 please",
      store.db,
    );
    const names = new Set(out.map(e => e.name));
    expect(names.has("clawmem")).toBe(true);
    expect(names.has("forge-stack")).toBe(true);
    expect(names.has("oauth2")).toBe(true);
    expect(names.has("vm 202")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cross-path dedup
  // -------------------------------------------------------------------------

  it("deduplicates across paths by resolved entity_id (path (b) match shadows path (c) n-gram)", () => {
    seedEntity(store, "default:project:clawmem", "ClawMem", "project");
    // "ClawMem" matches via path (b) proper-noun. Then path (c) would also
    // find "clawmem" as a 1-gram in the lowercased prompt — but since it
    // resolves to the SAME entity_id, the cross-path dedup drops the
    // second hit.
    const out = extractPromptEntities("talk about ClawMem again", store.db);
    expect(out).toHaveLength(1);
    expect(out[0]!.sourcePath).toBe("proper-noun");
  });

  // -------------------------------------------------------------------------
  // Validate-first invariant (Codex Turn 5)
  // -------------------------------------------------------------------------

  it("validate-first invariant: long capitalized-heavy prompt does NOT starve path (c)", () => {
    // Seed ONE lowercase technical entity that is only reachable via path (c).
    seedEntity(store, "default:project:clawmem", "clawmem", "project");
    // Build a long prompt with many UNVALIDATED capitalized tokens
    // (path (b) raw extractions) plus the lowercase "clawmem" token
    // (path (c) only).
    const capitalizedNoise = Array.from({ length: 120 }, (_, i) => `Foo${i}`).join(" ");
    const prompt = `${capitalizedNoise} clawmem please`;

    const out = extractPromptEntities(prompt, store.db);
    // Path (b) raw produced 120 tokens, none resolve → none count against
    // the cap → path (c) still gets to fill the budget → clawmem is found.
    expect(out.some(e => e.name === "clawmem")).toBe(true);
    expect(out.find(e => e.name === "clawmem")?.sourcePath).toBe("ngram");
  });

  // -------------------------------------------------------------------------
  // Exact-100 boundary (Codex Turn 5)
  // -------------------------------------------------------------------------

  it("exact-100 boundary: path (c) is dropped entirely when (a) + (b) contribute exactly 100 validated candidates", () => {
    // Seed 100 entities with proper-noun-shaped names.
    for (let i = 0; i < 100; i++) {
      seedEntity(store, `default:thing:foo${i}`, `Foo${i}`, "thing");
    }
    // Seed one lowercase-only entity that only path (c) can reach.
    seedEntity(store, "default:project:clawmem", "clawmem", "project");

    // Prompt mentions all 100 capitalized names + the lowercase clawmem.
    const names = Array.from({ length: 100 }, (_, i) => `Foo${i}`).join(" ");
    const out = extractPromptEntities(`${names} clawmem`, store.db);

    // Expect path (b) to contribute all 100 validated candidates, then
    // the cap kicks in and path (c) is dropped entirely.
    expect(out).toHaveLength(100);
    expect(out.every(e => e.sourcePath === "proper-noun")).toBe(true);
    expect(out.some(e => e.name === "clawmem")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Longer-n-gram tie-breaker (Codex Turn 5)
  // -------------------------------------------------------------------------

  it("path (c) tie-breaker: within path (c), 3-grams are preferred over shorter n-grams", () => {
    // Seed a 3-gram entity AND a 1-gram entity that both match the prompt.
    seedEntity(store, "default:stack:forge-stack-v2", "forge stack v2", "stack");
    seedEntity(store, "default:project:clawmem", "clawmem", "project");

    // Prompt contains both "forge stack v2" (3-gram) and "clawmem" (1-gram).
    // Both path (c) hits. They are independent entities, so both fit in the
    // cap. This test asserts they are BOTH returned (capacity available)
    // AND that the 3-gram comes first in the result (longer-first ordering).
    const out = extractPromptEntities("i need forge stack v2 and clawmem", store.db);
    const ngramOuts = out.filter(e => e.sourcePath === "ngram");
    expect(ngramOuts.length).toBeGreaterThanOrEqual(2);
    // 3-gram appears before 1-gram in the result
    const fsIdx = ngramOuts.findIndex(e => e.name === "forge stack v2");
    const cmIdx = ngramOuts.findIndex(e => e.name === "clawmem");
    expect(fsIdx).toBeGreaterThanOrEqual(0);
    expect(cmIdx).toBeGreaterThanOrEqual(0);
    expect(fsIdx).toBeLessThan(cmIdx);
  });
});

// =============================================================================
// buildVaultFactsBlock — triple serialization + token budget
// =============================================================================

describe("buildVaultFactsBlock", () => {
  const sampleEntity = {
    entityId: "default:project:clawmem",
    name: "clawmem",
    type: "project",
    sourcePath: "proper-noun" as const,
  };

  const sampleTriples: VaultFactsTriple[] = [
    { subject: "ClawMem", predicate: "depends_on", object: "Bun", validTo: null, confidence: 1.0 },
    { subject: "ClawMem", predicate: "uses", object: "SQLite", validTo: null, confidence: 0.95 },
    { subject: "ClawMem", predicate: "deployed_to", object: "VM 202", validTo: null, confidence: 0.9 },
  ];

  it("returns null on empty entity list", () => {
    expect(buildVaultFactsBlock([], () => [], 500)).toBeNull();
  });

  it("returns null when every entity has zero triples (empty-triple skip)", () => {
    expect(buildVaultFactsBlock([sampleEntity], () => [], 500)).toBeNull();
  });

  it("emits a wrapped <vault-facts> block with one or more triples", () => {
    const out = buildVaultFactsBlock([sampleEntity], () => sampleTriples, 500);
    expect(out).not.toBeNull();
    expect(out).toContain("<vault-facts>");
    expect(out).toContain("</vault-facts>");
    expect(out).toContain("ClawMem depends_on Bun");
    expect(out).toContain("ClawMem uses SQLite");
    expect(out).toContain("ClawMem deployed_to VM 202");
  });

  it("filters out triples with validTo <= now", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2099-12-31T00:00:00.000Z";
    const mix: VaultFactsTriple[] = [
      { subject: "ClawMem", predicate: "was", object: "Old", validTo: past, confidence: 1.0 },
      { subject: "ClawMem", predicate: "is", object: "New", validTo: future, confidence: 1.0 },
      { subject: "ClawMem", predicate: "current", object: "Fact", validTo: null, confidence: 1.0 },
    ];
    const out = buildVaultFactsBlock([sampleEntity], () => mix, 500);
    expect(out).not.toBeNull();
    expect(out).not.toContain("ClawMem was Old");
    expect(out).toContain("ClawMem is New");
    expect(out).toContain("ClawMem current Fact");
  });

  it("truncates at triple boundary when budget is exceeded (never mid-triple)", () => {
    // Generate 50 triples. With default 4-chars/token estimate, most lines
    // are ~8-12 tokens. A budget of 60 tokens should fit ~5 lines plus the
    // block overhead.
    const many: VaultFactsTriple[] = Array.from({ length: 50 }, (_, i) => ({
      subject: "S",
      predicate: "p",
      object: `O${i}`,
      validTo: null,
      confidence: 1.0,
    }));
    const out = buildVaultFactsBlock([sampleEntity], () => many, 60);
    expect(out).not.toBeNull();
    // Count the number of triple lines (every triple is on its own line)
    const lines = out!
      .split("\n")
      .filter(l => l.trim().length > 0 && !l.startsWith("<") && !l.endsWith(">"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(50);
    // All included lines are complete (each matches the triple shape)
    for (const line of lines) {
      expect(line).toMatch(/^S p O\d+$/);
    }
  });

  it("returns null when budget is too small to fit even one triple", () => {
    expect(
      buildVaultFactsBlock([sampleEntity], () => sampleTriples, 1),
    ).toBeNull();
  });

  it("returns null when budget is zero", () => {
    expect(
      buildVaultFactsBlock([sampleEntity], () => sampleTriples, 0),
    ).toBeNull();
  });

  it("respects maxTriplesPerEntity cap", () => {
    const many: VaultFactsTriple[] = Array.from({ length: 20 }, (_, i) => ({
      subject: "S",
      predicate: "p",
      object: `O${i}`,
      validTo: null,
      confidence: 1.0,
    }));
    const out = buildVaultFactsBlock(
      [sampleEntity],
      () => many,
      99999, // huge budget — cap comes from maxTriplesPerEntity
      { maxTriplesPerEntity: 5 },
    );
    expect(out).not.toBeNull();
    const lines = out!
      .split("\n")
      .filter(l => l.trim().length > 0 && !l.startsWith("<") && !l.endsWith(">"));
    expect(lines).toHaveLength(5);
  });

  it("fails open per-entity: queryTriples throwing for one entity does not abort the stage", () => {
    const entities = [
      sampleEntity,
      { ...sampleEntity, entityId: "default:tool:bun", name: "bun" },
    ];
    let firstCall = true;
    const queryTriples = (_id: string): VaultFactsTriple[] => {
      if (firstCall) {
        firstCall = false;
        throw new Error("simulated db error");
      }
      return sampleTriples;
    };
    const out = buildVaultFactsBlock(entities, queryTriples, 500);
    expect(out).not.toBeNull();
    expect(out).toContain("ClawMem depends_on Bun"); // from the second entity
  });

  it("dedupes triples across entities when both endpoints are seeded (Codex §11.1 Turn 1)", () => {
    // Scenario: prompt mentions both `ClawMem` and `Bun`. The graph contains
    // `ClawMem depends_on Bun`. queryTriples(ClawMem) returns it as outgoing,
    // queryTriples(Bun) returns the SAME triple as incoming (default direction=both).
    // Without cross-entity dedup, the block would emit the fact twice and spend
    // budget twice for identical information. The fix is to dedupe by stable key
    // before budgeting.
    const sharedTriple: VaultFactsTriple = {
      subject: "default:project:clawmem",
      predicate: "depends_on",
      object: "default:tool:bun",
      validTo: null,
      confidence: 1.0,
    };
    const entities: ValidatedEntity[] = [
      {
        entityId: "default:project:clawmem",
        name: "clawmem",
        type: "project",
        sourcePath: "proper-noun",
      },
      {
        entityId: "default:tool:bun",
        name: "bun",
        type: "tool",
        sourcePath: "proper-noun",
      },
    ];
    const queryTriples: TripleQueryFn = () => [sharedTriple];

    const out = buildVaultFactsBlock(entities, queryTriples, 500);
    expect(out).not.toBeNull();

    const serialized = "default:project:clawmem depends_on default:tool:bun";
    const occurrences = out!.split(serialized).length - 1;
    expect(occurrences).toBe(1);

    // Defense-in-depth: total line count inside the block should be 1 too.
    const lines = out!
      .split("\n")
      .filter(l => l.trim().length > 0 && !l.startsWith("<") && !l.endsWith(">"));
    expect(lines).toHaveLength(1);
  });

  it("dedup preserves distinct triples sharing one endpoint", () => {
    // Guard: only exact (subject, predicate, object) matches are deduped.
    // Two different facts about the same entity pair must both be emitted.
    const triples: VaultFactsTriple[] = [
      {
        subject: "default:project:clawmem",
        predicate: "depends_on",
        object: "default:tool:bun",
        validTo: null,
        confidence: 1.0,
      },
      {
        subject: "default:project:clawmem",
        predicate: "uses",
        object: "default:tool:bun",
        validTo: null,
        confidence: 1.0,
      },
    ];
    const entities: ValidatedEntity[] = [
      {
        entityId: "default:project:clawmem",
        name: "clawmem",
        type: "project",
        sourcePath: "proper-noun",
      },
      {
        entityId: "default:tool:bun",
        name: "bun",
        type: "tool",
        sourcePath: "proper-noun",
      },
    ];
    const queryTriples: TripleQueryFn = () => triples;

    const out = buildVaultFactsBlock(entities, queryTriples, 500);
    expect(out).not.toBeNull();
    expect(out).toContain("default:project:clawmem depends_on default:tool:bun");
    expect(out).toContain("default:project:clawmem uses default:tool:bun");
    // Each exactly once
    expect(out!.split("depends_on").length - 1).toBe(1);
    expect(out!.split(" uses ").length - 1).toBe(1);
  });
});
