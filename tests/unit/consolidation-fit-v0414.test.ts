/**
 * v0.41.4 rider 68.6 — consolidation's prompts fit the LLM's context, with provenance kept (DESIGN-v0414.md r7 §6.1).
 *
 * Baseline (v0.41.3): cluster synthesis sent every unconsolidated observation of a collection (up to 50, ~500 chars
 * each) and the deductive pass up to 20, through `generate()`, with no count against the server's context. On the
 * documented `-c 4096` the prompt overflowed, the server answered 400, `generate()` returned null and the pass did
 * nothing — silently, every tick. A cut reply was read as complete. Each test fails on v0.41.3 for the reason its name
 * gives.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createTestStore } from "../helpers/test-store.ts";
import { fakeBudgetLlm, type FakeReply } from "../helpers/fake-budget-llm.ts";
import { consolidateObservations, generateDeductiveObservations } from "../../src/consolidation.ts";
import type { Store } from "../../src/store.ts";

let store: Store;
beforeEach(() => { store = createTestStore(); });

function seed(path: string, title: string, contentType: string, observationType: string | null): number {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const facts = `${title} carried a long fact about the observer and its windows. `.repeat(6);
  store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, `# ${title}\n${facts}`, now);
  store.db.prepare(
    `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, content_type, observation_type, facts, narrative)
     VALUES ('test', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(path, title, hash, now, now, contentType, observationType, facts, "A narrative that explains why the change was made.");
  return (store.db.prepare(`SELECT id FROM documents WHERE path = ?`).get(path) as { id: number }).id;
}
/** The numbered sources a synthesis prompt shows ("1. [" … ), in order. */
const numbered = (prompt: string) => [...prompt.matchAll(/^(\d+)\. \[/gm)].map(m => Number(m[1]));
const clusterPrompt = (p: string) => p.includes("identify recurring patterns");
const deductivePrompt = (p: string) => p.includes("Find logical deductions");

describe("v0.41.4 68.6 cluster synthesis fits its prompt and keeps provenance", () => {
  it("the prompt fits the context with the reply; an index past the kept sources is refused, the kept ones map to their documents", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => seed(`o${i}.md`, `Observation ${i}`, "observation", "discovery"));
    let kept = 0;
    const fake = fakeBudgetLlm({
      nCtx: 2048,
      reply: (p): FakeReply => {
        if (!clusterPrompt(p)) return "[]";
        kept = numbered(p).length;
        return JSON.stringify([{ observation: "Observations 1 and 2 share the observer windows", proof_count: 3, source_indices: [1, 2, kept + 1] }]);
      },
    });
    await consolidateObservations(store, fake.llm as any);
    const calls = fake.calls.filter(c => clusterPrompt(c.prompt));
    expect(calls.length).toBe(1);
    expect(calls[0]!.promptTokens + 500).toBeLessThanOrEqual(2048);
    expect(kept).toBeGreaterThanOrEqual(2);
    expect(kept).toBeLessThan(40);
    const row = store.db.prepare(`SELECT source_doc_ids, proof_count FROM consolidated_observations`).get() as { source_doc_ids: string; proof_count: number } | null;
    expect(row).not.toBeNull();
    const shown = calls[0]!.prompt.match(/^1\. \[[^\]]*\] "([^"]+)"[\s\S]*?^2\. \[[^\]]*\] "([^"]+)"/m)!;
    const idOf = (title: string) => (store.db.prepare(`SELECT id FROM documents WHERE title = ?`).get(title) as { id: number }).id;
    expect(JSON.parse(row!.source_doc_ids)).toEqual([idOf(shown[1]!), idOf(shown[2]!)]);
    expect(row!.proof_count).toBe(2);
    void ids;
  });

  it("fewer than two sources fit → no synthesis and no call", async () => {
    for (let i = 0; i < 5; i++) seed(`o${i}.md`, `Observation ${i}`, "observation", "discovery");
    const fake = fakeBudgetLlm({ nCtx: 700, reply: () => "[]" });   // 200 tokens of prompt room: not even the fixed part and two sources
    await consolidateObservations(store, fake.llm as any);
    expect(fake.calls.filter(c => clusterPrompt(c.prompt)).length).toBe(0);
  });

  it("a cut reply is not a synthesis", async () => {
    for (let i = 0; i < 3; i++) seed(`o${i}.md`, `Observation ${i}`, "observation", "discovery");
    const json = JSON.stringify([{ observation: "Observations 1 and 2 share the observer windows", proof_count: 2, source_indices: [1, 2] }]);
    const fake = fakeBudgetLlm({ nCtx: 8192, reply: (p): FakeReply => (clusterPrompt(p) ? { text: json, finish: "length" } : "[]") });
    await consolidateObservations(store, fake.llm as any);
    expect(fake.calls.filter(c => clusterPrompt(c.prompt)).length).toBe(1);
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM consolidated_observations`).get()).toEqual({ n: 0 });
  });
});

describe("v0.41.4 68.6 the deductive pass fits its prompt; its statistics count the kept sources", () => {
  it("the draft prompt fits the context with the reply, and `considered` is the number of sources it showed", async () => {
    for (let i = 0; i < 20; i++) seed(`d${i}.md`, `Decision ${i}`, "decision", "decision");
    const fake = fakeBudgetLlm({ nCtx: 2048, reply: () => "[]" });
    const stats = await generateDeductiveObservations(store, fake.llm as any);
    const calls = fake.calls.filter(c => deductivePrompt(c.prompt));
    expect(calls.length).toBe(1);
    expect(calls[0]!.promptTokens + 500).toBeLessThanOrEqual(2048);
    const shown = [...calls[0]!.prompt.matchAll(/^\[(\d+)\] \(/gm)].length;
    expect(shown).toBeGreaterThanOrEqual(2);
    expect(shown).toBeLessThan(20);
    expect(stats.considered).toBe(shown);
    expect(stats.nullCalls).toBe(0);
  });
});
