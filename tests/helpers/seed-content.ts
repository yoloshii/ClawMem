/**
 * TEST SEEDING ONLY (BACKLOG 82.3, D7; operator ruling 42 A).
 *
 * `insertContent` asserts the hash contract: the hash it is given must be the hash of the body. Many tests seed a
 * body row under a hash they choose ("h1", a hash of body + path) so that two rows can share a body or carry a
 * readable id. That is test data, not a writer. This helper writes such a row directly; it is the test-side twin
 * of the one statement in `src/content-insert.ts`, without the assertion. The database handle is the guarded one,
 * so a body that starts with a byte-order mark is still refused.
 *
 * Production code never imports this file. The contract itself is tested in `tests/unit/hash-contract.test.ts`.
 */
import type { Database } from "bun:sqlite";

export function seedContent(db: Database, hash: string, body: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, body, createdAt);
}
