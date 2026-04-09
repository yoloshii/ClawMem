# ClawMem architecture

ClawMem stores AI agent memory in a single SQLite vault that combines BM25 full-text search with vector embeddings and graph-based retrieval. This page explains how vaults, collections, documents, and search backends fit together.

## Vaults

A vault is a single SQLite database file containing all of ClawMem's data: documents, content, vectors, relations, sessions, and usage tracking. The default vault lives at `~/.cache/clawmem/index.sqlite`.

SQLite is used in WAL (Write-Ahead Logging) mode with `busy_timeout=5000ms`, allowing concurrent reads from multiple processes (e.g., Claude Code and OpenClaw sharing the same vault).

## Collections

Collections are named groups of documents sourced from a directory. Each collection has:

- **Name** — identifier (e.g., `notes`, `research`, `memory`)
- **Path** — absolute directory path to scan
- **Pattern** — glob pattern for files to index (default: `**/*.md`)

Collections are defined in `~/.config/clawmem/config.yaml` (symlinked as `index.yml` in the vault directory).

```yaml
collections:
  notes:
    path: ~/notes
    pattern: "**/*.md"
  research:
    path: ~/research
    pattern: "**/*.md"
```

Only markdown files are indexed. Binary files, code, and credentials are never indexed.

### What to index

The retrieval pipeline surfaces better results from a richer corpus. Beyond the default memory and session log patterns, consider adding collections for research notes, architecture decisions, domain references, project specs, and any markdown you regularly consult during agent sessions. The broader the indexed field, the more likely context-surfacing will find something relevant to the current task.

Code files (`.ts`, `.py`, `.go`, etc.) are intentionally excluded. BM25 and embedding models trained on natural language don't perform well on code syntax — variable names, imports, and bracket-heavy constructs pollute the search index. Code retrieval is better served by tools built for that purpose (tree-sitter, LSP, semantic code search). Capture your technical decisions and architecture rationale in markdown instead; that's what agents need when making decisions during a coding session.

### Excluded directories

These directories are always skipped during indexing:

`_PRIVATE`, `.clawmem`, `.git`, `.obsidian`, `.logseq`, `.foam`, `.dendron`, `.trash`, `.stversions`, `node_modules`, `.cache`, `vendor`, `dist`, `build`, `gits`, `scraped`

## Documents

Each indexed file becomes a document with:

| Field | Description |
|-------|-------------|
| `collection` | Which collection it belongs to |
| `path` | Relative path within the collection |
| `title` | Extracted from first heading or filename |
| `hash` | SHA-256 of content (canonical identity) |
| `docid` | First 6 hex chars of hash (for human reference) |
| `content_type` | Auto-detected: decision, deductive, preference, note, handoff, conversation, progress, research, hub, antipattern, project, milestone, problem |
| `quality_score` | 0.0-1.0 based on length, structure, headings, lists, decision keywords, frontmatter |
| `confidence` | Starts at 0.5, adjusted by contradiction detection and feedback |
| `pinned` | Manual boost flag (+0.3 composite score) |
| `snoozed_until` | Temporarily hidden from context surfacing |

## Fragments

Each document is split into fragments for embedding:

- **full** — entire document (if under size limit)
- **section** — content under each heading
- **list** — list items grouped together
- **code** — code blocks

Fragments are embedded independently. The full-document fragment catches broad queries; section/list/code fragments provide precision.

## Search backends

| Backend | Signal | GPU cost | Use case |
|---------|--------|----------|----------|
| BM25 (FTS5) | Keyword exact match | 0 | Known terms, spot checks |
| Vector (vec0) | Semantic similarity | 1 call | Conceptual queries, fuzzy recall |
| Hybrid (RRF) | BM25 + Vector fused | 1+ calls | General recall (default) |

BM25 uses SQLite's FTS5 extension with prefix matching. Vector search uses the `vec0` extension with cosine similarity. Embedding dimensions depend on the model: 768 for the default EmbeddingGemma-300M, 2560 for the SOTA zembed-1, or provider-determined for cloud embedding.

## Graphs

ClawMem maintains a `memory_relations` table of typed edges between documents: semantic, supporting, contradicts, causal, and temporal. These edges let `intent_search` answer "why" and "what led to" questions by following chains across documents rather than relying on keyword or vector similarity alone.

A separate `entity_triples` table stores structured SPO (Subject-Predicate-Object) facts with temporal validity (`valid_from`/`valid_to`). Triples are extracted automatically from observation facts by `decision-extractor` — only from decision, preference, milestone, and problem observations to avoid noise. Query via `kg_query(entity)` for structured entity relationships.

Most edges are created automatically. When new documents are indexed, A-MEM finds vector neighbors and uses the LLM to classify relationships (semantic, supporting, contradicts). When `decision-extractor` runs after each response, it infers causal links between observations and extracts SPO triples from facts. The `build_graphs` MCP tool adds temporal backbone edges (creation-order) and bulk semantic edges — run it after large ingestion batches, not after routine indexing.

See [graph traversal](../internals/graph-traversal.md) for edge types, traversal mechanics, and beam search details.

## Consolidation safety (v0.7.1)

The background consolidation worker has three independent safety gates that prevent observation contamination, accidental cross-entity merges, and unchecked contradictions from landing in the vault.

### Phase 2 — name-aware merge safety

When the worker finds a candidate existing observation to merge a new pattern into, it runs a deterministic name-aware gate before updating. The gate extracts entity anchors from both the new and existing texts — first via `entity_mentions` (if the source docs are enriched), falling back to lexical proper-noun extraction — and compares them with normalized character 3-gram cosine similarity. When anchor sets differ materially (Jaccard ≤ 0.5), the merge is hard-rejected regardless of text similarity. Otherwise, a dual-threshold score applies: `CLAWMEM_MERGE_SCORE_NORMAL` (default `0.93`) for aligned anchors, `CLAWMEM_MERGE_SCORE_STRICT` (default `0.98`) as the strictest fallback. This prevents "Alice decided X" from merging into "Bob decided X" just because the predicate is identical. Set `CLAWMEM_MERGE_GUARD_DRY_RUN=true` to log rejections without enforcing them.

### Phase 2 — contradiction-aware merge gate

After the name-aware gate passes, the worker checks whether the new observation contradicts the existing one. A deterministic heuristic runs first (negation asymmetry, number/date mismatch), then an LLM check confirms. If the final confidence exceeds `CLAWMEM_CONTRADICTION_MIN_CONFIDENCE` (default `0.5`), the merge is blocked and one of two policies applies (controlled by `CLAWMEM_CONTRADICTION_POLICY`):

- `link` (default) — insert a new `consolidated_observations` row and create a `contradicts` edge in `memory_relations` between the two rows. Both remain active and queryable.
- `supersede` — insert the new row and mark the old row `status='inactive'` with `invalidated_at`/`superseded_by` set. The old row is filtered from retrieval but preserved for audit.

Phase 3 deductive synthesis applies the same `contradicts` link for any draft that matches a prior deductive observation with conflicting content.

### Phase 3 — anti-contamination deductive synthesis

Phase 3 synthesizes cross-session insights from recent observations into `content_type='deductive'` documents. The draft-generation LLM can produce drafts whose conclusion references entities that only appear in the candidate pool but not in the cited sources — a form of context bleed. Each draft runs through a three-layer validator:

1. **Deterministic pre-checks** — reject empty conclusions; reject drafts whose `source_indices` don't resolve to at least two unique source docs; reject drafts whose conclusion names an entity (entity-aware via `entity_mentions`, lexical fallback via proper-noun extraction) that exists in the candidate pool but not in any cited source.
2. **LLM validator** — a separate LLM call checks that the conclusion is genuinely supported by the cited source snippets. Fail-open: if the validator times out or returns malformed JSON, the draft is accepted and flagged via the `validatorFallbackAccepts` stat so operators can detect when the LLM path is effectively offline.
3. **Dedupe** — accepted drafts are compared against recent deductive observations to prevent duplicates.

Rejection reasons are tracked individually in `DeductiveSynthesisStats` (`contaminationRejects`, `invalidIndexRejects`, `unsupportedRejects`, `emptyRejects`, `dedupSkipped`, `validatorFallbackAccepts`) so Phase 3 yield can be diagnosed without enabling extra logging.

## Post-import conversation synthesis (v0.7.2)

`clawmem mine` imports raw chat exports (Claude Code, ChatGPT, Claude.ai, Slack, plain text) as `content_type='conversation'` full-text documents. Conversations preserve the narrative but rarely cluster well in retrieval — the same decision can appear across many turns and many conversations, and BM25 or vector search surfaces the prose rather than the structured claim underneath. The `--synthesize` opt-in flag adds a post-import LLM pass that walks the freshly indexed conversations and extracts first-class structured facts (decisions, preferences, milestones, problems) with cross-fact relations, writing them as searchable documents alongside the raw exchanges.

The synthesis module is `src/conversation-synthesis.ts`. It runs **after** `indexCollection` has committed the raw conversation docs, and a failure inside the synthesis pipeline never rolls back the mine import — the raw conversations remain indexed.

### Two-pass pipeline

**Pass 1 — fact extraction.** For each conversation doc in the target collection (capped by `--synthesis-max-docs`, default 20), the pipeline:

1. Sends the conversation body (truncated to 3000 chars) to the LLM with a strict extraction prompt. The prompt lists the four allowed `contentType` values (`decision`, `preference`, `milestone`, `problem`) and the six allowed `relationType` values (`semantic`, `supporting`, `contradicts`, `causal`, `temporal`, `entity`), and explicitly authorizes links that reference facts from **other** conversations in the same imported batch.
2. Parses the response via `extractJsonFromLLM` (the same helper the A-MEM pipeline uses, robust to truncated arrays and markdown fences).
3. Normalizes each fact: rejects empty titles, disallowed contentTypes, non-string facts/aliases entries, links with bad relation types, and clamps weights to `[0, 1]`.
4. Writes each valid fact via dedup-aware `saveMemory` with a stable synthesized path:
   ```
   synthesized/<slug(title)>-src<sourceDocId>-<short sha256(normalized title)>.md
   ```
   The path is a pure function of `(sourceDocId, slug, hash(normalizedTitle))`. No encounter-order dependence. Same-slug collisions (`Use OAuth.` and `Use OAuth!` both slugify to `use-oauth`) are disambiguated by the stable hash suffix — reruns in different LLM order still pin each title to the same path, so `saveMemory`'s `UNIQUE(collection, path)` update branch is hit instead of creating parallel rows.
5. Populates a local alias map: `Map<normalizedTitleOrAlias, Set<docId>>`. Each fact contributes its canonical title and every alias into the Set. If two different facts claim the same title or alias the Set accumulates multiple docIds and later becomes ambiguous.

`extractFactsFromConversation` returns `ExtractedFact[] | null`. A `null` return discriminates "LLM path failed" (null response, thrown generate, non-array JSON) from a valid empty extraction `[]`. The orchestrator uses this to increment either `llmFailures` or `docsWithNoFacts` — two distinct operator counters that were previously conflated as `nullCalls`.

**Pass 2 — link resolution.** Runs after Pass 1 finishes for every doc in the batch (skipped entirely in `--dry-run` mode). For each saved fact's `links[]`:

1. `resolveLinkTarget` first checks the local map. If the entry maps to exactly one docId, that's the resolved target. If the set contains two or more distinct docIds, the link is treated as **ambiguous** and counted as unresolved — the resolver fails closed rather than silently binding to an arbitrary candidate.
2. If the local map has no entry, the resolver falls back to a SQL lookup scoped to the same collection: `SELECT id FROM documents WHERE collection=? AND active=1 AND LOWER(TRIM(title))=? LIMIT 2`. If the result contains more than one row (two pre-existing docs with duplicate titles), the link is again treated as ambiguous.
3. Self-referencing links (target resolves to the source fact's own docId) are skipped.
4. Resolved links are inserted into `memory_relations` via a weight-monotonic upsert:
   ```sql
   INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(source_id, target_id, relation_type)
   DO UPDATE SET weight = MAX(weight, excluded.weight)
   ```
   This policy is idempotent on equal-weight reruns (no inflation) but monotonically accepts stronger later evidence (a subsequent run that finds the same triple with higher weight updates the existing row; a subsequent run with lower weight leaves it untouched). The earlier `INSERT OR IGNORE` would have under-accumulated by discarding legitimate stronger evidence, and `store.insertRelation`'s `weight += excluded.weight` would have over-accumulated by inflating weights linearly with rerun count.

### Failure model

All LLM failures, JSON parse errors, saveMemory collisions, and relation insert errors are caught and counted, never re-thrown. The final `SynthesisResult` exposes seven counters:

| Counter | Meaning |
|---------|---------|
| `docsScanned` | Conversations selected for extraction |
| `factsExtracted` | Facts that passed validation (per fact across all docs) |
| `factsSaved` | Facts where `saveMemory` returned `inserted` or `updated` (deduplicated is counted as extracted but not saved-new) |
| `linksResolved` | Links that bound to a unique non-self target and landed in `memory_relations` |
| `linksUnresolved` | Links that couldn't resolve (unknown target, ambiguous local, ambiguous SQL, self-reference) |
| `llmFailures` | Docs where the LLM path failed — null, thrown, or non-array JSON |
| `docsWithNoFacts` | Docs where the LLM responded validly but returned zero facts (or all candidates were rejected by normalize) |

Synthesis runs only when the user explicitly passes `--synthesize` — it is off by default because each pass drives one extra LLM call per conversation doc. Reruns over the same collection are safe: paths are stable, relation weights are monotone, saveMemory dedup collapses true duplicates.

## Retrieval tiers

| Tier | Mechanism | Agent effort | Coverage |
|------|-----------|-------------|----------|
| Tier 1 | Infrastructure (watcher + embed timer) | None | Keeps vault fresh |
| Tier 2 | Hooks (automatic) | None | ~90% of retrieval |
| Tier 3 | MCP tools (agent-initiated) | 1 tool call | ~10% — escalation only |

See [Hooks vs MCP](hooks-vs-mcp.md) for details.

## Recall tracking

ClawMem tracks which documents are surfaced by retrieval, which queries surfaced them, and whether the assistant actually cited them. This data feeds lifecycle decisions (pin/snooze candidates) and provides empirical signals beyond raw search relevance.

The `recall_events` table is an append-only log. Each time context-surfacing injects documents, it writes one event per injected doc with the query hash, search score, session ID, and turn index. The `feedback-loop` hook later marks which events were actually referenced in the assistant's response, using per-turn transcript segmentation to attribute references to specific turns rather than the session globally.

The `recall_stats` table is a derived summary recomputed by the consolidation worker. It tracks per-document:

| Signal | Description |
|--------|-------------|
| `recall_count` | Total times surfaced |
| `unique_queries` | Distinct query contexts (cross-domain generality) |
| `recall_days` | Distinct calendar days surfaced (spaced vs binge frequency) |
| `diversity_score` | `min(1, max(unique_queries, recall_days) / 5)` |
| `spacing_score` | Multi-day spread: log-scaled day count + calendar span |
| `negative_count` | Surfaced but not referenced (noise signal) |

`lifecycle_status` uses these signals to surface pin candidates (high diversity + spacing + recall count) and snooze candidates (high recall count with mostly negative signals).
