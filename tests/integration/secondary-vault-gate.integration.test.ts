/**
 * Secondary-vault surfacing gate (v0.35.0) — hook-level integration.
 *
 * The context-surfacing dual-query merged a configured secondary vault's FTS
 * results into every prompt's injected context unconditionally. v0.35.0 puts
 * that behind `retrieval.surface_secondary_vaults` / the
 * CLAWMEM_SURFACE_SECONDARY_VAULTS env override, DEFAULT OFF — automatic
 * surfacing reads only the general vault unless deliberately opted in.
 *
 * These tests drive the real `contextSurfacing(store, input)` handler:
 *
 *   1. Config contract — default false; yaml opt-in; env overrides yaml in
 *      both directions; only the literal "true" enables.
 *   2. OFF (default) with a configured AND matching secondary vault: no
 *      secondary-vault content reaches the output, and the recall mirror
 *      (context_usage in the secondary vault) stays untouched — every
 *      downstream secondary-vault path keys off the `_fromVault` tag the
 *      gated block sets, so the single gate must starve them all.
 *   3. ON: the same seed surfaces secondary-vault content, and the recall
 *      mirror writes once the parked bookkeeping job is applied (t60: the
 *      drainer's code path) — proving the gate enables, not just disables.
 *
 * Hermetic per the topic-boost suite's pattern: CLAWMEM_CONFIG_DIR points at
 * a per-test tmp dir, CLAWMEM_VAULTS registers a per-test tmp vault file,
 * dedupe/nudge are disabled, and every touched env var is saved/restored.
 * Fresh stores per invocation (the hook mutates recall state on every call).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { consumePendingSurfacingBookkeeping, applySurfacingBookkeeping } from "../../src/hooks/surfacing-bookkeeping.ts";
import { createTestStore } from "../helpers/test-store.ts";
import {
  createStore,
  insertDocument,
  type Store,
} from "../../src/store.ts";
import { clearConfigCache, surfaceSecondaryVaults } from "../../src/config.ts";

import { seedContent } from "../helpers/seed-content.ts";
let TMP_ROOT: string;
let ORIG_CONFIG_DIR: string | undefined;
let ORIG_VAULTS: string | undefined;
let ORIG_SURFACE: string | undefined;
let ORIG_SESSION_FOCUS: string | undefined;
let ORIG_DEDUP_WINDOW: string | undefined;
let ORIG_NUDGE: string | undefined;

beforeEach(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), "clawmem-sv-gate-"));
  ORIG_CONFIG_DIR = process.env.CLAWMEM_CONFIG_DIR;
  process.env.CLAWMEM_CONFIG_DIR = TMP_ROOT;
  ORIG_VAULTS = process.env.CLAWMEM_VAULTS;
  delete process.env.CLAWMEM_VAULTS;
  ORIG_SURFACE = process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS;
  delete process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS;
  ORIG_SESSION_FOCUS = process.env.CLAWMEM_SESSION_FOCUS;
  delete process.env.CLAWMEM_SESSION_FOCUS;
  ORIG_DEDUP_WINDOW = process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
  process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  ORIG_NUDGE = process.env.CLAWMEM_NUDGE_INTERVAL;
  process.env.CLAWMEM_NUDGE_INTERVAL = "0";
  clearConfigCache();
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.CLAWMEM_CONFIG_DIR;
  else process.env.CLAWMEM_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_VAULTS === undefined) delete process.env.CLAWMEM_VAULTS;
  else process.env.CLAWMEM_VAULTS = ORIG_VAULTS;
  if (ORIG_SURFACE === undefined) delete process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS;
  else process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = ORIG_SURFACE;
  if (ORIG_SESSION_FOCUS === undefined) delete process.env.CLAWMEM_SESSION_FOCUS;
  else process.env.CLAWMEM_SESSION_FOCUS = ORIG_SESSION_FOCUS;
  if (ORIG_DEDUP_WINDOW === undefined) delete process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC;
  else process.env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = ORIG_DEDUP_WINDOW;
  if (ORIG_NUDGE === undefined) delete process.env.CLAWMEM_NUDGE_INTERVAL;
  else process.env.CLAWMEM_NUDGE_INTERVAL = ORIG_NUDGE;
  clearConfigCache();
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// Fixed timestamp so seeded stores are deterministic in every
// score-affecting field (recency derives from modified_at).
const SEED_TS = "2026-01-01T00:00:00.000Z";

function seedDoc(store: Store, path: string, title: string, body: string): void {
  const hash = `hash_${path}`;
  seedContent(store.db, hash, body, SEED_TS);
  insertDocument(store.db, "test", path, title, hash, SEED_TS, SEED_TS);
  store.db
    .prepare(
      `UPDATE documents SET content_type = 'decision', confidence = 0.9, quality_score = 0.8
       WHERE collection = 'test' AND path = ? AND active = 1`,
    )
    .run(path);
}

// A secondary-vault doc whose title/body match the test prompt, carrying a
// marker no general-vault doc contains — its presence in the hook output is
// the leak signal.
const MARKER = "SECONDARYVAULTMARKER";

/** Register a fresh secondary vault under the name "skill", seed it, return its path. */
function seedSecondaryVault(fileName: string): string {
  const vaultPath = join(TMP_ROOT, fileName);
  process.env.CLAWMEM_VAULTS = JSON.stringify({ skill: vaultPath });
  clearConfigCache();
  const vaultStore = createStore(vaultPath);
  seedDoc(
    vaultStore,
    "obs.md",
    `${MARKER} authentication pipeline observation`,
    `${MARKER} authentication pipeline design notes from the secondary vault`,
  );
  vaultStore.db.close();
  return vaultPath;
}

function countVaultUsageRows(vaultPath: string): number {
  const s = createStore(vaultPath);
  const n = (s.db.prepare("SELECT COUNT(*) n FROM context_usage").get() as { n: number }).n;
  s.db.close();
  return n;
}

function additionalContext(output: unknown): string {
  return (
    (output as { hookSpecificOutput?: { additionalContext?: string } })
      ?.hookSpecificOutput?.additionalContext ?? ""
  );
}

const PROMPT = "authentication pipeline design";

describe("secondary-vault surfacing gate — config contract", () => {
  it("defaults OFF; yaml opts in; env overrides yaml in both directions; only literal 'true' enables", () => {
    // Default: no yaml, no env
    expect(surfaceSecondaryVaults()).toBe(false);

    // yaml true → on
    writeFileSync(
      join(TMP_ROOT, "config.yaml"),
      "retrieval:\n  surface_secondary_vaults: true\n",
    );
    clearConfigCache();
    expect(surfaceSecondaryVaults()).toBe(true);

    // env "false" beats yaml true
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
    clearConfigCache();
    expect(surfaceSecondaryVaults()).toBe(false);

    // env "true" beats yaml FALSE — precedence proven in both directions
    writeFileSync(
      join(TMP_ROOT, "config.yaml"),
      "retrieval:\n  surface_secondary_vaults: false\n",
    );
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "true";
    clearConfigCache();
    expect(surfaceSecondaryVaults()).toBe(true);

    // Config is process-cached: an env change WITHOUT clearConfigCache keeps
    // serving the cached value; clearing adopts the new one.
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "false";
    expect(surfaceSecondaryVaults()).toBe(true); // stale by design
    clearConfigCache();
    expect(surfaceSecondaryVaults()).toBe(false); // adopted after clear

    // Only the literal "true" enables via env
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "1";
    clearConfigCache();
    expect(surfaceSecondaryVaults()).toBe(false);

    // yaml non-boolean truthy does not enable
    writeFileSync(
      join(TMP_ROOT, "config.yaml"),
      'retrieval:\n  surface_secondary_vaults: "yes"\n',
    );
    delete process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS;
    clearConfigCache();
    expect(surfaceSecondaryVaults()).toBe(false);
  });
});

/**
 * t60 (codex F59-1): the handler no longer writes the recall mirror inline —
 * it parks a bookkeeping job for the off-process drainer. Applying the parked
 * job here is the drainer's exact code path, so the mirror assertions below
 * still exercise the production writes (and the OFF case proves the gate
 * starves the job of any secondary-vault group even when the job IS applied).
 */
function drainBookkeeping(general: Store): void {
  const job = consumePendingSurfacingBookkeeping();
  if (job) applySurfacingBookkeeping(general, job);
}

describe("secondary-vault surfacing gate — hook-level", () => {
  it("OFF (default): a configured, matching secondary vault reaches neither the output nor the recall mirror", async () => {
    const vaultPath = seedSecondaryVault("vault-off.sqlite");

    const general = createTestStore();
    seedDoc(general, "auth.md", "Authentication pipeline", "authentication pipeline design and login flow");

    const out = await contextSurfacing(general, {
      prompt: PROMPT,
      sessionId: "sess-gate-off",
    } as any);
    drainBookkeeping(general); // t60: mirror writes land via the off-process drainer — apply them here
    const ctx = additionalContext(out);

    // The hook itself worked — general-vault content surfaced…
    expect(ctx).toContain("auth.md");
    // …but nothing from the secondary vault leaked into the output…
    expect(ctx).not.toContain(MARKER);
    // …and the recall mirror never touched the secondary vault (downstream
    // paths starved by the single gate).
    expect(countVaultUsageRows(vaultPath)).toBe(0);
  });

  it("ON (env opt-in): the same seed surfaces secondary-vault content and the recall mirror writes", async () => {
    const vaultPath = seedSecondaryVault("vault-on.sqlite");
    process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS = "true";
    clearConfigCache();

    const general = createTestStore();
    seedDoc(general, "auth.md", "Authentication pipeline", "authentication pipeline design and login flow");

    const out = await contextSurfacing(general, {
      prompt: PROMPT,
      sessionId: "sess-gate-on",
    } as any);
    drainBookkeeping(general); // t60: mirror writes land via the off-process drainer — apply them here
    const ctx = additionalContext(out);

    // Both vaults surface: the gate enables — it is not a permanent off switch.
    expect(ctx).toContain("auth.md");
    expect(ctx).toContain(MARKER);
    // The recall mirror wrote a context_usage row into the secondary vault.
    expect(countVaultUsageRows(vaultPath)).toBeGreaterThanOrEqual(1);
  });
});
