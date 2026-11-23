import { isoNow } from "../clock.ts";
/**
 * Context-surfacing provenance trace — the per-stage diagnostics envelope
 * (RANKING-DEFECT-HANDOFF Addendum 5, BUILD-0 / CONTRACT-5).
 *
 * One `SurfacingTrace` records everything a single `contextSurfacing`
 * invocation did: which retrieval legs ran, every candidate's raw channel
 * score + rank at insertion, rerank coverage, per-document composite scores,
 * the admission decision, post-admission reorders, and the final injected
 * order. It exists so ranking diagnosis reads ground truth instead of
 * inferring cause from final output — the Addendum 4 mis-diagnosis
 * (spreading-activation-over-hubs) happened precisely because no per-stage
 * record existed.
 *
 * The trace is OBSERVATION ONLY: collecting it never changes retrieval,
 * ranking, admission, or output. The handler populates it when (a) the
 * caller passes one in (the hook replay-eval harness), or (b)
 * CLAWMEM_SURFACING_TRACE=1 asks the live hook to persist envelopes into
 * `surfacing_diagnostics` for post-hoc diagnosis.
 *
 * Forward-looking fields (`rankingKey`, `TraceCandidate.lane`) are part of
 * the envelope contract now so the BUILD-1..5 invariant checkers have a
 * stable schema to key on; today's handler records the current behavior
 * (`rankingKey: "composite"`, no lanes) truthfully.
 */

/** Retrieval leg that produced a candidate. */
export type SurfacingLeg =
  | "vector"            // primary vector leg (current prompt)
  | "fts-fallback"      // BM25 when the vector leg returned nothing
  | "fts-supplement"    // BM25 supplement merged alongside vector results
  | "prior-vector"      // gated prior-turns leg: vector over the joined prior prompts
  | "prior-fts"         // gated prior-turns leg: BM25 over one prior prompt
  | "secondary-vault"   // opt-in secondary-vault FTS (surface_secondary_vaults)
  | "file-aware"        // per-file-path FTS on the raw current prompt
  | "expansion-lex"     // deep escalation: expanded lexical variant → FTS
  | "expansion-vec";    // deep escalation: expanded vec/hyde variant → vector

/** One candidate as returned by one leg, recorded AT INSERTION TIME. */
export interface TraceCandidate {
  leg: SurfacingLeg;
  /** Expansion / file-aware legs: the variant or file query that produced this hit. */
  variantQuery?: string;
  filepath: string;
  displayPath: string;
  /** Raw score channel — "fts" (BM25 transform) or "vec" (cosine). Incomparable across channels. */
  source: "fts" | "vec";
  /** The channel score at insertion, BEFORE rerank blending or composite scoring. */
  rawScore: number;
  /** 0-based rank within this leg's returned list. */
  rank: number;
  /** False when the seen-set dedupe dropped the hit at insertion (provenance still recorded). */
  pooled: boolean;
}

export interface TraceRetrievalQuery {
  current: string;
  /** Prior-turn texts folded in by multi-turn lookback (empty = current-only). */
  priors: string[];
  combined: string;
  /** True when priors were folded into the combined query. */
  multiTurn: boolean;
  /** True when the combined query was clamped to the char budget. */
  truncated: boolean;
}

export interface TraceRerank {
  attempted: boolean;
  /** Candidate filepaths sent to the reranker. */
  sentPaths: string[];
  /**
   * sha256 of each candidate's TRANSMITTED text (store.rerankTextHash — the
   * transport projection, not the handler's 2000-char slice), aligned with
   * sentPaths. The eval's draw-binding transmitted-text manifest is built
   * from these (BUILD-3b). Absent on traces recorded before BUILD-3b.
   */
  sentTextHashes?: string[];
  /** Filepaths that actually received a reranker score. */
  coveredPaths: string[];
  scores: { filepath: string; score: number }[];
  /**
   * True when the reranker ANSWERED the complete candidate set (full
   * coverage) — the guard-level truth that arbitrates the failure guard,
   * independent of whether the lane influenced ordering. Separated from
   * orderingApplied because a zero rerank-lane weight keeps coverage true
   * while applying NO ordering (codex turn-17 finding 1). Absent on traces
   * recorded before turn-18, where orderingApplied carried this meaning.
   */
  coverageComplete?: boolean;
  /**
   * True when the reranker's ranking was ACTUALLY incorporated into the
   * FINAL ORDERING KEY as a rank-fused lane (BUILD-2) — which requires FULL
   * coverage, a positive rerank-lane weight (a zero-weight lane is skipped
   * by the shared RRF and applies nothing; codex turn-17 finding 1), AND a
   * non-degenerate score set when the degeneracy gate is active (BUILD-3d).
   * Raw channel scores are never blended (the pre-BUILD-2 0.6/0.4 blend is
   * gone); false with coverageComplete=true means the lane was inert by
   * weight OR discarded as degenerate (the `degeneracy` field
   * distinguishes); false with failed=true means the rerank was discarded
   * and the failure guard arbitrated instead.
   */
  orderingApplied: boolean;
  failed: boolean;
  /**
   * BUILD-3d: per-request degeneracy assessment of the fully-covered score
   * set (assessRerankDegeneracy — floors adapted from the rerank-health
   * probe). Recorded whenever full coverage was reached — the only state in
   * which an ordering decision was on the table — REGARDLESS of the gate
   * toggle, so a control arm still measures how often the gate would fire.
   * `gated` records whether the gate's ACTION was armed
   * (CLAWMEM_RERANK_DEGENERACY_GATE): gated && degenerate ⇒ the lane was
   * DISCARDED (orderingApplied stays false, the failure guard arbitrates).
   * Deliberately NOT part of the pair-audit pre-treatment envelope: the
   * assessment is a pure function of the compared `scores`, and `gated` is
   * the treatment's own state. Absent on traces recorded before BUILD-3d.
   */
  degeneracy?: {
    gated: boolean;
    degenerate: boolean;
    reason: "collapse" | "inert" | "invalid" | null;
    maxScore: number;
    spread: number;
    thresholds: { calibFloor: number; spreadFloor: number };
  };
}

export interface TraceExpansion {
  attempted: boolean;
  variants: { type: string; query: string; used: boolean }[];
  failed: boolean;
}

export interface TraceCompositeEntry {
  filepath: string;
  displayPath: string;
  /** The RAW channel search score fed into composite — never rerank-blended (BUILD-2). */
  searchScore: number;
  compositeScore: number;
}

export interface TraceAdmission {
  /** "relevance" = BUILD-4 admission on the final ordering basis; "adaptive"/"absolute" = the pre-BUILD-4 composite modes (kept for historical traces). */
  mode: "adaptive" | "absolute" | "relevance";
  bestScore: number;
  /** Composite modes only (pre-BUILD-4). */
  activationFloor?: number;
  /** Adaptive mode: max(bestScore * minScoreRatio, absoluteFloor). */
  adaptiveMin?: number;
  /** Absolute mode: the legacy minScore threshold. */
  minScore?: number;
  /** Relevance mode (BUILD-4): the basis judged on — the same key that orders. */
  basis?: "bm25-rrf" | "weighted-rrf" | "rerank-fused-rrf";
  /** Relevance mode: top band-0 mass (band-1 top when band 0 is empty). */
  topMass?: number;
  /** Relevance mode: relative spread (top − kth)/top over the band-0 leaders — DIAGNOSTIC only (rank bonuses make fused-mass spread non-flat by construction); null when band 0 was empty. */
  spreadRel?: number | null;
  /** Relevance mode: how many present candidates carry keyword-class current agreement — zero in band 0 is the degenerate-basis abstention signature. */
  keywordAgreed?: number;
  /** Relevance mode: the per-basis floor actually applied. */
  floorRatio?: number;
  /** Relevance mode: query-level abstention cause (null = no abstention). */
  abstainReason?: "no-current-support" | "degenerate-basis" | null;
  /** `candidate` = vault-qualified identity (candidateKey); the admission-honored invariant matches on it, not displayPath (cross-vault twins share a displayPath). Relevance mode adds the ordering-basis evidence per entry. */
  admitted: { candidate: string; displayPath: string; compositeScore: number; mass?: number; band?: 0 | 1 }[];
  rejected: { candidate: string; displayPath: string; compositeScore: number; mass?: number; band?: 0 | 1; reason?: string }[];
  /** True when admission bailed the whole injection (activation floor pre-BUILD-4; query-level abstention since). */
  abstained: boolean;
}

export interface TraceInjectionEntry {
  /** Vault-qualified identity (candidateKey) of the injected doc — the admission/single-ranking-key invariants match on this, not displayPath (cross-vault twins share a displayPath). */
  candidate: string;
  displayPath: string;
  tier: string;
  tokens: number;
}

/** One candidate's weighted-fusion membership record (BUILD-1, C1c). */
export interface TraceFusionCandidate {
  /** Vault-qualified identity: bare filepath for general-vault docs, `skill:`-prefixed for skill-vault docs (SPEC-5). */
  filepath: string;
  displayPath: string;
  /** Which vault produced this candidate. */
  vault: "general" | "skill";
  /** Every lane that returned this candidate. */
  lanes: SurfacingLeg[];
  /** Total post-cap weighted RRF contribution across lanes. */
  contribution: number;
  /** Post-cap contribution split per lane — lets the invariant audit prove per-lane-class claims (e.g. zero expansion contribution) independently of lane overlap. */
  laneContributions: { lane: SurfacingLeg; contribution: number }[];
  /** Supported by at least one current-class lane (vector / fts / file-aware / secondary). */
  currentSupported: boolean;
  /** CONTRACT-1(d) cheap per-candidate gate: the doc shares content vocabulary with the gate token set (current prompt's tokens, or the priors' on a pure-anaphora prompt; fails closed when both are empty). */
  currentQueryGatePassed: boolean;
  /** Admitted into the candidate pool by membership selection. */
  admitted: boolean;
}

/** Weighted-fusion membership record for one invocation (BUILD-1, C1/C1c). */
export interface TraceFusion {
  lanes: { lane: SurfacingLeg; weight: number; count: number }[];
  candidates: TraceFusionCandidate[];
  /** Provenance of the per-candidate gate's token set: the current prompt, the prior turns (pure-anaphora fallback), or none (gate fails closed). */
  gateTokenSource: "current" | "prior" | "none";
  /** Post-cap aggregate weighted mass of the current-class lanes. */
  currentMass: number;
  /** Post-cap aggregate weighted mass of the prior+expansion lanes. */
  discountedMass: number;
  /** The discounted mass BEFORE any cap scaling. */
  preCapDiscountedMass: number;
  capApplied: boolean;
  capFactor: number | null;
  poolBound: number;
  protectedSlots: number;
  admittedCurrentSupported: number;
}

/** The gated prior-turns leg decision (CONTRACT-1e). */
export interface TracePriorLeg {
  enabled: boolean;
  reason: string;
  priorsUsed: number;
}

/** Reason an invocation emitted no context. */
export type TraceEmptyReason =
  | "gate:empty-prompt"
  | "gate:short-prompt"
  | "gate:slash-command"
  | "gate:skip-retrieval"
  | "gate:heartbeat"
  | "gate:recent-duplicate"
  | "no-results"
  | "all-filtered"
  | "all-snoozed"
  | "threshold"
  | "activation-floor"
  // BUILD-4 relevance-admission outcomes:
  | "admission-no-current"   // query-level abstention: zero current-supported candidates
  | "admission-degenerate"   // query-level abstention: flat band-0 basis, no keyword agreement
  | "admission-floor"        // every candidate fell below the relative per-doc floor
  | "budget"
  // t61 (codex F60-2): the retrieval-commit alignment row could not be
  // written (lock contention/lockout past busy_timeout) — the hook fails the
  // injection rather than injecting an untracked turn.
  | "alignment-unavailable";

export interface SurfacingTrace {
  traceVersion: 1;
  /**
   * The final ordering authority recorded truthfully. Post-BUILD-2 an
   * injected outcome records "rrf" (channel-aware weighted RRF key) or
   * "rerank" (the RRF key with the reranker's ranking rank-fused in as one
   * more lane); "composite" remains only the pre-ordering default (empty
   * outcomes never reach the ordering step).
   */
  rankingKey: "composite" | "rrf" | "rerank";
  /**
   * BUILD-2: the final ordering key per candidate that reached the ordering
   * step, in the final order. The key is the pair (band, keyValue): band 0 =
   * current-supported (the current-anchor tier), band 1 = discounted-only
   * survivors, which order strictly BELOW band 0 ("fuse prior/expansion legs
   * BELOW current"). The band is UNCONDITIONAL on current support — an applied
   * full-coverage rerank adds keyValue MASS within the bands but never
   * elevates one (coverage proves the reranker answered, not that it
   * discriminated; codex turn-15). `candidate` is the vault-qualified identity
   * (candidateKey) — displayPath alone collapses cross-vault twins. The
   * single-ranking-key invariant walks the injected candidates against these.
   */
  finalOrder: { candidate: string; displayPath: string; band: 0 | 1; keyValue: number }[] | null;
  profileName: string | null;
  sessionTopic: string | null;
  isRecencyIntent: boolean | null;
  retrievalQuery: TraceRetrievalQuery | null;
  priorLeg: TracePriorLeg | null;
  candidates: TraceCandidate[];
  fusion: TraceFusion | null;
  expansion: TraceExpansion | null;
  rerank: TraceRerank | null;
  filters: {
    privateDropped: string[];
    snoozedDropped: string[];
    noiseDropped: string[];
    dedupeCollapsed: number;
  };
  composite: TraceCompositeEntry[];
  topicBoost: { topic: string; boosted: string[]; demoted: string[] } | null;
  /**
   * BUILD-4 turn-54/55 (codex turn-53 finding 3 + turn-54 finding 3): the
   * ADMISSION-INPUT LEDGER — recorded IMMEDIATELY BEFORE the policy branch
   * and therefore arm-symmetric on an admission-only pair by construction
   * (the admitted/rejected split inside `admission` is produced by the
   * SELECTED policy arm and is deliberately excluded from pair comparison).
   * Each entry carries the COMPLETE per-candidate policy input of BOTH arms:
   * the ordering key {band, mass} the relevance policy judges, and the
   * compositeScore the composite control judges (deterministic across arms
   * only under the frozen evaluation clock — CLAWMEM_EVAL_NOW, recorded in
   * the run identity as eval_now). Entries are key-sorted for canonical
   * comparison. Null when the invocation never reached the admission step
   * (gate / no-results / all-filtered returns).
   */
  admissionInput: { candidates: { key: string; band: 0 | 1; mass: number; compositeScore: number }[] } | null;
  admission: TraceAdmission | null;
  /** Post-admission co-activation score deltas (E11). */
  spreadingActivation: { displayPath: string; delta: number }[];
  /** Post-admission procedural diversification move (E10). */
  diversification: { displayPath: string; fromIndex: number; toIndex: number } | null;
  injection: {
    entries: TraceInjectionEntry[];
    totalTokens: number;
  } | null;
  blocks: { relationships: number; vaultFacts: boolean } | null;
  outcome: "injected" | "empty" | null;
  emptyReason: TraceEmptyReason | null;
  /** Final injected displayPaths in order (empty on empty outcome). */
  finalPaths: string[];
  timings: {
    totalMs: number | null;
    vectorMs: number | null;
    escalationMs: number | null;
    /** BUILD-3a (boundary redefined at BUILD-5): escalation end → payload assembled — validated against FINALIZATION_RESERVE_MS by the observed invariant. Null when the deep escalation never ran. */
    finalizationMs?: number | null;
    /**
     * BUILD-3d.4: per-substage breakdown of the finalization window
     * (escalation end → emit), so the harness measures WHERE the reserve is
     * spent rather than asserting a bare aggregate against the constant.
     * Keyed filters/enrich/scoring/ordering/buildContext/facts/tail; each
     * value is ms for that substage. Present only when finalizationMs is
     * (deep reps); a substage absent from the record was not reached (early
     * empty return). BUILD-5: the substages cover the RESERVE window only
     * (escalation end → payload assembled); the post-output bookkeeping
     * writes moved past the payload boundary and are measured as
     * postOutputMs, never in this record.
     */
    finalizationSubstages?: Record<string, number> | null;
    /** BUILD-5/t60 (t48-B + codex F59-3): payload-assembled → emit — the in-handler bookkeeping HANDOFF (job packaging for the off-process drainer; no SQLite), measured OUTSIDE the finalization reserve and recorded for EVERY payload-bearing profile, not just deep. Null when no payload was assembled (empty outcomes). */
    postOutputMs?: number | null;
    /** BUILD-5/t60: true when the post-output bookkeeping HANDOFF was SKIPPED because the internal deadline had already passed (fail-open — the alignment row was already written at retrieval commit, so only the learning signal is lost). Initialized false in newSurfacingTrace (codex F59-3: absence must never read as "executed and not skipped"). */
    postOutputSkipped?: boolean;
  };
  /**
   * Codex t76 (daemon-backed eval): the classified execution path of EVERY
   * vector leg this invocation attempted, in order — "ok" (daemon answered),
   * "busy"/"error" (daemon present, bounded fallback to FTS), "absent" (no
   * daemon: the in-process synchronous scan ran, or — under
   * CLAWMEM_VECTOR_DAEMON_REQUIRED — the leg returned [] and the evaluator
   * refuses the run as daemon loss), "model_mismatch". The replay harness
   * reads this to prove the daemon-required protocol was actually executed.
   */
  vectorLegs?: { leg: "primary" | "prior" | "deep"; path: import("../vector-daemon.ts").VecExecStatus; protocol?: import("../vector-daemon.ts").VecResponseProtocol; vectorFaults?: number }[];
  /**
   * Codex t80 P1 / t81 P1+P2, O1 §3: one record per COMPLETED vector
   * INVOCATION (primary once, prior once, deep once per expansion query) —
   * see VectorLegDeadlineRecord. The eval enforces the MAX overshoot across
   * every invocation of the run and persists every rep's records.
   */
  vectorLegDeadlines?: VectorLegDeadlineRecord[];
}

/** O1 §3 evidence contract — the terminal dimension of one vector invocation, orthogonal to its execution path. */
export type VectorLegTerminal = "completion" | "abandonment" | "fallback";

/**
 * One COMPLETED vector invocation's timing record (codex t80 P1 / t81 P1+P2; O1 §3).
 *
 * `over_ms` = finish − the invocation's OWN deadline, MONOTONIC (positive =
 * finished LATE; under hydrated-v1 that covers only the bounded per-line
 * response decode — hydration runs daemon-side). `budget_ms` = the window the
 * invocation was actually allotted (its deadline − its start): the real per-leg
 * bound (the min() for primary, the dynamic bound for prior/deep), NOT the
 * nominal profile timeout. `mono_elapsed_ms` is the authoritative duration,
 * `wall_elapsed_ms` the same span on the wall clock, and `clock_skew_ms` their
 * difference — a realtime STEP, visible from the artifact (it cannot see
 * FREQUENCY error, which scales both clocks alike; that stays a host preflight).
 * `terminal_kind` × `status` are orthogonal, so a late SUCCESS and a late
 * ABANDONMENT are distinct records; `timing` (early / on_time / late) is
 * DERIVED by the harness against its frozen tolerance, never recorded here.
 * Every value is a projected number (`evidenceMs` / `spanEvidence`): the record
 * is persisted and compared as JSON.
 */
export interface VectorLegDeadlineRecord {
  leg: "primary" | "prior" | "deep";
  over_ms: number;
  budget_ms: number;
  mono_elapsed_ms: number;
  wall_elapsed_ms: number;
  clock_skew_ms: number;
  terminal_kind: VectorLegTerminal;
  /** The invocation's classified execution path (its vectorLegs entry), or null if the leg recorded none. */
  status: import("../vector-daemon.ts").VecExecStatus | null;
}

/** Fresh all-null trace for one invocation. */
export function newSurfacingTrace(): SurfacingTrace {
  return {
    traceVersion: 1,
    rankingKey: "composite",
    finalOrder: null,
    profileName: null,
    sessionTopic: null,
    isRecencyIntent: null,
    retrievalQuery: null,
    priorLeg: null,
    candidates: [],
    fusion: null,
    expansion: null,
    rerank: null,
    filters: { privateDropped: [], snoozedDropped: [], noiseDropped: [], dedupeCollapsed: 0 },
    composite: [],
    topicBoost: null,
    admissionInput: null,
    admission: null,
    spreadingActivation: [],
    diversification: null,
    injection: null,
    blocks: null,
    outcome: null,
    emptyReason: null,
    finalPaths: [],
    timings: { totalMs: null, vectorMs: null, escalationMs: null, finalizationMs: null, finalizationSubstages: null, postOutputMs: null, postOutputSkipped: false },
    vectorLegs: [],
    vectorLegDeadlines: [],
  };
}

/** Record one leg's returned hits into the trace (insertion-time provenance). */
export function traceLegHits(
  trace: SurfacingTrace | undefined,
  leg: SurfacingLeg,
  hits: { filepath: string; displayPath: string; source: "fts" | "vec"; score: number }[],
  pooledFilepaths: ReadonlySet<string>,
  variantQuery?: string
): void {
  if (!trace) return;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    trace.candidates.push({
      leg,
      ...(variantQuery !== undefined ? { variantQuery } : {}),
      filepath: h.filepath,
      displayPath: h.displayPath,
      source: h.source,
      rawScore: h.score,
      rank: i,
      pooled: pooledFilepaths.has(h.filepath),
    });
  }
}

/**
 * Env gate for live persistence of surfacing traces into the
 * `surfacing_diagnostics` table. Off by default — the envelope is written
 * only when an operator deliberately arms diagnosis.
 */
export function liveSurfacingTraceEnabled(): boolean {
  const v = (process.env.CLAWMEM_SURFACING_TRACE || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Rows kept in surfacing_diagnostics — oldest beyond this are pruned on write. */
export const SURFACING_DIAGNOSTICS_KEEP = 500;

/**
 * Best-effort persistence of one trace envelope. Creates the table lazily so
 * pre-existing vaults need no migration step; prunes to the newest
 * SURFACING_DIAGNOSTICS_KEEP rows. Never throws — diagnosis must not break
 * the hook.
 */
export function persistSurfacingTrace(
  db: import("bun:sqlite").Database,
  sessionId: string | undefined,
  turnIndex: number | undefined,
  trace: SurfacingTrace
): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS surfacing_diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        turn_index INTEGER,
        created_at TEXT NOT NULL,
        trace_json TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO surfacing_diagnostics (session_id, turn_index, created_at, trace_json) VALUES (?, ?, ?, ?)`
    ).run(sessionId ?? null, turnIndex ?? null, isoNow(), JSON.stringify(trace));
    db.prepare(
      `DELETE FROM surfacing_diagnostics WHERE id NOT IN (SELECT id FROM surfacing_diagnostics ORDER BY id DESC LIMIT ?)`
    ).run(SURFACING_DIAGNOSTICS_KEEP);
  } catch {
    /* fail-open: diagnostics must never break the hook */
  }
}
