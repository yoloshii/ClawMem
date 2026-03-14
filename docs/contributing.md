# Contributing

## Development setup

```bash
git clone https://github.com/yoloshii/clawmem.git
cd clawmem
bun install
```

## Running tests

```bash
bun test              # All tests (171)
bun test test/unit    # Unit tests only
```

Tests use in-memory SQLite databases and don't require GPU services.

## Type checking

```bash
npx tsc --noEmit
```

Must pass with zero errors on source files.

## Project structure

```
src/
  clawmem.ts         CLI entry point
  mcp.ts             MCP server (24+ tools)
  server.ts          REST API server
  store.ts           SQLite store (documents, vectors, relations)
  llm.ts             LLM abstraction (embedding, generation, reranking)
  config.ts          Vault configuration, profiles, lifecycle policy
  memory.ts          Composite scoring (SAME)
  search-utils.ts    RRF, enrichment, ranking utilities
  mmr.ts             Maximal Marginal Relevance diversity filter
  intent.ts          Intent classification (MAGMA)
  graph-traversal.ts Adaptive multi-hop traversal
  indexer.ts         Collection scanner, document indexer
  collections.ts     Collection configuration loader
  validation.ts      Input validation helpers
  limits.ts          Constants (max path length, query length)
  errors.ts          Error types
  promptguard.ts     Prompt injection sanitization
  retrieval-gate.ts  Adaptive retrieval filtering
  hooks.ts           Hook utilities (output format, dedup, logging)
  hooks/
    context-surfacing.ts   UserPromptSubmit hook
    decision-extractor.ts  Stop hook (observations)
    handoff-generator.ts   Stop hook (session summary)
    feedback-loop.ts       Stop hook (reference tracking)
    precompact-extract.ts  PreCompact hook
    session-bootstrap.ts   SessionStart hook (optional)
    staleness-check.ts     SessionStart hook (optional)
    curator-nudge.ts       SessionStart hook
  openclaw/
    index.ts          OpenClaw plugin entry
    engine.ts         ContextEngine implementation
    shell.ts          Shell-out transport utilities
    tools.ts          REST API agent tools
    plugin.json       Plugin manifest
test/
  unit/               Unit tests
  integration/        Integration tests (when present)
docs/                 Documentation (this folder)
bin/
  clawmem             Wrapper script (sets env defaults)
```

## Pull request guidelines

1. **Describe what and why** — not just what changed, but why
2. **Include test coverage** — new features need tests, bug fixes should include a regression test
3. **Type check clean** — `npx tsc --noEmit` must pass
4. **All tests pass** — `bun test` must pass
5. **Keep changes focused** — one feature or fix per PR

## What gets indexed

Only `.md` files. Never add indexing for binary files, source code, or credentials.

## Security considerations

- Never index or expose credential files (`.env`, `*secrets*`, `*credentials*`)
- `vault_sync` validates paths against a deny-list — don't weaken it
- Prompt injection sanitization (`promptguard.ts`) strips control sequences from injected context
- Bearer token auth on REST API when `CLAWMEM_API_TOKEN` is set

## License

MIT. See [LICENSE](../LICENSE).
