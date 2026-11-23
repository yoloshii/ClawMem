/**
 * BACKLOG 82.3, D7 — writers the binding census found (operator rulings 55 A, 56 A, 57 A; one missed writer):
 *  - `session_log.summary` — the D7 table rules session summaries normalised; `updateSession` bound it raw (missed);
 *  - judge `reasoning_head` / `evidence_head` — model text stored as evidence: normalised (55 A);
 *  - the hook dedupe preview and hash — `.trim()` removes U+FEFF but not U+FFFE: normalised (hook prompts are);
 *  - stored copies (56 A): `feedback_ledger.displayed_title` and `memory_evolution.previous_context` are copied as
 *    bytes; stop-recover selects only bodies that begin `# Antipatterns`, so a mark-led body is skipped, never refused.
 * Causal witness text (55 A, 57 A) is tested in `causal-writer.test.ts`, beside its harness.
 *  - `causal_run_events.detail` (ruling 61 A) — an audit event's text, often the model's own words: normalised, so the
 *    event row is always kept (a placeholder reasoning made only of marks used to be refused and its event lost).
 * No mark is typed into this file.
 */
import { describe, expect, test } from "bun:test";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import { seedContent } from "../helpers/seed-content.ts";
import { createMockLLM } from "../helpers/mock-llm.ts";
import { insertJudgeEvent, insertJudgeRun } from "../../src/judge-audit.ts";
import { wasPromptSeenRecently } from "../../src/hooks.ts";
import { writeGeneralMembership, writeMirrorMembership } from "../../src/stop-feedback.ts";
import { evolveMemories } from "../../src/amem.ts";
import { antipatternBodiesPreserved, preserveAntipatternBodies } from "../../src/stop-recover.ts";
import { insertCausalEvent, insertCausalRun } from "../../src/causal-writer.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];
const bytes = (s: string) => Buffer.from(s, "utf-8");
const hex = (s: string) => bytes(s).toString("hex").toUpperCase();

describe("normalised: the text after the marks is stored", () => {
  test.each(MARKS)("session_log.summary through updateSession — %s twice", (_name, mark) => {
    const store = createTestStore();
    store.db.prepare(`INSERT INTO session_log (session_id, started_at) VALUES ('s-1', '2026-11-23T00:00:00.000Z')`).run();
    store.updateSession("s-1", { summary: mark + mark + "Fixed the tank filter schedule." });
    expect(store.db.prepare(`SELECT summary FROM session_log WHERE session_id = 's-1'`).get()).toEqual({ summary: "Fixed the tank filter schedule." });
    store.close();
  });

  test.each(MARKS)("judge reasoning_head and evidence_head — %s", (_name, mark) => {
    const store = createTestStore();
    const runId = insertJudgeRun(store.db, { consumer: "merge-phase2", lane: "heuristic", outcome: "ok" });
    const id = insertJudgeEvent(store.db, { runId, eventType: "verdict", reasoningHead: mark + "Both name the same pump.", evidenceHead: mark + mark + "pump A, pump A" });
    expect(store.db.prepare(`SELECT reasoning_head r, evidence_head e FROM judge_events WHERE id = ?`).get(id)).toEqual({ r: "Both name the same pump.", e: "pump A, pump A" });
    store.close();
  });

  test.each(MARKS)("hook dedupe: a %s-led prompt is the same prompt as the plain one, and its preview is stored without the mark", (_name, mark) => {
    const store = createTestStore();
    expect(wasPromptSeenRecently(store, "context-surfacing", mark + "  how is the tank filter cleaned")).toBe(false);
    expect(wasPromptSeenRecently(store, "context-surfacing", "how is the tank filter cleaned")).toBe(true);
    expect(store.db.prepare(`SELECT prompt_preview p FROM hook_dedupe`).all()).toEqual([{ p: "how is the tank filter cleaned" }]);
    store.close();
  });
});

describe("causal_run_events.detail (61 A): normalised, the event row always kept", () => {
  const runOf = (store: ReturnType<typeof createTestStore>) =>
    insertCausalRun(store.db, { runKey: "run-61", source: "stop_hook", mode: "shadow", outcome: "in_progress" });
  test.each(MARKS)("model text led by %s twice is stored without the marks", (_name, mark) => {
    const store = createTestStore();
    const runId = runOf(store);
    insertCausalEvent(store.db, runId, { scope: "pair", eventType: "placeholder_reasoning", detail: mark + mark + "Because the pump failed." });
    expect(store.db.prepare(`SELECT event_type e, detail d FROM causal_run_events WHERE run_id = ?`).all(runId))
      .toEqual([{ e: "placeholder_reasoning", d: "Because the pump failed." }]);
    store.close();
  });

  test.each(MARKS)("a placeholder reasoning that is only %s keeps its event (detail empty)", (_name, mark) => {
    const store = createTestStore();
    const runId = runOf(store);
    insertCausalEvent(store.db, runId, { scope: "pair", eventType: "placeholder_reasoning", detail: mark });
    expect(store.db.prepare(`SELECT event_type e, detail d FROM causal_run_events WHERE run_id = ?`).all(runId))
      .toEqual([{ e: "placeholder_reasoning", d: "" }]);
    store.close();
  });

  test("control: a mark inside the text is kept, and a null detail stays null", () => {
    const store = createTestStore();
    const runId = runOf(store);
    insertCausalEvent(store.db, runId, { scope: "pair", eventType: "a", detail: `pump ${FEFF}A` });
    insertCausalEvent(store.db, runId, { scope: "pair", eventType: "b" });
    expect(store.db.prepare(`SELECT detail d FROM causal_run_events WHERE run_id = ? ORDER BY id`).all(runId))
      .toEqual([{ d: `pump ${FEFF}A` }, { d: null }]);
    store.close();
  });
});

describe("stored copies (56 A): copied byte for byte", () => {
  test.each(MARKS)("feedback_ledger.displayed_title copies a %s-led stored title", (_name, mark) => {
    const store = createTestStore();
    const usageId = store.insertUsage({
      sessionId: "s-1", timestamp: "2026-11-23T00:00:00.000Z", hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0,
      wasReferenced: 0, turnIndex: 0, queryText: "q", promptSha: "p", transcriptKey: null, host: "claude-code", sessionKey: null,
    } as any);
    writeGeneralMembership(store.db, usageId, [{ vault: null, displayPath: "notes/x.md", displayedTitle: mark + "Old title", docId: null }]);
    expect(store.db.prepare(`SELECT hex(displayed_title) h FROM feedback_ledger WHERE usage_id = ?`).get(usageId)).toEqual({ h: hex(mark + "Old title") });
    store.close();
  });

  test.each(MARKS)("feedback_ledger.displayed_title of a mirror row copies a %s-led stored title", (_name, mark) => {
    const store = createTestStore();
    const usageId = store.insertUsage({
      sessionId: "s-2", timestamp: "2026-11-23T00:00:00.000Z", hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0,
      wasReferenced: 0, turnIndex: 0, queryText: "q", promptSha: "p", transcriptKey: null, host: "claude-code", sessionKey: null,
    } as any);
    writeMirrorMembership(store.db, usageId, [{ vault: null, displayPath: "notes/y.md", displayedTitle: mark + "Mirrored title", docId: null }], true);
    expect(store.db.prepare(`SELECT hex(displayed_title) h FROM feedback_ledger WHERE usage_id = ?`).get(usageId)).toEqual({ h: hex(mark + "Mirrored title") });
    store.close();
  });

  test.each(MARKS)("memory_evolution.previous_context copies a %s-led stored context", async (_name, mark) => {
    const store = createTestStore();
    const [memId, nbId] = seedDocuments(store, [
      { path: "mem.md", title: "Memory A", body: "memory body" },
      { path: "nb.md", title: "Neighbor B", body: "neighbor body" },
    ]) as [number, number];
    store.db.prepare("UPDATE documents SET amem_context = CAST(? AS TEXT), amem_keywords = '[\"orig\"]', amem_tags = '[]' WHERE id = ?").run(bytes(mark + "Original context."), memId);
    store.db.prepare("UPDATE documents SET amem_context = 'Neighbor context.' WHERE id = ?").run(nbId);   // a neighbour needs a context
    store.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'related', 0.9, ?)").run(memId, nbId, new Date().toISOString());
    const llm = createMockLLM();
    llm.generate.mockResolvedValueOnce({
      text: JSON.stringify({ should_evolve: true, new_keywords: ["fresh"], new_tags: [], new_context: "Updated context.", reasoning: "New evidence." }),
      model: "mock", done: true,
    });
    expect(await evolveMemories(store, llm as any, memId, nbId)).toBe(true);
    expect(store.db.prepare(`SELECT hex(previous_context) h, new_context n FROM memory_evolution WHERE memory_id = ?`).all(memId))
      .toEqual([{ h: hex(mark + "Original context."), n: "Updated context." }]);
    store.close();
  });

  test.each(MARKS)("stop-recover: a %s-led orphaned body is not selected — the pass completes, nothing refused", async (_name, mark) => {
    const store = createTestStore();
    const body = "# Antipatterns 2026-01-01\n\n- **Avoid:** pushing with --force\n  > Context: c";
    seedContent(store.db, "plain", body, "2026-01-01T00:00:00.000Z");
    store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES ('marked', CAST(? AS TEXT), '2026-01-02T00:00:00.000Z')`).run(bytes(mark + body));
    expect(await preserveAntipatternBodies(store.db)).toBe(1);
    expect(antipatternBodiesPreserved(store.db)).toBe(true);
    expect(store.db.prepare(`SELECT hash FROM recovered_antipattern_bodies`).all()).toEqual([{ hash: "plain" }]);
    store.close();
  });
});
