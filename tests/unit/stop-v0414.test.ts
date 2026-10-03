/**
 * v0.41.4 (BACKLOG 69.3, riders 68.2 and the §7 operations) — the observer fix as the Stop pipeline sees it
 * (DESIGN-v0414.md r7 §3.2, §3.3, §4.4, §4.5, §6.2, §7.1, §7.2).
 *
 * Baseline (v0.41.3, prod 2026-10-03): on a backend whose invocations each afford one observer call, an unparseable
 * reply or a cut reply left the window's retry in locals; the invocation returned `partial`, the range was queued as a
 * continuation (attempts 0, no backoff) and the next invocation repeated the same first call — 14 ranges held, retried
 * every minute. Causal runs older than a day stayed "stuck" in doctor for ever. There was no way to retry a held range
 * now, and `--run` stopped at the first pass whose replays all failed. Each test here fails on v0.41.3 for the reason
 * its name gives, except the one named "(guard)", which pins a behaviour v0.41.3 already has and v0.41.4 must keep.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { fakeBudgetLlm, type FakeReply } from "../helpers/fake-budget-llm.ts";
import { runDecisionExtraction, replayDueRetries } from "../../src/stop-extract.ts";
import { runStopWorkerTick } from "../../src/stop-worker.ts";
import { stopPipelineHealth } from "../../src/stop-health.ts";
import { CHECKPOINT_PREFIX } from "../../src/stop-checkpoint.ts";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { human, assistant, toolResult, writeTranscriptFile, type Entry } from "./stop-fixtures.ts";
import type { Store } from "../../src/store.ts";

const workerModule = () => import("../../src/stop-worker.ts") as Promise<Record<string, any>>;
const SID = "sess-v0414";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "clawmem-v0414-")); });
afterEach(() => { setDefaultLlamaCpp(null); rmSync(dir, { recursive: true, force: true }); });

/** One turn of `tools` Read calls: 2·tools + 2 observer lines. */
function turn(tools: number): Entry[] {
  const out: Entry[] = [human("question: index the archive", 100_000)];
  for (let j = 0; j < tools; j++) {
    out.push(assistant("", 100_000 + j * 10 + 1, [{ id: `tu-${j}`, name: "Read", input: { file_path: `/repo/file${j}.ts` } }]));
    out.push(toolResult(`tu-${j}`, `contents of file${j} ` + "lorem ipsum dolor sit amet ".repeat(15), 100_000 + j * 10 + 2));
  }
  out.push(assistant("The archive is indexed and every file was read.", 199_999));
  return out;
}

const isObserver = (p: string) => p.includes("Extract observations:");
/** The observer lines a window prompt carries in its TRANSCRIPT section. */
function linesIn(prompt: string): number {
  const t = prompt.slice(prompt.lastIndexOf("--- TRANSCRIPT ---"), prompt.lastIndexOf("--- END TRANSCRIPT ---"));
  return (t.match(/^\[(user|assistant)\]: /gm) ?? []).length;
}
function block(title: string, type = "discovery"): string {
  return `<observation><type>${type}</type><title>${title}</title><facts><fact>The window was observed in full</fact></facts><narrative>n</narrative></observation>`;
}
const CUT: FakeReply = { text: "<observation><type>disc", finish: "length" };
/** A window of more than `max` lines is cut; a smaller one gets one observation named for its size and first file. */
function cutAbove(max: number) {
  return (prompt: string): FakeReply => {
    if (!isObserver(prompt)) return "";
    const n = linesIn(prompt);
    if (n > max) return CUT;
    const first = prompt.slice(prompt.lastIndexOf("--- TRANSCRIPT ---")).match(/file(\d+)/)?.[1] ?? "none";
    return block(`Window of ${n} lines from file ${first}`);
  };
}

type Ckpt = { state: string; doneThroughLine: number; rev: number; windowBound?: { start: number; maxLines: number } };
const ckpt = (store: Store): Ckpt | null => {
  const r = store.db.prepare(`SELECT value FROM vault_flags WHERE flag LIKE ?`).get(`${CHECKPOINT_PREFIX}%`) as { value: string } | null;
  return r ? JSON.parse(r.value) as Ckpt : null;
};
const retries = (store: Store) =>
  store.db.prepare(`SELECT id, attempts, state, last_error, next_retry_at FROM stop_retries ORDER BY id`).all() as
    { id: number; attempts: number; state: string; last_error: string; next_retry_at: string }[];
const makeDue = (store: Store) => store.db.prepare(`UPDATE stop_retries SET next_retry_at = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'`).run();
const replay = (store: Store, calls = 1) =>
  replayDueRetries(store, { deadline: deadlineAfter(monoNow(), duration(60_000)), limit: 1, observerMaxCalls: calls });

describe("v0.41.4 a window's retry ends inside its invocation (§3.2)", () => {
  it("an unparseable reply on a one-call budget fails the attempt (attempts 1, its class in last_error) — v0.41.3 queued a continuation", async () => {
    const fake = fakeBudgetLlm({ reply: p => (isObserver(p) ? block("Copied a tool role", "tool_use") : ""), nCtx: 8192 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", turn(2));
    const run = await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    expect(run.quarantined).toBe(1);
    const [row] = retries(store);
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe("no parseable response: type-not-allowed (tool-role)");
  });
});

describe("v0.41.4 a size reduction persists as a shrink-only window bound (§3.3)", () => {
  it("repeated one-call invocations on a cut window converge through the persisted bound, and the range completes", async () => {
    const fake = fakeBudgetLlm({ reply: cutAbove(8), nCtx: 8192 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", turn(10));   // 22 lines
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const states: Ckpt[] = [ckpt(store)!];
    const errors = [retries(store)[0]!.last_error];
    for (let i = 0; i < 20 && retries(store)[0]!.state !== "done"; i++) {
      makeDue(store);
      const before = fake.calls.filter(c => isObserver(c.prompt)).length;
      await replay(store, 1);
      expect(fake.calls.filter(c => isObserver(c.prompt)).length - before).toBe(1);
      errors.push(retries(store)[0]!.last_error);
      states.push(ckpt(store)!);
    }
    expect(retries(store)[0]!.state).toBe("done");
    expect(errors).toContain("capacity: the reply was cut and the halved window was not tried");
    for (const s of states) if (s.state === "live" && s.windowBound) expect(s.windowBound.start).toBe(s.doneThroughLine);
    for (let i = 1; i < states.length; i++) {
      const [a, b] = [states[i - 1]!, states[i]!];
      if (a.windowBound && b.windowBound && a.doneThroughLine === b.doneThroughLine) expect(b.windowBound.maxLines).toBeLessThanOrEqual(a.windowBound.maxLines);
    }
  });

  it("a bound swap that loses its compare-and-swap ends the invocation overtaken; the other processor's smaller bound stands", async () => {
    const store = createTestStore();
    let race = false;
    const base = cutAbove(8);
    const fake = fakeBudgetLlm({
      reply: (p) => {
        if (race && isObserver(p)) {
          race = false;
          // Another processor halved this window further while our call was in flight.
          const row = store.db.prepare(`SELECT flag, value FROM vault_flags WHERE flag LIKE ?`).get(`${CHECKPOINT_PREFIX}%`) as { flag: string; value: string };
          const c = JSON.parse(row.value);
          store.db.prepare(`UPDATE vault_flags SET value = ? WHERE flag = ?`)
            .run(JSON.stringify({ ...c, rev: c.rev + 1, windowBound: { start: 0, maxLines: 3 } }), row.flag);
        }
        return base(p);
      },
      nCtx: 8192,
    });
    setDefaultLlamaCpp(fake.llm as any);
    const path = writeTranscriptFile(dir, "t.jsonl", turn(10));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    expect(ckpt(store)!.windowBound).toEqual({ start: 0, maxLines: 11 });
    makeDue(store);
    race = true;
    await replay(store, 1);
    expect(ckpt(store)!.windowBound).toEqual({ start: 0, maxLines: 3 });
    const [row] = retries(store);
    expect(row!.attempts).toBe(1);   // overtaken is not a failure of this range
    expect(row!.last_error).toBe("capacity: the reply was cut and the halved window was not tried");
    for (let i = 0; i < 20 && retries(store)[0]!.state !== "done"; i++) {
      makeDue(store);
      await replay(store, 1);
      const c = ckpt(store)!;
      if (c.state === "live" && c.windowBound?.start === 0) expect(c.windowBound.maxLines).toBeLessThanOrEqual(3);
    }
    expect(retries(store)[0]!.state).toBe("done");
  });

  it("a malformed window bound is ignored and never invalidates the checkpoint: the replay resumes at its saved line (guard)", async () => {
    // Windows that each parse, on a 4096 context: one call completes the first window and leaves a live checkpoint.
    const fake = fakeBudgetLlm({ reply: p => (isObserver(p) ? block(`Window of ${linesIn(p)} lines`) : ""), nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", turn(40));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path, observerMaxCalls: 1 });
    const saved = ckpt(store)!;
    expect(saved.state).toBe("live");
    expect(saved.doneThroughLine).toBeGreaterThan(0);
    const row = store.db.prepare(`SELECT flag FROM vault_flags WHERE flag LIKE ?`).get(`${CHECKPOINT_PREFIX}%`) as { flag: string };
    store.db.prepare(`UPDATE vault_flags SET value = ? WHERE flag = ?`)
      .run(JSON.stringify({ ...saved, windowBound: { start: "x", maxLines: -4 } }), row.flag);
    makeDue(store);
    const before = fake.calls.length;
    await replay(store, 1);
    const first = fake.calls.slice(before).find(c => isObserver(c.prompt))!;
    const transcript = first.prompt.slice(first.prompt.lastIndexOf("--- TRANSCRIPT ---"));
    expect(transcript).not.toContain("question: index the archive");   // line 0 is behind the saved line
    expect(ckpt(store)!.doneThroughLine).toBeGreaterThan(saved.doneThroughLine);
  });
});

describe("v0.41.4 a grammar request's 400 in the Stop pipeline (§4.4)", () => {
  it("writes the grammar-off record to vault_flags at once; the grammarless retry commits the range and clears the obligation", async () => {
    const fake = fakeBudgetLlm({ reply: p => (isObserver(p) ? block("Grammar refused, plain retry parsed") : ""), nCtx: 8192 });
    const grammars: (string | undefined)[] = [];
    const llm = {
      ...fake.llm,
      generateDetailed: async (prompt: string, o: any) => {
        if (isObserver(prompt)) grammars.push(o.grammar);
        if (o.grammar) return { ok: false, reason: "http", status: 400, backend: o.backend };
        return fake.llm.generateDetailed(prompt, o);
      },
    };
    setDefaultLlamaCpp(llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", turn(2));
    const run = await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path });
    expect(typeof grammars[0]).toBe("string");
    expect(grammars[1]).toBeUndefined();
    expect(run.committed).toBe(1);
    const rows = store.db.prepare(`SELECT value FROM vault_flags WHERE flag LIKE 'observer-grammar:%'`).all() as { value: string }[];
    expect(rows.length).toBe(1);
    const rec = JSON.parse(rows[0]!.value);
    expect(rec).toMatchObject({ count: 1, pending: false });
    expect(Date.parse(rec.offUntil)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("completed grammar replies that fail structurally reach the doctor's record (§4.5)", async () => {
    let n = 0;
    const fake = fakeBudgetLlm({ reply: p => (!isObserver(p) ? "" : n++ === 0 ? "plain prose despite the grammar" : block("Second sample parsed")), nCtx: 8192 });
    setDefaultLlamaCpp(fake.llm as any);
    const store = createTestStore();
    const path = writeTranscriptFile(dir, "t.jsonl", turn(2));
    await runDecisionExtraction(store, { sessionId: SID, transcriptPath: path });
    const row = store.db.prepare(`SELECT value FROM vault_flags WHERE flag = 'observer_stats'`).get() as { value: string } | null;
    expect(row).not.toBeNull();
    const v = JSON.parse(row!.value) as { backends: Record<string, { grammarStructural: number }> };
    expect(Object.values(v.backends).reduce((s, b) => s + b.grammarStructural, 0)).toBe(1);
  });
});

describe("v0.41.4 68.2 — stuck causal runs vs stale ones (§6.2)", () => {
  it("in_progress runs started 1–24 h ago are stuck; older ones are counted apart as stale", () => {
    const store = createTestStore();
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const put = (key: string, outcome: string, startedHoursAgo: number) => store.db.prepare(
      `INSERT INTO causal_runs (run_key, session_id, source, mode, outcome, started_at) VALUES (?, 's', 'stop', 'on', ?, ?)`
    ).run(key, outcome, ago(startedHoursAgo));
    put("recent", "in_progress", 0.5);
    put("stuck", "in_progress", 2);
    put("stale", "in_progress", 72);
    put("done", "ok", 72);
    const h = stopPipelineHealth(store.db) as any;
    expect(h.causalStuck).toBe(1);
    expect(h.causalStale).toBe(1);
  });
});

describe("v0.41.4 operations: retry now, and a bounded drain (§7.1, §7.2)", () => {
  const seed = (store: Store, state: string, lastError: string, extra: Partial<{ next: string; lease: string; path: string }> = {}) => {
    store.db.prepare(
      `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha,
         attempts, last_error, first_failed_at, next_retry_at, state, claim_token, lease_expires_at)
       VALUES ('s', 'k', 'decision-extractor', ?, 0, 0, 10, ?, 'sha', 1, ?, '2026-10-01T00:00:00.000Z', ?, ?, ?, ?)`
    ).run(extra.path ?? "/gone/t.jsonl", `rk-${Math.random()}`, lastError, extra.next ?? "2099-01-01T00:00:00.000Z", state,
      state === "claimed" ? "tok" : null, extra.lease ?? (state === "claimed" ? "2099-01-01T00:00:00.000Z" : null));
    return (store.db.prepare(`SELECT MAX(id) AS id FROM stop_retries`).get() as { id: number }).id;
  };
  const row = (store: Store, id: number) => store.db.prepare(`SELECT state, next_retry_at, lease_expires_at FROM stop_retries WHERE id = ?`).get(id) as
    { state: string; next_retry_at: string; lease_expires_at: string | null };

  it("--retry-now makes queued rows due now: `held` skips continuations, a claimed row's lease is untouched, --limit caps", async () => {
    const m = await workerModule();
    expect(typeof m.retryNowStopRetries).toBe("function");
    const store = createTestStore();
    const failed = seed(store, "queued", "no parseable response: no-blocks");
    const cont = seed(store, "queued", "continuation: 3/9 lines");
    const claimed = seed(store, "claimed", "no parseable response: no-blocks");
    const done = seed(store, "done", "no parseable response: no-blocks");
    const t0 = Date.now();
    expect(m.retryNowStopRetries(store, "held")).toEqual([failed]);
    expect(Date.parse(row(store, failed).next_retry_at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(row(store, failed).next_retry_at)).toBeGreaterThanOrEqual(t0 - 1_000);
    expect(row(store, cont).next_retry_at).toBe("2099-01-01T00:00:00.000Z");
    expect(row(store, claimed)).toMatchObject({ state: "claimed", next_retry_at: "2099-01-01T00:00:00.000Z", lease_expires_at: "2099-01-01T00:00:00.000Z" });
    expect(m.retryNowStopRetries(store, [claimed, done, cont])).toEqual([cont]);   // ids: queued rows only, continuations included
    const more = [seed(store, "queued", "capacity: x"), seed(store, "queued", "capacity: y")];
    expect(m.retryNowStopRetries(store, "held", 2)).toEqual([failed, more[0]]);
  });

  it("a worker tick reports the replay rows it attempted, whatever their outcome", async () => {
    const store = createTestStore();
    const ids = [0, 1, 2, 3].map(() => seed(store, "queued", "no parseable response: no-blocks", { next: "2000-01-01T00:00:00.000Z" }));
    const fake = fakeBudgetLlm({ replies: [""], nCtx: 8192 });
    const r = await runStopWorkerTick(store, [], fake.llm as any, { quietMs: 0, limits: { replays: 3 } }) as any;
    expect(r.replayed).toBe(0);              // the transcripts are gone: each row turns unavailable
    expect(r.attempted).toBe(3);
    expect([...r.attemptedIds].sort((a: number, b: number) => a - b)).toEqual(ids.slice(0, 3));
  });
});
