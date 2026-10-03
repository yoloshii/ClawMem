/**
 * 62.1 D3/D8: the contradiction judge, split around Phase B.
 *
 * Phase A (no memory writes; audits of calls that failed or were skipped are written as they happen): candidate
 * retrieval, the pair-memory check, the judge call. Phase B (inside the batch's transaction): each admitted verdict's
 * OLD document is re-read — its hash still equal to the judged one → the effect is applied and the verdict recorded in
 * `judge_pair_verdicts` (D8: the same fact against the same old content is never judged into effect twice); changed →
 * `judge_deferred`, re-judged with backoff by later Stops and the worker (terminal `obsolete` only when the old
 * document is inactive or gone). A replayed range judges only candidates created and last modified at or before its
 * source time, so an earlier decision replayed late never erodes a later one or a body it never saw.
 */

import { createHash } from "crypto";
import type { Store, SearchResult } from "./store.ts";
import { DEFAULT_EMBED_MODEL, warnOnceOnVectorModelMismatch, extractSnippet, parseVirtualPath } from "./store.ts";
import { isoNow, deadlineBefore, remainingForTimeout, shorterThan, duration, signalAfter, evidenceMs, type MonoDeadline } from "./clock.ts";
import { resolveJudge, buildContradictionPrompt, extractJudgeJson, JUDGE_VERDICT_SCHEMA, JUDGE_PROMPT_VERSION } from "./judge.ts";
import { insertJudgeRunBestEffort } from "./judge-audit.ts";
import { PERSIST_RESERVE_MS, CAUSAL_MIN_BUDGET_MS } from "./causal-writer.ts";
import { hashContent } from "./indexer.ts";
import { lastChanges, nextRetryAt } from "./stop-schema.ts";
import { REJUDGE_DUE_SQL } from "./stop-due.ts";
import {
  admitContradictionEntries, unwrapContradictionArray, applyContradictionResponse, type ContradictionAuditContext,
} from "./hooks/decision-extractor.ts";

export type JudgePrepared = {
  newFacts: string[];
  candidates: SearchResult[];
  candidateDocIds: (number | null)[];
  /** Each candidate's hash when it was judged — Phase B's re-check operand. */
  candidateHashes: (string | null)[];
  rawJson: unknown;
  audit: ContradictionAuditContext;
  contractVersion: string;
};

export function factFingerprint(fact: string): string {
  return createHash("sha256").update(fact.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase(), "utf8").digest("hex");
}

function pairDecided(store: Store, factFp: string, oldDocId: number, oldHash: string, contract: string): boolean {
  return !!store.db.prepare(
    `SELECT 1 FROM judge_pair_verdicts WHERE fact_fp = ? AND old_doc_id = ? AND old_doc_hash = ? AND contract_version = ?`
  ).get(factFp, oldDocId, oldHash, contract);
}

function docIdOf(store: Store, c: SearchResult): number | null {
  const v = parseVirtualPath(c.filepath);
  return v ? store.findActiveDocument(v.collectionName, v.path)?.id ?? null : null;
}

/**
 * Phase A: retrieve candidates and ask the judge. Null when nothing is to be judged (no judge, no budget, no
 * candidate, every pair already decided, a failed or unusable call — each audited as today).
 */
export async function judgePhaseA(
  store: Store,
  newFacts: string[],
  sessionId: string,
  deadline: MonoDeadline,
  opts?: { sourceTime?: string | null; candidates?: SearchResult[] },
): Promise<JudgePrepared | null> {
  if (newFacts.length === 0) return null;
  const resolution = resolveJudge();
  if (resolution.status !== "ready") {
    insertJudgeRunBestEffort(store.db, {
      sessionId, consumer: "decision-extractor", lane: "none", promptVersion: JUDGE_PROMPT_VERSION,
      newFactCount: newFacts.length, outcome: resolution.status === "unconfigured" ? "no_judge_configured" : "config",
    });
    return null;
  }
  const judge = resolution.judge;
  const phaseDeadline = deadlineBefore(deadline, duration(PERSIST_RESERVE_MS));
  const budgetLeft = () => {
    const r = remainingForTimeout(phaseDeadline);
    return r === null || shorterThan(r, duration(CAUSAL_MIN_BUDGET_MS)) ? null : r;
  };
  const skipBudget = (candidateCount?: number) => {
    insertJudgeRunBestEffort(store.db, {
      sessionId, consumer: "decision-extractor", lane: judge.descriptor.lane, model: judge.descriptor.model,
      endpoint: judge.descriptor.endpoint, promptVersion: JUDGE_PROMPT_VERSION, newFactCount: newFacts.length,
      ...(candidateCount !== undefined ? { candidateCount } : {}), outcome: "skipped_budget",
    });
    return null;
  };
  if (!budgetLeft()) return skipBudget();

  let candidates = opts?.candidates;
  if (!candidates) {
    const queryText = newFacts.join(". ");
    let existing: SearchResult[];
    try {
      existing = await store.searchVec(queryText, DEFAULT_EMBED_MODEL, 5, undefined, undefined, undefined, phaseDeadline);
    } catch (e) {
      warnOnceOnVectorModelMismatch(e);
      existing = store.searchFTS(queryText, 5);
    }
    const sessionPrefix = sessionId.slice(0, 8);
    candidates = existing.filter(d =>
      (d.displayPath.includes("decisions/") || d.displayPath.includes("observations/")) && !d.displayPath.includes(sessionPrefix)
    );
  }
  let candidateDocIds = candidates.map(c => docIdOf(store, c));
  if (opts?.sourceTime) {
    // D3 (rev 5/6): a replay judges only candidates that existed, unmodified since, at its source time.
    const keep = candidates.map((c, i) => {
      const id = candidateDocIds[i];
      if (id == null) return false;
      const d = store.db.prepare(`SELECT created_at, modified_at FROM documents WHERE id = ?`).get(id) as { created_at: string; modified_at: string } | null;
      return !!d && d.created_at <= opts.sourceTime! && d.modified_at <= opts.sourceTime!;
    });
    candidates = candidates.filter((_, i) => keep[i]);
    candidateDocIds = candidateDocIds.filter((_, i) => keep[i]);
  }
  if (candidates.length === 0) return null;
  const candidateHashes = candidates.map(c => c.hash ?? null);
  const queryText = newFacts.join(". ");
  const prompt = buildContradictionPrompt({
    newFacts, existingSnippets: candidates.map(c => extractSnippet(c.body || "", queryText, 300).snippet), minConfidence: 0.7,
  });
  // D8: every (fact, old content) pair already decided under this contract — nothing left to ask.
  const facts = newFacts.map(factFingerprint);
  const allDecided = facts.every(f => candidates!.every((_, i) =>
    candidateDocIds[i] != null && candidateHashes[i] != null && pairDecided(store, f, candidateDocIds[i]!, candidateHashes[i]!, prompt.promptVersion)
  ));
  if (allDecided) return null;

  const remaining = budgetLeft();
  if (!remaining) return skipBudget(candidates.length);
  const base = {
    sessionId, consumer: "decision-extractor" as const, lane: judge.descriptor.lane, endpoint: judge.descriptor.endpoint,
    promptVersion: prompt.promptVersion, newFactCount: newFacts.length, candidateCount: candidates.length,
  };
  try {
    const result = await judge.judge({ system: prompt.system, user: prompt.user, schema: JUDGE_VERDICT_SCHEMA }, { signal: signalAfter(remaining) });
    if (!result.ok) {
      insertJudgeRunBestEffort(store.db, { ...base, model: judge.descriptor.model, outcome: result.reason });
      console.warn(`[decision-extractor] contradiction judge ${result.reason} (lane=${judge.descriptor.lane}): ${result.detail} — no contradiction was evaluated.`);
      return null;
    }
    if (result.truncated) {
      insertJudgeRunBestEffort(store.db, { ...base, model: result.model, responseSha256: hashContent(result.text), outcome: "truncated" });
      console.warn(`[decision-extractor] contradiction judge response TRUNCATED — rejected before extraction; no contradiction was evaluated.`);
      return null;
    }
    return {
      newFacts, candidates, candidateDocIds, candidateHashes, rawJson: extractJudgeJson(result.text), contractVersion: prompt.promptVersion,
      audit: { sessionId, lane: judge.descriptor.lane, model: result.model, endpoint: judge.descriptor.endpoint, promptVersion: prompt.promptVersion, responseSha256: hashContent(result.text) },
    };
  } catch (err) {
    console.error(`[decision-extractor] Contradiction classification failed (${evidenceMs(remaining)}ms budget):`, err);
    return null;
  }
}

function deferPair(store: Store, factFp: string, oldDocId: number, payload: unknown, sessionId: string, now: string, attempts = 0): void {
  const next = nextRetryAt(now, attempts + 1);
  store.db.prepare(
    `INSERT INTO judge_deferred (fact_fp, old_doc_id, fact_payload, session_id, queued_at, attempts, next_retry_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
     ON CONFLICT(fact_fp, old_doc_id) DO UPDATE SET fact_payload = excluded.fact_payload, attempts = excluded.attempts,
       next_retry_at = excluded.next_retry_at, state = 'queued'`
  ).run(factFp, oldDocId, JSON.stringify(payload), sessionId, now, attempts, next);
}

export type JudgeApply = { applied: number; deferred: number; remembered: number; contradictions: number };

/**
 * Phase B (inside the batch's transaction): apply the verdicts whose old document still has the judged hash, record
 * them, defer the rest. `factDocIds[i]` = the new observation document of `newFacts[i]` (null = unattributable).
 */
export function judgePhaseB(store: Store, prepared: JudgePrepared, factDocIds: readonly (number | null)[], sessionId: string, opts?: { attempts?: number }): JudgeApply {
  const out: JudgeApply = { applied: 0, deferred: 0, remembered: 0, contradictions: 0 };
  const parsed = unwrapContradictionArray(prepared.rawJson);
  if (!Array.isArray(parsed)) {
    insertJudgeRunBestEffort(store.db, {
      sessionId, consumer: "decision-extractor", lane: prepared.audit.lane, model: prepared.audit.model,
      endpoint: prepared.audit.endpoint, promptVersion: prepared.audit.promptVersion, newFactCount: prepared.newFacts.length,
      candidateCount: prepared.candidates.length, responseSha256: prepared.audit.responseSha256, outcome: "parse_reject",
    });
    return out;
  }
  const { accepted } = admitContradictionEntries(parsed, prepared.candidates.length, prepared.newFacts.length);
  const now = isoNow();
  const excluded = new Set<string>();
  const verdicts: { factFp: string; oldDocId: number; oldHash: string; relation: string }[] = [];
  for (const e of accepted) {
    const oldId = prepared.candidateDocIds[e.old_idx];
    const oldHash = prepared.candidateHashes[e.old_idx];
    if (oldId == null || oldHash == null) continue;   // the apply path audits an unresolvable target
    const factFp = factFingerprint(prepared.newFacts[e.new_idx]!);
    if (pairDecided(store, factFp, oldId, oldHash, prepared.contractVersion)) {
      out.remembered++;
      excluded.add(`${e.new_idx}:${e.old_idx}`);
      continue;
    }
    const cur = store.db.prepare(`SELECT hash, active FROM documents WHERE id = ?`).get(oldId) as { hash: string; active: number } | null;
    if (cur && cur.active === 1 && cur.hash !== oldHash) {
      deferPair(store, factFp, oldId, { fact: prepared.newFacts[e.new_idx], factDocId: factDocIds[e.new_idx] ?? null }, sessionId, now, opts?.attempts ?? 0);
      out.deferred++;
      excluded.add(`${e.new_idx}:${e.old_idx}`);
      continue;
    }
    verdicts.push({ factFp, oldDocId: oldId, oldHash, relation: e.relation });
  }
  const toApply = parsed.filter((e: any) => !excluded.has(`${e?.new_idx}:${e?.old_idx}`));
  if (toApply.length > 0) {
    const r = applyContradictionResponse(store, toApply, prepared.candidates, prepared.newFacts, factDocIds, prepared.audit);
    out.contradictions = r.outcomes.contradictions;
    out.applied = verdicts.length;
  }
  const ins = store.db.prepare(
    `INSERT OR IGNORE INTO judge_pair_verdicts (fact_fp, old_doc_id, old_doc_hash, contract_version, verdict, decided_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const v of verdicts) ins.run(v.factFp, v.oldDocId, v.oldHash, prepared.contractVersion, v.relation, now);
  return out;
}

/** A document as a judge candidate (the deferred re-judge's single candidate). */
function candidateOf(store: Store, docId: number): SearchResult | null {
  const d = store.db.prepare(
    `SELECT d.collection, d.path, d.title, d.hash, d.modified_at, c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.id = ? AND d.active = 1`
  ).get(docId) as { collection: string; path: string; title: string; hash: string; modified_at: string; body: string } | null;
  if (!d) return null;
  return {
    filepath: `clawmem://${d.collection}/${d.path}`, displayPath: `${d.collection}/${d.path}`, title: d.title, context: null,
    hash: d.hash, docid: d.hash.slice(0, 6), collectionName: d.collection, modifiedAt: d.modified_at, bodyLength: d.body.length,
    body: d.body, score: 1, source: "fts",
  } as SearchResult;
}

/**
 * Re-judge due `judge_deferred` pairs (later Stops, bounded, and the worker): an inactive or missing old document →
 * `obsolete`; otherwise the fact is judged against the old document's CURRENT content and applied under the same
 * hash re-check (changed again → deferred again, with backoff). Transaction-gated: only a still-queued row applies.
 */
export async function rejudgeDeferred(store: Store, deadline: MonoDeadline, opts?: { sessionId?: string; limit?: number }): Promise<number> {
  const now = isoNow();
  const rows = store.db.prepare(
    `SELECT fact_fp, old_doc_id, fact_payload, session_id, attempts FROM judge_deferred
     WHERE ${REJUDGE_DUE_SQL}${opts?.sessionId ? " AND session_id = ?" : ""}
     ORDER BY queued_at LIMIT ?`
  ).all(...[now, ...(opts?.sessionId ? [opts.sessionId] : []), opts?.limit ?? 5]) as
    { fact_fp: string; old_doc_id: number; fact_payload: string; session_id: string | null; attempts: number }[];
  let done = 0;
  for (const r of rows) {
    const payload = JSON.parse(r.fact_payload) as { fact: string; factDocId: number | null };
    const candidate = candidateOf(store, r.old_doc_id);
    if (!candidate) {
      store.db.prepare(`UPDATE judge_deferred SET state = 'obsolete' WHERE fact_fp = ? AND old_doc_id = ? AND state = 'queued'`).run(r.fact_fp, r.old_doc_id);
      done++;
      continue;
    }
    const prepared = await judgePhaseA(store, [payload.fact], r.session_id ?? "", deadline, { candidates: [candidate] });
    store.db.transaction(() => {
      const still = store.db.prepare(`SELECT 1 FROM judge_deferred WHERE fact_fp = ? AND old_doc_id = ? AND state = 'queued'`).get(r.fact_fp, r.old_doc_id);
      if (!still) return;
      if (!prepared) {
        const next = nextRetryAt(now, r.attempts + 1);
        store.db.prepare(`UPDATE judge_deferred SET attempts = attempts + 1, next_retry_at = ? WHERE fact_fp = ? AND old_doc_id = ?`).run(next, r.fact_fp, r.old_doc_id);
        return;
      }
      const res = judgePhaseB(store, prepared, [payload.factDocId], r.session_id ?? "", { attempts: r.attempts + 1 });
      if (res.deferred === 0) {
        store.db.prepare(`UPDATE judge_deferred SET state = 'done' WHERE fact_fp = ? AND old_doc_id = ? AND state = 'queued'`).run(r.fact_fp, r.old_doc_id);
        if (lastChanges(store.db) === 1) done++;
      }
    }).immediate();
  }
  return done;
}
