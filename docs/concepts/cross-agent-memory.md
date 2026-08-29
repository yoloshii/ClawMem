# Cross-Agent Memory (v0.38.0)

ClawMem becomes a **shared active memory** rather than a passive archive: an agent that
learns something writes a signed, witnessed fact into the knowledge graph, and every other
agent sharing the vault can read it — without rediscovering it.

This page covers the three MCP tools (`fact_write`, `fact_link`, `fact_query_cross_agent`)
and the optional context-injection layer. Tool reference: [mcp-tools.md](../reference/mcp-tools.md).

## Mental model

```
  Agent A learns X ──fact_write──▶ [ClawMem KG] ◀──fact_query_cross_agent── Agent B
                                          │                        ▲
                                          └────context injection────┘ (optional, default OFF)
```

Unlike document *indexing* (which captures what a doc *is*), a **fact** is a first-class
witnessed statement: *who* wrote it, *from which session*, *when*, *how* (source), *how
confident*, and *for how long* (`valid_from`/`valid_to` → natural decay and obsolescence).

## The three tools

### `fact_write`

Write a learned fact as a witnessed SPO triple.

```json
{
  "subject": "server:ema5-db",
  "predicate": "status",
  "object": "down",
  "subject_type": "server",
  "witness": {
    "agentId": "max",
    "sessionId": "abc-123",
    "timestamp": "2026-08-29T12:00:00Z",
    "source": "direct_observation"
  },
  "confidence": 0.95,
  "valid_to": null,
  "tags": ["infra", "ema5"]
}
```

Key semantics:

- The subject/object are **resolved-or-created** as canonical `vault:type:slug` entities
  (`ensureEntityCanonical`), so a misspelling of an existing entity stays typed correctly.
- `append` mode: a cross-agent write **always** inserts a fresh triple row. If another
  agent already wrote `status = up` for the same subject+predicate, your `down` does not
  clobber it — both survive as witnessed versions (divergence / disagreement / evolution).
- `confidence` (0..1) and `valid_to` support decay and obsolescence; expired facts
  (`valid_to` in the past) are filtered from `kg_query`'s `as_of` view and from injection.

### `fact_link`

Create a directed semantic relation between two entities — ideal for cross-domain
reference (`project → server`, `person → project`, `skill → agent`).

```json
{
  "from": "project:ema5",
  "relation": "uses_infrastructure",
  "to": "server:ema5-plc-db",
  "witness": { "agentId": "cleo", "timestamp": "2026-08-29T12:00:00Z" },
  "confidence": 0.9
}
```

### `fact_query_cross_agent`

Query witnessed facts across agents.

```json
{
  "subject": "server:ema5-db",
  "predicate": "*",
  "since": "2026-08-28T00:00:00Z",
  "min_confidence": 0.7,
  "written_by": ["max", "scout"]
}
```

- `subject` / `predicate` / `object` each accept `*` (or are optional) for discovery.
- `written_by` / `session_ids` restrict by writer; `since` bounds write time.
- `resolve_conflicts: true` merges arcs that differ only by witness, keeping the most
  recent current fact **at or above** `min_confidence` per (subject, predicate, object) —
  divergence collapse, not deletion.

Every result is a `CrossAgentFact` with `id`, `subject`, `predicate`, `object`,
`confidence`, `validFrom/validTo`, `current`, `writtenAt`, `agentId`, `sessionId`,
`sourceType`, and `tags`.

## Context-injection layer (optional, default OFF)

This is an **orchestration behaviour**, not a tool. When enabled, a task-spawning agent
can be fed facts written by *other* agents about the entities in its task prompt.

Enable:

```yaml
# config.yaml
retrieval:
  cross_agent_inject: true        # or CLAWMEM_CROSS_AGENT_INJECT=true
  cross_agent_confidence: 0.7     # floor; or CLAWMEM_CROSS_AGENT_CONFIDENCE=0.7
```

Behaviour and guarantees:

- **Prompt-only detection** — candidate entities come from the task prompt (reusing the
  vault-facts detector: canonical ids, proper nouns, n-gram scan). Never from ranked docs.
- **Others' facts only** — the receiving agent's own facts can be excluded
  (`excludeAgentId`); the default surfaces whichever facts meet the confidence floor.
- **Labelled & separate** — injected as `<cross-agent-facts>` with each line marked
  `[cross-agent fact, written by <agent> at <timestamp>]`. The receiver may ignore or use
  them; they are never binding.
- **Bounded & fail-open** — a 2s budget and never-throws degradation mean injection can
  never block task startup. A profile must grant a `crossAgentTokens` sub-budget for the
  stage to run, and that budget is separate — injection can't steal tokens from the
  established `<facts>` / `<vault-facts>` blocks.

## Storage

`entity_triples` gains idempotent witness columns (`agent_id`, `session_id`,
`source_type`, `written_at`, `tags`) plus indexes. Existing triples are untouched; adding
the columns is a no-op on re-open. Legacy `Store.addTriple` keeps its dedup-on-current
behaviour unless `append: true` is passed.

## Scope / non-goals (future)

- Automatic cross-agent conflict resolution (today: multiple witnessed versions + query-time
  `resolve_conflicts`).
- UI for the cross-agent graph.
- Webhooks on KG events ("someone wrote a fact about X — notify Y").
- PostgreSQL `cleo_ops` integration stays separate.
