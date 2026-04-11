# ClawMem — Release Notes

For upgrade instructions (migration steps, opt-in features, verification commands), see [docs/guides/upgrading.md](docs/guides/upgrading.md). This file is the chronological feature record, newest first.

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
