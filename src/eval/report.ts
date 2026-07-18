/**
 * Offline eval harness — run.json assembly + report.md rendering (HORMA-1).
 *
 * The gates here are the LABELED-SET TRUST gate only: enough resolved examples
 * (default 30 = feature-specific smoke floor; 80+ = trustworthy global number),
 * zero unresolved evidence refs, and the operator's 10–20% label-audit
 * attestation (recorded, not verifiable). Comparative feature gates
 * (CCG-1/CCG-3, §6.2/§16.2 thresholds) are computed BETWEEN runs, not inside
 * one — they arrive with the A/B follow-on, reading two run.json artifacts.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { mean, p95 } from "./metrics.ts";
import type { ExampleResult, RunAggregate, RunReport, UnresolvedRef } from "./types.ts";

function aggregate(examples: ExampleResult[]): RunAggregate {
  return {
    jaccard_mean: mean(examples.map(e => e.metrics.jaccard)),
    recall_mean: mean(examples.map(e => e.metrics.recall)),
    precision_mean: mean(examples.map(e => e.metrics.precision)),
    hit_at_k: mean(examples.map(e => e.metrics.hit)),
    mrr: mean(examples.map(e => e.metrics.mrr)),
    // Token axis is the context-profile replay's (buildContext reports tokens);
    // the query profile has no honest token measure, so these stay null.
    tokens_mean: null,
    recall_per_1k_tokens: null,
    elapsed_ms_p95: p95(examples.map(e => e.elapsed_ms)),
  };
}

export interface BuildReportInput {
  runId: string;
  profile: string;
  createdAt: string;
  goldPath: string;
  dbPath: string | null;
  clawmemVersion: string | null;
  limit: number;
  minExamples: number;
  auditAttested: boolean;
  examplesTotal: number;
  scored: ExampleResult[];
  unresolvedGold: { example_id: string; refs: UnresolvedRef[] }[];
  skipped: { example_id: string; reason: string }[];
}

export function buildRunReport(input: BuildReportInput): RunReport {
  const byTag: RunReport["by_tag"] = {};
  const tagMap = new Map<string, ExampleResult[]>();
  for (const ex of input.scored) {
    for (const tag of ex.tags) {
      const list = tagMap.get(tag) ?? [];
      list.push(ex);
      tagMap.set(tag, list);
    }
  }
  for (const [tag, list] of [...tagMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byTag[tag] = { ...aggregate(list), count: list.length };
  }

  const gateReasons: string[] = [];
  if (input.scored.length < input.minExamples) {
    gateReasons.push(`examples_scored ${input.scored.length} < min_examples ${input.minExamples}`);
  }
  if (input.unresolvedGold.length > 0) {
    const refCount = input.unresolvedGold.reduce((n, u) => n + u.refs.length, 0);
    gateReasons.push(`${refCount} unresolved gold evidence ref${refCount === 1 ? "" : "s"} across ${input.unresolvedGold.length} example${input.unresolvedGold.length === 1 ? "" : "s"}`);
  }
  if (!input.auditAttested) {
    gateReasons.push("operator label audit (10-20%) not attested — pass --audited after hand-auditing the gold set");
  }

  return {
    run_id: input.runId,
    profile: input.profile,
    created_at: input.createdAt,
    gold_path: input.goldPath,
    db_path: input.dbPath,
    clawmem_version: input.clawmemVersion,
    limit: input.limit,
    min_examples: input.minExamples,
    audit_attested: input.auditAttested,
    examples_total: input.examplesTotal,
    examples_scored: input.scored.length,
    aggregate: aggregate(input.scored),
    by_tag: byTag,
    examples: input.scored,
    unresolved_gold: input.unresolvedGold,
    skipped: input.skipped,
    gates: { pass: gateReasons.length === 0, reasons: gateReasons },
  };
}

const fmt = (v: number | null, digits = 3): string => (v === null ? "—" : v.toFixed(digits));

/** Human-readable companion to run.json — the artifact an operator hand-audits. */
export function renderReportMd(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# ClawMem eval run \`${report.run_id}\``);
  lines.push("");
  lines.push(`- profile: \`${report.profile}\` · limit (k): ${report.limit} · clawmem ${report.clawmem_version ?? "unknown"}`);
  lines.push(`- gold: \`${report.gold_path}\` · db: \`${report.db_path ?? "default"}\``);
  lines.push(`- examples: ${report.examples_scored} scored / ${report.examples_total} total (${report.skipped.length} skipped, ${report.unresolved_gold.length} unresolved) · label audit ${report.audit_attested ? "attested" : "NOT attested"}`);
  lines.push(`- gates: **${report.gates.pass ? "PASS" : "FAIL"}**${report.gates.reasons.length ? ` — ${report.gates.reasons.join("; ")}` : ""}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| J_doc | recall@k | precision@k | hit@k | MRR | p95 ms |");
  lines.push("|---|---|---|---|---|---|");
  const a = report.aggregate;
  lines.push(`| ${fmt(a.jaccard_mean)} | ${fmt(a.recall_mean)} | ${fmt(a.precision_mean)} | ${fmt(a.hit_at_k)} | ${fmt(a.mrr)} | ${fmt(a.elapsed_ms_p95, 0)} |`);
  lines.push("");

  const tags = Object.keys(report.by_tag);
  if (tags.length > 0) {
    lines.push("## By tag");
    lines.push("");
    lines.push("| tag | n | J_doc | recall@k | precision@k | hit@k | MRR |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const tag of tags) {
      const t = report.by_tag[tag]!;
      lines.push(`| ${tag} | ${t.count} | ${fmt(t.jaccard_mean)} | ${fmt(t.recall_mean)} | ${fmt(t.precision_mean)} | ${fmt(t.hit_at_k)} | ${fmt(t.mrr)} |`);
    }
    lines.push("");
  }

  lines.push("## Examples");
  lines.push("");
  lines.push("| id | J_doc | recall | precision | hit | MRR | ms | retrieved | gold |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const ex of report.examples) {
    const m = ex.metrics;
    lines.push(`| ${ex.id} | ${fmt(m.jaccard)} | ${fmt(m.recall)} | ${fmt(m.precision)} | ${m.hit} | ${fmt(m.mrr)} | ${Math.round(ex.elapsed_ms)} | ${ex.retrieved.length} | ${ex.gold.length} |`);
  }
  lines.push("");

  if (report.unresolved_gold.length > 0) {
    lines.push("## Unresolved gold (excluded from scoring)");
    lines.push("");
    for (const u of report.unresolved_gold) {
      for (const ref of u.refs) {
        lines.push(`- \`${u.example_id}\` → ${ref.collection}/${ref.path} — ${ref.reason}`);
      }
    }
    lines.push("");
  }

  if (report.skipped.length > 0) {
    lines.push("## Skipped");
    lines.push("");
    for (const s of report.skipped) lines.push(`- \`${s.example_id}\` — ${s.reason}`);
    lines.push("");
  }

  const warned = report.examples.filter(e => e.warnings.length > 0);
  if (warned.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const ex of warned) for (const w of ex.warnings) lines.push(`- \`${ex.id}\` — ${w}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Write run.json + report.md into outDir (created if absent). Returns the file paths. */
export function writeRunArtifacts(outDir: string, report: RunReport): { runJsonPath: string; reportMdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const runJsonPath = join(outDir, "run.json");
  const reportMdPath = join(outDir, "report.md");
  writeFileSync(runJsonPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(reportMdPath, renderReportMd(report));
  return { runJsonPath, reportMdPath };
}
