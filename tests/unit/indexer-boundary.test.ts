/**
 * §55.6 indexer-boundary regressions — the three LIVE defects the design gate surfaced.
 *
 * Every case here is written so that REINTRODUCING the bug makes it fail; several of them
 * failed against the code as shipped in v0.30.0. All three were found by observing the
 * database, not by reading call sites — which is the same discipline that caught T0's FK
 * cascade — so the assertions are on rows, never on the shape of the source.
 *
 *   D9  (#338)  a routine reindex silently undid `memory_forget` and lifecycle archival
 *   D7  (#339)  `reindex --force` blanket-deactivated every row, orphaning `_clawmem`
 *   D5  (#339)  nothing may reconcile `_clawmem` against a filesystem root
 *   D8.2(#340)  a failed enrichment wrote an EMPTY note over a learned one
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "fs";
import { createStore, type Store } from "../../src/store.ts";
import { indexCollection, hashContent } from "../../src/indexer.ts";
import { storeMemoryNote } from "../../src/amem.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { startServer } from "../../src/server.ts";

// The REST server needs a token on every request and a JSON Content-Type on every POST (BACKLOG 62.4).
const REST_TOKEN = "rest-test-token-62-4-0000000000000000000000";
const AUTH = { Authorization: `Bearer ${REST_TOKEN}` };
import { updateProfile } from "../../src/profile.ts";
import { runConsolidationTick } from "../../src/consolidation.ts";
import { buildMcpServer } from "../../src/mcp.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const ROOT = "/tmp/clawmem-indexer-boundary-test";
const CONTENT = `${ROOT}/content`;
const DB = `${ROOT}/vault.sqlite`;

/** Enrichment is unavailable in every case below — the E7 condition, and the realistic one. */
const deadLlm = {
  embed: async () => { throw new Error("no embedding endpoint in test"); },
  query: async () => null,
  expandQuery: async () => [],
} as any;

let store: Store;

function writeDoc(name: string, body: string): void {
  writeFileSync(`${CONTENT}/${name}`, body);
}

const reindex = () => indexCollection(store, "docs", CONTENT, "**/*.md");

const rowOf = (path: string) =>
  store.db.prepare("SELECT id, active, archived_at, deactivated_reason FROM documents WHERE collection = 'docs' AND path = ?")
    .get(path) as { id: number; active: number; archived_at: string | null; deactivated_reason: string | null } | undefined;

function seedDbOnlyMemory(path: string): void {
  const body = `# ${path}\n\nDatabase-created memory with no file behind it.\n`;
  const hash = hashContent(body + path);
  const now = new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument("_clawmem", path, path, hash, now, now);
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(CONTENT, { recursive: true });
  setDefaultLlamaCpp(deadLlm);
  store = createStore(DB);
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// D9 (#338) — deactivation provenance
// ---------------------------------------------------------------------------

describe("D9: a reindex must not undo forget or archival", () => {
  it("keeps forgotten and archived rows inactive while an absent row still returns", async () => {
    writeDoc("forgotten.md", "# F\n\nthe user forgot this\n");
    writeDoc("archived.md", "# A\n\nlifecycle archived this\n");
    writeDoc("absent.md", "# C\n\nthis one merely went missing\n");
    await reindex();

    // Three different owners write active=0. Only the third is the indexer's own.
    store.deactivateDocument("docs", "forgotten.md", "forget");
    store.archiveDocuments([rowOf("archived.md")!.id]);
    unlinkSync(`${CONTENT}/absent.md`);
    await reindex();
    expect(rowOf("absent.md")!.deactivated_reason).toBe("absent");

    // Everything is back on disk. ONE real reconciliation pass over all three.
    writeDoc("absent.md", "# C\n\nthis one merely went missing\n");
    await reindex();

    // The control matters: a mutant that simply refuses every reactivation would pass the
    // first two assertions and fail this one.
    expect(rowOf("absent.md")!.active).toBe(1);
    expect(rowOf("absent.md")!.deactivated_reason).toBeNull();
    expect(rowOf("forgotten.md")!.active).toBe(0);
    expect(rowOf("archived.md")!.active).toBe(0);
  });

  it("does not resurrect a forgotten document as a SECOND row at the same path", async () => {
    writeDoc("keep.md", "# K\n\nbody\n");
    await reindex();
    store.deactivateDocument("docs", "keep.md", "forget");
    await reindex();

    // Skipping the file is load-bearing. Falling through to the insert branch would leave the
    // row forgotten while making its content live again under a new id — the same bug in a
    // different shape, and invisible to an `active = 0` assertion on the original row.
    const rows = store.db.prepare("SELECT id, active FROM documents WHERE collection = 'docs' AND path = 'keep.md'")
      .all() as { id: number; active: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.active).toBe(0);
  });

  it("REST forget records 'forget' through the real route, and it survives a reindex", async () => {
    // Driven through `startServer`'s dispatcher, not the store helper: a registration that
    // became unreachable, or returned before mutating, would pass a helper-level test.
    writeDoc("rest.md", "# R\n\nbody\n");
    await reindex();
    const docid = (store.db.prepare("SELECT substr(hash,1,8) AS d FROM documents WHERE path = 'rest.md'")
      .get() as { d: string }).d;

    const server = startServer(store, 7439 + (process.pid % 200), "127.0.0.1", { token: REST_TOKEN });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/documents/${docid}/forget`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" } });
      expect(res.status).toBe(200);
      expect((await res.json() as { forgotten: boolean }).forgotten).toBe(true);
    } finally {
      server.stop(true);
    }

    expect(rowOf("rest.md")!.deactivated_reason).toBe("forget");
    await reindex();                       // the file is still on disk
    expect(rowOf("rest.md")!.active).toBe(0);
  });

  it("MCP memory_forget records 'forget' through the real tool, and it survives a reindex", async () => {
    // Driven over the in-memory transport against the registered handler — the same reason as
    // the REST case: a registration that stopped mutating would pass any helper-level test.
    writeDoc("zanzibarprotocol.md", "# Zanzibarprotocol\n\nthe zanzibarprotocol handshake ordering reference\n");
    await reindex();

    const prevIndexPath = process.env.INDEX_PATH;
    process.env.INDEX_PATH = DB;
    const built = buildMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await built.server.connect(serverTransport);
    const client = new Client({ name: "boundary-forget", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      // Target by exact path: a fuzzy query hits the v0.23.0 weak-match guard and returns a
      // disambiguation list WITHOUT mutating — which a loose assertion would happily accept.
      const res = await client.callTool({
        name: "memory_forget",
        arguments: { query: "docs/zanzibarprotocol.md", confirm: true },
      }) as { content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
      // Assert the tool actually FORGOT, not merely that it mentioned the path.
      expect(res.structuredContent?.action).toBe("deactivated");
    } finally {
      await client.close();
      built.closeAllStores();
      if (prevIndexPath === undefined) delete process.env.INDEX_PATH; else process.env.INDEX_PATH = prevIndexPath;
    }

    // Re-open: the MCP server had its own handle on the same file.
    store.close();
    store = createStore(DB);
    expect(rowOf("zanzibarprotocol.md")!.deactivated_reason).toBe("forget");
    await reindex();                       // the file is still on disk
    expect(rowOf("zanzibarprotocol.md")!.active).toBe(0);
  }, 60_000);

  it("updateProfile refuses to rebuild a forgotten profile, through its production path", () => {
    // The generic helper is tested elsewhere; this drives updateProfile itself, so deleting
    // its early return fails here.
    updateProfile(store);
    const before = store.db.prepare("SELECT id, active FROM documents WHERE collection = '_clawmem' AND path = 'profile.md'")
      .get() as { id: number; active: number } | undefined;
    expect(before?.active).toBe(1);

    store.deactivateDocument("_clawmem", "profile.md", "forget");
    // The outcome must distinguish WHY, because the remedies differ and one of them does not
    // exist: lifecycle_restore only reverses archival, so a forgotten row has no restore path.
    expect(updateProfile(store)).toBe("held-forget");
    const after = store.db.prepare("SELECT active FROM documents WHERE collection = '_clawmem' AND path = 'profile.md'")
      .get() as { active: number };
    expect(after.active).toBe(0);

    store.db.prepare("UPDATE documents SET deactivated_reason = 'archive', archived_at = ? WHERE collection = '_clawmem' AND path = 'profile.md'")
      .run("2026-01-01T00:00:00Z");
    expect(updateProfile(store)).toBe("held-archive");

    // An ordinary rebuild still works once the row is not lifecycle-held.
    store.db.prepare("UPDATE documents SET deactivated_reason = 'absent', archived_at = NULL WHERE collection = '_clawmem' AND path = 'profile.md'").run();
    expect(updateProfile(store)).toBe("rebuilt");
  });

  it("the profile CLI reports the refusal truthfully and prescribes nothing unavailable", async () => {
    // Drives the real command, so restoring an unconditional success message fails here.
    const cfgDir = `${ROOT}/profile-config`;
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(`${cfgDir}/config.yaml`, `collections:\n  docs:\n    path: ${CONTENT}\n    pattern: "**/*.md"\n`);
    updateProfile(store);
    store.deactivateDocument("_clawmem", "profile.md", "forget");
    store.close();

    const env = { ...process.env, CLAWMEM_CONFIG_DIR: cfgDir, INDEX_PATH: DB, CLAWMEM_NO_LOCAL_MODELS: "true", NO_COLOR: "1" };
    const held = Bun.spawnSync(["./bin/clawmem", "profile", "rebuild"], { env });
    const heldOut = held.stdout.toString() + held.stderr.toString();
    expect(heldOut).toContain("Profile not rebuilt");
    expect(heldOut).toContain("forgotten");
    // lifecycle_restore cannot reverse a forget — advising it would be a false remedy.
    expect(heldOut).not.toContain("lifecycle_restore");

    // held-archive renders the OTHER remedy — and that one is real, so it must be offered.
    store = createStore(DB);
    store.db.prepare("UPDATE documents SET deactivated_reason = 'archive', archived_at = ? WHERE collection = '_clawmem' AND path = 'profile.md'")
      .run("2026-01-01T00:00:00Z");
    store.close();
    const archived = Bun.spawnSync(["./bin/clawmem", "profile", "rebuild"], { env });
    const archivedOut = archived.stdout.toString() + archived.stderr.toString();
    expect(archivedOut).toContain("archived");
    expect(archivedOut).toContain("lifecycle_restore");

    store = createStore(DB);
    store.db.prepare("UPDATE documents SET deactivated_reason = 'absent', archived_at = NULL WHERE collection = '_clawmem' AND path = 'profile.md'").run();
    store.close();
    const ok = Bun.spawnSync(["./bin/clawmem", "profile", "rebuild"], { env });
    expect(ok.stdout.toString() + ok.stderr.toString()).toContain("Profile rebuilt");
    store = createStore(DB);
  }, 120_000);

  it("clawmem update's automatic rebuild reports the refusal too", async () => {
    // The auto-rebuild caller is a SECOND renderer; the `profile rebuild` test does not cover it,
    // so restoring its unconditional success message would otherwise pass.
    const cfgDir = `${ROOT}/update-config`;
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(`${cfgDir}/config.yaml`, `collections:\n  docs:\n    path: ${CONTENT}\n    pattern: "**/*.md"\n`);
    writeDoc("u.md", "# U\n\nbody\n");
    await reindex();
    updateProfile(store);
    store.deactivateDocument("_clawmem", "profile.md", "forget");
    store.close();

    const proc = Bun.spawnSync(["./bin/clawmem", "update"], {
      env: { ...process.env, CLAWMEM_CONFIG_DIR: cfgDir, INDEX_PATH: DB, CLAWMEM_NO_LOCAL_MODELS: "true", NO_COLOR: "1" },
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("Profile not rebuilt");
    expect(out).not.toContain("Profile auto-rebuilt");

    store = createStore(DB);
    expect(rowOf("u.md")!.active).toBe(1);   // the refusal must not derail the index pass
  }, 120_000);

  it("reports 'failed' when the profile row cannot be written", () => {
    // Without this, reverting the insert-path catch to a success value passes the suite —
    // the outcome would silently go back to meaning "I tried".
    const stub = {
      ...store,
      db: store.db,
      findActiveDocument: () => null,
      findAnyDocument: () => null,
      insertContent: () => {},
      insertDocument: () => { throw new Error("collection missing"); },
    } as unknown as Store;
    expect(updateProfile(stub)).toBe("failed");
  });

  it("backfills legacy archived rows and clears provenance on lifecycle restore", () => {
    const body = "# L\n\nbody\n";
    const hash = hashContent(body);
    const now = new Date().toISOString();
    store.insertContent(hash, body, now);
    store.insertDocument("docs", "legacy.md", "Legacy", hash, now, now);
    // A row archived by a PRE-migration version: inactive, archived_at set, no provenance.
    store.db.prepare("UPDATE documents SET active = 0, archived_at = ?, deactivated_reason = NULL WHERE collection = 'docs' AND path = 'legacy.md'")
      .run("2026-01-01T00:00:00Z");
    store.close();

    store = createStore(DB);
    expect(rowOf("legacy.md")!.deactivated_reason).toBe("archive"); // backfilled, so the indexer won't revive it

    expect(store.restoreArchivedDocuments({ collection: "docs" })).toBe(1);
    const restored = rowOf("legacy.md")!;
    expect(restored.active).toBe(1);
    expect(restored.archived_at).toBeNull();
    // Stale provenance on a live row would make the NEXT absence look like a lifecycle decision.
    expect(restored.deactivated_reason).toBeNull();
  });

  it("repairs rows a previous version reactivated while still marked archived", () => {
    const body = "# Repaired\n\nbody\n";
    const hash = hashContent(body);
    const now = new Date().toISOString();
    store.insertContent(hash, body, now);
    store.insertDocument("docs", "repair.md", "Repaired", hash, now, now);
    // The exact inconsistent state released versions could produce: active AND archived.
    store.db.prepare("UPDATE documents SET active = 1, archived_at = ? WHERE collection = 'docs' AND path = 'repair.md'")
      .run("2026-01-01T00:00:00Z");
    store.close();

    store = createStore(DB); // migrations run on open
    const row = rowOf("repair.md")!;
    expect(row.active).toBe(0);
    expect(row.deactivated_reason).toBe("archive");
  });
});

// ---------------------------------------------------------------------------
// D5 / D7 (#339) — reserved collection, and --force without mass deactivation
// ---------------------------------------------------------------------------

describe("D5/D7: _clawmem is unreachable, and --force deactivates nothing", () => {
  it("refuses to reconcile _clawmem against any root", async () => {
    seedDbOnlyMemory("observations/o1.md");
    await expect(indexCollection(store, "_clawmem", CONTENT, "**/*.md")).rejects.toThrow(/no filesystem source/);
    expect(
      (store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection = '_clawmem' AND active = 1")
        .get() as { n: number }).n,
    ).toBe(1);
  });

  it("force re-reads every file without deactivating anything", async () => {
    writeDoc("a.md", "# A\n\nbody a\n");
    writeDoc("b.md", "# B\n\nbody b\n");
    await reindex();
    seedDbOnlyMemory("handoffs/h1.md");

    // Nothing changed on disk: without force every file short-circuits on content_hash.
    const plain = await indexCollection(store, "docs", CONTENT, "**/*.md");
    expect(plain.unchanged).toBe(2);
    expect(plain.updated).toBe(0);

    const forced = await indexCollection(store, "docs", CONTENT, "**/*.md", { force: true });
    expect(forced.unchanged).toBe(0);
    expect(forced.updated).toBe(2);   // re-read and rewritten, not skipped
    expect(forced.removed).toBe(0);   // and NOT deactivated

    // The blanket `UPDATE documents SET active = 0` used to catch this row, which has no
    // filesystem source and so was never reconstructed — and no archived_at, so
    // restoreArchivedDocuments could not see it either.
    const dbOnly = store.db.prepare("SELECT active, archived_at FROM documents WHERE collection = '_clawmem'")
      .get() as { active: number; archived_at: string | null };
    expect(dbOnly.active).toBe(1);
    expect(store.restoreArchivedDocuments({ collection: "_clawmem" })).toBe(0); // nothing to restore: nothing was lost
    expect(rowOf("a.md")!.active).toBe(1);
    expect(rowOf("b.md")!.active).toBe(1);
  });

  it("force still deactivates files that are genuinely gone", async () => {
    // Removing the blanket UPDATE must not also remove real absence handling. Every other
    // force fixture keeps all files present, so without this case a `--force` that silently
    // stopped reconciling absence would pass the suite.
    writeDoc("stays.md", "# S\n\nbody\n");
    writeDoc("goes.md", "# G\n\nbody\n");
    await reindex();
    unlinkSync(`${CONTENT}/goes.md`);

    const forced = await indexCollection(store, "docs", CONTENT, "**/*.md", { force: true });
    expect(forced.removed).toBe(1);
    expect(rowOf("goes.md")!.active).toBe(0);
    expect(rowOf("goes.md")!.deactivated_reason).toBe("absent");
    expect(rowOf("stays.md")!.active).toBe(1);
  });
});

describe("D7 through the real CLI — the blanket deactivation is gone", () => {
  it("clawmem reindex --force leaves _clawmem and every configured row active", async () => {
    // The unit case above pins indexCollection's behaviour, but the defect lived in
    // cmdReindex, OUTSIDE the reconciler — so only a real dispatch can catch its return.
    const cfgDir = `${ROOT}/config`;
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      `${cfgDir}/config.yaml`,
      `collections:\n  docs:\n    path: ${CONTENT}\n    pattern: "**/*.md"\n`,
    );
    writeDoc("cli.md", "# CLI\n\nbody\n");
    await reindex();
    seedDbOnlyMemory("observations/cli-obs.md");
    store.close();

    const proc = Bun.spawnSync(["./bin/clawmem", "reindex", "--force"], {
      env: {
        ...process.env,
        CLAWMEM_CONFIG_DIR: cfgDir,
        INDEX_PATH: DB,
        CLAWMEM_NO_LOCAL_MODELS: "true",
        NO_COLOR: "1",
      },
    });
    const output = proc.stdout.toString() + proc.stderr.toString();
    expect(proc.exitCode, `clawmem reindex --force failed:\n${output}`).toBe(0);

    store = createStore(DB);
    const dbOnly = store.db.prepare("SELECT active, archived_at FROM documents WHERE collection = '_clawmem'")
      .get() as { active: number; archived_at: string | null };
    expect(dbOnly.active).toBe(1);          // was 0 — orphaned, with archived_at NULL
    expect(dbOnly.archived_at).toBeNull();
    expect(rowOf("cli.md")!.active).toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// D8.2 (#340) — an empty note never overwrites, and never masks a failure
// ---------------------------------------------------------------------------

describe("D8.2: enrichment failure must not write an empty note", () => {
  it("leaves a learned note intact when enrichment produces nothing", async () => {
    writeDoc("learned.md", "# L\n\noriginal body\n");
    await reindex();
    const id = rowOf("learned.md")!.id;
    store.db.prepare("UPDATE documents SET amem_keywords = ?, amem_tags = ?, amem_context = ? WHERE id = ?")
      .run(JSON.stringify(["LEARNED"]), JSON.stringify(["EVOLVED"]), "LEARNED-CONTEXT", id);

    // Deactivate by absence, then restore an IDENTICAL body — a source-equivalent round trip
    // that used to blank all three fields to []/[]/"" because inference was unavailable.
    unlinkSync(`${CONTENT}/learned.md`);
    await reindex();
    writeDoc("learned.md", "# L\n\noriginal body\n");
    await reindex();

    const amem = store.db.prepare("SELECT amem_keywords, amem_tags, amem_context FROM documents WHERE id = ?")
      .get(id) as { amem_keywords: string; amem_tags: string; amem_context: string };
    expect(JSON.parse(amem.amem_keywords)).toEqual(["LEARNED"]);
    expect(JSON.parse(amem.amem_tags)).toEqual(["EVOLVED"]);
    expect(amem.amem_context).toBe("LEARNED-CONTEXT");
  });

  it("leaves a never-enriched row NULL and reports that nothing landed", async () => {
    writeDoc("fresh.md", "# N\n\nbody\n");
    await reindex();
    const id = rowOf("fresh.md")!.id;

    // NULL is the retryable "not enriched yet" state that backfill keys on. Writing
    // []/[]/"" over it makes a FAILURE indistinguishable from completed enrichment, so the
    // document is never retried — a quieter version of the same defect.
    const landed = storeMemoryNote(store, id, { keywords: [], tags: [], context: "" } as any);
    expect(landed).toBe(false);

    const amem = store.db.prepare("SELECT amem_keywords, amem_tags, amem_context FROM documents WHERE id = ?")
      .get(id) as { amem_keywords: string | null; amem_tags: string | null; amem_context: string | null };
    expect(amem.amem_keywords).toBeNull();
    expect(amem.amem_tags).toBeNull();
    expect(amem.amem_context).toBeNull();

    // A note carrying real information still lands, and says so.
    expect(storeMemoryNote(store, id, { keywords: ["real"], tags: [], context: "" } as any)).toBe(true);
    expect(
      JSON.parse((store.db.prepare("SELECT amem_keywords FROM documents WHERE id = ?").get(id) as { amem_keywords: string }).amem_keywords),
    ).toEqual(["real"]);
  });

  it("refuses a whitespace-only note, which carries no information either", async () => {
    writeDoc("blank.md", "# B\n\nbody\n");
    await reindex();
    const id = rowOf("blank.md")!.id;

    // The parser preserves whitespace-only strings inside the arrays, so a note that is
    // "non-empty" by length alone would still mask the row from backfill forever.
    expect(storeMemoryNote(store, id, { keywords: [" "], tags: ["\t"], context: "  " } as any)).toBe(false);
    expect(
      (store.db.prepare("SELECT amem_keywords FROM documents WHERE id = ?").get(id) as { amem_keywords: string | null }).amem_keywords,
    ).toBeNull();

    // One real entry among blanks is information and is kept.
    expect(storeMemoryNote(store, id, { keywords: [" ", "actual"], tags: [], context: "" } as any)).toBe(true);
  });

  it("reports false when the target row does not exist", async () => {
    // The outcome must reflect what the database did, not merely that the note looked usable —
    // an unconditional `return true` would let a caller log success against a missing row.
    expect(storeMemoryNote(store, 999_999, { keywords: ["real"], tags: [], context: "" } as any)).toBe(false);
  });

  it("postIndexEnrich does not claim a completed refresh after a refused write", async () => {
    // The implementation is conditional, but only an assertion on the OUTPUT stops the false
    // "Completed note refresh" line from coming back.
    writeDoc("msg.md", "# M\n\nbody\n");
    await reindex();
    const id = rowOf("msg.md")!.id;

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      // isNew=false is the updated-document branch, where the false message lived.
      await store.postIndexEnrich(deadLlm, id, false);
    } finally {
      console.log = realLog;
    }

    expect(logged.some(l => /No note stored/.test(l))).toBe(true);
    expect(logged.some(l => /made no change/.test(l))).toBe(true);
    expect(logged.some(l => /Completed note refresh/.test(l))).toBe(false);
  }, 60_000);

  it("consolidation backfill skips the link pass and leaves the row retryable", async () => {
    // Production path, not the helper: a mutant that drops the `continue` in backfillAmem would
    // still generate links against a document whose note was refused, and would log it as
    // enriched — leaving amem_* NULL while claiming the work was done.
    writeDoc("backfill.md", "# B\n\nbody\n");
    await reindex();
    const id = rowOf("backfill.md")!.id;
    expect(
      (store.db.prepare("SELECT amem_keywords FROM documents WHERE id = ?").get(id) as { amem_keywords: string | null }).amem_keywords,
    ).toBeNull();

    let linkCalls = 0;
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    // The store's own note constructor is stubbed to the empty note the real one fails open to.
    const stubbed = {
      ...store,
      db: store.db,
      constructMemoryNote: async () => ({ keywords: [], tags: [], context: "" }),
      storeMemoryNote: (docId: number, note: any) => storeMemoryNote(store, docId, note),
      generateMemoryLinks: async () => { linkCalls++; return 0; },
    } as unknown as Store;

    try {
      await runConsolidationTick(stubbed, deadLlm, { workerName: `boundary-test-${process.pid}` });
    } finally {
      console.log = realLog;
    }

    expect(linkCalls).toBe(0);                                    // link pass skipped
    expect(
      (store.db.prepare("SELECT amem_keywords FROM documents WHERE id = ?").get(id) as { amem_keywords: string | null }).amem_keywords,
    ).toBeNull();                                                 // still eligible for backfill
    expect(logged.some(l => /Enriched doc/.test(l))).toBe(false); // and not reported as enriched
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Issue #24 (codex turn-2 findings 1–3) — note counters: outcome semantics,
// accumulation, and the public surfaces that present an index run
// ---------------------------------------------------------------------------

describe("issue-24 note counters", () => {
  /** Produces a valid, storable memory note; embedding stays dead so the later
   *  phases (entities, links) produce nothing — which must NOT change the
   *  note-write metric. */
  const okLlm = {
    embed: async () => { throw new Error("no embedding endpoint in test"); },
    generate: async () => ({ text: '{"keywords":["kw1"],"tags":["t1"],"context":"ctx"}', model: "test-ok", done: true }),
    expandQuery: async () => [],
  } as any;

  afterEach(() => {
    delete process.env.CLAWMEM_ENABLE_AMEM;
    delete process.env.CLAWMEM_CONFIG_DIR;
    delete process.env.CLAWMEM_VAULTS;
  });

  it("postIndexEnrich outcome taxonomy: disabled / empty / stored", async () => {
    writeDoc("m.md", "# M\n\nbody\n");
    await reindex();
    const id = rowOf("m.md")!.id;

    process.env.CLAWMEM_ENABLE_AMEM = "false";
    expect(await store.postIndexEnrich(deadLlm, id, false)).toBe("disabled");
    delete process.env.CLAWMEM_ENABLE_AMEM;

    // The LLM produces nothing usable → the note write is refused → "empty".
    expect(await store.postIndexEnrich(deadLlm, id, false)).toBe("empty");

    // A stored note reports "stored" even though the later phases (entities,
    // links) produce nothing with this stub — the metric is the note write,
    // not whole-pipeline success (codex turn-2 finding 1).
    expect(await store.postIndexEnrich(okLlm, id, true)).toBe("stored");
    const kw = (store.db.prepare("SELECT amem_keywords FROM documents WHERE id = ?").get(id) as { amem_keywords: string | null }).amem_keywords;
    expect(kw ?? "").toContain("kw1");
  }, 60_000);

  it("indexCollection accumulates enrichAttempted/enrichStored, keyed on the note write", async () => {
    writeDoc("a.md", "# A\n\nalpha\n");
    writeDoc("b.md", "# B\n\nbeta\n");
    const dead = await reindex();                 // deadLlm from beforeEach
    expect(dead.enrichAttempted).toBe(2);
    expect(dead.enrichStored).toBe(0);            // removing the accumulation reds this

    setDefaultLlamaCpp(okLlm);
    writeDoc("c.md", "# C\n\ngamma\n");
    const ok = await reindex();                   // only the NEW doc enqueues enrichment
    expect(ok.enrichAttempted).toBe(1);
    expect(ok.enrichStored).toBe(1);
  }, 60_000);

  it("CLAWMEM_ENABLE_AMEM=false is excluded from the counters entirely", async () => {
    process.env.CLAWMEM_ENABLE_AMEM = "false";
    writeDoc("d.md", "# D\n\ndelta\n");
    const stats = await reindex();
    expect(stats.enrichAttempted).toBe(0);
    expect(stats.enrichStored).toBe(0);
  }, 60_000);

  it("REST /reindex carries the note counters", async () => {
    const CONF = `${ROOT}/config`;
    mkdirSync(CONF, { recursive: true });
    writeFileSync(`${CONF}/config.yaml`, `collections:\n  docs:\n    path: ${CONTENT}\n    pattern: "**/*.md"\n`);
    process.env.CLAWMEM_CONFIG_DIR = CONF;

    writeDoc("rest-counters.md", "# R\n\nrho\n");
    const server = startServer(store, 7439 + ((process.pid + 17) % 200), "127.0.0.1", { token: REST_TOKEN });
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/reindex`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ collection: "docs" }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, number>;
      expect(body.enrichAttempted).toBe(1);       // the one new doc
      expect(body.enrichStored).toBe(0);          // dead LLM → note produced nothing
    } finally {
      server.stop(true);
    }
  }, 60_000);

  it("MCP reindex and vault_sync summaries carry the note counters", async () => {
    const CONF = `${ROOT}/config`;
    mkdirSync(CONF, { recursive: true });
    writeFileSync(`${CONF}/config.yaml`, `collections:\n  docs:\n    path: ${CONTENT}\n    pattern: "**/*.md"\n`);
    process.env.CLAWMEM_CONFIG_DIR = CONF;
    process.env.CLAWMEM_VAULTS = JSON.stringify({ testv: `${ROOT}/vault-testv.sqlite` });

    writeDoc("mcp-counters.md", "# P\n\npi\n");

    const prevIndexPath = process.env.INDEX_PATH;
    process.env.INDEX_PATH = DB;
    const built = buildMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await built.server.connect(serverTransport);
    const client = new Client({ name: "issue24-counters", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const re = await client.callTool({ name: "reindex", arguments: {} }) as { content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
      const text = re.content?.[0]?.text ?? "";
      expect(text).toContain("notes");
      expect(text).toContain("produced nothing");
      expect(re.structuredContent?.enrichAttempted).toBe(1);
      expect(re.structuredContent?.enrichStored).toBe(0);

      const vs = await client.callTool({ name: "vault_sync", arguments: { vault: "testv", content_root: CONTENT } }) as { content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
      const vsText = vs.content?.[0]?.text ?? "";
      expect(vsText).toContain("Notes:");
      expect(vsText).toContain("produced nothing");
      expect((vs.structuredContent?.enrichAttempted as number) ?? 0).toBeGreaterThanOrEqual(1);
      expect(vs.structuredContent?.enrichStored).toBe(0);
    } finally {
      await client.close();
      built.closeAllStores();
      if (prevIndexPath === undefined) delete process.env.INDEX_PATH; else process.env.INDEX_PATH = prevIndexPath;
    }
  }, 120_000);
});
