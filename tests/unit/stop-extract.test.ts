/**
 * 62.1 D2-D4: decision-extractor reads each transcript range once, commits it once, and quarantines a failed one
 * (design tests 7, 8, 9, 10, 11, 16, 20).
 *
 * Baseline (8e2579a): every Stop re-reads the last 200 entries and calls the observer again over the whole window,
 * persists observations again, rewrites the session decisions document from that window only, overwrites or dedups
 * antipatterns across sessions, and maps an observer failure to [] — the failed turn is committed as empty.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { decisionExtractor } from "../../src/hooks/decision-extractor.ts";
import { transcriptKey } from "../../src/stop-pairing.ts";
import { human, assistant, writeTranscriptFile, appendEntries, lineStarts } from "./stop-fixtures.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "clawmem-621-extract-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  setDefaultLlamaCpp(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A fake observer: one decision per "turn N" in the NEW section; `fail(newSection)` → null (model unavailable). */
function fakeObserver(opts?: { fail?: (prompt: string) => boolean; delayMs?: number }) {
  const calls: string[] = [];
  setDefaultLlamaCpp({
    generate: async (prompt: string) => {
      if (!prompt.includes("Extract observations:")) return { text: "", model: "fake", done: true };
      calls.push(prompt);
      if (opts?.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      const section = prompt.slice(prompt.indexOf("--- TRANSCRIPT ---"));
      if (opts?.fail?.(section)) return null;   // judged on the NEW material only, never the CONTEXT
      const turns = [...new Set([...section.matchAll(/question for turn (\d+)/g)].map(m => m[1]))];
      return {
        text: turns.map(n =>
          `<observation><type>decision</type><title>Decision for turn ${n}</title><facts><fact>Turn ${n} decided to ship feature ${n}</fact></facts><narrative>Turn ${n} needed it.</narrative></observation>`
        ).join("\n"),
        model: "fake", done: true,
      };
    },
    embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: "fake" }),
  } as any);
  return calls;
}

const turn = (n: number, t: number) => [
  human(`question for turn ${n}`, t),
  assistant(`For turn ${n} we decided to ship feature ${n} after reviewing the options carefully.`, t + 5),
];

const observationDocs = (store: Store) =>
  (store.db.prepare(`SELECT title FROM documents WHERE collection = '_clawmem' AND path LIKE 'observations/%' AND active = 1 ORDER BY id`).all() as { title: string }[]).map(r => r.title);
const decisionsBody = (store: Store, sid: string) =>
  (store.db.prepare(`SELECT c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = '_clawmem' AND d.path LIKE ? AND d.active = 1`)
    .get(`decisions/%-${sid.slice(0, 8)}%`) as { body: string } | null)?.body ?? null;
const cursorOf = (store: Store, sid: string, path: string) =>
  store.db.prepare(`SELECT byte_offset, anchor_epoch FROM stop_cursors WHERE session_id = ? AND hook = 'decision-extractor' AND transcript_key = ?`)
    .get(sid, transcriptKey(path)) as { byte_offset: number; anchor_epoch: number } | null;

describe("D4 decision-extractor processes each range once (tests 7, 8, 10)", () => {
  it("a second Stop with no new turn calls nothing and writes nothing (test 7)", async () => {
    const calls = fakeObserver();
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(1, 100));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(calls.length).toBe(1);
    expect(observationDocs(store)).toEqual(["Decision for turn 1"]);
    expect(cursorOf(store, "sess0001-a", path)!.byte_offset).toBe(readFileSync(path).length);
    expect((store.db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM legacy_writer_log`).get() as { n: number }).n).toBe(0);
  });

  it("a failed observer call quarantines its range, the cursor moves on, and later turns are processed (test 8)", async () => {
    const calls = fakeObserver({ fail: p => p.includes("question for turn 2") });
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(1, 100));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    appendEntries(path, turn(2, 200));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const callsAfterStop2 = calls.length;
    const q = store.db.prepare(`SELECT state, from_offset, to_offset, range_sha, attempts, next_retry_at FROM stop_retries`).all() as any[];
    expect(q.length).toBe(1);
    expect(q[0].state).toBe("queued");
    expect(q[0].from_offset).toBe(lineStarts(path)[2]);
    expect(q[0].range_sha).toMatch(/^[0-9a-f]{64}$/);
    appendEntries(path, turn(3, 300));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(observationDocs(store)).toEqual(["Decision for turn 1", "Decision for turn 3"]);
    // Stop 3 did not re-send turn 2 as new material: the quarantined range waits for its backoff.
    expect(calls.slice(callsAfterStop2).some(c => c.slice(c.indexOf("--- TRANSCRIPT ---")).includes("question for turn 2"))).toBe(false);
  });

  it("decisions of turn 1 are still in the session document after turn 5 (test 10)", async () => {
    fakeObserver();
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(1, 100));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    for (let n = 2; n <= 5; n++) {
      appendEntries(path, turn(n, n * 100));
      await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    }
    const body = decisionsBody(store, "sess0001-a")!;
    expect(body).toContain("Decision for turn 1");
    expect(body).toContain("Decision for turn 5");
    expect(body.indexOf("Decision for turn 1")).toBeLessThan(body.indexOf("Decision for turn 5"));
  });

  it("a turn without enough assistant content is not sent to the observer; its range is still consumed", async () => {
    const calls = fakeObserver();
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", [human("question for turn 1", 100), assistant("ok", 105)]);
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(calls.length).toBe(0);
    expect(cursorOf(store, "sess0001-a", path)!.byte_offset).toBe(readFileSync(path).length);
  });

  it("the observer sees the turn before the batch as CONTEXT, not as new material", async () => {
    const calls = fakeObserver();
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(1, 100));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    appendEntries(path, turn(2, 200));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const second = calls[1]!;
    const ctx = second.indexOf("CONTEXT (already recorded");
    const tr = second.indexOf("--- TRANSCRIPT ---");
    expect(ctx).toBeGreaterThanOrEqual(0);
    expect(second.slice(ctx, tr)).toContain("question for turn 1");
    expect(second.slice(ctx, tr)).toContain("Decision for turn 1");        // a recorded title
    expect(second.slice(tr)).not.toContain("question for turn 1");
  });
});

describe("D4 sessions and concurrency (tests 11, 16)", () => {
  it("two sessions' identical antipatterns land in two documents (test 11)", async () => {
    fakeObserver();
    const store = createTestStore();
    const dir = tmp();
    for (const sid of ["aaaa1111-s", "bbbb2222-s"]) {
      const path = writeTranscriptFile(dir, `${sid}.jsonl`, [
        human("question for turn 1", 100),
        assistant("Avoid using the global lock here, it caused the deadlock in production last week.", 105),
      ]);
      await decisionExtractor(store, { sessionId: sid, transcriptPath: path });
    }
    const bodies = store.db.prepare(`SELECT d.path, c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash WHERE d.path LIKE 'antipatterns/%' ORDER BY d.path`).all() as { path: string; body: string }[];
    expect(bodies.map(b => b.path.replace(/^antipatterns\/\d{4}-\d{2}-\d{2}-/, ""))).toEqual(["aaaa1111.md", "bbbb2222.md"]);
    for (const b of bodies) expect(b.body).toContain("**Avoid:** Avoid using the global lock here");
  });

  it("two Stops racing on one transcript commit its effects once (test 16)", async () => {
    fakeObserver({ delayMs: 20 });
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(1, 100));
    await Promise.all([
      decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path }),
      decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path }),
    ]);
    expect(observationDocs(store)).toEqual(["Decision for turn 1"]);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM stop_items WHERE kind = 'decision'`).get() as { n: number }).n).toBeGreaterThanOrEqual(1);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM stop_retries`).get() as { n: number }).n).toBe(0);
  });

  it("a replaced transcript file re-anchors at its current turn with a new generation (test 20)", async () => {
    fakeObserver();
    const store = createTestStore();
    const dir = tmp();
    const path = writeTranscriptFile(dir, "s1.jsonl", [...turn(1, 100), ...turn(2, 200)]);
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const replacement = join(dir, "next.jsonl");
    writeFileSync(replacement, readFileSync(path));
    renameSync(replacement, path);
    appendEntries(path, turn(3, 300));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(cursorOf(store, "sess0001-a", path)!.anchor_epoch).toBe(1);
    expect(observationDocs(store)).toContain("Decision for turn 3");
  });

  it("does nothing on a vault whose stop-pipeline migration is not verified (fail closed)", async () => {
    const calls = fakeObserver();
    const dir = tmp();
    const dbPath = join(dir, "index.sqlite");
    const s0 = createStore(dbPath);
    s0.db.exec(`DELETE FROM vault_flags WHERE flag = 'stop-pipeline:schema-v1'`);
    s0.close();
    const holder = new Database(dbPath);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const origError = console.error;
    console.error = () => {};
    let s1: Store;
    try { s1 = createStore(dbPath, { busyTimeout: 50 }); } finally { console.error = origError; holder.exec("ROLLBACK"); holder.close(); }
    const path = writeTranscriptFile(dir, "s1.jsonl", turn(1, 100));
    await decisionExtractor(s1!, { sessionId: "sess0001-a", transcriptPath: path });
    expect(calls.length).toBe(0);
    expect(observationDocs(s1!)).toEqual([]);
    s1!.close();
  });
});

describe("D4 batches fit the observer's input bounds (test 9)", () => {
  it("packs complete turns in order up to the bounds, at least one turn per batch", async () => {
    const { packTurnBatches } = await import("../../src/stop-extract.ts");
    const seg = (chars: number) => ({ messages: [{ role: "user" as const, content: "q" }, { role: "assistant" as const, content: "a".repeat(chars) }] });
    // The observer caps each message (≤ ~1,000 chars rendered), so bounds are measured on the capped render.
    const batches = packTurnBatches([seg(100), seg(100), seg(9000), seg(100)], { maxMessages: 100, maxChars: 500 });
    expect(batches.map(b => b.length)).toEqual([2, 1, 1]);
  });

  it("a Stop that runs out of budget leaves the cursor at the end of the last batch it committed", async () => {
    const calls = fakeObserver();
    const store = createTestStore();
    // Each turn renders ~4,800 capped chars (9 assistant messages): two turns never share one 8,000-char batch.
    const big = "x".repeat(1500);
    const entries = [1, 2, 3].flatMap(n => [
      human(`question for turn ${n}`, n * 100),
      ...Array.from({ length: 9 }, (_, k) => assistant(`For turn ${n} step ${k} we decided: ${big}`, n * 100 + 5 + k)),
    ]);
    // The first Stop anchors at its current turn (no backfill); the big turns arrive after it.
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(0, 50));
    const { runDecisionExtraction } = await import("../../src/stop-extract.ts");
    await runDecisionExtraction(store, { sessionId: "sess0001-a", transcriptPath: path });
    appendEntries(path, entries);
    const before = calls.length;
    await runDecisionExtraction(store, { sessionId: "sess0001-a", transcriptPath: path, maxBatches: 1 });
    expect(calls.length - before).toBe(1);
    const cur = cursorOf(store, "sess0001-a", path)!;
    expect(cur.byte_offset).toBeLessThan(readFileSync(path).length);
    await runDecisionExtraction(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(cursorOf(store, "sess0001-a", path)!.byte_offset).toBe(readFileSync(path).length);
  });
});

/**
 * v0.41.1: batches leave room for the CONTEXT. Baseline (v0.41.0): turns were packed up to the whole render budget
 * and the CONTEXT came on top, so every batch after the first overflowed the observer's bound.
 */
describe("v0.41.1 a backlog's batches fit the observer's bound with their CONTEXT", () => {
  it("every prompt stays inside OBSERVER_MAX_RENDER_CHARS, and every turn reaches the model whole exactly once", async () => {
    const { OBSERVER_MAX_RENDER_CHARS } = await import("../../src/observer.ts");
    const calls = fakeObserver();
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(0, 50));   // the first Stop anchors at its current turn
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const pad = "p".repeat(420);
    appendEntries(path, Array.from({ length: 40 }, (_, k) => k + 1).flatMap(n => [
      human(`question for turn ${n}`, n * 100),
      assistant(`For turn ${n} we decided to ship feature ${n}: ${pad} (end of turn ${n})`, n * 100 + 5),
    ]));
    const before = calls.length;
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const prompts = calls.slice(before);
    expect(prompts.length).toBeGreaterThan(1);
    const seen: number[] = [];
    for (const p of prompts) {
      const ctx = p.indexOf("--- CONTEXT");
      const tr = p.indexOf("--- TRANSCRIPT ---\n");
      const body = p.slice(tr + "--- TRANSCRIPT ---\n".length, p.indexOf("\n--- END TRANSCRIPT ---", tr));
      expect((ctx >= 0 ? tr - ctx : 0) + body.length).toBeLessThanOrEqual(OBSERVER_MAX_RENDER_CHARS);
      for (const m of body.matchAll(/\(end of turn (\d+)\)/g)) seen.push(Number(m[1]));
    }
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, k) => k + 1));
    expect(cursorOf(store, "sess0001-a", path)!.byte_offset).toBe(readFileSync(path).length);
  });

  it("when every batch's first answer fails to parse, each retry still fits the bound and carries its whole batch", async () => {
    const { OBSERVER_MAX_RENDER_CHARS } = await import("../../src/observer.ts");
    const retries: string[] = [];
    setDefaultLlamaCpp({
      generate: async (prompt: string) => {
        if (!prompt.includes("Extract observations:")) return { text: "", model: "fake", done: true };
        if (!prompt.includes("Your previous reply could not be used:")) {   // v0.41.4 §3.1: the observer's own retry feedback
          return { text: "<observation><type>bogus</type></observation>" + "j".repeat(700), model: "fake", done: true };
        }
        retries.push(prompt);
        const section = prompt.slice(prompt.indexOf("--- TRANSCRIPT ---"), prompt.indexOf("--- END TRANSCRIPT ---"));
        const turns = [...new Set([...section.matchAll(/question for turn (\d+)/g)].map(m => m[1]))];
        return {
          text: turns.map(n => `<observation><type>decision</type><title>Decision for turn ${n}</title><facts><fact>Turn ${n} decided to ship feature ${n}</fact></facts><narrative>Turn ${n} needed it.</narrative></observation>`).join("\n"),
          model: "fake", done: true,
        };
      },
      embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: "fake" }),
    } as any);
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(0, 50));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const pad = "p".repeat(420);
    appendEntries(path, Array.from({ length: 40 }, (_, k) => k + 1).flatMap(n => [
      human(`question for turn ${n}`, n * 100),
      assistant(`For turn ${n} we decided to ship feature ${n}: ${pad} (end of turn ${n})`, n * 100 + 5),
    ]));
    const before = retries.length;
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const got = retries.slice(before);
    expect(got.length).toBeGreaterThan(1);
    const seen: number[] = [];
    for (const p of got) {
      const ctx = p.indexOf("--- CONTEXT");
      const tr = p.indexOf("--- TRANSCRIPT ---\n");
      const body = p.slice(tr + "--- TRANSCRIPT ---\n".length, p.indexOf("\n--- END TRANSCRIPT ---", tr));
      const feedback = p.slice(p.indexOf("Extract observations:") + "Extract observations:".length);
      expect((ctx >= 0 ? tr - ctx : 0) + body.length + feedback.length).toBeLessThanOrEqual(OBSERVER_MAX_RENDER_CHARS);
      for (const m of body.matchAll(/\(end of turn (\d+)\)/g)) seen.push(Number(m[1]));
    }
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, k) => k + 1));
    expect(observationDocs(store)).toContain("Decision for turn 40");
  });
});

describe("D3 a stale failure is discarded (test 8, interleaving)", () => {
  it("an observer failure whose range another Stop committed meanwhile records nothing", async () => {
    fakeObserver({ fail: () => true });
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s1.jsonl", turn(1, 100));
    const { runDecisionExtraction } = await import("../../src/stop-extract.ts");
    await runDecisionExtraction(store, {
      sessionId: "sess0001-a", transcriptPath: path,
      beforePhaseB: () => {
        // Another processor commits the range between this Stop's Phase A and its Phase B.
        store.db.prepare(
          `INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, first_line_sha, byte_offset, tail_sha, human_turns)
           VALUES (?, 'decision-extractor', ?, ?, 'x', ?, 'y', 1)`
        ).run("sess0001-a", transcriptKey(path), path, readFileSync(path).length);
      },
    });
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM stop_retries`).get() as { n: number }).n).toBe(0);
  });
});
