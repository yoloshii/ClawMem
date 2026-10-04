#!/usr/bin/env bun
/**
 * ClawMem CLI - Hybrid agent memory (QMD search + SAME memory layer)
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve as pathResolve, basename, relative as pathRelative } from "path";
import { createHash } from "crypto";
import { runCanaryBattery, canaryProbeInputs, cosineSim, CANARY_DRIFT_FLOOR, runSampledVectorValidation, canaryGate, persistCanaryBaselineIfFirst, type CanaryCheckResult } from "./canary.ts";
import { retryOnBusyAsync, isSqliteBusyError } from "./busy-retry.ts";
import {
  createStore,
  prewarmVectors,
  startPeriodicPrewarm,
  resolvePrewarmIntervalMs,
  enableProductionMode,
  getDefaultDbPath,
  canonicalDocId,
  type Store,
  type SearchResult,
  type ExpandedQuery,
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_GLOB,
  extractSnippet,
  FatalVectorError,
  VecDimensionMismatchError,
  VecModelMismatchError,
  EmbedLeaseLostError,
} from "./store.ts";
import { startVectorDaemon, vectorDaemonHealth, type VectorDaemonHandle } from "./vector-daemon.ts";
import {
  getDefaultLlamaCpp,
  setDefaultLlamaCpp,
  buildRemoteChatCompletionsUrl,
  disposeDefaultLlamaCpp,
  formatDocForEmbedding,
  formatQueryForEmbedding,
  LlamaCpp,
  normalizeRemoteLlmNoThink,
  type Queryable,
} from "./llm.ts";
import {
  acquireWorkerLease,
  releaseWorkerLease,
  renewWorkerLease,
} from "./worker-lease.ts";
import {
  loadConfig,
  addCollection as collectionsAdd,
  removeCollection as collectionsRemove,
  listCollections as collectionsList,
  getCollection,
  isValidCollectionName,
  getConfigPath,
} from "./collections.ts";
import { formatSearchResults, type OutputFormat } from "./formatter.ts";
import { runEval, IMPLEMENTED_PROFILES, EvalIntegrityError, type EvalProfile, type RunEvalResult } from "./eval/run.ts";
import { GoldFileError } from "./eval/gold.ts";
import { runHookEval, HookEvalIntegrityError, PAIR_TREATMENTS, type RunHookEvalResult, type PairTreatment, type VectorExecSpec } from "./eval/hook-run.ts";
import { aggregateReplicatedRunDirs, writeReplicatedArtifacts, type ReplicatedAggregate } from "./eval/replicated.ts";
import { HookGoldFileError } from "./eval/hook-gold.ts";
import { indexCollection, parseDocument, hashContent, pathWithin, watchTargets } from "./indexer.ts";
import type { Store as StoreType } from "./store.ts";
import type { ConversationChunk } from "./normalize.ts";
import { detectBeadsProject } from "./beads.ts";
import { applyCompositeScoring, hasRecencyIntent, type EnrichedResult } from "./memory.ts";
import { enrichResults, reciprocalRankFusion, toRanked, hasStrongFtsSignal, ftsBypassEnabled, type RankedResult } from "./search-utils.ts";
import { splitDocument } from "./splitter.ts";
import { getProfile, updateProfile, isProfileStale, type ProfileUpdateOutcome } from "./profile.ts";
import { regenerateAllDirectoryContexts } from "./directory-context.ts";
import {
  startConsolidationWorker,
  stopConsolidationWorker,
} from "./consolidation.ts";
import {
  parseHeavyLaneConfigFromEnv,
  startHeavyMaintenanceWorker,
} from "./maintenance.ts";
import { readHookInput, writeHookOutput, makeEmptyOutput, type HookOutput } from "./hooks.ts";
import { consumePendingSurfacingBookkeeping, writeSurfacingBookkeepingSpoolJob, drainSurfacingBookkeepingSpool, validateSurfacingBookkeepingJob, serializeSurfacingBookkeepingJob, SPOOL_JOB_MAX_BYTES } from "./hooks/surfacing-bookkeeping.ts";
import { contextSurfacing, assertHookBudgetConfig } from "./hooks/context-surfacing.ts";
import { monoNow, elapsed, evidenceMs, deadlineAfter, remainingForTimeout, duration, sleep, scaled, type MonoInstant, isoNow, toDate, epochNow, epochMs } from "./clock.ts";
import { sessionBootstrap } from "./hooks/session-bootstrap.ts";
import { decisionExtractor, unwrapContradictionArray, admitContradictionEntries } from "./hooks/decision-extractor.ts";
import { resolveJudge, buildContradictionPrompt, extractJudgeJson, JUDGE_VERDICT_SCHEMA } from "./judge.ts";
import { evaluateMergeContradiction, isActionableContradiction, resolveContradictionPolicy } from "./merge-guards.ts";
import { judgeAuditCounts } from "./judge-audit.ts";
import { handoffGenerator } from "./hooks/handoff-generator.ts";
import { SESSION_END_BUSY_TIMEOUT_MS, SESSION_END_DEADLINE_MS } from "./stop-handoff.ts";
import { feedbackLoop } from "./hooks/feedback-loop.ts";
import { stalenessCheck } from "./hooks/staleness-check.ts";
import { precompactExtract } from "./hooks/precompact-extract.ts";
import { postcompactInject } from "./hooks/postcompact-inject.ts";
import { isLegacyPrecompactState, legacyPrecompactStateFiles, notLegacyArtifactSql, registerCompaction } from "./compaction-state.ts";
import { clawmemHookName, postcompactMatcherIssues, stripClawmemHooks } from "./hook-settings.ts";
import { pretoolInject } from "./hooks/pretool-inject.ts";
import { curatorNudge } from "./hooks/curator-nudge.ts";
import {
  readSessionFocus,
  writeSessionFocus,
  clearSessionFocus,
  focusFilePath,
} from "./session-focus.ts";
import {
  resolveExtensionsDirNoOpenClaw,
  resolveOpenClawProfile,
  printSetupOpenClawHelp,
  swapDirIntoPlace,
  moveTargetAside,
  resolveRecordableClawmemBin,
} from "./openclaw-paths.ts";

enableProductionMode();

// =============================================================================
// Store lifecycle
// =============================================================================

let store: Store | null = null;

function getStore(busyTimeout: number = 5000): Store {
  if (!store) {
    store = createStore(undefined, { busyTimeout });
  }
  return store;
}

function closeStore(): void {
  if (store) {
    store.close();
    store = null;
  }
}

// =============================================================================
// Terminal colors
// =============================================================================

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
};

// =============================================================================
// Helpers
// =============================================================================

function die(msg: string): never {
  console.error(`${c.red}Error:${c.reset} ${msg}`);
  process.exit(1);
}

/**
 * Enrichment segment for index-run summaries (issue #24): the per-doc `[amem]`
 * lines are easy to read past, so the run summary states how many enrichment
 * attempts stored a note. The label is "notes" deliberately — the metric is
 * the NOTE WRITE, not whole-pipeline success (codex turn-2 finding 1): a
 * stored note whose later link phase failed still counts, and an empty note
 * whose entity phase succeeded still shows as producing nothing. A persistent
 * gap is the dead-or-squatted inference signature. Empty string when nothing
 * ran (no enrichable changes, or CLAWMEM_ENABLE_AMEM=false).
 */
function enrichSummaryNote(stats: { enrichAttempted: number; enrichStored: number }): string {
  if (stats.enrichAttempted === 0) return "";
  if (stats.enrichStored === stats.enrichAttempted) {
    return `, ${c.green}✎${stats.enrichStored}/${stats.enrichAttempted}${c.reset} notes`;
  }
  const empty = stats.enrichAttempted - stats.enrichStored;
  return `, ${c.red}✎${stats.enrichStored}/${stats.enrichAttempted} notes — ${empty} produced nothing (LLM endpoint problem? run 'clawmem doctor')${c.reset}`;
}

// =============================================================================
// Commands
// =============================================================================

async function cmdInit() {
  const cacheDir = getDefaultDbPath().replace(/\/[^/]+$/, "");
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  // Create store (initializes DB)
  const s = getStore();
  const configPath = getConfigPath();

  console.log(`${c.green}ClawMem initialized${c.reset}`);
  console.log(`  Database: ${s.dbPath}`);
  console.log(`  Config:   ${configPath}`);
  console.log();
  console.log("Next steps:");
  console.log(`  clawmem collection add ~/notes --name notes`);
  console.log(`  clawmem update`);
  console.log(`  clawmem embed`);
}

async function cmdCollectionAdd(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      pattern: { type: "string", default: DEFAULT_GLOB },
    },
    allowPositionals: true,
  });

  const dirPath = positionals[0];
  if (!dirPath) die("Usage: clawmem collection add <path> --name <name>");

  const absPath = pathResolve(dirPath);
  if (!existsSync(absPath)) die(`Directory not found: ${absPath}`);

  const name = values.name || basename(absPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!isValidCollectionName(name)) die(`Invalid collection name: ${name}`);

  collectionsAdd(name, absPath, values.pattern);
  console.log(`${c.green}Added collection '${name}'${c.reset} → ${absPath}`);
  console.log(`  Pattern: ${values.pattern}`);
  console.log();
  console.log(`Run ${c.cyan}clawmem update${c.reset} to index files`);
}

async function cmdCollectionList() {
  const collections = collectionsList();
  if (collections.length === 0) {
    console.log("No collections configured.");
    console.log(`Add one with: ${c.cyan}clawmem collection add <path> --name <name>${c.reset}`);
    return;
  }

  for (const col of collections) {
    const s = getStore();
    const count = (s.db.prepare(
      "SELECT COUNT(*) as c FROM documents WHERE collection = ? AND active = 1"
    ).get(col.name) as { c: number }).c;

    console.log(`${c.bold}${col.name}${c.reset}`);
    console.log(`  Path:     ${col.path}`);
    console.log(`  Pattern:  ${col.pattern}`);
    console.log(`  Files:    ${count}`);
    if (col.update) console.log(`  Update:   ${col.update}`);
    console.log();
  }
}

async function cmdCollectionRemove(args: string[]) {
  const name = args[0];
  if (!name) die("Usage: clawmem collection remove <name>");

  if (collectionsRemove(name)) {
    console.log(`${c.green}Removed collection '${name}'${c.reset}`);
  } else {
    die(`Collection '${name}' not found`);
  }
}

async function cmdUpdate(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      pull: { type: "boolean", default: false },
      embed: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const collections = collectionsList();
  if (collections.length === 0) die("No collections configured. Add one first.");

  const s = getStore();

  for (const col of collections) {
    // Run pre-update command if configured
    if (values.pull && col.update) {
      console.log(`${c.dim}Running: ${col.update}${c.reset}`);
      const result = Bun.spawnSync(["bash", "-c", col.update], { cwd: col.path });
      if (result.exitCode !== 0) {
        console.error(`${c.yellow}Warning: update command failed for ${col.name}${c.reset}`);
      }
    }

    console.log(`${c.cyan}Indexing ${col.name}${c.reset} (${col.path})`);
    const stats = await indexCollection(s, col.name, col.path, col.pattern);
    console.log(`  ${c.green}+${stats.added}${c.reset} added, ${c.yellow}~${stats.updated}${c.reset} updated, ${c.dim}=${stats.unchanged}${c.reset} unchanged, ${c.red}-${stats.removed}${c.reset} removed${enrichSummaryNote(stats)}`);
  }

  // Auto-embed if --embed flag is set
  if (values.embed) {
    console.log();
    await cmdEmbed([]);
  } else {
    console.log();
    console.log(`Run ${c.cyan}clawmem embed${c.reset} to generate embeddings for new content`);
  }

  // Auto-rebuild profile if stale
  if (isProfileStale(s)) {
    // §55.6 D9: a forgotten or archived profile is deliberately left alone — say so rather
    // than reporting a rebuild that did not happen.
    console.log(`${c.dim}${profileOutcomeMessage(updateProfile(s), true)}${c.reset}`);
  }
}

// =============================================================================
// §51.1 D10 — mine/backfill shared identity derivation
// =============================================================================

/**
 * One staging-content formatter for mine writes AND the backfill body-hash
 * guard — a second formatter would drift and break the guard.
 */
function buildMineStagingContent(chunk: ConversationChunk): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  return [
    "---",
    `title: "${esc(chunk.title)}"`,
    `content_type: conversation`,
    `source: "${esc(chunk.sourcePath)}"`,
    ...(chunk.authoredAt ? [`authored_at: "${chunk.authoredAt}"`] : []),
    "---",
    "",
    chunk.body,
  ].join("\n");
}

/**
 * Has this source ever produced suffixed chunks in the collection?
 * Prepared prefix-range existence query over UNIQUE(collection, path) — NOT a
 * raw LIKE (its % and _ wildcards would misread path characters). The probe
 * prefix ends in "_" (0x5F); replacing that final character with backtick
 * (0x60, its successor code point) gives exact bounds under SQLite binary text
 * ordering. Active AND inactive rows both count: once suffixed, always suffixed.
 */
function suffixedPathExists(store: StoreType, collectionName: string, suffixedBase: string): boolean {
  const lower = `${suffixedBase}_`;
  const upper = `${suffixedBase}\``;
  const row = store.db.prepare(
    `SELECT 1 FROM documents WHERE collection = ? AND path >= ? AND path < ? LIMIT 1`
  ).get(collectionName, lower, upper);
  return row !== null && row !== undefined;
}

/**
 * Decide each source's staging-name base ONCE per source, before any chunk name
 * is derived. A source uses the suffixed scheme `<base>-h<8-hex sha256(relPosixPath)>`
 * when (a) it collides with another source in the current batch after
 * sanitization, or (b) any of its suffixed chunk paths already exist in the
 * target collection — so group-membership changes (a collision partner removed,
 * a transcript growing new chunks) can never flip an already-suffixed source
 * back to the legacy namespace. Also fixes the pre-existing silent overwrite:
 * two sources sanitizing to one staging name used to clobber each other's
 * chunks via concurrent Bun.write.
 */
function deriveMineIdentity(
  sourceRelPaths: string[],
  store: StoreType,
  collectionName: string
): Map<string, { base: string; suffixed: boolean }> {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const sanitize = (p: string) => p.replace(/[\/\\]/g, "_").replace(/\.[^.]+$/, "");

  const bySafe = new Map<string, string[]>();
  for (const rel of [...new Set(sourceRelPaths)]) {
    const safe = sanitize(norm(rel));
    const list = bySafe.get(safe) ?? [];
    list.push(rel);
    bySafe.set(safe, list);
  }

  const out = new Map<string, { base: string; suffixed: boolean }>();
  for (const [safe, rels] of bySafe) {
    for (const rel of rels) {
      const relPosix = norm(rel);
      const hash8 = new Bun.CryptoHasher("sha256").update(relPosix).digest("hex").slice(0, 8);
      const suffixedBase = `${safe}-h${hash8}`;
      const suffixed = rels.length > 1 || suffixedPathExists(store, collectionName, suffixedBase);
      out.set(rel, { base: suffixed ? suffixedBase : safe, suffixed });
    }
  }

  // Final output-name uniqueness assertion: an 8-hex hash collision (or a file
  // literally named like another source's suffixed base) is a hard error —
  // never a silent overwrite.
  const seen = new Map<string, string>();
  for (const [rel, id] of out) {
    const prior = seen.get(id.base);
    if (prior !== undefined) {
      die(`mine: staging name collision between "${prior}" and "${rel}" (base "${id.base}") — cannot derive unique identities`);
    }
    seen.set(id.base, rel);
  }
  return out;
}

async function cmdMine(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      collection: { type: "string", short: "c" },
      embed: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      synthesize: { type: "boolean", default: false },
      "synthesis-max-docs": { type: "string" },
      "backfill-dates": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const dir = positionals[0];
  if (!dir) die("Usage: clawmem mine <directory> [-c collection-name] [--embed] [--dry-run] [--synthesize] [--synthesis-max-docs N] | --backfill-dates [--apply]");
  const absDir = pathResolve(dir);
  if (!existsSync(absDir)) die(`Directory not found: ${absDir}`);

  const { scanConversationDir, normalizeFile, chunkConversation } = await import("./normalize.ts");

  console.log(`${c.cyan}Scanning for conversation files${c.reset} in ${absDir}`);
  const files = scanConversationDir(absDir);
  if (files.length === 0) die("No conversation files found (.json, .jsonl, .txt, .md)");
  console.log(`  Found ${files.length} candidate files`);

  // Normalize and chunk
  let totalChunks = 0;
  let totalConversations = 0;
  const allChunks: ConversationChunk[] = [];

  for (const file of files) {
    const conv = normalizeFile(file);
    if (!conv) continue;
    totalConversations++;

    const chunks = chunkConversation(conv);
    if (chunks.length === 0) continue;

    console.log(`  ${c.green}✓${c.reset} ${conv.source} (${conv.format}, ${conv.messages.length} messages → ${chunks.length} chunks)`);
    for (const chunk of chunks) {
      // §51.1 D10: relative POSIX form — identity hashes must not depend on
      // the machine's absolute path or separator style.
      chunk.sourcePath = pathRelative(absDir, file).replace(/\\/g, "/");
    }
    allChunks.push(...chunks);
    totalChunks += chunks.length;
  }

  if (totalConversations === 0) die("No conversation files could be parsed");
  console.log(`\n${c.bold}Parsed:${c.reset} ${totalConversations} conversations → ${totalChunks} exchange chunks`);

  const collectionName = values.collection || "conversations";

  // §51.1 D10 — exclusive backfill mode: derive authored_at for already-mined
  // docs from their source transcripts. Metadata-only; dry-run by default.
  if (values["backfill-dates"]) {
    if (values.embed || values.synthesize || values["dry-run"] || values["synthesis-max-docs"]) {
      die("--backfill-dates is an exclusive mode (dry-run by default; --apply executes) — it cannot combine with --embed, --synthesize, --dry-run, or --synthesis-max-docs");
    }
    runBackfillDates(allChunks, collectionName, values.apply as boolean);
    return;
  }
  if (values.apply) die("--apply only applies to --backfill-dates");

  if (values["dry-run"]) {
    console.log(`${c.yellow}Dry run — no changes made${c.reset}`);
    return;
  }

  // Write chunks as markdown to a staging directory (outside source tree), then index
  const { tmpdir } = await import("os");
  const stagingDir = pathResolve(tmpdir(), `clawmem-mine-${epochMs(epochNow())}`);
  mkdirSync(stagingDir, { recursive: true });

  const { rmSync } = await import("fs");
  const s = getStore();
  // §51.1 D10: per-source identity decided before any chunk name is derived
  const identity = deriveMineIdentity(allChunks.map(ch => ch.sourcePath), s, collectionName);
  try {
    const writePromises: Promise<number>[] = [];
    for (const chunk of allChunks) {
      const id = identity.get(chunk.sourcePath)!;
      const filename = `${id.base}_${String(chunk.chunkIndex).padStart(4, "0")}.md`;
      writePromises.push(Bun.write(pathResolve(stagingDir, filename), buildMineStagingContent(chunk)));
    }
    await Promise.all(writePromises);

    // Index through the existing pipeline in importMode: mined rows are DB-born ('api') and
    // the staging root is transient, so absence reconciliation must not run — a later mine
    // into the same collection would otherwise deactivate every earlier batch.
    console.log(`\n${c.cyan}Indexing ${totalChunks} conversation chunks${c.reset} as collection '${collectionName}'`);
    const stats = await indexCollection(s, collectionName, stagingDir, "**/*.md", { importMode: true });
    const datedNote = stats.dated > 0 ? `, ${c.cyan}◷${stats.dated}${c.reset} dated` : "";
    console.log(`  ${c.green}+${stats.added}${c.reset} added, ${c.yellow}~${stats.updated}${c.reset} updated, ${c.dim}=${stats.unchanged}${c.reset} unchanged${datedNote}${enrichSummaryNote(stats)}`);

    // Ext 4 — post-import conversation synthesis (opt-in via --synthesize)
    // Runs AFTER indexCollection has committed. Failure is non-fatal and never
    // rolls back the mine import.
    if (values.synthesize) {
      const maxDocs = values["synthesis-max-docs"]
        ? parseInt(values["synthesis-max-docs"] as string, 10)
        : undefined;
      console.log(`\n${c.cyan}Running post-import conversation synthesis${c.reset}`);
      try {
        const { runConversationSynthesis } = await import("./conversation-synthesis.ts");
        const llm = getDefaultLlamaCpp();
        const synthResult = await runConversationSynthesis(s, llm, {
          collection: collectionName,
          maxDocs: Number.isFinite(maxDocs) && (maxDocs as number) > 0 ? maxDocs : undefined,
        });
        console.log(
          `  ${c.green}${synthResult.factsSaved}${c.reset} facts saved, ` +
          `${c.green}${synthResult.linksResolved}${c.reset} links resolved, ` +
          `${c.yellow}${synthResult.linksUnresolved}${c.reset} unresolved, ` +
          `${c.dim}${synthResult.llmFailures} LLM failure(s), ${synthResult.docsWithNoFacts} docs with no facts${c.reset}`,
        );
      } catch (err) {
        console.log(`  ${c.yellow}Synthesis failed (mine import preserved):${c.reset} ${err}`);
      }
    }

    if (values.embed) {
      console.log();
      await cmdEmbed([]);
    } else {
      console.log(`\nRun ${c.cyan}clawmem embed${c.reset} to generate embeddings for the imported conversations`);
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * §51.1 D10 — recoverable-only authored_at backfill.
 *
 * Matches already-mined documents to their re-derived chunks via the shared
 * identity derivation, then applies a metadata-only UPDATE of authored_at.
 * Guards (all mandatory): the naming rule's collision handling; body-hash
 * equality (parser/chunker evolution can shift chunk indices while preserving
 * filenames — a mismatched chunk is skipped, never guessed); exact
 * collection+path match; idempotence. Never touches hash/content/modified_at/
 * stored confidence/embeddings. Dry-run by default; one transaction on --apply.
 */
function runBackfillDates(allChunks: ConversationChunk[], collectionName: string, apply: boolean): void {
  const s = getStore();
  const identity = deriveMineIdentity(allChunks.map(ch => ch.sourcePath), s, collectionName);

  const counts = { chunks: 0, noDate: 0, unmatched: 0, bodyMismatch: 0, unchanged: 0 };
  const updates: { id: number; authoredAt: string; expectedHash: string; path: string }[] = [];

  for (const chunk of allChunks) {
    counts.chunks++;
    if (!chunk.authoredAt) { counts.noDate++; continue; }
    const id = identity.get(chunk.sourcePath)!;
    const path = `${id.base}_${String(chunk.chunkIndex).padStart(4, "0")}.md`;
    const row = s.db.prepare(
      `SELECT id, hash, authored_at FROM documents WHERE collection = ? AND path = ? AND active = 1`
    ).get(collectionName, path) as { id: number; hash: string; authored_at: string | null } | null;
    if (!row) { counts.unmatched++; continue; }

    // Body-hash equality guard — rebuild the staging content and parse it
    // through the SAME pipeline the indexer used, so the comparison cannot
    // drift from what was actually hashed at mine time.
    const { body } = parseDocument(buildMineStagingContent(chunk), path);
    const expectedHash = hashContent(body);
    if (expectedHash !== row.hash) { counts.bodyMismatch++; continue; }

    if (row.authored_at === chunk.authoredAt) { counts.unchanged++; continue; }
    updates.push({ id: row.id, authoredAt: chunk.authoredAt, expectedHash, path });
  }

  console.log(`\n${c.bold}Backfill dates${c.reset} (collection '${collectionName}'${apply ? "" : ", DRY RUN"}):`);
  console.log(`  ${counts.chunks} chunks scanned — ${c.green}${updates.length}${c.reset} to update, ${c.dim}${counts.unchanged} already set, ${counts.noDate} without source timestamps${c.reset}, ${c.yellow}${counts.unmatched} unmatched${c.reset}, ${c.red}${counts.bodyMismatch} body-mismatch skipped${c.reset}`);

  if (!apply) {
    if (updates.length > 0) console.log(`  Run again with ${c.cyan}--apply${c.reset} to write.`);
    return;
  }
  if (updates.length === 0) { console.log("  Nothing to write."); return; }

  // Guarded, transactional apply: the UPDATE re-asserts the validated hash and
  // active state so a concurrent mine/index between validation and write can
  // never attach a source timestamp to content that did not pass the guard.
  // BEGIN IMMEDIATE takes the write lock up front.
  let applied = 0;
  s.db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = s.db.prepare(
      `UPDATE documents SET authored_at = ? WHERE id = ? AND hash = ? AND active = 1`
    );
    for (const u of updates) {
      applied += stmt.run(u.authoredAt, u.id, u.expectedHash).changes;
    }
    s.db.exec("COMMIT");
  } catch (err) {
    s.db.exec("ROLLBACK");
    throw err;
  }
  const raced = updates.length - applied;
  console.log(`  ${c.green}✓${c.reset} ${applied} document(s) dated (metadata-only — modified_at/embeddings untouched)`);
  if (raced > 0) console.log(`  ${c.yellow}⚠${c.reset} ${raced} document(s) changed concurrently and were skipped — re-run to reconcile`);
}

// SQLITE_BUSY retry helper lives in busy-retry.ts (testable — importing THIS module runs
// the CLI). Console reporting is injected here so the helper stays I/O-free.
const retryOnBusy = <T,>(fn: () => T, label: string, isLeaseLost: () => boolean): Promise<T> =>
  retryOnBusyAsync(fn, label, isLeaseLost, {
    onRetry: (l, attempt, delayMs) =>
      console.error(`${c.yellow}    ${l}: database busy — retrying in ${delayMs / 1000}s (${attempt}/3)${c.reset}`),
  });

async function cmdEmbed(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean", short: "f", default: false },
      // Escape hatch for the geometry-canary preflight ((d).1): a failing battery
      // aborts the run BEFORE any destructive step unless this is passed.
      "force-geometry": { type: "boolean", default: false },
      // Explicit baseline replacement (T8-M3): baselines are first-healthy calibrations
      // and never roll on their own — this is the intentional recalibration operation.
      "recalibrate-canary": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const s = getStore();
  // Embed runs race live hook/watcher writers. Set the operational busy timeout on the
  // ACTIVE connection — `update --embed` constructs and caches the store before invoking
  // this command, so a getStore()-time option could not cover it ((f).3 / T2-M1). Kept at
  // 10s: a synchronous busy wait blocks the event loop, and the lease heartbeat below
  // fires every 30s against a 60s TTL — waits must stay well under the renewal margin
  // ((f).1 / T2-H4). Recovery beyond 10s is the ASYNC bounded retry, not a longer block.
  s.db.exec(`PRAGMA busy_timeout = 10000`);

  // Embedding lease: serialize embed commands (manual / embed timer / update --embed)
  // so two embeds cannot run at once. It is RENEWABLE (token-fenced heartbeat), not a
  // fixed-TTL lease — a full-vault rebuild outlasts any fixed TTL and would be reclaimed
  // mid-run. Without serialization, two embeds using different same-dimension models can
  // silently build a heterogeneous vector space (dimension checks can't catch that).
  // See EMBED-LEASE-RENEWAL-DESIGN.md / INCIDENT-2026-06-22.
  const LEASE_NAME = "embedding";
  const LEASE_TTL_MS = 60_000;
  const lease = acquireWorkerLease(s, LEASE_NAME, LEASE_TTL_MS);
  if (!lease.acquired || !lease.token) {
    console.log(`${c.yellow}Another embed is already in progress (lease held); skipping.${c.reset}`);
    return;
  }
  const leaseToken = lease.token;
  // Passed into every vector mutation (clear, stale-clean, table-create, insert) so
  // each verifies ownership before mutating — a process that lost the lease mid-await
  // cannot wipe/recreate/write the vector store under the new holder.
  const leaseGuard = { workerName: LEASE_NAME, token: leaseToken };
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    if (!renewWorkerLease(s, LEASE_NAME, leaseToken, LEASE_TTL_MS)) leaseLost = true;
  }, Math.floor(LEASE_TTL_MS / 2));

  // Run-level state-marker wrapper ((f).4 / T9-M4): busy-retried, lease-loss aborts, and
  // a marker that STILL fails logs-and-continues — bookkeeping must never kill the run.
  const markSafeGlobal = async (label: string, fn: () => void) => {
    try { await retryOnBusy(fn, label, () => leaseLost); }
    catch (err) {
      if (err instanceof FatalVectorError) throw err; // incl. EmbedLeaseLostError
      if (!isSqliteBusyError(err)) throw err;
      console.error(`${c.yellow}Warning: ${label} still busy after retries — continuing${c.reset}`);
    }
  };

  try {
    const embedUrl = process.env.CLAWMEM_EMBED_URL;
    if (embedUrl) {
      console.log(`Using remote GPU embedding: ${embedUrl}`);
    } else {
      // Local CPU mode: disable inactivity timeout to prevent context disposal mid-batch
      setDefaultLlamaCpp(new LlamaCpp({ inactivityTimeoutMs: 0 }));
    }
    const llm = getDefaultLlamaCpp();

    // Geometry-canary PREFLIGHT ((d).1 / T3-H1): gate BEFORE any destructive step — a
    // broken-geometry server must fail the run before clearAllEmbeddings, not after 60k
    // writes. Runs on EVERY embed entry, including runs that turn out to be no-work
    // (a healthy-looking idle run still validates the server). FAIL-CLOSED for --force
    // (T8-H1): a destructive clear must never proceed on an UNVALIDATED endpoint — the
    // dimension probe alone can pass a flaky server far enough to destroy the old index.
    // Recalibration (T9-M3) evaluates INTRINSIC sanity only — the old baseline is exactly
    // what a recalibration replaces — and requires --force: the baseline must describe the
    // geometry the WHOLE vault was embedded with, which only a full rebuild guarantees.
    const recalibrate = !!values["recalibrate-canary"];
    if (recalibrate && !values.force) {
      console.error(`${c.red}--recalibrate-canary requires --force: the new baseline must correspond to a full rebuild under the new geometry.${c.reset}`);
      process.exitCode = 1;
      return;
    }
    let canaryState: CanaryCheckResult | null = null;
    {
      const outcome = await runCanaryBattery(t => llm.embed(t), key => s.getCanaryBaseline(key), { ignoreBaseline: recalibrate });
      if (!("unavailable" in outcome)) canaryState = outcome;
      const gate = canaryGate(outcome, { force: !!values.force, forceGeometry: !!values["force-geometry"] });
      if (gate.action === "abort") {
        console.error(`${c.red}Embed aborted: ${gate.reason}${c.reset}`);
        if (canaryState) {
          for (const f of canaryState.failures) console.error(`  ${c.red}${f}${c.reset}`);
          console.error(`${c.red}The server is producing non-discriminating or drifted vectors (pooling / EOS-anchor / quant misconfiguration?). Nothing was cleared or written. Fix the serving stack (see docs/troubleshooting.md → "Vector search returns weak or irrelevant results"), or override with --force-geometry.${c.reset}`);
        }
        process.exitCode = 1;
        return;
      }
      if (gate.action === "warn") {
        console.error(`${c.yellow}Geometry canary: ${gate.reason}${c.reset}`);
        if (canaryState) for (const f of canaryState.failures) console.error(`  ${c.yellow}${f}${c.reset}`);
      }
    }

    // Shared end-of-run finalization (T9-H1 + T10-M1): EVERY exit path that reaches a
    // completed run — including the no-work early return — verifies the end state.
    // Absent preflight vectors (canary unavailable, run proceeded) → persistent
    // unverified taint + nonzero; baseline persist/recalibration happens ONLY after a
    // successful same-dimension end probe. "Not verified" is never success (T8-M2).
    // v0.41.2 (BACKLOG 68.3): run scope, so the finalization (the no-work path included) knows what this run stored.
    let totalFragments = 0;
    let removedStale = 0;
    const finalizeCanary = async (failedFragmentsCount: number) => {
      const setTaint = (reason: string) =>
        markSafeGlobal("setVaultFlag(taint)", () => s.setVaultFlag("embed_geometry_taint", reason, leaseGuard));
      // A NON-destructive run (no --force clear) that stored no vectors cannot have mixed a second geometry into the
      // table: it never sets the taint. It still says so and exits non-zero when it was not verified (BACKLOG 68.3).
      const nothingStored = !values.force && totalFragments === 0;
      const unchanged = `this run wrote 0 vectors${removedStale > 0 ? ` (removed ${removedStale} stale)` : ""}, so the vault's geometry is unchanged — no taint set`;
      if (!canaryState) {
        if (nothingStored) {
          console.error(`${c.yellow}WARNING: this run had NO validated preflight geometry (canary unavailable); ${unchanged}. Re-run 'clawmem embed' once the server answers.${c.reset}`);
          process.exitCode = 1;
          return;
        }
        console.error(`${c.red}WARNING: this run had NO validated preflight geometry (canary unavailable). The vault state is UNVERIFIED — run 'clawmem embed --force' against a validated server to clear.${c.reset}`);
        await setTaint(`no preflight validation at ${isoNow()}`);
        process.exitCode = 1;
        return;
      }
      let endDrift: number | null = null;
      try {
        const fresh = await llm.embed(canaryProbeInputs().get("rel_a")!);
        const pre = canaryState.vectors.get("rel_a")!;
        if (fresh && fresh.embedding.length === pre.length) {
          endDrift = cosineSim(pre, fresh.embedding instanceof Float32Array ? fresh.embedding : new Float32Array(fresh.embedding));
        }
      } catch { /* endpoint gone at the very end — endDrift stays null → unverified */ }
      if (endDrift === null) {
        if (nothingStored) {
          console.error(`${c.yellow}WARNING: end-of-run geometry verification FAILED (endpoint unreachable or dimension changed); ${unchanged}.${c.reset}`);
        } else {
          console.error(`${c.red}WARNING: end-of-run geometry verification FAILED (endpoint unreachable or dimension changed). This run is UNVERIFIED — treat the vault state as suspect. Re-run 'clawmem embed' once the server is stable.${c.reset}`);
          await setTaint(`unverified end-of-run at ${isoNow()}`);
        }
        process.exitCode = 1;
      } else if (endDrift < CANARY_DRIFT_FLOOR) {
        if (nothingStored) {
          console.error(`${c.yellow}WARNING: embedding-server geometry DRIFTED mid-run (probe self-sim ${endDrift.toFixed(4)} < ${CANARY_DRIFT_FLOOR}); ${unchanged}. Stabilize the server before the next run.${c.reset}`);
        } else {
          console.error(`${c.red}WARNING: embedding-server geometry DRIFTED mid-run (probe self-sim ${endDrift.toFixed(4)} < ${CANARY_DRIFT_FLOOR}). This rebuild is TAINTED — the vault mixes two geometries. Stabilize the server, then run 'clawmem embed --force'.${c.reset}`);
          await setTaint(`mid-run drift ${endDrift.toFixed(4)} at ${isoNow()}`);
        }
        process.exitCode = 1;
      } else {
        // Verified end. A FULL verified rebuild (--force) clears any standing taint —
        // the mixed-geometry state the flag records has been rebuilt away (T8-M1).
        // leaseLost is re-checked first: a reclaimed holder must not clear a
        // successor's taint (T9-M4).
        // v0.41.2: only a PASSING preflight clears it — an overridden failed canary (--force-geometry) does not.
        if (values.force && failedFragmentsCount === 0 && !leaseLost && canaryState.pass) {
          await markSafeGlobal("clearVaultFlag(taint)", () => s.clearVaultFlag("embed_geometry_taint", leaseGuard));
        }
        if (canaryState.pass) {
          persistCanaryBaselineIfFirst(s, canaryState, { recalibrate, leaseGuard });
        }
      }
    };

    // Probe the live model's output dimension (+ model name). Returns null on ANY
    // failure so a down/flaky endpoint can NEVER trigger a destructive clear.
    const probeEmbed = async (): Promise<{ dim: number; model: string } | null> => {
      try {
        const r = await llm.embed("clawmem dimension probe");
        return r && r.embedding && r.embedding.length > 0
          ? { dim: r.embedding.length, model: r.model ?? "" }
          : null;
      } catch { return null; }
    };

    // Bind the whole run to one (dim, model); every fragment is validated before it is
    // stored. On a fresh vault these are set from the first successful fragment.
    let expectedDim: number | null = null;
    let expectedModel: string | null = null;

    if (values.force) {
      // Probe FIRST — validate the endpoint before destroying anything (so a force
      // re-embed against a dead endpoint cannot clear the vault and then fail).
      const probe = await probeEmbed();
      if (!probe) {
        console.error(`${c.red}Force re-embed aborted: could not reach the embedding endpoint. Nothing was cleared.${c.reset}`);
        return;
      }
      console.log(`${c.yellow}Force mode: clearing all embeddings (rebuilding at dim ${probe.dim})${c.reset}`);
      expectedDim = probe.dim;
      expectedModel = probe.model || null;
      s.clearAllEmbeddings(leaseGuard);
    } else {
      // Implicit run: NON-DESTRUCTIVE drift check (dimension AND model). Catches
      // drift even when the worklist is empty (query embeddings would already be
      // incompatible with the stored table). Never clears — aborts with instructions.
      const existingDim = s.getVecTableDim(); // throws VecSchemaError on malformed DDL → caught below
      if (existingDim !== null) {
        const probe = await probeEmbed();
        if (probe && probe.dim !== existingDim) {
          console.error(`${c.red}Embedding dimension changed (${existingDim} → ${probe.dim}). Run 'clawmem embed --force' to clear and rebuild the full vault.${c.reset}`);
          return;
        }
        // Same dimension but a DIFFERENT model still mixes the vector space (cosine
        // across two models is meaningless) and the dim check cannot see it. Compare
        // the probe's model against what the vault was built with; abort on mismatch.
        const existingModels = s.getVecModels();
        if (existingModels.length > 1) {
          console.error(`${c.red}Vault already contains mixed embedding models: ${existingModels.join(", ")}. Run 'clawmem embed --force' to rebuild with a single model.${c.reset}`);
          return;
        }
        if (probe && probe.model && existingModels.length === 1 && existingModels[0] !== probe.model) {
          console.error(`${c.red}Embedding model changed (${existingModels[0]} → ${probe.model}) at the same dimension. Mixing models in one vector space breaks similarity. Run 'clawmem embed --force' to rebuild with the current model.${c.reset}`);
          return;
        }
        expectedDim = existingDim;
        if (probe && probe.model) expectedModel = probe.model;
      }
    }

    // Clean stale embeddings (orphaned hashes from updated/deleted documents).
    // SKIPPED under --force ((f).7 / T2-H3): clearAllEmbeddings just emptied
    // content_vectors, so no orphaned hashes can exist — running it only risks a
    // SQLITE_BUSY dying AFTER the clear with the index freshly emptied.
    if (!values.force) {
      try {
        const cleaned = await retryOnBusy(() => s.cleanStaleEmbeddings(leaseGuard), "cleanStaleEmbeddings", () => leaseLost);
        removedStale = cleaned;
        if (cleaned > 0) {
          console.log(`${c.yellow}Cleaned ${cleaned} stale embedding(s) from orphaned documents${c.reset}`);
        }
      } catch (err) {
        if (err instanceof FatalVectorError) throw err; // incl. EmbedLeaseLostError
        if (!isSqliteBusyError(err)) throw err;
        // Busy after all retries: stale rows are inert (hydration JOINs active docs only) —
        // log and continue; the next sweep retries.
        console.error(`${c.yellow}Warning: stale-embedding cleanup still busy after retries — continuing${c.reset}`);
      }
    }

    // Use fragment-based pipeline: split documents into semantic fragments and embed each
    const hashes = s.getHashesNeedingFragments();
    if (hashes.length === 0) {
      // No-work run: routes through the SAME finalization as a working run (T10-M1) —
      // it must not skip end verification, silently exit zero on an unvalidated
      // endpoint, or persist/recalibrate a baseline without a verified end.
      console.log(`${c.green}All documents already embedded${c.reset}`);
      await finalizeCanary(0);
      return;
    }

    // Count total fragments first for ETA
    let totalFragEstimate = 0;
    const docFragCounts: number[] = [];
    for (const { body, path } of hashes) {
      let frontmatter: Record<string, any> | undefined;
      try {
        const parsed = parseDocument(body, path);
        frontmatter = parsed.meta as any;
      } catch { /* skip */ }
      const frags = splitDocument(body, frontmatter);
      docFragCounts.push(frags.length);
      totalFragEstimate += frags.length;
    }
    console.log(`Embedding ${hashes.length} documents (${totalFragEstimate} fragments total)...`);

    let embedded = 0;
    let failedFragments = 0;
    const batchStart = monoNow();

    // Cloud API: global batch pacing state (persists across documents)
    // TPM is the binding constraint, not RPM. 50 frags × ~800 tokens ≈ 40K tokens/batch → max ~2.5 batches/min at 100K TPM.
    const isCloudEmbed = !!process.env.CLAWMEM_EMBED_API_KEY;
    const CLOUD_BATCH_SIZE = 50;
    const CLOUD_TPM_LIMIT = parseInt(process.env.CLAWMEM_EMBED_TPM_LIMIT || "100000", 10);
    const CLOUD_TPM_SAFETY = 0.85; // use 85% of limit to leave headroom for retries
    const CHARS_PER_TOKEN = 4;
    let lastBatchSentAt: MonoInstant | null = null; // global timestamp of last batch send

    // Bind the run to one (dim, model) and validate every embedding before it is stored.
    // The first successful fragment sets the binding on a fresh vault; any later drift —
    // a dimension change OR a same-dimension model swap from a flapping endpoint — throws
    // a fatal error that aborts the whole run (caught below). This is what dimension
    // checks alone cannot do: catch a different 2560-d model.
    const bindAndValidate = (result: { embedding: number[] | Float32Array; model?: string }) => {
      const dim = result.embedding.length;
      if (expectedDim === null) {
        expectedDim = dim;
        if (!expectedModel && result.model) expectedModel = result.model;
      } else if (dim !== expectedDim) {
        throw new VecDimensionMismatchError(expectedDim, dim);
      }
      if (expectedModel && result.model && result.model !== expectedModel) {
        throw new VecModelMismatchError(expectedModel, result.model);
      }
    };

    for (let docIdx = 0; docIdx < hashes.length; docIdx++) {
      // Abort cleanly if the heartbeat reported the lease was reclaimed.
      if (leaseLost) throw new EmbedLeaseLostError();

      const { hash, body, path, title: docTitle, collection } = hashes[docIdx]!;
      const title = docTitle || basename(path).replace(/\.(md|txt)$/i, "");
      const canId = canonicalDocId(collection, path);

      // Parse frontmatter for fragment splitting
      let frontmatter: Record<string, any> | undefined;
      try {
        const parsed = parseDocument(body, path);
        frontmatter = parsed.meta as any;
      } catch {
        // No frontmatter or parsing error — fine, skip it
      }

      const fragments = splitDocument(body, frontmatter);
      const docStart = monoNow();
      const prevFailedFragments = failedFragments;
      let seq0Succeeded = false;

      // Mark the doc 'pending' and increment embed_attempts ONCE before its first
      // fragment, so a crash mid-document leaves it retryable (re-selected by
      // getHashesNeedingFragments). Completion setters below are state-only.
      // A state MARKER must never kill the run ((f).4) — markSafeGlobal above.
      const markSafe = markSafeGlobal;
      await markSafe("markEmbedStart", () => s.markEmbedStart(hash, leaseGuard));
      console.error(`  [${docIdx + 1}/${hashes.length}] ${basename(path)} (${fragments.length} frags, ${body.length} chars)`);

      if (isCloudEmbed) {
        // Batch mode: collect all texts, send in chunks of CLOUD_BATCH_SIZE
        const allTexts: string[] = [];
        for (const frag of fragments) {
          const label = frag.label || title;
          allTexts.push(formatDocForEmbedding(frag.content, label));
        }

        for (let batchStartIdx = 0; batchStartIdx < allTexts.length; batchStartIdx += CLOUD_BATCH_SIZE) {
          // Abort before each batch if the lease was reclaimed — a large document
          // must not keep writing after another process took the lease (HIGH-3).
          if (leaseLost) throw new EmbedLeaseLostError();
          // Global TPM-aware delay: compute required wait based on last batch's token count,
          // then wait only the remaining time since lastBatchSentAt. Applies to ALL batches
          // including first batch of each document (inter-document pacing).
          if (lastBatchSentAt !== null) {
            // Adaptive TPM-aware delay. Set CLAWMEM_EMBED_TPM_LIMIT to match your tier:
            //   Free: 100000 (default), Paid: 2000000, Premium: 50000000
            const batchEnd0 = Math.min(batchStartIdx + CLOUD_BATCH_SIZE, allTexts.length);
            const estimatedTokens = allTexts.slice(batchStartIdx, batchEnd0)
              .reduce((sum, t) => sum + Math.ceil(t.length / CHARS_PER_TOKEN), 0);
            // Use current batch estimate (not previous batch actuals — previous batch may differ in size)
            const batchTokens = estimatedTokens;
            const safeTPM = CLOUD_TPM_LIMIT * CLOUD_TPM_SAFETY;
            const requiredGapMs = Math.max(500, (batchTokens / safeTPM) * 60_000);
            // O1: the pacing window is a monotonic deadline from the last send.
            const wait = remainingForTimeout(deadlineAfter(lastBatchSentAt, duration(requiredGapMs)));
            if (wait !== null) await sleep(scaled(wait, 0.85 + Math.random() * 0.3));
          }

          const batchEnd = Math.min(batchStartIdx + CLOUD_BATCH_SIZE, allTexts.length);
          const batchTexts = allTexts.slice(batchStartIdx, batchEnd);
          lastBatchSentAt = monoNow();
          const reqStart = monoNow();

          try {
            const results = await llm.embedBatch(batchTexts);
            const reqMs = evidenceMs(elapsed(reqStart));
            const tokensUsed = llm.lastBatchTokens;

            for (let i = 0; i < results.length; i++) {
              const seq = batchStartIdx + i;
              const frag = fragments[seq]!;
              const result = results[i];
              if (result) {
                bindAndValidate(result);
                // Embed-input fingerprint ((d).4 / T5-L1): SHA-256 over the UTF-8 bytes of
                // the exact formatted embed input, written in the same atomic transaction.
                const embedInputFp = createHash("sha256").update(allTexts[seq]!, "utf8").digest("hex");
                // SQLITE_BUSY-only async retry ((f).2/6): busy exhaustion throws to the
                // batch catch (fragment failure); FatalVectorError passes through untouched.
                await retryOnBusy(() => {
                  s.ensureVecTable(result.embedding.length, leaseGuard);
                  s.insertEmbedding(
                    hash, seq, frag.startLine, new Float32Array(result.embedding),
                    result.model, isoNow(), frag.type, frag.label ?? undefined, canId,
                    leaseGuard, embedInputFp
                  );
                }, "insertEmbedding", () => leaseLost);
                totalFragments++;
                if (seq === 0) seq0Succeeded = true;
              } else {
                failedFragments++;
              }
            }
            console.error(`    batch ${batchStartIdx + 1}-${batchEnd}/${allTexts.length} (${results.filter(r => r).length} ok) ${reqMs}ms${tokensUsed ? ` ${tokensUsed} tok` : ""}`);
          } catch (err) {
            if (err instanceof FatalVectorError) throw err; // dim/model/schema mismatch → abort the whole run
            failedFragments += batchTexts.length;
            console.error(`${c.yellow}Warning: batch embed failed for ${path} frags ${batchStartIdx + 1}-${batchEnd}: ${err}${c.reset}`);
          }
        }
      } else {
        // Local mode: embed one at a time (no rate limit concern)
        for (let seq = 0; seq < fragments.length; seq++) {
          // Abort before each fragment if the lease was reclaimed — bounds any
          // post-loss writing to at most one fragment of a large doc (HIGH-3).
          if (leaseLost) throw new EmbedLeaseLostError();
          const frag = fragments[seq]!;
          const label = frag.label || title;
          const text = formatDocForEmbedding(frag.content, label);

          try {
            const fragStart = monoNow();
            const result = await llm.embed(text);
            const fragMs = evidenceMs(elapsed(fragStart));
            if (result) {
              bindAndValidate(result);
              // Embed-input fingerprint ((d).4 / T5-L1): SHA-256 over the UTF-8 bytes of
              // the exact formatted embed input, written in the same atomic transaction.
              const embedInputFp = createHash("sha256").update(text, "utf8").digest("hex");
              // SQLITE_BUSY-only async retry ((f).2/6): busy exhaustion throws to the
              // per-fragment catch (fragment failure); FatalVectorError passes through.
              await retryOnBusy(() => {
                s.ensureVecTable(result.embedding.length, leaseGuard);
                s.insertEmbedding(
                  hash, seq, frag.startLine, new Float32Array(result.embedding),
                  result.model, isoNow(), frag.type, frag.label ?? undefined, canId,
                  leaseGuard, embedInputFp
                );
              }, "insertEmbedding", () => leaseLost);
              totalFragments++;
              if (seq === 0) seq0Succeeded = true;
              if (seq === 0 || (seq + 1) % 5 === 0 || seq === fragments.length - 1) {
                console.error(`    frag ${seq + 1}/${fragments.length} (${frag.type}) ${fragMs}ms [${text.length} chars]`);
              }
            } else {
              failedFragments++;
              console.error(`    frag ${seq + 1}/${fragments.length} (${frag.type}) → null result [${text.length} chars]`);
            }
          } catch (err) {
            if (err instanceof FatalVectorError) throw err; // dim/model/schema mismatch → abort the whole run
            failedFragments++;
            console.error(`${c.yellow}Warning: failed to embed fragment ${seq} (${frag.type}) of ${path}: ${err}${c.reset}`);
          }
        }
      }

      // Embed-state completion: mark synced ONLY when the WHOLE document succeeded (no
      // failed fragments) — a partial embed must not be silently permanent. Any failure
      // → 'failed' (state-only; attempts already incremented at markEmbedStart) so the
      // worklist retries it, bounded by embed_attempts < 3. Markers are lease-fenced and
      // busy-retried; a marker that STILL fails logs-and-continues — it must never kill
      // the run (the 2026-07-10 incident: markEmbedFailed's own SQLITE_BUSY crashed a
      // force rebuild at doc 344/4,995 with the index already cleared).
      const docFragsFail = failedFragments - prevFailedFragments;
      if (seq0Succeeded && docFragsFail === 0) {
        await markSafe("markEmbedSynced", () => s.markEmbedSynced(hash, leaseGuard));
      } else if (!seq0Succeeded) {
        await markSafe("markEmbedFailed", () => s.markEmbedFailed(hash, "primary fragment (seq=0) failed", leaseGuard));
      } else {
        await markSafe("markEmbedFailed", () => s.markEmbedFailed(hash, `${docFragsFail} fragment(s) failed`, leaseGuard));
      }

      embedded++;
      const docMs = evidenceMs(elapsed(docStart));
      const elapsedSec = (evidenceMs(elapsed(batchStart)) / 1000).toFixed(0);
      console.error(`  → doc done in ${(docMs / 1000).toFixed(1)}s | ${embedded}/${hashes.length} docs, ${totalFragments} frags, ${failedFragments} fails [${elapsedSec}s elapsed]`);
    }

    const totalSec = (evidenceMs(elapsed(batchStart)) / 1000).toFixed(1);
    console.log();
    console.log(`${c.green}Embedded ${embedded} documents (${totalFragments} fragments, ${failedFragments} failed) in ${totalSec}s${c.reset}`);

    // End-of-run verification — shared finalization (T9-H1 + T10-M1); see finalizeCanary.
    await finalizeCanary(failedFragments);
  } catch (err) {
    // Fatal aborts must NOT exit 0 — otherwise the embed timer / `update --embed`
    // cannot tell the run was incomplete. Set a nonzero exit code (cleanup still
    // runs in finally). Non-fatal errors propagate unchanged.
    if (err instanceof EmbedLeaseLostError) {
      // Checked before FatalVectorError because EmbedLeaseLostError extends it.
      console.error(`${c.red}Embed aborted: lost the embedding lease (another embed process took over). Re-run 'clawmem embed'.${c.reset}`);
      process.exitCode = 1;
    } else if (err instanceof FatalVectorError) {
      console.error(`${c.red}Embed aborted: ${(err as Error).message}${c.reset}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    clearInterval(heartbeat);
    releaseWorkerLease(s, LEASE_NAME, leaseToken);
    await disposeDefaultLlamaCpp();
  }
}

async function cmdStatus() {
  const s = getStore();
  const status = s.getStatus();

  console.log(`${c.bold}ClawMem Status${c.reset}`);
  console.log(`  Database:   ${s.dbPath}`);
  console.log(`  Documents:  ${status.totalDocuments}`);
  console.log(`  Unembedded: ${status.needsEmbedding}`);
  console.log(`  Vectors:    ${status.hasVectorIndex ? "yes" : "no"}`);
  console.log();

  if (status.collections.length > 0) {
    console.log(`${c.bold}Collections:${c.reset}`);
    for (const col of status.collections) {
      console.log(`  ${col.name}: ${col.documents} docs (${col.path})`);
    }
  }

  // SAME metadata stats
  const types = s.db.prepare(`
    SELECT content_type, COUNT(*) as cnt FROM documents WHERE active = 1 GROUP BY content_type ORDER BY cnt DESC
  `).all() as { content_type: string; cnt: number }[];

  if (types.length > 0) {
    console.log();
    console.log(`${c.bold}Content Types:${c.reset}`);
    for (const t of types) {
      console.log(`  ${t.content_type}: ${t.cnt}`);
    }
  }

  const sessions = s.db.prepare("SELECT COUNT(*) as cnt FROM session_log").get() as { cnt: number };
  if (sessions.cnt > 0) {
    console.log();
    console.log(`${c.bold}Sessions:${c.reset} ${sessions.cnt} tracked`);
  }

  // 62.1 D10: one line for the stop pipeline (doctor has the detail).
  try {
    const { stopPipelineHealth, stopHealthLine } = await import("./stop-health.ts");
    console.log();
    console.log(stopHealthLine(stopPipelineHealth(s.db)));
  } catch { /* status stays readable on a vault the check cannot read */ }
}

async function cmdList(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      num: { type: "string", short: "n", default: "10" },
      limit: { type: "string" }, // alias for --num (matches issue request)
      collection: { type: "string", short: "c" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const limit = parseInt(values.limit || values.num!, 10);
  if (isNaN(limit) || limit < 1) die("--num must be a positive integer");

  const s = getStore();
  const col = values.collection || null;

  const rows = s.db.prepare(`
    SELECT
      substr(hash, 1, 6) AS docid,
      title,
      collection,
      path,
      content_type,
      modified_at,
      confidence,
      access_count
    FROM documents
    WHERE active = 1
      AND invalidated_at IS NULL
      AND (? IS NULL OR collection = ?)
    ORDER BY COALESCE(modified_at, created_at) DESC, id DESC
    LIMIT ?
  `).all(col, col, limit) as {
    docid: string;
    title: string | null;
    collection: string;
    path: string;
    content_type: string | null;
    modified_at: string | null;
    confidence: number | null;
    access_count: number | null;
  }[];

  if (rows.length === 0) {
    console.log(col ? `No documents in collection "${col}".` : "No documents in vault.");
    return;
  }

  if (values.json) {
    console.log(JSON.stringify(rows.map(r => ({
      docid: r.docid,
      title: r.title || null,
      collection: r.collection,
      path: r.path,
      contentType: r.content_type || "note",
      modifiedAt: r.modified_at || null,
      confidence: r.confidence ?? 1.0,
      accessCount: r.access_count ?? 0,
    })), null, 2));
    return;
  }

  console.log(`${c.bold}Recent documents${col ? ` (${col})` : ""}:${c.reset}\n`);
  for (const r of rows) {
    const date = r.modified_at?.slice(0, 10) || "-";
    const type = r.content_type || "note";
    const raw = r.title || r.path;
    const title = raw.length > 60 ? raw.slice(0, 57) + "..." : raw;
    console.log(`  ${c.dim}${r.docid}${c.reset}  ${date}  ${c.dim}[${type}]${c.reset}  ${r.collection}  ${title}`);
  }
  console.log(`\n${rows.length} document${rows.length !== 1 ? "s" : ""} shown.`);
}

async function cmdSearch(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      num: { type: "string", short: "n", default: "10" },
      collection: { type: "string", short: "c" },
      json: { type: "boolean", default: false },
      "min-score": { type: "string", default: "0" },
    },
    allowPositionals: true,
  });

  const query = positionals.join(" ");
  if (!query) die("Usage: clawmem search <query>");

  const s = getStore();
  const limit = parseInt(values.num!, 10);
  const minScore = parseFloat(values["min-score"]!);

  const results = s.searchFTS(query, limit * 2);
  const enriched = enrichResults(s, results, query);
  const scored = applyCompositeScoring(enriched, query)
    .filter(r => r.compositeScore >= minScore)
    .slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify(scored.map(r => ({
      file: r.displayPath,
      title: r.title,
      score: r.compositeScore,
      searchScore: r.score,
      recencyScore: r.recencyScore,
      contentType: r.contentType,
    })), null, 2));
  } else {
    printResults(scored, query);
  }
}

async function cmdVsearch(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      num: { type: "string", short: "n", default: "10" },
      collection: { type: "string", short: "c" },
      json: { type: "boolean", default: false },
      "min-score": { type: "string", default: "0.3" },
    },
    allowPositionals: true,
  });

  const query = positionals.join(" ");
  if (!query) die("Usage: clawmem vsearch <query>");

  const s = getStore();
  const limit = parseInt(values.num!, 10);
  const minScore = parseFloat(values["min-score"]!);

  const results = await s.searchVec(query, DEFAULT_EMBED_MODEL, limit * 2);
  const enriched = enrichResults(s, results, query);
  const scored = applyCompositeScoring(enriched, query)
    .filter(r => r.compositeScore >= minScore)
    .slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify(scored.map(r => ({
      file: r.displayPath,
      title: r.title,
      score: r.compositeScore,
      searchScore: r.score,
      recencyScore: r.recencyScore,
      contentType: r.contentType,
    })), null, 2));
  } else {
    printResults(scored, query);
  }

  await disposeDefaultLlamaCpp();
}

async function cmdQuery(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      num: { type: "string", short: "n", default: "10" },
      collection: { type: "string", short: "c" },
      json: { type: "boolean", default: false },
      "min-score": { type: "string", default: "0" },
    },
    allowPositionals: true,
  });

  const query = positionals.join(" ");
  if (!query) die("Usage: clawmem query <query>");

  const s = getStore();
  const limit = parseInt(values.num!, 10);
  const minScore = parseFloat(values["min-score"]!);

  // Step 1: BM25 for strong signal check
  const ftsResults = s.searchFTS(query, 20);
  const strongSignal = ftsBypassEnabled() && hasStrongFtsSignal(ftsResults);

  // Step 2: Query expansion (skip if strong BM25 signal). expandQuery now returns
  // typed ExpandedQuery[] (lex/vec/hyde) — no more brittle string re-parsing, and
  // the original query is no longer echoed back as a phantom "vec" expansion.
  let expandedQueries: ExpandedQuery[] = [];
  if (!strongSignal) {
    try {
      expandedQueries = await s.expandQuery(query, DEFAULT_QUERY_MODEL);
    } catch {
      // Fallback: no expansion
    }
  }

  // Step 3: Parallel searches
  const allRanked: { results: RankedResult[]; weight: number }[] = [];
  // Retain the raw SearchResult from every leg (original + typed expansions) so a
  // candidate found ONLY via an expansion leg survives Step 8's resultMap lookup.
  const candidateResults: SearchResult[] = [];

  // Original query BM25 + vec (weight 2x)
  allRanked.push({ results: ftsResults.map(toRanked), weight: 2 });
  candidateResults.push(...ftsResults);
  const vecResults = await s.searchVec(query, DEFAULT_EMBED_MODEL, 20);
  allRanked.push({ results: vecResults.map(toRanked), weight: 2 });
  candidateResults.push(...vecResults);

  // Expanded queries (weight 1x): lex → FTS, vec/hyde → vector
  for (const eq of expandedQueries) {
    if (eq.type === "lex") {
      const r = s.searchFTS(eq.query, 20);
      allRanked.push({ results: r.map(toRanked), weight: 1 });
      candidateResults.push(...r);
    } else {
      const r = await s.searchVec(eq.query, DEFAULT_EMBED_MODEL, 20);
      allRanked.push({ results: r.map(toRanked), weight: 1 });
      candidateResults.push(...r);
    }
  }

  // Step 4: RRF fusion
  const rrfResults = reciprocalRankFusion(
    allRanked.map(a => a.results),
    allRanked.map(a => a.weight),
    60
  );

  // Step 5: Take top 30 for reranking
  const candidates = rrfResults.slice(0, 30);

  // Step 6: Rerank
  let reranked: { file: string; score: number }[] = [];
  try {
    const docs = candidates.map(r => ({ file: r.file, text: r.body.slice(0, 4000) }));
    reranked = await s.rerank(query, docs, DEFAULT_RERANK_MODEL);
  } catch {
    reranked = candidates.map(r => ({ file: r.file, score: r.score }));
  }

  // Step 7: Position-aware blending
  const rrfRankMap = new Map(candidates.map((r, i) => [r.file, i + 1]));
  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || candidates.length;
    let rrfWeight: number;
    if (rrfRank <= 3) rrfWeight = 0.75;
    else if (rrfRank <= 10) rrfWeight = 0.60;
    else rrfWeight = 0.40;

    const blendedScore = rrfWeight * (1 / rrfRank) + (1 - rrfWeight) * r.score;
    return { file: r.file, score: blendedScore };
  });
  blended.sort((a, b) => b.score - a.score);

  // Step 8: Map back to full results and apply composite scoring. Build the map from
  // ALL legs (incl. typed expansions) so expansion-only candidates aren't dropped.
  const resultMap = new Map(
    candidateResults.map(r => [r.filepath, r])
  );
  const fullResults = blended
    .map(b => resultMap.get(b.file))
    .filter((r): r is SearchResult => r !== undefined)
    .map(r => ({ ...r, score: blended.find(b => b.file === r.filepath)?.score ?? r.score }));

  const enriched = enrichResults(s, fullResults, query);
  const scored = applyCompositeScoring(enriched, query)
    .filter(r => r.compositeScore >= minScore)
    .slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify(scored.map(r => ({
      file: r.displayPath,
      title: r.title,
      score: r.compositeScore,
      searchScore: r.score,
      recencyScore: r.recencyScore,
      contentType: r.contentType,
    })), null, 2));
  } else {
    printResults(scored, query);
  }

  await disposeDefaultLlamaCpp();
}

function printResults(results: Array<{ displayPath: string; title: string; compositeScore: number; score: number; contentType: string; body?: string }>, query: string) {
  if (results.length === 0) {
    console.log(`${c.dim}No results found${c.reset}`);
    return;
  }

  for (const r of results) {
    const scoreBar = "█".repeat(Math.round(r.compositeScore * 10));
    const scoreStr = r.compositeScore.toFixed(2);
    const typeTag = r.contentType !== "note" ? ` ${c.magenta}[${r.contentType}]${c.reset}` : "";
    console.log(`${c.cyan}${scoreStr}${c.reset} ${c.dim}${scoreBar}${c.reset} ${c.bold}${r.title}${c.reset}${typeTag}`);
    console.log(`  ${c.dim}${r.displayPath}${c.reset}`);

    if (r.body) {
      const snippet = extractSnippet(r.body, query, 200);
      const lines = snippet.snippet.split("\n").slice(1, 4); // Skip header line
      for (const line of lines) {
        console.log(`  ${c.dim}${line.trim()}${c.reset}`);
      }
    }
    console.log();
  }
}

// =============================================================================
// Offline eval harness (HORMA-1)
// =============================================================================

async function cmdEval(args: string[]) {
  const usage = "Usage: clawmem eval run --gold <file.jsonl> [--profile query] [--limit N] [--min-examples N] [--audited] [--out <dir>] [--db <path>] [--json]\n" +
    "       clawmem eval hook-run --gold <hook-cases.jsonl> --db <snapshot> [--limit N] [--budget-ms N] [--min-examples N] [--audited] [--profile speed|balanced|deep] [--skill-db <snapshot>] [--baseline <hook-run.json>] [--capture-expansions <draw.json>|--replay-expansions <draw.json>] [--pair-with <run-dir> --pair-min-valid N [--pair-max-retries N] [--pair-require-ids a,b] [--pair-min-valid-stratum deep=8] [--pair-min-exposed-stratum deep=6] [--pair-min-basis-stratum speed:bm25-rrf=3] [--pair-treatment rerank_lane_weight|degeneracy_gate|admission_policy]] [--vector-exec daemon-required|in-process] [--vector-prewarm steady-state|cold] [--vector-daemon-ready-timeout-ms N] [--out <dir>] [--json]\n" +
    "       clawmem eval hook-aggregate --runs <run-dir1,run-dir2,...> [--out <dir>] [--json]   (replicated-distribution aggregate over frozen-draw member runs of ONE arm)";
  const sub = args[0];
  if (sub === "hook-run") { await cmdEvalHookRun(args.slice(1), usage); return; }
  if (sub === "hook-aggregate") { cmdEvalHookAggregate(args.slice(1), usage); return; }
  if (sub !== "run") die(usage);

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      gold: { type: "string" },
      profile: { type: "string", default: "query" },
      limit: { type: "string", default: "10" },
      "min-examples": { type: "string", default: "30" },
      audited: { type: "boolean", default: false },
      out: { type: "string" },
      db: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  if (!values.gold) die(usage);
  const profile = values.profile!;
  if (!(IMPLEMENTED_PROFILES as readonly string[]).includes(profile)) {
    die(`Profile "${profile}" is not implemented yet — the first build replays "query" only (intent/context/raw/structured are follow-on phases).`);
  }
  // Number() rejects trailing garbage ("10x" → NaN) and Number.isInteger
  // rejects fractions ("1.5") — parseInt would silently accept both.
  const limit = Number(values.limit);
  const minExamples = Number(values["min-examples"]);
  if (!Number.isInteger(limit) || limit < 1) die("--limit must be a positive integer");
  if (!Number.isInteger(minExamples) || minExamples < 1) die("--min-examples must be a positive integer");

  // Point BOTH the resolution store and the replay server at a snapshot DB
  // (e.g. a VACUUM INTO copy) for frozen runs. Must land before any store
  // opens — and must already exist as a file, or createStore would silently
  // create an EMPTY vault at the typo'd path and score everything 0.
  if (values.db) {
    const dbPath = pathResolve(values.db);
    if (!existsSync(dbPath) || !statSync(dbPath).isFile()) die(`--db snapshot not found (or not a file): ${dbPath}`);
    process.env.INDEX_PATH = dbPath;
  }

  const goldPath = pathResolve(values.gold);
  if (!existsSync(goldPath)) die(`Gold file not found: ${goldPath}`);

  const s = getStore();
  let result: RunEvalResult;
  try {
    result = await runEval({
      goldPath,
      profile: profile as EvalProfile,
      limit,
      minExamples,
      audited: values.audited,
      outDir: values.out ? pathResolve(values.out) : pathResolve(`eval-runs/${isoNow().replace(/[:.]/g, "-")}-${profile}`),
      store: s,
    });
  } catch (e) {
    if (e instanceof GoldFileError || e instanceof EvalIntegrityError) die(e.message);
    throw e;
  } finally {
    await disposeDefaultLlamaCpp();
  }

  const { report, artifacts } = result;
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const a = report.aggregate;
    const n = (v: number | null, d = 3) => (v === null ? "—" : v.toFixed(d));
    console.log(`${c.bold}eval run ${report.run_id}${c.reset} (profile ${report.profile}, k=${report.limit})`);
    console.log(`  examples: ${report.examples_scored} scored / ${report.examples_total} total` +
      (report.skipped.length ? ` · ${report.skipped.length} skipped` : "") +
      (report.unresolved_gold.length ? ` · ${c.red}${report.unresolved_gold.length} unresolved${c.reset}` : ""));
    console.log(`  J_doc ${c.cyan}${n(a.jaccard_mean)}${c.reset} · recall@k ${c.cyan}${n(a.recall_mean)}${c.reset} · precision@k ${n(a.precision_mean)} · hit@k ${n(a.hit_at_k)} · MRR ${c.cyan}${n(a.mrr)}${c.reset} · p95 ${n(a.elapsed_ms_p95, 0)}ms`);
    console.log(`  gates: ${report.gates.pass ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset} — ${report.gates.reasons.join("; ")}`}`);
    if (artifacts) {
      console.log(`  ${c.dim}wrote ${artifacts.runJsonPath}${c.reset}`);
      console.log(`  ${c.dim}wrote ${artifacts.reportMdPath}${c.reset}`);
    }
  }

  // A failed trust gate must be machine-visible, not just printed — automation
  // treating exit 0 as "trustworthy number" is exactly what the gate prevents.
  // exitCode (not exit()) so the dispatcher's finally/cleanup still runs.
  if (!report.gates.pass) process.exitCode = 1;
}

/**
 * `clawmem eval hook-aggregate` — replicated-distribution aggregate (BUILD-3d)
 * over n frozen-draw member runs of ONE arm. Pure read-and-combine: no store,
 * no snapshot, no env mutation — each member dir's hook-run.json is parsed
 * with the same validation a --baseline gets. Structural impossibilities
 * (non-frozen members, duplicate draws, identity mismatch, mixed protocols)
 * REFUSE; member trust/acceptance failures produce a FAILING aggregate with
 * the artifact still written (evidence preserved), exit 1.
 */
function cmdEvalHookAggregate(args: string[], usage: string) {
  const { values } = parseArgs({
    args,
    options: {
      runs: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.runs) die(usage);
  const dirs = values.runs.split(",").map(s => s.trim()).filter(Boolean).map(d => pathResolve(d));
  if (dirs.length < 2) die("--runs needs at least 2 member run directories (a replicated distribution is n >= 2 independent draws)");
  for (const d of dirs) {
    if (!existsSync(d) || !statSync(d).isDirectory()) die(`--runs entry is not a run directory: ${d}`);
    if (!existsSync(pathResolve(d, "hook-run.json"))) die(`--runs entry has no hook-run.json: ${d}`);
  }
  let agg: ReplicatedAggregate;
  try {
    agg = aggregateReplicatedRunDirs(dirs);
  } catch (e) {
    if (e instanceof HookEvalIntegrityError) die(e.message);
    throw e;
  }
  if (values.out) {
    const { jsonPath, mdPath } = writeReplicatedArtifacts(agg, pathResolve(values.out));
    if (!values.json) {
      console.log(`${c.dim}wrote ${jsonPath}${c.reset}`);
      console.log(`${c.dim}wrote ${mdPath}${c.reset}`);
    }
  }
  if (values.json) {
    console.log(JSON.stringify(agg, null, 2));
  } else {
    const g = agg.gates;
    console.log(`${c.bold}replicated aggregate${c.reset} — ${agg.n} draws (${agg.identity.ranking_policy!.expansion_set})`);
    for (const m of agg.members) {
      console.log(`  ${m.run_id} draw ${m.draw}: trust ${m.trust_pass ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`} · acceptance ${m.acceptance_mode ?? "—"}${m.pair_valid !== null ? ` · pair ${m.pair_valid} valid / ${m.pair_treatment_exposed} exposed` : ""}`);
    }
    console.log(`  gates: ${g.pass ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`}${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}`);
  }
  // A failing distributional aggregate must be machine-visible, same contract
  // as the run-level gate.
  if (!agg.gates.pass) process.exitCode = 1;
}

/**
 * `clawmem eval hook-run` — replay labeled UserPromptSubmit cases through the
 * REAL context-surfacing handler against a corpus snapshot (BUILD-0). The
 * snapshot is REQUIRED: the hook writes telemetry during replay (cleaned up
 * per case, but a crash mid-case must never leave residue in the live vault,
 * and a live watcher would race the run). Make one with:
 *   sqlite3 ~/.cache/clawmem/index.sqlite "VACUUM INTO 'snapshot.sqlite'"
 */
async function cmdEvalHookRun(args: string[], usage: string) {
  const { values } = parseArgs({
    args,
    options: {
      gold: { type: "string" },
      db: { type: "string" },
      limit: { type: "string", default: "10" },
      "budget-ms": { type: "string", default: "8000" },
      "min-examples": { type: "string", default: "30" },
      audited: { type: "boolean", default: false },
      profile: { type: "string" },
      "skill-db": { type: "string" },
      baseline: { type: "string" },
      "latency-reps": { type: "string", default: "3" },
      "accept-unmeasured": { type: "string" },
      "allow-local-fallback": { type: "boolean", default: false },
      "capture-expansions": { type: "string" },
      "replay-expansions": { type: "string" },
      "pair-with": { type: "string" },
      "pair-min-valid": { type: "string" },
      "pair-max-retries": { type: "string", default: "2" },
      "pair-require-ids": { type: "string" },
      "pair-min-valid-stratum": { type: "string" },
      "pair-min-exposed-stratum": { type: "string" },
      "pair-min-basis-stratum": { type: "string" },
      "pair-treatment": { type: "string" },
      // Codex t76 (daemon-backed eval): the vector execution protocol. The
      // DEFAULT is the production protocol — a dedicated vector-daemon child
      // on the working copy with the watcher's steady-state prewarm; the
      // in-process protocol is an explicit, recorded opt-out whose latency
      // evidence is never authoritative on vector-exercising profiles.
      "vector-exec": { type: "string", default: "daemon-required" },
      "vector-prewarm": { type: "string", default: "steady-state" },
      "vector-daemon-ready-timeout-ms": { type: "string", default: "120000" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  if (!values.gold || !values.db) die(usage);
  if (values["vector-exec"] !== "daemon-required" && values["vector-exec"] !== "in-process") die("--vector-exec must be daemon-required (default; the production protocol) or in-process (recorded; latency not authoritative on balanced/deep)");
  if (values["vector-prewarm"] !== "steady-state" && values["vector-prewarm"] !== "cold") die("--vector-prewarm must be steady-state (default; the watcher topology's periodic prewarm, performed before readiness) or cold");
  const vectorDaemonReadyTimeoutMs = Number(values["vector-daemon-ready-timeout-ms"]);
  if (!Number.isInteger(vectorDaemonReadyTimeoutMs) || vectorDaemonReadyTimeoutMs < 1) die("--vector-daemon-ready-timeout-ms must be a positive integer");
  const vectorExec: VectorExecSpec = values["vector-exec"] === "in-process"
    ? { protocol: "in-process" }
    : { protocol: "daemon-required", prewarm: values["vector-prewarm"] as "steady-state" | "cold", readyTimeoutMs: vectorDaemonReadyTimeoutMs };
  const limit = Number(values.limit);
  const budgetMs = Number(values["budget-ms"]);
  const minExamples = Number(values["min-examples"]);
  const latencyReps = Number(values["latency-reps"]);
  if (!Number.isInteger(limit) || limit < 1) die("--limit must be a positive integer");
  if (!Number.isInteger(budgetMs) || budgetMs < 1) die("--budget-ms must be a positive integer");
  if (!Number.isInteger(minExamples) || minExamples < 1) die("--min-examples must be a positive integer");
  if (!Number.isInteger(latencyReps) || latencyReps < 1) die("--latency-reps must be a positive integer");
  if (values.profile !== undefined && !["speed", "balanced", "deep"].includes(values.profile)) {
    die("--profile must be speed, balanced, or deep");
  }
  const acceptUnmeasured = values["accept-unmeasured"]
    ? values["accept-unmeasured"].split(",").map(s => s.trim()).filter(Boolean)
    : undefined;
  if (acceptUnmeasured) {
    const { WAIVABLE_ACCEPTANCE_AXES } = await import("./eval/hook-run.ts");
    const bad = acceptUnmeasured.filter(a => !WAIVABLE_ACCEPTANCE_AXES.has(a));
    if (bad.length > 0) {
      die(`--accept-unmeasured: not waivable: ${bad.join(", ")} (core relevance/damage axes cannot be waived; waivable: ${[...WAIVABLE_ACCEPTANCE_AXES].join(", ")})`);
    }
  }

  const dbPath = pathResolve(values.db);
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) die(`--db snapshot not found (or not a file): ${dbPath}`);
  let skillDbPath: string | undefined;
  if (values["skill-db"]) {
    skillDbPath = pathResolve(values["skill-db"]);
    if (!existsSync(skillDbPath) || !statSync(skillDbPath).isFile()) die(`--skill-db snapshot not found (or not a file): ${skillDbPath}`);
  }
  let baselinePath: string | undefined;
  if (values.baseline) {
    baselinePath = pathResolve(values.baseline);
    if (!existsSync(baselinePath)) die(`--baseline run report not found: ${baselinePath}`);
  }

  const goldPath = pathResolve(values.gold);
  if (!existsSync(goldPath)) die(`Hook gold file not found: ${goldPath}`);

  // Paired-counterfactual draw plumbing (codex turn-17 finding 2): the
  // generator arm --capture-expansions writes its llm_cache delta as a draw
  // file; the replay arm --replay-expansions injects that exact draw so both
  // arms rank identical expansion inputs (identity records draw:<fp>).
  if (values["capture-expansions"] && values["replay-expansions"]) {
    die("--capture-expansions and --replay-expansions are mutually exclusive — an arm either generates a draw or replays one");
  }
  let expansionFreeze: { fingerprint: string; rows: { hash: string; result: string }[]; binding: { gold_fingerprint: string; corpus: string | null; query_model: string; rerank_model: string; rerank_request_rev: number; served_rerank: string; transmitted_text_manifest: string } } | undefined;
  if (values["replay-expansions"]) {
    const drawPath = pathResolve(values["replay-expansions"]);
    if (!existsSync(drawPath)) die(`--replay-expansions draw file not found: ${drawPath}`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(drawPath, "utf-8")); } catch (e) { die(`--replay-expansions is not readable JSON: ${(e as Error).message}`); }
    const d = parsed as { fingerprint?: unknown; rows?: unknown; binding?: unknown };
    const b = d.binding as Record<string, unknown> | undefined;
    if (typeof d.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(d.fingerprint)
      || !Array.isArray(d.rows)
      || !d.rows.every(r => r && typeof r === "object" && typeof (r as Record<string, unknown>).hash === "string" && typeof (r as Record<string, unknown>).result === "string")
      || !b || typeof b !== "object" || Array.isArray(b)
      || typeof b.gold_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(b.gold_fingerprint)
      || (b.corpus !== null && typeof b.corpus !== "string")
      || typeof b.query_model !== "string" || typeof b.rerank_model !== "string"
      || typeof b.rerank_request_rev !== "number" || !Number.isInteger(b.rerank_request_rev) || b.rerank_request_rev < 1
      // BUILD-3b binding v3 — a draw predating either field cannot be
      // validated against this run's provider or transmitted texts.
      || typeof b.served_rerank !== "string" || b.served_rerank.length === 0
      || typeof b.transmitted_text_manifest !== "string" || !/^[0-9a-f]{64}$/.test(b.transmitted_text_manifest)) {
      die(`--replay-expansions draw file is malformed (expected { fingerprint: hex16, rows: [{ hash, result }], binding: { gold_fingerprint, corpus, query_model, rerank_model, rerank_request_rev, served_rerank, transmitted_text_manifest } }) — a draw file predating the binding (codex turn-18 finding 2), the request-revision pin (codex turn-19 finding 2), or the BUILD-3b cache-identity contract (served-provider fingerprint + transmitted-text manifest) must be RE-CAPTURED with --capture-expansions on this build`);
    }
    if ((d.rows as unknown[]).length === 0) die(`--replay-expansions draw file carries zero rows — capture it from a run whose profiles exercise expansion (deep)`);
    expansionFreeze = d as typeof expansionFreeze;
  }

  // BUILD-3c in-run pair gate: audit this run's per-case pre-treatment
  // envelope against a partner run, reject + replace divergent cases, and
  // compute acceptance over VALID pairs only.
  let pairWith: string | undefined;
  let pairMinValid: number | undefined;
  let pairMaxRetries: number | undefined;
  let pairRequireIds: string[] | undefined;
  let pairMinValidByStratum: Record<string, number> | undefined;
  let pairMinExposedByStratum: Record<string, number> | undefined;
  let pairMinBasisByStratum: Record<string, number> | undefined;
  let pairTreatments: PairTreatment[] | undefined;
  if (values["pair-with"]) {
    pairWith = pathResolve(values["pair-with"]);
    if (!existsSync(pairWith) || !statSync(pairWith).isDirectory()) die(`--pair-with must be a completed run DIRECTORY (containing hook-run.json + traces.jsonl): ${pairWith}`);
    if (values["pair-min-valid"] === undefined) die("--pair-with requires --pair-min-valid (the PRE-REGISTERED valid-pair count) — a threshold chosen after seeing the audit is not a gate");
    pairMinValid = Number(values["pair-min-valid"]);
    if (!Number.isInteger(pairMinValid) || pairMinValid < 1) die("--pair-min-valid must be a positive integer");
    pairMaxRetries = Number(values["pair-max-retries"]);
    if (!Number.isInteger(pairMaxRetries) || pairMaxRetries < 0) die("--pair-max-retries must be a non-negative integer");
    // Pre-registered witnesses + per-stratum minimums (codex turn-29 SPEC-5):
    // a total-count gate alone can be satisfied after discarding every
    // treatment-bearing case.
    if (values["pair-require-ids"]) {
      pairRequireIds = values["pair-require-ids"].split(",").map(x => x.trim()).filter(Boolean);
      if (pairRequireIds.length === 0) die("--pair-require-ids was given but names no case ids");
    }
    const parseStrata = (flag: string, raw: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const pair of raw.split(",").map(x => x.trim()).filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq < 1) die(`${flag} expects comma-separated <stratum>=<n> pairs (e.g. deep=8,holdout=6); got "${pair}"`);
        const key = pair.slice(0, eq).trim();
        const n = Number(pair.slice(eq + 1).trim());
        if (!key || !Number.isInteger(n) || n < 1) die(`${flag} entry "${pair}" must be <stratum>=<positive integer>`);
        out[key] = n;
      }
      return out;
    };
    if (values["pair-min-valid-stratum"]) pairMinValidByStratum = parseStrata("--pair-min-valid-stratum", values["pair-min-valid-stratum"]);
    if (values["pair-min-exposed-stratum"]) pairMinExposedByStratum = parseStrata("--pair-min-exposed-stratum", values["pair-min-exposed-stratum"]);
    // Pre-registered per-stratum ADMISSION-BASIS coverage minima (codex t68
    // F3): counts VALID pairs whose candidate-arm case was judged on the
    // named basis — the machine-decisive form of the R4 "missing BM25
    // topology" requirement. Grammar: <stratum>:<basis>=<n>,...
    if (values["pair-min-basis-stratum"]) {
      const BASES = ["bm25-rrf", "weighted-rrf", "rerank-fused-rrf"];
      const out: Record<string, number> = {};
      for (const entry of values["pair-min-basis-stratum"].split(",").map(x => x.trim()).filter(Boolean)) {
        const eq = entry.indexOf("=");
        const colon = entry.indexOf(":");
        if (colon < 1 || eq < colon + 2) die(`--pair-min-basis-stratum expects comma-separated <stratum>:<basis>=<n> entries (e.g. speed:bm25-rrf=3,deep:rerank-fused-rrf=2); got "${entry}"`);
        const stratum = entry.slice(0, colon).trim();
        const basis = entry.slice(colon + 1, eq).trim();
        const n = Number(entry.slice(eq + 1).trim());
        if (!BASES.includes(basis)) die(`--pair-min-basis-stratum entry "${entry}" names "${basis}", which is not an admission basis (${BASES.join(", ")})`);
        if (!stratum || !Number.isInteger(n) || n < 1) die(`--pair-min-basis-stratum entry "${entry}" must be <stratum>:<basis>=<positive integer>`);
        const basisKey = `${stratum}:${basis}`;
        if (out[basisKey] !== undefined) die(`--pair-min-basis-stratum contains duplicate entry for "${basisKey}" — register each stratum:basis minimum once`);
        out[basisKey] = n;
      }
      if (Object.keys(out).length === 0) die("--pair-min-basis-stratum was given but names no entries");
      pairMinBasisByStratum = out;
    }
    // The REGISTERED treatments of the experiment (codex turn-40 finding 2):
    // exactly these ranking_policy variables may differ from the partner, and
    // paired acceptance permits exactly this difference. Omitted = the arms
    // must be policy-identical (a replicate audit).
    if (values["pair-treatment"]) {
      const names = values["pair-treatment"].split(",").map(x => x.trim()).filter(Boolean);
      if (names.length === 0) die("--pair-treatment was given but names no treatment");
      for (const n of names) {
        if (!(PAIR_TREATMENTS as readonly string[]).includes(n)) die(`--pair-treatment "${n}" is not a registrable treatment (${PAIR_TREATMENTS.join(", ")})`);
      }
      if (new Set(names).size !== names.length) die("--pair-treatment contains duplicates — register each treatment once");
      pairTreatments = names as PairTreatment[];
    }
  } else if (values["pair-min-valid"] !== undefined || values["pair-require-ids"] !== undefined || values["pair-min-valid-stratum"] !== undefined || values["pair-min-exposed-stratum"] !== undefined || values["pair-min-basis-stratum"] !== undefined || values["pair-treatment"] !== undefined) {
    die("--pair-min-valid / --pair-require-ids / --pair-min-valid-stratum / --pair-min-basis-stratum / --pair-treatment require --pair-with — there is no partner run to audit against");
  }

  // ALL run state — the mkdtemp working directory, the env mutations
  // (INDEX_PATH, CLAWMEM_NO_LOCAL_MODELS), the store, the inference handles
  // — is created inside ONE outer try/finally, and expected failures
  // (malformed gold/baseline — the NORMAL failure path) defer their exit
  // until after the finally has cleaned up. die() process.exit()s past
  // finally blocks, so calling it from inside the try leaked the working
  // dir, the env, and the handles (codex turn-11 finding 1); the deferred
  // path uses process.exitCode so main()'s own finally (closeStore) still
  // runs.
  const priorNoLocal = process.env.CLAWMEM_NO_LOCAL_MODELS;
  const priorIndexPath = process.env.INDEX_PATH;
  let workDir: string | undefined;
  let result: RunHookEvalResult | undefined;
  let deferredDie: string | undefined;
  try {
    // The replay writes telemetry during each case (cleaned up, but a crash
    // mid-case must never leave residue in the operator's snapshot). The run
    // therefore opens INTERNALLY-CREATED working copies only; the given
    // snapshots are read once by cp and never opened.
    workDir = mkdtempSync(pathResolve(tmpdir(), "clawmem-hook-eval-"));
    const workDb = pathResolve(workDir, "work.sqlite");
    cpSync(dbPath, workDb);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) cpSync(dbPath + suffix, workDb + suffix);
    }
    let workSkillDb: string | undefined;
    if (skillDbPath) {
      workSkillDb = pathResolve(workDir, "work-skill.sqlite");
      cpSync(skillDbPath, workSkillDb);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(skillDbPath + suffix)) cpSync(skillDbPath + suffix, workSkillDb + suffix);
      }
    }
    process.env.INDEX_PATH = workDb;
    console.error(`${c.dim}working copy: ${workDb} (snapshot ${dbPath} is never opened)${c.reset}`);

    // Corpus identity = CONTENT hash of the WORKING COPIES — the bytes the
    // replay actually executes. Hashing the originals after copying left a
    // TOCTOU window where a mutated source recorded a hash the run never ran
    // (codex turn-9 finding 3); the hash uses length framing per file
    // (hashCorpusFiles). The stamp tool hashes the attested snapshot with the
    // same helper — byte-identical content yields the same digest.
    const { hashCorpusFiles, probeServedModel, probeRerankFingerprint } = await import("./eval/hook-run.ts");
    const corpusHash = await hashCorpusFiles([
      workDb,
      existsSync(workDb + "-wal") ? workDb + "-wal" : undefined,
      workSkillDb,
      workSkillDb && existsSync(workSkillDb + "-wal") ? workSkillDb + "-wal" : undefined,
    ]);

    // Served-model probes: /v1/models for the OpenAI-compatible embed/llm
    // endpoints; a BEHAVIORAL fingerprint (fixed probe pair → score hash) for
    // the rerank endpoint, whose seq-cls sidecar exposes no model listing.
    // Tri-state per service: value · "unreachable" · "unknown" — an "unknown"
    // on an exercised service fails comparability unless attested.
    const servedModels = {
      embed: await probeServedModel(process.env.CLAWMEM_EMBED_URL),
      llm: await probeServedModel(process.env.CLAWMEM_LLM_URL),
      rerank: await probeRerankFingerprint(process.env.CLAWMEM_RERANK_URL),
    };

    // Eval runs execute a UNIFORM remote-only policy: with local fallback
    // allowed, an unreachable endpoint silently swaps in an unidentified
    // in-process model and two "unreachable" runs can execute different
    // pipelines while comparing equal (codex turn-10 finding 3). Forced
    // UNCONDITIONALLY — the ambient env is launcher-defaulted, not an invoker
    // decision — with --allow-local-fallback as the explicit opt-out; the
    // identity records whichever policy was effective either way.
    process.env.CLAWMEM_NO_LOCAL_MODELS = values["allow-local-fallback"] ? "false" : "true";

    const s = getStore();
    result = await runHookEval({
      goldPath,
      store: s,
      limit,
      budgetMs,
      minExamples,
      audited: values.audited,
      profileOverride: values.profile as "speed" | "balanced" | "deep" | undefined,
      skillVaultDb: workSkillDb,
      baselinePath,
      corpusHash,
      corpusLabel: `${dbPath} (${statSync(dbPath).size} bytes)`,
      servedModels,
      latencyReps,
      acceptUnmeasured,
      expansionCapture: values["capture-expansions"] !== undefined,
      expansionFreeze,
      pairWith,
      pairMinValid,
      pairMaxRetries,
      pairRequireIds,
      pairMinValidByStratum,
      pairMinExposedByStratum,
      pairMinBasisByStratum,
      pairTreatments,
      vectorExec,
      outDir: values.out ? pathResolve(values.out) : pathResolve(`eval-runs/${isoNow().replace(/[:.]/g, "-")}-hook`),
    });
  } catch (e) {
    if (e instanceof HookGoldFileError || e instanceof HookEvalIntegrityError) deferredDie = e.message;
    else throw e;
  } finally {
    if (priorNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = priorNoLocal;
    if (priorIndexPath === undefined) delete process.env.INDEX_PATH;
    else process.env.INDEX_PATH = priorIndexPath;
    await disposeDefaultLlamaCpp();
    if (workDir) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
    }
  }
  if (deferredDie !== undefined) {
    console.error(`${c.red}Error:${c.reset} ${deferredDie}`);
    process.exitCode = 1;
    return;
  }
  if (!result) throw new Error("unreachable: hook eval produced no result and no error");

  const { report, artifacts } = result;
  if (values["capture-expansions"]) {
    const drawOut = pathResolve(values["capture-expansions"]);
    writeFileSync(drawOut, JSON.stringify(result.expansionDraw ?? { fingerprint: "", rows: [] }, null, 2));
    const draw = result.expansionDraw;
    if (!draw || draw.rows.length === 0) {
      console.error(`${c.yellow}captured expansion draw is EMPTY${c.reset} (no llm_cache writes — did the profiles exercise expansion?) → ${drawOut}`);
    } else {
      console.error(`${c.dim}captured expansion draw ${draw.fingerprint} (${draw.rows.length} rows) → ${drawOut}${c.reset}`);
    }
  }
  if (expansionFreeze) {
    console.error(`${c.dim}replayed frozen expansion draw ${expansionFreeze.fingerprint} (${expansionFreeze.rows.length} rows; leak audit passed)${c.reset}`);
  }
  if (report.pair_audit) {
    const pa = report.pair_audit;
    console.error(`${c.dim}pair gate vs ${pa.partner_run_id}: ${pa.valid} valid / ${pa.invalid} invalid (min ${pa.min_valid}, ${pa.retried} retry attempt(s)) — reported aggregates cover VALID PAIRS ONLY${c.reset}`);
    for (const ic of pa.invalid_cases) console.error(`${c.dim}  excluded ${ic.id}: ${ic.divergences.slice(0, 2).join(" | ")}${c.reset}`);
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const a = report.aggregate;
    const n = (v: number | null, d = 3) => (v === null ? "—" : v.toFixed(d));
    console.log(`${c.bold}eval hook-run ${report.run_id}${c.reset} (k=${report.limit}, budget ${report.budget_ms}ms, secondary ${report.secondary_vaults})`);
    console.log(`  cases: ${report.examples_scored} scored / ${report.examples_total} total` +
      (report.unresolved_labels.length ? ` · ${c.red}${report.unresolved_labels.length} unresolved${c.reset}` : ""));
    console.log(`  nDCG ${c.cyan}${n(a.ndcgMean)}${c.reset} · must-not(case) ${c.cyan}${n(a.mustNotCaseRate)}${c.reset} · must-recall ${n(a.mustIncludeRecallMean)} · abst ${n(a.abstentionAccuracy)} · prior-leg ${n(a.priorLegAccuracy)} · p95 ${n(a.latencyP95Ms, 0)}ms · timeouts ${n(a.timeoutRate)}`);
    for (const [split, agg] of Object.entries(report.by_split)) {
      console.log(`  [${split}] nDCG ${n(agg.ndcgMean)} · must-not(case) ${n(agg.mustNotCaseRate)} · must-recall ${n(agg.mustIncludeRecallMean)} (${agg.cases} cases)`);
    }
    console.log(`  invariants: ${report.enforced_invariant_violations === 0 ? `${c.green}0 enforced${c.reset}` : `${c.red}${report.enforced_invariant_violations} enforced${c.reset}`} · ${report.observed_invariant_violations} observed (unenforced)`);
    const g = report.gates;
    const acceptanceLabel = g.acceptance_pass === null
      ? `${c.yellow}NOT EVALUATED${c.reset} (no --baseline; NOT product acceptance)`
      : g.acceptance_pass
        ? (g.acceptance_waived.length > 0
          ? `${c.yellow}CONDITIONAL PASS${c.reset} (waived: ${g.acceptance_waived.join(", ")} — NOT unconditional product acceptance)`
          : `${c.green}PASS${c.reset}`)
        : `${c.red}FAIL${c.reset}`;
    console.log(`  gates: trust ${g.trust_pass ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`} · acceptance ${acceptanceLabel}${g.reasons.length ? ` — ${g.reasons.join("; ")}` : ""}`);
    if (artifacts) {
      console.log(`  ${c.dim}wrote ${artifacts.runJsonPath}${c.reset}`);
      console.log(`  ${c.dim}wrote ${artifacts.reportMdPath}${c.reset}`);
      console.log(`  ${c.dim}wrote ${artifacts.tracesPath}${c.reset}`);
    }
  }

  // Exit reflects the gate the invocation ASKED for: with --baseline, the
  // acceptance verdict (a CONDITIONAL pass exits 0 — the waiver was this
  // invocation's own explicit --accept-unmeasured instruction — while
  // gates.pass stays false so machine consumers never read it as
  // unconditional product acceptance); without, the trust gate. The JSON's
  // acceptance_pass: null / acceptance_waived fields carry the distinction.
  const requiredPass = baselinePath
    ? report.gates.trust_pass && report.gates.acceptance_pass === true
    : report.gates.trust_pass;
  if (!requiredPass) process.exitCode = 1;
}

// =============================================================================
// Hook dispatch
// =============================================================================

// B3: the context-surfacing UserPromptSubmit hook runs under a tight budget
// (8s repo default). Its OWN writes — dedup UPSERT, context_usage, recall
// events, co-activations — are all best-effort/fail-open, but under writer
// contention each could otherwise wait up to the store default busy_timeout
// (5000ms) and blow the budget. Cap this process's busy_timeout so a contended
// write fails fast (SQLITE_BUSY → skipped by the fail-open guards) instead of
// stalling. Reads are unaffected (WAL readers never wait on the write lock).
const CONTEXT_SURFACING_WRITE_BUSY_TIMEOUT_MS = 1500;

async function cmdHook(args: string[]) {
  const hookName = args[0];
  if (!hookName) die("Usage: clawmem hook <name>");

  // v0.29.0 judge recursion guard: a claude-cli judge spawn sets this marker in the
  // child env. A nested session's ClawMem hooks must no-op BEFORE stdin is read or
  // the store is opened — otherwise a judge call inside a Stop hook could recurse
  // into another judge spawn. Central here so EVERY hook is covered.
  if (process.env.CLAWMEM_JUDGE_SPAWN === "1") {
    console.error(`[clawmem] hook ${hookName} skipped: running inside a judge spawn (CLAWMEM_JUDGE_SPAWN=1)`);
    writeHookOutput(makeEmptyOutput(hookName));
    return;
  }

  // O1 §2 (codex rev-8 F4) + codex migration r1 P1: refuse the context-surfacing RUN under an
  // unsupported budget BEFORE stdin is read or the store is opened — one clear stderr line and an
  // empty (fail-open) output, and no observable work under an unsupported budget. The tooling that
  // explains the value (`doctor`, `setup hooks`) never throws. The handler asserts the same
  // contract itself at its own entry, so there is no path to a budget that skips this check.
  if (hookName === "context-surfacing") {
    try {
      assertHookBudgetConfig();
    } catch (e) {
      console.error(`[clawmem] context-surfacing refused: ${(e as Error).message}`);
      writeHookOutput(makeEmptyOutput(hookName));
      return;
    }
  }

  const input = await readHookInput();
  // 62.1 D5: the SessionEnd handoff flush renders only, inside Claude Code's 1.5 s cap — its deadline starts here,
  // before the vault is opened, and the open waits at most 250 ms on a busy vault.
  const sessionEnd = hookName === "handoff-generator" && input.hookEventName === "SessionEnd";
  const sessionEndDeadline = sessionEnd ? deadlineAfter(monoNow(), duration(SESSION_END_DEADLINE_MS)) : undefined;
  // 62.2: PreCompact registers its attempt beside the vault BEFORE the vault is opened, so a contended
  // or failing open (or the host's timeout) cannot leave an earlier compaction's state takeable.
  let compactionAttempt: string | null | undefined;
  if (hookName === "precompact-extract") {
    try { compactionAttempt = registerCompaction({ dbPath: getDefaultDbPath() }, input.sessionId); } catch { compactionAttempt = null; }
  }
  // Open the store capped from the START for the context-surfacing hook (not just after open via the
  // PRAGMA below) so a contended init cannot wait the full 5000ms default before it is narrowed. Other
  // hooks (Stop-lane, 30s budget) keep the 5000ms default.
  // 62.2: the two compaction hooks run under a 5 s host timeout, so their busy wait is capped at 2 s:
  // a contended vault fails them closed (nothing stored, nothing injected) instead of timing out.
  let s: Store;
  try {
    s = getStore(
      hookName === "context-surfacing" ? CONTEXT_SURFACING_WRITE_BUSY_TIMEOUT_MS
        : hookName === "precompact-extract" || hookName === "postcompact-inject" ? 2000
        : sessionEnd ? SESSION_END_BUSY_TIMEOUT_MS
        : 5000,
    );
  } catch (err) {
    // A vault that cannot be opened (busy past the wait, or the 62.2 evolution-writer fence failing closed
    // on the first upgraded open) fails the hook open: one stderr line and the empty output. A PreCompact
    // has registered already, so nothing older can be injected.
    console.error(`[clawmem] hook ${hookName}: the vault could not be opened (${err instanceof Error ? err.message : String(err)})`);
    writeHookOutput(makeEmptyOutput(hookName));
    return;
  }
  let output: HookOutput;

  try {
    switch (hookName) {
      case "context-surfacing": {
        // (Budget refused above, before stdin and the store — codex migration r1 P1.)
        // Scope the small busy_timeout to THIS process only. Each `clawmem
        // hook` invocation runs exactly one hook, so the Stop hooks
        // (decision-extractor / handoff-generator / feedback-loop, 30s budget)
        // run in separate processes and keep the store default (5000ms).
        try { s.db.exec(`PRAGMA busy_timeout = ${CONTEXT_SURFACING_WRITE_BUSY_TIMEOUT_MS}`); } catch { /* non-fatal */ }
        output = await contextSurfacing(s, input);
        break;
      }
      case "session-bootstrap":
        output = await sessionBootstrap(s, input);
        break;
      case "decision-extractor":
        output = await decisionExtractor(s, input);
        break;
      case "handoff-generator":
        output = await handoffGenerator(s, input, { sessionEndDeadline });
        break;
      case "feedback-loop":
        output = await feedbackLoop(s, input);
        break;
      case "staleness-check":
        output = await stalenessCheck(s, input);
        break;
      case "precompact-extract":
        output = await precompactExtract(s, input, { attempt: compactionAttempt });
        break;
      case "postcompact-inject":
        output = await postcompactInject(s, input);
        break;
      case "pretool-inject":
        output = await pretoolInject(s, input);
        break;
      case "curator-nudge":
        output = await curatorNudge(s, input);
        break;
      default:
        die(`Unknown hook: ${hookName}. Available: context-surfacing, session-bootstrap, decision-extractor, handoff-generator, feedback-loop, staleness-check, precompact-extract, postcompact-inject, pretool-inject, curator-nudge`);
        output = makeEmptyOutput(); // unreachable, satisfies TS
    }
  } catch (err) {
    // Hooks must never crash — silent fallback
    console.error(`Hook ${hookName} error: ${err}`);
    output = makeEmptyOutput(hookName);
  }

  writeHookOutput(output);

  // BUILD-5 t60/t61/t63 (codex F59-1 + F60-4 + F62-3): the surfacing
  // bookkeeping handoff. The hook output is ALREADY on stdout — the hook
  // process performs NO post-stdout fs or SQLite work at all. The job is
  // handed over a pipe to a detached, unref'd `spool-ingest` child, and
  // THAT child persists it to the spool and drains. The handoff makes NO
  // kernel pipe-capacity assumption (t63): write() lands in the FileSink's
  // user-space buffer, and the flush (end()) is RACED against a hard
  // 250ms timeout — on any host, under any pipe limit, the parent moves on
  // within the bound. A spool-fs or DB stall blocks the child, never this
  // process's output or exit. Durability, stated honestly: the job dies
  // with the child if the child is killed before its spool write lands,
  // and an unflushed tail can be dropped at parent exit on a pathological
  // pipe (learning signal only — the alignment row was committed
  // in-handler or the turn was failed closed).
  if (hookName === "context-surfacing") {
    try {
      const job = consumePendingSurfacingBookkeeping();
      // t62 (codex F61-3): the nonblocking-pipe claim is only true when the
      // payload is bounded — serialize through the capped helper, and DROP
      // an oversized or inadmissible job (fail-open: optional learning
      // data) instead of ever writing an unbounded blob into the pipe.
      const raw = job && s.dbPath && s.dbPath !== ":memory:" ? serializeSurfacingBookkeepingJob(job) : null;
      if (raw !== null) {
        const child = Bun.spawn({
          cmd: [process.execPath, process.argv[1]!, "spool-ingest"],
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
          env: { ...process.env },
        });
        child.stdin.write(raw);
        // t64 (codex F63-2): the race must not LEAK its loser. end() is
        // called unconditionally (the child needs EOF); when the flush has
        // not settled within the bound, the pending sink operation is
        // unref'd and the child is dropped outright — a half-delivered
        // handoff is worthless (the ingest child would refuse a truncated
        // payload anyway) and an unresolved sink op must never retain this
        // process. CLAWMEM_TEST_HANDOFF_END_DELAY_MS is a test seam that
        // delays only the RACE's view of the flush, forcing the loser
        // branch deterministically.
        const endDelayMs = Number(process.env.CLAWMEM_TEST_HANDOFF_END_DELAY_MS ?? "0");
        let endP: Promise<unknown> = Promise.resolve(child.stdin.end()).catch(() => {});
        if (endDelayMs > 0) endP = endP.then(() => Bun.sleep(endDelayMs));
        const flushed = await Promise.race([endP.then(() => true), Bun.sleep(250).then(() => false)]);
        if (!flushed) {
          try { (child.stdin as unknown as { unref?: () => void }).unref?.(); } catch { /* best-effort */ }
          try { child.kill(); } catch { /* already gone */ }
        }
        child.unref();
      }
    } catch { /* bookkeeping handoff is fail-open */ }
  }
}

// =============================================================================
// Spool drain (internal): apply surfacing bookkeeping off the hook lifetime
// =============================================================================

/**
 * BUILD-5 t60 (codex F59-1): drain the surfacing-bookkeeping spool for the
 * default store. Spawned detached by cmdHook after each injected surfacing
 * turn; safe to run any time (claim-by-rename makes concurrent drainers
 * non-duplicating, and an empty spool is a no-op). Uses the operational
 * busy_timeout — a stall here blocks only this drainer process.
 */
async function cmdSpoolDrain() {
  const s = getStore();
  const r = drainSurfacingBookkeepingSpool(s);
  if (r.applied || r.discarded || r.retained) {
    console.error(`[clawmem] spool-drain: applied=${r.applied} discarded=${r.discarded} retained=${r.retained}`);
  }
}

/**
 * t61 (codex F60-4): detached child spawned by cmdHook AFTER hook stdout.
 * Reads ONE bookkeeping job as JSON from stdin, validates it structurally,
 * persists it to the spool (the durability point), then drains the spool.
 * The parent hook process does no post-stdout fs/SQLite work — this child
 * absorbs every stall. CLAWMEM_TEST_SPOOL_INGEST_HANG_MS makes the child
 * sleep BEFORE reading/persisting so tests can prove the parent's exit does
 * not depend on this child's progress.
 */
/**
 * t63 (codex F62-3): size-limited stdin reader for the ingest child — the
 * read ABORTS the moment the accumulated bytes cross the cap, so a rogue or
 * oversized stream is never fully buffered in memory. Returns null on
 * over-limit.
 */
async function readStdinRawBounded(maxBytes: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of Bun.stdin.stream()) {
    total += chunk.byteLength;
    if (total > maxBytes) return null; // abort — do not keep accumulating
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function cmdSpoolIngest() {
  const hangMs = Number(process.env.CLAWMEM_TEST_SPOOL_INGEST_HANG_MS ?? "0");
  if (hangMs > 0) await Bun.sleep(hangMs);
  // t62/t63 (codex F61-3, F62-3): the bound is enforced DURING the read —
  // crossing the cap aborts instead of buffering an unbounded stream.
  const raw = await readStdinRawBounded(SPOOL_JOB_MAX_BYTES);
  if (!raw) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!validateSurfacingBookkeepingJob(parsed)) return;
  const s = getStore();
  writeSurfacingBookkeepingSpoolJob(s.dbPath, parsed);
  const r = drainSurfacingBookkeepingSpool(s);
  if (r.discarded || r.retained) {
    console.error(`[clawmem] spool-ingest: applied=${r.applied} discarded=${r.discarded} retained=${r.retained}`);
  }
}

// =============================================================================
// IO6: Surface command (pre-prompt context injection for daemon mode)
// =============================================================================

async function readStdinRaw(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function cmdSurface(args: string[]) {
  const isBootstrap = args.includes("--bootstrap");
  const isContext = args.includes("--context");
  const useStdin = args.includes("--stdin");

  if (!isBootstrap && !isContext) {
    die("Usage: clawmem surface --context --stdin  OR  clawmem surface --bootstrap --stdin");
  }

  const input = useStdin ? await readStdinRaw() : args.find(a => !a.startsWith("--")) || "";
  if (!input) process.exit(0);

  // Open store: writable for both (context-surfacing writes dedupe data)
  const s = createStore(undefined, { busyTimeout: 5000 });

  try {
    if (isBootstrap) {
      // IO6b: session-bootstrap + staleness-check
      const sessionId = input.trim() || `io6-${epochMs(epochNow())}`;

      const bootstrapResult = await sessionBootstrap(s, {
        prompt: "",
        hookEventName: "io6-bootstrap",
        sessionId,
        transcriptPath: undefined,
      });

      const stalenessResult = await stalenessCheck(s, {
        prompt: "",
        hookEventName: "io6-staleness",
        sessionId,
        transcriptPath: undefined,
      });

      // Output both if present (bootstrap first, staleness appended)
      const output = [
        bootstrapResult.hookSpecificOutput?.additionalContext,
        stalenessResult.hookSpecificOutput?.additionalContext,
      ]
        .filter(Boolean)
        .join("\n");

      if (output) process.stdout.write(output);
    } else {
      // IO6a: context-surfacing
      if (input.length < 20) process.exit(0);

      const result = await contextSurfacing(s, {
        prompt: input,
        hookEventName: "io6-context",
        sessionId: undefined,
        transcriptPath: undefined,
      });

      const ctx = result.hookSpecificOutput?.additionalContext;
      if (ctx) process.stdout.write(ctx);
    }
  } finally {
    s.close();
  }
  process.exit(0);
}

async function cmdBudget(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { session: { type: "string" }, last: { type: "string", default: "5" } },
    allowPositionals: false,
  });

  const s = getStore();

  if (values.session) {
    const usages = s.getUsageForSession(values.session);
    if (usages.length === 0) {
      console.log(`No usage records for session ${values.session}`);
      return;
    }
    for (const u of usages) {
      const paths = JSON.parse(u.injectedPaths) as string[];
      console.log(`${c.dim}${u.timestamp}${c.reset} ${c.cyan}${u.hookName}${c.reset} ${u.estimatedTokens} tokens, ${paths.length} notes ${u.wasReferenced ? c.green + "referenced" + c.reset : c.dim + "not referenced" + c.reset}`);
    }
  } else {
    const sessions = s.getRecentSessions(parseInt(values.last!, 10));
    if (sessions.length === 0) {
      console.log("No sessions tracked yet.");
      return;
    }
    for (const sess of sessions) {
      const usages = s.getUsageForSession(sess.sessionId);
      const totalTokens = usages.reduce((sum, u) => sum + u.estimatedTokens, 0);
      const refCount = usages.filter(u => u.wasReferenced).length;
      console.log(`${c.bold}${sess.sessionId.slice(0, 8)}${c.reset} ${c.dim}${sess.startedAt}${c.reset} ${totalTokens} tokens, ${refCount}/${usages.length} referenced`);
      if (sess.summary) console.log(`  ${c.dim}${sess.summary.slice(0, 80)}${c.reset}`);
    }
  }
}

async function cmdLog(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { last: { type: "string", default: "10" } },
    allowPositionals: false,
  });

  const s = getStore();
  const sessions = s.getRecentSessions(parseInt(values.last!, 10));

  if (sessions.length === 0) {
    console.log("No sessions tracked.");
    return;
  }

  for (const sess of sessions) {
    const duration = sess.endedAt
      ? `${Math.round((new Date(sess.endedAt).getTime() - new Date(sess.startedAt).getTime()) / 60000)}min`
      : "active";
    console.log(`${c.bold}${sess.sessionId.slice(0, 8)}${c.reset} ${c.dim}${sess.startedAt}${c.reset} (${duration})`);
    if (sess.handoffPath) console.log(`  Handoff: ${sess.handoffPath}`);
    if (sess.summary) console.log(`  ${sess.summary.slice(0, 100)}`);
    if (sess.filesChanged.length > 0) console.log(`  Files: ${sess.filesChanged.slice(0, 5).join(", ")}`);
    console.log();
  }
}

// =============================================================================
// MCP Server
// =============================================================================

async function cmdMcp() {
  enableMcpStdioMode();
  const { startMcpServer } = await import("./mcp.ts");
  await startMcpServer();
}

async function cmdServe(args: string[]) {
  const port = parseInt(args.find((_, i, a) => a[i - 1] === "--port") || "7438", 10);
  const host = args.find((_, i, a) => a[i - 1] === "--host") || "127.0.0.1";
  const noToken = args.includes("--no-token");
  // Everything serve could refuse is settled before the vault opens: the guard (bind, allowlists), --no-token, the token.
  const { resolveServeGuard, resolveServeToken, ServeConfigError } = await import("./server-guard.ts");
  let guard, token;
  try {
    guard = resolveServeGuard({ host });
    if (noToken && !guard.loopbackBind) die(`--no-token is refused on a non-loopback bind (${host}): there the token is the only gate`);
    token = noToken ? null : resolveServeToken();
  } catch (e) {
    if (e instanceof ServeConfigError) die(e.message);
    throw e;
  }
  const s = getStore();
  const { startServer } = await import("./server.ts");
  // startServer logs what this configuration leaves open (--no-token, Host check off, Windows file checks).
  startServer(s, port, host, token ? { token } : { noToken: true });
  console.log(`ClawMem HTTP server listening on http://${host}:${port}`);
  console.log(token
    ? `Token: ${token.source === "env" ? "CLAWMEM_API_TOKEN" : token.path} (send it as Authorization: Bearer <token>; \`clawmem serve-token\` prints it)`
    : `${c.yellow}Token: none (--no-token)${c.reset}`);
  console.log(`Press Ctrl+C to stop.`);
  // Keep alive
  await new Promise(() => {});
}

/** Prints the token `serve` would use under this environment — CLAWMEM_API_TOKEN, else the token file, created on first use. */
async function cmdServeToken() {
  const { resolveServeToken, ServeConfigError } = await import("./server-guard.ts");
  try {
    process.stdout.write(`${resolveServeToken().token}\n`);
  } catch (e) {
    if (e instanceof ServeConfigError) die(e.message);
    throw e;
  }
}

// In MCP stdio mode, stdout is reserved exclusively for JSON-RPC messages.
// Any accidental console.log/info/debug/warn output will corrupt the protocol stream.
function enableMcpStdioMode(): void {
  process.env.CLAWMEM_STDIO_MODE = "true";
  if (!process.env.NO_COLOR) process.env.NO_COLOR = "1";

  const err = console.error.bind(console);
  // Bun's console properties are writable; still guard in case of future changes.
  try { (console as any).log = err; } catch {}
  try { (console as any).info = err; } catch {}
  try { (console as any).debug = err; } catch {}
  try { (console as any).warn = err; } catch {}
}

// =============================================================================
// Setup Commands
// =============================================================================

async function cmdSetup(args: string[]) {
  const subCmd = args[0];
  switch (subCmd) {
    case "hooks": await cmdSetupHooks(args.slice(1)); break;
    case "mcp": await cmdSetupMcp(args.slice(1)); break;
    case "curator": await cmdSetupCurator(args.slice(1)); break;
    case "openclaw": await cmdSetupOpenClaw(args.slice(1)); break;
    default: die("Usage: clawmem setup <hooks|mcp|curator|openclaw> [--remove]");
  }
}

async function cmdSetupHooks(args: string[]) {
  const remove = args.includes("--remove");
  const settingsPath = pathResolve(process.env.HOME || "~", ".claude", "settings.json");

  // Find clawmem binary
  const binPath = findClawmemBinary();

  let settings: any = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  if (!settings.hooks) settings.hooks = {};

  // 62.2: install and --remove strip ClawMem's OWN handlers only (`hook-settings.ts`): a group keeps
  // its other handlers and its matcher. Through v0.39.1 any group holding a command that contained
  // "clawmem" was deleted whole, taking a user's hook in the same group with it.
  if (remove) {
    // Remove clawmem hooks
    for (const event of ["UserPromptSubmit", "Stop", "SessionStart", "PreCompact", "SessionEnd"]) {
      if (settings.hooks[event]) {
        settings.hooks[event] = stripClawmemHooks(settings.hooks[event]);
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }
    console.log(`${c.green}Removed ClawMem hooks from ${settingsPath}${c.reset}`);
  } else {
    // Install clawmem hooks. 62.2 (CM-05): postcompact-inject gets its OWN SessionStart group with
    // matcher "compact" — SessionStart also fires on startup/resume/clear, and through v0.39.1 the
    // shared matcher-"" group ran it on every session start.
    const hookGroups: { event: string; matcher: string; hooks: string[] }[] = [
      { event: "UserPromptSubmit", matcher: "", hooks: ["context-surfacing"] },
      { event: "SessionStart", matcher: "compact", hooks: ["postcompact-inject"] },
      { event: "SessionStart", matcher: "", hooks: ["curator-nudge"] },
      { event: "PreCompact", matcher: "", hooks: ["precompact-extract"] },
      { event: "Stop", matcher: "", hooks: ["decision-extractor", "handoff-generator", "feedback-loop"] },
      // 62.1 D5: the handoff's render-only flush (no transcript read, no model) at session end.
      { event: "SessionEnd", matcher: "", hooks: ["handoff-generator"] },
    ];

    // Use Claude Code's native timeout property instead of shell `timeout` wrapper.
    // Shell `timeout` kills the process with SIGTERM (exit 124) which produces
    // "Stop hook error: Failed with non-blocking status code" in Claude Code.
    // Native timeout is handled gracefully by the hook runner.
    // BUILD-3a (C2c/C3): the UserPromptSubmit HOST timeout is derived from
    // the hook's INTERNAL budget — host ≥ startup allowance + budget, so the
    // outer kill switch can never fire before the handler's own deadlines.
    // The two are set TOGETHER here; `clawmem doctor` enforces the same
    // inequality against whatever is installed. A larger already-installed
    // timeout is preserved (never reduced).
    const { parseHookBudgetConfig, STARTUP_ALLOWANCE_MS } = await import("./hooks/context-surfacing.ts");
    // The budget the timeout is derived FROM is also PERSISTED into the
    // installed command (env prefix below) — otherwise the installer's
    // transient environment sizes the timeout while the installed hook runs
    // under whatever ambient budget it happens to get (codex turn-23
    // finding 4: silent drift in both directions).
    // O1 §2: an UNSUPPORTED budget (above MAX_HOOK_BUDGET_MS) is refused at
    // install — a pinned unsupported value would refuse every hook run.
    const budgetConfig = parseHookBudgetConfig(process.env.CLAWMEM_HOOK_BUDGET_MS);
    if (!budgetConfig.valid) die(`Refusing to install hooks: ${budgetConfig.reason}`);
    if (budgetConfig.note) console.log(`${c.yellow}!${c.reset} ${budgetConfig.note}`);
    const installBudgetMs = budgetConfig.effectiveMs;
    const requiredUserPromptTimeoutSec = Math.ceil((STARTUP_ALLOWANCE_MS + installBudgetMs) / 1000);
    const priorUserPromptTimeoutSec = (() => {
      let max = 0;
      for (const entry of settings.hooks["UserPromptSubmit"] ?? []) {
        for (const h of entry.hooks ?? []) {
          if (h.command?.includes("clawmem") && typeof h.timeout === "number") max = Math.max(max, h.timeout);
        }
      }
      return max;
    })();
    const timeouts: Record<string, number> = {
      UserPromptSubmit: Math.max(8, requiredUserPromptTimeoutSec, priorUserPromptTimeoutSec),
      SessionStart: 5,
      PreCompact: 5,
      Stop: 30, // LLM-based extraction hooks need more time
      SessionEnd: 2, // the flush's own deadline is 1 s; Claude Code caps SessionEnd hooks at 1.5 s
    };

    // Remove existing clawmem entries ONCE per event, before any group is added: an event with two
    // groups (SessionStart) would otherwise lose the first when the second is written.
    for (const event of new Set(hookGroups.map(g => g.event))) {
      settings.hooks[event] = stripClawmemHooks(settings.hooks[event] ?? []);
    }

    for (const { event, matcher, hooks } of hookGroups) {
      const timeout = timeouts[event] || 5;

      // Add new entries with native timeout property. The context-surfacing
      // command carries its budget as an env prefix so the installed
      // budget+timeout pair lives in ONE settings entry — the hook process
      // reads it from its own environment and doctor parses it from the
      // command string, neither depending on ambient env (codex turn-23 F4).
      settings.hooks[event].push({
        matcher,
        hooks: hooks.map(name => ({
          type: "command",
          command: name === "context-surfacing"
            ? `CLAWMEM_HOOK_BUDGET_MS=${installBudgetMs} ${binPath} hook ${name}`
            : `${binPath} hook ${name}`,
          timeout,
        })),
      });
    }

    console.log(`${c.green}Installed ClawMem hooks to ${settingsPath}${c.reset}`);
    for (const { event, matcher, hooks } of hookGroups) {
      console.log(`  ${event}${matcher ? ` (${matcher})` : ""}: ${hooks.join(", ")}`);
    }
  }

  const { writeFileSync: wfs } = await import("fs");
  const dir = pathResolve(process.env.HOME || "~", ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  wfs(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

async function cmdSetupMcp(args: string[]) {
  const remove = args.includes("--remove");
  const claudeJsonPath = pathResolve(process.env.HOME || "~", ".claude.json");

  let config: any = {};
  if (existsSync(claudeJsonPath)) {
    config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
  }

  if (!config.mcpServers) config.mcpServers = {};

  if (remove) {
    delete config.mcpServers.clawmem;
    console.log(`${c.green}Removed ClawMem MCP from ${claudeJsonPath}${c.reset}`);
  } else {
    const binPath = findClawmemBinary();
    config.mcpServers.clawmem = {
      command: binPath,
      args: ["mcp"],
    };
    console.log(`${c.green}Registered ClawMem MCP in ${claudeJsonPath}${c.reset}`);
    console.log(`  Command: ${binPath} mcp`);
  }

  const { writeFileSync: wfs } = await import("fs");
  wfs(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
}

async function cmdSetupCurator(args: string[]) {
  const remove = args.includes("--remove");
  const agentsDir = pathResolve(process.env.HOME || "~", ".claude", "agents");
  const targetPath = pathResolve(agentsDir, "clawmem-curator.md");
  const sourcePath = pathResolve(import.meta.dir, "..", "agents", "clawmem-curator.md");

  if (remove) {
    if (existsSync(targetPath)) {
      const { unlinkSync } = await import("fs");
      unlinkSync(targetPath);
      console.log(`${c.green}Removed curator agent from ${targetPath}${c.reset}`);
    } else {
      console.log(`${c.dim}Curator agent not installed at ${targetPath}${c.reset}`);
    }
    return;
  }

  if (!existsSync(sourcePath)) {
    die(`Curator agent definition not found at ${sourcePath}`);
  }

  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  const { copyFileSync } = await import("fs");
  copyFileSync(sourcePath, targetPath);
  console.log(`${c.green}Installed curator agent to ${targetPath}${c.reset}`);
  console.log(`  Trigger: "curate memory", "run curator", or "memory maintenance"`);
}

function cmdPath() {
  console.log(getDefaultDbPath());
}

/**
 * Read a single OpenClaw config key via `openclaw config get <key>`. Returns
 * the trimmed string value, or undefined when the key is unset / the CLI is
 * unavailable / the key is missing. Callers should treat undefined as
 * "no opinion" rather than "definitely unset".
 */
function readOpenClawConfigValue(key: string): string | undefined {
  try {
    const r = Bun.spawnSync(openClawArgv(["config", "get", key]), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return undefined;
    const out = new TextDecoder().decode(r.stdout).trim();
    if (!out) return undefined;
    // `openclaw config get` may print JSON ("clawmem"\n) or raw (clawmem). Strip quotes.
    return out.replace(/^"(.*)"$/, "$1");
  } catch {
    return undefined;
  }
}

// ---- OpenClaw plugin install helpers (PR #27 / OpenClaw >= 2026.5) ----------

type OpenClawConsentFlag = {
  /** true when `openclaw plugins install --help` printed a flag list we could read */
  helpSeen: boolean;
  /** true when that help advertises --accept-capabilities (OpenClaw >= 2026.9 local installs) */
  acceptCapabilities: boolean;
};

/**
 * Feature-detect capability consent from OpenClaw's own `plugins install
 * --help`. Only this flag is detected: `-l` and `--force` are sent exactly as
 * before (every supported OpenClaw accepts them in the modes we use), so the
 * contract is narrow on purpose. Version strings are never parsed.
 */
function detectOpenClawConsentFlag(): OpenClawConsentFlag {
  try {
    const r = Bun.spawnSync(openClawArgv(["plugins", "install", "--help"]), { stdout: "pipe", stderr: "pipe" });
    const text = new TextDecoder().decode(r.stdout ?? new Uint8Array()) + new TextDecoder().decode(r.stderr ?? new Uint8Array());
    return { helpSeen: /--(link|force|accept-capabilities)\b/.test(text), acceptCapabilities: /--accept-capabilities\b/.test(text) };
  } catch {
    return { helpSeen: false, acceptCapabilities: false };
  }
}

/**
 * Run an openclaw subcommand with PIPED stdio, echoing both streams, so the
 * output is visible to the operator AND inspectable by us. `stdout: "inherit"`
 * makes Bun.spawnSync return stdout/stderr as undefined — the trap PR #27's
 * string-detection fallback fell into.
 */
/**
 * OpenClaw selects a named profile ONLY from `--profile <name>` in its own
 * argv (openclaw src/entry.ts parseCliProfileArgs → applyCliProfileEnv); the
 * OPENCLAW_PROFILE variable by itself changes nothing for a delegated command.
 * So every openclaw invocation setup makes carries the operator's
 * OPENCLAW_PROFILE as that flag, validated with OpenClaw's own name grammar
 * (openclaw src/cli/profile-utils.ts PROFILE_NAME_RE) so a typo fails here
 * instead of installing silently into the default profile. The grammar
 * check itself lives in resolveOpenClawProfile (openclaw-paths.ts), shared
 * with the CLI-absent `.openclaw-<profile>` resolver, so both install paths
 * refuse exactly the same names.
 */
function openClawProfileOrDie(): string | undefined {
  try {
    return resolveOpenClawProfile();
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}
function openClawProfileArgs(): string[] {
  const profile = openClawProfileOrDie();
  return profile ? ["--profile", profile] : [];
}
function openClawArgv(args: string[]): string[] {
  return ["openclaw", ...openClawProfileArgs(), ...args];
}

function runOpenClaw(args: string[]): { exitCode: number; output: string } {
  const r = Bun.spawnSync(openClawArgv([...args]), { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout ?? new Uint8Array());
  const err = new TextDecoder().decode(r.stderr ?? new Uint8Array());
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  return { exitCode: r.exitCode, output: out + err };
}

type StagedPlugin = { dir: string; manifest: Record<string, unknown> };

/**
 * What the operator consents to when OpenClaw asks for capability acceptance.
 * The tool list comes from the manifest that will actually be installed —
 * never from a second hand-maintained list.
 */
function printOpenClawPluginCapabilities(manifest: Record<string, unknown>): void {
  const contracts = (manifest.contracts ?? {}) as { tools?: string[] };
  const tools = contracts.tools ?? [];
  console.log();
  console.log(`${c.bold}ClawMem asks OpenClaw for these capabilities:${c.reset}`);
  console.log(`  - ${tools.length} agent tools: ${tools.join(", ") || "(none declared)"}`);
  console.log(`  - conversation access: before_prompt_build injects retrieved memory into every prompt; agent_end reads the finished turn for extraction (plugins.entries.clawmem.hooks.allowConversationAccess)`);
  console.log(`  - ownership of the memory slot (plugins.slots.memory = clawmem)`);
  console.log(`  - a background REST service (\`clawmem serve\`) on the configured servePort`);
  console.log();
}

/**
 * Build the production copy of the plugin: ONLY a Node-target dist/index.js,
 * the manifest, and a package.json whose openclaw.extensions points at the
 * compiled entry. Old and current gateways both load a JavaScript entry;
 * shipping index.ts alongside would be a trap on gateways that ignore
 * runtimeExtensions (the TS module closure would be missing). Returns the
 * staging directory plus the manifest it carries; the caller installs from
 * it and removes it.
 */
async function stageOpenClawPluginCopy(pluginDir: string): Promise<StagedPlugin> {
  const { mkdtempSync, copyFileSync, readFileSync, writeFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const { rmSync } = await import("fs");
  const stage = mkdtempSync(join(tmpdir(), "clawmem-openclaw-plugin-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(pluginDir, "index.ts")],
      target: "node",
      outdir: join(stage, "dist"),
    });
    if (!build.success || !existsSync(join(stage, "dist", "index.js"))) {
      const msgs = build.logs.map((l) => String(l.message ?? l)).join("\n");
      throw new Error(`Failed to bundle the OpenClaw plugin runtime entry (dist/index.js):\n${msgs}`);
    }
    copyFileSync(join(pluginDir, "openclaw.plugin.json"), join(stage, "openclaw.plugin.json"));
    const srcPkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8")) as Record<string, unknown>;
    const pkg: Record<string, unknown> = { ...srcPkg, openclaw: { extensions: ["./dist/index.js"] } };
    writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    const manifest = JSON.parse(readFileSync(join(stage, "openclaw.plugin.json"), "utf-8")) as Record<string, unknown>;
    return { dir: stage, manifest };
  } catch (e) {
    // The stage is ours; never leave it behind on a failed build.
    try { rmSync(stage, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

/**
 * The three config keys a working install needs on OpenClaw >= 2026.5, set
 * idempotently after the plugin is installed, plus the one policy that can
 * silently disable injection if an operator set it to false.
 */
function applyOpenClawPluginConfig(binPath: string): { incomplete: string[] } {
  const sets: Array<[string, string, string]> = [
    ["plugins.entries.clawmem.config.clawmemBin", binPath, "the plugin runs this exact binary (no search-path guessing)"],
    ["plugins.entries.clawmem.hooks.allowConversationAccess", "true", "before_prompt_build + agent_end are conversation hooks; non-bundled plugins are denied without it"],
    ["plugins.slots.memory", "clawmem", "an unselected memory plugin loads without its memory runtime"],
  ];
  const incomplete: string[] = [];
  console.log(`${c.bold}Applying OpenClaw config:${c.reset}`);
  for (const [key, value, why] of sets) {
    const r = Bun.spawnSync(openClawArgv(["config", "set", key, value]), { stdout: "pipe", stderr: "pipe" });
    const err = new TextDecoder().decode(r.stderr ?? new Uint8Array()).trim();
    // Read back: the write returning 0 is not the contract, the stored value is.
    const seen = readOpenClawConfigValue(key);
    if (r.exitCode === 0 && seen === value) {
      console.log(`  ${c.green}✓${c.reset} ${key} = ${value}  ${c.dim}(${why})${c.reset}`);
    } else {
      incomplete.push(key);
      console.log(`  ${c.red}✗${c.reset} ${key}: ${r.exitCode !== 0 ? `set failed (exit ${r.exitCode})${err ? `: ${err.split("\n")[0]}` : ""}` : `read back ${JSON.stringify(seen)} instead of ${JSON.stringify(value)}`}`);
      console.log(`    run manually and re-check: ${c.cyan}openclaw config set ${key} ${value}${c.reset}`);
    }
  }
  const promptInjection = readOpenClawConfigValue("plugins.entries.clawmem.hooks.allowPromptInjection");
  if (promptInjection === "false") {
    console.log(`  ${c.yellow}! plugins.entries.clawmem.hooks.allowPromptInjection is false — before_prompt_build is blocked; ClawMem cannot inject memory until you unset it.${c.reset}`);
  }
  return { incomplete };
}

/**
 * OpenClaw lets an operator hook-timeout policy override the timeoutMs the
 * plugin registers (per-hook, then general, then the registration value).
 * A policy lower than the plugin's derived host timeout silently kills the
 * surfacing hook on every prompt — the failure class of issue #28 — so
 * setup checks it here, where the config is already being read.
 */
async function warnOnLowOpenClawHookTimeoutPolicy(): Promise<void> {
  const { resolveHookBudgetMs, hostHookTimeoutMs } = await import("./openclaw/shell.ts");
  const budget = resolveHookBudgetMs(readOpenClawConfigValue("plugins.entries.clawmem.config.hookBudgetMs"));
  const needed = hostHookTimeoutMs({ hookBudgetMs: budget });
  const perHook = readOpenClawConfigValue("plugins.entries.clawmem.hooks.timeouts.before_prompt_build");
  const general = readOpenClawConfigValue("plugins.entries.clawmem.hooks.timeoutMs");
  const raw = perHook ?? general;
  if (raw === undefined) return;
  const policy = Number(raw);
  if (!Number.isFinite(policy) || policy <= 0) return;
  if (policy < needed) {
    const key = perHook !== undefined ? "plugins.entries.clawmem.hooks.timeouts.before_prompt_build" : "plugins.entries.clawmem.hooks.timeoutMs";
    console.log(`${c.yellow}! ${key} = ${policy}ms is below the ${needed}ms the plugin needs for its ${budget}ms hook budget — OpenClaw will kill context-surfacing on every prompt.${c.reset}`);
    console.log(`  fix: ${c.cyan}openclaw config set ${key} ${needed}${c.reset}  (or lower plugins.entries.clawmem.config.hookBudgetMs)`);
  }
}

type UnixIdentity = { uid: number; gids: number[] } | { error: "id-unavailable" | "unknown-user" };

/** Resolve a user name to uid + supplementary gids via `id`; distinguishes a missing `id` from an unknown user. */
function resolveUnixIdentity(user: string): UnixIdentity {
  let u, g;
  try {
    u = Bun.spawnSync(["id", "-u", user], { stdout: "pipe", stderr: "pipe" });
    g = Bun.spawnSync(["id", "-G", user], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return { error: "id-unavailable" };
  }
  if (u.exitCode !== 0 || g.exitCode !== 0) return { error: "unknown-user" };
  const uid = Number(new TextDecoder().decode(u.stdout).trim());
  const gids = new TextDecoder().decode(g.stdout).trim().split(/\s+/).map(Number).filter(Number.isInteger);
  return Number.isInteger(uid) ? { uid, gids } : { error: "unknown-user" };
}

/** OpenClaw's own record of where it put the plugin (`plugins inspect clawmem --json`). */
function readOpenClawInstallPaths(): { installPath?: string; sourcePath?: string } {
  try {
    const r = Bun.spawnSync(openClawArgv(["plugins", "inspect", "clawmem", "--json"]), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return {};
    const text = new TextDecoder().decode(r.stdout ?? new Uint8Array()).trim();
    const start = text.indexOf("{");
    if (start < 0) return {};
    const json = JSON.parse(text.slice(start)) as unknown;
    const found: { installPath?: string; sourcePath?: string } = {};
    const walk = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "installPath" && typeof val === "string" && !found.installPath) found.installPath = val;
        else if (k === "sourcePath" && typeof val === "string" && !found.sourcePath) found.sourcePath = val;
        else walk(val);
      }
    };
    walk(json);
    return found;
  } catch {
    return {};
  }
}

/**
 * OpenClaw refuses a non-bundled plugin whose root or runtime entry is owned
 * by neither its own runtime uid nor root, or is world-writable
 * (src/plugins/discovery.ts). Verify the INSTALLED location, never the
 * temporary stage, against the gateway's uid. Returns true only when every
 * check passed; a failure prints the exact chown and returns false so the
 * caller never claims success on top of it.
 */
async function verifyOpenClawPluginOwnership(params: {
  root: string;
  entry: string;
  gatewayUser?: string;
  binPath: string;
}): Promise<{ verified: boolean }> {
  const { statSync } = await import("fs");
  const { canExecuteAs, unreadablePluginFiles } = await import("./openclaw-paths.ts");
  let identity: UnixIdentity;
  let label: string;
  if (params.gatewayUser) {
    identity = resolveUnixIdentity(params.gatewayUser);
    if ("error" in identity) {
      console.log(`${c.red}--gateway-user ${params.gatewayUser}: ${identity.error === "id-unavailable" ? "`id` is not available on this host, so the gateway identity cannot be resolved" : "unknown user on this host"} — installed but unverified.${c.reset}`);
      return { verified: false };
    }
    label = `gateway user ${params.gatewayUser} (uid ${identity.uid})`;
  } else {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const gids = typeof process.getgroups === "function" ? process.getgroups() : [];
    if (uid === undefined) { console.log(`${c.yellow}Could not determine the current uid; ownership unverified.${c.reset}`); return { verified: false }; }
    identity = { uid, gids };
    label = `the current user (uid ${uid})`;
  }
  if (!existsSync(params.root)) {
    console.log(`${c.yellow}Could not verify ownership: expected the installed plugin at ${params.root}, which is absent (custom extensions dir?).${c.reset}`);
    return { verified: false };
  }
  let ok = true;
  for (const path of [params.root, params.entry]) {
    let st;
    try { st = statSync(path); } catch { console.log(`${c.red}Missing after install: ${path}${c.reset}`); ok = false; continue; }
    if ((st.mode & 0o002) !== 0) { console.log(`${c.red}World-writable: ${path} — OpenClaw refuses it. Fix: chmod o-w ${path}${c.reset}`); ok = false; }
    if (st.uid !== identity.uid && st.uid !== 0) {
      console.log(`${c.red}Owned by uid ${st.uid}, but OpenClaw loads plugins only when owned by ${label} or root: ${path}${c.reset}`);
      ok = false;
    }
  }
  if (!ok) {
    console.log(`  fix: ${c.cyan}sudo chown -R ${params.gatewayUser ?? "<gateway-user>"} ${params.root}${c.reset}`);
    return { verified: false };
  }
  // Read + traverse for the same identity: OpenClaw reads the root, the
  // manifest, package.json and the entry as that user, so owner-or-root and
  // not world-writable is not enough (a 0750 home above the install passes both).
  const unreadable = unreadablePluginFiles(params.root, params.entry, identity.uid, identity.gids);
  if (unreadable.length > 0) {
    for (const p of unreadable) {
      console.log(existsSync(p)
        ? `${c.red}${label} cannot traverse to or read ${p} (check its r bits and the x bits on every directory on the way, symlink targets included).${c.reset}`
        : `${c.red}Missing after install: ${p}${c.reset}`);
    }
    return { verified: false };
  }
  // Execute + traverse for the identity that will actually spawn the binary,
  // computed from mode bits and group membership, not from this process.
  if (!canExecuteAs(params.binPath, identity.uid, identity.gids)) {
    console.log(`${c.red}${label} cannot traverse to or execute ${params.binPath} (check the x bits on the binary and every parent directory).${c.reset}`);
    return { verified: false };
  }
  console.log(`${c.green}✓ plugin files at ${params.root} are owned by ${label} or root, not world-writable and readable by that identity, and ${params.binPath} is executable for it${c.reset}`);
  if (!params.gatewayUser) {
    console.log(`${c.dim}  If the gateway runs as a different user (system service), re-run with --gateway-user <name> to verify for that user.${c.reset}`);
  }
  return { verified: true };
}

async function cmdSetupOpenClaw(args: string[]) {
  // §28.2 — short-circuit on --help / -h before any spawn or filesystem work.
  if (args.includes("--help") || args.includes("-h")) {
    printSetupOpenClawHelp();
    return;
  }

  const remove = args.includes("--remove");
  const linkMode = args.includes("--link");
  const gatewayUser = (() => {
    const eq = args.find((a) => a.startsWith("--gateway-user="));
    if (eq) {
      const v = eq.slice("--gateway-user=".length).trim();
      if (!v) die("--gateway-user= needs a user name");
      return v;
    }
    const i = args.indexOf("--gateway-user");
    if (i < 0) return undefined;
    const v = (args[i + 1] ?? "").trim();
    if (!v || v.startsWith("-")) die("--gateway-user needs a user name (the account the OpenClaw gateway runs as)");
    return v;
  })();
  const pluginDir = pathResolve(import.meta.dir, "openclaw");

  // Resolve the extensions/clawmem path we would touch directly. Both Path 1
  // link-mode pre-cleanup and Path 3 direct-copy install need this. Path 1
  // copy-mode delegation does NOT use linkPath because OpenClaw's
  // `--force` install owns the destination resolution there.
  // OPENCLAW_PROFILE is validated here, before any path is derived from it
  // and before the CLI probe decides which path runs: the delegated
  // `--profile` flag and the CLI-absent `.openclaw-<profile>` directory share
  // one grammar, so a name with a separator or `..` stops setup on every
  // path, --remove included, instead of escaping the intended state root.
  openClawProfileOrDie();
  const extensionsDir = resolveExtensionsDirNoOpenClaw();
  const linkPath = pathResolve(extensionsDir, "clawmem");

  // Probe whether the openclaw CLI is on PATH. Used to choose between
  // delegation (Path 1) and direct-copy fallback (Path 3) for installs,
  // and between CLI uninstall and manual cleanup for --remove.
  const hasOpenClawCli = (() => {
    try {
      const r = Bun.spawnSync(["openclaw", "--version"], { stdout: "pipe", stderr: "pipe" });
      return r.exitCode === 0;
    } catch { return false; }
  })();

  if (remove) {
    // §28.1 H3 / R1 / R4: try-and-fall-back uninstall + constrained stale
    // cleanup. CLI uninstall is preferred (handles managed config + slot
    // resets); manual cleanup is the legacy fallback for unmanaged
    // direct-cpSync installs from older ClawMem versions. On CLI failure we
    // fall through AND emit a warning so the user knows config/install
    // records may need manual repair.
    let cliUninstallSucceeded = false;
    let cliUninstallFailed = false;
    if (hasOpenClawCli) {
      const r = Bun.spawnSync(
        openClawArgv(["plugins", "uninstall", "clawmem", "--force"]),
        { stdout: "inherit", stderr: "inherit" },
      );
      if (r.exitCode === 0) {
        cliUninstallSucceeded = true;
      } else {
        cliUninstallFailed = true;
        console.log(
          `${c.yellow}Warning: openclaw plugins uninstall clawmem failed (exit ${r.exitCode}).${c.reset}`,
        );
        console.log(
          `${c.yellow}  OpenClaw config and install records may still reference clawmem.${c.reset}`,
        );
        console.log(
          `${c.yellow}  Falling back to manual cleanup of the install directory.${c.reset}`,
        );
      }
    }

    // Constrained stale cleanup (R3 in BACKLOG §28.1): even if CLI uninstall
    // succeeded, an old unmanaged direct-copy directory at the same path
    // could still be present (managed-link + unmanaged-copy side-by-side).
    // Always check the exact extensions/clawmem path and remove if present.
    let removed = false;
    try {
      const { lstatSync, unlinkSync, rmSync } = await import("fs");
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        unlinkSync(linkPath);
        console.log(`${c.green}Removed plugin symlink at ${linkPath}${c.reset}`);
        removed = true;
      } else if (stat.isDirectory()) {
        rmSync(linkPath, { recursive: true });
        console.log(`${c.green}Removed plugin directory at ${linkPath}${c.reset}`);
        removed = true;
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      if (!cliUninstallSucceeded && !cliUninstallFailed) {
        // Truly nothing to do — no CLI, no directory.
        console.log(`${c.dim}Plugin not installed at ${linkPath}${c.reset}`);
      }
    }

    // Slot reset: only meaningful if the CLI is reachable. CLI uninstall
    // already clears the memory slot if it succeeded, but if uninstall
    // failed we still attempt slot reset because config slots can be
    // populated separately from install records.
    if (hasOpenClawCli) {
      const memSlot = readOpenClawConfigValue("plugins.slots.memory");
      if (memSlot === "clawmem") {
        Bun.spawnSync(openClawArgv(["config", "unset", "plugins.slots.memory"]), { stdout: "inherit", stderr: "inherit" });
        console.log(`${c.green}Cleared memory slot (was clawmem)${c.reset}`);
      }
      // Reset the legacy context-engine slot if any pre-§14.3-migration install
      // left it pointing at clawmem.
      const ceSlot = readOpenClawConfigValue("plugins.slots.contextEngine");
      if (ceSlot === "clawmem") {
        Bun.spawnSync(openClawArgv(["config", "set", "plugins.slots.contextEngine", "legacy"]), { stdout: "inherit", stderr: "inherit" });
        console.log(`${c.green}Reset context engine slot to legacy (was clawmem)${c.reset}`);
      }
    } else if (removed) {
      console.log(`${c.dim}openclaw CLI not found — manually clear: openclaw config unset plugins.slots.memory && openclaw config set plugins.slots.contextEngine legacy${c.reset}`);
    }
    return;
  }

  // Verify plugin source files exist (cheap defense-in-depth — surfaces
  // ClawMem packaging bugs immediately, before any spawn).
  if (!existsSync(pathResolve(pluginDir, "index.ts"))) {
    die(`OpenClaw plugin files not found at ${pluginDir}`);
  }
  if (!existsSync(pathResolve(pluginDir, "openclaw.plugin.json"))) {
    die(`Plugin manifest not found at ${pluginDir}/openclaw.plugin.json`);
  }
  if (!existsSync(pathResolve(pluginDir, "package.json"))) {
    die(`Plugin package.json not found at ${pluginDir}/package.json — required for OpenClaw v2026.4.11+ discovery`);
  }

  // §28.1 H1/H2: choose path. Path 1 = openclaw plugins install delegation;
  // Path 3 = direct-copy fallback honoring OPENCLAW_STATE_DIR.
  const acceptCapabilitiesFlag = args.includes("--accept-capabilities") || args.includes("--yes") || args.includes("-y");
  const keepStage = process.env.CLAWMEM_KEEP_STAGE === "1"; // test seam: leave the staged copy on disk
  // clawmemBin is recorded as an absolute, regular, executable path or not at
  // all: a search-path guess or a non-executable file would pass setup and fail
  // at the first hook (codex v0.39 turn 8).
  const bin = resolveRecordableClawmemBin(findClawmemBinary(), (n) => Bun.which(n));
  if (!bin.ok) die(`Cannot record clawmemBin: ${bin.reason}. Run setup from an install whose bin/clawmem is executable, or put an executable clawmem on PATH.`);
  const binPath = bin.path;
  let delegated = false;
  let ownershipVerified = false;
  if (hasOpenClawCli) {
    // Path 1: delegate to OpenClaw. Auto-enables, writes install records,
    // applies slot selection, refreshes registry.
    const flags = detectOpenClawConsentFlag();

    // Stage BEFORE consent: OpenClaw binds consent to the final staged
    // bytes, so the operator must be shown what those bytes declare.
    let staged: StagedPlugin | undefined;
    let manifestForConsent: Record<string, unknown>;
    if (linkMode) {
      manifestForConsent = JSON.parse(readFileSync(pathResolve(pluginDir, "openclaw.plugin.json"), "utf-8"));
    } else {
      staged = await stageOpenClawPluginCopy(pluginDir);
      manifestForConsent = staged.manifest;
    }
    const cleanupStage = async () => {
      if (!staged) return;
      if (keepStage) { console.log(`${c.dim}CLAWMEM_KEEP_STAGE=1 — staged plugin copy left at ${staged.dir}${c.reset}`); return; }
      const { rmSync } = await import("fs");
      try { rmSync(staged.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };

    // OpenClaw >= 2026.5 asks for explicit capability consent on every local
    // install (link or copy). We never pass --accept-capabilities silently:
    // the operator sees the list and confirms, by flag or interactively.
    const consentArgs: string[] = [];
    if (flags.acceptCapabilities) {
      printOpenClawPluginCapabilities(manifestForConsent);
      let accepted = acceptCapabilitiesFlag;
      if (!accepted && process.stdin.isTTY) {
        const answer = prompt("Accept these capabilities and install? [y/N]");
        accepted = /^y(es)?$/i.test((answer ?? "").trim());
      }
      if (!accepted) {
        await cleanupStage();
        die(
          "This OpenClaw requires capability consent for plugin installs. Review the list above, then re-run:\n" +
            "  clawmem setup openclaw --accept-capabilities" + (linkMode ? " --link" : ""),
        );
      }
      consentArgs.push("--accept-capabilities");
    }

    let installedRoot: string;
    let installedEntry: string;
    if (linkMode) {
      // Development path: OpenClaw loads the TypeScript source straight from
      // this checkout (link mode is the only install path that permits a
      // .ts entry on >= 2026.5.3). A stale symlink or directory at linkPath
      // is moved aside, not deleted: reruns stay idempotent without --force
      // (which some releases reject with --link) and a failed install leaves
      // the previous plugin exactly where it was.
      const aside = moveTargetAside(linkPath);
      if (aside.kind === "symlink" || aside.kind === "directory") {
        console.log(`${c.dim}Moved the existing ${aside.kind} at ${linkPath} aside for the duration of the install${c.reset}`);
      }
      const r = runOpenClaw(["plugins", "install", pluginDir, "-l", ...consentArgs]);
      if (r.exitCode !== 0) {
        try {
          aside.restore();
        } catch (e) {
          die(`openclaw plugins install -l failed (exit ${r.exitCode}) and ${e instanceof Error ? e.message : String(e)}; aborting setup`);
        }
        const putBack = aside.kind === "symlink" || aside.kind === "directory" ? `; the previous ${aside.kind} at ${linkPath} was put back` : "";
        die(`openclaw plugins install -l failed (exit ${r.exitCode})${putBack}; aborting setup`);
      }
      aside.discard();
      installedRoot = pluginDir;
      installedEntry = pathResolve(pluginDir, "index.ts");
      // OpenClaw's `plugins install -l` records the source path in
      // plugins.load.paths and persists a path install record (not a
      // filesystem symlink). The v2026.4.11 symlink-discovery skip does
      // NOT apply to this mode — discovery uses the load-path entry.
      console.log(`${c.green}Linked local plugin path via openclaw plugins install -l (profile-aware, auto-enabled)${c.reset}`);
      console.log(`${c.dim}  Source recorded in plugins.load.paths — edits to ${pluginDir} take effect on next gateway restart.${c.reset}`);
      console.log(`${c.dim}  Link mode is the development path: the gateway executes whatever this checkout contains.${c.reset}`);
    } else {
      // Production path: install a compiled copy (dist/index.js only), which
      // OpenClaw >= 2026.5.3 requires from a copied plugin ("requires
      // compiled runtime output") and older gateways load just as well.
      // --force makes OpenClaw replace an existing install, preserving
      // idempotence across reruns.
      let r: { exitCode: number; output: string };
      try {
        r = runOpenClaw(["plugins", "install", staged!.dir, "--force", ...consentArgs]);
      } finally {
        await cleanupStage();
      }
      if (r.exitCode !== 0) {
        if (r.output.includes("compiled runtime output")) {
          console.log(`${c.red}OpenClaw rejected the staged copy as source-only even though dist/index.js was bundled — this is a ClawMem packaging bug, please report it with the output above.${c.reset}`);
        }
        die(`openclaw plugins install --force failed (exit ${r.exitCode}); aborting setup`);
      }
      installedRoot = linkPath;
      installedEntry = pathResolve(linkPath, "dist", "index.js");
      console.log(`${c.green}Installed plugin via openclaw plugins install --force (compiled runtime entry, profile-aware, auto-enabled)${c.reset}`);
    }
    delegated = true;

    // The install alone is not a working plugin on OpenClaw >= 2026.5:
    // tools need the manifest contract (shipped), conversation hooks need
    // the grant, the memory slot must name us, and the plugin must run the
    // binary from THIS checkout rather than a search-path guess.
    const cfgResult = applyOpenClawPluginConfig(binPath);
    if (cfgResult.incomplete.length > 0) {
      die(`Installed but configuration incomplete — OpenClaw will not run the plugin correctly until these are set: ${cfgResult.incomplete.join(", ")}`);
    }
    await warnOnLowOpenClawHookTimeoutPolicy();
    // The authoritative installed location comes from OpenClaw's own install
    // record. In link mode the root is the checkout we handed to `install -l`,
    // known by construction; in copy mode only the record knows where OpenClaw
    // put the files, and the resolver's guess is diagnostic at best.
    const recorded = readOpenClawInstallPaths();
    let rootIsAuthoritative = linkMode;
    if (linkMode && recorded.sourcePath) { installedRoot = recorded.sourcePath; installedEntry = pathResolve(recorded.sourcePath, "index.ts"); }
    if (!linkMode && recorded.installPath) { installedRoot = recorded.installPath; installedEntry = pathResolve(recorded.installPath, "dist", "index.js"); rootIsAuthoritative = true; }
    if (!rootIsAuthoritative) {
      console.log(`${c.yellow}openclaw plugins inspect clawmem --json named no install path; checking the inferred location ${installedRoot} as a diagnostic only, not as verification.${c.reset}`);
      if (gatewayUser) {
        die(`Installed but cannot verify for --gateway-user ${gatewayUser}: OpenClaw's install record did not name the installed path, so setup cannot confirm the gateway can load it. Run \`openclaw plugins inspect clawmem\` and check the ownership of the path it prints.`);
      }
    }
    const own = await verifyOpenClawPluginOwnership({ root: installedRoot, entry: installedEntry, gatewayUser, binPath });
    ownershipVerified = own.verified && rootIsAuthoritative;
    if (gatewayUser && !own.verified) {
      die(`Installed but unverified for --gateway-user ${gatewayUser}: fix the ownership above and re-run setup; the gateway will not load the plugin as it stands.`);
    }
  } else {
    // Path 3: direct-copy fallback. Honors OPENCLAW_STATE_DIR via the
    // resolveExtensionsDirNoOpenClaw helper. No install record, no
    // capability consent, no config writes — OpenClaw >= 2026.5 will not
    // register the hooks or tools until those are done by hand (see the
    // next-steps output).
    console.log(`${c.yellow}openclaw CLI not on PATH — using direct-copy install.${c.reset}`);
    console.log(`${c.yellow}  Profile awareness limited to the OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH /${c.reset}`);
    console.log(`${c.yellow}  OPENCLAW_PROFILE env vars. Install OpenClaw to enable manifest validation, security${c.reset}`);
    console.log(`${c.yellow}  scans, capability consent, and full plugin lifecycle management.${c.reset}`);

    // Create extensions directory.
    if (!existsSync(extensionsDir)) {
      mkdirSync(extensionsDir, { recursive: true });
    }

    // Build the replacement BEFORE touching the live install, then swap it
    // into place with the old tree moved aside, so a failed build, copy or
    // rename leaves the previous plugin exactly where it was.
    const { lstatSync, rmSync, symlinkSync, cpSync } = await import("fs");
    let newDir: string | undefined;
    if (!linkMode) {
      newDir = `${linkPath}.new-${process.pid}`;
      rmSync(newDir, { recursive: true, force: true }); // a stale tree from an interrupted run
      const staged = await stageOpenClawPluginCopy(pluginDir);
      try {
        cpSync(staged.dir, newDir, { recursive: true, dereference: true });
      } catch (e) {
        rmSync(newDir, { recursive: true, force: true }); // never leave a partial .new-* behind
        throw e;
      } finally {
        if (!keepStage) { try { rmSync(staged.dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
        else console.log(`${c.dim}CLAWMEM_KEEP_STAGE=1 — staged plugin copy left at ${staged.dir}${c.reset}`);
      }
    }
    // OpenClaw v2026.4.11+ discovery (discoverInDirectory in ids-*.js) uses
    // readdirSync({ withFileTypes: true }) where symlinks report
    // isDirectory() === false and get silently skipped, so copy mode is the
    // default; --link keeps symlink behavior for older OpenClaw versions.
    if (linkMode) {
      // The previous symlink or directory is moved aside and put back if the
      // new link cannot be made; it is deleted only once the link exists.
      const aside = moveTargetAside(linkPath);
      if (aside.kind === "other") {
        die(`${linkPath} exists but is not a symlink or directory. Remove it manually and re-run setup.`);
      }
      if (aside.kind !== "none") console.log(`${c.dim}Moved the existing ${aside.kind} at ${linkPath} aside${c.reset}`);
      try {
        symlinkSync(pluginDir, linkPath);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        try {
          aside.restore();
        } catch (re) {
          die(`Could not create the symlink at ${linkPath} (${why}) and ${re instanceof Error ? re.message : String(re)}`);
        }
        die(`Could not create the symlink at ${linkPath} (${why})${aside.kind !== "none" ? `; the previous ${aside.kind} was put back` : ""}.`);
      }
      aside.discard();
      console.log(`${c.green}Installed plugin: ${linkPath} → ${pluginDir} (symlink${aside.kind !== "none" ? `, previous ${aside.kind} replaced` : ""})${c.reset}`);
      console.log(`${c.yellow}  Warning: symlink mode. OpenClaw v2026.4.11+ discovery skips${c.reset}`);
      console.log(`${c.yellow}  symlinks silently. Re-run without --link on current releases.${c.reset}`);
    } else {
      // Whatever sits at linkPath — a stale symlink or the previous directory
      // — is parked by the swap and put back if the rename in fails; only a
      // regular file is refused, before anything moves.
      try {
        const stat = lstatSync(linkPath);
        if (!stat.isSymbolicLink() && !stat.isDirectory()) {
          rmSync(newDir!, { recursive: true, force: true });
          die(`${linkPath} exists but is not a symlink or directory. Remove it manually and re-run setup.`);
        }
      } catch (e: any) {
        if (e.code !== "ENOENT") { rmSync(newDir!, { recursive: true, force: true }); throw e; }
      }
      const swapped = swapDirIntoPlace(newDir!, linkPath);
      console.log(`${c.green}Installed plugin: ${linkPath} (compiled copy of ${pluginDir}${swapped.replaced ? `, previous ${swapped.previous} replaced` : ""})${c.reset}`);
    }
    const own = await verifyOpenClawPluginOwnership({ root: linkPath, entry: pathResolve(linkPath, linkMode ? "index.ts" : "dist/index.js"), gatewayUser, binPath });
    ownershipVerified = own.verified;
    if (gatewayUser && !own.verified) {
      die(`Installed but unverified for --gateway-user ${gatewayUser}: fix the ownership above and re-run setup.`);
    }
  }

  // ----- §14.3 upgrade migration -----
  // ClawMem v0.10.0 changed `kind: "context-engine"` to `kind: "memory"`.
  // Existing installs with `plugins.slots.contextEngine = "clawmem"` will hit
  // a hard runtime error after upgrading because OpenClaw's
  // `resolveContextEngine()` throws on unknown engine ids. Detect and rewrite
  // the stale config to "legacy" so OpenClaw's built-in LegacyContextEngine
  // takes over compaction. Also detect any pre-existing `plugins.slots.memory`
  // assignment so we don't clobber a user's choice during upgrade.
  let migrationApplied = false;
  if (hasOpenClawCli) {
    const staleContextEngine = readOpenClawConfigValue("plugins.slots.contextEngine");
    if (staleContextEngine === "clawmem") {
      console.log();
      console.log(`${c.bold}${c.cyan}Upgrade migration detected:${c.reset}`);
      console.log(`  Found legacy ClawMem context-engine slot config from v0.9.x or earlier.`);
      console.log(`  Rewriting plugins.slots.contextEngine: clawmem → legacy`);
      console.log(`  ${c.dim}(ClawMem now registers as a memory plugin. OpenClaw's built-in${c.reset}`);
      console.log(`  ${c.dim} LegacyContextEngine will handle compaction unless you install a${c.reset}`);
      console.log(`  ${c.dim} third-party context-engine plugin like hermes-lcm.)${c.reset}`);
      const migrate = Bun.spawnSync(
        openClawArgv(["config", "set", "plugins.slots.contextEngine", "legacy"]),
        { stdout: "inherit", stderr: "inherit" },
      );
      if (migrate.exitCode === 0) {
        migrationApplied = true;
      } else {
        console.log(`${c.yellow}  Warning: failed to rewrite stale config — please run manually:${c.reset}`);
        console.log(`    ${c.cyan}openclaw config set plugins.slots.contextEngine legacy${c.reset}`);
      }
    }
  } else {
    console.log();
    console.log(`${c.dim}Upgrade migration skipped — openclaw CLI not on PATH. If upgrading${c.reset}`);
    console.log(`${c.dim}from v0.9.x or earlier, manually run:${c.reset}`);
    console.log(`  ${c.cyan}openclaw config set plugins.slots.contextEngine legacy${c.reset}`);
  }

  // Version warning
  console.log();
  console.log(`${c.bold}Note:${c.reset} OpenClaw v2026.4.10+ recommended — earlier versions`);
  console.log(`have a bug where plugins.slots.contextEngine is silently dropped`);
  console.log(`during config normalization (openclaw/openclaw#64192).`);

  // §28.1 H1: dual next-steps output. Path 1 (delegated) auto-enables via
  // persistPluginInstall, so the legacy "Step 1: enable" instruction is
  // redundant and would mislead users. Path 3 (direct copy) writes only
  // the plugin files; the user must still run `openclaw plugins enable`
  // themselves, so the original 4-step output is preserved verbatim.
  console.log();
  console.log(`${c.bold}Next steps:${c.reset}`);
  console.log();
  if (delegated) {
    // Path 1 — plugin already enabled and registered by openclaw plugins install.
    console.log(`  1. Restart the gateway to apply:`);
    console.log(`     ${c.cyan}openclaw gateway restart${c.reset}`);
    console.log();
    console.log(`  2. Configure GPU endpoints (if not using defaults):`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuEmbed http://YOUR_GPU:8088${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuLlm http://YOUR_GPU:8089${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuLlmModel qwen3${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuRerank http://YOUR_GPU:8090${c.reset}`);
    console.log();
    console.log(`  3. Start the REST API (for agent tools):`);
    console.log(`     ${c.cyan}clawmem serve &${c.reset}`);
  } else {
    // Path 3 — direct-copy install. User still needs to enable + restart.
    console.log(`  1. Enable ClawMem as the active memory plugin and grant its hooks:`);
    console.log(`     ${c.cyan}openclaw plugins enable clawmem${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.slots.memory clawmem${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.hooks.allowConversationAccess true${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.clawmemBin ${binPath}${c.reset}`);
    console.log(`     ${c.dim}(Without the grant, OpenClaw >= 2026.4.23 blocks before_prompt_build and agent_end for non-bundled plugins.)${c.reset}`);
    console.log();
    console.log(`  2. Restart the gateway to apply:`);
    console.log(`     ${c.cyan}openclaw gateway restart${c.reset}`);
    console.log();
    console.log(`  3. Configure GPU endpoints (if not using defaults):`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuEmbed http://YOUR_GPU:8088${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuLlm http://YOUR_GPU:8089${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuLlmModel qwen3${c.reset}`);
    console.log(`     ${c.cyan}openclaw config set plugins.entries.clawmem.config.gpuRerank http://YOUR_GPU:8090${c.reset}`);
    console.log();
    console.log(`  4. Start the REST API (for agent tools):`);
    console.log(`     ${c.cyan}clawmem serve &${c.reset}`);
  }
  console.log();
  console.log(`${c.bold}Important: keep dreaming disabled${c.reset}`);
  console.log(`  ClawMem runs its own consolidation workers (CLAWMEM_ENABLE_CONSOLIDATION`);
  console.log(`  light lane and CLAWMEM_HEAVY_LANE heavy lane). Keep ${c.cyan}dreaming.enabled = false${c.reset}`);
  console.log(`  in OpenClaw's memory config to avoid auto-loading the bundled memory-core`);
  console.log(`  dreaming engine alongside ClawMem (#65411 coexistence rule).`);
  console.log();
  console.log(`${c.bold}Compaction:${c.reset} OpenClaw's built-in LegacyContextEngine handles compaction`);
  console.log(`by default. Install a third-party context-engine plugin (hermes-lcm, etc.)`);
  console.log(`if you want a different compaction strategy. ClawMem injects pre-emptive`);
  console.log(`precompact state via ${c.cyan}before_prompt_build${c.reset} when token usage approaches the`);
  console.log(`compaction threshold.`);
  console.log();
  console.log(`${c.dim}ClawMem will work alongside Claude Code hooks — both modes share the same vault.${c.reset}`);

  if (migrationApplied) {
    console.log();
    console.log(`${c.green}✓ Upgrade migration applied — restart OpenClaw to pick up the new plugin kind.${c.reset}`);
  }
  if (!ownershipVerified) {
    console.log();
    console.log(`${c.yellow}Plugin files installed but ownership NOT verified for the gateway's runtime user — see the notes above. OpenClaw refuses plugins owned by another user.${c.reset}`);
  }
}

function findClawmemBinary(): string {
  // Check common locations
  const candidates = [
    pathResolve(import.meta.dir, "..", "bin", "clawmem"),
    pathResolve(process.env.HOME || "~", ".local", "bin", "clawmem"),
    "/usr/local/bin/clawmem",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "clawmem"; // Assume in PATH
}

// =============================================================================
// Watch (File Watcher Daemon)
// =============================================================================

/**
 * 62.1 D11: the stop-pipeline worker for `clawmem watch` — the one-time preparation first (overwritten antipattern
 * bodies preserved, then the counter recompute of each vault whose marker is absent; both yield between chunks), then
 * a tick every 60 s over the general vault and every configured named vault.
 */
async function startStopWorkerForWatch(s: StoreType): Promise<import("./stop-worker.ts").StopWorkerHandle> {
  const { startStopPipelineWorker } = await import("./stop-worker.ts");
  const { recomputeCounters, recomputeDone } = await import("./stop-repair.ts");
  const { preserveAntipatternBodies } = await import("./stop-recover.ts");
  const { stopPipelineReady } = await import("./stop-schema.ts");
  const { resolveStore } = await import("./store.ts");
  const { listVaults, loadVaultConfig } = await import("./config.ts");
  const log = (msg: string) => console.log(`${c.dim}${msg}${c.reset}`);
  const opened = new Map<string, StoreType>();
  const vaults = () => {
    const names = listVaults();
    for (const [name, st] of opened) if (!names.includes(name)) { try { st.close(); } catch { /* closed */ } opened.delete(name); }
    for (const name of names) {
      if (opened.has(name)) continue;
      try { opened.set(name, resolveStore(name)); } catch { /* unavailable this tick */ }
    }
    return [...opened].map(([name, store]) => ({ name, store }));
  };
  const pause = () => new Promise<void>(r => setTimeout(r, 0));
  const prepare = async () => {
    if (!stopPipelineReady(s.db)) { log(`[stop-worker] the stop-pipeline schema is not verified on this vault — run 'clawmem doctor'`); return; }
    const copied = await preserveAntipatternBodies(s.db, { pause });
    if (copied > 0) log(`[stop-worker] preserved ${copied} overwritten antipattern bodies (see 'clawmem recover antipatterns')`);
    for (const v of [{ name: "general", store: s }, ...vaults()]) {
      if (!stopPipelineReady(v.store.db) || recomputeDone(v.store.db)) continue;
      log(`[stop-worker] ${v.name}: recomputing feedback counters from verified references (one time)`);
      const r = await recomputeCounters(v.store.db, { apply: true, policy: loadVaultConfig().lifecycle, pause });
      log(`[stop-worker] ${v.name}: recompute done [op ${r.opId}] — documents ${r.documents} (grace ${r.graced}), utility ${r.utility}, co-activations ${r.coActivationsDeleted} → ${r.coActivationsInserted}, usage relations ${r.relationsDeleted} → ${r.relationsInserted}`);
    }
  };
  return startStopPipelineWorker(s, vaults, getDefaultLlamaCpp(), {
    prepare, log,
  });
}

async function cmdWatch() {
  const { startWatcher } = await import("./watcher.ts");
  const collections = collectionsList()
    .sort((a, b) => b.path.length - a.path.length); // Most specific path first for prefix matching

  const dirs = collections.map(col => col.path);
  const s = getStore();

  // v0.8.2 Codex Turn 1 fix: register signal handlers BEFORE any async
  // startup work or worker startup. Resources are declared as null and
  // assigned once their respective creators run; the shutdown closure
  // captures the variable references so updates after registration are
  // visible. Without this ordering, a SIGTERM arriving during the brief
  // window between the worker startup banner and the handler registration
  // would terminate the watcher via the default signal action (exit 143)
  // instead of running the async drain → release → close sequence.
  let stopHeavyLane: (() => Promise<void>) | null = null;
  let watcherHandle: { close: () => void } | null = null;
  let checkpointTimerHandle: Timer | null = null;
  let prewarmTimerHandle: ReturnType<typeof setInterval> | null = null;
  let vectorDaemonHandle: VectorDaemonHandle | null = null;
  let stopWorker: import("./stop-worker.ts").StopWorkerHandle | null = null;

  // Graceful shutdown — stop workers, close watchers, then exit. SIGTERM
  // handling is critical for systemd `systemctl --user stop` to shut down
  // cleanly instead of being killed by the unit timeout. Both worker stops
  // are awaited so any mid-tick worker drains and releases its lease via
  // its own withWorkerLease finally block before we close the store.
  const shutdown = async (signal: string) => {
    console.log(`\n${c.dim}[watch] Received ${signal}, shutting down...${c.reset}`);
    // Clear the periodic prewarm FIRST — before the awaited worker drains below. The timer is
    // unref'd but still fires while the loop is alive; a tick landing mid-drain would run the
    // synchronous ~1.5 GB scan and delay shutdown. Clearing it here is the only guard against that.
    if (prewarmTimerHandle) {
      clearInterval(prewarmTimerHandle);
      prewarmTimerHandle = null;
    }
    // Stop the vector daemon early — before the awaited worker drain below — so no new socket-driven
    // scan starts mid-shutdown. close() stops the listener and unlinks the socket file.
    if (vectorDaemonHandle) {
      vectorDaemonHandle.close();
      vectorDaemonHandle = null;
    }
    if (stopHeavyLane) {
      await stopHeavyLane();
      stopHeavyLane = null;
    }
    await stopConsolidationWorker();
    if (stopWorker) {
      await stopWorker.stop();
      stopWorker = null;
    }
    if (checkpointTimerHandle) {
      clearInterval(checkpointTimerHandle);
      checkpointTimerHandle = null;
    }
    if (watcherHandle) {
      watcherHandle.close();
      watcherHandle = null;
    }
    closeStore();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  // 62.1 D11: the stop-pipeline worker (and, with no collection to watch, the vector daemon) start before anything that
  // needs a collection — the worker drains what no later Stop will, on a vault with no collections too.
  stopWorker = await startStopWorkerForWatch(s);
  console.log(`${c.dim}[watch] stop-pipeline worker started (every 60s)${c.reset}`);

  // Periodic WAL checkpoint: the watcher holds a long-lived DB connection which
  // prevents SQLite auto-checkpoint from shrinking the WAL file. Without this,
  // the WAL grows unbounded (observed 77MB+), slowing every concurrent DB access
  // (hooks, MCP) and eventually causing UserPromptSubmit hook timeouts.
  const WAL_CHECKPOINT_INTERVAL = 5 * 60 * 1000; // 5 minutes
  checkpointTimerHandle = setInterval(() => {
    try {
      s.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // Checkpoint failed (busy) — will retry next interval
    }
  }, WAL_CHECKPOINT_INTERVAL);

  if (collections.length === 0) {
    console.log(`${c.yellow}!${c.reset} No collections configured — nothing to watch; the stop-pipeline worker and the vector daemon keep running. Add one with: clawmem collection add <path> --name <name>`);
    vectorDaemonHandle = await startVectorDaemon(s, (msg) => console.log(`${c.dim}${msg}${c.reset}`));
    // Block forever — shutdown is driven by signal handlers registered above.
    await new Promise(() => {});
  }

  console.log(`${c.bold}Watching ${dirs.length} collection(s) for changes...${c.reset}`);
  for (const col of collections) {
    console.log(`  ${c.dim}${col.name}: ${col.path}${c.reset}`);
  }
  console.log(`${c.dim}Press Ctrl+C to stop.${c.reset}`);

  // v0.8.2: Light + heavy maintenance lane workers (opt-in via env vars).
  // Hosting them in `cmdWatch` makes the long-lived watcher service the
  // canonical host for both lanes — `clawmem-watcher.service` runs 24/7
  // under systemd, so the heavy lane's quiet-window logic actually sees a
  // live worker at the configured hours regardless of whether any Claude
  // Code session is open. `cmdMcp` (stdio MCP) keeps the same env-var
  // gates as a fallback host, but warns when CLAWMEM_HEAVY_LANE=true
  // since per-session MCPs are short-lived. Both hosts share the same
  // DB-backed `worker_leases` exclusivity (heavy lane v0.8.0, light lane
  // v0.8.2), so running both at once is safe.
  if (Bun.env.CLAWMEM_ENABLE_CONSOLIDATION === "true") {
    const llm = getDefaultLlamaCpp();
    const intervalMs = parseInt(Bun.env.CLAWMEM_CONSOLIDATION_INTERVAL || "300000", 10);
    console.log(`${c.dim}[watch] Starting consolidation worker (light lane, interval=${intervalMs}ms)${c.reset}`);
    startConsolidationWorker(s, llm, intervalMs);
  }
  if (Bun.env.CLAWMEM_HEAVY_LANE === "true") {
    const llm = getDefaultLlamaCpp();
    const cfg = parseHeavyLaneConfigFromEnv();
    console.log(`${c.dim}[watch] Starting heavy maintenance lane worker${c.reset}`);
    stopHeavyLane = startHeavyMaintenanceWorker(s, llm, cfg);
  }

  // Prewarm the sqlite-vec chunks into OS page cache ONCE, in the single long-lived watcher
  // process only (never in the per-session MCP processes — N concurrent cold scans would be an
  // I/O storm). The context-surfacing UserPromptSubmit hook runs a SYNCHRONOUS sqlite-vec MATCH
  // that cannot be time-bounded in-thread (bun:sqlite exposes no interrupt); a cold ~1.5 GB scan
  // can blow the hook's 8-15s budget. A single warm scan here keeps the hook-path scan sub-second.
  // Deferred + best-effort so it never delays watcher startup and never throws.
  setTimeout(() => {
    try {
      // prewarmVectors is embed-independent and returns true ONLY when a scan actually ran,
      // so we never log a false-positive "prewarmed" (embed down at boot / no vectors yet).
      if (prewarmVectors(s.db)) console.log(`${c.dim}[watch] vector cache prewarmed${c.reset}`);
    } catch { /* best-effort: unexpected SQL error */ }
  }, 0);

  // B5 Option C: keep the vector payload warm against OS page-cache eviction BETWEEN hook calls.
  // The one-shot prewarm above warms once; on a long-running host under memory pressure the kernel
  // can evict the payload and let a cold synchronous MATCH creep back into the context-surfacing
  // hook path. Re-touching the pages on an interval biases the kernel LRU toward keeping them
  // resident (a PROBABILITY reduction, not a hard cap — the hard cap is the deferred BACKLOG
  // Source 46 daemon). Cleared FIRST in shutdown(); the handle is unref'd so it never keeps the
  // process alive by itself. resolvePrewarmIntervalMs enforces a strict parse + 60s floor so a
  // stray tiny value (e.g. "1", or "1e3" which parseInt would read as 1) cannot schedule a
  // near-continuous scan loop. Set CLAWMEM_PREWARM_INTERVAL_MS=0 to disable. Default 10 min.
  const prewarmIntervalMs = resolvePrewarmIntervalMs(Bun.env.CLAWMEM_PREWARM_INTERVAL_MS);
  prewarmTimerHandle = startPeriodicPrewarm(s.db, prewarmIntervalMs);
  if (prewarmTimerHandle) {
    console.log(`${c.dim}[watch] periodic vector prewarm every ${Math.round(prewarmIntervalMs / 1000)}s${c.reset}`);
  }

  // BACKLOG Source 46: vector-query daemon — HARD cap on the cold synchronous MATCH. Runs Step 1 off
  // the hook's event loop on this long-lived watcher; the hook connects only when the socket exists,
  // so it is a pure optimization layer (null on bind failure → the hook keeps its in-process fallback).
  vectorDaemonHandle = await startVectorDaemon(s, (msg) => console.log(`${c.dim}${msg}${c.reset}`));

  watcherHandle = startWatcher(dirs, {
    debounceMs: 2000,
    onChanged: async (fullPath, event) => {
      // Beads: trigger sync on any change within .beads/ directory
      // Dolt backend writes to .beads/dolt/ — watch for any file change there
      if (fullPath.includes(".beads/")) {
        const col = collections.find(c => pathWithin(c.path, fullPath) !== null);
        if (!col) return;
        const projectDir = detectBeadsProject(fullPath.replace(/\/\.beads\/.*$/, ""));
        if (projectDir) {
          const relativePath = pathWithin(col.path, fullPath);
          console.log(`${c.dim}[${event}]${c.reset} ${col.name}/${relativePath}`);
          const result = await s.syncBeadsIssues(projectDir);
          console.log(`  beads: +${result.created} ~${result.synced}`);
        }
        return;
      }

      // Re-index every collection whose index pass would take this file. The quick
      // pattern check runs before any DB access, so broad path collections (e.g.
      // ~/Projects) with narrow patterns (e.g. a single filename) do not touch the DB
      // on every .md change under the tree. Since v0.40.1 it matches the way an index
      // pass scans, and an event reaches every such collection, not only the longest path.
      for (const target of watchTargets(collections, fullPath)) {
        console.log(`${c.dim}[${event}]${c.reset} ${target.col.name}/${target.relativePath}`);
        const stats = await indexCollection(s, target.col.name, target.col.path, target.col.pattern);
        if (stats.added > 0 || stats.updated > 0 || stats.removed > 0) {
          console.log(`  +${stats.added} ~${stats.updated} -${stats.removed}${enrichSummaryNote(stats)}`);
        }
      }
    },
    onError: (err) => {
      console.error(`${c.red}Watch error: ${err.message}${c.reset}`);
    },
  });

  // Block forever — shutdown is driven by signal handlers registered above.
  await new Promise(() => {});
}

// =============================================================================
// Reindex
// =============================================================================

/**
 * Truthful one-liner for a profile rebuild outcome (§55.6 D9).
 *
 * A FORGOTTEN profile deliberately gets no "restore it first" advice: `lifecycle_restore` only
 * reverses archival, so pointing a user at it would prescribe a capability that does not exist.
 */
function profileOutcomeMessage(outcome: ProfileUpdateOutcome, auto: boolean): string {
  switch (outcome) {
    case "rebuilt":
      return auto ? "Profile auto-rebuilt (stale)" : "Profile rebuilt";
    case "held-archive":
      return "Profile not rebuilt — it is archived. Restore it (lifecycle_restore), then rebuild.";
    case "held-forget":
      return "Profile not rebuilt — it was forgotten, and ClawMem will not rebuild over a forgotten document. There is no supported restore for a forgotten document yet.";
    case "failed":
      return "Profile not rebuilt — the write failed.";
  }
}

async function cmdReindex(args: string[]) {
  const force = args.includes("--force") || args.includes("-f");
  const enrich = args.includes("--enrich");
  const collections = collectionsList();

  if (collections.length === 0) {
    die("No collections configured.");
  }

  const s = getStore();

  if (force) {
    // §55.6 D7: `--force` re-parses and rewrites every file (see the `force` option threaded
    // into indexCollection below). It NO LONGER blanket-deactivates the vault first — that
    // `UPDATE documents SET active = 0` hit every collection, including `_clawmem`, whose
    // database-created rows have no filesystem source and so were never reconstructed. It set
    // no `archived_at`, so `lifecycle_restore` could not see them either.
    console.log(`${c.yellow}Force reindex: re-reading every file (content-hash check bypassed)${c.reset}`);
  }

  if (enrich) {
    console.log(`${c.cyan}Full enrichment: entity extraction + links + evolution for all documents${c.reset}`);
  }

  for (const col of collections) {
    console.log(`Indexing ${c.bold}${col.name}${c.reset} (${col.path})...`);
    const stats = await indexCollection(s, col.name, col.path, col.pattern, { forceEnrich: enrich, force });
    console.log(`  +${stats.added} added, ~${stats.updated} updated, =${stats.unchanged} unchanged, -${stats.removed} removed${enrichSummaryNote(stats)}`);
  }
}

// =============================================================================
// Doctor (Health Check)
// =============================================================================

/**
 * `clawmem vec-daemon-health [--db <path>] [--json]` — the machine-decisive
 * form of the doctor's vector-daemon check (codex t77 F5 / t89 P1): exit 0
 * ONLY for the Path-A-AUTHORITATIVE state `live` — the pong names exactly
 * this DB + the owning pid AND advertises BOTH the hydrated-v1 response
 * protocol and the O1 deadline-rel-v1 relative-budget protocol.
 * The liveness-without-authority tiers exit 1: `live-raw` (attested but not
 * hydrated-capable — serves the raw-hit execution) and `live-legacy` (a
 * pre-v0.38 watcher: an idle daemon-protocol listener that cannot attest).
 * JSON carries `live` (any listener), `attested`, and `authoritative`
 * separately. Shipping preflights gate on this; a socket glob is not
 * evidence of a listener.
 */
async function cmdVecDaemonHealth(args: string[]) {
  const { values } = parseArgs({ args, options: { db: { type: "string" }, json: { type: "boolean", default: false }, "timeout-ms": { type: "string", default: "2000" } } });
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) die("--timeout-ms must be a positive integer");
  const dbPath = values.db ? pathResolve(values.db) : getStore().dbPath;
  const h = await vectorDaemonHealth(dbPath, timeoutMs);
  // t89 P1: exit 0 is reserved for the Path-A-AUTHORITATIVE daemon — exact DB/pid AND the
  // hydrated-v1 capability. live-raw/live-legacy prove a listener (liveness) but execute the
  // client-side-hydration timing, which is not the contract the deadline certifies.
  const authoritative = h.status === "live";
  const listening = authoritative || h.status === "live-raw" || h.status === "live-legacy";
  if (values.json) {
    console.log(JSON.stringify({ ...h, checked_db: dbPath, live: listening, authoritative, attested: h.status === "live" || h.status === "live-raw" }));
  } else if (h.status === "live") {
    console.log(`${c.green}✓${c.reset} vector daemon LIVE for ${dbPath} (pid ${h.pid}, ${h.socket}) — hydrated-v1 + deadline-rel-v1 attested; the hook's vector deadline is authoritative`);
  } else if (h.status === "live-raw") {
    console.log(`${c.yellow}⚠${c.reset} vector daemon LIVE but NOT fully capable for ${dbPath} (pid ${h.pid}, ${h.socket}; advertised: ${h.protocols.join(", ") || "none"}) — the deadline contract needs hydrated-v1 AND deadline-rel-v1; restart 'clawmem watch' on v0.38+ for the deadline-authoritative path`);
  } else if (h.status === "live-legacy") {
    console.log(`${c.yellow}⚠${c.reset} vector daemon LIVE (legacy, unattested) for ${dbPath} (${h.socket}) — a pre-v0.38 watcher; restart it on v0.38 to attest DB/pid and serve hydrated-v1`);
  } else {
    console.log(`${c.red}✗${c.reset} vector daemon ${h.status} for ${dbPath} (${h.socket}) — run 'clawmem watch' (or restart it); the hook's vector deadline is unbounded without it`);
  }
  process.exitCode = authoritative ? 0 : 1;
}

/**
 * v0.41.2 (BACKLOG 68.5, design §1.7): the observer's view of the LLM server — its context and where that number came
 * from, how prompts are counted, and how much transcript one observer window holds after the system prompt and a full
 * reply reserve. `!` when that is small on a measured/configured context, or when any part is best-effort.
 */
async function doctorLlmContext(): Promise<void> {
  try {
    // The observer's mean call as the Stop pipeline last measured it (codex T11-13; the worker needs ≤ 18 s to progress).
    let meanCall = "mean observer call not measured yet (4 s assumed)";
    let slowCall = false;
    try {
      const { OBSERVER_CALL_MEAN_FLAG } = await import("./stop-extract.ts");
      const row = getStore().db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(OBSERVER_CALL_MEAN_FLAG) as { value: string } | null;
      const v = row ? JSON.parse(row.value) as { ms?: unknown; samples?: unknown } : null;
      if (v && typeof v.ms === "number" && typeof v.samples === "number") {
        meanCall = `mean observer call ${(v.ms / 1000).toFixed(1)} s (latest ${v.samples} call(s))`;
        slowCall = v.ms > 18_000;
      }
    } catch { /* an unreadable record keeps the default text */ }
    const { observerReplyReserve, observerRequestedCount, observationSystemPrompt } = await import("./observer.ts");
    const llm = getDefaultLlamaCpp();
    const deadline = deadlineAfter(monoNow(), duration(10_000));
    const cap = await llm.llmCapacityForDoctor({ deadline });
    if (!cap) return;
    const reserve = observerReplyReserve(cap.nCtx);
    const fixedPrompt = `${observationSystemPrompt(observerRequestedCount(reserve))}\n\n--- TRANSCRIPT ---\n\n--- END TRANSCRIPT ---\n\nExtract observations:`;
    const fixed = await llm.countChatTokens(llm.outboundChatContent(fixedPrompt, cap.backend), cap, { deadline });
    const window = cap.nCtx - reserve - fixed.tokens - fixed.margin;
    const how = fixed.method === "template" ? "template-exact" : fixed.method === "content" ? "content + template margin" : "estimate";
    const line = `LLM context: ${cap.nCtx} tokens (${cap.source === "measured" ? "measured via /props" : cap.source === "configured" ? "CLAWMEM_LLM_CONTEXT_TOKENS" : "assumed default"}); counting ${how}; fingerprint ${cap.fingerprintStrength} — an observer window holds ${window} transcript tokens (${reserve}-token reply); ${meanCall}`;
    const bestEffort = cap.source === "assumed" || fixed.method !== "template";
    if (slowCall) {
      console.log(`${c.yellow}!${c.reset} ${line}. One observer call takes longer than the watcher's 18-s slice, so long turns progress only through Stops — use a faster model or GPU`);
    } else if (cap.source !== "assumed" && window < 1_000) {
      console.log(`${c.yellow}!${c.reset} ${line}. Observer windows are small — raise the server's context (llama-server -c 8192, about +470 MiB VRAM measured)`);
    } else if (bestEffort) {
      console.log(`${c.yellow}!${c.reset} ${line}. Prompt fits are best-effort here${cap.source === "assumed" ? " — set CLAWMEM_LLM_CONTEXT_TOKENS or serve /props" : " — the server does not serve /apply-template"}`);
    } else {
      console.log(`${c.green}✓${c.reset} ${line}`);
    }
  } catch (err) {
    console.log(`${c.yellow}!${c.reset} LLM context: could not check (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function cmdDoctor() {
  console.log(`${c.bold}ClawMem Doctor${c.reset}\n`);
  let issues = 0;

  // 1. Database
  try {
    const s = getStore();
    const docCount = (s.db.prepare("SELECT COUNT(*) as n FROM documents WHERE active = 1").get() as any).n;
    console.log(`${c.green}✓${c.reset} Database: ${s.dbPath} (${docCount} documents)`);
  } catch (err) {
    console.log(`${c.red}✗${c.reset} Database: ${err}`);
    issues++;
  }

  // 1b. 62.1 D10: the stop pipeline — migration and fence, older writers the fence caught, the one-time counter
  // recompute, and the queues the watcher drains.
  try {
    const s = getStore();
    const { stopPipelineHealth, isStale } = await import("./stop-health.ts");
    const h = stopPipelineHealth(s.db);
    if (h.missing.length > 0) {
      console.log(`${c.red}✗${c.reset} Stop pipeline: migration incomplete (${h.missing.slice(0, 4).join(", ")}${h.missing.length > 4 ? ", …" : ""}) — Stop hooks skip counter and cursor work until a writable open completes it`);
      issues++;
    } else {
      console.log(`${c.green}✓${c.reset} Stop pipeline: schema and fence installed`);
    }
    if (h.legacyWritersRecent.length > 0) {
      const w = h.legacyWritersRecent.slice(0, 4).map(x => `${x.surface} ×${x.count}, last ${x.lastAt.slice(0, 16)}`).join("; ");
      console.log(`${c.red}✗${c.reset} Stop pipeline: an older ClawMem still writes to this vault — its Stop-hook writes were ignored and logged (${w}). Upgrade every ClawMem process that shares this vault`);
      issues++;
    } else if (h.legacyWriters.length > 0) {
      console.log(`${c.dim}   an older ClawMem wrote to this vault before (last ${h.legacyWriters[0]!.lastAt.slice(0, 16)}); nothing caught in the last 24 h${c.reset}`);
    }
    if (h.missing.length === 0) {
      if (h.recomputeDone) console.log(`${c.green}✓${c.reset} Stop pipeline: feedback counters recomputed from verified references`);
      else console.log(`${c.yellow}!${c.reset} Stop pipeline: counter recompute pending — 'clawmem watch' runs it once at start (or run 'clawmem repair counters --apply')`);
      const queues: [string, import("./stop-health.ts").QueueHealth][] = [
        ["quarantined ranges", h.stopRetries], ["pending feedback turns", h.feedbackPending],
        ["deferred judge verdicts", h.judgeDeferred], ["handoff renders", h.handoffRenders],
      ];
      const stale = queues.filter(([, q]) => isStale(q));
      const depths = queues.map(([n, q]) => `${n} ${q.count}`).join(", ");
      if (stale.length > 0) {
        console.log(`${c.yellow}!${c.reset} Stop pipeline queues: ${depths} — ${stale.map(([n, q]) => `${n} oldest ${q.oldest!.slice(0, 16)}`).join("; ")} (older than 24 h: is 'clawmem watch' running? Drain by hand: clawmem repair stop-queue --run)`);
      } else {
        console.log(`${c.green}✓${c.reset} Stop pipeline queues: ${depths}`);
      }
      if (h.unavailableRanges > 0) console.log(`${c.dim}   ${h.unavailableRanges} quarantined range(s) unavailable (their bytes changed) — dismiss with: clawmem repair stop-queue --dismiss <id>${c.reset}`);
      if (h.feedbackProvisional.count > 0) console.log(`${c.dim}   ${h.feedbackProvisional.count} feedback verdict(s) provisional — credited on a quiet transcript, final at the turn's end (a later turn, a Stop, the session's end); oldest ${h.feedbackProvisional.oldest!.slice(0, 16)}${c.reset}`);
      if (h.keylessPending > 0) console.log(`${c.dim}   ${h.keylessPending} feedback turn(s) wait for their OpenClaw transcript to be bound${c.reset}`);
      if (h.causalWaitingOff > 0) console.log(`${c.yellow}!${c.reset} Stop pipeline: ${h.causalWaitingOff} causal step(s) wait while CLAWMEM_CAUSAL_WRITER=off (they run when it is shadow/on; dismiss with: clawmem repair stop-queue --dismiss-causal)`);
      else if (h.causalRunnable > 0) console.log(`${c.dim}   ${h.causalRunnable} causal step(s) owed — the watcher runs them${c.reset}`);
      if (h.causalStuck > 0) console.log(`${c.yellow}!${c.reset} Stop pipeline: ${h.causalStuck} causal run(s) still in progress after 1 h (a crash inside the step — at-most-once, not re-run)`);
      // v0.41.4 (68.2, §6.2): runs older than a day are history, not a live problem — reported once, as information.
      if (h.causalStale > 0) console.log(`${c.dim}   ${h.causalStale} unfinished causal run(s) older than 24 hours; not automatically replayed${c.reset}`);
      if (h.recoveredBodies > 0) console.log(`${c.dim}   ${h.recoveredBodies} overwritten antipattern bodies preserved — review with: clawmem recover antipatterns${c.reset}`);
      if (h.graceByWeek.some(n => n > 0)) console.log(`${c.dim}   archive grace expiries per coming week: ${h.graceByWeek.join(", ")}${c.reset}`);
      // v0.41.2 (BACKLOG 68.5): the observer's held capacity failures, its continuations and checkpoints, and what it could not see.
      const capacityHeld = (s.db.prepare(`SELECT COUNT(*) AS n FROM stop_retries WHERE state IN ('queued', 'claimed') AND last_error LIKE 'capacity:%'`).get() as { n: number }).n;
      if (capacityHeld > 0) {
        const last = (s.db.prepare(`SELECT last_error FROM stop_retries WHERE state IN ('queued', 'claimed') AND last_error LIKE 'capacity:%' ORDER BY id DESC LIMIT 1`).get() as { last_error: string }).last_error;
        console.log(`${c.yellow}!${c.reset} Stop pipeline: ${capacityHeld} range(s) held because the observer's prompt cannot fit the LLM server's context (${last.slice(0, 160)}) — raise the server's context (llama-server -c); they replay by themselves`);
      }
      // v0.41.4 (§7.3): why ranges are held, by class — a legacy reason (v0.41.2–3) reads `legacy (unclassified)`.
      if (h.heldByClass.length > 0) {
        const held = h.heldByClass.reduce((n, [, k]) => n + k, 0);
        console.log(`${c.yellow}!${c.reset} Stop pipeline: ${held} range(s) held after failed attempts — held ranges by class: ${h.heldByClass.map(([cls, n]) => `${cls} ${n}`).join(", ")}. They retry on their own backoff; retry them now: clawmem repair stop-queue --retry-now held --run`);
      }
      // v0.41.4 (§4.4, §4.5): grammar refusals and what completed replies to grammar requests showed.
      for (const row of s.db.prepare(`SELECT value FROM vault_flags WHERE flag LIKE 'observer-grammar:%'`).all() as { value: string }[]) {
        try {
          const g = JSON.parse(row.value) as { offUntil?: string; pending?: boolean; cause?: string };
          if (typeof g.offUntil !== "string") continue;
          // codex T7-7: an in-process compile failure is a known cause; an HTTP 400's is not (§4.4).
          const why = g.cause === "compile" ? "after the in-process model could not compile the grammar" : "after an HTTP 400 on a grammar request (cause unconfirmed)";
          const owed = g.pending === true ? "; a grammarless request must reach the server before the grammar is used again" : "";
          if (Date.parse(g.offUntil) > epochMs(epochNow())) {
            console.log(`${c.dim}   observer: grammar off until ${g.offUntil.slice(0, 16)} ${why}${owed}${c.reset}`);
          } else if (g.pending === true) {
            console.log(`${c.dim}   observer: grammar off ${why} until a grammarless request reaches the server${c.reset}`);
          }
        } catch { /* a malformed record is skipped */ }
      }
      const statsRow = s.db.prepare(`SELECT value FROM vault_flags WHERE flag = 'observer_stats'`).get() as { value: string } | null;
      if (statsRow) {
        try {
          const v = JSON.parse(statsRow.value) as { backends?: Record<string, Record<string, unknown>> };
          const sum = (f: string) => Object.values(v.backends ?? {}).reduce((n, b) => n + (typeof b[f] === "number" ? b[f] as number : 0), 0);
          const lastAt = Object.values(v.backends ?? {}).map(b => String(b.at ?? "")).sort().at(-1)?.slice(0, 16) ?? "?";
          const structural = sum("grammarStructural");
          if (structural > 0) console.log(`${c.yellow}!${c.reset} Stop pipeline: ${structural} completed replies to grammar requests failed structurally — the server may be ignoring the grammar (last ${lastAt}; see docs/troubleshooting.md)`);
          const content = sum("grammarContent");
          const echoes = sum("instructionEcho") + sum("eventDefinitionEcho");
          const dropped = sum("tripleToolId") + sum("tripleSelf") + sum("identifierResidue") + sum("repeatedFact");
          if (content + echoes + dropped > 0) {
            console.log(`${c.dim}   observer: ${content} grammar reply(ies) rejected on content; ${echoes} prompt-clause echo(es) kept and counted; ${dropped} residue item(s) dropped (tool-call-id or self triples, skeleton identifiers, repeated facts)${c.reset}`);
          }
        } catch { /* a malformed record is skipped */ }
      }
      const continuations = (s.db.prepare(`SELECT COUNT(*) AS n FROM stop_retries WHERE state IN ('queued', 'claimed') AND last_error LIKE 'continuation:%'`).get() as { n: number }).n;
      // codex T12-6: a continuation whose server could not be verified waits until its /props answers again, however long.
      const unverified = (s.db.prepare(`SELECT COUNT(*) AS n FROM stop_retries WHERE state IN ('queued', 'claimed') AND last_error LIKE 'continuation:%could not be verified%'`).get() as { n: number }).n;
      if (continuations > 0) {
        const waiting = unverified > 0 ? `; ${unverified} wait for their LLM server to answer /props again (it could not be verified)` : "";
        console.log(`${c.dim}   observer: ${continuations} continuation(s) queued — the watcher resumes them${waiting}${c.reset}`);
      }
      // codex T11-10: a live checkpoint no queued range owns (its Stop ended before queueing the range) is reached only
      // by a later Stop of its transcript — the worker replays queued ranges, never bare checkpoints. A range is matched
      // by its full identity, as the sweep matches it (codex T12-3). codex T13-2, T14-2: one behind the transcript's
      // cursor (a dismissed or superseded range) is never reached again; a first Stop's that saved no cursor can still be,
      // by a later Stop that reads the same range, until the sweep's 7 days.
      const { parseCheckpoint, checkpointHeld, checkpointBehindCursor } = await import("./stop-checkpoint.ts");
      let ahead = 0;
      let firstStop = 0;
      let behind = 0;
      for (const row of s.db.prepare(`SELECT value FROM vault_flags WHERE flag LIKE 'observer-ckpt:%'`).all() as { value: string }[]) {
        const ck = parseCheckpoint(row.value);   // a malformed checkpoint is reset by the processor that next reaches its unit
        if (ck?.state !== "live" || checkpointHeld(s.db, ck)) continue;
        const past = checkpointBehindCursor(s.db, ck);
        if (past === false) ahead++;
        else if (past === null) firstStop++;
        else behind++;
      }
      if (ahead > 0) console.log(`${c.dim}   observer: ${ahead} live checkpoint(s) without a queued range — a later Stop resumes each one it reaches unchanged${c.reset}`);
      if (firstStop > 0) console.log(`${c.dim}   observer: ${firstStop} first-Stop checkpoint(s) with no cursor — a later Stop that reads the same range resumes it; the watcher's sweep removes them after 7 days${c.reset}`);
      if (behind > 0) console.log(`${c.dim}   observer: ${behind} checkpoint(s) behind their transcript's cursor (a dismissed or superseded range) — no later Stop reaches them; the watcher's sweep removes them${c.reset}`);
      const droppedRow = s.db.prepare(`SELECT value FROM vault_flags WHERE flag = 'observer_accumulator_dropped'`).get() as { value: string } | null;
      if (droppedRow) {
        try {
          const d = JSON.parse(droppedRow.value) as { total?: number; ranges?: number; recent?: { range_key: string; at: string }[] };
          const lastAt = d.recent?.at(-1)?.at?.slice(0, 16) ?? "?";
          console.log(`${c.yellow}!${c.reset} Stop pipeline: ${d.total ?? 0} message(s) in ${d.ranges ?? 0} range(s) were beyond the observer's 100-message window (a very long turn); last ${lastAt}`);
        } catch { /* a malformed tally is skipped */ }
      }
    }
  } catch (err) {
    console.log(`${c.red}✗${c.reset} Stop pipeline: could not check (${err instanceof Error ? err.message : String(err)})`);
    issues++;
  }

  // 2. Collections
  try {
    const collections = collectionsList();
    if (collections.length === 0) {
      console.log(`${c.yellow}!${c.reset} No collections configured`);
      issues++;
    } else {
      for (const col of collections) {
        if (existsSync(col.path)) {
          console.log(`${c.green}✓${c.reset} Collection "${col.name}": ${col.path}`);
        } else {
          console.log(`${c.red}✗${c.reset} Collection "${col.name}": ${col.path} (directory not found)`);
          issues++;
        }
      }
    }
  } catch (err) {
    console.log(`${c.red}✗${c.reset} Collections config: ${err}`);
    issues++;
  }

  // 2b. Vector daemon (the watcher's per-vault socket) — codex t77 F5: the
  // v0.38.0 latency contract is scoped to daemon-backed deployments, so the
  // deployed vault's daemon liveness is an operational health fact, checked
  // by a real round trip (a socket file alone is not a listener).
  try {
    const s = getStore();
    const h = await vectorDaemonHealth(s.dbPath);
    if (h.status === "live") {
      console.log(`${c.green}✓${c.reset} Vector daemon: live (pid ${h.pid}) on ${h.socket} — hydrated-v1 + deadline-rel-v1 attested; the context-surfacing hook's vector deadline is authoritative on this host`);
    } else if (h.status === "live-raw") {
      // t89 P1 + O1 §4: liveness without deadline authority — the daemon serves the raw-hit
      // execution or ignores the relative budget, not the certified Path-A contract.
      console.log(`${c.yellow}⚠${c.reset} Vector daemon: live (pid ${h.pid}) on ${h.socket} but NOT fully capable (advertised: ${h.protocols.join(", ") || "none"}) — the deadline contract needs hydrated-v1 AND deadline-rel-v1; restart 'clawmem watch' on v0.38+ for the deadline-authoritative path`);
      issues++;
    } else if (h.status === "live-legacy") {
      console.log(`${c.yellow}⚠${c.reset} Vector daemon: live on ${h.socket} (pre-v0.38 watcher — answers the daemon protocol but cannot attest its DB/pid, and serves the raw-hit execution; restart 'clawmem watch' on v0.38 for attested, deadline-authoritative health)`);
      issues++;
    } else {
      const why = h.status === "absent" ? "no socket — 'clawmem watch' is not running for this vault"
        : h.status === "stale" ? "stale socket (no listener) — the watcher crashed; restart 'clawmem watch'"
        : h.status === "unresponsive" ? "listener did not answer — the watcher may be wedged; restart 'clawmem watch'"
        : h.status === "foreign-db" ? `socket served for a different DB (${h.db}, pid ${h.pid}) — a foreign daemon owns this vault's socket`
        : String(h.status);
      console.log(`${c.red}✗${c.reset} Vector daemon: ${h.status} on ${h.socket} — ${why}. Without it the hook's vector leg runs in-process and its deadline cannot fire (v0.38.0: the latency contract holds for daemon-backed deployments only).`);
      issues++;
    }
  } catch (err) {
    console.log(`${c.red}✗${c.reset} Vector daemon: ${err}`);
    issues++;
  }

  // 3. Embeddings
  try {
    const s = getStore();
    const needsEmbed = s.getHashesNeedingEmbedding();
    const hasVectors = !!s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'").get();
    // ALWAYS run the consistency check — the WORST desync (content_vectors rows but
    // vectors_vec entirely absent) lives in the no-table case, so it must not be
    // skipped. set-diff, NOT counts (one missing + one orphan cancel in a count check).
    // Pending docs are reported separately — they are in neither table, not a desync.
    const vc = s.getVectorConsistency();
    if (!hasVectors && vc.cvCount === 0) {
      console.log(`${c.yellow}!${c.reset} Vector index: not created yet (run 'clawmem embed')`);
    } else if (!hasVectors) {
      console.log(`${c.red}✗${c.reset} Vector index: vectors_vec is MISSING but ${vc.cvCount} content_vectors row(s) exist — full desync. Run 'clawmem embed --force' to rebuild.`);
      issues++;
    } else {
      console.log(`${c.green}✓${c.reset} Vector index: exists (${needsEmbed} need embedding)`);
      if (vc.cvMissingVv > 0 || vc.vvOrphan > 0) {
        console.log(`${c.red}✗${c.reset} Vector consistency: ${vc.cvMissingVv} metadata row(s) missing a vector, ${vc.vvOrphan} orphan vector(s) (content_vectors=${vc.cvCount}, vectors_vec=${vc.vvCount}). Run 'clawmem embed --force' to rebuild.`);
        issues++;
      } else {
        console.log(`${c.green}✓${c.reset} Vector consistency: ${vc.vvCount} vectors match ${vc.cvCount} metadata rows (${vc.pending} pending)`);
      }
    }
    // Mixed embedding models = a heterogeneous vector space (cosine across different
    // models is meaningless) even when keys/dimensions are consistent. Flag it.
    const vecModels = s.getVecModels();
    if (vecModels.length > 1) {
      console.log(`${c.red}✗${c.reset} Embedding models: vault has MIXED models (${vecModels.join(", ")}) — heterogeneous vector space. Run 'clawmem embed --force' to rebuild with one model.`);
      issues++;
    }
  } catch (err) {
    console.log(`${c.yellow}!${c.reset} Vector index: could not check (${(err as Error).message})`);
  }

  // 4. Content types
  try {
    const s = getStore();
    const types = s.db.prepare(
      "SELECT content_type, COUNT(*) as n FROM documents WHERE active = 1 GROUP BY content_type"
    ).all() as { content_type: string; n: number }[];
    const typeStr = types.map(t => `${t.content_type}:${t.n}`).join(", ");
    console.log(`${c.green}✓${c.reset} Content types: ${typeStr || "none"}`);
  } catch {
    // Skip
  }

  // 5. Hooks installed
  try {
    const settingsPath = pathResolve(process.env.HOME || "~", ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const hasHooks = Object.values(settings.hooks || {}).some((arr: any) =>
        Array.isArray(arr) && arr.some((entry: any) =>
          entry.hooks?.some((h: any) => h.command?.includes("clawmem"))
        )
      );
      if (hasHooks) {
        console.log(`${c.green}✓${c.reset} Claude Code hooks: installed`);
        // BUILD-3a (C2c/C3): the HOST timeout must cover the hook's INTERNAL
        // budget plus the cold-start allowance — a smaller host timeout kills
        // the handler before its own deadlines can act (the internal budget is
        // authoritative; the host timeout is only the outer kill switch).
        try {
          const { parseHookBudgetConfig, readInstalledHookBudget, MAX_HOOK_BUDGET_MS, STARTUP_ALLOWANCE_MS } = await import("./hooks/context-surfacing.ts");
          // Codex migration r1 P5: EVERY installed context-surfacing entry is validated — each runs on
          // every prompt, so the last one is not the one that matters — and each entry's budget is
          // read STRUCTURALLY (`readInstalledHookBudget`): the INSTALLED budget is authoritative,
          // parsed from the command's own prefix assignment, never from this process's ambient
          // environment (codex turn-23 finding 4) and never through a token regex that keeps quotes.
          const entries: { command: string; timeoutSec: number | null }[] = [];
          for (const entry of settings.hooks?.["UserPromptSubmit"] ?? []) {
            for (const h of entry.hooks ?? []) {
              if (typeof h.command === "string" && h.command.includes("clawmem") && h.command.includes("context-surfacing")) {
                entries.push({ command: h.command, timeoutSec: typeof h.timeout === "number" ? h.timeout : null });
              }
            }
          }
          const multi = entries.length > 1;
          const effectiveBudgets = new Set<number>();
          entries.forEach((e, i) => {
            const tag = multi ? ` [entry ${i + 1}/${entries.length}]` : "";
            const installed = readInstalledHookBudget(e.command);
            if (installed.kind === "noncanonical") {
              console.log(`${c.red}✗${c.reset} Hook budget${tag}: ${installed.detail} — the value the shell passes cannot be verified, so this entry's budget is UNVERIFIED. Fix: re-run 'clawmem setup hooks' (it writes the canonical CLAWMEM_HOOK_BUDGET_MS=<integer> prefix)`);
              issues++;
              return;
            }
            const budgetConfig = installed.kind === "assigned" ? installed.config : parseHookBudgetConfig(process.env.CLAWMEM_HOOK_BUDGET_MS);
            const budgetSource = installed.kind === "assigned" ? "installed" : "ambient — pre-BUILD-3a install carries no budget; run 'clawmem setup hooks' to pin it";
            if (!budgetConfig.valid) {
              // O1 §2: an unsupported budget is a red line — every context-surfacing
              // run refuses under it — but the doctor itself never throws.
              console.log(`${c.red}✗${c.reset} Hook budget${tag}: ${budgetConfig.reason} (${budgetSource}) — the context-surfacing hook REFUSES to run under this value. Fix: set CLAWMEM_HOOK_BUDGET_MS ≤ ${MAX_HOOK_BUDGET_MS} and re-run 'clawmem setup hooks'`);
              issues++;
              return;
            }
            const budgetMs = budgetConfig.effectiveMs;
            effectiveBudgets.add(budgetMs);
            const requiredSec = Math.ceil((STARTUP_ALLOWANCE_MS + budgetMs) / 1000);
            if (e.timeoutSec === null) {
              console.log(`${c.yellow}!${c.reset} Hook timeout budget${tag}: context-surfacing entry has no timeout — run 'clawmem setup hooks' to set host timeout ≥ ${requiredSec}s (startup ${STARTUP_ALLOWANCE_MS}ms + internal budget ${budgetMs}ms)`);
            } else if (e.timeoutSec * 1000 < STARTUP_ALLOWANCE_MS + budgetMs) {
              console.log(`${c.red}✗${c.reset} Hook timeout budget${tag}: host timeout ${e.timeoutSec}s < startup ${STARTUP_ALLOWANCE_MS}ms + internal budget ${budgetMs}ms (${budgetSource}) — the host kills the hook before its internal deadlines can act. Fix: run 'clawmem setup hooks' (writes ≥ ${requiredSec}s and pins the budget), or lower CLAWMEM_HOOK_BUDGET_MS and re-run setup`);
              issues++; // a red line must contribute to doctor's failure state (codex turn-23 finding 2)
            } else {
              console.log(`${c.green}✓${c.reset} Hook timeout budget${tag}: host ${e.timeoutSec}s ≥ startup ${STARTUP_ALLOWANCE_MS}ms + internal budget ${budgetMs}ms (${budgetSource})`);
            }
          });
          if (effectiveBudgets.size > 1) {
            console.log(`${c.red}✗${c.reset} Hook budget: ${entries.length} installed context-surfacing entries CONFLICT (${[...effectiveBudgets].sort((a, b) => a - b).map(b => `${b}ms`).join(" vs ")}) — every entry runs on every prompt, so the hook executes under more than one budget. Fix: keep ONE entry (re-run 'clawmem setup hooks')`);
            issues++;
          } else if (multi) {
            console.log(`${c.yellow}!${c.reset} Claude Code hooks: ${entries.length} context-surfacing entries are installed — each runs on every prompt (the vault is surfaced once per entry); keep one`);
          }
        } catch { /* budget check is advisory — never blocks the doctor (every red line above already counted its issue) */ }
        // 62.2 (CM-05): the v0.39.x installer put postcompact-inject under matcher "", so it ran on every
        // session start. The hook itself now ignores all but compactions; re-running setup stops the spawn.
        const pcMatchers = postcompactMatcherIssues(settings);
        if (pcMatchers.length > 0) {
          console.log(`${c.yellow}!${c.reset} Claude Code hooks: postcompact-inject is installed under SessionStart matcher ${pcMatchers.map(m => `"${m}"`).join(", ")}, so it starts on every session start (it acts only on compactions). Fix: re-run 'clawmem setup hooks' (installs it under matcher "compact")`);
        }
        // 62.1 D5: the handoff's SessionEnd flush renders the turns after the last summary when a session ends.
        const sessionEndFlush = ((settings.hooks?.SessionEnd ?? []) as { hooks?: { command?: unknown }[] }[])
          .some(g => g.hooks?.some(h => clawmemHookName(h.command) === "handoff-generator"));
        if (!sessionEndFlush) {
          console.log(`${c.yellow}!${c.reset} Claude Code hooks: the SessionEnd handoff flush is not installed, so a session's last turns reach its handoff only through the watcher. Fix: re-run 'clawmem setup hooks'`);
        }
      } else {
        console.log(`${c.yellow}!${c.reset} Claude Code hooks: not installed (run 'clawmem setup hooks')`);
      }
    } else {
      console.log(`${c.yellow}!${c.reset} Claude Code hooks: settings.json not found`);
    }
  } catch {
    console.log(`${c.yellow}!${c.reset} Claude Code hooks: could not check`);
  }

  // 5b. Legacy pre-compaction state (62.2): ClawMem ≤ v0.39.x wrote precompact-state.md into Claude
  // Code's per-project memory dirs. This version's compaction hooks never use it (the doctor lists it and
  // the indexer retires its copies); ClawMem never deletes it itself. A file modified AFTER this version first opened the vault (vault_flags, store.ts) was
  // written by an older ClawMem process that is still running (and still has the cross-session leak):
  // that one is a red line.
  try {
    const legacy = legacyPrecompactStateFiles(pathResolve(process.env.HOME || "~", ".claude", "projects"));
    if (legacy.length > 0) {
      let retiredAt = NaN;
      try {
        const row = getStore().db.prepare(`SELECT updated_at FROM vault_flags WHERE flag = 'migration:retire-legacy-precompact-state'`).get() as { updated_at: string } | null;
        if (row) retiredAt = Date.parse(row.updated_at);
      } catch { /* no flag yet */ }
      const live = Number.isFinite(retiredAt) ? legacy.filter(f => f.mtimeMs > retiredAt) : [];
      if (live.length > 0) {
        console.log(`${c.red}✗${c.reset} Legacy pre-compaction state: ${live.length} precompact-state.md file(s) were written after this vault was upgraded, so an older ClawMem process is still running (hooks, watcher, MCP server, or the OpenClaw/Hermes plugin) and still has the cross-session compaction leak. Upgrade every ClawMem install that shares this vault:`);
        for (const f of live.slice(0, 5)) console.log(`    ${f.path}`);
        issues++;
      }
      console.log(`${c.yellow}!${c.reset} Legacy pre-compaction state: ${legacy.length} precompact-state.md file(s) left by ClawMem ≤ v0.39.x. Upgraded compaction hooks no longer use them; the doctor and the indexer only look at them, while an older ClawMem still running may still write and read them. Delete the files:`);
      for (const f of legacy.slice(0, 5)) console.log(`    ${f.path}`);
      if (legacy.length > 5) console.log(`    … and ${legacy.length - 5} more`);
    }
  } catch { /* advisory only */ }
  // Indexed copies of the artifact that are still active. Retrieval never returns them
  // (notLegacyArtifactSql); an index pass deactivates each one whose file it finds, and absence
  // reconciliation an 'fs' one whose file is gone. A pre-v0.34 (NULL-origin) one with no file has
  // nothing to confirm that ClawMem wrote it, so only the user removes it.
  try {
    const copies = (getStore().db.prepare(
      `SELECT d.collection, d.path, d.origin, c.doc FROM documents d LEFT JOIN content c ON c.hash = d.hash
       WHERE d.active = 1 AND substr(d.path, -19) = 'precompact-state.md'`
    ).all() as { collection: string; path: string; origin: string | null; doc: string | null }[])
      .filter(r => isLegacyPrecompactState(r.path, r.doc ?? ""));
    if (copies.length > 0) {
      console.log(`${c.yellow}!${c.reset} Legacy pre-compaction state: ${copies.length} indexed cop${copies.length === 1 ? "y" : "ies"} of an old snapshot ${copies.length === 1 ? "is" : "are"} still active. Search and retrieval never return ${copies.length === 1 ? "it" : "them"}; 'clawmem update' deactivates each one whose file is on disk or was deleted. One from before v0.34 whose file is gone stays until you forget it (MCP memory_forget with its path):`);
      for (const r of copies.slice(0, 5)) console.log(`    ${r.collection}/${r.path}${r.origin === null ? "  (pre-v0.34)" : ""}`);
      if (copies.length > 5) console.log(`    … and ${copies.length - 5} more`);
    }
  } catch { /* advisory only */ }

  // 6. MCP registered
  try {
    const claudeJsonPath = pathResolve(process.env.HOME || "~", ".claude.json");
    if (existsSync(claudeJsonPath)) {
      const config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      if (config.mcpServers?.clawmem) {
        console.log(`${c.green}✓${c.reset} MCP server: registered in ~/.claude.json`);
      } else {
        console.log(`${c.yellow}!${c.reset} MCP server: not registered (run 'clawmem setup mcp')`);
      }
    }
  } catch {
    console.log(`${c.yellow}!${c.reset} MCP server: could not check`);
  }

  // 7. Sessions
  try {
    const s = getStore();
    const sessions = s.getRecentSessions(1);
    if (sessions.length > 0) {
      console.log(`${c.green}✓${c.reset} Sessions: last session ${sessions[0]!.startedAt}`);
    } else {
      console.log(`${c.dim}-${c.reset} Sessions: none tracked yet`);
    }
  } catch {
    // Skip
  }

  // 8. OpenClaw plugin slot config (§14.3 upgrade migration check)
  try {
    const stale = readOpenClawConfigValue("plugins.slots.contextEngine");
    if (stale === "clawmem") {
      console.log(
        `${c.red}✗${c.reset} OpenClaw config: stale ${c.cyan}plugins.slots.contextEngine = "clawmem"${c.reset}`,
      );
      console.log(
        `   ${c.dim}ClawMem v0.10.0 is now a memory plugin. Run ${c.cyan}clawmem setup openclaw${c.dim} to migrate,${c.reset}`,
      );
      console.log(
        `   ${c.dim}or manually: ${c.cyan}openclaw config set plugins.slots.contextEngine legacy${c.reset}`,
      );
      issues++;
    } else if (stale && stale !== "legacy") {
      console.log(
        `${c.green}✓${c.reset} OpenClaw context-engine slot: ${c.cyan}${stale}${c.reset} (third-party LCM)`,
      );
    }
    const memSlot = readOpenClawConfigValue("plugins.slots.memory");
    if (memSlot === "clawmem") {
      console.log(`${c.green}✓${c.reset} OpenClaw memory slot: ${c.cyan}clawmem${c.reset}`);
    } else if (memSlot) {
      console.log(
        `${c.dim}-${c.reset} OpenClaw memory slot: ${c.cyan}${memSlot}${c.reset} (ClawMem hooks will not fire under this agent)`,
      );
    }
  } catch {
    // openclaw CLI unavailable — skip silently
  }

  // 9. Reranker discrimination (active probe — asserts the reranker DISCRIMINATES, not just
  //    responds). Liveness is worthless here: the broken zerank-2 GGUF returned HTTP 200 + valid
  //    JSON + finite positive ~1e-11 scores and passed every other check while silently collapsing
  //    the final ranking to RRF. This routes a golden hard-pair set through the live reranker
  //    (cache-bypassed, coverage-enforced) and checks calibration + per-pair discrimination.
  try {
    const s = getStore();
    // Both production callers delegate to the shared policy function, so the
    // remote-only rule cannot drift between doctor and rerank-health (codex
    // turn-34 finding 1).
    const { runDoctorRerankCheck } = await import("./health/rerank-health.ts");
    const health = await runDoctorRerankCheck(s, { timeoutMs: 8000 });
    if (health.ok) {
      console.log(`${c.green}✓${c.reset} Reranker: discriminates (coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toFixed(2)} ≥ ${health.thresholds.calibFloor}, min margin ${health.minMargin.toFixed(2)} ≥ ${health.thresholds.discrimMargin})`);
    } else {
      console.log(`${c.red}✗${c.reset} Reranker: degenerate / not discriminating (coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toExponential(1)}, min margin ${health.minMargin.toFixed(2)})`);
      for (const f of health.failures.slice(0, 4)) console.log(`   ${c.dim}${f}${c.reset}`);
      console.log(`   ${c.dim}Likely a zerank-2 GGUF without its score head (most uploads lack it) — serve the Q8_0 GGUF that carries it, or the seq-cls sidecar. See docs/guides/inference-services.md.${c.reset}`);
      issues++;
    }
  } catch (err) {
    console.log(`${c.yellow}!${c.reset} Reranker: could not probe (${(err as Error).message})`);
  }

  // 10. Embedding-geometry canary (VSEARCH-TRUST-HARDENING (d)): pair-separation sanity
  //     (catches WRONG-but-stable geometry — the 2026-07-10 class, invisible to
  //     self-similarity) + drift vs the stored baseline (catches a changed serving stack —
  //     the 2026-06-22 class — behind an unchanged model name). For a vault WITH vectors
  //     this is a REQUIRED check: unavailability is incomplete/nonzero, not green (T8-M6).
  //     A persisted taint flag from a bad rebuild stays red until a verified full rebuild
  //     clears it (T8-M1).
  {
    const s = getStore();
    const vaultHasVectors = !!s.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get()
      && ((s.db.prepare(`SELECT count(*) as cnt FROM vectors_vec`).get() as { cnt: number })?.cnt ?? 0) > 0;
    const taint = s.getVaultFlag("embed_geometry_taint");
    if (taint) {
      console.log(`${c.red}✗${c.reset} Geometry taint: a prior embed run was tainted/unverified (${taint}) — the vault may mix two geometries. Run 'clawmem embed --force' against a stable server to clear.`);
      issues++;
      process.exitCode = 1;
    }
    try {
      const llm = getDefaultLlamaCpp();
      const outcome = await runCanaryBattery(t => llm.embed(t), key => s.getCanaryBaseline(key));
      if ("unavailable" in outcome) {
        if (vaultHasVectors) {
          console.log(`${c.red}✗${c.reset} Geometry canary: INCOMPLETE — required check could not run (${outcome.reason}). A vector vault without a validated server is unverified, not healthy.`);
          issues++;
          process.exitCode = 1;
        } else {
          console.log(`${c.yellow}!${c.reset} Geometry canary: skipped (${outcome.reason}; vault has no vectors)`);
        }
      } else if (outcome.pass) {
        const m = outcome.margins;
        console.log(`${c.green}✓${c.reset} Geometry canary: separation healthy (rel ${m.m_rel!.toFixed(2)}, echo ${m.m_echo!.toFixed(2)}, term ${m.m_term!.toFixed(2)}, trunc ${m.m_trunc!.toFixed(2)})${outcome.driftChecked ? " · drift vs baseline OK" : " · no baseline yet (absolute floors)"}`);
      } else {
        console.log(`${c.red}✗${c.reset} Geometry canary: FAILED — embedding server produces non-discriminating or drifted vectors`);
        for (const f of outcome.failures.slice(0, 6)) console.log(`   ${c.dim}${f}${c.reset}`);
        console.log(`   ${c.dim}Pooling / EOS-anchor / quant misconfiguration, or the server changed since the last embed. See docs/troubleshooting.md → "Vector search returns weak or irrelevant results". A geometry change requires 'clawmem embed --force'.${c.reset}`);
        issues++;
        process.exitCode = 1;
      }
    } catch (err) {
      if (vaultHasVectors) {
        console.log(`${c.red}✗${c.reset} Geometry canary: INCOMPLETE — required check errored (${(err as Error).message})`);
        issues++;
        process.exitCode = 1;
      } else {
        console.log(`${c.yellow}!${c.reset} Geometry canary: could not run (${(err as Error).message})`);
      }
    }
  }

  // 11. Sampled vector validation ((d).4): persisted-vs-fresh on REAL vectors_vec rows,
  //     reconstructed through the production pipeline from the CANONICAL document
  //     (T8-H3). Definitive fingerprint failures return immediately and are nonzero
  //     regardless of coverage (T6-M2/T8-H2); attempts are hard-capped. Required check
  //     for a vector vault — exceptions are incomplete/nonzero, not green (T8-M6).
  try {
    const s = getStore();
    const llm = getDefaultLlamaCpp();
    const summary = await runSampledVectorValidation(s, (t: string) => llm.embed(t));
    if (summary.eligible === 0) {
      console.log(`${c.yellow}!${c.reset} Sampled vectors: no eligible rows (no synced embedded documents)`);
    } else if (summary.definitiveFailures.length > 0) {
      console.log(`${c.red}✗${c.reset} Sampled vectors: DEFINITIVE failure after ${summary.attempts} attempt(s) (${summary.validated}/${summary.target} validated before stopping, ${summary.eligible} eligible)`);
      for (const f of summary.definitiveFailures.slice(0, 4)) console.log(`   ${c.dim}${f}${c.reset}`);
      console.log(`   ${c.dim}Stale-input rows need a re-embed; corruption/drift at matching fingerprints means the stored vector no longer matches its exact input.${c.reset}`);
      issues++;
      process.exitCode = 1;
    } else if (summary.validated < summary.nMin || summary.validatedSeq0 < summary.seq0Target) {
      const seq0Part = summary.validatedSeq0 < summary.seq0Target ? `; seq-0 quota UNMET (${summary.validatedSeq0}/${summary.seq0Target} validated — primary fragments are the surprisal/graph/health anchors)` : "";
      console.log(`${c.red}✗${c.reset} Sampled vectors: DEGRADED — validation could not complete (${summary.validated}/${summary.target} validated, min ${summary.nMin}${seq0Part}; ${summary.unreconstructable} unreconstructable, ${summary.inconclusiveLegacy} legacy-inconclusive; ${summary.attempts} attempts over ${summary.eligible} eligible)`);
      console.log(`   ${c.dim}Splitter/metadata drift or legacy rows below threshold — re-embed or investigate.${c.reset}`);
      issues++;
      process.exitCode = 1;
    } else {
      const legacyNote = summary.legacyTier > 0 ? ` (${summary.legacyTier} legacy-tier: structural only — title provenance unavailable until re-embed)` : "";
      const seq0Note = summary.validatedSeq0 > 0 ? `, ${summary.validatedSeq0} seq-0` : "";
      console.log(`${c.green}✓${c.reset} Sampled vectors: ${summary.validated}/${summary.target} validated (cos ≥ 0.98${seq0Note})${legacyNote}`);
    }
  } catch (err) {
    const s = getStore();
    const vaultHasVectors = !!s.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get()
      && ((s.db.prepare(`SELECT count(*) as cnt FROM vectors_vec`).get() as { cnt: number })?.cnt ?? 0) > 0;
    if (vaultHasVectors) {
      console.log(`${c.red}✗${c.reset} Sampled vectors: INCOMPLETE — required check errored (${(err as Error).message})`);
      issues++;
      process.exitCode = 1;
    } else {
      console.log(`${c.yellow}!${c.reset} Sampled vectors: could not run (${(err as Error).message})`);
    }
  }

  // 12. Remote LLM endpoint shape (issue #24). Reachability is not the same as
  // serving chat completions: a port squatted by an unrelated service answers
  // HTTP (404/501/…) forever, which through v0.36.0 never engaged the local
  // fallback — enrichment failed silently on every call. The reranker (section
  // 9) and the embedding server (geometry canary) already have active shape
  // probes; this closes the same "liveness ≠ correctness" gap for the third
  // inference service. POST a minimal completion and validate the OpenAI
  // response shape.
  {
    const llmUrl = process.env.CLAWMEM_LLM_URL;
    // The consequence of a broken endpoint depends on the fallback POLICY
    // (codex turn-2 finding 4): under CLAWMEM_NO_LOCAL_MODELS=true there is no
    // fallback by design — saying "the fallback path will be used" there is
    // exactly the false comfort this section exists to remove.
    const noLocal = process.env.CLAWMEM_NO_LOCAL_MODELS === "true";
    const consequence = noLocal
      ? "Fallback is disabled by policy (CLAWMEM_NO_LOCAL_MODELS=true), so enrichment and query expansion will produce nothing until this is fixed"
      : "Enrichment and query expansion will run on the in-process fallback path";
    if (!llmUrl) {
      console.log(
        noLocal
          ? `${c.yellow}!${c.reset} LLM endpoint: CLAWMEM_LLM_URL not set AND CLAWMEM_NO_LOCAL_MODELS=true — generation is fully disabled (no remote, no fallback)`
          : `${c.yellow}!${c.reset} LLM endpoint: CLAWMEM_LLM_URL not set (in-process fallback model will be used)`
      );
    } else {
      const ep = buildRemoteChatCompletionsUrl(llmUrl);
      // Same request the runtime would make: model name and the no-think
      // policy come from the SAME env normalization getDefaultLlamaCpp uses —
      // an endpoint configured with CLAWMEM_LLM_NO_THINK=false must not be
      // probed with a control token it may reject (codex turn-1 finding 3).
      const probe = await LlamaCpp.probeChatCompletionsShape({
        url: llmUrl,
        apiKey: process.env.CLAWMEM_LLM_API_KEY || undefined,
        model: process.env.CLAWMEM_LLM_MODEL,
        noThink: normalizeRemoteLlmNoThink(process.env.CLAWMEM_LLM_NO_THINK) ?? true,
      });
      if (probe.status === "ok") {
        console.log(`${c.green}✓${c.reset} LLM endpoint: ${ep} serves chat completions (model ${probe.model})`);
        await doctorLlmContext();
      } else if (probe.status === "http") {
        console.log(`${c.red}✗${c.reset} LLM endpoint: ${ep} answered HTTP ${probe.httpStatus} — reachable but NOT serving chat completions (another service on the port, or a misconfigured model name). ${consequence}. Check CLAWMEM_LLM_URL / CLAWMEM_LLM_MODEL.`);
        issues++;
      } else if (probe.status === "shape") {
        console.log(`${c.red}✗${c.reset} LLM endpoint: ${ep} answered 200 but the body is not a chat-completions response (${probe.detail}) — wrong service on the port?`);
        issues++;
      } else {
        console.log(`${c.red}✗${c.reset} LLM endpoint: could not reach ${ep} (${probe.detail}). ${noLocal ? "Fallback is disabled by policy (CLAWMEM_NO_LOCAL_MODELS=true), so generation will produce nothing until the endpoint is reachable" : "Transport cooldown + in-process fallback will be used at runtime"}`);
        issues++;
      }
    }
  }

  // 10. Contradiction judge (v0.29.0). A SMOKE TEST, never capability
  // certification: three fixture scenarios through the configured judge, zero
  // store involvement. Runs ONLY when a judge is configured — the default lane
  // is never probed (no reliable non-downloading cache detector exists, and the
  // stock model's verdict is established and documented).
  try {
    const resolution = resolveJudge();
    const configuredPolicy = resolveContradictionPolicy();
    if (resolution.status === "unconfigured") {
      console.log(
        `${c.yellow}!${c.reset} Contradiction judge: not configured — contradiction analysis is ` +
        `DISABLED (the stock expansion model cannot meet the judge contract). ` +
        `Set CLAWMEM_JUDGE_* to enable: docs/guides/inference-services.md`,
      );
      // Migration warning (§J1): a capable GLOBAL LLM may have produced real verdicts
      // before v0.29.0 decoupled the judge from CLAWMEM_LLM_*. Provenance-aware — the
      // wrapper marks its own stock default; a custom model served AT the stock
      // endpoint is undetectable, so upgrading.md remains the authoritative notice.
      const urlSource = process.env.CLAWMEM_LLM_URL_SOURCE;
      const llmUrl = process.env.CLAWMEM_LLM_URL;
      const llmModel = process.env.CLAWMEM_LLM_MODEL?.trim();
      const userSuppliedUrl = !!llmUrl && urlSource !== "default" && llmUrl !== "http://localhost:8089";
      const nonStockModel = !!llmModel && llmModel !== "qwen3";
      if (userSuppliedUrl || nonStockModel) {
        console.log(
          `${c.yellow}!${c.reset} Migration: a custom global LLM is configured ` +
          `(${userSuppliedUrl ? llmUrl : `model=${llmModel}`}) but no judge is. If it was doing ` +
          `real contradiction analysis before v0.29.0, set CLAWMEM_JUDGE_* to keep it — the ` +
          `judge no longer rides the global vars (docs/guides/upgrading.md).`,
        );
      }
      if (configuredPolicy === "supersede") {
        console.log(
          `${c.yellow}!${c.reset} CLAWMEM_CONTRADICTION_POLICY=supersede is configured but ` +
          `presently INACTIVE (no judge) — merge contradictions are constrained to ` +
          `non-deactivating 'link'.`,
        );
      }
    } else if (resolution.status === "invalid") {
      console.log(`${c.red}✗${c.reset} Contradiction judge: misconfigured — ${resolution.error}`);
      issues++;
    } else {
      const judge = resolution.judge;
      const d = judge.descriptor;
      const scenarioA = {
        newFacts: ["Decided: the ingestion worker now writes directly to Postgres; the Redis queue layer is removed entirely."],
        existing: ["Decided: all ingestion must go through the Redis queue; workers never write directly to Postgres."],
      };
      const scenarioB = {
        newFacts: ["Decided: bump the frontend to Tailwind v4 in the next sprint."],
        existing: ["Observation: the nightly backup cron runs at 03:00 and rotates 7 snapshots."],
      };
      const runPair = async (sc: { newFacts: string[]; existing: string[] }) => {
        const prompt = buildContradictionPrompt({ newFacts: sc.newFacts, existingSnippets: sc.existing, minConfidence: 0.7 });
        const res = await judge.judge({ system: prompt.system, user: prompt.user, schema: JUDGE_VERDICT_SCHEMA });
        if (!res.ok) return { ok: false as const, detail: `${res.reason}: ${res.detail}` };
        if (res.truncated) return { ok: false as const, detail: "response truncated" };
        const parsed = unwrapContradictionArray(extractJudgeJson(res.text));
        if (!Array.isArray(parsed)) return { ok: false as const, detail: "response is not a JSON array" };
        const batch = admitContradictionEntries(parsed, sc.existing.length, sc.newFacts.length);
        return { ok: true as const, parsed, batch };
      };

      const a = await runPair(scenarioA);
      // A CLEAN response is required — one raw entry, one admitted, zero
      // rejected/duplicate/inconsistent. A right answer wrapped in schema junk
      // or repeats is not a passing judge (code-review t1 finding 5).
      const aPass = a.ok && a.parsed.length === 1 && a.batch.accepted.length === 1 &&
        a.batch.rejected === 0 && a.batch.duplicates === 0 && a.batch.inconsistent === 0 &&
        a.batch.accepted[0].relation === "contradiction" &&
        a.batch.accepted[0].new_idx === 0 && a.batch.accepted[0].old_idx === 0 &&
        a.batch.accepted[0].confidence >= 0.7;
      const b = await runPair(scenarioB);
      // ANY verdict on unrelated facts — even a low-confidence `same` — is fabrication.
      const bPass = b.ok && b.parsed.length === 0;
      const cEval = await evaluateMergeContradiction(resolution, scenarioA.existing[0]!, scenarioA.newFacts[0]!);
      const cRun = cEval.kind === "decided" ? cEval.runs[cEval.runs.length - 1] : undefined;
      const cPass = cEval.kind === "decided" && cEval.result.source === "llm" &&
        isActionableContradiction(cEval.result) &&
        (cRun?.entriesAdmitted ?? 0) === 1 && (cRun?.entriesRejected ?? 1) === 0 &&
        (cRun?.entriesDuplicate ?? 1) === 0 && (cRun?.entriesInconsistent ?? 1) === 0;

      if (aPass && bPass && cPass) {
        console.log(
          `${c.green}✓${c.reset} Contradiction judge: ${d.lane}/${d.model} passed the smoke test ` +
          `(designed contradiction detected, unrelated control clean, merge contract actionable). ` +
          `${c.dim}Smoke test only — not capability certification.${c.reset}`,
        );
      } else {
        const parts = [
          aPass ? null : `scenario A (designed contradiction): ${a.ok ? 'no valid (0,0,"contradiction") verdict at ≥ 0.7' : a.detail}`,
          bPass ? null : `scenario B (unrelated control): ${b.ok ? "fabricated a verdict on unrelated facts" : b.detail}`,
          cPass ? null : `scenario C (merge single-pair): not actionable via the judge`,
        ].filter(Boolean);
        console.log(
          `${c.red}✗${c.reset} Contradiction judge: ${d.lane}/${d.model} FAILED the smoke test — ` +
          `${parts.join("; ")}. Rejects stay fail-closed, but this judge is not fit to rely on. ` +
          `See docs/guides/inference-services.md.`,
        );
        issues++;
      }
      if (configuredPolicy === "supersede") {
        console.log(`${c.dim}   supersede policy: ACTIVE (judge configured)${c.reset}`);
      }
    }
    // Durable audit rows — the evidence calibration reads.
    try {
      const s = getStore();
      const counts = judgeAuditCounts(s.db);
      console.log(`${c.dim}   judge audit: ${counts.runs} run(s), ${counts.events} event(s)${counts.oldestTs ? `, oldest ${counts.oldestTs}` : ""}${c.reset}`);
    } catch { /* audit tables absent on pre-0.29.0 vaults — non-fatal */ }
  } catch (err) {
    console.log(`${c.yellow}!${c.reset} Contradiction judge: could not probe (${(err as Error).message})`);
  }

  console.log();
  if (issues > 0) {
    console.log(`${c.yellow}${issues} issue(s) found.${c.reset}`);
  } else {
    console.log(`${c.green}All checks passed.${c.reset}`);
  }
}


// =============================================================================
// Reranker health (scheduled-check CLI)
// =============================================================================

// Oneshot reranker discrimination probe. Exits non-zero on degeneracy so a systemd OnFailure= (or
// any scheduled check) can alert — the standalone counterpart to doctor section 9. Routes through
// the live, cache-bypassed, coverage-enforced probe (src/health/rerank-health.ts).
async function cmdRerankHealth(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
    },
    allowPositionals: false,
  });
  const timeoutMs = values["timeout-ms"] ? parseInt(values["timeout-ms"] as string, 10) : undefined;
  const store = getStore();
  // The COMMAND workflow — probe under the remote-only policy, then attest or
  // revoke — lives in the health module so a test can drive the production
  // path with an injected store (codex turn-35 finding 1). The CLI formats.
  const { runRerankHealthWorkflow } = await import("./health/rerank-health.ts");
  const outcome = await runRerankHealthWorkflow(store, timeoutMs ? { timeoutMs } : {});
  const health = outcome.health;
  if (!values.json) {
    if (outcome.attested) {
      console.log(`${c.dim}provider identity recorded for ${process.env.CLAWMEM_RERANK_URL?.trim()}: ${outcome.attested} (namespaces the rerank score cache)${c.reset}`);
    } else if (outcome.revoked) {
      console.log(`${c.dim}provider identity REVOKED for ${process.env.CLAWMEM_RERANK_URL?.trim()} — rerank scores will not be cached until a healthy probe re-attests${c.reset}`);
    }
  }
  if (outcome.revokeError) {
    console.error(`${c.red}✗ could not revoke the provider identity${c.reset}: ${outcome.revokeError}`);
    process.exitCode = 1;
  }

  if (values.json) {
    console.log(JSON.stringify(health));
  } else if (health.ok) {
    console.log(`${c.green}✓ Reranker healthy${c.reset} — coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toFixed(2)} ≥ ${health.thresholds.calibFloor}, min margin ${health.minMargin.toFixed(2)} ≥ ${health.thresholds.discrimMargin}`);
  } else {
    console.log(`${c.red}✗ Reranker degenerate / not discriminating${c.reset} — coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toExponential(1)}, min margin ${health.minMargin.toFixed(2)}`);
    for (const f of health.failures) console.log(`  - ${f}`);
    console.log(`Likely a zerank-2 GGUF without its score head (most uploads lack it) — serve the Q8_0 GGUF that carries it, or the seq-cls sidecar. See docs/guides/inference-services.md.`);
  }
  // Non-zero exit on degeneracy so systemd OnFailure= / a scheduled check can alert. Use exitCode
  // (not process.exit) so main()'s finally { closeStore() } still runs.
  process.exitCode = health.ok ? 0 : 1;
}


// =============================================================================
// Bootstrap
// =============================================================================

async function cmdBootstrap(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      "skip-embed": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const vaultPath = positionals[0];
  if (!vaultPath) die("Usage: clawmem bootstrap <vault-path> [--name <name>] [--skip-embed]");

  const absPath = pathResolve(vaultPath);
  if (!existsSync(absPath)) die(`Directory not found: ${absPath}`);

  const name = values.name || basename(absPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  // 1. Init (skip if already initialized)
  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.log(`${c.cyan}Step 1: Initializing ClawMem${c.reset}`);
    await cmdInit();
  } else {
    console.log(`${c.dim}Step 1: Already initialized${c.reset}`);
  }

  // 2. Collection add (skip if already exists)
  const existing = collectionsList().find(col => col.path === absPath);
  if (!existing) {
    console.log(`${c.cyan}Step 2: Adding collection '${name}'${c.reset}`);
    collectionsAdd(name, absPath, DEFAULT_GLOB);
    console.log(`  ${c.green}Added${c.reset} ${absPath}`);
  } else {
    console.log(`${c.dim}Step 2: Collection already exists (${existing.name})${c.reset}`);
  }

  // 3. Update
  console.log(`${c.cyan}Step 3: Indexing files${c.reset}`);
  await cmdUpdate([]);

  // 4. Embed (unless --skip-embed)
  if (!values["skip-embed"]) {
    console.log(`${c.cyan}Step 4: Embedding documents${c.reset}`);
    await cmdEmbed([]);
  } else {
    console.log(`${c.dim}Step 4: Skipping embeddings (--skip-embed)${c.reset}`);
  }

  // 5. Setup hooks
  console.log(`${c.cyan}Step 5: Installing hooks${c.reset}`);
  await cmdSetupHooks([]);

  // 6. Setup MCP
  console.log(`${c.cyan}Step 6: Registering MCP${c.reset}`);
  await cmdSetupMcp([]);

  console.log();
  console.log(`${c.green}ClawMem bootstrapped for ${absPath}${c.reset}`);
}

// =============================================================================
// Install Service
// =============================================================================

async function cmdInstallService(args: string[]) {
  const remove = args.includes("--remove");
  const enable = args.includes("--enable");

  const { join: pathJoin } = await import("path");
  const os = await import("os");
  const { execSync } = await import("child_process");

  const servicePath = pathJoin(os.homedir(), ".config", "systemd", "user", "clawmem-watcher.service");

  if (remove) {
    try { execSync("systemctl --user stop clawmem-watcher.service 2>/dev/null"); } catch { /* may not be running */ }
    try { execSync("systemctl --user disable clawmem-watcher.service 2>/dev/null"); } catch { /* may not be enabled */ }
    if (existsSync(servicePath)) {
      const { unlinkSync } = await import("fs");
      unlinkSync(servicePath);
    }
    execSync("systemctl --user daemon-reload");
    console.log(`${c.green}Removed clawmem-watcher service${c.reset}`);
    return;
  }

  const binPath = findClawmemBinary();
  const unit = `[Unit]
Description=ClawMem File Watcher
After=default.target

[Service]
Type=simple
ExecStart=${process.argv[0]} ${pathResolve(import.meta.dir, "clawmem.ts")} watch
Restart=on-failure
RestartSec=5
Environment=HOME=${os.homedir()}

[Install]
WantedBy=default.target
`;

  const serviceDir = pathJoin(os.homedir(), ".config", "systemd", "user");
  if (!existsSync(serviceDir)) mkdirSync(serviceDir, { recursive: true });

  const { writeFileSync: wfs } = await import("fs");
  wfs(servicePath, unit);
  execSync("systemctl --user daemon-reload");

  console.log(`${c.green}Installed clawmem-watcher service${c.reset}`);
  console.log(`  ${servicePath}`);

  if (enable) {
    execSync("systemctl --user enable --now clawmem-watcher.service");
    console.log(`  ${c.green}Enabled and started${c.reset}`);
  } else {
    console.log(`  Run: ${c.cyan}systemctl --user enable --now clawmem-watcher.service${c.reset}`);
  }
}

// =============================================================================
// Directory Context
// =============================================================================

async function cmdUpdateContext() {
  const s = getStore();
  const count = regenerateAllDirectoryContexts(s);
  console.log(`${c.green}Updated CLAUDE.md in ${count} directories${c.reset}`);
}

// =============================================================================
// Profile
// =============================================================================

async function cmdProfile(args: string[]) {
  const s = getStore();

  if (args[0] === "rebuild") {
    const outcome = updateProfile(s);
    const colour = outcome === "rebuilt" ? c.green : c.yellow;
    console.log(`${colour}${profileOutcomeMessage(outcome, false)}${c.reset}`);
    return;
  }

  const profile = getProfile(s);
  if (!profile) {
    console.log("No profile found. Run: clawmem profile rebuild");
    return;
  }

  console.log(`${c.bold}User Profile${c.reset}`);
  if (profile.static.length > 0) {
    console.log(`\n${c.cyan}Known Context:${c.reset}`);
    for (const fact of profile.static) {
      console.log(`  - ${fact}`);
    }
  }
  if (profile.dynamic.length > 0) {
    console.log(`\n${c.cyan}Current Focus:${c.reset}`);
    for (const item of profile.dynamic) {
      console.log(`  - ${item}`);
    }
  }
}

// §11.4 (v0.9.0): session-scoped focus topic — read/write/clear the
// per-session focus file at ~/.cache/clawmem/sessions/<session_id>.focus.
// The file is the primary signal read by context-surfacing for topic
// boosting; the CLAWMEM_SESSION_FOCUS env var is a debug-only override
// that does NOT provide per-session scoping on multi-session hosts.
async function cmdFocus(args: string[]) {
  const subCmd = args[0];

  function resolveSessionId(rest: string[]): string {
    const sidIdx = rest.indexOf("--session-id");
    if (sidIdx >= 0 && rest[sidIdx + 1]) return rest[sidIdx + 1]!;
    const envSid = (
      process.env.CLAUDE_SESSION_ID ||
      process.env.CLAWMEM_SESSION_ID ||
      ""
    ).trim();
    if (envSid) return envSid;
    die(
      "No session id. Pass --session-id <id>, or set CLAUDE_SESSION_ID " +
        "(Claude Code exposes this) or CLAWMEM_SESSION_ID env var before " +
        "invoking this command."
    );
  }

  function stripSessionIdArg(rest: string[]): string[] {
    const sidIdx = rest.indexOf("--session-id");
    if (sidIdx < 0) return rest;
    return [...rest.slice(0, sidIdx), ...rest.slice(sidIdx + 2)];
  }

  switch (subCmd) {
    case "set": {
      const rest = args.slice(1);
      const sessionId = resolveSessionId(rest);
      const positional = stripSessionIdArg(rest);
      const topic = positional.join(" ").trim();
      if (!topic) {
        die("Usage: clawmem focus set <topic> [--session-id <id>]");
      }
      try {
        writeSessionFocus(sessionId, topic);
      } catch (err: any) {
        die(`Failed to set focus: ${err?.message ?? err}`);
      }
      console.log(
        `${c.green}Focus set${c.reset} for session ${c.cyan}${sessionId}${c.reset}: ${topic}`
      );
      console.log(`${c.dim}File: ${focusFilePath(sessionId)}${c.reset}`);
      break;
    }
    case "show": {
      const rest = args.slice(1);
      const sessionId = resolveSessionId(rest);
      const topic = readSessionFocus(sessionId);
      if (topic) {
        console.log(
          `${c.green}Focus${c.reset} for session ${c.cyan}${sessionId}${c.reset}: ${topic}`
        );
        console.log(`${c.dim}File: ${focusFilePath(sessionId)}${c.reset}`);
      } else {
        console.log(
          `${c.yellow}No focus${c.reset} set for session ${c.cyan}${sessionId}${c.reset}.`
        );
        console.log(
          `${c.dim}Expected file: ${focusFilePath(sessionId)}${c.reset}`
        );
      }
      break;
    }
    case "clear": {
      const rest = args.slice(1);
      const sessionId = resolveSessionId(rest);
      clearSessionFocus(sessionId);
      console.log(
        `${c.green}Focus cleared${c.reset} for session ${c.cyan}${sessionId}${c.reset}.`
      );
      break;
    }
    default:
      die(
        "Usage: clawmem focus <set|show|clear> [<topic>] [--session-id <id>]"
      );
  }
}

// =============================================================================
// Main dispatch
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const subArgs = args.slice(1);

  try {
    switch (command) {
      case "init":
        await cmdInit();
        break;
      case "collection": {
        const subCmd = subArgs[0];
        const subSubArgs = subArgs.slice(1);
        switch (subCmd) {
          case "add": await cmdCollectionAdd(subSubArgs); break;
          case "list": await cmdCollectionList(); break;
          case "remove": await cmdCollectionRemove(subSubArgs); break;
          default: die("Usage: clawmem collection <add|list|remove>");
        }
        break;
      }
      case "update":
        await cmdUpdate(subArgs);
        break;
      case "mine":
        await cmdMine(subArgs);
        break;
      case "embed":
        await cmdEmbed(subArgs);
        break;
      case "status":
        await cmdStatus();
        break;
      case "list":
        await cmdList(subArgs);
        break;
      case "search":
        await cmdSearch(subArgs);
        break;
      case "vsearch":
        await cmdVsearch(subArgs);
        break;
      case "query":
        await cmdQuery(subArgs);
        break;
      case "eval":
        await cmdEval(subArgs);
        break;
      case "hook":
        await cmdHook(subArgs);
        break;
      case "spool-drain":
        await cmdSpoolDrain();
        break;
      case "spool-ingest":
        await cmdSpoolIngest();
        break;
      case "budget":
        await cmdBudget(subArgs);
        break;
      case "log":
        await cmdLog(subArgs);
        break;
      case "mcp":
        await cmdMcp();
        break;
      case "serve":
        await cmdServe(subArgs);
        break;
      case "serve-token":
        await cmdServeToken();
        break;
      case "setup":
        await cmdSetup(subArgs);
        break;
      case "watch":
        await cmdWatch();
        break;
      case "reindex":
        await cmdReindex(subArgs);
        break;
      case "doctor":
        await cmdDoctor();
        break;
      case "vec-daemon-health":
        await cmdVecDaemonHealth(subArgs);
        break;
      case "rerank-health":
        await cmdRerankHealth(subArgs);
        break;
      case "path":
        cmdPath();
        break;
      case "bootstrap":
        await cmdBootstrap(subArgs);
        break;
      case "install-service":
        await cmdInstallService(subArgs);
        break;
      case "profile":
        await cmdProfile(subArgs);
        break;
      case "focus":
        await cmdFocus(subArgs);
        break;
      case "update-context":
        await cmdUpdateContext();
        break;
      case "surface":
        await cmdSurface(subArgs);
        break;
      case "lifecycle":
        await cmdLifecycle(subArgs);
        break;
      case "reflect":
        await cmdReflect(subArgs);
        break;
      case "consolidate":
        await cmdConsolidate(subArgs);
        break;
      case "curate":
        await cmdCurate(subArgs);
        break;
      case "diary":
        await cmdDiary(subArgs);
        break;
      case "migrate":
        await cmdMigrate(subArgs);
        break;
      case "causal-audit":
        await cmdCausalAudit(subArgs);
        break;
      case "repair":
        await cmdRepair(subArgs);
        break;
      case "recover":
        await cmdRecover(subArgs);
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        printHelp();
        break;
      default:
        die(`Unknown command: ${command}. Run 'clawmem help' for usage.`);
    }
  } finally {
    closeStore();
  }
}

// =============================================================================
// migrate causal-witnesses — s342 legacy-evidence resolution (operator CLI)
// =============================================================================

function parseEdgeArg(raw: string): { sourceId: number; targetId: number } {
  const m = raw.match(/^(\d+):(\d+)$/);
  if (!m) die(`--edge expects <sourceDocId>:<targetDocId> (got "${raw}")`);
  return { sourceId: Number(m[1]), targetId: Number(m[2]) };
}

/**
 * `clawmem migrate causal-witnesses` — the operator surface for causal edges the
 * writer refuses to touch (zero sightings + metadata that cannot yield a valid
 * witness). Preflight is REQUIRED (or every unresolved edge resolved) before
 * setting CLAWMEM_CAUSAL_WRITER=on. Application is explicit-selection only —
 * bulk "resolve all qualifying" does not exist — and is bound to the preview by
 * a version-tagged full-row fingerprint rechecked under the write lock.
 */
async function cmdMigrate(args: string[]) {
  const sub = args[0];
  if (sub !== "causal-witnesses") {
    die("Usage: clawmem migrate causal-witnesses --preflight [--out <manifest.json>]\n" +
        "       clawmem migrate causal-witnesses --resolve-unmaterializable keep-weight|retire-edge \\\n" +
        "           --manifest <file> --edge <src>:<tgt> [--edge ...] [--note <text>] [--apply]\n" +
        "       clawmem migrate causal-witnesses --restore-edge <src>:<tgt> [--apply]");
  }
  const rest = args.slice(1);
  const {
    causalWitnessCensus, buildResolutionManifest, applyResolution, restoreRetiredEdge,
    insertCausalRun, finalizeCliCausalRun, CAUSAL_FINGERPRINT_VERSION,
  } = await import("./causal-writer.ts");
  const { randomUUID } = await import("node:crypto");

  const flagValue = (name: string): string | null => {
    const i = rest.indexOf(name);
    if (i === -1) return null;
    const v = rest[i + 1];
    if (!v || v.startsWith("--")) die(`${name} requires a value`);
    return v;
  };
  const edgeArgs: { sourceId: number; targetId: number }[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--edge") {
      const v = rest[i + 1];
      if (!v) die("--edge requires a value");
      edgeArgs.push(parseEdgeArg(v));
    }
  }
  const apply = rest.includes("--apply");
  const s = getStore();

  // --- restore-edge -----------------------------------------------------------
  const restoreRaw = flagValue("--restore-edge");
  if (restoreRaw) {
    const edge = parseEdgeArg(restoreRaw);
    const archived = s.db.prepare(
      `SELECT weight, metadata, created_at, retired_at, operator_note FROM retired_causal_edges
       WHERE source_id = ? AND target_id = ? AND relation_type = 'causal'`,
    ).get(edge.sourceId, edge.targetId) as { weight: number | null; retired_at: string; operator_note: string | null } | undefined;
    if (!archived) {
      die(`No archived causal edge ${edge.sourceId}→${edge.targetId} in retired_causal_edges.`);
    }
    if (!apply) {
      console.log(`${c.cyan}Would restore${c.reset} edge ${edge.sourceId}→${edge.targetId} ` +
        `(weight ${archived.weight}, retired ${archived.retired_at}` +
        `${archived.operator_note ? `, note: ${archived.operator_note}` : ""}). Re-run with --apply.`);
      return;
    }
    const startedAt = monoNow();
    const runKey = randomUUID();
    // Pessimistic terminal outcome: the row is BORN cli_error and only a
    // successful finalization flips it to cli_ok — a writer lock that kills
    // both the operation and the finalization leaves an honest cli_error,
    // never a stranded in_progress row.
    const runId = insertCausalRun(s.db, { runKey, source: "cli_migrate", mode: "cli", outcome: "cli_error" });
    let outcome: ReturnType<typeof restoreRetiredEdge>;
    try {
      outcome = restoreRetiredEdge(s.db, edge, { runKey, runId });
    } catch (err) {
      finalizeCliCausalRun(s.db, runId, "cli_error", startedAt);
      throw err;
    }
    finalizeCliCausalRun(s.db, runId, outcome.status === "restored" ? "cli_ok" : "cli_error", startedAt);
    if (outcome.status === "restored") {
      console.log(`${c.green}Restored${c.reset} causal edge ${edge.sourceId}→${edge.targetId} from the archive.`);
    } else if (outcome.status === "not_archived") {
      die(`Edge ${edge.sourceId}→${edge.targetId} vanished from the archive before apply.`);
    } else {
      // Fail-closed: a key or foreign-key CONSTRAINT refused the plain INSERT —
      // an active edge may occupy the composite key, or an endpoint document is
      // missing. Either way nothing was replaced and the archive row is untouched.
      die(`Restore REFUSED (fail-closed): ${outcome.reason}\n` +
          `A key/FK constraint refused ${edge.sourceId}→${edge.targetId} (occupied key or missing endpoint); ` +
          `the archive row is untouched.`);
    }
    return;
  }

  // --- preflight --------------------------------------------------------------
  if (rest.includes("--preflight")) {
    const entries = causalWitnessCensus(s.db);
    const unresolved = entries.filter(e => !e.materializable);
    const materializable = entries.filter(e => e.materializable);
    console.log(`Causal witness census (observation-lane edges with zero sightings):`);
    console.log(`  ${materializable.length} edge(s) with valid old-writer metadata — will materialize lazily on first live touch; no action needed.`);
    console.log(`  ${unresolved.length} UNRESOLVED edge(s) — metadata cannot yield a valid witness; the writer fails closed on these until resolved:`);
    for (const e of unresolved) {
      const metaHead = (e.row.metadata ?? "<null>").slice(0, 80);
      console.log(`    ${c.yellow}${e.row.source_id}→${e.row.target_id}${c.reset} weight=${e.row.weight} metadata=${JSON.stringify(metaHead)}`);
    }
    const outPath = flagValue("--out");
    if (outPath) {
      const manifest = buildResolutionManifest(entries);
      writeFileSync(outPath, JSON.stringify(manifest, null, 2));
      console.log(`\nManifest (${manifest.edges.length} edge(s), fingerprint ${CAUSAL_FINGERPRINT_VERSION}) written to ${outPath}.`);
      console.log(`Resolve with: clawmem migrate causal-witnesses --resolve-unmaterializable keep-weight|retire-edge --manifest ${outPath} --edge <src>:<tgt> --apply`);
    } else if (unresolved.length > 0) {
      console.log(`\nRe-run with --out <manifest.json> to emit the binding manifest required by --apply.`);
    }
    if (unresolved.length === 0) {
      console.log(`${c.green}Preflight clean${c.reset} — safe to set CLAWMEM_CAUSAL_WRITER=on.`);
    }
    return;
  }

  // --- resolve-unmaterializable ----------------------------------------------
  const action = flagValue("--resolve-unmaterializable");
  if (!action) {
    die("Nothing to do: pass --preflight, --resolve-unmaterializable, or --restore-edge.");
  }
  if (action !== "keep-weight" && action !== "retire-edge") {
    die(`--resolve-unmaterializable must be keep-weight or retire-edge (got "${action}")`);
  }
  // Bulk resolution is refused for unprovable-origin metadata: application acts
  // only on edges EXPLICITLY SELECTED from the preview, never on "all qualifying".
  if (edgeArgs.length === 0) {
    die("Explicit selection required: pass one --edge <src>:<tgt> per edge from the preflight preview. Bulk resolution is not supported.");
  }
  const manifestPath = flagValue("--manifest");
  if (!manifestPath) {
    die("--manifest <file> (from --preflight --out) is required — application is bound to the previewed row images.");
  }
  let manifest: { version: string; edges: Array<{ sourceId: number; targetId: number; fingerprint: string; materializable: boolean }> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    die(`Cannot read manifest ${manifestPath}: ${err}`);
  }
  const note = flagValue("--note");

  if (!apply) {
    for (const edge of edgeArgs) {
      const entry = manifest.edges.find(e => e.sourceId === edge.sourceId && e.targetId === edge.targetId);
      if (!entry) {
        console.log(`${c.red}NOT IN MANIFEST${c.reset} ${edge.sourceId}→${edge.targetId} — regenerate the preflight preview.`);
      } else if (entry.materializable) {
        console.log(`${c.red}WOULD REFUSE${c.reset} ${edge.sourceId}→${edge.targetId}: materializable (valid old-writer metadata) — resolves itself lazily; no action needed.`);
      } else {
        console.log(`${c.cyan}Would ${action}${c.reset} ${edge.sourceId}→${edge.targetId} (fingerprint ${entry.fingerprint.slice(0, 12)}…).`);
      }
    }
    console.log(`Re-run with --apply to execute.`);
    return;
  }

  const startedAt = monoNow();
  const runKey = randomUUID();
  // Pessimistic terminal outcome (same discipline as restore): born cli_error,
  // flipped to cli_ok only by successful finalization — failure representation
  // never depends on a second successful write.
  const runId = insertCausalRun(s.db, { runKey, source: "cli_migrate", mode: "cli", outcome: "cli_error" });
  let failures = 0;
  try {
    for (const edge of edgeArgs) {
      const entry = manifest.edges.find(e => e.sourceId === edge.sourceId && e.targetId === edge.targetId);
      if (!entry) {
        console.log(`${c.red}REFUSED${c.reset} ${edge.sourceId}→${edge.targetId}: not in the manifest — regenerate the preflight preview.`);
        failures++;
        continue;
      }
      // Resolution acts on UNRESOLVED edges only — an edge whose old-writer
      // metadata is valid materializes lazily and must never be retired here.
      if (entry.materializable) {
        console.log(`${c.red}REFUSED${c.reset} ${edge.sourceId}→${edge.targetId}: materializable (valid old-writer metadata) — no resolution needed.`);
        failures++;
        continue;
      }
      const outcome = applyResolution(
        s.db,
        { sourceId: edge.sourceId, targetId: edge.targetId, fingerprint: entry.fingerprint, manifestVersion: manifest.version },
        action,
        { runKey, runId, operatorNote: note },
      );
      if (outcome.status === "resolved") {
        console.log(`${c.green}${action === "keep-weight" ? "Materialized" : "Retired"}${c.reset} ${edge.sourceId}→${edge.targetId}.`);
      } else if (outcome.status === "stale") {
        console.log(`${c.yellow}STALE${c.reset} ${edge.sourceId}→${edge.targetId}: ${outcome.reason} — row untouched; re-run --preflight.`);
        failures++;
      } else {
        console.log(`${c.red}REFUSED${c.reset} ${edge.sourceId}→${edge.targetId}: ${outcome.reason}`);
        failures++;
      }
    }
  } catch (err) {
    finalizeCliCausalRun(s.db, runId, "cli_error", startedAt);
    throw err;
  }
  finalizeCliCausalRun(s.db, runId, failures > 0 ? "cli_error" : "cli_ok", startedAt);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

/**
 * `clawmem causal-audit` — the D5 operator inspection surface over
 * `causal_runs` / `causal_run_events` (shadow-mode calibration and general
 * writer forensics). Read-only.
 */
async function cmdCausalAudit(args: string[]) {
  const s = getStore();
  const json = args.includes("--json");
  const runKeyIdx = args.indexOf("--run");
  const runKey = runKeyIdx !== -1 ? args[runKeyIdx + 1] : null;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? Math.max(1, Math.min(200, Number(args[limitIdx + 1]) || 20)) : 20;

  if (runKey) {
    const run = s.db.prepare(`SELECT * FROM causal_runs WHERE run_key = ?`).get(runKey) as Record<string, unknown> | null;
    if (!run) die(`No causal run with run_key ${runKey}.`);
    const events = s.db.prepare(
      `SELECT scope, event_type, source_doc_id, target_doc_id, source_fact_ordinal,
              target_fact_ordinal, confidence, detail, created_at
       FROM causal_run_events WHERE run_id = ? ORDER BY id`,
    ).all(run.id as number) as Record<string, unknown>[];
    if (json) {
      console.log(JSON.stringify({ run, events }, null, 2));
      return;
    }
    console.log(`${c.bold}Run ${runKey}${c.reset} (${run.source}/${run.mode}) outcome=${c.cyan}${run.outcome}${c.reset}`);
    console.log(`  started=${run.started_at} finished=${run.finished_at ?? "—"} duration=${run.duration_ms ?? "—"}ms model=${run.model ?? "—"}`);
    console.log(`  new=${run.new_doc_count} window=${run.window_doc_count} candidates=${run.candidate_count} admitted=${run.admitted_count}`);
    console.log(`  edges: written=${run.edges_written} refused=${run.edges_refused} errored=${run.edges_errored}`);
    console.log(`  ${events.length} event(s):`);
    for (const ev of events) {
      const pair = ev.source_doc_id != null ? ` ${ev.source_doc_id}→${ev.target_doc_id ?? "?"}` : "";
      const ords = ev.source_fact_ordinal != null ? ` [${ev.source_fact_ordinal}→${ev.target_fact_ordinal}]` : "";
      const conf = ev.confidence != null ? ` conf=${ev.confidence}` : "";
      const detail = ev.detail ? ` — ${String(ev.detail).slice(0, 80)}` : "";
      console.log(`    ${String(ev.scope).padEnd(8)} ${c.cyan}${ev.event_type}${c.reset}${pair}${ords}${conf}${detail}`);
    }
    return;
  }

  const runs = s.db.prepare(
    `SELECT run_key, session_id, source, mode, outcome, candidate_count, admitted_count,
            edges_written, edges_refused, edges_errored, started_at, duration_ms
     FROM causal_runs ORDER BY started_at DESC, id DESC LIMIT ?`,
  ).all(limit) as Record<string, unknown>[];
  if (json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.log("No causal runs recorded. The writer audits runs when CLAWMEM_CAUSAL_WRITER is shadow or on.");
    return;
  }
  console.log(`${c.bold}Recent causal runs${c.reset} (${runs.length}; --run <run_key> for events):`);
  for (const r of runs) {
    console.log(
      `  ${r.started_at}  ${String(r.mode).padEnd(6)} ${c.cyan}${String(r.outcome).padEnd(14)}${c.reset} ` +
      `cand=${r.candidate_count} adm=${r.admitted_count} w/r/e=${r.edges_written}/${r.edges_refused}/${r.edges_errored} ` +
      `${r.duration_ms ?? "—"}ms  ${c.dim}${r.run_key}${c.reset}`,
    );
  }
}

async function cmdLifecycle(args: string[]) {
  const subCmd = args[0];
  const subArgs = args.slice(1);

  switch (subCmd) {
    case "status": {
      const store = getStore();
      const stats = store.getLifecycleStats();
      const { loadVaultConfig } = await import("./config.ts");
      const config = loadVaultConfig();
      const policy = config.lifecycle;

      console.log(`Active: ${stats.active}`);
      console.log(`Archived (auto): ${stats.archived}`);
      console.log(`Forgotten (manual): ${stats.forgotten}`);
      console.log(`Deactivation reasons: absent ${stats.deactivation_reasons.absent}, forget ${stats.deactivation_reasons.forget}, archive ${stats.deactivation_reasons.archive}, unknown-legacy ${stats.deactivation_reasons.unknown_legacy}`);
      console.log(`Pinned: ${stats.pinned}`);
      console.log(`Snoozed: ${stats.snoozed}`);
      console.log(`Never accessed: ${stats.neverAccessed}`);
      console.log(`Oldest access: ${stats.oldestAccess?.slice(0, 10) || "n/a"}`);
      console.log();
      if (policy) {
        console.log(`Policy: archive after ${policy.archive_after_days}d, purge after ${policy.purge_after_days ?? "never"}, dry_run=${policy.dry_run}`);
        if (policy.exempt_collections.length > 0) {
          console.log(`Exempt: ${policy.exempt_collections.join(", ")}`);
        }
        if (Object.keys(policy.type_overrides).length > 0) {
          const overrides = Object.entries(policy.type_overrides)
            .map(([k, v]) => `${k}=${v === null ? "never" : v + "d"}`)
            .join(", ");
          console.log(`Type overrides: ${overrides}`);
        }
      } else {
        console.log("Policy: none configured");
      }
      break;
    }

    case "sweep": {
      const { values } = parseArgs({
        args: subArgs,
        options: { "dry-run": { type: "boolean", default: false } },
        allowPositionals: false,
      });
      const dryRun = values["dry-run"];

      const { loadVaultConfig } = await import("./config.ts");
      const config = loadVaultConfig();
      const policy = config.lifecycle;
      if (!policy) {
        die("No lifecycle policy configured in config.yaml");
        return;
      }

      const store = getStore();
      const candidates = store.getArchiveCandidates(policy);

      if (dryRun || policy.dry_run) {
        console.log(`Would archive ${candidates.length} document(s):`);
        for (const c of candidates) {
          console.log(`  - ${c.collection}/${c.path} (${c.content_type}, modified ${c.modified_at.slice(0, 10)}, accessed ${c.last_accessed_at?.slice(0, 10) || "never"})`);
        }
        if (candidates.length === 0) console.log("  (none)");
        return;
      }

      // Archival only. ClawMem no longer physically deletes document rows from any code
      // path — see the retention note in src/store.ts. `purge_after_days` is inert.
      const archived = store.archiveDocuments(candidates.map(c => c.id));
      console.log(`Lifecycle sweep: archived ${archived} document(s). Nothing was deleted.`);
      if (policy.purge_after_days) {
        console.log(
          `  Note: purge_after_days=${policy.purge_after_days} is set but INERT — ClawMem no ` +
          `longer deletes rows. Archived docs stay restorable (clawmem lifecycle restore).`
        );
      }
      break;
    }

    case "restore": {
      const { values } = parseArgs({
        args: subArgs,
        options: {
          query: { type: "string" },
          collection: { type: "string" },
          all: { type: "boolean", default: false },
        },
        allowPositionals: false,
      });

      const store = getStore();

      if (values.query) {
        const results = store.searchArchived(values.query, 20);

        if (results.length === 0) {
          console.log("No archived documents match that query.");
          return;
        }

        const restored = store.restoreArchivedDocuments({ ids: results.map(r => r.id) });
        console.log(`Restored ${restored}:`);
        for (const r of results) {
          console.log(`  - ${r.collection}/${r.path} (archived ${r.archived_at?.slice(0, 10)})`);
        }
      } else if (values.collection) {
        const restored = store.restoreArchivedDocuments({ collection: values.collection });
        console.log(`Restored ${restored} documents from collection "${values.collection}"`);
      } else if (values.all) {
        const restored = store.restoreArchivedDocuments({});
        console.log(`Restored ${restored} archived documents`);
      } else {
        die("Usage: clawmem lifecycle restore --query <term> | --collection <name> | --all");
      }
      break;
    }

    case "search": {
      const query = subArgs.join(" ").trim();
      if (!query) {
        die("Usage: clawmem lifecycle search <query>");
        return;
      }

      const store = getStore();
      const results = store.searchArchived(query);

      if (results.length === 0) {
        console.log("No archived documents match that query.");
        return;
      }

      console.log(`Found ${results.length} archived document(s):\n`);
      for (const r of results) {
        console.log(`  [${r.score.toFixed(3)}] ${r.collection}/${r.path}`);
        console.log(`          ${r.title} (archived ${r.archived_at?.slice(0, 10)})`);
      }
      break;
    }

    default:
      die("Usage: clawmem lifecycle <status|sweep|search|restore>");
  }
}

// =============================================================================
// Cross-Session Reflection (E5)
// =============================================================================

async function cmdReflect(args: string[]) {
  const store = getStore();
  const days = parseInt(args[0] || "14");
  const cutoff = toDate(epochNow());
  cutoff.setDate(cutoff.getDate() - days);

  // §51.1 D13: reflection is about when content was authored, not when it was filed
  const recentDocs = store.getDocumentsByType("decision", 50, { orderBy: "effective" })
    .filter(d => d.effectiveAt && d.effectiveAt >= cutoff.toISOString());

  if (recentDocs.length === 0) {
    console.log(`No decisions found in the last ${days} days.`);
    return;
  }

  console.log(`${c.bold}Reflection Report${c.reset} (last ${days} days, ${recentDocs.length} decisions)\n`);

  // Noun-phrase clustering: find recurring 2-3 word phrases across decisions
  const phrases = new Map<string, number>();
  const stopWords = new Set(["the", "that", "this", "with", "from", "have", "will", "been", "were", "they", "their", "what", "when", "which", "about", "into", "more", "some", "than", "them", "then", "very", "also", "just", "should", "would", "could", "does", "make", "like", "using", "used"]);

  for (const d of recentDocs) {
    const doc = store.findDocument(d.path);
    if ("error" in doc) continue;
    const body = store.getDocumentBody(doc) || "";
    const words = body.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    // M2: Ordered bigrams (preserve phrase direction)
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]!} ${words[i + 1]!}`;
      phrases.set(pair, (phrases.get(pair) || 0) + 1);
    }
    // Trigrams for better phrase capture
    for (let i = 0; i < words.length - 2; i++) {
      const triple = `${words[i]!} ${words[i + 1]!} ${words[i + 2]!}`;
      phrases.set(triple, (phrases.get(triple) || 0) + 1);
    }
  }

  // Report patterns appearing 3+ times (prefer longer phrases)
  const patterns = [...phrases.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => {
      // Prefer trigrams over bigrams at same count
      const lenDiff = b[0].split(" ").length - a[0].split(" ").length;
      return b[1] - a[1] || lenDiff;
    })
    .slice(0, 20);

  if (patterns.length > 0) {
    console.log(`${c.bold}Recurring Themes:${c.reset}`);
    for (const [pair, count] of patterns) {
      console.log(`  ${c.green}[${count}x]${c.reset} ${pair}`);
    }
  } else {
    console.log("No recurring patterns found (threshold: 3+ occurrences).");
  }

  // Also report antipatterns
  const antiDocs = store.getDocumentsByType("antipattern", 10, { orderBy: "effective" })
    .filter(d => d.effectiveAt && d.effectiveAt >= cutoff.toISOString());

  if (antiDocs.length > 0) {
    console.log(`\n${c.bold}Recent Antipatterns (${antiDocs.length}):${c.reset}`);
    for (const d of antiDocs) {
      console.log(`  ${c.red}●${c.reset} ${d.title} (${d.effectiveAt?.slice(0, 10)})`);
    }
  }

  // Co-activation clusters
  const coActs = store.db.prepare(`
    SELECT doc_a, doc_b, count FROM co_activations
    WHERE count >= 3
    ORDER BY count DESC
    LIMIT 10
  `).all() as { doc_a: string; doc_b: string; count: number }[];

  if (coActs.length > 0) {
    console.log(`\n${c.bold}Strong Co-Activations (accessed together 3+ times):${c.reset}`);
    for (const ca of coActs) {
      console.log(`  ${c.cyan}[${ca.count}x]${c.reset} ${ca.doc_a} ↔ ${ca.doc_b}`);
    }
  }
}

// =============================================================================
// Memory Consolidation (E12)
// =============================================================================

async function cmdConsolidate(args: string[]) {
  const store = getStore();
  const dryRun = args.includes("--dry-run");
  const maxDocs = parseInt(args.find(a => /^\d+$/.test(a)) || "50");

  // Find low-confidence documents that might be duplicates
  const candidates = store.db.prepare(`
    SELECT id, collection, path, title, hash, confidence, modified_at
    FROM documents
    WHERE active = 1 AND confidence < 0.4
    ORDER BY confidence ASC
    LIMIT ?
  `).all(maxDocs) as { id: number; collection: string; path: string; title: string; hash: string; confidence: number; modified_at: string }[];

  if (candidates.length === 0) {
    console.log("No low-confidence documents to consolidate.");
    return;
  }

  console.log(`${c.bold}Consolidation Analysis${c.reset} (${candidates.length} candidates, confidence < 0.4)${dryRun ? " [DRY RUN]" : ""}\n`);

  let mergeCount = 0;

  for (const candidate of candidates) {
    // BM25 search with title as query to find similar docs
    const similar = store.searchFTS(candidate.title, 5);
    const candidateBody = store.getDocumentBody({ filepath: `clawmem://${candidate.collection}/${candidate.path}` } as any) || "";

    const matches = similar.filter(r => {
      if (r.filepath === `clawmem://${candidate.collection}/${candidate.path}`) return false;
      if (r.score < 0.7) return false;

      // M1: Require same collection
      const rCollection = r.collectionName;
      if (rCollection !== candidate.collection) return false;

      // M1: Require body similarity (Jaccard on word sets)
      const matchBody = r.body || "";
      if (matchBody.length === 0 || candidateBody.length === 0) return false;
      const wordsA = new Set(candidateBody.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const wordsB = new Set(matchBody.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      if (wordsA.size === 0 || wordsB.size === 0) return false;
      let intersection = 0;
      for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
      const jaccard = intersection / (wordsA.size + wordsB.size - intersection);
      if (jaccard < 0.4) return false;

      return true;
    });

    if (matches.length === 0) continue;

    const bestMatch = matches[0]!;
    console.log(`  ${c.yellow}Duplicate:${c.reset} ${candidate.collection}/${candidate.path} (conf: ${candidate.confidence.toFixed(2)})`);
    console.log(`  ${c.green}Keep:${c.reset}      ${bestMatch.displayPath} (score: ${bestMatch.score.toFixed(3)})`);

    if (!dryRun) {
      // Archive the lower-confidence duplicate
      store.archiveDocuments([candidate.id]);
      mergeCount++;
    }
    console.log();
  }

  console.log(`${dryRun ? "Would consolidate" : "Consolidated"}: ${mergeCount} document(s)`);
}

// =============================================================================
// Curate — automated maintenance (designed for cron/timer)
// =============================================================================

interface CuratorReport {
  timestamp: string;
  health: {
    active: number;
    archived: number;
    forgotten: number;
    deactivationReasons: { absent: number; forget: number; archive: number; unknown_legacy: number };
    pinned: number;
    snoozed: number;
    neverAccessed: number;
    embeddingBacklog: number;
    infrastructure: string;
  };
  sweep: { candidates: number };
  consolidation: { candidates: number };
  retrieval: { bm25Pass: boolean; topScore: number };
  collections: { total: number; orphaned: string[]; neverAccessedPct: number };
  actions: string[];
}

async function cmdDiary(args: string[]) {
  const subCmd = args[0];
  const subArgs = args.slice(1);

  switch (subCmd) {
    case "write": {
      const { values, positionals } = parseArgs({
        args: subArgs,
        options: {
          topic: { type: "string", short: "t", default: "general" },
          agent: { type: "string", short: "a", default: "user" },
        },
        allowPositionals: true,
      });

      const entry = positionals.join(" ");
      if (!entry) die("Usage: clawmem diary write <entry text> [-t topic] [-a agent-name]");

      const s = getStore();
      const now = toDate(epochNow());
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
      const ms = String(now.getMilliseconds()).padStart(3, "0");
      const diaryPath = `diary/${dateStr}-${timeStr}${ms}-${values.topic}.md`;
      const body = [
        "---",
        `title: "${entry.slice(0, 80).replace(/"/g, '\\"')}"`,
        `content_type: note`,
        `tags: [diary, ${values.topic}]`,
        `domain: "${values.agent}"`,
        "---",
        "",
        entry,
      ].join("\n");

      const result = s.saveMemory({
        collection: "_clawmem",
        path: diaryPath,
        title: entry.slice(0, 80),
        body,
        contentType: "note",
        confidence: 0.7,
        semanticPayload: `${diaryPath}::${entry}`,
      });

      console.log(`${c.green}✓${c.reset} Diary entry saved (${result.action}, doc #${result.docId})`);
      break;
    }

    case "read": {
      const { values } = parseArgs({
        args: subArgs,
        options: {
          last: { type: "string", short: "n", default: "10" },
          agent: { type: "string", short: "a" },
        },
        allowPositionals: false,
      });

      const limit = parseInt(values.last || "10", 10);
      const s = getStore();

      const rows = s.db.prepare(`
        SELECT d.id, d.path, d.title, d.modified_at as modifiedAt, d.domain,
               c.doc as body
        FROM documents d
        JOIN content c ON c.hash = d.hash
        WHERE d.active = 1 AND d.collection = '_clawmem' AND d.path LIKE 'diary/%'
          AND ${notLegacyArtifactSql("d", "c.doc")}
        ${values.agent ? "AND d.domain = ?" : ""}
        ORDER BY d.modified_at DESC
        LIMIT ?
      `).all(...(values.agent ? [values.agent, limit] : [limit])) as any[];

      if (rows.length === 0) {
        console.log("No diary entries found.");
        break;
      }

      console.log(`${c.bold}Diary${c.reset} (${rows.length} entries)\n`);
      for (const row of rows) {
        const agent = row.domain ? ` [${row.domain}]` : "";
        console.log(`${c.dim}${row.modifiedAt.slice(0, 16)}${c.reset}${agent} ${row.title}`);
      }
      break;
    }

    default:
      console.log(`Usage:
  clawmem diary write <entry> [-t topic] [-a agent]   Write diary entry
  clawmem diary read [-n limit] [-a agent]            Read recent entries`);
  }
}

async function cmdCurate(_args: string[]) {
  const s = getStore();
  const report: CuratorReport = {
    timestamp: isoNow(),
    health: { active: 0, archived: 0, forgotten: 0, deactivationReasons: { absent: 0, forget: 0, archive: 0, unknown_legacy: 0 }, pinned: 0, snoozed: 0, neverAccessed: 0, embeddingBacklog: 0, infrastructure: "healthy" },
    sweep: { candidates: 0 },
    consolidation: { candidates: 0 },
    retrieval: { bm25Pass: false, topScore: 0 },
    collections: { total: 0, orphaned: [], neverAccessedPct: 0 },
    actions: [],
  };

  console.log(`${c.bold}ClawMem Curator${c.reset} — ${isoNow().slice(0, 10)}\n`);

  // Phase 0: Health snapshot
  try {
    const stats = s.getLifecycleStats();
    const status = s.getStatus();
    report.health = {
      active: stats.active,
      archived: stats.archived,
      forgotten: stats.forgotten,
      deactivationReasons: stats.deactivation_reasons,
      pinned: stats.pinned,
      snoozed: stats.snoozed,
      neverAccessed: stats.neverAccessed,
      embeddingBacklog: status.needsEmbedding,
      infrastructure: "healthy",
    };
    console.log(`  Documents: ${stats.active} active, ${stats.archived} archived, ${stats.forgotten} forgotten`);
    console.log(`  Deactivation reasons: absent ${stats.deactivation_reasons.absent}, forget ${stats.deactivation_reasons.forget}, archive ${stats.deactivation_reasons.archive}, unknown-legacy ${stats.deactivation_reasons.unknown_legacy}`);
    console.log(`  Pinned: ${stats.pinned} | Snoozed: ${stats.snoozed} | Never accessed: ${stats.neverAccessed}`);
    console.log(`  Embedding backlog: ${status.needsEmbedding}`);
    if (status.needsEmbedding > 0) {
      report.actions.push(`${status.needsEmbedding} documents need embedding`);
    }
  } catch (err) {
    console.log(`  ${c.red}Health snapshot failed:${c.reset} ${err}`);
    report.health.infrastructure = "error";
  }

  // Phase 1: Doctor (infrastructure)
  try {
    let issues = 0;
    const collections = collectionsList();
    for (const col of collections) {
      if (!existsSync(col.path)) {
        report.collections.orphaned.push(col.name);
        issues++;
      }
    }
    report.collections.total = collections.length;
    if (issues > 0) {
      report.health.infrastructure = `${issues} issue(s)`;
      report.actions.push(`${issues} orphaned collection(s): ${report.collections.orphaned.join(", ")}`);
    }
    console.log(`  Infrastructure: ${issues === 0 ? `${c.green}healthy${c.reset}` : `${c.yellow}${issues} issue(s)${c.reset}`}`);
  } catch (err) {
    console.log(`  ${c.red}Doctor failed:${c.reset} ${err}`);
  }

  // Phase 2: Lifecycle sweep (dry-run)
  console.log();
  try {
    const { loadVaultConfig } = await import("./config.ts");
    const config = loadVaultConfig();
    if (config.lifecycle) {
      const candidates = s.getArchiveCandidates(config.lifecycle);
      report.sweep.candidates = candidates.length;
      console.log(`  Sweep: ${candidates.length} archive candidate(s) [dry-run]`);
      if (candidates.length > 0) {
        report.actions.push(`${candidates.length} documents eligible for archival`);
      }
    } else {
      console.log(`  Sweep: no lifecycle policy configured`);
    }
  } catch (err) {
    console.log(`  ${c.red}Sweep failed:${c.reset} ${err}`);
  }

  // Phase 3: Consolidation (dry-run)
  try {
    const candidates = s.db.prepare(`
      SELECT id, collection, path, title, hash, confidence
      FROM documents WHERE active = 1 AND confidence < 0.4
      ORDER BY confidence ASC LIMIT 50
    `).all() as { id: number; collection: string; path: string; title: string; hash: string; confidence: number }[];

    let dupes = 0;
    for (const candidate of candidates) {
      const similar = s.searchFTS(candidate.title, 5);
      const candidateBody = s.getDocumentBody({ filepath: `clawmem://${candidate.collection}/${candidate.path}` } as any) || "";
      for (const r of similar) {
        if (r.filepath === `clawmem://${candidate.collection}/${candidate.path}`) continue;
        if (r.score < 0.7 || r.collectionName !== candidate.collection) continue;
        const matchBody = r.body || "";
        if (!matchBody || !candidateBody) continue;
        const wordsA = new Set(candidateBody.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const wordsB = new Set(matchBody.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        if (wordsA.size === 0 || wordsB.size === 0) continue;
        let intersection = 0;
        for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
        const jaccard = intersection / (wordsA.size + wordsB.size - intersection);
        if (jaccard >= 0.4) { dupes++; break; }
      }
    }
    report.consolidation.candidates = dupes;
    console.log(`  Consolidation: ${dupes} duplicate candidate(s) [dry-run]`);
    if (dupes > 0) {
      report.actions.push(`${dupes} duplicate documents found — run \`clawmem consolidate\` to review`);
    }
  } catch (err) {
    console.log(`  ${c.red}Consolidation check failed:${c.reset} ${err}`);
  }

  // Phase 4: Retrieval probe (BM25)
  try {
    const results = s.searchFTS("architecture decision", 3);
    const topScore = results[0]?.score || 0;
    report.retrieval.bm25Pass = results.length > 0 && topScore > 0.3;
    report.retrieval.topScore = topScore;
    console.log(`  Retrieval: ${report.retrieval.bm25Pass ? `${c.green}OK${c.reset}` : `${c.red}DEGRADED${c.reset}`} (BM25 top=${topScore.toFixed(3)})`);
    if (!report.retrieval.bm25Pass) {
      report.actions.push("Retrieval degraded — BM25 probe returned no strong results");
    }
  } catch (err) {
    console.log(`  ${c.red}Retrieval probe failed:${c.reset} ${err}`);
    report.actions.push("Retrieval probe failed");
  }

  // Phase 5: Collection hygiene
  try {
    const naPct = report.health.active > 0
      ? Math.round((report.health.neverAccessed / report.health.active) * 100)
      : 0;
    report.collections.neverAccessedPct = naPct;
    if (naPct > 30) {
      report.actions.push(`${report.health.neverAccessed} documents never accessed (${naPct}%) — consider review`);
    }
  } catch {
    // non-critical
  }

  // Write report
  const reportPath = pathResolve(process.env.HOME || "~", ".cache", "clawmem", "curator-report.json");
  try {
    mkdirSync(pathResolve(reportPath, ".."), { recursive: true });
    Bun.write(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n  Report: ${reportPath}`);
  } catch (err) {
    console.log(`  ${c.red}Failed to write report:${c.reset} ${err}`);
  }

  // Summary
  console.log();
  if (report.actions.length === 0) {
    console.log(`${c.green}No actions needed.${c.reset}`);
  } else {
    console.log(`${c.bold}Actions (${report.actions.length}):${c.reset}`);
    for (const a of report.actions) {
      console.log(`  ${c.yellow}→${c.reset} ${a}`);
    }
  }
}

// =============================================================================
// 62.1 stop pipeline: repair counters, repair stop-queue, recover antipatterns
// =============================================================================

/** The general vault and every configured named vault, as stores (a vault that cannot open is reported, skipped). */
async function stopPipelineVaults(): Promise<{ name: string; store: StoreType; general: boolean }[]> {
  const { resolveStore } = await import("./store.ts");
  const { listVaults } = await import("./config.ts");
  const out: { name: string; store: StoreType; general: boolean }[] = [{ name: "general", store: getStore(), general: true }];
  for (const name of listVaults()) {
    try { out.push({ name, store: resolveStore(name), general: false }); }
    catch (err) { console.log(`${c.yellow}!${c.reset} vault ${name}: cannot open (${err instanceof Error ? err.message : String(err)}) — skipped`); }
  }
  return out;
}

async function cmdRepair(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "counters") {
    const { values } = parseArgs({
      args: rest,
      options: { apply: { type: "boolean" }, restore: { type: "string" }, "remove-fence": { type: "boolean" }, force: { type: "boolean" } },
      allowPositionals: false,
    });
    const { recomputeCounters, restoreCounterRepair, removeStopFence } = await import("./stop-repair.ts");
    const { preserveAntipatternBodies } = await import("./stop-recover.ts");
    const { loadVaultConfig } = await import("./config.ts");
    const policy = loadVaultConfig().lifecycle;
    for (const v of await stopPipelineVaults()) {
      const db = v.store.db;
      if (values["remove-fence"]) {
        const n = removeStopFence(db);
        console.log(`${v.name}: dropped ${n} fence trigger(s). An upgraded ClawMem reinstalls them at its next writable open — run this only after every v0.41+ process sharing the vault has stopped.`);
        continue;
      }
      if (values.restore) {
        try {
          const r = restoreCounterRepair(db, values.restore);
          console.log(`${v.name}: restored ${r.restored} value(s) of op ${r.opId}; ${r.conflicts.length} conflict(s)`);
          for (const cfl of r.conflicts.slice(0, 50)) console.log(`  ${c.yellow}conflict${c.reset} ${cfl}`);
        } catch (err) {
          console.log(`${v.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      if (values.apply && v.general) {
        const copied = await preserveAntipatternBodies(db);
        if (copied > 0) console.log(`${v.name}: preserved ${copied} overwritten antipattern bodies (see 'clawmem recover antipatterns')`);
      }
      try {
        const r = await recomputeCounters(db, { apply: values.apply === true, policy, force: values.force === true });
        if (values.apply && r.alreadyDone && !values.force) { console.log(`${v.name}: already recomputed (--force to run again)`); continue; }
        const verb = values.apply ? "recomputed" : "would recompute";
        console.log(`${v.name}: ${verb} — frozen ${r.frozen} pre-upgrade usage row(s); documents ${r.documents} (grace ${r.graced}); utility signals ${r.utility}; co-activations ${r.coActivationsDeleted} removed / ${r.coActivationsInserted} verified; usage relations ${r.relationsDeleted} removed / ${r.relationsInserted} verified${r.opId ? ` [op ${r.opId}]` : ""}`);
      } catch (err) {
        console.log(`${c.red}✗${c.reset} ${v.name}: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
    if (!values.apply && !values.restore && !values["remove-fence"]) console.log(`${c.dim}Dry run. Re-run with --apply to write (before-images go to counter_repair_log; --restore <op> reverses).${c.reset}`);
    return;
  }
  if (sub === "stop-queue") {
    const { values } = parseArgs({
      args: rest,
      options: {
        run: { type: "boolean" }, dismiss: { type: "string" }, "dismiss-causal": { type: "boolean" },
        "retry-now": { type: "string" }, limit: { type: "string" },
      },
      allowPositionals: false,
    });
    const s = getStore();
    const { dismissStopRetry, dismissCausalMarkers, causalDismissRefusal, runStopWorkerTick, retryNowStopRetries, stopQueueNextDue } = await import("./stop-worker.ts");
    if (values.dismiss) {
      console.log(dismissStopRetry(s, Number(values.dismiss)) ? `dismissed quarantined range ${values.dismiss}` : `no open quarantined range ${values.dismiss}`);
      return;
    }
    if (values["dismiss-causal"]) {
      const refusal = causalDismissRefusal(s);
      const n = refusal === null ? dismissCausalMarkers(s) : null;
      if (n === null) {
        console.log(`${c.yellow}!${c.reset} refused: ${refusal ?? "a causal consumer is active"}. --dismiss-causal is for steps waiting while every consumer keeps the writer off: set CLAWMEM_CAUSAL_WRITER=off for the watcher and the hooks, wait an hour without causal activity, then run it again. (It cannot see a consumer that is idle — switching them all off is on you.)`);
        process.exitCode = 1;
      } else {
        console.log(`dismissed ${n} causal marker(s) — those ranges' causal step will not run`);
      }
      return;
    }
    // v0.41.4 (§7.1): make held ranges due now — queued rows only; a claimed row's lease is never touched.
    let selected: number[] | null = null;
    if (values["retry-now"] !== undefined) {
      const raw = values["retry-now"].trim();
      const ids = raw === "held" ? null : raw.split(",").map(x => Number(x.trim()));
      if (ids && (ids.length === 0 || ids.some(n => !Number.isInteger(n) || n <= 0))) die("--retry-now takes `held` or a comma-separated list of range ids");
      const limit = values.limit === undefined ? 50 : Number(values.limit);
      if (!Number.isInteger(limit) || limit <= 0) die("--limit takes a positive whole number");
      selected = retryNowStopRetries(s, ids ?? "held", limit);
      console.log(selected.length > 0 ? `rescheduled ${selected.length} range(s) to retry now: ${selected.join(", ")}` : "no queued range matched --retry-now");
    }
    if (values.run) {
      // v0.41.4 (§7.2): a bounded drain — a pass counts as progress when anything moved OR a replay row was attempted
      // (whatever its outcome), at most 20 passes; no exactly-once promise, and future-due work is not waited for.
      const vaults = (await stopPipelineVaults()).filter(v => !v.general).map(v => ({ name: v.name, store: v.store }));
      const attempted = new Set<number>();
      // One quiet window for the passes and the report, so the report counts as due what a pass would take (codex T7-10).
      const RUN_QUIET_MS = 0;
      for (let i = 0; i < 20; i++) {
        const r = await runStopWorkerTick(s, vaults, getDefaultLlamaCpp(), { quietMs: RUN_QUIET_MS });
        const moved = r.attributed + r.provisional + r.unattributable + r.mirrors + r.digested + r.rendered + r.replayed + r.rejudged + r.causal;
        for (const id of r.attemptedIds) attempted.add(id);
        console.log(`pass ${i + 1}: attributed ${r.attributed} (+${r.provisional} provisional), unattributable ${r.unattributable}, mirrors ${r.mirrors}, digested ${r.digested}, rendered ${r.rendered}, replayed ${r.replayed}, attempted ${r.attempted}, rejudged ${r.rejudged}, causal ${r.causal}`);
        for (const e of r.errors) console.log(`  ${c.yellow}!${c.reset} ${e}`);
        if (moved + r.attempted === 0) break;
      }
      if (selected) {
        const notReached = selected.filter(id => !attempted.has(id));
        console.log(`retry-now: ${selected.length} rescheduled, ${selected.length - notReached.length} attempted, ${notReached.length} not reached${notReached.length > 0 ? ` (${notReached.join(", ")})` : ""}`);
      }
      console.log(stopQueueNextDue(s.db, { quietMs: RUN_QUIET_MS, vaults }));
    }
    const { stopPipelineHealth } = await import("./stop-health.ts");
    const h = stopPipelineHealth(s.db);
    console.log(`quarantined ranges ${h.stopRetries.count} (unavailable ${h.unavailableRanges}) · feedback pending ${h.feedbackPending.count} (keyless ${h.keylessPending}), provisional ${h.feedbackProvisional.count} · judge deferred ${h.judgeDeferred.count} · handoff renders ${h.handoffRenders.count} · causal runnable ${h.causalRunnable}, waiting on mode off ${h.causalWaitingOff}`);
    return;
  }
  die("Usage: clawmem repair counters [--apply] [--restore <op>] [--remove-fence] [--force]\n       clawmem repair stop-queue [--retry-now <id[,id…]|held> [--limit N]] [--run] [--dismiss <id>] [--dismiss-causal]");
}

async function cmdRecover(args: string[]) {
  if (args[0] !== "antipatterns") die("Usage: clawmem recover antipatterns [--apply] [--min-occurrences N]");
  const { values } = parseArgs({
    args: args.slice(1),
    options: { apply: { type: "boolean" }, "min-occurrences": { type: "string" } },
    allowPositionals: false,
  });
  const s = getStore();
  const { preserveAntipatternBodies, listRecoveredAntipatterns, applyRecoveredAntipatterns } = await import("./stop-recover.ts");
  await preserveAntipatternBodies(s.db);
  const min = values["min-occurrences"] ? Number(values["min-occurrences"]) : 1;
  const list = listRecoveredAntipatterns(s.db);
  console.log(`${list.length} distinct antipattern assertion(s) in overwritten bodies (${list.filter(a => a.occurrences >= min).length} with ≥ ${min} occurrence(s))`);
  for (const a of list.slice(0, 50)) console.log(`  ${String(a.occurrences).padStart(4)}×  ${a.firstSeen.slice(0, 10)} … ${a.lastSeen.slice(0, 10)}  ${a.text}`);
  if (!values.apply) { console.log(`${c.dim}Dry run. --apply writes the accepted set as _clawmem/antipatterns/recovered-<YYYY-MM>.md.${c.reset}`); return; }
  const w = applyRecoveredAntipatterns(s.db, { minOccurrences: min });
  console.log(`${w.action} _clawmem/${w.path} (${w.assertions} assertion(s))`);
}

function printHelp() {
  console.log(`
${c.bold}ClawMem${c.reset} - Hybrid Agent Memory

${c.bold}Setup:${c.reset}
  clawmem init                         Initialize ClawMem
  clawmem bootstrap <path> [--name N]  One-command setup (init+add+update+embed+hooks+mcp)
  clawmem collection add <path> --name <name>
  clawmem collection list
  clawmem collection remove <name>
  clawmem setup hooks [--remove]       Install/remove Claude Code hooks
  clawmem setup mcp [--remove]         Register/remove MCP in ~/.claude.json
  clawmem setup openclaw [--link] [--remove]   Install/remove ClawMem as OpenClaw memory plugin
  clawmem install-service [--enable]   Install systemd watcher service

${c.bold}Indexing:${c.reset}
  clawmem update [--pull] [--embed]    Re-scan collections (--embed auto-embeds)
  clawmem mine <dir> [-c name] [--embed] [--synthesize]  Import conversation exports (Claude, ChatGPT, Slack); --synthesize runs post-import LLM fact extraction; preserves per-exchange authored_at
  clawmem mine <dir> -c name --backfill-dates [--apply]  Derive authored_at for already-mined docs from source transcripts (metadata-only; dry-run without --apply)
  clawmem embed [-f]                   Generate fragment embeddings
  clawmem reindex [--force] [--enrich]  Full re-index (--enrich: run entity extraction + links on all docs)
  clawmem watch                        File watcher daemon
  clawmem status                       Show index status

${c.bold}Search:${c.reset}
  clawmem search <query> [-n N]        BM25 keyword search
  clawmem vsearch <query> [-n N]       Vector similarity
  clawmem query <query> [-n N]         Hybrid + rerank (best)

${c.bold}Eval:${c.reset}
  clawmem eval run --gold <file.jsonl> [--limit N] [--audited] [--out DIR] [--db <snapshot>]  Replay gold-labeled queries through the live pipeline (J_doc/recall/MRR); exits 1 when the trust gate fails

${c.bold}Memory:${c.reset}
  clawmem list [-n/--limit N] [-c col]  Browse recent documents (--json for machine output)
  clawmem budget [--session ID]        Token utilization
  clawmem log [--last N]               Session history
  clawmem profile                      Show user profile
  clawmem profile rebuild              Force profile rebuild
  clawmem focus set <topic> [--session-id ID]   Set per-session focus topic (steers context-surfacing)
  clawmem focus show [--session-id ID]          Show current focus topic
  clawmem focus clear [--session-id ID]         Clear focus topic

${c.bold}Hooks:${c.reset}
  clawmem hook <name>                  Run hook (stdin JSON)
  clawmem surface --context --stdin    IO6a: pre-prompt context injection
  clawmem surface --bootstrap --stdin  IO6b: per-session bootstrap injection

${c.bold}Lifecycle:${c.reset}
  clawmem lifecycle status             Show lifecycle stats + policy
  clawmem lifecycle sweep [--dry-run]  Archive stale docs per policy
  clawmem lifecycle search <query>     Search archived docs (FTS, no restore)
  clawmem lifecycle restore --query Q  Restore archived docs by keyword
  clawmem lifecycle restore --collection N  Restore by collection
  clawmem lifecycle restore --all      Restore all archived docs

${c.bold}Stop pipeline:${c.reset}
  clawmem repair counters [--apply] [--restore <op>] [--remove-fence] [--force]
                                       Recompute feedback counters from verified references (dry run without --apply)
  clawmem repair stop-queue [--retry-now <id[,id…]|held> [--limit N]] [--run] [--dismiss <id>] [--dismiss-causal]
                                       Show, drain (--run) or dismiss the stop pipeline's queues
  clawmem recover antipatterns [--apply] [--min-occurrences N]
                                       List (or write) the antipatterns earlier versions overwrote

${c.bold}Intelligence:${c.reset}
  clawmem reflect [days]               Cross-session pattern analysis
  clawmem consolidate [--dry-run]      Merge duplicate low-confidence docs
  clawmem curate                       Automated maintenance (health, sweep, dedup, hygiene)
  clawmem diary write <entry> [-t topic]  Write a diary entry (for non-hooked environments)
  clawmem diary read [-n N] [-a agent]    Read recent diary entries

${c.bold}Integration:${c.reset}
  clawmem mcp                          Start stdio MCP server
  clawmem serve [--port 7438] [--host 127.0.0.1] [--no-token]  Start HTTP REST API server (token required by default)
  clawmem serve-token                  Print the token serve uses (CLAWMEM_API_TOKEN, else the generated token file)
  clawmem update-context               Regenerate all directory CLAUDE.md files
  clawmem doctor                       Full health check
  clawmem vec-daemon-health [--db P] [--json]   Is the watcher's vector daemon Path-A authoritative? (exit 0 ONLY when live: attested DB/pid + hydrated-v1; live-raw/live-legacy = listener present but non-authoritative, exit 1)
  clawmem rerank-health [--json]       Probe reranker discrimination (exit 1 if degenerate)
  clawmem migrate causal-witnesses --preflight [--out <manifest.json>]
                                       Census unresolved pre-cut causal edges (run before CLAWMEM_CAUSAL_WRITER=on)
  clawmem migrate causal-witnesses --resolve-unmaterializable keep-weight|retire-edge
      --manifest <file> --edge <src>:<tgt> [--note <text>] [--apply]
                                       Resolve an explicitly selected unresolved edge (manifest-bound)
  clawmem migrate causal-witnesses --restore-edge <src>:<tgt> [--apply]
                                       Restore a retired causal edge from the archive (fail-closed)
  clawmem causal-audit [--limit N] [--run <run_key>] [--json]
                                       Inspect causal writer runs/events (shadow calibration)

${c.bold}Options:${c.reset}
  -n, --num <N>        Number of results
  -c, --collection     Filter by collection
  --json               JSON output
  --min-score <N>      Minimum score threshold
  -f, --force          Force re-embed/reindex all
  --force-geometry     Override a failing embed geometry-canary preflight
  --recalibrate-canary Replace the stored canary baseline (first-healthy otherwise)
  --pull               Run update commands before indexing
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
