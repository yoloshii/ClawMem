# Setup Hooks

Hooks provide automatic context injection and extraction for Claude Code sessions.

## Install default hooks

```bash
./bin/clawmem setup hooks
```

This installs hooks into `~/.claude/settings.json`:

| Hook | Event | Timeout | Purpose |
|------|-------|---------|---------|
| `context-surfacing` | UserPromptSubmit | 5s | Search vault, inject relevant context |
| `curator-nudge` | SessionStart | 5s | Surface maintenance suggestions |
| `postcompact-inject` | SessionStart | 5s | Re-inject state after compaction |
| `precompact-extract` | PreCompact | 10s | Preserve state before compaction |
| `decision-extractor` | Stop | 10s | Extract observations from conversation |
| `handoff-generator` | Stop | 10s | Summarize session for continuity |
| `feedback-loop` | Stop | 10s | Track referenced notes, boost confidence |

## Remove hooks

```bash
./bin/clawmem setup hooks --remove
```

## Available but not default

These hooks exist but are not installed by default:

| Hook | Event | Why not default |
|------|-------|----------------|
| `session-bootstrap` | SessionStart | Redundant with `context-surfacing` for most setups. Useful for heavy bootstrap context on session start. |
| `staleness-check` | SessionStart | Can add latency on session start. Useful for surfacing stale document alerts. |

To add them manually, edit `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "timeout 5 /path/to/clawmem hook session-bootstrap"
      }
    ]
  }
}
```

## Timeout wrappers

All default hooks use `timeout` wrappers (5s for lightweight hooks, 10s for LLM-based extraction). This prevents hung GPU services from blocking Claude Code.

## Deduplication

The `context-surfacing` hook suppresses duplicate prompts using SHA-256 hashing with a 600-second window (`hook_dedupe` table). Heartbeat prompts are also detected and skipped.

The Stop-event hooks (`decision-extractor`, `handoff-generator`, `feedback-loop`) use `saveMemory()` which enforces a 30-minute normalized content hash dedup window, preventing duplicate observations across concurrent or rapid sessions.

## Profile integration

`context-surfacing` reads `CLAWMEM_PROFILE` to configure its token budget, max results, vector timeout, and minimum score threshold. See [Tuning context-surfacing with profiles](../concepts/hooks-vs-mcp.md#tuning-context-surfacing-with-profiles).
