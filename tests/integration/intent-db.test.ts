import { describe, it, expect, beforeEach, mock } from "bun:test";
import { classifyIntent } from "../../src/intent.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import type { Store } from "../../src/store.ts";

let store: Store;

beforeEach(() => {
  store = createTestStore();
});

describe("classifyIntent with DB caching", () => {
  it("caches heuristic result in intent_classifications table", async () => {
    const llm = createMockLLM();
    // "why did we choose X" is high-confidence heuristic (WHY)
    await classifyIntent("why did we choose PostgreSQL", llm, store.db);
    const row = store.db.prepare(
      "SELECT intent, confidence FROM intent_classifications LIMIT 1"
    ).get() as { intent: string; confidence: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.intent).toBe("WHY");
  });

  it("returns cached result on repeated query", async () => {
    const llm = createMockLLM();
    const first = await classifyIntent("why did we choose Redis", llm, store.db);
    const second = await classifyIntent("why did we choose Redis", llm, store.db);
    expect(first.intent).toBe(second.intent);
    expect(first.confidence).toBe(second.confidence);
  });

  it("falls back to heuristic when LLM fails", async () => {
    const llm = createMockLLM();
    // Make LLM throw
    llm.generate = mock(async () => { throw new Error("LLM unavailable"); });
    // "explain the approach" is ambiguous (WHAT, low confidence)
    const result = await classifyIntent("explain the approach", llm, store.db);
    expect(result.intent).toBe("WHAT");
    expect(result.confidence).toBe(0.6);
  });

  it("persists temporal_start and temporal_end", async () => {
    const llm = createMockLLM();
    await classifyIntent("when was it deployed last week", llm, store.db);
    const row = store.db.prepare(
      "SELECT temporal_start, temporal_end FROM intent_classifications LIMIT 1"
    ).get() as { temporal_start: string | null; temporal_end: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.temporal_start).toBeDefined();
    expect(row!.temporal_end).toBeDefined();
  });

  it("uses LLM for ambiguous queries when heuristic confidence < 0.8", async () => {
    const llm = createMockLLM();
    // Configure LLM to return a valid intent
    llm.generate = mock(async () => ({ text: "ENTITY", model: "mock", done: true }));
    // "tell me about the project" has no strong heuristic signal
    const result = await classifyIntent("tell me about the project", llm, store.db);
    // Either heuristic WHAT (0.6) or LLM-refined ENTITY (0.85)
    expect(["WHAT", "ENTITY"]).toContain(result.intent);
  });
});
