import { describe, it, expect } from "bun:test";

// We need to test extractTripleFromFact which is not exported.
// Import the module and test indirectly via observable behavior,
// or extract the function. For now, test the regex patterns directly.

// Replicate the extraction logic for testing (mirrors decision-extractor.ts)
type ExtractedTriple = {
  subject: string;
  subjectId: string;
  predicate: string;
  object: string;
  objectId: string | null;
};

function toEntityId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function extractTripleFromFact(fact: string, obsType: string): ExtractedTriple | null {
  if (!["decision", "preference", "milestone", "problem"].includes(obsType)) return null;

  const verbPatterns = [
    /^(.+?)\s+(chose|selected|switched to|migrated to|adopted)\s+(.+?)\.?$/i,
    /^(.+?)\s+(depends on|integrates with|connects to)\s+(.+?)\.?$/i,
    /^(.+?)\s+(deployed to|runs on|hosted on|installed on)\s+(.+?)\.?$/i,
    /^(.+?)\s+(replaced|superseded|deprecated)\s+(.+?)\.?$/i,
  ];

  for (const pattern of verbPatterns) {
    const match = fact.match(pattern);
    if (match) {
      const subject = match[1]!.trim();
      const predicate = match[2]!.trim();
      const object = match[3]!.trim();
      if (subject.length < 3 || object.length < 3 || subject.length > 60 || object.length > 60) continue;
      if (subject.includes(",") || object.includes(",")) continue;
      return { subject, subjectId: toEntityId(subject), predicate: predicate.toLowerCase().replace(/\s+/g, "_"), object, objectId: toEntityId(object) };
    }
  }

  if (obsType === "preference") {
    const prefMatch = fact.match(/^(?:user\s+)?(?:prefers?|avoids?)\s+(.+?)\.?$/i);
    if (prefMatch && prefMatch[1]!.trim().length > 2) {
      return { subject: "user", subjectId: "user", predicate: "prefers", object: prefMatch[1]!.trim(), objectId: null };
    }
  }

  return null;
}

// ─── Positive matches ──────────────────────────────────────────────

describe("extractTripleFromFact — positive matches", () => {
  it("extracts 'chose' pattern", () => {
    const t = extractTripleFromFact("ClawMem chose SQLite over ChromaDB", "decision");
    expect(t).not.toBeNull();
    expect(t!.subject).toBe("ClawMem");
    expect(t!.predicate).toBe("chose");
    expect(t!.object).toBe("SQLite over ChromaDB");
  });

  it("extracts 'switched to' pattern", () => {
    const t = extractTripleFromFact("Project switched to GraphQL", "decision");
    expect(t).not.toBeNull();
    expect(t!.predicate).toBe("switched_to");
  });

  it("extracts 'deployed to' pattern", () => {
    const t = extractTripleFromFact("ClawMem deployed to VM 202", "milestone");
    expect(t).not.toBeNull();
    expect(t!.predicate).toBe("deployed_to");
  });

  it("extracts 'replaced' pattern", () => {
    const t = extractTripleFromFact("ZeroEntropy replaced EmbeddingGemma", "decision");
    expect(t).not.toBeNull();
    expect(t!.predicate).toBe("replaced");
  });

  it("extracts 'depends on' pattern", () => {
    const t = extractTripleFromFact("ClawMem depends on Bun runtime", "decision");
    expect(t).not.toBeNull();
    expect(t!.predicate).toBe("depends_on");
  });

  it("extracts preference literal", () => {
    const t = extractTripleFromFact("User prefers single PRs for refactors", "preference");
    expect(t).not.toBeNull();
    expect(t!.subject).toBe("user");
    expect(t!.predicate).toBe("prefers");
    expect(t!.object).toBe("single PRs for refactors");
    expect(t!.objectId).toBeNull(); // literal, not entity
  });

  it("extracts 'avoids' as preference", () => {
    const t = extractTripleFromFact("User avoids shell timeout wrappers", "preference");
    expect(t).not.toBeNull();
    expect(t!.predicate).toBe("prefers"); // mapped to prefers
  });
});

// ─── Negative matches (should NOT extract) ─────────────────────────

describe("extractTripleFromFact — negative matches", () => {
  it("rejects bugfix type entirely", () => {
    expect(extractTripleFromFact("Fixed the timeout bug", "bugfix")).toBeNull();
  });

  it("rejects feature type entirely", () => {
    expect(extractTripleFromFact("Added new search mode", "feature")).toBeNull();
  });

  it("rejects change type entirely", () => {
    expect(extractTripleFromFact("Updated the config", "change")).toBeNull();
  });

  it("rejects subjects with commas (likely sentences)", () => {
    const t = extractTripleFromFact("After careful analysis, team chose React", "decision");
    expect(t).toBeNull(); // comma in subject
  });

  it("rejects very short subjects", () => {
    const t = extractTripleFromFact("It chose SQLite", "decision");
    // "It" is only 2 chars
    expect(t).toBeNull();
  });

  it("does not extract 'uses' or 'needs' (too broad)", () => {
    const t = extractTripleFromFact("ClawMem uses hybrid search", "decision");
    expect(t).toBeNull(); // 'uses' removed from patterns
  });

  it("does not extract plain narrative facts", () => {
    const t = extractTripleFromFact("The system performed well under load", "decision");
    expect(t).toBeNull();
  });
});

// ─── Entity ID generation ──────────────────────────────────────────

describe("toEntityId", () => {
  it("lowercases and slugifies", () => {
    expect(toEntityId("ClawMem")).toBe("clawmem");
    expect(toEntityId("VM 202")).toBe("vm_202");
    expect(toEntityId("SQLite + Bun")).toBe("sqlite_bun");
  });

  it("strips leading/trailing underscores", () => {
    expect(toEntityId(" spaces ")).toBe("spaces");
  });
});
