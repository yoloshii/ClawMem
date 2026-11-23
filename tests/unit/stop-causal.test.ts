/**
 * 62.1 D3: the causal step at most once per committed range, through the `causal_due` marker (design tests 13, 32,
 * 35, 39, 41).
 *
 * Baseline (8e2579a): the causal step runs on EVERY Stop over the re-extracted observations with a random run key, so
 * the same range is inferred again each Stop; its window is unbounded, so a delayed run sees documents written after
 * the range; and a crash between the commit and the step leaves nothing that owes the run.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { setDefaultLlamaCpp, getDefaultLlamaCpp } from "../../src/llm.ts";
import { decisionExtractor } from "../../src/hooks/decision-extractor.ts";
import { runDecisionExtraction } from "../../src/stop-extract.ts";
import { drainCausalMarkers, causalRunKey } from "../../src/stop-causal.ts";
import { runCausalStep } from "../../src/causal-writer.ts";
import { transcriptKey } from "../../src/stop-pairing.ts";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { human, assistant, writeTranscriptFile } from "./stop-fixtures.ts";

import { seedContent } from "../helpers/seed-content.ts";
const dirs: string[] = [];
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.CLAWMEM_CAUSAL_WRITER;
  setDefaultLlamaCpp({
    generate: async (prompt: string) => {
      if (prompt.includes("Extract observations:")) {
        return { text: `<observation><type>decision</type><title>Adopt bun</title><facts><fact>The team adopted bun</fact></facts><narrative>Speed.</narrative></observation>`, model: "fake", done: true };
      }
      return { text: "[]", model: "fake", done: true };
    },
    embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: "fake" }),
  } as any);
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.CLAWMEM_CAUSAL_WRITER; else process.env.CLAWMEM_CAUSAL_WRITER = savedMode;
  setDefaultLlamaCpp(null);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-621-causal-")); dirs.push(d); return d; }
const deadline = () => deadlineAfter(monoNow(), duration(30_000));
const runs = (store: Store) => store.db.prepare(`SELECT run_key, mode, window_doc_count FROM causal_runs ORDER BY id`).all() as { run_key: string; mode: string; window_doc_count: number }[];
const markers = (store: Store) => store.db.prepare(`SELECT run_key, state, mode FROM causal_due ORDER BY id`).all() as { run_key: string; state: string; mode: string }[];
const transcript = () => writeTranscriptFile(tmp(), "s.jsonl", [human("question for turn 1", 100), assistant("For turn 1 we decided to adopt bun as the build runtime after the benchmark.", 105)]);

describe("D3 one causal run per committed range (tests 13, 32)", () => {
  it("a committed range runs its step once under stop:<session>:<transcript key>:<range key>; a second Phase C starts nothing", async () => {
    process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
    const store = createTestStore();
    const path = transcript();
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    const r = runs(store);
    expect(r.length).toBe(1);
    expect(r[0]!.run_key.startsWith(`stop:sess0001-a:${transcriptKey(path)}:0-`)).toBe(true);
    expect(markers(store)).toEqual([]);
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });   // no new turn
    expect(await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() })).toBe(0);
    expect(runs(store).length).toBe(1);
  });

  it("a crash between Phase B and Phase C leaves the marker; a later consumer starts the run exactly once (test 32)", async () => {
    process.env.CLAWMEM_CAUSAL_WRITER = "on";
    const store = createTestStore();
    await runDecisionExtraction(store, { sessionId: "sess0001-a", transcriptPath: transcript() });   // no Phase C
    expect(markers(store).map(m => [m.state, m.mode])).toEqual([["queued", "on"]]);
    expect(runs(store).length).toBe(0);
    expect(await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() })).toBe(1);
    expect(await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() })).toBe(0);
    expect(runs(store).length).toBe(1);
    expect(markers(store)).toEqual([]);
  });
});

describe("D3 the recorded and the current mode (tests 35, 41)", () => {
  async function owed(mode: "shadow" | "on") {
    process.env.CLAWMEM_CAUSAL_WRITER = mode;
    const store = createTestStore();
    await runDecisionExtraction(store, { sessionId: "sess0001-a", transcriptPath: transcript() });
    return store;
  }

  it("the run never escalates past the mode recorded at commit, nor past the current one", async () => {
    const store = await owed("on");
    process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
    await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() });
    expect(runs(store).map(r => r.mode)).toEqual(["shadow"]);
  });

  it("while the current mode is off, a marker waits unclaimed; two consumers racing start one run", async () => {
    const store = await owed("on");
    process.env.CLAWMEM_CAUSAL_WRITER = "off";
    expect(await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() })).toBe(0);
    expect(markers(store).map(m => m.state)).toEqual(["queued"]);
    process.env.CLAWMEM_CAUSAL_WRITER = "on";
    const [a, b] = await Promise.all([
      drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() }),
      drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() }),
    ]);
    expect(a + b).toBe(1);
    expect(runs(store).length).toBe(1);
  });

  it("a marker whose run row already exists is cleared in every mode, and never started again (test 41)", async () => {
    const store = await owed("on");
    const key = markers(store)[0]!.run_key;
    store.db.prepare(`INSERT INTO causal_runs (run_key, session_id, source, mode, outcome, started_at) VALUES (?, 'sess0001-a', 'stop_hook', 'on', 'in_progress', ?)`)
      .run(key, new Date().toISOString());
    process.env.CLAWMEM_CAUSAL_WRITER = "off";
    await drainCausalMarkers(store, getDefaultLlamaCpp(), { deadline: deadline() });
    expect(markers(store)).toEqual([]);
    expect(runs(store).length).toBe(1);
  });
});

describe("D3 the window as it stood at commit (test 39)", () => {
  it("windowAt excludes a late backfill (backdated authorship) and a document revised after it", async () => {
    const store = createTestStore();
    const obs = (path: string, created: string, modified: string, authored: string | null) => {
      seedContent(store.db, `h-${path}`, `# ${path}`, created);
      store.insertDocument("_clawmem", path, path, `h-${path}`, created, modified);
      const id = store.findActiveDocument("_clawmem", path)!.id;
      store.db.prepare(`UPDATE documents SET observation_type = 'discovery', facts = ?, authored_at = ?, created_at = ?, modified_at = ? WHERE id = ?`)
        .run(JSON.stringify([`fact of ${path}`]), authored, created, modified, id);
      return id;
    };
    const windowAt = "2026-09-30T12:00:00.000Z";
    const newId = obs("observations/new.md", "2026-09-30T11:59:00.000Z", "2026-09-30T11:59:00.000Z", null);
    obs("observations/before.md", "2026-09-30T10:00:00.000Z", "2026-09-30T10:00:00.000Z", null);
    obs("observations/backfill.md", "2026-09-30T13:00:00.000Z", "2026-09-30T13:00:00.000Z", "2026-01-01T00:00:00.000Z");
    obs("observations/revised.md", "2026-09-30T09:00:00.000Z", "2026-09-30T14:00:00.000Z", null);
    await runCausalStep(store, getDefaultLlamaCpp() as any, {
      sessionId: "s", mode: "shadow", newObservations: [{ docId: newId, facts: ["fact of observations/new.md"] }],
      deadline: deadline(), runKey: causalRunKey("s", "tk", "0-0-1-x"), windowAt,
    });
    expect(runs(store)).toEqual([{ run_key: "stop:s:tk:0-0-1-x", mode: "shadow", window_doc_count: 1 }]);
  });
});
