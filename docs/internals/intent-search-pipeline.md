# Intent Search Pipeline

The `intent_search` tool classifies query intent and uses graph traversal to find causal chains that keyword/vector search can't reach.

## Pipeline stages

```
User Query
  │
  ▼
Intent Classification (LLM)
  │ → WHY, WHEN, ENTITY, or WHAT
  │ (or force_intent override)
  │
  ▼
Baseline Search
  │ BM25 + Vector in parallel
  │
  ▼
Intent-Weighted RRF
  │ WHY  → boost vector [1.0, 1.5]
  │ WHEN → boost BM25   [1.5, 1.0]
  │ Other → balanced     [1.0, 1.0]
  │
  ▼
Graph Traversal (WHY/ENTITY only)
  │ Multi-hop beam search over memory_relations
  │ Outbound: all edge types
  │ Inbound: semantic + entity only
  │ Budget: 30 nodes, depth: 2, beam: 5
  │ Scores normalized to [0,1]
  │
  ▼
Cross-Encoder Reranking
  │ 200 chars/doc context
  │ File-keyed score join
  │
  ▼
Position-Aware Blending
  │ Same α curve as query pipeline
  │
  ▼
Composite Scoring
  │
  ▼
Results (with intent + confidence metadata)
```

## Intent types

| Intent | Signal | Graph traversal | RRF weighting |
|--------|--------|----------------|---------------|
| WHY | "why did", "what caused", "reason for", "decided to" | Yes | Boost vector |
| WHEN | "when did", "first/last occurrence", timeline | No | Boost BM25 |
| ENTITY | Named component/person/service needing cross-doc linkage | Yes | Balanced |
| WHAT | General factual | No | Balanced |

## Graph traversal

When intent is WHY or ENTITY, the pipeline runs `adaptiveTraversal()`:

1. Anchors on top 10 search results
2. Traverses `memory_relations` edges:
   - **Outbound** (source→target): semantic, supporting, contradicts, causal, temporal
   - **Inbound** (target→source): semantic and entity only
3. Beam search with query embedding as relevance signal
4. Discovered nodes are hydrated from the database and merged with search results
5. Scores are normalized to [0, 1] before merging

## Graph edge sources

| Source | Edge types | How populated |
|--------|-----------|--------------|
| A-MEM `generateMemoryLinks()` | semantic, supporting, contradicts | During indexing (new docs) |
| A-MEM `inferCausalLinks()` | causal | Post-response (decision-extractor) |
| Beads `syncBeadsIssues()` | causal, supporting, semantic | `beads_sync` or watcher |
| `buildTemporalBackbone()` | temporal | `build_graphs` (manual) |
| `buildSemanticGraph()` | semantic | `build_graphs` (manual) |

## Differences from query

| Aspect | `query` | `intent_search` |
|--------|---------|-----------------|
| Query expansion | Yes | No |
| Intent hint | Manual (`intent` param) | Auto-detected |
| Rerank context | 4000 chars/doc | 200 chars/doc |
| Graph traversal | No | Yes (WHY/ENTITY) |
| MMR diversity | Yes | No |
| `compact` param | Yes | No |
| `collection` filter | Yes | No |
| Best for | General recall | Causal chains spanning docs |

## When to use

Use `intent_search` **directly** (not as a fallback from query) when:
- The question starts with "why"
- You need to trace decision chains
- You're asking about entity relationships across documents
- You need temporal context ("when did this change")

For WHEN queries, start with `enable_graph_traversal=false` (BM25-biased). Fall back to `query()` if recall drifts.
