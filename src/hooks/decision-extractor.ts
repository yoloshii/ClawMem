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
import {
  resolveCausalWriterMode,
  resolveStopBudgetMs,
  runCausalStep,
  pruneCausalRuns,
  PERSIST_RESERVE_MS,
  CAUSAL_MIN_BUDGET_MS,
} from "../causal-writer.ts";
import {
  resolveJudge,
  buildContradictionPrompt,
  extractJudgeJson,
  JUDGE_VERDICT_SCHEMA,
  JUDGE_PROMPT_VERSION,
} from "../judge.ts";
import {
  insertJudgeRun,
  insertJudgeEvent,
  insertJudgeRunBestEffort,
  pruneJudgeRuns,
  type JudgeEventInput,
  type JudgeLane,
  type JudgeReasonCode,
} from "../judge-audit.ts";
import { DEFAULT_EMBED_MODEL, warnOnceOnVectorModelMismatch, extractSnippet, parseVirtualPath, type SearchResult } from "../store.ts";
import { ensureEntityCanonical, resolveEntityTypeExact } from "../entity.ts";
import { isSchemaPlaceholder, CONTRADICTION_RESIDUE } from "../schema-placeholder.ts";
import { stopPipelineReady } from "../stop-schema.ts";
import { replayDueRetries, runDecisionExtraction } from "../stop-extract.ts";
import { drainCausalMarkers } from "../stop-causal.ts";
import { monoNow, deadlineAfter, deadlineBefore, remainingForTimeout, shorterThan, duration, isExpired, signalAfter, evidenceMs, type MonoDeadline, toDate, epochNow, epochMs } from "../clock.ts";

// Observation types that are allowed to contribute SPO triples. Widened from the
// original {decision, preference, milestone, problem} gate, which rejected 77% of
// real observations in production vaults (the majority type is 'discovery').
// See BACKLOG.md §1.6 for the full diagnosis.
const SPO_ELIGIBLE_OBSERVATION_TYPES = new Set<Observation["type"]>([
  "decision", "preference", "milestone", "problem",
  "discovery", "feature",
]);

// 62.1 D4: the merge policies (dedup_check, merge_recent, update_existing) for session documents are gone — a
// session document is a render of its own items (stop-session-docs.ts); cross-session dedup was the CM-07 defect.

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

export type ContradictionEntryVerdict =
  | "ok"
  | "invalid-relation"
  | "invalid-reasoning"
  | "placeholder-reasoning"
  | "invalid-confidence"
  | "index-out-of-range";

/**
 * Runtime semantic validation for ONE classifier entry, ahead of any mutation.
 *
 * Extracted as a pure function so it is testable without an LLM: the hook resolves its own
 * model internally, so an end-to-end test would assert whatever the deployed model happens
 * to return that day. It is also why the `reasoning: "..."` bypass stayed invisible — the
 * only tests exercised `isSchemaPlaceholder` directly, never the real decision boundary.
 *
 * The parse gate upstream only proves the ROOT of the response is an array. Entries were
 * never checked at all, so the deployed model's echoed skeleton reached the mutation path.
 */
export function validateContradictionEntry(
  entry: unknown,
  candidateCount: number,
  newFactCount: number,
): ContradictionEntryVerdict {
  const rel = (entry ?? {}) as Record<string, unknown>;
  // Relation must be an exact enum member. The prompt's `"update|contradiction|same"`
  // skeleton is echoed as this VALUE by the deployed model and is rejected here.
  if (typeof rel.relation !== "string" || !VALID_RELATIONS.has(rel.relation)) {
    return "invalid-relation";
  }

  // Strict typing, NOT coercion. `String(rel.reasoning ?? "")` turned 123, {}, true and
  // ["real"] into plausible strings that cleared the residue check and proceeded toward
  // mutation — a fail-open on every JSON-valid non-string value.
  if (typeof rel.reasoning !== "string") return "invalid-reasoning";

  // Reasoning must not be the prompt's own `"..."` skeleton, nor quote/punctuation residue.
  if (isSchemaPlaceholder(rel.reasoning, CONTRADICTION_RESIDUE)) {
    return "placeholder-reasoning";
  }

  if (
    typeof rel.confidence !== "number" ||
    !Number.isFinite(rel.confidence) ||
    rel.confidence < 0 ||
    rel.confidence > 1
  ) {
    return "invalid-confidence";
  }

  // Both indices must address real entries. `old_idx` is incidentally bounded by the
  // candidate lookup, but `new_idx` feeds only a log line today — and once the filepath
  // contract is repaired an out-of-range `new_idx` would mutate the old document while
  // reporting `undefined`. Bound both before any mutation can occur.
  const inRange = (value: unknown, bound: number): boolean =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value < bound;

  if (!inRange(rel.old_idx, candidateCount) || !inRange(rel.new_idx, newFactCount)) {
    return "index-out-of-range";
  }

  return "ok";
}

const VALID_RELATIONS = new Set(["same", "update", "contradiction"]);

export type ContradictionBatch = {
  /** Entries cleared for mutation, at most one per (old, new) pair, in first-seen order. */
  accepted: any[];
  /** Entries that failed per-entry validation. */
  rejected: number;
  /** Repeats identical across mutation-relevant fields, collapsed. */
  duplicates: number;
  /** Pairs dropped whole because the classifier gave more than one answer for them. */
  inconsistent: number;
  /**
   * v0.29.0: the rejected entries WITH their verdicts, observationally — admission
   * semantics are unchanged (`rejected === rejectedEntries.length`). Feeds the
   * durable audit's per-reject events; without it a reject was a bare count.
   */
  rejectedEntries: { entry: unknown; reason: Exclude<ContradictionEntryVerdict, "ok"> }[];
  /** One sample entry per collapsed-duplicate pair, with the repeat count (observational). */
  duplicateEntries: { entry: unknown; repeats: number }[];
  /** One sample entry per inconsistently-answered pair, with the distinct-answer count (observational). */
  inconsistentEntries: { entry: unknown; answers: number }[];
};

/**
 * Array-level admission for one classifier response, ahead of ANY mutation.
 *
 * `validateContradictionEntry` proves each object is well-formed and says nothing about the
 * SET. Two entries for the same (old, new) pair each decrement that document's confidence, so
 * a repeat compounds the penalty and can cross the invalidation floor a single classification
 * never reaches — and a model that echoes its prompt, which is this model's established
 * failure mode, emits repeats readily.
 *
 * A pair the classifier answered more than one way is dropped ENTIRELY rather than first-wins.
 * First-wins made the outcome depend on array order: `[0.69, 0.99]` kept the sub-threshold
 * entry and mutated nothing, while `[0.99, 0.69]` mutated — for the same classification. That
 * is also why differing confidence or reasoning counts as inconsistent, not as a duplicate:
 * only a repeat identical across the mutation-relevant fields is safely collapsible. Entries
 * differing solely in fields that cannot reach the mutation path ARE collapsed — they are the
 * same classification, so this is deliberately not object identity.
 *
 * Exported and pure so the batch contract is testable without an LLM — the judge's Phase B (`stop-judge.ts`)
 * resolves its own model, so an end-to-end test would assert whatever the deployed model
 * returned that day.
 *
 * NOT decided here: whether several DISTINCT new facts may penalize one old document
 * repeatedly. That is the unresolved document-identity question.
 */
export function admitContradictionEntries(
  parsed: any[],
  candidateCount: number,
  newFactCount: number,
): ContradictionBatch {
  // Group EVERY signature per pair before deriving any count. Comparing each later entry
  // against only the first made the telemetry depend on array order — `[0.9, 0.9, 0.8]`
  // reported one duplicate while `[0.8, 0.9, 0.9]` reported none, for the same multiset.
  const groups = new Map<string, { first: any; signatures: string[] }>();
  let rejected = 0;
  const rejectedEntries: { entry: unknown; reason: Exclude<ContradictionEntryVerdict, "ok"> }[] = [];

  for (const rel of parsed) {
    const verdict = validateContradictionEntry(rel, candidateCount, newFactCount);
    if (verdict !== "ok") {
      rejected++;
      rejectedEntries.push({ entry: rel, reason: verdict });
      continue;
    }

    const pairKey = `${rel.old_idx}:${rel.new_idx}`;
    // Every field that drives a mutation participates in identity — relation selects the
    // branch, confidence gates it, reasoning is the evidence. Fields outside this set cannot
    // reach the mutation path, so entries differing only in those are genuinely the same
    // classification.
    const signature = JSON.stringify([rel.relation, rel.confidence, rel.reasoning]);

    const group = groups.get(pairKey);
    if (group) group.signatures.push(signature);
    else groups.set(pairKey, { first: rel, signatures: [signature] });
  }

  const accepted: any[] = [];
  let duplicates = 0;
  let inconsistent = 0;
  const duplicateEntries: { entry: unknown; repeats: number }[] = [];
  const inconsistentEntries: { entry: unknown; answers: number }[] = [];

  for (const { first, signatures } of groups.values()) {
    const distinct = new Set(signatures);
    if (distinct.size > 1) {
      inconsistent++;               // the classifier answered this pair more than one way
      inconsistentEntries.push({ entry: first, answers: distinct.size });
    } else {
      accepted.push(first);         // insertion order — deterministic for a given input
      duplicates += signatures.length - 1;
      if (signatures.length > 1) duplicateEntries.push({ entry: first, repeats: signatures.length });
    }
  }

  return { accepted, rejected, duplicates, inconsistent, rejectedEntries, duplicateEntries, inconsistentEntries };
}

/**
 * The deployed model wraps its array in an object (`{"result": [...]}`) rather than returning a
 * bare array. `parseLinkGenerationFromLLM` in amem.ts has unwrapped that shape since it was
 * written; this path never did, so the gate rejected structurally-valid responses as unparseable.
 *
 * Anything that is neither shape is returned UNCHANGED, so the caller's existing
 * `!Array.isArray(parsed)` reporting branch still catches genuinely malformed responses.
 */
export function unwrapContradictionArray(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const inner = (raw as { result?: unknown }).result;
    if (Array.isArray(inner)) return inner;
  }
  return raw;
}

/**
 * The only `content_type` the armed invalidation writer can touch.
 *
 * Candidate selection matches on PATHNAME (`decisions/`, `observations/`), which is a much wider
 * population than this — roughly 3x on the vault this was developed against.
 * Reporting an invalidation intent the armed writer could never honour would point shadow-mode
 * calibration at the wrong population — roughly two thirds of what it flagged would have been
 * un-invalidatable — so eligibility is asked ONCE, here, and both the shadow log and the armed
 * write are gated on the same answer.
 */
export const INVALIDATION_ELIGIBLE_CONTENT_TYPE = "observation";

export type ContradictionOutcomes = {
  contradictions: number;
  /** Virtual path failed to PARSE — a URI-contract regression. */
  unparseableTarget: number;
  /** Parsed fine, but no active row — benign (archived/deleted between search and apply). */
  missingTarget: number;
  /** Hit the confidence floor but cannot be invalidated: wrong content_type, or already invalidated. */
  floorIneligible: number;
  /** Eligible and at floor, but the writer is unarmed. */
  shadowInvalidations: number;
  invalidated: number;
  /** Armed write matched zero rows — lost a race after the eligibility check. */
  invalidationNoOp: number;
  invalidationErrors: number;
};

/**
 * v0.29.0: the eligibility answer split into its real causes — the boolean form
 * conflated wrong-content-type with already-invalidated (`invalidated_at IS NULL`
 * in the predicate), which made the audit unable to say WHICH kind of ineligible
 * a floor-reaching document was. `floorIneligible` still counts all of them;
 * only the audit event distinguishes.
 */
type InvalidationEligibility = "eligible" | "ineligible-type" | "already-invalidated" | "row-missing";

function invalidationEligibility(store: Store, docId: number): InvalidationEligibility {
  const row = store.db
    .prepare(`SELECT content_type, invalidated_at FROM documents WHERE id = ?`)
    .get(docId) as { content_type: string | null; invalidated_at: string | null } | undefined;
  if (!row) return "row-missing";
  if (row.invalidated_at != null) return "already-invalidated";
  return row.content_type === INVALIDATION_ELIGIBLE_CONTENT_TYPE ? "eligible" : "ineligible-type";
}

/**
 * Applies validated classifier verdicts to the vault. Split out of the old whole-window judge as the
 * mutation boundary: everything above it is inference and validation, everything here is a write.
 * Exported so the write path can be driven directly by tests without an LLM — the branches below
 * had no coverage precisely because they were only reachable through a live model call.
 */
export function applyContradictionOutcomes(
  store: Store,
  accepted: any[],
  candidates: SearchResult[],
  newFacts: string[],
  /** Source document of each entry in `newFacts`, positionally aligned. Null = unattributable. */
  newFactDocIds: ReadonlyArray<number | null>,
  /**
   * v0.29.0 audit sink. When present (production: inside the run's transaction),
   * every applied/blocked/errored outcome emits a durable event. Absent in
   * seam-level tests that assert mutation behavior only.
   */
  emit?: (ev: Omit<JudgeEventInput, "runId">) => void,
): ContradictionOutcomes {
  const out: ContradictionOutcomes = {
    contradictions: 0,
    unparseableTarget: 0,
    missingTarget: 0,
    floorIneligible: 0,
    shadowInvalidations: 0,
    invalidated: 0,
    invalidationNoOp: 0,
    invalidationErrors: 0,
  };

  for (const rel of accepted) {
    if (rel.confidence < 0.7) {
      // Below the mutation threshold: the verdict is recorded (calibration wants to
      // see near-misses) but nothing is written.
      emit?.({
        eventType: "verdict",
        newIdx: rel.new_idx,
        oldIdx: rel.old_idx,
        relation: rel.relation,
        confidence: rel.confidence,
        reasoningHead: rel.reasoning,
        action: "classified_only",
      });
      continue;
    }
    const oldDoc = candidates[rel.old_idx];
    if (!oldDoc) continue;

    // `SearchResult.filepath` is a VIRTUAL path — `clawmem://<collection>/<path>`, built in
    // store.ts by `'clawmem://' || d.collection || '/' || d.path`. `findActiveDocument` matches
    // the bare `documents.path` column. Passing the URI straight through could never match any
    // row, so every contradiction that survived the parse gate and validation died here,
    // silently. Parse it back to the bare path first — and keep the two failure modes apart:
    // a parse failure means the URI contract itself broke, a missing row is an ordinary race.
    const virtual = parseVirtualPath(oldDoc.filepath);
    if (!virtual) {
      out.unparseableTarget++;
      emit?.({
        eventType: "reject",
        newIdx: rel.new_idx,
        oldIdx: rel.old_idx,
        relation: rel.relation,
        confidence: rel.confidence,
        reasonCode: "target_unparseable",
        evidenceHead: oldDoc.filepath,
      });
      continue;
    }
    const existingDoc = store.findActiveDocument(virtual.collectionName, virtual.path);
    if (!existingDoc) {
      out.missingTarget++;
      emit?.({
        eventType: "reject",
        newIdx: rel.new_idx,
        oldIdx: rel.old_idx,
        relation: rel.relation,
        confidence: rel.confidence,
        reasonCode: "target_missing",
        evidenceHead: oldDoc.filepath,
      });
      continue;
    }

    if (rel.relation === "contradiction") {
      // Lower old doc confidence by 0.25 (floor 0.2)
      const currentConfidence = existingDoc.confidence ?? 0.5;
      const newConfidence = Math.max(0.2, currentConfidence - 0.25);
      store.updateDocumentMeta(existingDoc.id, {
        confidence: newConfidence,
      });
      out.contradictions++;
      emit?.({
        eventType: "verdict",
        newIdx: rel.new_idx,
        oldIdx: rel.old_idx,
        newRef: newFactDocIds[rel.new_idx] != null ? `doc:${newFactDocIds[rel.new_idx]}` : null,
        oldRef: `doc:${existingDoc.id}`,
        relation: rel.relation,
        confidence: rel.confidence,
        reasoningHead: rel.reasoning,
        action: "eroded",
        scoreBefore: currentConfidence,
        scoreAfter: newConfidence,
      });
      console.error(
        `[decision-extractor] CONTRADICTION: "${newFacts[rel.new_idx]}" vs "${oldDoc.displayPath}" (conf: ${rel.confidence})`
      );

      // Soft invalidation: if confidence drops to floor AND the row is invalidation-eligible,
      // mark as invalidated (Pattern I — prevents stale contradicted knowledge from surfacing)
      //
      // SHADOWED BY DEFAULT. Repairing the virtual-path contract above made this reachable for
      // the first time; no shipped version could apply a classification here. Unlike the
      // confidence adjustment — bounded, floored, reversible — invalidation hard-gates FTS *and*
      // vector retrieval, so a false positive makes a real document invisible with no signal.
      // The classifier feeding it is a model with a demonstrated habit of echoing its prompt,
      // and hits-to-floor depends entirely on where the document's confidence started.
      //
      // Shadow mode logs exactly what the armed writer would remove — no more and no less — so
      // precision can be adjudicated against real traffic first. Set
      // CLAWMEM_CONTRADICTION_INVALIDATE=true to arm it.
      if (newConfidence <= 0.2) {
        const eligibility = invalidationEligibility(store, existingDoc.id);
        if (eligibility !== "eligible") {
          out.floorIneligible++;
          emit?.({
            eventType: "verdict",
            newIdx: rel.new_idx,
            oldIdx: rel.old_idx,
            oldRef: `doc:${existingDoc.id}`,
            relation: rel.relation,
            confidence: rel.confidence,
            action: "floor_reached",
            reasonCode:
              eligibility === "already-invalidated" ? "already_invalidated"
              : eligibility === "row-missing" ? "target_missing"
              : "ineligible_type",
            scoreBefore: currentConfidence,
            scoreAfter: newConfidence,
          });
          continue;
        }
        if (process.env.CLAWMEM_CONTRADICTION_INVALIDATE !== "true") {
          out.shadowInvalidations++;
          emit?.({
            eventType: "verdict",
            newIdx: rel.new_idx,
            oldIdx: rel.old_idx,
            oldRef: `doc:${existingDoc.id}`,
            relation: rel.relation,
            confidence: rel.confidence,
            action: "would_invalidate",
            scoreBefore: currentConfidence,
            scoreAfter: newConfidence,
          });
          console.warn(
            `[decision-extractor] contradiction: WOULD invalidate "${oldDoc.displayPath}" ` +
            `(confidence ${currentConfidence} -> ${newConfidence}) — shadow mode, nothing ` +
            `written. Set CLAWMEM_CONTRADICTION_INVALIDATE=true to arm.`,
          );
          continue;
        }
        try {
          // The content_type predicate is redundant against invalidationEligibility above and
          // kept deliberately: it makes a lost race a zero-row no-op rather than a wrong write.
          const res = store.db.prepare(`
            UPDATE documents
            SET invalidated_at = datetime('now'),
                invalidated_by = ?
            WHERE id = ? AND invalidated_at IS NULL AND content_type = ?
          `).run(newFactDocIds[rel.new_idx] ?? null, existingDoc.id, INVALIDATION_ELIGIBLE_CONTENT_TYPE);

          // A swallowed result is how the original defect stayed invisible for four months.
          if (res.changes === 0) out.invalidationNoOp++;
          else out.invalidated++;
          emit?.({
            eventType: "verdict",
            newIdx: rel.new_idx,
            oldIdx: rel.old_idx,
            oldRef: `doc:${existingDoc.id}`,
            relation: rel.relation,
            confidence: rel.confidence,
            action: res.changes === 0 ? "write_noop" : "invalidated",
            scoreBefore: currentConfidence,
            scoreAfter: newConfidence,
          });
        } catch (e) {
          out.invalidationErrors++;
          emit?.({
            eventType: "error",
            newIdx: rel.new_idx,
            oldIdx: rel.old_idx,
            oldRef: `doc:${existingDoc.id}`,
            relation: rel.relation,
            confidence: rel.confidence,
            reasonCode: "write_error",
            evidenceHead: e instanceof Error ? e.message : String(e),
          });
          console.warn(
            `[decision-extractor] contradiction: invalidation FAILED for ` +
            `"${oldDoc.displayPath}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

    } else if (rel.relation === "update") {
      // Lower old doc confidence by 0.15 (floor 0.3)
      const currentConfidence = existingDoc.confidence ?? 0.5;
      const newConfidence = Math.max(0.3, currentConfidence - 0.15);
      store.updateDocumentMeta(existingDoc.id, {
        confidence: newConfidence,
      });
      emit?.({
        eventType: "verdict",
        newIdx: rel.new_idx,
        oldIdx: rel.old_idx,
        newRef: newFactDocIds[rel.new_idx] != null ? `doc:${newFactDocIds[rel.new_idx]}` : null,
        oldRef: `doc:${existingDoc.id}`,
        relation: rel.relation,
        confidence: rel.confidence,
        reasoningHead: rel.reasoning,
        action: "eroded",
        scoreBefore: currentConfidence,
        scoreAfter: newConfidence,
      });
    } else if (rel.relation === "same") {
      // No mutation for `same` — but the classification is still a calibration fact.
      emit?.({
        eventType: "verdict",
        newIdx: rel.new_idx,
        oldIdx: rel.old_idx,
        oldRef: `doc:${existingDoc.id}`,
        relation: rel.relation,
        confidence: rel.confidence,
        reasoningHead: rel.reasoning,
        action: "classified_only",
      });
    }
  }

  return out;
}

export type ContradictionResponseResult = {
  /** Root was neither a bare array nor `{result: [...]}` — nothing was applied. */
  parseFailed: boolean;
  /** Shape of the post-unwrap value, for the operator-facing rejection diagnostic. */
  parsedCategory: string;
  outcomes: ContradictionOutcomes;
  rejected: number;
  duplicates: number;
  inconsistent: number;
};

const EMPTY_OUTCOMES = (): ContradictionOutcomes => ({
  contradictions: 0, unparseableTarget: 0, missingTarget: 0, floorIneligible: 0,
  shadowInvalidations: 0, invalidated: 0, invalidationNoOp: 0, invalidationErrors: 0,
});

/**
 * unwrap -> admit -> apply, as one unit, called by production.
 *
 * The three steps were previously wired together only inside the old whole-window judge, which meant
 * the envelope repair could be unwired at the call site without a single test noticing. This is
 * the seam a regression test drives; `stop-judge.ts` adds only the LLM call (Phase A) and the
 * operator-facing reporting around it.
 */
/** Judge identity + response identity for the durable audit (§J7). */
export type ContradictionAuditContext = {
  sessionId: string | null;
  lane: JudgeLane;
  model: string | null;
  endpoint: string | null;
  promptVersion: string;
  responseSha256: string;
};

/** Admission verdicts → audit reason codes — mirrors, never invents (§J7). */
const REJECT_REASON_CODE: Record<Exclude<ContradictionEntryVerdict, "ok">, JudgeReasonCode> = {
  "invalid-relation": "invalid_relation",
  "invalid-reasoning": "invalid_reasoning",
  "placeholder-reasoning": "placeholder_reasoning",
  "invalid-confidence": "invalid_confidence",
  "index-out-of-range": "index_oob",
};

export function applyContradictionResponse(
  store: Store,
  rawJson: unknown,
  candidates: SearchResult[],
  newFacts: string[],
  newFactDocIds: ReadonlyArray<number | null>,
  /**
   * v0.29.0: when present (production), the run row, per-verdict/per-reject events,
   * and every mutation commit in ONE transaction — an audit-insert failure rolls the
   * mutations back (fail-closed: an unauditable erosion is this feature's original
   * defect). A thrown transaction propagates to the caller, which records the
   * post-rollback `write_error` run. Seam-level tests may omit it.
   */
  audit?: ContradictionAuditContext,
): ContradictionResponseResult {
  const parsed = unwrapContradictionArray(rawJson);
  const parsedCategory = parsed === null ? "unparseable" : Array.isArray(parsed) ? "array" : typeof parsed;
  if (!Array.isArray(parsed)) {
    return {
      parseFailed: true, parsedCategory,
      outcomes: EMPTY_OUTCOMES(), rejected: 0, duplicates: 0, inconsistent: 0,
    };
  }
  const { accepted, rejected, duplicates, inconsistent, rejectedEntries, duplicateEntries, inconsistentEntries } =
    admitContradictionEntries(parsed, candidates.length, newFacts.length);

  const applyAll = (): ContradictionOutcomes => {
    let emit: ((ev: Omit<JudgeEventInput, "runId">) => void) | undefined;
    if (audit) {
      const runId = insertJudgeRun(store.db, {
        sessionId: audit.sessionId,
        consumer: "decision-extractor",
        lane: audit.lane,
        model: audit.model,
        endpoint: audit.endpoint,
        promptVersion: audit.promptVersion,
        responseSha256: audit.responseSha256,
        newFactCount: newFacts.length,
        candidateCount: candidates.length,
        outcome: "ok",
        entriesAdmitted: accepted.length,
        entriesRejected: rejected,
        entriesDuplicate: duplicates,
        entriesInconsistent: inconsistent,
      });
      emit = ev => { insertJudgeEvent(store.db, { runId, ...ev }); };
      for (const { entry, reason } of rejectedEntries) {
        emit({
          eventType: "reject",
          reasonCode: REJECT_REASON_CODE[reason],
          evidenceHead: JSON.stringify(entry),
        });
      }
      // Collapsed duplicates and inconsistently-answered pairs are audit facts too —
      // counts alone could not say WHICH pair was collapsed or dropped (t1 finding 7).
      for (const { entry, repeats } of duplicateEntries) {
        emit({ eventType: "reject", reasonCode: "duplicate", evidenceHead: JSON.stringify({ repeats, entry }) });
      }
      for (const { entry, answers } of inconsistentEntries) {
        emit({ eventType: "reject", reasonCode: "inconsistent", evidenceHead: JSON.stringify({ answers, entry }) });
      }
    }
    return applyContradictionOutcomes(store, accepted, candidates, newFacts, newFactDocIds, emit);
  };

  const outcomes = audit ? store.db.transaction(applyAll)() : applyAll();
  return { parseFailed: false, parsedCategory, outcomes, rejected, duplicates, inconsistent };
}

// =============================================================================
// Handler
// =============================================================================

export async function decisionExtractor(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  const sessionId = input.sessionId || `session-${epochMs(epochNow())}`;

  // Judge-audit retention (§J7, code-review t3 finding 1 / t4 finding 1): prune as the
  // handler's FIRST act — before transcript validation, so literally every invocation,
  // early returns included, honors the 90-day/10k root cap. Pair-aware, best-effort,
  // never this session's rows.
  // s342 D2: the whole-handler deadline starts at handler ENTRY — captured
  // BEFORE the retention passes below, which take the same database locks as
  // everything else and must count against the budget, not precede it.
  // CLAWMEM_STOP_BUDGET_MS bounds EVERY model-bearing phase — observation
  // extraction, the contradiction judge, and the causal step — with
  // PERSIST_RESERVE_MS held back for persistence/output so the host never
  // kills mid-write. Operating requirement (docs/reference/configuration.md):
  // the installed host hook timeout must exceed this budget plus safety.
  const stopBudget = resolveStopBudgetMs();
  // O1: the whole-handler deadline is MONOTONIC — a realtime step during the
  // Stop hook can no longer extend or cut every model-bearing phase at once.
  const deadline = deadlineAfter(monoNow(), duration(stopBudget.budgetMs));
  if (stopBudget.invalid) {
    console.error(`[decision-extractor] ${stopBudget.invalid}`);
  }

  try {
    pruneJudgeRuns(store.db, { excludeSessionId: sessionId });
  } catch { /* retention is best-effort */ }
  try {
    pruneCausalRuns(store.db, { excludeSessionId: sessionId });
  } catch { /* retention is best-effort */ }

  // 62.1 D10: on a vault whose stop-pipeline migration is not verified, cursor work is skipped (fail closed).
  if (!stopPipelineReady(store.db) || !validateTranscriptPath(input.transcriptPath)) return makeEmptyOutput("decision-extractor");

  // 62.1 D2-D4: the delta since this hook's cursor, in batches, each committed once (stop-extract.ts); the judge runs
  // split around each batch's Phase B (stop-judge.ts). Phase C for a committed batch: the causal step for that range.
  const phaseSkipNotes: string[] = [];
  const run = await runDecisionExtraction(store, {
    sessionId,
    transcriptPath: input.transcriptPath!,
    host: input.host,
    sessionKey: input.sessionKey,
    deadline,
    phaseSkipNotes,
    // Phase C: the causal step owed by the range just committed (its marker, D3).
    afterCommit: async ({ range }) => {
      try {
        await drainCausalMarkers(store, getDefaultLlamaCpp(), {
          deadline, sessionId, rangeKey: range.key, limit: 1,
          invalidConfigNotes: stopBudget.invalid ? [stopBudget.invalid] : [], phaseSkipNotes,
        });
      } catch (err) {
        console.log(`[decision-extractor] Error in causal inference:`, err);
      }
    },
  });
  // D3: at most one due quarantined range of this session, inside what is left of the budget; its Phase C follows.
  try {
    const replay = await replayDueRetries(store, { deadline, sessionId, limit: 1 });
    for (const r of replay.ranges) {
      await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline, sessionId, rangeKey: r.key, limit: 1, phaseSkipNotes });
    }
  } catch (err) {
    console.error(`[decision-extractor] replay of a quarantined range failed:`, err);
  }
  // Markers this session still owes from earlier Stops (a crash between Phase B and Phase C), bounded.
  try {
    await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline, sessionId, limit: 2, phaseSkipNotes });
  } catch (err) {
    console.log(`[decision-extractor] Error in causal inference:`, err);
  }

  // Trigger directory context update if enabled and observer found files
  const config = loadConfig();
  if (config.directoryContext) {
    const allModifiedFiles = run.observations.flatMap(o => o.filesModified);
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

/** The persisted body of an observation — `persistObservationDoc` hashes it into the path (v0.41.2: exported for the window union). */
export function formatObservation(obs: Observation, dateStr: string, sessionId: string): string {
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
export function insertObservationTriples(
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
