import { describe, it, expect } from "bun:test";
import {
  buildSourceRelationContext,
  collectRelevantEvidence,
  scanConclusionContamination,
  validateDeductiveDraft,
  type DeductiveDraft,
  type DocLike,
} from "../../src/deductive-guardrails.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";

/**
 * Unit tests for Ext 1 — Anti-contamination LLM synthesis wrapper
 * (THOTH_EXTRACTION_PLAN.md Extraction 1).
 *
 * Covers the four public helpers plus the orchestrator's pre-check /
 * contamination / LLM-fallback decision matrix.
 */

// ─── collectRelevantEvidence ───────────────────────────────────────────

describe("collectRelevantEvidence", () => {
  it("keeps sentences with ≥2 draft-token overlap", () => {
    const docs: DocLike[] = [
      {
        id: 1,
        title: "A",
        facts: "The team shipped the OAuth2 migration. The team also fixed a bug.",
        narrative: "Unrelated commentary about weather.",
      },
    ];
    const draft: DeductiveDraft = {
      conclusion: "The team shipped OAuth2 migration on schedule",
      premises: ["team shipped OAuth2"],
      sourceIndices: [1],
    };

    const { evidenceSentences } = collectRelevantEvidence(docs, draft);
    // Should keep the "The team shipped the OAuth2 migration" sentence
    // (shares: team, shipped, oauth2, migration → ≥2 overlap)
    // Should drop "The team also fixed a bug" (shares: team → <2 overlap)
    // Should drop "Unrelated commentary about weather" (shares: nothing)
    const joined = evidenceSentences.join(" | ");
    expect(joined).toContain("shipped");
    expect(joined).toContain("OAuth2");
    expect(joined).not.toContain("weather");
  });

  it("returns empty when no sentences overlap", () => {
    const docs: DocLike[] = [
      { id: 1, title: "A", facts: "completely unrelated content", narrative: "nothing matches here" },
    ];
    const draft: DeductiveDraft = {
      conclusion: "The server rebooted last night",
      premises: [],
      sourceIndices: [1],
    };
    const { evidenceSentences } = collectRelevantEvidence(docs, draft);
    expect(evidenceSentences).toHaveLength(0);
  });

  it("prefixes each sentence with its doc id", () => {
    const docs: DocLike[] = [
      { id: 42, title: "A", facts: "Alice shipped the OAuth2 feature on Friday", narrative: "" },
    ];
    const draft: DeductiveDraft = {
      conclusion: "Alice shipped OAuth2 Friday",
      premises: [],
      sourceIndices: [42],
    };
    const { evidenceSentences } = collectRelevantEvidence(docs, draft);
    expect(evidenceSentences.length).toBeGreaterThan(0);
    expect(evidenceSentences[0]).toContain("[doc#42]");
  });

  it("handles null facts/narrative gracefully", () => {
    const docs: DocLike[] = [
      { id: 1, title: "A", facts: null, narrative: null },
    ];
    const draft: DeductiveDraft = {
      conclusion: "any conclusion",
      premises: [],
      sourceIndices: [1],
    };
    expect(() => collectRelevantEvidence(docs, draft)).not.toThrow();
  });
});

// ─── buildSourceRelationContext ────────────────────────────────────────

describe("buildSourceRelationContext", () => {
  function seedRelation(
    store: Store,
    sourceId: number,
    targetId: number,
    type: string,
    weight: number
  ) {
    store.db
      .prepare(
        `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .run(sourceId, targetId, type, weight);
  }

  it("returns empty string when <2 source docs", () => {
    const store = createTestStore();
    expect(buildSourceRelationContext(store, [])).toBe("");
    expect(buildSourceRelationContext(store, [1])).toBe("");
  });

  it("returns empty string when no edges exist among sources", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);
    expect(buildSourceRelationContext(store, ids)).toBe("");
  });

  it("formats edges among source docs sorted by weight DESC", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
    ]);
    seedRelation(store, ids[0]!, ids[1]!, "supporting", 0.75);
    seedRelation(store, ids[1]!, ids[2]!, "causal", 0.95); // strongest

    const ctx = buildSourceRelationContext(store, ids);
    const lines = ctx.split("\n");
    expect(lines).toHaveLength(2);
    // Strongest edge should be listed first
    expect(lines[0]).toContain("causal");
    expect(lines[0]).toContain("0.95");
    expect(lines[1]).toContain("supporting");
    expect(lines[1]).toContain("0.75");
  });

  it("excludes edges whose target is outside the source set", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
    ]);
    // Edge from source to a NON-source doc — should be excluded
    seedRelation(store, ids[0]!, ids[2]!, "semantic", 0.9);

    const ctx = buildSourceRelationContext(store, [ids[0]!, ids[1]!]);
    expect(ctx).toBe("");
  });

  it("caps at maxEdges parameter", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
      { path: "d.md", title: "D", body: "D" },
    ]);
    seedRelation(store, ids[0]!, ids[1]!, "supporting", 0.9);
    seedRelation(store, ids[1]!, ids[2]!, "supporting", 0.8);
    seedRelation(store, ids[2]!, ids[3]!, "supporting", 0.7);

    const ctx = buildSourceRelationContext(store, ids, 2);
    expect(ctx.split("\n")).toHaveLength(2);
  });
});

// ─── scanConclusionContamination ───────────────────────────────────────

describe("scanConclusionContamination", () => {
  function addEntityMention(
    store: Store,
    entityId: string,
    name: string,
    docId: number
  ) {
    store.db
      .prepare(
        `INSERT OR IGNORE INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
         VALUES (?, 'person', ?, datetime('now'), 1, datetime('now'), 'default')`
      )
      .run(entityId, name);
    store.db
      .prepare(
        `INSERT OR IGNORE INTO entity_mentions (entity_id, doc_id, mention_text, created_at)
         VALUES (?, ?, NULL, datetime('now'))`
      )
      .run(entityId, docId);
  }

  it("entity-aware: flags conclusion mentioning pool-only entity by name", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" }, // outside source
    ]);
    addEntityMention(store, "default:person:alice", "Alice", ids[0]!);
    addEntityMention(store, "default:person:alice", "Alice", ids[1]!);
    // Charlie is in the pool but NOT in the sources — a contamination candidate
    addEntityMention(store, "default:person:charlie", "Charlie", ids[2]!);

    const pool: DocLike[] = ids.map((id) => ({ id, title: "x", facts: "", narrative: "" }));

    const result = scanConclusionContamination(
      store,
      "Alice and Charlie shipped the feature together",
      [ids[0]!, ids[1]!],
      pool
    );

    expect(result.method).toBe("entity");
    expect(result.hits).toContain("Charlie");
  });

  it("entity-aware: returns empty hits when sources cover all referenced entities", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);
    addEntityMention(store, "default:person:alice", "Alice", ids[0]!);
    addEntityMention(store, "default:person:bob", "Bob", ids[1]!);

    const pool: DocLike[] = ids.map((id) => ({ id, title: "x", facts: "", narrative: "" }));

    const result = scanConclusionContamination(
      store,
      "Alice and Bob shipped the feature together",
      ids,
      pool
    );

    expect(result.method).toBe("entity");
    expect(result.hits).toHaveLength(0);
  });

  it("lexical fallback when source docs have no entity mentions", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alice shipped feature" },
      { path: "b.md", title: "B", body: "Alice deployed today" },
      { path: "c.md", title: "C", body: "Charlie reviewed code" }, // pool-only
    ]);

    const pool: DocLike[] = [
      { id: ids[0]!, title: "a", facts: "Alice shipped feature", narrative: "" },
      { id: ids[1]!, title: "b", facts: "Alice deployed today", narrative: "" },
      { id: ids[2]!, title: "c", facts: "Charlie reviewed code", narrative: "" },
    ];

    // No entity_mentions seeded → lexical fallback
    const result = scanConclusionContamination(
      store,
      "Alice and Charlie worked together on the feature",
      [ids[0]!, ids[1]!],
      pool
    );

    expect(result.method).toBe("lexical");
    expect(result.hits).toContain("charlie");
  });

  it("lexical fallback: empty hits when conclusion stays within source anchors", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alice shipped feature" },
      { path: "b.md", title: "B", body: "Alice deployed today" },
    ]);
    const pool: DocLike[] = [
      { id: ids[0]!, title: "a", facts: "Alice shipped feature", narrative: "" },
      { id: ids[1]!, title: "b", facts: "Alice deployed today", narrative: "" },
    ];
    const result = scanConclusionContamination(
      store,
      "Alice shipped and deployed the feature",
      ids,
      pool
    );
    expect(result.method).toBe("lexical");
    expect(result.hits).toHaveLength(0);
  });

  it("does not crash on empty candidate pool", () => {
    const store = createTestStore();
    const result = scanConclusionContamination(store, "some text", [], []);
    expect(result.hits).toEqual([]);
  });

  it("entity-aware: matches names with internal/trailing punctuation (auth-service, OAuth2.0, C++)", () => {
    // Regression guard: `\bname\b` fails for names that end in non-word
    // characters (`+`, `.`) because `\b` requires one side to be a
    // word char. The fix uses `(?<=^|[^a-z0-9])name(?=$|[^a-z0-9])`.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" }, // pool-only — holds the punctuation entity
    ]);
    // Sources own some bland entity; pool owns the tricky-named ones.
    addEntityMention(store, "default:person:alice", "Alice", ids[0]!);
    addEntityMention(store, "default:person:alice", "Alice", ids[1]!);
    addEntityMention(store, "default:tech:auth_service", "auth-service", ids[2]!);
    addEntityMention(store, "default:tech:oauth2", "OAuth2.0", ids[2]!);
    addEntityMention(store, "default:tech:cpp", "C++", ids[2]!);

    const pool: DocLike[] = ids.map((id) => ({ id, title: "x", facts: "", narrative: "" }));

    // Case 1: name with internal hyphen, appears standalone
    expect(
      scanConclusionContamination(
        store,
        "Alice fixed the auth-service bug",
        [ids[0]!, ids[1]!],
        pool
      ).hits
    ).toContain("auth-service");

    // Case 2: name ending in digit+dot (OAuth2.0), followed by space
    expect(
      scanConclusionContamination(
        store,
        "Alice migrated to OAuth2.0 yesterday",
        [ids[0]!, ids[1]!],
        pool
      ).hits
    ).toContain("OAuth2.0");

    // Case 3: name ending in `+` (C++), followed by space — the `\b`
    // bug would miss this because both `+` and space are non-word
    // characters, breaking the `\b` anchor.
    expect(
      scanConclusionContamination(
        store,
        "Alice ported the module to C++ last sprint",
        [ids[0]!, ids[1]!],
        pool
      ).hits
    ).toContain("C++");
  });

  it("entity-aware: does not false-positive on substring occurrences", () => {
    // Sanity check: the new boundary regex must not match a name when
    // it's just a substring of a longer word.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
      { path: "c.md", title: "C", body: "C" },
    ]);
    addEntityMention(store, "default:person:alice", "Alice", ids[0]!);
    addEntityMention(store, "default:person:alice", "Alice", ids[1]!);
    addEntityMention(store, "default:tech:auth_service", "auth-service", ids[2]!);

    const pool: DocLike[] = ids.map((id) => ({ id, title: "x", facts: "", narrative: "" }));

    // "authenticationservice" is not "auth-service" — the name in the
    // pool has a hyphen that must not be bypassed by substring matching.
    const result = scanConclusionContamination(
      store,
      "Alice used the authenticationservice module",
      [ids[0]!, ids[1]!],
      pool
    );
    expect(result.hits).toHaveLength(0);
  });
});

// ─── validateDeductiveDraft ────────────────────────────────────────────

describe("validateDeductiveDraft", () => {
  function makeStore() {
    return createTestStore();
  }

  function makeSources(store: Store, count: number): DocLike[] {
    const ids = seedDocuments(
      store,
      Array.from({ length: count }, (_, i) => ({
        path: `src${i}.md`,
        title: `Src ${i}`,
        body: `source content ${i}`,
      }))
    );
    return ids.map((id, i) => ({
      id,
      title: `Src ${i}`,
      facts: `source content ${i} includes the phrase engineering team`,
      narrative: "",
    }));
  }

  it("rejects with reason=empty on trivial conclusion", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);
    const result = await validateDeductiveDraft(
      store,
      llm,
      { conclusion: "  ", premises: [], sourceIndices: [1, 2] },
      sources,
      sources
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("rejects with reason=invalid_indices when <2 unique sources", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 1);
    const result = await validateDeductiveDraft(
      store,
      llm,
      { conclusion: "a conclusion about the engineering team", premises: [], sourceIndices: [1] },
      sources,
      sources
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("invalid_indices");
  });

  it("rejects with reason=contamination when conclusion mentions pool-only entity", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);

    // Seed entity_mentions: source docs have Alice, pool has Charlie (outside sources)
    store.db
      .prepare(
        `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
         VALUES ('default:person:alice', 'person', 'Alice', datetime('now'), 1, datetime('now'), 'default')`
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
         VALUES ('default:person:charlie', 'person', 'Charlie', datetime('now'), 1, datetime('now'), 'default')`
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at)
         VALUES ('default:person:alice', ?, NULL, datetime('now'))`
      )
      .run(sources[0]!.id);
    store.db
      .prepare(
        `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at)
         VALUES ('default:person:alice', ?, NULL, datetime('now'))`
      )
      .run(sources[1]!.id);

    // Seed a THIRD pool doc with Charlie mention
    const [poolOnlyId] = seedDocuments(store, [
      { path: "pool.md", title: "Pool", body: "Charlie reviewed the code" },
    ]);
    store.db
      .prepare(
        `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at)
         VALUES ('default:person:charlie', ?, NULL, datetime('now'))`
      )
      .run(poolOnlyId!);

    const pool: DocLike[] = [
      ...sources,
      { id: poolOnlyId!, title: "Pool", facts: "Charlie reviewed", narrative: "" },
    ];

    const result = await validateDeductiveDraft(
      store,
      llm,
      {
        conclusion: "Alice and Charlie shipped the engineering team's work together",
        premises: [],
        sourceIndices: [1, 2],
      },
      sources,
      pool
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("contamination");
    expect(result.contaminationHits).toContain("Charlie");
    expect(result.contaminationMethod).toBe("entity");
  });

  it("accepts on LLM positive + no contamination", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);

    llm.generate.mockResolvedValueOnce({
      text: '{"accepted": true, "conclusion": "refined conclusion about the engineering team"}',
      model: "mock-llm",
      done: true,
    });

    const result = await validateDeductiveDraft(
      store,
      llm,
      {
        conclusion: "the engineering team shipped the feature on time",
        premises: ["shipped"],
        sourceIndices: [1, 2],
      },
      sources,
      sources
    );

    expect(result.accepted).toBe(true);
    expect(result.conclusion).toBe("refined conclusion about the engineering team");
  });

  it("rejects with reason=unsupported when LLM says accepted=false", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);

    llm.generate.mockResolvedValueOnce({
      text: '{"accepted": false, "reason": "not supported by sources"}',
      model: "mock-llm",
      done: true,
    });

    const result = await validateDeductiveDraft(
      store,
      llm,
      {
        conclusion: "the engineering team shipped the feature on time",
        premises: [],
        sourceIndices: [1, 2],
      },
      sources,
      sources
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("unsupported");
  });

  it("deterministic accept on LLM null (cooldown) — fallbackAccepted=true", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);

    llm.generate.mockResolvedValueOnce(null);

    const result = await validateDeductiveDraft(
      store,
      llm,
      {
        conclusion: "the engineering team shipped the feature on time",
        premises: [],
        sourceIndices: [1, 2],
      },
      sources,
      sources
    );

    expect(result.accepted).toBe(true);
    expect(result.fallbackAccepted).toBe(true);
  });

  it("deterministic accept on LLM throw — fallbackAccepted=true", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);

    llm.generate.mockRejectedValueOnce(new Error("timeout"));

    const result = await validateDeductiveDraft(
      store,
      llm,
      {
        conclusion: "the engineering team shipped the feature on time",
        premises: [],
        sourceIndices: [1, 2],
      },
      sources,
      sources
    );

    expect(result.accepted).toBe(true);
    expect(result.fallbackAccepted).toBe(true);
  });

  it("deterministic accept on malformed LLM JSON — fallbackAccepted=true", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);

    llm.generate.mockResolvedValueOnce({
      text: "This is not JSON, it's plain prose explaining a thing.",
      model: "mock-llm",
      done: true,
    });

    const result = await validateDeductiveDraft(
      store,
      llm,
      {
        conclusion: "the engineering team shipped the feature on time",
        premises: [],
        sourceIndices: [1, 2],
      },
      sources,
      sources
    );

    expect(result.accepted).toBe(true);
    expect(result.fallbackAccepted).toBe(true);
  });

  it("LLM-affirmed accept does NOT set fallbackAccepted", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    const sources = makeSources(store, 2);

    llm.generate.mockResolvedValueOnce({
      text: '{"accepted": true, "conclusion": "refined"}',
      model: "mock-llm",
      done: true,
    });

    const result = await validateDeductiveDraft(
      store,
      llm,
      {
        conclusion: "the engineering team shipped the feature on time",
        premises: [],
        sourceIndices: [1, 2],
      },
      sources,
      sources
    );

    expect(result.accepted).toBe(true);
    expect(result.fallbackAccepted).toBeUndefined();
  });

  it("never throws on any input", async () => {
    const store = makeStore();
    const llm = createMockLLM();
    llm.generate.mockRejectedValueOnce(new Error("boom"));

    const sources = makeSources(store, 2);
    let threw = false;
    try {
      await validateDeductiveDraft(
        store,
        llm,
        {
          conclusion: "the engineering team shipped the feature on time",
          premises: [],
          sourceIndices: [1, 2],
        },
        sources,
        sources
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
