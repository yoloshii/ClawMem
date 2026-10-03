/**
 * 62.1 codex T23 (the implementation review's first pass): each finding reproduced by a test that failed on the build
 * it was raised against, then fixed.
 *   #1 a quiet-time feedback verdict was final — a long tool run's later citation was never credited;
 *   #2 the manifest carried no document identity — a document archived before its job drained lost its exposure;
 *   #3 a turn larger than one read's 64 MB bound never progressed (decision extraction, handoff digests, feedback);
 *   #4 SessionEnd parsed every stored digest to show 20;
 *   #5 a manifest job on an unverified vault was consumed by the legacy path;
 *   #6 an entry whose document was inactive at attribution was still marked referenced, so the repair credited it;
 *   #7 a fixed first page of blocked items starved a due one (worker feedback groups, named-vault mirrors).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { setDefaultLlamaCpp, getDefaultLlamaCpp } from "../../src/llm.ts";
import { applySurfacingBookkeeping, type SurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";
import { feedbackLoop } from "../../src/hooks/feedback-loop.ts";
import { handoffGenerator } from "../../src/hooks/handoff-generator.ts";
import { runStopWorkerTick } from "../../src/stop-worker.ts";
import { applyMirrorSlices, attributeTranscript } from "../../src/stop-feedback.ts";
import { runDecisionExtraction } from "../../src/stop-extract.ts";
import { runHandoffDigests, HANDOFF_HOOK } from "../../src/stop-handoff.ts";
import { recomputeCounters } from "../../src/stop-repair.ts";
import { readStopCursor } from "../../src/stop-cursor.ts";
import { registerTranscript } from "../../src/stop-identity.ts";
import { promptSha, transcriptKey } from "../../src/stop-pairing.ts";
import { T0, iso, human, assistant, toolResult, stopMarker, ocMessage, command, writeTranscriptFile, appendEntries } from "./stop-fixtures.ts";
import { currentTurnStart, streamLines, readLines } from "../../src/stop-cursor.ts";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { writeFileSync } from "fs";

const dirs: string[] = [];
let failSummary = false;
let observerPrompts: string[] = [];
beforeEach(() => {
  failSummary = false;
  observerPrompts = [];
  setDefaultLlamaCpp({
    generate: async (prompt: string) => {
      // v0.41.4 §2.1: the model's "nothing" is `<none/>` (an empty reply is a format failure now).
      if (prompt.includes("Extract observations:")) { observerPrompts.push(prompt); return { text: "<none/>", model: "fake", done: true }; }
      if (prompt.includes("session summarizer")) {
        if (failSummary) return null;
        return { text: `<summary><request>R</request><investigated>None</investigated><learned>None</learned><completed>Done</completed><next_steps>None</next_steps></summary>`, model: "fake", done: true };
      }
      return { text: "", model: "fake", done: true };
    },
    embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: "fake" }),
  } as any);
});
afterEach(() => {
  setDefaultLlamaCpp(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-621-t23-")); dirs.push(d); return d; }
const ageFile = (path: string, ms: number) => { const t = (Date.now() - ms) / 1000; utimesSync(path, t, t); };
const MIN = 60_000;

function seedDoc(store: Store, collection: string, path: string, title: string): number {
  const hash = `h-${collection}-${path}`;
  store.insertContent(hash, `# ${title}\n\nbody`, iso(0));
  store.insertDocument(collection, path, title, hash, iso(0), iso(0));
  return store.findActiveDocument(collection, path)!.id;
}
function usageRow(store: Store, sessionId: string, t: number, prompt: string, path: string | null, host = "claude-code"): number {
  return store.insertUsage({
    sessionId, timestamp: iso(t), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0,
    queryText: prompt, promptSha: promptSha(prompt), transcriptKey: path ? transcriptKey(path) : null, host, sessionKey: null,
  });
}
type Item = { vault: string | null; displayPath: string; title: string; docId?: number | null };
function manifestJob(usageId: number, sessionId: string, entries: Item[], jobId = `job-${usageId}-${sessionId}`): SurfacingBookkeepingJob {
  const groups = new Map<string | null, { displayPath: string; searchScore: number }[]>();
  for (const e of entries) {
    if (!groups.has(e.vault)) groups.set(e.vault, []);
    groups.get(e.vault)!.push({ displayPath: e.displayPath, searchScore: 0.9 });
  }
  return {
    v: 1, kind: "surfacing-bookkeeping", jobId, sessionId, turnIndex: 0, usageId, queryHash: "qh",
    injectedPaths: entries.map(e => e.displayPath), estimatedTokens: 10, vaults: [...groups].map(([vault, docs]) => ({ vault, docs })),
    manifest: entries.map(e => ({ vault: e.vault, displayPath: e.displayPath, displayedTitle: e.title, docId: e.docId ?? null })),
  } as SurfacingBookkeepingJob;
}
const turnState = (store: Store, id: number) => store.db.prepare(`SELECT state, reason FROM feedback_turns WHERE usage_id = ?`).get(id) as { state: string; reason: string | null } | null;
const accessOf = (store: Store, id: number) => (store.db.prepare(`SELECT access_count FROM documents WHERE id = ?`).get(id) as { access_count: number }).access_count;
const ledger = (store: Store, id: number) => store.db.prepare(
  `SELECT vault, display_path, vault_doc_id, referenced_at FROM feedback_ledger WHERE usage_id = ? ORDER BY vault, display_path`
).all(id) as { vault: string; display_path: string; vault_doc_id: number | null; referenced_at: string | null }[];
const surfaced = (store: Store, path: string) => (store.db.prepare(`SELECT surfaced_count FROM utility_signals WHERE path = ?`).get(path) as { surfaced_count: number } | null)?.surfaced_count ?? 0;
const tick = (store: Store, vaults: { name: string; store: Store }[] = []) => runStopWorkerTick(store, vaults, getDefaultLlamaCpp());
const A = { vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" };
const B = { vault: null, displayPath: "notes/b/beta.md", title: "Beta rollout notes" };

describe("T23 #1 a quiet-time feedback verdict is provisional; the turn's end revises it once", () => {
  /** An OpenClaw turn (its window [E_prev, H] is closed once H is written), paused in a long tool run. */
  function longToolRun() {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const b = seedDoc(store, "notes", "b/beta.md", B.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      ocMessage("user", "question about alpha and beta", 100),
      ocMessage("assistant", "Starting from a/alpha.md; running the long build now.", 110),
    ]);
    registerTranscript(store.db, "s", path, "openclaw", null);   // before_prompt_build registers it
    const u = usageRow(store, "s", 99, "question about alpha and beta", path, "openclaw");
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }, { ...B, docId: b }]));
    return { store, a, b, path, u };
  }

  it("the worker credits what is written after 10 quiet minutes; the Stop credits the later citation, each once, the pair once", async () => {
    const { store, a, b, path, u } = longToolRun();
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(accessOf(store, a)).toBe(1);
    expect(accessOf(store, b)).toBe(0);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: "provisional" });
    appendEntries(path, [ocMessage("assistant", "Per b/beta.md the rollout waits for the build.", 15 * MIN + 10)]);
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path, host: "openclaw" } as any, { vaults: [] });   // agent_end ends the turn
    expect(accessOf(store, a)).toBe(1);
    expect(accessOf(store, b)).toBe(1);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: null });
    expect(store.db.prepare(`SELECT doc_a, doc_b, count FROM co_activations`).all()).toEqual([{ doc_a: "notes/a/alpha.md", doc_b: "notes/b/beta.md", count: 1 }]);
    expect(store.db.prepare(`SELECT source_id, target_id FROM memory_relations WHERE relation_type = 'usage'`).all()).toEqual([{ source_id: a, target_id: b }]);
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path, host: "openclaw" } as any, { vaults: [] });
    await tick(store);
    expect([accessOf(store, a), accessOf(store, b)]).toEqual([1, 1]);
  });

  it("a named vault's mirror follows the provisional verdict and is finalized with it (T24 #4)", async () => {
    const general = createTestStore();
    const vault = createTestStore();
    const v = seedDoc(vault, "skills", "tools/linter.md", "Linter configuration guide");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [ocMessage("user", "how do we lint", 100), ocMessage("assistant", "Checking now.", 110)]);
    registerTranscript(general.db, "s", path, "openclaw", null);
    const u = usageRow(general, "s", 99, "how do we lint", path, "openclaw");
    applySurfacingBookkeeping(general, manifestJob(u, "s", [{ vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide", docId: v }]),
      { resolveVaultStore: () => vault });
    const vaults = [{ name: "skills", store: vault }];
    ageFile(path, 11 * MIN);
    await tick(general, vaults);
    expect(turnState(general, u)).toEqual({ state: "attributed", reason: "provisional" });
    const mirror = (vault.db.prepare(`SELECT id FROM context_usage`).get() as { id: number }).id;
    expect(turnState(vault, mirror)).toEqual({ state: "attributed", reason: "provisional" });   // open, like its source
    expect(accessOf(vault, v)).toBe(0);
    appendEntries(path, [ocMessage("assistant", "skills/tools/linter.md is strict.", 15 * MIN + 10)]);
    await feedbackLoop(general, { sessionId: "s", transcriptPath: path, host: "openclaw" } as any, { vaults });
    expect(turnState(vault, mirror)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(vault, v)).toBe(1);
    await feedbackLoop(general, { sessionId: "s", transcriptPath: path, host: "openclaw" } as any, { vaults });
    expect(accessOf(vault, v)).toBe(1);
  });

  it("age alone never makes it final: a turn paused for 25 hours that resumes still gets its later citation credited (T24 #4)", async () => {
    const { store, b, path, u } = longToolRun();
    ageFile(path, 11 * MIN);
    await tick(store);
    ageFile(path, 25 * 60 * MIN);
    await tick(store);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: "provisional" });
    appendEntries(path, [ocMessage("assistant", "Per b/beta.md the rollout is done.", 26 * 60 * MIN + 10)]);
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path, host: "openclaw" } as any, { vaults: [] });
    expect(accessOf(store, b)).toBe(1);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: null });
  });

  it("a session end makes it final", async () => {
    const { store, path, u } = longToolRun();
    ageFile(path, 11 * MIN);
    await tick(store);
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path, hookEventName: "SessionEnd" } as any);
    await tick(store);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: null });
  });
});

describe("T23 #2 the manifest carries the document's id; exposure counts whatever its later state", () => {
  it("buildContext records the id the snooze filter resolved for each accepted result", async () => {
    const { buildContext } = await import("../../src/hooks/context-surfacing.ts");
    const r = { displayPath: "notes/a.md", filepath: "clawmem://notes/a.md", title: "Alpha", body: "alpha body", compositeScore: 0.9, contentType: "note", chunkPos: 0, _docId: 42 } as any;
    expect(buildContext([r], "alpha", 1000).manifest).toEqual([{ vault: null, displayPath: "notes/a.md", displayedTitle: "Alpha", docId: 42 }]);
  });

  it("a document archived before its job drains is pinned by id and counted surfaced; its later mention is never credited", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      human("question about alpha", 100), assistant("a/alpha.md helps", 110), human("next", 200), assistant("ok", 210),
    ]);
    const u = usageRow(store, "s", 101, "question about alpha", path);
    store.db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(a);   // archived between injection and drain
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    expect(ledger(store, u)).toEqual([{ vault: "", display_path: "notes/a/alpha.md", vault_doc_id: a, referenced_at: null }]);
    expect(surfaced(store, "notes/a/alpha.md")).toBe(1);
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path }, { vaults: [] });
    expect(turnState(store, u)!.state).toBe("attributed");
    expect(ledger(store, u)[0]!.referenced_at).toBeNull();
    expect(accessOf(store, a)).toBe(0);
  });
});

describe("T23 #3 a turn larger than one read's bound progresses in bounded pieces", () => {
  const BOUND = 4096;
  const bigTurn = (n: number, t: number) => [
    human(`question for turn ${n}`, t),
    ...Array.from({ length: 6 }, (_, i) => assistant(`step ${i} of turn ${n}: ${"x".repeat(1500)}`, t + 1 + i)),
    assistant(`Per a/alpha.md the answer for turn ${n} is ready. We decided to adopt bun as the build runtime.`, t + 10),
  ];

  it("an oversized turn is ONE turn: one inference that sees its end, one digest, both cursors past it (T24 #1)", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [...bigTurn(1, 100), human("question for turn 2", 200), assistant("short", 201)]);
    // The first Stop sees turn 2 as current (a fresh cursor anchors there); write the cursors at turn 1's start by
    // letting the first Stop happen with only turn 1 in the file.
    rmSync(path);
    writeTranscriptFile(dirs.at(-1)!, "s.jsonl", bigTurn(1, 100));
    await runDecisionExtraction(store, { sessionId: "s", transcriptPath: path, readMaxBytes: BOUND } as any);
    runHandoffDigests(store, { sessionId: "s", transcriptPath: path, atStop: true, readMaxBytes: BOUND } as any);
    const key = transcriptKey(path);
    const size1 = (await Bun.file(path).arrayBuffer()).byteLength;
    expect(readStopCursor(store.db, "s", "decision-extractor", key)!.byteOffset).toBe(size1);
    expect(readStopCursor(store.db, "s", HANDOFF_HOOK, key)!.byteOffset).toBe(size1);
    expect(observerPrompts.length).toBe(1);
    expect(observerPrompts[0]).toContain("the answer for turn 1 is ready");
    const digests = store.db.prepare(`SELECT fp, payload FROM stop_items WHERE kind = 'turn-digest'`).all() as { fp: string; payload: string }[];
    expect(digests.length).toBe(1);
    expect(JSON.parse(digests[0]!.payload)).toMatchObject({ request: "question for turn 1" });
    expect(JSON.parse(digests[0]!.payload).outcome).toContain("the answer for turn 1 is ready");
  });

  it("decision extraction and the handoff digest step advance through the oversized turn", async () => {
    const store = createTestStore();
    // Only the big turn so far: a fresh cursor anchors at the current turn, which starts at offset 0.
    const path = writeTranscriptFile(tmp(), "s.jsonl", bigTurn(1, 100));
    const key = transcriptKey(path);
    const offsets = () => [readStopCursor(store.db, "s", "decision-extractor", key)?.byteOffset ?? -1, readStopCursor(store.db, "s", HANDOFF_HOOK, key)?.byteOffset ?? -1];
    const stop = async () => {
      await runDecisionExtraction(store, { sessionId: "s", transcriptPath: path, readMaxBytes: BOUND } as any);
      runHandoffDigests(store, { sessionId: "s", transcriptPath: path, atStop: true, readMaxBytes: BOUND } as any);
    };
    await stop();
    const first = offsets();
    expect(first[0]).toBeGreaterThan(0);
    expect(first[1]).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) await stop();
    appendEntries(path, [human("question for turn 2", 200), assistant("short", 201)]);
    for (let i = 0; i < 3; i++) await stop();
    const size = (await Bun.file(path).arrayBuffer()).byteLength;
    expect(offsets()).toEqual([size, size]);
  });

  it("feedback streams past eight reads' worth of one turn and concludes it (T24 #5)", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [...bigTurn(1, 100), human("question for turn 2", 200), assistant("short", 201)]);
    const u = usageRow(store, "s", 101, "question for turn 1", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    attributeTranscript(store, { sessionId: "s", transcriptPath: path, atStop: false, readMaxBytes: 512 } as any);   // ≈ 20 reads
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, a)).toBe(1);
  });

  it("feedback reads through the oversized turn to its end and credits a citation beyond the first read", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [...bigTurn(1, 100), human("question for turn 2", 200), assistant("short", 201)]);
    const u = usageRow(store, "s", 101, "question for turn 1", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    attributeTranscript(store, { sessionId: "s", transcriptPath: path, atStop: false, readMaxBytes: BOUND } as any);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, a)).toBe(1);
  });
});

describe("T23 #4 SessionEnd's work is bounded by its display, not by the stored digests", () => {
  it("200,000 stored digests: the latest 20 and a count, inside 150 ms", async () => {
    const store = createTestStore();
    failSummary = true;
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      human("question for turn 1", 100), assistant("Working.", 101, [{ id: "t1", name: "Edit", input: { file_path: "/r/a.ts" } }]),
      toolResult("t1", "ok", 102), assistant("Final answer for turn 1: done.", 103),
    ]);
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path });
    const key = transcriptKey(path);
    const ins = store.db.prepare(
      `INSERT INTO stop_items (session_id, transcript_key, kind, fp, anchor_epoch, range_from, range_to, range_sha, seq, payload, created_at)
       VALUES ('s', ?, 'turn-digest', ?, 0, 0, 1, 'x', ?, ?, ?)`
    );
    store.db.transaction(() => {
      for (let i = 2; i <= 200_001; i++) {
        ins.run(key, `0:${1_000_000 + i}`, i, JSON.stringify({ request: `request ${i} ${"r".repeat(150)}`, outcome: `outcome ${i} ${"o".repeat(250)}`, files: [`/r/f${i}.ts`], at: null, messages: 4 }), iso(i));
      }
    })();
    store.db.prepare(`UPDATE session_docs SET render_needed = 1 WHERE kind = 'handoff'`).run();
    const t0 = performance.now();
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path, hookEventName: "SessionEnd" } as any);
    const ms = performance.now() - t0;
    console.log(`[t23#4] SessionEnd with 200k digests: ${ms.toFixed(0)} ms`);
    const body = (store.db.prepare(`SELECT c.doc FROM session_docs s JOIN documents d ON d.id = s.doc_id JOIN content c ON c.hash = d.hash WHERE s.kind = 'handoff'`).get() as { doc: string }).doc;
    expect(body).toContain("199981 earlier turns");
    expect(body).toContain("request 200001 ");
    expect(ms).toBeLessThan(150);
  }, 60_000);
});

describe("T23 #5 a manifest job on an unverified vault is retained, never consumed", () => {
  /** A file-backed store whose stop-pipeline migration cannot complete at this open (a writer holds the vault). */
  function unverified(dbPath: string): Store {
    const s0 = createStore(dbPath);
    s0.db.exec(`DELETE FROM vault_flags WHERE flag = 'stop-pipeline:schema-v1'`);
    s0.close();
    const holder = new Database(dbPath);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const origError = console.error;
    console.error = () => {};
    try { return createStore(dbPath, { busyTimeout: 50 }); } finally { console.error = origError; holder.exec("ROLLBACK"); holder.close(); }
  }

  it("general vault unverified: the update unit fails and nothing is marked; verified later, the job applies in full", () => {
    const dir = tmp();
    const dbPath = join(dir, "index.sqlite");
    const s0 = createStore(dbPath);
    const a = seedDoc(s0, "notes", "a/alpha.md", A.title);
    const u = usageRow(s0, "s", 101, "question about alpha", null);
    s0.close();
    const s1 = unverified(dbPath);
    const job = manifestJob(u, "s", [{ ...A, docId: a }]);
    const r1 = applySurfacingBookkeeping(s1, job);
    expect(r1.failedUnits).toContain("update");
    expect(r1.completedUnits).not.toContain("update");
    s1.close();
    const s2 = createStore(dbPath);
    expect(turnState(s2, u)).toBeNull();
    const r2 = applySurfacingBookkeeping(s2, { ...job, completedUnits: r1.completedUnits });
    expect(r2.failedUnits).toEqual([]);
    expect(turnState(s2, u)!.state).toBe("pending");
    expect(ledger(s2, u).length).toBe(1);
    expect(surfaced(s2, "notes/a/alpha.md")).toBe(1);
    s2.close();
  });

  it("named vault unverified: its unit fails before any write; verified later, the mirror and its membership land", () => {
    const general = createTestStore();
    const dir = tmp();
    const vaultPath = join(dir, "skills.sqlite");
    const v0 = createStore(vaultPath);
    const v = seedDoc(v0, "skills", "tools/linter.md", "Linter configuration guide");
    v0.close();
    const u = usageRow(general, "s", 101, "how do we lint", null);
    const job = manifestJob(u, "s", [{ vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide", docId: v }]);
    const v1 = unverified(vaultPath);
    const r1 = applySurfacingBookkeeping(general, job, { resolveVaultStore: () => v1 });
    expect(r1.failedUnits).toEqual(["vault:skills"]);
    expect((v1.db.prepare(`SELECT COUNT(*) AS n FROM context_usage`).get() as { n: number }).n).toBe(0);
    v1.close();
    const v2 = createStore(vaultPath);
    const r2 = applySurfacingBookkeeping(general, { ...job, completedUnits: r1.completedUnits, usageLinked: r1.usageLinked }, { resolveVaultStore: () => v2 });
    expect(r2.failedUnits).toEqual([]);
    const mirror = (v2.db.prepare(`SELECT id FROM context_usage`).get() as { id: number }).id;
    expect(turnState(v2, mirror)!.state).toBe("pending");
    expect(ledger(v2, mirror)[0]!.vault_doc_id).toBe(v);
    v2.close();
  });
});

describe("T23 #6 an entry whose document is inactive at attribution is never marked referenced", () => {
  it("live attribution credits neither it nor its pair, and the repair agrees", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const b = seedDoc(store, "notes", "b/beta.md", B.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      human("question about alpha and beta", 100), assistant("a/alpha.md and b/beta.md agree.", 110), human("next", 200), assistant("ok", 210),
    ]);
    const u = usageRow(store, "s", 101, "question about alpha and beta", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }, { ...B, docId: b }]));
    store.db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(b);
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path }, { vaults: [] });
    expect(ledger(store, u).map(e => [e.display_path, e.referenced_at !== null])).toEqual([["notes/a/alpha.md", true], ["notes/b/beta.md", false]]);
    await recomputeCounters(store.db, { apply: true });
    expect(accessOf(store, b)).toBe(0);
    expect(accessOf(store, a)).toBe(1);
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM co_activations`).get()).toEqual({ n: 0 });
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM memory_relations WHERE relation_type = 'usage'`).get()).toEqual({ n: 0 });
  });
});

describe("T23 #7 a due item behind a full page of blocked ones is reached", () => {
  it("feedback: 60 live transcripts with pending rows do not hide a quiet one", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const dir = tmp();
    for (let i = 0; i < 60; i++) {
      const p = writeTranscriptFile(dir, `live-${i}.jsonl`, [human(`live question ${i}`, 100), assistant("thinking", 110)]);
      registerTranscript(store.db, `a-live-${String(i).padStart(2, "0")}`, p, "claude-code", null);
      const u = usageRow(store, `a-live-${String(i).padStart(2, "0")}`, 101, `live question ${i}`, p);
      applySurfacingBookkeeping(store, manifestJob(u, `a-live-${String(i).padStart(2, "0")}`, [{ ...A, docId: a }]));
    }
    const qp = writeTranscriptFile(dir, "quiet.jsonl", [human("quiet question", 100), assistant("a/alpha.md helps", 110), stopMarker(111)]);
    registerTranscript(store.db, "z-quiet", qp, "claude-code", null);
    const uq = usageRow(store, "z-quiet", 101, "quiet question", qp);
    applySurfacingBookkeeping(store, manifestJob(uq, "z-quiet", [{ ...A, docId: a }]));
    ageFile(qp, 11 * MIN);
    await tick(store);
    expect(turnState(store, uq)!.state).toBe("attributed");
  });

  it("mirrors: 60 mirrors waiting on a pending general verdict do not hide an eligible one", () => {
    const general = createTestStore();
    const vault = createTestStore();
    const mirrorOf = (sourceId: number) => {
      const id = vault.insertUsage({
        sessionId: "s", timestamp: iso(1), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0,
        queryText: "q", promptSha: null, transcriptKey: null, host: "claude-code", sessionKey: null, sourceUsageId: sourceId,
      });
      vault.db.prepare(`INSERT INTO feedback_turns (usage_id, state, attempts, updated_at) VALUES (?, 'pending', 0, ?)`).run(id, iso(1));
      return id;
    };
    for (let i = 0; i < 60; i++) {
      const g = usageRow(general, "s", 1, "q", null);
      general.db.prepare(`INSERT INTO feedback_turns (usage_id, state, attempts, updated_at) VALUES (?, 'pending', 0, ?)`).run(g, iso(1));
      mirrorOf(g);
    }
    const gDone = usageRow(general, "s", 1, "q", null);
    general.db.prepare(`INSERT INTO feedback_turns (usage_id, state, attempts, updated_at) VALUES (?, 'attributed', 0, ?)`).run(gDone, iso(1));
    const eligible = mirrorOf(gDone);
    expect(applyMirrorSlices(general, vault, "skills", { limit: 50 })).toBe(1);
    expect(turnState(vault, eligible)!.state).toBe("attributed");
  });
});

describe("T24 provisional credit, catch-up progress, reporting", () => {
  it("#2 a pairing decided by the prompt hash alone (no timestamps) earns no provisional credit; the Stop credits it", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("question about alpha", null), assistant("a/alpha.md helps", null)]);
    registerTranscript(store.db, "s", path, "claude-code", null);
    const u = usageRow(store, "s", 101, "question about alpha", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(turnState(store, u)!.state).toBe("pending");
    expect(accessOf(store, a)).toBe(0);
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path }, { vaults: [] });
    expect(accessOf(store, a)).toBe(1);
  });

  it("#3 worker catch-up without a Stop: repeated reads reach the readable end of a quiet transcript larger than one read", async () => {
    const store = createTestStore();
    const big = (n: number, t: number) => [
      human(`question for turn ${n}`, t),
      ...Array.from({ length: 4 }, (_, i) => assistant(`step ${i} of turn ${n}: ${"y".repeat(1500)}`, t + 1 + i)),
      assistant(`Final answer for turn ${n}: done.`, t + 9),
    ];
    const path = writeTranscriptFile(tmp(), "s.jsonl", big(1, 100));
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path, readMaxBytes: 4096 } as any);
    appendEntries(path, [...big(2, 200), ...big(3, 300), human("question for turn 4", 400), assistant("Final answer for turn 4: done.", 401)]);
    registerTranscript(store.db, "s", path, "claude-code", null);
    ageFile(path, 11 * MIN);
    for (let i = 0; i < 3; i++) await runStopWorkerTick(store, [], getDefaultLlamaCpp(), { readMaxBytes: 4096 });
    const cursor = readStopCursor(store.db, "s", HANDOFF_HOOK, transcriptKey(path))!;
    const requests = (store.db.prepare(`SELECT payload FROM stop_items WHERE kind = 'turn-digest' ORDER BY seq`).all() as { payload: string }[])
      .map(r => JSON.parse(r.payload).request);
    expect(requests).toEqual(expect.arrayContaining(["question for turn 2", "question for turn 3", "question for turn 4"]));
    expect(cursor.turnStartOffset).toBe(cursor.byteOffset);   // at the trailing turn's start (provisional), nothing unread before it
  });

  it("#6 doctor's data reports open provisional verdicts and their age", async () => {
    const { stopPipelineHealth, stopHealthLine } = await import("../../src/stop-health.ts");
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [ocMessage("user", "question about alpha", 100), ocMessage("assistant", "a/alpha.md helps", 110)]);
    registerTranscript(store.db, "s", path, "openclaw", null);
    const u = usageRow(store, "s", 99, "question about alpha", path, "openclaw");
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    ageFile(path, 11 * MIN);
    await tick(store);
    const h = stopPipelineHealth(store.db);
    expect(h.feedbackPending.count).toBe(0);
    expect(h.feedbackProvisional.count).toBe(1);
    expect(h.feedbackProvisional.oldest).toBe(iso(99));
    expect(stopHealthLine(h)).toContain("(+1 provisional)");
  });
});

describe("T25 closed windows, whole-text references, no silent caps, strict progress, revisions", () => {
  it("#1 a trailing Claude Code turn (open window) gets no provisional credit, even quiet; a later untimestamped twin cannot strand one", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("question about alpha", 100), assistant("a/alpha.md helps", 110)]);
    registerTranscript(store.db, "s", path, "claude-code", null);
    const u = usageRow(store, "s", 101, "question about alpha", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(turnState(store, u)!.state).toBe("pending");
    expect(accessOf(store, a)).toBe(0);
    appendEntries(path, [human("question about alpha", null), assistant("again a/alpha.md", null)]);
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(accessOf(store, a)).toBe(0);   // nothing was credited that the twin could have made ambiguous
  });

  it("#1 a stop marker ends the turn it follows — the main one only, never on a subagent's (sidechain) marker", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      human("question about alpha", 100), assistant("a/alpha.md helps", 110), { ...stopMarker(111), isSidechain: true },
    ]);
    registerTranscript(store.db, "s", path, "claude-code", null);
    const u = usageRow(store, "s", 101, "question about alpha", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(turnState(store, u)!.state).toBe("pending");
    appendEntries(path, [stopMarker(112)]);
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(store, a)).toBe(1);
  });

  it("#2 a displayed title split across two assistant messages is still credited", async () => {
    const store = createTestStore();
    const x = seedDoc(store, "notes", "projects/plan-notes.md", "Ingest pipeline plan");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      human("how do we batch writes", 100), assistant("For batching, see the Ingest pipeline", 110), assistant("plan: writes go in groups of fifty.", 111),
      human("next", 200), assistant("ok", 201),
    ]);
    const u = usageRow(store, "s", 101, "how do we batch writes", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ vault: null, displayPath: "notes/projects/plan-notes.md", title: "Ingest pipeline plan", docId: x }]));
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path }, { vaults: [] });
    expect(accessOf(store, x)).toBe(1);
  });

  it("#3 every distinct regex decision of a streamed oversized turn is kept, the last one included", async () => {
    const store = createTestStore();
    const lines = [human("question for turn 1", 100)];
    for (let i = 1; i <= 25; i++) lines.push(assistant(`We decided to adopt tool number ${i} for stage ${i}. ${"z".repeat(900)}`, 100 + i));
    const path = writeTranscriptFile(tmp(), "s.jsonl", lines);
    await runDecisionExtraction(store, { sessionId: "s", transcriptPath: path, readMaxBytes: 2048 } as any);
    const texts = (store.db.prepare(`SELECT payload FROM stop_items WHERE kind = 'decision'`).all() as { payload: string }[])
      .map(r => JSON.parse(r.payload)).filter(p => p.source === "regex").map(p => p.text as string);
    expect(texts.length).toBe(25);
    expect(texts.some(t => t.includes("tool number 25 "))).toBe(true);
  });

  it("#4 the backward scan crosses a line longer than its step (20 MB) and ends", () => {
    const dir = tmp();
    const path = join(dir, "big.jsonl");
    const bigHuman = JSON.stringify({ type: "user", timestamp: iso(100), message: { role: "user", content: `question ${"q".repeat(20 * 1024 * 1024)}` } });
    writeFileSync(path, `${bigHuman}\n${JSON.stringify({ type: "assistant", timestamp: iso(110), message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })}\n`);
    const t0 = performance.now();
    expect(currentTurnStart(path)).toBe(0);
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it("#5 a command record followed by a line larger than the read bound does not stall a stream", () => {
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      command("/review", "the diff", 100),
      toolResult("t1", "r".repeat(8000), 101),
      assistant("done", 102),
    ]);
    const seen: string[] = [];
    const end = streamLines(path, 0, l => { seen.push(l.kind); }, { maxBytes: 1024, deadline: deadlineAfter(monoNow(), duration(3000)) });
    expect(end.expired).toBe(false);
    expect(end.eof).toBe(true);
    expect(seen.length).toBe(3);
  });

  it("#6 a mirror takes a newer provisional revision even when the clock stepped back between them", async () => {
    const general = createTestStore();
    const vault = createTestStore();
    const v1 = seedDoc(vault, "skills", "tools/linter.md", "Linter configuration guide");
    const v2 = seedDoc(vault, "skills", "tools/formatter.md", "Formatter configuration guide");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [ocMessage("user", "how do we lint and format", 100), ocMessage("assistant", "skills/tools/linter.md first.", 110)]);
    registerTranscript(general.db, "s", path, "openclaw", null);
    const u = usageRow(general, "s", 99, "how do we lint and format", path, "openclaw");
    applySurfacingBookkeeping(general, manifestJob(u, "s", [
      { vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide", docId: v1 },
      { vault: "skills", displayPath: "skills/tools/formatter.md", title: "Formatter configuration guide", docId: v2 },
    ]), { resolveVaultStore: () => vault });
    const vaults = [{ name: "skills", store: vault }];
    ageFile(path, 11 * MIN);
    await tick(general, vaults);
    expect(accessOf(vault, v1)).toBe(1);
    const mirror = (vault.db.prepare(`SELECT id FROM context_usage`).get() as { id: number }).id;
    // The mirror's last write carries a later wall-clock time than the general row's next revision will.
    vault.db.prepare(`UPDATE feedback_turns SET updated_at = '2099-01-01T00:00:00.000Z' WHERE usage_id = ?`).run(mirror);
    appendEntries(path, [ocMessage("assistant", "Then skills/tools/formatter.md.", 120)]);
    ageFile(path, 11 * MIN);
    await tick(general, vaults);
    expect(accessOf(vault, v2)).toBe(1);
    expect(accessOf(vault, v1)).toBe(1);
  });
});

describe("T26 only a Stop ends a turn, finalization moves the revision, oversized local output still classifies", () => {
  const toolHookSummary = (label: string, t: number) => ({ ...stopMarker(t), hookLabel: label });

  it("#1 PreToolUse / PostToolUse hook summaries do not close a turn; the Stop's summary does", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const b = seedDoc(store, "notes", "b/beta.md", B.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      human("question about alpha and beta", 100),
      assistant("Starting with a/alpha.md.", 110, [{ id: "tu1", name: "Bash", input: { command: "make" } }]),
      toolHookSummary("PreToolUse", 111), toolResult("tu1", "ok", 112), toolHookSummary("PostToolUse", 113),
    ]);
    registerTranscript(store.db, "s", path, "claude-code", null);
    const u = usageRow(store, "s", 101, "question about alpha and beta", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }, { ...B, docId: b }]));
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(turnState(store, u)!.state).toBe("pending");
    appendEntries(path, [assistant("Per b/beta.md it is done.", 120), stopMarker(121)]);
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(turnState(store, u)).toEqual({ state: "attributed", reason: null });
    expect([accessOf(store, a), accessOf(store, b)]).toEqual([1, 1]);
  });

  it("#1 a marker before any assistant line closes neither the feedback turn nor the handoff's trailing turn", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", A.title);
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("question about alpha", 100), stopMarker(101)]);
    registerTranscript(store.db, "s", path, "claude-code", null);
    const u = usageRow(store, "s", 101, "question about alpha", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ ...A, docId: a }]));
    ageFile(path, 11 * MIN);
    await tick(store);
    expect(turnState(store, u)!.state).toBe("pending");
    // The tick's catch-up digested it provisionally (not complete: nothing answered it): the cursor stays at its start.
    runHandoffDigests(store, { sessionId: "s", transcriptPath: path, atStop: false });
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM stop_items WHERE kind = 'turn-digest'`).get() as { n: number }).n).toBe(1);
    const c = readStopCursor(store.db, "s", HANDOFF_HOOK, transcriptKey(path))!;
    expect(c.byteOffset).toBe(0);
  });

  it("#2 a provisional mirror becomes final when its transcript disappears", async () => {
    const general = createTestStore();
    const vault = createTestStore();
    const v = seedDoc(vault, "skills", "tools/linter.md", "Linter configuration guide");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [ocMessage("user", "how do we lint", 100), ocMessage("assistant", "skills/tools/linter.md is strict.", 110)]);
    registerTranscript(general.db, "s", path, "openclaw", null);
    const u = usageRow(general, "s", 99, "how do we lint", path, "openclaw");
    applySurfacingBookkeeping(general, manifestJob(u, "s", [{ vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide", docId: v }]),
      { resolveVaultStore: () => vault });
    const vaults = [{ name: "skills", store: vault }];
    ageFile(path, 11 * MIN);
    await tick(general, vaults);
    const mirror = (vault.db.prepare(`SELECT id FROM context_usage`).get() as { id: number }).id;
    expect(turnState(vault, mirror)).toEqual({ state: "attributed", reason: "provisional" });
    rmSync(path);
    await tick(general, vaults);
    expect(turnState(general, u)).toEqual({ state: "attributed", reason: null });
    expect(turnState(vault, mirror)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(vault, v)).toBe(1);
  });

  it("#3 a built-in command followed by oversized local-command output stays metadata, inside a read and at its bound", () => {
    const big = { type: "user", timestamp: iso(101), message: { role: "user", content: `<local-command-stdout>${"m".repeat(6000)}</local-command-stdout>` } };
    const path = writeTranscriptFile(tmp(), "s.jsonl", [command("/model", "sonnet", 100), big as any, human("real question", 200)]);
    // Inside one read: the oversized line is passed over, its kept prefix still classifies the command.
    const inRead = readLines(path, 0, { maxBytes: 4096 }).lines;
    expect(inRead[0]!.kind).toBe("meta");
    // At the read's bound (the command is the read's last line): the peek classifies it the same way.
    const commandLen = (JSON.stringify(command("/model", "sonnet", 100)) + "\n").length;
    const atBound = readLines(path, 0, { maxBytes: commandLen + 10 });
    expect(atBound.lines.map(l => l.kind)).toEqual(["meta"]);
    expect(atBound.next).toBeGreaterThan(0);
  });
});

void T0;
