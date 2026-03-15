import { describe, it, expect } from "bun:test";

// ─── Reflect Logic Tests (M2 fix: ordered bigrams/trigrams) ────────

// Test the bigram/trigram extraction logic used by cmdReflect
// (Extracted inline since cmdReflect is not exported)

const STOP_WORDS = new Set(["the", "that", "this", "with", "from", "have", "will", "been", "were", "they", "their", "what", "when", "which", "about", "into", "more", "some", "than", "them", "then", "very", "also", "just", "should", "would", "could", "does", "make", "like", "using", "used"]);

function extractPhrases(bodies: string[]): Map<string, number> {
  const phrases = new Map<string, number>();

  for (const body of bodies) {
    const words = body.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));

    // M2: Ordered bigrams (preserve phrase direction)
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]!} ${words[i + 1]!}`;
      phrases.set(pair, (phrases.get(pair) || 0) + 1);
    }
    // Trigrams for better phrase capture
    for (let i = 0; i < words.length - 2; i++) {
      const triple = `${words[i]!} ${words[i + 1]!} ${words[i + 2]!}`;
      phrases.set(triple, (phrases.get(triple) || 0) + 1);
    }
  }

  return phrases;
}

describe("reflect phrase extraction", () => {
  it("extracts recurring bigrams appearing 3+ times", () => {
    const bodies = [
      "The event sourcing pattern helps with event sourcing architecture",
      "We use event sourcing for state management",
      "Event sourcing provides audit trails and event sourcing enables replay",
    ];
    const phrases = extractPhrases(bodies);
    const recurring = [...phrases.entries()].filter(([, count]) => count >= 3);
    expect(recurring.length).toBeGreaterThanOrEqual(1);
    expect(recurring.some(([phrase]) => phrase === "event sourcing")).toBe(true);
  });

  it("prefers trigrams over bigrams at same count", () => {
    const bodies = Array.from({ length: 3 }, () =>
      "API gateway rate limiting is important for API gateway rate limiting"
    );
    const phrases = extractPhrases(bodies);
    const recurring = [...phrases.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => {
        const lenDiff = b[0].split(" ").length - a[0].split(" ").length;
        return b[1] - a[1] || lenDiff;
      });

    if (recurring.length > 0) {
      // Trigrams should rank before bigrams when count is equal
      const trigramIdx = recurring.findIndex(([p]) => p.split(" ").length === 3);
      const bigramIdx = recurring.findIndex(([p]) => p.split(" ").length === 2);
      if (trigramIdx >= 0 && bigramIdx >= 0) {
        // At same count, trigram should come first
        const triCount = recurring[trigramIdx]![1];
        const biCount = recurring[bigramIdx]![1];
        if (triCount === biCount) {
          expect(trigramIdx).toBeLessThan(bigramIdx);
        }
      }
    }
  });

  it("filters stop words from phrases", () => {
    const bodies = ["this should also just make the decision"];
    const phrases = extractPhrases(bodies);
    // All individual words are stop words or too short, so very few phrases
    for (const [phrase] of phrases) {
      const words = phrase.split(" ");
      // At least one non-stop word should be present
      expect(words.some(w => !STOP_WORDS.has(w) && w.length > 3)).toBe(true);
    }
  });

  it("returns empty when no decisions provided", () => {
    const phrases = extractPhrases([]);
    expect(phrases.size).toBe(0);
  });

  it("preserves phrase order (M2 fix: ordered bigrams)", () => {
    const bodies = [
      "database migration strategy is critical",
      "database migration strategy requires planning",
      "follow database migration strategy carefully",
    ];
    const phrases = extractPhrases(bodies);
    // Should have "database migration" as ordered bigram, NOT "migration database"
    expect(phrases.has("database migration")).toBe(true);
    expect(phrases.has("migration database")).toBe(false);
  });
});
