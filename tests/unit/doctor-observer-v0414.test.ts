/**
 * v0.41.4 (BACKLOG 69.3 G5, rider 68.2, §7) — `clawmem doctor` names why ranges are held and what the grammar did, and
 * `clawmem repair stop-queue --retry-now … --run` retries held ranges now and says what it reached
 * (DESIGN-v0414.md r7 §4.4, §4.5, §6.2, §7.1–§7.3).
 *
 * Baseline (v0.41.3): held ranges showed only as a queue count (the doctor said nothing about why — 14 prod ranges
 * held "no parseable response within the budget"), causal runs started days ago stayed a "stuck" warning for ever, and
 * `repair stop-queue` had no way to make a held range due now. Runs the REAL CLI against a seeded vault; every model
 * endpoint points at a dead port (the doctor's sections take their fast non-fatal paths, a replay of a range whose
 * transcript is gone needs no model). Each test fails on v0.41.3 for the reason its name gives.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createStore } from "../../src/store.ts";

const ROOT = join(import.meta.dir, "../..");
let home: string;
let deadPort: number;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-v0414-doctor-"));
  const t = Bun.serve({ port: 0, fetch: () => new Response("x") });
  deadPort = t.port!;
  t.stop(true);
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

async function cli(vault: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"),
      INDEX_PATH: resolve(home, vault),
      CLAWMEM_EMBED_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_LLM_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_RERANK_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_NO_LOCAL_MODELS: "true",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return out + err;
}

function queue(st: ReturnType<typeof createStore>, lastError: string, next = "2099-01-01T00:00:00.000Z"): number {
  st.db.prepare(
    `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha,
       attempts, last_error, first_failed_at, next_retry_at, state)
     VALUES ('s', 'tk', 'decision-extractor', '/gone/t.jsonl', 0, 0, 10, ?, 'abc', 1, ?, '2026-10-01T00:00:00.000Z', ?, 'queued')`
  ).run(`rk-${Math.random()}`, lastError, next);
  return (st.db.prepare(`SELECT MAX(id) AS id FROM stop_retries`).get() as { id: number }).id;
}

describe("v0.41.4 clawmem doctor — held ranges by class, the grammar, stale causal runs", () => {
  it("groups held ranges by class (a legacy reason reads `legacy (unclassified)`), shows the grammar-off record and structural violations, and reports stale causal runs once as information", async () => {
    const st = createStore(resolve(home, "doctor.sqlite"));
    const now = new Date().toISOString();
    queue(st, "no parseable response: type-not-allowed (tool-role)");
    queue(st, "no parseable response: type-not-allowed (tool-role)");
    queue(st, "no parseable response: no-blocks");
    queue(st, "capacity: the reply was cut and the halved window was not tried");
    queue(st, "no parseable response within the budget");
    queue(st, "continuation: 3/9 lines");
    const offUntil = new Date(Date.now() + 20 * 3_600_000).toISOString();
    st.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)`)
      .run("observer-grammar:abc123", JSON.stringify({ offUntil, at: now, count: 1, pending: true }), now);
    st.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES ('observer_stats', ?, ?)`)
      .run(JSON.stringify({ backends: { k1: { grammarStructural: 3, grammarContent: 1, instructionEcho: 0, eventDefinitionEcho: 0, at: now } } }), now);
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    st.db.prepare(`INSERT INTO causal_runs (run_key, session_id, source, mode, outcome, started_at) VALUES ('stuck', 's', 'stop', 'on', 'in_progress', ?)`).run(ago(2));
    st.db.prepare(`INSERT INTO causal_runs (run_key, session_id, source, mode, outcome, started_at) VALUES ('stale', 's', 'stop', 'on', 'in_progress', ?)`).run(ago(72));
    st.close();

    const out = await cli("doctor.sqlite", "doctor");
    expect(out).toContain("held ranges by class");
    expect(out).toContain("type-not-allowed (tool-role) 2");
    expect(out).toContain("no-blocks 1");
    expect(out).toContain("capacity 1");
    expect(out).toContain("legacy (unclassified) 1");
    expect(out).toContain("clawmem repair stop-queue --retry-now held --run");
    expect(out).toContain(`grammar off until ${offUntil.slice(0, 16)}`);
    expect(out).toContain("after an HTTP 400 on a grammar request (cause unconfirmed)");
    expect(out).toContain("3 completed replies to grammar requests failed structurally — the server may be ignoring the grammar");
    expect(out).toContain("1 causal run(s) still in progress after 1 h");
    expect(out).toContain("1 unfinished causal run(s) older than 24 hours; not automatically replayed");
  }, 60_000);
});

describe("v0.41.4 clawmem repair stop-queue --retry-now … --run (§7.1, §7.2)", () => {
  it("makes the held ranges due now, prints their ids, drains past a pass whose replays all failed, and reports what it reached and what is next due", async () => {
    const st = createStore(resolve(home, "retry.sqlite"));
    const ids = [0, 1, 2, 3].map(() => queue(st, "no parseable response: no-blocks"));
    const cont = queue(st, "continuation: 3/9 lines");
    st.close();

    const out = await cli("retry.sqlite", "repair", "stop-queue", "--retry-now", "held", "--run");
    expect(out).toContain(`rescheduled 4 range(s) to retry now: ${ids.join(", ")}`);
    // The worker's replay step takes 3 rows a pass; each turns unavailable (its transcript is gone) — attempted, not replayed.
    expect(out).toMatch(/pass 2: .*attempted 1/);
    expect(out).toContain("retry-now: 4 rescheduled, 4 attempted, 0 not reached");
    expect(out).toMatch(/next due: quarantined ranges 20\d\d-/);
    const st2 = createStore(resolve(home, "retry.sqlite"));
    const states = st2.db.prepare(`SELECT id, state FROM stop_retries ORDER BY id`).all() as { id: number; state: string }[];
    st2.close();
    expect(states.filter(s => ids.includes(s.id)).every(s => s.state === "unavailable")).toBe(true);
    expect(states.find(s => s.id === cont)!.state).toBe("queued");
  }, 60_000);
});
