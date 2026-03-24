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

When an entity is extracted, ClawMem checks whether a matching entity already exists in the vault. Resolution uses FTS5 candidate lookup followed by Levenshtein fuzzy matching (threshold 0.75, lowered to 0.65 for person names).

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
- `getEntityGraphNeighbors()` for discovering related documents through shared entities

## Entity edges

Document-to-document edges with `relation_type='entity'` are created in `memory_relations` when two documents share entities. Edge weight is computed using IDF-based specificity:

- **Rare entities** (appearing in few documents) produce higher-weight edges
- **Ubiquitous entities** (appearing in many documents) produce low-weight edges that fall below the creation threshold

This prevents common entities (e.g., a project name mentioned in every doc) from creating noise edges between unrelated documents, while allowing rare entities to establish meaningful connections even as the sole shared entity.

## Enrichment lifecycle

Entity extraction runs as part of the A-MEM `postIndexEnrich()` pipeline during indexing. Each document's enrichment is tracked via `entity_enrichment_state` (input hash of title + body). Documents are only re-extracted when their content changes.

To force re-extraction after upgrading ClawMem:

```bash
clawmem reindex --enrich
```

This processes all documents through the full enrichment pipeline regardless of whether content changed.

## Model quality and entity extraction

Entity extraction quality scales directly with LLM capability. The default QMD query expansion model (1.7B parameters) is optimized for query expansion, not structured extraction — it can mistype entities, echo prompt examples, or extract document titles as entities. The quality filters in the pipeline catch most of these, but a more capable model produces cleaner extractions with fewer filter rejections.

**Options for better entity extraction:**

### Option 1: Use a larger local model

Point `CLAWMEM_LLM_URL` at a more capable model for all LLM tasks (query expansion + entity extraction + A-MEM notes):

```bash
# Example: use a 7B+ model instead of QMD 1.7B
CLAWMEM_LLM_URL=http://localhost:8091 clawmem reindex --enrich
```

Trade-off: query expansion is already well-served by QMD — a larger model is slower for the same task with marginal gains. Entity extraction benefits more.

### Option 2: Use a cloud API

Point the LLM at a cloud endpoint for higher-quality extraction. Any OpenAI-compatible `/v1/chat/completions` endpoint works:

```bash
# Example: use an OpenAI-compatible API
CLAWMEM_LLM_URL=https://api.example.com/v1 clawmem reindex --enrich
```

Trade-off: cloud API calls have per-token costs. With 261 documents at ~2000 tokens each, a full re-enrichment is roughly 500K input tokens.

### Option 3: Accept the default and rely on filters

The quality filters (title rejection, length limits, blocklist, location validation, type-agnostic canonical resolution) compensate for most small-model weaknesses. For many vaults, the default QMD model with filters produces adequate entity graphs. Run `reindex --enrich` after upgrading ClawMem to benefit from improved filters.

### Recommendation

For vaults where entity graph quality matters (large corpora, cross-document discovery, ENTITY intent queries), use a 7B+ model or cloud API for the initial `reindex --enrich` pass. The watcher's incremental enrichment can continue with the default QMD model — individual document additions are less sensitive to extraction quality than bulk corpus enrichment.
