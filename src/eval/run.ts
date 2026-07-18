/**
 * Offline eval harness — run orchestrator (HORMA-1).
 *
 * `runEval` is the whole run minus arg parsing and terminal printing, so the
 * CLI (`clawmem eval run`) and the test suite exercise the identical path:
 * strict gold load → strict resolution → sequential replay through the real
 * `query` handler → doc-level metrics → run.json/report.md.
 *
 * Replay is deliberately SEQUENTIAL: parallel calls would contend on the
 * shared expansion/rerank services and corrupt per-example latency.
 */

import { readFileSync } from "fs";
import type { Store } from "../store.ts";
import { parseGoldFile, resolveGoldExamples } from "./gold.ts";
import { computeDocMetrics } from "./metrics.ts";
import { createEvalSession, replayQueryExample } from "./replay.ts";
import { buildRunReport, writeRunArtifacts } from "./report.ts";
import type { ExampleResult, GoldMode, RunReport } from "./types.ts";

/** Replay surfaces implemented so far. intent/context/raw/structured are follow-on phases. */
export const IMPLEMENTED_PROFILES = ["query"] as const;
export type EvalProfile = (typeof IMPLEMENTED_PROFILES)[number];

const PROFILE_MODE: Record<EvalProfile, GoldMode> = { query: "query" };

export interface RunEvalOptions {
  goldPath: string;
  profile: EvalProfile;
  /** k for the @k metrics — the `limit` passed to the replayed tool. Default 10. */
  limit?: number;
  /** Labeled-set trust-gate floor. Default 30 (feature-specific); 80+ for a global number. */
  minExamples?: number;
  /** Operator attests a 10–20% hand-audit of the gold labels passed. Part of the trust gate — the harness cannot verify it, only record it. Default false. */
  audited?: boolean;
  /** Directory for run.json + report.md; omit to skip writing (tests). */
  outDir?: string;
  /** Open store on the SAME vault the replay server will open — used for gold resolution + docid mapping. Caller owns its lifecycle. */
  store: Store;
}

export interface RunEvalResult {
  report: RunReport;
  artifacts: { runJsonPath: string; reportMdPath: string } | null;
}

/**
 * Thrown when retrieved-result identity cannot be established: a returned
 * `collection/path` display path that maps to zero or multiple active
 * documents. Either way the measurement is corrupt — silently dropping the
 * result would inflate precision/Jaccard, and silently picking one candidate
 * would score the wrong document — so the run hard-fails.
 */
export class EvalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalIntegrityError";
  }
}

/**
 * Map a display path back to exactly one active document id. The composed
 * `collection || '/' || path` string is ambiguous when a collection name
 * itself contains "/" (nothing validates collection names against that), so
 * this refuses to guess: 0 matches or 2+ matches throw EvalIntegrityError.
 */
export function resolveRetrievedDocId(store: Store, displayPath: string): number {
  const rows = store.db.prepare(
    `SELECT id FROM documents WHERE collection || '/' || path = ? AND active = 1 AND invalidated_at IS NULL LIMIT 2`
  ).all(displayPath) as { id: number }[];
  if (rows.length === 0) {
    throw new EvalIntegrityError(`retrieved path "${displayPath}" did not map to any active document — vault changed mid-run?`);
  }
  if (rows.length > 1) {
    throw new EvalIntegrityError(`retrieved path "${displayPath}" is ambiguous — its collection/path composition matches multiple documents (a collection name containing "/" collides with a sibling); rename the colliding collection before evaluating`);
  }
  return rows[0]!.id;
}

function readClawmemVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function runEval(opts: RunEvalOptions): Promise<RunEvalResult> {
  const limit = opts.limit ?? 10;
  const minExamples = opts.minExamples ?? 30;
  const createdAt = new Date().toISOString();
  const runId = `${createdAt.replace(/[:.]/g, "-")}-${opts.profile}`;

  const examples = parseGoldFile(opts.goldPath); // throws GoldFileError on any bad line
  const resolved = resolveGoldExamples(opts.store, examples);

  const wantMode = PROFILE_MODE[opts.profile];
  const skipped: { example_id: string; reason: string }[] = [];
  const unresolvedGold: RunReport["unresolved_gold"] = [];
  const toScore: typeof resolved = [];

  for (const r of resolved) {
    // Unresolved accounting comes BEFORE the profile filter: the trust
    // contract is zero unresolved required-evidence refs across the whole
    // gold FILE — a stale label must not vanish into `skipped` just because
    // its mode isn't replayed by this run's profile.
    if (r.unresolved.length > 0) {
      // Strict: partial gold would silently inflate recall — the example is
      // excluded from scoring and the run's trust gate fails.
      unresolvedGold.push({ example_id: r.example.id, refs: r.unresolved });
      continue;
    }
    if (r.example.mode !== wantMode) {
      skipped.push({ example_id: r.example.id, reason: `mode "${r.example.mode}" not replayed by profile "${opts.profile}"` });
      continue;
    }
    toScore.push(r);
  }

  const scored: ExampleResult[] = [];
  const session = await createEvalSession();
  try {
    for (const r of toScore) {
      const warnings = [...r.warnings];
      const { orderedPaths, elapsedMs } = await replayQueryExample(session.client, r.example, limit);

      const retrievedIds: number[] = [];
      const retrieved: { doc_id: number; path: string }[] = [];
      for (const p of orderedPaths) {
        const id = resolveRetrievedDocId(opts.store, p); // throws EvalIntegrityError on 0 or 2+ matches
        retrievedIds.push(id);
        retrieved.push({ doc_id: id, path: p });
      }

      scored.push({
        id: r.example.id,
        tags: r.example.tags,
        mode: r.example.mode,
        metrics: computeDocMetrics(retrievedIds, new Set(r.goldDocIds)),
        retrieved,
        gold: r.goldDocs.map(g => ({ doc_id: g.docId, path: g.path })),
        elapsed_ms: elapsedMs,
        warnings,
      });
    }
  } finally {
    await session.close();
  }

  const report = buildRunReport({
    runId,
    profile: opts.profile,
    createdAt,
    goldPath: opts.goldPath,
    dbPath: (opts.store.db as { filename?: string }).filename ?? null,
    clawmemVersion: readClawmemVersion(),
    limit,
    minExamples,
    auditAttested: opts.audited ?? false,
    examplesTotal: examples.length,
    scored,
    unresolvedGold,
    skipped,
  });

  const artifacts = opts.outDir ? writeRunArtifacts(opts.outDir, report) : null;
  return { report, artifacts };
}
