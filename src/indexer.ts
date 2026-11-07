/**
 * ClawMem Indexer - Vault walking, frontmatter parsing, SAME metadata extraction
 *
 * Combines QMD's document indexing with SAME's frontmatter metadata system.
 */

import { Glob } from "bun";
import { isLegacyPrecompactState, retireLegacyPrecompactRow } from "./compaction-state.ts";
import { isoNow } from "./clock.ts";
import { readFileSync, statSync } from "fs";
import { basename, isAbsolute, posix, relative, sep } from "path";
import matter from "gray-matter";
import jsYaml from "js-yaml";
import { createHash } from "crypto";
import type { Store } from "./store.ts";
import { inferContentType, confidenceScore, type ContentType } from "./memory.ts";
import { getDefaultLlamaCpp } from "./llm.ts";
import { normalizeIsoTimestamp } from "./normalize.ts";

// =============================================================================
// Types
// =============================================================================

export interface DocumentMeta {
  title?: string;
  tags?: string[];
  domain?: string;
  workstream?: string;
  content_type?: ContentType;
  review_by?: string;
  /** §51.1: authorship time (UTC ISO) from frontmatter; null = declared-but-invalid or absent → clears/leaves per branch */
  authored_at?: string | null;
}

// =============================================================================
// Authored-at Frontmatter Adapter (§51.1 D5)
// =============================================================================

// Strict date-only form, normalized to UTC midnight. Acceptance must not depend
// on YAML quoting: quoted "2025-03-01" (string) and unquoted 2025-03-01
// (gray-matter coerces to Date) are equivalent.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Frontmatter-specific adapter, distinct from the transcript rule: gray-matter
 * has already discarded the lexical form, so Date instances are validated as
 * finite Dates rather than re-parsed as RFC3339 strings. Returns UTC ISO or
 * null (invalid/absent). Date-only precision is legitimate for hand-dated
 * notes — sub-day uncertainty is insignificant against ClawMem's half-lives.
 */
export function authoredAtFromFrontmatter(value: unknown): string | null {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY_RE.exec(trimmed);
  if (dateOnly) {
    return normalizeIsoTimestamp(`${trimmed}T00:00:00Z`);
  }
  return normalizeIsoTimestamp(trimmed);
}

export interface IndexStats {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** §51.1: dated-only metadata transitions (authored_at set without touching modified_at / A-MEM) */
  dated: number;
  /**
   * A-MEM enrichment outcomes for this run (issue #24, codex turn-1 finding 5):
   * attempted = enrichments that ran (excludes CLAWMEM_ENABLE_AMEM=false);
   * stored = the note step produced and stored content. attempted − stored is
   * the "LLM produced nothing" count — a persistently nonzero gap is the
   * squatted-port / dead-inference signature that per-doc log lines let hide
   * inside an otherwise-successful update summary.
   */
  enrichAttempted: number;
  enrichStored: number;
}

// =============================================================================
// Exclusion Rules
// =============================================================================

export const EXCLUDED_DIRS = new Set([
  "_PRIVATE",
  ".clawmem",
  ".git",
  ".obsidian",
  ".logseq",
  ".foam",
  ".dendron",
  ".trash",
  ".stversions",
  "node_modules",
  ".cache",
  "vendor",
  "dist",
  "build",
  "gits",
  "scraped",
]);

export function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some(s => EXCLUDED_DIRS.has(s) || (s.startsWith(".") && s !== "."));
}

// =============================================================================
// Content Hashing
// =============================================================================

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// =============================================================================
// Title Extraction
// =============================================================================

export function extractTitle(content: string, filename: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(/^#+\s+(.+)/);
    if (match?.[1]) return match[1].trim();
  }
  return basename(filename).replace(/\.(md|txt)$/i, "");
}

// =============================================================================
// Frontmatter engine (82.1 — v0.43.6)
// =============================================================================
//
// gray-matter 4.0.3 reads the text after the opening `---` as a language name and runs the matching engine; its
// default table includes a `javascript` engine that `eval`s the block, and its default YAML engine is an unbounded
// js-yaml `safeLoad` (aliases, `<<` merges, `!!omap`). ClawMem parses frontmatter through ONE frozen options object,
// FRONTMATTER_OPTIONS: the eval engine refuses (C1), the language is allow-listed after the call (C2), the excerpt
// step is disabled (C3), tags are bounded (C4), gray-matter's module cache is bypassed (options disable it, C5), the
// YAML engine is ClawMem's own bounded one (C7) that checks its own contracts with js-yaml at first use (C10), and
// the block is measured BEFORE gray-matter sees it (C9). The binding itself is guarded by a source test (C6).

/** Frontmatter block limits (operator 198 (a) / 201 (a) / 202 (a)): characters, lines, YAML depth and node count. */
export const FRONTMATTER_LIMITS = Object.freeze({ chars: 65536, lines: 1024, depth: 32, nodes: 4096 });

const YAML_MERGE_TAG = "tag:yaml.org,2002:merge";
const YAML_OMAP_TAG = "tag:yaml.org,2002:omap";

/** A js-yaml 3.x surface — what the engine needs, so T10 can hand it a fake. */
export interface FrontmatterYamlLib {
  safeLoad(src: string, options?: Record<string, unknown>): unknown;
  Schema: new (definition: { include?: unknown[]; implicit?: unknown[]; explicit?: unknown[] }) => unknown;
  CORE_SCHEMA: unknown;
  DEFAULT_SAFE_SCHEMA: { implicit: { tag: string }[]; explicit: { tag: string }[] };
}

export interface FrontmatterYamlEngine {
  /** Parses one frontmatter block; throws on anything over the limits, on an anchor, a merge key's expansion, `!!omap`. */
  parse(src: string): unknown;
  /** The self-check's verdict for THIS engine: `broken` ⇒ every parse throws (closed) until the process restarts. */
  status(): { broken: boolean; reason?: string };
}

type ListenerState = { anchorMap?: Record<string, unknown>; anchor?: string | null };

/**
 * C7 + C10 — build the bounded YAML engine over `lib` (js-yaml 3.x). The engine refuses anchors (so no alias can be
 * read and nothing is shared), has no merge type (a `<<` key is an ordinary key) and no `!!omap`, and stops at
 * `FRONTMATTER_LIMITS.depth` levels / `.nodes` nodes / `.chars` characters. Before its FIRST parse it runs a self-test
 * of the contracts those limits rely on — js-yaml reports every node to the listener, in order, with its depth, and
 * exposes anchors through `state.anchorMap` / `state.anchor` — and marks itself BROKEN (every later parse throws;
 * one stderr line, once) when a contract fails, so a js-yaml that stopped reporting could never fail open.
 */
export function makeFrontmatterYamlEngine(lib: FrontmatterYamlLib): FrontmatterYamlEngine {
  const safe = lib.DEFAULT_SAFE_SCHEMA;
  const schema = new lib.Schema({
    include: [lib.CORE_SCHEMA],
    implicit: safe.implicit.filter(t => t.tag !== YAML_MERGE_TAG),
    explicit: safe.explicit.filter(t => t.tag !== YAML_OMAP_TAG),
  });

  /** One bounded load; `trace` (when given) records every listener event as `open:<depth>` / `close:<depth>`. */
  const load = (src: string, trace?: string[]): unknown => {
    if (src.length > FRONTMATTER_LIMITS.chars) throw new Error(`frontmatter block over ${FRONTMATTER_LIMITS.chars} characters`);
    let depth = 0;
    let nodes = 0;
    let events = 0;
    const listener = (event: string, state: ListenerState) => {
      events++;
      // Fail closed on a loader that hides its anchor state, and refuse any anchor — including `&__proto__`, which
      // the `{}` anchorMap stores as a prototype rather than an own entry, so `state.anchor` is checked too.
      if (!state || typeof state.anchorMap !== "object" || state.anchorMap === null) throw new Error("frontmatter YAML: anchor state unavailable");
      if (Object.keys(state.anchorMap).length > 0 || state.anchor != null) throw new Error("frontmatter YAML: anchors are not accepted");
      if (event === "open") {
        depth++;
        nodes++;
        if (depth > FRONTMATTER_LIMITS.depth) throw new Error(`frontmatter YAML nested deeper than ${FRONTMATTER_LIMITS.depth}`);
        if (nodes > FRONTMATTER_LIMITS.nodes) throw new Error(`frontmatter YAML over ${FRONTMATTER_LIMITS.nodes} nodes`);
      } else {
        depth--;
      }
      trace?.push(`${event}:${event === "open" ? depth : depth + 1}`);
    };
    const result = lib.safeLoad(src, { schema, listener });
    // C10 (1): the listener is called for every non-empty block; a loader that called it less has dropped the limits.
    if (events === 0 && src.trim() !== "") throw new Error("frontmatter YAML: the loader reported no nodes");
    return result;
  };

  // C10 (2) — the self-test, once per engine, at first use (never at import: hooks and the stop-judge import this module).
  const SELF_TEST_BLOCK = "a:\n  b: [1, 2]\n  c: d\n";
  // js-yaml 3.14.2's events for that block, recorded 2026-11-07: the root mapping (1); key `a` (2) opens and closes
  // before its value mapping (2) opens; inside it key `b` (3), the sequence (3) holding scalars 1 and 2 (4 each), then
  // key `c` (3) and scalar `d` (3). 18 events — every node, in order, with its depth.
  const SELF_TEST_TRACE = [
    "open:1", "open:2", "close:2", "open:2", "open:3", "close:3", "open:3", "open:4", "close:4", "open:4", "close:4",
    "close:3", "open:3", "close:3", "open:3", "close:3", "close:2", "close:1",
  ];
  let checked = false;
  let broken: string | undefined;
  const fail = (why: string) => { broken = why; process.stderr.write(`clawmem: frontmatter YAML guard self-test FAILED — ${why}; YAML frontmatter is read as plain text until this is fixed (clawmem doctor reports it)\n`); };
  const selfTest = () => {
    checked = true;
    try {
      // (a) the full event trace of a fixed nested block equals the recorded one — every node, in order, with its depth
      const trace: string[] = [];
      load(SELF_TEST_BLOCK, trace);
      if (trace.join(" ") !== SELF_TEST_TRACE.join(" ")) return fail(`node trace differs (${trace.length} events)`);
      // (b) depth 33 throws the depth error; (c) 4,097 nodes throw the node error
      const deep = "a: " + "[".repeat(32) + "1" + "]".repeat(32);
      if (!throws(() => load(deep), /deeper than/)) return fail("depth limit not enforced");
      const wide = "a: [" + Array(4094).fill("1").join(", ") + "]";   // root + key + sequence + 4,094 scalars = 4,097 nodes
      if (!throws(() => load(wide), /nodes/)) return fail("node limit not enforced");
      // (d) an anchor on the FIRST of two sibling values throws at that value's own CLOSE event (js-yaml 3.14.2 sets
      // `state.anchor` as the anchored node finishes composing, measured 2026-11-07), so the trace holds the root,
      // key `a` and the value's open only (4 events) — never the sibling `b`, whose key opens as the 6th event
      const t2: string[] = [];
      if (!throws(() => load("a: &x 1\nb: 2", t2), /anchors are not accepted/)) return fail("anchors not visible to the listener");
      if (t2.length > 4) return fail(`anchor refused only after ${t2.length} events (sibling composed)`);
      // (e) the same block without the anchor parses to the expected object
      const plain = load("a: 1\nb: 2") as Record<string, unknown>;
      if (!plain || plain.a !== 1 || plain.b !== 2) return fail("plain block did not parse");
    } catch (e) {
      return fail(`self-test threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    parse(src: string): unknown {
      if (!checked) selfTest();
      if (broken) throw new Error(`frontmatter YAML guard broken: ${broken}`);
      return load(src);
    },
    status: () => (broken ? { broken: true, reason: broken } : { broken: false }),
  };
}

function throws(fn: () => unknown, re: RegExp): boolean {
  try { fn(); return false; } catch (e) { return re.test(e instanceof Error ? e.message : String(e)); }
}

const FRONTMATTER_YAML = makeFrontmatterYamlEngine(jsYaml as unknown as FrontmatterYamlLib);
const TEST_GUARD_HOOK = process.env.CLAWMEM_TEST_FRONTMATTER_GUARD;   // test seam: "broken" forces the broken state

/** The production engine's self-check verdict (`clawmem doctor` prints a ✗ line when it is broken). */
export function frontmatterGuardStatus(): { broken: boolean; reason?: string } {
  if (TEST_GUARD_HOOK === "broken") return { broken: true, reason: "forced by CLAWMEM_TEST_FRONTMATTER_GUARD (test hook)" };
  try { FRONTMATTER_YAML.parse("self: check"); } catch { /* the status below carries the reason */ }
  return FRONTMATTER_YAML.status();
}

const refuse = (what: string) => ({ parse(): never { throw new Error(`frontmatter ${what} engine is not accepted`); } });

/** C1 / C3 / C5 / C7 — the ONE options object every gray-matter call receives (passing options bypasses its cache). */
const FRONTMATTER_OPTIONS = Object.freeze({
  engines: Object.freeze({
    javascript: refuse("javascript"),
    coffee: refuse("coffee"),
    yaml: { parse: (src: string) => FRONTMATTER_YAML.parse(src) as object },
    json: { parse: (src: string): object => { if (src.length > FRONTMATTER_LIMITS.chars) throw new Error("frontmatter block too large"); return JSON.parse(src); } },
  }),
  excerpt: (): string => "",
});

const ALLOWED_LANGUAGES = (lang: string) => ["yaml", "yml"].includes(lang.toLowerCase()) || lang === "json";

/**
 * C9 — measure the frontmatter block the way gray-matter delimits it, BEFORE calling it: strip one BOM; if the text
 * starts with `---` and the fourth character is not `-`, the block runs from index 3 to the first `\n---` (or the end).
 * Over the character cap, or over the line cap — lines counted the way the comment regex's `^` sees them: every CR, LF,
 * U+2028 and U+2029, CRLF once — the text is NOT frontmatter. Linear: one indexOf, one pass.
 */
function frontmatterBlockWithinLimits(content: string): boolean {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!text.startsWith("---") || text.charAt(3) === "-") return true;      // not frontmatter: nothing to measure
  const close = text.indexOf("\n---", 3);
  const block = text.slice(3, close === -1 ? text.length : close);
  if (block.length > FRONTMATTER_LIMITS.chars) return false;
  let terminators = 0;
  for (let i = 0; i < block.length; i++) {
    const c = block.charCodeAt(i);
    if (c === 0x0a || c === 0x2028 || c === 0x2029) terminators++;
    else if (c === 0x0d) { terminators++; if (block.charCodeAt(i + 1) === 0x0a) i++; }
    if (terminators + 1 > FRONTMATTER_LIMITS.lines) return false;
  }
  return true;
}

/** C4 — `tags`: scalar elements only (string / finite number / boolean), each ≤ 256 characters, at most 64. */
function boundedTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (out.length >= 64) break;
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") {
      const s = String(v);
      if (s.length <= 256) out.push(s);
    }
  }
  return out;
}

// =============================================================================
// Frontmatter Parsing
// =============================================================================

export function parseDocument(content: string, relativePath: string): { body: string; meta: DocumentMeta } {
  // gray-matter coerces YAML values: `title: 2023-09-27` → Date, `title: true` → boolean.
  // All frontmatter fields must be runtime-checked to prevent SQLite binding errors.
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v || undefined : undefined;
  try {
    if (!frontmatterBlockWithinLimits(content)) throw new Error("frontmatter block over the limits");   // C9
    const file = matter(content, FRONTMATTER_OPTIONS);
    // C2 — allow-list the language AFTER the call: `matter("")` returns early with no `language`, so an emptied file
    // is yaml (→ authored_at null, clears a stored date); an EMPTY or comment-only block under a forbidden tag never
    // reached an engine, and the Object-prototype names (`constructor`, `toString`, `valueOf`) return junk `data`.
    const lang = (file as { language?: string }).language || "yaml";
    if (!ALLOWED_LANGUAGES(lang)) throw new Error(`frontmatter language ${lang} is not accepted`);
    const data = (file.data ?? {}) as Record<string, unknown>;
    const body = file.content;
    return {
      body,
      meta: {
        title: str(data.title),
        tags: boundedTags(data.tags),
        domain: str(data.domain),
        workstream: str(data.workstream),
        content_type: (str(data.content_type) as ContentType) || inferContentType(relativePath),
        review_by: str(data.review_by),
        // §51.1: string | null — null means "not validly declared", which CLEARS
        // on the changed-content path (frontmatter is authoritative there).
        authored_at: authoredAtFromFrontmatter(data.authored_at),
      },
    };
  } catch {
    // If frontmatter parsing fails, treat entire content as body.
    // authored_at stays undefined (= leave any stored value untouched):
    // a parse failure is not a declared absence.
    return {
      body: content,
      meta: {
        content_type: inferContentType(relativePath),
      },
    };
  }
}

// =============================================================================
// Quality Scoring
// =============================================================================

export function computeQualityScore(body: string, meta: DocumentMeta): number {
  let score = 0.3; // Base

  // Length signals
  if (body.length > 200) score += 0.1;
  if (body.length > 500) score += 0.1;

  // Structure signals
  if (/^##\s+/m.test(body)) score += 0.1;
  if (/^[-*]\s+/m.test(body)) score += 0.05;

  // Decision/commitment keywords
  if (/\b(decided?\s+to|chose|will\s+use|switching\s+to|going\s+with|selected|adopted)\b/i.test(body)) {
    score += 0.15;
  }

  // Correction keywords
  if (/\b(fix(ed)?|bug|resolved|corrected|patched|root\s+cause)\b/i.test(body)) {
    score += 0.1;
  }

  // Frontmatter richness: +0.05 per populated field, max +0.15
  let metaBonus = 0;
  if (meta.tags && meta.tags.length > 0) metaBonus += 0.05;
  if (meta.domain) metaBonus += 0.05;
  if (meta.workstream) metaBonus += 0.05;
  score += Math.min(0.15, metaBonus);

  // Penalty for trivial stubs
  if (body.length < 50) score -= 0.1;

  return Math.max(0, Math.min(1.0, score));
}

// =============================================================================
// Collection Indexing
// =============================================================================

// Expand top-level brace patterns into individual glob strings.
// e.g. "{MEMORY.md,memory/x.md}" => ["MEMORY.md", "memory/x.md"]
// Patterns without braces pass through unchanged.
function expandBraces(pattern: string): string[] {
  const match = pattern.match(/^\{(.+)\}$/);
  if (!match) return [pattern];
  return match[1]!.split(",").map(s => s.trim());
}

/**
 * Whether a changed file at `relativePath` can match a collection's `pattern` — the watcher's pre-check.
 * It matches the way an index pass scans (the same brace expansion and Bun.Glob), so the watcher never
 * skips a file indexCollection would index. Before v0.40.1 a literal-prefix check dropped every event
 * for a pattern with a wildcard directory (the Claude Code auto-memory pattern) or a brace list with a
 * suffix (`{README,guide}.md`).
 */
export function matchesCollectionPattern(pattern: string, relativePath: string): boolean {
  return expandBraces(pattern).some(p => {
    // A pattern that is not relative to the collection root: let the index pass decide.
    if (p.startsWith("/") || p.split("/").includes("..")) return true;
    // "./README.md", "docs/./x/*.md", "docs//x/*.md" and "**/*.md/" scan the same files as their normal form.
    return new Glob(posix.normalize(p).replace(/\/+$/, "")).match(relativePath);
  });
}

/** `fullPath` relative to `root`, in "/" form — or null when it is not inside `root` (either may be unnormalised). */
export function pathWithin(root: string, fullPath: string): string | null {
  const rel = relative(root, fullPath);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * The collections a changed file re-indexes (the watcher's routing): every collection whose path contains
 * the file and whose pattern can match it, each with the file's path relative to that collection. Before
 * v0.40.1 an event reached only the longest matching path, so an overlapping outer collection missed a file
 * the inner collection's pattern rejected; a string-prefix test also matched `notes-archive/` to `notes`.
 */
export function watchTargets<C extends { name: string; path: string; pattern?: string }>(
  collections: readonly C[],
  fullPath: string,
): { col: C; relativePath: string }[] {
  const targets: { col: C; relativePath: string }[] = [];
  for (const col of collections) {
    const relativePath = pathWithin(col.path, fullPath);
    if (relativePath === null) continue;
    if (col.pattern && col.pattern !== "**/*.md" && !matchesCollectionPattern(col.pattern, relativePath)) continue;
    targets.push({ col, relativePath });
  }
  return targets;
}

/**
 * Collections that are never reconciled against a filesystem root (§55.6 D5).
 *
 * `_clawmem` holds DB-created memory — observations, handoffs, deductions — which has no file
 * behind it. Reconciling it against any root deactivates every row and nothing brings them back.
 * §55.1 required reserving it for one tool; enforcing it in the reconciler covers every present
 * and future caller instead.
 */
export const RESERVED_COLLECTIONS = new Set(["_clawmem"]);

export async function indexCollection(
  store: Store,
  collectionName: string,
  collectionPath: string,
  pattern: string = "**/*.md",
  options?: { forceEnrich?: boolean; force?: boolean; importMode?: boolean }
): Promise<IndexStats> {
  if (RESERVED_COLLECTIONS.has(collectionName)) {
    throw new Error(
      `Collection '${collectionName}' is database-created memory and has no filesystem source; ` +
      `it cannot be reconciled against a root.`,
    );
  }
  const stats: IndexStats = { added: 0, updated: 0, unchanged: 0, removed: 0, dated: 0, enrichAttempted: 0, enrichStored: 0 };
  const activePaths = new Set<string>();

  // importMode: an additive DB-born ingest routed through the filesystem pipeline via a
  // TRANSIENT staging root (`clawmem mine`). Rows are stamped origin 'api' — on insert AND on
  // every update path, so a re-imported changed chunk never flips to 'fs' — and the
  // whole-collection absence reconciliation below is skipped: absence from one run's staging
  // snapshot means nothing, and a later import into the same collection must never deactivate
  // earlier batches.
  const rowOrigin = options?.importMode ? "api" as const : "fs" as const;

  // Get LLM instance for A-MEM enrichment
  const llm = getDefaultLlamaCpp();

  // Bun.Glob doesn't support brace expansion {a,b,c} — expand manually
  const patterns = expandBraces(pattern);
  const seen = new Set<string>();
  const allEntries: string[] = [];
  for (const p of patterns) {
    const glob = new Glob(p);
    for (const f of glob.scanSync({ cwd: collectionPath, followSymlinks: false, absolute: false })) {
      if (!seen.has(f)) {
        seen.add(f);
        allEntries.push(f);
      }
    }
  }

  // Collect doc IDs that need post-index enrichment (deferred until after commit)
  const enrichQueue: { docId: number; isNew: boolean }[] = [];

  // Wrap all DB writes in a transaction for atomicity. IMMEDIATE takes the write lock up front
  // (75.1): the pass reads before it writes, and SQLite never runs the busy handler when a
  // connection that already holds a read transaction asks for the write lock — a deferred BEGIN
  // failed with `database is locked` at once whenever another connection was writing, instead
  // of waiting on busy_timeout. The lock is held while the files are read and hashed; A-MEM
  // enrichment (model calls) stays after the commit.
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const relativePath of allEntries) {
      if (shouldExclude(relativePath)) continue;

      // 62.2: the pre-compaction snapshot ClawMem ≤ v0.39.x wrote into Claude Code memory dirs,
      // recognised by its exact header — never indexed, and left out of activePaths. The file on disk
      // corroborates an indexed copy at its path, which is retired here: an 'fs' one, or a NULL-origin
      // (pre-v0.34) one that absence reconciliation would never touch. Retirement happens on an index
      // pass; retrieval never returns a copy in the meantime, active or not (`notLegacyArtifactSql`),
      // and an older ClawMem that reactivates one gets it retired again by the next pass. A same-named
      // file with any other content is indexed as usual.
      if (relativePath.endsWith("precompact-state.md")) {
        try {
          if (isLegacyPrecompactState(relativePath, readFileSync(`${collectionPath}/${relativePath}`, "utf-8"))) {
            if (retireLegacyPrecompactRow(store, collectionName, relativePath)) stats.removed++;
            continue;
          }
        } catch { /* unreadable here — the read below skips it too */ }
      }

      activePaths.add(relativePath);
      const absolutePath = `${collectionPath}/${relativePath}`;

      let content: string;
      let mtime: Date;
      try {
        content = readFileSync(absolutePath, "utf-8");
        mtime = statSync(absolutePath).mtime;
      } catch {
        continue; // File may have been deleted between scan and read
      }

      const contentHash = hashContent(content);
      const now = isoNow();

      // Check if document already exists
      const existing = store.findActiveDocument(collectionName, relativePath);

      if (existing) {
        // Check if content changed via content hash
        const existingRow = store.db.prepare(
          "SELECT content_hash, authored_at, origin FROM documents WHERE id = ?"
        ).get(existing.id) as { content_hash: string | null; authored_at: string | null; origin: string | null } | null;

        // Ownership-collision boundary: a row explicitly owned by the OPPOSITE origin is
        // never silently taken over — the same rule saveMemory enforces for API writes onto
        // filesystem rows, applied symmetrically (an import colliding with a real file, or a
        // file appearing at an API row's path). Skip the write and surface it; NULL is the
        // only claimable state, adopted by the first writer to touch it.
        if (existingRow?.origin != null && existingRow.origin !== rowOrigin) {
          console.warn(
            `[indexer] ownership collision: ${collectionName}/${relativePath} is ` +
            `'${existingRow.origin}'-owned; ${rowOrigin === "api" ? "import" : "filesystem"} write skipped`,
          );
          continue;
        }

        // §55.6 D7: `--force` re-parses and rewrites every file by bypassing this
        // content-hash short-circuit. It replaces a blanket `UPDATE documents SET active = 0`
        // that deactivated EVERY row in the vault — including `_clawmem` rows, which have no
        // filesystem source and so were never reconstructed, with no `archived_at` and
        // therefore no supported restore.
        if (existingRow?.content_hash === contentHash && !options?.force) {
          stats.unchanged++;
          // Origin adoption on the unchanged path: legacy NULL rows heal to their owner HERE
          // — there is no open-time backfill (content_hash proves nothing about ownership;
          // mined imports write it too), and this short-circuit is the only write path an
          // unchanged file ever takes.
          if (existingRow.origin === null) {
            store.db.prepare("UPDATE documents SET origin = ? WHERE id = ?").run(rowOrigin, existing.id);
          }
          // §51.1 D5: unchanged-row adoption — a NULL row whose frontmatter
          // already declares authored_at adopts it metadata-only (no modified_at
          // bump, no A-MEM). The frontmatter-block substring pre-check gates the
          // full parse so undated vaults pay near-zero.
          if (existingRow.authored_at === null && content.startsWith("---")) {
            const fmEnd = content.indexOf("\n---", 3);
            if (fmEnd !== -1 && content.slice(0, fmEnd).includes("authored_at")) {
              const { meta: adoptMeta } = parseDocument(content, relativePath);
              if (typeof adoptMeta.authored_at === "string") {
                store.updateDocumentMeta(existing.id, { authored_at: adoptMeta.authored_at });
                stats.dated++;
              }
            }
          }
          if (options?.forceEnrich) {
            // --enrich: queue unchanged docs for full enrichment (entity extraction, links)
            enrichQueue.push({ docId: existing.id, isNew: true });
          }
          continue;
        }

        // Content changed — parse, then check for the §51.1 dated-only
        // transition first: body and every persisted metadata field unchanged
        // with only authored_at differing → update authored_at + content_hash
        // only. modified_at is preserved, stored confidence stays untouched,
        // and no A-MEM enrichment is queued — re-mining an existing vault dates
        // documents without operational side-effects.
        const { body, meta } = parseDocument(content, relativePath);
        const title = (typeof meta.title === "string" && meta.title) ? meta.title : extractTitle(body, relativePath);
        const docHash = hashContent(body);
        const contentType = meta.content_type || inferContentType(relativePath);

        const prev = store.db.prepare(
          "SELECT hash, title, domain, workstream, tags, content_type, review_by, authored_at FROM documents WHERE id = ?"
        ).get(existing.id) as { hash: string; title: string; domain: string | null; workstream: string | null; tags: string | null; content_type: string; review_by: string | null; authored_at: string | null } | null;

        // "Unchanged" per field mirrors what the normal path would write: fields
        // the normal path leaves untouched (undefined) count as unchanged.
        const datedOnly = prev !== null
          && meta.authored_at !== undefined
          && (meta.authored_at ?? null) !== prev.authored_at
          && docHash === prev.hash
          && title === prev.title
          && (meta.domain === undefined || meta.domain === (prev.domain ?? undefined))
          && (meta.workstream === undefined || meta.workstream === (prev.workstream ?? undefined))
          && (meta.tags === undefined || JSON.stringify(meta.tags) === prev.tags)
          && contentType === prev.content_type
          && (meta.review_by === undefined || meta.review_by === (prev.review_by ?? undefined));

        if (datedOnly) {
          store.updateDocumentMeta(existing.id, { authored_at: meta.authored_at });
          store.db.prepare("UPDATE documents SET content_hash = ?, origin = ? WHERE id = ?").run(contentHash, rowOrigin, existing.id);
          stats.dated++;
          continue;
        }

        store.insertContent(docHash, body, now);
        store.updateDocument(existing.id, title, docHash, mtime.toISOString());

        // Update SAME metadata
        store.updateDocumentMeta(existing.id, {
          domain: meta.domain,
          workstream: meta.workstream,
          tags: meta.tags ? JSON.stringify(meta.tags) : undefined,
          content_type: contentType,
          review_by: meta.review_by,
          confidence: confidenceScore(contentType, mtime, 0),
          quality_score: computeQualityScore(body, meta),
          // §51.1: authoritative on the changed path — string sets, null clears,
          // undefined (frontmatter parse failure) leaves the stored value.
          authored_at: meta.authored_at,
        });

        // Update content_hash for next incremental check
        store.db.prepare("UPDATE documents SET content_hash = ?, origin = ? WHERE id = ?").run(contentHash, rowOrigin, existing.id);

        // Defer A-MEM enrichment until after commit
        enrichQueue.push({ docId: existing.id, isNew: false });

        stats.updated++;
      } else {
        // Check for an inactive doc at the same path — reactivate instead of inserting.
        // §55.6 D9: ONLY a row this reconciler deactivated for absence may come back. A row
        // deactivated by `memory_forget` or by lifecycle archival is a memory decision, and
        // reactivating it silently undid that decision — measured: a forget on a file-backed
        // document survived only until the next `.md` change in its collection.
        // NULL = legacy pre-migration row, treated as 'absent' so it is not stranded.
        const inactiveRow = store.db.prepare(
          "SELECT id, hash, deactivated_reason, origin FROM documents WHERE collection = ? AND path = ? AND active = 0"
        ).get(collectionName, relativePath) as { id: number; hash: string; deactivated_reason: string | null; origin: string | null } | null;

        // Forgotten / archived: leave it alone. Skipping the file — rather than falling through
        // to the insert branch — is load-bearing: inserting would create a SECOND row at the
        // same (collection, path) and resurrect the content under a new id, which is the same
        // bug wearing a different shape.
        if (inactiveRow && inactiveRow.deactivated_reason !== null && inactiveRow.deactivated_reason !== "absent") {
          continue;
        }

        // Ownership-collision boundary (same rule as the active branch): an inactive row
        // explicitly owned by the opposite origin is neither reactivated nor shadowed by a
        // second insert at its path. Skip the file; resolving the collision is a deliberate
        // operator action, never an indexing side effect.
        if (inactiveRow && inactiveRow.origin != null && inactiveRow.origin !== rowOrigin) {
          console.warn(
            `[indexer] ownership collision: ${collectionName}/${relativePath} (inactive) is ` +
            `'${inactiveRow.origin}'-owned; ${rowOrigin === "api" ? "import" : "filesystem"} write skipped`,
          );
          continue;
        }
        const inactive = inactiveRow;

        const { body, meta } = parseDocument(content, relativePath);
        const title = (typeof meta.title === "string" && meta.title) ? meta.title : extractTitle(body, relativePath);
        const docHash = hashContent(body);
        const contentType = meta.content_type || inferContentType(relativePath);

        store.insertContent(docHash, body, now);

        if (inactive) {
          // Reactivate existing row. §55.6 D9: clear the provenance on the way back.
          store.db.prepare("UPDATE documents SET active = 1, hash = ?, title = ?, modified_at = ?, content_hash = ?, origin = ?, deactivated_reason = NULL WHERE id = ?")
            .run(docHash, title, mtime.toISOString(), contentHash, rowOrigin, inactive.id);
          store.updateDocumentMeta(inactive.id, {
            domain: meta.domain,
            workstream: meta.workstream,
            tags: meta.tags ? JSON.stringify(meta.tags) : undefined,
            content_type: contentType,
            review_by: meta.review_by,
            confidence: confidenceScore(contentType, mtime, 0),
            quality_score: computeQualityScore(body, meta),
            authored_at: meta.authored_at,
          });
          enrichQueue.push({ docId: inactive.id, isNew: false });
        } else {
          // Truly new document
          store.insertDocument(collectionName, relativePath, title, docHash, now, mtime.toISOString(), rowOrigin);
          const newDoc = store.findActiveDocument(collectionName, relativePath);
          if (newDoc) {
            store.updateDocumentMeta(newDoc.id, {
              domain: meta.domain,
              workstream: meta.workstream,
              tags: meta.tags ? JSON.stringify(meta.tags) : undefined,
              content_type: contentType,
              review_by: meta.review_by,
              confidence: confidenceScore(contentType, mtime, 0),
              quality_score: computeQualityScore(body, meta),
              authored_at: meta.authored_at,
            });
            store.db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?").run(contentHash, newDoc.id);
            enrichQueue.push({ docId: newDoc.id, isNew: true });
          }
        }

        stats.added++;
      }
    }

    // Deactivate documents that no longer exist on disk. Origin-aware: only rows the
    // filesystem indexer owns (origin = 'fs') are enumerated — DB-born rows (hooks,
    // saveMemory, beads, REST; origin = 'api') have no backing file BY DESIGN, and
    // reconciling them against disk deactivated them on every pass. NULL-origin legacy
    // rows are exempt too (fail-safe; they are adopted by the next writer to touch them —
    // there is no backfill, and content_hash proves nothing about ownership since mined
    // imports write it too). Skipped entirely in importMode: the
    // staging root is transient, so absence from it means nothing.
    if (!options?.importMode) {
      const storedPaths = store.getReconcilableDocumentPaths(collectionName);
      for (const storedPath of storedPaths) {
        if (!activePaths.has(storedPath)) {
          // §55.6 D9: record WHY. Only 'absent' is reversible by a later reconciliation.
          store.deactivateDocument(collectionName, storedPath, "absent");
          stats.removed++;
        }
      }
    }

    store.db.exec("COMMIT");
  } catch (err) {
    store.db.exec("ROLLBACK");
    throw err;
  }

  // A-MEM enrichment runs after successful commit (LLM calls should not block transaction)
  // forceEnrich overrides isNew to true — triggers full pipeline (entity extraction, links, evolution)
  for (const { docId, isNew } of enrichQueue) {
    const outcome = await store.postIndexEnrich(llm, docId, options?.forceEnrich ? true : isNew);
    if (outcome !== "disabled") stats.enrichAttempted++;
    if (outcome === "stored") stats.enrichStored++;
  }

  return stats;
}
