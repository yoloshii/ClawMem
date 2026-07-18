/**
 * Offline eval harness — shared types (HORMA-1, BACKLOG Source 35).
 *
 * Gold evidence sets live in versioned JSONL files OUTSIDE the vault DB
 * (`--gold <path>`), hand-labeled as the authority; telemetry
 * (context_usage / recall_events) proposes candidates but is never truth.
 * P1 scores at DOCUMENT granularity: retrieval surfaces are path/document
 * based, and chunk identity is not stable across every path, so chunk_seq /
 * span / weight are parsed and carried but do not affect P1 scoring
 * (weighted nDCG is a later phase).
 */

/** One labeled evidence reference inside a gold example. */
export interface GoldEvidenceRef {
  collection: string;
  path: string;
  /** Optional content hash pin — mismatch is a warning (label may be stale), not a resolution failure. */
  hash?: string | null;
  /** Parsed for forward-compat; unused by P1 doc-level scoring. */
  chunk_seq?: number | null;
  /** Parsed for forward-compat; unused by P1 doc-level scoring (weighted nDCG later). */
  weight?: number | null;
  /** Parsed for forward-compat; unused by P1 doc-level scoring. */
  span?: { start_line: number; end_line: number } | null;
}

/** Replay surface a gold example is labeled for. P1 implements "query" only. */
export type GoldMode = "query" | "intent_search" | "context" | "raw" | "structured";

/** One line of a gold JSONL file, after validation + defaults. */
export interface GoldExample {
  id: string;
  query: string;
  mode: GoldMode;
  /** intent_search-profile knob; carried, unused by the query profile. */
  force_intent?: string;
  /** context-profile knob; carried, unused by the query profile. */
  budget_tokens?: number;
  /** Passed through to the tool call — gold in `_clawmem` needs true (tools exclude it by default). */
  include_internal: boolean;
  /** Optional collection filter passed through to the tool call. */
  collection?: string;
  gold_evidence: GoldEvidenceRef[];
  /** Optional answer rubric — L-J answer scoring is out of P1 scope (default off). */
  gold_answer?: string;
  tags: string[];
}

/** A gold ref that failed to resolve to an active document. */
export interface UnresolvedRef {
  collection: string;
  path: string;
  reason: string;
}

/** Resolution outcome for one example. Strict: ANY unresolved ref excludes the example from scoring. */
export interface ResolvedExample {
  example: GoldExample;
  /** Deduped active document ids for the resolved refs. */
  goldDocIds: number[];
  /** Resolved (collection/path, docId) pairs for reporting. */
  goldDocs: { docId: number; path: string }[];
  unresolved: UnresolvedRef[];
  /** e.g. a gold `hash` pin that no longer matches the live document. */
  warnings: string[];
}

/** Doc-level metrics for one example (HORMA J plus standard IR companions). */
export interface DocMetrics {
  jaccard: number;
  precision: number;
  recall: number;
  hit: 0 | 1;
  mrr: number;
}

/** Per-example replay + scoring result, as embedded in run.json. */
export interface ExampleResult {
  id: string;
  tags: string[];
  mode: GoldMode;
  metrics: DocMetrics;
  retrieved: { doc_id: number; path: string }[];
  gold: { doc_id: number; path: string }[];
  elapsed_ms: number;
  warnings: string[];
}

/** Aggregate block of run.json. All-null when examples_scored is 0. */
export interface RunAggregate {
  jaccard_mean: number | null;
  recall_mean: number | null;
  precision_mean: number | null;
  hit_at_k: number | null;
  mrr: number | null;
  /** Token axis belongs to the context-profile replay (buildContext); null under the query profile. */
  tokens_mean: number | null;
  recall_per_1k_tokens: number | null;
  elapsed_ms_p95: number | null;
}

/** run.json — the machine artifact of one eval run. */
export interface RunReport {
  run_id: string;
  profile: string;
  created_at: string;
  gold_path: string;
  db_path: string | null;
  clawmem_version: string | null;
  limit: number;
  min_examples: number;
  /** Operator's attestation that a 10–20% hand-audit of the gold labels passed — the harness records it, it cannot verify it. */
  audit_attested: boolean;
  examples_total: number;
  examples_scored: number;
  aggregate: RunAggregate;
  by_tag: Record<string, RunAggregate & { count: number }>;
  examples: ExampleResult[];
  unresolved_gold: { example_id: string; refs: UnresolvedRef[] }[];
  skipped: { example_id: string; reason: string }[];
  gates: { pass: boolean; reasons: string[] };
}
