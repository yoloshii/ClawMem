# Quickstart

Get ClawMem running with a searchable vault in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A GPU for local inference (default models need ~4GB VRAM; SOTA upgrade needs ~10GB). Or use [cloud embedding](guides/cloud-embedding.md)
- Claude Code, OpenClaw, or any MCP-compatible client

## Install

```bash
git clone https://github.com/yoloshii/clawmem.git ~/clawmem
cd ~/clawmem && bun install
ln -sf ~/clawmem/bin/clawmem ~/.bun/bin/clawmem
```

## Bootstrap a vault

The fastest path — one command to init, index, embed, set up hooks, and register MCP:

```bash
./bin/clawmem bootstrap ~/notes --name notes
```

This creates a vault at `~/.cache/clawmem/index.sqlite`, indexes all `.md` files under `~/notes`, embeds them for vector search, installs Claude Code hooks, and registers the MCP server.

## Or step by step

```bash
# 1. Initialize the vault
./bin/clawmem init

# 2. Add a collection (directory of markdown files)
./bin/clawmem collection add ~/notes --name notes

# 3. Index and embed
./bin/clawmem update --embed

# 4. Set up Claude Code hooks (automatic context injection)
./bin/clawmem setup hooks

# 5. Register the MCP server (agent-initiated tools)
./bin/clawmem setup mcp
```

## Start GPU services

ClawMem uses three llama-server instances for best performance. All three models also auto-download and run locally via `node-llama-cpp` if no server is running — using Metal on Apple Silicon, Vulkan where available, or CPU. In-process inference is slower than a dedicated server. If you're using GPU servers, run them via [systemd services](guides/systemd-services.md) to prevent silent fallback on server crash.

```bash
# Embedding (recommended for performance — falls back to in-process if no server)
llama-server -m embeddinggemma-300M-Q8_0.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 2048

# LLM — query expansion (falls back to in-process if unavailable)
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf \
  --port 8089 --host 0.0.0.0 -ngl 99 -c 4096

# Reranker (falls back to in-process if unavailable)
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 512
```

> **SOTA upgrade (12GB+ GPU):** Replace embedding with zembed-1-Q4_K_M (2560d, `-b 2048 -ub 2048`) and reranker with zerank-2-Q4_K_M (`-b 2048 -ub 2048`). See [GPU services](../README.md#gpu-services) for details.

See [GPU services guide](guides/systemd-services.md) for systemd setup and remote GPU configuration.

No GPU? See [cloud embedding](guides/cloud-embedding.md) for OpenAI, Voyage, Jina, or Cohere alternatives.

## Verify

```bash
./bin/clawmem doctor    # Full health check
./bin/clawmem status    # Quick index status
bun test                # Run test suite
```

## What happens next

Once set up, ClawMem works automatically:

1. **Every prompt** — the `context-surfacing` hook searches your vault and injects relevant context as `<vault-context>` XML
2. **Every response** — the `decision-extractor` and `handoff-generator` hooks capture decisions and session summaries
3. **On demand** — the agent can call MCP tools like `memory_retrieve`, `query`, or `intent_search` when hooks don't surface enough

No agent configuration needed. The hooks are invisible to the agent — it just sees richer context.

## Next steps

- [Architecture](concepts/architecture.md) — understand how vaults, collections, and scoring work
- [Setup Hooks](guides/setup-hooks.md) — customize which hooks are installed
- [OpenClaw Plugin](guides/openclaw-plugin.md) — use ClawMem as OpenClaw's context engine
- [Multi-Vault](guides/multi-vault-config.md) — separate memory domains for different projects
