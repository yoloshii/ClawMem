/**
 * T0 containment, DB-level — a delete leaves durable evidence, on the paths this drives.
 *
 * The sibling suite (`no-hard-delete.test.ts`) checks known method shapes, which cannot see
 * a destructive helper that takes arguments, a module-level export not attached to `Store`,
 * or raw SQL issued from MCP / REST / hook / CLI / plugin code. This suite instead installs
 * an AFTER DELETE trigger on `documents` that records every deleted row into an audit table,
 * then drives the REAL production surfaces and asserts the audit table is empty.
 *
 * It RECORDS rather than ABORTs, deliberately. An aborting trigger raises a SQLite error,
 * and `stalenessCheck` wraps its lifecycle work in a fail-open `catch {}` — so a delete
 * reintroduced in the hook would abort, be swallowed, and leave the row counts looking
 * correct. That swallowed-error shape is exactly how the original unattended purge survived
 * for months, so the guard must not depend on an exception surviving the call stack. An
 * audit row cannot be caught.
 *
 * SCOPE, stated plainly: this verifies the paths it drives — the MCP `lifecycle_sweep` tool
 * and the `stalenessCheck` hook, plus the store maintenance surface. The REST routes, the
 * CLI dispatch, and the OpenClaw/Hermes plugins are NOT exercised here and are not covered.
 * Adding a surface is a few lines; claiming coverage without driving it is not.
 *
 * Ref: BACKLOG.md Source 55 §55.5.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import * as storeModule from "../../src/store.ts";
import { createStore, insertDocument, type Store } from "../../src/store.ts";
import { stalenessCheck } from "../../src/hooks/staleness-check.ts";
import { clearConfigCache } from "../../src/config.ts";

import { seedContent } from "../helpers/seed-content.ts";
const AUDIT = "clawmem_delete_audit";
const TRIPWIRE = "clawmem_record_document_delete";

/**
 * Arm the tripwire: every deleted `documents` row — direct, cascaded from `content`, or
 * displaced by an `INSERT OR REPLACE` — lands in an audit table. Records rather than aborts,
 * so no fail-open `catch` can hide it.
 *
 * `recursive_triggers` is load-bearing and per-connection. SQLite's REPLACE conflict
 * resolution deletes the conflicting row, but fires that row's DELETE triggers ONLY when
 * this pragma is ON, and it defaults to OFF (ClawMem never sets it). Without this line an
 * `INSERT OR REPLACE INTO documents` on a driven path would destroy a row, leave the count
 * unchanged, write no audit entry, and pass the suite. Verified both ways.
 */
function armTripwire(db: { run: (sql: string) => unknown }): void {
  db.run("PRAGMA recursive_triggers = ON");
  db.run(`CREATE TABLE IF NOT EXISTS ${AUDIT} (doc_id INTEGER, path TEXT)`);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS ${TRIPWIRE}
    AFTER DELETE ON documents
    BEGIN
      INSERT INTO ${AUDIT} (doc_id, path) VALUES (old.id, old.path);
    END
  `);
}

/** Paths of any documents deleted since the tripwire was armed. Empty is the invariant. */
function deletedPaths(s: Store): string[] {
  return (s.db.prepare(`SELECT path FROM ${AUDIT} ORDER BY path`).all() as { path: string }[])
    .map(r => r.path);
}

let tmpDir: string;
let dbPath: string;
let store: Store;
let savedIndexPath: string | undefined;
let savedConfigDir: string | undefined;

/** A live lifecycle policy, so the surfaces under test actually do lifecycle work. */
function writeLivePolicy(dir: string): void {
  writeFileSync(
    join(dir, "config.yaml"),
    [
      "collections: {}",
      "lifecycle:",
      "  archive_after_days: 1",
      "  type_overrides: {}",
      "  purge_after_days: 1", // set on purpose: the surfaces must ignore it
      "  exempt_collections: []",
      "  dry_run: false",
    ].join("\n")
  );
  clearConfigCache();
}

/**
 * Seed `n` stale documents, then take one ARCHIVED and one FORGOTTEN.
 *
 * The inactive rows are load-bearing, not decoration. The cascade bug this suite exists to
 * catch only fires when content is referenced *solely* by an inactive document — with an
 * all-active fixture `cleanupOrphanedContent` finds every hash referenced, deletes nothing,
 * and the tripwire never trips. Verified: with an all-active fixture, reintroducing the bug
 * left all tests green.
 */
function seedOldDocs(s: Store, n: number): void {
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  for (let i = 0; i < n; i++) {
    const hash = `h-${i}`;
    seedContent(s.db, hash, `body ${i}`, old);
    insertDocument(s.db, "test", `doc-${i}.md`, "T", hash, old, old);
  }
  s.db.prepare("UPDATE documents SET active = 0, archived_at = ? WHERE path = 'doc-0.md'").run(old);
  s.db.prepare("UPDATE documents SET active = 0, archived_at = NULL WHERE path = 'doc-1.md'").run();
}

const docCount = (s: Store): number =>
  (s.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "clawmem-tripwire-"));
  dbPath = join(tmpDir, "index.sqlite");
  savedIndexPath = Bun.env.INDEX_PATH;
  savedConfigDir = process.env.CLAWMEM_CONFIG_DIR;
  Bun.env.INDEX_PATH = dbPath;
  process.env.CLAWMEM_CONFIG_DIR = tmpDir;
  writeLivePolicy(tmpDir);

  store = createStore(dbPath);
  seedOldDocs(store, 3);
  armTripwire(store.db);
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  if (savedIndexPath === undefined) delete Bun.env.INDEX_PATH;
  else Bun.env.INDEX_PATH = savedIndexPath;
  if (savedConfigDir === undefined) delete process.env.CLAWMEM_CONFIG_DIR;
  else process.env.CLAWMEM_CONFIG_DIR = savedConfigDir;
  clearConfigCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── The tripwire must actually fire ────────────────────────────────

describe("the tripwire itself", () => {
  it("records a direct delete — proving the guard is armed, not vacuous", () => {
    // Without this, every assertion below could pass because nothing was ever watched.
    expect(deletedPaths(store)).toEqual([]);
    store.db.prepare("DELETE FROM documents WHERE path = 'doc-2.md'").run();
    expect(deletedPaths(store)).toEqual(["doc-2.md"]);
  });

  it("records an FK cascade from content, not just a direct delete", () => {
    // This is the shape that actually shipped: content deleted, documents taken with it.
    store.db.prepare("DELETE FROM content WHERE hash = 'h-0'").run();
    expect(deletedPaths(store)).toEqual(["doc-0.md"]);
  });

  it("records a row displaced by INSERT OR REPLACE", () => {
    // REPLACE deletes the conflicting row. Its DELETE trigger fires only under
    // `recursive_triggers = ON` (default OFF), so without that pragma this destruction is
    // invisible: same row count, no audit entry, suite green.
    const iso = new Date().toISOString();
    store.db
      .prepare(
        `INSERT OR REPLACE INTO documents (collection, path, title, hash, created_at, modified_at, active)
         VALUES ('test', 'doc-2.md', 'replaced', 'h-2', ?, ?, 1)`
      )
      .run(iso, iso);
    expect(deletedPaths(store)).toEqual(["doc-2.md"]);
  });

  it("survives a swallowed exception — the failure mode that hid the original bug", () => {
    // stalenessCheck wraps lifecycle work in a fail-open `catch {}`. An ABORTing trigger
    // would raise, be swallowed there, and leave row counts intact — the regression would
    // pass. An audit row is written by the same statement that deletes, so catching the
    // error (or there being no error at all) cannot erase the evidence.
    try {
      store.db.prepare("DELETE FROM documents WHERE path = 'doc-1.md'").run();
      throw new Error("simulated downstream failure");
    } catch {
      /* swallowed exactly as the hook swallows */
    }
    expect(deletedPaths(store)).toEqual(["doc-1.md"]);
  });
});

// ─── Production surfaces, driven through the armed tripwire ─────────

describe("production surfaces destroy no document row", () => {
  it("the real MCP lifecycle_sweep tool, non-dry-run, with purge_after_days set", async () => {
    const built = buildMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await built.server.connect(serverTransport);
    const client = new Client({ name: "tripwire-tests", version: "0.0.0" });
    await client.connect(clientTransport);

    try {
      // The tripwire lives in the DB file, so the server's own store connection sees it.
      armTripwire(built.store.db);

      const res = (await client.callTool({
        name: "lifecycle_sweep",
        arguments: { dry_run: false },
      })) as { content: { type: string; text: string }[] };

      const text = res.content.map(c => c.text).join("\n");
      expect(text).toMatch(/Nothing was deleted/);
      expect(deletedPaths(built.store)).toEqual([]);
      expect(docCount(built.store)).toBe(3);
    } finally {
      try { built.closeAllStores(); } catch { /* already closed */ }
    }
  });

  it("the real SessionStart staleness-check hook", async () => {
    await stalenessCheck(store, { sessionId: "tripwire", hookEventName: "SessionStart" });
    // Audit-based, so a delete the hook's fail-open catch swallowed is still visible.
    expect(deletedPaths(store)).toEqual([]);
    expect(docCount(store)).toBe(3);
    // The lifecycle path genuinely ran, so the assertion above is not vacuous.
    expect(
      (store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE active = 0")
        .get() as { n: number }).n
    ).toBe(3);
  });

  it("every zero-arg Store method, including async ones", async () => {
    const s = store as unknown as Record<string, unknown>;
    const names = Object.keys(s).filter(
      k => typeof s[k] === "function" && (s[k] as Function).length === 0 && k !== "close"
    );
    expect(names.length).toBeGreaterThan(5);

    for (const name of names) {
      try {
        // Awaited: an async helper's delete would otherwise land after the assertion.
        await (s[name] as () => unknown)();
      } catch {
        // A method may legitimately fail on a minimal fixture; only deletion matters.
      }
    }
    expect(deletedPaths(store)).toEqual([]);
    expect(docCount(store)).toBe(3);
  });

  it("the module-level maintenance exports not attached to Store", async () => {
    // `deleteInactiveDocuments` and the store-level `removeCollection` were both module
    // exports, so this shape needs cover too. The set is named rather than swept: a blind
    // sweep of every single-argument export invokes embedding/LLM helpers that block on
    // network I/O, and a call that hangs proves nothing about whether it deletes.
    const mod = storeModule as unknown as Record<string, unknown>;
    const maintenance = ["cleanupOrphanedContent", "deleteLLMCache", "vacuumDatabase"];

    for (const name of maintenance) {
      const fn = mod[name];
      if (typeof fn !== "function") continue; // removed helpers are legitimately absent
      try {
        await (fn as (db: unknown) => unknown)(store.db);
      } catch {
        // Legitimate failure on a minimal fixture; only deletion matters.
      }
    }
    expect(deletedPaths(store)).toEqual([]);
    expect(docCount(store)).toBe(3);
  });

  it("the removed destructive exports are still absent from the module", () => {
    const mod = storeModule as unknown as Record<string, unknown>;
    expect(mod.deleteInactiveDocuments).toBeUndefined();
    expect(mod.removeCollection).toBeUndefined();
    expect(mod.purgeArchivedDocuments).toBeUndefined();
  });
});
