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
| `context-surfacing` | UserPromptSubmit | retrieval gate → profile-driven hybrid search → FTS supplement → file-aware search → snooze/noise filters → relevance admission on the ordering key → tiered injection → `<vault-context>` (+ optional `<vault-facts>` / `<vault-routing>`). Budget/results/vector-timeout/escalation driven by `CLAWMEM_PROFILE`. |
| `postcompact-inject` | SessionStart (compact) | re-injects THIS session's pre-compaction state + recent vault decisions, framed as reference data → `<vault-postcompact>` |
| `curator-nudge` | SessionStart | surfaces curator actions; nudges when the report is stale |
| `precompact-extract` | PreCompact | extracts the last typed request / decisions / file paths / open questions before compaction → the vault's session-keyed `compaction_state` row |
| `decision-extractor` | Stop | LLM → observations + contradiction detection + SPO triples from the turns after its cursor, each turn once (v0.41.0) → the session's own decision/antipattern docs |
| `handoff-generator` | Stop | per-turn digest (no model) + throttled incremental LLM summary → the session's handoff |
| `handoff-generator` | SessionEnd | render-only flush of the handoff's latest turns (v0.41.0) |
| `feedback-loop` | Stop | credits each surfaced note once per turn when that turn verifiably names it → access count, utility signal, same-turn co-activations |

**Default behavior:** read injected `<vault-context>` first; if sufficient, answer immediately.

**Hook blind spots (by design):** hooks filter `_clawmem/` artifacts, enforce score thresholds, and cap token budget — **absence in `<vault-context>` does NOT mean absence in memory.** If expected memory wasn't surfaced, escalate to Tier 3. Note the MCP retrieval tools themselves exclude `_clawmem` by default since v0.21.0 — pass `includeInternal: true` when system-internal memory (observations/handoffs/deductions) is the target.

**Profiles:** `speed` / `balanced` (default) / `deep` set the token budget, max results, vector timeout, and `factsTokens`. Only `deep` adds query expansion + reranking to the hook path. (Kept-score ratios / activation floors are consulted only by the eval-only composite control arm, `CLAWMEM_ADMISSION_POLICY=composite` — production admission is the profile-independent relevance policy, v0.38.0.) The profile comes from the `CLAWMEM_PROFILE` environment variable; the host hook `timeout` lives in `~/.claude/settings.json` — see *Operational gotchas* for timeout tuning.

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
    MAGMA intent classification + intent-weighted RRF + multi-hop graph traversal + a bounded
    one-hop causal step in BOTH directions (v0.32.0 — the only backward cause→effect reach).
    Use DIRECTLY (not as a fallback) for "why" / "when" / "how did X lead to Y" / entity links.
    Override: force_intent="WHY"|"WHEN"|"ENTITY"|"WHAT".
    (1a vs 1b are parallel options, chosen by query type — not sequential. memory_retrieve's
    causal mode runs the SAME shared pipeline since v0.32.0, default-filtered plus a WHY
    observation lane, so auto-routing is no longer weaker than calling intent_search directly;
    one-hop hits carry causal: [{anchorDocid, direction}].)
1c. Multi-topic         -> query_plan(query, compact=true)
    Decomposes into 2-4 typed clauses (bm25/vector/graph), runs them in parallel, merges via RRF.
2.  Progressive disclosure -> multi_get("path1,path2") for full content of top hits
3.  Spot checks         -> search(query) (BM25, 0 GPU)  or  vsearch(query) (vector, 1 GPU)
4.  Chain tracing       -> find_causal_links(docid, direction="both", depth=5)
5.  Entity facts        -> kg_query(entity)  (SPO triples; different from intent_search's reasoning chains)
6.  Temporal context    -> timeline(docid, before=5, after=5)
7.  Ranking diagnosis   -> memory_rank(query)  ("why did X outrank Y": per-factor
    composite breakdown + raw-vs-composite rank shifts; diagnostic, not retrieval)
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
| `kg_query` | Entity SPO triples with temporal validity + per-fact evidence (`evidenceCount`, up to 5 sources; v0.32.0). Entity facts, NOT causal "why" (use `intent_search`). |
| `session_log` | "last time" / "yesterday" / "what did we do". Do NOT use `query` for cross-session. |
| `profile` | User profile (static facts + dynamic context). |
| `memory_pin` | Lifecycle retention + priority among relevance-equivalent results (+0.3 composite boost on composite surfaces; exact-tie precedence on raw routes — vector + `search` non-recency). Use PROACTIVELY for constraints, architecture decisions, corrections. |
| `memory_snooze` | Use PROACTIVELY when `<vault-context>` surfaces noise — snooze 30 days. |
| `memory_forget` | Deactivate a memory by closest match. Sparingly — prefer snooze. Weak matches return a disambiguation list instead of acting (v0.23.0). |
| `build_graphs` | Temporal backbone + semantic graph after bulk ingestion. NOT after every reindex. Reports `N new edge(s), M total` — `0 new` on a rebuild is correct, not an empty graph. |
| `timeline` | Temporal neighborhood around a doc. Progressive disclosure: search → timeline → get. |
| `memory_evolution_status` | How a doc's A-MEM metadata evolved over time. |
| `lifecycle_status` / `lifecycle_sweep` / `lifecycle_restore` | Lifecycle stats / archive stale (dry-run default, archives only — ClawMem never deletes rows) / restore auto-archived. |
| `index_stats` / `status` / `reindex` | Doc counts + embedding coverage / quick health / force re-index (does NOT embed). |
| `memory_stats` | Lifecycle + ranking-metadata aggregates per collection: origin×active cross-tabs, pinned, accrual, access/confidence/quality/effective-age distributions. Deeper than `index_stats`. |
| `memory_rank` | "Why did X outrank Y" — real-pipeline composite breakdown (weights, multipliers, signed pinΔ, co-activation) + raw-vs-composite rank shifts. Diagnostic, not retrieval. |
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

Applied on the composite surfaces: `query` and `memory_retrieve`'s keyword/hybrid/causal/complex modes. **v0.38.0:** the context-surfacing hook is no longer a composite ordering surface — its injected order and admission run on the channel-aware fusion key; composite sizes the injection tiers (HOT/WARM/COLD) only. **v0.22.0: MCP `vsearch` and `memory_retrieve` semantic/discovery rank non-recency queries by RAW cosine instead** (`scoreBasis: "vector-cosine"`; metadata breaks exact ties only; `minScore` filters raw with no default); recency-intent queries keep composite everywhere. **v0.23.0:** `searchScore` on FTS surfaces is the monotonic `|bm25|/(1+|bm25|)` transform (it was a constant 1.0 through v0.22.0 due to a clamp bug — keyword relevance contributed zero ordering); FTS-transform scores and cosines are independent monotonic signals, not one calibrated scale. **v0.24.0: MCP `search` ranks non-recency queries by the RAW BM25 transform** (`scoreBasis: "fts-bm25"`; metadata breaks exact ties only; `minScore` filters raw with no default) — judged keyword eval: raw MRR 0.848 vs composite 0.415 over 43 targets, composite losing even on the fresh-doc-favorable slice; recency-intent queries keep composite.

```
compositeScore = (0.50·searchScore + 0.25·recencyScore + 0.25·confidenceScore) × qualityMultiplier × coActivationBoost
```

**Effective time (v0.27.0):** `recencyScore` ages documents by `authored_at ?? modified_at` — mined/synthesized historical content ranks by when it was written, not when it was filed. Result metadata carries `authored_at` (null = unknown); temporal filters and recency-intent queries use the same axis.

- `qualityMultiplier = 0.7 + 0.6·qualityScore` (0.7× penalty … 1.3× boost).
- `coActivationBoost = 1 + min(coCount/10, 0.15)` (docs verifiably referenced in the same turn get up to +15%; v0.41.0 — injection records no co-activation).
- Length normalization penalizes verbose entries (floor 30%); frequency boost capped at +10%.
- **Pinned docs: +0.3 additive on composite surfaces** (capped at 1.0); on the raw routes (vector + `search` non-recency) pin = exact-tie precedence only.
- **`query` tool (v0.13.0+):** non-recency queries use retrieval-tuned **0.70·search + 0.15·recency + 0.15·confidence**. `memory_retrieve`'s composite modes, `context-surfacing`, and `search`'s recency branch keep the 0.50/0.25/0.25 default. (`vsearch` + `memory_retrieve` semantic/discovery use RAW cosine, and `search` uses the RAW BM25 transform, for non-recency queries — v0.22.0/v0.24.0: no composite weights at all.)
- **Recency intent** ("latest"/"recent"/"last session") switches all to **0.10·search + 0.70·recency + 0.20·confidence**.

**Content-type half-lives:** deductive / preference / hub / antipattern = ∞ (never decay) · decision 180d (very slow ranking decay — §36.11) · project 120d · research 90d · problem / milestone / note 60d · conversation / progress 45d · handoff 30d. Half-lives extend up to 3× for frequently-accessed memories. Attention decay: non-durable types (handoff, progress, conversation, note, project) lose 5% confidence/week without access; decision / deductive / preference / hub / research / antipattern are exempt.

**Inspect a live ranking (v0.36.0):** `memory_rank(query)` returns each result's captured per-factor breakdown (weights, multipliers, signed pinΔ — negative means the 1.0 pin cap clamped a high scorer down — co-activation) plus raw-vs-composite rank shifts, with demoted raw winners flagged.

→ full derivation: [`docs/concepts/composite-scoring.md`](docs/concepts/composite-scoring.md).

---

## Memory lifecycle (pin / snooze / forget — manual tools)

- **`memory_pin`** (lifecycle retention + priority among relevance-equivalent results; +0.3 boost on composite surfaces, exact-tie precedence on raw routes) — PROACTIVELY when: user says "remember this"/"important"; an architecture/critical decision was just made; a user preference/constraint should persist across sessions. Do NOT pin routine/session-specific items.
- **`memory_snooze`** — PROACTIVELY when a memory keeps surfacing but isn't relevant now, user says "not now"/"later", or content is time-boxed.
- **`memory_forget`** — only when genuinely wrong or permanently obsolete. Prefer snooze for temporary suppression.
- **ClawMem never physically deletes a document row (v0.30.0).** Every lifecycle operation above is reversible: pin/snooze are metadata, forget and archive deactivate, contradiction handling only erodes confidence. Retention archives — `lifecycle_restore` brings it back — and `purge_after_days` is inert. Through v0.29.0 it permanently deleted archived rows from a non-dry-run sweep and from the SessionStart hook, unreported.
- **Contradiction auto-resolution (judge-gated, v0.29.0):** runs ONLY when a judge is configured via `CLAWMEM_JUDGE_*` — disabled (audited no-op) otherwise. With a judge: when `decision-extractor` detects a new decision contradicting an old one, the old one's confidence is lowered automatically (−0.25, floor 0.2). It stays retrievable; only its ranking drops. Removing it from retrieval outright (`invalidated_at`) is a separate, **opt-in** step behind `CLAWMEM_CONTRADICTION_INVALIDATE`, and applies **only to `content_type='observation'`** — a superseded decision is eroded, never retired, so do NOT tell a user that contradiction handling will retire a prior decision. Unarmed it logs `WOULD invalidate` and writes nothing. Do NOT suggest arming it without the vault-specific calibration in [`docs/guides/contradiction-invalidation.md`](docs/guides/contradiction-invalidation.md).

---

## Operational gotchas (agent-facing)

- **Empty `context-surfacing`** → prompt < 20 chars (short memory-intent queries like "what did I say?" are exempt — they force retrieval), starts with `/`, or nothing scored above threshold. Check `clawmem status` (doc counts) + embedding coverage.
- **Vector search empty but BM25 works** → missing embeddings (the watcher indexes but does NOT embed). Run `clawmem embed` or wait for the embed timer.
- **`intent_search` weak for WHY/ENTITY** → sparse graph. Run `build_graphs` (temporal backbone + semantic edges). Otherwise don't run it after every reindex — A-MEM links per-doc automatically.
- **Rankings look RRF-flat / reranker suspect** → `clawmem rerank-health`. A mis-served reranker (e.g. a GGUF that drops the score head) returns HTTP 200 but inert, non-discriminating scores, silently collapsing ranking to RRF. The reranker is a separately served model, not a bundled one — verify it discriminates, don't assume liveness = correctness.
- **Index-run summary shows a `✎ notes` gap (or `[amem] LLM returned null` per doc)** → the LLM endpoint is dead, squatted, or misconfigured — `clawmem doctor` shape-probes `CLAWMEM_LLM_URL` with a real completion (v0.37.0). Persistent HTTP errors trip the 60s cooldown so the fallback engages where permitted; under `CLAWMEM_NO_LOCAL_MODELS=true` enrichment stays empty until fixed.
- **Intermittent `UserPromptSubmit hook timed out after 8s — output discarded`** → **fixed in v0.16.0** (upgrade). Root cause was not inference or host RAM alone: the vector leg ran a *synchronous* `sqlite-vec` scan the timeout race could not bound, and writable hook opens could wait out `busy_timeout` on an unconditional backfill `UPDATE`. v0.16.0 bounds both with real deadlines; **v0.20.0** adds the hard cap (run `clawmem watch` — the vector daemon runs the blocking scan off the hook's event loop, so a cold scan falls back to FTS instead of blocking the turn); **v0.38.0** derives every in-handler deadline from `CLAWMEM_HOOK_BUDGET_MS` (default 6000ms) and requires the host timeout ≥ 1.5s startup + budget (`clawmem setup hooks` writes both; `clawmem doctor` checks). A timed-out hook silently drops that turn's `<vault-context>` (degraded recall, no error). A cold OS page cache still adds first-call latency, so host RAM headroom helps the margin — but it is the margin, not the fix. Full detail: [`docs/troubleshooting.md`](docs/troubleshooting.md) → *Hooks slow or near timeout* / *Tuning the context-surfacing hook timeout*.
- **A known document is absent from `search`/`vsearch`/`query` but `get` by path returns it** → it is invalidated (`documents.invalidated_at IS NULL` is a hard predicate on the FTS and both vector joins, with no query-time signal). On `documents` the only writer is contradiction invalidation, and only when armed — the `invalidated_at` in `consolidation.ts` is a different table. Diagnose + restore: [`docs/troubleshooting.md`](docs/troubleshooting.md#hooks).
- **A file an editor or agent saved never re-indexes until `clawmem update`** → an atomic save (temp file renamed over the target) on Bun < 1.4.0, which reports it under the temp name. **Fixed in v0.40.2** (the watcher rescans a directory after any event); on older versions upgrade Bun to 1.4.0+ and restart the watcher. Detail: [`docs/troubleshooting.md`](docs/troubleshooting.md#indexing).
- **Files in a directory made after the watcher started never re-index until `clawmem update`** → the watcher walked each collection path once, at start (a new Claude Code project's `memory/` is the common case). **Fixed in v0.40.3** (a rescan watches new directories, within `CLAWMEM_WATCH_MAX_DIRS`); on older versions restart the watcher after new directories appear. Detail: [`docs/troubleshooting.md`](docs/troubleshooting.md#indexing).
- **Access counts or co-activations look reset after an upgrade to v0.41.0** → expected: the watcher's first start recomputed them from verified references (a turn that names a surfaced note, once per turn), so they start near zero and grow with real use. Through v0.40.3 every Stop counted the whole session again. `clawmem doctor` shows the stop pipeline's state; an ✗ for an older writer means some ClawMem process sharing the vault was not upgraded. Detail: [`docs/guides/upgrading.md`](docs/guides/upgrading.md).
- **Stop-hook ranges keep coming back as `model unavailable` while the LLM server is up** → v0.41.0's observer prompt could pass the 4,096-token context the docs prescribe for the observer model, and the server refused it (HTTP 400). **Fixed in v0.41.1** (the CONTEXT section and the transcript share the 8,000-character budget); upgrade the hooks and restart the watcher; each queued range is due again within 12 hours and replays when the watcher or a later Stop runs. Detail: [`docs/troubleshooting.md`](docs/troubleshooting.md#hooks).
- **Stop-hook ranges stay quarantined on dense turns (hashes, JSON, logs, non-Latin text), or `clawmem doctor` counts ranges held as `capacity:`** → v0.41.1's bound was in characters, and dense text filled the context and cut the observer's reply. **Fixed in v0.41.2:** the observer fits each prompt in tokens to the server's own context, keeps room for its reply, and runs a long turn as checkpointed windows. Serve the observer model with `-c 8192`; `capacity:` ranges replay by themselves once the context is raised. Detail: [`docs/troubleshooting.md`](docs/troubleshooting.md#hooks).
- **Stop-hook ranges held as `no parseable response`, or a turn with real work committed with no observation** → the observer model's replies did not follow the schema (a transcript role as the type, a copied placeholder, its query-expansion format, which v0.41.3 read as "nothing"). **Fixed in v0.41.4:** only `<none/>` means "nothing", the prompt names the allowed types, a format retry names the failing field, and the observer asks llama-server for a grammar that admits only well-formed replies. Retry held ranges now with `clawmem repair stop-queue --retry-now held --run`; `clawmem doctor` groups what stays held by class. Detail: [`docs/troubleshooting.md`](docs/troubleshooting.md#hooks).
- **Anything setup-shaped** (download blocked, server unreachable, watcher memory bloat or its per-collection directory cap, indexer bugs) → [`docs/troubleshooting.md`](docs/troubleshooting.md). This skill does not duplicate it.

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

This skill is **operations-only**. For installation, inference-server setup (the embedding/LLM/reranker services — the SOTA reranker needs the zerank-2 **GGUF that carries its score head**, or the seq-cls sidecar), environment variables, systemd units, indexing/collection config, graph internals, and the OpenClaw (`kind: memory`) / Hermes (`MemoryProvider`) plugins, see [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/):

- Inference stack choice + server setup → [`docs/guides/inference-services.md`](docs/guides/inference-services.md)
- All environment variables → [`docs/reference/configuration.md`](docs/reference/configuration.md)
- Cloud embedding → [`docs/guides/cloud-embedding.md`](docs/guides/cloud-embedding.md)
- Setup (hooks / mcp / systemd) → [`docs/guides/setup-hooks.md`](docs/guides/setup-hooks.md), [`docs/guides/setup-mcp.md`](docs/guides/setup-mcp.md), [`docs/guides/systemd-services.md`](docs/guides/systemd-services.md)
- Internals (pipelines, graph, entities) → [`docs/internals/`](docs/internals/)
- OpenClaw / Hermes plugins → [`docs/guides/openclaw-plugin.md`](docs/guides/openclaw-plugin.md), [`docs/guides/hermes-plugin.md`](docs/guides/hermes-plugin.md)
- Troubleshooting → [`docs/troubleshooting.md`](docs/troubleshooting.md)
