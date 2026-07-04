/**
 * Shared anti-parrot guard.
 *
 * A weak local extraction model, run out-of-distribution, may echo the schema example text or
 * template placeholders from its prompt verbatim instead of extracting real content — the confirmed
 * root cause of a failed mining run with the 1.7B model. This guard rejects that residue on output.
 *
 * Extracted from observer.ts so all three extraction paths — observer (Stop-hook observations),
 * consolidation (Phase-3 deductive synthesis), and conversation-synthesis (mining/import) — share
 * one residue check instead of each re-implementing (or omitting) it.
 *
 * Design note on what does NOT belong here: this blocklist holds only strings that no real fact
 * could legitimately be (schema-instruction words, obviously-synthetic skeleton phrases). It must
 * NOT hold plausible real content — an earlier draft rejected any line starting with
 * "example:" / "placeholder:", which false-positived legitimate facts like
 * "Example: QMD switched to Bun in v0.2". The prompts kill the parrot at the source by using
 * {{...}} skeleton tokens (caught generically by PLACEHOLDER_REGEX) rather than copyable
 * real-looking examples, so this blocklist stays narrow.
 */

// Exact placeholder strings that must never be persisted as facts, titles, or triple components.
// Defense-in-depth: even though prompts now use structure-only skeletons (no copyable example
// content), a weak model could still echo these phrases from the schema description itself.
export const SCHEMA_PLACEHOLDER_STRINGS = new Set([
  // observer.ts schema-instruction residue
  "individual atomic fact",
  "atomic fact",
  "one atomic claim per fact element",
  "brief descriptive title",
  "canonical entity name",
  // consolidation.ts deductive-skeleton residue (former copyable example — safe to blocklist
  // because no genuine deduction is literally "clear deductive statement" / "premise from obs N")
  "clear deductive statement",
  "premise from obs 1",
  "premise from obs 3",
]);

// Regex for template placeholder markers: {{...}}, <!--...-->, ${...}.
// Intentionally narrow — earlier drafts rejected any line starting with
// "example:" / "placeholder:", which false-positived legitimate facts like
// "Example: QMD switched to Bun in v0.2". Shape-only matching avoids that
// drift; the exact-string blocklist above handles known echoed placeholders.
export const PLACEHOLDER_REGEX = /^(\{\{.*\}\}|<!--.*-->|\$\{.*\})/;

/**
 * True when `text` is empty, a known schema-placeholder string, or a template marker — i.e.
 * residue a model echoed from its prompt rather than real extracted content.
 */
export function isSchemaPlaceholder(text: string): boolean {
  if (!text) return true;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true; // whitespace-only is effectively empty content
  if (SCHEMA_PLACEHOLDER_STRINGS.has(normalized)) return true;
  if (PLACEHOLDER_REGEX.test(normalized)) return true;
  return false;
}
