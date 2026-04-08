/**
 * Recall Tracking — direct-write recall event recording.
 *
 * Context-surfacing writes recall events directly to SQLite (single transaction,
 * <0.4ms for ~12 rows). This replaces the original in-memory buffer design which
 * failed in Claude Code mode where each hook is a separate process invocation.
 *
 * Per GPT 5.4 High review (Codex turn 1):
 * - Direct INSERT is preferred over buffer for cross-process correctness
 * - WAL mode handles concurrent writes safely (busy_timeout=5000ms)
 * - Negative signals (surfaced but not referenced) marked retroactively by feedback-loop
 */

import { createHash } from "crypto";
import type { Store } from "./store.ts";

// =============================================================================
// Query Hashing
// =============================================================================

/**
 * Hash a query string for recall tracking.
 * SHA1 truncated to 12 hex chars (same as OpenClaw's approach).
 */
export function hashQuery(query: string): string {
  return createHash("sha1")
    .update(query.toLowerCase().trim())
    .digest("hex")
    .slice(0, 12);
}

// =============================================================================
// Direct Write (replaces in-memory buffer)
// =============================================================================

/**
 * Record surfaced documents as recall events directly to SQLite.
 * Called from context-surfacing hook — single transaction, ~0.4ms.
 *
 * Resolves displayPath → doc_id inline. Docs that can't be resolved
 * (deleted between search and write) are silently skipped.
 *
 * @param store - Store instance with DB access
 * @param sessionId - Current session identifier
 * @param queryHash - SHA1 hash of the search query
 * @param docs - Array of {displayPath, searchScore} for each surfaced result
 * @returns Number of events recorded
 */
export function writeRecallEvents(
  store: Store,
  sessionId: string,
  queryHash: string,
  docs: { displayPath: string; searchScore: number }[],
  usageId?: number,
  turnIndex?: number
): number {
  if (!sessionId || docs.length === 0) return 0;

  const resolved: { docId: number; queryHash: string; searchScore: number; sessionId: string }[] = [];

  for (const doc of docs) {
    const parts = doc.displayPath.split("/");
    if (parts.length < 2) continue;
    const collection = parts[0]!;
    const docPath = parts.slice(1).join("/");
    const found = store.findActiveDocument(collection, docPath);
    if (!found) {
      console.debug?.(`[recall] skipping unresolvable displayPath: ${doc.displayPath}`);
      continue;
    }

    resolved.push({
      docId: found.id,
      queryHash,
      searchScore: doc.searchScore,
      sessionId,
      usageId,
      turnIndex,
    });
  }

  if (resolved.length === 0) return 0;
  return store.insertRecallEvents(resolved);
}

