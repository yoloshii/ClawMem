# Performance Profiles

Profiles control the resource budget for context-surfacing hooks. Set via `CLAWMEM_PROFILE` environment variable.

## Available profiles

| Profile | Token budget | Max results | Vector search | Vector timeout | Min score |
|---------|-------------|-------------|---------------|---------------|-----------|
| `speed` | 400 | 5 | Disabled | — | 0.55 |
| `balanced` | 800 | 10 | Enabled | 900ms | 0.45 |
| `deep` | 1200 | 15 | Enabled | 2000ms | 0.35 |

Default: `balanced`.

## When to use each

**`speed`** — constrained environments, high-frequency prompts, or when GPU is unavailable. BM25-only retrieval with tight token budget. Useful for OpenClaw's `before_prompt_build` hook where latency matters.

**`balanced`** — recommended default. Hybrid search with 900ms vector timeout. Good tradeoff between recall quality and latency.

**`deep`** — for sessions focused on research, architecture review, or deep debugging. Wider recall window, longer vector timeout, lower score threshold means more results surface.

## What profiles affect

The `context-surfacing` hook reads the active profile to configure:

1. **Token budget** — how many tokens of context to inject
2. **Max results** — how many search results to consider
3. **Vector search** — whether to use vector search at all (speed disables it)
4. **Vector timeout** — how long to wait for the vector search backend
5. **Min score** — composite score threshold below which results are dropped

## Configuration

```bash
# In shell
export CLAWMEM_PROFILE=deep

# In systemd service
Environment=CLAWMEM_PROFILE=speed

# In bin/clawmem wrapper (already sets defaults)
export CLAWMEM_PROFILE="${CLAWMEM_PROFILE:-balanced}"
```

Profiles do not affect MCP tool behavior — only the automatic hook-based retrieval.
