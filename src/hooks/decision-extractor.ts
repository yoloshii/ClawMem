/**
 * Decision Extractor Hook - Stop
 *
 * Fires when a Claude Code session ends. Scans the transcript for
 * decisions made during the conversation and persists them as
 * decision documents in the _clawmem collection.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { Store } from "../store.ts";
import type { HookInput, HookOutput } from "../hooks.ts";
import {
  makeContextOutput,
  makeEmptyOutput,
  readTranscript,
  validateTranscriptPath,
} from "../hooks.ts";
import { hashContent } from "../indexer.ts";
import { extractObservations, type Observation, LITERAL_PREDICATES } from "../observer.ts";
import { updateDirectoryContext } from "../directory-context.ts";
import { loadConfig } from "../collections.ts";
import { getDefaultLlamaCpp } from "../llm.ts";
import type { ObservationWithDoc } from "../amem.ts";
import { extractJsonFromLLM } from "../amem.ts";
import { DEFAULT_EMBED_MODEL, extractSnippet, type SearchResult } from "../store.ts";
import { ensureEntityCanonical, resolveEntityTypeExact } from "../entity.ts";

// Observation types that are allowed to contribute SPO triples. Widened from the
// original {decision, preference, milestone, problem} gate, which rejected 77% of
// real observations in production vaults (the majority type is 'discovery').
// See BACKLOG.md §1.6 for the full diagnosis.
const SPO_ELIGIBLE_OBSERVATION_TYPES = new Set<Observation["type"]>([
  "decision", "preference", "milestone", "problem",
  "discovery", "feature",
]);

// =============================================================================
// Facet-Based Merge Policy
// =============================================================================

export type MergePolicy = 'always_new' | 'merge_recent' | 'update_existing' | 'dedup_check';

/**
 * Content-type-specific merge policy. Controls how new extracted content
 * interacts with existing entries to prevent memory bloat.
 *
 * - always_new: Every entry is unique (handoffs, observations)
 * - merge_recent: Merge with recent same-topic entry if within 7 days
 * - update_existing: Overwrite older entry on same topic
 * - dedup_check: Check embedding similarity before inserting
 */
export function getMergePolicy(contentType: string): MergePolicy {
  switch (contentType) {
    case 'decision': return 'dedup_check';
    case 'antipattern': return 'merge_recent';
    case 'preference': return 'update_existing';
    case 'handoff': return 'always_new';
    default: return 'always_new';
  }
}

const DEDUP_SIMILARITY_THRESHOLD = 0.92;
const MERGE_RECENT_DAYS = 7;

/**
 * Check if a new document should be merged/skipped based on merge policy.
 * Returns the existing doc ID to merge with, or null to insert new.
 */
export async function checkMergePolicy(
  store: Store,
  contentType: string,
  body: string,
  collection: string,
): Promise<{ action: 'insert' | 'skip' | 'merge'; existingId?: number }> {
  const policy = getMergePolicy(contentType);

  if (policy === 'always_new') return { action: 'insert' };

  // Get recent entries of same content type
  const recentDocs = store.getDocumentsByType(contentType, 5);
  if (recentDocs.length === 0) return { action: 'insert' };

  if (policy === 'dedup_check') {
    // Vector similarity check against recent entries
    try {
      const results = await store.searchVec(body.slice(0, 500), DEFAULT_EMBED_MODEL, 3);
      const sameType = results.filter(r =>
        r.collectionName === collection &&
        r.score >= DEDUP_SIMILARITY_THRESHOLD
      );
      if (sameType.length > 0) {
        return { action: 'skip' };
      }
    } catch {
      // Vector search unavailable — fall through to insert
    }
    return { action: 'insert' };
  }

  if (policy === 'merge_recent') {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MERGE_RECENT_DAYS);
    const recent = recentDocs.find(d =>
      d.modifiedAt && new Date(d.modifiedAt) >= cutoff
    );
    if (recent) {
      return { action: 'merge', existingId: recent.id };
    }
    return { action: 'insert' };
  }

  if (policy === 'update_existing') {
    // Find most recent entry of same type
    if (recentDocs.length > 0 && recentDocs[0]) {
      return { action: 'merge', existingId: recentDocs[0].id };
    }
    return { action: 'insert' };
  }

  return { action: 'insert' };
}

// =============================================================================
// Decision Patterns
// =============================================================================

export const DECISION_PATTERNS = [
  /\b(?:we(?:'ll|'ve)?\s+)?decided?\s+(?:to|that|on)\b/i,
  /\b(?:the\s+)?decision\s+(?:is|was)\s+to\b/i,
  /\b(?:we(?:'re)?|i(?:'m)?)\s+going\s+(?:to|with)\b/i,
  /\blet(?:'s)?\s+(?:go\s+with|use|stick\s+with)\b/i,
  /\bchose\s+(?:to)?\b/i,
  /\bwe\s+should\s+(?:use|go\s+with|implement)\b/i,
  /\bthe\s+approach\s+(?:is|will\s+be)\b/i,
  /\b(?:selected|picking|choosing)\s/i,
  /\binstead\s+of\b.*\bwe(?:'ll)?\s/i,
];

// =============================================================================
// Antipattern / Failure Patterns
// =============================================================================

export const FAILURE_PATTERNS = [
  /\b(?:this\s+)?(?:doesn't|didn't|won't)\s+work\b/i,
  /\b(?:bug|error|issue|problem|failure)\s+(?:is|was|caused\s+by)\b/i,
  /\b(?:reverted?|rolled?\s+back|undid|undo)\b/i,
  /\b(?:wrong\s+approach|bad\s+idea|mistake)\b/i,
  /\bdon't\s+(?:use|do|try)\b/i,
  /\b(?:avoid|never|stop)\s+(?:using|doing)\b/i,
];

/**
 * Extract antipatterns (failures, mistakes, things to avoid) from transcript messages.
 * Same extraction structure as extractDecisions but with failure-oriented patterns.
 */
export function extractAntipatterns(
  messages: { role: string; content: string }[]
): { text: string; context: string }[] {
  const antipatterns: { text: string; context: string }[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const sentences = msg.content.split(/[.!]\s+/);

    for (const sentence of sentences) {
      if (sentence.length < 15 || sentence.length > 500) continue;

      for (const pattern of FAILURE_PATTERNS) {
        if (pattern.test(sentence)) {
          const key = sentence.slice(0, 80).toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            // Get surrounding context (previous sentence)
            const idx = sentences.indexOf(sentence);
            const context = idx > 0 ? sentences[idx - 1]!.trim() : "";
            antipatterns.push({ text: sentence.trim(), context });
          }
          break;
        }
      }
    }
  }

  return antipatterns.slice(0, 10);
}

// =============================================================================
// Contradiction Detection
// =============================================================================

async function detectContradictions(
  store: Store,
  newObservations: Observation[],
  sessionId: string
): Promise<number> {
  const decisions = newObservations.filter(o => o.type === "decision");
  if (decisions.length === 0) return 0;

  let contradictionCount = 0;
  const llm = await getDefaultLlamaCpp();
  if (!llm) return 0;

  // Batch all new decision facts
  const newFacts = decisions.flatMap(d => d.facts);
  if (newFacts.length === 0) return 0;

  // Vector search for existing decisions on overlapping topics
  const queryText = newFacts.join(". ");
  let existingDocs: SearchResult[];
  try {
    existingDocs = await store.searchVec(queryText, DEFAULT_EMBED_MODEL, 5);
  } catch {
    existingDocs = store.searchFTS(queryText, 5);
  }

  // Filter to decision/observation docs, exclude same session
  const sessionPrefix = sessionId.slice(0, 8);
  const candidates = existingDocs.filter(d =>
    (d.displayPath.includes("decisions/") || d.displayPath.includes("observations/")) &&
    !d.displayPath.includes(sessionPrefix)
  );

  if (candidates.length === 0) return 0;

  // Build classification prompt
  const existingFacts = candidates
    .map((c, i) => `[OLD-${i}] ${c.displayPath}\n${extractSnippet(c.body || "", queryText, 300).snippet}`)
    .join("\n\n");

  const prompt = `You are analyzing decisions for contradictions.

NEW DECISIONS (this session):
${newFacts.map((f, i) => `[NEW-${i}] ${f}`).join("\n")}

EXISTING DECISIONS (prior sessions):
${existingFacts}

For each NEW decision, check against EXISTING decisions. Classify each relationship:
- "same": Identical decision, no action needed
- "update": New decision supersedes/refines old one
- "contradiction": New decision directly conflicts with old one

Return JSON array:
[{"new_idx": 0, "old_idx": 0, "relation": "update|contradiction|same", "confidence": 0.0-1.0, "reasoning": "..."}]

Only include pairs with confidence >= 0.7. Return [] if no relationships found. /no_think`;

  try {
    const result = await llm.generate(prompt, { temperature: 0.3, maxTokens: 400 });
    if (!result) return 0;
    const parsed = extractJsonFromLLM(result.text);
    if (!Array.isArray(parsed)) return 0;

    for (const rel of parsed) {
      if (rel.confidence < 0.7) continue;
      const oldDoc = candidates[rel.old_idx];
      if (!oldDoc) continue;

      const existingDoc = store.findActiveDocument(oldDoc.collectionName, oldDoc.filepath);
      if (!existingDoc) continue;

      if (rel.relation === "contradiction") {
        // Lower old doc confidence by 0.25 (floor 0.2)
        const currentConfidence = existingDoc.confidence ?? 0.5;
        const newConfidence = Math.max(0.2, currentConfidence - 0.25);
        store.updateDocumentMeta(existingDoc.id, {
          confidence: newConfidence,
        });
        contradictionCount++;
        console.error(
          `[decision-extractor] CONTRADICTION: "${newFacts[rel.new_idx]}" vs "${oldDoc.displayPath}" (conf: ${rel.confidence})`
        );

        // Soft invalidation: if confidence drops to floor AND content is observation type,
        // mark as invalidated (Pattern I — prevents stale contradicted knowledge from surfacing)
        if (newConfidence <= 0.2) {
          try {
            // Find the new contradicting observation's doc ID (if already persisted in this session)
            const newObsDoc = store.db.prepare(`
              SELECT id FROM documents
              WHERE collection = '_clawmem' AND path LIKE ? AND active = 1
              ORDER BY created_at DESC LIMIT 1
            `).get(`%${sessionId.slice(0, 8)}%decision%`) as { id: number } | undefined;

            store.db.prepare(`
              UPDATE documents
              SET invalidated_at = datetime('now'),
                  invalidated_by = ?
              WHERE id = ? AND invalidated_at IS NULL AND content_type = 'observation'
            `).run(newObsDoc?.id || null, existingDoc.id);
          } catch { /* non-fatal — invalidation is best-effort */ }
        }

      } else if (rel.relation === "update") {
        // Lower old doc confidence by 0.15 (floor 0.3)
        const currentConfidence = existingDoc.confidence ?? 0.5;
        store.updateDocumentMeta(existingDoc.id, {
          confidence: Math.max(0.3, currentConfidence - 0.15),
        });
      }
    }
  } catch (err) {
    console.error(`[decision-extractor] Contradiction classification failed:`, err);
  }

  return contradictionCount;
}

// =============================================================================
// Handler
// =============================================================================

export async function decisionExtractor(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  const transcriptPath = validateTranscriptPath(input.transcriptPath);
  if (!transcriptPath) return makeEmptyOutput("decision-extractor");

  const messages = readTranscript(transcriptPath, 200);
  if (messages.length === 0) return makeEmptyOutput("decision-extractor");

  const sessionId = input.sessionId || `session-${Date.now()}`;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString();

  // Try observer first for structured observations
  const observations = await extractObservations(messages);
  const observedDecisions = observations.filter(o => o.type === "decision");

  // Persist ALL observations unconditionally (C2 fix: not gated on decisions existing)
  const observationsWithDocs: ObservationWithDoc[] = [];
  if (observations.length > 0) {
    for (const obs of observations) {
      const wit = persistObservationDoc(store, obs, sessionId, dateStr, timestamp);
      if (wit) observationsWithDocs.push(wit);
    }

    // Infer causal links from observations with facts
    if (observationsWithDocs.length > 0) {
      try {
        const llm = await getDefaultLlamaCpp();
        if (llm) {
          await store.inferCausalLinks(llm, observationsWithDocs);
        }
      } catch (err) {
        console.log(`[decision-extractor] Error in causal inference:`, err);
      }
    }

    // Extract SPO triples from observation-emitted <triples> blocks (Fix A).
    // The regex-based extractTripleFromFact is gone — the observer LLM now emits
    // structured triples alongside facts, parsed and validated in parseObservationXml.
    // We iterate observationsWithDocs (not raw observations) so every triple gets
    // real source_doc_id provenance from the persisted observation document (Fix F).
    insertObservationTriples(store, observations, observationsWithDocs);
  }

  // Extract decisions (observer-first, regex fallback)
  let decisionBody: string;
  let decisionCount: number;
  let decisionFacts: string = ""; // Stable semantic payload for dedup hashing

  if (observedDecisions.length > 0) {
    decisionBody = formatObservedDecisions(observedDecisions, dateStr, sessionId);
    decisionCount = observedDecisions.length;
    decisionFacts = observedDecisions.map(d => [d.title, ...d.facts].join(". ")).join("\n");

    // Detect contradictions with existing decisions
    try {
      const contradictions = await detectContradictions(store, observedDecisions, sessionId);
      if (contradictions > 0) {
        console.error(`[decision-extractor] Found ${contradictions} contradiction(s) with prior decisions`);
      }
    } catch (err) {
      console.error(`[decision-extractor] Error in contradiction detection:`, err);
    }
  } else {
    // Fallback to regex extraction
    const decisions = extractDecisions(messages);
    if (decisions.length === 0 && observations.length === 0) return makeEmptyOutput("decision-extractor");

    if (decisions.length === 0) {
      decisionBody = `# Session Observations ${dateStr}\n\nNo decisions extracted. ${observations.length} observation(s) persisted separately.\n`;
      decisionCount = 0;
    } else {
      decisionBody = formatDecisionLog(decisions, dateStr, sessionId);
      decisionCount = decisions.length;
      decisionFacts = decisions.map(d => d.text).join("\n");
    }
  }

  // Save decision via unified saveMemory API (handles dedup + upsert)
  const semanticPayload = decisionFacts || decisionBody;

  const decisionPath = `decisions/${dateStr}-${sessionId.slice(0, 8)}.md`;

  // Check existing merge policy first (vector-based dedup for decisions)
  const mergeResult = await checkMergePolicy(store, "decision", decisionBody, "_clawmem");

  if (mergeResult.action === 'skip') {
    process.stderr.write(`[decision-extractor] Skipped near-duplicate decision (vector dedup)\n`);
  } else if (mergeResult.action === 'merge' && mergeResult.existingId) {
    // Merge with existing entry (update content)
    const mergeHash = hashContent(decisionBody);
    store.insertContent(mergeHash, decisionBody, timestamp);
    store.db.prepare(
      "UPDATE documents SET hash = ?, modified_at = ?, revision_count = revision_count + 1, last_seen_at = ? WHERE id = ?"
    ).run(mergeHash, timestamp, timestamp, mergeResult.existingId);
  } else {
    // Use saveMemory for dedup-protected insert
    const result = store.saveMemory({
      collection: "_clawmem",
      path: decisionPath,
      title: `Decisions ${dateStr}`,
      body: decisionBody,
      contentType: "decision",
      confidence: observedDecisions.length > 0 ? 0.90 : 0.85,
      semanticPayload,
    });

    if (result.action === 'deduplicated') {
      process.stderr.write(`[decision-extractor] Dedup: existing decision within window (doc ${result.docId}, count=${result.duplicateCount})\n`);
    }
  }

  // Extract and store antipatterns (E8) via saveMemory
  try {
    const antipatterns = extractAntipatterns(messages);
    if (antipatterns.length > 0) {
      const antiBody = [
        `# Antipatterns ${dateStr}`,
        ``,
        `_Session: ${sessionId.slice(0, 8)}_`,
        ``,
        ...antipatterns.map(a => {
          const ctx = a.context ? `\n  > Context: ${a.context.slice(0, 150)}` : "";
          return `- **Avoid:** ${a.text}${ctx}`;
        }),
      ].join("\n");

      // Semantic payload: the antipattern texts only (stable across date wrappers)
      const antiSemanticPayload = antipatterns.map(a => a.text).join("\n");
      const antiPath = `antipatterns/${dateStr}-${sessionId.slice(0, 8)}.md`;

      // Check existing merge policy first (merge_recent for antipatterns)
      const antiMerge = await checkMergePolicy(store, "antipattern", antiBody, "_clawmem");

      if (antiMerge.action === 'skip') {
        // Near-duplicate — skip
      } else if (antiMerge.action === 'merge' && antiMerge.existingId) {
        const antiHash = hashContent(antiBody);
        store.insertContent(antiHash, antiBody, timestamp);
        store.db.prepare(
          "UPDATE documents SET hash = ?, modified_at = ?, revision_count = revision_count + 1, last_seen_at = ? WHERE id = ?"
        ).run(antiHash, timestamp, timestamp, antiMerge.existingId);
      } else {
        const result = store.saveMemory({
          collection: "_clawmem",
          path: antiPath,
          title: `Antipatterns ${dateStr}`,
          body: antiBody,
          contentType: "antipattern",
          confidence: 0.75,
          semanticPayload: antiSemanticPayload,
        });

        if (result.action === 'deduplicated') {
          process.stderr.write(`[decision-extractor] Dedup: antipattern within window (doc ${result.docId})\n`);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Trigger directory context update if enabled and observer found files
  const config = loadConfig();
  if (config.directoryContext) {
    const allModifiedFiles = observations.flatMap(o => o.filesModified);
    if (allModifiedFiles.length > 0) {
      try {
        updateDirectoryContext(store, allModifiedFiles);
      } catch { /* non-fatal */ }
    }
  }

  return makeEmptyOutput("decision-extractor");
}

// =============================================================================
// Extraction
// =============================================================================

export type Decision = {
  text: string;
  context: string;
};

export function extractDecisions(messages: { role: string; content: string }[]): Decision[] {
  const decisions: Decision[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;

    const sentences = msg.content.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
      if (sentence.length < 20 || sentence.length > 500) continue;

      const isDecision = DECISION_PATTERNS.some(p => p.test(sentence));
      if (!isDecision) continue;

      // Deduplicate by first 80 chars
      const key = sentence.slice(0, 80).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Get preceding user message as context
      let context = "";
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        if (messages[j]!.role === "user") {
          context = messages[j]!.content.slice(0, 200);
          break;
        }
      }

      decisions.push({ text: sentence.trim(), context });
    }
  }

  return decisions;
}

// =============================================================================
// Formatting
// =============================================================================

function formatDecisionLog(decisions: Decision[], dateStr: string, sessionId: string): string {
  const lines = [
    `---`,
    `content_type: decision`,
    `tags: [auto-extracted]`,
    `---`,
    ``,
    `# Decisions — ${dateStr}`,
    ``,
    `Session: \`${sessionId.slice(0, 8)}\``,
    ``,
  ];

  for (const d of decisions) {
    lines.push(`- ${d.text}`);
    if (d.context) {
      lines.push(`  > Context: ${d.context.split("\n")[0]}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatObservedDecisions(observations: Observation[], dateStr: string, sessionId: string): string {
  const lines = [
    `---`,
    `content_type: decision`,
    `tags: [auto-extracted, observer]`,
    `---`,
    ``,
    `# Decisions — ${dateStr}`,
    ``,
    `Session: \`${sessionId.slice(0, 8)}\``,
    ``,
  ];

  for (const obs of observations) {
    lines.push(`## ${obs.title}`, ``);
    if (obs.narrative) {
      lines.push(obs.narrative, ``);
    }
    if (obs.facts.length > 0) {
      lines.push(`**Facts:**`);
      for (const fact of obs.facts) {
        lines.push(`- ${fact}`);
      }
      lines.push(``);
    }
    if (obs.filesModified.length > 0) {
      lines.push(`**Files:** ${obs.filesModified.map(f => `\`${f}\``).join(", ")}`, ``);
    }
  }

  return lines.join("\n");
}

function formatObservation(obs: Observation, dateStr: string, sessionId: string): string {
  const lines = [
    `---`,
    `content_type: ${obs.type === "decision" ? "decision" : "note"}`,
    `tags: [auto-extracted, observer, ${obs.type}]`,
    `---`,
    ``,
    `# ${obs.title}`,
    ``,
    `Session: \`${sessionId.slice(0, 8)}\` | Date: ${dateStr} | Type: ${obs.type}`,
    ``,
  ];

  if (obs.narrative) {
    lines.push(obs.narrative, ``);
  }

  if (obs.facts.length > 0) {
    lines.push(`## Facts`, ``);
    for (const fact of obs.facts) {
      lines.push(`- ${fact}`);
    }
    lines.push(``);
  }

  if (obs.concepts.length > 0) {
    lines.push(`## Concepts`, ``);
    lines.push(obs.concepts.join(", "), ``);
  }

  if (obs.filesRead.length > 0) {
    lines.push(`## Files Read`, ``);
    for (const f of obs.filesRead) {
      lines.push(`- \`${f}\``);
    }
    lines.push(``);
  }

  if (obs.filesModified.length > 0) {
    lines.push(`## Files Modified`, ``);
    for (const f of obs.filesModified) {
      lines.push(`- \`${f}\``);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// =============================================================================
// Observation persistence
// =============================================================================

/**
 * Persist a single observation as a `_clawmem` document and return an
 * `ObservationWithDoc` for downstream consumers (causal inference + SPO
 * triples).
 *
 * Path format: `observations/${date}-${session8}-${type}-${hash8}.md`. The
 * 8-char hash slice (SHA256 of the formatted body) disambiguates multiple
 * observations of the same type within a single session — without it, the
 * second insert hits the `UNIQUE(collection, path)` constraint, is silently
 * dropped, and its triples never reach `entity_triples`. See Codex Turn 3
 * for the regression this guards against.
 *
 * Returns null when the doc cannot be looked up after insert OR when the
 * observation has no facts (triples without facts wouldn't survive the
 * causal-links/facts filter downstream).
 */
export function persistObservationDoc(
  store: Store,
  obs: Observation,
  sessionId: string,
  dateStr: string,
  timestamp: string
): ObservationWithDoc | null {
  const obsBody = formatObservation(obs, dateStr, sessionId);
  const obsHash = hashContent(obsBody);
  const obsPath = `observations/${dateStr}-${sessionId.slice(0, 8)}-${obs.type}-${obsHash.slice(0, 8)}.md`;

  store.insertContent(obsHash, obsBody, timestamp);
  try {
    store.insertDocument("_clawmem", obsPath, obs.title, obsHash, timestamp, timestamp);
    const doc = store.findActiveDocument("_clawmem", obsPath);
    if (!doc) return null;

    store.updateDocumentMeta(doc.id, {
      content_type: obs.type === "decision" ? "decision"
        : obs.type === "preference" ? "preference"
        : obs.type === "milestone" ? "milestone"
        : obs.type === "problem" ? "problem"
        : "observation",
      confidence: 0.80,
    });
    store.updateObservationFields(obsPath, "_clawmem", {
      observation_type: obs.type,
      facts: JSON.stringify(obs.facts),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.filesRead),
      files_modified: JSON.stringify(obs.filesModified),
    });

    if (obs.facts.length === 0) return null;
    return {
      docId: doc.id,
      facts: obs.facts,
      obsType: obs.type,
      triples: obs.triples,
    };
  } catch (err) {
    console.log(`[decision-extractor] Failed to persist observation ${obs.type}/${obs.title}:`, err);
    return null;
  }
}

// =============================================================================
// SPO Triple Extraction from Facts
// =============================================================================

/**
 * Insert SPO triples emitted by the observer into `entity_triples`.
 *
 * Uses canonical vault:type:slug entity IDs via `ensureEntityCanonical` so the
 * knowledge graph stays in one namespace with A-MEM entities. Type inheritance
 * is exact-match-only and ambiguity-safe: if a name resolves to exactly one type
 * already in `entity_nodes`, inherit it; otherwise default to `concept`.
 *
 * Provenance: every triple carries `source_doc_id` from the persisted observation
 * document. Iterates `observationsWithDocs` directly so triples from observations
 * whose doc insert failed are naturally skipped — no order-matching gymnastics.
 */
function insertObservationTriples(
  store: Store,
  _observations: Observation[],
  observationsWithDocs: ObservationWithDoc[]
): void {
  if (observationsWithDocs.length === 0) return;

  // Per-invocation cache keyed on (vault, normalizedName, resolvedType) to avoid
  // redundant SQL for repeated entity references within a single extraction.
  const vault = "default";
  const cache = new Map<string, string>();

  const resolveEntity = (name: string, type: string): string => {
    const key = `${vault}:${type}:${name.toLowerCase().trim()}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const id = ensureEntityCanonical(store.db, name, type, vault);
    cache.set(key, id);
    return id;
  };

  for (const wit of observationsWithDocs) {
    if (!wit.triples || wit.triples.length === 0) continue;
    const obsType = wit.obsType as Observation["type"] | undefined;
    if (!obsType || !SPO_ELIGIBLE_OBSERVATION_TYPES.has(obsType)) continue;

    const confidence = obsType === "decision" || obsType === "preference" ? 0.9 : 0.7;

    for (const triple of wit.triples) {
      try {
        const subjectType = resolveEntityTypeExact(store.db, triple.subject, vault) ?? "concept";
        const subjectId = resolveEntity(triple.subject, subjectType);

        let objectId: string | null = null;
        let objectLiteral: string | null = null;

        if (LITERAL_PREDICATES.has(triple.predicate)) {
          objectLiteral = triple.object;
        } else {
          const objectType = resolveEntityTypeExact(store.db, triple.object, vault) ?? "concept";
          objectId = resolveEntity(triple.object, objectType);
        }

        store.addTriple(subjectId, triple.predicate, objectId, objectLiteral, {
          confidence,
          sourceFact: `${triple.subject} ${triple.predicate} ${triple.object}`,
          sourceDocId: wit.docId,
        });
      } catch (err) {
        // Triple insertion errors are non-fatal — log at debug
        console.log(`[decision-extractor] Failed to insert triple ${triple.subject}/${triple.predicate}/${triple.object}:`, err);
      }
    }
  }
}
