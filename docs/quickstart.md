# Quickstart

Get ClawMem running with a searchable vault in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A GPU with ~4.5GB VRAM for local inference (or use [cloud embedding](guides/cloud-embedding.md))
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

ClawMem uses three llama-server instances. Download the models and start them:

```bash
# Embedding (required — no in-process fallback)
llama-server -m embeddinggemma-300M-Q8_0.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 2048

# LLM — query expansion (falls back to CPU if unavailable)
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf \
  --port 8089 --host 0.0.0.0 -ngl 99 -c 4096

# Reranker (falls back to CPU if unavailable)
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf \
  --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 --reranking
```

See [GPU services guide](guides/systemd-services.md) for systemd setup and remote GPU configuration.

No GPU? See [cloud embedding](guides/cloud-embedding.md) for OpenAI, Voyage, Jina, or Cohere alternatives.

## Verify

```bash
./bin/clawmem doctor    # Full health check
./bin/clawmem status    # Quick index status
bun test                # Run test suite (171 tests)
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
