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
Parallel Search (typed routing)
  │ BM25(original) + Vector(original)   ← original fans out to both
  │ + BM25(lex expansions)              ← lex → BM25 only
  │ + Vector(vec/hyde expansions)       ← vec/hyde → vector only
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
Rerank / RRF Blend (blendRerank)
  │ 0.9 · reranker + 0.1 · normalized-RRF tiebreaker
  │ Reranker is the dominant signal; can promote a doc over RRF #1
  │ Falls back to pure RRF order if the reranker is unavailable / all-zero
  │
  ▼
Composite Scoring
  │ (relevance * 0.70 + recency * 0.15 + confidence * 0.15)   ← query-tuned weights (v0.13.0)
  │ recency-intent queries instead use 0.10 / 0.70 / 0.20
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

The LLM generates lex (keyword), vec (semantic), and hyde (hypothetical answer) variants of the query, each carried as a typed `ExpandedQuery`. Variants are **routed by type**: `lex` expansions are searched on BM25 only, `vec` and `hyde` on vector only. The original query is the only leg that fans out to *both* backends. All legs are searched in parallel and fused; the original query's two lists receive 2x weight in RRF, ensuring it anchors the ranking.

Routing by type matters because a keyword expansion ("auth token refresh") is useless to a dense vector model, and a hypothetical-answer passage (hyde) is mostly stopword noise to BM25. Searching every variant on both backends — the earlier behavior — fed each leg the input it handles worst, diluting RRF with low-quality lists.

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
