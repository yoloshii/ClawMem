/**
 * BUILD-1 lane mechanics through the REAL contextSurfacing handler
 * (codex turn-6 STANDARDS-4): vector+FTS fusion, the gated prior-vector leg,
 * expansion re-fusion, rerank success/failure interaction with the
 * CONTRACT-1(d) guard, and secondary-vault fusion. Inference is stubbed at
 * the STORE boundary (searchVec / expandQuery / rerank) so the handler's own
 * wiring — searchVecBounded fallback, lane collection, membership, guard —
 * runs for real on a GPU-less host.
 */
import { stubSearchVec } from "../helpers/vec-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { newSurfacingTrace } from "../../src/eval/hook-trace.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import { createStore, type Store, type SearchResult } from "../../src/store.ts";
import { clearConfigCache } from "../../src/config.ts";
import { vecDaemonSocketPath } from "../../src/vector-daemon.ts";

const ENV_KEYS = [
  "CLAWMEM_PROFILE", "CLAWMEM_HOOK_DEDUP_WINDOW_SEC", "CLAWMEM_PRIOR_VECTOR_INPROC",
  "CLAWMEM_SURFACE_SECONDARY_VAULTS", "CLAWMEM_VAULTS", "CLAWMEM_SESSION_FOCUS",
  "CLAWMEM_EVAL_NOW", "CLAWMEM_VECTOR_DAEMON_REQUIRED", "CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  delete process.env.CLAWMEM_SESSION_FOCUS;
  process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
  clearConfigCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  clearConfigCache();
});

/** Build a vec-channel SearchResult for a seeded doc. */
function vecResult(store: Store, displayPath: string, score: number): SearchResult {
  const row = store.db.prepare(
    `SELECT d.collection, d.path, d.title, d.hash, c.doc as body, d.modified_at
       FROM documents d JOIN content c ON c.hash = d.hash
      WHERE d.collection || '/' || d.path = ? AND d.active = 1`
  ).get(displayPath) as { collection: string; path: string; title: string; hash: string; body: string; modified_at: string };
  return {
    filepath: `clawmem://${row.collection}/${row.path}`,
    displayPath,
    title: row.title,
    hash: row.hash,
    docid: `doc-${row.hash}`,
    collectionName: row.collection,
    modifiedAt: row.modified_at,
    bodyLength: row.body.length,
    body: row.body,
    context: "",
    score,
    source: "vec",
  } as unknown as SearchResult;
}

describe("BUILD-1 lanes through the real handler", () => {
  it("fuses the stubbed vector leg with the FTS supplement (balanced)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/vector-hit.md", title: "Deployment pipeline rollback design", body: "How we roll back a bad deployment of the pipeline service safely.", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/keyword-hit.md", title: "deployment pipeline rollback checklist", body: "deployment pipeline rollback checklist for the release train operators", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => [vecResult(store, "test/m/vector-hit.md", 0.55)]);

    process.env.CLAWMEM_PROFILE = "balanced";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "deployment pipeline rollback checklist", sessionId: "lanes-vec" }, { trace });

    const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
    expect(lanes.has("vector")).toBe(true);
    expect(lanes.has("fts-supplement")).toBe(true);
    expect(trace.finalPaths).toContain("test/m/vector-hit.md");
    expect(trace.finalPaths).toContain("test/m/keyword-hit.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-vec'`).run();
  }, 20_000);

  it("runs the gated prior-vector + prior-fts lanes on an anaphoric prompt (in-process override)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/prior-doc.md", title: "OAuth rotation rationale", body: "The oauth refresh token rotation decision rationale in depth.", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    // The prior's vocabulary reaches the doc; the current prompt's does not.
    store.insertUsage({
      sessionId: "lanes-prior", timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
      hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
      turnIndex: 0, queryText: "the oauth refresh token rotation decision rationale",
    });
    let priorVecQueries = 0;
    stubSearchVec(store, async (query: string) => {
      priorVecQueries++;
      // Return the doc only for the joined-priors query, not the current prompt.
      return query.includes("oauth") ? [vecResult(store, "test/m/prior-doc.md", 0.5)] : [];
    });

    process.env.CLAWMEM_PROFILE = "balanced";
    process.env.CLAWMEM_PRIOR_VECTOR_INPROC = "1";
    const trace = newSurfacingTrace();
    // Current prompt shares "rationale"/"depth" vocabulary with the doc, so the
    // CONTRACT-1(d) per-candidate gate passes while FTS on the full prompt misses.
    await contextSurfacing(store, { prompt: "Can you explain that rationale in a bit more depth please", sessionId: "lanes-prior" }, { trace });

    expect(trace.priorLeg?.enabled).toBe(true);
    expect(priorVecQueries).toBeGreaterThanOrEqual(2); // current leg + prior leg
    const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
    expect(lanes.has("prior-fts")).toBe(true);
    expect(lanes.has("prior-vector")).toBe(true);
    expect(trace.finalPaths).toContain("test/m/prior-doc.md");
    // BUILD-4 (t52-F1 lock): the certified-prior path went through RELEVANCE
    // admission — zero current mass, band-1 prior doc admitted under its own
    // floor, no abstention.
    expect(trace.admission?.mode).toBe("relevance");
    expect(trace.admission?.abstainReason ?? null).toBeNull();
    const priorAdm = trace.admission!.admitted.find(e => e.displayPath === "test/m/prior-doc.md");
    expect(priorAdm?.band).toBe(1);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-prior'`).run();
  }, 20_000);

  it("skips prior-vector without the daemon or the override, keeping prior-fts", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/prior-doc2.md", title: "rationale depth notes", body: "rationale depth notes covering the oauth refresh token rotation decision rationale", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    store.insertUsage({
      sessionId: "lanes-prior2", timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
      hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
      turnIndex: 0, queryText: "oauth refresh token rotation decision rationale",
    });
    const vecQueries: string[] = [];
    stubSearchVec(store, async (query: string) => { vecQueries.push(query); return []; });

    process.env.CLAWMEM_PROFILE = "balanced";
    delete process.env.CLAWMEM_PRIOR_VECTOR_INPROC;
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "Can you explain that rationale in a bit more depth please", sessionId: "lanes-prior2" }, { trace });

    expect(trace.priorLeg?.enabled).toBe(true);
    const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
    expect(lanes.has("prior-fts")).toBe(true);
    expect(lanes.has("prior-vector")).toBe(false); // daemon-less: supplementary vector leg skipped
    expect(vecQueries.length).toBe(1); // only the primary current leg
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-prior2'`).run();
  }, 20_000);

  it("CLAWMEM_VECTOR_DAEMON_REQUIRED=1 (the replay-eval's daemon-backed protocol): the PRIMARY leg is daemon-required — a stale socket yields [] + a recorded 'absent' path and the in-process scan is NEVER entered (codex t76 constraint 4)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/req-doc.md", title: "oauth refresh rotation", body: "oauth refresh token rotation decision for the auth service", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    let inprocScans = 0;
    stubSearchVec(store, async () => { inprocScans++; return []; });

    const savedXdg = process.env.XDG_RUNTIME_DIR;
    const fakeRuntime = mkdtempSync(join(tmpdir(), "clawmem-req-sock-"));
    process.env.XDG_RUNTIME_DIR = fakeRuntime;
    try {
      const sockPath = vecDaemonSocketPath(store.dbPath);
      mkdirSync(dirname(sockPath), { recursive: true });
      writeFileSync(sockPath, ""); // stale: exists, refuses connections
      process.env.CLAWMEM_PROFILE = "balanced";
      process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED = "1";
      // Were the bridge reverted to searchVecBounded, the absent branch would
      // busy-wait here for 3000ms AND call store.searchVec — both must not happen.
      process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS = "3000";
      const trace = newSurfacingTrace();
      const t0 = Date.now();
      await contextSurfacing(store, { prompt: "oauth refresh token rotation decision for the auth service", sessionId: "lanes-required" }, { trace });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(inprocScans).toBe(0);
      expect(trace.vectorLegs).toEqual([{ leg: "primary", path: "absent" }]);
      const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
      expect(lanes.has("vector")).toBe(false);
      expect(lanes.has("fts-fallback")).toBe(true);
      expect(trace.finalPaths).toContain("test/m/req-doc.md");
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = savedXdg;
      rmSync(fakeRuntime, { recursive: true, force: true });
    }
  });

  it("a STALE daemon socket never routes the prior leg into the in-process scan (codex turn-7 F1)", async () => {
    // A socket file exists (so the cheap pre-check passes) but nothing
    // listens — connect is refused. searchVecDaemonRequired must return []
    // for the prior leg: prior-vector lane absent, and store.searchVec is
    // reached ONLY by the primary current leg, never with the priors.
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/prior-doc3.md", title: "rationale depth notes", body: "rationale depth notes covering the oauth refresh token rotation decision rationale", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    store.insertUsage({
      sessionId: "lanes-stale", timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
      hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
      turnIndex: 0, queryText: "oauth refresh token rotation decision rationale",
    });
    const vecQueries: string[] = [];
    stubSearchVec(store, async (query: string) => { vecQueries.push(query); return []; });

    const savedXdg = process.env.XDG_RUNTIME_DIR;
    const fakeRuntime = mkdtempSync(join(tmpdir(), "clawmem-stale-sock-"));
    process.env.XDG_RUNTIME_DIR = fakeRuntime;
    try {
      const sockPath = vecDaemonSocketPath(store.dbPath);
      mkdirSync(dirname(sockPath), { recursive: true });
      writeFileSync(sockPath, ""); // plain file: exists, refuses connections

      process.env.CLAWMEM_PROFILE = "balanced";
      delete process.env.CLAWMEM_PRIOR_VECTOR_INPROC;
      const trace = newSurfacingTrace();
      await contextSurfacing(store, { prompt: "Can you explain that rationale in a bit more depth please", sessionId: "lanes-stale" }, { trace });

      expect(trace.priorLeg?.enabled).toBe(true);
      const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
      expect(lanes.has("prior-fts")).toBe(true);
      expect(lanes.has("prior-vector")).toBe(false); // daemon-required leg returned []
      // The in-process scan was never reached with the priors' query — only
      // the PRIMARY leg (whose in-process fallback is the designed behavior)
      // touched store.searchVec, with the current prompt.
      expect(vecQueries.some(q => q.includes("oauth"))).toBe(false);
      expect(vecQueries.length).toBe(1);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
      rmSync(fakeRuntime, { recursive: true, force: true });
      store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-stale'`).run();
    }
  }, 20_000);

  it("pure-anaphora prompt: candidates are gated against PRIOR tokens, not passed vacuously (codex turn-7 F3)", async () => {
    // "okay now please do that again" carries ZERO content tokens. The prior
    // leg supplies the meaning; the per-candidate gate must check each
    // candidate against the PRIOR's vocabulary and drop the off-topic
    // prior-only candidate on the no-rerank (balanced) path.
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/on-topic.md", title: "Ranking defect handoff", body: "composite scoring ranking defect diagnosis notes for the memory hook", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/off-topic.md", title: "weaving", body: "basket weaving supplies inventory and reorder cadence", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
    ]);
    store.insertUsage({
      sessionId: "lanes-anaphora", timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
      hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
      turnIndex: 0, queryText: "clawmem ranking defect composite scoring diagnosis",
    });
    stubSearchVec(store, async () => []);
    // The prior's FTS list returns BOTH docs (simulating a polluted lane);
    // the current prompt's own FTS finds nothing (all stopwords).
    const realSearchFTS = store.searchFTS.bind(store);
    store.searchFTS = (query: string, limit?: number) => {
      if (query.includes("ranking")) {
        return [
          ...realSearchFTS("ranking defect composite", 5),
          ...realSearchFTS("basket weaving supplies", 5),
        ];
      }
      return [];
    };

    process.env.CLAWMEM_PROFILE = "balanced";
    process.env.CLAWMEM_PRIOR_VECTOR_INPROC = "1";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "okay now please do that again", sessionId: "lanes-anaphora" }, { trace });

    expect(trace.priorLeg?.enabled).toBe(true);
    expect(trace.fusion!.gateTokenSource).toBe("prior");
    const offTopic = trace.fusion!.candidates.find(c => c.displayPath === "test/m/off-topic.md");
    expect(offTopic).toBeDefined();
    expect(offTopic!.currentQueryGatePassed).toBe(false);
    const onTopic = trace.fusion!.candidates.find(c => c.displayPath === "test/m/on-topic.md");
    expect(onTopic!.currentQueryGatePassed).toBe(true);
    expect(trace.finalPaths).toContain("test/m/on-topic.md");
    expect(trace.finalPaths).not.toContain("test/m/off-topic.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-anaphora'`).run();
  }, 20_000);

  it("deep: expansion re-fuses and a successful rerank arbitrates expansion-only candidates", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/base1.md", title: "release train cadence", body: "release train cadence and stage gates for the platform", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/base2.md", title: "release train ownership", body: "release train cadence ownership and the platform stage gates responsibilities", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/exp-only.md", title: "cadence retrospective summary", body: "retrospective summary of cadence changes across quarters", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [{ type: "lex", query: "cadence retrospective" } as { type: string; query: string }] as Awaited<ReturnType<Store["expandQuery"]>>;
    store.rerank = async (_q, docs) => docs.map((d, i) => ({ file: d.file, score: 0.9 - i * 0.1 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "release train cadence stage gates platform", sessionId: "lanes-deep-ok" }, { trace });

    const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
    expect(lanes.has("expansion-lex")).toBe(true);          // re-fusion included the expansion lane
    expect(trace.rerank?.orderingApplied).toBe(true);
    // BUILD-4 (t52-F4): arbitration carries the expansion-only candidate past
    // the guard into ADMISSION — where the C4 band contract rejects it
    // (discounted-only never enters output beside current evidence).
    const expEntry = trace.admission!.rejected.find(e => e.displayPath === "test/m/exp-only.md");
    expect(expEntry?.reason).toBe("band-floor");
    expect(expEntry?.band).toBe(1);
    expect(trace.finalPaths).not.toContain("test/m/exp-only.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-deep-ok'`).run();
  }, 20_000);

  it("deep: rerank evidence enters ONLY the ordering key — raw channel scores are never blended (BUILD-2, supersedes the codex turn-10 F2 blend contract)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/raw1.md", title: "cadence stage gates", body: "release train cadence and stage gates for the platform team", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/raw2.md", title: "cadence ownership", body: "release train cadence ownership and platform stage gates responsibilities", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/raw3.md", title: "cadence checklist", body: "release train cadence checklist for platform stage gates operators", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
    ]);
    const RAW_VEC_SCORE = 0.5;
    stubSearchVec(store, async () => [vecResult(store, "test/m/raw1.md", RAW_VEC_SCORE)]);
    store.expandQuery = async () => [] as Awaited<ReturnType<Store["expandQuery"]>>;
    // The reranker inverts the FTS preference: raw3 (weakest by fusion) gets
    // the TOP rerank score — its effect must appear in the ORDER, not in any
    // stored score.
    const RERANK_TOP = "test/m/raw3.md";
    // Match on the TRANSMITTED id (candidateKey = the scheme-qualified
    // filepath), not the bare displayPath — the bare compare never matched,
    // so this stub silently returned a CONSTANT 0.2 set and the "inverted
    // preference" was never exercised (exposed by the BUILD-3d degeneracy
    // gate, which now discards constant sets).
    store.rerank = async (_q, docs) => docs.map(d => ({ file: d.file, score: d.file.endsWith(RERANK_TOP) ? 0.95 : 0.2 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "release train cadence stage gates platform", sessionId: "lanes-rawscore" }, { trace });

    expect(trace.rerank?.orderingApplied).toBe(true);
    // The LEG-level provenance records the raw channel score…
    const legHit = trace.candidates.find(c => c.leg === "vector" && c.displayPath === "test/m/raw1.md");
    expect(legHit).toBeDefined();
    expect(legHit!.rawScore).toBe(RAW_VEC_SCORE);
    // …and the composite record now ALSO carries the raw score — BUILD-2
    // deleted the 0.6/0.4 blend; rerank evidence is rank-fused into the
    // final ordering key instead of mutating any score field.
    const compositeEntry = trace.composite.find(c => c.displayPath === "test/m/raw1.md");
    expect(compositeEntry).toBeDefined();
    expect(compositeEntry!.searchScore).toBe(RAW_VEC_SCORE);
    // The ordering authority is the rank-fused key: rankingKey "rerank",
    // per-candidate key values recorded, and the injected order is
    // non-increasing in the key.
    expect(trace.rankingKey).toBe("rerank");
    expect(trace.finalOrder).not.toBeNull();
    const keyByPath = new Map(trace.finalOrder!.map(e => [e.displayPath, e.keyValue]));
    for (let i = 1; i < trace.finalPaths.length; i++) {
      expect(keyByPath.get(trace.finalPaths[i]!)!).toBeLessThanOrEqual(keyByPath.get(trace.finalPaths[i - 1]!)!);
    }
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-rawscore'`).run();
  }, 20_000);

  it("deep: PARTIAL rerank coverage is discarded for ordering (pure RRF key) and the failure guard arbitrates (BUILD-2/CONTRACT-3)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/pc1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/pc2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // Shares ZERO content vocabulary with the current prompt → gate fails.
      { path: "m/pc-junk.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [{ type: "lex", query: "gardening almanac" } as { type: string; query: string }] as Awaited<ReturnType<Store["expandQuery"]>>;
    // The reranker ANSWERS but covers only a strict subset of what it was
    // sent — a partially-covered pool must never be partially reordered.
    store.rerank = async (_q, docs) => docs.slice(0, 1).map(d => ({ file: d.file, score: 0.9 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-partial-cov" }, { trace });

    expect(trace.rerank?.attempted).toBe(true);
    expect(trace.rerank?.orderingApplied ?? false).toBe(false); // partial coverage → NOT applied
    expect(trace.rankingKey).toBe("rrf");                    // ordering fell back to the pure fusion key
    // Unarbitrated expansion-only junk was dropped by the failure guard —
    // a partial rerank is NOT arbitration.
    expect(trace.finalPaths).not.toContain("test/m/pc-junk.md");
    expect(trace.finalPaths).toContain("test/m/pc1.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-partial-cov'`).run();
  }, 20_000);

  it("deep: rerank failure drops gate-failing expansion-only candidates (CONTRACT-1d guard)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/base3.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/base4.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // Shares ZERO content vocabulary with the current prompt → gate fails.
      { path: "m/exp-junk.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [{ type: "lex", query: "gardening almanac" } as { type: string; query: string }] as Awaited<ReturnType<Store["expandQuery"]>>;
    store.rerank = async () => { throw new Error("reranker down"); };

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-deep-fail" }, { trace });

    expect(trace.rerank?.failed ?? false).toBe(true);
    expect(trace.finalPaths).not.toContain("test/m/exp-junk.md"); // dropped: no current support, gate failed, no arbitration
    expect(trace.finalPaths).toContain("test/m/base3.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-deep-fail'`).run();
  }, 20_000);

  it("BUILD-2/F1: a PARTIAL remote rerank response is refused at the PRODUCTION zero-fill seam (real store.rerank + HTTP stub)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/zf1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/zf2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/zf-junk.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [{ type: "lex", query: "gardening almanac" } as { type: string; query: string }] as Awaited<ReturnType<Store["expandQuery"]>>;
    // store.rerank is NOT stubbed: the request goes through the store's real
    // remote path, whose default contract ZERO-FILLS omitted documents and
    // returns the complete list — pre-fix, this partial response arrived at
    // the handler as apparent full coverage and partially reordered the pool.
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { documents: string[] };
        // Score ONLY the first document — a strict subset of what was sent.
        void body;
        return Response.json({ results: [{ index: 0, relevance_score: 0.9 }] });
      },
    });
    const priorRerankUrl = process.env.CLAWMEM_RERANK_URL;
    const priorNoLocalModels = process.env.CLAWMEM_NO_LOCAL_MODELS;
    try {
      process.env.CLAWMEM_RERANK_URL = `http://127.0.0.1:${stub.port}`;
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true"; // a local fallback would mask the seam
      process.env.CLAWMEM_PROFILE = "deep";
      const trace = newSurfacingTrace();
      await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-zerofill" }, { trace });

      // requireLiveCoverage makes the store THROW before the zero-fill — the
      // rerank is discarded for ordering and the failure guard arbitrates.
      expect(trace.rerank?.attempted).toBe(true);
      expect(trace.rerank?.orderingApplied ?? false).toBe(false);
      expect(trace.rankingKey).toBe("rrf");
      expect(trace.finalPaths).not.toContain("test/m/zf-junk.md");
      expect(trace.finalPaths).toContain("test/m/zf1.md");
      store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-zerofill'`).run();
    } finally {
      stub.stop(true);
      if (priorRerankUrl === undefined) delete process.env.CLAWMEM_RERANK_URL;
      else process.env.CLAWMEM_RERANK_URL = priorRerankUrl;
      if (priorNoLocalModels === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
      else process.env.CLAWMEM_NO_LOCAL_MODELS = priorNoLocalModels;
    }
  }, 20_000);

  it("BUILD-2/F4: a discounted-only doc that OUT-MASSES the best current hit still orders BELOW every current-anchored doc (band)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/cb1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/cb2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // Shares ONE token with the prompt ("enterprise") so the per-candidate
      // gate passes and it survives the failure guard — but it is
      // expansion-only, and rank-0 in THREE variants out-masses cb1's single
      // current rank-0 contribution (codex turn-14 finding 4 arithmetic).
      { path: "m/cb-exp.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows for enterprise gardens", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [
      { type: "lex", query: "gardening almanac" },
      { type: "lex", query: "almanac planting" },
      { type: "lex", query: "planting windows" },
    ] as Awaited<ReturnType<Store["expandQuery"]>>;
    store.rerank = async () => { throw new Error("reranker down"); }; // no arbitration — bands decide

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-band" }, { trace });

    const exp = "test/m/cb-exp.md";
    // The pool genuinely carries it, and its summed expansion mass EXCEEDS
    // the best current-anchored mass — the pre-BUILD-2 mass-only key would
    // have put it FIRST. The band evidence lives in the fusion record…
    const cand = trace.fusion!.candidates.find(c => c.displayPath === exp)!;
    expect(cand.admitted).toBe(true);          // membership: it reached the pool
    expect(cand.currentSupported).toBe(false); // …as a discounted-only (band-1) candidate
    const bestCurrent = Math.max(...trace.fusion!.candidates.filter(c => c.currentSupported).map(c => c.contribution));
    expect(cand.contribution).toBeGreaterThan(bestCurrent);
    // …and BUILD-4 (t52-F4) finishes the job: discounted-only never enters
    // output beside current evidence — rejected at admission, not ordered last.
    const rj = trace.admission!.rejected.find(e => e.displayPath === exp);
    expect(rj?.reason).toBe("band-floor");
    expect(trace.finalPaths).not.toContain(exp);
    expect(trace.finalOrder!.every(e => e.band === 0)).toBe(true);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-band'`).run();
  }, 20_000);

  it("BUILD-2/F5: deep pools larger than 15 are reranked COMPLETELY — full coverage is attainable at the 20-candidate pool bound", async () => {
    const store = createTestStore();
    // 15 docs saturate the current FTS leg (deep maxResults = 15)…
    seedDocuments(store, Array.from({ length: 15 }, (_, i) => ({
      path: `m/pool${i}.md`,
      title: `release train cadence entry ${i}`,
      body: `release train cadence and stage gates for the platform team entry ${i}`,
      contentType: "decision" as const,
      confidence: 0.9,
      qualityScore: 0.8,
    })));
    // …and 3 more arrive only through the expansion lane (they share
    // "cadence" with the prompt so the gate passes).
    seedDocuments(store, Array.from({ length: 3 }, (_, i) => ({
      path: `m/extra${i}.md`,
      title: `quarterly cadence retrospective ${i}`,
      body: `quarterly retrospective summary of cadence adjustments volume ${i}`,
      contentType: "note" as const,
      confidence: 0.9,
      qualityScore: 0.8,
    })));
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [{ type: "lex", query: "quarterly retrospective summary" } as { type: string; query: string }] as Awaited<ReturnType<Store["expandQuery"]>>;
    store.rerank = async (_q, docs) => docs.map((d, i) => ({ file: d.file, score: 0.9 - i * 0.01 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "release train cadence stage gates platform", sessionId: "lanes-bigpool" }, { trace });

    // The pool exceeded the old fixed 15-slice — the COMPLETE pool was sent,
    // so full coverage (and the rerank ordering lane) is attainable.
    // Pre-fix, sentPaths was capped at 15, coverage could never be full for
    // a 16+ pool, and the rerank lane was always discarded.
    expect(trace.rerank?.sentPaths.length ?? 0).toBeGreaterThan(15);
    expect(trace.rerank?.orderingApplied).toBe(true);
    expect(trace.rankingKey).toBe("rerank");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-bigpool'`).run();
  }, 20_000);

  it("BUILD-2: the channel-aware key orders the output — a pinned doc composite favors no longer outranks a better-keyed doc", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      // Dense match on every prompt token → best FTS rank → best fusion key.
      { path: "m/keyed.md", title: "release calendar freeze window policy", body: "release calendar freeze window policy for the release calendar freeze window", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // Matches every token once in a longer body → worse FTS rank — but PINNED,
      // so the composite score (+0.3 pin boost) strongly favors it.
      { path: "m/pinned.md", title: "ops notes", body: "notes about the release calendar and the freeze window policy among many other operational topics discussed at length across the quarter including oncall rotations and postmortem templates", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    store.db.prepare(`UPDATE documents SET pinned = 1 WHERE path = 'm/pinned.md'`).run();

    process.env.CLAWMEM_PROFILE = "speed";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "release calendar freeze window policy", sessionId: "lanes-key-order" }, { trace });

    const keyed = "test/m/keyed.md", pinned = "test/m/pinned.md";
    expect(trace.finalPaths).toContain(keyed);
    expect(trace.finalPaths).toContain(pinned);
    // Composite (with the pin boost) prefers the pinned doc…
    const comp = new Map(trace.composite.map(c => [c.displayPath, c.compositeScore]));
    expect(comp.get(pinned)!).toBeGreaterThan(comp.get(keyed)!);
    // …but the FINAL order follows the channel-aware key: the dense FTS
    // match is injected first. Pre-BUILD-2 (composite ordering) this
    // assertion fails — the pinned doc led.
    expect(trace.finalPaths.indexOf(keyed)).toBeLessThan(trace.finalPaths.indexOf(pinned));
    expect(trace.rankingKey).toBe("rrf");
    const keys = new Map(trace.finalOrder!.map(e => [e.displayPath, e.keyValue]));
    expect(keys.get(keyed)!).toBeGreaterThan(keys.get(pinned)!);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-key-order'`).run();
  }, 20_000);

  it("fuses the secondary-vault lane when enabled (env opt-in + named vault)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/general.md", title: "scraper skill routing", body: "scraper skill routing decision for the toolchain", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    // Secondary vault on disk, seeded with a doc matching the prompt.
    const skillDir = mkdtempSync(join(tmpdir(), "hook-lanes-skill-"));
    const skillPath = join(skillDir, "skill.sqlite");
    const skillStore = createStore(skillPath);
    seedDocuments(skillStore as Store, [
      { path: "obs/scraper-observation.md", title: "scraper skill observation", body: "observation about the scraper skill routing decision toolchain outcomes", collection: "skillobs", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);

    process.env.CLAWMEM_PROFILE = "speed";
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "true";
    process.env.CLAWMEM_VAULTS = JSON.stringify({ skill: skillPath });
    clearConfigCache();

    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "scraper skill routing decision toolchain", sessionId: "lanes-secondary" }, { trace });

    const lanes = new Set(trace.fusion!.lanes.map(l => l.lane));
    expect(lanes.has("secondary-vault")).toBe(true);
    expect(trace.finalPaths).toContain("skillobs/obs/scraper-observation.md");
    expect(trace.finalPaths).toContain("test/m/general.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-secondary'`).run();
  }, 20_000);

  it("BUILD-2/F16-2: a fully-covering but INERT reranker that top-ranks expansion-only junk STILL cannot elevate it out of band 1 (handler boundary)", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/ib1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/ib2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // Expansion-only, gate-passing junk (shares only "enterprise").
      { path: "m/ib-exp.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows for enterprise gardens", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [{ type: "lex", query: "gardening almanac planting" }] as Awaited<ReturnType<Store["expandQuery"]>>;
    // The reranker ANSWERS for the whole pool (full coverage → applied) but is
    // DEGENERATE: it top-ranks the expansion-only junk. Coverage is not
    // discrimination (codex turn-15) — the current-anchor band must hold. This
    // is the inert-reranker attack at the REAL handler, not the unit helper.
    const JUNK = "test/m/ib-exp.md";
    // endsWith: the transmitted id is the scheme-qualified candidateKey, not
    // the bare displayPath — the bare compare never matched, so the junk was
    // never actually top-ranked and the whole set was a CONSTANT 0.5 (exposed
    // by the BUILD-3d degeneracy gate, which now discards constant sets).
    store.rerank = async (_q, docs) => docs.map(d => ({ file: d.file, score: d.file.endsWith(JUNK) ? 0.99 : 0.5 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-inert" }, { trace });

    // The rerank WAS applied (full coverage) — the dangerous path…
    expect(trace.rerank?.orderingApplied).toBe(true);
    expect(trace.rankingKey).toBe("rerank");
    // …yet the top-reranked junk is still band 1 (pre-BUILD-2,
    // rerankArbitrated elevated all bands to 0 and the junk would have LED
    // the injection), and under BUILD-4 (t52-F4) the band contract keeps it
    // out of the output entirely — rejected at admission, not ordered last.
    const cand = trace.fusion!.candidates.find(c => c.displayPath === JUNK)!;
    expect(cand.currentSupported).toBe(false);
    const rj = trace.admission!.rejected.find(e => e.displayPath === JUNK);
    expect(rj?.reason).toBe("band-floor");
    expect(trace.finalPaths).not.toContain(JUNK);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-inert'`).run();
  }, 20_000);

  it("BUILD-2/F16-2: cross-vault twins keep DISTINCT candidate identities end-to-end — each injected candidate matches its OWN admission record (handler boundary)", async () => {
    const store = createTestStore();
    // General-vault twin.
    seedDocuments(store, [
      { path: "m/twin.md", title: "scraper skill routing", body: "scraper skill routing decision for the toolchain in the general vault at length", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    // Skill-vault twin sharing the SAME collection/path → IDENTICAL displayPath,
    // DISTINCT candidateKey ("skill:" prefixed).
    const skillDir = mkdtempSync(join(tmpdir(), "hook-lanes-twin-"));
    const skillPath = join(skillDir, "skill.sqlite");
    const skillStore = createStore(skillPath);
    seedDocuments(skillStore as Store, [
      { path: "m/twin.md", collection: "test", title: "scraper skill routing", body: "scraper skill routing decision for the toolchain in the skill vault at length", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    process.env.CLAWMEM_PROFILE = "speed";
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "true";
    process.env.CLAWMEM_VAULTS = JSON.stringify({ skill: skillPath });
    clearConfigCache();

    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "scraper skill routing decision toolchain", sessionId: "lanes-twin" }, { trace });

    // Both twins share ONE displayPath but must remain TWO distinct candidates,
    // differing only by the "skill:" qualification of the same underlying path.
    const twinEntries = trace.injection!.entries.filter(e => e.displayPath === "test/m/twin.md");
    expect(twinEntries.length).toBe(2);
    const cands = twinEntries.map(e => e.candidate);
    const skillCand = cands.find(c => c.startsWith("skill:"));
    const generalCand = cands.find(c => !c.startsWith("skill:"));
    expect(skillCand).toBeDefined();                       // skill vault: qualified identity
    expect(generalCand).toBeDefined();                     // general vault: bare identity
    expect(skillCand).toBe(`skill:${generalCand}`);        // same underlying path, distinct identity
    // Each injected candidate matches its OWN admission record — a displayPath
    // match would let one twin borrow the other's (codex turn-15/16).
    const admitted = new Set(trace.admission!.admitted.map(a => a.candidate));
    for (const e of trace.injection!.entries) expect(admitted.has(e.candidate)).toBe(true);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-twin'`).run();
  }, 20_000);
});

describe("BUILD-2/F19-3: zero-weight failure guard at the real handler (subprocess)", () => {
  // RERANK_LANE_WEIGHT is baked at module import, so the w=0 handler path
  // needs a fresh process; the driver runs the REAL handler with the same
  // store-boundary stubs as the tests above (codex turn-19 finding 3 — the
  // unit test exercises only the invariant checker; deleting the handler
  // guard leaves it green).
  const DRIVER = join(import.meta.dir, "../helpers/w0-guard-driver.ts");
  const JUNK = "test/m/w0-junk.md";

  function runDriver(weight: string | null) {
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAWMEM_RERANK_LANE_WEIGHT;
    delete env.CLAWMEM_SESSION_FOCUS;
    delete env.CLAWMEM_VAULTS;
    if (weight !== null) env.CLAWMEM_RERANK_LANE_WEIGHT = weight;
    const proc = Bun.spawnSync([process.execPath, DRIVER], { env, cwd: join(import.meta.dir, "../..") });
    const out = proc.stdout.toString();
    const line = out.split("\n").reverse().find(l => l.startsWith("W0DRIVER::"));
    if (!line) throw new Error(`driver produced no W0DRIVER line (exit ${proc.exitCode}):\n${out}\n${proc.stderr.toString()}`);
    return JSON.parse(line.slice("W0DRIVER::".length)) as {
      weightEnv: string | null;
      rerank: { attempted: boolean; failed: boolean; coverageComplete: boolean; orderingApplied: boolean } | null;
      rankingKey: string | null;
      finalPaths: string[];
      admissionEntries: string[] | null;
      admissionJunk: { reason: string | null; band: number | null } | null;
    };
  }

  it("w=0: full coverage + inert lane ⇒ dropUnarbitrated runs — the gate-failing expansion-only doc is DROPPED", () => {
    const r = runDriver("0");
    expect(r.weightEnv).toBe("0");
    // The dangerous trace shape: the reranker ANSWERED everything…
    expect(r.rerank).toEqual({ attempted: true, failed: false, coverageComplete: true, orderingApplied: false });
    expect(r.rankingKey).toBe("rrf");
    // …and coverage did NOT arbitrate: the guard dropped the junk. Regressing
    // the guard to the coverage-arbitrates form (skip on rerankBlended alone)
    // injects it and turns this red.
    expect(r.finalPaths).not.toContain(JUNK);
    // BUILD-4 (t52-F4 re-pin): the guard dropped it from the POOL — it never
    // even reached admission (contrast with the control arm below).
    expect(r.admissionEntries).not.toContain(JUNK);
    expect(r.finalPaths).toContain("test/m/ib1.md");
    expect(r.finalPaths).toContain("test/m/ib2.md");
  }, 40_000);

  it("control (default weight): usable arbitration present ⇒ the SAME pool injects the junk — its absence at w=0 is the guard's doing, not the pool's", () => {
    const r = runDriver(null);
    expect(r.rerank?.orderingApplied).toBe(true);
    expect(r.rankingKey).toBe("rerank");
    // BUILD-4 (t52-F4): arbitration still carries the junk PAST the guard —
    // it reaches ADMISSION (absent at w=0: the guard's doing, proven above) —
    // where the C4 band contract now rejects it: discounted-only never
    // enters output beside current evidence.
    expect(r.admissionEntries).toContain(JUNK);
    expect(r.admissionJunk).toEqual({ reason: "band-floor", band: 1 });
    expect(r.finalPaths).not.toContain(JUNK);
  }, 40_000);
});

describe("BUILD-3a: budget-derived rerank window at the real handler (subprocess)", () => {
  // HOOK_BUDGET_MS is baked at module import — the budget varies only in a
  // fresh process. The driver's expandQuery stub sleeps a spawner-set delay
  // so the window state at the rerank gate is deterministic.
  const DRIVER = join(import.meta.dir, "../helpers/budget-guard-driver.ts");
  const JUNK3A = "test/m/budget-junk.md";

  function runBudgetDriver(budget: string | null, expandDelayMs: number, opts?: { mode?: string; httpDelayMs?: number; expandHttpDelayMs?: number; vectorSyncDelayMs?: number; priorSlowFirstMs?: number; fileAwareSlowFirstMs?: number; wallJump?: string }) {
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAWMEM_HOOK_BUDGET_MS;
    // O1 §5: an optional realtime STEP in the driver process ("<atUptimeMs>:<deltaMs>", read by the clock module).
    delete env.CLAWMEM_TEST_WALL_JUMP;
    if (opts?.wallJump) env.CLAWMEM_TEST_WALL_JUMP = opts.wallJump;
    delete env.CLAWMEM_RERANK_LANE_WEIGHT;
    delete env.CLAWMEM_SESSION_FOCUS;
    delete env.CLAWMEM_VAULTS;
    delete env.CLAWMEM_TEST_RERANK_MODE;
    delete env.CLAWMEM_TEST_EXPAND_HTTP_MODE;
    if (budget !== null) env.CLAWMEM_HOOK_BUDGET_MS = budget;
    env.CLAWMEM_TEST_EXPAND_DELAY_MS = String(expandDelayMs);
    if (opts?.mode) env.CLAWMEM_TEST_RERANK_MODE = opts.mode;
    if (opts?.httpDelayMs !== undefined) env.CLAWMEM_TEST_RERANK_HTTP_DELAY_MS = String(opts.httpDelayMs);
    if (opts?.expandHttpDelayMs !== undefined) {
      env.CLAWMEM_TEST_EXPAND_HTTP_MODE = "real-expand-http-delay";
      env.CLAWMEM_TEST_EXPAND_HTTP_DELAY_MS = String(opts.expandHttpDelayMs);
    }
    delete env.CLAWMEM_TEST_VECTOR_SYNC_DELAY_MS;
    if (opts?.vectorSyncDelayMs !== undefined) env.CLAWMEM_TEST_VECTOR_SYNC_DELAY_MS = String(opts.vectorSyncDelayMs);
    delete env.CLAWMEM_TEST_PRIOR_SLOW_FIRST;
    delete env.CLAWMEM_PRIOR_VECTOR_INPROC;
    if (opts?.priorSlowFirstMs !== undefined) {
      env.CLAWMEM_TEST_PRIOR_SLOW_FIRST = "1";
      env.CLAWMEM_TEST_PRIOR_SLOW_MS = String(opts.priorSlowFirstMs);
    }
    delete env.CLAWMEM_TEST_FILEAWARE_SLOW_FIRST;
    if (opts?.fileAwareSlowFirstMs !== undefined) {
      env.CLAWMEM_TEST_FILEAWARE_SLOW_FIRST = "1";
      env.CLAWMEM_TEST_FILEAWARE_SLOW_MS = String(opts.fileAwareSlowFirstMs);
    }
    const proc = Bun.spawnSync([process.execPath, DRIVER], { env, cwd: join(import.meta.dir, "../..") });
    const out = proc.stdout.toString();
    const line = out.split("\n").reverse().find(l => l.startsWith("BUDGETDRIVER::"));
    if (!line) throw new Error(`driver produced no BUDGETDRIVER line (exit ${proc.exitCode}):\n${out}\n${proc.stderr.toString()}`);
    return JSON.parse(line.slice("BUDGETDRIVER::".length)) as {
      budgetEnv: string | null;
      lanes: string[] | null;
      expansionAttempted: boolean | null;
      priorFtsCalls: number;
      fileAwareCalls: number;
      vecCallsTotal: number;
      priorLegEnabled: boolean | null;
      rerankCalls: number;
      rerankAttempted: boolean | null;
      rerankFailed: boolean | null;
      rankingKey: string | null;
      finalPaths: string[];
      finalizationMsRecorded: boolean;
      finalizationMs: number | null;
      finalizationSubstages: Record<string, number> | null;
      postOutputMs: number | null;
      postOutputSkipped: boolean;
      outcome: string | null;
      requireLiveCoverage: boolean | null;
      deadlineDeltaMs: number | null;
      elapsedMs: number;
    };
  }

  it("budget 1000 + 750ms expansion: the rerank window (budget − reserve = 500ms) is CLOSED — the rerank is never attempted and the guard drops the gate-failing junk", () => {
    const r = runBudgetDriver("1000", 750);
    expect(r.budgetEnv).toBe("1000");
    expect(r.rerankCalls).toBe(0);
    expect(r.rerankAttempted).toBeNull(); // never reached trace.rerank init
    expect(r.rankingKey).toBe("rrf");
    expect(r.finalPaths).not.toContain(JUNK3A);
    expect(r.finalPaths).toContain("test/m/ib1.md");
    expect(r.finalizationMsRecorded).toBe(true); // escalation concluded ⇒ finalization measured
  }, 40_000);

  it("finalization substages are complete and sum exactly to finalizationMs on the injected deep path; the bookkeeping writes are POST-OUTPUT (BUILD-3d.4 + BUILD-5)", () => {
    // Real deep handler (the driver forces CLAWMEM_PROFILE=deep); the default
    // budget keeps the window open so escalation concludes and the injected
    // path runs every finalization boundary.
    const r = runBudgetDriver(null, 0);
    expect(r.outcome).toBe("injected");
    expect(r.finalizationMsRecorded).toBe(true);
    const sub = r.finalizationSubstages!;
    expect(sub).not.toBeNull();
    // Every RESERVE-window boundary is recorded, in order, ending in tail.
    // BUILD-5: "inject" is GONE from the reserve window — the bookkeeping
    // writes moved past the payload boundary.
    for (const k of ["filters", "enrich", "scoring", "ordering", "buildContext", "facts", "tail"]) {
      expect(typeof sub[k]).toBe("number");
    }
    expect(sub.inject).toBeUndefined();
    // The deltas telescope: they sum EXACTLY to finalizationMs (integer ms,
    // no rounding) — which now bounds escalation end → PAYLOAD ASSEMBLED.
    expect(r.finalizationMs).not.toBeNull();
    const total = Object.values(sub).reduce((a: number, b: number) => a + b, 0);
    expect(total).toBe(r.finalizationMs!);
    // The post-output writes ran (deadline open) and were measured separately.
    expect(r.postOutputSkipped).toBe(false);
    expect(r.postOutputMs).not.toBeNull();
    expect(r.postOutputMs!).toBeGreaterThanOrEqual(0);
  }, 40_000);

  it("default budget + the same 750ms expansion: the window is open — the rerank runs (control: the skip above is the deadline's doing)", () => {
    const r = runBudgetDriver(null, 750);
    expect(r.rerankCalls).toBe(1);
    expect(r.rerankAttempted).toBe(true);
    expect(r.rankingKey).toBe("rerank");
    // Codex turn-23 F1: the production call's OPTIONS are regression-locked —
    // removing `deadline` (or requireLiveCoverage) from the handler's
    // store.rerank call turns these red. `deadline` is a MONOTONIC instant
    // (O1): its delta from the driver's monotonic start must equal budget −
    // FINALIZATION_RESERVE (6000−500) plus the small pre-handler startup,
    // never a per-call relative window.
    expect(r.requireLiveCoverage).toBe(true);
    expect(r.deadlineDeltaMs).not.toBeNull();
    expect(r.deadlineDeltaMs!).toBeGreaterThan(5500 - 400);
    expect(r.deadlineDeltaMs!).toBeLessThanOrEqual(5500 + 10);
  }, 40_000);

  it("REAL store.rerank + delayed HTTP under budget 2000: the batch aborts at the window edge, the local fallback never runs, the guard arbitrates", () => {
    // Window = 2000 − 500 reserve ≈ 1500ms; the HTTP mock sleeps 2500ms but
    // honors the abort signal. The handler must come back around the window
    // edge (deadline cut the call), never the full delay.
    const r = runBudgetDriver("2000", 0, { mode: "real-http-delay", httpDelayMs: 2500 });
    expect(r.rerankCalls).toBeGreaterThanOrEqual(1);
    expect(r.rerankAttempted).toBe(true);
    expect(r.rerankFailed).toBe(true);           // coverage error → escalation catch
    expect(r.rankingKey).toBe("rrf");
    expect(r.finalPaths).not.toContain(JUNK3A);  // failure guard arbitrated
    expect(r.elapsedMs).toBeLessThan(2400);      // did NOT wait out the 2500ms delay
  }, 40_000);

  it("REAL expansion + delayed LLM under budget 1000: the threaded abort stops the transport and the PROCESS exits inside the budget (codex turn-24 F3, fixed)", () => {
    // Codex reproduced pre-fix: handler reported ~1009ms but the process
    // lived 2.63s — the abandoned race left the fetch pending and the host
    // waits on the PROCESS. With the deadline threaded to the transport,
    // spawnSync (which returns at process EXIT) must come back well under
    // the 2500ms delay.
    const t0 = Date.now();
    const r = runBudgetDriver("1000", 0, { expandHttpDelayMs: 2500 });
    const wallMs = Date.now() - t0;
    expect(r.elapsedMs).toBeLessThan(1300);      // handler honored the budget
    expect(wallMs).toBeLessThan(2300);           // PROCESS exit, not just handler return
    expect(r.finalPaths).toContain("test/m/ib1.md");
  }, 40_000);

  // O1 §6 transport boundary locks under a realtime STEP (§5): forward and backward wall jumps
  // inside the driver process change NONE of the outcomes above. Pre-O1, a backward step of 5 s
  // during the window made `AbortSignal.timeout(deadlineAt - Date.now())` 5 s longer, so the
  // remote batch / fetch ran to its full delay and the handler blew its budget.
  for (const [label, wallJump] of [["BACKWARD −5 s", "300:-5000"], ["FORWARD +5 s", "300:5000"]] as const) {
    it(`O1 §5: REAL store.rerank + delayed HTTP under budget 2000 with a ${label} wall step mid-window — the batch still aborts at the MONOTONIC window edge`, () => {
      const r = runBudgetDriver("2000", 0, { mode: "real-http-delay", httpDelayMs: 2500, wallJump });
      expect(r.rerankCalls).toBeGreaterThanOrEqual(1);
      expect(r.rerankAttempted).toBe(true);
      expect(r.rerankFailed).toBe(true);
      expect(r.rankingKey).toBe("rrf");
      expect(r.finalPaths).not.toContain(JUNK3A);
      expect(r.elapsedMs).toBeLessThan(2400);
    }, 40_000);

    it(`O1 §5: REAL expansion + delayed LLM under budget 1000 with a ${label} wall step — the transport abort and the PROCESS exit still honor the monotonic budget`, () => {
      const t0 = Date.now();
      const r = runBudgetDriver("1000", 0, { expandHttpDelayMs: 2500, wallJump: wallJump.replace("300:", "200:") });
      const wallMs = Date.now() - t0;
      expect(r.elapsedMs).toBeLessThan(1300);
      expect(wallMs).toBeLessThan(2300);
      expect(r.finalPaths).toContain("test/m/ib1.md");
    }, 40_000);
  }

  it("pathological SYNC vector overrun past the window: optional legs SKIP, the primary-FTS floor still delivers (codex turn-25 F2)", () => {
    // A synchronous 900ms busy-wait in the vector leg cannot be interrupted
    // by the race timer (event loop blocked) — under budget 1000 the work
    // window (700ms) is genuinely CLOSED when the candidate legs run. The
    // guards must skip the optional legs and the escalation entry while the
    // reserved primary-FTS floor still produces candidates.
    const r = runBudgetDriver("1000", 0, { vectorSyncDelayMs: 900 });
    expect(r.lanes).toContain("fts-fallback");        // the guaranteed floor ran
    expect(r.lanes!.some((l: string) => l.startsWith("expansion"))).toBe(false); // escalation entry refused
    expect(r.expansionAttempted).toBeNull();
    expect(r.rerankCalls).toBe(0);
    expect(r.rankingKey).toBe("rrf");
    expect(r.finalPaths).toContain("test/m/ib1.md");  // useful output despite the overrun
    expect(r.finalizationMsRecorded).toBe(true);      // the tail sample is NOT lost (skipped-escalation measurement)
  }, 40_000);

  it("a FIRST optional search crossing the deadline stops the REST: prior loop rechecks per search, prior-vector never starts (codex turn-26)", () => {
    // Two seeded priors + an anaphoric prompt fire the prior leg under
    // budget 1000 (work deadline 700). The first prior FTS search busy-waits
    // 800ms SYNCHRONOUSLY — crossing the deadline mid-leg. The operation-
    // level rechecks must stop the second prior search and the prior-vector
    // sub-leg; block-level guards (the turn-25 shape) let both run.
    const r = runBudgetDriver("1000", 0, { priorSlowFirstMs: 800 });
    expect(r.priorLegEnabled).toBe(true);       // the leg genuinely fired
    expect(r.priorFtsCalls).toBe(1);            // second prior search NOT called
    expect(r.vecCallsTotal).toBe(1);            // current leg only — prior-vector never started
    expect(r.lanes === null || !r.lanes.some((l: string) => l === "prior-vector")).toBe(true);
    expect(r.elapsedMs).toBeLessThan(1400); // one crossing search + a fast tail — never a second 800ms search
  }, 40_000);

  it("file-aware twin: the FIRST file-aware search crossing the deadline stops the SECOND (codex turn-27 — the duplicated branch regression-locked)", () => {
    // Prompt carries TWO file references (config.yaml, deploy.sh) under
    // budget 1000; the first file-aware FTS search busy-waits 800ms
    // synchronously past the 700ms work deadline. The per-iteration recheck
    // in the file-aware loop must stop the second — removing that recheck
    // turns this red while the prior-leg test stays green.
    const r = runBudgetDriver("1000", 0, { fileAwareSlowFirstMs: 800 });
    expect(r.fileAwareCalls).toBe(1);       // second file-aware search NOT called
    expect(r.elapsedMs).toBeLessThan(1400);
    expect(r.finalPaths).toContain("test/m/ib3-config.md"); // the floor still delivered
  }, 40_000);
});

describe("BUILD-3d: per-request degeneracy gate at the real handler", () => {
  it("a fully-covered CONSTANT score set is discarded: assessment recorded, orderingApplied false, guard arbitrates", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/dg1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/dg2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // Expansion-only, gate-FAILING junk (no prompt vocabulary).
      { path: "m/dg-junk.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows and frost dates", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [{ type: "lex", query: "gardening almanac planting" }] as Awaited<ReturnType<Store["expandQuery"]>>;
    // The inert regime: full coverage, every score identical — spread 0.
    store.rerank = async (_q, docs) => docs.map(d => ({ file: d.file, score: 0.5 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-degen-inert" }, { trace });

    // Coverage stays the transport truth (the reranker ANSWERED)…
    expect(trace.rerank?.coverageComplete).toBe(true);
    // …the assessment is recorded with the gate armed…
    expect(trace.rerank?.degeneracy).toMatchObject({ gated: true, degenerate: true, reason: "inert", spread: 0 });
    // …and the ACTION discarded the lane: no ordering application, RRF key,
    // and the failure guard dropped the unarbitrated gate-failing junk.
    expect(trace.rerank?.orderingApplied).toBe(false);
    expect(trace.rankingKey).toBe("rrf");
    expect(trace.finalPaths).not.toContain("test/m/dg-junk.md");
    expect(trace.finalPaths).toContain("test/m/dg1.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-degen-inert'`).run();
    store.db.close();
  }, 20_000);

  it("the ~0 collapse regime (broken-GGUF scores) is discarded with reason 'collapse'", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/dc1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/dc2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/dc3.md", title: "billing invoice dunning", body: "billing invoice dunning retries cadence for enterprise export accounts", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [] as Awaited<ReturnType<Store["expandQuery"]>>;
    // The documented broken-GGUF regime: every score <= 8.03e-7, tiny but
    // NON-constant differences — spread alone would also catch it, the max
    // band catches it FIRST and names the regime.
    store.rerank = async (_q, docs) => docs.map((d, i) => ({ file: d.file, score: 8e-7 - i * 1e-8 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-degen-collapse" }, { trace });

    expect(trace.rerank?.coverageComplete).toBe(true);
    expect(trace.rerank?.degeneracy?.degenerate).toBe(true);
    expect(trace.rerank?.degeneracy?.reason).toBe("collapse");
    expect(trace.rerank?.orderingApplied).toBe(false);
    expect(trace.rankingKey).toBe("rrf");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-degen-collapse'`).run();
    store.db.close();
  }, 20_000);

  it("a DISCRIMINATING score set records a non-degenerate assessment and orders normally", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/dh1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/dh2.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/dh3.md", title: "billing invoice dunning", body: "billing invoice dunning retries cadence for enterprise export accounts", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => []);
    store.expandQuery = async () => [] as Awaited<ReturnType<Store["expandQuery"]>>;
    store.rerank = async (_q, docs) => docs.map((d, i) => ({ file: d.file, score: 0.9 - i * 0.1 }));

    process.env.CLAWMEM_PROFILE = "deep";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-degen-healthy" }, { trace });

    expect(trace.rerank?.coverageComplete).toBe(true);
    expect(trace.rerank?.degeneracy?.gated).toBe(true);
    expect(trace.rerank?.degeneracy?.degenerate).toBe(false);
    expect(trace.rerank?.degeneracy?.reason).toBeNull();
    expect(trace.rerank?.orderingApplied).toBe(true);
    expect(trace.rankingKey).toBe("rerank");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-degen-healthy'`).run();
    store.db.close();
  }, 20_000);
});

describe("BUILD-3d: degeneracy-gate toggle at the real handler (subprocess)", () => {
  // RERANK_DEGENERACY_GATE_ACTIVE is baked at module import, so the gate-off
  // control arm needs a fresh process — same discipline as the w=0 driver.
  const DRIVER = join(import.meta.dir, "../helpers/degeneracy-gate-driver.ts");
  const JUNK = "test/m/dg-junk.md";

  function runDegeneracyDriver(gate: string | null) {
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAWMEM_RERANK_DEGENERACY_GATE;
    delete env.CLAWMEM_RERANK_LANE_WEIGHT;
    delete env.CLAWMEM_SESSION_FOCUS;
    delete env.CLAWMEM_VAULTS;
    if (gate !== null) env.CLAWMEM_RERANK_DEGENERACY_GATE = gate;
    const proc = Bun.spawnSync([process.execPath, DRIVER], { env, cwd: join(import.meta.dir, "../..") });
    const out = proc.stdout.toString();
    const line = out.split("\n").reverse().find(l => l.startsWith("DGDRIVER::"));
    if (!line) throw new Error(`driver produced no DGDRIVER line (exit ${proc.exitCode}):\n${out}\n${proc.stderr.toString()}`);
    return JSON.parse(line.slice("DGDRIVER::".length)) as {
      gateEnv: string | null;
      rerank: { attempted: boolean; failed: boolean; coverageComplete: boolean; orderingApplied: boolean; degeneracy: { gated: boolean; degenerate: boolean; reason: string | null } | null } | null;
      rankingKey: string | null;
      finalPaths: string[];
      admissionEntries: string[] | null;
      admissionJunk: { reason: string | null; band: number | null } | null;
    };
  }

  it("default (gate armed): the constant-score lane is discarded and the guard drops the junk", () => {
    const r = runDegeneracyDriver(null);
    expect(r.gateEnv).toBeNull();
    expect(r.rerank?.coverageComplete).toBe(true);
    expect(r.rerank?.degeneracy).toMatchObject({ gated: true, degenerate: true, reason: "inert" });
    expect(r.rerank?.orderingApplied).toBe(false);
    expect(r.rankingKey).toBe("rrf");
    expect(r.finalPaths).not.toContain(JUNK);
    // BUILD-4 (t52-F4 re-pin): with the lane discarded there is no usable
    // arbitration — the guard dropped the junk from the pool, so it never
    // reached admission.
    expect(r.admissionEntries).not.toContain(JUNK);
    expect(r.finalPaths).toContain("test/m/ib1.md");
  }, 40_000);

  it("CLAWMEM_RERANK_DEGENERACY_GATE=off (control): SAME scores, shadow assessment recorded, ordering applied, junk injected", () => {
    const r = runDegeneracyDriver("off");
    expect(r.gateEnv).toBe("off");
    expect(r.rerank?.coverageComplete).toBe(true);
    // The assessment still ran and still says degenerate — only the ACTION
    // is disarmed, so a control arm measures the firing rate.
    expect(r.rerank?.degeneracy).toMatchObject({ gated: false, degenerate: true, reason: "inert" });
    expect(r.rerank?.orderingApplied).toBe(true);
    expect(r.rankingKey).toBe("rerank");
    // Arbitration present -> the guard is skipped -> the junk reaches
    // ADMISSION (the toggle is the only difference between the arms) — and
    // BUILD-4's band contract (t52-F4) rejects it there: discounted-only
    // never enters output beside current evidence.
    expect(r.admissionEntries).toContain(JUNK);
    expect(r.admissionJunk).toEqual({ reason: "band-floor", band: 1 });
    expect(r.finalPaths).not.toContain(JUNK);
  }, 40_000);

  it("an unrecognized toggle value keeps the gate ARMED (fail-safe direction)", () => {
    const r = runDegeneracyDriver("disable");
    expect(r.rerank?.degeneracy).toMatchObject({ gated: true, degenerate: true });
    expect(r.rerank?.orderingApplied).toBe(false);
  }, 40_000);
});

describe("BUILD-4 relevance admission at the real handler (codex t52-F1 locks)", () => {
  it("vector-only pool with zero keyword agreement ABSTAINS (degenerate-basis) through the real handler", async () => {
    const store = createTestStore();
    // Bodies share NO vocabulary with the prompt — FTS finds nothing; the
    // vector leg alone carries them (the Addendum-2 junk-entry shape).
    seedDocuments(store, [
      { path: "m/vj1.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows and frost dates", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
      { path: "m/vj2.md", title: "sourdough hydration", body: "sourdough hydration ratios and proofing schedule notes", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
      { path: "m/vj3.md", title: "marathon taper", body: "marathon taper week mileage and carb loading", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => [
      vecResult(store, "test/m/vj1.md", 0.69),
      vecResult(store, "test/m/vj2.md", 0.67),
      vecResult(store, "test/m/vj3.md", 0.66),
    ]);
    process.env.CLAWMEM_PROFILE = "balanced";
    const trace = newSurfacingTrace();
    const out = await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-b4-degenerate" }, { trace });
    expect((out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "").toBe("");
    expect(trace.outcome).toBe("empty");
    expect(trace.emptyReason).toBe("admission-degenerate");
    expect(trace.admission?.mode).toBe("relevance");
    expect(trace.admission?.abstainReason).toBe("degenerate-basis");
    expect(trace.admission?.basis).toBe("weighted-rrf");
    expect(trace.admission?.keywordAgreed).toBe(0);
    // t54-F3: the admission-input ledger is recorded BEFORE the policy
    // branch even on an abstained outcome — exposure reads it; the
    // admitted/rejected split never decides.
    expect(trace.admissionInput?.candidates.length).toBe(3);
    expect(trace.admissionInput!.candidates.every(c => Number.isFinite(c.compositeScore) && Number.isFinite(c.mass))).toBe(true);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-b4-degenerate'`).run();
  }, 20_000);

  it("the relative floor rejects a weak single-lane band-0 tail through the real handler", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      // Two-lane agreement (FTS + vector) — the clear leader.
      { path: "m/fa.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // FTS-only, rank 2 — mass ≈ 0.27 of the two-lane top → below the 0.5 floor.
      { path: "m/fb.md", title: "billing invoice retries", body: "billing invoice retries enterprise and the export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => [vecResult(store, "test/m/fa.md", 0.8)]);
    process.env.CLAWMEM_PROFILE = "balanced";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-b4-floor" }, { trace });
    expect(trace.outcome).toBe("injected");
    expect(trace.admission?.mode).toBe("relevance");
    expect(trace.finalPaths).toContain("test/m/fa.md");
    const rj = trace.admission!.rejected.find(e => e.displayPath === "test/m/fb.md");
    expect(rj?.reason).toBe("floor");
    expect(trace.finalPaths).not.toContain("test/m/fb.md");
    // t54-F1 ledger lock: both candidates reached the branch with their full
    // policy inputs recorded, the two-lane leader carrying the greater mass.
    const lkeys = trace.admissionInput!.candidates.map(c => c.key);
    expect(lkeys).toContain("clawmem://test/m/fa.md");
    expect(lkeys).toContain("clawmem://test/m/fb.md");
    const lfa = trace.admissionInput!.candidates.find(c => c.key.endsWith("fa.md"))!;
    const lfb = trace.admissionInput!.candidates.find(c => c.key.endsWith("fb.md"))!;
    expect(lfa.band).toBe(0);
    expect(lfb.band).toBe(0);
    expect(lfa.mass).toBeGreaterThan(lfb.mass);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-b4-floor'`).run();
  }, 20_000);

  it("basis lock (t53-F1/t54-F1): a snoozed vector-only candidate leaves an FTS-only judged set — basis bm25-rrf through the real handler", async () => {
    const store = createTestStore();
    seedDocuments(store, [
      { path: "m/kw.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      // Vector-only junk: shares no vocabulary with the prompt.
      { path: "m/vsnooze.md", title: "gardening almanac", body: "seasonal gardening almanac with planting windows and frost dates", contentType: "note", confidence: 0.8, qualityScore: 0.8 },
    ]);
    stubSearchVec(store, async () => [vecResult(store, "test/m/vsnooze.md", 0.7)]);
    store.snoozeDocument("test", "m/vsnooze.md", new Date(Date.now() + 86_400_000).toISOString());
    process.env.CLAWMEM_PROFILE = "balanced";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-b4-basis" }, { trace });
    // The vector LANE ran (count 1) — but its only candidate was snoozed out
    // before admission, so the judged surface is FTS-only: bm25-rrf, never a
    // mislabeled weighted-rrf (lane counts would say otherwise; t53-F1).
    expect(trace.fusion!.lanes.find(l => l.lane === "vector")?.count).toBe(1);
    expect(trace.filters.snoozedDropped).toContain("test/m/vsnooze.md");
    expect(trace.outcome).toBe("injected");
    expect(trace.admission?.mode).toBe("relevance");
    expect(trace.admission?.basis).toBe("bm25-rrf");
    const admPaths = [...trace.admission!.admitted, ...trace.admission!.rejected].map(e => e.displayPath);
    expect(admPaths).not.toContain("test/m/vsnooze.md");
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-b4-basis'`).run();
  }, 20_000);

  it("ledger + frozen-clock lock (t54-F1/F3): admissionInput carries {key, band, mass, compositeScore} and CLAWMEM_EVAL_NOW pins the composite clock through the real handler", async () => {
    const mk = async (sessionId: string) => {
      const store = createTestStore();
      seedDocuments(store, [
        { path: "m/fa.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "note", qualityScore: 0.8, modifiedAt: "2026-08-01T00:00:00.000Z" },
      ]);
      stubSearchVec(store, async () => [vecResult(store, "test/m/fa.md", 0.8)]);
      process.env.CLAWMEM_PROFILE = "balanced";
      const trace = newSurfacingTrace();
      await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId }, { trace });
      store.db.prepare(`DELETE FROM context_usage WHERE session_id = '${sessionId}'`).run();
      return trace;
    };
    delete process.env.CLAWMEM_EVAL_NOW;
    const wall = await mk("lanes-b4-clock-wall");
    // t54-F1 production-bridge lock: deleting the handler's ledger
    // assignment goes red HERE, at the real handler.
    expect(wall.admissionInput).not.toBeNull();
    const entry = wall.admissionInput!.candidates.find(c => c.key === "clawmem://test/m/fa.md");
    expect(entry).toBeDefined();
    expect(entry!.band).toBe(0);
    expect(entry!.mass).toBeGreaterThan(0);
    expect(Number.isFinite(entry!.compositeScore)).toBe(true);
    const keys = wall.admissionInput!.candidates.map(c => c.key);
    expect(keys).toEqual([...keys].sort());
    // t54-F3 frozen clock: pin CLAWMEM_EVAL_NOW to the doc's modifiedAt —
    // age 0 ⇒ recency at its MAXIMUM, so the frozen composite must be
    // strictly GREATER than the wall-clock run's (the doc is 24d old on the
    // wall). The direction is deliberately OPPOSITE to wall drift: an
    // unwired seam makes the second run's wall clock marginally LATER (composite
    // equal-or-lower), so this assertion goes red under the mutation instead
    // of riding the drift. Content type "note" decays; a never-decaying
    // type would hide the contrast.
    process.env.CLAWMEM_EVAL_NOW = "2026-08-01T00:00:00.000Z";
    const frozen = await mk("lanes-b4-clock-frozen");
    const frozenEntry = frozen.admissionInput!.candidates.find(c => c.key === "clawmem://test/m/fa.md")!;
    expect(frozenEntry.compositeScore).toBeGreaterThan(entry!.compositeScore);
  }, 20_000);

  it("BUILD-5 deletion locks at the real handler: no co-activation READS or WRITES on the surfacing path, no reorder machinery records, bookkeeping measured post-output", async () => {
    const store = createTestStore();
    // >3 admitted docs so the deleted E10/E11 blocks WOULD have fired, one
    // of them procedural-shaped (the E10 splice candidate).
    seedDocuments(store, [
      { path: "m/d1.md", title: "billing invoice export", body: "billing invoice export retries flow for enterprise tenants", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/d2.md", title: "billing invoice retries", body: "billing invoice retries enterprise export dead letter queue", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/d3.md", title: "invoice export enterprise", body: "invoice export retries enterprise billing schedule", contentType: "decision", confidence: 0.9, qualityScore: 0.8 },
      { path: "m/howto-export.md", title: "how to run the billing export", body: "step by step: run the billing invoice export retries for enterprise", contentType: "note", confidence: 0.9, qualityScore: 0.8 },
    ]);
    // Seed a co-activation pair so a restored E11 would have material to read.
    store.recordCoActivation(["test/m/d1.md", "test/m/d2.md"]);
    let coReadCalls = 0;
    const realGetCo = store.getCoActivated.bind(store);
    store.getCoActivated = ((path: string, limit: number) => { coReadCalls++; return realGetCo(path, limit); }) as typeof store.getCoActivated;
    let coWriteCalls = 0;
    const realRecordCo = store.recordCoActivation.bind(store);
    store.recordCoActivation = ((paths: string[]) => { coWriteCalls++; return realRecordCo(paths); }) as typeof store.recordCoActivation;
    // Vector lane in REVERSE fts order: two-lane masses even out, so all
    // four clear the BUILD-4 relative floor (a single lane's rank-4 sits at
    // ~0.235 of top and would be floor-cut, leaving only 3 admitted).
    stubSearchVec(store, async () => [
      vecResult(store, "test/m/howto-export.md", 0.8),
      vecResult(store, "test/m/d3.md", 0.7),
      vecResult(store, "test/m/d2.md", 0.6),
      vecResult(store, "test/m/d1.md", 0.5),
    ]);
    process.env.CLAWMEM_PROFILE = "balanced";
    const trace = newSurfacingTrace();
    await contextSurfacing(store, { prompt: "billing invoice export retries enterprise", sessionId: "lanes-b5-locks" }, { trace });
    expect(trace.outcome).toBe("injected");
    expect(trace.finalPaths.length).toBeGreaterThan(3);
    // C5: co-activation is OUT of the surfacing path ENTIRELY — no reads
    // (E11 deleted) and no injection-time writes (logInjection opts out;
    // feedback-loop's referenced-paths signal is unaffected elsewhere).
    expect(coReadCalls).toBe(0);
    expect(coWriteCalls).toBe(0);
    // The reorder machinery records nothing — the fields exist, empty.
    expect(trace.spreadingActivation).toEqual([]);
    expect(trace.diversification).toBeNull();
    expect(trace.topicBoost).toBeNull();
    // The bookkeeping still RAN (usage row + recall events), post-output —
    // balanced never escalates so the finalization clock is deep-only, but
    // the usage row must exist.
    const usage = store.db.prepare(`SELECT COUNT(*) as c FROM context_usage WHERE session_id = 'lanes-b5-locks'`).get() as { c: number };
    expect(usage.c).toBe(1);
    store.db.prepare(`DELETE FROM context_usage WHERE session_id = 'lanes-b5-locks'`).run();
  }, 20_000);
});
