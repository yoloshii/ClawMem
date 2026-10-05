# Upgrading ClawMem

Guide for upgrading between released versions. Current: **v0.41.4**.

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

Hooks (spawned fresh per Claude Code invocation) pick up new code automatically on their next invocation. A hook that happens to start while the upgrade is still replacing files can load a mix of old and new modules and fail. The failure is non-blocking — Claude Code carries on without that hook's output — so that one prompt runs without ClawMem context (or that one turn-end extraction is skipped), and the next invocation loads the new code cleanly. The MCP stdio server is respawned per agent session — a **new** session gets the new code, but a session already open when you upgrade keeps its old-code server alive until you reconnect (`/mcp` in Claude Code) or close it. For most releases that stale server is harmless — it just lacks the new features. **For releases that migrate the vault and change write semantics (v0.31.0, v0.32.0), it is not** — see the mixed-version caution in the v0.31.0 section below. **Nor for v0.40.0:** until you reconnect it, an old server keeps the cross-session compaction leak and enriches notes from the old snapshot files (see the v0.40.0 section). The safe order on those upgrades: stop persistent daemons (`clawmem watch`, `clawmem serve`, the systemd embed/watcher/curator units) → upgrade → reconnect or restart every open agent session → start the daemons again.

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

## Reranker: replace a headless zerank-2 GGUF

If you followed an earlier "SOTA upgrade" and are running the **`zerank-2-Q4_K_M` GGUF reranker** on `:8090`, **replace it.** That GGUF is broken: llama.cpp's `convert_hf_to_gguf.py` only synthesizes a rerank head when the model card contains the literal `# Qwen3-Reranker`, which zerank-2's card lacks — so the previously-recommended GGUF (and any built by the current/standard llama.cpp converter) is a headless causal LM that produces near-zero, uninformative scores under `--reranking`. Reranking silently degrades to an RRF-dominated passthrough.

**Migration** — serve the Q8_0 GGUF from [`seamon67/Zerank-2-GGUF`](https://huggingface.co/seamon67/Zerank-2-GGUF), which carries the head (~6 GB VRAM; pinned download and launch line in [inference services](inference-services.md#sota-stack--z-models-16-gb-gpu-apache-20)), or the bf16 seq-cls sidecar (~9 GB; transformers, ships a reproducible correctness gate):

```bash
# The bf16 sidecar (for the GGUF, use the launch line linked above):
cd extras/rerankers/zerank-2-seq
docker compose build
docker compose run --rm convert                   # download + convert + verify
docker compose up -d reranker                      # /v1/rerank on :8090
```

**Already on the sidecar?** It stays correct, and nothing requires a change. The Q8_0 GGUF frees about 3 GB of VRAM, is somewhat slower per document, and ranked like the sidecar in a side-by-side comparison ([measurements](inference-services.md#zerank-2-reranker-the-q8_0-gguf-or-the-bf16-sidecar)). To switch, stop the sidecar (`docker compose stop reranker`; its `unless-stopped` policy keeps it down across reboots), start the GGUF on `:8090`, and run `clawmem rerank-health`.

`CLAWMEM_RERANK_URL` already points at `:8090`, so nothing else changes. **zembed-1** (embedding) and **qwen3-reranker-0.6B** (default reranker) are unaffected. See [`extras/rerankers/zerank-2-seq/`](../../extras/rerankers/zerank-2-seq/) for details. zerank-2 has been Apache-2.0 since 2026-07-24, so commercial use is allowed.

---

## v0.43.1: input queued between a built-in command and its output no longer makes the command a request

No action needed beyond the usual upgrade of every process that shares the vault; restart `clawmem watch`. The
transcript classifier's revision moves to 3, so, as after v0.43.0, the first processing restarts each observer
checkpoint written by an older version, v0.43.0 included, from its range's first window (its range is not lost) and
re-derives the handoff digest of a turn still in progress; settled work is not redone.

## v0.43.0: a turn started by a task's notice, another session or a bare command is its own turn

No action needed beyond the usual upgrade of every process that shares the vault (hooks, the watcher, MCP servers,
plugins): hooks take the new code at their next run, and `clawmem watch`, whose worker runs the same readers, needs a
restart. Neither plugin's own files changed, so a copied OpenClaw or Hermes plugin need not be copied again. The first
processing after the upgrade restarts each observer checkpoint written by an older version from its range's first
window (its range is not lost), and re-derives the handoff digest of a turn still in progress; settled digests stay as
they are. Settled work (ranges already processed, digests behind the cursor) is not redone; a range still queued for
retry is read under the new rules when it runs.

## v0.42.0: `clawmem serve` requires a token and turns web pages away

**Only REST clients are affected.** The vault, the hooks and the MCP server are unchanged.

- **Restart `clawmem serve`.** On its first start it writes a token to `serve-token` in `CLAWMEM_CONFIG_DIR` (default
  `~/.config/clawmem`), unless `CLAWMEM_API_TOKEN` is set; every request must then carry `Authorization: Bearer
  <token>`. `clawmem serve-token` prints it. A `CLAWMEM_API_TOKEN` shorter than 32 characters, or with characters
  outside `A–Z a–z 0–9 - . _ ~ + /` (and a trailing `=`), is refused: unset it, or set a random value
  (`openssl rand -base64 32`) for `serve` and every client.
- **Hermes:** copy the plugin's contents over the installed one (the command is under v0.41.0 below) and restart Hermes.
  It sends `CLAWMEM_API_TOKEN` when set and otherwise reads the token file, so run it as the user `serve` runs as, with
  the same `CLAWMEM_CONFIG_DIR`. A token set only in the ClawMem checkout's `.env` reaches `serve` but not the plugin.
- **OpenClaw:** re-run `clawmem setup openclaw` (a `--link` install picks the change up on its own) and restart the
  gateway. If a systemd unit sets `CLAWMEM_API_TOKEN`, set the same value in the gateway's environment. The plugin
  reads the token once, when the gateway starts, so restart the gateway after a token rotation.
- **Scripts and curl:** add `-H "Authorization: Bearer $(clawmem serve-token)"` to every request and
  `-H "Content-Type: application/json"` to every POST — a POST without it now gets `415`.
- **Proxies, host names, browser frontends:** a request whose `Host` is not a loopback name or the bind address gets
  `403`; list a proxy's name, or the names clients use for a wildcard bind, in `CLAWMEM_ALLOWED_HOSTS`. A browser
  frontend on a non-loopback origin goes in `CLAWMEM_ALLOWED_ORIGINS`; it also needs the token.
- **No token at all:** `clawmem serve --no-token` keeps the old open behaviour on a loopback bind only. Pages from
  other origins are still refused, but a page served from a loopback origin can call it, and so can any local program.

## v0.41.5: a window whose first message fits under a smaller CONTEXT is never held

No action needed. A range held with `capacity: one message needs … tokens; a window holds …` because its message
missed the window's fullest CONTEXT, though it fit under a smaller one, replays on its own at its next attempt;
`clawmem repair stop-queue --retry-now held --run` retries held ranges now. A range still held with `capacity: one
message needs … tokens; a window holds …` after the upgrade has a message larger than a window with no CONTEXT at all,
and the reason now reports that room: raise the server's `-c` and restart it. A checkpointed range resumes where it
stopped.

**Hermes:** to take the timestamp fix, copy the plugin's contents over the installed one, then restart Hermes (the
command is under v0.41.0 below; a symlinked install picks it up on its own). The copied plugin dates a new
transcript's header by the line it opens, never later, and stamps each line as it joins the transcript's writes, so
the times follow the file unless the system clock is set back. A plugin left as it was keeps working.

## v0.41.4: the observer's replies parse, and a reply that is not an answer is never "nothing"

**No vault migration.** Upgrade every process that runs the Stop hooks (the hooks, `clawmem watch`, the MCP server of
every open agent session, the OpenClaw and Hermes plugins) and restart the watcher.

- **Held ranges.** Ranges that v0.41.2 or v0.41.3 held with "no parseable response within the budget" retry on their own
  backoff, up to 12 hours apart. To retry them now: `clawmem repair stop-queue --retry-now held --run`. `clawmem doctor`
  lists what stays held, by class ([troubleshooting](../troubleshooting.md#hooks)).
- **Checkpoints restart.** A range's observer checkpoint written by v0.41.2 or v0.41.3 belongs to the old contract: that
  range starts again from its first window when it is next reached. Finished ranges stay finished.
- **Grammar.** On llama-server the observer now sends a GBNF grammar with its requests. There is nothing to configure.
  `CLAWMEM_OBSERVER_GRAMMAR=off` turns it off, for a server behind the URL that is not llama.cpp.
- **A slightly longer prompt.** The observer's fixed prompt measures 794 tokens on the documented model (684 in
  v0.41.3), so a window holds about 110 fewer transcript tokens: about 1,660 at `-c 4096`, 5,400 at `-c 8192`.
- **Not recovered:** turns that v0.41.3 committed as empty because the model answered in another format.

Otherwise no re-embed, reindex or `clawmem setup hooks` is needed.

---

## v0.41.3: zerank-2 runs as a Q8_0 GGUF; two zembed-1 launch lines gain their flags

**No vault migration.** The docs and one CLI hint changed.

- **Running the zerank-2 sidecar?** It stays correct, and switching is optional — see
  [Reranker: replace a headless zerank-2 GGUF](#reranker-replace-a-headless-zerank-2-gguf). Running a
  zerank-2 GGUF from any other source? Check it with `clawmem rerank-health`: most have no score head.
- **Launched zembed-1 from the cloud-embedding guide or the systemd example?** Those lines lacked
  `--pooling last` and `--override-kv tokenizer.ggml.add_eos_token=bool:true`. Add both, restart the
  server, then run a full `clawmem embed --force`: if either flag changed the server's pooling or EOS
  handling, the vectors already stored are not comparable with new ones
  ([troubleshooting](../troubleshooting.md#search--retrieval)). Skip the re-embed only if you know both
  flags were no-ops for your GGUF, because its metadata already sets last-token pooling and
  `tokenizer.ggml.add_eos_token`.
- **License:** zerank-2 and zembed-1 are Apache-2.0 since 2026-07-24, and the sidecar's convert step
  needs no `HF_TOKEN`.

Otherwise no re-embed, reindex or `clawmem setup hooks` is needed.

---

## v0.41.2: the observer counts its prompt in tokens and keeps room for its reply

**No vault migration.** Upgrade every process that runs the Stop hooks (the hooks, `clawmem watch`,
the MCP server of every open agent session, the OpenClaw and Hermes plugins) and restart the
watcher: its stop worker resumes observer continuations and replays held ranges.

- **Raise the observer model's context to `-c 8192` (recommended).** The observer now reads the
  server's context from llama-server's `/props` and fits each prompt to it in tokens, keeping a reply
  reserve. At `-c 4096` it works, in windows of about 1,350 to 1,770 transcript tokens; at `-c 8192`
  a window holds about 5,090 to 5,500, so a dense turn needs far fewer calls. Measured cost: about
  +470 MiB of VRAM. With `--parallel N`, each request gets `-c / N`. `clawmem doctor` prints the
  context it sees and the window it leaves. See [inference services](inference-services.md#llm-server).
- **A server without `/props`** (a cloud gateway, vLLM, Ollama): set `CLAWMEM_LLM_CONTEXT_TOKENS` to
  its context per request. Without it ClawMem assumes 4,096 tokens and counts by a cautious estimate.
- **Ranges v0.41.1 quarantined** on dense turns are due again on their old schedule (at most 12 hours
  after the last attempt) and now run in windows. A range that cannot fit at all, because one message
  is larger than a window can ever be on that server, is held with a `capacity:` reason and replays
  on its own once the context is raised; `clawmem doctor` counts them.
- **Until every process runs v0.41.2**, an older one can still replay a held range with v0.41.1's
  prompt. Nothing is lost: a v0.41.2 process that finds the range committed drops its checkpoint, and
  the watcher sweeps orphaned checkpoints.
- **`clawmem embed`:** a run that did not clear the index (no `--force`) and stored no vector no
  longer sets the geometry taint; it still exits 1. A taint already set, by such a run or any other,
  stays until a verified `clawmem embed --force`. See
  [troubleshooting](../troubleshooting.md#embedding--gpu).

No re-embed, reindex or `clawmem setup hooks` is needed; the hook configuration is unchanged.

---

## v0.41.1: the observer's prompt fits its documented context again

**No vault migration.** Upgrade every process that runs the Stop hooks, and restart the watcher
(`systemctl --user restart clawmem-watcher.service`, or restart `clawmem watch`): its stop worker
replays quarantined ranges.

- **From v0.41.0 only.** v0.41.0's observer prompt could exceed the 4,096-token context the docs
  prescribe for the observer model (`-c 4096`); the server refused it with HTTP 400 and the batch
  was quarantined as `model unavailable`. Each of those ranges is due again at most 12 hours after
  its last attempt and replays when the watcher or a later Stop next runs; `clawmem repair
  stop-queue` shows how many are queued. See [troubleshooting](../troubleshooting.md#hooks).
- **A developer machine that ran v0.41.0's test suite** with a named vault configured in
  `~/.config/clawmem/config.yaml` may have had that vault migrated to the v0.41 schema by
  `tests/unit/stop-feedback.test.ts`. That is what any v0.41 process opening it does. Before an older
  ClawMem uses the vault again, stop every v0.41 or later process that shares it (an upgraded process
  reinstalls the fence at its next writable open), then run `clawmem repair counters --remove-fence`.
  The suite no longer reads your configuration.

---

## v0.41.0: the Stop hooks process each turn once; counters recomputed from verified references

**A vault migration, a one-time recompute, and one hook to install.** `decision-extractor` and
`handoff-generator` now keep a cursor per transcript and `feedback-loop` decides each surfaced turn
once, so a turn is extracted, digested and credited once, and a session's decision, antipattern and
handoff documents are its own. See the [release notes](../../RELEASE_NOTES.md).

In this order:

1. **Stop every ClawMem process that shares the vault** — `clawmem watch`, `clawmem serve`, the
   systemd units, the MCP server of every open agent session (reconnect or close them), and the
   OpenClaw and Hermes plugins — then upgrade them all. The first writable open installs a fence:
   an older ClawMem still running afterwards cannot write feedback counters, co-activations, `usage`
   relations, utility signals or the Stop hooks' documents (each write is skipped and counted), and
   its `context-surfacing` hook injects nothing, because its usage-row insert fails. An older MCP
   server's `memory_pin`, `memory_snooze` and `memory_forget` still make their change, then report an
   error, because the usage row each writes afterwards fails the same way: reconnect the session
   (`/mcp`) instead of retrying. `clawmem doctor` fails while the fence has caught such a write in
   the last 24 h.
2. **Re-run `clawmem setup hooks`.** It adds a SessionEnd group running `handoff-generator` (timeout
   2 s), which renders the handoff's latest turns when a session ends. Without it, the watcher renders
   them later, and `clawmem doctor` warns. Other tools' hooks in the same groups are kept.
3. **Hermes:** copy the plugin's contents over the installed one, then restart Hermes:
   `cp -r /path/to/ClawMem/src/hermes/. "${HERMES_HOME:-$HOME/.hermes}/plugins/clawmem/"` (the
   trailing `/.` copies the contents; `cp -r src/hermes <existing dir>` would nest a `hermes/` inside
   it and leave the old plugin running). A symlinked install picks it up on its own. The old plugin
   runs the Stop hooks only at session end, which under v0.41.0 keeps a session's last turn only and
   writes no handoff.
4. **Start `clawmem watch`.** At its first start it copies every antipattern body older versions
   overwrote into `recovered_antipattern_bodies`, then recomputes the counters of the general vault and
   of every named vault, once. On a large vault this takes minutes, yielding between chunks of 5,000
   rows, and it writes one before-image per value it changes or deletes into `counter_repair_log`
   (about 380,000 rows on a vault with 212,037 co-activations and 166,084 `usage` relations). Without a
   watcher, run `clawmem repair counters` (a dry run that prints what would change), then
   `clawmem repair counters --apply`. `clawmem doctor` shows "counter recompute pending" until it has
   run.

What the recompute does:

- `access_count` becomes the number of verified references, and `last_accessed_at` the newest one
  (else `modified_at`). Right after the upgrade almost nothing is verified yet, so the counts start
  near zero and the last-access times fall back to `modified_at`, and recency and confidence stop
  reflecting the inflated counts. Usage rows written before the
  upgrade are frozen and never credited.
- Every co-activation row and every `usage` relation is deleted and rebuilt from verified same-turn
  references (weight 1.0). The utility signals are recomputed: surfaced counts from the pre-upgrade
  rows' injected paths plus the new manifests, referenced counts from verified references.
- A document whose old last access fell inside its archive window gets an archive grace of 30 days
  plus (its id mod 60) days, so the lifecycle sweep does not archive such documents all at once.
  `clawmem doctor` shows how many grace periods end in each coming week; run
  `lifecycle_sweep(dry_run=true)` before a real sweep as usual.
- **Undo:** `clawmem repair counters --restore <op>` (the op id is in the watcher log and in the
  output of `--apply`) restores each value while it still equals what the recompute wrote, and each
  deleted row while no row has taken its key, and reports the conflicts it leaves.

What else changes on its own:

- Session documents are rendered from the session's own items at a path fixed when each document is
  first written (`_clawmem/decisions/<date>-<sid8>.md`, the same under `antipatterns/` and
  `handoffs/`). A pre-upgrade document at that path stays as it is; the session's new document takes
  a `-<tk6>` suffix. Nothing is merged or deduplicated across sessions any more.
- `clawmem watch` runs the stop-pipeline worker every 60 s, even with no collection configured. It
  drains feedback of quiet or ended transcripts, named-vault slices, handoff digests and renders,
  quarantined ranges, deferred judge pairs and queued causal steps. Run the watcher: without it these
  wait for the session's own Stops (and deferred judge pairs for `clawmem repair stop-queue --run`),
  and `clawmem doctor` warns once a queue is older than 24 h.
- The antipatterns older versions overwrote can be reviewed with `clawmem recover antipatterns` and
  written to `_clawmem/antipatterns/recovered-<YYYY-MM>.md` with `--apply` (optionally
  `--min-occurrences N`). Nothing is recovered automatically.
- A vault whose migration transaction cannot commit (another process held the write lock too long)
  still opens: the Stop hooks skip their counter and cursor work, `clawmem doctor` shows "migration
  incomplete", and the next writable open tries again.

**Downgrading:** run `clawmem repair counters --remove-fence` after stopping every v0.41 process, or
the older version's Stop-hook writes are ignored and its surfacing hook injects nothing. The next
v0.41 writable open installs the fence again. The new tables and columns are ignored by older
versions. `--restore` can put the recomputed counters back first.

Nothing to re-embed or re-index, and no config change.

---

## v0.40.3: the watcher watches directories made after it starts

**No vault migration.** Restart the watcher (`systemctl --user restart clawmem-watcher.service`,
or restart `clawmem watch`), then run `clawmem update` once to index the files the old watcher
missed in directories made while it ran.

- **New directories are watched.** A directory made under a watched collection after the watcher
  started (a new Claude Code project and its `memory/`, a copied or moved-in folder) went unwatched
  until a restart. The watcher now takes it on at its parent's next rescan, with the directories
  under it, and re-indexes the files it already holds. A directory deleted and made again at the
  same path is watched anew. See [troubleshooting](../troubleshooting.md#indexing).
- **New directories count against the cap.** `CLAWMEM_WATCH_MAX_DIRS` (default 500) now bounds the
  directories a collection path watches over the watcher's whole run, not only at start. If the log
  shows `WARNING: <path> is at its cap of <cap> watched dirs`, raise the cap; see
  [configuration](../reference/configuration.md#file-watcher). A collection path already over the
  cap at start watches no new directory.

---

## v0.40.2: the watcher re-indexes files saved atomically

**No vault migration.** Restart the watcher (`systemctl --user restart clawmem-watcher.service`,
or restart `clawmem watch`), then run `clawmem update` once to index anything the old watcher
missed.

- **Files saved atomically now re-index on change.** On Bun before 1.4.0, a file saved by writing a
  temp file and renaming it over the original (many editors and agent tools, Claude Code's Write
  and Edit among them), a rename inside a directory, and the second of two files changed
  back-to-back in one directory never reached the watcher under their own names, so they waited
  for a full index pass. The watcher now rescans a directory after any event in it — see
  [troubleshooting](../troubleshooting.md#indexing).
- **Bun 1.4.0 or later is recommended** whatever the ClawMem version: it reports each event under
  its own name. Older ClawMem versions on Bun 1.4.0+ get the event names right too.

---

## v0.40.1: the watcher re-indexes every collection it watches

**No vault migration.** Restart the watcher (`systemctl --user restart clawmem-watcher.service`,
or restart `clawmem watch`), then run `clawmem update` once to index anything the old pre-check
skipped.

- **Collections that never re-indexed on change now do.** The watcher's pre-check dropped every
  event for a pattern with a wildcard directory (`*/memory/**/*.md`) or a brace list followed by
  a suffix (`{README,guide}.md`), and an event reached only the collection with the longest
  matching path, so an overlapping outer collection missed files the inner one's pattern
  rejected. If you have either, its next changes trigger index passes (and A-MEM enrichment of
  the changed documents) that did not happen before — see [troubleshooting](../troubleshooting.md).
- **The directory cap is a setting.** The watcher watches at most 500 directories under each
  collection path; its startup log says `WARNING: <path> has N dirs — watching the first 500`
  when a collection has more. Set `CLAWMEM_WATCH_MAX_DIRS` on the watcher to raise it — see
  [configuration](../reference/configuration.md#file-watcher) and
  [systemd services](systemd-services.md#watching-large-collections-v0401).

---

## v0.40.0: the post-compaction block carries only this session's pre-compaction state

**Nothing has to be run; three things are worth doing.** Through v0.39.1 the
pre-compaction state was one `precompact-state.md` per project directory, read back on every
session start there, so a session could receive another session's state — see the
[release notes](../../RELEASE_NOTES.md) and [setup-hooks](setup-hooks.md#compaction-hooks).

- **Upgrade every ClawMem install that shares the vault** — the hooks, the watcher, the MCP
  server in every open session, and the OpenClaw or Hermes plugin wherever they run. Everything
  below describes an upgraded process. An older version still running writes and reads the old
  file, injects it, and enriches notes from it, so its sessions keep the leak until it is upgraded
  or stopped. `clawmem doctor` shows red while a legacy file is being written after the upgrade.
- **Re-run `clawmem setup hooks`.** It moves `postcompact-inject` into its own SessionStart group
  with matcher `compact`. The hook already ignores every other start, so an old layout stays
  correct; the re-run only stops a wasted process launch per session start. Other tools' hooks in
  the same groups are kept.
- **Delete the old `precompact-state.md` files.** `clawmem doctor` lists them. An upgraded
  ClawMem uses them for nothing: only the doctor lists them and the indexer retires their copies.

What happens on its own:

- Search, retrieval, globs and path suffixes stop returning indexed copies of the old file at once,
  whatever version indexed them, and enrichment and embedding stop reading them. The indexer
  deactivates each copy whose file it finds (reason `absent`) on its next pass, and `clawmem doctor`
  lists the copies still active. One from before v0.34 whose file is gone stays until you forget it
  (`memory_forget` with its exact path, `collection/path`).
- Older versions let a copy feed A-MEM enrichment, so a note's A-MEM summary can carry text from
  another session, and an older ClawMem still running after the upgrade reads notes unguarded. So an
  upgraded process never hands an enrichment prompt a note a copy shaped, or one an older ClawMem
  evolved after the upgrade (its evolution entries carry no writer stamp). The first writable open
  (and each background pass) clears such a note, and its `memory_evolution_status` history shows a
  `reset:` entry in place of the entries that carried the text. The light-lane backfill
  (`CLAWMEM_ENABLE_CONSOLIDATION=true`) rebuilds it from the note's own text. A note indexed from a
  file is also rebuilt when the file changes or by `clawmem reindex --enrich`; one that hooks or the
  API wrote stays without an A-MEM note until the light lane runs (search and injection never use
  one).
- The first writable open adds a `writer` column to `memory_evolution` and records where the vault's
  history ends, in one short write. If another process holds the vault's write lock for longer than
  that open waits, the open fails and changes nothing: a hook skips its work that once, and a
  watcher, an MCP server or a CLI command reports the error and exits; start it again.
- A small database `<vault>-compaction.sqlite` appears beside the vault file (for the default
  vault, `~/.cache/clawmem/index.sqlite-compaction.sqlite`). It holds one registration per
  compacting session; each is marked taken when its compaction's session start takes it, and each
  is removed after 7 days.
- REST `GET /export` leaves the old copies out and reports how many in `legacy_snapshots_excluded`;
  `GET /export?full=true` includes them (every active document; the export is not a vault backup).
- `get` and `multi_get` resolve `collection/path` exactly before trying the text as a path suffix.
- **Downgrading** is safe: v0.39.x ignores the new table, column and flag and the registration
  database, and goes back to its own file-based behaviour, leak included. Upgrading again later
  clears the notes it evolved in between.

Nothing to re-embed or re-index, and no config change.

## v0.39.1: collection edits keep the comments in `config.yaml`

**No vault migration and nothing to run.** `clawmem collection add` and `collection remove` now
edit `~/.config/clawmem/config.yaml` in place instead of rewriting it, so comments, blank lines,
quoting and key order outside the edited entry survive — see the
[CLI reference](../reference/cli.md#collection-management).

- **Comments an earlier version already dropped do not come back.** Every write before v0.39.1
  re-serialised the whole file without them. Restore any you still need from a backup or from
  version control.
- **Re-adding an existing name keeps its `update` command.** Earlier versions rebuilt the entry
  from path, pattern and context, and dropped `update`.
- **Writes no longer copy the lifecycle defaults into the file.** A `lifecycle:` block an earlier
  version wrote stays as it is. ClawMem still applies the defaults when it reads the file, so the
  effective policy is unchanged.
- **An edit the file's YAML cannot keep now stops instead.** A command that reports
  `Cannot edit … in place` has left the file untouched: the file uses a merge key, anchor or
  alias the edit would have changed, such as a collection that only a `<<:` merge key provides.
  Edit it by hand — see [troubleshooting](../troubleshooting.md#general).

---

## v0.39.0: the OpenClaw plugin on current OpenClaw, and `forgotten` counts only forget

**No vault migration; nothing auto-applies in the vault.** What to do depends on your setup:

- **OpenClaw: re-run `clawmem setup openclaw` after upgrading.** It installs the compiled copy
  OpenClaw 2026.5.3 and later require, ships the manifest's tool declarations (from 2026.5.2
  undeclared agent tools are rejected), and sets `hooks.allowConversationAccess` (needed from
  2026.4.23) and `plugins.slots.memory` — see
  [OpenClaw 2026.5 and later](openclaw-plugin.md#openclaw-20265-and-later-what-changed-and-what-setup-does-about-it).
  On OpenClaw 2026.5 and later it asks for capability consent: add `--accept-capabilities` (or
  `--yes`) to a non-interactive run. A gateway that runs as a service user: add
  `--gateway-user <name>`. A named profile: `OPENCLAW_PROFILE=<name>` now reaches OpenClaw as
  `--profile <name>`. New plugin config: `hookBudgetMs` (default 6000, 1000 to 25000). Setup now
  stops when it cannot record an executable `clawmemBin`, and, with `--gateway-user`, when that
  user cannot read the installed files.
- **Source checkouts: run `bun install`.** `node-llama-cpp` moved to ^3.20.0. Package installs
  get it with the update.
- **In-process models on CUDA: run `clawmem embed` once after upgrading.** The first in-process
  embedding after the `node-llama-cpp` upgrade compiles its kernels once (about ten seconds);
  `clawmem embed` pays that outside a prompt.
- **Reranking re-scores cold once.** In-process scores cached under node-llama-cpp 3.15.1 had a
  squeezed scale, and a v0.38 remote cache can hold such scores written while its endpoint was
  down; neither is reused. Expected, not a defect.

### `forgotten` counts only forget; inactive documents broken down by reason

**Drop-in — no migration, no action required.** `clawmem lifecycle status`, the `lifecycle_status` MCP tool,
`GET /lifecycle/status` and `clawmem curate` now report **`forgotten` as the number of documents deactivated
by forget** (`deactivated_reason = 'forget'`). It used to count every inactive document without
`archived_at`, which also took in documents whose source file disappeared and documents deactivated before
v0.31.0 recorded a reason — so **on an existing vault the number usually drops**. Nothing in the vault
changed; the old count was mislabelled.

A new breakdown partitions every inactive document, exhaustively and without overlap:

| Reason | Meaning |
|---|---|
| `absent` | its file disappeared from the collection (the document comes back if the file does) |
| `forget` | deactivated by forget (`memory_forget`, `POST /documents/:docid/forget`) — equals `forgotten` |
| `archive` | archived by the lifecycle sweep, or an older row with no recognised reason but an `archived_at` |
| `unknown_legacy` | no recognised reason and no `archived_at` — in practice a row deactivated before v0.31.0, by forget or by absence; that cause cannot be recovered, so it is not guessed |

The CLI and the MCP tool print it as `Deactivation reasons: absent N, forget N, archive N, unknown-legacy N`;
`GET /lifecycle/status` adds a `deactivation_reasons` object; the curator report
(`~/.cache/clawmem/curator-report.json`) adds `health.deactivationReasons`. Anything that relied on the old
meaning of `forgotten` should read `deactivation_reasons` instead.

## v0.38.0: channel-aware hook ranking, relevance admission, off-process bookkeeping

**Drop-in.** Schema migrations are additive and auto-apply on first open: `dedupe_key` columns (with partial unique indexes) on `context_usage` and `recall_events` for idempotent off-process bookkeeping, and the `surfacing_diagnostics` table (created lazily the first time `CLAWMEM_SURFACING_TRACE=1` persists a trace). No reindex, no re-embed, no graph rebuild. MCP tools are unchanged — everything below is the context-surfacing hook.

**Behavior changes to expect:**

- **The surfaced set and its order can differ from v0.37.0.** Membership, final order, and admission now all run on one channel-aware ordering key (current-support band + weighted-RRF fused mass) — see [relevance admission](../concepts/hooks-vs-mcp.md#relevance-admission). The composite score no longer orders or admits hook output; it sizes the injection tiers only. Consequences: pins, co-activation, recency, and quality multipliers no longer change *which* documents the hook surfaces or their order (they still act on the composite MCP surfaces); the spreading-activation and memory-type-diversification stages are removed.
- **The hook abstains instead of surfacing weak lists.** Two new empty-output classes: no current-turn support, and a keyword-degenerate basis (FTS agreed on nothing — the junk signature of gibberish or fully-off-vault prompts). An empty `<vault-context>` there is the designed outcome, not a regression.
- **Session focus is presentation-only.** A focus topic now steers snippet selection only; the 1.4×/0.75× post-composite topic boost and the expansion/rerank intent threading are removed. The surfaced set and order are byte-identical with or without a focus.
- **Turn alignment is fail-closed; bookkeeping left the hook.** The hook writes its `context_usage` alignment row at retrieval commit; if that write cannot land (writer contention), the hook emits nothing for that turn rather than injecting untracked context. Recall events, injected-paths fill-in, and secondary-vault mirrors are applied by a detached drainer through an on-disk spool (`<db dir>/surfacing-spool/`, new) — best-effort learning data, never turn alignment. `clawmem spool-drain` applies pending jobs manually; details in [architecture → Off-process surfacing bookkeeping](../concepts/architecture.md#off-process-surfacing-bookkeeping-v0380).
- **Rerank caching is provider-identity-gated, and existing rerank cache entries invalidate once.** Remote rerank scores are cached only under an attested provider identity — run `clawmem rerank-health` once per endpoint to attest (7-day expiry; a failed probe revokes). Independently, the rerank request-construction revision was bumped (`RERANK_REQUEST_REV=2` — session focus removed from rerank intent), so previously cached rerank scores no longer match: the first deep-profile queries after upgrading re-score cold. Expected, not a defect.

**Recommended (not required):** re-run `clawmem setup hooks` — it now derives the host hook timeout from the internal budget (`CLAWMEM_HOOK_BUDGET_MS`, default 6000ms; host ≥ 1.5s startup + budget), pins the budget into the installed hook command, and never reduces an existing larger timeout. `clawmem doctor` checks the inequality.

**Restart the watcher after upgrading** (`systemctl --user restart clawmem-watcher.service`, or wherever `clawmem watch` runs). The hook's vector deadline is scoped to a watcher/daemon-backed deployment in v0.38.0, and `clawmem doctor` / `clawmem vec-daemon-health` attest the watcher's vector daemon by a ping round trip that only a v0.38 `clawmem watch` answers in full. A watcher still running pre-v0.38 code reports `live-legacy` (DB and pid unattested) until it is restarted on the new code, after which it reports `live` and advertises both the `hydrated-v1` response protocol and the `deadline-rel-v1` relative-budget protocol. The restart is also what activates the deadline-holding vector path: the v0.38 hook asks the daemon to hydrate and project results server-side (`hydrated-v1` — snippets, rerank text, and filter verdicts computed in the daemon, bodies never crossing the wire), so the hook performs no synchronous sqlite work inside its vector deadline, and it sends the daemon a relative remaining budget rather than a wall-clock deadline.

**Upgrade the hook and the watcher together.** The v0.38 wire is not backward compatible in either direction, by design: a daemon that does not attest `deadline-rel-v1` (or answers a hydrated request with raw hits) is classified `skew` by the v0.38 hook, and a v0.38 daemon refuses a pre-v0.38 hook's absolute `deadlineMs` request as `version_skew`. Either mismatch keeps surfacing working but drops its vector legs to FTS until both sides run v0.38 — the v0.38 hook prints a once-per-process warning naming the socket; a pre-v0.38 hook degrades silently, and since v0.38.1 the watcher logs the first `version_skew` refusal once per run. Restart `clawmem watch` in the same step as installing the new hook — and if the hook command in `~/.claude/settings.json` and the watcher's service unit point at different installs (a source checkout for one and a package install for the other, or a unit drop-in override), upgrade both paths: upgrading one leaves the other behind. [Troubleshooting](../troubleshooting.md) covers the symptoms.

New knobs: `CLAWMEM_HOOK_BUDGET_MS`, `CLAWMEM_ADMISSION_POLICY` (eval control arm), `CLAWMEM_RERANK_DEGENERACY_GATE`, `CLAWMEM_RERANK_LANE_WEIGHT`, `CLAWMEM_RERANK_PROVIDER_ID`, `CLAWMEM_SURFACING_TRACE`, `CLAWMEM_PRIOR_VECTOR_INPROC` — see [configuration](../reference/configuration.md). New eval surface: `clawmem eval hook-run` / `hook-aggregate` — see [eval-harness](eval-harness.md#hook-replay-clawmem-eval-hook-run).

---

## v0.37.0: reachable-but-wrong inference endpoints degrade instead of silently dying

**No migration** — no schema change, no reindex, no re-embed. One behaviour change to
know about: an LLM or self-hosted embedding endpoint that persistently answers HTTP
errors (405/501 immediately; any other non-2xx after 3 consecutive failures) now trips
the same 60-second cooldown a transport failure does, so the in-process fallback engages
where it is permitted. Through v0.36.0 that state never tripped, and a port squatted by
an unrelated service could disable A-MEM enrichment silently and permanently while
indexing kept reporting success (public issue #24). Cloud embedding (API key set) is
exempt and never falls back; 429 never counts.

Restart long-lived processes (`clawmem watch`, `clawmem serve`, systemd units) to pick up
the new behaviour. Two new signals to know: `clawmem doctor` now probes
`CLAWMEM_LLM_URL` with a real completion and validates the response shape, and every
index-run summary (`update` / `reindex` / `mine` / watcher / MCP / REST) reports
`✎stored/attempted notes` with an explicit warning when enrichment produced nothing.
`IndexStats` and the REST `/reindex` response gain `enrichAttempted`/`enrichStored`
(additive).

---

## v0.36.0: memory_stats + memory_rank diagnostics

**No migration** — no schema change, no reindex, no re-embed, and no behaviour change
to any existing tool. Two new read-only MCP tools: `memory_stats` (per-collection
lifecycle + ranking-metadata aggregates) and `memory_rank` (per-result composite
ranking breakdown with raw-vs-composite rank shifts). See
[mcp-tools.md](../reference/mcp-tools.md) for parameters.

The MCP stdio server is respawned per agent session, so new sessions see the tools
immediately; reconnect (`/mcp` in Claude Code) any session that stays open across the
upgrade. Hooks, the watcher, and all retrieval semantics are untouched.

---

## v0.35.0: secondary-vault surfacing is now opt-in

**No migration** — no schema change, no reindex, no re-embed. One behaviour change to check.

**Behaviour change:** the `context-surfacing` hook no longer merges a configured secondary
vault's results into the automatically injected context by default. Single-vault
deployments are unaffected. If you run multi-vault AND relied on automatic cross-vault
surfacing, re-enable it:

```yaml
# ~/.config/clawmem/config.yaml
retrieval:
  surface_secondary_vaults: true
```

or `CLAWMEM_SURFACE_SECONDARY_VAULTS=true` (env wins over yaml; only the literal `true`
enables). Config is process-cached — restart long-lived processes (`clawmem watch`, the
MCP server) after changing it; hook invocations are per-event processes and pick it up on
their next run.

Explicit `vault`-parameter MCP calls are not affected by the gate in either state.

## v0.34.0: origin-aware reconciliation

**Migration is automatic** on first open and additive only: one new column
(`documents.origin`). No data backfill — deliberately: `content_hash` proves nothing about
ownership (mined imports write it too), so legacy rows stay `NULL` (exempt from absence
reconciliation) and are adopted by the next writer to touch them. Files present on disk adopt
`fs` on the next index pass of their collection; hook/`saveMemory` rows adopt `api` on their
next write.

**Behaviour changes to expect:**
- A row whose file was already deleted *before* upgrading is no longer auto-deactivated —
  nothing proves the indexer owned it. Retire it with `memory_forget` or a lifecycle sweep if
  unwanted.
- `saveMemory` now rejects a write to a path occupied by a filesystem-owned document or by an
  inactive document (lifecycle decisions stick), instead of silently overwriting.
- `clawmem mine` is additive: re-mining into the same collection no longer deactivates
  earlier batches.

**Verify after upgrading:** `clawmem update` on any collection, then confirm hook-written
rows survive it — e.g. `sqlite3 <vault> "SELECT COUNT(*) FROM documents WHERE origin='api'
AND active=0 AND deactivated_reason='absent'"` should stay at its pre-upgrade value (new
absence deactivations of `api` rows can no longer occur).

---

## v0.33.0: the causal witness writer + Stop-hook deadline + docid validation

**Migration is automatic** on first open and additive only: four new tables (`causal_runs`,
`causal_run_events`, `causal_witness_sightings`, `retired_causal_edges`) plus indexes. No data
backfill, no manual step.

**Mixed-version exposure is lower than v0.31/v0.32** — the schema additions are ignored by old
code and the causal writer defaults to `off`, so a stale process cannot corrupt the new state.
What a stale process DOES keep until restarted: the unescaped-docid lookup (the `_`/`%` wildcard
vulnerability, reachable through REST `/documents/{docid}/forget`) and the unbounded Stop-hook
phases. Restart daemons and reconnect open agent sessions to retire both.

**Before arming the writer** (`CLAWMEM_CAUSAL_WRITER=on`): run
`clawmem migrate causal-witnesses --preflight`. Edges from the pre-v0.30 writer whose metadata
cannot yield a valid witness make the new writer fail closed on those candidates; resolve them
(`--resolve-unmaterializable keep-weight|retire-edge`, manifest-bound, explicitly selected edges
only — retirement is reversible via `--restore-edge`) or accept the per-candidate refusals.
Recommended order: `shadow` first, read `clawmem causal-audit` for a few sessions, then `on`.

**Behavior to check after upgrading:**

- Docids are structurally validated everywhere (`^[0-9a-fA-F]{6,64}$` after `#` strip): `_`, `%`,
  non-hex, and prefixes shorter than 6 now return not-found on every docid surface, MCP and REST.
  Anything that relied on wildcard matching was relying on the vulnerability.
- The `decision-extractor` Stop hook now runs to a whole-handler deadline
  (`CLAWMEM_STOP_BUDGET_MS`, default 25000): under a slow inference server, phases are skipped
  (audited + logged) instead of overrunning the host hook timeout. Ensure the installed host hook
  timeout exceeds the budget plus margin (default 25s sits under Claude Code's 30s).
- `find_causal_links` (MCP + REST) returns the new directed edge-record shape with fact-pair
  witnesses, capped at a 64 KiB response ceiling that drops whole edges from the tail. Consumers
  parsing the old shape need updating.
- With the writer `off` (default), no causal model call and no causal rows — the audit surfaces
  stay empty until you arm `shadow`/`on`.

---

## v0.32.0: the shared causal pipeline + knowledge-graph evidence

**Migration is automatic** on first open: a new `entity_triple_provenance` table records one row
per unique evidence source per knowledge-graph fact, backfilled from every existing triple's
inline evidence (a triple with no inline evidence gets a single `unattributed` row). The backfill
is idempotent and read-guarded — steady-state opens perform no writes.

**Upgrading with concurrent writers:** the [v0.31.0 mixed-version caution](#v0310-forget-and-archive-survive-re-indexing)
applies here too. An old-code process still writing after the vault has migrated inserts
knowledge-graph facts without evidence rows — repaired by a later open's backfill — and keeps
dropping repeat sightings outright, which is not recoverable: the evidence row is simply never
written. Restart daemons and reconnect open agent sessions together.

**Behavior to check after upgrading:**

- `memory_retrieve`'s causal mode, `intent_search`, `query_plan`'s graph clauses, and REST
  `/retrieve`'s causal mode now run ONE shared pipeline. WHY-classified queries on the
  default-filtered routes reach `_clawmem` **observation documents** (never handoffs/deductions)
  and follow causal edges one bounded hop in both directions — internal observation paths
  appearing in causal results is the feature, not a leak. `includeInternal` semantics are
  unchanged.
- `intent_search(enable_graph_traversal: false)` now disables the one-hop step too, along with
  adaptive traversal, MPFP, and entity expansion.
- REST `/retrieve` causal gains graph traversal (it was anchor-only RRF). The REST classifier now
  recognizes the same causal phrasings as MCP ("why were", "because we").
- `kg_query` facts now carry `evidenceCount` + up to 5 `sources`; text output appends
  `[evidence ×N; sources: …]`.
- Inactive, invalidated, or out-of-time-window documents no longer consume graph-traversal
  budget on any causal surface.

---

## v0.31.0: forget and archive survive re-indexing

**Migration is automatic** on first open: a new `documents.deactivated_reason` column records why
each row was deactivated (`absent` / `forget` / `archive`); existing archived rows are backfilled
as `'archive'`, and any row a previous version left simultaneously active-and-archived is
repaired to archived (count reported on stderr — use `lifecycle_restore` to bring any back).

**Mixed-version caution — restart every writer together.** Once any new-code process has opened
(and therefore migrated) the vault, a still-running old-code process must not keep writing. An
old-code writer deactivates documents without recording a reason, and the new indexer
deliberately treats reason-less deactivation as legacy absence — so a `memory_forget` issued
through a stale session can be reactivated by the next re-index: the exact bug this release
fixes, reintroduced by the stale process. Exposure requires concurrent long-lived writers — the
watcher, `clawmem serve`, or an MCP server in an agent session that stays open across the
upgrade; a single-session setup with no daemons needs nothing beyond the quick path. The
discipline is one line: restart the daemons and reconnect (`/mcp`) or restart every open agent
session as part of the upgrade, so no pre-upgrade process keeps writing afterward.

**Behavior to check after upgrading:**

- `memory_forget` on a file-backed document now STICKS across `clawmem update` / the watcher —
  do not re-run forget after indexing. Only absence-deactivated rows reactivate automatically.
- `clawmem reindex --force` no longer blanket-deactivates the vault up front; it re-reads and
  rewrites every file, bypassing the content-hash short-circuit. `_clawmem` is refused by the
  filesystem indexer outright (database-created memory has no filesystem source).
- A failed A-MEM enrichment no longer blanks learned keywords/tags/context — an empty note is
  refused and the prior note preserved.

---

## v0.30.0: ClawMem no longer deletes document rows

No schema change, no re-embed, no reindex. **Check whether you set `purge_after_days`:**

```bash
grep -A6 '^lifecycle:' ~/.config/clawmem/config.yaml | grep purge_after_days
```

- **`purge_after_days: null` (the default) — nothing changes.** No deletion was happening.
- **`purge_after_days: <number>` — deletion stops.** Until now, a non-dry-run
  `lifecycle_sweep` *and* every SessionStart with the `staleness-check` hook installed
  permanently deleted every archived row past that window. The MCP preview never listed or
  counted those rows (it reported only what would be *archived*), and the hook path reported
  nothing at all. **Anything already deleted is gone**; this release stops the ongoing loss.
  The value is now inert — archival continues and stays reversible via `lifecycle_restore`.

There is no replacement command. Physical deletion is the one ClawMem mutation with no
restore path, and no in-process or CLI credential can tell an operator apart from the coding
agent ClawMem serves — an env var or a confirmation flag is satisfiable by the agent itself.
So the capability is not offered rather than gated. If you need to reclaim space, operate on
the SQLite file directly, out-of-band; that is explicitly outside ClawMem's mutation
contract. A supported retention design (reversible quarantine with a protected window) is
planned.

**Also fixed:** `archiveDocuments` / `restoreArchivedDocuments` returned SQLite's `changes`
count, which includes the `documents_fts` trigger writes — archiving 3 documents reported
16. Every "archived N" / "restored N" figure ClawMem printed was inflated. The mutations
were always correct; only the counts were wrong. If you parse that output, the numbers will
now be smaller and accurate.

---

## v0.29.0: contradiction judge — a behavior change to check

Schema changes (`judge_runs`, `judge_events`) auto-apply on first open; no re-embed or
reindex. **One behavior change needs a decision from you:**

**Contradiction analysis is now judge-gated.** It runs ONLY when `CLAWMEM_JUDGE_*` is
configured, because the stock expansion model cannot meet the judge contract
([details](inference-services.md#contradiction-judge)). Check which case you are in:

- **Stock install** (wrapper defaults, or `CLAWMEM_LLM_URL` at the stock 1.7B): nothing to
  do. No verdict ever applied on the stock model — you lose nothing and gain a skipped LLM
  call per Stop hook. Configure a judge when you want contradiction analysis.
- **Custom global LLM** (you pointed `CLAWMEM_LLM_URL`/`CLAWMEM_LLM_MODEL` at a larger or
  cloud model): contradiction verdicts **may have been genuinely applying** through the
  global endpoint, and after this upgrade they stop until you opt in. To keep the behavior,
  configure the judge explicitly — e.g. the same endpoint, task-scoped:

  ```bash
  export CLAWMEM_JUDGE_URL="$CLAWMEM_LLM_URL"
  export CLAWMEM_JUDGE_MODEL="your-model-id"        # required — no default on this lane
  export CLAWMEM_JUDGE_API_KEY="$CLAWMEM_LLM_API_KEY"   # if the endpoint needs one
  ```

  ClawMem never adopts the global endpoint as a judge automatically — the judge vars are
  also your data-egress consent (the judge receives new decisions + retrieved snippets).
  `clawmem doctor` warns when it detects a custom global LLM with no judge configured (it
  cannot detect a custom model served at the stock localhost endpoint — this notice is the
  authoritative one).

Also in this release: `CLAWMEM_CONTRADICTION_POLICY=supersede` now **requires a configured
judge** — without one it is loudly constrained to the non-deactivating `link` policy and
`clawmem doctor` reports it inactive. Run `clawmem doctor` after upgrading: it smoke-tests
whatever judge you configure and reports the audit tables.

---

## v0.28.0: hook write-path contracts

No migration, no re-embed, no config change. Drop-in.

**One behavior change to be aware of:** `build_graphs` now reports `N new edge(s), M total`
instead of `N edges`, and both the MCP tool and the REST endpoint gained `temporalTotal` /
`semanticTotal` fields. The counts also changed meaning — they report rows actually written
rather than insert attempts, so an idempotent rebuild now correctly reports 0 new edges (the
standing total tells you the graph is populated). If you parse that text output, update it.

Totals count only edges whose both endpoints are active, matching what the builders operate on.

**Contradiction detection starts having an effect.** The hook always classified, but two contract
defects discarded every verdict before it could mutate anything — it will now lower the confidence of documents a
session's facts contradict (`-0.25`, floored at `0.2`). That is a ranking signal only; nothing
leaves retrieval. (Superseded in v0.29.0: contradiction analysis now runs only when a judge is
configured via `CLAWMEM_JUDGE_*` — see the v0.29.0 section above.) The terminal step that *does* remove a document from retrieval — invalidation —
is **off by default** behind `CLAWMEM_CONTRADICTION_INVALIDATE` and logs `WOULD invalidate`
instead of writing. Nothing to do on upgrade. Before arming it, calibrate against your own vault:
[contradiction invalidation](contradiction-invalidation.md).

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
| Contradiction policy | v0.7.1 (judge-gated v0.29.0) | `CLAWMEM_CONTRADICTION_POLICY=link` (default, keep both rows + set the old row's `invalidated_by` backlink) or `supersede` (mark old row `status='inactive'`; requires a configured judge since v0.29.0). |
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
