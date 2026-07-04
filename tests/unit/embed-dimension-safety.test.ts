import { describe, it, expect, afterEach } from "bun:test";

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
  searchVec,
  updateDocument,
  VecDimensionMismatchError,
  VecReadModelMismatchError,
  VecSchemaError,
  EmbedLeaseLostError,
  rethrowIfFatalVectorError,
  DEFAULT_EMBED_MODEL,
  type Store,
} from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import {
  acquireWorkerLease,
  releaseWorkerLease,
  renewWorkerLease,
} from "../../src/worker-lease.ts";
import { hashContent } from "../../src/indexer.ts";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

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

// ---------------------------------------------------------------------------
// W1 — read-path embedding-model consistency guard
//
// The vault's stored vectors carry the model that produced them (cv.model). If the active endpoint
// later returns a DIFFERENT model at the SAME dimension (so VecDimensionMismatchError cannot catch
// it), matching the new model's query vector against the old model's stored vectors is
// cosine-meaningless. searchVec must throw VecReadModelMismatchError on the query path rather than
// serve corrupted results. Bug-first: these assert CORRECT behavior.
// ---------------------------------------------------------------------------

// Minimal LLM stub: getEmbedding() calls getDefaultLlamaCpp().embed(); only .embed is exercised.
// It returns a fixed unit vector plus the `model` we want the "endpoint" to report.
function mockEmbedLlm(model: string, dim = 4): unknown {
  return {
    embed: async () => ({ embedding: Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)), model }),
  };
}

describe("searchVec — read-path embedding-model consistency (W1)", () => {
  afterEach(() => setDefaultLlamaCpp(null));

  function seedOneVector(store: Store, storedModel: string) {
    store.ensureVecTable(4);
    const hash = seed(store, "c", "a.md", "doc a body");
    store.insertEmbedding(hash, 0, 1, vec(4), storedModel, new Date().toISOString(), "full", null, "c/a.md");
  }

  it("throws VecReadModelMismatchError when the endpoint model differs from the stored model (same dim)", async () => {
    const store = createStore(":memory:");
    seedOneVector(store, "model-A");
    expect(store.getVecModels()).toEqual(["model-A"]);

    setDefaultLlamaCpp(mockEmbedLlm("model-B") as any); // endpoint now serves a different model, same dim
    await expect(searchVec(store.db, "some query", DEFAULT_EMBED_MODEL, 10)).rejects.toBeInstanceOf(
      VecReadModelMismatchError,
    );
  });

  it("does not throw and returns results when the endpoint model matches the stored model", async () => {
    const store = createStore(":memory:");
    seedOneVector(store, "model-A");
    setDefaultLlamaCpp(mockEmbedLlm("model-A") as any);
    const results = await searchVec(store.db, "some query", DEFAULT_EMBED_MODEL, 10);
    expect(results.length).toBeGreaterThanOrEqual(1); // consistent → the seeded vector is served
  });

  it("compares the ENDPOINT model, not the caller's DEFAULT_EMBED_MODEL arg", async () => {
    // The vault stored "model-A"; the caller passes DEFAULT_EMBED_MODEL ("granite"), which is a local
    // alias unrelated to what the endpoint serves. The endpoint returns "model-A", so the check must
    // pass. A wrong implementation comparing the caller arg ("granite") to stored ("model-A") would
    // false-throw here.
    const store = createStore(":memory:");
    seedOneVector(store, "model-A");
    expect(DEFAULT_EMBED_MODEL).not.toBe("model-A"); // the caller arg is genuinely different
    setDefaultLlamaCpp(mockEmbedLlm("model-A") as any);
    const results = await searchVec(store.db, "q", DEFAULT_EMBED_MODEL, 10);
    expect(results.length).toBeGreaterThanOrEqual(1); // matched on endpoint model, no throw
  });

  it("does not throw on an empty vault (no stored vectors to be inconsistent with)", async () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4); // table exists but holds no vectors
    setDefaultLlamaCpp(mockEmbedLlm("model-B") as any);
    const results = await searchVec(store.db, "some query", DEFAULT_EMBED_MODEL, 10);
    expect(results).toEqual([]); // MATCH finds nothing → empty, and no spurious throw
  });

  it("re-checks when the endpoint model drifts, even after a consistent verdict was cached", async () => {
    // Cache correctness: the memoization stores only the specific OK model, so a later drift to a
    // different model is NOT masked by the cached happy-path verdict.
    const store = createStore(":memory:");
    seedOneVector(store, "model-A");
    setDefaultLlamaCpp(mockEmbedLlm("model-A") as any);
    await searchVec(store.db, "q", DEFAULT_EMBED_MODEL, 10); // consistent → caches model-A as OK
    setDefaultLlamaCpp(mockEmbedLlm("model-B") as any); // endpoint drifts
    await expect(searchVec(store.db, "q", DEFAULT_EMBED_MODEL, 10)).rejects.toBeInstanceOf(
      VecReadModelMismatchError,
    );
  });

  it("throws on a HETEROGENEOUS vault even when the endpoint matches ONE of the stored models", async () => {
    // A vault holding >1 model is cosine-corrupt: matching the endpoint against one model still scans
    // the other model's polluting vectors. Consistency requires EXACTLY one stored model == endpoint.
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const hA = seed(store, "c", "a.md", "doc a body");
    store.insertEmbedding(hA, 0, 1, vec(4), "model-A", new Date().toISOString(), "full", null, "c/a.md");
    const hB = seed(store, "c", "b.md", "doc b body");
    store.insertEmbedding(hB, 0, 1, vec(4), "model-B", new Date().toISOString(), "full", null, "c/b.md");
    expect(store.getVecModels().length).toBe(2);

    setDefaultLlamaCpp(mockEmbedLlm("model-A") as any); // endpoint matches ONE of the two
    await expect(searchVec(store.db, "q", DEFAULT_EMBED_MODEL, 10)).rejects.toBeInstanceOf(
      VecReadModelMismatchError,
    );
  });

  it("invalidates a cached OK verdict when ANOTHER connection rebuilds the vault (data_version)", async () => {
    // Finding 1 (multi-process staleness): a long-running process caches model-A as OK, then a
    // separate `clawmem embed --force` process re-embeds with model-B. SQLite's data_version (which
    // changes on the first connection when ANOTHER connection commits) must invalidate the stale
    // verdict so the next query re-reads content_vectors and throws.
    const path = `${tmpdir()}/clawmem-w1-datav-${process.pid}-${Date.now()}.sqlite`;
    const s1 = createStore(path);
    const s2 = createStore(path); // a second, independent connection to the same DB file
    try {
      s1.ensureVecTable(4);
      const hA = seed(s1, "c", "a.md", "doc a body");
      s1.insertEmbedding(hA, 0, 1, vec(4), "model-A", new Date().toISOString(), "full", null, "c/a.md");

      setDefaultLlamaCpp(mockEmbedLlm("model-A") as any);
      const first = await searchVec(s1.db, "q", DEFAULT_EMBED_MODEL, 10); // caches {dataVersion, model-A}
      expect(first.length).toBeGreaterThanOrEqual(1);

      // Another connection rebuilds the vault with model-B (its commits bump s1's data_version).
      s2.clearAllEmbeddings();
      s2.ensureVecTable(4);
      const hB = seed(s2, "c", "b.md", "doc b body");
      s2.insertEmbedding(hB, 0, 1, vec(4), "model-B", new Date().toISOString(), "full", null, "c/b.md");

      // s1's endpoint is still model-A; the vault now holds model-B. The stale cache must NOT mask it.
      await expect(searchVec(s1.db, "q", DEFAULT_EMBED_MODEL, 10)).rejects.toBeInstanceOf(
        VecReadModelMismatchError,
      );
    } finally {
      s1.close();
      s2.close();
      try { unlinkSync(path); } catch { /* best-effort cleanup */ }
    }
  });
});

describe("rethrowIfFatalVectorError", () => {
  it("rethrows FatalVectorError subclasses so a searchVec fallback catch surfaces them", () => {
    const err = new VecReadModelMismatchError(["A"], "B");
    expect(() => rethrowIfFatalVectorError(err)).toThrow(VecReadModelMismatchError);
    expect(() => rethrowIfFatalVectorError(new VecDimensionMismatchError(4, 8))).toThrow(VecDimensionMismatchError);
  });

  it("swallows non-fatal errors (transient vector timeout / absent vectors) without throwing", () => {
    expect(rethrowIfFatalVectorError(new Error("vector timeout"))).toBeUndefined();
    expect(rethrowIfFatalVectorError("string error")).toBeUndefined();
    expect(rethrowIfFatalVectorError(undefined)).toBeUndefined();
  });
});
