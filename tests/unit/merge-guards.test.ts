import { describe, it, expect, afterEach } from "bun:test";
import {
  checkContradiction,
  CONTRADICTION_MIN_CONFIDENCE,
  heuristicContradictionCheck,
  isActionableContradiction,
  llmContradictionCheck,
  resolveContradictionPolicy,
} from "../../src/merge-guards.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";

/**
 * Unit tests for Ext 2 — Contradiction-aware merge gate
 * (THOTH_EXTRACTION_PLAN.md Extraction 2).
 *
 * The module is fully unit-testable: the heuristic is deterministic,
 * the LLM path uses the shared `createMockLLM` helper, and the
 * orchestrator is just LLM → heuristic fallback.
 */

// ─── heuristicContradictionCheck ───────────────────────────────────────

describe("heuristicContradictionCheck", () => {
  it("flags negation asymmetry (one side has 'not', the other doesn't)", () => {
    const result = heuristicContradictionCheck(
      "The migration completed on time",
      "The migration did not complete on time"
    );
    expect(result.contradictory).toBe(true);
    expect(result.source).toBe("heuristic");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.reason).toContain("negation");
  });

  it("flags common negation contractions (didn't, won't, cannot)", () => {
    expect(
      heuristicContradictionCheck(
        "Bob will ship this sprint",
        "Bob won't ship this sprint"
      ).contradictory
    ).toBe(true);
    expect(
      heuristicContradictionCheck(
        "The team finished on time",
        "The team didn't finish on time"
      ).contradictory
    ).toBe(true);
    expect(
      heuristicContradictionCheck(
        "The system can recover automatically",
        "The system cannot recover automatically"
      ).contradictory
    ).toBe(true);
  });

  it("flags number/date mismatches when both sides cite numbers", () => {
    const result = heuristicContradictionCheck(
      "Deploy count was 5 last week",
      "Deploy count was 7 last week"
    );
    expect(result.contradictory).toBe(true);
    expect(result.source).toBe("heuristic");
    expect(result.reason).toContain("mismatch");
  });

  it("does NOT flag when numbers overlap (same numeric anchor)", () => {
    const result = heuristicContradictionCheck(
      "Version 1.2 was released on 2026-04-10",
      "Version 1.2 shipped on 2026-04-10"
    );
    expect(result.contradictory).toBe(false);
  });

  it("does NOT flag two statements without any signal", () => {
    const result = heuristicContradictionCheck(
      "The team shipped the feature",
      "The team shipped the feature"
    );
    expect(result.contradictory).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain("no heuristic signal");
  });

  it("does NOT flag when both sides have matching negation", () => {
    const result = heuristicContradictionCheck(
      "The deployment did not succeed",
      "The rollout did not succeed"
    );
    // Both have negation; heuristic shouldn't mark a contradiction.
    expect(result.contradictory).toBe(false);
  });

  it("does NOT flag when only one side has numbers (no comparison possible)", () => {
    const result = heuristicContradictionCheck(
      "The feature shipped today",
      "The feature shipped 3 days after the milestone"
    );
    expect(result.contradictory).toBe(false);
  });

  it("always returns source='heuristic'", () => {
    expect(heuristicContradictionCheck("a", "b").source).toBe("heuristic");
    expect(
      heuristicContradictionCheck("not a", "b").source
    ).toBe("heuristic");
  });
});

// ─── llmContradictionCheck ─────────────────────────────────────────────

describe("llmContradictionCheck", () => {
  it("returns structured result on valid JSON", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: '{"contradictory": true, "confidence": 0.92, "reason": "opposite outcomes"}',
      model: "mock-llm",
      done: true,
    });

    const result = await llmContradictionCheck(
      llm,
      "Deploy succeeded",
      "Deploy failed"
    );

    expect(result).not.toBeNull();
    expect(result!.contradictory).toBe(true);
    expect(result!.confidence).toBe(0.92);
    expect(result!.reason).toBe("opposite outcomes");
    expect(result!.source).toBe("llm");
  });

  it("returns null when LLM returns null (cooldown)", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce(null);

    const result = await llmContradictionCheck(llm, "a", "b");
    expect(result).toBeNull();
  });

  it("returns null when LLM throws", async () => {
    const llm = createMockLLM();
    llm.generate.mockRejectedValueOnce(new Error("network failure"));

    const result = await llmContradictionCheck(llm, "a", "b");
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON output", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: "I am not JSON at all, this is plain prose.",
      model: "mock-llm",
      done: true,
    });

    const result = await llmContradictionCheck(llm, "a", "b");
    expect(result).toBeNull();
  });

  it("returns null when 'contradictory' field is missing", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: '{"confidence": 0.8, "reason": "missing contradictory field"}',
      model: "mock-llm",
      done: true,
    });

    const result = await llmContradictionCheck(llm, "a", "b");
    expect(result).toBeNull();
  });

  it("clamps confidence into [0, 1]", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: '{"contradictory": true, "confidence": 1.7, "reason": "over"}',
      model: "mock-llm",
      done: true,
    });
    const result = await llmContradictionCheck(llm, "a", "b");
    expect(result!.confidence).toBe(1.0);

    llm.generate.mockResolvedValueOnce({
      text: '{"contradictory": true, "confidence": -0.3, "reason": "under"}',
      model: "mock-llm",
      done: true,
    });
    const result2 = await llmContradictionCheck(llm, "a", "b");
    expect(result2!.confidence).toBe(0);
  });

  it("falls back to 0.5 confidence when field is missing/invalid", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: '{"contradictory": false}',
      model: "mock-llm",
      done: true,
    });
    const result = await llmContradictionCheck(llm, "a", "b");
    expect(result!.confidence).toBe(0.5);
  });

  it("passes the context string into the prompt", async () => {
    const llm = createMockLLM();
    let capturedPrompt = "";
    llm.generate.mockImplementationOnce(async (prompt: string) => {
      capturedPrompt = prompt;
      return {
        text: '{"contradictory": false, "confidence": 0.1}',
        model: "mock-llm",
        done: true,
      };
    });

    await llmContradictionCheck(llm, "a", "b", "test collection: foo");
    expect(capturedPrompt).toContain("test collection: foo");
  });
});

// ─── checkContradiction (orchestrator) ─────────────────────────────────

describe("checkContradiction", () => {
  it("returns LLM result when LLM path succeeds", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: '{"contradictory": true, "confidence": 0.88}',
      model: "mock-llm",
      done: true,
    });

    const result = await checkContradiction(llm, "a", "b");
    expect(result.source).toBe("llm");
    expect(result.contradictory).toBe(true);
    expect(result.confidence).toBe(0.88);
  });

  it("falls back to heuristic when LLM returns null", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce(null);

    // Heuristic should fire on the negation asymmetry
    const result = await checkContradiction(
      llm,
      "The deploy succeeded",
      "The deploy did not succeed"
    );
    expect(result.source).toBe("heuristic");
    expect(result.contradictory).toBe(true);
  });

  it("falls back to heuristic when LLM throws", async () => {
    const llm = createMockLLM();
    llm.generate.mockRejectedValueOnce(new Error("timeout"));

    const result = await checkContradiction(
      llm,
      "Version 2 shipped",
      "Version 5 shipped"
    );
    expect(result.source).toBe("heuristic");
    expect(result.contradictory).toBe(true); // number mismatch
  });

  it("falls back to heuristic with null when LLM null + no heuristic signal", async () => {
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce(null);

    const result = await checkContradiction(
      llm,
      "The team shipped the feature",
      "The team shipped the feature"
    );
    expect(result.source).toBe("heuristic");
    expect(result.contradictory).toBe(false);
  });

  it("never throws — LLM exception + heuristic always resolves", async () => {
    const llm = createMockLLM();
    llm.generate.mockRejectedValueOnce(new Error("boom"));

    let threw = false;
    try {
      await checkContradiction(llm, "x", "y");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ─── isActionableContradiction ─────────────────────────────────────────

describe("isActionableContradiction", () => {
  it("true when contradictory=true AND confidence >= threshold", () => {
    expect(
      isActionableContradiction({
        contradictory: true,
        confidence: 0.9,
        source: "llm",
      })
    ).toBe(true);
  });

  it("false when contradictory=false regardless of confidence", () => {
    expect(
      isActionableContradiction({
        contradictory: false,
        confidence: 1.0,
        source: "llm",
      })
    ).toBe(false);
  });

  it("false when contradictory=true but confidence below threshold", () => {
    expect(
      isActionableContradiction({
        contradictory: true,
        confidence: 0.2,
        source: "heuristic",
      })
    ).toBe(false);
  });

  it("boundary: confidence exactly at threshold is actionable", () => {
    expect(
      isActionableContradiction({
        contradictory: true,
        confidence: CONTRADICTION_MIN_CONFIDENCE,
        source: "heuristic",
      })
    ).toBe(true);
  });
});

// ─── resolveContradictionPolicy ────────────────────────────────────────

describe("resolveContradictionPolicy", () => {
  afterEach(() => {
    delete process.env.CLAWMEM_CONTRADICTION_POLICY;
  });

  it("defaults to 'link' when env unset", () => {
    expect(resolveContradictionPolicy()).toBe("link");
  });

  it("honors 'supersede' from env", () => {
    process.env.CLAWMEM_CONTRADICTION_POLICY = "supersede";
    expect(resolveContradictionPolicy()).toBe("supersede");
  });

  it("honors 'link' explicitly from env", () => {
    process.env.CLAWMEM_CONTRADICTION_POLICY = "link";
    expect(resolveContradictionPolicy()).toBe("link");
  });

  it("falls back to 'link' on invalid value", () => {
    process.env.CLAWMEM_CONTRADICTION_POLICY = "merge-everything";
    expect(resolveContradictionPolicy()).toBe("link");
  });
});
