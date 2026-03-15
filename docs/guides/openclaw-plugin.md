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
| `before_prompt_build` hook | Prompt-aware retrieval (context-surfacing + session-bootstrap on first turn) |
| `ContextEngine.afterTurn()` | Decision extraction, handoff generation, feedback loop (parallel) |
| `ContextEngine.compact()` | Pre-compaction state preservation (delegates real compaction to legacy engine) |
| `ContextEngine.bootstrap()` | Session bookkeeping |
| `ContextEngine.assemble()` | Pass-through (retrieval done in hook, not here) |
| Agent tools | 5 retrieval tools registered with OpenClaw via REST API: search, get, session_log, timeline, similar. The full [REST API](../reference/rest-api.md) exposes 20+ endpoints (lifecycle, graph traversal, mutations, export, etc.) accessible via HTTP but not registered as agent tools. |

### Why hybrid?

The ContextEngine interface alone can't handle all ClawMem operations:

- `assemble()` receives history and token budget but **not the current user prompt** — so it can't do prompt-aware retrieval
- `bootstrap()` can't inject context into the prompt — its return type doesn't support it

The `before_prompt_build` plugin hook solves both: it has access to the prompt and can inject context directly.

## Configuration

The plugin manifest (`src/openclaw/plugin.json`) supports:

| Option | Default | Description |
|--------|---------|-------------|
| `clawmemBin` | auto-detected | Path to `clawmem` binary |
| `tokenBudget` | 800 | Context injection budget |
| `profile` | `balanced` | Performance profile |
| `enableTools` | true | Register agent tools |
| `servePort` | 7438 | REST API port for agent tools |

## Deployment options

### Option 1: ClawMem Exclusive (recommended)

ClawMem handles 100% of memory. Disable OpenClaw's native memory:

```bash
openclaw config set agents.defaults.memorySearch.extraPaths "[]"
```

Benefits: no context waste from duplicate injection, all memory in ClawMem's hybrid search.

### Option 2: Hybrid

Run both ClawMem and OpenClaw's native memory:

```bash
openclaw config set agents.defaults.memorySearch.extraPaths '["~/documents"]'
```

Tradeoff: redundant recall from two systems, but 10-15% context window waste from duplicates.

## Dual-mode

The plugin shares the same SQLite vault as Claude Code hooks. Both runtimes read and write the same memory — decisions captured in a Claude Code session are visible to OpenClaw, and vice versa.

SQLite WAL mode + `busy_timeout=5000ms` ensures safe concurrent access across runtimes.

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
