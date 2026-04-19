# Hermes Agent MemoryProvider plugin

ClawMem integrates with Hermes Agent as a native MemoryProvider plugin, giving Hermes agents the same persistent memory available to Claude Code and OpenClaw. All three runtimes share a single vault, so decisions captured in one are available in the others.

## Install

Hermes scans two directories for memory provider plugins (since Hermes #10529, in v2026.4.13+):

1. **User plugins** at `$HERMES_HOME/plugins/<name>/` — typically `~/.hermes/plugins/<name>/`. **Preferred.** Survives `git pull` of hermes-agent and avoids the dual-registration trap that previously caused duplicate tool names with strict providers.
2. **Bundled plugins** at `hermes-agent/plugins/memory/<name>/` — always supported. Bundled-first precedence on name collisions.

```bash
# Preferred — user-plugin path
cp -r /path/to/ClawMem/src/hermes ${HERMES_HOME:-~/.hermes}/plugins/clawmem

# Or symlink for development (either path)
ln -s /path/to/ClawMem/src/hermes ${HERMES_HOME:-~/.hermes}/plugins/clawmem

# Bundled-style — only when working in the hermes-agent source tree
cp -r /path/to/ClawMem/src/hermes /path/to/hermes-agent/plugins/memory/clawmem
```

Discovery is heuristic — Hermes looks for `register_memory_provider` or `MemoryProvider` substrings in `__init__.py`. Both are present in `src/hermes/__init__.py`, so the plugin is discovered correctly under either path.

Verify discovery:
```bash
hermes memory list   # Should show "clawmem" as available
```

## Architecture

The plugin uses shell-out for lifecycle hooks and REST API for interactive tools:

| Component | Transport | Role |
|-----------|-----------|------|
| `initialize()` | Shell-out | Create transcript, run `session-bootstrap`, cache bootstrap context |
| `prefetch()` / `queue_prefetch()` | Shell-out | Prompt-aware retrieval via `context-surfacing` hook (automatic every turn) |
| `sync_turn()` | Local file I/O | Append user+assistant to plugin-managed transcript JSONL |
| `on_session_end()` | Shell-out | `decision-extractor`, `handoff-generator`, `feedback-loop` in parallel |
| `on_pre_compress()` | Shell-out | `precompact-extract` for state preservation |
| `system_prompt_block()` | In-process | Static provider info and tool names |
| Agent tools (5) | REST API | `clawmem_retrieve`, `clawmem_get`, `clawmem_session_log`, `clawmem_timeline`, `clawmem_similar` |

### Why shell-out for hooks?

ClawMem's lifecycle hooks (context-surfacing, decision-extractor, etc.) are Bun/TypeScript programs that read a transcript JSONL file and interact with the SQLite vault directly. The Python plugin shells out to the `clawmem` binary to invoke them, avoiding a cross-language library dependency. This is the same pattern used by the OpenClaw plugin.

### Why REST for tools?

Interactive tool calls need structured JSON responses and benefit from the REST server's connection pooling. The `clawmem serve` process stays warm, so tool calls complete in milliseconds.

### Plugin-managed transcript

Hermes passes turn data via `sync_turn(user_content, assistant_content)`, but ClawMem hooks expect a `.jsonl` transcript file. The plugin bridges this by maintaining its own transcript at `$HERMES_HOME/clawmem-transcripts/<session_id>.jsonl`, appending each turn in Claude Code transcript format (`{"type":"message","message":{"role":"...","content":"..."}}`).

## Configuration

Set in your Hermes profile's `.env` or shell environment:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMEM_BIN` | auto-detect on PATH | Path to `clawmem` binary |
| `CLAWMEM_SERVE_PORT` | `7438` | REST API port |
| `CLAWMEM_SERVE_MODE` | `external` | `external` (you run `clawmem serve`) or `managed` (plugin starts/stops it) |
| `CLAWMEM_PROFILE` | `balanced` | Retrieval profile: `speed` (BM25 only), `balanced` (hybrid), `deep` (full pipeline) |
| `CLAWMEM_EMBED_URL` | — | GPU embedding server URL (e.g., `http://localhost:8088`) |
| `CLAWMEM_LLM_URL` | — | GPU LLM server URL (e.g., `http://localhost:8089`) |
| `CLAWMEM_RERANK_URL` | — | GPU reranker server URL (e.g., `http://localhost:8090`) |
| `CLAWMEM_API_TOKEN` | — | Bearer token for REST API auth (optional, must match `clawmem serve` config) |

Or configure interactively:
```bash
hermes memory setup   # Walks through provider configuration
```

## Server modes

### External (recommended for production)

You manage `clawmem serve` yourself, either as a systemd service or a background process:

```bash
clawmem serve --port 7438 &
# or via systemd — see docs/guides/systemd-services.md
```

The plugin connects to the existing server. If the server is unreachable, tools fail gracefully but hooks still work (shell-out transport).

### Managed

The plugin starts `clawmem serve` during `initialize()` and stops it on `shutdown()`. Includes a readiness probe (5s health check loop) and early-exit detection.

```bash
export CLAWMEM_SERVE_MODE=managed
```

Suitable for development. Not recommended for production — the process doesn't survive plugin crashes or Hermes restarts.

## Agent-context isolation

Hermes's `run_agent.py` passes an `agent_context` kwarg to every `MemoryProvider.initialize()` call with one of four values: `"primary"`, `"subagent"`, `"cron"`, or `"flush"`. The `MemoryProvider` ABC docstring is explicit about why this matters: *"Providers should skip writes for non-primary contexts (cron system prompts would corrupt user representations)."*

The plugin honours this contract by gating only the **write-side** surfaces — read-side hooks always run so non-primary agents still benefit from retrieval:

| Surface | Direction | `agent_context != "primary"` behaviour |
|---|---|---|
| `session-bootstrap` (in `initialize`) | Read | Runs — context still surfaced |
| `prefetch()` / `queue_prefetch()` (`context-surfacing`) | Read | Runs — context still surfaced |
| `system_prompt_block()` | Read | Runs — provider info still injected |
| Agent tools (REST) | Read | Runs — agents can still call `clawmem_retrieve` etc. |
| `sync_turn()` (transcript append) | Write | **Suppressed** |
| `on_session_end()` (extraction) | Write | **Suppressed** |
| `on_pre_compress()` (precompact) | Write | **Suppressed** |

Net effect: subagents, cron jobs, and flush passes get the benefit of vault recall without contaminating the vault with intermediate state or system-prompt reasoning. The `initialize()` log line records the active context for operator visibility:

```
clawmem: agent_context=cron — reads enabled, writes suppressed
```

## Hermes built-in memory coexistence

Hermes always runs its built-in memory provider (MEMORY.md / USER.md) alongside the external provider. ClawMem is additive — it does not replace or disable built-in memory. Both inject into the context independently.

This means some duplication is possible (built-in memory captures a fact, ClawMem extracts the same fact from the transcript). In practice the overlap is minimal because:
- Built-in memory captures explicit `add_to_memory` tool calls
- ClawMem captures implicit decisions, handoffs, and patterns from conversation flow
- Different storage formats (markdown files vs SQLite vault) serve different retrieval strategies

`on_memory_write()` is intentionally a no-op in v1 to avoid amplifying duplication.

## Shared vault across frameworks

Claude Code, OpenClaw, and Hermes all access the same SQLite vault file (`~/.cache/clawmem/index.sqlite` by default). A decision captured in a Claude Code session is visible to Hermes agents, and vice versa.

SQLite WAL mode + `busy_timeout=5000ms` handles concurrent access. The plugin-managed transcript is stored separately under `$HERMES_HOME/clawmem-transcripts/` and does not affect the shared vault.

## What needs to be running

| Service | Purpose | Managed by |
|---------|---------|------------|
| `clawmem serve` | REST API for agent tools | External (systemd) or managed (plugin) |
| `clawmem-watcher` | Auto-index on file changes | [systemd](systemd-services.md#watcher-service) |
| `clawmem-embed.timer` | Daily embedding sweep | [systemd](systemd-services.md#embed-timer) |
| GPU servers (optional) | Embedding, LLM, reranker | [systemd](systemd-services.md#gpu-service-units) or in-process fallback |

## Verify

```bash
# Plugin discovered
hermes memory list | grep clawmem

# REST API responding
curl http://localhost:7438/health

# Hooks working
clawmem status

# Watcher active
systemctl --user status clawmem-watcher.service
```

## Lifecycle mapping reference

| Hermes MemoryProvider | ClawMem equivalent | Notes |
|---|---|---|
| `is_available()` | PATH check for `clawmem` binary | No network calls |
| `initialize(session_id, **kwargs)` | `session-bootstrap` hook | Creates transcript, caches bootstrap context. Reads `agent_context` and `hermes_home` from kwargs. Other kwargs Hermes passes (`platform`, `agent_identity`, `agent_workspace`, `parent_session_id`, `user_id`, `gateway_session_key`, `session_title`) are absorbed via `**kwargs` and currently unused. |
| `system_prompt_block()` | Static text | Provider active, tool names |
| `prefetch(query)` | `context-surfacing` hook output | Returns cached result from background thread |
| `queue_prefetch(query)` | `context-surfacing` hook | Background thread, generation-safe |
| `sync_turn(user, assistant)` | Transcript JSONL append | Bridges Hermes turn pairs to ClawMem file format. Suppressed when `agent_context != "primary"`. |
| `on_turn_start()` | — | Not overridden — base no-op |
| `on_session_end(messages)` | `decision-extractor` + `handoff-generator` + `feedback-loop` | Parallel, 30s timeout each. Suppressed when `agent_context != "primary"`. |
| `on_pre_compress(messages)` | `precompact-extract` | Side effect only (Hermes ignores return). Suppressed when `agent_context != "primary"`. |
| `on_memory_write()` | No-op | Avoids duplication with built-in memory (filesystem watcher already indexes MEMORY.md / USER.md if they live under a configured collection). |
| `on_delegation()` | No-op | Subagent observation handled at the parent's primary context already; nothing useful to add here. |
| `get_tool_schemas()` | 5 REST-backed tools | retrieve, get, session_log, timeline, similar |
| `handle_tool_call()` | REST API dispatch | Bearer auth when `CLAWMEM_API_TOKEN` is set |
| `shutdown()` | Thread cleanup + managed serve stop | Joins prefetch thread, terminates managed process |
