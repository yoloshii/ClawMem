# Troubleshooting

Common issues when running ClawMem with hooks, MCP server, or OpenClaw plugin. Organized by subsystem.

## Bun runtime

**Snap Bun: EPERM on stdin (hooks return empty)**
- On Linux, Bun installed via snap (`/snap/bin/bun`) cannot read stdin due to snap's confinement sandbox. Hooks receive no prompt input and silently return empty context.
- Fix: Install Bun via the official installer (`curl -fsSL https://bun.sh/install | bash`) which places it at `~/.bun/bin/bun`. The `bin/clawmem` wrapper prefers `~/.bun/bin/bun` over the system bun for this reason. If hooks return empty on a snap-based system, verify `~/.bun/bin/bun` exists and is executable.

**Two Bun binaries on PATH**
- If both snap bun (`/snap/bin/bun`) and native bun (`~/.bun/bin/bun`) are installed, `which bun` may return the snap version. Direct `bun -e` or `bun run` commands will use the wrong binary.
- Fix: The `bin/clawmem` wrapper handles this automatically. For manual commands, use `~/.bun/bin/bun` explicitly or add `~/.bun/bin` to PATH before `/snap/bin`.

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

**Vector search: "Dimension mismatch" error**
- The vault was embedded with one model (e.g., zembed-1 at 2560d) but the query is being embedded with a different model (e.g., EmbeddingGemma at 768d). This happens when the GPU embedding server is unreachable and `node-llama-cpp` falls back to the default model, which has different dimensions.
- Fix: Ensure the embedding server is running (`curl http://host:8088/health`). Or set `CLAWMEM_NO_LOCAL_MODELS=true` to fail fast instead of falling back to a mismatched model. If you switched models, re-embed the vault with `clawmem embed --force`.

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

**"UserPromptSubmit hook error" (intermittent)**
- SQLite contention between the watcher and the context-surfacing hook. During active conversations, Claude Code writes rapidly to session transcript `.jsonl` files. Prior to v0.1.6, the watcher processed all `.jsonl` file changes (not just Beads `.beads/*.jsonl`), triggering database opens and brief write locks on every transcript update. If the context-surfacing hook fired during a lock, it exceeded its timeout.
- Fixed in v0.1.6: The watcher now only processes `.jsonl` files within `.beads/` directories (Dolt backend). Claude Code transcript `.jsonl` files are ignored entirely, eliminating the main source of lock contention and memory bloat.
- If you still see this error on v0.1.6+: restart the watcher to clear accumulated state (`systemctl --user restart clawmem-watcher.service`). If it persists, check `systemctl --user status clawmem-watcher.service` for memory usage — healthy is under 100MB, bloated is 400MB+.

**Watcher memory bloat (400MB+)**
- The watcher accumulates memory when processing high-frequency file change events. The most common trigger was Claude Code session transcript `.jsonl` files changing on every keystroke during active conversations. Each event opened the database briefly, and over hours of active use, memory grew to 400-800MB.
- Fixed in v0.1.6: transcript `.jsonl` files are no longer watched. Memory stays under 100MB during normal operation.
- If memory still grows: check which files are triggering events (`journalctl --user -u clawmem-watcher -f`). Common remaining causes:

**Diagnosing watcher memory issues:**

1. **Identify what's triggering events.** Watch the journal in real time:
   ```bash
   journalctl --user -u clawmem-watcher -f
   ```
   Each `[change]` or `[rename]` line shows the collection and file. High-frequency entries point to the source.

2. **Broad collection paths with narrow patterns.** If a collection has a broad path (e.g. `path: ~/Projects`) but a narrow pattern (e.g. `pattern: "specific-file.md"`), the watcher receives `fs.watch` events for every `.md` change under that entire tree — even files that don't match the pattern. Prior to v0.1.7, each event still triggered `indexCollection()` and opened the database.
   - Fixed in v0.1.7: the watcher pre-checks if the changed file could match the collection pattern before calling `indexCollection()`. Non-matching files are silently skipped with no DB access.
   - If you're on an older version: narrow the collection path to the smallest directory that contains the files you actually want indexed.

3. **Git operations in watched directories.** `git pull`, `git checkout`, or `git merge` in a directory covered by a `**/*.md` collection can change hundreds of `.md` files at once. Each triggers a watcher event, and even with debouncing (2s), batches of changes arrive in rapid succession.
   - Not a bug — the watcher is doing its job (re-indexing changed docs). But if this causes contention with hooks, restart the watcher afterward: `systemctl --user restart clawmem-watcher.service`.

4. **Editor autosave and temp files.** Some editors (VS Code, JetBrains) write `.md~`, `.md.tmp`, or shadow copies during autosave. These don't match the `.md` extension check in the watcher, but frequent filesystem churn in the same directory can cause `fs.watch` callback overhead on some platforms (especially WSL2 where filesystem events cross the Linux/Windows boundary).
   - Fix: If memory grows without visible `[change]` log entries, the overhead is in `fs.watch` itself, not in ClawMem's handler. Consider reducing the number of watched directories by consolidating collections or excluding directories with heavy non-`.md` file churn.

5. **Too many watched directories.** Each collection path gets its own recursive `fs.watch`. If you have 15+ collections, that's 15+ recursive watchers. On large directory trees, each watcher consumes memory for inotify handles (Linux) or FSEvents streams (macOS).
   - Check watcher count: `cat /proc/sys/fs/inotify/max_user_watches` (Linux default: 8192). If the watcher reports `ENOSPC` errors, increase: `echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches`.
   - macOS: FSEvents has no hard limit but memory scales with watched directory depth.

6. **Healthy baseline.** After a fresh restart, the watcher should stabilize under 100MB within 30 seconds. If it immediately spikes above 200MB during startup, check `journalctl --user -u clawmem-watcher` for rapid-fire events during initialization (common when collections contain recently-changed files that trigger immediate indexing).

**Quick recovery:** `systemctl --user restart clawmem-watcher.service` — clears accumulated state, resets memory. Safe to do at any time; the watcher re-discovers its watch targets on startup.

**Hooks hang or timeout**
- GPU services are unreachable, causing embedding/LLM calls to block until the timeout wrapper kills the process.
- Fix: Check GPU connectivity (`curl http://host:8088/health`). Hook timeouts are 8s for context-surfacing, 5s for SessionStart/PreCompact hooks, 10s for Stop hooks. See [setup-hooks](guides/setup-hooks.md) for the full table.

**Hook fires but returns empty context**
- The context-surfacing hook filters aggressively. Common causes:
  - Prompt too short (< 20 chars), starts with `/`, or matches the heartbeat/greeting filter
  - Duplicate prompt within the 600-second dedup window (SHA-256 hash match)
  - Vector search silently failed (dimension mismatch, server down) and BM25-only results scored too low after composite scoring
  - All results fell below the profile's minimum composite score threshold after recency decay, confidence weighting, and quality multiplier were applied
- Fix: Check `clawmem status` for doc counts and `clawmem embed` for embedding coverage. Verify the embedding server is reachable if using a remote GPU. Try `CLAWMEM_PROFILE=deep` which lowers the score threshold from 0.45 to 0.25 and adds budget-aware query expansion + reranking. For vaults with older documents, the `balanced` profile's 0.45 threshold may filter out everything — `deep` compensates with a wider net.

**Context-surfacing returns results on `balanced` but not `speed`**
- `speed` profile disables vector search entirely and uses a higher minimum score (0.55). Documents that rank well via hybrid search (BM25+vector) may not score high enough on BM25 alone.
- Not a bug — this is the intended tradeoff. Use `balanced` or `deep` for richer retrieval.

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
