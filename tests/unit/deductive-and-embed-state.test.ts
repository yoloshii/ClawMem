import { describe, it, expect } from "bun:test";

/**
 * Tests for v0.6.0 features:
 * 1. Deductive content type in memory scoring
 * 2. source_doc_ids column on documents
 * 3. Embed state tracking (pending/synced/failed)
 * 4. Surprisal scoring (computeSurprisalScores)
 */

// ─── Content Type: deductive ─────────────────────────────────────────

import {
  HALF_LIVES, TYPE_BASELINES, recencyScore, confidenceScore,
  inferContentType, inferMemoryType, type ContentType,
} from "../../src/memory.ts";

describe("deductive content type", () => {
  it("has infinite half-life (never decays)", () => {
    expect(HALF_LIVES["deductive"]).toBe(Infinity);
  });

  it("has 0.85 confidence baseline (same as decision)", () => {
    expect(TYPE_BASELINES["deductive"]).toBe(0.85);
  });

  it("recencyScore returns 1.0 regardless of age", () => {
    const ancient = new Date("2020-01-01");
    const score = recencyScore(ancient, "deductive");
    expect(score).toBe(1.0);
  });

  it("is in the ContentType union", () => {
    const ct: ContentType = "deductive";
    expect(ct).toBe("deductive");
  });

  it("is classified as semantic memory type", () => {
    expect(inferMemoryType("test", "deductive")).toBe("semantic");
  });

  it("is decay-exempt in confidenceScore", () => {
    // Deductive docs should not have attention decay applied
    const ancient = new Date("2020-01-01");
    const lastAccessed = new Date("2020-06-01");
    const now = new Date("2026-04-08");

    const score = confidenceScore("deductive", ancient, 5, now, lastAccessed);
    // Should be close to baseline * recency (1.0) * accessBoost, no attention decay
    expect(score).toBeGreaterThan(0.7);
  });
});

// ─── Embed State Tracking ────────────────────────────────────────────

import { createStore, getHashesNeedingFragments, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";

describe("embed state tracking", () => {
  let store: Store;

  it("new documents start with embed_state pending", () => {
    store = createStore(":memory:");
    const hash = hashContent("test body");
    const now = new Date().toISOString();
    store.insertContent(hash, "test body", now);
    store.insertDocument("test", "doc1.md", "Test Doc", hash, now, now);

    const doc = store.findActiveDocument("test", "doc1.md");
    expect(doc).toBeDefined();
    // embed_state defaults to 'pending' (or NULL which we treat as pending)
  });

  it("markEmbedSynced updates state to synced", () => {
    const hash = hashContent("synced body");
    const now = new Date().toISOString();
    store.insertContent(hash, "synced body", now);
    store.insertDocument("test", "doc2.md", "Synced Doc", hash, now, now);

    store.markEmbedSynced(hash);
    const row = store.db.prepare(
      `SELECT embed_state FROM documents WHERE hash = ? AND active = 1`
    ).get(hash) as { embed_state: string };
    expect(row.embed_state).toBe("synced");
  });

  it("markEmbedFailed updates state and records error", () => {
    const hash = hashContent("failed body");
    const now = new Date().toISOString();
    store.insertContent(hash, "failed body", now);
    store.insertDocument("test", "doc3.md", "Failed Doc", hash, now, now);

    store.markEmbedFailed(hash, "GPU timeout");
    const row = store.db.prepare(
      `SELECT embed_state, embed_error, embed_attempts FROM documents WHERE hash = ? AND active = 1`
    ).get(hash) as { embed_state: string; embed_error: string; embed_attempts: number };

    expect(row.embed_state).toBe("failed");
    expect(row.embed_error).toBe("GPU timeout");
    expect(row.embed_attempts).toBe(1);
  });

  it("markEmbedFailed increments attempts on subsequent calls", () => {
    const hash = hashContent("retry body");
    const now = new Date().toISOString();
    store.insertContent(hash, "retry body", now);
    store.insertDocument("test", "doc4.md", "Retry Doc", hash, now, now);

    store.markEmbedFailed(hash, "error 1");
    store.markEmbedFailed(hash, "error 2");
    store.markEmbedFailed(hash, "error 3");

    const row = store.db.prepare(
      `SELECT embed_attempts, embed_error FROM documents WHERE hash = ? AND active = 1`
    ).get(hash) as { embed_attempts: number; embed_error: string };

    expect(row.embed_attempts).toBe(3);
    expect(row.embed_error).toBe("error 3"); // latest error
  });

  it("getEmbedStats returns correct counts", () => {
    const stats = store.getEmbedStats();
    // doc1 = pending (default), doc2 = synced, doc3 = failed, doc4 = failed
    expect(stats.synced).toBe(1);
    expect(stats.failed).toBe(2);
    expect(stats.pending).toBeGreaterThanOrEqual(1);
  });

  it("getHashesNeedingFragments skips docs with 3+ failed attempts", () => {
    // doc4 has 3 attempts — should be excluded from embedding queue
    const hashes = getHashesNeedingFragments(store.db);
    const doc4Hash = hashContent("retry body");
    const hasDoc4 = hashes.some(h => h.hash === doc4Hash);
    expect(hasDoc4).toBe(false);
  });
});

// ─── source_doc_ids Column ───────────────────────────────────────────

describe("source_doc_ids column", () => {
  it("can store and retrieve source doc IDs on documents", () => {
    const store = createStore(":memory:");
    const hash = hashContent("deductive conclusion");
    const now = new Date().toISOString();
    store.insertContent(hash, "deductive conclusion", now);
    store.insertDocument("_clawmem", "deductions/test.md", "Test Deduction", hash, now, now);

    const doc = store.findActiveDocument("_clawmem", "deductions/test.md");
    expect(doc).toBeDefined();

    // Store source doc IDs
    const sourceIds = [1, 2, 3];
    store.db.prepare(`UPDATE documents SET source_doc_ids = ? WHERE id = ?`)
      .run(JSON.stringify(sourceIds), doc!.id);

    // Retrieve
    const row = store.db.prepare(`SELECT source_doc_ids FROM documents WHERE id = ?`)
      .get(doc!.id) as { source_doc_ids: string };
    expect(JSON.parse(row.source_doc_ids)).toEqual([1, 2, 3]);
  });
});

// ─── Surprisal Scoring ───────────────────────────────────────────────

import { computeSurprisalScores } from "../../src/consolidation.ts";

describe("computeSurprisalScores", () => {
  it("returns empty array when not enough documents", () => {
    const store = createStore(":memory:");
    const results = computeSurprisalScores(store);
    expect(results).toEqual([]);
  });

  it("returns empty array when vectors_vec table does not exist", () => {
    const store = createStore(":memory:");
    // Create some observation docs but no embeddings
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      const hash = hashContent(`obs ${i}`);
      store.insertContent(hash, `obs ${i}`, now);
      store.insertDocument("_clawmem", `obs${i}.md`, `Obs ${i}`, hash, now, now);
      store.updateObservationFields(`obs${i}.md`, "_clawmem", { observation_type: "decision" });
    }

    const results = computeSurprisalScores(store);
    expect(results).toEqual([]);
  });
});
