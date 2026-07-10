/**
 * Read-only query-template A/B evaluator (VSEARCH-TRUST-HARDENING (e) Phase 1).
 *
 * Measures where a set of known-target queries rank their targets under three
 * query-side formatter variants, against the LIVE index, WITHOUT writing anything:
 *
 *   query-template : formatQueryForEmbedding(q)      (production behavior)
 *   doc-template   : formatDocForEmbedding(q)        (symmetric-with-docs variant)
 *   raw            : q                               (no template)
 *
 * A query-side-only template change requires NO re-embed — only formatQueryForEmbedding
 * is involved — so a dominant variant here is a cheap retrieval win. Doc-side changes
 * (Phase 2) force a full re-embed and are NOT evaluated here.
 *
 * The evaluator goes through searchVecDetailedWithVector, which runs the SAME shared
 * query-vector compatibility guard as production (model consistency + dimension), with
 * endpointModel taken from the actual embed response (T3-M2 / T4-M4).
 *
 * Usage:
 *   bun scripts/eval-query-template.ts --queries eval-queries.json [--limit 100] [--db PATH]
 *
 * eval-queries.json: [{ "query": "...", "target": "substring of the target displayPath" }, ...]
 * Exit code: 0 (report only). Prints per-query ranks and a per-variant summary.
 */
import { parseArgs } from "util";
import { readFileSync } from "fs";
import { createStore, searchVecDetailedWithVector, type VecSearchDetailedOpts } from "../src/store.ts";
import { getDefaultLlamaCpp, formatQueryForEmbedding, formatDocForEmbedding } from "../src/llm.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    queries: { type: "string" },
    limit: { type: "string", default: "100" },
    db: { type: "string" },
    includeInternal: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.queries) {
  console.error("Usage: bun scripts/eval-query-template.ts --queries eval-queries.json [--limit 100] [--db PATH] [--includeInternal]");
  console.error('  eval-queries.json: [{ "query": "...", "target": "displayPath substring" }, ...]');
  process.exit(2);
}

type EvalCase = { query: string; target: string };
const cases = JSON.parse(readFileSync(values.queries, "utf8")) as EvalCase[];
if (!Array.isArray(cases) || cases.length === 0) {
  console.error("No eval cases in the queries file.");
  process.exit(2);
}

const store = createStore(values.db || undefined, { readonly: true }); // read-only by construction — the evaluator can not write
const llm = getDefaultLlamaCpp();
const limit = parseInt(values.limit || "100", 10);
const opts: VecSearchDetailedOpts = values.includeInternal ? {} : { excludeCollections: ["_clawmem"] };

const VARIANTS: { name: string; format: (q: string) => string }[] = [
  { name: "query-template", format: q => formatQueryForEmbedding(q) },
  { name: "doc-template", format: q => formatDocForEmbedding(q) },
  { name: "raw", format: q => q },
];

function rankOf(results: { displayPath: string }[], target: string): number | null {
  const idx = results.findIndex(r => r.displayPath.includes(target));
  return idx >= 0 ? idx + 1 : null;
}

const summary: Record<string, { found: number; mrr: number; ranks: (number | null)[] }> = {};
for (const v of VARIANTS) summary[v.name] = { found: 0, mrr: 0, ranks: [] };

for (const evalCase of cases) {
  const line: string[] = [`"${evalCase.query.slice(0, 60)}" → ${evalCase.target}`];
  for (const variant of VARIANTS) {
    const embedded = await llm.embed(variant.format(evalCase.query));
    if (!embedded) {
      line.push(`${variant.name}: EMBED-FAIL`);
      summary[variant.name]!.ranks.push(null);
      continue;
    }
    const det = searchVecDetailedWithVector(
      store.db,
      { embedding: embedded.embedding instanceof Float32Array ? embedded.embedding : new Float32Array(embedded.embedding), endpointModel: embedded.model ?? "" },
      limit,
      opts
    );
    const rank = rankOf(det.results, evalCase.target);
    summary[variant.name]!.ranks.push(rank);
    if (rank !== null) {
      summary[variant.name]!.found++;
      summary[variant.name]!.mrr += 1 / rank;
    }
    line.push(`${variant.name}: ${rank !== null ? `#${rank}` : `>${limit}`}${det.degraded ? ` (degraded:${det.degradedReason})` : ""}`);
  }
  console.log(line.join("  |  "));
}

console.log("\n=== summary ===");
for (const v of VARIANTS) {
  const s = summary[v.name]!;
  console.log(`${v.name.padEnd(16)} found ${s.found}/${cases.length} in top-${limit}, MRR ${(s.mrr / cases.length).toFixed(4)}`);
}
store.close();
