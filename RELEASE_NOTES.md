# ClawMem — Release Notes

For upgrade instructions (migration steps, opt-in features, verification commands), see [docs/guides/upgrading.md](docs/guides/upgrading.md). This file is the chronological feature record, newest first.

---

## v0.25.0 — extraction retry-with-error-feedback + decision half-life + entity-neighbor hub-bias fix

Three independently reviewed items from the strategic queue (§13.1, §36.11, BL-001) — the first queue burndown since the ranking was locked. Three files, three pipelines, no shared invariants.

### §13.1 — retry-with-error-feedback on every LLM extraction path (`src/llm-retry.ts`)

ClawMem's extraction surfaces were single-shot: one `generate()` attempt, and any malformed/empty response failed open to `[]`/`null` with no signal to the model about what went wrong — invisible data loss on every transient formatting miss. All eight extraction call sites now ride `withRetryAndFeedback` (pattern re-authored from Volt's llm-map validation loop):

- **Stateless corrective retries** (default 3 attempts): each retry is a fresh `generate()` call with a reconstructed prompt — original prompt + the parse error + a 500-char excerpt of the previous response — never a conversation continuation.
- **Hard wall-clock deadline** shared across all attempts: no attempt starts past the deadline, and an in-flight `generate()` is raced against it — a backend that ignores the abort signal cannot hold the helper past the budget.
- **Fail-open on exhaustion** (null → the same `[]`/`null` callers already handled), now with a terminal `[llm-retry] <label>: exhausted…` warning naming the call site.
- Call sites: observer `extractObservations`/`extractSummary`, conversation-synthesis `extractFactsFromConversation`, A-MEM `constructMemoryNote`/`generateMemoryLinks`/`evolveMemories`/`inferCausalLinks`, entity `extractEntities`. Parse closures own whole-response STRUCTURAL validation (so a malformed payload triggers a corrective retry instead of a silent post-loop drop — including integer-validated causal-link indexes, closing a partial-write path); semantic/domain filtering stays outside the loop.
- Accounting change: a transient failure that recovers on retry no longer counts as an LLM failure in `mine --synthesize` stats; only terminal exhaustion does.

### §36.11 — decision ranking half-life: ∞ → 180 days (`src/memory.ts`)

`HALF_LIVES.decision = Infinity` pinned recency at 1.0 forever, so a silently-abandoned decision ("we'll use X" → quietly moved to Y, with no contradictory write to trigger supersession) kept winning ranking indefinitely. Decisions now decay on a 180-day half-life. **Ranking durability only:** `decision` keeps its attention-decay exemption, nothing is deleted or archived (lifecycle policy is separate), the access-frequency extension still stretches frequently-resurfaced decisions toward 3×, and `deductive`/`preference`/`hub`/`antipattern` stay infinite. An unaccessed 180-day-old decision drops to recency 0.5 — still fully searchable, just no longer permanently ahead of fresher material.

### BL-001 — `getEntityGraphNeighbors` hub-bias fix (`src/entity.ts`)

The entity-neighbor path ranked by raw co-occurrence count — reintroducing exactly the hub bias the edge-creation path's IDF suppression exists to prevent (one path suppressed hubs, the other reinforced them). Neighbor ranking now blends count with IDF specificity (`min(1, log1p(count)/5) × clamp(idf/3.0)`, sharing the edge path's 3.0 threshold via `ENTITY_IDF_SPECIFICITY_THRESHOLD`):

- **Score-before-limit:** every co-occurring candidate is scored, THEN the pool is capped at 30 — a specific neighbor at raw-count rank 31+ can now surface (the old SQL `ORDER BY count DESC LIMIT 30` excluded it before scoring).
- **Best-path-per-doc:** candidates are traversed in blended-score order, so a document reachable via both a hub and a specific entity keeps the specific path's score and `viaEntity`.
- **Active-only IDF + hydration:** IDF populations are active-documents-only (archived mentions can no longer distort specificity), archived-only candidates are dropped from the pool, and hydration excludes archived documents before its per-entity LIMIT. One grouped CTE query supplies counts and active doc-frequency together (no N+1).

### Quality gates

Full suite 1,577/0. Each item independently reviewed by a cross-model adversarial pass (codex / GPT-5.6) to verbatim "Zero remaining findings — ship as is.": §13.1 in 3 turns, §36.11 in 2, BL-001 in 3 (bug-first — the failing hub-bias test predates the fix).

---

## v0.24.0 — raw-BM25-primary ranking for `search` (judged keyword eval) + bypass A/B toolkit

v0.23.0 made the FTS relevance signal real and deliberately deferred any ranking-contract change to a judged eval. That eval ran: 43 judged keyword targets (23 discovery + 20 family-disjoint held-out) with objectively-labeled fairness shapes (14 raw-favorable "exact-old", 22 composite-favorable "fresh-among-many"), frozen floors and decision rules pre-registered before any comparison was computed. **Raw-BM25-primary beat the shipping composite decisively**: combined MRR 0.848 vs 0.415, hit@1 33 vs 6; held-out 0.875/16-at-#1 vs 0.335/zero-at-#1 (the composite missed the absolute floors outright); composite lost even on its OWN favorable shape (fresh-among-many 0.348 vs 0.801) — the recency/quality/co-activation multipliers bury keyword relevance rather than refine it. One paired regression (one position) in 43 cases; controls clean in both arms.

### Behavior changes

- **`search` ranks non-recency queries by the RAW BM25 transform** (`|bm25|/(1+|bm25|)`), mirroring the v0.22.0 vector-route pattern. Metadata — including pin — participates only inside groups of exactly-equal raw scores (deterministic tie order: pinned, then legacy composite, then path). `structuredContent` carries `scoreBasis: "fts-bm25"`. FTS-transform values and vector cosines remain independent, non-comparable channels.
- **`minScore` on `search`** now filters the raw score for non-recency queries and has NO default — omitted means no filter, an explicit `0` is honored. Recency-intent queries ("latest…", "recent…") keep the composite regime with the previous default-0 floor and report `scoreBasis: "composite"`.
- **Unchanged surfaces:** hooks/context-surfacing, `query`, `query_plan`, `intent_search`, `memory_retrieve`'s composite modes, the CLI `search` command, and the REST API keep their existing scoring. The change is scoped to the MCP `search` tool, exactly as evaluated.
- **Bypass ops escape hatch:** `CLAWMEM_DISABLE_FTS_BYPASS=true` forces the full expansion path at both strong-signal-bypass consumers (MCP `query` pipeline + CLI `query`) — built for the 49.3 A/B harness, kept as an operational kill switch.
- **`expandQueryCacheKey` exported** — the exact `llm_cache` key `expandQuery` reads/writes, so eval harnesses can delete/verify expansion cache rows without replicating private key construction.
- **Bypass characterization (49.3, frozen census):** on a frozen 127-query census (51 judged keyword cases + 76 firing-hunt probes) over the frozen production snapshot, the strong-signal bypass fired on THREE — 3/51 on the judged set, 0/76 among the probes — all lone-or-near-lone pools, all with the correct top document. Frozen-corpus characterization only: the probes were selected to hunt firings, so these rates say nothing about production firing prevalence (unmeasured), and the firing set is snapshot-relative — one probe term began firing on the live index hours later as new documents mentioned it. On this frozen snapshot/census the gap ≥ 0.15 condition fired rarely — sibling documents suppress the gap on this corpus. Eval tooling: `scripts/eval-keyword-acceptance.ts` (freeze/run, FTS-only) and `scripts/eval-bypass-ab.ts` (freeze/run, live-service A/B with a verified expansion-cache freeze and census integrity re-execution).
- **Bypass A/B verdict (49.3):** on the frozen census's complete fired population (3 natural cases; pre-registered zero-allowance gates; run gated on frozen service identity + an embed-geometry canary drift-check + rerank health), the bypass lost nothing — zero dropouts, zero hard regressions, bypass-arm MRR +0.038 higher — and saves ~56% wall time where it fires (1.9 s vs 4.3 s with a warm expansion cache). Verdict: `SAFE ON FROZEN CENSUS (n=3 fired; zero-allowance gates); population risk unvalidated` — thresholds 0.85/0.15 stand on this census; no tuning proposed.

---

## v0.23.0 — monotonic BM25 exposed score (the FTS relevance signal was a constant)

The v0.22.0 design gate discovered that `searchFTS`'s exposed score was computed as `1 / (1 + Math.max(0, bm25))` — but FTS5's `bm25()` is negative-is-better and ≤ 0 for every match (0/4,962 positive rows measured on a production vault), so **every FTS result carried the identical score 1.0**. SQL ordering was correct; everything downstream of the exposed score was not: composite ranking on FTS surfaces (`search`, REST keyword, CLI, `memory_retrieve` keyword and its semantic-mode FTS fallback, hook FTS lanes) was effectively metadata-only, the `query` pipeline's strong-signal bypass could never fire on multi-hit queries yet always fired on single-hit ones, hook injection systematically preferred FTS-sourced docs over vector-sourced ones (1.0 vs cosine), and every score-threshold gate was vacuous.

### Behavior changes

- **Exposed FTS score is now `|bm25|/(1+|bm25|)`** (`ftsScoreFromBm25`, exported): monotonic in match strength, bounded [0,1), per-row stable, clamps a hypothetical positive input to 0.
- **`search` keeps the composite regime** (a regime change is gated on the 49.2 judged keyword eval) — but its searchScore input is now real, so keyword relevance finally contributes ordering. Observed `score`/`compositeScore` values shift accordingly; `minScore` semantics are unchanged. Compact results report the composite; non-compact carry both `score` (raw transform) and `compositeScore`.
- **Strong-signal bypass is functional**: fires only on a strong (≥ 0.85 ⇔ |bm25| ≥ 5.67), clearly separated (gap ≥ 0.15) top hit; a lone weak match no longer triggers it. One shared helper (`hasStrongFtsSignal`) now backs both the MCP `query` pipeline and the CLI `query` command (previously a drifted duplicate).
- **`memory_forget` targeting is stricter and safer**: the confidence gate (`score ≥ 0.7`, or a ≥ 0.2 gap when 2+ candidates exist) is live — previously every FTS candidate scored 1.0 and was auto-selected, including a lone garbage match. Weak matches now return the candidate list for disambiguation. Non-destructive pin/snooze behavior is unchanged.
- **`query_plan`'s graph clause now carries RRF-fused scores into graph traversal** (parity with the causal and `intent_search` paths, via a shared `attachRrfScores` helper) — traversal seed mass was previously anchored on raw single-channel scores.
- **Consolidation dup-gate and curator BM25 probe are live**: the `score ≥ 0.7` duplicate filter and the `> 0.3` retrieval probe actually discriminate now. A near-empty vault may honestly report a degraded BM25 probe where it previously passed vacuously.
- **Scale honesty**: FTS-transform scores and vector cosines are independent monotonic signals, not a calibrated common scale. Mixed-channel merge points (REST hybrid max-merge, hook dedup) are no longer degenerate, but cross-channel calibration remains future, eval-gated work.

Follow-on work: BACKLOG 49.2 (judged keyword eval → `search` regime recommendation; reports bypass firings) and 49.3 (query-pipeline A/B before any bypass-threshold tuning).

---

## v0.22.0 — raw-similarity-primary ranking for the direct vector routes

v0.21.0 removed the system-internal junk from the direct tools' results; the direct-pipeline eval it mandated then showed the composite scoring layer itself was the remaining defect on those routes: on a judged set against the live vault, pure raw cosine ranked 16/19 targets #1 (MRR 0.912) while the shipping composite ranked 1/19 (MRR 0.307), filtered 14/19 correct answers below the old `minScore` floor, and got WORSE with deeper candidate pools. Attribution was measured per stage: length normalization caused the floor kills; the pin +0.3 additive made one pinned, heavily-accessed hub document top-1 for nearly every query including nonsense controls; re-mixing the weights could not help because every multiplier is larger than the 0.03–0.10 raw margins that separate right answers from wrong ones in the compressed-high band of modern embedding models.

### Behavior change: raw ordering on the evidenced vector routes

- **`vsearch` and `memory_retrieve` semantic/discovery modes** rank non-recency queries by RAW vector cosine. Document metadata — including pin — participates only inside groups of exactly-equal raw scores (deterministic tie order: pinned, then legacy composite, then path). `structuredContent` carries `scoreBasis: "vector-cosine"`; raw cosine is embedding-model-specific and not comparable to composite values.
- **`minScore` on `vsearch`** now filters the raw score for non-recency queries and has NO default — omitted means no filter, an explicit `0` is honored (nullish handling). Recency-intent queries keep the composite regime with its 0.3 default floor and report `scoreBasis: "composite"`.
- **Recency-intent queries are unchanged everywhere** (RECENCY_WEIGHTS composite, newest-first behavior, contentType priority sort), selected through one centralized regime function. The semantic/discovery FTS *fallback* (vector leg unavailable) also keeps composite — its scores are not cosine.
- **Unchanged routes:** `search` (BM25), `query`, `query_plan`, `intent_search`, hooks/context-surfacing, and `memory_retrieve` keyword/hybrid/causal/complex. `find_similar` was already raw-ranked and is untouched (docs now say so). A BM25 ranking eval is backlogged separately — its exposed score is currently non-monotonic (`Math.max(0, bm25)` flattens FTS5's negative-is-better scores), a pre-existing issue this release documents but does not change.
- **Pin re-documented:** pin = lifecycle retention + prioritization among relevance-equivalent results. On composite surfaces it keeps the +0.3 boost; on the raw routes it breaks exact ties only. "Persistent surfacing" — a pinned document floating above more relevant ones on every query — was the measured hub defect, not a feature.
- **`retrieval.mcp_direct_tuned_weights` is superseded and has no effect.** Its own gate evidence (the direct-pipeline eval) measured tuned weights at 1/19 hit@1. The key is still parsed; setting it logs a once-per-process warning.

### Verification

`bun test` → 1504 pass / 0 fail (new: constructed-tie units — pin wins inside an exact-score tie group and never crosses a boundary; regime selection; no-default-floor + explicit-zero `minScore` handling; route-level raw-ordering regressions including the incident fixture, which now proves the inversion cannot recur even with `includeInternal: true`). A frozen, deterministic acceptance gate (`scripts/eval-acceptance.ts`: vault snapshot + frozen `asOf` clock + per-case frozen query vectors through the guarded precomputed-vector path) passed all predeclared criteria: pin-invariance rank identity on non-recency cases; exact match to the frozen composite baseline on recency cases; no control-query hub dominance and no pinned top-1; discovery set 23/23 in-pool, hit@1 18/23, MRR 0.870; held-out family-disjoint set hit@1 17/20, hit@5 19/20, MRR 0.879 against floors of 12/20, 17/20, and 0.75 declared before the set was authored. Design and implementation adversarially reviewed cross-model to explicit clearance (5-turn DESIGN gate, 14 findings folded).

## v0.21.0 — vsearch trust hardening: internal-collection exclusion, geometry canary, embed survivability

A live incident exposed a stacked failure: an embedding server silently producing non-discriminating vectors for the vault's dominant register (a last-token model whose GGUF conversion lost its EOS-append flag), amplified by composite scoring floating system-internal docs over true matches — while every existing health check passed. The server-side cause is an operator fix; this release closes the client-side amplification and the detection gaps, and hardens the embed run that the remediation itself crashed.

### Behavior change: `_clawmem` excluded from MCP retrieval by default

`search`, `vsearch`, `query`, `query_plan`, `memory_retrieve`, and `find_similar` no longer return the system-internal `_clawmem` collection (observations/deductions/handoffs) unless asked: pass `includeInternal: true`, or name `_clawmem` in an explicit `collection` filter. `find_similar` auto-includes internal neighbors when the reference document is itself internal. `intent_search` / `find_causal_links` / `kg_query` / `session_log` / `timeline` are unfiltered by design — system memory is their substrate. Exclusion happens at the store layer (SQL predicate for BM25; escalating MATCH depth for vectors) and inside graph traversal (excluded nodes are pruned before beam selection and score normalization), so internal docs neither appear NOR consume candidate/beam budget.

Vector-side contract: under exclusion the scan escalates depth until `limit` allowed documents hydrate, capped at 4,096 fragments. Cap-limited under-fills carry an explicit `degraded: true` + `degradedReason` (`excluded-dominant` when distinct excluded docs account for the shortfall, `cap-truncation` when fragment dedup drives it); multi-leg routes aggregate `any(leg)` with per-leg reasons in `structuredContent.degradedLegs`. Plain small-vault exhaustion returns a normal short list with no marker.

### Embedding-geometry canary (preflight + doctor)

- `clawmem embed` now runs a pair-separation probe battery BEFORE any destructive step — a broken-geometry server aborts the run before `--force` clears anything (override: `--force-geometry`). The battery uses the production embed templates and includes terminus + truncation controls that catch unanchored last-token readouts; self-similarity alone cannot (stored-vs-fresh stayed 0.999 through the entire incident).
- Baselines are stored per (probe-version, model, dimension) profile in a new `embed_canary` table as **first-healthy calibrations** — healthy runs never roll the reference; `clawmem embed --force --recalibrate-canary` is the explicit replacement operation (intrinsic sanity floors govern its gate, since the old baseline is exactly what it replaces). Margins alert relative to the calibrated baseline (< 50%) with an absolute backstop, and drift (stored-vs-fresh probe cos < 0.98) flags a changed serving stack behind an unchanged model name. Mixed dimensions/models across one battery (a flapping endpoint) are a hard failure, and a `--force` clear never proceeds on an UNVALIDATED endpoint. Mid-run drift, an unverifiable run end, or a no-preflight override persists a durable `embed_geometry_taint` flag (lease-fenced) that keeps `doctor` nonzero until a verified full rebuild clears it.
- `clawmem doctor` gains the canary (section 10) and a sampled persisted-vs-fresh check on real index rows (section 11): fragments are reconstructed through the production parse/split/format pipeline and compared to their stored vectors. New vectors persist an `embed_input_fp` (SHA-256 of the exact embed input) enabling full validation; pre-0.21.0 rows validate structurally with title provenance flagged unavailable until their next re-embed. Definitive failures (fingerprint mismatch = stale input; fingerprint match + low cosine = corruption) exit nonzero immediately — sampling coverage can never mask them.

### Embed-run survivability

The incident's remediation run died on a transient `SQLITE_BUSY`: the failure-marker write itself crashed a `--force` rebuild at doc 344/4,995 with the index already cleared. Now: the embed connection runs a 10s busy timeout (set on the ACTIVE connection, covering `update --embed`'s cached store; kept short so synchronous waits cannot starve the 30s lease heartbeat), retries are asynchronous and bounded with a lease-loss abort between attempts, `markEmbedStart/Synced/Failed` are lease-fenced in-transaction, a marker that still fails logs-and-continues instead of killing the run, and `--force` skips the post-clear stale-embedding cleanup (a no-op that could only add a die-after-clear window).

### Also

- `latest` now routes to recency intent (`RECENCY_PATTERNS`) — "latest decisions" was scoring under non-recency weights.
- Config knob `retrieval.mcp_direct_tuned_weights` (default **false**; env `CLAWMEM_MCP_DIRECT_TUNED_WEIGHTS`): opt-in to score the MCP direct tools' non-recency queries with the retrieval-tuned `query`-tool weights. The default flip is gated on a direct-pipeline eval — the existing n=199 evidence covered only the hybrid `query` pipeline.
- Read-only template A/B evaluator (`scripts/eval-query-template.ts`): ranks known-target queries under query-template / doc-template / raw formatting against the live index through the same model+dimension guards as production, writing nothing. Measured post-incident: a doc-templated query ranked the true target #1 where the query template ranked it #383 — a query-side-only template change needs no re-embed.
- Production vector search now runs an explicit pre-MATCH dimension check via a shared query-vector compatibility guard (previously model-consistency only).
- Docs: the zembed-1 launch line ships with `--pooling last --override-kv tokenizer.ggml.add_eos_token=bool:true` (the missing flags seeded the incident); troubleshooting's claim that a re-embed is "not required" after a pooling fix is corrected (it IS required — same-dimension geometries are incompatible); the missing-EOS-anchor signature, shared-suffix diagnostic confound, compressed-high similarity bands, and watcher/`tee` operational notes are documented.

### Verification

`bun test` → 1492 pass / 0 fail (45 new regressions: escalation fill / cap-exhaustion markers / dedup-collapse / mixed-cause truthfulness / small-vault no-marker; traversal beam parity; shared-guard model+dimension; canary healthy/collapsed/drift/unavailable/mixed-endpoint; fail-closed preflight gate matrix; first-healthy baseline calibration; sampled-validation tiers incl. definitive-failure non-maskability, canonical-alias dedup, and hard attempt caps; busy-retry semantics; lease-fenced markers; `latest` routing; route-level MCP tests over an in-memory transport for all six retrieval tools incl. the incident composite-ranking fixture). Design adversarially reviewed to explicit clearance in a 7-turn cross-model DESIGN gate (34 findings folded); implementation review findings (fail-open canary gate, unbounded sampling, canonical-identity blindness, rolling baselines, taint persistence, and route coverage) folded before ship.

## v0.20.2 — Beads sync hardening: argument-safe exec, telemetry-off spawns

`runBd` assembled a shell string and ran it through `execSync`, leaving argument interpolation to the shell, and bd v1.1.0 upstream turned on anonymous usage metrics by default with a remote reporting endpoint and a spawned flush sender — so every bd invocation ClawMem makes during a sync would have phoned home on upgraded installs.

- **`execFileSync` replaces the shell string** (`src/beads.ts`): arguments pass as an array with no shell interpolation; same timeout, cwd, and error handling.
- **Telemetry is disabled for ClawMem-spawned bd calls only.** The spawn env forces `BD_DISABLE_METRICS=1` and `BD_DISABLE_EVENT_FLUSH=1`. Older bd releases ignore the unknown variables (verified on v0.58.0); a user's own interactive bd keeps whatever metrics preference they chose — automated sync calls would only have skewed it.

### Verification

`bun test` → 1447 pass / 0 fail. Empirical matrix on both ends of the supported bd range: v0.58.0 and v1.1.0 return identical rows with and without the env pair. The exec seam was flagged in an independent cross-model adversarial review (codex / GPT-5.5).

### What didn't change

The parse schema, sync semantics, dep-type bridging, and document shape are untouched. v0.20.2 is byte-identical in behavior to v0.20.1 except for the exec mechanism and the spawned-call env.

## v0.20.1 — Beads sync against bd v1.1.0: full-backlog list, dead field dropped, claim leases surfaced

An upstream delta survey of beads v1.0.5 → v1.1.0 (`gastownhall/beads`, formerly `steveyegge/beads`) found three drift points in the sync:

- **The 50-issue silent truncation is gone.** `queryBeadsList` inherited `bd list`'s default cap, so backlogs past 50 issues silently synced a prefix. The query now passes `--limit 0` (unlimited) — verified live against bd v0.58.0 and v1.1.0, so the fix does not raise the version floor.
- **`quality_score` dropped from the parse** (`src/beads.ts` interface, normalizer, and formatter). Upstream removed the field at v0.62.0; it was `omitempty` even before, so real `bd list --json` output stopped carrying it long ago. This is bd's per-issue field — ClawMem's own indexing-time quality scoring is a different mechanism and is untouched.
- **Claim leases surfaced.** bd v1.1.0 issues can carry `lease_expires_at` / `heartbeat_at`; the sync now parses both and renders a `**Claim Lease**: expires …` line when present, so agent-claimed work is visible in indexed memory. Absent on older bd → the line is skipped.

### Verification

`bun test` → 1447 pass / 0 fail. No ClawMem consumer references the dropped field (`store.ts` / `mcp.ts` / CLI checked). `--limit 0` and field behavior exercised against live databases on bd v0.58.0 and v1.1.0.

### What didn't change

Dependency-type bridging is untouched — the new upstream dep types (`tracks`, `until`, `authored-by`, `assigned-to`, `approved-by`, `attests`) fall to the existing `semantic` default exactly as unmapped types always have. Watcher behavior, `.beads/` discovery, and document format are unchanged apart from the two field-level items above.

## v0.20.0 — Vector-query daemon: a hard cap on the cold synchronous MATCH

v0.16.0 and v0.17.0 bounded the `context-surfacing` hook's vector leg with wall-clock deadlines and kept the sqlite-vec payload warm with a watcher prewarm, but those are probability reductions: a synchronous `bun:sqlite` MATCH exposes no interrupt, so once a cold scan on a large vault is in flight it blocks the hook's event loop past the 8-15s budget and the in-thread `Promise.race` timer cannot fire. v0.17.0 tracked the true hard cap — moving the scan off the hook's event loop — as deferred. This release ships it.

- **Vector-query daemon, hosted by the watcher (opt-in, a pure optimization layer).** `clawmem watch` now runs a per-vault unix-domain socket daemon. The `context-surfacing` hook sends only the query string; the daemon runs Step 1 — the embed plus the blocking sqlite-vec MATCH — in its own process and returns the raw `{hash_seq, distance}` matches, which the hook hydrates locally (Step 2). With the blocking scan off the hook's event loop, the hook's real `setTimeout` finally fires: a cold scan that would have blocked the turn now times out fast and falls back to FTS with bounded latency. `searchVec` is split into `searchVecMatch` (Step 1) and `hydrateVecResults` (Step 2); the in-process `searchVec` composes them, so its contract is unchanged, and both hook vector legs — primary and deep-escalation — are bounded, not just the first.
- **Strict graceful degradation — never a dependency.** When the watcher isn't running the socket is absent and the hook uses the in-process path exactly as before. When the daemon is busy or misbehaving the hook drops to FTS rather than re-running the scan in-process (which would reintroduce the block). A read-path model mismatch still surfaces as `VecReadModelMismatchError` (warned once) across the socket, preserving the v0.18.0 contract.
- **Single-flight, deadline-on-receipt, and a private socket.** At most one scan runs per vault; a request arriving mid-scan gets an immediate `busy` (→ FTS) rather than queuing, and a request whose deadline already elapsed is dropped without scanning — so cold-scan pileups cannot starve the watcher. The socket lives under `$XDG_RUNTIME_DIR/clawmem/` (0700 dir, 0600 socket), is keyed per vault DB path, refuses to clobber a live daemon from another watcher, and is unlinked on shutdown. `CLAWMEM_VEC_TIMING=1` logs per-leg outcome and elapsed for attribution.

### Verification

`bun test` → 1447 pass / 0 fail — the project's release gate. New bug-first tests in `tests/unit/vector-daemon.test.ts` (16, deterministic under `--rerun-each 3`) cover the socket protocol (serve, malformed, oversized, teardown), single-flight and deadline-on-receipt, the per-vault socket derivation, and the client's full fail-open matrix (absent → in-process, busy/error → FTS, model-mismatch → typed rethrow); the Step-1 scan is dependency-injected so they run without an embedding server. A bare `tsc --noEmit` remains a non-gate for the reasons noted under v0.18.0; the new `src/vector-daemon.ts` and the split `src/store.ts` add no new type errors over that baseline. Reviewed by an independent cross-model adversarial pass (codex / GPT-5.5-high): a fresh DESIGN gate on the spec at build time, then code review to zero remaining findings.

### What didn't change

Retrieval quality, scoring, ranking, and the vault format are untouched — the daemon returns the same Step-1 matches the in-process path would, hydrated by the same Step-2 query. A deployment that does not run `clawmem watch` gets byte-identical behavior to v0.19.0. The daemon hosts the general vault only; skill-vault vector queries stay in-process (a far smaller surface, not the ~2 GB risk).

## v0.19.0 — Priority-based transcript formatting for session extraction

The `decision-extractor` and session-summary Stop hooks prepared their LLM input by walking the last N messages and truncating each to a per-role character cap until a flat budget ran out. Under that scheme a long run of mid-conversation tool output could exhaust the budget before the final assistant message (the actual outcome) was reached, and the original user request — the single most important anchor for extraction — carried the same weight as any other message. Extraction quality degraded on exactly the long, tool-heavy sessions where good observations matter most.

- **Priority-based transcript assembly.** `prepareTranscript` now classifies each message before budgeting: P0 the first user message (the original request), P1 the last real assistant message (the final response, skipping trailing tool calls), P2 tool activity, P3 the remaining conversation, P4 system messages. The critical P0/P1 pair is always included (at a doubled per-role cap); tool activity and then conversation fill the remaining budget and are *truncated to fit* rather than dropped wholesale; the result is reassembled in chronological order so the LLM still sees a coherent sequence. Tool detection keys off the generic `[tool_use` / `[tool_result` markers, so a transcript that ends on a tool call correctly keeps the preceding assistant text as the final response instead of mislabeling the tool call as the outcome.

### Verification

`bun test` → 1431 pass / 0 fail — the project's release gate. New bug-first tests in `tests/unit/observer.test.ts` cover `classifyMessages` (P0–P4 assignment, plus the end-on-tool and all-tool edge cases where no P1 exists) and `prepareTranscript` (P0/P1 always present, chronological order preserved, tight-budget prioritization, and tool messages truncated-to-fit rather than dropped). A bare `tsc --noEmit` remains a non-gate for the reasons noted under v0.18.0; the changed `src/observer.ts` adds no new type errors over that baseline. Reviewed by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

Retrieval quality, scoring, the vault format, and every public API are untouched. The formatter keeps the same `TranscriptMessage[] → string` contract; only the selection and ordering of what survives truncation changed. A session short enough to fit the budget is formatted with the same content as before, now in guaranteed-chronological order.

## v0.18.0 — Read-path embedding-model guard, extraction parrot-hardening, remote LLM/rerank auth

Three independent hardenings gathered from a QMD-upstream survey. The first is a behavior change on the query path (a new fatal that replaces silently-wrong results) and drives the minor bump; the other two are additive.

- **Read-path embedding-model consistency guard (contract change).** A vault embedded with one model and then queried after the active embedding endpoint switched to a *different model at the same dimension* silently matched the new query vector against the old stored vectors — cosine-meaningless results that `VecDimensionMismatchError` cannot catch (the dimension is unchanged). `searchVec` now compares the endpoint-returned model against the vault's stored model(s) after the query embed and throws `VecReadModelMismatchError` unless the vault holds exactly one model equal to the active one — a heterogeneous vault (more than one stored model) is rejected too, since the extra model's vectors still pollute the space. The comparison uses the endpoint's own reported model, not the caller's model alias, and is cached per connection keyed on SQLite's `data_version` so a cross-process `clawmem embed --force` invalidates a stale verdict. Explicit query paths (MCP tools, the REST server, the CLI) surface the error; the fail-open hooks (`context-surfacing`, the Stop-hook `decision-extractor`) warn once per process and degrade to BM25 rather than dropping the turn. Remedy: `clawmem embed --force`.
- **Extraction prompts hardened against parroting.** The conversation-synthesis and deductive-synthesis prompts carried copyable few-shot examples with concrete, real-looking content; a weak local extraction model run out of distribution echoed them verbatim instead of extracting. Both examples are replaced with structure-only `{{...}}` skeletons, and a shared residue guard — extracted from the observer path into `src/schema-placeholder.ts` and now imported by all three extraction paths — rejects any output that echoes a schema placeholder or template marker. A new `placeholderRejects` counter surfaces echoed drafts in the deductive-synthesis stats. The guard deliberately does not blocklist the removed example text (plausible real facts like an OAuth decision would false-positive); it keys off the skeleton markers instead.
- **Remote LLM + reranker authentication.** `generateRemote` (the remote LLM path) and the remote reranker path sent no `Authorization` header, so neither could point at an authenticated cloud endpoint. New independent env vars `CLAWMEM_LLM_API_KEY` and `CLAWMEM_RERANK_API_KEY` add a `Bearer` header when set, mirroring the existing `CLAWMEM_EMBED_API_KEY`. The three keys are independent (the services may sit behind different hosts). Additive and backward-compatible — no header is sent when a key is unset.

### Verification

`bun test` → 1228 unit + 131 integration + 35 hooks = 1394 pass / 0 fail — the project's release gate. (A bare `tsc --noEmit` is not a gate here: the root tsconfig pulls in a vendored example app whose deps aren't installed, and the tree carries pre-existing type-loose test idioms; the changed W1/W2/W3 source adds no new type errors over that baseline.) New and expanded bug-first tests: `tests/unit/embed-dimension-safety.test.ts` (read-path model mismatch, endpoint-model-vs-caller-arg discrimination, heterogeneous-vault rejection, cross-connection `data_version` invalidation, and the fatal-rethrow helper), `tests/unit/schema-placeholder.test.ts` (residue detection with an explicit false-positive boundary), `tests/unit/conversation-synthesis.test.ts` and `tests/integration/deductive-guardrails.integration.test.ts` (skeleton echoes rejected, residue filtered), and `tests/unit/llm-remote-config.test.ts` + `tests/unit/rerank-health.test.ts` (auth headers present when configured, absent when not, keys independent). Reviewed across all three workstreams by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

Retrieval quality, scoring, and the vault format are untouched. The read-path guard fires only on an actual model divergence — a correctly-embedded vault behaves exactly as in v0.17.0. When no auth keys are set, the LLM and reranker requests are byte-identical to before.

## v0.17.0 — Harden the `context-surfacing` hook budget + cancellable embeds (follow-up to v0.16.0)

v0.16.0 fixed the dominant `context-surfacing` hook-timeout causes (the unbounded synchronous vector leg and the init-backfill write lock). This release closes the residual write-contention and embed-cancellation gaps on the same hook path, and keeps the warm-cache guarantee alive on long-running hosts.

- **Best-effort hook writes fail fast under contention.** The hook's own writes (the dedup UPSERT, `context_usage`, recall events, co-activations) are all best-effort, but the dedup UPSERT ran early and unguarded — a contended `SQLITE_BUSY` there aborted the whole hook before it could return context. It is now fail-open, and the `context-surfacing` hook process caps its own `busy_timeout` (1500ms) so a contended best-effort write fails fast instead of stalling the budget. The cap is scoped to that process only (the Stop hooks keep the 5000ms default), and the skill-vault opens on the hook path inherit the same cap.
- **Cancellable embeds.** `embed()` now honors an `AbortSignal` end to end: the underlying fetch is cancellable, the 429 retry backoff aborts mid-sleep instead of sleeping through every retry, and an aborted embed is classified as cancellation — not a transport failure — so it no longer trips the 60s remote-down cooldown. `searchVec`/`getEmbedding` derive the signal from their wall-clock deadline, and a deadline also suppresses the unbounded local-model fallback so a hook embed cannot start a model load past its budget. The indexing batch-embed path is unchanged.
- **Periodic vector prewarm.** The watcher's one-shot prewarm warms the OS page cache once; on a long-running host under memory pressure the kernel can evict the vector payload between hook calls, letting a cold synchronous scan creep back onto the hook path. The watcher now re-runs the embed-independent prewarm on an interval — `CLAWMEM_PREWARM_INTERVAL_MS`, default 10 minutes, `0` disables, values below a 60s floor are clamped up — to keep the payload resident. This is a probability reduction, not a hard cap: a true bound on the uninterruptible synchronous scan needs process isolation and is tracked as deferred.
- **Two test-methodology fixes (source proven correct, not adjusted).** A pre-existing topic-boost fail-open test conflated the focus-topic variable with sequential recall-feedback state and read the real skill vault; it now uses two identically-seeded stores plus hermetic vault isolation, and the zero-match fail-open contract is proven byte-identical. A pre-existing watcher heavy-lane test set a `0..23` quiet-window believing it meant "any hour," but the window is end-exclusive, so the test failed during the 23:00 local hour; it now omits the window (always-open) and a hermetic unit guard pins the end-exclusive boundary.

### Verification

`bun test` → 1390 pass / 0 fail. New and expanded bug-first tests: `tests/unit/hook-timeout-fix.test.ts` (dedup fail-open under a held write lock, the named-vault `busy_timeout` cap, periodic prewarm firing + clean teardown, and the interval resolver's strict parse + floor) and `tests/unit/llm-fallback.test.ts` (embed `AbortSignal` across the fetch, the 429 backoff, the cooldown classification, and the local-fallback suppression). Each was guard-verified — it fails on the pre-fix source and passes after. Reviewed by an independent cross-model adversarial pass (GPT-5.5 high) to zero remaining findings.

### What didn't change

Retrieval quality, scoring, and the vault format are untouched. The `busy_timeout` cap is scoped to the `context-surfacing` hook process, so the Stop hooks and every other command keep the operational default. On any host that does not run the watcher, behavior is exactly as in v0.16.0 (the periodic prewarm lives only in the watcher).

## v0.16.0 — Fix: `context-surfacing` UserPromptSubmit hook intermittently times out

The `context-surfacing` hook could intermittently exceed its UserPromptSubmit budget ("hook timed out — output discarded"), especially on the first prompt after a fresh boot and across concurrent sessions. The dominant cause was **not** inference or host memory: the vector leg ran a *synchronous* `sqlite-vec` scan that the `Promise.race(vectorTimeout)` guard could not bound (a synchronous call blocks the event loop, so the timer never fires), and every writable hook open ran an unconditional backfill `UPDATE` that could wait out `busy_timeout` under writer contention.

- **Bounded vector search on the hook path.** `searchVec` now takes a wall-clock deadline and self-aborts before the blocking `MATCH` if the budget elapsed during the async embed. Both the balanced and deep-escalation vector legs race the embed against the remaining budget and clear their timers, so a pending timer no longer keeps the hook process alive after results are in hand.
- **No write lock on a healthy init.** The `last_accessed_at` backfill is read-guarded (skipped when nothing needs it) and `initializeDatabase`'s `busy_timeout` is capped to the caller's value, so a writable hook open no longer waits out the init `busy_timeout` under contention.
- **Watcher-side vector prewarm.** A single embed-independent prewarm (a zero-vector `MATCH`) warms the sqlite-vec payload into the OS page cache on watcher startup so the first post-boot hook call isn't cold. It runs only in the watcher process (never per-session), reports success only when a scan actually ran, and never blocks startup.

Cross-model reviewed (GPT-5.5, five rounds to zero findings). New tests: `tests/unit/hook-timeout-fix.test.ts`.

## v0.15.1 — Fix: macOS bootstrap fails to load the sqlite-vec extension (Issue #20)

On macOS, `clawmem bootstrap` (and `clawmem doctor`) failed at the database step with `This build of sqlite3 does not support dynamic extension loading`. Apple's built-in SQLite — which Bun uses by default — is compiled without extension-loading support, so the `sqlite-vec` vector extension cannot load. The prior macOS handling probed only the Apple-Silicon Homebrew path and swallowed the failure silently, so a fresh macOS install with no `brew install sqlite` (and Intel Macs, whose Homebrew prefix differs) hit the bare extension-loading error with no guidance. Yoloshii/ClawMem#20.

What changed:

- **Broader extension-capable SQLite detection** (`src/store.ts`): `setCustomSQLite()` now probes the Apple-Silicon (`/opt/homebrew`) *and* Intel (`/usr/local`) Homebrew prefixes, falling back to `brew --prefix sqlite` for non-standard prefixes (only when the standard paths are absent, so the common case pays no subprocess cost). Every candidate is existence-checked before use — `setCustomSQLite()` with an invalid path hard-crashes Bun (oven-sh/bun#18811), so the existence guard is load-bearing, not cosmetic.
- **Actionable error instead of the cryptic one** (`src/store.ts`): both `sqlite-vec` load sites now route through a helper that, on macOS, rewrites the "does not support dynamic extension loading" failure into guidance to run `brew install sqlite` (naming the detected SQLite path, or noting none was found). `clawmem bootstrap` and `clawmem doctor` surface this message directly instead of the bare extension error.
- **Troubleshooting entry** (`docs/troubleshooting.md` → "Bun runtime"): documents the symptom, the `brew install sqlite` fix, and the auto-detection behavior.

### Verification

`bun test tests/unit/` → 1183 pass / 0 fail. A new bug-first test (`tests/unit/store.macos-sqlite.test.ts`, 5 cases) asserts the error mapping: macOS + no Homebrew SQLite → `brew install sqlite` guidance; macOS + a detected-but-failing SQLite → `brew reinstall` + the path; non-macOS and unrelated errors pass through untouched. It fails on the pre-fix source (no mapping existed) and passes after.

### What didn't change

- No change to retrieval, scoring, the vault format, or any non-macOS code path — on Linux/Windows the macOS detection block is skipped entirely and `sqlite-vec` loads exactly as before. This is a macOS-only install fix.

## v0.15.0 — Agent-instruction refactor (AGENTS.md as lean SSOT) + antipattern durability fix

The agent-facing instruction surface was three overlapping copies — `CLAUDE.md` and `AGENTS.md` were byte-identical 72 KB / 800-line twins (2.2× over Codex's 32 KiB `AGENTS.md` cap, which truncates silently), and `SKILL.md` was an 830-line third copy. All three duplicated each other and the existing `docs/` tree. This release aligns to the convention — `AGENTS.md` is the lean root SSOT, `CLAUDE.md` imports it, `SKILL.md` is on-demand operational guidance, and the deep reference lives in `docs/`. It also fixes a latent scoring bug found during review: `antipattern` memories were decaying despite being documented and intended as durable.

What changed:

- **`AGENTS.md` is now a lean root SSOT** (72,637 → ~17.7 KB, under the 32 KiB cap). Keeps the agent-facing essentials — inference-at-a-glance, install, the 90/10 retrieval model + Tier-2 hook table, the 3-rule escalation gate, Tier-3 tool routing + MCP tool table, query-optimization levers, composite-scoring summary, indexing rules, lifecycle, anti-patterns, integrations — and points into `docs/` for everything deep, with a reference index at the foot.
- **`CLAUDE.md` is now an `@AGENTS.md` import** (72,637 → 379 bytes), ending the byte-identical twin and its dual-maintenance drift. Claude Code reads `CLAUDE.md` natively, so the import bridges to the single SSOT.
- **`SKILL.md` trimmed to an on-demand operational reference** (830 → ~267 lines, `version` 2.0.0): escalation gate, tool routing, the 4 query-optimization levers, pipeline behavior, composite scoring, lifecycle, gotchas — with repo-relative pointers. Setup / inference / config / internals deliberately live in `AGENTS.md` + `docs/`.
- **New `docs/guides/inference-services.md`** consolidates the inference / model / server-setup content that was triplicated across `AGENTS.md`, the README "GPU Services" wall, and `cloud-embedding.md`, with a stack-decision matrix (QMD-native vs SOTA z-stack vs cloud embedding) up front.
- **New `docs/reference/configuration.md`** — a complete environment-variable reference (every `CLAWMEM_*` var except the internal, process-set `CLAWMEM_STDIO_MODE`).
- **README**: the "GPU Services" setup wall collapsed to a ~20-line decision callout linking the new guide (81.5 → 71.5 KB); the "Agent Instructions" file-roles table updated; `docs/guides/systemd-services.md` gained the scheduled `clawmem-rerank-health` unit (previously documented only in the old AGENTS.md).
- **`package.json` `files[]` now includes `docs/`** so the relative `docs/` pointers in the shipped `AGENTS.md` / `CLAUDE.md` / `SKILL.md` resolve for npm consumers, not just git clones.
- **Fix — `antipattern` memories are now durable** (`src/memory.ts`): `antipattern` was in `DECAY_EXEMPT_TYPES` and mapped to a `semantic` relation, but was **omitted from `HALF_LIVES` and `TYPE_BASELINES`**, so it fell through to the 60-day half-life / 0.5 baseline defaults — i.e. it decayed despite being documented as ∞ half-life / 0.75 baseline. Added `antipattern: Infinity` to `HALF_LIVES` and `antipattern: 0.75` to `TYPE_BASELINES` (matching the documented values). Accumulated negative patterns now persist as intended and rank with a durable baseline.

### Verification

`bun test tests/unit/` → 1178 pass / 0 fail. A new bug-first test (`tests/unit/memory.scoring.test.ts`) asserts `antipattern` durability — `recencyScore` returns 1.0 at one year old, `antipattern` confidence outranks `note` (exercising the 0.75 baseline), and the attention-decay exemption holds; it fails on the pre-fix source and passes after. Every relative link in the refactored files was resolved; `AGENTS.md` confirmed under 32 KiB; `CLAUDE.md` confirmed no longer a byte-twin. Reviewed by an independent cross-model adversarial pass (codex / GPT-5.5-high) across the refactor and the source fix to zero remaining findings.

### What didn't change

- **No retrieval-pipeline, scoring-formula, or vault-format change** beyond the `antipattern` durability fix. Documented facts, tool routing, hook behavior, and scoring weights are preserved — moved, condensed, or consolidated, not altered.
- The only runtime behavior change is `antipattern` memories no longer decaying (and getting a 0.75 vs 0.5 baseline); every other content type's half-life and baseline is unchanged.

## v0.14.0 — Reranker health guard: detect a silently-degenerate reranker (doctor + scheduled check + runtime emit)

v0.11.3 deprecated the broken zerank-2 GGUF and shipped a faithful sidecar; v0.12.0 made the reranker the dominant ranking signal. Together they raised the stakes of a *silent* reranker failure: the broken GGUF returned HTTP 200 + valid JSON + finite positive ~1e-11 scores — passing every liveness check — yet contributed nothing at weight 0.9 and silently collapsed the final ranking to RRF. `blendRerank`'s usability check was `score > 0`, which those ~1e-11 scores passed, and `clawmem doctor` had no reranker probe at all. This release makes that failure mode impossible to miss.

What changed:

- **`blendRerank` degenerate-floor trip + visible fallback** (`src/search-utils.ts`): the usability check widened from `> 0` to `> RERANK_DEGENERATE_FLOOR` (1e-4) — above the broken regime's 8e-7 ceiling, far below the weakest working score (~0.1) — so a near-zero collapse now routes to the RRF fallback instead of blending in ~nothing. The 3rd arg accepts an options object `{ rerankWeight, degenerateFloor, onFallback }` (numeric back-compat preserved); the `query` caller (`src/mcp.ts`) passes an `onFallback` that emits a rate-limited (≤1/min) stderr warning + running count, so the previously-silent degrade is surfaced.
- **`clawmem doctor` section 9 — reranker discrimination** (`src/clawmem.ts`): an active probe that asserts the reranker *discriminates*, not just responds. Runs a shipped golden set of same-topic (query, relevant, hard-negative) pairs (`src/health/rerank-golden.json`) through the live reranker, cache-bypassed, and checks coverage + a calibration band + a per-pair discrimination margin.
- **`clawmem rerank-health` command + scheduled unit** (`src/clawmem.ts`; `CLAUDE.md`/`AGENTS.md`): the same probe as a standalone command that exits non-zero on degeneracy, for a systemd `OnFailure=` alert (`clawmem-rerank-health.{service,timer}`, documented) — proactive detection of an endpoint reverted to the broken GGUF, independent of query traffic.
- **`store.rerank` probe seam** (`src/store.ts`): an additive `{ noCache, requireLiveCoverage, signal, timeoutMs }` options param. `noCache` bypasses the rerank cache (so a probe always exercises the live endpoint); `signal`/`timeoutMs` bounds the remote fetch; `requireLiveCoverage` enforces the full coverage contract — exactly `batch.length` results, unique in-range integer indices, finite numeric scores, a valid JSON object body — **before** the score-apply zero-fill (after which an omitted score and a true 0 are indistinguishable), throwing `RerankCoverageError` / `RerankMalformedResponseError`. A defensive skip in the apply loop also hardens the production path against an out-of-range index or non-array body (previously a latent crash).

### Verification

Thresholds were calibrated from a live `zerank-2-seq` baseline (8-pair golden set): relevant scores 0.92–0.97, hard-negative ≤ 0.31, minimum margin 0.64, 0/8 inverted — vs the broken GGUF regime's max-ever 8.03e-7 (a 5–6 order-of-magnitude separation). Locked: `CALIB_FLOOR 0.05`, `DISCRIM_MARGIN 0.25` (2.5× below the live minimum margin), `RERANK_DEGENERATE_FLOOR 1e-4`. 24 new unit tests (`tests/unit/rerank-health.test.ts`) pin the load-bearing contracts: the degenerate-floor trip + `onFallback`, the options-object overload + 2-arg back-compat, coverage-before-zero-fill, the malformed-response contract (duplicate / out-of-range / wrong-count / non-numeric / invalid-JSON / null-body), the defensive non-probe skip, and the calibration-band-passes-but-margin-fails (constant-output) case. Full suite: 1363 pass / 1 pre-existing unrelated failure; `tsc --noEmit` clean. Reviewed across the design and the implementation by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

- **The healthy hot path is untouched.** A working reranker scores ≫ 1e-4, so `blendRerank` behaves exactly as in v0.12.0; the degenerate floor only changes behavior when the reranker has already collapsed (where the old code silently produced RRF order anyway — now it is explicit and surfaced). `store.rerank`'s no-options path (the `query`, `intent_search`, and context-surfacing callers) is byte-identical to before.
- No schema migration, no config/env-var change, no breaking API change — the `store.rerank` options param and the `blendRerank` options object are additive, and the new CLI command, `doctor` section, golden set, and systemd recipe are all additive. The default reranker stays qwen3-reranker-0.6B.

## v0.13.0 — Query composite re-weight: search 0.70 for the `query` tool (the deferred lever from v0.12.0)

v0.12.0 fixed the rerank blend but flagged a larger deferred lever: composite scoring's default `{search:0.50, recency:0.25, confidence:0.25}` puts half the weight on non-search signals, which caps how much the improved blend reaches the surfaced top-k. v0.12.0 deferred acting on it "pending a judged-relevance / recency-aware eval." This release runs that eval and acts on it — scoped to the `query` tool only.

What changed:

- **The `query` tool now scores with `QUERY_WEIGHTS = {search:0.70, recency:0.15, confidence:0.15}`** (`src/memory.ts`), replacing the 0.50/0.25/0.25 default for non-recency `query` calls. Implemented via an additive `{ weights, now, forceWeights }` options seam on `applyCompositeScoring`; the `query` call passes `{ weights: QUERY_WEIGHTS }` **without** `forceWeights`, so a recency-phrased query still switches to `RECENCY_WEIGHTS` (0.10/0.70/0.20) by construction. Scoped to the `query` tool — `search`, `vsearch`, `memory_retrieve`'s routed modes, `intent_search`, and the context-surfacing hook keep the 0.50/0.25/0.25 default (their pipelines weren't part of this eval).

### Verification

A held-out, judged-relevance eval — the recency-aware eval v0.12.0 asked for. Real `query`-shaped prompts (held-out n=279 → 199 usable after oracle-drop) were graded 0–3 by an LLM judge (GLM-5.2) over the full ~30-doc candidate pool per query, blind / order-shuffled / freeze-time-framed. The judge was calibrated against an independent annotator (quadratic-weighted κ=0.681) plus an order-perturbation self-consistency check (κ=0.77). A dev pilot (n=84) picked the candidate weight; a **pre-registered decision rule** (locked before the held-out judging) then chose between 0.70 and 0.80. Result: graded NDCG@10 vs the 0.50 control — **w_search 0.70 +0.064 (paired permutation p<1e-4)**, 0.80 +0.104, robust across precision / exploratory / temporal families. A dedicated **freshness guard** (does raising search weight demote the newest-correct version of an evolving doc?) was the tiebreaker: at 0.70 the newest-correct doc is never demoted (mean rank improves); at 0.80 it falls out of the top-10 in 2/19 supersession cases. So **0.70 captures the bulk of the gain with zero freshness regression**, while 0.80's extra NDCG came at a freshness cost in a work-memory vault full of evolving docs. Pinned- and revision-rank-stability guards are non-regressive at 0.70. Reviewed across design, dev results, hardening, and implementation by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

- **`RECENCY_WEIGHTS` and the recency-intent switch** — a recency-phrased query ("latest", "recent", "last session", …) is scored exactly as before. The freshness guarantee the eval relied on holds by construction (`forceWeights` is never set).
- `search`, `vsearch`, `memory_retrieve` routed modes, `intent_search`, and the context-surfacing hook — all keep the 0.50/0.25/0.25 default. The seam's no-options path is byte-identical to prior behavior.
- No schema migration, no config/env-var change, no API-shape change. **`query` result ordering shifts**, and the **composite-score distribution** shifts upward for search-dominated hits — threshold consumers of the returned `compositeScore` (e.g. `minScore`) may see changed inclusion near the boundary. Scores remain `[0,1]`-scaled.

## v0.12.0 — Query reranking: blend the cross-encoder as the dominant signal (fixes the immovable RRF #1)

The `query` tool fused the cross-encoder reranker into the final ranking with a position-aware blend — `rrfWeight·(1/rrfRank) + (1-rrfWeight)·rerankScore`, with `rrfWeight` 0.75 / 0.60 / 0.40 by RRF rank. Because reranker scores are in `[0,1]`, RRF rank-1's floor (`0.75·(1/1)` = 0.750) exceeds RRF rank-2's ceiling (`0.75·(1/2) + 0.25·1` = 0.625): **RRF #1 was mathematically immovable by the reranker.** A strong reranker could reorder the tail but could never promote the best document to the top. With the now-faithful zerank-2 seq-cls reranker (v0.11.3), that ceiling was discarding the reranker's single largest win.

What changed:

- **New `blendRerank` blend** (`src/search-utils.ts`): `0.1·normalizedRRF + 0.9·rerank`. The cross-encoder is the dominant relevance signal; normalized RRF is a thin tiebreaker — so a strong rerank score *can* promote a document over RRF #1. It maps over the candidate set (so partial rerank coverage can never drop a candidate) and **falls back to pure RRF order** when the reranker is unavailable or returns no usable signal (empty / all-zero — e.g. a total remote+local failure, now also caught by a try/catch around the rerank call). Scoped to the `query` tool; `intent_search` is unchanged (its blend uses actual upstream scores, a different shape, measured separately).

### Verification

Harness-validated against known-item recall over two eval sets (NL n=45, KW n=50) on a frozen 3,743-doc snapshot with the live reranker, faithfully replicating the production query path (the harness's pre-rerank ranking reproduces the prior pipeline's exactly). At the blend stage the reranker lifts recall@1 from 0.22 (RRF alone) to 0.62 — and the old blend discarded all of it (blend@1 equalled RRF@1 to three decimals). The shipped 0.1/0.9 blend improves final recall@1–5 and MRR@10 on both eval sets with no material pooled recall@10 regression (NL @10 +0.044, KW @10 −0.04, pooled tie). New unit tests (`tests/unit/search-utils.blend.test.ts`) pin the two load-bearing contracts: a strong rerank score promotes above RRF #1, and empty/all-zero rerank preserves RRF order. Reviewed across design, results, and implementation by an independent cross-model adversarial pass (codex / GPT-5.5-high) to zero remaining findings.

### What didn't change

- `intent_search`, `search`, `vsearch`, the context-surfacing hook's deep-profile rerank blend, composite scoring, and MMR are unchanged — only the `query` tool's rerank/RRF blend. No schema migration, no config/env-var change, no API-shape change (result ordering for `query` shifts; scores remain `[0,1]`-scaled as before).
- A separate, larger lever surfaced by this work — composite scoring's 50% non-search weighting, which caps how much the improved blend reaches the surfaced top-k — is **deferred** to a future release pending a judged-relevance / recency-aware eval (known-item recall alone can't adjudicate it). MMR was measured to be a near-no-op here and is left untouched.

## v0.11.3 — Reranker: deprecate the broken zerank-2 GGUF; ship the zerank-2 seq-cls sidecar (SOTA, non-commercial)

The "SOTA upgrade" reranker — `zerank-2-Q4_K_M.gguf` served under `llama-server --reranking` — was silently broken. This release deprecates it across the docs and ships a working replacement as an opt-in recipe.

Root cause: zerank-2 is a `Qwen3ForCausalLM` that scores a (query, document) pair on the logit of a single relevance token ("Yes", id 9454) via a sentence-transformers `LogitScore` head. llama.cpp's `convert_hf_to_gguf.py` only synthesizes a rerank head when the model card contains the literal string `# Qwen3-Reranker`; zerank-2's card lacks it, so the previously-recommended GGUF — and any built by the current/standard llama.cpp converter — is a **headless causal LM**. Served with `--reranking` it returns near-zero, uninformative scores → reranking degrades to an inert RRF-dominated passthrough, with no error.

What changed:

- **New opt-in recipe** at `extras/rerankers/zerank-2-seq/` — converts `zeroentropy/zerank-2-reranker` to a `Qwen3ForSequenceClassification` (`num_labels=1`) whose score head is the tied-embedding row 9454, so the relevance logit is **identical by construction** to the native causal score. Served as a small transformers sidecar (`/v1/rerank`, `batch=1`, applies zerank's chat template, returns `sigmoid(logit/5)`) behind the existing `CLAWMEM_RERANK_URL` contract — drop-in, no ClawMem code change.
- **Reproducible correctness gate** (`build_and_verify.py`) — the convert step refuses to finish unless it proves: fp32 score-head weight-equality (bf16 preserved, no fp16 downcast); served-tokenizer == source-tokenizer (including the truncation path); the assistant-generation prefix survives near-`MAXLEN` inputs; and the seq-cls logit equals the causal token-9454 logit bit-exactly over the real served path (including batched right-padded pooling and empty/whitespace-doc edges).
- **Docs corrected** — `README.md`, `CLAUDE.md`/`AGENTS.md`, `SKILL.md`, `docs/quickstart.md`, `docs/introduction.md`, and `docs/guides/cloud-embedding.md` now point the SOTA reranker at the sidecar and explain the GGUF deprecation; `docs/guides/upgrading.md` gains a migration section. Full-SOTA-stack VRAM guidance moves 12GB → 16GB (the bf16 reranker is ~9GB).

### Verification

The conversion's correctness is enforced by `build_and_verify.py`, which the convert step runs before serving and which exits non-zero unless every gate passes: fp32 score-head weight-equality (bf16 preserved, no fp16 downcast); served-tokenizer == source-tokenizer identity (including the truncation path); assistant-prefix preservation under near-`MAXLEN` inputs; and seq-cls-vs-causal token-9454 logit equivalence over the real served path (batched right-padded pooling + empty/whitespace-doc edges). Verified live after deploy: relevant vs. irrelevant scores 0.96 / 0.08, matching the gate.

### What didn't change

- **zembed-1** (SOTA embedding) and **qwen3-reranker-0.6B** (default reranker) are unchanged — only the zerank-2 *reranker GGUF* is deprecated.
- No `src/` change, no schema migration, no config/env-var change, no public API change. ClawMem's default reranker stays the permissively-licensed qwen3-reranker-0.6B; the sidecar is an opt-in upgrade. zerank-2 weights are **CC-BY-NC-4.0** (non-commercial) and are never bundled — the recipe downloads them for your own use.

## v0.11.2 — Packaging: `bin` path so `npm install -g` registers the `clawmem` command on npm 11

v0.11.2 is a packaging-only fix. The `bin` map declared `"clawmem": "./bin/clawmem"`; npm 11's publish path rejects the `./`-prefixed form and **drops the bin entry from the tarball** (older npm silently rewrote it — the live v0.11.0 ships `bin/clawmem`), so a global install would land the files but expose no `clawmem` command. Changed to `"clawmem": "bin/clawmem"`, verified with `npm publish --dry-run` (no warning; the bin survives in the packed `package.json`).

No source change from v0.11.1. **v0.11.1 was git-tagged but never reached npm** (the publish that surfaced this packaging issue also failed on an expired npm token), so on npm v0.11.2 supersedes v0.11.0 directly and carries the full v0.11.1 query-expansion fix documented below.

## v0.11.1 — Query expansion: typed lex/vec/hyde routing + terse qmd prompt (fixes garbage / mis-routed expansions)

v0.11.1 fixes the LLM query-expansion stage, which had two compounding bugs that quietly degraded `query` / `intent_search` recall: the expansion model produced **garbage variants**, and the variants that were usable got **routed to the wrong search backend**.

Root cause — two layers:

- **Prompt was out-of-distribution for the finetune.** `expandQueryRemote` (`src/llm.ts`) sent a verbose prose instruction with no format constraint. The shipped expansion model (`qmd-query-expansion-1.7B`, a Qwen3-1.7B finetune) was trained on QMD's terse `/no_think Expand this search query: <q>` form. The mismatch produced bare question-stem "lex" terms ("What are the", "How do the"), literal template echoes, and `</think>` leakage — roughly a third of queries returned pure template noise.
- **Variant type was erased at the routing layer.** The expander emits typed `lex` (keyword), `vec` (semantic), and `hyde` (hypothetical-answer) variants, but every consumer dropped the type and searched **each variant on both backends** — so keyword expansions were vector-searched and hypothetical-answer passages were BM25-searched, each leg fed the input it handles worst. The CLI (`clawmem query`) was worse: it re-parsed already-stripped `lex:` / `vec:` prefixes, collapsing every variant into a single mis-typed list.

What changed:

- **Terse, in-distribution prompt.** `expandQueryRemote` now sends `/no_think Expand this search query: <q>` (plus the intent line when provided), matching the finetune's training form. Clean lex/vec/hyde verified end-to-end against the live server.
- **Typed `ExpandedQuery` contract end-to-end.** `store.expandQuery` returns `{ type, query }[]` instead of erasing the type, and every consumer routes by it: `lex → BM25`, `vec` / `hyde → vector`, original query → both backends (the only leg that fans out to both, keeping its 2× RRF anchor). Fixes the MCP `query` tool (`src/mcp.ts`), the CLI (`src/clawmem.ts`), and the deep-escalation path in `context-surfacing` (`src/hooks/context-surfacing.ts`). The MCP tool now also counts the original query's actual contributed list count for the 2× positional weight, fixing a latent mis-weight when the original's BM25 or vector leg came back empty.
- **Shared sanitize guards.** A single `sanitizeExpandedQueries` (`src/llm.ts`) runs in both the remote parser and the store wrapper: strips stray control tokens (`/no_think`, `/think`, word-boundary-safe), rejects template-residue / `<think>` / empty lines, dedups, and echo-filters variants equal to the original. A typed `expansionFallback` covers expansion failure or all-junk output, and `isFallbackExpansion` detects a leaked llm-level fallback so the store returns expansions-only and does not cache it.
- **Versioned expansion cache.** Cache key bumped to `expandQuery:v3-qmd-terse-typed` with a provider fingerprint and typed-JSON value; the old newline-delimited cache ages out via LRU (no manual purge). A malformed v3 entry is rejected and re-expanded instead of partially accepted.

### Verification

`tsc` clean on the touched files; full unit suite green (187 pass). Live end-to-end against the running expansion server: typed shape, zero echo, zero template-junk, correct per-type routing, cache round-trip. Validated under a fresh GPT-5.5 high-reasoning adversarial review via `codex exec` (a separate impl-review session from the design session): Turn 1 surfaced three real findings — a leaked llm-level fallback being cached, partial acceptance of a malformed typed-cache entry, and CLI expansion-only candidates dropped after RRF — each fixed and re-verified to verbatim "zero remaining findings."

### What didn't change

- Composite scoring, MMR diversity, cross-encoder reranking, RRF fusion weights, vault format, hook set, and the agent tool surface are unchanged.
- No schema migration, no config or env-var change, no public API change; the expansion model and the three inference services are the same. **One behavior change:** query expansion now routes each variant to a single backend by type instead of searching every variant on both — recall improves on the same vault the moment you upgrade. Pure `bun add -g clawmem` upgrade.

Docs `docs/internals/query-pipeline.md`, `AGENTS.md`, and `CLAUDE.md` updated to describe typed routing (`AGENTS.md` / `CLAUDE.md` also carry a pending correction: MPFP meta-path fusion is max-score, not RRF).

## v0.11.0 — Embedding dimension-migration safety + lease-fenced, atomic vector writes

v0.11.0 hardens the embedding write path against a class of **silent vector loss** surfaced by a real incident: a re-embed reported success, but pure-vector retrieval (`vsearch` / `find_similar`) returned nothing for the affected docs. Root-cause analysis found two layers — a model-serving quality issue (operator-side; see Troubleshooting → "weak or irrelevant results") and, in ClawMem itself, an **unsafe dimension migration**: when the embedding model's output dimension changed, `ensureVecTable` dropped the `vectors_vec` table while the metadata-based worklist (`getHashesNeedingFragments`) skipped the now-vectorless documents (their `content_vectors` rows still existed). The result was a vault whose vectors were silently wiped while `embed` reported "all done."

What changed in the embedding write path:

- **`ensureVecTable` never drops an existing table.** A dimension/schema mismatch now throws a fatal `VecDimensionMismatchError` and aborts the run instead of dropping. The only path that clears vectors is the explicit `clearAllEmbeddings`, reached only via `embed --force`.
- **`embed` detects dimension AND model drift non-destructively.** An implicit (non-`--force`) run that sees a changed dimension — or a *different model at the same dimension*, which mixes a heterogeneous, similarity-meaningless vector space — aborts with instructions to run `--force`, never mutating. `embed --force` probes the endpoint **first** and aborts without clearing if it's unreachable, so a force rebuild against a dead server cannot wipe the vault. The whole run is bound to one `(dimension, model)`; every embedding is validated before it is stored.
- **All vector mutations are atomic and lease-fenced.** `insertEmbedding`, `clearAllEmbeddings`, `cleanStaleEmbeddings`, and table creation each run in a single immediate-write-lock transaction that verifies a renewable, token-fenced **embedding lease** (`worker_leases`, name `embedding`, heartbeat-renewed) before mutating — so two concurrent embeds, or a process that lost its lease mid-run, cannot interleave a clear with an insert or mix two models into one index. A second concurrent `embed` skips cleanly.
- **Crash-safe retry budget.** `embed_attempts` increments exactly once per attempt (at start), resets on a successful embed, and resets whenever a document's content changes (new hash) via a new `reset_embed_on_hash_change` trigger that covers *every* hash-changing path. A document can no longer be permanently excluded by stale failures from old content. Partial embeds are retried in full.
- **`doctor` now reports content_vectors ↔ vectors_vec consistency** (a set-difference check, including the worst case where `vectors_vec` is absent but metadata rows remain), and flags a vault that contains mixed embedding models.
- **`embed` exits non-zero** when a run aborts (dimension/model mismatch or lost lease), so the embed timer / `update --embed` can detect an incomplete run.

### Verification

Validated across a 9-turn GPT-5.5 high-reasoning adversarial review under `codex exec`: a diagnosis pass, four design passes (which overturned an initial "defer the concurrency lease" decision by demonstrating that two same-dimension models can silently build a heterogeneous index), and four code-review passes that drove findings 6 → 4 → 3 → 2 → **0** ("vector-table mutations are now atomic, lease-fenced, and dimension/model consistent"). Ships with new unit tests covering throw-on-mismatch, `getVecTableDim` states, the lease fence on insert/clear, the hash-change trigger, attempt-budget resets, and `getVecModels` heterogeneity detection; full suite green except one pre-existing unrelated integration test.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, and OpenClaw/Hermes plugin registration are unchanged.
- No public API change. **One behavior change:** `embed` now **aborts** on a dimension/model change instead of silently re-embedding into a dropped table — run `clawmem embed --force` to migrate. The only schema addition is the `reset_embed_on_hash_change` trigger, created automatically on store open (no manual migration).

## v0.10.7 — Hermes plugin: refresh session-derived state on `on_session_switch`

v0.10.7 implements the `MemoryProvider.on_session_switch` hook in the Hermes plugin (`src/hermes/__init__.py`). Hermes Agent (v2026.5.16) wired this lifecycle hook to fire on `/new` (reset=True), `/resume`, `/branch`, and context compression — any mid-process `session_id` rotation that does not tear the provider down. ClawMem previously did not override it (the ABC default is a no-op), so after a switch the plugin kept using the `session_id` it cached at `initialize()`: extraction and handoff metadata carried the stale id, and the session-keyed transcript file (`{session_id}.jsonl`) kept collecting the new session's turns under the old name.

The override repoints the cached `_session_id`, rebuilds `_transcript_path` for the new session, and **unconditionally** invalidates the prior session's prefetch + bootstrap caches so a recall queued under the old session cannot surface in the new one. To stay race-free with the background prefetch worker, `queue_prefetch` now snapshots the session id and transcript path under the prefetch lock at queue time (the worker uses the snapshot, never live state), and the switch bumps the prefetch generation monotonically so an in-flight worker discards its result instead of writing it into the new session. Retrieval is unaffected — the vault is path-keyed, not session-keyed — so this is metadata/transcript correctness, not a recall change.

### Verification

Validated across three turns of GPT-5.5 high-reasoning adversarial review under `codex exec`. Turn 1 (design) returned no-ship-as-written and caught two real bugs in the initial design — a reset-gated prefetch leak (stale recall crossing into `/resume` and `/branch` sessions) and an ABA race from resetting the prefetch generation to zero — and prescribed the snapshot-at-queue-time fix. Turn 2 verified the implemented design against a standalone behavioral test covering the switch / reset / compression / prefetch-race paths → verbatim "zero remaining design findings — can ship." Turn 3 re-cleared a final added assertion.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration, and the Claude Code hook path are all unchanged from v0.10.6.
- No reindex, no schema migration, no public API change, no config or env-var change. Pure `bun add -g clawmem` upgrade.

## v0.10.6 — FTS keyword-search tokenization: split separators instead of stripping them

v0.10.6 fixes an internally-found bug in the BM25 keyword-search path: the query builder silently returned **zero rows for any compound / path / snake_case / dotted / hyphenated query** — exactly the config-name, hook-name, filename, and identifier searches the system is meant to serve.

`src/store.ts:sanitizeFTS5Term()` removed every non-alphanumeric character from each whitespace token, which **concatenated** separator-delimited word-parts into a token that was never indexed. The FTS index (`documents_fts`, `tokenize='porter unicode61'`) does the opposite — it **splits** stored text on `_ - . / '` and all punctuation. So query and index tokenization disagreed:

- `before_compaction` → `beforecompaction` → `MATCH "beforecompaction"*` → **0 rows** (the index holds `before` and `compaction` as separate tokens)
- `src/store.ts` → `srcstorets` → **0 rows**; `q4_k_m`/`v0.8.2` → `q4km`/`v082` → **0 rows**

Vector recall partially masked this in the hybrid `query` path, but pure `search` (BM25-only) and the raw file-path supplemental lookup in `context-surfacing` returned nothing. CLAUDE.md, AGENTS.md, and SKILL.md already documented "code identifiers work" — this release makes the implementation match that promise.

Vault on disk is unchanged. **No reindex required** — a query-build change only, so it fixes every existing vault the moment you upgrade. No schema migration, no env-var change, no public API change. Pure `bun add -g clawmem` upgrade.

### The fix — split, don't strip

`sanitizeFTS5Term` is replaced by `tokenizeForFTS5`, which splits on the same boundaries the index tokenizer uses:

```ts
export function tokenizeForFTS5(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 0);
}
```

`buildFTS5Query` keeps the existing AND-of-prefixes semantics (`"before"* AND "compaction"*`). One-character tokens are kept (needed for `q4_k_m`, `v0.8.2`, `a/b`); AND makes them a precision constraint, not noise. The split regex consumes every FTS5 syntax character, so each surviving token is alphanumeric and quoted — at least as injection-safe as the prior strip approach.

### Entity FTS — exact-first candidate gathering

The same `tokenizeForFTS5` is shared with the two `entities_fts` MATCH builders (`src/entity.ts`). Adversarial review surfaced that a naïve prefix query there starves short exact names: `entities_fts` applies its `LIMIT` **before** the Levenshtein / mention-count ranking, so a broad prefix (`"go"*` matching 30 `Golang*` rows, or `"c"*` for `C++`) fills the candidate pool and drops the exact row before it can be ranked. `resolveEntityCanonical` and `searchEntities` now gather **exact-token matches first**, then top up with deduped prefix matches only while under the limit (`gatherEntityFTSCandidates`). The exact row is always present for ranking; multi-char prefix recall (`clawme`* → `clawmem`) is preserved as a supplement.

### Verification

Validated across four turns of GPT-5.5 high-reasoning adversarial review under `codex exec`. Turn 1 cleared the approach; Turn 2 confirmed the `documents_fts` fix correct + injection-safe but **caught the entity prefix-starvation regression**; Turn 3 rejected a 1-char-only band-aid (the same starvation hit short multi-char names like `Go`); Turn 4 cleared the exact-first fix verbatim "**zero remaining findings**" after re-running the repros (`C++` resolves, `Go` resolves, `clawme`→`ClawMem` recall holds).

Test coverage: 8 new bug-first tests in `tests/integration/store-search.test.ts` (compound, non-adjacent AND, slash-path via the filepath column, 1-char tokens, apostrophe behavior-lock, FTS5-specials no-throw, punctuation-only → empty) + 4 entity starvation regression tests in `tests/unit/entity.test.ts` (`C++` and `Go`, each across `resolveEntityCanonical` and `searchEntities`). Five of the store tests fail on the pre-fix code; all pass after. Full suite: 1298 pass / 0 fail. `tsc --noEmit` clean for the changed files.

### What didn't change

- Retrieval pipeline shape, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration (`kind: memory`), and the Hermes plugin contract are all unchanged from v0.10.5.
- No reindex, no schema migration, no public API change, no config or env-var change.
- The `store ⇄ entity` import added for the shared tokenizer is runtime-safe (hoisted `function` declaration, called only at runtime).

### Cross-references

- Codex review: 4 turns (T2 caught the entity regression, T4 zero remaining findings)
- Primary surfaces: `src/store.ts` (`tokenizeForFTS5`, `buildFTS5Query`), `src/entity.ts` (`gatherEntityFTSCandidates`, both `entities_fts` sites)

---

## v0.10.5 — Issue #13: SQLite PRAGMA ordering race fix + openclaw doc-comment line-ref bump

v0.10.5 fixes [yoloshii/ClawMem#13](https://github.com/yoloshii/ClawMem/issues/13). One bug reported by @jcgau (first-time contributor):

`src/store.ts:initializeDatabase()` set `PRAGMA busy_timeout = 15000` AFTER `PRAGMA journal_mode = WAL`. Because `busy_timeout` is a connection-level setting that only governs *subsequent* statements (default busy callback is NULL → `SQLITE_BUSY` returns immediately), the busy handler was not active when the first contending statement ran. When concurrent Stop-hook subprocesses (`decision-extractor`, `handoff-generator`, `feedback-loop`) opened the same SQLite file in parallel — both from OpenClaw's `agent_end` plugin-hook fan-out (`src/openclaw/engine.ts:449`) and from `before_reset` (`src/openclaw/engine.ts:576`), plus the Hermes `MemoryProvider.on_session_end` thread fan-out (`src/hermes/__init__.py:518`) — the first subprocess to acquire the journal-mode write lock succeeded and the rest returned `SQLITE_BUSY` immediately. Under the reporter's typical load (~48 heartbeat turns/day in their OpenClaw setup), two of three hooks failed per turn, silently dropping decision-extraction / handoff-generation / feedback-loop work for the losing subprocesses.

Vault on disk is byte-identical to v0.10.4. No schema migration. No env-var change. No public API change. Pure `bun add -g clawmem` upgrade.

### The fix — one-line ordering swap, applied to two sites

`src/store.ts:initializeDatabase()` (writable init path) and `src/store.ts:createStore()` readonly branch both now set `busy_timeout` as the **first** statement on the connection, before `sqliteVec.load()`, `PRAGMA journal_mode = WAL`, and any DDL. The writable path uses 15000ms during DDL (well within the 30s Stop hook timeout); the terminal `createStore()` statement resets to operational 5000ms (or `opts.busyTimeout`) after DDL completes. The readonly branch is also hardened against the same race — public-API hardening, since no in-tree production caller currently passes `readonly: true`, but the ordering invariant should hold regardless.

The docstring in `initializeDatabase()` carries the rationale durably so a future refactor can't quietly re-introduce the race:

> "busy_timeout is a connection-level setting that only governs *subsequent* statements (default busy handler is NULL → SQLITE_BUSY returns immediately), so it must precede the contending PRAGMAs. 15s is well within the 30s Stop hook timeout. createStore() resets to operational value (5000ms or opts.busyTimeout) after DDL completes."

### Verification

The change set was validated against two turns of GPT-5.5 high-reasoning adversarial code review (cumulative ~401K tokens) under `codex exec`. Turn 1 verdict was APPROVED WITH MODIFICATIONS — zero High, one Medium (soften the readonly-branch comment from "takes a brief write lock" to "can contend when switching/initializing WAL state"), one Low (mention BOTH `agent_end` AND `before_reset` parallel Stop-hook fan-outs). Both modifications applied. Turn 2 cleared verbatim "**Zero remaining findings on the Issue #13 fix. Ship as is. Ready to tag v0.10.5.**" Turn 2 also independently verified the skill-forge mirror byte-identical via `cmp -s` on all four changed files.

Test coverage: 3 new tests in `tests/integration/store-concurrent-init.test.ts` (NEW) + supporting `tests/helpers/concurrent-init-worker.ts` (NEW). Two source-text assertion gates (deterministic — catch the exact regression an accidental re-swap would introduce, anchored on the function body for `initializeDatabase` and on the `// Readonly:` comment marker for the readonly branch) plus one subprocess concurrent-init test (spawns 3 `bun run` worker processes against the same on-disk DB in `mkdtempSync(tmpdir())`, 60s timeout, asserts all 3 exit 0 without `SQLITE_BUSY` or "database is locked" in stderr).

The subprocess test mirrors the actual production scenario more faithfully than an in-process `Promise.all` could — `bun:sqlite` `db.exec` is synchronous, so in-process "concurrent" calls serialize on the JS event loop and do not contend on the SQLite file lock. `:memory:` stores have no file-system lock at all and cannot reproduce this bug — that's why the pre-existing `tests/integration/store.test.ts` (which uses `:memory:` exclusively) missed the regression.

Local run: `bun test tests/integration/store-concurrent-init.test.ts` reports 3 pass / 0 fail (18 expect() calls, 3.01s). `bun test tests/integration/store.test.ts` reports 33 pass / 0 fail (57 expect() calls, 496ms). No regressions.

### Companion housekeeping — `src/openclaw/index.ts` doc-comment line-ref bump

Bundled with the v0.10.5 ship is a doc-only update to `src/openclaw/index.ts` carrying line-ref drift from the OpenClaw upstream-delta survey run on 2026-05-14 (`upstream-delta-survey` skill, main HEAD `5bb23c2f95` → `25eef1203a`, 7091 commits in that window, non-breaking for ClawMem v0.10.x). Four doc-comment occurrences updated:

- `attempt.ts:2610` → `attempt.ts:2973` — `before_prompt_build` await site (twice: backtick docstring at `:41`, inline comment at `:164`)
- `attempt.ts:3379-3402` → `attempt.ts:3870-3892` — `agent_end` fire-and-forget block (twice: backtick docstring at `:40`, inline comment at `:178`)

No runtime change. Standing "doc-line-refs ride the next release" pattern from prior cycles.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration shape (`kind: memory`), and Hermes plugin contract are all unchanged from v0.10.4.
- §14.3 contextEngine→memory migration block in `CLAUDE.md` / `AGENTS.md` preserved verbatim.
- No public API change; no config change; no env-var change; no schema migration.
- The terminal `PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}` at the bottom of `createStore()` is preserved — for the writable branch it resets 15000 → 5000 after DDL; for the readonly branch it's a no-op rewrite to the same value (harmless, intentional simplicity).

### Cross-references

- Issue: https://github.com/yoloshii/ClawMem/issues/13 (@jcgau, first-time contributor)
- Codex review: Turn 1 APPROVED WITH MODIFICATIONS, Turn 2 zero remaining findings
- Parallel Stop-hook fan-out sites covered by this fix: `src/openclaw/engine.ts:449` (`handleAgentEnd`), `src/openclaw/engine.ts:576` (`handleBeforeReset`), `src/hermes/__init__.py:518` (Python thread fan-out)
- Companion 2026-05-14 OpenClaw upstream-survey driving the doc-comment line-ref bump: a local memory note (`memory/openclaw-v2026.4.x-analysis.md`)

---

## v0.10.4 — Profile-aware `setup openclaw` + `--help` short-circuit (issue #11)

v0.10.4 fixes [yoloshii/ClawMem#11](https://github.com/yoloshii/ClawMem/issues/11). Two bugs reported by @elquercarlos:

1. **`clawmem setup openclaw` ignored `OPENCLAW_STATE_DIR` and OpenClaw's `--profile` flag.** Pre-v0.10.4 hardcoded `~/.openclaw/extensions/clawmem` and never consulted env vars or OpenClaw's own destination-resolution logic. Users running OpenClaw with a non-default profile (e.g. `~/.openclaw-dev`) got the plugin installed in the wrong directory, where their active profile couldn't see it.
2. **`clawmem setup openclaw --help` ran setup instead of printing help.** The handler had no argv short-circuit for `--help` / `-h`.

Both bugs close on this release. Vault on disk is byte-identical to v0.10.3. No schema changes, no env-var changes for default-profile users, no retrieval-pipeline or hook changes. Pure `bun update -g clawmem` upgrade.

### `cmdSetupOpenClaw` — three-path install (§28.1)

The setup command now picks one of three paths at runtime:

- **Delegated copy mode (default, OpenClaw CLI on `PATH`).** Spawns `openclaw plugins install <pluginDir> --force`. OpenClaw owns destination resolution (which respects `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and the `--profile` flag), runs manifest validation + security scans, persists install records, applies slot selection, and refreshes the registry. The plugin is **auto-enabled** by the install — the post-install "Next steps" output no longer prints `openclaw plugins enable clawmem`. `--force` makes the install idempotent across re-runs (OpenClaw's default install mode rejects existing targets).
- **Delegated link mode (`--link` flag, OpenClaw CLI on `PATH`).** Spawns `openclaw plugins install <pluginDir> -l`, which records the source in `plugins.load.paths` — a load-path entry, **not a filesystem symlink**. Discovery uses the recorded load-path entry directly, so the v2026.4.11 symlink-discovery skip does NOT apply here. ClawMem does manual stale-install cleanup before delegating because OpenClaw rejects `--force` with `--link`.
- **Direct-copy fallback (CLI absent).** Falls back to recursive `cpSync` (or filesystem symlink with `--link`) at a destination resolved by a faithful mirror of OpenClaw's `resolveConfigDir`: `OPENCLAW_STATE_DIR` → `OPENCLAW_CONFIG_PATH` (config root = `dirname(file)`) → `OPENCLAW_HOME`/`HOME`/`USERPROFILE`/`os.homedir()`/`cwd` → `~/.openclaw`. The user gets a warning surfacing reduced capability (no manifest validation, no security scan, no install records). Filesystem symlink in the fallback's `--link` path is still subject to OpenClaw v2026.4.11+'s discovery skip — install OpenClaw to get the cleaner delegated behavior.

The faithful-mirror resolver matches OpenClaw exactly, including the asymmetry where `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` apply only `.trim()` (so `OPENCLAW_STATE_DIR="undefined"` is a literal directory name) while home-resolution env vars filter the literal strings `"undefined"` / `"null"` (matching OpenClaw's `home-dir.ts:normalize`). Diverging here would mean the delegated path and the fallback path install into different locations for the same env, which is exactly the bug class §28.1 set out to fix.

### `--remove` — legacy-compatible uninstall

`clawmem setup openclaw --remove` now tries `openclaw plugins uninstall clawmem --force` first (when the CLI is available) and falls back to manual cleanup at the resolved extensions path. The fallback runs in two cases:

1. CLI uninstall fails (typically because the install was a legacy unmanaged direct-copy from pre-v0.10.4 ClawMem and isn't tracked in OpenClaw's plugin install records). On failure, ClawMem **warns the user** that OpenClaw config and install records may still need manual repair, then runs the manual cleanup. We do not silently mask managed-uninstall failures.
2. CLI uninstall succeeds (managed install). Even on success, ClawMem then checks the exact `extensions/clawmem` path and removes any remaining symlink or directory — a "constrained stale cleanup" that handles the side-by-side case of a managed-link install plus a leftover unmanaged-copy directory from an earlier ClawMem version.

### `--help` / `-h` short-circuit (§28.2)

`cmdSetupOpenClaw` short-circuits `--help` / `-h` at the top of the handler before any spawn or filesystem work and prints the full flag + env-var reference. Documents: `--link` (with separate behavior in delegated load-path mode vs filesystem-symlink fallback), `--remove`, env vars consulted (`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`, `HOME`, `USERPROFILE`), and example invocations including the headline `OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw`.

### Verification

The change set was validated against four turns of GPT-5.5 high-reasoning adversarial code review (cumulative ~292K tokens) under `codex exec`. All findings — three HIGH (delegated-install auto-enable messaging, idempotence-via-`--force`, legacy-compatible `--remove`), two MEDIUM (resolver fidelity, real-stub-binary integration tests), two LOW (assertion tightening, main `--help` line) — were addressed before final clearance. The Turn 4 verdict was an explicit "zero remaining concerns, ready to ship v0.10.4."

Test coverage: 8 unit tests (`tests/unit/openclaw-paths.test.ts`) on the resolver helpers, including precedence (`OPENCLAW_STATE_DIR` over `OPENCLAW_CONFIG_PATH`), tilde expansion, `OPENCLAW_HOME` priority, `os.homedir()` failure → cwd fallback, and the asymmetric `"undefined"` / `"null"` literal handling that mirrors OpenClaw exactly. 6 integration tests (`tests/integration/setup-openclaw.integration.test.ts`) exercise the real subprocess boundary via a per-command shell stub on a sandboxed `PATH`: copy mode passes `--force` and not `-l`; link mode passes `-l` and not `--force`; install failure aborts (no silent fallback to direct copy); `--remove` with a managed install runs CLI uninstall AND constrained stale cleanup; `--remove` with a legacy install falls back to manual cleanup with the user-visible warning; CLI absent honors `OPENCLAW_STATE_DIR` in direct-copy mode. Two further integration tests prove the dual next-steps messaging differs between paths and that `--help` short-circuits before the `openclaw --version` probe.

### What didn't change

- Retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration shape (`kind: memory`), and Hermes plugin contract are all unchanged.
- The §14.3 contextEngine→memory upgrade migration block is preserved verbatim.
- Plugin source files (`src/openclaw/`) are unchanged. The change is entirely in `cmdSetupOpenClaw` and a new `src/openclaw-paths.ts` helper module.
- Existing regression-gate tests in `tests/unit/openclaw-plugin.test.ts` (84 source-text assertions) all still pass — the Path 3 fallback branch preserves the original next-steps output verbatim.

### Cross-references

- Issue: https://github.com/yoloshii/ClawMem/issues/11 (@elquercarlos)
- BACKLOG: `BACKLOG.md` Source 28 — full scope including the codex-validated implementation plan
- OpenClaw delegation surfaces: `openclaw/src/cli/plugins-install-command.ts:669` (linked-path branch), `openclaw/src/cli/plugins-install-persist.ts:182` (auto-enable + slot selection), `openclaw/src/utils.ts:119` (`resolveConfigDir`)
- Helper module: `src/openclaw-paths.ts` (mirrors OpenClaw's path-resolution semantics for the fallback path)

---

## v0.10.3 — A-MEM parser hardening for noisy llama-server output (PR #7) + batched doc maintenance

v0.10.3 is a small patch release. The retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, OpenClaw plugin registration shape, and Hermes plugin contract are all unchanged from v0.10.2. The release hardens the A-MEM JSON parser against a class of noisy llama-server outputs that v0.10.2 mishandled (parser silently picked an example/schema literal over the real payload, link-generation batches got zeroed when the LLM under-delivered), and bundles four sitting-in-tree doc updates that were waiting for the next release.

Vaults from v0.10.2 are byte-identical at rest. No schema migration. **Default behavior is byte-identical for users whose llama-server outputs were already parsing cleanly** — the parser only changes what it returns on inputs that previously fell through to repair paths or to zeroed link batches. Pure `bun add -g clawmem` upgrade.

### A-MEM parser hardening (PR #7 by @cymkd / Veljko Simakovic)

The pre-PR parser had two real-world failure modes when the llama-server LLM emitted prompt-shaped prose alongside the real payload:

1. **Prose-balanced literal won over the real payload.** When the model echoed phrases like `Return empty array [] if no structured facts found.` before the real fenced JSON answer, the parser locked onto the prose `[]` and returned it as the result. Conversation-synthesis runs that included the actual prompt wording in the assistant context exhibited this regularly. After the fix, the later real payload wins via a precedence order that walks all parseable balanced JSON candidates in source order, prefers payload-cued candidates (`Actual:`, `Result:`, `Final answer:`, `Answer:`), then avoids example-cued (`example`, `e.g.`, `schema`) and inline-prose literals, then falls back to the first candidate. `parseJsonCandidate` now searches forward for a later line-start `[`/`{` when the first balanced candidate sits behind an example cue or at a non-line-start position with no payload cue. `extractJsonFromLLM` tightens its precedence so that outside-of-fences JSON before a preferred `json` fence requires a payload cue rather than winning by virtue of position.
2. **Link-generation under-delivery zeroed the batch.** The pre-PR `generateMemoryLinks` enforced an all-or-nothing completeness gate: if the LLM returned 4 valid links for a 5-neighbor prompt, or repeated a `target_idx`, or referenced an out-of-range index, the entire batch was discarded and `0` links were created. After the fix, partial-valid insertion semantics are restored: a 5-neighbor prompt with 4 valid returned links inserts 4 rows. Duplicate `target_idx` entries are logged (`Skipping duplicate link target N`) and skipped after the first valid link for that neighbor. Out-of-range entries are logged (`Skipping out-of-range link target N`) and skipped instead of aborting already-valid links. The commit message includes the directive "Do not reintroduce all-or-nothing link generation without corpus measurements" to lock the contract.

Item-shape validation in `parseLinkGenerationFromLLM` (`src/amem.ts:55,99`) is unchanged and continues to reject malformed items strictly (missing fields, wrong types, non-finite confidence, bad relation type, non-positive/non-integer `target_idx`) before they reach the insert loop.

The PR went through three adversarial review rounds: Turn 1 surfaced 3 findings (1 HIGH on the prose-precedence behavior + 2 Medium on the under-delivery zeroing path and a sanitization edge), Turn 2 confirmed Findings 2-3 fixed and surfaced 1 HIGH on a regressed prose-fence ordering case + 1 MEDIUM on an un-flagged completeness gate that wasn't parser-level. Turn 3 verified both Turn 2 findings fixed (cymkd ran an independent GPT-5.5 high-reasoning pass before pushing the Turn 2 follow-up commit) and surfaced 2 LOW findings deferred to a future release (see below).

### Two known LOW limitations deferred to v0.10.4+

Both LOWs were surfaced by the Turn 3 GPT-5.5 high-reasoning review pass and are explicit-acceptance candidates per the contributor's own "intentionally broad for this repro; can be tightened later" framing:

1. **Outside-JSON-before-`json`-fence precedence change.** The new `outsidePrecedesPreferredJsonFence` gate causes raw line-start JSON before a non-example `json` fence to lose to the fence. Repro: `[{"key":"real"}]\n` followed by a `json` fence containing `[]` parses as `[]`. Real behavior change from "first raw JSON wins," but the affected pattern is narrow — well-formed raw payload immediately followed by a non-example `json` fence is uncommon in observed llama-server output, and the broader fix the gate enables (the prose-before-fence repro above) is the more frequent failure mode.
2. **`schema` cue breadth.** `hasExampleCueBefore` recognizes `schema` alongside `example` and `e.g.` to fix the reported `Schema: {...}\n[{...real...}]` repro, but the substring match is broad enough to suppress real fenced payloads following phrases like `Schema validation result:`. A tighter `schema:` / `json schema:` boundary regex would close the false-positive without losing the original repro coverage.

Both will be addressed in the next release with measurement-backed fixes — either tightening the heuristics with a corpus-measurement pass over real llama-server output, or accepting them with regression tests locking in the new contract. That decision belongs with the data, not this PR.

### Batched doc maintenance (rides this release per option-(a) standing direction)

Four user-facing doc updates that accumulated in the working tree across the v0.10.2 → v0.10.3 window, all from in-session OpenClaw delta surveys:

- **`src/openclaw/index.ts` line-ref drift** (cosmetic, no behavior change). OpenClaw advanced from v2026.4.21 to HEAD `1f724bc50b` (2026-05-04, post-v2026.4.26 untagged) across two consecutive surveys. `attempt.ts` was reorganized under `src/agents/pi-embedded-runner/run/` as part of a runner refactor; line refs in our doc-comment correctness contracts shifted twice: `before_prompt_build` await context `attempt.ts:1873` → `:2294` → `:2610`; `agent_end` fire-and-forget block `attempt.ts:2470-2496` → `:3023-3048` → `:3379-3402`. Both await/fire-and-forget contracts hold across both bumps; only line numbers shifted. 4 occurrences updated in the file header docstring and the `before_prompt_build` / `agent_end` handler comments.
- **`README.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md` — 30s `agent_end` void-hook timeout disclosure.** OpenClaw v2026.4.26 (commit `4d4c7c8ab3`) introduced `DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK = { agent_end: 30_000 }` in `src/plugins/hooks.ts`. A timed-out handler is logged ("timed out after 30000ms") and the runner continues, but the plugin's underlying work is not cancelled. ClawMem's `agent_end` runs decision-extractor + handoff-generator + feedback-loop; warm-cache postrun is well under 30s, but cold-start indexing or LLM stalls could approach this. The disclosure is operational, not behavioral — it doesn't change what ClawMem does, only adds a log warning above the 30s threshold for users with cold-start scenarios that exceed it. Single-sentence insertion in each doc, adapted to surrounding tone, fail-open framing emphasized. CLAUDE.md and AGENTS.md remain byte-identical post-edit.

Per the option-(a) standing direction these doc updates do not justify a release on their own; they ride PR #7 which is the next real-functionality release.

### External credit

- **Veljko Simakovic / @cymkd** — opened yoloshii/ClawMem#7 with the four-commit progressive parser hardening (initial parse robustness, object-wrapped result handling, prose-vs-payload preservation, and the Turn 2 follow-up that fixed the regressed prose-fence ordering and removed the un-flagged completeness gate). The PR went through three adversarial review rounds (gpt-5.4 high reasoning Turns 1-2, gpt-5.5 high reasoning Turn 3); the contributor independently ran a gpt-5.5 high-reasoning pass on his own diff before pushing the Turn 2 follow-up, which surfaced and fixed several edge cases before they hit our review queue. Cross-validated against `tests/unit/amem.test.ts` + `tests/unit/conversation-synthesis.test.ts` + `tests/integration/conversation-synthesis-two-pass.integration.test.ts` (107 pass / 0 fail / 220 expect() calls, was 102 pre-PR; +5 new regression tests). Two Turn 3 LOW findings were explicitly deferred to the next release rather than chasing a fifth round, in line with cymkd's own forward-looking framing on the schema cue breadth.

### Test coverage

PR #7 adds five new regression tests in `tests/unit/amem.test.ts` covering: prose `[]` before a fenced real payload, the actual conversation-synthesis prompt wording echoed before a fenced payload, prose schema object before a later real raw array, `parseLinkGenerationFromLLM` parsing the later real link array instead of the schema object, and `generateMemoryLinks` inserting a valid partial batch while skipping duplicate/out-of-range targets.

Targeted suite: **107 pass / 0 fail / 220 expect() calls** across the three test files (was 102 pre-PR; +5 new tests).

---

## v0.10.2 — Configurable remote LLM endpoints + doc maintenance

v0.10.2 is a small patch release. The retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, and OpenClaw plugin registration shape are all unchanged from v0.10.0/v0.10.1. The release adds three opt-in env vars for users running ClawMem against OpenAI-compatible remote LLM proxies, fixes a `/v1` URL-doubling edge case in the remote LLM transport, and applies two small doc updates that were sitting in the working tree.

Vaults from v0.10.1 are byte-identical at rest. No schema migration. **Default behavior is byte-identical for users with no new env vars set** — same hard-coded `qwen3` model, same `/no_think` suffix, same request body field order, same `http://localhost:8089/v1/chat/completions` URL. Pure `git pull` upgrade.

### Configurable remote LLM endpoints (PR #8 by @DrJsPBs)

The remote LLM transport in `src/llm.ts` previously hard-coded `model: "qwen3"` and the `/no_think` prompt suffix in the `/v1/chat/completions` request body. That worked for the QMD native combo (qmd-query-expansion-1.7B on `:8089` via `llama-server`) but blocked anyone wanting to point ClawMem at an OpenAI-compatible proxy with a different model name or at a non-Qwen endpoint that treats `/no_think` as literal prompt text. v0.10.2 adds three opt-in env vars to make all three knobs user-configurable while preserving the existing defaults exactly:

| Env var | Default | Effect |
|---|---|---|
| `CLAWMEM_LLM_MODEL` | `qwen3` | Model name sent in the request body. Override for OpenAI-compatible proxies (e.g. `gpt-5.4-mini`). |
| `CLAWMEM_LLM_REASONING_EFFORT` | (unset, field omitted) | Optional top-level `reasoning_effort` field for Chat Completions endpoints that support it. Validated against the enum `none / minimal / low / medium / high / xhigh`; unsupported values log a warning and are ignored. Leave unset for llama-server / vLLM unless your serving stack explicitly accepts the field. |
| `CLAWMEM_LLM_NO_THINK` | `true` | Append `/no_think` to remote prompts. Set `false` for standard OpenAI models and other endpoints that reject or treat the Qwen-style suffix as literal prompt text. |

The settings are threaded through both plugin layers:

- **OpenClaw plugin** — `src/openclaw/openclaw.plugin.json` exposes `gpuLlmModel`, `gpuLlmReasoningEffort` (with the same enum constraint), and `gpuLlmNoThink` config keys. `src/openclaw/index.ts` maps each to the corresponding `CLAWMEM_LLM_*` env var only when the user explicitly set it (so unset config falls through to the runtime default rather than overriding it with an empty string).
- **Hermes plugin** — `src/hermes/__init__.py` adds the three keys to its `get_config_schema()` (all `secret: False`) and to the env-passthrough tuple in `initialize()`. The module docstring lists them alongside the existing `CLAWMEM_LLM_URL`.

#### `/v1` URL doubling fix

The pre-PR transport posted to `${remoteLlmUrl}/v1/chat/completions` unconditionally. If a user set `CLAWMEM_LLM_URL=https://api.example.com/v1` (a common shape for OpenAI-compatible proxies that document their base URL with `/v1` already included), the request went to `https://api.example.com/v1/v1/chat/completions` and 404'd. v0.10.2 introduces `buildRemoteChatCompletionsUrl()` which strips trailing slashes, detects an existing `/v1` suffix, and only appends `/chat/completions` in that case. All four shapes now resolve correctly: `http://host`, `http://host/`, `http://host/v1`, `http://host/v1/`.

#### Validation centralization

`normalizeRemoteLlmReasoningEffort()` is now the single normalization point for the reasoning-effort value. Previously the env-bootstrap path did its own `.trim().toLowerCase() + Set check` and the constructor did nothing — so a direct caller passing `LlamaCpp({remoteLlmReasoningEffort: "  HIGH  "})` would have posted `"reasoning_effort":"  HIGH  "` to the endpoint while the env path correctly normalized it to `"high"`. The constructor now calls the helper for both paths, so env and direct config behave identically. `CLAWMEM_LLM_MODEL` is also trimmed at both surfaces (defense-in-depth — whitespace-padded values from `.env`-style configs no longer post `"model":" gpt-5.4-mini "`).

### Doc maintenance

Two small doc changes that were sitting in the working tree from the v2026.4.18 / v2026.4.16-920 changelog surveys ride this release:

- **`docs/guides/hermes-plugin.md`** — preventive warning added to the Install section: do NOT add `clawmem` to `plugins.enabled` in `~/.hermes/config.yaml`. Hermes #11xxx onwards made all general plugins opt-in by default; `plugins.enabled` is the general-plugin opt-in roster, not the memory-provider activation channel. Memory providers are activated via `memory.provider: clawmem`, completely separate from the general plugin loader. Adding `clawmem` to `plugins.enabled` would cause the general loader to import it as a `kind: standalone` plugin and call `register(ctx)` against the general `PluginContext` — which doesn't expose `register_memory_provider`, so the import errors and a warning gets logged. Harmless but noisy. The warning heads off the easy mistake for users reading the install path docs literally and conflating the two settings.
- **`src/openclaw/index.ts`** — cosmetic line-ref drift fix in the file-header docstring and correctness-contract comments. OpenClaw's `before_prompt_build` is still awaited at `attempt.ts:1873` (was `:1642` at v2026.4.18 cutoff); `agent_end` is still fire-and-forget at `attempt.ts:2470-2496` (was `:2198-2224`). No semantic change — the await/fire-and-forget contracts hold; only the line numbers in our reference comments shifted.

### External credit

- **@DrJsPBs / @DrJLabs** — opened yoloshii/ClawMem#8 with the configurable remote LLM env vars, the OpenClaw + Hermes plumbing, the `/v1` URL doubling fix, the validation centralization, and 5 new contract tests covering whitespace handling, URL normalization, env-vs-direct config consistency, and the byte-identical default-preservation contract. The PR went through two adversarial review rounds (gpt-5.4 high reasoning each side); the contributor independently identified and folded in fork-review extras (the `/v1` fix being the standout) within the same PR scope. Cross-validated in their downstream `DrJLabs/ClawMem` fork before opening upstream — exactly the integration discipline the v0.7.x community-contributor track has been rewarding.

### Test coverage

PR #8 adds three new test files:

- `tests/unit/llm-remote-config.test.ts` (new) — the contract tests for the new env vars and the `/v1` URL builder
- `tests/unit/hermes-plugin.test.ts` (new) — covers the schema additions
- `tests/unit/openclaw-plugin.test.ts` extended — covers the env-mapping consistency

Targeted suite: **97 pass / 0 fail / 171 expect() calls** across the three files (was 92 pre-PR; +5 new tests).

---

## v0.10.1 — Hermes agent_context isolation + OpenClaw v2026.4.18 / Hermes v2026.4.16+ doc maintenance

v0.10.1 is a small patch release. The retrieval pipeline, composite scoring, vault format, hook set, agent tool surface, and OpenClaw plugin registration shape are all unchanged from v0.10.0. The release covers two upstream changelog reviews against the OpenClaw and Hermes runtimes ClawMem integrates with — neither produced any breaking changes — plus one correctness fix in the Hermes plugin and a small set of doc updates that keep the public-facing surfaces aligned with the runtimes users are actually running.

Vaults from v0.10.0 are byte-identical at rest. No schema migration, no new env vars, no new dependencies. Pure `git pull` upgrade for Claude Code users; `clawmem setup openclaw` re-run is optional (no plugin code changes that affect runtime behavior); Hermes users on a non-primary `agent_context` (subagent, cron, flush) get a quiet correctness improvement.

### Hermes Agent — `agent_context` isolation in `src/hermes/__init__.py`

Hermes's `MemoryProvider` ABC docstring is explicit: *"Providers should skip writes for non-primary contexts (cron system prompts would corrupt user representations)."* Hermes's `run_agent.py` passes an `agent_context` kwarg to every `MemoryProvider.initialize()` call with one of `"primary"`, `"subagent"`, `"cron"`, or `"flush"`. Pre-v0.10.1 the ClawMem plugin absorbed the kwarg via `**kwargs` and ran the full lifecycle for every context — including writing transcript turns and running decision-extractor / handoff-generator / feedback-loop / precompact-extract on cron and subagent passes. The vault's `saveMemory` dedup limited the blast radius, but the cleaner answer is the one the ABC asks for.

v0.10.1 honours the contract. The plugin now reads `agent_context` in `initialize()` and gates only the **write-side** surfaces; the **read-side** surfaces still run for every context so non-primary agents continue to benefit from retrieval:

| Surface | Direction | `agent_context != "primary"` |
|---|---|---|
| `session-bootstrap` (in `initialize`) | Read | Runs |
| `prefetch()` / `queue_prefetch()` (`context-surfacing`) | Read | Runs |
| `system_prompt_block()` | Read | Runs |
| Agent tools (REST: `clawmem_retrieve` etc.) | Read | Runs |
| `sync_turn()` (transcript append) | Write | **Suppressed** |
| `on_session_end()` (extraction trio) | Write | **Suppressed** |
| `on_pre_compress()` (precompact-extract) | Write | **Suppressed** |

When the active context is non-primary, `initialize()` logs a single info-level line for operator visibility:

```
clawmem: agent_context=cron — reads enabled, writes suppressed
```

Net effect: subagents and cron agents read the vault as before; they no longer write back into it. For installs that run only `agent_context="primary"` (the default for interactive CLI / Telegram / Discord platforms), behavior is unchanged.

### Hermes Agent — preferred install path now `$HERMES_HOME/plugins/clawmem/`

Hermes #10529 (in v2026.4.13+) added user-plugin discovery: `plugins/memory/__init__.py` now scans `$HERMES_HOME/plugins/<name>/` in addition to the bundled `hermes-agent/plugins/memory/<name>/`. Both paths still work; the user-plugin path is preferred because it survives `git pull` of hermes-agent and avoids the dual-registration trap that previously caused duplicate tool names with strict providers. Discovery heuristic = grep `__init__.py` for `register_memory_provider` or `MemoryProvider`; both already present in `src/hermes/__init__.py`. `README.md` Install + Setup blocks, `docs/guides/hermes-plugin.md`, `CLAUDE.md`, `AGENTS.md`, and `SKILL.md` now lead with the user-plugin path and document the bundled path as a still-supported alternative.

### OpenClaw v2026.4.18 — three relevant changes (all compatible)

A v2026.4.11 → v2026.4.18 changelog survey (1,794 commits) ran against ClawMem v0.10.0's plugin. Verdict: no breaking changes. Three changes touch surfaces ClawMem consumes; all are documented in this release:

- **Synchronous `register()` enforcement (`2a283e87a7`, in `v2026.4.19-beta.1`).** OpenClaw now throws `"plugin register must be synchronous"` if a plugin's `register()` returns a Promise. ClawMem's `register(api)` in `src/openclaw/index.ts` is and always has been synchronous (no `async`, no top-level `await`, returns void) — every `await` lives inside per-event handlers, never in registration itself. Companion change: register failures now atomically roll back side effects, so any future throw inside `register()` will leave OpenClaw in a clean state. The constraint is now documented as a load-bearing invariant in `CLAUDE.md` / `AGENTS.md`.
- **`memory-core` dreaming sidecar coexistence (`5fde14b844`, #65411, in v2026.4.18).** When ClawMem owns the `memory` slot AND `plugins.entries.memory-core.config.dreaming.enabled = true`, OpenClaw now loads `memory-core`'s dreaming engine alongside ClawMem instead of unloading it entirely. Two valid configurations: ClawMem-only (default after `openclaw plugins enable clawmem`, with `dreaming.enabled = false`) or ClawMem + dreaming sidecar (opt-in, set `dreaming.enabled = true`). Documented in `docs/guides/openclaw-plugin.md` (new "Coexistence with memory-core dreaming sidecar" section), `README.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md`.
- **`attempt.ts` line drift.** OpenClaw's `before_prompt_build` is still awaited; `agent_end` is still fire-and-forget. Their line numbers shifted between v2026.4.11 and v2026.4.18 (`:1661 → :1642` and `:2226-2249 → :2198-2224`). The four references in `src/openclaw/index.ts` (file docstring + correctness-contract comments) were updated accordingly. No semantic change.

### `on_memory_write` deliberately not opted into

Hermes #10507 added an `on_memory_write` bridge to the sequential tool execution path; the commit message names ClawMem as a beneficiary. v0.10.1 deliberately stays opted out. ClawMem's filesystem watcher already indexes Hermes's `MEMORY.md` / `USER.md` if those files live under a configured collection — layering an `on_memory_write` shell-out on top duplicates filesystem watching and introduces a remove-semantics mismatch (a hook event saying "this entry was removed" cannot be cleanly translated into ClawMem's content-addressed vault). The `docs/guides/hermes-plugin.md` lifecycle table now documents this rationale instead of the prior "future" framing.

### v0.8.4 retroactive credit

`### External credit` subsection added to v0.8.4 in this file naming `@saschabuehrle` (Lemony.ai founder) for PR #6 (`fix/issue-5`). The PR was closed-as-superseded on 2026-04-11 because v0.8.4 ended up shipping the broader auto-install fix, but the gateway-restart-before-slot-assignment insight is preserved verbatim in v0.8.4's printed next-steps and the code comment that documents the constraint. Matches the v0.10.0 `### External credit` precedent set for `@withx`. The credit landed in the working tree before the v0.10.1 cut and rides this release.

### Test coverage

No new tests in v0.10.1 — the `agent_context` guard's behavior is observable only against a live Hermes runtime, and the rest of the release is documentation. Full v0.10.0 baseline holds: 1204 pass / 0 fail, 2339 expect() calls across 66 test files.

---

## v0.10.0 — OpenClaw Pure-Memory Migration (§14.3) + v2026.4.11 Packaging Fix

v0.10.0 is the OpenClaw pure-memory migration. ClawMem's OpenClaw plugin is no longer a `kind: context-engine` plugin wrapping a `ClawMemContextEngine` class. It is a `kind: memory` plugin that wires every lifecycle event (`before_prompt_build`, `agent_end`, `before_compaction`, `session_start`) through OpenClaw's plugin-hook bus directly. This matches the direction OpenClaw's own `context-engine` slot has taken since v2026.4.x (narrowed to runtime compaction) and moves ClawMem to the slot it was always logically targeting: the exclusive `memory` slot, alongside `memory-core` and `memory-lancedb` (which it automatically displaces when enabled).

### Why this matters — dual plugin surfaces across OpenClaw and Hermes

Over the last year, the OpenClaw and Hermes maintainers independently converged on the same architectural split: agent runtimes expose **two** distinct plugin surfaces, one for **memory** (persistent, cross-session, retrieval-first) and one for **context engines** (in-session, lossless or lossy compression, compaction-first). Hermes shipped its `MemoryProvider` ABC from the start, and ClawMem has always been plugged in there correctly — as a memory provider. OpenClaw's plugin kind vocabulary took longer to stabilize, with `context-engine` originally broad enough to accommodate both roles, then narrowing through v2026.4.x to what it is today: runtime compaction / compression specifically.

Under the stabilized definition, **ClawMem is a memory layer, not a context engine.** A memory layer maintains a durable index of prior sessions, decisions, and knowledge and serves them back into new conversations via retrieval. A context engine reshapes the live session window: compressing old turns, summarizing transcripts, handing off between models. These are different jobs on different time axes. Calling ClawMem a "context engine" was accurate for the ClawMem-as-OpenClaw-plugin wiring pre-v0.10.0 only because no other slot existed yet. Post-v0.10.0 it is misleading in both directions: it mislabels what ClawMem does, and it **blocks OpenClaw users from pairing ClawMem with a genuine context-engine plugin** (e.g. an LCM-compression plugin like `lossless-claw`) because the two would fight over the same slot.

On v0.10.0, OpenClaw users get the same composability Hermes users have had all along:

- **Memory slot:** `clawmem` — cross-session retrieval, knowledge graph, decision extraction, the 5 agent tools
- **Context-engine slot:** free for an LCM/compression plugin that runs inside the live session window (e.g. `lossless-claw`)

Both can be enabled at the same time. They do not overlap. The memory slot is about what you knew yesterday; the context-engine slot is about what fits in today's prompt. This is the end state the OpenClaw maintainers have been steering toward for several releases, and v0.10.0 is ClawMem moving to the seat that was prepared for it. For Hermes users nothing changes — ClawMem has always been correctly integrated as a memory provider there.

### What is unchanged

The retrieval pipeline, composite scoring, profiles, vault format, hook set, `<vault-context>` output, and the 5 registered agent tools are **unchanged**. No schema migration, no new env vars, no new dependencies. The vault on disk is byte-identical to v0.9.0. Claude Code users who do not run OpenClaw can upgrade with no action beyond `git pull`.

v0.10.0 also fixes a packaging bug that surfaced when OpenClaw shipped v2026.4.11. The new discovery path (`readdirSync({ withFileTypes: true })` + `dirent.isDirectory()`) started silently skipping ClawMem's symlinked plugin directory. Diagnosis, confirmation via an external user on yoloshii/ClawMem#5, and the complete fix (discovery manifest + copy-not-symlink install) are all in this release.

### §14.3 — Pure-memory plugin registration

- **Plugin kind changes from `context-engine` to `memory`.** The adapter in `src/openclaw/` registers as `kind: memory`. OpenClaw's exclusive `memory` slot now holds `clawmem` (via `openclaw plugins enable clawmem`, which also disables any competing memory plugin in the same step). The older `plugins.slots.contextEngine: "clawmem"` pattern no longer applies — v0.10.0 does not occupy that slot.
- **`ClawMemContextEngine` class removed.** Every lifecycle surface the plugin needs — prompt injection, post-turn extraction, pre-compaction state capture, session bootstrap — is now a plain `PluginHookName` handler on the plugin-hook bus. `before_prompt_build` is the **load-bearing** path: it runs prompt-aware retrieval (context-surfacing every turn + cached bootstrap context on first turn) AND runs `precompact-extract` synchronously when token usage approaches the compaction threshold, so state is captured before the LLM call that could trigger compaction on this turn (no race with the compactor). `agent_end` runs decision-extractor + handoff-generator + feedback-loop in parallel (fire-and-forget at OpenClaw's call site). `before_compaction` is a **defense-in-depth fallback only** — fire-and-forget, races the compactor, exists solely to catch the rare case where `before_prompt_build`'s proximity heuristic missed a sudden token-count jump; it forces the precompact regardless of proximity since by the time it runs compaction is already in motion. `session_start` registers the session and caches the bootstrap context for first-turn injection. This is a strict improvement over v0.3.0's shape, where the pre-emptive extraction happened inside `ContextEngine.compact()` via `delegateCompactionToRuntime()` — the v0.10.0 wiring moves the extraction up the stack into `before_prompt_build` where it has a real pre-LLM hook to await on.
- **Behavior is identical from the agent's point of view.** The `<vault-context>` block is byte-equivalent to v0.9.0 on the same vault with the same prompt. This is a packaging and registration change, not a behavioral one. The pure-memory shape is the architecturally correct home for what ClawMem has always done — the old `context-engine` shape was load-bearing on an OpenClaw version that narrowed out from under us.

### v2026.4.11 packaging fix (external report → yoloshii/ClawMem#5)

The packaging fix is co-resident with §14.3 because they are both in the same file and both required for v0.10.0 to run on the current OpenClaw release. The symptom was reported externally by @withx on a fresh install of OpenClaw v2026.4.11 + ClawMem — the plugin looked installed to every CLI command but never registered at runtime.

- **`src/openclaw/package.json` is the new discovery manifest.** OpenClaw v2026.4.11's `discoverInDirectory` reads `package.json` and checks for the `openclaw.extensions: ["./index.ts"]` field before descending into a candidate plugin directory. Pre-v0.10.0 ClawMem shipped `openclaw.plugin.json` as the only manifest. That file is still shipped and still parsed at runtime, but it is not enough on its own for discovery on v2026.4.11+ — the plugin directory is silently skipped. v0.10.0 adds `package.json` to the plugin source tree and `clawmem setup openclaw` now verifies it is present before copying.
- **`clawmem setup openclaw` defaults to recursive copy, not symlink.** OpenClaw v2026.4.11's discoverer walks the extensions directory with `readdirSync({ withFileTypes: true })` and uses `dirent.isDirectory()` to decide which entries to descend into. Symlinks to directories report `isDirectory() === false` on that API shape, so a symlinked plugin is silently skipped during discovery and never registers. Every ClawMem release since the OpenClaw plugin was introduced shipped a symlinked install — it worked on OpenClaw v2026.3.x but stopped working on v2026.4.11. `cmdSetupOpenClaw` now runs `cpSync(..., { recursive: true, dereference: true })` to install the plugin as a real directory. A new `--link` opt-in flag preserves the old symlink behavior for local dev workflows and for older OpenClaw versions, with a warning that v2026.4.11+ discovery will skip the symlink.
- **Next-steps output uses `openclaw plugins enable clawmem`.** The setup command now prints `openclaw plugins enable clawmem` instead of `openclaw config set plugins.slots.memory clawmem`. The `enable` verb pre-validates that the plugin is in the discovered registry (so it only runs on a successful copy), switches the exclusive `memory` slot, and disables the previous occupant (`memory-core`, `memory-lancedb`) in a single command. The older `config set` pattern failed silently on v2026.4.11 because the slot validator rejected a plugin id that had not been discovered first.
- **Multi-user ownership gotcha is documented.** OpenClaw v2026.4.11 enforces that plugin directories be owned by the current runtime user or root, rejecting foreign-owned directories with `suspicious ownership (uid=X, expected uid=Y or root)`. This is a security feature (it prevents a gateway running as a privileged system user from loading code a less-privileged user dropped into its extensions directory). On single-user installs where the gateway runs as your own user account, the ownership check passes automatically. On deployments where the gateway runs as a dedicated system user (e.g. `openclaw`) different from the installer user (e.g. `deploy-user`), you must `sudo chown -R <gateway-user>:<gateway-group> ~/.openclaw/extensions/clawmem` after running setup. Documented in `docs/guides/openclaw-plugin.md` Install section and `docs/troubleshooting.md` OpenClaw section.

### Test coverage

+2 regression gates on top of the v0.9.0 test baseline, locking in the v2026.4.11 packaging fix:

- `tests/unit/openclaw-plugin.test.ts::cmdSetupOpenClaw defaults to copy mode (v2026.4.11+ compat)` — asserts the `cpSync(pluginDir, linkPath, ...)` call exists in `cmdSetupOpenClaw` and the `--link` opt-in is parsed via `args.includes("--link")`. If a future edit flips the default back to symlink without also updating the assertion, the test fails loudly.
- `tests/unit/openclaw-plugin.test.ts::src/openclaw/package.json declares openclaw.extensions (v2026.4.11+ discovery gate)` — reads `src/openclaw/package.json`, asserts `type === "module"` and `openclaw.extensions` is an array containing `"./index.ts"`. If the manifest is ever deleted or reshaped without updating this test, the suite fails before the change reaches release.

Public test suite: **1105 → 1107, zero regressions.** The one pre-existing assertion in the `Shipping Condition 2 — setup-time migration text is present` suite was updated from `"plugins.slots.memory clawmem"` to `"openclaw plugins enable clawmem"` to match the new next-steps output shape.

### Multi-user end-to-end validation

Captured on a representative multi-user install (OpenClaw gateway runs as system user `openclaw`, ClawMem installed by a separate admin user):

```
[plugins] clawmem: plugin registered (kind=memory, bin=/home/<user>/clawmem/bin/clawmem, profile=balanced, budget=800)
[plugins] clawmem: registered 5 agent tools
[gateway] ready (7 plugins: acpx, browser, clawmem, device-pair, phone-control, talk-voice, telegram; 11.3s)
```

The runtime registration log line explicitly emits `kind=memory`, which is the §14.3 change proving the new registration path is live. The `clawmem` entry appears in the gateway ready line alongside the stock plugins, proving the packaging fix clears v2026.4.11's discovery gate. The multi-user ownership check (`suspicious ownership (uid=1001, expected uid=997 or root)`) reproduced and cleared after `sudo chown -R openclaw:openclaw ~/.openclaw/extensions/clawmem`, which is now a documented step in `docs/guides/openclaw-plugin.md` for multi-user deployments.

### Codex review

GPT 5.4 High, session `019d72d5` (continues the session chain used from v0.7.1 through v0.9.0, now cumulative across 20+ turns). The §14.3 implementation reached zero remaining findings before the v2026.4.11 packaging gap was discovered. Codex was re-engaged with the packaging compat delta (new `package.json`, copy-default `cmdSetupOpenClaw`, next-steps rewrite, +2 regression gates, multi-user e2e evidence) for a final pre-ship pass, same session.

### External credit

- **@withx** — reported the OpenClaw v2026.4.11 incompatibility on yoloshii/ClawMem#5 and confirmed the runtime symptom on a fresh install that did not share any state with the development machines. The external reproduction is what made it clear this was a clean packaging gap, not a machine-specific config drift.

### Upgrading from v0.9.0

v0.10.0 is **drop-in safe for Claude Code users**: `cd ~/clawmem && git pull && systemctl --user restart clawmem-watcher.service`. Nothing on the retrieval path changed.

**OpenClaw users** must also re-run `clawmem setup openclaw` (to switch the extensions dir from symlink to recursive copy), chown the new directory to the gateway user on multi-user installs, and restart the gateway. The full step-by-step is in [docs/guides/upgrading.md](docs/guides/upgrading.md#v090--v0100). **Upgrade OpenClaw to v2026.4.11+ first** — v0.10.0's setup and discovery behavior depend on v2026.4.11's new plugin discovery contract.

---

## v0.9.0 — `<vault-facts>` KG Injection + Session-Scoped Focus Topic Boost

Two context-surfacing upgrades. §11.1 adds a `<vault-facts>` SPO-triple injection block inside `<vault-context>` so the model gets structured "what is currently true about the entities in this prompt" alongside the existing `<facts>` (surfaced documents) and `<relationships>` (memory-graph edges) blocks. §11.4 adds a per-session topic steering lever (`clawmem focus set "<topic>" --session-id <id>`) that biases retrieval toward a declared topic for the duration of a working session without mutating any persisted state. Both changes live exclusively on the read path and are fail-open — the baseline pre-v0.9.0 `<vault-context>` shape is byte-identical when the new stages don't fire, and every downstream stage (threshold, diversification, token budget, injection) is unchanged. v0.8.5 was the last feature release; v0.9.0 is **drop-in safe**: one idempotent expression-index migration, no breaking API changes, no required reindex/embed, no schema rewrites.

### §11.1 — `<vault-facts>` knowledge-graph injection

- **Three-path prompt-only entity extraction** — the seed set for `<vault-facts>` comes from the raw prompt ONLY, via three independent paths: (a) a canonical `vault:type:slug` regex (e.g. `default:project:clawmem`), (b) proper-noun extraction validated via exact-match `resolveEntityTypeExact` that skips ambiguous names resolving to multiple types, and (c) a longer-first n-gram scan (3-gram > 2-gram > 1-gram, cased + lowercased) for technical vocabulary like `vector-store`, `oauth2`, `gpu node`. Prompt-only is a HARD CONSTRAINT — entity seeds never come from `surfacedDocs[i].body` or any retrieval-phase field, so a topic-boosted off-topic doc from §11.4 cannot pollute the facts block with facts about unrelated entities.
- **Validate-then-count candidate ordering (Codex §11.1 Turn 5 invariant)** — per-path, candidates are validated against the entity index BEFORE counting against the 100-candidate cap. Without this ordering, a long prompt dominated by unvalidated capitalized noise (path b raw extraction) would starve the lowercase/hyphenated n-gram lane (path c) and the technical-vocabulary recall would silently drop. The cap also preserves prompt order as a tiebreaker so the first mentioned entities win under pressure.
- **Cross-path entity-id dedup + longer-n-gram tie-breaker** — if the same entity resolves via multiple paths (e.g. "ClawMem" as a proper noun AND "clawmem" as a 1-gram), the cross-path dedup collapses it to one `entity_id` and the sourcePath from the first-matching path wins. For n-gram ties, longer n-grams outrank shorter ones (`vector-store` as a 1-gram compound beats `vector` + `store` as separate tokens).
- **Cross-entity triple dedup (Codex §11.1 Turn 1 fix)** — when both endpoints of a triple are seeded from the prompt (e.g. the prompt mentions both `ClawMem` and `Bun`, and the graph has `ClawMem depends_on Bun`), `store.queryEntityTriples` returns the triple from both sides (outgoing from ClawMem, incoming to Bun). `buildVaultFactsBlock` now dedupes by a stable `${subject}\u0000${predicate}\u0000${object}` key before budgeting so the same fact isn't emitted twice and budget isn't spent twice. Per-entity `maxTriplesPerEntity` cap still applies BEFORE dedup (anti-monopoly is enforced per entity first, then dedup collapses cross-entity duplicates).
- **Profile-gated `factsTokens` sub-budget** — a new `ProfileConfig.factsTokens` field gives `<vault-facts>` a dedicated token allowance that cannot steal from the existing `<facts>` / `<relationships>` budget. `speed`=0 disables the stage entirely (zero overhead on the fast profile). `balanced`=200 tokens (~50 triples at default 4-char/token estimate). `deep`=250 tokens. Truncation always at the triple boundary, never mid-triple, never emits an empty block. If `OVERHEAD >= budgetTokens` the block is dropped — established blocks take priority.
- **Schema migration — `idx_entity_nodes_lower_name`** — `store.ts` adds `CREATE INDEX IF NOT EXISTS idx_entity_nodes_lower_name ON entity_nodes(LOWER(name), vault)` on first open. This expression index backs the new `batchLookupNames` query (`WHERE LOWER(name) IN (...) AND vault = ?`) which would otherwise degenerate to a full scan on large vaults. Idempotent, runs once, harmless if the binary is later rolled back to v0.8.5 (SQLite ignores the unused index).
- **Fail-open at every stage** — empty entity set → skip the stage (caller gets unchanged `vaultInner`). Per-entity `queryTriples` throw → skip that entity and continue. Budget too small for even one triple → drop the whole block. Any exception inside the `if (profile.factsTokens > 0) { try { ... } catch {} }` wrapper → degraded vault behaves identically to pre-§11.1. The baseline `<vault-context>` is always recoverable.

### §11.4 — Session-scoped focus topic boost

- **`clawmem focus set / show / clear` CLI** — three new subcommands write/read/delete a per-session focus file at `~/.cache/clawmem/sessions/<session_id>.focus` (1024-byte cap, UTF-8, plain text). Session ID is resolved from `--session-id <id>`, then `CLAUDE_SESSION_ID` (Claude Code exposes this natively), then `CLAWMEM_SESSION_ID`. The focus file IS the primary signal read by `context-surfacing` — `CLAWMEM_SESSION_FOCUS` env var is a debug-only override that is NOT session-scoped and should not be used in multi-session deployments. `CLAWMEM_FOCUS_ROOT` env override is supported for hermetic testing.
- **Intent-threaded retrieval** — when a focus topic is resolved, `context-surfacing` threads it as the `intent` parameter to `expandQuery` + `rerank` + `extractSnippet`. This is the existing query-time intent lever (already Codex-approved in the query pipeline), so the topic steers query expansion variants, reranker priority, and snippet-extraction sentence selection along the same code paths as a manually-provided `intent` on an MCP `query()` call.
- **Post-composite-score topic boost** — after `applyCompositeScoring` and BEFORE the adaptive threshold filter + memory-type diversification stages, docs matching ALL tokens of the focus topic (bag-of-words against title/path/body[:800], case-insensitive) get a 1.4× multiplier on `compositeScore`. Non-matching docs get a 0.75× demote (clamped at a 0.5 floor via `Math.max(demoteFactor, 0.5)`). The boost fires per-result and re-sorts the scored set, so matching docs rise and non-matching docs drop but stay eligible if they would have made the threshold without the demote.
- **Zero-match NO-OP fail-open contract (Codex §11.4 Turn 1 fix)** — if zero docs in the scored result set match the topic, `applyTopicBoost(...)` early-returns without mutating `compositeScore`. Without this short-circuit, uniformly demoting every non-matching doc would push borderline docs below the downstream adaptive threshold and silently shrink the result set compared to the no-topic baseline — a direct regression against the approved §11.4 spec ("topic set + zero matching docs → proceed with the normal results"). The fix pre-computes a per-result match flag array in a single pass, checks `if (!anyMatch) return scored`, and only enters the mutation loop when at least one match exists.
- **Session isolation — no SQLite writes** — the focus file is scoped by `sessionId`, never writes to SQLite, never mutates `confidence` / `status` / `snoozed_until` / `archived_at` / any lifecycle column. Concurrent sessions on the same host cannot cross-contaminate each other's topic biasing. This is load-bearing for multi-session deployments (OpenClaw daemon, mission-control concurrent chats) — a global `memory_snooze` would not have worked for session-scoped noise suppression without polluting other sessions' retrieval state.
- **Hook-level integration test lock-in** — three new tests in `tests/integration/context-surfacing-topic-boost.integration.test.ts` drive the real `contextSurfacing(store, input)` handler end-to-end against a hermetic in-memory SQLite store with redirected `CLAWMEM_FOCUS_ROOT`: (1) no-topic vs non-matching-topic produces byte-identical `<vault-context>` output, (2) the byte-equality invariant holds even on a 3-doc result set exercising the full threshold + diversification pass, (3) matching topic produces observably different output from the no-topic baseline (positive control for the boost being active). The byte-equality check is what Codex specifically asked for in Turn 1 — it is the only test shape that proves the fail-open contract survives the full hook pipeline and not just the isolated `applyTopicBoost` unit.

### Codex review

GPT 5.4 High, session `019d72d5` (continues the session chain used from v0.7.1 through v0.8.5, cumulative ~7.5M tokens across 16+ turns). Design review cleared after 6 turns across both §11.4 and §11.1 together. Implementation reviews ran sequentially:

- **§11.4 implementation** — cleared in 2 turns. **Turn 1** raised 1 High finding: the zero-match fail-open contract was violated because `applyTopicBoost` demoted every non-matching doc uniformly even when ZERO docs matched the topic, which under the adaptive threshold filter downstream would push borderline docs below the threshold and silently shrink the result set. Fixed with pre-computed match array + early-return no-op + hook-level integration test asserting byte-equality between the no-topic baseline and a non-matching-topic run. **Turn 2** zero findings.
- **§11.1 implementation** — cleared in 2 turns. **Turn 1** raised 1 Medium finding: `<vault-facts>` could duplicate the same fact when the prompt resolves both endpoints of one triple, because `store.queryEntityTriples(entityId)` defaults to `direction='both'` and the block had no cross-entity dedupe — the same line would appear twice and spend budget twice. Fixed with cross-entity `(subject, predicate, object)` dedup Set applied before budgeting + 2 new unit tests (same triple from both endpoints → one line; distinct triples sharing one endpoint → both lines preserved). **Turn 2** zero findings, verbatim: *"No remaining findings on §11.1. Yes, §11.1 is now cleared to ship."*

All nine design approvals from the design-phase review survived implementation unchanged (three-path extraction, validate-then-count ordering, cross-path entity-id dedup, longer-n-gram tie-breaker, stage placement after `vaultInner`, index migration safety, the four accepted design deviations).

### Test coverage

**+96 tests** across the unit + integration layers on top of the v0.8.5 baseline:

- `tests/unit/session-focus.test.ts` (51 tests) — focus file round-trip, `resolveSessionTopic` env-var-precedence, `applyTopicBoost` boost/demote math, demote floor clamp, zero-match NO-OP, empty-array early return, Unicode topic handling, file-size overflow guard.
- `tests/unit/vault-facts.test.ts` (49 tests) — `extractCanonicalIds` regex boundary cases (interior hyphens, trailing hyphens, word boundaries), `extractProperNouns` title-case sequences, `generateNgramCandidates` longer-first ordering + length tagging + dedup, `batchLookupNames` vault isolation, `extractPromptEntities` three-path orchestration + path-(a/b/c) happy paths + validate-first invariant against long capitalized noise + exact-100 boundary + cross-path dedup + ambiguity skip, `buildVaultFactsBlock` budget handling + truncation at triple boundary + empty-block drop + per-entity max cap + fail-open on DB throw + cross-entity dedup + distinct-triples-sharing-endpoint preservation + schema migration `PRAGMA index_list` assertion.
- `tests/integration/context-surfacing-topic-boost.integration.test.ts` (3 tests) — zero-match fail-open byte-equality × 2 variants (single-result + multi-result), matching topic observably changes output vs the no-topic baseline.

Public test suite: **1025 → 1105, zero regressions.** Skill-forge clawmem backport test suite: **1022 pass, zero regressions** (53 files, smaller baseline because skill-forge has fewer test files overall).

### Upgrading from a pre-v0.9.0 vault

v0.9.0 is **safe to drop in** — the only behavior change on existing code paths is the additive `<vault-facts>` block and the session-scoped topic boost, both gated on new state (entity seeds from the prompt and a per-session focus file). Everything else is unchanged:

- **Schema** — the only migration is a single `CREATE INDEX IF NOT EXISTS idx_entity_nodes_lower_name` statement that runs idempotently on first open. No column additions, no data rewrites, no downtime.
- **API** — zero breaking changes. New `clawmem focus` subcommand is additive. Existing CLI commands and MCP tools are signature-compatible.
- **Config / env vars** — optional: `CLAWMEM_FOCUS_ROOT` (override for the focus file root, primarily for hermetic testing) and `CLAWMEM_SESSION_FOCUS` (debug-only override, NOT session-scoped). The new `factsTokens` profile field defaults to 0 / 200 / 250 for speed/balanced/deep — existing custom profiles that don't set it will receive `factsTokens: 0` from the type default (stage disabled) unless you add it explicitly.
- **Hooks** — no `clawmem setup hooks` re-run needed. Claude Code invokes `${binPath} hook ${name}` at runtime, so upgrading the ClawMem binary alone propagates the new context-surfacing behavior.
- **Reindex / embed** — not required. `<vault-facts>` reads from existing `entity_triples` rows populated by the v0.8.5 SPO extraction pipeline, and §11.4 reads from existing `documents` rows. No re-enrichment needed to see the new blocks.

**Confirming the features are live:**

- `clawmem focus set "authentication" --session-id test1 && clawmem focus show --session-id test1` should print the topic and the expected file path at `~/.cache/clawmem/sessions/test1.focus`.
- After a user prompt that mentions a known entity (e.g., one that appears in `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT name FROM entity_nodes LIMIT 5"`), the hook should append a `<vault-facts>` block inside `<vault-context>` on `balanced`/`deep` profiles. Check by running `echo "tell me about <entity>" | clawmem surface --context --stdin`.

---

## v0.8.5 — SPO Triple Extraction Fix: KG Actually Populates Now

Fixes a bug cluster (BACKLOG.md §1.6) where `entity_triples` was stuck at zero rows on production vaults regardless of activity, making `kg_query` return empty for every entity and silently hollowing out the WHY / ENTITY graph-traversal paths in `intent_search`. Nine bugs across the decision-extractor → observer → entity-resolution → triple-storage pipeline were traced and fixed across four Codex review turns. The fix is entirely additive and strictly improves pre-v0.8.5 behavior — no schema changes, no API breaks, no required migration steps.

- **LLM-based SPO extraction replaces the old regex path** — the observer LLM now emits structured `<triples>` blocks alongside `<facts>`, parsed and validated in `parseObservationXml` against a fixed predicate vocabulary. The pre-v0.8.5 regex-based `extractTripleFromFact` required `subject verb object` sentence shape, which rejected the majority of real observation facts (descriptive phrases like "ClawMem now deploys via systemd user units on a remote host"). The LLM path extracts relational claims without sentence-shape constraints. `VALID_PREDICATES` is a tight 13-predicate set — `adopted`, `migrated_to`, `deployed_to`, `runs_on`, `replaced`, `depends_on`, `integrates_with`, `uses`, `prefers`, `avoids`, `caused_by`, `resolved_by`, `owned_by` — and the parser rejects anything outside it. `LITERAL_PREDICATES` marks `prefers`/`avoids` as literal-object predicates (object is stored as a string, not resolved to an entity).
- **Canonical A-MEM entity IDs end-to-end via `ensureEntityCanonical`** — the old path minted `entity_nodes` rows with `entity_type='auto'` (not a valid compatibility bucket, so those entities never resolved via `kg_query` — a major root cause of the empty KG). The new helper in `src/entity.ts` resolves to a canonical `vault:type:slug` entity ID shared with the rest of A-MEM, never writes `'auto'`, and — unlike `upsertEntity` — does NOT bump `mention_count`, so SPO triple references don't inflate A-MEM's doc-mention counter. `INSERT OR IGNORE` + deterministic `makeEntityId` handles concurrent-insert races correctly.
- **Ambiguity-safe type inheritance via `resolveEntityTypeExact`** — when the observer emits a bare entity name, the helper inherits its `entity_type` from `entity_nodes` only if exactly one entity in the vault matches. Zero matches return null (caller defaults to `concept`); multiple matches across buckets (e.g., "Alice" as `person` AND as `project`) also return null instead of arbitrarily picking. `SELECT DISTINCT entity_type ... WHERE LOWER(name) = LOWER(?)` — exact-match-only, no fuzzy fallback, fails closed on ambiguity.
- **Observation type gate widened to `{decision, preference, milestone, problem, discovery, feature}`** — the pre-v0.8.5 gate rejected roughly 77% of real observations in production vaults because it only accepted `decision`/`preference`/`milestone`/`problem` while the majority of observer output was `discovery`. The new `SPO_ELIGIBLE_OBSERVATION_TYPES` set includes `discovery` and `feature` (the two most common types for product-development work) while still excluding `refactor`/`bugfix`/`change` (noisy types that would dilute the KG).
- **Observation path collision fix** — the persistence path was previously `observations/${date}-${session8}-${type}.md`, which collided on `UNIQUE(collection, path)` whenever two observations of the same type appeared in one session (common for `discovery` during deep coding sessions). The second `insertDocument` threw, was silently caught, and the observation + its triples were dropped. The new path bakes an 8-char SHA256 `obsHash` slice into the filename — deterministic (identical bodies still collide → idempotent reruns), collision-safe under a birthday bound for realistic session sizes. Persistence logic is now in an exported `persistObservationDoc` helper so regressions are unit-testable.
- **Placeholder leak defense at both prompt and parser** — the pre-v0.8.5 `OBSERVATION_SYSTEM_PROMPT` placed literal example text (`<fact>Individual atomic fact</fact>`) inside tags the parser later extracted, and a weak 1.7B model occasionally echoed that text verbatim into production `entity_triples` rows. The new prompt uses ellipsis placeholders outside data tags, prose field rules below the XML block, and two parser defenses: an exact-string blocklist (`SCHEMA_PLACEHOLDER_STRINGS`) + a narrow shape-only regex (`{{...}}`, `<!--...-->`, `${...}`). Applied to `title`, every `<fact>`, and every triple `<subject>`/`<object>`.
- **`kg_query` canonical-ID fallback** — previously, a callerside canonical ID like `default:project:clawmem` was run through `searchEntities`, failed to match as free text, then fed through a slugification fallback (`entity.toLowerCase().replace(/[^a-z0-9]+/g, "_")`) that fabricated invalid IDs and returned misleading "no facts found for X" responses. The fallback now regex-tests for the canonical shape (`/^[a-z][a-z0-9-]*:[a-z_]+:[a-z0-9_]+$/`) and round-trips the ID verbatim if it matches, otherwise returns an explicit "no entity found" message with a format hint. The tool description + parameter description updated to advertise canonical-ID acceptance. `kg_query` is a pure superset — entity-name callers see no behavior change.
- **`source_doc_id` provenance on every triple** — `addTriple` callsites now pass `sourceDocId: wit.docId` from the persisted observation, enabling downstream provenance queries and joining triples back to their originating observation document. Previously dropped silently. `source_fact` is the reconstructed `subject predicate object` string (not `JSON.stringify`) so human inspection is readable.
- **Deleted false-comfort test + new real coverage** — the pre-existing `tests/unit/triple-extraction.test.ts` was a copy-paste of the (now deleted) regex helper, not testing production code. Replaced with `tests/unit/spo-extraction.test.ts` covering the full new pipeline: parser triple extraction (canonical predicates, unknown predicate rejection, missing-field rejection, oversize rejection, placeholder rejection, 5-triple cap, case normalization), placeholder filtering (exact strings + template shapes + legitimate `Example:` false-positive preservation), `VALID_PREDICATES`/`LITERAL_PREDICATES` sanity, `ensureEntityCanonical` (canonical creation, zero mention_count bump, reuse, vault scoping, no `'auto'` leak), `resolveEntityTypeExact` (single match, ambiguity rejection, vault isolation), end-to-end triple insertion via canonical IDs with real `source_doc_id`, and `persistObservationDoc` collision-free + idempotent + fact-less behavior.
- **Codex review** — GPT 5.4 High, session `019d72d5` (same session used for v0.7.1 through v0.8.4), 4 turns of review-and-fix. Turn 1 raised 3 categories of bugs and a design direction. Turn 2 raised 3 High findings on the Turn 1 fix plan (`upsertEntity` bumping mention_count, `resolveEntityType` ambiguity unsafety, docId-threading path assumption) plus tighter predicate vocabulary recommendation. Turn 3 raised 1 High (observation path collision, a pre-existing blocker that the new pipeline surfaced) + 1 Low (placeholder regex false-positive on `Example:` prefix) plus a recommended integration test. Turn 4: zero remaining findings, clear to ship.

Adds +34 tests (`tests/unit/spo-extraction.test.ts`, 31 Turn-3 parser/entity/provenance + 3 Turn-4 collision-free persistence) on top of the v0.8.4 baseline. Public test suite: 1006 → 1025, zero regressions.

### Upgrading from a pre-v0.8.5 vault

v0.8.5 is **safe to drop in** — the fix is additive across the board and nothing existing breaks:

- **Schema** — zero changes. No SQL migration runs on first open.
- **API** — zero breaking changes. `kg_query` gained canonical-ID acceptance but continues to accept entity names; every other MCP tool signature is identical.
- **Config / env vars** — zero changes.
- **Hooks** — no `clawmem setup hooks` re-run needed. Claude Code invokes `${binPath} hook ${name}` at runtime, so upgrading the ClawMem binary alone propagates the new decision-extractor behavior.
- **Data cleanup** — *optional*. Dead `entity_nodes.entity_type='auto'` rows and placeholder `source_fact` strings from pre-v0.8.5 runs are harmless (they never resolve via `kg_query`), but can be deleted if you want a clean slate. See the "kg_query returns empty for every entity" entry in `docs/troubleshooting.md` for the exact `sqlite3` cleanup commands and diagnostic symptoms.
- **Retroactive re-enrichment** — *optional*. v0.8.5 does not introduce new enrichment stages, so `clawmem reindex --enrich` is NOT required. Only run it if you specifically want triple extraction to re-fire across your existing observation history — but note that past observation transcripts are gone, so re-enrichment on already-persisted `_clawmem/observations/*.md` files will not recover lost same-type-collision observations. New Stop-hook activity from v0.8.5 onward is the cleanest source of triples.

**Confirming the fix is live** — after a real Claude Code Stop-hook-firing session, `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT source_fact FROM entity_triples ORDER BY created_at DESC LIMIT 5"` should show human-readable `subject predicate object` strings (e.g. `"ClawMem depends_on Bun"`), not JSON blobs or schema-placeholder echoes.

---

## v0.8.4 — OpenClaw Setup Auto-Install + Active Memory Coexistence Docs

Fixes the OpenClaw plugin setup workflow that caused issue #5 ("plugin not found: clawmem"). Patch release — no schema changes, no migration required.

- **`clawmem setup openclaw` now auto-installs** — previously only printed manual instructions (symlink + manifest copy + config set), which users frequently skipped or misconfigured. Now auto-creates `~/.openclaw/extensions/clawmem` as a symlink to the plugin source, verifies the manifest exists, and prints only the remaining steps that require a gateway restart first (slot assignment, GPU endpoints, REST API). Handles stale symlinks (detects via `readlink` compare, replaces automatically after npm updates), existing directories (removes and re-symlinks), and regular file conflicts (aborts with clear message). Idempotent on re-run.
- **`clawmem setup openclaw --remove` now auto-uninstalls** — previously only printed removal instructions. Now removes the symlink/directory and resets the context engine slot to `legacy` via `openclaw config set` (if the OpenClaw CLI is available). Falls back to printing the manual command when the CLI is absent.
- **Manifest renamed to `openclaw.plugin.json`** — the plugin manifest shipped as `plugin.json` but OpenClaw expects `openclaw.plugin.json`. The old setup workflow worked around this with a copy step that wrote into the symlinked source tree (bad for protected npm prefixes and source checkouts). Now ships with the correct filename, eliminating the copy step entirely.
- **OpenClaw v2026.4.10+ version warning** — setup prints a warning about the config normalization bug (openclaw/openclaw#64192) where `plugins.slots.contextEngine` was silently dropped on earlier versions. The warning is informational, not fatal.
- **Active Memory coexistence documented** — new section in the OpenClaw plugin guide explaining that ClawMem and OpenClaw's Active Memory plugin (v2026.4.10+) are fully compatible: different plugin kinds, different injection targets (user prompt vs system prompt), different memory backends. Both can run simultaneously.
- **Codex review** — GPT 5.4 High, session `019d72d5`, turns 25-27 (~4.32M cumulative tokens). Turn 25 raised 1 High (manifest copy into source tree) + 2 Medium (auto-install gap, version warning). Turn 26 raised 1 High (config set before gateway restart) + 1 Low (regular file conflict unhandled). Turn 27: zero remaining findings.

No breaking changes. Existing users who previously ran the manual symlink steps are unaffected — `setup openclaw` detects the existing correct symlink and skips re-creation.

### External credit

- **@saschabuehrle** — opened yoloshii/ClawMem#6 with the gateway-restart-before-slot-assignment fix and the correct diagnosis of the `Context engine "clawmem" is not registered` failure path. The PR was closed as superseded because v0.8.4 ended up shipping a broader auto-install fix, but the restart-ordering insight is preserved verbatim in v0.8.4's printed next-steps and the code comment that documents the constraint.

---

## v0.8.3 — Content-Type-Aware Entity Cap + Self-Loop Guard + Docs Restructure

Two small safety/correctness fixes land alongside a major documentation restructure. Patch release — no schema changes, no migration required, no new env vars.

- **Content-type-aware entity cap** — A-MEM entity extraction used a flat `.slice(0, 10)` cap that silently dropped legitimate entities on long-form content (research dumps, conversation synthesis, hub/index documents). The new `ENTITY_CAP_BY_TYPE` mapping in `src/entity.ts` scales the cap by `content_type`: research documents keep up to 15, hub and conversation documents keep up to 12, short types (decision, deductive, note, handoff, progress) stay at 8, and anything else — including untyped documents and unknown types — keeps the pre-v0.8.3 default of 10. `extractEntities` gained an optional `contentType` parameter and `enrichDocumentEntities` threads the column through from the document row. The LLM extraction prompt also advertises the dynamic cap directly (`0-${cap} entities` instead of the old hardcoded `0-10`) so a compliant model no longer stops early on long-form documents. Input is trimmed and lowercased before lookup, so hand-authored frontmatter values like `"Research"` or `" conversation "` resolve cleanly.
- **Self-loop guard in `insertRelation`** — the primary `memory_relations` write API (`store.ts:1545`) now rejects relations where `fromDoc === toDoc` at the API boundary. A self-loop has no informational value for graph traversal and would pollute `intent_search` / `find_similar` neighborhoods. A mirror guard was added to the beads dependency bridge inside `syncBeadsIssues` (`store.ts:~4228`) because that path inserts directly into `memory_relations` without going through the wrapper. `buildTemporalBackbone` and `buildSemanticGraph` were left alone — both are structurally safe via their loop shape or SQL filter. An extended audit surfaced six additional INSERT sites (in `amem.ts`, `entity.ts`, `consolidation.ts`, `conversation-synthesis.ts`) that each already have their own structural or explicit self-loop protection; none required new guards.
- **Documentation restructure** — All version history was moved out of `README.md` (removed 7 inline subsections, ~75 lines) into a new chronological `RELEASE_NOTES.md` with every release from v0.1.1 through v0.8.3. `README.md` now reads as setup + usage + architecture, not changelog, and points to the new file. Upgrade action guidance for existing vaults continues to live in `docs/guides/upgrading.md`. This is the document you are reading.
- **Tests** — added 28 new tests across `tests/unit/entity.test.ts` (14 unit tests for `entityCapForContentType` covering all content types, defaults, unknown fallback, case/whitespace normalization; 11 integration tests for `extractEntities` covering per-type caps, untyped backward compat, and prompt-shape verification) and `tests/unit/openviking-enhancements.test.ts` (3 tests for the self-loop guard: plain rejection, mixed-valid-and-self-loop regression, and upsert weight-accumulation invariance). Public test suite: 978 → 1006, zero regressions.

No breaking changes. Existing callers that don't pass `contentType` get the default cap of 10, matching pre-v0.8.3 behavior exactly.

---

## v0.8.2 — Dual-Host Worker Architecture

Both maintenance lanes can now be hosted by the long-lived `clawmem watch` watcher service in addition to the existing per-session `clawmem mcp` host. This makes the systemd-managed watcher the canonical 24/7 home for the v0.8.0 heavy maintenance lane — its quiet-window logic finally sees a live worker at the configured hours regardless of whether any Claude Code session is open. The light consolidation lane (Phase 1 backfill + Phase 2 merge + Phase 3 deductive synthesis + Phase 4 recall stats) now also acquires its own DB-backed `worker_leases` row before each tick, symmetric with the heavy lane's existing exclusivity, so multiple host processes against the same vault cannot race on Phase 2 merges or Phase 3 deductive writes.

- **Light-lane worker lease** — `runConsolidationTick` wraps every tick (Phase 1 → 4) in `withWorkerLease` against a new `light-consolidation` worker name with a 10-minute TTL. Two host processes (e.g. one watcher service + one per-session stdio MCP) cannot both consolidate the same near-duplicate observations or both INSERT a duplicate row into `consolidated_observations`. Phase 1 enrichment is also serialized — overkill for cost but cleaner for symmetry. The in-process `isRunning` reentrancy guard remains the cheap first defense before the SQLite lease round-trip.
- **`cmdWatch` hosts both workers** — `clawmem watch` honors the same `CLAWMEM_ENABLE_CONSOLIDATION` and `CLAWMEM_HEAVY_LANE` env-var gates as `cmdMcp`. Off by default. Mirror the existing systemd unit (or your wrapper `.env`) to opt in. The recommended deployment for v0.8.2+ is to set both env vars on `clawmem-watcher.service` and leave `cmdMcp` unset, so the heavy lane has a continuously available host independent of Claude Code session lifecycle.
- **`cmdMcp` is now a fallback host with a heavy-lane warning** — `cmdMcp` retains the same env-var gates so non-watcher deployments (e.g. macOS users running everything via Claude Code launchd) keep working unchanged. When `CLAWMEM_HEAVY_LANE=true` is set on a stdio MCP host, `cmdMcp` emits a one-line warning to stderr advising operators to move heavy-lane hosting to `clawmem watch` instead.
- **Async drain on shutdown** — both worker stop helpers (`stopConsolidationWorker` and the closure returned by `startHeavyMaintenanceWorker`) are now `async`, clearing their `setInterval` AND polling their in-flight running flag until any mid-tick worker drains. This guarantees the worker's `withWorkerLease` finally block runs against a still-open store, so the lease is released cleanly instead of leaking until TTL expiry. Bounded waits (15s light, 30s heavy) prevent a stuck tick from wedging shutdown indefinitely; the next process reclaims any stranded lease atomically.
- **Signal handlers registered before worker startup** — both `cmdWatch` and `cmdMcp` now register their `SIGINT`/`SIGTERM` handlers BEFORE any worker initialization. A signal arriving in the brief window between worker startup and handler registration would otherwise terminate the host via the default signal action (exit 143) and skip the async drain entirely.
- **Subprocess smoke test** — new `tests/integration/cmdwatch-workers.integration.test.ts` spawns `bun src/clawmem.ts watch` against a temp vault with short worker intervals, exercises the env-var gates, exercises a real heavy-lane tick (slow path, ~35s), and asserts the lease is released cleanly on `SIGTERM`.
- **Bug fix: removed dead skill-vault watcher block from `clawmem.ts cmdWatch()`** — a try/catch wrapped block had been silently destructuring `getSkillContentRoot` from `./config.ts`, but that helper is forge-internal and was never exported in public ClawMem. The runtime catch swallowed the failure so it had no observable effect, but TypeScript flagged a static `TS2339` error on the destructure. v0.8.2 removes the dead code path. No behavior change for public users.

Adds +15 tests (9 light-lane lease unit + 5 cmdWatch fast subprocess + 1 cmdWatch slow subprocess) on top of the v0.8.1 baseline.

For operational guidance — enabling the workers via systemd drop-in, tuning intervals to your usage pattern, monitoring queries, and rollback steps — see [docs/guides/systemd-services.md](docs/guides/systemd-services.md#background-maintenance-workers-v082).

---

## v0.8.1 — Multi-Turn Prior-Query Lookback

`context-surfacing` now builds its retrieval query from the current prompt plus up to two recent same-session prior prompts, so a short follow-up turn ("do the same for X", "explain the rationale") can still inherit the vocabulary of earlier turns. The raw prompt is persisted in a new nullable `context_usage.query_text` column so future hook ticks can reconstitute the multi-turn query from the DB. See [multi-turn lookback](docs/concepts/architecture.md#multi-turn-prior-query-lookback-v081) for the full walkthrough.

- **Additive schema migration** — new nullable `query_text TEXT` column on `context_usage`, guarded by `PRAGMA table_info`. Pre-v0.8.1 stores get the column added on first open; ad-hoc stores that skip the migration path degrade transparently via a feature-detect WeakMap so `insertUsageFn` never writes a column that doesn't exist.
- **Discovery path only** — the multi-turn query feeds vector search, BM25, and query expansion. Cross-encoder reranking continues to use the RAW current prompt so relevance scoring is not diluted by older turns, and composite scoring / snippet extraction / dedupe / routing-hint detection all remain on the raw prompt as well.
- **Privacy-conscious persistence split** — gated skip paths (slash commands, `MIN_PROMPT_LENGTH`, `shouldSkipRetrieval`, heartbeat dedupe) do NOT persist their raw text because those turns are not meaningful user questions and carry a higher sensitivity profile. Post-retrieval empty paths (empty result set, threshold blocked, budget blocked) DO persist so a follow-up turn can still inherit the intent even when the current turn surfaced nothing.
- **Current-first truncation** — the combined query is clamped to 2000 chars with the current prompt preserved verbatim at the head. Older priors are dropped first when the budget runs out. If the current prompt alone already exceeds the cap, priors are omitted entirely and the current prompt is truncated.
- **SQL-level self-match guard** — duplicate submits of the same prompt are filtered out of the lookback SELECT via `AND query_text != ?` so a retry burst cannot eat into the 2-prior budget and leave the lookback window underfilled.
- **10-minute max age, session-scoped** — priors older than 10 minutes or from a different `session_id` are invisible to the lookback. All fallback paths (missing column, DB error, no matching rows) return the current prompt unchanged — the hook never throws on lookback failures.

Adds +27 tests (22 unit + 5 integration) on top of the v0.8.0 baseline.

---

## v0.8.0 — Quiet-Window Heavy Maintenance Lane

A second, longer-interval consolidation worker that keeps Phase 2 + Phase 3 running on large vaults without starving interactive sessions. Off by default — set `CLAWMEM_HEAVY_LANE=true` to enable. The existing 5-minute light-lane worker is unchanged. See [heavy maintenance lane](docs/concepts/architecture.md#heavy-maintenance-lane-v080) for the architectural walkthrough.

- **Quiet-window gating** — the heavy lane only runs inside the hours set by `CLAWMEM_HEAVY_LANE_WINDOW_START` / `CLAWMEM_HEAVY_LANE_WINDOW_END` (0-23). Supports midnight wraparound (e.g., 22→6). Null on either bound means "always in window".
- **Query-rate gating via `context_usage`** — counts hook injections in the last 10 minutes and skips the tick when the rate exceeds `CLAWMEM_HEAVY_LANE_MAX_USAGES` (default 30). No new `query_activity` table; reuses v0.7.0 telemetry.
- **DB-backed worker leases** — exclusivity enforced via a new `worker_leases` table with atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= ?` acquisition, random 16-byte fencing tokens, and TTL reclaim. Safe under multi-process contention; any SQLite error translates to a `lease_unavailable` skip rather than a thrown exception.
- **Stale-first selection** — Phase 2 and Phase 3 reorder their candidate sets by `COALESCE(recall_stats.last_recalled_at, documents.last_accessed_at, documents.modified_at) ASC` so long-unseen docs bubble up first. Empty `recall_stats` falls through to access-time without erroring.
- **Optional surprisal selector** — `CLAWMEM_HEAVY_LANE_SURPRISAL=true` plumbs k-NN anomaly-ranked doc ids (via the existing `computeSurprisalScores`) into Phase 2 as an explicit `candidateIds` filter. Degrades to stale-first on vaults without embeddings and logs `selector: 'surprisal-fallback-stale'` in the journal.
- **`maintenance_runs` journal** — every scheduled attempt writes a row: `status` (`started`/`completed`/`failed`/`skipped`), `reason` for skips, selected/processed/created/null_call counts, and a `metrics_json` payload with selector type and full `DeductiveSynthesisStats` breakdown. Operators can reconstruct any lane decision without reading worker logs.
- **Force-enforce merge gate** — the heavy lane passes `guarded: true` to `consolidateObservations`, which overrides `CLAWMEM_MERGE_GUARD_DRY_RUN` inside `findSimilarConsolidation` so experimenting operators cannot weaken heavy-lane enforcement via env flag.

Adds +56 tests (13 worker-lease + 35 maintenance unit + 8 maintenance integration) on top of the v0.7.2 baseline.

---

## v0.7.2 — Post-Import Conversation Synthesis

Opt-in LLM pass that runs **after** `clawmem mine` finishes indexing an imported collection. Operates on the freshly imported `content_type='conversation'` documents and extracts structured knowledge facts (decisions / preferences / milestones / problems) plus cross-fact relations, writing each fact as a first-class searchable document alongside the raw conversation exchanges. See [post-import synthesis](docs/concepts/architecture.md#post-import-conversation-synthesis-v072) for the architectural walkthrough.

- **New CLI flag** — `clawmem mine <dir> --synthesize [--synthesis-max-docs N]`. Off by default. When omitted, existing mine behaviour is byte-identical to v0.7.1.
- **Two-pass pipeline** — Pass 1 extracts facts per conversation via the existing LLM, saves each via dedup-aware `saveMemory`, and populates a local alias map. Pass 2 resolves cross-fact links against the local map first, falling back to collection-scoped SQL lookup. Forward references (link to a fact extracted later in the same run) are resolved correctly.
- **Idempotent reruns** — synthesized fact paths are a pure function of `(sourceDocId, slug(title), short sha256(normalizedTitle))`, so reruns over the same conversation batch hit the `saveMemory` update branch instead of creating parallel rows. Same-slug collisions are disambiguated by the stable hash suffix, not encounter order.
- **Fail-closed link resolution** — when two different facts claim the same normalized title or alias, the resolver treats the link as ambiguous and counts it unresolved. Pre-existing docs with duplicate titles in the collection do not silently bind either.
- **Weight-monotonic relation upsert** — `memory_relations` insert uses `ON CONFLICT DO UPDATE SET weight = MAX(weight, excluded.weight)`, which is idempotent on equal-weight reruns but still accepts stronger later evidence without double-counting.
- **Non-fatal failure model** — any LLM failure, JSON parse error, saveMemory collision, or relation insert error is counted and logged, never re-thrown. Synthesis failure after `indexCollection` commits does not roll back the mine import.
- **Split operator counters** — `llmFailures` counts actual LLM path failures (null, thrown, non-array JSON), while `docsWithNoFacts` counts docs where the LLM responded validly but returned zero structured facts. Previously these were conflated as `nullCalls`.

Adds +63 tests (46 unit + 5 integration + 12 regression) on top of the v0.7.1 baseline.

---

## v0.7.1 — Safety Release

Five independent safety gates around the consolidation pipeline and context surfacing, aimed at preventing contamination, cross-entity merges, and unchecked contradictions from landing in the vault. Every extraction ships with full unit + integration test coverage (+158 tests on top of the v0.7.0 baseline). See [consolidation safety](docs/concepts/architecture.md#consolidation-safety-v071) for the architectural walkthrough.

- **Taxonomy cleanup** — standardized on the A-MEM `contradicts` (plural) convention across the entire codebase, eliminating silent query misses on the legacy singular form
- **Name-aware merge safety** — the Phase 2 consolidation worker gate extracts entity anchors (via `entity_mentions`, with lexical proper-noun fallback) and runs dual-threshold normalized 3-gram cosine similarity before merging similar observations. Cross-entity merges are hard-rejected when anchor sets differ materially, preventing context bleed where "Alice decided X" merges into "Bob decided X". Thresholds are env-overridable (`CLAWMEM_MERGE_SCORE_NORMAL`=0.93, `_STRICT`=0.98). Dry-run mode via `CLAWMEM_MERGE_GUARD_DRY_RUN` for calibration.
- **Contradiction-aware merge gate** — after the name-aware gate passes, a deterministic heuristic (negation asymmetry, number/date mismatch) plus an LLM check detect contradictory merges. Blocked merges route to `link` policy (insert new row + `contradicts` edge, default) or `supersede` policy (mark old row `status='inactive'`). Configurable via `CLAWMEM_CONTRADICTION_POLICY` and `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE`. Phase 3 deductive synthesis applies the same gate to deductive dedupe matches.
- **Anti-contamination deductive synthesis** — every Phase 3 draft runs through a three-layer validator: deterministic pre-checks (empty conclusion, invalid source_indices, pool-only entity contamination via `entity_mentions`) + LLM validator (fail-open with `validatorFallbackAccepts` counter) + dedupe. Per-reason rejection stats exposed via `DeductiveSynthesisStats` so Phase 3 yield can be diagnosed without enabling extra logging.
- **Context instruction + relationship snippets** — `context-surfacing` now always prepends an `<instruction>` block framing the surfaced facts as background knowledge the model already holds, and appends an optional `<relationships>` block listing memory-graph edges where BOTH endpoints are in the surfaced doc set. The relationships block is the first thing dropped when the payload would overflow `CLAWMEM_PROFILE`'s token budget, preserving facts-first behaviour while giving the model graph-level reasoning hooks directly in-prompt.

---

## v0.7.0 — Recall Tracking with Per-Turn Attribution

Extracts recall tracking patterns from OpenClaw's dreaming memory consolidation system. Tracks which documents are surfaced by retrieval, which queries surfaced them, and whether the assistant cited them — per-turn, not per-session. Validated by GPT 5.4 High across 8 review turns (2.6M tokens).

- **New schema** — `recall_events` (append-only event log), `recall_stats` (derived summary with diversity / spacing / negative counts), `turn_index` column on `context_usage` + `recall_events`, `contradict_confidence` column on `memory_relations`.
- **Direct SQLite write in context-surfacing** — recall events are written directly from the hook process, not through an in-memory buffer. Claude Code hooks are separate short-lived processes, so in-memory buffering would drop events on every session boundary.
- **Per-turn attribution** — `feedback-loop` segments the transcript into turns and zips with `context_usage` rows by `turn_index`, checking references per-turn rather than session-globally. Eliminates cross-turn attribution noise where a document surfaced in turn 3 gets credited by a reference in turn 8.
- **Cross-vault support** — all 31 MCP tools accept an optional `vault` parameter. `context_usage` writes are mirrored into the named vault without cross-DB foreign keys. New `list_vaults()` and `vault_sync()` tools for vault management. Configured in `config.yaml` under `vaults:` or via `CLAWMEM_VAULTS` env var.
- **Budget-only recording** — only docs that actually made it into the injected context are tracked. Budget-clipped docs are excluded, preventing negative signal inflation from entries the model never saw.
- **Lifecycle integration** — `lifecycle_status` and `lifecycle_sweep` now surface pin candidates (high diversity + spacing) and snooze candidates (high noise ratio), scoped to active docs with collection/path in output.
- **SQLite contention fix** — `busy_timeout=15s` during DDL init (was 0ms, causing SQLITE_BUSY on concurrent Stop hooks), reset to 5s for normal operations.

New files: `src/recall-buffer.ts`, `src/recall-attribution.ts`. Adds +36 recall tracking tests; 659 total passing.

---

## v0.6.0 — Deductive Observations, Surprisal Scoring & LLM Remote Fallback

Consolidation worker gains a Phase 3 that synthesizes higher-order deductive observations from recent related facts. Introduces k-NN surprisal scoring for curator triage, embed-state tracking with retries, and a cooldown-based LLM remote fallback. Honcho deep analysis informed the deductive synthesis and surprisal patterns. GPT 5.4 Codex reviewed across 4 turns, 5.2M tokens. 623 tests passing.

- **Deductive observation synthesis** — the consolidation worker Phase 3 combines related recent observations (`decision` / `preference` / `milestone` / `problem`, last 7 days) into first-class `content_type='deductive'` documents with `source_doc_ids` provenance and supporting edges in `memory_relations`. Infinite half-life, 0.85 baseline, decay-exempt — deductions compound over time rather than fading.
- **Retrieval separation** — `session-bootstrap` `getCurrentFocus()` surfaces deductive insights in a dedicated "Derived Insights" section. `context-surfacing` tags them as `(deductive)` so the agent knows they are synthesized rather than directly observed.
- **Surprisal scoring** — `computeSurprisalScores()` uses k-NN average-neighbor-distance over `sqlite-vec` embeddings to identify anomalous observations for curator triage. High surprisal = outlier relative to its semantic neighborhood.
- **Embed-state tracking** — documents track `embed_state` (`pending` / `synced` / `failed`), `embed_error`, and `embed_attempts`. Failed docs retried up to 3 attempts. `clearAllEmbeddings()` resets state. `getHashesNeedingFragments()` catches missing `seq=0` primary embeddings on resume.
- **LLM remote fallback** — `generate()` and `expandQuery()` fall back to local `node-llama-cpp` on transport failures. Structured failure classification: transport errors trigger a 60s cooldown; HTTP errors and `AbortError` do not. Concurrent race guard via pre-fetch cooldown re-check.

---

## v0.5.1 — Documentation Update

Clarified the LLM fallback description in README — transport vs HTTP error distinction, cooldown semantics, "silently falls back" language replaced with explicit cooldown mechanism description. No behavior changes.

---

## v0.5.0 — Conversation Import & Broadened Observation Taxonomy

New `clawmem mine` CLI imports conversation exports from six different chat formats. Observation taxonomy expanded from a single "observation" type into four first-class subtypes. GPT 5.4 reviewed across 3 turns, 6 issues found and fixed (consecutive-assistant loss, unawaited writes, permissive plain-text detection, Slack multi-party handling, preference decay exemption, YAML escaping).

- **`clawmem mine <dir>`** — imports conversation exports from Claude Code, ChatGPT, Claude.ai, Slack, and plain text into the indexing pipeline. New `src/normalize.ts` format normalizer supports all six formats with per-format robustness fixes.
- **New `conversation` content type** — 45-day half-life, 0.55 baseline, optimized for chat-log characteristics (shorter-lived relevance than decisions or docs, but longer than handoffs).
- **Three new first-class observation types** — `preference` (decay-exempt, `Infinity` half-life: user preferences persist indefinitely), `milestone` (60-day half-life), `problem` (60-day half-life).
- **Observer prompt updated** — the local GGUF observer model now extracts preferences, milestones, and problems explicitly, rather than flattening everything into generic observations.
- **Decision-extractor dedicated routing** — each subtype gets dedicated `content_type` treatment instead of the pre-v0.5.0 flattening into a single "observation" bucket.

---

## v0.4.2 — Gray-Matter Frontmatter Sanitization

**Bug fix release.** Resolves `clawmem update` crashes on Obsidian vaults with bare YAML dates or booleans in frontmatter.

`gray-matter` auto-coerces YAML values — `title: 2023-09-27` becomes a `Date` object, `title: true` becomes a boolean. Bun's SQLite driver rejects these as bind parameters with "Binding expected string, TypedArray, boolean, number, bigint or null", crashing the indexer mid-run.

- **Runtime `str()` helper** in `parseDocument()` checks all frontmatter fields and coerces to string.
- **Defense-in-depth `safeTitle` guards** in `insertDocument` / `updateDocument` / `reactivateDocument` catch any Date/boolean leakage past the parse layer.
- Closes [#3](https://github.com/yoloshii/ClawMem/issues/3).

Affected frontmatter fields: `title`, `domain`, `workstream`, `content_type`, `review_by` — any field gray-matter can coerce.

---

## v0.4.0 / v0.4.1 — Version Alignment

Version-number bumps only. No user-visible changes. Kept for npm release continuity between v0.3.4 and v0.4.2.

---

## v0.3.1 — Native Hook Timeout

**Bug fix release.** Shell `timeout` wrappers killed hook processes with exit 124 (no stderr), producing `Failed with non-blocking status code` errors in Claude Code on every hook event.

- **Native `timeout` property** — `clawmem setup hooks` now generates the native Claude Code hook `timeout` field instead of wrapping commands in shell `timeout`.
- **Stop hooks raised from 10s to 30s** — LLM inference in `decision-extractor` / `handoff-generator` / `feedback-loop` regularly exceeds 10s on CPU or under load.
- **All hooks: `timeout` removed from command strings** — only the new native field carries timeout semantics.
- Setup documentation updated with new examples. Troubleshooting entry added.

v0.3.2 / v0.3.3 / v0.3.4 are version-number bumps only with no user-visible changes.

---

## v0.3.0 — OpenClaw Compaction Delegation

**OpenClaw compatibility release.** Reviewed by GPT 5.4 High across 3 turns, 797K tokens.

OpenClaw v2026.3.28+ removed the legacy compaction fallback that `compact()` implementations with `ownsCompaction=false` were relying on. ClawMem's OpenClaw plugin needed to delegate compaction to the runtime directly instead of returning `compacted: false` and expecting OpenClaw to fall back.

- **`compact()` delegates to runtime** — uses `delegateCompactionToRuntime()` from `openclaw/plugin-sdk/core`. `precompact-extract` still runs first as a side-effect so pre-compaction state is captured regardless of who performs the compaction.
- **Bootstrap duplication fix** — `bootstrap()` caches context, `before_prompt_build` consumes it once. Previous behavior invoked bootstrap twice per session.
- **Removed duplicate `before_compaction` hook** — `precompact-extract` now runs once per compaction, not twice.
- **Bootstrap parsing fix** — uses `extractContext()` instead of the legacy `systemMessage` field.
- **New `clearSession()`** for per-session cleanup.
- **Removed unused `bootstrappedSessions` / `isBootstrapped()`** helpers.

Without this fix, OpenClaw sessions never compact on v2026.3.28+.

---

## v0.2.9 — Stop Hook JSON Output Requirement

Documentation-only release. Custom Stop hooks that exit 0 with no stdout cause Claude Code to report `Failed with non-blocking status code: No stderr output`. Documented the root cause and fix pattern in `troubleshooting.md` and `setup-hooks.md`.

---

## v0.2.8 — Stop Hooks on Large Transcripts

**Bug fix release.** Stop hooks were hanging or OOM-ing on transcripts larger than ~10MB because `readTranscript()` loaded the entire file.

- **Backward chunked reader** — up to 5× 2MB chunks read backwards with early exit when the target line count is reached. Raw `Buffer` accumulation with a single UTF-8 decode at the end prevents multi-byte character corruption at chunk boundaries.
- **Single `fd` with `try/finally`** — no descriptor leak.
- **`validateTranscriptPath()` limit raised from 50MB to 1GB** — Claude Code sessions can genuinely produce very large transcripts.

---

## v0.2.7 — Patch Release

Minor fixes. No substantive feature changes beyond v0.2.6.

---

## v0.2.6 — Resilient Lifecycle Tool Search

`memory_pin`, `memory_snooze`, and `memory_forget` now use a 4-stage search cascade instead of BM25-only, preventing `No matching memory found` failures when the document exists but BM25 fails on multi-term queries.

- **`findMemoryCandidates()` cascade** — exact path match → BM25 → title-token overlap → vector similarity. Async pipeline with path detection, stopword filtering, minimum match rule (`max(2, ceil(n/2))` terms), vector fallback on cascade exhaustion.
- **`selectLifecycleTarget()` confidence gate** — ambiguous matches return a candidate list for `memory_forget` (destructive, requires confirmation), top hit for `pin` / `snooze` (non-destructive, single choice).
- `docs/reference/mcp-tools.md` updated with the new search behavior.

---

## v0.2.5 — Hook SQLITE_BUSY Fix

**Bug fix release.** Hook SQLite `busy_timeout` was 500ms while watcher/MCP used 5000ms. During A-MEM enrichment or heavy indexing, watcher write locks exceeded 500ms, causing the hook's DB open to fail with `SQLITE_BUSY` — surfaced as `UserPromptSubmit hook error` in Claude Code.

- **Hook `busy_timeout` raised from 500ms to 5000ms** — matches MCP server.
- Hook still completes within its 8s outer timeout — the raise does not extend user-visible latency, only the patience window.
- Troubleshooting docs appended with new entry (existing context preserved).

---

## v0.2.4 — Watcher Inotify FD Exhaustion Fix

**Bug fix release.** The watcher used `fs.watch(recursive: true)` which registered inotify watches on every subdirectory, including excluded dirs (`gits/`, `node_modules/`, `.git/`). Broad collection paths like `~/Projects` caused 200K+ file descriptors, hanging WSL and triggering inotify limit errors on Linux.

- **Walk directory trees at startup** — skip excluded subtrees using the shared `EXCLUDED_DIRS` from `indexer.ts`.
- **Watch each non-excluded dir individually** (non-recursive) — exact scope instead of blanket recursion.
- **Safety cap: 500 dirs per collection path** — logs a warning if exceeded.
- Exported `EXCLUDED_DIRS` from `indexer.ts` for watcher to share.
- Documented in `troubleshooting.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md`.

Diagnosis command added: `ls /proc/$(pgrep -f "clawmem.*watch")/fd | wc -l` — healthy watchers stay under 15K FDs.

---

## v0.2.3 — Entity Extraction Quality Overhaul

Entity resolution pipeline rewritten with quality filters, type-agnostic canonical resolution, and IDF-based entity edge scoring. Addresses the v0.2.0 entity extraction quality issues flagged during a spot audit — prompts were producing title-as-entity extractions at 67% rate because the LLM echoed named examples from the prompt.

- **`isLowQualityEntity()` filter** — rejects title-as-entity (Levenshtein > 0.85), names longer than 60 chars, template placeholders, trailing colons, and invalid locations.
- **Type-agnostic canonical resolution within compatibility buckets** — `person` / `org` / `location` are isolated; `project` / `service` / `tool` / `concept` merge freely within a shared `tech` bucket, capturing the common LLM confusion between them.
- **IDF-based entity edge scoring** — rare entities create edges, ubiquitous entities alone cannot. Shared-count bonus for multi-entity overlap across documents.
- **Prompt rewrite** — `0-10 entities` (was `3-15` — upper bound too high invited hallucination), generic placeholder (was named examples the LLM echoed at 67% rate), negative instructions for titles and headings.
- **`isValidLocation()`** — positive-signal only (IP addresses, `VM \d+` pattern). No length fallback; the old fallback was accepting FQDN-looking heading fragments.
- **`clearDocEntityState` guard** — handles externally-wiped enrichment state without crashing.
- **`LlamaCpp` → `LLM` interface** refactor for `entity.ts` and `intent.ts` function signatures.
- New `docs/internals/entity-resolution.md` with the bucket system and model quality guidance.

---

## v0.2.2 — Entity Enrichment Idempotency

**Bug fix release.** Entity enrichment could double-count mentions or leave partial state on mid-run failures.

- **`entity_enrichment_state` table** with SHA256(`title+body`) input hash — tracks which documents have been enriched and against what content.
- **Transactional writes** — partial failure rolls back; state is only persisted on full success.
- **Full derived state cleanup on content change** — mentions, counts, edges, co-occurrences all cleared when a document's content hash changes.
- **Concurrent enrichment race protection** — re-reads state inside the transaction to catch a racing second enrichment attempt.
- **Canonical alias dedup before counter mutation** — prevents `mention_count` inflation when the same entity appears under multiple aliases in one document.
- **Watcher race protection** — rechecks input hash after LLM call in case the file changed mid-enrichment.
- **Zero-entity docs marked enriched** — prevents infinite retry on documents the LLM finds no entities in.

---

## v0.2.1 — v0.2.0 Follow-up Fixes

- **`--enrich` flag fix** — `clawmem reindex --enrich` now queues unchanged documents for entity backfill. Previously it only queued changed documents, which meant existing vaults couldn't backfill entities after upgrading.
- **47 new tests** for entity resolution, MPFP graph retrieval, temporal UTC boundary handling, observation invalidation, and memory nudge.
- **Troubleshooting entries** for `--enrich` vs `--force` distinction and the wrapper bypass trap (scripts running `bun run src/clawmem.ts` directly miss GPU env var defaults from the `bin/clawmem` wrapper).

---

## v0.2.0 — Hindsight Pattern Integration

Seven patterns extracted from the [Hindsight](https://github.com/vectorize-io/hindsight) memory engine plus a memory nudge pattern from [Hermes Agent](https://github.com/NousResearch/hermes-agent), reviewed by GPT 5.4 High across three rounds. Introduces entity resolution, multi-path graph retrieval, temporal query extraction, 3-tier consolidation, observation invalidation, and memory nudges.

> ⚠ **Migration required:** Existing vaults upgrading from v0.1.x must run `clawmem reindex --enrich` to populate the new entity tables and trigger A-MEM enrichment on existing documents. `reindex --force` alone is NOT sufficient — the A-MEM pipeline skips entity extraction for update-path documents to avoid churn, so the `--enrich` flag is required to backfill. See [docs/guides/upgrading.md](docs/guides/upgrading.md) and the troubleshooting entry on `reindex --force after v0.2.0 upgrade shows no entity extraction` for details.

- **Entity resolution + co-occurrence graph** — LLM entity extraction with quality filters, type-agnostic canonical resolution within [compatibility buckets](docs/internals/entity-resolution.md) (extensible type vocabulary), IDF-based entity edge scoring, co-occurrence tracking, entity graph traversal for ENTITY intent queries
- **MPFP graph retrieval** — Multi-Path Fact Propagation with meta-path patterns per intent, hop-synchronized edge cache, Forward Push with α=0.15 teleport probability. Replaces single-beam traversal for causal/entity/temporal queries.
- **Temporal query extraction** — regex-based date range extraction from natural language queries ("last week", "March 2026"), wired as WHERE filters into BM25 and vector search
- **4-way parallel retrieval** — temporal proximity and entity graph channels added as parallel RRF legs in `query` tool (Tier 3 only), alongside existing BM25 + vector channels
- **3-tier consolidation** — facts to observations (auto-generated, with proof_count and trend enum) to mental models. Background worker synthesizes clusters of related observations into consolidated patterns.
- **Observation invalidation** — soft invalidation (invalidated_at/invalidated_by/superseded_by columns). Observations with confidence ≤ 0.2 after contradiction are filtered from search results.
- **Memory nudge** — periodic ephemeral `<vault-nudge>` injection prompting lifecycle tool use after N turns of inactivity. Configurable via `CLAWMEM_NUDGE_INTERVAL`.

---

## v0.1.8 — Curator-Nudge Backport + Auto-Archive Lifecycle Hook

- **Curator-nudge event map entry** — `HOOK_EVENT_MAP` was missing the curator-nudge hook; it existed only in skill-forge. Backported so public users get the curator-nudge hook wired correctly.
- **Auto-archive lifecycle hook** — `staleness-check` now runs `getArchiveCandidates` + `archiveDocuments` on session start when lifecycle policy is configured. Fail-open: any error logs and continues, never blocks session startup.

---

## v0.1.6 — Watcher Session Transcript Exclusion

**Bug fix release.** The watcher was processing Claude Code session transcript `.jsonl` files as if they were memory documents, causing SQLite write lock contention that triggered `UserPromptSubmit hook error` on the context-surfacing hook. Watcher now excludes session transcripts explicitly (only `.beads/*.jsonl` is still processed).

v0.1.4 / v0.1.5 / v0.1.7 are version-number bumps with minor doc fixes (tool count correction 25 → 28, hook count fixes, manual hook config reference in `setup-hooks.md`, hook cold start latency notes, stale troubleshooting cleanup).

---

## v0.1.3 — Adaptive Thresholds & Deep Profile Escalation

Context-surfacing moves from absolute score thresholds to ratio-based adaptive thresholds (Tier 1 of the adaptive threshold roadmap). Introduces budget-aware deep-profile escalation that spends remaining hook time budget on query expansion and cross-encoder reranking.

- **Adaptive ratio-based thresholds** — three-layer filtering: activation floor (bail if best result is too weak) + score ratio (keep results within X% of best) + absolute floor (never surface below this). Per profile: `speed` 0.65/0.24/0.18, `balanced` 0.55/0.20/0.15, `deep` 0.45/0.16/0.12. MCP tools remain on fixed absolute thresholds (agents control their own limits).
- **Deep profile budget-aware escalation** — when `CLAWMEM_PROFILE=deep` and the fast path (BM25+vector) finishes under 4s, the remaining time budget is spent on (1) query expansion via LLM to discover candidates keyword+vector missed, and (2) cross-encoder reranking of the top 15 candidates for a deeper relevance signal. Hard stop at 6s; fail-open to fast-path results on GPU failure or timeout. Only fires on `deep`; `speed` and `balanced` unchanged.
- **`deep` profile `minScore` lowered from 0.35 to 0.25** — composite scoring with recency/confidence decay was filtering out all results at 0.35 for vaults with older documents. Validated end-to-end: deep profile returns results in ~2s, well within the 8s hook timeout.
- **Sort results by score before reranking slice** — insertion-order slicing was missing expansion-discovered candidates that ranked highly but arrived later in the pipeline (Codex review finding).
- **Expanded troubleshooting docs** — new entries for snap Bun stdin incompatibility, vector dimension mismatch on fallback model, and balanced vs speed profile retrieval differences.
- README + quickstart warnings against snap Bun installation (snap Bun cannot read stdin, breaks hooks).

---

## v0.1.1 / v0.1.2 — Initial Public Releases

First public releases to npm. Baseline feature set:

- **Hooks + MCP integration** for Claude Code — `session-bootstrap`, `context-surfacing`, `staleness-check`, `decision-extractor`, `handoff-generator`, `feedback-loop`, `precompact-extract`, `postcompact-inject`, `curator-nudge`
- **A-MEM pipeline** — automatic memory note generation, link generation, evolution on document updates
- **QMD retrieval** — BM25 + vector + query expansion + RRF + cross-encoder reranking
- **MAGMA intent classification + graph traversal** — WHY / WHEN / ENTITY / WHAT routing with multi-hop beam search
- **Composite scoring** — half-life decay per content type, attention decay, pin/snooze/forget lifecycle
- **Watcher + embed timer** — systemd user services for continuous vault freshness
- **Curator agent** — 6-phase maintenance workflow for Tier 3 operations agents typically neglect
