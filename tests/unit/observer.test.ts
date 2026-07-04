import { describe, it, expect } from "bun:test";
import { parseObservationXml, parseSummaryXml, classifyMessages, prepareTranscript } from "../../src/observer.ts";
import type { TranscriptMessage } from "../../src/hooks.ts";

// ─── parseObservationXml ────────────────────────────────────────────

describe("parseObservationXml", () => {
  it("extracts type, title, and narrative", () => {
    const xml = `
      <type>decision</type>
      <title>Use PostgreSQL for primary store</title>
      <narrative>We evaluated several databases and chose PostgreSQL.</narrative>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).toBeDefined();
    expect(obs!.type).toBe("decision");
    expect(obs!.title).toBe("Use PostgreSQL for primary store");
    expect(obs!.narrative).toContain("PostgreSQL");
  });

  it("returns null without type", () => {
    const xml = `<title>Missing Type</title>`;
    expect(parseObservationXml(xml)).toBeNull();
  });

  it("returns null without title", () => {
    const xml = `<type>decision</type>`;
    expect(parseObservationXml(xml)).toBeNull();
  });

  it("rejects invalid observation type", () => {
    const xml = `<type>invalid_type</type><title>Test</title>`;
    expect(parseObservationXml(xml)).toBeNull();
  });

  it("truncates title to 80 chars", () => {
    const longTitle = "A".repeat(120);
    const xml = `<type>bugfix</type><title>${longTitle}</title>`;
    const obs = parseObservationXml(xml);
    expect(obs).toBeDefined();
    expect(obs!.title.length).toBeLessThanOrEqual(80);
  });

  it("extracts facts, filtering short ones", () => {
    const xml = `
      <type>discovery</type>
      <title>Found pattern</title>
      <fact>This is a valid fact that exceeds the minimum length</fact>
      <fact>Too</fact>
      <fact>Another valid fact about the system architecture design</fact>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).toBeDefined();
    expect(obs!.facts).toHaveLength(2);
  });

  it("validates concepts against whitelist", () => {
    const xml = `
      <type>refactor</type>
      <title>Clean up auth</title>
      <concept>how-it-works</concept>
      <concept>invalid-concept</concept>
      <concept>gotcha</concept>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).toBeDefined();
    expect(obs!.concepts).toContain("how-it-works");
    expect(obs!.concepts).toContain("gotcha");
    expect(obs!.concepts).not.toContain("invalid-concept");
  });

  it("extracts files read and modified from parent tags", () => {
    const xml = `
      <type>change</type>
      <title>Updated config</title>
      <files_read><file>src/config.ts</file></files_read>
      <files_modified><file>src/config.ts</file><file>src/store.ts</file></files_modified>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).toBeDefined();
    expect(obs!.filesRead).toContain("src/config.ts");
    expect(obs!.filesModified).toHaveLength(2);
  });

  it("rejects unknown types", () => {
    const xml = `<type>unknown_type</type><title>Test</title>`;
    expect(parseObservationXml(xml)).toBeNull();
  });

  it("handles all valid observation types", () => {
    const types = ["decision", "bugfix", "feature", "refactor", "discovery", "change", "preference", "milestone", "problem"] as const;
    for (const type of types) {
      const xml = `<type>${type}</type><title>Test ${type}</title>`;
      const obs = parseObservationXml(xml);
      expect(obs).toBeDefined();
      expect(obs!.type).toBe(type);
    }
  });
});

// ─── parseSummaryXml ────────────────────────────────────────────────

describe("parseSummaryXml", () => {
  it("extracts all summary fields", () => {
    const xml = `
      <request>Fix the auth bug</request>
      <investigated>Checked JWT validation</investigated>
      <learned>Token expiry was wrong</learned>
      <completed>Fixed token expiry logic</completed>
      <next_steps>Add tests for JWT</next_steps>
    `;
    const summary = parseSummaryXml(xml);
    expect(summary).toBeDefined();
    expect(summary!.request).toBe("Fix the auth bug");
    expect(summary!.completed).toContain("token expiry");
    expect(summary!.nextSteps).toContain("JWT");
  });

  it("returns null without request AND completed", () => {
    const xml = `<investigated>Something</investigated>`;
    expect(parseSummaryXml(xml)).toBeNull();
  });

  it("defaults missing fields to 'None' or 'Unknown'", () => {
    const xml = `<request>Fix bug</request>`;
    const summary = parseSummaryXml(xml);
    expect(summary).toBeDefined();
    expect(summary!.investigated).toBe("None");
    expect(summary!.learned).toBe("None");
    expect(summary!.completed).toBe("None");
    expect(summary!.nextSteps).toBe("None");
  });

  it("accepts completed without request", () => {
    const xml = `<completed>Done with refactoring</completed>`;
    const summary = parseSummaryXml(xml);
    expect(summary).toBeDefined();
    expect(summary!.request).toBe("Unknown");
    expect(summary!.completed).toBe("Done with refactoring");
  });
});

// ─── classifyMessages (Priority-Based Transcript Formatting) ───────

describe("classifyMessages", () => {
  it("assigns P0 to first user message", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Fix the auth bug" },
      { role: "assistant", content: "Looking into it..." },
      { role: "user", content: "Also check logging" },
    ];
    const classified = classifyMessages(msgs);
    expect(classified[0]!.priority).toBe(0); // P0
    expect(classified[2]!.priority).toBe(3); // P3 (second user msg is conversation)
  });

  it("assigns P1 to last assistant message", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Do something" },
      { role: "assistant", content: "Step 1..." },
      { role: "assistant", content: "Done! Here's the result." },
    ];
    const classified = classifyMessages(msgs);
    expect(classified[1]!.priority).toBe(3); // P3 (non-final assistant)
    expect(classified[2]!.priority).toBe(1); // P1 (final assistant)
  });

  it("assigns P2 to tool_use and tool_result messages", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Read config.ts" },
      { role: "assistant", content: '[tool_use name="Read" id="123"] {"path": "config.ts"}' },
      { role: "assistant", content: '[tool_result id="123"] file contents here' },
      { role: "assistant", content: "The file contains..." },
    ];
    const classified = classifyMessages(msgs);
    expect(classified[1]!.priority).toBe(2); // P2 (tool_use)
    expect(classified[2]!.priority).toBe(2); // P2 (tool_result)
    expect(classified[3]!.priority).toBe(1); // P1 (final assistant)
  });

  it("tool message at end stays P2, not P1", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Read the file" },
      { role: "assistant", content: "Let me read it." },
      { role: "assistant", content: '[tool_use name="Read" id="999"] {"path": "x.ts"}' },
    ];
    const classified = classifyMessages(msgs);
    // Last message is tool content — should be P2, not P1
    expect(classified[2]!.priority).toBe(2);
    // The real final response is the assistant text before it
    expect(classified[1]!.priority).toBe(1);
  });

  it("all-tool transcript has no P1", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Read all files" },
      { role: "assistant", content: '[tool_use name="Read" id="1"] {}' },
      { role: "assistant", content: '[tool_result id="1"] contents' },
    ];
    const classified = classifyMessages(msgs);
    // No real assistant text → no P1 assigned
    expect(classified.filter(m => m.priority === 1)).toHaveLength(0);
    // Tool messages are P2
    expect(classified[1]!.priority).toBe(2);
    expect(classified[2]!.priority).toBe(2);
  });

  it("assigns P4 to system messages", () => {
    const msgs: TranscriptMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const classified = classifyMessages(msgs);
    expect(classified[0]!.priority).toBe(4); // P4 (system)
  });
});

// ─── prepareTranscript (Priority-Based Budgeting) ──────────────────

describe("prepareTranscript", () => {
  it("always includes first user message and last assistant message", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Original request" },
      { role: "assistant", content: "Mid conversation..." },
      { role: "assistant", content: "Final answer here." },
    ];
    const result = prepareTranscript(msgs);
    expect(result).toContain("Original request");
    expect(result).toContain("Final answer here.");
  });

  it("preserves chronological order in output", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "First" },
      { role: "assistant", content: "Second" },
      { role: "assistant", content: "Third" },
    ];
    const result = prepareTranscript(msgs);
    const firstIdx = result.indexOf("First");
    const thirdIdx = result.indexOf("Third");
    expect(firstIdx).toBeLessThan(thirdIdx);
  });

  it("prioritizes P0/P1 over P3 when budget is tight", () => {
    // Create messages where P0+P1 take most of the budget
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "A".repeat(300) },  // P0
      { role: "assistant", content: "B".repeat(300) }, // P3 (mid)
      { role: "assistant", content: "C".repeat(300) }, // P3 (mid)
      { role: "assistant", content: "D".repeat(300) }, // P1 (final)
    ];
    // With a tight budget, P0 + P1 should survive, P3 may be dropped
    const result = prepareTranscript(msgs);
    expect(result).toContain("A".repeat(100)); // P0 present (may be truncated by role limit)
    expect(result).toContain("D".repeat(100)); // P1 present
  });

  it("includes tool messages before conversation when budget allows", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Read the file" },
      { role: "assistant", content: '[tool_use name="Read"] {"path": "test.ts"}' },
      { role: "assistant", content: "Here is what I found." },
    ];
    const result = prepareTranscript(msgs);
    expect(result).toContain("tool_use");
    expect(result).toContain("Here is what I found.");
  });

  it("returns empty string for empty input", () => {
    expect(prepareTranscript([])).toBe("");
  });

  it("truncates tool messages to fit, not drops", () => {
    // Create a scenario where P0+P1 leave limited room for a large tool message
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "Do something" },               // P0: small
      { role: "assistant", content: '[tool_use name="Bash" id="1"] ' + "X".repeat(2000) }, // P2: large
      { role: "assistant", content: "Done." },                  // P1: small
    ];
    const result = prepareTranscript(msgs);
    // Tool message should be present (truncated), not entirely dropped
    expect(result).toContain("tool_use");
    // But truncated — not the full 2000 X's
    expect(result.split("X").length - 1).toBeLessThan(2000);
  });
});

// ─── New observation types (v0.5.0) ─────────────────────────────────

describe("new observation types", () => {
  it("accepts 'preference' as valid type", () => {
    const xml = `<type>preference</type><title>User prefers single PRs</title><narrative>Validated approach.</narrative>`;
    const obs = parseObservationXml(xml);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe("preference");
  });

  it("accepts 'milestone' as valid type", () => {
    const xml = `<type>milestone</type><title>v0.5.0 released</title><narrative>Major release with conversation import.</narrative>`;
    const obs = parseObservationXml(xml);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe("milestone");
  });

  it("accepts 'problem' as valid type", () => {
    const xml = `<type>problem</type><title>SQLite contention under load</title><narrative>Watcher locks conflict with hooks.</narrative>`;
    const obs = parseObservationXml(xml);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe("problem");
  });
});
