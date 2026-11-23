/**
 * 62.1 D6: feedback — membership at the drainer, the manifest reference test, verified-once effects (design tests
 * 1, 2, 3, 4, 6, 24, 25, 49, 50, 52, 53, 54).
 *
 * Baseline (8e2579a): every Stop re-reads the session, re-counts every injected path as surfaced and every mention
 * as a reference (CM-02: live access_count up to 13,213), credits a generic basename ("SKILL.md") anywhere in the
 * text, attributes turns by position, and has no membership record: a path the drainer filled after the last Stop is
 * never attributed, and a named vault re-runs the same guesses on its own.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../../src/store.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { applySurfacingBookkeeping, type SurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";
import { feedbackLoop } from "../../src/hooks/feedback-loop.ts";
import { promptSha, transcriptKey } from "../../src/stop-pairing.ts";
import { T0, iso, human, assistant, ocMessage, writeTranscriptFile, appendEntries } from "./stop-fixtures.ts";

import { seedContent } from "../helpers/seed-content.ts";
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "clawmem-621-feedback-"));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

// ─── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
function seedDoc(store: Store, collection: string, path: string, title: string, body = `# ${title}\n\nbody`): number {
  const hash = `h-${collection}-${path}-${Math.random().toString(36).slice(2, 8)}`;
  seedContent(store.db, hash, body, iso(0));
  store.insertDocument(collection, path, title, hash, iso(0), iso(0));
  return store.findActiveDocument(collection, path)!.id;
}

type RowSpec = { sessionId: string; t: number; prompt: string; path: string | null; turnIndex?: number; host?: string; sessionKey?: string | null };
function usageRow(store: Store, r: RowSpec): number {
  return store.insertUsage({
    sessionId: r.sessionId, timestamp: iso(r.t), hookName: "context-surfacing", injectedPaths: [], estimatedTokens: 0,
    wasReferenced: 0, turnIndex: r.turnIndex ?? 0, queryText: r.prompt,
    promptSha: promptSha(r.prompt), transcriptKey: r.path ? transcriptKey(r.path) : null,
    host: r.host ?? "claude-code", sessionKey: r.sessionKey ?? null,
  });
}

type Entry = { vault: string | null; displayPath: string; title: string };
function manifestJob(usageId: number, sessionId: string, entries: Entry[], over: Partial<SurfacingBookkeepingJob> = {}): SurfacingBookkeepingJob {
  const groups = new Map<string | null, { displayPath: string; searchScore: number }[]>();
  for (const e of entries) {
    if (!groups.has(e.vault)) groups.set(e.vault, []);
    groups.get(e.vault)!.push({ displayPath: e.displayPath, searchScore: 0.9 });
  }
  return {
    v: 1, kind: "surfacing-bookkeeping", jobId: `job-${usageId}-${sessionId}`, sessionId, turnIndex: 0, usageId,
    queryHash: "qh", injectedPaths: entries.map(e => e.displayPath), estimatedTokens: 10,
    vaults: [...groups].map(([vault, docs]) => ({ vault, docs })),
    manifest: entries.map(e => ({ vault: e.vault, displayPath: e.displayPath, displayedTitle: e.title })),
    ...over,
  } as SurfacingBookkeepingJob;
}

function ledger(store: Store, usageId: number) {
  return store.db.prepare(
    `SELECT vault, vault_doc_id, display_path, displayed_title, referenced_at FROM feedback_ledger WHERE usage_id = ? ORDER BY vault, display_path`
  ).all(usageId) as { vault: string; vault_doc_id: number | null; display_path: string; displayed_title: string | null; referenced_at: string | null }[];
}
function turnState(store: Store, usageId: number) {
  return store.db.prepare(`SELECT state, reason FROM feedback_turns WHERE usage_id = ?`).get(usageId) as { state: string; reason: string | null } | null;
}
function utility(store: Store, path: string) {
  return store.db.prepare(`SELECT surfaced_count, referenced_count, stamp FROM utility_signals WHERE path = ?`).get(path) as
    { surfaced_count: number; referenced_count: number; stamp: string | null } | null;
}
const accessOf = (store: Store, id: number) => (store.db.prepare(`SELECT access_count FROM documents WHERE id = ?`).get(id) as { access_count: number }).access_count;
const legacyLog = (store: Store) => (store.db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM legacy_writer_log`).get() as { n: number }).n;

// ─── Drainer ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe("D6 drainer: the turn's membership lands in one transaction (tests 6, 54)", () => {
  it("fills the row, links recall events, writes the manifest, counts each document surfaced once, and leaves the turn pending", () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "projects/ingest-plan.md", "Ingest pipeline plan");
    const u = usageRow(store, { sessionId: "s1", t: 101, prompt: "how do we batch", path: "/tmp/s1.jsonl" });
    const r = applySurfacingBookkeeping(store, manifestJob(u, "s1", [{ vault: null, displayPath: "notes/projects/ingest-plan.md", title: "Ingest pipeline plan" }]));
    expect(r.failedUnits).toEqual([]);
    expect(JSON.parse((store.db.prepare(`SELECT injected_paths FROM context_usage WHERE id = ?`).get(u) as { injected_paths: string }).injected_paths))
      .toEqual(["notes/projects/ingest-plan.md"]);
    expect(ledger(store, u)).toEqual([{ vault: "", vault_doc_id: a, display_path: "notes/projects/ingest-plan.md", displayed_title: "Ingest pipeline plan", referenced_at: null }]);
    expect(utility(store, "notes/projects/ingest-plan.md")).toMatchObject({ surfaced_count: 1, referenced_count: 0 });
    expect(utility(store, "notes/projects/ingest-plan.md")!.stamp).not.toBeNull();
    expect(turnState(store, u)).toEqual({ state: "pending", reason: null });
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM recall_events WHERE usage_id = ? AND doc_id = ?`).get(u, a) as { n: number }).n).toBe(1);
    expect(legacyLog(store)).toBe(0);
  });

  it("re-applying the same job (a crash before its claim was rewritten) adds nothing", () => {
    const store = createTestStore();
    seedDoc(store, "notes", "a.md", "Alpha design notes");
    const u = usageRow(store, { sessionId: "s1", t: 101, prompt: "p", path: "/tmp/s1.jsonl" });
    const job = manifestJob(u, "s1", [{ vault: null, displayPath: "notes/a.md", title: "Alpha design notes" }]);
    applySurfacingBookkeeping(store, job);
    applySurfacingBookkeeping(store, { ...job, completedUnits: undefined, usageLinked: undefined });
    expect(utility(store, "notes/a.md")!.surfaced_count).toBe(1);
    expect(ledger(store, u).length).toBe(1);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM recall_events WHERE usage_id = ?`).get(u) as { n: number }).n).toBe(1);
  });

  it("a job without manifest fields applies today's units only; its row is unattributable (legacy-job, test 54)", () => {
    const store = createTestStore();
    seedDoc(store, "notes", "a.md", "Alpha design notes");
    const u = usageRow(store, { sessionId: "s1", t: 101, prompt: "p", path: "/tmp/s1.jsonl" });
    const { manifest: _m, ...legacy } = manifestJob(u, "s1", [{ vault: null, displayPath: "notes/a.md", title: "Alpha design notes" }]) as any;
    const r = applySurfacingBookkeeping(store, legacy);
    expect(r.failedUnits).toEqual([]);
    expect(JSON.parse((store.db.prepare(`SELECT injected_paths FROM context_usage WHERE id = ?`).get(u) as { injected_paths: string }).injected_paths)).toEqual(["notes/a.md"]);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM recall_events WHERE usage_id = ?`).get(u) as { n: number }).n).toBe(1);
    expect(ledger(store, u)).toEqual([]);
    expect(utility(store, "notes/a.md")).toBeNull();
    expect(turnState(store, u)).toEqual({ state: "unattributable", reason: "legacy-job" });
  });

  it("a legacy job whose update unit already completed still applies its remaining units", () => {
    const store = createTestStore();
    seedDoc(store, "notes", "a.md", "Alpha design notes");
    const u = usageRow(store, { sessionId: "s1", t: 101, prompt: "p", path: "/tmp/s1.jsonl" });
    const { manifest: _m, ...legacy } = manifestJob(u, "s1", [{ vault: null, displayPath: "notes/a.md", title: "Alpha design notes" }]) as any;
    const r = applySurfacingBookkeeping(store, { ...legacy, completedUnits: ["update"], usageLinked: true });
    expect(r.failedUnits).toEqual([]);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM recall_events WHERE usage_id = ?`).get(u) as { n: number }).n).toBe(1);
    expect(turnState(store, u)?.state).toBe("unattributable");
  });

  it("a named vault's mirror records its general row, pins its own membership, counts its documents surfaced once, and waits", () => {
    const general = createTestStore();
    const vault = createTestStore();
    seedDoc(general, "notes", "a.md", "Alpha design notes");
    const v = seedDoc(vault, "skills", "tools/linter.md", "Linter configuration guide");
    const u = usageRow(general, { sessionId: "s1", t: 101, prompt: "p", path: "/tmp/s1.jsonl" });
    const job = manifestJob(u, "s1", [
      { vault: null, displayPath: "notes/a.md", title: "Alpha design notes" },
      { vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide" },
    ], { promptSha: promptSha("p"), transcriptKey: transcriptKey("/tmp/s1.jsonl"), host: "claude-code" });
    const opts = { resolveVaultStore: () => vault };
    expect(applySurfacingBookkeeping(general, job, opts).failedUnits).toEqual([]);
    expect(ledger(general, u).map(e => [e.vault, e.display_path])).toEqual([["", "notes/a.md"], ["skills", "skills/tools/linter.md"]]);
    const mirror = vault.db.prepare(`SELECT id, source_usage_id, prompt_sha, transcript_key FROM context_usage`).get() as { id: number; source_usage_id: number; prompt_sha: string; transcript_key: string };
    expect(mirror.source_usage_id).toBe(u);
    expect(mirror.prompt_sha).toBe(promptSha("p"));
    expect(ledger(vault, mirror.id)).toEqual([{ vault: "", vault_doc_id: v, display_path: "skills/tools/linter.md", displayed_title: "Linter configuration guide", referenced_at: null }]);
    expect(utility(vault, "skills/tools/linter.md")!.surfaced_count).toBe(1);
    expect(turnState(vault, mirror.id)).toEqual({ state: "pending", reason: null });
    // A retried vault unit adds nothing.
    applySurfacingBookkeeping(general, { ...job, completedUnits: ["update", "general"], usageLinked: true }, opts);
    expect(utility(vault, "skills/tools/linter.md")!.surfaced_count).toBe(1);
    expect((vault.db.prepare(`SELECT COUNT(*) AS n FROM context_usage`).get() as { n: number }).n).toBe(1);
  });

  it("an event written after its entry was referenced is written referenced (reconcile)", () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a.md", "Alpha design notes");
    const u = usageRow(store, { sessionId: "s1", t: 101, prompt: "p", path: "/tmp/s1.jsonl" });
    const job = manifestJob(u, "s1", [{ vault: null, displayPath: "notes/a.md", title: "Alpha design notes" }]);
    applySurfacingBookkeeping(store, job);
    store.db.prepare(`UPDATE feedback_ledger SET referenced_at = ? WHERE usage_id = ?`).run(iso(500), u);
    store.db.prepare(`DELETE FROM recall_events WHERE usage_id = ?`).run(u);
    applySurfacingBookkeeping(store, { ...job, completedUnits: undefined, usageLinked: undefined });
    expect((store.db.prepare(`SELECT was_referenced FROM recall_events WHERE usage_id = ? AND doc_id = ?`).get(u, a) as { was_referenced: number }).was_referenced).toBe(1);
  });
});

// ─── The reference test ────────────────────────────────────────────────────────────────────────────────────────────
describe("D6 the manifest reference test (test 2)", () => {
  const ref = () => import("../../src/recall-attribution.ts");
  const e = (key: string, displayPath: string, title: string | null, vault = "") => ({ key, vault, displayPath, displayedTitle: title });

  it("a display path or a 2+-segment path credits; a generic basename alone does not", async () => {
    const { verifiedReferences } = await ref();
    const m = [e("A", "notes/skills/alpha/SKILL.md", "Alpha skill"), e("B", "notes/projects/ingest-plan.md", "Ingest pipeline plan")];
    expect([...verifiedReferences("I followed SKILL.md closely.", m)]).toEqual([]);
    expect([...verifiedReferences("Per alpha/SKILL.md, do X.", m)]).toEqual(["A"]);
    expect([...verifiedReferences("See notes/projects/ingest-plan.md.", m)]).toEqual(["B"]);
    expect([...verifiedReferences("The ingest-plan.md file says so.", m)]).toEqual(["B"]);
  });

  it("a path, basename or title shared by two entries credits neither", async () => {
    const { verifiedReferences } = await ref();
    const m = [e("A", "notes/a/plan.md", "Deployment runbook notes"), e("B", "notes/b/plan.md", "Deployment runbook notes")];
    expect([...verifiedReferences("As plan.md explains.", m)]).toEqual([]);
    expect([...verifiedReferences("The Deployment runbook notes cover it.", m)]).toEqual([]);
    expect([...verifiedReferences("See a/plan.md.", m)]).toEqual(["A"]);
    const vaults = [e("G", "notes/x.md", "Shared cache design", ""), e("V", "notes/x.md", "Other thing entirely", "skills")];
    expect([...verifiedReferences("Look at notes/x.md now.", vaults)]).toEqual([]);
  });

  it("a title credits only when long and specific enough, as a word-bounded phrase, never a date-stamped system title", async () => {
    const { verifiedReferences } = await ref();
    const m = [e("A", "notes/a.md", "Ingest pipeline plan"), e("B", "notes/b.md", "Plan"), e("C", "_clawmem/decisions/2026-09-30-x.md", "Decisions 2026-09-30")];
    expect([...verifiedReferences("the ingest pipeline plan says batch", m)]).toEqual(["A"]);
    expect([...verifiedReferences("the xingest pipeline plans", m)]).toEqual([]);
    expect([...verifiedReferences("Plan: see Decisions 2026-09-30", m)]).toEqual([]);
  });

  it("paths must be bounded tokens", async () => {
    const { verifiedReferences } = await ref();
    const m = [e("A", "notes/a/plan.md", null)];
    expect([...verifiedReferences("xa/plan.md", m)]).toEqual([]);
    expect([...verifiedReferences("a/plan.md.bak", m)]).toEqual([]);
    expect([...verifiedReferences("(a/plan.md)", m)]).toEqual(["A"]);
  });
});

// ─── Attribution through feedback-loop ─────────────────────────────────────────────────────────────────────────────
describe("D6 feedback-loop attributes each turn once, by identity (tests 1, 3, 4, 24, 49)", () => {
  function scenario() {
    const store = createTestStore();
    const dir = tmp();
    const x = seedDoc(store, "notes", "projects/ingest-plan.md", "Ingest pipeline plan");
    const y = seedDoc(store, "notes", "ops/deploy-runbook.md", "Deployment runbook notes");
    const path = writeTranscriptFile(dir, "s1.jsonl", [
      human("first question about ingest", 100), assistant("Per notes/projects/ingest-plan.md we batch writes.", 110),
      human("keepalive", 200), assistant("still here", 210),
      human("third question about deploys", 300), assistant("The Deployment runbook notes say: canary first.", 310),
    ]);
    const u1 = usageRow(store, { sessionId: "s1", t: 101, prompt: "first question about ingest", path, turnIndex: 0 });
    const u3 = usageRow(store, { sessionId: "s1", t: 301, prompt: "third question about deploys", path, turnIndex: 1 });
    applySurfacingBookkeeping(store, manifestJob(u1, "s1", [{ vault: null, displayPath: "notes/projects/ingest-plan.md", title: "Ingest pipeline plan" }], { turnIndex: 0 }));
    applySurfacingBookkeeping(store, manifestJob(u3, "s1", [{ vault: null, displayPath: "notes/ops/deploy-runbook.md", title: "Deployment runbook notes" }], { turnIndex: 1 }));
    return { store, path, x, y, u1, u3 };
  }

  it("a heartbeat turn without a row does not shift attribution; each reference is credited to its own row", async () => {
    const { store, path, x, y, u1, u3 } = scenario();
    await feedbackLoop(store, { sessionId: "s1", transcriptPath: path });
    expect(ledger(store, u1)[0]!.referenced_at).not.toBeNull();
    expect(ledger(store, u3)[0]!.referenced_at).not.toBeNull();
    expect(turnState(store, u1)!.state).toBe("attributed");
    expect(turnState(store, u3)!.state).toBe("attributed");
    expect(accessOf(store, x)).toBe(1);
    expect(accessOf(store, y)).toBe(1);
    expect((store.db.prepare(`SELECT was_referenced FROM recall_events WHERE usage_id = ? AND doc_id = ?`).get(u3, y) as { was_referenced: number }).was_referenced).toBe(1);
    expect((store.db.prepare(`SELECT was_referenced FROM context_usage WHERE id = ?`).get(u3) as { was_referenced: number }).was_referenced).toBe(1);
    expect(utility(store, "notes/ops/deploy-runbook.md")).toMatchObject({ surfaced_count: 1, referenced_count: 1 });
    expect(legacyLog(store)).toBe(0);
  });

  it("a second Stop over the same transcript changes nothing (test 1)", async () => {
    const { store, path, x, u1 } = scenario();
    await feedbackLoop(store, { sessionId: "s1", transcriptPath: path });
    await feedbackLoop(store, { sessionId: "s1", transcriptPath: path });
    expect(accessOf(store, x)).toBe(1);
    expect(utility(store, "notes/projects/ingest-plan.md")).toMatchObject({ surfaced_count: 1, referenced_count: 1 });
    expect(turnState(store, u1)!.state).toBe("attributed");
  });

  it("co-references in one turn record one co-activation and one usage relation, never across turns", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
    const b = seedDoc(store, "notes", "b/beta.md", "Beta rollout checklist");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("compare alpha and beta please", 100), assistant("Both a/alpha.md and b/beta.md agree.", 110)]);
    const u = usageRow(store, { sessionId: "s", t: 101, prompt: "compare alpha and beta please", path });
    applySurfacingBookkeeping(store, manifestJob(u, "s", [
      { vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" },
      { vault: null, displayPath: "notes/b/beta.md", title: "Beta rollout checklist" },
    ]));
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    expect((store.db.prepare(`SELECT count FROM co_activations`).get() as { count: number }).count).toBe(1);
    const rel = store.db.prepare(`SELECT source_id, target_id, weight FROM memory_relations WHERE relation_type = 'usage'`).all() as { source_id: number; target_id: number; weight: number }[];
    expect(rel.length).toBe(1);
    expect([rel[0]!.source_id, rel[0]!.target_id].sort()).toEqual([a, b].sort());
    expect(rel[0]!.weight).toBe(1);
  });

  it("a turn whose rows cannot be told apart is concluded unattributable, never guessed", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [
      human("same prompt text", 100), assistant("a/alpha.md", 110), human("next prompt text", 200), assistant("ok", 210),
    ]);
    const u1 = usageRow(store, { sessionId: "s", t: 101, prompt: "same prompt text", path });
    const u2 = usageRow(store, { sessionId: "s", t: 102, prompt: "same prompt text", path });
    for (const u of [u1, u2]) applySurfacingBookkeeping(store, manifestJob(u, "s", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }]));
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    expect(turnState(store, u1)!.state).toBe("unattributable");
    expect(turnState(store, u2)!.state).toBe("unattributable");
    expect(accessOf(store, a)).toBe(0);
  });

  it("rows of another transcript of the same session id are left alone (tests 24, 36)", async () => {
    const store = createTestStore();
    const dir = tmp();
    seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
    const base = writeTranscriptFile(dir, "s.jsonl", [human("question about alpha", 100), assistant("a/alpha.md", 110)]);
    const topic = writeTranscriptFile(dir, "s-topic-1.jsonl", [human("question about alpha", 100), assistant("a/alpha.md", 110)]);
    const ub = usageRow(store, { sessionId: "s", t: 101, prompt: "question about alpha", path: base });
    const ut = usageRow(store, { sessionId: "s", t: 101, prompt: "question about alpha", path: topic, turnIndex: 1 });
    applySurfacingBookkeeping(store, manifestJob(ub, "s", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }]));
    applySurfacingBookkeeping(store, manifestJob(ut, "s", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }], { turnIndex: 1 }));
    await feedbackLoop(store, { sessionId: "s", transcriptPath: base });
    expect(turnState(store, ub)!.state).toBe("attributed");
    expect(turnState(store, ut)!.state).toBe("pending");
  });

  it("a path the drainer fills after the last Stop is attributed by a later invocation (test 6)", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("question about alpha", 100), assistant("a/alpha.md helps", 110)]);
    const u = usageRow(store, { sessionId: "s", t: 101, prompt: "question about alpha", path });
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });       // the Stop ran before the drain
    applySurfacingBookkeeping(store, manifestJob(u, "s", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }]));
    appendEntries(path, [human("another question", 200), assistant("sure", 210)]);
    await feedbackLoop(store, { sessionId: "s", transcriptPath: path });
    expect(turnState(store, u)!.state).toBe("attributed");
    expect(accessOf(store, a)).toBe(1);
  });

  it("an OpenClaw keyless row is bound by agent_end's session key, then paired by OpenClaw's rule (test 49)", async () => {
    const store = createTestStore();
    const a = seedDoc(store, "notes", "a/alpha.md", "Alpha design notes");
    const path = writeTranscriptFile(tmp(), "s-oc.jsonl", [ocMessage("user", "question about alpha", 100), ocMessage("assistant", "See a/alpha.md.", 120)]);
    const u = usageRow(store, { sessionId: "s-oc", t: 95, prompt: "question about alpha", path: null, host: "openclaw", sessionKey: "agent:main:topic-1" });
    applySurfacingBookkeeping(store, manifestJob(u, "s-oc", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }]));
    await feedbackLoop(store, { sessionId: "s-oc", transcriptPath: path, host: "openclaw", sessionKey: "agent:main:other" });
    expect(turnState(store, u)!.state).toBe("pending");    // another session key: not this row's transcript
    await feedbackLoop(store, { sessionId: "s-oc", transcriptPath: path, host: "openclaw", sessionKey: "agent:main:topic-1" });
    expect(turnState(store, u)!.state).toBe("attributed");
    expect(accessOf(store, a)).toBe(1);
  });

  it("does nothing on a vault whose stop-pipeline migration is not verified for this connection", async () => {
    const dir = tmp();
    const dbPath = join(dir, "index.sqlite");
    const s0 = createStore(dbPath);
    const a = seedDoc(s0, "notes", "a/alpha.md", "Alpha design notes");
    const path = writeTranscriptFile(dir, "s.jsonl", [human("question about alpha", 100), assistant("a/alpha.md", 110)]);
    const u = usageRow(s0, { sessionId: "s", t: 101, prompt: "question about alpha", path });
    applySurfacingBookkeeping(s0, manifestJob(u, "s", [{ vault: null, displayPath: "notes/a/alpha.md", title: "Alpha design notes" }]));
    s0.db.exec(`DELETE FROM vault_flags WHERE flag = 'stop-pipeline:schema-v1'`);
    s0.close();
    const holder = new Database(dbPath);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    const origError = console.error;
    console.error = () => {};
    let s1: Store;
    try { s1 = createStore(dbPath, { busyTimeout: 50 }); } finally { console.error = origError; holder.exec("ROLLBACK"); holder.close(); }
    await feedbackLoop(s1!, { sessionId: "s", transcriptPath: path });
    expect(accessOf(s1!, a)).toBe(0);
    expect(turnState(s1!, u)!.state).toBe("pending");
    s1!.close();
  });
});

describe("D6 named vaults apply their slice of the general verdict (tests 25, 50, 52)", () => {
  function setup() {
    const general = createTestStore();
    const vault = createTestStore();
    const g = seedDoc(general, "notes", "cache/design.md", "Shared cache design");
    const v = seedDoc(vault, "skills", "tools/linter.md", "Linter configuration guide");
    return { general, vault, g, v };
  }
  const vaultsOf = (vault: Store) => ({ vaults: [{ name: "skills", store: vault }] });

  it("a title shown only for a named-vault document is credited to that entry and applied in that vault", async () => {
    const { general, vault, v } = setup();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("how do we lint", 100), assistant("The Linter configuration guide says strict.", 110)]);
    const u = usageRow(general, { sessionId: "s", t: 101, prompt: "how do we lint", path });
    applySurfacingBookkeeping(general, manifestJob(u, "s", [
      { vault: null, displayPath: "notes/cache/design.md", title: "Shared cache design" },
      { vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide" },
    ]), { resolveVaultStore: () => vault });
    await feedbackLoop(general, { sessionId: "s", transcriptPath: path }, vaultsOf(vault));
    const entries = ledger(general, u);
    expect(entries.find(e => e.vault === "skills")!.referenced_at).not.toBeNull();
    expect(entries.find(e => e.vault === "")!.referenced_at).toBeNull();
    const mirrorId = (vault.db.prepare(`SELECT id FROM context_usage`).get() as { id: number }).id;
    expect(turnState(vault, mirrorId)!.state).toBe("attributed");
    expect(accessOf(vault, v)).toBe(1);
    expect(utility(vault, "skills/tools/linter.md")).toMatchObject({ surfaced_count: 1, referenced_count: 1 });
    // A second pass changes nothing in either vault.
    await feedbackLoop(general, { sessionId: "s", transcriptPath: path }, vaultsOf(vault));
    expect(accessOf(vault, v)).toBe(1);
  });

  it("a title shared by entries of two vaults credits neither; a retitled document matches only its displayed title", async () => {
    const { general, vault, g, v } = setup();
    const dir = tmp();
    const p1 = writeTranscriptFile(dir, "s1.jsonl", [human("which config", 100), assistant("Use the Linter configuration guide.", 110)]);
    const u1 = usageRow(general, { sessionId: "s1", t: 101, prompt: "which config", path: p1 });
    applySurfacingBookkeeping(general, manifestJob(u1, "s1", [
      { vault: null, displayPath: "notes/cache/design.md", title: "Linter configuration guide" },
      { vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide" },
    ]), { resolveVaultStore: () => vault });
    await feedbackLoop(general, { sessionId: "s1", transcriptPath: p1 }, vaultsOf(vault));
    expect(ledger(general, u1).every(e => e.referenced_at === null)).toBe(true);
    expect(accessOf(general, g)).toBe(0);
    expect(accessOf(vault, v)).toBe(0);

    general.db.prepare(`UPDATE documents SET title = 'Cache design, revised' WHERE id = ?`).run(g);
    const p2 = writeTranscriptFile(dir, "s2.jsonl", [human("cache question", 100), assistant("Cache design, revised is the new doc; Shared cache design explains it.", 110)]);
    const u2 = usageRow(general, { sessionId: "s2", t: 101, prompt: "cache question", path: p2 });
    applySurfacingBookkeeping(general, manifestJob(u2, "s2", [{ vault: null, displayPath: "notes/cache/design.md", title: "Shared cache design" }]));
    await feedbackLoop(general, { sessionId: "s2", transcriptPath: p2 }, vaultsOf(vault));
    expect(ledger(general, u2)[0]!.referenced_at).not.toBeNull();   // matched on the displayed title
    expect(accessOf(general, g)).toBe(1);
  });

  it("a mirror inserted after its general row was attributed is completed by the next pass; one without a source row is unattributable", async () => {
    const { general, vault, v } = setup();
    const path = writeTranscriptFile(tmp(), "s.jsonl", [human("how do we lint", 100), assistant("skills/tools/linter.md is strict.", 110)]);
    const u = usageRow(general, { sessionId: "s", t: 101, prompt: "how do we lint", path });
    const job = manifestJob(u, "s", [{ vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide" }]);
    // The vault unit fails first (vault unavailable), so the general row is attributed before its mirror exists.
    const r1 = applySurfacingBookkeeping(general, job, { resolveVaultStore: () => { throw new Error("vault busy"); } });
    expect(r1.failedUnits).toEqual(["vault:skills"]);
    await feedbackLoop(general, { sessionId: "s", transcriptPath: path }, vaultsOf(vault));
    expect(turnState(general, u)!.state).toBe("attributed");
    applySurfacingBookkeeping(general, { ...job, completedUnits: r1.completedUnits, usageLinked: r1.usageLinked }, { resolveVaultStore: () => vault });
    await feedbackLoop(general, { sessionId: "s", transcriptPath: path }, vaultsOf(vault));
    const mirrorId = (vault.db.prepare(`SELECT id FROM context_usage`).get() as { id: number }).id;
    expect(turnState(vault, mirrorId)!.state).toBe("attributed");
    expect(accessOf(vault, v)).toBe(1);

    // A mirror whose general row never linked (the alignment row was gone) carries no source row.
    const orphanJob = manifestJob(999_999, "s-orphan", [{ vault: "skills", displayPath: "skills/tools/linter.md", title: "Linter configuration guide" }]);
    applySurfacingBookkeeping(general, orphanJob, { resolveVaultStore: () => vault });
    const orphan = vault.db.prepare(`SELECT id, source_usage_id FROM context_usage WHERE session_id = 's-orphan'`).get() as { id: number; source_usage_id: number | null };
    expect(orphan.source_usage_id).toBeNull();
    expect(turnState(vault, orphan.id)!.state).toBe("unattributable");
  });
});

describe("D6 the manifest is exactly the rendered results (test 53)", () => {
  it("two vaults hold the same display path and the budget renders one: the manifest and the event groups hold exactly it", async () => {
    const { buildContext } = await import("../../src/hooks/context-surfacing.ts");
    const { verifiedReferences } = await import("../../src/recall-attribution.ts");
    const big = "shared cache word ".repeat(200);
    const mk = (vault: string | null, title: string) => ({
      displayPath: "notes/shared.md", filepath: "clawmem://notes/shared.md", title, body: big, compositeScore: 0.9,
      contentType: "note", chunkPos: 0, ...(vault ? { _fromVault: vault } : {}),
    }) as any;
    const out = buildContext([mk(null, "General shared document"), mk("skills", "Skill shared document")], "shared cache", 1);
    expect(out.manifest).toEqual([{ vault: null, displayPath: "notes/shared.md", displayedTitle: "General shared document", docId: null }]);
    expect(out.accepted.map((r: any) => r._fromVault ?? null)).toEqual([null]);
    const refs = verifiedReferences("See notes/shared.md.", out.manifest.map(m => ({ key: `${m.vault ?? ""}|${m.displayPath}`, vault: m.vault ?? "", displayPath: m.displayPath, displayedTitle: m.displayedTitle })));
    expect([...refs]).toEqual(["|notes/shared.md"]);
  });
});
