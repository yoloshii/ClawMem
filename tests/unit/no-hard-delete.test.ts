/**
 * T0 containment — ClawMem never physically deletes a document row (BACKLOG Source 55 §55.5).
 *
 * The governing rule is "no unrecoverable model-mediated mutation". Deactivation, archival
 * and forgetting are all reversible; a `DELETE FROM documents` is not. Through v0.29.0 three
 * paths reached one — an agent-invoked MCP tool, an unattended SessionStart hook, and the
 * CLI — plus two unguarded store methods with no callers.
 *
 * These tests assert the CORRECT behavior (nothing is destroyed), not the behavior that
 * shipped. They exercise real code paths rather than scraping source text for call
 * patterns: a source regex stays green if a caller uses an alias, a helper, or raw SQL.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, insertDocument, type Store } from "../../src/store.ts";
import { stalenessCheck } from "../../src/hooks/staleness-check.ts";
import { clearConfigCache } from "../../src/config.ts";

import { seedContent } from "../helpers/seed-content.ts";
let store: Store;

beforeEach(() => {
  store = createStore(":memory:");
});

/** Seed a document. `documents.hash` is a FK into `content`, so both rows are needed. */
function seed(path: string, iso: string): void {
  const hash = `h-${path}`;
  seedContent(store.db, hash, `body of ${path}`, iso);
  insertDocument(store.db, "test", path, "T", hash, iso, iso);
}

/** Seed a document already archived `daysAgo` days back. */
function seedArchived(path: string, daysAgo: number): void {
  const when = new Date();
  when.setDate(when.getDate() - daysAgo);
  const iso = when.toISOString();
  seed(path, iso);
  store.db
    .prepare("UPDATE documents SET active = 0, archived_at = ? WHERE path = ?")
    .run(iso, path);
}

const rowCount = (): number =>
  (store.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;

// ─── The destructive surface is gone ────────────────────────────────

describe("the Store exposes no row-destroying operation", () => {
  it("has no purgeArchivedDocuments", () => {
    expect((store as Record<string, unknown>).purgeArchivedDocuments).toBeUndefined();
  });

  it("has no deleteInactiveDocuments", () => {
    // Removed with purge: it deleted every `active = 0` row — archived AND forgotten —
    // with no age bound at all, so it was strictly broader than the retention purge.
    expect((store as Record<string, unknown>).deleteInactiveDocuments).toBeUndefined();
  });

  it("exports no row-destroying helper from the store module", async () => {
    const mod = await import("../../src/store.ts");
    expect((mod as Record<string, unknown>).purgeArchivedDocumentsFn).toBeUndefined();
    expect((mod as Record<string, unknown>).deleteInactiveDocuments).toBeUndefined();
    // The store-level removeCollection ran `DELETE FROM documents WHERE collection = ?`.
    // `clawmem collection remove` goes through collections.ts (YAML only) instead.
    expect((mod as Record<string, unknown>).removeCollection).toBeUndefined();
  });

  it("no zero-arg maintenance method destroys a document", () => {
    // Covers ONE shape: zero-argument methods on the Store, which is what maintenance and
    // cleanup helpers look like — the shape `cleanupOrphanedContent` had when it slipped
    // through (it deleted content still referenced by archived documents, and
    // `documents.hash` is ON DELETE CASCADE, so the archived rows went with it).
    //
    // It is defence-in-depth, NOT a package-wide guard. It cannot see a destructive helper
    // that takes arguments (both removed ones did), a module-level export not attached to
    // the Store, or raw SQL issued from MCP/REST/hook/CLI code. The invariant itself is
    // guarded at the database level in `no-hard-delete-tripwire.test.ts`, which arms a
    // BEFORE DELETE trigger and drives the real surfaces through it.
    const iso = new Date().toISOString();
    seed("active.md", iso);
    seedArchived("archived.md", 400);
    seed("forgotten.md", iso);
    store.db
      .prepare("UPDATE documents SET active = 0, archived_at = NULL WHERE path = 'forgotten.md'")
      .run();

    const before = rowCount();
    expect(before).toBe(3);

    const s = store as unknown as Record<string, unknown>;
    const zeroArg = Object.keys(s).filter(
      k => typeof s[k] === "function" && (s[k] as Function).length === 0 && k !== "close"
    );
    expect(zeroArg.length).toBeGreaterThan(5); // guard against the filter silently matching nothing

    for (const name of zeroArg) {
      try {
        (s[name] as () => unknown)();
      } catch {
        // A method may legitimately fail on a minimal fixture (missing vec tables, no
        // embeddings). That is fine — we only care that it destroyed nothing.
      }
      expect(`${name} destroyed a document: ${rowCount()} of ${before} remain`).toBe(
        `${name} destroyed a document: ${before} of ${before} remain`
      );
    }
  });

  it("cleanupOrphanedContent cannot cascade-delete an archived document", () => {
    // Regression for the FK cascade: the predicate scoped to `active = 1`, so content
    // referenced only by an archived document was deleted and took the document with it
    // (1 archived doc -> 0 docs, returning 2 because the cascade was counted).
    seedArchived("precious.md", 400);
    expect(rowCount()).toBe(1);

    const removed = store.cleanupOrphanedContent();

    expect(rowCount()).toBe(1);
    expect(removed).toBe(0); // its content IS referenced — by an archived document
  });

  it("cleanupOrphanedContent still removes genuinely unreferenced content", () => {
    // The fix must not turn the helper into a no-op: content no document references at all
    // is still collectable, and cannot cascade because nothing points at it.
    seedContent(store.db, "orphan-hash", "nothing references this", new Date().toISOString());
    const contentBefore = (
      store.db.prepare("SELECT COUNT(*) AS n FROM content").get() as { n: number }
    ).n;

    expect(store.cleanupOrphanedContent()).toBe(1);
    expect(
      (store.db.prepare("SELECT COUNT(*) AS n FROM content").get() as { n: number }).n
    ).toBe(contentBefore - 1);
  });
});

// ─── Archival stays reversible ──────────────────────────────────────

describe("retention archives rather than deletes", () => {
  it("archiveDocuments deactivates without destroying, and restore brings it back", () => {
    seed("doc.md", new Date().toISOString());
    const id = (store.db.prepare("SELECT id FROM documents").get() as { id: number }).id;

    expect(store.archiveDocuments([id])).toBe(1);
    expect(rowCount()).toBe(1); // still present, merely inactive
    expect(
      (store.db.prepare("SELECT active FROM documents").get() as { active: number }).active
    ).toBe(0);

    expect(store.restoreArchivedDocuments({ ids: [id] })).toBe(1);
    expect(
      (store.db.prepare("SELECT active FROM documents").get() as { active: number }).active
    ).toBe(1);
  });

  it("an ancient archived row survives — there is no retention window that removes it", () => {
    seedArchived("ancient.md", 4000);
    expect(rowCount()).toBe(1);
  });

  it("reports the number of DOCUMENTS affected, not the trigger side-effect total", () => {
    // Regression: both helpers returned `result.changes`, which counts the documents_fts
    // shadow-table writes fired by the UPDATE triggers. Archiving 3 documents reported 16,
    // so every "archived N" / "restored N" ClawMem printed was inflated. The mutation was
    // always correct — only the count lied.
    const iso = new Date().toISOString();
    for (const p of ["a.md", "b.md", "c.md"]) seed(p, iso);
    const ids = (store.db.prepare("SELECT id FROM documents").all() as { id: number }[])
      .map(r => r.id);

    expect(store.archiveDocuments(ids)).toBe(3);
    expect(
      (store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE active = 0")
        .get() as { n: number }).n
    ).toBe(3);

    expect(store.restoreArchivedDocuments({ ids })).toBe(3);
    expect(
      (store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE active = 1")
        .get() as { n: number }).n
    ).toBe(3);
  });

  it("counts only rows it actually changed — already-archived ids are not recounted", () => {
    const iso = new Date().toISOString();
    seed("x.md", iso);
    const id = (store.db.prepare("SELECT id FROM documents").get() as { id: number }).id;

    expect(store.archiveDocuments([id])).toBe(1);
    expect(store.archiveDocuments([id])).toBe(0); // already inactive — nothing to do
  });
});

// ─── The production hook path ───────────────────────────────────────

describe("the SessionStart staleness-check hook", () => {
  it("archives per an ACTIVE policy but destroys nothing, with purge_after_days set", async () => {
    // The real hook, invoked as the runtime invokes it. This path previously deleted
    // unattended, inside a catch that swallowed the result.
    //
    // The config is written under a temp CLAWMEM_CONFIG_DIR rather than inherited from the
    // host: with the host's default (`dry_run` true, `purge_after_days` null) the hook
    // would archive nothing, and the test would pass while exercising no lifecycle
    // mutation at all. Here the policy is deliberately live AND has purge configured, so
    // the assertion is meaningful — archival must happen, deletion must not.
    const cfgDir = mkdtempSync(join(tmpdir(), "clawmem-lifecycle-"));
    const saved = process.env.CLAWMEM_CONFIG_DIR;
    process.env.CLAWMEM_CONFIG_DIR = cfgDir;
    // loadVaultConfig() memoizes in a module-level cache, so setting the env var is not
    // enough once any earlier test in the run has loaded config — without this the hook
    // reads the host policy and archives nothing, and the test passes vacuously in
    // isolation while failing in a full-suite run.
    clearConfigCache();
    writeFileSync(
      join(cfgDir, "config.yaml"),
      [
        "collections: {}",
        "lifecycle:",
        "  archive_after_days: 1",
        "  type_overrides: {}",
        "  purge_after_days: 1",
        "  exempt_collections: []",
        "  dry_run: false",
      ].join("\n")
    );

    try {
      seed("stale.md", new Date(Date.now() - 400 * 86_400_000).toISOString());
      const before = rowCount();
      expect(before).toBe(1);

      await stalenessCheck(store, {
        sessionId: "test-session",
        hookEventName: "SessionStart",
      });

      // Nothing destroyed...
      expect(rowCount()).toBe(before);
      // ...and the lifecycle path genuinely ran, so the assertion above means something.
      expect(
        (store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE active = 0")
          .get() as { n: number }).n
      ).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.CLAWMEM_CONFIG_DIR;
      else process.env.CLAWMEM_CONFIG_DIR = saved;
      clearConfigCache(); // leave no temp policy cached for the rest of the run
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });
});

