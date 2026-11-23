/**
 * BACKLOG 82.2, D5 — a small vault of the REAL schema for the stored-vector health tests: documents with one or more
 * stored vectors, any of which can be replaced by a vector the embed path would never store.
 */
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "./seed-content.ts";
export const now = () => new Date().toISOString();
export const HEALTHY = [0.6, 0.8];
/** Vectors the embed path refuses, by the kind the health check gives them. */
export const BAD = {
  zero: [0, 0],                // norm 0
  subnormal: [1e-40, 0],       // norm below the interval
  huge: [1e7, 0],              // norm above the interval
  nan: [NaN, 1],
  infinite: [Infinity, 1],
} as const;

export function hashOf(name: string): string { return hashContent(`body of ${name}${name}`); }
export function keyOf(name: string, seq = 0): string { return `${hashOf(name)}_${seq}`; }

/** Replace the stored vector of one key, bypassing every check of the embed path. */
export function setVector(store: Store, hashSeq: string, vector: readonly number[]): void {
  store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(hashSeq);
  store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(hashSeq, new Float32Array(vector));
}

/** One active, synced document `name` whose fragments 0..n-1 have the given stored vectors. Returns its id. */
export function addDocument(store: Store, name: string, vectors: readonly (readonly number[])[], collection = "c"): number {
  const body = `body of ${name}`;
  const hash = hashOf(name);
  seedContent(store.db, hash, body, now());
  store.insertDocument(collection, `${name}.md`, name, hash, now(), now());
  vectors.forEach((vector, seq) => {
    store.insertEmbedding(hash, seq, seq, new Float32Array(HEALTHY), "m1", now());
    setVector(store, `${hash}_${seq}`, vector);
  });
  store.markEmbedSynced(hash);
  return (store.db.prepare(`SELECT id FROM documents WHERE hash = ? AND collection = ?`).get(hash, collection) as { id: number }).id;
}

/** An in-memory vault with a two-dimension vector table. */
export function memoryVault(docs: Record<string, readonly (readonly number[])[]> = {}): { store: Store; ids: Record<string, number> } {
  const store = createStore(":memory:");
  store.ensureVecTable(2);
  const ids: Record<string, number> = {};
  for (const [name, vectors] of Object.entries(docs)) ids[name] = addDocument(store, name, vectors);
  return { store, ids };
}

/** A vault in a file (write-ahead log), for tests that need a second connection. `done()` closes and removes it. */
export function fileVault(docs: Record<string, readonly (readonly number[])[]> = {}): { store: Store; path: string; ids: Record<string, number>; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-822-vh-"));
  const path = join(dir, "vault.sqlite");
  const store = createStore(path);
  store.ensureVecTable(2);
  const ids: Record<string, number> = {};
  for (const [name, vectors] of Object.entries(docs)) ids[name] = addDocument(store, name, vectors);
  return { store, path, ids, done: () => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}
