/**
 * Tests for decomposeQuery — the QueryPlan multi-query decomposition.
 * Validates: short queries route by intent (not BM25-only),
 * multi-topic queries decompose into multiple clauses.
 */

import { describe, it, expect, mock } from "bun:test";
import { decomposeQuery, type QueryClause } from "../../src/intent.ts";
import { createStore } from "../../src/store.ts";

const store = createStore(":memory:");

/** Minimal mock LLM satisfying the LlamaCpp interface for intent/decompose. */
function makeMockLLM(generateFn?: (prompt: string) => Promise<{ text: string; model: string; done: boolean } | null>) {
  return {
    generate: mock(generateFn ?? (async () => ({ text: "WHAT", model: "mock", done: true }))),
    embed: mock(async () => null),
    rerank: mock(async () => ({ results: [], model: "mock" })),
    expandQuery: mock(async (q: string) => [{ type: "lex" as const, text: q }]),
    modelExists: mock(async () => ({ name: "mock", exists: true })),
    dispose: mock(async () => {}),
  };
}

describe("decomposeQuery", () => {
  it("routes short WHY queries to graph, not BM25", async () => {
    const llm = makeMockLLM(async () => ({ text: "WHY", model: "mock", done: true }));
    const clauses = await decomposeQuery("why did this fail?", llm as any, store.db);
    expect(clauses.length).toBeGreaterThanOrEqual(1);
    const types = clauses.map(c => c.type);
    expect(types).toContain("graph");
  });

  it("routes short ENTITY queries to graph", async () => {
    const llm = makeMockLLM(async () => ({ text: "ENTITY", model: "mock", done: true }));
    const clauses = await decomposeQuery("who wrote this?", llm as any, store.db);
    const types = clauses.map(c => c.type);
    expect(types).toContain("graph");
  });

  it("routes short WHAT queries to BM25 (not graph)", async () => {
    const llm = makeMockLLM();
    const clauses = await decomposeQuery("explain the config", llm as any, store.db);
    const types = clauses.map(c => c.type);
    expect(types).toContain("bm25");
    expect(types).not.toContain("graph");
  });

  it("includes vector clause alongside primary clause for short queries", async () => {
    const llm = makeMockLLM();
    const clauses = await decomposeQuery("explain the config", llm as any, store.db);
    expect(clauses.length).toBe(2);
    const types = clauses.map(c => c.type);
    expect(types).toContain("vector");
  });

  it("decomposes multi-topic queries into multiple clauses", async () => {
    const llm = makeMockLLM(async (prompt: string) => {
      if (prompt.includes("Decompose")) {
        return {
          text: JSON.stringify([
            { query: "auth decisions", type: "bm25", priority: 1 },
            { query: "tools used for auth", type: "vector", priority: 2 },
          ]),
          model: "mock", done: true,
        };
      }
      return { text: "WHAT", model: "mock", done: true };
    });

    const clauses = await decomposeQuery(
      "what decisions did we make about auth and what tools were used",
      llm as any, store.db
    );
    expect(clauses.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to dual-mode for medium-length single-topic queries", async () => {
    const llm = makeMockLLM();
    const clauses = await decomposeQuery(
      "explain the architecture of the system overview",
      llm as any, store.db
    );
    expect(clauses.length).toBe(2);
    const types = clauses.map(c => c.type);
    expect(types).toContain("vector");
  });
});
