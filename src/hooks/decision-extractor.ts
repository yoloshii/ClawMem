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
import { extractObservations, type Observation } from "../observer.ts";
import { updateDirectoryContext } from "../directory-context.ts";
import { loadConfig } from "../collections.ts";
import { getDefaultLlamaCpp } from "../llm.ts";
import type { ObservationWithDoc } from "../amem.ts";
import { extractJsonFromLLM } from "../amem.ts";
import { DEFAULT_EMBED_MODEL, extractSnippet, type SearchResult } from "../store.ts";

// =============================================================================
// Decision Patterns
// =============================================================================

const DECISION_PATTERNS = [
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
        store.updateDocumentMeta(existingDoc.id, {
          confidence: Math.max(0.2, currentConfidence - 0.25),
        });
        contradictionCount++;
        console.error(
          `[decision-extractor] CONTRADICTION: "${newFacts[rel.new_idx]}" vs "${oldDoc.displayPath}" (conf: ${rel.confidence})`
        );
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
      const obsPath = `observations/${dateStr}-${sessionId.slice(0, 8)}-${obs.type}.md`;
      const obsBody = formatObservation(obs, dateStr, sessionId);
      const obsHash = hashContent(obsBody);

      store.insertContent(obsHash, obsBody, timestamp);
      try {
        store.insertDocument("_clawmem", obsPath, obs.title, obsHash, timestamp, timestamp);
        const doc = store.findActiveDocument("_clawmem", obsPath);
        if (doc) {
          store.updateDocumentMeta(doc.id, {
            content_type: obs.type === "decision" ? "decision" : "note",
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

          if (obs.facts.length > 0) {
            observationsWithDocs.push({
              docId: doc.id,
              facts: obs.facts,
            });
          }
        }
      } catch {
        // May already exist
      }
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
  }

  // Extract decisions (observer-first, regex fallback)
  let decisionBody: string;
  let decisionCount: number;

  if (observedDecisions.length > 0) {
    decisionBody = formatObservedDecisions(observedDecisions, dateStr, sessionId);
    decisionCount = observedDecisions.length;

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
    }
  }

  const decisionHash = hashContent(decisionBody);

  // Store main decision document
  store.insertContent(decisionHash, decisionBody, timestamp);

  const decisionPath = `decisions/${dateStr}-${sessionId.slice(0, 8)}.md`;
  try {
    store.insertDocument(
      "_clawmem",
      decisionPath,
      `Decisions ${dateStr}`,
      decisionHash,
      timestamp,
      timestamp
    );

    const doc = store.findActiveDocument("_clawmem", decisionPath);
    if (doc) {
      store.updateDocumentMeta(doc.id, {
        content_type: "decision",
        confidence: observedDecisions.length > 0 ? 0.90 : 0.85,
      });
    }
  } catch {
    const existing = store.findActiveDocument("_clawmem", decisionPath);
    if (existing) {
      store.db.prepare(
        "UPDATE documents SET hash = ?, modified_at = ? WHERE id = ?"
      ).run(decisionHash, timestamp, existing.id);
    }
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

  return makeContextOutput(
    "decision-extractor",
    `<vault-decisions>Extracted ${decisionCount} decision(s) from session (observer: ${observedDecisions.length > 0}).</vault-decisions>`
  );
}

// =============================================================================
// Extraction
// =============================================================================

type Decision = {
  text: string;
  context: string;
};

function extractDecisions(messages: { role: string; content: string }[]): Decision[] {
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
