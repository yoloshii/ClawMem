import { describe, it, expect } from "bun:test";
import {
  DECISION_PATTERNS,
  FAILURE_PATTERNS,
  extractAntipatterns,
} from "../../src/hooks/decision-extractor.ts";

// ─── DECISION_PATTERNS ─────────────────────────────────────────────

describe("DECISION_PATTERNS", () => {
  const matchesAny = (text: string) =>
    DECISION_PATTERNS.some((p) => p.test(text));

  it("matches 'we decided to'", () => {
    expect(matchesAny("We decided to use PostgreSQL")).toBe(true);
  });

  it("matches 'let's go with'", () => {
    expect(matchesAny("Let's go with the microservice approach")).toBe(true);
  });

  it("matches 'the approach is'", () => {
    expect(matchesAny("The approach is to use event sourcing")).toBe(true);
  });

  it("matches 'we should use'", () => {
    expect(matchesAny("We should use Redis for caching")).toBe(true);
  });

  it("matches 'I'm going with'", () => {
    expect(matchesAny("I'm going with TypeScript for this")).toBe(true);
  });

  it("does NOT match generic statements", () => {
    expect(matchesAny("The function returns a string")).toBe(false);
  });
});

// ─── FAILURE_PATTERNS ───────────────────────────────────────────────

describe("FAILURE_PATTERNS", () => {
  const matchesAny = (text: string) =>
    FAILURE_PATTERNS.some((p) => p.test(text));

  it("matches 'doesn't work'", () => {
    expect(matchesAny("This approach doesn't work for large datasets")).toBe(true);
  });

  it("matches 'reverted'", () => {
    expect(matchesAny("We reverted the changes after finding the bug")).toBe(true);
  });

  it("matches 'avoid using'", () => {
    expect(matchesAny("Avoid using global state in this module")).toBe(true);
  });

  it("matches 'wrong approach'", () => {
    expect(matchesAny("That was the wrong approach for this problem")).toBe(true);
  });

  it("matches 'bug is caused by'", () => {
    expect(matchesAny("The bug is caused by a race condition")).toBe(true);
  });

  it("does NOT match generic code", () => {
    expect(matchesAny("The function compiles correctly")).toBe(false);
  });
});

// ─── extractAntipatterns ────────────────────────────────────────────

describe("extractAntipatterns", () => {
  it("extracts antipatterns from assistant messages only", () => {
    const messages = [
      { role: "user", content: "This doesn't work at all with the system." },
      { role: "assistant", content: "The problem is caused by the race condition in the handler. We should avoid using global state here." },
    ];
    const result = extractAntipatterns(messages);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Should not include user message match
    expect(result.every((r) => !r.text.includes("at all"))).toBe(true);
  });

  it("ignores user role messages", () => {
    const messages = [
      { role: "user", content: "This doesn't work with my setup." },
    ];
    const result = extractAntipatterns(messages);
    expect(result).toHaveLength(0);
  });

  it("deduplicates by first 80 chars", () => {
    const text = "The problem is caused by a race condition in the event processing pipeline which blocks the main thread. " +
      "The problem is caused by a race condition in the event processing pipeline which blocks the main thread.";
    const messages = [
      { role: "assistant", content: text },
    ];
    const result = extractAntipatterns(messages);
    expect(result).toHaveLength(1);
  });

  it("skips sentences shorter than 15 chars", () => {
    const messages = [
      { role: "assistant", content: "Bad idea. Don't use it." },
    ];
    const result = extractAntipatterns(messages);
    expect(result).toHaveLength(0);
  });

  it("skips sentences longer than 500 chars", () => {
    const messages = [
      { role: "assistant", content: `This doesn't work because ${"x".repeat(500)}` },
    ];
    const result = extractAntipatterns(messages);
    expect(result).toHaveLength(0);
  });

  it("caps at 10 antipatterns", () => {
    const sentences = Array.from({ length: 15 }, (_, i) =>
      `The bug is caused by issue number ${i} in the system which needs fixing`
    );
    const messages = [
      { role: "assistant", content: sentences.join(". ") },
    ];
    const result = extractAntipatterns(messages);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("includes context from previous sentence", () => {
    const messages = [
      { role: "assistant", content: "We tried the synchronous approach first. This doesn't work because of the blocking behavior in production." },
    ];
    const result = extractAntipatterns(messages);
    if (result.length > 0) {
      expect(result[0]!.context).toContain("synchronous");
    }
  });
});
