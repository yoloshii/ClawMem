/**
 * Audit-coupled contradiction seam (v0.29.0, DESIGN §J7 decision-extractor rows).
 *
 * Load-bearing properties:
 * - WITH an audit context, run + events + mutations commit in ONE transaction —
 *   an audit-insert failure rolls the EROSION back (fail-closed: an unauditable
 *   erosion is this feature's original defect).
 * - WITHOUT an audit context (seam-level tests, pre-0.29.0 callers), behavior is
 *   byte-identical to before: mutations apply, zero audit rows.
 * - Reject events mirror the REAL admission verdicts; below-threshold verdicts
 *   are recorded as classified_only with no mutation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";
import { createStore, searchFTS, type Store } from "../../src/store.ts";
import {
  applyContradictionResponse,
  type ContradictionAuditContext,
} from "../../src/hooks/decision-extractor.ts";

import { seedContent } from "../helpers/seed-content.ts";
let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "judge-seam-"));
  store = createStore(join(dir, "vault.sqlite"));
});

afterEach(() => {
  try { (store as any).close?.(); } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
});

function mkTypedDoc(path: string, contentType: string, confidence: number): number {
  const hash = createHash("sha256").update(path).digest("hex");
  const ts = "2026-08-01T00:00:00.000Z";
  seedContent(store.db, hash, `body of ${path}`, ts);
  (store as any).insertDocument("_clawmem", path, path, hash, ts, ts);
  const id = (store as any).findActiveDocument("_clawmem", path)!.id as number;
  (store as any).updateDocumentMeta(id, { content_type: contentType, confidence });
  return id;
}

function candidateFor(path: string) {
  const hit = searchFTS((store as any).db, "body", 50).find(r => r.filepath.endsWith(`/${path}`));
  if (!hit) throw new Error(`searchFTS did not return a candidate for ${path}`);
  return hit;
}

const confidenceOf = (id: number) =>
  ((store as any).db.prepare(`SELECT confidence FROM documents WHERE id = ?`).get(id) as { confidence: number }).confidence;

const AUDIT: ContradictionAuditContext = {
  sessionId: "sess-seam",
  lane: "anthropic",
  model: "claude-haiku-4-5",
  endpoint: "https://api.anthropic.com",
  promptVersion: "judge-v1",
  responseSha256: "deadbeef",
};

const verdict = (overrides: Record<string, unknown> = {}) => ({
  old_idx: 0, new_idx: 0, relation: "contradiction", confidence: 0.9, reasoning: "conflicts directly", ...overrides,
});

describe("audit-coupled apply (§J7)", () => {
  test("an ok run writes the run row, the eroded event with scores/refs, and the erosion — atomically", () => {
    const id = mkTypedDoc("observations/alpha.md", "observation", 0.8);
    const cand = candidateFor("observations/alpha.md");

    const r = applyContradictionResponse(store, [verdict()], [cand], ["new fact"], [null], AUDIT);

    expect(r.parseFailed).toBe(false);
    expect(r.outcomes.contradictions).toBe(1);
    expect(confidenceOf(id)).toBeCloseTo(0.55, 5);

    const run = (store as any).db.prepare(`SELECT * FROM judge_runs`).get() as Record<string, unknown>;
    expect(run.consumer).toBe("decision-extractor");
    expect(run.lane).toBe("anthropic");
    expect(run.outcome).toBe("ok");
    expect(run.entries_admitted).toBe(1);
    expect(run.prompt_version).toBe("judge-v1");
    expect(run.response_sha256).toBe("deadbeef");

    const ev = (store as any).db.prepare(`SELECT * FROM judge_events WHERE action = 'eroded'`).get() as Record<string, unknown>;
    expect(ev.relation).toBe("contradiction");
    expect(ev.old_ref).toBe(`doc:${id}`);
    expect(ev.score_before).toBeCloseTo(0.8, 5);
    expect(ev.score_after).toBeCloseTo(0.55, 5);
  });

  test("rejected entries emit reject events with MIRRORED reason codes", () => {
    mkTypedDoc("observations/beta.md", "observation", 0.8);
    const cand = candidateFor("observations/beta.md");
    const junk = [
      verdict({ relation: "update|contradiction|same" }),           // enum echo → invalid_relation
      verdict({ confidence: "0.0-1.0" }),                           // placeholder → invalid_confidence
      verdict({ old_idx: 99 }),                                     // → index_oob
    ];

    const r = applyContradictionResponse(store, junk, [cand], ["f"], [null], AUDIT);

    expect(r.rejected).toBe(3);
    const codes = ((store as any).db.prepare(
      `SELECT reason_code FROM judge_events WHERE event_type = 'reject' ORDER BY id`,
    ).all() as { reason_code: string }[]).map(x => x.reason_code);
    expect(codes).toEqual(["invalid_relation", "invalid_confidence", "index_oob"]);
    const run = (store as any).db.prepare(`SELECT entries_rejected FROM judge_runs`).get() as { entries_rejected: number };
    expect(run.entries_rejected).toBe(3);
  });

  test("a below-threshold verdict is classified_only: recorded, nothing mutated", () => {
    const id = mkTypedDoc("observations/gamma.md", "observation", 0.8);
    const cand = candidateFor("observations/gamma.md");

    const r = applyContradictionResponse(store, [verdict({ confidence: 0.65 })], [cand], ["f"], [null], AUDIT);

    expect(r.outcomes.contradictions).toBe(0);
    expect(confidenceOf(id)).toBeCloseTo(0.8, 5);
    const ev = (store as any).db.prepare(`SELECT action, confidence FROM judge_events WHERE event_type='verdict'`).get() as { action: string; confidence: number };
    expect(ev.action).toBe("classified_only");
    expect(ev.confidence).toBeCloseTo(0.65, 5);
  });

  test("FAIL-CLOSED: an audit-insert failure rolls the erosion back — no unaudited mutation", () => {
    const id = mkTypedDoc("observations/delta.md", "observation", 0.8);
    const cand = candidateFor("observations/delta.md");
    // Sabotage the audit inside the same store the mutation uses.
    (store as any).db.exec(`DROP TABLE judge_events`);

    expect(() =>
      applyContradictionResponse(store, [verdict()], [cand], ["f"], [null], AUDIT),
    ).toThrow();

    // The transaction rolled back: the erosion must NOT have applied.
    expect(confidenceOf(id)).toBeCloseTo(0.8, 5);
  });

  test("WITHOUT an audit context, mutations apply and ZERO audit rows are written (legacy seam)", () => {
    const id = mkTypedDoc("observations/epsilon.md", "observation", 0.8);
    const cand = candidateFor("observations/epsilon.md");

    const r = applyContradictionResponse(store, [verdict()], [cand], ["f"], [null]);

    expect(r.outcomes.contradictions).toBe(1);
    expect(confidenceOf(id)).toBeCloseTo(0.55, 5);
    const runs = ((store as any).db.prepare(`SELECT COUNT(*) AS n FROM judge_runs`).get() as { n: number }).n;
    expect(runs).toBe(0);
  });
});
