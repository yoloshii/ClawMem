# ClawMem CLI reference

Complete command reference for the ClawMem memory engine. Always use the `bin/clawmem` wrapper, which sets GPU endpoint defaults.

## Core commands

```bash
clawmem init                    # Initialize vault (creates SQLite DB)
clawmem status                  # Quick index status
clawmem doctor                  # Full health check (GPU connectivity, index integrity)
```

## Collection management

```bash
clawmem collection add <path> --name <name>   # Add a collection
clawmem collection list                        # List all collections
clawmem collection remove <name>               # Remove a collection
```

## Indexing

```bash
clawmem update                  # Index all collections (BM25 only)
clawmem update --embed          # Index + embed in one pass
clawmem mine <dir>                             # Import conversation exports (Claude, ChatGPT, Slack)
clawmem mine <dir> -c convos                   # Import with custom collection name
clawmem mine <dir> --embed                     # Import + embed in one pass
clawmem mine <dir> --dry-run                   # Preview without importing
clawmem mine <dir> --synthesize                # v0.7.2: import + post-import LLM fact extraction
clawmem mine <dir> --synthesize --synthesis-max-docs 50   # Cap synthesis to first 50 conversations (default 20)
clawmem reindex                                # Force re-scan all collections
clawmem embed                   # Embed all un-embedded fragments
clawmem embed --force           # Re-embed everything (clears existing vectors)
```

### Conversation Import

`clawmem mine` normalizes and imports conversation exports from multiple AI chat formats:

- **Claude Code JSONL** — session transcripts (`.jsonl`)
- **Claude.ai JSON** — flat messages or privacy export with `chat_messages`
- **ChatGPT JSON** — `conversations.json` with mapping tree
- **Slack JSON** — 2-party DM exports
- **Plain text** — files with `User:`/`Assistant:` markers

Each user+assistant exchange pair becomes one indexed document with `content_type: conversation`. Files are chunked, written to a temporary staging directory, indexed through the standard pipeline (including A-MEM enrichment), then staging is cleaned up.

#### `--synthesize` (v0.7.2)

Adds a post-import LLM fact extraction pass. After `indexCollection` commits the raw conversations, the synthesis pipeline walks the freshly imported docs and extracts structured facts (`decision`, `preference`, `milestone`, `problem`) plus cross-fact relations via a two-pass LLM pipeline. Each extracted fact is saved as a first-class searchable document alongside the raw conversation exchanges. Cross-fact links bind across conversations in the same batch — not just within a single conversation.

- **Off by default.** Raw mine import semantics are byte-identical when `--synthesize` is omitted.
- **Opt-in user consent required** — each pass drives one additional LLM call per conversation doc.
- **`--synthesis-max-docs N`** caps the number of conversations scanned per run (default 20).
- **Idempotent reruns** — synthesized fact paths are hash-stable, so rerunning over the same collection updates facts in place rather than creating parallel rows. Relation weights are monotone (`MAX(weight, excluded.weight)`).
- **Non-fatal failures** — any LLM failure, JSON parse error, or relation insert error is counted and logged. Synthesis failure never rolls back the mine import.
- See [post-import conversation synthesis](../concepts/architecture.md#post-import-conversation-synthesis-v072) for the full architectural walkthrough.

## Search (CLI)

```bash
clawmem search <query>          # BM25 search
clawmem search <query> --vec    # Vector search
clawmem search <query> --hybrid # BM25 + vector (default)
```

## Bootstrap

```bash
clawmem bootstrap <path> --name <name>   # One-command setup: init + collection + index + embed + hooks + mcp
```

## Watch

```bash
clawmem watch                   # Start file watcher (indexes on .md changes)
```

## Setup

```bash
clawmem setup hooks             # Install Claude Code hooks
clawmem setup hooks --remove    # Remove installed hooks
clawmem setup mcp               # Register MCP server
clawmem setup openclaw          # Register OpenClaw ContextEngine plugin
clawmem setup curator           # Install curator agent
```

## Server

```bash
clawmem serve                            # Start REST API (localhost:7438)
clawmem serve --port 8080                # Custom port
clawmem serve --host 0.0.0.0             # Listen on all interfaces
```

## Hook execution (internal)

```bash
clawmem hook context-surfacing    # Execute a hook (reads JSON from stdin)
clawmem hook decision-extractor
clawmem hook handoff-generator
clawmem hook feedback-loop
clawmem hook precompact-extract
clawmem hook session-bootstrap
clawmem hook staleness-check
clawmem hook curator-nudge
```

## IO6 surface commands (daemon integration)

For non-hook integrations where a host process needs to inject context programmatically (e.g., daemon mode, custom orchestrators):

```bash
echo "user query" | clawmem surface --context --stdin     # Per-prompt context injection
echo "session-id" | clawmem surface --bootstrap --stdin    # Per-session bootstrap
```

## Analysis

```bash
clawmem reflect [N]             # Cross-session reflection (last N days, default 14)
clawmem consolidate [--dry-run] # Find and archive duplicate low-confidence documents
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMEM_EMBED_URL` | `http://localhost:8088` | Embedding server |
| `CLAWMEM_EMBED_API_KEY` | — | API key for cloud embedding |
| `CLAWMEM_EMBED_MODEL` | `embedding` | Model name for embedding requests |
| `CLAWMEM_EMBED_MAX_CHARS` | `6000` | Max chars per embedding input |
| `CLAWMEM_EMBED_TPM_LIMIT` | `100000` | Tokens-per-minute limit for cloud embedding pacing |
| `CLAWMEM_EMBED_DIMENSIONS` | — | Output dimensions for OpenAI `text-embedding-3-*` models |
| `CLAWMEM_LLM_URL` | `http://localhost:8089` | LLM server |
| `CLAWMEM_RERANK_URL` | `http://localhost:8090` | Reranker server |
| `CLAWMEM_NO_LOCAL_MODELS` | `false` | Block node-llama-cpp auto-downloads |
| `CLAWMEM_PROFILE` | `balanced` | Performance profile: `speed` (BM25 only), `balanced` (BM25+vector), `deep` (BM25+vector+expansion+reranking) |
| `CLAWMEM_VAULTS` | — | JSON map of vault name to SQLite path |
| `CLAWMEM_API_TOKEN` | — | Bearer token for REST API auth |
| `CLAWMEM_ENABLE_AMEM` | enabled | A-MEM note construction during indexing |
| `CLAWMEM_ENABLE_CONSOLIDATION` | disabled | Background consolidation worker (light lane, 5-min interval) |
| `CLAWMEM_CONSOLIDATION_INTERVAL` | `300000` | Light-lane worker interval in ms |
| `CLAWMEM_HEAVY_LANE` | disabled | **v0.8.0.** Enable the quiet-window heavy maintenance lane (second consolidation worker with DB-backed lease + stale-first batching + `maintenance_runs` journaling). See [heavy maintenance lane](../concepts/architecture.md#heavy-maintenance-lane-v080). |
| `CLAWMEM_HEAVY_LANE_INTERVAL` | `1800000` | **v0.8.0.** Heavy-lane tick interval in ms (default 30 min, min 30 s). |
| `CLAWMEM_HEAVY_LANE_WINDOW_START` | — | **v0.8.0.** Start hour (0-23) of the quiet window. Unset → no window. |
| `CLAWMEM_HEAVY_LANE_WINDOW_END` | — | **v0.8.0.** End hour (0-23, exclusive). Supports midnight wrap (22→6). |
| `CLAWMEM_HEAVY_LANE_MAX_USAGES` | `30` | **v0.8.0.** Max `context_usage` rows in the last 10 min before the heavy lane skips with `reason='query_rate_high'`. |
| `CLAWMEM_HEAVY_LANE_OBS_LIMIT` | `100` | **v0.8.0.** Phase 2 stale-first observation batch size for the heavy lane. |
| `CLAWMEM_HEAVY_LANE_DED_LIMIT` | `40` | **v0.8.0.** Phase 3 stale-first deductive candidate batch size for the heavy lane. |
| `CLAWMEM_HEAVY_LANE_SURPRISAL` | `false` | **v0.8.0.** When `true`, seed Phase 2 with k-NN anomaly-ranked doc ids from `computeSurprisalScores` instead of stale-first ordering. Degrades to stale-first on vaults without embeddings. |
| `INDEX_PATH` | `~/.cache/clawmem/index.sqlite` | Override default vault path |

The `bin/clawmem` wrapper sets endpoint defaults. Always use it instead of `bun run src/clawmem.ts` directly.
