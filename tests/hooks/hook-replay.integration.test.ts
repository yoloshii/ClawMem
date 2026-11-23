/**
 * Hook replay-eval runner — end-to-end against the REAL contextSurfacing
 * handler on a fixture store (BUILD-0).
 *
 * Proves the four load-bearing properties of the harness:
 *  1. it drives the real handler (a seeded on-topic doc is injected and
 *     labeled metrics score it);
 *  2. the prior-turn shapes work (seeded priors inside the window enable the
 *     multi-turn leg; priors outside the window do not);
 *  3. cases are isolated (dedup disabled so one prompt replays twice;
 *     telemetry rows cleaned; co_activations restored; env restored);
 *  4. the enforced provenance invariants (trace-complete, admission-honored)
 *     hold on real traces.
 *
 * Runs on the `speed` profile — FTS-only, no vector service, no escalation —
 * so the suite is hermetic on a GPU-less CI host.
 */
import { stubSearchVec, realSearches } from "../helpers/vec-stub.ts";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import { runHookEval, HookEvalIntegrityError, expansionDrawFingerprint, transmittedTextManifest, deriveValidBasisByStratum } from "../../src/eval/hook-run.ts";
import { RERANK_REQUEST_REV } from "../../src/hooks/context-surfacing.ts";

const OAUTH_PROMPT = "Explain the OAuth refresh token rotation decision we made for the auth service";
const FOLLOWUP_PROMPT = "Can you explain that rationale in a bit more depth please";

function seedFixture(store: Store): void {
  seedDocuments(store, [
    {
      path: "memory/oauth-refresh-decision.md",
      title: "OAuth refresh token rotation decision",
      // The hook's FTS leg ANDs every prompt token as a prefix match
      // (buildFTS5Query), so the hermetic fixture doc must carry the full
      // vocabulary of both test prompts for the BM25-only speed profile to
      // retrieve it.
      body: "# OAuth refresh token rotation\n\nExplain the OAuth refresh token rotation decision we made for the auth service. Can you explain that rationale in a bit more depth please? We decided to rotate OAuth refresh tokens every 24 hours to limit blast radius on compromise. The auth service owns rotation.",
      contentType: "decision",
      confidence: 0.9,
      qualityScore: 0.8,
    },
    {
      path: "memory/database-migrations.md",
      title: "Database migration runbook",
      body: "# Database migrations\n\nRun migrations with the deploy pipeline. Never run them by hand in production.",
      contentType: "note",
      confidence: 0.6,
      qualityScore: 0.7,
    },
    {
      path: "memory/seo-hacks.md",
      title: "Top SEO hacks for rank and rent",
      body: "# SEO hacks\n\nDominate rank and rent local SEO with these growth hacks and content clusters.",
      contentType: "research",
      confidence: 0.6,
      qualityScore: 0.7,
    },
  ]);
}

function writeGold(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-replay-"));
  const p = join(dir, "cases.jsonl");
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const OAUTH_DOC = "test/memory/oauth-refresh-decision.md";
const SEO_DOC = "test/memory/seo-hacks.md";

describe("hook replay-eval — end-to-end on the real handler", () => {
  let store: Store;
  let priorNoLocal: string | undefined;

  beforeAll(() => {
    store = createTestStore();
    seedFixture(store);
    // Acceptance comparison forbids an allowed-fallback candidate (codex
    // turn-11 finding 3), and the eval CLI forces "blocked" for its runs —
    // the suite replays under the same policy the CLI enforces. The
    // topology-boundary tests below flip it deliberately per case.
    priorNoLocal = process.env.CLAWMEM_NO_LOCAL_MODELS;
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  });

  afterAll(() => {
    if (priorNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = priorNoLocal;
  });

  it("codex migration r1 P4: ONE budget per run — a case hook that changes CLAWMEM_HOOK_BUDGET_MS mid-run is REFUSED before that case is scored, and the environment is restored", async () => {
    const goldPath = writeGold([
      { id: "budget-a", prompt: OAUTH_PROMPT, profile: "speed", labels: { must_include: [OAUTH_DOC] }, split: "tuning", tags: ["budget"] },
      { id: "budget-b", prompt: OAUTH_PROMPT, profile: "speed", labels: { must_include: [OAUTH_DOC] }, split: "holdout", tags: ["budget"] },
    ]);
    const prev = process.env.CLAWMEM_HOOK_BUDGET_MS;
    process.env.CLAWMEM_HOOK_BUDGET_MS = "6000";
    try {
      // A VALID but different value: drift, not an invalid config — the run would otherwise execute
      // case b under 7000 while its identity and summary judged 6000.
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true,
        _testOnCaseStart: ({ index }) => { if (index === 1) process.env.CLAWMEM_HOOK_BUDGET_MS = "7000"; },
      })).rejects.toThrow(/CLAWMEM_HOOK_BUDGET_MS changed mid-run \(case budget-b rep 0\): the run started under 6000ms and the environment now resolves 7000ms/);
      expect(process.env.CLAWMEM_HOOK_BUDGET_MS).toBe("6000"); // restored by the run's env transaction
      // An unsupported value mid-run is refused the same way.
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true,
        _testOnCaseStart: ({ index }) => { if (index === 1) process.env.CLAWMEM_HOOK_BUDGET_MS = "30000"; },
      })).rejects.toThrow(/became unsupported mid-run \(case budget-b rep 0\)/);
      expect(process.env.CLAWMEM_HOOK_BUDGET_MS).toBe("6000");
      // Undisturbed, the run's identity records the captured budget.
      const { report } = await runHookEval({ goldPath, store, minExamples: 1, audited: true });
      expect(report.identity!.hook_budget_ms).toBe(6000);
      expect(report.budget_elapsed.budget_ms).toBe(6000);
    } finally {
      if (prev === undefined) delete process.env.CLAWMEM_HOOK_BUDGET_MS; else process.env.CLAWMEM_HOOK_BUDGET_MS = prev;
    }
  }, 30_000);

  it("replays labeled cases through the real pipeline with isolation and scores them", async () => {
    // Pre-existing co-activation state that the run must preserve byte-identically.
    store.recordCoActivation(["test/x.md", "test/y.md"]);
    const coactBefore = store.db.prepare(`SELECT doc_a, doc_b, count FROM co_activations ORDER BY doc_a, doc_b`).all();

    const envBefore = process.env.CLAWMEM_PROFILE;
    process.env.CLAWMEM_PROFILE = "deep"; // must be restored after the run

    const goldPath = writeGold([
      {
        id: "current-hit",
        prompt: OAUTH_PROMPT,
        profile: "speed",
        labels: { must_include: [OAUTH_DOC], must_not_include: [SEO_DOC] },
        split: "tuning",
        tags: ["current-only"],
      },
      {
        // Same prompt replayed again — only possible with the dedup gate disabled.
        id: "current-hit-repeat",
        prompt: OAUTH_PROMPT,
        profile: "speed",
        labels: { must_include: [OAUTH_DOC], must_not_include: [SEO_DOC] },
        split: "holdout",
        tags: ["dedup-off"],
      },
      {
        // Prior inside the 10-minute window → the multi-turn leg must engage.
        id: "prior-in-window",
        prompt: FOLLOWUP_PROMPT,
        priors: [{ text: OAUTH_PROMPT, age_minutes: 2 }],
        profile: "speed",
        prior_leg: "required",
        labels: { must_include: [OAUTH_DOC] },
        split: "tuning",
        tags: ["multi-turn"],
      },
      {
        // Prior OUTSIDE the window → current-only shape; lookback must not fire.
        id: "prior-out-of-window",
        prompt: FOLLOWUP_PROMPT,
        priors: [{ text: OAUTH_PROMPT, age_minutes: 30 }],
        profile: "speed",
        prior_leg: "forbidden",
        labels: {},
        split: "tuning",
        tags: ["control"],
      },
      {
        // Nothing in the vault matches → correct behavior is an empty injection.
        id: "abstain",
        prompt: "quantum blockchain espresso telemetry flux capacitor calibration",
        profile: "speed",
        expect_abstain: true,
        labels: {},
        split: "holdout",
        tags: ["abstention"],
      },
    ]);

    const { report, artifacts } = await runHookEval({
      goldPath,
      store,
      minExamples: 5,
      audited: true,
    });

    // --- 1. Real handler drove: the on-topic doc was injected and scored ---
    const byId = new Map(report.cases.map(c => [c.id, c]));
    const hit = byId.get("current-hit")!;
    expect(hit.outcome).toBe("injected");
    expect(hit.injectedPaths).toContain(OAUTH_DOC);
    expect(hit.metrics.mustIncludeRecall).toBe(1);
    expect(hit.metrics.mustNotCount).toBe(0);

    // --- 2. Prior-turn shapes ---
    const inWindow = byId.get("prior-in-window")!;
    expect(inWindow.metrics.priorLegOk).toBe(1); // multi-turn leg engaged as required
    expect(inWindow.metrics.mustIncludeRecall).toBe(1);
    const outOfWindow = byId.get("prior-out-of-window")!;
    expect(outOfWindow.metrics.priorLegOk).toBe(1); // lookback correctly did NOT fire

    // --- 3. Isolation ---
    const repeat = byId.get("current-hit-repeat")!;
    expect(repeat.outcome).toBe("injected"); // dedup gate disabled → same prompt replays
    expect(repeat.injectedPaths).toContain(OAUTH_DOC);

    const abstain = byId.get("abstain")!;
    expect(abstain.outcome).toBe("empty");
    expect(abstain.metrics.abstentionCorrect).toBe(1);

    // Telemetry rows for replay sessions are gone.
    const leftover = store.db.prepare(
      `SELECT COUNT(*) as cnt FROM context_usage WHERE session_id LIKE 'eval-hook-%'`
    ).get() as { cnt: number };
    expect(leftover.cnt).toBe(0);

    // co_activations restored byte-identically.
    const coactAfter = store.db.prepare(`SELECT doc_a, doc_b, count FROM co_activations ORDER BY doc_a, doc_b`).all();
    expect(coactAfter).toEqual(coactBefore);

    // Env restored.
    expect(process.env.CLAWMEM_PROFILE).toBe("deep");
    if (envBefore === undefined) delete process.env.CLAWMEM_PROFILE;
    else process.env.CLAWMEM_PROFILE = envBefore;

    // --- 4. Enforced provenance invariants hold on real traces ---
    expect(report.enforced_invariant_violations).toBe(0);

    // --- Report integrity ---
    expect(report.examples_scored).toBe(5);
    expect(report.by_split.tuning!.cases).toBe(3);
    expect(report.by_split.holdout!.cases).toBe(2);
    // Machine-visible gate split (codex turn-7 F4): a run WITHOUT a baseline
    // is a trust-only run — acceptance is null, product acceptance is false.
    expect(report.gates.trust_pass).toBe(true);
    expect(report.gates.acceptance_pass).toBeNull();
    expect(report.gates.pass).toBe(false);
    expect(report.acceptance).toBeNull();
    // Comparable-run identity is embedded for future baselines.
    expect(report.identity?.gold_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.identity?.limit).toBe(report.limit);
    expect(artifacts).toBeNull(); // no outDir requested
  }, 30_000);

  it("acceptance gate: identity-checked baseline, holdout-only, machine-visible pass (codex turn-7 F4)", async () => {
    // The holdout case carries must_include AND must_not labels so the core
    // (non-waivable) strata are measured; abstention stays unmeasured — the
    // one waivable declaration this fixture legitimately needs.
    const gold = [
      { id: "a1", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
      { id: "a2", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC], must_not_include: ["test/memory/seo-hacks.md"] }, split: "holdout" as const },
    ];
    const goldPath = writeGold(gold);

    // Baseline run (same code — a self-comparison must PASS acceptance).
    const outDir = mkdtempSync(join(tmpdir(), "clawmem-accept-int-"));
    const { report: baseRun } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir });
    const baselineJson = join(outDir, "hook-run.json");
    expect(existsSync(baselineJson)).toBe(true);

    // Candidate vs that baseline: acceptance evaluated on the holdout slice.
    // The abstention axis is unmeasured-by-construction: UNDECLARED it fails…
    const { report: undeclaredRun } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: baselineJson });
    expect(undeclaredRun.acceptance!.pass).toBe(false);
    expect(undeclaredRun.acceptance!.notes.join(" ")).toContain("UNDECLARED unmeasured");
    // …declaring a NON-waivable axis changes nothing (core axes can't be waived)…
    const { report: nonWaivableRun } = await runHookEval({
      goldPath, store, minExamples: 1, audited: true, baselinePath: baselineJson,
      acceptUnmeasured: ["abstentionAccuracy", "mustNotCaseRate"],
    });
    expect(nonWaivableRun.acceptance!.notes.join(" ")).toContain("non-waivable");
    // …and DECLARED on the waivable axis, the measured axes decide — as a
    // CONDITIONAL pass, never unconditional product acceptance (turn-9 F5).
    const { report: cand } = await runHookEval({
      goldPath, store, minExamples: 1, audited: true, baselinePath: baselineJson,
      acceptUnmeasured: ["abstentionAccuracy"],
    });
    expect(cand.acceptance).not.toBeNull();
    expect(cand.acceptance!.slice).toBe("holdout");
    expect(cand.acceptance!.pass).toBe(true);
    expect(cand.acceptance!.mode).toBe("conditional");
    expect(cand.acceptance!.waived).toEqual(["abstentionAccuracy"]);
    expect(cand.acceptance!.axes.map(a => a.metric)).toContain("latencyP95Ms");
    expect(cand.acceptance!.axes.map(a => a.metric)).toContain("priorLegAccuracy");
    // The core must-not axis was genuinely measured (labels exist on holdout).
    expect(cand.acceptance!.axes.find(a => a.metric === "mustNotCaseRate")!.pass).toBe(true);
    expect(cand.gates.trust_pass).toBe(true);
    expect(cand.gates.acceptance_pass).toBe(true);
    expect(cand.gates.acceptance_waived).toEqual(["abstentionAccuracy"]);
    expect(cand.gates.pass).toBe(false); // waived → NOT unconditional product acceptance
    // The baseline carries a run-time identity (not an unattested legacy one).
    expect(cand.acceptance!.notes.some(n => n.includes("no run identity"))).toBe(false);
    // Identity is content-deep: the latency protocol matched (default reps),
    // so the latency axes were genuinely compared, not downgraded.
    expect(cand.acceptance!.axes.find(a => a.metric === "latencyP95Ms")!.pass).not.toBeNull();

    // An identity-incompatible baseline (different gold set) REFUSES to compare.
    const otherGold = writeGold([
      { id: "b1", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
      { id: "b2", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "holdout" as const },
    ]);
    await expect(runHookEval({ goldPath: otherGold, store, minExamples: 1, audited: true, baselinePath: baselineJson }))
      .rejects.toThrow(HookEvalIntegrityError);

    // A baseline missing the holdout slice FAILS acceptance — no overall fallback.
    const noHoldoutGold = writeGold([
      { id: "a1", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
      { id: "a2", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
    ]);
    const outDir2 = mkdtempSync(join(tmpdir(), "clawmem-accept-int2-"));
    await runHookEval({ goldPath: noHoldoutGold, store, minExamples: 1, audited: true, outDir: outDir2 });
    const { report: cand2 } = await runHookEval({ goldPath: noHoldoutGold, store, minExamples: 1, audited: true, baselinePath: join(outDir2, "hook-run.json") });
    expect(cand2.acceptance!.pass).toBe(false);
    expect(cand2.acceptance!.notes.join(" ")).toContain("held-out slice missing");
    expect(cand2.gates.acceptance_pass).toBe(false);
    expect(cand2.gates.pass).toBe(false);

    rmSync(outDir, { recursive: true, force: true });
    rmSync(outDir2, { recursive: true, force: true });
  }, 60_000);

  it("local-fallback policy at the runHookEval boundary: candidate forbidden, baseline attestation tiers (codex turn-11 F2/F3/F4)", async () => {
    const gold = [
      { id: "a1", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
      { id: "a2", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC], must_not_include: [SEO_DOC] }, split: "holdout" as const },
    ];
    const goldPath = writeGold(gold);
    const outDir = mkdtempSync(join(tmpdir(), "clawmem-topo-base-"));
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir });
    const baselineJson = join(outDir, "hook-run.json");
    const { readFileSync, writeFileSync: writeF } = await import("fs");
    const patchBaseline = (name: string, mutate: (identity: Record<string, any>) => void): string => {
      const raw = JSON.parse(readFileSync(baselineJson, "utf-8")) as Record<string, any>;
      mutate(raw.identity);
      const p = join(outDir, name);
      writeF(p, JSON.stringify(raw));
      return p;
    };
    const declare = { acceptUnmeasured: ["abstentionAccuracy"] };

    // (F3) An allowed-fallback CANDIDATE is refused outright — a mid-run
    // endpoint failure would silently execute an unidentified local model…
    process.env.CLAWMEM_NO_LOCAL_MODELS = "false";
    try {
      await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: baselineJson, ...declare }))
        .rejects.toThrow(/forbids local_fallback=allowed on the candidate/);
      // …while trust-only exploration (no baseline) stays available.
      const { report: trustOnly } = await runHookEval({ goldPath, store, minExamples: 1, audited: true });
      expect(trustOnly.identity!.topology.local_fallback).toBe("allowed");
      expect(trustOnly.gates.trust_pass).toBe(true); // speed-only fixture: no vector leg, latency evidence vacuously authoritative (codex t77 F4)
      expect(trustOnly.gates.acceptance_pass).toBeNull();
    } finally {
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    }

    // (F3) An UNATTESTED allowed-fallback baseline refuses comparison.
    const unattestedAllowed = patchBaseline("unattested-allowed.json", id => { id.topology.local_fallback = "allowed"; });
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: unattestedAllowed, ...declare }))
      .rejects.toThrow(/local fallback ALLOWED and its identity is not attested/);

    // (F4) Attested allowed + fallback_observed="none" is pipeline-equivalent
    // to blocked: comparison proceeds and acceptance can PASS — this also
    // proves local_fallback is compared by POLICY, not blind strict equality
    // (an "allowed" baseline vs a "blocked" candidate passes here).
    const attestedNone = patchBaseline("attested-none.json", id => {
      id.topology.local_fallback = "allowed";
      id.topology.fallback_observed = "none";
      id.attested = "test-attested 2026-08-13";
    });
    const { report: vsNone } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: attestedNone, ...declare });
    expect(vsNone.identity!.topology.local_fallback).toBe("blocked");
    expect(vsNone.acceptance!.pass).toBe(true);
    expect(vsNone.acceptance!.notes.join(" ")).toContain(`fallback_observed="none"`);

    // (F4) Attested allowed with routing "unknown" (or unattested-per-route)
    // does NOT throw — axes are computed and reported — but the comparison
    // is INFORMATIONAL-only and acceptance can never pass.
    for (const [name, mutate] of [
      ["attested-unknown.json", (id: Record<string, any>) => { id.topology.local_fallback = "allowed"; id.topology.fallback_observed = "unknown"; id.attested = "test-attested 2026-08-13"; }],
      ["attested-no-route.json", (id: Record<string, any>) => { id.topology.local_fallback = "allowed"; id.attested = "test-attested 2026-08-13"; }],
    ] as const) {
      const p = patchBaseline(name, mutate);
      const { report } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: p, ...declare });
      expect(report.acceptance!.pass).toBe(false);
      expect(report.gates.acceptance_pass).toBe(false);
      expect(report.acceptance!.notes.join(" ")).toContain("INFORMATIONAL");
      // The relevance axes were still individually computed and reported.
      expect(report.acceptance!.axes.find(a => a.metric === "ndcgMean")!.pass).toBe(true);
    }

    // (control) blocked-vs-blocked with every service unreachable is a
    // deterministic degradation — fully comparable.
    const { report: ctrl } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: baselineJson, ...declare });
    expect(ctrl.identity!.topology.local_fallback).toBe("blocked");
    expect(ctrl.identity!.topology.served_embed).toBe("unreachable");
    expect(ctrl.acceptance!.pass).toBe(true);

    rmSync(outDir, { recursive: true, force: true });
  }, 120_000);

  it("ranking-policy identity at the runHookEval boundary: weight/protocol strict, fusion rev informational, legacy demoted (codex turn-17 F1)", async () => {
    const gold = [
      { id: "rp1", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
      { id: "rp2", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC], must_not_include: [SEO_DOC] }, split: "holdout" as const },
    ];
    const goldPath = writeGold(gold);
    const outDir = mkdtempSync(join(tmpdir(), "clawmem-rankpol-base-"));
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir });
    const baselineJson = join(outDir, "hook-run.json");
    const { readFileSync, writeFileSync: writeF } = await import("fs");
    const patchBaseline = (name: string, mutate: (identity: Record<string, any>) => void): string => {
      const raw = JSON.parse(readFileSync(baselineJson, "utf-8")) as Record<string, any>;
      mutate(raw.identity);
      const p = join(outDir, name);
      writeF(p, JSON.stringify(raw));
      return p;
    };
    const declare = { acceptUnmeasured: ["abstentionAccuracy"] };

    // A live run self-identifies its ranking policy (effective weight, rev,
    // expansion protocol, degeneracy-gate toggle) — no treatment variable is
    // ever silently omitted (BUILD-3d added the gate).
    const { FUSION_POLICY_REV } = await import("../../src/hooks/surfacing-fusion.ts");
    const baselineReport = JSON.parse(readFileSync(baselineJson, "utf-8")) as Record<string, any>;
    expect(baselineReport.identity.ranking_policy).toEqual({
      // BUILD-4: the admission policy + rev join the exhaustive set — the
      // point of this toEqual is that NO treatment variable is silently omitted.
      admission_policy: "relevance",
      admission_rev: 1,
      rerank_lane_weight: 1.5,
      fusion_policy_rev: FUSION_POLICY_REV,
      expansion_set: "sampled",
      degeneracy_gate: "on",
    });

    // A rerank-lane weight difference is a TREATMENT — --baseline refuses it.
    const weightMismatch = patchBaseline("weight-mismatch.json", id => { id.ranking_policy.rerank_lane_weight = 0; });
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: weightMismatch, ...declare }))
      .rejects.toThrow(/rerank_lane_weight.*treatment/);

    // Different expansion protocols measured different inputs — refused.
    const drawMismatch = patchBaseline("draw-mismatch.json", id => { id.ranking_policy.expansion_set = "draw:deadbeef"; });
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: drawMismatch, ...declare }))
      .rejects.toThrow(/expansion_set/);

    // A fusion-policy rev difference is the code-under-test delta the
    // comparison exists to measure — note, not a refusal or demotion.
    const revDiffers = patchBaseline("rev-differs.json", id => { id.ranking_policy.fusion_policy_rev = 3; });
    const { report: vsRev } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: revDiffers, ...declare });
    expect(vsRev.acceptance!.pass).toBe(true);
    expect(vsRev.acceptance!.notes.join(" ")).toContain("fusion policy rev differs");

    // A legacy baseline (predates ranking_policy) is unverifiable — the
    // comparison proceeds but is INFORMATIONAL-only and can never pass.
    const legacy = patchBaseline("legacy-no-rankpol.json", id => { delete id.ranking_policy; });
    const { report: vsLegacy } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: legacy, ...declare });
    expect(vsLegacy.acceptance!.pass).toBe(false);
    expect(vsLegacy.gates.acceptance_pass).toBe(false);
    expect(vsLegacy.acceptance!.notes.join(" ")).toContain("predates ranking_policy identity");

    // BUILD-3a (codex turn-23 F5): a speed-only run never escalates —
    // finalization reports 0 samples, fits null, and the null NEVER fails
    // the gate (only false does).
    expect(baselineReport.finalization).toEqual({ samples: 0, max_ms: null, p95_ms: null, reserve_ms: 500, fits: null });
    expect(baselineReport.gates.finalization_reserve_ok).toBeNull();
    // No escalated reps → no substage samples → the breakdown is null, not {}.
    expect(baselineReport.finalization_breakdown).toBeNull();
    // Every rep measures total elapsed; a fast hermetic run is within budget.
    expect(baselineReport.budget_elapsed.samples).toBeGreaterThan(0);
    expect(baselineReport.gates.budget_elapsed_ok).toBe(true);

    // INTEGRATED failure path (codex turn-24 F1): a reserve or budget
    // violation must fail TRUST — the gate every CLI exit mode reads — not
    // merely flip an advisory field. (Samples injected via the declared
    // test seam; the measurement side is proven by the subprocess drivers.)
    const { report: reserveViolated } = await runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      _testTimingSamples: {
        finalization: [600],
        // Substages telescope to the violating sample (5+10+8+2+40+80+455 = 600).
        // BUILD-5: the reserve window has no "inject" — bookkeeping is post-output.
        finalizationSubstages: [{ filters: 5, enrich: 10, scoring: 8, ordering: 2, buildContext: 40, facts: 80, tail: 455 }],
      },
    });
    expect(reserveViolated.gates.finalization_reserve_ok).toBe(false);
    expect(reserveViolated.gates.trust_pass).toBe(false);
    expect(reserveViolated.gates.reasons.join(" ")).toContain("finalization exceeded the reserve");
    // Codex turn-49 finding 2: the report-level chain — substage samples →
    // `finalization_breakdown` → top-substage naming in the gate reason — is a
    // PRODUCT boundary. Deleting the report wiring must go red HERE, not stay
    // green behind the handler-level and helper-level tests.
    expect(reserveViolated.finalization_breakdown).toEqual({
      filters: { max_ms: 5, mean_ms: 5 },
      enrich: { max_ms: 10, mean_ms: 10 },
      scoring: { max_ms: 8, mean_ms: 8 },
      ordering: { max_ms: 2, mean_ms: 2 },
      buildContext: { max_ms: 40, mean_ms: 40 },
      facts: { max_ms: 80, mean_ms: 80 },
      tail: { max_ms: 455, mean_ms: 455 },
    });
    expect(reserveViolated.gates.reasons.join(" ")).toContain("top substages: tail=455ms, facts=80ms, buildContext=40ms");
    const { report: budgetViolated } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, _testTimingSamples: { totals: [99_999] } });
    expect(budgetViolated.gates.budget_elapsed_ok).toBe(false);
    expect(budgetViolated.gates.trust_pass).toBe(false);
    expect(budgetViolated.gates.reasons.join(" ")).toContain("not authoritative");

    // BUILD-3a: the internal budget self-identifies; a budget difference is
    // a treatment — refused like the weight.
    const { assertHookBudgetConfig } = await import("../../src/hooks/context-surfacing.ts");
    const EFFECTIVE_BUDGET: number = assertHookBudgetConfig();
    expect(baselineReport.identity.hook_budget_ms).toBe(EFFECTIVE_BUDGET);
    const budgetMismatch = patchBaseline("budget-mismatch.json", id => { id.hook_budget_ms = 9999; });
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: budgetMismatch, ...declare }))
      .rejects.toThrow(/hook_budget_ms.*treatment/);

    // BUILD-4: the admission policy self-identifies and is a treatment — an
    // unregistered difference is refused like the weight and the gate toggle.
    expect(baselineReport.identity.ranking_policy!.admission_policy).toBe("relevance");
    expect(baselineReport.identity.ranking_policy!.admission_rev).toBe(1);
    const admissionMismatch = patchBaseline("admission-mismatch.json", id => { id.ranking_policy.admission_policy = "composite"; });
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: admissionMismatch, ...declare }))
      .rejects.toThrow(/admission_policy.*treatment/);

    // A baseline that PREDATES hook_budget_ms necessarily ran under the
    // pre-BUILD-3a hardcoded 6000ms — compared as that value with a note,
    // never demoted (the build2f forward baselines stay fully comparable).
    const budgetLegacy = patchBaseline("budget-legacy.json", id => { delete id.hook_budget_ms; });
    const { report: vsBudgetLegacy } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: budgetLegacy, ...declare });
    expect(vsBudgetLegacy.acceptance!.pass).toBe(true);
    expect(vsBudgetLegacy.acceptance!.notes.join(" ")).toContain("pre-BUILD-3a code pinned 6000ms");

    rmSync(outDir, { recursive: true, force: true });
  }, 120_000);

  it("expansion-draw capture/freeze at the runHookEval boundary (codex turn-17 F2 + turn-18 F2 binding)", async () => {
    const gold = [
      { id: "ed1", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
    ];
    const goldPath = writeGold(gold);

    // Generator arm: harvest the llm_cache delta (EMPTY here — no inference
    // services and speed never expands; the harvest path, the fingerprint,
    // the BINDING, and the identity stamp are what this pins).
    const gen = await runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionCapture: true });
    expect(gen.expansionDraw).toBeDefined();
    expect(gen.expansionDraw!.rows).toEqual([]);
    expect(gen.expansionDraw!.fingerprint).toBe(expansionDrawFingerprint([]));
    expect(gen.report.identity!.ranking_policy!.expansion_set).toBe(`draw:${gen.expansionDraw!.fingerprint}`);
    const binding = gen.expansionDraw!.binding;
    expect(binding.gold_fingerprint).toBe(gen.report.identity!.gold_fingerprint);
    expect(binding.corpus).toBeNull(); // test runs carry no corpus hash
    expect(typeof binding.query_model).toBe("string");
    expect(typeof binding.rerank_model).toBe("string");
    expect(binding.rerank_request_rev).toBe(RERANK_REQUEST_REV); // codex turn-19 F2: request construction pinned

    // Replay arm: a synthetic draw is injected before scoring, its binding
    // validates against THIS run, the leak audit passes (no live LLM
    // writes), identity records the draw id, and the injected row is
    // present in the working store afterwards.
    const rows = [{ hash: "hook-eval-test-draw-row", result: JSON.stringify([{ type: "lex", query: "synthetic variant" }]) }];
    const fp = expansionDrawFingerprint(rows);
    const rep = await runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionFreeze: { fingerprint: fp, rows, binding } });
    expect(rep.report.identity!.ranking_policy!.expansion_set).toBe(`draw:${fp}`);
    expect(rep.expansionDraw).toBeUndefined();
    const cached = store.db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get("hook-eval-test-draw-row") as { result: string } | null;
    expect(cached?.result).toBe(rows[0]!.result);

    // A draw captured under a DIFFERENT gold set is refused — cached scores
    // are outputs, not evidence of identical inputs (codex turn-18 F2).
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionFreeze: { fingerprint: fp, rows, binding: { ...binding, gold_fingerprint: "0".repeat(64) } } }))
      .rejects.toThrow(/binding mismatch on gold_fingerprint/);
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionFreeze: { fingerprint: fp, rows, binding: { ...binding, corpus: "deadbeef" } } }))
      .rejects.toThrow(/binding mismatch on corpus/);
    // A draw captured under a DIFFERENT rerank request construction is
    // refused — corpus content alone does not determine transmitted text
    // across code revisions (codex turn-19 F2).
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionFreeze: { fingerprint: fp, rows, binding: { ...binding, rerank_request_rev: RERANK_REQUEST_REV + 1 } } }))
      .rejects.toThrow(/binding mismatch on rerank_request_rev/);
    // A corrupt draw file (fingerprint does not hash its rows) refuses to run.
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionFreeze: { fingerprint: "0".repeat(16), rows, binding } }))
      .rejects.toThrow(/draw fingerprint mismatch/);
    // Freeze and capture on one arm is a contradiction.
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionFreeze: { fingerprint: fp, rows, binding }, expansionCapture: true }))
      .rejects.toThrow(/mutually exclusive/);
  }, 120_000);

  it("deep 'sampled' identities are NOT comparable; equal frozen draws are (codex turn-18 F1)", async () => {
    // profiles = "deep" exercises expansion regardless of service
    // availability — exercisedServices keys on the PROFILES, and identity
    // must not let two independently-sampled deep runs compare as equal.
    const gold = [
      { id: "dp1", prompt: OAUTH_PROMPT, profile: "deep" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
      { id: "dp2", prompt: OAUTH_PROMPT, profile: "deep" as const, labels: { must_include: [OAUTH_DOC], must_not_include: [SEO_DOC] }, split: "holdout" as const },
    ];
    const goldPath = writeGold(gold);
    const outDir = mkdtempSync(join(tmpdir(), "clawmem-sampled-deep-"));
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir });
    const baselineJson = join(outDir, "hook-run.json");
    const declare = { acceptUnmeasured: ["abstentionAccuracy"] };

    // sampled vs sampled on a deep-exercising run → refused.
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: baselineJson, ...declare }))
      .rejects.toThrow(/"sampled" on both sides.*exercise expansion/);

    // Equal FROZEN draws compare: capture a draw on this gold, patch the
    // baseline to the same draw id, replay the candidate under that draw.
    const cap = await runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionCapture: true });
    const draw = cap.expansionDraw!;
    const rows = draw.rows.length > 0 ? draw.rows : [{ hash: "deep-sampled-test-row", result: "[]" }];
    const fp = expansionDrawFingerprint(rows);
    const { readFileSync, writeFileSync: writeF } = await import("fs");
    const raw = JSON.parse(readFileSync(baselineJson, "utf-8")) as Record<string, any>;
    raw.identity.ranking_policy.expansion_set = `draw:${fp}`;
    const patched = join(outDir, "baseline-frozen.json");
    writeF(patched, JSON.stringify(raw));
    const { report } = await runHookEval({
      goldPath, store, minExamples: 1, audited: true, baselinePath: patched, ...declare,
      expansionFreeze: { fingerprint: fp, rows, binding: draw.binding },
    });
    expect(report.identity!.ranking_policy!.expansion_set).toBe(`draw:${fp}`);
    expect(report.acceptance).not.toBeNull(); // comparison proceeded — no sampled refusal

    rmSync(outDir, { recursive: true, force: true });
  }, 120_000);

  it("served-model 'unknown' on an exercised service refuses unattested comparison; normalizer equivalence classes compare equal (codex turn-11 F2/F5)", async () => {
    // balanced profile EXERCISES the embed service (speed exercises none).
    const gold = [
      { id: "u1", prompt: OAUTH_PROMPT, profile: "balanced" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
      { id: "u2", prompt: OAUTH_PROMPT, profile: "balanced" as const, labels: { must_include: [OAUTH_DOC], must_not_include: [SEO_DOC] }, split: "holdout" as const },
    ];
    const goldPath = writeGold(gold);
    // Codex t76: this fixture store is in-memory, so its vector legs run
    // IN-PROCESS — on a vector-exercising profile that latency evidence is
    // not authoritative and the latency axes are unmeasured (declared here;
    // the daemon-backed protocol is exercised in eval-vector-daemon tests).
    const declare = { acceptUnmeasured: ["abstentionAccuracy", "latencyP50Ms", "latencyP95Ms"] };

    // Baseline and candidate BOTH probe "unknown" on the exercised embed
    // service: strict equality alone would pass — the unknown rule must
    // refuse (two unknowns matching proves nothing about the models).
    const outUnknown = mkdtempSync(join(tmpdir(), "clawmem-topo-unk-"));
    const unknownServed = { embed: "unknown", llm: "unreachable", rerank: "unreachable" };
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: outUnknown, servedModels: unknownServed });
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: join(outUnknown, "hook-run.json"), servedModels: unknownServed, ...declare }))
      .rejects.toThrow(/could not be fingerprinted/);

    // Control: a VALUED served fingerprint on both sides compares fine.
    const outValued = mkdtempSync(join(tmpdir(), "clawmem-topo-val-"));
    const valuedServed = { embed: "fixture-embed-v1", llm: "unreachable", rerank: "unreachable" };
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: outValued, servedModels: valuedServed });
    const { report: valued } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: join(outValued, "hook-run.json"), servedModels: valuedServed, ...declare });
    expect(valued.acceptance!.pass).toBe(true);

    // (F5) Normalizer equivalence at the boundary: a baseline recorded under
    // spelled-variant env (no-think "1", effort "bogus") and a candidate
    // under UNSET env fingerprint identically — the constructor defaults
    // noThink TRUE on unset, and an unsupported effort normalizes to
    // "default". Pre-fix the unset candidate recorded "default" ≠ "true"
    // and this comparison threw an identity mismatch.
    const priorNoThink = process.env.CLAWMEM_LLM_NO_THINK;
    const priorEffort = process.env.CLAWMEM_LLM_REASONING_EFFORT;
    const outNorm = mkdtempSync(join(tmpdir(), "clawmem-topo-norm-"));
    try {
      process.env.CLAWMEM_LLM_NO_THINK = "1";
      process.env.CLAWMEM_LLM_REASONING_EFFORT = "bogus";
      const { report: spelled } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: outNorm, servedModels: valuedServed });
      expect(spelled.identity!.topology.llm_no_think).toBe("true");
      expect(spelled.identity!.topology.llm_effort).toBe("default");
      delete process.env.CLAWMEM_LLM_NO_THINK;
      delete process.env.CLAWMEM_LLM_REASONING_EFFORT;
      const { report: unset } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: join(outNorm, "hook-run.json"), servedModels: valuedServed, ...declare });
      expect(unset.identity!.topology.llm_no_think).toBe("true"); // effective boolean, not "default"
      expect(unset.acceptance!.pass).toBe(true);
    } finally {
      if (priorNoThink === undefined) delete process.env.CLAWMEM_LLM_NO_THINK;
      else process.env.CLAWMEM_LLM_NO_THINK = priorNoThink;
      if (priorEffort === undefined) delete process.env.CLAWMEM_LLM_REASONING_EFFORT;
      else process.env.CLAWMEM_LLM_REASONING_EFFORT = priorEffort;
    }

    rmSync(outUnknown, { recursive: true, force: true });
    rmSync(outValued, { recursive: true, force: true });
    rmSync(outNorm, { recursive: true, force: true });
  }, 120_000);

  it("CLI cleans its working directory and defers the exit on the expected failure path (codex turn-11 F1)", async () => {
    const { readdirSync, mkdirSync } = await import("fs");
    const { createStore } = await import("../../src/store.ts");
    const scratch = mkdtempSync(join(tmpdir(), "clawmem-cli-clean-"));
    // A real on-disk snapshot for --db, a PRIVATE TMPDIR for the child (so
    // any leaked clawmem-hook-eval-* working dir is unambiguously the
    // child's), and a malformed gold file — the NORMAL failure path that
    // previously die()d past the finally and leaked the working dir.
    const snapPath = join(scratch, "snap.sqlite");
    const snap = createStore(snapPath);
    snap.db.close();
    const childTmp = join(scratch, "child-tmp");
    mkdirSync(childTmp);
    const badGold = join(scratch, "bad.jsonl");
    writeFileSync(badGold, "this is not json\n");

    const repoRoot = join(import.meta.dir, "../..");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("CLAWMEM_")) env[k] = v;
    }
    env.TMPDIR = childTmp;
    env.CLAWMEM_CONFIG_DIR = join(scratch, "child-config");   // dropping it alone would read ~/.config/clawmem
    mkdirSync(env.CLAWMEM_CONFIG_DIR);
    const child = Bun.spawnSync({
      cmd: ["bun", "src/clawmem.ts", "eval", "hook-run", "--gold", badGold, "--db", snapPath, "--min-examples", "1"],
      cwd: repoRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = child.stderr.toString();
    expect(child.exitCode).toBe(1);
    // The failure is the EXPECTED one (gold parse), reported after cleanup…
    expect(stderr).toContain("hook gold line 1");
    // …and the mkdtemp working directory did NOT leak: pre-fix, die()
    // process.exit()ed past the finally and left clawmem-hook-eval-* behind.
    const leaked = readdirSync(childTmp).filter(n => n.startsWith("clawmem-hook-eval-"));
    expect(leaked).toEqual([]);

    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  it("fails the trust gate on unresolved must labels and missing attestation", async () => {
    const goldPath = writeGold([
      {
        id: "stale-label",
        prompt: OAUTH_PROMPT,
        profile: "speed",
        labels: { must_include: ["test/memory/deleted-doc.md"] },
        split: "tuning",
      },
      {
        id: "ok",
        prompt: OAUTH_PROMPT,
        profile: "speed",
        labels: { must_include: [OAUTH_DOC] },
        split: "tuning",
      },
    ]);

    const { report } = await runHookEval({ goldPath, store, minExamples: 1, audited: false });
    expect(report.examples_scored).toBe(1); // stale-label case excluded, not silently skipped
    expect(report.unresolved_labels).toHaveLength(1);
    expect(report.gates.trust_pass).toBe(false);
    expect(report.gates.pass).toBe(false);
    expect(report.gates.reasons.join(" ")).toContain("unresolved");
    expect(report.gates.reasons.join(" ")).toContain("audit");
  }, 30_000);

  it("latency reps leave NO replay telemetry in the general OR skill store (codex turn-9 F2)", async () => {
    const { createStore } = await import("../../src/store.ts");
    const skillDir = mkdtempSync(join(tmpdir(), "hook-replay-skill-"));
    const skillPath = join(skillDir, "skill.sqlite");
    const skillStore = createStore(skillPath);
    // Filler docs make the 1-doc-vault BM25 degenerate-IDF artifact go away
    // (a term present in 100% of a corpus has IDF≈0, so a single-doc vault
    // FTS-scores its only match near zero and the composite floor rejects it).
    seedDocuments(skillStore, [
      { path: "obs/oauth-observation.md", title: "OAuth rotation observation", body: "Explain the OAuth refresh token rotation decision we made for the auth service — observation record.", collection: "skillobs", contentType: "decision", confidence: 0.95, qualityScore: 0.9 },
      { path: "obs/filler-a.md", title: "deploy checklist", body: "deployment checklist for the platform release train operators", collection: "skillobs", contentType: "note", confidence: 0.6, qualityScore: 0.7 },
      { path: "obs/filler-b.md", title: "meeting notes", body: "weekly meeting notes about roadmap priorities and staffing", collection: "skillobs", contentType: "note", confidence: 0.6, qualityScore: 0.7 },
      { path: "obs/filler-c.md", title: "style guide", body: "documentation style guide covering headings and terminology", collection: "skillobs", contentType: "note", confidence: 0.6, qualityScore: 0.7 },
    ]);
    skillStore.db.close();

    const goldPath = writeGold([
      { id: "sv1", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC], acceptable: ["skill:skillobs/obs/oauth-observation.md"] }, split: "tuning" as const },
    ]);
    const { report } = await runHookEval({ goldPath, store, minExamples: 1, audited: true, skillVaultDb: skillPath, latencyReps: 2 });
    expect(report.examples_scored).toBe(1);
    expect(report.cases[0]!.outcome).toBe("injected");
    // The SKILL document itself was injected — otherwise no skill-store
    // telemetry was ever written and the zero-row assertions below would be
    // vacuous (codex turn-10 finding 1).
    expect(report.cases[0]!.injectedPaths).toContain("skill:skillobs/obs/oauth-observation.md");

    // Neither store retains ANY replay-session telemetry after the run.
    const generalLeft = store.db.prepare(`SELECT COUNT(*) AS cnt FROM context_usage WHERE session_id LIKE 'eval-hook-%'`).get() as { cnt: number };
    expect(generalLeft.cnt).toBe(0);
    const skillDbCheck = createStore(skillPath);
    const skillUsage = skillDbCheck.db.prepare(`SELECT COUNT(*) AS cnt FROM context_usage WHERE session_id LIKE 'eval-hook-%'`).get() as { cnt: number };
    const skillRecall = skillDbCheck.db.prepare(`SELECT COUNT(*) AS cnt FROM recall_events WHERE session_id LIKE 'eval-hook-%'`).get() as { cnt: number };
    expect(skillUsage.cnt).toBe(0);
    expect(skillRecall.cnt).toBe(0);
    skillDbCheck.db.close();
  }, 60_000);

  it("trace inertness: the handler emits byte-identical output with and without a trace", async () => {
    const { contextSurfacing } = await import("../../src/hooks/context-surfacing.ts");
    const { newSurfacingTrace } = await import("../../src/eval/hook-trace.ts");

    const priorDedup = process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
    const priorProfile = process.env.CLAWMEM_PROFILE;
    process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
    process.env.CLAWMEM_PROFILE = "speed";
    try {
      const bare = await contextSurfacing(store, { prompt: OAUTH_PROMPT, sessionId: "inert-a" });
      const trace = newSurfacingTrace();
      const traced = await contextSurfacing(store, { prompt: OAUTH_PROMPT, sessionId: "inert-b" }, { trace });
      expect(traced.hookSpecificOutput?.additionalContext).toBe(bare.hookSpecificOutput?.additionalContext);
      expect(trace.outcome).toBe("injected");
      expect(trace.finalPaths.length).toBeGreaterThan(0);
    } finally {
      if (priorDedup === undefined) delete process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
      else process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = priorDedup;
      if (priorProfile === undefined) delete process.env.CLAWMEM_PROFILE;
      else process.env.CLAWMEM_PROFILE = priorProfile;
      store.db.prepare(`DELETE FROM context_usage WHERE session_id IN ('inert-a','inert-b')`).run();
    }
  }, 30_000);
});

// ===========================================================================
// BUILD-3b / BUILD-3c — cache identity (draw binding v3) + the in-run pair gate
// ===========================================================================
describe("BUILD-3b/3c: draw binding v3 + in-run pair gate", () => {
  let store: Store;
  let priorNoLocal: string | undefined;
  const dirs: string[] = [];

  beforeAll(() => {
    store = createTestStore();
    seedFixture(store);
    priorNoLocal = process.env.CLAWMEM_NO_LOCAL_MODELS;
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  });
  afterAll(() => {
    if (priorNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = priorNoLocal;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const newDir = (tag: string): string => {
    const d = mkdtempSync(join(tmpdir(), `clawmem-${tag}-`));
    dirs.push(d);
    return d;
  };

  // Two holdout cases with DIFFERENT nDCG, so restricting the slice to valid
  // pairs moves the mean measurably (the acceptance-restriction assertion).
  const PAIR_GOLD = [
    { id: "pg-tune", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
    { id: "pg-hit", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "holdout" as const },
    { id: "pg-miss", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [SEO_DOC] }, split: "holdout" as const },
  ];

  /** Rewrite one case's trace in a partner run's traces.jsonl. */
  function doctorTrace(dir: string, id: string, mutate: (t: Record<string, any>) => void): void {
    const p = join(dir, "traces.jsonl");
    const lines = readFileSync(p, "utf-8").split("\n").filter(l => l.trim());
    const out = lines.map(l => {
      const e = JSON.parse(l) as { id: string; trace: Record<string, any> };
      if (e.id === id) mutate(e.trace);
      return JSON.stringify(e);
    });
    writeFileSync(p, out.join("\n") + "\n");
  }

  /** Drop one case's trace entirely (the "absent from the partner" shape). */
  function dropTrace(dir: string, id: string): void {
    const p = join(dir, "traces.jsonl");
    const lines = readFileSync(p, "utf-8").split("\n").filter(l => l.trim());
    writeFileSync(p, lines.filter(l => (JSON.parse(l) as { id: string }).id !== id).join("\n") + "\n");
  }

  it("the draw binding carries the served-provider fingerprint and the transmitted-text manifest (v3)", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const gen = await runHookEval({
      goldPath, store, minExamples: 1, audited: true, expansionCapture: true,
      servedModels: { rerank: "behavioral:abc123def4567890" },
    });
    const binding = gen.expansionDraw!.binding;
    expect(binding.served_rerank).toBe("behavioral:abc123def4567890");
    expect(binding.transmitted_text_manifest).toMatch(/^[0-9a-f]{64}$/);
    // No rerank ran on the speed profile, so the manifest is the canonical
    // empty-set digest — deterministic, and equal on any arm that also
    // transmitted nothing.
    expect(binding.transmitted_text_manifest).toBe(transmittedTextManifest([]));

    // A draw captured against a DIFFERENT served reranker is refused before
    // injection: cached scores are that provider's outputs.
    const rows = [{ hash: "b3b-draw-row", result: "[]" }];
    const fp = expansionDrawFingerprint(rows);
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      servedModels: { rerank: "behavioral:0000000000000000" },
      expansionFreeze: { fingerprint: fp, rows, binding },
    })).rejects.toThrow(/binding mismatch on served_rerank/);
  }, 120_000);

  it("a transmitted-text manifest mismatch refuses the frozen replay (post-run, BUILD-3b)", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const gen = await runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionCapture: true });
    const rows = [{ hash: "b3b-manifest-row", result: "[]" }];
    const fp = expansionDrawFingerprint(rows);
    const poisoned = { ...gen.expansionDraw!.binding, transmitted_text_manifest: "f".repeat(64) };
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, expansionFreeze: { fingerprint: fp, rows, binding: poisoned } }))
      .rejects.toThrow(/transmitted-text manifest mismatch/);
  }, 120_000);

  it("preflight refuses every unusable pair configuration BEFORE any case runs", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-pre");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });

    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner }))
      .rejects.toThrow(/requires a pre-registered pairMinValid/);
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairMinValid: 2 }))
      .rejects.toThrow(/meaningless without pairWith/);
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: newDir("pair-empty"), pairMinValid: 1 }))
      .rejects.toThrow(/no readable hook-run.json/);
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 1, expansionCapture: true }))
      .rejects.toThrow(/pairWith and expansionCapture are mutually exclusive/);
    // A third run is not the partner — "acceptance over valid pairs" needs
    // the baseline to BE the partner.
    const other = newDir("pair-other");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: other });
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 1, baselinePath: join(other, "hook-run.json") }))
      .rejects.toThrow(/--baseline is run .* under the pair gate acceptance is computed over VALID PAIRS/s);
  }, 180_000);

  it("a clean pair validates every case and restricts nothing", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-clean-a");
    const a = await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    const b = await runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 3, outDir: newDir("pair-clean-b") });

    expect(b.report.pair_audit).not.toBeNull();
    expect(b.report.pair_audit!.valid).toBe(3);
    expect(b.report.pair_audit!.invalid).toBe(0);
    expect(b.report.pair_audit!.retried).toBe(0);
    expect(b.report.pair_audit!.partner_run_id).toBe(a.report.run_id);
    expect(b.report.aggregate.cases).toBe(3);
    expect(b.report.by_split["holdout"]!.cases).toBe(2);
    for (const c of b.report.cases) expect(c.pair_valid).toBe(true);
  }, 180_000);

  it("a permanently divergent case is RETRIED, then EXCLUDED from every reported mean", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-rej-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    // A pre-treatment surface the candidate can never reproduce.
    doctorTrace(partner, "pg-miss", t => { t.sessionTopic = "poisoned-topic-no-run-will-produce"; });

    const b = await runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 2, pairMaxRetries: 1, outDir: newDir("pair-rej-b") });
    const pa = b.report.pair_audit!;
    expect(pa.valid).toBe(2);
    expect(pa.invalid).toBe(1);
    expect(pa.retried).toBe(1); // reject + REPLACE: the case was actually re-run
    expect(pa.invalid_cases.map(c => c.id)).toEqual(["pg-miss"]);
    expect(pa.invalid_cases[0]!.divergences.join(" ")).toMatch(/sessionTopic/);

    // The metrics cover valid pairs ONLY; the rejected case survives as
    // evidence, flagged.
    expect(b.report.cases.length).toBe(3);
    expect(b.report.examples_scored).toBe(3);
    expect(b.report.aggregate.cases).toBe(2);
    expect(b.report.by_split["holdout"]!.cases).toBe(1);
    expect(b.report.cases.find(c => c.id === "pg-miss")!.pair_valid).toBe(false);
    expect(b.report.cases.find(c => c.id === "pg-hit")!.pair_valid).toBe(true);
  }, 180_000);

  it("a case ABSENT from the partner is invalid and is never retried (a re-run cannot create a partner trace)", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-abs-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    dropTrace(partner, "pg-miss");

    const b = await runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 2, pairMaxRetries: 2, outDir: newDir("pair-abs-b") });
    expect(b.report.pair_audit!.invalid).toBe(1);
    expect(b.report.pair_audit!.retried).toBe(0);
    expect(b.report.pair_audit!.invalid_cases[0]!.divergences.join(" ")).toMatch(/absent from the partner/);
  }, 180_000);

  it("below the PRE-REGISTERED valid count the run REFUSES, carrying the evidence in the error", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-ref-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    doctorTrace(partner, "pg-miss", t => { t.sessionTopic = "poisoned"; });

    // 3 registered, only 2 obtainable.
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 3, pairMaxRetries: 0, outDir: newDir("pair-ref-b") }))
      .rejects.toThrow(/pair gate REFUSED: 2 valid pair\(s\) < pre-registered pairMinValid 3[\s\S]*pg-miss/);
  }, 180_000);

  it("acceptance recomputes the BASELINE slice over the same valid ids (never the partner's stored mean)", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-acc-a");
    const a = await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    // Unrestricted holdout mean covers pg-hit (nDCG 1) + pg-miss (nDCG 0).
    const storedHoldout = a.report.by_split["holdout"]!;
    expect(storedHoldout.cases).toBe(2);
    const hitNdcg = a.report.cases.find(c => c.id === "pg-hit")!.metrics.ndcg;
    expect(storedHoldout.ndcgMean).not.toBe(hitNdcg); // the two cases really do differ

    doctorTrace(partner, "pg-miss", t => { t.sessionTopic = "poisoned"; });
    const b = await runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 2, pairMaxRetries: 0,
      baselinePath: join(partner, "hook-run.json"),
      outDir: newDir("pair-acc-b"),
    });
    const ndcgAxis = b.report.acceptance!.axes.find(x => x.metric === "ndcgMean")!;
    // The baseline side is the RESTRICTED recompute (pg-hit only), not the
    // stored two-case mean — otherwise the comparison would average a case
    // the candidate excluded.
    expect(ndcgAxis.baseline).toBeCloseTo(hitNdcg!, 10);
    expect(ndcgAxis.baseline).not.toBeCloseTo(storedHoldout.ndcgMean!, 10);
    expect(ndcgAxis.candidate).toBeCloseTo(hitNdcg!, 10);
  }, 180_000);

  it("a PRE-REGISTERED witness that ends invalid REFUSES the run, even when the total count is met", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-wit-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    doctorTrace(partner, "pg-miss", t => { t.sessionTopic = "poisoned"; });

    // 2 valid pairs satisfies pairMinValid — but pg-miss was named a witness,
    // so the experiment no longer tests what it registered.
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 2, pairMaxRetries: 0,
      pairRequireIds: ["pg-hit", "pg-miss"],
      outDir: newDir("pair-wit-b"),
    })).rejects.toThrow(/did not survive as valid, base-exposed pairs[\s\S]*pg-miss: NOT A VALID PAIR/);

    // And a witness that IS a valid pair but never reached the policy under
    // test is refused just as hard (codex turn-30 SPEC-2). On this hermetic
    // fixture no reranker runs, so pg-hit is a valid pair in which the
    // treatment never operated — exactly the shape that used to pass.
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 2, pairMaxRetries: 0,
      pairRequireIds: ["pg-hit"],
      outDir: newDir("pair-wit-c"),
    })).rejects.toThrow(/pg-hit: valid pair but the TREATMENT NEVER OPERATED/);
  }, 240_000);

  it("a stratum minimum counted over TREATMENT-EXPOSED pairs refuses a stratum of degraded cases", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-exp-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });

    // All 3 pairs are valid, so the plain stratum minimum is met...
    const ok = await runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 3, pairMinValidByStratum: { holdout: 2 },
      outDir: newDir("pair-exp-ok"),
    });
    expect(ok.report.pair_audit!.valid).toBe(3);
    expect(ok.report.pair_audit!.treatment_exposed).toBe(0); // no reranker on this fixture

    // ...but NONE of them exercised the treatment, so an exposed minimum refuses.
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 3, pairMinExposedByStratum: { holdout: 2 },
      outDir: newDir("pair-exp-b"),
    })).rejects.toThrow(/holdout: 0 treatment-EXPOSED < 2 required/);
  }, 240_000);

  it("exposure is decided by the REAL handler's pre-treatment envelope, and both arms agree (codex turn-31 SPEC-3)", async () => {
    // Its own store: the deep path only reranks a pool of >=3, so this test
    // seeds several docs that all carry the prompt vocabulary (the current-FTS
    // leg ANDs every prompt token). A stubbed reranker then ANSWERS the whole
    // pool, so the handler records coverageComplete + >=2 sentPaths — the
    // symmetric, pre-treatment surface exposure is judged on.
    const deepStore = createTestStore();
    seedDocuments(deepStore, [0, 1, 2, 3].map(i => ({
      path: `memory/oauth-variant-${i}.md`,
      title: `OAuth refresh token rotation note ${i}`,
      body: `# OAuth refresh token rotation ${i}\n\nExplain the OAuth refresh token rotation decision we made for the auth service. Variant ${i} of the rotation rationale.`,
      contentType: "decision" as const,
      confidence: 0.8,
      qualityScore: 0.8,
    })));
    const realRerank = deepStore.rerank.bind(deepStore);
    (deepStore as unknown as { rerank: unknown }).rerank = async (
      _q: string, docs: { file: string; text: string }[],
    ) => docs.map((d, i) => ({ file: d.file, score: 1 - i * 0.01 })); // FULL coverage
    const goldPath = writeGold([
      { id: "dx-1", prompt: OAUTH_PROMPT, profile: "deep" as const, labels: { must_include: ["test/memory/oauth-variant-0.md"] }, split: "tuning" as const },
      { id: "dx-2", prompt: OAUTH_PROMPT, profile: "deep" as const, labels: { must_include: ["test/memory/oauth-variant-0.md"] }, split: "holdout" as const },
    ]);
    try {
      const partner = newDir("pair-deepexp-a");
      await runHookEval({ goldPath, store: deepStore, minExamples: 1, audited: true, outDir: partner });
      const partnerTraces = readFileSync(join(partner, "traces.jsonl"), "utf-8").split("\n").filter(Boolean)
        .map(l => JSON.parse(l) as { id: string; trace: { rerank?: { coverageComplete?: boolean; sentPaths?: string[] } } });
      const exposedInPartner = partnerTraces.filter(t =>
        t.trace.rerank?.coverageComplete === true && (t.trace.rerank?.sentPaths?.length ?? 0) >= 2);
      expect(exposedInPartner.length).toBe(2); // the fixture really does expose the treatment

      const b = await runHookEval({
        goldPath, store: deepStore, minExamples: 1, audited: true,
        pairWith: partner, pairMinValid: 2,
        pairRequireIds: ["dx-1", "dx-2"],                 // witnesses must end EXPOSED, not merely valid
        pairMinExposedByStratum: { deep: 2 },
        outDir: newDir("pair-deepexp-b"),
      });
      expect(b.report.pair_audit!.valid).toBe(2);
      expect(b.report.pair_audit!.treatment_exposed).toBe(2); // both arms agree — the surface is pre-treatment
      expect(b.report.pair_audit!.min_exposed_by_stratum).toEqual({ deep: 2 });
      // Codex turn-50 residual (CR-3): the PRODUCTION collector — the rep
      // loop's repTrace.timings.finalizationSubstages push into
      // allFinalizationSubstages — is locked by this REAL escalating run.
      // Every escalated rep records finalization + its substages, so the
      // report's breakdown must be populated here, not null. Deleting the
      // collector push in hook-run.ts goes red on THIS assertion (the seam
      // test upstream covers only injection → report → gate reason).
      expect(b.report.finalization.samples).toBeGreaterThan(0);
      expect(b.report.finalization_breakdown).not.toBeNull();
      const bdKeys = Object.keys(b.report.finalization_breakdown!);
      // BUILD-5: the reserve window ends at the payload boundary — no "inject".
      for (const k of ["filters", "enrich", "scoring", "ordering", "buildContext", "facts", "tail"]) {
        expect(bdKeys).toContain(k);
      }
      expect(bdKeys).not.toContain("inject");
    } finally {
      (deepStore as unknown as { rerank: unknown }).rerank = realRerank;
      deepStore.db.close();
    }
  }, 240_000);

  it("codex migration r2 #6: a RETRIED case's leg records are keyed by ATTEMPT — both attempts persist under distinct (leg, case, attempt, rep) keys, and the worst names its attempt", async () => {
    const restoreSearches = realSearches(store);
    stubSearchVec(store, (async () => []) as Store["searchVec"]); // hermetic in-process vector leg: no embedding, no network
    try {
      const goldPath = writeGold(PAIR_GOLD);
      const partner = newDir("pair-att-a");
      await runHookEval({ goldPath, store, minExamples: 1, audited: true, profileOverride: "balanced", latencyReps: 1, outDir: partner });
      doctorTrace(partner, "pg-miss", t => { t.sessionTopic = "poisoned-topic-no-run-will-produce"; }); // forces a retry of pg-miss
      const res = await runHookEval({ goldPath, store, minExamples: 1, audited: true, profileOverride: "balanced", latencyReps: 1, pairWith: partner, pairMinValid: 2, pairMaxRetries: 1, outDir: newDir("pair-att-b") });
      expect(res.report.pair_audit!.retried).toBe(1);
      const recs = res.report.vector_leg_records;
      const keys = recs.map(r => `${r.leg}|${r.case}|${r.attempt}|${r.rep}`);
      expect(new Set(keys).size).toBe(keys.length); // pre-fix: pg-miss's two attempts collided on case + rep
      expect(recs.filter(r => r.case === "pg-miss" && r.leg === "primary").map(r => r.attempt).sort()).toEqual([0, 1]);
      const top = recs.reduce((a, b) => (b.over_ms > a.over_ms ? b : a));
      expect(res.report.vector_deadline.worst).toMatchObject({ leg: top.leg, case: top.case, attempt: top.attempt, rep: top.rep });
    } finally { restoreSearches(); }
  }, 240_000);

  it("a retried attempt's enforced violation survives into the trust gate AND the artifacts (codex turn-30 F3 seam)", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-inv-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    doctorTrace(partner, "pg-miss", t => { t.sessionTopic = "poisoned"; }); // forces a retry of pg-miss

    const res = await runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 2, pairMaxRetries: 1,
      outDir: newDir("pair-inv-b"),
      // Attempt 0 of the retried case acquires an enforced violation; the
      // retry is clean. Pre-fix, the replacement overwrote the case and the
      // violation vanished from both the gate and the artifacts.
      _testAuditTransform: (audit, caseId, attempt) =>
        caseId === "pg-miss" && attempt === 0
          ? { ...audit, enforcedViolations: [...audit.enforcedViolations, { id: "trace-complete", violations: ["synthetic first-attempt violation"] }] }
          : audit,
    });

    expect(res.report.pair_audit!.retried).toBe(1);        // the case really was re-run
    expect(res.report.enforced_invariant_violations).toBe(1);
    expect(res.report.gates.trust_pass).toBe(false);
    expect(res.report.gates.reasons.join(" ")).toContain("enforced invariant violation");
    // The surviving attempt is clean, so the evidence lives ONLY here.
    const cse = res.report.cases.find(c => c.id === "pg-miss")!;
    expect(cse.invariants.enforcedViolations).toHaveLength(0);
    expect(cse.superseded_attempts![0]!.enforcedViolations[0]!.violations).toEqual(["synthetic first-attempt violation"]);
  }, 240_000);

  it("a PRE-REGISTERED stratum minimum REFUSES the run when that stratum loses its cases", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-str-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    doctorTrace(partner, "pg-miss", t => { t.sessionTopic = "poisoned"; });

    // Total is 2 (met), but the holdout stratum now carries only 1 valid pair.
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 2, pairMaxRetries: 0,
      pairMinValidByStratum: { holdout: 2 },
      outDir: newDir("pair-str-b"),
    })).rejects.toThrow(/stratum minimum\(s\) unmet[\s\S]*holdout: 1 valid < 2 required/);
  }, 240_000);

  it("pre-registration is validated up front: unknown witness ids, strata matching nothing, unbounded retries", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-prereg-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });

    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 1, pairRequireIds: ["pg-hit", "typo-case"] }))
      .rejects.toThrow(/absent from the gold set: typo-case/);
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 1, pairMinValidByStratum: { deap: 2 } }))
      .rejects.toThrow(/neither a profile .* nor a split .* present in this gold set/);
    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 1, pairMaxRetries: Infinity }))
      .rejects.toThrow(/pairMaxRetries must be a finite non-negative integer/);
  }, 240_000);

  it("a pair-restricted report is refused as a baseline for an UNGATED run (restricted vs unrestricted means)", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("pair-base-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    const gatedDir = newDir("pair-base-b");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 3, outDir: gatedDir });

    await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, baselinePath: join(gatedDir, "hook-run.json") }))
      .rejects.toThrow(/was produced under a pair gate/);
  }, 240_000);

  it("admission-basis minima are ENFORCED and RECORDED through the production runner (codex t69 F1)", async () => {
    const goldPath = writeGold(PAIR_GOLD);
    const partner = newDir("basis-a");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    // The fixture is BM25-only (speed profile, no vector service), so every
    // judged case lands on the "bm25-rrf" basis. A pre-registered minimum the
    // rows can carry passes, and pair_audit records BOTH the declared minima
    // and the row-derived coverage.
    const b = await runHookEval({
      goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 3,
      pairMinBasisByStratum: { "speed:bm25-rrf": 2, "holdout:bm25-rrf": 1 },
      outDir: newDir("basis-b"),
    });
    const pa = b.report.pair_audit!;
    expect(pa.min_basis_by_stratum).toEqual({ "speed:bm25-rrf": 2, "holdout:bm25-rrf": 1 });
    expect(pa.valid_basis_by_stratum["speed:bm25-rrf"]!).toBeGreaterThanOrEqual(2);
    expect(pa.valid_basis_by_stratum["holdout:bm25-rrf"]!).toBeGreaterThanOrEqual(1);
    // The recorded coverage reconciles with the per-case rows via the SAME
    // exported derivation the replicated aggregate uses — the recording is
    // recomputable evidence, not a free-standing number.
    const validIds = new Set(b.report.cases.filter(c => c.pair_valid === true).map(c => c.id));
    expect(pa.valid_basis_by_stratum).toEqual(deriveValidBasisByStratum(b.report.cases, validIds));

    // A pre-registered minimum the rows CANNOT carry refuses the run: the
    // speed profile never reranks, so no case is judged on rerank-fused-rrf.
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true, pairWith: partner, pairMinValid: 3,
      pairMinBasisByStratum: { "speed:rerank-fused-rrf": 1 },
      outDir: newDir("basis-d"),
    })).rejects.toThrow(/speed:rerank-fused-rrf: 0 valid pair\(s\) judged on that admission basis < 1 required/);
  }, 240_000);
});

// ===========================================================================
// BUILD-3d (turn-41) — registered treatments: the experiment is RUNNABLE
// ===========================================================================
describe("BUILD-3d: registered treatments at the runHookEval boundary (codex turn-40 F2/F4)", () => {
  let store: Store;
  let priorNoLocal: string | undefined;
  const dirs: string[] = [];

  beforeAll(() => {
    store = createTestStore();
    seedFixture(store);
    priorNoLocal = process.env.CLAWMEM_NO_LOCAL_MODELS;
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  });
  afterAll(() => {
    if (priorNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = priorNoLocal;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const newDir = (tag: string): string => {
    const d = mkdtempSync(join(tmpdir(), `clawmem-${tag}-`));
    dirs.push(d);
    return d;
  };

  /** Rewrite the partner's recorded identity (hook-run.json) — the cheap way
   *  to stand up a REAL other-arm report without a second process: the pair
   *  envelope excludes the treatment's own trace state, so the traces stay
   *  valid pairs while the identity declares the other arm. */
  function doctorReportIdentity(dir: string, mutate: (rp: Record<string, any>) => void): void {
    const p = join(dir, "hook-run.json");
    const r = JSON.parse(readFileSync(p, "utf-8")) as Record<string, any>;
    mutate(r.identity.ranking_policy as Record<string, any>);
    writeFileSync(p, JSON.stringify(r, null, 2));
  }

  const GOLD = [
    { id: "rt-tune", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
    { id: "rt-hit", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC], must_not_include: [SEO_DOC] }, split: "holdout" as const },
  ];

  it("an invalid CLAWMEM_EVAL_NOW refuses the run BEFORE scoring (codex t55 CR-6)", async () => {
    const goldPath = writeGold(GOLD);
    const prior = process.env.CLAWMEM_EVAL_NOW;
    process.env.CLAWMEM_EVAL_NOW = "not-a-timestamp";
    try {
      await expect(runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: newDir("evalnow-bad") }))
        .rejects.toThrow(/CLAWMEM_EVAL_NOW/);
    } finally {
      if (prior === undefined) delete process.env.CLAWMEM_EVAL_NOW;
      else process.env.CLAWMEM_EVAL_NOW = prior;
    }
  }, 60_000);

  it("a gate-differing partner is REFUSED without registration and ACCEPTED with it — paired acceptance measures the registered difference (F2)", async () => {
    const goldPath = writeGold(GOLD);
    const partner = newDir("rt-partner");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
    doctorReportIdentity(partner, rp => { rp.degeneracy_gate = "off"; });

    // Unregistered: the in-run identity gate refuses the pair outright.
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 2,
      outDir: newDir("rt-unreg"),
    })).rejects.toThrow(/NOT identity-comparable[\s\S]*degeneracy_gate/);

    // Registered: the pair gate accepts exactly that difference, and PAIRED
    // acceptance (--baseline = the partner) computes instead of throwing —
    // this is the composition codex proved impossible pre-fix. The abstention
    // axis is unmeasured-by-construction on this gold (no abstain cases) and
    // declared, so acceptance decides on the measured axes (CONDITIONAL —
    // same recipe as the standing acceptance integration test).
    const r = await runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      pairWith: partner, pairMinValid: 2, pairTreatments: ["degeneracy_gate"],
      baselinePath: join(partner, "hook-run.json"),
      acceptUnmeasured: ["abstentionAccuracy"],
      outDir: newDir("rt-reg"),
    });
    expect(r.report.pair_audit!.registered_treatments).toEqual(["degeneracy_gate"]);
    expect(r.report.pair_audit!.treatment_contrast).toEqual({ degeneracy_gate: { candidate: "on", partner: "off" } });
    expect(r.report.acceptance).not.toBeNull();
    expect(r.report.acceptance!.notes.join("\n")).toContain("REGISTERED treatment degeneracy_gate");
    expect(r.report.gates.acceptance_pass).toBe(true); // same runs — no regression
    expect(r.report.acceptance!.mode).toBe("conditional"); // waived abstention axis, never unconditional
  }, 240_000);

  it("an UNPAIRED --baseline still refuses the gate difference — registration exists only inside a paired experiment (F2)", async () => {
    const goldPath = writeGold(GOLD);
    const base = newDir("rt-base");
    await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: base });
    doctorReportIdentity(base, rp => { rp.degeneracy_gate = "off"; });
    await expect(runHookEval({
      goldPath, store, minExamples: 1, audited: true,
      baselinePath: join(base, "hook-run.json"),
      outDir: newDir("rt-nobase"),
    })).rejects.toThrow(/degeneracy_gate[\s\S]*REGISTERED|degeneracy_gate.*treatment variable/);
  }, 240_000);

  it("measured vector-deadline gate: a breach is an INDEPENDENT TRUST FAILURE that fails the member — budget AND latency authority both stay topology-scoped (codex t82 P1 hard gate)", async () => {
    // The 2026-08-26 draws recorded daemon-required legs path:"ok" past their
    // 900ms deadline (a cold client hydrate blocked the race timer). A speed-only
    // gold is budget-authoritative (no embed profile → representative totalMs), so
    // injected per-invocation overshoot samples isolate the MEASURED deadline gate.
    const goldPath = writeGold(GOLD);
    const breached = await runHookEval({
      goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
      // O1 §3: the injected sample is a COMPLETE per-rep record (span on both clocks, terminal kind, status).
      _testTimingSamples: { vectorLegs: [{ leg: "primary", over_ms: 2230, budget_ms: 900, case: "rt-tune", attempt: 0, rep: 0, mono_elapsed_ms: 3130, wall_elapsed_ms: 3130, clock_skew_ms: 0, terminal_kind: "completion", status: "ok" }] },
      outDir: newDir("vd-breach"),
    });
    expect(breached.report.vector_deadline.adhered).toBe(false);
    expect(breached.report.vector_deadline.max_over_ms).toBe(2230);
    expect(breached.report.vector_deadline.worst).toEqual({ leg: "primary", case: "rt-tune", attempt: 0, rep: 0, budget_ms: 900 });
    // O1 §3: EVERY rep's record is persisted in full, keyed case + rep, with the harness-derived
    // timing class and the run's deadline-protocol identity (stamped on EVERY run since O1 activation — never null) — a late
    // SUCCESS is distinguishable from a late abandonment in the artifact itself.
    expect(breached.report.vector_leg_records).toEqual([{ leg: "primary", over_ms: 2230, budget_ms: 900, case: "rt-tune", attempt: 0, rep: 0, mono_elapsed_ms: 3130, wall_elapsed_ms: 3130, clock_skew_ms: 0, terminal_kind: "completion", status: "ok", timing: "late", deadline_protocol: "monotonic-relative-v1" }]);
    const persisted = JSON.parse(readFileSync(breached.artifacts!.runJsonPath, "utf8")) as { vector_leg_records: unknown[] };
    expect(persisted.vector_leg_records).toEqual(breached.report.vector_leg_records);
    // The breach is an INDEPENDENT trust failure (codex t82 P1) — never a
    // waivable latency axis: the member FAILS.
    expect(breached.report.gates.vector_deadline_ok).toBe(false);
    expect(breached.report.gates.trust_pass).toBe(false);
    expect(breached.report.gates.pass).toBe(false);
    expect(breached.report.gates.reasons.some((r: string) => /measured vector deadline did NOT hold/.test(r))).toBe(true);
    // Authority stays TOPOLOGY-scoped: latency axes remain authoritative
    // (daemon-backed) — the breach fails trust instead of demoting them.
    expect(breached.report.vector_exec!.latency_authoritative).toBe(true);
    expect(breached.report.vector_exec!.note).toBeNull();
    // BUDGET authority is RETAINED and independently evaluated: the gate is
    // NOT null and trust does NOT fail on a budget-UNMEASURED reason.
    expect(breached.report.gates.budget_elapsed_ok).not.toBeNull();
    expect(breached.report.gates.reasons.some((r: string) => /budget evidence UNMEASURED/.test(r))).toBe(false);

    // Converse: every injected invocation within its deadline ⇒ gate passes.
    const warm = await runHookEval({
      goldPath, store, minExamples: 1, audited: true, latencyReps: 1,
      _testTimingSamples: { vectorLegs: [{ leg: "primary", over_ms: -420, budget_ms: 900, case: "rt-tune", attempt: 0, rep: 0, mono_elapsed_ms: 480, wall_elapsed_ms: -4520, clock_skew_ms: -5000, terminal_kind: "completion", status: "ok" }] },
      outDir: newDir("vd-warm"),
    });
    expect(warm.report.vector_deadline.adhered).toBe(true);
    expect(warm.report.gates.vector_deadline_ok).toBe(true);
    // O1 §3: a wall STEP during the leg is visible from the artifact while the monotonic verdict stands.
    expect(warm.report.vector_leg_records[0]).toMatchObject({ timing: "early", clock_skew_ms: -5000, mono_elapsed_ms: 480 });
    expect(warm.report.gates.reasons.some((r: string) => /measured vector deadline/.test(r))).toBe(false);
    expect(warm.report.vector_exec!.latency_authoritative).toBe(true);
    expect(warm.report.vector_exec!.note).toBeNull();
  }, 180_000);

  it("codex migration r2 #2: REAL per-rep collection — every rep's own leg record is persisted, and a breach in rep 1 (never rep 0) is the attributed worst", async () => {
    const goldPath = writeGold([{ id: "rt-reps", prompt: OAUTH_PROMPT, profile: "balanced", labels: { must_include: [OAUTH_DOC] }, split: "tuning", tags: ["reps"] }]);
    const restoreSearches = realSearches(store);
    let calls = 0;
    // The in-process vector leg (no daemon serves this vault): the 2nd rep's synchronous scan overruns the
    // 900 ms leg deadline; the others answer at once. The stall spins on the RAW clock.
    stubSearchVec(store, (async () => {
      calls++;
      if (calls === 2) { const until = performance.now() + 1200; while (performance.now() < until) { /* stall */ } }
      return [];
    }) as Store["searchVec"]);
    try {
      const r = await runHookEval({ goldPath, store, minExamples: 1, audited: true, latencyReps: 3, outDir: newDir("vd-reps") });
      const recs = r.report.vector_leg_records.filter(x => x.leg === "primary");
      expect(recs.map(x => [x.case, x.attempt, x.rep])).toEqual([["rt-reps", 0, 0], ["rt-reps", 0, 1], ["rt-reps", 0, 2]]);
      expect(recs[1]!.over_ms).toBeGreaterThan(150);
      expect(recs[0]!.over_ms).toBeLessThanOrEqual(0);
      expect(recs[2]!.over_ms).toBeLessThanOrEqual(0);
      expect(r.report.vector_deadline.worst).toMatchObject({ leg: "primary", case: "rt-reps", attempt: 0, rep: 1 });
      expect(r.report.vector_deadline.adhered).toBe(false);
    } finally { restoreSearches(); }
  }, 120_000);

  it("admission_policy pair on SPEED cases: the per-case ledger records base AND treatment exposure with no rerank lane (ship-draw aggregate refusal 2026-08-26)", async () => {
    // The 2026-08-26 shipping draws: five clean admission_policy members were
    // refused by the replicated aggregate because every balanced/speed row
    // carried pair_treatment_exposed=true with pair_base_exposed=false — the
    // base ledger was computed with the NO-treatment (rerank) predicate while
    // admission_policy exposure is the admission-input ledger. Speed cases
    // never run the rerank lane, so this is exactly that row shape at the
    // real runner: the witnesses (regression-watch, BASE exposure) must
    // survive and the ledger must satisfy treatment ⇒ base ⇒ valid.
    const goldPath = writeGold(GOLD);
    // One experiment, one clock (codex t56 F1): the admission-input ledger
    // carries composite inputs (recency), so both arms compute them on the
    // same pinned CLAWMEM_EVAL_NOW — exactly what scripts/experiment-clock.sh
    // does for every shipping draw.
    const priorNow = process.env.CLAWMEM_EVAL_NOW;
    process.env.CLAWMEM_EVAL_NOW = "2026-08-26T00:00:00Z";
    let r;
    try {
      const partner = newDir("rt-adm-partner");
      await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
      doctorReportIdentity(partner, rp => { rp.admission_policy = "composite"; });
      r = await runHookEval({
        goldPath, store, minExamples: 1, audited: true,
        pairWith: partner, pairMinValid: 2, pairTreatments: ["admission_policy"],
        pairRequireIds: ["rt-tune", "rt-hit"],
        pairMinExposedByStratum: { speed: 2 },
        outDir: newDir("rt-adm-cand"),
      });
    } finally {
      if (priorNow === undefined) delete process.env.CLAWMEM_EVAL_NOW;
      else process.env.CLAWMEM_EVAL_NOW = priorNow;
    }
    expect(r.report.pair_audit!.registered_treatments).toEqual(["admission_policy"]);
    expect(r.report.pair_audit!.treatment_exposed).toBe(2);
    expect(r.report.pair_audit!.witness_outcomes).toEqual([
      { id: "rt-tune", valid: true, base_exposed: true },
      { id: "rt-hit", valid: true, base_exposed: true },
    ]);
    for (const id of ["rt-tune", "rt-hit"]) {
      const row = r.report.cases.find(c => c.id === id)!;
      expect(row.pair_valid).toBe(true);
      expect(row.pair_base_exposed).toBe(true);
      expect(row.pair_treatment_exposed).toBe(true);
    }
    // The implication chain the aggregate re-derives, over EVERY row.
    for (const row of r.report.cases) {
      if (row.pair_treatment_exposed) expect(row.pair_base_exposed).toBe(true);
      if (row.pair_base_exposed) expect(row.pair_valid).toBe(true);
    }
  }, 240_000);

  it("gate-treatment exposure counts only assessment-FIRED pairs; witnesses stay regression-watch (F4)", async () => {
    // Own deep store: pool of >=3 docs all carrying the prompt vocabulary,
    // reranker stubbed at the store boundary.
    const deepStore = createTestStore();
    seedDocuments(deepStore, [0, 1, 2, 3].map(i => ({
      path: `memory/oauth-variant-${i}.md`,
      title: `OAuth refresh token rotation note ${i}`,
      body: `# OAuth refresh token rotation ${i}\n\nExplain the OAuth refresh token rotation decision we made for the auth service. Variant ${i} of the rotation rationale.`,
      contentType: "decision" as const,
      confidence: 0.8,
      qualityScore: 0.8,
    })));
    const realRerank = deepStore.rerank.bind(deepStore);
    const deepGold = [
      { id: "gx-1", prompt: OAUTH_PROMPT, profile: "deep" as const, labels: { must_include: ["test/memory/oauth-variant-0.md"] }, split: "tuning" as const },
      { id: "gx-2", prompt: OAUTH_PROMPT, profile: "deep" as const, labels: { must_include: ["test/memory/oauth-variant-0.md"] }, split: "holdout" as const },
    ];
    try {
      // ---- Degenerate scores (constant): the gate FIRES on every request ----
      (deepStore as unknown as { rerank: unknown }).rerank = async (
        _q: string, docs: { file: string; text: string }[],
      ) => docs.map(d => ({ file: d.file, score: 0.5 }));
      const goldPath = writeGold(deepGold);
      const pd = newDir("rt-deg-a");
      await runHookEval({ goldPath, store: deepStore, minExamples: 1, audited: true, outDir: pd });
      doctorReportIdentity(pd, rp => { rp.degeneracy_gate = "off"; });
      const fired = await runHookEval({
        goldPath, store: deepStore, minExamples: 1, audited: true,
        pairWith: pd, pairMinValid: 2, pairTreatments: ["degeneracy_gate"],
        pairRequireIds: ["gx-1", "gx-2"],          // regression-watch: base exposure suffices
        pairMinExposedByStratum: { deep: 2 },      // treatment-aware: gate-FIRED pairs
        outDir: newDir("rt-deg-b"),
      });
      expect(fired.report.pair_audit!.treatment_exposed).toBe(2);
      expect(fired.report.pair_audit!.registered_treatments).toEqual(["degeneracy_gate"]);
      expect(fired.report.pair_audit!.treatment_contrast).toEqual({ degeneracy_gate: { candidate: "on", partner: "off" } });
      // Per-stratum outcome evidence recorded by the REAL runner (turn-43 F2):
      // both deep cases valid + gate-fired; the witnesses recorded valid +
      // base-exposed.
      expect(fired.report.pair_audit!.valid_by_stratum.deep).toBe(2);
      expect(fired.report.pair_audit!.treatment_exposed_by_stratum.deep).toBe(2);
      expect(fired.report.pair_audit!.witness_outcomes).toEqual([
        { id: "gx-1", valid: true, base_exposed: true },
        { id: "gx-2", valid: true, base_exposed: true },
      ]);
      // Per-case LEDGER rows at the real runner (turn-45 F1): deleting either
      // production assignment (pair_base_exposed / pair_treatment_exposed)
      // turns these red — the aggregate derives everything from these rows.
      for (const id of ["gx-1", "gx-2"]) {
        const row = fired.report.cases.find(c => c.id === id)!;
        expect(row.pair_valid).toBe(true);
        expect(row.pair_base_exposed).toBe(true);
        expect(row.pair_treatment_exposed).toBe(true);
      }

      // ---- Discriminating scores: the gate NEVER fires ----
      (deepStore as unknown as { rerank: unknown }).rerank = async (
        _q: string, docs: { file: string; text: string }[],
      ) => docs.map((d, i) => ({ file: d.file, score: 0.9 - i * 0.1 }));
      const ph = newDir("rt-hlt-a");
      await runHookEval({ goldPath, store: deepStore, minExamples: 1, audited: true, outDir: ph });
      doctorReportIdentity(ph, rp => { rp.degeneracy_gate = "off"; });
      // The stratum minimum refuses (0 gate-fired pairs) while the WITNESSES
      // are fine — the refusal must name the stratum, not the witnesses.
      await expect(runHookEval({
        goldPath, store: deepStore, minExamples: 1, audited: true,
        pairWith: ph, pairMinValid: 2, pairTreatments: ["degeneracy_gate"],
        pairRequireIds: ["gx-1", "gx-2"],
        pairMinExposedByStratum: { deep: 1 },
        outDir: newDir("rt-hlt-b"),
      })).rejects.toThrow(/treatment-EXPOSED < 1/);
      // Without the exposed minimum the same run COMPLETES, and the ledger
      // records the never-fired shape at the real runner: valid + BASE
      // exposed, treatment NOT exposed (turn-45 F1 — the base assignment has
      // its own mutation kill here).
      const unfired = await runHookEval({
        goldPath, store: deepStore, minExamples: 1, audited: true,
        pairWith: ph, pairMinValid: 2, pairTreatments: ["degeneracy_gate"],
        outDir: newDir("rt-hlt-c"),
      });
      expect(unfired.report.pair_audit!.treatment_exposed).toBe(0);
      for (const id of ["gx-1", "gx-2"]) {
        const row = unfired.report.cases.find(c => c.id === id)!;
        expect(row.pair_valid).toBe(true);
        expect(row.pair_base_exposed).toBe(true);
        expect(row.pair_treatment_exposed).toBe(false);
      }
    } finally {
      (deepStore as unknown as { rerank: unknown }).rerank = realRerank;
      deepStore.db.close();
    }
  }, 360_000);
});

describe("BUILD-3d turn-42: registered no-op refused in PREFLIGHT — before any case is scored", () => {
  it("a registered treatment equal on both arms refuses before scoring (GPU protection, codex turn-42 F2)", async () => {
    const store = createTestStore();
    seedFixture(store);
    const prior = process.env.CLAWMEM_NO_LOCAL_MODELS;
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    const partner = mkdtempSync(join(tmpdir(), "clawmem-preflight-"));
    try {
      const goldPath = writeGold([
        { id: "pf-tune", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "tuning" as const },
        { id: "pf-hit", prompt: OAUTH_PROMPT, profile: "speed" as const, labels: { must_include: [OAUTH_DOC] }, split: "holdout" as const },
      ]);
      await runHookEval({ goldPath, store, minExamples: 1, audited: true, outDir: partner });
      // The partner ran the SAME policy (gate on) — registering the gate
      // treatment is a no-op configuration. It must refuse in PREFLIGHT:
      // the audit-transform seam fires on every scored attempt, so zero
      // invocations proves no case was scored before the refusal.
      let attempts = 0;
      await expect(runHookEval({
        goldPath, store, minExamples: 1, audited: true,
        pairWith: partner, pairMinValid: 2, pairTreatments: ["degeneracy_gate"],
        _testAuditTransform: (audit) => { attempts++; return audit; },
      })).rejects.toThrow(/preflight[\s\S]*does NOT differ[\s\S]*BEFORE any case is scored/);
      expect(attempts).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
      else process.env.CLAWMEM_NO_LOCAL_MODELS = prior;
      rmSync(partner, { recursive: true, force: true });
      store.db.close();
    }
  }, 240_000);
});
