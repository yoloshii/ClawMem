/**
 * Durable contradiction-judge audit primitives (v0.29.0).
 *
 * The judge pipeline's stderr is not persisted by interactive hosts, so every
 * judge evaluation writes rows here. Transaction placement is owned by the
 * CALLER per the per-consumer taxonomy (DESIGN 0.29.0 §J7): mutation-capable
 * outcomes commit their run + events inside the mutation transaction;
 * never-mutating outcomes write standalone best-effort runs; a provider-failure
 * → heuristic fallback records BOTH runs, linked by `fallback_from_run_id`,
 * atomically before the heuristic verdict is used.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { stripLeadingMarks, truncateText } from "./text-policy.ts";

export type JudgeConsumer = "decision-extractor" | "merge-phase2" | "merge-phase3";

/** 'heuristic' = deterministic fallback classifier; 'none' = no evaluation ran (e.g. unconfigured). */
export type JudgeLane = "openai" | "anthropic" | "claude-cli" | "heuristic" | "none";

export type JudgeRunOutcome =
  | "ok"
  | "no_judge_configured"
  | "parse_reject"
  | "truncated"
  | "unavailable"
  | "config"
  | "timeout"
  | "http"
  | "aborted"
  | "skipped_budget"
  | "write_error";

export type JudgeEventType = "verdict" | "reject" | "error";

/** Mirrors the REAL admission/application verdicts — never invent codes the validators don't emit. */
export type JudgeReasonCode =
  | "invalid_relation"
  | "invalid_confidence"
  | "invalid_reasoning"
  | "placeholder_reasoning"
  | "index_oob"
  | "duplicate"
  | "inconsistent"
  | "target_unparseable"
  | "target_missing"
  | "ineligible_type"
  | "already_invalidated"
  | "write_error";

export type JudgeAction =
  | "classified_only"
  | "eroded"
  | "floor_reached"
  | "would_invalidate"
  | "invalidated"
  | "merge_link"
  | "merge_supersede"
  | "merge_supersede_blocked"
  | "merge_allowed"
  | "dedup_skip"
  | "contradicts_edge"
  | "write_noop";

export type JudgeRunInput = {
  sessionId?: string | null;
  consumer: JudgeConsumer;
  lane: JudgeLane;
  model?: string | null;
  endpoint?: string | null;
  promptVersion?: string | null;
  newFactCount?: number;
  candidateCount?: number;
  responseSha256?: string | null;
  outcome: JudgeRunOutcome;
  fallbackFromRunId?: number | null;
  entriesAdmitted?: number;
  entriesRejected?: number;
  entriesDuplicate?: number;
  entriesInconsistent?: number;
};

export type JudgeEventInput = {
  runId: number;
  eventType: JudgeEventType;
  newIdx?: number | null;
  oldIdx?: number | null;
  /** Namespaced target ids: 'doc:<id>' for documents, 'cons:<id>' for consolidated_observations. */
  newRef?: string | null;
  oldRef?: string | null;
  relation?: string | null;
  confidence?: number | null;
  reasoningHead?: string | null;
  reasonCode?: JudgeReasonCode | null;
  action?: JudgeAction | null;
  evidenceHead?: string | null;
  scoreBefore?: number | null;
  scoreAfter?: number | null;
};

/** Bound for reasoning_head / evidence_head snippets — audit rows carry heads, never full payloads. */
export const JUDGE_HEAD_MAX = 200;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function head(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = stripLeadingMarks(raw);                      // 82.3 D7: model text stored as evidence
  return truncateText(text, JUDGE_HEAD_MAX);                // never half of a pair (Codex T2 S3)
}

export function insertJudgeRun(db: Database, input: JudgeRunInput): number {
  const row = db
    .prepare(
      `INSERT INTO judge_runs (
         session_id, consumer, lane, model, endpoint, prompt_version,
         new_fact_count, candidate_count, response_sha256, outcome,
         fallback_from_run_id,
         entries_admitted, entries_rejected, entries_duplicate, entries_inconsistent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      input.sessionId ?? null,
      input.consumer,
      input.lane,
      input.model ?? null,
      input.endpoint ?? null,
      input.promptVersion ?? null,
      input.newFactCount ?? 0,
      input.candidateCount ?? 0,
      input.responseSha256 ?? null,
      input.outcome,
      input.fallbackFromRunId ?? null,
      input.entriesAdmitted ?? 0,
      input.entriesRejected ?? 0,
      input.entriesDuplicate ?? 0,
      input.entriesInconsistent ?? 0
    ) as { id: number };
  return row.id;
}

export function insertJudgeEvent(db: Database, input: JudgeEventInput): number {
  const row = db
    .prepare(
      `INSERT INTO judge_events (
         run_id, event_type, new_idx, old_idx, new_ref, old_ref,
         relation, confidence, reasoning_head, reason_code, action,
         evidence_head, score_before, score_after
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      input.runId,
      input.eventType,
      input.newIdx ?? null,
      input.oldIdx ?? null,
      input.newRef ?? null,
      input.oldRef ?? null,
      input.relation ?? null,
      input.confidence ?? null,
      head(input.reasoningHead),
      input.reasonCode ?? null,
      input.action ?? null,
      head(input.evidenceHead),
      input.scoreBefore ?? null,
      input.scoreAfter ?? null
    ) as { id: number };
  return row.id;
}

/**
 * Standalone best-effort run for never-mutating outcomes (config / outage / parse /
 * aborted / no-judge) and for the post-rollback `write_error` record. Never throws:
 * an audit failure on a path that mutates nothing must not take the hook down with it.
 */
export function insertJudgeRunBestEffort(db: Database, input: JudgeRunInput): number | null {
  try {
    return insertJudgeRun(db, input);
  } catch (err) {
    console.error(`[judge-audit] best-effort run insert failed (${input.consumer}/${input.outcome}): ${err}`);
    return null;
  }
}

export type JudgePruneOptions = {
  maxAgeDays?: number;
  maxRuns?: number;
  /** Runs from this session are never pruned (an open mutation txn may still reference them). */
  excludeSessionId?: string | null;
};

/**
 * Retention with pair semantics: prune selects ROOT runs only
 * (`fallback_from_run_id IS NULL`); the heuristic child and both runs' events go
 * with the root via FK cascade. The count cap counts root runs — one logical
 * evaluation, paired or not, is one toward the cap.
 */
export function pruneJudgeRuns(db: Database, opts: JudgePruneOptions = {}): { pruned: number } {
  const maxAgeDays = opts.maxAgeDays ?? 90;
  const maxRuns = opts.maxRuns ?? 10_000;
  const excludeSession = opts.excludeSessionId ?? null;

  // Select-then-delete so `pruned` counts ROOT runs exactly — Statement.run's
  // `changes` includes cascade deletes (children + events), which would inflate it.
  const ageIds = (
    db
      .prepare(
        `SELECT id FROM judge_runs
         WHERE fallback_from_run_id IS NULL
           AND ts < datetime('now', ?)
           AND (? IS NULL OR session_id IS NULL OR session_id != ?)`
      )
      .all(`-${maxAgeDays} days`, excludeSession, excludeSession) as { id: number }[]
  ).map(r => r.id);

  // Keep the newest maxRuns roots; roots beyond the cap go too.
  const countIds = (
    db
      .prepare(
        `SELECT id FROM judge_runs
         WHERE fallback_from_run_id IS NULL
           AND (? IS NULL OR session_id IS NULL OR session_id != ?)
           AND id NOT IN (
             SELECT id FROM judge_runs
             WHERE fallback_from_run_id IS NULL
             ORDER BY ts DESC, id DESC
             LIMIT ?
           )`
      )
      .all(excludeSession, excludeSession, maxRuns) as { id: number }[]
  ).map(r => r.id);

  const doomed = [...new Set([...ageIds, ...countIds])];
  const del = db.prepare(`DELETE FROM judge_runs WHERE id = ?`);
  const txn = db.transaction((ids: number[]) => {
    for (const id of ids) del.run(id);
  });
  if (doomed.length > 0) txn(doomed);

  return { pruned: doomed.length };
}

/** Doctor summary: row counts + oldest retained run timestamp. */
export function judgeAuditCounts(db: Database): { runs: number; events: number; oldestTs: string | null } {
  const runs = (db.prepare(`SELECT COUNT(*) AS n FROM judge_runs`).get() as { n: number }).n;
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM judge_events`).get() as { n: number }).n;
  const oldest = (db.prepare(`SELECT MIN(ts) AS t FROM judge_runs`).get() as { t: string | null }).t;
  return { runs, events, oldestTs: oldest };
}
