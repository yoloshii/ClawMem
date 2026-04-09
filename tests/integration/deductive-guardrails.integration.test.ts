import { describe, it, expect } from "bun:test";
import {
  runDeductiveSynthesis,
  type DeductiveSynthesisStats,
} from "../../src/consolidation.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import { hashContent } from "../../src/indexer.ts";
import type { Store } from "../../src/store.ts";

/**
 * Integration tests for Ext 1 — Anti-contamination LLM synthesis
 * wrapper driven through the real `runDeductiveSynthesis` path.
 *
 * Each test seeds a set of "recent observations" (docs with
 * `content_type` in the deductive source types, `observation_type`
 * set, `facts` populated, `modified_at` within 7 days), then mocks
 * the LLM for both the draft-generation call and the per-draft
 * validation calls. Assertions cover:
 *
 *  - Full happy path → deductive doc inserted, stats reflect success
 *  - Contamination reject → no deductive doc inserted, stats counter set
 *  - LLM null on draft-gen → clean no-op with nullCalls=1
 *  - LLM null on validation → deterministic accept via fallback +
 *    validatorFallbackAccepts counter
 */

/**
 * Seed a document that will be picked up by Phase 3's recent-obs query.
 * Returns the doc id.
 */
function seedDeductiveSource(
  store: Store,
  opts: {
    path: string;
    title: string;
    facts: string;
    narrative?: string;
    contentType?: "decision" | "preference" | "milestone" | "problem";
    observationType?: string;
    modifiedAt?: string;
  }
): number {
  const contentType = opts.contentType ?? "decision";
  const observationType = opts.observationType ?? "explicit";
  const modifiedAt = opts.modifiedAt ?? new Date().toISOString();
  const body = `# ${opts.title}\n\n${opts.facts}\n\n${opts.narrative ?? ""}`;
  const hash = hashContent(body);

  store.insertContent(hash, body, modifiedAt);
  store.insertDocument("test", opts.path, opts.title, hash, modifiedAt, modifiedAt);

  const row = store.db
    .prepare(`SELECT id FROM documents WHERE collection = 'test' AND path = ? AND active = 1`)
    .get(opts.path) as { id: number } | undefined;
  if (!row) throw new Error(`failed to seed ${opts.path}`);

  store.db
    .prepare(
      `UPDATE documents
       SET content_type = ?,
           observation_type = ?,
           facts = ?,
           narrative = ?
       WHERE id = ?`
    )
    .run(contentType, observationType, opts.facts, opts.narrative ?? "", row.id);

  return row.id;
}

function seedEntityMention(
  store: Store,
  entityId: string,
  entityType: string,
  name: string,
  docId: number
) {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO entity_nodes
         (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES (?, ?, ?, datetime('now'), 1, datetime('now'), 'default')`
    )
    .run(entityId, entityType, name);
  store.db
    .prepare(
      `INSERT OR IGNORE INTO entity_mentions
         (entity_id, doc_id, mention_text, created_at)
       VALUES (?, ?, NULL, datetime('now'))`
    )
    .run(entityId, docId);
}

/**
 * Mock the LLM for a single Phase 3 tick: first call is the draft-gen
 * JSON array; subsequent calls are the validation JSON objects.
 */
function stageLLM(
  llm: ReturnType<typeof createMockLLM>,
  draftGenJson: string,
  validationResponses: Array<string | null>
) {
  llm.generate.mockResolvedValueOnce({
    text: draftGenJson,
    model: "mock-llm",
    done: true,
  });
  for (const v of validationResponses) {
    if (v === null) {
      llm.generate.mockResolvedValueOnce(null);
    } else {
      llm.generate.mockResolvedValueOnce({
        text: v,
        model: "mock-llm",
        done: true,
      });
    }
  }
}

describe("Phase 3 happy path — validated draft is persisted", () => {
  it("creates a deductive doc when draft passes all guardrails", async () => {
    const store = createTestStore();
    const llm = createMockLLM();

    const srcAId = seedDeductiveSource(store, {
      path: "src-a.md",
      title: "Decision A",
      facts: "the engineering team decided to migrate the auth service to OAuth2",
    });
    const srcBId = seedDeductiveSource(store, {
      path: "src-b.md",
      title: "Decision B",
      facts: "the engineering team completed the OAuth2 migration last Friday",
    });

    // LLM draft generation returns one draft citing both sources
    stageLLM(
      llm,
      JSON.stringify([
        {
          conclusion: "the engineering team completed the OAuth2 migration for the auth service",
          premises: ["decided to migrate auth to OAuth2", "completed the migration last Friday"],
          source_indices: [1, 2],
        },
      ]),
      // Validation: accept with refinement
      [
        JSON.stringify({
          accepted: true,
          conclusion: "the engineering team completed the OAuth2 migration for the auth service last Friday",
          premises: ["migration decided", "migration completed"],
        }),
      ]
    );

    const stats: DeductiveSynthesisStats = await runDeductiveSynthesis(store, llm);

    expect(stats.considered).toBe(2);
    expect(stats.drafted).toBe(1);
    expect(stats.accepted).toBe(1);
    expect(stats.rejected).toBe(0);
    expect(stats.contaminationRejects).toBe(0);
    expect(stats.created).toBe(1);
    expect(stats.validatorFallbackAccepts).toBe(0);

    // Verify the deductive doc landed with source provenance and supporting edges
    const deductive = store.db
      .prepare(
        `SELECT id, title, source_doc_ids, content_type, confidence
         FROM documents WHERE content_type = 'deductive' AND active = 1`
      )
      .all() as {
      id: number;
      title: string;
      source_doc_ids: string;
      content_type: string;
      confidence: number;
    }[];
    expect(deductive).toHaveLength(1);
    expect(deductive[0]!.confidence).toBe(0.85);
    // Order depends on Phase 3's recentObs ORDER BY modified_at DESC and the
    // mapping from source_indices → recentObs[i-1].id — compare as sets.
    expect(new Set(JSON.parse(deductive[0]!.source_doc_ids))).toEqual(
      new Set([srcAId, srcBId])
    );

    const dedId = deductive[0]!.id;
    const supporting = store.db
      .prepare(
        `SELECT source_id, target_id FROM memory_relations
         WHERE target_id = ? AND relation_type = 'supporting'`
      )
      .all(dedId) as { source_id: number; target_id: number }[];
    expect(supporting).toHaveLength(2);
    const supportingSources = supporting.map((r) => r.source_id).sort();
    expect(supportingSources).toEqual([srcAId, srcBId].sort());
  });
});

describe("Phase 3 contamination reject — draft mentions pool-only entity", () => {
  it("rejects draft when conclusion names a non-source entity (entity-aware)", async () => {
    const store = createTestStore();
    const llm = createMockLLM();

    // Phase 3 orders recentObs by `modified_at DESC`, so the most recent
    // doc becomes source_indices=1. Set explicit timestamps so the test's
    // intended mapping is deterministic: srcA=1, srcB=2, srcC=3.
    const now = Date.now();
    const ts = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

    const srcAId = seedDeductiveSource(store, {
      path: "src-a.md",
      title: "Alice decision",
      facts: "Alice decided to ship the feature",
      modifiedAt: ts(0), // most recent → index 1
    });
    const srcBId = seedDeductiveSource(store, {
      path: "src-b.md",
      title: "Alice milestone",
      facts: "Alice completed the feature implementation",
      modifiedAt: ts(5), // → index 2
    });
    // A third recent observation NOT cited by any draft — but in the pool
    const srcCId = seedDeductiveSource(store, {
      path: "src-c.md",
      title: "Charlie note",
      facts: "Charlie reviewed the code",
      contentType: "decision",
      modifiedAt: ts(10), // oldest → index 3
    });

    seedEntityMention(store, "default:person:alice", "person", "Alice", srcAId);
    seedEntityMention(store, "default:person:alice", "person", "Alice", srcBId);
    seedEntityMention(store, "default:person:charlie", "person", "Charlie", srcCId);

    // Draft cites only Alice sources (indices 1, 2) but conclusion
    // mentions Charlie (pool-only at index 3)
    stageLLM(
      llm,
      JSON.stringify([
        {
          conclusion: "Alice and Charlie together shipped the feature after thorough review",
          premises: ["Alice shipped", "Charlie reviewed"],
          source_indices: [1, 2], // only Alice sources
        },
      ]),
      [] // no validation call expected — rejected before LLM validation
    );

    const stats = await runDeductiveSynthesis(store, llm);

    expect(stats.drafted).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.contaminationRejects).toBe(1);
    expect(stats.accepted).toBe(0);
    expect(stats.created).toBe(0);

    // No deductive doc should have been created
    const deductive = store.db
      .prepare(`SELECT id FROM documents WHERE content_type = 'deductive' AND active = 1`)
      .all() as { id: number }[];
    expect(deductive).toHaveLength(0);
  });
});

describe("Phase 3 LLM-null on draft-gen — clean no-op", () => {
  it("returns stats with nullCalls=1 when draft LLM returns null", async () => {
    const store = createTestStore();
    const llm = createMockLLM();

    seedDeductiveSource(store, {
      path: "src-a.md",
      title: "A",
      facts: "some fact A",
    });
    seedDeductiveSource(store, {
      path: "src-b.md",
      title: "B",
      facts: "some fact B",
    });

    llm.generate.mockResolvedValueOnce(null);

    const stats = await runDeductiveSynthesis(store, llm);

    expect(stats.nullCalls).toBe(1);
    expect(stats.drafted).toBe(0);
    expect(stats.created).toBe(0);
  });
});

describe("Phase 3 LLM-null on validation — fallback accept", () => {
  it("counts fallbackAccepts when validator LLM returns null and draft lands", async () => {
    const store = createTestStore();
    const llm = createMockLLM();

    seedDeductiveSource(store, {
      path: "src-a.md",
      title: "A",
      facts: "the engineering team shipped feature A last Friday",
    });
    seedDeductiveSource(store, {
      path: "src-b.md",
      title: "B",
      facts: "the engineering team shipped feature B last Friday",
    });

    stageLLM(
      llm,
      JSON.stringify([
        {
          conclusion: "the engineering team shipped both features last Friday",
          premises: ["feature A shipped", "feature B shipped"],
          source_indices: [1, 2],
        },
      ]),
      [null] // validator returns null → fallback accept
    );

    const stats = await runDeductiveSynthesis(store, llm);

    expect(stats.drafted).toBe(1);
    expect(stats.accepted).toBe(1);
    expect(stats.validatorFallbackAccepts).toBe(1);
    expect(stats.created).toBe(1);
  });
});

describe("Phase 3 invalid indices reject", () => {
  it("rejects draft with source_indices pointing at non-existent obs", async () => {
    const store = createTestStore();
    const llm = createMockLLM();

    seedDeductiveSource(store, { path: "src-a.md", title: "A", facts: "fact A" });
    seedDeductiveSource(store, { path: "src-b.md", title: "B", facts: "fact B" });

    stageLLM(
      llm,
      JSON.stringify([
        {
          conclusion: "some valid-looking conclusion about the team",
          premises: [],
          source_indices: [99, 100], // out of range
        },
      ]),
      []
    );

    const stats = await runDeductiveSynthesis(store, llm);

    expect(stats.drafted).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.invalidIndexRejects).toBe(1);
    expect(stats.created).toBe(0);
  });
});

describe("Phase 3 no-op when fewer than 2 recent observations", () => {
  it("returns stats with considered<2 and nothing else", async () => {
    const store = createTestStore();
    const llm = createMockLLM();

    seedDeductiveSource(store, { path: "src-a.md", title: "A", facts: "fact A" });
    // Only one source — not enough to deduce anything

    const stats = await runDeductiveSynthesis(store, llm);

    expect(stats.considered).toBe(1);
    expect(stats.drafted).toBe(0);
    expect(stats.created).toBe(0);
    // No LLM call should have happened
    expect(llm.generate).toHaveBeenCalledTimes(0);
  });
});
