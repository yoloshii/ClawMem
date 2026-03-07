/**
 * Retrieval Gate — Adaptive prompt filtering for context-surfacing
 *
 * Determines whether a prompt warrants memory retrieval. Skips greetings,
 * shell commands, affirmations, pure emoji, and system pings. Forces
 * retrieval for memory-intent queries even if short.
 *
 * Ported from memory-lancedb-pro's adaptive-retrieval.ts + noise-filter.ts,
 * complementing ClawMem's existing short-prompt, slash-command, heartbeat,
 * and dedupe gates in context-surfacing.
 */

// Prompts that should skip retrieval entirely
const SKIP_PATTERNS = [
  // Greetings & pleasantries
  /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|greetings|yo|sup|howdy|what'?s up)\b/i,
  // Shell/dev commands (slash commands handled separately in context-surfacing)
  /^(run|build|test|ls|cd|git|npm|pip|docker|curl|cat|grep|find|make|sudo|bun|node|deno)\b/i,
  // Simple affirmations/negations
  /^(yes|no|yep|nope|ok|okay|sure|fine|thanks|thank you|thx|ty|got it|understood|cool|nice|great|good|perfect|awesome)\s*[.!]?$/i,
  // Continuation prompts
  /^(go ahead|continue|proceed|do it|start|begin|next)\s*[.!]?$/i,
  // Pure emoji
  /^[\p{Emoji}\s]+$/u,
  // Single-word utility pings
  /^(ping|pong|test|debug)\s*[.!?]?$/i,
];

// Prompts that MUST trigger retrieval even if short (checked before skip)
const FORCE_RETRIEVE_PATTERNS = [
  /\b(remember|recall|forgot|memory|memories)\b/i,
  /\b(last time|before|previously|earlier|yesterday|ago)\b/i,
  /\b(my (name|email|phone|address|birthday|preference))\b/i,
  /\b(what did (i|we)|did i (tell|say|mention))\b/i,
];

/**
 * Normalize OpenClaw-injected metadata from prompts.
 * Strips cron wrappers, timestamp prefixes, and conversation metadata.
 */
function normalizePrompt(prompt: string): string {
  let s = prompt.trim();
  // Strip OpenClaw metadata headers
  s = s.replace(/^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim, "");
  // Strip cron wrapper prefix
  s = s.trim().replace(/^\[cron:[^\]]+\]\s*/i, "");
  // Strip timestamp prefix
  s = s.trim().replace(/^\[[A-Za-z]{3}\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}\s[^\]]+\]\s*/, "");
  return s.trim();
}

/**
 * Check if a prompt should skip memory retrieval.
 * Returns true if retrieval should be skipped.
 *
 * This complements (does NOT replace) existing gates in context-surfacing:
 * - MIN_PROMPT_LENGTH (<20 chars)
 * - Slash commands (starts with /)
 * - Heartbeat suppression
 * - Duplicate prompt dedupe
 */
export function shouldSkipRetrieval(prompt: string): boolean {
  const trimmed = normalizePrompt(prompt);

  // Force retrieve if query has memory-related intent (before length/pattern checks)
  if (FORCE_RETRIEVE_PATTERNS.some(p => p.test(trimmed))) return false;

  // Too short to be meaningful (below context-surfacing's MIN_PROMPT_LENGTH)
  if (trimmed.length < 5) return true;

  // Skip if matches any skip pattern
  if (SKIP_PATTERNS.some(p => p.test(trimmed))) return true;

  // Skip very short non-question messages
  // CJK characters carry more meaning per character — lower threshold
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(trimmed);
  const minLength = hasCJK ? 6 : 15;
  if (trimmed.length < minLength && !trimmed.includes('?') && !trimmed.includes('\uff1f')) return true;

  return false;
}

// =============================================================================
// Noise Filter — Post-retrieval result filtering
// =============================================================================

// Agent denial patterns (filter from retrieved results)
const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /i don'?t remember/i,
  /no (relevant )?memories found/i,
  /i don'?t have access to/i,
];

/**
 * Check if a retrieved memory snippet is noise that should be filtered.
 * Use on search results before injection, NOT on indexed documents.
 */
export function isRetrievedNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return true;
  if (DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;
  return false;
}
