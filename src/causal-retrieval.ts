/**
 * Shared intent-aware causal retrieval pipeline (v0.32.0).
 *
 * One implementation behind every causal surface — MCP `memory_retrieve`'s causal mode, MCP
 * `intent_search`, MCP `query_plan`'s graph clauses, and REST `/retrieve`'s causal mode. Before
 * v0.32.0 these were four divergent variants; behavioral parity now holds by construction.
 * Callers choose STAGES and ELIGIBILITY explicitly — nothing is implied by the surface.
 *
 * Visibility model:
 * - `baseEligibility` — the caller's collection/time policy, threaded into anchors, adaptive
 *   traversal, and MPFP. The core predicates (active, not-invalidated, effective-time axis
 *   COALESCE(authored_at, modified_at)) are non-waivable and live in the SQL.
 * - WHY observation lane — for default-filtered callers, a WHY-classified query additionally
 *   anchors into `_clawmem` OBSERVATION documents (path 'observations/%', observation_type NOT
 *   NULL — not content_type, which would drop decision/preference/milestone/problem-typed
 *   observations) and follows causal edges one bounded hop in BOTH directions. The exception
 *   admits only observation documents — handoffs and deductions stay excluded — and never flows
 *   through adaptive traversal, MPFP, or entity expansion (the C4' one-hop fence).
 * - Entity co-occurrence expansion is a LEGACY stage OUTSIDE the eligibility contract: the
 *   `entity_cooccurrences` aggregates carry no source-document provenance, so no visibility or
 *   time policy can be honored through them. Its only home is direct `intent_search`.
 */

import type { Store, SearchResult, VecSearchDetailedResult } from "./store.ts";
import { notLegacyArtifactSql } from "./compaction-state.ts";
import { DEFAULT_EMBED_MODEL, rethrowIfFatalVectorError } from "./store.ts";
import { isRefusedEmbedResponse } from "./vector-guard.ts";
import type { LLM } from "./llm.ts";
import { classifyIntent, extractTemporalConstraint, type IntentType, type IntentResult } from "./intent.ts";
import { reciprocalRankFusion, toRanked, attachRrfScores, type RankedResult } from "./search-utils.ts";
import { adaptiveTraversal, mergeTraversalResults, mpfpTraversal, type CandidateEligibility } from "./graph-traversal.ts";
import { getEntityGraphNeighbors } from "./entity.ts";

// =============================================================================
// Shared routing signals (one source of truth for MCP + REST classifiers)
// =============================================================================

// The MCP classifier's signal set was the superset; REST's own copy recognized neither
// "why were" nor "because we", so those queries never reached the causal route over REST.
export const TIMELINE_SIGNAL_RE = /\b(last session|yesterday|prior session|previous session|last time we|handoff|what happened last|what did we do|cross.session|earlier today|this morning|what we discussed|when we last)\b/i;
export const CAUSAL_SIGNAL_RE = /\b(why did|why was|why were|what caused|what led to|reason for|decided to|decision about|trade.?off|instead of|chose to|because we)\b/i;
export const CAUSAL_PREFIX_RE = /^why\b/i;

export function hasTimelineSignal(q: string): boolean {
  return TIMELINE_SIGNAL_RE.test(q);
}

export function hasCausalSignal(q: string): boolean {
  return CAUSAL_SIGNAL_RE.test(q) || CAUSAL_PREFIX_RE.test(q.trim());
}

// =============================================================================
// Types
// =============================================================================

export interface CausalStages {
  traversal: boolean;
  mpfp: boolean;
  entityExpansion: boolean;
  rerank: boolean;
  causalOneHop: boolean;
}

export interface CausalBudgets {
  anchorLimit: number;        // per-channel anchor fetch (default 30)
  obsAnchorK: number;         // internal observation anchors kept per channel (default 5)
  seedCount: number;          // fused results seeding traversal / one-hop (default 10)
  traversalDepth: number;
  traversalBeam: number;
  traversalBudget: number;
  mpfpBudget: number;
  entityLimit: number;
  oneHopPerAnchor: number;    // default 3
  oneHopGlobal: number;       // default 10
}

export const DEFAULT_CAUSAL_BUDGETS: CausalBudgets = {
  anchorLimit: 30,
  obsAnchorK: 5,
  seedCount: 10,
  traversalDepth: 2,
  traversalBeam: 5,
  traversalBudget: 30,
  mpfpBudget: 20,
  entityLimit: 15,
  oneHopPerAnchor: 3,
  oneHopGlobal: 10,
};

export interface CausalAssociation {
  anchorDocid: string;
  direction: "cause" | "effect";
}

export interface CausalRetrievalOptions {
  forceIntent?: IntentType;
  stages: CausalStages;
  budgets?: Partial<CausalBudgets>;
  baseEligibility: CandidateEligibility;
  whyObservationLane: boolean;
}

export interface CausalDegradedLeg {
  leg: string;
  reason: NonNullable<VecSearchDetailedResult["degradedReason"]>;
  /** v0.43.7 (82.2 D4): stored vectors the leg's scan skipped as unusable (with reason `vector-fault`). */
  vectorFaults?: number;
}

/**
 * The entries of one vector-anchor lookup: the older reason stays as it is; stored vectors
 * the scan skipped are an entry of their own, with the count.
 */
function anchorEntries(leg: string, det: Pick<VecSearchDetailedResult, "degraded" | "degradedReason" | "vectorFaults">): CausalDegradedLeg[] {
  const entries: CausalDegradedLeg[] = [];
  if (det.degraded && det.degradedReason && det.degradedReason !== "vector-fault") entries.push({ leg, reason: det.degradedReason });
  if (det.vectorFaults > 0) entries.push({ leg, reason: "vector-fault", vectorFaults: det.vectorFaults });
  return entries;
}

export interface CausalRetrievalResult {
  /** The FULL classification result — including temporal fields — so callers that expose it
   * in structured output (memory_retrieve causal) keep their pre-v0.32.0 contract. */
  intent: IntentResult;
  results: SearchResult[];
  /** filepath → causal one-hop associations for results discovered/confirmed by the hop */
  associations: Map<string, CausalAssociation[]>;
  degraded: CausalDegradedLeg[];
}

// =============================================================================
// Internals
// =============================================================================

function hydrateByHash(store: Store, hash: string): (SearchResult & { observationType: string | null; effectiveTime: string | null }) | null {
  const doc = store.db.prepare(`
    SELECT d.collection, d.path, d.title, d.hash, d.observation_type, c.doc as body, d.modified_at,
           COALESCE(d.authored_at, d.modified_at) as effective_time
    FROM documents d
    LEFT JOIN content c ON c.hash = d.hash
    WHERE d.hash = ? AND d.active = 1 AND d.invalidated_at IS NULL AND ${notLegacyArtifactSql("d", "c.doc")} LIMIT 1
  `).get(hash) as { collection: string; path: string; title: string; hash: string; observation_type: string | null; body: string | null; modified_at: string; effective_time: string | null } | undefined;
  if (!doc) return null;
  return {
    filepath: `clawmem://${doc.collection}/${doc.path}`,
    displayPath: `${doc.collection}/${doc.path}`,
    title: doc.title || doc.path.split("/").pop() || "",
    context: null,
    hash: doc.hash,
    docid: doc.hash.slice(0, 6),
    collectionName: doc.collection,
    modifiedAt: doc.modified_at || "",
    bodyLength: doc.body?.length || 0,
    body: doc.body || "",
    score: 0,
    source: "vec" as const,
    observationType: doc.observation_type,
    effectiveTime: doc.effective_time,
  } as SearchResult & { observationType: string | null; effectiveTime: string | null };
}

/**
 * Base-policy admission. Used for graph SEEDS and for graph-DISCOVERED nodes at hydration:
 * adaptive traversal and MPFP admit baseEligible only — lane-admitted observation documents
 * never seed them and are never re-admitted through them (C4' one-hop fence). Lane results
 * reach output exclusively via the anchor lists and the one-hop step.
 *
 * `effectiveTime` is the caller-computed COALESCE(authored_at, modified_at) (§51.1 axis).
 * When the policy carries a timeRange, an unknown effective time fails CLOSED — a row that
 * cannot prove it is inside the window is not admitted. Exported for direct unit coverage:
 * the SQL legs normally reject these rows earlier, so this guard is defense-in-depth and
 * cannot be exercised through the production traversal path alone.
 */
export function baseAdmissible(
  r: { collectionName: string },
  base: CandidateEligibility,
  effectiveTime?: string | null,
): boolean {
  const inAllow = !base.allowCollections || base.allowCollections.length === 0 || base.allowCollections.includes(r.collectionName);
  const notExcluded = !base.excludeCollections || !base.excludeCollections.includes(r.collectionName);
  if (!inAllow || !notExcluded) return false;
  if (base.timeRange) {
    if (!effectiveTime) return false;
    if (effectiveTime < base.timeRange.start || effectiveTime > base.timeRange.end) return false;
  }
  return true;
}

interface OneHopHit {
  anchorRank: number;
  anchorDocid: string;
  neighborHash: string;
  weight: number;
  direction: "cause" | "effect";
}

interface OneHopEndpoint {
  neighborHash: string;
  bestAnchorRank: number;
  bestWeight: number;
  associations: CausalAssociation[];
}

/**
 * Bounded one-hop causal traversal, BOTH directions (T1-F2: neither adaptive nor MPFP can
 * follow a causal edge backward — inbound is restricted to semantic/entity there, so
 * "why did B happen?" anchored at B could never reach cause A).
 */
function collectCausalOneHop(
  store: Store,
  anchors: SearchResult[],
  base: CandidateEligibility,
  laneActive: boolean,
  timeRange: { start: string; end: string } | undefined,
  perAnchor: number,
  global: number,
): { endpoints: OneHopEndpoint[] } {
  if (anchors.length === 0) return { endpoints: [] };

  const anchorIds: { docId: number; rank: number; docid: string }[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const row = store.db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1 LIMIT 1`).get(anchors[i]!.hash) as { id: number } | undefined;
    if (row) anchorIds.push({ docId: row.id, rank: i, docid: anchors[i]!.docid });
  }
  if (anchorIds.length === 0) return { endpoints: [] };

  // Admission: core (active/invalidated/effective-time) AND (baseEligible OR — lane only —
  // the structural observation predicate). The base group must be composed as ONE parenthesized
  // alternative or the lane's own hits would be filtered straight back out (T2-F2).
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const baseParts: string[] = [];
  if (base.allowCollections && base.allowCollections.length > 0) {
    baseParts.push(`d.collection IN (${base.allowCollections.map(() => "?").join(",")})`);
    params.push(...base.allowCollections);
  }
  if (base.excludeCollections && base.excludeCollections.length > 0) {
    baseParts.push(`d.collection NOT IN (${base.excludeCollections.map(() => "?").join(",")})`);
    params.push(...base.excludeCollections);
  }
  const baseGroup = baseParts.length > 0 ? `(${baseParts.join(" AND ")})` : "1=1";
  const whyGroup = `(d.collection = '_clawmem' AND d.path LIKE 'observations/%' AND d.observation_type IS NOT NULL)`;
  clauses.push(laneActive ? `(${baseGroup} OR ${whyGroup})` : baseGroup);
  clauses.push(`d.active = 1`, `d.invalidated_at IS NULL`, notLegacyArtifactSql("d")); // 62.2: never the legacy artifact
  if (timeRange) {
    clauses.push(`COALESCE(d.authored_at, d.modified_at) >= ? AND COALESCE(d.authored_at, d.modified_at) <= ?`);
    params.push(timeRange.start, timeRange.end);
  }
  const admission = clauses.join(" AND ");

  const idPh = anchorIds.map(() => "?").join(",");
  const idParams = anchorIds.map(a => a.docId);
  const byAnchor = new Map<number, { docId: number; rank: number; docid: string }>();
  for (const a of anchorIds) byAnchor.set(a.docId, a);

  // Outbound: anchor caused neighbor → the neighbor is an EFFECT of the anchor.
  const outbound = store.db.prepare(`
    SELECT r.source_id AS anchorId, r.target_id AS neighborId, r.weight, d.hash AS neighborHash
    FROM memory_relations r JOIN documents d ON d.id = r.target_id
    WHERE r.source_id IN (${idPh}) AND r.relation_type = 'causal' AND r.source_id != r.target_id AND ${admission}
  `).all(...idParams, ...params) as { anchorId: number; neighborId: number; weight: number; neighborHash: string }[];

  // Inbound: neighbor caused anchor → the neighbor is a CAUSE of the anchor.
  const inbound = store.db.prepare(`
    SELECT r.target_id AS anchorId, r.source_id AS neighborId, r.weight, d.hash AS neighborHash
    FROM memory_relations r JOIN documents d ON d.id = r.source_id
    WHERE r.target_id IN (${idPh}) AND r.relation_type = 'causal' AND r.source_id != r.target_id AND ${admission}
  `).all(...idParams, ...params) as { anchorId: number; neighborId: number; weight: number; neighborHash: string }[];

  const raw: OneHopHit[] = [];
  for (const [rows, direction] of [[outbound, "effect"], [inbound, "cause"]] as const) {
    for (const row of rows) {
      const anchor = byAnchor.get(row.anchorId);
      if (!anchor) continue;
      raw.push({ anchorRank: anchor.rank, anchorDocid: anchor.docid, neighborHash: row.neighborHash, weight: row.weight, direction });
    }
  }

  // Breadth bounds (T3-F2), enforced BEFORE the hop list enters RRF: per-anchor cap by weight,
  // then endpoint aggregation, then a global cap over UNIQUE endpoints ordered by (best anchor
  // rank, best weight). Aggregating first stops one endpoint's multiple associations from
  // consuming multiple global slots, and every retained association survives on its endpoint.
  const perAnchorGroups = new Map<number, OneHopHit[]>();
  for (const hit of raw) {
    const list = perAnchorGroups.get(hit.anchorRank) ?? [];
    list.push(hit);
    perAnchorGroups.set(hit.anchorRank, list);
  }
  const capped: OneHopHit[] = [];
  for (const list of perAnchorGroups.values()) {
    list.sort((a, b) => b.weight - a.weight);
    capped.push(...list.slice(0, perAnchor));
  }

  const byEndpoint = new Map<string, OneHopEndpoint>();
  for (const hit of capped) {
    const existing = byEndpoint.get(hit.neighborHash);
    if (existing) {
      existing.bestAnchorRank = Math.min(existing.bestAnchorRank, hit.anchorRank);
      existing.bestWeight = Math.max(existing.bestWeight, hit.weight);
      if (!existing.associations.some(a => a.anchorDocid === hit.anchorDocid && a.direction === hit.direction)) {
        existing.associations.push({ anchorDocid: hit.anchorDocid, direction: hit.direction });
      }
    } else {
      byEndpoint.set(hit.neighborHash, {
        neighborHash: hit.neighborHash,
        bestAnchorRank: hit.anchorRank,
        bestWeight: hit.weight,
        associations: [{ anchorDocid: hit.anchorDocid, direction: hit.direction }],
      });
    }
  }
  const endpoints = [...byEndpoint.values()]
    .sort((a, b) => a.bestAnchorRank - b.bestAnchorRank || b.bestWeight - a.bestWeight)
    .slice(0, global);
  return { endpoints };
}

// =============================================================================
// Pipeline
// =============================================================================

export async function runCausalRetrieval(
  store: Store,
  llm: LLM,
  query: string,
  opts: CausalRetrievalOptions,
): Promise<CausalRetrievalResult> {
  const budgets: CausalBudgets = { ...DEFAULT_CAUSAL_BUDGETS, ...opts.budgets };
  const { stages, baseEligibility, whyObservationLane } = opts;
  const degraded: CausalDegradedLeg[] = [];

  // Step 1: intent classification (+ optional override)
  const intentResult: IntentResult = opts.forceIntent
    ? { intent: opts.forceIntent, confidence: 1.0 }
    : await classifyIntent(query, llm, store.db);
  const intent = intentResult.intent;

  // Step 2: temporal constraint — intent's local dates, else query-extracted (UTC)
  const dateRange = (intentResult.temporal_start && intentResult.temporal_end)
    ? {
        start: intentResult.temporal_start.includes("T") ? intentResult.temporal_start : new Date(intentResult.temporal_start + "T00:00:00").toISOString(),
        end: intentResult.temporal_end.includes("T") ? intentResult.temporal_end : new Date(intentResult.temporal_end + "T23:59:59.999").toISOString(),
      }
    : extractTemporalConstraint(query) || baseEligibility.timeRange || undefined;
  const eligibility: CandidateEligibility = { ...baseEligibility, timeRange: dateRange };
  const laneActive = whyObservationLane && intent === "WHY";

  // Step 3: anchors — named ranked lists (T2-F5): ext-FTS, ext-vec, and (lane) obs-FTS, obs-vec
  const [wB, wV] = intent === "WHEN" ? [1.5, 1.0] : intent === "WHY" ? [1.0, 1.5] : [1.0, 1.0];
  const anchorLists: RankedResult[][] = [];
  const listWeights: number[] = [];

  const extFts = store.searchFTS(query, budgets.anchorLimit, undefined, eligibility.allowCollections, dateRange, eligibility.excludeCollections);
  anchorLists.push(extFts.map(toRanked));
  listWeights.push(wB);

  let extVec: SearchResult[] = [];
  try {
    const det = await store.searchVecDetailed(query, DEFAULT_EMBED_MODEL, budgets.anchorLimit, {
      collections: eligibility.allowCollections,
      excludeCollections: eligibility.excludeCollections,
      dateRange,
    });
    extVec = det.results;
    degraded.push(...anchorEntries("causal:vector", det));
  } catch (e) {
    // v0.43.7 (82.2 D4): a refused QUERY vector is handled before the fatal rethrow — the anchors come from the
    // lexical side only, and the trace records it. Dimension and model errors keep rethrowing.
    if (isRefusedEmbedResponse(e)) degraded.push({ leg: "causal:vector", reason: "vector-fault" });
    else rethrowIfFatalVectorError(e); /* else: no vectors */
  }
  anchorLists.push(extVec.map(toRanked));
  listWeights.push(wV);

  let obsFts: SearchResult[] = [];
  let obsVec: SearchResult[] = [];
  if (laneActive) {
    // The structural observation predicate is applied INSIDE the search SQL (observationsOnly),
    // so obsAnchorK is satisfied with eligible observation documents by construction — a fixed
    // overfetch could be starved by higher-ranked handoffs/deductions.
    obsFts = store.searchFTS(query, budgets.obsAnchorK, undefined, ["_clawmem"], dateRange, undefined, { observationsOnly: true });
    try {
      const det = await store.searchVecDetailed(query, DEFAULT_EMBED_MODEL, budgets.obsAnchorK, { collections: ["_clawmem"], dateRange, observationsOnly: true });
      obsVec = det.results;
      // Before v0.43.7 this lookup recorded nothing; only what is new is recorded: skipped stored vectors.
      if (det.vectorFaults > 0) degraded.push({ leg: "causal:observation-vector", reason: "vector-fault", vectorFaults: det.vectorFaults });
    } catch (e) {
      if (isRefusedEmbedResponse(e)) degraded.push({ leg: "causal:observation-vector", reason: "vector-fault" });
      else rethrowIfFatalVectorError(e); /* else: no vectors */
    }
    if (obsFts.length > 0) { anchorLists.push(obsFts.map(toRanked)); listWeights.push(wB); }
    if (obsVec.length > 0) { anchorLists.push(obsVec.map(toRanked)); listWeights.push(wV); }
  }

  // First fusion over the named anchor lists — supplies the anchor ranks the one-hop step
  // orders by. When the one-hop step contributes, the FINAL fusion re-runs over all named
  // lists PLUS the one-hop list (the fifth named list), preserving per-channel consensus and
  // intent weights rather than collapsing the anchor union into a single vote.
  const anchorFusion = reciprocalRankFusion(anchorLists, listWeights);
  const anchorOriginals = [...extFts, ...extVec, ...obsFts, ...obsVec];
  let fused: SearchResult[] = attachRrfScores(anchorFusion, anchorOriginals);

  // Step 4: bounded one-hop causal step (WHY only). Runs regardless of visibility policy —
  // for unfiltered callers it is pure capability, no visibility change.
  const associations = new Map<string, CausalAssociation[]>();
  if (stages.causalOneHop && intent === "WHY") {
    const { endpoints } = collectCausalOneHop(
      store, fused.slice(0, budgets.seedCount), baseEligibility, laneActive, dateRange,
      budgets.oneHopPerAnchor, budgets.oneHopGlobal,
    );
    if (endpoints.length > 0) {
      const oneHopResults: SearchResult[] = [];
      const oneHopRanked: RankedResult[] = [];
      for (const ep of endpoints) {
        const doc = hydrateByHash(store, ep.neighborHash);
        if (!doc) continue;
        oneHopResults.push(doc);
        oneHopRanked.push(toRanked(doc));
        associations.set(doc.filepath, ep.associations);
      }
      if (oneHopRanked.length > 0) {
        const finalFusion = reciprocalRankFusion([...anchorLists, oneHopRanked], [...listWeights, 1.0]);
        fused = attachRrfScores(finalFusion, [...anchorOriginals, ...oneHopResults]);
      }
    }
  }

  // Step 5: graph expansion (WHY/ENTITY) — adaptive traversal and MPFP admit baseEligibility
  // ONLY, for SEEDS as well as neighbors: lane- and hop-admitted observation documents never
  // seed them, never consume their budgets, and never carry their mass (C4' one-hop fence).
  // Every leg is individually contained: an unavailable embedding service or a failed graph
  // leg degrades to the fused anchors instead of failing the whole retrieval.
  let expanded = fused;
  if ((stages.traversal || stages.mpfp) && (intent === "WHY" || intent === "ENTITY")) {
    let anchorEmbeddingResult: Awaited<ReturnType<LLM["embed"]>> = null;
    try {
      anchorEmbeddingResult = await llm.embed(query);
    } catch (e) {
      /* embedding service down — graph legs skipped, fused anchors retained */
      // v0.43.7 (82.2 D4): a REFUSED query vector skips the graph legs the same way, and is MARKED — before,
      // nothing said that the expansion did not run.
      if (isRefusedEmbedResponse(e)) degraded.push({ leg: "causal:graph", reason: "vector-fault" });
    }
    if (anchorEmbeddingResult) {
      let merged: { hash: string; score: number }[] = fused.map(r => ({ hash: r.hash, score: r.score }));
      // Seeds: collection policy only — every fused entry already passed its search leg's
      // time filter on the true COALESCE axis, and FTS rows don't carry authored_at, so a
      // time re-check here would fail closed on exactly the wrong rows.
      const seedPolicy: CandidateEligibility = { allowCollections: baseEligibility.allowCollections, excludeCollections: baseEligibility.excludeCollections };
      const baseSeeds = fused
        .filter(r => baseAdmissible(r, seedPolicy))
        .slice(0, budgets.seedCount)
        .map(r => ({ hash: r.hash, score: r.score }));

      if (stages.traversal) {
        try {
          const traversed = adaptiveTraversal(store.db, baseSeeds, {
            maxDepth: budgets.traversalDepth,
            beamWidth: budgets.traversalBeam,
            budget: budgets.traversalBudget,
            intent,
            queryEmbedding: anchorEmbeddingResult.embedding,
            eligibility,
          });
          merged = mergeTraversalResults(store.db, merged, traversed);
        } catch { /* traversal leg failed — retain current results */ }
      }

      if (stages.mpfp) {
        try {
          const mpfpNodes = mpfpTraversal(store.db, baseSeeds, intent, budgets.mpfpBudget, eligibility);
          const maxMpfpScore = mpfpNodes.length > 0 ? Math.max(...mpfpNodes.map(n => n.score)) : 1;
          const mpfpNormalizer = maxMpfpScore > 0 ? 1 / maxMpfpScore : 1;
          for (const node of mpfpNodes) {
            const normalizedScore = node.score * mpfpNormalizer;
            const doc = store.db.prepare(`SELECT hash FROM documents WHERE id = ? AND active = 1 AND invalidated_at IS NULL AND ${notLegacyArtifactSql("documents")} LIMIT 1`).get(node.docId) as { hash: string } | undefined;
            if (doc) {
              const existing = merged.find(m => m.hash === doc.hash);
              if (existing) {
                existing.score = Math.max(existing.score, normalizedScore * 0.9);
              } else {
                merged.push({ hash: doc.hash, score: normalizedScore * 0.75 });
              }
            }
          }
        } catch { /* MPFP leg failed — retain current results */ }
      }

      // Entity co-occurrence expansion (ENTITY intent; legacy stage, see module header)
      if (stages.entityExpansion && intent === "ENTITY") {
        try {
          const seedDocIds = baseSeeds.map(s => {
            const row = store.db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1 LIMIT 1`).get(s.hash) as { id: number } | undefined;
            return row?.id;
          }).filter((id): id is number => id !== undefined);
          const entityNeighbors = getEntityGraphNeighbors(store.db, seedDocIds, budgets.entityLimit);
          for (const en of entityNeighbors) {
            const doc = store.db.prepare(`SELECT hash FROM documents WHERE id = ? AND active = 1 AND invalidated_at IS NULL AND ${notLegacyArtifactSql("documents")} LIMIT 1`).get(en.docId) as { hash: string } | undefined;
            if (doc && !merged.some(m => m.hash === doc.hash)) {
              merged.push({ hash: doc.hash, score: en.score * 0.7 });
            }
          }
        } catch { /* entity leg failed — retain current results */ }
      }

      // Hydrate merged results back to SearchResult format. Graph-DISCOVERED nodes (not in
      // fused) are admitted under the FULL base policy — collections AND the effective-time
      // window — never the observation exception, which applies to the anchor lane and one-hop
      // step exclusively (those entries are already in fused).
      const fusedMap = new Map(fused.map(r => [r.hash, r]));
      expanded = merged.map(m => {
        const orig = fusedMap.get(m.hash);
        if (orig) return { ...orig, score: m.score };
        const doc = hydrateByHash(store, m.hash);
        if (!doc) return null;
        if (!baseAdmissible(doc, eligibility, doc.effectiveTime)) return null;
        return { ...doc, score: m.score };
      }).filter((r): r is SearchResult => r !== null);
    }
  }

  // Step 6: rerank top 30 and blend scores (same pattern as the pre-v0.32.0 intent_search)
  if (stages.rerank) {
    const toRerank = expanded.slice(0, 30);
    const rerankDocs = toRerank.map(r => ({ file: r.filepath, text: r.body?.slice(0, 200) || r.title }));
    const reranked = await store.rerank(query, rerankDocs);
    const rerankMap = new Map(reranked.map(r => [r.file, r.score]));
    const rankMap = new Map(toRerank.map((r, i) => [r.filepath, i + 1]));
    const blended = toRerank.map(r => {
      const rerankScore = rerankMap.get(r.filepath) || 0;
      const rank = rankMap.get(r.filepath) || toRerank.length;
      const origWeight = rank <= 3 ? 0.75 : rank <= 10 ? 0.60 : 0.40;
      return { ...r, score: origWeight * r.score + (1 - origWeight) * rerankScore };
    });
    blended.sort((a, b) => b.score - a.score);
    expanded = blended;
  }

  return { intent: intentResult, results: expanded, associations, degraded };
}
