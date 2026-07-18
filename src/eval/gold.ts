/**
 * Offline eval harness — gold JSONL loading + resolution (HORMA-1).
 *
 * Parsing is STRICT: any malformed line, schema violation, or duplicate id is
 * a hard error — a silently dropped example would corrupt the metric the
 * harness exists to make trustworthy. Resolution is also strict per example:
 * an example with ANY unresolved evidence ref is excluded from scoring
 * (partial gold would silently inflate recall) and fails the run's trust gate.
 */

import { readFileSync } from "fs";
import { z } from "zod";
import type { Store } from "../store.ts";
import type { GoldExample, ResolvedExample, UnresolvedRef } from "./types.ts";

// Strict objects: an unknown key is a hard error, never silently stripped — a
// typo like `includeInternal` would otherwise be dropped and the example would
// silently evaluate a different route than the labeler intended.
const goldEvidenceSchema = z.strictObject({
  collection: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().nullish(),
  chunk_seq: z.number().int().nullish(),
  weight: z.number().nullish(),
  span: z.strictObject({ start_line: z.number().int(), end_line: z.number().int() }).nullish(),
});

const goldExampleSchema = z.strictObject({
  id: z.string().min(1),
  query: z.string().min(1),
  mode: z.enum(["query", "intent_search", "context", "raw", "structured"]).optional().default("query"),
  force_intent: z.string().optional(),
  budget_tokens: z.number().int().positive().optional(),
  include_internal: z.boolean().optional().default(false),
  collection: z.string().optional(),
  gold_evidence: z.array(goldEvidenceSchema).min(1),
  gold_answer: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
});

export interface GoldParseError {
  line: number;
  message: string;
}

/** Thrown when a gold file fails strict parsing. `errors` carries per-line detail. */
export class GoldFileError extends Error {
  readonly errors: GoldParseError[];
  constructor(goldPath: string, errors: GoldParseError[]) {
    super(
      `Gold file ${goldPath} failed validation (${errors.length} error${errors.length === 1 ? "" : "s"}):\n` +
      errors.map(e => `  line ${e.line}: ${e.message}`).join("\n")
    );
    this.name = "GoldFileError";
    this.errors = errors;
  }
}

/**
 * Parse a gold JSONL file. Blank lines are skipped; everything else must be a
 * valid gold example. Throws GoldFileError on any parse/schema/duplicate-id error.
 */
export function parseGoldFile(goldPath: string): GoldExample[] {
  const raw = readFileSync(goldPath, "utf8");
  const lines = raw.split("\n");
  const examples: GoldExample[] = [];
  const errors: GoldParseError[] = [];
  const seenIds = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.trim();
    if (line.length === 0) continue;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (e) {
      errors.push({ line: lineNo, message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const parsed = goldExampleSchema.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(iss => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ");
      errors.push({ line: lineNo, message: detail });
      continue;
    }

    const prior = seenIds.get(parsed.data.id);
    if (prior !== undefined) {
      errors.push({ line: lineNo, message: `duplicate example id "${parsed.data.id}" (first seen on line ${prior})` });
      continue;
    }
    seenIds.set(parsed.data.id, lineNo);
    // Dedupe tags so a repeated tag cannot double-count the example in by_tag.
    examples.push({ ...parsed.data, tags: [...new Set(parsed.data.tags)] });
  }

  if (errors.length > 0) throw new GoldFileError(goldPath, errors);
  return examples;
}

/**
 * Resolve every evidence ref against active documents. A ref resolves only to
 * an ACTIVE, non-invalidated document — an archived/invalidated doc cannot be
 * retrieved, so a label pointing at one is stale, not a retrieval failure.
 * A gold `hash` pin that mismatches the live document resolves WITH a warning
 * (the doc identity holds; the labeled content may have drifted).
 */
export function resolveGoldExamples(store: Store, examples: GoldExample[]): ResolvedExample[] {
  const lookup = store.db.prepare(
    `SELECT id, hash FROM documents WHERE collection = ? AND path = ? AND active = 1 AND invalidated_at IS NULL LIMIT 1`
  );

  return examples.map(example => {
    const goldDocIds: number[] = [];
    const goldDocs: { docId: number; path: string }[] = [];
    const unresolved: UnresolvedRef[] = [];
    const warnings: string[] = [];
    const seen = new Set<number>();

    for (const ref of example.gold_evidence) {
      const row = lookup.get(ref.collection, ref.path) as { id: number; hash: string } | undefined;
      if (!row) {
        unresolved.push({ collection: ref.collection, path: ref.path, reason: "no active document at collection/path" });
        continue;
      }
      if (ref.hash && ref.hash !== row.hash) {
        warnings.push(`gold hash pin for ${ref.collection}/${ref.path} does not match the live document — label may be stale`);
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        goldDocIds.push(row.id);
        goldDocs.push({ docId: row.id, path: `${ref.collection}/${ref.path}` });
      }
    }

    return { example, goldDocIds, goldDocs, unresolved, warnings };
  });
}
