/**
 * s342 resolution CLI core — census scoping, manifest-bound resolution
 * (keep-weight / retire-edge), and fail-closed restore, per the rev-7 design's
 * verification plan (.codex-review/s342-causal-writer-design-2026-08-04.md §3).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, type Store } from "../../src/store.ts";
import {
  causalWitnessCensus,
  buildResolutionManifest,
  applyResolution,
  restoreRetiredEdge,
  edgeFingerprint,
  insertCausalRun,
  isConstraintConflict,
  CAUSAL_FINGERPRINT_VERSION,
} from "../../src/causal-writer.ts";
import { createHash, randomUUID } from "node:crypto";

import { seedContent } from "../helpers/seed-content.ts";
let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawmem-causal-migrate-"));
  store = createStore(join(dir, "vault.sqlite"));
});

afterEach(() => {
  try { (store as any).close?.(); } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
});

function mkDoc(path: string, opts?: { collection?: string; observationType?: string | null }): number {
  const collection = opts?.collection ?? "_clawmem";
  const hash = createHash("sha256").update(collection + path).digest("hex");
  const ts = "2026-08-01T00:00:00.000Z";
  seedContent(store.db, hash, `body of ${path}`, ts);
  (store as any).insertDocument(collection, path, path, hash, ts, ts);
  const id = (store as any).findActiveDocument(collection, path)!.id;
  if (opts?.observationType) {
    store.db.prepare(`UPDATE documents SET observation_type = ? WHERE id = ?`).run(opts.observationType, id);
  }
  return id;
}

/** Two observation-lane endpoints (the only edges the writer can own). */
function laneDocs(): [number, number] {
  return [
    mkDoc("observations/lane-a.md", { observationType: "decision" }),
    mkDoc("observations/lane-b.md", { observationType: "discovery" }),
  ];
}

function insertEdge(sourceId: number, targetId: number, opts?: {
  weight?: number | null; metadata?: string | null; createdAt?: string; contradictConfidence?: number | null;
}): void {
  store.db.prepare(
    `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at, contradict_confidence)
     VALUES (?, ?, 'causal', ?, ?, ?, ?)`,
  ).run(
    sourceId, targetId,
    opts?.weight === undefined ? 0.7 : opts.weight,
    opts?.metadata === undefined ? null : opts.metadata,
    opts?.createdAt ?? "2026-07-01T00:00:00.000Z",
    opts?.contradictConfidence ?? null,
  );
}

function insertLiveSighting(sourceId: number, targetId: number): void {
  store.db.prepare(
    `INSERT INTO causal_witness_sightings (source_id, target_id, source_fact_ordinal, target_fact_ordinal,
       source_fact, target_fact, reasoning, confidence, model_identity, prompt_version, run_key, legacy, created_at)
     VALUES (?, ?, 0, 0, 'sf', 'tf', 'r', 0.8, 'm', 'v1', ?, 0, '2026-08-01T00:00:00.000Z')`,
  ).run(sourceId, targetId, randomUUID());
}

function cliRun(): { runKey: string; runId: number } {
  const runKey = randomUUID();
  const runId = insertCausalRun(store.db, { runKey, source: "cli_migrate", mode: "cli", outcome: "cli_ok" });
  return { runKey, runId };
}

// Bun's Statement.get() returns null for no-row; normalize to undefined so
// absence assertions read uniformly.
const activeEdge = (s: number, t: number) => (store.db.prepare(
  `SELECT source_id, target_id, relation_type, weight, metadata, created_at, contradict_confidence
   FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'causal'`,
).get(s, t) ?? undefined) as Record<string, unknown> | undefined;

const archivedEdge = (s: number, t: number) => (store.db.prepare(
  `SELECT source_id, target_id, relation_type, weight, metadata, created_at, contradict_confidence, operator_note
   FROM retired_causal_edges WHERE source_id = ? AND target_id = ?`,
).get(s, t) ?? undefined) as Record<string, unknown> | undefined;

// ─── Census scoping ──────────────────────────────────────────────────────────

describe("causalWitnessCensus", () => {
  test("Beads-origin causal edges (non-observation endpoints) NEVER enter the census", () => {
    const beadA = mkDoc("beads/issue-1.md", { collection: "beads" });
    const beadB = mkDoc("beads/issue-2.md", { collection: "beads" });
    insertEdge(beadA, beadB, { weight: 1.0, metadata: JSON.stringify({ origin: "beads", dep_type: "blocks" }) });
    expect(causalWitnessCensus(store.db)).toHaveLength(0);
  });

  test("an edge with sightings is excluded; classification separates materializable from unresolved", () => {
    const [a, b] = laneDocs();
    const c = mkDoc("observations/lane-c.md", { observationType: "problem" });

    insertEdge(a, b, { metadata: JSON.stringify({ reasoning: "old r", source_fact: "sf", target_fact: "tf" }), weight: 0.9 });
    insertEdge(a, c, { metadata: JSON.stringify({ origin: "beads" }) });        // unprovable metadata on lane endpoints
    insertEdge(b, c, { metadata: null });                                       // null metadata → unresolved
    insertLiveSighting(a, b);   // a→b drops out of the census entirely

    const census = causalWitnessCensus(store.db);
    expect(census).toHaveLength(2);
    expect(census.every(e => !e.materializable)).toBe(true);
    const keys = census.map(e => `${e.row.source_id}:${e.row.target_id}`).sort();
    expect(keys).toEqual([`${a}:${c}`, `${b}:${c}`].sort());
  });

  test("valid old-writer metadata classifies as materializable (no resolution needed)", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: JSON.stringify({ reasoning: "old r", source_fact: "sf", target_fact: "tf" }), weight: 0.85 });
    const census = causalWitnessCensus(store.db);
    expect(census).toHaveLength(1);
    expect(census[0]!.materializable).toBe(true);
  });

  test("resolution REFUSES a materializable edge — valid old-writer evidence can never be retired here", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: JSON.stringify({ reasoning: "old r", source_fact: "sf", target_fact: "tf" }), weight: 0.85 });
    const [entry] = causalWitnessCensus(store.db);
    const { runKey, runId } = cliRun();
    for (const action of ["retire-edge", "keep-weight"] as const) {
      const outcome = applyResolution(store.db,
        { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
        action, { runKey, runId });
      expect(outcome.status).toBe("refused");
    }
    expect(activeEdge(a, b)).toBeDefined();
    expect(archivedEdge(a, b)).toBeUndefined();
    expect(store.db.prepare(`SELECT COUNT(*) n FROM causal_witness_sightings`).get()).toEqual({ n: 0 });
  });
});

// ─── keep-weight ─────────────────────────────────────────────────────────────

describe("applyResolution keep-weight", () => {
  test("writes the single operator-ratified legacy row carrying the current weight", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { weight: 0.7, metadata: JSON.stringify({ garbage: true }) });
    const [entry] = causalWitnessCensus(store.db);
    const { runKey, runId } = cliRun();

    const outcome = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "keep-weight", { runKey, runId });

    expect(outcome).toEqual({ status: "resolved", action: "keep-weight" });
    const sightings = store.db.prepare(
      `SELECT legacy, confidence, source_fact_ordinal FROM causal_witness_sightings WHERE source_id = ? AND target_id = ?`,
    ).all(a, b) as Array<{ legacy: number; confidence: number; source_fact_ordinal: number }>;
    expect(sightings).toHaveLength(1);
    expect(sightings[0]!.legacy).toBe(1);
    expect(sightings[0]!.confidence).toBe(0.7);
    expect(sightings[0]!.source_fact_ordinal).toBe(-1);
    // The edge is now resolved — it leaves the census.
    expect(causalWitnessCensus(store.db)).toHaveLength(0);
  });

  test("repeated materialization cannot add a second legacy row or use a raised weight", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { weight: 0.7, metadata: JSON.stringify({ garbage: true }) });
    const [entry] = causalWitnessCensus(store.db);
    const { runKey, runId } = cliRun();
    applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "keep-weight", { runKey, runId });

    // Live evidence raises the weight afterwards.
    insertLiveSighting(a, b);
    store.db.prepare(`UPDATE memory_relations SET weight = 0.95 WHERE source_id = ? AND target_id = ?`).run(a, b);

    // A second apply against the ORIGINAL manifest is stale (sightings exist).
    const again = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "keep-weight", { runKey, runId });
    expect(again.status).toBe("stale");

    // And the structural invariant holds even against a direct insert:
    // ux_cws_one_legacy THROWS rather than fabricating a second legacy row.
    expect(() => store.db.prepare(
      `INSERT INTO causal_witness_sightings (source_id, target_id, source_fact_ordinal, target_fact_ordinal,
         reasoning, confidence, model_identity, prompt_version, run_key, legacy, created_at)
       VALUES (?, ?, -1, -1, '', 0.95, '', '', ?, 1, '2026-08-02T00:00:00.000Z')`,
    ).run(a, b, randomUUID())).toThrow();
    const legacyRows = store.db.prepare(
      `SELECT confidence FROM causal_witness_sightings WHERE source_id = ? AND target_id = ? AND legacy = 1`,
    ).all(a, b) as Array<{ confidence: number }>;
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]!.confidence).toBe(0.7);   // the ratified weight, never the raised one
  });

  test("refuses to ratify a weight outside [0,1]", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { weight: 3.5, metadata: null });
    const [entry] = causalWitnessCensus(store.db);
    const { runKey, runId } = cliRun();
    const outcome = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "keep-weight", { runKey, runId });
    expect(outcome.status).toBe("refused");
    expect(store.db.prepare(`SELECT COUNT(*) n FROM causal_witness_sightings`).get()).toEqual({ n: 0 });
  });
});

// ─── retire-edge + binding preview ───────────────────────────────────────────

describe("applyResolution retire-edge", () => {
  test("archives the COMPLETE row image and deletes the active row in one transaction", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { weight: 0.66, metadata: '{"odd": "metadata"}', createdAt: "2026-06-15T12:00:00.000Z", contradictConfidence: 0.4 });
    const [entry] = causalWitnessCensus(store.db);
    const { runKey, runId } = cliRun();

    const outcome = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "retire-edge", { runKey, runId, operatorNote: "unprovable origin" });

    expect(outcome).toEqual({ status: "resolved", action: "retire-edge" });
    expect(activeEdge(a, b)).toBeUndefined();
    const archived = archivedEdge(a, b)!;
    expect(archived.weight).toBe(0.66);
    expect(archived.metadata).toBe('{"odd": "metadata"}');
    expect(archived.created_at).toBe("2026-06-15T12:00:00.000Z");
    expect(archived.contradict_confidence).toBe(0.4);
    expect(archived.operator_note).toBe("unprovable origin");
    const events = store.db.prepare(`SELECT event_type FROM causal_run_events WHERE run_id = ?`).all(runId) as Array<{ event_type: string }>;
    expect(events.some(e => e.event_type === "edge_retired")).toBe(true);
  });

  test("a sighting added between preview and apply reports STALE and touches nothing", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: null });
    const [entry] = causalWitnessCensus(store.db);
    insertLiveSighting(a, b);   // concurrent admission after the preview
    const { runKey, runId } = cliRun();

    const outcome = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "retire-edge", { runKey, runId });

    expect(outcome.status).toBe("stale");
    expect(activeEdge(a, b)).toBeDefined();
    expect(archivedEdge(a, b)).toBeUndefined();
  });

  test("ANY column mutation between preview and apply — including contradict_confidence — reports STALE", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: null, contradictConfidence: null });
    const [entry] = causalWitnessCensus(store.db);
    // The full-row fingerprint covers the migrated column; assuming it null is unsafe.
    store.db.prepare(`UPDATE memory_relations SET contradict_confidence = 0.9 WHERE source_id = ? AND target_id = ?`).run(a, b);
    const { runKey, runId } = cliRun();

    const outcome = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "retire-edge", { runKey, runId });

    expect(outcome.status).toBe("stale");
    expect(activeEdge(a, b)).toBeDefined();
  });

  test("a manifest from a different fingerprint version is refused outright", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: null });
    const [entry] = causalWitnessCensus(store.db);
    const { runKey, runId } = cliRun();
    const outcome = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: "cwfp0" },
      "retire-edge", { runKey, runId });
    expect(outcome.status).toBe("refused");
    expect(activeEdge(a, b)).toBeDefined();
  });

  test("fingerprints are typed and null-preserving (NULL ≠ '' ≠ 0)", () => {
    const base = { source_id: 1, target_id: 2, relation_type: "causal" };
    const fpNull = edgeFingerprint({ ...base, weight: null, metadata: null, created_at: null, contradict_confidence: null });
    const fpEmpty = edgeFingerprint({ ...base, weight: null, metadata: "", created_at: null, contradict_confidence: null });
    const fpZero = edgeFingerprint({ ...base, weight: 0, metadata: null, created_at: null, contradict_confidence: null });
    const fpZeroStr = edgeFingerprint({ ...base, weight: "0" as any, metadata: null, created_at: null, contradict_confidence: null });
    expect(new Set([fpNull, fpEmpty, fpZero, fpZeroStr]).size).toBe(4);
  });

  test("manifest carries the version tag and every census edge", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: null });
    const manifest = buildResolutionManifest(causalWitnessCensus(store.db));
    expect(manifest.version).toBe(CAUSAL_FINGERPRINT_VERSION);
    expect(manifest.edges).toHaveLength(1);
    expect(manifest.edges[0]).toMatchObject({ sourceId: a, targetId: b, relationType: "causal", materializable: false });
  });
});

// ─── restore-edge ────────────────────────────────────────────────────────────

describe("restoreRetiredEdge", () => {
  function retire(a: number, b: number): void {
    const [entry] = causalWitnessCensus(store.db).filter(e => e.row.source_id === a && e.row.target_id === b);
    const { runKey, runId } = cliRun();
    const outcome = applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "retire-edge", { runKey, runId });
    expect(outcome.status).toBe("resolved");
  }

  test("round-trips the archived row byte-identically via plain INSERT", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { weight: 0.42, metadata: '{"x":1}', createdAt: "2026-05-05T05:05:05.000Z", contradictConfidence: 0.25 });
    const before = activeEdge(a, b)!;
    retire(a, b);
    expect(activeEdge(a, b)).toBeUndefined();

    const { runKey, runId } = cliRun();
    const outcome = restoreRetiredEdge(store.db, { sourceId: a, targetId: b }, { runKey, runId });

    expect(outcome).toEqual({ status: "restored" });
    expect(activeEdge(a, b)).toEqual(before);
    expect(archivedEdge(a, b)).toBeUndefined();   // archive row consumed exactly once
  });

  test("with the composite key OCCUPIED, restore FAILS CLOSED: occupying edge + archive both untouched", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { weight: 0.42, metadata: '{"x":1}' });
    retire(a, b);

    // Another producer occupies the key and accumulates its own sightings.
    insertEdge(a, b, { weight: 0.99, metadata: '{"occupier":true}' });
    insertLiveSighting(a, b);

    const { runKey, runId } = cliRun();
    const outcome = restoreRetiredEdge(store.db, { sourceId: a, targetId: b }, { runKey, runId });

    expect(outcome.status).toBe("conflict");
    const occupying = activeEdge(a, b)!;
    expect(occupying.weight).toBe(0.99);          // never replaced
    expect(occupying.metadata).toBe('{"occupier":true}');
    expect(store.db.prepare(
      `SELECT COUNT(*) n FROM causal_witness_sightings WHERE source_id = ? AND target_id = ?`,
    ).get(a, b)).toEqual({ n: 1 });               // sightings never cascaded away
    const archived = archivedEdge(a, b)!;
    expect(archived.weight).toBe(0.42);           // archive byte-untouched
  });

  test("restoring a never-retired edge reports not_archived", () => {
    const { runKey, runId } = cliRun();
    expect(restoreRetiredEdge(store.db, { sourceId: 111, targetId: 222 }, { runKey, runId }))
      .toEqual({ status: "not_archived" });
  });

  test("only recognized CONSTRAINT violations classify as occupied-key conflicts; operational failures rethrow", () => {
    // SQLite constraint shapes → conflict (fail-closed occupied-key report).
    expect(isConstraintConflict(Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" }))).toBe(true);
    expect(isConstraintConflict(Object.assign(new Error("FK failed"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }))).toBe(true);
    expect(isConstraintConflict(new Error("FOREIGN KEY constraint failed"))).toBe(true);
    // Operational failures (locking, I/O, corruption) → NOT conflicts; the
    // restore rethrows them so the CLI finalizes cli_error and reports honestly.
    expect(isConstraintConflict(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))).toBe(false);
    expect(isConstraintConflict(Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }))).toBe(false);
    expect(isConstraintConflict(new Error("database disk image is malformed"))).toBe(false);

    // End-to-end: a genuine operational failure (SQLITE_BUSY from a concurrent
    // writer holding the lock) propagates out of restoreRetiredEdge instead of
    // reporting "conflict". (Trigger-based RAISE cannot stage this: SQLite
    // reports every RAISE — FAIL included — under the constraint class.)
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: null });
    const [entry] = causalWitnessCensus(store.db);
    const pre = cliRun();
    expect(applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "retire-edge", { runKey: pre.runKey, runId: pre.runId }).status).toBe("resolved");
    const { runKey, runId } = cliRun();
    store.db.exec(`PRAGMA busy_timeout = 1`);
    const { Database } = require("bun:sqlite");
    const contender = new Database(join(dir, "vault.sqlite"));
    try {
      contender.exec(`PRAGMA busy_timeout = 1`);
      contender.exec(`BEGIN IMMEDIATE`);
      expect(() => restoreRetiredEdge(store.db, { sourceId: a, targetId: b }, { runKey, runId })).toThrow();
    } finally {
      try { contender.exec(`ROLLBACK`); } catch { /* not open */ }
      contender.close();
      store.db.exec(`PRAGMA busy_timeout = 5000`);
    }
    // Fail-closed even on rethrow: archive untouched, nothing restored.
    expect(archivedEdge(a, b)).toBeDefined();
    expect(activeEdge(a, b)).toBeUndefined();
  });

  test("CLI boundary: a REFUSED restore finalizes the run cli_error through the REAL command surface", () => {
    // Production path (cmdMigrate → restoreRetiredEdge → conflict → finalize →
    // die): retire an edge, let another producer occupy its key, then restore
    // via the actual CLI subprocess — non-zero exit AND a terminal cli_error
    // run row with a real finish time.
    const [a, b] = laneDocs();
    insertEdge(a, b, { weight: 0.42, metadata: null });
    const [entry] = causalWitnessCensus(store.db);
    const pre = cliRun();
    expect(applyResolution(store.db,
      { sourceId: a, targetId: b, fingerprint: entry!.fingerprint, manifestVersion: CAUSAL_FINGERPRINT_VERSION },
      "retire-edge", { runKey: pre.runKey, runId: pre.runId }).status).toBe("resolved");
    insertEdge(a, b, { weight: 0.99, metadata: '{"occupier":true}' });   // key now occupied

    const proc = Bun.spawnSync(
      ["bun", "src/clawmem.ts", "migrate", "causal-witnesses", "--restore-edge", `${a}:${b}`, "--apply"],
      { env: { ...process.env, INDEX_PATH: join(dir, "vault.sqlite") }, cwd: process.cwd() },
    );
    expect(proc.exitCode).not.toBe(0);
    const runs = store.db.prepare(
      `SELECT outcome, finished_at FROM causal_runs WHERE source = 'cli_migrate' AND id > ? ORDER BY id DESC LIMIT 1`,
    ).all(pre.runId) as Array<{ outcome: string; finished_at: string | null }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("cli_error");
    expect(runs[0]!.finished_at).not.toBeNull();
    // Fail-closed: occupier and archive both intact.
    expect((activeEdge(a, b) as any).weight).toBe(0.99);
    expect(archivedEdge(a, b)).toBeDefined();
  }, 30_000);

  test("CLI boundary: a vault locked for the ENTIRE operation strands no in_progress row", () => {
    // The contender holds the write lock across the whole subprocess run — the
    // pessimistic-terminal discipline means every surviving row is terminal
    // (cli_ok/cli_error); an insert the lock refused simply leaves no row.
    const { Database } = require("bun:sqlite");
    const contender = new Database(join(dir, "vault.sqlite"));
    let proc: ReturnType<typeof Bun.spawnSync>;
    try {
      contender.exec(`PRAGMA busy_timeout = 1`);
      contender.exec(`BEGIN IMMEDIATE`);
      proc = Bun.spawnSync(
        ["bun", "src/clawmem.ts", "migrate", "causal-witnesses", "--restore-edge", "999:998", "--apply"],
        { env: { ...process.env, INDEX_PATH: join(dir, "vault.sqlite") }, cwd: process.cwd() },
      );
    } finally {
      try { contender.exec(`ROLLBACK`); } catch { /* not open */ }
      contender.close();
    }
    expect(proc.exitCode).not.toBe(0);
    const stranded = store.db.prepare(
      `SELECT COUNT(*) n FROM causal_runs WHERE outcome = 'in_progress'`,
    ).get() as { n: number };
    expect(stranded.n).toBe(0);
  }, 30_000);

  test("pessimistic terminal: a failed finalization leaves the row cli_error — never in_progress, never fabricated success", () => {
    const { finalizeCliCausalRun } = require("../../src/causal-writer.ts");
    // The row is BORN terminal-pessimistic.
    const runKey = randomUUID();
    const runId = insertCausalRun(store.db, { runKey, source: "cli_migrate", mode: "cli", outcome: "cli_error" });

    // The operation "succeeded", but a contender holds the write lock when
    // finalization tries to flip the row to cli_ok — the UPDATE fails, the
    // failure is swallowed loudly, and the row keeps its terminal cli_error.
    const { Database } = require("bun:sqlite");
    const contender = new Database(join(dir, "vault.sqlite"));
    try {
      store.db.exec(`PRAGMA busy_timeout = 1`);
      contender.exec(`PRAGMA busy_timeout = 1`);
      contender.exec(`BEGIN IMMEDIATE`);
      finalizeCliCausalRun(store.db, runId, "cli_ok", Date.now() - 5);   // must not throw
    } finally {
      try { contender.exec(`ROLLBACK`); } catch { /* not open */ }
      contender.close();
      store.db.exec(`PRAGMA busy_timeout = 5000`);
    }
    const row = store.db.prepare(`SELECT outcome FROM causal_runs WHERE id = ?`).get(runId) as { outcome: string };
    expect(row.outcome).toBe("cli_error");
  });

  test("CLI boundary: BOTH production inserts are born cli_error — a rejected cli_ok finalization leaves the REAL rows terminal while the operations succeed", () => {
    // A permanent trigger persists in the DB file, so it fires inside the
    // subprocess's own connection. It rejects ONLY the flip to cli_ok — if
    // either production insert (resolve path / restore path in cmdMigrate)
    // were reverted to born-in_progress, the surviving row would read
    // in_progress here and this test would fail.
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: null });                     // unresolved legacy edge
    const entries = causalWitnessCensus(store.db);
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(buildResolutionManifest(entries), null, 2));
    store.db.exec(
      `CREATE TRIGGER cw_reject_cli_ok BEFORE UPDATE OF outcome ON causal_runs
       WHEN NEW.outcome = 'cli_ok' BEGIN SELECT RAISE(ABORT, 'injected finalization rejection'); END`,
    );
    const before = (store.db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM causal_runs`).get() as { m: number }).m;

    // Insert site 1 — the resolve path: retire the edge through the REAL CLI.
    const resolveProc = Bun.spawnSync(
      ["bun", "src/clawmem.ts", "migrate", "causal-witnesses", "--resolve-unmaterializable", "retire-edge",
       "--manifest", manifestPath, "--edge", `${a}:${b}`, "--apply"],
      { env: { ...process.env, INDEX_PATH: join(dir, "vault.sqlite") }, cwd: process.cwd() },
    );
    expect(resolveProc.exitCode).toBe(0);                     // finalization is best-effort; the operation decides the exit
    expect(archivedEdge(a, b)).toBeDefined();                 // the retire genuinely applied
    expect(activeEdge(a, b)).toBeUndefined();
    expect(new TextDecoder().decode(resolveProc.stderr)).toContain("finalization (cli_ok) failed");

    // Insert site 2 — the restore path: bring it back through the REAL CLI.
    const restoreProc = Bun.spawnSync(
      ["bun", "src/clawmem.ts", "migrate", "causal-witnesses", "--restore-edge", `${a}:${b}`, "--apply"],
      { env: { ...process.env, INDEX_PATH: join(dir, "vault.sqlite") }, cwd: process.cwd() },
    );
    expect(restoreProc.exitCode).toBe(0);
    expect(activeEdge(a, b)).toBeDefined();                   // the restore genuinely applied
    expect(new TextDecoder().decode(restoreProc.stderr)).toContain("finalization (cli_ok) failed");

    // Both production-created rows kept their born-terminal outcome, and the
    // NULL finish time proves no second write repainted them — cli_error here
    // is the INSERT's value, not a finalization fallback.
    const rows = store.db.prepare(
      `SELECT outcome, finished_at FROM causal_runs WHERE source = 'cli_migrate' AND id > ? ORDER BY id`,
    ).all(before) as Array<{ outcome: string; finished_at: string | null }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.outcome).toBe("cli_error");
      expect(row.finished_at).toBeNull();
    }
    store.db.exec(`DROP TRIGGER cw_reject_cli_ok`);
  }, 30_000);

  test("the archive survives audit retention (retired_causal_edges is non-pruned)", () => {
    const [a, b] = laneDocs();
    insertEdge(a, b, { metadata: null });
    retire(a, b);
    // Prune EVERYTHING from the runs/events audit.
    const { pruneCausalRuns } = require("../../src/causal-writer.ts");
    pruneCausalRuns(store.db, { maxAgeDays: 0, maxRuns: 0 });
    expect(store.db.prepare(`SELECT COUNT(*) n FROM causal_runs`).get()).toEqual({ n: 0 });
    expect(archivedEdge(a, b)).toBeDefined();
  });
});

// ─── BACKLOG 82.3, D7 — a --note led by a byte-order mark (ruling 62 A) ──────
// The note is refused when the CLI reads the flag, with a message naming the flag, before any run row is written —
// not by the storage guard deep in the retire transaction (whose message points at the doctor, which does not apply).
describe("--note led by a byte-order mark (62 A)", () => {
  test.each([["U+FEFF", String.fromCharCode(0xfeff)], ["U+FFFE", String.fromCharCode(0xfffe)]])(
    "%s: refused at the flag — exit 2, the message names --note, no run row, the edge untouched",
    (_name, mark) => {
      const [a, b] = laneDocs();
      insertEdge(a, b, { metadata: null });
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(buildResolutionManifest(causalWitnessCensus(store.db)), null, 2));
      for (const extra of [["--apply"], []]) {
        const proc = Bun.spawnSync(
          ["bun", "src/clawmem.ts", "migrate", "causal-witnesses", "--resolve-unmaterializable", "retire-edge",
           "--manifest", manifestPath, "--edge", `${a}:${b}`, "--note", mark + "unprovable origin", ...extra],
          { env: { ...process.env, INDEX_PATH: join(dir, "vault.sqlite") }, cwd: process.cwd() },
        );
        expect(proc.exitCode).toBe(2);                         // 64 A: the exit code of every refused mark-led input
        expect(new TextDecoder().decode(proc.stderr)).toContain("--note");
      }
      expect(store.db.prepare(`SELECT COUNT(*) n FROM causal_runs WHERE source = 'cli_migrate'`).get()).toEqual({ n: 0 });
      expect(activeEdge(a, b)).toBeDefined();
      expect(archivedEdge(a, b)).toBeUndefined();
    },
    30_000,
  );
});
