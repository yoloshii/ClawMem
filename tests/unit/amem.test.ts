import { describe, it, expect } from "bun:test";
import { extractJsonFromLLM } from "../../src/amem.ts";

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
