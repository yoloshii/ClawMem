/**
 * ClawMem Consolidation Worker
 *
 * Three-phase background worker:
 * 1. A-MEM backfill: enriches documents missing memory notes
 * 2. 3-tier consolidation: synthesizes clusters of related observations
 *    into higher-order consolidated observations with proof counts and trends
 * 3. Deductive synthesis: combines related recent observations into
 *    first-class deductive documents with source provenance
 *
 * Pattern H from ENHANCEMENT-PLAN.md (source: Hindsight consolidator.py)
 * Deductive synthesis inspired by Honcho's Dreamer deduction specialist.
 */

import type { Store } from "./store.ts";
import type { LlamaCpp } from "./llm.ts";
import { extractJsonFromLLM } from "./amem.ts";
import { hashContent } from "./indexer.ts";
import { passesMergeSafety } from "./text-similarity.ts";
import {
  checkContradiction,
  isActionableContradiction,
  resolveContradictionPolicy,
  type ContradictionResult,
} from "./merge-guards.ts";
import {
  validateDeductiveDraft,
  type DeductiveDraft,
  type DocLike,
} from "./deductive-guardrails.ts";

// =============================================================================
// Types
// =============================================================================

interface DocumentToEnrich {
  id: number;
  hash: string;
  title: string;
}

export type TrendEnum = 'NEW' | 'STABLE' | 'STRENGTHENING' | 'WEAKENING' | 'STALE';

/**
 * Phase 3 deductive synthesis stats. Each counter is incremented at a
 * specific decision point in `generateDeductiveObservations`, giving
 * operators per-rejection-reason visibility into why drafts didn't land.
 */
export interface DeductiveSynthesisStats {
  /** Final number of deductive documents written to disk + indexed */
  created: number;
  /** Recent observations passed to the draft-generation LLM */
  considered: number;
  /** Drafts returned by the draft-generation LLM (before validation) */
  drafted: number;
  /** Drafts accepted by validation (pre-dedupe count) */
  accepted: number;
  /** Drafts rejected by validation (sum of all reject reasons) */
  rejected: number;
  /** LLM `generate()` returned null (cooldown / remote down) — draft-gen + validation */
  nullCalls: number;
  /** Drafts rejected because the conclusion mentioned a non-source entity */
  contaminationRejects: number;
  /** Drafts rejected because sourceIndices didn't resolve to ≥2 unique source docs */
  invalidIndexRejects: number;
  /** Drafts rejected because the LLM validator said `accepted: false` */
  unsupportedRejects: number;
  /** Drafts rejected because the conclusion was empty/trivial */
  emptyRejects: number;
  /** Accepted drafts that were then skipped as deductive dedupe duplicates */
  dedupSkipped: number;
  /**
   * Accepted drafts that went through the validator fail-open path
   * (LLM null/throw/malformed JSON). These passed the deterministic
   * pre-checks but were NOT affirmed by the LLM validator. A high
   * ratio of this counter to `accepted` means the LLM path is
   * effectively offline and deductions are only gated by the
   * deterministic guardrails (empty, invalid_indices, contamination).
   */
  validatorFallbackAccepts: number;
}

function emptyDeductiveStats(considered: number = 0): DeductiveSynthesisStats {
  return {
    created: 0,
    considered,
    drafted: 0,
    accepted: 0,
    rejected: 0,
    nullCalls: 0,
    contaminationRejects: 0,
    invalidIndexRejects: 0,
    unsupportedRejects: 0,
    emptyRejects: 0,
    dedupSkipped: 0,
    validatorFallbackAccepts: 0,
  };
}

export interface ConsolidatedObservation {
  id: number;
  observation: string;
  proof_count: number;
  source_doc_ids: number[];
  trend: TrendEnum;
  status: string;
  created_at: string;
  updated_at: string;
  collection: string | null;
}

interface ObservationCluster {
  docs: { id: number; title: string; facts: string; context: string; modified_at: string }[];
  collection: string;
}

/**
 * Phase 2 consolidation option bag (v0.8.0 Ext 5). All fields optional;
 * omitting the bag reproduces pre-Ext-5 behavior exactly.
 *
 *  - `maxDocs`       override for the observation batch size (default 50)
 *  - `guarded`       when true, force merge-safety enforcement regardless of
 *                    the `CLAWMEM_MERGE_GUARD_DRY_RUN` env var. Heavy-lane
 *                    callers pass this so experimenting operators cannot
 *                    weaken the heavy-lane gate by toggling an env flag.
 *  - `staleOnly`     when true, order observations by
 *                    `recall_stats.last_recalled_at ASC` (with
 *                    `documents.last_accessed_at` fallback) so least-recalled
 *                    documents are processed first instead of most-recent.
 *  - `candidateIds`  when non-empty, restricts the Phase 2 candidate set to
 *                    exactly these document ids. Heavy lane uses this to
 *                    plumb surprisal-selector output into consolidation so
 *                    `useSurprisalSelector: true` actually feeds anomaly-first
 *                    candidates instead of just relabeling the default batch.
 */
export interface ConsolidateOptions {
  maxDocs?: number;
  guarded?: boolean;
  staleOnly?: boolean;
  candidateIds?: number[];
}

/**
 * Phase 3 deductive synthesis option bag (v0.8.0 Ext 5). All fields optional;
 * omitting the bag reproduces pre-Ext-5 behavior exactly.
 *
 *  - `maxRecent`  override for the recent-observation window size (default 20)
 *  - `guarded`    forward-compat marker; currently a no-op because the Phase 3
 *                 deductive guardrails always enforce their deterministic
 *                 pre-checks + LLM validator regardless of this flag
 *  - `staleOnly`  when true, order candidate observations by
 *                 `recall_stats.last_recalled_at ASC` with
 *                 `documents.last_accessed_at` fallback
 */
export interface DeductiveOptions {
  maxRecent?: number;
  guarded?: boolean;
  staleOnly?: boolean;
}

// =============================================================================
// Worker State
// =============================================================================

let consolidationTimer: Timer | null = null;
let isRunning = false;
let tickCount = 0;

// =============================================================================
// Worker Functions
// =============================================================================

/**
 * Starts the consolidation worker that enriches documents missing A-MEM metadata
 * and periodically consolidates observations.
 *
 * @param store - Store instance with A-MEM methods
 * @param llm - LLM instance for memory note construction
 * @param intervalMs - Tick interval in milliseconds (default: 300000 = 5 min)
 */
export function startConsolidationWorker(
  store: Store,
  llm: LlamaCpp,
  intervalMs: number = 300000
): void {
  // Clamp interval to minimum 15 seconds
  const interval = Math.max(15000, intervalMs);

  console.log(`[consolidation] Starting worker with ${interval}ms interval`);

  // Set up periodic tick
  consolidationTimer = setInterval(async () => {
    await tick(store, llm);
  }, interval);

  // Use unref() to avoid blocking process exit
  consolidationTimer.unref();

  console.log("[consolidation] Worker started");
}

/**
 * Stops the consolidation worker.
 */
export function stopConsolidationWorker(): void {
  if (consolidationTimer) {
    clearInterval(consolidationTimer);
    consolidationTimer = null;
    console.log("[consolidation] Worker stopped");
  }
}

/**
 * Single worker tick: A-MEM backfill + periodic observation consolidation.
 */
async function tick(store: Store, llm: LlamaCpp): Promise<void> {
  // Reentrancy guard
  if (isRunning) {
    console.log("[consolidation] Skipping tick (already running)");
    return;
  }

  isRunning = true;
  tickCount++;

  try {
    // Phase 1: A-MEM backfill (every tick)
    await backfillAmem(store, llm);

    // Phase 2: Observation consolidation (every 6th tick, ~30 min at default interval)
    if (tickCount % 6 === 0) {
      await consolidateObservations(store, llm);
    }

    // Phase 3: Deductive synthesis (every 3rd tick, ~15 min at default interval)
    if (tickCount % 3 === 0) {
      await generateDeductiveObservations(store, llm);
    }

    // Phase 4: Recall stats recomputation (every tick — lightweight SQL aggregation)
    try {
      const updated = store.recomputeRecallStats();
      if (updated > 0) {
        console.log(`[consolidation] Phase 4: recomputed recall_stats for ${updated} docs`);
      }
    } catch (err) {
      // Non-critical — recall stats are informational, not retrieval-blocking
      console.error("[consolidation] Phase 4 recall stats failed:", err);
    }
  } catch (err) {
    console.error("[consolidation] Tick failed:", err);
  } finally {
    isRunning = false;
  }
}

/**
 * Phase 1: Find and enrich up to 3 documents missing A-MEM metadata.
 */
async function backfillAmem(store: Store, llm: LlamaCpp): Promise<void> {
  const docs = store.db
    .prepare<DocumentToEnrich, []>(
      `SELECT id, hash, title
       FROM documents
       WHERE amem_keywords IS NULL AND active = 1
       ORDER BY created_at ASC
       LIMIT 3`
    )
    .all();

  if (docs.length === 0) return;

  console.log(`[consolidation] Enriching ${docs.length} documents`);

  for (const doc of docs) {
    try {
      const note = await store.constructMemoryNote(llm, doc.id);
      await store.storeMemoryNote(doc.id, note);
      await store.generateMemoryLinks(llm, doc.id);
      console.log(`[consolidation] Enriched doc ${doc.id} (${doc.title})`);
    } catch (err) {
      console.error(`[consolidation] Failed to enrich doc ${doc.id}:`, err);
    }
  }
}

// =============================================================================
// Phase 2: 3-Tier Observation Consolidation
// =============================================================================

/**
 * Find clusters of related observations and synthesize into consolidated observations.
 * Runs per-collection to prevent cross-vault false merges.
 *
 * `opts` (v0.8.0 Ext 5) lets the heavy-maintenance lane override batch size,
 * force merge-safety enforcement, and switch to stale-first ordering. The
 * zero-arg call path (internal light-lane tick) preserves pre-Ext-5 behavior.
 */
export async function consolidateObservations(
  store: Store,
  llm: LlamaCpp,
  opts: ConsolidateOptions = {},
): Promise<void> {
  const maxDocs = opts.maxDocs && opts.maxDocs > 0 ? opts.maxDocs : 50;
  const staleOnly = opts.staleOnly === true;
  const guarded = opts.guarded === true;
  const candidateIds = opts.candidateIds && opts.candidateIds.length > 0
    ? opts.candidateIds
    : null;

  // Early exit when caller passed candidateIds: [] explicitly. An empty
  // array means "the selector found nothing" — not "select everything".
  if (opts.candidateIds && opts.candidateIds.length === 0) {
    console.log("[consolidation] Empty candidateIds array — nothing to consolidate");
    return;
  }

  console.log(
    `[consolidation] Starting observation consolidation (maxDocs=${maxDocs}, ` +
      `staleOnly=${staleOnly}, guarded=${guarded}, ` +
      `candidateIds=${candidateIds ? candidateIds.length : "null"})`,
  );

  // Base SELECT — observation-type docs not yet consolidated.
  // Stale-first ordering joins recall_stats.last_recalled_at ASC with a
  // documents.last_accessed_at fallback so long-unseen docs bubble up first.
  // Default ordering (modified_at DESC) preserves pre-Ext-5 light-lane semantics.
  const orderBy = staleOnly
    ? `ORDER BY
         d.collection,
         COALESCE(rs.last_recalled_at, d.last_accessed_at, d.modified_at) ASC,
         d.modified_at ASC`
    : `ORDER BY d.collection, d.modified_at DESC`;

  const joinClause = staleOnly
    ? `LEFT JOIN recall_stats rs ON rs.doc_id = d.id`
    : ``;

  // When candidateIds is provided, restrict the SELECT to those docs. This
  // is how the heavy lane plumbs surprisal-selector output into Phase 2:
  // select anomaly-first IDs via computeSurprisalScores, then ask
  // consolidateObservations to limit its pattern detection to that subset.
  const candidateFilter = candidateIds
    ? `AND d.id IN (${candidateIds.map(() => "?").join(",")})`
    : ``;

  const sqlParams: (number | string)[] = candidateIds
    ? [...candidateIds, maxDocs]
    : [maxDocs];

  const observations = store.db.prepare(`
    SELECT d.id, d.title, d.facts, d.amem_context as context, d.modified_at, d.collection
    FROM documents d
    ${joinClause}
    WHERE d.active = 1
      AND d.content_type = 'observation'
      AND d.facts IS NOT NULL
      ${candidateFilter}
      AND d.id NOT IN (
        SELECT value FROM (
          SELECT json_each.value as value
          FROM consolidated_observations co, json_each(co.source_doc_ids)
          WHERE co.status = 'active'
        )
      )
    ${orderBy}
    LIMIT ?
  `).all(...sqlParams) as { id: number; title: string; facts: string; context: string; modified_at: string; collection: string }[];

  if (observations.length === 0) {
    console.log("[consolidation] No unconsolidated observations found");
    return;
  }

  // Group by collection
  const clusters = new Map<string, ObservationCluster>();
  for (const obs of observations) {
    if (!clusters.has(obs.collection)) {
      clusters.set(obs.collection, { docs: [], collection: obs.collection });
    }
    clusters.get(obs.collection)!.docs.push(obs);
  }

  // Process each collection cluster
  for (const [collection, cluster] of clusters) {
    if (cluster.docs.length < 2) continue; // Need at least 2 observations to consolidate

    try {
      await synthesizeCluster(store, llm, cluster, { guarded });
    } catch (err) {
      console.error(`[consolidation] Failed to consolidate cluster for ${collection}:`, err);
    }
  }

  // Update trends on existing consolidated observations
  updateTrends(store);

  console.log("[consolidation] Observation consolidation complete");
}

/**
 * Synthesize a cluster of observations into consolidated observations using LLM.
 *
 * `opts.guarded` (v0.8.0 Ext 5) forces merge-safety enforcement inside
 * `findSimilarConsolidation` regardless of `CLAWMEM_MERGE_GUARD_DRY_RUN`.
 */
async function synthesizeCluster(
  store: Store,
  llm: LlamaCpp,
  cluster: ObservationCluster,
  opts: { guarded?: boolean } = {},
): Promise<void> {
  const docsText = cluster.docs.map((d, i) =>
    `${i + 1}. [${d.modified_at}] "${d.title}"\n   Facts: ${d.facts?.slice(0, 300) || 'none'}\n   Context: ${d.context?.slice(0, 200) || 'none'}`
  ).join('\n\n');

  const prompt = `Analyze these ${cluster.docs.length} session observations and identify recurring patterns or cross-session themes.

Observations:
${docsText}

For each pattern you identify:
1. Write a clear, actionable observation (1-2 sentences)
2. Count how many source observations support it (proof_count)
3. List which source numbers (1-indexed) contribute

Return ONLY valid JSON array:
[
  {
    "observation": "Clear statement of the pattern",
    "proof_count": 3,
    "source_indices": [1, 3, 5]
  }
]

Rules:
- Only include patterns supported by 2+ observations
- Be specific — "user frequently modifies X" > "user works on code"
- 1-5 patterns maximum
Return ONLY the JSON array. /no_think`;

  const result = await llm.generate(prompt, {
    temperature: 0.3,
    maxTokens: 500,
  });

  if (!result) return;

  const parsed = extractJsonFromLLM(result.text) as Array<{
    observation: string;
    proof_count: number;
    source_indices: number[];
  }> | null;

  if (!Array.isArray(parsed)) return;

  for (const pattern of parsed) {
    if (!pattern.observation || !Array.isArray(pattern.source_indices) || pattern.source_indices.length < 2) continue;

    // Map source indices to doc IDs
    const sourceDocIds = pattern.source_indices
      .filter(i => i >= 1 && i <= cluster.docs.length)
      .map(i => cluster.docs[i - 1]!.id);

    if (sourceDocIds.length < 2) continue;

    // Check for existing similar consolidated observation (avoid duplicates).
    // Two-stage gate: Jaccard shortlist + name-aware merge safety (Ext 3).
    // `guarded` forces gate enforcement when the heavy lane calls us.
    const existing = findSimilarConsolidation(
      store,
      pattern.observation,
      cluster.collection,
      sourceDocIds,
      opts.guarded === true,
    );
    if (existing) {
      // Ext 2: contradiction gate. Before merging into an existing
      // consolidation, check whether the new observation contradicts
      // the existing one. On actionable contradiction we do NOT merge;
      // instead we insert the new row as a separate consolidation and
      // apply the configured policy (link or supersede).
      const contradiction = await checkContradiction(
        llm,
        existing.observation,
        pattern.observation,
        `collection: ${cluster.collection}`
      );

      if (isActionableContradiction(contradiction)) {
        applyContradictoryConsolidation(
          store,
          existing,
          pattern.observation,
          sourceDocIds,
          cluster.collection,
          contradiction
        );
      } else {
        const { mergedIds } = mergeIntoExistingConsolidation(
          store,
          existing,
          sourceDocIds,
          pattern.observation
        );
        console.log(`[consolidation] Updated observation #${existing.id}: proof_count=${mergedIds.length}`);
      }
    } else {
      // Insert new consolidated observation
      store.db.prepare(`
        INSERT INTO consolidated_observations (observation, proof_count, source_doc_ids, trend, status, collection)
        VALUES (?, ?, ?, 'NEW', 'active', ?)
      `).run(pattern.observation, sourceDocIds.length, JSON.stringify(sourceDocIds), cluster.collection);

      console.log(`[consolidation] Created new observation: "${pattern.observation.slice(0, 60)}..." (proof=${sourceDocIds.length})`);
    }
  }
}

/**
 * Handle a contradictory Phase 2 merge attempt.
 *
 * Inserts the new observation as a separate active consolidation row and
 * applies the resolved contradiction policy, atomically:
 *
 *  - **link** (default): old row stays active (`status='active'`); sets
 *    `invalidated_by = newId` as a backlink so operators can find the
 *    contradiction via `SELECT * FROM consolidated_observations WHERE
 *    invalidated_by IS NOT NULL AND invalidated_at IS NULL`.
 *  - **supersede**: sets `invalidated_at = now`, `invalidated_by = newId`,
 *    `superseded_by = newId`, **AND `status = 'inactive'`** — the old
 *    row stops surfacing via every consolidation reader (all of which
 *    filter by `status = 'active'`). Subsequent recalls and merge
 *    matches see only the new row.
 *
 * The INSERT + UPDATE pair runs inside a SQLite transaction so a
 * failure on the UPDATE side rolls back the new row, preventing a
 * dangling active consolidation with no backlink.
 *
 * Policy is resolved via `CLAWMEM_CONTRADICTION_POLICY=link|supersede`.
 *
 * Returns the new consolidation's id and the policy used.
 */
export function applyContradictoryConsolidation(
  store: Store,
  existing: { id: number; observation: string; source_doc_ids: string },
  newObservation: string,
  newSourceDocIds: number[],
  collection: string,
  contradiction: ContradictionResult
): { newId: number; policy: "link" | "supersede" } {
  const policy = resolveContradictionPolicy();

  let newId = 0;
  const tx = store.db.transaction(() => {
    // Insert the new consolidation as a separate active row
    const insertResult = store.db
      .prepare(
        `INSERT INTO consolidated_observations
           (observation, proof_count, source_doc_ids, trend, status, collection)
         VALUES (?, ?, ?, 'NEW', 'active', ?)`
      )
      .run(
        newObservation,
        newSourceDocIds.length,
        JSON.stringify(newSourceDocIds),
        collection
      );
    newId = Number(insertResult.lastInsertRowid);

    // Apply the policy to the old row
    if (policy === "supersede") {
      // Mark the old row as fully inactive so existing readers
      // (filter on `status = 'active'`) stop surfacing it, and set
      // all three invalidation columns for operator queries.
      store.db
        .prepare(
          `UPDATE consolidated_observations
           SET invalidated_at = datetime('now'),
               invalidated_by = ?,
               superseded_by = ?,
               status = 'inactive'
           WHERE id = ?`
        )
        .run(newId, newId, existing.id);
    } else {
      // link: old row stays active, set backlink only
      store.db
        .prepare(
          `UPDATE consolidated_observations
           SET invalidated_by = ?
           WHERE id = ?`
        )
        .run(newId, existing.id);
    }
  });
  tx();

  console.log(
    `[consolidation] contradiction detected (policy=${policy} source=${contradiction.source} ` +
      `confidence=${contradiction.confidence.toFixed(2)}): ` +
      `existing #${existing.id} + new #${newId} — reason="${contradiction.reason ?? ""}"`
  );

  return { newId, policy };
}

/**
 * Find an existing consolidated observation similar to the given text.
 *
 * Two-stage gate (Ext 3 — name-aware merge safety):
 *  1. Jaccard > 0.5 on long-word sets — cheap candidate shortlist
 *  2. Name-aware dual-threshold merge safety gate — entity-first, lexical
 *     fallback, strictest default when both sides have no anchors
 *
 * Returns the highest-scoring candidate that passes BOTH gates, or null
 * when no candidate passes. Previously the function returned the first
 * Jaccard hit, which allowed semantic-collision merges between topics
 * sharing vocabulary but referring to different subjects (e.g. "Dan" vs
 * "Dad"). The second gate blocks those.
 *
 * Respects `CLAWMEM_MERGE_GUARD_DRY_RUN=true` — in dry-run mode the gate
 * logs its decision for each candidate but does NOT block the merge; the
 * first Jaccard hit is returned (legacy behavior). Use during rollout to
 * observe gate decisions before enforcement.
 */
export function findSimilarConsolidation(
  store: Store,
  observation: string,
  collection: string,
  candidateSourceDocIds: number[],
  forceEnforce: boolean = false,
): { id: number; observation: string; source_doc_ids: string } | null {
  // ORDER BY id ASC makes "first shortlist hit" deterministic across
  // SQLite plan changes — the dry-run legacy parity case relies on
  // iterating rows in a stable insertion order.
  const existing = store.db.prepare(`
    SELECT id, observation, source_doc_ids
    FROM consolidated_observations
    WHERE status = 'active' AND collection = ?
    ORDER BY id ASC
  `).all(collection) as { id: number; observation: string; source_doc_ids: string }[];

  const queryWords = new Set(observation.toLowerCase().split(/\s+/).filter(w => w.length > 3));

  // Stage 1: Jaccard shortlist (broad candidate generation)
  const shortlist: Array<{ row: typeof existing[number]; jaccard: number }> = [];
  for (const obs of existing) {
    const obsWords = new Set(obs.observation.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const intersection = [...queryWords].filter(w => obsWords.has(w)).length;
    const union = new Set([...queryWords, ...obsWords]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    if (jaccard > 0.5) {
      shortlist.push({ row: obs, jaccard });
    }
  }

  if (shortlist.length === 0) return null;

  // `forceEnforce` (v0.8.0 Ext 5) lets the heavy lane override the env
  // `CLAWMEM_MERGE_GUARD_DRY_RUN` so operators can experiment with dry-run
  // in the light lane without weakening heavy-lane guarantees.
  const dryRun = forceEnforce
    ? false
    : process.env.CLAWMEM_MERGE_GUARD_DRY_RUN === "true";

  // Dry-run: preserve EXACT legacy behavior — return the first shortlist
  // hit (the pre-Ext-3 code iterated the SELECT rows in order and returned
  // on first Jaccard > 0.5), while still logging every candidate's gate
  // decision for operator observation.
  if (dryRun) {
    for (const candidate of shortlist) {
      const existingSourceIds = safeParseDocIds(candidate.row.source_doc_ids);
      const result = passesMergeSafety(
        store,
        observation,
        candidateSourceDocIds,
        candidate.row.observation,
        existingSourceIds
      );
      console.log(
        `[consolidation] merge-safety[dry-run] id=${candidate.row.id} ` +
        `jaccard=${candidate.jaccard.toFixed(2)} ` +
        `score=${result.score.toFixed(3)} threshold=${result.threshold} ` +
        `method=${result.method} accepted=${result.accepted} reason="${result.reason}"`
      );
    }
    const first = shortlist[0]!;
    return {
      id: first.row.id,
      observation: first.row.observation,
      source_doc_ids: first.row.source_doc_ids,
    };
  }

  // Stage 2: Merge safety gate — keep best candidate that passes
  let best: { row: typeof existing[number]; gateScore: number } | null = null;
  for (const candidate of shortlist) {
    const existingSourceIds = safeParseDocIds(candidate.row.source_doc_ids);
    const result = passesMergeSafety(
      store,
      observation,
      candidateSourceDocIds,
      candidate.row.observation,
      existingSourceIds
    );

    if (!result.accepted) {
      console.log(
        `[consolidation] merge-safety rejected id=${candidate.row.id} ` +
        `method=${result.method} score=${result.score.toFixed(3)} ` +
        `threshold=${result.threshold} reason="${result.reason}"`
      );
      continue;
    }

    if (!best || result.score > best.gateScore) {
      best = { row: candidate.row, gateScore: result.score };
    }
  }

  if (!best) return null;
  return {
    id: best.row.id,
    observation: best.row.observation,
    source_doc_ids: best.row.source_doc_ids,
  };
}

/**
 * Safely parse a JSON array of doc IDs from a stored string column.
 * Returns an empty array on any parse failure (null, empty string,
 * malformed JSON, non-array JSON). Exported so tests can drive the
 * exact parse path that the merge-update helper and findSimilarConsolidation
 * both rely on.
 */
export function safeParseDocIds(raw: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Merge a new set of source doc IDs into an existing consolidated
 * observation row. Idempotent: deduplicates source IDs, updates proof
 * count to the final de-duplicated size, refreshes observation text.
 *
 * Uses `safeParseDocIds` so a corrupted `source_doc_ids` value on the
 * existing row (NULL, empty string, malformed JSON, non-array JSON)
 * cannot crash the merge path. A corrupted existing row is treated as
 * if it had no prior source IDs, and the merged list contains only the
 * new IDs — recovering the row instead of losing the entire cluster.
 *
 * Extracted from `synthesizeCluster` so the update-path safety can be
 * unit-tested directly (Ext 3 Low finding — review Turn 5).
 */
export function mergeIntoExistingConsolidation(
  store: Store,
  existing: { id: number; source_doc_ids: string },
  newSourceDocIds: number[],
  newObservation: string
): { mergedIds: number[] } {
  const existingSourceIds = safeParseDocIds(existing.source_doc_ids);
  const mergedIds = [...new Set([...existingSourceIds, ...newSourceDocIds])];

  store.db
    .prepare(
      `UPDATE consolidated_observations
       SET proof_count = ?,
           source_doc_ids = ?,
           updated_at = datetime('now'),
           observation = ?
       WHERE id = ?`
    )
    .run(mergedIds.length, JSON.stringify(mergedIds), newObservation, existing.id);

  return { mergedIds };
}

/**
 * Update trend labels on consolidated observations based on evidence timestamps.
 * Trends: NEW (< 7 days), STRENGTHENING (proof growing), WEAKENING (no new evidence 30+ days),
 * STABLE (steady), STALE (60+ days without new evidence).
 */
function updateTrends(store: Store): void {
  const observations = store.db.prepare(`
    SELECT id, proof_count, source_doc_ids, trend, created_at, updated_at
    FROM consolidated_observations
    WHERE status = 'active'
  `).all() as {
    id: number; proof_count: number; source_doc_ids: string;
    trend: string; created_at: string; updated_at: string;
  }[];

  const now = Date.now();
  const DAY_MS = 86400000;

  for (const obs of observations) {
    const createdAge = (now - new Date(obs.created_at).getTime()) / DAY_MS;
    const updatedAge = (now - new Date(obs.updated_at).getTime()) / DAY_MS;

    let newTrend: TrendEnum;
    if (createdAge < 7) {
      newTrend = 'NEW';
    } else if (updatedAge > 60) {
      newTrend = 'STALE';
    } else if (updatedAge > 30) {
      newTrend = 'WEAKENING';
    } else if (obs.proof_count >= 4 && updatedAge < 14) {
      newTrend = 'STRENGTHENING';
    } else {
      newTrend = 'STABLE';
    }

    if (newTrend !== obs.trend) {
      store.db.prepare(`UPDATE consolidated_observations SET trend = ? WHERE id = ?`).run(newTrend, obs.id);
    }
  }
}

// =============================================================================
// Phase 3: Deductive Observation Synthesis
// =============================================================================

/**
 * Find pairs/groups of recent high-confidence observations that can be combined
 * into higher-level deductive conclusions. Creates first-class documents with
 * content_type='deductive' and source_doc_ids provenance.
 *
 * Only considers decision/preference/milestone/problem observations from the
 * last 7 days that haven't already been used as sources for deductions.
 *
 * `opts` (v0.8.0 Ext 5):
 *  - `maxRecent`  override batch size (default 20)
 *  - `staleOnly`  order by recall_stats.last_recalled_at ASC with
 *                 documents.last_accessed_at fallback instead of
 *                 modified_at DESC
 *  - `guarded`    forward-compat marker — no-op in v0.8.0 because the Phase 3
 *                 guardrails always enforce their gates regardless
 */
export async function generateDeductiveObservations(
  store: Store,
  llm: LlamaCpp,
  opts: DeductiveOptions = {},
): Promise<DeductiveSynthesisStats> {
  const maxRecent = opts.maxRecent && opts.maxRecent > 0 ? opts.maxRecent : 20;
  const staleOnly = opts.staleOnly === true;
  const stats = emptyDeductiveStats();
  // Find recent high-value observations not yet used in deductions
  const DEDUCTIVE_TYPES = ['decision', 'preference', 'milestone', 'problem'];

  const orderBy = staleOnly
    ? `ORDER BY COALESCE(rs.last_recalled_at, d.last_accessed_at, d.modified_at) ASC, d.modified_at ASC`
    : `ORDER BY d.modified_at DESC`;
  const joinClause = staleOnly
    ? `LEFT JOIN recall_stats rs ON rs.doc_id = d.id`
    : ``;

  const recentObs = store.db.prepare(`
    SELECT d.id, d.title, d.facts, d.narrative, d.observation_type, d.content_type,
           d.collection, d.path, d.modified_at
    FROM documents d
    ${joinClause}
    WHERE d.active = 1
      AND d.content_type IN (${DEDUCTIVE_TYPES.map(() => '?').join(',')})
      AND d.observation_type IS NOT NULL
      AND d.facts IS NOT NULL
      AND d.modified_at >= datetime('now', '-7 days')
      AND d.id NOT IN (
        SELECT value FROM (
          SELECT json_each.value as value
          FROM documents dd, json_each(dd.source_doc_ids)
          WHERE dd.content_type = 'deductive' AND dd.active = 1
        )
      )
    ${orderBy}
    LIMIT ?
  `).all(...DEDUCTIVE_TYPES, maxRecent) as {
    id: number; title: string; facts: string; narrative: string;
    observation_type: string; content_type: string; collection: string;
    path: string; modified_at: string;
  }[];

  stats.considered = recentObs.length;
  if (recentObs.length < 2) return stats;

  // Build context for LLM
  const obsText = recentObs.map((o, i) =>
    `[${i + 1}] (${o.content_type}/${o.observation_type}) "${o.title}"\n   Facts: ${(o.facts || '').slice(0, 300)}\n   Narrative: ${(o.narrative || '').slice(0, 200)}`
  ).join('\n\n');

  const prompt = `You are analyzing recent observations from a developer's work sessions. Find logical deductions that can be drawn by combining 2-3 observations.

A deduction combines facts from different observations into a NEW conclusion that isn't stated in any single observation alone.

Observations:
${obsText}

For each valid deduction:
1. State the conclusion clearly (1-2 sentences)
2. List the premises (which observations support it)
3. List the source indices (1-indexed)

Return ONLY valid JSON array:
[
  {
    "conclusion": "Clear deductive statement",
    "premises": ["Premise from obs 1", "Premise from obs 3"],
    "source_indices": [1, 3]
  }
]

Rules:
- Each deduction MUST combine 2+ different observations (not restate a single one)
- Only include conclusions with genuine logical basis
- Maximum 3 deductions
- If no valid deductions exist, return []
Return ONLY the JSON array. /no_think`;

  const result = await llm.generate(prompt, { temperature: 0.3, maxTokens: 500 });
  if (!result?.text) {
    stats.nullCalls++;
    console.log(`[deductive] draft-generation LLM null — skipping Phase 3 tick`);
    return stats;
  }

  const parsed = extractJsonFromLLM(result.text) as Array<{
    conclusion: string;
    premises: string[];
    source_indices: number[];
  }> | null;

  if (!Array.isArray(parsed)) return stats;

  stats.drafted = parsed.length;

  const timestamp = new Date().toISOString();
  const dateStr = timestamp.slice(0, 10);

  for (const deduction of parsed) {
    if (!deduction.conclusion || !Array.isArray(deduction.source_indices) || deduction.source_indices.length < 2) {
      stats.rejected++;
      stats.invalidIndexRejects++;
      continue;
    }

    const sourceDocIds = [...new Set(
      deduction.source_indices
        .filter(i => i >= 1 && i <= recentObs.length)
        .map(i => recentObs[i - 1]!.id)
    )];

    if (sourceDocIds.length < 2) {
      stats.rejected++;
      stats.invalidIndexRejects++;
      continue;
    }

    // Ext 1: Anti-contamination validation. Build the source doc
    // subset from recentObs, then run the guardrails:
    //  1. Deterministic pre-checks (non-trivial conclusion, ≥2 sources)
    //  2. Entity-aware / lexical-fallback contamination scan
    //  3. LLM validation/refinement with filtered evidence + relation
    //     context — on null/malformed, fall back to deterministic accept
    const sourceDocs: DocLike[] = sourceDocIds
      .map(id => recentObs.find(o => o.id === id))
      .filter((d): d is typeof recentObs[number] => Boolean(d))
      .map(d => ({
        id: d.id,
        title: d.title,
        facts: d.facts,
        narrative: d.narrative,
      }));

    const draft: DeductiveDraft = {
      conclusion: deduction.conclusion,
      premises: deduction.premises ?? [],
      sourceIndices: deduction.source_indices,
    };

    const validation = await validateDeductiveDraft(
      store,
      llm,
      draft,
      sourceDocs,
      recentObs.map(r => ({
        id: r.id,
        title: r.title,
        facts: r.facts,
        narrative: r.narrative,
      }))
    );

    if (!validation.accepted) {
      stats.rejected++;
      switch (validation.reason) {
        case "contamination":
          stats.contaminationRejects++;
          console.log(
            `[deductive] rejected for contamination (method=${validation.contaminationMethod}): ` +
              `hits=${(validation.contaminationHits ?? []).join(",")} — ` +
              `"${deduction.conclusion.slice(0, 60)}..."`
          );
          break;
        case "invalid_indices":
          stats.invalidIndexRejects++;
          break;
        case "unsupported":
          stats.unsupportedRejects++;
          console.log(
            `[deductive] rejected as unsupported by LLM validator: ` +
              `"${deduction.conclusion.slice(0, 60)}..."`
          );
          break;
        case "empty":
          stats.emptyRejects++;
          break;
      }
      continue;
    }

    stats.accepted++;
    if (validation.fallbackAccepted) {
      stats.validatorFallbackAccepts++;
    }
    // Use validated (possibly LLM-refined) conclusion + premises from
    // here on. This replaces the draft's original text for dedupe,
    // persistence, and the sourceRefs block.
    deduction.conclusion = validation.conclusion ?? deduction.conclusion;
    deduction.premises = validation.premises ?? deduction.premises;

    // Check for duplicate deduction (Jaccard on conclusion text) →
    // contradiction gate (Ext 2). Evaluate ALL near-duplicates, not
    // just the first one, so the decision is order-independent:
    //
    //  - If ANY existing deduction is a non-contradictory duplicate,
    //    skip the new deduction (something already says this).
    //  - Else if ANY existing deduction is an actionable contradiction,
    //    KEEP the new deduction and link to EVERY contradictory match
    //    via `contradicts` relations.
    //  - Else (no Jaccard matches at all) → insert as new.
    const existingDedups = store.db.prepare(`
      SELECT id, title FROM documents
      WHERE content_type = 'deductive' AND active = 1
      ORDER BY created_at DESC LIMIT 20
    `).all() as { id: number; title: string }[];

    const conclusionWords = new Set(deduction.conclusion.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const jaccardDuplicates = existingDedups.filter(d => {
      const titleWords = new Set(d.title.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const intersection = [...conclusionWords].filter(w => titleWords.has(w)).length;
      const union = new Set([...conclusionWords, ...titleWords]).size;
      return union > 0 && intersection / union > 0.5;
    });

    const contradictoryDuplicates: { id: number; confidence: number; reason?: string }[] = [];
    let hasNonContradictoryDuplicate = false;
    for (const candidate of jaccardDuplicates) {
      const contradiction = await checkContradiction(
        llm,
        candidate.title,
        deduction.conclusion,
        "deductive synthesis phase"
      );
      if (isActionableContradiction(contradiction)) {
        contradictoryDuplicates.push({
          id: candidate.id,
          confidence: contradiction.confidence,
          reason: contradiction.reason,
        });
      } else {
        hasNonContradictoryDuplicate = true;
        // Don't break — keep scanning to give operator full log coverage,
        // but we already know we'll skip.
      }
    }

    // Skip rule: if ANY non-contradictory duplicate exists, the new
    // deduction is redundant regardless of any contradictions.
    if (hasNonContradictoryDuplicate) {
      stats.dedupSkipped++;
      continue;
    }
    // Otherwise we either have no matches (fall through to insert as new)
    // or only contradictory matches (insert + link).

    // Build the deductive document
    const premisesText = (deduction.premises || []).map(p => `- ${p}`).join('\n');
    const sourceRefs = sourceDocIds.map(id => {
      const obs = recentObs.find(o => o.id === id);
      return obs ? `- "${obs.title}" (${obs.content_type})` : `- doc#${id}`;
    }).join('\n');

    const body = [
      `---`,
      `content_type: deductive`,
      `tags: [auto-deduced, consolidation]`,
      `---`,
      ``,
      `# ${deduction.conclusion.slice(0, 80)}`,
      ``,
      deduction.conclusion,
      ``,
      `## Premises`,
      ``,
      premisesText,
      ``,
      `## Sources`,
      ``,
      sourceRefs,
      ``,
    ].join('\n');

    const dedPath = `deductions/${dateStr}-${sourceDocIds.join('-')}.md`;
    const hash = hashContent(body);

    try {
      store.insertContent(hash, body, timestamp);
      store.insertDocument("_clawmem", dedPath, deduction.conclusion.slice(0, 80), hash, timestamp, timestamp);

      const doc = store.findActiveDocument("_clawmem", dedPath);
      if (doc) {
        store.updateDocumentMeta(doc.id, {
          content_type: "deductive",
          confidence: 0.85,
        });
        store.updateObservationFields(dedPath, "_clawmem", {
          observation_type: "deductive",
          facts: JSON.stringify(deduction.premises || []),
          narrative: deduction.conclusion,
        });
        // Store source provenance
        store.db.prepare(`UPDATE documents SET source_doc_ids = ? WHERE id = ?`)
          .run(JSON.stringify(sourceDocIds), doc.id);

        // Create supporting edges in memory_relations
        for (const sourceId of sourceDocIds) {
          try {
            store.db.prepare(`
              INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
              VALUES (?, ?, 'supporting', 0.85, datetime('now'))
            `).run(sourceId, doc.id);
          } catch { /* non-fatal */ }
        }

        // Ext 2: If we kept this deduction because it contradicts one
        // or more existing deductive docs, link them ALL via
        // `contradicts` relations so operators can find every conflict
        // via `SELECT * FROM memory_relations WHERE relation_type = 'contradicts'`.
        // Uses the A-MEM convention plural form (P0-enforced).
        if (contradictoryDuplicates.length > 0) {
          const relStmt = store.db.prepare(
            `INSERT OR IGNORE INTO memory_relations
               (source_id, target_id, relation_type, weight, contradict_confidence, metadata, created_at)
             VALUES (?, ?, 'contradicts', 0, ?, ?, datetime('now'))`
          );
          for (const contra of contradictoryDuplicates) {
            try {
              relStmt.run(
                doc.id,
                contra.id,
                contra.confidence,
                JSON.stringify({ reason: contra.reason ?? "" })
              );
              console.log(
                `[deductive] contradiction linked: new #${doc.id} contradicts existing #${contra.id} ` +
                  `(confidence=${contra.confidence.toFixed(2)})`
              );
            } catch { /* non-fatal — the deduction itself still landed */ }
          }
        }

        stats.created++;
        console.log(`[deductive] Created: "${deduction.conclusion.slice(0, 60)}..." from ${sourceDocIds.length} sources`);
      }
    } catch (err) {
      console.error(`[deductive] Failed to create deduction:`, err);
    }
  }

  return stats;
}

/**
 * Manually trigger deductive synthesis (for CLI or MCP tool).
 */
export async function runDeductiveSynthesis(
  store: Store,
  llm: LlamaCpp,
): Promise<DeductiveSynthesisStats> {
  return await generateDeductiveObservations(store, llm);
}

// =============================================================================
// Surprisal Scoring (k-NN density anomaly detection)
// =============================================================================

export interface SurprisalResult {
  docId: number;
  title: string;
  path: string;
  collection: string;
  contentType: string;
  avgNeighborDistance: number;  // higher = more anomalous
  neighborCount: number;
}

/**
 * Compute surprisal scores for observation documents using k-NN average
 * neighbor distance in embedding space. High-surprisal observations are
 * anomalous — they don't fit existing patterns and deserve curator attention.
 *
 * Uses sqlite-vec's built-in KNN query (vec0 virtual table) for efficiency.
 * Only scores documents that have embeddings (content_vectors + vectors_vec).
 */
export function computeSurprisalScores(
  store: Store,
  options?: { collection?: string; limit?: number; k?: number; minScore?: number }
): SurprisalResult[] {
  const k = options?.k ?? 5;
  const limit = options?.limit ?? 20;
  const minScore = options?.minScore ?? 0;

  // Get observation documents with embeddings (seq=0 = primary fragment)
  let sql = `
    SELECT d.id, d.title, d.path, d.collection, d.content_type,
           cv.hash || '_0' as hash_seq
    FROM documents d
    JOIN content_vectors cv ON d.hash = cv.hash AND cv.seq = 0
    WHERE d.active = 1
      AND d.observation_type IS NOT NULL
  `;
  const params: any[] = [];
  if (options?.collection) {
    sql += ` AND d.collection = ?`;
    params.push(options.collection);
  }
  sql += ` ORDER BY d.modified_at DESC LIMIT 100`;

  const docs = store.db.prepare(sql).all(...params) as {
    id: number; title: string; path: string; collection: string;
    content_type: string; hash_seq: string;
  }[];

  if (docs.length < k + 1) return []; // Not enough docs for meaningful k-NN

  // For each doc, query its k nearest neighbors and compute average distance
  const results: SurprisalResult[] = [];

  // Check if vectors_vec exists
  const vecTable = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!vecTable) return [];

  for (const doc of docs) {
    try {
      // Get this doc's embedding from vectors_vec
      const vecRow = store.db.prepare(
        `SELECT embedding FROM vectors_vec WHERE hash_seq = ?`
      ).get(doc.hash_seq) as { embedding: Float32Array | number[] } | null;

      if (!vecRow?.embedding) continue;

      // Query k+1 nearest neighbors (first result is the doc itself)
      const neighbors = store.db.prepare(`
        SELECT distance
        FROM vectors_vec
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(vecRow.embedding, k + 1) as { distance: number }[];

      // Skip the first result (self, distance ≈ 0) and compute average
      const nonSelf = neighbors.filter(n => n.distance > 0.001);
      if (nonSelf.length === 0) continue;

      const avgDist = nonSelf.reduce((sum, n) => sum + n.distance, 0) / nonSelf.length;

      if (avgDist >= minScore) {
        results.push({
          docId: doc.id,
          title: doc.title,
          path: doc.path,
          collection: doc.collection,
          contentType: doc.content_type,
          avgNeighborDistance: avgDist,
          neighborCount: nonSelf.length,
        });
      }
    } catch {
      // Skip docs that fail vector lookup (missing embedding, dimension mismatch)
      continue;
    }
  }

  // Sort by surprisal (highest first) and limit
  results.sort((a, b) => b.avgNeighborDistance - a.avgNeighborDistance);
  return results.slice(0, limit);
}

// =============================================================================
// Public API for MCP / CLI
// =============================================================================

/**
 * Get consolidated observations, optionally filtered.
 */
export function getConsolidatedObservations(
  store: Store,
  options?: { collection?: string; trend?: TrendEnum; minProof?: number; limit?: number }
): ConsolidatedObservation[] {
  let sql = `SELECT * FROM consolidated_observations WHERE status = 'active'`;
  const params: any[] = [];

  if (options?.collection) {
    sql += ` AND collection = ?`;
    params.push(options.collection);
  }
  if (options?.trend) {
    sql += ` AND trend = ?`;
    params.push(options.trend);
  }
  if (options?.minProof) {
    sql += ` AND proof_count >= ?`;
    params.push(options.minProof);
  }

  sql += ` ORDER BY proof_count DESC, updated_at DESC LIMIT ?`;
  params.push(options?.limit || 20);

  return store.db.prepare(sql).all(...params) as ConsolidatedObservation[];
}

/**
 * Manually trigger consolidation (for CLI or MCP tool).
 */
export async function runConsolidation(
  store: Store,
  llm: LlamaCpp,
  dryRun: boolean = false
): Promise<{ clustersFound: number; observationsCreated: number }> {
  if (dryRun) {
    // Count unconsolidated observations
    const count = store.db.prepare(`
      SELECT COUNT(*) as cnt FROM documents
      WHERE active = 1 AND content_type = 'observation' AND facts IS NOT NULL
        AND id NOT IN (
          SELECT value FROM (
            SELECT json_each.value as value
            FROM consolidated_observations co, json_each(co.source_doc_ids)
            WHERE co.status = 'active'
          )
        )
    `).get() as { cnt: number };

    return { clustersFound: count.cnt, observationsCreated: 0 };
  }

  const before = store.db.prepare(`SELECT COUNT(*) as cnt FROM consolidated_observations WHERE status = 'active'`).get() as { cnt: number };
  await consolidateObservations(store, llm);
  const after = store.db.prepare(`SELECT COUNT(*) as cnt FROM consolidated_observations WHERE status = 'active'`).get() as { cnt: number };

  return { clustersFound: 0, observationsCreated: after.cnt - before.cnt };
}
