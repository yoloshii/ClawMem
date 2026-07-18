import { describe, it, expect } from "bun:test";

import {
  evolveMemories,
  extractJsonFromLLM,
  generateMemoryLinks,
  inferCausalLinks,
  parseLinkGenerationFromLLM,
  parseMemoryNoteFromLLM,
} from "../../src/amem.ts";
import { insertContent, insertDocument } from "../../src/store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";

// ─── extractJsonFromLLM ─────────────────────────────────────────────

describe("extractJsonFromLLM", () => {
  it("parses clean JSON array", () => {
    const result = extractJsonFromLLM('[{"key": "value"}]');
    expect(result).toEqual([{ key: "value" }]);
  });

  it("parses clean JSON object", () => {
    const result = extractJsonFromLLM('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("strips markdown code blocks", () => {
    const raw = '```json\n[{"key": "value"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("strips leading prose before JSON", () => {
    const raw = 'Here is the result:\n\n[{"key": "value"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("repairs truncated JSON array", () => {
    const raw = '[{"a": 1}, {"b": 2}, {"c": 3';
    const result = extractJsonFromLLM(raw);
    // Should repair by closing at last }
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns null for non-JSON text", () => {
    const result = extractJsonFromLLM("This is just plain text with no JSON");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = extractJsonFromLLM("");
    expect(result).toBeNull();
  });

  it("handles markdown code block without language tag", () => {
    const raw = '```\n{"key": "value"}\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual({ key: "value" });
  });

  it("handles nested JSON objects", () => {
    const raw = '{"outer": {"inner": [1, 2, 3]}}';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual({ outer: { inner: [1, 2, 3] } });
  });

  it("handles truncated code block (no closing ```)", () => {
    const raw = '```json\n[{"key": "value"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("parses prose-prefixed fenced empty arrays", () => {
    const raw = 'Here is the JSON:\n```json\n[]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([]);
  });

  it("does not treat literal triple backticks inside JSON strings as fences", () => {
    const raw = '{"context":"Use ```json code fences``` in docs."}';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual({ context: "Use ```json code fences``` in docs." });
  });

  it("does not repair adjacent array strings as object fields", () => {
    const raw = '[\n  "alpha"\n  "beta"\n]';
    const result = extractJsonFromLLM(raw);
    expect(result).toBeNull();
  });

  it("prefers later fenced JSON payloads after prose examples", () => {
    const raw = 'Example:\n```\n[]\n```\nActual:\n```json\n[{"key":"value"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("keeps the leading fenced payload when later examples follow", () => {
    const raw = '```json\n[{"key":"value"}]\n```\nExample:\n```\n[]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("prefers the first json fence when later fenced examples follow prose", () => {
    const raw = 'Here is the result:\n```json\n[{"key":"value"}]\n```\nExample:\n```\n[]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("does not let later raw JSON examples override a leading fenced payload", () => {
    const raw = '```json\n[{"key":"value"}]\n```\nExample: [{"key":"example"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("prefers raw JSON before later json-fenced examples", () => {
    const raw = 'Result:\n[]\nExample:\n```json\n[{"key":"example"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([]);
  });

  it("prefers later json fences over leading untagged examples", () => {
    const raw = '```\n[]\n```\nActual:\n```json\n[{"key":"value"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("keeps the first untagged fence when later untagged examples follow prose", () => {
    const raw = 'Result:\n```\n[]\n```\nExample:\n```\n[{"key":"example"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([]);
  });

  it("keeps the first untagged fence when later raw examples follow prose", () => {
    const raw = 'Here is the result:\n```\n[{"key":"value"}]\n```\nExample: [{"key":"example"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("prefers later json payloads over earlier example json fences", () => {
    const raw = 'Example:\n```json\n[]\n```\nActual:\n```json\n[{"key":"value"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("extracts balanced raw JSON before trailing prose", () => {
    const raw = '[{"key":"value"}]\nAdditional explanation follows.';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("prefers later raw payloads over leading fenced examples", () => {
    const raw = '```json\n[]\n```\nActual:\n[{"key":"value"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("prefers later untagged payloads over earlier json-fenced examples", () => {
    const raw = 'Example:\n```json\n[]\n```\nActual:\n```\n[{"key":"value"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("ignores tagged code fences when finding outside JSON", () => {
    const raw = '```ts\nconst result = [{"key":"example"}];\n```\nActual:\n```json\n[{"key":"value"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("prefers raw payloads after leading tagged example fences", () => {
    const raw = '```ts\nconst result = [{"key":"example"}];\n```\n[{"key":"real"}]\nExample:\n```json\n[]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "real" }]);
  });

  it("recognizes final answer cues as payload markers", () => {
    const raw = '```json\n[]\n```\nFinal answer:\n[{"key":"value"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("recognizes answer cues as payload markers", () => {
    const raw = '```json\n[]\n```\nAnswer:\n[{"key":"value"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("does not treat descriptive schema prose as a payload cue", () => {
    const raw = '```json\n[{"key":"value"}]\n```\nThe result schema is [{"key":"example"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ key: "value" }]);
  });

  it("prefers fenced payloads over earlier prose bracket literals", () => {
    const raw = 'Return empty array [] if no structured facts found.\n```json\n[{"title":"T","contentType":"decision","narrative":"N"}]\n```';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ title: "T", contentType: "decision", narrative: "N" }]);
  });

  it("prefers fenced payloads when the conversation-synthesis prompt is echoed first", () => {
    const raw = [
      "The instruction was: Return ONLY valid JSON array. Return empty array [] if no structured facts found.",
      "```json",
      '[{"title":"T","contentType":"decision","narrative":"N"}]',
      "```",
    ].join("\n");
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ title: "T", contentType: "decision", narrative: "N" }]);
  });

  it("prefers later raw payloads over earlier prose schema literals", () => {
    const raw = 'Schema: {"target_idx":1,"link_type":"semantic","confidence":0.9,"reasoning":"example"}\n[{"target_idx":1,"link_type":"semantic","confidence":0.8,"reasoning":"real"}]';
    const result = extractJsonFromLLM(raw);
    expect(result).toEqual([{ target_idx: 1, link_type: "semantic", confidence: 0.8, reasoning: "real" }]);
  });
});

describe("parseMemoryNoteFromLLM", () => {
  it("salvages partial JSON missing tags and context", () => {
    const raw = '```json\n{"keywords":["scheduled reports design"]}\n```';
    const result = parseMemoryNoteFromLLM(raw);
    expect(result).toEqual({
      keywords: ["scheduled reports design"],
      tags: [],
      context: "",
    });
  });

  it("salvages lex vec hyde fallback output", () => {
    const raw = [
      'lex: scheduled reports v2 design',
      'lex: scheduled reports v2 documentation',
      'vec: scheduled reports v2 design pattern implementation',
      'hyde: Here are some code examples for scheduled reports v2.',
    ].join('\n');
    const result = parseMemoryNoteFromLLM(raw);
    expect(result).toEqual({
      keywords: [
        'scheduled reports v2 design',
        'scheduled reports v2 documentation',
      ],
      tags: [],
      context: 'Here are some code examples for scheduled reports v2.',
    });
  });
});

describe("parseMemoryNoteFromLLM repair", () => {
  it("repairs missing commas between top-level object fields", () => {
    const raw = [
      '{',
      '  "keywords": ["scheduled reports design"]',
      '  "tags": ["tag1", "tag2"]',
      '  "context": "Brief summary"',
      '}',
    ].join('\n');
    const result = parseMemoryNoteFromLLM(raw);
    expect(result).toEqual({
      keywords: ["scheduled reports design"],
      tags: ["tag1", "tag2"],
      context: "Brief summary",
    });
  });
});

describe("parseLinkGenerationFromLLM", () => {
  it("unwraps object-wrapped result arrays", () => {
    const raw = `{"status":"valid","confidence":0.95,"result":[{"target_idx":1,"link_type":"semantic","confidence":0.85,"reasoning":"Brief explanation"}]}`;
    const result = parseLinkGenerationFromLLM(raw);
    expect(result).toEqual([
      {
        target_idx: 1,
        link_type: "semantic",
        confidence: 0.85,
        reasoning: "Brief explanation",
      },
    ]);
  });

  it("accepts the primary bare-array payload shape", () => {
    const raw = `[{"target_idx":1,"link_type":"semantic","confidence":0.85,"reasoning":"Brief explanation"}]`;
    const result = parseLinkGenerationFromLLM(raw);
    expect(result).toEqual([
      {
        target_idx: 1,
        link_type: "semantic",
        confidence: 0.85,
        reasoning: "Brief explanation",
      },
    ]);
  });

  it("rejects malformed link items after unwrapping result arrays", () => {
    const raw = `{"result":[{"target_idx":1,"link_type":"semantic","confidence":0.85,"reasoning":"Brief explanation"},{"target_idx":2,"link_type":"semantic","confidence":0.8},{"target_idx":3,"link_type":"semantic","confidence":0.75,"reasoning":4}]}`;
    const result = parseLinkGenerationFromLLM(raw);
    expect(result).toBeNull();
  });

  it("rejects non-finite and out-of-range confidences", () => {
    const raw = `{"result":[{"target_idx":1,"link_type":"semantic","confidence":1e309,"reasoning":"overflow"},{"target_idx":2,"link_type":"semantic","confidence":-0.1,"reasoning":"negative"},{"target_idx":3,"link_type":"semantic","confidence":1.1,"reasoning":"too high"},{"target_idx":4,"link_type":"semantic","confidence":0.5,"reasoning":"valid"}]}`;
    const result = parseLinkGenerationFromLLM(raw);
    expect(result).toBeNull();
  });

  it("rejects invalid target indexes", () => {
    const raw = `{"result":[{"target_idx":0,"link_type":"semantic","confidence":0.5,"reasoning":"zero"},{"target_idx":1.5,"link_type":"semantic","confidence":0.5,"reasoning":"fractional"},{"target_idx":2,"link_type":"semantic","confidence":0.5,"reasoning":"valid"}]}`;
    const result = parseLinkGenerationFromLLM(raw);
    expect(result).toBeNull();
  });

  it("accepts inclusive confidence boundaries", () => {
    const raw = `{"result":[{"target_idx":1,"link_type":"semantic","confidence":0,"reasoning":"zero"},{"target_idx":2,"link_type":"semantic","confidence":1,"reasoning":"one"}]}`;
    const result = parseLinkGenerationFromLLM(raw);
    expect(result).toEqual([
      {
        target_idx: 1,
        link_type: "semantic",
        confidence: 0,
        reasoning: "zero",
      },
      {
        target_idx: 2,
        link_type: "semantic",
        confidence: 1,
        reasoning: "one",
      },
    ]);
  });

  it("parses real link arrays after prose schema examples", () => {
    const raw = 'Schema: {"target_idx":1,"link_type":"semantic","confidence":0.9,"reasoning":"example"}\n[{"target_idx":1,"link_type":"semantic","confidence":0.8,"reasoning":"real"}]';
    const result = parseLinkGenerationFromLLM(raw);
    expect(result).toEqual([
      {
        target_idx: 1,
        link_type: "semantic",
        confidence: 0.8,
        reasoning: "real",
      },
    ]);
  });
});

describe("generateMemoryLinks", () => {
  it("inserts valid partial link batches instead of requiring all neighbors", async () => {
    const store = createTestStore();
    try {
      const ids = seedDocuments(store, [
        { path: "source.md", title: "Source", body: "source" },
        { path: "n1.md", title: "Neighbor 1", body: "one" },
        { path: "n2.md", title: "Neighbor 2", body: "two" },
        { path: "n3.md", title: "Neighbor 3", body: "three" },
        { path: "n4.md", title: "Neighbor 4", body: "four" },
        { path: "n5.md", title: "Neighbor 5", body: "five" },
      ]);

      store.db.prepare("UPDATE documents SET amem_context = title").run();
      store.ensureVecTable(2);

      const rows = store.db.prepare("SELECT id, hash FROM documents ORDER BY id").all() as Array<{ id: number; hash: string }>;
      const embeddings = new Map<number, [number, number]>([
        [ids[0]!, [1, 0]],
        [ids[1]!, [0.99, 0.01]],
        [ids[2]!, [0.98, 0.02]],
        [ids[3]!, [0.97, 0.03]],
        [ids[4]!, [0.96, 0.04]],
        [ids[5]!, [0.95, 0.05]],
      ]);

      for (const row of rows) {
        const embedding = embeddings.get(row.id);
        if (!embedding) throw new Error(`missing embedding for doc ${row.id}`);
        store.insertEmbedding(row.hash, 0, 0, new Float32Array(embedding), "test", new Date().toISOString());
      }

      const llm = {
        generate: async () => ({
          text: JSON.stringify([
            { target_idx: 1, link_type: "semantic", confidence: 0.8, reasoning: "one" },
            { target_idx: 2, link_type: "supporting", confidence: 0.7, reasoning: "two" },
            { target_idx: 3, link_type: "semantic", confidence: 0.6, reasoning: "three" },
            { target_idx: 4, link_type: "contradicts", confidence: 0.5, reasoning: "four" },
            { target_idx: 2, link_type: "contradicts", confidence: 0.9, reasoning: "duplicate" },
            { target_idx: 99, link_type: "semantic", confidence: 0.4, reasoning: "out of range" },
          ]),
        }),
      };

      const created = await generateMemoryLinks(store, llm as any, ids[0]!, 5);
      expect(created).toBe(4);

      const relationCount = store.db.prepare(
        "SELECT COUNT(*) as count FROM memory_relations WHERE source_id = ?"
      ).get(ids[0]!) as { count: number };
      expect(relationCount.count).toBe(4);
    } finally {
      store.close();
    }
  });
});

// ─── generateMemoryLinks vector readiness ───────────────────────────

describe("generateMemoryLinks vector readiness", () => {
  it("returns 0 when vectors_vec is not ready", async () => {
    const store = createTestStore();
    store.db.exec("DROP TABLE IF EXISTS vectors_vec");

    const now = new Date().toISOString();
    insertContent(store.db, "hash-a", "Profile facts", now);
    insertDocument(store.db, "test", "users/cooper.md", "Cooper", "hash-a", now, now);
    const row = store.db.prepare("SELECT id FROM documents WHERE hash = ?").get("hash-a") as { id: number };

    const count = await generateMemoryLinks(store, {} as any, row.id);
    expect(count).toBe(0);
  });

  it("returns 0 when the source document has no vector row yet", async () => {
    const store = createTestStore();
    store.db.exec("DROP TABLE IF EXISTS vectors_vec");
    store.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)");

    const now = new Date().toISOString();
    insertContent(store.db, "hash-a", "Profile facts", now);
    insertDocument(store.db, "test", "users/cooper.md", "Cooper", "hash-a", now, now);
    const row = store.db.prepare("SELECT id FROM documents WHERE hash = ?").get("hash-a") as { id: number };

    const count = await generateMemoryLinks(store, {} as any, row.id);
    expect(count).toBe(0);
  });

  it("returns 0 when the vector neighbor query throws for vector columns", async () => {
    const store = createTestStore();
    store.db.exec("DROP TABLE IF EXISTS vectors_vec");
    store.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY)");

    const now = new Date().toISOString();
    insertContent(store.db, "hash-a", "Profile facts", now);
    insertContent(store.db, "hash-b", "More profile facts", now);
    insertDocument(store.db, "test", "users/cooper.md", "Cooper", "hash-a", now, now);
    insertDocument(store.db, "test", "notes/peer.md", "Peer", "hash-b", now, now);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq) VALUES (?)").run("hash-a_0");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq) VALUES (?)").run("hash-b_0");
    const row = store.db.prepare("SELECT id FROM documents WHERE hash = ?").get("hash-a") as { id: number };

    const count = await generateMemoryLinks(store, {} as any, row.id);
    expect(count).toBe(0);
  });

  it("rethrows non-vector SQL errors from the neighbor query", async () => {
    const store = createTestStore();
    store.db.exec("DROP TABLE IF EXISTS vectors_vec");
    store.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)");

    const now = new Date().toISOString();
    insertContent(store.db, "hash-a", "Profile facts", now);
    insertDocument(store.db, "test", "users/cooper.md", "Cooper", "hash-a", now, now);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run("hash-a_0", new Uint8Array([1, 2, 3]));
    const row = store.db.prepare("SELECT id FROM documents WHERE hash = ?").get("hash-a") as { id: number };

    const originalPrepare = store.db.prepare.bind(store.db);
    (store.db as any).prepare = (sql: string) => {
      if (sql.includes("vec_distance_cosine")) {
        throw new Error("no such column: d2.active");
      }
      return originalPrepare(sql);
    };

    await expect(generateMemoryLinks(store, {} as any, row.id)).rejects.toThrow(
      "no such column: d2.active"
    );
  });
});

// ─── §13.1 — evolveMemories structural validation inside the parse closure ───
//
// A malformed should_evolve=true payload must trigger a corrective retry
// (not a silent post-loop rejection), while should_evolve=false needs no
// payload fields at all.

function seedEvolutionFixture() {
  const store = createTestStore();
  const [memId, nbId] = seedDocuments(store, [
    { path: "mem.md", title: "Memory A", body: "memory body" },
    { path: "nb.md", title: "Neighbor B", body: "neighbor body" },
  ]) as [number, number];

  store.db
    .prepare(
      "UPDATE documents SET amem_context = ?, amem_keywords = ?, amem_tags = ? WHERE id = ?"
    )
    .run("Original context.", '["orig"]', '["old-tag"]', memId);
  store.db
    .prepare("UPDATE documents SET amem_context = ? WHERE id = ?")
    .run("Neighbor context.", nbId);
  store.db
    .prepare(
      "INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'related', 0.9, ?)"
    )
    .run(memId, nbId, new Date().toISOString());

  return { store, memId, nbId };
}

describe("evolveMemories retry-with-error-feedback (§13.1)", () => {
  const MALFORMED_EVOLUTION = JSON.stringify({
    should_evolve: true,
    new_keywords: "not-an-array",
    new_tags: [],
    new_context: "",
    reasoning: "",
  });
  const VALID_EVOLUTION = JSON.stringify({
    should_evolve: true,
    new_keywords: ["fresh"],
    new_tags: ["new-tag"],
    new_context: "Updated context.",
    reasoning: "New evidence arrived.",
  });

  it("retries a malformed should_evolve=true payload and applies the corrected evolution", async () => {
    const { store, memId, nbId } = seedEvolutionFixture();
    const llm = createMockLLM();
    llm.generate
      .mockResolvedValueOnce({ text: MALFORMED_EVOLUTION, model: "mock", done: true })
      .mockResolvedValueOnce({ text: VALID_EVOLUTION, model: "mock", done: true });

    const result = await evolveMemories(store, llm as any, memId, nbId);

    expect(result).toBe(true);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    const retryPrompt = llm.generate.mock.calls[1]?.[0] as string;
    expect(retryPrompt).toContain("did not match the expected structure");

    const row = store.db
      .prepare("SELECT amem_keywords, amem_context FROM documents WHERE id = ?")
      .get(memId) as { amem_keywords: string; amem_context: string };
    expect(row.amem_keywords).toBe('["fresh"]');
    expect(row.amem_context).toBe("Updated context.");
  });

  it("fails open (no evolution) when every attempt returns a malformed payload", async () => {
    const { store, memId, nbId } = seedEvolutionFixture();
    const llm = createMockLLM();
    llm.generate
      .mockResolvedValueOnce({ text: MALFORMED_EVOLUTION, model: "mock", done: true })
      .mockResolvedValueOnce({ text: MALFORMED_EVOLUTION, model: "mock", done: true })
      .mockResolvedValueOnce({ text: MALFORMED_EVOLUTION, model: "mock", done: true });

    const result = await evolveMemories(store, llm as any, memId, nbId);

    expect(result).toBe(false);
    expect(llm.generate).toHaveBeenCalledTimes(3);
    const row = store.db
      .prepare("SELECT amem_context FROM documents WHERE id = ?")
      .get(memId) as { amem_context: string };
    expect(row.amem_context).toBe("Original context.");
  });

  it("accepts should_evolve=false without payload fields — no retry burned on it", async () => {
    const { store, memId, nbId } = seedEvolutionFixture();
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: '{"should_evolve": false}',
      model: "mock",
      done: true,
    });

    const result = await evolveMemories(store, llm as any, memId, nbId);

    expect(result).toBe(false);
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });
});

// ─── §13.1 — inferCausalLinks structural validation inside the parse closure ─
//
// A structurally broken link entry must trigger a corrective retry; semantic
// filters (confidence threshold, index range) stay outside and never retry.

function seedCausalFixture() {
  const store = createTestStore();
  const [d1, d2] = seedDocuments(store, [
    { path: "obs-1.md", title: "Obs One", body: "first observation" },
    { path: "obs-2.md", title: "Obs Two", body: "second observation" },
  ]) as [number, number];
  const observations = [
    { docId: d1, facts: ["Fact zero happened"] },
    { docId: d2, facts: ["Fact one followed"] },
  ];
  return { store, d1, d2, observations };
}

describe("inferCausalLinks retry-with-error-feedback (§13.1)", () => {
  const VALID_LINKS = JSON.stringify([
    { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.9, reasoning: "zero led to one" },
  ]);

  it("retries a structurally invalid link entry and inserts the corrected link", async () => {
    const { store, d1, d2, observations } = seedCausalFixture();
    const llm = createMockLLM();
    llm.generate
      .mockResolvedValueOnce({
        text: '[{"source_fact_idx": "0", "target_fact_idx": 1, "confidence": 0.9, "reasoning": "r"}]',
        model: "mock",
        done: true,
      })
      .mockResolvedValueOnce({ text: VALID_LINKS, model: "mock", done: true });

    const created = await inferCausalLinks(store, llm as any, observations);

    expect(created).toBe(1);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    const row = store.db
      .prepare(
        "SELECT source_id, target_id FROM memory_relations WHERE relation_type = 'causal'"
      )
      .get() as { source_id: number; target_id: number };
    expect(row.source_id).toBe(d1);
    expect(row.target_id).toBe(d2);
  });

  it("fails open to 0 links when every attempt is structurally invalid", async () => {
    const { store, observations } = seedCausalFixture();
    const llm = createMockLLM();
    const malformed = { text: '[{"confidence": "high"}]', model: "mock", done: true };
    llm.generate
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(malformed);

    const created = await inferCausalLinks(store, llm as any, observations);

    expect(created).toBe(0);
    expect(llm.generate).toHaveBeenCalledTimes(3);
    const count = store.db
      .prepare("SELECT COUNT(*) as n FROM memory_relations WHERE relation_type = 'causal'")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects fractional indexes structurally — a valid preceding entry causes NO partial write", async () => {
    const { store, observations } = seedCausalFixture();
    const llm = createMockLLM();
    llm.generate
      .mockResolvedValueOnce({
        // Valid first entry + fractional-index second entry: the WHOLE
        // response must be rejected in parse (retry), so the valid entry is
        // never inserted from the malformed attempt.
        text: JSON.stringify([
          { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.9, reasoning: "valid" },
          { source_fact_idx: 0.5, target_fact_idx: 1, confidence: 0.9, reasoning: "fractional" },
        ]),
        model: "mock",
        done: true,
      })
      .mockResolvedValueOnce({ text: VALID_LINKS, model: "mock", done: true });

    const created = await inferCausalLinks(store, llm as any, observations);

    expect(created).toBe(1);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    const count = store.db
      .prepare("SELECT COUNT(*) as n FROM memory_relations WHERE relation_type = 'causal'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("does NOT retry semantically filtered links (low confidence, out-of-range index)", async () => {
    const { store, observations } = seedCausalFixture();
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: JSON.stringify([
        { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.3, reasoning: "too weak" },
        { source_fact_idx: 5, target_fact_idx: 1, confidence: 0.9, reasoning: "bad index" },
      ]),
      model: "mock",
      done: true,
    });

    const created = await inferCausalLinks(store, llm as any, observations);

    expect(created).toBe(0);
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });
});
