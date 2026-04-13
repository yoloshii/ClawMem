/**
 * §11.1 — `<vault-facts>` KG injection for context-surfacing (v0.9.0)
 *
 * Prompt-only entity detection + exact-match validation + triple query +
 * token-budgeted XML serialization. Wires the SPO knowledge graph
 * (populated by v0.8.5 decision-extractor + A-MEM enrichment) into the
 * retrieval hot path without ever reading from ranked documents.
 *
 * Hard constraint from the approved design (§11.1, prompt-only seeding):
 * entity seeds come from `input.prompt` text ONLY, never from ranked
 * document bodies or snippets. Without this, a topic-boosted off-topic
 * doc (§11.4) could pollute the `<vault-facts>` block with facts about
 * entities that have nothing to do with the user's actual prompt.
 *
 * Three-path candidate generation (BACKLOG §11.1 "Concrete implementation"):
 *   (a) canonical-ID regex `/^[a-z][a-z0-9-]*:[a-z_]+:[a-z0-9_]+$/`
 *   (b) proper-noun extraction (capitalized tokens + all-caps acronyms)
 *   (c) normalized n-gram scan against entity_nodes.name (1-3 grams,
 *       keep internal hyphens whole, batch SQL lookup via
 *       `WHERE LOWER(name) IN (?, ?, ...) AND vault = ?` backed by
 *       the `idx_entity_nodes_lower_name` expression index added in
 *       the v0.9.0 schema migration)
 *
 * Per-path validate-then-count ordering (Codex §11.1 Turn 5):
 *   - Path (a): validate via direct PK lookup, count immediately.
 *   - Path (b): validate via `resolveEntityTypeExact` BEFORE counting —
 *     only non-null results consume budget. Raw capitalized tokens that
 *     fail validation are dropped silently without starving path (c).
 *   - Path (c): validated hits fill remaining slots up to the 100-cap.
 *     Within path (c): 3-grams > 2-grams > 1-grams; prompt order is
 *     the final tie-breaker within each length class.
 *
 * Cross-path dedup: path (b) / (c) hits that resolve to the same
 * entity_id as an earlier path (a) hit are no-ops — they do not
 * consume a second cap slot.
 *
 * Fail-open discipline (BACKLOG §11.1 "CRITICAL fail-open requirement"):
 *   - Empty prompt / zero candidates → return [] (caller skips stage).
 *   - SQLite error during any lookup → caught per-candidate, silent skip.
 *   - Empty triples for every validated entity → return null from
 *     buildVaultFactsBlock (caller omits the block entirely).
 *   - Token budget too small to fit even one triple → return null.
 *   - Exact-match ambiguity (two entities with the same name) → skip
 *     that entity via `resolveEntityTypeExact` returning null.
 */

import type { Database } from "bun:sqlite";
import { resolveEntityTypeExact, ensureEntityCanonical } from "./entity.ts";

// =============================================================================
// Constants
// =============================================================================

/** Hard upper bound on the number of VALIDATED entity candidates per prompt. */
const CANDIDATE_CAP = 100;

/** Maximum n-gram length (inclusive). 3-grams provide the best recall
 *  vs. signal trade-off per the Codex Turn 3 analysis; 4-grams dilute. */
const MAX_NGRAM_LEN = 3;

/**
 * Canonical entity ID shape: `vault:type:slug`. The slug segment can
 * include hyphens (e.g. `skill:tool:forge-stack`). Use a non-hyphen
 * boundary on both ends so a trailing `.` or `,` doesn't swallow the
 * last character but interior hyphens survive intact.
 */
const CANONICAL_ID_REGEX = /(?<![a-zA-Z0-9_-])[a-z][a-z0-9-]*:[a-z_]+:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?![a-zA-Z0-9_-])/g;

/**
 * Proper-noun shape: capitalized first letter + optional mixed case, OR
 * all-caps acronyms (2+ chars). Matches `ClawMem`, `OAuth`, `API`, `Bun`,
 * `PostgreSQL`, `JWT`, etc. Intentionally does NOT match lowercase
 * technical identifiers like `clawmem`, `forge-stack`, `oauth2` — those
 * are the job of path (c) n-gram scanning.
 */
const PROPER_NOUN_REGEX = /\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*|[A-Z]{2,}[a-z0-9]*)\b/g;

// =============================================================================
// Types
// =============================================================================

export interface ValidatedEntity {
  /** Canonical `vault:type:slug` entity id for querying triples. */
  entityId: string;
  /** Lowercase name used internally for dedup / audit. */
  name: string;
  /** Entity type as stored in `entity_nodes.entity_type`. */
  type: string;
  /** Which extraction path surfaced this candidate (for debugging). */
  sourcePath: "canonical-id" | "proper-noun" | "ngram";
}

export interface NgramCandidate {
  /** Lowercase / whitespace-normalized n-gram text. */
  normalized: string;
  /** N-gram length: 1, 2, or 3. Used for the longer-first tie-breaker. */
  length: 1 | 2 | 3;
  /** First-token index in the prompt, for stable prompt-order tie-break. */
  promptOrder: number;
}

/** Lightweight shape of a knowledge-graph triple the caller needs for serialization. */
export interface VaultFactsTriple {
  subject: string;
  predicate: string;
  object: string;
  validTo: string | null;
  confidence: number;
}

/** Function shape used to query triples for a single entity id.
 *  Decoupled from `Store` so unit tests can inject a mock. */
export type TripleQueryFn = (entityId: string) => VaultFactsTriple[];

// =============================================================================
// Path (a) — canonical-ID regex
// =============================================================================

/**
 * Extract all canonical-ID matches from a prompt. Deduplicated preserving
 * first-occurrence order. Purely syntactic — does NOT consult the DB.
 */
export function extractCanonicalIds(prompt: string): string[] {
  if (!prompt) return [];
  const matches = prompt.match(CANONICAL_ID_REGEX) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

// =============================================================================
// Path (b) — proper-noun extraction
// =============================================================================

/**
 * Extract all proper-noun-shaped tokens from a prompt. Deduplicated
 * preserving first-occurrence order. Purely syntactic — does NOT consult
 * the DB. Validation happens via `resolveEntityTypeExact` at the
 * per-path budget-accounting step, NOT here.
 */
export function extractProperNouns(prompt: string): string[] {
  if (!prompt) return [];
  const matches = prompt.match(PROPER_NOUN_REGEX) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

// =============================================================================
// Path (c) — normalized n-gram scan
// =============================================================================

/**
 * Tokenize a prompt for n-gram generation. Splits on whitespace and
 * common punctuation while keeping internal hyphens whole — so
 * `forge-stack` stays one token, not two. Strips edge punctuation
 * (quotes, backticks, brackets) from each token boundary.
 */
function tokenizeForNgrams(prompt: string): string[] {
  if (!prompt) return [];
  return prompt
    .split(/[\s,;:!?"'`()\[\]{}<>]+/)
    .map(t => t.replace(/^[^a-zA-Z0-9\-]+|[^a-zA-Z0-9\-]+$/g, ""))
    .filter(t => t.length > 0);
}

/**
 * Generate 1-gram, 2-gram, and 3-gram windows from a prompt. Windows are
 * deduplicated on their normalized form (lowercase, trimmed, internal
 * whitespace collapsed). Result preserves generation order: all 1-grams
 * first (in prompt order), then 2-grams, then 3-grams. The caller re-sorts
 * by length+promptOrder at validation time for the Turn 5 tie-breaker.
 */
export function generateNgramCandidates(prompt: string): NgramCandidate[] {
  const tokens = tokenizeForNgrams(prompt);
  const seen = new Set<string>();
  const out: NgramCandidate[] = [];

  for (let n = 1; n <= MAX_NGRAM_LEN; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const slice = tokens.slice(i, i + n).join(" ");
      const normalized = slice.toLowerCase().trim().replace(/\s+/g, " ");
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push({ normalized, length: n as 1 | 2 | 3, promptOrder: i });
    }
  }
  return out;
}

/**
 * Batch-lookup a set of normalized candidate names against entity_nodes.
 * Uses a single parameterized SQL query backed by the
 * `idx_entity_nodes_lower_name` expression index (added in the v0.9.0
 * schema migration). Duplicate names are deduped in SQL (`DISTINCT`).
 * Returns a map from `LOWER(name)` → `{ entityId, entityType }`.
 *
 * Fail-open: any SQL error returns an empty map. The caller proceeds
 * as if the batch returned zero hits, and path (c) contributes nothing
 * for that prompt.
 */
export function batchLookupNames(
  db: Database,
  candidates: string[],
  vault: string = "default"
): Map<string, { entityId: string; entityType: string }> {
  const out = new Map<string, { entityId: string; entityType: string }>();
  if (candidates.length === 0) return out;

  // Dedupe and bound the candidate set for the SQL `IN` clause.
  // The per-path budget accounting above us already bounds path (c) to
  // `CANDIDATE_CAP - len(path a + path b)` entries, but we cap the
  // raw n-gram set independently here for safety: a worst-case prompt
  // could generate many distinct normalized n-grams even if only a
  // few would survive the candidate accounting, and a single giant
  // SQL IN clause is wasted work. The 500 cap is intentionally larger
  // than `CANDIDATE_CAP` so the batch query still gets the headroom
  // to return overflow n-grams that the prioritization step then
  // drops at budget time.
  const unique = Array.from(new Set(candidates)).slice(0, 500);
  const placeholders = unique.map(() => "?").join(", ");
  const sql = `
    SELECT DISTINCT LOWER(name) AS lname, entity_id, entity_type
    FROM entity_nodes
    WHERE LOWER(name) IN (${placeholders})
      AND vault = ?
  `;

  try {
    const rows = db.prepare(sql).all(...unique, vault) as Array<{
      lname: string;
      entity_id: string;
      entity_type: string;
    }>;
    for (const row of rows) {
      out.set(row.lname, { entityId: row.entity_id, entityType: row.entity_type });
    }
  } catch {
    /* fail-open: empty map */
  }
  return out;
}

// =============================================================================
// Main entity extraction — three-path, validate-then-count, 100-cap
// =============================================================================

/**
 * Three-path prompt entity extraction with per-path validate-then-count
 * ordering, cross-path dedup by resolved entity_id, and the Codex-approved
 * 100-candidate cap.
 *
 * Reads `input.prompt` text ONLY — NEVER touches ranked documents,
 * surfaced snippets, or any retrieval-phase field. This is the §11.1
 * prompt-only hard constraint.
 *
 * Returns a list of validated entities ready for triple-query seeding.
 * Empty array on empty prompt, zero matches, or any fail-open branch.
 */
export function extractPromptEntities(
  prompt: string,
  db: Database,
  vault: string = "default"
): ValidatedEntity[] {
  if (!prompt) return [];

  const validated: ValidatedEntity[] = [];
  const seenEntityIds = new Set<string>();

  // --------------------------------------------------------------------
  // Path (a): Canonical-ID regex → direct primary-key lookup
  // --------------------------------------------------------------------
  const canonicalIds = extractCanonicalIds(prompt);
  for (const id of canonicalIds) {
    if (validated.length >= CANDIDATE_CAP) break;
    if (seenEntityIds.has(id)) continue;
    try {
      const exists = db
        .prepare(`SELECT entity_id, entity_type FROM entity_nodes WHERE entity_id = ? AND vault = ?`)
        .get(id, vault) as { entity_id: string; entity_type: string } | undefined;
      if (!exists) continue;
      seenEntityIds.add(id);
      validated.push({
        entityId: id,
        name: id,
        type: exists.entity_type,
        sourcePath: "canonical-id",
      });
    } catch {
      /* fail-open per candidate */
    }
  }

  // --------------------------------------------------------------------
  // Path (b): Proper-noun extraction → validate-then-count via
  // resolveEntityTypeExact. Non-null return means exactly-one match.
  // After confirming type, use ensureEntityCanonical to get the
  // canonical `vault:type:slug` entity_id. Note: ensureEntityCanonical
  // is effectively read-only in production because every entity_nodes
  // row has a matching entities_fts row inserted at upsert time — the
  // fallback INSERT OR IGNORE fires only when the FTS index got out
  // of sync (rare / migration edge case), in which case it self-heals.
  // --------------------------------------------------------------------
  const properNouns = extractProperNouns(prompt);
  for (const name of properNouns) {
    if (validated.length >= CANDIDATE_CAP) break;
    try {
      const type = resolveEntityTypeExact(db, name, vault);
      if (!type) continue; // null = zero or multi-match → skip silently
      const entityId = ensureEntityCanonical(db, name, type, vault);
      if (!entityId) continue;
      if (seenEntityIds.has(entityId)) continue; // cross-path dedup
      seenEntityIds.add(entityId);
      validated.push({
        entityId,
        name: name.toLowerCase(),
        type,
        sourcePath: "proper-noun",
      });
    } catch {
      /* fail-open per candidate */
    }
  }

  // --------------------------------------------------------------------
  // Path (c): Normalized n-gram scan → batch SQL → per-candidate validate
  // → longer-first tie-breaker → fill remaining budget.
  // --------------------------------------------------------------------
  if (validated.length < CANDIDATE_CAP) {
    const ngrams = generateNgramCandidates(prompt);
    const normalizedSet = ngrams.map(g => g.normalized);

    const hits = batchLookupNames(db, normalizedSet, vault);
    if (hits.size > 0) {
      // First pass: collect every ngram that the SQL batch confirms
      // exists in entity_nodes, THEN run the exact-match validator to
      // enforce the exactly-one-entity constraint. Attach length +
      // promptOrder so the sort step can apply the Turn 5 tie-breaker.
      interface ValidatedNgram extends ValidatedEntity {
        length: 1 | 2 | 3;
        promptOrder: number;
      }
      const validatedNgrams: ValidatedNgram[] = [];
      const ngramSeen = new Set<string>();

      for (const gram of ngrams) {
        const hit = hits.get(gram.normalized);
        if (!hit) continue;
        if (ngramSeen.has(hit.entityId)) continue; // dedup within path (c)
        if (seenEntityIds.has(hit.entityId)) continue; // dedup across paths

        try {
          const confirmedType = resolveEntityTypeExact(db, gram.normalized, vault);
          if (!confirmedType) continue; // multi-match or zero-match → skip
          ngramSeen.add(hit.entityId);
          validatedNgrams.push({
            entityId: hit.entityId,
            name: gram.normalized,
            type: confirmedType,
            sourcePath: "ngram",
            length: gram.length,
            promptOrder: gram.promptOrder,
          });
        } catch {
          /* fail-open per candidate */
        }
      }

      // Turn 5 tie-breaker: longer n-grams first (3 → 2 → 1), then
      // prompt order within each length class. Longer n-grams are more
      // semantically specific and should win the remaining budget.
      validatedNgrams.sort((a, b) => {
        if (a.length !== b.length) return b.length - a.length;
        return a.promptOrder - b.promptOrder;
      });

      // Fill remaining budget.
      for (const g of validatedNgrams) {
        if (validated.length >= CANDIDATE_CAP) break;
        if (seenEntityIds.has(g.entityId)) continue; // paranoid re-check
        seenEntityIds.add(g.entityId);
        validated.push({
          entityId: g.entityId,
          name: g.name,
          type: g.type,
          sourcePath: "ngram",
        });
      }
    }
  }

  return validated;
}

// =============================================================================
// Vault-facts block builder
// =============================================================================

export interface BuildVaultFactsOptions {
  /** Cap on triples emitted per entity. Default 10. */
  maxTriplesPerEntity?: number;
  /** Token estimator. Defaults to ~4 chars per token heuristic. */
  estimateTokens?: (s: string) => number;
  /** ISO "now" used to filter `validTo > now`. Defaults to `new Date().toISOString()`. */
  now?: string;
}

const DEFAULT_ESTIMATE_TOKENS = (s: string): number => Math.ceil(s.length / 4);

/**
 * Build the `<vault-facts>` XML block for a set of validated entities
 * and a budget in tokens. Returns null if:
 *   - No entities (caller: skip the stage entirely).
 *   - Zero current triples after filtering (caller: do NOT emit an
 *     empty `<vault-facts/>` element).
 *   - Budget too small to fit even one triple (caller: drop block,
 *     preserve established blocks' budget).
 *   - Query callback throws for every entity (fail-open).
 *
 * Truncation rule (BACKLOG §11.1 budget guidance): if the serialized
 * block would exceed the budget, truncate at the triple boundary.
 * Never mid-triple, never emit an empty block.
 *
 * This function does NOT query the DB directly — the caller passes a
 * `TripleQueryFn` functor so tests can inject a mock query.
 */
export function buildVaultFactsBlock(
  entities: ValidatedEntity[],
  queryTriples: TripleQueryFn,
  budgetTokens: number,
  options: BuildVaultFactsOptions = {}
): string | null {
  if (entities.length === 0) return null;
  if (budgetTokens <= 0) return null;

  const maxPerEntity = options.maxTriplesPerEntity ?? 10;
  const estimate = options.estimateTokens ?? DEFAULT_ESTIMATE_TOKENS;
  const now = options.now ?? new Date().toISOString();

  // Collect all current triples from all entities, deduping across
  // entities by (subject, predicate, object). Without this, prompts that
  // resolve both endpoints of a triple (e.g. "ClawMem depends_on Bun"
  // when both `ClawMem` and `Bun` are validated entities) would emit
  // the same fact twice and spend budget twice — once from the
  // outgoing side of ClawMem's query, once from the incoming side of
  // Bun's query. Caught by Codex §11.1 code review Turn 1, 2026-04-13.
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const entity of entities) {
    let triples: VaultFactsTriple[] = [];
    try {
      triples = queryTriples(entity.entityId);
    } catch {
      continue; // fail-open per entity
    }

    // Current-only filter: validTo IS NULL OR validTo > now.
    // Cap at maxPerEntity per entity so one chatty entity does not
    // monopolize the shared budget below.
    const current = triples
      .filter(t => !t.validTo || t.validTo > now)
      .slice(0, maxPerEntity);

    for (const t of current) {
      const key = `${t.subject}\u0000${t.predicate}\u0000${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${t.subject} ${t.predicate} ${t.object}`);
    }
  }

  if (lines.length === 0) return null;

  // Token-bounded serialization. Start with the structural XML overhead
  // (open + close tag + two newlines) and greedily add triple lines
  // until the next line would overflow the budget. Drop entire block
  // if even one line does not fit — never emit an empty block.
  const OPEN = "<vault-facts>\n";
  const CLOSE = "\n</vault-facts>";
  const OVERHEAD = estimate(OPEN + CLOSE);
  if (OVERHEAD >= budgetTokens) return null;

  const outLines: string[] = [];
  let runningTokens = OVERHEAD;
  for (const line of lines) {
    const lineTokens = estimate(line) + 1; // +1 for the trailing newline
    if (runningTokens + lineTokens > budgetTokens) break;
    outLines.push(line);
    runningTokens += lineTokens;
  }

  if (outLines.length === 0) return null;

  return `${OPEN}${outLines.join("\n")}${CLOSE}`;
}
