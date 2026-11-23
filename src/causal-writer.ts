/**
 * s342 causal writer (C4′) — bounded one-hop fact-pair inference over observation
 * documents, with append-only witness evidence on the edge.
 *
 * Design of record: .codex-review/s342-causal-writer-design-2026-08-04.md (rev 7,
 * DESIGN CLEARED). Canon: .codex-review/causal-node-granularity-ruling-2026-08-04.md.
 *
 * Contract highlights implemented here:
 *  - Node = observation document; facts are evidence ON the edge (never nodes).
 *  - Candidate set = this invocation's new observation docs ∪ a small temporal
 *    window (W ∈ [1,10], default 5) over the shipped observation-lane predicate.
 *    Admission structurally requires ≥1 NEW endpoint — window↔window pairs are
 *    rejected, so recurring historical re-inference is impossible.
 *  - ONE model call per Stop invocation, strict single-shot parsing (attempts=1),
 *    under the whole-handler `CLAWMEM_STOP_BUDGET_MS` deadline with a reserved
 *    persistence tail.
 *  - Sightings are APPEND-ONLY. Live inserts use a targeted partial-index
 *    `ON CONFLICT ... WHERE legacy = 0 DO NOTHING` — the ONLY suppressed condition
 *    is the exact-duplicate uniqueness; every other constraint violation throws and
 *    rolls the edge group back. Never `INSERT OR IGNORE` (it swallows CHECK/NOT NULL
 *    violations indistinguishably).
 *  - Candidates are grouped by physical edge; each group gets its own preflight and
 *    its own immediate transaction (legacy materialization + sighting appends +
 *    weight derivation + write events commit together). One group's failure never
 *    discards other groups from the same response.
 *  - Pre-cut edges with valid old-writer metadata are materialized as exactly one
 *    `legacy = 1` sighting on first live touch; unmaterializable legacy evidence
 *    FAILS CLOSED as an admission rejection (`legacy_unresolved_refusal`).
 *  - Retirement is archive-style and REVERSIBLE via `retired_causal_edges` +
 *    `restore-edge`; preview/apply are bound by a version-tagged full-row
 *    fingerprint rechecked null-safely under the write lock.
 */

import { monoNow, deadlineAfter, deadlineBefore, deadlineTimer, earliest, elapsed, evidenceMs, isoNow, remainingForTimeout, shorterThan, untilDeadline, duration, type MonoDeadline, type MonoInstant } from "./clock.ts";
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { ObservationWithDoc } from "./amem.ts";
import { extractJsonFromLLM } from "./amem.ts";
import { isSchemaPlaceholder, CAUSAL_RESIDUE } from "./schema-placeholder.ts";
import { parseLegacyEdgeWitness, CAUSAL_FACT_CHAR_CAP } from "./causal-reader.ts";
import type { GenerateResult } from "./llm.ts";
import { stripLeadingMarks, truncateText } from "./text-policy.ts";
const nullableStrip = <T extends string | null | undefined>(v: T): T => (typeof v === "string" ? stripLeadingMarks(v) as T : v);

// =============================================================================
// Constants + configuration
// =============================================================================

export type CausalWriterMode = "off" | "shadow" | "on";

/** Whole-handler Stop budget default. Docs state the operating requirement:
 *  installed host timeout must exceed budget + safety margin. */
export const DEFAULT_STOP_BUDGET_MS = 25_000;
const MAX_STOP_BUDGET_MS = 300_000;

/** Reserved tail for persistence/output so the host never kills mid-write. */
export const PERSIST_RESERVE_MS = 2_000;

/** Below this remaining budget a model-bearing phase is skipped, not started. */
export const CAUSAL_MIN_BUDGET_MS = 3_000;

/** Per-call ceiling for the single causal generate() (bounded further by the
 *  remaining handler budget minus the persistence reserve). */
export const CAUSAL_CALL_CAP_MS = 20_000;

export const CAUSAL_WINDOW_DEFAULT = 5;
export const CAUSAL_WINDOW_MIN = 1;
export const CAUSAL_WINDOW_MAX = 10;

/** Hard input bounds (rev 3): per-fact character cap (CAUSAL_FACT_CHAR_CAP,
 *  shared via causal-reader.ts) and total-facts cap (new-first). Ordinals
 *  always index the FULL persisted fact array; the cap bounds prompt/snapshot
 *  text only. */
export { CAUSAL_FACT_CHAR_CAP } from "./causal-reader.ts";
export const CAUSAL_TOTAL_FACT_CAP = 40;
const CAUSAL_MAX_TOKENS = 800;
const CAUSAL_TEMPERATURE = 0.3;

export const CAUSAL_CONFIDENCE_FLOOR = 0.6;
export const CAUSAL_PROMPT_VERSION = "causal-writer-v1";

/** Bump whenever the fingerprinted column set or serialization changes. */
export const CAUSAL_FINGERPRINT_VERSION = "cwfp1";

export function resolveCausalWriterMode(env: Record<string, string | undefined> = process.env): CausalWriterMode {
  const raw = env.CLAWMEM_CAUSAL_WRITER?.trim().toLowerCase();
  if (!raw || raw === "off") return "off";
  if (raw === "shadow" || raw === "on") return raw;
  console.error(
    `[causal-writer] CLAWMEM_CAUSAL_WRITER must be off | shadow | on (got "${raw}") — treating as off.`,
  );
  return "off";
}

/** Positive bounded integer; invalid falls back to the default and is reported
 *  so the causal run can audit it as `invalid_config`. */
export function resolveStopBudgetMs(env: Record<string, string | undefined> = process.env): {
  budgetMs: number;
  invalid: string | null;
} {
  const raw = env.CLAWMEM_STOP_BUDGET_MS?.trim();
  if (!raw) return { budgetMs: DEFAULT_STOP_BUDGET_MS, invalid: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_STOP_BUDGET_MS) {
    return {
      budgetMs: DEFAULT_STOP_BUDGET_MS,
      invalid: `CLAWMEM_STOP_BUDGET_MS="${raw}" is not a positive integer ≤ ${MAX_STOP_BUDGET_MS} — using ${DEFAULT_STOP_BUDGET_MS}`,
    };
  }
  return { budgetMs: n, invalid: null };
}

/** W clamped to [1,10]; non-integer values fail closed to the default. */
export function resolveCausalWindow(env: Record<string, string | undefined> = process.env): {
  window: number;
  invalid: string | null;
} {
  const raw = env.CLAWMEM_CAUSAL_WINDOW?.trim();
  if (!raw) return { window: CAUSAL_WINDOW_DEFAULT, invalid: null };
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return {
      window: CAUSAL_WINDOW_DEFAULT,
      invalid: `CLAWMEM_CAUSAL_WINDOW="${raw}" is not an integer — using ${CAUSAL_WINDOW_DEFAULT}`,
    };
  }
  if (n < CAUSAL_WINDOW_MIN || n > CAUSAL_WINDOW_MAX) {
    const clamped = Math.min(CAUSAL_WINDOW_MAX, Math.max(CAUSAL_WINDOW_MIN, n));
    return {
      window: clamped,
      invalid: `CLAWMEM_CAUSAL_WINDOW=${n} outside [${CAUSAL_WINDOW_MIN},${CAUSAL_WINDOW_MAX}] — clamped to ${clamped}`,
    };
  }
  return { window: n, invalid: null };
}

// =============================================================================
// Audit: causal_runs + causal_run_events
// =============================================================================

export type CausalRunSource = "stop_hook" | "cli_migrate";
export type CausalRunOutcome =
  | "in_progress"
  | "ok"
  | "skipped_budget"
  | "no_candidates"
  | "timeout"
  | "parse_fail"
  | "llm_error"
  | "cli_ok"
  | "cli_error";

export type CausalEventScope = "document" | "pair" | "write";

export type CausalEventInput = {
  scope: CausalEventScope;
  eventType: string;
  sourceDocId?: number | null;
  targetDocId?: number | null;
  sourceFactOrdinal?: number | null;
  targetFactOrdinal?: number | null;
  confidence?: number | null;
  detail?: string | null;
};

const EVENT_DETAIL_MAX = 300;

export function insertCausalRun(db: Database, input: {
  runKey: string;
  sessionId?: string | null;
  source: CausalRunSource;
  mode: "shadow" | "on" | "cli";
  outcome: CausalRunOutcome;
}): number {
  const row = db.prepare(
    `INSERT INTO causal_runs (run_key, session_id, source, mode, outcome, started_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(
    input.runKey,
    input.sessionId ?? null,
    input.source,
    input.mode,
    input.outcome,
    isoNow(),
  ) as { id: number };
  return row.id;
}

export function insertCausalEvent(db: Database, runId: number, ev: CausalEventInput): void {
  db.prepare(
    `INSERT INTO causal_run_events (
       run_id, scope, event_type, source_doc_id, target_doc_id,
       source_fact_ordinal, target_fact_ordinal, confidence, detail, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    ev.scope,
    ev.eventType,
    ev.sourceDocId ?? null,
    ev.targetDocId ?? null,
    ev.sourceFactOrdinal ?? null,
    ev.targetFactOrdinal ?? null,
    ev.confidence ?? null,
    // BACKLOG 82.3, D7 (ruling 61 A): detail is normalised — often the model's own words; a refused detail would lose the event.
    ev.detail == null ? null : truncateText(stripLeadingMarks(ev.detail), EVENT_DETAIL_MAX),   // never half of a pair (T2 S3)
    isoNow(),
  );
}

/** Best-effort event for post-rollback reporting — an audit failure on a path
 *  that mutated nothing must not take the handler down. */
function insertCausalEventBestEffort(db: Database, runId: number, ev: CausalEventInput): void {
  try {
    insertCausalEvent(db, runId, ev);
  } catch (err) {
    console.error(`[causal-writer] best-effort event insert failed (${ev.eventType}): ${err}`);
  }
}

function finalizeCausalRun(db: Database, runId: number, patch: {
  outcome: CausalRunOutcome;
  model?: string | null;
  promptVersion?: string | null;
  promptSha256?: string | null;
  responseSha256?: string | null;
  newDocCount?: number;
  windowDocCount?: number;
  candidateCount?: number;
  admittedCount?: number;
  edgesWritten?: number;
  edgesRefused?: number;
  edgesErrored?: number;
  startedAt: MonoInstant;
}): void {
  db.prepare(
    `UPDATE causal_runs SET
       outcome = ?, model = COALESCE(?, model), prompt_version = COALESCE(?, prompt_version),
       prompt_sha256 = COALESCE(?, prompt_sha256), response_sha256 = COALESCE(?, response_sha256),
       new_doc_count = ?, window_doc_count = ?, candidate_count = ?, admitted_count = ?,
       edges_written = ?, edges_refused = ?, edges_errored = ?,
       finished_at = ?, duration_ms = ?
     WHERE id = ?`,
  ).run(
    patch.outcome,
    patch.model ?? null,
    patch.promptVersion ?? null,
    patch.promptSha256 ?? null,
    patch.responseSha256 ?? null,
    patch.newDocCount ?? 0,
    patch.windowDocCount ?? 0,
    patch.candidateCount ?? 0,
    patch.admittedCount ?? 0,
    patch.edgesWritten ?? 0,
    patch.edgesRefused ?? 0,
    patch.edgesErrored ?? 0,
    isoNow(),
    evidenceMs(elapsed(patch.startedAt)),
    runId,
  );
}

/** CLI operations use a PESSIMISTIC TERMINAL initial outcome: the run row is
 *  inserted as `cli_error` and flipped to `cli_ok` only by a successful
 *  finalization. Representing failure therefore never requires a second
 *  successful write — a writer lock that kills both the operation and the
 *  finalization leaves an honest `cli_error`, never a stranded `in_progress`
 *  and never fabricated success. Finalization failures are best-effort by the
 *  same logic: they log loudly and never mask the primary error. */
export function finalizeCliCausalRun(
  db: Database,
  runId: number,
  outcome: "cli_ok" | "cli_error",
  startedAt: MonoInstant,
): void {
  try {
    db.prepare(
      `UPDATE causal_runs SET outcome = ?, finished_at = ?, duration_ms = ? WHERE id = ?`,
    ).run(outcome, isoNow(), evidenceMs(elapsed(startedAt)), runId);
  } catch (err) {
    console.error(
      `[causal-writer] run ${runId} finalization (${outcome}) failed: ${err} — ` +
      `the row keeps its pessimistic cli_error outcome${outcome === "cli_ok" ? " despite the operation succeeding" : ""}.`,
    );
  }
}

/** Retention mirrors the judge-audit discipline: prune runs (events cascade)
 *  by age and count; sightings denormalize attribution and their `run_id` is
 *  `ON DELETE SET NULL`, so evidence and attribution survive pruning.
 *  `retired_causal_edges` is a NON-PRUNED archive — never touched here. */
export function pruneCausalRuns(db: Database, opts: {
  maxAgeDays?: number;
  maxRuns?: number;
  excludeSessionId?: string | null;
} = {}): { pruned: number } {
  const maxAgeDays = opts.maxAgeDays ?? 90;
  const maxRuns = opts.maxRuns ?? 10_000;
  const excludeSession = opts.excludeSessionId ?? null;

  const ageIds = (db.prepare(
    `SELECT id FROM causal_runs
     WHERE started_at < datetime('now', ?)
       AND (? IS NULL OR session_id IS NULL OR session_id != ?)`,
  ).all(`-${maxAgeDays} days`, excludeSession, excludeSession) as { id: number }[]).map(r => r.id);

  const countIds = (db.prepare(
    `SELECT id FROM causal_runs
     WHERE (? IS NULL OR session_id IS NULL OR session_id != ?)
       AND id NOT IN (
         SELECT id FROM causal_runs ORDER BY started_at DESC, id DESC LIMIT ?
       )`,
  ).all(excludeSession, excludeSession, maxRuns) as { id: number }[]).map(r => r.id);

  const doomed = [...new Set([...ageIds, ...countIds])];
  const del = db.prepare(`DELETE FROM causal_runs WHERE id = ?`);
  const txn = db.transaction((ids: number[]) => {
    for (const id of ids) del.run(id);
  });
  if (doomed.length > 0) txn(doomed);
  return { pruned: doomed.length };
}

// =============================================================================
// The causal step (D1 + D2 + D3 writes + D5 audit)
// =============================================================================

/** Minimal generate() surface — satisfied by LlamaCpp. */
export type CausalLlm = {
  generate(
    prompt: string,
    options: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<GenerateResult | null>;
};

type CausalLinkProposal = {
  source_fact_idx: number;
  target_fact_idx: number;
  confidence: number;
  reasoning: string;
};

type FactEntry = {
  docId: number;
  ordinal: number;
  fact: string;       // capped display/prompt text (CAUSAL_FACT_CHAR_CAP)
  isNew: boolean;
};

type StagedCandidate = {
  sourceDocId: number;
  targetDocId: number;
  sourceOrdinal: number;
  targetOrdinal: number;
  sourceFact: string;
  targetFact: string;
  confidence: number;
  reasoning: string;
};

export type CausalStepResult = {
  outcome: CausalRunOutcome;
  runKey: string;
  candidateCount: number;
  admittedCount: number;
  edgesWritten: number;
  edgesRefused: number;
  edgesErrored: number;
};

/** Strict parse of the persisted `documents.facts` JSON column. The array index
 *  IS the ordinal (C3 as ruled) — no body re-parsing exists on any path. */
export function parseFactsColumn(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const f of value) {
    if (typeof f !== "string" || f.trim().length === 0) return null;
  }
  return value as string[];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}


/** ONE generate() call, hard wall-clock bound (the llm-retry race discipline),
 *  no retry, no feedback — strict single-shot parsing per the Q5 ruling. */
async function singleShotGenerate(
  llm: CausalLlm,
  prompt: string,
  deadline: MonoDeadline,
): Promise<{ kind: "ok"; text: string; model: string } | { kind: "timeout" } | { kind: "error"; message: string }> {
  // O1: one monotonic deadline drives both the abort (an abort-aware backend
  // stops) and the race (a signal-ignoring backend cannot hold the handler).
  const controller = new AbortController();
  const cancelAbort = deadlineTimer(deadline, () => controller.abort());
  try {
    const inFlight = llm.generate(prompt, {
      maxTokens: CAUSAL_MAX_TOKENS,
      temperature: CAUSAL_TEMPERATURE,
      signal: controller.signal,
    });
    const raced = await untilDeadline(inFlight, deadline);
    if (raced.timedOut) {
      inFlight.catch(() => {});
      return { kind: "timeout" };
    }
    const text = raced.value?.text ?? "";
    if (!text) return { kind: "error", message: "LLM returned an empty response" };
    return { kind: "ok", text, model: raced.value?.model || "unknown" };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    cancelAbort();
  }
}

function buildCausalPrompt(facts: FactEntry[]): string {
  const factsText = facts.map((f, idx) => `${idx}. ${f.fact}`).join("\n");
  return `Analyze the following facts from a session and identify causal relationships.

Facts:
${factsText}

Identify cause-effect relationships where one fact directly or indirectly caused another.
Consider:
- Temporal ordering (causes precede effects)
- Logical dependencies (one fact enables or triggers another)
- Problem-solution patterns (a discovery leads to an action)

Return ONLY valid JSON array in this exact format:
[
  {
    "source_fact_idx": 0,
    "target_fact_idx": 2,
    "confidence": 0.85,
    "reasoning": "Brief explanation of causal relationship"
  }
]

Only include relationships with confidence >= 0.6. Return empty array [] if no causal relationships found.`;
}

/** Structural validation only — strict single-shot: ANY malformed entry rejects
 *  the whole response (there is no corrective retry to feed back into). */
function parseCausalResponse(text: string): CausalLinkProposal[] | null {
  const value = extractJsonFromLLM(text) as CausalLinkProposal[] | null;
  if (!Array.isArray(value)) return null;
  for (const link of value) {
    if (!link || typeof link !== "object" ||
        !Number.isInteger(link.source_fact_idx) ||
        !Number.isInteger(link.target_fact_idx) ||
        typeof link.confidence !== "number" ||
        typeof link.reasoning !== "string") {
      return null;
    }
  }
  return value;
}

// Legacy-evidence validity is THE shared rule `parseLegacyEdgeWitness`
// (causal-reader.ts): writer refusal, census classification, and reader
// read-through all call the identical function.

const INSERT_LIVE_SIGHTING_SQL = `
  INSERT INTO causal_witness_sightings (
    source_id, target_id, relation_type, source_fact_ordinal, target_fact_ordinal,
    source_fact, target_fact, reasoning, confidence, model_identity, prompt_version,
    run_key, run_id, legacy, created_at
  ) VALUES (?, ?, 'causal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(source_id, target_id, source_fact_ordinal, target_fact_ordinal, run_key)
    WHERE legacy = 0 DO NOTHING
`;

const INSERT_LEGACY_SIGHTING_SQL = `
  INSERT INTO causal_witness_sightings (
    source_id, target_id, relation_type, source_fact_ordinal, target_fact_ordinal,
    source_fact, target_fact, reasoning, confidence, model_identity, prompt_version,
    run_key, run_id, legacy, created_at
  ) VALUES (?, ?, 'causal', -1, -1, ?, ?, ?, ?, '', '', ?, ?, 1, ?)
`;

/**
 * Run the causal step for one Stop invocation. Callers gate on mode upstream:
 * this is only invoked for `shadow` or `on`.
 *
 * `deadlineAt` is the whole-handler deadline (handler entry + budget); this step
 * consumes at most `min(remaining − PERSIST_RESERVE_MS, CAUSAL_CALL_CAP_MS)` of
 * model time and skips entirely below the floor (`skipped_budget`, audited).
 */
export async function runCausalStep(
  store: Store,
  llm: CausalLlm,
  opts: {
    sessionId: string | null;
    mode: "shadow" | "on";
    newObservations: ObservationWithDoc[];
    /** O1: the Stop handler's MONOTONIC whole-handler deadline. */
    deadline: MonoDeadline;
    /** Config anomalies detected by the handler (bad budget/window env values),
     *  audited as document-scope `invalid_config` events on this run. */
    invalidConfigNotes?: string[];
    /** Budget skips of OTHER handler phases (e.g. observation extraction),
     *  audited as document-scope `phase_skipped_budget` events — the causal run
     *  is the invocation's durable audit surface. */
    phaseSkipNotes?: string[];
    /** 62.1 D3: the run's stable key (`stop:<session>:<transcript key>:<range key>`) — a second start for the same
     *  committed range fails at the run-row insert below, before any inference. Default: a fresh UUID. */
    runKey?: string;
    /** 62.1 D3 (rev 8): the window as it stood when the range committed — only documents created, modified and
     *  authored (effective time) at or before this instant are admitted. Default: unbounded. */
    windowAt?: string;
  },
): Promise<CausalStepResult> {
  const db = store.db;
  const startedAt = monoNow();
  const runKey = opts.runKey ?? randomUUID();
  // UNIQUE NOT NULL on causal_runs.run_key: a collision fails LOUDLY here, before
  // any inference result exists — never as a silent write_noop downstream.
  const runId = insertCausalRun(db, {
    runKey,
    sessionId: opts.sessionId,
    source: "stop_hook",
    mode: opts.mode,
    outcome: "in_progress",
  });

  const result: CausalStepResult = {
    outcome: "in_progress",
    runKey,
    candidateCount: 0,
    admittedCount: 0,
    edgesWritten: 0,
    edgesRefused: 0,
    edgesErrored: 0,
  };
  const finalize = (outcome: CausalRunOutcome, extra?: {
    model?: string | null; promptSha256?: string | null; responseSha256?: string | null;
    newDocCount?: number; windowDocCount?: number;
  }) => {
    result.outcome = outcome;
    finalizeCausalRun(db, runId, {
      outcome,
      model: extra?.model ?? null,
      promptVersion: CAUSAL_PROMPT_VERSION,
      promptSha256: extra?.promptSha256 ?? null,
      responseSha256: extra?.responseSha256 ?? null,
      newDocCount: extra?.newDocCount ?? 0,
      windowDocCount: extra?.windowDocCount ?? 0,
      candidateCount: result.candidateCount,
      admittedCount: result.admittedCount,
      edgesWritten: result.edgesWritten,
      edgesRefused: result.edgesRefused,
      edgesErrored: result.edgesErrored,
      startedAt,
    });
    return result;
  };

  for (const note of opts.invalidConfigNotes ?? []) {
    insertCausalEventBestEffort(db, runId, {
      scope: "document", eventType: "invalid_config", detail: note,
    });
  }
  for (const note of opts.phaseSkipNotes ?? []) {
    insertCausalEventBestEffort(db, runId, {
      scope: "document", eventType: "phase_skipped_budget", detail: note,
    });
  }

  // --- D1: candidate set -----------------------------------------------------
  // New endpoints are verified against the PERSISTED documents — the SHIPPED
  // observation-lane predicate expressed in the SAME SQL the window and census
  // use (LIKE semantics included), eligibility, and the authoritative
  // `documents.facts` column — never trusted from caller-supplied arrays, so
  // the writer's ownership universe is exactly the census's.
  const selectNewDoc = db.prepare(
    `SELECT facts FROM documents d
     WHERE d.id = ?
       AND d.collection = '_clawmem' AND d.path LIKE 'observations/%'
       AND d.observation_type IS NOT NULL
       AND d.active = 1 AND d.invalidated_at IS NULL`,
  );
  const newDocs: Array<{ docId: number; facts: string[] }> = [];
  for (const obs of opts.newObservations) {
    const row = selectNewDoc.get(obs.docId) as { facts: string | null } | null;
    if (!row) {
      insertCausalEventBestEffort(db, runId, {
        scope: "document", eventType: "new_doc_ineligible", sourceDocId: obs.docId,
      });
      continue;
    }
    const facts = parseFactsColumn(row.facts);
    if (!facts) {
      insertCausalEventBestEffort(db, runId, {
        scope: "document", eventType: "no_facts", sourceDocId: obs.docId,
      });
      continue;
    }
    newDocs.push({ docId: obs.docId, facts });
  }
  const newIds = new Set(newDocs.map(o => o.docId));

  const windowCfg = resolveCausalWindow();
  if (windowCfg.invalid) {
    insertCausalEventBestEffort(db, runId, {
      scope: "document", eventType: "invalid_config", detail: windowCfg.invalid,
    });
  }

  // Temporal window over the shipped observation-lane predicate, eligibility
  // enforced, this invocation's new docs excluded. Recency is the effective-time
  // axis (`authored_at ?? modified_at`, v0.27 discipline) with a stable id
  // tie-break — imported/backfilled observations window by when they were
  // WRITTEN, not when they were filed.
  const placeholders = newIds.size > 0 ? [...newIds].map(() => "?").join(",") : "-1";
  const windowAt = opts.windowAt ?? null;
  const windowRows = db.prepare(
    `SELECT d.id, d.facts FROM documents d
     WHERE d.collection = '_clawmem' AND d.path LIKE 'observations/%'
       AND d.observation_type IS NOT NULL
       AND d.active = 1 AND d.invalidated_at IS NULL
       AND d.id NOT IN (${placeholders})
       ${windowAt ? "AND d.created_at <= ? AND d.modified_at <= ? AND COALESCE(d.authored_at, d.modified_at) <= ?" : ""}
     ORDER BY COALESCE(d.authored_at, d.modified_at) DESC, d.id DESC
     LIMIT ?`,
  ).all(...[...newIds], ...(windowAt ? [windowAt, windowAt, windowAt] : []), windowCfg.window) as { id: number; facts: string | null }[];

  // --- Fact assembly under hard input bounds (new-first) ---------------------
  const facts: FactEntry[] = [];
  const factsByDoc = new Map<number, string[]>();

  const addDocFacts = (docId: number, full: string[], isNew: boolean): void => {
    factsByDoc.set(docId, full);
    let included = 0;
    for (let ordinal = 0; ordinal < full.length; ordinal++) {
      if (facts.length >= CAUSAL_TOTAL_FACT_CAP) break;
      facts.push({
        docId,
        ordinal,
        fact: full[ordinal]!.slice(0, CAUSAL_FACT_CHAR_CAP),
        isNew,
      });
      included++;
    }
    if (included < full.length) {
      insertCausalEventBestEffort(db, runId, {
        scope: "document",
        eventType: "dropped_fact_budget",
        sourceDocId: docId,
        detail: JSON.stringify({ included, total: full.length }),
      });
    }
  };

  for (const obs of newDocs) addDocFacts(obs.docId, obs.facts, true);

  let windowDocCount = 0;
  for (const row of windowRows) {
    const parsed = parseFactsColumn(row.facts);
    if (!parsed) {
      insertCausalEventBestEffort(db, runId, {
        scope: "document", eventType: "no_facts", sourceDocId: row.id,
      });
      continue;
    }
    windowDocCount++;
    addDocFacts(row.id, parsed, false);
  }

  const newFactCount = facts.filter(f => f.isNew).length;
  const docCount = new Set(facts.map(f => f.docId)).size;
  if (newFactCount === 0 || docCount < 2 || facts.length < 2) {
    return finalize("no_candidates", { newDocCount: newDocs.length, windowDocCount });
  }

  // --- D2: one call under the whole-handler deadline -------------------------
  // O1: the phase deadline is the whole-handler deadline minus the persistence
  // reserve; the call is additionally capped at CAUSAL_CALL_CAP_MS from now.
  const phaseDeadline = deadlineBefore(opts.deadline, duration(PERSIST_RESERVE_MS));
  const remaining = remainingForTimeout(phaseDeadline);
  if (remaining === null || shorterThan(remaining, duration(CAUSAL_MIN_BUDGET_MS))) {
    return finalize("skipped_budget", { newDocCount: newDocs.length, windowDocCount });
  }

  const prompt = buildCausalPrompt(facts);
  const promptSha256 = sha256Hex(prompt);
  const generated = await singleShotGenerate(llm, prompt, earliest(phaseDeadline, deadlineAfter(monoNow(), duration(CAUSAL_CALL_CAP_MS))));
  if (generated.kind === "timeout") {
    return finalize("timeout", { promptSha256, newDocCount: newDocs.length, windowDocCount });
  }
  if (generated.kind === "error") {
    console.warn(`[causal-writer] generate failed: ${generated.message}`);
    return finalize("llm_error", { promptSha256, newDocCount: newDocs.length, windowDocCount });
  }
  const responseSha256 = sha256Hex(generated.text);
  const modelIdentity = generated.model;

  const proposals = parseCausalResponse(generated.text);
  if (proposals === null) {
    return finalize("parse_fail", {
      model: modelIdentity, promptSha256, responseSha256,
      newDocCount: newDocs.length, windowDocCount,
    });
  }
  result.candidateCount = proposals.length;

  // --- Admission filters, each with a named pair-scope disposition -----------
  const emitPair = (ev: Omit<CausalEventInput, "scope">) =>
    insertCausalEventBestEffort(db, runId, { scope: "pair", ...ev });

  type Keyed = StagedCandidate & { key: string };
  const surviving: Keyed[] = [];
  for (const link of proposals) {
    // Anti-parrot: echoed prompt-skeleton residue passes structural validation
    // and the confidence threshold — shared guard with the other extraction paths.
    if (isSchemaPlaceholder(link.reasoning, CAUSAL_RESIDUE)) {
      emitPair({ eventType: "placeholder_reasoning", detail: link.reasoning });
      continue;
    }
    if (!Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1) {
      emitPair({ eventType: "invalid_confidence", detail: String(link.confidence) });
      continue;
    }
    if (link.confidence < CAUSAL_CONFIDENCE_FLOOR) {
      emitPair({ eventType: "below_threshold", confidence: link.confidence });
      continue;
    }
    if (link.source_fact_idx < 0 || link.source_fact_idx >= facts.length ||
        link.target_fact_idx < 0 || link.target_fact_idx >= facts.length) {
      emitPair({
        eventType: "index_oob",
        detail: `${link.source_fact_idx} -> ${link.target_fact_idx}`,
      });
      continue;
    }
    const src = facts[link.source_fact_idx]!;
    const tgt = facts[link.target_fact_idx]!;
    // Canon: intra-observation pairs are NEVER edges (self-loops forbidden).
    if (src.docId === tgt.docId) {
      emitPair({
        eventType: "self_pair", sourceDocId: src.docId, targetDocId: tgt.docId,
        sourceFactOrdinal: src.ordinal, targetFactOrdinal: tgt.ordinal,
      });
      continue;
    }
    // Admission structurally requires ≥1 NEW endpoint (window↔window rejected).
    if (!src.isNew && !tgt.isNew) {
      emitPair({
        eventType: "no_new_endpoint", sourceDocId: src.docId, targetDocId: tgt.docId,
        sourceFactOrdinal: src.ordinal, targetFactOrdinal: tgt.ordinal,
      });
      continue;
    }
    surviving.push({
      key: `${src.docId}:${tgt.docId}:${src.ordinal}:${tgt.ordinal}`,
      sourceDocId: src.docId,
      targetDocId: tgt.docId,
      sourceOrdinal: src.ordinal,
      targetOrdinal: tgt.ordinal,
      sourceFact: src.fact,
      targetFact: tgt.fact,
      confidence: link.confidence,
      reasoning: link.reasoning,
    });
  }

  // Within-response dedup: exact repeats collapse to the first; mutually
  // inconsistent entries for one ordinal pair reject the WHOLE pair. Survivors
  // are STAGED here — the `admitted` disposition is decided per edge group
  // below, AFTER the legacy preflight, because an unresolved-legacy refusal is
  // itself an admission rejection (a candidate is never classified both
  // admitted and refused).
  const byKey = new Map<string, Keyed[]>();
  for (const cand of surviving) {
    const list = byKey.get(cand.key) ?? [];
    list.push(cand);
    byKey.set(cand.key, list);
  }
  const staged: StagedCandidate[] = [];
  for (const [, entries] of byKey) {
    const first = entries[0]!;
    if (entries.length > 1) {
      const consistent = entries.every(e =>
        e.confidence === first.confidence && e.reasoning === first.reasoning);
      for (const e of entries.slice(1)) {
        emitPair({
          eventType: "duplicate_in_response",
          sourceDocId: e.sourceDocId, targetDocId: e.targetDocId,
          sourceFactOrdinal: e.sourceOrdinal, targetFactOrdinal: e.targetOrdinal,
          detail: consistent ? "exact_repeat" : "inconsistent_repeat",
        });
      }
      if (!consistent) {
        emitPair({
          eventType: "duplicate_in_response",
          sourceDocId: first.sourceDocId, targetDocId: first.targetDocId,
          sourceFactOrdinal: first.sourceOrdinal, targetFactOrdinal: first.targetOrdinal,
          detail: "inconsistent_pair_rejected",
        });
        continue;
      }
    }
    staged.push(first);
  }

  // --- D3: write granularity — per-physical-edge groups ----------------------
  const groups = new Map<string, StagedCandidate[]>();
  for (const cand of staged) {
    const key = `${cand.sourceDocId}:${cand.targetDocId}`;
    const list = groups.get(key) ?? [];
    list.push(cand);
    groups.set(key, list);
  }

  const selectEdge = db.prepare(
    `SELECT weight, metadata, created_at, contradict_confidence FROM memory_relations
     WHERE source_id = ? AND target_id = ? AND relation_type = 'causal'`,
  );
  const selectHasSightings = db.prepare(
    `SELECT 1 FROM causal_witness_sightings WHERE source_id = ? AND target_id = ? LIMIT 1`,
  );

  for (const [, group] of groups) {
    const { sourceDocId, targetDocId } = group[0]!;

    if (opts.mode === "shadow") {
      // Shadow audits the same admission/refusal split the live writer would
      // make, mutating nothing.
      const edge = selectEdge.get(sourceDocId, targetDocId) as
        { weight: number | null; metadata: string | null } | undefined;
      const hasSightings = !!selectHasSightings.get(sourceDocId, targetDocId);
      if (edge && !hasSightings && parseLegacyEdgeWitness(edge) === null) {
        for (const cand of group) {
          emitPair({
            eventType: "legacy_unresolved_refusal",
            sourceDocId: cand.sourceDocId, targetDocId: cand.targetDocId,
            sourceFactOrdinal: cand.sourceOrdinal, targetFactOrdinal: cand.targetOrdinal,
          });
        }
        result.edgesRefused++;
        continue;
      }
      for (const cand of group) {
        emitPair({
          eventType: "admitted",
          sourceDocId: cand.sourceDocId, targetDocId: cand.targetDocId,
          sourceFactOrdinal: cand.sourceOrdinal, targetFactOrdinal: cand.targetOrdinal,
          confidence: cand.confidence,
        });
      }
      result.admittedCount += group.length;
      continue;
    }

    // Live writes: preflight snapshot + admission events + legacy handling +
    // sighting appends + weight derivation + write events, all in ONE immediate
    // transaction. A rollback removes the group's admitted events with its
    // writes — the post-rollback write_error record is then the group's only
    // durable classification, so no candidate is ever recorded as both admitted
    // and failed.
    const writeGroup = db.transaction(() => {
      const nowIso = isoNow();
      const edge = selectEdge.get(sourceDocId, targetDocId) as
        { weight: number | null; metadata: string | null; created_at: string | null } | undefined;
      const preExisting = !!edge;
      const hasSightings = !!selectHasSightings.get(sourceDocId, targetDocId);

      if (preExisting && !hasSightings) {
        const legacy = parseLegacyEdgeWitness(edge!);
        if (legacy === null) {
          // Fail closed: refusal IS an admission rejection — edge untouched,
          // weight untouched, candidates NOT staged, no admitted disposition.
          // Sequentially unreachable (a foreign-keyed edge cannot predate its
          // endpoint document); arises only from concurrent/mixed-version
          // writers. Resolution: the `clawmem migrate causal-witnesses` CLI.
          for (const cand of group) {
            insertCausalEvent(db, runId, {
              scope: "pair",
              eventType: "legacy_unresolved_refusal",
              sourceDocId: cand.sourceDocId, targetDocId: cand.targetDocId,
              sourceFactOrdinal: cand.sourceOrdinal, targetFactOrdinal: cand.targetOrdinal,
            });
          }
          return { refused: true };
        }
        // Materialize the pre-cut evidence FIRST so it can never be erased by
        // weight re-derivation (the 0.9-metadata / 0.7-new-sighting case keeps 0.9).
        db.prepare(INSERT_LEGACY_SIGHTING_SQL).run(
          sourceDocId, targetDocId,
          // 82.3 D7 (ruling 57 A): copied evidence text is normalised like a live sighting's
          nullableStrip(legacy.sourceFact), nullableStrip(legacy.targetFact), nullableStrip(legacy.reasoning), legacy.confidence,
          runKey, runId, edge!.created_at ?? nowIso,
        );
        insertCausalEvent(db, runId, {
          scope: "write", eventType: "legacy_materialized",
          sourceDocId, targetDocId, confidence: legacy.confidence,
        });
      }

      // The group cleared admission (including the legacy gate above): record
      // the pair-scope disposition, then write.
      for (const cand of group) {
        insertCausalEvent(db, runId, {
          scope: "pair", eventType: "admitted",
          sourceDocId: cand.sourceDocId, targetDocId: cand.targetDocId,
          sourceFactOrdinal: cand.sourceOrdinal, targetFactOrdinal: cand.targetOrdinal,
          confidence: cand.confidence,
        });
      }

      if (!preExisting) {
        db.prepare(
          `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
           VALUES (?, ?, 'causal', ?, ?, ?)`,
        ).run(
          sourceDocId, targetDocId,
          Math.max(...group.map(c => c.confidence)),
          JSON.stringify({ origin: "causal-writer" }),
          nowIso,
        );
      }

      const insertSighting = db.prepare(INSERT_LIVE_SIGHTING_SQL);
      for (const cand of group) {
        const changes = insertSighting.run(
          cand.sourceDocId, cand.targetDocId,
          cand.sourceOrdinal, cand.targetOrdinal,
          // 82.3 D7 (ruling 55 A): model text stored as evidence is normalised
          stripLeadingMarks(cand.sourceFact), stripLeadingMarks(cand.targetFact),
          stripLeadingMarks(cand.reasoning), cand.confidence,
          modelIdentity, CAUSAL_PROMPT_VERSION,
          runKey, runId, nowIso,
        ).changes;
        insertCausalEvent(db, runId, {
          scope: "write",
          eventType: changes === 1 ? "admitted_written" : "write_noop",
          sourceDocId: cand.sourceDocId, targetDocId: cand.targetDocId,
          sourceFactOrdinal: cand.sourceOrdinal, targetFactOrdinal: cand.targetOrdinal,
          confidence: cand.confidence,
        });
      }

      // Edge weight is DERIVED from stored evidence in the same transaction —
      // weight and visible witnesses cannot disagree. ≥1 sighting row is
      // guaranteed here (materialized legacy and/or the appends above).
      db.prepare(
        `UPDATE memory_relations
         SET weight = (SELECT MAX(confidence) FROM causal_witness_sightings
                       WHERE source_id = ? AND target_id = ?)
         WHERE source_id = ? AND target_id = ? AND relation_type = 'causal'`,
      ).run(sourceDocId, targetDocId, sourceDocId, targetDocId);
      return { refused: false };
    });

    try {
      const groupResult = writeGroup.immediate();
      if (groupResult.refused) {
        result.edgesRefused++;
      } else {
        result.edgesWritten++;
        result.admittedCount += group.length;
      }
    } catch (err) {
      // Post-rollback write_error record — nothing from this group persisted
      // (its admitted events rolled back with it); other edge groups from the
      // same response continue.
      result.edgesErrored++;
      insertCausalEventBestEffort(db, runId, {
        scope: "write", eventType: "write_error",
        sourceDocId, targetDocId,
        detail: err instanceof Error ? err.message : String(err),
      });
      console.warn(`[causal-writer] edge group ${sourceDocId}->${targetDocId} failed: ${err}`);
    }
  }

  return finalize("ok", {
    model: modelIdentity, promptSha256, responseSha256,
    newDocCount: newDocs.length, windowDocCount,
  });
}

// =============================================================================
// Resolution CLI core: census, keep-weight, retire-edge, restore-edge
// =============================================================================

export type EdgeRowImage = {
  source_id: number;
  target_id: number;
  relation_type: string;
  weight: number | null;
  metadata: string | null;
  created_at: string | null;
  contradict_confidence: number | null;
};

function typedCell(v: unknown): [string, string] | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return ["number", String(v)];
  if (typeof v === "bigint") return ["bigint", v.toString()];
  return ["string", String(v)];
}

/** Version-tagged fingerprint over EVERY non-key column of the complete
 *  `memory_relations` row image (the retirement path handles possibly-foreign
 *  rows, so no column may be assumed null), typed and null-preserving. Any
 *  future column migration on memory_relations MUST bump
 *  CAUSAL_FINGERPRINT_VERSION and extend this list. */
export function edgeFingerprint(row: EdgeRowImage): string {
  const payload = JSON.stringify([
    CAUSAL_FINGERPRINT_VERSION,
    typedCell(row.weight),
    typedCell(row.metadata),
    typedCell(row.created_at),
    typedCell(row.contradict_confidence),
  ]);
  return sha256Hex(payload);
}

export type CensusEntry = {
  row: EdgeRowImage;
  fingerprint: string;
  /** true when the old-writer metadata parses to a valid witness — these edges
   *  materialize lazily on first live touch and need no resolution. */
  materializable: boolean;
};

/**
 * Census of causal edges the WRITER can own: zero sightings AND both endpoints
 * satisfying the observation-lane predicate. Structurally excludes other
 * `'causal'` producers (Beads dependency edges live between beads documents and
 * never match the lane predicate).
 */
export function causalWitnessCensus(db: Database): CensusEntry[] {
  const lane = (alias: string) =>
    `${alias}.collection = '_clawmem' AND ${alias}.path LIKE 'observations/%' AND ${alias}.observation_type IS NOT NULL`;
  const rows = db.prepare(
    `SELECT mr.source_id, mr.target_id, mr.relation_type, mr.weight, mr.metadata,
            mr.created_at, mr.contradict_confidence
     FROM memory_relations mr
     JOIN documents s ON s.id = mr.source_id
     JOIN documents t ON t.id = mr.target_id
     WHERE mr.relation_type = 'causal'
       AND ${lane("s")} AND ${lane("t")}
       AND NOT EXISTS (
         SELECT 1 FROM causal_witness_sightings w
         WHERE w.source_id = mr.source_id AND w.target_id = mr.target_id
       )
     ORDER BY mr.source_id, mr.target_id`,
  ).all() as EdgeRowImage[];
  return rows.map(row => ({
    row,
    fingerprint: edgeFingerprint(row),
    materializable: parseLegacyEdgeWitness(row) !== null,
  }));
}

export type ResolutionManifest = {
  version: string;
  generatedAt: string;
  edges: Array<{
    sourceId: number;
    targetId: number;
    relationType: string;
    fingerprint: string;
    materializable: boolean;
  }>;
};

export function buildResolutionManifest(entries: CensusEntry[]): ResolutionManifest {
  return {
    version: CAUSAL_FINGERPRINT_VERSION,
    generatedAt: isoNow(),
    edges: entries.map(e => ({
      sourceId: e.row.source_id,
      targetId: e.row.target_id,
      relationType: e.row.relation_type,
      fingerprint: e.fingerprint,
      materializable: e.materializable,
    })),
  };
}

export type ResolutionOutcome =
  | { status: "resolved"; action: "keep-weight" | "retire-edge" }
  | { status: "stale"; reason: string }
  | { status: "refused"; reason: string };

/**
 * Apply one explicitly selected resolution under `txn.immediate()`: the manifest
 * fingerprint AND the zero-sighting condition are RECHECKED under the write lock
 * (null-safe: the fingerprint is recomputed from the live row image), so a
 * concurrent admission or any column mutation between preview and apply reports
 * STALE and touches nothing. Bulk application does not exist — callers pass one
 * edge at a time, each explicitly selected from the preview.
 */
export function applyResolution(
  db: Database,
  edge: { sourceId: number; targetId: number; fingerprint: string; manifestVersion: string },
  action: "keep-weight" | "retire-edge",
  opts: { runKey: string; runId: number; operatorNote?: string | null },
): ResolutionOutcome {
  if (edge.manifestVersion !== CAUSAL_FINGERPRINT_VERSION) {
    return {
      status: "refused",
      reason: `manifest version ${edge.manifestVersion} != ${CAUSAL_FINGERPRINT_VERSION} — regenerate the preview`,
    };
  }
  const txn = db.transaction((): ResolutionOutcome => {
    const row = db.prepare(
      `SELECT source_id, target_id, relation_type, weight, metadata, created_at, contradict_confidence
       FROM memory_relations
       WHERE source_id = ? AND target_id = ? AND relation_type = 'causal'`,
    ).get(edge.sourceId, edge.targetId) as EdgeRowImage | undefined;
    if (!row) return { status: "stale", reason: "edge no longer exists" };
    if (edgeFingerprint(row) !== edge.fingerprint) {
      return { status: "stale", reason: "row image changed since preview" };
    }
    const hasSightings = !!db.prepare(
      `SELECT 1 FROM causal_witness_sightings WHERE source_id = ? AND target_id = ? LIMIT 1`,
    ).get(edge.sourceId, edge.targetId);
    if (hasSightings) return { status: "stale", reason: "sightings appeared since preview" };

    // Resolution exists for the UNRESOLVED census only: an edge whose metadata
    // yields a valid legacy witness materializes lazily on first live touch and
    // needs no operator action — refusing here keeps retire-edge from deleting
    // valid old-writer evidence.
    if (parseLegacyEdgeWitness(row) !== null) {
      return {
        status: "refused",
        reason: "edge is materializable (valid old-writer metadata) — not an unresolved edge; no resolution needed",
      };
    }

    if (action === "keep-weight") {
      // Operator-ratified single legacy row carrying the current weight; the
      // edge becomes resolved and future writes proceed. `ux_cws_one_legacy`
      // makes a second materialization THROW rather than fabricate.
      if (typeof row.weight !== "number" || !Number.isFinite(row.weight) ||
          row.weight < 0 || row.weight > 1) {
        return {
          status: "refused",
          reason: `weight ${row.weight} is not a valid confidence in [0,1] — keep-weight cannot ratify it; use retire-edge`,
        };
      }
      // The edge is unresolved by construction (the materializable gate above
      // refused valid metadata), so there are no fact snapshots to carry — the
      // operator ratifies the weight alone.
      db.prepare(INSERT_LEGACY_SIGHTING_SQL).run(
        edge.sourceId, edge.targetId,
        null, null, "",
        row.weight, opts.runKey, opts.runId, row.created_at ?? isoNow(),
      );
      insertCausalEvent(db, opts.runId, {
        scope: "write", eventType: "legacy_materialized",
        sourceDocId: edge.sourceId, targetDocId: edge.targetId, confidence: row.weight,
        detail: "operator keep-weight",
      });
      return { status: "resolved", action };
    }

    // retire-edge: move the COMPLETE row image into the non-pruned archive and
    // delete it from the active graph in this one transaction. The archive is
    // the supported restoration path. Nothing can cascade here — the recheck
    // above proved zero sightings under the write lock.
    db.prepare(
      `INSERT INTO retired_causal_edges (
         source_id, target_id, relation_type, weight, metadata, created_at,
         contradict_confidence, retired_at, retired_run_key, operator_note, fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.source_id, row.target_id, row.relation_type, row.weight, row.metadata,
      row.created_at, row.contradict_confidence,
      isoNow(), opts.runKey, opts.operatorNote ?? null, edge.fingerprint,
    );
    db.prepare(
      `DELETE FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'causal'`,
    ).run(edge.sourceId, edge.targetId);
    insertCausalEvent(db, opts.runId, {
      scope: "write", eventType: "edge_retired",
      sourceDocId: edge.sourceId, targetDocId: edge.targetId,
      detail: opts.operatorNote ?? null,
    });
    return { status: "resolved", action };
  });
  return txn.immediate();
}

export type RestoreOutcome =
  | { status: "restored" }
  | { status: "not_archived" }
  | { status: "conflict"; reason: string };

/** Only a recognized CONSTRAINT violation is an occupied-key conflict; locking,
 *  I/O, and corruption failures must propagate honestly (and finalize the CLI
 *  run as cli_error), never masquerade as "an active edge occupies the key". */
export function isConstraintConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return true;
  return err instanceof Error && /constraint/i.test(err.message);
}

/**
 * FAIL-CLOSED restoration: under `txn.immediate()` the archived row is
 * re-inserted with a PLAIN INSERT — REPLACE, merge, and conflict-update behavior
 * are forbidden. The archive row is deleted only when exactly one active row was
 * inserted; on ANY key/FK conflict the archive stays byte-untouched and the
 * conflict is reported. An occupying active edge and its sightings can never be
 * replaced or cascaded away by a restore.
 */
export function restoreRetiredEdge(
  db: Database,
  edge: { sourceId: number; targetId: number },
  opts: { runKey: string; runId: number },
): RestoreOutcome {
  const txn = db.transaction((): RestoreOutcome => {
    const archived = db.prepare(
      `SELECT id, source_id, target_id, relation_type, weight, metadata, created_at, contradict_confidence
       FROM retired_causal_edges
       WHERE source_id = ? AND target_id = ? AND relation_type = 'causal'`,
    ).get(edge.sourceId, edge.targetId) as (EdgeRowImage & { id: number }) | undefined;
    if (!archived) return { status: "not_archived" };

    let changes = 0;
    try {
      changes = db.prepare(
        `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at, contradict_confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        archived.source_id, archived.target_id, archived.relation_type,
        archived.weight, archived.metadata, archived.created_at, archived.contradict_confidence,
      ).changes;
    } catch (err) {
      // Constraint conflict → fail-closed occupied-key report; anything else
      // (BUSY, I/O, corruption) rethrows for honest propagation.
      if (!isConstraintConflict(err)) throw err;
      return {
        status: "conflict",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (changes !== 1) {
      return { status: "conflict", reason: `insert reported ${changes} changes` };
    }
    db.prepare(`DELETE FROM retired_causal_edges WHERE id = ?`).run(archived.id);
    insertCausalEvent(db, opts.runId, {
      scope: "write", eventType: "edge_restored",
      sourceDocId: edge.sourceId, targetDocId: edge.targetId,
    });
    return { status: "restored" };
  });
  return txn.immediate();
}
