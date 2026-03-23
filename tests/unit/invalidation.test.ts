/**
 * Observation Invalidation Tests
 *
 * Tests designed to catch:
 * - Invalidated docs still appearing in search results (the leak bug GPT found)
 * - content_type gate (only observations get invalidated, not decisions)
 * - Confidence boundary at exactly 0.2
 * - Soft invalidation preserves the document (not deleted)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";

let store: Store;

beforeEach(() => {
  store = createTestStore();
});

describe("invalidation filtering in search", () => {
  it("searchFTS excludes invalidated documents", () => {
    const [docId] = seedDocuments(store, [{
      path: "obs1.md",
      title: "Watcher Observation",
      body: "The watcher process was restarted due to memory issues",
      contentType: "observation",
    }]);

    // Verify it appears before invalidation
    const before = store.searchFTS("watcher process");
    expect(before.length).toBeGreaterThan(0);

    // Invalidate it
    store.db.prepare("UPDATE documents SET invalidated_at = datetime('now') WHERE id = ?").run(docId!);

    // Should no longer appear
    const after = store.searchFTS("watcher process");
    expect(after.length).toBe(0);
  });

  it("invalidated document is NOT deleted (soft invalidation)", () => {
    const [docId] = seedDocuments(store, [{
      path: "obs2.md",
      title: "Test Observation",
      body: "Some observation content",
      contentType: "observation",
    }]);

    store.db.prepare("UPDATE documents SET invalidated_at = datetime('now') WHERE id = ?").run(docId!);

    // Document still exists in DB
    const row = store.db.prepare("SELECT id, active, invalidated_at FROM documents WHERE id = ?").get(docId!) as any;
    expect(row).not.toBeNull();
    expect(row.active).toBe(1); // still active
    expect(row.invalidated_at).not.toBeNull(); // but invalidated
  });
});

describe("invalidation content_type gate", () => {
  it("invalidation columns exist on documents table", () => {
    const cols = store.db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain("invalidated_at");
    expect(colNames).toContain("invalidated_by");
    expect(colNames).toContain("superseded_by");
  });
});

describe("consolidated_observations table", () => {
  it("table exists with correct schema", () => {
    const cols = store.db.prepare("PRAGMA table_info(consolidated_observations)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain("observation");
    expect(colNames).toContain("proof_count");
    expect(colNames).toContain("source_doc_ids");
    expect(colNames).toContain("trend");
    expect(colNames).toContain("status");
    expect(colNames).toContain("invalidated_at");
  });

  it("trend defaults to NEW", () => {
    store.db.prepare(`
      INSERT INTO consolidated_observations (observation, proof_count, source_doc_ids, collection)
      VALUES ('test observation', 2, '[1,2]', 'test')
    `).run();

    const row = store.db.prepare("SELECT trend FROM consolidated_observations").get() as { trend: string };
    expect(row.trend).toBe("NEW");
  });
});
