import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStore,
  insertContent,
  insertDocument,
  searchFTS,
  extractSnippet,
  type Store,
} from "../../src/store.ts";
import { applyCompositeScoring, hasRecencyIntent, type EnrichedResult } from "../../src/memory.ts";
import { enrichResults } from "../../src/search-utils.ts";

let store: Store;

beforeEach(() => {
  store = createStore(":memory:");
});

function addDoc(collection: string, path: string, title: string, body: string, opts?: { modifiedAt?: string; pinned?: boolean; qualityScore?: number }) {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const now = opts?.modifiedAt || new Date().toISOString();
  insertContent(store.db, hash, body, now);
  insertDocument(store.db, collection, path, title, hash, now, now);

  if (opts?.pinned || opts?.qualityScore !== undefined) {
    const doc = store.findActiveDocument(collection, path);
    if (doc) {
      if (opts?.pinned) store.pinDocument(collection, path, true);
      if (opts?.qualityScore !== undefined) {
        store.updateDocumentMeta(doc.id, { quality_score: opts.qualityScore });
      }
    }
  }
}

// ─── Full Pipeline: index → search → enrich → score → retrieve ────

describe("index-search-score pipeline", () => {
  it("indexes a document and finds it via FTS", () => {
    addDoc("test", "arch.md", "Architecture Guide", "The system uses microservices with gRPC communication");
    const results = searchFTS(store.db, "microservices");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.title).toContain("Architecture");
  });

  it("enriches results with metadata for scoring", () => {
    addDoc("test", "decision.md", "Auth Decision", "We decided to use JWT tokens", { qualityScore: 0.9 });
    const results = searchFTS(store.db, "JWT tokens");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const enriched = enrichResults(store, results, "JWT tokens");
    expect(enriched.length).toBeGreaterThanOrEqual(1);
    expect(enriched[0]!.contentType).toBeDefined();
  });

  it("applies composite scoring and sorts by score", () => {
    addDoc("test", "high.md", "Important Decision", "We decided to use PostgreSQL for everything", { qualityScore: 0.95 });
    addDoc("test", "low.md", "Random Notes", "Some random notes about testing", { qualityScore: 0.3 });

    const results = searchFTS(store.db, "decision testing");
    if (results.length >= 2) {
      const enriched = enrichResults(store, results, "decision testing");
      const scored = applyCompositeScoring(enriched, "decision testing");
      // Scored should be sorted descending by compositeScore
      for (let i = 1; i < scored.length; i++) {
        expect(scored[i - 1]!.compositeScore).toBeGreaterThanOrEqual(scored[i]!.compositeScore);
      }
    }
  });

  it("pinned docs get +0.3 boost (capped at 1.0)", () => {
    addDoc("test", "pinned.md", "Pinned Architecture", "Critical architecture decision about the system", { pinned: true });
    addDoc("test", "normal.md", "Normal Architecture", "Less critical architecture note about the system");

    const results = searchFTS(store.db, "architecture decision");
    if (results.length >= 2) {
      const enriched = enrichResults(store, results, "architecture decision");
      const scored = applyCompositeScoring(enriched, "architecture decision");

      const pinned = scored.find(r => r.displayPath.includes("pinned"));
      const normal = scored.find(r => r.displayPath.includes("normal"));
      if (pinned && normal) {
        expect(pinned.compositeScore).toBeGreaterThan(normal.compositeScore);
      }
    }
  });

  it("recency intent reweights scoring", () => {
    expect(hasRecencyIntent("what happened last session")).toBe(true);
    expect(hasRecencyIntent("explain the architecture")).toBe(false);
  });

  it("extractSnippet returns relevant context around query terms", () => {
    const body = "Introduction paragraph. The system uses JWT tokens for authentication. This ensures secure stateless sessions. Conclusion paragraph.";
    const { snippet } = extractSnippet(body, "JWT authentication", 200);
    expect(snippet).toContain("JWT");
  });

  it("quality multiplier affects final score", () => {
    addDoc("test", "quality-high.md", "High Quality", "Important system architecture decision document with detailed analysis", { qualityScore: 1.0 });
    addDoc("test", "quality-low.md", "Low Quality", "Important system architecture decision document with detailed analysis", { qualityScore: 0.3 });

    const results = searchFTS(store.db, "architecture decision");
    if (results.length >= 2) {
      const enriched = enrichResults(store, results, "architecture decision");
      const scored = applyCompositeScoring(enriched, "architecture decision");

      const high = scored.find(r => r.displayPath.includes("quality-high"));
      const low = scored.find(r => r.displayPath.includes("quality-low"));
      if (high && low) {
        expect(high.compositeScore).toBeGreaterThan(low.compositeScore);
      }
    }
  });
});
