// Shared anti-parrot guard — bug-first tests. These assert CORRECT behavior: the guard must reject
// schema/skeleton residue a weak model echoes, WITHOUT false-positiving plausible real content
// (the exact drift the observer comment warns about, e.g. "Example: QMD switched to Bun in v0.2").
import { describe, it, expect } from "bun:test";
import {
  isSchemaPlaceholder,
  SCHEMA_PLACEHOLDER_STRINGS,
  PLACEHOLDER_REGEX,
} from "../../src/schema-placeholder.ts";

describe("isSchemaPlaceholder — rejects residue", () => {
  it("treats empty / whitespace-only as placeholder", () => {
    expect(isSchemaPlaceholder("")).toBe(true);
    expect(isSchemaPlaceholder("   ")).toBe(true);
  });

  it("catches {{...}} skeleton tokens (the new prompt-skeleton residue)", () => {
    expect(isSchemaPlaceholder("{{concise 3-8 word title}}")).toBe(true);
    expect(isSchemaPlaceholder("{{new conclusion combining 2+ observations, 1-2 sentences}}")).toBe(true);
    expect(isSchemaPlaceholder("  {{fact from one source observation}}  ")).toBe(true); // trimmed
  });

  it("catches ${...} and <!-- --> template markers", () => {
    expect(isSchemaPlaceholder("${placeholder}")).toBe(true);
    expect(isSchemaPlaceholder("<!-- fill me in -->")).toBe(true);
  });

  it("catches the known observer + deductive schema strings (case-insensitive)", () => {
    expect(isSchemaPlaceholder("individual atomic fact")).toBe(true);
    expect(isSchemaPlaceholder("Canonical Entity Name")).toBe(true);
    expect(isSchemaPlaceholder("Clear deductive statement")).toBe(true);
    expect(isSchemaPlaceholder("Premise from obs 1")).toBe(true);
    expect(isSchemaPlaceholder("premise from obs 3")).toBe(true);
  });
});

describe("isSchemaPlaceholder — does NOT false-positive real content", () => {
  it("passes a plausible real decision that looks like the old removed example", () => {
    // "Use OAuth 2.0 with PKCE" was the OLD copyable example. It is a plausible REAL decision, so
    // blocklisting it would be a bug — the parrot is killed at the prompt source, not by rejecting
    // this string. This test locks that boundary.
    expect(isSchemaPlaceholder("Use OAuth 2.0 with PKCE")).toBe(false);
    expect(isSchemaPlaceholder("Team decided to use OAuth 2.0 with PKCE")).toBe(false);
  });

  it("passes real facts that merely start with 'Example:' (the documented anti-drift case)", () => {
    expect(isSchemaPlaceholder("Example: QMD switched to Bun in v0.2")).toBe(false);
  });

  it("passes ordinary extracted facts", () => {
    expect(isSchemaPlaceholder("Adopt Bun test runner")).toBe(false);
    expect(isSchemaPlaceholder("Switched the suite to bun test for speed.")).toBe(false);
    expect(isSchemaPlaceholder("3x faster CI")).toBe(false);
  });
});

describe("shared guard contract", () => {
  it("exports the observer + deductive residue strings for reuse", () => {
    // Regression guard: these must stay in the shared set so all three extraction paths agree.
    expect(SCHEMA_PLACEHOLDER_STRINGS.has("individual atomic fact")).toBe(true);
    expect(SCHEMA_PLACEHOLDER_STRINGS.has("clear deductive statement")).toBe(true);
  });

  it("PLACEHOLDER_REGEX matches only the three template-marker shapes", () => {
    expect(PLACEHOLDER_REGEX.test("{{x}}")).toBe(true);
    expect(PLACEHOLDER_REGEX.test("${x}")).toBe(true);
    expect(PLACEHOLDER_REGEX.test("<!--x-->")).toBe(true);
    expect(PLACEHOLDER_REGEX.test("a real fact about {{something}} inline")).toBe(false); // must be at start
  });
});
