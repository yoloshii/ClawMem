---
name: clawmem
description: |
  ClawMem agent reference — detailed operational guidance for the on-device hybrid memory system. Use when: setting up collections/indexing/embedding, troubleshooting retrieval, tuning query optimization (4 levers), understanding pipeline behavior, managing memory lifecycle (pin/snooze/forget), building graphs, or any ClawMem operation beyond basic tool routing.
allowed-tools: "mcp__clawmem__*"
metadata:
  author: yoloshii
  version: 1.0.0
---

# ClawMem Agent Reference

## Architecture

Two tiers: **hooks** handle automatic context flow (surfacing, extraction, compaction survival). **MCP tools** handle explicit recall, write, and lifecycle operations.

---

## Inference Services

Three `llama-server` instances for neural inference. The `bin/clawmem` wrapper defaults to `localhost:8088/8089/8090`.

**Default (QMD native combo, any GPU or CPU):**

| Service | Port | Model | VRAM | Protocol |
|---|---|---|---|---|
| Embedding | 8088 | EmbeddingGemma-300M-Q8_0 | ~400MB | `/v1/embeddings` |
| LLM | 8089 | qmd-query-expansion-1.7B-q4_k_m | ~2.2GB | `/v1/chat/completions` |
| Reranker | 8090 | qwen3-reranker-0.6B-Q8_0 | ~1.3GB | `/v1/rerank` |

All three models auto-download via `node-llama-cpp` and run on CPU if no server is running.

**SOTA upgrade (12GB+ GPU):** zembed-1-Q4_K_M (embedding, 2560d, ~4.4GB) + zerank-2-Q4_K_M (reranker, ~3.3GB). Total ~10GB with LLM. Distillation-paired via zELO. `-ub` must match `-b` for both. **CC-BY-NC-4.0** — non-commercial only.

**Remote option:** Set `CLAWMEM_EMBED_URL`, `CLAWMEM_LLM_URL`, `CLAWMEM_RERANK_URL` to remote host. Set `CLAWMEM_NO_LOCAL_MODELS=true` to prevent fallback downloads.

**Cloud embedding:** Set `CLAWMEM_EMBED_API_KEY` + `CLAWMEM_EMBED_URL` + `CLAWMEM_EMBED_MODEL` for cloud providers. Supported: Jina AI (`jina-embeddings-v5-text-small`, 1024d), OpenAI, Voyage, Cohere. Batch embedding, TPM-aware pacing, provider-specific params auto-detected.

### Server Setup

```bash
# === Default (QMD native combo) ===

# Embedding (--embeddings flag required)
llama-server -m embeddinggemma-300M-Q8_0.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 2048

# LLM (auto-downloads via node-llama-cpp if no server)
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf \
  --port 8089 --host 0.0.0.0 -ngl 99 -c 4096 --batch-size 512

# Reranker (auto-downloads via node-llama-cpp if no server)
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 512

# === SOTA upgrade (12GB+ GPU) — -ub must match -b ===

# Embedding (zembed-1)
llama-server -m zembed-1-Q4_K_M.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 8192 -b 2048 -ub 2048

# Reranker (zerank-2)
llama-server -m zerank-2-Q4_K_M.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 -b 2048 -ub 2048
```

### Verify Endpoints

```bash
curl http://host:8088/v1/embeddings -d '{"input":"test","model":"embedding"}' -H 'Content-Type: application/json'
curl http://host:8089/v1/models
curl http://host:8090/v1/models
```

## Environment Variables

| Variable | Default (via wrapper) | Effect |
|---|---|---|
| `CLAWMEM_EMBED_URL` | `http://localhost:8088` | Embedding server. Falls back to in-process `node-llama-cpp` if unset. |
| `CLAWMEM_EMBED_API_KEY` | (none) | API key for cloud embedding. Enables cloud mode: batch embedding, provider-specific params, TPM-aware pacing. |
| `CLAWMEM_EMBED_MODEL` | `embedding` | Model name for embedding requests. Override for cloud providers (e.g. `jina-embeddings-v5-text-small`). |
| `CLAWMEM_EMBED_TPM_LIMIT` | `100000` | Tokens-per-minute limit for cloud embedding pacing. Match to your provider tier. |
| `CLAWMEM_EMBED_DIMENSIONS` | (none) | Output dimensions for OpenAI `text-embedding-3-*` Matryoshka models. |
| `CLAWMEM_LLM_URL` | `http://localhost:8089` | LLM server. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. |
| `CLAWMEM_RERANK_URL` | `http://localhost:8090` | Reranker server. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. |
| `CLAWMEM_NO_LOCAL_MODELS` | `false` | Blocks `node-llama-cpp` auto-downloads. Set `true` for remote-only. |
| `CLAWMEM_ENABLE_AMEM` | enabled | A-MEM note construction + link generation during indexing. |
| `CLAWMEM_ENABLE_CONSOLIDATION` | disabled | Background worker backfills unenriched docs. Needs long-lived MCP process. |
| `CLAWMEM_CONSOLIDATION_INTERVAL` | 300000 | Worker interval in ms (min 15000). |

**Note:** The `bin/clawmem` wrapper sets all endpoint defaults. Always use the wrapper — never `bun run src/clawmem.ts` directly.

---

## Quick Setup

```bash
git clone https://github.com/yoloshii/clawmem.git ~/clawmem
cd ~/clawmem && bun install
ln -sf ~/clawmem/bin/clawmem ~/.bun/bin/clawmem

# Bootstrap a vault (init + index + embed + hooks + MCP)
./bin/clawmem bootstrap ~/notes --name notes

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

```bash
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
loginctl enable-linger $(whoami)
```

**Note:** Service files use `%h` (home dir). For remote GPU, add `Environment=CLAWMEM_EMBED_URL=http://host:8088` etc. to both service files.

---

## Tier 2 — Automatic Retrieval (Hooks)

Hooks handle ~90% of retrieval. Zero agent effort.

| Hook | Trigger | Budget | Content |
|------|---------|--------|---------|
| `context-surfacing` | UserPromptSubmit | profile-driven (default 800) | retrieval gate -> profile-driven hybrid search (vector if `useVector`, timeout from profile) -> FTS supplement -> snooze filter -> noise filter -> `<vault-context>`. Budget, max results, vector timeout, min score all driven by `CLAWMEM_PROFILE`. |
| `postcompact-inject` | SessionStart (compact) | 1200 tokens | re-injects authoritative context after compaction: precompact state (600) + decisions (400) + antipatterns (150) + vault context (200) -> `<vault-postcompact>` |
| `curator-nudge` | SessionStart | 200 tokens | surfaces curator report actions, nudges when report is stale (>7 days) |
| `precompact-extract` | PreCompact | — | extracts decisions, file paths, open questions -> writes `precompact-state.md`. Query-aware ranking. Reindexes auto-memory. |
| `decision-extractor` | Stop | — | LLM extracts observations -> `_clawmem/agent/observations/`, infers causal links, detects contradictions |
| `handoff-generator` | Stop | — | LLM summarizes session -> `_clawmem/agent/handoffs/` |
| `feedback-loop` | Stop | — | tracks referenced notes -> boosts confidence |

**Default behavior:** Read injected `<vault-context>` first. If sufficient, answer immediately.

**Hook blind spots (by design):** Hooks filter out `_clawmem/` system artifacts, enforce score thresholds, and cap token budget. Absence in `<vault-context>` does NOT mean absence in memory. Escalate to Tier 3 if expected memory wasn't surfaced.

---

## Tier 3 — Agent-Initiated Retrieval (MCP Tools)

### 3-Rule Escalation Gate

Escalate to MCP tools ONLY when one of these fires:

1. **Low-specificity injection** — `<vault-context>` is empty or lacks the specific fact the task requires. Hooks surface top-k by relevance; if needed memory wasn't in top-k, escalate.
2. **Cross-session question** — task explicitly references prior sessions or decisions: "why did we decide X", "what changed since last time".
3. **Pre-irreversible check** — about to make a destructive or hard-to-reverse change. Check vault for prior decisions.

All other retrieval is handled by Tier 2 hooks. Do NOT call MCP tools speculatively.

### Tool Routing

Once escalated, route by query type:

**PREFERRED:** `memory_retrieve(query)` — auto-classifies and routes to the optimal backend (query, intent_search, session_log, find_similar, or query_plan). Use this instead of manually choosing a tool below.

```
1a. General recall -> query(query, compact=true, limit=20)
    Full hybrid: BM25 + vector + query expansion + deep reranking.
    Supports compact, collection filter, intent, candidateLimit.
    Optional: intent="domain hint" for ambiguous queries.
    Optional: candidateLimit=N (default 30).
    BM25 strong-signal bypass: skips expansion when top BM25 >= 0.85 with gap >= 0.15
    (disabled when intent is provided).

1b. Causal/why/when/entity -> intent_search(query, enable_graph_traversal=true)
    MAGMA intent classification + intent-weighted RRF + multi-hop graph traversal.
    Use DIRECTLY when question is "why", "when", "how did X lead to Y",
    or needs entity-relationship traversal.
    Override auto-detection: force_intent="WHY"|"WHEN"|"ENTITY"|"WHAT"

    Choose 1a or 1b based on query type. Parallel options, not sequential.

1c. Multi-topic/complex -> query_plan(query, compact=true)
    Decomposes query into 2-4 typed clauses (bm25/vector/graph), executes in parallel, merges via RRF.
    Use when query spans multiple topics or needs both keyword and semantic recall simultaneously.
    Falls back to single-query behavior for simple queries.

2. Progressive disclosure -> multi_get("path1,path2") for full content of top hits

3. Spot checks -> search(query) (BM25, 0 GPU) or vsearch(query) (vector, 1 GPU)

4. Chain tracing -> find_causal_links(docid, direction="both", depth=5)
   Traverses causal edges between _clawmem/agent/observations/ docs.

5. Memory debugging -> memory_evolution_status(docid)

6. Temporal context -> timeline(docid, before=5, after=5, same_collection=false)
   Shows what was created/modified before and after a document.
   Use after search to understand chronological neighborhood.
```

### All MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_retrieve` | **Preferred.** Auto-classifies query and routes to optimal backend. Use instead of choosing manually. |
| `query` | Full hybrid (BM25 + vector + rerank). General-purpose when type unclear. WRONG for "why" (use `intent_search`) or cross-session (use `session_log`). Prefer `memory_retrieve`. |
| `intent_search` | USE THIS for "why did we decide X", "what caused Y", "who worked on Z". Classifies intent, traverses graph edges. Returns decision chains `query()` cannot find. |
| `query_plan` | USE THIS for multi-topic queries ("X and also Y", "compare A with B"). `query()` searches as one blob — this splits and routes each optimally. |
| `search` | BM25 keyword — for exact terms, config names, error codes. Fast, 0 GPU. Prefer `memory_retrieve`. |
| `vsearch` | Vector semantic — for conceptual/fuzzy when keywords unknown. ~100ms, 1 GPU. Prefer `memory_retrieve`. |
| `get` | Retrieve single doc by path or `#docid`. |
| `multi_get` | Retrieve multiple docs by glob or comma-separated list. |
| `find_similar` | USE THIS for "what else relates to X". k-NN vector neighbors — discovers connections beyond keyword overlap. |
| `find_causal_links` | Trace decision chains: "what led to X". Follow up `intent_search` on a top result to walk the full causal chain. |
| `session_log` | USE THIS for "last time", "yesterday", "what did we do". DO NOT use `query()` for cross-session questions. |
| `profile` | User profile (static facts + dynamic context). |
| `memory_forget` | Deactivate a memory by closest match. |
| `memory_pin` | +0.3 composite boost. USE PROACTIVELY for constraints, architecture decisions, corrections. Don't wait for curator. |
| `memory_snooze` | USE PROACTIVELY when `<vault-context>` surfaces noise — snooze 30 days instead of ignoring. |
| `build_graphs` | Build temporal backbone + semantic graph after bulk ingestion. |
| `beads_sync` | Sync Beads issues from Dolt backend into memory. |
| `index_stats` | Doc counts, embedding coverage, content type distribution. |
| `status` | Quick index health. |
| `reindex` | Force re-index (BM25 only, does NOT embed). |
| `memory_evolution_status` | Track how a doc's A-MEM metadata evolved over time. |
| `timeline` | Temporal neighborhood around a document — what was modified before/after. Progressive disclosure: search → timeline → get. Supports same-collection scoping and session correlation. |
| `list_vaults` | Show configured vault names and paths. Empty in single-vault mode. |
| `vault_sync` | Index markdown from a directory into a named vault. Restricted-path validation rejects sensitive directories. |
| `lifecycle_status` | Document lifecycle statistics: active, archived, forgotten, pinned, snoozed counts and policy summary. |
| `lifecycle_sweep` | Run lifecycle policies: archive stale docs. Defaults to dry_run (preview only). |
| `lifecycle_restore` | Restore auto-archived documents. Filter by query, collection, or all. Does NOT restore manually forgotten docs. |

**Multi-vault:** All tools accept an optional `vault` parameter. Omit for the default vault (single-vault mode). Named vaults configured in `~/.config/clawmem/config.yaml` under `vaults:` or via `CLAWMEM_VAULTS` env var. Vault paths support `~` expansion.

**Progressive disclosure:** ALWAYS `compact=true` first -> review snippets/scores -> `get(docid)` or `multi_get(pattern)` for full content.

---

## Query Optimization

ClawMem's pipeline autonomously generates lex/vec/hyde variants, fuses BM25 + vector via RRF, and reranks with a cross-encoder. The agent does NOT choose search types — the pipeline handles fusion internally. The agent's optimization levers are: **tool selection**, **query string quality**, **intent**, and **candidateLimit**.

### Lever 1: Tool Selection (highest impact)

Pick the lightest tool that satisfies the need. Heavier tools are slower and consume more GPU.

| Tool | Cost | When |
|------|------|------|
| `search(q, compact=true)` | BM25 only, 0 GPU | Know exact terms, spot-check, fast keyword lookup |
| `vsearch(q, compact=true)` | Vector only, 1 GPU call | Conceptual/fuzzy, don't know vocabulary |
| `query(q, compact=true)` | Full hybrid, 3+ GPU calls | General recall, unsure which signal matters, need best results |
| `intent_search(q)` | Hybrid + graph traversal | Why/entity chains (graph traversal), when queries (BM25-biased) |
| `query_plan(q, compact=true)` | Hybrid + decomposition | Complex multi-topic queries needing parallel typed retrieval |

Use `search` for quick keyword spot-checks. Use `query` for general recall (default Tier 3 workhorse). Use `intent_search` directly (not as fallback) when the question is causal or relational.

### Lever 2: Query String Quality

The query string directly feeds BM25 (which probes first and can short-circuit the entire pipeline) and anchors the 2x-weighted original signal in RRF. A good query string is the single biggest determinant of result quality.

**For keyword recall (BM25 path):**
- 2-5 precise terms, no filler words
- Code identifiers work: `handleError async`
- BM25 tokenizes on whitespace and AND's all terms as prefix matches (`perf` matches "performance")
- No phrase search or negation syntax — all terms are positive prefix matches
- A strong keyword hit (score >= 0.85 with gap >= 0.15) skips expansion entirely — faster results

**For semantic recall (vector path):**
- Full natural language question, be specific
- Include context: `"in the payment service, how are refunds processed"` > `"refunds"`
- The expansion LLM generates complementary variants — don't try to do its job

**Do NOT write hypothetical-answer-style queries.** The expansion LLM already generates hyde variants internally. Writing a 50-word hypothetical dilutes BM25 scoring and is redundant with what the pipeline does autonomously.

### Lever 3: Intent (Disambiguation)

Steers 5 autonomous stages: expansion, reranking, chunk selection, snippet extraction, and strong-signal bypass (disabled when intent is provided, forcing full pipeline).

```
query("performance", intent="web page load times and Core Web Vitals")
```

**When to provide:**
- Query term has multiple meanings in the vault ("performance", "pipeline", "model")
- You know the domain but the query alone is ambiguous
- Cross-domain search where same terms appear in different contexts

**When NOT to provide:**
- Query is already specific enough
- Single-domain vault with no ambiguity
- Using `search` or `vsearch` (intent only affects `query` tool)

**Note:** Intent disables BM25 strong-signal bypass, forcing full expansion+reranking even on strong keyword hits. This is correct behavior — intent means the query is ambiguous, so keyword confidence alone is insufficient.

### Lever 4: candidateLimit

Controls how many RRF candidates reach the cross-encoder reranker (default 30).

```
query("architecture decisions", candidateLimit=15)  # Faster, more precise
query("architecture decisions", candidateLimit=50)  # Broader recall, slower
```

Lower when: high-confidence keyword query, speed matters, vault is small.
Higher when: broad topic, vault is large, recall matters more than speed.

---

## Pipeline Details

### `query` (default Tier 3 workhorse)

```
User Query + optional intent hint
  -> BM25 Probe -> Strong Signal Check (skip expansion if top hit >= 0.85 with gap >= 0.15; disabled when intent provided)
  -> Query Expansion (LLM generates text variants; intent steers expansion prompt)
  -> Parallel: BM25(original) + Vector(original) + BM25(each expanded) + Vector(each expanded)
  -> Original query lists get positional 2x weight in RRF; expanded get 1x
  -> Reciprocal Rank Fusion (k=60, top candidateLimit)
  -> Intent-Aware Chunk Selection (intent terms at 0.5x weight alongside query terms at 1.0x)
  -> Cross-Encoder Reranking (4000 char context; intent prepended to rerank query; chunk dedup; batch cap=4)
  -> Position-Aware Blending (alpha=0.75 top3, 0.60 mid, 0.40 tail)
  -> Composite Scoring
  -> MMR Diversity Filter (Jaccard bigram similarity > 0.6 -> demoted, not removed)
```

### `intent_search` (specialist for causal chains)

```
User Query -> Intent Classification (WHY/WHEN/ENTITY/WHAT)
  -> BM25 + Vector (intent-weighted RRF: boost BM25 for WHEN, vector for WHY)
  -> Graph Traversal (WHY/ENTITY only; multi-hop beam search over memory_relations)
      Outbound: all edge types (semantic, supporting, contradicts, causal, temporal)
      Inbound: semantic and entity only
      Scores normalized to [0,1] before merge with search results
  -> Cross-Encoder Reranking (200 char context per doc; file-keyed score join)
  -> Composite Scoring (uses stored confidence from contradiction detection + feedback)
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

### `intent_search` force_intent Guide

| Override | Triggers |
|----------|----------|
| `WHY` | "why", "what led to", "rationale", "tradeoff", "decision behind" |
| `ENTITY` | Named component/person/service needing cross-doc linkage |
| `WHEN` | Timelines, first/last occurrence, "when did this change/regress" |

**WHEN note:** Start with `enable_graph_traversal=false` (BM25-biased); fall back to `query()` if recall drifts.

---

## Composite Scoring

Applied automatically to all search tool results.

```
compositeScore = (0.50 x searchScore + 0.25 x recencyScore + 0.25 x confidenceScore) x qualityMultiplier x coActivationBoost
```

Where `qualityMultiplier = 0.7 + 0.6 x qualityScore` (range: 0.7x penalty to 1.3x boost).
`coActivationBoost = 1 + min(coCount/10, 0.15)` — documents frequently surfaced together get up to 15% boost.

Length normalization: `1/(1 + 0.5 x log2(max(bodyLength/500, 1)))` — penalizes verbose entries, floor at 30%.

Frequency boost: `freqSignal = (revisions-1)x2 + (duplicates-1)`, `freqBoost = min(0.10, log1p(freqSignal)x0.03)`. Revision count weighted 2x vs duplicate count. Capped at 10%.

Pinned documents get +0.3 additive boost (capped at 1.0).

### Recency Intent Detected ("latest", "recent", "last session")

```
compositeScore = (0.10 x searchScore + 0.70 x recencyScore + 0.20 x confidenceScore) x qualityMultiplier x coActivationBoost
```

### Content Type Half-Lives

| Content Type | Half-Life | Effect |
|--------------|-----------|--------|
| decision, hub | infinity | Never decay |
| antipattern | infinity | Never decay — accumulated negative patterns persist |
| project | 120 days | Slow decay |
| research | 90 days | Moderate decay |
| note | 60 days | Default |
| progress | 45 days | Faster decay |
| handoff | 30 days | Fast — recent matters most |

Half-lives extend up to 3x for frequently-accessed memories (access reinforcement decays over 90 days).

Attention decay: non-durable types (handoff, progress, note, project) lose 5% confidence per week without access. Decision/hub/research/antipattern are exempt.

---

## Indexing & Graph Building

### What Gets Indexed (per collection in config.yaml)

- `**/MEMORY.md` — any depth
- `**/memory/**/*.md`, `**/memory/**/*.txt` — session logs
- `**/docs/**/*.md`, `**/docs/**/*.txt` — documentation
- `**/research/**/*.md`, `**/research/**/*.txt` — research dumps
- `**/YYYY-MM-DD*.md`, `**/YYYY-MM-DD*.txt` — date-format records

### Excluded (even if pattern matches)

- `gits/`, `scraped/`, `.git/`, `node_modules/`, `dist/`, `build/`, `vendor/`

### Indexing vs Embedding

**Infrastructure (Tier 1, no agent action):**
- **`clawmem-watcher`** — keeps index + A-MEM fresh (continuous, on `.md` change). Watches `.beads/` too. Does NOT embed.
- **`clawmem-embed` timer** — keeps embeddings fresh (daily). Idempotent, skips already-embedded fragments.

**Quality scoring:** Each document gets `quality_score` (0.0-1.0) during indexing based on length, structure (headings, lists), decision keywords, correction keywords, frontmatter richness. Applied as multiplier in composite scoring.

**Impact of missing embeddings:** `vsearch`, `query` (vector component), `context-surfacing` (vector component), and `generateMemoryLinks()` all depend on embeddings. BM25 still works, but vector recall and inter-doc link quality suffer.

**Agent escape hatches (rare):**
- `clawmem embed` via CLI for immediate vector recall after writing a doc.
- Manual `reindex` only when watcher hasn't caught up.

### Adding New Collections

```bash
# 1. Edit config
Edit ~/.config/clawmem/config.yaml

# 2. Reindex (BM25 only)
mcp__clawmem__reindex()

# 3. Embed (vectors, CLI only)
CLAWMEM_PATH=~/clawmem ~/clawmem/bin/clawmem embed

# 4. Verify
mcp__clawmem__search(query, collection="name", compact=true)    # BM25
mcp__clawmem__vsearch(query, collection="name", compact=true)   # vector
```

**Gotcha:** `reindex` shows `added` count but does NOT embed. `needsEmbedding` in `index_stats` shows pending. Must run CLI `embed` separately.

### Graph Population (memory_relations)

| Source | Edge Types | Trigger | Notes |
|--------|-----------|---------|-------|
| A-MEM `generateMemoryLinks()` | semantic, supporting, contradicts | Indexing (new docs) | LLM-assessed confidence. Requires embeddings. |
| A-MEM `inferCausalLinks()` | causal | Post-response (decision-extractor) | Links `_clawmem/agent/observations/` docs only. |
| Beads `syncBeadsIssues()` | causal, supporting, semantic | `beads_sync` MCP or watcher | Queries `bd` CLI (Dolt backend). |
| `buildTemporalBackbone()` | temporal | `build_graphs` MCP (manual) | Creation-order edges. |
| `buildSemanticGraph()` | semantic | `build_graphs` MCP (manual) | Pure cosine similarity. A-MEM edges take precedence (first-writer wins). |

**Graph traversal asymmetry:** `adaptiveTraversal()` traverses all edge types outbound (source->target) but only `semantic` and `entity` inbound.

### When to Run `build_graphs`

- After **bulk ingestion** — adds temporal backbone + semantic gap filling.
- When `intent_search` for WHY/ENTITY returns weak results and you suspect graph sparsity.
- Do NOT run after every reindex (A-MEM handles per-doc links automatically).

---

## Memory Lifecycle

Pin, snooze, and forget are **manual MCP tools**.

### Pin (`memory_pin`)

+0.3 composite boost, ensures persistent surfacing.

**Proactive triggers:**
- User says "remember this" / "don't forget" / "this is important"
- Architecture or critical design decision just made
- User-stated preference or constraint that should persist across sessions

**Do NOT pin:** routine decisions, session-specific context, or observations that naturally surface via recency.

### Snooze (`memory_snooze`)

Temporarily hides from context surfacing until a date.

**Proactive triggers:**
- A memory keeps surfacing but isn't relevant to current work
- User says "not now" / "later" / "ignore this for now"
- Seasonal or time-boxed content

### Forget (`memory_forget`)

Permanently deactivates. Use sparingly — only when genuinely wrong or permanently obsolete. Prefer snooze for temporary suppression.

### Contradiction Auto-Resolution

When `decision-extractor` detects a new decision contradicting an old one, the old decision's confidence is lowered automatically. No manual intervention needed.

---

## Anti-Patterns

- Do NOT manually pick query/intent_search/search when `memory_retrieve` can auto-route.
- Do NOT call MCP tools every turn — 3-rule escalation gate is the only trigger.
- Do NOT re-search what's already in `<vault-context>`.
- Do NOT run `status` routinely. Only when retrieval feels broken or after large ingestion.
- Do NOT pin everything — pin is for persistent high-priority items.
- Do NOT forget memories to "clean up" — let confidence decay and contradiction detection handle it.
- Do NOT run `build_graphs` after every reindex — A-MEM creates per-doc links automatically.

---

## OpenClaw Integration

### Option 1: ClawMem Exclusive (Recommended)

ClawMem handles 100% of memory. No redundancy.

```bash
# Disable OpenClaw's native memory
openclaw config set agents.defaults.memorySearch.extraPaths "[]"
```

**Distribution:** Hooks 90%, MCP tools 10%.

### Option 2: Hybrid

Run both ClawMem and OpenClaw native memory.

```bash
openclaw config set agents.defaults.memorySearch.extraPaths '["~/documents", "~/notes"]'
```

**Tradeoffs:** Redundant recall but 10-15% context window waste from duplicate facts.

---

## Troubleshooting

```
Symptom: "Local model download blocked" error
  -> llama-server endpoint unreachable while CLAWMEM_NO_LOCAL_MODELS=true.
  -> Fix: Start llama-server. Or set CLAWMEM_NO_LOCAL_MODELS=false for in-process fallback.

Symptom: Query expansion always fails / returns garbage
  -> In-process CPU inference is slow and unreliable.
  -> Fix: Run llama-server on GPU.

Symptom: Vector search returns no results but BM25 works
  -> Missing embeddings. Watcher indexes but does NOT embed.
  -> Fix: Run `clawmem embed` or wait for daily embed timer.

Symptom: context-surfacing hook returns empty
  -> Prompt too short (<20 chars), starts with `/`, or no docs above threshold.
  -> Fix: Check `clawmem status` for doc counts. Check `clawmem embed` for embedding coverage.

Symptom: intent_search returns weak results for WHY/ENTITY
  -> Graph may be sparse (few A-MEM edges).
  -> Fix: Run `build_graphs` to add temporal backbone + semantic edges.

Symptom: Watcher fires but collections show 0 docs
  -> Bun.Glob does not support brace expansion {a,b,c}.
  -> Fixed: indexer.ts splits brace patterns into individual Glob scans.

Symptom: Watcher fires but wrong collection processes events
  -> Collection prefix matching returns first match. Parent paths match before children.
  -> Fixed: cmdWatch() sorts by path length descending (most specific first).

Symptom: reindex --force crashes with UNIQUE constraint
  -> Force deactivates rows but UNIQUE(collection, path) doesn't discriminate by active flag.
  -> Fixed: indexer.ts reactivates inactive rows instead of inserting.

Symptom: CLI reindex/update falls back to node-llama-cpp
  -> GPU env vars only in systemd drop-in, not in wrapper script.
  -> Fixed: bin/clawmem wrapper exports CLAWMEM_EMBED_URL/LLM_URL/RERANK_URL defaults.
```

---

## CLI Reference

Run `clawmem --help` for full command listing.

### IO6 Surface Commands (daemon/`--print` mode)

```bash
# IO6a: per-prompt context injection (pipe prompt on stdin)
echo "user query" | clawmem surface --context --stdin

# IO6b: per-session bootstrap injection (pipe session ID on stdin)
echo "session-id" | clawmem surface --bootstrap --stdin
```

### Analysis Commands

```bash
clawmem reflect [N]             # Cross-session reflection (last N days, default 14)
                                # Recurring themes, antipatterns, co-activation clusters
clawmem consolidate [--dry-run] # Find and archive duplicate low-confidence documents
                                # Jaccard similarity within same collection
```

---

## Operational Issue Tracking

When encountering tool failures, instruction contradictions, retrieval gaps, or workflow friction:

Write to `docs/issues/YYYY-MM-DD-<slug>.md`:

```
# <title>
- Category: tool-failure | instruction-gap | workflow-friction | retrieval-gap | inconsistency
- Severity: critical | high | medium
- Status: open | resolved

## Observed
## Expected
## Context
## Suggested Fix
```

**Triggers:** repeated tool error, instruction contradicting observed behavior, retrieval consistently missing known content.

**Do NOT log:** one-off transient errors, user-caused issues, already recorded issues.

---

## Integration Notes

- QMD retrieval (BM25, vector, RRF, rerank, query expansion) is forked into ClawMem. Do not call standalone QMD tools.
- SAME (composite scoring), MAGMA (intent + graph), A-MEM (self-evolving notes) layer on top of QMD substrate.
- Three `llama-server` instances on local or remote GPU. Wrapper defaults to `localhost:8088/8089/8090`.
- `CLAWMEM_NO_LOCAL_MODELS=false` (default) allows in-process fallback. Set `true` for remote-only to fail fast.
- Consolidation worker (`CLAWMEM_ENABLE_CONSOLIDATION=true`) backfills unenriched docs. Only runs if MCP process stays alive long enough (every 5min).
- Beads integration: `syncBeadsIssues()` queries `bd` CLI (Dolt backend, v0.58.0+), creates markdown docs, maps dependency edges into `memory_relations`. Watcher auto-triggers on `.beads/` changes; `beads_sync` MCP for manual sync.
- HTTP REST API: `clawmem serve [--port 7438]` — optional REST server on localhost. Search, retrieval, lifecycle, and graph traversal. `POST /retrieve` mirrors `memory_retrieve` with auto-routing (keyword/semantic/causal/timeline/hybrid). `POST /search` provides direct mode selection. Bearer token auth via `CLAWMEM_API_TOKEN` env var (disabled if unset).
- OpenClaw ContextEngine plugin: `clawmem setup openclaw` — registers as native OpenClaw context engine. Dual-mode: shares vault with Claude Code hooks. Uses `before_prompt_build` for retrieval, `afterTurn()` for extraction, `compact()` for pre-compaction.

## Tool Selection (one-liner)

```
ClawMem escalation: memory_retrieve(query) | query(compact=true) | intent_search(why/when/entity) | query_plan(multi-topic) -> multi_get -> search/vsearch (spot checks)
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
