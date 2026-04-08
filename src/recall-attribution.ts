/**
 * Recall Attribution — per-turn reference detection for recall tracking.
 *
 * Extracted into a standalone module for testability (per GPT 5.4 High review turn 4).
 *
 * Architecture:
 * 1. Segment the transcript into ordered turns (user → assistant pairs)
 * 2. Zip context_usage rows (by turn_index) with transcript turns (by position)
 * 3. For each pair, detect references in that turn's assistant text only
 * 4. Mark recall_events linked to the usage rows whose turn actually cited the doc
 */

import type { Store, UsageRow } from "./store.ts";

// =============================================================================
// Types
// =============================================================================

export type TranscriptTurn = {
  userText: string;
  assistantText: string;
};

// =============================================================================
// Transcript Segmentation
// =============================================================================

/**
 * Segment a flat message array into ordered turns.
 * A turn starts on each "user" message and includes all following "assistant"
 * messages until the next "user" message.
 *
 * @param messages - Ordered array of {role, content} from transcript JSONL
 * @returns Ordered array of turns
 */
export function segmentTranscriptIntoTurns(
  messages: { role: string; content: string }[]
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let currentUser = "";
  let currentAssistant = "";

  for (const msg of messages) {
    if (msg.role === "user") {
      // New turn: flush previous if it has assistant content
      if (currentUser || currentAssistant) {
        turns.push({ userText: currentUser, assistantText: currentAssistant });
      }
      currentUser = msg.content;
      currentAssistant = "";
    } else if (msg.role === "assistant") {
      currentAssistant += (currentAssistant ? "\n" : "") + msg.content;
    }
    // Ignore system/tool messages for attribution purposes
  }

  // Flush final turn
  if (currentUser || currentAssistant) {
    turns.push({ userText: currentUser, assistantText: currentAssistant });
  }

  return turns;
}

// =============================================================================
// Per-Turn Reference Detection
// =============================================================================

/**
 * Check if a displayPath (collection/path) is referenced in text.
 * Matches by: full path, filename (without extension), or doc title.
 */
function isPathReferenced(
  store: Store,
  displayPath: string,
  text: string
): boolean {
  if (!text || !displayPath) return false;

  // Full path match
  if (text.includes(displayPath)) return true;

  // Filename match (without extension, min 4 chars)
  const filename = displayPath.split("/").pop()?.replace(/\.(md|txt)$/i, "");
  if (filename && filename.length > 3 && text.toLowerCase().includes(filename.toLowerCase())) {
    return true;
  }

  // Title match from DB
  const parts = displayPath.split("/");
  if (parts.length >= 2) {
    const collection = parts[0]!;
    const docPath = parts.slice(1).join("/");
    const doc = store.findActiveDocument(collection, docPath);
    if (doc?.title && doc.title.length >= 5 && text.toLowerCase().includes(doc.title.toLowerCase())) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Attribution Core
// =============================================================================

/**
 * Attribute recall events to specific turns using per-turn reference detection.
 *
 * For each context_usage row (ordered by turn_index), finds the corresponding
 * transcript turn and checks which of that turn's injected docs were cited in
 * that turn's assistant text. Only marks recall_events linked to turns where
 * the doc was actually referenced.
 *
 * @param store - Store instance for doc resolution and event marking
 * @param sessionId - Session identifier
 * @param usages - context_usage rows for this session, ordered by turn_index
 * @param turns - Transcript turns, ordered by position
 */
export function attributeRecallReferences(
  store: Store,
  sessionId: string,
  usages: UsageRow[],
  turns: TranscriptTurn[]
): void {
  // Filter to context-surfacing usages only
  const surfacingUsages = usages.filter(u => u.hookName === "context-surfacing");

  for (const usage of surfacingUsages) {
    // Match usage to transcript turn by turn_index
    const turn = turns[usage.turnIndex];
    if (!turn || !turn.assistantText) continue;

    // Parse injected paths for this turn
    let injectedPaths: string[];
    try { injectedPaths = JSON.parse(usage.injectedPaths) as string[]; }
    catch { continue; }
    if (injectedPaths.length === 0) continue;

    // Check which docs from THIS turn were referenced in THIS turn's assistant text
    const referencedDocIds: number[] = [];
    for (const path of injectedPaths) {
      if (!isPathReferenced(store, path, turn.assistantText)) continue;

      const parts = path.split("/");
      if (parts.length < 2) continue;
      const collection = parts[0]!;
      const docPath = parts.slice(1).join("/");
      const doc = store.findActiveDocument(collection, docPath);
      if (doc) referencedDocIds.push(doc.id);
    }

    if (referencedDocIds.length === 0) continue;

    // Mark only recall events linked to THIS usage row
    for (const docId of referencedDocIds) {
      // Primary: usage_id-linked events (current schema)
      const linked = store.db.prepare(`
        SELECT id FROM recall_events
        WHERE usage_id = ? AND doc_id = ? AND was_referenced = 0
      `).all(usage.id, docId) as { id: number }[];

      if (linked.length > 0) {
        const ids = linked.map(r => r.id);
        const placeholders = ids.map(() => "?").join(",");
        store.db.prepare(`
          UPDATE recall_events SET was_referenced = 1
          WHERE id IN (${placeholders})
        `).run(...ids);
      } else {
        // Fallback: pre-migration events without usage_id — match by turn_index
        store.db.prepare(`
          UPDATE recall_events SET was_referenced = 1
          WHERE id IN (
            SELECT id FROM recall_events
            WHERE session_id = ? AND doc_id = ? AND turn_index = ? AND was_referenced = 0
          )
        `).run(sessionId, docId, usage.turnIndex);
      }
    }
  }
}
