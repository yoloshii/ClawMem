# ClawMem — Agent Quick Reference

## Inference Services

ClawMem uses three `llama-server` instances for neural inference. By default, the `bin/clawmem` wrapper points at `localhost:8088/8089/8090`.

**Default (QMD native combo, any GPU or in-process):**

| Service | Port | Model | VRAM | Protocol |
|---|---|---|---|---|
| Embedding | 8088 | EmbeddingGemma-300M-Q8_0 | ~400MB | `/v1/embeddings` |
| LLM | 8089 | qmd-query-expansion-1.7B-q4_k_m | ~2.2GB | `/v1/chat/completions` |
| Reranker | 8090 | qwen3-reranker-0.6B-Q8_0 | ~1.3GB | `/v1/rerank` |

All three models auto-download via `node-llama-cpp` if no server is running (Metal on Apple Silicon, Vulkan where available, CPU as last resort). Fast with GPU acceleration (Metal/Vulkan); significantly slower on CPU-only.

**SOTA upgrade (12GB+ GPU):** CC-BY-NC-4.0 — non-commercial only.

| Service | Port | Model | VRAM | Protocol |
|---|---|---|---|---|
| Embedding | 8088 | zembed-1-Q4_K_M | ~4.4GB | `/v1/embeddings` |
| LLM | 8089 | qmd-query-expansion-1.7B-q4_k_m | ~2.2GB | `/v1/chat/completions` |
| Reranker | 8090 | zerank-2-Q4_K_M | ~3.3GB | `/v1/rerank` |

Total ~10GB VRAM. zembed-1 (2560d, 32K context, SOTA retrieval) distilled from zerank-2 via zELO. Optimal pairing.

**Remote option:** Set `CLAWMEM_EMBED_URL`, `CLAWMEM_LLM_URL`, `CLAWMEM_RERANK_URL` to the remote host. Set `CLAWMEM_NO_LOCAL_MODELS=true` to prevent surprise fallback downloads.

**Cloud embedding:** Set `CLAWMEM_EMBED_API_KEY` + `CLAWMEM_EMBED_URL` + `CLAWMEM_EMBED_MODEL` to use a cloud provider instead of local GPU. Supported: Jina AI (recommended: `jina-embeddings-v5-text-small`, 1024d), OpenAI, Voyage, Cohere. Cloud mode enables batch embedding (50 frags/request), provider-specific retrieval params auto-detected from URL (Jina `task`, Voyage/Cohere `input_type`), server-side truncation, and adaptive TPM-aware pacing. Set `CLAWMEM_EMBED_TPM_LIMIT` to match your tier.

**Qwen3 /no_think flag:** Qwen3 uses thinking tokens by default. ClawMem appends `/no_think` to all prompts automatically for structured output.

### Model Recommendations

| Role | Default (QMD native) | SOTA Upgrade | Notes |
|---|---|---|---|
| Embedding | [EmbeddingGemma-300M-Q8_0](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF) (314MB, 768d) | [zembed-1-Q4_K_M](https://huggingface.co/Abhiray/zembed-1-Q4_K_M-GGUF) (2.4GB, 2560d) | zembed-1: 32K context, SOTA retrieval. `-ub` must match `-b`. |
| LLM | [qmd-query-expansion-1.7B-q4_k_m](https://huggingface.co/tobil/qmd-query-expansion-1.7B-gguf) (~1.1GB) | Same | QMD's Qwen3-1.7B finetune for query expansion. |
| Reranker | [qwen3-reranker-0.6B-Q8_0](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) (~600MB) | [zerank-2-Q4_K_M](https://huggingface.co/keisuke-miyako/zerank-2-gguf-q4_k_m) (2.4GB) | zerank-2: outperforms Cohere rerank-3.5. `-ub` must match `-b`. |

### Server Setup (all three use llama-server)

```bash
# === Default (QMD native combo) ===

# Embedding (--embeddings flag required)
llama-server -m embeddinggemma-300M-Q8_0.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 2048

# LLM (QMD finetuned model)
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf \
  --port 8089 --host 0.0.0.0 -ngl 99 -c 4096 --batch-size 512

# Reranker
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 512

# === SOTA upgrade (12GB+ GPU) — -ub must match -b for non-causal attention ===

# Embedding
llama-server -m zembed-1-Q4_K_M.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 8192 -b 2048 -ub 2048

# Reranker
llama-server -m zerank-2-Q4_K_M.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 -b 2048 -ub 2048
```

### Verify Endpoints

```bash
# Embedding
curl http://host:8088/v1/embeddings -d '{"input":"test","model":"embedding"}' -H 'Content-Type: application/json'

# LLM
curl http://host:8089/v1/models

# Reranker
curl http://host:8090/v1/models
```

## Environment Variable Reference

| Variable | Default (via wrapper) | Effect |
|---|---|---|
| `CLAWMEM_EMBED_URL` | `http://localhost:8088` | Embedding server URL. Local llama-server, cloud API, or falls back to in-process `node-llama-cpp` if unset. |
| `CLAWMEM_EMBED_API_KEY` | (none) | API key for cloud embedding providers. Sent as Bearer token. Enables cloud mode: skips client-side truncation, sends `truncate: true` + `task` param (LoRA adapter selection for Jina v5), and activates batch embedding with adaptive TPM-aware pacing. |
| `CLAWMEM_EMBED_MODEL` | `embedding` | Model name for embedding requests. Override for cloud providers (e.g. `jina-embeddings-v5-text-small`). |
| `CLAWMEM_EMBED_MAX_CHARS` | `6000` | Max chars per embedding input. Default fits EmbeddingGemma (2048 tokens). Set to `1100` for granite-278m (512 tokens). Cloud providers skip truncation. |
| `CLAWMEM_EMBED_TPM_LIMIT` | `100000` | Tokens-per-minute limit for cloud embedding pacing. Match to your provider tier: Free 100000, Paid 2000000, Premium 50000000. |
| `CLAWMEM_EMBED_DIMENSIONS` | (none) | Output dimensions for OpenAI `text-embedding-3-*` Matryoshka models (e.g. `512`, `1024`). Only sent when URL contains `openai.com`. |
| `CLAWMEM_LLM_URL` | `http://localhost:8089` | LLM server for intent, expansion, A-MEM, and entity extraction. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. For better entity extraction quality, point at a 7B+ model or cloud API during `reindex --enrich` (see `docs/internals/entity-resolution.md`). |
| `CLAWMEM_RERANK_URL` | `http://localhost:8090` | Reranker server. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. |
| `CLAWMEM_NO_LOCAL_MODELS` | `false` | Blocks `node-llama-cpp` from auto-downloading GGUF models. Set `true` for remote-only setups. |
| `CLAWMEM_VAULTS` | (none) | JSON map of vault name → SQLite path for multi-vault mode. E.g. `{"work":"~/.cache/clawmem/work.sqlite"}` |
| `CLAWMEM_ENABLE_AMEM` | enabled | A-MEM note construction + link generation during indexing. |
| `CLAWMEM_ENABLE_CONSOLIDATION` | disabled | Background worker backfills unenriched docs. Needs long-lived MCP process. |
| `CLAWMEM_CONSOLIDATION_INTERVAL` | 300000 | Worker interval in ms (min 15000). |
| `CLAWMEM_HEAVY_LANE` | disabled | **v0.8.0.** Enable the quiet-window heavy maintenance worker — a second, longer-interval consolidation lane with DB-backed `worker_leases` exclusivity, stale-first batching, and `maintenance_runs` journaling. Runs alongside the light lane; off by default. |
| `CLAWMEM_HEAVY_LANE_INTERVAL` | 1800000 | **v0.8.0.** Heavy-lane tick interval in ms (min 30000, default 30 min). |
| `CLAWMEM_HEAVY_LANE_WINDOW_START` | (none) | **v0.8.0.** Start hour (0-23) of the quiet window. Unset → no window. |
| `CLAWMEM_HEAVY_LANE_WINDOW_END` | (none) | **v0.8.0.** End hour (0-23, exclusive) of the quiet window. Supports midnight wrap (22→6). |
| `CLAWMEM_HEAVY_LANE_MAX_USAGES` | 30 | **v0.8.0.** Max `context_usage` rows in the last 10 min before the heavy lane skips with `reason='query_rate_high'`. |
| `CLAWMEM_HEAVY_LANE_OBS_LIMIT` | 100 | **v0.8.0.** Phase 2 stale-first observation batch size. |
| `CLAWMEM_HEAVY_LANE_DED_LIMIT` | 40 | **v0.8.0.** Phase 3 stale-first deductive candidate batch size. |
| `CLAWMEM_HEAVY_LANE_SURPRISAL` | `false` | **v0.8.0.** When `true`, the heavy lane seeds Phase 2 with k-NN anomaly-ranked doc ids from `computeSurprisalScores` instead of stale-first ordering. Degrades to stale-first (`surprisal-fallback-stale` metric) on vaults without embeddings. |
| `CLAWMEM_NUDGE_INTERVAL` | `15` | Prompts between lifecycle tool use before `<vault-nudge>` injection. 0 to disable. |
| `CLAWMEM_MERGE_SCORE_NORMAL` | `0.93` | **v0.7.1.** Phase 2 merge-safety score threshold when candidate and existing anchors align. Merges above this normalized 3-gram cosine similarity are allowed. |
| `CLAWMEM_MERGE_SCORE_STRICT` | `0.98` | **v0.7.1.** Strictest merge-safety score threshold (fallback when anchors are ambiguous). |
| `CLAWMEM_MERGE_GUARD_DRY_RUN` | `false` | **v0.7.1.** When `true`, Phase 2 merge-safety rejections are logged but not enforced — use for calibration before switching on the gate. |
| `CLAWMEM_CONTRADICTION_POLICY` | `link` | **v0.7.1.** How the merge-time contradiction gate handles a contradictory merge. `link` keeps both rows active and inserts a `contradicts` edge. `supersede` marks the old row `status='inactive'`. |
| `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE` | `0.5` | **v0.7.1.** Minimum combined (heuristic + LLM) confidence required before the contradiction gate blocks a merge. Below this, the merge proceeds. |

**Note:** The `bin/clawmem` wrapper sets all endpoint defaults. Always use the wrapper — never `bun run src/clawmem.ts` directly. For remote GPU setups, add the same env vars to the watcher service via a systemd drop-in.

## Quick Setup

```bash
# Install via npm
bun add -g clawmem   # or: npm install -g clawmem

# Or from source
git clone https://github.com/yoloshii/clawmem.git ~/clawmem
cd ~/clawmem && bun install
ln -sf ~/clawmem/bin/clawmem ~/.bun/bin/clawmem

# Bootstrap a vault (init + index + embed + hooks + MCP)
clawmem bootstrap ~/notes --name notes

# Or step by step:
./bin/clawmem init
./bin/clawmem collection add ~/notes --name notes
./bin/clawmem update --embed
./bin/clawmem setup hooks
./bin/clawmem setup mcp

# Verify
./bin/clawmem doctor    # Full health check
./bin/clawmem status    # Quick index status
```

### Background Services (systemd user units)

The watcher and embed timer keep the vault fresh automatically. Create these after setup:

```bash
# Create systemd user directory
mkdir -p ~/.config/systemd/user

# clawmem-watcher.service — auto-indexes on .md changes
cat > ~/.config/systemd/user/clawmem-watcher.service << 'EOF'
[Unit]
Description=ClawMem file watcher — auto-indexes on .md changes
After=default.target

[Service]
Type=simple
ExecStart=%h/clawmem/bin/clawmem watch
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

# clawmem-embed.service — oneshot embedding sweep
cat > ~/.config/systemd/user/clawmem-embed.service << 'EOF'
[Unit]
Description=ClawMem embedding sweep

[Service]
Type=oneshot
ExecStart=%h/clawmem/bin/clawmem embed
EOF

# clawmem-embed.timer — daily at 04:00
cat > ~/.config/systemd/user/clawmem-embed.timer << 'EOF'
[Unit]
Description=ClawMem daily embedding sweep

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now clawmem-watcher.service clawmem-embed.timer

# Persist across reboots (start without login)
loginctl enable-linger $(whoami)

# Verify
systemctl --user status clawmem-watcher.service clawmem-embed.timer
```

**Note:** The service files use `%h` (home directory specifier). If clawmem is installed elsewhere, update `ExecStart` paths. For remote GPU setups, add `Environment=CLAWMEM_EMBED_URL=http://host:8088` etc. to both service files (the `bin/clawmem` wrapper sets defaults).

---

## OpenClaw Integration: Memory System Configuration

When using ClawMem with OpenClaw, choose one of two deployment options:

### Option 1: ClawMem Exclusive (Recommended)

ClawMem handles 100% of memory operations via hooks + MCP tools. Zero redundancy.

**Benefits:**
- No context window waste (avoids 10-15% duplicate injection)
- Prevents OpenClaw native memory auto-initialization on updates
- All memory in ClawMem's hybrid search + graph traversal system

**Configuration:**
```bash
# Disable OpenClaw's native memory
openclaw config set agents.defaults.memorySearch.extraPaths "[]"

# Verify
openclaw config get agents.defaults.memorySearch
# Expected: {"extraPaths": []}

# Confirm no native memory index exists
ls ~/.openclaw/agents/main/memory/
# Expected: "No such file or directory"
```

**Memory distribution:**
- **Tier 2 (90%):** Hooks auto-inject context (session-bootstrap, context-surfacing, staleness-check, decision-extractor, handoff-generator, feedback-loop)
- **Tier 3 (10%):** Agent-initiated MCP tools (query, intent_search, find_causal_links, etc.)

### Option 2: Hybrid (ClawMem + Native)

Run both ClawMem and OpenClaw's native memory for redundancy.

**Configuration:**
```bash
openclaw config set agents.defaults.memorySearch.extraPaths '["~/documents", "~/notes"]'
```

**Tradeoffs:**
- ✅ Redundant recall from two independent systems
- ❌ 10-15% context window waste from duplicate facts
- ❌ Two memory indices to maintain

**Recommendation:** Use Option 1 unless you have a specific need for redundant memory systems.

---

## Memory Retrieval (90/10 Rule)

ClawMem hooks handle ~90% of retrieval automatically. Agent-initiated MCP calls cover the remaining ~10%.

### Tier 2 — Automatic (hooks, zero agent effort)

| Hook | Trigger | Budget | Content |
|------|---------|--------|---------|
| `context-surfacing` | UserPromptSubmit | profile-driven (default 800) | retrieval gate → **multi-turn query construction** (v0.8.1: current prompt + up to 2 recent same-session priors from `context_usage.query_text`, 10-min max age, capped at 2000 chars with current-first preservation — used only for discovery: vector/FTS/expansion, NOT for rerank/scoring/snippet extraction) → profile-driven hybrid search (vector if `useVector`, timeout from profile) → FTS supplement → file-aware supplemental search (E13, raw current prompt) → snooze filter → noise filter → spreading activation (E11: co-activated doc boost) → memory type diversification (E10) → tiered injection (HOT/WARM/COLD snippets) → `<vault-context><instruction>…</instruction><facts>…</facts><relationships>…</relationships></vault-context>` (v0.7.1: instruction always prepended when context is returned; relationships block lists memory-graph edges where BOTH endpoints are in the surfaced set, truncated first when over budget) + optional `<vault-routing>` hint. Budget, max results, vector timeout, and min score all driven by `CLAWMEM_PROFILE`. Raw prompt persisted to `context_usage.query_text` for future multi-turn lookback — except on gated skip paths (slash commands, heartbeats, too-short prompts) where the text is withheld for privacy. |
| `postcompact-inject` | SessionStart (compact) | 1200 tokens | re-injects authoritative context after compaction: precompact state (600) + recent decisions (400) + antipatterns (150) + vault context (200) → `<vault-postcompact>` |
| `curator-nudge` | SessionStart | 200 tokens | surfaces curator report actions, nudges when report is stale (>7 days) |
| `precompact-extract` | PreCompact | — | extracts decisions, file paths, open questions → writes `precompact-state.md` to auto-memory. Query-aware decision ranking. Reindexes auto-memory collection. |
| `decision-extractor` | Stop | — | LLM extracts observations → `_clawmem/agent/observations/`, infers causal links, detects contradictions, extracts SPO triples from decision/preference/milestone/problem facts. Background consolidation worker synthesizes deductive observations from related facts (Phase 3, every ~15 min). |
| `handoff-generator` | Stop | — | LLM summarizes session → `_clawmem/agent/handoffs/` |
| `feedback-loop` | Stop | — | tracks referenced notes → boosts confidence, records usage relations + co-activations between co-referenced docs, tracks utility signals (surfaced vs referenced ratio for lifecycle automation), per-turn recall attribution (marks which surfaced docs were cited in which turn) |

**Default behavior:** Read injected `<vault-context>` first. If sufficient, answer immediately.

**Hook blind spots (by design):** Hooks filter out `_clawmem/` system artifacts, enforce score thresholds, and cap token budget. Absence in `<vault-context>` does NOT mean absence in memory. If you expect a memory to exist but it wasn't surfaced, escalate to Tier 3.

**Adaptive thresholds:** Context-surfacing uses ratio-based scoring that adapts to vault characteristics (size, document quality, content age, embedding model). Results are kept within a percentage of the best result's composite score rather than a fixed absolute threshold. An activation floor prevents surfacing when all results are weak. Profiles control the ratio: `speed` (65%), `balanced` (55%), `deep` (45% + query expansion + reranking). `CLAWMEM_PROFILE=deep` is recommended for vaults with older content or lower-quality documents. MCP tools use fixed absolute thresholds, not adaptive.

### Tier 3 — Agent-Initiated (one targeted MCP call)

**Escalate ONLY when one of these three rules fires:**
1. **Low-specificity injection** — `<vault-context>` is empty or lacks the specific fact/chain the task requires. Hooks surface top-k by relevance; if the needed memory wasn't in top-k, escalate.
2. **Cross-session question** — the task explicitly references prior sessions or decisions: "why did we decide X", "what changed since last time", "when did we start doing Y".
3. **Pre-irreversible check** — about to make a destructive or hard-to-reverse change (deletion, config change, architecture decision). Check vault for prior decisions before proceeding.

All other retrieval is handled by Tier 2 hooks. Do NOT call MCP tools speculatively or "just to be thorough."

**Once escalated, route by query type:**

**PREFERRED:** `memory_retrieve(query)` — auto-classifies and routes to the optimal backend (query, intent_search, session_log, find_similar, or query_plan). Use this instead of manually choosing a tool below.

```
1a. General recall → query(query, compact=true, limit=20)
    Full hybrid: BM25 + vector + query expansion + deep reranking (4000 char).
    Supports compact, collection filter (comma-separated for multi-collection: `"col1,col2"`), intent, and candidateLimit.
    Default for most Tier 3 needs.
    Optional: intent="domain hint" for ambiguous queries (steers expansion, reranking, chunk selection, snippets).
    Optional: candidateLimit=N to tune precision/speed (default 30).
    BM25 strong-signal bypass: skips expansion when top BM25 hit ≥ 0.85 with gap ≥ 0.15 (disabled when intent is provided).

1b. Causal/why/when/entity → intent_search(query, enable_graph_traversal=true)
    MAGMA intent classification + intent-weighted RRF + multi-hop graph traversal.
    Use DIRECTLY (not as fallback) when the question is "why", "when", "how did X lead to Y",
    or needs entity-relationship traversal.
    Override auto-detection: force_intent="WHY"|"WHEN"|"ENTITY"|"WHAT"
    When to override:
      WHY — "why", "what led to", "rationale", "tradeoff", "decision behind"
      ENTITY — named component/person/service needing cross-doc linkage, not just keyword hits
      WHEN — timelines, first/last occurrence, "when did this change/regress"
    WHEN note: start with enable_graph_traversal=false (BM25-biased); fall back to query() if recall drifts.

    Choose 1a or 1b based on query type. They are parallel options, not sequential.

1c. Multi-topic/complex → query_plan(query, compact=true)
    Decomposes query into 2-4 typed clauses (bm25/vector/graph), executes in parallel, merges via RRF.
    Use when query spans multiple topics or needs both keyword and semantic recall simultaneously.
    Falls back to single-query behavior for simple queries (planner returns 1 clause).

2. Progressive disclosure → multi_get("path1,path2") for full content of top hits

3. Spot checks → search(query) (BM25, 0 GPU) or vsearch(query) (vector, 1 GPU)

4. Chain tracing → find_causal_links(docid, direction="both", depth=5)
   Traverses causal edges between _clawmem/agent/observations/ docs (from decision-extractor).

5. Entity facts → kg_query(entity, as_of?, direction?)
   Structured SPO triples with temporal validity. Different from intent_search:
   - kg_query: "what does ClawMem relate to?" → returns structured facts (subject-predicate-object)
   - intent_search: "why did we choose ClawMem?" → returns documents with causal reasoning
   Use kg_query for entity lookup, intent_search for causal chains.

6. Memory debugging → memory_evolution_status(docid)

7. Temporal context → timeline(docid, before=5, after=5, same_collection=false)
   Shows what was created/modified before and after a document.
   Use after search to understand chronological neighborhood.
```

**Other tools:**
- `find_similar(docid)` — "what else relates to X". k-NN vector neighbors — discovers connections beyond keyword overlap.
- `session_log` — USE THIS for "last time", "yesterday", "what did we do". DO NOT use `query()` for cross-session questions.
- `profile` — user profile (static facts + dynamic context).
- `memory_forget(query)` — deactivate a memory by closest match.
- `memory_pin(query, unpin?)` — +0.3 composite boost. USE PROACTIVELY for constraints, architecture decisions, corrections.
- `memory_snooze(query, until?)` — USE PROACTIVELY when `<vault-context>` surfaces noise — snooze 30 days.
- `build_graphs(temporal?, semantic?)` — build temporal backbone + semantic graph after bulk ingestion. Not needed after routine indexing (A-MEM handles per-doc links).
- `beads_sync(project_path?)` — sync Beads issues from Dolt backend (via `bd` CLI) into memory. Usually automatic via watcher.
- `query_plan(query, compact=true)` — USE THIS for multi-topic queries. `query()` searches as one blob — this splits topics and routes each optimally.
- `timeline(docid, before=5, after=5, same_collection=false)` — temporal neighborhood around a document. Progressive disclosure: search → timeline → get. Supports same-collection scoping and session correlation.
- `list_vaults()` — show configured vault names and paths. Empty in single-vault mode (default).
- `vault_sync(vault, content_root, pattern?, collection_name?)` — index markdown from a directory into a named vault. Restricted-path validation rejects sensitive directories (`/etc/`, `/root/`, `.ssh`, `.env`, `credentials`, etc.).
- `kg_query(entity, as_of?, direction?)` — query the SPO knowledge graph for an entity's relationships. Returns temporal triples with validity windows. USE THIS for "what does X relate to?", "what was true about X in January?". Uses entity resolution for lookup.
- `diary_write(entry, topic?, agent?)` — write a diary entry. USE PROACTIVELY in non-hooked environments (Hermes, Gemini, plain MCP) for recording important events and decisions. Do NOT use in Claude Code (hooks handle this automatically).
- `diary_read(last_n?, agent?)` — read recent diary entries.

### Multi-Vault

All tools accept an optional `vault` parameter — retrieval (query, search, vsearch, intent_search, memory_retrieve, query_plan), document access (get, multi_get, find_similar, find_causal_links, timeline, memory_evolution_status, session_log), mutations (memory_pin, memory_snooze, memory_forget), lifecycle (lifecycle_status, lifecycle_sweep, lifecycle_restore), and maintenance (status, reindex, index_stats, build_graphs). Omit `vault` for the default vault (single-vault mode). Named vaults are configured in `~/.config/clawmem/config.yaml` under `vaults:` or via `CLAWMEM_VAULTS` env var. Vault paths support `~` expansion.

### Memory Lifecycle

Pin, snooze, and forget are **manual MCP tools** — not automated. The agent should proactively use them when appropriate:

- **Pin** (`memory_pin`) — +0.3 composite boost, ensures persistent surfacing.
  - **Proactive triggers:** User says "remember this" / "don't forget" / "this is important". Architecture or critical design decision just made. User-stated preference or constraint that should persist across sessions.
  - **Do NOT pin:** routine decisions, session-specific context, or observations that will naturally surface via recency.
- **Snooze** (`memory_snooze`) — temporarily hides from context surfacing until a date.
  - **Proactive triggers:** A memory keeps surfacing but isn't relevant to current work. User says "not now" / "later" / "ignore this for now". Seasonal or time-boxed content (e.g., "revisit after launch").
- **Forget** (`memory_forget`) — permanently deactivates. Use sparingly.
  - Only when a memory is genuinely wrong or permanently obsolete. Prefer snooze for temporary suppression.
- **Contradictions auto-resolve:** When `decision-extractor` detects a new decision contradicting an old one, the old decision's confidence is lowered automatically. No manual intervention needed for superseded decisions. **v0.7.1:** the consolidation worker adds a merge-time contradiction gate — before any Phase 2 merge, it runs a deterministic heuristic + LLM check and either links contradictory observations via a `contradicts` edge (default) or marks the prior row `status='inactive'` (when `CLAWMEM_CONTRADICTION_POLICY=supersede`). Phase 3 deductive synthesis applies the same gate to deductive dedupe matches.

### Anti-Patterns

- Do NOT manually pick query/intent_search/search when `memory_retrieve` can auto-route.
- Do NOT call MCP tools every turn — three rules above are the only gates.
- Do NOT re-search what's already in `<vault-context>`.
- Do NOT run `status` routinely. Only when retrieval feels broken or after large ingestion.
- Do NOT pin everything — pin is for persistent high-priority items, not temporary boosting.
- Do NOT forget memories to "clean up" — let confidence decay and contradiction detection handle it naturally.
- Do NOT run `build_graphs` after every reindex — A-MEM creates per-doc links automatically. Only after bulk ingestion or when `intent_search` returns weak graph results.
- Do NOT run `clawmem mine` autonomously — it is a bulk ingestion command (same category as `update`/`reindex`). Suggest it to the user when they mention old conversation exports, but let them run it. Bulk import has disk/embedding cost implications that need user consent. **v0.7.2 adds `--synthesize`** — an opt-in post-import LLM fact extraction pass that turns raw conversation dumps into searchable structured decisions / preferences / milestones / problems with cross-fact relations. Off by default; also requires user consent because it drives additional LLM calls (one per conversation doc). Suggest both together when the user wants to get real value out of old chat exports, not just the raw dumps.
- Do NOT use `diary_write` in Claude Code — hooks (`decision-extractor`, `handoff-generator`) capture this automatically. Diary is for non-hooked environments only (Hermes, Gemini, plain MCP clients).
- Do NOT use `kg_query` for causal "why" questions — use `intent_search` or `memory_retrieve`. `kg_query` returns structured entity facts (SPO triples), not reasoning chains.

## Tool Selection (one-liner)

```
ClawMem escalation: memory_retrieve(query) | query(compact=true) | intent_search(why/when/entity) | query_plan(multi-topic) → multi_get → search/vsearch (spot checks)
```

## Curator Agent

Maintenance agent for Tier 3 operations the main agent typically neglects. Install with `clawmem setup curator`.

**Invoke:** "curate memory", "run curator", or "memory maintenance"

**6 phases:**
1. Health snapshot — status, index_stats, lifecycle_status, doctor
2. Lifecycle triage — pin high-value unpinned memories, snooze stale content, propose forget candidates (never auto-confirms)
3. Retrieval health check — 5 probes (BM25, vector, hybrid, intent/graph, lifecycle)
4. Maintenance — reflect (cross-session patterns), consolidate --dry-run (dedup candidates)
5. Graph rebuild — conditional on probe results and embedding state
6. Collection hygiene — orphan detection, content type distribution

**Safety rails:** Never auto-confirms forget. Never runs embed (timer's job). Never modifies config.yaml. All destructive proposals require user approval.

## Query Optimization

The pipeline autonomously generates lex/vec/hyde variants, fuses BM25 + vector via RRF, and reranks with a cross-encoder. Agents do NOT choose search types — the pipeline handles fusion internally. The optimization levers are: **tool selection**, **query string quality**, **intent**, and **candidateLimit**.

### Tool Selection (highest impact)

Pick the lightest tool that satisfies the need:

| Tool | Cost | When |
|------|------|------|
| `search(q, compact=true)` | BM25 only, 0 GPU | Know exact terms, spot-check, fast keyword lookup |
| `vsearch(q, compact=true)` | Vector only, 1 GPU call | Conceptual/fuzzy, don't know vocabulary |
| `query(q, compact=true)` | Full hybrid, 3+ GPU calls | General recall, unsure which signal matters |
| `intent_search(q)` | Hybrid + graph | Why/entity chains (graph traversal), when queries (BM25-biased) |
| `query_plan(q)` | Hybrid + decomposition | Complex multi-topic queries needing parallel typed retrieval |

Use `search` for quick keyword spot-checks. Use `query` for general recall (default Tier 3 workhorse). Use `intent_search` directly (not as fallback) when the question is causal or relational.

### Query String Quality

The query string feeds BM25 directly (probes first, can short-circuit the pipeline) and anchors the 2×-weighted original signal in RRF.

**For keyword recall (BM25):** 2-5 precise terms, no filler. Code identifiers work. BM25 AND's all terms as prefix matches (`perf` matches "performance") — no phrase search or negation syntax. A strong hit (≥ 0.85 with gap ≥ 0.15) skips expansion — faster results.

**For semantic recall (vector):** Full natural language question, be specific. `"in the payment service, how are refunds processed"` > `"refunds"`.

**Do NOT write hypothetical-answer-style queries.** The expansion LLM already generates hyde variants internally. A long hypothetical dilutes BM25 scoring and duplicates what the pipeline does autonomously.

### Intent Parameter

Steers 5 autonomous stages: expansion, reranking, chunk selection, snippet extraction, and strong-signal bypass (disabled when intent is provided).

Use when: query term has multiple meanings in the vault, domain is known but query alone is ambiguous.
Do NOT use when: query is already specific, single-domain vault, using `search`/`vsearch` (intent only affects `query`).

Note: intent disables BM25 strong-signal bypass, forcing full expansion+reranking. Correct behavior — intent means the query is ambiguous, so keyword confidence alone is insufficient.

## Composite Scoring (automatic, applied to all search tools)

**Observation invalidation (v0.2.0):** Documents with `invalidated_at` set are excluded from search results. Soft invalidation uses `invalidated_at`, `invalidated_by`, and `superseded_by` columns. When `decision-extractor` detects a contradiction that drops confidence ≤ 0.2, the observation is marked invalidated. Invalidated docs can be restored via lifecycle tools.

```
compositeScore = (0.50 × searchScore + 0.25 × recencyScore + 0.25 × confidenceScore) × qualityMultiplier × coActivationBoost
```

Where `qualityMultiplier = 0.7 + 0.6 × qualityScore` (range: 0.7× penalty to 1.3× boost).
`coActivationBoost = 1 + min(coCount/10, 0.15)` — documents frequently surfaced together get up to 15% boost.
Length normalization: `1/(1 + 0.5 × log2(max(bodyLength/500, 1)))` — penalizes verbose entries, floor at 30%.
Frequency boost: `freqSignal = (revisions-1)×2 + (duplicates-1)`, `freqBoost = min(0.10, log1p(freqSignal)×0.03)`. Revision count weighted 2× vs duplicate count. Capped at 10%.
Pinned documents get +0.3 additive boost (capped at 1.0).

Recency intent detected ("latest", "recent", "last session"):
```
compositeScore = (0.10 × searchScore + 0.70 × recencyScore + 0.20 × confidenceScore) × qualityMultiplier × coActivationBoost
```

| Content Type | Half-Life | Effect |
|--------------|-----------|--------|
| decision, deductive, preference, hub | ∞ | Never decay |
| antipattern | ∞ | Never decay — accumulated negative patterns persist |
| project | 120 days | Slow decay |
| research | 90 days | Moderate decay |
| problem, milestone, note | 60 days | Default |
| conversation, progress | 45 days | Faster decay |
| handoff | 30 days | Fast — recent matters most |

Half-lives extend up to 3× for frequently-accessed memories (access reinforcement decays over 90 days).
Attention decay: non-durable types (handoff, progress, conversation, note, project) lose 5% confidence per week without access. Decision/deductive/preference/hub/research/antipattern are exempt.

## Indexing & Graph Building

### What Gets Indexed (per collection in config.yaml, symlinked as index.yml)

- `**/MEMORY.md` — any depth
- `**/memory/**/*.md`, `**/memory/**/*.txt` — session logs
- `**/docs/**/*.md`, `**/docs/**/*.txt` — documentation
- `**/research/**/*.md`, `**/research/**/*.txt` — research dumps
- `**/YYYY-MM-DD*.md`, `**/YYYY-MM-DD*.txt` — date-format records

### Excluded (even if pattern matches)

- `gits/`, `scraped/`, `.git/`, `node_modules/`, `dist/`, `build/`, `vendor/`

### Indexing vs Embedding (important distinction)

**Infrastructure (Tier 1, no agent action needed):**
- **`clawmem-watcher`** — keeps index + A-MEM fresh (continuous, on `.md` change). Also watches `.beads/` — routes changes to `syncBeadsIssues()` which queries `bd` CLI for live Dolt data (auto-bridges deps into `memory_relations`). Does NOT embed.
- **`clawmem-embed` timer** — keeps embeddings fresh (daily). Idempotent, skips already-embedded fragments.

**Quality scoring:** Each document gets a `quality_score` (0.0–1.0) computed during indexing based on length, structure (headings, lists), decision keywords, correction keywords, and frontmatter richness. Applied as a multiplier in composite scoring.

**Impact of missing embeddings:** `vsearch`, `query` (vector component), `context-surfacing` (vector component), and `generateMemoryLinks()` (neighbor discovery) all depend on embeddings. If embeddings are missing, these degrade silently — BM25 still works, but vector recall and inter-doc link quality suffer.

**Agent escape hatches (rare):**
- `clawmem embed` via CLI if you just wrote a doc and need immediate vector recall in the next turn.
- Manual `reindex` only when immediate index freshness is required and watcher hasn't caught up.

### Graph Population (memory_relations)

The `memory_relations` table is populated by multiple independent sources:

| Source | Edge Types | Trigger | Notes |
|--------|-----------|---------|-------|
| A-MEM `generateMemoryLinks()` | semantic, supporting, contradicts | Indexing (new docs only) | LLM-assessed confidence + reasoning. Requires embeddings for neighbor discovery. |
| A-MEM `inferCausalLinks()` | causal | Post-response (IO3 decision-extractor) | Links between `_clawmem/agent/observations/` docs, not arbitrary workspace docs. |
| Beads `syncBeadsIssues()` | causal, supporting, semantic | `beads_sync` MCP tool or watcher (.beads/ change) | Queries `bd` CLI (Dolt backend). Maps beads deps: blocks→causal, discovered-from→supporting, relates-to→semantic, plus conditional-blocks→causal, caused-by→causal, supersedes→supporting. Metadata: `{origin: "beads"}`. |
| `buildTemporalBackbone()` | temporal | `build_graphs` MCP tool (manual) | Creation-order edges between all active docs. |
| `buildSemanticGraph()` | semantic | `build_graphs` MCP tool (manual) | Pure cosine similarity. PK collision: `INSERT OR IGNORE` means A-MEM semantic edges take precedence if they exist first. |
| Entity co-occurrence graph | entity | A-MEM enrichment (indexing) | LLM entity extraction → quality filters (title/length/blocklist/location validation) → type-agnostic canonical resolution within compatibility buckets (person, org, location, tech=project/service/tool/concept) → `entity_mentions` + `entity_cooccurrences` tables. Entity edges use IDF-based specificity scoring. Feeds ENTITY intent queries and MPFP `[entity, semantic]` patterns. |
| `consolidated_observations` | supporting, contradicts | Consolidation worker (background, light + heavy lanes) | 3-tier consolidation: facts → observations → mental models. Observations track `proof_count`, `trend` (STABLE/STRENGTHENING/WEAKENING/STALE), and source links. **v0.7.1 safety gates:** name-aware merge gate uses entity-anchor comparison + 3-gram cosine similarity (dual-threshold `CLAWMEM_MERGE_SCORE_NORMAL`=0.93 / `_STRICT`=0.98) to prevent cross-entity merges ("Alice decided X" merging into "Bob decided X"). Merge-time contradiction gate runs deterministic heuristic + LLM check; blocked merges route to `CLAWMEM_CONTRADICTION_POLICY`=`link` (new row + `contradicts` edge, default) or `supersede` (old row `status='inactive'`, new row replaces). **v0.8.0:** the heavy lane calls `consolidateObservations(store, llm, { maxDocs, guarded: true, staleOnly: true })` — `guarded: true` forces merge-safety enforcement regardless of `CLAWMEM_MERGE_GUARD_DRY_RUN`, and `staleOnly: true` reorders candidates by `recall_stats.last_recalled_at ASC` so long-unseen docs bubble up first. Optional `candidateIds` filter plumbs k-NN anomaly ids from `computeSurprisalScores`. |
| Deductive synthesis | supporting, contradicts | Consolidation worker Phase 3 (background, every ~15 min in the light lane; batched in the heavy lane) | Combines 2-3 related recent observations (decision/preference/milestone/problem, last 7 days) into `content_type='deductive'` documents with `source_doc_ids` provenance. First-class searchable docs with ∞ half-life. **v0.7.1 anti-contamination wrapper:** every draft passes through deterministic pre-checks (empty conclusion, invalid source_indices, pool-only entity contamination via `entity_mentions` or lexical fallback) + LLM validator (fail-open with `validatorFallbackAccepts` counter) + dedupe. Per-reason rejection stats exposed via `DeductiveSynthesisStats` (contaminationRejects, invalidIndexRejects, unsupportedRejects, emptyRejects, dedupSkipped, validatorFallbackAccepts). Contradictory dedupe matches are linked via `contradicts` edges. **v0.8.0:** heavy lane calls `generateDeductiveObservations(store, llm, { maxRecent, guarded: true, staleOnly: true })` for stale-first batching on large vaults. |
| Heavy maintenance lane journal | — | `clawmem` process with `CLAWMEM_HEAVY_LANE=true` (v0.8.0) | Writes a row to the `maintenance_runs` table for every scheduled heavy-lane attempt (including skips). Columns: `lane` (`heavy`), `phase` (`gate`/`consolidate`/`deductive`), `status` (`started`/`completed`/`failed`/`skipped`), `reason` (`outside_window`/`query_rate_high`/`lease_unavailable`), per-phase `selected`/`processed`/`created`/`null_call` counts, and `metrics_json` with selector type (`stale-first`/`surprisal`/`surprisal-fallback-stale`) + full `DeductiveSynthesisStats` on completed Phase 3 runs. Exclusivity is enforced via the new `worker_leases` table with atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= ?` acquisition, random 16-byte fencing tokens, and TTL reclaim. Gate uses the existing `context_usage` table (no `query_activity` table) and `recall_stats.last_recalled_at` for stale-first ordering. Off by default — requires explicit opt-in. |
| Conversation synthesis (`runConversationSynthesis`) | semantic, supporting, contradicts, causal, temporal, entity | `clawmem mine <dir> --synthesize` (opt-in, post-index) | **v0.7.2.** Two-pass LLM pipeline over freshly imported `content_type='conversation'` docs. Pass 1 extracts structured facts (decision/preference/milestone/problem) via `extractFactsFromConversation`, saves each via dedup-aware `saveMemory`, populates a local Set-based alias map. Pass 2 resolves cross-fact links against the local map first (fails closed on ambiguity — multi-candidate titles return unresolved), falls back to collection-scoped SQL lookup with LIMIT 2 ambiguity detection. Relations upsert via `ON CONFLICT DO UPDATE SET weight = MAX(weight, excluded.weight)` — idempotent on equal-weight reruns but monotonically accepts stronger later evidence. Synthesized fact paths are a pure function of `(sourceDocId, slug(title), short sha256(normalizedTitle))`, so reruns update in place instead of creating parallel rows. Counters split into `llmFailures` (null/thrown/invalid-JSON) vs `docsWithNoFacts` (valid-empty extraction). All failures non-fatal — never rolls back the mine import. |

**Edge collision:** Both `generateMemoryLinks()` and `buildSemanticGraph()` insert `relation_type='semantic'`. PK is `(source_id, target_id, relation_type)` — first writer wins.

**Graph traversal asymmetry:** `adaptiveTraversal()` traverses all edge types outbound (source→target) but only `semantic` and `entity` edges inbound (target→source). Temporal and causal edges are directional only.

**MPFP graph retrieval (v0.2.0):** Multi-Path Fact Propagation runs predefined meta-path patterns in parallel (`[semantic, semantic]`, `[entity, temporal]`, `[semantic, causal]`, etc.), fuses via RRF. Hop-synchronized edge cache batches DB queries per hop instead of per pattern. Forward Push with α=0.15 teleport probability bounds active nodes sublinearly. Tier 3 only (`query`/`intent_search`), not hooks. Patterns selected per MAGMA intent: WHY → `[semantic, causal]`, ENTITY → `[entity, semantic]`, WHEN → `[temporal, semantic]`.

### When to Run `build_graphs`

- After **bulk ingestion** (many new docs at once) — adds temporal backbone and fills semantic gaps where A-MEM links are sparse.
- When `intent_search` for WHY/ENTITY returns **weak or obviously incomplete results** and you suspect graph sparsity.
- Do NOT run after every reindex. Routine indexing creates A-MEM links automatically for new docs.

### When to Run `index_stats`

- After bulk ingestion to verify doc counts and embedding coverage.
- When retrieval quality seems degraded — check for unembedded docs or content type distribution issues.
- Do NOT run routinely.

## Pipeline Details

### `query` (default Tier 3 workhorse)

```
User Query + optional intent hint
  → Temporal Extraction (regex date range from query: "last week", "March 2026" → WHERE modified_at BETWEEN filters)
  → BM25 Probe → Strong Signal Check (skip expansion if top hit ≥ 0.85 with gap ≥ 0.15; disabled when intent provided)
  → Query Expansion (LLM generates text variants; intent steers expansion prompt)
  → Parallel: BM25(original) + Vector(original) + BM25(each expanded) + Vector(each expanded)
       + Temporal Proximity (date-range filtered, if temporal constraint extracted)
       + Entity Graph (conditional 1-hop entity walk from top seeds, if entity signals present)
  → Original query lists get positional 2× weight in RRF; expanded get 1×
  → Reciprocal Rank Fusion (k=60, top candidateLimit, up to 4-way parallel legs)
  → Intent-Aware Chunk Selection (intent terms at 0.5× weight alongside query terms at 1.0×)
  → Cross-Encoder Reranking (4000 char context; intent prepended to rerank query; chunk dedup; batch cap=4)
  → Position-Aware Blending (α=0.75 top3, 0.60 mid, 0.40 tail)
  → SAME Composite Scoring
  → MMR Diversity Filter (Jaccard bigram similarity > 0.6 → demoted, not removed)
```

### `intent_search` (specialist for causal chains)

```
User Query → Intent Classification (WHY/WHEN/ENTITY/WHAT)
  → BM25 + Vector (intent-weighted RRF: boost BM25 for WHEN, vector for WHY)
  → Graph Traversal (WHY/ENTITY only; multi-hop beam search over memory_relations)
      Outbound: all edge types (semantic, supporting, contradicts, causal, temporal)
      Inbound: semantic and entity only
      Scores normalized to [0,1] before merge with search results
  → Cross-Encoder Reranking (200 char context per doc; file-keyed score join)
  → SAME Composite Scoring (uses stored confidence from contradiction detection + feedback)
```

### Key Differences

| Aspect | `query` | `intent_search` |
|--------|---------|-----------------|
| Query expansion | Yes (skipped on strong BM25 signal) | No |
| Intent hint | Yes (`intent` param steers 5 stages) | Auto-detected (WHY/WHEN/ENTITY/WHAT) |
| Rerank context | 4000 chars/doc (intent-aware chunk selection) | 200 chars/doc |
| Chunk dedup | Yes (identical texts share single rerank call) | No |
| Graph traversal | No | Yes (WHY/ENTITY, multi-hop) |
| MMR diversity | Yes (`diverse=true` default) | No |
| `compact` param | Yes | No |
| `collection` filter | Yes | No |
| `candidateLimit` | Yes (default 30) | No |
| Best for | Most queries, progressive disclosure | Causal chains spanning multiple docs |


## Troubleshooting

```
Symptom: "Local model download blocked" error
  → llama-server endpoint unreachable while CLAWMEM_NO_LOCAL_MODELS=true.
  → Fix: Start the llama-server instance. Or set CLAWMEM_NO_LOCAL_MODELS=false for in-process fallback.

Symptom: "[generate] Remote LLM in cooldown, falling back to in-process generation"
  → Remote LLM server had a transport failure (ECONNREFUSED/ETIMEDOUT). ClawMem set a 60s cooldown
    and is using local node-llama-cpp. Remote will be retried after cooldown expires.
  → Not an error if you expect local fallback. If you want remote only: ensure llama-server is running,
    or set CLAWMEM_NO_LOCAL_MODELS=true to get null instead of slow local inference.

Symptom: Query expansion always fails / returns garbage
  → On CPU-only systems, in-process inference is significantly slower and less reliable. Systems with GPU acceleration (Metal/Vulkan) handle these models well in-process.
  → Fix: Run llama-server on a GPU. Even a low-end NVIDIA card handles 1.7B models.

Symptom: Vector search returns no results but BM25 works
  → Missing embeddings. Watcher indexes but does NOT embed.
  → Fix: Run `clawmem embed` or wait for the daily embed timer.

Symptom: llama-server crashes with "non-causal attention requires n_ubatch >= n_tokens"
  → Embedding/reranking models use non-causal attention. When -b (batch) > -ub (ubatch), the assertion fails.
  → Fix: Set -ub equal to -b (e.g. -b 2048 -ub 2048). Never omit -ub for embedding/reranking servers.

Symptom: context-surfacing hook returns empty
  → Prompt too short (<20 chars), starts with `/`, or no docs score above threshold.
  → Fix: Check `clawmem status` for doc counts. Check `clawmem embed` for embedding coverage.

Symptom: intent_search returns weak results for WHY/ENTITY
  → Graph may be sparse (few A-MEM edges).
  → Fix: Run `build_graphs` to add temporal backbone + semantic edges.

Symptom: Watcher logs events but collections show 0 docs after update/reindex
  → Bun.Glob does not support brace expansion {a,b,c}. Collection patterns returned 0 files.
  → Fixed 2026-02-12: indexer.ts splits brace patterns into individual Glob scans.

Symptom: Watcher fires events but wrong collection processes them (e.g., workspace instead of dharma-propagation)
  → Collection prefix matching via Array.find() returns first match. Parent paths match before children.
  → Fixed 2026-02-12: cmdWatch() sorts collections by path length descending (most specific first).

Symptom: reindex --force crashes with "UNIQUE constraint failed: documents.collection, documents.path"
  → Force deactivates rows (active=0) but UNIQUE(collection, path) doesn't discriminate by active flag.
  → Fixed 2026-02-12: indexer.ts checks for inactive rows and reactivates instead of inserting.

Symptom: embed crashes with "UNIQUE constraint failed on vectors_vec primary key" on restart
  → vectors_vec is a vec0 virtual table — INSERT OR REPLACE is not supported by vec0.
  → Fixed 2026-03-15: insertEmbedding() uses DELETE (try-catch) + INSERT instead of INSERT OR REPLACE.
  → Embed can now resume after interrupted runs without --force.

Symptom: embed crashes with alternating "no such table: vectors_vec" / "table vectors_vec already exists"
  → Dimension migration race: --force drops vectors_vec, ensureVecTable per-fragment drops+recreates on dimension
    mismatch, causing rapid table existence flickering between fragments.
  → Fixed 2026-03-15: ensureVecTable caches verified dimensions (vecTableDims), uses CREATE VIRTUAL TABLE IF NOT EXISTS,
    and clearAllEmbeddings resets the cache. First fragment creates, rest skip the check.

Symptom: embed --force with new model produces 3 docs stuck as "Unembedded" but "All documents already embedded"
  → First fragment (seq=0) failed during a crashed embed run. Later fragments succeeded.
    getHashesNeedingFragments thinks the doc is done but status checks seq=0 specifically.
  → Fix: Delete partial content_vectors + vectors_vec for the stuck hashes, then re-run embed (no --force).
    The vec0 DELETE try-catch prevents cascading failures during the re-embed.

Symptom: reindex --force after v0.2.0 upgrade shows no entity extraction
  → `reindex --force` treats existing docs as updates (isNew=false). The A-MEM pipeline
    skips entity extraction, link generation, and evolution for updates to avoid churn.
  → Fix: Use `clawmem reindex --enrich` instead. The `--enrich` flag forces the full
    enrichment pipeline (entity extraction + links + evolution) on all documents.
  → `--force` alone only refreshes A-MEM notes (keywords, tags, context). `--enrich`
    is needed after major upgrades that add new enrichment stages.

Symptom: `clawmem update` crashes with "Binding expected string, TypedArray, boolean, number, bigint or null"
  → YAML frontmatter values like `title: 2023-09-27` or `title: true` are coerced by gray-matter
    into Date objects or booleans. Bun's SQLite driver rejects these as bind parameters.
  → Fixed v0.4.2: `parseDocument()` runtime-checks all frontmatter fields via `str()` helper.
    Defense-in-depth `safeTitle` guards in `insertDocument`/`updateDocument`/`reactivateDocument`.
  → Affects: title, domain, workstream, content_type, review_by — any field gray-matter can coerce.

Symptom: CLI reindex/update falls back to node-llama-cpp Vulkan (not GPU server)
  → GPU env vars only in systemd drop-in, not in wrapper script. CLI invocations missed them.
  → Fixed 2026-02-12: bin/clawmem wrapper exports CLAWMEM_EMBED_URL/LLM_URL/RERANK_URL defaults.
  → Always run ClawMem via the `bin/clawmem` wrapper, not `bun run src/clawmem.ts` directly.
    The wrapper sets CLAWMEM_EMBED_URL/LLM_URL/RERANK_URL defaults. Scripts or inline bun
    commands that bypass the wrapper will fall back to in-process node-llama-cpp (slow, CPU).

Symptom: "UserPromptSubmit hook error" on context-surfacing hook (intermittent)
  → SQLite contention between the watcher and the hook. The watcher processes filesystem events
    and holds brief write locks. If the hook fires during a lock, it can exceed its timeout.
    More likely during active conversations with frequent file changes.
  → v0.1.6 fix: watcher no longer processes session transcript .jsonl files (only .beads/*.jsonl),
    eliminating the most common source of contention.
  → Default hook timeout is 8s (since v0.1.1). If you have an older install, re-run
    `clawmem setup hooks`. If persistent, restart the watcher: `systemctl --user restart
    clawmem-watcher.service`. Healthy memory is under 100MB — if 400MB+, restart clears it.
  → v0.2.4 fix: hook's SQLite busy_timeout was 500ms — too tight. During A-MEM enrichment
    or heavy indexing, watcher write locks exceed 500ms, causing SQLITE_BUSY. Raised to
    5000ms (matches MCP server). Still completes within the 8s outer timeout.

Symptom: WSL hangs or becomes unresponsive during long sessions / watcher has 100K+ FDs
  → Pre-v0.2.3: fs.watch(recursive: true) registered inotify watches on EVERY subdirectory,
    including excluded dirs (gits/, node_modules/, .git/). Broad collection paths like
    ~/Projects with 67K subdirs exhausted inotify limits.
  → v0.2.3 fix: watcher walks dir trees at startup, skips excluded subtrees, watches
    non-excluded dirs individually. 500-dir cap per collection path.
  → Diagnosis: `ls /proc/$(pgrep -f "clawmem.*watch")/fd | wc -l` — healthy < 15K.
  → If still high: narrow broad collection paths. See docs/troubleshooting.md for details.
```

## CLI Reference

Run `clawmem --help` for full command listing. Use this before guessing at commands or parameters.

**IO6 surface commands** (for daemon/`--print` mode integration):
```bash
# IO6a: per-prompt context injection (pipe prompt on stdin)
echo "user query" | clawmem surface --context --stdin

# IO6b: per-session bootstrap injection (pipe session ID on stdin)
echo "session-id" | clawmem surface --bootstrap --stdin
```

**Browse and analysis:**
```bash
clawmem list [-n N] [-c col]    # Browse recent documents (--json for machine output)
clawmem reflect [N]             # Cross-session reflection (last N days, default 14)
                                # Shows recurring themes, antipatterns, co-activation clusters
clawmem consolidate [--dry-run] # Find and archive duplicate low-confidence documents
                                # Uses Jaccard similarity within same collection
```

## Integration Notes

- **Memory nudge (v0.2.0):** Every N prompts (default 15) without a lifecycle MCP tool call (`memory_pin`/`memory_forget`/`memory_snooze`), context-surfacing appends `<vault-nudge>` prompting proactive memory management. Counter resets on lifecycle tool use. Configure via `CLAWMEM_NUDGE_INTERVAL` (0 to disable).
- **Entity resolution (v0.2.0+):** A-MEM enrichment extracts named entities via LLM, resolves to canonical forms using FTS5 + Levenshtein fuzzy matching with **type-agnostic compatibility buckets** (person, org, location stay separate; project/service/tool/concept merge freely as "tech" bucket). Quality filters reject title-as-entity, long names, template placeholders, and invalid locations. Entity edges use IDF-based specificity scoring (rare entities create edges; ubiquitous entities alone cannot). See `docs/internals/entity-resolution.md` for customization (extending type vocabulary and buckets).
- QMD retrieval (BM25, vector, RRF, rerank, query expansion) is forked into ClawMem. Do not call standalone QMD tools.
- SAME (composite scoring), MAGMA (intent + graph), A-MEM (self-evolving notes) layer on top of QMD substrate.
- Three `llama-server` instances (embedding, LLM, reranker) on local or remote GPU. Wrapper defaults to `localhost:8088/8089/8090`.
- `CLAWMEM_NO_LOCAL_MODELS=false` (default) allows in-process LLM/reranker fallback via `node-llama-cpp`. Set `true` for remote-only setups to fail fast on unreachable endpoints.
- Consolidation worker (`CLAWMEM_ENABLE_CONSOLIDATION=true`) backfills unenriched docs with A-MEM notes + links. Only runs if the MCP process stays alive long enough to tick (every 5min).
- Beads integration: `syncBeadsIssues()` queries `bd` CLI (Dolt backend, v0.58.0+) for live issue data, creates markdown docs in `beads` collection, maps all dependency edge types into `memory_relations`, and triggers A-MEM enrichment for new docs. Watcher auto-triggers on `.beads/` directory changes; `beads_sync` MCP tool for manual sync. Requires `bd` binary on PATH or at `~/go/bin/bd`.
- HTTP REST API: `clawmem serve [--port 7438]` — optional REST server on localhost. Search, retrieval, lifecycle, and graph traversal. `POST /retrieve` mirrors `memory_retrieve` with auto-routing (keyword/semantic/causal/timeline/hybrid). `POST /search` provides direct mode selection. Bearer token auth via `CLAWMEM_API_TOKEN` env var (disabled if unset).
- OpenClaw ContextEngine plugin: `clawmem setup openclaw` — registers ClawMem as a native OpenClaw context engine. Uses `before_prompt_build` for retrieval (prompt-aware), `afterTurn()` for extraction, `compact()` for pre-compaction + runtime delegation. Shares same vault as Claude Code hooks (dual-mode). SQLite busy_timeout=5000ms for concurrent access safety.
- **OpenClaw v2026.3.28+ compaction fix (v0.3.0):** `compact()` now delegates to OpenClaw's runtime compactor via `delegateCompactionToRuntime()` from `openclaw/plugin-sdk/core`. Previous versions returned `compacted: false` expecting legacy fallback — that fallback no longer exists. Without this fix, sessions never compact. Bootstrap context is now cached in `bootstrap()` and consumed once in `before_prompt_build`, eliminating duplicate hook invocations.
- Hermes Agent MemoryProvider plugin: `src/hermes/` — Python plugin implementing Hermes's `MemoryProvider` ABC. Symlink or copy into `hermes-agent/plugins/memory/clawmem/`. Uses shell-out for lifecycle hooks (session-bootstrap, context-surfacing, extraction) and REST API for tools (retrieve, get, session_log, timeline, similar). Plugin manages its own transcript JSONL for ClawMem hooks. Supports external (you run `clawmem serve`) and managed (plugin starts/stops serve) modes.
