/**
 * Integration test for Ext 4 — post-import conversation synthesis two-pass pipeline.
 *
 * Exercises the full flow against a real in-memory store and a mocked LLM that
 * returns scripted JSON per-doc. Unlike the unit tests, this suite focuses on:
 *
 *  1. A realistic 3-conversation batch producing 4 facts + 3 cross-fact relations
 *  2. Per-doc LLM cost — one generate call per conversation doc
 *  3. Mixed resolved/unresolved links within the same run
 *  4. The mine-preserving contract: synthesis errors must not roll back facts
 *     saved in earlier iterations of the same run
 *  5. The saveMemory dedup window: re-running synthesis over an unchanged
 *     collection should not inflate the fact count and should not create
 *     duplicate relations
 *  6. Boundary case: zero conversations → clean no-op with no state change
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  runConversationSynthesis,
  type SynthesisResult,
} from "../../src/conversation-synthesis.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";

const COLLECTION = "conv-integration";

/** Seed a conversation doc via saveMemory so content_type = conversation. */
function seedConv(store: Store, path: string, title: string, body: string): number {
  const res = store.saveMemory({
    collection: COLLECTION,
    path,
    title,
    body,
    contentType: "conversation",
  });
  return res.docId;
}

/**
 * Script an LLM that returns scripted JSON per conversation doc.
 * The map is keyed by the substring of the conversation body that uniquely
 * identifies it — each LLM call inspects its prompt and returns the matching
 * scripted response.
 */
function scriptedLlm(responses: Record<string, unknown>) {
  const llm = createMockLLM();
  llm.generate.mockImplementation(async (prompt: string) => {
    for (const [marker, payload] of Object.entries(responses)) {
      if (prompt.includes(marker)) {
        return {
          text: JSON.stringify(payload),
          model: "mock",
          done: true,
        };
      }
    }
    return {
      text: "[]",
      model: "mock",
      done: true,
    };
  });
  return llm;
}

describe("Ext 4 — two-pass conversation synthesis integration", () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it("builds a realistic knowledge graph from 3 conversations", async () => {
    seedConv(
      store,
      "conv/001.md",
      "Auth discussion",
      "MARKER_AUTH: Long conversation about replacing session auth with OAuth.",
    );
    seedConv(
      store,
      "conv/002.md",
      "Deploy discussion",
      "MARKER_DEPLOY: Talked about staging deployment timing and the mobile release.",
    );
    seedConv(
      store,
      "conv/003.md",
      "Retrospective",
      "MARKER_RETRO: Retro on the Q2 release — decided to keep the weekly deploy cadence.",
    );

    const llm = scriptedLlm({
      MARKER_AUTH: [
        {
          title: "Adopt OAuth 2.0 with PKCE",
          contentType: "decision",
          narrative:
            "Decided to replace session cookies with OAuth 2.0 + PKCE for all clients.",
          aliases: ["OAuth migration", "OAuth decision"],
          links: [
            {
              targetTitle: "Deprecate session auth",
              relationType: "causal",
              weight: 0.85,
            },
          ],
        },
        {
          title: "Deprecate session auth",
          contentType: "milestone",
          narrative: "Session cookie auth removed by end of Q2.",
        },
      ],
      MARKER_DEPLOY: [
        {
          title: "Staging deploy freeze before release",
          contentType: "preference",
          narrative:
            "Prefer a 24-hour staging freeze before any mobile release push.",
          links: [
            {
              // Alias reference — resolved via localMap from Auth conv
              targetTitle: "OAuth migration",
              relationType: "supporting",
              weight: 0.5,
            },
          ],
        },
      ],
      MARKER_RETRO: [
        {
          title: "Weekly deploy cadence",
          contentType: "preference",
          narrative: "Keep the weekly release cadence for the foreseeable future.",
          links: [
            {
              targetTitle: "Staging deploy freeze before release",
              relationType: "supporting",
              weight: 0.6,
            },
          ],
        },
      ],
    });

    const result: SynthesisResult = await runConversationSynthesis(
      store,
      llm as any,
      { collection: COLLECTION },
    );

    // 3 conversations, 4 facts total, 3 intended links all resolvable
    expect(result.docsScanned).toBe(3);
    expect(result.factsExtracted).toBe(4);
    expect(result.factsSaved).toBe(4);
    expect(result.linksResolved).toBe(3);
    expect(result.linksUnresolved).toBe(0);
    expect(result.llmFailures).toBe(0);
    expect(result.docsWithNoFacts).toBe(0);

    // LLM was called exactly once per conversation doc
    expect(llm.generate.mock.calls.length).toBe(3);

    // Verify the knowledge graph edges landed
    const edges = store.db
      .prepare(
        `SELECT mr.relation_type, mr.weight, src.title AS src, tgt.title AS tgt
         FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.collection = ? AND tgt.collection = ?
         ORDER BY src.title, tgt.title`,
      )
      .all(COLLECTION, COLLECTION) as Array<{
      relation_type: string;
      weight: number;
      src: string;
      tgt: string;
    }>;

    // Drop any pre-existing edges that weren't part of synthesis
    const synthEdges = edges.filter(
      (e) =>
        e.src === "Adopt OAuth 2.0 with PKCE" ||
        e.src === "Staging deploy freeze before release" ||
        e.src === "Weekly deploy cadence",
    );

    expect(synthEdges).toHaveLength(3);
    expect(
      synthEdges.find(
        (e) =>
          e.src === "Adopt OAuth 2.0 with PKCE" &&
          e.tgt === "Deprecate session auth",
      )?.relation_type,
    ).toBe("causal");

    // Alias-resolution edge: deploy freeze → OAuth migration (alias of Adopt OAuth 2.0)
    expect(
      synthEdges.find(
        (e) =>
          e.src === "Staging deploy freeze before release" &&
          e.tgt === "Adopt OAuth 2.0 with PKCE",
      )?.relation_type,
    ).toBe("supporting");

    expect(
      synthEdges.find(
        (e) =>
          e.src === "Weekly deploy cadence" &&
          e.tgt === "Staging deploy freeze before release",
      )?.relation_type,
    ).toBe("supporting");
  });

  it("mixed resolved/unresolved links are counted separately", async () => {
    seedConv(store, "conv/a.md", "A", "MARKER_A: content");
    seedConv(store, "conv/b.md", "B", "MARKER_B: content");

    const llm = scriptedLlm({
      MARKER_A: [
        {
          title: "Real fact",
          contentType: "decision",
          narrative: "n",
          links: [
            { targetTitle: "Other real fact", relationType: "semantic" },
            { targetTitle: "Nonexistent ghost", relationType: "semantic" },
          ],
        },
      ],
      MARKER_B: [
        {
          title: "Other real fact",
          contentType: "milestone",
          narrative: "n",
        },
      ],
    });

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });

    expect(result.factsExtracted).toBe(2);
    expect(result.factsSaved).toBe(2);
    expect(result.linksResolved).toBe(1);
    expect(result.linksUnresolved).toBe(1);
  });

  it("re-running synthesis over the same collection does not create duplicate relations", async () => {
    seedConv(store, "conv/a.md", "A", "MARKER_A: content");
    seedConv(store, "conv/b.md", "B", "MARKER_B: content");

    const llm = scriptedLlm({
      MARKER_A: [
        {
          title: "Fact A",
          contentType: "decision",
          narrative: "n",
          links: [{ targetTitle: "Fact B", relationType: "causal", weight: 0.7 }],
        },
      ],
      MARKER_B: [
        {
          title: "Fact B",
          contentType: "milestone",
          narrative: "n",
        },
      ],
    });

    const first = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(first.linksResolved).toBe(1);

    const beforeSecond = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.title = 'Fact A' AND tgt.title = 'Fact B'
           AND mr.relation_type = 'causal'`,
      )
      .get() as { n: number };
    expect(beforeSecond.n).toBe(1);

    // Second run — same scripted LLM, same conversations
    const second = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(second.docsScanned).toBe(2);

    const afterSecond = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_relations mr
         JOIN documents src ON src.id = mr.source_id
         JOIN documents tgt ON tgt.id = mr.target_id
         WHERE src.title = 'Fact A' AND tgt.title = 'Fact B'
           AND mr.relation_type = 'causal'`,
      )
      .get() as { n: number };

    // The Fact A → Fact B causal triple must not have been duplicated by the rerun
    expect(afterSecond.n).toBe(1);
  });

  it("zero conversations → clean no-op, no state change", async () => {
    const docsBefore = store.db
      .prepare("SELECT COUNT(*) AS n FROM documents")
      .get() as { n: number };
    const relsBefore = store.db
      .prepare("SELECT COUNT(*) AS n FROM memory_relations")
      .get() as { n: number };

    const llm = createMockLLM();
    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
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
    expect(llm.generate.mock.calls.length).toBe(0);

    const docsAfter = store.db
      .prepare("SELECT COUNT(*) AS n FROM documents")
      .get() as { n: number };
    const relsAfter = store.db
      .prepare("SELECT COUNT(*) AS n FROM memory_relations")
      .get() as { n: number };
    expect(docsAfter.n).toBe(docsBefore.n);
    expect(relsAfter.n).toBe(relsBefore.n);
  });

  it("synthesis failure on one doc does not discard facts saved earlier in the same run", async () => {
    seedConv(store, "conv/a.md", "A", "MARKER_OK: good doc");
    seedConv(store, "conv/b.md", "B", "MARKER_BOOM: bad doc");

    const llm = createMockLLM();
    llm.generate.mockImplementation(async (prompt: string) => {
      if (prompt.includes("MARKER_OK")) {
        return {
          text: JSON.stringify([
            {
              title: "Saved early fact",
              contentType: "decision",
              narrative: "Should survive the later failure.",
            },
          ]),
          model: "mock",
          done: true,
        };
      }
      if (prompt.includes("MARKER_BOOM")) {
        throw new Error("LLM failure on second doc");
      }
      return { text: "[]", model: "mock", done: true };
    });

    const result = await runConversationSynthesis(store, llm as any, {
      collection: COLLECTION,
    });
    expect(result.docsScanned).toBe(2);
    expect(result.factsSaved).toBe(1);
    expect(result.llmFailures).toBe(1);
    expect(result.docsWithNoFacts).toBe(0);

    // The "Saved early fact" must still be in the store
    const row = store.db
      .prepare(
        "SELECT id FROM documents WHERE collection = ? AND title = ? AND active = 1",
      )
      .get(COLLECTION, "Saved early fact") as { id: number } | null;
    expect(row).not.toBeNull();
  });
});
