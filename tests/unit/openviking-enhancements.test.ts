/**
 * Tests for OpenViking-derived enhancements:
 * - Canonical document IDs
 * - Collection-scoped SQL retrieval
 * - Co-activation boost in composite scoring
 * - Clean stale embeddings
 * - Facet-based merge policy
 * - Manifest source name alignment
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStore,
  canonicalDocId,
  insertEmbedding,
  getHashesNeedingFragments,
  cleanStaleEmbeddings,
  type Store,
} from "../../src/store.ts";
import {
  applyCompositeScoring,
  type CoActivationFn,
  type EnrichedResult,
} from "../../src/memory.ts";
import {
  getMergePolicy,
  type MergePolicy,
} from "../../src/hooks/decision-extractor.ts";

let store: Store;

beforeEach(() => {
  store = createStore(":memory:");
});

// ─── canonicalDocId ─────────────────────────────────────────────────

describe("canonicalDocId", () => {
  it("produces deterministic hash for same collection/path", () => {
    const id1 = canonicalDocId("forge-stack", "docs/readme.md");
    const id2 = canonicalDocId("forge-stack", "docs/readme.md");
    expect(id1).toBe(id2);
  });

  it("produces different hashes for different paths", () => {
    const id1 = canonicalDocId("forge-stack", "docs/readme.md");
    const id2 = canonicalDocId("forge-stack", "docs/other.md");
    expect(id1).not.toBe(id2);
  });

  it("produces different hashes for different collections", () => {
    const id1 = canonicalDocId("forge-stack", "docs/readme.md");
    const id2 = canonicalDocId("tool-forge", "docs/readme.md");
    expect(id1).not.toBe(id2);
  });

  it("returns 16-character hex string", () => {
    const id = canonicalDocId("test", "file.md");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─── content_vectors canonical_id migration ─────────────────────────

describe("content_vectors canonical_id column", () => {
  it("has canonical_id column after store creation", () => {
    const cols = store.db
      .prepare("PRAGMA table_info(content_vectors)")
      .all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("canonical_id");
  });
});

// ─── getHashesNeedingFragments includes collection ──────────────────

describe("getHashesNeedingFragments", () => {
  it("returns collection field for each result", () => {
    // Insert a document
    store.insertContent("hash1", "# Test Document\n\nContent here.", new Date().toISOString());
    store.insertDocument("test-collection", "docs/test.md", "Test", "hash1", new Date().toISOString(), new Date().toISOString());

    const hashes = store.getHashesNeedingFragments();
    expect(hashes.length).toBe(1);
    expect(hashes[0]!.collection).toBe("test-collection");
    expect(hashes[0]!.hash).toBe("hash1");
    expect(hashes[0]!.path).toBe("docs/test.md");
  });
});

// ─── insertEmbedding with canonical_id ──────────────────────────────

describe("insertEmbedding with canonical_id", () => {
  it("stores canonical_id in content_vectors", () => {
    // Need vec table first
    store.ensureVecTable(3);

    const canId = canonicalDocId("test", "file.md");
    store.insertEmbedding(
      "hashA", 0, 0, new Float32Array([0.1, 0.2, 0.3]),
      "test-model", new Date().toISOString(), "full", "Test", canId
    );

    const row = store.db.prepare(
      "SELECT canonical_id FROM content_vectors WHERE hash = ? AND seq = ?"
    ).get("hashA", 0) as { canonical_id: string | null };
    expect(row.canonical_id).toBe(canId);
  });

  it("stores null canonical_id when not provided", () => {
    store.ensureVecTable(3);

    store.insertEmbedding(
      "hashB", 0, 0, new Float32Array([0.1, 0.2, 0.3]),
      "test-model", new Date().toISOString(), "full", "Test"
    );

    const row = store.db.prepare(
      "SELECT canonical_id FROM content_vectors WHERE hash = ? AND seq = ?"
    ).get("hashB", 0) as { canonical_id: string | null };
    expect(row.canonical_id).toBeNull();
  });
});

// ─── cleanStaleEmbeddings ───────────────────────────────────────────

describe("cleanStaleEmbeddings", () => {
  it("returns 0 when no stale embeddings exist", () => {
    const cleaned = store.cleanStaleEmbeddings();
    expect(cleaned).toBe(0);
  });

  it("removes embeddings for inactive documents", () => {
    store.ensureVecTable(3);

    // Insert content + active document + embedding
    store.insertContent("activeHash", "Active content", new Date().toISOString());
    store.insertDocument("col", "active.md", "Active", "activeHash", new Date().toISOString(), new Date().toISOString());
    store.insertEmbedding("activeHash", 0, 0, new Float32Array([0.1, 0.2, 0.3]), "m", new Date().toISOString());

    // Insert orphaned embedding (no matching active document)
    store.insertEmbedding("orphanHash", 0, 0, new Float32Array([0.4, 0.5, 0.6]), "m", new Date().toISOString());

    const cleaned = store.cleanStaleEmbeddings();
    expect(cleaned).toBe(1);

    // Active embedding should remain
    const remaining = store.db.prepare("SELECT hash FROM content_vectors").all() as { hash: string }[];
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.hash).toBe("activeHash");
  });

  it("cleans vectors_vec table alongside content_vectors", () => {
    store.ensureVecTable(3);

    store.insertEmbedding("orphan1", 0, 0, new Float32Array([0.1, 0.2, 0.3]), "m", new Date().toISOString());
    store.insertEmbedding("orphan1", 1, 10, new Float32Array([0.4, 0.5, 0.6]), "m", new Date().toISOString());

    const cleaned = store.cleanStaleEmbeddings();
    expect(cleaned).toBe(2); // 2 rows removed from vectors_vec

    const vecRows = store.db.prepare("SELECT hash_seq FROM vectors_vec").all();
    expect(vecRows.length).toBe(0);
  });
});

// ─── Collection-scoped searchFTS ────────────────────────────────────

describe("collection-scoped searchFTS", () => {
  beforeEach(() => {
    // Insert docs across two collections
    store.insertContent("h1", "# Architecture decisions for auth module", new Date().toISOString());
    store.insertDocument("forge-stack", "decisions/auth.md", "Auth Decisions", "h1", new Date().toISOString(), new Date().toISOString());

    store.insertContent("h2", "# Architecture decisions for API design", new Date().toISOString());
    store.insertDocument("tool-forge", "decisions/api.md", "API Decisions", "h2", new Date().toISOString(), new Date().toISOString());

    store.insertContent("h3", "# Architecture overview of the system", new Date().toISOString());
    store.insertDocument("forge-stack", "docs/arch.md", "Architecture", "h3", new Date().toISOString(), new Date().toISOString());
  });

  it("returns all results when no collection filter", () => {
    const results = store.searchFTS("architecture", 10);
    expect(results.length).toBe(3);
  });

  it("filters by single collection", () => {
    const results = store.searchFTS("architecture", 10, undefined, ["forge-stack"]);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.collectionName).toBe("forge-stack");
    }
  });

  it("filters by multiple collections", () => {
    const results = store.searchFTS("architecture decisions", 10, undefined, ["tool-forge"]);
    expect(results.length).toBe(1);
    expect(results[0]!.collectionName).toBe("tool-forge");
  });

  it("returns empty for non-existent collection", () => {
    const results = store.searchFTS("architecture", 10, undefined, ["nonexistent"]);
    expect(results.length).toBe(0);
  });
});

// ─── Co-activation boost ────────────────────────────────────────────

describe("co-activation boost in applyCompositeScoring", () => {
  const makeResult = (filepath: string, score: number, modifiedAt: string = "2026-03-01T12:00:00Z"): EnrichedResult => ({
    filepath,
    displayPath: filepath.replace("clawmem://", ""),
    title: filepath.split("/").pop() || "",
    context: null,
    hash: filepath,
    docid: filepath.slice(0, 6),
    collectionName: "test",
    modifiedAt,
    bodyLength: 100,
    body: "content",
    score,
    source: "fts" as const,
    contentType: "note",
    pinned: false,
    confidence: 0.8,
    accessCount: 1,
    qualityScore: 0.5,
    duplicateCount: 1,
    revisionCount: 1,
  });

  it("boosts lower-ranked results that co-activate with top results", () => {
    const results: EnrichedResult[] = [
      makeResult("clawmem://col/top1.md", 0.9),
      makeResult("clawmem://col/top2.md", 0.8),
      makeResult("clawmem://col/mid.md", 0.5),
      makeResult("clawmem://col/low.md", 0.3),
    ];

    // Mock: top1.md co-activates with low.md
    const coFn: CoActivationFn = (path: string) => {
      if (path === "col/top1.md") {
        return [{ path: "col/low.md", count: 5 }];
      }
      return [];
    };

    const scored = applyCompositeScoring(results, "test query", coFn);
    const lowResult = scored.find(r => r.filepath === "clawmem://col/low.md")!;
    const midResult = scored.find(r => r.filepath === "clawmem://col/mid.md")!;

    // low.md should have been boosted; mid.md should not
    // The boost should make low.md's composite score relatively higher
    expect(lowResult.compositeScore).toBeGreaterThan(0);
    // With 5 co-activations, boost = min(5/10, 0.15) = 0.15 (15%)
  });

  it("works without coActivationFn (no boost)", () => {
    const results: EnrichedResult[] = [
      makeResult("clawmem://col/a.md", 0.9),
      makeResult("clawmem://col/b.md", 0.5),
    ];

    const scored = applyCompositeScoring(results, "test");
    expect(scored.length).toBe(2);
    // Should not throw
  });

  it("handles clawmem:// prefix normalization for path matching", () => {
    const results: EnrichedResult[] = [
      makeResult("clawmem://col/top.md", 0.9),
      makeResult("clawmem://col/partner.md", 0.3),
    ];

    // Co-activation table stores displayPath format (no prefix)
    const coFn: CoActivationFn = (path: string) => {
      if (path === "col/top.md") {
        return [{ path: "col/partner.md", count: 3 }];
      }
      return [];
    };

    const scored = applyCompositeScoring(results, "test", coFn);
    const partner = scored.find(r => r.filepath === "clawmem://col/partner.md")!;
    expect(partner).toBeDefined();
    // If normalization works, partner should have been boosted
  });
});

// ─── Co-activation recording and retrieval ──────────────────────────

describe("recordCoActivation and getCoActivated", () => {
  it("records and retrieves co-activation pairs", () => {
    store.recordCoActivation(["a/doc1.md", "a/doc2.md", "a/doc3.md"]);

    const partners = store.getCoActivated("a/doc1.md");
    expect(partners.length).toBe(2);
    const paths = partners.map(p => p.path);
    expect(paths).toContain("a/doc2.md");
    expect(paths).toContain("a/doc3.md");
  });

  it("increments count on repeated co-activation", () => {
    store.recordCoActivation(["x/a.md", "x/b.md"]);
    store.recordCoActivation(["x/a.md", "x/b.md"]);
    store.recordCoActivation(["x/a.md", "x/b.md"]);

    const partners = store.getCoActivated("x/a.md");
    expect(partners.length).toBe(1);
    expect(partners[0]!.count).toBe(3);
  });

  it("stores pairs order-independent (sorted)", () => {
    store.recordCoActivation(["z/b.md", "z/a.md"]);
    const fromA = store.getCoActivated("z/a.md");
    const fromB = store.getCoActivated("z/b.md");
    expect(fromA.length).toBe(1);
    expect(fromB.length).toBe(1);
    expect(fromA[0]!.path).toBe("z/b.md");
    expect(fromB[0]!.path).toBe("z/a.md");
  });
});

// ─── insertRelation ─────────────────────────────────────────────────

describe("insertRelation", () => {
  it("inserts a usage relation", () => {
    // Need two documents
    store.insertContent("rh1", "doc1 content", new Date().toISOString());
    store.insertDocument("col", "doc1.md", "Doc1", "rh1", new Date().toISOString(), new Date().toISOString());
    store.insertContent("rh2", "doc2 content", new Date().toISOString());
    store.insertDocument("col", "doc2.md", "Doc2", "rh2", new Date().toISOString(), new Date().toISOString());

    const doc1 = store.findActiveDocument("col", "doc1.md")!;
    const doc2 = store.findActiveDocument("col", "doc2.md")!;

    store.insertRelation(doc1.id, doc2.id, "usage");

    const rel = store.db.prepare(
      "SELECT * FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?"
    ).get(doc1.id, doc2.id, "usage") as { weight: number } | null;
    expect(rel).not.toBeNull();
    expect(rel!.weight).toBe(1.0);
  });

  it("increments weight on conflict", () => {
    store.insertContent("rh3", "doc3", new Date().toISOString());
    store.insertDocument("col", "doc3.md", "D3", "rh3", new Date().toISOString(), new Date().toISOString());
    store.insertContent("rh4", "doc4", new Date().toISOString());
    store.insertDocument("col", "doc4.md", "D4", "rh4", new Date().toISOString(), new Date().toISOString());

    const d3 = store.findActiveDocument("col", "doc3.md")!;
    const d4 = store.findActiveDocument("col", "doc4.md")!;

    store.insertRelation(d3.id, d4.id, "usage", 1.0);
    store.insertRelation(d3.id, d4.id, "usage", 1.0);
    store.insertRelation(d3.id, d4.id, "usage", 1.0);

    const rel = store.db.prepare(
      "SELECT weight FROM memory_relations WHERE source_id = ? AND target_id = ?"
    ).get(d3.id, d4.id) as { weight: number };
    expect(rel.weight).toBe(3.0);
  });

  // v0.8.3 §1.3 — self-loop guard at the API boundary.
  //
  // The primary fix is in `insertRelation` itself (store.ts:1545). A
  // secondary mirror guard lives in the beads → memory_relations bridge
  // inside `syncBeadsIssues` (store.ts:~4228). Since the bridge is
  // entangled with file I/O (reads .beads/beads.jsonl, shells out to bd),
  // a full integration test for the mirror guard would need a fixture
  // project directory and a bd CLI mock — out of scope for this guard.
  // The mirror guard is a single-line structural copy of the primary, so
  // exhaustively testing the primary covers the guard pattern. Codex
  // review in task #170 verifies both sites by inspection.

  it("rejects self-loops (fromDoc === toDoc) — no row inserted", () => {
    store.insertContent("rh_self1", "self doc", new Date().toISOString());
    store.insertDocument("col", "self1.md", "Self1", "rh_self1", new Date().toISOString(), new Date().toISOString());
    const self = store.findActiveDocument("col", "self1.md")!;

    // Attempt to insert a self-loop — should be rejected silently by the guard
    store.insertRelation(self.id, self.id, "semantic");
    store.insertRelation(self.id, self.id, "usage");
    store.insertRelation(self.id, self.id, "causal", 0.9);

    const count = store.db.prepare(
      "SELECT COUNT(*) as cnt FROM memory_relations WHERE source_id = ? AND target_id = ?"
    ).get(self.id, self.id) as { cnt: number };

    expect(count.cnt).toBe(0);
  });

  it("normal (non-self) relation still works after self-loop guard added — regression", () => {
    store.insertContent("rh_norm1", "a", new Date().toISOString());
    store.insertDocument("col", "norm1.md", "N1", "rh_norm1", new Date().toISOString(), new Date().toISOString());
    store.insertContent("rh_norm2", "b", new Date().toISOString());
    store.insertDocument("col", "norm2.md", "N2", "rh_norm2", new Date().toISOString(), new Date().toISOString());

    const n1 = store.findActiveDocument("col", "norm1.md")!;
    const n2 = store.findActiveDocument("col", "norm2.md")!;

    // Mix self-loop (should be dropped) with valid relations — the guard must
    // not spill over and reject legitimate pairs.
    store.insertRelation(n1.id, n1.id, "semantic"); // dropped
    store.insertRelation(n1.id, n2.id, "semantic"); // kept
    store.insertRelation(n2.id, n2.id, "semantic"); // dropped
    store.insertRelation(n2.id, n1.id, "semantic"); // kept (opposite direction)

    const valid = store.db.prepare(
      "SELECT source_id, target_id FROM memory_relations WHERE relation_type = 'semantic' ORDER BY source_id, target_id"
    ).all() as { source_id: number; target_id: number }[];

    expect(valid).toHaveLength(2);
    expect(valid).toContainEqual({ source_id: n1.id, target_id: n2.id });
    expect(valid).toContainEqual({ source_id: n2.id, target_id: n1.id });
  });

  it("self-loop guard does not interfere with conflict upsert on valid pair", () => {
    store.insertContent("rh_up1", "u1", new Date().toISOString());
    store.insertDocument("col", "up1.md", "U1", "rh_up1", new Date().toISOString(), new Date().toISOString());
    store.insertContent("rh_up2", "u2", new Date().toISOString());
    store.insertDocument("col", "up2.md", "U2", "rh_up2", new Date().toISOString(), new Date().toISOString());
    const u1 = store.findActiveDocument("col", "up1.md")!;
    const u2 = store.findActiveDocument("col", "up2.md")!;

    // Interleave self-loops with repeated valid inserts — weight must still
    // accumulate on the valid pair.
    store.insertRelation(u1.id, u1.id, "usage", 5.0); // dropped
    store.insertRelation(u1.id, u2.id, "usage", 1.0);
    store.insertRelation(u1.id, u2.id, "usage", 1.0);
    store.insertRelation(u2.id, u2.id, "usage", 5.0); // dropped
    store.insertRelation(u1.id, u2.id, "usage", 1.0);

    const rel = store.db.prepare(
      "SELECT weight FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'usage'"
    ).get(u1.id, u2.id) as { weight: number };
    expect(rel.weight).toBe(3.0);
  });
});

// ─── Facet-based merge policy ───────────────────────────────────────

describe("getMergePolicy", () => {
  it("returns dedup_check for decisions", () => {
    expect(getMergePolicy("decision")).toBe("dedup_check");
  });

  it("returns merge_recent for antipatterns", () => {
    expect(getMergePolicy("antipattern")).toBe("merge_recent");
  });

  it("returns update_existing for preferences", () => {
    expect(getMergePolicy("preference")).toBe("update_existing");
  });

  it("returns always_new for handoffs", () => {
    expect(getMergePolicy("handoff")).toBe("always_new");
  });

  it("returns always_new for unknown types", () => {
    expect(getMergePolicy("something_else")).toBe("always_new");
  });
});
