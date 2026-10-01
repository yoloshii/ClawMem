/**
 * v0.41.2 (BACKLOG 68.5) — windows and durable checkpoints in the Stop pipeline (DESIGN-v0412.md §1.4; tests T3c, T4,
 * T15, T16, T17, T21, T22, plus the checkpoint transitions and the orphan sweep).
 *
 * Baseline (v0.41.1, prod 2026-10-01): a unit's prompt was cut to 8,000 characters and sent once; on the documented
 * `-c 4096` a dense turn filled 4,072 of 4,096 tokens, the reply was cut, and the range was held forever — every
 * retry the same size. These assert that a unit too large for one prompt is extracted in windows, that progress
 * survives between invocations in a checkpoint, and that continuations never count as failures.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setDefaultLlamaCpp, LlamaCpp } from "../../src/llm.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { fakeBudgetLlm } from "../helpers/fake-budget-llm.ts";
import { runDecisionExtraction, replayDueRetries } from "../../src/stop-extract.ts";
import { runStopWorkerTick } from "../../src/stop-worker.ts";
import {
  readCheckpoint, createCheckpoint, swapCheckpoint, finishCheckpoint, liveCheckpoint, checkpointKey, sweepCheckpoints, CHECKPOINT_PREFIX,
} from "../../src/stop-checkpoint.ts";
import { monoNow, deadlineAfter, duration, epochNow, epochMs } from "../../src/clock.ts";
import { extractObservationsWindowed } from "../../src/observer.ts";
import { human, assistant, toolResult, writeTranscriptFile, appendEntries, type Entry } from "./stop-fixtures.ts";
import type { Store } from "../../src/store.ts";

const SID = "sess-v0412-a";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "clawmem-ckpt-")); });
afterEach(() => { setDefaultLlamaCpp(null); rmSync(dir, { recursive: true, force: true }); });

/** One turn with `tools` tool calls — far more than one 4,096-token window holds. */
function bigTurn(k: number, tools: number): Entry[] {
  const out: Entry[] = [human(`question for turn ${k}: index the archive`, k * 100_000)];
  for (let j = 0; j < tools; j++) {
    out.push(assistant("", k * 100_000 + j * 10 + 1, [{ id: `tu-${k}-${j}`, name: "Read", input: { file_path: `/repo/file${j}.ts` } }]));
    out.push(toolResult(`tu-${k}-${j}`, `contents of file${j} ` + "lorem ipsum dolor sit amet ".repeat(15), k * 100_000 + j * 10 + 2));
  }
  out.push(assistant(`Turn ${k} is done: the archive is indexed and every file was read.`, k * 100_000 + 99_999));
  return out;
}

/** One observation per window, named for the first file the window's transcript shows. */
function windowReply(prompt: string) {
  if (!prompt.includes("Extract observations:")) return "";
  const t = prompt.slice(prompt.indexOf("--- TRANSCRIPT ---"));
  const first = t.match(/file(\d+)/)?.[1] ?? "none";
  return `<observation><type>discovery</type><title>Window from file ${first}</title><facts><fact>file ${first} was read in the window</fact></facts><narrative>n</narrative></observation>`;
}

const ckpts = (store: Store) =>
  (store.db.prepare(`SELECT flag, value FROM vault_flags WHERE flag LIKE ?`).all(`${CHECKPOINT_PREFIX}%`) as { flag: string; value: string }[])
    .map(r => ({ flag: r.flag, ...(JSON.parse(r.value) as { state: string; doneThroughLine: number; rev: number }) }));
const retries = (store: Store) =>
  store.db.prepare(`SELECT id, attempts, state, last_error FROM stop_retries ORDER BY id`).all() as { id: number; attempts: number; state: string; last_error: string }[];
const windowDocs = (store: Store) =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE collection = '_clawmem' AND active = 1 AND title LIKE 'Window from file%'`).get() as { n: number }).n;
const makeDue = (store: Store) => store.db.prepare(`UPDATE stop_retries SET next_retry_at = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'`).run();
const replay = (store: Store, calls = 1) =>
  replayDueRetries(store, { deadline: deadlineAfter(monoNow(), duration(60_000)), limit: 1, observerMaxCalls: calls });

describe("v0.41.2 a unit too large for one prompt: windows, checkpoints, continuations", () => {
  it("cut off by the call budget → a continuation (attempts 0); each replay resumes its checkpoint; it completes once (T4)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    const run = await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    expect(run.quarantined).toBe(1);
    expect(run.committed).toBe(0);
    let [row] = retries(store);
    expect(row!.attempts).toBe(0);
    expect(row!.last_error).toMatch(/^continuation: \d+\/\d+ lines$/);
    let [c] = ckpts(store);
    expect(c!.state).toBe("live");
    const first = c!.doneThroughLine;
    expect(first).toBeGreaterThan(0);

    for (let i = 0; i < 20 && retries(store)[0]!.state !== "done"; i++) {
      makeDue(store);
      await replay(store, 1);
      row = retries(store)[0];
      expect(row!.attempts).toBe(0);   // a continuation is never a failure
      c = ckpts(store)[0];
      if (row!.state !== "done") expect(c!.doneThroughLine).toBeGreaterThan(first);
    }
    expect(retries(store)[0]!.state).toBe("done");
    expect(ckpts(store)[0]!.state).toBe("done");          // the terminal Phase B tombstoned it
    const windows = fake.calls.filter(x => x.prompt.includes("Extract observations:")).length;
    expect(windows).toBeGreaterThan(2);
    expect(windowDocs(store)).toBe(windows);               // every window's observation, committed once
    for (const x of fake.calls) expect(x.promptTokens + 1638).toBeLessThanOrEqual(4096);
  });

  it("a checkpoint written under another contract is reset, then the unit completes (T4)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const [c] = ckpts(store);
    const raw = (store.db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(c!.flag) as { value: string }).value;
    store.db.prepare(`UPDATE vault_flags SET value = ? WHERE flag = ?`).run(raw.replace(/"contract":"[0-9a-f]+"/, `"contract":"other"`), c!.flag);
    makeDue(store);
    await replay(store, 6);
    for (let i = 0; i < 10 && retries(store)[0]!.state !== "done"; i++) { makeDue(store); await replay(store, 6); }
    expect(retries(store)[0]!.state).toBe("done");
    expect(retries(store)[0]!.attempts).toBe(0);
  });

  it("two sessions with byte-identical transcripts keep separate checkpoints (T15)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const a = writeTranscriptFile(dir, "a.jsonl", bigTurn(1, 40));
    const b = writeTranscriptFile(dir, "b.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: "sess-one", transcriptPath: a, observerMaxCalls: 1 });
    await runDecisionExtraction(store, { sessionId: "sess-two", transcriptPath: b, observerMaxCalls: 2 });
    const all = ckpts(store);
    expect(all.length).toBe(2);
    expect(new Set(all.map(x => x.flag)).size).toBe(2);
    expect(all.find(x => x.flag.includes("sess-one|"))!.doneThroughLine)
      .toBeLessThan(all.find(x => x.flag.includes("sess-two|"))!.doneThroughLine);
  });

  it("a range another processor committed (its tombstone) ends the replay as done, with no second set of effects (T16)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const [c] = ckpts(store);
    const v = JSON.parse((store.db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(c!.flag) as { value: string }).value);
    finishCheckpoint(store.db, c!.flag, { sessionId: v.sessionId, transcriptKey: v.transcriptKey, hook: v.hook, range: { ...v.range, key: "k" } });
    const before = windowDocs(store);
    makeDue(store);
    await replay(store, 6);
    expect(retries(store)[0]!.state).toBe("done");
    expect(retries(store)[0]!.last_error).toContain("committed by another processor");
    expect(windowDocs(store)).toBe(before);
  });

  it("a checkpoint whose backend is unreachable defers: attempts unchanged, no reset, no progress lost (T22)", async () => {
    let up = true;
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096, available: () => up });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const done = ckpts(store)[0]!.doneThroughLine;
    up = false;
    makeDue(store);
    await replay(store, 6);
    const [row] = retries(store);
    expect(row!.state).toBe("queued");
    expect(row!.attempts).toBe(0);
    expect(row!.last_error).toContain("backend is unavailable");
    expect(ckpts(store)[0]!.doneThroughLine).toBe(done);
    up = true;
    for (let i = 0; i < 10 && retries(store)[0]!.state !== "done"; i++) { makeDue(store); await replay(store, 6); }
    expect(retries(store)[0]!.state).toBe("done");
  });

  it("units that each fail at once with `capacity:` write exactly ONE retry row; the cursor stops just past it (T21)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 1500 });   // the system prompt alone exceeds B
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    // A transcript's first Stop anchors at its current turn: anchor on a turn with nothing to extract (no model call),
    // then append three turns of 82 messages each — two pass the 100-message batch bound, so each is its own unit.
    const path = writeTranscriptFile(dir, "t.jsonl", [human("hello", 1), assistant("hi", 2)]);
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path });
    expect(retries(store).length).toBe(0);
    appendEntries(path, [...bigTurn(1, 40), ...bigTurn(2, 40), ...bigTurn(3, 40)]);
    const run = await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path });
    const rows = retries(store);
    expect(rows.length).toBe(1);
    expect(rows[0]!.last_error).toMatch(/^capacity: /);
    expect(rows[0]!.attempts).toBe(1);
    expect(run.batches).toBe(1);
    expect(run.quarantined).toBe(1);
    expect(fake.calls.length).toBe(0);   // no model call was made
    const cursorAt = (store.db.prepare(`SELECT byte_offset FROM stop_cursors WHERE session_id = ?`).get(SID) as { byte_offset: number }).byte_offset;
    expect(cursorAt).toBe((store.db.prepare(`SELECT to_offset FROM stop_retries`).get() as { to_offset: number }).to_offset);
    expect(cursorAt).toBeLessThan(statSync(path).size);   // the turns after the held unit wait for the next Stop
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path });
    expect(retries(store).length).toBe(2);                // the next Stop holds the next unit, again only one
  });

  it("the worker runs a due continuation FIRST, ahead of an older failed row (T17)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const done = ckpts(store)[0]!.doneThroughLine;
    // An older failed row of another range, due before the continuation.
    store.db.prepare(
      `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha,
         attempts, last_error, first_failed_at, next_retry_at, state)
       VALUES ('sess-old', 'tk-old', 'decision-extractor', '/nonexistent.jsonl', 0, 0, 10, 'old-key', 'old-sha', 1, 'model unavailable',
         '1999-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z', 'queued')`
    ).run();
    makeDue(store);
    store.db.prepare(`UPDATE stop_retries SET next_retry_at = '1999-01-01T00:00:00.000Z' WHERE range_key = 'old-key'`).run();
    await runStopWorkerTick(store, [], fake.llm as any, { deadline: deadlineAfter(monoNow(), duration(60_000)), limits: { replays: 0 } });
    expect(ckpts(store)[0]!.doneThroughLine > done || retries(store).find(r => r.last_error?.startsWith("continuation"))?.state === "done"
      || retries(store).some(r => r.state === "done")).toBe(true);
    expect(retries(store).find(r => r.last_error === "model unavailable")!.state).toBe("queued");   // untouched
  });

  it("equal observation bodies from two windows become ONE document carrying both windows' triples (T3c)", async () => {
    let n = 0;
    const fake = fakeBudgetLlm({
      nCtx: 4096,
      reply: (prompt) => {
        if (!prompt.includes("Extract observations:")) return "";
        n++;
        const subject = n % 2 ? "archive indexer" : "file reader";
        return `<observation><type>discovery</type><title>The archive is indexed</title><facts><fact>The archive was indexed file by file</fact></facts><narrative>n</narrative><triples><triple><subject>${subject}</subject><predicate>uses</predicate><object>bun runtime</object></triple></triples></observation>`;
      },
    });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 20));
    const run = await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 20 });
    expect(run.committed).toBe(1);
    expect(n).toBeGreaterThan(1);
    const docs = store.db.prepare(`SELECT id FROM documents WHERE collection = '_clawmem' AND active = 1 AND title = 'The archive is indexed'`).all() as { id: number }[];
    expect(docs.length).toBe(1);
    expect(run.observations.length).toBe(1);
    expect(run.observations[0]!.triples?.length).toBe(2);
  });
});

describe("v0.41.2 checkpoint transitions (stop-checkpoint.ts)", () => {
  const base = () => liveCheckpoint({
    rev: 1, sessionId: "s", transcriptKey: "tk", hook: "decision-extractor", range: { anchorEpoch: 0, from: 0, to: 10, sha: "abc" },
    linesSha: "l", contract: "c", backend: { kind: "remote", root: "http://x" }, fingerprint: "f", fingerprintStrength: "strong",
    doneThroughLine: 0, observations: [], titles: [],
  });

  it("create is INSERT OR IGNORE; an advance needs the exact stored value; a tombstone cannot be replaced or advanced", () => {
    const store = createTestStore();
    const key = checkpointKey("s", "tk", "decision-extractor", "rk");
    const raw1 = createCheckpoint(store.db, key, base());
    expect(raw1).not.toBeNull();
    expect(createCheckpoint(store.db, key, base())).toBeNull();
    const raw2 = swapCheckpoint(store.db, key, raw1!, { ...base(), rev: 2, doneThroughLine: 5 });
    expect(raw2).not.toBeNull();
    expect(swapCheckpoint(store.db, key, raw1!, { ...base(), rev: 2, doneThroughLine: 3 })).toBeNull();   // a stale writer
    finishCheckpoint(store.db, key, { sessionId: "s", transcriptKey: "tk", hook: "decision-extractor", range: { anchorEpoch: 0, from: 0, to: 10, sha: "abc", key: "rk" } });
    expect(readCheckpoint(store.db, key)!.value!.state).toBe("done");
    expect(swapCheckpoint(store.db, key, raw2!, { ...base(), rev: 3, doneThroughLine: 9 })).toBeNull();
    expect(createCheckpoint(store.db, key, base())).toBeNull();
  });

  it("the sweep removes orphans only: a queued range, a cursor short of the range, a young first Stop and a fresh tombstone stay", () => {
    const store = createTestStore();
    const NOW = "2026-10-01T12:00:00.000Z";
    const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
    const HOUR = 60 * 60_000;
    const range = { anchorEpoch: 0, from: 0, to: 10, sha: "abc" };
    const put = (sid: string, opts: { state?: "live" | "done"; at: string }) => {
      const key = checkpointKey(sid, "tk", "decision-extractor", "rk");
      const c = { ...base(), sessionId: sid, state: opts.state ?? "live", at: opts.at };
      store.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)`).run(key, JSON.stringify(c), opts.at);
      return key;
    };
    const cursor = (sid: string, byteOffset: number, anchorEpoch = 0) => store.db.prepare(
      `INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, first_line_sha, anchor_epoch, byte_offset, tail_sha, human_turns)
       VALUES (?, 'decision-extractor', 'tk', '/t.jsonl', 'f', ?, ?, 't', 1)`
    ).run(sid, anchorEpoch, byteOffset);
    const queue = (sid: string) => store.db.prepare(
      `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha,
         attempts, last_error, first_failed_at, next_retry_at, state)
       VALUES (?, 'tk', 'decision-extractor', '/t.jsonl', 0, ?, ?, 'rk', ?, 0, 'continuation: 3/9 lines', ?, ?, 'queued')`
    ).run(sid, range.from, range.to, range.sha, NOW, NOW);

    const held = put("held", { at: ago(30 * 24 * HOUR) }); cursor("held", 50); queue("held");
    const passed = put("passed", { at: NOW }); cursor("passed", 10);
    const reanchored = put("reanchored", { at: NOW }); cursor("reanchored", 0, 1);
    const short = put("short", { at: ago(30 * 24 * HOUR) }); cursor("short", 5);
    const youngFirst = put("young-first", { at: ago(6 * 24 * HOUR) });
    const oldFirst = put("old-first", { at: ago(8 * 24 * HOUR) });
    const freshTomb = put("fresh-tomb", { state: "done", at: ago(30 * 60_000) });
    const oldTomb = put("old-tomb", { state: "done", at: ago(2 * HOUR) });
    const malformed = checkpointKey("malformed", "tk", "decision-extractor", "rk");
    store.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, '{not json', ?)`).run(malformed, ago(30 * 24 * HOUR));

    expect(sweepCheckpoints(store.db, Date.parse(NOW))).toBe(4);
    const left = new Set((store.db.prepare(`SELECT flag FROM vault_flags WHERE flag LIKE ?`).all(`${CHECKPOINT_PREFIX}%`) as { flag: string }[]).map(r => r.flag));
    for (const k of [held, short, youngFirst, freshTomb, malformed]) expect(left.has(k)).toBe(true);
    for (const k of [passed, reanchored, oldFirst, oldTomb]) expect(left.has(k)).toBe(false);
  });
});

describe("v0.41.2 codex T11 regressions — checkpoints, the worker, the sweep", () => {
  it("a /props that does not answer before a resume DEFERS the checkpoint (progress kept); the range completes once it does (T11-3)", async () => {
    let propsUp = true;
    const fake = fakeBudgetLlm({
      reply: windowReply, nCtx: 4096, fingerprint: () => (propsUp ? "fp-1" : "weak-fp"), strength: () => (propsUp ? "strong" : "weak"),
    });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const done = ckpts(store)[0]!.doneThroughLine;
    expect(done).toBeGreaterThan(0);
    propsUp = false;
    makeDue(store);
    await replay(store, 6);
    const [row] = retries(store);
    expect(row!.state).toBe("queued");
    expect(row!.attempts).toBe(0);
    expect(row!.last_error).toContain("could not be verified");
    expect(ckpts(store)[0]!.doneThroughLine).toBe(done);   // no reset: the windows already done stay done
    propsUp = true;
    for (let i = 0; i < 10 && retries(store)[0]!.state !== "done"; i++) { makeDue(store); await replay(store, 6); }
    expect(retries(store)[0]!.state).toBe("done");
  });

  it("an expired claim on a continuation still gets the worker's FIRST slice (T11-5)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const done = ckpts(store)[0]!.doneThroughLine;
    // A worker took the row and died: claimed, its lease long expired, not otherwise due.
    store.db.prepare(`UPDATE stop_retries SET state = 'claimed', claim_token = 'dead', lease_expires_at = '2000-01-01T00:00:00.000Z',
      next_retry_at = '2999-01-01T00:00:00.000Z'`).run();
    await runStopWorkerTick(store, [], fake.llm as any, { deadline: deadlineAfter(monoNow(), duration(60_000)), limits: { replays: 0 } });
    expect(retries(store)[0]!.state === "done" || ckpts(store)[0]!.doneThroughLine > done).toBe(true);
  });

  it("the sweep reaches an orphan behind 200 older checkpoints that must stay (T11-6)", () => {
    const store = createTestStore();
    const NOW = "2026-10-01T12:00:00.000Z";
    const insert = (sid: string, at: string) => {
      const c = { ...liveCheckpoint({
        rev: 1, sessionId: sid, transcriptKey: "tk", hook: "decision-extractor", range: { anchorEpoch: 0, from: 0, to: 10, sha: "abc" },
        linesSha: "l", contract: "c", backend: { kind: "remote", root: "http://x" }, fingerprint: "f", fingerprintStrength: "strong",
        doneThroughLine: 0, observations: [], titles: [],
      } as any), at };
      store.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)`)
        .run(checkpointKey(sid, "tk", "decision-extractor", "rk"), JSON.stringify(c), at);
    };
    // 200 live checkpoints whose cursor has not reached their range: they stay.
    for (let i = 0; i < 200; i++) {
      const sid = `keep-${String(i).padStart(3, "0")}`;
      insert(sid, "2026-09-01T00:00:00.000Z");
      store.db.prepare(`INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, first_line_sha, anchor_epoch, byte_offset, tail_sha, human_turns)
        VALUES (?, 'decision-extractor', 'tk', '/t.jsonl', 'f', 0, 5, 't', 1)`).run(sid);
    }
    // One newer orphan: its cursor is past its range and nothing holds it.
    insert("zz-orphan", "2026-09-30T00:00:00.000Z");
    store.db.prepare(`INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, first_line_sha, anchor_epoch, byte_offset, tail_sha, human_turns)
      VALUES ('zz-orphan', 'decision-extractor', 'tk', '/t.jsonl', 'f', 0, 50, 't', 1)`).run();
    expect(sweepCheckpoints(store.db, Date.parse(NOW))).toBe(1);
    expect(store.db.prepare(`SELECT 1 FROM vault_flags WHERE flag = ?`).get(checkpointKey("zz-orphan", "tk", "decision-extractor", "rk"))).toBeNull();
  });

  it("a first-window fallback from the remote to the local backend keeps the run's call cap: at most 6 calls (T11-14)", async () => {
    const base = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    const remote = { kind: "remote", root: "http://fake-llm" } as const;
    const local = { kind: "local", modelPath: "/models/local.gguf" } as const;
    let remoteDown = false;
    let remoteCalls = 0;
    const llm = {
      ...base.llm,
      activeLlmBackend: () => (remoteDown ? local : remote),
      isConfiguredBackend: () => true,
      isBackendAvailable: (b: { kind: string }) => b.kind === "local" || !remoteDown,
      generateDetailed: async (prompt: string, o: { maxTokens: number; backend: { kind: string } }) => {
        if (o.backend.kind === "remote") { remoteCalls++; remoteDown = true; return { ok: false as const, reason: "unavailable" as const, backend: o.backend as any }; }
        return base.llm.generateDetailed(prompt, o as any);
      },
    };
    setDefaultLlamaCpp(llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path });
    expect(remoteCalls).toBe(1);
    expect(remoteCalls + base.calls.length).toBeLessThanOrEqual(6);
  });

  it("the Stop pipeline keeps the measured observer call time where the doctor can read it (T11-13)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 2 });
    const row = store.db.prepare(`SELECT value FROM vault_flags WHERE flag = 'observer_call_mean'`).get() as { value: string } | null;
    expect(row).not.toBeNull();
    const v = JSON.parse(row!.value) as { ms: number; samples: number };
    expect(v.samples).toBeGreaterThanOrEqual(1);
    expect(v.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("v0.41.2 codex T12 regressions — checkpoints, the sweep, the call mean", () => {
  const bareCheckpoint = (sid: string, anchorEpoch: number) => liveCheckpoint({
    rev: 1, sessionId: sid, transcriptKey: "tk", hook: "decision-extractor", range: { anchorEpoch, from: 0, to: 10, sha: "abc" },
    linesSha: "l", contract: "c", backend: { kind: "remote", root: "http://x" }, fingerprint: "f", fingerprintStrength: "strong",
    doneThroughLine: 3, observations: [], titles: [],
  } as any);

  it("the sweep matches a queued range by its FULL identity: a re-anchored epoch's range at the same offsets and bytes does not hold an old checkpoint (T12-3)", () => {
    const store = createTestStore();
    const NOW = "2026-10-01T12:00:00.000Z";
    const put = (anchorEpoch: number) => {
      const key = checkpointKey("s", "tk", "decision-extractor", `${anchorEpoch}-0-10-abc`);
      store.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)`).run(key, JSON.stringify({ ...bareCheckpoint("s", anchorEpoch), at: NOW }), NOW);
      return key;
    };
    const old = put(0);
    const current = put(1);
    // The transcript was re-anchored: the cursor is in epoch 1, and epoch 1's range — same offsets, same bytes — is queued.
    store.db.prepare(`INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, first_line_sha, anchor_epoch, byte_offset, tail_sha, human_turns)
      VALUES ('s', 'decision-extractor', 'tk', '/t.jsonl', 'f', 1, 10, 't', 1)`).run();
    store.db.prepare(`INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha,
        attempts, last_error, first_failed_at, next_retry_at, state)
      VALUES ('s', 'tk', 'decision-extractor', '/t.jsonl', 1, 0, 10, '1-0-10-abc', 'abc', 0, 'continuation: 3/9 lines', ?, ?, 'queued')`).run(NOW, NOW);
    expect(sweepCheckpoints(store.db, Date.parse(NOW))).toBe(1);
    const left = (store.db.prepare(`SELECT flag FROM vault_flags WHERE flag LIKE ?`).all(`${CHECKPOINT_PREFIX}%`) as { flag: string }[]).map(r => r.flag);
    expect(left).toEqual([current]);   // epoch 0's checkpoint went; epoch 1's, which the queued range owns, stays
    expect(left).not.toContain(old);
  });

  it("an unverified checkpoint WAITS however long ago it last progressed — no reset after an hour (T12-6)", async () => {
    let propsUp = true;
    const fake = fakeBudgetLlm({
      reply: windowReply, nCtx: 4096, fingerprint: () => (propsUp ? "fp-1" : "weak-fp"), strength: () => (propsUp ? "strong" : "weak"),
    });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const done = ckpts(store)[0]!.doneThroughLine;
    expect(done).toBeGreaterThan(0);
    const row = store.db.prepare(`SELECT flag, value FROM vault_flags WHERE flag LIKE ?`).get(`${CHECKPOINT_PREFIX}%`) as { flag: string; value: string };
    const twoHoursAgo = new Date(epochMs(epochNow()) - 2 * 60 * 60_000).toISOString();
    store.db.prepare(`UPDATE vault_flags SET value = ? WHERE flag = ?`).run(JSON.stringify({ ...JSON.parse(row.value), at: twoHoursAgo }), row.flag);
    propsUp = false;
    makeDue(store);
    await replay(store, 6);
    const [r] = retries(store);
    expect(r!.state).toBe("queued");
    expect(r!.attempts).toBe(0);
    expect(r!.last_error).toContain("could not be verified");
    expect(ckpts(store)[0]!.doneThroughLine).toBe(done);   // the windows done stay done
  });

  it("a completed window, then a `/props` answering HTML, 404 or the context alone, then the original `/props`: the unit waits, then resumes at its saved line (T13-1, T14-1)", async () => {
    // The real LlamaCpp against a fake llama-server, so the HTML, 404 and n_ctx-only answers go through the real reader.
    let props: "ok" | "html" | "404" | "nctx" = "ok";
    const prompts: string[] = [];
    const tok = (t: string) => Math.ceil(t.length / 3);
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/props") {
          if (props === "404") return new Response("nf", { status: 404 });
          if (props === "html") return new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
          if (props === "nctx") return Response.json({ default_generation_settings: { n_ctx: 4096 } });
          return Response.json({ default_generation_settings: { n_ctx: 4096 }, model_path: "/m/q.gguf", chat_template: "t", build_info: "b" });
        }
        if (path === "/apply-template") { const body = await req.json() as { messages: { content: string }[] }; return Response.json({ prompt: `<u>${body.messages[0]!.content}</u>` }); }
        if (path === "/tokenize") { const body = await req.json() as { content: string }; return Response.json({ tokens: new Array(tok(body.content)).fill(1) }); }
        if (path === "/v1/chat/completions") {
          const content = (await req.json() as { messages: { content: string }[] }).messages[0]!.content;
          prompts.push(content);
          return Response.json({
            choices: [{ message: { content: windowReply(content) }, finish_reason: "stop" }], model: "fake",
            usage: { prompt_tokens: tok(`<u>${content}</u>`), completion_tokens: 40 },
          });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const savedEnv = process.env.CLAWMEM_NO_LOCAL_MODELS;
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    try {
      setDefaultLlamaCpp(new LlamaCpp({ remoteLlmUrl: `http://127.0.0.1:${server.port}` }) as any);
      const store = createTestStore();
      const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
      await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
      const done = ckpts(store)[0]!.doneThroughLine;
      expect(done).toBeGreaterThan(0);
      for (const bad of ["html", "404", "nctx"] as const) {
        props = bad;
        makeDue(store);
        await replay(store, 6);
        expect(retries(store)[0]!.last_error).toContain("could not be verified");
        expect(ckpts(store)[0]!.doneThroughLine).toBe(done);   // kept, never reset
      }
      props = "ok";
      const before = prompts.length;
      makeDue(store);
      await replay(store, 1);
      expect(prompts.length).toBe(before + 1);
      const transcript = (p: string) => p.slice(p.indexOf("--- TRANSCRIPT ---"), p.indexOf("--- END TRANSCRIPT ---"));
      expect(transcript(prompts[before]!)).not.toContain("question for turn 1");   // it went on from its saved line, not from line 0
      const c = ckpts(store)[0]!;
      if (c.state === "live") expect(c.doneThroughLine).toBeGreaterThan(done);
    } finally {
      if (savedEnv === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS; else process.env.CLAWMEM_NO_LOCAL_MODELS = savedEnv;
      server.stop(true);
    }
  });

  it("a first Stop's checkpoint with no cursor: a repeated Stop that reads the same range resumes its saved window (T14-2)", async () => {
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", bigTurn(1, 40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const done = ckpts(store)[0]!.doneThroughLine;
    expect(done).toBeGreaterThan(0);
    // As if that first Stop had died after saving its window: no queued range, no cursor.
    store.db.prepare(`DELETE FROM stop_retries`).run();
    store.db.prepare(`DELETE FROM stop_cursors`).run();
    const before = fake.calls.length;
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    expect(fake.calls.length).toBe(before + 1);
    const transcript = (p: string) => p.slice(p.indexOf("--- TRANSCRIPT ---"), p.indexOf("--- END TRANSCRIPT ---"));
    expect(transcript(fake.calls[before]!.prompt)).not.toContain("question for turn 1");   // its saved window, not line 0
    expect(ckpts(store)[0]!.doneThroughLine).toBeGreaterThan(done);
  });

  it("the observer's call mean is the mean of its LATEST 50 calls — in the process, and in the record the doctor reads (T12-5)", async () => {
    const obs = await import("../../src/observer.ts") as Record<string, any>;
    const se = await import("../../src/stop-extract.ts") as Record<string, any>;
    obs.resetObserverCallStatsForTest();
    const store = createTestStore();
    const fake = fakeBudgetLlm({ reply: windowReply, nCtx: 4096 });
    let delayMs = 0;
    const llm = {
      ...fake.llm,
      generateDetailed: async (p: string, o: any) => { if (delayMs > 0) await Bun.sleep(delayMs); return fake.llm.generateDetailed(p, o); },
    };
    const B = { kind: "remote", root: "http://fake-llm" } as const;
    const oneCall = () => extractObservationsWindowed([{ role: "assistant", content: "Renamed the loader in file1.", turn: 0 }], {
      llm: llm as any, backend: B, deadline: deadlineAfter(monoNow(), duration(60_000)),
    });
    for (let i = 0; i < 50; i++) await oneCall();
    se.persistObserverCallMean(store.db);
    delayMs = 50;
    for (let i = 0; i < 50; i++) await oneCall();
    se.persistObserverCallMean(store.db);
    expect(obs.observerCallStats().samples).toBe(50);
    expect(obs.observerCallStats().meanMs).toBeGreaterThanOrEqual(45);   // the 50 fast calls have left the mean
    const v = JSON.parse((store.db.prepare(`SELECT value FROM vault_flags WHERE flag = 'observer_call_mean'`).get() as { value: string }).value);
    expect(v.samples).toBe(50);
    expect(v.ms).toBeGreaterThanOrEqual(45);
    obs.resetObserverCallStatsForTest();
  });
});
