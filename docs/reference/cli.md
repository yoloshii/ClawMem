# ClawMem CLI reference

Complete command reference for the ClawMem memory engine. Always use the `bin/clawmem` wrapper, which sets GPU endpoint defaults.

## Core commands

```bash
clawmem init                    # Initialize vault (creates SQLite DB)
clawmem status                  # Quick index status
clawmem doctor                  # Full health check (GPU connectivity, index integrity, embedding-geometry canary, sampled vector validation, LLM endpoint shape probe — a squatted port that answers HTTP but not chat completions shows red, contradiction-judge config + live smoke test when CLAWMEM_JUDGE_* is set, hook host-timeout vs internal-budget inequality since v0.38.0, and the compaction leftovers since v0.40.0: `postcompact-inject` under a matcher other than `compact`, old `precompact-state.md` files (red when one was written after the upgrade), indexed copies of them still active; since v0.41.2 the LLM server's context as `/props` reports it to the Stop hooks' observer — its source, how prompts are counted, the nominal transcript allowance of one window (before the context section and any remembered context ceiling, so an actual window can be smaller), the observer's mean call over its latest 50 calls — the ranges held as `capacity:`, queued continuations and those waiting for a server that could not be verified, and live checkpoints no queued range owns, split into those a later Stop can still reach, a first Stop's with no cursor, and those behind the transcript's cursor)
clawmem rerank-health           # Live cache-bypassed reranker probe: coverage + discrimination check, and provider-identity attestation (v0.38.0 — a passing probe enables remote rerank-score caching; a failed or unfingerprintable probe REVOKES it)
```

## Collection management

```bash
clawmem collection add <path> --name <name>   # Add a collection
clawmem collection list                        # List all collections
clawmem collection remove <name>               # Remove a collection
```

`collection add` and `collection remove` edit `~/.config/clawmem/config.yaml` in place: comments, blank lines and quoting outside the edited entry come back unchanged (since v0.39.1). Adding a name that already exists updates its path and pattern and keeps its `context` and `update`. Removing a collection also removes the comment lines directly above it; a comment set off from the entry by a blank line stays. Before writing, each edit reads back the text it is about to write; if the config would change anywhere else, or not as asked (a collection that only a YAML merge key `<<` provides, say), the command stops with an error and leaves the file untouched.

## Indexing

```bash
clawmem update                  # Index all collections (BM25 only); summary reports ✎stored/attempted notes when A-MEM enrichment ran
clawmem update --embed          # Index + embed in one pass
clawmem mine <dir>                             # Import conversation exports (Claude, ChatGPT, Slack)
clawmem mine <dir> -c convos                   # Import with custom collection name
clawmem mine <dir> --embed                     # Import + embed in one pass
clawmem mine <dir> --dry-run                   # Preview without importing
clawmem mine <dir> --synthesize                # v0.7.2: import + post-import LLM fact extraction
clawmem mine <dir> --synthesize --synthesis-max-docs 50   # Cap synthesis to first 50 conversations (default 20)
clawmem mine <dir> -c convos --backfill-dates  # v0.27.0: derive authored_at for ALREADY-mined docs from
                                               # source transcripts — dry-run report by default
clawmem mine <dir> -c convos --backfill-dates --apply     # Execute the backfill (metadata-only: modified_at,
                                               # stored confidence, and embeddings are never touched)
clawmem reindex                                # Re-scan all collections
clawmem reindex --force                        # Re-read every file, bypassing the content-hash skip
clawmem reindex --enrich                       # Full A-MEM pipeline on all documents (entity extraction skips unchanged ones)
clawmem embed                   # Embed all un-embedded fragments (geometry-canary preflight runs first; since v0.41.2 a run that stores no vector never sets the geometry taint, and still exits 1 when unverified)
clawmem embed --force           # Re-embed everything (clears existing vectors; aborts BEFORE clearing if the canary preflight fails)
clawmem embed --force --force-geometry        # v0.21.0: proceed despite a failed/unavailable canary — vault is tainted until a verified rebuild (since v0.41.2 only a --force rebuild whose preflight PASSES clears the taint)
clawmem embed --force --recalibrate-canary    # v0.21.0: replace the stored canary baseline after a deliberate model/server change (requires --force)
```

### Conversation Import

`clawmem mine` normalizes and imports conversation exports from multiple AI chat formats:

- **Claude Code JSONL** — session transcripts (`.jsonl`)
- **Claude.ai JSON** — flat messages or privacy export with `chat_messages`
- **ChatGPT JSON** — `conversations.json` with mapping tree
- **Slack JSON** — 2-party DM exports
- **Plain text** — files with `User:`/`Assistant:` markers

Each user+assistant exchange pair becomes one indexed document with `content_type: conversation`. Files are chunked, written to a temporary staging directory, indexed through the standard pipeline (including A-MEM enrichment), then staging is cleaned up.

#### Authorship time (v0.27.0)

Mining preserves **when the content was originally written**: message timestamps are extracted per format (strict RFC3339 for Claude Code / codex / Claude.ai; epoch seconds for ChatGPT / Slack; plain text has none), each exchange chunk is stamped `authored_at` = the max timestamp within that exchange, and synthesized facts inherit their source doc's date. `created_at`/`modified_at` remain filing/update time. Ranking recency, temporal filters ("from March"), and recency windows (postcompact, session bootstrap, `reflect`, profile) all run on **effective time** — `authored_at` when known, `modified_at` otherwise — so a 2025 conversation mined today no longer ranks as if written today. Any vault file may also declare `authored_at:` in frontmatter (full timestamp or date-only `YYYY-MM-DD`, quoted or not).

For vaults mined before v0.27.0, `--backfill-dates` re-derives dates from the source transcripts and applies a **metadata-only** update (dry-run report by default; `--apply` executes; documents whose content no longer matches the source are skipped, never guessed).

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

Since v0.41.0 the watcher also runs the stop-pipeline worker every 60 s (feedback of quiet or ended transcripts, named-vault slices, handoff digests and renders, quarantined ranges, deferred judge pairs, queued causal steps; since v0.41.2 a due observer continuation first, then an orphaned-checkpoint sweep), and it keeps running with no collection configured. Its first start preserves the antipattern bodies older versions overwrote and recomputes the feedback counters once (see [`repair counters`](#stop-pipeline-v0410)).

## Setup

```bash
clawmem setup hooks             # Install Claude Code hooks (v0.41.0+: also the SessionEnd handoff flush)
clawmem setup hooks --remove    # Remove installed hooks
clawmem setup mcp               # Register MCP server
clawmem setup openclaw                   # Install the OpenClaw memory plugin. With the openclaw CLI on PATH: stages a compiled copy (dist/index.js), delegates to `openclaw plugins install --force`, then sets and reads back clawmemBin, hooks.allowConversationAccess=true and plugins.slots.memory=clawmem (v0.39.0+). Falls back to a direct copy honoring OPENCLAW_STATE_DIR when the CLI is absent.
clawmem setup openclaw --accept-capabilities  # Consent to the plugin's declared capabilities in a non-interactive run; OpenClaw 2026.5+ asks on every local install. Alias --yes / -y (v0.39.0+).
clawmem setup openclaw --gateway-user <name>  # System-service installs: verify the installed files are owned by that user or root, not world-writable and readable by it (every directory on the way traversable, symlink targets included), and that it can run the clawmem binary; exits non-zero when a check fails (v0.39.0+).
clawmem setup openclaw --link            # Load-path mode: delegates `openclaw plugins install -l` when CLI is on PATH (records source in plugins.load.paths — NOT a filesystem symlink). In CLI-absent fallback, creates a real symlink (note: OpenClaw v2026.4.11+ discovery skips fallback symlinks).
clawmem setup openclaw --remove          # Uninstall. Tries `openclaw plugins uninstall clawmem --force` first; falls back to manual cleanup at the resolved extensions path for legacy unmanaged installs.
clawmem setup openclaw --help            # Print full flag + env-var reference (v0.10.4+).
clawmem setup curator                    # Install curator agent
```

### `setup openclaw` env vars (v0.10.4+)

Both the delegated and fallback paths honor:

| Env var | Effect |
|---------|--------|
| `OPENCLAW_STATE_DIR` | Override the OpenClaw config root. Plugin installs into `<OPENCLAW_STATE_DIR>/extensions/clawmem`. |
| `OPENCLAW_CONFIG_PATH` | Override the OpenClaw config file path; config root becomes `dirname(OPENCLAW_CONFIG_PATH)`. |
| `OPENCLAW_PROFILE` | Named OpenClaw profile (v0.39.0+). Passed to every `openclaw` command as `--profile <name>` (the variable alone selects nothing in OpenClaw); the CLI-absent fallback resolves `~/.openclaw-<name>`. Checked against OpenClaw's profile-name grammar before anything is touched, `--remove` included. |
| `OPENCLAW_HOME` | Override the home directory used to resolve the default `~/.openclaw` root. |
| `HOME` / `USERPROFILE` | Standard home-dir env vars; consulted in that order when `OPENCLAW_HOME` is unset. |

```bash
# Install ClawMem into the `dev` profile (~/.openclaw-dev/extensions/clawmem)
OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw
```

## Server

```bash
clawmem serve                            # Start REST API (localhost:7438); every request needs the token
clawmem serve --port 8080                # Custom port
clawmem serve --host 0.0.0.0             # Listen on all interfaces (Host is checked only with CLAWMEM_ALLOWED_HOSTS)
clawmem serve --no-token                 # No token — loopback binds only; local programs and loopback-origin pages can call it
clawmem serve-token                      # Print the token serve uses (CLAWMEM_API_TOKEN, else the generated token file)
```

Since v0.42.0 `serve` requires `Authorization: Bearer <token>` on every request, refuses foreign `Origin` and `Host`
headers, and takes only JSON POST bodies — see [REST API](rest-api.md#authentication-v0420).

## Hook execution (internal)

```bash
clawmem hook context-surfacing    # Execute a hook (reads JSON from stdin)
clawmem hook decision-extractor
clawmem hook handoff-generator    # Stop; with "hook_event_name": "SessionEnd", the render-only flush
clawmem hook feedback-loop
clawmem hook precompact-extract
clawmem hook postcompact-inject
clawmem hook session-bootstrap
clawmem hook staleness-check
clawmem hook curator-nudge
```

Since v0.38.0 the context-surfacing hook applies injection bookkeeping (recall events, injected-paths/token fill-in, secondary-vault mirrors) off-process: after emitting its payload the hook parks a job and hands it over a pipe to a detached `spool-ingest` child, which persists it under `<db dir>/surfacing-spool/` and drains it. The turn-alignment `context_usage` row is written in-hook (fail-closed) and never depends on the spool.

```bash
clawmem spool-ingest            # INTERNAL: read one bookkeeping job from stdin, persist to the spool, drain
clawmem spool-drain             # Apply pending spool jobs manually (safe any time; claim-by-rename makes concurrent drainers non-duplicating; jobs older than 24h are discarded)
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

## Lifecycle & retention

```bash
clawmem lifecycle status                    # Lifecycle stats (+ deactivation reasons) + active policy
clawmem lifecycle sweep [--dry-run]         # Archive stale docs per policy (reversible)
clawmem lifecycle search <query>            # Search archived docs (FTS, no restore)
clawmem lifecycle restore --query <term> | --collection <name> | --all
```

`sweep` archives only; `restore` reverses it. **ClawMem physically deletes no document row
on any path** (v0.30.0) — `purge_after_days` is inert, and a sweep that sees it configured
says so. To reclaim disk space, act on the SQLite file out-of-band; that is deliberately
outside ClawMem's mutation contract.

## Stop pipeline (v0.41.0)

```bash
clawmem repair counters                     # Dry run: what the recompute would change, per vault
clawmem repair counters --apply             # Recompute from verified references (once; --force to run it again)
clawmem repair counters --restore <op>      # Put back what op <op> changed, where nothing changed it since
clawmem repair counters --remove-fence      # Drop the fence triggers (before a downgrade)
clawmem repair stop-queue                   # Queue depths: quarantined ranges, pending/provisional feedback, judge, handoffs, causal
clawmem repair stop-queue --run             # Drain every queue now (no quiet period; up to 20 passes)
clawmem repair stop-queue --retry-now held  # Make the held ranges due now (queued, last error not a continuation; at most 50)
clawmem repair stop-queue --retry-now 12,15 --limit 10   # The same for named ranges (queued rows only)
clawmem repair stop-queue --retry-now held --run         # …and drain now: reports the ranges it reached and the next due times
clawmem repair stop-queue --dismiss <id>    # Dismiss one quarantined range for good
clawmem repair stop-queue --dismiss-causal  # Drop the causal steps waiting while every consumer keeps CLAWMEM_CAUSAL_WRITER=off
clawmem recover antipatterns                # List the distinct lines of the antipattern bodies older versions overwrote
clawmem recover antipatterns --apply [--min-occurrences N]   # Write them to _clawmem/antipatterns/recovered-<YYYY-MM>.md
```

`repair counters` runs on the general vault and every configured named vault. The recompute sets
`access_count` and `last_accessed_at` from verified references, recomputes the utility signals,
deletes and rebuilds co-activations and `usage` relations from verified same-turn references, and
gives a staggered archive grace to documents whose old last access fell inside their archive
window. Every value it changes or deletes is kept in `counter_repair_log` under the op id it prints;
`--restore` puts a value back only while it still equals what that op wrote, and a deleted row only
while its key is free, and reports the rest as conflicts. `--apply` first preserves the overwritten
antipattern bodies (as `recover antipatterns` does). `clawmem watch` runs `--apply` once at its first
start. `--remove-fence` lasts until the next writable open by v0.41 or later, which installs the fence
again; run it after every v0.41 process has stopped. `--dismiss-causal` deletes, in one write transaction, every causal step queued up to that moment. It
refuses while this shell's `CLAWMEM_CAUSAL_WRITER` is not `off`, and while the vault shows the writer in use
elsewhere (a causal step queued or run in the last hour). It cannot see a consumer that runs the writer but has
been idle: set the writer to `off` for the watcher and every hook before you use it.

`--retry-now` (v0.41.4) sets the selected quarantined ranges' next retry to now and prints their ids: `held` selects the
queued rows whose last error is not a continuation, a comma-separated list selects those ids; only `queued` rows are
touched (a row another process has claimed keeps its lease), at most `--limit` (default 50), lowest ids first. Without
`--run` the watcher replays them at its next tick. `--run` drains every queue the worker services, up to 20 passes: a pass
counts as progress when anything moved or a replay row was attempted, whatever its outcome, so a pass whose replays all
failed again does not end the drain. It then reports, for the ranges `--retry-now` selected in the same command, how many
were attempted and which were not reached, and what each queue still has due and when its next item falls due, counted
with the worker's own rules (a claimed range whose lease expired is due now; feedback turns are examined every pass; a
named vault's mirror is due once its general verdict is ready; handoff renders wait for the session to end or go
quiet). The handoff digest catch-up is not a queue (each pass re-reads quiet transcripts whose cursor is behind) and is
not counted. It does not wait for work due later, and
promises no exactly-once replay: other due work, continuations and each tick's time budget share every pass.

## Causal witness migration (s342)

```bash
clawmem migrate causal-witnesses --preflight [--out <manifest.json>]
clawmem migrate causal-witnesses --resolve-unmaterializable keep-weight|retire-edge \
    --manifest <file> --edge <src>:<tgt> [--edge ...] [--note <text>] [--apply]
clawmem migrate causal-witnesses --restore-edge <src>:<tgt> [--apply]
```

Operator surface for pre-cut causal edges the writer refuses to touch (zero witness
sightings + metadata that cannot yield a valid witness). `--preflight` runs the census —
scoped to edges whose BOTH endpoints are observation-lane documents, so Beads dependency
edges and other producers never enter it — and classifies each edge as *materializable*
(valid old-writer metadata; resolves itself lazily, no action needed) or *unresolved*.
Run it (and resolve or accept the result) **before** setting `CLAWMEM_CAUSAL_WRITER=on`.

Resolution is explicit-selection only (`--edge` per edge; bulk "all qualifying" does not
exist), refuses *materializable* entries outright (valid old-writer evidence is never
retired here), and is manifest-bound: `--apply` recomputes each row's version-tagged
full-row fingerprint under the write lock and refuses rows that changed since the preview
(`STALE`). `keep-weight` writes the single operator-ratified legacy witness carrying the
edge's current weight; `retire-edge` moves the complete row into the non-pruned
`retired_causal_edges` archive and deletes it from the active graph in one transaction.
`--restore-edge` is the reversal: a plain fail-closed INSERT — if another edge now
occupies the key, the restore is refused and both the occupying edge and the archive row
stay untouched.

## Causal writer audit (s342)

```bash
clawmem causal-audit [--limit N] [--json]      # recent causal_runs (mode, outcome, counts, timing)
clawmem causal-audit --run <run_key> [--json]  # one run + its scoped events
```

Read-only inspection over `causal_runs`/`causal_run_events` — the shadow-mode calibration
surface. Every invocation in `shadow`/`on` writes one run row (no-call outcomes such as
`skipped_budget`/`no_candidates` included) with document/pair/write-scope events carrying a
named disposition per filter.

## Offline eval harness

```bash
clawmem eval run --gold <file.jsonl> [--profile query] [--limit N] [--min-examples N] [--audited] [--out <dir>] [--db <snapshot>] [--json]
```

Replays gold-labeled queries through the real `query` tool handler and scores retrieved documents against hand-labeled evidence (doc-level Jaccard, precision/recall@k, hit@k, MRR). Writes `run.json` + `report.md`; touches no retrieval, lifecycle, or telemetry state (normal inference caches may populate, as in any live query). Exits `1` when the trust gate fails (too few scored examples, unresolved gold refs, or no `--audited` label-audit attestation). Gold schema, trust gates, and A/B workflow: [docs/guides/eval-harness.md](../guides/eval-harness.md).

`clawmem vec-daemon-health [--db <path>] [--json] [--timeout-ms N]` — **v0.38.0.** Is the watcher's vector daemon Path-A AUTHORITATIVE for the vault? A real ping round trip (exact DB + owning pid), never a socket glob. Exit 0 ONLY for `live` (attested pid + DB **and** both the `hydrated-v1` response protocol and the O1 `deadline-rel-v1` relative-budget protocol advertised) — the one state under which the context-surfacing hook's vector deadline is authoritative. Everything else exits 1: `absent` / `stale` / `unresponsive` / `foreign-db` (no usable listener), and the two liveness-without-authority tiers — `live-raw` (attested, but missing `hydrated-v1` or `deadline-rel-v1`: the v0.38 hook classifies its answers `skew` and falls back to FTS) and `live-legacy` (a pre-v0.38 watcher: answers the daemon protocol, cannot attest). The JSON output carries `live` (any listener), `attested`, and `authoritative` separately. `clawmem doctor` runs the same check and warns (non-fatal issue) on the non-authoritative live tiers.

```bash
clawmem eval hook-run --gold <cases.jsonl> --db <snapshot> [--profile ...] [--budget-ms N] [--baseline <hook-run.json>] [--pair-with <run-dir> --pair-min-valid N] [--pair-min-exposed-stratum deep=6] [--pair-min-basis-stratum speed:bm25-rrf=3] [--pair-treatment <t>] [--capture-expansions <f> | --replay-expansions <f>] [--latency-reps N] [--skill-db <snapshot>] [--out <dir>] [--vector-exec daemon-required|in-process] [--vector-prewarm steady-state|cold] [--vector-daemon-ready-timeout-ms N]
clawmem eval hook-aggregate --runs <dir1,dir2,...> --out <dir>
```

`hook-run` runs the **daemon-backed vector protocol** by default (`--vector-exec daemon-required`): a dedicated vector-daemon child is spawned on the working copy (steady-state prewarm before verified readiness), every vector leg is daemon-required, and the protocol is recorded in the run identity (`vector_exec`, strict on every comparison surface); `in-process` is the recorded opt-out whose latency evidence is not authoritative on balanced/deep — see [eval-harness](../guides/eval-harness.md). It replays labeled UserPromptSubmit cases through the **real** context-surfacing handler and scores the injected order (graded nDCG@k, must-include recall, must-not rate, abstention accuracy, prior-leg accuracy, latency, invariant audit), with run-identity fingerprints, acceptance gates against a baseline, paired counterfactuals, and registered treatments. `hook-aggregate` aggregates replicated paired draws into a distributional verdict. Full protocol: [eval-harness](../guides/eval-harness.md#hook-replay-clawmem-eval-hook-run).

## Session focus topic (v0.9.0)

Per-session topic biasing for the context-surfacing hook. Writes a focus file at `~/.cache/clawmem/sessions/<session_id>.focus` used ONLY as a snippet-selection `intent` hint (presentation: which sentences of a surfaced doc are shown). A focus never reaches query expansion, reranking, scoring, or ordering — the post-composite topic boost and the expansion/rerank intent threading were both removed in v0.38.0. Session-scoped — never writes to SQLite or mutates any lifecycle column.

```bash
clawmem focus set "<topic>"                        # uses CLAUDE_SESSION_ID / CLAWMEM_SESSION_ID env
clawmem focus set "<topic>" --session-id <id>      # explicit session id
clawmem focus show                                 # reads session id from env
clawmem focus show --session-id <id>
clawmem focus clear                                # uses env-resolved session id
clawmem focus clear --session-id <id>
```

The session ID is resolved from `--session-id <id>`, then `CLAUDE_SESSION_ID`, then `CLAWMEM_SESSION_ID`. `CLAWMEM_SESSION_FOCUS` env var is a debug-only override that does NOT provide per-session scoping on multi-session hosts. `CLAWMEM_FOCUS_ROOT` overrides the focus file root directory for hermetic testing.

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
| `CLAWMEM_LLM_API_KEY` | — | Bearer token for an authenticated remote LLM endpoint |
| `CLAWMEM_LLM_MODEL` | `qwen3` | Model name sent to the configured LLM endpoint |
| `CLAWMEM_LLM_REASONING_EFFORT` | — | Optional top-level `reasoning_effort` field for Chat Completions endpoints that support it (for example OpenAI reasoning models). Leave unset for llama-server/vLLM unless explicitly supported. |
| `CLAWMEM_LLM_NO_THINK` | `true` | Append `/no_think` to remote prompts; set `false` for standard OpenAI models and other endpoints that reject or treat it as literal prompt text |
| `CLAWMEM_JUDGE_URL` / `_PROVIDER` / `_MODEL` / `_API_KEY` / `_NO_THINK` / `_STRUCTURED` | (none) | **v0.29.0.** The contradiction **judge** — task-scoped endpoint for contradiction classification (decision-extractor hook + merge-time gate), independent of the global `CLAWMEM_LLM_*` vars. Unset ⇒ contradiction analysis is disabled (audited no-op). Full table + lane semantics: [inference services](../guides/inference-services.md#contradiction-judge). |
| `CLAWMEM_RERANK_URL` | `http://localhost:8090` | Reranker server |
| `CLAWMEM_RERANK_API_KEY` | — | Bearer token for an authenticated remote reranker endpoint |
| `CLAWMEM_NO_LOCAL_MODELS` | `false` | Block node-llama-cpp auto-downloads |
| `CLAWMEM_PROFILE` | `balanced` | Performance profile: `speed` (BM25 only), `balanced` (BM25+vector), `deep` (BM25+vector+expansion+reranking) |
| `CLAWMEM_HOOK_BUDGET_MS` | `6000` | **v0.38.0.** Context-surfacing hook's authoritative internal time budget; host hook timeout must be ≥ 1.5s startup + this ([configuration](configuration.md)) |
| `CLAWMEM_ADMISSION_POLICY` | `relevance` | **v0.38.0.** Hook admission policy; `composite` = eval control arm only |
| `CLAWMEM_RERANK_DEGENERACY_GATE` | `on` | **v0.38.0.** Discard non-discriminating deep-profile rerank score sets; `off` only for eval control arms |
| `CLAWMEM_RERANK_LANE_WEIGHT` | `1.5` | **v0.38.0.** Rank-fusion weight of an applied rerank lane; `0` = RRF-only counterfactual |
| `CLAWMEM_RERANK_PROVIDER_ID` | — | **v0.38.0.** Declared reranker identity refinement; remote rerank caching requires an attested identity (`clawmem rerank-health`) |
| `CLAWMEM_SURFACING_TRACE` | — | **v0.38.0.** `=1`: persist per-stage surfacing traces to `surfacing_diagnostics` (diagnostic; adds post-payload latency) |
| `CLAWMEM_VAULTS` | — | JSON map of vault name to SQLite path |
| `CLAWMEM_API_TOKEN` | — | The REST token (32+ characters); unset or empty → the generated token file `serve-token` in the config directory |
| `CLAWMEM_ALLOWED_HOSTS` | — | Extra `Host` names `serve` accepts (comma-separated, no ports) |
| `CLAWMEM_ALLOWED_ORIGINS` | — | Extra browser origins `serve` accepts (comma-separated) |
| `CLAWMEM_ENABLE_AMEM` | enabled | A-MEM note construction during indexing |
| `CLAWMEM_ENABLE_CONSOLIDATION` | disabled | Background consolidation worker (light lane, 5-min interval). **v0.8.2:** every tick wraps in a `worker_leases` row (`light-consolidation` key) so dual-host (`clawmem watch` + `clawmem mcp`) is safe. Hosted by either `cmdWatch` (canonical, long-lived) or `cmdMcp` (per-session fallback). |
| `CLAWMEM_CONSOLIDATION_INTERVAL` | `300000` | Light-lane worker interval in ms |
| `CLAWMEM_HEAVY_LANE` | disabled | **v0.8.0.** Enable the quiet-window heavy maintenance lane (second consolidation worker with DB-backed lease + stale-first batching + `maintenance_runs` journaling). See [heavy maintenance lane](../concepts/architecture.md#heavy-maintenance-lane-v080). **v0.8.2:** canonical host is `clawmem watch`; `clawmem mcp` retains the same gate as a fallback host but emits a stderr warning advising operators to move heavy-lane hosting to the watcher because per-session stdio MCPs may never be alive during the configured quiet window. |
| `CLAWMEM_HEAVY_LANE_INTERVAL` | `1800000` | **v0.8.0.** Heavy-lane tick interval in ms (default 30 min, min 30 s). |
| `CLAWMEM_HEAVY_LANE_WINDOW_START` | — | **v0.8.0.** Start hour (0-23) of the quiet window. Unset → no window. |
| `CLAWMEM_HEAVY_LANE_WINDOW_END` | — | **v0.8.0.** End hour (0-23, exclusive). Supports midnight wrap (22→6). |
| `CLAWMEM_HEAVY_LANE_MAX_USAGES` | `30` | **v0.8.0.** Max `context_usage` rows in the last 10 min before the heavy lane skips with `reason='query_rate_high'`. |
| `CLAWMEM_HEAVY_LANE_OBS_LIMIT` | `100` | **v0.8.0.** Phase 2 stale-first observation batch size for the heavy lane. |
| `CLAWMEM_HEAVY_LANE_DED_LIMIT` | `40` | **v0.8.0.** Phase 3 stale-first deductive candidate batch size for the heavy lane. |
| `CLAWMEM_HEAVY_LANE_SURPRISAL` | `false` | **v0.8.0.** When `true`, seed Phase 2 with k-NN anomaly-ranked doc ids from `computeSurprisalScores` instead of stale-first ordering. Degrades to stale-first on vaults without embeddings. |
| `CLAWMEM_SESSION_FOCUS` | — | **v0.9.0 §11.4.** Debug-only override for the session focus topic. NOT session-scoped — do not use in multi-session deployments. Use `clawmem focus set <topic> --session-id <id>` instead. |
| `CLAWMEM_FOCUS_ROOT` | `~/.cache/clawmem/sessions` | **v0.9.0 §11.4.** Override directory for per-session focus files. Primarily for hermetic testing. |
| `INDEX_PATH` | `~/.cache/clawmem/index.sqlite` | Override default vault path |

The `bin/clawmem` wrapper sets endpoint defaults. Always use it instead of `bun run src/clawmem.ts` directly.
