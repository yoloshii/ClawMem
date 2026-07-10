/**
 * S49.3 hybrid query-pipeline bypass A/B (S49-JUDGED-EVAL-DESIGN.md Part B).
 * Requires live inference services (H5) and the CLAWMEM_DISABLE_FTS_BYPASS knob.
 *
 *   freeze — copy the 49.2 snapshot; persist the FROZEN CENSUS (T31 MEDIUM-1: every
 *            query string probed during 49.2 judging + 49.3 case-hunting, each with its
 *            pool-20 row on this snapshot; inclusion rule: stratum N∪X must cover every
 *            fired census case — abort otherwise); derive stratum N from the 49.2
 *            manifest (target cases whose frozen pool-20 fires hasStrongFtsSignal);
 *            validate stratum X (fires + top ∈ targets) and non-fire controls; capture
 *            expansion per case with the H3 protocol (DELETE the exact
 *            expandQueryCacheKey row → live call → verify the NEWLY WRITTEN row
 *            + digest; uncached latency is genuine); purge every non-frozen llm_cache
 *            row (stale prod rows under drifted keys can never serve a hit; rerank
 *            starts uniformly cold in both arms). Near-fire bands are CONJUNCTIVE
 *            (T31 MEDIUM-2): near-gap top≥0.85 ∧ 0.05≤gap<0.15; near-strength
 *            0.80≤top<0.85 ∧ gap≥0.15; all other census rows recorded as "none".
 *   run    — census integrity re-execution; rerank-health gate; per arm a FRESH copy
 *            of the frozen cache snapshot; spy on the server store's expandQuery
 *            (args → expandQueryCacheKey must EQUAL the manifest key; returned
 *            variants digest-match); counterbalanced per-case arm order; paired
 *            metrics per stratum over effective samples; PREDECLARED H6 gates +
 *            verdict precedence (SAFE is scoped to the frozen census — population
 *            risk unvalidated). Controls assert arm identity.
 *
 * Exit codes: 0 verdict produced · 1 fixture/integrity failure · 2 infra abort.
 */
import { parseArgs } from "util";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStore, expandQueryCacheKey, type Store } from "../src/store.ts";
import { hasStrongFtsSignal } from "../src/search-utils.ts";
import { extractTemporalConstraint } from "../src/intent.ts";
import { buildMcpServer } from "../src/mcp.ts";
import { probeRerankHealth } from "../src/health/rerank-health.ts";
import { runCanaryBattery } from "../src/canary.ts";
import { getDefaultLlamaCpp } from "../src/llm.ts";

const EXCL = ["_clawmem"];
const GATES = {
  epsN: -0.05, allowN: (eN: number) => Math.floor(0.10 * eN),
  epsX: -0.05, allowX: (eX: number) => Math.floor(0.10 * eX),
  coverage: (S: number) => Math.max(1, Math.ceil(0.8 * S)),
  controlsMin: 5,
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Stratum = "N" | "X" | "control";
type FrozenCase = {
  id: string; stratum: Stratum; query: string; targets: string[] | null;
  fired: boolean; pool20Top?: { path: string; score: number; gap: number };
  expansionKey: string; variantsDigest: string; latencyUncachedMs: number;
};
type CensusPoolState = {
  n: number; top: string | null; topScore: number | null; gap: number | null;
  fired: boolean; band: "fired" | "near-gap" | "near-strength" | "none";
};
type CensusRow = CensusPoolState & {
  query: string; src: "judged" | "probe"; sources: string[];
  targets: string[] | null; topCorrect: boolean | null;
  judgedBy: "49.2-manifest" | "content-judgment-2026-07-11" | null;
};
type CensusSource = { name: string; kind: string; count: number; sha256: string; queries: string[] };
type Manifest = {
  asOf: string; fromBundle: string; services: Record<string, string>;
  cases: FrozenCase[]; census: CensusRow[];
  censusSources: Omit<CensusSource, "queries">[];
};

// Provenance expectations (T32 MEDIUM-2 / T33 MEDIUM-1), frozen from the design doc:
// the five persisted probe sources with INDEPENDENTLY ANCHORED digests — the cases
// artifact's own digest column proves nothing (it sits beside the list it digests);
// both the supplied digest and the recomputed digest must equal these frozen values.
const EXPECTED_CENSUS = {
  sources: {
    "judged-49.2": { count: 51, sha256: "aebe8860a3a7285d5cca938e60bcef442415b8406edbb2ce6ecc9ca7857dc6e0" },
    "mine": { count: 64, sha256: "35e0ba8126bb937416e7fd83cb2fb1531929c5afc7396a0a90f4c6f274c1a7b1" },
    "author-aid": { count: 49, sha256: "a4d13794133a7a7540a43bd6601b9dbe7e92a8db31ea486417bd6aea158798ea" },
    "probe-fire": { count: 35, sha256: "e3f8f8250f184219ea4dd78ca833973fc52d2ff9e2682b8249d0268252040535" },
    "probe-fire2": { count: 30, sha256: "1e2901d4fd41cdfbffeb379e4fcc145931f9d1a35365f814b54901312844573c" },
  } as Record<string, { count: number; sha256: string }>,
  unionCount: 127,
};

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { bundle: { type: "string" }, "from-bundle": { type: "string" }, cases: { type: "string" } },
  allowPositionals: true,
});
const cmd = positionals[0];
if (!values.bundle || (cmd !== "freeze" && cmd !== "run")) {
  console.error("Usage: bun scripts/eval-bypass-ab.ts freeze --from-bundle <49.2 dir> --bundle <dir> --cases <file>");
  console.error("       bun scripts/eval-bypass-ab.ts run --bundle <dir>");
  process.exit(2);
}
const bundleDir = values.bundle;
const manifestPath = join(bundleDir, "manifest.json");
const cacheSnapPath = join(bundleDir, "cache-snapshot.sqlite");

function pool20(store: Store, query: string) {
  const dr = extractTemporalConstraint(query) || undefined;
  return store.searchFTS(query, 20, undefined, undefined, dr, EXCL);
}

/**
 * A census query's pool-derived state (T31 MEDIUM-1): production-mirror pool-20 on the
 * frozen snapshot, firing state, and CONJUNCTIVE near-fire band (T31 MEDIUM-2).
 * Deterministic given (snapshot, query) — the run side re-executes and byte-compares
 * exactly these fields; provenance fields are freeze-derived and digest-audited instead.
 */
function censusPoolState(store: Store, query: string): CensusPoolState {
  const p = pool20(store, query);
  const top = p[0] ?? null;
  const gap = top ? (p.length > 1 ? top.score - p[1]!.score : top.score) : null;
  const fired = hasStrongFtsSignal(p);
  const band = fired ? "fired"
    : top && gap !== null && top.score >= 0.85 && gap >= 0.05 && gap < 0.15 ? "near-gap"
    : top && gap !== null && top.score >= 0.80 && top.score < 0.85 && gap >= 0.15 ? "near-strength" : "none";
  return { n: p.length, top: top?.displayPath ?? null, topScore: top?.score ?? null, gap, fired, band };
}
const pickPoolState = (r: CensusRow): CensusPoolState =>
  ({ n: r.n, top: r.top, topScore: r.topScore, gap: r.gap, fired: r.fired, band: r.band });

// ---------------------------------------------------------------------------
// freeze
// ---------------------------------------------------------------------------
if (cmd === "freeze") {
  if (!values["from-bundle"] || !values.cases) { console.error("freeze needs --from-bundle --cases"); process.exit(2); }
  if (!process.env.CLAWMEM_LLM_URL) { console.error("ABORT: CLAWMEM_LLM_URL not set — expansion capture needs the live LLM (H5)."); process.exit(2); }
  mkdirSync(bundleDir, { recursive: true });
  if (existsSync(cacheSnapPath)) { console.error(`refusing to overwrite ${cacheSnapPath}`); process.exit(2); }

  const kw = JSON.parse(readFileSync(join(values["from-bundle"], "manifest.json"), "utf8")) as
    { asOf: string; cases: { id: string; kind: string; query: string; targets: string[] | null; pool20: { path: string; score: number }[] }[] };
  copyFileSync(join(values["from-bundle"], "snapshot.sqlite"), cacheSnapPath);

  const spec = JSON.parse(readFileSync(values.cases, "utf8")) as {
    xCases: { query: string; targets: string[] }[];
    controls: { query: string }[];
    censusSources: CensusSource[];
    probeJudgments: { query: string; targets: string[]; note?: string }[];
  };
  if (spec.controls.length < GATES.controlsMin) { console.error(`ABORT: ${spec.controls.length} controls < ${GATES.controlsMin}`); process.exit(2); }

  // Census provenance enforcement (T32 MEDIUM-2): reconstruct the union OURSELVES from
  // the five digested source lists; assert each source's digest + exact-string count and
  // the union count against the design doc's frozen expectations.
  const expectedNames = Object.keys(EXPECTED_CENSUS.sources);
  const gotNames = (spec.censusSources ?? []).map(s => s.name);
  if (JSON.stringify([...gotNames].sort()) !== JSON.stringify([...expectedNames].sort())) {
    console.error(`ABORT: censusSources names ${JSON.stringify(gotNames)} != expected ${JSON.stringify(expectedNames)}`); process.exit(2);
  }
  for (const s of spec.censusSources) {
    const exp = EXPECTED_CENSUS.sources[s.name]!;
    if (s.queries.length !== s.count || s.count !== exp.count) {
      console.error(`ABORT: source ${s.name} count ${s.queries.length}/${s.count} != expected ${exp.count}`); process.exit(2);
    }
    if (new Set(s.queries).size !== s.queries.length) { console.error(`ABORT: source ${s.name} contains duplicate query strings`); process.exit(2); }
    // T33 MEDIUM-1: both the artifact's digest column AND the recomputed digest must
    // equal the independently anchored value — the adjacent digest alone proves nothing.
    if (s.sha256 !== exp.sha256) { console.error(`ABORT: source ${s.name} declared digest != anchored expectation`); process.exit(2); }
    if (sha256(JSON.stringify(s.queries)) !== exp.sha256) { console.error(`ABORT: source ${s.name} recomputed digest != anchored expectation — provenance list edited`); process.exit(2); }
  }
  const sourcesOf = new Map<string, string[]>();
  for (const s of spec.censusSources) {
    for (const q of s.queries) sourcesOf.set(q, [...(sourcesOf.get(q) ?? []), s.name]);
  }
  const censusQueries = [...sourcesOf.keys()].sort((a, b) => a.localeCompare(b));
  if (censusQueries.length !== EXPECTED_CENSUS.unionCount) {
    console.error(`ABORT: census union ${censusQueries.length} != expected ${EXPECTED_CENSUS.unionCount}`); process.exit(2);
  }

  const store = createStore(cacheSnapPath); // writable — the expansion cache IS the freeze medium
  const asOf = new Date().toISOString();
  const cases: FrozenCase[] = [];
  let aborts = 0;

  // Stratum N: derived from the 49.2 manifest's frozen pools (pool-derived, no arm output).
  const nCases = kw.cases.filter(c => c.kind === "target" && hasStrongFtsSignal(c.pool20 as any));
  const addCase = async (id: string, stratum: Stratum, query: string, targets: string[] | null) => {
    const p = pool20(store, query);
    const fired = hasStrongFtsSignal(p);
    if (stratum === "N" && !fired) { console.error(`STRATUM FAIL ${id}: N case no longer fires on the snapshot copy`); aborts++; return; }
    if (stratum === "X") {
      if (!fired) { console.error(`STRATUM FAIL ${id}: X case does not fire — "${query}"`); aborts++; return; }
      if (!targets || !p[0] || !targets.some(t => p[0]!.displayPath.includes(t))) { console.error(`STRATUM FAIL ${id}: X case top-1 not in targets`); aborts++; return; }
    }
    if (stratum === "control" && fired) { console.error(`STRATUM FAIL ${id}: control fires — "${query}"`); aborts++; return; }

    // H3 expansion capture: force a genuinely uncached live sample at the EXACT production key.
    const key = expandQueryCacheKey(query);
    const capture = async (): Promise<{ digest: string; ms: number } | null> => {
      store.db.prepare(`DELETE FROM llm_cache WHERE hash = ?`).run(key);
      const t0 = performance.now();
      const variants = await store.expandQuery(query);
      const ms = performance.now() - t0;
      const row = store.db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(key) as { result: string } | null;
      if (!row) return null; // fallback path fired (uncached) — retry once
      if (JSON.stringify(JSON.parse(row.result)) !== JSON.stringify(variants)) return null;
      return { digest: sha256(row.result), ms };
    };
    let cap = await capture();
    if (!cap) cap = await capture();
    if (!cap) { console.error(`EXPANSION FAIL ${id}: fallback fired twice (LLM unreachable or unstable) — "${query}"`); aborts++; return; }

    cases.push({
      id, stratum, query, targets, fired,
      pool20Top: p[0] ? { path: p[0].displayPath, score: p[0].score, gap: p.length > 1 ? p[0].score - p[1]!.score : p[0].score } : undefined,
      expansionKey: key, variantsDigest: cap.digest, latencyUncachedMs: Math.round(cap.ms),
    });
    console.log(`froze ${id} (${stratum}${fired ? "/FIRES" : ""}) expansion ${Math.round(cap.ms)}ms`);
  };

  for (const c of nCases) await addCase(`N-${c.id}`, "N", c.query, c.targets);
  for (let i = 0; i < spec.xCases.length; i++) await addCase(`X-${i}`, "X", spec.xCases[i]!.query, spec.xCases[i]!.targets);
  for (let i = 0; i < spec.controls.length; i++) await addCase(`C-${i}`, "control", spec.controls[i]!.query, null);
  // H4: the 49.2 controls re-used verbatim, imported from the 49.2 manifest.
  const kwControls = kw.cases.filter(c => c.kind === "control");
  for (let i = 0; i < kwControls.length; i++) await addCase(`KC-${i}`, "control", kwControls[i]!.query, null);

  // Frozen census (T31 MEDIUM-1): one row per provenance-reconstructed union query with
  // its pool-20 state on THIS snapshot + frozen top-correctness (T32 LOW-1; null = unjudged,
  // reported as such). The judged-49.2 source must equal the 49.2 manifest exactly.
  const judgedSource = new Set(spec.censusSources.find(s => s.name === "judged-49.2")!.queries);
  const manifestQueries = new Set(kw.cases.map(c => c.query));
  if (judgedSource.size !== manifestQueries.size || [...manifestQueries].some(q => !judgedSource.has(q))) {
    console.error("CENSUS FAIL: judged-49.2 source list != 49.2 manifest case queries"); aborts++;
  }
  const targetsByJudged = new Map(kw.cases.map(c => [c.query, c.targets]));
  const judgmentByProbe = new Map((spec.probeJudgments ?? []).map(j => [j.query, j.targets]));
  const census: CensusRow[] = censusQueries.map(query => {
    const ps = censusPoolState(store, query);
    const isJudged = manifestQueries.has(query);
    const targets = (isJudged ? targetsByJudged.get(query) : judgmentByProbe.get(query)) ?? null;
    return {
      query, src: isJudged ? "judged" : "probe", sources: sourcesOf.get(query)!,
      targets, topCorrect: targets && ps.top ? targets.some(t => ps.top!.includes(t)) : null,
      judgedBy: targets ? (isJudged ? "49.2-manifest" : "content-judgment-2026-07-11") : null,
      ...ps,
    };
  });
  const armQueries = new Set([...nCases.map(c => c.query), ...spec.xCases.map(x => x.query)]);
  for (const r of census.filter(r => r.fired && !armQueries.has(r.query))) {
    console.error(`CENSUS FAIL: fired census case not covered by N∪X — "${r.query}" (top=${r.top})`);
    aborts++;
  }

  // Post-capture verification + purge (T28 M1 hardening): every frozen key present, then
  // no OTHER llm_cache rows survive — a drifted key can never silently hit stale prod cache.
  for (const c of cases) {
    const row = store.db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(c.expansionKey) as { result: string } | null;
    if (!row || sha256(row.result) !== c.variantsDigest) { console.error(`POST-VERIFY FAIL ${c.id}: frozen key missing or digest drift (prune sweep?)`); aborts++; }
  }
  if (aborts === 0) {
    const keys = cases.map(c => c.expansionKey);
    const ph = keys.map(() => "?").join(",");
    const purged = store.db.prepare(`DELETE FROM llm_cache WHERE hash NOT IN (${ph})`).run(...keys);
    console.log(`purged ${purged.changes} non-frozen llm_cache rows (stale-key + rerank uniformity)`);
  }
  if (aborts > 0) { console.error(`\nFREEZE ABORTED: ${aborts} defect(s).`); process.exit(2); }

  // Finalize the freeze medium: merge the WAL into the main file and close, so arm
  // copies of cache-snapshot.sqlite are self-contained — copyFileSync ignores the
  // -wal/-shm sidecars, and an unmerged WAL leaves arms with the PRE-purge cache
  // (stale rows present, frozen captures absent). The run's pre-flight catches that
  // state; this prevents it.
  store.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  store.close();

  const services = {
    embed: process.env.CLAWMEM_EMBED_URL ?? "(unset)", llm: process.env.CLAWMEM_LLM_URL ?? "(unset)", rerank: process.env.CLAWMEM_RERANK_URL ?? "(unset)",
    attested: "inference-host reference 2026-07-10: zembed-1-Q4_K_M + EOS-anchor override; qmd-query-expansion-1.7B-q4_k_m; zerank-2-Q4_K_M seq-cls",
  };
  const censusSources = spec.censusSources.map(({ queries: _q, ...meta }) => meta);
  writeFileSync(manifestPath, JSON.stringify({ asOf, fromBundle: values["from-bundle"], services, cases, census, censusSources } satisfies Manifest, null, 1));
  const cFired = census.filter(r => r.fired);
  console.log(`\nBundle frozen: |N|=${cases.filter(c => c.stratum === "N").length} |X|=${cases.filter(c => c.stratum === "X").length} controls=${cases.filter(c => c.stratum === "control").length} asOf=${asOf}`);
  console.log(`census: ${census.length} rows — fired ${cFired.length} (judged ${cFired.filter(r => r.src === "judged").length} · probe ${cFired.filter(r => r.src === "probe").length}) · near-gap ${census.filter(r => r.band === "near-gap").length} · near-strength ${census.filter(r => r.band === "near-strength").length}`);
  for (const r of census.filter(r => r.band === "near-gap" || r.band === "near-strength")) {
    console.log(`  [${r.band}] "${r.query}" top=${(r.top ?? "-").slice(0, 70)} topCorrect=${r.topCorrect === null ? "UNJUDGED" : r.topCorrect}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
for (const v of ["CLAWMEM_EMBED_URL", "CLAWMEM_LLM_URL", "CLAWMEM_RERANK_URL"]) {
  if (!process.env[v]) { console.error(`ABORT: ${v} not set — the hybrid pipeline needs live services (H5).`); process.exit(2); }
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
let failures = 0;
const fail = (msg: string) => { failures++; console.error(`FAIL: ${msg}`); };

type ArmName = "A" | "B";
type Spied = { key: string; digest: string };
type ArmCtx = {
  name: ArmName; dbPath: string; store: Store; client: Client;
  close: () => void; spied: Spied[];
};

async function buildArm(name: ArmName): Promise<ArmCtx> {
  const dbPath = join(bundleDir, `arm-${name}.sqlite`);
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dbPath + s); } catch { /* absent */ } }
  copyFileSync(cacheSnapPath, dbPath);
  Bun.env.INDEX_PATH = dbPath;
  const built = buildMcpServer();
  const spied: Spied[] = [];
  const st = built.store as Store;
  const orig = st.expandQuery;
  (st as { expandQuery: Store["expandQuery"] }).expandQuery = async (q: string, model?: string, intent?: string) => {
    const out = await orig(q, model, intent);
    spied.push({ key: expandQueryCacheKey(q, model, intent), digest: sha256(JSON.stringify(out)) });
    return out;
  };
  const [ct, st2] = InMemoryTransport.createLinkedPair();
  await built.server.connect(st2);
  const client = new Client({ name: `arm-${name}`, version: "0.0.0" });
  await client.connect(ct);
  return { name, dbPath, store: st, client, close: built.closeAllStores, spied };
}

// Census integrity: every frozen census row's pool state re-executes identically on the
// snapshot (T31 MEDIUM-1). Provenance fields are freeze-derived, digest-audited instead.
{
  const cs = createStore(cacheSnapPath, { readonly: true });
  for (const row of manifest.census) {
    const re = censusPoolState(cs, row.query);
    if (JSON.stringify(re) !== JSON.stringify(pickPoolState(row))) fail(`census integrity: "${row.query}" pool state diverged from frozen row`);
  }
  cs.close();
  if (failures > 0) { console.error("EVAL INVALID: census integrity failed."); process.exit(1); }
  console.log(`census integrity ok (${manifest.census.length} rows re-executed identically)`);
}

// Service identity + embedding-geometry gate (T35 HIGH-1): the frozen comparison is only
// valid against the exact services the bundle was frozen with, and a same-name endpoint
// with degraded geometry would disproportionately weaken Arm B's expansion vector legs
// into a false SAFE. Pin URLs to the manifest, then canary the embed geometry against
// the snapshot's stored baseline — pass AND drift-checked are both required.
{
  const cur: Record<string, string | undefined> = {
    embed: process.env.CLAWMEM_EMBED_URL, llm: process.env.CLAWMEM_LLM_URL, rerank: process.env.CLAWMEM_RERANK_URL,
  };
  for (const [k, v] of Object.entries(cur)) {
    if (v !== manifest.services[k]) { console.error(`ABORT: ${k} URL ${v} != frozen manifest ${manifest.services[k]} (H5 service identity)`); process.exit(2); }
  }
  const cs = createStore(cacheSnapPath, { readonly: true });
  const llm = getDefaultLlamaCpp();
  const outcome = await runCanaryBattery(t => llm.embed(t), key => cs.getCanaryBaseline(key));
  cs.close();
  if ("unavailable" in outcome) { console.error(`ABORT: embed canary unavailable — ${outcome.reason}`); process.exit(2); }
  if (!outcome.pass) { console.error(`ABORT: embed canary FAILED — ${outcome.failures.join("; ")}`); process.exit(2); }
  if (!outcome.driftChecked) { console.error(`ABORT: embed canary has no stored baseline for profile ${outcome.profileKey} — geometry drift unverifiable, frozen comparison invalid`); process.exit(2); }
  console.log(`embed canary ok (pass + drift-checked vs stored baseline, profile ${outcome.profileKey})`);
}

// Rerank health gate on a throwaway store over the frozen snapshot (production path, cache-bypassed).
{
  const probeStore = createStore(cacheSnapPath, { readonly: true });
  const health = await probeRerankHealth(probeStore, {});
  probeStore.close();
  if (!health.ok) { console.error(`ABORT: rerank-health failed — ${health.failures.join("; ")} (an inert reranker invalidates the A/B)`); process.exit(2); }
  console.log(`rerank-health ok (minMargin ${health.minMargin.toFixed(3)}, ${health.pairsScored}/${health.pairsTotal} pairs)`);
}

const armA = await buildArm("A");
const armB = await buildArm("B");

// Pre-flight: every frozen key + digest present in BOTH arm copies.
for (const arm of [armA, armB]) {
  for (const c of manifest.cases) {
    const row = arm.store.db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(c.expansionKey) as { result: string } | null;
    if (!row || sha256(row.result) !== c.variantsDigest) fail(`pre-flight[${arm.name}] ${c.id}: frozen expansion row missing/drifted`);
  }
}
if (failures > 0) { console.error("EVAL INVALID: pre-flight failed."); process.exit(1); }

type CaseRun = { id: string; stratum: Stratum; query: string; rankA: number | null; rankB: number | null; msA: number; msB: number; firedA: boolean; pathsA: string[]; pathsB: string[] };
const runs: CaseRun[] = [];

async function callArm(arm: ArmCtx, c: FrozenCase): Promise<{ rank: number | null; ms: number; invocations: Spied[]; paths: string[] }> {
  if (arm.name === "B") process.env.CLAWMEM_DISABLE_FTS_BYPASS = "true";
  else delete process.env.CLAWMEM_DISABLE_FTS_BYPASS;
  const before = arm.spied.length;
  const t0 = performance.now();
  const res = await arm.client.callTool({ name: "query", arguments: { query: c.query, compact: false, limit: 10 } }) as { structuredContent?: { results?: { file: string }[] } };
  const ms = performance.now() - t0;
  delete process.env.CLAWMEM_DISABLE_FTS_BYPASS;
  const paths = (res.structuredContent?.results ?? []).map(r => r.file);
  const idx = c.targets ? paths.findIndex(p => c.targets!.some(t => p.includes(t))) : -1;
  return { rank: idx >= 0 ? idx + 1 : null, ms, invocations: arm.spied.slice(before), paths };
}

for (let i = 0; i < manifest.cases.length; i++) {
  const c = manifest.cases[i]!;
  const order: ArmCtx[] = i % 2 === 0 ? [armA, armB] : [armB, armA];
  const results: Partial<Record<ArmName, Awaited<ReturnType<typeof callArm>>>> = {};
  for (const arm of order) results[arm.name] = await callArm(arm, c);
  const ra = results.A!, rb = results.B!;

  // Consumption verification (H3.2, T28 M1): key-equality + digest on every invocation.
  for (const [arm, r] of [["A", ra], ["B", rb]] as const) {
    for (const inv of r.invocations) {
      if (inv.key !== c.expansionKey) fail(`${c.id}[${arm}]: expandQuery invoked with a DIFFERENT cache key than the manifest (argument drift)`);
      else if (inv.digest !== c.variantsDigest) fail(`${c.id}[${arm}]: consumed variants digest != frozen (live resample or fallback leak)`);
    }
  }
  // Arm B always expands exactly once; Arm A expands iff the bypass did not fire.
  if (rb.invocations.length !== 1) fail(`${c.id}[B]: expected exactly 1 expansion invocation, saw ${rb.invocations.length}`);
  const firedA = ra.invocations.length === 0;
  if (c.fired !== firedA) fail(`${c.id}[A]: pool-derived fired=${c.fired} but observed ${firedA ? "bypass" : "expansion"} (deterministic mismatch)`);

  runs.push({ id: c.id, stratum: c.stratum, query: c.query, rankA: ra.rank, rankB: rb.rank, msA: Math.round(ra.ms), msB: Math.round(rb.ms), firedA, pathsA: ra.paths, pathsB: rb.paths });
}

// Post-flight: frozen rows still present + unchanged in both arm copies.
for (const arm of [armA, armB]) {
  for (const c of manifest.cases) {
    const row = arm.store.db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(c.expansionKey) as { result: string } | null;
    if (!row || sha256(row.result) !== c.variantsDigest) fail(`post-flight[${arm.name}] ${c.id}: frozen expansion row missing/changed`);
  }
}

// Controls: arm identity (knob is the only difference; non-fire → identical paths).
for (const r of runs.filter(r => r.stratum === "control")) {
  if (JSON.stringify(r.pathsA) !== JSON.stringify(r.pathsB)) fail(`control ${r.id}: arm outputs differ — knob leak or nondeterminism`);
}

// Stratum metrics over effective samples (H6 definitions).
type StratumStats = {
  S: number; bothAbsent: number; e: number; coverageOk: boolean;
  bypassDropouts: number; armBAbsent: number; hardRegressions: number;
  mrrA: number; mrrB: number;
};
function stats(stratum: Stratum): StratumStats {
  const rows = runs.filter(r => r.stratum === stratum && r.stratum !== "control");
  const S = rows.length;
  const bothAbsent = rows.filter(r => r.rankA === null && r.rankB === null).length;
  const eRows = rows.filter(r => !(r.rankA === null && r.rankB === null));
  const e = eRows.length;
  const mrr = (k: "rankA" | "rankB") => e === 0 ? 0 : eRows.reduce((s, r) => s + (r[k] ? 1 / r[k]! : 0), 0) / e;
  return {
    S, bothAbsent, e, coverageOk: S === 0 || e >= GATES.coverage(S),
    bypassDropouts: eRows.filter(r => r.rankA === null && r.rankB !== null).length,
    armBAbsent: eRows.filter(r => r.rankA !== null && r.rankB === null).length,
    hardRegressions: eRows.filter(r => r.rankA !== null && r.rankB !== null && r.rankA > r.rankB + 2).length,
    mrrA: mrr("rankA"), mrrB: mrr("rankB"),
  };
}
const N = stats("N"), X = stats("X");

console.log(`\n=== Stratum tables (paired rankA → rankB; A = bypass active) ===`);
for (const r of runs.filter(r => r.stratum !== "control")) {
  console.log(`  [${r.stratum}] ${r.id} fired=${r.firedA} ${r.rankA ?? "—"} → ${r.rankB ?? "—"}  ${r.msA}ms/${r.msB}ms  "${r.query.slice(0, 50)}"`);
}
const fmt = (s: StratumStats, name: string) =>
  console.log(`  ${name}: |S|=${s.S} bothAbsent=${s.bothAbsent} e=${s.e} coverage=${s.coverageOk} dropouts=${s.bypassDropouts} armBAbsent=${s.armBAbsent} hardRegr=${s.hardRegressions} MRR A=${s.mrrA.toFixed(3)} B=${s.mrrB.toFixed(3)} Δ=${(s.mrrA - s.mrrB).toFixed(3)}`);
fmt(N, "N"); fmt(X, "X");

console.log(`\n=== Firing + latency report ===`);
console.log(`  arm-A observed firings: ${runs.filter(r => r.firedA).length}/${runs.length} cases (controls included)`);
const lat = (rows: CaseRun[], k: "msA" | "msB") => rows.length === 0 ? 0 : Math.round(rows.reduce((s, r) => s + r[k], 0) / rows.length);
const firedRuns = runs.filter(r => r.firedA);
console.log(`  fired cases: mean A ${lat(firedRuns, "msA")}ms (bypass) vs B ${lat(firedRuns, "msB")}ms (warm-expansion-cache)`);
console.log(`  freeze-time uncached expansion: mean ${Math.round(manifest.cases.reduce((s, c) => s + c.latencyUncachedMs, 0) / manifest.cases.length)}ms`);
console.log(`\n=== Frozen-census firing + near-fire report (T31 HIGH-1/MEDIUM-2) ===`);
const cJudged = manifest.census.filter(r => r.src === "judged");
const cProbe = manifest.census.filter(r => r.src === "probe");
const nFired = (rows: CensusRow[]) => rows.filter(r => r.fired).length;
console.log(`  firings on frozen census: ${nFired(manifest.census)}/${manifest.census.length} — judged set ${nFired(cJudged)}/${cJudged.length} · firing-hunt probes ${nFired(cProbe)}/${cProbe.length}`);
console.log(`  (frozen-corpus characterization only — probes were selected to hunt firings; production firing prevalence is UNKNOWN without sampled query logs)`);
for (const nf of manifest.census.filter(r => r.band === "near-gap" || r.band === "near-strength")) {
  console.log(`  [${nf.band}] "${nf.query}" top=${(nf.top ?? "-").slice(0, 60)} score=${nf.topScore!.toFixed(3)} gap=${nf.gap!.toFixed(3)} topCorrect=${nf.topCorrect === null ? "UNJUDGED" : nf.topCorrect} (${nf.judgedBy ?? "unjudged"})`);
}

// H6 gates + verdict precedence.
const gateViolations: string[] = [];
if (N.S > 0 && N.e > 0) {
  if (N.mrrA - N.mrrB < GATES.epsN) gateViolations.push(`N ΔMRR ${(N.mrrA - N.mrrB).toFixed(3)} < ${GATES.epsN}`);
  if (N.hardRegressions > GATES.allowN(N.e)) gateViolations.push(`N hard regressions ${N.hardRegressions} > ${GATES.allowN(N.e)}`);
}
if (X.S > 0 && X.e > 0) {
  if (X.mrrA - X.mrrB < GATES.epsX) gateViolations.push(`X ΔMRR ${(X.mrrA - X.mrrB).toFixed(3)} < ${GATES.epsX}`);
  if (X.hardRegressions > GATES.allowX(X.e)) gateViolations.push(`X hard regressions ${X.hardRegressions} > ${GATES.allowX(X.e)}`);
}
const anyDropout = N.bypassDropouts + X.bypassDropouts > 0;
const coverageFail = !N.coverageOk || !X.coverageOk;

if (failures > 0) { console.error(`\nEVAL INVALID: ${failures} integrity failure(s) — no verdict.`); process.exit(1); }
console.log(`\n=== VERDICT (H6 precedence) ===`);
if (anyDropout || gateViolations.length > 0) {
  console.log(`NOT SAFE — ${anyDropout ? `bypass-dropouts: N=${N.bypassDropouts} X=${X.bypassDropouts}; ` : ""}${gateViolations.join("; ")}`);
} else if (N.S === 0 || coverageFail) {
  console.log(`INCONCLUSIVE — ${N.S === 0 ? "|N| = 0 (natural-case safety unmeasured)" : "coverage floor failure"}; thresholds stand by default but are marked unvalidated.`);
} else {
  console.log(`SAFE ON FROZEN CENSUS (n=${N.e + X.e} fired; zero-allowance gates); population risk unvalidated — thresholds 0.85/0.15 stand on this census.`);
}
process.exit(0);
