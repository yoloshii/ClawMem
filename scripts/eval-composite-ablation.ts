/**
 * Read-only composite-multiplier ablation harness (BACKLOG Source 48.1/48.2).
 *
 * Mirrors the MCP direct vsearch pipeline verbatim — searchVecDetailed (with the
 * production `_clawmem` exclusion) → enrichResults → composite scoring → minScore —
 * then re-scores the SAME per-query candidate pool under toggled configurations to
 * attribute ranking damage to individual stages:
 *
 *   weights mix        DEFAULT (0.5/0.25/0.25) vs QUERY_WEIGHTS (0.7/0.15/0.15) vs search-only
 *   length norm        1/(1+0.5·log2(len/500)), floor 0.3x
 *   quality multiplier 0.7 + 0.6·qualityScore (0.7x–1.3x)
 *   co-activation      ≤ +15%, seeded from the pre-sort top quartile
 *   freq boost         ≤ +10% from revision/duplicate counts
 *
 * The local re-implementation is VALIDATED per query against the real
 * applyCompositeScoring (production flags, shared clock) and the run aborts on any
 * drift > 1e-9 — the ablation numbers can never come from a stale formula copy.
 *
 * Usage:
 *   bun scripts/eval-composite-ablation.ts --queries eval-queries.local.json \
 *     [--db PATH] [--pool 10] [--minScore 0.3] [--verbose]
 *
 * queries JSON: [{ "query": "...", "target": "displayPath substring" | null }, ...]
 * (target null = control row: no relevant doc exists; top-1 score is reported as
 *  false-positive pressure instead of rank metrics.)
 *
 * Writes nothing: read-only store, no access recording, no co-activation writes.
 */
import { parseArgs } from "util";
import { readFileSync } from "fs";
import { createStore, DEFAULT_EMBED_MODEL } from "../src/store.ts";
import { enrichResults } from "../src/search-utils.ts";
import {
  applyCompositeScoring,
  compositeScore,
  recencyScore,
  confidenceScore,
  hasRecencyIntent,
  DEFAULT_WEIGHTS,
  QUERY_WEIGHTS,
  RECENCY_WEIGHTS,
  type EnrichedResult,
  type CompositeWeights,
  type CoActivationFn,
} from "../src/memory.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    queries: { type: "string" },
    db: { type: "string" },
    pool: { type: "string", default: "10" },
    minScore: { type: "string", default: "0.3" },
    verbose: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.queries) {
  console.error("Usage: bun scripts/eval-composite-ablation.ts --queries eval-queries.local.json [--db PATH] [--pool 10] [--minScore 0.3] [--verbose]");
  process.exit(2);
}

type EvalCase = { query: string; target: string | null; note?: string };
const cases = JSON.parse(readFileSync(values.queries, "utf8")) as EvalCase[];
const pool = parseInt(values.pool || "10", 10);
const minScore = parseFloat(values.minScore || "0.3");
const store = createStore(values.db || undefined, { readonly: true });

// ---------------------------------------------------------------------------
// Faithful re-implementation of applyCompositeScoring with per-stage toggles.
// Validated against the real function below — do not "improve" it here.
// ---------------------------------------------------------------------------
type Toggles = {
  weights?: CompositeWeights; // undefined => production default resolution
  quality: boolean;
  lenNorm: boolean;
  freq: boolean;
  canonical: boolean;
  pin: boolean;
  coActivation: boolean;
  rawSimilarity?: boolean; // rank by r.score only, skip everything
};

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

function scoreWithToggles(
  results: EnrichedResult[],
  query: string,
  coActivationFn: CoActivationFn | undefined,
  now: Date,
  t: Toggles
): (EnrichedResult & { compositeScore: number })[] {
  if (t.rawSimilarity) {
    return results.map(r => ({ ...r, compositeScore: r.score })).sort((a, b) => b.compositeScore - a.compositeScore);
  }
  const recencyIntent = hasRecencyIntent(query);
  const weights = recencyIntent ? RECENCY_WEIGHTS : (t.weights ?? DEFAULT_WEIGHTS);

  const scored = results.map(r => {
    const recency = recencyScore(r.modifiedAt, r.contentType, now, r.accessCount, r.lastAccessedAt);
    const computed = confidenceScore(r.contentType, r.modifiedAt, r.accessCount, now, r.lastAccessedAt);
    const storedConf = r.confidence ?? 0.5;
    const conf = storedConf === 0.5 ? computed : Math.min(1.0, computed * (storedConf / 0.5) * 0.5 + computed * 0.5);
    const composite = compositeScore(r.score, recency, conf, weights);

    let adjusted = composite;
    if (t.quality) adjusted *= 0.7 + 0.6 * (r.qualityScore ?? 0.5);
    if (t.lenNorm) {
      const lenRatio = Math.log2(Math.max((r.bodyLength || 500) / 500, 1));
      const lenFactor = 1 / (1 + 0.5 * lenRatio);
      adjusted = Math.max(adjusted * 0.3, adjusted * lenFactor);
    }
    if (t.freq) {
      const revisions = (r.revisionCount || 1) - 1;
      const duplicates = (r.duplicateCount || 1) - 1;
      const freqSignal = revisions * 2 + duplicates;
      const freqBoost = freqSignal > 0 ? Math.min(0.10, Math.log1p(freqSignal) * 0.03) : 0;
      adjusted *= 1 + freqBoost;
    }
    if (t.canonical) adjusted *= canonicalMemoryMultiplier(r.displayPath, r.contentType, query);
    if (t.pin && r.pinned) adjusted = Math.min(1.0, adjusted + 0.3);
    return { ...r, compositeScore: adjusted };
  });

  // Co-activation seeds from the PRE-SORT top quartile (input = similarity order),
  // exactly as applyCompositeScoring does.
  if (t.coActivation && coActivationFn && scored.length > 1) {
    const topQuartile = Math.max(1, Math.floor(scored.length * 0.25));
    const stripPrefix = (p: string) => (p.startsWith("clawmem://") ? p.slice(10) : p);
    const topDisplayPaths = new Set(scored.slice(0, topQuartile).map(r => stripPrefix(r.filepath)));
    const coActivatedCounts = new Map<string, number>();
    for (const topPath of topDisplayPaths) {
      for (const p of coActivationFn(topPath)) {
        if (!topDisplayPaths.has(p.path)) coActivatedCounts.set(p.path, (coActivatedCounts.get(p.path) || 0) + p.count);
      }
    }
    if (coActivatedCounts.size > 0) {
      for (const r of scored) {
        const coCount = coActivatedCounts.get(stripPrefix(r.filepath));
        if (coCount) r.compositeScore *= 1 + Math.min(coCount / 10, 0.15);
      }
    }
  }

  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  if (hasRecencyIntent(query)) {
    const priority = new Set<string>(["handoff", "decision", "progress"]);
    scored.sort((a, b) => {
      const aP = priority.has(a.contentType) ? 1 : 0;
      const bP = priority.has(b.contentType) ? 1 : 0;
      if (aP !== bP) return bP - aP;
      return b.compositeScore - a.compositeScore;
    });
  }
  return scored;
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------
const ALL_ON = { quality: true, lenNorm: true, freq: true, canonical: true, pin: true, coActivation: true };
const CONFIGS: { name: string; t: Toggles }[] = [
  { name: "prod", t: { ...ALL_ON } },
  { name: "rawSim", t: { ...ALL_ON, rawSimilarity: true } },
  { name: "w-tuned", t: { ...ALL_ON, weights: QUERY_WEIGHTS } },
  { name: "w-searchOnly", t: { ...ALL_ON, weights: { search: 1, recency: 0, confidence: 0 } } },
  { name: "prod-noLen", t: { ...ALL_ON, lenNorm: false } },
  { name: "prod-noQual", t: { ...ALL_ON, quality: false } },
  { name: "prod-noCo", t: { ...ALL_ON, coActivation: false } },
  { name: "prod-noFreq", t: { ...ALL_ON, freq: false } },
  { name: "tuned-noLen", t: { ...ALL_ON, weights: QUERY_WEIGHTS, lenNorm: false } },
  { name: "tuned-noLenQual", t: { ...ALL_ON, weights: QUERY_WEIGHTS, lenNorm: false, quality: false } },
];

type Agg = { hit1: number; hit5: number; mrr: number; ranks: number[]; belowMin: number; missing: number };
const agg: Record<string, Agg> = {};
for (const c of CONFIGS) agg[c.name] = { hit1: 0, hit5: 0, mrr: 0, ranks: [], belowMin: 0, missing: 0 };
const controlTop: Record<string, { path: string; score: number } | null> = {};
let targeted = 0;
let poolMisses = 0;

const coFn: CoActivationFn = (path: string) => store.getCoActivated(path);
const now = new Date();

for (const evalCase of cases) {
  const det = await store.searchVecDetailed(evalCase.query, DEFAULT_EMBED_MODEL, pool, { excludeCollections: ["_clawmem"] });
  const enriched = enrichResults(store, det.results, evalCase.query);

  // Fidelity gate: replica(prod flags) must equal the real production function.
  const real = applyCompositeScoring(enriched, evalCase.query, coFn, { now });
  const replica = scoreWithToggles(enriched, evalCase.query, coFn, now, { ...ALL_ON });
  for (let i = 0; i < real.length; i++) {
    const a = real[i]!;
    const b = replica[i]!;
    if (a.displayPath !== b.displayPath || Math.abs(a.compositeScore - b.compositeScore) > 1e-9) {
      console.error(`REPLICA DRIFT on "${evalCase.query.slice(0, 50)}" at #${i + 1}: real ${a.displayPath}@${a.compositeScore} vs replica ${b.displayPath}@${b.compositeScore}`);
      console.error("Ablation numbers would be untrustworthy — fix the replica before measuring.");
      process.exit(1);
    }
  }

  if (evalCase.target === null) {
    for (const c of CONFIGS) {
      const scored = scoreWithToggles(enriched, evalCase.query, coFn, now, c.t);
      const survivors = c.t.rawSimilarity ? scored : scored.filter(r => r.compositeScore >= minScore);
      controlTop[c.name] = survivors.length > 0 ? { path: survivors[0]!.displayPath, score: survivors[0]!.compositeScore } : null;
    }
    continue;
  }

  targeted++;
  const inPool = enriched.some(r => r.displayPath.includes(evalCase.target!));
  if (!inPool) {
    poolMisses++;
    for (const c of CONFIGS) agg[c.name]!.missing++;
    if (values.verbose) console.log(`POOL MISS (raw top-${pool}): "${evalCase.query.slice(0, 60)}" → ${evalCase.target}`);
    continue;
  }

  for (const c of CONFIGS) {
    const scored = scoreWithToggles(enriched, evalCase.query, coFn, now, c.t);
    const idx = scored.findIndex(r => r.displayPath.includes(evalCase.target!));
    const rank = idx + 1;
    const a = agg[c.name]!;
    a.ranks.push(rank);
    if (rank === 1) a.hit1++;
    if (rank <= 5) a.hit5++;
    a.mrr += 1 / rank;
    if (!c.t.rawSimilarity && scored[idx]!.compositeScore < minScore) a.belowMin++;
    if (values.verbose && (evalCase.note?.startsWith("incident") ?? false) && ["prod", "rawSim", "tuned-noLenQual"].includes(c.name)) {
      console.log(`\n[${c.name}] "${evalCase.query.slice(0, 60)}" (target rank ${rank}):`);
      for (const r of scored.slice(0, 5)) console.log(`   ${r.compositeScore.toFixed(3)}  ${r.displayPath.slice(0, 90)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\nComposite ablation — pool=${pool} (production default 10), minScore=${minScore}, targeted queries=${targeted}, raw-pool misses=${poolMisses}`);
console.log(`(pool misses are un-savable by ANY composite config — the target never reached the candidate pool)\n`);
const header = ["config", "hit@1", "hit@5", "MRR", "meanRank", "<minScore"];
console.log(header.map(h => h.padEnd(16)).join(""));
for (const c of CONFIGS) {
  const a = agg[c.name]!;
  const n = a.ranks.length || 1;
  const meanRank = a.ranks.length ? (a.ranks.reduce((x, y) => x + y, 0) / a.ranks.length).toFixed(2) : "-";
  const mrr = a.ranks.length ? (a.mrr / n).toFixed(3) : "-";
  const scoredN = targeted - a.missing;
  console.log(
    c.name.padEnd(16) +
    `${a.hit1}/${scoredN}`.padEnd(16) +
    `${a.hit5}/${scoredN}`.padEnd(16) +
    String(mrr).padEnd(16) +
    String(meanRank).padEnd(16) +
    (c.t.rawSimilarity ? "n/a" : `${a.belowMin}/${scoredN}`)
  );
}
console.log(`\nControl query top-1 after minScore (false-positive pressure; null = nothing survived):`);
for (const c of CONFIGS) {
  const t = controlTop[c.name];
  console.log(`  ${c.name.padEnd(16)} ${t ? `${t.score.toFixed(3)}  ${t.path.slice(0, 80)}` : "(none)"}`);
}
store.close?.();
