/**
 * BACKLOG 82.3, D7 — the ONE statement that writes a body row, and the hash contract it asserts.
 *
 * A writer takes its body and its hash from `normalizedContent` (normalise, then hash) and hands both here. Nothing
 * is normalised in this module. Every writer of `content` under `src/` calls this function: a source test counts
 * the inserts.
 */
import type { Database } from "bun:sqlite";
import { normalizedContent } from "./text-policy.ts";

/**
 * `insertContent` was given a pair that breaks the hash contract: a body that still starts with a byte-order mark, or
 * a hash that is not the hash of that body. It is a fault of the CALLER (a writer that did not go through
 * `normalizedContent`), and nothing was stored. The message holds no part of the body.
 */
export class ContentContractError extends Error {
  constructor(public readonly reason: "leading-mark" | "not-normalised" | "hash-mismatch") {
    super(reason === "leading-mark"
      ? "insertContent: the body starts with a byte-order mark — the writer must normalise it first (normalizedContent)"
      : reason === "not-normalised"
      ? "insertContent: the body holds a lone UTF-16 surrogate — the writer must normalise it first (normalizedContent)"
      : "insertContent: the hash is not the hash of the body — the writer must take both from normalizedContent");
    this.name = "ContentContractError";
  }
}

/**
 * Insert a body into the content table (content-addressable storage). `INSERT OR IGNORE`: a hash that is already
 * stored is skipped. Throws `ContentContractError`, before any statement runs, when the pair breaks the contract.
 */
export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  const sound = normalizedContent(content);
  if (sound.body.length !== content.length) throw new ContentContractError("leading-mark");
  if (sound.body !== content) throw new ContentContractError("not-normalised");   // a lone surrogate keeps the length
  if (sound.hash !== hash) throw new ContentContractError("hash-mismatch");
  const r = db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
  if (r.changes > 0) return;
  // The hash is already stored. A row whose bytes are not this body's was written by an older
  // version (a body holding a lone UTF-16 surrogate was hashed as U+FFFD and stored as other bytes, which read back
  // lossily, sometimes as empty text); the hash certifies this body, so the row is rewritten, and the search rows of the active documents
  // that hold it follow (the FTS triggers copy the body only when a DOCUMENT row changes).
  const row = db.prepare(`SELECT CAST(doc AS BLOB) AS b FROM content WHERE hash = ?`).get(hash) as { b: Uint8Array | null } | null;
  const want = utf8.encode(content);
  if (!row || (row.b instanceof Uint8Array && row.b.length === want.length && row.b.every((x, i) => x === want[i]))) return;
  // One unit (Codex T2 S2): a SAVEPOINT nests in a caller's transaction and is a transaction of its own otherwise, so
  // a failure between the two statements leaves neither — and a retry still sees the old bytes and does both.
  db.exec("SAVEPOINT clawmem_content_rewrite");
  try {
    db.prepare(`UPDATE content SET doc = ? WHERE hash = ?`).run(content, hash);
    db.prepare(`INSERT OR REPLACE INTO documents_fts (rowid, filepath, title, body)
                SELECT id, collection || '/' || path, title, (SELECT doc FROM content WHERE hash = ?) FROM documents WHERE hash = ? AND active = 1`)
      .run(hash, hash);
    db.exec("RELEASE clawmem_content_rewrite");
  } catch (err) {
    db.exec("ROLLBACK TO clawmem_content_rewrite");
    db.exec("RELEASE clawmem_content_rewrite");
    throw err;
  }
}

const utf8 = new TextEncoder();
