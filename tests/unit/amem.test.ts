import { describe, it, expect } from "bun:test";
import { extractJsonFromLLM, generateMemoryLinks } from "../../src/amem.ts";
import { insertContent, insertDocument } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";

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
});

// ─── generateMemoryLinks vector readiness ───────────────────────────

describe("generateMemoryLinks", () => {
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
});
