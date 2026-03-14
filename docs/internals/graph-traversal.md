# Graph Traversal

ClawMem maintains a multi-graph of relationships between documents in the `memory_relations` table. These edges power `intent_search` graph expansion and `find_causal_links` chain tracing.

## Edge types

| Type | Meaning | Direction |
|------|---------|-----------|
| `semantic` | Topically related (cosine similarity or LLM-assessed) | Bidirectional |
| `supporting` | One document supports/reinforces another | Directional |
| `contradicts` | One document contradicts another | Directional |
| `causal` | One event/decision caused or led to another | Directional |
| `temporal` | Creation-order adjacency | Directional |

## How edges are created

| Source | Edge types | Trigger |
|--------|-----------|---------|
| **A-MEM `generateMemoryLinks()`** | semantic, supporting, contradicts | Indexing (new docs only). LLM-assessed confidence + reasoning. Requires embeddings for neighbor discovery. |
| **A-MEM `inferCausalLinks()`** | causal | Post-response (`decision-extractor`). Links between `_clawmem/agent/observations/` docs. |
| **Beads `syncBeadsIssues()`** | causal, supporting, semantic | `beads_sync` MCP tool or watcher. Maps dependency types: `blocks→causal`, `discovered-from→supporting`, `relates-to→semantic`. |
| **`buildTemporalBackbone()`** | temporal | `build_graphs` MCP tool (manual). Creation-order edges between all active docs. |
| **`buildSemanticGraph()`** | semantic | `build_graphs` MCP tool (manual). Pure cosine similarity between embeddings. |

### Edge collision

Both `generateMemoryLinks()` and `buildSemanticGraph()` insert `semantic` edges. The primary key is `(source_id, target_id, relation_type)` — first writer wins (`INSERT OR IGNORE`). A-MEM edges take precedence if they exist.

## Adaptive traversal

`adaptiveTraversal()` performs multi-hop beam search:

1. Start from anchor nodes (top search results)
2. At each hop, expand outbound edges (all types) and inbound edges (semantic + entity only)
3. Score candidates by:
   - Edge weight (confidence)
   - Cosine similarity to the query embedding
   - Decay by depth
4. Beam selection: keep top `beamWidth` candidates per hop
5. Budget cap: stop after visiting `budget` total nodes

### Traversal asymmetry

| Direction | Edge types traversed |
|-----------|---------------------|
| Outbound (source→target) | All: semantic, supporting, contradicts, causal, temporal |
| Inbound (target→source) | Only: semantic, entity |

This is intentional — temporal and causal edges are directional by nature.

## When to run build_graphs

- After **bulk ingestion** (many new docs at once) — adds temporal backbone and fills semantic gaps
- When `intent_search` returns **weak or incomplete results** and you suspect graph sparsity
- Do NOT run after every reindex — A-MEM creates per-doc links automatically for new docs

## When to run find_causal_links

Use after `intent_search` to walk the full causal chain from a specific document:

```
# 1. Find the anchor
intent_search("why did we switch to PostgreSQL")
# → top result: decisions/2026-02-15-db-migration.md (#a1b2c3)

# 2. Trace the chain
find_causal_links(docid="#a1b2c3", direction="both", depth=5)
# → shows what caused this decision and what it caused
```
