# Graph traversal in ClawMem

ClawMem maintains a multi-graph of relationships between documents in the `memory_relations` table. These edges let agents trace chains of reasoning across documents — answering questions like "why did we decide X", "what caused Y", and "what else supports Z" that keyword and vector search alone can't handle.

Most edges are created automatically during indexing (A-MEM link generation) and after each response (causal inference from decision-extractor). The `build_graphs` tool adds temporal backbone and bulk semantic edges for vaults with sparse A-MEM coverage. You don't need to manage the graph manually under normal use.

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

### SPO knowledge graph (entity_triples)

Separate from `memory_relations`, the `entity_triples` table stores structured Subject-Predicate-Object facts with temporal validity (`valid_from`/`valid_to`). Triples are emitted by the observer LLM as `<triples>` blocks alongside `<facts>`, parsed and validated by `parseObservationXml` against a tight canonical predicate vocabulary, then persisted by `decision-extractor` using canonical `vault:type:slug` entity IDs via `ensureEntityCanonical`.

**Eligible observation types** for triple extraction: decision, preference, milestone, problem, discovery, feature. Observation types `bugfix`, `change`, `refactor` are excluded as secondary safety net.

**Canonical predicate vocabulary** (parser rejects anything outside this set): `adopted`, `migrated_to`, `deployed_to`, `runs_on`, `replaced`, `depends_on`, `integrates_with`, `uses`, `prefers`, `avoids`, `caused_by`, `resolved_by`, `owned_by`. The `prefers` and `avoids` predicates store their object as a literal (not resolved to an entity).

**Entity type inheritance** is ambiguity-safe via `resolveEntityTypeExact`: if exactly one active entity in the vault shares the name, its type is inherited; zero matches or multiple matches (cross-bucket ambiguity) default to `concept`.

**Provenance**: each triple's `source_doc_id` points at the persisted observation document it was extracted from. Triples for observations whose doc insert failed are naturally skipped because the extractor iterates the `ObservationWithDoc` array.

Query via the `kg_query(entity)` MCP tool — accepts either an entity name (resolved via `searchEntities`) or a canonical ID in `vault:type:slug` form. This is not used by `adaptiveTraversal()` — it serves a different purpose (structured entity lookup vs document graph traversal).

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
