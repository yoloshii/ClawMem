# Upgrading ClawMem

Guide for upgrading between released versions. Current: **v0.27.0**.

ClawMem upgrades are designed to be drop-in: pull the new version, restart any long-lived processes, and the SQLite schema auto-migrates on first open. This guide documents per-version specifics for upgrades that have additional considerations beyond the quick path below.

## Quick path

```bash
# Option A: npm / bun global install
bun update -g clawmem   # or: npm update -g clawmem

# Option B: source install
cd ~/clawmem && git pull

# Restart long-lived processes to pick up the new code
systemctl --user restart clawmem-watcher.service  # if installed as a user unit
```

Hooks (spawned fresh per Claude Code invocation) and the MCP stdio server (respawned per Claude Code session) pick up new code automatically on their next invocation — no restart required for those. Only persistent daemons like `clawmem watch`, `clawmem serve`, and the systemd embed/watcher/curator units need to be restarted.

### What auto-applies on first open

All schema changes from v0.7.1 → v0.9.0 are additive and idempotent:

- New tables via `CREATE TABLE IF NOT EXISTS`
- New columns via `ALTER TABLE ADD COLUMN` wrapped in `try/catch`
- New indexes via `CREATE INDEX IF NOT EXISTS` (v0.9.0 adds `idx_entity_nodes_lower_name` on `entity_nodes(LOWER(name), vault)` — built idempotently on first open)
- A per-database feature-detect cache so ad-hoc stores that skip the migration path degrade transparently (they never write columns that don't exist)

The first time any v0.7.1+ process opens an existing vault, the migrations run silently. Hook invocations alone are sufficient — you do not need a manual upgrade command.

### What you do NOT need to run

- `clawmem embed` — embedding contract and fragment boundaries are unchanged across v0.7.x → v0.9.0
- `clawmem reindex` — document storage is unchanged
- `clawmem reindex --enrich` — no new enrichment stages added in v0.9.0
- `clawmem build-graphs` — no new graph edge types
- `clawmem setup hooks` — hook configuration is unchanged (no new hooks, no renamed hooks, no changed budgets)
- `bun install` / `npm install` — no dependency changes in `package.json` between v0.7.0 and v0.9.0
- Edit `~/.config/clawmem/config.yaml` — no required fields added

---

## Reranker: zerank-2 GGUF deprecated → seq-cls sidecar

If you followed an earlier "SOTA upgrade" and are running the **`zerank-2-Q4_K_M` GGUF reranker** on `:8090`, **replace it.** That GGUF is broken: llama.cpp's `convert_hf_to_gguf.py` only synthesizes a rerank head when the model card contains the literal `# Qwen3-Reranker`, which zerank-2's card lacks — so the previously-recommended GGUF (and any built by the current/standard llama.cpp converter) is a headless causal LM that produces near-zero, uninformative scores under `--reranking`. Reranking silently degrades to an RRF-dominated passthrough.

**Migration** — serve zerank-2 via the seq-cls sidecar instead (transformers, bf16; ships a reproducible correctness gate):

```bash
cd extras/rerankers/zerank-2-seq
docker compose build
HF_TOKEN=hf_xxx docker compose run --rm convert   # download + convert + verify
docker compose up -d reranker                      # /v1/rerank on :8090
```

`CLAWMEM_RERANK_URL` already points at `:8090`, so nothing else changes. **zembed-1** (embedding) and **qwen3-reranker-0.6B** (default reranker) are unaffected. See [`extras/rerankers/zerank-2-seq/`](../../extras/rerankers/zerank-2-seq/) for details and the non-commercial (CC-BY-NC-4.0) license note.

---

## v0.27.0: authorship time (`authored_at`) + entity-edge IDF fix

Drop-in; the `authored_at` column and its index auto-migrate on first open. What changes and what to know:

- **Ranking recency now runs on effective time** — `authored_at` (when the content was originally written) when known, `modified_at` otherwise. Documents without `authored_at` behave exactly as before, so an existing vault is unaffected until content carries dates.
- **New mines are dated automatically.** `clawmem mine` extracts per-message timestamps from Claude Code / codex / Claude.ai / ChatGPT / Slack exports and stamps each exchange chunk; synthesized facts inherit their source's date.
- **Dating an already-mined vault:** either re-run `clawmem mine` over the same export directory — previously-mined documents take a metadata-only "dated" transition (no `modified_at` bump, no re-enrichment, no re-embed) — or run `clawmem mine <dir> -c <collection> --backfill-dates` (dry-run report), then `--backfill-dates --apply`. Both are safe to repeat; documents whose content no longer matches the source are skipped.
- **Colliding source filenames are now disambiguated.** Two transcripts that sanitize to the same staging name (e.g. `a/b.jsonl` and `a_b.jsonl`) previously overwrote each other silently; they now mine under distinct hash-suffixed names. Non-colliding sources keep their existing names — no path churn.
- **Hand-dated notes:** any indexed file may declare `authored_at:` in frontmatter (RFC3339 with timezone, or date-only `YYYY-MM-DD` = UTC midnight; quoted or unquoted). Removing the line clears the stored date on the next content change.
- Temporal queries ("what did we plan in March"), the recent-decision windows (postcompact, session bootstrap, `clawmem reflect`, profile), and directory context all use effective time; operational clocks (dedup window, lifecycle sweeps, staleness review) intentionally do not.
- Entity-graph enrichment now computes IDF over active documents only and never creates edges toward archived documents (completes the v0.25.0 hub-bias fix); existing edges are unaffected.

## v0.26.0: offline eval harness + short memory-query fix

No migration steps, no schema change, no re-embed — drop-in. Restart long-lived processes per the quick path. Behavior notes:

- **New offline eval subsystem** (`clawmem eval run --gold <file.jsonl>`): replays gold-labeled queries through the real `query` tool handler and scores them (doc-level Jaccard, precision/recall@k, hit@k, MRR). Purely additive — no runtime surface changes; nothing to run unless you build a gold set. See [docs/guides/eval-harness.md](eval-harness.md).
- **Short explicit memory queries now reach retrieval.** Prompts under 20 characters that match the memory-intent force patterns ("what did I say?", "recall …", "what's my email?") previously returned an empty `<vault-context>` from the length gate; they now run retrieval. Expect context injection on short memory questions that used to come back empty. Greetings, slash commands, and other short non-memory prompts are unchanged.

## v0.25.0: extraction retries + decision half-life + entity-neighbor ranking

No migration steps, no schema change, no re-embed — drop-in. Restart long-lived processes per the quick path. Behavior notes:

- **LLM extraction paths retry on malformed responses** (observer, conversation-synthesis, A-MEM, entity extraction): up to 3 attempts with error feedback under one hard wall-clock budget. Expect occasional multi-call extraction where a single call previously failed silently; terminal exhaustion logs `[llm-retry] <site>: exhausted…`. `mine --synthesize` failure counts now reflect terminal failures only (transient-recovered calls no longer count).
- **`decision` recency now decays on a 180-day half-life** (was infinite). Old, unaccessed decisions gradually stop outranking fresh material on composite surfaces; frequently-accessed decisions stretch toward 3× via the existing access extension. No deletion or archival — lifecycle policy is unchanged.
- **Entity-neighbor ranking (`intent_search` ENTITY channel and the `query` entity walk) reorders**: neighbors now rank by co-occurrence blended with IDF specificity instead of raw count — ubiquitous hub entities drop, specific entities rise; archived documents no longer appear in neighbor results.

## v0.24.0: raw-BM25-primary ranking on `search`

No migration steps — drop-in. Behavior notes:

- **MCP `search` ordering changes for non-recency queries**: results now rank by the raw BM25 transform instead of the composite blend (judged keyword eval: raw MRR 0.848 vs composite 0.415 over 43 targets; the composite lost even the fresh-doc-favorable slice). If you depended on recency/quality multipliers reordering keyword results, phrase the query with recency intent ("recent …", "latest …") — that branch keeps composite — or use `query`.
- **`minScore` on `search` is now raw-basis with NO default** for non-recency queries: omitted = no filter, explicit `0` honored. Previous composite-scale floors (e.g. `0.3`) do not translate — the raw transform maps `0.70 ⇔ |bm25| ≈ 2.3` and `0.85 ⇔ |bm25| ≈ 5.7`.
- **`structuredContent.scoreBasis`** on `search` reports `"fts-bm25"` (non-recency) or `"composite"` (recency-intent). Consumers that parsed the compact `score` as a composite value should read the basis field.
- **CLI `search`, REST, hooks, `query`, and `memory_retrieve` are unchanged** — the ranking-contract change is scoped to the MCP `search` tool, exactly as evaluated.
- New ops knob: `CLAWMEM_DISABLE_FTS_BYPASS=true` disables the query-pipeline strong-signal bypass at both consumers (MCP + CLI) — harness/incident use.

## v0.23.0: monotonic BM25 exposed score

No migration command, no schema change, no re-embed. Restart long-lived processes per the quick path.

**Behavior change — the exposed FTS score is a real relevance signal.** Through v0.22.0 a clamp bug flattened every FTS result's `score` to the constant 1.0, so ranking on the BM25 surfaces (`search`, REST keyword mode, CLI search, `memory_retrieve` keyword and its semantic-mode FTS fallback, hook FTS lanes) was effectively metadata-only. The score is now `|bm25|/(1+|bm25|)` — bounded [0,1), higher is better. What to expect after upgrading:

- `search` results reorder toward keyword relevance; reported scores drop from the old flat values and vary per hit. If a workflow compared `search` scores against a hardcoded cutoff tuned to the constant-1.0 era, re-tune it (the composite floor semantics of `minScore` are unchanged; the observed values shifted).
- The `query` pipeline's strong-signal bypass actually fires now on unambiguous keyword queries (skipping LLM expansion, which makes those calls faster) — and no longer fires on a lone weak match.
- `memory_forget` targeting is stricter: weak keyword matches return a disambiguation list instead of auto-selecting. If a script relied on forget acting on any single match, it must now pass a more specific query or a path.
- `clawmem doctor`/curator's BM25 probe reports honestly — a near-empty vault may now show a degraded BM25 probe where it previously passed vacuously.

---

## v0.22.0: raw-cosine ranking on the direct vector routes

No migration command, no schema change, no re-embed. Restart long-lived processes per the quick path.

**Behavior change — MCP `vsearch` and `memory_retrieve` semantic/discovery rank non-recency queries by RAW cosine.** Reported scores on those routes are raw cosine (`scoreBasis: "vector-cosine"`), not composite values — expect a different numeric scale (unrelated results sit near ~0.4–0.55 on compressed-band embedding models, not near 0). `vsearch`'s `minScore` filters that raw scale and no longer defaults to 0.3 — omitted means no filter. If a workflow passed `minScore` tuned to composite values, re-tune it to your embedding model's band or omit it. Recency-phrased queries ("latest…", "recently…") behave exactly as before on every route.

**Pinned documents** no longer float above more relevant results on those two routes — pin now means lifecycle retention plus winning exact-score ties. Hooks, `query`, and `search` keep the +0.3 composite pin boost.

**`retrieval.mcp_direct_tuned_weights` / `CLAWMEM_MCP_DIRECT_TUNED_WEIGHTS` no longer has any effect** (superseded by its own gating eval). Configs that set it keep working; a once-per-process warning is logged — remove the key at your convenience.

---

## v0.21.0: MCP internal-collection exclusion + embedding-geometry canary

No migration command required. Two things to know:

**Behavior change — `_clawmem` excluded from MCP retrieval by default.** `search`, `vsearch`, `query`, `query_plan`, `memory_retrieve`, and `find_similar` no longer return the system-internal `_clawmem` collection (observations/deductions/handoffs) unless asked. If a workflow depended on those appearing in MCP results, pass `includeInternal: true` or name `_clawmem` in an explicit `collection` filter. `intent_search`, `find_causal_links`, `kg_query`, `session_log`, and `timeline` are unfiltered by design, and hooks already filtered internal docs — `<vault-context>` behavior is unchanged. Details: [docs/reference/mcp-tools.md](../reference/mcp-tools.md).

**What auto-applies on first open** (additive, idempotent — same contract as prior releases): the `embed_canary` and `vault_flags` tables, and an `embed_input_fp` column on `content_vectors`.

**No re-embed required.** Existing vectors stay valid. Pre-0.21.0 rows carry no input fingerprint, so `clawmem doctor`'s new sampled vector validation checks them structurally and flags title provenance as unavailable ("legacy") until each document's next natural re-embed — informational, not an error.

**The canary baseline seeds itself.** The first `clawmem embed` run after upgrade (including a timer-fired one) probes the embedding server with a pair-separation battery and persists a first-healthy baseline; subsequent runs alert relative to it, and a broken-geometry server now aborts `embed --force` BEFORE anything is cleared. `--force-geometry` (proceed despite a failed probe; the vault is flagged tainted until a verified rebuild) and `--force --recalibrate-canary` (replace the baseline after a deliberate model/server change) are operator overrides, not upgrade steps.

**Opt-in knob:** `retrieval.mcp_direct_tuned_weights` (config) / `CLAWMEM_MCP_DIRECT_TUNED_WEIGHTS` (env), default `false` — scored the MCP direct tools' non-recency queries with the retrieval-tuned `query`-tool weights. *(Superseded in v0.22.0 — the knob no longer has any effect; see the v0.22.0 section above.)*

Upgrades from v0.13 → v0.20 shipped no steps beyond the [quick path](#quick-path) — schema changes auto-apply; see [RELEASE_NOTES.md](../../RELEASE_NOTES.md) for what each version changed.

---

## v0.12.0: query reranking blend (no action required)

v0.12.0 changes the `query` tool's rerank/RRF blend so the cross-encoder reranker can promote the best document to the top — the previous blend left RRF #1 mathematically immovable. It is a pure ranking-quality change: **no migration, no schema change, no config change.** It applies automatically on upgrade. Hooks and the per-session MCP stdio server pick it up on their next invocation; restart any long-lived `query` host — `clawmem serve` and persistent MCP/daemon processes — to pick up the improved ordering. The default reranker (`qwen3-reranker-0.6B`) is unchanged, and the blend improvement applies whatever reranker `:8090` serves. (`intent_search` and the context-surfacing hook keep their existing blends.)

---

## v0.10.3 → v0.10.4

v0.10.4 fixes [issue #11](https://github.com/yoloshii/ClawMem/issues/11) — `clawmem setup openclaw` previously hardcoded `~/.openclaw/extensions/clawmem` and ignored `OPENCLAW_STATE_DIR`, breaking installs into custom OpenClaw profiles. The fix is non-breaking: vault on disk is byte-identical, no schema changes, no env-var changes for users on the default profile, no retrieval-pipeline or hook changes. Pure `bun update -g clawmem`.

### Behavior changes you should know about

- **`clawmem setup openclaw` is now profile-aware.** When the `openclaw` CLI is on `PATH`, ClawMem delegates to `openclaw plugins install <pluginDir> --force`. OpenClaw owns destination resolution, which respects `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and any active `--profile` flag. The plugin is **auto-enabled** as part of the install (OpenClaw's `persistPluginInstall` writes install records, applies slot selection, and refreshes the registry). The post-install "Next steps" output no longer prints `openclaw plugins enable clawmem` because the install path already did it.
- **CLI-absent fallback.** If `openclaw` is not on `PATH`, ClawMem falls back to a recursive copy that also honors `OPENCLAW_STATE_DIR` (via a faithful mirror of OpenClaw's `resolveConfigDir`). The fallback path keeps the original 4-step output including `openclaw plugins enable clawmem` because direct-copy doesn't auto-enable.
- **`--link` mode now does the right thing in both paths.** The delegated path invokes `openclaw plugins install -l`, which records the source in `plugins.load.paths` (NOT a filesystem symlink) — discovery uses the load-path entry, so the v2026.4.11 symlink-discovery skip does NOT apply. The fallback path still creates a real filesystem symlink, which OpenClaw v2026.4.11+ skips during discovery; install OpenClaw to get the cleaner delegated behavior.
- **`--remove` is legacy-compatible.** `clawmem setup openclaw --remove` first tries `openclaw plugins uninstall clawmem --force` (when the CLI is available) and falls back to manual cleanup at the resolved extensions path for legacy unmanaged installs from earlier ClawMem versions. On CLI uninstall failure ClawMem warns the user that OpenClaw config and install records may still need manual repair, then runs the fallback cleanup.
- **`clawmem setup openclaw --help` works.** Pre-v0.10.4 ran the install instead of printing help. v0.10.4 short-circuits the `--help` / `-h` flag at the top of the handler and prints the full flag + env-var reference.

### Custom profile users (the headline win)

If you run OpenClaw with a non-default profile, the upgrade is now a one-liner:

```bash
# Pre-v0.10.4 (broken): installed into ~/.openclaw regardless of OPENCLAW_STATE_DIR
OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw

# v0.10.4+: installs into ~/.openclaw-dev/extensions/clawmem as expected
OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw
```

If you previously worked around the bug by manually copying the plugin directory into your profile, you can now run `clawmem setup openclaw --remove` (in the affected profile via `OPENCLAW_STATE_DIR`) and then a fresh `clawmem setup openclaw` to land cleanly. Or leave the manual copy in place — v0.10.4 is backwards-compatible and `--remove` will fall back to manual cleanup if the CLI uninstall fails because the install isn't in OpenClaw's records.

### Quick path

```bash
# Source install
cd ~/clawmem && git pull

# Or via npm/bun
bun update -g clawmem

# Re-run setup so any new behavior takes effect (idempotent)
clawmem setup openclaw

# Restart long-lived processes (only if you re-installed the plugin)
sudo systemctl restart openclaw-gateway.service   # or your gateway unit
```

No schema migration. No vault changes. The OpenClaw plugin source under `src/openclaw/` is unchanged from v0.10.3 — the change is entirely in `cmdSetupOpenClaw` (and a new `src/openclaw-paths.ts` helper module that mirrors OpenClaw's path-resolution semantics for the CLI-absent fallback). See [docs/guides/openclaw-plugin.md](openclaw-plugin.md#install) for the full Install reference and [docs/troubleshooting.md](../troubleshooting.md#openclaw) for the symptom→fix entries this release closes.

## v0.9.0 → v0.10.0

v0.10.0 is the OpenClaw pure-memory migration (§14.3). It changes how the ClawMem plugin registers with OpenClaw and updates `clawmem setup openclaw` to produce a layout that the v2026.4.11+ plugin discoverer actually finds. There are no schema changes, no new env vars, and no changes to the retrieval pipeline, hook set, or agent tools. The vault on disk is byte-identical to v0.9.0. Claude Code users who do not run OpenClaw can upgrade with no action beyond `git pull`.

**Why the migration, in one paragraph.** OpenClaw and Hermes have converged on a two-surface plugin model — one slot for memory plugins (cross-session, retrieval-first) and a separate slot for context-engine plugins (in-session, compaction-first). Under that model ClawMem is a memory layer, not a context engine, and Hermes has always had it plugged in correctly via `MemoryProvider`. Pre-v0.10.0 the OpenClaw integration occupied the context-engine slot only because OpenClaw had no separate memory slot at the time. v0.10.0 moves ClawMem to the OpenClaw `memory` slot and frees the `context-engine` slot for genuine compression/compaction plugins like `lossless-claw`. You can now run both at once. See [RELEASE_NOTES.md](../../RELEASE_NOTES.md#v0100--openclaw-pure-memory-migration-143--v20264.11-packaging-fix) and [docs/guides/openclaw-plugin.md](openclaw-plugin.md#memory-vs-context-engine--the-dual-plugin-surface) for the full rationale.

**OpenClaw users MUST upgrade to OpenClaw v2026.4.11+** before running v0.10.0's `clawmem setup openclaw`. The new discovery contract and the new install layout both depend on behavior that only exists in OpenClaw v2026.4.11 and later.

### Quick path

```bash
# Source install
cd ~/clawmem && git pull

# Restart long-lived daemons (still needed if you run the watcher / serve as a user unit)
systemctl --user restart clawmem-watcher.service

# OpenClaw users: re-run setup so the plugin dir switches from symlink to recursive copy
clawmem setup openclaw

# Multi-user installs only: chown the new plugin dir to the gateway user
#   (see docs/guides/openclaw-plugin.md for the full ownership gotcha)
sudo chown -R <openclaw-gateway-user>:<gateway-group> ~/.openclaw/extensions/clawmem

# Then restart the gateway so it re-discovers the plugin
sudo systemctl restart openclaw-gateway.service   # or whatever your gateway unit is called
```

Hooks and the stdio MCP server pick up the new binary automatically on their next invocation — no `clawmem setup hooks` re-run needed.

### What changed under the hood

- **Plugin registers as `kind: memory`, not `kind: context-engine`.** The adapter in `src/openclaw/` no longer exposes a `ClawMemContextEngine` class. Lifecycle events on the plugin-hook bus: `before_prompt_build` is the **load-bearing** path, running prompt-aware retrieval AND the pre-emptive `precompact-extract` synchronously when token usage approaches the compaction threshold (captures state strictly before the LLM call that could trigger compaction, no race with the compactor); `agent_end` runs decision-extractor + handoff-generator + feedback-loop in parallel; `before_compaction` is **defense-in-depth fallback only** — fire-and-forget at OpenClaw's call site, races the compactor, exists for the rare case where the proximity heuristic in `before_prompt_build` missed a sudden token jump; `session_start` registers the session and caches first-turn bootstrap. The retrieval pipeline, composite scoring, profiles, vault format, and the 5 registered agent tools are unchanged. This is a packaging and registration change, not a behavioral one. v0.3.0 did the pre-emptive extraction from `ContextEngine.compact()` via `delegateCompactionToRuntime()`; v0.10.0 moves it up the stack into `before_prompt_build` where it has a real pre-LLM hook to await on, and demotes the compaction-entry-point handler to the fallback role.
- **`plugins.slots.memory: "clawmem"` replaces `plugins.slots.contextEngine: "clawmem"`.** On the new pure-memory plugin, the exclusive slot is `memory`. The `setup openclaw` next-steps output tells you to run `openclaw plugins enable clawmem`, which sets the slot and disables competing memory plugins (`memory-core`, `memory-lancedb`) in a single command. You do NOT need to run the older `openclaw config set plugins.slots.contextEngine clawmem` pattern on v0.10.0.
- **`src/openclaw/package.json` is now the plugin's discovery manifest.** OpenClaw v2026.4.11's `discoverInDirectory` reads `package.json` for the `openclaw.extensions` field and uses that to decide whether a directory under `~/.openclaw/extensions/` is a valid plugin. The older `openclaw.plugin.json` manifest is still shipped and parsed at runtime, but it is not sufficient to pass discovery on v2026.4.11+ without the `package.json` companion file. v0.10.0 adds the `package.json` to the plugin source tree, and `clawmem setup openclaw` verifies it is present before copying.
- **`clawmem setup openclaw` defaults to recursive copy instead of symlink.** OpenClaw v2026.4.11 walks `~/.openclaw/extensions/` with `readdirSync({ withFileTypes: true })` and uses `dirent.isDirectory()` to descend into candidate plugin directories. Symlinks to directories report `isDirectory() === false` on that API shape, so a symlinked plugin is silently skipped during discovery. v0.10.0's `cmdSetupOpenClaw` therefore copies the plugin source into `~/.openclaw/extensions/clawmem/` with `cpSync(..., { recursive: true, dereference: true })`. A `--link` opt-in flag preserves the old symlink behavior for local development and for older OpenClaw versions, with a warning that v2026.4.11+ discovery will skip the symlink. Setup is idempotent: any existing plugin directory or stale symlink is removed before the new copy is written.
- **Multi-user ownership check (OpenClaw v2026.4.11+).** If the gateway runs as a dedicated system user (e.g. `openclaw`) and you run `clawmem setup openclaw` as a different user (e.g. `alice`), the copied plugin directory is owned by the installer user, but OpenClaw's ownership check rejects it with `suspicious ownership (uid=1001, expected uid=997 or root)`. This is a security feature that prevents a privileged gateway process from loading code a less-privileged user dropped into its extensions directory. Fix: `sudo chown -R <gateway-user>:<gateway-group> ~/.openclaw/extensions/clawmem`. Single-user installs where you ARE the gateway user are not affected — your own user owns the copy, and the ownership check passes.

### Rollback

Rolling back to v0.9.0 is a `git checkout v0.9.0 && clawmem setup openclaw --link` away. The `--link` flag produces the old symlink layout, which is what v0.9.0 expected. If you are rolling back because you are on an OpenClaw version older than v2026.4.11, the symlink layout will still work (pre-v2026.4.11 discovery did not require the `package.json` file and did not have the `dirent.isDirectory()` gate). You do not need to downgrade OpenClaw.

If you rolled back and still see `context engine 'clawmem' is not registered`, remove the stale slot config: `openclaw config set plugins.slots.memory ""` and `openclaw config set plugins.slots.contextEngine clawmem`, then restart the gateway.

### What you do NOT need to run

- `clawmem embed` — embedding contract is unchanged
- `clawmem reindex` — document storage is unchanged
- `clawmem reindex --enrich` — no new enrichment stages in v0.10.0
- `clawmem build-graphs` — no new graph edge types
- `clawmem setup hooks` — Claude Code hook configuration is unchanged
- `bun install` / `npm install` — no dependency changes

---

## v0.8.5 → v0.9.0

v0.9.0 adds two new context-surfacing features — `<vault-facts>` KG injection and session-scoped focus topic boost — and is **drop-in safe**. One idempotent expression-index migration, no breaking API changes, no schema rewrites, no reindex/embed/graph-build needed. All behavior changes on existing code paths are additive and fail-open: if the new stages don't fire (no entity seeds from the prompt, no focus file set), the `<vault-context>` output is byte-identical to v0.8.5.

### Quick path

```bash
bun update -g clawmem   # or: npm update -g clawmem
# Or source install:
cd ~/clawmem && git pull

# Restart long-lived daemons so they pick up the new context-surfacing stages
systemctl --user restart clawmem-watcher.service
# If you run `clawmem serve` or `clawmem watch` in systemd, restart those too.
```

Hooks + MCP stdio pick up new code automatically on next invocation — no restart needed for those.

### What changes on first open

- **Expression index migration** — `store.ts` runs `CREATE INDEX IF NOT EXISTS idx_entity_nodes_lower_name ON entity_nodes(LOWER(name), vault)` on first open. Idempotent. Backs the §11.1 batch `LOWER(name) IN (...) AND vault = ?` lookup on the entity-detection hot path. Without this index the batch query would degrade to a full scan on large vaults. No action needed from you — the migration runs once on the first process that opens the vault.
- **Profile config** — `PROFILES` gains a new `factsTokens` field. Defaults: `speed=0` (stage off), `balanced=200`, `deep=250`. If you have a custom profile wrapper or override `PROFILES` in code, add the field. Default behavior unchanged.

### New `<vault-facts>` block in `<vault-context>`

When the user's prompt mentions entities already known to the vault (via `entity_nodes`), `context-surfacing` now appends a token-bounded `<vault-facts>` block of raw SPO triple lines to `<vault-context>`, alongside the existing `<facts>` / `<relationships>` blocks. This feeds the model current-state knowledge about entities the user is talking about, without requiring the agent to call `kg_query` explicitly.

- **Three-path entity seeding** — canonical-ID regex (e.g. `default:project:clawmem`) → proper-noun extraction via `resolveEntityTypeExact` → longer-first n-gram scan (3-gram > 2-gram > 1-gram) for lowercase/hyphenated vocabulary like `side-project`, `oauth2`, `vm 12`. All three paths run prompt-only — entity seeds NEVER come from surfaced doc bodies, so topic-boosted off-topic docs cannot pollute the facts block.
- **Profile-gated token sub-budget** — `factsTokens=0` on `speed` disables the stage entirely. `balanced` uses 200 tokens, `deep` uses 250. The sub-budget is dedicated — `<vault-facts>` cannot steal budget from `<facts>` or `<relationships>`.
- **Truncation** — at the triple boundary, never mid-triple, never emits an empty block.
- **Fail-open** — empty entity set → skip. Budget too small → drop block. Per-entity DB error → skip that entity. Any exception in the stage → return baseline `vault-context` unchanged.

No configuration required. You can verify the block appears by running `echo "tell me about <some entity from entity_nodes>" | clawmem surface --context --stdin` after upgrade.

### New `clawmem focus` CLI — session-scoped topic boost

Three new subcommands write a per-session focus file that steers context-surfacing for that session only:

```bash
clawmem focus set "authentication flow"                       # uses CLAUDE_SESSION_ID env var
clawmem focus set "authentication flow" --session-id abc123   # explicit
clawmem focus show --session-id abc123
clawmem focus clear --session-id abc123
```

When a focus topic is set:

- Threaded as `intent` hint to `expandQuery` / `rerank` / `extractSnippet` (the existing query-time lever).
- Post-composite-score boost: 1.4× match, 0.75× demote (floor 50%), applied AFTER `applyCompositeScoring` and BEFORE the adaptive threshold filter.
- **Zero matches in the current result set → NO-OP.** The topic boost early-returns without mutating `compositeScore`, so the baseline threshold filter sees byte-identical ordering and the result set never shrinks because of a non-matching topic. Locked in by hook-level integration tests.

Session isolation contract: the focus file is keyed by `sessionId` and never writes to SQLite, never mutates `confidence` / `status` / `snoozed_until` / any lifecycle column. Concurrent sessions on the same host cannot cross-contaminate each other's topic biasing. `CLAWMEM_SESSION_FOCUS` env var is a debug-only override that does NOT provide per-session scoping — do not rely on it in multi-session deployments. `CLAWMEM_FOCUS_ROOT` override is available for hermetic testing.

### What you do NOT need to run

- `clawmem embed` — no embedding changes
- `clawmem reindex` — no document storage changes
- `clawmem reindex --enrich` — no new enrichment stages
- `clawmem build-graphs` — §11.1 reads from existing `entity_triples` populated by the v0.8.5 SPO pipeline
- `clawmem setup hooks` — hook configuration is unchanged; Claude Code invokes `${binPath} hook ${name}` at runtime, so upgrading the binary propagates the new context-surfacing behavior automatically

### Rollback

If you need to roll back to v0.8.5, the `idx_entity_nodes_lower_name` index is harmless on pre-v0.9.0 code — SQLite will simply ignore it. No data cleanup required, no compatibility shim needed.

---

## v0.8.4 → v0.8.5

v0.8.5 is a drop-in fix for the SPO triple extraction bug cluster (see RELEASE_NOTES.md entry for the full bug list). `entity_triples` stayed at zero on pre-v0.8.5 vaults regardless of activity, making `kg_query` return empty for every entity. v0.8.5 fixes the population path end-to-end. No schema changes, no new env vars, no new dependencies, no breaking API changes. All behavior changes are additive.

### Quick path

```bash
bun update -g clawmem   # or: npm update -g clawmem
# Or source install:
cd ~/clawmem && git pull

# Restart long-lived daemons so they pick up the new decision-extractor pipeline
systemctl --user restart clawmem-watcher.service
```

Claude Code hooks and the stdio MCP server pick up the new code automatically on their next invocation — no `clawmem setup hooks` re-run needed. The hook command in `~/.claude/settings.json` is `${binPath} hook ${name}`, which resolves at runtime to the upgraded binary.

### What changed behaviorally

- **`entity_triples` actually populates now.** The decision-extractor Stop hook persists observer-emitted SPO triples into `entity_triples` using canonical `vault:type:slug` entity IDs shared with A-MEM. Eligible observation types are `decision`, `preference`, `milestone`, `problem`, `discovery`, `feature`.
- **`kg_query` accepts canonical IDs as well as entity names.** Callers that already resolved an entity via `searchEntities` or `list_vaults` output can now round-trip the canonical ID (e.g. `default:project:clawmem`) directly into `kg_query` without going through a name-based fallback that would fabricate a different ID.
- **Tight predicate vocabulary** — only `adopted`, `migrated_to`, `deployed_to`, `runs_on`, `replaced`, `depends_on`, `integrates_with`, `uses`, `prefers`, `avoids`, `caused_by`, `resolved_by`, `owned_by` are emitted. Anything the observer produces outside this set is silently dropped at parse time.
- **Observation path disambiguation.** Multiple observations of the same type within one Claude Code session no longer collide on filename — the new path scheme embeds an 8-char `obsHash` slice so each observation gets a unique document row. Pre-v0.8.5 sessions silently lost the second-onward observation per type.

### Do I need to clean up dead pre-v0.8.5 data?

**Optional.** Pre-v0.8.5 runs left two kinds of harmless dead data in SQLite:

1. `entity_nodes` rows with `entity_type='auto'` — minted by the old regex-based triple path. `'auto'` is not a valid compatibility bucket, so these entities never resolve via `kg_query` — they cost a few KB of storage and nothing else.
2. `entity_triples` rows with schema-placeholder `source_fact` values (e.g. `"Individual atomic fact"`, `"canonical entity name"`) — the 1.7B observer occasionally echoed example text from the old prompt into real facts.

Neither affects correctness or query results going forward, because v0.8.5 writes canonical IDs only and the new prompt + parser filter placeholder strings before persistence. Clean them if you want a tidy store:

```bash
sqlite3 ~/.cache/clawmem/index.sqlite "
  DELETE FROM entity_triples WHERE source_fact LIKE '%atomic fact%' OR source_fact LIKE '%canonical entity name%';
  DELETE FROM entity_nodes WHERE entity_type='auto';
"
```

The troubleshooting guide has the full set of diagnostic queries and the symptom-by-symptom checklist for confirming you were on pre-v0.8.5: see the "kg_query returns empty for every entity" entry in [`docs/troubleshooting.md`](../troubleshooting.md#hooks).

### Do I need to re-run `clawmem reindex --enrich`?

**No.** v0.8.5 does not introduce new enrichment stages, so `--enrich` is not required to benefit from the fix. New Stop-hook activity from v0.8.5 onward is the cleanest source of triples.

Running `--enrich` anyway is harmless but unnecessary — it will re-extract entities against the same entity cap as v0.8.3, not re-fire the decision-extractor hook. Past observation transcripts are gone (they were consumed by the Stop hook on their original session), so re-enrichment on already-persisted `_clawmem/observations/*.md` files cannot recover observations lost to the pre-v0.8.5 path-collision bug — those are permanently gone. Only future sessions generate new triples.

### Confirming the fix is live

After a real Claude Code session that fires the Stop hook:

```bash
# Should show reconstructed "subject predicate object" strings, not placeholder echoes or JSON blobs
sqlite3 ~/.cache/clawmem/index.sqlite \
  "SELECT source_fact FROM entity_triples ORDER BY created_at DESC LIMIT 5;"

# Should show only real bucket types (project/service/tool/concept/person/org/location), never 'auto'
sqlite3 ~/.cache/clawmem/index.sqlite \
  "SELECT DISTINCT entity_type FROM entity_nodes
   WHERE entity_id IN (SELECT subject_id FROM entity_triples ORDER BY created_at DESC LIMIT 50);"

# Should increment after each real session — not after every indexing tick
sqlite3 ~/.cache/clawmem/index.sqlite "SELECT COUNT(*) FROM entity_triples;"
```

If `entity_triples` still shows zero after multiple Stop-hook-firing sessions, the Stop hook itself is not firing — check `~/.claude/settings.json` for a ClawMem entry under `hooks.Stop`, and run `clawmem doctor` to verify hook installation.

---

## v0.8.2 → v0.8.3

v0.8.3 is a drop-in patch release. No schema changes, no new env vars, no new dependencies. All changes are transparent behavior fixes that take effect automatically after upgrading the package and restarting any long-lived `clawmem` processes.

### Quick path

```bash
bun update -g clawmem   # or: npm update -g clawmem
# Or source install:
cd ~/clawmem && git pull

# Restart long-lived daemons so they pick up the new entity extraction + self-loop guard
systemctl --user restart clawmem-watcher.service
```

### What changed behaviorally

- **A-MEM entity extraction now keeps more entities on long-form content.** Documents with `content_type: research` keep up to 15 entities per enrichment pass (was 10), `hub` and `conversation` documents keep up to 12, and short types (`decision`, `deductive`, `note`, `handoff`, `progress`) tighten to 8. Anything else — including documents with no `content_type` frontmatter — keeps the pre-v0.8.3 default of 10. The LLM extraction prompt advertises the dynamic cap to the model directly, so a compliant model no longer stops early on long-form documents.
- **Self-loops into `memory_relations` are rejected.** The `insertRelation` API boundary silently drops writes where `fromDoc === toDoc`, and the beads dependency bridge applies the same filter. No existing caller was known to emit self-loops — this is a defensive guard, not a bug fix for an observed failure.

### Do I need to re-run `clawmem reindex --enrich` to pick up the new entity cap?

Only if you want previously-enriched long-form documents to re-extract entities against the new cap. A-MEM enrichment is tied to an `input_hash` of (title + body), so re-enrichment is skipped when the document content is unchanged. To force re-extraction against the new cap on already-indexed docs:

```bash
# Re-enrich all documents (LLM call per doc — expect latency on large vaults)
clawmem reindex --enrich
```

This is purely opt-in. New and modified documents pick up the new cap automatically on their next enrichment pass — no manual step needed for those.

### Do I need to rebuild graphs?

No. The self-loop guard only affects new writes. Existing self-loops in `memory_relations` (if any) are not scrubbed on upgrade. To check for and clean pre-existing self-loops:

```bash
sqlite3 ~/.cache/clawmem/index.sqlite \
  "SELECT COUNT(*) FROM memory_relations WHERE source_id = target_id;"

# If non-zero and you want to clean them:
sqlite3 ~/.cache/clawmem/index.sqlite \
  "DELETE FROM memory_relations WHERE source_id = target_id;"
```

This is optional housekeeping — the guard ensures no new self-loops are created, and existing ones have no observed impact beyond graph noise.

---

## v0.8.1 → v0.8.2

v0.8.2 is a pure code release: no schema changes, no new dependencies, no new env vars. The only behavior change is operational — the long-lived `clawmem watch` process now hosts the consolidation and heavy maintenance lane workers in addition to `cmdMcp`, and the light lane gained the same DB-backed `worker_leases` exclusivity the heavy lane already had. See [`docs/concepts/architecture.md#dual-host-worker-architecture-v082`](../concepts/architecture.md) for the architectural walkthrough.

### Quick path

```bash
git pull   # or: bun update -g clawmem / npm update -g clawmem
systemctl --user restart clawmem-watcher.service  # if installed as a user unit
```

### Recommended deployment change

Move worker hosting from `cmdMcp` (per-session) to `cmdWatch` (long-lived, canonical) by setting the env vars on your watcher service unit instead of the wrapper. Example systemd drop-in:

```bash
systemctl --user edit clawmem-watcher.service
```

Then paste:

```ini
[Service]
Environment=CLAWMEM_ENABLE_CONSOLIDATION=true
Environment=CLAWMEM_HEAVY_LANE=true
Environment=CLAWMEM_HEAVY_LANE_WINDOW_START=2
Environment=CLAWMEM_HEAVY_LANE_WINDOW_END=6
```

Then `systemctl --user restart clawmem-watcher.service`. The watcher process now runs both lanes 24/7 — the heavy lane sees the configured 02:00-06:00 quiet window every night regardless of whether any Claude Code session is open at the time, and the light lane drains the enrichment backlog continuously.

`cmdMcp` remains a supported fallback host for users who do not run `clawmem watch` (e.g. macOS users running everything via Claude Code launchd). When `CLAWMEM_HEAVY_LANE=true` is set on a stdio MCP host, `cmdMcp` emits a one-line warning to stderr advising operators to move heavy-lane hosting to the watcher.

### What changed under the hood

- **Light-lane worker lease (`light-consolidation` key)** — `runConsolidationTick` now wraps each tick in `withWorkerLease`. Two host processes against the same vault cannot race on Phase 2 consolidated_observations writes or duplicate Phase 3 deductive synthesis LLM calls. The in-process `isRunning` reentrancy guard remains as the cheap first defense before the SQLite round-trip.
- **`cmdWatch` hosts both workers** — same env-var gates as `cmdMcp`. Off by default in both hosts.
- **`cmdMcp` heavy-lane warning** — `console.error` advises moving heavy-lane hosting to the watcher.
- **Async drain on shutdown** — `stopConsolidationWorker` and the closure returned by `startHeavyMaintenanceWorker` are now async. They clear their `setInterval` AND poll their in-flight running flag until any mid-tick worker drains before resolving, so the worker's `withWorkerLease` finally block runs against a still-open store. Bounded waits (15s light, 30s heavy) prevent stuck ticks from wedging shutdown.
- **Signal handlers registered before worker startup** — both `cmdWatch` and `cmdMcp` register `SIGINT`/`SIGTERM` handlers before any worker initialization, eliminating the brief race window where a signal arriving mid-startup would terminate via the default action and skip the async drain.

### Multi-host safety

Running BOTH `clawmem watch` (with env vars) AND a per-session `clawmem mcp` (with env vars) against the same vault is supported in v0.8.2. The `worker_leases` table arbitrates: only one host wins each tick, the other journals a skip (heavy lane) or logs "lease held" (light lane). For the cleanest setup, set the env vars on `clawmem-watcher.service` only and leave `cmdMcp` unset.

### What you do NOT need to do

- No SQL migration (no schema changes)
- No `clawmem embed` (no embedding contract change)
- No `clawmem reindex` (no document storage change)
- No `clawmem setup hooks` (no hook config change)
- No `bun install` / `npm install` (no dependency change)

### Verify the upgrade

```bash
# Confirm watcher is running latest code
systemctl --user status clawmem-watcher.service

# After enabling the env vars + restart, watcher should log both worker
# startup banners. The exact intervals depend on the env vars you set —
# defaults are 5-min light lane and 30-min heavy lane.
journalctl --user -u clawmem-watcher.service -n 50 --no-pager | \
  grep -E "Starting (consolidation|heavy)"
# Expected:
#   [watch] Starting consolidation worker (light lane, interval=...)
#   [consolidation] Worker started
#   [watch] Starting heavy maintenance lane worker
#   [heavy-lane] Starting worker (interval=..., window=..., ...)
```

For the full operator guide — what to expect over the first hour, the per-usage-pattern tuning matrix, the complete monitoring query set, and rollback steps — see [docs/guides/systemd-services.md](systemd-services.md#background-maintenance-workers-v082).

---

## v0.7.0 → v0.8.1

### Schema migrations (automatic)

| Version | Change | Tables / columns added |
|---|---|---|
| v0.7.1 | Contradiction gate | `memory_relations.contradict_confidence` |
| v0.8.0 | Heavy maintenance lane | `maintenance_runs` + `worker_leases` tables |
| v0.8.1 | Multi-turn lookback | `context_usage.query_text` |

Applied on first open of any v0.7.1+ process against the vault. No action required.

### Optional: legacy `contradicts` taxonomy cleanup

The v0.7.1 P0 taxonomy cleanup standardized on the A-MEM plural form `contradicts` across the codebase. Prior code mixed `contradict` and `contradicts`, so v0.7.0 vaults may contain orphaned rows with `relation_type = 'contradict'` (singular) that v0.7.1+ queries cannot reach.

**Check whether your vault has any:**

```bash
sqlite3 -readonly ~/.cache/clawmem/index.sqlite \
  "SELECT relation_type, COUNT(*) FROM memory_relations \
   WHERE relation_type LIKE 'contradict%' GROUP BY relation_type"
```

If the output shows only `contradicts`, nothing to do. If it shows a `contradict` (singular) row, rescue them:

```bash
sqlite3 ~/.cache/clawmem/index.sqlite \
  "UPDATE memory_relations SET relation_type='contradicts' \
   WHERE relation_type='contradict'"
```

Cosmetic cleanup — orphaned rows are harmless but invisible to contradict-aware features (the merge-time contradiction gate, Phase 3 deductive dedupe linking, and `intent_search` WHY-graph traversal over contradicts edges).

### Opt-in features

None of these auto-enable. They are new capabilities gated behind environment variables on the long-lived clawmem process.

| Feature | Version | How to enable |
|---|---|---|
| Heavy maintenance lane | v0.8.0 | `CLAWMEM_HEAVY_LANE=true` + `CLAWMEM_HEAVY_LANE_WINDOW_START/END` for quiet hours. Second consolidation worker gated by query-rate, scoped exclusively via DB-backed `worker_leases`, stale-first batching, journaled in `maintenance_runs`. |
| Surprisal selector | v0.8.0 | `CLAWMEM_HEAVY_LANE_SURPRISAL=true`. Seeds Phase 2 with k-NN anomaly-ranked doc ids; falls back to stale-first (`surprisal-fallback-stale` metric) on vaults without embeddings. |
| Post-import conversation synthesis | v0.7.2 | `clawmem mine <dir> --synthesize` flag. One-shot, not persistent. Runs a two-pass LLM pipeline over freshly imported conversation docs to extract structured decision / preference / milestone / problem facts with cross-fact relations. |
| Consolidation worker | v0.7.1 | `CLAWMEM_ENABLE_CONSOLIDATION=true` (flag exists pre-v0.7.1). v0.7.1 attaches the new safety gates (Ext 1/2/3) to the existing Phase 2/3 path — enabling the flag picks up the gates automatically. |
| Contradiction policy | v0.7.1 | `CLAWMEM_CONTRADICTION_POLICY=link` (default, keep both rows + insert `contradicts` edge) or `supersede` (mark old row `status='inactive'`). |
| Merge guard dry-run | v0.7.1 | `CLAWMEM_MERGE_GUARD_DRY_RUN=true` logs merge-safety rejections without enforcing — useful for calibration on older vaults before flipping the gate on. Leave `false` (default) to enforce. |

Full environment variable reference: [`docs/reference/cli.md`](../reference/cli.md).

### Auto-active (no opt-in, no action)

These activate automatically as soon as the new code runs:

- **Context instruction + relationships block** (v0.7.1) — `<instruction>` and `<relationships>` blocks appear inside `<vault-context>` when memory-graph edges exist between surfaced docs
- **Multi-turn prior-query lookback** (v0.8.1) — the context-surfacing hook persists `query_text` on each prompt and uses up to 2 recent same-session priors (≤10 min old, ≤2000 chars total) for discovery queries only (NOT for rerank, composite scoring, or snippet extraction)
- **P0 contradicts taxonomy cleanup** (v0.7.1) — all new writes and reads use the plural form consistently
- **Anti-contamination deductive synthesis wrapper** (v0.7.1 Ext 1) — runs whenever Phase 3 deductive synthesis runs (gated by `CLAWMEM_ENABLE_CONSOLIDATION` or `CLAWMEM_HEAVY_LANE`)
- **Name-aware + contradiction-aware merge gates** (v0.7.1 Ext 2+3) — runs whenever Phase 2 consolidation runs (same gating)

### Verify the upgrade

```bash
# Schema check — confirms v0.7.1 / v0.8.0 / v0.8.1 migrations applied
sqlite3 -readonly ~/.cache/clawmem/index.sqlite \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN \
   ('maintenance_runs','worker_leases','recall_stats','recall_events')"
# expect: all four tables listed

sqlite3 -readonly ~/.cache/clawmem/index.sqlite "PRAGMA table_info(context_usage)" \
  | grep query_text
# expect: a row with query_text TEXT

sqlite3 -readonly ~/.cache/clawmem/index.sqlite "PRAGMA table_info(memory_relations)" \
  | grep contradict_confidence
# expect: a row with contradict_confidence REAL

# Full health check
clawmem doctor
```

---

## Per-version feature summary

### v0.7.1 — Safety release

Five independent gates around consolidation and context-surfacing:

- **P0** — Contradicts taxonomy cleanup (unified `contradicts` plural)
- **Ext 1** — Anti-contamination deductive synthesis wrapper (deterministic pre-checks + LLM validator + dedupe)
- **Ext 2** — Contradiction-aware merge gate (heuristic + LLM check, `link` / `supersede` policy)
- **Ext 3** — Name-aware dual-threshold merge safety (entity anchor comparison + normalized 3-gram cosine)
- **Ext 6a** — Context instruction + relationships block in `<vault-context>`

See [`docs/concepts/architecture.md`](../concepts/architecture.md) for the architectural walkthrough.

### v0.7.2 — Post-import conversation synthesis

Two-pass LLM pipeline over freshly imported `content_type='conversation'` docs. Pass 1 extracts structured facts; Pass 2 resolves cross-fact links via a local alias map with SQL fallback. Gated behind `clawmem mine <dir> --synthesize`. Idempotent on reruns.

### v0.8.0 — Quiet-window heavy maintenance lane

Second consolidation worker gated by a configurable quiet-hour window and query-rate, scoped exclusively via DB-backed `worker_leases` with atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= ?` acquisition and 16-byte fencing tokens. Journals every attempt (including skips) in `maintenance_runs`. Stale-first batching by default; optional surprisal selector degrades gracefully on vaults without embeddings.

See [`docs/concepts/architecture.md`](../concepts/architecture.md) for the architectural walkthrough.

### v0.8.1 — Multi-turn prior-query lookback

Context-surfacing hook joins the current prompt with up to 2 recent same-session priors from the new `context_usage.query_text` column for discovery queries (vector, FTS, expansion). Rerank, composite scoring, chunk selection, snippet extraction, file-path FTS supplements, and recall attribution all stay on the raw current prompt. Privacy-conscious persistence split: gated skip paths (slash commands, heartbeats, too-short prompts) persist `query_text = NULL` to keep agent noise out of future lookback; post-retrieval empty paths still persist so a follow-up turn can reuse the intent.

See [`docs/concepts/architecture.md`](../concepts/architecture.md) for the architectural walkthrough.

### v0.8.5 — SPO triple extraction fix

The knowledge graph finally populates. Pre-v0.8.5 decision-extractor wrote zero rows to `entity_triples` on production vaults because of a bug cluster: observation-type gate too narrow (rejected ~77% of real observations), regex-based triple extractor expected sentence shape (facts are usually descriptive phrases), entity IDs written with invalid `'auto'` type, same-type observations in one session collided on filename and the second was silently dropped, and a weak model occasionally echoed schema placeholder text (`"Individual atomic fact"`) into real triples. v0.8.5 replaces the regex path with observer-LLM-emitted `<triples>` blocks using a tight 13-predicate vocabulary (`adopted`, `migrated_to`, `deployed_to`, `runs_on`, `replaced`, `depends_on`, `integrates_with`, `uses`, `prefers`, `avoids`, `caused_by`, `resolved_by`, `owned_by`), canonical `vault:type:slug` entity IDs via `ensureEntityCanonical` (shared namespace with A-MEM, never writes `'auto'`), ambiguity-safe type inheritance via `resolveEntityTypeExact` (zero or multiple bucket matches → default to `concept`), widened observation-type gate (`decision`/`preference`/`milestone`/`problem`/`discovery`/`feature`), 8-char SHA256 hash slice in observation paths for collision-free persistence, placeholder defense at both prompt and parser, `kg_query` canonical-ID round-trip, and `source_doc_id` provenance on every triple. 4-turn Codex review.

See [`docs/troubleshooting.md`](../troubleshooting.md) "kg_query returns empty for every entity" for diagnostic symptoms and optional cleanup SQL.

---

## Downgrading

Schema migrations are additive — downgrading to an earlier version leaves new tables and columns in place, and the older code simply does not touch them. No data corruption risk.

```bash
cd ~/clawmem
git checkout v0.7.0   # or your target tag
systemctl --user restart clawmem-watcher.service
```

To fully remove v0.7.1+ schema additions (destructive, loses any v0.7.1+ data written to the new tables):

```bash
sqlite3 ~/.cache/clawmem/index.sqlite << 'SQL'
DROP TABLE IF EXISTS maintenance_runs;
DROP TABLE IF EXISTS worker_leases;
SQL
```

`context_usage.query_text` and `memory_relations.contradict_confidence` cannot be removed without rebuilding the table in SQLite. They are nullable and cost nothing to keep. Not recommended.
