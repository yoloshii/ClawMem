# Systemd Services

Keep ClawMem's background services running automatically with systemd user units. This is important for GPU setups — if a llama-server crashes, ClawMem silently falls back to slower in-process inference via `node-llama-cpp` (Metal on Apple Silicon, Vulkan/CPU otherwise). Systemd's `Restart=on-failure` ensures servers come back up automatically. To disable silent fallback entirely, set `CLAWMEM_NO_LOCAL_MODELS=true`.

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
