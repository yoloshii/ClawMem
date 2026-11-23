/**
 * 62.1 D9/D10: the counter recompute, antipattern recovery and the stop pipeline's health (design tests 17, 19, 55, 56).
 *
 * Baseline (8e2579a): no recompute exists — the counters every Stop inflated stay inflated (live access_count up to
 * 13,213; injection-time co-activations; usage weights up to 8,931), overwritten antipattern bodies are unreachable
 * orphans, and doctor says nothing about an older writer.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { applySurfacingBookkeeping, type SurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";
import { feedbackLoop } from "../../src/hooks/feedback-loop.ts";
import { recomputeCounters, restoreCounterRepair, removeStopFence, recomputeDone, RECOMPUTE_MARKER } from "../../src/stop-repair.ts";
import { preserveAntipatternBodies, listRecoveredAntipatterns, applyRecoveredAntipatterns, antipatternBodiesPreserved } from "../../src/stop-recover.ts";
import { stopPipelineHealth, stopHealthLine, isStale } from "../../src/stop-health.ts";
import { missingStopSchema, STOP_USAGE_WATERMARK_FLAG } from "../../src/stop-schema.ts";
import { promptSha, transcriptKey } from "../../src/stop-pairing.ts";
import { iso, human, assistant, writeTranscriptFile } from "./stop-fixtures.ts";

import { seedContent } from "../helpers/seed-content.ts";
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "clawmem-621-repair-")); dirs.push(d); return d; }

function seedDoc(store: Store, collection: string, path: string, title: string, contentType = "note"): number {
  const hash = `h-${collection}-${path}`;
  seedContent(store.db, hash, `# ${title}\n\nbody`, iso(0));
  store.insertDocument(collection, path, title, hash, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const id = store.findActiveDocument(collection, path)!.id;
  store.db.prepare(`UPDATE documents SET content_type = ? WHERE id = ?`).run(contentType, id);
  return id;
}
/** A pre-upgrade writer's inflation, as the old Stops left it (the stamp change lets the setup pass the fence). */
function inflate(store: Store, id: number, access: number, lastAccessed: string) {
  store.db.prepare(`UPDATE documents SET access_count = ?, last_accessed_at = ?, counter_stamp = 'legacy-setup' WHERE id = ?`).run(access, lastAccessed, id);
}
function usageRow(store: Store, sessionId: string, t: number, prompt: string, path: string | null, injected: string[] = []): number {
  return store.insertUsage({
    sessionId, timestamp: iso(t), hookName: "context-surfacing", injectedPaths: injected, estimatedTokens: 0, wasReferenced: 0, turnIndex: 0,
    queryText: prompt, promptSha: promptSha(prompt), transcriptKey: path ? transcriptKey(path) : null, host: "claude-code", sessionKey: null,
  });
}
function manifestJob(usageId: number, sessionId: string, entries: { displayPath: string; title: string }[]): SurfacingBookkeepingJob {
  return {
    v: 1, kind: "surfacing-bookkeeping", jobId: `job-${usageId}`, sessionId, turnIndex: 0, usageId, queryHash: "qh",
    injectedPaths: entries.map(e => e.displayPath), estimatedTokens: 10,
    vaults: [{ vault: null, docs: entries.map(e => ({ displayPath: e.displayPath, searchScore: 0.9 })) }],
    manifest: entries.map(e => ({ vault: null, displayPath: e.displayPath, displayedTitle: e.title })),
  } as SurfacingBookkeepingJob;
}
const doc = (store: Store, id: number) => store.db.prepare(`SELECT access_count, last_accessed_at, modified_at, access_grace_until FROM documents WHERE id = ?`).get(id) as
  { access_count: number; last_accessed_at: string | null; modified_at: string; access_grace_until: string | null };
const signal = (store: Store, path: string) => store.db.prepare(`SELECT surfaced_count, referenced_count FROM utility_signals WHERE path = ?`).get(path) as
  { surfaced_count: number; referenced_count: number } | null;

/**
 * A vault with pre-upgrade history (3 usage rows at or below the watermark, inflated counters, injection-time
 * co-activations, legacy usage relations with runaway weights) and one verified post-upgrade turn referencing a + b.
 */
async function upgradedVault() {
  const store = createTestStore();
  const a = seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
  const b = seedDoc(store, "notes", "b/beta.md", "Beta rollout notes");
  const c = seedDoc(store, "notes", "c/gamma.md", "Gamma runbook notes");
  const d = seedDoc(store, "notes", "d/delta.md", "Delta archive notes");
  // History: three pre-upgrade surfacing rows; the watermark is moved over them (they predate the fence).
  const h1 = usageRow(store, "old", 1, "old prompt 1", null, ["notes/a/alpha.md", "notes/c/gamma.md"]);
  const h2 = usageRow(store, "old", 2, "old prompt 2", null, ["notes/a/alpha.md"]);
  const h3 = usageRow(store, "old", 3, "old prompt 3", null, ["notes/c/gamma.md", "notes/c/gamma.md"]);
  store.db.prepare(`UPDATE vault_flags SET value = ? WHERE flag = ?`).run(String(h3), STOP_USAGE_WATERMARK_FLAG);
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
  inflate(store, a, 13_213, recent);
  inflate(store, c, 400, recent);
  inflate(store, d, 7, "2025-01-01T00:00:00.000Z");   // old access: no grace
  store.db.prepare(`INSERT INTO co_activations (doc_a, doc_b, count, last_seen, stamp) VALUES ('notes/a/alpha.md', 'notes/c/gamma.md', 57, ?, 'legacy-setup')`).run(recent);
  store.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at, stamp) VALUES (?, ?, 'usage', 8931, ?, 'legacy-setup')`).run(a, c, recent);
  // One verified post-upgrade turn: a and b both referenced.
  const path = writeTranscriptFile(tmp(), "s.jsonl", [
    human("question about alpha and beta", 100), assistant("a/alpha.md and b/beta.md agree.", 110), human("next", 200), assistant("ok", 210),
  ]);
  const u = usageRow(store, "s", 101, "question about alpha and beta", path);
  applySurfacingBookkeeping(store, manifestJob(u, "s", [
    { displayPath: "notes/a/alpha.md", title: "Alpha design notes" }, { displayPath: "notes/b/beta.md", title: "Beta rollout notes" },
  ]));
  await feedbackLoop(store, { sessionId: "s", transcriptPath: path }, { vaults: [] });
  return { store, a, b, c, d, h: [h1, h2, h3], u };
}

describe("D9 recompute from verified references (tests 19, 55)", () => {
  it("a dry run writes nothing and reports what would change", async () => {
    const { store, a } = await upgradedVault();
    const r = await recomputeCounters(store.db, { apply: false });
    expect(r.applied).toBe(false);
    expect(r.documents).toBeGreaterThan(0);
    expect(r.coActivationsDeleted).toBe(2);   // the legacy row + the verified one (rebuilt)
    expect(doc(store, a).access_count).toBe(13_214);
    expect(recomputeDone(store.db)).toBe(false);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM counter_repair_log`).get() as { n: number }).n).toBe(0);
  });

  it("counters become verified references; surfaced counts are history + ledger; grace is staggered; rebuilt pairs; before-images", async () => {
    const { store, a, b, c, d, h } = await upgradedVault();
    const r = await recomputeCounters(store.db, { apply: true });
    expect(r.opId).toMatch(/^rc-/);
    expect(recomputeDone(store.db)).toBe(true);
    // Pre-upgrade rows are frozen; none carries a ledger entry.
    for (const id of h) {
      expect(store.db.prepare(`SELECT state, reason FROM feedback_turns WHERE usage_id = ?`).get(id)).toEqual({ state: "unattributable", reason: "pre-upgrade" });
      expect((store.db.prepare(`SELECT COUNT(*) AS n FROM feedback_ledger WHERE usage_id = ?`).get(id) as { n: number }).n).toBe(0);
    }
    // access = verified references only; last access = newest reference, else modified_at.
    expect(doc(store, a).access_count).toBe(1);
    expect(doc(store, b).access_count).toBe(1);
    expect(doc(store, c).access_count).toBe(0);
    expect(doc(store, c).last_accessed_at).toBe(doc(store, c).modified_at);
    // Grace: a and c were recently accessed per the old counter → staggered grace; d's old access was not recent.
    const ga = Date.parse(doc(store, a).access_grace_until!);
    const gc = Date.parse(doc(store, c).access_grace_until!);
    const day = 86_400_000;
    for (const [g, id] of [[ga, a], [gc, c]] as const) {
      const days = (g - Date.now()) / day;
      expect(days).toBeGreaterThan(29.9 + (id % 60));
      expect(days).toBeLessThan(30.1 + (id % 60));
    }
    expect(ga).not.toBe(gc);
    expect(doc(store, d).access_grace_until).toBeNull();
    // Surfaced: history (a: 2 rows, c: 2 rows — a row counts a path once) + the ledger (a, b: 1 each).
    expect(signal(store, "notes/a/alpha.md")).toEqual({ surfaced_count: 3, referenced_count: 1 });
    expect(signal(store, "notes/b/beta.md")).toEqual({ surfaced_count: 1, referenced_count: 1 });
    expect(signal(store, "notes/c/gamma.md")).toEqual({ surfaced_count: 2, referenced_count: 0 });
    // Co-activations and usage relations: only the verified same-turn pair remains.
    expect(store.db.prepare(`SELECT doc_a, doc_b, count FROM co_activations`).all()).toEqual([{ doc_a: "notes/a/alpha.md", doc_b: "notes/b/beta.md", count: 1 }]);
    expect(store.db.prepare(`SELECT source_id, target_id, weight FROM memory_relations WHERE relation_type = 'usage'`).all())
      .toEqual([{ source_id: a, target_id: b, weight: 1 }]);
    // Before-images exist for what changed.
    const logged = store.db.prepare(`SELECT tbl, col FROM counter_repair_log WHERE op_id = ?`).all(r.opId) as { tbl: string; col: string }[];
    expect(logged.some(l => l.tbl === "documents" && l.col === "access_count")).toBe(true);
    expect(logged.some(l => l.tbl === "co_activations" && l.col === "*delete")).toBe(true);
    expect(logged.some(l => l.tbl === "memory_relations" && l.col === "*delete")).toBe(true);
    // A re-run is a no-op.
    const again = await recomputeCounters(store.db, { apply: true });
    expect(again.alreadyDone).toBe(true);
    expect(doc(store, a).access_count).toBe(1);
  });

  it("restore round-trips; a value changed after the repair is a conflict and is kept", async () => {
    const { store, a, c } = await upgradedVault();
    const r = await recomputeCounters(store.db, { apply: true });
    // A post-repair increment on c (a verified reference would move it the same way).
    store.db.prepare(`UPDATE documents SET access_count = access_count + 1, counter_stamp = 'post-repair' WHERE id = ?`).run(c);
    const back = restoreCounterRepair(store.db, r.opId!);
    expect(doc(store, a).access_count).toBe(13_214);   // back to the pre-repair value
    expect(doc(store, c).access_count).toBe(1);        // changed since: kept
    expect(back.conflicts.some(x => x.startsWith(`documents ${c}.access_count`))).toBe(true);
    const pairs = store.db.prepare(`SELECT doc_a, doc_b, count FROM co_activations ORDER BY doc_b`).all();
    expect(pairs).toEqual([{ doc_a: "notes/a/alpha.md", doc_b: "notes/b/beta.md", count: 1 }, { doc_a: "notes/a/alpha.md", doc_b: "notes/c/gamma.md", count: 57 }]);
  });

  it("archive candidacy honours the grace: a recently used document is not archived until it expires", async () => {
    const { store, c } = await upgradedVault();
    await recomputeCounters(store.db, { apply: true });
    store.db.prepare(`UPDATE documents SET modified_at = '2025-01-01T00:00:00.000Z' WHERE id = ?`).run(c);
    const policy = { archive_after_days: 30, type_overrides: {}, purge_after_days: null, exempt_collections: [], dry_run: true };
    const ids = () => store.getArchiveCandidates(policy).map(x => x.id);
    expect(ids()).not.toContain(c);
    store.db.prepare(`UPDATE documents SET access_grace_until = '2020-01-01T00:00:00.000Z', last_accessed_at = '2025-01-01T00:00:00.000Z', counter_stamp = 'x' WHERE id = ?`).run(c);
    expect(ids()).toContain(c);
  });

  it("--remove-fence drops the triggers (the schema check then reports them missing)", () => {
    const store = createTestStore();
    expect(missingStopSchema(store.db)).toEqual([]);
    expect(removeStopFence(store.db)).toBeGreaterThan(0);
    expect(missingStopSchema(store.db).every(m => m.startsWith("trigger "))).toBe(true);
    expect(missingStopSchema(store.db).length).toBeGreaterThan(0);
  });
});

describe("D9 antipattern recovery", () => {
  function withBodies() {
    const store = createTestStore();
    const body = (n: number, lines: string[]) => `# Antipatterns 2026-0${n}-01\n\n_Session: x_\n\n${lines.map(l => `- **Avoid:** ${l}\n  > Context: c`).join("\n")}`;
    seedContent(store.db, "ap1", body(1, ["pushing with --force", "editing the shared checkout"]), "2026-01-01T00:00:00.000Z");
    seedContent(store.db, "ap2", body(2, ["pushing with --force", "skipping the gate"]), "2026-02-01T00:00:00.000Z");
    seedContent(store.db, "ap3", body(3, ["pushing   with --force"]), "2026-03-01T00:00:00.000Z");
    seedContent(store.db, "live", body(4, ["the live doc's own line"]), "2026-04-01T00:00:00.000Z");
    store.insertDocument("_clawmem", "antipatterns/2026-04-01-live.md", "Antipatterns", "live", iso(0), iso(0));
    seedContent(store.db, "other", "# Decisions\n\n- **Avoid:** not an antipatterns body", "2026-01-01T00:00:00.000Z");
    return store;
  }

  it("preserves only orphaned antipattern bodies, resumably; lists de-duplicated assertions with counts and dates", async () => {
    const store = withBodies();
    await preserveAntipatternBodies(store.db, { maxChunks: 0 });
    expect(antipatternBodiesPreserved(store.db)).toBe(false);
    expect(await preserveAntipatternBodies(store.db)).toBe(3);
    expect(antipatternBodiesPreserved(store.db)).toBe(true);
    expect(await preserveAntipatternBodies(store.db)).toBe(0);
    const list = listRecoveredAntipatterns(store.db);
    expect(list[0]).toEqual({ text: "pushing with --force", occurrences: 3, firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-03-01T00:00:00.000Z" });
    expect(list.map(a => a.text).sort()).toEqual(["editing the shared checkout", "pushing with --force", "skipping the gate"]);
  });

  it("--apply writes the accepted set once (stamped, api-owned); an unchanged re-apply writes nothing", async () => {
    const store = withBodies();
    await preserveAntipatternBodies(store.db);
    const w = applyRecoveredAntipatterns(store.db, { minOccurrences: 2, now: "2026-09-30T12:00:00.000Z" });
    expect(w).toEqual({ path: "antipatterns/recovered-2026-09.md", action: "inserted", assertions: 1 });
    const row = store.db.prepare(`SELECT d.origin, d.doc_stamp, c.doc FROM documents d JOIN content c ON c.hash = d.hash WHERE d.path = ?`).get(w.path) as
      { origin: string; doc_stamp: string | null; doc: string };
    expect(row.origin).toBe("api");
    expect(row.doc_stamp).not.toBeNull();
    expect(row.doc).toContain("- **Avoid:** pushing with --force");
    expect(row.doc).not.toContain("skipping the gate");
    expect(applyRecoveredAntipatterns(store.db, { minOccurrences: 2, now: "2026-09-30T12:00:00.000Z" }).action).toBe("unchanged");
  });
});

describe("D10 health for doctor and status (tests 17, 56)", () => {
  it("an older writer caught by the fence is reported; queues, staleness and the causal split are counted", async () => {
    const store = createTestStore();
    let h = stopPipelineHealth(store.db);
    expect(h.missing).toEqual([]);
    expect(h.legacyWriters).toEqual([]);
    expect(stopHealthLine(h)).toContain("fence clean");
    expect(stopHealthLine(h)).toContain("recompute pending");
    // The baseline's counter statement against a migrated vault: ignored, logged.
    const id = seedDoc(store, "notes", "x.md", "X");
    store.db.prepare(`UPDATE documents SET access_count = access_count + 1 WHERE id = ?`).run(id);
    store.db.prepare(
      `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, anchor_epoch, from_offset, to_offset, range_key, range_sha, first_failed_at, next_retry_at, state)
       VALUES ('s', 'k', 'decision-extractor', '/x.jsonl', 0, 0, 10, 'rk', 'sha', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'queued')`
    ).run();
    store.db.prepare(`INSERT INTO causal_due (session_id, transcript_key, range_key, run_key, obs_doc_ids, window_at, mode, state, attempts, created_at) VALUES ('s', 'k', 'r', 'stop:s:k:r', '[]', ?, 'on', 'queued', 0, ?)`)
      .run(iso(0), iso(0));
    h = stopPipelineHealth(store.db);
    expect(h.legacyWriters.length).toBe(1);
    expect(h.legacyWriters[0]!.count).toBe(1);
    expect(stopHealthLine(h)).toContain("older writer caught");
    expect(h.stopRetries.count).toBe(1);
    expect(isStale(h.stopRetries)).toBe(true);
    const saved = process.env.CLAWMEM_CAUSAL_WRITER;
    try {
      delete process.env.CLAWMEM_CAUSAL_WRITER;
      h = stopPipelineHealth(store.db);
      expect([h.causalRunnable, h.causalWaitingOff]).toEqual([0, 1]);
      process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
      h = stopPipelineHealth(store.db);
      expect([h.causalRunnable, h.causalWaitingOff]).toEqual([1, 0]);
    } finally {
      if (saved === undefined) delete process.env.CLAWMEM_CAUSAL_WRITER; else process.env.CLAWMEM_CAUSAL_WRITER = saved;
    }
    await recomputeCounters(store.db, { apply: true });
    expect(stopHealthLine(stopPipelineHealth(store.db))).toContain("counters recomputed");
    expect(store.db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(RECOMPUTE_MARKER)).not.toBeNull();
  });

  // Found at the docs stage: the log keeps its rows, so one caught write failed doctor for good, upgraded or not.
  it("an older writer last seen over 24 h ago is reported as past, no longer as a failure", () => {
    const store = createTestStore();
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    store.db.prepare(`INSERT INTO legacy_writer_log (surface, first_at, last_at, count) VALUES ('documents.counters', ?, ?, 3)`).run(old, old);
    let h = stopPipelineHealth(store.db);
    expect(h.legacyWriters.length).toBe(1);
    expect(h.legacyWritersRecent).toEqual([]);
    expect(stopHealthLine(h)).toContain("fence clean");
    expect(stopHealthLine(h)).toContain("older writer last seen");
    // A new caught write makes it current again.
    store.db.prepare(`UPDATE legacy_writer_log SET last_at = ?, count = count + 1`).run(new Date().toISOString());
    h = stopPipelineHealth(store.db);
    expect(h.legacyWritersRecent.map(w => w.surface)).toEqual(["documents.counters"]);
    expect(stopHealthLine(h)).toContain("older writer caught");
  });
});
