/**
 * BACKLOG 82.3, D7 — consolidated observation text is a NORMALISED field (D7 table: "consolidated observation text
 * (`src/consolidation.ts`) | normalise | at each writer, before any deduplication key or hash is built from the
 * value"). The text comes from a model's reply; a reply whose observation starts with a byte-order mark is stored,
 * compared and merged as the text after the mark.
 *
 * The writers: the new-row insert of the cluster pass, `applyContradictoryConsolidationCore` (a contradicting row)
 * and `mergeIntoExistingConsolidation` (a merge). The deduplication key: `findSimilarConsolidation` is called with
 * the normalised text, so a marked copy of a stored observation merges into it instead of becoming a second row.
 * No mark is typed into this file.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestStore } from "../helpers/test-store.ts";
import { fakeBudgetLlm, type FakeReply } from "../helpers/fake-budget-llm.ts";
import {
  applyContradictoryConsolidationCore, consolidateObservations, mergeIntoExistingConsolidation,
} from "../../src/consolidation.ts";
import { normalizedContent } from "../../src/text-policy.ts";
import type { Store } from "../../src/store.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];
const TEXT = "Observer windows share the same retry schedule across sessions";

let store: Store;
beforeEach(() => { store = createTestStore(); });

function seed(path: string, title: string): number {
  const now = new Date().toISOString();
  const facts = `${title}: the observer windows retry on the same schedule. `.repeat(3);
  const { body, hash } = normalizedContent(`# ${title}\n${facts}`);
  store.insertContent(hash, body, now);
  store.db.prepare(
    `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, content_type, observation_type, facts, narrative)
     VALUES ('test', ?, ?, ?, ?, ?, 1, 'observation', 'discovery', ?, 'A narrative.')`,
  ).run(path, title, hash, now, now, facts);
  return (store.db.prepare(`SELECT id FROM documents WHERE path = ?`).get(path) as { id: number }).id;
}
const clusterPrompt = (p: string) => p.includes("identify recurring patterns");
const rows = () => store.db.prepare(`SELECT id, observation, hex(substr(CAST(observation AS BLOB), 1, 3)) AS head, proof_count FROM consolidated_observations ORDER BY id`).all() as
  { id: number; observation: string; head: string; proof_count: number }[];
const replyWith = (observation: string) => fakeBudgetLlm({
  nCtx: 8192,
  reply: (p): FakeReply => (clusterPrompt(p) ? JSON.stringify([{ observation, proof_count: 2, source_indices: [1, 2] }]) : "[]"),
});

describe("the cluster pass stores a new observation without its leading marks", () => {
  test.each(MARKS)("%s (twice) before the text", async (_name, mark) => {
    seed("a.md", "Observation A");
    seed("b.md", "Observation B");
    await consolidateObservations(store, replyWith(mark + mark + TEXT).llm as any);
    const got = rows();
    expect(got.map(r => r.observation)).toEqual([TEXT]);
    expect(got[0]!.head).toBe(Buffer.from(TEXT.slice(0, 3)).toString("hex").toUpperCase());
  });

  test("control: the plain text is stored as it is, and a mark inside the text is kept", async () => {
    seed("a.md", "Observation A");
    seed("b.md", "Observation B");
    const inner = `Observer ${FEFF}windows share the same retry schedule`;
    await consolidateObservations(store, replyWith(inner).llm as any);
    expect(rows().map(r => r.observation)).toEqual([inner]);
  });
});

describe("the deduplication key is built from the normalised text", () => {
  // Three words of more than three letters: a mark glued to the first one leaves 2 of 4 words shared — Jaccard 0.5,
  // which does NOT shortlist (the gate is > 0.5) — while the normalised copy shares all three.
  const SHORT = "Observer windows retry";
  const mergeCase = async (observation: string) => {
    seed("a.md", "Observation A");
    seed("b.md", "Observation B");
    seed("c.md", "Observation C");
    // its sources are other documents: a source of a stored observation is not offered to the pass again
    store.db.prepare(`INSERT INTO consolidated_observations (observation, proof_count, source_doc_ids, trend, status, collection) VALUES (?, 2, '[9001, 9002]', 'NEW', 'active', 'test')`)
      .run(SHORT);
    await consolidateObservations(store, fakeBudgetLlm({
      nCtx: 8192,
      reply: (p): FakeReply => (clusterPrompt(p) ? JSON.stringify([{ observation, proof_count: 3, source_indices: [1, 2, 3] }]) : "[]"),
    }).llm as any);
    return rows().map(r => ({ observation: r.observation, proof_count: r.proof_count }));
  };

  test("control: a plain copy of a stored observation merges into it (one row, its proof grows from 2 to 5)", async () => {
    expect(await mergeCase(SHORT)).toEqual([{ observation: SHORT, proof_count: 5 }]);
  });

  test.each(MARKS)("a %s-led copy merges the same way, instead of adding a second row", async (_name, mark) => {
    expect(await mergeCase(mark + SHORT)).toEqual([{ observation: SHORT, proof_count: 5 }]);
  });
});

describe("the two exported writers normalise what they are given", () => {
  test.each(MARKS)("mergeIntoExistingConsolidation: %s", (_name, mark) => {
    store.db.prepare(`INSERT INTO consolidated_observations (observation, proof_count, source_doc_ids, trend, status, collection) VALUES ('old text', 1, '[1]', 'NEW', 'active', 'test')`).run();
    const existing = store.db.prepare(`SELECT id, source_doc_ids FROM consolidated_observations`).get() as { id: number; source_doc_ids: string };
    mergeIntoExistingConsolidation(store, existing, [2], mark + mark + TEXT);
    expect(rows().map(r => r.observation)).toEqual([TEXT]);
  });

  test.each(MARKS)("applyContradictoryConsolidationCore: %s", (_name, mark) => {
    store.db.prepare(`INSERT INTO consolidated_observations (observation, proof_count, source_doc_ids, trend, status, collection) VALUES ('old text', 1, '[1]', 'NEW', 'active', 'test')`).run();
    const existing = store.db.prepare(`SELECT id, observation, source_doc_ids FROM consolidated_observations`).get() as { id: number; observation: string; source_doc_ids: string };
    const { newId } = applyContradictoryConsolidationCore(store, existing, mark + TEXT, [2, 3], "test", "link");
    expect(rows().find(r => r.id === newId)!.observation).toBe(TEXT);
    expect(rows().find(r => r.id === existing.id)!.observation).toBe("old text");
  });
});
