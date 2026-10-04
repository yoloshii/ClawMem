# Contributing to ClawMem

Development guide for the ClawMem memory engine (TypeScript on Bun, SQLite vector search, Claude Code hooks, MCP server).

## Development setup

```bash
git clone https://github.com/yoloshii/clawmem.git
cd clawmem
bun install
```

## Running tests

```bash
bun test              # All tests
bun test tests/unit   # Unit tests only
```

Tests use in-memory SQLite databases and don't require GPU services. They never read your own ClawMem configuration or open your vaults: `tests/preload.ts` (loaded through `bunfig.toml`) points `CLAWMEM_CONFIG_DIR` at an empty scratch directory before any test loads (and back at it whenever a test leaves it unset), and clears `CLAWMEM_VAULTS` and `INDEX_PATH`. Run `bun test` from the repository root: Bun reads `bunfig.toml` only from the directory it runs in. Give a test that needs a configuration, a named vault or an index path its own scratch copy.

## Type checking

```bash
npx tsc --noEmit
```

Must pass with zero errors on source files.

## Time and deadlines (v0.38.0)

Only `src/clock.ts` reads a platform clock — `Date.now()`, an argless `new Date()`, `performance.now()`, `process.hrtime()`, `Bun.nanoseconds()` and their kin are refused everywhere else. Use its exports instead:

- **Deadlines and durations** are branded values (`MonoDeadline`, `DurationMs`). Take an instant with `monoNow()`, build a deadline with `deadlineAfter(start, duration(ms))`, test it with `isExpired()`, and arm timers and signals with `deadlineTimer`, `raceDeadline`, `sleep`, `timeoutSignal` or `signalAfter`. A monotonic deadline never moves when the wall clock steps.
- **Wall time** — ages, cooldowns, leases, identifiers, timestamps — comes from `epochNow()`, `isoNow()` and `toDate()`; use `epochMs(epochNow())` where existing logic needs a plain epoch number.
- **Numbers leave the brand** only through named exits: `evidenceMs` (timing evidence and logs), `epochMs` (wall-clock numbers), `wireBudget` (the vector daemon's relative budget).

Two static audits enforce this. `bun test` runs both against the repository, and each also runs standalone:

```bash
bun scripts/o1-clock-audit.ts   # raw clock reads outside src/clock.ts
bun scripts/o1-seam-audit.ts    # arithmetic, comparison or erasure on branded time values
```

Their ratchets (`o1-clock-debt.json`, `o1-seam-debt.json`) hold zero entries and only tighten, so a new raw clock read or brand erasure fails the suite. Route the code through `src/clock.ts` instead of adding a debt entry. A test that needs a wall-clock step uses the module's seam (`setWallJumpForTest`, or `CLAWMEM_TEST_WALL_JUMP` in a child process), never a patched `Date`.

## Project structure

```
src/
  clawmem.ts         CLI entry point
  mcp.ts             MCP server
  server.ts          REST API server
  server-guard.ts    REST transport guard (Origin/Host checks, CORS, the token)
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
  normalize.ts       Conversation format normalizer (Claude, ChatGPT, Slack, plain text)
  recall-buffer.ts   Recall event writing (direct SQLite write during context-surfacing)
  recall-attribution.ts  The reference test (`verifiedReferences`: path, file name, displayed title)
  relation-weight.ts Relation weights clamped to [0, 1] on write and read
  stop-*.ts          The Stop pipeline (v0.41.0): schema + fence, cursor, pairing, identity, extraction, judge, causal
                     markers, session docs, handoff, feedback, worker, repair, recovery, health
  limits.ts          Constants (max path length, query length)
  errors.ts          Error types
  promptguard.ts     Prompt injection sanitization
  retrieval-gate.ts  Adaptive retrieval filtering
  clock.ts           The ONLY module that reads a clock (monotonic deadlines, wall time, timers)
  vector-daemon.ts   Vector query daemon (hosted by `clawmem watch`) and its hook-side client
  vector-protocol.ts Daemon wire constants (hydrated-v1, deadline-rel-v1, caps)
  hooks.ts           Hook utilities (output format, dedup, logging)
  hooks/
    context-surfacing.ts   UserPromptSubmit hook
    decision-extractor.ts  Stop hook (observations)
    handoff-generator.ts   Stop + SessionEnd hook (turn digests, session summary)
    feedback-loop.ts       Stop hook (verified references)
    precompact-extract.ts  PreCompact hook
    session-bootstrap.ts   SessionStart hook (optional)
    staleness-check.ts     SessionStart hook (optional)
    curator-nudge.ts       SessionStart hook
    surfacing-fusion.ts    context-surfacing lane fusion (ordering key, membership)
    surfacing-bookkeeping.ts  Off-process surfacing bookkeeping (spool)
  eval/               Hook replay-eval harness (`clawmem eval hook-run` / `hook-aggregate`)
  openclaw/
    index.ts          Plugin entry point (registers as kind=memory, wires hook handlers)
    engine.ts         Retrieval/extraction engine (invoked from hook handlers in index.ts)
    shell.ts          Shell-out transport utilities
    tools.ts          REST API agent tools
    openclaw.plugin.json  Legacy plugin manifest (still shipped; parsed at runtime)
    package.json      OpenClaw v2026.4.11+ discovery manifest (openclaw.extensions)
tests/
  unit/               Unit tests
  integration/        Integration tests (when present)
  preload.ts          Loaded before every test (bunfig.toml): a scratch config, no inherited vault or index path
docs/                 Documentation (this folder)
scripts/              Tooling, including the O1 clock and seam audits
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
- `clawmem serve` requires a bearer token on every request (`CLAWMEM_API_TOKEN`, else the generated token file) and refuses foreign `Origin`/`Host` headers and non-JSON POSTs (`src/server-guard.ts`). The token stops web pages, not processes running as the same user

## License

MIT. See [LICENSE](../LICENSE).
