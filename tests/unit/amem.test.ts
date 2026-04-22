import { describe, it, expect } from "bun:test";

import { extractJsonFromLLM, parseLinkGenerationFromLLM, parseMemoryNoteFromLLM } from "../../src/amem.ts";

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
});
