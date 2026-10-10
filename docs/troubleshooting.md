# Troubleshooting

Common issues when running ClawMem with hooks, MCP server, or OpenClaw plugin. Organized by subsystem.

## Bun runtime

**Snap Bun: EPERM on stdin (hooks return empty)**
- On Linux, Bun installed via snap (`/snap/bin/bun`) cannot read stdin due to snap's confinement sandbox. Hooks receive no prompt input and silently return empty context.
- Fix: Install Bun via the official installer (`curl -fsSL https://bun.sh/install | bash`) which places it at `~/.bun/bin/bun`. The `bin/clawmem` wrapper prefers `~/.bun/bin/bun` over the system bun for this reason. If hooks return empty on a snap-based system, verify `~/.bun/bin/bun` exists and is executable.

**Two Bun binaries on PATH**
- If both snap bun (`/snap/bin/bun`) and native bun (`~/.bun/bin/bun`) are installed, `which bun` may return the snap version. Direct `bun -e` or `bun run` commands will use the wrong binary.
- Fix: The `bin/clawmem` wrapper handles this automatically. For manual commands, use `~/.bun/bin/bun` explicitly or add `~/.bun/bin` to PATH before `/snap/bin`.

**macOS: `bootstrap` / `doctor` fails with "does not support dynamic extension loading" (sqlite-vec on macOS)**
- `clawmem bootstrap` (or `clawmem doctor`) fails at the database step because macOS's built-in SQLite — which Bun uses by default — is compiled without extension-loading support, so the `sqlite-vec` vector extension cannot load. Symptom: `✗ Database: ... This build of sqlite3 does not support dynamic extension loading`. Yoloshii/ClawMem#20.
- Fix: install an extension-capable SQLite via Homebrew, then re-run bootstrap:
  ```bash
  brew install sqlite
  clawmem bootstrap ~/notes --name notes
  ```
- ClawMem auto-detects Homebrew's SQLite at the standard prefixes (`/opt/homebrew` on Apple Silicon, `/usr/local` on Intel) and at `brew --prefix sqlite` for non-standard prefixes — installing it is all that's required, no env var or config. If it still fails after `brew install sqlite`, run `brew reinstall sqlite` and confirm `ls $(brew --prefix sqlite)/lib/libsqlite3.dylib` resolves.

## Embedding & GPU

**"Local model download blocked" error**
- The llama-server endpoint is unreachable while `CLAWMEM_NO_LOCAL_MODELS=true`.
- Fix: Start the llama-server instance. Or set `CLAWMEM_NO_LOCAL_MODELS=false` for in-process fallback.

**"Remote LLM in cooldown, falling back to in-process generation"**
- A transport failure (ECONNREFUSED, ETIMEDOUT) triggered a 60-second cooldown on the remote LLM server. During cooldown, `generate()` and `expandQuery()` use local node-llama-cpp. Remote is retried automatically after cooldown expires. A *single* HTTP error (400, 500) and AbortError do NOT trigger cooldown — remote is retried on the next call. Since v0.37.0, HTTP errors that indicate the endpoint is not actually serving the API DO trip the same cooldown: 405/501 immediately (a correctly-routed endpoint never returns these), any other non-2xx — including 404, which cloud gateways legitimately return for an unknown model — after 3 consecutive failures; 429 never counts. See the squatted-port entry below.
- Fix: Start the llama-server. Or set `CLAWMEM_NO_LOCAL_MODELS=true` to prevent local fallback (returns null / passthrough instead).

**`[generate] The LLM server cut a reply at its context limit …` (v0.41.2)**
- A reply stopped at the server's context, not at the request's `max_tokens`. It is logged once per process, whichever caller hit it (A-MEM notes, query expansion, the observer, which also re-runs that window at half its size). Raise the server's `-c`; with `--parallel N`, each request gets only `-c / N`.

**Enrichment produces nothing while indexing reports success (`[amem] LLM returned null` on every doc)**
- The classic cause is a *squatted port*: `CLAWMEM_LLM_URL` points at a port where an unrelated service answers HTTP (a file browser, a dashboard, anything), so every `POST /v1/chat/completions` returns 404/501. The endpoint is "reachable", so through v0.36.0 the down-cache never tripped, the local fallback never engaged, and A-MEM notes / entities / links were silently produced by nobody — while `clawmem update` kept ending in a normal success summary. Ironically a *dead* port degraded gracefully (connection refused → cooldown → local fallback); a *squatted* one failed forever. (Public issue #24.)
- Since v0.37.0: an endpoint-shape status (405/501) trips the 60s cooldown immediately, any other non-2xx (404 included) trips after 3 consecutive failures, and one loud line names the URL and the env var to fix (`Remote endpoint at <url> answers HTTP but not the chat-completions API …`). During each cooldown the normal fallback engages when local fallback is permitted, so enrichment degrades to the in-process model instead of dying; under `CLAWMEM_NO_LOCAL_MODELS=true` there is still no fallback by policy — you get the trip line plus the run-summary counter instead of silence. The same trip protects the self-hosted embedding lane (`CLAWMEM_EMBED_URL`); cloud embedding (API key set) is deliberately exempt — an auth/quota error on a chosen provider must not flip the vault onto a different local model.
- The run summary now counts it: `clawmem update` / `reindex` / `mine` / the watcher (and the MCP `reindex`/`vault_sync` tools and REST `/reindex`) report `✎stored/attempted notes`, with an explicit `N produced nothing (LLM endpoint problem? run 'clawmem doctor')` when there is a gap — a run of nothing-but-nulls no longer ends in an unqualified success line. The metric is the note write specifically, not whole-pipeline success.
- Diagnose: `clawmem doctor` now POSTs a minimal completion to `CLAWMEM_LLM_URL` (honoring `CLAWMEM_LLM_MODEL` / `CLAWMEM_LLM_NO_THINK`) and validates the response shape — a squatted port shows as `✗ LLM endpoint: … reachable but NOT serving chat completions`.
- Fix: point `CLAWMEM_LLM_URL` at the actual llama-server (default convention `:8089`), or stop the squatter. Then re-run enrichment (`clawmem reindex --enrich` for a full pass).

**Unexpectedly slow inference (in-process fallback)**
- When a remote llama-server is unreachable, ClawMem falls back to in-process inference via `node-llama-cpp` (logged as cooldown message). With GPU acceleration (Metal on Apple Silicon, Vulkan on supported hardware), the fallback is fast. On CPU-only systems, inference is significantly slower.
- Fix: Run GPU servers via [systemd services](guides/systemd-services.md) with `Restart=on-failure`. Or set `CLAWMEM_NO_LOCAL_MODELS=true` to fail fast instead of falling back.

**`ggml_metal_library_init_from_source: error compiling source` on Apple Silicon (in-process fallback)**
- The line comes from llama.cpp inside `node-llama-cpp`, not from ClawMem. The bundled Metal shader source failed to compile on your macOS release, so ggml falls back to a slower path. Inference still completes and nothing crashes; embedding runs without Metal acceleration.
- Seen on macOS 26.6 with an M5 Pro when a source checkout resolved `node-llama-cpp` 3.15.1 (llama.cpp b7836, January 2026). Releases from 3.20.0 (llama.cpp b10361, August 2026) compile cleanly on that hardware. ClawMem's `package.json` now requires `node-llama-cpp` `^3.20.0`; on an older checkout run `bun update node-llama-cpp`, then re-run `clawmem embed`. In one report the full embed of a 156-document vault went from 14.5 s to 9.6 s after the update.
- A `No results found` from `vsearch` right after that line is a separate problem: the vault has no embeddings yet. Run `clawmem embed` (or wait for the embed timer) and check the unembedded count in `clawmem status`.
- The `[embed] Local embedding endpoint unavailable, cooldown 60s before retry` line above it is expected when no `llama-server` is running; that cooldown is what engages the in-process fallback. Point `CLAWMEM_EMBED_URL` at a server to skip in-process inference entirely.
- On CUDA the first in-process embedding after a node-llama-cpp upgrade can take about ten seconds while the driver compiles PTX for your card (measured on a GTX 1080 Ti with 3.20.0); the result lands in `~/.nv/ComputeCache` and later calls take around 130 ms. A hook killed during that compile leaves nothing cached, so run `clawmem embed` once by hand after upgrading if you rely on hooks with local inference. The OpenClaw plugin does not warm the model itself (an automatic warm-up is deferred until it can run without touching the vault), so that manual `clawmem embed` is the upgrade step.

**Query expansion always fails or returns garbage**
- On CPU-only systems (no Metal, no Vulkan), in-process inference is significantly slower and less reliable than a dedicated GPU server. Systems with GPU acceleration (Metal/Vulkan) handle these models well in-process.
- Fix: Run llama-server on a GPU. Even a low-end NVIDIA card handles 1.7B models.

**Some documents never get embedded (stuck after multiple sweeps)**
- A document is skipped only after **3 consecutive failed** embedding attempts (to prevent infinite retry loops). As of v0.11.0 the retry budget resets on a successful embed and whenever the document's content changes (new hash, via a DB trigger), so a doc that later succeeds — or is edited — gets a fresh budget and can never be permanently excluded by stale failures.
- Force a full retry of everything with `clawmem embed --force` (resets all embed state). Check pending/synced/failed counts via the MCP `status` tool (`getEmbedStats`).
- A partial embed (some fragments failed) marks the document `failed` so it is retried in full next sweep — every fragment, not just the missing ones; seq=0 is required for surprisal scoring, semantic graph, and health checks.

**Vector search returns no results but BM25 works**
- Missing embeddings. The watcher indexes but does NOT embed.
- Fix: Run `clawmem embed` or wait for the daily embed timer.

**`clawmem embed` aborts: "Embedding dimension changed (N → M)"**
- The embedding model now returns a different vector dimension than the vault was built with — you switched models, or the GPU server is down and `node-llama-cpp` fell back to a different default. As of v0.11.0, `embed` refuses to mix dimensions and aborts **non-destructively**. (Previously the first new-dimension insert dropped the `vectors_vec` table while the metadata-based worklist skipped the now-vectorless docs, silently wiping the vault's vectors — the dimension-migration safety fix; see RELEASE_NOTES v0.11.0.)
- Fix: decide which model you want, then `clawmem embed --force` to clear and rebuild the whole vault at the new dimension. `--force` probes the endpoint **first** and aborts without clearing if it's unreachable, so a force re-embed against a dead server cannot wipe the vault. To keep the old model, point `CLAWMEM_EMBED_URL` back at it and set `CLAWMEM_NO_LOCAL_MODELS=true` to prevent a silent fallback to a mismatched default.

**`clawmem embed` aborts: "Embedding model changed (X → Y) at the same dimension"**
- A different embedding model is being used than the one the vault was built with, even though both produce the same dimension. Cosine similarity across two different models is meaningless, so `embed` refuses to mix them. `clawmem doctor` likewise flags a vault that already contains mixed models.
- Fix: `clawmem embed --force` to rebuild with the current model, or point the endpoint back at the original model.

**`clawmem doctor` reports a content_vectors ↔ vectors_vec desync**
- `doctor` now runs a vault-wide consistency check: every `content_vectors` metadata row must have a matching `vectors_vec` entry and vice-versa. A nonzero "metadata rows missing a vector" / "orphan vectors" count (or "vectors_vec is MISSING but N content_vectors rows exist") means the two are out of sync — historically caused by an interrupted dimension migration on a pre-v0.11.0 build.
- Fix: `clawmem embed --force` rebuilds both tables atomically from scratch.

**Two `clawmem embed` runs at once / "Another embed is already in progress"**
- As of v0.11.0, embed runs hold a renewable, token-fenced lease (`worker_leases`, name `embedding`) so two embeds (a manual run, the embed timer, `update --embed`) cannot run concurrently — concurrent runs could otherwise interleave a clear with an insert, or mix two models into one index. A second run prints "Another embed is already in progress; skipping" and exits.
- Fix: this is intended. Re-run after the active embed finishes. A crashed embed's lease expires after its TTL and is reclaimable automatically.

**`clawmem embed` exits 1: "this run wrote 0 vectors … no taint set" (v0.41.2)**
- The run ended without storing a vector (the embedding server was down, or every fragment failed) and without a verified geometry. Through v0.41.1 such a run set the geometry taint (`✗ Geometry taint` in `clawmem doctor`), and only a full `clawmem embed --force` cleared it; the embed timer firing while the server was down was enough. Since v0.41.2 a run that did not clear the index (no `--force`) and stored nothing leaves the taint alone. It still exits 1. Start the server and re-run `clawmem embed`.
- Unchanged: a run that stored vectors without a validated preflight sets the taint, and so does a `--force` run that cleared the index, even with nothing stored. Clearing the taint now needs a `--force` rebuild whose preflight passed; a run whose failed canary you overrode with `--force-geometry` no longer clears it.
- A taint set by v0.41.1 or earlier stays until a verified `clawmem embed --force`.
- Limit: an embed run killed after it stored vectors (`SIGKILL`, out of memory, power loss) sets no taint, as in v0.41.1, because the run never reaches its end check. Run `clawmem doctor` after a crash; if the vault looks wrong, run `clawmem embed --force` against a stable server.

**Embedding fails with "input is too large to process"**
- The `full` document fragment exceeds the model's token context (2048 tokens for EmbeddingGemma).
- This is expected for large documents — the full-doc fragment fails but section/list/code fragments succeed.
- Not a problem: vector search uses fragment-level embeddings, so the document is still searchable.

**API key + localhost warning**
- You set `CLAWMEM_EMBED_API_KEY` but `CLAWMEM_EMBED_URL` points to localhost.
- If intentional (local API gateway), ignore. Otherwise, fix the URL to point to the cloud provider.

## Search & retrieval

**Historical/mined conversations rank as if they were written today**
- Fixed in v0.27.0: ranking recency, temporal filters, and the recent-decision windows run on **effective time** (`authored_at` when known, `modified_at` otherwise). New mines capture authorship automatically.
- For vaults mined before v0.27.0: re-run `clawmem mine` over the same export directory (metadata-only "dated" transition — no re-enrichment/re-embed), or `clawmem mine <dir> -c <collection> --backfill-dates` (dry-run) then `--apply`.
- Documents that still lack `authored_at` (source transcripts without timestamps, plain-text imports) keep filing-time behavior by design.

**context-surfacing hook returns empty**
- Prompt too short (< 20 chars — short memory-intent queries like "what did I say?" are exempt and force retrieval), starts with `/`, or no docs score above threshold.
- Fix: Check `clawmem status` for doc counts. Check `clawmem embed` for embedding coverage.

**intent_search returns weak results for WHY/ENTITY**
- Graph may be sparse (few A-MEM edges).
- Fix: Run `build_graphs` to add temporal backbone + semantic edges.

### `build_graphs` reports 0 new edges

Expected on a rebuild. Inserts are idempotent, so a second call over an unchanged corpus writes
nothing and correctly reports `0 new`. Read the accompanying total (`N new edge(s), M total`) —
if the total is non-zero the graph is populated and there is nothing to fix.

Before v0.28.0 these counters reported insert *attempts* rather than rows written, so a call
that persisted nothing could still report a healthy-looking count. If you are on an older
version, a non-zero count is not evidence that edges landed.

Totals count only edges whose **both endpoints are active**, matching the population the
builders operate on — so archiving documents legitimately lowers the total.

**search returns results but query returns nothing**
- `query` applies stricter scoring (composite + MMR + expansion). If expansion LLM is down, the pipeline may return empty.
- Fix: Check GPU connectivity. Use `search` or `vsearch` as a fallback.

**`clawmem doctor` reports "Reranker: degenerate / not discriminating" (or `query` results feel keyword-only / RRF-like)**
- The reranker endpoint responds but its scores do not discriminate — the classic cause is a **zerank-2 GGUF without its score head** — most uploads, including the `zerank-2-Q4_K_M` one ClawMem recommended before v0.11.3 (llama.cpp's standard converter drops the head → near-zero, uninformative scores), so the rerank stage contributes nothing and the final ranking collapses to RRF. The guard catches this: `blendRerank` falls back to RRF when no score clears `RERANK_DEGENERATE_FLOOR` (1e-4) and emits a rate-limited `[clawmem] reranker degraded → RRF fallback` warning; `clawmem doctor` section 9 (and `clawmem rerank-health`) probe it directly with a golden hard-pair set.
- Diagnose: `clawmem rerank-health` (add `--json` for the raw coverage / max-score / min-margin numbers). A healthy reranker shows coverage N/N, max score ≥ 0.05, and a minimum per-pair margin ≥ 0.25; a degenerate one shows a near-zero max score or ~0 margins.
- Fix: re-deploy a working reranker — zerank-2 as the **Q8_0 GGUF that carries its score head** or the bf16 **seq-cls sidecar** (both in [inference services](guides/inference-services.md#zerank-2-reranker-the-q8_0-gguf-or-the-bf16-sidecar)), or the default `qwen3-reranker-0.6B` — and confirm `CLAWMEM_RERANK_URL` points at it. Re-run `clawmem rerank-health`; it should exit 0. For a remote reranker, schedule `clawmem-rerank-health.timer` ([systemd services](guides/systemd-services.md#reranker-health-check-scheduled)) so a future silent reversion pages you.

**Vector search returns weak or irrelevant results even though embeddings exist**
- BM25/keyword search works and `doctor` shows vectors present + consistent, but `vsearch`/`find_similar` (and the vector half of `query`) return loosely-related results, or "the same few docs regardless of query." This is an embedding-**quality** problem, not a ClawMem index problem: the model is producing poorly-discriminating vectors. Two common causes, both server-side:
  - **Pooling misconfiguration** — serving a last-token model (Qwen3-Embedding family) without `--pooling last`, or without L2 normalization. Mean-pooling a last-token model gives usable self-retrieval but collapsed semantic separation (paraphrases score ~0.5 instead of ~0.85).
  - **Missing EOS anchor** — a last-token model whose GGUF conversion lost `tokenizer.ggml.add_eos_token`: the server never appends the terminator the model reads its embedding from, so last-token pooling reads an arbitrary final text token. Signature: similarity tracks how texts END, not what they mean — identical-vocabulary pairs score low; similarity swings with the truncation point; texts sharing a final word score deceptively high; self-similarity stays ~1.0 (so stored-vs-fresh checks pass). Verified real-world: this exact failure served an entire vault ~0.33 on echo pairs while basic-English probes looked healthy.
- Diagnose: embed two paraphrases and one unrelated sentence through your endpoint and compare cosine similarity. A healthy model scores the paraphrase pair > 0.75 and the unrelated pair < 0.45. Also test a near-identical pair differing only in the final word — it must score HIGH; low means an unanchored last-token readout. Beware the shared-suffix confound when testing terminators by hand: appending ANY common suffix to both texts inflates similarity by last-token identity — only genuine semantic separation (related high AND unrelated low) proves the fix. `clawmem doctor` runs this battery automatically (geometry canary), and `clawmem embed` refuses to build against a failing geometry (override: `--force-geometry`).
- Fix: launch the embedding `llama-server` with the pooling its model requires (`--pooling last` for Qwen3-Embedding / last-token models), restore the EOS append when the GGUF lost it (`--override-kv tokenizer.ggml.add_eos_token=bool:true` — a no-op when the metadata is already correct), and ensure outputs are L2-normalized. **A full `clawmem embed --force` is REQUIRED after any serving-side pooling/normalization/EOS change**: the old vectors are faithful to the old geometry, and two geometries at the same dimension are mutually incompatible — fresh queries against stale vectors are cosine-meaningless.
- Note on `_clawmem/` system docs (observations/deductions): since v0.21.0 the MCP retrieval tools exclude the `_clawmem` collection by default (pass `includeInternal: true` to include it; an explicit `collection` filter naming `_clawmem` also overrides). If internal docs dominate results even with a HEALTHY model, that is the composite-scoring floor (system docs carry high confidence and non-decaying recency), not geometry — the default exclusion is the remedy there.
- Operational: don't run `embed --force` while the file watcher is indexing bulk changes — stop the watcher or expect write contention (the run now survives transient `SQLITE_BUSY`, but contention still slows it). If you pipe embed output through `tee`, remember the pipeline exit code is `tee`'s — check `PIPESTATUS[0]` for the embed's own status.

**kg_query returns empty for every entity**
- `entity_triples` is populated by the decision-extractor Stop hook from observer-emitted `<triples>` blocks. Zero rows typically means either (a) the Stop hook has never fired in this vault, or (b) the observer LLM is not emitting `<triples>` blocks.
- Check triple population: `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT COUNT(*) FROM entity_triples"`.
- Check observation persistence: `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT COUNT(*) FROM documents WHERE collection='_clawmem' AND content_type='observation' AND active=1"`. If zero, decision-extractor has never fired successfully.
- Check observer schema compatibility: the observer LLM must emit `<triples>` blocks alongside `<facts>`. Older prompts may not include this schema — re-run `clawmem setup hooks` to refresh the hook binaries, and verify the observer is a recent build.
- Fix: Restart the clawmem-watcher service to clear stuck state. Run a real Claude Code session and check if the next `entity_triples` count increments.
- Historical context: BACKLOG.md §1.6 documents a pre-v0.8.5 bug cluster where `entity_triples` stayed at 0 regardless of activity due to regex+gate issues in decision-extractor. v0.8.5 fixes all of this — if you're on an older version, upgrade.
- **Symptoms you're hitting the pre-v0.8.5 cluster (one or more present together):** (1) `entity_triples` is 0 or near-0 despite tens of observations in activity; (2) `SELECT COUNT(*) FROM entity_nodes WHERE entity_type='auto'` returns > 0 — the old regex path minted nodes with `entity_type='auto'` which is not a valid bucket, so those entities never resolve via `kg_query`; (3) `SELECT path FROM documents WHERE collection='_clawmem' AND path LIKE 'observations/%'` shows at most one row per (date, session, obs_type) — the old path scheme had no hash disambiguator, so multiple same-type observations in one session collided on `UNIQUE(collection, path)` and were silently dropped (second observation's triples lost with it); (4) any surviving `entity_triples.source_fact` values look like `'Individual atomic fact'` or similar schema-placeholder strings that leaked from the observer prompt.
- **Upgrading to v0.8.5 on an already-polluted vault:** upgrading alone does NOT retroactively repair damage — the broken triples/entities are still in SQLite and the lost observations are gone for good. Two cleanup options: (a) for a low-value vault, let it bleed in — new activity populates cleanly from v0.8.5 onward, and dead `entity_type='auto'` rows are harmless (they never resolve via `kg_query`). (b) For a cleaner slate, delete just the polluted rows and let A-MEM re-enrich on next activity: `sqlite3 ~/.cache/clawmem/index.sqlite "DELETE FROM entity_triples WHERE source_fact LIKE '%atomic fact%' OR source_fact LIKE '%canonical entity name%'; DELETE FROM entity_nodes WHERE entity_type='auto';"`. A full `clawmem reindex --enrich` does not make extraction re-fire across the whole vault: it re-extracts entities only for documents that are new or changed since their last extraction ([enrichment lifecycle](internals/entity-resolution.md#enrichment-lifecycle)), and it never runs triple extraction.
- **Confirm v0.8.5 path is live:** after a real Stop-hook-firing Claude Code session, `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT source_fact FROM entity_triples ORDER BY created_at DESC LIMIT 5"` should show reconstructed `subject predicate object` strings (e.g. `ClawMem depends_on Bun`), never JSON or placeholder text. `SELECT DISTINCT entity_type FROM entity_nodes WHERE entity_id IN (SELECT subject_id FROM entity_triples ORDER BY created_at DESC LIMIT 50)` should show only real bucket types (`project`, `service`, `tool`, `concept`, `person`, `org`, `location`), never `auto`.

**kg_query shows facts under an entity with a different number in its name**
- Through v0.43.1 the entity resolver could merge names that differ only in a number (facts about `Node 200` stored on `Node 202`), and `kg_query` could answer a name or an ID with a more-mentioned entity that shared one word with it. v0.43.2 fixes both; links made earlier stay. See [upgrading](guides/upgrading.md#v0432-names-that-differ-only-in-a-number-stay-separate-entities-and-kg_query-returns-the-named-entitys-facts).

## Indexing

**Watcher fires events but collections show 0 docs**
- Fixed in current version. Was caused by `Bun.Glob` not supporting brace expansion `{a,b,c}`.
- If still occurring: check collection patterns in config.yaml.

**Watcher fires events but wrong collection processes them**
- Fixed in current version. Collections are now sorted by path length (most specific first).

**A file saved by an editor or agent tool is not re-indexed until `clawmem update` (Bun before 1.4.0)**
- Symptom: after a save, the watcher journal shows no `[change]` or `[rename]` line for the file, although a `touch` of the same file logs one. Common with Claude Code's Write and Edit tools, editors with safe-write or atomic save, and atomic-write libraries.
- Cause: those tools save atomically: they write a temp file beside the target (`notes.md.tmp.4242.9f3c`) and rename it over the target. Bun before 1.4.0 folds the events that reach one watched directory together into one callback per event type, named after the first file, so the save arrives under the temp file's name and the watcher's `.md` filter drops it. A rename inside a directory arrives under the old name only, and of two files written or deleted back-to-back in one directory only the first arrives.
- **Fixed in v0.40.2:** every event schedules one rescan of its directory (`debounceMs`, 2 s, after the first event), which compares each `.md` file with the directory's listing (inode, size, mtime and ctime) and re-indexes each one that appeared, changed or disappeared. Restart the watcher after upgrading and run `clawmem update` once to index anything it missed.
- One case stays out of reach of a rescan: a rewrite that keeps the file's size and lands within one filesystem timestamp tick of the watcher's last look at it leaves all four values unchanged. On Bun before 1.4.0, if its event is folded away, that write waits for the file's next change or a full pass; Bun 1.4.0 or later reports it by name.
- On an older ClawMem: upgrade Bun to 1.4.0 or later (`bun upgrade`) and restart the watcher, which fixes the event names; until then, run `clawmem update` after saves the watcher missed.

**Files in a directory made after the watcher started are not re-indexed until `clawmem update` (before v0.40.3)**
- Symptom: a directory made under a watched collection while the watcher runs (a new Claude Code project and its `memory/`, a copied or moved-in folder) never shows `[change]` or `[rename]` lines in the watcher journal; `clawmem update` indexes its files, and after a watcher restart its changes re-index.
- Cause: the watcher walked each collection path once, at start, and never added a watch. A watched directory deleted and made again at the same path kept its old watch, which receives nothing for the new directory (on ext4 the new directory even gets the old inode number back).
- **Fixed in v0.40.3:** every rescan also looks at its directory's subdirectories, with the startup walk's rules. A new one is watched, before it is listed, and so are the directories under it; each `.md` file it already holds is re-indexed. A gone one stops being watched, and each file it held is re-indexed once more, so the removal reaches the vault. A replaced one (a new directory at the same path, told apart by its birth time) is watched anew. The journal logs `[watcher] new directory <path>: watching N dirs` (or `replaced directory`). Restart the watcher after upgrading and run `clawmem update` once.
- Still unwatched: directories past a collection path's cap, where new directories count too (look for `WARNING: <path> is at its cap of <cap> watched dirs`, then raise `CLAWMEM_WATCH_MAX_DIRS`); excluded and `.`-prefixed directories; a symlink to a directory made while the watcher runs, unless it is a collection path itself (the index pass does not follow symlinked directories below a collection path, so nothing under one is indexed); every directory made under a collection path whose startup walk was already over the cap; and a collection path that did not exist when the watcher started, unless its parent is watched under another collection path. A new directory that cannot be watched yet (its permissions, the kernel's watch limit) is reported once as a `Watch error` and tried again at each rescan of its parent. On a filesystem without birth times, a directory deleted and made again with the same inode number keeps its dead watch until a restart.

**reindex --force crashes with "UNIQUE constraint failed"**
- Fixed in current version. Force mode now reactivates inactive rows instead of inserting.

**reindex --force after v0.2.0 upgrade shows no entity extraction**
- `reindex --force` treats existing documents as updates (`isNew=false`). The A-MEM pipeline skips entity extraction, link generation, and memory evolution for updates to avoid churn on routine reindexes.
- Fix: Use `clawmem reindex --enrich` instead. The `--enrich` flag runs the full enrichment pipeline (entity extraction + canonical resolution + co-occurrence tracking + link generation + memory evolution) on all documents, including unchanged ones; entity extraction itself runs only for a document with no recorded extraction or whose title or body changed since its last one ([enrichment lifecycle](internals/entity-resolution.md#enrichment-lifecycle)), which covers documents indexed before entity resolution existed.
- `--force` alone only refreshes A-MEM notes (keywords, tags, context). `--enrich` is needed after major upgrades that add new enrichment stages (e.g. 0.1.x → 0.2.0 added entity resolution).
- Always run ClawMem through the `bin/clawmem` wrapper, not `bun run src/clawmem.ts` directly. The wrapper sets GPU endpoint defaults (`CLAWMEM_EMBED_URL`, `CLAWMEM_LLM_URL`, `CLAWMEM_RERANK_URL`). Bypassing the wrapper causes fallback to slow in-process `node-llama-cpp` inference.

## Hooks

**`<vault-postcompact>` shows another session's pre-compaction state (its last request, decisions or files)**
- ClawMem ≤ v0.39.1 kept one `precompact-state.md` per project directory and injected it on every session start there, so a session could receive another session's last compaction, or an old one again. Fixed in v0.40.0: the state is one row per session in the vault, taken once by the start that follows that session's own compaction. The block's recent decisions, antipatterns and vault context come from the whole vault on purpose; only the pre-compaction state is per session.
- Upgrade every ClawMem that shares the vault: the hooks, the watcher, the MCP server in every open session, and the OpenClaw or Hermes plugin. An older one still running keeps the old behaviour. Then re-run `clawmem setup hooks` and delete the old files `clawmem doctor` lists; it shows red while one is still being written after the upgrade.

**No pre-compaction state after `/compact`**
- The PreCompact met a busy vault, failed or timed out. It then stores nothing, on purpose, so that nothing older is injected in its place. On the first open after the upgrade, a vault another process keeps busy can make that one open fail the same way.
- `postcompact-inject` is not installed for the `compact` start: re-run `clawmem setup hooks`.
- More than 15 minutes passed between the PreCompact and the start that follows it: an older state is never injected.
- The transcript had nothing to extract: no typed request, decision or file path. Open questions alone are not stored.
- OpenClaw and Hermes store the state at compaction, but nothing in them reads it back yet.

**`clawmem doctor` compaction lines (v0.40.0)**
- "postcompact-inject is installed under SessionStart matcher …": re-run `clawmem setup hooks`.
- "Legacy pre-compaction state: N precompact-state.md file(s) left by ClawMem ≤ v0.39.x": delete the files. In red ("written after this vault was upgraded"), an older ClawMem process is still running against the vault: upgrade it.
- "… indexed cop(y|ies) of an old snapshot … still active": `clawmem update` deactivates each one whose file is on disk or was deleted; one from before v0.34 whose file is gone stays until you forget it by its exact path.

**`clawmem doctor` stop-pipeline lines (v0.41.0)**
- "✗ Stop pipeline: migration incomplete (…)": the migration transaction did not commit, usually because another process held the vault's write lock longer than the open waited. The store still opens, but the Stop hooks skip their counter and cursor work. Any writable open retries it; run `clawmem doctor` again after stopping the busy process.
- "✗ Stop pipeline: an older ClawMem still writes to this vault …": the fence caught writes from a ClawMem older than v0.41.0 (each surface with its count and last time). Those writes were skipped, and that version's `context-surfacing` injects nothing. Upgrade or stop every ClawMem process that shares the vault — the watcher, `clawmem serve`, MCP servers in open sessions, the OpenClaw and Hermes plugins. Once nothing has been caught for 24 h, doctor reports the log as past instead of failing.
- "! counter recompute pending": `clawmem watch` runs it once at its next start; without a watcher, run `clawmem repair counters --apply`.
- "! Stop pipeline queues: … older than 24 h": nothing drained them — `clawmem watch` is not running, or its worker cannot reach the vault. Start the watcher, or drain by hand with `clawmem repair stop-queue --run`. A quarantined range whose bytes changed is listed as unavailable; dismiss it with `clawmem repair stop-queue --dismiss <id>`.
- "N feedback verdict(s) provisional": an OpenClaw or Hermes turn credited on a quiet transcript; it becomes final at the next turn, Stop or session end. Informational.
- "N feedback turn(s) wait for their OpenClaw transcript to be bound": surfacing rows written before OpenClaw could resolve the session's file. They are bound by the session's next prompt, `agent_end` or `session_end` that resolves it.
- "! … causal step(s) wait while CLAWMEM_CAUSAL_WRITER=off": ranges committed while the writer was `shadow`/`on`. They run when it is on again; to keep the lane off for good, set `CLAWMEM_CAUSAL_WRITER=off` for the watcher and the hooks, then `clawmem repair stop-queue --dismiss-causal` drops them. It refuses while this shell's writer is not `off`, and while the vault shows a causal step queued or run in the last hour, since those steps are runnable. It cannot see an idle consumer, so switch the writer off everywhere first.
- "N overwritten antipattern bodies preserved": review them with `clawmem recover antipatterns`.
- "! Claude Code hooks: the SessionEnd handoff flush is not installed": re-run `clawmem setup hooks`.

**Stop-hook ranges pile up as `model unavailable` while the LLM server is up (v0.41.0)**
- Symptom: `clawmem repair stop-queue` shows quarantined ranges that keep coming back; the hook or watcher log shows `[generate] Remote LLM HTTP 400` and `[llm-retry] observer.extractObservations: exhausted after 3 attempt(s)`; the server answers `the request exceeds the available context size, try increasing it`. The observer model runs with `-c 4096`, as the docs prescribe.
- Cause: v0.41.0's observer prompt carried a CONTEXT section as large as its transcript, up to about 5,400 tokens. The server refused it, and three refusals in a row also put the process's LLM endpoint into its 60-second cooldown (in-process generation meanwhile, or none with `CLAWMEM_NO_LOCAL_MODELS=true`).
- **Fixed in v0.41.1:** the section and the transcript, with a retry's error feedback, stay within the 8,000 characters v0.40's transcript could take. That is a bound in characters: text that tokenizes very densely can still pass 4,096 tokens, as in v0.40. Upgrade the hooks and restart the watcher; each queued range is due again at most 12 hours after its last attempt and replays when the watcher or a later Stop next runs. Raising the server's `-c` also works on v0.41.0.
- v0.41.2 counts the prompt in tokens instead; see the next entry.

**Stop-hook ranges stay quarantined on dense turns, or the observer's reply is cut short (v0.41.1)**
- Symptom: a range keeps coming back in `clawmem repair stop-queue` while the server answers every request; the server's reply ends with `finish_reason: "length"` after a few dozen tokens, or the hook log shows `[llm-retry] observer.extractObservations: exhausted`. Turns full of hashes, hex, JSON, logs or non-Latin text are the usual trigger.
- Cause: v0.41.1 bounded the prompt in characters. Such text runs about 1.1 to 1.3 characters per token (prose about 5.7), so an 8,000-character prompt plus the 2,825-character system prompt filled 4,072 of the 4,096 tokens and left the reply 24. The cut reply did not parse, every retry had the same size, and the range was quarantined for good. A cut reply with no `<` in it was read as "nothing to record", so that turn's observations were lost.
- **Fixed in v0.41.2:** the observer reads the server's context from llama-server's `/props` before each model call of the Stop pipeline, retries included (else `CLAWMEM_LLM_CONTEXT_TOKENS`, else an assumed 4,096), counts its prompt in tokens through `/apply-template` and `/tokenize`, and keeps a reply reserve of 40% of the context (768 to 2,000 tokens). A turn larger than one prompt runs as windows inside one Stop, each window seeing the titles of the observations already found. A reply the server reports as cut is never parsed: that window runs again at half its size. A reply that did not finish as an answer (no completion choice, or a finish reason such as `content_filter`) is held for a retry, never read as "nothing to record". A server that sends no `finish_reason` at all (llama-server, vLLM, Ollama and OpenAI all send one) gets a best-effort reading, logged once per process as "The LLM server's replies carry no finish_reason": a reply that used its whole allowance counts as cut, any other as complete, so a reply its context cut can still be misread there. Progress is kept in a durable checkpoint, so a Stop that runs out of time between windows leaves a continuation that resumes after the last finished window (since v0.41.4, one that runs out while a window waits for its retry fails the attempt with the failure backoff instead).
- Upgrade every process that shares the vault (hooks, watcher, MCP servers, plugins). Each queued range is due again on its old schedule (at most 12 hours) and runs in windows. Serving the observer model with `-c 8192` gives each window about three times the transcript room of `-c 4096` (measured figures in [inference services](guides/inference-services.md#llm-server); about +470 MiB VRAM); the docs now prescribe it. `clawmem doctor` shows the nominal window allowance for your server (an actual window can be smaller: see the doctor line below).

**`clawmem doctor` observer lines (v0.41.2)**
- "✓ LLM context: N tokens (measured via /props); counting template-exact; fingerprint strong — an observer window holds W transcript tokens (R-token reply); mean observer call T s (latest K call(s))": the observer's nominal budget on this server. W is what one window leaves for the transcript after the system prompt, the reply reserve and the counting margin (none when the count is template-exact), computed from `/props` as read: the context section a window carries, and since v0.41.4 a remembered context ceiling below `/props` (an earlier validated oversize), make an actual window smaller. T is the mean of the latest K (at most 50) observer model calls the Stop pipeline recorded ("not measured yet" until a hook or the watcher has made one).
- The same line with "! … One observer call takes longer than the watcher's 18-s slice": the watcher cannot finish a window in its tick, so a long turn progresses only through Stops. Use a faster model or a GPU.
- The same line with "! … Observer windows are small": W is under 1,000 tokens on a measured or configured context. Raise the server's `-c` (8192 is the prescribed value) and restart it.
- The same line with "! … Prompt fits are best-effort here": the context is assumed (no `/props` and no `CLAWMEM_LLM_CONTEXT_TOKENS`) or the server does not serve `/apply-template`, so the observer counts by estimate with a margin. Set `CLAWMEM_LLM_CONTEXT_TOKENS` to the server's context per request (on llama-server, `-c` divided by `--parallel`). "fingerprint weak" means the observer cannot see a model change behind the same URL, so a turn split into windows resumes across such a change instead of starting again from its first window. A `/props` that gives the context but not the model path, chat template and build reads weak too (its context still counts as measured). When a server whose `/props` answered stops giving a fingerprint (no answer, an error status, a 404, a body that is not llama.cpp's, one without the model, template and build), a turn in progress waits with its windows kept, however long (its queue reason ends "its server could not be verified"); it starts again from its first window only when `/props` names a different model, template or build.
- "! Stop pipeline: N range(s) held because the observer's prompt cannot fit the LLM server's context (capacity: …)": one message, or the observer's fixed prompt, is larger than a window can ever be on this server. The ranges are kept, not dropped: they stay queued on the failure schedule (1 minute, rising to 12 hours) and replay by themselves. Raise the server's `-c` and restart it.
- "observer: N continuation(s) queued — the watcher resumes them": a long turn whose windows did not all fit in one Stop's time. Its next window is due within a minute, and `clawmem watch` runs it first in its next tick; without a watcher, a later Stop or `clawmem repair stop-queue --run` does. Informational.
- The same line ending "K wait for their LLM server to answer /props again (it could not be verified)": K of those turns were split into windows on a server whose `/props` answered, and it has not given a fingerprint since (a timeout, a dropped connection, an error status, a 404, a body that is not llama.cpp's, one without the model, template and build). They resume when it answers again. A server that no longer serves `/props` at all, such as another kind of server behind the same URL, keeps them waiting: serve `/props` again, or drop the range with `clawmem repair stop-queue --dismiss <id>` (its turns are then not extracted).
- "observer: N live checkpoint(s) without a queued range — a later Stop resumes each one it reaches unchanged": a Stop that ended (killed, or out of time) after saving windows but before queueing its range, while its transcript's cursor is still before the range. The watcher replays queued ranges only, so such a checkpoint waits for a later Stop of the same transcript; that Stop resumes it when it packs the same range (new turns can change the packing, and then the unit starts again and the old checkpoint is swept). A session that has ended leaves it in place, with its turns unextracted, as in v0.41.1 (a catch-up is planned).
- "observer: N first-Stop checkpoint(s) with no cursor — a later Stop that reads the same range resumes it; the watcher's sweep removes them after 7 days": a transcript's first Stop saved windows and ended before saving a cursor. A later Stop with no cursor starts at its own turn, so it resumes such a checkpoint when it reads the same range: a repeated Stop in that turn, or a Hermes transcript begun after the upgrade (it starts at its first line). Otherwise its turns are not extracted, and the sweep removes it after 7 days. Informational.
- "observer: N checkpoint(s) behind their transcript's cursor (a dismissed or superseded range) — no later Stop reaches them; the watcher's sweep removes them": a range dismissed with `clawmem repair stop-queue --dismiss`, one whose bytes changed, or one a re-anchored transcript left behind. Their turns are not extracted; the sweep removes them at the watcher's next tick. Informational.
- "! Stop pipeline: N message(s) in M range(s) were beyond the observer's 100-message window (a very long turn)": the observer reads at most the last 100 messages of one turn, as before; v0.41.2 counts the ones it skipped. Informational.

**Stop-hook ranges held with "no parseable response", or a turn committed with no observation (v0.41.3 and earlier)**
- Symptom: `clawmem doctor` counts quarantined ranges whose reason is "no parseable response within the budget", and they come back after every retry. Or a turn with real work produced no observation at all. The observer model is the documented qmd-query-expansion-1.7B, or another small model.
- Cause: the model's replies did not follow the schema. Measured on 34 replies to three held ranges: 21 typed an observation `tool_use` (copied from the transcript's tool calls), 4 copied the prompt's `...` placeholder, and 7 came back in the model's query-expansion format. Through v0.41.3 a short reply without markup counted as "nothing to record", so such a turn committed empty and was never observed again. The format retry could not repair a reply: its feedback named a `<content>` tag the schema does not have and quoted the bad reply back. On a backend whose invocations each afford one call, the retry never ran at all: each invocation sent the same first call and the range came back as a continuation, every minute.
- **Fixed in v0.41.4:** only the exact reply `<none/>` means "nothing"; the prompt names the allowed types and has no copyable placeholders; a rejected block says why, by class; up to two format retries per window carry feedback that names the failing field and its allowed values; a window that needs a retry it cannot afford fails its attempt with the failure backoff instead of looping; and llama-server (or the in-process model) is asked for a grammar that admits only well-formed replies. Upgrade, then retry the held ranges at once with `clawmem repair stop-queue --retry-now held --run` (otherwise each retries on its own schedule, up to 12 hours apart). Turns v0.41.3 committed empty after a query-expansion reply are not re-observed.
- A model that keeps answering in prose, or in another format, still fails each attempt: its ranges stay held with the class in their reason (`no parseable response: no-blocks`), visible in `clawmem doctor`. Serve the observer model through llama-server so the grammar applies, or use a stronger model (see [inference services](guides/inference-services.md#llm-server)).

**`clawmem doctor` observer reply lines (v0.41.4)**
- "! Stop pipeline: N range(s) held after failed attempts — held ranges by class: …": the ranges waiting for their next retry, grouped by why their last attempt failed. `type-not-allowed (tool-role)`: the model typed an observation as a transcript tool role. `type-not-allowed (type-list)`: it copied the list of allowed types. `type-not-allowed (placeholder)` or `title-placeholder`: it copied template text. `no-blocks`: it answered with no observation block and no `<none/>`. `empty-reply`: it answered nothing. `facts-empty`: no fact had 5 or more characters of real content. `capacity`: a window cannot fit, or its reply was cut and the smaller window was not reached in time. `grammar`: the server refused a grammar request (or the in-process model could not compile the grammar) and the attempt could not afford the grammarless retry. `legacy (unclassified)`: a reason written by v0.41.2 or v0.41.3. The ranges retry on their own backoff; `clawmem repair stop-queue --retry-now held --run` retries them now.
- "observer: grammar off until T after an HTTP 400 on a grammar request (cause unconfirmed)": the server answered a request that carried the grammar with HTTP 400, so the observer sends no grammar to that server until T (24 hours; a later refusal extends it). "… after the in-process model could not compile the grammar": the same, for the in-process model (its log names the compile error). The 400 may have had another cause: when T passes, the next request carries the grammar again and re-tests the server. "; a grammarless request must reach the server before the grammar is used again": no request without the grammar has been answered since the refusal; the observer sends one first, however late its next attempt comes.
- "! Stop pipeline: N completed replies to grammar requests failed structurally — the server may be ignoring the grammar": replies that finished, to requests that carried the grammar, that the grammar should have made impossible (no observation block and no `<none/>`, a type outside the list, a missing element, a raw `<` or `&` in a field). llama-server honours the `grammar` field; another OpenAI-compatible server behind the same URL may ignore it. Replies the server cut are not counted, and the check is partial (it does not verify element order or every length), so the line says "may". If the server is not llama.cpp, set `CLAWMEM_OBSERVER_GRAMMAR=off`.
- "observer: K grammar reply(ies) rejected on content; E prompt-clause echo(es) kept and counted; D residue item(s) dropped …": informational. A content rejection is a well-formed block the parser refused (a blank title, template text as a title, no usable fact). An echo is a title, fact or narrative that restates one of the prompt's own rules; it is kept, since it can be true. The drops are triples naming a tool-call id or equal on both sides, copied skeleton identifiers, and repeated facts.
- "N unfinished causal run(s) older than 24 hours; not automatically replayed": causal runs a crash interrupted more than a day ago. Informational; v0.41.3 counted them as "still in progress after 1 h" for ever. That warning now counts runs interrupted 1 to 24 hours ago.

**Access counts and co-activations dropped after upgrading to v0.41.0**
- Expected. The one-time recompute set each document's `access_count` to its verified references since the upgrade (near zero at first) and rebuilt co-activations and `usage` relations the same way; through v0.40.3 every Stop counted the whole session again. Documents whose old access fell inside their archive window got a staggered archive grace (`clawmem doctor` projects the expiries per week). `clawmem repair counters --restore <op>` reverses the recompute; the op id is in the watcher log.

**A session's handoff lacks its last turns**
- The handoff document renders at the summary step, at SessionEnd and in the watcher. Without the SessionEnd hook (`clawmem setup hooks` installs it since v0.41.0), or when the flush found the vault busy, the watcher renders it once the session has ended or its digests have been quiet for 10 minutes. `clawmem repair stop-queue --run` renders it at once.

**A handoff turn's request reads `[background task …]` or `[message from …]` (v0.43.0)**
- Expected. Since v0.43.0 a background task's notice and another Claude Code session's message open a turn of their own, and the Stop hooks and PreCompact see them only as labels: the request is the label, never the task's output or the message's text. See [Turns](concepts/architecture.md#turns).

**Hermes sessions keep only their last turn and write no handoff (v0.41.0)**
- The Hermes plugin copied before v0.41.0 runs the Stop hooks only at session end, and a transcript's first Stop starts at its current turn. Copy the plugin's contents over it and restart Hermes: `cp -r /path/to/ClawMem/src/hermes/. "${HERMES_HOME:-$HOME/.hermes}/plugins/clawmem/"` (with the trailing `/.` — `cp -r src/hermes` into an existing directory nests a copy inside it and leaves the old plugin running). The v0.41 plugin runs them after every synced turn.

**"UserPromptSubmit hook error" (intermittent)**
- SQLite contention between the watcher and the context-surfacing hook. During active conversations, Claude Code writes rapidly to session transcript `.jsonl` files. Prior to v0.1.6, the watcher processed all `.jsonl` file changes (not just Beads `.beads/*.jsonl`), triggering database opens and brief write locks on every transcript update. If the context-surfacing hook fired during a lock, it exceeded its timeout.
- Fixed in v0.1.6: The watcher now only processes `.jsonl` files within `.beads/` directories (Dolt backend). Claude Code transcript `.jsonl` files are ignored entirely, eliminating the main source of lock contention and memory bloat.
- If you still see this error on v0.1.6+: the watcher's long-lived database connection can prevent SQLite WAL auto-checkpointing, allowing the WAL file to grow unbounded (observed 77MB+). A large WAL forces every concurrent reader (hooks, MCP) to traverse the entire log, amplifying contention under load. Fixed in v0.1.8: the watcher now runs `PRAGMA wal_checkpoint(PASSIVE)` every 5 minutes to keep the WAL small.
- If the error persists after v0.1.8: restart the watcher to clear accumulated state (`systemctl --user restart clawmem-watcher.service`). Check `systemctl --user status clawmem-watcher.service` for memory usage — healthy is under 100MB, bloated is 400MB+.
- **v0.2.4 fix:** Hook's SQLite `busy_timeout` was 500ms — too tight. During A-MEM enrichment or heavy indexing, the watcher can hold write locks for 500ms+, causing the hook's DB open to fail with SQLITE_BUSY. Raised to 5000ms (matches MCP server). The hook's 8s outer timeout still leaves 3s for actual work after a 5s busy wait.
- **v0.3.1 fix:** Shell `timeout` wrappers (e.g., `timeout 8 clawmem hook context-surfacing`) kill the process with exit 124 and no stderr — Claude Code reports "Failed with non-blocking status code: No stderr output". This affects all hook events (UserPromptSubmit, Stop, SessionStart, PreCompact), not just Stop hooks. Fix: Remove shell `timeout` from all hook commands and use Claude Code's native `timeout` property instead. Run `clawmem setup hooks` to reinstall with correct config (v0.3.1+), or manually update `~/.claude/settings.json` — see [setup-hooks](guides/setup-hooks.md).
- **Large vault + intermittent hook timeout (`timed out after 8s`) — FIXED in v0.16.0.** Earlier this was diagnosed as pure cold-start (fresh Bun process, opening a large `index.sqlite`, re-reading evicted index pages) with "give the host more RAM" as the durable fix — but the dominant causes were two code-level defects: (1) the `context-surfacing` vector leg ran a *synchronous* `sqlite-vec` scan that the `Promise.race(vectorTimeout)` guard could not bound (a synchronous call blocks the event loop, so the timer never fires), and (2) every writable hook open ran an unconditional backfill `UPDATE` that could wait out `busy_timeout` under writer contention. **v0.16.0 fixes both:** `searchVec` takes a real wall-clock deadline and self-aborts before the blocking scan; both vector legs race the embed against the remaining budget and clear their timers; the init backfill is read-guarded and the init `busy_timeout` is capped to the caller's value; and the watcher prewarms the sqlite-vec payload into the page cache on startup (embed-independent, watcher-only). A cold page cache still adds latency to the genuine first post-boot call, so host RAM headroom + the prewarm help the margin — but on a large vault the scan cost, not RAM, was the trigger. A modest `timeout` bump (see the tradeoffs table under *Hooks slow or near timeout*) remains a secondary margin. The `deep` profile additionally reranks (extra remote round-trips), widening the cold-call window; `balanced` (default) does not rerank. **v0.20.0** adds the true hard cap: run `clawmem watch` and the hook sends the query to the watcher, which runs the blocking scan off the hook's event loop and returns the raw matches for local hydration — a cold scan then times out fast and falls back to FTS instead of blocking the turn. It is a pure optimization layer: when the watcher isn't running the hook uses the in-process, deadline-bounded path unchanged.

**Watcher memory bloat (400MB+)**
- The watcher accumulates memory when processing high-frequency file change events. The most common trigger was Claude Code session transcript `.jsonl` files changing on every keystroke during active conversations. Each event opened the database briefly, and over hours of active use, memory grew to 400-800MB.
- Fixed in v0.1.6: transcript `.jsonl` files are no longer watched. Memory stays under 100MB during normal operation.
- If memory still grows: check which files are triggering events (`journalctl --user -u clawmem-watcher -f`). Common remaining causes:

**Diagnosing watcher memory issues:**

1. **Identify what's triggering events.** Watch the journal in real time:
   ```bash
   journalctl --user -u clawmem-watcher -f
   ```
   Each `[change]` or `[rename]` line shows the collection and file. High-frequency entries point to the source.

2. **Broad collection paths with narrow patterns.** If a collection has a broad path (e.g. `path: ~/Projects`) but a narrow pattern (e.g. `pattern: "specific-file.md"`), the watcher receives `fs.watch` events for every `.md` change under that entire tree — even files that don't match the pattern. Prior to v0.1.7, each event still triggered `indexCollection()` and opened the database.
   - Fixed in v0.1.7: the watcher pre-checks if the changed file could match the collection pattern before calling `indexCollection()`. Non-matching files are silently skipped with no DB access.
   - If you're on an older version: narrow the collection path to the smallest directory that contains the files you actually want indexed.
   - **Fixed in v0.40.1:** the pre-check read a pattern's directory part as literal text and split brace lists by stripping one leading `{` and one trailing `}`, so it dropped every event for a pattern with a wildcard directory (`*/memory/**/*.md`) or a brace list followed by a suffix (`{README,guide}.md`). Those collections re-indexed only on `clawmem update`. The pre-check now matches the way an index pass scans, and an event reaches every collection that would index the file (before, only the collection with the longest matching path got it). After upgrading, restart the watcher and run `clawmem update` once to index anything the old pre-check skipped.

3. **Git operations in watched directories.** `git pull`, `git checkout`, or `git merge` in a directory covered by a `**/*.md` collection can change hundreds of `.md` files at once. Each triggers a watcher event, and even with debouncing (2s), batches of changes arrive in rapid succession.
   - Not a bug — the watcher is doing its job (re-indexing changed docs). But if this causes contention with hooks, restart the watcher afterward: `systemctl --user restart clawmem-watcher.service`.

4. **Editor autosave and temp files.** Some editors (VS Code, JetBrains) write `.md~`, `.md.tmp`, or shadow copies during autosave. These don't match the `.md` extension check in the watcher, but frequent filesystem churn in the same directory can cause `fs.watch` callback overhead on some platforms (especially WSL2 where filesystem events cross the Linux/Windows boundary).
   - Fix: If memory grows without visible `[change]` log entries, the overhead is in `fs.watch` itself, not in ClawMem's handler. Consider reducing the number of watched directories by consolidating collections or excluding directories with heavy non-`.md` file churn.
   - Since v0.40.2 an event for any file, `.md` or not, also schedules one rescan of its directory, at most one per directory every `debounceMs` (2 s): it reads the directory and stats its `.md` files 256 at a time, letting other work run between batches, and it reaches the database only when one of those files changed (see the *Indexing* entry on atomic saves).

5. **Too many watched directories / inotify FD exhaustion (v0.2.3 fix).**
   - Prior to v0.2.3, the watcher used `fs.watch(dir, { recursive: true })` which registers an OS-level inotify watch on **every subdirectory** in the tree — including excluded directories like `gits/`, `node_modules/`, `.git/`. The `shouldExclude()` filter only prevented *processing* events from excluded paths but couldn't prevent the kernel from allocating inotify handles for them. A collection path like `~/Projects` with 67,000 subdirectories would exhaust inotify limits and eventually hang WSL or Linux.
   - Fixed in v0.2.3: The watcher now walks each collection directory at startup, skips excluded subtrees (using the same `EXCLUDED_DIRS` list as the indexer), and watches each non-excluded directory individually (non-recursive). A cap of 500 directories per collection path limits overly broad collection paths; since v0.40.1 `CLAWMEM_WATCH_MAX_DIRS` sets it. Past the cap the watcher logs `WARNING: /path has N dirs — watching the first 500; changes in the others wait for the next full index pass (clawmem update). Raise the cap with CLAWMEM_WATCH_MAX_DIRS, or narrow the collection path.` (before v0.40.1: `… capping at 500 to prevent FD exhaustion …`). The directories past the cap are not watched, and which ones they are depends on the walk order, so a change in one of them reaches the vault only on the collection's next full index pass.
   - **Raising the cap:** set `CLAWMEM_WATCH_MAX_DIRS` on the watcher process (for the systemd unit, a drop-in — see [systemd services](guides/systemd-services.md#watching-large-collections-v0401)) and restart it. Each watched directory is one inotify watch on Linux: compare the watcher's inotify watch count (the diagnosis above) with the per-user limit below, leaving room for other processes. The startup log's `[watcher]` counts (`watching N dirs`, or the cap where a line says `watching the first`) add up to an upper bound, since overlapping collection paths register some directories twice. See [configuration](reference/configuration.md#file-watcher).
   - **Symptoms (before v0.2.3):** WSL hangs or becomes unresponsive during long sessions, hook timeouts increase, and system memory climbs without visible cause.
   - **Diagnosis:** count the watcher's inotify watches, not its file descriptors. Bun keeps all of a process's watches on one inotify descriptor, so the watcher's FD count stays small however many directories it watches: `cat /proc/$(pgrep -f "clawmem.*watch" | head -1)/fdinfo/* 2>/dev/null | grep -c '^inotify wd'`. Near `max_user_watches` (below, shared with every other process) → narrow collection paths, lower `CLAWMEM_WATCH_MAX_DIRS`, or raise the limit.
   - **If still high after v0.2.3:** Narrow collection paths. A collection with `path: ~/Projects` watching a single file is wasteful — move the file to a subdirectory or create a dedicated directory for it. Check the watcher startup log for the `[watcher]` lines showing dir counts per collection.
   - Check max inotify watches: `cat /proc/sys/fs/inotify/max_user_watches` (Linux default: 8192). If the watcher reports `ENOSPC` errors, increase: `echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches`.
   - macOS: FSEvents has no hard limit but memory scales with watched directory depth.

6. **Healthy baseline.** After a fresh restart, the watcher should stabilize under 100MB within 30 seconds. If it immediately spikes above 200MB during startup, check `journalctl --user -u clawmem-watcher` for rapid-fire events during initialization (common when collections contain recently-changed files that trigger immediate indexing).

**Quick recovery:** `systemctl --user restart clawmem-watcher.service` — clears accumulated state, resets memory. Safe to do at any time; the watcher re-discovers its watch targets on startup.

**"Stop hook error: Failed with non-blocking status code: No stderr output"**
- Caused by shell `timeout` wrappers (e.g., `timeout 10 clawmem hook ...`) killing the process with exit 124 before LLM inference completes. The Stop hooks (`decision-extractor`, `handoff-generator`, `feedback-loop`) call an LLM which routinely takes 8-15s with real transcripts.
- Fix: Remove shell `timeout` from hook commands and use Claude Code's native `timeout` property instead. Run `clawmem setup hooks` to reinstall with correct config (v0.3.0+), or manually update `~/.claude/settings.json` — see [setup-hooks](guides/setup-hooks.md).

**Hooks hang or timeout**
- GPU services are unreachable, causing embedding/LLM calls to block until timeout.
- Fix: Check GPU connectivity (`curl http://host:8088/health`). Hook timeouts are 8s for context-surfacing, 5s for SessionStart/PreCompact hooks, 30s for Stop hooks. See [setup-hooks](guides/setup-hooks.md) for the full table.

**Hooks slow or near timeout (4-6s per invocation)**
- Each hook spawns a fresh Bun process. If the hook path requires `node-llama-cpp` (in-process models), the native addon import alone costs ~3.5s, leaving very little headroom in the 8s timeout for actual search and scoring.
- This only happens when no `llama-server` is running and the hook falls back to in-process inference. The MCP server (long-lived process) does not have this problem — `node-llama-cpp` loads once at startup and stays warm.
- **Who is affected:**

| Setup | Hook latency | Notes |
|-------|-------------|-------|
| `llama-server` running (local or remote) | ~200ms | Hooks use HTTP calls, never import `node-llama-cpp`. Recommended. |
| In-process Metal (Apple Silicon) | ~4-5s | `node-llama-cpp` addon import + model load. Under 8s but tight. |
| In-process Vulkan (discrete GPU) | ~4-5s | Same as Metal — addon import is the bottleneck, not inference. |
| In-process CPU-only (no Metal, no Vulkan) | >8s | Will timeout. Use `speed` profile or cloud embedding. |
| Cloud embedding (`CLAWMEM_EMBED_API_KEY` set) | ~500ms | HTTP call to cloud provider, no `node-llama-cpp` needed. |

- **Fix by setup type:**
  - **Best:** Run `llama-server` locally — even on the same machine, a persistent server eliminates the per-invocation import. See [the inference services guide](guides/inference-services.md) for setup. This is what most users will do in practice.
  - **Quick:** Set `CLAWMEM_PROFILE=speed` — disables vector search in hooks entirely, pure BM25, never loads `node-llama-cpp`. Hooks complete in under 500ms.
  - **Cloud:** Set `CLAWMEM_EMBED_API_KEY` + `CLAWMEM_EMBED_URL` + `CLAWMEM_EMBED_MODEL` — query embedding via cloud API, no local models needed in the hook path.
  - **Fail-fast:** Set `CLAWMEM_NO_LOCAL_MODELS=true` — prevents `node-llama-cpp` from loading at all. Hooks degrade to BM25-only when GPU servers are unreachable, instead of blocking for 3.5s on a fallback import.
- **Why not keep models warm?** Claude Code hooks spawn a fresh process per invocation (by design — hooks are shell commands). There is no persistent process between hook calls. The MCP server does keep models warm via a 5-minute inactivity timer, but that only benefits MCP tool calls, not hooks.
- **Tuning the context-surfacing hook timeout.** Two knobs exist since v0.38.0: the hook's **internal budget** `CLAWMEM_HOOK_BUDGET_MS` (default 6000ms, maximum 25000ms — larger values are refused by the hook, by `clawmem setup hooks`, and reported by `clawmem doctor`; the authoritative schedule every in-handler deadline derives from, on the MONOTONIC clock since O1, including the deep-escalation and rerank windows and the 500ms finalization reserve) and the **host** `timeout` in `~/.claude/settings.json` (the outer kill switch — it must be ≥ 1.5s startup allowance + the internal budget; `clawmem setup hooks` writes both together and pins the budget into the installed command, and `clawmem doctor` checks the inequality). The budget bounds the **vector** leg only when the watcher's vector daemon serves the vault (`clawmem watch`) — the sqlite-vec MATCH is synchronous and cannot be interrupted in-process, so a hook that overruns on a cold scan without the watcher running is the expected watcher-free behavior, not a budget defect (v0.38.0 also fixes a stale daemon socket left by a crashed watcher silently preventing the next watcher from binding its daemon). `clawmem doctor` reports the daemon's liveness for the vault by a real round trip, and `clawmem vec-daemon-health` (exit 0 only when live) is the scriptable form. If you're using in-process Metal/Vulkan and hooks are timing out intermittently, raise the host timeout in `~/.claude/settings.json`. Use the native `timeout` property (in seconds), not a shell `timeout` wrapper:
  ```json
  {
    "type": "command",
    "command": "/path/to/clawmem hook context-surfacing",
    "timeout": 12
  }
  ```
  Or re-run `clawmem setup hooks` (v0.3.1+) which generates correct config automatically.

  **Tradeoffs of longer timeouts:**

  | Timeout | Effect |
  |---------|--------|
  | 8s (default) | Good balance for `llama-server` setups (~200ms) and Metal/Vulkan in-process (~4-5s). Tight for CPU-only. |
  | 10-12s | Accommodates in-process Metal/Vulkan with SQLite contention headroom. Adds a noticeable delay before Claude sees your prompt when the hook is slow — you'll see the spinner for up to 12s on cold starts. |
  | 15s+ | Not recommended. Claude Code waits for the hook before processing the prompt. A 15s hook makes the agent feel unresponsive on every first prompt and after any Bun cache invalidation. If you need this, run `llama-server` instead. |
  | 5s or less | Only viable with `llama-server` running or `CLAWMEM_PROFILE=speed`. In-process models will always timeout. |

  The timeout applies per invocation. A slow first prompt (cold start) doesn't mean subsequent prompts will be slow — Bun caches modules after the first load, and `node-llama-cpp` model files are cached on disk after the first download. Subsequent prompts in the same session are typically faster.

  **Exception — large vaults (intermittent, pre-v0.16.0):** before v0.16.0 the hook could time out on *certain* turns (not just the first) because of an unbounded synchronous `sqlite-vec` scan plus an init-time write-lock wait — see *"UserPromptSubmit hook error" (intermittent)* above. **Upgrade to v0.16.0**, which bounds the scan and the init path and prewarms the cache (v0.20.0 adds the vector-query daemon — a true hard cap on the cold scan when the watcher runs). Host RAM headroom + the watcher prewarm still help the genuine cold-call margin, but they were not the root cause.

  **Stop hooks** (`decision-extractor`, `handoff-generator`, `feedback-loop`) default to 30s (v0.3.1+, was 10s prior) because they run LLM inference (observer model). These run at session end, so latency doesn't block the user.

**"Stop hook error: Failed with non-blocking status code: No stderr output"**
- Claude Code expects all hooks (including Stop hooks) to output valid JSON to stdout. A hook that exits 0 but produces **no stdout** is treated as an error — "non-blocking status code" means exit 0, "no stderr output" means Claude Code has no error message to show.
- This typically happens with custom Stop hooks (not ClawMem's built-in hooks, which always output `{"continue":true,"suppressOutput":false}`). If you add your own Stop hook alongside ClawMem's, every code path must output JSON — including early returns, error handling, and default/fallback paths.
- Common pattern that causes this:
  ```bash
  # BAD — exits 0 with no stdout on the early-return path
  if [[ -z "$some_var" ]]; then
      exit 0
  fi

  # GOOD — always output JSON
  OK='{"continue":true,"suppressOutput":false}'
  if [[ -z "$some_var" ]]; then
      echo "$OK"; exit 0
  fi
  ```
- If you have a Stop hook that blocks the agent (outputs `{"continue":false}`), use `{"continue":false,"stopReason":"..."}` to provide context.
- **Diagnosis:** Expand the Stop hooks output (ctrl+o) to see which hooks ran. Test each hook manually: `echo '{"transcriptPath":"/path/to/transcript.jsonl","sessionId":"test"}' | bash ~/.claude/scripts/your-hook.sh` — verify it outputs JSON.

**Hook fires but returns empty context**
- The context-surfacing hook filters aggressively. Common causes:
  - Prompt too short (< 20 chars; short memory-intent queries are exempt and force retrieval), starts with `/`, or matches the heartbeat/greeting filter
  - Duplicate prompt within the 600-second dedup window (SHA-256 hash match)
  - Vector search silently failed (dimension mismatch, server down), leaving a BM25-only candidate set that admission judged degenerate
  - **Relevance admission abstained (v0.38.0):** no candidate had current-turn support (`no-current-support`), or no candidate had keyword-class agreement — FTS found nothing, the vector-only junk signature (`degenerate-basis`). The hook prefers emitting nothing over surfacing a weak or arbitrary list; on a gibberish or fully-off-vault prompt this is the designed outcome.
  - **Turn-alignment write failed under database contention (v0.38.0):** the hook fails closed — no injection without its `context_usage` alignment row. Transient; the next turn recovers.
- Fix: Check `clawmem status` for doc counts and `clawmem embed` for embedding coverage. Verify the embedding server is reachable if using a remote GPU. Try `CLAWMEM_PROFILE=deep`, which widens recall with budget-aware query expansion + reranking. To see *why* a specific prompt surfaced nothing, set `CLAWMEM_SURFACING_TRACE=1` and read the newest row in `surfacing_diagnostics` — it records every retrieval leg, the fusion envelope, and the admission decision with its abstain reason.

**Context-surfacing returns results on `balanced` but not `speed`**
- `speed` profile disables vector search entirely, so documents that rank via the hybrid lanes (BM25 + vector agreement compounds fused mass) may not survive membership or admission on BM25 alone.
- Not a bug — this is the intended tradeoff. Use `balanced` or `deep` for richer retrieval.

**Semantic matches vanished after an upgrade — surfacing looks keyword-only (v0.38.0)**
- Cause: the hook and the watcher run different ClawMem builds. The v0.38.0 vector wire refuses mixed versions in both directions. A v0.38 hook classifies an older watcher's answers `skew` and prints once per process `[clawmem] vector daemon on <socket> does not implement deadline-rel-v1 (a watcher on an older build) — vector legs degrade to FTS until 'clawmem watch' is restarted on this build`. A v0.38 watcher refuses an older hook's absolute-deadline request as `version_skew`, and that older hook falls back to FTS **silently**. Since v0.38.1 the watcher logs the first such refusal, once per run: `[vec-daemon] refused a request from a pre-v0.38 client on <socket> (absolute deadlineMs → version_skew) — …`. A v0.38.0 watcher logs nothing, so on that build this direction leaves no trace on either side. Surfacing keeps working either way; only the vector legs are lost.
- A common way to get here: the hook command in `~/.claude/settings.json` and the watcher's service unit (its `ExecStart`, including any drop-in override) point at different installs, so upgrading one leaves the other behind.
- Which side is behind: a `version_skew` line in the watcher's log (`journalctl --user -u clawmem-watcher.service | grep version_skew`, v0.38.1+) means the hook runs the older build; the hook's `does not implement deadline-rel-v1` warning means the watcher does.
- Fix: run the hook and `clawmem watch` from the same install, then restart the watcher (`systemctl --user restart clawmem-watcher.service`). Verify with `clawmem vec-daemon-health` from that install: exit 0 means `live`, advertising both `hydrated-v1` and `deadline-rel-v1`; `live-raw` or `live-legacy` means the watcher still runs an older build.

**Recall attribution or injected-paths fill-in missing (`recall_events` empty for recent turns)**
- Since v0.38.0 injection bookkeeping is applied off-process: the hook parks a job, hands it to a detached `clawmem spool-ingest` child, and the child persists it under `<db dir>/surfacing-spool/` (next to `index.sqlite`) then drains it into SQLite. The turn-alignment `context_usage` row is written in-hook and is never affected.
- Bookkeeping is best-effort by design: if the handoff loses its 250ms flush race (pathological pipe) or the hook's deadline passed before packaging, that turn's learning data is dropped — alignment, prior-turn lookback, and the injection itself are unaffected.
- Check for stuck jobs: `ls ~/.cache/clawmem/surfacing-spool/`. Plain `.json` files are unapplied jobs; `.json.claim-<pid>` files are claims (a dead drainer's claim is reclaimed automatically on the next drain). Run `clawmem spool-drain` to apply anything pending; jobs older than 24h are discarded as poison.
- A persistently growing set of retained files means a unit keeps failing (e.g. a secondary-vault DB is unwritable) — run `clawmem spool-drain` in a terminal and read its stderr summary (`applied= discarded= retained=`).

**Duplicate observations after every session**
- Since v0.41.0 `decision-extractor` keeps a cursor per transcript, so a turn is extracted once; an item is dropped as a duplicate only when the same session emits it again with identical content. The same decision stated in other words is a second item, by design — the usual source of near-duplicates.
- Two documents for one session: a second transcript of the same session id (OpenClaw's base and topic transcripts) has its own documents, with a `-<tk6>` suffix. So does a session whose canonical path a pre-upgrade document already held.
- A turn extracted twice: a transcript that was replaced, truncated or rewritten starts a new generation at its current turn, so that turn can be read again (its identical items are still dropped). `SELECT hook, anchor_epoch, byte_offset FROM stop_cursors WHERE session_id = '<id>'` shows each hook's cursor and generation.
- An older ClawMem cannot add such duplicates: the fence skips its writes under `_clawmem/decisions/`, `antipatterns/`, `handoffs/` and `observations/`. `clawmem doctor` names it when it tries.
- Through v0.40.3 every Stop re-extracted the last 200 transcript entries, and `saveMemory()`'s 30-minute hash window and the cross-session merge policies were what held the repeats back.

**`[decision-extractor] contradiction: N invalidation(s) suppressed by shadow mode`**
- Not an error. Contradiction invalidation ships unarmed (v0.28.0+): the hook eroded a document's confidence to the `0.2` floor, which is the point at which it *would* set `invalidated_at` and drop the document out of FTS and vector retrieval. It logged the intent and wrote nothing.
- The preceding `WOULD invalidate "<collection>/<path>"` lines name each affected document, and name **only documents the armed writer could actually remove** — candidates are selected by pathname but only `content_type='observation'` is invalidation-eligible, so the two populations differ substantially — on a reference vault, roughly 3x more candidates than eligible rows. Confidence erosion still applied — that half is live, bounded, and reversible.
- A companion line reports documents that **reached the floor but are not eligible**. Those are informational: erosion has bottomed out there and arming the flag would not touch them.
- To act on it: read the named documents and decide whether removing them from retrieval would have been correct, then arm with `CLAWMEM_CONTRADICTION_INVALIDATE=true`. Exposure depends on your vault — see [contradiction invalidation](guides/contradiction-invalidation.md) for the measurement queries and the full procedure.
- **Stderr visibility no longer gates calibration (v0.29.0)**: every judge evaluation writes durable `judge_runs`/`judge_events` rows in the vault database, so hosts that discard hook stderr (OpenClaw surfaces it only on non-zero exits) calibrate from the audit rows instead — see the queries in [contradiction invalidation](guides/contradiction-invalidation.md).
- If the proposals are frequent and look wrong, that is a judge-precision signal (check `CLAWMEM_JUDGE_MODEL` and the `judge_runs` rows for that model), not a logging problem. The docs' recommended default is `claude-haiku-4-5`; upgrading the judge is a one-variable change.

**A memory stopped appearing in search but is still in the vault**
- `invalidated_at IS NULL` is a hard predicate on the FTS join and both vector joins, so an invalidated document is absent from `search`, `vsearch`, `query`, and context-surfacing with no query-time signal. `get`/`multi_get` by path still return it, which is the usual way this gets noticed.
- Diagnose: `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT id, path, content_type, invalidated_at, invalidated_by FROM documents WHERE invalidated_at IS NOT NULL ORDER BY invalidated_at DESC;"`
- On the `documents` table, **contradiction invalidation is the only writer of this column**, and only when armed via `CLAWMEM_CONTRADICTION_INVALIDATE=true` (and only on `content_type='observation'`). Grepping the source turns up a second `invalidated_at` writer in `consolidation.ts` — that one targets a *different table*, `consolidated_observations`, whose superseded rows are filtered by `status='inactive'` rather than by the joins above. The two are unrelated; do not diagnose one from the other.
- Restore one document **by numeric `id`**, which the audit query above returns: `sqlite3 ~/.cache/clawmem/index.sqlite "UPDATE documents SET invalidated_at=NULL, invalidated_by=NULL WHERE id=<id>;"`. Do not match on the logged path — the hook logs `collection/path` while the table stores the bare `path`, so a `WHERE path=` clause usually matches nothing, and a bare path can collide across collections. Retrieval resumes immediately; the body and its vectors were never touched, so no re-index or re-embed is needed.
- The restore deliberately leaves `confidence` alone — the document returns at whatever erosion left it (usually `0.2`), retrievable but ranking low. Raise it separately if you judge the erosion itself was wrong: `UPDATE documents SET confidence=0.8 WHERE id=<id>;`.
- If contradiction invalidation is the cause and you want it off, remove `CLAWMEM_CONTRADICTION_INVALIDATE` from wherever the hook's environment is configured (a shell `unset` will not affect a value set in your hook config or plugin host); a bulk restore scoped `WHERE invalidated_at IS NOT NULL AND content_type='observation'` covers exactly what that path can have written. Full procedure: [contradiction invalidation](guides/contradiction-invalidation.md).

**A memory is gone from the vault entirely — not merely absent from search (pre-v0.30.0 only)**
- Check this first, because the entry above will mislead you: if the row was *deleted* rather than invalidated, the `invalidated_at` query returns nothing and there is no document to restore. Confirm which case you are in: `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT id, active, archived_at FROM documents WHERE path LIKE '%<filename>%';"` — no row at all means deletion, not invalidation.
- **Cause, on v0.29.0 and earlier:** a configured `lifecycle.purge_after_days` permanently deleted every archived document past that window. It fired from a non-dry-run `lifecycle_sweep` (MCP) and from the `staleness-check` SessionStart hook, and neither reported it — the MCP dry-run preview listed only what would be *archived*, and the hook discarded the count inside a catch. If `purge_after_days` was null (the default), this never happened to you.
- **Fixed in v0.30.0: ClawMem physically deletes no document row on any code path**, and `purge_after_days` is inert. Retention is archival, reversed by `lifecycle_restore`. Upgrading stops any ongoing loss.
- **Already-deleted rows are unrecoverable from the vault** — the row, not just its retrieval flag, is gone. Recover from a backup of `index.sqlite` if you keep one, or re-index the source files: for file-backed collections the markdown on disk was never touched, so `clawmem update --embed` re-indexes it. Only vault-native content with no file behind it (mined conversations, synthesized facts, `_clawmem` observations) is genuinely lost.
- Verify your current exposure: `grep -A6 '^lifecycle:' ~/.config/clawmem/config.yaml`. On v0.30.0+ a sweep that sees `purge_after_days` set says so explicitly and deletes nothing.

## OpenClaw

**MCP stdio server "dies" after the first call — every later call fails with "Connection closed" / "transport closed" until the client reconnects (gateway hosts)**
- Symptom: the first `tools/call` on a `clawmem mcp` stdio server succeeds; every subsequent call in the same session fails client-side with `MCP error -32000: Connection closed` or `bundle-mcp server "clawmem" is disconnected: mcp transport closed`. Reported as yoloshii/ClawMem#22.
- What it is not: a one-shot server. `clawmem mcp` is a long-lived stdio process (`StdioServerTransport` from the official MCP SDK) that exits only on stdin EOF or SIGINT/SIGTERM. Measured on v0.29.0 and v0.33.0 under scripted stdio sessions: multi-call sequences, calls returning real results and performing writes (`memory_pin`), 90s and 150s idle gaps between calls, and hostile input (garbage lines, truncated JSON, JSON-RPC batch arrays, repeated `initialize`, 1 MB requests). The process survives all of it and exits 0 only when the client closes stdin. The same sequences pass when the server is spawned exactly the way OpenClaw spawns it: through the `/bin/sh` shim that sets `oom_score_adj=1000` before exec, detached, with the SDK's minimal inherited env, launching `bin/clawmem`. The child ran at `oom_score_adj=1000` throughout those runs.
- What actually happened: the host killed the server process. Gateway clients (OpenClaw's `bundle-mcp` session layer) mark the session disconnected when the child process exits and surface the error above on every later call rather than respawning inside the live session, which makes a killed server look one-shot from the agent's side.
- Discriminate the killer from the gateway's stderr/journal:
  1. `[mcp] Received SIGTERM, shutting down...` present: the host's own lifecycle tore the server down (OpenClaw's process teardown sends SIGTERM first). Investigate the gateway's session/catalog lifecycle, not ClawMem.
  2. Silence with the process gone: a SIGKILL-class death, most commonly the kernel OOM killer. OpenClaw spawns MCP servers with `oom_score_adj=1000`, the maximum OOM preference, so they are the kernel's first victim under any memory pressure (openclaw/openclaw@cc9dcd3d69e, April 2026, present in current releases; the wrap protects the gateway by sacrificing child processes). Verify: `cat /proc/$(pgrep -f "clawmem.ts mcp" | head -1)/oom_score_adj` prints `1000`, and `dmesg -T | grep -iE "oom|killed process"` shows the kill. Mitigation: set `OPENCLAW_CHILD_OOM_SCORE_ADJ=0` in the gateway's environment (OpenClaw's own opt-out) and/or add memory headroom.
  3. A stack trace on stderr: a genuine server crash. Capture it and file it at yoloshii/ClawMem with the trace. This is the one case that is a ClawMem bug.
- Note: the npm package's `clawmem` bin always execs bun (`engines: bun >=1.0.0`); Node is never the server runtime, so the host's Node version is not a variable here. When reporting, include `bun --version` and the OpenClaw version.

**`clawmem setup openclaw` installs into the wrong profile / ignores `OPENCLAW_STATE_DIR` (ClawMem v0.10.0–v0.10.3)**
- Symptom: running `OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw` (or running ClawMem setup while OpenClaw is configured for a non-default profile via `--profile` / `OPENCLAW_STATE_DIR`) installs the plugin into `~/.openclaw/extensions/clawmem` instead of the profile-specific extensions directory. The default profile picks the plugin up; the active profile does not see it.
- Root cause: ClawMem v0.10.0 through v0.10.3 hardcoded the install destination to `~/.openclaw/extensions/clawmem` and never consulted `OPENCLAW_STATE_DIR` or the OpenClaw CLI's profile resolution. Yoloshii/ClawMem#11.
- Fix: upgrade ClawMem to v0.10.4 or later. v0.10.4 delegates to `openclaw plugins install` when the OpenClaw CLI is on `PATH` (which respects `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and the `--profile` flag) and falls back to a direct-copy install honoring `OPENCLAW_STATE_DIR` when the CLI is absent. See [docs/guides/openclaw-plugin.md](guides/openclaw-plugin.md#custom-openclaw-profiles-v0104) for the full env-var contract.

**`clawmem setup openclaw --help` runs setup instead of printing help (ClawMem ≤ v0.10.3)**
- Symptom: `clawmem setup openclaw --help` performs the install instead of printing usage. Reported as part of yoloshii/ClawMem#11.
- Fix: upgrade to v0.10.4. The argv handler now short-circuits on `--help` / `-h` before any spawn or filesystem work and prints the full flag and env-var reference.

**"plugin not found: clawmem" / gateway ready line omits clawmem (OpenClaw v2026.4.11+)**
- Most common root cause on current OpenClaw releases: a symlinked plugin directory created by the CLI-absent fallback path or by a pre-v0.10.0 ClawMem install. OpenClaw v2026.4.11 tightened its discovery path to `readdirSync({ withFileTypes: true })` with `dirent.isDirectory()`, and symlinks to directories report `isDirectory() === false` on that API shape. A symlinked `<extensions>/clawmem` is silently skipped during discovery. Pre-ClawMem-v0.10.0 setup always produced a symlink, which worked on OpenClaw v2026.3.x but started failing silently when OpenClaw released v2026.4.11. Note: from v0.10.4, the delegated path's `--link` mode uses OpenClaw's `plugins.load.paths` (a load-path entry, not a filesystem symlink) and is not affected by this discovery skip.
- Fix: upgrade ClawMem to v0.10.0 or later and re-run `clawmem setup openclaw`. v0.10.0 changed the default to recursive copy (`cpSync(..., { recursive: true, dereference: true })`); v0.10.4 added profile-aware delegation that further sidesteps the issue when `openclaw` is on `PATH`. The result on disk is a real directory, not a link.
- Second cause: missing `package.json`. OpenClaw v2026.4.11+ reads `package.json` for the `openclaw.extensions: ["./index.ts"]` field as part of discovery. `openclaw.plugin.json` alone is not enough. v0.10.0 ships `src/openclaw/package.json` with the required manifest, and setup refuses to install if it is missing. If you are on v0.10.0 and the file is there (verify with `ls ~/.openclaw/extensions/clawmem/package.json`) but discovery still fails, see the next two entries.
- External report: yoloshii/ClawMem#5 — fresh install of OpenClaw v2026.4.11 reproduced this symptom on a machine that did not share any state with the ClawMem development environment. Resolved in ClawMem v0.10.0.

**"blocked plugin candidate: suspicious ownership" (multi-user installs)**
- Gateway journal shows a line like `[plugins] clawmem: blocked plugin candidate: suspicious ownership (/home/<user>/.openclaw/extensions/clawmem, uid=1001, expected uid=997 or root)`. OpenClaw v2026.4.11+ enforces that plugin directories be owned by the current runtime user or root. This is a security feature that prevents a privileged gateway process from loading code that a less-privileged user dropped into its extensions directory.
- Common trigger: the gateway runs as a dedicated system user (e.g. `openclaw`) that is different from the user who ran `clawmem setup openclaw` (e.g. your admin account). Setup copies the plugin as the installer user, so the new directory is owned by the installer and rejected by the gateway.
- Fix: after running setup, chown the plugin directory to the gateway user or root. `sudo chown -R <gateway-user>:<gateway-group> ~/.openclaw/extensions/clawmem`. Then restart the gateway. `sudo systemctl restart openclaw-gateway.service` (or whatever your gateway unit is called).
- Single-user installs where you ARE the gateway user are not affected — your own user owns the plugin copy and the ownership check passes automatically.
- The inverse situation also happens: if you later run `openclaw plugins inspect clawmem` from a different shell user than the gateway, the CLI's own ownership check may reject the plugin (`expected uid=<your uid> or root`) even though the gateway is loading it fine at runtime. Trust the gateway journal over the CLI inspect output when they disagree — the journal is the authoritative runtime state.

**Gateway fails to start with "Missing config. Run `openclaw setup` or set gateway.mode=local"**
- On system-service OpenClaw deployments where the gateway runs as a different user than the owner of `~/<gateway-user's-home>/.openclaw/`, the gateway cannot traverse into its own config directory if the directory is 700 (`drwx------`). The error is misleading — the config file itself is readable (correctly chowned by the systemd `ExecStartPre` step), but the parent directory has no group-execute bit, so the gateway user cannot even `cd` into it to open the file.
- Verify: `sudo stat /home/<installer>/.openclaw | grep Access` — if it shows `(0700/drwx------)`, this is the cause.
- Fix: `sudo chmod 750 /home/<installer>/.openclaw` (owner rwx, group rx). The gateway user must be a member of the owning group — check with `id <gateway-user>` and confirm `<installer-group>` is listed. On Debian-family systems with an `appuser:appuser`-owned home directory and an `openclaw:openclaw` gateway that is also in the `appuser` group, `chmod 750` is enough.
- Single-user installs are not affected — the gateway IS the home directory owner and has full access regardless of group perms.

**"plugins.entries.clawmem: plugin not found (stale config entry ignored)"**
- OpenClaw saw a `plugins.entries.clawmem: { enabled: true }` entry in its config but could not find a corresponding plugin directory under `~/.openclaw/extensions/`. This typically means the plugin directory was deleted or moved without running `openclaw config unset plugins.entries.clawmem`.
- Fix: re-run `clawmem setup openclaw` to restore the plugin directory, then the stale entry resolves. Or, if you intentionally uninstalled the plugin and want to keep it gone, `openclaw config unset plugins.entries.clawmem` + `openclaw config unset plugins.slots.memory` (which restores the default `memory-core`).

**"memory plugin not selected for the memory slot; skipping its indexing runtime and recall registration" (OpenClaw main from September 2026, #131779)**
- Symptom: the gateway ready line lists `clawmem`, `openclaw plugins inspect clawmem` shows `Status: enabled`, hooks fire and the agent tools answer, but the startup journal carries the warning above. ClawMem loaded without its memory-capability runtime because another plugin owns `plugins.slots.memory`, or the slot was cleared.
- What changed: on earlier OpenClaw releases an unselected `kind: memory` plugin was disabled outright and dropped from the ready line. From #131779 it stays loaded with its hooks and tools, and OpenClaw strips only the memory runtime. The failure moved from loud to quiet.
- Verify: `openclaw config get plugins.slots.memory`. It must print `clawmem`. Anything else, or nothing, is the cause.
- Fix: `openclaw plugins enable clawmem` re-applies slot selection and disables the competing memory plugin. Or set it directly: `openclaw config set plugins.slots.memory clawmem`. Restart the gateway and confirm the warning is gone.
- ClawMem's memory runtime is currently a stub (`getMemorySearchManager` returns no manager; retrieval runs through `before_prompt_build`), so you lose little today. Fix it anyway. The slot is the contract OpenClaw uses to decide which plugin owns memory, and a later ClawMem release may put real work behind that runtime.

**Older OpenClaw version notes**
- **v2026.4.10:** fixed a config normalization bug where `plugins.slots.contextEngine` was silently dropped during config processing (openclaw/openclaw#64192). Only relevant on ClawMem < v0.10.0, which used the `contextEngine` slot. ClawMem v0.10.0+ uses the `memory` slot and is not affected by #64192.
- **v2026.4.11:** introduced the new plugin discovery contract (`readdirSync({ withFileTypes: true })` + `dirent.isDirectory()`) and the plugin ownership check described above. Required for ClawMem v0.10.0+. Upgrade OpenClaw with `sudo npm i -g openclaw@latest`.

**REST API tools return no results**
- The `clawmem serve` process may not be running. The plugin auto-starts it, but it doesn't survive plugin crashes.
- Fix: Check with `curl http://localhost:7438/health`. If unreachable, either restart OpenClaw or run `clawmem serve` as a [systemd service](guides/systemd-services.md#rest-api-service-for-openclaw) for persistence.

**Agent tools silently fail but hooks still work**
- Hooks use shell-out transport (independent of REST). Agent tools use REST. If the REST server is down, tools fail but hooks continue.
- Fix: Verify REST server: `curl http://localhost:7438/health`. Start it manually (`./bin/clawmem serve`) or via systemd.

**Plugin registers but hooks don't fire**
- Verify ClawMem owns the memory slot: `openclaw config get plugins.slots.memory` must print `clawmem`. ClawMem v0.10.0+ uses the `memory` slot, not the older `contextEngine` slot.
- On OpenClaw v2026.4.23 or newer, verify the conversation grant: `openclaw config get plugins.entries.clawmem.hooks.allowConversationAccess` must print `true`, or the gateway logs `typed hook "before_prompt_build" blocked because non-bundled plugins must set plugins.entries.clawmem.hooks.allowConversationAccess=true` and neither injection nor extraction runs. On v2026.5.2 or newer, `plugin must declare contracts.tools` in the journal means the installed manifest predates the tool contract; re-run `clawmem setup openclaw`.
- If using hybrid mode, OpenClaw's native memory may be intercepting.

**`hook context-surfacing failed: timeout after Nms (hook=context-surfacing, profile=..., hookBudgetMs=...)` on every prompt**
- The plugin kills the hook `hookBudgetMs + 2000` ms after start and registers it with OpenClaw 2 s later than that. If the message repeats on every prompt, either the hook cannot finish inside its budget or an operator hook-timeout policy is lower than the plugin's registration value (`plugins.entries.clawmem.hooks.timeouts.before_prompt_build` or `plugins.entries.clawmem.hooks.timeoutMs` win over it).
- Fix: run `clawmem setup openclaw` again, which reports a policy below the derived timeout with the exact `openclaw config set` to run, or lower `plugins.entries.clawmem.config.hookBudgetMs`. At `profile: deep` with no `gpuRerank` or `gpuLlm` endpoint, ClawMem v0.37 and older loaded models in-process on every prompt and blew the budget; v0.38 degrades those legs inside it. Set the endpoints or use `balanced` on older versions.

**OpenClaw agent doesn't use ClawMem tools**
- The 5 agent tools (search, get, session_log, timeline, similar) require the REST API. Verify it's running and accessible from the OpenClaw process.
- Check plugin config: `enableTools` must be `true` and `servePort` must match the running server port (default 7438).

## Indexing

**`clawmem update` crashes with "Binding expected string, TypedArray, boolean, number, bigint or null"**
- YAML frontmatter values are auto-coerced by `gray-matter` (via `js-yaml`): `title: 2023-09-27` becomes a JS `Date` object, `title: true` becomes a boolean, `title: null` stays null. Bun's SQLite driver rejects `Date` objects as bind parameters, crashing the indexer.
- Affects any field parsed from frontmatter: `title`, `domain`, `workstream`, `content_type`, `review_by`.
- Common in Obsidian vaults where bare dates or booleans appear in YAML.
- Fixed in v0.4.2: `parseDocument()` runtime-checks all frontmatter string fields. Defense-in-depth guards in `insertDocument()`, `updateDocument()`, and `reactivateDocument()`.
- If on an older version: quote YAML values as strings (`title: "2023-09-27"`) as a workaround.

## General

**"Unknown vault" error**
- The vault name isn't configured in `config.yaml` or `CLAWMEM_VAULTS`.
- Fix: Add the vault to `~/.config/clawmem/config.yaml` or set `CLAWMEM_VAULTS` env var.

**Editing collections fails with "Cannot edit … in place"**
- Since v0.39.1, ClawMem reads back the text an edit is about to write to `config.yaml` and stops if anything outside the edited entry would change, or the edit would not come out as asked. The file is left untouched; the message names anything else the edit would have changed.
- The usual cause is a YAML merge key (`<<:`), anchor or alias the edit cannot keep, such as a collection that exists only through a merge key.
- Fix: edit `~/.config/clawmem/config.yaml` by hand (write a merged collection out as a plain entry), then run `clawmem update`.

**Comments in `config.yaml` disappeared after `clawmem collection add` or `remove`**
- Before v0.39.1 every write re-serialised the whole file and dropped its comments and blank lines, with exit 0 and no warning.
- Fix: upgrade to v0.39.1 or later, then restore the comments from a backup or version control. Later edits keep them.

**Vault path with ~ doesn't resolve**
- Fixed in current version. Vault paths now support `~` expansion.
- If using an older version, use absolute paths.

**High memory usage in long-running MCP process**
- Named vault stores are cached in memory. Each vault holds one SQLite connection.
- All stores are closed on SIGINT/SIGTERM. This is normal behavior, not a leak.
