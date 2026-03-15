/**
 * Feedback Loop Hook - Stop
 *
 * Fires when a session ends. Detects which surfaced notes were actually
 * referenced by the assistant, and boosts their access counts.
 * This closes the learning loop: notes that prove useful rise in confidence,
 * unused notes gradually decay.
 *
 * Silent — does not inject context back to Claude.
 */

import type { Store } from "../store.ts";
import type { HookInput, HookOutput } from "../hooks.ts";
import {
  makeEmptyOutput,
  readTranscript,
  validateTranscriptPath,
} from "../hooks.ts";

// =============================================================================
// Handler
// =============================================================================

export async function feedbackLoop(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  const transcriptPath = validateTranscriptPath(input.transcriptPath);
  const sessionId = input.sessionId;
  if (!transcriptPath || !sessionId) return makeEmptyOutput("feedback-loop");

  // Get all notes injected during this session
  const usages = store.getUsageForSession(sessionId);
  if (usages.length === 0) return makeEmptyOutput("feedback-loop");

  // Collect all injected paths
  const injectedPaths = new Set<string>();
  for (const u of usages) {
    try {
      const paths = JSON.parse(u.injectedPaths) as string[];
      for (const p of paths) injectedPaths.add(p);
    } catch {
      // Skip malformed
    }
  }

  if (injectedPaths.size === 0) return makeEmptyOutput("feedback-loop");

  // Read assistant messages from transcript
  const assistantMessages = readTranscript(transcriptPath, 200, "assistant");
  if (assistantMessages.length === 0) return makeEmptyOutput("feedback-loop");

  // Build full assistant text for reference detection
  const assistantText = assistantMessages.map(m => m.content).join("\n");

  // Detect references: check if the assistant mentioned any injected path or title
  const referencedPaths: string[] = [];

  for (const path of injectedPaths) {
    // Check for path reference
    if (assistantText.includes(path)) {
      referencedPaths.push(path);
      continue;
    }

    // Check for filename reference
    const filename = path.split("/").pop()?.replace(/\.(md|txt)$/i, "");
    if (filename && filename.length > 3 && assistantText.toLowerCase().includes(filename.toLowerCase())) {
      referencedPaths.push(path);
      continue;
    }

    // Check for title reference (look up from DB)
    const titleMatch = checkTitleReference(store, path, assistantText);
    if (titleMatch) {
      referencedPaths.push(path);
    }
  }

  // Boost access counts for referenced notes
  if (referencedPaths.length > 0) {
    store.incrementAccessCount(referencedPaths);

    // Mark usage records as referenced
    for (const u of usages) {
      try {
        const paths = JSON.parse(u.injectedPaths) as string[];
        if (paths.some(p => referencedPaths.includes(p))) {
          store.markUsageReferenced(u.id);
        }
      } catch {
        // Skip
      }
    }

    // Record usage relations between co-referenced documents
    if (referencedPaths.length >= 2) {
      try {
        const docIds = new Map<string, number>();
        for (const path of referencedPaths) {
          const parts = path.split("/");
          if (parts.length < 2) continue;
          const collection = parts[0]!;
          const docPath = parts.slice(1).join("/");
          const doc = store.findActiveDocument(collection, docPath);
          if (doc) docIds.set(path, doc.id);
        }
        const ids = [...docIds.values()];
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            store.insertRelation(ids[i]!, ids[j]!, "usage");
          }
        }
      } catch {
        // Non-critical — don't block feedback loop on relation errors
      }
    }

    // Record co-activations for the referenced paths
    if (referencedPaths.length >= 2) {
      store.recordCoActivation(referencedPaths);
    }
  }

  // Utility tracking: detect pin/snooze candidates based on usage patterns
  try {
    trackUtilitySignals(store, injectedPaths, referencedPaths);
  } catch {
    // Non-critical — don't block feedback loop on utility tracking errors
  }

  // Silent return — feedback loop doesn't inject context
  return makeEmptyOutput("feedback-loop");
}

// =============================================================================
// Utility Signal Tracking
// =============================================================================

/**
 * Track utility signals for lifecycle automation (ReMe-inspired u/f ratio).
 *
 * For each injected path, records whether it was referenced (useful) or not (noise).
 * Over time this builds a utility profile per document:
 * - High utility (referenced often) → pin candidate
 * - Low utility (surfaced often, never referenced) → snooze candidate
 *
 * Writes to `utility_signals` table (created lazily).
 */
function trackUtilitySignals(
  store: Store,
  injectedPaths: Set<string>,
  referencedPaths: string[]
): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS utility_signals (
      path TEXT NOT NULL,
      surfaced_count INTEGER NOT NULL DEFAULT 0,
      referenced_count INTEGER NOT NULL DEFAULT 0,
      last_surfaced TEXT,
      last_referenced TEXT,
      PRIMARY KEY (path)
    )
  `);

  const referencedSet = new Set(referencedPaths);
  const now = new Date().toISOString();

  const upsert = store.db.prepare(`
    INSERT INTO utility_signals (path, surfaced_count, referenced_count, last_surfaced, last_referenced)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      surfaced_count = surfaced_count + 1,
      referenced_count = referenced_count + ?,
      last_surfaced = ?,
      last_referenced = CASE WHEN ? > 0 THEN ? ELSE last_referenced END
  `);

  for (const path of injectedPaths) {
    const wasReferenced = referencedSet.has(path) ? 1 : 0;
    upsert.run(
      path,
      wasReferenced,
      now,
      wasReferenced > 0 ? now : null,
      wasReferenced,
      now,
      wasReferenced,
      now
    );
  }
}

// =============================================================================
// Reference Detection
// =============================================================================

function checkTitleReference(store: Store, path: string, text: string): boolean {
  try {
    const parts = path.split("/");
    if (parts.length < 2) return false;
    const collection = parts[0]!;
    const docPath = parts.slice(1).join("/");
    const doc = store.findActiveDocument(collection, docPath);
    if (!doc?.title) return false;

    // Skip generic titles
    if (doc.title.length < 5) return false;

    return text.toLowerCase().includes(doc.title.toLowerCase());
  } catch {
    return false;
  }
}
