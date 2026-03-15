/**
 * Shared test store factory — creates in-memory SQLite stores.
 */
import { createStore, insertContent, insertDocument, type Store } from "../../src/store.ts";
import { TEST_COLLECTION } from "./fixtures.ts";

/**
 * Create a fresh in-memory store with full schema.
 */
export function createTestStore(): Store {
  return createStore(":memory:");
}

export interface SeedDoc {
  path: string;
  title: string;
  body: string;
  collection?: string;
  contentType?: string;
  confidence?: number;
  qualityScore?: number;
  pinned?: boolean;
  modifiedAt?: string;
}

/**
 * Seed documents into a test store.
 * Returns array of document IDs.
 */
export function seedDocuments(store: Store, docs: SeedDoc[]): number[] {
  const ids: number[] = [];
  const now = new Date().toISOString();

  for (const doc of docs) {
    const collection = doc.collection || TEST_COLLECTION;
    const hash = `hash_${doc.path}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const modifiedAt = doc.modifiedAt || now;

    // Insert content + document (collections are config-based, not a DB table)
    insertContent(store.db, hash, doc.body, now);
    insertDocument(store.db, collection, doc.path, doc.title, hash, now, modifiedAt);

    // Get the inserted doc ID
    const row = store.db.prepare(
      "SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1"
    ).get(collection, doc.path) as { id: number } | undefined;

    if (row) {
      ids.push(row.id);

      // Apply optional metadata
      if (doc.contentType || doc.confidence !== undefined || doc.qualityScore !== undefined) {
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (doc.contentType) { sets.push("content_type = ?"); vals.push(doc.contentType); }
        if (doc.confidence !== undefined) { sets.push("confidence = ?"); vals.push(doc.confidence); }
        if (doc.qualityScore !== undefined) { sets.push("quality_score = ?"); vals.push(doc.qualityScore); }
        if (sets.length > 0) {
          vals.push(row.id);
          store.db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        }
      }
      if (doc.pinned) {
        store.db.prepare("UPDATE documents SET pinned = 1 WHERE id = ?").run(row.id);
      }
    }
  }

  return ids;
}

/**
 * Seed a session record.
 */
export function seedSession(store: Store, sessionId: string, startedAt?: string): void {
  store.insertSession(sessionId, startedAt || new Date().toISOString());
}
