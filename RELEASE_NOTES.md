# ClawMem — Release Notes

For upgrade instructions (migration steps, opt-in features, verification commands), see [docs/guides/upgrading.md](docs/guides/upgrading.md). This file is the chronological feature record, newest first.

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
- **Multi-user ownership gotcha is documented.** OpenClaw v2026.4.11 enforces that plugin directories be owned by the current runtime user or root, rejecting foreign-owned directories with `suspicious ownership (uid=X, expected uid=Y or root)`. This is a security feature (it prevents a gateway running as a privileged system user from loading code a less-privileged user dropped into its extensions directory). On single-user installs where the gateway runs as your own user account, the ownership check passes automatically. On deployments where the gateway runs as a dedicated system user (e.g. `openclaw`) different from the installer user (e.g. `sciros`), you must `sudo chown -R <gateway-user>:<gateway-group> ~/.openclaw/extensions/clawmem` after running setup. Documented in `docs/guides/openclaw-plugin.md` Install section and `docs/troubleshooting.md` OpenClaw section.

### Test coverage

+2 regression gates on top of the v0.9.0 test baseline, locking in the v2026.4.11 packaging fix:

- `tests/unit/openclaw-plugin.test.ts::cmdSetupOpenClaw defaults to copy mode (v2026.4.11+ compat)` — asserts the `cpSync(pluginDir, linkPath, ...)` call exists in `cmdSetupOpenClaw` and the `--link` opt-in is parsed via `args.includes("--link")`. If a future edit flips the default back to symlink without also updating the assertion, the test fails loudly.
- `tests/unit/openclaw-plugin.test.ts::src/openclaw/package.json declares openclaw.extensions (v2026.4.11+ discovery gate)` — reads `src/openclaw/package.json`, asserts `type === "module"` and `openclaw.extensions` is an array containing `"./index.ts"`. If the manifest is ever deleted or reshaped without updating this test, the suite fails before the change reaches release.

Public test suite: **1105 → 1107, zero regressions.** The one pre-existing assertion in the `Shipping Condition 2 — setup-time migration text is present` suite was updated from `"plugins.slots.memory clawmem"` to `"openclaw plugins enable clawmem"` to match the new next-steps output shape.

### VM 202 end-to-end validation

Captured on a representative multi-user install (VM 202: OpenClaw gateway runs as system user `openclaw`, ClawMem installed by admin user `sciros`, separate from `himadmin`):

```
[plugins] clawmem: plugin registered (kind=memory, bin=/home/sciros/clawmem/bin/clawmem, profile=balanced, budget=800)
[plugins] clawmem: registered 5 agent tools
[gateway] ready (7 plugins: acpx, browser, clawmem, device-pair, phone-control, talk-voice, telegram; 11.3s)
```

The runtime registration log line explicitly emits `kind=memory`, which is the §14.3 change proving the new registration path is live. The `clawmem` entry appears in the gateway ready line alongside the stock plugins, proving the packaging fix clears v2026.4.11's discovery gate. The multi-user ownership check (`suspicious ownership (uid=1001, expected uid=997 or root)`) reproduced and cleared after `sudo chown -R openclaw:openclaw ~/.openclaw/extensions/clawmem`, which is now a documented step in `docs/guides/openclaw-plugin.md` for multi-user deployments.

### Codex review

GPT 5.4 High, session `019d72d5` (continues the session chain used from v0.7.1 through v0.9.0, now cumulative across 20+ turns). The §14.3 implementation reached zero remaining findings before the v2026.4.11 packaging gap was discovered. Codex was re-engaged with the packaging compat delta (new `package.json`, copy-default `cmdSetupOpenClaw`, next-steps rewrite, +2 regression gates, VM 202 e2e evidence) for a final pre-ship pass, same session.

### External credit

- **@withx** — reported the OpenClaw v2026.4.11 incompatibility on yoloshii/ClawMem#5 and confirmed the runtime symptom on a fresh install that did not share any state with the development machines. The external reproduction is what made it clear this was a clean packaging gap, not a machine-specific config drift.

### Upgrading from v0.9.0

v0.10.0 is **drop-in safe for Claude Code users**: `cd ~/clawmem && git pull && systemctl --user restart clawmem-watcher.service`. Nothing on the retrieval path changed.

**OpenClaw users** must also re-run `clawmem setup openclaw` (to switch the extensions dir from symlink to recursive copy), chown the new directory to the gateway user on multi-user installs, and restart the gateway. The full step-by-step is in [docs/guides/upgrading.md](docs/guides/upgrading.md#v090--v0100). **Upgrade OpenClaw to v2026.4.11+ first** — v0.10.0's setup and discovery behavior depend on v2026.4.11's new plugin discovery contract.

---

## v0.9.0 — `<vault-facts>` KG Injection + Session-Scoped Focus Topic Boost

Two context-surfacing upgrades. §11.1 adds a `<vault-facts>` SPO-triple injection block inside `<vault-context>` so the model gets structured "what is currently true about the entities in this prompt" alongside the existing `<facts>` (surfaced documents) and `<relationships>` (memory-graph edges) blocks. §11.4 adds a per-session topic steering lever (`clawmem focus set "<topic>" --session-id <id>`) that biases retrieval toward a declared topic for the duration of a working session without mutating any persisted state. Both changes live exclusively on the read path and are fail-open — the baseline pre-v0.9.0 `<vault-context>` shape is byte-identical when the new stages don't fire, and every downstream stage (threshold, diversification, token budget, injection) is unchanged. v0.8.5 was the last feature release; v0.9.0 is **drop-in safe**: one idempotent expression-index migration, no breaking API changes, no required reindex/embed, no schema rewrites.

### §11.1 — `<vault-facts>` knowledge-graph injection

- **Three-path prompt-only entity extraction** — the seed set for `<vault-facts>` comes from the raw prompt ONLY, via three independent paths: (a) a canonical `vault:type:slug` regex (e.g. `default:project:clawmem`), (b) proper-noun extraction validated via exact-match `resolveEntityTypeExact` that skips ambiguous names resolving to multiple types, and (c) a longer-first n-gram scan (3-gram > 2-gram > 1-gram, cased + lowercased) for technical vocabulary like `forge-stack`, `oauth2`, `vm 202`. Prompt-only is a HARD CONSTRAINT — entity seeds never come from `surfacedDocs[i].body` or any retrieval-phase field, so a topic-boosted off-topic doc from §11.4 cannot pollute the facts block with facts about unrelated entities.
- **Validate-then-count candidate ordering (Codex §11.1 Turn 5 invariant)** — per-path, candidates are validated against the entity index BEFORE counting against the 100-candidate cap. Without this ordering, a long prompt dominated by unvalidated capitalized noise (path b raw extraction) would starve the lowercase/hyphenated n-gram lane (path c) and the technical-vocabulary recall would silently drop. The cap also preserves prompt order as a tiebreaker so the first mentioned entities win under pressure.
- **Cross-path entity-id dedup + longer-n-gram tie-breaker** — if the same entity resolves via multiple paths (e.g. "ClawMem" as a proper noun AND "clawmem" as a 1-gram), the cross-path dedup collapses it to one `entity_id` and the sourcePath from the first-matching path wins. For n-gram ties, longer n-grams outrank shorter ones (`forge-stack` as a 1-gram compound beats `forge` + `stack` as separate tokens).
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

- **LLM-based SPO extraction replaces the old regex path** — the observer LLM now emits structured `<triples>` blocks alongside `<facts>`, parsed and validated in `parseObservationXml` against a fixed predicate vocabulary. The pre-v0.8.5 regex-based `extractTripleFromFact` required `subject verb object` sentence shape, which rejected the majority of real observation facts (descriptive phrases like "ClawMem now deploys via systemd user units on VM 202"). The LLM path extracts relational claims without sentence-shape constraints. `VALID_PREDICATES` is a tight 13-predicate set — `adopted`, `migrated_to`, `deployed_to`, `runs_on`, `replaced`, `depends_on`, `integrates_with`, `uses`, `prefers`, `avoids`, `caused_by`, `resolved_by`, `owned_by` — and the parser rejects anything outside it. `LITERAL_PREDICATES` marks `prefers`/`avoids` as literal-object predicates (object is stored as a string, not resolved to an entity).
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
