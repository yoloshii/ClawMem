# Hermes Agent MemoryProvider plugin

ClawMem integrates with Hermes Agent as a native MemoryProvider plugin, giving Hermes agents the same persistent memory available to Claude Code and OpenClaw. All three runtimes share a single vault, so decisions captured in one are available in the others.

## Install

Hermes scans two directories for memory provider plugins (since Hermes #10529, in v2026.4.13+):

1. **User plugins** at `$HERMES_HOME/plugins/<name>/` — typically `~/.hermes/plugins/<name>/`. **Preferred.** Survives `git pull` of hermes-agent and avoids the dual-registration trap that previously caused duplicate tool names with strict providers.
2. **Bundled plugins** at `hermes-agent/plugins/memory/<name>/` — always supported. Bundled-first precedence on name collisions.

```bash
# Preferred — user-plugin path. Copies the directory's CONTENTS, so the same command installs and upgrades
# (`cp -r src/hermes <existing dir>` would nest a hermes/ inside it and leave the old plugin running).
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins/clawmem"
cp -r /path/to/ClawMem/src/hermes/. "${HERMES_HOME:-$HOME/.hermes}/plugins/clawmem/"

# Or symlink for development (either path; an upgrade then needs no copy)
ln -s /path/to/ClawMem/src/hermes "${HERMES_HOME:-$HOME/.hermes}/plugins/clawmem"

# Bundled-style — only when working in the hermes-agent source tree
mkdir -p /path/to/hermes-agent/plugins/memory/clawmem
cp -r /path/to/ClawMem/src/hermes/. /path/to/hermes-agent/plugins/memory/clawmem/
```

Discovery is heuristic — Hermes looks for `register_memory_provider` or `MemoryProvider` substrings in `__init__.py`. Both are present in `src/hermes/__init__.py`, so the plugin is discovered correctly under either path.

Activate via `memory.provider: clawmem` in `~/.hermes/config.yaml` (or run `hermes memory setup` and pick `clawmem`). Memory providers are an exclusive category — exactly one is active at a time, selected via `memory.provider`, completely separate from the general plugin loader.

> **Do NOT add `clawmem` to `plugins.enabled` in `config.yaml`.** That list is the general-plugin opt-in roster (Hermes #11xxx onwards made all general plugins opt-in by default). Memory providers have their own activation channel via `memory.provider` and the general loader explicitly skips bundled `plugins/memory/` and treats user-installed memory providers as separate from the standalone-plugin gate. Adding `clawmem` to `plugins.enabled` would make the general loader try to import it as a `kind: standalone` plugin and call `register(ctx)` against the general `PluginContext` — which doesn't expose `register_memory_provider`, so the import errors and the warning gets logged. Harmless but noisy.

Verify discovery:
```bash
hermes memory list   # Should show "clawmem" as available
```

## Architecture

The plugin uses shell-out for lifecycle hooks and REST API for interactive tools:

| Component | Transport | Role |
|-----------|-----------|------|
| `initialize()` | Shell-out | Claim the transcript (a primary context: open and lock it), run `session-bootstrap`, cache bootstrap context |
| `prefetch()` / `queue_prefetch()` | Shell-out | Prompt-aware retrieval via `context-surfacing` hook (automatic every turn) |
| `sync_turn()` | Local file I/O + shell-out | Append user+assistant to plugin-managed transcript JSONL, then queue a Stop pass: `decision-extractor`, `handoff-generator`, `feedback-loop` in parallel, in the background (v0.41.0) |
| `on_session_end()` | Shell-out | This transcript's final Stop pass, then `handoff-generator`'s SessionEnd flush, then a last `feedback-loop` run |
| `on_pre_compress()` | Shell-out | `precompact-extract` for state preservation |
| `system_prompt_block()` | In-process | Static provider info and tool names |
| Agent tools (5) | REST API | `clawmem_retrieve`, `clawmem_get`, `clawmem_session_log`, `clawmem_timeline`, `clawmem_similar` |

### The stop pipeline on Hermes (v0.41.0)

Since v0.41.0 `decision-extractor` and `handoff-generator` keep a cursor per transcript and process only the turns they have not processed, and `feedback-loop` decides each surfaced turn once. The plugin therefore runs the three after every synced turn, as Claude Code runs them after every response. A plugin copied from an earlier version runs them only at session end, which under v0.41.0 keeps a session's last turn only and writes no handoff: **copy the plugin again when you upgrade** (see [Install](#install); a symlinked install follows on its own).

- **First pass.** A Hermes transcript begun after the upgrade is read from its first line, so a first pass that ran late or failed still covers every turn. One begun before the upgrade (a resumed session) starts at its current turn, and its earlier turns are not extracted again.
- **Transcript format.** A new transcript opens with a small header line, `{"type": "clawmem-transcript", …}`, dated by the line it opens (never later), however large its first turn is. Every line carries a millisecond wall-clock timestamp, taken as the line joins the transcript's writes, so the times never decrease down the file, whichever thread wrote the line, unless the system clock is set back (v0.41.5).
- **Delivery by identity.** Hermes prefetches in the background once a turn is synced: `queue_prefetch` runs `context-surfacing` on the turn just completed, and the result reaches the agent with a later prompt, or with none — Hermes skips the prefetch for trivial prompts, and the plugin drops a result that arrives after its three-second wait. `context-surfacing` hands the plugin the id of its usage row with the result (for the Hermes host only), and the plugin settles every such row explicitly (a record is lost only in the cases under **Failed writes** below):
  - **handed over** — `prefetch()` gave the context to the turn that is starting; that turn's sync writes the id on its user line, `"clawmem_delivery": {"usage_id": …, "at": …}`;
  - **dropped** — the result arrived after its turn had started, was replaced by a newer one before any turn took it, or was still cached at a session switch; the plugin appends `{"type": "clawmem-prefetch-outcome", "usage_id": …, "outcome": "dropped"}`;
  - **unresolved** — it was handed over, but the plugin cannot prove to which synced turn: the turn's text had another turn begun and not yet synced (a retried prompt, a sync lagging behind — counted through Hermes's `on_turn_start`), the note waited past the 256 kept, the turn never synced before a session switch, or `prefetch()` took longer than 6 s (Hermes gives a provider 8 s by default and may have discarded it); the same line with `"outcome": "unresolved"`.

  The feedback step credits a surfaced note only in the turn whose line carries its row's id; a dropped or unresolved row is closed `not-delivered`, and a row still open when its session ends is closed so too. The feedback step reads each Hermes transcript once, from its first line, every pass resuming where the last one stopped: each pass checks the file (its first line, and the line the last pass stopped after) and reads only what was appended since, and it decides by these records alone: no timestamp or line position decides anything. A hand-over is what the plugin gave Hermes; whether Hermes put it in front of the model is not visible to a provider, so a verified reference in that turn is the evidence. A dropped result's documents still count as surfaced: the manifest records what `context-surfacing` rendered, not what the agent received.
- **Failed writes.** A transcript write that fails, a turn's or an outcome's, is kept and written in order at a later write (after a pause that grows from half a second to 30 s while it keeps failing), and at once at a session switch, the session's end and shutdown; a turn's Stop pass is queued once its lines are on disk. Every byte is accounted for and nothing is truncated: a write that stops part-way goes on from its next byte, and nothing already on disk is written twice. The transcript has one writer (see [Plugin-managed transcript](#plugin-managed-transcript)); if it changes under a write cut short all the same (a writer outside the plugin, an edit), the rest of that write is given up, with a warning, rather than appended after someone else's lines, where it would join another turn. A torn tail (a crash, a write given up) is ended first, so it stays a line of its own, which ClawMem skips. A record is lost when its transcript still cannot be written at the session's end (the writes still waiting are then given up, with a warning, before the end is recorded, so none can land after a verdict made without it) or at shutdown; when more than 256 writes or 16 MB wait for one transcript (once an attempt has failed, the oldest is given up, with a warning, a single larger write included); when the transcript changed, or was moved or replaced, under a write cut short; or when the process dies with writes waiting. A row whose record is lost is never credited on it: it closes `not-delivered` once the session's end is recorded, and stays open if the process died first. Complete lines a given-up write had already put on disk stay readable and are processed like any others (a user line with its record, and its whole reply, can still credit that row).
- **Session end.** `on_session_end` takes this transcript's queued pass out of the queue, waits for a pass of it still running (up to 35 s), runs the final pass itself — passes of other transcripts do not delay it — then the SessionEnd flush and one more `feedback-loop` run. What a timed-out step leaves, the watcher's worker finishes, apart from the decision extraction of turns no pass processed.

One limit: the plugin matches a `prefetch()` call to the turn's sync by the turn's text. A turn whose synced text differs from its prefetch query (Hermes flattens multimodal messages two ways) carries no record, and its prefetch stays open until the session ends; and once a text has had two turns begun but not synced (an interrupted turn and its retry), that text stays unresolved for the rest of the session. Those prefetches are never credited.

### Why shell-out for hooks?

ClawMem's lifecycle hooks (context-surfacing, decision-extractor, etc.) are Bun/TypeScript programs that read a transcript JSONL file and interact with the SQLite vault directly. The Python plugin shells out to the `clawmem` binary to invoke them, avoiding a cross-language library dependency. This is the same pattern used by the OpenClaw plugin.

### Why REST for tools?

Interactive tool calls need structured JSON responses and benefit from the REST server's connection pooling. The `clawmem serve` process stays warm, so tool calls complete in milliseconds.

### Plugin-managed transcript

Hermes passes turn data via `sync_turn(user_content, assistant_content)`, but ClawMem hooks expect a `.jsonl` transcript file. The plugin bridges this by maintaining its own transcript at `$HERMES_HOME/clawmem-transcripts/<session_id>.jsonl`, appending each turn in Claude Code transcript format (`{"type":"message","message":{"role":"...","content":"..."}}`). Since v0.41.0 a process holds its transcript open and locked (`flock`) while it writes it, so each transcript has one writer: a second process on the same session writes `<session_id>.2.jsonl` (up to `.8`), and where the platform or file system cannot lock (Windows, a network file system without locks), a process writes a name of its own, `<session_id>.<random>.jsonl`. ClawMem treats each file as its own transcript (its own cursors and handoff). A transcript is held while a prefetch that may still record an outcome in it runs, even past a session switch. Moving, replacing or editing a transcript while its session runs is not supported. The plugin checks before each write, and between two waiting writes, that the path still names the file it holds; if not, it writes on in the file now at the path, and gives up the rest of a write cut short (with a warning) rather than finish it there. A write under way when the file moves, and whatever went to the old file, stay in the old file, out of ClawMem's reach. An edit in place is noticed only where it changes the first line or the line the last feedback pass stopped after; the transcript is then read again from its start. Any other edit goes unnoticed: a record changed before the feedback step reads it is taken as written.

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
| `CLAWMEM_LLM_MODEL` | `qwen3` | Model name sent to the GPU/cloud LLM endpoint (e.g., `qwen3`, `gpt-5.4-mini`) |
| `CLAWMEM_LLM_REASONING_EFFORT` | — | Optional top-level `reasoning_effort` field for Chat Completions endpoints that support it (for example OpenAI reasoning models). Leave unset for llama-server/vLLM unless explicitly supported. |
| `CLAWMEM_LLM_NO_THINK` | `true` | Append `/no_think` to remote prompts; set to `false` for standard OpenAI models and other endpoints that reject or treat the Qwen-style suffix as literal prompt text |
| `CLAWMEM_RERANK_URL` | — | GPU reranker server URL (e.g., `http://localhost:8090`) |
| `CLAWMEM_API_TOKEN` | — | REST token. Unset: the plugin reads the token file `clawmem serve` generates (below) |
| `CLAWMEM_CONFIG_DIR` | `~/.config/clawmem` | Where `clawmem serve` keeps its token file, `serve-token` |

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

**The token (v0.42.0).** `clawmem serve` requires a token on every request. The plugin sends `CLAWMEM_API_TOKEN` when it
is set, and otherwise reads the token file `serve` generates (`$CLAWMEM_CONFIG_DIR/serve-token`, default
`~/.config/clawmem/serve-token`) on each call — so run the plugin and `serve` as the same user with the same
`CLAWMEM_CONFIG_DIR`, and either set the same `CLAWMEM_API_TOKEN` for both or for neither. A `CLAWMEM_API_TOKEN` (or
`CLAWMEM_CONFIG_DIR`) set only in the ClawMem checkout's `.env` reaches `serve` through `bin/clawmem` but not the plugin:
set it in the plugin's environment too. A token that is not valid (32–4096 characters of `A–Z a–z 0–9 - . _ ~ + /`) is
never sent; the plugin logs why, without the value.

### Managed

The plugin starts `clawmem serve` during `initialize()` and stops it on `shutdown()`. Includes a readiness probe (5s health check loop) and early-exit detection. Before starting it, the plugin runs `clawmem serve-token` through the same binary and environment and passes the printed token to the child explicitly, so the two ends always agree; it keeps using that token if its child loses the port to another `clawmem serve` started the same way (which then holds the same token). It reads the token once, at start: after a token rotation, restart Hermes.

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

# REST API responding (it needs the token since v0.42.0)
curl -H "Authorization: Bearer $(clawmem serve-token)" http://localhost:7438/health

# Hooks working
clawmem status

# Watcher active
systemctl --user status clawmem-watcher.service
```

## Lifecycle mapping reference

| Hermes MemoryProvider | ClawMem equivalent | Notes |
|---|---|---|
| `is_available()` | PATH check for `clawmem` binary | No network calls |
| `initialize(session_id, **kwargs)` | `session-bootstrap` hook | Claims the transcript a primary context writes — held open and locked while it writes it (see [Plugin-managed transcript](#plugin-managed-transcript)) — and caches bootstrap context. Reads `agent_context` and `hermes_home` from kwargs. Other kwargs Hermes passes (`platform`, `agent_identity`, `agent_workspace`, `parent_session_id`, `user_id`, `gateway_session_key`, `session_title`) are absorbed via `**kwargs` and currently unused. |
| `system_prompt_block()` | Static text | Provider active, tool names |
| `prefetch(query)` | `context-surfacing` hook output | Returns cached result from background thread; notes the surfacing row it handed over for this turn's sync to record, and records a row it drops (v0.41.0) |
| `queue_prefetch(query)` | `context-surfacing` hook | Background thread, generation-safe |
| `sync_turn(user, assistant)` | Transcript JSONL append + a Stop pass | Bridges Hermes turn pairs to ClawMem file format (the user line carries the turn's `clawmem_delivery`; a failed write waits and goes first at a later one), then runs the three Stop hooks over the transcript on a background thread. Background passes run one at a time, and requests made meanwhile coalesce per transcript; a session end's final pass runs on the caller's thread and may overlap a background pass of another transcript. Suppressed when `agent_context != "primary"`. |
| `on_turn_start(turn_number, message)` | — | Counts the turn under its text (v0.41.0), so the plugin knows when two unsynced turns share a text and their prefetches cannot be told apart. Suppressed when `agent_context != "primary"`. |
| `on_session_end(messages)` | A last Stop pass, `handoff-generator` (SessionEnd), `feedback-loop` | Takes this transcript's queued pass and runs it after any pass of it still running (up to 35 s; the hooks in parallel, 30s timeout each), renders the handoff's latest turns and records the session's end, then closes the last prefetch. Suppressed when `agent_context != "primary"`. |
| `on_pre_compress(messages)` | `precompact-extract` | Side effect only (Hermes ignores return): stores the session-keyed pre-compaction state in the vault's `compaction_state` table, which nothing in Hermes reads back today. Suppressed when `agent_context != "primary"`. |
| `on_memory_write()` | No-op | Avoids duplication with built-in memory (filesystem watcher already indexes MEMORY.md / USER.md if they live under a configured collection). |
| `on_delegation()` | No-op | Subagent observation handled at the parent's primary context already; nothing useful to add here. |
| `get_tool_schemas()` | 5 REST-backed tools | retrieve, get, session_log, timeline, similar |
| `handle_tool_call()` | REST API dispatch | Sends the token: the managed one, else `CLAWMEM_API_TOKEN`, else serve's token file |
| `shutdown()` | Thread cleanup + managed serve stop | Joins prefetch thread, makes a last try at transcript writes still waiting (what cannot be written is logged as lost), releases the transcripts it holds, terminates managed process |
