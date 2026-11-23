/**
 * 62.1 D3: replay of quarantined ranges — backoff, lease, integrity, source time (design tests 8, 22, 23, 30, 31).
 *
 * Baseline (8e2579a): a failed observer call is committed as "no observations" and never retried; there is no range
 * identity, so nothing could verify a later retry reads the same bytes, and nothing orders a late decision behind the
 * ones written after it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { canonicalDocId, DEFAULT_EMBED_MODEL, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { decisionExtractor } from "../../src/hooks/decision-extractor.ts";
import { replayDueRetries } from "../../src/stop-extract.ts";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { T0, iso, human, assistant, writeTranscriptFile, appendEntries } from "./stop-fixtures.ts";

import { seedContent } from "../helpers/seed-content.ts";
let failTurns = new Set<string>();
let observerPrompts: string[] = [];
let judgeHits = 0;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async () => {
      judgeHits++;
      return Response.json({ choices: [{ message: { content: JSON.stringify([{ new_idx: 0, old_idx: 0, relation: "contradiction", confidence: 0.9, reasoning: "The new decision reverses the earlier runtime choice." }]) }, finish_reason: "stop" }], model: "test-judge" });
    },
  });
});
afterAll(() => server.stop(true));

const ENV = ["CLAWMEM_JUDGE_URL", "CLAWMEM_JUDGE_PROVIDER", "CLAWMEM_JUDGE_MODEL", "CLAWMEM_CAUSAL_WRITER"];
let saved: Record<string, string | undefined>;
const dirs: string[] = [];
beforeEach(() => {
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  delete process.env.CLAWMEM_CAUSAL_WRITER;
  for (const k of ["CLAWMEM_JUDGE_URL", "CLAWMEM_JUDGE_PROVIDER", "CLAWMEM_JUDGE_MODEL"]) delete process.env[k];
  failTurns = new Set();
  observerPrompts = [];
  judgeHits = 0;
  setDefaultLlamaCpp({
    generate: async (prompt: string) => {
      if (!prompt.includes("Extract observations:")) return { text: "", model: "fake", done: true };
      observerPrompts.push(prompt);
      const section = prompt.slice(prompt.indexOf("--- TRANSCRIPT ---"));
      const turns = [...new Set([...section.matchAll(/question for turn (\d+)/g)].map(m => m[1]!))];
      if (turns.some(n => failTurns.has(n))) return null;
      return {
        text: turns.map(n => `<observation><type>decision</type><title>Decision for turn ${n}</title><facts><fact>Turn ${n} adopted bun as the build runtime</fact></facts><narrative>n</narrative></observation>`).join("\n"),
        model: "fake", done: true,
      };
    },
    embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: DEFAULT_EMBED_MODEL }),
    rerank: async () => ({ results: [] }),
  } as any);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setDefaultLlamaCpp(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-621-replay-")); dirs.push(d); return d; }
const deadline = () => deadlineAfter(monoNow(), duration(30_000));
const turn = (n: number, t: number) => [human(`question for turn ${n}`, t), assistant(`For turn ${n} we decided to adopt bun as the build runtime, replacing node.`, t + 5)];
const obsTitles = (store: Store) => (store.db.prepare(`SELECT title FROM documents WHERE path LIKE 'observations/%' AND active = 1 ORDER BY id`).all() as { title: string }[]).map(r => r.title);
const retryState = (store: Store) => (store.db.prepare(`SELECT state FROM stop_retries`).all() as { state: string }[]).map(r => r.state);
const makeDue = (store: Store) => store.db.prepare(`UPDATE stop_retries SET next_retry_at = '2000-01-01T00:00:00.000Z'`).run();

/** Turns 1..3 across three Stops with turn 2's extraction failing: one quarantined range. */
async function quarantinedSession(store: Store): Promise<string> {
  const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
  await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
  failTurns.add("2");
  appendEntries(path, turn(2, 200));
  await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
  failTurns.clear();
  appendEntries(path, turn(3, 300));
  await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
  return path;
}

describe("D3 a quarantined range is retried after its backoff (test 8)", () => {
  it("the retry commits once and its items render in transcript order; nothing is dropped meanwhile", async () => {
    const store = createTestStore();
    await quarantinedSession(store);
    expect(retryState(store)).toEqual(["queued"]);
    expect(obsTitles(store)).toEqual(["Decision for turn 1", "Decision for turn 3"]);
    expect((await replayDueRetries(store, { deadline: deadline() })).replayed).toBe(0);   // not due yet
    makeDue(store);
    const r = await replayDueRetries(store, { deadline: deadline() });
    expect(r.replayed).toBe(1);
    expect(retryState(store)).toEqual(["done"]);
    expect(obsTitles(store)).toContain("Decision for turn 2");
    const body = (store.db.prepare(`SELECT c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.path LIKE 'decisions/%'`).get() as { body: string }).body;
    expect(body.indexOf("Decision for turn 1")).toBeLessThan(body.indexOf("Decision for turn 2"));
    expect(body.indexOf("Decision for turn 2")).toBeLessThan(body.indexOf("Decision for turn 3"));
  });

  it("a Stop of the session replays one due range itself", async () => {
    const store = createTestStore();
    const path = await quarantinedSession(store);
    makeDue(store);
    appendEntries(path, turn(4, 400));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(retryState(store)).toEqual(["done"]);
    expect(obsTitles(store)).toContain("Decision for turn 2");
  });
});

describe("D3 integrity and leases (tests 31, 22)", () => {
  it("a range whose bytes changed while it waited is marked unavailable and nothing is processed (test 31)", async () => {
    const store = createTestStore();
    const path = await quarantinedSession(store);
    writeFileSync(path, readFileSync(path, "utf8").replace("question for turn 2", "question for turn 9"));
    makeDue(store);
    const before = observerPrompts.length;
    expect((await replayDueRetries(store, { deadline: deadline() })).unavailable).toBe(1);
    expect(retryState(store)).toEqual(["unavailable"]);
    expect(observerPrompts.length).toBe(before);
  });

  it("an item whose claimant died is reclaimed after its lease and committed once; racing processors commit once (test 22)", async () => {
    const store = createTestStore();
    await quarantinedSession(store);
    store.db.prepare(`UPDATE stop_retries SET state = 'claimed', claim_token = 'dead-claimant', lease_expires_at = '2000-01-01T00:00:00.000Z'`).run();
    const [a, b] = await Promise.all([
      replayDueRetries(store, { deadline: deadline() }),
      replayDueRetries(store, { deadline: deadline() }),
    ]);
    expect(a.replayed + b.replayed).toBe(1);
    expect(obsTitles(store).filter(t => t === "Decision for turn 2").length).toBe(1);
    expect(retryState(store)).toEqual(["done"]);
  });
});

describe("D3 a replay keeps its source time (tests 23, 30)", () => {
  function judgeOn() {
    process.env.CLAWMEM_JUDGE_URL = `http://127.0.0.1:${server.port}`;
    process.env.CLAWMEM_JUDGE_PROVIDER = "openai";
    process.env.CLAWMEM_JUDGE_MODEL = "test-judge";
  }
  function conflictingDecision(store: Store, created: string, modified: string): number {
    const path = "decisions/2026-09-30-othersess.md";
    const body = "The team adopted node as the build runtime.";
    const hash = createHash("sha256").update(body).digest("hex");
    seedContent(store.db, hash, body, created);
    store.insertDocument("_clawmem", path, "Decisions", hash, created, modified);
    const id = store.findActiveDocument("_clawmem", path)!.id;
    store.db.prepare(`UPDATE documents SET content_type = 'decision', confidence = 0.8, created_at = ?, modified_at = ? WHERE id = ?`).run(created, modified, id);
    (store as any).ensureVecTable(4);
    (store as any).insertEmbedding(hash, 0, 0, new Float32Array([1, 0, 0, 0]), DEFAULT_EMBED_MODEL, created, "full", undefined, canonicalDocId("_clawmem", path));
    return id;
  }
  const conf = (store: Store, id: number) => (store.db.prepare(`SELECT confidence FROM documents WHERE id = ?`).get(id) as { confidence: number }).confidence;

  it("a replayed decision never erodes a later one, and its observation is authored at its source time (test 23)", async () => {
    const store = createTestStore();
    await quarantinedSession(store);
    judgeOn();
    const later = conflictingDecision(store, iso(3_600_000), iso(3_600_000));   // written after turn 2's source time
    makeDue(store);
    await replayDueRetries(store, { deadline: deadline() });
    expect(conf(store, later)).toBeCloseTo(0.8, 6);
    expect(judgeHits).toBe(0);
    const authored = (store.db.prepare(`SELECT authored_at FROM documents WHERE title = 'Decision for turn 2'`).get() as { authored_at: string }).authored_at;
    expect(authored).toBe(iso(200));
  });

  it("the replay judge skips a candidate revised after the source time; one older and unrevised is judged", async () => {
    const store = createTestStore();
    await quarantinedSession(store);
    judgeOn();
    const revised = conflictingDecision(store, iso(0), iso(3_600_000));
    makeDue(store);
    await replayDueRetries(store, { deadline: deadline() });
    expect(judgeHits).toBe(0);
    expect(conf(store, revised)).toBeCloseTo(0.8, 6);

    const store2 = createTestStore();
    await quarantinedSession(store2);
    judgeOn();
    const older = conflictingDecision(store2, iso(0), iso(0));
    makeDue(store2);
    await replayDueRetries(store2, { deadline: deadline() });
    expect(judgeHits).toBe(1);
    expect(conf(store2, older)).toBeCloseTo(0.55, 6);
  });

  it("the replay's CONTEXT lists only observation titles recorded by its source time (test 30)", async () => {
    const store = createTestStore();
    await quarantinedSession(store);
    // Backdate turn 1's observation to before the source time; turn 3's stays after it.
    store.db.prepare(`UPDATE documents SET created_at = ? WHERE title = 'Decision for turn 1'`).run(iso(150));
    store.db.prepare(`UPDATE documents SET created_at = ? WHERE title = 'Decision for turn 3'`).run(iso(350));
    makeDue(store);
    observerPrompts = [];
    await replayDueRetries(store, { deadline: deadline() });
    const p = observerPrompts[0]!;
    const ctx = p.slice(p.indexOf("CONTEXT (already recorded"), p.indexOf("--- TRANSCRIPT ---"));
    expect(ctx).toContain("Decision for turn 1");
    expect(ctx).not.toContain("Decision for turn 3");
    expect(T0).toBeGreaterThan(0);
  });
});
