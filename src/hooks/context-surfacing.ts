/**
 * Context Surfacing Hook - UserPromptSubmit
 *
 * Fires on every user message. Searches the vault for relevant context,
 * applies SAME composite scoring, enforces a token budget, and injects
 * the most relevant notes as additional context for Claude.
 */

import type { Store, SearchResult } from "../store.ts";
import { notLegacyArtifactSql } from "../compaction-state.ts";
import { DEFAULT_EMBED_MODEL, DEFAULT_QUERY_MODEL, DEFAULT_RERANK_MODEL, warnOnceOnVectorModelMismatch, extractSnippet, resolveStore, rerankTextHash, isProjectedVecResult } from "../store.ts";
import { searchVecBounded } from "../vector-daemon.ts";
import { getVaultPath, getActiveProfile, surfaceSecondaryVaults } from "../config.ts";
import type { HookInput, HookOutput } from "../hooks.ts";
import {
  makeContextOutput,
  makeEmptyOutput,
  smartTruncate,
  estimateTokens,
  logInjection,
  isHeartbeatPrompt,
  wasPromptSeenRecently,
} from "../hooks.ts";
import {
  applyCompositeScoring,
  hasRecencyIntent,
  inferMemoryType,
  type EnrichedResult,
  type ScoredResult,
} from "../memory.ts";
import { enrichResults } from "../search-utils.ts";
import { sanitizeSnippet } from "../promptguard.ts";
import { shouldSkipRetrieval, hasForceRetrieveIntent, isRetrievedNoise, needsPriorContext, contentTokenSet } from "../retrieval-gate.ts";
import { selectCandidatePool, dropUnarbitrated, candidateKey, finalOrderingKeys, fuseRerankLane, compareOrderingKeys, relevanceAdmission, resolveAdmissionBasis, ADMISSION_PARAMS, ADMISSION_POLICY_ACTIVE, RERANK_LANE_ACTIVE, RERANK_DEGENERACY_GATE_ACTIVE, type LaneList, type FusionMembership, type OrderingKey } from "./surfacing-fusion.ts";
import { assessRerankDegeneracy } from "../health/rerank-health.ts";
import { isRefusedEmbedResponse } from "../vector-guard.ts";
import { vectorDaemonLikelyAvailable, searchVecDaemonRequired, type VecExecStatus, type VecResponseProtocol } from "../vector-daemon.ts";
import { MAX_QUERY_LENGTH } from "../limits.ts";
import { registerSurfacingTranscript, surfacingIdentity, type UsageIdentity } from "../stop-identity.ts";
import type { ManifestItem } from "../stop-feedback.ts";
import { parseEvalNowTimestamp } from "../eval/run-identity.ts";
import { hashQuery } from "../recall-buffer.ts";
import { setPendingSurfacingBookkeeping, type SurfacingBookkeepingVaultGroup } from "./surfacing-bookkeeping.ts";
import { resolveSessionTopic } from "../session-focus.ts";
import {
  extractPromptEntities,
  buildVaultFactsBlock,
  type VaultFactsTriple,
} from "../vault-facts.ts";
import {
  newSurfacingTrace,
  traceLegHits,
  liveSurfacingTraceEnabled,
  persistSurfacingTrace,
  type SurfacingTrace,
  type TraceEmptyReason,
  type VectorLegTerminal,
} from "../eval/hook-trace.ts";
import { PROFILES } from "../config.ts";
import { monoNow, duration, evidenceMs, deadlineAfter, deadlineBefore, earliest, isExpired, remainingForTimeout, elapsed, allotted, overshoot, raceDeadline, spanStart, spanEvidence, type DurationMs, type MonoDeadline, type MonoInstant, type Span, toDate, epochNow, epochMs, epochBefore } from "../clock.ts";
import { MAX_LEG_BUDGET_MS } from "../vector-protocol.ts";
import { relWeightSql } from "../relation-weight.ts";

// =============================================================================
// Config
// =============================================================================

// Profile-driven defaults (overridden by CLAWMEM_PROFILE env var via E14)
/**
 * The rerank request-construction revision moved to store.ts with BUILD-3b
 * (it now also keys the rerank cache, and store.ts owns the transport
 * projection the rev pins). Re-exported here so eval/test importers keep
 * their import path.
 */
export { RERANK_REQUEST_REV } from "../store.ts";

/**
 * BUILD-3a (C2c/C3): the hook's AUTHORITATIVE internal time budget. The
 * handler derives every deadline from THIS value — never from host settings
 * (the host timeout is an outer kill switch, not the schedule). Invalid,
 * non-finite, or non-positive values fall back to the default — the budget
 * can never be disabled, only sized. Values below MIN_HOOK_BUDGET_MS clamp
 * up (a sub-second budget cannot complete even the fast path honestly).
 *
 * O1 §2 (codex rev-6 F4 / rev-7 F4 / rev-8 F4): the budget now has a
 * MAXIMUM, `MAX_HOOK_BUDGET_MS` (= the daemon wire's `MAX_LEG_BUDGET_MS`,
 * 25_000 — see vector-protocol.ts for the grounding), and the parse is a
 * DISCRIMINATED result: the accepted branch carries the branded `DurationMs`
 * the handler and the evaluator identity consume — there is no other path to
 * a budget — while the rejected branch carries diagnostics and NO usable
 * budget. Order: normalize exactly as before (fallback, clamp, floor), THEN
 * validate the effective integer — so `"25000.9"` floors to the supported
 * 25000 and is accepted, while `"3e4"` normalizes to 30000 and is refused.
 * Positive flooring can only decrease a value, so validation second can never
 * manufacture an over-max integer from an in-range input.
 *
 *   - `assertHookBudgetConfig()` runs at hook STARTUP (cmdHook) and inside
 *     the handler itself: an unsupported value refuses the RUN with a clear
 *     stderr line (the hook stays fail-open for the prompt);
 *   - `clawmem setup hooks` refuses to install an unsupported value;
 *   - `clawmem doctor` reads and REPORTS an unsupported installed value
 *     without crashing — `parseHookBudgetConfig` never throws.
 */
export const DEFAULT_HOOK_BUDGET_MS = 6000;
export const MIN_HOOK_BUDGET_MS = 1000;
/** The supported maximum internal budget — EQUAL to the wire ceiling by construction (O1 §2). */
export const MAX_HOOK_BUDGET_MS = MAX_LEG_BUDGET_MS;

export type HookBudgetConfig =
  | {
      valid: true;
      /** The budget the handler runs under — the ONLY source of a hook budget. */
      budget: DurationMs;
      /** The same value as a plain number, for diagnostics and host-timeout arithmetic. */
      effectiveMs: number;
      raw: string | undefined;
      /** Set when the raw value was normalized (fallback or clamp) — reported, never fatal. */
      note: string | null;
    }
  | {
      valid: false;
      raw: string;
      /** What the value normalizes to — shown so the operator sees why it is refused. */
      effectiveMs: number;
      reason: string;
    };

/** Non-throwing parser over `CLAWMEM_HOOK_BUDGET_MS` (see above for the table). */
export function parseHookBudgetConfig(raw: string | undefined): HookBudgetConfig {
  const accept = (effectiveMs: number, note: string | null): HookBudgetConfig =>
    ({ valid: true, budget: duration(effectiveMs), effectiveMs, raw, note });
  if (raw === undefined || raw.trim() === "") return accept(DEFAULT_HOOK_BUDGET_MS, null);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return accept(DEFAULT_HOOK_BUDGET_MS, `CLAWMEM_HOOK_BUDGET_MS=${JSON.stringify(raw)} is not a positive finite number — using the default ${DEFAULT_HOOK_BUDGET_MS}ms`);
  }
  const effectiveMs = Math.max(MIN_HOOK_BUDGET_MS, Math.floor(n));
  if (effectiveMs > MAX_HOOK_BUDGET_MS) {
    return {
      valid: false,
      raw,
      effectiveMs,
      reason: `CLAWMEM_HOOK_BUDGET_MS=${raw} normalizes to ${effectiveMs}ms, above the supported maximum ${MAX_HOOK_BUDGET_MS}ms — set a value ≤ ${MAX_HOOK_BUDGET_MS} (at the maximum the host hook timeout must be ≥ ${Math.ceil((STARTUP_ALLOWANCE_MS + MAX_HOOK_BUDGET_MS) / 1000)}s and a prompt can block that long)`,
    };
  }
  return accept(effectiveMs, effectiveMs !== n ? `CLAWMEM_HOOK_BUDGET_MS=${raw} normalized to ${effectiveMs}ms` : null);
}

/** Thrown by `assertHookBudgetConfig` for an unsupported budget — the run is refused, never silently resized. */
/** A shell word the shell passes VERBATIM: no quoting, escaping, expansion, globbing or operators (empty allowed). */
const SHELL_PLAIN_WORD = /^[^\s'"\\$`;|&<>(){}*?[\]#~!]*$/;

/** What an installed hook COMMAND carries for `CLAWMEM_HOOK_BUDGET_MS` (see `readInstalledHookBudget`). */
export type InstalledHookBudget =
  | { kind: "absent" }
  | { kind: "assigned"; raw: string; config: HookBudgetConfig }
  | { kind: "noncanonical"; detail: string };

/**
 * Codex migration r1 P5: the budget an installed hook command carries, read STRUCTURALLY — never a
 * token regex that keeps shell quoting. The one form this can verify is what `clawmem setup hooks`
 * writes: a LEADING shell prefix assignment `CLAWMEM_HOOK_BUDGET_MS=<plain word>` (other plain
 * `NAME=word` prefix assignments may sit beside it) and no other mention of the variable anywhere
 * in the command. A plain word reaches the process verbatim, so its value is parsed by
 * `parseHookBudgetConfig` exactly as the hook will parse it — an unsupported value such as `3e4`
 * is REPORTED, not hidden. Anything else that mentions the variable — a quoted or escaped value,
 * an expansion, an `env`/`export` form, an assignment after the executable, a repeat — is
 * `noncanonical`: the value the shell passes cannot be verified here, and a doctor that guessed
 * would report green on a budget the hook refuses (`"30000"` read as a non-number → the default).
 */
export function readInstalledHookBudget(command: string): InstalledHookBudget {
  const VAR = "CLAWMEM_HOOK_BUDGET_MS";
  const mentions = command.split(VAR).length - 1;
  if (mentions === 0) return { kind: "absent" };
  let raw: string | null = null;
  for (const token of command.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    // The prefix-assignment block ends at the first token that is not `NAME=…` (the executable).
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq))) break;
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!SHELL_PLAIN_WORD.test(value)) {
      return { kind: "noncanonical", detail: `the ${name} prefix assignment is not a plain shell word (${JSON.stringify(token)})` };
    }
    if (name === VAR) {
      if (raw !== null) return { kind: "noncanonical", detail: `${VAR} is assigned more than once in the command prefix` };
      raw = value;
    }
  }
  if (raw === null) return { kind: "noncanonical", detail: `${VAR} appears in the command but not as a leading plain prefix assignment (${JSON.stringify(command)})` };
  if (mentions !== 1) return { kind: "noncanonical", detail: `${VAR} is mentioned more than once in the command` };
  return { kind: "assigned", raw, config: parseHookBudgetConfig(raw) };
}

export class HookBudgetConfigError extends Error {
  constructor(message: string) { super(message); this.name = "HookBudgetConfigError"; }
}

/**
 * The hook budget, or a `HookBudgetConfigError`. The handler calls this at
 * entry and the CLI calls it at hook startup; the evaluator stamps its
 * identity from it. Reads the process environment on every call — the parse
 * is trivial and a module-level constant would be exactly the "usable budget
 * under an invalid config" this contract forbids.
 */
export function assertHookBudgetConfig(raw: string | undefined = process.env.CLAWMEM_HOOK_BUDGET_MS): DurationMs {
  const cfg = parseHookBudgetConfig(raw);
  if (!cfg.valid) throw new HookBudgetConfigError(cfg.reason);
  return cfg.budget;
}

/**
 * Tail of the budget reserved for finalization (failure guard, filters,
 * enrich, composite, admission, ordering, buildContext, injection writes,
 * facts/relations, emit):
 * workDeadlineAt = internalDeadlineAt − this reserve, and EVERY
 * pre-finalization stage (vector legs, prior leg, expansion, rerank) is
 * bounded by workDeadlineAt — no stage may spend the tail (codex turn-24
 * finding 4). The constant is VALIDATED by the eval harness — not just the
 * aggregate finalizationMs against the reserve gate, but the per-substage
 * breakdown (trace.timings.finalizationSubstages, BUILD-3d.4) so the harness
 * measures WHERE the tail is spent, never a bare assertion (codex turn-47
 * finding 2). It is not adaptively read on the hot path — a DB read at hook
 * start would spend the budget it protects.
 *
 * 500ms, sized to the measured NON-STALL finalization after the co-activation
 * write was batched into one transaction (the per-pair autocommit fsync had
 * dominated the injection tail at ~3s; recordCoActivation in store.ts). Across
 * probes 3-4 on the prod-scale snapshot, deep finalization is ~120-335ms
 * (enrich + filter + inject + facts, all output-critical) — 500ms covers it
 * with margin while leaving 5500ms of the 6000ms budget for candidate gen.
 *
 * HONEST LIMIT (codex turn-48 finding 3): NO fixed reserve deadline-bounds a
 * synchronous SQLite commit — a rare fsync/WAL stall under host I/O contention
 * still exceeds any value (one probe-4 rep hit inject=2780ms). BUILD-5 + t60
 * (codex F59-1/2) landed the structural closure: the ONLY SQLite write left in
 * the handler is the early alignment/query-history row at retrieval commit
 * (bounded by the hook process's busy_timeout, and required for turn_index /
 * prior-lookback correctness); the injection bookkeeping (paths/tokens UPDATE,
 * recall events, per-vault mirror) is handed off after payload assembly to an
 * off-process drainer via surfacing-bookkeeping.ts — a stalled commit blocks
 * the DRAINER, never hook output. finalizationMs (what this reserve bounds)
 * measures output-critical construction only; the in-handler handoff cost is
 * measured separately as postOutputMs, outside the reserve contract.
 */
export const FINALIZATION_RESERVE_MS = 500;

/**
 * Cold-start allowance the HOST timeout must provide ON TOP of the internal
 * budget (fresh Bun process + sqlite open before handlerStart). Installer
 * writes hostTimeout ≥ (this + HOOK_BUDGET_MS); doctor enforces it.
 */
export const STARTUP_ALLOWANCE_MS = 1500;

/**
 * The guaranteed candidate FLOOR (codex turn-25 finding 2): the primary FTS
 * leg and fusion are the hook's usefulness floor — both synchronous and
 * <10ms — and their time is CARVED OUT of the current-vector cap (the vector
 * leg ends this much before the work deadline), so the floor always runs
 * with reserved time rather than abstaining. OPTIONAL candidate legs (prior
 * FTS/vector, the secondary-vault open+search, file-aware FTS) are instead
 * SKIPPED once the work window has closed — supplements degrade, the floor
 * does not.
 */
export const CANDIDATE_FLOOR_RESERVE_MS = 50;

const DEFAULT_TOKEN_BUDGET = 800;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0.45;
const MIN_COMPOSITE_SCORE_RECENCY = 0.35;
const MIN_PROMPT_LENGTH = 20;

// Tiered injection: HOT gets full snippets, WARM gets shorter, COLD gets title-only
function getTierConfig(score: number): { snippetLen: number; showMeta: boolean; tier: string } {
  if (score > 0.8) return { snippetLen: 300, showMeta: true, tier: "HOT" };
  if (score > 0.6) return { snippetLen: 150, showMeta: false, tier: "WARM" };
  return { snippetLen: 0, showMeta: false, tier: "COLD" };
}

// Directories to never surface
const FILTERED_PATHS = ["_PRIVATE/", "experiments/", "_clawmem/"];

// Memory nudge: prompt agent to use lifecycle tools after N prompts without use
const NUDGE_INTERVAL = parseInt(process.env.CLAWMEM_NUDGE_INTERVAL || "15", 10);
/**
 * BUILD-4 turn-55 (codex turn-54 finding 3): frozen evaluation clock —
 * eval-only. CLAWMEM_EVAL_NOW (ISO timestamp) pins the composite
 * recency/confidence clock so both arms of an admission_policy pair compute
 * IDENTICAL composite policy inputs from the shared snapshot; without it,
 * wall-clock drift between the arms perturbs recency and defeats strict
 * admission-ledger comparison. Unset or unparsable (production) = wall
 * clock (null). Recorded in the run identity (eval_now) so a clock mismatch
 * refuses the pair.
 */
export function resolveEvalNow(): Date | null {
  const raw = process.env.CLAWMEM_EVAL_NOW;
  if (!raw) return null;
  // STRICT canonical parse (codex t55 CR-6) — the same parser identity
  // validation uses. An invalid value resolves null HERE because a
  // production hook fails open; an EVAL RUN refuses it before scoring
  // (assertEvalNowConfig in hook-run), so a typo can never silently select
  // wall time inside an experiment.
  return parseEvalNowTimestamp(raw);
}

const LIFECYCLE_HOOK_NAMES = ["memory_pin", "memory_forget", "memory_snooze", "lifecycle-archive"];
const NUDGE_TEXT = "You haven't managed memory recently. If vault-context is surfacing noise → snooze it. If a critical decision was just made → pin it. If stale knowledge appeared → forget it.";

// Ext 6a: Context instruction + relationship snippets
// The instruction is ALWAYS prepended when the hook emits context — it frames
// the surfaced facts as background knowledge the agent already holds, reducing
// prompt-level ambiguity. Relationship snippets are fetched from the vault
// knowledge graph for edges where BOTH endpoints are in the surfaced doc set.
const INSTRUCTION_TEXT = "Treat the following as background facts you already know unless the user corrects them.";
const INSTRUCTION_XML = `<instruction>${INSTRUCTION_TEXT}</instruction>`;
const INSTRUCTION_TOKEN_COST = estimateTokens(INSTRUCTION_XML);
const RELATIONSHIPS_XML_OVERHEAD_TOKENS = estimateTokens("<relationships>\n\n</relationships>");
const MAX_RELATION_SNIPPETS = 10;

// Ext 6b: Multi-turn prior-query lookback
// The retrieval query is built from the current prompt plus up to
// MULTI_TURN_LOOKBACK recent same-session prior prompts within
// MULTI_TURN_MAX_AGE_MINUTES. The combined query is clamped to
// MULTI_TURN_MAX_CHARS with newest content preserved first — so the
// current prompt is always the first N chars even when older priors
// would otherwise push it out. All other hook signals (scoring,
// composite recency intent, recall attribution, routing hints)
// continue to use the raw current prompt.
const MULTI_TURN_LOOKBACK = 2;
const MULTI_TURN_MAX_AGE_MINUTES = 10;
const MULTI_TURN_MAX_CHARS = 2000;

// File path patterns to extract from prompts (E13 replacement: file-aware UserPromptSubmit)
const FILE_PATH_RE = /(?:^|\s)((?:\/[\w.@-]+)+(?:\.\w+)?|[\w.@-]+\.(?:ts|js|py|md|sh|yaml|yml|json|toml|rs|go|tsx|jsx|css|html))\b/g;

// =============================================================================
// Handler
// =============================================================================

/**
 * Options for `contextSurfacing`. `trace` is the BUILD-0 provenance envelope:
 * when supplied (hook replay-eval harness) the handler records per-stage
 * ground truth into it. Collection is observation-only — it never changes
 * retrieval, ranking, admission, or output. When absent, the live
 * CLAWMEM_SURFACING_TRACE knob can self-arm a trace that is persisted into
 * `surfacing_diagnostics` on completion.
 */
export interface ContextSurfacingOptions {
  trace?: SurfacingTrace;
}

export async function contextSurfacing(
  store: Store,
  input: HookInput,
  opts?: ContextSurfacingOptions
): Promise<HookOutput> {
  let prompt = input.prompt?.trim();

  // BUILD-0 provenance trace (observation-only). Self-armed live persistence
  // only when the caller did NOT supply a trace — a harness-owned trace is the
  // harness's to keep, never written into the vault under diagnosis.
  const selfArmed = !opts?.trace && liveSurfacingTraceEnabled();
  const trace = opts?.trace ?? (selfArmed ? newSurfacingTrace() : undefined);
  // O1: THE anchor — monotonic. Its only consumers are durations (totalMs) and
  // the budget deadlines below; no wall-clock instant is ever persisted from it.
  const traceT0 = monoNow();
  // O1 §1/§2: ONE monotonic anchor, and the ONLY path to a budget — an
  // unsupported value throws HERE, at TRUE handler entry (codex migration r1
  // P1): before the turn-index read, the gates, dedup, or any early return, so
  // an unsupported budget refuses EVERY invocation — including the ones that
  // would have returned empty — and no observable work runs under it. cmdHook
  // refuses before stdin or the store; a direct caller such as the eval harness
  // refuses at run start. BUILD-3a (C2c/C3): the budget clock anchors at
  // handler entry (turn-index, gating and dedup work spend the budget too;
  // codex turn-23 finding 3), and every deadline in this handler derives from
  // the internal budget. The rerank window ends a FINALIZATION_RESERVE before
  // the internal deadline so a full-window rerank still leaves time for the
  // guard/ordering/emit tail. Every control decision below is `isExpired` on a
  // deadline derived from these two; a realtime step moves none of them.
  const hookBudget = assertHookBudgetConfig();
  const internalDeadline = deadlineAfter(traceT0, hookBudget);
  const workDeadline = deadlineBefore(internalDeadline, duration(FINALIZATION_RESERVE_MS));
  // BUILD-3a: set when the deep escalation block concludes (success or
  // catch) — everything after it is finalization, measured against
  // FINALIZATION_RESERVE_MS by the observed eval invariant.
  let escalationEndAt: MonoInstant | null = null;
  // BUILD-3d.4: substage stamps across the finalization window (escalation
  // end → emit). finStamp records a monotonic boundary timestamp; finish()
  // turns the reached stamps into per-substage deltas so the harness can see
  // WHERE the reserve is spent (codex turn-47 finding 2). Recording is
  // unconditional (monoNow() is free); the breakdown is computed only for
  // deep reps (escalationEndAt !== null), matching finalizationMs.
  const finStamps: Record<string, MonoInstant> = {};
  const finStamp = (label: string): void => { finStamps[label] = monoNow(); };
  const finish = (out: HookOutput, outcome: "injected" | "empty", emptyReason?: TraceEmptyReason): HookOutput => {
    if (trace) {
      trace.outcome = outcome;
      trace.emptyReason = emptyReason ?? null;
      trace.timings.totalMs = evidenceMs(elapsed(traceT0));
      // t60 (codex F59-3): postOutputMs is a property of the PAYLOAD boundary,
      // not of the deep finalization clock — measure payload-assembled → emit
      // for every payload-bearing profile (balanced/speed included). Stays
      // null when no payload was assembled (empty outcomes).
      {
        const emitAt = monoNow();
        const payloadAt = finStamps["payload"];
        trace.timings.postOutputMs = payloadAt !== undefined ? evidenceMs(elapsed(payloadAt, emitAt)) : null;
      }
      if (escalationEndAt !== null) {
        const emitAt = monoNow();
        // BUILD-5 (the t48 option-B contract change, codex-authorized):
        // finalizationMs bounds escalation end → PAYLOAD ASSEMBLED — the
        // output-critical construction the reserve exists to protect. The
        // post-output bookkeeping writes are measured separately as
        // postOutputMs and are NOT part of the reserve contract (no fixed
        // reserve deadline-bounds a synchronous SQLite commit). An empty
        // return never assembles a payload; its finalization runs to emit.
        const payloadAt = finStamps["payload"];
        const finalEndAt = payloadAt ?? emitAt;
        trace.timings.finalizationMs = evidenceMs(elapsed(escalationEndAt, finalEndAt));
        // Deltas from escalation end through whichever boundaries were
        // reached (an early empty return sets fewer stamps). "tail" is the
        // remainder after the last boundary up to the payload boundary.
        const order = ["filters", "enrich", "scoring", "ordering", "buildContext", "facts"];
        const sub: Record<string, number> = {};
        let prev: MonoInstant = escalationEndAt;
        for (const k of order) {
          const t = finStamps[k];
          if (t === undefined) break;
          sub[k] = evidenceMs(elapsed(prev, t));
          prev = t;
        }
        sub.tail = evidenceMs(elapsed(prev, finalEndAt));
        trace.timings.finalizationSubstages = sub;
      }
      if (selfArmed) {
        // DIAGNOSTIC-MODE ONLY (CLAWMEM_SURFACING_TRACE armed, no caller-supplied
        // trace). This synchronous persist (table-create + insert + prune + JSON)
        // runs AFTER totalMs/finalizationMs are stamped, so it is deliberately
        // OUTSIDE both the reserve and budget clocks and is NOT covered by the
        // deadline guarantee (codex turn-48 finding 4). It never runs in the eval
        // harness (which supplies its own trace) or in production hooks with the
        // knob off — arming it is a debugging choice that accepts the extra tail.
        persistSurfacingTrace(store.db, input.sessionId, (input as any)._turnIndex, trace);
      }
    }
    return out;
  };

  // 62.1 D1 (rev 9/11): the turn's identity, and the transcript locator registered at entry — before every gate,
  // whether or not this turn writes a row (fail-open; a registered transcript costs no write lock). The hash is of
  // the prompt as received, before the trim above and the truncation below. On a vault whose stop-pipeline migration
  // is not verified, identity is null: legacy rows, no locator.
  const identity = surfacingIdentity(store.db, input);
  if (identity) registerSurfacingTranscript(store.db, input.sessionId, input.transcriptPath, identity);
  // register_only (OpenClaw's empty or short prompt, rev 11): the locator only — no gate, row, spool job or retrieval.
  if (input.registerOnly) return makeEmptyOutput("context-surfacing");

  // Compute turn_index FIRST, before any early returns.
  // Every transcript-visible early return must log an empty context_usage row
  // to keep turn_index aligned with transcript turns for per-turn attribution.
  if (input.sessionId) {
    try {
      let turnIndex = 0;
      try {
        const existing = store.db.prepare(
          `SELECT COUNT(*) as cnt FROM context_usage WHERE session_id = ? AND hook_name = 'context-surfacing'`
        ).get(input.sessionId) as { cnt: number };
        turnIndex = existing.cnt;
      } catch { /* fallback to 0 */ }
      (input as any)._turnIndex = turnIndex;
    } catch { /* non-fatal */ }
  }

  // §51.5: FORCE_RETRIEVE_PATTERNS carry the contract "(checked before skip)"
  // — that includes THIS skip. A short explicit memory query ("what did I
  // say?") must reach retrieval; only short prompts WITHOUT memory intent
  // take the length early-return. Empty prompts still return unconditionally.
  if (!prompt || (prompt.length < MIN_PROMPT_LENGTH && !hasForceRetrieveIntent(prompt))) {
    const reason: TraceEmptyReason = !prompt ? "gate:empty-prompt" : "gate:short-prompt";
    logEmptyTurn(store, input, identity);
    return finish(makeEmptyOutput("context-surfacing"), "empty", reason);
  }

  // Bound query length to prevent DoS on search indices
  if (prompt.length > MAX_QUERY_LENGTH) prompt = prompt.slice(0, MAX_QUERY_LENGTH);

  // Skip slash commands — log empty turn for alignment
  if (prompt.startsWith("/")) {
    logEmptyTurn(store, input, identity);
    return finish(makeEmptyOutput("context-surfacing"), "empty", "gate:slash-command");
  }

  // Adaptive retrieval gate: skip greetings, shell commands, affirmations, etc.
  if (shouldSkipRetrieval(prompt)) {
    logEmptyTurn(store, input, identity);
    return finish(makeEmptyOutput("context-surfacing"), "empty", "gate:skip-retrieval");
  }

  // Heartbeat / duplicate suppression (IO4) — NOT transcript-visible user turns
  if (isHeartbeatPrompt(prompt)) return finish(makeEmptyOutput("context-surfacing"), "empty", "gate:heartbeat");
  if (wasPromptSeenRecently(store, "context-surfacing", prompt)) {
    return finish(makeEmptyOutput("context-surfacing"), "empty", "gate:recent-duplicate");
  }

  // Load active performance profile (E14)
  const profile = getActiveProfile();
  const maxResults = profile.maxResults;
  const tokenBudget = profile.tokenBudget;
  // (The budget and its deadlines were acquired at handler entry — see traceT0.)

  if (trace) {
    // Mirror getActiveProfile's name resolution (unknown names fall back to balanced).
    const envProfile = process.env.CLAWMEM_PROFILE || "balanced";
    trace.profileName = envProfile in PROFILES ? envProfile : "balanced";
  }

  // High-fix (B3): the hook's writes to the MAIN store are bounded by the
  // busy_timeout cmdHook set for this process (1500ms for context-surfacing).
  // But skill-vault stores are opened separately via resolveStore(), which
  // would otherwise use the 5000ms operational default — so a contended
  // skill-vault write (the recall mirror below) could still stall the hook up
  // to 5s. Inherit the main store's current cap and pass it to EVERY
  // skill-vault open so those opens/writes are bounded identically. (Reads are
  // WAL-safe regardless; this primarily bounds the mirror write.)
  let hookBusyTimeout = 5000;
  try {
    const bt = (store.db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined)?.timeout;
    if (typeof bt === "number" && bt > 0) hookBusyTimeout = bt;
  } catch { /* keep default */ }
  const skillStoreOpts = { busyTimeout: hookBusyTimeout };

  // BUILD-5 t60 (codex F59-2): the turn's context_usage row is ALIGNMENT-
  // CRITICAL, not optional bookkeeping — turn_index derives from this table's
  // row count and the next turn's prior-context leg reads query_text from it.
  // Write it HERE, at retrieval commit (every pre-retrieval gate has passed),
  // with the raw prompt and empty paths, so a later deadline-skip or crash
  // loses only the injected-paths/tokens fill-in (learning signal, applied
  // off-process by the bookkeeping drainer) and never the turn alignment or
  // the prompt history. Bounded: the write waits at most this process's
  // busy_timeout (1500ms under cmdHook). The prior-leg lookback excludes the
  // current turn by query_text inequality, so this earlier write is invisible
  // to it.
  //
  // t61 (codex F60-2): the write is bounded, NOT guaranteed — busy_timeout
  // bounds lock waits, and a commit/WAL/fsync stall or lockout makes it fail
  // open. When that happens the hook FAILS THE INJECTION (empty return,
  // "alignment-unavailable") instead of injecting an untracked turn: an
  // injected turn without its context_usage row corrupts count-derived
  // turn_index for every later turn and silently drops this prompt from
  // prior-context retrieval — the alignment defect F59-2 exists to prevent.
  // No row could be written, so the failed turn leaves the count unchanged
  // and the NEXT successful turn takes the index this one would have had —
  // alignment holds by construction: no injection without its row.
  let alignmentUsageId = -1;
  if (input.sessionId) {
    alignmentUsageId = logInjection(store, input.sessionId, "context-surfacing", [], 0, (input as any)._turnIndex ?? 0, prompt, identity);
    if (alignmentUsageId <= 0) {
      return finish(makeEmptyOutput("context-surfacing"), "empty", "alignment-unavailable");
    }
  }

  // §11.4: Resolve session-scoped focus topic. Primary signal is the
  // per-session focus file at ~/.cache/clawmem/sessions/<id>.focus
  // (file > env var precedence via resolveSessionTopic). Env var
  // CLAWMEM_SESSION_FOCUS is a debug-only override and does NOT
  // provide per-session scoping on multi-session hosts.
  //
  // t61 (codex F60-1): PRESENTATION ONLY. The topic feeds extractSnippet
  // (snippet selection inside buildContext) and nothing else. It is NOT
  // passed to expandQuery or rerank: expansion variants change candidate
  // MEMBERSHIP and rerank intent changes fused mass/order, so a session
  // preference reaching either is a metadata signal crossing into ordering —
  // the same class C5 deleted with the topic boost. Fail-open: missing /
  // unreadable / corrupt / empty / oversized focus file → undefined →
  // snippet selection no-ops.
  const sessionTopic = resolveSessionTopic(
    input.sessionId,
    process.env.CLAWMEM_SESSION_FOCUS
  );

  const isRecency = hasRecencyIntent(prompt);
  const minScore = isRecency ? MIN_COMPOSITE_SCORE_RECENCY : profile.minScore;

  if (trace) {
    trace.sessionTopic = sessionTopic ?? null;
    trace.isRecencyIntent = isRecency;
  }

  // BUILD-1 (C1) — supersedes the Ext 6b concatenation: every retrieval leg
  // now queries the CURRENT prompt; prior turns enter as their own gated,
  // discounted lanes fused below it. Concatenating priors let polluted
  // thread vocabulary anchor the whole candidate set (Addendum 4), and on
  // the FTS leg (AND semantics) could only ever NARROW recall. The prior
  // leg is enabled ONLY by the deterministic anaphora/underspecification
  // test on the current prompt (CONTRACT-1e). All other prompt-dependent
  // signals (recency intent, composite scoring, recall attribution, snippet
  // highlighting, routing hints, dedupe, heartbeat check) continue to use
  // the raw current prompt, as before.
  const priorDecision = needsPriorContext(prompt);
  const priors = input.sessionId ? fetchRecentPriorQueries(store, input.sessionId, prompt) : [];
  const priorLegEnabled = priorDecision.enabled && priors.length > 0;
  if (trace) {
    trace.retrievalQuery = { current: prompt, priors: priorLegEnabled ? [...priors] : [], combined: prompt, multiTurn: priorLegEnabled, truncated: false };
    trace.priorLeg = { enabled: priorLegEnabled, reason: priorDecision.reason, priorsUsed: priorLegEnabled ? priors.length : 0 };
  }

  // Search — C1 lane collection: every leg contributes a ranked list; pool
  // MEMBERSHIP is decided by weighted fusion with the C1c mass cap and
  // protected current-supported slots (surfacing-fusion.ts). Ordering of the
  // pool downstream stays composite until BUILD-2.
  const lanes: LaneList[] = [];
  const currentContentTokens = contentTokenSet(prompt);
  // Per-candidate gate tokens (CONTRACT-1d, codex turn-7 SPEC-3): the current
  // prompt's content tokens; on a pure-anaphora prompt (zero content tokens)
  // the PRIOR turns' tokens, so the gate checks candidates against the
  // context the prompt delegates to instead of passing vacuously. Both empty
  // → the gate fails closed inside passesCurrentQueryGate.
  let gateTokens: ReadonlySet<string> = currentContentTokens;
  let gateTokenSource: "current" | "prior" | "none" = currentContentTokens.size > 0 ? "current" : "none";
  if (currentContentTokens.size === 0 && priorLegEnabled) {
    const priorTokens = contentTokenSet(priors.join(" "));
    if (priorTokens.size > 0) {
      gateTokens = priorTokens;
      gateTokenSource = "prior";
    }
  }

  // Vector execution protocol (codex t76): daemon-REQUIRED under the replay-eval's daemon-backed
  // protocol; otherwise the production contract (daemon when live, in-process fallback when not).
  // Read per call — the eval arms it at run time, after this module was imported.
  const vectorDaemonRequired = process.env.CLAWMEM_VECTOR_DAEMON_REQUIRED === "1";
  // v0.43.7 (82.2 D4): an ok leg also records how many stored vectors the scan skipped as unusable (the field is
  // absent when the count is zero, so a healthy trace is unchanged).
  type VectorLegEntry = NonNullable<NonNullable<typeof trace>["vectorLegs"]>[number];
  const recordVectorLeg = (leg: "primary" | "prior" | "deep") => (path: VecExecStatus, protocol?: VecResponseProtocol, vectorFaults?: number): VectorLegEntry | undefined => {
    if (!trace) return undefined;
    const entry: VectorLegEntry = { leg, path, ...(protocol ? { protocol } : {}), ...(vectorFaults ? { vectorFaults } : {}) };
    (trace.vectorLegs ??= []).push(entry);
    return entry;
  };
  // hydrated-v1 request inputs (codex #28 t87 F4): snippet construction runs against the RAW
  // CURRENT PROMPT + resolved session topic on EVERY leg — the prior leg searches with joined
  // priors and deep legs with expansion variants, but presentation is always the current prompt.
  const hydration = { presentationQuery: prompt, intent: sessionTopic };
  // Codex t81 P1+P2 / O1 §3: one measured record per COMPLETED vector invocation —
  // its finish vs its OWN monotonic deadline (over_ms > 0 ⇒ finished LATE), the
  // window it was allotted, the span on BOTH clocks (clock_skew_ms exposes a
  // realtime step), and the terminal kind derived from how the race settled ×
  // the invocation's classified path: completion (settled, `ok`), abandonment
  // (the deadline won — the handler's race timer, or the daemon client's own
  // authoritative timer, which classifies the path `deadline`), fallback
  // (settled on any other non-ok path, or threw).
  // Codex migration r1 S1: the path is INVOCATION-LOCAL — each invocation owns
  // its recorder and its record reads exactly that invocation's outcome, never
  // a search of the shared leg-named ledger (deep invocations share one name; a
  // late or missing classification must not borrow another invocation's).
  // Codex migration r1 S2: every finish-time quantity derives from ONE terminal
  // sample `end`, and each quantity leaves the branded world through
  // `evidenceMs` here — so over_ms = mono_elapsed_ms − budget_ms exactly
  // whenever the invocation started before its deadline.
  type VectorLegRace = "settled" | "timeout" | "threw";
  const isVectorTimeout = (e: unknown): boolean => e instanceof Error && e.message === "vector timeout";
  const vectorLegInvocation = (leg: "primary" | "prior" | "deep") => {
    let status: VecExecStatus | null = null;
    let entry: VectorLegEntry | undefined;
    const toLedger = recordVectorLeg(leg);
    return {
      // The in-process leg reports twice: its path before the search runs, its fault count after. The second
      // call (same path) adds the count to the SAME entry — one entry per invocation.
      onPath: (path: VecExecStatus, protocol?: VecResponseProtocol, vectorFaults?: number): void => {
        if (entry && status === path) { if (vectorFaults) entry.vectorFaults = vectorFaults; return; }
        status = path;
        entry = toLedger(path, protocol, vectorFaults);
      },
      // 82.2 D4: the embedding endpoint answered the QUERY with a vector that must not be used — thrown by the
      // daemon client (already recorded `vector-fault`) or by the in-process search (recorded `absent` before it
      // ran). Either way this invocation's path IS `vector-fault`, and the leg is lexical only.
      onRefusedQueryVector: (e: unknown): void => {
        if (!isRefusedEmbedResponse(e) || status === "vector-fault") return;
        status = "vector-fault";
        if (entry) entry.path = "vector-fault"; else entry = toLedger("vector-fault");
      },
      status: (): VecExecStatus | null => status,
    };
  };
  const recordVectorLegDeadline = (leg: "primary" | "prior" | "deep", deadline: MonoDeadline, started: Span, end: Span, race: VectorLegRace, status: VecExecStatus | null): void => {
    if (!trace) return;
    const terminal: VectorLegTerminal = race === "timeout" || status === "deadline" ? "abandonment"
      : race === "settled" && status === "ok" ? "completion" : "fallback";
    const span = spanEvidence(started, end);
    (trace.vectorLegDeadlines ??= []).push({
      leg,
      over_ms: evidenceMs(overshoot(deadline, end.mono)),
      budget_ms: evidenceMs(allotted(started.mono, deadline)),
      mono_elapsed_ms: evidenceMs(span.mono),
      wall_elapsed_ms: evidenceMs(span.wall),
      clock_skew_ms: evidenceMs(span.skew),
      terminal_kind: terminal,
      status,
    });
  };

  // Current vector leg (if profile allows)
  let vectorResults: SearchResult[] = [];
  if (profile.useVector) {
    let primaryDeadline: MonoDeadline | undefined;
    let primaryRace: VectorLegRace = "threw";
    const vectorStart = spanStart();
    const primaryLeg = vectorLegInvocation("primary");
    try {
      // Pass a MONOTONIC deadline into searchVec (O1): the race below abandons the vector
      // promise on timeout but cannot CANCEL it (and cannot interrupt its synchronous scan). The
      // deadline makes searchVec self-abort before the blocking MATCH, so a slow embed cannot let
      // an already-timed-out vector leg resume and re-block the hook after it fell back to FTS.
      // Capped by the work deadline MINUS the candidate floor reserve
      // (codex turn-23 finding 3 + turn-25 finding 2): the vector leg can
      // never eat the primary-FTS/fusion floor's reserved slice.
      const vectorDeadline = earliest(deadlineAfter(vectorStart.mono, duration(profile.vectorTimeout)), deadlineBefore(workDeadline, duration(CANDIDATE_FLOOR_RESERVE_MS)));
      primaryDeadline = vectorDeadline;
      // searchVecBounded runs Step 1 (the blocking MATCH) in the vector daemon when it is live, so the
      // Promise.race timer below can ACTUALLY fire (this event loop stays free during the scan). When the
      // daemon is absent it falls back to the in-process searchVec unchanged; when the daemon is
      // busy/errors it returns [] and we drop to FTS below.
      // CLAWMEM_VECTOR_DAEMON_REQUIRED=1 (the replay-eval's daemon-backed protocol, codex t76
      // constraint 4): the leg is daemon-REQUIRED — an absent/stale daemon returns [] (the evaluator
      // refuses the run as daemon loss) and the in-process synchronous scan is never entered, so the
      // timer above is authoritative by construction. Production hooks never set it.
      const vectorPromise = vectorDaemonRequired
        ? searchVecDaemonRequired(store, prompt, DEFAULT_EMBED_MODEL, maxResults, undefined, undefined, undefined, vectorDeadline, primaryLeg.onPath, hydration)
        : searchVecBounded(store, prompt, DEFAULT_EMBED_MODEL, maxResults, undefined, undefined, undefined, vectorDeadline, primaryLeg.onPath, hydration);
      // raceDeadline clears its own timer whichever side settles: a pending (ref'd) timer would
      // keep the Bun hook process alive for the full vectorTimeout after results are in hand.
      vectorResults = await raceDeadline(vectorPromise, vectorDeadline, () => new Error("vector timeout"));
      primaryRace = "settled";
    } catch (e) {
      primaryRace = isVectorTimeout(e) ? "timeout" : "threw";
      primaryLeg.onRefusedQueryVector(e);
      // Vector search unavailable, timed out, or errored — fall back to BM25. A vault-wide
      // embedding-model mismatch is a persistent config error, not a transient miss: surface it
      // loudly once, then degrade (the hook stays fail-open).
      warnOnceOnVectorModelMismatch(e);
    } finally {
      // Recorded on EVERY path — the timed-out leg is exactly the one whose
      // elapsed time the replay-eval must see (success-only stamping left it
      // null whenever the race timer won against the daemon's own deadline).
      // ONE terminal sample for both the leg timing and its deadline record (codex migration r1 S2).
      const vectorEnd = spanStart();
      if (trace) trace.timings.vectorMs = evidenceMs(elapsed(vectorStart.mono, vectorEnd.mono));
      // Codex t81 P2: the primary leg's finish vs its OWN deadline (the min()
      // above), measured in the finally so a late client-side decode is included.
      if (primaryDeadline !== undefined) recordVectorLegDeadline("primary", primaryDeadline, vectorStart, vectorEnd, primaryRace, primaryLeg.status());
    }
  }
  if (vectorResults.length > 0) lanes.push({ lane: "vector", results: vectorResults });

  // Current FTS leg: full fallback when vector returned nothing, keyword-exact
  // supplement alongside it otherwise (<10ms either way). DELIBERATELY not
  // work-deadline-guarded: this is the guaranteed candidate FLOOR — its time
  // is reserved out of the vector cap (CANDIDATE_FLOOR_RESERVE_MS), chosen
  // over abstaining (codex turn-25 finding 2's explicit policy question).
  if (vectorResults.length === 0) {
    const ftsFallback = store.searchFTS(prompt, maxResults);
    if (ftsFallback.length > 0) lanes.push({ lane: "fts-fallback", results: ftsFallback });
  } else {
    const ftsSupplemental = store.searchFTS(prompt, 5);
    if (ftsSupplemental.length > 0) lanes.push({ lane: "fts-supplement", results: ftsSupplemental });
  }

  // Prior-turns leg (CONTRACT-1e): runs ONLY when the anaphora gate certified
  // that the current prompt delegates its meaning to earlier turns. Each
  // prior gets its own BM25 list (AND semantics make a joined FTS query
  // strictly narrower — never join); the vector leg embeds the joined priors
  // once under a tight bound.
  // Skipped once the work window has closed (codex turn-25 finding 2) — the
  // prior leg is a supplement; a pathological earlier overrun (a sync scan
  // the race could not interrupt) must not also spend the reserved tail.
  if (priorLegEnabled && !isExpired(workDeadline)) {
    for (const p of priors) {
      // Re-checked before EVERY search (codex turn-26): a first synchronous
      // search that crosses the deadline must not let the remaining ones
      // start inside the finalization reserve.
      if (isExpired(workDeadline)) break;
      try {
        const hits = store.searchFTS(p, 5);
        if (hits.length > 0) lanes.push({ lane: "prior-fts", results: hits, variantQuery: p });
      } catch { /* non-fatal */ }
    }
    // Daemon-only (codex turn-6 S1 + turn-7 STANDARDS-1): without the vector
    // daemon, the in-process fallback's synchronous MATCH blocks the event
    // loop and the race timer below cannot fire — the 400ms bound would not
    // be real. The prior leg is supplementary, so it is skipped rather than
    // risked; its FTS lists above still run. The existsSync pre-check is only
    // a fast skip — the leg goes through searchVecDaemonRequired, which
    // returns [] on a STALE socket (connect refused) instead of falling back
    // to the in-process scan. CLAWMEM_PRIOR_VECTOR_INPROC=1 is the
    // eval/testing override (the replay harness measures the leg on
    // daemon-less snapshots with it) — only it may take the in-process path.
    const priorVecInproc = process.env.CLAWMEM_PRIOR_VECTOR_INPROC === "1";
    const priorVectorAllowed = priorVecInproc || vectorDaemonLikelyAvailable(store.dbPath);
    // Re-checked immediately before starting (codex turn-26): the FTS loop
    // above may have consumed the window.
    if (profile.useVector && priorVectorAllowed && !isExpired(workDeadline)) {
      const joinedPriors = priors.join("\n\n").slice(0, MULTI_TURN_MAX_CHARS);
      const priorTimeout = Math.min(400, profile.vectorTimeout);
      // Hoisted out of the try so the finally can attribute the leg's deadline (codex t81 P2).
      const priorStart = spanStart();
      const priorDeadline = earliest(deadlineAfter(priorStart.mono, duration(priorTimeout)), workDeadline);
      let priorRace: VectorLegRace = "threw";
      const priorLeg = vectorLegInvocation("prior");
      try {
        const priorVecPromise = priorVecInproc
          ? searchVecBounded(store, joinedPriors, DEFAULT_EMBED_MODEL, 5, undefined, undefined, undefined, priorDeadline, priorLeg.onPath, hydration)
          : searchVecDaemonRequired(store, joinedPriors, DEFAULT_EMBED_MODEL, 5, undefined, undefined, undefined, priorDeadline, priorLeg.onPath, hydration);
        const priorVec = await raceDeadline(priorVecPromise, priorDeadline, () => new Error("vector timeout"));
        priorRace = "settled";
        if (priorVec.length > 0) lanes.push({ lane: "prior-vector", results: priorVec, variantQuery: joinedPriors });
      } catch (e) { priorRace = isVectorTimeout(e) ? "timeout" : "threw"; priorLeg.onRefusedQueryVector(e); warnOnceOnVectorModelMismatch(e); /* prior leg is supplementary — non-fatal */ }
      finally {
          recordVectorLegDeadline("prior", priorDeadline, priorStart, spanStart(), priorRace, priorLeg.status()); // codex t81 P2: prior leg vs its own dynamic deadline
        }
    }
  }

  // Dual-query: also search the secondary vault when cross-vault surfacing is
  // enabled (retrieval.surface_secondary_vaults / CLAWMEM_SURFACE_SECONDARY_VAULTS).
  // Default OFF since v0.35.0 — automatic surfacing reads only the general vault,
  // so a configured secondary vault stays isolated unless deliberately opted in.
  // Every downstream secondary-vault path (snooze routing, enrichment, the recall
  // mirror) keys off the `_fromVault` tag set here, so this single gate starves
  // them all when disabled.
  if (surfaceSecondaryVaults() && getVaultPath("skill") && !isExpired(workDeadline)) {
    try {
      const skillStore = resolveStore("skill", skillStoreOpts);
      const skillResults = skillStore.searchFTS(prompt, 5);
      // Tag skill vault results for identification in output
      for (const r of skillResults) {
        (r as any)._fromVault = "skill";
      }
      if (skillResults.length > 0) lanes.push({ lane: "secondary-vault", results: skillResults });
    } catch {
      // Skill vault unavailable — continue with general results only
    }
  }

  // File-aware supplemental search (E13 replacement): extract file paths/names from prompt
  // and run targeted FTS queries to surface file-specific vault context.
  // File-path extraction stays on the raw current prompt so priors cannot
  // pollute the file-specific discovery channel with stale filenames.
  const fileMatches = [...prompt.matchAll(FILE_PATH_RE)].map(m => m[1]!.trim()).filter(Boolean);
  if (fileMatches.length > 0 && !isExpired(workDeadline)) {
    for (const fp of fileMatches.slice(0, 3)) {
      // Re-checked before EVERY search (codex turn-26) — same rule as the
      // prior loop: one crossing search must not admit the rest.
      if (isExpired(workDeadline)) break;
      try {
        const fileResults = store.searchFTS(fp, 2);
        if (fileResults.length > 0) lanes.push({ lane: "file-aware", results: fileResults, variantQuery: fp });
      } catch { /* non-fatal */ }
    }
  }

  // C1c membership: weighted fusion decides who competes downstream.
  let membership: FusionMembership = selectCandidatePool(lanes, maxResults, priorLegEnabled, gateTokens, gateTokenSource);
  let results: SearchResult[] = membership.pool;

  if (results.length === 0) {
    recordCandidateLanes(trace, lanes, membership);
    return finish(makeEmptyOutput("context-surfacing"), "empty", "no-results");
  }

  // Budget-aware deep escalation (deep profile only):
  // If the fast path finished quickly and found results, spend remaining time budget
  // on query expansion (discovers new candidates) and cross-encoder reranking (reorders).
  // BUILD-1 (C1): expansion runs on the CURRENT prompt — never a concatenated
  // multi-turn query — and its variants are recall-only lanes at a rank
  // discount, re-fused through the same C1c membership (mass cap + protected
  // slots). Reranking continues to use the RAW current prompt so relevance
  // scoring is not diluted by older turns — the cross-encoder is asked "how
  // well does this doc match the user's current question".
  let rerankBlended = false;
  let rerankedKeysDesc: string[] | null = null;
  let expansionLanesAdded = false;
  if (profile.deepEscalation && results.length >= 2) {
    const escalationDeadline = deadlineAfter(traceT0, duration(profile.escalationBudgetMs));
    // Entry needs BOTH the profile's escalation window AND the whole-handler
    // budget still open (codex turn-23 finding 3).
    if (!isExpired(escalationDeadline) && !isExpired(workDeadline)) {
      try {
        // Phase 1: Query expansion — discover candidates BM25+vector missed.
        // Bounded by the remaining budget (codex turn-23 finding 3): the LLM
        // call itself is not signal-aware, so the race abandons it on expiry
        // — the rejection lands in the escalation catch (expansion recorded
        // failed, the guard arbitrates), same pattern as the vector legs.
        // `deadline` gives the expansion transport a REAL abort and
        // structurally disables local inference (codex turn-24 finding 3) —
        // the race alone abandons the promise but the pending work would
        // hold the hook PROCESS past its budget.
        const expanded = await raceDeadline(store.expandQuery(prompt, DEFAULT_QUERY_MODEL, undefined /* t61 F60-1: session topic is presentation-only — never expansion intent */, { deadline: workDeadline }), workDeadline, () => new Error("expansion timeout"));
        if (trace) {
          trace.expansion = {
            attempted: true,
            variants: expanded.map(eq => ({ type: eq.type, query: eq.query, used: false })),
            failed: false,
          };
        }
        if (expanded.length > 0) {
          for (const eq of expanded.slice(0, 3)) {
            if (isExpired(workDeadline)) break; // hard stop at the work deadline (reserve preserved)
            if (trace?.expansion) {
              const v = trace.expansion.variants[expanded.indexOf(eq)];
              if (v) v.used = true;
            }
            // Typed routing: lex → FTS; vec/hyde → vector (deep profile + time budget only).
            let hits: SearchResult[] = [];
            if (eq.type === 'lex') {
              hits = store.searchFTS(eq.query, 5);
            } else if (profile.useVector) {
              // Bound BOTH the async embed wait (Promise.race on the remaining budget) AND the
              // late synchronous MATCH (the deadline arg makes the abandoned promise self-abort
              // before the scan) — mirroring the balanced leg above. The loop guard only breaks
              // BETWEEN iterations, so without the race a slow embed here can still blow the budget.
              const deepStart = spanStart();
              if (remainingForTimeout(workDeadline, deepStart.mono) === null) break;
              let deepRace: VectorLegRace = "threw";
              const deepLeg = vectorLegInvocation("deep"); // one recorder PER invocation (codex migration r1 S1)
              try {
                // Daemon-REQUIRED under the eval's daemon-backed protocol (codex t76 constraint 4:
                // primary AND deep), same contract as the primary leg above.
                const deepVec = vectorDaemonRequired
                  ? searchVecDaemonRequired(store, eq.query, DEFAULT_EMBED_MODEL, 5, undefined, undefined, undefined, workDeadline, deepLeg.onPath, hydration)
                  : searchVecBounded(store, eq.query, DEFAULT_EMBED_MODEL, 5, undefined, undefined, undefined, workDeadline, deepLeg.onPath, hydration);
                hits = await raceDeadline(deepVec, workDeadline, () => new Error("vector timeout"));
                deepRace = "settled";
              } catch (e) { deepRace = isVectorTimeout(e) ? "timeout" : "threw"; deepLeg.onRefusedQueryVector(e); warnOnceOnVectorModelMismatch(e); /* vector leg non-fatal (timed out or errored) */ }
              finally {
                recordVectorLegDeadline("deep", workDeadline, deepStart, spanStart(), deepRace, deepLeg.status()); // codex t81 P2: each deep invocation vs the work deadline it was bounded by
              }
            }
            if (hits.length > 0) {
              lanes.push({ lane: eq.type === "lex" ? "expansion-lex" : "expansion-vec", results: hits, variantQuery: eq.query });
              expansionLanesAdded = true;
            }
          }
          if (expansionLanesAdded) {
            // Re-run C1c membership over ALL lanes so expansion candidates
            // compete under the same mass cap + protected slots.
            membership = selectCandidatePool(lanes, maxResults, priorLegEnabled, gateTokens, gateTokenSource);
            results = membership.pool;
          }
        }

        // Phase 2: Cross-encoder reranking — the deep profile's strongest
        // relevance channel. BUILD-2 (C2): the pool arrives in FUSED order
        // (the channel-aware weighted RRF key), so the preselect takes the
        // top of that order — the old sort-by-raw-score here compared cosine
        // against the BM25 transform, numerically incomparable channels.
        // The rerank result is consumed by the FINAL ORDERING step below as
        // a rank-fused lane (fuseRerankLane) — never blended into raw
        // channel scores. It applies ONLY under FULL coverage of the
        // candidate set: a partially-covered pool must never be partially
        // reordered (CONTRACT-3), and a discarded rerank leaves the pool
        // unarbitrated (the failure guard runs).
        // BUILD-3a: the rerank attempt is admitted only while ITS window is
        // open — the internal deadline minus the finalization reserve. A
        // rerank that would eat the reserve is not attempted at all (the
        // failure guard arbitrates instead).
        if (!isExpired(workDeadline) && results.length >= 3) {
          // Rerank ids are the VAULT-QUALIFIED identity (candidateKey) so a
          // cross-vault same-path pair never receives each other's scores
          // (codex turn-7 SPEC-5). The id is opaque to the reranker. The
          // COMPLETE pool is sent (bounded by poolBound = maxResults+5): a
          // fixed 15-slice made full coverage structurally impossible on
          // deep's 20-candidate pools (codex turn-14 finding 5).
          const toRerank = results.map(r => ({
            file: candidateKey(r),
            // A projected candidate's rerankText IS body.slice(0, 2000) computed daemon-side —
            // identical bytes, so rerankTextHash and the draw-binding manifests are unchanged
            // (codex #28 t86).
            text: isProjectedVecResult(r) ? r.rerankText : (r.body || "").slice(0, 2000),
          }));
          if (trace) {
            // sentTextHashes: content identity of the TRANSMITTED text per
            // candidate (store-side projection of this 2000-char slice) —
            // the eval's draw-binding manifest is built from these, so the
            // binding identifies exactly what the reranker scored (BUILD-3b).
            trace.rerank = { attempted: true, sentPaths: toRerank.map(d => d.file), sentTextHashes: toRerank.map(d => rerankTextHash(d.text)), coveredPaths: [], scores: [], coverageComplete: false, orderingApplied: false, failed: false };
          }
          // requireLiveCoverage: the store's default contract ZERO-FILLS any
          // document the reranker omitted and returns the complete list, so a
          // partial remote response would arrive here as apparent full
          // coverage and partially reorder the pool (codex turn-14 finding
          // 1). Under the flag the store THROWS on incomplete coverage
          // (before the zero-fill), which lands in the escalation catch —
          // the rerank is discarded and the failure guard arbitrates.
          // `deadline` bounds every remote batch to the remaining rerank
          // window AND disables the untimed local fallback inside
          // store.rerank (BUILD-3a: no untimed local fallback — missing
          // scores surface as a coverage error and the guard arbitrates).
          const reranked = await store.rerank(prompt, toRerank, DEFAULT_RERANK_MODEL, undefined /* t61 F60-1: session topic is presentation-only — never rerank intent (RERANK_REQUEST_REV bumped) */, { requireLiveCoverage: true, deadline: workDeadline });
          if (reranked.length > 0) {
            const rerankedMap = new Map(reranked.map(r => [r.file, r.score]));
            if (trace?.rerank) {
              trace.rerank.scores = reranked.map(r => ({ filepath: r.file, score: r.score }));
              trace.rerank.coveredPaths = toRerank.filter(d => rerankedMap.has(d.file)).map(d => d.file);
            }
            // Belt-and-braces coverage check (the store already threw on a
            // partial LIVE response; this also guards cache-shape drift and
            // future store-contract changes).
            const uncovered = results.filter(r => !rerankedMap.has(candidateKey(r)));
            if (uncovered.length === 0) {
              // BUILD-3d: under full coverage the score set must still
              // DISCRIMINATE (turn-15 F3: trust only behind coverage AND
              // degeneracy validation — an attested provider can still emit
              // a collapsed/inert set for one query, and a fully-covered
              // inert response must not have its arbitrary ordering
              // trusted). The ASSESSMENT always runs and is always traced
              // (a gate-off control arm still measures firing rate); only
              // the discard ACTION is behind the toggle.
              const degeneracy = assessRerankDegeneracy(reranked.map(r => r.score));
              const discardDegenerate = RERANK_DEGENERACY_GATE_ACTIVE && degeneracy.degenerate;
              if (trace?.rerank) {
                // Coverage is the guard-level truth (the reranker ANSWERED);
                // ordering application additionally requires a positive lane
                // weight — a zero-weight lane is skipped by the shared RRF
                // and must not claim application (codex turn-17 finding 1) —
                // and a non-degenerate score set under an active gate.
                trace.rerank.coverageComplete = true;
                trace.rerank.degeneracy = { gated: RERANK_DEGENERACY_GATE_ACTIVE, ...degeneracy };
              }
              if (!discardDegenerate) {
                rerankBlended = true;
                rerankedKeysDesc = [...rerankedMap.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([file]) => file);
                if (trace?.rerank) trace.rerank.orderingApplied = RERANK_LANE_ACTIVE;
              }
              // Degenerate discard: rerankBlended stays false, so the
              // failure guard below arbitrates exactly as it does for a
              // failed rerank — orderingApplied stays false and the trace
              // carries the reason (degeneracy.reason).
            }
            // Partial coverage: scores are recorded for diagnosis but the
            // ordering ignores them and the failure guard below arbitrates.
          }
        }
        if (trace) trace.timings.escalationMs = evidenceMs(elapsed(traceT0));
      } catch {
        // Escalation failed (GPU down, timeout, etc.) — continue with fast-path results
        if (trace) {
          // Failure = the rerank never COMPLETED coverage (orderingApplied is
          // legitimately false on a completed zero-weight rerank).
          if (trace.rerank && !trace.rerank.coverageComplete) trace.rerank.failed = true;
          else if (trace.expansion == null) trace.expansion = { attempted: true, variants: [], failed: true };
        }
      }
      escalationEndAt = monoNow();
    }
    // A deep case whose window closed BEFORE escalation must still measure
    // the finalization tail — otherwise pre-escalation overruns silently
    // lose their reserve sample (codex turn-24 finding 4).
    if (escalationEndAt === null) escalationEndAt = monoNow();
  }

  // Failure guard (CONTRACT-1d): prior-only and expansion-only candidates
  // were admitted on the premise that either the reranker would arbitrate
  // them or the per-candidate current-query gate vouches for them. With no
  // USABLE rerank arbitration, candidates lacking BOTH current support and a
  // passed gate must not reach the main block — the anaphora gate enables
  // the prior LANE but cannot certify its individual documents (codex turn-6
  // SPEC-2). USABLE means the lane actually influences ordering: coverage
  // alone is transport completeness — a reranker merely returning scores
  // does not qualify candidates when those scores affect neither order nor
  // admission (codex turn-18 finding 3: at weight 0, full coverage skipped
  // this guard and gate-failing discounted-only docs were injected).
  // Enforcement is trace-independent by construction.
  if (!(rerankBlended && RERANK_LANE_ACTIVE)) {
    results = dropUnarbitrated(results, membership.fusion);
  }

  // Single provenance-recording point for candidate generation: every lane's
  // raw hits, flagged with membership admission.
  recordCandidateLanes(trace, lanes, membership);

  if (results.length === 0) { return finish(makeEmptyOutput("context-surfacing"), "empty", "no-results"); }

  // Filter out private/excluded paths
  const beforePrivate = trace ? results : null;
  results = results.filter(r =>
    !FILTERED_PATHS.some(p => r.displayPath.includes(p))
  );
  if (trace && beforePrivate) {
    const kept = new Set(results);
    trace.filters.privateDropped = beforePrivate.filter(r => !kept.has(r)).map(r => r.displayPath);
  }

  if (results.length === 0) { return finish(makeEmptyOutput("context-surfacing"), "empty", "all-filtered"); }

  // Filter out snoozed documents
  const now = toDate(epochNow());
  const beforeSnooze = trace ? results : null;
  results = results.filter(r => {
    // filepath is a virtual path (clawmem://collection/path) but findActiveDocument
    // expects the collection-relative path, not the full virtual path
    const parsed = r.filepath.startsWith('clawmem://') ? r.filepath.replace(/^clawmem:\/\/[^/]+\/?/, '') : r.filepath;
    // Use the correct store for skill-vault results
    const targetStore = (r as any)._fromVault === "skill" ? (() => { try { return resolveStore("skill", skillStoreOpts); } catch { return store; } })() : store;
    const doc = targetStore.findActiveDocument(r.collectionName, parsed);
    if (!doc) return true;
    // 62.1 D6 (T23 #2): the injection manifest pins the document by its id in its own vault, resolved here — before
    // payload assembly, so the hook adds no SQLite work after it.
    (r as any)._docId = doc.id;
    if (doc.snoozed_until && new Date(doc.snoozed_until) > now) return false;
    return true;
  });
  if (trace && beforeSnooze) {
    const kept = new Set(results);
    trace.filters.snoozedDropped = beforeSnooze.filter(r => !kept.has(r)).map(r => r.displayPath);
  }

  if (results.length === 0) { return finish(makeEmptyOutput("context-surfacing"), "empty", "all-snoozed"); }

  // Deduplicate by vault-qualified identity (keep best score per identity) —
  // bare-filepath keying collapsed two DISTINCT cross-vault documents sharing
  // one collection/path into an arbitrary survivor (codex turn-7 SPEC-5).
  const deduped = new Map<string, SearchResult>();
  for (const r of results) {
    const key = candidateKey(r);
    const existing = deduped.get(key);
    if (!existing || r.score > existing.score) {
      deduped.set(key, r);
    }
  }
  if (trace) trace.filters.dedupeCollapsed = results.length - deduped.size;
  results = [...deduped.values()];

  // Filter out noise results (agent denials, too-short snippets) before enrichment
  const beforeNoise = trace ? results : null;
  // Projected candidates (codex #28 t86) carry the daemon-precomputed verdicts of the SAME
  // predicates the body branch runs — `hasBody` mirrors the `!r.body` truthiness exactly.
  results = results.filter(r => isProjectedVecResult(r) ? (!r.hasBody || !r.noise) : (!r.body || !isRetrievedNoise(r.body)));
  if (trace && beforeNoise) {
    const kept = new Set(results);
    trace.filters.noiseDropped = beforeNoise.filter(r => !kept.has(r)).map(r => r.displayPath);
  }
  finStamp("filters"); // guard + private/snooze/dedupe/noise filters (per-candidate findActiveDocument reads)

  // Enrich with SAME metadata — route skill-vault results through their own store
  const generalResults = results.filter(r => !(r as any)._fromVault);
  const skillResults = results.filter(r => (r as any)._fromVault === "skill");
  let enriched = enrichResults(store, generalResults, prompt);
  if (skillResults.length > 0) {
    try {
      const skillStore = resolveStore("skill", skillStoreOpts);
      enriched = [...enriched, ...enrichResults(skillStore, skillResults, prompt)];
    } catch {
      // Skill store unavailable — enrich with general store as fallback
      enriched = [...enriched, ...enrichResults(store, skillResults, prompt)];
    }
  }
  finStamp("enrich"); // enrichResults SAME-metadata reads per candidate (both vaults)

  // Apply composite scoring
  const evalNow = resolveEvalNow();
  const allScored = applyCompositeScoring(enriched, prompt, undefined, evalNow ? { now: evalNow } : undefined);
  if (trace) {
    trace.composite = allScored.map(r => ({
      filepath: r.filepath,
      displayPath: r.displayPath,
      searchScore: r.score,
      compositeScore: r.compositeScore,
    }));
  }

  // §11.4 topic boost: REMOVED (BUILD-5, C5). BUILD-2 made it order-inert
  // (the final key sort ignores composite) and BUILD-4 removed its admission
  // authority; its only residual effect was tier DEPTH via the composite
  // multiplier — a metadata signal crossing presentation. sessionTopic
  // itself stays (traced + buildContext snippet intent — presentation, not
  // ordering); trace.topicBoost stays null.

  // BUILD-4 (C4): RELEVANCE ADMISSION on the final ordering basis — the same
  // channel-aware key that orders the output (current-anchor band, weighted
  // RRF mass; deep: rerank lane rank-fused when applied) is the single
  // admission authority. The composite score no longer admits or rejects
  // anything (turn-17 finding 4: composite admission rejected on-topic docs
  // ~0.280 against its ~0.338 floor while admitting junk 0.418–0.752); it
  // retains tier sizing (getTierConfig) and the BUILD-5-scoped reorder
  // stages only. Floors are RELATIVE to the query's own top mass and
  // abstention is signature-based (zero current support, or a flat band-0
  // basis with zero keyword-class agreement) — never an absolute score
  // cutoff (Addendum 6: embeddinggemma-300M's flat cosine band 0.66–0.69
  // makes absolute per-document floors meaningless).
  //
  // The ordering keys are computed HERE, before admission, and reused
  // unchanged by the final ordering sort below — one computation, one
  // authority. Ordering application requires an ACTIVE lane (weight > 0):
  // the shared RRF skips zero-weight lists, so fusing at weight 0 would be
  // a no-op that still CLAIMED "rerank" as the ranking key — the trace must
  // report the ordering that actually ran (codex turn-17 finding 1). The
  // failure guard above uses the SAME usable-arbitration condition
  // (coverage AND active lane) — coverage alone is transport completeness
  // and qualifies nothing (codex turn-18 finding 3).
  const rerankArbitrated = rerankBlended && rerankedKeysDesc !== null;
  const rerankOrderingApplied = rerankArbitrated && RERANK_LANE_ACTIVE;
  let orderingKeys = finalOrderingKeys(membership.fusion);
  if (rerankOrderingApplied) {
    orderingKeys = fuseRerankLane(orderingKeys, rerankedKeysDesc!);
  }
  const presentKeys = allScored.map(r => candidateKey(r));
  const admissionBasis = resolveAdmissionBasis(membership.fusion, rerankOrderingApplied, presentKeys, orderingKeys);
  // BUILD-4 turn-54/55 (codex turn-53 finding 3 + turn-54 finding 3): the
  // ADMISSION-INPUT LEDGER, recorded IMMEDIATELY BEFORE the policy branch so
  // it is arm-symmetric by construction. Each entry carries the COMPLETE
  // per-candidate policy input of both arms — the ordering key {band, mass}
  // the relevance policy judges, and the compositeScore the composite
  // control judges (frozen across arms by CLAWMEM_EVAL_NOW) — so an
  // admission-only pair proves the arms judged the SAME inputs, not merely
  // the same identities. The pair audit compares it for admission-only
  // experiments and treatment exposure reads it; the treatment-downstream
  // admitted/rejected split is never consulted.
  if (trace) {
    trace.admissionInput = {
      candidates: allScored
        .map(r => {
          const key = candidateKey(r);
          const k = orderingKeys.get(key);
          return { key, band: (k?.band ?? 1) as 0 | 1, mass: k?.mass ?? 0, compositeScore: r.compositeScore };
        })
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    };
  }
  let scored: typeof allScored;
  if (ADMISSION_POLICY_ACTIVE === "composite") {
    // BUILD-4 registered-treatment CONTROL ARM (CLAWMEM_ADMISSION_POLICY=
    // composite — eval-only, never the default): the pre-BUILD-4 composite
    // gate kept verbatim, so the admission_policy paired A/B compares two
    // arms of ONE code state (the BUILD-3d registered-treatment protocol).
    if (profile.thresholdMode === "adaptive") {
      const bestScore = allScored.length > 0
        ? Math.max(...allScored.map(r => r.compositeScore))
        : 0;
      if (bestScore < profile.activationFloor) {
        if (trace) {
          trace.admission = {
            mode: "adaptive", bestScore, activationFloor: profile.activationFloor,
            admitted: [], rejected: allScored.map(r => ({ candidate: candidateKey(r), displayPath: r.displayPath, compositeScore: r.compositeScore })),
            abstained: true,
          };
        }
        return finish(makeEmptyOutput("context-surfacing"), "empty", "activation-floor");
      }
      const adaptiveMin = Math.max(bestScore * profile.minScoreRatio, profile.absoluteFloor);
      scored = allScored.filter(r => r.compositeScore >= adaptiveMin);
      if (trace) {
        trace.admission = {
          mode: "adaptive", bestScore, activationFloor: profile.activationFloor, adaptiveMin,
          admitted: scored.map(r => ({ candidate: candidateKey(r), displayPath: r.displayPath, compositeScore: r.compositeScore })),
          rejected: allScored.filter(r => r.compositeScore < adaptiveMin).map(r => ({ candidate: candidateKey(r), displayPath: r.displayPath, compositeScore: r.compositeScore })),
          abstained: false,
        };
      }
    } else {
      scored = allScored.filter(r => r.compositeScore >= minScore);
      if (trace) {
        const bestScore = allScored.length > 0 ? Math.max(...allScored.map(r => r.compositeScore)) : 0;
        trace.admission = {
          mode: "absolute", bestScore, activationFloor: profile.activationFloor, minScore,
          admitted: scored.map(r => ({ candidate: candidateKey(r), displayPath: r.displayPath, compositeScore: r.compositeScore })),
          rejected: allScored.filter(r => r.compositeScore < minScore).map(r => ({ candidate: candidateKey(r), displayPath: r.displayPath, compositeScore: r.compositeScore })),
          abstained: false,
        };
      }
    }
    if (scored.length === 0) { return finish(makeEmptyOutput("context-surfacing"), "empty", "threshold"); }
  } else {
    const decision = relevanceAdmission(presentKeys, orderingKeys, membership.fusion, admissionBasis);
    const bestScore = allScored.length > 0 ? Math.max(...allScored.map(r => r.compositeScore)) : 0;
    const admissionEntry = (r: (typeof allScored)[number], reason?: string) => {
      const k = orderingKeys.get(candidateKey(r));
      return {
        candidate: candidateKey(r), displayPath: r.displayPath, compositeScore: r.compositeScore,
        mass: k?.mass ?? 0, band: (k?.band ?? 1) as 0 | 1,
        ...(reason !== undefined ? { reason } : {}),
      };
    };
    const recordAdmission = (admittedRows: typeof allScored, abstained: boolean) => {
      if (!trace) return;
      const admittedRowSet = new Set(admittedRows);
      const reasonByKey = new Map(decision.rejected.map(rj => [rj.key, rj.reason]));
      trace.admission = {
        mode: "relevance", bestScore, basis: admissionBasis,
        topMass: decision.stats.topMass, spreadRel: decision.stats.spreadRel,
        keywordAgreed: decision.stats.keywordAgreed,
        floorRatio: ADMISSION_PARAMS[admissionBasis].floorRatio,
        abstainReason: decision.abstain,
        admitted: admittedRows.map(r => admissionEntry(r)),
        rejected: allScored.filter(r => !admittedRowSet.has(r)).map(r => admissionEntry(r, reasonByKey.get(candidateKey(r)))),
        abstained,
      };
    };
    if (decision.abstain) {
      recordAdmission([], true);
      return finish(
        makeEmptyOutput("context-surfacing"), "empty",
        decision.abstain === "no-current-support" ? "admission-no-current" : "admission-degenerate"
      );
    }
    const admittedKeys = new Set(decision.admitted);
    scored = allScored.filter(r => admittedKeys.has(candidateKey(r)));
    recordAdmission(scored, false);
    if (scored.length === 0) { return finish(makeEmptyOutput("context-surfacing"), "empty", "admission-floor"); }
  }
  finStamp("scoring"); // composite scoring + admission (CPU; topic boost removed at BUILD-5)

  // E11 spreading activation + E10 memory-type diversification: REMOVED
  // (BUILD-5, C5). Co-activation is out of ordering ENTIRELY — the
  // injection-time signal was rich-get-richer trained on the hook's own
  // injections, and its getCoActivated reads + composite mutation + resort
  // sat on the deadline path for nothing the final key sort would honor.
  // The diversification splice was provably output-inert since BUILD-2 (the
  // key sort below re-orders). trace.spreadingActivation stays empty and
  // trace.diversification stays null; the trace fields remain so historical
  // traces keep their shape.

  // BUILD-2 (C2): FINAL ORDERING = the channel-aware key (band, mass).
  // The membership fusion already computed one rank-derived, scale-free mass
  // per candidate (current-anchored lanes; the secondary vault as its own
  // list — its FTS scores are corpus-statistics-incomparable with the
  // general vault's). The BAND is the current anchor, UNCONDITIONALLY:
  // discounted-only survivors order strictly BELOW every current-supported
  // candidate (codex turn-14 finding 4 — the aggregate mass cap alone lets a
  // three-variant expansion-only doc out-mass the best current hit). On the
  // deep profile the applied rerank is fused in as one more lane, but it adds
  // MASS ONLY inside the bands — full coverage proves the reranker answered,
  // not that it discriminated, so it never elevates a band (codex turn-15
  // finding). This sort is the single ordering authority, and since BUILD-4
  // the relevance ADMISSION above is judged on this SAME key — the composite
  // score retains tier sizing only, and the
  // metadata reorder machinery (topic boost, spreading activation,
  // diversification) is DELETED as of BUILD-5 (C5) — composite retains tier
  // sizing and the eval-only control arm; the metadata-band-only invariant
  // enforces the ZERO-WIDTH band (equal-key neighbors must follow the
  // candidateKey tie-break exactly). Tie-break: the vault-qualified
  // identity, deterministic and metadata-free.
  // BUILD-4: rerankOrderingApplied + orderingKeys were computed BEFORE the
  // relevance admission (one computation, one authority — the key that
  // admitted is the key that orders); reused here unchanged.
  const FLOOR_KEY: OrderingKey = { band: 1, mass: 0 };
  scored.sort((a, b) => {
    const cmp = compareOrderingKeys(
      orderingKeys.get(candidateKey(a)) ?? FLOOR_KEY,
      orderingKeys.get(candidateKey(b)) ?? FLOOR_KEY
    );
    if (cmp !== 0) return cmp;
    const ca = candidateKey(a), cb = candidateKey(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  if (trace) {
    trace.rankingKey = rerankOrderingApplied ? "rerank" : "rrf";
    trace.finalOrder = scored.map(r => {
      const k = orderingKeys.get(candidateKey(r)) ?? FLOOR_KEY;
      return { candidate: candidateKey(r), displayPath: r.displayPath, band: k.band, keyValue: k.mass };
    });
  }
  finStamp("ordering"); // final ordering sort (E10/E11 machinery removed at BUILD-5)

  // Build context within token budget (profile-driven).
  // Ext 6a: Reserve budget for the always-on instruction line so the final
  // vault-context payload stays within `tokenBudget`. Relations are layered
  // in afterward using whatever budget remains and are the first thing
  // truncated when the payload would overflow.
  const factsBudget = Math.max(0, tokenBudget - INSTRUCTION_TOKEN_COST);
  const { context, paths, tokens, manifest, accepted } = buildContext(scored, prompt, factsBudget, sessionTopic, trace);
  finStamp("buildContext"); // output construction: body reads + tiered entry assembly

  if (!context) {
    return finish(makeEmptyOutput("context-surfacing"), "empty", "budget");
  }


  // Routing hint: detect query intent signals and prepend a tool routing directive
  // This makes routing instructions salient at the moment of tool selection (per research)
  const routingHint = detectRoutingHint(prompt);

  // Memory nudge: periodically remind agent to use lifecycle tools
  const nudge = NUDGE_INTERVAL > 0 ? shouldNudge(store) : null;

  // Ext 6a: Enrich vault-context with instruction framing + optional
  // relationship snippets sourced from memory_relations. Only edges where
  // BOTH endpoints are in the surfaced doc set are included. The relations
  // block is the first thing dropped when the payload would overflow budget.
  //
  // Budget accounting (Turn 11 fix): `tokens` from buildContext only sums per-
  // entry bodies and misses both the `<facts>...</facts>` wrapper and the
  // `\n\n---\n\n` separators between entries. Compute the wrapped-facts cost
  // directly from the rendered string so the relationships block can never
  // push the final `<vault-context>` inner payload past `tokenBudget`.
  const surfacedDocIds = lookupSurfacedDocIds(store, paths);
  const relationSnippets = fetchRelationSnippets(store, surfacedDocIds);
  const factsBlockXml = `<facts>\n${context}\n</facts>`;
  const factsWrappedTokens = estimateTokens(factsBlockXml);
  const relationBudget = Math.max(
    0,
    tokenBudget - INSTRUCTION_TOKEN_COST - factsWrappedTokens
  );
  const vaultInner = buildVaultContextInner(context, relationSnippets, relationBudget);

  // §11.1 (v0.9.0): `<vault-facts>` KG injection.
  //
  // Stage ordering (BACKLOG.md §11.1, amended at BUILD-4/5): retrieval +
  // rerank + scoring + relevance admission + key-ordered output → build
  // <facts>/<relationships> → compute remaining facts-block budget →
  // inject <vault-facts> if entities resolve AND budget allows.
  //
  // Prompt-only seeding (HARD CONSTRAINT): entity seeds come from the
  // raw user prompt ONLY, never from `surfacedDocs[i].body`, snippets,
  // or any retrieval-phase field. Without this, a topic-boosted
  // off-topic doc (§11.4) could pollute the facts block with facts
  // about entities that have nothing to do with the user's actual
  // prompt.
  //
  // Profile-gated via `profile.factsTokens`: `speed` profile sets this
  // to 0, which naturally disables the stage. `balanced`/`deep` get a
  // dedicated sub-budget that cannot steal from <facts>/<relationships>.
  //
  // Fail-open: any DB error, empty entity set, empty triple set, or
  // budget-too-small case returns the baseline `vaultInner` unchanged
  // (byte-identical pre-§11.1 output).
  let vaultInnerWithFacts = vaultInner;
  if (profile.factsTokens > 0) {
    try {
      const entities = extractPromptEntities(prompt, store.db, "default");
      if (entities.length > 0) {
        const queryTriples = (entityId: string): VaultFactsTriple[] =>
          store
            .queryEntityTriples(entityId)
            .map(t => ({
              subject: t.subject,
              predicate: t.predicate,
              object: t.object,
              validTo: t.validTo,
              confidence: t.confidence,
            }));
        const factsBlock = buildVaultFactsBlock(
          entities,
          queryTriples,
          profile.factsTokens,
          { estimateTokens }
        );
        if (factsBlock) {
          vaultInnerWithFacts = `${vaultInner}\n${factsBlock}`;
        }
      }
    } catch {
      /* fail-open: degraded vault behaves identically to pre-§11.1 */
    }
  }

  const parts: string[] = [];
  if (routingHint) parts.push(`<vault-routing>${routingHint}</vault-routing>`);
  parts.push(`<vault-context>\n${vaultInnerWithFacts}\n</vault-context>`);
  if (nudge) parts.push(`<vault-nudge>${NUDGE_TEXT}</vault-nudge>`);

  const finalOut = makeContextOutput("context-surfacing", parts.join("\n"));
  // 62.1 (T29): the Hermes plugin carries this row's id to the turn that receives the context (hooks.ts HookOutput).
  if (identity?.host === "hermes" && alignmentUsageId > 0) finalOut.clawmemUsageId = alignmentUsageId;
  finStamp("facts"); // <relationships> (fetchRelationSnippets) + <vault-facts> KG reads
  finStamp("payload"); // TRUE post-output boundary: the final payload is fully assembled
  if (trace) {
    trace.blocks = { relationships: relationSnippets.length, vaultFacts: vaultInnerWithFacts !== vaultInner };
    trace.finalPaths = [...paths];
  }
  // BUILD-5 t60 (codex F59-1 — the off-process closure of t48 option B): the
  // handler performs NO SQLite work after payload assembly. The injection
  // bookkeeping (paths/tokens UPDATE onto the early alignment row, recall
  // events, per-vault mirror) is packaged as an in-memory job and PARKED for
  // the CLI layer, which — after the hook output is already on stdout —
  // spools it to disk and spawns a detached drainer process
  // (surfacing-bookkeeping.ts). A WAL/fsync stall in those writes therefore
  // blocks the DRAINER, never hook output or hook process exit. The alignment
  // row itself was written at retrieval commit (F59-2), so a deadline-skip
  // here loses only the learning signal. Injection-time co-activation logging
  // left the path entirely at BUILD-5 (C5). postOutputMs measures this
  // handoff (pure memory work), outside the finalization reserve.
  if (isExpired(internalDeadline)) {
    if (trace) trace.timings.postOutputSkipped = true;
  } else if (input.sessionId) {
    try {
      const turnIndex = (input as any)._turnIndex ?? 0;
      // 62.1 D6 (rev 18): exactly the results the renderer accepted — never re-selected by display path, which would
      // add a second vault's document at the same path that the budget left out.
      const injectedScored = accepted;

      // Group by vault origin (null = general vault). Recall events cover
      // ONLY docs that made it into the injected context (post-budget) —
      // docs trimmed by token budget were never seen by the model.
      const byVault = new Map<string | null, { displayPath: string; searchScore: number }[]>();
      for (const r of injectedScored) {
        const vault = ((r as any)._fromVault as string | undefined) ?? null;
        let group = byVault.get(vault);
        if (!group) { group = []; byVault.set(vault, group); }
        group.push({ displayPath: r.displayPath, searchScore: r.compositeScore });
      }
      const vaults: SurfacingBookkeepingVaultGroup[] = [...byVault].map(([vault, docs]) => ({ vault, docs }));

      setPendingSurfacingBookkeeping({
        v: 1,
        kind: "surfacing-bookkeeping",
        jobId: `${epochMs(epochNow()).toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        sessionId: input.sessionId,
        turnIndex,
        usageId: alignmentUsageId,
        queryHash: hashQuery(prompt),
        injectedPaths: [...paths],
        estimatedTokens: tokens,
        vaults,
        // 62.1 D6: the manifest the drainer records (only with a verified identity: legacy rows are never attributed).
        ...(identity ? { manifest } : {}),
        // 62.1 D1: the turn's identity, copied onto the named-vault mirror rows.
        ...(identity ? {
          promptSha: identity.promptSha ?? undefined,
          transcriptKey: identity.transcriptKey ?? undefined,
          host: identity.host,
          sessionKey: identity.sessionKey ?? undefined,
        } : {}),
      });
    } catch {
      // Non-critical — never block context surfacing on bookkeeping packaging
    }
  }
  return finish(finalOut, "injected");
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Record every lane's raw hits into the trace with membership admission as
 * the `pooled` flag, plus the full fusion arithmetic (BUILD-1). One call per
 * invocation — after candidate generation settles — so per-leg provenance and
 * the mass-cap audit read one consistent snapshot.
 */
function recordCandidateLanes(
  trace: SurfacingTrace | undefined,
  lanes: LaneList[],
  membership: FusionMembership
): void {
  if (!trace) return;
  trace.fusion = membership.fusion;
  // Fusion identity is vault-qualified (candidateKey) — record leg hits under
  // the same identity so pooled-flag matching and the invariant audit line up
  // across vaults (general docs keep the bare filepath unchanged).
  const admitted = new Set(
    membership.fusion.candidates.filter(c => c.admitted).map(c => c.filepath)
  );
  for (const l of lanes) {
    traceLegHits(trace, l.lane, l.results.map(r => ({
      filepath: candidateKey(r),
      displayPath: r.displayPath,
      source: r.source,
      score: r.score,
    })), admitted, l.variantQuery);
  }
}

/**
 * Log an empty context_usage row for a PRE-RETRIEVAL gated turn.
 * Keeps turn_index aligned with transcript turns so per-turn recall
 * attribution doesn't drift when some prompts are gated.
 *
 * Ext 6b / t60: pre-retrieval gates (slash commands, too-short prompts,
 * `shouldSkipRetrieval`) log WITHOUT query_text — those turns are not
 * meaningful user questions and their raw text is not worth persisting
 * for multi-turn lookback. Every turn that PASSES those gates gets its
 * row (with query_text) from the retrieval-commit alignment write in the
 * handler body (codex F59-2), so post-retrieval empty returns no longer
 * call this helper.
 */
function logEmptyTurn(store: Store, input: HookInput, identity: UsageIdentity | null): void {
  if (!input.sessionId) return;
  try {
    const turnIndex = (input as any)._turnIndex ?? 0;
    logInjection(store, input.sessionId, "context-surfacing", [], 0, turnIndex, undefined, identity);
  } catch { /* non-fatal */ }
}

/**
 * Detect causal/temporal/discovery signals in the prompt and return a
 * routing hint that makes the correct tool choice salient at the moment
 * of tool selection. Returns null for general queries (no hint needed).
 */
function detectRoutingHint(prompt: string): string | null {
  const q = prompt.toLowerCase();

  // Timeline/session signals
  if (/\b(last session|yesterday|prior session|previous session|last time we|handoff|what happened last|what did we do|cross.session|earlier today|what we discussed|when we last)\b/i.test(q)) {
    return "If searching memory for this: use session_log or memory_retrieve, NOT query.";
  }

  // Causal signals
  if (/\b(why did|why was|why were|what caused|what led to|reason for|decided to|decision about|trade.?off|instead of|chose to)\b/i.test(q) || /^why\b/i.test(q)) {
    return "If searching memory for this: use intent_search or memory_retrieve, NOT query.";
  }

  // Discovery signals
  if (/\b(similar to|related to|what else|what other|reminds? me of|like this)\b/i.test(q)) {
    return "If searching memory for this: use find_similar or memory_retrieve, NOT query.";
  }

  return null;
}

export function buildContext(
  scored: ScoredResult[],
  query: string,
  budget: number = DEFAULT_TOKEN_BUDGET,
  intent?: string,
  trace?: SurfacingTrace
): { context: string; paths: string[]; tokens: number; manifest: ManifestItem[]; accepted: ScoredResult[] } {
  const lines: string[] = [];
  const paths: string[] = [];
  // 62.1 D6 (rev 18): the injection manifest — exactly the results accepted into the context, each with its vault
  // and the title as rendered. Never re-derived from `paths`: two vaults can hold the same display path.
  const manifest: ManifestItem[] = [];
  const accepted: ScoredResult[] = [];
  const traceEntries: { candidate: string; displayPath: string; tier: string; tokens: number }[] = [];
  let totalTokens = 0;

  for (const r of scored) {
    if (totalTokens >= budget) break;

    // Tiered injection: allocate snippet length by composite score
    const tier = getTierConfig(r.compositeScore);

    // Sanitize title and displayPath to prevent injection via metadata fields
    const safeTitle = sanitizeSnippet(r.title);
    const safePath = sanitizeSnippet(r.displayPath);
    if (safeTitle === "[content filtered for security]" || safePath === "[content filtered for security]") continue;

    const typeTag = r.contentType !== "note" ? ` (${r.contentType})` : "";
    let entry: string;

    if (tier.snippetLen > 0) {
      // HOT or WARM: include snippet
      let snippet: string;
      if (isProjectedVecResult(r)) {
        // Daemon-projected candidate (codex #28 t86): the snippet was computed server-side by
        // the SAME functions on the SAME inputs — sanitizeSnippet(body) then
        // extractSnippet(sanitized, presentationQuery=prompt, len, chunkPos, intent=sessionTopic)
        // — so this branch is byte-equivalent to the body branch below.
        if (r.sanitizeFiltered) continue;
        snippet = smartTruncate(r.snippets[tier.snippetLen] ?? "", tier.snippetLen);
      } else {
        const bodyStr = r.body || "";
        const sanitized = sanitizeSnippet(bodyStr);
        if (sanitized === "[content filtered for security]") continue;
        snippet = smartTruncate(
          extractSnippet(sanitized, query, tier.snippetLen, r.chunkPos, intent).snippet,
          tier.snippetLen
        );
      }
      entry = `**${safeTitle}**${typeTag}\n${safePath}\n${snippet}`;
    } else {
      // COLD: title + path only, no snippet
      entry = `**${safeTitle}**${typeTag}\n${safePath}`;
    }

    const entryTokens = estimateTokens(entry);
    if (totalTokens + entryTokens > budget && lines.length > 0) break;

    lines.push(entry);
    paths.push(r.displayPath);
    const docId = (r as any)._docId;
    manifest.push({
      vault: ((r as any)._fromVault as string | undefined) ?? null, displayPath: r.displayPath, displayedTitle: safeTitle,
      docId: typeof docId === "number" ? docId : null,
    });
    accepted.push(r);
    traceEntries.push({ candidate: candidateKey(r), displayPath: r.displayPath, tier: tier.tier, tokens: entryTokens });
    totalTokens += entryTokens;
  }

  if (trace) trace.injection = { entries: traceEntries, totalTokens };

  return {
    context: lines.join("\n\n---\n\n"),
    paths,
    tokens: totalTokens,
    manifest,
    accepted,
  };
}

// =============================================================================
// Ext 6a: Relationship snippets + instruction framing
// =============================================================================

/**
 * Relationship snippet derived from a memory_relations edge whose source and
 * target are both active documents currently surfaced by the context hook.
 */
export interface RelationSnippet {
  sourceTitle: string;
  targetTitle: string;
  relationType: string;
}

/**
 * Resolve surfaced display paths back to document ids so the relation query
 * can filter memory_relations edges to the surfaced set. Silently drops paths
 * that don't match an active row in the general vault (e.g. skill-vault paths
 * or deactivated docs) — fail-open, never throws.
 */
export function lookupSurfacedDocIds(
  store: Store,
  displayPaths: string[]
): number[] {
  if (displayPaths.length === 0) return [];
  try {
    const placeholders = displayPaths.map(() => "?").join(",");
    const rows = store.db
      .prepare(
        `SELECT id FROM documents
         WHERE active = 1
           AND (collection || '/' || path) IN (${placeholders})`
      )
      .all(...displayPaths) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * Fetch relationship snippets for edges where BOTH endpoints are in the
 * surfaced doc set. Returns an empty list on empty input, zero/one surfaced
 * docs, self-loops, or any DB error (fail-open, never throws). Results are
 * ordered by relation weight DESC then recency so the most salient edges
 * survive budget truncation.
 */
export function fetchRelationSnippets(
  store: Store,
  surfacedDocIds: number[],
  limit: number = MAX_RELATION_SNIPPETS
): RelationSnippet[] {
  if (surfacedDocIds.length < 2) return [];
  try {
    const placeholders = surfacedDocIds.map(() => "?").join(",");
    const rows = store.db
      .prepare(
        `SELECT mr.relation_type,
                ds.title AS source_title,
                dt.title AS target_title
         FROM memory_relations mr
         JOIN documents ds ON ds.id = mr.source_id AND ds.active = 1 AND ${notLegacyArtifactSql("ds")}
         JOIN documents dt ON dt.id = mr.target_id AND dt.active = 1 AND ${notLegacyArtifactSql("dt")}
         WHERE mr.source_id IN (${placeholders})
           AND mr.target_id IN (${placeholders})
           AND mr.source_id != mr.target_id
         ORDER BY ${relWeightSql("mr")} DESC, mr.created_at DESC
         LIMIT ?`
      )
      .all(...surfacedDocIds, ...surfacedDocIds, limit) as Array<{
      relation_type: string;
      source_title: string;
      target_title: string;
    }>;
    return rows.map((r) => ({
      sourceTitle: r.source_title,
      targetTitle: r.target_title,
      relationType: r.relation_type,
    }));
  } catch {
    return [];
  }
}

/**
 * Render relationship snippets as bullet lines, sanitizing titles to block
 * prompt-injection via metadata fields. Lines that become filtered-content
 * markers after sanitization are dropped.
 */
export function renderRelationshipLines(
  relations: RelationSnippet[]
): string[] {
  const FILTERED = "[content filtered for security]";
  const out: string[] = [];
  for (const r of relations) {
    const src = sanitizeSnippet(r.sourceTitle);
    const tgt = sanitizeSnippet(r.targetTitle);
    if (src === FILTERED || tgt === FILTERED) continue;
    out.push(`- ${src} --[${r.relationType}]--> ${tgt}`);
  }
  return out;
}

/**
 * Assemble the inner body of <vault-context>: always instruction + facts,
 * optionally relationships when at least one line fits in the remaining
 * budget. Relationships are the first thing dropped — if the relationships
 * XML wrapper alone would exceed `remainingBudgetTokens`, the whole block
 * is omitted rather than emitting an empty wrapper.
 */
export function buildVaultContextInner(
  factsBlock: string,
  relations: RelationSnippet[],
  remainingBudgetTokens: number
): string {
  const lines: string[] = [];
  lines.push(INSTRUCTION_XML);
  lines.push(`<facts>\n${factsBlock}\n</facts>`);

  if (relations.length === 0 || remainingBudgetTokens <= 0) {
    return lines.join("\n");
  }

  const relationLines = renderRelationshipLines(relations);
  if (relationLines.length === 0) return lines.join("\n");

  // The XML wrapper itself consumes tokens — if there's no room for even one
  // line on top of the wrapper, drop the block entirely.
  const fittedLines: string[] = [];
  let used = RELATIONSHIPS_XML_OVERHEAD_TOKENS;
  for (const line of relationLines) {
    const lineTokens = estimateTokens(line + "\n");
    if (used + lineTokens > remainingBudgetTokens) break;
    fittedLines.push(line);
    used += lineTokens;
  }
  if (fittedLines.length === 0) return lines.join("\n");

  lines.push(`<relationships>\n${fittedLines.join("\n")}\n</relationships>`);
  return lines.join("\n");
}

// =============================================================================
// Ext 6b: Multi-turn prior-query lookback
// =============================================================================

/**
 * Fetch the recent same-session prior prompts inside the multi-turn window
 * (newest first). This is the shared retrieval that BOTH the gated prior leg
 * (BUILD-1) and the legacy `buildMultiTurnSurfacingQuery` helper use. Returns
 * [] on missing sessionId, empty current query, pre-migration store (no
 * query_text column), or any DB error — fail-open, never throws.
 */
export function fetchRecentPriorQueries(
  store: Store,
  sessionId: string,
  currentQuery: string,
  lookback: number = MULTI_TURN_LOOKBACK,
  maxAgeMinutes: number = MULTI_TURN_MAX_AGE_MINUTES,
): string[] {
  if (!sessionId || currentQuery.length === 0) return [];
  try {
    // ISO 8601 cutoff computed in JS (same lesson as the v0.8.0
    // countRecentContextUsages fix — datetime('now', ...) returns a
    // space-separated string that sorts incorrectly against the
    // T-separated ISO 8601 timestamps stored in context_usage).
    const cutoff = toDate(epochBefore(epochNow(), duration(maxAgeMinutes * 60 * 1000))).toISOString();
    // Self-match guard lives in SQL so a duplicate submit/retry cannot eat
    // into the lookback budget. Turn 18 review found that filtering in
    // application code with `LIMIT lookback + 1` under-fills when multiple
    // prior rows carry the same text as the current prompt — the SELECT
    // returned only `lookback + 1` rows and application-level skipping
    // then dropped legitimate distinct priors along with the dupes.
    // Pushing the inequality into WHERE means every returned row is a
    // valid non-self prior and the LIMIT == lookback fits exactly.
    const rows = store.db.prepare(
      `SELECT query_text FROM context_usage
        WHERE session_id = ?
          AND hook_name = 'context-surfacing'
          AND timestamp > ?
          AND query_text IS NOT NULL
          AND query_text != ''
          AND query_text != ?
        ORDER BY id DESC
        LIMIT ?`,
    ).all(sessionId, cutoff, currentQuery, lookback) as { query_text: string }[];
    return rows.map(r => r.query_text).filter(Boolean);
  } catch {
    // query_text column may be missing on a pre-migration store, or
    // the DB might be in a corrupted state — fall back to no priors.
    return [];
  }
}

/**
 * Build the retrieval query from the current prompt plus up to `lookback`
 * recent prior prompts from the same session within `maxAgeMinutes`.
 *
 * Returns the current prompt unchanged when:
 *  - no `sessionId` (nothing to scope by)
 *  - the `query_text` column is missing (pre-migration store)
 *  - no prior rows within the window / all NULL
 *  - any DB error (fail-open — never throws)
 *
 * The combined query format is
 *   `<current>\n\n<newest prior>\n\n<older prior>...`
 * truncated to `MULTI_TURN_MAX_CHARS` with **current content preserved
 * first** — so even when older priors would push the current prompt
 * past the char limit, the truncation drops the tail (older priors),
 * not the head. This guarantees the retrieval query always contains the
 * user's current question verbatim.
 *
 * LEGACY as of BUILD-1 (C1): the context-surfacing handler no longer calls
 * this — concatenation let polluted thread vocabulary anchor the candidate
 * set, and on the FTS leg (AND semantics) could only ever narrow recall.
 * Prior turns now enter as gated, discounted lanes (`fetchRecentPriorQueries`
 * + surfacing-fusion.ts). Kept exported for compatibility and tests.
 *
 * Exported for direct unit testing.
 */
export function buildMultiTurnSurfacingQuery(
  store: Store,
  sessionId: string,
  currentQuery: string,
  lookback: number = MULTI_TURN_LOOKBACK,
  maxAgeMinutes: number = MULTI_TURN_MAX_AGE_MINUTES,
  maxChars: number = MULTI_TURN_MAX_CHARS,
  trace?: SurfacingTrace,
): string {
  // BUILD-0 provenance: record what the retrieval query was built from —
  // `priorsUsed` holds only the priors that actually made it into the
  // combined string (truncation can drop the tail).
  const setRQ = (priorsUsed: string[], combined: string, truncated: boolean): void => {
    if (!trace) return;
    trace.retrievalQuery = {
      current: currentQuery,
      priors: priorsUsed,
      combined,
      multiTurn: priorsUsed.length > 0,
      truncated,
    };
  };

  if (!sessionId || currentQuery.length === 0) { setRQ([], currentQuery, false); return currentQuery; }

  // Shared window fetch (fail-open: [] on pre-migration store or DB error).
  const priors = fetchRecentPriorQueries(store, sessionId, currentQuery, lookback, maxAgeMinutes);

  if (priors.length === 0) { setRQ([], currentQuery, false); return currentQuery; }

  // Assemble newest-first: current first, then newest prior, then older.
  // The SQL already ordered rows DESC by id, so `priors[0]` is the newest.
  const segments = [currentQuery, ...priors];
  const combined = segments.join("\n\n");

  if (combined.length <= maxChars) { setRQ(priors, combined, false); return combined; }

  // Over budget. Current query ALWAYS wins — include the full current
  // prompt first, then add priors newest-first until the budget runs out.
  // If the current prompt alone is already over budget, return it
  // truncated (same as pre-v0.8.1 behavior — MAX_QUERY_LENGTH is
  // enforced earlier in the handler so this branch is rare).
  if (currentQuery.length >= maxChars) {
    const clamped = currentQuery.slice(0, maxChars);
    setRQ([], clamped, true);
    return clamped;
  }

  const parts: string[] = [currentQuery];
  let used = currentQuery.length;
  const separator = "\n\n";
  for (const prior of priors) {
    const cost = separator.length + prior.length;
    if (used + cost > maxChars) break;
    parts.push(prior);
    used += cost;
  }
  const assembled = parts.join(separator);
  setRQ(parts.slice(1), assembled, true);
  return assembled;
}

/**
 * Check if the agent should be nudged to use lifecycle tools.
 * Returns true if N+ context-surfacing invocations have occurred since the
 * last lifecycle tool use (memory_pin, memory_forget, memory_snooze).
 */
function shouldNudge(store: Store): boolean {
  try {
    // Count context-surfacing invocations since last lifecycle tool use
    const lastLifecycle = store.db.prepare(`
      SELECT MAX(id) as max_id FROM context_usage
      WHERE hook_name IN (${LIFECYCLE_HOOK_NAMES.map(() => "?").join(",")})
    `).get(...LIFECYCLE_HOOK_NAMES) as { max_id: number | null } | undefined;

    const sinceId = lastLifecycle?.max_id ?? 0;
    const count = store.db.prepare(`
      SELECT COUNT(*) as cnt FROM context_usage
      WHERE hook_name = 'context-surfacing' AND id > ?
    `).get(sinceId) as { cnt: number } | undefined;

    return (count?.cnt ?? 0) >= NUDGE_INTERVAL;
  } catch {
    return false; // DB error — fail silent, no nudge
  }
}
