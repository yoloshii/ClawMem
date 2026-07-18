# Offline eval harness

Measure retrieval quality against a hand-labeled gold set instead of eyeballing it. `clawmem eval run` replays labeled queries through the **real** `query` tool handler — the exact code path an agent's MCP call takes, including expansion, RRF fusion, rerank blending, composite scoring, and MMR diversity at their tool defaults — and scores the returned documents against gold evidence with doc-level Jaccard (`J = |C∩E| / |C∪E|`), precision@k, recall@k, hit@k, and MRR. It exists so ranking/extraction changes ship **measured**: a before/after pair of runs on the same gold set is the evidence a change actually helps.

The harness is offline and CLI-only (no MCP tool). The replayed path writes nothing to `context_usage`, `recall_events`, or `memory_relations` — eval runs never contaminate the retrieval, lifecycle, or telemetry state they may later mine for label candidates. It is not byte-level read-only, though: expansion and reranking may populate the normal inference cache (`llm_cache`), exactly as any live query would.

## Gold files

Gold sets are versioned JSONL files that live **outside** the vault DB — pass any path via `--gold`, so private labels can stay out of the repo. One example per line:

```json
{
  "id": "p1-why-001",
  "query": "why did we defer FastRP?",
  "mode": "query",
  "include_internal": true,
  "gold_evidence": [
    { "collection": "_clawmem", "path": "decisions/2026-06-12-context-graph.md" }
  ],
  "tags": ["why", "decision"]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique per file — duplicates are a hard error. |
| `query` | yes | The query to replay, verbatim. |
| `mode` | no (default `query`) | Which replay surface the example is labeled for: `query` \| `intent_search` \| `context` \| `raw` \| `structured`. A run replays only the examples matching its `--profile`; the rest are skipped with accounting. |
| `include_internal` | no (default `false`) | Passed through to the tool call. Gold evidence in `_clawmem` needs `true` — retrieval tools exclude internal docs by default. |
| `collection` | no | Optional collection filter passed through to the tool call. |
| `gold_evidence[]` | yes (≥1) | Each ref needs `collection` + `path`. Optional: `hash` (content pin — a mismatch warns that the label may be stale, but still scores), `weight`, `span`, `chunk_seq` (parsed and carried; scoring is doc-level in this build, so they do not affect metrics — weighted/nDCG variants are a later phase). |
| `force_intent`, `budget_tokens` | no | Knobs for the `intent_search`/`context` replay profiles (follow-on phases); carried, unused by the `query` profile. |
| `gold_answer` | no | Answer rubric for optional offline answer scoring (not implemented; retrieval gold only). |
| `tags[]` | no | Aggregated into a per-tag metrics table in the report. |

**Labeling discipline:** the hand-labeled file is the authority — telemetry ("the assistant referenced this doc") proposes candidates but is never truth. 30 resolved examples is a feature-specific smoke floor; 80–120 gives a trustworthy global number. Hand-audit 10–20% of labels, then attest it with `--audited` — the trust gate requires the attestation (the harness records it; it cannot verify it).

**Strictness:** any malformed line, schema violation, unknown field (a typo like `includeInternal` would otherwise silently evaluate a different route), or duplicate id fails the whole load — a silently dropped example would corrupt the metric. Repeated tags are deduplicated. An example with **any** evidence ref that doesn't resolve to an active document is excluded from scoring entirely — partial gold would silently inflate recall — and fails the run's trust gate *regardless of the example's `mode`* (a stale label never vanishes into the skipped list).

## Running

```bash
clawmem eval run --gold labels.jsonl                      # profile query, k=10, out to ./eval-runs/<run_id>/
clawmem eval run --gold labels.jsonl --limit 5 --out runs/baseline
clawmem eval run --gold labels.jsonl --min-examples 80 --audited   # global-number trust floor, audit attested
clawmem eval run --gold labels.jsonl --audited --db snapshot.sqlite   # corpus-frozen run against a DB snapshot
clawmem eval run --gold labels.jsonl --json               # print run.json to stdout
```

| Flag | Default | Meaning |
|---|---|---|
| `--gold <file>` | required | Gold JSONL path. |
| `--profile query` | `query` | Replay surface. This build implements `query`; `intent`/`context`/`raw`/`structured` are follow-on phases. |
| `--limit N` | 10 | The k in the @k metrics — the `limit` passed to the replayed tool. |
| `--min-examples N` | 30 | Trust-gate floor for `examples_scored`. |
| `--audited` | off | Attest that a 10–20% hand-audit of the gold labels passed. Recorded as `audit_attested` in `run.json`; the trust gate fails without it. |
| `--out <dir>` | `eval-runs/<run_id>/` | Where `run.json` + `report.md` land. |
| `--db <path>` | live vault | Point the whole run (resolution + replay) at a snapshot DB — e.g. a `VACUUM INTO` copy. Corpus-frozen (documents and labels can't drift between runs), not fully deterministic — the snapshot is opened writable and inference caches may populate, and live expansion/rerank services can still vary. Must already exist (a typo'd path is refused, never created as an empty vault). |
| `--json` | off | Emit `run.json` to stdout instead of the summary line. |

Run it via `bin/clawmem` as usual so the inference endpoints are set — the replay uses whatever embedding/expansion/reranker services the live pipeline would. **Exit code:** `0` only when the run completes AND the trust gate passes; a completed run with a failing gate exits `1` (artifacts still written) so automation can never mistake an untrusted number for a trusted one.

**Identity integrity:** retrieved results are mapped back to document ids by inverting the `collection/path` display path. If a returned path maps to zero documents (vault changed mid-run) or to more than one (a collection name containing `/` colliding with a sibling — nothing forbids such names), the run hard-fails rather than guess or silently drop the result, since either would corrupt precision and Jaccard.

## Reading the output

`run.json` is the machine artifact: run metadata (profile, k, gold path, DB path, clawmem version), `aggregate` (jaccard/recall/precision means, hit@k, MRR, p95 latency), `by_tag` slices, per-example detail (metrics, retrieved vs gold doc lists, warnings), `unresolved_gold`, `skipped`, and `gates`. `report.md` is the human companion for hand-auditing.

Token-axis fields (`tokens_mean`, `recall_per_1k_tokens`) are `null` under the `query` profile — the only honest token measure is the context-surfacing replay's `buildContext` accounting, which arrives with the `context` profile.

**Gates in this build are the labeled-set trust gate only**: enough scored examples, zero unresolved refs, and the `--audited` operator attestation. Comparative feature gates (e.g. "recall must improve ≥5pp with no >10% token increase") are computed *between* runs — do an A/B by running the same gold file against two checkouts or two `--db` snapshots and comparing the two `run.json` artifacts.

## Relation to `scripts/eval-*.ts`

The route-local scripts (`eval-keyword-acceptance.ts` etc.) are **frozen decision bundles**: they mirror specific handler internals deterministically for one A/B verdict, run FTS-only with zero services, and stay untouched as historical artifacts. This harness is the general product surface — it replays the real handlers end-to-end rather than mirroring them, so it measures the product, not a copy that can drift.
