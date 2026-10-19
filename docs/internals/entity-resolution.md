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

This runs every document through the full enrichment pipeline, but entity extraction itself is skipped for a document whose title and body still match its recorded hash. `--enrich` therefore does not redo extraction for an unchanged document: not under a new model, entity cap or filter, and not to resolve its mentions again after a resolver change. For the links an earlier resolver got wrong, see [Repairing links made before v0.43.2](#repairing-links-made-before-v0432).

## Repairing links made before v0.43.2

`clawmem repair entities` (v0.43.4) moves the mentions and triple endpoints that a resolver before v0.43.2 attached to the wrong entity, and only those that their own stored text proves wrong. The text is a mention's `mention_text`, or a triple's subject or object as each of its evidence rows records it (`source_fact` is `subject predicate object`).

- **R1, the numbers differ.** The text holds other runs of digits than the linked entity's name: facts about `Node 200` stored on `Node 202`. This includes a variant that adds or drops a number (`Driver 590` stored on `Driver 590.44`), which v0.43.2 keeps apart.
- **R2, another entity has that exact name.** The text names another entity in the linked entity's bucket and vault exactly.

Each such link is resolved again with today's resolver and moved to its answer. When the answer is no entity, one is created as the resolver would create it: named as written, with `mention_count` 0. Two other kinds of difference are counted and left alone, because the stored text does not prove the link wrong: **R3**, the text equals the linked entity's name, but today's resolver picks another entity of that name or none (a duplicate entity, not a wrong link); **R4**, anything else today's resolver would answer differently, such as types assigned inconsistently, or a merge of names without a number difference whose text names no other entity in the bucket exactly.

**Order.** Links are resolved one at a time, in the order they were seen. Evidence and mention times are compared as UTC instants, and a missing or unreadable time comes last; then evidence before mention, then row id, then subject before object. Resolution runs on an in-memory copy of the vault's `entity_nodes` and `entities_fts`, with the same rows and row ids, so a later link can resolve to an entity created for an earlier one, as it would in sequential resolution. Apply checks every answer on the vault itself too, in the same order, writing each created entity before it checks the answers after it; any mismatch rolls the whole apply back.

**Holds.** A held link stays as it is, and the dry run lists it with its reason:

| Reason | Meaning |
|--------|---------|
| `cross-bucket` | The text names an entity of another bucket exactly |
| `predicate-twice` | The predicate occurs twice in the fact, so subject and object cannot be told apart |
| `resolver-still-linked` | Today's resolver still answers the linked entity |
| `alias-only` | The match came through a search row that holds another name |
| `slug-collision` | The ID a new entity would get is taken by an entity of another name |
| `fts-row-mismatch` | That ID already has a search row with another name or type |
| `key-of-held-triple` | The repaired triple would merge into a held one |
| `open-key-taken` | The repaired triple would be a second open triple with the same subject, predicate and object (they differ only in `valid_from`) |
| `no-node` | The linked entity has no row or no type |

A held triple keeps all of its evidence, and no other link resolves to an entity created for a held link.

**Triples.** A triple's evidence rows are grouped by their repaired key (subject, predicate, object and validity). A group whose key one of its triples already has keeps that triple. Otherwise it merges into an untouched triple that has the key, or re-points the triple holding its earliest evidence, or becomes a new triple. A triple left without evidence is removed. Evidence rows with the same document and fact collapse to the earliest one, and a surviving triple takes its earliest evidence row's source, fact and time, and the highest confidence among the triples merged into it.

**Mentions.** Within a document, each repaired mention moves to its new entity. Mentions that meet at one entity collapse to one: a mention already there wins, else the earliest, and its text and time are kept. `mention_count` and the co-occurrence counts change by the difference; a co-occurrence row that one document's move removes and another's makes again keeps its time. When the document's text still contains the old entity's name, the dry run says so, and the mention moves anyway.

**Entity edges.** The repair adds an `entity` edge only where it makes two documents share an entity. For a repaired document that is active, it takes the edges enrichment would give the document now and adds one when the entities the two documents newly share (ones that were not in both documents before) reach enrichment's specificity threshold on their own, the entities they already shared do not, and no `entity` edge joins the two documents in either direction. Like enrichment, it sees only the documents each entity's candidate lookup returns (20 per entity). An existing edge whose recorded entity the two documents no longer share is listed as stale and kept: no stored field shows which writer created it, and extracting the document again rebuilds its links.

**Dry run, apply and restore.**

- Without `--apply` or `--restore`, the command plans every vault, or the one `--vault` names, and writes nothing (a read-only handle and one read snapshot). It prints the counts, the holds, every planned change, and a **plan digest**: a hash of the repair's own decisions, namely the order, each answer, each new entity, each triple's grouping and evidence, each mention move, the count changes, and each added edge's two documents and recorded entity, with the stored values those decisions rest on: each link's entity and time before the repair, each affected triple's endpoints, and the time of each grouped evidence row and moving mention. Edge weights and the reports are not in it, so writes elsewhere in the vault change it only when they change what the repair would do.
- `--apply --vault <name> --expect <digest>` plans again under the vault's write lock and writes only when the digest is the one you reviewed. `--expect` is optional: without it, apply writes whatever it plans then. It checks every answer against the vault, computes the edges on the vault after moving the mentions and requires them to match its plan, and records every change in `entity_repair_log` under an op id. Any refusal rolls everything back and exits 1.
- `--restore <op> --vault <name>` undoes an apply, one group of dependent changes at a time: one document's mentions, or the triples and evidence rows one repair regrouped. A group is reversed only while the rows it wrote are unchanged (its triples and evidence rows, or the document's whole set of mentions; the counts are not checked), each triple that carries a repaired group included (a later sighting, a triple closed since, or a document whose entities were extracted again, keeps it) and is otherwise kept and reported. A group is also kept when undoing it would put a triple back on a subject, predicate and object that another open triple has taken since (a fact recorded after the repair, or a triple whose own group is kept): ClawMem keeps one open triple per subject, predicate and object. Counts are reversed by their difference. Added edges are never removed. A created entity is removed only when nothing refers to it any more.

The repair opens vault files directly and never initializes a store. It refuses a vault that `ANALYZE` has given statistics for `entity_nodes` (ClawMem never runs `ANALYZE`) until those rows are dropped, and a vault whose triple evidence has not been backfilled yet until ClawMem has opened it once.

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
