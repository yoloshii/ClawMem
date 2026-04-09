# Upgrading ClawMem

Guide for upgrading between released versions. Current: **v0.8.1**.

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

All schema changes from v0.7.1 → v0.8.1 are additive and idempotent:

- New tables via `CREATE TABLE IF NOT EXISTS`
- New columns via `ALTER TABLE ADD COLUMN` wrapped in `try/catch`
- A per-database feature-detect cache so ad-hoc stores that skip the migration path degrade transparently (they never write columns that don't exist)

The first time any v0.7.1+ process opens an existing vault, the migrations run silently. Hook invocations alone are sufficient — you do not need a manual upgrade command.

### What you do NOT need to run

- `clawmem embed` — embedding contract and fragment boundaries are unchanged across v0.7.x → v0.8.x
- `clawmem reindex` — document storage is unchanged
- `clawmem reindex --enrich` — no new enrichment stages added
- `clawmem build-graphs` — no new graph edge types
- `clawmem setup hooks` — hook configuration is unchanged (no new hooks, no renamed hooks, no changed budgets)
- `bun install` / `npm install` — no dependency changes in `package.json` between v0.7.0 and v0.8.1
- Edit `~/.config/clawmem/config.yaml` — no required fields added

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
