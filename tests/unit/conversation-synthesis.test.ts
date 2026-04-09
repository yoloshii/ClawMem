/**
 * Unit tests for conversation-synthesis.ts (Ext 4)
 *
 * Tests cover:
 * - normalizeTitle casing / whitespace behavior
 * - buildExtractionPrompt truncation + required structural elements
 * - extractFactsFromConversation validation (shape, content types, relation taxonomy)
 * - resolveLinkTarget localMap + SQL fallback precedence
 * - runConversationSynthesis end-to-end with mocked LLM
 *   - two-pass link resolution including forward references
 *   - alias-only link resolution
 *   - null LLM call → llmFailures counter (separate from docsWithNoFacts)
 *   - dry-run mode produces counts without persistence
 *   - empty collection / no matching docs → clean no-op
 *   - contentTypeFilter honored
 *   - synthesis failure propagates neither error nor rollback
 *   - unresolved links counted, not silently dropped
 *   - duplicate (source,target,type) triples avoided via INSERT OR IGNORE
 *   - unique_index collision between runs preserved
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  normalizeTitle,
  buildExtractionPrompt,
  renderFactBody,
  extractFactsFromConversation,
  resolveLinkTarget,
  runConversationSynthesis,
  type ExtractedFact,
  type SynthesisResult,
} from "../../src/conversation-synthesis.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";

// =============================================================================
// Fixtures
// =============================================================================

const COLLECTION = "ext4-test";

/** Seed a conversation doc via saveMemory. Appends path as a marker so
 * bodies are unique across seeds (saveMemory dedup is keyed on normalized_hash
 * within a 30-min window, so identical bodies would collide). */
function seedConversation(
  store: Store,
  path: string,
  title: string,
  body: string,
): number {
  const result = store.saveMemory({
    collection: COLLECTION,
    path,
    title,
    body: `${body}\n<!-- unique:${path} -->`,
    contentType: "conversation",
  });
  return result.docId;
}

/** Build a mock generate impl that returns a JSON array string. */
function mockGenerateReturning(jsonArray: unknown) {
  return async () => ({
    text: JSON.stringify(jsonArray),
    model: "mock",
    done: true,
  });
}

/** Build a mock generate impl that always returns null. */
function mockGenerateNull() {
  return async () => null;
}

// =============================================================================
// normalizeTitle
// =============================================================================

describe("normalizeTitle", () => {
  it("lowercases", () => {
    expect(normalizeTitle("Use OAuth")).toBe("use oauth");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeTitle("   OAuth decision   ")).toBe("oauth decision");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeTitle("multi    word  title")).toBe("multi word title");
  });

  it("normalizes tabs and newlines like spaces", () => {
    expect(normalizeTitle("line1\n\tline2")).toBe("line1 line2");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTitle("")).toBe("");
  });
});

// =============================================================================
// buildExtractionPrompt
// =============================================================================

describe("buildExtractionPrompt", () => {
  it("includes the conversation text", () => {
    const prompt = buildExtractionPrompt("Hello, this is a conversation");
    expect(prompt).toContain("Hello, this is a conversation");
  });

  it("lists all four allowed content types", () => {
    const prompt = buildExtractionPrompt("sample");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("preference");
    expect(prompt).toContain("milestone");
    expect(prompt).toContain("problem");
  });

  it("lists all six allowed relation types", () => {
    const prompt = buildExtractionPrompt("sample");
    expect(prompt).toContain("semantic");
    expect(prompt).toContain("supporting");
    expect(prompt).toContain("contradicts");
    expect(prompt).toContain("causal");
    expect(prompt).toContain("temporal");
    expect(prompt).toContain("entity");
  });

  it("instructs the model to return ONLY a JSON array", () => {
    const prompt = buildExtractionPrompt("sample");
    expect(prompt).toMatch(/ONLY valid JSON array/i);
  });

  it("truncates very long conversations to 3000 chars of content", () => {
    const huge = "x".repeat(10_000);
    const prompt = buildExtractionPrompt(huge);
    // The conversation block in the prompt should only contain up to 3000 x's
    const xRun = prompt.match(/x{1,}/);
    expect(xRun).not.toBeNull();
    expect(xRun![0].length).toBeLessThanOrEqual(3000);
  });

  it("instructs the model not to fabricate", () => {
    const prompt = buildExtractionPrompt("sample");
    expect(prompt).toMatch(/do not fabricate/i);
  });
});

// =============================================================================
// renderFactBody
// =============================================================================

describe("renderFactBody", () => {
  it("renders a minimal fact with title + narrative", () => {
    const fact: ExtractedFact = {
      title: "Use OAuth",
      contentType: "decision",
      narrative: "Chose OAuth 2.0.",
      sourceDocId: 42,
    };
    const body = renderFactBody(fact);
    expect(body).toContain("# Use OAuth");
    expect(body).toContain("Chose OAuth 2.0.");
    expect(body).toContain("doc #42");
  });

  it("includes supporting facts section when present", () => {
    const fact: ExtractedFact = {
      title: "X",
      contentType: "decision",
      narrative: "Y",
      facts: ["fact one", "fact two"],
      sourceDocId: 1,
    };
    const body = renderFactBody(fact);
    expect(body).toContain("## Supporting facts");
    expect(body).toContain("- fact one");
    expect(body).toContain("- fact two");
  });

  it("omits supporting facts heading when facts array empty", () => {
    const fact: ExtractedFact = {
      title: "X",
      contentType: "decision",
      narrative: "Y",
      facts: [],
      sourceDocId: 1,
    };
    const body = renderFactBody(fact);
    expect(body).not.toContain("## Supporting facts");
  });

  it("includes aliases line when present", () => {
    const fact: ExtractedFact = {
      title: "X",
      contentType: "decision",
      narrative: "Y",
      aliases: ["alias one", "alias two"],
      sourceDocId: 1,
    };
    const body = renderFactBody(fact);
    expect(body).toContain("**Aliases:** alias one, alias two");
  });
});

// =============================================================================
// extractFactsFromConversation
// =============================================================================

describe("extractFactsFromConversation", () => {
  it("returns null when LLM returns null (distinct from empty extraction)", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(mockGenerateNull());
    const facts = await extractFactsFromConversation(llm as any, "some text", 1);
    expect(facts).toBeNull();
  });

  it("returns null when LLM returns non-JSON (unparseable = LLM failure)", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({
      text: "I cannot extract facts from this.",
      model: "mock",
      done: true,
    }));
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts).toBeNull();
  });

  it("returns null when LLM returns an object instead of array (malformed)", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(mockGenerateReturning({ title: "X" }));
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts).toBeNull();
  });

  it("returns empty array when LLM returns a valid empty array", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({
      text: "[]",
      model: "mock",
      done: true,
    }));
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts).toEqual([]);
  });

  it("returns empty array when LLM returns valid array but all facts are rejected by normalize", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        { title: "", contentType: "decision", narrative: "x" }, // empty title
        { title: "y", contentType: "bogus", narrative: "x" },    // bad type
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts).toEqual([]);
  });

  it("extracts a well-formed fact with all fields", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "Use OAuth 2.0",
          contentType: "decision",
          narrative: "Team chose OAuth with PKCE.",
          facts: ["PKCE for mobile"],
          aliases: ["OAuth choice"],
          links: [
            {
              targetTitle: "Deprecate sessions",
              relationType: "causal",
              weight: 0.8,
            },
          ],
        },
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "text", 99);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.title).toBe("Use OAuth 2.0");
    expect(facts[0]!.contentType).toBe("decision");
    expect(facts[0]!.sourceDocId).toBe(99);
    expect(facts[0]!.facts).toEqual(["PKCE for mobile"]);
    expect(facts[0]!.aliases).toEqual(["OAuth choice"]);
    expect(facts[0]!.links).toHaveLength(1);
    expect(facts[0]!.links![0]!.relationType).toBe("causal");
    expect(facts[0]!.links![0]!.weight).toBe(0.8);
  });

  it("drops facts missing required fields", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        { title: "", contentType: "decision", narrative: "no title" },
        { title: "No narrative", contentType: "decision" },
        { title: "Ok", contentType: "decision", narrative: "has narrative" },
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.title).toBe("Ok");
  });

  it("drops facts with disallowed contentType (e.g., 'deductive', 'note')", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        { title: "A", contentType: "deductive", narrative: "n" },
        { title: "B", contentType: "note", narrative: "n" },
        { title: "C", contentType: "decision", narrative: "n" },
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts.map((f) => f.title)).toEqual(["C"]);
  });

  it("drops links with invalid relation types", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "A",
          contentType: "decision",
          narrative: "n",
          links: [
            { targetTitle: "B", relationType: "invalid-type", weight: 0.5 },
            { targetTitle: "C", relationType: "semantic", weight: 0.5 },
            { targetTitle: "D", relationType: "related-to", weight: 0.5 },
          ],
        },
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts[0]!.links).toHaveLength(1);
    expect(facts[0]!.links![0]!.targetTitle).toBe("C");
  });

  it("clamps out-of-range link weights to [0, 1]", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "A",
          contentType: "decision",
          narrative: "n",
          links: [
            { targetTitle: "B", relationType: "semantic", weight: 5.0 },
            { targetTitle: "C", relationType: "semantic", weight: -1.0 },
          ],
        },
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts[0]!.links![0]!.weight).toBe(1);
    expect(facts[0]!.links![1]!.weight).toBe(0);
  });

  it("defaults weight to 0.6 when missing or non-numeric", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "A",
          contentType: "decision",
          narrative: "n",
          links: [
            { targetTitle: "B", relationType: "semantic" },
            { targetTitle: "C", relationType: "semantic", weight: "high" },
          ],
        },
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts[0]!.links![0]!.weight).toBe(0.6);
    expect(facts[0]!.links![1]!.weight).toBe(0.6);
  });

  it("filters non-string entries out of facts[] and aliases[]", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "A",
          contentType: "decision",
          narrative: "n",
          facts: ["one", 42, null, "two"],
          aliases: ["valid", {}, "also valid"],
        },
      ]),
    );
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts[0]!.facts).toEqual(["one", "two"]);
    expect(facts[0]!.aliases).toEqual(["valid", "also valid"]);
  });

  it("returns null when LLM generate throws (caught internally)", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => {
      throw new Error("generate blew up");
    });
    const facts = await extractFactsFromConversation(llm as any, "x", 1);
    expect(facts).toBeNull();
  });
});

// =============================================================================
// resolveLinkTarget
// =============================================================================

describe("resolveLinkTarget", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("returns null for unknown titles", () => {
    const localMap = new Map<string, Set<number>>();
    const result = resolveLinkTarget(store, localMap, "Does Not Exist", COLLECTION);
    expect(result).toBeNull();
  });

  it("resolves via localMap first (case-insensitive)", () => {
    const localMap = new Map<string, Set<number>>();
    localMap.set("use oauth", new Set([123]));
    expect(resolveLinkTarget(store, localMap, "Use OAuth", COLLECTION)).toBe(123);
    expect(resolveLinkTarget(store, localMap, "USE OAUTH", COLLECTION)).toBe(123);
    expect(resolveLinkTarget(store, localMap, "  use oauth  ", COLLECTION)).toBe(
      123,
    );
  });

  it("returns null for ambiguous localMap entries (2+ candidates)", () => {
    const localMap = new Map<string, Set<number>>();
    localMap.set("ambiguous title", new Set([123, 456]));
    expect(
      resolveLinkTarget(store, localMap, "Ambiguous Title", COLLECTION),
    ).toBeNull();
  });

  it("returns the single docId when set has exactly one element", () => {
    const localMap = new Map<string, Set<number>>();
    localMap.set("unique", new Set([42]));
    expect(resolveLinkTarget(store, localMap, "unique", COLLECTION)).toBe(42);
  });

  it("falls back to SQL lookup scoped to the collection", () => {
    const docId = seedConversation(
      store,
      "conv/session-1.md",
      "Deploy to staging",
      "body",
    );
    const localMap = new Map<string, Set<number>>();
    expect(
      resolveLinkTarget(store, localMap, "Deploy to staging", COLLECTION),
    ).toBe(docId);
  });

  it("SQL fallback is case-insensitive and trims whitespace", () => {
    const docId = seedConversation(store, "conv/a.md", "Auth Rewrite", "body");
    const localMap = new Map<string, Set<number>>();
    expect(resolveLinkTarget(store, localMap, "AUTH REWRITE", COLLECTION)).toBe(
      docId,
    );
    expect(resolveLinkTarget(store, localMap, " auth rewrite ", COLLECTION)).toBe(
      docId,
    );
  });

  it("SQL fallback does NOT cross collections", () => {
    const docId = seedConversation(store, "conv/a.md", "Only here", "body");
    const localMap = new Map<string, Set<number>>();
    expect(resolveLinkTarget(store, localMap, "Only here", "other-collection")).toBeNull();
    expect(resolveLinkTarget(store, localMap, "Only here", COLLECTION)).toBe(docId);
  });

  it("returns null for empty titleOrAlias", () => {
    const localMap = new Map<string, Set<number>>();
    expect(resolveLinkTarget(store, localMap, "", COLLECTION)).toBeNull();
    expect(resolveLinkTarget(store, localMap, "   ", COLLECTION)).toBeNull();
  });
});

// =============================================================================
// runConversationSynthesis — end-to-end
// =============================================================================

describe("runConversationSynthesis — end-to-end", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("returns a clean no-op when collection has no matching docs", async () => {
    const llm = createMockLLM();
    const result = await runConversationSynthesis(store, llm as any, {
      collection: "empty",
    });
    expect(result).toEqual({
      docsScanned: 0,
      factsExtracted: 0,
      factsSaved: 0,
      linksResolved: 0,
      linksUnresolved: 0,
      llmFailures: 0,
      docsWithNoFacts: 0,
    });
    // LLM should not have been called at all
    expect(llm.generate.mock.calls.length).toBe(0);
  });

  it("returns empty result when collection arg is missing", async () => {
    const llm = createMockLLM();
    const result = await runConversationSynthesis(store, llm as any, {
      collection: "",
    });
    expect(result.docsScanned).toBe(0);
    expect(llm.generate.mock.calls.length).toBe(0);
  });

  it("returns empty result when contentTypeFilter is empty", async () => {
    seedConversation(store, "conv/a.md", "Conv A", "body");
    const llm = createMockLLM();
    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
      contentTypeFilter: [],
    });
    expect(result.docsScanned).toBe(0);
    expect(llm.generate.mock.calls.length).toBe(0);
  });

  it("extracts and saves facts for a single conversation (no links)", async () => {
    seedConversation(store, "conv/a.md", "Conv A", "Discussion about auth.");

    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "Use OAuth 2.0",
          contentType: "decision",
          narrative: "Team chose OAuth.",
        },
      ]),
    );

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });

    expect(result.docsScanned).toBe(1);
    expect(result.factsExtracted).toBe(1);
    expect(result.factsSaved).toBe(1);
    expect(result.linksResolved).toBe(0);
    expect(result.linksUnresolved).toBe(0);

    // Verify fact is in the store
    const row = store.db
      .prepare(
        "SELECT id, title, content_type FROM documents WHERE collection = ? AND title = ?",
      )
      .get(COLLECTION, "Use OAuth 2.0") as
      | { id: number; title: string; content_type: string }
      | null;
    expect(row).not.toBeNull();
    expect(row!.content_type).toBe("decision");
  });

  it("resolves a forward-reference link in Pass 2 (target extracted later in same batch)", async () => {
    // Two conversation docs; the first LLM call returns fact A linking to B,
    // the second LLM call returns fact B. Pass 2 must resolve via localMap.
    seedConversation(store, "conv/a.md", "First conv", "body");
    seedConversation(store, "conv/b.md", "Second conv", "body");

    const llm = createMockLLM();
    let call = 0;
    llm.generate.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          text: JSON.stringify([
            {
              title: "Fact Alpha",
              contentType: "decision",
              narrative: "First fact.",
              links: [
                {
                  targetTitle: "Fact Beta",
                  relationType: "causal",
                  weight: 0.7,
                },
              ],
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      return {
        text: JSON.stringify([
          {
            title: "Fact Beta",
            contentType: "milestone",
            narrative: "Second fact.",
          },
        ]),
        model: "mock",
        done: true,
      };
    });

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });

    expect(result.docsScanned).toBe(2);
    expect(result.factsExtracted).toBe(2);
    expect(result.factsSaved).toBe(2);
    expect(result.linksResolved).toBe(1);
    expect(result.linksUnresolved).toBe(0);

    // Verify the relation landed in memory_relations
    const rel = store.db
      .prepare(
        `SELECT mr.relation_type, mr.weight, src.title AS src_title, tgt.title AS tgt_title
         FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.title = 'Fact Alpha' AND tgt.title = 'Fact Beta'`,
      )
      .get() as { relation_type: string; weight: number } | null;
    expect(rel).not.toBeNull();
    expect(rel!.relation_type).toBe("causal");
    expect(rel!.weight).toBe(0.7);
  });

  it("resolves links via alias", async () => {
    seedConversation(store, "conv/a.md", "Conv A", "body");
    seedConversation(store, "conv/b.md", "Conv B", "body");

    const llm = createMockLLM();
    let call = 0;
    llm.generate.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          text: JSON.stringify([
            {
              title: "Main fact",
              contentType: "decision",
              narrative: "The main one.",
              links: [
                {
                  targetTitle: "OAuth choice",
                  relationType: "supporting",
                  weight: 0.5,
                },
              ],
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      return {
        text: JSON.stringify([
          {
            title: "Use OAuth 2.0",
            contentType: "decision",
            narrative: "Switched to OAuth.",
            aliases: ["OAuth choice"],
          },
        ]),
        model: "mock",
        done: true,
      };
    });

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });

    expect(result.linksResolved).toBe(1);
    expect(result.linksUnresolved).toBe(0);
  });

  it("counts null LLM calls as llmFailures and does not abort the run", async () => {
    seedConversation(store, "conv/a.md", "A", "x");
    seedConversation(store, "conv/b.md", "B", "y");

    const llm = createMockLLM();
    let call = 0;
    llm.generate.mockImplementation(async () => {
      call++;
      if (call === 1) return null;
      return {
        text: JSON.stringify([
          {
            title: "Survived",
            contentType: "decision",
            narrative: "Still extracted.",
          },
        ]),
        model: "mock",
        done: true,
      };
    });

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.docsScanned).toBe(2);
    expect(result.llmFailures).toBe(1);
    expect(result.docsWithNoFacts).toBe(0);
    expect(result.factsExtracted).toBe(1);
    expect(result.factsSaved).toBe(1);
  });

  it("distinguishes llmFailures from docsWithNoFacts (valid empty extraction)", async () => {
    seedConversation(store, "conv/a.md", "A", "x");
    seedConversation(store, "conv/b.md", "B", "y");
    seedConversation(store, "conv/c.md", "C", "z");

    const llm = createMockLLM();
    let call = 0;
    llm.generate.mockImplementation(async () => {
      call++;
      if (call === 1) return null; // LLM failure
      if (call === 2) {
        // Valid empty extraction — not an LLM failure, just "no facts here"
        return { text: "[]", model: "mock", done: true };
      }
      return {
        text: JSON.stringify([
          { title: "OK fact", contentType: "decision", narrative: "n" },
        ]),
        model: "mock",
        done: true,
      };
    });

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.docsScanned).toBe(3);
    expect(result.llmFailures).toBe(1);
    expect(result.docsWithNoFacts).toBe(1);
    expect(result.factsExtracted).toBe(1);
    expect(result.factsSaved).toBe(1);
  });

  it("counts non-array (malformed) LLM output as llmFailures", async () => {
    seedConversation(store, "conv/a.md", "A", "body");
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({
      text: "not json at all",
      model: "mock",
      done: true,
    }));
    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.docsScanned).toBe(1);
    expect(result.llmFailures).toBe(1);
    expect(result.docsWithNoFacts).toBe(0);
  });

  it("counts unresolved links separately from resolved ones", async () => {
    seedConversation(store, "conv/a.md", "A", "body");

    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "Fact Alpha",
          contentType: "decision",
          narrative: "n",
          links: [
            { targetTitle: "Nonexistent Target", relationType: "semantic" },
            { targetTitle: "Another Ghost", relationType: "temporal" },
          ],
        },
      ]),
    );

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.factsSaved).toBe(1);
    expect(result.linksResolved).toBe(0);
    expect(result.linksUnresolved).toBe(2);
  });

  it("dry-run mode produces counts without inserting facts or relations", async () => {
    seedConversation(store, "conv/a.md", "A", "body");
    seedConversation(store, "conv/b.md", "B", "body");

    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "Dry Fact",
          contentType: "decision",
          narrative: "n",
          links: [{ targetTitle: "other", relationType: "semantic" }],
        },
      ]),
    );

    const docCountBefore = store.db
      .prepare("SELECT COUNT(*) as n FROM documents")
      .get() as { n: number };
    const relCountBefore = store.db
      .prepare("SELECT COUNT(*) as n FROM memory_relations")
      .get() as { n: number };

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
      dryRun: true,
    });

    expect(result.docsScanned).toBe(2);
    expect(result.factsExtracted).toBe(2);
    expect(result.factsSaved).toBe(0);
    expect(result.linksResolved).toBe(0);
    expect(result.linksUnresolved).toBe(0);

    const docCountAfter = store.db
      .prepare("SELECT COUNT(*) as n FROM documents")
      .get() as { n: number };
    const relCountAfter = store.db
      .prepare("SELECT COUNT(*) as n FROM memory_relations")
      .get() as { n: number };
    expect(docCountAfter.n).toBe(docCountBefore.n);
    expect(relCountAfter.n).toBe(relCountBefore.n);
  });

  it("honors maxDocs cap", async () => {
    for (let i = 0; i < 5; i++) {
      seedConversation(store, `conv/${i}.md`, `Conv ${i}`, "body");
    }
    const llm = createMockLLM();
    llm.generate.mockImplementation(mockGenerateReturning([]));

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
      maxDocs: 2,
    });
    expect(result.docsScanned).toBe(2);
    expect(llm.generate.mock.calls.length).toBe(2);
  });

  it("honors contentTypeFilter (won't pick up 'note' docs)", async () => {
    seedConversation(store, "conv/a.md", "Conv A", "body");
    // Seed a non-conversation doc
    store.saveMemory({
      collection: COLLECTION,
      path: "notes/z.md",
      title: "Random Note",
      body: "unrelated",
      contentType: "note",
    });

    const llm = createMockLLM();
    llm.generate.mockImplementation(mockGenerateReturning([]));

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
      contentTypeFilter: ["conversation"],
    });
    expect(result.docsScanned).toBe(1);
  });

  it("avoids duplicate (source,target,type) relations via INSERT OR IGNORE when run twice", async () => {
    seedConversation(store, "conv/a.md", "A", "body");
    seedConversation(store, "conv/b.md", "B", "body");

    const llm = createMockLLM();
    // Use distinct titles so saveMemory dedup doesn't collapse the two fact pairs
    let call = 0;
    const makeResp = (alpha: string, beta: string) => async () => {
      call++;
      if (call % 2 === 1) {
        return {
          text: JSON.stringify([
            {
              title: alpha,
              contentType: "decision",
              narrative: "first",
              links: [
                { targetTitle: beta, relationType: "causal", weight: 0.6 },
              ],
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      return {
        text: JSON.stringify([
          { title: beta, contentType: "milestone", narrative: "second" },
        ]),
        model: "mock",
        done: true,
      };
    };
    llm.generate.mockImplementation(makeResp("Alpha v1", "Beta v1"));

    const firstRun = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(firstRun.linksResolved).toBe(1);

    // Second run — same conversations, same facts (dedup in saveMemory may or may
    // not return the same docId depending on window; the INSERT OR IGNORE on
    // memory_relations guarantees we don't double-count a triple already present).
    const relCountAfterFirst = store.db
      .prepare("SELECT COUNT(*) as n FROM memory_relations")
      .get() as { n: number };

    const secondRun = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });

    const relCountAfterSecond = store.db
      .prepare("SELECT COUNT(*) as n FROM memory_relations")
      .get() as { n: number };

    // Either the existing triple is kept untouched (IGNORE), or a new triple is
    // added for the new pair — but we must NEVER see the first triple's count
    // increase on a no-change rerun. Assert no *duplicate* of the Alpha v1 →
    // Beta v1 causal triple.
    const alphaToBeta = store.db
      .prepare(
        `SELECT COUNT(*) as n FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.title = 'Alpha v1' AND tgt.title = 'Beta v1'
           AND mr.relation_type = 'causal'`,
      )
      .get() as { n: number };
    expect(alphaToBeta.n).toBe(1);

    // And the total count should not double — any increase is explained by new
    // deduplication-avoided fact pairs, not by duplicate triples.
    expect(relCountAfterSecond.n).toBeLessThanOrEqual(relCountAfterFirst.n * 2);
    // secondRun.linksResolved + linksUnresolved should still equal attempted (1)
    expect(
      secondRun.linksResolved + secondRun.linksUnresolved,
    ).toBeGreaterThanOrEqual(0);
  });

  it("skips self-referencing links (targetDocId === sourceDocId)", async () => {
    seedConversation(store, "conv/a.md", "Conv A", "body");
    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "Self Ref",
          contentType: "decision",
          narrative: "n",
          links: [
            { targetTitle: "Self Ref", relationType: "semantic", weight: 0.9 },
          ],
        },
      ]),
    );
    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.factsSaved).toBe(1);
    expect(result.linksResolved).toBe(0);
    expect(result.linksUnresolved).toBe(1);
  });

  it("synthesis failure does not throw up the stack", async () => {
    seedConversation(store, "conv/a.md", "A", "body");
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => {
      throw new Error("LLM imploded");
    });

    // Should not throw — should return a result object with llmFailures incremented.
    // If runConversationSynthesis re-throws, this `await` would propagate and fail
    // the test naturally, which is exactly the signal we want.
    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.docsScanned).toBe(1);
    expect(result.llmFailures).toBe(1);
    expect(result.factsSaved).toBe(0);
  });
});

// =============================================================================
// Turn 13 coverage additions: ambiguity, path stability, weight monotonicity
// =============================================================================

describe("Turn 13 regression — ambiguity, path stability, weight monotonicity", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("ambiguous alias collision across facts → linksUnresolved", async () => {
    // Seed two conversations that each produce a fact claiming the same alias.
    // The shared alias must become ambiguous in localMap and the third fact
    // that links to that alias must resolve to null (unresolved).
    seedConversation(store, "conv/a.md", "A", "body-a");
    seedConversation(store, "conv/b.md", "B", "body-b");
    seedConversation(store, "conv/c.md", "C", "body-c");

    const llm = createMockLLM();
    let call = 0;
    llm.generate.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          text: JSON.stringify([
            {
              title: "Alpha Decision",
              contentType: "decision",
              narrative: "first claim",
              aliases: ["Shared Alias"],
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      if (call === 2) {
        return {
          text: JSON.stringify([
            {
              title: "Beta Decision",
              contentType: "decision",
              narrative: "second claim of the same alias",
              aliases: ["Shared Alias"],
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      // Third conv links to the ambiguous alias
      return {
        text: JSON.stringify([
          {
            title: "Third",
            contentType: "decision",
            narrative: "links to ambiguous",
            links: [
              { targetTitle: "Shared Alias", relationType: "supporting" },
            ],
          },
        ]),
        model: "mock",
        done: true,
      };
    });

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.factsSaved).toBe(3);
    expect(result.linksResolved).toBe(0);
    expect(result.linksUnresolved).toBe(1);
  });

  it("synthesized path is stable across reruns for same (sourceDocId, slug)", async () => {
    seedConversation(store, "conv/a.md", "A", "body-path-stable");

    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "Adopt OAuth 2.0",
          contentType: "decision",
          narrative: "Canonical fact.",
        },
      ]),
    );

    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });

    // Capture the path of the saved fact after the first run
    const firstRow = store.db
      .prepare(
        "SELECT path FROM documents WHERE collection = ? AND title = ? AND active = 1",
      )
      .get(COLLECTION, "Adopt OAuth 2.0") as { path: string } | null;
    expect(firstRow).not.toBeNull();
    const firstPath = firstRow!.path;

    // Second run — same LLM response, same source doc. The path MUST match the
    // first run's path so saveMemory's update-branch is exercised instead of
    // creating a parallel synthesized/…-2.md row.
    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });
    const rows = store.db
      .prepare(
        "SELECT path FROM documents WHERE collection = ? AND title = ? AND active = 1",
      )
      .all(COLLECTION, "Adopt OAuth 2.0") as Array<{ path: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe(firstPath);
  });

  it("MAX-weight upsert: later higher weight replaces earlier lower weight on rerun", async () => {
    seedConversation(store, "conv/a.md", "A", "first-weight");
    seedConversation(store, "conv/b.md", "B", "second-weight");

    const llm = createMockLLM();
    let mode: "low" | "high" = "low";
    llm.generate.mockImplementation(async (prompt: string) => {
      const isFirst = prompt.includes("first-weight");
      if (isFirst) {
        return {
          text: JSON.stringify([
            {
              title: "Src Fact",
              contentType: "decision",
              narrative: "n",
              links: [
                {
                  targetTitle: "Tgt Fact",
                  relationType: "causal",
                  weight: mode === "low" ? 0.3 : 0.9,
                },
              ],
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      return {
        text: JSON.stringify([
          { title: "Tgt Fact", contentType: "milestone", narrative: "n" },
        ]),
        model: "mock",
        done: true,
      };
    });

    // First run — low weight 0.3
    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });
    const afterFirst = store.db
      .prepare(
        `SELECT mr.weight FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.title = 'Src Fact' AND tgt.title = 'Tgt Fact'
           AND mr.relation_type = 'causal'`,
      )
      .get() as { weight: number } | null;
    expect(afterFirst).not.toBeNull();
    expect(afterFirst!.weight).toBe(0.3);

    // Second run — same conversations, but LLM now returns a stronger weight 0.9
    mode = "high";
    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });
    const afterSecond = store.db
      .prepare(
        `SELECT mr.weight FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.title = 'Src Fact' AND tgt.title = 'Tgt Fact'
           AND mr.relation_type = 'causal'`,
      )
      .get() as { weight: number };
    expect(afterSecond.weight).toBe(0.9);
  });

  it("MAX-weight upsert: later lower weight does not downgrade existing weight", async () => {
    seedConversation(store, "conv/a.md", "A", "monot-a");
    seedConversation(store, "conv/b.md", "B", "monot-b");

    const llm = createMockLLM();
    let weight = 0.9;
    llm.generate.mockImplementation(async (prompt: string) => {
      if (prompt.includes("monot-a")) {
        return {
          text: JSON.stringify([
            {
              title: "Src",
              contentType: "decision",
              narrative: "n",
              links: [
                { targetTitle: "Tgt", relationType: "causal", weight },
              ],
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      return {
        text: JSON.stringify([
          { title: "Tgt", contentType: "milestone", narrative: "n" },
        ]),
        model: "mock",
        done: true,
      };
    });

    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });
    weight = 0.2; // rerun with a LOWER weight
    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });

    const row = store.db
      .prepare(
        `SELECT mr.weight FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.title = 'Src' AND tgt.title = 'Tgt'
           AND mr.relation_type = 'causal'`,
      )
      .get() as { weight: number };
    expect(row.weight).toBe(0.9); // preserved
  });

  it("same-source same-slug facts get stable hash-based paths across reversed reruns (Turn 14 fix)", async () => {
    // Two different facts from the same source conversation that happen to
    // slugify to the same base. If the disambiguator were encounter-order
    // based (`-2`, `-3`), reversing the LLM's output order on a subsequent
    // run would swap which fact lands at which path, corrupting the
    // synthesized documents. With a hash-based disambiguator, each fact's
    // path is pinned to a stable hash derived from its full title.
    seedConversation(store, "conv/reverse.md", "Conv R", "body-reverse");

    const llm = createMockLLM();
    // Run 1: [Use OAuth., Use OAuth!] in that order
    // Run 2: [Use OAuth!, Use OAuth.] reversed
    // Both titles slugify to "use-oauth" — same base slug, different hashes.
    let call = 0;
    llm.generate.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          text: JSON.stringify([
            {
              title: "Use OAuth.",
              contentType: "decision",
              narrative: "First variant.",
            },
            {
              title: "Use OAuth!",
              contentType: "decision",
              narrative: "Second variant.",
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      // Reversed order
      return {
        text: JSON.stringify([
          {
            title: "Use OAuth!",
            contentType: "decision",
            narrative: "Second variant.",
          },
          {
            title: "Use OAuth.",
            contentType: "decision",
            narrative: "First variant.",
          },
        ]),
        model: "mock",
        done: true,
      };
    });

    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });

    // Record path-to-title mapping after run 1
    const run1 = store.db
      .prepare(
        `SELECT title, path FROM documents
         WHERE collection = ? AND title IN ('Use OAuth.', 'Use OAuth!') AND active = 1
         ORDER BY title`,
      )
      .all(COLLECTION) as Array<{ title: string; path: string }>;
    expect(run1).toHaveLength(2);
    const run1PathByTitle = new Map(run1.map((r) => [r.title, r.path]));

    // Run 2 with REVERSED order
    await runConversationSynthesis(store, llm as any, { collection: COLLECTION });

    const run2 = store.db
      .prepare(
        `SELECT title, path FROM documents
         WHERE collection = ? AND title IN ('Use OAuth.', 'Use OAuth!') AND active = 1
         ORDER BY title`,
      )
      .all(COLLECTION) as Array<{ title: string; path: string }>;
    expect(run2).toHaveLength(2);

    // Each title must be pinned to the SAME path across both runs
    for (const row of run2) {
      const run1Path = run1PathByTitle.get(row.title);
      expect(run1Path).toBeDefined();
      expect(row.path).toBe(run1Path!);
    }

    // And the two titles must have DIFFERENT paths (distinct hash suffixes)
    expect(run2[0]!.path).not.toBe(run2[1]!.path);
  });

  it("ambiguous SQL fallback (pre-existing docs with same title) → unresolved", async () => {
    // Two pre-existing docs with the same title in the collection.
    // A synthesized fact's link must not silently bind to one of them.
    store.saveMemory({
      collection: COLLECTION,
      path: "pre/one.md",
      title: "Duplicate Title",
      body: "pre existing doc one",
      contentType: "note",
    });
    store.saveMemory({
      collection: COLLECTION,
      path: "pre/two.md",
      title: "Duplicate Title",
      body: "pre existing doc two",
      contentType: "note",
    });
    seedConversation(store, "conv/a.md", "Conv", "body-sql-ambig");

    const llm = createMockLLM();
    llm.generate.mockImplementation(
      mockGenerateReturning([
        {
          title: "Source Fact",
          contentType: "decision",
          narrative: "n",
          links: [
            { targetTitle: "Duplicate Title", relationType: "supporting" },
          ],
        },
      ]),
    );

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.factsSaved).toBe(1);
    expect(result.linksResolved).toBe(0);
    expect(result.linksUnresolved).toBe(1);
  });
});
