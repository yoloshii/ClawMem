# ClawMem — Agent Quick Reference

## Inference Services

ClawMem uses three `llama-server` instances for neural inference. By default, the `bin/clawmem` wrapper points at `localhost:8088/8089/8090` — run them on your local GPU.

| Service | Port | Model | VRAM | Protocol |
|---|---|---|---|---|
| Embedding | 8088 | granite-embedding-278m-multilingual-Q6_K | ~400MB | `/v1/embeddings` |
| LLM | 8089 | qmd-query-expansion-1.7B-q4_k_m | ~2.2GB | `/v1/chat/completions` |
| Reranker | 8090 | qwen3-reranker-0.6B-Q8_0 | ~1.3GB | `/v1/rerank` |

**Total VRAM:** ~4.5GB. Fits alongside other workloads on any modern GPU.

**Remote option:** To offload to a separate GPU machine, set `CLAWMEM_EMBED_URL`, `CLAWMEM_LLM_URL`, `CLAWMEM_RERANK_URL` to the remote host. Set `CLAWMEM_NO_LOCAL_MODELS=true` to prevent surprise fallback downloads.

**No GPU:** LLM and reranker fall back to in-process `node-llama-cpp` automatically (auto-downloads models on first use). CPU inference works but is significantly slower — GPU is strongly recommended. Embedding has no in-process fallback — a `llama-server --embeddings` instance is always required.

### Model Recommendations

| Role | Recommended Model | Source | Size | Notes |
|---|---|---|---|---|
| Embedding | granite-embedding-278m-multilingual-Q6_K | [bartowski/granite-embedding-278m-multilingual-GGUF](https://huggingface.co/bartowski/granite-embedding-278m-multilingual-GGUF) | 226MB | 768 dimensions. 512-token context (~1100 chars). Client-side truncation prevents 500 errors. |
| LLM | qmd-query-expansion-1.7B-q4_k_m | [tobil/qmd-query-expansion-1.7B-gguf](https://huggingface.co/tobil/qmd-query-expansion-1.7B-gguf) | ~1.1GB | QMD's Qwen3-1.7B finetune — trained specifically for query expansion (hyde/lex/vec). |
| Reranker | qwen3-reranker-0.6B-Q8_0 | [ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) | ~600MB | Cross-encoder architecture. Scores candidates against original query. |

**Qwen3 /no_think flag:** Qwen3 uses thinking tokens by default. ClawMem appends `/no_think` to all prompts automatically for structured output.

### Server Setup (all three use llama-server)

```bash
# Embedding (--embeddings flag required)
llama-server -m granite-embedding-278m-multilingual-Q6_K.gguf \
  --embeddings --port 8088 --host 0.0.0.0 --no-mmap -ngl 99 -c 2048 --batch-size 2048

# LLM (QMD finetuned model recommended)
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf \
  --port 8089 --host 0.0.0.0 -ngl 99 -c 4096 --batch-size 512

# Reranker (--reranking flag required)
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf \
  --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 512 --reranking
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
| `CLAWMEM_EMBED_URL` | `http://localhost:8088` | Embedding server. No in-process fallback — `llama-server --embeddings` required. |
| `CLAWMEM_LLM_URL` | `http://localhost:8089` | LLM server for intent, expansion, A-MEM. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. |
| `CLAWMEM_RERANK_URL` | `http://localhost:8090` | Reranker server. Falls to `node-llama-cpp` if unset + `NO_LOCAL_MODELS=false`. |
| `CLAWMEM_NO_LOCAL_MODELS` | `false` | Blocks `node-llama-cpp` from auto-downloading GGUF models. Set `true` for remote-only setups. |
| `CLAWMEM_ENABLE_AMEM` | enabled | A-MEM note construction + link generation during indexing. |
| `CLAWMEM_ENABLE_CONSOLIDATION` | disabled | Background worker backfills unenriched docs. Needs long-lived MCP process. |
| `CLAWMEM_CONSOLIDATION_INTERVAL` | 300000 | Worker interval in ms (min 15000). |

**Note:** The `bin/clawmem` wrapper sets all endpoint defaults and `CLAWMEM_NO_LOCAL_MODELS=true`. Always use the wrapper — never `bun run src/clawmem.ts` directly. For remote GPU setups, add the same env vars to the watcher service via a systemd drop-in.

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
| `session-bootstrap` | SessionStart | 2000 tokens | profile + latest handoff + recent decisions + stale notes |
| `context-surfacing` | UserPromptSubmit | 800 tokens | retrieval gate → hybrid search (vector + FTS supplement, 900ms timeout) → snooze filter → noise filter → `<vault-context>` injection |
| `staleness-check` | SessionStart | 250 tokens | flags notes not modified in 30+ days |
| `decision-extractor` | Stop | — | LLM extracts observations → `_clawmem/agent/observations/`, infers causal links, detects contradictions with prior decisions |
| `handoff-generator` | Stop | — | LLM summarizes session → `_clawmem/agent/handoffs/` |
| `feedback-loop` | Stop | — | tracks referenced notes → boosts confidence |
| `precompact-extract` | PreCompact | — | extracts decisions, file paths, open questions → writes `precompact-state.md` to auto-memory. Query-aware decision ranking. Reindexes auto-memory collection. |
| `postcompact-inject` | SessionStart (compact) | 1200 tokens | re-injects authoritative context after compaction: precompact state (600) + recent decisions (400) + antipatterns (150) + vault context (200) → `<vault-postcompact>` |
| `pretool-inject` | PreToolUse | 200 tokens | searches vault for file-specific context before Read/Edit/Write. Surfaces via `reason` field. Disabled in HOOK_EVENT_MAP (cannot inject additionalContext). |

**Default behavior:** Read injected `<vault-context>` first. If sufficient, answer immediately.

**Hook blind spots (by design):** Hooks filter out `_clawmem/` system artifacts, enforce score thresholds, and cap token budget. Absence in `<vault-context>` does NOT mean absence in memory. If you expect a memory to exist but it wasn't surfaced, escalate to Tier 3.

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

5. Memory debugging → memory_evolution_status(docid)

6. Temporal context → timeline(docid, before=5, after=5, same_collection=false)
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

### Memory Lifecycle

Pin, snooze, and forget are **manual MCP tools** — not automated. The agent should proactively use them when appropriate:

- **Pin** (`memory_pin`) — +0.3 composite boost, ensures persistent surfacing.
  - **Proactive triggers:** User says "remember this" / "don't forget" / "this is important". Architecture or critical design decision just made. User-stated preference or constraint that should persist across sessions.
  - **Do NOT pin:** routine decisions, session-specific context, or observations that will naturally surface via recency.
- **Snooze** (`memory_snooze`) — temporarily hides from context surfacing until a date.
  - **Proactive triggers:** A memory keeps surfacing but isn't relevant to current work. User says "not now" / "later" / "ignore this for now". Seasonal or time-boxed content (e.g., "revisit after launch").
- **Forget** (`memory_forget`) — permanently deactivates. Use sparingly.
  - Only when a memory is genuinely wrong or permanently obsolete. Prefer snooze for temporary suppression.
- **Contradictions auto-resolve:** When `decision-extractor` detects a new decision contradicting an old one, the old decision's confidence is lowered automatically. No manual intervention needed for superseded decisions.

### Anti-Patterns

- Do NOT manually pick query/intent_search/search when `memory_retrieve` can auto-route.
- Do NOT call MCP tools every turn — three rules above are the only gates.
- Do NOT re-search what's already in `<vault-context>`.
- Do NOT run `status` routinely. Only when retrieval feels broken or after large ingestion.
- Do NOT pin everything — pin is for persistent high-priority items, not temporary boosting.
- Do NOT forget memories to "clean up" — let confidence decay and contradiction detection handle it naturally.
- Do NOT run `build_graphs` after every reindex — A-MEM creates per-doc links automatically. Only after bulk ingestion or when `intent_search` returns weak graph results.

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
| decision, hub | ∞ | Never decay |
| antipattern | ∞ | Never decay — accumulated negative patterns persist |
| project | 120 days | Slow decay |
| research | 90 days | Moderate decay |
| note | 60 days | Default |
| progress | 45 days | Faster decay |
| handoff | 30 days | Fast — recent matters most |

Half-lives extend up to 3× for frequently-accessed memories (access reinforcement decays over 90 days).
Attention decay: non-durable types (handoff, progress, note, project) lose 5% confidence per week without access. Decision/hub/research/antipattern are exempt.

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

**Edge collision:** Both `generateMemoryLinks()` and `buildSemanticGraph()` insert `relation_type='semantic'`. PK is `(source_id, target_id, relation_type)` — first writer wins.

**Graph traversal asymmetry:** `adaptiveTraversal()` traverses all edge types outbound (source→target) but only `semantic` and `entity` edges inbound (target→source). Temporal and causal edges are directional only.

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
  → BM25 Probe → Strong Signal Check (skip expansion if top hit ≥ 0.85 with gap ≥ 0.15; disabled when intent provided)
  → Query Expansion (LLM generates text variants; intent steers expansion prompt)
  → Parallel: BM25(original) + Vector(original) + BM25(each expanded) + Vector(each expanded)
  → Original query lists get positional 2× weight in RRF; expanded get 1×
  → Reciprocal Rank Fusion (k=60, top candidateLimit)
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

## Operational Issue Tracking

When encountering tool failures, instruction contradictions, retrieval gaps, or workflow friction that would benefit from a fix:

Write to `docs/issues/YYYY-MM-DD-<slug>.md` with: category, severity, what happened, what was expected, context, suggested fix.

**File structure:**
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

**Triggers:** repeated tool error, instruction that contradicts observed behavior, retrieval consistently missing known content, workflow requiring unnecessary steps.

**Do NOT log:** one-off transient errors, user-caused issues, issues already recorded.

## Troubleshooting

```
Symptom: "Local model download blocked" error
  → llama-server endpoint unreachable while CLAWMEM_NO_LOCAL_MODELS=true.
  → Fix: Start the llama-server instance. Or set CLAWMEM_NO_LOCAL_MODELS=false for in-process fallback.

Symptom: Query expansion always fails / returns garbage
  → In-process CPU inference is significantly slower and less reliable than GPU.
  → Fix: Run llama-server on a GPU. Even a low-end NVIDIA card handles 1.7B models.

Symptom: Vector search returns no results but BM25 works
  → Missing embeddings. Watcher indexes but does NOT embed.
  → Fix: Run `clawmem embed` or wait for the daily embed timer.

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

Symptom: CLI reindex/update falls back to node-llama-cpp Vulkan (not GPU server)
  → GPU env vars only in systemd drop-in, not in wrapper script. CLI invocations missed them.
  → Fixed 2026-02-12: bin/clawmem wrapper exports CLAWMEM_EMBED_URL/LLM_URL/RERANK_URL defaults.
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

**Analysis commands:**
```bash
clawmem reflect [N]             # Cross-session reflection (last N days, default 14)
                                # Shows recurring themes, antipatterns, co-activation clusters
clawmem consolidate [--dry-run] # Find and archive duplicate low-confidence documents
                                # Uses Jaccard similarity within same collection
```

## Integration Notes

- QMD retrieval (BM25, vector, RRF, rerank, query expansion) is forked into ClawMem. Do not call standalone QMD tools.
- SAME (composite scoring), MAGMA (intent + graph), A-MEM (self-evolving notes) layer on top of QMD substrate.
- Three `llama-server` instances (embedding, LLM, reranker) on local or remote GPU. Wrapper defaults to `localhost:8088/8089/8090`.
- `CLAWMEM_NO_LOCAL_MODELS=false` (default) allows in-process LLM/reranker fallback via `node-llama-cpp`. Set `true` for remote-only setups to fail fast on unreachable endpoints.
- Consolidation worker (`CLAWMEM_ENABLE_CONSOLIDATION=true`) backfills unenriched docs with A-MEM notes + links. Only runs if the MCP process stays alive long enough to tick (every 5min).
- Beads integration: `syncBeadsIssues()` queries `bd` CLI (Dolt backend, v0.58.0+) for live issue data, creates markdown docs in `beads` collection, maps all dependency edge types into `memory_relations`, and triggers A-MEM enrichment for new docs. Watcher auto-triggers on `.beads/` directory changes; `beads_sync` MCP tool for manual sync. Requires `bd` binary on PATH or at `~/go/bin/bd`.
