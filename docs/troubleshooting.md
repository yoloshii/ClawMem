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
- A transport failure (ECONNREFUSED, ETIMEDOUT) triggered a 60-second cooldown on the remote LLM server. During cooldown, `generate()` and `expandQuery()` use local node-llama-cpp. Remote is retried automatically after cooldown expires. HTTP errors (400, 500) and AbortError do NOT trigger cooldown — remote is retried on the next call.
- Fix: Start the llama-server. Or set `CLAWMEM_NO_LOCAL_MODELS=true` to prevent local fallback (returns null / passthrough instead).

**Unexpectedly slow inference (in-process fallback)**
- When a remote llama-server is unreachable, ClawMem falls back to in-process inference via `node-llama-cpp` (logged as cooldown message). With GPU acceleration (Metal on Apple Silicon, Vulkan on supported hardware), the fallback is fast. On CPU-only systems, inference is significantly slower.
- Fix: Run GPU servers via [systemd services](guides/systemd-services.md) with `Restart=on-failure`. Or set `CLAWMEM_NO_LOCAL_MODELS=true` to fail fast instead of falling back.

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

**Embedding fails with "input is too large to process"**
- The `full` document fragment exceeds the model's token context (2048 tokens for EmbeddingGemma).
- This is expected for large documents — the full-doc fragment fails but section/list/code fragments succeed.
- Not a problem: vector search uses fragment-level embeddings, so the document is still searchable.

**API key + localhost warning**
- You set `CLAWMEM_EMBED_API_KEY` but `CLAWMEM_EMBED_URL` points to localhost.
- If intentional (local API gateway), ignore. Otherwise, fix the URL to point to the cloud provider.

## Search & retrieval

**context-surfacing hook returns empty**
- Prompt too short (< 20 chars), starts with `/`, or no docs score above threshold.
- Fix: Check `clawmem status` for doc counts. Check `clawmem embed` for embedding coverage.

**intent_search returns weak results for WHY/ENTITY**
- Graph may be sparse (few A-MEM edges).
- Fix: Run `build_graphs` to add temporal backbone + semantic edges.

**search returns results but query returns nothing**
- `query` applies stricter scoring (composite + MMR + expansion). If expansion LLM is down, the pipeline may return empty.
- Fix: Check GPU connectivity. Use `search` or `vsearch` as a fallback.

**`clawmem doctor` reports "Reranker: degenerate / not discriminating" (or `query` results feel keyword-only / RRF-like)**
- The reranker endpoint responds but its scores do not discriminate — the classic cause is the deprecated **zerank-2 GGUF** (llama.cpp drops its score head → near-zero, uninformative scores), so the rerank stage contributes nothing and the final ranking collapses to RRF. The guard catches this: `blendRerank` falls back to RRF when no score clears `RERANK_DEGENERATE_FLOOR` (1e-4) and emits a rate-limited `[clawmem] reranker degraded → RRF fallback` warning; `clawmem doctor` section 9 (and `clawmem rerank-health`) probe it directly with a golden hard-pair set.
- Diagnose: `clawmem rerank-health` (add `--json` for the raw coverage / max-score / min-margin numbers). A healthy reranker shows coverage N/N, max score ≥ 0.05, and a minimum per-pair margin ≥ 0.25; a degenerate one shows a near-zero max score or ~0 margins.
- Fix: re-deploy a working reranker — the **zerank-2 seq-cls sidecar** (`extras/rerankers/zerank-2-seq/`, see CLAUDE.md "SOTA upgrade") or the default `qwen3-reranker-0.6B` — and confirm `CLAWMEM_RERANK_URL` points at it. Re-run `clawmem rerank-health`; it should exit 0. For remote-sidecar setups, schedule `clawmem-rerank-health.timer` (CLAUDE.md → Background Services) so a future silent reversion pages you.

**Vector search returns weak or irrelevant results even though embeddings exist**
- BM25/keyword search works and `doctor` shows vectors present + consistent, but `vsearch`/`find_similar` (and the vector half of `query`) return loosely-related results, or "the same few docs regardless of query." This is an embedding-**quality** problem, not a ClawMem index problem: the model is producing poorly-discriminating vectors. The most common cause is a **server-side pooling/normalization misconfiguration** — e.g. serving a last-token model (Qwen3-Embedding family) without `--pooling last`, or without L2 normalization. Mean-pooling a last-token model gives usable self-retrieval but collapsed semantic separation (paraphrases score ~0.5 instead of ~0.85).
- Diagnose: embed two paraphrases and one unrelated sentence through your endpoint and compare cosine similarity. A healthy model scores the paraphrase pair > 0.75 and the unrelated pair < 0.45. If paraphrases score ~0.5 with weak separation, the model/serving is the problem, not ClawMem.
- Fix: launch the embedding `llama-server` with the pooling its model requires (`--pooling last` for Qwen3-Embedding / last-token models) and ensure outputs are L2-normalized. Re-run the diagnostic; once separation is healthy, retrieval recovers. A re-embed is not required if the dimension is unchanged, though `clawmem embed --force` after the fix guarantees a clean rebuild.
- Aside: auto-generated `_clawmem/` system docs (observations/deductions) sit near the embedding centroid and can dominate pure-vector tools when discrimination is weak — fixing the model is the real remedy, not filtering.

**kg_query returns empty for every entity**
- `entity_triples` is populated by the decision-extractor Stop hook from observer-emitted `<triples>` blocks. Zero rows typically means either (a) the Stop hook has never fired in this vault, or (b) the observer LLM is not emitting `<triples>` blocks.
- Check triple population: `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT COUNT(*) FROM entity_triples"`.
- Check observation persistence: `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT COUNT(*) FROM documents WHERE collection='_clawmem' AND content_type='observation' AND active=1"`. If zero, decision-extractor has never fired successfully.
- Check observer schema compatibility: the observer LLM must emit `<triples>` blocks alongside `<facts>`. Older prompts may not include this schema — re-run `clawmem setup hooks` to refresh the hook binaries, and verify the observer is a recent build.
- Fix: Restart the clawmem-watcher service to clear stuck state. Run a real Claude Code session and check if the next `entity_triples` count increments.
- Historical context: BACKLOG.md §1.6 documents a pre-v0.8.5 bug cluster where `entity_triples` stayed at 0 regardless of activity due to regex+gate issues in decision-extractor. v0.8.5 fixes all of this — if you're on an older version, upgrade.
- **Symptoms you're hitting the pre-v0.8.5 cluster (one or more present together):** (1) `entity_triples` is 0 or near-0 despite tens of observations in activity; (2) `SELECT COUNT(*) FROM entity_nodes WHERE entity_type='auto'` returns > 0 — the old regex path minted nodes with `entity_type='auto'` which is not a valid bucket, so those entities never resolve via `kg_query`; (3) `SELECT path FROM documents WHERE collection='_clawmem' AND path LIKE 'observations/%'` shows at most one row per (date, session, obs_type) — the old path scheme had no hash disambiguator, so multiple same-type observations in one session collided on `UNIQUE(collection, path)` and were silently dropped (second observation's triples lost with it); (4) any surviving `entity_triples.source_fact` values look like `'Individual atomic fact'` or similar schema-placeholder strings that leaked from the observer prompt.
- **Upgrading to v0.8.5 on an already-polluted vault:** upgrading alone does NOT retroactively repair damage — the broken triples/entities are still in SQLite and the lost observations are gone for good. Two cleanup options: (a) for a low-value vault, let it bleed in — new activity populates cleanly from v0.8.5 onward, and dead `entity_type='auto'` rows are harmless (they never resolve via `kg_query`). (b) For a cleaner slate, delete just the polluted rows and let A-MEM re-enrich on next activity: `sqlite3 ~/.cache/clawmem/index.sqlite "DELETE FROM entity_triples WHERE source_fact LIKE '%atomic fact%' OR source_fact LIKE '%canonical entity name%'; DELETE FROM entity_nodes WHERE entity_type='auto';"`. Full `clawmem reindex --enrich` is only needed if you want entity extraction to re-fire across the whole vault.
- **Confirm v0.8.5 path is live:** after a real Stop-hook-firing Claude Code session, `sqlite3 ~/.cache/clawmem/index.sqlite "SELECT source_fact FROM entity_triples ORDER BY created_at DESC LIMIT 5"` should show reconstructed `subject predicate object` strings (e.g. `ClawMem depends_on Bun`), never JSON or placeholder text. `SELECT DISTINCT entity_type FROM entity_nodes WHERE entity_id IN (SELECT subject_id FROM entity_triples ORDER BY created_at DESC LIMIT 50)` should show only real bucket types (`project`, `service`, `tool`, `concept`, `person`, `org`, `location`), never `auto`.

## Indexing

**Watcher fires events but collections show 0 docs**
- Fixed in current version. Was caused by `Bun.Glob` not supporting brace expansion `{a,b,c}`.
- If still occurring: check collection patterns in config.yaml.

**Watcher fires events but wrong collection processes them**
- Fixed in current version. Collections are now sorted by path length (most specific first).

**reindex --force crashes with "UNIQUE constraint failed"**
- Fixed in current version. Force mode now reactivates inactive rows instead of inserting.

**reindex --force after v0.2.0 upgrade shows no entity extraction**
- `reindex --force` treats existing documents as updates (`isNew=false`). The A-MEM pipeline skips entity extraction, link generation, and memory evolution for updates to avoid churn on routine reindexes.
- Fix: Use `clawmem reindex --enrich` instead. The `--enrich` flag forces the full enrichment pipeline (entity extraction + canonical resolution + co-occurrence tracking + link generation + memory evolution) on all documents, including unchanged ones.
- `--force` alone only refreshes A-MEM notes (keywords, tags, context). `--enrich` is needed after major upgrades that add new enrichment stages (e.g. 0.1.x → 0.2.0 added entity resolution).
- Always run ClawMem through the `bin/clawmem` wrapper, not `bun run src/clawmem.ts` directly. The wrapper sets GPU endpoint defaults (`CLAWMEM_EMBED_URL`, `CLAWMEM_LLM_URL`, `CLAWMEM_RERANK_URL`). Bypassing the wrapper causes fallback to slow in-process `node-llama-cpp` inference.

## Hooks

**"UserPromptSubmit hook error" (intermittent)**
- SQLite contention between the watcher and the context-surfacing hook. During active conversations, Claude Code writes rapidly to session transcript `.jsonl` files. Prior to v0.1.6, the watcher processed all `.jsonl` file changes (not just Beads `.beads/*.jsonl`), triggering database opens and brief write locks on every transcript update. If the context-surfacing hook fired during a lock, it exceeded its timeout.
- Fixed in v0.1.6: The watcher now only processes `.jsonl` files within `.beads/` directories (Dolt backend). Claude Code transcript `.jsonl` files are ignored entirely, eliminating the main source of lock contention and memory bloat.
- If you still see this error on v0.1.6+: the watcher's long-lived database connection can prevent SQLite WAL auto-checkpointing, allowing the WAL file to grow unbounded (observed 77MB+). A large WAL forces every concurrent reader (hooks, MCP) to traverse the entire log, amplifying contention under load. Fixed in v0.1.8: the watcher now runs `PRAGMA wal_checkpoint(PASSIVE)` every 5 minutes to keep the WAL small.
- If the error persists after v0.1.8: restart the watcher to clear accumulated state (`systemctl --user restart clawmem-watcher.service`). Check `systemctl --user status clawmem-watcher.service` for memory usage — healthy is under 100MB, bloated is 400MB+.
- **v0.2.4 fix:** Hook's SQLite `busy_timeout` was 500ms — too tight. During A-MEM enrichment or heavy indexing, the watcher can hold write locks for 500ms+, causing the hook's DB open to fail with SQLITE_BUSY. Raised to 5000ms (matches MCP server). The hook's 8s outer timeout still leaves 3s for actual work after a 5s busy wait.
- **v0.3.1 fix:** Shell `timeout` wrappers (e.g., `timeout 8 clawmem hook context-surfacing`) kill the process with exit 124 and no stderr — Claude Code reports "Failed with non-blocking status code: No stderr output". This affects all hook events (UserPromptSubmit, Stop, SessionStart, PreCompact), not just Stop hooks. Fix: Remove shell `timeout` from all hook commands and use Claude Code's native `timeout` property instead. Run `clawmem setup hooks` to reinstall with correct config (v0.3.1+), or manually update `~/.claude/settings.json` — see [setup-hooks](guides/setup-hooks.md).
- **Large vault + intermittent hook timeout (`timed out after 8s`) — FIXED in v0.16.0.** Earlier this was diagnosed as pure cold-start (fresh Bun process, opening a large `index.sqlite`, re-reading evicted index pages) with "give the host more RAM" as the durable fix — but the dominant causes were two code-level defects: (1) the `context-surfacing` vector leg ran a *synchronous* `sqlite-vec` scan that the `Promise.race(vectorTimeout)` guard could not bound (a synchronous call blocks the event loop, so the timer never fires), and (2) every writable hook open ran an unconditional backfill `UPDATE` that could wait out `busy_timeout` under writer contention. **v0.16.0 fixes both:** `searchVec` takes a real wall-clock deadline and self-aborts before the blocking scan; both vector legs race the embed against the remaining budget and clear their timers; the init backfill is read-guarded and the init `busy_timeout` is capped to the caller's value; and the watcher prewarms the sqlite-vec payload into the page cache on startup (embed-independent, watcher-only). A cold page cache still adds latency to the genuine first post-boot call, so host RAM headroom + the prewarm help the margin — but on a large vault the scan cost, not RAM, was the trigger. A modest `timeout` bump (see the tradeoffs table under *Hooks slow or near timeout*) remains a secondary margin. The `deep` profile additionally reranks (extra remote round-trips), widening the cold-call window; `balanced` (default) does not rerank.

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

3. **Git operations in watched directories.** `git pull`, `git checkout`, or `git merge` in a directory covered by a `**/*.md` collection can change hundreds of `.md` files at once. Each triggers a watcher event, and even with debouncing (2s), batches of changes arrive in rapid succession.
   - Not a bug — the watcher is doing its job (re-indexing changed docs). But if this causes contention with hooks, restart the watcher afterward: `systemctl --user restart clawmem-watcher.service`.

4. **Editor autosave and temp files.** Some editors (VS Code, JetBrains) write `.md~`, `.md.tmp`, or shadow copies during autosave. These don't match the `.md` extension check in the watcher, but frequent filesystem churn in the same directory can cause `fs.watch` callback overhead on some platforms (especially WSL2 where filesystem events cross the Linux/Windows boundary).
   - Fix: If memory grows without visible `[change]` log entries, the overhead is in `fs.watch` itself, not in ClawMem's handler. Consider reducing the number of watched directories by consolidating collections or excluding directories with heavy non-`.md` file churn.

5. **Too many watched directories / inotify FD exhaustion (v0.2.3 fix).**
   - Prior to v0.2.3, the watcher used `fs.watch(dir, { recursive: true })` which registers an OS-level inotify watch on **every subdirectory** in the tree — including excluded directories like `gits/`, `node_modules/`, `.git/`. The `shouldExclude()` filter only prevented *processing* events from excluded paths but couldn't prevent the kernel from allocating inotify handles for them. A collection path like `~/Projects` with 67,000 subdirectories would exhaust inotify limits and eventually hang WSL or Linux.
   - Fixed in v0.2.3: The watcher now walks each collection directory at startup, skips excluded subtrees (using the same `EXCLUDED_DIRS` list as the indexer), and watches each non-excluded directory individually (non-recursive). A safety cap of 500 directories per collection path prevents FD exhaustion from overly broad collection paths. The cap logs a warning: `WARNING: /path has N dirs — capping at 500 to prevent FD exhaustion. Consider narrowing the collection path.`
   - **Symptoms:** WSL hangs or becomes unresponsive during long sessions. `ls /proc/<watcher_pid>/fd | wc -l` shows 100K+ file descriptors. Hook timeouts increase. System memory usage climbs without visible cause.
   - **Diagnosis:** Check FD count: `ls /proc/$(pgrep -f "clawmem.*watch")/fd | wc -l`. Healthy is under 15,000. If over 50,000, update ClawMem to v0.2.3+.
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
- **Adjusting hook timeouts.** If you're using in-process Metal/Vulkan and hooks are timing out intermittently, you can increase the timeout in `~/.claude/settings.json`. Use the native `timeout` property (in seconds), not a shell `timeout` wrapper:
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

  **Exception — large vaults (intermittent, pre-v0.16.0):** before v0.16.0 the hook could time out on *certain* turns (not just the first) because of an unbounded synchronous `sqlite-vec` scan plus an init-time write-lock wait — see *"UserPromptSubmit hook error" (intermittent)* above. **Upgrade to v0.16.0**, which bounds the scan and the init path and prewarms the cache. Host RAM headroom + the watcher prewarm still help the genuine cold-call margin, but they were not the root cause.

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
  - Prompt too short (< 20 chars), starts with `/`, or matches the heartbeat/greeting filter
  - Duplicate prompt within the 600-second dedup window (SHA-256 hash match)
  - Vector search silently failed (dimension mismatch, server down) and BM25-only results scored too low after composite scoring
  - All results fell below the profile's minimum composite score threshold after recency decay, confidence weighting, and quality multiplier were applied
- Fix: Check `clawmem status` for doc counts and `clawmem embed` for embedding coverage. Verify the embedding server is reachable if using a remote GPU. Try `CLAWMEM_PROFILE=deep` which lowers the score threshold from 0.45 to 0.25 and adds budget-aware query expansion + reranking. For vaults with older documents, the `balanced` profile's 0.45 threshold may filter out everything — `deep` compensates with a wider net.

**Context-surfacing returns results on `balanced` but not `speed`**
- `speed` profile disables vector search entirely and uses a higher minimum score (0.55). Documents that rank well via hybrid search (BM25+vector) may not score high enough on BM25 alone.
- Not a bug — this is the intended tradeoff. Use `balanced` or `deep` for richer retrieval.

**Duplicate observations after every session**
- The `saveMemory()` API enforces a 30-minute normalized content hash dedup window.
- If duplicates still appear: check that the dedup window hasn't been bypassed by large time gaps or content variations.

## OpenClaw

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
- Verify ClawMem is selected as the active context engine in OpenClaw config.
- If using hybrid mode, OpenClaw's native memory may be intercepting.

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

**Vault path with ~ doesn't resolve**
- Fixed in current version. Vault paths now support `~` expansion.
- If using an older version, use absolute paths.

**High memory usage in long-running MCP process**
- Named vault stores are cached in memory. Each vault holds one SQLite connection.
- All stores are closed on SIGINT/SIGTERM. This is normal behavior, not a leak.
