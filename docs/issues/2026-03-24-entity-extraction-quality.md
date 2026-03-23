# Entity Extraction Quality Issues

- Category: retrieval-gap
- Severity: medium
- Status: open

## Observed

Spot audit of entity extraction after v0.2.0 full enrichment (261 docs, 240 entities) revealed:

1. **Same entity classified under multiple types** — "ClawMem" appears as `tool` (18x), `project` (11x), `service` (6x). Canonical resolution matches on name+type, so different types create separate entities. Same issue with "VM 202" (`project` 16x, `service` 5x).

2. **LLM prompt template leaking as entity** — "Entity Name" extracted 5x. The JSON template placeholder in the extraction prompt is being returned as a real entity.

3. **Document titles extracted as entities** — "OpenClaw Update: v2026.2.22-2 → v2026.2.23" (16x). Long version-specific titles are not useful entities.

4. **Co-occurrence self-pairs** — "Campaign: GFL SEO Content Factory (Feb 2026)" paired with itself (3x). Likely from duplicate surface forms resolving to different canonical IDs due to slight text differences.

5. **Unused entity type** — `org` type defined in prompt but never produced by the LLM. Distribution: project (109), service (77), tool (29), location (12), concept (7), person (6), org (0).

## Expected

- "ClawMem" should resolve to one canonical entity regardless of type classification
- Template placeholders should never appear as extracted entities
- Document titles should not be extracted as entities
- No self-pairs in co-occurrences

## Context

- Extraction model: qmd-query-expansion-1.7B (Qwen3-1.7B finetune) — optimized for query expansion, not structured extraction
- Extraction prompt: `src/entity.ts:extractEntities()` — asks LLM to return JSON array of {name, type} pairs
- Canonical resolution: FTS5 + Levenshtein fuzzy matching, scoped by vault AND type

## Suggested Fix

1. **Type-agnostic canonical resolution** — match on name similarity alone (ignoring type) within the same vault. Merge "ClawMem:tool" and "ClawMem:project" into one canonical entity. Keep the most common type.

2. **Post-extraction filter** — reject entities matching known template strings ("Entity Name", "entity1"), entities longer than ~60 chars (likely titles), and entities identical to the document title.

3. **Prompt tightening** — add negative examples: "Do NOT extract document titles as entities. Do NOT return the template example as a real entity."

4. **Self-pair guard** — `trackCoOccurrences()` should skip pairs where both IDs are equal after canonical resolution.

5. **Consider a better extraction model** — Qwen3-4B or 8B would produce more consistent type classifications and fewer hallucinated entities. The 1.7B model is at the edge of reliable structured extraction.
