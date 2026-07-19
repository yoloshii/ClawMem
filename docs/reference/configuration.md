# Configuration reference (environment variables)

All ClawMem tuning knobs are environment variables. The `bin/clawmem` wrapper sets the endpoint defaults; **always run ClawMem via the wrapper.** For remote GPU setups, add the same vars to your systemd units via a drop-in.

**Precedence:** shell environment > `.env` file (project root) > `bin/clawmem` wrapper defaults. The wrapper sources `.env` before applying defaults, so `.env` overrides defaults but explicit shell exports still win.

See also: [../guides/inference-services.md](../guides/inference-services.md) (stack choice + server setup) · [../guides/cloud-embedding.md](../guides/cloud-embedding.md) (cloud providers) · [../guides/systemd-services.md](../guides/systemd-services.md) (services).

## Inference routing

| Variable | Default (via wrapper) | Effect |
|---|---|---|
| `CLAWMEM_EMBED_URL` | `http://localhost:8088` | Embedding server URL. Local `llama-server`, cloud API, or in-process `node-llama-cpp` fallback if unset. |
| `CLAWMEM_LLM_URL` | `http://localhost:8089` | LLM server for intent, expansion, A-MEM, entity extraction. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. Point at a 7B+ model or cloud API during `reindex --enrich` for better entity extraction. |
| `CLAWMEM_LLM_API_KEY` | (none) | Bearer token for an authenticated remote LLM endpoint. Independent of the embed/rerank keys — set it when the LLM points at a different authenticated host. |
| `CLAWMEM_RERANK_URL` | `http://localhost:8090` | Reranker server. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. |
| `CLAWMEM_RERANK_API_KEY` | (none) | Bearer token for an authenticated remote reranker endpoint. Independent of the embed/LLM keys. |
| `CLAWMEM_LLM_MODEL` | `qwen3` | Model name sent on LLM requests. |
| `CLAWMEM_LLM_REASONING_EFFORT` | (none) | Top-level `reasoning_effort` for Chat Completions endpoints that support it (e.g. a remote reasoning model). Optional. |
| `CLAWMEM_LLM_NO_THINK` | enabled | Appends `/no_think` to remote LLM prompts (Qwen3 emits thinking tokens by default). Set `false` for standard OpenAI-compatible models that would treat `/no_think` as literal text. |
| `CLAWMEM_NO_LOCAL_MODELS` | `false` | Blocks `node-llama-cpp` from auto-downloading GGUFs. Set `true` for remote-only setups to fail fast on unreachable endpoints. |

## Cloud embedding

Full provider matrix and behavior: [../guides/cloud-embedding.md](../guides/cloud-embedding.md).

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_EMBED_API_KEY` | (none) | API key for cloud embedding providers (Bearer token). Enables cloud mode: skips client-side truncation, sends `truncate: true` + provider params, batch embedding with adaptive TPM pacing. |
| `CLAWMEM_EMBED_MODEL` | `embedding` | Model name for embedding requests. Override for cloud (e.g. `jina-embeddings-v5-text-small`). |
| `CLAWMEM_EMBED_MAX_CHARS` | `6000` | Max chars per embedding input (local only; fits EmbeddingGemma's 2048 tokens). Set `1100` for granite-278m (512 tokens). Cloud providers skip truncation. |
| `CLAWMEM_EMBED_TPM_LIMIT` | `100000` | Tokens-per-minute limit for cloud pacing. Match your tier (e.g. Jina Free 100000, Paid 2000000, Premium 50000000). |
| `CLAWMEM_EMBED_DIMENSIONS` | (none) | Output dimensions for OpenAI `text-embedding-3-*` Matryoshka models (e.g. `512`, `1024`). Sent only when the URL contains `openai.com`. |

## Retrieval profile

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_PROFILE` | `balanced` | `speed` / `balanced` / `deep`. Sets the kept-score ratio (65% / 55% / 45%), vector timeout, max results, and the `factsTokens` sub-budget. Only `deep` adds query expansion + reranking to the hook path. `speed` makes hooks BM25-only (sub-500ms). |
| `CLAWMEM_NUDGE_INTERVAL` | `15` | Prompts between lifecycle tool use before a `<vault-nudge>` is injected. `0` to disable. |
| `CLAWMEM_MCP_DIRECT_TUNED_WEIGHTS` | (superseded) | **No effect since v0.22.0.** The direct-pipeline eval this knob was gated on measured tuned weights at 1/19 hit@1; the direct vector routes now rank by raw cosine instead (see [mcp-tools](mcp-tools.md) → Scoring regimes). Still parsed for backward compatibility — setting it (env or `retrieval.mcp_direct_tuned_weights` in `config.yaml`) logs a once-per-process warning. |

The context-surfacing hook `timeout` is **not** an env var — it lives in `~/.claude/settings.json` (8s default). See [../troubleshooting.md](../troubleshooting.md) → *Tuning the context-surfacing hook timeout*.

## Multi-vault

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_VAULTS` | (none) | JSON map of vault name → SQLite path. E.g. `{"work":"~/.cache/clawmem/work.sqlite"}`. Paths support `~`. (Also configurable in `~/.config/clawmem/config.yaml` under `vaults:`.) |

## A-MEM & consolidation

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_ENABLE_AMEM` | enabled | A-MEM note construction + link generation during indexing. |
| `CLAWMEM_ENABLE_CONSOLIDATION` | disabled | Background worker backfills unenriched docs + runs Phase 2/3 consolidation + deductive synthesis. Each tick wrapped in a DB-backed `worker_leases` row (`light-consolidation`) so multiple hosts can't race Phase 2 writes. Hosted by `clawmem watch` (canonical) or `clawmem mcp` (per-session fallback). |
| `CLAWMEM_CONSOLIDATION_INTERVAL` | `300000` | Light-worker interval in ms (min 15000). |

## Heavy maintenance lane (v0.8.0)

A second, longer-interval consolidation lane with DB-backed exclusivity, stale-first batching, and `maintenance_runs` journaling. Off by default; canonical host is `clawmem watch`.

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_HEAVY_LANE` | disabled | Enable the quiet-window heavy lane. |
| `CLAWMEM_HEAVY_LANE_INTERVAL` | `1800000` | Tick interval in ms (min 30000, default 30 min). |
| `CLAWMEM_HEAVY_LANE_WINDOW_START` | (none) | Start hour (0–23) of the quiet window. Unset → no window. |
| `CLAWMEM_HEAVY_LANE_WINDOW_END` | (none) | End hour (0–23, exclusive). Supports midnight wrap (22→6). |
| `CLAWMEM_HEAVY_LANE_MAX_USAGES` | `30` | Max `context_usage` rows in the last 10 min before the lane skips (`reason='query_rate_high'`). |
| `CLAWMEM_HEAVY_LANE_OBS_LIMIT` | `100` | Phase 2 stale-first observation batch size. |
| `CLAWMEM_HEAVY_LANE_DED_LIMIT` | `40` | Phase 3 stale-first deductive candidate batch size. |
| `CLAWMEM_HEAVY_LANE_SURPRISAL` | `false` | When `true`, seed Phase 2 with k-NN anomaly-ranked doc ids instead of stale-first. Degrades to stale-first on vaults without embeddings. |

## Merge & contradiction safety (v0.7.1)

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_MERGE_SCORE_NORMAL` | `0.93` | Phase 2 merge-safety threshold (normalized 3-gram cosine) when anchors align. |
| `CLAWMEM_MERGE_SCORE_STRICT` | `0.98` | Strictest merge-safety threshold (fallback when anchors are ambiguous). |
| `CLAWMEM_MERGE_GUARD_DRY_RUN` | `false` | When `true`, merge-safety rejections are logged but not enforced — calibration before switching the gate on. |
| `CLAWMEM_CONTRADICTION_POLICY` | `link` | How the merge-time contradiction gate handles a contradictory merge. `link` keeps both rows + adds a `contradicts` edge; `supersede` marks the old row `status='inactive'`. |
| `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE` | `0.5` | Minimum combined (heuristic + LLM) confidence before the gate blocks a merge. Below this, the merge proceeds. |

## REST API & Hermes plugin

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_API_TOKEN` | (none) | When set, `clawmem serve` requires `Authorization: Bearer <token>` on all requests. Unset → open (localhost-only by default). |
| `CLAWMEM_SERVE_PORT` | `7438` | REST API port read by the **Hermes plugin** (to launch/connect to `clawmem serve`). Manual `clawmem serve` takes `--port` instead — it does not read this env var. |
| `CLAWMEM_SERVE_MODE` | `external` | Hermes plugin serve mode: `external` (you run `clawmem serve`) or `managed` (the plugin starts/stops `serve`). |
| `CLAWMEM_BIN` | (auto-detect on PATH) | Path to the `clawmem` binary, for the Hermes plugin when it is not on `PATH`. |

## Hooks, session & paths

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_CONFIG_DIR` | `~/.config/clawmem` | Override the config directory (holds `config.yaml`). |
| `CLAWMEM_SESSION_ID` | (Claude Code exposes its own) | Session id for the per-session focus topic; set explicitly in non-Claude-Code environments. |
| `CLAWMEM_FOCUS_ROOT` | `~/.cache/clawmem/sessions` | Directory for per-session focus files (`clawmem focus`). |
| `CLAWMEM_SESSION_FOCUS` | (none) | **Debug only.** Directly overrides the session focus topic, bypassing the focus file. |
| `CLAWMEM_DEBUG_LLM_RAW` | `false` | **Debug only.** Set `true` to log the raw model response when the contradiction parse gate rejects it (truncated to 160 chars). Off by default because the extraction prompt carries transcript-derived material, so raw output is a content-exposure path in ordinary operation — the gate always logs response shape, length, content hash and served model identity regardless. |
| `CLAWMEM_HEARTBEAT_PATTERNS` | (built-in set) | Comma-separated prompt patterns treated as heartbeats (skipped by context-surfacing). |
| `CLAWMEM_DISABLE_HEARTBEAT_SUPPRESSION` | `false` | Set `true` to disable heartbeat-prompt suppression in the context-surfacing hook. |
| `CLAWMEM_HOOK_DEDUP_WINDOW_SEC` | (built-in) | Window (seconds) for deduplicating hook-generated observations by normalized content hash. |
| `CLAWMEM_PRECOMPACT_PROXIMITY_RATIO` | (built-in, clamped [0.5, 0.95]) | OpenClaw `before_prompt_build` precompact trigger: fraction of the compaction threshold at which pre-emptive extraction fires. |
