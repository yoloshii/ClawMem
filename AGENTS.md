# ClawMem — Agent Quick Reference

On-device retrieval-augmented memory for Claude Code, OpenClaw, and Hermes agents. **Hooks** auto-inject context (~90%); **MCP tools** cover targeted recall (~10%). TypeScript on Bun, MIT.

This file is the **lean root SSOT** — agent-facing essentials only. Deep reference lives in `docs/` (linked throughout, indexed at the bottom). `CLAUDE.md` is an `@AGENTS.md` import; `SKILL.md` is the portable on-demand operating reference.

---

## Inference at a glance

Three services — **embedding**, **LLM** (query expansion / intent / A-MEM), **reranker**. Default: all three as `llama-server` with an in-process `node-llama-cpp` fallback that auto-downloads on first use (works with no GPU). The `bin/clawmem` wrapper points at `localhost:8088/8089/8090`. **Always run via `bin/clawmem`** — it sets the endpoints.

**Choose a stack:**
- **native** (default) — EmbeddingGemma-300M + qmd-query-expansion-1.7B + qwen3-reranker-0.6B · ~4 GB or in-process · **permissive, commercial OK** · zero-config.
- **z / SOTA** — zembed-1 + qmd-query-expansion-1.7B + zerank-2 seq-cls **sidecar** · ~16 GB · **CC-BY-NC-4.0, non-commercial only** · best recall.
- **cloud embedding** — Jina/OpenAI/Voyage/Cohere · embedding **only** (LLM + reranker stay local) · no local GPU needed.

**Landmines:**
- The zerank-2 **GGUF is inert** — llama.cpp drops the score head → ranking silently collapses to RRF. Use the **seq-cls sidecar**; verify with `clawmem rerank-health` (liveness ≠ correctness).
- `-ub` must equal `-b` for embedding/reranking (non-causal attention) or `llama-server` asserts.
- Changing embedding dimensions → `clawmem embed --force` (full re-embed).
- `CLAWMEM_NO_LOCAL_MODELS=true` to fail fast instead of silent CPU fallback.

→ Stack decision matrix + server setup: [docs/guides/inference-services.md](docs/guides/inference-services.md) · cloud: [docs/guides/cloud-embedding.md](docs/guides/cloud-embedding.md) · all env vars: [docs/reference/configuration.md](docs/reference/configuration.md).

---

## Install

```bash
npm install -g clawmem                      # or: bun add -g clawmem
clawmem bootstrap ~/notes --name notes      # init + index + embed + hooks + MCP

# Or step by step:
clawmem init
clawmem collection add ~/notes --name notes
clawmem update --embed
clawmem setup hooks && clawmem setup mcp
clawmem doctor                              # full health check (clawmem status = quick)
```

→ Quickstart + index patterns: [docs/quickstart.md](docs/quickstart.md) · hooks/MCP: [docs/guides/setup-hooks.md](docs/guides/setup-hooks.md), [docs/guides/setup-mcp.md](docs/guides/setup-mcp.md) · background services: [docs/guides/systemd-services.md](docs/guides/systemd-services.md) · upgrading: [docs/guides/upgrading.md](docs/guides/upgrading.md).

---

## Memory retrieval (90/10 rule)

### Tier 2 — automatic (hooks, zero agent effort)

| Hook | Trigger | Does |
|------|---------|------|
| `context-surfacing` | UserPromptSubmit | retrieval gate → profile-driven hybrid search → FTS supplement → file-aware search → snooze/noise filters → spreading activation → memory-type diversification → tiered injection → `<vault-context>` (+ optional `<vault-facts>` SPO triples, `<vault-routing>` hint). Budget/results/timeout/threshold driven by `CLAWMEM_PROFILE`. |
| `postcompact-inject` | SessionStart (compact) | re-injects authoritative state after compaction → `<vault-postcompact>` |
| `curator-nudge` | SessionStart | surfaces curator actions; nudges when the report is stale |
| `precompact-extract` | PreCompact | extracts decisions / file paths / open questions before compaction |
| `decision-extractor` | Stop | LLM → observations + causal links + contradiction detection + SPO triples |
| `handoff-generator` | Stop | LLM session summary → handoffs |
| `feedback-loop` | Stop | tracks referenced notes → confidence boosts, co-activations, utility signals |

**Default behavior:** read injected `<vault-context>` first; if sufficient, answer immediately.
**Blind spots (by design):** hooks filter `_clawmem/` artifacts, enforce score thresholds, cap token budget — **absence in `<vault-context>` does NOT mean absence in memory.** If expected memory wasn't surfaced, escalate to Tier 3.
**Profiles:** `speed` / `balanced` (default) / `deep` set the kept-score ratio (65% / 55% / 45%) + an activation floor; only `deep` adds query expansion + reranking to the hook path. → [docs/concepts/hooks-vs-mcp.md](docs/concepts/hooks-vs-mcp.md).

### Tier 3 — agent-initiated (one targeted MCP call)

**3-rule escalation gate — escalate ONLY when one fires:**
1. **Low-specificity injection** — `<vault-context>` is empty or lacks the specific fact the task requires.
2. **Cross-session question** — "why did we decide X", "what changed since last time", "when did we start Y".
3. **Pre-irreversible check** — before a destructive / hard-to-reverse change, check the vault for prior decisions.

All other retrieval is handled by Tier 2 hooks. **Do NOT call MCP tools speculatively.**

**Routing** — PREFERRED: `memory_retrieve(query)` auto-classifies and routes to the optimal backend.

```
1a. General recall      -> query(query, compact=true, limit=20)
    Full hybrid: BM25 + vector + expansion + deep rerank. Supports compact, collection,
    intent, candidateLimit. BM25 strong-signal bypass skips expansion when top hit >= 0.85
    with gap >= 0.15 (disabled when intent is provided).
1b. Causal/why/when/entity -> intent_search(query, enable_graph_traversal=true)
    MAGMA intent classification + intent-weighted RRF + multi-hop graph traversal.
    Use DIRECTLY (not as a fallback) for "why" / "when" / "how did X lead to Y" / entity links.
    Override: force_intent="WHY"|"WHEN"|"ENTITY"|"WHAT". (1a vs 1b are parallel, chosen by query type.)
1c. Multi-topic         -> query_plan(query, compact=true)
    Decomposes into 2-4 typed clauses (bm25/vector/graph), runs them in parallel, merges via RRF.
2.  Progressive disclosure -> multi_get("path1,path2") for full content of top hits
3.  Spot checks         -> search(query) (BM25, 0 GPU)  or  vsearch(query) (vector, 1 GPU)
4.  Chain tracing       -> find_causal_links(docid, direction="both", depth=5)
5.  Entity facts        -> kg_query(entity)  (SPO triples; NOT causal "why" — that's intent_search)
6.  Temporal context    -> timeline(docid, before=5, after=5)
```

| Tool | Purpose |
|------|---------|
| `memory_retrieve` | **Preferred.** Auto-classifies + routes. Use instead of choosing manually. |
| `query` | Full hybrid (BM25 + vector + rerank). General-purpose. WRONG for "why" (→ `intent_search`) or cross-session (→ `session_log`). |
| `intent_search` | "why did we decide X" / "what caused Y" / "who worked on Z". Classifies intent, traverses graph edges — decision chains `query` can't find. |
| `query_plan` | Multi-topic ("X and also Y", "compare A with B"). Splits + routes each clause. |
| `search` | BM25 keyword — exact terms, config names, error codes. Fast, 0 GPU. |
| `vsearch` | Vector semantic — conceptual/fuzzy when vocabulary unknown. ~100ms, 1 GPU. |
| `get` / `multi_get` | Single doc by path/`#docid` / multiple by glob or comma-list. |
| `find_similar` | "what else relates to X" — k-NN vector neighbors beyond keyword overlap. |
| `find_causal_links` | Trace decision chains ("what led to X") over observation docs. |
| `kg_query` | Entity SPO triples with temporal validity. Entity facts, NOT causal "why". |
| `session_log` | "last time" / "yesterday" / "what did we do". Do NOT use `query` for cross-session. |
| `profile` | User profile (static facts + dynamic context). |
| `memory_pin` | +0.3 composite boost. PROACTIVELY for constraints, architecture decisions, corrections. |
| `memory_snooze` | PROACTIVELY when `<vault-context>` surfaces noise — snooze 30 days. |
| `memory_forget` | Deactivate a memory by closest match. Sparingly — prefer snooze. |
| `build_graphs` | Temporal backbone + semantic graph after bulk ingestion. NOT after every reindex. |
| `timeline` | Temporal neighborhood around a doc. Progressive disclosure: search → timeline → get. |
| `memory_evolution_status` | How a doc's A-MEM metadata evolved over time. |
| `lifecycle_status` / `lifecycle_sweep` / `lifecycle_restore` | Lifecycle stats / archive stale (dry-run default) / restore. |
| `index_stats` / `status` / `reindex` | Doc counts + embedding coverage / quick health / force re-index (does NOT embed). |
| `beads_sync` / `vault_sync` / `list_vaults` | Beads from Dolt / index a dir into a named vault / list vaults. |
| `diary_write` / `diary_read` | Diary entries — non-hooked envs only (in Claude Code hooks capture this). |

**Multi-vault:** all tools accept an optional `vault` param (omit for single-vault mode). **Progressive disclosure:** ALWAYS `compact=true` first → review snippets/scores → `get` / `multi_get` for full content. → full param docs: [docs/reference/mcp-tools.md](docs/reference/mcp-tools.md).

---

## Query optimization (4 levers)

The pipeline autonomously generates lex/vec/hyde variants, fuses BM25 + vector via RRF, and reranks with a cross-encoder — you do NOT choose search types. Your levers:

1. **Tool selection (highest impact)** — pick the lightest tool: `search` (BM25, 0 GPU, exact terms) < `vsearch` (vector, 1 GPU, fuzzy) < `query` (full hybrid) < `intent_search` (why/entity chains) < `query_plan` (multi-topic).
2. **Query string quality** — keyword recall: 2–5 precise terms, no filler (BM25 ANDs prefix matches, no phrase/negation). Semantic recall: full natural-language question. Do NOT write hypothetical-answer queries (the LLM already generates hyde variants).
3. **Intent (disambiguation)** — `query("performance", intent="web page load times")` steers 5 stages; use when the term is polysemous or the domain is ambiguous; skip when already specific. Disables BM25 strong-signal bypass (correct — intent signals ambiguity).
4. **candidateLimit** — RRF candidates reaching the reranker (default 30). Lower (15) for speed/small vault; higher (50) for broad topics/recall.

→ pipeline internals: [docs/internals/query-pipeline.md](docs/internals/query-pipeline.md), [docs/internals/intent-search-pipeline.md](docs/internals/intent-search-pipeline.md). Deeper operating guidance: `SKILL.md`.

---

## Composite scoring

Applied automatically to all search results.

```
compositeScore = (0.50·searchScore + 0.25·recencyScore + 0.25·confidenceScore) × qualityMultiplier × coActivationBoost
```

- `qualityMultiplier = 0.7 + 0.6·qualityScore` (0.7× … 1.3×); `coActivationBoost` up to +15%; length-normalized (floor 30%); frequency boost capped +10%; **pinned docs +0.3 additive**.
- **`query` tool (v0.13.0+):** non-recency queries use **0.70·search + 0.15·recency + 0.15·confidence**. `search`/`vsearch`/`memory_retrieve`/context-surfacing keep the 0.50/0.25/0.25 default.
- **Recency intent** ("latest"/"recent"/"last session") switches all to **0.10·search + 0.70·recency + 0.20·confidence**.
- **Half-lives:** decision/deductive/preference/hub/antipattern = ∞ · project 120d · research 90d · problem/milestone/note 60d · conversation/progress 45d · handoff 30d (extend up to 3× for frequently-accessed).

→ full derivation: [docs/concepts/composite-scoring.md](docs/concepts/composite-scoring.md).

---

## Indexing rules

- **Indexed** (per collection in `config.yaml`): `**/MEMORY.md` · `**/memory/**` · `**/docs/**` · `**/research/**` · `**/YYYY-MM-DD*` (`.md`/`.txt`).
- **Excluded (always):** `gits/`, `scraped/`, `.git/`, `node_modules/`, `dist/`, `build/`, `vendor/`. **Never index** credential files (`.env`, `*secrets*`, `*credentials*`) or `gits/`.
- **Indexing ≠ embedding:** the watcher indexes on `.md` change but does NOT embed; the embed timer (or `clawmem embed`) keeps vectors fresh. Missing embeddings silently degrade vector recall — BM25 still works.

→ architecture + graph building: [docs/concepts/architecture.md](docs/concepts/architecture.md), [docs/internals/graph-traversal.md](docs/internals/graph-traversal.md).

---

## Memory lifecycle (pin / snooze / forget — manual tools)

- **`memory_pin`** (+0.3 boost, persistent surfacing) — PROACTIVELY when: user says "remember this"/"important"; an architecture/critical decision was just made; a user preference/constraint should persist. Do NOT pin routine/session-specific items.
- **`memory_snooze`** — PROACTIVELY when a memory keeps surfacing but isn't relevant now, user says "not now"/"later", or content is time-boxed.
- **`memory_forget`** — only when genuinely wrong or permanently obsolete. Prefer snooze for temporary suppression.
- **Contradiction auto-resolution:** when `decision-extractor` detects a new decision contradicting an old one, the old one's confidence is lowered automatically — no manual action needed.

---

## Operational gotchas

- **Empty `context-surfacing`** → prompt < 20 chars, starts with `/`, or nothing scored above threshold. Check `clawmem status` + embedding coverage.
- **Vector search empty but BM25 works** → missing embeddings (the watcher indexes but does NOT embed). Run `clawmem embed`.
- **`intent_search` weak for WHY/ENTITY** → sparse graph. Run `build_graphs`. Don't run it after every reindex (A-MEM links per-doc automatically).
- **Rankings look RRF-flat / reranker suspect** → `clawmem rerank-health`. A mis-served reranker (e.g. a GGUF that drops the score head) returns HTTP 200 but inert scores, silently collapsing ranking to RRF.
- **Intermittent `UserPromptSubmit hook timed out after 8s — output discarded`** → **fixed in v0.16.0** (upgrade). Root cause was not inference or host RAM alone: the `context-surfacing` vector leg ran a *synchronous* `sqlite-vec` scan that the `Promise.race(vectorTimeout)` guard could not bound (a synchronous call blocks the event loop, so the timer never fires), and every writable hook open ran an unconditional backfill `UPDATE` that could wait out `busy_timeout` under writer contention. v0.16.0 bounds both vector legs with real deadlines + timer cleanup, read-guards the init backfill, caps the init `busy_timeout`, and adds a watcher-side vector prewarm. A cold OS page cache still adds latency to the first post-boot call, so RAM headroom helps the margin — but on a large vault the scan cost, not RAM, was the dominant trigger. Still seeing it after upgrading? Raise the hook `timeout` in `~/.claude/settings.json` (8s default; no CLI knob) as a secondary margin. Detail: [docs/troubleshooting.md](docs/troubleshooting.md).
- **Anything setup-shaped** (download blocked, server unreachable, watcher memory bloat, indexer bugs) → [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Anti-patterns

- ❌ Manually pick `query`/`intent_search`/`search` when `memory_retrieve` can auto-route → ✅ `memory_retrieve` first.
- ❌ Call MCP tools every turn → ✅ only when the 3-rule gate fires.
- ❌ Re-search what's already in `<vault-context>`.
- ❌ Run `status` routinely → ✅ only when retrieval feels broken or after large ingestion.
- ❌ Pin everything → ✅ pin only persistent high-priority items.
- ❌ Forget memories to "clean up" → ✅ let decay + contradiction detection handle it.
- ❌ `build_graphs` after every reindex → ✅ only after bulk ingestion or weak graph traversal.
- ❌ `diary_write` in Claude Code → ✅ hooks capture this (diary is for non-hooked envs only).
- ❌ `kg_query` for causal "why" → ✅ `intent_search` (kg_query is entity facts, not reasoning chains).

---

## Curator agent

Maintenance agent for Tier-3 work the main agent neglects. Install: `clawmem setup curator`. Invoke: **"curate memory" / "run curator" / "memory maintenance"**. Six phases: health snapshot → lifecycle triage (pin/snooze/propose-forget, never auto-confirms) → retrieval health probes → reflect + consolidate `--dry-run` → conditional graph rebuild → collection hygiene. Never auto-confirms forget, never runs embed, never edits config.

---

## Integrations

- **Claude Code** — `clawmem setup hooks && clawmem setup mcp`. Hooks = 90% auto; 31 MCP tools = 10%.
- **OpenClaw** — native memory plugin (`kind: memory`, v0.10.0+): `clawmem setup openclaw`. → [docs/guides/openclaw-plugin.md](docs/guides/openclaw-plugin.md).
- **Hermes** — `MemoryProvider` plugin: copy `src/hermes/` into `$HERMES_HOME/plugins/clawmem/`. → [docs/guides/hermes-plugin.md](docs/guides/hermes-plugin.md).
- **REST API** — `clawmem serve [--port 7438]`. → [docs/reference/rest-api.md](docs/reference/rest-api.md).

All integrations share the same SQLite vault — decisions captured in one runtime surface in the others.

---

## Tool selection (one-liner)

```
memory_retrieve(query) | query(compact=true) | intent_search(why/when/entity) | query_plan(multi-topic) -> multi_get -> search/vsearch (spot checks)
```

---

## Deep reference (docs/)

| Topic | Path |
|---|---|
| Quickstart / introduction | `docs/quickstart.md`, `docs/introduction.md` |
| Inference stack + server setup | `docs/guides/inference-services.md` |
| Cloud embedding | `docs/guides/cloud-embedding.md` |
| Configuration (env vars) | `docs/reference/configuration.md` |
| Hooks vs MCP | `docs/concepts/hooks-vs-mcp.md` |
| Composite scoring | `docs/concepts/composite-scoring.md` |
| Architecture / multi-vault | `docs/concepts/architecture.md`, `docs/concepts/multi-vault.md` |
| Pipelines / graph / entities | `docs/internals/{query-pipeline,intent-search-pipeline,graph-traversal,entity-resolution}.md` |
| MCP tools / CLI / REST | `docs/reference/{mcp-tools,cli,rest-api}.md` |
| Setup (hooks / mcp / systemd) | `docs/guides/{setup-hooks,setup-mcp,systemd-services}.md` |
| OpenClaw / Hermes plugins | `docs/guides/openclaw-plugin.md`, `docs/guides/hermes-plugin.md` |
| Troubleshooting | `docs/troubleshooting.md` |
| Upgrading | `docs/guides/upgrading.md` |
| Operating ClawMem at query time (portable skill) | `SKILL.md` |
