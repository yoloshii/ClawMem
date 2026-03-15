# Query pipeline

The `query` MCP tool runs the full hybrid retrieval pipeline, combining BM25, vector search, query expansion, and cross-encoder reranking in a single call.

## Pipeline stages

```
User Query + optional intent hint
  │
  ▼
BM25 Probe
  │ Top hit score >= 0.85 with gap >= 0.15?
  │ (disabled when intent is provided)
  ├── YES → Skip expansion, use BM25 results directly
  │
  ▼
Query Expansion (LLM)
  │ Generates text variants (lex/vec/hyde)
  │ Intent steers the expansion prompt
  │
  ▼
Parallel Search
  │ BM25(original) + Vector(original)
  │ + BM25(each expanded) + Vector(each expanded)
  │
  ▼
Reciprocal Rank Fusion (k=60)
  │ Original query lists get 2x positional weight
  │ Expanded query lists get 1x weight
  │ Top candidateLimit results (default 30)
  │
  ▼
Intent-Aware Chunk Selection
  │ Intent terms at 0.5x weight
  │ Query terms at 1.0x weight
  │
  ▼
Cross-Encoder Reranking
  │ 4000 char context per doc
  │ Intent prepended to rerank query
  │ Chunk dedup (identical texts share single call)
  │ Batch cap = 4
  │
  ▼
Position-Aware Blending
  │ α = 0.75 (top 3), 0.60 (mid), 0.40 (tail)
  │ Blends original + reranked scores
  │
  ▼
Composite Scoring
  │ (relevance * 0.50 + recency * 0.25 + confidence * 0.25)
  │ × quality multiplier × co-activation boost
  │
  ▼
MMR Diversity Filter
  │ Jaccard bigram similarity > 0.6 → demoted
  │
  ▼
Results
```

## Key parameters

| Parameter | Effect | Default |
|-----------|--------|---------|
| `intent` | Steers 5 stages: expansion, reranking, chunk selection, snippet extraction, bypass | — |
| `candidateLimit` | How many candidates reach reranking | 30 |
| `compact` | Snippet vs full content output | true |
| `collection` | Filter by collection (comma-separated) | all |

## BM25 strong-signal bypass

When the top BM25 hit scores >= 0.85 and the gap to the second hit is >= 0.15, the pipeline skips query expansion entirely. This is a fast path for queries with obvious keyword matches.

The bypass is disabled when `intent` is provided — intent implies the query is ambiguous, so keyword confidence alone is insufficient.

## Query expansion

The LLM generates lex (keyword), vec (semantic), and hyde (hypothetical answer) variants of the query. These are searched in parallel alongside the original query. The original query's results receive 2x weight in RRF fusion, ensuring it anchors the ranking.

## Chunk selection

For reranking, each document's content is windowed into overlapping chunks. Chunks are scored by overlap with query terms (1.0x weight) and intent terms (0.5x weight). The best chunk per document is sent to the cross-encoder.

## When to use query vs alternatives

| Tool | Cost | When |
|------|------|------|
| `search` | 0 GPU calls | Known exact terms, spot-check |
| `vsearch` | 1 GPU call | Conceptual, don't know vocabulary |
| `query` | 3+ GPU calls | General recall, unsure which signal matters |
| `intent_search` | Hybrid + graph | Why/entity chains, temporal queries |
| `query_plan` | Hybrid + decomposition | Multi-topic queries |
