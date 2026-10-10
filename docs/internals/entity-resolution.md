# Entity resolution

ClawMem extracts named entities from documents during A-MEM enrichment, resolves them to canonical forms, and tracks co-occurrences to power entity-aware retrieval.

## Extraction

Each document is passed to the LLM (QMD query expansion model by default) with a prompt requesting named entities as JSON. The LLM returns `(name, type)` pairs from a fixed type vocabulary:

`person`, `project`, `service`, `tool`, `concept`, `org`, `location`

Entities pass through quality filters before storage:
- Document titles are rejected (Levenshtein similarity > 0.85 against the doc's own title)
- Names longer than 60 characters are rejected (likely titles or sentence fragments)
- Template placeholders and heading labels are blocklisted
- Location entities are validated against lexical patterns (IP addresses, VM identifiers, short geographic names) — long non-geographic names typed as location are rejected

## Canonical resolution

The same resolver serves the entities extracted from documents during enrichment, the subjects and objects of the triples `decision-extractor` stores, and the proper nouns `context-surfacing` looks up in a prompt. It checks whether a matching entity already exists in the vault, in two steps:

1. **Exact name (v0.43.2).** An entity in the same bucket (below) whose name equals the new one, ignoring letter case (non-ASCII letters included) and leading or trailing spaces, is the match. When several do, the oldest wins, so later mentions all feed the same entity.
2. **Fuzzy match.** Otherwise, FTS5 candidate lookup followed by Levenshtein fuzzy matching (threshold 0.75, lowered to 0.65 for person names). Two names whose numbers differ never match (v0.43.2): a candidate must hold the same runs of digits in the same order. One changed digit costs a short name little similarity (`node 200` vs `node 202` scores 0.875), and that digit is usually what tells two entities apart: a host, a port, a version, a date. A variant that adds or drops a number (`Driver 590` vs `Driver 590.44`) therefore becomes its own entity.

Resolution is **type-agnostic within compatibility buckets**. Two entities with the same name but different types will merge if their types belong to the same bucket:

| Bucket | Types | Rationale |
|--------|-------|-----------|
| `person` | person | People should never merge with non-people |
| `org` | org | Organizations are distinct from other categories |
| `location` | location | Geographic entities kept separate |
| `tech` | project, service, tool, concept | LLMs frequently assign these inconsistently for the same entity across documents |

Cross-bucket merges are always rejected. "Andrea" as a person will never merge with "Andrea" as a project, even if both exist in the vault.

Unknown types (if you customize the extraction prompt) default to their own isolated bucket — they won't false-merge with anything.

### How merging works

When a new entity is extracted and a canonical match is found in the same bucket:
1. The existing entity's `mention_count` is incremented
2. The new mention is recorded against the existing entity's ID
3. No new `entity_nodes` row is created

When no match is found, a new entity node is created with ID format `vault:type:normalized_name`.

### Extending the type vocabulary

The extraction prompt and bucket map live in `src/entity.ts`. To add domain-specific types:

1. Add the type to the prompt's type list
2. Add it to `ENTITY_BUCKETS` with a bucket assignment:

```typescript
const ENTITY_BUCKETS: Record<string, string> = {
  person: 'person',
  org: 'org',
  location: 'location',
  project: 'tech',
  service: 'tech',
  tool: 'tech',
  concept: 'tech',
  // Domain extensions:
  statute: 'legal',
  regulation: 'legal',   // statutes and regulations can merge
  drug: 'medical',
  condition: 'medical',  // or keep them separate with distinct buckets
};
```

Types not listed in `ENTITY_BUCKETS` automatically form their own single-type bucket.

## Co-occurrences

When multiple entities are extracted from the same document, all pairs are recorded in `entity_cooccurrences`. This powers:
- The entity graph channel in `query` (conditional 1-hop entity walk from seed results)
- Entity-aware MPFP meta-path patterns (`[entity, semantic]`)
- `getEntityGraphNeighbors()` for discovering related documents through shared entities — ranked by co-occurrence count blended with the same IDF specificity used for edge weights (v0.25.0, BL-001), so ubiquitous hub entities do not dominate the ordering; archived-only candidates and archived documents are excluded

## Entity edges

Document-to-document edges with `relation_type='entity'` are created in `memory_relations` when two documents share entities. Edge weight is computed using IDF-based specificity:

- **Rare entities** (appearing in few documents) produce higher-weight edges
- **Ubiquitous entities** (appearing in many documents) produce low-weight edges that fall below the creation threshold

This prevents common entities (e.g., a project name mentioned in every doc) from creating noise edges between unrelated documents, while allowing rare entities to establish meaningful connections even as the sole shared entity.

## Enrichment lifecycle

Entity extraction runs as part of the A-MEM `postIndexEnrich()` pipeline when a document is first indexed; when an existing document's content changes, indexing refreshes its A-MEM note only. Each extraction records an input hash of the title and body in `entity_enrichment_state`.

To backfill extraction (after an upgrade that adds an enrichment stage, or for documents whose content changed since their last extraction):

```bash
clawmem reindex --enrich
```

This runs every document through the full enrichment pipeline, but entity extraction itself is skipped for a document whose title and body still match its recorded hash. `--enrich` therefore does not redo extraction for an unchanged document: not under a new model, entity cap or filter, and not to resolve its mentions again after a resolver change.

## Model quality and entity extraction

Entity extraction quality scales directly with LLM capability. The default QMD query expansion model (1.7B parameters) is optimized for query expansion, not structured extraction — it can mistype entities, echo prompt examples, or extract document titles as entities. The quality filters in the pipeline catch most of these, but a more capable model produces cleaner extractions with fewer filter rejections.

**Options for better entity extraction:** each takes effect for documents extracted from then on; `reindex --enrich` re-extracts only documents that are new or changed since their last extraction (see [Enrichment lifecycle](#enrichment-lifecycle)).

### Option 1: Use a larger local model

Point `CLAWMEM_LLM_URL` at a more capable model for all LLM tasks (query expansion + entity extraction + A-MEM notes + the Stop hooks' observations and handoff summary):

```bash
# Example: use a 7B+ model instead of QMD 1.7B (extracts new or changed documents only)
CLAWMEM_LLM_URL=http://localhost:8091 \
CLAWMEM_LLM_MODEL=your-7b-model \
clawmem reindex --enrich
```

Trade-off: query expansion is already well-served by QMD — a larger model is slower for the same task with marginal gains. Entity extraction benefits more.

### Option 2: Use a cloud API

Point the LLM at a cloud endpoint for higher-quality extraction. Any OpenAI-compatible `/v1/chat/completions` endpoint works:

```bash
# Example: use an OpenAI-compatible API (extracts new or changed documents only)
CLAWMEM_LLM_URL=https://api.example.com/v1 \
CLAWMEM_LLM_MODEL=gpt-5.4-mini \
clawmem reindex --enrich
```

Trade-off: cloud API calls have per-token costs. With 261 documents at ~2000 tokens each, a full re-enrichment is roughly 500K input tokens.

### Option 3: Accept the default and rely on filters

The quality filters (title rejection, length limits, blocklist, location validation, type-agnostic canonical resolution) compensate for most small-model weaknesses. For many vaults, the default QMD model with filters produces adequate entity graphs. Improved filters apply to documents extracted after an upgrade; `reindex --enrich` does not re-extract unchanged documents (see [Enrichment lifecycle](#enrichment-lifecycle)).

### Recommendation

For vaults where entity graph quality matters (large corpora, cross-document discovery, ENTITY intent queries), use a 7B+ model or cloud API before the vault's first indexing, when each document's entities are first extracted; a later `reindex --enrich` does not re-extract unchanged documents. The watcher's incremental enrichment can continue with the default QMD model — individual document additions are less sensitive to extraction quality than bulk corpus enrichment.
