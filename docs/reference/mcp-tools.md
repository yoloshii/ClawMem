# MCP server tools reference

Complete reference for ClawMem's MCP server tools. These let AI agents search, retrieve, and manage persistent memory. All tools accept an optional `vault` parameter for multi-vault setups. Omit for the default vault.

## Retrieval

**Internal-collection visibility (v0.21.0):** the retrieval tools `search`, `vsearch`, `query`, `query_plan`, `memory_retrieve`, and `find_similar` — plus `memory_rank` since v0.36.0 — exclude the system-internal `_clawmem` collection (observations/deductions/handoffs) by default. Opt-ins: pass `includeInternal: true` (all seven tools), or — on the tools that expose a `collection` parameter (`search`, `vsearch`, `query`, `memory_rank`) — name `_clawmem` explicitly in the filter. `find_similar` auto-includes internal results when the REFERENCE document is itself internal. `intent_search`, `find_causal_links`, `kg_query`, `session_log`, and `timeline` are NOT filtered — system memory is their substrate by design.

**Shared causal pipeline + the WHY observation lane (v0.32.0):** the causal surfaces — `memory_retrieve`'s causal mode, `intent_search`, `query_plan`'s graph clauses, and REST `/retrieve`'s causal mode — run one shared intent-aware pipeline (anchors → intent-weighted RRF → bounded one-hop causal traversal in BOTH directions → adaptive traversal → MPFP → rerank), so their behavior no longer drifts; they differ only in declared stages and visibility policy. On the default-filtered callers (`memory_retrieve` causal, `query_plan` graph), a WHY-classified query additionally anchors into `_clawmem` **observation documents only** (`observations/` path with an observation type — never handoffs or deductions) and follows causal edges one bounded hop each way (≤3 per anchor, ≤10 total); one-hop hits carry `causal: [{anchorDocid, direction: "cause"|"effect"}]` in results. Candidate eligibility (active, non-invalidated, effective-time window, collection policy) is enforced inside every anchor/traversal/MPFP query — ineligible rows never consume beam slots or propagation mass. **Exception:** entity co-occurrence expansion derives from provenance-free aggregates and cannot honor row-level eligibility; it is a legacy stage that runs only on direct `intent_search`, pending provenance-aware co-occurrence.

**Scoring regimes (v0.22.0 vector · v0.24.0 FTS):** the direct retrieval routes — `vsearch` and `memory_retrieve`'s semantic/discovery modes (v0.22.0), and `search` (v0.24.0) — rank non-recency queries by their RAW channel score: vector cosine (`scoreBasis: "vector-cosine"`) on the vector routes, the monotonic BM25 transform (`scoreBasis: "fts-bm25"`) on `search`. Raw values are channel-specific and NOT comparable across channels, across embedding models, or to composite scores. Document metadata — including pin — participates only inside groups of exactly-equal raw scores. On these routes `minScore` filters the raw score and has NO default (omitted = no filter; an explicit `0` is honored). Recency-intent queries ("latest…", "recently…", "yesterday…") keep the composite regime and report `scoreBasis: "composite"` — `vsearch`'s recency branch keeps its 0.3 composite default floor, `search`'s keeps 0 — as do `query`, `query_plan`, and `memory_retrieve`'s keyword/hybrid/causal/complex modes. `find_similar` has always ranked by raw cosine. Rationale — both splits are measured, not aesthetic: on judged sets against the live vault, raw cosine ranked 16/19 targets #1 (MRR 0.912) vs composite 1/19 (0.307); raw-FTS ranked 33/43 keyword targets #1 (MRR 0.848) vs composite 6/43 (0.415), with composite losing even on the fresh-doc-favorable slice (0.348 vs 0.801).

**FTS score provenance (v0.23.0):** the raw `score` on BM25/FTS results is the monotonic transform `|bm25|/(1+|bm25|)` of FTS5's negative-is-better `bm25()` value — bounded [0,1), higher is better, stable across queries. (Through v0.22.0 a clamp bug flattened it to a constant 1.0, so composite ranking on FTS surfaces was effectively metadata-only and score-threshold gates never filtered.) FTS-transform scores and vector cosines are **independent monotonic signals, not a calibrated common scale** — compare within a channel, not across channels.

**Degraded vector results (v0.21.0):** under default exclusion the vector scan escalates its depth to fill `limit` with allowed documents, up to a hard cap. When the cap prevents an exhaustive scan and the result is under-filled, `structuredContent` carries `degraded: true` with `degradedReason`: `"excluded-dominant"` (distinct excluded docs account for the shortfall — the guidance line suggests `includeInternal: true` or a refined query) or `"cap-truncation"` (shortfall driven by fragment dedup, neutral guidance). Multi-leg routes (`query`, `query_plan`, `memory_retrieve` complex mode) aggregate `degraded = any(leg)` and list per-leg reasons in `structuredContent.degradedLegs`; single-vector routes (`vsearch`, `find_similar`, `memory_retrieve`'s other modes) report the flat `degraded` + `degradedReason` pair. A small vault whose whole index is scanned without hitting the cap returns a plain short list with NO marker.

### memory_retrieve

**Recommended entry point.** Auto-classifies query and routes to the optimal backend.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Your question or search query |
| `mode` | enum | `auto` | Override: `keyword`, `semantic`, `causal`, `timeline`, `discovery`, `complex`, `hybrid` |
| `limit` | number | 10 | Max results |
| `compact` | boolean | true | Compact output (snippets vs full content) |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs |
| `vault` | string | — | Named vault |

Auto-routing:
- Timeline queries ("last session", "yesterday") → session history
- Causal queries ("why did we", "what caused") → the shared intent-aware causal pipeline with graph traversal (behavioral parity with `intent_search`; default-filtered, plus the WHY observation lane)
- Discovery queries ("similar to", "related to") → find_similar
- Complex queries (multi-topic) → query_plan
- Everything else → full hybrid search

### query

Full hybrid pipeline: BM25 + vector + query expansion + cross-encoder reranking.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `compact` | boolean | false | Compact output |
| `collection` | string | — | Filter by collection (comma-separated for multi) |
| `intent` | string | — | Domain hint for ambiguous queries (steers expansion, reranking, chunk selection) |
| `candidateLimit` | number | 30 | Candidates for reranking (tune precision vs speed) |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs |
| `vault` | string | — | Named vault |

BM25 strong-signal bypass: skips expansion when top BM25 hit >= 0.85 with gap >= 0.15 (disabled when `intent` is provided).

### search

BM25 only. Zero GPU cost. Non-recency queries rank by the RAW BM25 transform (`scoreBasis: "fts-bm25"`, v0.24.0 — see the regimes note above); recency-intent queries use the composite regime.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `minScore` | number | — | Score floor. Non-recency: filters the RAW BM25 transform, NO default (omitted = no filter; explicit `0` honored). Recency-intent: composite floor, default 0 |
| `compact` | boolean | false | Compact output |
| `collection` | string | — | Filter by collection |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs |
| `vault` | string | — | Named vault |

Score fields: on non-recency queries the reported ranking score IS the raw BM25 transform (compact `score` and non-compact `compositeScore` both carry it; non-compact `score` is the same raw value). On recency-intent queries compact `score` / non-compact `compositeScore` are composite while non-compact `score` stays the raw transform.

### vsearch

Vector only. Semantic similarity. Non-recency queries rank by RAW cosine (`scoreBasis: "vector-cosine"`, v0.22.0); recency-intent queries use the composite regime.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `minScore` | number | — | Raw-cosine floor on non-recency queries (no default — omitted means no filter; explicit `0` honored). Recency-intent queries keep the composite-scale 0.3 default. |
| `compact` | boolean | false | Compact output |
| `collection` | string | — | Filter by collection |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs |
| `vault` | string | — | Named vault |

### intent_search

Intent-classified search with graph traversal. Use directly for "why", "when", "who" questions.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `force_intent` | enum | — | Override: `WHY`, `WHEN`, `ENTITY`, `WHAT` |
| `enable_graph_traversal` | boolean | true | Master graph switch: `false` disables adaptive traversal, MPFP, entity expansion, AND the one-hop causal step (anchor search + rerank remain) |
| `vault` | string | — | Named vault |

### query_plan

Multi-topic decomposition. Use for complex queries spanning multiple subjects.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Complex or multi-topic query |
| `limit` | number | 10 | Max results |
| `compact` | boolean | true | Compact output |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs |
| `vault` | string | — | Named vault |

### memory_rank

Ranking diagnostic (v0.36.0): runs the real FTS + composite scoring pipeline for a query and returns each result's per-factor breakdown plus raw-vs-composite rank shifts. FTS-only candidates — no vector or LLM stage. Read-only; scores and ordering are exactly what production computes.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Query to explain ranking for |
| `limit` | number | 10 | Results to explain per view (1–50, integer) |
| `collection` | string | — | Filter to collection (single name or comma-separated) |
| `weightProfile` | enum | `default` | `default` = hook/`memory_retrieve` weights (0.50/0.25/0.25); `query` = the `query` tool's (0.70/0.15/0.15). Recency-intent queries use the recency weights regardless, as in production |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs — excluded by default |
| `vault` | string | — | Named vault; an unknown name returns the available list |

Output is the **union** of the composite top-`limit` and the raw top-`limit`: a raw winner the composite ordering pushed below the cutoff stays visible, flagged `demotedRawWinner` (text marker `⚠ demoted raw winner`) with its true composite rank. Each item carries `searchScore`, `compositeScore`, `compositeRank`, `rawRank` (production raw ordering, including its pin → legacy-composite → path tie contract), `rankShift` (positive = composite promoted the doc), and a `breakdown` with every factor: weights applied, recency and blended-confidence inputs, quality/length/frequency/canonical multipliers, `pinBoost` (signed — negative means the 1.0 pin cap clamped a high scorer down; see [composite-scoring.md](../concepts/composite-scoring.md#pin-boost)), and the co-activation multiplier. The factors are captured inside the scorer, never re-derived, so they reproduce `compositeScore` exactly.

## Document access

### get

Retrieve a single document by path or docid.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | required | File path or docid (`#abc123`) |
| `fromLine` | number | — | Start line |
| `maxLines` | number | — | Line limit |
| `lineNumbers` | boolean | false | Include line numbers |
| `vault` | string | — | Named vault |

### multi_get

Retrieve multiple documents by glob pattern or comma-separated list.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `pattern` | string | required | Glob pattern or comma-separated paths |
| `maxLines` | number | — | Line limit per document |
| `maxBytes` | number | 10240 | Max total bytes |
| `lineNumbers` | boolean | false | Include line numbers |
| `vault` | string | — | Named vault |

### find_similar

k-NN vector neighbors of a reference document.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | required | Path of reference document |
| `limit` | number | 5 | Max results |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs (auto-included when the reference doc is itself internal) |
| `vault` | string | — | Named vault |

### find_causal_links

Evidence-preserving directed causal edge traversal from a document. Each result is
an edge record with invariant `sourceDocId`/`targetDocId` (the physical edge) plus
separate traversal provenance (`predecessorDocId`, `depth`, `direction`), carrying
up to 3 fact-pair witnesses (`sourceFactOrdinal`/`targetFactOrdinal`, fact
snapshots, reasoning, confidence, `strongestAt`/`lastSeenAt`) and an honest
`evidenceCount`. Pre-cut edges without stored witnesses surface one synthesized
`legacy` display witness from edge metadata when it is valid.

**Multi-hop CHAIN quality is experimental**: records at `depth > 1` are per-edge
evidence along a traversal, not a verified causal chain.

Bounds: one combined 50-edge budget across both directions with a truthful
`truncated` flag, and the complete serialized result (text and structured copies
together) is capped at 64 KiB — truncation drops whole edges from both
representations symmetrically in the deterministic order
(depth, weight DESC, sourceDocId, targetDocId, direction).

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `docid` | string | required | Document ID |
| `direction` | enum | `both` | `causes`, `caused_by`, or `both` |
| `depth` | number | 5 | Max traversal depth (1-10) |
| `vault` | string | — | Named vault |

### timeline

Temporal neighborhood — what was created/modified before and after a document.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `docid` | string | required | Document ID |
| `before` | number | 5 | Documents to show before (1-20) |
| `after` | number | 5 | Documents to show after (1-20) |
| `same_collection` | boolean | false | Constrain to same collection |
| `vault` | string | — | Named vault |

### memory_evolution_status

Track how a document's A-MEM metadata evolved over time.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `docid` | string | required | Document ID |
| `limit` | number | 10 | Max evolution entries (1-100) |
| `vault` | string | — | Named vault |

### session_log

Recent session history with handoffs and file changes.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 10 | Max sessions |
| `vault` | string | — | Named vault |

## Mutations

### memory_pin

Pin a memory: lifecycle retention plus prioritization among relevance-equivalent results. On composite surfaces (hooks, `query`) pinned docs get the +0.3 composite boost; on the raw routes (`vsearch`/`memory_retrieve` semantic-discovery v0.22.0, `search` non-recency v0.24.0) pin wins exact raw-score ties but never overrides a relevance difference.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query or path to find the memory |
| `unpin` | boolean | false | Set true to unpin |
| `vault` | string | — | Named vault |

### memory_snooze

Temporarily hide a memory from context surfacing.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query or path to find the memory |
| `until` | string | — | ISO date (e.g., `2026-04-01`). Omit to unsnooze. |
| `vault` | string | — | Named vault |

### memory_forget

Permanently deactivate a memory.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query or path to find the memory |
| `confirm` | boolean | true | False = preview only |
| `vault` | string | — | Named vault |

**Search behavior (v0.2.6+, all three tools):** Query matching cascades through four strategies: exact path match → BM25 full-text → title-token overlap → vector similarity. This prevents "No matching memory found" errors when the document exists but BM25 fails to match (e.g., too many AND'd terms). Path-like queries (containing `/` or ending in `.md`) try direct path matching first. `memory_forget` requires higher confidence to act — ambiguous matches return candidates instead of mutating.

**Targeting confidence (v0.23.0):** the confidence gate (`score ≥ 0.7`, or a ≥ 0.2 gap to the runner-up when more than one candidate exists) is now live for BM25 candidates — through v0.22.0 every FTS candidate carried a constant score of 1.0, so `memory_forget` treated ANY keyword match as high-confidence and auto-selected it. Weak matches — including a lone weak match — now return the candidate list for disambiguation instead of acting. Stricter, safer targeting for a destructive operation.

## Lifecycle

### lifecycle_status

Document lifecycle statistics: active, archived, forgotten, pinned, snoozed counts.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vault` | string | — | Named vault |

### lifecycle_sweep

Archive stale documents based on lifecycle policy. **Archives only — never deletes.**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `dry_run` | boolean | true | Preview only (no action) |
| `vault` | string | — | Named vault |

Archival is reversible via `lifecycle_restore`. Through v0.29.0 a non-dry-run sweep also
permanently deleted every archived row past `purge_after_days` — a set the preview never
listed or counted. As of v0.30.0 ClawMem does not physically delete document rows on any
path, and `purge_after_days` is inert.

### lifecycle_restore

Restore auto-archived documents.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | — | Search archived docs by keyword |
| `collection` | string | — | Restore all from a collection |
| `all` | boolean | false | Restore everything |
| `vault` | string | — | Named vault |

## Maintenance

### status

Quick index health check.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vault` | string | — | Named vault |

### reindex

Trigger re-scan of all collections. The summary (and `structuredContent`) carries
`enrichAttempted`/`enrichStored` note counters — a run whose every enrichment produced
nothing reports the gap explicitly instead of an unqualified success (v0.37.0).

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vault` | string | — | Named vault |

### index_stats

Detailed statistics: content type distribution, staleness, embedding coverage.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vault` | string | — | Named vault |

### memory_stats

Deterministic lifecycle + ranking-metadata aggregates per collection (v0.36.0). Complements `index_stats` (embedding coverage / content types). Pure SQL, fail-loud, read-only. Includes system collections — nothing is filtered.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `collection` | string | — | Restrict to one collection; an unknown name returns the available list |
| `vault` | string | — | Named vault; an unknown name returns the available list |

Per collection: counts by active state; **origin×active cross-tabs** (`fs` / `api` / legacy-`NULL` rows from the v0.34.0 ownership model — each total/active/inactive); pinned count; accrual (created last 7d/30d) and created-at span; and mean/median/min/max distributions over `access_count`, `confidence`, `quality_score`, and **effective-time age in days** (`authored_at ?? modified_at`, the same axis recency ranking decays on). Counts and cross-tabs cover ALL rows; the distributions cover ACTIVE rows only — ranking never sees inactive rows, so mixing them in would misstate the corpus the scorer operates on. Deactivation reasons are grouped at the end (`null` reason = pre-v0.31.0 rows). Empty distributions (e.g. an inactive-only collection) return `null` fields, rendered `n/a` in text.

### build_graphs

Build temporal backbone and semantic graph.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `graph_types` | array | `["all"]` | `temporal`, `semantic`, or `all` |
| `semantic_threshold` | number | 0.7 | Similarity threshold for semantic edges |
| `vault` | string | — | Named vault |

**Response** (v0.28.0+):

| Field | Meaning |
|---|---|
| `temporal` / `semantic` | Edges **newly written by this call**. Inserts are idempotent, so a rebuild over an unchanged corpus correctly returns `0`. |
| `temporalTotal` / `semanticTotal` | Edges of that type **currently in the active graph** — both endpoints active. |

Text output reads `Temporal graph: N new edge(s), M total`.

`0 new` does **not** mean the graph is empty — check the total. Before v0.28.0 these counters
reported insert *attempts* rather than rows written, so a call that persisted nothing could
still report a non-zero count. Only the graph types you request appear in the response; the
REST endpoint differs (see [rest-api.md](rest-api.md)).

### profile

Get or rebuild the user profile (static facts + dynamic context).

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `rebuild` | boolean | false | Force rebuild |

### beads_sync

Sync Beads issues from Dolt backend into the search index.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `project_path` | string | cwd | Path to project with `.beads/` directory |

Runs `bd list --json --limit 0` — the full backlog, not bd's default 50-issue page (v0.20.1). The spawned call disables bd usage metrics (`BD_DISABLE_METRICS=1`, ignored by pre-1.1.0 binaries). Issues carrying bd ≥1.1.0 claim-lease fields render a `**Claim Lease**` line in the indexed document (v0.20.1); upstream's removed `quality_score` field is no longer parsed.

## Vault management

### list_vaults

Show configured vault names and paths. Returns empty in single-vault mode.

### vault_sync

Index markdown from a directory into a named vault.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vault` | string | required | Target vault name |
| `content_root` | string | required | Directory path to index |
| `pattern` | string | `**/*.md` | Glob pattern |
| `collection_name` | string | vault name | Collection name in the vault |

Restricted-path validation rejects sensitive directories (`/etc/`, `/root/`, `.ssh`, `.env`, `credentials`, `.aws`, `.kube`). The summary carries a `Notes: stored/attempted` line with an explicit warning when enrichment produced nothing (v0.37.0).

### kg_query

Query the SPO knowledge graph for an entity's temporal relationships.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `entity` | string | required | Entity name or ID |
| `as_of` | string | — | Date filter (YYYY-MM-DD) — only facts valid at this date |
| `direction` | enum | `both` | `outgoing`, `incoming`, or `both` |
| `vault` | string | — | Named vault |

Uses entity resolution (FTS search) first, falls back to slug normalization. Returns triples with subject, predicate, object, valid_from, valid_to, confidence, and current status.

**Evidence (v0.32.0):** each fact carries `evidenceCount` — the number of UNIQUE evidence sources (distinct `(source document, source fact)` pairs; identical re-sightings collapse) — plus up to 5 `sources` of `{ docId, collection, path, fact, at }` ordered most-recent-first. Evidence with no source document renders as `unattributed`. Text output appends `[evidence ×N; sources: …]` when evidence exists.

### diary_write

Write to the agent's diary. For non-hooked environments where hooks don't capture session context automatically.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `entry` | string | required | Diary entry text |
| `topic` | string | `general` | Topic tag (e.g., 'technical', 'user_facts', 'session') |
| `agent` | string | `agent` | Agent name writing the entry |
| `vault` | string | — | Named vault |

Entries stored via `saveMemory()` with ms-resolution paths to prevent dedup of rapid writes.

### diary_read

Read recent diary entries.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `last_n` | number | 10 | Number of entries to return |
| `agent` | string | — | Filter by agent name |
| `vault` | string | — | Named vault |
## Cross-Agent Memory (v0.38.0)

Active shared memory: an agent writes a signed, witnessed fact into the knowledge graph
and every other agent sharing the vault can read it. Distinct from document indexing —
these are first-class witnessed facts with attribution and confidence.

### fact_write

Write a learned fact as a witnessed SPO triple.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `subject` | string | required | Subject entity (name or canonical id) |
| `predicate` | string | required | Relation (lowercased; spaces → `_`) |
| `object` | string | required | Object entity or literal value |
| `subject_type` | string | `concept` | Entity type for subject if new |
| `object_type` | string | `concept` | Entity type for object if new |
| `witness.agentId` | string | required | Agent writing the fact |
| `witness.sessionId` | string | — | Session the fact was learned in |
| `witness.timestamp` | string | now | ISO observation timestamp |
| `witness.source` | string | — | How observed (`direct_observation`, …) |
| `confidence` | number | `0.9` | 0..1 confidence |
| `valid_from` | string | now | Validity start (ISO) |
| `valid_to` | string | — | Validity end / expiry (ISO) — natural decay |
| `tags` | string[] | — | Free-form labels |
| `vault` | string | — | Named vault |

Cross-agent writes **append** a new version rather than overwrite: a different agent's
higher-confidence fact on the same subject+predicate survives as an alternate witnessed
version (divergence/evolution preserved).

### fact_link

Create a directed semantic relation between two entities (cross-domain reference).

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from` | string | required | Source entity |
| `relation` | string | required | Directed relation name |
| `to` | string | required | Target entity |
| `from_type` / `to_type` | string | `concept` | Entity types if new |
| `witness` | object | required | Same attribution shape as `fact_write` |
| `confidence` | number | `0.9` | 0..1 confidence |
| `valid_to` | string | — | Optional expiry |
| `tags` | string[] | — | Free-form labels |
| `vault` | string | — | Named vault |

### fact_query_cross_agent

Query witnessed facts across agents with filtering.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `subject` | string | `*` | Subject entity or `*` |
| `predicate` | string | `*` | Relation or `*` |
| `object` | string | `*` | Object entity/literal or `*` |
| `since` | string | — | Only facts written on/after this ISO time |
| `min_confidence` | number | `0.7` | Lower bound (inclusive) on confidence |
| `written_by` | string[] | — | Restrict to writer agent(s) |
| `session_ids` | string[] | — | Restrict to session(s) |
| `resolve_conflicts` | boolean | `false` | Collapse divergent witnesses to most recent ≥ floor |
| `limit` | number | `50` | Max facts (1..200) |
| `vault` | string | — | Named vault |

`resolve_conflicts: true` merges arcs that differ only by witness, keeping the most recent
current fact above `min_confidence` per (subject, predicate, object).

### Context injection layer (optional, default OFF)

Not an MCP tool — an orchestration behaviour of the vault. Enable via
`retrieval.cross_agent_inject: true` (or `CLAWMEM_CROSS_AGENT_INJECT=true`); confidence
floor `retrieval.cross_agent_confidence` (default 0.7). When enabled, facts written by
*other* agents about entities in the task prompt are injected as a labelled
`<cross-agent-facts>` block. Bounded to 2s and fail-open by design; the active profile must
grant a `crossAgentTokens` sub-budget for the stage to run. See the
[cross-agent section of the README](https://github.com/yoloshii/ClawMem#readme).
