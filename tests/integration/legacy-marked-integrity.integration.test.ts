/**
 * BACKLOG 82.3, D7 — INTEGRITY UNDER A SWALLOWED REFUSAL (DESIGN §7, D9 = C2). A vault holds a legacy document whose
 * path starts with a byte-order mark BESIDE its unmarked twin with a different body (`<mark>a.md`, `a.md`), a marked
 * session id and a marked handoff reference. Every entry point is run against it, and for each the test asserts three
 * things and NO MORE:
 *  1. no reply and no write treats one twin as the other;
 *  2. the identity of every marked row is kept — its identifier bytes, and the body it names;
 *  3. a before/after snapshot of every table changes only by the operations this test names in advance for that
 *     entry point (an operation that completed before a refusal counts as completed).
 * What an entry point RETURNS is NOT asserted: a typed error, a result without the refused leg and a step recorded
 * complete without the refused step all pass. This file is not a promise about replies.
 * No mark is typed into this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { createStore } from "../../src/store.ts";
import { serializeSurfacingBookkeepingJob, spoolDirForDb, validateSurfacingBookkeepingJob } from "../../src/hooks/surfacing-bookkeeping.ts";
import {
  MARKS, QUERY, changedTables, documentChanges, documentsById, expectedIdentity, identityOf, makeTwinVault, snapshot, twinConfusion,
  twinEnv, twinLlm,
  type TwinVault,
} from "../helpers/twin-vault.ts";

/** The tables the lifecycle sweep and restore rewrite: the documents rows (by id) and the full-text index. */
const FTS_AND_DOCS = ["documents", "documents_fts_content", "documents_fts_data", "documents_fts_docsize", "documents_fts_idx"];

/** A pin or a snooze: the documents row (its full-text entry follows it) and the usage record of the call. */
const PIN_WRITES = ["documents", "documents_fts_data", "documents_fts_idx", "context_usage"];
/** `active` of each twin, read by id. */
function activeById(t: TwinVault): { plain: number; marked: number } {
  const db = new Database(t.vault, { readonly: true });
  const a = (id: number) => (db.prepare(`SELECT active FROM documents WHERE id = ?`).get(id) as { active: number }).active;
  const out = { plain: a(t.plainId), marked: a(t.markedId) };
  db.close();
  return out;
}

/** The plain twin carries the change and the marked twin does not. */
function pinState(t: TwinVault, column: "pinned" | "snoozed_until", value: unknown): void {
  const db = new Database(t.vault, { readonly: true });
  const v = (id: number) => (db.prepare(`SELECT ${column} v FROM documents WHERE id = ?`).get(id) as { v: unknown }).v;
  const got = { plain: v(t.plainId), marked: v(t.markedId) };
  db.close();
  expect(column === "snoozed_until" ? { plain: String(got.plain).slice(0, 10), marked: got.marked } : got)
    .toEqual({ plain: value, marked: column === "pinned" ? 0 : null });
}

type Route = { tool: string; args: (t: TwinVault) => Record<string, unknown>; writes?: string[]; why?: string; after?: (t: TwinVault) => void;
  /** A precondition of the test, not a promise about replies: the route found the document it was given. */
  reaches?: boolean };
const ROUTES: Route[] = [
  { tool: "search", args: () => ({ query: QUERY }) },
  { tool: "search", args: () => ({ query: QUERY, compact: true }) },
  { tool: "vsearch", args: () => ({ query: QUERY, compact: true }) },
  { tool: "query", args: () => ({ query: QUERY, compact: true }) },
  { tool: "intent_search", args: () => ({ query: QUERY }), writes: ["intent_classifications"], why: "the intent classifier caches the query's class before the search" },
  { tool: "memory_retrieve", args: () => ({ query: QUERY }) },
  { tool: "query_plan", args: () => ({ query: QUERY }) },
  { tool: "find_similar", args: () => ({ file: "notes/a.md" }) },
  { tool: "get", args: () => ({ file: "notes/a.md" }) },
  { tool: "get", args: t => ({ file: "notes/" + t.markedPath }) },
  { tool: "multi_get", args: () => ({ pattern: "*.md" }) },
  { tool: "multi_get", args: t => ({ pattern: `notes/a.md,notes/${t.markedPath}` }) },
  { tool: "timeline", args: t => ({ docid: "#" + t.plainHash.slice(0, 6) }), reaches: true },
  { tool: "find_causal_links", args: t => ({ docid: "#" + t.plainHash.slice(0, 6) }), reaches: true },
  { tool: "session_log", args: () => ({ limit: 5 }) },
  { tool: "profile", args: () => ({}) },
  { tool: "memory_pin", args: () => ({ query: "tank filter weekly" }), writes: PIN_WRITES, why: "the query names the plain twin alone: it is pinned, by its id", after: t => pinState(t, "pinned", 1) },
  { tool: "memory_snooze", args: () => ({ query: "tank filter weekly", until: "2099-01-01" }), writes: PIN_WRITES, why: "the plain twin is snoozed, by its id", after: t => pinState(t, "snoozed_until", "2099-01-01") },
  { tool: "memory_forget", args: () => ({ query: "tank filter weekly" }) },
  { tool: "lifecycle_status", args: () => ({}) },
  { tool: "lifecycle_sweep", args: () => ({ dry_run: true }) },
  { tool: "lifecycle_sweep", args: () => ({ dry_run: false }), writes: FTS_AND_DOCS, why: "the sweep archives the marked twin by its id; the plain twin is pinned (above) and kept",
    after: t => expect(activeById(t)).toEqual({ plain: 1, marked: 0 }) },
  { tool: "lifecycle_restore", args: () => ({ query: "tank" }), writes: FTS_AND_DOCS, why: "the restore brings the marked twin back by its id",
    after: t => expect(activeById(t)).toEqual({ plain: 1, marked: 1 }) },
];

for (const [markName, mark] of MARKS) {
  describe(`MCP routes in process — a ${markName}-led legacy row beside its twin`, () => {
    let t: TwinVault;
    let client: Client;
    let close: () => void;
    beforeAll(async () => {
      t = makeTwinVault(mark);
      process.env.INDEX_PATH = t.vault;
      process.env.CLAWMEM_CONFIG_DIR = t.cfgDir;
      setDefaultLlamaCpp(twinLlm);
      const built = buildMcpServer();
      close = built.closeAllStores;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await built.server.connect(st);
      client = new Client({ name: "twin", version: "0" });
      await client.connect(ct);
    });
    afterAll(() => {
      try { close(); } catch { /* closed */ }
      setDefaultLlamaCpp(null);
      delete process.env.INDEX_PATH;
      delete process.env.CLAWMEM_CONFIG_DIR;
      rmSync(t.dir, { recursive: true, force: true });
    });

    for (const r of ROUTES) {
      test(`${r.tool} ${JSON.stringify(Object.keys(r.args({ markedPath: "x", plainHash: "h" } as TwinVault)))}${r.why ? ` (named write: ${r.why})` : ""}`, async () => {
        const before = snapshot(t.vault);
        let reply: unknown;
        try { reply = await client.callTool({ name: r.tool, arguments: r.args(t) }); } catch (e) { reply = String(e); }
        expect(twinConfusion(reply, t)).toEqual([]);
        expect(identityOf(t)).toBe(expectedIdentity(t));
        const changed = Object.keys(changedTables(before, snapshot(t.vault)));
        expect(changed.filter(c => !(r.writes ?? []).includes(c))).toEqual([]);
        r.after?.(t);
        if (r.reaches) expect(JSON.stringify(reply)).not.toContain("not found");
      });
    }

    test("after the sweep and the restore both twins are active again, each with its own path bytes and body", () => {
      expect(identityOf(t)).toBe(expectedIdentity(t));
      expect(activeById(t)).toEqual({ plain: 1, marked: 1 });
    });
  });
}

describe("the twin check itself sees a confusion (constructed replies)", () => {
  const t = { mark: MARKS[0]![1], plainHash: "a".repeat(64), markedHash: "b".repeat(64) };
  const m = t.mark + "a.md";
  test.each([
    ["plain path + marked body", { results: [{ path: "notes/a.md", snippet: "MARKEDTWIN …" }] }],
    ["plain path + marked docid in a text line", "1. notes/a.md #bbbbbb score 0.9"],
    ["plain path + marked title", { content: [{ type: "text", text: "notes/a.md — Marked twin" }] }],
    ["marked path + plain body", { results: [{ file: "notes/" + m, body: "PLAINTWIN …" }] }],
  ])("%s → flagged", (_name, reply) => {
    expect(twinConfusion(reply, t).length).toBeGreaterThan(0);
  });
  test.each([
    ["each twin with its own body", { results: [{ path: "notes/a.md", snippet: "PLAINTWIN" }, { path: "notes/" + m, snippet: "MARKEDTWIN" }] }],
    ["a block that names both twins", `- notes/a.md\n- notes/${m}`],
  ])("%s → not flagged", (_name, reply) => {
    expect(twinConfusion(reply, t)).toEqual([]);
  });
});

// ─── Hooks and the CLI, in child processes; the guard's warnings counted ───────────────────────────────────────────
const ROOT = new URL("../..", import.meta.url).pathname;
const REFUSAL_LINE = "A statement was refused";
function child(t: TwinVault, argv: string[], stdin?: unknown, rawStdin?: string): { code: number | null; out: string; err: string } {
  const env = twinEnv(t);
  env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  const input = rawStdin !== undefined ? Buffer.from(rawStdin) : stdin === undefined ? undefined : Buffer.from(JSON.stringify(stdin));
  const p = Bun.spawnSync([process.execPath, "src/clawmem.ts", ...argv], { env, cwd: ROOT, stdin: input });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const refusals = (err: string) => err.split("\n").filter(l => l.includes(REFUSAL_LINE)).length;
function transcript(t: TwinVault): string {
  const path = join(t.dir, "transcript.jsonl");
  const line = (role: "user" | "assistant", text: string, i: number) => JSON.stringify({
    type: role, uuid: `u-${i}`, sessionId: "sess-plain", timestamp: new Date(Date.now() - (10 - i) * 1000).toISOString(),
    message: { role, content: [{ type: "text", text }] },
  });
  writeFileSync(path, [
    line("user", "How often is the tank filter cleaned?", 1),
    line("assistant", "We decided to clean the tank filter weekly and to change the water on Sunday.", 2),
  ].join("\n") + "\n");
  return path;
}

/** A hook run: its input, the warnings its process writes (exactly), and the writes this test names in advance. */
type HookCase = { hook: string; input: (t: TwinVault, tp: string) => Record<string, unknown>; warnings: 0 | 1; writes?: string[]; why?: string };
const PROMPT = "the tank filter is cleaned, says the twin";   // long enough to be surfaced; every word is in both bodies
const HOOKS: HookCase[] = [
  { hook: "context-surfacing", warnings: 1, writes: ["context_usage"], why: "this turn's usage row (it records nothing injected)", input: t => ({ session_id: "sess-plain", prompt: PROMPT, hook_event_name: "UserPromptSubmit", cwd: t.dir }) },
  { hook: "session-bootstrap", warnings: 1, writes: ["session_log"], why: "the new session's own row, written before the marked handoff is read",
    input: t => ({ session_id: "sess-plain", hook_event_name: "SessionStart", source: "startup", cwd: t.dir }) },
  { hook: "staleness-check", warnings: 0, input: t => ({ session_id: "sess-plain", hook_event_name: "SessionStart", source: "startup", cwd: t.dir }) },
  { hook: "precompact-extract", warnings: 0, writes: ["compaction_state", "context_usage", "registry:registration"], why: "this session's PreCompact: its state, its usage row and its registration",
    input: (t, tp) => ({ session_id: "sess-plain", transcript_path: tp, hook_event_name: "PreCompact", cwd: t.dir }) },
  { hook: "postcompact-inject", warnings: 0, writes: ["compaction_state", "context_usage", "registry:registration"], why: "this session's state consumed, its usage row, its registration marked consumed",
    input: (t, tp) => ({ session_id: "sess-plain", transcript_path: tp, hook_event_name: "SessionStart", source: "compact", cwd: t.dir }) },
  { hook: "decision-extractor", warnings: 0, writes: ["session_transcripts", "stop_cursors", "stop_retries", "vault_flags"], why: "this transcript's range recorded and queued for a retry (no model is reachable)",
    input: (t, tp) => ({ session_id: "sess-plain", transcript_path: tp, hook_event_name: "Stop", cwd: t.dir }) },
  { hook: "handoff-generator", warnings: 0, writes: ["stop_cursors", "stop_items"], why: "this transcript's handoff cursor and item",
    input: (t, tp) => ({ session_id: "sess-plain", transcript_path: tp, hook_event_name: "Stop", cwd: t.dir }) },
  { hook: "feedback-loop", warnings: 0, input: (t, tp) => ({ session_id: "sess-plain", transcript_path: tp, hook_event_name: "Stop", cwd: t.dir }) },
];

for (const [markName, mark] of MARKS) {
  describe(`hooks and the CLI in child processes — a ${markName}-led legacy row beside its twin`, () => {
    let t: TwinVault;
    let tp: string;
    beforeAll(() => { t = makeTwinVault(mark, { lifecycle: false, ageDays: 0 }); tp = transcript(t); });
    afterAll(() => { rmSync(t.dir, { recursive: true, force: true }); });

    for (const h of HOOKS) {
      test(`hook ${h.hook}${h.why ? ` (named write: ${h.why})` : ""}`, () => {
        const before = snapshot(t.vault);
        const r = child(t, ["hook", h.hook], h.input(t, tp));
        expect(twinConfusion(r.out, t)).toEqual([]);
        expect(identityOf(t)).toBe(expectedIdentity(t));
        expect(Object.keys(changedTables(before, snapshot(t.vault))).filter(c => !(h.writes ?? []).includes(c))).toEqual([]);
        expect(refusals(r.err)).toBe(h.warnings);                        // one warning per process that refused, none otherwise
      }, 30_000);
    }

    test("clawmem update of the configured collection (it reaches the marked row and is refused): every row of the collection is as it was", () => {
      const before = snapshot(t.vault);
      const r = child(t, ["update"]);
      expect(identityOf(t)).toBe(expectedIdentity(t));
      expect(changedTables(before, snapshot(t.vault))).toEqual({});
      expect(refusals(r.err)).toBe(1);                                  // it did reach the marked row
    }, 60_000);

    test("the CLI prints a refusal as ONE message — no stack trace, no source lines (ruling 67 A), exit 1", () => {
      const u = makeTwinVault(mark, { lifecycle: false, ageDays: 0, markedFile: false });
      try {
        const r = child(u, ["update"]);
        expect(r.code).toBe(1);
        expect(r.err).toContain("Error:");
        expect(r.err).toContain("a bound string starts with");
        expect(r.err).not.toMatch(/^\s+at \S+ \(/m);                     // no stack frame
        expect(r.err).not.toMatch(/^\d+ \| /m);                           // no source line
      } finally { rmSync(u.dir, { recursive: true, force: true }); }
    }, 60_000);

    test("clawmem update with the marked FILE gone (the stored row alone): refused once, no table changed", () => {
      const u = makeTwinVault(mark, { lifecycle: false, ageDays: 0, markedFile: false });
      try {
        const before = snapshot(u.vault);
        const r = child(u, ["update"]);
        expect(r.err).not.toContain("[indexer] refused");                // the file is not what is refused
        expect(refusals(r.err)).toBe(1);
        expect(changedTables(before, snapshot(u.vault))).toEqual({});
        expect(identityOf(u)).toBe(expectedIdentity(u));
      } finally { rmSync(u.dir, { recursive: true, force: true }); }
    }, 60_000);

    test("clawmem doctor only READS the marked rows: it lists them and its process writes no warning", () => {
      const before = snapshot(t.vault);
      const r = child(t, ["doctor"]);
      expect(refusals(r.err)).toBe(0);
      expect(identityOf(t)).toBe(expectedIdentity(t));
      expect(Object.keys(changedTables(before, snapshot(t.vault)))).toEqual([]);
    }, 60_000);
  });
}

describe("warnings in a healthy vault, and the lifecycle policy at session start", () => {
  test("a fresh process on a vault with no marked value writes no warning (the guard's self-check spends nothing)", () => {
    const t = makeTwinVault(MARKS[0]![1], { marked: false, lifecycle: false, ageDays: 0 });
    try {
      const r = child(t, ["hook", "context-surfacing"], { session_id: "sess-plain", prompt: PROMPT, hook_event_name: "UserPromptSubmit", cwd: t.dir });
      expect(refusals(r.err)).toBe(0);
    } finally { rmSync(t.dir, { recursive: true, force: true }); }
  }, 30_000);

  for (const [markName, mark] of MARKS) {
    test(`${markName}: staleness-check with a one-day policy archives BOTH twins, each by its id, and refuses nothing (named write)`, () => {
      const t = makeTwinVault(mark);
      try {
        const before = documentsById(t.vault);
        const r = child(t, ["hook", "staleness-check"], { session_id: "sess-plain", hook_event_name: "SessionStart", source: "startup", cwd: t.dir });
        expect(refusals(r.err)).toBe(0);
        const cols = ["active", "archived_at", "deactivated_reason"];
        expect(documentChanges(before, documentsById(t.vault))).toEqual({ [t.plainId]: cols, [t.markedId]: cols });
        expect(identityOf(t)).toBe(expectedIdentity(t));
      } finally { rmSync(t.dir, { recursive: true, force: true }); }
    }, 30_000);
  }
});

// ─── Four controls: nothing is bound again, so nothing is refused and nothing warns ─────────────────────────────────
for (const [markName, mark] of MARKS) {
  describe(`controls — ${markName}`, () => {
    test("1. a marked row in an UNCONFIGURED collection is returned by a search, with its own title, beside its twin", () => {
      const t = makeTwinVault(mark, { configured: false, files: false, lifecycle: false, ageDays: 0 });
      try {
        const r = child(t, ["search", QUERY, "--json"]);
        expect(refusals(r.err)).toBe(0);
        const rows = JSON.parse(r.out) as { file: string; title: string }[];
        expect(rows.map(x => [x.file, x.title]).sort()).toEqual([["notes/" + t.markedPath, "Marked twin"], ["notes/a.md", "Plain twin"]].sort());
        expect(twinConfusion(rows, t)).toEqual([]);
      } finally { rmSync(t.dir, { recursive: true, force: true }); }
    }, 30_000);

    test("2. an API-origin marked row does not stop `update` of its collection", () => {
      // no marked handoff reference here: profile construction reads a handoff by its path (see the cleanup test)
      const t = makeTwinVault(mark, { markedOrigin: "api", markedFile: false, markedSession: false, lifecycle: false, ageDays: 0 });
      try {
        const r = child(t, ["update"]);
        expect({ code: r.code, warnings: refusals(r.err) }).toEqual({ code: 0, warnings: 0 });
        expect(identityOf(t)).toBe(expectedIdentity(t));
      } finally { rmSync(t.dir, { recursive: true, force: true }); }
    }, 60_000);

    test("3. the lifecycle sweep archives a marked-path document by its id (see the staleness-check and lifecycle_sweep cases above)", () => {
      const t = makeTwinVault(mark, { files: false });
      try {
        const before = documentsById(t.vault);
        const r = child(t, ["hook", "staleness-check"], { session_id: "sess-plain", hook_event_name: "SessionStart", source: "startup", cwd: t.dir });
        expect(refusals(r.err)).toBe(0);
        expect(documentChanges(before, documentsById(t.vault))[t.markedId]).toEqual(["active", "archived_at", "deactivated_reason"]);
      } finally { rmSync(t.dir, { recursive: true, force: true }); }
    }, 30_000);

    test("4. a new PreCompact replaces a marked stored attempt with a fresh token", () => {
      const t = makeTwinVault(mark, { files: false, lifecycle: false, ageDays: 0 });
      try {
        const tp = transcript(t);
        const input = { session_id: "sess-plain", transcript_path: tp, hook_event_name: "PreCompact", cwd: t.dir };
        child(t, ["hook", "precompact-extract"], input);
        const reg = new Database(t.vault + "-compaction.sqlite");
        reg.prepare(`UPDATE registration SET attempt = CAST(? AS TEXT) WHERE session_id = 'sess-plain'`).run(new TextEncoder().encode(mark + "old-attempt"));
        reg.close();
        const r = child(t, ["hook", "precompact-extract"], input);
        expect(refusals(r.err)).toBe(0);
        const ro = new Database(t.vault + "-compaction.sqlite", { readonly: true });
        const got = ro.prepare(`SELECT hex(attempt) h, attempt a FROM registration WHERE session_id = 'sess-plain'`).get() as { h: string; a: string };
        ro.close();
        expect(got.h.startsWith("EFBBBF") || got.h.startsWith("EFBFBE")).toBe(false);
        expect(got.a).toMatch(/^\d+-[0-9a-f]{12}$/);
      } finally { rmSync(t.dir, { recursive: true, force: true }); }
    }, 30_000);
  });
}

// ─── Through the vector daemon (its own process: its warnings are counted too) ─────────────────────────────────────
// Only the context hook sends its vector legs to the daemon (the MCP routes search in process, above). The daemon's
// own warning proves the hook's leg reached the marked row there.
for (const [markName, mark] of MARKS) {
  describe(`through the vector daemon — ${markName}`, () => {
    let t: TwinVault;
    let daemon: ReturnType<typeof Bun.spawn>;
    let daemonErr = "";
    beforeAll(async () => {
      t = makeTwinVault(mark, { lifecycle: false, ageDays: 0 });
      daemon = Bun.spawn([process.execPath, "tests/fixtures/twin-daemon.ts"], { env: twinEnv(t), cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const first = await (daemon.stdout as ReadableStream<Uint8Array>).getReader().read();
      expect(new TextDecoder().decode(first.value)).toContain("READY");
      void (async () => { for await (const c of daemon.stderr as ReadableStream<Uint8Array>) daemonErr += new TextDecoder().decode(c); })();
    });
    afterAll(async () => {
      try { daemon.kill(); await daemon.exited; } catch { /* gone */ }
      rmSync(t.dir, { recursive: true, force: true });
    });

    test("context-surfacing with the daemon live: the daemon refuses the marked hit (its ONE warning), the hook refuses once, usage row only", async () => {
      expect(refusals(daemonErr)).toBe(0);
      const before = snapshot(t.vault);
      const r = child(t, ["hook", "context-surfacing"], { session_id: "sess-plain", prompt: PROMPT, hook_event_name: "UserPromptSubmit", cwd: t.dir });
      expect(twinConfusion(r.out, t)).toEqual([]);
      expect(identityOf(t)).toBe(expectedIdentity(t));
      expect(Object.keys(changedTables(before, snapshot(t.vault))).filter(c => c !== "context_usage")).toEqual([]);
      expect(refusals(r.err)).toBe(1);
      await Bun.sleep(200);
      expect(refusals(daemonErr)).toBe(1);                              // the vector leg reached the marked row in the daemon
    }, 30_000);

    test("a second hook run: the daemon keeps serving and writes no second warning; the hook again refuses once", async () => {
      const r = child(t, ["hook", "context-surfacing"], { session_id: "sess-plain", prompt: PROMPT, hook_event_name: "UserPromptSubmit", cwd: t.dir });
      expect(refusals(r.err)).toBe(1);
      expect(identityOf(t)).toBe(expectedIdentity(t));
      await Bun.sleep(200);
      expect(refusals(daemonErr)).toBe(1);
    }, 30_000);

    test("after its refusals the daemon still answers: `clawmem vec-daemon-health` exits 0", () => {
      expect(child(t, ["vec-daemon-health"]).code).toBe(0);
    }, 30_000);
  });
}

// ─── The spool ingest (a child process, as the hook spawns it) ──────────────────────────────────────────────────────
// A bookkeeping job that NAMES a mark-led path (only a spool from before the upgrade can hold one) is discarded and
// reported, never applied or retried (ruling 68 A); a job naming the plain twin alone is applied as usual.
for (const [markName, mark] of MARKS) {
  describe(`the spool ingest — ${markName}`, () => {
    let t: TwinVault;
    let turn = 0;
    beforeAll(() => { t = makeTwinVault(mark, { lifecycle: false, ageDays: 0 }); });
    afterAll(() => { rmSync(t.dir, { recursive: true, force: true }); });
    const ingest = (paths: string[], sessionId = "sess-plain") => {
      const s = createStore(t.vault);
      const usageId = s.insertUsage({ sessionId: "sess-plain", timestamp: new Date().toISOString(), hookName: "context-surfacing", injectedPaths: [],
        estimatedTokens: 0, wasReferenced: 0, turnIndex: turn, queryText: "q", promptSha: "p", transcriptKey: null, host: "claude-code", sessionKey: null } as any);
      s.close();
      const job = { v: 1, kind: "surfacing-bookkeeping", jobId: `twin-job-${turn}`, sessionId, turnIndex: turn++, usageId, queryHash: "qh",
        injectedPaths: paths, estimatedTokens: 10, vaults: [{ vault: null, docs: paths.map(p => ({ displayPath: p, searchScore: 0.9 })) }] };
      const r = child(t, ["spool-ingest"], undefined, JSON.stringify(job));   // raw: the serializer itself refuses such a job
      return r;
    };
    /** A job file as a spool from BEFORE the upgrade holds it, planted directly, then drained. */
    const plantAndDrain = (paths: string[]) => {
      const s = createStore(t.vault);
      const usageId = s.insertUsage({ sessionId: "sess-plain", timestamp: new Date().toISOString(), hookName: "context-surfacing", injectedPaths: [],
        estimatedTokens: 0, wasReferenced: 0, turnIndex: turn, queryText: "q", promptSha: "p", transcriptKey: null, host: "claude-code", sessionKey: null } as any);
      s.close();
      const job = { v: 1, kind: "surfacing-bookkeeping", jobId: `old-job-${turn}`, sessionId: "sess-plain", turnIndex: turn++, usageId, queryHash: "qh",
        injectedPaths: paths, estimatedTokens: 10, vaults: [{ vault: null, docs: paths.map(p => ({ displayPath: p, searchScore: 0.9 })) }] };
      mkdirSync(spoolDirForDb(t.vault), { recursive: true });
      writeFileSync(join(spoolDirForDb(t.vault), `${Date.now()}-${process.pid}-0.json`), JSON.stringify(job));
      return child(t, ["spool-drain"]);
    };
    const spoolFiles = () => existsSync(spoolDirForDb(t.vault)) ? readdirSync(spoolDirForDb(t.vault), { recursive: true }).length : 0;

    test("a job naming the marked path is discarded with one line naming it: no warning, no write, nothing left in the spool", () => {
      const before = snapshot(t.vault);
      const r = ingest(["notes/a.md", "notes/" + t.markedPath]);
      expect(refusals(r.err)).toBe(0);
      expect(r.err).toContain("twin-job-0");
      expect(r.err).toContain("byte-order mark");
      expect(spoolFiles()).toBe(0);
      expect(Object.keys(changedTables(before, snapshot(t.vault))).filter(c => c !== "context_usage")).toEqual([]);   // the usage row is the test's own seed
      expect(identityOf(t)).toBe(expectedIdentity(t));
    }, 30_000);

    test("a job whose session id starts with the mark is discarded the same way", () => {
      const r = ingest(["notes/a.md"], mark + "sess");
      expect(refusals(r.err)).toBe(0);
      expect(r.err).toContain("byte-order mark");
      expect(spoolFiles()).toBe(0);
    }, 30_000);

    test("a job file from before the upgrade naming the marked path: the drain discards it with one line, no warning, no write", () => {
      const before = snapshot(t.vault);
      const r = plantAndDrain(["notes/a.md", "notes/" + t.markedPath]);
      expect(refusals(r.err)).toBe(0);
      expect(r.err).toContain("old-job-");
      expect(r.err).toContain("byte-order mark");
      expect(spoolFiles()).toBe(0);
      expect(Object.keys(changedTables(before, snapshot(t.vault))).filter(c => c !== "context_usage")).toEqual([]);
      expect(identityOf(t)).toBe(expectedIdentity(t));
    }, 30_000);

    test("the validator (and so the hook's serializer) refuses such a job, for a marked path and for a marked session id", () => {
      const base = { v: 1, kind: "surfacing-bookkeeping", jobId: "j", sessionId: "sess-plain", turnIndex: 0, usageId: 1, queryHash: "qh",
        injectedPaths: ["notes/a.md"], estimatedTokens: 1, vaults: [{ vault: null, docs: [{ displayPath: "notes/a.md", searchScore: 0.5 }] }] };
      const markedPath = { ...base, injectedPaths: ["notes/" + t.markedPath], vaults: [{ vault: null, docs: [{ displayPath: "notes/" + t.markedPath, searchScore: 0.5 }] }] };
      const markedSession = { ...base, sessionId: mark + "sess" };
      expect(validateSurfacingBookkeepingJob(base)).toBe(true);           // the control
      expect([validateSurfacingBookkeepingJob(markedPath), validateSurfacingBookkeepingJob(markedSession)]).toEqual([false, false]);
      expect([serializeSurfacingBookkeepingJob(markedPath as any), serializeSurfacingBookkeepingJob(markedSession as any)]).toEqual([null, null]);
    });

    test("a job naming the plain twin alone is applied (its recall event written), no warning, nothing left", () => {
      const before = snapshot(t.vault);
      const r = ingest(["notes/a.md"]);
      expect(refusals(r.err)).toBe(0);
      expect(spoolFiles()).toBe(0);
      expect(Object.keys(changedTables(before, snapshot(t.vault)))).toContain("recall_events");
      expect(identityOf(t)).toBe(expectedIdentity(t));
    }, 30_000);
  });
}

// ─── Worker phases, each in its own process (tests/fixtures/twin-worker.ts): both twins are observations ───────────
// Consolidation acts on documents by id: it reaches the marked row and binds no stored path, so nothing is refused.
const worker = (t: TwinVault, phase: string) => {
  const p = Bun.spawnSync([process.execPath, "tests/fixtures/twin-worker.ts", phase], { env: twinEnv(t), cwd: ROOT });
  return { out: p.stdout.toString(), err: p.stderr.toString() };
};
const consolidatedSources = (t: TwinVault) => {
  const db = new Database(t.vault, { readonly: true });
  const rows = db.prepare(`SELECT source_doc_ids s FROM consolidated_observations`).all() as { s: string }[];
  db.close();
  return rows.map(r => (JSON.parse(r.s) as number[]).slice().sort((a, b) => a - b));
};
for (const [markName, mark] of MARKS) {
  describe(`worker phases — ${markName}`, () => {
    const cases: { phase: string; writes: string[]; why: string; prep?: (t: TwinVault) => void; after?: (t: TwinVault) => void }[] = [
      { phase: "consolidate", writes: ["consolidated_observations"], why: "one observation over both twins, each named by its id",
        after: t => expect(consolidatedSources(t)).toEqual([[t.plainId, t.markedId].sort((a, b) => a - b)]) },
      { phase: "heavy", writes: ["consolidated_observations", "maintenance_runs"], why: "the lane's journal rows and the same observation",
        after: t => expect(consolidatedSources(t)).toEqual([[t.plainId, t.markedId].sort((a, b) => a - b)]) },
      { phase: "stop-tick", writes: ["stop_retries", "vault_flags"], why: "the queued range is replayed (the model finds nothing)",
        prep: t => {
          const tp = transcript(t);
          child(t, ["hook", "decision-extractor"], { session_id: "sess-plain", transcript_path: tp, hook_event_name: "Stop", cwd: t.dir });
          const w = new Database(t.vault);
          w.exec(`UPDATE stop_retries SET next_retry_at = '2000-01-01T00:00:00.000Z'`);   // due now
          w.close();
        } },
    ];
    for (const c of cases) {
      test(`${c.phase} (named writes: ${c.why}): no warning, no confusion, identity kept`, () => {
        const t = makeTwinVault(mark, { lifecycle: false, ageDays: 0, observation: true });
        try {
          c.prep?.(t);
          const before = snapshot(t.vault);
          const r = worker(t, c.phase);
          expect(JSON.parse(r.out.trim().split("\n").pop()!)).toEqual({ ok: true, error: null });
          expect(refusals(r.err)).toBe(0);
          expect(identityOf(t)).toBe(expectedIdentity(t));
          expect(Object.keys(changedTables(before, snapshot(t.vault))).filter(x => !c.writes.includes(x))).toEqual([]);
          c.after?.(t);
        } finally { rmSync(t.dir, { recursive: true, force: true }); }
      }, 60_000);
    }
  });
}
