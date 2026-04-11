# Setting up Claude Code hooks

Claude Code hooks give ClawMem automatic context injection and extraction on every prompt and response. This is the primary integration path for Claude Code memory.

## Install default hooks

```bash
clawmem setup hooks
```

This installs hooks into `~/.claude/settings.json`:

| Hook | Event | Timeout | Purpose |
|------|-------|---------|---------|
| `context-surfacing` | UserPromptSubmit | 8s | Search vault, inject relevant context |
| `curator-nudge` | SessionStart | 5s | Surface maintenance suggestions |
| `postcompact-inject` | SessionStart | 5s | Re-inject state after compaction |
| `precompact-extract` | PreCompact | 5s | Preserve state before compaction |
| `decision-extractor` | Stop | 30s | Extract observations from conversation |
| `handoff-generator` | Stop | 30s | Summarize session for continuity |
| `feedback-loop` | Stop | 30s | Track referenced notes, boost confidence |

## Manual install (full reference)

If you prefer to configure hooks manually instead of running `setup hooks`, add this to `~/.claude/settings.json`. Replace `/path/to/clawmem` with your actual install path (e.g. `~/.bun/bin/clawmem` or `~/clawmem/bin/clawmem`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "/path/to/clawmem hook context-surfacing",
        "timeout": 8
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "/path/to/clawmem hook curator-nudge",
        "timeout": 5
      },
      {
        "type": "command",
        "command": "/path/to/clawmem hook postcompact-inject",
        "timeout": 5
      }
    ],
    "PreCompact": [
      {
        "type": "command",
        "command": "/path/to/clawmem hook precompact-extract",
        "timeout": 5
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "/path/to/clawmem hook decision-extractor",
        "timeout": 30
      },
      {
        "type": "command",
        "command": "/path/to/clawmem hook handoff-generator",
        "timeout": 30
      },
      {
        "type": "command",
        "command": "/path/to/clawmem hook feedback-loop",
        "timeout": 30
      }
    ]
  }
}
```

## Remove hooks

```bash
clawmem setup hooks --remove
```

## Available but not default

These hooks exist but are not installed by default:

| Hook | Event | Why not default |
|------|-------|----------------|
| `session-bootstrap` | SessionStart | Redundant with `context-surfacing` for most setups. Useful for heavy bootstrap context on session start. |
| `staleness-check` | SessionStart | Can add latency on session start. Useful for surfacing stale document alerts. |

To add them, append to the `SessionStart` array in the config above:

```json
{
  "type": "command",
  "command": "/path/to/clawmem hook session-bootstrap",
  "timeout": 5
},
{
  "type": "command",
  "command": "/path/to/clawmem hook staleness-check",
  "timeout": 5
}
```

## Timeouts

All hooks use Claude Code's native `timeout` property (in seconds). Stop hooks use 30s to allow LLM inference to complete; other hooks use 5-8s.

**Do not use shell `timeout` wrappers** (e.g., `timeout 10 clawmem hook ...`). When shell `timeout` kills a process, it exits with code 124 and no stderr, which Claude Code reports as "Stop hook error: Failed with non-blocking status code: No stderr output". The native `timeout` property is handled gracefully by Claude Code's hook runner.

## Deduplication

The `context-surfacing` hook suppresses duplicate prompts using SHA-256 hashing with a 600-second window (`hook_dedupe` table). Heartbeat prompts are also detected and skipped.

The Stop-event hooks (`decision-extractor`, `handoff-generator`, `feedback-loop`) use `saveMemory()` which enforces a 30-minute normalized content hash dedup window, preventing duplicate observations across concurrent or rapid sessions.

## Adding custom hooks alongside ClawMem

If you add your own hooks to `~/.claude/settings.json` alongside ClawMem's (e.g., a custom Stop hook for context management), every code path in your script must output valid JSON to stdout. Claude Code treats a hook that exits 0 with no stdout as an error.

Use this pattern:

```bash
#!/bin/bash
OK='{"continue":true,"suppressOutput":false}'
input=$(cat)

# Every early return must output JSON
transcript=$(echo "$input" | jq -r '.transcriptPath // empty')
if [[ -z "$transcript" ]]; then
    echo "$OK"; exit 0
fi

# ... your logic ...

# Default path must also output JSON
echo "$OK"
```

ClawMem's built-in hooks handle this automatically. This only applies to custom scripts you add to the same hook events.

## Profile integration

`context-surfacing` reads `CLAWMEM_PROFILE` to configure its token budget, max results, vector timeout, minimum score threshold, and deep escalation (query expansion + reranking on the `deep` profile). See [Tuning context-surfacing with profiles](../concepts/hooks-vs-mcp.md#tuning-context-surfacing-with-profiles).
