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

Any path segment beginning with `.` is also skipped, so dotfile directories need no entry.

#### Adding your own

There is no exclude key in `config.yaml` — the list is the `EXCLUDED_DIRS` set in `src/indexer.ts`, and adding to it is the supported way to exclude a directory convention ClawMem doesn't already know about:

```ts
export const EXCLUDED_DIRS = new Set([
  "_PRIVATE",
  "_snapshots",   // your archive convention
  ".clawmem",
  // ...
]);
```

`shouldExclude()` matches **whole path segments**, not substrings, so an entry can only ever match a directory of exactly that name — a document *named* `backup-design.md` is unaffected by an entry called `backup`. The set is shared by the indexer and the file watcher, so one entry covers both reindex sweeps and live file events.

Two operational notes:

- **Restart the watcher** (`systemctl --user restart clawmem-watcher`) after editing the set. A running watcher holds the old list in memory and will keep indexing the directory you just excluded.
- **Already-indexed documents retire on the next `clawmem update`** — the indexer deactivates stored paths that no longer match. No manual deletion is needed, and the documents remain in the database as `active=0` rather than being destroyed.

One artifact is excluded by content rather than by path: the `precompact-state.md` snapshot ClawMem ≤ v0.39.x wrote into Claude Code's per-project memory dirs, recognised by the header those versions always wrote. Every ranked retrieval path and every automatic listing excludes an indexed copy with one read-side predicate (`notLegacyArtifactSql`), whatever its origin and whatever version indexed it, so no migration has to run first. That covers FTS, the vector hydrations, graph and entity-neighbour traversal, causal retrieval, `query`'s temporal and entity channels, typed and review-due listings, timeline neighbours, relation snippets and evolution triggers; glob and path-suffix matches, did-you-mean suggestions, lifecycle target search and exports (REST `/export?full=true` includes it); and every input to A-MEM enrichment, entity extraction, graph building, consolidation, deduction, conversation synthesis and embedding. A get by exact path or docid still returns it. An A-MEM note a copy shaped, or one an older ClawMem evolved after the upgrade (its evolution entries carry no writer stamp), is never read by an enrichment prompt; it is cleared at the next writable open or background pass and rebuilt from the note's own text by the light-lane backfill (`CLAWMEM_ENABLE_CONSOLIDATION=true`), or, for a note indexed from a file, also when the file changes or by `clawmem reindex --enrich` (a note that hooks or the API wrote has only the backfill, so without the light lane it stays without an A-MEM note, which search and injection never use); its evolution history hides the entries that carried the text and shows a `reset:` entry instead. All of this describes an upgraded process: an older ClawMem still running against the vault keeps its own behaviour until it is upgraded, so upgrade every process that shares the vault. The indexer skips the file and deactivates the copy at its path (origin `fs`, or a pre-v0.34 `NULL` row, which the file on disk vouches for). A file with that name and other content is an ordinary document, and `clawmem doctor` lists copies still active.

The common case is an archive or versioned-copy directory holding timestamped duplicates of live documents (`_snapshots/<ts>/report.md` beside a live `report.md`). Indexing those yields several stale near-identical copies of the same document, and retrieval can surface a superseded revision as though it were current — a quiet correctness problem rather than a noisy one, since nothing errors.

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
| `pinned` | Lifecycle retention + priority among relevance-equivalent results (+0.3 on composite surfaces; exact-tie precedence on the raw vector routes) |
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

## Vector query daemon (v0.20.0; wire contract v0.38.0)

The sqlite-vec `MATCH` is synchronous and `bun:sqlite` has no interrupt handler, so a cold scan inside the context-surfacing hook blocks the hook's event loop — a timeout on that loop cannot fire until the scan returns. `clawmem watch` therefore hosts a vector query daemon. The hook sends its query over a per-vault Unix socket (`$XDG_RUNTIME_DIR/clawmem/vec-<hash of the DB path>.sock`) and races the reply against a real timer while its own loop stays free. The daemon is an optimization, never a dependency: with no daemon the hook runs the scan in-process, unbounded as before; a daemon that is busy, errors or runs out of time costs that turn's vector leg — the hook falls back to FTS and never re-runs the scan in-process.

**Hydrated responses (`hydrated-v1`).** The daemon hydrates and projects the results itself — snippets, rerank text and filter verdicts — so document bodies never cross the socket and the hook does no synchronous SQLite work inside its vector deadline. The projection is capped (result count, entry and frame bytes); an over-cap answer is refused and the leg falls back to FTS.

**Relative budgets (`deadline-rel-v1`).** The hook's deadlines are monotonic, and none crosses the wire: each request carries `remainingBudgetMs`, the whole milliseconds left on the leg, sampled just before the write (an integer from 1 to 25000; a hydrated request must carry one). The daemon anchors its own deadline at frame receipt and checks it before and after each synchronous phase — advisory, never cancelling a scan; the hook's timer stays authoritative. Every answer to a budgeted request attests `deadlineProtocol: "deadline-rel-v1"`. Mismatched builds fail closed in both directions: an answer without the attestation, or raw hits returned for a hydrated request, is classified `skew` (FTS plus a once-per-process warning naming the socket), and a request that still carries an absolute `deadlineMs` is refused as `version_skew`. The old client falls back without a word, so the daemon logs the first refusal once per run (v0.38.1).

**Health.** A ping names the exact DB and pid behind the socket and advertises the protocols it serves. `clawmem doctor` and `clawmem vec-daemon-health` report `live` only when both `hydrated-v1` and `deadline-rel-v1` are advertised — the one state in which the hook's vector deadline holds. `live-raw` (attested, a protocol missing) and `live-legacy` (a pre-v0.38 watcher without the ping) prove a listener only. See [vec-daemon-health](../reference/cli.md) and, for version mismatches, [troubleshooting](../troubleshooting.md).

## Graphs

ClawMem maintains a `memory_relations` table of typed edges between documents: semantic, supporting, contradicts, causal, and temporal. These edges let `intent_search` answer "why" and "what led to" questions by following chains across documents rather than relying on keyword or vector similarity alone.

A separate `entity_triples` table stores structured SPO (Subject-Predicate-Object) facts with temporal validity (`valid_from`/`valid_to`). Triples are emitted by the observer LLM alongside facts as `<triples>` blocks in each observation, parsed and validated against a tight canonical predicate vocabulary (adopted, migrated_to, deployed_to, runs_on, replaced, depends_on, integrates_with, uses, prefers, avoids, caused_by, resolved_by, owned_by), then persisted by `decision-extractor` using canonical `vault:type:slug` entity IDs via `ensureEntityCanonical`. Subject/object type inheritance is ambiguity-safe (exact-match only, defaults to `concept` on unknown or ambiguous names). Query via `kg_query(entity)` for structured entity relationships — accepts entity name or canonical ID.

Most edges are created automatically. When new documents are indexed, A-MEM finds vector neighbors and uses the LLM to classify relationships (semantic, supporting, contradicts). When `decision-extractor` runs after each response, it infers causal links between observations and extracts SPO triples from facts. The `build_graphs` MCP tool adds temporal backbone edges (creation-order) and bulk semantic edges — run it after large ingestion batches, not after routine indexing.

See [graph traversal](../internals/graph-traversal.md) for edge types, traversal mechanics, and beam search details.

## Consolidation safety (v0.7.1)

The background consolidation worker has three independent safety gates that prevent observation contamination, accidental cross-entity merges, and unchecked contradictions from landing in the vault.

### Phase 2 — name-aware merge safety

When the worker finds a candidate existing observation to merge a new pattern into, it runs a deterministic name-aware gate before updating. The gate extracts entity anchors from both the new and existing texts — first via `entity_mentions` (if the source docs are enriched), falling back to lexical proper-noun extraction — and compares them with normalized character 3-gram cosine similarity. When anchor sets differ materially (Jaccard ≤ 0.5), the merge is hard-rejected regardless of text similarity. Otherwise, a dual-threshold score applies: `CLAWMEM_MERGE_SCORE_NORMAL` (default `0.93`) for aligned anchors, `CLAWMEM_MERGE_SCORE_STRICT` (default `0.98`) as the strictest fallback. This prevents "Alice decided X" from merging into "Bob decided X" just because the predicate is identical. Set `CLAWMEM_MERGE_GUARD_DRY_RUN=true` to log rejections without enforcing them.

### Phase 2 — contradiction-aware merge gate

After the name-aware gate passes, the worker checks whether the new observation contradicts the existing one. Since v0.29.0 the check runs through the configured **contradiction judge** (`CLAWMEM_JUDGE_*`, the same strict relation-array contract as the decision-extractor hook); with no judge configured, only the deterministic heuristic runs (negation asymmetry, number/date mismatch) and outcomes are constrained to the non-deactivating `link` policy. Mutation-authorizing evaluations commit durable `judge_runs`/`judge_events` audit rows in the same transaction as the resulting mutation; non-mutating outcomes write standalone rows. If the final confidence meets `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE` (default `0.5`), the merge is blocked and one of two policies applies (configured via `CLAWMEM_CONTRADICTION_POLICY`):

- `link` (default) — insert a new `consolidated_observations` row and set the old row's `invalidated_by` column as a **backlink** to the new row. Both remain active and queryable. *(Phase 2 does not insert `memory_relations` edges — `contradicts` edges come from Phase 3 deductive synthesis.)*
- `supersede` — insert the new row and mark the old row `status='inactive'` with `invalidated_at`/`superseded_by` set. The old row is filtered from retrieval but preserved for audit. **Requires a configured judge**: without one, a configured `supersede` is loudly constrained to `link` (`clawmem doctor` reports the policy as inactive).

Phase 3 deductive synthesis applies the same `contradicts` link for any draft that matches a prior deductive observation with conflicting content.

### Phase 3 — anti-contamination deductive synthesis

Phase 3 synthesizes cross-session insights from recent observations into `content_type='deductive'` documents. The draft-generation LLM can produce drafts whose conclusion references entities that only appear in the candidate pool but not in the cited sources — a form of context bleed. Each draft runs through a three-layer validator:

1. **Deterministic pre-checks** — reject empty conclusions; reject drafts whose `source_indices` don't resolve to at least two unique source docs; reject drafts whose conclusion names an entity (entity-aware via `entity_mentions`, lexical fallback via proper-noun extraction) that exists in the candidate pool but not in any cited source.
2. **LLM validator** — a separate LLM call checks that the conclusion is genuinely supported by the cited source snippets. Fail-open: if the validator times out or returns malformed JSON, the draft is accepted and flagged via the `validatorFallbackAccepts` stat so operators can detect when the LLM path is effectively offline.
3. **Dedupe** — accepted drafts are compared against recent deductive observations to prevent duplicates.

Rejection reasons are tracked individually in `DeductiveSynthesisStats` (`contaminationRejects`, `invalidIndexRejects`, `unsupportedRejects`, `emptyRejects`, `dedupSkipped`, `validatorFallbackAccepts`) so Phase 3 yield can be diagnosed without enabling extra logging.

Since v0.41.4 both passes fit their prompt to the LLM's context (read fresh, counted as the chat endpoint will see it, with a 500-token reply): the Phase 2 cluster prompt and the Phase 3 draft prompt hold the leading sources that fit, in their selection order, and the numbering, the source-index bounds, the document mapping, the validator's context and `DeductiveSynthesisStats.considered` all use exactly those: `considered` is the number of sources the model was shown, 0 when fewer than two fit or the fitting used up the call's deadline (no call is made then). With fewer than two observations selected nothing is fitted or sent, and `considered` stays the selection count (0 or 1), as before v0.41.4. Fewer than two sources fit → no synthesis that tick. A reply the server cut is neither a synthesis nor a deduction (counted as a null call in Phase 3).

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

### Dual-host worker architecture (v0.8.2)

v0.8.0 shipped the heavy lane wired into `cmdMcp` (the stdio MCP host) only. In a Claude Code deployment that means workers are spawned per-session and die when the user closes Claude Code — defeating the heavy lane's quiet-window premise, which expects a long-lived process running at the configured hours regardless of user interactivity. v0.8.2 adds `cmdWatch` as a second host so the existing `clawmem-watcher.service` systemd user unit can carry both lanes 24/7, alongside the per-session MCP fallback.

**Light lane gets its own DB lease.** The v0.8.0 heavy lane already had cross-process exclusivity via `worker_leases` (key `heavy-maintenance`). v0.8.2 extends the same primitive to the light lane (key `light-consolidation`, 10-min default TTL). `runConsolidationTick` now wraps the entire tick body in `withWorkerLease`, so two host processes against the same vault cannot:

- both decide `findSimilarConsolidation(...)` is null and both INSERT a duplicate row into `consolidated_observations`
- both merge into the same existing row and lose source_ids from the read-modify-write update in `mergeIntoExistingConsolidation`
- double-burn LLM calls on the v0.7.1 anti-contamination wrapper for Phase 3 deductive synthesis

The in-process `isRunning` reentrancy guard remains as the cheap first defense that catches overlapping `setInterval` fires before any SQLite round-trip; the lease is the cross-process authority.

**Both hosts wire the same env-var gates.** `cmdWatch` and `cmdMcp` both check `CLAWMEM_ENABLE_CONSOLIDATION` and `CLAWMEM_HEAVY_LANE` (parsed via the shared `parseHeavyLaneConfigFromEnv()` helper in `maintenance.ts`). Off by default in both hosts. Operators opt in by setting the env vars on whichever long-lived process they want to host the workers — typically `clawmem-watcher.service` for the canonical setup.

**`cmdMcp` warns when heavy lane is enabled.** Per-session stdio MCPs are short-lived and may never see the configured quiet window. When `CLAWMEM_HEAVY_LANE=true` is set on a stdio MCP host, `cmdMcp` emits a one-line warning to stderr advising operators to move heavy-lane hosting to `clawmem watch`. The fallback host still works, just with a visible reminder.

**Async drain on shutdown.** Both worker stop helpers (`stopConsolidationWorker` and the closure returned by `startHeavyMaintenanceWorker`) are now `async`. They clear their `setInterval` AND poll their in-flight running flag (`isRunning` / `heavyRunning`) until any mid-tick worker drains. This guarantees the worker's `withWorkerLease` finally block runs against a still-open store, so the lease is released cleanly via `releaseWorkerLease` instead of being abandoned to TTL expiry. The drain wait is bounded — `STOP_DRAIN_TIMEOUT_MS=15s` for the light lane, `HEAVY_STOP_DRAIN_TIMEOUT_MS=30s` for the heavy lane — so a pathologically stuck tick (e.g. unreachable LLM with no socket timeout) cannot wedge shutdown indefinitely. After the timeout, the host logs and exits anyway; the next process reclaims the stale lease via the v0.8.0 atomic upsert.

**Signal handlers registered before worker startup.** Both `cmdWatch` and `cmdMcp` now register their `SIGINT`/`SIGTERM` handlers BEFORE any worker initialization. The mutable `stopHeavyLane` is declared at the top, the closure captures it, the handlers are registered immediately, then the workers start and assign into the captured variable. Without this ordering, a `SIGTERM` arriving in the brief window between worker startup and handler registration would be handled by Node's default signal action (terminate with exit 143) and skip the async drain entirely.

**Multi-host contention is safe.** Running both `clawmem watch` AND a per-session `clawmem mcp` against the same vault with both env vars enabled is supported. The `worker_leases` table arbitrates: only one host wins each tick, the other journals a skip (heavy lane) or logs a "lease held" message (light lane) and waits for the next interval. Operators who want exactly one worker per lane should set the env vars on `clawmem-watcher.service` only and leave `cmdMcp` unset.

## Multi-turn prior-query lookback (v0.8.1)

A single-prompt retrieval query is wrong when the user's current turn is short. "Do the same thing for X", "Explain that in more depth", and "Now talk about refresh tokens in the same design" are all legitimate questions whose intent lives in the *previous* turn, not the current one. v0.8.1 introduced multi-turn lookback as a concatenated discovery query; **v0.38.0 reworked it into gated, discounted prior lanes** — concatenation let polluted thread vocabulary anchor the whole candidate set, and on the FTS leg (AND semantics) a joined query could only ever *narrow* recall. The mechanics now:

- **A deterministic anaphora gate decides.** The prior leg runs only when the *current* prompt delegates its meaning to earlier turns: anaphoric/deictic markers, continuation openers, explicit conversation back-references, and strong continuation moves ("go deeper", "expand", "continue"). Weak discourse openers ("now", "so", "ok") stay behind a content-token threshold, so a self-contained imperative that merely opens with "now" never drags priors in.
- **Priors are their own lanes, never a joined query.** Up to two recent same-session prior prompts (10-minute window, read from `context_usage.query_text`) each run their own BM25 list (`prior-fts` — one list per prior, because a joined FTS query is strictly narrower under AND semantics); the vector leg embeds the joined priors once (`prior-vector`), bounded to 400ms and **daemon-only** — without the vector-query daemon the leg is skipped rather than risk an unbounded synchronous in-process scan (`CLAWMEM_PRIOR_VECTOR_INPROC=1` is the eval/debug override).
- **Discounted in fusion, band-separated in the output.** Prior lanes join the weighted RRF at a rank discount under the same mass cap + protected current-class slots as expansion lanes, and prior-only survivors carry band 1 — ordered strictly below every current-supported candidate and admitted only on the certified-prior edge (the current lanes returned nothing AND the gate certified delegation).
- **Everything else stays on the raw current prompt** — query expansion, cross-encoder rerank, composite scoring, snippet extraction, file-path supplements, routing hints, recall attribution, dedupe, and heartbeat detection all see exactly what the user typed.

The helper lives in `src/hooks/context-surfacing.ts` and is backed by a new nullable `query_text` column on `context_usage`.

### Additive schema migration

```sql
ALTER TABLE context_usage ADD COLUMN query_text TEXT;
```

Guarded with `PRAGMA table_info(context_usage)` the same way the existing `turn_index` migration is. Stores created before v0.8.1 pick up the column on first open. A WeakMap `contextUsageHasQueryTextCache` records the column presence per `Database` instance at migration time so `insertUsageFn` can pick the correct INSERT shape without running `PRAGMA table_info` on every write. Ad-hoc stores that construct a `Database` outside `createStore()` default the cache to `false` and fall back to the pre-v0.8.1 7-column INSERT shape — the new code never writes a column that doesn't exist.

### Privacy-conscious persistence split

Raw prompt text has privacy implications. Two classes of `logEmptyTurn` call site exist in `contextSurfacing`, and they get different treatment:

- **Pre-retrieval gates** — slash commands (`prompt.startsWith("/")`), too-short prompts (`< MIN_PROMPT_LENGTH` — unless the prompt matches the memory-intent `FORCE_RETRIEVE_PATTERNS`, which are checked before every skip gate so short queries like "what did I say?" still reach retrieval), and `shouldSkipRetrieval` hits (greetings, shell commands, affirmations). These are not meaningful user questions and carry a higher sensitivity profile (they often contain incidental tool output or noise). They write a `context_usage` row with `query_text = NULL` to keep `turn_index` aligned with the transcript but not persist the raw text. Heartbeat prompts and recent-duplicate prompts write **no row at all** — they are not transcript-visible user turns.
- **Every turn that reaches retrieval** — since v0.38.0 the hook writes its alignment row **early, at retrieval commit**, with `query_text = prompt` and empty paths. One row covers every downstream outcome (successful injection, empty result set, filtered/snoozed-out sets, admission abstention, deadline skip), so a follow-up turn ("try again" / "what about Y") can always use the intent via multi-turn lookback. If the alignment insert cannot land (writer contention past the hook's bounded `busy_timeout`), the hook **fails closed** — it emits nothing for that turn rather than injecting untracked context, and the row count is unchanged so the next successful turn takes the vacated index. The injected-paths/token fill-in for the happy path is applied afterward by the off-process bookkeeping drainer (see [Recall tracking](#recall-tracking)) via a guarded `UPDATE` that verifies the exact row identity.

### Prior-query retrieval

`fetchRecentPriorQueries(store, sessionId, currentQuery, lookback=2, maxAgeMinutes=10)` — shared with the legacy `buildMultiTurnSurfacingQuery` helper, which is retained for compatibility but no longer used by the hook — fetches recent `query_text` rows via:

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

### Which stages see prior turns

Only the two gated prior lanes (`prior-fts`, `prior-vector`) ever consume prior-turn text. Every current-class lane (vector, FTS, file-aware) and every downstream signal — query expansion, cross-encoder rerank, composite scoring, snippet extraction, routing hints, recall attribution (`hashQuery`), dedupe, heartbeat detection — runs on the raw current prompt. This keeps prior-turn lookback a gated, discounted discovery supplement: it can add candidates that the current turn's vocabulary missed, but it can never re-anchor the query, outvote current-turn support in fusion, or leak into relevance scoring of the user's actual question.

## Retrieval tiers

| Tier | Mechanism | Agent effort | Coverage |
|------|-----------|-------------|----------|
| Tier 1 | Infrastructure (watcher + embed timer) | None | Keeps vault fresh |
| Tier 2 | Hooks (automatic) | None | ~90% of retrieval |
| Tier 3 | MCP tools (agent-initiated) | 1 tool call | ~10% — escalation only |

See [Hooks vs MCP](hooks-vs-mcp.md) for details.

## Recall tracking

ClawMem tracks which documents are surfaced by retrieval, which queries surfaced them, and whether the assistant actually cited them. This data feeds lifecycle decisions (pin/snooze candidates) and provides empirical signals beyond raw search relevance.

The `recall_events` table is an append-only log. Each time context-surfacing injects documents, one event per injected doc is recorded with the query hash, search score, session ID, and turn index. The `feedback-loop` hook later marks which events were actually referenced: since v0.41.0 it pairs each turn with its surfacing row by identity and tests the turn's own assistant text once against that turn's manifest (see [Stop pipeline](#stop-pipeline)); through v0.40.3 turns and rows were zipped by position. Since v0.38.0 these rows are written by the off-process bookkeeping drainer (below) carrying per-row idempotency keys (`dedupe_key`, enforced by a partial unique index), so a crashed-and-retried job can never double-count a surfacing.

### Off-process surfacing bookkeeping (v0.38.0)

In normal production mode (`CLAWMEM_SURFACING_TRACE` off) the context-surfacing hook performs **zero SQLite or filesystem bookkeeping after its payload is assembled**, and its only in-lifetime write is the early alignment `context_usage` row at retrieval commit (turn index + prompt text, empty paths) — fail-closed: no row, no injection. (The one disclosed exception: with the diagnostic `CLAWMEM_SURFACING_TRACE=1` armed, the hook synchronously persists a `surfacing_diagnostics` trace after both clocks stop — outside every budget and reserve, which is why it is a diagnostic mode.) Everything else is learning data, and it leaves the process:

1. **Park** — after emitting stdout, the CLI wrapper consumes the parked job (paths, token estimate, per-vault doc groups) and serializes it under a 32 KB cap (an oversized job is dropped fail-open).
2. **Handoff** — the job is piped to a detached, unref'd `clawmem spool-ingest` child. The flush is raced against 250 ms; if the race is lost (a pathological pipe), the sink is unref'd and the child killed — the hook's lifetime is never extended by its own bookkeeping, at the cost of that turn's optional learning data. The alignment row is already durable either way.
3. **Persist + drain** — the child does a bounded stdin read (aborts at the cap), validates the complete job shape, persists it to `<db dir>/surfacing-spool/` (tmp file + atomic rename), and drains the spool.
4. **Apply** — draining claims each job by atomic rename (`<job>.json` → `.json.claim-<pid>`), then applies per **unit**: the guarded alignment `UPDATE` first, then recall events per vault group and the secondary-vault `context_usage` mirrors. Recall events and mirrors carry dedupe keys, so retries are idempotent; a thrown update defers all event units to the retry (events are never committed ahead of a settled update outcome); a definitively failed update (row absent or identity mismatch) writes events **unlinked** rather than attributing them to the wrong row. Completed units are checkpointed into the retained claim, dead-pid claims are reclaimed, and jobs older than 24 h are discarded as poison.

Since v0.41.0 a job also carries the turn's **manifest** — each injected document's vault, display path, document id and title as rendered — whenever the hook had a verified turn identity. On a migrated vault the drainer then applies the alignment update, the general-vault recall events and the manifest (`feedback_ledger` rows, one `utility_signals` surfaced increment per document, the turn's pending `feedback_turns` row) in ONE transaction, and each named vault's mirror row, manifest slice and events in one transaction of that vault. A manifest job on a vault whose migration is not verified fails its unit and stays in the spool, retried like any failed unit until the job's 24 h limit. A job without a manifest (written by a pre-upgrade hook, or by an older ClawMem) applies the old units only, and its row is marked `unattributable` (`legacy-job`).

`clawmem spool-drain` runs the same drain manually and is safe at any time — claim-by-rename makes concurrent drainers non-duplicating. The design trade is explicit: recall attribution and fill-in are **best-effort** off-process work; turn alignment and prompt history are not.

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

## Stop pipeline

Since v0.41.0 the three Stop hooks (`decision-extractor`, `handoff-generator`, `feedback-loop`) process each turn once. Claude Code runs them after every response, OpenClaw after every agent turn (`agent_end`), and the Hermes plugin after every synced turn.

### Transcript identity and cursors

A transcript is identified by its session id and `transcript_key` = sha256 of its absolute path, so two transcripts of one session id (OpenClaw's base and topic transcripts) never share state. `context-surfacing` registers each transcript it sees in `session_transcripts` at handler entry, before any gate, and the Stop-family hooks register theirs too. So the watcher can reach every Claude Code transcript that produced a prompt, and every OpenClaw transcript that some invocation of its session resolved to an existing file (OpenClaw may create a session's file after its first prompt).

`decision-extractor` and `handoff-generator` each keep a cursor per transcript in `stop_cursors`: the byte offset of the end of what it has processed, the hash of the line ending there, and the file's identity (device, inode, first line). A run reads complete lines after the cursor, at most 64 MB at a time, and never advances past what it processed. A transcript with no cursor — its first Stop, or its first after the upgrade — starts at its current turn, so pre-upgrade turns are never re-extracted. A Hermes transcript begun after the stop pipeline was installed starts at its first line instead: the plugin writes that file itself, so nothing processed any of it, and a first pass that ran late or failed would otherwise skip the turns before it. (Claude Code keeps the current-turn rule: a `--fork-session` transcript opens with copies of its source session's entries under their original timestamps.) `feedback-loop` keeps no cursor: it works from the transcript's open `feedback_turns` rows, and applies each verdict under a state check on that row. A file whose identity no longer matches (replaced, truncated or rewritten) is re-anchored at its current turn with a new generation number (`anchor_epoch`), which enters every identity derived from a range, so no old key is reused.

### Phases

The two cursor hooks run Phase A (reading and model calls, no memory writes), then Phase B (one `BEGIN IMMEDIATE` transaction on the general vault: re-read the cursor; if another run moved it, discard; else write the range's effects and advance the cursor), then Phase C (after-effects that are idempotent by key). `feedback-loop`'s verdicts are gated the same way on the row instead: each applies only while its `feedback_turns` row is still open. A model call ends `ok`, `empty` (a valid answer with nothing to record) or `retryable`; since v0.41.2 the observer can also end a range as a `continuation` (part of it done, see below). Only `ok` and `empty` commit effects. A `retryable` range is **quarantined** in `stop_retries` — keyed by transcript, hook and range (`<epoch>-<from>-<to>-<sha16>`), with the hash of its bytes — while the cursor moves past it. Later Stops (one due range each) and the watcher claim it with a 5-minute lease and retry it with backoff (1 minute, 5 minutes, 30 minutes, 2 hours, then every 12 hours), re-reading and re-hashing its bytes first. A range whose bytes changed is marked `unavailable` and processed no further. A replayed range writes its observations with the source turn's time, and its judge and causal steps consider only documents created and last modified by that time. Since v0.41.2 a Stop ends its loop at its first quarantine: the turns after that range wait for the next Stop, so one Stop queues at most one range.

### decision-extractor

Complete turns from the cursor are packed into batches as in v0.41.1: at most 100 messages and 8,000 rendered characters, less 2,850 kept for the CONTEXT section and a retry's feedback. The section carries the two turns before the batch and the session's recorded observation titles, marked as already recorded: at most 2,000 characters (`OBSERVER_CONTEXT_MAX_CHARS`), the latest 1,100 of those turns' text and the newest titles that fit in 700.

Since v0.41.2 the observer fits each prompt in **tokens**. Before each model call, retries included, it reads the LLM server's context from `/props` (else `CLAWMEM_LLM_CONTEXT_TOKENS`, else an assumed 4,096) and counts the assembled prompt exactly through `/apply-template` and `/tokenize` where the server serves them (otherwise a content count plus a template margin, or a cautious estimate that only learns upward). It keeps a reply reserve R of 40% of the context, clamped to 768–2,000 tokens, and asks for at most ⌊(R − 64) / 360⌋ observations (1 to 5). A batch that does not fit one prompt runs as **windows** of whole turns inside the same Stop; a turn is cut between messages only when it alone exceeds a window, and a window that holds a turn boundary ends at the last one that fits, counted before it is sent. Window 1 carries the CONTEXT section above; window k > 1 carries the tail of the transcript before it (`EARLIER IN THIS EXCHANGE`) and the titles recorded so far, its earlier windows' included (`ALREADY RECORDED`). A reply the context cut (`finish_reason: "length"`) is never parsed: that window runs again at half its size. A reply that did not finish as an answer (no completion choice, or another finish reason) is retryable, never read as "nothing to record". A server that sends no finish reason is read best-effort: a reply that used its whole allowance counts as cut, any other as complete. A 200 without a completion choice counts toward the endpoint's failure streak like an HTTP error, instead of clearing it. An oversize refusal corrects the count once. One message, or the fixed prompt, that cannot fit a window at all ends the range `retryable` with a `capacity:` reason, which `clawmem doctor` counts. One run gives a range at most 6 observer calls.

Since v0.41.4 only the reply `<none/>` is "nothing to record": an empty reply, prose, or another format is a format failure (`empty-reply`, `no-blocks`), and a reply holding valid blocks yields them, its invalid blocks dropped. A rejected block is classed (`type-not-allowed` with the value's class — `tool-role`, `placeholder`, `type-list`, `other` — `type-missing`, `title-missing`, `title-empty`, `title-placeholder`, `facts-empty`), and a window gets up to two format retries, each a fresh sample whose feedback names the failing field, its class and the allowed values, never the reply. Field values are decoded once (`&lt;`, `&gt;`, `&amp;`), then trimmed and checked, with every bound in code points. A triple whose subject or object is a tool-call id or a copied tool-call rendering (the whole value — `toolu_abcdef.ts` names a file and keeps its triple), or whose two sides are equal, a copied `{{entity}}`/`{{path}}` skeleton token and a repeated fact are dropped; a field that restates one of the prompt's own rules is kept and counted. After a reply that needs a retry — unparseable, cut, a validated oversize, or a refused grammar request — every way the run can end before the retry's own reply (no call or time left, a capacity read that cannot be verified, the retry's call never answering) ends the range `retryable` with that reply's class, with the failure backoff; only a verified server change and a lost compare-and-swap keep their meaning. A halving or an oversize's correction is written into the checkpoint as a shrink-only window bound before the smaller window is tried, so the next run starts small. An oversize whose `n_ctx` is below what `/props` claims also records a context ceiling for that `/props` value (`vault_flags` `observer-nctx:<backend>:<n_ctx>`, 7 days; 4 records per backend, the one just written and the 3 latest others), which every later run applies from its first call; each further validated oversize lowers it. On a server whose fingerprint is strong (llama-server) and in process, each request carries a GBNF grammar built from the type, predicate and concept lists and the field bounds, unless the grammar is off for that server or `CLAWMEM_OBSERVER_GRAMMAR=off`; enforcement is not checked before use. A refused grammar request — an HTTP 400, or in process a grammar that does not compile — writes `observer-grammar:<hash of root, model, fingerprint, grammar version>` at once — off for 24 hours (extended, never shortened, by a later refusal), with an obligation that a grammarless request reach the server before the grammar is used again, cleared only by an answer to one whose generation is still current. Completed replies to grammar requests that fail structurally, content rejections, echoes and drops are kept per backend in `vault_flags` `observer_stats` for `clawmem doctor`.

Progress through the windows is kept in a durable checkpoint: a `vault_flags` row `observer-ckpt:<session>|<transcript key>|<hook>|<range key>` holding the windows done (and, since v0.41.4, the window bound of the next one after a size reduction), the observer contract version, the server's fingerprint (sha256 of its model path, chat template and build; strong only when `/props` names all three) and the backend the range is pinned to. Every change is a compare-and-swap on the row's raw value. A range that runs out of calls or time between windows is quarantined as a `continuation`: attempts unchanged, due again in 60 s, resumed after its last finished window (since v0.41.4 one that runs out while a window waits for its retry fails the attempt instead, as above). Two strong fingerprints that differ start the range again from window 1; a strong one against a `/props` that gives no fingerprint (no answer, an error, a 404, a body that is not llama.cpp's, one without the model, template and build) leaves the range waiting with its windows kept, however long, as a pinned backend that is down leaves the continuation for later. Phase B writes a tombstone over the checkpoint when the range commits, and the watcher sweeps orphaned checkpoints (no queued range owns them — matched by the range's full identity, its transcript epoch included — and their range is settled), paging from where its last sweep stopped. Each run adds its measured call times to `vault_flags` `observer_call_mean`, which keeps the latest 50 and their mean for `clawmem doctor`. Observations with equal bodies from different windows merge, with their triples, before the contradiction judge. A batch with no assistant message of 40 characters or more and no tool call is consumed without a model call. Decisions and antipatterns (the observer's, and the regex extractor's) become items in `stop_items`, one row per distinct item content per transcript. The session's `_clawmem/decisions/…` and `_clawmem/antipatterns/…` documents are **renders** of all its items in transcript order, written by `upsertSessionDoc` at a path fixed in `session_docs` at first creation (`<date>-<sid8>.md`; `-<tk6>` for a second transcript of the session id, or when a document this pipeline did not write holds the path). The write is path-authoritative: an active API-owned document gets its body replaced, a filesystem-owned one is refused, an inactive one is left alone and re-rendered by `restoreArchivedDocuments` when it is restored.

The contradiction judge (when configured) records every classification in `judge_pair_verdicts` by fact, old document, old document hash and contract version, so a pair is decided once; a verdict whose old document changed during the call goes to `judge_deferred` and is re-judged against the current content by the watcher. The causal witness writer (when `shadow`/`on`) runs once per committed range under the run key `stop:<session>:<transcript key>:<range key>`; Phase B leaves a `causal_due` marker recording the mode in force, and a run never uses a mode above both the recorded and the current one. While the writer is `off`, markers wait.

### handoff-generator

The digest step (no model) records one `turn-digest` item per turn — the request (≤ 200 characters), the final answer's last paragraph (≤ 300), the files its Edit/Write/MultiEdit/NotebookEdit calls touched — with a sequence number from `stop_cursors.next_digest_seq`, which is never reused. The summary step folds the digests past its watermark (`summary_through`) into the previous summary when at least 3 wait, 30 minutes after the last summary, or at the first; it runs in ordered batches, prunes the digests a successful summary covers, and renders `_clawmem/handoffs/…`. Since v0.41.2 a batch is the first digests whose prompt, with a 500-token reply, fits the server's context in tokens (the recent turn text is dropped first); the watermark moves only past the digests the summary used. A digest lists at most 10 files in the prompt, and the stored summary is capped (the request at 600 characters, each other field at 800). A failed summary changes only its audit. The document renders only in the summary step, at SessionEnd and in the watcher; other paths mark it `render_needed`. The SessionEnd flush reads no transcript and calls no model: it renders the summary and the latest 20 digests past it, and records `ended_at` for the session's transcripts. A transcript's handoff exists once its digested turns hold four messages.

### feedback-loop

The bookkeeping drainer records each turn's manifest — what `context-surfacing` rendered into the context it returned (see [Off-process surfacing bookkeeping](#off-process-surfacing-bookkeeping-v0380)). On Claude Code and OpenClaw the host injects that output into the turn; on Hermes the plugin hands it over later, or not at all, and records which turn received it when it can prove it (otherwise it records the row dropped or unresolved — see the [Hermes guide](../guides/hermes-plugin.md#the-stop-pipeline-on-hermes-v0410)). A Stop then pairs the transcript's pending surfacing rows with its human turns: the row's `prompt_sha` (sha256 of the normalised prompt the hook received) must equal the hash of the turn's text, and the host's ordering rule must hold on the entries' own timestamps — Claude Code `H.ts ≤ U.ts < H_next.ts`, OpenClaw `E_prev.ts ≤ U.ts ≤ H.ts`; on Hermes, whose plugin prefetches after a turn for a later prompt, a row is not paired at all: it is credited in the turn whose user line carries its id (`clawmem_delivery`, written by the plugin), and closed `not-delivered` when the plugin records it dropped or unresolved; the feedback step reads each Hermes transcript once, every pass resuming where the last stopped (`hermes_scan`, with what it read in `hermes_marks`). A pairing must be unique both ways; anything else leaves the row unattributed. The reference test runs once per turn over the whole manifest (display path, a path of two or more segments, a file name as a whole token, or the displayed title), and each identifier must name exactly one entry across all vaults. A verified reference flips its `feedback_ledger` entry once and applies, stamped, `access_count + 1`, `last_accessed_at`, the utility signal, the recall event and same-turn co-activations and `usage` relations. The verdict is final once the turn is over (a later human entry, a Stop, Claude Code's `stop_hook_summary`/`turn_duration` entry after an answer, or the session's end); where the pairing window is closed (OpenClaw, Hermes) the watcher may credit a quiet trailing turn provisionally first. Named vaults apply their slice of the general verdict, tracked by the verdict's revision number.

### The fence and the recompute

The migration (one transaction at the end of every writable open's schema setup, read-guarded) records the highest `context_usage.id` as the usage watermark and installs triggers that skip, and count in `legacy_writer_log`, every write an older ClawMem makes to feedback counters, co-activations, `usage` relations, utility signals and the Stop hooks' documents (paths under `decisions/`, `antipatterns/`, `handoffs/`, `observations/` in `_clawmem`). This version stamps every such write. An older surfacing hook's usage-row insert fails instead, so it fails closed and injects nothing. The one-time recompute (`stop-pipeline:recompute-v1`), run by the watcher's first start or `clawmem repair counters --apply`, freezes pre-watermark usage rows, sets each document's access count and last access from verified references, recomputes the utility signals, rebuilds co-activations and `usage` relations from verified same-turn references, and gives a staggered archive grace (`access_grace_until`) to documents whose old access was inside their archive window. It works in chunks of 5,000 rows with resumable step markers and keeps every before-image in `counter_repair_log` for `--restore`.

### The watcher's worker

`clawmem watch` runs the stop-pipeline worker every 60 s with a 25 s budget per tick, through the same Phase A/B code as the hooks: pending feedback of every registered transcript that is quiet for 10 minutes or has ended (a transcript whose file is gone closes its rows `unattributable`), named-vault slices, handoff digest catch-up for a quiet transcript whose final Stop never committed (its trailing turn digested provisionally), uncapped handoff renders, quarantined ranges, deferred judge pairs and runnable causal markers. Since v0.41.2 a due observer continuation runs first, in its own slice of the tick (twice the process's mean observer call plus 5 s, 15 to 23 s), and the tick ends by sweeping orphaned observer checkpoints. Every item is leased or transaction-gated, so a Stop and the worker never both apply one. `clawmem repair stop-queue --run` runs the same passes by hand with no quiet period.
