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

    // Phase 3: Deductive synthesis (every 3rd tick, ~15 min at default interval)
    if (tickCount % 3 === 0) {
      await generateDeductiveObservations(store, llm);
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
// Phase 3: Deductive Observation Synthesis
// =============================================================================

/**
 * Find pairs/groups of recent high-confidence observations that can be combined
 * into higher-level deductive conclusions. Creates first-class documents with
 * content_type='deductive' and source_doc_ids provenance.
 *
 * Only considers decision/preference/milestone/problem observations from the
 * last 7 days that haven't already been used as sources for deductions.
 */
async function generateDeductiveObservations(store: Store, llm: LlamaCpp): Promise<number> {
  // Find recent high-value observations not yet used in deductions
  const DEDUCTIVE_TYPES = ['decision', 'preference', 'milestone', 'problem'];
  const recentObs = store.db.prepare(`
    SELECT d.id, d.title, d.facts, d.narrative, d.observation_type, d.content_type,
           d.collection, d.path, d.modified_at
    FROM documents d
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
    ORDER BY d.modified_at DESC
    LIMIT 20
  `).all(...DEDUCTIVE_TYPES) as {
    id: number; title: string; facts: string; narrative: string;
    observation_type: string; content_type: string; collection: string;
    path: string; modified_at: string;
  }[];

  if (recentObs.length < 2) return 0;

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
  if (!result?.text) return 0;

  const parsed = extractJsonFromLLM(result.text) as Array<{
    conclusion: string;
    premises: string[];
    source_indices: number[];
  }> | null;

  if (!Array.isArray(parsed)) return 0;

  let created = 0;
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.slice(0, 10);

  for (const deduction of parsed) {
    if (!deduction.conclusion || !Array.isArray(deduction.source_indices) || deduction.source_indices.length < 2) continue;

    const sourceDocIds = deduction.source_indices
      .filter(i => i >= 1 && i <= recentObs.length)
      .map(i => recentObs[i - 1]!.id);

    if (sourceDocIds.length < 2) continue;

    // Check for duplicate deduction (Jaccard on conclusion text)
    const existingDedups = store.db.prepare(`
      SELECT id, title FROM documents
      WHERE content_type = 'deductive' AND active = 1
      ORDER BY created_at DESC LIMIT 20
    `).all() as { id: number; title: string }[];

    const conclusionWords = new Set(deduction.conclusion.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const isDuplicate = existingDedups.some(d => {
      const titleWords = new Set(d.title.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const intersection = [...conclusionWords].filter(w => titleWords.has(w)).length;
      const union = new Set([...conclusionWords, ...titleWords]).size;
      return union > 0 && intersection / union > 0.5;
    });

    if (isDuplicate) continue;

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

        created++;
        console.log(`[deductive] Created: "${deduction.conclusion.slice(0, 60)}..." from ${sourceDocIds.length} sources`);
      }
    } catch (err) {
      console.error(`[deductive] Failed to create deduction:`, err);
    }
  }

  return created;
}

/**
 * Manually trigger deductive synthesis (for CLI or MCP tool).
 */
export async function runDeductiveSynthesis(
  store: Store,
  llm: LlamaCpp,
): Promise<{ created: number }> {
  const created = await generateDeductiveObservations(store, llm);
  return { created };
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
