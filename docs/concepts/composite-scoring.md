# Composite Scoring

Composite scoring blends multiple signals beyond raw search relevance. **It applies to the hook pipeline (context surfacing), the `query` hybrid pipeline, `search`, and `memory_retrieve`'s keyword/hybrid/causal/complex modes.** Since v0.22.0 the direct vector routes — MCP `vsearch` and `memory_retrieve` semantic/discovery — do NOT use it for non-recency queries: they rank by raw vector cosine, with metadata (including pin) breaking exact score ties only, and report `scoreBasis: "vector-cosine"`. That split is measured, not aesthetic: on a judged set against the live vault, raw cosine ranked 16/19 targets #1 (MRR 0.912) while this composite ranked 1/19 (MRR 0.307) and pushed 14/19 correct answers below the old minScore floor — in the compressed-high similarity band of modern embedding models, every multiplier below is larger than the raw margins separating right answers from wrong ones. Recency-intent queries keep composite (the Recency column) on every route that had it.

## Formula

```
compositeScore = (w_search * searchScore + w_recency * recencyScore + w_confidence * confidenceScore)
                 * qualityMultiplier * coActivationBoost
```

### Weights

| Signal | Normal (default) | `query` tool | Recency intent |
|--------|------------------|--------------|----------------|
| searchScore | 0.50 | 0.70 | 0.10 |
| recencyScore | 0.25 | 0.15 | 0.70 |
| confidenceScore | 0.25 | 0.15 | 0.20 |

Recency intent is detected automatically when queries contain "latest", "recent", "last session", etc. — and **takes precedence over the `query`-tool weights**: a recency-phrased `query` call still uses the Recency-intent column.

The **`query` tool** uses retrieval-tuned weights (search 0.70) derived from a held-out judged-relevance eval (v0.13.0) — more weight on topical relevance measurably improves graded NDCG@10 without demoting the newest-correct version of evolving docs. `search`, the composite `memory_retrieve` modes, and the context-surfacing hook **keep the Normal column**. The v0.21.0 `retrieval.mcp_direct_tuned_weights` knob is **superseded as of v0.22.0 and has no effect** — the direct-pipeline eval it was gated on measured tuned weights at 1/19 hit@1, and the direct vector routes moved to raw ordering instead. The key is still parsed (a once-per-process warning is logged if set) so existing configs don't break.

Threshold note: EOS-anchored last-token embedding models (e.g. zembed-1 served correctly) produce a **compressed-high similarity band** — unrelated pairs sit near ~0.4 rather than ~0.2. Relative ordering is what matters; treat absolute `minScore` cutoffs as model-dependent rather than universal.

`searchScore` provenance (v0.23.0): on FTS/BM25 surfaces the input is the monotonic transform `|bm25|/(1+|bm25|)` of FTS5's negative-is-better `bm25()` (through v0.22.0 a clamp bug flattened it to a constant 1.0, which made composite ranking on those surfaces metadata-only); on vector surfaces it is the raw cosine. The two are independent monotonic signals on an uncalibrated common range — composite blends them where pools mix (hooks, REST hybrid), which removes the old unconditional FTS-over-vector dominance but does not make the channels numerically comparable.

## Signal breakdown

### Search score (0.0 - 1.0)

Raw relevance from the search backend — BM25, vector cosine similarity, or RRF-fused hybrid score.

### Recency score (0.0 - 1.0)

Exponential decay based on document age and content type half-life:

| Content type | Half-life | Behavior |
|-------------|-----------|----------|
| decision, deductive, preference, hub | Infinite | Never decay |
| antipattern | Infinite | Never decay |
| project | 120 days | Slow decay |
| research | 90 days | Moderate decay |
| problem, milestone, note | 60 days | Default |
| conversation, progress | 45 days | Faster decay |
| handoff | 30 days | Fast decay — recent matters most |

Half-lives extend up to 3x for frequently-accessed memories (access reinforcement decays over 90 days).

### Confidence score (0.0 - 1.0)

Starts at 0.5 for new documents. Adjusted by:

- **Contradiction detection** — when `decision-extractor` finds a new decision contradicting an old one, the old decision's confidence is lowered. The consolidation worker applies an additional merge-time contradiction gate (v0.7.1): before merging a new pattern into an existing consolidated observation, it checks for contradictions via a deterministic heuristic plus an LLM confirmation. Contradictory merges are blocked and either linked via a `contradicts` edge (default) or supersede the old row with `status='inactive'` (see [consolidation safety](architecture.md#consolidation-safety-v071)).
- **Feedback loop** — referenced notes get confidence boosts
- **Attention decay** — non-durable types (handoff, progress, conversation, note, project) lose 5% confidence per week without access. Decision, deductive, preference, hub, research, and antipattern types are exempt.

### Quality multiplier (0.7 - 1.3)

```
qualityMultiplier = 0.7 + 0.6 * qualityScore
```

Quality score (0.0 - 1.0) is computed during indexing based on:
- Document length
- Structural elements (headings, lists)
- Decision keywords
- Correction keywords
- Frontmatter richness

A document with headings, structured lists, decision-related terms ("decided", "chose", "tradeoff"), and YAML frontmatter will score near the top of the range. A single paragraph with no structure scores near the bottom and gets penalized to 0.7x in every search result.

### Writing documents that score well

Structure your notes the way you'd want to read them later. Use headings to separate topics — each heading creates a separate fragment that can be embedded and retrieved independently. Bullet lists score better than run-on paragraphs. If a document records a decision, say so explicitly ("We decided X because Y") rather than burying it in narrative.

Frontmatter adds 0.2 to the quality score. Even minimal frontmatter helps:

```yaml
---
title: Switch from REST to gRPC for internal services
type: decision
date: 2026-03-15
---
```

This is not about gaming the scoring system. Documents that score well are also documents that agents (and humans) can actually use — they have structure, they state their purpose, and they're findable by the terms you'd naturally search for.

### Co-activation boost (1.0 - 1.15)

```
coActivationBoost = 1 + min(coCount / 10, 0.15)
```

Documents frequently surfaced together in the same session get up to 15% boost.

**Where co-activation is applied depends on the caller.** The composite MCP surfaces (`query`, `search`, and `vsearch` on recency-intent queries only) pass a co-activation function into `applyCompositeScoring()`, so the boost is part of the composite score used for ranking and — on `vsearch` and `search`, the tools that expose `minScore` — for `minScore` filtering. On `vsearch`'s non-recency (raw) regime, co-activation contributes only to the exact-tie key, never to ranking or filtering. The context-surfacing hook does NOT pass co-activation into composite scoring — instead it applies a separate spreading-activation step *after* adaptive threshold filtering. This means the hook's threshold decisions are based on scores without co-activation, and co-activation only boosts results that already passed the threshold. This is intentional: it prevents relationship boosts from rescuing otherwise-weak results into the surfaced set.

## Additional modifiers

### Pin boost

On composite surfaces, pinned documents receive a +0.3 additive boost (capped at 1.0 total). Pin's contract is **lifecycle retention + prioritization among relevance-equivalent results** — on the raw vector routes (v0.22.0) it therefore breaks exact raw-score ties only and never lifts a document over a more relevant one.

### Length normalization

```
lengthPenalty = 1 / (1 + 0.5 * log2(max(bodyLength / 500, 1)))
```

Penalizes verbose entries. Floor at 30% of original score.

### Frequency boost

```
freqSignal = (revisions - 1) * 2 + (duplicates - 1)
freqBoost = min(0.10, log1p(freqSignal) * 0.03)
```

Revision count weighted 2x vs duplicate count. Capped at 10%.

### MMR diversity filter

After scoring, results pass through Maximal Marginal Relevance filtering. Documents with Jaccard bigram similarity > 0.6 to a higher-ranked result are demoted (not removed).

## Score distribution and adaptive thresholds

Absolute composite scores vary across vaults due to several factors:

- **Vault size** — smaller vaults produce higher BM25 scores per hit because IDF (inverse document frequency) is less diluted. A 30-doc vault may score 0.8 on a good match while a 3000-doc vault scores 0.4 for equal relevance.
- **Quality multiplier** — ranges 0.7x to 1.3x based on document structure. A vault of well-structured docs with headings, lists, and frontmatter gets systematically higher composite scores than a vault of flat text notes.
- **Embedding model** — zembed-1 (2560d) and EmbeddingGemma (768d) produce different cosine similarity distributions. Higher-dimensional embeddings tend toward lower absolute cosine scores but better relative ordering.
- **Content age** — recency accounts for 25% of composite score. A vault of recent docs (< 30 days old) has minimal decay. A vault of 6-month-old research notes gets significant recency penalties even on strong search relevance.

Context-surfacing handles this with adaptive ratio-based thresholds instead of fixed absolute values. The hook computes the best composite score in the result set, then keeps results within a percentage of that best score (e.g., 55% for balanced). An activation floor prevents surfacing when even the best result is too weak. See [profiles](hooks-vs-mcp.md#adaptive-thresholds) for the specific values per profile.

MCP tools use fixed absolute `minScore` thresholds since agents control those limits directly.
