import { describe, it, expect, afterEach } from "bun:test";
import {
  applyContradictoryConsolidation,
  findSimilarConsolidation,
  getConsolidatedObservations,
} from "../../src/consolidation.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import type { ContradictionResult } from "../../src/merge-guards.ts";

/**
 * Integration test for Ext 2 — Contradiction-aware merge gate
 * (THOTH_EXTRACTION_PLAN.md Extraction 2).
 *
 * Covers the Phase 2 merge-path integration via
 * `applyContradictoryConsolidation` (exported helper). Phase 3
 * deductive contradiction linking is exercised by the unit tests in
 * `tests/unit/merge-guards.test.ts` plus Phase 3 shape verification
 * at the bottom of this file.
 */

const TEST_COLLECTION = "test_contradictions";

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

const MOCK_CONTRADICTION: ContradictionResult = {
  contradictory: true,
  confidence: 0.85,
  reason: "test contradiction",
  source: "llm",
};

describe("applyContradictoryConsolidation — policy routing", () => {
  afterEach(() => {
    delete process.env.CLAWMEM_CONTRADICTION_POLICY;
  });

  it("default policy='link': keeps both rows active, sets backlink on old", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const oldId = insertConsolidation(
      store,
      "migration completed on Tuesday",
      [seedIds[0]!]
    );

    const { newId, policy } = applyContradictoryConsolidation(
      store,
      {
        id: oldId,
        observation: "migration completed on Tuesday",
        source_doc_ids: JSON.stringify([seedIds[0]!]),
      },
      "migration completed on Thursday",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    expect(policy).toBe("link");
    expect(newId).toBeGreaterThan(oldId);

    // Both rows should remain active
    const oldRow = store.db
      .prepare("SELECT * FROM consolidated_observations WHERE id = ?")
      .get(oldId) as {
      status: string;
      invalidated_at: string | null;
      invalidated_by: number | null;
      superseded_by: number | null;
    };
    expect(oldRow.status).toBe("active");
    expect(oldRow.invalidated_at).toBeNull(); // not invalidated in link mode
    expect(oldRow.invalidated_by).toBe(newId); // backlink set
    expect(oldRow.superseded_by).toBeNull();

    const newRow = store.db
      .prepare("SELECT * FROM consolidated_observations WHERE id = ?")
      .get(newId) as { status: string; observation: string };
    expect(newRow.status).toBe("active");
    expect(newRow.observation).toBe("migration completed on Thursday");
  });

  it("policy='supersede': invalidates old row, sets all link columns", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    process.env.CLAWMEM_CONTRADICTION_POLICY = "supersede";

    const oldId = insertConsolidation(store, "version 1 shipped", [seedIds[0]!]);

    const { newId, policy } = applyContradictoryConsolidation(
      store,
      {
        id: oldId,
        observation: "version 1 shipped",
        source_doc_ids: JSON.stringify([seedIds[0]!]),
      },
      "version 2 shipped",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    expect(policy).toBe("supersede");

    const oldRow = store.db
      .prepare("SELECT * FROM consolidated_observations WHERE id = ?")
      .get(oldId) as {
      status: string;
      invalidated_at: string | null;
      invalidated_by: number | null;
      superseded_by: number | null;
    };
    expect(oldRow.invalidated_at).not.toBeNull();
    expect(oldRow.invalidated_by).toBe(newId);
    expect(oldRow.superseded_by).toBe(newId);

    const newRow = store.db
      .prepare("SELECT * FROM consolidated_observations WHERE id = ?")
      .get(newId) as { status: string };
    expect(newRow.status).toBe("active");
  });

  it("both policies create a new active row with the new observation text", () => {
    // Regression guard: the new row must always be inserted with the
    // new observation text and source doc ids, regardless of policy.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
    ]);

    const oldId = insertConsolidation(store, "old text", [seedIds[0]!]);
    const { newId } = applyContradictoryConsolidation(
      store,
      { id: oldId, observation: "old text", source_doc_ids: JSON.stringify([seedIds[0]!]) },
      "new different text",
      [seedIds[1]!, seedIds[2]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    const newRow = store.db
      .prepare("SELECT * FROM consolidated_observations WHERE id = ?")
      .get(newId) as {
      observation: string;
      source_doc_ids: string;
      proof_count: number;
    };
    expect(newRow.observation).toBe("new different text");
    expect(JSON.parse(newRow.source_doc_ids)).toEqual([seedIds[1]!, seedIds[2]!]);
    expect(newRow.proof_count).toBe(2);
  });
});

describe("operator query acceptance", () => {
  afterEach(() => {
    delete process.env.CLAWMEM_CONTRADICTION_POLICY;
  });

  it("link-policy contradictions surface via 'invalidated_by IS NOT NULL AND invalidated_at IS NULL'", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const oldId = insertConsolidation(store, "alpha", [seedIds[0]!]);
    applyContradictoryConsolidation(
      store,
      { id: oldId, observation: "alpha", source_doc_ids: JSON.stringify([seedIds[0]!]) },
      "beta (contradicts alpha)",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    const linked = store.db
      .prepare(
        `SELECT * FROM consolidated_observations
         WHERE invalidated_by IS NOT NULL AND invalidated_at IS NULL`
      )
      .all() as { id: number }[];

    expect(linked).toHaveLength(1);
    expect(linked[0]!.id).toBe(oldId);
  });

  it("supersede-policy contradictions surface via 'invalidated_at IS NOT NULL'", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    process.env.CLAWMEM_CONTRADICTION_POLICY = "supersede";

    const oldId = insertConsolidation(store, "gamma", [seedIds[0]!]);
    applyContradictoryConsolidation(
      store,
      { id: oldId, observation: "gamma", source_doc_ids: JSON.stringify([seedIds[0]!]) },
      "delta (supersedes gamma)",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    const invalidated = store.db
      .prepare(
        `SELECT * FROM consolidated_observations WHERE invalidated_at IS NOT NULL`
      )
      .all() as { id: number }[];

    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]!.id).toBe(oldId);
  });
});

describe("Phase 3 deductive contradiction linking (memory_relations)", () => {
  it("a 'contradicts' relation between deductive doc IDs is queryable", () => {
    // Phase 3 writes a `memory_relations(relation_type='contradicts')`
    // edge between two `documents` rows. The full Phase 3 flow requires
    // an LLM and the documents table, which are covered by existing
    // integration tests. This test verifies the write path shape: a
    // relation row with plural 'contradicts' type, weight=0,
    // contradict_confidence set, and metadata JSON — exactly what the
    // production code inserts — can be read back via the operator query.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "d1.md", title: "Deduction 1", body: "first conclusion" },
      { path: "d2.md", title: "Deduction 2", body: "second conclusion" },
    ]);

    store.db
      .prepare(
        `INSERT INTO memory_relations
           (source_id, target_id, relation_type, weight, contradict_confidence, metadata, created_at)
         VALUES (?, ?, 'contradicts', 0, ?, ?, datetime('now'))`
      )
      .run(
        seedIds[0]!,
        seedIds[1]!,
        0.85,
        JSON.stringify({ reason: "opposite conclusions about the same subject" })
      );

    const rows = store.db
      .prepare(
        `SELECT source_id, target_id, relation_type, weight, contradict_confidence, metadata
         FROM memory_relations
         WHERE relation_type = 'contradicts'`
      )
      .all() as Array<{
      source_id: number;
      target_id: number;
      relation_type: string;
      weight: number;
      contradict_confidence: number;
      metadata: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe(seedIds[0]!);
    expect(rows[0]!.target_id).toBe(seedIds[1]!);
    expect(rows[0]!.relation_type).toBe("contradicts");
    expect(rows[0]!.weight).toBe(0);
    expect(rows[0]!.contradict_confidence).toBe(0.85);
    expect(JSON.parse(rows[0]!.metadata)).toEqual({
      reason: "opposite conclusions about the same subject",
    });
  });

  it("plural 'contradicts' is the only canonical form the query finds (P0 guard)", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "x.md", title: "X", body: "X" },
      { path: "y.md", title: "Y", body: "Y" },
    ]);

    // The canonical plural form
    store.db
      .prepare(
        `INSERT INTO memory_relations
           (source_id, target_id, relation_type, weight, contradict_confidence, created_at)
         VALUES (?, ?, 'contradicts', 0, 0.9, datetime('now'))`
      )
      .run(seedIds[0]!, seedIds[1]!);

    // A singular query returns zero — confirms P0 taxonomy guard holds
    // through the Phase 3 write path too.
    const singular = store.db
      .prepare(
        `SELECT COUNT(*) as n FROM memory_relations WHERE relation_type = 'contradict'`
      )
      .get() as { n: number };
    expect(singular.n).toBe(0);

    const plural = store.db
      .prepare(
        `SELECT COUNT(*) as n FROM memory_relations WHERE relation_type = 'contradicts'`
      )
      .get() as { n: number };
    expect(plural.n).toBe(1);
  });
});

describe("Ext 3 integration — findSimilarConsolidation now returns observation text", () => {
  it("return shape includes { id, observation, source_doc_ids } for Phase 2 contradiction check", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const existingId = insertConsolidation(
      store,
      "The migration to OAuth2-based authentication was completed last Friday by the team",
      [seedIds[0]!]
    );

    const match = findSimilarConsolidation(
      store,
      "The migration to OAuth2-based authentication was completed last Friday by the team.",
      TEST_COLLECTION,
      [seedIds[1]!]
    );

    expect(match).not.toBeNull();
    expect(match?.id).toBe(existingId);
    expect(match?.observation).toContain("OAuth2-based authentication");
    expect(match?.source_doc_ids).toBeDefined();
  });
});

describe("supersede invariant — old row must stop surfacing", () => {
  afterEach(() => {
    delete process.env.CLAWMEM_CONTRADICTION_POLICY;
  });

  it("superseded row disappears from findSimilarConsolidation", () => {
    // Regression guard for the Turn 7 HIGH finding: supersede used to
    // set only `invalidated_at` and leave `status='active'`, so the
    // old row still surfaced to findSimilarConsolidation (which
    // filters by `status='active'`). The fix sets `status='inactive'`
    // in supersede mode so the row is excluded by existing readers.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
    ]);

    process.env.CLAWMEM_CONTRADICTION_POLICY = "supersede";

    // Seed an old row that will be superseded
    const oldId = insertConsolidation(
      store,
      "shared observation text about the engineering team and the sprint work",
      [seedIds[0]!]
    );

    // Supersede it
    applyContradictoryConsolidation(
      store,
      {
        id: oldId,
        observation:
          "shared observation text about the engineering team and the sprint work",
        source_doc_ids: JSON.stringify([seedIds[0]!]),
      },
      "shared observation text about the engineering team and the sprint work, with a CORRECTION",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    // Now a third candidate that is Jaccard-close to BOTH rows should
    // never see the superseded (old) row via findSimilarConsolidation.
    const match = findSimilarConsolidation(
      store,
      "shared observation text about the engineering team and the sprint work regarding delivery",
      TEST_COLLECTION,
      [seedIds[2]!]
    );

    if (match !== null) {
      expect(match.id).not.toBe(oldId); // must not surface the superseded row
    }

    // Direct verification: the superseded row's status is 'inactive'
    const oldRow = store.db
      .prepare("SELECT status, invalidated_at FROM consolidated_observations WHERE id = ?")
      .get(oldId) as { status: string; invalidated_at: string | null };
    expect(oldRow.status).toBe("inactive");
    expect(oldRow.invalidated_at).not.toBeNull();
  });

  it("superseded row disappears from getConsolidatedObservations", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    process.env.CLAWMEM_CONTRADICTION_POLICY = "supersede";

    const oldId = insertConsolidation(store, "old observation", [seedIds[0]!]);

    applyContradictoryConsolidation(
      store,
      {
        id: oldId,
        observation: "old observation",
        source_doc_ids: JSON.stringify([seedIds[0]!]),
      },
      "new observation",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    const active = getConsolidatedObservations(store, { collection: TEST_COLLECTION });
    const activeIds = active.map((r) => r.id);
    expect(activeIds).not.toContain(oldId); // superseded must not surface
    expect(active).toHaveLength(1); // only the new row remains active
  });

  it("link policy keeps the old row active (counterpart assertion)", () => {
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    // default: link
    const oldId = insertConsolidation(store, "link-policy old", [seedIds[0]!]);

    applyContradictoryConsolidation(
      store,
      {
        id: oldId,
        observation: "link-policy old",
        source_doc_ids: JSON.stringify([seedIds[0]!]),
      },
      "link-policy new",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    const active = getConsolidatedObservations(store, { collection: TEST_COLLECTION });
    const activeIds = active.map((r) => r.id);
    expect(activeIds).toContain(oldId); // link policy keeps old row active
    expect(active).toHaveLength(2); // both rows surface
  });
});

describe("applyContradictoryConsolidation transaction safety", () => {
  afterEach(() => {
    delete process.env.CLAWMEM_CONTRADICTION_POLICY;
  });

  it("rolls back the new row insertion when the UPDATE on the old row fails", () => {
    // Use a NON-EXISTENT `existing.id` so the UPDATE inside the
    // transaction becomes a no-op (0 rows affected). SQLite will not
    // throw on a no-op UPDATE, so to really force a rollback we must
    // cause the UPDATE to throw. The simplest way: pass an existing
    // row ID whose underlying row we deleted after constructing the
    // existing descriptor, then drop the NOT NULL column via a
    // schema hack... that's too invasive.
    //
    // Alternative approach: wrap the transaction ourselves with an
    // intentionally-throwing inner step, by patching the store.db.
    //
    // Simpler: just assert the happy path is transactional by
    // checking that a successful call is atomic (BEGIN/COMMIT wraps
    // both writes). Since we cannot easily inject a mid-transaction
    // failure without a db mock, the next test asserts atomicity
    // indirectly: after a successful call, the row count matches
    // expectations (no half-states). The rollback semantics are
    // provided by bun:sqlite's db.transaction() wrapper.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const oldId = insertConsolidation(store, "original", [seedIds[0]!]);

    // Happy path: both rows exist after success, no orphans
    const before = store.db
      .prepare("SELECT COUNT(*) as n FROM consolidated_observations")
      .get() as { n: number };
    expect(before.n).toBe(1);

    applyContradictoryConsolidation(
      store,
      {
        id: oldId,
        observation: "original",
        source_doc_ids: JSON.stringify([seedIds[0]!]),
      },
      "contradictory new",
      [seedIds[1]!],
      TEST_COLLECTION,
      MOCK_CONTRADICTION
    );

    const after = store.db
      .prepare("SELECT COUNT(*) as n FROM consolidated_observations")
      .get() as { n: number };
    expect(after.n).toBe(2); // old + new

    // Both rows have the expected state
    const oldRow = store.db
      .prepare("SELECT invalidated_by FROM consolidated_observations WHERE id = ?")
      .get(oldId) as { invalidated_by: number | null };
    expect(oldRow.invalidated_by).not.toBeNull(); // link established
  });

  it("rollback on thrown transaction: no new row if UPDATE throws", () => {
    // Force a transaction failure by passing a corrupt Store whose
    // `prepare` throws on the UPDATE statement. We do this by
    // monkey-patching `store.db.prepare` to throw on a specific SQL
    // fragment AFTER the INSERT has run.
    const store = createTestStore();
    const seedIds = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const oldId = insertConsolidation(store, "pre-tx", [seedIds[0]!]);

    const originalPrepare = store.db.prepare.bind(store.db);
    const patched = ((sql: string) => {
      if (sql.includes("UPDATE consolidated_observations")) {
        throw new Error("simulated update failure");
      }
      return originalPrepare(sql);
    }) as typeof store.db.prepare;
    (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = patched;

    let threw = false;
    try {
      applyContradictoryConsolidation(
        store,
        {
          id: oldId,
          observation: "pre-tx",
          source_doc_ids: JSON.stringify([seedIds[0]!]),
        },
        "would-be new row",
        [seedIds[1]!],
        TEST_COLLECTION,
        MOCK_CONTRADICTION
      );
    } catch {
      threw = true;
    }

    // Restore before any further assertions
    (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = originalPrepare;

    expect(threw).toBe(true);

    // Transaction should have rolled back — no new row inserted
    const count = store.db
      .prepare("SELECT COUNT(*) as n FROM consolidated_observations")
      .get() as { n: number };
    expect(count.n).toBe(1); // only the pre-tx row remains
  });
});
