import { describe, it, expect } from "bun:test";
import {
  anchorSetsMateriallyDiffer,
  extractSourceDocEntities,
  extractSubjectAnchorsLexical,
  MERGE_SCORE_NORMAL,
  MERGE_SCORE_STRICT,
  normalizedCosine3Gram,
  passesMergeSafety,
} from "../../src/text-similarity.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";

/**
 * Unit tests for Ext 3 — Name-aware dual-threshold merge safety
 * (THOTH_EXTRACTION_PLAN.md Extraction 3).
 *
 * The gate is fully deterministic (no LLM), so these tests fully cover
 * the feature. An integration test at
 * tests/integration/consolidation-name-guard.integration.test.ts drives
 * the gate through the real consolidation path.
 */

// ─── normalizedCosine3Gram ─────────────────────────────────────────────

describe("normalizedCosine3Gram", () => {
  it("returns 1.0 for identical strings", () => {
    expect(normalizedCosine3Gram("hello world", "hello world")).toBe(1.0);
  });

  it("returns 1.0 when only punctuation/whitespace differs", () => {
    expect(normalizedCosine3Gram("Hello, World!", "hello world")).toBe(1.0);
  });

  it("returns 0 for empty strings on either side", () => {
    expect(normalizedCosine3Gram("", "hello")).toBe(0);
    expect(normalizedCosine3Gram("hello", "")).toBe(0);
    expect(normalizedCosine3Gram("", "")).toBe(0);
  });

  it("returns a high score for near-identical paraphrases", () => {
    const s = normalizedCosine3Gram(
      "Dan visited Paris last year",
      "Dan visited Paris last year."
    );
    expect(s).toBeGreaterThanOrEqual(0.98);
  });

  it("distinguishes 'Dan visited Paris' from 'Dad visited Paris' via score drop", () => {
    // Single-character difference in a key token — score should drop
    // noticeably below 1.0 but stay quite high because most trigrams
    // are shared. The test documents the metric's sensitivity; the
    // actual decision to reject this merge comes from the hard-reject
    // rule on materially different anchors in `passesMergeSafety`, not
    // from the score alone.
    const s = normalizedCosine3Gram(
      "Dan visited Paris last year",
      "Dad visited Paris last year"
    );
    expect(s).toBeGreaterThan(0.80);
    expect(s).toBeLessThan(0.95);
  });

  it("is lower for materially different sentences", () => {
    const s = normalizedCosine3Gram(
      "The team decided to use REST over GraphQL for simplicity",
      "The weather in Berlin was surprisingly warm for April"
    );
    expect(s).toBeLessThan(0.5);
  });
});

// ─── extractSubjectAnchorsLexical ──────────────────────────────────────

describe("extractSubjectAnchorsLexical", () => {
  it("returns empty for empty input", () => {
    expect(extractSubjectAnchorsLexical("")).toEqual([]);
  });

  it("extracts capitalized proper nouns", () => {
    const anchors = extractSubjectAnchorsLexical("Alice met Bob at Google HQ.");
    expect(anchors).toContain("alice");
    expect(anchors).toContain("bob");
    expect(anchors).toContain("google");
    expect(anchors).toContain("hq");
  });

  it("filters common sentence-start stopwords", () => {
    const anchors = extractSubjectAnchorsLexical(
      "The team shipped the feature. And they celebrated."
    );
    expect(anchors).not.toContain("the");
    expect(anchors).not.toContain("and");
  });

  it("deduplicates repeated anchors", () => {
    const anchors = extractSubjectAnchorsLexical("Alpha met Alpha again near Alpha.");
    expect(anchors.filter((a) => a === "alpha")).toHaveLength(1);
  });

  it("handles CamelCase / mixed case product names", () => {
    const anchors = extractSubjectAnchorsLexical("ClawMem indexes GitHub repos via GPT5.");
    expect(anchors).toContain("clawmem");
    expect(anchors).toContain("github");
    expect(anchors).toContain("gpt5");
  });
});

// ─── anchorSetsMateriallyDiffer ────────────────────────────────────────

describe("anchorSetsMateriallyDiffer", () => {
  it("is false when either side is empty", () => {
    expect(anchorSetsMateriallyDiffer([], ["alice"])).toBe(false);
    expect(anchorSetsMateriallyDiffer(["alice"], [])).toBe(false);
    expect(anchorSetsMateriallyDiffer([], [])).toBe(false);
  });

  it("is false for a proper subset (Bob ⊂ Bob Smith)", () => {
    expect(anchorSetsMateriallyDiffer(["bob"], ["bob", "smith"])).toBe(false);
    expect(anchorSetsMateriallyDiffer(["bob", "smith"], ["bob"])).toBe(false);
  });

  it("is true for disjoint sets (Dan vs Dad)", () => {
    expect(anchorSetsMateriallyDiffer(["dan"], ["dad"])).toBe(true);
  });

  it("is true for fully disjoint multi-entity sets", () => {
    expect(
      anchorSetsMateriallyDiffer(["alice", "paris"], ["bob", "berlin"])
    ).toBe(true);
  });

  it("is false when more than half of the smaller set is shared", () => {
    // overlap = 2, smaller = 2 → 2/2 = 1.0 > 0.5
    expect(
      anchorSetsMateriallyDiffer(["alice", "bob"], ["alice", "bob", "charlie"])
    ).toBe(false);
  });

  it("is true when less than half of the smaller set is shared", () => {
    // overlap = 1, smaller = 3 → 1/3 ≈ 0.33 ≤ 0.5
    expect(
      anchorSetsMateriallyDiffer(
        ["alice", "bob", "charlie"],
        ["alice", "diana", "edward", "frank"]
      )
    ).toBe(true);
  });

  it("boundary: exactly half shared IS material (1-of-2 case)", () => {
    // overlap = 1, smaller = 2 → 1/2 = 0.5 ≤ 0.5 → material
    // This is the `[alice, auth-service]` vs `[bob, auth-service]`
    // primary-subject-mismatch case the gate must fence off.
    expect(
      anchorSetsMateriallyDiffer(
        ["alice", "auth-service"],
        ["bob", "auth-service"]
      )
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(anchorSetsMateriallyDiffer(["Alice"], ["alice"])).toBe(false);
  });
});

// ─── extractSourceDocEntities ──────────────────────────────────────────

describe("extractSourceDocEntities", () => {
  it("returns lexical_fallback when no docs given", () => {
    const store = createTestStore();
    const result = extractSourceDocEntities(store, []);
    expect(result.method).toBe("lexical_fallback");
    expect(result.entities).toEqual([]);
  });

  it("returns lexical_fallback when docs have no entity mentions", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alpha fact" },
    ]);
    const result = extractSourceDocEntities(store, ids);
    expect(result.method).toBe("lexical_fallback");
    expect(result.entities).toEqual([]);
  });

  it("returns entity_mentions when docs have mentions", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alice met Bob at Google" },
      { path: "b.md", title: "B", body: "Bob called Alice later" },
    ]);

    // Seed entity_nodes + entity_mentions manually
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:alice', 'person', 'Alice', datetime('now'), 2, datetime('now'), 'default')`
    ).run();
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:bob', 'person', 'Bob', datetime('now'), 2, datetime('now'), 'default')`
    ).run();
    for (const id of ids) {
      store.db.prepare(
        `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
      ).run("default:person:alice", id);
      store.db.prepare(
        `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
      ).run("default:person:bob", id);
    }

    const result = extractSourceDocEntities(store, ids);
    expect(result.method).toBe("entity_mentions");
    expect(result.entities).toContain("default:person:alice");
    expect(result.entities).toContain("default:person:bob");
  });
});

// ─── passesMergeSafety ─────────────────────────────────────────────────

describe("passesMergeSafety", () => {
  it("strictest_default: both sides have no anchors — strict threshold", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "x.md", title: "X", body: "generic body" },
      { path: "y.md", title: "Y", body: "another generic body" },
    ]);

    const text = "the feature was shipped on time";
    const result = passesMergeSafety(store, text, [ids[0]!], text, [ids[1]!]);

    expect(result.method).toBe("strictest_default");
    expect(result.threshold).toBe(MERGE_SCORE_STRICT);
    expect(result.accepted).toBe(true); // identical text → score 1.0
  });

  it("lexical_only: 'Bob' ⊂ 'Bob Smith' anchors — normal threshold, accept on long text", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    // Long enough text that adding "Smith " is a small relative
    // perturbation — 3-gram cosine stays above NORMAL (0.93).
    // Short-text cases ("Bob X" vs "Bob Smith X") correctly reject
    // because the relative change is too large — the safety gate is
    // meant to block merges when the only difference matters.
    const result = passesMergeSafety(
      store,
      "Bob successfully completed the migration of the legacy authentication service to the new OAuth2-based implementation last Friday",
      [ids[0]!],
      "Bob Smith successfully completed the migration of the legacy authentication service to the new OAuth2-based implementation last Friday",
      [ids[1]!]
    );

    expect(result.method).toBe("lexical_only");
    expect(result.threshold).toBe(MERGE_SCORE_NORMAL);
    // {bob} ⊂ {bob, smith} → anchors NOT materially different → NORMAL
    // threshold; long text keeps 3-gram cosine above 0.93
    expect(result.accepted).toBe(true);
  });

  it("lexical_only: short-text 'Bob' vs 'Bob Smith' rejects — perturbation too large", () => {
    // Counterpart to the long-text case: when the text is short, adding
    // "Smith " changes a large fraction of trigrams, so even though
    // anchors are compatible ({bob} ⊂ {bob, smith}), the 3-gram cosine
    // falls below NORMAL (0.93). This is the correct behavior — for a
    // short observation, "Bob joined" and "Bob Smith joined" are materially
    // different statements worth tracking separately.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const result = passesMergeSafety(
      store,
      "Bob joined the team on Monday",
      [ids[0]!],
      "Bob Smith joined the team on Monday",
      [ids[1]!]
    );

    expect(result.method).toBe("lexical_only");
    expect(result.threshold).toBe(MERGE_SCORE_NORMAL);
    expect(result.accepted).toBe(false);
    expect(result.score).toBeLessThan(MERGE_SCORE_NORMAL);
  });

  it("lexical_only: 'Dan' vs 'Dad' hard-rejects on material anchors (boundary)", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const result = passesMergeSafety(
      store,
      "Dan visited Paris last year",
      [ids[0]!],
      "Dad visited Paris last year",
      [ids[1]!]
    );

    // Anchors {dan, paris} vs {dad, paris} — overlap 1, smaller 2 → 0.5,
    // boundary `≤ 0.5` → material → HARD REJECT regardless of score.
    expect(result.method).toBe("lexical_only");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("hard reject");
  });

  it("lexical_only: fully disjoint anchors + very high text similarity still hard-rejects", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    // Materially different anchors — even if text similarity is high
    // the gate must hard-reject. Previously the gate upgraded to STRICT
    // 0.98 and relied on the score; the new rule is hard-reject regardless.
    const result = passesMergeSafety(
      store,
      "Alice won the Berlin marathon",
      [ids[0]!],
      "Robert won the Tokyo marathon",
      [ids[1]!]
    );

    expect(result.method).toBe("lexical_only");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("hard reject");
  });

  it("entity_aware: both sides have entity_mentions with same entities — normal threshold, accept", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alice shipped the feature" },
      { path: "b.md", title: "B", body: "Alice shipped the feature." },
    ]);

    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:alice', 'person', 'Alice', datetime('now'), 2, datetime('now'), 'default')`
    ).run();
    for (const id of ids) {
      store.db.prepare(
        `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
      ).run("default:person:alice", id);
    }

    const result = passesMergeSafety(
      store,
      "Alice shipped the feature",
      [ids[0]!],
      "Alice shipped the feature.",
      [ids[1]!]
    );

    expect(result.method).toBe("entity_aware");
    expect(result.threshold).toBe(MERGE_SCORE_NORMAL);
    expect(result.accepted).toBe(true);
  });

  it("entity_aware: disjoint canonical entities hard-reject even with identical text", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alice shipped the feature" },
      { path: "b.md", title: "B", body: "Alice shipped the feature" }, // same text!
    ]);

    // Two different canonical entities, one per doc
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:alice', 'person', 'Alice', datetime('now'), 1, datetime('now'), 'default')`
    ).run();
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:bob', 'person', 'Bob', datetime('now'), 1, datetime('now'), 'default')`
    ).run();
    store.db.prepare(
      `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
    ).run("default:person:alice", ids[0]!);
    store.db.prepare(
      `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
    ).run("default:person:bob", ids[1]!);

    // Observation texts are word-for-word identical → score = 1.0.
    // Under the previous design this would have passed STRICT 0.98 and
    // merged. Under the hard-reject rule, disjoint canonical entities
    // block the merge regardless of text similarity — the primary
    // safety goal of the extraction.
    const result = passesMergeSafety(
      store,
      "Alice shipped the authentication service last sprint",
      [ids[0]!],
      "Alice shipped the authentication service last sprint",
      [ids[1]!]
    );

    expect(result.method).toBe("entity_aware");
    expect(result.score).toBe(1.0);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("hard reject");
  });

  it("mixed coverage: one side with entities, other without → lexical fallback", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alice shipped the feature" },
      { path: "b.md", title: "B", body: "Alice shipped the feature" },
    ]);

    // Only doc 0 has an entity mention; doc 1 does not
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:alice', 'person', 'Alice', datetime('now'), 1, datetime('now'), 'default')`
    ).run();
    store.db.prepare(
      `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
    ).run("default:person:alice", ids[0]!);

    const result = passesMergeSafety(
      store,
      "Alice shipped the feature",
      [ids[0]!],
      "Alice shipped the feature",
      [ids[1]!]
    );

    // Mixed coverage → lexical fallback (apples-to-apples)
    expect(result.method).toBe("lexical_only");
    expect(result.accepted).toBe(true); // identical text → score 1.0
  });

  it("entity_aware boundary: [alice, shared-service] vs [bob, shared-service] hard-rejects", () => {
    // Primary-subject mismatch with a shared context anchor. Under the
    // previous permissive boundary (`< 0.5`), this was treated as "not
    // materially different" and fell through to NORMAL — exactly the
    // kind of mistake the extraction is supposed to prevent. The new
    // `<= 0.5` boundary + hard-reject rule catches it.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "alice.md", title: "A", body: "Alice on auth-service" },
      { path: "bob.md", title: "B", body: "Bob on auth-service" },
    ]);

    // Seed two canonical entities per side plus a shared service entity
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:alice', 'person', 'Alice', datetime('now'), 1, datetime('now'), 'default')`
    ).run();
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:person:bob', 'person', 'Bob', datetime('now'), 1, datetime('now'), 'default')`
    ).run();
    store.db.prepare(
      `INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
       VALUES ('default:tech:auth_service', 'service', 'auth-service', datetime('now'), 2, datetime('now'), 'default')`
    ).run();
    store.db.prepare(
      `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
    ).run("default:person:alice", ids[0]!);
    store.db.prepare(
      `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
    ).run("default:tech:auth_service", ids[0]!);
    store.db.prepare(
      `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
    ).run("default:person:bob", ids[1]!);
    store.db.prepare(
      `INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, NULL, datetime('now'))`
    ).run("default:tech:auth_service", ids[1]!);

    const result = passesMergeSafety(
      store,
      "Alice rolled the auth-service to production",
      [ids[0]!],
      "Bob rolled the auth-service to production",
      [ids[1]!]
    );

    expect(result.method).toBe("entity_aware");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("hard reject");
  });

  it("lexical_only: no-proper-noun text falls to strictest_default path", () => {
    // All-lowercase, no capitalized tokens — `extractSubjectAnchorsLexical`
    // returns the empty set for both sides, which routes to the
    // strictest-default branch (requires text score >= STRICT 0.98).
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const result = passesMergeSafety(
      store,
      "the migration finished without any incidents",
      [ids[0]!],
      "the migration finished without any incidents",
      [ids[1]!]
    );

    expect(result.method).toBe("strictest_default");
    expect(result.threshold).toBe(MERGE_SCORE_STRICT);
    expect(result.accepted).toBe(true); // identical → score 1.0
  });

  it("empirical calibration: same-subject near-duplicates clear NORMAL threshold", () => {
    // Calibration data point: a realistic near-duplicate observation
    // pair (trivial punctuation/capitalization difference) should cross
    // the NORMAL threshold in lexical mode. If this test fails after a
    // threshold change, the threshold is too strict for legitimate
    // paraphrases and needs operator tuning via `CLAWMEM_MERGE_SCORE_NORMAL`.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const result = passesMergeSafety(
      store,
      "The Engineering team shipped the OAuth2 migration last Friday without incidents.",
      [ids[0]!],
      "The Engineering team shipped the OAuth2 migration last Friday without incidents",
      [ids[1]!]
    );

    expect(result.method).toBe("lexical_only");
    expect(result.accepted).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(MERGE_SCORE_NORMAL);
  });

  it("empirical calibration: word-reorder paraphrase does NOT clear default NORMAL (3-gram harshness)", () => {
    // Documents the known limitation: 3-gram cosine is harsher than
    // SequenceMatcher on word-reorder paraphrases. This test locks the
    // behavior so operators can see where the gate stands today and
    // decide whether to tune via `CLAWMEM_MERGE_SCORE_NORMAL`.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const result = passesMergeSafety(
      store,
      "The team migrated auth to OAuth2 last Friday",
      [ids[0]!],
      "Last Friday the team completed the auth migration to OAuth2",
      [ids[1]!]
    );

    // Score is substantially lower than 0.93 despite being the same
    // statement in different words. With default thresholds this rejects.
    expect(result.score).toBeLessThan(MERGE_SCORE_NORMAL);
    expect(result.accepted).toBe(false);
  });

  it("env override: CLAWMEM_MERGE_SCORE_NORMAL lowers the threshold at runtime", async () => {
    // The exported constants are captured at module load, so this test
    // reads the default value and verifies that parseEnvFloat accepts a
    // valid override without regressing on invalid inputs.
    process.env.CLAWMEM_MERGE_SCORE_NORMAL = "0.75";
    try {
      // Re-import the module to pick up the env override
      const mod = await import("../../src/text-similarity.ts?t=" + Date.now());
      expect(mod.MERGE_SCORE_NORMAL).toBe(0.75);
    } finally {
      delete process.env.CLAWMEM_MERGE_SCORE_NORMAL;
    }
  });

  it("env override: invalid CLAWMEM_MERGE_SCORE_NORMAL falls back to default", async () => {
    process.env.CLAWMEM_MERGE_SCORE_NORMAL = "not-a-number";
    try {
      const mod = await import("../../src/text-similarity.ts?t=" + Date.now());
      expect(mod.MERGE_SCORE_NORMAL).toBe(0.93);
    } finally {
      delete process.env.CLAWMEM_MERGE_SCORE_NORMAL;
    }
  });

  it("known caveat: lexical_only hard-rejects legitimate alias variants (Bob vs Robert)", () => {
    // Intentional behavior for the v0.7.1 safety release: when
    // entity enrichment is absent, the gate treats `Bob` and `Robert`
    // as materially different anchors and hard-rejects the merge. This
    // fragments cases where a doc mentions a person by a nickname vs
    // formal name, but it is the safe trade-off — the alternative
    // (fuzzy lexical alias matching) would risk merging across true
    // primary-subject differences.
    //
    // Once entity enrichment covers both docs, the `entity_aware` path
    // uses canonical entity IDs which handle alias resolution via
    // `resolveEntityCanonical` in `src/entity.ts:245`.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const result = passesMergeSafety(
      store,
      "Bob shipped the authentication service last sprint",
      [ids[0]!],
      "Robert shipped the authentication service last sprint",
      [ids[1]!]
    );

    expect(result.method).toBe("lexical_only");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("hard reject");
  });

  it("known caveat: lexical_only hard-rejects Postgres vs PostgreSQL alias", () => {
    // Same known caveat: when both sides lack entity enrichment, the
    // lexical anchor extractor treats `Postgres` and `PostgreSQL` as
    // materially different and hard-rejects the merge. Entity-aware
    // mode would handle this via canonical resolution.
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    const result = passesMergeSafety(
      store,
      "Postgres migration completed on Friday",
      [ids[0]!],
      "PostgreSQL migration completed on Friday",
      [ids[1]!]
    );

    expect(result.method).toBe("lexical_only");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("hard reject");
  });
});
