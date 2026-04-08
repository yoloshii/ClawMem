import { describe, it, expect } from "bun:test";
import { parseObservationXml, parseSummaryXml } from "../../src/observer.ts";

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
