# Setting up Claude Code hooks

Claude Code hooks give ClawMem automatic context injection and extraction on every prompt and response. This is the primary integration path for Claude Code memory.

## Install default hooks

```bash
./bin/clawmem setup hooks
```

This installs hooks into `~/.claude/settings.json`:

| Hook | Event | Timeout | Purpose |
|------|-------|---------|---------|
| `context-surfacing` | UserPromptSubmit | 8s | Search vault, inject relevant context |
| `curator-nudge` | SessionStart | 5s | Surface maintenance suggestions |
| `postcompact-inject` | SessionStart | 5s | Re-inject state after compaction |
| `precompact-extract` | PreCompact | 5s | Preserve state before compaction |
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

All default hooks use `timeout` wrappers (5s for SessionStart/PreCompact hooks, 8s for context-surfacing, 10s for LLM-based Stop hooks). This prevents hung GPU services from blocking the agent.

## Deduplication

The `context-surfacing` hook suppresses duplicate prompts using SHA-256 hashing with a 600-second window (`hook_dedupe` table). Heartbeat prompts are also detected and skipped.

The Stop-event hooks (`decision-extractor`, `handoff-generator`, `feedback-loop`) use `saveMemory()` which enforces a 30-minute normalized content hash dedup window, preventing duplicate observations across concurrent or rapid sessions.

## Profile integration

`context-surfacing` reads `CLAWMEM_PROFILE` to configure its token budget, max results, vector timeout, minimum score threshold, and deep escalation (query expansion + reranking on the `deep` profile). See [Tuning context-surfacing with profiles](../concepts/hooks-vs-mcp.md#tuning-context-surfacing-with-profiles).
