# OpenClaw ContextEngine plugin

ClawMem integrates with OpenClaw as a native ContextEngine plugin, giving OpenClaw agents the same persistent memory available to Claude Code. Both runtimes share a single vault, so decisions captured in one are available in the other.

## Install

```bash
./bin/clawmem setup openclaw
```

This registers ClawMem as a context engine plugin with OpenClaw.

## Architecture

The plugin uses a hybrid approach — ContextEngine methods for lifecycle management and plugin hooks for prompt-aware retrieval:

| Component | Role |
|-----------|------|
| `before_prompt_build` hook | Prompt-aware retrieval (context-surfacing every turn + cached bootstrap context on first turn) |
| `ContextEngine.afterTurn()` | Decision extraction, handoff generation, feedback loop (parallel) |
| `ContextEngine.compact()` | Pre-compaction state preservation, then delegates to OpenClaw runtime compactor |
| `ContextEngine.bootstrap()` | Session registration + caches bootstrap context for first-turn injection |
| `ContextEngine.assemble()` | Pass-through (retrieval done in hook, not here) |
| Agent tools | 5 retrieval tools registered with OpenClaw via REST API: search, get, session_log, timeline, similar. The full [REST API](../reference/rest-api.md) exposes additional endpoints (lifecycle, graph traversal, mutations, export, etc.) accessible via HTTP but not registered as agent tools. |

### Why hybrid?

The ContextEngine interface alone can't handle all ClawMem operations:

- `assemble()` now receives `prompt` and `model` (since OpenClaw v2026.3.22) and `availableTools` and `citationsMode` (since v2026.4.7), but retrieval remains in the `before_prompt_build` hook by design. `assemble().systemPromptAddition` prepends to the system prompt, while `prependContext` prepends to the user prompt — different model semantics. Additionally, `systemPromptAddition` can be clobbered by other plugins returning `systemPrompt` from hooks. The hybrid approach is architecturally correct, not a workaround.
- `bootstrap()` can't inject context into the prompt — its return type doesn't support it. ClawMem caches bootstrap output and injects it via the prompt hook on the first turn.

The `before_prompt_build` plugin hook provides access to the prompt and can inject context directly.

### Compaction delegation (v0.3.0+)

ClawMem does not own a compaction algorithm — it uses OpenClaw's built-in runtime compactor. The `compact()` method:
1. Runs `precompact-extract` to preserve state (decisions, file paths, open questions)
2. Delegates actual compaction to OpenClaw via `delegateCompactionToRuntime()` from `openclaw/plugin-sdk/core`

This is required since OpenClaw v2026.3.28 — returning `compacted: false` with `ownsCompaction: false` no longer triggers implicit legacy compaction fallback.

## Configuration

The plugin manifest (`src/openclaw/plugin.json`) supports:

| Option | Default | Description |
|--------|---------|-------------|
| `clawmemBin` | auto-detected | Path to `clawmem` binary |
| `tokenBudget` | 800 | Context injection budget |
| `profile` | `balanced` | Performance profile |
| `enableTools` | true | Register agent tools |
| `servePort` | 7438 | REST API port for agent tools |

## Coexistence with OpenClaw Active Memory

OpenClaw v2026.4.10 introduced [Active Memory](https://docs.openclaw.ai/concepts/active-memory) — an optional plugin that runs a blocking memory sub-agent before each reply, searching OpenClaw's native memory (dreaming, wiki, memory palace).

**ClawMem and Active Memory are fully compatible.** They operate on different integration surfaces:

| Dimension | ClawMem | Active Memory |
|-----------|---------|---------------|
| Plugin kind | `context-engine` | standard plugin |
| Injection target | User prompt (`prependContext`) | System prompt (`appendSystemContext`) |
| Memory backend | ClawMem SQLite vault | OpenClaw native dreaming/wiki |
| Latency | ~200-500ms (CLI hook) | 3-15s (LLM sub-agent) |

Both can run simultaneously — Active Memory handles casual personal recall ("what's my favorite food") while ClawMem handles deep project context (decisions, architecture, cross-session chains). There is no conflict or duplicate injection between them because they search different backends and inject into different prompt regions.

**No configuration changes needed.** If Active Memory is enabled, ClawMem continues working as before. The deployment options below control ClawMem's relationship with OpenClaw's *native memory search* (`memorySearch.extraPaths`), which is separate from Active Memory.

### OpenClaw version note

OpenClaw v2026.4.10 also fixed a config normalization bug (#64192) where `plugins.slots.contextEngine` was silently dropped during config processing. If you configure ClawMem via the context engine slot (`plugins.slots.contextEngine: "clawmem"`), upgrade to OpenClaw v2026.4.10+ to ensure reliable plugin activation. Earlier versions still activate ClawMem via explicit `plugins.entries.clawmem.enabled: true`, but the slot path is more robust.

## Deployment options

### Option 1: ClawMem Exclusive (recommended)

ClawMem handles 100% of structured memory. Disable OpenClaw's native memory search to avoid duplicate injection from `memorySearch.extraPaths`:

```bash
openclaw config set agents.defaults.memorySearch.extraPaths "[]"
```

Benefits: no context waste from duplicate injection, all memory in ClawMem's hybrid search.

This does NOT disable Active Memory (which is a separate plugin). If you want both ClawMem and Active Memory, leave Active Memory enabled — they complement each other.

### Option 2: Hybrid

Run both ClawMem and OpenClaw's native memory search:

```bash
openclaw config set agents.defaults.memorySearch.extraPaths '["~/documents"]'
```

Tradeoff: redundant recall from two systems, but 10-15% context window waste from duplicates.

## Shared vault across frameworks

Claude Code and OpenClaw access the same SQLite vault file (`~/.cache/clawmem/index.sqlite` by default). Both runtimes read and write the same memory — decisions captured in a Claude Code session are visible to OpenClaw agents, and vice versa.

### How it works

Both frameworks resolve the vault path from the same config file (`~/.config/clawmem/config.yaml`). Claude Code hooks invoke `bin/clawmem hook <name>` which opens the vault. The OpenClaw plugin spawns the same binary via shell-out. Since they share a filesystem, they share the vault.

SQLite WAL mode allows concurrent readers with a single writer. `busy_timeout=5000ms` on all connections prevents "database is locked" errors when both frameworks access the vault simultaneously.

### Same-machine requirement

By default, both frameworks must run on the same machine (or share the same filesystem mount) because they both open the SQLite file directly. SQLite does not support network-based concurrent access.

### Remote access options

For cross-machine setups where one runtime is on a different host:

| Method | How | Latency | Full feature set |
|--------|-----|---------|-----------------|
| **REST API** | Run `clawmem serve --port 7438` on the vault host. Remote agents call HTTP endpoints. | ~5-20ms per call | Search, retrieval, lifecycle, graph traversal. No hooks (hooks are local-only). |
| **MCP over SSE** | Run the MCP server as an SSE transport instead of stdio. Configure the remote MCP client (Claude Code, OpenClaw, etc.) to connect via SSE URL. | ~5-20ms per call | All 31 MCP tools. No hooks. |

In both cases, hooks (context-surfacing, decision-extractor, etc.) only run on the machine where the vault lives. Remote agents get tool access but not automatic context injection.

To add hooks on the remote machine, run a second ClawMem instance with its own local vault and use `clawmem serve` on the primary host for cross-machine queries.

## Shell-out transport

The plugin spawns `clawmem hook <name>` as Bun subprocesses (Phase 1 transport). This avoids importing Bun-specific modules into the Node.js OpenClaw runtime. Each hook receives JSON on stdin and returns JSON on stdout.

## REST API dependency

The 5 agent tools (search, get, session_log, timeline, similar) are served via ClawMem's HTTP REST API. The plugin manages this in one of two ways:

**Auto-managed (default):** The plugin launches `clawmem serve` via `spawnBackground()` on init and sends SIGTERM on stop. This works for development but the process may not survive plugin crashes or OpenClaw restarts.

**Systemd-managed (recommended for production):** Run `clawmem serve` as a persistent systemd service. The plugin connects to the existing server. See the [REST API reference](../reference/rest-api.md#running-as-a-systemd-service) for the service unit.

If the REST API is unreachable, agent tools fail silently — the agent won't get search results but hooks (context-surfacing, decision-extractor, etc.) continue working since they use shell-out transport, not REST.

## What needs to be running

For full OpenClaw integration, these services must be active:

| Service | Purpose | Managed by |
|---------|---------|------------|
| `clawmem serve` | REST API for agent tools | Plugin auto-start or [systemd](../reference/rest-api.md#running-as-a-systemd-service) |
| `clawmem-watcher` | Auto-index on file changes | [systemd](systemd-services.md#watcher-service) |
| `clawmem-embed.timer` | Daily embedding sweep | [systemd](systemd-services.md#embed-timer) |
| GPU servers (optional) | Embedding, LLM, reranker | [systemd](systemd-services.md#gpu-service-units) or in-process fallback |

The **curator agent** (`clawmem setup curator`) handles periodic maintenance — lifecycle triage, retrieval health checks, graph rebuilds. It runs on-demand, not as a service. Invoke via "curate memory" or "run curator" in a Claude Code session.

## Verify

After setup, check all components:

```bash
# Plugin registered
openclaw plugins list | grep clawmem

# REST API responding
curl http://localhost:7438/health

# Hooks working (check vault for recent context)
clawmem status

# Watcher active
systemctl --user status clawmem-watcher.service

# Embed timer scheduled
systemctl --user status clawmem-embed.timer
```
