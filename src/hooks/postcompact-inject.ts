/**
 * PostCompact inject hook — re-injects ClawMem context after compaction.
 *
 * Fires via SessionStart with matcher "compact". Reads the precompact-state.md
 * file (written by precompact-extract), loads recent decisions from the vault,
 * and injects authoritative context to compensate for summarization losses.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  type HookInput,
  type HookOutput,
  makeContextOutput,
  makeEmptyOutput,
  estimateTokens,
  smartTruncate,
} from "../hooks.ts";
import type { Store } from "../store.ts";
import { extractSnippet } from "../store.ts";
import { sanitizeSnippet } from "../promptguard.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOKEN_BUDGET = 1200;
const PRECOMPACT_STATE_BUDGET = 600;
const DECISIONS_BUDGET = 400;
const VAULT_CONTEXT_BUDGET = 200;

// ---------------------------------------------------------------------------
// Auto-memory path discovery (same logic as precompact-extract)
// ---------------------------------------------------------------------------

function getAutoMemoryDir(transcriptPath?: string): string | null {
  // Derive from transcript_path: ~/.claude/projects/<project-dir>/<session>.jsonl
  if (transcriptPath) {
    const projectDir = resolve(transcriptPath, "..");
    const memDir = join(projectDir, "memory");
    if (existsSync(memDir)) return memDir;
  }

  // Fallback: CWD-based lookup
  const cwd = process.cwd();
  const sanitized = cwd.replace(/\//g, "-").replace(/^-/, "");
  const memDir = join(
    process.env.HOME || "/tmp",
    ".claude",
    "projects",
    sanitized,
    "memory"
  );
  if (existsSync(memDir)) return memDir;

  return null;
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

export async function postcompactInject(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  const sections: string[] = [];
  let totalTokens = 0;

  // Section 1: Precompact state (if available)
  const memDir = getAutoMemoryDir(input.transcriptPath);
  if (memDir) {
    const statePath = join(memDir, "precompact-state.md");
    if (existsSync(statePath)) {
      try {
        let stateContent = readFileSync(statePath, "utf-8").trim();
        const stateTokens = estimateTokens(stateContent);

        if (stateTokens > PRECOMPACT_STATE_BUDGET) {
          stateContent = smartTruncate(stateContent, PRECOMPACT_STATE_BUDGET * 4);
        }

        if (stateContent.length > 0) {
          sections.push(stateContent);
          totalTokens += Math.min(stateTokens, PRECOMPACT_STATE_BUDGET);
        }
      } catch {
        // ignore read errors
      }
    }
  }

  // Section 2: Recent decisions from vault (last 7 days)
  if (totalTokens < MAX_TOKEN_BUDGET) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const recentDocs = store.getDocumentsByType("decision", 5);

      const recentDecisions = recentDocs.filter(
        (d) => d.modifiedAt && d.modifiedAt >= cutoff.toISOString()
      );

      if (recentDecisions.length > 0) {
        const decisionLines: string[] = ["## Recent Decisions (from vault)", ""];

        let budgetLeft = DECISIONS_BUDGET;
        for (const doc of recentDecisions) {
          const line = `- **${doc.title}** (${doc.modifiedAt?.slice(0, 10)})`;
          const lineTokens = estimateTokens(line);
          if (budgetLeft - lineTokens < 0) break;
          decisionLines.push(line);
          budgetLeft -= lineTokens;
        }

        if (decisionLines.length > 2) {
          sections.push(decisionLines.join("\n"));
          totalTokens += DECISIONS_BUDGET - budgetLeft;
        }
      }
    } catch {
      // non-critical
    }
  }

  // Section 2b: Recent antipatterns (last 7 days)
  if (totalTokens < MAX_TOKEN_BUDGET) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const recentAnti = store.getDocumentsByType("antipattern", 3);
      const filteredAnti = recentAnti.filter(
        (d) => d.modifiedAt && d.modifiedAt >= cutoff.toISOString()
      );

      if (filteredAnti.length > 0) {
        const antiLines: string[] = ["## Recent Antipatterns (avoid these)", ""];
        let budgetLeft = 150; // small budget for antipatterns
        for (const doc of filteredAnti) {
          const line = `- **Avoid:** ${doc.title} (${doc.modifiedAt?.slice(0, 10)})`;
          const lineTokens = estimateTokens(line);
          if (budgetLeft - lineTokens < 0) break;
          antiLines.push(line);
          budgetLeft -= lineTokens;
        }
        if (antiLines.length > 2) {
          sections.push(antiLines.join("\n"));
          totalTokens += 150 - budgetLeft;
        }
      }
    } catch {
      // non-critical
    }
  }

  // Section 3: Vault context search (if we have a last request to search for)
  if (totalTokens < MAX_TOKEN_BUDGET && memDir) {
    try {
      const statePath = join(memDir, "precompact-state.md");
      if (existsSync(statePath)) {
        const stateContent = readFileSync(statePath, "utf-8");
        // Extract the last user request from the state file
        const requestMatch = stateContent.match(
          /## Last User Request\n\n([\s\S]*?)(?:\n##|\n$)/
        );
        if (requestMatch?.[1]) {
          const query = requestMatch[1].trim().slice(0, 200);
          if (query.length > 10) {
            const results = store.searchFTS(query, 3);
            if (results.length > 0) {
              const contextLines: string[] = ["## Relevant Vault Context", ""];
              let budgetLeft = VAULT_CONTEXT_BUDGET;

              for (const r of results) {
                const snippet = sanitizeSnippet(extractSnippet(r.body || "", query, 150).snippet);
                const line = `- **${sanitizeSnippet(r.title)}** (${r.displayPath}): ${snippet}`;
                const lineTokens = estimateTokens(line);
                if (budgetLeft - lineTokens < 0) break;
                contextLines.push(line);
                budgetLeft -= lineTokens;
              }

              if (contextLines.length > 2) {
                sections.push(contextLines.join("\n"));
                totalTokens += VAULT_CONTEXT_BUDGET - budgetLeft;
              }
            }
          }
        }
      }
    } catch {
      // non-critical
    }
  }

  // Nothing to inject
  if (sections.length === 0) {
    return makeEmptyOutput("postcompact-inject");
  }

  // Build final output with authoritative framing
  const context = [
    `<vault-postcompact>`,
    `IMPORTANT: Context was just compacted. The following is authoritative`,
    `and takes precedence over any paraphrased version in the compacted summary.`,
    ``,
    sections.join("\n\n---\n\n"),
    `</vault-postcompact>`,
  ].join("\n");

  // Audit trail
  try {
    store.insertUsage({
      sessionId: input.sessionId || "unknown",
      timestamp: new Date().toISOString(),
      hookName: "postcompact-inject",
      injectedPaths: [],
      estimatedTokens: estimateTokens(context),
      wasReferenced: 0,
    });
  } catch {
    // non-critical
  }

  return makeContextOutput("postcompact-inject", context);
}
