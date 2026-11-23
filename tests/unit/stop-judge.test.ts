/**
 * 62.1 D3/D8: the judge split around Phase B, its pair memory and its deferral queue (design test 12).
 *
 * Baseline (8e2579a): every Stop re-judges the same decisions against the same old documents and applies each verdict
 * again (a contradiction erodes −0.25 per Stop until the floor); a verdict is applied to whatever the old document holds
 * at apply time, even when it was rewritten after the judge read it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { canonicalDocId, DEFAULT_EMBED_MODEL, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { decisionExtractor } from "../../src/hooks/decision-extractor.ts";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { human, assistant, writeTranscriptFile, appendEntries } from "./stop-fixtures.ts";

import { seedContent } from "../helpers/seed-content.ts";
let server: ReturnType<typeof Bun.serve>;
let hits = 0;
const VERDICT = [{ new_idx: 0, old_idx: 0, relation: "contradiction", confidence: 0.9, reasoning: "The new decision reverses the earlier runtime choice." }];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async () => {
      hits++;
      return Response.json({ choices: [{ message: { content: JSON.stringify(VERDICT) }, finish_reason: "stop" }], model: "test-judge" });
    },
  });
});
afterAll(() => server.stop(true));

const ENV = ["CLAWMEM_JUDGE_URL", "CLAWMEM_JUDGE_PROVIDER", "CLAWMEM_JUDGE_MODEL", "CLAWMEM_CAUSAL_WRITER"];
let saved: Record<string, string | undefined>;
const dirs: string[] = [];
beforeEach(() => {
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  process.env.CLAWMEM_JUDGE_URL = `http://127.0.0.1:${server.port}`;
  process.env.CLAWMEM_JUDGE_PROVIDER = "openai";
  process.env.CLAWMEM_JUDGE_MODEL = "test-judge";
  delete process.env.CLAWMEM_CAUSAL_WRITER;
  hits = 0;
  setDefaultLlamaCpp({
    generate: async (prompt: string) => {
      if (!prompt.includes("Extract observations:")) return { text: "", model: "fake", done: true };
      return {
        text: `<observation><type>decision</type><title>Adopt bun for the build</title><facts><fact>The team adopted bun as the build runtime</fact></facts><narrative>Faster installs.</narrative></observation>`,
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
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-621-judge-")); dirs.push(d); return d; }

/** A prior-session decision the judge's vector search finds (every text embeds to one vector). */
function priorDecision(store: Store): number {
  const path = "decisions/2026-08-01-othersess.md";
  const body = "The team adopted node as the build runtime — prior decision record.";
  const hash = createHash("sha256").update(body).digest("hex");
  seedContent(store.db, hash, body, "2026-08-01T00:00:00.000Z");
  store.insertDocument("_clawmem", path, "Decisions 2026-08-01", hash, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  const id = store.findActiveDocument("_clawmem", path)!.id;
  store.db.prepare(`UPDATE documents SET content_type = 'decision', confidence = 0.8 WHERE id = ?`).run(id);
  (store as any).ensureVecTable(4);
  (store as any).insertEmbedding(hash, 0, 0, new Float32Array([1, 0, 0, 0]), DEFAULT_EMBED_MODEL, new Date().toISOString(), "full", undefined,
    canonicalDocId("_clawmem", path));
  return id;
}
const confidence = (store: Store, id: number) => (store.db.prepare(`SELECT confidence FROM documents WHERE id = ?`).get(id) as { confidence: number }).confidence;
const turn = (n: number, t: number) => [human(`question for turn ${n}`, t), assistant(`For turn ${n} we decided to adopt bun as the build runtime, replacing node.`, t + 5)];

describe("D3/D8 the judge applies a verdict once, to the content it judged (test 12)", () => {
  it("the same (fact, old content) judged again erodes once: pair memory skips the second call", async () => {
    const store = createTestStore();
    const prior = priorDecision(store);
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(hits).toBe(1);
    expect(confidence(store, prior)).toBeCloseTo(0.55, 6);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM judge_pair_verdicts`).get() as { n: number }).n).toBe(1);
    appendEntries(path, turn(2, 200));   // the observer re-emits the same decision fact
    await decisionExtractor(store, { sessionId: "sess0001-a", transcriptPath: path });
    expect(hits).toBe(1);
    expect(confidence(store, prior)).toBeCloseTo(0.55, 6);
  });

  it("an old document rewritten between Phase A and Phase B is deferred, then re-judged against its current content", async () => {
    const store = createTestStore();
    const prior = priorDecision(store);
    const path = writeTranscriptFile(tmp(), "s.jsonl", turn(1, 100));
    const { runDecisionExtraction } = await import("../../src/stop-extract.ts");
    await runDecisionExtraction(store, {
      sessionId: "sess0001-a", transcriptPath: path,
      beforePhaseB: () => {
        const body = "The team adopted node as the build runtime — revised record with a new rationale.";
        const hash = createHash("sha256").update(body).digest("hex");
        seedContent(store.db, hash, body, new Date().toISOString());
        store.updateDocument(prior, "Decisions 2026-08-01", hash, new Date().toISOString());
      },
    });
    expect(confidence(store, prior)).toBeCloseTo(0.8, 6);   // nothing applied to content the judge never saw
    const q = store.db.prepare(`SELECT state, old_doc_id FROM judge_deferred`).all() as { state: string; old_doc_id: number }[];
    expect(q).toEqual([{ state: "queued", old_doc_id: prior }]);

    const { rejudgeDeferred } = await import("../../src/stop-judge.ts");
    const deadline = deadlineAfter(monoNow(), duration(30_000));
    expect(await rejudgeDeferred(store, deadline)).toBe(0);   // not due yet (backoff)
    store.db.prepare(`UPDATE judge_deferred SET next_retry_at = '2000-01-01T00:00:00.000Z'`).run();
    expect(await rejudgeDeferred(store, deadline)).toBe(1);
    expect(confidence(store, prior)).toBeCloseTo(0.55, 6);
    expect((store.db.prepare(`SELECT state FROM judge_deferred`).get() as { state: string }).state).toBe("done");
  });

  it("a deferred pair whose old document is no longer active becomes obsolete", async () => {
    const store = createTestStore();
    const prior = priorDecision(store);
    store.db.prepare(
      `INSERT INTO judge_deferred (fact_fp, old_doc_id, fact_payload, session_id, queued_at, attempts, next_retry_at, state)
       VALUES ('fp', ?, '{"fact":"x","factDocId":null}', 's', '2026-09-30T00:00:00.000Z', 0, NULL, 'queued')`
    ).run(prior);
    store.archiveDocuments([prior]);
    const { rejudgeDeferred } = await import("../../src/stop-judge.ts");
    expect(await rejudgeDeferred(store, deadlineAfter(monoNow(), duration(30_000)))).toBe(1);
    expect((store.db.prepare(`SELECT state FROM judge_deferred`).get() as { state: string }).state).toBe("obsolete");
    expect(hits).toBe(0);
  });
});
