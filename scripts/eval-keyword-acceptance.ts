/**
 * S49.2 judged keyword eval (S49-JUDGED-EVAL-DESIGN.md Part A) — FTS-only, read-only,
 * deterministic freeze bundle. No llm.ts import: runs with zero GPU/services.
 *
 *   freeze — VACUUM INTO snapshot + one asOf; per case freeze pool-10 (the `search`
 *            handler's candidate pool) and pool-20 (the `query` pipeline's initialFts
 *            mirror: dateRange = extractTemporalConstraint(query), excl _clawmem);
 *            validate recency labels against selectScoringRegime, discovery targets
 *            in-pool, and objective shape labels (exact-old / fresh-among-many) with
 *            recorded shapeEvidence; freeze recency arm-A baselines with { now: asOf }.
 *   run    — bundle-integrity re-execution; fixture cardinalities (23/20/≥3/≥4 and
 *            shape floors ≥8/≥8 combined, ≥3/≥3 held-out); compute Arm A (shipped
 *            composite, mcp.ts search handler mirror) and Arm B (rankRawPrimary) from
 *            the SAME frozen pool-10; recency identity both arms; per-arm control
 *            checks; paired metrics + shape slices; apply the PREDECLARED E5 rule →
 *            SWITCH/KEEP verdict; emit the E6 bypass-firing report from pool-20.
 *
 * Exit codes: 0 verdict produced · 1 fixture/integrity failure · 2 infra abort.
 */
import { parseArgs } from "util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore, tokenizeForFTS5, type Store, type SearchResult } from "../src/store.ts";
import { enrichResults, hasStrongFtsSignal } from "../src/search-utils.ts";
import { applyCompositeScoring, type CoActivationFn, type ScoredResult } from "../src/memory.ts";
import { selectScoringRegime, rankRawPrimary } from "../src/scoring-regime.ts";
import { extractTemporalConstraint } from "../src/intent.ts";
import { proximityRerankDetailed, type ProximityOutcome } from "./proximity.ts";

const POOL_SEARCH = 10; // mcp.ts `search` handler default (limit || 10)
const POOL_PIPELINE = 20; // mcp.ts:741 query-pipeline initialFts depth
const EXCL = ["_clawmem"]; // resolveExcludedCollections default on both surfaces
const CARD = { discTargets: 23, holdTargets: 20, recencyMin: 3, controlsMin: 4, shapeEachMin: 8, shapeHoldoutEachMin: 3 };
const E5 = { switchMargin: 0.10, holdFloorHit1: 12, holdFloorHit5: 17, holdFloorMrr: 0.75 };

// ---------------------------------------------------------------------------
// §51.6 proximity experiment (s516-prereg.md v5 — pre-registered protocol taken
// through a cross-model adversarial design pass to zero findings, 2026-07-18)
// Pre-registered constants — frozen BEFORE unblinding; do not tune.
// ---------------------------------------------------------------------------
/** §4 frozen eligible ID list (run invariant I5): multi-word targets, 19 discovery + 11 held-out. */
const S516_ELIGIBLE = new Set([
  "disc-2", "disc-3", "disc-4", "disc-6", "disc-7", "disc-8", "disc-10", "disc-11", "disc-12", "disc-13",
  "disc-14", "disc-15", "disc-16", "disc-17", "disc-18", "disc-19", "disc-20", "disc-21", "disc-22",
  "hold-1", "hold-5", "hold-8", "hold-12", "hold-13", "hold-14", "hold-15", "hold-16", "hold-17", "hold-18", "hold-19",
]);
/** §7 gates + §6/I6 identity chain. COLD_PROBE_ID: G7c designated by ID (T4 LOW-2). */
const S516 = {
  g1MarginMrr: 0.05, g6aBoundary: 5, g6bMaxDrop: 2,
  g7P95Ms: 20, g7WorstMs: 50, g7ColdMs: 50, g7Reps: 5,
  coldProbeId: "disc-2",
  eligibleDisc: 19, eligibleHold: 11,
  manifestSha: "58b860a51dff050287b3428e7858626b7fe4b7467c170c872bd870dfa2b25260",
  snapshotSha: "b55846d127daf73ee272d74867f75e1f5b995b5aec6a10958bc7bda6c131e72b",
  controlSha: "596d35f3c0b2db079d44196f726b54c39cf87be27f6abbe686ddb61c2d7805ce",
  controlPath: join(import.meta.dir, "..", ".codex-review", "s516-control-run-prechange.txt"),
  activeDocs: 5100,
};

type Shape = "exact-old" | "fresh-among-many" | "neutral";
type Case = {
  id: string;
  set: "discovery" | "holdout";
  kind: "target" | "control" | "recency";
  query: string;
  targets: string[] | null;
  shape?: Shape;
};
type FrozenPoolRow = { path: string; score: number };
type FrozenCase = Case & {
  pool10: FrozenPoolRow[];
  pool20: FrozenPoolRow[];
  dateRange: { start: string; end: string } | null;
  shapeEvidence?: { poolMedianDate: string; targetDate: string; poolMatchCount: number };
  recencyBaseline?: FrozenPoolRow[];
};
type Manifest = { asOf: string; snapshot: string; cases: FrozenCase[] };

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" }, bundle: { type: "string" },
    queries: { type: "string" }, holdout: { type: "string" },
  },
  allowPositionals: true,
});
const cmd = positionals[0];
if (!values.bundle || (cmd !== "freeze" && cmd !== "run")) {
  console.error("Usage: bun scripts/eval-keyword-acceptance.ts freeze --db <live.sqlite> --bundle <dir> --queries <file> --holdout <file>");
  console.error("       bun scripts/eval-keyword-acceptance.ts run --bundle <dir>");
  process.exit(2);
}
const bundleDir = values.bundle;
const manifestPath = join(bundleDir, "manifest.json");
const snapshotPath = join(bundleDir, "snapshot.sqlite");

function loadCases(): Case[] {
  const cases: Case[] = [];
  const disc = JSON.parse(readFileSync(values.queries!, "utf8")) as
    { query: string; target: string | null; kind?: "recency"; shape?: Shape; note?: string }[];
  disc.forEach((c, i) => cases.push({
    id: `disc-${i}`, set: "discovery",
    kind: c.kind === "recency" ? "recency" : c.target === null ? "control" : "target",
    query: c.query, targets: c.target === null ? null : [c.target], shape: c.shape,
  }));
  const hold = JSON.parse(readFileSync(values.holdout!, "utf8")) as
    { cases: { kind: Case["kind"]; query: string; targets: string[] | null; shape?: Shape }[] };
  hold.cases.forEach((c, i) => cases.push({ id: `hold-${i}`, set: "holdout", kind: c.kind, query: c.query, targets: c.targets, shape: c.shape }));
  return cases;
}

function poolFor(store: Store, query: string, depth: number, dateRange?: { start: string; end: string }): SearchResult[] {
  return store.searchFTS(query, depth, undefined, undefined, dateRange, EXCL);
}
const toRows = (rs: { displayPath: string; score?: number; compositeScore?: number }[]): FrozenPoolRow[] =>
  rs.map(r => ({ path: r.displayPath, score: Math.round(((r.compositeScore ?? r.score)!) * 1e6) / 1e6 }));

/** Arm A — the shipped `search` handler, verbatim (mcp.ts:585-590) with { now } injected. */
function armA(store: Store, pool: SearchResult[], query: string, now: Date): FrozenPoolRow[] {
  const coFn: CoActivationFn = (p: string) => store.getCoActivated(p);
  const scored = applyCompositeScoring(enrichResults(store, pool, query), query, coFn, { now })
    .filter(r => r.compositeScore >= 0); // handler's default-minScore filter (no-op: composite >= 0)
  return toRows(scored.map(r => ({ displayPath: r.displayPath, compositeScore: r.compositeScore })));
}
/** Arm B (full rows) — rankRawPrimary over the same enriched pool; the §51.6 B→P
 *  bridge derives BOTH arms from this single invocation (s516-prereg.md §5). */
function armBFull(store: Store, pool: SearchResult[], query: string, now: Date): ScoredResult[] {
  const coFn: CoActivationFn = (p: string) => store.getCoActivated(p);
  return rankRawPrimary(enrichResults(store, pool, query), query, coFn, { now });
}
/** Arm B — raw-FTS-primary candidate: rankRawPrimary over the same enriched pool. */
function armB(store: Store, pool: SearchResult[], query: string, now: Date): FrozenPoolRow[] {
  return toRows(armBFull(store, pool, query, now).map(r => ({ displayPath: r.displayPath, compositeScore: r.compositeScore })));
}

/**
 * Objective shape predicates (design E2, T26 MEDIUM-3 determinism rules):
 * evaluated on the PRIMARY target (targets[0]) only; verbatim = full normalized
 * query as one contiguous substring of title+body (lowercase, whitespace collapsed).
 */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
function computeShape(pool10: SearchResult[], targets: string[], query: string):
  { shape: Shape; evidence: { poolMedianDate: string; targetDate: string; poolMatchCount: number } } | null {
  const primary = targets[0]!;
  const t = pool10.find(r => r.displayPath.includes(primary));
  if (!t) return null;
  const dates = pool10.map(r => r.modifiedAt || "").sort();
  const median = dates[Math.floor((dates.length - 1) / 2)]!;
  const targetDate = t.modifiedAt || "";
  const verbatim = norm((t.title || "") + "\n" + (t.body || "")).includes(norm(query));
  let shape: Shape = "neutral";
  if (targetDate <= median && verbatim) shape = "exact-old";
  else if (pool10.length >= 3 && targetDate > median) shape = "fresh-among-many";
  return { shape, evidence: { poolMedianDate: median, targetDate, poolMatchCount: pool10.length } };
}

function rankOf(rows: FrozenPoolRow[], targets: string[] | null): number | null {
  if (!targets) return null;
  const idx = rows.findIndex(r => targets.some(t => r.path.includes(t)));
  return idx >= 0 ? idx + 1 : null;
}

// ---------------------------------------------------------------------------
// freeze
// ---------------------------------------------------------------------------
if (cmd === "freeze") {
  if (!values.db || !values.queries || !values.holdout) { console.error("freeze needs --db --queries --holdout"); process.exit(2); }
  mkdirSync(bundleDir, { recursive: true });
  if (existsSync(snapshotPath)) { console.error(`refusing to overwrite existing snapshot at ${snapshotPath}`); process.exit(2); }
  console.log(`Snapshotting ${values.db} → ${snapshotPath} ...`);
  const live = new Database(values.db, { readonly: true });
  live.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  live.close();
  const walConvert = new Database(snapshotPath);
  walConvert.exec("PRAGMA journal_mode = WAL");
  walConvert.close();

  const asOf = new Date().toISOString();
  const store = createStore(snapshotPath, { readonly: true });
  const cases = loadCases();
  const frozen: FrozenCase[] = [];
  let aborts = 0;
  const shapeCounts = { combined: { "exact-old": 0, "fresh-among-many": 0 } as Record<string, number>, holdout: { "exact-old": 0, "fresh-among-many": 0 } as Record<string, number> };

  for (const c of cases) {
    const regime = selectScoringRegime(c.query);
    if (c.kind === "recency" && regime !== "recency-composite") { console.error(`MISLABELED ${c.id}: kind=recency but no recency intent — "${c.query}"`); aborts++; continue; }
    if (c.kind !== "recency" && regime === "recency-composite") { console.error(`MISLABELED ${c.id}: kind=${c.kind} but query triggers recency intent — "${c.query}"`); aborts++; continue; }

    const dateRange = extractTemporalConstraint(c.query); // production pipeline pre-step (mcp.ts:733-734)
    const pool10 = poolFor(store, c.query, POOL_SEARCH);
    const pool20 = poolFor(store, c.query, POOL_PIPELINE, dateRange || undefined);
    const fc: FrozenCase = { ...c, pool10: toRows(pool10), pool20: toRows(pool20), dateRange };

    if (c.kind === "target") {
      if (c.set === "discovery" && rankOf(fc.pool10, c.targets) === null) {
        console.error(`IN-POOL FAIL ${c.id}: discovery target not in pool-10 — fix or drop the case ("${c.query}")`); aborts++; continue;
      }
      const sh = computeShape(pool10, c.targets!, c.query);
      if (c.set === "discovery" && !sh) { console.error(`SHAPE FAIL ${c.id}: PRIMARY target (targets[0]) not in pool-10 — shape unverifiable`); aborts++; continue; }
      if (!sh && c.shape && c.shape !== "neutral") { console.error(`SHAPE FAIL ${c.id}: declared non-neutral shape but primary target not in pool-10 (unverifiable label)`); aborts++; continue; }
      if (sh) {
        if (!c.shape) { console.error(`SHAPE FAIL ${c.id}: target case missing declared shape label`); aborts++; continue; }
        if (c.shape !== sh.shape) { console.error(`SHAPE MISMATCH ${c.id}: declared "${c.shape}" but objective predicates say "${sh.shape}" (median=${sh.evidence.poolMedianDate}, target=${sh.evidence.targetDate}, n=${sh.evidence.poolMatchCount})`); aborts++; continue; }
        fc.shapeEvidence = sh.evidence;
        if (sh.shape !== "neutral") {
          shapeCounts.combined[sh.shape]!++;
          if (c.set === "holdout") shapeCounts.holdout[sh.shape]!++;
        }
      }
    }
    if (c.kind === "recency") fc.recencyBaseline = armA(store, pool10, c.query, new Date(asOf));
    frozen.push(fc);
    console.log(`froze ${fc.id} (${fc.kind}${fc.shape ? "/" + fc.shape : ""}) pool10=${fc.pool10.length} pool20=${fc.pool20.length}${fc.dateRange ? " dateRange!" : ""}`);
  }

  if (shapeCounts.combined["exact-old"]! < CARD.shapeEachMin || shapeCounts.combined["fresh-among-many"]! < CARD.shapeEachMin) {
    console.error(`SHAPE FLOOR FAIL: combined exact-old=${shapeCounts.combined["exact-old"]}, fresh-among-many=${shapeCounts.combined["fresh-among-many"]} (need ≥${CARD.shapeEachMin} each)`); aborts++;
  }
  if (shapeCounts.holdout["exact-old"]! < CARD.shapeHoldoutEachMin || shapeCounts.holdout["fresh-among-many"]! < CARD.shapeHoldoutEachMin) {
    console.error(`SHAPE FLOOR FAIL: holdout exact-old=${shapeCounts.holdout["exact-old"]}, fresh-among-many=${shapeCounts.holdout["fresh-among-many"]} (need ≥${CARD.shapeHoldoutEachMin} each)`); aborts++;
  }
  if (aborts > 0) { console.error(`\nFREEZE ABORTED: ${aborts} case defect(s) — fix the set and re-freeze (delete the bundle dir first).`); process.exit(2); }

  writeFileSync(manifestPath, JSON.stringify({ asOf, snapshot: "snapshot.sqlite", cases: frozen } satisfies Manifest, null, 1));
  console.log(`\nBundle frozen: ${frozen.length} cases, asOf=${asOf}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const store = createStore(join(bundleDir, manifest.snapshot), { readonly: true });
const asOf = new Date(manifest.asOf);
let failures = 0;
const fail = (msg: string) => { failures++; console.error(`FAIL: ${msg}`); };

// §51.6 I6 — run-side bundle identity enforcement (T2 HIGH-1): the FULL digest
// chain must hold BEFORE any arm executes; a content mutation without an FTS
// rebuild could leave frozen pools intact while corrupting scratch-oracle
// buckets, so the text-level I4 diff alone is insufficient.
async function s516Sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}
{
  const mSha = await s516Sha256(manifestPath);
  if (mSha !== S516.manifestSha) fail(`§51.6 I6: manifest sha256 ${mSha} != pinned ${S516.manifestSha}`);
  const sSha = await s516Sha256(join(bundleDir, manifest.snapshot));
  if (sSha !== S516.snapshotSha) fail(`§51.6 I6: migrated snapshot sha256 ${sSha} != pinned ${S516.snapshotSha}`);
  // Digest mismatch = wrong bundle entirely — the schema probes below would be
  // meaningless (and may not even parse on a pre-migration snapshot).
  if (failures > 0) { console.error(`\nEVAL INVALID: §51.6 I6 identity chain broken — no arm executed, no unblinding.`); process.exit(1); }
  const active = (store.db.prepare(`SELECT COUNT(*) as n FROM documents WHERE active = 1`).get() as { n: number }).n;
  if (active !== S516.activeDocs) fail(`§51.6 I6: active docs ${active} != ${S516.activeDocs}`);
  const dated = (store.db.prepare(`SELECT COUNT(*) as n FROM documents WHERE authored_at IS NOT NULL`).get() as { n: number }).n;
  if (dated !== 0) fail(`§51.6 I6: ${dated} non-NULL authored_at rows (must be 0)`);
  if (!existsSync(S516.controlPath)) fail(`§51.6 I6: control artifact missing at ${S516.controlPath}`);
  else {
    const cSha = await s516Sha256(S516.controlPath);
    if (cSha !== S516.controlSha) fail(`§51.6 I6: control artifact sha256 ${cSha} != pinned ${S516.controlSha}`);
  }
  if (failures > 0) { console.error(`\nEVAL INVALID: §51.6 I6 identity chain broken — no arm executed, no unblinding.`); process.exit(1); }
}

// Fixture cardinalities (predeclared; a thinned manifest must not pass a weakened gate).
const counts = {
  discTargets: manifest.cases.filter(c => c.set === "discovery" && c.kind === "target").length,
  holdTargets: manifest.cases.filter(c => c.set === "holdout" && c.kind === "target").length,
  recency: manifest.cases.filter(c => c.kind === "recency").length,
  controls: manifest.cases.filter(c => c.kind === "control").length,
  shapeCombined: { "exact-old": 0, "fresh-among-many": 0 } as Record<string, number>,
  shapeHoldout: { "exact-old": 0, "fresh-among-many": 0 } as Record<string, number>,
};
for (const c of manifest.cases.filter(c => c.kind === "target" && c.shape && c.shape !== "neutral")) {
  counts.shapeCombined[c.shape!]!++;
  if (c.set === "holdout") counts.shapeHoldout[c.shape!]!++;
}
if (counts.discTargets !== CARD.discTargets) fail(`fixture: discovery targets ${counts.discTargets} != ${CARD.discTargets}`);
if (counts.holdTargets !== CARD.holdTargets) fail(`fixture: held-out targets ${counts.holdTargets} != ${CARD.holdTargets}`);
if (counts.recency < CARD.recencyMin) fail(`fixture: recency cases ${counts.recency} < ${CARD.recencyMin}`);
if (counts.controls < CARD.controlsMin) fail(`fixture: controls ${counts.controls} < ${CARD.controlsMin}`);
if (counts.shapeCombined["exact-old"]! < CARD.shapeEachMin || counts.shapeCombined["fresh-among-many"]! < CARD.shapeEachMin)
  fail(`fixture: combined shapes ${JSON.stringify(counts.shapeCombined)} below ≥${CARD.shapeEachMin} each`);
if (counts.shapeHoldout["exact-old"]! < CARD.shapeHoldoutEachMin || counts.shapeHoldout["fresh-among-many"]! < CARD.shapeHoldoutEachMin)
  fail(`fixture: holdout shapes ${JSON.stringify(counts.shapeHoldout)} below ≥${CARD.shapeHoldoutEachMin} each`);

type Row = {
  id: string; set: string; query: string; shape?: Shape; rankA: number | null; rankB: number | null;
  rankP: number | null; eligible: boolean; pSame: boolean; pBuckets: string;
};
const targetRows: Row[] = [];
const controlTopA: { id: string; path: string; pinned: boolean }[] = [];
const controlTopB: { id: string; path: string; pinned: boolean }[] = [];
const controlTopP: { id: string; path: string; pinned: boolean }[] = [];
// §51.6 run state: G7 latency samples + the designated cold probe (G7c).
const s516G7: { id: string; medianMs: number; bytes: number }[] = [];
let s516ColdMs: number | null = null;
let s516OracleTouched = false;
const s516RssBefore = process.memoryUsage().rss;
type FireRow = { id: string; kind: string; fired: boolean; top?: string; topScore?: number; gap?: number; topIsTarget?: boolean; singleton: boolean };
const fireRows: FireRow[] = [];

for (const fc of manifest.cases) {
  // Bundle integrity: pools re-execute bit-identically on the snapshot.
  const dateRange = extractTemporalConstraint(fc.query);
  if (JSON.stringify(dateRange) !== JSON.stringify(fc.dateRange)) fail(`${fc.id}: dateRange extraction diverged from manifest`);
  const pool10 = poolFor(store, fc.query, POOL_SEARCH);
  const pool20 = poolFor(store, fc.query, POOL_PIPELINE, dateRange || undefined);
  if (JSON.stringify(toRows(pool10)) !== JSON.stringify(fc.pool10)) fail(`${fc.id}: pool-10 diverged from frozen baseline — bundle integrity broken`);
  if (JSON.stringify(toRows(pool20)) !== JSON.stringify(fc.pool20)) fail(`${fc.id}: pool-20 diverged from frozen baseline — bundle integrity broken`);

  // E6 bypass observability (pool-20, the production bypass input).
  const fired = hasStrongFtsSignal(pool20);
  const fr: FireRow = {
    id: fc.id, kind: fc.kind, fired, singleton: pool20.length === 1,
    top: pool20[0]?.displayPath, topScore: pool20[0]?.score,
    gap: pool20.length > 1 ? pool20[0]!.score - pool20[1]!.score : (pool20.length === 1 ? pool20[0]!.score : undefined),
  };
  if (fired && fc.kind === "target") fr.topIsTarget = (fc.targets ?? []).some(t => pool20[0]!.displayPath.includes(t));
  fireRows.push(fr);

  if (fc.kind === "recency") {
    const a = armA(store, pool10, fc.query, asOf);
    // Regime rule (E4): recency-intent queries keep composite in BOTH arms → identity to baseline.
    if (JSON.stringify(a) !== JSON.stringify(fc.recencyBaseline ?? [])) fail(`${fc.id}: recency Arm A diverged from frozen baseline`);
    // Arm B as SHIPPED applies the regime gate (mcp.ts search handler): recency must
    // route to the composite path and match the same frozen baseline (T31 LOW-1 fix).
    const regime = selectScoringRegime(fc.query);
    const bShipped = regime === "raw" ? armB(store, pool10, fc.query, asOf) : armA(store, pool10, fc.query, asOf);
    if (regime !== "recency-composite") fail(`${fc.id}: regime selector routed recency query to "${regime}" — E4 broken`);
    if (JSON.stringify(bShipped) !== JSON.stringify(fc.recencyBaseline ?? [])) fail(`${fc.id}: recency Arm B (shipped regime gate) diverged from frozen baseline`);
    // §51.6 I3: arm P as SHIPPED sits behind the same regime gate — recency routes
    // composite and must reproduce the frozen baseline; proximity never applies.
    const pShipped = regime === "raw"
      ? toRows(proximityRerankDetailed(armBFull(store, pool10, fc.query, asOf), fc.query).rows.map(r => ({ displayPath: r.displayPath, compositeScore: r.compositeScore })))
      : armA(store, pool10, fc.query, asOf);
    if (JSON.stringify(pShipped) !== JSON.stringify(fc.recencyBaseline ?? [])) fail(`${fc.id}: §51.6 I3 — recency arm P (shipped regime gate) diverged from frozen baseline`);
    continue;
  }

  const a = armA(store, pool10, fc.query, asOf);
  // §51.6 frozen B→P bridge (s516-prereg.md §5): both arms derive from ONE bFull.
  const bFull = armBFull(store, pool10, fc.query, asOf);
  const b = toRows(bFull.map(r => ({ displayPath: r.displayPath, compositeScore: r.compositeScore })));
  if (a.length !== b.length) fail(`${fc.id}: arm output lengths differ (A=${a.length}, B=${b.length}) — pool identity broken`);

  // §51.6 arm P — asserts I1/I2/I5/I7, cold probe G7c, warm reps G7 (s516-prereg.md §6-§7).
  const multiword = tokenizeForFTS5(fc.query).length >= 2;
  if (fc.kind === "target" && multiword !== S516_ELIGIBLE.has(fc.id))
    fail(`${fc.id}: §51.6 I5 — census drift: computed eligibility ${multiword} contradicts the frozen ID list`);
  const applicable = multiword && bFull.length >= 2;
  const snap = JSON.stringify(bFull); // I1 deep field snapshot BEFORE the first P invocation
  let d: ProximityOutcome<ScoredResult>;
  if (fc.id === S516.coldProbeId) {
    if (s516OracleTouched) fail(`§51.6 G7c: oracle touched before designated cold probe ${S516.coldProbeId}`);
    const t0 = performance.now();
    d = proximityRerankDetailed(bFull, fc.query);
    s516ColdMs = performance.now() - t0;
  } else {
    d = proximityRerankDetailed(bFull, fc.query);
  }
  if (multiword) s516OracleTouched = true;
  const checkStatus = (st: ProximityOutcome<ScoredResult>["status"], where: string) => {
    if (st === "oracle-failure") fail(`${fc.id}: §51.6 I7 — oracle failure during ${where} (EVAL INVALID)`);
    else if (applicable && st !== "applied") fail(`${fc.id}: §51.6 I7 — expected "applied" during ${where}, got "${st}"`);
    else if (!applicable && st !== "inapplicable") fail(`${fc.id}: §51.6 I7 — expected "inapplicable" during ${where}, got "${st}"`);
  };
  checkStatus(d.status, "primary call");
  if (applicable) {
    // G7: 1 warm-up + 5 timed repetitions, ALL through the detailed core with
    // status checks (T4 MEDIUM-1) — the status-discarding wrapper is never used.
    checkStatus(proximityRerankDetailed(bFull, fc.query).status, "warm-up");
    const times: number[] = [];
    for (let i = 0; i < S516.g7Reps; i++) {
      const t0 = performance.now();
      const rd = proximityRerankDetailed(bFull, fc.query);
      times.push(performance.now() - t0);
      checkStatus(rd.status, `timed rep ${i + 1}`);
    }
    times.sort((x, y) => x - y);
    const bytes = bFull.reduce((s, r) => s + r.displayPath.length + (r.title?.length ?? 0) + (r.body?.length ?? 0), 0);
    s516G7.push({ id: fc.id, medianMs: times[Math.floor(times.length / 2)]!, bytes });
  }
  // I1: reference-identical permutation + no in-place mutation across ALL P invocations.
  const bSet = new Set<ScoredResult>(bFull);
  if (d.rows.length !== bFull.length || new Set(d.rows.map(r => r.displayPath)).size !== d.rows.length || !d.rows.every(r => bSet.has(r)))
    fail(`${fc.id}: §51.6 I1 — arm P is not a reference-identical permutation of bFull`);
  if (JSON.stringify(bFull) !== snap) fail(`${fc.id}: §51.6 I1 — bFull fields mutated across P invocations`);
  const p = toRows(d.rows.map(r => ({ displayPath: r.displayPath, compositeScore: r.compositeScore })));
  if (!applicable && JSON.stringify(p) !== JSON.stringify(b))
    fail(`${fc.id}: §51.6 I2 — re-rank must not apply, but ordering changed`);

  if (fc.kind === "control") {
    const track = (rows: FrozenPoolRow[], sink: typeof controlTopA) => {
      if (rows.length === 0) return;
      const top = rows[0]!;
      const enrichedTop = enrichResults(store, pool10.filter(r => r.displayPath === top.path), fc.query)[0];
      sink.push({ id: fc.id, path: top.path, pinned: !!enrichedTop?.pinned });
    };
    track(a, controlTopA); track(b, controlTopB); track(p, controlTopP);
    continue;
  }

  targetRows.push({
    id: fc.id, set: fc.set, query: fc.query, shape: fc.shape, rankA: rankOf(a, fc.targets), rankB: rankOf(b, fc.targets),
    rankP: rankOf(p, fc.targets), eligible: fc.kind === "target" && multiword, pSame: JSON.stringify(p) === JSON.stringify(b),
    pBuckets: d.buckets ? d.buckets.map(bi => (bi.col ? `${bi.bucket}${bi.col[0]}` : `${bi.bucket}`)).join(" ") : "-",
  });
}

// Per-arm control checks (E5.5): no repeated top-1; no pinned top-1.
function controlCheck(rows: { id: string; path: string; pinned: boolean }[], arm: string): boolean {
  let clean = true;
  const seen = new Map<string, string>();
  for (const c of rows) {
    if (seen.has(c.path)) { console.error(`CONTROL[${arm}]: "${c.path}" tops both ${seen.get(c.path)} and ${c.id} (hub dominance)`); clean = false; }
    seen.set(c.path, c.id);
    if (c.pinned) { console.error(`CONTROL[${arm}]: ${c.id} top-1 "${c.path}" is pinned`); clean = false; }
  }
  return clean;
}
const controlsCleanA = controlCheck(controlTopA, "A");
const controlsCleanB = controlCheck(controlTopB, "B");
const controlsCleanP = controlCheck(controlTopP, "P");

// Metrics.
const mrr = (rows: Row[], k: "rankA" | "rankB" | "rankP") => rows.reduce((s, r) => s + (r[k] ? 1 / r[k]! : 0), 0) / Math.max(1, rows.length);
const hitN = (rows: Row[], k: "rankA" | "rankB" | "rankP", n: number) => rows.filter(r => r[k] !== null && r[k]! <= n).length;
const slice = (rows: Row[], label: string) => {
  console.log(`  ${label}: n=${rows.length} · A: hit@1 ${hitN(rows, "rankA", 1)} MRR ${mrr(rows, "rankA").toFixed(3)} · B: hit@1 ${hitN(rows, "rankB", 1)} MRR ${mrr(rows, "rankB").toFixed(3)}`);
};

const hold = targetRows.filter(r => r.set === "holdout");
const combined = targetRows;
console.log(`\n=== Arm comparison (A = shipped composite · B = raw-FTS-primary) ===`);
slice(combined, "combined");
slice(targetRows.filter(r => r.set === "discovery"), "discovery");
slice(hold, "held-out ");
slice(combined.filter(r => r.shape === "exact-old"), "shape:exact-old      ");
slice(combined.filter(r => r.shape === "fresh-among-many"), "shape:fresh-among-many");
console.log(`\nPaired per-case deltas (rankA → rankB):`);
for (const r of combined) if (r.rankA !== r.rankB) console.log(`  ${r.id} [${r.shape ?? "-"}] ${r.rankA} → ${r.rankB}  "${r.query.slice(0, 60)}"`);

// E5 predeclared rule.
const mrrA = mrr(combined, "rankA"), mrrB = mrr(combined, "rankB");
const hit1A = hitN(combined, "rankA", 1), hit1B = hitN(combined, "rankB", 1);
const hMrrA = mrr(hold, "rankA"), hMrrB = mrr(hold, "rankB");
const hHit1A = hitN(hold, "rankA", 1), hHit1B = hitN(hold, "rankB", 1);
const hHit5B = hitN(hold, "rankB", 5);
const cond = {
  margin: mrrB - mrrA >= E5.switchMargin,
  noHit1Regress: hit1B >= hit1A,
  holdMrrNonRegress: hMrrB >= hMrrA,
  holdHit1NonRegress: hHit1B >= hHit1A,
  holdFloor1: hHit1B >= E5.holdFloorHit1,
  holdFloor5: hHit5B >= E5.holdFloorHit5,
  holdFloorMrr: hMrrB >= E5.holdFloorMrr,
  controlsB: controlsCleanB,
};
console.log(`\n=== E5 rule evaluation ===`);
console.log(`  ΔMRR (B−A) combined = ${(mrrB - mrrA).toFixed(3)} (switch needs ≥ ${E5.switchMargin}) → ${cond.margin}`);
console.log(`  hit@1 B ≥ A combined: ${hit1B} ≥ ${hit1A} → ${cond.noHit1Regress}`);
console.log(`  held-out MRR B ≥ A: ${hMrrB.toFixed(3)} ≥ ${hMrrA.toFixed(3)} → ${cond.holdMrrNonRegress}`);
console.log(`  held-out hit@1 B ≥ A: ${hHit1B} ≥ ${hHit1A} → ${cond.holdHit1NonRegress}`);
console.log(`  held-out floors B: hit@1 ${hHit1B}≥${E5.holdFloorHit1} ${cond.holdFloor1} · hit@5 ${hHit5B}≥${E5.holdFloorHit5} ${cond.holdFloor5} · MRR ${hMrrB.toFixed(3)}≥${E5.holdFloorMrr} ${cond.holdFloorMrr}`);
console.log(`  controls clean: A=${controlsCleanA} B=${controlsCleanB} (B gates)`);
const SWITCH = Object.values(cond).every(Boolean);

// E6 report.
const fired = fireRows.filter(f => f.fired);
const firedTargets = fireRows.filter(f => f.fired && f.kind === "target");
console.log(`\n=== E6 bypass-firing report (pool-20, report-only) ===`);
console.log(`  fire rate: ${fired.length}/${fireRows.length} all cases · ${firedTargets.length}/${fireRows.filter(f => f.kind === "target").length} target cases`);
console.log(`  precision-when-fired (target cases): ${firedTargets.filter(f => f.topIsTarget).length}/${firedTargets.length}`);
console.log(`  old-world counterfactual (pre-v0.23.0 always-fired singletons): ${fireRows.filter(f => f.singleton).length}`);
for (const f of fired) console.log(`  FIRED ${f.id} (${f.kind}) top="${f.top}" score=${f.topScore?.toFixed(3)} gap=${f.gap?.toFixed(3)}${f.topIsTarget !== undefined ? ` topIsTarget=${f.topIsTarget}` : ""}`);

// ---------------------------------------------------------------------------
// §51.6 proximity report (s516-prereg.md v5). All §51.6 output lives between
// "=== §51.6" headers and "--- end §51.6 ---" markers so the I4 byte-diff can
// strip it and compare the remainder against the pre-change control artifact.
// ---------------------------------------------------------------------------
const elig = targetRows.filter(r => r.eligible);
const eligDisc = elig.filter(r => r.set === "discovery");
const eligHold = elig.filter(r => r.set === "holdout");
if (eligDisc.length !== S516.eligibleDisc || eligHold.length !== S516.eligibleHold)
  fail(`§51.6 I5: eligible cardinality ${eligDisc.length}/${eligHold.length} != ${S516.eligibleDisc}/${S516.eligibleHold}`);
const s516Meds = s516G7.map(g => g.medianMs).sort((x, y) => x - y);
const s516P95 = s516Meds[Math.ceil(0.95 * s516Meds.length) - 1] ?? 0; // nearest-rank (G7a)
const s516Worst = s516Meds[s516Meds.length - 1] ?? 0;
console.log(`\n=== §51.6 proximity arm (P = proximity re-rank over B; s516-prereg.md v5) ===`);
const sliceBP = (rows: Row[], label: string) =>
  console.log(`  ${label}: n=${rows.length} · B: hit@1 ${hitN(rows, "rankB", 1)} MRR ${mrr(rows, "rankB").toFixed(3)} · P: hit@1 ${hitN(rows, "rankP", 1)} MRR ${mrr(rows, "rankP").toFixed(3)}`);
sliceBP(elig, "eligible combined ");
sliceBP(eligDisc, "eligible discovery");
sliceBP(eligHold, "eligible held-out ");
sliceBP(elig.filter(r => r.shape === "exact-old"), "elig shape:exact-old      ");
sliceBP(elig.filter(r => r.shape === "fresh-among-many"), "elig shape:fresh-among-many");
console.log(`  arm A context (combined all targets): hit@1 ${hitN(combined, "rankA", 1)} MRR ${mrr(combined, "rankA").toFixed(3)}`);
console.log(`  eligible cases where P ≡ B: ${elig.filter(r => r.pSame).length}/${elig.length}`);
console.log(`  paired deltas (rankB → rankP) where changed:`);
for (const r of elig) if (r.rankB !== r.rankP) console.log(`    ${r.id} [${r.shape ?? "-"}] ${r.rankB} → ${r.rankP}  buckets[${r.pBuckets}]  "${r.query.slice(0, 50)}"`);
console.log(`  G7 latency: samples ${s516Meds.length} · p95(nearest-rank, per-case medians) ${s516P95.toFixed(2)}ms · worst ${s516Worst.toFixed(2)}ms · cold(${S516.coldProbeId}) ${s516ColdMs === null ? "MISSING" : s516ColdMs.toFixed(2) + "ms"}`);
console.log(`  G7 per-case: ${s516G7.map(g => `${g.id}=${g.medianMs.toFixed(1)}ms/${(g.bytes / 1024).toFixed(0)}kB`).join(" ")}`);
console.log(`  RSS delta across run: ${((process.memoryUsage().rss - s516RssBefore) / 1048576).toFixed(1)} MiB (report-only)`);
console.log(`--- end §51.6 ---`);

if (failures > 0) {
  console.error(`\nEVAL INVALID: ${failures} fixture/integrity failure(s) — no verdict.`);
  process.exit(1);
}
console.log(`\n=== VERDICT (predeclared E5 rule) ===`);
console.log(SWITCH
  ? `SWITCH — raw-FTS-primary earns the ranking-contract change on \`search\` (all conditions met).`
  : `KEEP — \`search\` retains the composite regime (one or more SWITCH conditions unmet; status quo holds).`);
if (!controlsCleanA) console.log(`NOTE: Arm A (shipped) failed a control check — recorded as a finding against composite regardless of verdict.`);
if ((hMrrA < E5.holdFloorMrr || hHit1A < E5.holdFloorHit1) && !SWITCH)
  console.log(`NOTE: Arm A misses absolute held-out floors (hit@1 ${hHit1A}, MRR ${hMrrA.toFixed(3)}) — reported per E5.3.`);

// ---------------------------------------------------------------------------
// §51.6 verdict (pre-registered v5 rule — s516-prereg.md §7).
// ---------------------------------------------------------------------------
const s516Cond = {
  g1_marginMrr: mrr(elig, "rankP") - mrr(elig, "rankB") >= S516.g1MarginMrr,
  g2_hit1NonRegress: hitN(elig, "rankP", 1) >= hitN(elig, "rankB", 1),
  g3_holdoutNonRegress: mrr(eligHold, "rankP") >= mrr(eligHold, "rankB") && hitN(eligHold, "rankP", 1) >= hitN(eligHold, "rankB", 1),
  g4_inheritedFloors: hitN(hold, "rankP", 1) >= E5.holdFloorHit1 && hitN(hold, "rankP", 5) >= E5.holdFloorHit5 && mrr(hold, "rankP") >= E5.holdFloorMrr,
  g5_controlsClean: controlsCleanP,
  g6a_topBoundary: elig.filter(r => r.rankB !== null && r.rankB <= S516.g6aBoundary && (r.rankP ?? Infinity) > S516.g6aBoundary).length === 0,
  g6b_maxDrop: elig.filter(r => r.rankB !== null && (r.rankP ?? Infinity) - r.rankB! > S516.g6bMaxDrop).length === 0,
  g7a_p95: s516P95 <= S516.g7P95Ms,
  g7b_worst: s516Worst <= S516.g7WorstMs,
  g7c_cold: s516ColdMs !== null && s516ColdMs <= S516.g7ColdMs,
};
console.log(`\n=== §51.6 VERDICT (pre-registered v5 rule) ===`);
console.log(`  G1 ΔMRR(P−B) eligible-combined = ${(mrr(elig, "rankP") - mrr(elig, "rankB")).toFixed(3)} (ship needs ≥ ${S516.g1MarginMrr}) → ${s516Cond.g1_marginMrr}`);
console.log(`  G2 hit@1 P ≥ B eligible-combined: ${hitN(elig, "rankP", 1)} ≥ ${hitN(elig, "rankB", 1)} → ${s516Cond.g2_hit1NonRegress}`);
console.log(`  G3 eligible-held-out MRR ${mrr(eligHold, "rankP").toFixed(3)} ≥ ${mrr(eligHold, "rankB").toFixed(3)} & hit@1 ${hitN(eligHold, "rankP", 1)} ≥ ${hitN(eligHold, "rankB", 1)} → ${s516Cond.g3_holdoutNonRegress}`);
console.log(`  G4 inherited floors (redundant sanity): hit@1 ${hitN(hold, "rankP", 1)}≥${E5.holdFloorHit1} · hit@5 ${hitN(hold, "rankP", 5)}≥${E5.holdFloorHit5} · MRR ${mrr(hold, "rankP").toFixed(3)}≥${E5.holdFloorMrr} → ${s516Cond.g4_inheritedFloors}`);
console.log(`  G5 controls clean under P → ${s516Cond.g5_controlsClean}`);
console.log(`  G6a zero top-${S516.g6aBoundary} demotions → ${s516Cond.g6a_topBoundary} · G6b zero drops > ${S516.g6bMaxDrop} → ${s516Cond.g6b_maxDrop}`);
console.log(`  G7 p95 ${s516P95.toFixed(2)}≤${S516.g7P95Ms}ms → ${s516Cond.g7a_p95} · worst ${s516Worst.toFixed(2)}≤${S516.g7WorstMs}ms → ${s516Cond.g7b_worst} · cold ${s516ColdMs === null ? "MISSING" : s516ColdMs.toFixed(2)}≤${S516.g7ColdMs}ms → ${s516Cond.g7c_cold}`);
const S516_SHIP = Object.values(s516Cond).every(Boolean);
console.log(S516_SHIP
  ? `SHIP — proximity re-rank earns the \`search\` raw-route ordering change (all §7 gates met) → v0.28.0.`
  : `KILL — proximity re-rank does not earn the change (one or more §7 gates unmet); \`search\` raw route unchanged.`);
console.log(`--- end §51.6 ---`);
process.exit(0);
