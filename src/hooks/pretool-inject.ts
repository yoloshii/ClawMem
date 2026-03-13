/**
 * PreToolUse inject hook — injects file-specific vault context before Read/Edit/Write.
 *
 * Fires via PreToolUse with matcher "Read|Edit|Write". Searches the vault for
 * context related to the target file path and injects relevant decisions,
 * antipatterns, and notes about that specific file.
 */

import type { Store } from "../store.ts";
import { extractSnippet } from "../store.ts";
import { sanitizeSnippet } from "../promptguard.ts";
import {
  type HookInput,
  type HookOutput,
  makeEmptyOutput,
  estimateTokens,
} from "../hooks.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOKEN_BUDGET = 200;
const MAX_RESULTS = 3;

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

export async function pretoolInject(
  store: Store,
  input: HookInput
): Promise<HookOutput> {
  // Extract file_path from tool input
  const toolInput = input.toolInput as { file_path?: string } | undefined;
  if (!toolInput?.file_path) return makeEmptyOutput("pretool-inject");

  const filePath = toolInput.file_path;

  // Skip very short paths or non-file paths
  if (filePath.length < 5) return makeEmptyOutput("pretool-inject");

  // Search vault for context about this specific file
  let results;
  try {
    results = store.searchFTS(filePath, MAX_RESULTS);
  } catch {
    return makeEmptyOutput("pretool-inject");
  }

  if (!results || results.length === 0) return makeEmptyOutput("pretool-inject");

  // Build compact context within budget
  const lines: string[] = [];
  let totalTokens = 0;

  for (const r of results) {
    if (totalTokens >= MAX_TOKEN_BUDGET) break;

    const snippet = sanitizeSnippet(extractSnippet(r.body || "", filePath, 100).snippet);
    const line = `- **${sanitizeSnippet(r.title)}**: ${snippet}`;
    const lineTokens = estimateTokens(line);

    if (totalTokens + lineTokens > MAX_TOKEN_BUDGET && lines.length > 0) break;
    lines.push(line);
    totalTokens += lineTokens;
  }

  if (lines.length === 0) return makeEmptyOutput("pretool-inject");

  // PreToolUse hooks cannot inject additionalContext (only UserPromptSubmit can).
  // Use the `reason` field to surface file-specific vault context.
  const context = lines.join("\n");
  return {
    continue: true,
    suppressOutput: false,
    reason: `vault-file-context: ${context}`,
  };
}
