/**
 * Curator Nudge Hook - SessionStart
 *
 * Reads the curator report JSON and surfaces actionable items.
 * If the report is stale (>7 days), nudges to run curator.
 * Budget: ~200 tokens. Fail-open.
 */

import { resolve as pathResolve } from "path";
import { existsSync, readFileSync } from "fs";
import type { Store } from "../store.ts";
import type { HookInput, HookOutput } from "../hooks.ts";
import {
  makeContextOutput,
  makeEmptyOutput,
  estimateTokens,
  logInjection,
} from "../hooks.ts";

const MAX_TOKEN_BUDGET = 200;
const STALE_DAYS = 7;
const REPORT_PATH = pathResolve(process.env.HOME || "~", ".cache", "clawmem", "curator-report.json");

interface CuratorReport {
  timestamp: string;
  actions: string[];
  health: { active: number; embeddingBacklog: number; infrastructure: string };
  sweep: { candidates: number };
  consolidation: { candidates: number };
}

export async function curatorNudge(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  if (!existsSync(REPORT_PATH)) {
    // No report yet — nudge to run curator
    return makeContextOutput(
      "curator-nudge",
      `<vault-curator>\nCurator has never run. Consider: \`clawmem curate\` or "run curator" agent.\n</vault-curator>`
    );
  }

  let report: CuratorReport;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, "utf-8"));
  } catch {
    return makeEmptyOutput("curator-nudge");
  }

  const reportAge = Date.now() - new Date(report.timestamp).getTime();
  const reportDays = Math.floor(reportAge / (86400 * 1000));

  // If report is stale, just nudge
  if (reportDays > STALE_DAYS) {
    return makeContextOutput(
      "curator-nudge",
      `<vault-curator>\nCurator report is ${reportDays}d old. Consider: \`clawmem curate\` or "run curator" agent.\n</vault-curator>`
    );
  }

  // If no actions, stay silent
  if (!report.actions || report.actions.length === 0) {
    return makeEmptyOutput("curator-nudge");
  }

  // Build compact action summary within budget
  const lines = [`**Curator (${report.timestamp.slice(0, 10)}):**`];
  let tokens = estimateTokens(lines[0]!);

  for (const action of report.actions) {
    const line = `- ${action}`;
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > MAX_TOKEN_BUDGET && lines.length > 1) break;
    lines.push(line);
    tokens += lineTokens;
  }

  if (lines.length <= 1) return makeEmptyOutput("curator-nudge");

  if (input.sessionId) {
    logInjection(store, input.sessionId, "curator-nudge", [], tokens);
  }

  return makeContextOutput(
    "curator-nudge",
    `<vault-curator>\n${lines.join("\n")}\n</vault-curator>`
  );
}
