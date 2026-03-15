# Troubleshooting

Common issues when running ClawMem as Claude Code memory or with an MCP server setup. Organized by subsystem.

## Embedding & GPU

**"Local model download blocked" error**
- The llama-server endpoint is unreachable while `CLAWMEM_NO_LOCAL_MODELS=true`.
- Fix: Start the llama-server instance. Or set `CLAWMEM_NO_LOCAL_MODELS=false` for in-process fallback.

**Unexpectedly slow inference (silent in-process fallback)**
- If a llama-server instance crashes or is unreachable, ClawMem silently falls back to in-process inference via `node-llama-cpp`. With GPU acceleration (Metal on Apple Silicon, Vulkan on supported hardware), the fallback is fast for these small models. On CPU-only systems (no Metal, no Vulkan), inference is significantly slower. There is no visible warning either way.
- Fix: Run GPU servers via [systemd services](guides/systemd-services.md) with `Restart=on-failure`. Or set `CLAWMEM_NO_LOCAL_MODELS=true` to fail fast instead of falling back.

**Query expansion always fails or returns garbage**
- On CPU-only systems (no Metal, no Vulkan), in-process inference is significantly slower and less reliable than a dedicated GPU server. Systems with GPU acceleration (Metal/Vulkan) handle these models well in-process.
- Fix: Run llama-server on a GPU. Even a low-end NVIDIA card handles 1.7B models.

**Vector search returns no results but BM25 works**
- Missing embeddings. The watcher indexes but does NOT embed.
- Fix: Run `clawmem embed` or wait for the daily embed timer.

**Embedding fails with "input is too large to process"**
- The `full` document fragment exceeds the model's token context (2048 tokens for EmbeddingGemma).
- This is expected for large documents — the full-doc fragment fails but section/list/code fragments succeed.
- Not a problem: vector search uses fragment-level embeddings, so the document is still searchable.

**API key + localhost warning**
- You set `CLAWMEM_EMBED_API_KEY` but `CLAWMEM_EMBED_URL` points to localhost.
- If intentional (local API gateway), ignore. Otherwise, fix the URL to point to the cloud provider.

## Search & retrieval

**context-surfacing hook returns empty**
- Prompt too short (< 20 chars), starts with `/`, or no docs score above threshold.
- Fix: Check `clawmem status` for doc counts. Check `clawmem embed` for embedding coverage.

**intent_search returns weak results for WHY/ENTITY**
- Graph may be sparse (few A-MEM edges).
- Fix: Run `build_graphs` to add temporal backbone + semantic edges.

**search returns results but query returns nothing**
- `query` applies stricter scoring (composite + MMR + expansion). If expansion LLM is down, the pipeline may return empty.
- Fix: Check GPU connectivity. Use `search` or `vsearch` as a fallback.

## Indexing

**Watcher fires events but collections show 0 docs**
- Fixed in current version. Was caused by `Bun.Glob` not supporting brace expansion `{a,b,c}`.
- If still occurring: check collection patterns in config.yaml.

**Watcher fires events but wrong collection processes them**
- Fixed in current version. Collections are now sorted by path length (most specific first).

**reindex --force crashes with "UNIQUE constraint failed"**
- Fixed in current version. Force mode now reactivates inactive rows instead of inserting.

## Hooks

**Hooks hang or timeout**
- GPU services are unreachable, causing embedding/LLM calls to hang.
- Fix: Check GPU connectivity (`curl http://host:8088/health`). Default hook timeouts (5s/10s) should prevent permanent hangs.

**Duplicate observations after every session**
- The `saveMemory()` API enforces a 30-minute normalized content hash dedup window.
- If duplicates still appear: check that the dedup window hasn't been bypassed by large time gaps or content variations.

## OpenClaw

**REST API tools return no results**
- The `clawmem serve` process may not be running. The plugin auto-starts it, but it doesn't survive plugin crashes.
- Fix: Check with `curl http://localhost:7438/health`. If unreachable, either restart OpenClaw or run `clawmem serve` as a [systemd service](guides/systemd-services.md#rest-api-service-for-openclaw) for persistence.

**Agent tools silently fail but hooks still work**
- Hooks use shell-out transport (independent of REST). Agent tools use REST. If the REST server is down, tools fail but hooks continue.
- Fix: Verify REST server: `curl http://localhost:7438/health`. Start it manually (`./bin/clawmem serve`) or via systemd.

**Plugin registers but hooks don't fire**
- Verify ClawMem is selected as the active context engine in OpenClaw config.
- If using hybrid mode, OpenClaw's native memory may be intercepting.

**OpenClaw agent doesn't use ClawMem tools**
- The 5 agent tools (search, get, session_log, timeline, similar) require the REST API. Verify it's running and accessible from the OpenClaw process.
- Check plugin config: `enableTools` must be `true` and `servePort` must match the running server port (default 7438).

## General

**"Unknown vault" error**
- The vault name isn't configured in `config.yaml` or `CLAWMEM_VAULTS`.
- Fix: Add the vault to `~/.config/clawmem/config.yaml` or set `CLAWMEM_VAULTS` env var.

**Vault path with ~ doesn't resolve**
- Fixed in current version. Vault paths now support `~` expansion.
- If using an older version, use absolute paths.

**High memory usage in long-running MCP process**
- Named vault stores are cached in memory. Each vault holds one SQLite connection.
- All stores are closed on SIGINT/SIGTERM. This is normal behavior, not a leak.
