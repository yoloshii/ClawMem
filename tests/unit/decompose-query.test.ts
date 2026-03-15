/**
 * Tests for decomposeQuery — the QueryPlan multi-query decomposition.
 * Validates fix #5A: short queries no longer forced to BM25-only.
 */

import { describe, it, expect } from "bun:test";
import { decomposeQuery, type QueryClause } from "../../src/intent.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";

const store = createTestStore();

describe("decomposeQuery", () => {
  it("routes short WHY queries to graph, not BM25", async () => {
    // "why did this fail?" is 4 words — previously forced to BM25-only
    const llm = createMockLLM();
    // Mock generate to return WHY intent for short queries
    llm.generate.mockImplementation(async () => ({ text: "WHY", model: "mock", done: true }));

    const clauses = await decomposeQuery("why did this fail?", llm, store.db);
    expect(clauses.length).toBeGreaterThanOrEqual(1);

    const types = clauses.map(c => c.type);
    expect(types).toContain("graph");
  });

  it("routes short ENTITY queries to graph", async () => {
    const llm = createMockLLM();
    llm.generate.mockImplementation(async () => ({ text: "ENTITY", model: "mock", done: true }));

    const clauses = await decomposeQuery("who wrote this?", llm, store.db);
    const types = clauses.map(c => c.type);
    expect(types).toContain("graph");
  });

  it("routes short WHAT queries to BM25 (not graph)", async () => {
    const llm = createMockLLM();
    // Default mock returns "WHAT"
    const clauses = await decomposeQuery("explain the config", llm, store.db);
    const types = clauses.map(c => c.type);
    expect(types).toContain("bm25");
    expect(types).not.toContain("graph");
  });

  it("includes vector clause alongside primary clause for short queries", async () => {
    const llm = createMockLLM();
    const clauses = await decomposeQuery("explain the config", llm, store.db);
    expect(clauses.length).toBe(2);
    const types = clauses.map(c => c.type);
    expect(types).toContain("vector");
  });

  it("decomposes multi-topic queries into multiple clauses", async () => {
    const llm = createMockLLM();
    // Mock to return JSON array for multi-topic decomposition
    llm.generate.mockImplementation(async (prompt: string) => {
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
      llm, store.db
    );
    expect(clauses.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to dual-mode for medium-length single-topic queries", async () => {
    const llm = createMockLLM();
    // 7 words, no multi-topic signals
    const clauses = await decomposeQuery(
      "explain the architecture of the system overview",
      llm, store.db
    );
    expect(clauses.length).toBe(2);
    const types = clauses.map(c => c.type);
    // Should include both bm25/graph + vector
    expect(types).toContain("vector");
  });
});
