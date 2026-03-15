# Introduction

ClawMem is an open-source, on-device context engine for AI agents. It gives agents persistent, searchable memory that survives across sessions, compactions, and runtime boundaries.

## What it does

- **Indexes** markdown documents into a local SQLite vault with full-text search (BM25) and vector embeddings
- **Retrieves** relevant context automatically via hooks or on-demand via MCP tools / REST API
- **Scores** results using composite scoring (relevance, recency, confidence, quality, co-activation)
- **Tracks** decisions, handoffs, and session history across conversations
- **Traverses** causal and semantic graphs to answer "why" and "what led to" questions

## Architecture

```
 Agent (Claude Code / OpenClaw / any MCP client)
   │
   ├── Hooks (automatic, ~90% of retrieval)
   │   ├── context-surfacing    → injects <vault-context> on every prompt
   │   ├── decision-extractor   → extracts observations after each response
   │   ├── handoff-generator    → summarizes sessions for continuity
   │   ├── feedback-loop        → reinforces referenced memories
   │   ├── precompact-extract   → preserves state before context compaction
   │   ├── curator-nudge        → surfaces maintenance suggestions
   │   └── postcompact-inject   → re-injects authoritative context after compaction
   │
   ├── MCP Tools (agent-initiated, ~10%)
   │   ├── memory_retrieve      → auto-routing entry point
   │   ├── query / search / vsearch / intent_search / query_plan
   │   ├── get / multi_get / find_similar / find_causal_links / timeline
   │   ├── memory_pin / memory_snooze / memory_forget
   │   └── lifecycle / vault / maintenance tools
   │
   └── REST API (optional, for non-MCP clients)
       ├── POST /retrieve       → mirrors memory_retrieve
       ├── POST /search         → direct mode selection
       └── GET/POST endpoints   → documents, lifecycle, graphs

   │
   ▼
 SQLite Vault (WAL mode)
   ├── documents + content (FTS5 index)
   ├── vectors (vec0 extension)
   ├── memory_relations (causal, semantic, temporal, supporting edges)
   ├── sessions + usage tracking
   └── hook_dedupe (heartbeat suppression)

   │
   ▼
 GPU Services (llama-server)
   ├── :8088 — Embedding (EmbeddingGemma-300M default, zembed-1 SOTA upgrade)
   ├── :8089 — LLM (qmd-query-expansion-1.7B)
   └── :8090 — Reranker (qwen3-reranker-0.6B default, zerank-2 SOTA upgrade)
```

## Key design principles

1. **Local-first** — all data stays on your machine in a single SQLite file. No cloud dependencies unless you opt into cloud embedding.
2. **Fail-open** — every hook and search path degrades gracefully. A failed GPU call returns BM25-only results, not an error.
3. **Dual-mode** — the same vault is shared between Claude Code hooks and OpenClaw's ContextEngine plugin. Both runtimes read and write the same memory.
4. **Progressive disclosure** — agents see compact results first (`compact=true`), then fetch full content only when needed. Minimizes context window usage.
5. **Zero-config default** — a single vault with `clawmem bootstrap` gets you running. Multi-vault, cloud embedding, and profiles are opt-in.

## Integrations

| Runtime | Integration | How | Services needed |
|---------|------------|-----|-----------------|
| Claude Code | Hooks + MCP stdio | `clawmem setup hooks` + `clawmem setup mcp` | watcher + embed timer |
| OpenClaw | ContextEngine plugin + REST API | `clawmem setup openclaw` | watcher + embed timer + `clawmem serve` |
| Any MCP client | MCP stdio | Add to MCP config | watcher + embed timer |
| Web / scripts | REST API | `clawmem serve` | watcher + embed timer + `clawmem serve` |

All integrations share the same SQLite vault. The [watcher](guides/systemd-services.md#watcher-service) keeps the index fresh, the [embed timer](guides/systemd-services.md#embed-timer) maintains vector embeddings, and the [REST API](reference/rest-api.md) serves OpenClaw agent tools. GPU servers are optional — `node-llama-cpp` provides in-process fallback (Metal on Apple Silicon, Vulkan where available, CPU as last resort). Fast with GPU acceleration; significantly slower on CPU-only. The [curator agent](../agents/clawmem-curator.md) handles periodic maintenance on demand.

## Next steps

- [Quickstart](quickstart.md) — install and bootstrap in 5 minutes
- [Concepts](concepts/architecture.md) — understand vaults, collections, and scoring
- [MCP Tools Reference](reference/mcp-tools.md) — all 24+ tools with examples
