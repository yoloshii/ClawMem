import { describe, it, expect, afterEach } from "bun:test";
import {
  findSimilarConsolidation,
  mergeIntoExistingConsolidation,
} from "../../src/consolidation.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";

/**
 * Integration test for Ext 3 — Name-aware dual-threshold merge safety.
 *
 * Drives `findSimilarConsolidation` (the real merge-lookup function used
 * by consolidation's synthesizeCluster) through the following cases:
 *
 *  1. Old Jaccard-only behavior is REPLACED: a Jaccard-0.5+ collision
 *     between materially different topics no longer auto-merges.
 *  2. The gate still merges paraphrases of the same observation.
 *  3. Entity-aware path is preferred when both sides have entity_mentions.
 *  4. CLAWMEM_MERGE_GUARD_DRY_RUN=true restores legacy behavior for
 *     operator observation during rollout.
 */

const TEST_COLLECTION = "test_consolidation";

function insertConsolidation(
  store: Store,
  observation: string,
  sourceDocIds: number[],
  collection: string = TEST_COLLECTION
): number {
  const result = store.db
    .prepare(
      `INSERT INTO consolidated_observations
         (observation, proof_count, source_doc_ids, trend, status, collection)
       VALUES (?, ?, ?, 'NEW', 'active', ?)`
    )
    .run(observation, sourceDocIds.length, JSON.stringify(sourceDocIds), collection);
  return Number(result.lastInsertRowid);
}

function addEntityMention(store: Store, entityId: string, docId: number, name: string) {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO entity_nodes
         (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES (?, 'person', ?, datetime('now'), 1, datetime('now'), 'default')`
    )
    .run(entityId, name);
  store.db
    .prepare(
      `INSERT OR IGNORE INTO entity_mentions
         (entity_id, doc_id, mention_text, created_at)
       VALUES (?, ?, NULL, datetime('now'))`
    )
    .run(entityId, docId);
}

describe("findSimilarConsolidation — merge safety gate (Ext 3)", () => {
  afterEach(() => {
    delete process.env.CLAWMEM_MERGE_GUARD_DRY_RUN;
  });

  it("Jaccard-only collisions with materially different anchors are hard-rejected", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "dan.md", title: "Dan", body: "Dan visited Paris" },
      { path: "dad.md", title: "Dad", body: "Dad visited Paris" },
    ]);

    // Seed an existing consolidation about "Dan"
    insertConsolidation(store, "Dan visited Paris last year on vacation", [seedIds[0]!]);

    // Candidate about "Dad" — high Jaccard overlap ("visited", "paris",
    // "last", "year", "vacation") but a materially different subject
    const match = findSimilarConsolidation(
      store,
      "Dad visited Paris last year on vacation",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    // Old behavior: would merge Dan into Dad (Jaccard ~1.0).
    // New behavior: lexical anchors {dan, paris, vacation} vs
    // {dad, paris, vacation} — overlap 2/3 ≈ 0.67 — NOT material.
    // Falls through to NORMAL threshold; 3-gram cosine is ~0.92 which
    // is below 0.93 → rejected on threshold. This particular case hits
    // the threshold path rather than the hard-reject path, but either
    // way the merge is blocked.
    expect(match).toBeNull();
  });

  it("hard-reject: 2-anchor Dan vs Dad case hits the boundary rule", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "dan.md", title: "Dan", body: "Dan left" },
      { path: "dad.md", title: "Dad", body: "Dad left" },
    ]);

    // Shorter observation text with exactly two lexical anchors per side,
    // one shared ("Monday") — triggers the 1-of-2 boundary rule.
    insertConsolidation(store, "Dan left on Monday", [seedIds[0]!]);

    const match = findSimilarConsolidation(
      store,
      "Dad left on Monday",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    // Anchors {dan, monday} vs {dad, monday} → overlap 1, smaller 2
    // → 0.5 ≤ 0.5 → material → hard reject regardless of text score.
    expect(match).toBeNull();
  });

  it("paraphrases of the same observation still merge", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "source A" },
      { path: "b.md", title: "B", body: "source B" },
    ]);

    // Existing consolidation
    const existingId = insertConsolidation(
      store,
      "The migration to OAuth2-based authentication was completed last Friday by the team",
      [seedIds[0]!]
    );

    // New candidate with the same subject and minimal rewording. The
    // anchors are lexically identical and the 3-gram cosine should be
    // well above NORMAL (0.93).
    const match = findSimilarConsolidation(
      store,
      "The migration to OAuth2-based authentication was completed last Friday by the team.",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    expect(match).not.toBeNull();
    expect(match?.id).toBe(existingId);
  });

  it("entity_aware path merges when canonical entities match", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "alice1.md", title: "Alice 1", body: "Alice shipped the feature" },
      { path: "alice2.md", title: "Alice 2", body: "Alice shipped the feature again" },
    ]);

    // Both docs share the SAME canonical entity — entity_mentions is
    // the entity-aware source of truth for both sides.
    addEntityMention(store, "default:person:alice", seedIds[0]!, "Alice");
    addEntityMention(store, "default:person:alice", seedIds[1]!, "Alice");

    const existingId = insertConsolidation(
      store,
      "Alice successfully shipped the authentication service last sprint without any incidents reported",
      [seedIds[0]!]
    );

    const match = findSimilarConsolidation(
      store,
      "Alice successfully shipped the authentication service last sprint without any incidents reported",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    expect(match).not.toBeNull();
    expect(match?.id).toBe(existingId);
  });

  it("entity_aware path HARD-REJECTS when canonical entities disjoint, even with identical text", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "alice.md", title: "Alice", body: "Alice shipped the feature" },
      { path: "bob.md", title: "Bob", body: "Bob shipped the feature" },
    ]);

    addEntityMention(store, "default:person:alice", seedIds[0]!, "Alice");
    addEntityMention(store, "default:person:bob", seedIds[1]!, "Bob");

    // Existing consolidation sourced from the Alice doc
    insertConsolidation(
      store,
      "shipped the authentication service last sprint without any incidents reported during the rollout phase of the release",
      [seedIds[0]!]
    );

    // Candidate from the Bob doc — identical observation text, but the
    // canonical entities are disjoint. Under the previous design this
    // merged at score 1.0 >= STRICT 0.98; under the hard-reject rule
    // the gate refuses to merge two consolidations sourced from docs
    // with disjoint primary subjects regardless of how similar the
    // templated observation wording happens to be.
    const match = findSimilarConsolidation(
      store,
      "shipped the authentication service last sprint without any incidents reported during the rollout phase of the release",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    expect(match).toBeNull();
  });

  it("entity_aware + slight wording drift + disjoint entities rejects", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "alice.md", title: "Alice", body: "Alice shipped" },
      { path: "bob.md", title: "Bob", body: "Bob shipped" },
    ]);

    addEntityMention(store, "default:person:alice", seedIds[0]!, "Alice");
    addEntityMention(store, "default:person:bob", seedIds[1]!, "Bob");

    insertConsolidation(
      store,
      "The release of the authentication service was completed on schedule last sprint by the owning team",
      [seedIds[0]!]
    );

    // Slightly reworded candidate + disjoint canonical entities → gate
    // upgrades to STRICT (0.98) and the reworded text should not clear
    // 0.98.
    const match = findSimilarConsolidation(
      store,
      "The launch of the authentication service was completed on schedule last sprint by the owning team",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    expect(match).toBeNull();
  });

  it("CLAWMEM_MERGE_GUARD_DRY_RUN=true restores legacy Jaccard-only behavior", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "dan.md", title: "Dan", body: "Dan visited Paris" },
      { path: "dad.md", title: "Dad", body: "Dad visited Paris" },
    ]);

    const existingId = insertConsolidation(
      store,
      "Dan visited Paris last year on vacation",
      [seedIds[0]!]
    );

    process.env.CLAWMEM_MERGE_GUARD_DRY_RUN = "true";

    // Same scenario as the first test — the gate would normally reject
    // this merge. In dry-run mode the legacy Jaccard-only path wins.
    const match = findSimilarConsolidation(
      store,
      "Dad visited Paris last year on vacation",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    expect(match).not.toBeNull();
    expect(match?.id).toBe(existingId);
  });

  it("dry-run multi-candidate parity: returns FIRST shortlist hit, not highest Jaccard", () => {
    // Legacy behavior was "iterate SELECT rows, return first Jaccard
    // > 0.5". The shortlist is populated in DB insertion order, so the
    // first inserted qualifying row should win — even if a later row
    // has a higher Jaccard score. This test catches the regression
    // where dry-run returned the best Jaccard instead.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
    ]);

    // Insert TWO consolidations that both beat Jaccard 0.5 against the
    // candidate. The second one has higher Jaccard (more shared words),
    // but legacy behavior returns the first.
    const firstId = insertConsolidation(
      store,
      "team shipped feature sprint retrospective meeting",
      [seedIds[0]!]
    );
    insertConsolidation(
      store,
      "team shipped feature sprint retrospective meeting discussion notes agenda",
      [seedIds[1]!]
    );

    process.env.CLAWMEM_MERGE_GUARD_DRY_RUN = "true";

    const match = findSimilarConsolidation(
      store,
      "team shipped feature sprint retrospective meeting discussion notes agenda",
      TEST_COLLECTION,
      [seedIds[2]!]
    );

    expect(match).not.toBeNull();
    // Legacy parity: must be the first-inserted hit, not the best match
    expect(match?.id).toBe(firstId);
  });

  it("malformed source_doc_ids on existing row: LOOKUP path (findSimilarConsolidation) survives", () => {
    // The lookup path iterates the shortlist and calls safeParseDocIds
    // on each candidate's source_doc_ids for the merge-safety gate.
    // A corrupted row must not throw during iteration.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    // Insert a row with a malformed JSON value in source_doc_ids by
    // bypassing the helper. This simulates production corruption.
    store.db
      .prepare(
        `INSERT INTO consolidated_observations
           (observation, proof_count, source_doc_ids, trend, status, collection)
         VALUES (?, 1, '{not-valid-json', 'NEW', 'active', ?)`
      )
      .run(
        "the migration finished without any incidents reported during rollout phase",
        TEST_COLLECTION
      );

    expect(() => {
      findSimilarConsolidation(
        store,
        "the migration finished without any incidents reported during rollout phase",
        TEST_COLLECTION,
        [seedIds[0]!]
      );
    }).not.toThrow();
  });

  it("malformed source_doc_ids on existing row: UPDATE path (mergeIntoExistingConsolidation) survives", () => {
    // The UPDATE path is exercised by `mergeIntoExistingConsolidation`
    // (extracted from synthesizeCluster so it can be tested directly).
    // A corrupted row is treated as empty prior source list; the
    // merged result is the new source IDs, and the UPDATE succeeds.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    // Seed a corrupted row directly
    const insertResult = store.db
      .prepare(
        `INSERT INTO consolidated_observations
           (observation, proof_count, source_doc_ids, trend, status, collection)
         VALUES (?, 1, '{not-valid-json', 'NEW', 'active', ?)`
      )
      .run("stale observation text", TEST_COLLECTION);
    const existingId = Number(insertResult.lastInsertRowid);

    // Drive the UPDATE path directly, simulating what synthesizeCluster
    // would do when findSimilarConsolidation returns the corrupted row.
    let result: { mergedIds: number[] } | null = null;
    expect(() => {
      result = mergeIntoExistingConsolidation(
        store,
        { id: existingId, source_doc_ids: "{not-valid-json" },
        [seedIds[0]!, seedIds[1]!],
        "refreshed observation text"
      );
    }).not.toThrow();

    expect(result).not.toBeNull();
    expect(result!.mergedIds).toEqual([seedIds[0]!, seedIds[1]!]);

    // Verify the row actually got updated in the DB
    const row = store.db
      .prepare(
        `SELECT proof_count, source_doc_ids, observation
         FROM consolidated_observations WHERE id = ?`
      )
      .get(existingId) as {
      proof_count: number;
      source_doc_ids: string;
      observation: string;
    };

    expect(row.proof_count).toBe(2);
    expect(JSON.parse(row.source_doc_ids)).toEqual([seedIds[0]!, seedIds[1]!]);
    expect(row.observation).toBe("refreshed observation text");
  });

  it("update path dedupes source IDs across merges", () => {
    // Regression guard for the `new Set` dedup: if the new source IDs
    // overlap with the existing ones, the merged list should not
    // double-count.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
    ]);

    const existingId = insertConsolidation(
      store,
      "existing observation",
      [seedIds[0]!, seedIds[1]!]
    );

    const { mergedIds } = mergeIntoExistingConsolidation(
      store,
      { id: existingId, source_doc_ids: JSON.stringify([seedIds[0]!, seedIds[1]!]) },
      [seedIds[1]!, seedIds[2]!], // overlaps on seedIds[1]
      "updated observation"
    );

    expect(mergedIds).toHaveLength(3);
    expect(new Set(mergedIds)).toEqual(new Set([seedIds[0]!, seedIds[1]!, seedIds[2]!]));
  });

  it("no Jaccard shortlist candidates → returns null (no gate call)", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    insertConsolidation(
      store,
      "The weather in Berlin was surprisingly warm for April this year",
      [seedIds[0]!]
    );

    const match = findSimilarConsolidation(
      store,
      "The team decided to adopt TypeScript for the backend rewrite",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    expect(match).toBeNull();
  });
});
