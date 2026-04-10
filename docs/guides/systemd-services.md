# Systemd services for ClawMem

Keep ClawMem's AI agent memory services running automatically with systemd user units. This is important for GPU setups — if a llama-server crashes, ClawMem silently falls back to in-process inference via `node-llama-cpp` (Metal on Apple Silicon, Vulkan where available, CPU as last resort). With GPU acceleration (Metal/Vulkan) the fallback is fast; on CPU-only systems it is significantly slower. Systemd's `Restart=on-failure` ensures servers come back up automatically. To disable silent fallback entirely, set `CLAWMEM_NO_LOCAL_MODELS=true`.

## Watcher service

Monitors collections for file changes and re-indexes automatically:

```bash
cat > ~/.config/systemd/user/clawmem-watcher.service << 'EOF'
[Unit]
Description=ClawMem file watcher — auto-indexes on .md changes
After=default.target

[Service]
Type=simple
ExecStart=%h/clawmem/bin/clawmem watch
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
```

## Embed timer

Daily embedding sweep at 04:00 UTC:

```bash
cat > ~/.config/systemd/user/clawmem-embed.service << 'EOF'
[Unit]
Description=ClawMem embedding sweep

[Service]
Type=oneshot
ExecStart=%h/clawmem/bin/clawmem embed
EOF

cat > ~/.config/systemd/user/clawmem-embed.timer << 'EOF'
[Unit]
Description=ClawMem daily embedding sweep

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
```

## Enable and start

```bash
mkdir -p ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user enable --now clawmem-watcher.service clawmem-embed.timer

# Persist across reboots (start without login)
loginctl enable-linger $(whoami)
```

## Verify

```bash
systemctl --user status clawmem-watcher.service
systemctl --user status clawmem-embed.timer
```

## Background maintenance workers (v0.8.2)

ClawMem ships two background workers that improve retrieval quality over time:

- **Light consolidation lane** — every 5-10 min, enriches documents missing A-MEM metadata (Phase 1), merges near-duplicate observations (Phase 2), and synthesizes deductive observations from related decisions (Phase 3). Off by default.
- **Heavy maintenance lane** — runs on a longer interval *only inside a configurable hour window*, batches stale-first work (least-recently-recalled documents first), and journals every attempt. Designed for overnight maintenance on large vaults. Off by default.

As of v0.8.2 the canonical host for both lanes is the long-lived `clawmem-watcher.service` you just set up, so the heavy lane's quiet window actually sees a live worker every night regardless of whether any agent session is open. The per-session stdio MCP host (`clawmem mcp`) retains the same env-var gates as a fallback for non-watcher deployments, but emits a warning when heavy lane is enabled there.

Both lanes share DB-backed `worker_leases` exclusivity, so running multiple host processes against the same vault is safe — only one worker can hold the lease for each lane at a time.

### Enable via systemd drop-in

Recommended approach: `systemctl --user edit clawmem-watcher.service` and paste the following. This creates `~/.config/systemd/user/clawmem-watcher.service.d/override.conf` without editing the main unit file, so a future `clawmem` upgrade that touches the unit file does not clobber your tuning.

```ini
[Service]
# Light consolidation lane — drains enrichment backlog and runs Phase 2/3
# consolidation. Hosted inside the long-lived watcher process, so it ticks
# whenever the watcher is up. v0.8.2+ wraps every tick in a worker_leases
# row so multi-host deployments are safe.
Environment=CLAWMEM_ENABLE_CONSOLIDATION=true
Environment=CLAWMEM_CONSOLIDATION_INTERVAL=600000

# Heavy maintenance lane — quiet-hours stale-first batch consolidation +
# deductive synthesis. Off-hours window in LOCAL time (not UTC).
Environment=CLAWMEM_HEAVY_LANE=true
Environment=CLAWMEM_HEAVY_LANE_INTERVAL=1800000
Environment=CLAWMEM_HEAVY_LANE_WINDOW_START=2
Environment=CLAWMEM_HEAVY_LANE_WINDOW_END=6
```

Then reload + restart:

```bash
systemctl --user daemon-reload
systemctl --user restart clawmem-watcher.service
journalctl --user -u clawmem-watcher.service -n 30 --no-pager | grep -E "Starting (consolidation|heavy)"
# Expected:
#   [watch] Starting consolidation worker (light lane, interval=600000ms)
#   [consolidation] Worker started
#   [watch] Starting heavy maintenance lane worker
#   [heavy-lane] Starting worker (interval=1800000ms, window=2-6, ...)
```

### Tuning for your usage pattern

The defaults (`CLAWMEM_CONSOLIDATION_INTERVAL=600000` / 10 min; heavy lane `CLAWMEM_HEAVY_LANE_INTERVAL=1800000` / 30 min, window 02:00-06:00 local) suit a single-developer workstation with overnight idle time. Adjust based on your actual usage:

| Pattern | Light interval | Heavy window | Notes |
|---|---|---|---|
| **Single workstation, overnight idle** | 600000 (10 min) | 02:00-06:00 local | Default. Fine for vaults with up to a few thousand docs. |
| **Always-on workstation, no idle window** | 900000 (15 min) | unset (no window — runs every interval) | Heavy lane will fire every 30 min regardless of hour. The query-rate gate (`CLAWMEM_HEAVY_LANE_MAX_USAGES=30`) skips ticks during active sessions, so it self-throttles. |
| **Shared multi-user server** | 1200000 (20 min) | 03:00-05:00 local | Conservative — minimize background CPU/GPU contention. |
| **Large vault (>10k docs), heavy ingestion** | 600000 (10 min) | 01:00-07:00 local | Wider quiet window to give Phase 2 + Phase 3 time to drain stale-first batches. Bump `CLAWMEM_HEAVY_LANE_OBS_LIMIT=200` and `CLAWMEM_HEAVY_LANE_DED_LIMIT=80` to process more per tick. |
| **Laptop / ephemeral host** | unset (off) | unset (off) | Workers do not survive sleep/suspend cleanly. Run consolidation manually via `clawmem consolidate` instead, or accept the per-session-MCP fallback. |

**Minimum intervals are clamped in code:** light lane is forced to ≥15 s (`CLAWMEM_CONSOLIDATION_INTERVAL=15000`), heavy lane to ≥30 s (`CLAWMEM_HEAVY_LANE_INTERVAL=30000`). Lower values are silently bumped up.

**Quiet window semantics:** start/end hours are in **local time** (`new Date().getHours()`). Both bounds inclusive at start, exclusive at end. Supports midnight wrap (`START=22 END=6` = 22:00-06:00 across midnight). Either bound unset → no window (always run).

### What to expect after the first restart

Assuming you set both env vars and restarted the watcher around midday:

- **+ a few seconds:** watcher logs `[consolidation] Worker started` and `[heavy-lane] Starting worker (...)`. Workers are scheduled but no tick has fired yet — `setInterval` waits one full interval before the first call.
- **+ light interval (e.g. ~10 min):** first light-lane tick fires. Phase 1 enriches up to 3 unenriched docs per tick, so a backlog of N unenriched docs takes roughly `N/3 × interval` to drain. A 100-doc backlog at 10-min interval drains in ~5.5 hours.
- **+ heavy interval (e.g. ~30 min):** first heavy-lane tick fires. If you are *outside* the quiet window, the lane journals `(phase=gate, status=skipped, reason=outside_window)` to `maintenance_runs` and waits for the next interval. This is normal and expected during the day.
- **First night inside the quiet window:** heavy lane runs in earnest. Phase 2 (consolidation) and Phase 3 (deductive synthesis) each get their own `maintenance_runs` row per tick with `status=completed` and per-phase metrics.

### Monitoring

```bash
# Light-lane drainage progress: how much enrichment backlog is left?
sqlite3 -readonly ~/.cache/clawmem/index.sqlite \
  "SELECT COUNT(*) AS total,
          SUM(CASE WHEN amem_keywords IS NULL OR amem_keywords='' THEN 1 ELSE 0 END) AS unenriched
     FROM documents WHERE active=1"

# Heavy-lane journal: every scheduled attempt, including skipped ones
sqlite3 -readonly ~/.cache/clawmem/index.sqlite \
  "SELECT lane, phase, status, reason, started_at, finished_at
     FROM maintenance_runs
     WHERE lane = 'heavy'
     ORDER BY id DESC LIMIT 10"

# Why did the heavy lane skip its most recent tick?
sqlite3 -readonly ~/.cache/clawmem/index.sqlite \
  "SELECT status, reason, started_at FROM maintenance_runs
     WHERE lane = 'heavy' AND phase = 'gate' AND status = 'skipped'
     ORDER BY id DESC LIMIT 5"

# Phase 2 / Phase 3 throughput over the last 7 days
sqlite3 -readonly ~/.cache/clawmem/index.sqlite \
  "SELECT phase, status, COUNT(*), SUM(processed_count), SUM(created_count)
     FROM maintenance_runs
     WHERE lane = 'heavy' AND started_at > datetime('now', '-7 days')
     GROUP BY phase, status"

# Are any leases stuck? (Should be empty unless a worker is mid-tick right now)
sqlite3 -readonly ~/.cache/clawmem/index.sqlite \
  "SELECT worker_name, acquired_at, expires_at FROM worker_leases"

# Live worker activity in the watcher service
journalctl --user -u clawmem-watcher.service -n 50 --no-pager | \
  grep -E "(consolidation|heavy-lane|Worker)"
```

### Rollback

To temporarily disable the workers without removing the drop-in, set both env vars to anything other than `"true"`:

```bash
systemctl --user edit clawmem-watcher.service
# Change the values to "false" then save
systemctl --user daemon-reload
systemctl --user restart clawmem-watcher.service
```

To remove the drop-in entirely:

```bash
rm ~/.config/systemd/user/clawmem-watcher.service.d/override.conf
systemctl --user daemon-reload
systemctl --user restart clawmem-watcher.service
```

The vault state (existing `consolidated_observations`, deductive documents, `maintenance_runs` history) is preserved. Disabling the workers only stops further background work — it does not roll back any consolidation that already happened.

For the architectural deep dive on how the workers operate, see [docs/concepts/architecture.md](../concepts/architecture.md) sections "Heavy maintenance lane (v0.8.0)" and "Dual-host worker architecture (v0.8.2)".

## Remote GPU

If GPU services run on a different machine, add environment overrides to both services:

```ini
[Service]
Environment=CLAWMEM_EMBED_URL=http://gpu-host:8088
Environment=CLAWMEM_LLM_URL=http://gpu-host:8089
Environment=CLAWMEM_RERANK_URL=http://gpu-host:8090
```

Or create a drop-in override:

```bash
mkdir -p ~/.config/systemd/user/clawmem-watcher.service.d
cat > ~/.config/systemd/user/clawmem-watcher.service.d/gpu.conf << 'EOF'
[Service]
Environment=CLAWMEM_EMBED_URL=http://gpu-host:8088
Environment=CLAWMEM_LLM_URL=http://gpu-host:8089
Environment=CLAWMEM_RERANK_URL=http://gpu-host:8090
EOF
systemctl --user daemon-reload
systemctl --user restart clawmem-watcher.service
```

## REST API service (for OpenClaw)

Required for OpenClaw agent tools and remote access. Optional for local MCP clients like Claude Code (which use MCP stdio directly).

```bash
cat > ~/.config/systemd/user/clawmem-serve.service << 'EOF'
[Unit]
Description=ClawMem REST API server
After=default.target

[Service]
Type=simple
ExecStart=%h/clawmem/bin/clawmem serve --port 7438
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
```

For authenticated access, add `Environment=CLAWMEM_API_TOKEN=your-secret` to the `[Service]` section.

Enable alongside the other services:

```bash
systemctl --user enable --now clawmem-serve.service
```

See the [REST API reference](../reference/rest-api.md) for endpoints and usage.

## GPU service units

The three llama-server instances can also run as systemd services:

```bash
# Example: embedding server
cat > ~/.config/systemd/user/clawmem-embed-server.service << 'EOF'
[Unit]
Description=ClawMem embedding server (zembed-1)
After=default.target

[Service]
Type=simple
ExecStart=/usr/local/bin/llama-server \
  -m %h/models/zembed-1-Q4_K_M.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 8192 -b 2048 -ub 2048
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
```

Repeat for LLM (port 8089) and reranker (port 8090) with their respective models and flags.

## Notes

- `%h` in systemd units expands to the user's home directory
- The watcher does NOT embed — it only indexes. The embed timer handles embeddings separately.
- If clawmem is installed elsewhere, update `ExecStart` paths accordingly
