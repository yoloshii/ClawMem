# Claude Code hooks vs MCP tools

ClawMem delivers AI agent memory through two tiers: Claude Code hooks handle about 90% of context delivery automatically, while MCP server tools cover the remaining 10% when the agent needs to escalate.

## Tier 2 — Hooks (automatic)

Hooks fire on Claude Code lifecycle events with zero agent effort:

| Hook | Trigger | Budget | What it does |
|------|---------|--------|-------------|
| `context-surfacing` | UserPromptSubmit | profile-driven (default 800 tokens) | Searches vault for context relevant to the user's prompt. Injects results as `<vault-context>` XML. |
| `postcompact-inject` | SessionStart (after compact) | 1200 tokens | Re-injects authoritative state after context window compaction. |
| `curator-nudge` | SessionStart | 200 tokens | Surfaces maintenance suggestions from the curator report. |
| `precompact-extract` | PreCompact | — | Extracts decisions, file paths, and open questions before compaction. Writes `precompact-state.md`. |
| `decision-extractor` | Stop | — | LLM extracts observations from the conversation. Infers causal links. Detects contradictions with prior decisions. |
| `handoff-generator` | Stop | — | LLM summarizes the session for cross-session continuity. |
| `feedback-loop` | Stop | — | Tracks which notes were referenced. Boosts their confidence. |

### How context-surfacing works

1. Validate prompt (skip slash commands, greetings, heartbeats, duplicates)
2. Load performance profile (`speed` / `balanced` / `deep`) for budget and thresholds
3. Search: vector (if profile enables it, with profile-driven timeout) + BM25 supplement
4. Filter: exclude private paths, snoozed documents, noise
5. Score: composite scoring (relevance + recency + confidence + quality)
6. Build context within token budget
7. Inject as `<vault-context>` XML in the prompt

### Tuning context-surfacing with profiles

Set `CLAWMEM_PROFILE` to adjust the context-surfacing hook's resource budget:

| Profile | Token budget | Max results | Vector | Timeout | Min score |
|---------|-------------|-------------|--------|---------|-----------|
| `speed` | 400 | 5 | Off | — | 0.55 |
| `balanced` (default) | 800 | 10 | On | 900ms | 0.45 |
| `deep` | 1200 | 15 | On | 2000ms | 0.35 |

Profiles only affect the automatic context-surfacing hook. MCP tools are not affected — agents control their own `limit`, `compact`, and tool selection per call.

### Hook blind spots

Hooks filter aggressively — they enforce score thresholds, cap token budgets, and exclude system artifacts. If a memory exists but wasn't surfaced in `<vault-context>`, it doesn't mean it's missing from the vault. It means it didn't make the top-k cut for this prompt.

## Tier 3 — MCP Tools (agent-initiated)

The agent should escalate to MCP tools only when one of three rules fires:

1. **Low-specificity** — `<vault-context>` is empty or missing the specific fact needed
2. **Cross-session** — the task references prior sessions or decisions ("why did we decide X")
3. **Pre-irreversible** — about to make a destructive or hard-to-reverse change

### Preferred entry point

Use `memory_retrieve(query)` — it auto-classifies the query and routes to the optimal backend:

- "why did we decide X" → intent_search (causal graph traversal)
- "what happened last session" → session_log
- "what else relates to X" → find_similar (vector neighbors)
- complex multi-topic → query_plan (parallel decomposition)
- general recall → query (full hybrid pipeline)

### Direct routing (when you know which tool to use)

| Query type | Tool | Why not query()? |
|-----------|------|-----------------|
| Why / what caused / decision | `intent_search` | Graph traversal finds causal chains query() can't |
| Last session / yesterday | `session_log` | Session-specific data not in search index |
| What else relates to X | `find_similar` | k-NN vector neighbors, not keyword overlap |
| Complex multi-topic | `query_plan` | Decomposes into typed parallel retrieval |
| General recall | `query` | Full hybrid: BM25 + vector + expansion + reranking |
| Keyword spot check | `search` | BM25 only, zero GPU cost |
| Conceptual / fuzzy | `vsearch` | Vector only, semantic similarity |

### Anti-patterns

- Do NOT call MCP tools every turn — the three rules above are the only gates
- Do NOT re-search what's already in `<vault-context>`
- Do NOT use `query()` for "why" questions — use `intent_search` or `memory_retrieve`
- Do NOT use `query()` for session history — use `session_log`
