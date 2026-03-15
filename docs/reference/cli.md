# CLI Reference

Always use the `bin/clawmem` wrapper — it sets GPU endpoint defaults.

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
clawmem reindex                 # Force re-scan all collections
clawmem embed                   # Embed all un-embedded fragments
clawmem embed --force           # Re-embed everything (clears existing vectors)
```

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

For `--print` daemon mode (claude-serve) where CLI hooks don't work:

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
| `CLAWMEM_PROFILE` | `balanced` | Performance profile (speed/balanced/deep) |
| `CLAWMEM_VAULTS` | — | JSON map of vault name to SQLite path |
| `CLAWMEM_API_TOKEN` | — | Bearer token for REST API auth |
| `CLAWMEM_ENABLE_AMEM` | enabled | A-MEM note construction during indexing |
| `CLAWMEM_ENABLE_CONSOLIDATION` | disabled | Background consolidation worker |
| `CLAWMEM_CONSOLIDATION_INTERVAL` | `300000` | Worker interval in ms |
| `INDEX_PATH` | `~/.cache/clawmem/index.sqlite` | Override default vault path |

The `bin/clawmem` wrapper sets endpoint defaults. Always use it instead of `bun run src/clawmem.ts` directly.
