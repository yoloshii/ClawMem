# ClawMem architecture

ClawMem stores AI agent memory in a single SQLite vault that combines BM25 full-text search with vector embeddings and graph-based retrieval. This page explains how vaults, collections, documents, and search backends fit together.

## Vaults

A vault is a single SQLite database file containing all of ClawMem's data: documents, content, vectors, relations, sessions, and usage tracking. The default vault lives at `~/.cache/clawmem/index.sqlite`.

SQLite is used in WAL (Write-Ahead Logging) mode with `busy_timeout=5000ms`, allowing concurrent reads from multiple processes (e.g., Claude Code and OpenClaw sharing the same vault).

## Collections

Collections are named groups of documents sourced from a directory. Each collection has:

- **Name** — identifier (e.g., `notes`, `research`, `memory`)
- **Path** — absolute directory path to scan
- **Pattern** — glob pattern for files to index (default: `**/*.md`)

Collections are defined in `~/.config/clawmem/config.yaml` (symlinked as `index.yml` in the vault directory).

```yaml
collections:
  notes:
    path: ~/notes
    pattern: "**/*.md"
  research:
    path: ~/research
    pattern: "**/*.md"
```

Only markdown files are indexed. Binary files, code, and credentials are never indexed.

### What to index

The retrieval pipeline surfaces better results from a richer corpus. Beyond the default memory and session log patterns, consider adding collections for research notes, architecture decisions, domain references, project specs, and any markdown you regularly consult during agent sessions. The broader the indexed field, the more likely context-surfacing will find something relevant to the current task.

Code files (`.ts`, `.py`, `.go`, etc.) are intentionally excluded. BM25 and embedding models trained on natural language don't perform well on code syntax — variable names, imports, and bracket-heavy constructs pollute the search index. Code retrieval is better served by tools built for that purpose (tree-sitter, LSP, semantic code search). Capture your technical decisions and architecture rationale in markdown instead; that's what agents need when making decisions during a coding session.

### Excluded directories

These directories are always skipped during indexing:

`_PRIVATE`, `.clawmem`, `.git`, `.obsidian`, `.logseq`, `.foam`, `.dendron`, `.trash`, `.stversions`, `node_modules`, `.cache`, `vendor`, `dist`, `build`, `gits`, `scraped`

## Documents

Each indexed file becomes a document with:

| Field | Description |
|-------|-------------|
| `collection` | Which collection it belongs to |
| `path` | Relative path within the collection |
| `title` | Extracted from first heading or filename |
| `hash` | SHA-256 of content (canonical identity) |
| `docid` | First 6 hex chars of hash (for human reference) |
| `content_type` | Auto-detected: decision, deductive, preference, note, handoff, conversation, progress, research, hub, antipattern, project, milestone, problem |
| `quality_score` | 0.0-1.0 based on length, structure, headings, lists, decision keywords, frontmatter |
| `confidence` | Starts at 0.5, adjusted by contradiction detection and feedback |
| `pinned` | Manual boost flag (+0.3 composite score) |
| `snoozed_until` | Temporarily hidden from context surfacing |

## Fragments

Each document is split into fragments for embedding:

- **full** — entire document (if under size limit)
- **section** — content under each heading
- **list** — list items grouped together
- **code** — code blocks

Fragments are embedded independently. The full-document fragment catches broad queries; section/list/code fragments provide precision.

## Search backends

| Backend | Signal | GPU cost | Use case |
|---------|--------|----------|----------|
| BM25 (FTS5) | Keyword exact match | 0 | Known terms, spot checks |
| Vector (vec0) | Semantic similarity | 1 call | Conceptual queries, fuzzy recall |
| Hybrid (RRF) | BM25 + Vector fused | 1+ calls | General recall (default) |

BM25 uses SQLite's FTS5 extension with prefix matching. Vector search uses the `vec0` extension with cosine similarity. Embedding dimensions depend on the model: 768 for the default EmbeddingGemma-300M, 2560 for the SOTA zembed-1, or provider-determined for cloud embedding.

## Graphs

ClawMem maintains a `memory_relations` table of typed edges between documents: semantic, supporting, contradicts, causal, and temporal. These edges let `intent_search` answer "why" and "what led to" questions by following chains across documents rather than relying on keyword or vector similarity alone.

A separate `entity_triples` table stores structured SPO (Subject-Predicate-Object) facts with temporal validity (`valid_from`/`valid_to`). Triples are extracted automatically from observation facts by `decision-extractor` — only from decision, preference, milestone, and problem observations to avoid noise. Query via `kg_query(entity)` for structured entity relationships.

Most edges are created automatically. When new documents are indexed, A-MEM finds vector neighbors and uses the LLM to classify relationships (semantic, supporting, contradicts). When `decision-extractor` runs after each response, it infers causal links between observations and extracts SPO triples from facts. The `build_graphs` MCP tool adds temporal backbone edges (creation-order) and bulk semantic edges — run it after large ingestion batches, not after routine indexing.

See [graph traversal](../internals/graph-traversal.md) for edge types, traversal mechanics, and beam search details.

## Consolidation safety (v0.7.1)

The background consolidation worker has three independent safety gates that prevent observation contamination, accidental cross-entity merges, and unchecked contradictions from landing in the vault.

### Phase 2 — name-aware merge safety

When the worker finds a candidate existing observation to merge a new pattern into, it runs a deterministic name-aware gate before updating. The gate extracts entity anchors from both the new and existing texts — first via `entity_mentions` (if the source docs are enriched), falling back to lexical proper-noun extraction — and compares them with normalized character 3-gram cosine similarity. When anchor sets differ materially (Jaccard ≤ 0.5), the merge is hard-rejected regardless of text similarity. Otherwise, a dual-threshold score applies: `CLAWMEM_MERGE_SCORE_NORMAL` (default `0.93`) for aligned anchors, `CLAWMEM_MERGE_SCORE_STRICT` (default `0.98`) as the strictest fallback. This prevents "Alice decided X" from merging into "Bob decided X" just because the predicate is identical. Set `CLAWMEM_MERGE_GUARD_DRY_RUN=true` to log rejections without enforcing them.

### Phase 2 — contradiction-aware merge gate

After the name-aware gate passes, the worker checks whether the new observation contradicts the existing one. A deterministic heuristic runs first (negation asymmetry, number/date mismatch), then an LLM check confirms. If the final confidence exceeds `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE` (default `0.5`), the merge is blocked and one of two policies applies (controlled by `CLAWMEM_CONTRADICTION_POLICY`):

- `link` (default) — insert a new `consolidated_observations` row and create a `contradicts` edge in `memory_relations` between the two rows. Both remain active and queryable.
- `supersede` — insert the new row and mark the old row `status='inactive'` with `invalidated_at`/`superseded_by` set. The old row is filtered from retrieval but preserved for audit.

Phase 3 deductive synthesis applies the same `contradicts` link for any draft that matches a prior deductive observation with conflicting content.

### Phase 3 — anti-contamination deductive synthesis

Phase 3 synthesizes cross-session insights from recent observations into `content_type='deductive'` documents. The draft-generation LLM can produce drafts whose conclusion references entities that only appear in the candidate pool but not in the cited sources — a form of context bleed. Each draft runs through a three-layer validator:

1. **Deterministic pre-checks** — reject empty conclusions; reject drafts whose `source_indices` don't resolve to at least two unique source docs; reject drafts whose conclusion names an entity (entity-aware via `entity_mentions`, lexical fallback via proper-noun extraction) that exists in the candidate pool but not in any cited source.
2. **LLM validator** — a separate LLM call checks that the conclusion is genuinely supported by the cited source snippets. Fail-open: if the validator times out or returns malformed JSON, the draft is accepted and flagged via the `validatorFallbackAccepts` stat so operators can detect when the LLM path is effectively offline.
3. **Dedupe** — accepted drafts are compared against recent deductive observations to prevent duplicates.

Rejection reasons are tracked individually in `DeductiveSynthesisStats` (`contaminationRejects`, `invalidIndexRejects`, `unsupportedRejects`, `emptyRejects`, `dedupSkipped`, `validatorFallbackAccepts`) so Phase 3 yield can be diagnosed without enabling extra logging.

## Post-import conversation synthesis (v0.7.2)

`clawmem mine` imports raw chat exports (Claude Code, ChatGPT, Claude.ai, Slack, plain text) as `content_type='conversation'` full-text documents. Conversations preserve the narrative but rarely cluster well in retrieval — the same decision can appear across many turns and many conversations, and BM25 or vector search surfaces the prose rather than the structured claim underneath. The `--synthesize` opt-in flag adds a post-import LLM pass that walks the freshly indexed conversations and extracts first-class structured facts (decisions, preferences, milestones, problems) with cross-fact relations, writing them as searchable documents alongside the raw exchanges.

The synthesis module is `src/conversation-synthesis.ts`. It runs **after** `indexCollection` has committed the raw conversation docs, and a failure inside the synthesis pipeline never rolls back the mine import — the raw conversations remain indexed.

### Two-pass pipeline

**Pass 1 — fact extraction.** For each conversation doc in the target collection (capped by `--synthesis-max-docs`, default 20), the pipeline:

1. Sends the conversation body (truncated to 3000 chars) to the LLM with a strict extraction prompt. The prompt lists the four allowed `contentType` values (`decision`, `preference`, `milestone`, `problem`) and the six allowed `relationType` values (`semantic`, `supporting`, `contradicts`, `causal`, `temporal`, `entity`), and explicitly authorizes links that reference facts from **other** conversations in the same imported batch.
2. Parses the response via `extractJsonFromLLM` (the same helper the A-MEM pipeline uses, robust to truncated arrays and markdown fences).
3. Normalizes each fact: rejects empty titles, disallowed contentTypes, non-string facts/aliases entries, links with bad relation types, and clamps weights to `[0, 1]`.
4. Writes each valid fact via dedup-aware `saveMemory` with a stable synthesized path:
   ```
   synthesized/<slug(title)>-src<sourceDocId>-<short sha256(normalized title)>.md
   ```
   The path is a pure function of `(sourceDocId, slug, hash(normalizedTitle))`. No encounter-order dependence. Same-slug collisions (`Use OAuth.` and `Use OAuth!` both slugify to `use-oauth`) are disambiguated by the stable hash suffix — reruns in different LLM order still pin each title to the same path, so `saveMemory`'s `UNIQUE(collection, path)` update branch is hit instead of creating parallel rows.
5. Populates a local alias map: `Map<normalizedTitleOrAlias, Set<docId>>`. Each fact contributes its canonical title and every alias into the Set. If two different facts claim the same title or alias the Set accumulates multiple docIds and later becomes ambiguous.

`extractFactsFromConversation` returns `ExtractedFact[] | null`. A `null` return discriminates "LLM path failed" (null response, thrown generate, non-array JSON) from a valid empty extraction `[]`. The orchestrator uses this to increment either `llmFailures` or `docsWithNoFacts` — two distinct operator counters that were previously conflated as `nullCalls`.

**Pass 2 — link resolution.** Runs after Pass 1 finishes for every doc in the batch (skipped entirely in `--dry-run` mode). For each saved fact's `links[]`:

1. `resolveLinkTarget` first checks the local map. If the entry maps to exactly one docId, that's the resolved target. If the set contains two or more distinct docIds, the link is treated as **ambiguous** and counted as unresolved — the resolver fails closed rather than silently binding to an arbitrary candidate.
2. If the local map has no entry, the resolver falls back to a SQL lookup scoped to the same collection: `SELECT id FROM documents WHERE collection=? AND active=1 AND LOWER(TRIM(title))=? LIMIT 2`. If the result contains more than one row (two pre-existing docs with duplicate titles), the link is again treated as ambiguous.
3. Self-referencing links (target resolves to the source fact's own docId) are skipped.
4. Resolved links are inserted into `memory_relations` via a weight-monotonic upsert:
   ```sql
   INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(source_id, target_id, relation_type)
   DO UPDATE SET weight = MAX(weight, excluded.weight)
   ```
   This policy is idempotent on equal-weight reruns (no inflation) but monotonically accepts stronger later evidence (a subsequent run that finds the same triple with higher weight updates the existing row; a subsequent run with lower weight leaves it untouched). The earlier `INSERT OR IGNORE` would have under-accumulated by discarding legitimate stronger evidence, and `store.insertRelation`'s `weight += excluded.weight` would have over-accumulated by inflating weights linearly with rerun count.

### Failure model

All LLM failures, JSON parse errors, saveMemory collisions, and relation insert errors are caught and counted, never re-thrown. The final `SynthesisResult` exposes seven counters:

| Counter | Meaning |
|---------|---------|
| `docsScanned` | Conversations selected for extraction |
| `factsExtracted` | Facts that passed validation (per fact across all docs) |
| `factsSaved` | Facts where `saveMemory` returned `inserted` or `updated` (deduplicated is counted as extracted but not saved-new) |
| `linksResolved` | Links that bound to a unique non-self target and landed in `memory_relations` |
| `linksUnresolved` | Links that couldn't resolve (unknown target, ambiguous local, ambiguous SQL, self-reference) |
| `llmFailures` | Docs where the LLM path failed — null, thrown, or non-array JSON |
| `docsWithNoFacts` | Docs where the LLM responded validly but returned zero facts (or all candidates were rejected by normalize) |

Synthesis runs only when the user explicitly passes `--synthesize` — it is off by default because each pass drives one extra LLM call per conversation doc. Reruns over the same collection are safe: paths are stable, relation weights are monotone, saveMemory dedup collapses true duplicates.

## Heavy maintenance lane (v0.8.0)

The consolidation worker that ticks every 5 minutes (the "light lane") is tuned for interactive sessions — it backfills A-MEM notes on the newest three documents per tick and runs Phase 2 consolidation every 30 minutes and Phase 3 deductive synthesis every 15 minutes. On large vaults this keeps context-surfacing happy but is too slow to catch up on a multi-thousand-document backlog or to apply anomaly-first reviews to long-tail content. v0.8.0 adds a **second worker** — the **heavy maintenance lane** — that runs on a longer interval, only during configured quiet windows, with DB-backed exclusivity and stale-first batching. It is **off by default** and requires `CLAWMEM_HEAVY_LANE=true` to start. The light lane is unchanged.

The heavy lane lives in `src/maintenance.ts`. Exclusivity is provided by `src/worker-lease.ts`. Schema additions are in `store.ts`: a `maintenance_runs` journal table and a `worker_leases` exclusivity table.

### Why a second lane

Running Phase 2/3 more aggressively in the light lane would starve interactive sessions. Running them only when the user is idle requires knowing when the user is idle — in v0.8.0 that signal is the existing `context_usage` table (the same v0.7.0 telemetry that `recall_events` feeds off). The heavy lane counts context injections in the last 10 minutes and skips when the rate exceeds its configured cap. No new `query_activity` table is needed.

### Quiet-window gating

Two knobs select when the heavy lane is allowed to fire:

- **Hour window** — `CLAWMEM_HEAVY_LANE_WINDOW_START` and `_WINDOW_END` accept integer hours `0-23`. The lane runs when the current local hour is inside `[start, end)`. Midnight wraparound is supported: `start=22, end=6` means "10 PM through 6 AM". When either bound is unset (the default), the window check is skipped entirely.
- **Query-rate cap** — `CLAWMEM_HEAVY_LANE_MAX_USAGES` caps the number of `context_usage` rows in the last 10 minutes. The default of 30 is conservative; raise it on vaults where many concurrent agents share a store. The query runs `SELECT COUNT(*) FROM context_usage WHERE timestamp > ?` with the cutoff computed in JS and bound as a parameter (the naive `datetime('now', '-10 minutes')` pattern returns a space-separated string that sorts incorrectly against the ISO 8601 `T`-separated timestamps that `context_usage.timestamp` is actually written with).

Gate failures write a `maintenance_runs` row with `phase='gate'`, `status='skipped'`, and `reason='outside_window'` or `reason='query_rate_high'` so operators can tell whether the lane is being gated by the schedule or by actual activity.

### Worker lease exclusivity

Even when the gate passes, two processes sharing a vault could start heavy ticks simultaneously. v0.8.0 adds a `worker_leases` table and an atomic acquire path in `src/worker-lease.ts`:

```sql
INSERT INTO worker_leases (worker_name, lease_token, acquired_at, expires_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(worker_name) DO UPDATE SET
  lease_token = excluded.lease_token,
  acquired_at = excluded.acquired_at,
  expires_at  = excluded.expires_at
WHERE worker_leases.expires_at <= excluded.acquired_at
```

The `WHERE` clause on the upsert path only reclaims a row whose existing `expires_at` has passed, so a live lease blocks the conflict branch entirely and SQLite reports `changes=0`. The caller interprets `changes === 0` as "another worker holds it" and returns `{ acquired: false }`. A single statement means no SELECT-then-INSERT race window exists across processes — the old TurnArc-style `transaction(SELECT → if existing → UPDATE else INSERT)` pattern had a window where two callers could both observe "no row" and then one would hit a UNIQUE violation on its INSERT, which would throw instead of returning a cooperative "busy" result.

Acquired leases return a random 16-byte hex fencing token. `releaseWorkerLease` deletes the row only when `worker_name = ? AND lease_token = ?`, so a lease that has been reclaimed by another worker after TTL expiry cannot be torn down by the original holder on its way out. The entire acquire path is wrapped in a `try/catch` that translates `SQLITE_BUSY` (pathological contention under heavy WAL pressure) and any other DB error into `{ acquired: false }` so the advertised non-throw contract holds for `shouldRunHeavyMaintenance`-style gates layered on top.

A lease TTL of 10 minutes by default (`CLAWMEM_HEAVY_LANE_INTERVAL` / 3 or thereabouts) covers the worst-case duration of a Phase 2 + Phase 3 run; if a worker crashes mid-tick, the lease naturally expires and the next tick reclaims it.

Failure to acquire the lease writes a `maintenance_runs` row with `status='skipped'` and `reason='lease_unavailable'`.

### Stale-first selection

The default light-lane Phase 2 SELECT orders by `modified_at DESC` so the most-recently-changed observations are consolidated first. That works for an interactive agent but neglects long-tail content whose consolidated patterns never get refreshed. The heavy lane passes `staleOnly: true` into `consolidateObservations`, which switches the SQL to:

```sql
SELECT d.id, d.title, d.facts, d.amem_context AS context, d.modified_at, d.collection
  FROM documents d
  LEFT JOIN recall_stats rs ON rs.doc_id = d.id
 WHERE d.active = 1
   AND d.content_type = 'observation'
   AND d.facts IS NOT NULL
   AND d.id NOT IN (
     SELECT value FROM (
       SELECT json_each.value AS value
         FROM consolidated_observations co, json_each(co.source_doc_ids)
        WHERE co.status = 'active'
     )
   )
 ORDER BY d.collection,
          COALESCE(rs.last_recalled_at, d.last_accessed_at, d.modified_at) ASC,
          d.modified_at ASC
 LIMIT ?
```

The `COALESCE` fallback chain is important: a fresh vault has an empty `recall_stats` table, so the ordering has to fall through to `documents.last_accessed_at` (which is backfilled from `modified_at` by the initial migration) and then to `documents.modified_at` itself. An empty `recall_stats` is a first-class case, not an error, and is covered by unit tests that explicitly assert valid stale ordering with zero `recall_stats` rows. The same switching logic applies to Phase 3's recent-observation SELECT when the heavy lane calls `generateDeductiveObservations({ staleOnly: true })`.

### Surprisal selector (optional)

Stale-first is a good default, but it is driven purely by access timestamps. An operator can instead ask the heavy lane to feed Phase 2 with k-NN anomaly-ranked doc ids by setting `CLAWMEM_HEAVY_LANE_SURPRISAL=true`. The heavy lane then calls `selectSurprisingObservationBatch(store, staleObservationLimit)` — a thin wrapper over the existing `computeSurprisalScores` from `consolidation.ts` — and passes the returned ids into `consolidateObservations` via a new `candidateIds` option. The Phase 2 SELECT then filters `AND d.id IN (?, ?, ...)` against exactly those ids.

When the surprisal backend returns an empty array (no embeddings in the vault, `vectors_vec` missing, or the k-NN query yields fewer docs than `k+1`), the heavy lane **falls through to stale-first** rather than doing nothing. The `maintenance_runs.metrics_json` distinguishes the three cases via the `selector` field: `stale-first` (default), `surprisal` (selector returned a non-empty batch), or `surprisal-fallback-stale` (selector returned empty and the lane degraded gracefully). Empty `candidateIds` passed in explicitly is treated as "the selector found nothing" and short-circuits without hitting the LLM — distinct from `candidateIds: undefined` which means "select via the default ordering".

### Guarded merge-safety enforcement

The light lane respects `CLAWMEM_MERGE_GUARD_DRY_RUN=true` — when set, Phase 2 merge-safety gate rejections are logged but not enforced, giving operators a way to calibrate thresholds before switching the gate on. The heavy lane passes `guarded: true` into `consolidateObservations`, which is threaded down through `synthesizeCluster` into `findSimilarConsolidation(forceEnforce=true)`. With `forceEnforce=true`, the function ignores the dry-run env var and always enforces the name-aware dual-threshold gate. This means experimenting operators cannot weaken heavy-lane guarantees by toggling an env flag, while still keeping the light lane tunable for calibration runs.

### Journal rows

Every scheduled heavy-lane attempt writes rows to `maintenance_runs` via `insertMaintenanceRun` / `finalizeMaintenanceRun`:

| Column | Meaning |
|---|---|
| `lane` | Always `heavy` for v0.8.0. The light-lane tick does not journal (would require a larger refactor). |
| `phase` | `gate` (for skipped rows), `consolidate` (Phase 2), or `deductive` (Phase 3). |
| `status` | `started` when the row is first written, `completed` on success, `failed` on exception, `skipped` when gating blocks the tick. |
| `reason` | For skips: `outside_window`, `query_rate_high`, or `lease_unavailable`. For failures: `phase2_exception` or `phase3_exception`. |
| `selected_count` | For Phase 2: the limit passed to the SELECT (or the surprisal batch size). For Phase 3: `DeductiveSynthesisStats.considered`. |
| `processed_count` | Phase 3 only: `DeductiveSynthesisStats.drafted`. |
| `created_count` | Phase 3 only: `DeductiveSynthesisStats.created`. |
| `rejected_count` | Phase 3 only: `DeductiveSynthesisStats.rejected` (the sum of all reject reasons). |
| `null_call_count` | Phase 3 only: `DeductiveSynthesisStats.nullCalls`. |
| `metrics_json` | Phase 2: `{ selector, candidateCount? }`. Phase 3: the full `DeductiveSynthesisStats` breakdown (contamination rejects, invalid index rejects, unsupported rejects, empty rejects, dedupe skipped, validator fallback accepts). |
| `started_at` / `finished_at` | Both ISO 8601 UTC. `finished_at` is null for rows that were never finalized because the process crashed between `insertMaintenanceRun` and `finalizeMaintenanceRun`. |

Operators can use these rows to reconstruct any lane decision without reading worker logs:

```sql
-- Why did the lane skip the most recent tick?
SELECT status, reason, started_at FROM maintenance_runs
 WHERE lane = 'heavy' AND phase = 'gate'
 ORDER BY started_at DESC LIMIT 5;

-- What selector has the heavy lane been running?
SELECT json_extract(metrics_json, '$.selector') AS selector, COUNT(*)
  FROM maintenance_runs
 WHERE lane = 'heavy' AND phase = 'consolidate' AND status = 'completed'
 GROUP BY selector;
```

### Vault scoping

The heavy lane operates on whatever `Store` it is handed. `createStore(path)` maps 1:1 to a single SQLite vault, so `context_usage` counts and `recall_stats` ordering are both inherently scoped to the current vault via `store.db` — no per-vault predicate is needed in the queries. Multi-vault mode (running the heavy lane across multiple stores from a single process) is explicitly out of scope for v0.8.0 and would require extending `HeavyMaintenanceConfig` with an explicit vault list plus a per-vault lease name.

## Multi-turn prior-query lookback (v0.8.1)

A single-prompt retrieval query is wrong when the user's current turn is short. "Do the same thing for X", "Explain that in more depth", and "Now talk about refresh tokens in the same design" are all legitimate questions whose intent lives in the *previous* turn, not the current one. v0.8.1 teaches `context-surfacing` to build its retrieval query from the current prompt plus up to two recent same-session prior prompts, so short follow-up turns inherit the vocabulary of earlier turns. Everything else (composite scoring, snippet extraction, reranking, dedupe, routing hints, recall attribution) continues to use the raw current prompt unchanged — only the discovery path sees the multi-turn query.

The helper lives in `src/hooks/context-surfacing.ts` and is backed by a new nullable `query_text` column on `context_usage`.

### Additive schema migration

```sql
ALTER TABLE context_usage ADD COLUMN query_text TEXT;
```

Guarded with `PRAGMA table_info(context_usage)` the same way the existing `turn_index` migration is. Stores created before v0.8.1 pick up the column on first open. A WeakMap `contextUsageHasQueryTextCache` records the column presence per `Database` instance at migration time so `insertUsageFn` can pick the correct INSERT shape without running `PRAGMA table_info` on every write. Ad-hoc stores that construct a `Database` outside `createStore()` default the cache to `false` and fall back to the pre-v0.8.1 7-column INSERT shape — the new code never writes a column that doesn't exist.

### Privacy-conscious persistence split

Raw prompt text has privacy implications. Two classes of `logEmptyTurn` call site exist in `contextSurfacing`, and they get different treatment:

- **Pre-retrieval gates** — slash commands (`prompt.startsWith("/")`), too-short prompts (`< MIN_PROMPT_LENGTH`), `shouldSkipRetrieval` hits (greetings, shell commands, affirmations), and `wasPromptSeenRecently` / `isHeartbeatPrompt` dedupe. These are not meaningful user questions and carry a higher sensitivity profile (they often contain incidental tool output or noise). They write a `context_usage` row with `query_text = NULL` to keep `turn_index` aligned with the transcript but not persist the raw text.
- **Post-retrieval empty paths** — empty result set, all results in `FILTERED_PATHS`, all results snoozed, activation floor not met, adaptive threshold filter, and empty `buildContext`. These are legitimate user questions that simply didn't match anything. They write a row with `query_text = prompt` so a follow-up turn ("try again" / "what about Y") can still use the intent via multi-turn lookback.

The happy path (successful injection) also persists `query_text = prompt`.

### Retrieval query construction

`buildMultiTurnSurfacingQuery(store, sessionId, currentQuery, lookback=2, maxAgeMinutes=10, maxChars=2000)` fetches recent `query_text` rows via:

```sql
SELECT query_text FROM context_usage
 WHERE session_id = ?
   AND hook_name = 'context-surfacing'
   AND timestamp > ?
   AND query_text IS NOT NULL
   AND query_text != ''
   AND query_text != ?     -- SQL-level self-match guard
 ORDER BY id DESC
 LIMIT ?
```

The ISO 8601 cutoff is computed in JS and bound as a parameter (same lesson as v0.8.0's `countRecentContextUsages` fix — `datetime('now', ...)` returns a space-separated format that sorts wrong against the `T`-separated ISO 8601 timestamps written by `new Date().toISOString()`).

The self-match filter lives in SQL because pushing it into application code under a `LIMIT lookback + 1` under-fills the window when multiple duplicate rows of the current prompt share the session. Example: `[current, current, prior1, prior2]` with app-level filtering would return only 3 rows, drop both duplicates, and leave just `prior1` in the result — half the lookback budget wasted. With the SQL inequality, every returned row is a valid non-self prior by construction and the `LIMIT = lookback` exactly matches the budget.

Fallback paths: missing `sessionId`, empty current prompt, missing `query_text` column on a pre-migration schema (SELECT throws → caught), and any other DB error all return the current prompt unchanged. The function never throws.

### Current-first truncation

The combined query format is:

```
<current prompt>

<newest prior>

<older prior>
```

(blank lines between segments). If the assembled string exceeds `maxChars` (default 2000), the algorithm drops older priors one at a time rather than truncating the head. The current prompt is **always** present verbatim in the result so the user's actual question anchors the retrieval. Only when the current prompt alone already exceeds `maxChars` (rare, because the handler enforces `MAX_QUERY_LENGTH` earlier) does the function return the truncated current prompt with priors omitted entirely.

### Which retrieval stages use the combined query

| Stage | Query used | Rationale |
|---|---|---|
| `searchVec` | combined | Discovery — inherit prior-turn vocabulary |
| `searchFTS` (fast path) | combined | Discovery |
| `searchFTS` (expanded variants) | combined | Discovery — expansion already reads from the combined query |
| `expandQuery` | combined | The LLM expansion benefits from context |
| File-path FTS supplements | raw current | File names live in the current prompt only; priors would pollute this channel |
| Cross-encoder rerank | **raw current** | Rerank asks "how well does this doc match the user's current question" — diluting with older turns blurs the final ordering |
| Composite scoring | raw current | Recency intent / content-type weighting is per-current-turn |
| Snippet extraction | raw current | Highlighting should point at the user's current question |
| Routing hint detection | raw current | "why did we decide X" is about the current turn's intent |
| `hashQuery` for recall attribution | raw current | Each event should attribute to the specific turn that surfaced it |
| `wasPromptSeenRecently` dedupe | raw current | Dedupe key is about the actual submitted text |
| `isHeartbeatPrompt` check | raw current | Heartbeat detection runs on the raw input |

This split keeps multi-turn lookback a discovery-only enhancement and ensures every downstream signal that depends on "what did the user actually type right now" continues to see exactly that.

## Retrieval tiers

| Tier | Mechanism | Agent effort | Coverage |
|------|-----------|-------------|----------|
| Tier 1 | Infrastructure (watcher + embed timer) | None | Keeps vault fresh |
| Tier 2 | Hooks (automatic) | None | ~90% of retrieval |
| Tier 3 | MCP tools (agent-initiated) | 1 tool call | ~10% — escalation only |

See [Hooks vs MCP](hooks-vs-mcp.md) for details.

## Recall tracking

ClawMem tracks which documents are surfaced by retrieval, which queries surfaced them, and whether the assistant actually cited them. This data feeds lifecycle decisions (pin/snooze candidates) and provides empirical signals beyond raw search relevance.

The `recall_events` table is an append-only log. Each time context-surfacing injects documents, it writes one event per injected doc with the query hash, search score, session ID, and turn index. The `feedback-loop` hook later marks which events were actually referenced in the assistant's response, using per-turn transcript segmentation to attribute references to specific turns rather than the session globally.

The `recall_stats` table is a derived summary recomputed by the consolidation worker. It tracks per-document:

| Signal | Description |
|--------|-------------|
| `recall_count` | Total times surfaced |
| `unique_queries` | Distinct query contexts (cross-domain generality) |
| `recall_days` | Distinct calendar days surfaced (spaced vs binge frequency) |
| `diversity_score` | `min(1, max(unique_queries, recall_days) / 5)` |
| `spacing_score` | Multi-day spread: log-scaled day count + calendar span |
| `negative_count` | Surfaced but not referenced (noise signal) |

`lifecycle_status` uses these signals to surface pin candidates (high diversity + spacing + recall count) and snooze candidates (high recall count with mostly negative signals).
