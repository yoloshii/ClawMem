/**
 * 62.2 (codex T8 #2; CR-5) — the legacy pre-compaction snapshot is never an input to automatic
 * enrichment: no A-MEM note, link, evolution, entity edge, graph edge, consolidation, deduction or
 * synthesis is built from it, and no enrichment prompt carries its text. The vault holds active copies
 * of it (fs, a fileless NULL one with CRLF, api) that sit next to real notes every way enrichment
 * travels: shared vectors, relations, an entity, a document type. A fake LLM records every prompt.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { runConsolidationTick, consolidateObservations, generateDeductiveObservations, computeSurprisalScores } from "../../src/consolidation.ts";
import { selectStaleObservationBatch, selectStaleDeductiveBatch } from "../../src/maintenance.ts";
import { runConversationSynthesis, resolveLinkTarget } from "../../src/conversation-synthesis.ts";
import { EVOLUTION_WRITER_FLOOR_FLAG, LEGACY_NOTE_RESET_REASON, notLegacyTaintedNoteSql, resetLegacyDerivedNotes } from "../../src/compaction-state.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { seedContent } from "../helpers/seed-content.ts";
const MODEL = "enrichment-fake";
/** Nearby but distinct vectors: every seeded document is every other's close neighbour. */
const vec = (spread = 0) => new Float32Array([0.1, 0.1, 1, spread]);
const CANARY = "CANARY-ENRICH";
const LEGACY = `# Pre-Compaction State\n\n_Extracted 2026-09-01T10:00:00 before auto-compaction. This is authoritative._\n\n## Last User Request\n\nzephyrinth gantry ${CANARY} from another session\n`;
const COPIES = ["-u-fs/memory/precompact-state.md", "-u-null/memory/precompact-state.md", "-u-api/memory/precompact-state.md"];

let store: Store;
let prompts: string[];
/** Whether the fake LLM tells `evolveMemories` to evolve (then this version writes a stamped entry). */
let evolveAnswer = false;
const id: Record<string, number> = {};

/** Answers each enrichment prompt in the shape its parser accepts, and records it. */
const llm = {
  generate: async (prompt: string) => {
    prompts.push(prompt);
    let text = "[]";
    if (prompt.includes("extract structured memory metadata")) {
      text = JSON.stringify({ keywords: ["gantry", "rig", "calibration"], tags: ["lab", "notes"], context: "A lab note about the gantry rig." });
    } else if (prompt.includes("semantic neighbors")) {
      const n = Number(prompt.match(/Include all (\d+) neighbors/)?.[1] ?? 0);
      text = JSON.stringify(Array.from({ length: n }, (_, i) => ({ target_idx: i + 1, link_type: "semantic", confidence: 0.9, reasoning: "related" })));
    } else if (prompt.includes("should evolve")) {
      text = JSON.stringify(evolveAnswer
        ? { should_evolve: true, new_keywords: ["k2", "k3", "k4"], new_tags: ["t2", "t3"], new_context: "evolved from clean evidence", reasoning: "clean" }
        : { should_evolve: false, new_keywords: [], new_tags: [], new_context: "", reasoning: "none" });
    } else if (prompt.includes("Extract named entities")) {
      text = JSON.stringify([{ name: "Gantry", type: "tool" }]);
    }
    return { text, model: MODEL, done: true };
  },
} as any;

const t0 = Date.parse("2026-09-20T12:00:00.000Z");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();

function seed(path: string, body: string, origin: string | null, createdAt: string, title = path, spread = 0): number {
  const hash = hashContent(body + path);
  seedContent(store.db, hash, body, createdAt);
  store.insertDocument("agent-memory", path, title, hash, createdAt, createdAt);
  store.db.prepare("UPDATE documents SET origin = ? WHERE collection = 'agent-memory' AND path = ?").run(origin, path);
  store.markEmbedSynced(hash);
  store.ensureVecTable(4);
  store.insertEmbedding(hash, 0, 0, vec(spread), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("agent-memory", path));
  return (id[path] = (store.db.prepare("SELECT id FROM documents WHERE collection = 'agent-memory' AND path = ?").get(path) as { id: number }).id);
}

const copyIds = () => COPIES.map(p => id[p]!);
const noCanary = () => expect(prompts.filter(p => p.includes(CANARY))).toEqual([]);

/** Makes a vault look as v0.39.1 left it: no evolution `writer` column and no evolution-writer floor. */
const asPreUpgrade = (db: Database) => {
  db.exec("ALTER TABLE memory_evolution DROP COLUMN writer");
  db.prepare("DELETE FROM vault_flags WHERE flag = ?").run(EVOLUTION_WRITER_FLOOR_FLAG);
};
const evolutionColumns = (db: Database) => (db.prepare("PRAGMA table_info(memory_evolution)").all() as { name: string }[]).map(c => c.name);
const floorOf = (db: Database) => (db.prepare("SELECT value FROM vault_flags WHERE flag = ?").get(EVOLUTION_WRITER_FLOOR_FLAG) as { value: string } | null)?.value ?? null;
const maxEvolutionId = (db: Database) => (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM memory_evolution").get() as { n: number }).n;

beforeEach(() => {
  prompts = [];
  evolveAnswer = false;
  store = createStore(":memory:");
  // The copies are the OLDEST rows: an input that orders by age reaches them first.
  seed(COPIES[1]!, LEGACY.replace(/\n/g, "\r\n"), null, at(-3), "Pre-Compaction State", 0.0);
  seed(COPIES[0]!, LEGACY, "fs", at(-2), "Pre-Compaction State", 0.2);
  seed(COPIES[2]!, LEGACY, "api", at(-1), "Pre-Compaction State", 0.4);
  seed("anchor.md", "zephyrinth project anchor note about the gantry rig", "fs", at(0), "anchor.md", 0.1);
  seed("gantry-note.md", "calibration log for the gantry rig, written by the lab", "fs", at(1), "gantry-note.md", 0.3);
  seed("rig-log.md", "second calibration pass on the gantry rig", "fs", at(2), "rig-log.md", 0.5);
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
});

describe("62.2 (codex T8 #2) — no automatic enrichment reads the legacy snapshot", () => {
  it("the consolidation worker's A-MEM backfill never selects a copy, and still enriches the real notes", async () => {
    await runConsolidationTick(store, llm);
    noCanary();
    const noted = (docId: number) => (store.db.prepare("SELECT amem_keywords FROM documents WHERE id = ?").get(docId) as { amem_keywords: string | null }).amem_keywords !== null;
    expect(["anchor.md", "gantry-note.md", "rig-log.md"].map(p => noted(id[p]!))).toEqual([true, true, true]);
    expect(copyIds().map(noted)).toEqual([false, false, false]);
  });

  it("a new note's enrichment links only real neighbours, and evolves them from real evidence only", async () => {
    // gantry-note has a note and relations to every copy, whose A-MEM contexts carry the canary.
    const setNote = store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?");
    for (const c of copyIds()) setNote.run(`${CANARY} context of another session`, c);
    setNote.run("gantry calibration context", id["gantry-note.md"]!);
    setNote.run("second pass context", id["rig-log.md"]!);
    const rel = store.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'semantic', 1.0, ?)");
    for (const c of copyIds()) rel.run(id["gantry-note.md"]!, c, at(5));
    rel.run(id["gantry-note.md"]!, id["rig-log.md"]!, at(5));

    await store.postIndexEnrich(llm, id["anchor.md"]!, true);
    noCanary();
    const linkPrompt = prompts.find(p => p.includes("semantic neighbors"))!;
    expect(linkPrompt).toContain("gantry-note.md");                         // the neighbour route ran
    expect(linkPrompt).not.toContain("Pre-Compaction State");
    const linked = (store.db.prepare("SELECT target_id FROM memory_relations WHERE source_id = ?").all(id["anchor.md"]!) as { target_id: number }[]).map(r => r.target_id);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter(t => copyIds().includes(t))).toEqual([]);
    expect(prompts.some(p => p.includes("should evolve") && p.includes("second pass context"))).toBe(true); // evolution ran on real evidence
  });

  it("a copy itself is never enriched: no note, entity, link or evolution", async () => {
    for (const c of copyIds()) expect(await store.postIndexEnrich(llm, c, true)).not.toBe("stored");
    expect(prompts).toEqual([]);
    // A copy that already has a note (from before the upgrade) and linked evidence does not evolve.
    store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?").run(`${CANARY} context`, copyIds()[0]!);
    store.db.prepare("UPDATE documents SET amem_context = 'gantry calibration context' WHERE id = ?").run(id["gantry-note.md"]!);
    store.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'semantic', 1.0, ?)").run(copyIds()[0]!, id["gantry-note.md"]!, at(5));
    expect(await store.evolveMemories(llm, copyIds()[0]!, id["anchor.md"]!)).toBe(false);
    expect(prompts).toEqual([]);
  });

  it("entity edges never target a copy", async () => {
    // Enough documents that a shared entity is specific enough to justify an edge (IDF ≥ 3).
    for (let i = 0; i < 150; i++) seed(`filler-${i}.md`, `filler document number ${i}`, "fs", at(10 + i));
    expect(await store.enrichDocumentEntities(llm, id["gantry-note.md"]!)).toBe(1);
    const entityId = (store.db.prepare("SELECT entity_id FROM entity_mentions WHERE doc_id = ?").get(id["gantry-note.md"]!) as { entity_id: string }).entity_id;
    // The copies mention the entity too (as enrichment before the upgrade left them).
    const mention = store.db.prepare("INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, 'Gantry', ?)");
    for (const c of copyIds()) mention.run(entityId, c, at(5));
    prompts = [];
    expect(await store.enrichDocumentEntities(llm, id["rig-log.md"]!)).toBe(1);
    noCanary();
    const targets = (store.db.prepare("SELECT target_id FROM memory_relations WHERE source_id = ? AND relation_type = 'entity'").all(id["rig-log.md"]!) as { target_id: number }[]).map(r => r.target_id);
    expect(targets).toContain(id["gantry-note.md"]!);                      // the edge route ran
    expect(targets.filter(t => copyIds().includes(t))).toEqual([]);
  });

  it("the temporal and semantic graph builders never make a copy a node", async () => {
    expect(store.buildTemporalBackbone()).toBeGreaterThan(0);
    expect(await store.buildSemanticGraph()).toBeGreaterThan(0);
    const touching = store.db.prepare(
      `SELECT relation_type, COUNT(*) AS n FROM memory_relations WHERE source_id IN (${copyIds().join(",")}) OR target_id IN (${copyIds().join(",")}) GROUP BY relation_type`
    ).all();
    expect(touching).toEqual([]);
  });

  it("consolidation, deduction, surprisal and the stale-batch selectors never take a copy", async () => {
    // Make every copy look like the input each phase selects (a v0.39 vault cannot produce this; the
    // guard must not depend on it). The real rows are recent typed observations with facts.
    const now = new Date().toISOString();
    const asObs = store.db.prepare("UPDATE documents SET content_type = ?, observation_type = 'decision', facts = ?, modified_at = ? WHERE id = ?");
    asObs.run("observation", JSON.stringify([`${CANARY} fact one`]), now, copyIds()[0]!);
    asObs.run("decision", JSON.stringify([`${CANARY} fact two`]), now, copyIds()[1]!);
    asObs.run("decision", JSON.stringify([`${CANARY} fact three`]), now, copyIds()[2]!);
    asObs.run("observation", JSON.stringify(["the gantry rig was recalibrated"]), now, id["gantry-note.md"]!);
    asObs.run("decision", JSON.stringify(["the lab keeps a calibration log"]), now, id["rig-log.md"]!);
    asObs.run("decision", JSON.stringify(["the anchor note tracks the zephyrinth project"]), now, id["anchor.md"]!);

    await consolidateObservations(store, llm);
    await generateDeductiveObservations(store, llm);
    noCanary();
    expect(prompts.some(p => p.includes("the lab keeps a calibration log"))).toBe(true); // deduction ran on real input
    const surprising = computeSurprisalScores(store, { k: 1 }).map(r => r.docId);
    expect(surprising).toContain(id["gantry-note.md"]!);                  // surprisal ran on real input
    for (const c of copyIds()) {
      expect(surprising).not.toContain(c);
      expect(selectStaleObservationBatch(store, 50)).not.toContain(c);
      expect(selectStaleDeductiveBatch(store, 50)).not.toContain(c);
    }
    expect(selectStaleObservationBatch(store, 50)).toContain(id["gantry-note.md"]!);
    expect(selectStaleDeductiveBatch(store, 50)).toContain(id["rig-log.md"]!);
  });

  it("conversation synthesis never reads a copy, and never resolves a link to one", async () => {
    store.db.prepare(`UPDATE documents SET content_type = 'conversation' WHERE id IN (${[...copyIds(), id["anchor.md"]!].join(",")})`).run();
    await runConversationSynthesis(store, llm, { collection: "agent-memory" });
    noCanary();
    expect(prompts.some(p => p.includes("zephyrinth project anchor note"))).toBe(true); // synthesis ran on the real conversation
    // One copy keeps the title an LLM could propose as a link target (two would read as ambiguous).
    store.db.prepare(`UPDATE documents SET title = 'renamed' WHERE id IN (${copyIds().slice(1).join(",")})`).run();
    expect(resolveLinkTarget(store, new Map(), "Pre-Compaction State", "agent-memory")).toBeNull();
    expect(resolveLinkTarget(store, new Map(), "gantry-note.md", "agent-memory")).toBe(id["gantry-note.md"]!);
  });
});

describe("62.2 (codex T9 #3; operator ruling: reset) — a note a copy shaped is rebuilt from its own text", () => {
  const taint = (memory: string, copy: number, text: string) => {
    store.db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, previous_context, new_context, reasoning) VALUES (?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM memory_evolution WHERE memory_id = ?), 'before', ?, 'copy evidence')")
      .run(id[memory]!, copy, id[memory]!, text);
    store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?").run(text, id[memory]!);
  };
  const history = (memory: string) => store.getEvolutionTimeline(id[memory]!, 100);

  it("the note is reset once, rebuilt by the backfill from its own text, and reset again if a copy shapes it again", async () => {
    taint("gantry-note.md", copyIds()[0]!, `${CANARY} context`);
    // A later ordinary evolution carries the copy's text forward.
    store.db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, previous_context, new_context, reasoning) VALUES (?, ?, 2, ?, ?, 'ordinary evidence')")
      .run(id["gantry-note.md"]!, id["rig-log.md"]!, `${CANARY} context`, `${CANARY} carried forward`);
    expect(JSON.stringify(history("gantry-note.md"))).not.toContain(CANARY);   // hidden before any reset

    expect(resetLegacyDerivedNotes(store.db)).toBe(1);
    expect(store.db.prepare("SELECT amem_keywords, amem_context FROM documents WHERE id = ?").get(id["gantry-note.md"]!))
      .toEqual({ amem_keywords: null, amem_context: null });
    expect(history("gantry-note.md").map(e => e.reasoning)).toEqual([expect.stringContaining("reset:")]);
    expect(resetLegacyDerivedNotes(store.db)).toBe(0);                          // nothing left: no write

    await runConsolidationTick(store, llm);                                      // the light-lane backfill
    noCanary();
    expect(prompts.some(p => p.includes("calibration log for the gantry rig"))).toBe(true); // rebuilt from its own body
    expect((store.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(id["gantry-note.md"]!) as { amem_context: string | null }).amem_context)
      .toBe("A lab note about the gantry rig.");

    taint("gantry-note.md", copyIds()[1]!, `${CANARY} again`);                  // an older ClawMem taints it again
    expect(resetLegacyDerivedNotes(store.db)).toBe(1);
    expect(JSON.stringify(history("gantry-note.md"))).not.toContain(CANARY);
    expect(history("gantry-note.md").filter(e => e.reasoning?.startsWith("reset:")).length).toBe(2);
  });

  it("codex T14 #1: an API-created note a copy shaped is reset and rebuilt from its own text by the light-lane backfill, its one rebuild path", async () => {
    const saved = store.saveMemory({ collection: "_clawmem", path: "decisions/api-note.md", title: "api-note.md", body: "an API-created decision about the gantry rig", contentType: "decision", confidence: 0.6, qualityScore: 0.6 });
    id["api-note"] = saved.docId;
    expect(store.db.prepare("SELECT origin FROM documents WHERE id = ?").get(saved.docId)).toEqual({ origin: "api" });
    // Every other real note already has one, so the backfill's oldest-first selection reaches this one.
    store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = 'x' WHERE id IN (?, ?, ?)")
      .run(id["anchor.md"]!, id["gantry-note.md"]!, id["rig-log.md"]!);
    taint("api-note", copyIds()[0]!, `${CANARY} context`);
    expect(resetLegacyDerivedNotes(store.db)).toBe(1);
    expect(store.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(saved.docId)).toEqual({ amem_context: null });
    await runConsolidationTick(store, llm);                                      // the light-lane backfill
    noCanary();
    expect(prompts.some(p => p.includes("an API-created decision about the gantry rig"))).toBe(true); // rebuilt from its own body
    expect(store.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(saved.docId)).toEqual({ amem_context: "A lab note about the gantry rig." });
  });

  it("codex T10 #2: a self-triggered entry that is not a reset marker neither blocks the reset nor unhides the span", async () => {
    taint("gantry-note.md", copyIds()[0]!, `${CANARY} context`);
    store.db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, previous_context, new_context, reasoning) VALUES (?, ?, 9, ?, ?, 'self evidence')")
      .run(id["gantry-note.md"]!, id["gantry-note.md"]!, `${CANARY} context`, `${CANARY} carried by a self-trigger`);
    // Nor does an unstamped entry in the exact shape of a marker: only this version writes markers.
    store.db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, reasoning) VALUES (?, ?, 10, ?)")
      .run(id["gantry-note.md"]!, id["gantry-note.md"]!, LEGACY_NOTE_RESET_REASON);
    // All of it predates the upgrade (below the evolution-writer floor), where only the marker's shape and
    // stamp tell a marker apart; above the floor an unstamped entry is suspect by itself.
    store.db.prepare("UPDATE vault_flags SET value = (SELECT MAX(id) FROM memory_evolution) WHERE flag = ?").run(EVOLUTION_WRITER_FLOOR_FLAG);
    expect(JSON.stringify(history("gantry-note.md"))).not.toContain(CANARY);
    expect(resetLegacyDerivedNotes(store.db)).toBe(1);                          // still tainted: reset
    // No note is evidence for itself: a clean note with clean evidence is not evolved by itself.
    const note = store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?");
    note.run("second pass context", id["rig-log.md"]!);
    note.run("anchor context", id["anchor.md"]!);
    store.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'semantic', 1.0, ?)").run(id["rig-log.md"]!, id["anchor.md"]!, at(5));
    prompts = [];
    expect(await store.evolveMemories(llm, id["rig-log.md"]!, id["rig-log.md"]!)).toBe(false);
    expect(prompts).toEqual([]);
  });

  it("a writable open performs the reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-622-reset-"));
    try {
      const file = join(dir, "vault.sqlite");
      const first = createStore(file);
      const put = (path: string, body: string) => {
        const hash = hashContent(body + path);
        seedContent(first.db, hash, body, at(0));
        first.insertDocument("agent-memory", path, path, hash, at(0), at(0));
        return (first.db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number }).id;
      };
      const copy = put(COPIES[0]!, LEGACY);
      const note = put("note.md", "a real note");
      first.db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, new_context) VALUES (?, ?, 1, ?)").run(note, copy, `${CANARY} context`);
      first.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_context = ? WHERE id = ?").run(`${CANARY} context`, note);
      first.close();
      const reopened = createStore(file);
      try {
        expect(reopened.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(note)).toEqual({ amem_context: null });
        expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM memory_evolution WHERE memory_id = ? AND triggered_by = ?").get(note, note)).toEqual({ n: 1 });
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("codex T10 #1: in a long-lived store, a note another process taints after the open, or whose reset fails, is never read by a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-622-live-"));
    try {
      const file = join(dir, "vault.sqlite");
      const live = createStore(file);                                          // the watcher's store: opened once
      try {
        const put = (path: string, body: string, spread: number) => {
          const hash = hashContent(body + path);
          seedContent(live.db, hash, body, at(0));
          live.insertDocument("agent-memory", path, path, hash, at(0), at(0));
          live.ensureVecTable(4);
          live.insertEmbedding(hash, 0, 0, vec(spread), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("agent-memory", path));
          return (live.db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number }).id;
        };
        const copy = put(COPIES[0]!, LEGACY, 0.0);
        const noted = put("gantry-note.md", "calibration log for the gantry rig, written by the lab", 0.1);
        const other = put("rig-log.md", "second calibration pass on the gantry rig", 0.2);
        const fresh = put("new-note.md", "a new note about the gantry rig", 0.3);
        const note = live.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?");
        note.run("clean rig context", other);
        note.run("fresh note context", fresh);
        // rig-log's evidence: the soon-tainted note and a clean one.
        const rel = live.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'semantic', 1.0, ?)");
        rel.run(other, noted, at(1));
        rel.run(other, fresh, at(1));

        // An older ClawMem, on its own connection, evolves the note from the copy after the live store opened.
        const older = new (await import("bun:sqlite")).Database(file);
        older.exec("PRAGMA busy_timeout = 2000");
        older.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, new_context, reasoning) VALUES (?, ?, 1, ?, 'copy evidence')").run(noted, copy, `${CANARY} context`);
        older.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?").run(`${CANARY} context`, noted);

        // Its reset fails: the older process holds the write lock.
        live.db.exec("PRAGMA busy_timeout = 50");
        older.exec("BEGIN IMMEDIATE");
        expect(resetLegacyDerivedNotes(live.db)).toBe(0);
        older.exec("ROLLBACK");
        older.close();
        live.db.exec("PRAGMA busy_timeout = 5000");

        // Both notes are observations too, as consolidation selects them.
        const asObs = live.db.prepare("UPDATE documents SET content_type = 'observation', observation_type = 'decision', facts = ? WHERE id = ?");
        asObs.run(JSON.stringify(["the rig was calibrated"]), noted);
        asObs.run(JSON.stringify(["a second pass followed"]), other);

        prompts = [];
        await live.generateMemoryLinks(llm, fresh);                           // the tainted note is a neighbour
        await live.generateMemoryLinks(llm, noted);                           // and a source
        expect(await live.evolveMemories(llm, noted, fresh)).toBe(false);     // the tainted note is not evolved
        await live.evolveMemories(llm, other, fresh);                         // nor evidence for another note
        await consolidateObservations(live, llm);                             // nor an observation's context
        noCanary();
        expect(prompts.some(p => p.includes("semantic neighbors") && p.includes("gantry-note.md"))).toBe(true); // it was a neighbour
        expect(prompts.some(p => p.includes("should evolve") && p.includes("fresh note context"))).toBe(true);  // evolution ran on the clean evidence
        expect(prompts.some(p => p.includes("session observations") && p.includes("clean rig context"))).toBe(true); // consolidation ran

        // The long-lived worker's next backfill pass resets the note and rebuilds it from its own text.
        prompts = [];
        await runConsolidationTick(live, llm);
        noCanary();
        expect(live.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(noted)).toEqual({ amem_context: "A lab note about the gantry rig." });
      } finally { live.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("codex T11 #1: an older writer's evolution committed after the reset, from text it read before it, keeps the note quarantined and is reset again; this version's own evolutions are not suspect", async () => {
    taint("gantry-note.md", copyIds()[0]!, `${CANARY} context`);
    // An older ClawMem reads the tainted note and waits on its model ...
    const readBefore = (store.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(id["gantry-note.md"]!) as { amem_context: string }).amem_context;
    expect(resetLegacyDerivedNotes(store.db)).toBe(1);                            // ... this version resets it ...
    // ... and the older writer commits: an ordinary-triggered, unstamped entry after the reset marker.
    store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?").run(`${readBefore} evolved`, id["gantry-note.md"]!);
    store.db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, previous_context, new_context, reasoning) VALUES (?, ?, 5, ?, ?, 'late')")
      .run(id["gantry-note.md"]!, id["rig-log.md"]!, readBefore, `${readBefore} evolved`);

    // Quarantined at once: no prompt reads it, and the history hides the late entry.
    store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = 'anchor context' WHERE id = ?").run(id["anchor.md"]!);
    store.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'semantic', 1.0, ?)").run(id["anchor.md"]!, id["gantry-note.md"]!, at(5));
    prompts = [];
    await store.generateMemoryLinks(llm, id["rig-log.md"]!);                      // the note is a neighbour
    expect(await store.evolveMemories(llm, id["gantry-note.md"]!, id["rig-log.md"]!)).toBe(false);
    noCanary();
    expect(JSON.stringify(history("gantry-note.md"))).not.toContain(CANARY);
    expect(resetLegacyDerivedNotes(store.db)).toBe(1);                            // and reset again
    expect(store.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(id["gantry-note.md"]!)).toEqual({ amem_context: null });

    // This version's own evolution after the reset is stamped: not suspect, visible, and never reset.
    store.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = 'rebuilt clean context' WHERE id = ?").run(id["gantry-note.md"]!);
    store.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'semantic', 1.0, ?)").run(id["gantry-note.md"]!, id["anchor.md"]!, at(6));
    evolveAnswer = true;
    expect(await store.evolveMemories(llm, id["gantry-note.md"]!, id["anchor.md"]!)).toBe(true);
    expect(resetLegacyDerivedNotes(store.db)).toBe(0);
    expect(history("gantry-note.md").map(e => e.newContext)).toContain("evolved from clean evidence");
  });

  it("codex T11 #1 / T13 #2 (operator ruling): pre-upgrade history is not suspect; a note no copy touched that an older writer evolves after the upgrade is quarantined and reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-622-floor-"));
    try {
      const file = join(dir, "vault.sqlite");
      const before = createStore(file);
      const put = (path: string) => {
        const hash = hashContent(path);
        seedContent(before.db, hash, `body of ${path}`, at(0));
        before.insertDocument("agent-memory", path, path, hash, at(0), at(0));
        return (before.db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number }).id;
      };
      const a = put("a.md"), b = put("b.md"), c = put("c.md");
      const evolve = (db: { prepare: Store["db"]["prepare"] }, memory: number, trigger: number, text: string) =>
        db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, new_context, reasoning) VALUES (?, ?, 1, ?, 'x')").run(memory, trigger, text);
      asPreUpgrade(before.db);                                                   // the vault as v0.39.1 left it
      evolve(before.db, a, b, "history from before the upgrade");               // an older version's normal history
      before.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_context = 'history from before the upgrade' WHERE id = ?").run(a);
      before.close();

      const upgraded = createStore(file);                                        // this version's first writable open
      try {
        const amem = (doc: number) => (upgraded.db.prepare("SELECT amem_context FROM documents WHERE id = ?").get(doc) as { amem_context: string | null }).amem_context;
        const readable = (doc: number) => !!upgraded.db.prepare(`SELECT 1 FROM documents d WHERE d.id = ? AND ${notLegacyTaintedNoteSql("d")}`).get(doc);
        expect(amem(a)).toBe("history from before the upgrade");
        expect(readable(a)).toBe(true);
        expect(upgraded.getEvolutionTimeline(a, 10).map(e => e.newContext)).toEqual(["history from before the upgrade"]);
        // An older process still running evolves c after the upgrade (no stamp). No copy is in c's history.
        evolve(upgraded.db, c, b, `${CANARY} via an unguarded reader`);
        upgraded.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_context = ? WHERE id = ?").run(`${CANARY} via an unguarded reader`, c);
        expect(readable(c)).toBe(false);                                         // quarantined: no prompt reads it
        expect(JSON.stringify(upgraded.getEvolutionTimeline(c, 10))).not.toContain(CANARY);
        expect(resetLegacyDerivedNotes(upgraded.db)).toBe(1);                    // and cleared on its own, like a copy's note
        expect(amem(c)).toBeNull();
        expect(amem(a)).toBe("history from before the upgrade");
        expect(readable(c)).toBe(true);
        expect(upgraded.getEvolutionTimeline(c, 10).map(e => e.reasoning)).toEqual([LEGACY_NOTE_RESET_REASON]);
        expect(resetLegacyDerivedNotes(upgraded.db)).toBe(0);                    // nothing left: no write
      } finally { upgraded.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("62.2 (codex T12 #1) — the writer column and the evolution-writer floor appear together", () => {
  const put = (st: Store, path: string) => {
    const hash = hashContent(path);
    seedContent(st.db, hash, `body of ${path}`, at(0));
    st.insertDocument("agent-memory", path, path, hash, at(0), at(0));
    return (st.db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number }).id;
  };
  const OLDER_ENTRY = "INSERT INTO memory_evolution (memory_id, triggered_by, version, new_context, reasoning) VALUES (?, ?, 1, 'an older writer', 'older')";

  it("a floor that cannot be written (refused, or silently not landing: T13 #1) leaves neither, on an upgrade and on a new vault, and the store does not open; the next open records both", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-622-fence-"));
    try {
      const upgradedFile = join(dir, "upgraded.sqlite"), newFile = join(dir, "new.sqlite");
      const old = createStore(upgradedFile);
      const n = put(old, "n.md"), m = put(old, "m.md");
      asPreUpgrade(old.db);
      old.db.prepare(OLDER_ENTRY).run(n, m);
      old.close();
      const blank = new Database(newFile);                                       // a new vault, with room for the refusal below
      blank.exec("CREATE TABLE vault_flags (flag TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
      blank.close();
      for (const [file, floor, raise] of [[upgradedFile, "1", "RAISE(ABORT, 'floor refused')"], [newFile, "0", "RAISE(IGNORE)"]] as const) {
        const raw = new Database(file);
        raw.exec(`CREATE TRIGGER refuse_floor BEFORE INSERT ON vault_flags WHEN NEW.flag = '${EVOLUTION_WRITER_FLOOR_FLAG}' BEGIN SELECT ${raise}; END`);
        expect(() => createStore(file)).toThrow(/evolution-writer floor/);
        expect(evolutionColumns(raw)).not.toContain("writer");                   // rolled back with the floor
        expect(floorOf(raw)).toBeNull();
        raw.exec("DROP TRIGGER refuse_floor");
        raw.close();
        const st = createStore(file);
        try {
          expect(evolutionColumns(st.db)).toContain("writer");
          expect(floorOf(st.db)).toBe(floor);
          // A vault with the column but no floor (a pre-release build left one) records it at the next open.
          st.db.prepare("DELETE FROM vault_flags WHERE flag = ?").run(EVOLUTION_WRITER_FLOOR_FLAG);
        } finally { st.close(); }
        const again = createStore(file);
        try { expect(floorOf(again.db)).toBe(floor); } finally { again.close(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("an older writer holding the write lock at the first upgraded open: the open fails and leaves neither; its entry is history, its next one is above the floor", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-622-fence-busy-"));
    try {
      const file = join(dir, "vault.sqlite");
      const old = createStore(file);
      const n = put(old, "n.md"), m = put(old, "m.md");
      asPreUpgrade(old.db);
      old.close();
      const older = new Database(file);
      older.exec("PRAGMA busy_timeout = 2000");
      older.exec("BEGIN IMMEDIATE");
      older.prepare(OLDER_ENTRY).run(n, m);                                      // mid-transaction when the upgrade opens
      expect(() => createStore(file, { busyTimeout: 100 })).toThrow(/evolution-writer floor/);
      older.exec("COMMIT");
      expect(evolutionColumns(older)).not.toContain("writer");
      expect(floorOf(older)).toBeNull();
      const st = createStore(file);
      try {
        const readable = () => !!st.db.prepare(`SELECT 1 FROM documents d WHERE d.id = ? AND ${notLegacyTaintedNoteSql("d")}`).get(n);
        expect(floorOf(st.db)).toBe(String(maxEvolutionId(st.db)));              // it committed before the column: history
        expect(readable()).toBe(true);
        older.prepare(OLDER_ENTRY).run(n, m);                                    // after the fence: above the floor
        expect(readable()).toBe(false);
        expect(resetLegacyDerivedNotes(st.db)).toBe(1);                          // cleared on its own (ruling T13 #2)
      } finally { st.close(); }
      // Once both exist, the fence takes no write lock (nor does the reset, with nothing to reset): a writer
      // holding it does not delay the open.
      older.exec("BEGIN IMMEDIATE");
      try {
        const t = performance.now();
        createStore(file, { busyTimeout: 1000 }).close();
        expect(performance.now() - t).toBeLessThan(900);
      } finally { older.exec("ROLLBACK"); older.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("across processes: an older writer committing through the first upgraded open lands below the floor exactly when it could not see the column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawmem-622-fence-x-"));
    try {
      const file = join(dir, "vault.sqlite");
      const old = createStore(file);
      const n = put(old, "n.md"), m = put(old, "m.md");
      asPreUpgrade(old.db);
      old.close();
      // A v0.39.1 evolution writer: it holds the write lock as the upgrade starts, then keeps committing.
      const script = join(dir, "older-writer.ts");
      writeFileSync(script, `
        import { Database } from "bun:sqlite";
        import { existsSync, writeFileSync } from "fs";
        const [file, memory, trigger, signal, gate] = process.argv.slice(2);
        const db = new Database(file);
        db.exec("PRAGMA busy_timeout = 5000");
        const sawColumn = () => (db.prepare("PRAGMA table_info(memory_evolution)").all() as { name: string }[]).some(c => c.name === "writer");
        const put = db.prepare(${JSON.stringify(OLDER_ENTRY)});
        const once = () => {
          db.prepare("SELECT COUNT(*) FROM memory_evolution").get();   // checks the schema cookie, so the check below reads the current schema
          const saw = sawColumn();
          return { saw, id: Number(put.run(Number(memory), Number(trigger)).lastInsertRowid) };
        };
        const out: { saw: boolean; id: number }[] = [];
        db.exec("BEGIN IMMEDIATE");
        const first = once();
        writeFileSync(signal, "held");
        while (!existsSync(gate)) Bun.sleepSync(5);
        Bun.sleepSync(150);
        db.exec("COMMIT");
        out.push(first);
        const until = Date.now() + 5000;
        while (Date.now() < until && out.filter(r => r.saw).length < 3) {
          db.exec("BEGIN IMMEDIATE");
          const r = once();
          db.exec("COMMIT");
          out.push(r);
          Bun.sleepSync(3);
        }
        console.log(JSON.stringify(out));
      `);
      const signal = join(dir, "held"), gate = join(dir, "go");
      const child = Bun.spawn([process.execPath, script, file, String(n), String(m), signal, gate], { stdout: "pipe", stderr: "pipe" });
      for (let i = 0; i < 400 && !existsSync(signal); i++) await Bun.sleep(5);
      expect(existsSync(signal)).toBe(true);
      writeFileSync(gate, "go");
      const st = createStore(file, { busyTimeout: 5000 });                       // blocks on the older writer's lock
      try {
        const records = JSON.parse((await new Response(child.stdout).text()).trim()) as { saw: boolean; id: number }[];
        await child.exited;
        const floor = Number(floorOf(st.db));
        expect(records[0]!.saw).toBe(false);                                     // the entry it held: history
        expect(records.some(r => r.saw)).toBe(true);                             // and some after the fence
        for (const r of records) expect(r.id > floor).toBe(r.saw);
        expect(st.db.prepare(`SELECT 1 FROM documents d WHERE d.id = ? AND ${notLegacyTaintedNoteSql("d")}`).get(n)).toBeNull(); // what it wrote after the fence is suspect
      } finally { st.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
