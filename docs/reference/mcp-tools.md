# MCP server tools reference

Complete reference for ClawMem's MCP server tools. These let AI agents search, retrieve, and manage persistent memory. All tools accept an optional `vault` parameter for multi-vault setups. Omit for the default vault.

## Retrieval

### memory_retrieve

**Recommended entry point.** Auto-classifies query and routes to the optimal backend.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Your question or search query |
| `mode` | enum | `auto` | Override: `keyword`, `semantic`, `causal`, `timeline`, `discovery`, `complex`, `hybrid` |
| `limit` | number | 10 | Max results |
| `compact` | boolean | true | Compact output (snippets vs full content) |
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
| `vault` | string | — | Named vault |

BM25 strong-signal bypass: skips expansion when top BM25 hit >= 0.85 with gap >= 0.15 (disabled when `intent` is provided).

### search

BM25 only. Zero GPU cost.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `compact` | boolean | true | Compact output |
| `collection` | string | — | Filter by collection |
| `vault` | string | — | Named vault |

### vsearch

Vector only. Semantic similarity.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Search query |
| `limit` | number | 10 | Max results |
| `compact` | boolean | true | Compact output |
| `collection` | string | — | Filter by collection |
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

Pin a memory for permanent prioritization (+0.3 composite boost).

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
