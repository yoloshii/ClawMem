# Setup MCP

Register ClawMem as an MCP (Model Context Protocol) server so agents can call memory tools directly.

## Install

```bash
./bin/clawmem setup mcp
```

This adds ClawMem to your MCP client's configuration as a stdio server. For Claude Code, it writes to `~/.claude.json`.

## Manual configuration

Add to your MCP client config:

```json
{
  "mcpServers": {
    "clawmem": {
      "command": "/path/to/clawmem/bin/clawmem",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

## What it exposes

The MCP server registers 24+ tools:

**Retrieval** — `memory_retrieve`, `query`, `search`, `vsearch`, `intent_search`, `query_plan`

**Documents** — `get`, `multi_get`, `find_similar`, `find_causal_links`, `timeline`, `memory_evolution_status`, `session_log`

**Mutations** — `memory_pin`, `memory_snooze`, `memory_forget`

**Lifecycle** — `lifecycle_status`, `lifecycle_sweep`, `lifecycle_restore`

**Maintenance** — `status`, `reindex`, `index_stats`, `build_graphs`, `profile`, `beads_sync`

**Vault** — `list_vaults`, `vault_sync`

**Workflow** — `__IMPORTANT` (read-first instructions for agents)

See [MCP Tools Reference](../reference/mcp-tools.md) for full documentation.

## Verify

After setup, the agent should see ClawMem tools in its available tools list. Test with:

```
memory_retrieve("test query")
```

Or check status:

```
status()
```

## Environment variables

The `bin/clawmem` wrapper sets all GPU endpoint defaults. If running the MCP server directly (without the wrapper), set:

```bash
CLAWMEM_EMBED_URL=http://localhost:8088
CLAWMEM_LLM_URL=http://localhost:8089
CLAWMEM_RERANK_URL=http://localhost:8090
```
