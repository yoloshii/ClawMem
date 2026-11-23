/**
 * 62.1 D11: the stop-pipeline worker drains what no later Stop will (design tests 21, 25, 27, 37, 40, 51).
 *
 * Baseline (8e2579a): there is no durable consumer — a feedback row the drainer fills after the last Stop, a Stop
 * that was killed, a failed extraction and a named vault's mirror are never processed; `clawmem watch` dies on a vault
 * with no collections before starting any worker.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { setDefaultLlamaCpp, getDefaultLlamaCpp } from "../../src/llm.ts";
import { applySurfacingBookkeeping, type SurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";
import { feedbackLoop } from "../../src/hooks/feedback-loop.ts";
import { handoffGenerator } from "../../src/hooks/handoff-generator.ts";
import { decisionExtractor } from "../../src/hooks/decision-extractor.ts";
import { runStopWorkerTick, dismissStopRetry, dismissCausalMarkers, causalDismissRefusal } from "../../src/stop-worker.ts";
import { registerTranscript } from "../../src/stop-identity.ts";
import { promptSha, transcriptKey } from "../../src/stop-pairing.ts";
import { T0, iso, human, assistant, toolResult, stopMarker, writeTranscriptFile, appendEntries } from "./stop-fixtures.ts";

import { seedContent } from "../helpers/seed-content.ts";
const dirs: string[] = [];
let failObserver = false;
let failSummary = false;
beforeEach(() => {
  failObserver = false;
  failSummary = false;
  setDefaultLlamaCpp({
    generate: async (prompt: string) => {
      if (prompt.includes("Extract observations:")) {
        if (failObserver) return null;
        const turns = [...new Set([...prompt.slice(prompt.indexOf("--- TRANSCRIPT ---")).matchAll(/question for turn (\d+)/g)].map(m => m[1]!))];
        return { text: turns.map(n => `<observation><type>decision</type><title>Decision for turn ${n}</title><facts><fact>Turn ${n} adopted bun</fact></facts><narrative>n</narrative></observation>`).join(""), model: "fake", done: true };
      }
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
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-621-worker-")); dirs.push(d); return d; }
const tick = (store: Store, vaults: { name: string; store: Store }[] = [], quietMs?: number) =>
  runStopWorkerTick(store, vaults, getDefaultLlamaCpp(), quietMs === undefined ? {} : { quietMs });
/** Make a transcript look quiet for 11 minutes. */
const quiet = (path: string) => { const t = (Date.now() - 11 * 60_000) / 1000; utimesSync(path, t, t); };

function seedDoc(store: Store, collection: string, path: string, title: string): number {
  const hash = `h-${collection}-${path}-${Math.random().toString(36).slice(2, 8)}`;
  seedContent(store.db, hash, `# ${title}\n\nbody`, iso(0));
  store.insertDocument(collection, path, title, hash, iso(0), iso(0));
  return store.findActiveDocument(collection, path)!.id;
}
function usageRow(store: Store, sessionId: string, t: number, prompt: string, path: string | null, sessionKey: string | null = null): number {
  return store.insertUsage({
    sessionId, timestamp: iso(t), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0, turnIndex: 0,
    queryText: prompt, promptSha: promptSha(prompt), transcriptKey: path ? transcriptKey(path) : null, host: "claude-code", sessionKey,
  });
}
function manifestJob(usageId: number, sessionId: string, entries: { vault: string | null; displayPath: string; title: string }[]): SurfacingBookkeepingJob {
  const groups = new Map<string | null, { displayPath: string; searchScore: number }[]>();
  for (const e of entries) {
    if (!groups.has(e.vault)) groups.set(e.vault, []);
    groups.get(e.vault)!.push({ displayPath: e.displayPath, searchScore: 0.9 });
  }
  return {
    v: 1, kind: "surfacing-bookkeeping", jobId: `job-${usageId}-${sessionId}`, sessionId, turnIndex: 0, usageId, queryHash: "qh",
    injectedPaths: entries.map(e => e.displayPath), estimatedTokens: 10, vaults: [...groups].map(([vault, docs]) => ({ vault, docs })),
    manifest: entries.map(e => ({ vault: e.vault, displayPath: e.displayPath, displayedTitle: e.title })),
  } as SurfacingBookkeepingJob;
}
const turnState = (store: Store, id: number) => (store.db.prepare(`SELECT state, reason FROM feedback_turns WHERE usage_id = ?`).get(id) as { state: string; reason: string | null } | null);
const accessOf = (store: Store, id: number) => (store.db.prepare(`SELECT access_count FROM documents WHERE id = ?`).get(id) as { access_count: number }).access_count;
const turn = (n: number, t: number) => [
  human(`question for turn ${n}`, t),
  assistant(`Working on turn ${n}.`, t + 1, [{ id: `tu${n}`, name: "Edit", input: { file_path: `/repo/src/turn${n}.ts` } }]),
  toolResult(`tu${n}`, "ok", t + 2),
  assistant(`For turn ${n} we decided to adopt bun as the build runtime. Final answer for turn ${n}: done.`, t + 3),
];
const handoff = (store: Store) => store.db.prepare(
  `SELECT s.render_needed, c.doc AS body FROM session_docs s LEFT JOIN documents d ON d.id = s.doc_id LEFT JOIN content c ON c.hash = d.hash WHERE s.kind = 'handoff'`
).get() as { render_needed: number; body: string | null } | null;

describe("D11 feedback with no further Stop (tests 6, 21, 25, 40, 51)", () => {
  it("a row the drainer filled after the last Stop (its stop marker proves the turn ended) is attributed once the transcript is quiet; the mirror follows (tests 6, 25)", async () => {
    const general = createTestStore();
    const vault = createTestStore();
    const g = seedDoc(general, "notes", "a/alpha.md", "Alpha design notes");
    const v = seedDoc(vault, "skills", "tools/linter.md", "Linter configuration guide");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("question about alpha", 100), assistant("a/alpha.md and skills/tools/linter.md both apply.", 110), stopMarker(111)]);
    const u = usageRow(general, "s", 101, "question about alpha", path);
    await feedbackLoop(general, { sessionId: "s", transcriptPath: path }, { vaults: [] });   // the Stop ran before the drain
    applySurfacingBookkeeping(general, manifestJob(u, "s", [
      { vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" },
      { vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide" },
    ]), { resolveVaultStore: () => vault });
    const vaults = [{ name: "skills", store: vault }];
    registerTranscript(general.db, "s", path, "claude-code", null);   // context-surfacing registered it at entry
    await tick(general, vaults);
    expect(turnState(general, u)!.state).toBe("pending");   // not quiet yet: the turn may still be running
    quiet(path);
    const r = await tick(general, vaults);
    expect(r.attributed).toBe(1);
    expect(turnState(general, u)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(general, g)).toBe(1);
    const mirror = (vault.db.prepare(`SELECT id FROM context_usage`).get() as { id: number }).id;
    expect(turnState(vault, mirror)).toEqual({ state: "attributed", reason: null });
    expect(accessOf(vault, v)).toBe(1);
    await tick(general, vaults);   // nothing more
    expect(accessOf(general, g)).toBe(1);
    expect(accessOf(vault, v)).toBe(1);
  });

  it("a Stop and the worker racing on one row apply it once", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("question about alpha", 100), assistant("a/alpha.md helps", 110)]);
    const u = usageRow(store, "s", 101, "question about alpha", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }]));
    quiet(path);
    await Promise.all([feedbackLoop(store, { sessionId: "s", transcriptPath: path }, { vaults: [] }), tick(store)]);
    expect(accessOf(store, a)).toBe(1);
  });

  it("a one-turn session whose only Stop died: the worker reaches it through the surfacing locator, digests it, attributes its feedback (test 40)", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
    // Its Stop fired (Claude Code wrote the stop marker) but the hook died before opening the vault.
    const path = writeTranscriptFile(tmp(), "s.jsonl", [...turn(1, 100).slice(0, 3), assistant("Per a/alpha.md: question for turn 1 is done.", 103), stopMarker(104)]);
    registerTranscript(store.db, "s", path, "claude-code", null);   // context-surfacing registered it at entry
    const u = usageRow(store, "s", 101, "question for turn 1", path);
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }]));
    quiet(path);
    const r = await tick(store);
    expect(r.attributed).toBe(1);   // the stop marker proves the turn ended
    expect(accessOf(store, a)).toBe(1);
    expect(r.digested).toBe(1);
    expect(r.rendered).toBe(1);
    const h = handoff(store)!;
    expect(h.render_needed).toBe(0);
    expect(h.body).toContain("question for turn 1");
  });

  it("a keyless row with two transcripts registered stays pending until bound; a row whose file is gone closes after the quiet period (test 51)", async () => {
    const store = createTestStore();
    const dir = tmp();
    const base = writeTranscriptFile(dir, "s.jsonl", [human("hello base", 100), assistant("hi", 110)]);
    const topic = writeTranscriptFile(dir, "s-topic-2.jsonl", [human("hello topic", 150), assistant("hi", 160)]);
    registerTranscript(store.db, "s", base, "openclaw", "agent:main:main");
    registerTranscript(store.db, "s", topic, "openclaw", "agent:main:topic:2");
    const keyless = usageRow(store, "s", 151, "hello topic", null, "agent:main:topic:9");
    applySurfacingBookkeeping(store, manifestJob(keyless, "s", [{ vault: null, displayPath: "notes/x.md", title: "X" }]));
    const gone = writeTranscriptFile(dir, "gone.jsonl", [human("q", 100), assistant("a", 110)]);
    registerTranscript(store.db, "s2", gone, "claude-code", null);
    const old = usageRow(store, "s2", Date.now() - 20 * 60_000 - T0, "q", gone);   // 20 minutes ago (real clock): past the quiet period
    applySurfacingBookkeeping(store, manifestJob(old, "s2", [{ vault: null, displayPath: "notes/x.md", title: "X" }]));
    rmSync(gone);
    quiet(base);
    quiet(topic);
    await tick(store);
    expect(turnState(store, keyless)!.state).toBe("pending");
    expect(turnState(store, old)).toEqual({ state: "unattributable", reason: "transcript-gone" });
  });
});

describe("D11 handoffs and the model queues with no further Stop (tests 21, 37)", () => {
  it("a killed final Stop: after 10 quiet minutes the worker digests the missed turn and renders the handoff (test 37)", async () => {
    const store = createTestStore();
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path });
    appendEntries(path, turn(2, 200));   // its Stop was killed
    expect((await tick(store)).digested).toBe(0);   // not quiet yet
    quiet(path);
    const r = await tick(store);
    expect(r.digested).toBe(1);
    expect(r.rendered).toBe(1);
    expect(handoff(store)!.body).toContain("question for turn 2");
    expect((await tick(store)).digested).toBe(0);   // examined: not re-read until the file changes
  });

  it("an ended session's handoff left render_needed by a capped SessionEnd is rendered uncapped; a due quarantined range is replayed", async () => {
    const store = createTestStore();
    failSummary = true;
    failObserver = true;
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path });
    await decisionExtractor(store, { sessionId: "s", transcriptPath: path });
    for (let n = 2; n <= 22; n++) {
      appendEntries(path, turn(n, n * 100));
      await handoffGenerator(store, { sessionId: "s", transcriptPath: path });
    }
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path, hookEventName: "SessionEnd" } as any);
    expect(handoff(store)!.render_needed).toBe(1);   // 22 digests, 20 shown
    expect((store.db.prepare(`SELECT state FROM stop_retries`).get() as { state: string }).state).toBe("queued");
    failObserver = false;
    store.db.prepare(`UPDATE stop_retries SET next_retry_at = '2000-01-01T00:00:00.000Z'`).run();
    const r = await tick(store);
    expect(r.rendered).toBe(1);
    expect(handoff(store)!.render_needed).toBe(0);
    expect(handoff(store)!.body).toContain("question for turn 1");
    expect(r.replayed).toBe(1);
    expect((store.db.prepare(`SELECT state FROM stop_retries`).get() as { state: string }).state).toBe("done");
  });

  it("a queued judge deferral whose old document is gone turns obsolete; dismiss helpers close their queues", async () => {
    const store = createTestStore();
    store.db.prepare(`INSERT INTO judge_deferred (fact_fp, old_doc_id, fact_payload, session_id, queued_at, state) VALUES ('fp', 999999, ?, 's', ?, 'queued')`)
      .run(JSON.stringify({ fact: "f", factDocId: null }), iso(0));
    const r = await tick(store);
    expect(r.rejudged).toBe(1);
    expect((store.db.prepare(`SELECT state FROM judge_deferred`).get() as { state: string }).state).toBe("obsolete");
    store.db.prepare(
      `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha, first_failed_at, next_retry_at, state)
       VALUES ('s', 'k', 'decision-extractor', '/x.jsonl', 0, 0, 10, 'rk', 'sha', ?, ?, 'unavailable')`
    ).run(iso(0), iso(0));
    const id = (store.db.prepare(`SELECT id FROM stop_retries`).get() as { id: number }).id;
    expect(dismissStopRetry(store, id)).toBe(true);
    expect(dismissStopRetry(store, id)).toBe(false);
    store.db.prepare(`INSERT INTO causal_due (session_id, transcript_key, range_key, run_key, obs_doc_ids, window_at, mode, state, attempts, created_at) VALUES ('s', 'k', 'r', 'stop:s:k:r', '[]', ?, 'on', 'queued', 0, ?)`)
      .run(iso(0), iso(0));
    expect(dismissCausalMarkers(store)).toBe(1);
  });

  // T28 #11: the command is documented (and designed) for markers WAITING on mode off; with the writer on they are
  // runnable work, and dismissing them would drop it for good.
  it("dismissing causal markers is refused while the causal writer is on; allowed once it is off", () => {
    const store = createTestStore();
    store.db.prepare(`INSERT INTO causal_due (session_id, transcript_key, range_key, run_key, obs_doc_ids, window_at, mode, state, attempts, created_at) VALUES ('s', 'k', 'r', 'stop:s:k:r', '[]', ?, 'on', 'queued', 0, ?)`)
      .run(iso(0), iso(0));
    const queued = () => (store.db.prepare(`SELECT COUNT(*) AS n FROM causal_due WHERE state = 'queued'`).get() as { n: number }).n;
    const saved = process.env.CLAWMEM_CAUSAL_WRITER;
    try {
      process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
      expect(dismissCausalMarkers(store)).toBeNull();
      expect(queued()).toBe(1);
      delete process.env.CLAWMEM_CAUSAL_WRITER;
      expect(dismissCausalMarkers(store)).toBe(1);
      expect(queued()).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.CLAWMEM_CAUSAL_WRITER; else process.env.CLAWMEM_CAUSAL_WRITER = saved;
    }
  });

  // T29 #9: this shell's `off` says nothing about the watcher's or the hooks' setting; the vault's recent causal activity does.
  it("dismissing is refused, even with this process off, while the vault shows a consumer running the writer", () => {
    const store = createTestStore();
    const saved = process.env.CLAWMEM_CAUSAL_WRITER;
    const queued = () => (store.db.prepare(`SELECT COUNT(*) AS n FROM causal_due WHERE state = 'queued'`).get() as { n: number }).n;
    try {
      delete process.env.CLAWMEM_CAUSAL_WRITER;
      const now = new Date().toISOString();
      store.db.prepare(`INSERT INTO causal_due (session_id, transcript_key, range_key, run_key, obs_doc_ids, window_at, mode, state, attempts, created_at) VALUES ('s', 'k', 'r', 'stop:s:k:r', '[]', ?, 'on', 'queued', 0, ?)`)
        .run(now, now);   // a Stop hook queued it just now: it runs with the writer on
      expect(causalDismissRefusal(store)).toContain("queued a causal step");
      expect(dismissCausalMarkers(store)).toBeNull();
      expect(queued()).toBe(1);
      store.db.prepare(`UPDATE causal_due SET created_at = ?`).run(iso(0));   // old marker, but a run started just now
      store.db.prepare(`INSERT INTO causal_runs (run_key, source, started_at, mode, outcome) VALUES ('run-now', 'stop', ?, 'shadow', 'completed')`).run(now);
      expect(causalDismissRefusal(store)).toContain("causal step ran");
      expect(dismissCausalMarkers(store)).toBeNull();
      store.db.prepare(`UPDATE causal_runs SET started_at = ?`).run(iso(0));   // nothing in the last hour
      expect(causalDismissRefusal(store)).toBeNull();
      expect(dismissCausalMarkers(store)).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.CLAWMEM_CAUSAL_WRITER; else process.env.CLAWMEM_CAUSAL_WRITER = saved;
    }
  });
});

describe("D11 `clawmem watch` on a vault with no collections (test 27)", () => {
  it("starts the worker, which drains an owed handoff render; SIGTERM exits cleanly", async () => {
    const root = tmp();
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), "collections: {}\n");
    const vaultPath = join(root, "index.sqlite");
    const store = createStore(vaultPath);
    failSummary = true;
    const path = writeTranscriptFile(root, "s.jsonl", turn(1, 100));
    await handoffGenerator(store, { sessionId: "s", transcriptPath: path });
    store.db.prepare(`UPDATE session_docs SET ended_at = ? WHERE kind = 'handoff'`).run(iso(0));
    expect(handoff(store)!.render_needed).toBe(1);
    store.close();

    mkdirSync(join(root, "run"), { recursive: true });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAWMEM_") && k !== "INDEX_PATH") env[k] = v;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/clawmem.ts"), "watch"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: {
        ...env, INDEX_PATH: vaultPath, CLAWMEM_CONFIG_DIR: configDir, CLAWMEM_NO_LOCAL_MODELS: "true",
        CLAWMEM_EMBED_URL: "http://127.0.0.1:1", CLAWMEM_LLM_URL: "http://127.0.0.1:1", CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
        CLAWMEM_PREWARM_INTERVAL_MS: "0", NO_COLOR: "1", XDG_RUNTIME_DIR: join(root, "run"),
      },
    });
    let rendered = false;
    const probe = new Database(vaultPath, { readonly: true });
    try {
      for (let i = 0; i < 200 && !rendered; i++) {
        await Bun.sleep(100);
        rendered = (probe.prepare(`SELECT render_needed FROM session_docs WHERE kind = 'handoff'`).get() as { render_needed: number }).render_needed === 0;
      }
    } finally {
      probe.close();
      proc.kill("SIGTERM");
    }
    const code = await Promise.race([proc.exited, Bun.sleep(8000).then(() => null)]);
    if (code === null) proc.kill("SIGKILL");
    const out = await new Response(proc.stdout).text();
    if (!rendered) console.error(out, await new Response(proc.stderr).text());
    expect(rendered).toBe(true);
    expect(out).toContain("stop-pipeline worker started");
    expect(code).toBe(0);
  }, 30_000);
});
