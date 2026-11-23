/**
 * BACKLOG 82.3, D7 — the normalised fields that are written OUTSIDE a body: one test per writer, each given a value
 * that starts with a byte-order mark. The value is stored without the mark; nothing is refused.
 *
 * No mark is typed into this file: each is built with `String.fromCharCode`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { createStore, type Store } from "../../src/store.ts";
import { ensureEntityCanonical, recordEntityMention, upsertEntity } from "../../src/entity.ts";
import { normalizedContent } from "../../src/text-policy.ts";
import { splitDocument } from "../../src/splitter.ts";
import { classifyIntent } from "../../src/intent.ts";
import { parseHookInput } from "../../src/hooks.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];

const ROOT = "/tmp/clawmem-normalised-writers-test";
const NOW = "2026-11-22T00:00:00.000Z";
let store: Store;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  store = createStore(`${ROOT}/vault.sqlite`);
});
afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(ROOT, { recursive: true, force: true });
});

const seed = (path: string): void => {
  const { body, hash } = normalizedContent(`body of ${path}`);
  store.insertContent(hash, body, NOW);
  store.insertDocument("_clawmem", path, "a title", hash, NOW, NOW);
};

describe("updateObservationFields normalises its scalar fields", () => {
  const fieldsOf = (path: string) =>
    store.db.prepare(`SELECT observation_type, narrative, skill_name, obs_quality_score, failure_reason, facts, concepts, files_read, files_modified,
                             hex(CAST(narrative AS BLOB)) AS narrative_bytes
                      FROM documents WHERE collection = '_clawmem' AND path = ?`).get(path) as Record<string, string | null>;

  test.each(MARKS)("every scalar led by %s is stored without it; the JSON lists are stored as given", (_name, mark) => {
    seed("observations/one.md");
    const lists = { facts: JSON.stringify([mark + "a fact"]), concepts: JSON.stringify(["c"]), files_read: JSON.stringify([]), files_modified: JSON.stringify(["src/a.ts"]) };
    (store.updateObservationFields as (p: string, c: string, f: Record<string, string>) => void)("observations/one.md", "_clawmem", {
      observation_type: mark + "decision",
      narrative: mark + mark + "The conclusion of a deduction.",
      skill_name: mark + "codex-review",
      quality_score: mark + "0.8",
      failure_reason: mark + "wrong_output",
      ...lists,
    });
    const row = fieldsOf("observations/one.md");
    expect(row.observation_type).toBe("decision");
    expect(row.narrative).toBe("The conclusion of a deduction.");
    expect(row.narrative_bytes).toBe(Buffer.from("The conclusion of a deduction.", "utf-8").toString("hex").toUpperCase());
    expect(row.skill_name).toBe("codex-review");
    expect(String(row.obs_quality_score)).toBe("0.8");
    expect(row.failure_reason).toBe("wrong_output");
    expect({ facts: row.facts, concepts: row.concepts, files_read: row.files_read, files_modified: row.files_modified }).toEqual(lists);
  });

  test("a mark that is not at the start stays", () => {
    seed("observations/two.md");
    const inside = "a" + FEFF + "b" + FFFE;
    store.updateObservationFields("observations/two.md", "_clawmem", { narrative: inside });
    expect(fieldsOf("observations/two.md").narrative).toBe(inside);
  });
});

describe("entity names, types and mentions are normalised at ingestion", () => {
  const nodes = () => store.db.prepare(`SELECT entity_id, entity_type, name, mention_count FROM entity_nodes ORDER BY entity_id`).all() as
    { entity_id: string; entity_type: string; name: string; mention_count: number }[];

  test.each(MARKS)("upsertEntity given a name and a type led by %s: one entity, stored without the mark", (_name, mark) => {
    const plain = upsertEntity(store.db, "Forgejo", "tool");
    const marked = upsertEntity(store.db, mark + "Forgejo", mark + "tool");
    expect(marked).toBe(plain);                                             // the same entity, not a second one
    expect(nodes()).toEqual([{ entity_id: plain, entity_type: "tool", name: "Forgejo", mention_count: 2 }]);
  });

  test.each(MARKS)("upsertEntity alone, with %s: the stored name and type have no mark", (_name, mark) => {
    const id = upsertEntity(store.db, mark + mark + "Proxmox", mark + "tool");
    expect(nodes()).toEqual([{ entity_id: id, entity_type: "tool", name: "Proxmox", mention_count: 1 }]);
    const fts = store.db.prepare(`SELECT name, entity_type FROM entities_fts WHERE entity_id = ?`).get(id) as { name: string; entity_type: string };
    expect(fts).toEqual({ name: "proxmox", entity_type: "tool" });
  });

  test.each(MARKS)("ensureEntityCanonical with %s", (_name, mark) => {
    const id = ensureEntityCanonical(store.db, mark + "Talos", mark + "tool");
    expect(nodes()).toEqual([{ entity_id: id, entity_type: "tool", name: "Talos", mention_count: 0 }]);
    expect(ensureEntityCanonical(store.db, "Talos", "tool")).toBe(id);
  });

  test.each(MARKS)("recordEntityMention with a mention text led by %s", (_name, mark) => {
    seed("observations/m.md");
    const docId = (store.db.prepare(`SELECT id FROM documents WHERE path = 'observations/m.md'`).get() as { id: number }).id;
    const id = upsertEntity(store.db, "Bun", "tool");
    recordEntityMention(store.db, id, docId, mark + "the Bun runtime");
    const row = store.db.prepare(`SELECT mention_text FROM entity_mentions WHERE entity_id = ? AND doc_id = ?`).get(id, docId) as { mention_text: string };
    expect(row.mention_text).toBe("the Bun runtime");
  });
});

describe("a triple's predicate, object literal and provenance fact are normalised", () => {
  const triples = () => store.db.prepare(`SELECT id, predicate, object_literal, source_fact, valid_to FROM entity_triples ORDER BY id`).all() as
    { id: number; predicate: string; object_literal: string | null; source_fact: string | null; valid_to: string | null }[];
  const evidence = () => store.db.prepare(`SELECT triple_id, source_fact FROM entity_triple_provenance ORDER BY rowid`).all() as
    { triple_id: number; source_fact: string | null }[];

  test.each(MARKS)("%s: the marked triple IS the plain one — one row, two sightings", (_name, mark) => {
    const subject = upsertEntity(store.db, "ClawMem", "project");
    const first = store.addTriple(subject, "runs on", null, "Bun", { sourceFact: "ClawMem runs on Bun" });
    const again = store.addTriple(subject, mark + "runs on", null, mark + "Bun", { sourceFact: mark + "ClawMem runs on Bun" });
    expect(again).toBe(first);
    expect(triples()).toEqual([{ id: first, predicate: "runs_on", object_literal: "Bun", source_fact: "ClawMem runs on Bun", valid_to: null }]);
    expect(evidence()).toEqual([{ triple_id: first, source_fact: "ClawMem runs on Bun" }]);   // the same fact twice is one evidence row
  });

  test.each(MARKS)("%s: stored alone, no part keeps the mark; the predicate has no underscore for it", (_name, mark) => {
    const subject = upsertEntity(store.db, "ClawMem", "project");
    const id = store.addTriple(subject, mark + mark + "Depends On", null, mark + "sqlite-vec", { sourceFact: mark + "a fact" });
    expect(triples()).toEqual([{ id, predicate: "depends_on", object_literal: "sqlite-vec", source_fact: "a fact", valid_to: null }]);
    expect(evidence()).toEqual([{ triple_id: id, source_fact: "a fact" }]);
  });

  test.each(MARKS)("%s: invalidateTriple finds the triple by the same normalised key", (_name, mark) => {
    const subject = upsertEntity(store.db, "ClawMem", "project");
    store.addTriple(subject, "runs on", null, "Bun");
    expect(store.invalidateTriple(subject, mark + "runs on", null, mark + "Bun", "2026-11-22")).toBe(1);
    expect(triples()[0]!.valid_to).toBe("2026-11-22");
  });
});

describe("a fragment label is a normalised field", () => {
  const filler = "A sentence that is long enough to be kept as a fragment of its own, said more than once. ".repeat(3);

  test.each(MARKS)("a section heading led by %s gives a label without it", (_name, mark) => {
    const body = `# Title\n\n${filler}\n\n## ${mark}Marked section\n\n${filler}\n\n### ${mark}${mark}Deeper\n\n${filler}\n`;
    const labels = splitDocument(body).filter(f => f.type === "section").map(f => f.label);
    expect(labels).toContain("Marked section");
    expect(labels).toContain("Deeper");
    for (const label of labels) expect(label === null || (label.charCodeAt(0) !== 0xfeff && label.charCodeAt(0) !== 0xfffe)).toBe(true);
  });

  test.each(MARKS)("a frontmatter key led by %s gives a label without it", (_name, mark) => {
    const body = `# Title\n\n${filler}\n\n## Section\n\n${filler}\n`;
    const labels = splitDocument(body, { [mark + "owner"]: "the platform team" }).filter(f => f.type === "frontmatter").map(f => f.label);
    expect(labels).toEqual(["owner"]);
  });
});

describe("stored query text is a normalised field", () => {
  const llm = { generate: async () => null } as any;

  test.each(MARKS)("the intent cache: a query led by %s is cached as the query without it, under the same key", async (_name, mark) => {
    const plain = await classifyIntent("why did we choose the canister filter", llm, store.db);
    const marked = await classifyIntent(mark + mark + "why did we choose the canister filter", llm, store.db);
    expect(marked).toMatchObject({ intent: plain.intent });
    const rows = store.db.prepare(`SELECT query_text FROM intent_classifications`).all();
    expect(rows).toEqual([{ query_text: "why did we choose the canister filter" }]);   // ONE row: the same query
  });

  test.each(MARKS)("the usage log: a query text led by %s", (_name, mark) => {
    const id = store.insertUsage({
      sessionId: "sess-1", timestamp: NOW, hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0, wasReferenced: 0,
      queryText: mark + "when is the filter cleaned",
    } as any);
    const row = store.db.prepare(`SELECT query_text FROM context_usage WHERE id = ?`).get(id) as { query_text: string };
    expect(row.query_text).toBe("when is the filter cleaned");
  });

  test.each(MARKS)("a hook's prompt led by %s is read without it; the session id is left as it is", (_name, mark) => {
    const input = parseHookInput(JSON.stringify({ session_id: "sess-1", prompt: mark + "when is the filter cleaned", hook_event_name: "UserPromptSubmit" }));
    expect(input.prompt).toBe("when is the filter cleaned");
    expect(input.sessionId).toBe("sess-1");
    expect(parseHookInput(JSON.stringify({ prompt: 7 })).prompt as unknown).toBe(7);          // not a string: passed as it was
  });
});
