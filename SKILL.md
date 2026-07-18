---
name: clawmem
description: "ClawMem operational reference for agents at query time — the 3-rule escalation gate, MCP tool routing, the 4 query-optimization levers, pipeline behavior (query vs intent_search), composite scoring, and memory lifecycle (pin/snooze/forget). Use when tuning retrieval, troubleshooting recall quality, or any ClawMem operation beyond the routing already in your global CLAUDE.md / this repo's AGENTS.md. NOT for setup — install / inference-server config / env vars / systemd / indexing config / internals live in AGENTS.md + docs/."
allowed-tools: "mcp__clawmem__*"
metadata:
  author: yoloshii
  version: 2.0.0
---

# ClawMem Operational Reference

**Scope: agent-time operations only** — escalation, tool routing, query tuning, pipeline reasoning, composite scoring, lifecycle. Setup, inference-server config, env vars, systemd units, indexing/collection config, graph internals, and the OpenClaw/Hermes plugins are **deliberately not here** — they live in this repo's [`AGENTS.md`](AGENTS.md) + [`docs/`](docs/) (e.g. [`docs/guides/inference-services.md`](docs/guides/inference-services.md), [`docs/reference/configuration.md`](docs/reference/configuration.md), [`docs/troubleshooting.md`](docs/troubleshooting.md), [`docs/internals/`](docs/internals/)). Kept out to avoid drift between this skill and the package.

Routine memory needs neither this skill nor manual MCP calls — **hooks + the ClawMem routing already in `AGENTS.md` / your global `CLAUDE.md` handle ~90%.** Reach for this skill (and Tier-3 tools) only when that isn't enough.

## Architecture (one-liner)

Two tiers: **hooks** = automatic context flow (surfacing, extraction, compaction survival); **MCP tools** = explicit recall / write / lifecycle. Substrate: QMD retrieval (BM25 + vector + RRF + cross-encoder rerank + query expansion), with SAME (composite scoring), MAGMA (intent + graph), and A-MEM (self-evolving notes) layered on top. Do not call standalone QMD tools.

---

## Tier 2 — Automatic retrieval (hooks)

Hooks handle ~90% of retrieval at zero agent effort.

| Hook | Trigger | Does |
|------|---------|------|
| `context-surfacing` | UserPromptSubmit | retrieval gate → profile-driven hybrid search → FTS supplement → file-aware search → snooze/noise filters → spreading activation → memory-type diversification → tiered injection → `<vault-context>` (+ optional `<vault-facts>` / `<vault-routing>`). Budget/results/timeout/threshold driven by `CLAWMEM_PROFILE`. |
| `postcompact-inject` | SessionStart (compact) | re-injects authoritative state after compaction → `<vault-postcompact>` |
| `curator-nudge` | SessionStart | surfaces curator actions; nudges when the report is stale |
| `precompact-extract` | PreCompact | extracts decisions / file paths / open questions before compaction |
| `decision-extractor` | Stop | LLM → observations + causal links + contradiction detection + SPO triples |
| `handoff-generator` | Stop | LLM session summary → handoffs |
| `feedback-loop` | Stop | tracks referenced notes → confidence boosts, co-activations, utility signals |

**Default behavior:** read injected `<vault-context>` first; if sufficient, answer immediately.

**Hook blind spots (by design):** hooks filter `_clawmem/` artifacts, enforce score thresholds, and cap token budget — **absence in `<vault-context>` does NOT mean absence in memory.** If expected memory wasn't surfaced, escalate to Tier 3. Note the MCP retrieval tools themselves exclude `_clawmem` by default since v0.21.0 — pass `includeInternal: true` when system-internal memory (observations/handoffs/deductions) is the target.

**Profiles:** `speed` / `balanced` (default) / `deep` set the kept-score ratio (65% / 55% / 45%) and an activation floor. Only `deep` adds query expansion + reranking to the hook path. Profile and the hook `timeout` are set in `~/.claude/settings.json` — see *Operational gotchas* for timeout tuning.

---

## Tier 3 — Agent-initiated retrieval (MCP tools)

### 3-rule escalation gate

Escalate to MCP tools ONLY when one of these fires:

1. **Low-specificity injection** — `<vault-context>` is empty or lacks the specific fact the task requires.
2. **Cross-session question** — "why did we decide X", "what changed since last time", "when did we start Y".
3. **Pre-irreversible check** — about to make a destructive / hard-to-reverse change; check the vault for prior decisions first.

All other retrieval is handled by Tier 2 hooks. **Do NOT call MCP tools speculatively.**

### Tool routing

**PREFERRED:** `memory_retrieve(query)` — auto-classifies and routes to the optimal backend (query / intent_search / session_log / find_similar / query_plan). Use this instead of manually choosing.

```
1a. General recall      -> query(query, compact=true, limit=20)
    Full hybrid: BM25 + vector + expansion + deep rerank. Supports compact, collection,
    intent, candidateLimit. BM25 strong-signal bypass skips expansion when top hit >= 0.85
    with gap >= 0.15 (disabled when intent is provided).
1b. Causal/why/when/entity -> intent_search(query, enable_graph_traversal=true)
    MAGMA intent classification + intent-weighted RRF + multi-hop graph traversal.
    Use DIRECTLY (not as a fallback) for "why" / "when" / "how did X lead to Y" / entity links.
    Override: force_intent="WHY"|"WHEN"|"ENTITY"|"WHAT".
    (1a vs 1b are parallel options, chosen by query type — not sequential.)
1c. Multi-topic         -> query_plan(query, compact=true)
    Decomposes into 2-4 typed clauses (bm25/vector/graph), runs them in parallel, merges via RRF.
2.  Progressive disclosure -> multi_get("path1,path2") for full content of top hits
3.  Spot checks         -> search(query) (BM25, 0 GPU)  or  vsearch(query) (vector, 1 GPU)
4.  Chain tracing       -> find_causal_links(docid, direction="both", depth=5)
5.  Entity facts        -> kg_query(entity)  (SPO triples; different from intent_search's reasoning chains)
6.  Temporal context    -> timeline(docid, before=5, after=5)
```

### All MCP tools

| Tool | Purpose |
|------|---------|
| `memory_retrieve` | **Preferred.** Auto-classifies + routes. Use instead of choosing manually. |
| `query` | Full hybrid (BM25 + vector + rerank). General-purpose. WRONG for "why" (→ `intent_search`) or cross-session (→ `session_log`). |
| `intent_search` | "why did we decide X" / "what caused Y" / "who worked on Z". Classifies intent, traverses graph edges — returns decision chains `query` can't find. |
| `query_plan` | Multi-topic queries ("X and also Y", "compare A with B"). Splits + routes each clause. |
| `search` | BM25 keyword — exact terms, config names, error codes. Fast, 0 GPU. |
| `vsearch` | Vector semantic — conceptual/fuzzy when vocabulary unknown. ~100ms, 1 GPU. |
| `get` / `multi_get` | Single doc by path/`#docid` / multiple by glob or comma-list. |
| `find_similar` | "what else relates to X" — k-NN vector neighbors beyond keyword overlap. |
| `find_causal_links` | Trace decision chains ("what led to X") over observation docs. |
| `kg_query` | Entity SPO triples with temporal validity. Entity facts, NOT causal "why" (use `intent_search`). |
| `session_log` | "last time" / "yesterday" / "what did we do". Do NOT use `query` for cross-session. |
| `profile` | User profile (static facts + dynamic context). |
| `memory_pin` | Lifecycle retention + priority among relevance-equivalent results (+0.3 composite boost on composite surfaces; exact-tie precedence on raw routes — vector + `search` non-recency). Use PROACTIVELY for constraints, architecture decisions, corrections. |
| `memory_snooze` | Use PROACTIVELY when `<vault-context>` surfaces noise — snooze 30 days. |
| `memory_forget` | Deactivate a memory by closest match. Sparingly — prefer snooze. Weak matches return a disambiguation list instead of acting (v0.23.0). |
| `build_graphs` | Temporal backbone + semantic graph after bulk ingestion. NOT after every reindex. |
| `timeline` | Temporal neighborhood around a doc. Progressive disclosure: search → timeline → get. |
| `memory_evolution_status` | How a doc's A-MEM metadata evolved over time. |
| `lifecycle_status` / `lifecycle_sweep` / `lifecycle_restore` | Lifecycle stats / archive stale (dry-run default) / restore auto-archived. |
| `index_stats` / `status` / `reindex` | Doc counts + embedding coverage / quick health / force re-index (does NOT embed). |
| `beads_sync` / `vault_sync` / `list_vaults` | Beads issues from Dolt / index a dir into a named vault / list vaults. |

**Multi-vault:** all tools accept an optional `vault` param (omit for single-vault mode). **Progressive disclosure:** ALWAYS `compact=true` first → review snippets/scores → `get` / `multi_get` for full content.

---

## Query optimization (4 levers)

The pipeline autonomously generates lex/vec/hyde variants, fuses BM25 + vector via RRF, and reranks with a cross-encoder — you do NOT choose search types. Your levers are **tool selection, query string quality, intent, and candidateLimit.**

### Lever 1 — Tool selection (highest impact)

Pick the lightest tool that satisfies the need:

| Tool | Cost | When |
|------|------|------|
| `search(q, compact=true)` | BM25 only, 0 GPU | Know exact terms, spot-check |
| `vsearch(q, compact=true)` | Vector only, 1 GPU | Conceptual/fuzzy, vocabulary unknown |
| `query(q, compact=true)` | Full hybrid, 3+ GPU | General recall, need best results |
| `intent_search(q)` | Hybrid + graph | Why/entity chains, when queries |
| `query_plan(q, compact=true)` | Hybrid + decomposition | Complex multi-topic |

### Lever 2 — Query string quality

The query string feeds BM25 (probes first, can short-circuit the pipeline) and anchors the 2×-weighted original signal in RRF — the single biggest determinant of result quality.

- **Keyword recall (BM25):** 2–5 precise terms, no filler. Code identifiers work (`handleError async`). BM25 ANDs all terms as prefix matches (`perf` matches "performance") — no phrase search or negation. A strong hit (≥ 0.85, gap ≥ 0.15) skips expansion.
- **Semantic recall (vector):** full natural-language question, be specific — `"in the payment service, how are refunds processed"` > `"refunds"`.
- **Do NOT write hypothetical-answer-style queries** — the expansion LLM already generates hyde variants; a long hypothetical dilutes BM25 and duplicates the pipeline.

### Lever 3 — Intent (disambiguation)

Steers 5 autonomous stages (expansion, reranking, chunk selection, snippet extraction, strong-signal bypass). `query("performance", intent="web page load times and Core Web Vitals")`.

- **Provide when:** the term is polysemous in the vault, or the domain is known but the query alone is ambiguous.
- **Skip when:** the query is already specific, single-domain vault, or using `search`/`vsearch` (intent only affects `query`).
- Intent disables the BM25 strong-signal bypass (forces full expansion+rerank) — correct, since intent signals ambiguity.

### Lever 4 — candidateLimit

How many RRF candidates reach the cross-encoder reranker (default 30). Lower (`15`) for high-confidence/speed/small-vault; higher (`50`) for broad topics/large vault/recall-over-speed.

---

## Pipeline behavior

### `query` (default Tier 3 workhorse)

```
Query + optional intent
  -> Temporal extraction (date ranges from "last week"/"March 2026")
  -> BM25 probe -> strong-signal check (skip expansion if top >= 0.85, gap >= 0.15; off when intent given)
  -> Query expansion (LLM text variants; intent steers the prompt)
  -> Parallel typed legs: BM25(orig) + Vector(orig) + BM25(lex exp) + Vector(vec/hyde exp) [+ temporal/entity if signalled]
  -> RRF (k=60; original lists get 2x positional weight, expanded 1x; top candidateLimit)
  -> Intent-aware chunk selection -> cross-encoder rerank (4000-char ctx; chunk dedup)
  -> rerank/RRF blend (0.9 reranker + 0.1 RRF tiebreaker; falls back to RRF if reranker down)
  -> composite scoring -> MMR diversity (Jaccard bigram > 0.6 demoted, not removed)
```

### `intent_search` (specialist for causal chains)

```
Query -> intent classification (WHY/WHEN/ENTITY/WHAT)
  -> BM25 + Vector (intent-weighted RRF: BM25 for WHEN, vector for WHY)
  -> Graph traversal (WHY/ENTITY; multi-hop over memory_relations; outbound all edge types, inbound semantic+entity)
  -> cross-encoder rerank (200-char ctx) -> composite scoring
```

**MPFP fusion is max-score, NOT RRF.** The graph stage runs meta-path patterns (`[semantic,causal]`, `[entity,temporal]`, …) via Forward Push (α=0.15) and fuses by max-score ("best supporting path wins"), because propagation magnitude carries signal. This is distinct from the *outer* retrieval, which DOES fuse BM25+vector via RRF — two layers, two fusion rules, by design.

### Key differences

| Aspect | `query` | `intent_search` |
|--------|---------|-----------------|
| Query expansion | Yes (skipped on strong BM25) | No |
| Intent | `intent` param steers 5 stages | Auto-detected (WHY/WHEN/ENTITY/WHAT) |
| Rerank context | 4000 chars/doc | 200 chars/doc |
| Graph traversal | No | Yes (WHY/ENTITY, multi-hop) |
| MMR diversity | Yes | No |
| `compact` / `collection` / `candidateLimit` | Yes | No |
| Best for | most queries, progressive disclosure | causal chains across docs |

**force_intent:** `WHY` ("why", "what led to", "rationale", "tradeoff") · `ENTITY` (named component/person/service needing cross-doc linkage) · `WHEN` (timelines, first/last, "when did this change") — for WHEN start with `enable_graph_traversal=false`, fall back to `query()` if recall drifts.

---

## Composite scoring (how ranking works)

Applied on the composite surfaces: hooks, `query`, and `memory_retrieve`'s keyword/hybrid/causal/complex modes. **v0.22.0: MCP `vsearch` and `memory_retrieve` semantic/discovery rank non-recency queries by RAW cosine instead** (`scoreBasis: "vector-cosine"`; metadata breaks exact ties only; `minScore` filters raw with no default); recency-intent queries keep composite everywhere. **v0.23.0:** `searchScore` on FTS surfaces is the monotonic `|bm25|/(1+|bm25|)` transform (it was a constant 1.0 through v0.22.0 due to a clamp bug — keyword relevance contributed zero ordering); FTS-transform scores and cosines are independent monotonic signals, not one calibrated scale. **v0.24.0: MCP `search` ranks non-recency queries by the RAW BM25 transform** (`scoreBasis: "fts-bm25"`; metadata breaks exact ties only; `minScore` filters raw with no default) — judged keyword eval: raw MRR 0.848 vs composite 0.415 over 43 targets, composite losing even on the fresh-doc-favorable slice; recency-intent queries keep composite.

```
compositeScore = (0.50·searchScore + 0.25·recencyScore + 0.25·confidenceScore) × qualityMultiplier × coActivationBoost
```

- `qualityMultiplier = 0.7 + 0.6·qualityScore` (0.7× penalty … 1.3× boost).
- `coActivationBoost = 1 + min(coCount/10, 0.15)` (docs surfaced together get up to +15%).
- Length normalization penalizes verbose entries (floor 30%); frequency boost capped at +10%.
- **Pinned docs: +0.3 additive on composite surfaces** (capped at 1.0); on the raw routes (vector + `search` non-recency) pin = exact-tie precedence only.
- **`query` tool (v0.13.0+):** non-recency queries use retrieval-tuned **0.70·search + 0.15·recency + 0.15·confidence**. `memory_retrieve`'s composite modes, `context-surfacing`, and `search`'s recency branch keep the 0.50/0.25/0.25 default. (`vsearch` + `memory_retrieve` semantic/discovery use RAW cosine, and `search` uses the RAW BM25 transform, for non-recency queries — v0.22.0/v0.24.0: no composite weights at all.)
- **Recency intent** ("latest"/"recent"/"last session") switches all to **0.10·search + 0.70·recency + 0.20·confidence**.

**Content-type half-lives:** deductive / preference / hub / antipattern = ∞ (never decay) · decision 180d (very slow ranking decay — §36.11) · project 120d · research 90d · problem / milestone / note 60d · conversation / progress 45d · handoff 30d. Half-lives extend up to 3× for frequently-accessed memories. Attention decay: non-durable types (handoff, progress, conversation, note, project) lose 5% confidence/week without access; decision / deductive / preference / hub / research / antipattern are exempt.

→ full derivation: [`docs/concepts/composite-scoring.md`](docs/concepts/composite-scoring.md).

---

## Memory lifecycle (pin / snooze / forget — manual tools)

- **`memory_pin`** (lifecycle retention + priority among relevance-equivalent results; +0.3 boost on composite surfaces, exact-tie precedence on raw routes) — PROACTIVELY when: user says "remember this"/"important"; an architecture/critical decision was just made; a user preference/constraint should persist across sessions. Do NOT pin routine/session-specific items.
- **`memory_snooze`** — PROACTIVELY when a memory keeps surfacing but isn't relevant now, user says "not now"/"later", or content is time-boxed.
- **`memory_forget`** — only when genuinely wrong or permanently obsolete. Prefer snooze for temporary suppression.
- **Contradiction auto-resolution:** when `decision-extractor` detects a new decision contradicting an old one, the old one's confidence is lowered automatically — no manual action needed.

---

## Operational gotchas (agent-facing)

- **Empty `context-surfacing`** → prompt < 20 chars, starts with `/`, or nothing scored above threshold. Check `clawmem status` (doc counts) + embedding coverage.
- **Vector search empty but BM25 works** → missing embeddings (the watcher indexes but does NOT embed). Run `clawmem embed` or wait for the embed timer.
- **`intent_search` weak for WHY/ENTITY** → sparse graph. Run `build_graphs` (temporal backbone + semantic edges). Otherwise don't run it after every reindex — A-MEM links per-doc automatically.
- **Rankings look RRF-flat / reranker suspect** → `clawmem rerank-health`. A mis-served reranker (e.g. a GGUF that drops the score head) returns HTTP 200 but inert, non-discriminating scores, silently collapsing ranking to RRF. The reranker is a served sidecar, not a bundled model — verify it discriminates, don't assume liveness = correctness.
- **Intermittent `UserPromptSubmit hook timed out after 8s — output discarded`** → almost always the context-surfacing hook's **cold-start**, NOT inference: a fresh Bun process + opening a large `index.sqlite` + a cold OS page cache. Warm calls are sub-second. On a memory-constrained host (e.g. WSL with a low memory cap) or a large vault, the cache is evicted between turns so it **recurs on certain turns**. A timed-out hook silently drops that turn's `<vault-context>` (degraded recall, no error). **Durable fix: give the host enough RAM to keep the index + Bun modules cached**; raising the hook `timeout` in `~/.claude/settings.json` (8s default; no CLI knob) is only a secondary margin — avoid 15s+ as a standing default since the hook blocks prompt submission. Full detail: [`docs/troubleshooting.md`](docs/troubleshooting.md) → *Hooks slow or near timeout* / *Tuning the context-surfacing hook timeout*.
- **Anything setup-shaped** (download blocked, server unreachable, watcher memory bloat, indexer bugs) → [`docs/troubleshooting.md`](docs/troubleshooting.md). This skill does not duplicate it.

---

## Anti-patterns

- ❌ Manually pick `query`/`intent_search`/`search` when `memory_retrieve` can auto-route → ✅ `memory_retrieve` first.
- ❌ Call MCP tools every turn → ✅ only when the 3-rule gate fires.
- ❌ Re-search what's already in `<vault-context>`.
- ❌ Run `status` routinely → ✅ only when retrieval feels broken or after large ingestion.
- ❌ Pin everything → ✅ pin only persistent high-priority items.
- ❌ Forget memories to "clean up" → ✅ let decay + contradiction detection handle it.
- ❌ `build_graphs` after every reindex → ✅ only after bulk ingestion or when graph traversal is weak.
- ❌ `diary_write` in Claude Code → ✅ hooks capture this automatically (diary is for non-hooked envs only).
- ❌ `kg_query` for causal "why" → ✅ `intent_search` (kg_query is entity facts, not reasoning chains).

---

## Curator agent

Maintenance agent for Tier-3 work the main agent neglects. Invoke: **"curate memory" / "run curator" / "memory maintenance"**. Six phases: (1) health snapshot, (2) lifecycle triage (pin/snooze/propose-forget — never auto-confirms), (3) retrieval health probes, (4) reflect + consolidate `--dry-run`, (5) conditional graph rebuild, (6) collection hygiene. Safety rails: never auto-confirms forget, never runs embed, never edits config.

## Tool selection (one-liner)

```
memory_retrieve(query) | query(compact=true) | intent_search(why/when/entity) | query_plan(multi-topic) -> multi_get -> search/vsearch (spot checks)
```

---

## Setup / config / internals → AGENTS.md + docs/

This skill is **operations-only**. For installation, inference-server setup (the embedding/LLM/reranker services — the SOTA reranker is a **seq-cls sidecar, not a GGUF**), environment variables, systemd units, indexing/collection config, graph internals, and the OpenClaw (`kind: memory`) / Hermes (`MemoryProvider`) plugins, see [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/):

- Inference stack choice + server setup → [`docs/guides/inference-services.md`](docs/guides/inference-services.md)
- All environment variables → [`docs/reference/configuration.md`](docs/reference/configuration.md)
- Cloud embedding → [`docs/guides/cloud-embedding.md`](docs/guides/cloud-embedding.md)
- Setup (hooks / mcp / systemd) → [`docs/guides/setup-hooks.md`](docs/guides/setup-hooks.md), [`docs/guides/setup-mcp.md`](docs/guides/setup-mcp.md), [`docs/guides/systemd-services.md`](docs/guides/systemd-services.md)
- Internals (pipelines, graph, entities) → [`docs/internals/`](docs/internals/)
- OpenClaw / Hermes plugins → [`docs/guides/openclaw-plugin.md`](docs/guides/openclaw-plugin.md), [`docs/guides/hermes-plugin.md`](docs/guides/hermes-plugin.md)
- Troubleshooting → [`docs/troubleshooting.md`](docs/troubleshooting.md)
