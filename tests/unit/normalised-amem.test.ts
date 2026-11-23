/**
 * BACKLOG 82.3, D7 — A-MEM text is a normalised field: a note's `context`, and an evolution's `context` and
 * `reasoning` (model output), are stored without a leading byte-order mark. Nothing is refused: before the fix the
 * guard refused these bindings and the note or the evolution was silently not written.
 *
 * No mark is typed into this file: each is built with `String.fromCharCode`.
 */
import { describe, expect, test } from "bun:test";
import { evolveMemories, storeMemoryNote } from "../../src/amem.ts";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];

describe("A-MEM text is stored without a leading mark", () => {
  test.each(MARKS)("storeMemoryNote: a context led by %s", (_name, mark) => {
    const store = createTestStore();
    const [docId] = seedDocuments(store, [{ path: "mem.md", title: "Memory A", body: "memory body" }]) as [number];
    expect(storeMemoryNote(store, docId, { keywords: ["k"], tags: ["t"], context: mark + mark + "What this memory is about." })).toBe(true);
    const row = store.db.prepare(`SELECT amem_context, amem_keywords, amem_tags FROM documents WHERE id = ?`).get(docId) as Record<string, string>;
    expect(row).toEqual({ amem_context: "What this memory is about.", amem_keywords: '["k"]', amem_tags: '["t"]' });
    store.close();
  });

  test.each(MARKS)("evolveMemories: a new context and a reasoning led by %s", async (_name, mark) => {
    const store = createTestStore();
    const [memId, nbId] = seedDocuments(store, [
      { path: "mem.md", title: "Memory A", body: "memory body" },
      { path: "nb.md", title: "Neighbor B", body: "neighbor body" },
    ]) as [number, number];
    store.db.prepare("UPDATE documents SET amem_context = ?, amem_keywords = ?, amem_tags = ? WHERE id = ?").run("Original context.", '["orig"]', '["old-tag"]', memId);
    store.db.prepare("UPDATE documents SET amem_context = ? WHERE id = ?").run("Neighbor context.", nbId);
    store.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'related', 0.9, ?)").run(memId, nbId, new Date().toISOString());
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: JSON.stringify({ should_evolve: true, new_keywords: ["fresh"], new_tags: ["new-tag"], new_context: mark + "Updated context.", reasoning: mark + "New evidence arrived." }),
      model: "mock", done: true,
    });

    expect(await evolveMemories(store, llm as any, memId, nbId)).toBe(true);
    const doc = store.db.prepare(`SELECT amem_context FROM documents WHERE id = ?`).get(memId) as { amem_context: string };
    expect(doc.amem_context).toBe("Updated context.");
    const history = store.db.prepare(`SELECT previous_context, new_context, reasoning FROM memory_evolution WHERE memory_id = ?`).all(memId);
    expect(history).toEqual([{ previous_context: "Original context.", new_context: "Updated context.", reasoning: "New evidence arrived." }]);
    store.close();
  });
});
