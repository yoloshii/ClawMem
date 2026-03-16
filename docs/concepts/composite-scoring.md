# Composite Scoring

Every search result in ClawMem is scored using a composite formula that blends multiple signals beyond raw search relevance.

## Formula

```
compositeScore = (w_search * searchScore + w_recency * recencyScore + w_confidence * confidenceScore)
                 * qualityMultiplier * coActivationBoost
```

### Default weights

| Signal | Normal | Recency intent |
|--------|--------|---------------|
| searchScore | 0.50 | 0.10 |
| recencyScore | 0.25 | 0.70 |
| confidenceScore | 0.25 | 0.20 |

Recency intent is detected automatically when queries contain "latest", "recent", "last session", etc.

## Signal breakdown

### Search score (0.0 - 1.0)

Raw relevance from the search backend — BM25, vector cosine similarity, or RRF-fused hybrid score.

### Recency score (0.0 - 1.0)

Exponential decay based on document age and content type half-life:

| Content type | Half-life | Behavior |
|-------------|-----------|----------|
| decision, hub | Infinite | Never decay |
| antipattern | Infinite | Never decay |
| project | 120 days | Slow decay |
| research | 90 days | Moderate decay |
| note | 60 days | Default |
| progress | 45 days | Faster decay |
| handoff | 30 days | Fast decay — recent matters most |

Half-lives extend up to 3x for frequently-accessed memories (access reinforcement decays over 90 days).

### Confidence score (0.0 - 1.0)

Starts at 0.5 for new documents. Adjusted by:

- **Contradiction detection** — when `decision-extractor` finds a new decision contradicting an old one, the old decision's confidence is lowered
- **Feedback loop** — referenced notes get confidence boosts
- **Attention decay** — non-durable types (handoff, progress, note, project) lose 5% confidence per week without access. Decision, hub, research, and antipattern types are exempt.

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

## Additional modifiers

### Pin boost

Pinned documents receive +0.3 additive boost (capped at 1.0 total).

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
