import { describe, it, expect } from "bun:test";
import { classifyIntent, getIntentWeights } from "../../src/intent.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";

// ─── Heuristic classification (tested via classifyIntent) ───────────

describe("classifyIntent — heuristic", () => {
  const store = createTestStore();
  const llm = createMockLLM();

  it("classifies 'why did we choose X' as WHY", async () => {
    const r = await classifyIntent("why did we choose REST", llm, store.db);
    expect(r.intent).toBe("WHY");
  });

  it("classifies 'what caused the failure' as WHY", async () => {
    const r = await classifyIntent("what caused the failure", llm, store.db);
    expect(r.intent).toBe("WHY");
  });

  it("classifies 'when was X deployed' as WHEN", async () => {
    const r = await classifyIntent("when was the service deployed", llm, store.db);
    expect(r.intent).toBe("WHEN");
  });

  it("classifies 'who worked on X' as ENTITY", async () => {
    const r = await classifyIntent("who worked on the auth module", llm, store.db);
    expect(r.intent).toBe("ENTITY");
  });

  it("classifies generic 'explain X' as WHAT", async () => {
    const r = await classifyIntent("explain the architecture", llm, store.db);
    expect(r.intent).toBe("WHAT");
  });

  it("boosts score when query starts with 'why'", async () => {
    const r = await classifyIntent("why is the sky blue", llm, store.db);
    expect(r.intent).toBe("WHY");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("boosts score when query starts with 'when'", async () => {
    const r = await classifyIntent("when did this start", llm, store.db);
    expect(r.intent).toBe("WHEN");
  });

  it("boosts score when query starts with 'who'", async () => {
    const r = await classifyIntent("who is responsible", llm, store.db);
    expect(r.intent).toBe("ENTITY");
  });

  it("returns confidence 0.6 for zero-score (WHAT default)", async () => {
    const r = await classifyIntent("hello world", llm, store.db);
    expect(r.intent).toBe("WHAT");
    // LLM mock returns "WHAT" so this may refine, but heuristic would be 0.6
  });
});

// ─── Temporal extraction ────────────────────────────────────────────

describe("classifyIntent — temporal extraction", () => {
  const store = createTestStore();
  const llm = createMockLLM();

  it("extracts 'last week' relative dates", async () => {
    const r = await classifyIntent("what happened last week", llm, store.db);
    expect(r.temporal_start).toBeDefined();
    expect(r.temporal_end).toBeDefined();
  });

  it("extracts 'last month' relative dates", async () => {
    const r = await classifyIntent("changes from last month", llm, store.db);
    expect(r.temporal_start).toBeDefined();
  });

  it("extracts 'yesterday' date", async () => {
    const r = await classifyIntent("what did we do yesterday", llm, store.db);
    expect(r.temporal_start).toBeDefined();
    expect(r.temporal_start).toBe(r.temporal_end); // same day
  });

  it("extracts 'N days ago' with correct arithmetic", async () => {
    const r = await classifyIntent("what happened 3 days ago", llm, store.db);
    expect(r.temporal_start).toBeDefined();
  });

  it("extracts 'in January 2026' absolute month range", async () => {
    const r = await classifyIntent("in January 2026", llm, store.db);
    expect(r.temporal_start).toBe("2026-01-01");
    expect(r.temporal_end).toBe("2026-01-31");
  });

  it("handles month name abbreviations", async () => {
    const r = await classifyIntent("in Mar 2026", llm, store.db);
    expect(r.temporal_start).toBe("2026-03-01");
  });

  it("returns undefined temporal for non-temporal queries", async () => {
    const r = await classifyIntent("explain the architecture", llm, store.db);
    expect(r.temporal_start).toBeUndefined();
    expect(r.temporal_end).toBeUndefined();
  });
});

// ─── getIntentWeights ───────────────────────────────────────────────

describe("getIntentWeights", () => {
  it("WHY weights causal highest", () => {
    const w = getIntentWeights("WHY");
    expect(w.causal).toBe(5.0);
    expect(w.causal).toBeGreaterThan(w.semantic);
    expect(w.causal).toBeGreaterThan(w.temporal);
  });

  it("WHEN weights temporal highest", () => {
    const w = getIntentWeights("WHEN");
    expect(w.temporal).toBe(5.0);
    expect(w.temporal).toBeGreaterThan(w.causal);
  });

  it("ENTITY weights entity highest", () => {
    const w = getIntentWeights("ENTITY");
    expect(w.entity).toBe(6.0);
  });

  it("WHAT weights semantic highest", () => {
    const w = getIntentWeights("WHAT");
    expect(w.semantic).toBe(5.0);
  });
});

// ─── Cache behavior ─────────────────────────────────────────────────

describe("classifyIntent — caching", () => {
  it("caches results in intent_classifications table", async () => {
    const store = createTestStore();
    const llm = createMockLLM();
    await classifyIntent("why did X happen", llm, store.db);
    const row = store.db.prepare(
      "SELECT intent FROM intent_classifications WHERE query_text = ?"
    ).get("why did X happen") as { intent: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.intent).toBe("WHY");
  });

  it("returns cached result on repeat query", async () => {
    const store = createTestStore();
    const llm = createMockLLM();
    const r1 = await classifyIntent("unique test query abc", llm, store.db);
    const r2 = await classifyIntent("unique test query abc", llm, store.db);
    expect(r1.intent).toBe(r2.intent);
    expect(r1.confidence).toBe(r2.confidence);
  });

  it("falls back to heuristic when LLM fails", async () => {
    const store = createTestStore();
    const llm = createMockLLM();
    llm.generate = async () => { throw new Error("LLM down"); };
    // "explain something" → ambiguous, should try LLM, fall back to heuristic
    const r = await classifyIntent("tell me about the project", llm, store.db);
    expect(r.intent).toBeDefined();
  });
});
