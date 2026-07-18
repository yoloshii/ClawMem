#!/usr/bin/env bun
/**
 * ClawMem CLI - Hybrid agent memory (QMD search + SAME memory layer)
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
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
import { startVectorDaemon, type VectorDaemonHandle } from "./vector-daemon.ts";
import {
  getDefaultLlamaCpp,
  setDefaultLlamaCpp,
  disposeDefaultLlamaCpp,
  formatDocForEmbedding,
  formatQueryForEmbedding,
  LlamaCpp,
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
import { indexCollection, parseDocument, hashContent } from "./indexer.ts";
import type { Store as StoreType } from "./store.ts";
import type { ConversationChunk } from "./normalize.ts";
import { detectBeadsProject } from "./beads.ts";
import { applyCompositeScoring, hasRecencyIntent, type EnrichedResult } from "./memory.ts";
import { enrichResults, reciprocalRankFusion, toRanked, hasStrongFtsSignal, ftsBypassEnabled, type RankedResult } from "./search-utils.ts";
import { splitDocument } from "./splitter.ts";
import { getProfile, updateProfile, isProfileStale } from "./profile.ts";
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
import { contextSurfacing } from "./hooks/context-surfacing.ts";
import { sessionBootstrap } from "./hooks/session-bootstrap.ts";
import { decisionExtractor } from "./hooks/decision-extractor.ts";
import { handoffGenerator } from "./hooks/handoff-generator.ts";
import { feedbackLoop } from "./hooks/feedback-loop.ts";
import { stalenessCheck } from "./hooks/staleness-check.ts";
import { precompactExtract } from "./hooks/precompact-extract.ts";
import { postcompactInject } from "./hooks/postcompact-inject.ts";
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
  printSetupOpenClawHelp,
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
    console.log(`  ${c.green}+${stats.added}${c.reset} added, ${c.yellow}~${stats.updated}${c.reset} updated, ${c.dim}=${stats.unchanged}${c.reset} unchanged, ${c.red}-${stats.removed}${c.reset} removed`);
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
    updateProfile(s);
    console.log(`${c.dim}Profile auto-rebuilt (stale)${c.reset}`);
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
  const stagingDir = pathResolve(tmpdir(), `clawmem-mine-${Date.now()}`);
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

    // Index through existing pipeline
    console.log(`\n${c.cyan}Indexing ${totalChunks} conversation chunks${c.reset} as collection '${collectionName}'`);
    const stats = await indexCollection(s, collectionName, stagingDir, "**/*.md");
    const datedNote = stats.dated > 0 ? `, ${c.cyan}◷${stats.dated}${c.reset} dated` : "";
    console.log(`  ${c.green}+${stats.added}${c.reset} added, ${c.yellow}~${stats.updated}${c.reset} updated, ${c.dim}=${stats.unchanged}${c.reset} unchanged${datedNote}`);

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
    const finalizeCanary = async (failedFragmentsCount: number) => {
      const setTaint = (reason: string) =>
        markSafeGlobal("setVaultFlag(taint)", () => s.setVaultFlag("embed_geometry_taint", reason, leaseGuard));
      if (!canaryState) {
        console.error(`${c.red}WARNING: this run had NO validated preflight geometry (canary unavailable). The vault state is UNVERIFIED — run 'clawmem embed --force' against a validated server to clear.${c.reset}`);
        await setTaint(`no preflight validation at ${new Date().toISOString()}`);
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
        console.error(`${c.red}WARNING: end-of-run geometry verification FAILED (endpoint unreachable or dimension changed). This run is UNVERIFIED — treat the vault state as suspect. Re-run 'clawmem embed' once the server is stable.${c.reset}`);
        await setTaint(`unverified end-of-run at ${new Date().toISOString()}`);
        process.exitCode = 1;
      } else if (endDrift < CANARY_DRIFT_FLOOR) {
        console.error(`${c.red}WARNING: embedding-server geometry DRIFTED mid-run (probe self-sim ${endDrift.toFixed(4)} < ${CANARY_DRIFT_FLOOR}). This rebuild is TAINTED — the vault mixes two geometries. Stabilize the server, then run 'clawmem embed --force'.${c.reset}`);
        await setTaint(`mid-run drift ${endDrift.toFixed(4)} at ${new Date().toISOString()}`);
        process.exitCode = 1;
      } else {
        // Verified end. A FULL verified rebuild (--force) clears any standing taint —
        // the mixed-geometry state the flag records has been rebuilt away (T8-M1).
        // leaseLost is re-checked first: a reclaimed holder must not clear a
        // successor's taint (T9-M4).
        if (values.force && failedFragmentsCount === 0 && !leaseLost) {
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
    let totalFragments = 0;
    let failedFragments = 0;
    const batchStart = Date.now();

    // Cloud API: global batch pacing state (persists across documents)
    // TPM is the binding constraint, not RPM. 50 frags × ~800 tokens ≈ 40K tokens/batch → max ~2.5 batches/min at 100K TPM.
    const isCloudEmbed = !!process.env.CLAWMEM_EMBED_API_KEY;
    const CLOUD_BATCH_SIZE = 50;
    const CLOUD_TPM_LIMIT = parseInt(process.env.CLAWMEM_EMBED_TPM_LIMIT || "100000", 10);
    const CLOUD_TPM_SAFETY = 0.85; // use 85% of limit to leave headroom for retries
    const CHARS_PER_TOKEN = 4;
    let lastBatchSentAt = 0; // global timestamp of last batch send

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
      const docStart = Date.now();
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
          if (lastBatchSentAt > 0) {
            // Adaptive TPM-aware delay. Set CLAWMEM_EMBED_TPM_LIMIT to match your tier:
            //   Free: 100000 (default), Paid: 2000000, Premium: 50000000
            const batchEnd0 = Math.min(batchStartIdx + CLOUD_BATCH_SIZE, allTexts.length);
            const estimatedTokens = allTexts.slice(batchStartIdx, batchEnd0)
              .reduce((sum, t) => sum + Math.ceil(t.length / CHARS_PER_TOKEN), 0);
            // Use current batch estimate (not previous batch actuals — previous batch may differ in size)
            const batchTokens = estimatedTokens;
            const safeTPM = CLOUD_TPM_LIMIT * CLOUD_TPM_SAFETY;
            const requiredGapMs = Math.max(500, (batchTokens / safeTPM) * 60_000);
            const elapsed = Date.now() - lastBatchSentAt;
            const remainingMs = requiredGapMs - elapsed;
            if (remainingMs > 0) {
              const jittered = Math.floor(remainingMs * (0.85 + Math.random() * 0.3));
              await new Promise(r => setTimeout(r, jittered));
            }
          }

          const batchEnd = Math.min(batchStartIdx + CLOUD_BATCH_SIZE, allTexts.length);
          const batchTexts = allTexts.slice(batchStartIdx, batchEnd);
          lastBatchSentAt = Date.now();
          const reqStart = Date.now();

          try {
            const results = await llm.embedBatch(batchTexts);
            const reqMs = Date.now() - reqStart;
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
                    result.model, new Date().toISOString(), frag.type, frag.label ?? undefined, canId,
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
            const fragStart = Date.now();
            const result = await llm.embed(text);
            const fragMs = Date.now() - fragStart;
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
                  result.model, new Date().toISOString(), frag.type, frag.label ?? undefined, canId,
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
      const docMs = Date.now() - docStart;
      const elapsed = ((Date.now() - batchStart) / 1000).toFixed(0);
      console.error(`  → doc done in ${(docMs / 1000).toFixed(1)}s | ${embedded}/${hashes.length} docs, ${totalFragments} frags, ${failedFragments} fails [${elapsed}s elapsed]`);
    }

    const totalSec = ((Date.now() - batchStart) / 1000).toFixed(1);
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
  const usage = "Usage: clawmem eval run --gold <file.jsonl> [--profile query] [--limit N] [--min-examples N] [--audited] [--out <dir>] [--db <path>] [--json]";
  const sub = args[0];
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
      outDir: values.out ? pathResolve(values.out) : pathResolve(`eval-runs/${new Date().toISOString().replace(/[:.]/g, "-")}-${profile}`),
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

  const input = await readHookInput();
  // Open the store capped from the START for the context-surfacing hook (not just after open via the
  // PRAGMA below) so a contended init cannot wait the full 5000ms default before it is narrowed. Other
  // hooks (Stop-lane, 30s budget) keep the 5000ms default.
  const s = getStore(hookName === "context-surfacing" ? CONTEXT_SURFACING_WRITE_BUSY_TIMEOUT_MS : 5000);
  let output: HookOutput;

  try {
    switch (hookName) {
      case "context-surfacing":
        // Scope the small busy_timeout to THIS process only. Each `clawmem
        // hook` invocation runs exactly one hook, so the Stop hooks
        // (decision-extractor / handoff-generator / feedback-loop, 30s budget)
        // run in separate processes and keep the store default (5000ms).
        try { s.db.exec(`PRAGMA busy_timeout = ${CONTEXT_SURFACING_WRITE_BUSY_TIMEOUT_MS}`); } catch { /* non-fatal */ }
        output = await contextSurfacing(s, input);
        break;
      case "session-bootstrap":
        output = await sessionBootstrap(s, input);
        break;
      case "decision-extractor":
        output = await decisionExtractor(s, input);
        break;
      case "handoff-generator":
        output = await handoffGenerator(s, input);
        break;
      case "feedback-loop":
        output = await feedbackLoop(s, input);
        break;
      case "staleness-check":
        output = await stalenessCheck(s, input);
        break;
      case "precompact-extract":
        output = await precompactExtract(s, input);
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
      const sessionId = input.trim() || `io6-${Date.now()}`;

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
  const s = getStore();
  const { startServer } = await import("./server.ts");
  const server = startServer(s, port, host);
  console.log(`ClawMem HTTP server listening on http://${host}:${port}`);
  console.log(`Token auth: ${process.env.CLAWMEM_API_TOKEN ? "enabled" : "disabled (set CLAWMEM_API_TOKEN)"}`);
  console.log(`Press Ctrl+C to stop.`);
  // Keep alive
  await new Promise(() => {});
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

  if (remove) {
    // Remove clawmem hooks
    for (const event of ["UserPromptSubmit", "Stop", "SessionStart", "PreCompact"]) {
      if (settings.hooks[event]) {
        settings.hooks[event] = settings.hooks[event].filter((entry: any) =>
          !entry.hooks?.some((h: any) => h.command?.includes("clawmem"))
        );
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }
    console.log(`${c.green}Removed ClawMem hooks from ${settingsPath}${c.reset}`);
  } else {
    // Install clawmem hooks
    const hookConfig: Record<string, string[]> = {
      UserPromptSubmit: ["context-surfacing"],
      SessionStart: ["postcompact-inject", "curator-nudge"],
      PreCompact: ["precompact-extract"],
      Stop: ["decision-extractor", "handoff-generator", "feedback-loop"],
    };

    // Use Claude Code's native timeout property instead of shell `timeout` wrapper.
    // Shell `timeout` kills the process with SIGTERM (exit 124) which produces
    // "Stop hook error: Failed with non-blocking status code" in Claude Code.
    // Native timeout is handled gracefully by the hook runner.
    const timeouts: Record<string, number> = {
      UserPromptSubmit: 8,
      SessionStart: 5,
      PreCompact: 5,
      Stop: 30, // LLM-based extraction hooks need more time
    };

    for (const [event, hooks] of Object.entries(hookConfig)) {
      if (!settings.hooks[event]) settings.hooks[event] = [];

      // Remove existing clawmem entries first
      settings.hooks[event] = settings.hooks[event].filter((entry: any) =>
        !entry.hooks?.some((h: any) => h.command?.includes("clawmem"))
      );

      const timeout = timeouts[event] || 5;

      // Add new entries with native timeout property
      settings.hooks[event].push({
        matcher: "",
        hooks: hooks.map(name => ({
          type: "command",
          command: `${binPath} hook ${name}`,
          timeout,
        })),
      });
    }

    console.log(`${c.green}Installed ClawMem hooks to ${settingsPath}${c.reset}`);
    for (const [event, hooks] of Object.entries(hookConfig)) {
      console.log(`  ${event}: ${hooks.join(", ")}`);
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
    const r = Bun.spawnSync(["openclaw", "config", "get", key], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return undefined;
    const out = new TextDecoder().decode(r.stdout).trim();
    if (!out) return undefined;
    // `openclaw config get` may print JSON ("clawmem"\n) or raw (clawmem). Strip quotes.
    return out.replace(/^"(.*)"$/, "$1");
  } catch {
    return undefined;
  }
}

async function cmdSetupOpenClaw(args: string[]) {
  // §28.2 — short-circuit on --help / -h before any spawn or filesystem work.
  if (args.includes("--help") || args.includes("-h")) {
    printSetupOpenClawHelp();
    return;
  }

  const remove = args.includes("--remove");
  const linkMode = args.includes("--link");
  const pluginDir = pathResolve(import.meta.dir, "openclaw");

  // Resolve the extensions/clawmem path we would touch directly. Both Path 1
  // link-mode pre-cleanup and Path 3 direct-copy install need this. Path 1
  // copy-mode delegation does NOT use linkPath because OpenClaw's
  // `--force` install owns the destination resolution there.
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
        ["openclaw", "plugins", "uninstall", "clawmem", "--force"],
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
        Bun.spawnSync(["openclaw", "config", "unset", "plugins.slots.memory"], { stdout: "inherit", stderr: "inherit" });
        console.log(`${c.green}Cleared memory slot (was clawmem)${c.reset}`);
      }
      // Reset the legacy context-engine slot if any pre-§14.3-migration install
      // left it pointing at clawmem.
      const ceSlot = readOpenClawConfigValue("plugins.slots.contextEngine");
      if (ceSlot === "clawmem") {
        Bun.spawnSync(["openclaw", "config", "set", "plugins.slots.contextEngine", "legacy"], { stdout: "inherit", stderr: "inherit" });
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
  let delegated = false;
  if (hasOpenClawCli) {
    // Path 1: delegate to OpenClaw. Auto-enables, writes install records,
    // applies slot selection, refreshes registry.
    if (linkMode) {
      // §28.1 H2 link-mode: OpenClaw rejects --force with --link, so we do
      // manual stale cleanup before delegating to preserve idempotence.
      try {
        const { lstatSync, unlinkSync, rmSync } = await import("fs");
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          unlinkSync(linkPath);
          console.log(`${c.dim}Replaced stale symlink at ${linkPath}${c.reset}`);
        } else if (stat.isDirectory()) {
          rmSync(linkPath, { recursive: true });
          console.log(`${c.dim}Replaced existing directory at ${linkPath}${c.reset}`);
        }
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      const r = Bun.spawnSync(
        ["openclaw", "plugins", "install", pluginDir, "-l"],
        { stdout: "inherit", stderr: "inherit" },
      );
      if (r.exitCode !== 0) {
        die(`openclaw plugins install -l failed (exit ${r.exitCode}); aborting setup`);
      }
      // OpenClaw's `plugins install -l` records the source path in
      // plugins.load.paths and persists a path install record (not a
      // filesystem symlink). The v2026.4.11 symlink-discovery skip does
      // NOT apply to this mode — discovery uses the load-path entry.
      console.log(`${c.green}Linked local plugin path via openclaw plugins install -l (profile-aware, auto-enabled)${c.reset}`);
      console.log(`${c.dim}  Source recorded in plugins.load.paths — edits to ${pluginDir} take effect on next gateway restart.${c.reset}`);
    } else {
      // §28.1 H2 copy-mode: --force makes OpenClaw replace existing target,
      // preserving idempotence across reruns.
      const r = Bun.spawnSync(
        ["openclaw", "plugins", "install", pluginDir, "--force"],
        { stdout: "inherit", stderr: "inherit" },
      );
      if (r.exitCode !== 0) {
        die(`openclaw plugins install --force failed (exit ${r.exitCode}); aborting setup`);
      }
      console.log(`${c.green}Installed plugin via openclaw plugins install --force (profile-aware, auto-enabled)${c.reset}`);
    }
    delegated = true;
  } else {
    // Path 3: direct-copy fallback. Honors OPENCLAW_STATE_DIR via the
    // resolveExtensionsDirNoOpenClaw helper. Profile awareness is limited
    // to env vars (no manifest validation, no security scan, no install
    // records) — surface that to the user.
    console.log(`${c.yellow}openclaw CLI not on PATH — using direct-copy install.${c.reset}`);
    console.log(`${c.yellow}  Profile awareness limited to OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH${c.reset}`);
    console.log(`${c.yellow}  env vars. Install OpenClaw to enable manifest validation, security${c.reset}`);
    console.log(`${c.yellow}  scans, and full plugin lifecycle management.${c.reset}`);

    // Create extensions directory.
    if (!existsSync(extensionsDir)) {
      mkdirSync(extensionsDir, { recursive: true });
    }

    // Remove any stale install (symlink or directory) before re-installing.
    // OpenClaw v2026.4.11+ discovery (discoverInDirectory in ids-*.js) uses
    // readdirSync({ withFileTypes: true }) where symlinks report
    // isDirectory() === false and get silently skipped, so copy mode is the
    // default. The --link flag keeps symlink behavior for older OpenClaw
    // versions or local development workflows where editing the live source
    // should take effect without re-running setup.
    try {
      const { lstatSync, unlinkSync, rmSync } = await import("fs");
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        unlinkSync(linkPath);
        console.log(`${c.dim}Replaced stale symlink at ${linkPath}${c.reset}`);
      } else if (stat.isDirectory()) {
        rmSync(linkPath, { recursive: true });
        console.log(`${c.dim}Replaced existing directory at ${linkPath}${c.reset}`);
      } else {
        die(`${linkPath} exists but is not a symlink or directory. Remove it manually and re-run setup.`);
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }

    if (linkMode) {
      const { symlinkSync } = await import("fs");
      symlinkSync(pluginDir, linkPath);
      console.log(`${c.green}Installed plugin: ${linkPath} → ${pluginDir} (symlink)${c.reset}`);
      console.log(`${c.yellow}  Warning: symlink mode. OpenClaw v2026.4.11+ discovery skips${c.reset}`);
      console.log(`${c.yellow}  symlinks silently. Re-run without --link on current releases.${c.reset}`);
    } else {
      const { cpSync } = await import("fs");
      cpSync(pluginDir, linkPath, { recursive: true, dereference: true });
      console.log(`${c.green}Installed plugin: ${linkPath} (copied from ${pluginDir})${c.reset}`);
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
        ["openclaw", "config", "set", "plugins.slots.contextEngine", "legacy"],
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
    console.log(`  1. Enable ClawMem as the active memory plugin:`);
    console.log(`     ${c.cyan}openclaw plugins enable clawmem${c.reset}`);
    console.log(`     ${c.dim}(Switches plugins.slots.memory to clawmem and disables memory-core if active.)${c.reset}`);
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

async function cmdWatch() {
  const { startWatcher } = await import("./watcher.ts");
  const collections = collectionsList()
    .sort((a, b) => b.path.length - a.path.length); // Most specific path first for prefix matching

  if (collections.length === 0) {
    die("No collections configured. Add one first: clawmem collection add <path> --name <name>");
  }

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
      // Find which collection this belongs to
      const col = collections.find(c => fullPath.startsWith(c.path));
      if (!col) return;

      // Beads: trigger sync on any change within .beads/ directory
      // Dolt backend writes to .beads/dolt/ — watch for any file change there
      if (fullPath.includes(".beads/")) {
        const projectDir = detectBeadsProject(fullPath.replace(/\/\.beads\/.*$/, ""));
        if (projectDir) {
          const relativePath = fullPath.slice(col.path.length + 1);
          console.log(`${c.dim}[${event}]${c.reset} ${col.name}/${relativePath}`);
          const result = await s.syncBeadsIssues(projectDir);
          console.log(`  beads: +${result.created} ~${result.synced}`);
        }
        return;
      }

      // Quick pattern check: skip files that can't match the collection pattern
      // before touching the DB. This prevents broad path collections (e.g. ~/Projects)
      // with narrow patterns (e.g. single filename) from triggering DB access on
      // every .md change under the tree.
      const relativePath = fullPath.slice(col.path.length + 1);
      if (col.pattern && col.pattern !== "**/*.md") {
        const patterns = col.pattern.includes("{")
          ? col.pattern.replace(/^\{|\}$/g, "").split(",")
          : [col.pattern];
        const couldMatch = patterns.some(p => {
          // Simple glob check: if pattern has no wildcards, it's a filename match
          if (!p.includes("*") && !p.includes("?")) return relativePath === p || relativePath.endsWith("/" + p);
          // If pattern starts with **/, any relative path could match
          if (p.startsWith("**/")) return true;
          // If pattern has a directory prefix, check it
          const patternDir = p.substring(0, p.lastIndexOf("/") + 1);
          if (patternDir) return relativePath.startsWith(patternDir);
          return true; // Fallback: let indexCollection handle it
        });
        if (!couldMatch) return;
      }

      console.log(`${c.dim}[${event}]${c.reset} ${col.name}/${relativePath}`);

      // Re-index just this collection
      const stats = await indexCollection(s, col.name, col.path, col.pattern);
      if (stats.added > 0 || stats.updated > 0 || stats.removed > 0) {
        console.log(`  +${stats.added} ~${stats.updated} -${stats.removed}`);
      }
    },
    onError: (err) => {
      console.error(`${c.red}Watch error: ${err.message}${c.reset}`);
    },
  });

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

  // Block forever — shutdown is driven by signal handlers registered above.
  await new Promise(() => {});
}

// =============================================================================
// Reindex
// =============================================================================

async function cmdReindex(args: string[]) {
  const force = args.includes("--force") || args.includes("-f");
  const enrich = args.includes("--enrich");
  const collections = collectionsList();

  if (collections.length === 0) {
    die("No collections configured.");
  }

  const s = getStore();

  if (force) {
    // Delete all documents and re-scan
    s.db.exec("UPDATE documents SET active = 0");
    console.log(`${c.yellow}Force reindex: deactivated all documents${c.reset}`);
  }

  if (enrich) {
    console.log(`${c.cyan}Full enrichment: entity extraction + links + evolution for all documents${c.reset}`);
  }

  for (const col of collections) {
    console.log(`Indexing ${c.bold}${col.name}${c.reset} (${col.path})...`);
    const stats = await indexCollection(s, col.name, col.path, col.pattern, { forceEnrich: enrich });
    console.log(`  +${stats.added} added, ~${stats.updated} updated, =${stats.unchanged} unchanged, -${stats.removed} removed`);
  }
}

// =============================================================================
// Doctor (Health Check)
// =============================================================================

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
      } else {
        console.log(`${c.yellow}!${c.reset} Claude Code hooks: not installed (run 'clawmem setup hooks')`);
      }
    } else {
      console.log(`${c.yellow}!${c.reset} Claude Code hooks: settings.json not found`);
    }
  } catch {
    console.log(`${c.yellow}!${c.reset} Claude Code hooks: could not check`);
  }

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
    const { probeRerankHealth } = await import("./health/rerank-health.ts");
    const health = await probeRerankHealth(s, { timeoutMs: 8000 });
    if (health.ok) {
      console.log(`${c.green}✓${c.reset} Reranker: discriminates (coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toFixed(2)} ≥ ${health.thresholds.calibFloor}, min margin ${health.minMargin.toFixed(2)} ≥ ${health.thresholds.discrimMargin})`);
    } else {
      console.log(`${c.red}✗${c.reset} Reranker: degenerate / not discriminating (coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toExponential(1)}, min margin ${health.minMargin.toFixed(2)})`);
      for (const f of health.failures.slice(0, 4)) console.log(`   ${c.dim}${f}${c.reset}`);
      console.log(`   ${c.dim}Likely the deprecated zerank-2 GGUF (no score head) — re-deploy the seq-cls sidecar. See CLAUDE.md "SOTA upgrade".${c.reset}`);
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
  const { probeRerankHealth } = await import("./health/rerank-health.ts");
  const health = await probeRerankHealth(store, timeoutMs ? { timeoutMs } : {});

  if (values.json) {
    console.log(JSON.stringify(health));
  } else if (health.ok) {
    console.log(`${c.green}✓ Reranker healthy${c.reset} — coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toFixed(2)} ≥ ${health.thresholds.calibFloor}, min margin ${health.minMargin.toFixed(2)} ≥ ${health.thresholds.discrimMargin}`);
  } else {
    console.log(`${c.red}✗ Reranker degenerate / not discriminating${c.reset} — coverage ${health.pairsScored}/${health.pairsTotal}, max score ${health.maxScore.toExponential(1)}, min margin ${health.minMargin.toFixed(2)}`);
    for (const f of health.failures) console.log(`  - ${f}`);
    console.log(`Likely the deprecated zerank-2 GGUF (no score head) — re-deploy the seq-cls sidecar. See CLAUDE.md "SOTA upgrade".`);
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
    updateProfile(s);
    console.log(`${c.green}Profile rebuilt${c.reset}`);
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

      const archived = store.archiveDocuments(candidates.map(c => c.id));
      let purged = 0;
      if (policy.purge_after_days) {
        purged = store.purgeArchivedDocuments(policy.purge_after_days);
      }
      console.log(`Lifecycle sweep: archived ${archived}, purged ${purged}`);
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
  const cutoff = new Date();
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
      const now = new Date();
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
    timestamp: new Date().toISOString(),
    health: { active: 0, archived: 0, forgotten: 0, pinned: 0, snoozed: 0, neverAccessed: 0, embeddingBacklog: 0, infrastructure: "healthy" },
    sweep: { candidates: 0 },
    consolidation: { candidates: 0 },
    retrieval: { bm25Pass: false, topScore: 0 },
    collections: { total: 0, orphaned: [], neverAccessedPct: 0 },
    actions: [],
  };

  console.log(`${c.bold}ClawMem Curator${c.reset} — ${new Date().toISOString().slice(0, 10)}\n`);

  // Phase 0: Health snapshot
  try {
    const stats = s.getLifecycleStats();
    const status = s.getStatus();
    report.health = {
      active: stats.active,
      archived: stats.archived,
      forgotten: stats.forgotten,
      pinned: stats.pinned,
      snoozed: stats.snoozed,
      neverAccessed: stats.neverAccessed,
      embeddingBacklog: status.needsEmbedding,
      infrastructure: "healthy",
    };
    console.log(`  Documents: ${stats.active} active, ${stats.archived} archived, ${stats.forgotten} forgotten`);
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

${c.bold}Intelligence:${c.reset}
  clawmem reflect [days]               Cross-session pattern analysis
  clawmem consolidate [--dry-run]      Merge duplicate low-confidence docs
  clawmem curate                       Automated maintenance (health, sweep, dedup, hygiene)
  clawmem diary write <entry> [-t topic]  Write a diary entry (for non-hooked environments)
  clawmem diary read [-n N] [-a agent]    Read recent diary entries

${c.bold}Integration:${c.reset}
  clawmem mcp                          Start stdio MCP server
  clawmem serve [--port 7438] [--host 127.0.0.1]  Start HTTP REST API server
  clawmem update-context               Regenerate all directory CLAUDE.md files
  clawmem doctor                       Full health check
  clawmem rerank-health [--json]       Probe reranker discrimination (exit 1 if degenerate)

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
