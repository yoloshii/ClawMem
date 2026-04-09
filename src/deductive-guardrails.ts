/**
 * Anti-contamination LLM synthesis wrapper (Ext 1).
 *
 * Three guardrails around Phase 3 deductive synthesis:
 *
 *  1. **Evidence filtering** — `collectRelevantEvidence` splits each
 *     source doc's `facts` + `narrative` into sentences and keeps only
 *     those with lexical overlap against the draft conclusion/premises.
 *     The filtered evidence is fed to the validation LLM so it sees
 *     only the parts of each source that actually matter.
 *
 *  2. **Relation context injection** — `buildSourceRelationContext`
 *     queries `memory_relations` for edges AMONG the cited source docs
 *     and formats them as structural context. This lets the LLM
 *     cross-reference the graph shape alongside the raw text.
 *
 *  3. **Contamination scan** — `scanConclusionContamination` is the
 *     primary safety check. It compares entities (or lexical anchors)
 *     mentioned by the draft conclusion against the set of entities
 *     present in the cited sources. Any mention of an entity that
 *     exists in the BROADER candidate pool but NOT in the sources is
 *     flagged as contamination — the LLM imported content from a doc
 *     it wasn't supposed to reference. Entity-aware first (uses
 *     `entity_mentions`), lexical fallback when entity state is thin.
 *
 * `validateDeductiveDraft` orchestrates all three: deterministic
 * pre-checks → contamination scan → LLM validation/refinement. Never
 * throws, LLM null is a soft fall-through that still honors the
 * deterministic safety gates.
 *
 * Adapted from Thoth `dream_cycle.py:371-565` + `prompts.py:552-579`
 * (THOTH_EXTRACTION_PLAN.md Extraction 1).
 */

import type { Store } from "./store.ts";
import type { LLM } from "./llm.ts";
import { extractJsonFromLLM } from "./amem.ts";
import { extractSubjectAnchorsLexical } from "./text-similarity.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * A deductive draft as emitted by the Phase 3 draft-generation LLM
 * call. Matches the shape of `extractJsonFromLLM` output for the
 * existing draft prompt.
 */
export interface DeductiveDraft {
  conclusion: string;
  premises: string[];
  sourceIndices: number[];
}

/**
 * Minimal doc shape the guardrails need. Kept narrow so the module can
 * be tested without the full `Document` row type — any object with
 * `id`, `title`, and optionally `facts`/`narrative` satisfies it.
 */
export interface DocLike {
  id: number;
  title: string;
  facts?: string | null;
  narrative?: string | null;
}

export type ValidationRejectReason =
  | "empty"
  | "invalid_indices"
  | "contamination"
  | "unsupported"
  | "null_llm";

export interface DeductiveValidation {
  accepted: boolean;
  conclusion?: string;
  premises?: string[];
  reason?: ValidationRejectReason;
  contaminationHits?: string[];
  contaminationMethod?: "entity" | "lexical";
  /**
   * True when `accepted === true` because the LLM validation path
   * failed (null result, throw, or malformed JSON) and the deterministic
   * pre-checks were treated as sufficient. Operators should track
   * this separately from LLM-affirmed acceptances — a high
   * fallback-accept rate means the LLM path is effectively disabled
   * and deductions are only gated by the deterministic guardrails.
   */
  fallbackAccepted?: boolean;
}

// =============================================================================
// Evidence filtering
// =============================================================================

/**
 * Split each source doc's `facts` + `narrative` into sentences, keep
 * only sentences with lexical overlap against the draft conclusion or
 * any premise (minimum 2 shared >3-char tokens). Returns the
 * concatenated evidence text (for LLM context) and the raw sentence
 * list (for further downstream validation or logging).
 *
 * Keeps evidence output bounded so long source docs don't blow the
 * validation prompt budget.
 */
export function collectRelevantEvidence(
  sourceDocs: DocLike[],
  draft: DeductiveDraft
): { evidenceText: string; evidenceSentences: string[] } {
  const draftTokens = new Set<string>();
  const addTokens = (s: string) => {
    for (const tok of s.toLowerCase().split(/\s+/)) {
      if (tok.length > 3) draftTokens.add(tok);
    }
  };
  addTokens(draft.conclusion);
  for (const p of draft.premises ?? []) addTokens(p);

  const relevant: string[] = [];
  for (const doc of sourceDocs) {
    const text = `${doc.facts ?? ""}\n${doc.narrative ?? ""}`;
    const sentences = text
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      const sentenceTokens = new Set(
        sentence
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 3)
      );
      const overlap = [...sentenceTokens].filter((t) => draftTokens.has(t)).length;
      if (overlap >= 2) {
        relevant.push(`[doc#${doc.id}] ${sentence}`);
      }
    }
  }

  return {
    evidenceText: relevant.join(". "),
    evidenceSentences: relevant,
  };
}

// =============================================================================
// Source relation context
// =============================================================================

/**
 * Query `memory_relations` for edges AMONG the cited source docs and
 * format them as a human-readable context string. Sorted by weight
 * DESC, capped at `maxEdges` (default 10) to keep the prompt
 * bounded. Returns the empty string when there are no edges or the
 * query fails — callers treat that as "no structural context".
 */
export function buildSourceRelationContext(
  store: Store,
  sourceDocIds: number[],
  maxEdges: number = 10
): string {
  if (sourceDocIds.length < 2) return "";

  const placeholders = sourceDocIds.map(() => "?").join(",");
  let rows: {
    source_id: number;
    target_id: number;
    relation_type: string;
    weight: number;
  }[];
  try {
    rows = store.db
      .prepare(
        `SELECT source_id, target_id, relation_type, weight
         FROM memory_relations
         WHERE source_id IN (${placeholders})
           AND target_id IN (${placeholders})
         ORDER BY weight DESC
         LIMIT ?`
      )
      .all(...sourceDocIds, ...sourceDocIds, maxEdges) as typeof rows;
  } catch {
    return "";
  }

  if (rows.length === 0) return "";

  return rows
    .map(
      (r) =>
        `doc#${r.source_id} --[${r.relation_type} w=${r.weight.toFixed(2)}]--> doc#${r.target_id}`
    )
    .join("\n");
}

// =============================================================================
// Contamination scan
// =============================================================================

/**
 * Scan a draft conclusion for "contamination" — content that appears
 * in the broader candidate pool but NOT in the cited source docs.
 *
 * Entity-aware first: queries `entity_mentions` for both the source
 * docs and the pool. When an entity is mentioned by the pool but not
 * by the sources, look up its canonical name in `entity_nodes` and
 * search for it in the conclusion (whole-word match, case-insensitive).
 *
 * Lexical fallback: when either side has zero entity mentions, extract
 * proper-noun anchors from source text and pool text, find the set
 * exclusive to the pool, and check whether the conclusion mentions
 * any of them.
 *
 * Returns the list of contamination hits (anchor strings or entity
 * names) and which path produced them.
 */
export function scanConclusionContamination(
  store: Store,
  conclusion: string,
  sourceDocIds: number[],
  candidatePool: DocLike[]
): { hits: string[]; method: "entity" | "lexical" } {
  const candidateIds = candidatePool.map((d) => d.id);

  const sourceEntities = getEntitiesForDocs(store, sourceDocIds);
  const poolEntities = getEntitiesForDocs(store, candidateIds);

  if (sourceEntities !== null && poolEntities !== null) {
    const sourceSet = new Set(sourceEntities);
    const outsideEntities = poolEntities.filter((e) => !sourceSet.has(e));
    if (outsideEntities.length === 0) {
      return { hits: [], method: "entity" };
    }

    let names: { entity_id: string; name: string }[];
    try {
      const placeholders = outsideEntities.map(() => "?").join(",");
      names = store.db
        .prepare(
          `SELECT entity_id, name FROM entity_nodes WHERE entity_id IN (${placeholders})`
        )
        .all(...outsideEntities) as typeof names;
    } catch {
      return scanLexicalContamination(conclusion, sourceDocIds, candidatePool);
    }

    const lowerConclusion = conclusion.toLowerCase();
    const hitSet = new Set<string>();
    for (const n of names) {
      const nameLC = n.name.toLowerCase();
      // Use a custom non-alnum boundary instead of `\b` because `\b` fails
      // for names that BEGIN or END with punctuation (`auth-service`,
      // `OAuth2.0`, `C++`, `.NET`). `\b` requires one side to be a word
      // character, so a trailing `+` in `c++` followed by whitespace
      // produces no match (both sides non-word).
      //
      // Lookbehind/lookahead on `[^a-z0-9]` (plus start/end anchors)
      // correctly matches the name when surrounded by anything that
      // isn't alphanumeric — including punctuation, whitespace, and
      // string boundaries.
      const regex = new RegExp(
        `(?<=^|[^a-z0-9])${escapeRegex(nameLC)}(?=$|[^a-z0-9])`
      );
      if (regex.test(lowerConclusion)) {
        hitSet.add(n.name);
      }
    }
    return { hits: [...hitSet], method: "entity" };
  }

  return scanLexicalContamination(conclusion, sourceDocIds, candidatePool);
}

/**
 * Get the canonical entity IDs mentioned by a set of docs. Returns
 * null when the docs have no entity_mentions at all — caller should
 * fall back to lexical scan (apples-to-apples comparison).
 */
function getEntitiesForDocs(store: Store, docIds: number[]): string[] | null {
  if (docIds.length === 0) return [];
  const placeholders = docIds.map(() => "?").join(",");
  let rows: { entity_id: string }[];
  try {
    rows = store.db
      .prepare(
        `SELECT DISTINCT entity_id FROM entity_mentions WHERE doc_id IN (${placeholders})`
      )
      .all(...docIds) as typeof rows;
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  return rows.map((r) => r.entity_id);
}

function scanLexicalContamination(
  conclusion: string,
  sourceDocIds: number[],
  candidatePool: DocLike[]
): { hits: string[]; method: "lexical" } {
  const sourceSet = new Set(sourceDocIds);
  const sourceDocs = candidatePool.filter((d) => sourceSet.has(d.id));
  const outsideDocs = candidatePool.filter((d) => !sourceSet.has(d.id));

  const sourceText = sourceDocs
    .map((d) => `${d.title}\n${d.facts ?? ""}\n${d.narrative ?? ""}`)
    .join("\n");
  const outsideText = outsideDocs
    .map((d) => `${d.title}\n${d.facts ?? ""}\n${d.narrative ?? ""}`)
    .join("\n");

  const sourceAnchors = new Set(extractSubjectAnchorsLexical(sourceText));
  const outsideAnchors = extractSubjectAnchorsLexical(outsideText);

  const exclusiveOutside = outsideAnchors.filter((a) => !sourceAnchors.has(a));
  if (exclusiveOutside.length === 0) {
    return { hits: [], method: "lexical" };
  }

  const conclusionAnchors = new Set(extractSubjectAnchorsLexical(conclusion));
  const hits = [...new Set(exclusiveOutside.filter((a) => conclusionAnchors.has(a)))];
  return { hits, method: "lexical" };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Validation orchestrator
// =============================================================================

const VALIDATION_PROMPT_TEMPLATE = `You are a logic validator. Check whether a proposed deductive conclusion is fully supported by the provided source evidence — and nothing beyond it.

Source evidence (only these observations are allowed):
{EVIDENCE}
{RELATIONS}
Proposed deduction:
  Conclusion: {CONCLUSION}
  Premises: {PREMISES}

Rules:
1. If the evidence does not fully support the conclusion, reject.
2. If the conclusion references anything NOT present in the source evidence, reject.
3. If the conclusion is supported but could be phrased more precisely, return a revised conclusion.

Respond with ONLY a JSON object:
{"accepted": true|false, "conclusion": "revised or original", "premises": ["revised or original"], "reason": "brief"}

Do not include any other text. /no_think`;

/**
 * Validate a deductive draft against its source docs.
 *
 * Pipeline:
 *  1. Deterministic pre-checks:
 *     - conclusion must be non-trivial (>= 10 chars after trim)
 *     - source docs must resolve to >= 2 unique ids
 *  2. Contamination scan — reject immediately on any hit.
 *  3. LLM validation/refinement. On null/malformed JSON, fall back to
 *     deterministic accept (the pre-checks already passed, so the
 *     draft is structurally valid).
 *
 * Never throws. Returns `accepted: false` with a `reason` on any
 * rejection so the caller can track per-reason counters in stats.
 */
export async function validateDeductiveDraft(
  store: Store,
  llm: LLM,
  draft: DeductiveDraft,
  sourceDocs: DocLike[],
  candidatePool: DocLike[]
): Promise<DeductiveValidation> {
  // Pre-check 1: non-trivial conclusion
  if (!draft.conclusion?.trim() || draft.conclusion.trim().length < 10) {
    return { accepted: false, reason: "empty" };
  }

  // Pre-check 2: at least 2 unique source docs
  const uniqueSourceIds = [...new Set(sourceDocs.map((d) => d.id))];
  if (uniqueSourceIds.length < 2) {
    return { accepted: false, reason: "invalid_indices" };
  }

  // Contamination scan
  const contamination = scanConclusionContamination(
    store,
    draft.conclusion,
    uniqueSourceIds,
    candidatePool
  );
  if (contamination.hits.length > 0) {
    return {
      accepted: false,
      reason: "contamination",
      contaminationHits: contamination.hits,
      contaminationMethod: contamination.method,
    };
  }

  // LLM validation / refinement
  const evidence = collectRelevantEvidence(sourceDocs, draft);
  const relationContext = buildSourceRelationContext(store, uniqueSourceIds);

  const evidenceBlock =
    evidence.evidenceText ||
    sourceDocs
      .map(
        (d) =>
          `[doc#${d.id}] ${d.title}: ${(d.facts ?? "").slice(0, 200)} ${(d.narrative ?? "").slice(0, 200)}`
      )
      .join("\n");

  const prompt = VALIDATION_PROMPT_TEMPLATE.replace("{EVIDENCE}", evidenceBlock)
    .replace("{RELATIONS}", relationContext ? `\nRelations among sources:\n${relationContext}\n` : "")
    .replace("{CONCLUSION}", draft.conclusion)
    .replace("{PREMISES}", (draft.premises ?? []).join("; "));

  let result;
  try {
    result = await llm.generate(prompt, { temperature: 0.2, maxTokens: 400 });
  } catch {
    // LLM call threw → deterministic accept (pre-checks already passed)
    return {
      accepted: true,
      conclusion: draft.conclusion,
      premises: draft.premises,
      fallbackAccepted: true,
    };
  }

  if (!result?.text) {
    // LLM returned null (cooldown / remote down) → deterministic accept
    return {
      accepted: true,
      conclusion: draft.conclusion,
      premises: draft.premises,
      fallbackAccepted: true,
    };
  }

  const parsed = extractJsonFromLLM(result.text) as {
    accepted?: unknown;
    conclusion?: unknown;
    premises?: unknown;
    reason?: unknown;
  } | null;

  if (!parsed || typeof parsed.accepted !== "boolean") {
    // Malformed → deterministic accept
    return {
      accepted: true,
      conclusion: draft.conclusion,
      premises: draft.premises,
      fallbackAccepted: true,
    };
  }

  if (!parsed.accepted) {
    return {
      accepted: false,
      reason: "unsupported",
      conclusion:
        typeof parsed.conclusion === "string" ? parsed.conclusion : draft.conclusion,
    };
  }

  // Accepted, possibly with LLM refinement
  return {
    accepted: true,
    conclusion:
      typeof parsed.conclusion === "string" && parsed.conclusion.trim()
        ? parsed.conclusion
        : draft.conclusion,
    premises:
      Array.isArray(parsed.premises) &&
      parsed.premises.every((p) => typeof p === "string")
        ? (parsed.premises as string[])
        : draft.premises,
  };
}
