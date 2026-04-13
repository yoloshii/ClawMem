# OpenClaw memory plugin

ClawMem integrates with OpenClaw as a native memory plugin (`kind: memory`), giving OpenClaw agents the same persistent memory available to Claude Code. Both runtimes share a single vault, so decisions captured in one are available in the other.

> **Requires OpenClaw v2026.4.11+.** Earlier versions either silently drop the slot config (`plugins.slots.contextEngine`, openclaw/openclaw#64192, fixed in v2026.4.10) or are incompatible with the new `kind: memory` registration path (added in ClawMem v0.10.0 as part of the §14.3 pure-memory migration).

## Install

```bash
clawmem setup openclaw
```

This installs the plugin into `~/.openclaw/extensions/clawmem` by recursively copying the plugin source. Pass `--link` if you want a symlink instead (dev workflow only, see the note below). `setup openclaw --remove` uninstalls.

### Why a copy, not a symlink (v0.10.0+)

OpenClaw v2026.4.11's plugin discoverer walks `~/.openclaw/extensions/` with `readdirSync({ withFileTypes: true })` and uses `dirent.isDirectory()` to decide which entries to descend into. Symlinks to directories report `isDirectory() === false` on that API shape, so a symlinked plugin is silently skipped during discovery and never registers. ClawMem versions prior to v0.10.0 installed the plugin as a symlink, which worked on OpenClaw v2026.3.x but stopped discovering the plugin on v2026.4.11.

`clawmem setup openclaw` defaults to `cpSync(..., { recursive: true, dereference: true })` on v0.10.0+. If you prefer the old symlink behavior (for example, to edit plugin source in place and pick up changes without re-running setup), pass `--link`. The command prints a warning noting that discovery on v2026.4.11+ will skip the symlink.

### Required: `openclaw.extensions` in `package.json`

The plugin directory ships `src/openclaw/package.json` with:

```json
{
  "name": "clawmem-openclaw-plugin",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

This file is what OpenClaw's `discoverInDirectory` uses to decide whether a plugin directory is a valid plugin (the older `openclaw.plugin.json` manifest is still shipped and parsed, but it is not sufficient for discovery on v2026.4.11+). Setup verifies `package.json` is present before copying and fails loudly if it is missing.

### Multi-user gotcha (system-service deployments)

On single-user installs where OpenClaw runs as your own user account, the plugin directory owner matches the gateway user and everything works. On deployments where the OpenClaw gateway runs as a dedicated system user (e.g. `openclaw`) that is different from the user running `clawmem setup openclaw` (e.g. `sciros`), the gateway's ownership check rejects the plugin with:

```
[plugins] clawmem: blocked plugin candidate: suspicious ownership
  (/home/sciros/.openclaw/extensions/clawmem, uid=1001, expected uid=997 or root)
```

OpenClaw v2026.4.11+ enforces that plugin directories be owned by the current runtime user or root. This is a security feature to prevent a gateway running as a privileged system user from loading code a less-privileged user dropped into its extensions directory.

Fix: after running setup, chown the plugin directory to the gateway user or root.

```bash
# gateway runs as the 'openclaw' user
sudo chown -R openclaw:openclaw ~/.openclaw/extensions/clawmem

# OR: leave it root-owned (also accepted by the ownership check)
sudo chown -R root:root ~/.openclaw/extensions/clawmem
```

The same check also applies to the parent `~/.openclaw/` directory — if it is 700 (`drwx------`) and the gateway runs as a different user, the gateway cannot traverse into it to read its own config and fails with `Missing config` on startup. `chmod 750 ~/.openclaw` (owner rwx, group rx) plus the gateway user being a member of the owning group fixes this. Single-user installs are not affected.

### Idempotency

Re-running setup is safe. Setup removes any existing `~/.openclaw/extensions/clawmem` (whether it is a symlink, a directory, or a stale copy from a previous version) before writing the new copy. This makes upgrades a matter of `git pull && clawmem setup openclaw && chown -R <user>:<group> ~/.openclaw/extensions/clawmem` (the chown only matters on multi-user installs).

## Architecture

The plugin registers with OpenClaw as `kind: memory` and wires all its behavior through the plugin-hook event bus. There is no `ContextEngine` class. Every lifecycle surface the plugin needs (prompt injection, post-turn extraction, pre-compaction state capture, session bootstrap) is implemented as a handler on a `PluginHookName` event.

| Component | Role |
|-----------|------|
| `before_prompt_build` hook **(load-bearing)** | Runs on every turn. Executes prompt-aware retrieval (context-surfacing), AND runs pre-emptive `precompact-extract` synchronously when token usage approaches the compaction threshold. This is where state capture actually happens — it is awaited before the LLM call that could trigger compaction on this turn, so it cannot race the compactor. |
| `agent_end` hook | Decision extraction, handoff generation, feedback loop (parallel, fire-and-forget at OpenClaw's call site). |
| `before_compaction` hook **(defense-in-depth fallback)** | Fire-and-forget at OpenClaw's call site — races the compactor and offers no correctness guarantee on its own. Exists only to catch the rare case where `before_prompt_build` did not fire the precompact gate (e.g., the proximity heuristic missed a sudden token-count jump). Do not rely on this hook for precompact state capture — the guarantee comes from `before_prompt_build`. |
| `session_start` hook | Session registration + caches bootstrap context for first-turn injection. |
| Agent tools | 5 retrieval tools registered with OpenClaw via REST API: search, get, session_log, timeline, similar. The full [REST API](../reference/rest-api.md) exposes additional endpoints (lifecycle, graph traversal, mutations, export, etc.) accessible via HTTP but not registered as agent tools. |

### Pure-memory migration (§14.3, v0.10.0)

Versions prior to v0.10.0 registered the plugin as `kind: context-engine` and exposed a `ClawMemContextEngine` class that implemented `assemble()`, `bootstrap()`, `afterTurn()`, and `compact()`. The shape worked on OpenClaw v2026.3.x, but by v2026.4.x OpenClaw's own context-engine slot had narrowed to runtime compaction only, and a plugin occupying the slot for memory retrieval was no longer the right surface. v0.10.0 moves ClawMem to `kind: memory`, drops the `ContextEngine` class, and routes every lifecycle event through the plugin-hook bus that was already handling prompt-aware retrieval.

Nothing about the retrieval pipeline, the vault format, the hook set, or the agent tools changed. The migration is internal to the plugin adapter in `src/openclaw/`. From an agent's point of view, the output is the same `<vault-context>` block it was before.

### Memory vs context engine — the dual plugin surface

Over the last year, OpenClaw and Hermes maintainers independently converged on a two-surface plugin model for agent runtimes: one slot for **memory** plugins (durable, cross-session, retrieval-first) and one slot for **context-engine** plugins (in-session, compression/compaction-first). The roles are not interchangeable. A memory layer answers "what did we decide last week, and what facts do we know about this project." A context engine answers "the live session window is 80% full, how do I get it back to 40% without losing anything load-bearing." These are separate jobs on separate time axes, and a single plugin cannot cleanly serve both without architectural compromise.

Under this stabilized definition, ClawMem is a memory layer. The vault lives in SQLite, it persists across sessions, it runs retrieval against a full-text index plus vector embeddings plus a knowledge graph, and it feeds results into the system via `<vault-context>` injection and explicit agent tools. It does not compact transcripts, it does not summarize live turns, and it does not own a compression algorithm. v0.3.0 already delegated OpenClaw compaction to OpenClaw's own runtime compactor precisely because compaction is not ClawMem's job.

Hermes users have always plugged ClawMem in correctly. Hermes's `MemoryProvider` ABC is explicitly the memory surface, and `src/hermes/` implements it. OpenClaw users, on the other hand, were stuck occupying the context-engine slot with ClawMem because OpenClaw's pre-v2026.4.x plugin kind vocabulary did not yet expose a separate memory slot. v0.10.0 corrects that on both sides: ClawMem moves to `kind: memory`, and the context-engine slot is freed up for whatever compression or compaction plugin the user actually wants (for example, an LCM-style lossless compressor like `lossless-claw`). Both slots can be filled at the same time — they operate on different data and inject at different points.

This is not a breaking change dressed up as a refactor. It is ClawMem moving into the seat that was prepared for it. If you were previously running ClawMem as OpenClaw's context engine, you were doing the right thing for the runtime you had. The v0.10.0 + OpenClaw v2026.4.11 combination is the first moment at which a cleaner answer exists. Upgrade and you get two benefits at once: (1) ClawMem registers under the correct semantic label, and (2) your context-engine slot is free for a real context engine.

### Precompact state capture — where it actually runs

ClawMem does not own a compaction algorithm. It uses OpenClaw's built-in runtime compactor, and its only job on the compaction path is to run `precompact-extract` (which writes decisions, file paths, and open questions to auto-memory) **before** the compactor mutates the transcript.

The load-bearing surface for that extraction is `before_prompt_build`, not `before_compaction`. `before_prompt_build` runs on every turn. When token usage approaches the compaction threshold (the proximity heuristic in `src/openclaw/compaction-threshold.ts`), `before_prompt_build` awaits `precompact-extract` synchronously as part of the same hook. Because the plugin-hook bus awaits `before_prompt_build` before dispatching to the LLM, state capture completes strictly before the LLM call that could trigger compaction on this turn. No race with the compactor.

`before_compaction` is a defense-in-depth fallback only. It fires when OpenClaw's runtime is about to invoke the compactor — by that point compaction is already in motion. OpenClaw calls the hook fire-and-forget at the event site (see `pi-embedded-subscribe.handlers.compaction.ts` in the OpenClaw source), so there is no guarantee the handler finishes before the transcript is rewritten. The handler exists solely to catch the rare case where `before_prompt_build`'s proximity heuristic missed a sudden token-count jump (for example, a very large tool output arriving mid-turn), and it forces the precompact regardless of proximity since by the time it runs the threshold has clearly been exceeded.

This is also what changed between v0.3.0 and v0.10.0. v0.3.0 did the pre-emptive extraction from `ContextEngine.compact()` via `delegateCompactionToRuntime()`, which worked but was a strange shape — "run state capture, then hand off compaction" meant the extraction ran under OpenClaw's compaction entry point rather than under the caller's prompt-build path. v0.10.0 moves the extraction up the stack into `before_prompt_build`, where it has a real pre-LLM hook to await on, and demotes the compaction-entry-point handler to the fallback role. The user-visible behavior is equivalent or better: state capture now happens strictly before compaction on the normal path, not in a race with it.

ClawMem itself does not implement compaction. If you want a separate compression or compaction strategy in the same OpenClaw runtime, install a third-party context-engine plugin (for example, an LCM-style lossless compressor like `lossless-claw`) into the context-engine slot. That slot is no longer occupied by ClawMem on v0.10.0+.

## Configuration

The plugin manifest (`src/openclaw/openclaw.plugin.json`) supports:

| Option | Default | Description |
|--------|---------|-------------|
| `clawmemBin` | auto-detected | Path to `clawmem` binary |
| `tokenBudget` | 800 | Context injection budget |
| `profile` | `balanced` | Performance profile |
| `enableTools` | true | Register agent tools |
| `servePort` | 7438 | REST API port for agent tools |

## Coexistence with OpenClaw Active Memory

OpenClaw v2026.4.10 introduced [Active Memory](https://docs.openclaw.ai/concepts/active-memory), an optional plugin that runs a blocking memory sub-agent before each reply, searching OpenClaw's native memory (dreaming, wiki, memory palace).

**ClawMem and Active Memory are fully compatible.** They operate on different integration surfaces:

| Dimension | ClawMem | Active Memory |
|-----------|---------|---------------|
| Plugin kind | `memory` (v0.10.0+) | standard plugin |
| Injection target | User prompt (`prependContext`) | System prompt (`appendSystemContext`) |
| Memory backend | ClawMem SQLite vault | OpenClaw native dreaming/wiki |
| Latency | ~200-500ms (CLI hook) | 3-15s (LLM sub-agent) |

Both can run simultaneously. Active Memory handles casual personal recall ("what's my favorite food") while ClawMem handles deep project context (decisions, architecture, cross-session chains). There is no conflict or duplicate injection between them because they search different backends and inject into different prompt regions.

**No configuration changes needed.** If Active Memory is enabled, ClawMem continues working as before. The deployment options below control ClawMem's relationship with OpenClaw's *native memory search* (`memorySearch.extraPaths`), which is separate from Active Memory.

### OpenClaw version note

**OpenClaw v2026.4.11+ recommended (required for ClawMem v0.10.0+).**

Two separate OpenClaw changes interact with how ClawMem is configured and discovered:

- **v2026.4.10** fixed a config normalization bug (#64192) where `plugins.slots.contextEngine` was silently dropped during config processing. If you are on an older pre-v0.10.0 ClawMem that still uses the `context-engine` slot, v2026.4.10+ is needed for reliable slot activation.
- **v2026.4.11** tightened the plugin discovery path (`readdirSync({ withFileTypes: true })` + `dirent.isDirectory()`) and the plugin ownership check (`uid == current user || uid == 0`). Both are load-bearing for ClawMem v0.10.0+, which ships with the new `package.json`-based discovery contract and defaults to a copied (not symlinked) extensions directory. See the Install section above for the multi-user ownership gotcha.

ClawMem v0.10.0 uses the `memory` slot (`plugins.slots.memory: "clawmem"`), not the older `contextEngine` slot. The slot is set automatically by the `openclaw plugins enable clawmem` step in the setup next-steps output — you do not need to set it by hand via `openclaw config set`. On v2026.4.11+, `openclaw plugins enable clawmem` also disables any competing `memory`-slot plugin (e.g. `memory-core`, `memory-lancedb`) in the same command.

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

After setup (and the chown step on multi-user installs), check all components:

```bash
# Plugin registered
openclaw plugins list | grep clawmem
openclaw plugins inspect clawmem   # should show Kind: memory, Status: enabled

# Gateway log should include clawmem in the ready line, for example:
#   [gateway] ready (7 plugins: acpx, browser, clawmem, device-pair, phone-control, talk-voice, telegram; ...)
# AND the per-plugin registration line:
#   [plugins] clawmem: plugin registered (kind=memory, bin=..., profile=balanced, budget=800)
#   [plugins] clawmem: registered 5 agent tools
journalctl -u openclaw-gateway.service -n 50 --no-pager | grep -E "(ready|\bclawmem\b)"

# REST API responding
curl http://localhost:7438/health

# Hooks working (check vault for recent context)
clawmem status

# Watcher active
systemctl --user status clawmem-watcher.service

# Embed timer scheduled
systemctl --user status clawmem-embed.timer
```

If `openclaw plugins inspect clawmem` reports `blocked plugin candidate: suspicious ownership` or the gateway ready line omits `clawmem` while the journal shows the same `suspicious ownership` warning, re-apply the chown step from the Install section. If the gateway fails to start at all with `Missing config. Run openclaw setup or set gateway.mode=local`, the traversal perms on `~/.openclaw/` are locking the gateway user out of its own config directory (`chmod 750 ~/.openclaw` and confirm the gateway's system group is the owning group).
