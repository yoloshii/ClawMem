# OpenClaw ContextEngine Plugin

ClawMem integrates with OpenClaw as a native ContextEngine plugin, providing the same memory capabilities available to Claude Code.

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
| Agent tools | 5 tools via REST API: search, get, session_log, timeline, similar |

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

The REST API server is launched via `spawnBackground()` as a persistent background process, managed by the plugin's service lifecycle (started on plugin init, SIGTERM on stop).
