/**
 * MAGMA Adaptive Graph Traversal
 *
 * Beam search over multi-graph memory structure with intent-aware routing.
 * Reference: MAGMA paper (arXiv:2501.XXXXX, Jan 2026)
 */

import type { Database } from "bun:sqlite";
import { storedVector, VecPoisonError } from "./vector-guard.ts";
import type { IntentType } from "./intent.ts";
import { getIntentWeights } from "./intent.ts";
import { notLegacyArtifactSql } from "./compaction-state.ts";
import { relWeightSql } from "./relation-weight.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Candidate-eligibility policy (v0.32.0). Collection scoping and the effective-time window are
 * caller-supplied; the CORE predicates — active = 1, invalidated_at IS NULL, not the legacy
 * pre-compaction artifact (62.2), and the
 * COALESCE(authored_at, modified_at) effective-time axis for any time window — are baked into
 * every traversal SQL and cannot be waived by any caller. Ineligible rows are pruned in the
 * neighbor/edge queries themselves — BEFORE beam selection, per-node top-k, and mass
 * normalization — so they can neither crowd out nor demote eligible nodes.
 */
export interface CandidateEligibility {
  allowCollections?: string[];
  excludeCollections?: string[];
  timeRange?: { start: string; end: string };
}

export function eligibilitySql(alias: string, e: CandidateEligibility | undefined): { sql: string; params: string[] } {
  // 62.2: the legacy pre-compaction artifact is never a traversal candidate (compaction-state.ts).
  const clauses = [`${alias}.active = 1`, `${alias}.invalidated_at IS NULL`, notLegacyArtifactSql(alias)];
  const params: string[] = [];
  if (e?.allowCollections && e.allowCollections.length > 0) {
    clauses.push(`${alias}.collection IN (${e.allowCollections.map(() => "?").join(",")})`);
    params.push(...e.allowCollections);
  }
  if (e?.excludeCollections && e.excludeCollections.length > 0) {
    clauses.push(`${alias}.collection NOT IN (${e.excludeCollections.map(() => "?").join(",")})`);
    params.push(...e.excludeCollections);
  }
  if (e?.timeRange) {
    clauses.push(`COALESCE(${alias}.authored_at, ${alias}.modified_at) >= ? AND COALESCE(${alias}.authored_at, ${alias}.modified_at) <= ?`);
    params.push(e.timeRange.start, e.timeRange.end);
  }
  return { sql: clauses.join(" AND "), params };
}

export interface TraversalOptions {
  maxDepth: number;           // 2-3 hops
  beamWidth: number;          // 5-10 nodes per level
  budget: number;             // Max total nodes (20-50)
  intent: IntentType;
  queryEmbedding: number[] | Float32Array;
  eligibility?: CandidateEligibility;
}

export interface TraversalNode {
  docId: number;
  path: string;
  score: number;
  hops: number;
  viaRelation?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Get document embedding from vectors_vec table.
 */
let warnedUnusableStoredVector = false;

/**
 * v0.43.7 (BACKLOG 82.2): the blob is DECODED and validated (`storedVector`). Bun returns it as a `Uint8Array`;
 * through v0.43.6 it was typed `Float32Array` without decoding, so its length never matched the query's and the
 * affinity of every neighbour was 0. A vector that is not usable contributes affinity 0 (an empty array) and one
 * warning per process — the traversal leg is not discarded.
 */
function getDocEmbedding(db: Database, docId: number): Float32Array {
  // Get the hash for this document
  const doc = db.prepare(`
    SELECT hash FROM documents WHERE id = ?
  `).get(docId) as { hash: string } | undefined;

  if (!doc) return new Float32Array(0);

  // Get embedding for seq=0 (whole document)
  const row = db.prepare(`
    SELECT embedding FROM vectors_vec WHERE hash_seq = ?
  `).get(`${doc.hash}_0`) as { embedding: Uint8Array } | undefined;

  if (!row?.embedding) return new Float32Array(0);
  try {
    return storedVector(row.embedding, undefined, { context: `${doc.hash}_0` });
  } catch (e) {
    if (!(e instanceof VecPoisonError)) throw e;
    if (!warnedUnusableStoredVector) {
      warnedUnusableStoredVector = true;
      console.warn(`[clawmem] graph traversal skipped a stored vector that is not usable (${e.message}) Run 'clawmem doctor', then 'clawmem repair vectors'.`);
    }
    return new Float32Array(0);
  }
}

/**
 * Get document path from ID.
 */
function getDocPath(db: Database, docId: number): string {
  const row = db.prepare(`
    SELECT collection, path FROM documents WHERE id = ?
  `).get(docId) as { collection: string; path: string } | undefined;

  return row ? `${row.collection}/${row.path}` : '';
}

// =============================================================================
// Adaptive Traversal
// =============================================================================

/**
 * Get document ID from hash.
 */
function getDocIdFromHash(db: Database, hash: string): number | null {
  const row = db.prepare(`
    SELECT id FROM documents WHERE hash = ? AND active = 1 LIMIT 1
  `).get(hash) as { id: number } | undefined;
  return row?.id || null;
}

/**
 * Perform intent-aware beam search over memory graph.
 *
 * Algorithm:
 * 1. Start from anchor documents (top BM25/vector results)
 * 2. Expand frontier by following edges weighted by intent
 * 3. Score each new node: parent_score * decay + transition_score
 * 4. Keep top-k nodes per level (beam search)
 * 5. Stop at maxDepth or budget
 */
export function adaptiveTraversal(
  db: Database,
  anchors: { hash: string; score: number }[],
  options: TraversalOptions
): TraversalNode[] {
  // Convert hashes to IDs
  const anchorNodes: { docId: number; score: number }[] = [];
  for (const anchor of anchors) {
    const docId = getDocIdFromHash(db, anchor.hash);
    if (docId !== null) {
      anchorNodes.push({ docId, score: anchor.score });
    }
  }
  const { maxDepth, beamWidth, budget, intent, queryEmbedding, eligibility } = options;

  // Intent-specific weights for structural alignment
  const weights = getIntentWeights(intent);

  // Neighbor-selection query — eligibility lives IN the SQL, always: the core predicates
  // (active/invalidated, plus any time window) apply even for callers with no collection
  // policy, so ineligible nodes never enter `candidates` (no beam consumption, no
  // normalization skew).
  const elig = eligibilitySql("d", eligibility);
  const neighborStmt = db.prepare(`
        SELECT r.target_id as docId, r.relation_type, ${relWeightSql("r")} AS weight
        FROM memory_relations r
        JOIN documents d ON d.id = r.target_id
        WHERE r.source_id = ? AND ${elig.sql}

        UNION

        SELECT r.source_id as docId, r.relation_type, ${relWeightSql("r")} AS weight
        FROM memory_relations r
        JOIN documents d ON d.id = r.source_id
        WHERE r.target_id = ? AND r.relation_type IN ('semantic', 'entity') AND ${elig.sql}
      `);

  const visited = new Map<number, TraversalNode>();
  let currentFrontier: TraversalNode[] = anchorNodes.map(a => ({
    docId: a.docId,
    path: getDocPath(db, a.docId),
    score: a.score,
    hops: 0,
  }));

  // Add anchors to visited set
  for (const node of currentFrontier) {
    visited.set(node.docId, node);
  }

  // Beam search expansion
  for (let depth = 1; depth <= maxDepth; depth++) {
    const candidates: TraversalNode[] = [];

    for (const u of currentFrontier) {
      // Get all neighbors via any relation type (eligibility enforced in the statement)
      const neighbors = neighborStmt.all(
        u.docId, ...elig.params, u.docId, ...elig.params
      ) as { docId: number; relation_type: string; weight: number }[];

      for (const neighbor of neighbors) {
        if (visited.has(neighbor.docId)) continue;

        // Get neighbor embedding for semantic affinity
        const neighborVec = getDocEmbedding(db, neighbor.docId);
        const semanticAffinity = neighborVec.length > 0
          ? cosineSimilarity(queryEmbedding, neighborVec)
          : 0;

        // Calculate transition score: λ1·structure + λ2·semantic
        const λ1 = 0.6;
        const λ2 = 0.4;
        const structureScore = weights[neighbor.relation_type as keyof typeof weights] || 1.0;
        const transitionScore = Math.exp(λ1 * structureScore + λ2 * semanticAffinity);

        // Apply decay and accumulate
        const γ = 0.9;
        const newScore = u.score * γ + transitionScore * neighbor.weight;

        candidates.push({
          docId: neighbor.docId,
          path: getDocPath(db, neighbor.docId),
          score: newScore,
          hops: depth,
          viaRelation: neighbor.relation_type,
        });
      }
    }

    // Take top-k by score (beam search)
    candidates.sort((a, b) => b.score - a.score);
    currentFrontier = candidates.slice(0, beamWidth);

    for (const node of currentFrontier) {
      visited.set(node.docId, node);
    }

    // Budget check
    if (visited.size >= budget) break;
  }

  // Convert to sorted array
  return Array.from(visited.values()).sort((a, b) => b.score - a.score);
}

// =============================================================================
// MPFP: Multi-Path Fact Propagation (Pattern E)
// =============================================================================

/**
 * Predefined meta-path patterns for graph traversal.
 * Each pattern is a sequence of edge types to follow at each hop.
 */
export type MetaPath = string[];

/**
 * Get MPFP meta-path patterns based on intent.
 */
export function getMetaPathsForIntent(intent: IntentType): MetaPath[] {
  switch (intent) {
    case 'WHY':
      return [
        ['semantic', 'causal'],      // forward causal reasoning
        ['causal', 'semantic'],      // backward reasoning → context
        ['semantic', 'semantic'],    // topic expansion
      ];
    case 'ENTITY':
      return [
        ['entity', 'semantic'],      // entity → related topics
        ['entity', 'entity'],        // entity co-occurrence chains
        ['semantic', 'entity'],      // topic → entity discovery
      ];
    case 'WHEN':
      return [
        ['temporal', 'semantic'],    // timeline → context
        ['semantic', 'temporal'],    // context → timeline
      ];
    case 'WHAT':
      return [
        ['semantic', 'semantic'],    // topic expansion
        ['semantic', 'supporting'],  // evidence chains
      ];
  }
}

/**
 * Shared edge cache for hop-synchronized loading.
 * All patterns share this cache to avoid redundant DB queries.
 */
type EdgeCache = Map<number, Map<string, { docId: number; weight: number }[]>>;

/**
 * Batch-load edges for a set of node IDs, filtered by edge type.
 * Results cached in edgeCache for reuse across patterns.
 */
function batchLoadEdges(
  db: Database,
  nodeIds: number[],
  edgeType: string,
  edgeCache: EdgeCache,
  topK: number = 10,
  eligibility?: CandidateEligibility
): void {
  // Only load nodes not already cached for this edge type.
  // The cache is created per-mpfpTraversal call, so one eligibility policy governs its
  // whole lifetime — entries never leak across policies.
  const uncached = nodeIds.filter(id => {
    const cached = edgeCache.get(id);
    return !cached || !cached.has(edgeType);
  });

  if (uncached.length === 0) return;

  const placeholders = uncached.map(() => '?').join(',');
  const elig = eligibilitySql("d", eligibility);

  // Outbound edges (source → target) — destination must be eligible, checked here so
  // ineligible rows never receive propagated mass or occupy a top-k slot
  const outbound = db.prepare(`
    SELECT r.source_id, r.target_id as docId, ${relWeightSql("r")} AS weight
    FROM memory_relations r
    JOIN documents d ON d.id = r.target_id
    WHERE r.source_id IN (${placeholders}) AND r.relation_type = ? AND ${elig.sql}
    ORDER BY ${relWeightSql("r")} DESC
  `).all(...uncached, edgeType, ...elig.params) as { source_id: number; docId: number; weight: number }[];

  // Inbound edges for symmetric types (semantic, entity)
  let inbound: { source_id: number; docId: number; weight: number }[] = [];
  if (edgeType === 'semantic' || edgeType === 'entity') {
    inbound = db.prepare(`
      SELECT r.target_id as source_id, r.source_id as docId, ${relWeightSql("r")} AS weight
      FROM memory_relations r
      JOIN documents d ON d.id = r.source_id
      WHERE r.target_id IN (${placeholders}) AND r.relation_type = ? AND ${elig.sql}
      ORDER BY ${relWeightSql("r")} DESC
    `).all(...uncached, edgeType, ...elig.params) as typeof inbound;
  }

  // Populate cache (top-k per node)
  for (const nodeId of uncached) {
    if (!edgeCache.has(nodeId)) edgeCache.set(nodeId, new Map());
    const nodeEdges = [
      ...outbound.filter(e => e.source_id === nodeId),
      ...inbound.filter(e => e.source_id === nodeId),
    ].slice(0, topK);
    edgeCache.get(nodeId)!.set(edgeType, nodeEdges.map(e => ({ docId: e.docId, weight: e.weight })));
  }
}

/**
 * Execute a single meta-path traversal using Forward Push with teleport.
 *
 * @param db - Database instance
 * @param anchors - Seed nodes with initial scores
 * @param metaPath - Edge type sequence to follow at each hop
 * @param edgeCache - Shared edge cache (hop-synchronized)
 * @param alpha - Teleport probability (default 0.15)
 * @param threshold - Mass pruning threshold (default 1e-4)
 * @returns Nodes discovered with scores
 */
function executeMetaPath(
  db: Database,
  anchors: { docId: number; score: number }[],
  metaPath: MetaPath,
  edgeCache: EdgeCache,
  alpha: number = 0.15,
  threshold: number = 1e-4,
  eligibility?: CandidateEligibility
): TraversalNode[] {
  const results = new Map<number, number>(); // docId → accumulated score

  // Initialize residual with anchor scores
  let residual = new Map<number, number>();
  for (const a of anchors) {
    residual.set(a.docId, a.score);
    results.set(a.docId, a.score * alpha); // teleport portion stays at seed
  }

  // Walk each hop in the meta-path
  for (let hop = 0; hop < metaPath.length; hop++) {
    const edgeType = metaPath[hop]!;
    const activeNodes = [...residual.entries()].filter(([_, mass]) => mass > threshold);
    if (activeNodes.length === 0) break;

    // Batch-load edges for this hop (shared cache)
    const nodeIds = activeNodes.map(([id]) => id);
    batchLoadEdges(db, nodeIds, edgeType, edgeCache, 10, eligibility);

    const nextResidual = new Map<number, number>();

    for (const [nodeId, mass] of activeNodes) {
      const propagated = mass * (1 - alpha);
      const nodeEdges = edgeCache.get(nodeId)?.get(edgeType) || [];

      if (nodeEdges.length === 0) continue;

      // Distribute mass evenly across neighbors (weighted by edge weight)
      const totalWeight = nodeEdges.reduce((sum, e) => sum + e.weight, 0);
      if (totalWeight === 0) continue;

      for (const edge of nodeEdges) {
        const share = (propagated * edge.weight) / totalWeight;
        const current = nextResidual.get(edge.docId) || 0;
        nextResidual.set(edge.docId, current + share);

        // Accumulate in results (teleport portion)
        const existing = results.get(edge.docId) || 0;
        results.set(edge.docId, existing + share * alpha);
      }
    }

    residual = nextResidual;
  }

  // Convert to TraversalNode array
  return [...results.entries()]
    .filter(([_, score]) => score > threshold)
    .map(([docId, score]) => ({
      docId,
      path: getDocPath(db, docId),
      score,
      hops: metaPath.length,
      viaRelation: metaPath.join('→'),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * MPFP Multi-Path Fact Propagation traversal.
 * Runs multiple meta-path patterns in parallel, fuses results.
 *
 * @param db - Database instance
 * @param anchors - Seed documents (from BM25/vector search)
 * @param intent - Query intent for pattern selection
 * @param budget - Maximum total nodes to return
 * @returns Traversed nodes with scores
 */
export function mpfpTraversal(
  db: Database,
  anchors: { hash: string; score: number }[],
  intent: IntentType,
  budget: number = 30,
  eligibility?: CandidateEligibility
): TraversalNode[] {
  // Convert hashes to IDs
  const anchorNodes: { docId: number; score: number }[] = [];
  for (const anchor of anchors) {
    const docId = getDocIdFromHash(db, anchor.hash);
    if (docId !== null) {
      anchorNodes.push({ docId, score: anchor.score });
    }
  }

  if (anchorNodes.length === 0) return [];

  const metaPaths = getMetaPathsForIntent(intent);
  const edgeCache: EdgeCache = new Map(); // Shared across all patterns

  // Execute all meta-paths (synchronous — SQLite is single-threaded anyway)
  const pathResults: TraversalNode[][] = metaPaths.map(path =>
    executeMetaPath(db, anchorNodes, path, edgeCache, 0.15, 1e-4, eligibility)
  );

  // Fuse results via max-score (not RRF): Forward Push produces absolute propagation mass
  // where magnitude carries signal. Rank-only fusion (RRF) would discard the difference
  // between a strong path hit (0.9) and a barely-surviving tail hit (0.01). Meta-paths are
  // alternative explanations — "best supporting path wins" is the correct fusion rule here.
  const fused = new Map<number, TraversalNode>();
  for (const results of pathResults) {
    for (const node of results) {
      const existing = fused.get(node.docId);
      if (!existing || node.score > existing.score) {
        fused.set(node.docId, node);
      }
    }
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, budget);
}

// =============================================================================
// Merge Helpers
// =============================================================================

/**
 * Merge graph traversal results with original search results.
 * Returns results with both hash and score for re-integration.
 */
export function mergeTraversalResults(
  db: Database,
  originalResults: { hash: string; score: number }[],
  traversedNodes: TraversalNode[]
): { hash: string; score: number }[] {
  const merged = new Map<string, number>();

  // Add original results
  for (const r of originalResults) {
    merged.set(r.hash, r.score);
  }

  // Normalize traversal scores to [0, 1] before merging (traversal uses exp() which is unbounded)
  const maxTraversalScore = traversedNodes.length > 0
    ? Math.max(...traversedNodes.map(n => n.score))
    : 1;
  const normalizer = maxTraversalScore > 0 ? 1 / maxTraversalScore : 1;

  // Merge traversed nodes (boost scores slightly for multi-hop discoveries)
  for (const node of traversedNodes) {
    // Get hash from doc ID
    const doc = db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(node.docId) as { hash: string } | undefined;
    if (!doc) continue;

    const normalizedScore = node.score * normalizer;
    const existing = merged.get(doc.hash);
    if (existing !== undefined) {
      // Document found via both direct search and traversal - boost it
      merged.set(doc.hash, Math.max(existing, normalizedScore * 1.1));
    } else {
      // New document discovered via traversal
      merged.set(doc.hash, normalizedScore * 0.8); // Slight penalty for indirect hits
    }
  }

  // Convert back to array and sort
  return Array.from(merged.entries())
    .map(([hash, score]) => ({ hash, score }))
    .sort((a, b) => b.score - a.score);
}
