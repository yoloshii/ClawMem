import { describe, it, expect } from "bun:test";

/**
 * Dimension-safety + consistency tests for the 2026-06-22 vector-retrieval
 * incident fix (INCIDENT-2026-06-22 §12). Covers the store/worker-lease
 * primitives that make silent vector loss impossible:
 *   - ensureVecTable THROWS (never drops) on a dimension mismatch
 *   - getVecTableDim distinguishes absent / valid / malformed
 *   - clearAllEmbeddings resets state (and is the only destructive path)
 *   - insertEmbedding writes content_vectors + vectors_vec together
 *   - getVectorConsistency set-diff detects cv-without-vv and orphan vv
 *   - the worklist retries failed/pending docs, bounded by embed_attempts < 3
 *   - markEmbedStart increments attempts ONCE; failure setters are state-only
 *   - renewWorkerLease is token-fenced; the "embedding" lease is exclusive
 */

import {
  createStore,
  updateDocument,
  VecDimensionMismatchError,
  VecSchemaError,
  EmbedLeaseLostError,
  type Store,
} from "../../src/store.ts";
import {
  acquireWorkerLease,
  releaseWorkerLease,
  renewWorkerLease,
} from "../../src/worker-lease.ts";
import { hashContent } from "../../src/indexer.ts";

function seed(store: Store, col: string, path: string, body: string): string {
  const hash = hashContent(body + path);
  const now = new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument(col, path, path, hash, now, now);
  return hash;
}
const vec = (dim: number) => new Float32Array(Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)));

describe("ensureVecTable — throw, never drop", () => {
  it("throws VecDimensionMismatchError on a dimension change and leaves the table + rows intact", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const hash = seed(store, "c", "a.md", "doc a");
    const now = new Date().toISOString();
    store.insertEmbedding(hash, 0, 1, vec(4), "m1", now, "full", null, "c/a.md");

    expect(store.getVecTableDim()).toBe(4);
    // The old code DROPPED the table here (silent vault wipe). It must now throw.
    expect(() => store.ensureVecTable(8)).toThrow(VecDimensionMismatchError);
    // Table not dropped, the existing vector survives.
    expect(store.getVecTableDim()).toBe(4);
    const vc = store.getVectorConsistency();
    expect(vc.vvCount).toBe(1);
    expect(vc.cvMissingVv).toBe(0);
  });

  it("creates the table at the requested dimension when absent (fresh vault)", () => {
    const store = createStore(":memory:");
    expect(store.getVecTableDim()).toBeNull();
    store.ensureVecTable(4); // no throw on a fresh vault
    expect(store.getVecTableDim()).toBe(4);
    // Re-entrant with the same dim is a no-op (cache fast path), no throw.
    expect(() => store.ensureVecTable(4)).not.toThrow();
  });
});

describe("getVecTableDim — distinct states", () => {
  it("returns null when absent, the dim when valid, and throws VecSchemaError on malformed DDL", () => {
    const store = createStore(":memory:");
    expect(store.getVecTableDim()).toBeNull(); // absent

    store.ensureVecTable(2560);
    expect(store.getVecTableDim()).toBe(2560); // valid

    // Malformed: a non-vec0 table named vectors_vec whose DDL has no float[N].
    store.db.exec("DROP TABLE IF EXISTS vectors_vec");
    store.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT, junk TEXT)");
    expect(() => store.getVecTableDim()).toThrow(VecSchemaError);
  });
});

describe("clearAllEmbeddings — the only destructive path", () => {
  it("clears content_vectors, drops vectors_vec, and resets embed_state to pending", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const hash = seed(store, "c", "a.md", "doc a");
    const now = new Date().toISOString();
    store.insertEmbedding(hash, 0, 1, vec(4), "m1", now, "full", null, "c/a.md");
    store.markEmbedSynced(hash);

    store.clearAllEmbeddings();

    expect(store.getVecTableDim()).toBeNull(); // table dropped
    const cv = store.db.prepare("SELECT COUNT(*) AS n FROM content_vectors").get() as { n: number };
    expect(cv.n).toBe(0);
    const doc = store.db.prepare("SELECT embed_state, embed_attempts FROM documents WHERE hash = ?").get(hash) as { embed_state: string; embed_attempts: number };
    expect(doc.embed_state).toBe("pending");
    expect(doc.embed_attempts).toBe(0);
  });
});

describe("insertEmbedding + getVectorConsistency — cv↔vv invariant", () => {
  it("writes content_vectors and vectors_vec together (consistent)", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const hash = seed(store, "c", "a.md", "doc a");
    const now = new Date().toISOString();
    store.insertEmbedding(hash, 0, 1, vec(4), "m1", now, "full", null, "c/a.md");
    const vc = store.getVectorConsistency();
    expect(vc.cvCount).toBe(1);
    expect(vc.vvCount).toBe(1);
    expect(vc.cvMissingVv).toBe(0);
    expect(vc.vvOrphan).toBe(0);
  });

  it("detects a content_vectors row missing its vector (the desync class)", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const now = new Date().toISOString();
    const hash = seed(store, "c", "a.md", "doc a");
    // Inject a metadata row with NO matching vectors_vec entry (simulates the
    // dimension-drop-then-skip desync the incident was about).
    store.db.prepare(
      "INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)"
    ).run(hash, 0, 1, "m1", now);
    const vc = store.getVectorConsistency();
    expect(vc.cvMissingVv).toBe(1);
    expect(vc.vvOrphan).toBe(0);
  });

  it("detects an orphan vector with no metadata row", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run("orphan_0", vec(4));
    const vc = store.getVectorConsistency();
    expect(vc.vvOrphan).toBe(1);
    expect(vc.cvMissingVv).toBe(0);
  });
});

describe("worklist — retries partial failures, bounded by attempts", () => {
  it("re-selects a doc marked failed (attempts < 3) and excludes it at attempts == 3", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const hash = seed(store, "c", "a.md", "doc a body long enough");
    const now = new Date().toISOString();
    // Fully embed: seq0 + a typed fragment present.
    store.insertEmbedding(hash, 0, 1, vec(4), "m1", now, "full", null, "c/a.md");
    store.insertEmbedding(hash, 1, 2, vec(4), "m1", now, "section", null, "c/a.md");
    store.markEmbedSynced(hash);
    expect(store.getHashesNeedingFragments().some(h => h.hash === hash)).toBe(false);

    // A partial failure marks it 'failed' → must be retried while attempts < 3.
    store.markEmbedFailed(hash, "1 fragment(s) failed");
    expect(store.getHashesNeedingFragments().some(h => h.hash === hash)).toBe(true);

    // Exhaust the retry budget → excluded.
    store.db.prepare("UPDATE documents SET embed_attempts = 3 WHERE hash = ?").run(hash);
    expect(store.getHashesNeedingFragments().some(h => h.hash === hash)).toBe(false);
  });
});

describe("embed_attempts accounting — increment once per attempt", () => {
  it("markEmbedStart increments; markEmbedFailed is state-only (no double count)", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "c", "a.md", "doc a");
    const get = () => store.db.prepare("SELECT embed_state, embed_attempts FROM documents WHERE hash = ?").get(hash) as { embed_state: string; embed_attempts: number };

    store.markEmbedStart(hash);
    expect(get()).toMatchObject({ embed_state: "pending", embed_attempts: 1 });
    store.markEmbedFailed(hash, "boom");
    // attempts unchanged — failure setter must not double-count the start increment.
    expect(get()).toMatchObject({ embed_state: "failed", embed_attempts: 1 });

    store.markEmbedStart(hash); // second attempt
    expect(get()).toMatchObject({ embed_state: "pending", embed_attempts: 2 });
    // Success RESETS the retry budget — otherwise a doc re-embedded many times
    // (repeated content edits) accumulates attempts and is wrongly excluded.
    store.markEmbedSynced(hash);
    expect(get()).toMatchObject({ embed_state: "synced", embed_attempts: 0 });
  });
});

describe("retry budget resets — success and content change (codex T5 HIGH-1)", () => {
  it("a successful re-embed never exhausts the attempts budget", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "c", "a.md", "doc a");
    const get = () => store.db.prepare("SELECT embed_attempts FROM documents WHERE hash = ?").get(hash) as { embed_attempts: number };
    // Simulate many successful re-embeds (each starts → increments, succeeds → resets).
    for (let i = 0; i < 5; i++) {
      store.markEmbedStart(hash);
      store.markEmbedSynced(hash);
    }
    expect(get().embed_attempts).toBe(0); // never accumulates across successes
  });

  it("updateDocument (content change) resets a stale exhausted budget", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "c", "a.md", "old body");
    const doc = store.findActiveDocument("c", "a.md") as { id: number };
    // Old content failed its full budget.
    store.db.prepare("UPDATE documents SET embed_state='failed', embed_attempts=3 WHERE id=?").run(doc.id);
    expect(store.getHashesNeedingFragments().some(h => h.hash === hash)).toBe(false); // excluded

    // Content edited → new hash → updateDocument must reset the budget so the new
    // content is re-embeddable (not excluded by the OLD content's exhausted attempts).
    const newHash = hashContent("new body" + "a.md");
    store.insertContent(newHash, "new body", new Date().toISOString());
    updateDocument(store.db, doc.id, "a.md", newHash, new Date().toISOString());
    const row = store.db.prepare("SELECT embed_state, embed_attempts FROM documents WHERE id=?").get(doc.id) as { embed_state: string; embed_attempts: number };
    expect(row.embed_state).toBe("pending");
    expect(row.embed_attempts).toBe(0);
    expect(store.getHashesNeedingFragments().some(h => h.hash === newHash)).toBe(true); // re-embeddable
  });

  it("the hash-change trigger resets embed state on ANY hash update, not just updateDocument", () => {
    const store = createStore(":memory:");
    seed(store, "c", "a.md", "old");
    const doc = store.findActiveDocument("c", "a.md") as { id: number };
    store.db.prepare("UPDATE documents SET embed_state='failed', embed_attempts=3 WHERE id=?").run(doc.id);
    // documents.hash has a FK → content.hash, so the new content must exist first
    // (real code always inserts content before re-pointing the doc). This simulates
    // a bypass path (decision/antipattern merges, saveMemory, beads sync) that
    // updates hash directly without going through updateDocument/reactivateDocument.
    const newHash = hashContent("brand new content");
    store.insertContent(newHash, "brand new content", new Date().toISOString());
    store.db.prepare("UPDATE documents SET hash=? WHERE id=?").run(newHash, doc.id);
    const row = store.db.prepare("SELECT embed_state, embed_attempts FROM documents WHERE id=?").get(doc.id) as { embed_state: string; embed_attempts: number };
    expect(row.embed_state).toBe("pending");
    expect(row.embed_attempts).toBe(0);
  });
});

describe("getVecModels — stored vault models (codex T5 HIGH-2 / T6 MED-1)", () => {
  it("returns [] when empty, the distinct model when uniform, and length>1 when heterogeneous", () => {
    const store = createStore(":memory:");
    expect(store.getVecModels()).toEqual([]);
    store.ensureVecTable(4);
    const h1 = seed(store, "c", "a.md", "doc a");
    store.insertEmbedding(h1, 0, 1, vec(4), "granite-2560", new Date().toISOString(), "full", null, "c/a.md");
    expect(store.getVecModels()).toEqual(["granite-2560"]);
    // A second, different model present → heterogeneous vault (must be detectable,
    // NOT hidden behind a majority value).
    const h2 = seed(store, "c", "b.md", "doc b");
    store.insertEmbedding(h2, 0, 1, vec(4), "other-2560", new Date().toISOString(), "full", null, "c/b.md");
    expect(store.getVecModels().length).toBe(2);
    expect(store.getVecModels()).toContain("granite-2560");
    expect(store.getVecModels()).toContain("other-2560");
  });
});

describe("insertEmbedding lease guard — in-transaction fence (codex T6 HIGH-1)", () => {
  it("refuses to write when the lease token no longer matches (atomic abort)", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const hash = seed(store, "c", "a.md", "doc a");
    const lease = acquireWorkerLease(store, "embedding", 60_000);

    // Correct token → write commits.
    store.insertEmbedding(hash, 0, 1, vec(4), "m", new Date().toISOString(), "full", null, "c/a.md", { workerName: "embedding", token: lease.token! });
    expect(store.getVectorConsistency().vvCount).toBe(1);

    // Wrong token (another process reclaimed the lease) → throws, nothing written.
    expect(() => store.insertEmbedding(hash, 1, 2, vec(4), "m", new Date().toISOString(), "section", null, "c/a.md", { workerName: "embedding", token: "stolen-token" })).toThrow(EmbedLeaseLostError);
    expect(store.getVectorConsistency().vvCount).toBe(1); // unchanged — guarded write rolled back
  });

  it("clearAllEmbeddings refuses to wipe when the lease token no longer matches (codex T7 HIGH-1)", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const hash = seed(store, "c", "a.md", "doc a");
    store.insertEmbedding(hash, 0, 1, vec(4), "m", new Date().toISOString(), "full", null, "c/a.md");
    acquireWorkerLease(store, "embedding", 60_000); // a holder exists
    // A stale --force process whose token no longer matches must NOT wipe the vault.
    expect(() => store.clearAllEmbeddings({ workerName: "embedding", token: "stale-token" })).toThrow(EmbedLeaseLostError);
    expect(store.getVecTableDim()).toBe(4);               // table not dropped
    expect(store.getVectorConsistency().vvCount).toBe(1); // rolled back
  });
});

describe("renewWorkerLease — token-fenced heartbeat", () => {
  it("renews with the owning token, rejects a foreign token, and fails after release", () => {
    const store = createStore(":memory:");
    const lease = acquireWorkerLease(store, "embedding", 60_000);
    expect(lease.acquired).toBe(true);
    expect(lease.token).toBeTruthy();

    expect(renewWorkerLease(store, "embedding", lease.token!, 60_000)).toBe(true);
    expect(renewWorkerLease(store, "embedding", "not-the-token", 60_000)).toBe(false);

    expect(releaseWorkerLease(store, "embedding", lease.token!)).toBe(true);
    // After release the row is gone → renewal fails (caller must abort).
    expect(renewWorkerLease(store, "embedding", lease.token!, 60_000)).toBe(false);
  });

  it("the embedding lease is exclusive while held", () => {
    const store = createStore(":memory:");
    const a = acquireWorkerLease(store, "embedding", 60_000);
    expect(a.acquired).toBe(true);
    const b = acquireWorkerLease(store, "embedding", 60_000);
    expect(b.acquired).toBe(false); // second embed must skip
  });
});
