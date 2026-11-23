/**
 * s342 causal writer (C4′) — boundary tests per the rev-7 design's verification
 * plan (.codex-review/s342-causal-writer-design-2026-08-04.md §3).
 *
 * Covers: reopen-idempotent DDL; insert discipline (targeted conflict vs thrown
 * constraint); new-edge control (no legacy fabrication); legacy materialization
 * on first live touch; fail-closed unresolved-legacy refusal with per-edge-group
 * isolation; within-response dedup; window admission (no_new_endpoint) and
 * W clamping; budget skip; run-key recurrence; shadow-mode auditing; loud
 * run_key collision; and the production Stop-handler call-site lock under
 * off / shadow / on.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { monoNow, deadlineAfter, duration, type MonoDeadline } from "../../src/clock.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, canonicalDocId, DEFAULT_EMBED_MODEL, type Store } from "../../src/store.ts";
import {
  runCausalStep,
  insertCausalRun,
  parseFactsColumn,
  resolveStopBudgetMs,
  resolveCausalWindow,
  resolveCausalWriterMode,
  PERSIST_RESERVE_MS,
  CAUSAL_WINDOW_DEFAULT,
} from "../../src/causal-writer.ts";
import { decisionExtractor } from "../../src/hooks/decision-extractor.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { createHash } from "node:crypto";

import { seedContent } from "../helpers/seed-content.ts";
let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawmem-causal-writer-"));
  store = createStore(join(dir, "vault.sqlite"));
});

afterEach(() => {
  try { (store as any).close?.(); } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
});

function stubLlm(payload: unknown): any {
  return { generate: async () => ({ text: JSON.stringify(payload), model: "stub", done: true }) };
}

function mkDoc(path: string, opts?: { collection?: string; observationType?: string; facts?: string[] | string; createdAt?: string; body?: string }): number {
  const collection = opts?.collection ?? "_clawmem";
  const hash = createHash("sha256").update(collection + path).digest("hex");
  const ts = opts?.createdAt ?? "2026-08-01T00:00:00.000Z";
  seedContent(store.db, hash, opts?.body ?? `body of ${path}`, ts);
  (store as any).insertDocument(collection, path, path, hash, ts, ts);
  const id = (store as any).findActiveDocument(collection, path)!.id;
  if (opts?.observationType) {
    const factsJson = typeof opts.facts === "string" ? opts.facts : JSON.stringify(opts.facts ?? []);
    store.db.prepare(`UPDATE documents SET observation_type = ?, facts = ? WHERE id = ?`)
      .run(opts.observationType, factsJson, id);
  }
  return id;
}

/** A lane-valid NEW observation doc: the writer verifies new endpoints against
 *  the persisted lane predicate + authoritative facts column, so fixtures must
 *  persist what they hand to runCausalStep. Returns the ObservationWithDoc-shaped
 *  entry to pass as a new observation. */
function mkNewObs(path: string, facts: string[]): { docId: number; facts: string[] } {
  const docId = mkDoc(path, { observationType: "discovery", facts });
  return { docId, facts };
}

const step = (llm: any, observations: Array<{ docId: number; facts: string[] }>, opts?: {
  mode?: "shadow" | "on"; deadline?: MonoDeadline;
}) =>
  runCausalStep(store, llm, {
    sessionId: "cw-test",
    mode: opts?.mode ?? "on",
    newObservations: observations,
    deadline: opts?.deadline ?? deadlineAfter(monoNow(), duration(25_000)),
  });

const edgeRows = () => store.db.prepare(
  `SELECT source_id, target_id, weight, metadata, created_at, contradict_confidence
   FROM memory_relations WHERE relation_type = 'causal' ORDER BY source_id, target_id`,
).all() as Array<{ source_id: number; target_id: number; weight: number | null; metadata: string | null; created_at: string | null; contradict_confidence: number | null }>;

const sightingRows = () => store.db.prepare(
  `SELECT source_id, target_id, source_fact_ordinal, target_fact_ordinal, source_fact,
          target_fact, reasoning, confidence, legacy, run_key
   FROM causal_witness_sightings ORDER BY id`,
).all() as Array<{ source_id: number; target_id: number; source_fact_ordinal: number; target_fact_ordinal: number; source_fact: string | null; target_fact: string | null; reasoning: string; confidence: number; legacy: number; run_key: string }>;

const eventRows = (type?: string) => store.db.prepare(
  `SELECT scope, event_type, source_doc_id, target_doc_id, detail FROM causal_run_events
   ${type ? "WHERE event_type = ?" : ""} ORDER BY id`,
).all(...(type ? [type] : [])) as Array<{ scope: string; event_type: string; source_doc_id: number | null; target_doc_id: number | null; detail: string | null }>;

const runRows = () => store.db.prepare(
  `SELECT run_key, source, mode, outcome, candidate_count, admitted_count,
          edges_written, edges_refused, edges_errored, window_doc_count
   FROM causal_runs ORDER BY id`,
).all() as Array<{ run_key: string; source: string; mode: string; outcome: string; candidate_count: number; admitted_count: number; edges_written: number; edges_refused: number; edges_errored: number; window_doc_count: number }>;

// ─── Schema ──────────────────────────────────────────────────────────────────

describe("schema", () => {
  test("DDL is reopen-idempotent — a second open of the same vault does not throw", () => {
    const path = join(dir, "reopen.sqlite");
    const first = createStore(path);
    (first as any).close?.();
    const second = createStore(path);   // would throw "index already exists" without IF NOT EXISTS
    (second as any).close?.();
  });

  test("a live sighting with invalid confidence THROWS (CHECK) — never silently suppressed", () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");
    store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'causal', 0.9, '2026-08-01')`).run(a, b);
    expect(() => store.db.prepare(
      `INSERT INTO causal_witness_sightings (source_id, target_id, source_fact_ordinal, target_fact_ordinal,
        source_fact, target_fact, reasoning, confidence, model_identity, prompt_version, run_key, legacy, created_at)
       VALUES (?, ?, 0, 0, 'f1', 'f2', 'r', 1.5, 'm', 'v1', 'rk', 0, '2026-08-01')`,
    ).run(a, b)).toThrow();
  });

  test("a live sighting missing evidence/attribution THROWS (live-row CHECK)", () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");
    store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'causal', 0.9, '2026-08-01')`).run(a, b);
    expect(() => store.db.prepare(
      `INSERT INTO causal_witness_sightings (source_id, target_id, source_fact_ordinal, target_fact_ordinal,
        source_fact, target_fact, reasoning, confidence, model_identity, prompt_version, run_key, legacy, created_at)
       VALUES (?, ?, 0, 0, NULL, 'f2', 'r', 0.8, 'm', 'v1', 'rk', 0, '2026-08-01')`,
    ).run(a, b)).toThrow();
  });

  test("the targeted partial-index conflict suppresses ONLY the exact live duplicate", () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");
    store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'causal', 0.9, '2026-08-01')`).run(a, b);
    const insert = store.db.prepare(
      `INSERT INTO causal_witness_sightings (source_id, target_id, source_fact_ordinal, target_fact_ordinal,
        source_fact, target_fact, reasoning, confidence, model_identity, prompt_version, run_key, legacy, created_at)
       VALUES (?, ?, 0, 1, 'f1', 'f2', 'r', 0.8, 'm', 'v1', 'rk-1', 0, '2026-08-01')
       ON CONFLICT(source_id, target_id, source_fact_ordinal, target_fact_ordinal, run_key)
         WHERE legacy = 0 DO NOTHING`,
    );
    expect(insert.run(a, b).changes).toBe(1);
    expect(insert.run(a, b).changes).toBe(0);   // genuine duplicate → noop, no throw
  });

  test("run_key collision fails LOUDLY on causal_runs (UNIQUE NOT NULL)", () => {
    insertCausalRun(store.db, { runKey: "fixed-key", source: "stop_hook", mode: "on", outcome: "in_progress" });
    expect(() =>
      insertCausalRun(store.db, { runKey: "fixed-key", source: "stop_hook", mode: "on", outcome: "in_progress" }),
    ).toThrow();
  });
});

// ─── Config resolution ───────────────────────────────────────────────────────

describe("config resolution", () => {
  test("stop budget: valid, invalid, and non-positive values", () => {
    expect(resolveStopBudgetMs({ CLAWMEM_STOP_BUDGET_MS: "30000" })).toEqual({ budgetMs: 30000, invalid: null });
    expect(resolveStopBudgetMs({}).budgetMs).toBe(25000);
    expect(resolveStopBudgetMs({ CLAWMEM_STOP_BUDGET_MS: "abc" }).budgetMs).toBe(25000);
    expect(resolveStopBudgetMs({ CLAWMEM_STOP_BUDGET_MS: "abc" }).invalid).not.toBeNull();
    expect(resolveStopBudgetMs({ CLAWMEM_STOP_BUDGET_MS: "-5" }).invalid).not.toBeNull();
    expect(resolveStopBudgetMs({ CLAWMEM_STOP_BUDGET_MS: "999999999" }).invalid).not.toBeNull();
  });

  test("window: clamped to [1,10]; non-integer fails closed to the default, audited", () => {
    expect(resolveCausalWindow({ CLAWMEM_CAUSAL_WINDOW: "3" })).toEqual({ window: 3, invalid: null });
    expect(resolveCausalWindow({ CLAWMEM_CAUSAL_WINDOW: "99" }).window).toBe(10);
    expect(resolveCausalWindow({ CLAWMEM_CAUSAL_WINDOW: "99" }).invalid).not.toBeNull();
    expect(resolveCausalWindow({ CLAWMEM_CAUSAL_WINDOW: "0" }).window).toBe(1);
    expect(resolveCausalWindow({ CLAWMEM_CAUSAL_WINDOW: "abc" }).window).toBe(CAUSAL_WINDOW_DEFAULT);
    expect(resolveCausalWindow({ CLAWMEM_CAUSAL_WINDOW: "abc" }).invalid).not.toBeNull();
  });

  test("writer mode: off default, invalid values fail closed to off", () => {
    expect(resolveCausalWriterMode({})).toBe("off");
    expect(resolveCausalWriterMode({ CLAWMEM_CAUSAL_WRITER: "shadow" })).toBe("shadow");
    expect(resolveCausalWriterMode({ CLAWMEM_CAUSAL_WRITER: "on" })).toBe("on");
    expect(resolveCausalWriterMode({ CLAWMEM_CAUSAL_WRITER: "yes" })).toBe("off");
  });

  test("parseFactsColumn is strict: JSON array of nonempty strings or nothing", () => {
    expect(parseFactsColumn(JSON.stringify(["a fact", "b fact"]))).toEqual(["a fact", "b fact"]);
    expect(parseFactsColumn(null)).toBeNull();
    expect(parseFactsColumn("not json")).toBeNull();
    expect(parseFactsColumn(JSON.stringify({ not: "array" }))).toBeNull();
    expect(parseFactsColumn(JSON.stringify([]))).toBeNull();
    expect(parseFactsColumn(JSON.stringify(["ok", 42]))).toBeNull();
    expect(parseFactsColumn(JSON.stringify(["ok", "  "]))).toBeNull();
  });
});

// ─── Writer behavior ─────────────────────────────────────────────────────────

describe("runCausalStep", () => {
  test("new-edge control: a first-ever edge gets NO legacy row and NO legacy events", async () => {
    const a = mkNewObs("observations/a.md", ["config changed"]);
    const b = mkNewObs("observations/b.md", ["service restarted"]);
    const result = await step(stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.8, reasoning: "config change caused restart" },
    ]), [a, b]);

    expect(result.outcome).toBe("ok");
    expect(result.edgesWritten).toBe(1);
    const sightings = sightingRows();
    expect(sightings).toHaveLength(1);
    expect(sightings[0]!.legacy).toBe(0);
    expect(eventRows("legacy_materialized")).toHaveLength(0);
    expect(eventRows("legacy_unresolved_refusal")).toHaveLength(0);
    expect(edgeRows()[0]!.weight).toBe(0.8);
  });

  test("new endpoints are verified against the PERSISTED lane: a non-lane docId is excluded (new_doc_ineligible)", async () => {
    const plain = mkDoc("observations/plain.md");   // no observation_type → not lane-valid
    const b = mkNewObs("observations/b.md", ["a real fact"]);
    let calls = 0;
    const llm: any = { generate: async () => { calls++; return { text: "[]", model: "stub", done: true }; } };

    const result = await step(llm, [{ docId: plain, facts: ["caller-claimed fact"] }, b]);

    // Only one verified new doc remains and there is no window → no candidates,
    // and the ineligible doc is durably audited.
    expect(result.outcome).toBe("no_candidates");
    expect(calls).toBe(0);
    expect(eventRows("new_doc_ineligible")).toHaveLength(1);
    expect(eventRows("new_doc_ineligible")[0]!.source_doc_id).toBe(plain);
  });

  test("facts come from the authoritative documents.facts column, not the caller's array", async () => {
    // Persisted facts differ from what the caller passes — the prompt and the
    // stored snapshots must reflect the PERSISTED value.
    const a = mkDoc("observations/a.md", { observationType: "discovery", facts: ["persisted cause"] });
    const b = mkDoc("observations/b.md", { observationType: "discovery", facts: ["persisted effect"] });
    let seenPrompt = "";
    const llm: any = {
      generate: async (prompt: string) => {
        seenPrompt = prompt;
        return {
          text: JSON.stringify([{ source_fact_idx: 0, target_fact_idx: 1, confidence: 0.8, reasoning: "cause led to effect" }]),
          model: "stub", done: true,
        };
      },
    };

    const result = await step(llm, [
      { docId: a, facts: ["caller lie A"] },
      { docId: b, facts: ["caller lie B"] },
    ]);

    expect(result.edgesWritten).toBe(1);
    expect(seenPrompt).toContain("persisted cause");
    expect(seenPrompt).not.toContain("caller lie");
    expect(sightingRows()[0]!.source_fact).toBe("persisted cause");
    expect(sightingRows()[0]!.target_fact).toBe("persisted effect");
  });

  test("legacy materialization: pre-cut 0.9 metadata + new 0.7 sighting keeps weight 0.9 with BOTH witnesses stored", async () => {
    const a = mkNewObs("observations/a.md", ["cause fact"]);
    const b = mkNewObs("observations/b.md", ["effect fact"]);
    store.db.prepare(
      `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
       VALUES (?, ?, 'causal', 0.9, ?, '2026-07-01T00:00:00.000Z')`,
    ).run(a.docId, b.docId, JSON.stringify({ reasoning: "old writer reasoning", source_fact: "old src", target_fact: "old tgt" }));

    const result = await step(stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.7, reasoning: "weaker new evidence" },
    ]), [a, b]);

    expect(result.edgesWritten).toBe(1);
    const sightings = sightingRows();
    expect(sightings).toHaveLength(2);
    const legacy = sightings.find(s => s.legacy === 1)!;
    expect(legacy.confidence).toBe(0.9);
    expect(legacy.source_fact_ordinal).toBe(-1);
    expect(legacy.reasoning).toBe("old writer reasoning");
    expect(edgeRows()[0]!.weight).toBe(0.9);   // MAX over {legacy 0.9, live 0.7}
    expect(eventRows("legacy_materialized")).toHaveLength(1);
  });

  test("unresolved legacy FAILS CLOSED as an admission rejection (never classified admitted); other edge groups commit", async () => {
    const a = mkNewObs("observations/a.md", ["fact in a"]);
    const b = mkNewObs("observations/b.md", ["fact in b"]);
    const cc = mkNewObs("observations/c.md", ["fact in c"]);
    // Pre-cut edge a→b with metadata that cannot yield a witness (Beads-shaped).
    store.db.prepare(
      `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
       VALUES (?, ?, 'causal', 1.0, ?, '2026-07-01T00:00:00.000Z')`,
    ).run(a.docId, b.docId, JSON.stringify({ origin: "beads", dep_type: "blocks" }));
    const before = edgeRows();

    const result = await step(stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.8, reasoning: "refused group evidence" },
      { source_fact_idx: 0, target_fact_idx: 2, confidence: 0.75, reasoning: "healthy group evidence" },
    ]), [a, b, cc]);

    expect(result.edgesRefused).toBe(1);
    expect(result.edgesWritten).toBe(1);
    expect(result.edgesErrored).toBe(0);
    // Refusal IS the admission decision: only the healthy candidate is admitted,
    // and the refused pair carries NO admitted event.
    expect(result.admittedCount).toBe(1);
    const admittedEvents = eventRows("admitted");
    expect(admittedEvents).toHaveLength(1);
    expect(admittedEvents[0]!.target_doc_id).toBe(cc.docId);
    // Refused edge byte-identical: weight untouched, metadata untouched, no sightings.
    const after = edgeRows();
    const refused = after.find(e => e.source_id === a.docId && e.target_id === b.docId)!;
    expect(refused).toEqual(before[0]!);
    expect(sightingRows().filter(s => s.target_id === b.docId)).toHaveLength(0);
    expect(eventRows("legacy_unresolved_refusal")).toHaveLength(1);
    // Healthy group committed with its sighting.
    expect(sightingRows().filter(s => s.target_id === cc.docId)).toHaveLength(1);
    const run = runRows()[0]!;
    expect(run.edges_written).toBe(1);
    expect(run.edges_refused).toBe(1);
    expect(run.admitted_count).toBe(1);
  });

  test("one edge group's constraint failure rolls back ONLY that group (write_error); others commit", async () => {
    const a = mkNewObs("observations/a.md", ["fact in a"]);
    const b = mkNewObs("observations/b.md", ["fact in b"]);
    const cc = mkNewObs("observations/c.md", ["fact in c"]);
    // Deterministic injected failure for exactly one edge group: any sighting
    // insert targeting c aborts, exercising the real rollback machinery.
    store.db.exec(`CREATE TEMP TRIGGER fail_c_group BEFORE INSERT ON causal_witness_sightings
      WHEN NEW.target_id = ${cc.docId} BEGIN SELECT RAISE(ABORT, 'test-injected failure'); END`);

    const result = await step(stubLlm([
      { source_fact_idx: 0, target_fact_idx: 2, confidence: 0.8, reasoning: "doomed group evidence" },
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.9, reasoning: "healthy group evidence" },
    ]), [a, b, cc]);

    expect(result.outcome).toBe("ok");
    expect(result.edgesErrored).toBe(1);
    expect(result.edgesWritten).toBe(1);
    // The failed group persisted NOTHING — not even its edge or admitted events.
    expect(edgeRows()).toHaveLength(1);
    expect(edgeRows()[0]!.target_id).toBe(b.docId);
    expect(sightingRows()).toHaveLength(1);
    expect(eventRows("write_error")).toHaveLength(1);
    expect(eventRows("admitted").filter(e => e.target_doc_id === cc.docId)).toHaveLength(0);
    // Errored candidates never count as admitted.
    expect(result.admittedCount).toBe(1);
  });

  test("within-response dedup: exact repeats collapse to one sighting; inconsistent repeats reject the pair", async () => {
    const a = mkNewObs("observations/a.md", ["fact in a"]);
    const b = mkNewObs("observations/b.md", ["fact in b"]);
    const cc = mkNewObs("observations/c.md", ["fact in c"]);
    const result = await step(stubLlm([
      // Exact repeat — one sighting survives.
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.8, reasoning: "same evidence" },
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.8, reasoning: "same evidence" },
      // Inconsistent repeat — the WHOLE ordinal pair is rejected.
      { source_fact_idx: 0, target_fact_idx: 2, confidence: 0.7, reasoning: "one story" },
      { source_fact_idx: 0, target_fact_idx: 2, confidence: 0.95, reasoning: "another story" },
    ]), [a, b, cc]);

    expect(result.admittedCount).toBe(1);
    const sightings = sightingRows();
    expect(sightings).toHaveLength(1);
    expect(sightings[0]!.target_id).toBe(b.docId);
    expect(eventRows("duplicate_in_response").length).toBeGreaterThanOrEqual(3);
  });

  test("window admission: window↔window pairs rejected (no_new_endpoint); new↔window admitted", async () => {
    const w1 = mkDoc("observations/w1.md", { observationType: "discovery", facts: ["window fact one"], createdAt: "2026-07-30T00:00:00.000Z" });
    const w2 = mkDoc("observations/w2.md", { observationType: "discovery", facts: ["window fact two"], createdAt: "2026-07-29T00:00:00.000Z" });
    const fresh = mkNewObs("observations/new.md", ["a brand new fact"]);

    // Fact order is new-first: idx 0 = fresh, idx 1 = w1 (newest), idx 2 = w2.
    const result = await step(stubLlm([
      { source_fact_idx: 1, target_fact_idx: 2, confidence: 0.9, reasoning: "history to history" },
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.85, reasoning: "new caused window doc state" },
    ]), [fresh]);

    expect(result.admittedCount).toBe(1);
    expect(eventRows("no_new_endpoint")).toHaveLength(1);
    const edges = edgeRows();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source_id).toBe(fresh.docId);
    expect(edges[0]!.target_id).toBe(w1);
    expect(runRows()[0]!.window_doc_count).toBe(2);
    void w2;
  });

  test("window recency is effective time (authored_at ?? modified_at), not filing time", async () => {
    // Filed later but AUTHORED earlier vs filed earlier but authored later:
    // the authored-later doc must win the W=1 window slot.
    const oldByAuthor = mkDoc("observations/old-author.md", {
      observationType: "discovery", facts: ["authored long ago"], createdAt: "2026-08-02T00:00:00.000Z",
    });
    store.db.prepare(`UPDATE documents SET authored_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(oldByAuthor);
    const newByAuthor = mkDoc("observations/new-author.md", {
      observationType: "discovery", facts: ["authored recently"], createdAt: "2026-07-01T00:00:00.000Z",
    });
    store.db.prepare(`UPDATE documents SET authored_at = '2026-08-03T00:00:00.000Z' WHERE id = ?`).run(newByAuthor);
    const fresh = mkNewObs("observations/new.md", ["a brand new fact"]);

    let seenPrompt = "";
    const llm: any = {
      generate: async (prompt: string) => { seenPrompt = prompt; return { text: "[]", model: "stub", done: true }; },
    };
    const prevWindow = process.env.CLAWMEM_CAUSAL_WINDOW;
    process.env.CLAWMEM_CAUSAL_WINDOW = "1";
    try {
      await step(llm, [fresh]);
    } finally {
      if (prevWindow === undefined) delete process.env.CLAWMEM_CAUSAL_WINDOW;
      else process.env.CLAWMEM_CAUSAL_WINDOW = prevWindow;
    }
    expect(seenPrompt).toContain("authored recently");
    expect(seenPrompt).not.toContain("authored long ago");
  });

  test("intra-observation pairs are rejected (self_pair) — canon forbids self-loops", async () => {
    const a = mkNewObs("observations/a.md", ["fact one of a", "fact two of a"]);
    const b = mkNewObs("observations/b.md", ["fact in b"]);
    const result = await step(stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.9, reasoning: "both facts in one doc" },
    ]), [a, b]);

    expect(result.admittedCount).toBe(0);
    expect(eventRows("self_pair")).toHaveLength(1);
    expect(edgeRows()).toHaveLength(0);
  });

  test("malformed window facts JSON → document-scope no_facts event, doc excluded", async () => {
    mkDoc("observations/bad.md", { observationType: "discovery", facts: "{not json", createdAt: "2026-07-30T00:00:00.000Z" });
    const a = mkNewObs("observations/a.md", ["fact in a"]);
    const b = mkNewObs("observations/b.md", ["fact in b"]);
    const result = await step(stubLlm([]), [a, b]);

    expect(result.outcome).toBe("ok");
    expect(eventRows("no_facts")).toHaveLength(1);
    expect(runRows()[0]!.window_doc_count).toBe(0);
  });

  test("budget floor: near-exhausted deadline skips the model call entirely (skipped_budget, audited)", async () => {
    const a = mkNewObs("observations/a.md", ["fact in a"]);
    const b = mkNewObs("observations/b.md", ["fact in b"]);
    let calls = 0;
    const llm: any = { generate: async () => { calls++; return { text: "[]", model: "stub", done: true }; } };

    const result = await step(llm, [a, b],
      { deadline: deadlineAfter(monoNow(), duration(PERSIST_RESERVE_MS + 100)) });

    expect(result.outcome).toBe("skipped_budget");
    expect(calls).toBe(0);
    expect(runRows()[0]!.outcome).toBe("skipped_budget");
  });

  test("no candidates: a single new doc with no window yields no_candidates and no model call", async () => {
    const a = mkNewObs("observations/solo.md", ["only fact"]);
    let calls = 0;
    const llm: any = { generate: async () => { calls++; return { text: "[]", model: "stub", done: true }; } };
    const result = await step(llm, [a]);
    expect(result.outcome).toBe("no_candidates");
    expect(calls).toBe(0);
  });

  test("zero new observations still writes the invocation run row (no_candidates) and audits config anomalies", async () => {
    const result = await runCausalStep(store, stubLlm([]), {
      sessionId: "cw-test",
      mode: "shadow",
      newObservations: [],
      deadline: deadlineAfter(monoNow(), duration(25_000)),
      invalidConfigNotes: ["CLAWMEM_STOP_BUDGET_MS=\"abc\" is not a positive integer — using 25000"],
    });
    expect(result.outcome).toBe("no_candidates");
    expect(runRows()).toHaveLength(1);
    expect(eventRows("invalid_config")).toHaveLength(1);
  });

  test("strict single-shot: exactly ONE generate call, malformed response → parse_fail with no retry", async () => {
    const a = mkNewObs("observations/a.md", ["fact a"]);
    const b = mkNewObs("observations/b.md", ["fact b"]);
    let calls = 0;
    const llm: any = { generate: async () => { calls++; return { text: "not json at all", model: "stub", done: true }; } };
    const result = await step(llm, [a, b]);
    expect(result.outcome).toBe("parse_fail");
    expect(calls).toBe(1);
    expect(edgeRows()).toHaveLength(0);
  });

  test("shadow mode: audits admissions AND unresolved refusals, mutates NOTHING", async () => {
    const a = mkNewObs("observations/a.md", ["fact in a"]);
    const b = mkNewObs("observations/b.md", ["fact in b"]);
    const cc = mkNewObs("observations/c.md", ["fact in c"]);
    store.db.prepare(
      `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
       VALUES (?, ?, 'causal', 1.0, ?, '2026-07-01T00:00:00.000Z')`,
    ).run(a.docId, b.docId, JSON.stringify({ origin: "beads", dep_type: "blocks" }));

    const result = await step(stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.8, reasoning: "would be refused" },
      { source_fact_idx: 0, target_fact_idx: 2, confidence: 0.75, reasoning: "would be written" },
    ]), [a, b, cc], { mode: "shadow" });

    // Refusal is an admission rejection in shadow too: only the healthy pair admits.
    expect(result.admittedCount).toBe(1);
    expect(result.edgesWritten).toBe(0);
    expect(result.edgesRefused).toBe(1);
    expect(sightingRows()).toHaveLength(0);
    expect(edgeRows()).toHaveLength(1);        // only the pre-existing edge, untouched
    expect(edgeRows()[0]!.weight).toBe(1.0);
    expect(eventRows("legacy_unresolved_refusal")).toHaveLength(1);
    expect(runRows()[0]!.mode).toBe("shadow");
  });
});

// ─── Production call-site lock: the REAL Stop handler under off / shadow / on ─

describe("decisionExtractor boundary (off / shadow / on)", () => {
  const OBSERVATION_XML = `<observation>
  <type>decision</type>
  <title>Adopted bun for the build</title>
  <facts>
    <fact>The team adopted bun as the build runtime</fact>
  </facts>
  <narrative>Bun was adopted because install times dominated CI.</narrative>
</observation>`;

  function fakeHandlerLlm() {
    return {
      generate: async (prompt: string) => {
        if (prompt.includes("--- TRANSCRIPT ---")) {
          return { text: OBSERVATION_XML, model: "fake-observer", done: true };
        }
        // The causal prompt: link the new observation's fact (idx 0) to the
        // seeded window observation's fact (idx 1).
        return {
          text: JSON.stringify([
            { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.82, reasoning: "the adoption caused the migration work" },
          ]),
          model: "fake-causal",
          done: true,
        };
      },
      // Constant embedding: every text lands on the same vector, so the seeded
      // prior-session decision doc always surfaces as a contradiction candidate.
      embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: DEFAULT_EMBED_MODEL }),
      rerank: async () => ({ results: [] }),
    } as any;
  }

  function writeTranscript(): string {
    const path = join(dir, "transcript.jsonl");
    const lines = [
      { role: "user", content: "should we adopt bun for the build?" },
      { role: "assistant", content: "comparing bun and node install times now" },
      { role: "user", content: "ok decide and implement it" },
      { role: "assistant", content: "decision: we adopt bun; migrating the CI scripts next" },
    ].map(m => JSON.stringify(m));
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  const ENV_KEYS = ["CLAWMEM_CAUSAL_WRITER", "CLAWMEM_STOP_BUDGET_MS", "CLAWMEM_JUDGE_URL", "CLAWMEM_JUDGE_PROVIDER", "CLAWMEM_JUDGE_MODEL"];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    setDefaultLlamaCpp(fakeHandlerLlm());
    // A window observation for the causal prompt's second fact.
    mkDoc("observations/window.md", { observationType: "discovery", facts: ["CI scripts were migrated"], createdAt: "2026-07-30T00:00:00.000Z" });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    setDefaultLlamaCpp(null as any);
  });

  const drive = async () =>
    decisionExtractor(store, { sessionId: "boundary-test-session", transcriptPath: writeTranscript() } as any);

  test("off (default): the causal step never runs — zero causal_runs rows", async () => {
    delete process.env.CLAWMEM_CAUSAL_WRITER;
    await drive();
    expect(runRows()).toHaveLength(0);
  });

  test("shadow: a run row exists, nothing is written to the graph", async () => {
    process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
    await drive();
    const runs = runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.mode).toBe("shadow");
    expect(runs[0]!.admitted_count).toBe(1);
    expect(edgeRows()).toHaveLength(0);
    expect(sightingRows()).toHaveLength(0);
  });

  test("on: the real handler writes the edge + witness sighting through the new call site", async () => {
    process.env.CLAWMEM_CAUSAL_WRITER = "on";
    await drive();
    const runs = runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("ok");
    expect(runs[0]!.edges_written).toBe(1);
    expect(edgeRows()).toHaveLength(1);
    const sightings = sightingRows();
    expect(sightings).toHaveLength(1);
    expect(sightings[0]!.legacy).toBe(0);
    expect(sightings[0]!.reasoning).toBe("the adoption caused the migration work");
  });

  test("62.1 D3: the causal step runs once per COMMITTED range — an invalid transcript path commits nothing, so no run", async () => {
    // (s342 D5 recorded one invocation per Stop, early returns included; 62.1 D3's scope ruling replaced that with at
    // most one run per range Phase B committed.)
    process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
    await decisionExtractor(store, {
      sessionId: "boundary-test-session",
      transcriptPath: "/nonexistent/not-a-transcript.jsonl",
    } as any);
    expect(runRows()).toHaveLength(0);
  });

  test("an exhausted budget SKIPS observation extraction outright — no model call with a degenerate timeout", async () => {
    process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
    process.env.CLAWMEM_STOP_BUDGET_MS = "1";   // remaining − reserve is negative at extraction time
    let extractionCalls = 0;
    setDefaultLlamaCpp({
      generate: async (prompt: string) => {
        if (prompt.includes("--- TRANSCRIPT ---")) extractionCalls++;
        return { text: "[]", model: "fake", done: true };
      },
      embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: DEFAULT_EMBED_MODEL }),
      rerank: async () => ({ results: [] }),
    } as any);

    await drive();

    expect(extractionCalls).toBe(0);
    // 62.1 D3: a range that could not be extracted is QUARANTINED for a later retry (never committed as empty), so
    // no causal run starts for it; the reason is durable on the queued range.
    expect(runRows()).toHaveLength(0);
    const queued = store.db.prepare(`SELECT state, last_error FROM stop_retries`).all() as { state: string; last_error: string }[];
    expect(queued).toHaveLength(1);
    expect(queued[0]!.state).toBe("queued");
    expect(queued[0]!.last_error).toContain("budget");
  });

  test("a near-exhausted Stop budget skips the causal step, the contradiction judge, AND candidate retrieval", async () => {
    process.env.CLAWMEM_CAUSAL_WRITER = "on";
    // Extraction clears its floor (5600 − 2000 reserve = 3600 ≥ 3000), succeeds,
    // and consumes most of the budget (~2.6s): the causal step and the WHOLE
    // contradiction phase — its candidate-retrieval embedding included — then
    // sit below the 3000ms floor and must never start. The dedup embedding may
    // run legitimately (a ~1s deterministic margin remains before its absolute
    // deadline) and is told apart by its formatted input.
    process.env.CLAWMEM_STOP_BUDGET_MS = "5600";
    const base = fakeHandlerLlm();
    const embedTexts: string[] = [];
    setDefaultLlamaCpp({
      ...base,
      embed: async (text: string) => {
        embedTexts.push(text);
        return base.embed(text);
      },
      generate: async (prompt: string) => {
        if (prompt.includes("--- TRANSCRIPT ---")) {
          await new Promise(resolve => setTimeout(resolve, 2_600));
        }
        return base.generate(prompt);
      },
    } as any);
    // A READY judge configuration (config-only; the HTTP call would happen at
    // judge() time — the budget skip must fire BEFORE any call starts).
    process.env.CLAWMEM_JUDGE_URL = "http://127.0.0.1:9";
    process.env.CLAWMEM_JUDGE_PROVIDER = "openai";
    process.env.CLAWMEM_JUDGE_MODEL = "test-judge";
    // A prior-session decision doc, embedded, so the judge path's vector search
    // returns ≥1 candidate and reaches the budget gate.
    (store as any).ensureVecTable(4);
    const priorId = mkDoc("decisions/2026-08-01-othersess.md", {
      body: "The team adopted bun as the build runtime — prior decision record.",
    });
    store.db.prepare(`UPDATE documents SET content_type = 'decision' WHERE id = ?`).run(priorId);
    const priorHash = (store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(priorId) as { hash: string }).hash;
    (store as any).insertEmbedding(
      priorHash, 0, 0, new Float32Array([1, 0, 0, 0]), DEFAULT_EMBED_MODEL,
      new Date().toISOString(), "full", undefined,
      canonicalDocId("_clawmem", "decisions/2026-08-01-othersess.md"),
    );

    await drive();

    const causalRuns = runRows();
    expect(causalRuns).toHaveLength(1);
    expect(causalRuns[0]!.outcome).toBe("skipped_budget");
    const judgeRuns = store.db.prepare(
      `SELECT outcome FROM judge_runs WHERE session_id = 'boundary-test-session' ORDER BY id`,
    ).all() as Array<{ outcome: string }>;
    expect(judgeRuns.some(r => r.outcome === "skipped_budget")).toBe(true);
    // The floor gates the WHOLE contradiction phase: its candidate-retrieval
    // embedding never starts. The spy sees the FORMATTED embedding input
    // (llm.ts formatQueryForEmbedding prefixes `task: search result | query:`),
    // so the candidate signature is matched exactly and independently of how
    // many legitimate dedup embeddings ran — removing the pre-search floor
    // makes this signature appear and fails the test regardless of timing.
    const candidateSignature = "task: search result | query: The team adopted bun as the build runtime";
    expect(embedTexts.filter(t => t === candidateSignature)).toHaveLength(0);
    expect(embedTexts.length).toBeLessThanOrEqual(1);
  }, 20_000);
  // (62.1 D4: checkMergePolicy — the session-document dedup whose embedding this bounded — was deleted.)
});

// ─── 82.3 D7: witness text is a normalised field (operator rulings 55 A, 57 A) ─────────────────────────────────
describe("82.3: causal witness text without a leading byte-order mark", () => {
  const MARKS: [string, string][] = [["U+FEFF", String.fromCharCode(0xfeff)], ["U+FFFE", String.fromCharCode(0xfffe)]];

  test.each(MARKS)("a live sighting: facts and the model's reasoning led by %s are stored without it", async (_name, mark) => {
    const a = mkNewObs("observations/a.md", [mark + "config changed"]);
    const b = mkNewObs("observations/b.md", [mark + mark + "service restarted"]);
    const result = await step(stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.8, reasoning: mark + "config change caused restart" },
    ]), [a, b]);
    expect(result.edgesWritten).toBe(1);
    expect(sightingRows().map(s => [s.source_fact, s.target_fact, s.reasoning]))
      .toEqual([["config changed", "service restarted", "config change caused restart"]]);
  });

  test.each(MARKS)("a legacy sighting materialized from stored metadata led by %s is stored without it", async (_name, mark) => {
    const a = mkNewObs("observations/a.md", ["cause fact"]);
    const b = mkNewObs("observations/b.md", ["effect fact"]);
    store.db.prepare(
      `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
       VALUES (?, ?, 'causal', 0.9, ?, '2026-07-01T00:00:00.000Z')`,
    ).run(a.docId, b.docId, JSON.stringify({ reasoning: mark + "old writer reasoning", source_fact: mark + "old src", target_fact: mark + "old tgt" }));
    await step(stubLlm([{ source_fact_idx: 0, target_fact_idx: 1, confidence: 0.7, reasoning: "weaker new evidence" }]), [a, b]);
    const legacy = sightingRows().find(s => s.legacy === 1)!;
    expect([legacy.source_fact, legacy.target_fact, legacy.reasoning]).toEqual(["old src", "old tgt", "old writer reasoning"]);
  });
});
