/**
 * BACKLOG 82.2, D2 — the bookkeeping of a fatal embed abort: scope, ownership and charge are explicit.
 *   - `markEmbedStart` returns the ids of the rows it charged (the receipt);
 *   - a REFUSED RESPONSE refunds exactly those rows, once, under the lease — a later alias and a changed row are not
 *     touched, and no receipt means no refund;
 *   - a run that cleared the index or committed a vector and was not verified at its end sets the taint;
 *   - a lost lease writes NOTHING.
 * New APIs: none of this exists on v0.43.6 (a poisoned fragment was stored, so there was no abort to account for).
 */
import { describe, it, expect } from "bun:test";
import { createStore, EmbedLeaseLostError, VecDimensionMismatchError, type Store } from "../../src/store.ts";
import { VecPoisonError, EmbedEnvelopeError } from "../../src/vector-guard.ts";
import { finaliseEmbedAbort } from "../../src/embed-abort.ts";
import { acquireWorkerLease } from "../../src/worker-lease.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const TAINT = "embed_geometry_taint";
const now = () => new Date().toISOString();
function seed(store: Store, path: string, body: string, hash = hashContent(body)): string {
  if (!store.db.prepare(`SELECT 1 FROM content WHERE hash = ?`).get(hash)) seedContent(store.db, hash, body, now());
  store.insertDocument("c", path, path, hash, now(), now());
  return hash;
}
const rows = (store: Store) => store.db.prepare(`SELECT path, embed_state, embed_attempts, embed_error FROM documents ORDER BY path`).all() as
  { path: string; embed_state: string | null; embed_attempts: number | null; embed_error: string | null }[];
const poison = new VecPoisonError("non-number", "endpoint", { context: "h_2" });
const noSleep = { delaysMs: [0, 0, 0] };

describe("markEmbedStart — the charge receipt", () => {
  it("returns the ids of every ACTIVE row of the hash it incremented", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "a.md", "one body");
    seed(store, "alias.md", "one body", hash);
    seed(store, "other.md", "another body");
    const ids = store.markEmbedStart(hash);
    const expected = (store.db.prepare(`SELECT id FROM documents WHERE hash = ? ORDER BY id`).all(hash) as { id: number }[]).map(r => r.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(expected);
    expect(rows(store).map(r => [r.path, r.embed_attempts ?? 0, r.embed_state])).toEqual([["a.md", 1, "pending"], ["alias.md", 1, "pending"], ["other.md", 0, r_state(store, "other.md")]]);
  });
  it("returns an empty receipt when no active row has the hash", () => {
    const store = createStore(":memory:");
    expect(store.markEmbedStart("f".repeat(64))).toEqual([]);
  });
});
function r_state(store: Store, path: string): string | null {
  return (store.db.prepare(`SELECT embed_state FROM documents WHERE path = ?`).get(path) as { embed_state: string | null }).embed_state;
}

describe("refundEmbedAttempt — conditional, and applied to exactly the charged rows", () => {
  it("gives the attempt back, records the error, and leaves the row pending", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "a.md", "one body");
    const ids = store.markEmbedStart(hash);
    expect(store.refundEmbedAttempt(hash, ids, "the endpoint returned a malformed vector")).toBe(1);
    expect(rows(store)).toEqual([{ path: "a.md", embed_state: "pending", embed_attempts: 0, embed_error: "the endpoint returned a malformed vector" }]);
  });
  it("does not touch an alias added after the charge, a row that changed state, or a deactivated row", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "a.md", "one body");
    seed(store, "synced.md", "one body", hash);
    seed(store, "gone.md", "one body", hash);
    const ids = store.markEmbedStart(hash);
    seed(store, "later-alias.md", "one body", hash);                                        // appeared during the run
    store.db.prepare(`UPDATE documents SET embed_state = 'synced' WHERE path = 'synced.md'`).run();   // changed meanwhile
    store.db.prepare(`UPDATE documents SET active = 0 WHERE path = 'gone.md'`).run();
    expect(store.refundEmbedAttempt(hash, ids, "refused")).toBe(1);
    const byPath = Object.fromEntries(rows(store).map(r => [r.path, r]));
    expect([byPath["a.md"]!.embed_attempts, byPath["a.md"]!.embed_error]).toEqual([0, "refused"]);
    expect([byPath["synced.md"]!.embed_attempts, byPath["synced.md"]!.embed_error]).toEqual([1, null]);
    expect([byPath["gone.md"]!.embed_attempts, byPath["gone.md"]!.embed_error]).toEqual([1, null]);
    expect([byPath["later-alias.md"]!.embed_attempts ?? 0, byPath["later-alias.md"]!.embed_error]).toEqual([0, null]);
  });
  it("never goes below zero, and a row whose hash changed is not touched", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "a.md", "one body");
    const ids = store.markEmbedStart(hash);
    store.db.prepare(`UPDATE documents SET embed_attempts = 0 WHERE path = 'a.md'`).run();
    expect(store.refundEmbedAttempt(hash, ids, "refused")).toBe(1);
    expect(rows(store)[0]!.embed_attempts).toBe(0);
    expect(store.refundEmbedAttempt("e".repeat(64), ids, "other hash")).toBe(0);
    expect(rows(store)[0]!.embed_error).toBe("refused");
  });
  it("asserts the lease: a holder that lost it writes nothing", () => {
    const store = createStore(":memory:");
    const hash = seed(store, "a.md", "one body");
    const ids = store.markEmbedStart(hash);
    acquireWorkerLease(store, "embedding", 60_000);
    expect(() => store.refundEmbedAttempt(hash, ids, "refused", { workerName: "embedding", token: "not-the-holder" })).toThrow(EmbedLeaseLostError);
    expect(rows(store)).toEqual([{ path: "a.md", embed_state: "pending", embed_attempts: 1, embed_error: null }]);
  });
});

describe("finaliseEmbedAbort — one finaliser for a fatal abort", () => {
  const base = { clearedIndex: false, vectorsCommitted: 0, endVerificationRan: false, leaseLost: false };
  function charged(store: Store) {
    const hash = seed(store, "a.md", "one body");
    return { hash, chargedIds: store.markEmbedStart(hash) };
  }

  it("a refused response: the document's attempt is refunded with the error; nothing stored and nothing cleared → no taint", async () => {
    for (const err of [poison, new EmbedEnvelopeError("no data array", { context: "h_2" })]) {
      const store = createStore(":memory:");
      const report = await finaliseEmbedAbort(store, { ...base, err, docInHand: charged(store) }, noSleep);
      expect(rows(store)[0]).toMatchObject({ embed_state: "pending", embed_attempts: 0 });
      expect(rows(store)[0]!.embed_error).toContain("Malformed embedding");
      expect(store.getVaultFlag(TAINT)).toBeNull();
      expect([report.refund, report.taint]).toEqual(["refunded", "not-needed"]);
    }
  });

  it("vectors were committed (or the index was cleared) and the end was not verified → the taint is set, and the message says a retry does not clear it", async () => {
    for (const state of [{ vectorsCommitted: 2 }, { clearedIndex: true }]) {
      const store = createStore(":memory:");
      const report = await finaliseEmbedAbort(store, { ...base, ...state, err: poison, docInHand: charged(store) }, noSleep);
      expect(store.getVaultFlag(TAINT)).toContain("aborted");
      expect(report.taint).toBe("set");
      expect(report.lines.join("\n")).toContain("embed --force");
    }
  });

  it("the end WAS verified → no second taint decision is made here", async () => {
    const store = createStore(":memory:");
    const report = await finaliseEmbedAbort(store, { ...base, vectorsCommitted: 2, endVerificationRan: true, err: poison, docInHand: null }, noSleep);
    expect(store.getVaultFlag(TAINT)).toBeNull();
    expect(report.taint).toBe("not-needed");
  });

  it("a start marker that did not commit (no receipt) → no refund is made", async () => {
    const store = createStore(":memory:");
    const hash = seed(store, "a.md", "one body");
    store.db.prepare(`UPDATE documents SET embed_attempts = 2, embed_state = 'pending' WHERE hash = ?`).run(hash);
    const report = await finaliseEmbedAbort(store, { ...base, err: poison, docInHand: null }, noSleep);
    expect(rows(store)[0]).toMatchObject({ embed_attempts: 2, embed_error: null });
    expect(report.refund).toBe("none");
  });

  it("any other fatal error keeps today's accounting: no refund, but the taint rule still applies", async () => {
    const store = createStore(":memory:");
    const doc = charged(store);
    const report = await finaliseEmbedAbort(store, { ...base, vectorsCommitted: 1, err: new VecDimensionMismatchError(4, 8), docInHand: doc }, noSleep);
    expect(rows(store)[0]).toMatchObject({ embed_state: "pending", embed_attempts: 1, embed_error: null });
    expect(report.refund).toBe("none");
    expect(store.getVaultFlag(TAINT)).toContain("aborted");
  });

  it("the lease was lost → NOTHING is written, and the report says so", async () => {
    for (const lost of [{ leaseLost: true, err: poison as Error }, { leaseLost: false, err: new EmbedLeaseLostError() as Error }]) {
      const store = createStore(":memory:");
      const doc = charged(store);
      const report = await finaliseEmbedAbort(store, { ...base, vectorsCommitted: 3, clearedIndex: true, docInHand: doc, ...lost } as never, noSleep);
      expect(rows(store)[0]).toMatchObject({ embed_attempts: 1, embed_error: null });
      expect(store.getVaultFlag(TAINT)).toBeNull();
      expect([report.refund, report.taint]).toEqual(["skipped-lease-lost", "skipped-lease-lost"]);
      expect(report.lines.join("\n")).toContain("no bookkeeping was written");
    }
  });

  it("the lease is found lost by the first write → the later write is not attempted", async () => {
    const store = createStore(":memory:");
    const doc = charged(store);
    acquireWorkerLease(store, "embedding", 60_000);
    const report = await finaliseEmbedAbort(store, {
      ...base, vectorsCommitted: 1, err: poison, docInHand: doc, leaseGuard: { workerName: "embedding", token: "stale" },
    }, noSleep);
    expect(rows(store)[0]).toMatchObject({ embed_attempts: 1, embed_error: null });
    expect(store.getVaultFlag(TAINT)).toBeNull();
    expect([report.refund, report.taint]).toEqual(["skipped-lease-lost", "skipped-lease-lost"]);
  });

  it("a bookkeeping write that is still busy after its retries is reported as NOT RECORDED — never implied done", async () => {
    const store = createStore(":memory:");
    const doc = charged(store);
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const wrapped: Store = Object.create(store, {
      refundEmbedAttempt: { value: () => { throw busy; } },
      setVaultFlag: { value: () => { throw busy; } },
    });
    const report = await finaliseEmbedAbort(wrapped, { ...base, vectorsCommitted: 1, err: poison, docInHand: doc }, noSleep);
    expect([report.refund, report.taint]).toEqual(["not-recorded", "not-recorded"]);
    expect(report.lines.join("\n")).toContain("NOT recorded");
    expect(rows(store)[0]).toMatchObject({ embed_attempts: 1, embed_error: null });
  });
});
