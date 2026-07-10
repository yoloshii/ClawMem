# MCP server tools reference

Complete reference for ClawMem's MCP server tools. These let AI agents search, retrieve, and manage persistent memory. All tools accept an optional `vault` parameter for multi-vault setups. Omit for the default vault.

## Retrieval

**Internal-collection visibility (v0.21.0):** the retrieval tools `search`, `vsearch`, `query`, `query_plan`, `memory_retrieve`, and `find_similar` exclude the system-internal `_clawmem` collection (observations/deductions/handoffs) by default. Opt-ins: pass `includeInternal: true` (all six tools), or — on the tools that expose a `collection` parameter (`search`, `vsearch`, `query`) — name `_clawmem` explicitly in the filter. `find_similar` auto-includes internal results when the REFERENCE document is itself internal. `intent_search`, `find_causal_links`, `kg_query`, `session_log`, and `timeline` are NOT filtered — system memory is their substrate by design.

**Scoring regimes (v0.22.0):** the direct vector routes — `vsearch` and `memory_retrieve`'s semantic/discovery modes — rank non-recency queries by RAW vector cosine. Their `structuredContent` carries `scoreBasis: "vector-cosine"`; raw cosine values are specific to the embedding model that produced them and are NOT comparable across models or to composite scores. Document metadata — including pin — participates only inside groups of exactly-equal raw scores. On these routes `minScore` filters the raw score and has NO default (omitted = no filter; an explicit `0` is honored). Recency-intent queries ("latest…", "recently…", "yesterday…") keep the composite regime with its 0.3 default floor and report `scoreBasis: "composite"`, as do `search`, `query`, `query_plan`, and `memory_retrieve`'s keyword/hybrid/causal/complex modes. `find_similar` has always ranked by raw cosine. Rationale: on the measured vault, raw cosine ranked 16/19 judged targets #1 (MRR 0.912) while the composite stack ranked 1/19 and filtered 14/19 out entirely.

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
- Causal queries ("why did we", "what caused") → intent_search with graph traversal
- Discovery queries ("similar to", "related to") → find_similar
- Complex queries (multi-topic) → query_plan
- Everything else → full hybrid search

### query

Full hybrid pipeline: BM25 + vector + query expansion + cross-encoder reranking.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `compact` | boolean | true | Compact output |
| `collection` | string | — | Filter by collection (comma-separated for multi) |
| `intent` | string | — | Domain hint for ambiguous queries (steers expansion, reranking, chunk selection) |
| `candidateLimit` | number | 30 | Candidates for reranking (tune precision vs speed) |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs |
| `vault` | string | — | Named vault |

BM25 strong-signal bypass: skips expansion when top BM25 hit >= 0.85 with gap >= 0.15 (disabled when `intent` is provided).

### search

BM25 only. Zero GPU cost. Ranking is composite (see the score-provenance note above); the underlying keyword relevance signal is the monotonic BM25 transform introduced in v0.23.0.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `minScore` | number | 0 | Composite-score floor (values shifted in v0.23.0 — the searchScore input is now a real relevance signal, not a constant) |
| `compact` | boolean | true | Compact output |
| `collection` | string | — | Filter by collection |
| `includeInternal` | boolean | false | Include system-internal `_clawmem` docs |
| `vault` | string | — | Named vault |

Score fields: compact results report the rounded **composite** score; non-compact results carry both `score` (raw BM25 transform) and `compositeScore`.

### vsearch

Vector only. Semantic similarity. Non-recency queries rank by RAW cosine (`scoreBasis: "vector-cosine"`, v0.22.0); recency-intent queries use the composite regime.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `minScore` | number | — | Raw-cosine floor on non-recency queries (no default — omitted means no filter; explicit `0` honored). Recency-intent queries keep the composite-scale 0.3 default. |
| `compact` | boolean | true | Compact output |
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
| `enable_graph_traversal` | boolean | true | Multi-hop graph expansion |
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

Trace causal decision chains from a document.

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

Pin a memory: lifecycle retention plus prioritization among relevance-equivalent results. On composite surfaces (hooks, `query`, `search`) pinned docs get the +0.3 composite boost; on the raw vector routes (v0.22.0) pin wins exact raw-score ties but never overrides a relevance difference.

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

Archive stale documents based on lifecycle policy.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `dry_run` | boolean | true | Preview only (no action) |
| `vault` | string | — | Named vault |

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

Trigger re-scan of all collections.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vault` | string | — | Named vault |

### index_stats

Detailed statistics: content type distribution, staleness, embedding coverage.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vault` | string | — | Named vault |

### build_graphs

Build temporal backbone and semantic graph.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `graph_types` | array | `["all"]` | `temporal`, `semantic`, or `all` |
| `semantic_threshold` | number | 0.7 | Similarity threshold for semantic edges |
| `vault` | string | — | Named vault |

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

Restricted-path validation rejects sensitive directories (`/etc/`, `/root/`, `.ssh`, `.env`, `credentials`, `.aws`, `.kube`).

### kg_query

Query the SPO knowledge graph for an entity's temporal relationships.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `entity` | string | required | Entity name or ID |
| `as_of` | string | — | Date filter (YYYY-MM-DD) — only facts valid at this date |
| `direction` | enum | `both` | `outgoing`, `incoming`, or `both` |
| `vault` | string | — | Named vault |

Uses entity resolution (FTS search) first, falls back to slug normalization. Returns triples with subject, predicate, object, valid_from, valid_to, confidence, and current status.

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
