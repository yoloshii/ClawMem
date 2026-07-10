/**
 * v0.22.0 acceptance gate (VSEARCH-RAW-PRIMARY-DESIGN.md R6) — read-only evaluator
 * with a deterministic freeze bundle.
 *
 *   freeze  — snapshot the vault (VACUUM INTO), stamp one asOf timestamp, embed every
 *             case's query ONCE via the production query template against the live
 *             endpoint, and capture per-case baselines against the snapshot:
 *               non-recency → the pure-raw ordering (searchVecDetailedWithVector)
 *               recency     → the composite pipeline with { now: asOf } (the pre-v0.22.0
 *                             behavior, which v0.22.0 preserves on recency queries)
 *   run     — re-score every case from the bundle (same snapshot, same vectors, same
 *             asOf; no live embeds, no wall clock) through the SHIPPED regime pipeline
 *             and enforce the predeclared criteria:
 *               1. pin-invariance identity on non-recency cases (shipped == pure-raw as
 *                  a sequence, permutation allowed only inside exact-raw-score ties)
 *               2. recency cases match their frozen composite baseline exactly
 *               3. controls: no repeated top-1 across controls; no pinned top-1
 *               4. discovery set: every target in-pool (miss = failure) + paired deltas
 *               5. held-out floors: hit@1 >= 12/20, hit@5 >= 17/20, MRR >= 0.75
 *               6. any degraded candidate pool aborts the run
 *
 * Usage:
 *   bun scripts/eval-acceptance.ts freeze --db <live.sqlite> --bundle <dir> \
 *       --queries eval-queries.local.json --holdout eval-queries-holdout.local.json
 *   bun scripts/eval-acceptance.ts run --bundle <dir>
 *
 * Exit codes: 0 pass · 1 criteria failure · 2 degraded/infrastructure abort.
 */
import { parseArgs } from "util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore, searchVecDetailedWithVector, type Store } from "../src/store.ts";
import { getDefaultLlamaCpp, formatQueryForEmbedding } from "../src/llm.ts";
import { enrichResults } from "../src/search-utils.ts";
import { applyCompositeScoring, type CoActivationFn } from "../src/memory.ts";
import { selectScoringRegime, rankRawPrimary } from "../src/scoring-regime.ts";

const POOL = 10; // production default candidate depth
const RECENCY_DEFAULT_MIN = 0.3; // the composite regime's preserved default floor
const FLOORS = { hit1: 12, hit5: 17, mrr: 0.75, holdoutTargets: 20 };

type Case = {
  id: string;
  set: "discovery" | "holdout";
  kind: "target" | "control" | "recency";
  query: string;
  targets: string[] | null;
};
type FrozenCase = Case & {
  embedding: number[];
  endpointModel: string;
  rawBaseline: { path: string; score: number }[];
  recencyBaseline?: { path: string; score: number }[];
};
type Manifest = { asOf: string; snapshot: string; cases: FrozenCase[] };

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" },
    bundle: { type: "string" },
    queries: { type: "string" },
    holdout: { type: "string" },
  },
  allowPositionals: true,
});
const cmd = positionals[0];
if (!values.bundle || (cmd !== "freeze" && cmd !== "run")) {
  console.error("Usage: bun scripts/eval-acceptance.ts freeze --db <live.sqlite> --bundle <dir> --queries <file> --holdout <file>");
  console.error("       bun scripts/eval-acceptance.ts run --bundle <dir>");
  process.exit(2);
}
const bundleDir = values.bundle;
const manifestPath = join(bundleDir, "manifest.json");
const snapshotPath = join(bundleDir, "snapshot.sqlite");

function loadCases(): Case[] {
  const cases: Case[] = [];
  const disc = JSON.parse(readFileSync(values.queries!, "utf8")) as { query: string; target: string | null; note?: string }[];
  disc.forEach((c, i) => cases.push({
    id: `disc-${i}`,
    set: "discovery",
    kind: c.target === null ? "control" : "target",
    query: c.query,
    targets: c.target === null ? null : [c.target],
  }));
  const hold = JSON.parse(readFileSync(values.holdout!, "utf8")) as { cases: { kind: Case["kind"]; query: string; targets: string[] | null }[] };
  hold.cases.forEach((c, i) => cases.push({ id: `hold-${i}`, set: "holdout", kind: c.kind, query: c.query, targets: c.targets }));
  return cases;
}

function shippedRanking(store: Store, det: { results: any[] }, query: string, asOf: Date): { path: string; score: number }[] {
  const coFn: CoActivationFn = (p: string) => store.getCoActivated(p);
  const enriched = enrichResults(store, det.results, query);
  if (selectScoringRegime(query) === "raw") {
    // Shipped raw route: no default floor (design R3).
    return rankRawPrimary(enriched, query, coFn, { now: asOf }).map(r => ({ path: r.displayPath, score: r.compositeScore }));
  }
  return applyCompositeScoring(enriched, query, coFn, { now: asOf })
    .filter(r => r.compositeScore >= RECENCY_DEFAULT_MIN)
    .map(r => ({ path: r.displayPath, score: r.compositeScore }));
}

function detFor(store: Store, fc: { embedding: number[]; endpointModel: string }, opts: { abortOnDegraded: boolean }) {
  const det = searchVecDetailedWithVector(
    store.db,
    { embedding: new Float32Array(fc.embedding), endpointModel: fc.endpointModel },
    POOL,
    { excludeCollections: ["_clawmem"] }
  );
  if (opts.abortOnDegraded && det.degraded) {
    console.error(`ABORT: degraded candidate pool (${det.degradedReason ?? "?"}) — acceptance requires non-degraded pools.`);
    process.exit(2);
  }
  return det;
}

if (cmd === "freeze") {
  if (!values.db || !values.queries || !values.holdout) { console.error("freeze needs --db --queries --holdout"); process.exit(2); }
  mkdirSync(bundleDir, { recursive: true });
  if (existsSync(snapshotPath)) { console.error(`refusing to overwrite existing snapshot at ${snapshotPath}`); process.exit(2); }
  console.log(`Snapshotting ${values.db} → ${snapshotPath} ...`);
  const live = new Database(values.db, { readonly: true });
  live.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  live.close();
  // VACUUM INTO produces a DELETE-journal DB; the store's WAL pragma is a write and
  // would fail on a readonly open. Convert once here so both freeze and run can open
  // the snapshot readonly.
  const walConvert = new Database(snapshotPath);
  walConvert.exec("PRAGMA journal_mode = WAL");
  walConvert.close();

  const asOf = new Date().toISOString();
  const store = createStore(snapshotPath, { readonly: true });
  const llm = getDefaultLlamaCpp();
  const cases = loadCases();
  const frozen: FrozenCase[] = [];
  for (const c of cases) {
    // A declared-recency case whose wording does not actually trigger the production
    // recency detector would freeze no baseline and fail meaninglessly at run time —
    // catch the mislabel here instead.
    const regime = selectScoringRegime(c.query);
    if (c.kind === "recency" && regime !== "recency-composite") {
      console.error(`MISLABELED CASE ${c.id}: kind=recency but the query does not trigger recency intent — "${c.query}"`);
      process.exit(2);
    }
    if (c.kind !== "recency" && regime === "recency-composite") {
      console.error(`MISLABELED CASE ${c.id}: kind=${c.kind} but the query triggers recency intent — "${c.query}"`);
      process.exit(2);
    }
    const embedded = await llm.embed(formatQueryForEmbedding(c.query));
    if (!embedded) { console.error(`EMBED FAIL at freeze for "${c.query}" — bundle would be unusable.`); process.exit(2); }
    const fc: FrozenCase = {
      ...c,
      embedding: Array.from(embedded.embedding instanceof Float32Array ? embedded.embedding : new Float32Array(embedded.embedding)),
      endpointModel: embedded.model ?? "",
      rawBaseline: [],
    };
    const det = detFor(store, fc, { abortOnDegraded: true });
    fc.rawBaseline = det.results.map((r: any) => ({ path: r.displayPath, score: r.score }));
    if (selectScoringRegime(c.query) === "recency-composite") {
      fc.recencyBaseline = shippedRanking(store, det, c.query, new Date(asOf));
    }
    frozen.push(fc);
    console.log(`froze ${fc.id} (${fc.kind}) pool=${fc.rawBaseline.length}${fc.recencyBaseline ? ` recencyBaseline=${fc.recencyBaseline.length}` : ""}`);
  }
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

// Predeclared fixture cardinalities — a manifest with dropped cases must not pass a
// weakened gate (MEDIUM-2, Turn 17).
const counts = {
  discTargets: manifest.cases.filter(c => c.set === "discovery" && c.kind === "target").length,
  holdTargets: manifest.cases.filter(c => c.set === "holdout" && c.kind === "target").length,
  recency: manifest.cases.filter(c => c.kind === "recency").length,
  controls: manifest.cases.filter(c => c.kind === "control").length,
};
if (counts.discTargets !== 23) fail(`fixture cardinality: discovery targets ${counts.discTargets} != 23`);
if (counts.holdTargets !== FLOORS.holdoutTargets) fail(`fixture cardinality: held-out targets ${counts.holdTargets} != ${FLOORS.holdoutTargets}`);
if (counts.recency < 3) fail(`fixture cardinality: recency cases ${counts.recency} < 3`);
if (counts.controls < 3) fail(`fixture cardinality: controls ${counts.controls} < 3`);

// Identity check: shipped == raw baseline as sequences, permutation allowed ONLY within
// groups of exactly-equal raw scores.
function identityModuloTies(raw: { path: string; score: number }[], shipped: { path: string }[], id: string) {
  if (raw.length !== shipped.length) { fail(`${id}: shipped length ${shipped.length} != raw ${raw.length}`); return; }
  let i = 0;
  while (i < raw.length) {
    let j = i + 1;
    while (j < raw.length && raw[j]!.score === raw[i]!.score) j++;
    // Multiset equality per tie group, both directions — a duplicated or omitted path
    // inside a group is a failure, not a permutation.
    const rawGroup = raw.slice(i, j).map(r => r.path).sort();
    const shipGroup = shipped.slice(i, j).map(r => r.path).sort();
    if (JSON.stringify(rawGroup) !== JSON.stringify(shipGroup)) {
      fail(`${id}: rank ${i + 1}-${j}: shipped [${shipGroup.join(", ")}] != raw tie group [${rawGroup.join(", ")}]`);
    }
    i = j;
  }
}

const controlTop1: { id: string; path: string; pinned: boolean }[] = [];
const discoveryRows: { id: string; query: string; rank: number | null }[] = [];
const holdoutRows: { id: string; query: string; rank: number | null }[] = [];

for (const fc of manifest.cases) {
  const det = detFor(store, fc, { abortOnDegraded: true });
  // Sanity: raw layer reproduces the frozen baseline bit-for-bit (same snapshot + vector).
  const rawNow = det.results.map((r: any) => ({ path: r.displayPath, score: r.score }));
  if (JSON.stringify(rawNow) !== JSON.stringify(fc.rawBaseline)) fail(`${fc.id}: raw layer diverged from the frozen baseline — bundle integrity broken`);

  const shipped = shippedRanking(store, det, fc.query, asOf);

  if (fc.kind === "recency") {
    if (JSON.stringify(shipped) !== JSON.stringify(fc.recencyBaseline ?? [])) fail(`${fc.id}: recency output diverged from the frozen v0.21-composite baseline`);
    continue;
  }

  identityModuloTies(fc.rawBaseline, shipped, fc.id);

  if (fc.kind === "control") {
    if (shipped.length > 0) {
      const top = shipped[0]!;
      const enrichedTop = enrichResults(store, det.results.filter((r: any) => r.displayPath === top.path), fc.query)[0];
      controlTop1.push({ id: fc.id, path: top.path, pinned: !!enrichedTop?.pinned });
    }
    continue;
  }

  const rank = (() => {
    const idx = shipped.findIndex(r => (fc.targets ?? []).some(t => r.path.includes(t)));
    return idx >= 0 ? idx + 1 : null;
  })();
  (fc.set === "discovery" ? discoveryRows : holdoutRows).push({ id: fc.id, query: fc.query, rank });
}

// 3. Controls: no repeated top-1, no pinned top-1.
const seenTop = new Map<string, string>();
for (const c of controlTop1) {
  if (seenTop.has(c.path)) fail(`controls: "${c.path}" is top-1 for both ${seenTop.get(c.path)} and ${c.id} (hub dominance)`);
  seenTop.set(c.path, c.id);
  if (c.pinned) fail(`controls: ${c.id} top-1 "${c.path}" is a pinned document`);
}

// 4. Discovery: every target in-pool; paired deltas vs raw baseline are zero by identity.
for (const d of discoveryRows) {
  if (d.rank === null) fail(`discovery ${d.id}: target not in the raw top-${POOL} pool — "${d.query.slice(0, 60)}"`);
}
const dHit1 = discoveryRows.filter(d => d.rank === 1).length;
const dMrr = discoveryRows.reduce((s, d) => s + (d.rank ? 1 / d.rank : 0), 0) / Math.max(1, discoveryRows.length);
console.log(`discovery: ${discoveryRows.length} targets · hit@1 ${dHit1}/${discoveryRows.length} · MRR ${dMrr.toFixed(3)} · misses ${discoveryRows.filter(d => d.rank === null).length}`);

// 5. Held-out floors.
const hHit1 = holdoutRows.filter(d => d.rank === 1).length;
const hHit5 = holdoutRows.filter(d => d.rank !== null && d.rank <= 5).length;
const hMrr = holdoutRows.reduce((s, d) => s + (d.rank ? 1 / d.rank : 0), 0) / Math.max(1, holdoutRows.length);
console.log(`held-out:  ${holdoutRows.length} targets · hit@1 ${hHit1}/${holdoutRows.length} · hit@5 ${hHit5}/${holdoutRows.length} · MRR ${hMrr.toFixed(3)}`);
if (holdoutRows.length !== FLOORS.holdoutTargets) fail(`held-out target count ${holdoutRows.length} != predeclared ${FLOORS.holdoutTargets}`);
if (hHit1 < FLOORS.hit1) fail(`held-out hit@1 ${hHit1} < floor ${FLOORS.hit1}`);
if (hHit5 < FLOORS.hit5) fail(`held-out hit@5 ${hHit5} < floor ${FLOORS.hit5}`);
if (hMrr < FLOORS.mrr) fail(`held-out MRR ${hMrr.toFixed(3)} < floor ${FLOORS.mrr}`);

for (const d of [...discoveryRows, ...holdoutRows].filter(d => d.rank !== null && d.rank > 1)) {
  console.log(`  rank ${d.rank}  ${d.id}  "${d.query.slice(0, 70)}"`);
}

console.log(failures === 0 ? "\nACCEPTANCE: PASS (all predeclared criteria met)" : `\nACCEPTANCE: ${failures} criterion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
