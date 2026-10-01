/**
 * v0.41.2 (codex T11 #10, #13; T12 #3, #6; T13 #2; T14 #2) — `clawmem doctor`'s observer lines tell a queued
 * continuation (the watcher resumes it) from a live checkpoint no queued range owns — a range matched by its full
 * identity, epoch included — and split those three ways: ahead of the transcript's cursor (a later Stop resumes it),
 * a first Stop's with no cursor (a later Stop that reads the same range can resume it until the sweep's 7 days), and
 * behind the cursor — a dismissed or superseded range (no Stop reaches it; the sweep removes it). They count the
 * continuations waiting for a server that could not be verified, and show the observer's mean call time. Runs the REAL CLI against a seeded vault and a fake llama-server
 * (the doctor prints its LLM context line only for an endpoint that serves chat completions); the embedding and
 * reranker endpoints point at a dead port so those sections take their fast non-fatal paths.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createStore } from "../../src/store.ts";
import { checkpointKey, liveCheckpoint } from "../../src/stop-checkpoint.ts";

const ROOT = join(import.meta.dir, "../..");
let home: string;
let deadPort: number;
let llm: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-v0412-doctor-"));
  const t = Bun.serve({ port: 0, fetch: () => new Response("x") });
  deadPort = t.port!;
  t.stop(true);
  const tok = (s: string) => Math.ceil(s.length / 3);
  llm = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/props") return Response.json({ default_generation_settings: { n_ctx: 8192 }, model_path: "/m/q.gguf", chat_template: "t", build_info: "b" });
      if (path === "/apply-template") { const b = await req.json() as { messages: { content: string }[] }; return Response.json({ prompt: `<u>${b.messages[0]!.content}</u>` }); }
      if (path === "/tokenize") { const b = await req.json() as { content: string }; return Response.json({ tokens: new Array(tok(b.content)).fill(1) }); }
      if (path === "/v1/chat/completions") {
        return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "fake", usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
      }
      return new Response("nf", { status: 404 });
    },
  });
});

afterAll(() => { llm.stop(true); rmSync(home, { recursive: true, force: true }); });

async function cli(...args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"),
      INDEX_PATH: resolve(home, "vault.sqlite"),
      CLAWMEM_EMBED_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_LLM_URL: `http://127.0.0.1:${llm.port}`,
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
const doctor = () => cli("doctor");

describe("v0.41.2 clawmem doctor — observer continuations, live checkpoints and the mean call", () => {
  it("counts queued continuations, live checkpoints a later Stop can resume, first-Stop ones with no cursor, those behind the cursor (a dismissed range among them), the unverified waits, and the mean call", async () => {
    const st = createStore(resolve(home, "vault.sqlite"));
    const now = "2026-10-01T12:00:00.000Z";
    const range = { anchorEpoch: 0, from: 0, to: 10, sha: "abc" };
    const put = (sid: string) => {
      const c = liveCheckpoint({
        rev: 1, sessionId: sid, transcriptKey: "tk", hook: "decision-extractor", range, linesSha: "l", contract: "c",
        backend: { kind: "remote", root: "http://x" }, fingerprint: "f", fingerprintStrength: "strong", doneThroughLine: 3,
        observations: [], titles: [],
      } as any);
      st.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?)`)
        .run(checkpointKey(sid, "tk", "decision-extractor", "rk"), JSON.stringify(c), now);
    };
    const queue = (sid: string, epoch: number, rangeKey: string, lastError: string) => st.db.prepare(
      `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha,
         attempts, last_error, first_failed_at, next_retry_at, state)
       VALUES (?, 'tk', 'decision-extractor', '/t.jsonl', ?, 0, 10, ?, 'abc', 0, ?, ?, ?, 'queued')`
    ).run(sid, epoch, rangeKey, lastError, now, now);
    const cursor = (sid: string, epoch: number, byteOffset: number) => st.db.prepare(
      `INSERT INTO stop_cursors (session_id, hook, transcript_key, transcript_path, first_line_sha, anchor_epoch, byte_offset, tail_sha, human_turns)
       VALUES (?, 'decision-extractor', 'tk', '/t.jsonl', 'f', ?, ?, 't', 1)`
    ).run(sid, epoch, byteOffset);
    put("queued-sess"); queue("queued-sess", 0, "rk", "continuation: 3/9 lines");
    // A later Stop can reach these: their transcript's cursor is still before the range's end.
    put("stranded-a"); cursor("stranded-a", 0, 0);
    put("stranded-b"); cursor("stranded-b", 0, 0);
    // No later Stop reaches these two: re-anchored (epoch 1's same-offset range is queued) and a dismissed continuation
    // (the cursor went past its range when it was queued). A first Stop's that saved no cursor may still be resumed.
    put("reanchored"); cursor("reanchored", 1, 10); queue("reanchored", 1, "1-0-10-abc", "continuation: 3/9 lines — its server could not be verified");
    put("dismissed"); cursor("dismissed", 0, 10); queue("dismissed", 0, "rk", "continuation: 3/9 lines");
    put("first-stop");
    const dismissId = (st.db.prepare(`SELECT id FROM stop_retries WHERE session_id = 'dismissed'`).get() as { id: number }).id;
    st.db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES ('observer_call_mean', ?, ?)`)
      .run(JSON.stringify({ ms: 2500, samples: 12, at: now }), now);
    st.close();

    expect(await cli("repair", "stop-queue", "--dismiss", String(dismissId))).toContain(`dismissed quarantined range ${dismissId}`);
    const out = await doctor();
    expect(out).toContain("2 continuation(s) queued");
    expect(out).toMatch(/1 wait for their LLM server to answer \/props again/);
    expect(out).toContain("2 live checkpoint(s) without a queued range — a later Stop resumes each one it reaches unchanged");
    expect(out).toContain("1 first-Stop checkpoint(s) with no cursor — a later Stop that reads the same range resumes it");
    expect(out).toContain("2 checkpoint(s) behind their transcript's cursor (a dismissed or superseded range) — no later Stop reaches them");
    expect(out).toMatch(/mean observer call 2\.5 s/);
  }, 60_000);
});
