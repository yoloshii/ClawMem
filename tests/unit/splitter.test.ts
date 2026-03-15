import { describe, it, expect } from "bun:test";
import { splitDocument, splitObservation, type Fragment } from "../../src/splitter.ts";

// ─── splitDocument ──────────────────────────────────────────────────

describe("splitDocument", () => {
  it("always includes 'full' fragment as first element", () => {
    const frags = splitDocument("Some content");
    expect(frags[0]!.type).toBe("full");
    expect(frags[0]!.content).toBe("Some content");
  });

  it("returns only full fragment for short docs (<200 chars)", () => {
    const frags = splitDocument("Short doc");
    expect(frags).toHaveLength(1);
    expect(frags[0]!.type).toBe("full");
  });

  it("extracts sections from ## headings", () => {
    const doc = `# Title

${"x".repeat(50)}

## Section One

${"This is section one content that is long enough to be a fragment. ".repeat(3)}

## Section Two

${"This is section two content that is also long enough for extraction. ".repeat(3)}
`;
    const frags = splitDocument(doc);
    const sections = frags.filter(f => f.type === "section");
    expect(sections.length).toBeGreaterThanOrEqual(1);
    expect(sections.some(s => s.label === "Section One")).toBe(true);
  });

  it("extracts bullet lists (2+ items)", () => {
    const doc = `# Doc

${"x".repeat(100)}

- First item in the list that needs to be long enough
- Second item in the list that also needs to be long enough for the fragment

${"x".repeat(100)}
`;
    const frags = splitDocument(doc);
    const lists = frags.filter(f => f.type === "list");
    expect(lists.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts code blocks with language label", () => {
    const doc = `# Doc

${"x".repeat(100)}

\`\`\`typescript
const config = loadConfig();
server.listen(config.port);
// More code to make the fragment long enough for extraction threshold
const db = new Database();
await db.connect();
\`\`\`

More text here.
`;
    const frags = splitDocument(doc);
    const codes = frags.filter(f => f.type === "code");
    expect(codes.length).toBeGreaterThanOrEqual(1);
    if (codes.length > 0) {
      expect(codes[0]!.label).toBe("typescript");
    }
  });

  it("extracts frontmatter key-value pairs", () => {
    const frags = splitDocument("x".repeat(300), {
      domain: "backend-services",
      workstream: "authentication-flow",
    });
    const fm = frags.filter(f => f.type === "frontmatter");
    expect(fm.length).toBeGreaterThanOrEqual(1);
    expect(fm.some(f => f.label === "domain")).toBe(true);
  });

  it("skips content_type and tags from frontmatter", () => {
    const frags = splitDocument("x".repeat(300), {
      content_type: "decision",
      tags: ["a", "b"],
      domain: "backend-services",
    });
    const fm = frags.filter(f => f.type === "frontmatter");
    expect(fm.every(f => f.label !== "content_type")).toBe(true);
    expect(fm.every(f => f.label !== "tags")).toBe(true);
  });

  it("truncates section fragments exceeding MAX_FRAGMENT_CHARS (2000)", () => {
    const longSection = `## Long Section\n\n${"x".repeat(3000)}`;
    const doc = `# Title\n\n${longSection}`;
    const frags = splitDocument(doc);
    // Non-full fragments should be truncated at MAX_FRAGMENT_CHARS (2000)
    const nonFull = frags.filter(f => f.type !== "full");
    for (const f of nonFull) {
      expect(f.content.length).toBeLessThanOrEqual(2000);
    }
  });

  it("truncates input at MAX_SPLITTER_INPUT_CHARS", () => {
    const hugeDoc = "x".repeat(600000);
    const frags = splitDocument(hugeDoc);
    // Should not crash and should produce a bounded full fragment
    expect(frags[0]!.content.length).toBeLessThanOrEqual(500001);
  });
});

// ─── splitObservation ───────────────────────────────────────────────

describe("splitObservation", () => {
  it("includes full fragment", () => {
    const frags = splitObservation("observation body", {});
    expect(frags[0]!.type).toBe("full");
  });

  it("parses JSON facts into individual 'fact' fragments", () => {
    const facts = JSON.stringify([
      "The authentication system uses JWT tokens for stateless session management",
      "Rate limiting is applied at the API gateway level with a 100 req/min default",
    ]);
    const frags = splitObservation("body", { facts });
    const factFrags = frags.filter(f => f.type === "fact");
    expect(factFrags).toHaveLength(2);
  });

  it("includes narrative fragment", () => {
    const narrative = "This session focused on fixing the authentication bug and adding rate limiting to the API gateway layer for better security.";
    const frags = splitObservation("body", { narrative });
    const narr = frags.filter(f => f.type === "narrative");
    expect(narr).toHaveLength(1);
  });

  it("handles invalid JSON in facts gracefully", () => {
    const frags = splitObservation("body", { facts: "not valid json" });
    // Should not throw, just skip
    const factFrags = frags.filter(f => f.type === "fact");
    expect(factFrags).toHaveLength(0);
  });

  it("skips short facts below MIN_FRAGMENT_CHARS (50)", () => {
    const facts = JSON.stringify(["Too short", "This is a longer fact that exceeds the minimum fragment character threshold"]);
    const frags = splitObservation("body", { facts });
    const factFrags = frags.filter(f => f.type === "fact");
    expect(factFrags).toHaveLength(1); // only the long one
  });
});
