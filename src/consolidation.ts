/**
 * ClawMem Consolidation Worker
 *
 * Two-phase background worker:
 * 1. A-MEM backfill: enriches documents missing memory notes
 * 2. 3-tier consolidation: synthesizes clusters of related observations
 *    into higher-order consolidated observations with proof counts and trends
 *
 * Pattern H from ENHANCEMENT-PLAN.md (source: Hindsight consolidator.py)
 */

import type { Store } from "./store.ts";
import type { LlamaCpp } from "./llm.ts";
import { extractJsonFromLLM } from "./amem.ts";

// =============================================================================
// Types
// =============================================================================

interface DocumentToEnrich {
  id: number;
  hash: string;
  title: string;
}

export type TrendEnum = 'NEW' | 'STABLE' | 'STRENGTHENING' | 'WEAKENING' | 'STALE';

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
 */
async function consolidateObservations(store: Store, llm: LlamaCpp): Promise<void> {
  console.log("[consolidation] Starting observation consolidation");

  // Find observation-type documents not yet consolidated
  const observations = store.db.prepare(`
    SELECT d.id, d.title, d.facts, d.amem_context as context, d.modified_at, d.collection
    FROM documents d
    WHERE d.active = 1
      AND d.content_type = 'observation'
      AND d.facts IS NOT NULL
      AND d.id NOT IN (
        SELECT value FROM (
          SELECT json_each.value as value
          FROM consolidated_observations co, json_each(co.source_doc_ids)
          WHERE co.status = 'active'
        )
      )
    ORDER BY d.collection, d.modified_at DESC
    LIMIT 50
  `).all() as { id: number; title: string; facts: string; context: string; modified_at: string; collection: string }[];

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
      await synthesizeCluster(store, llm, cluster);
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
 */
async function synthesizeCluster(
  store: Store,
  llm: LlamaCpp,
  cluster: ObservationCluster
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

    // Check for existing similar consolidated observation (avoid duplicates)
    const existing = findSimilarConsolidation(store, pattern.observation, cluster.collection);
    if (existing) {
      // Update existing: merge source docs, increment proof count
      const existingSourceIds: number[] = JSON.parse(existing.source_doc_ids as unknown as string || '[]');
      const mergedIds = [...new Set([...existingSourceIds, ...sourceDocIds])];

      store.db.prepare(`
        UPDATE consolidated_observations
        SET proof_count = ?,
            source_doc_ids = ?,
            updated_at = datetime('now'),
            observation = ?
        WHERE id = ?
      `).run(mergedIds.length, JSON.stringify(mergedIds), pattern.observation, existing.id);

      console.log(`[consolidation] Updated observation #${existing.id}: proof_count=${mergedIds.length}`);
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
 * Find an existing consolidated observation similar to the given text.
 * Uses simple word overlap (Jaccard) to detect near-duplicates.
 */
function findSimilarConsolidation(
  store: Store,
  observation: string,
  collection: string
): { id: number; source_doc_ids: string } | null {
  const existing = store.db.prepare(`
    SELECT id, observation, source_doc_ids
    FROM consolidated_observations
    WHERE status = 'active' AND collection = ?
  `).all(collection) as { id: number; observation: string; source_doc_ids: string }[];

  const queryWords = new Set(observation.toLowerCase().split(/\s+/).filter(w => w.length > 3));

  for (const obs of existing) {
    const obsWords = new Set(obs.observation.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const intersection = [...queryWords].filter(w => obsWords.has(w)).length;
    const union = new Set([...queryWords, ...obsWords]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    if (jaccard > 0.5) {
      return { id: obs.id, source_doc_ids: obs.source_doc_ids };
    }
  }

  return null;
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
