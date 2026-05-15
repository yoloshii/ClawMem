/**
 * ClawMem Memory Module - SAME composite scoring layer
 *
 * Provides recency decay, confidence scoring, and composite scoring
 * that overlays on top of QMD's raw search results.
 */

// =============================================================================
// Content Type Half-Lives (days until score drops to 50%)
// =============================================================================

export const HALF_LIVES: Record<string, number> = {
  handoff: 30,
  progress: 45,
  conversation: 45,
  problem: 60,
  milestone: 60,
  note: 60,
  research: 90,
  project: 120,
  preference: Infinity,
  decision: Infinity,
  deductive: Infinity,
  hub: Infinity,
};

// =============================================================================
// Confidence Baselines by Content Type
// =============================================================================

export const TYPE_BASELINES: Record<string, number> = {
  decision: 0.85,
  deductive: 0.85,
  preference: 0.80,
  hub: 0.80,
  problem: 0.75,
  research: 0.70,
  milestone: 0.70,
  project: 0.65,
  handoff: 0.60,
  conversation: 0.55,
  progress: 0.50,
  note: 0.50,
};

// =============================================================================
// Content Type Inference
// =============================================================================

export type ContentType = "decision" | "deductive" | "preference" | "hub" | "research" | "project" | "handoff" | "conversation" | "progress" | "milestone" | "problem" | "note";

export function inferContentType(path: string, explicitType?: string): ContentType {
  if (explicitType && explicitType in TYPE_BASELINES) return explicitType as ContentType;

  const lower = path.toLowerCase();
  if (lower.includes("decision") || lower.includes("adr/") || lower.includes("adr-")) return "decision";
  if (lower.includes("hub") || lower.includes("moc") || lower.match(/\/index\.md$/)) return "hub";
  if (lower.includes("research") || lower.includes("investigation") || lower.includes("analysis")) return "research";
  if (lower.includes("project") || lower.includes("epic") || lower.includes("initiative")) return "project";
  if (lower.includes("handoff") || lower.includes("handover") || lower.includes("session")) return "handoff";
  if (lower.includes("conversation") || lower.includes("convo") || lower.includes("chat") || lower.includes("transcript")) return "conversation";
  if (lower.includes("progress") || lower.includes("status") || lower.includes("standup") || lower.includes("changelog")) return "progress";
  return "note";
}

// =============================================================================
// Memory Type Classification (E10)
// =============================================================================

export type MemoryType = "episodic" | "semantic" | "procedural";

/**
 * Infer memory type from content metadata.
 * - episodic: session events, handoffs, progress (time-bound)
 * - semantic: facts, decisions, knowledge (declarative)
 * - procedural: how-to, patterns, workflows (actionable)
 */
export function inferMemoryType(path: string, contentType: string, body?: string): MemoryType {
  if (["handoff", "progress", "conversation"].includes(contentType)) return "episodic";
  if (["decision", "deductive", "hub", "research"].includes(contentType)) return "semantic";
  if (body && /\b(step\s+\d|workflow|recipe|how\s+to|procedure|runbook|playbook)\b/i.test(body)) return "procedural";
  if (path.includes("sop") || path.includes("runbook") || path.includes("playbook")) return "procedural";
  if (contentType === "antipattern") return "semantic";
  return "semantic";
}

// =============================================================================
// Recency Score
// =============================================================================

/**
 * Compute effective half-life adjusted by access frequency.
 * Frequently accessed memories decay slower (up to 3x base half-life).
 */
function effectiveHalfLife(
  baseHalfLife: number,
  accessCount: number,
  lastAccessedAt?: Date | string | null,
  now: Date = new Date()
): number {
  if (!isFinite(baseHalfLife) || accessCount <= 0) return baseHalfLife;

  let freshness = 1.0;
  if (lastAccessedAt) {
    const lastAccess = typeof lastAccessedAt === "string" ? new Date(lastAccessedAt) : lastAccessedAt;
    if (!isNaN(lastAccess.getTime())) {
      const daysSinceAccess = (now.getTime() - lastAccess.getTime()) / (1000 * 60 * 60 * 24);
      freshness = Math.max(0, 1 - daysSinceAccess / 90);
    }
  }

  const extension = baseHalfLife * 0.3 * Math.log1p(accessCount * freshness);
  return Math.min(baseHalfLife * 3, baseHalfLife + extension);
}

export function recencyScore(
  modifiedAt: Date | string,
  contentType: string,
  now: Date = new Date(),
  accessCount: number = 0,
  lastAccessedAt?: Date | string | null
): number {
  const baseHalfLife = HALF_LIVES[contentType] ?? 60;
  if (!isFinite(baseHalfLife)) return 1.0;

  const halfLife = effectiveHalfLife(baseHalfLife, accessCount, lastAccessedAt, now);

  const modified = typeof modifiedAt === "string" ? new Date(modifiedAt) : modifiedAt;
  if (isNaN(modified.getTime())) return 0.5;
  const daysSince = (now.getTime() - modified.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 0) return 1.0;
  const result = Math.pow(0.5, daysSince / halfLife);
  return Number.isFinite(result) ? result : 0;
}

// =============================================================================
// Confidence Score
// =============================================================================

export function confidenceScore(
  contentType: string,
  modifiedAt: Date | string,
  accessCount: number,
  now: Date = new Date(),
  lastAccessedAt?: Date | string | null
): number {
  const baseline = TYPE_BASELINES[contentType] ?? 0.5;
  const recency = recencyScore(modifiedAt, contentType, now);
  const safeAccess = Number.isFinite(accessCount) && accessCount >= 0 ? accessCount : 0;
  const accessBoost = Math.min(1.5, 1 + Math.log2(1 + safeAccess) * 0.1);

  // Attention decay: reduce confidence if not accessed recently (5% per week)
  // Only apply to episodic/progress content — skip for durable types (decision, hub, research)
  // Also skip if last_accessed_at was backfilled from modified_at (no real access yet)
  const DECAY_EXEMPT_TYPES = new Set(["decision", "deductive", "hub", "research", "antipattern", "preference"]);
  let attentionDecay = 1.0;
  if (lastAccessedAt && !DECAY_EXEMPT_TYPES.has(contentType)) {
    const lastAccess = typeof lastAccessedAt === "string" ? new Date(lastAccessedAt) : lastAccessedAt;
    const modified = typeof modifiedAt === "string" ? new Date(modifiedAt) : modifiedAt;
    if (!isNaN(lastAccess.getTime())) {
      // Skip decay if last_accessed_at == modified_at (backfilled, no real access)
      const isBackfilled = Math.abs(lastAccess.getTime() - modified.getTime()) < 1000;
      if (!isBackfilled) {
        const daysSinceAccess = (now.getTime() - lastAccess.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceAccess > 0) {
          attentionDecay = Math.max(0.5, Math.pow(0.95, daysSinceAccess / 7));
        }
      }
    }
  }

  const result = Math.min(1.0, baseline * recency * accessBoost * attentionDecay);
  return Number.isFinite(result) ? result : 0;
}

// =============================================================================
// Composite Scoring
// =============================================================================

export type CompositeWeights = {
  search: number;
  recency: number;
  confidence: number;
};

export const DEFAULT_WEIGHTS: CompositeWeights = { search: 0.5, recency: 0.25, confidence: 0.25 };
export const RECENCY_WEIGHTS: CompositeWeights = { search: 0.1, recency: 0.7, confidence: 0.2 };

const RECENCY_PATTERNS = [
  /\brecent(ly)?\b/i,
  /\blast\s+(session|time|week|month|few\s+days)\b/i,
  /\bleft\s+off\b/i,
  /\bwhere\s+(was|were)\s+(we|i)\b/i,
  /\bpick\s+up\b/i,
  /\bcontinue\b/i,
  /\byesterday\b/i,
  /\btoday\b/i,
  /\bwhat\s+(was|were)\s+(we|i)\s+(doing|working)\b/i,
];

export function hasRecencyIntent(query: string): boolean {
  return RECENCY_PATTERNS.some(p => p.test(query));
}

export function compositeScore(
  searchScore: number,
  recency: number,
  confidence: number,
  weights: CompositeWeights = DEFAULT_WEIGHTS
): number {
  // Guard against NaN propagation
  const s = Number.isFinite(searchScore) ? searchScore : 0;
  const r = Number.isFinite(recency) ? recency : 0;
  const c = Number.isFinite(confidence) ? confidence : 0;
  const result = weights.search * s + weights.recency * r + weights.confidence * c;
  return Number.isFinite(result) ? result : 0;
}

// =============================================================================
// Apply Composite Scoring to Search Results
// =============================================================================

export type EnrichedResult = {
  filepath: string;
  displayPath: string;
  title: string;
  score: number;
  body?: string;
  contentType: string;
  modifiedAt: string;
  accessCount: number;
  confidence: number;
  qualityScore: number;
  pinned: boolean;
  context: string | null;
  hash: string;
  docid: string;
  collectionName: string;
  bodyLength: number;
  source: "fts" | "vec";
  chunkPos?: number;
  fragmentType?: string;
  fragmentLabel?: string;
  lastAccessedAt?: string | null;
  // Engram integration: frequency/evolution metadata
  duplicateCount: number;
  revisionCount: number;
};

export type ScoredResult = EnrichedResult & {
  compositeScore: number;
  recencyScore: number;
};

export type CoActivationFn = (path: string) => { path: string; count: number }[];

const STABLE_PROFILE_PATTERNS = [
  /\b(pronouns?|timezone|time\s*zone|location|locale|home\s+base)\b/i,
  /\b(preferences?|prefers?|identity|profile|bio|about\s+me)\b/i,
  /\b(who\s+(am\s+i|is\s+\w+)|what\s+(do\s+i|does\s+\w+)\s+(prefer|use|avoid))\b/i,
];

function hasStableProfileIntent(query: string): boolean {
  return STABLE_PROFILE_PATTERNS.some(p => p.test(query));
}

function canonicalMemoryMultiplier(path: string, contentType: string, query: string): number {
  if (hasRecencyIntent(query) || !hasStableProfileIntent(query)) return 1.0;

  const lower = path.toLowerCase();
  if (/(^|\/)(core\/memory|memory\/core|profile|identity|soul)\.md$/.test(lower)) return 1.14;
  if (/(^|\/)users\/[^/]+\.md$/.test(lower)) return 1.14;
  if (contentType === "preference") return 1.08;
  return 1.0;
}

export function applyCompositeScoring(
  results: EnrichedResult[],
  query: string,
  coActivationFn?: CoActivationFn
): ScoredResult[] {
  const weights = hasRecencyIntent(query) ? RECENCY_WEIGHTS : DEFAULT_WEIGHTS;
  const now = new Date();

  const scored = results.map(r => {
    const recency = recencyScore(r.modifiedAt, r.contentType, now, r.accessCount, r.lastAccessedAt);
    const computed = confidenceScore(r.contentType, r.modifiedAt, r.accessCount, now, r.lastAccessedAt);
    // Blend stored confidence (from contradiction lowering, feedback boosts) with computed.
    // Default stored=0.5 → 100% computed. Stored deviations shift the result proportionally.
    const storedConf = r.confidence ?? 0.5;
    const conf = storedConf === 0.5 ? computed : Math.min(1.0, computed * (storedConf / 0.5) * 0.5 + computed * 0.5);
    const composite = compositeScore(r.score, recency, conf, weights);

    // Quality multiplier: 0.5 default → 1.0x (no effect)
    // Range: 0.0 → 0.7x penalty, 1.0 → 1.3x boost
    const qualityMultiplier = 0.7 + 0.6 * (r.qualityScore ?? 0.5);
    let adjusted = composite * qualityMultiplier;

    // Length normalization: penalize verbose entries that dominate via keyword density
    // anchor=500 chars. At anchor → 1.0x, 1000 → 0.75x, 2000 → 0.57x. Never boosts short docs.
    const lenRatio = Math.log2(Math.max((r.bodyLength || 500) / 500, 1));
    const lenFactor = 1 / (1 + 0.5 * lenRatio);
    adjusted = Math.max(adjusted * 0.3, adjusted * lenFactor);

    // Engram integration: revision durability signal (Phase 3)
    // revision_count is weighted more heavily than duplicate_count (evolution vs noise).
    // Capped at 10% to prevent runaway amplification.
    const revisions = (r.revisionCount || 1) - 1;
    const duplicates = (r.duplicateCount || 1) - 1;
    const freqSignal = revisions * 2 + duplicates; // revisions weighted 2x
    const freqBoost = freqSignal > 0 ? Math.min(0.10, Math.log1p(freqSignal) * 0.03) : 0;
    adjusted *= (1 + freqBoost);

    adjusted *= canonicalMemoryMultiplier(r.displayPath, r.contentType, query);

    // Pin boost: +0.3 additive, capped at 1.0
    if (r.pinned) {
      adjusted = Math.min(1.0, adjusted + 0.3);
    }

    return { ...r, compositeScore: adjusted, recencyScore: recency };
  });

  // Co-activation boost: docs frequently accessed alongside top results get a boost
  if (coActivationFn && scored.length > 1) {
    const topQuartile = Math.max(1, Math.floor(scored.length * 0.25));
    // Co-activations are recorded using displayPath format (collection/path),
    // but scored results use filepath format (clawmem://collection/path).
    // Normalize: strip clawmem:// prefix for lookup, match back via both formats.
    const stripPrefix = (p: string) => p.startsWith("clawmem://") ? p.slice(10) : p;
    const topDisplayPaths = new Set(scored.slice(0, topQuartile).map(r => stripPrefix(r.filepath)));
    const coActivatedCounts = new Map<string, number>();

    for (const topPath of topDisplayPaths) {
      const partners = coActivationFn(topPath);
      for (const p of partners) {
        if (!topDisplayPaths.has(p.path)) {
          coActivatedCounts.set(p.path, (coActivatedCounts.get(p.path) || 0) + p.count);
        }
      }
    }

    if (coActivatedCounts.size > 0) {
      for (const r of scored) {
        const coCount = coActivatedCounts.get(stripPrefix(r.filepath));
        if (coCount) {
          // Boost capped at 15% to prevent runaway amplification
          r.compositeScore *= 1 + Math.min(coCount / 10, 0.15);
        }
      }
    }
  }

  // Sort by composite score descending
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  // Boost handoff/decision types when recency intent detected
  if (hasRecencyIntent(query)) {
    const priority = new Set<string>(["handoff", "decision", "progress"]);
    scored.sort((a, b) => {
      const aPriority = priority.has(a.contentType) ? 1 : 0;
      const bPriority = priority.has(b.contentType) ? 1 : 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return b.compositeScore - a.compositeScore;
    });
  }

  return scored;
}
