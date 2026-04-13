/**
 * Local Observer Agent - Structured observation extraction using local GGUF model
 *
 * Uses Qwen3-1.7B (already loaded for query expansion) with XML-formatted prompts
 * to extract structured observations and session summaries from transcripts.
 * Falls back gracefully when model is unavailable.
 */

import type { TranscriptMessage } from "./hooks.ts";
import { getDefaultLlamaCpp } from "./llm.ts";
import { MAX_LLM_GENERATE_TIMEOUT_MS } from "./limits.ts";

// =============================================================================
// Types
// =============================================================================

export type Observation = {
  type: "decision" | "bugfix" | "feature" | "refactor" | "discovery" | "change" | "preference" | "milestone" | "problem";
  title: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  triples?: ParsedTriple[];
};

export type ParsedTriple = {
  subject: string;
  predicate: string;
  object: string;
};

export type SessionSummary = {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
};

// =============================================================================
// Config
// =============================================================================

const MAX_TRANSCRIPT_MESSAGES = 100;
const MAX_USER_MSG_CHARS = 200;
const MAX_ASSISTANT_MSG_CHARS = 500;
const MAX_TRANSCRIPT_TOKENS = 2000;
const GENERATION_MAX_TOKENS = 2000;
const GENERATION_TEMPERATURE = 0.3;

// =============================================================================
// System Prompts
// =============================================================================

const OBSERVATION_SYSTEM_PROMPT = `You are an observer analyzing a coding session transcript. Extract structured observations.
For each significant action, decision, or discovery, output an <observation> XML element with the structure below.

Structure:
<observation>
  <type>...</type>
  <title>...</title>
  <facts>
    <fact>...</fact>
  </facts>
  <triples>
    <triple>
      <subject>...</subject>
      <predicate>...</predicate>
      <object>...</object>
    </triple>
  </triples>
  <narrative>...</narrative>
  <concepts>
    <concept>...</concept>
  </concepts>
  <files_read><file>...</file></files_read>
  <files_modified><file>...</file></files_modified>
</observation>

Field rules:
- <type>: one of decision, bugfix, feature, refactor, discovery, change, preference, milestone, problem
- <title>: brief descriptive title, max 80 chars
- <facts>: 1-5 <fact> elements, each a standalone atomic claim about what happened or what is true (concrete, specific, no schema placeholders or template text)
- <triples>: 0-3 <triple> elements for structural relationships between named entities (see predicate vocabulary below). Omit entirely if no relational claims apply. Do NOT emit triples for descriptive facts — only for explicit S-P-O relations.
- <narrative>: 2-3 sentences explaining WHY something was done, not just WHAT
- <concepts>: 0-3 <concept> elements from: how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off
- <files_read>, <files_modified>: only files explicitly mentioned in the transcript

Predicate vocabulary (use EXACTLY these predicates in <predicate>, nothing else):
- adopted, migrated_to — switching to a new tool/framework/approach
- deployed_to, runs_on — where something runs
- replaced — when one thing supersedes another
- depends_on, integrates_with, uses — structural dependencies
- prefers, avoids — user preferences (use for <subject>user</subject>)
- caused_by, resolved_by — causal relationships between problems and fixes
- owned_by — responsibility / ownership

<subject> and <object> must be short canonical entity names (2-80 chars). No sentences. No placeholder text. If you cannot fit a claim into this vocabulary, keep it in <facts> instead and omit the triple.

Observation rules:
- Output 1-5 observations, focusing on the MOST significant events
- If no significant observations, output nothing
- Never use schema example text or template placeholders in <fact>, <subject>, or <object> — emit only real content extracted from the transcript

Type guidance:
- preference: user expresses a preference, habit, or way of working (e.g., "don't use subagents for this", "I prefer single PRs")
- milestone: significant completion point, version release, deployment, or phase transition
- problem: persistent issue, recurring bug, architectural limitation, or unresolved blocker`;

const SUMMARY_SYSTEM_PROMPT = `You are a session summarizer. Analyze this coding session transcript and output a structured summary.

<summary>
  <request>What the user originally asked for (1-2 sentences)</request>
  <investigated>What was explored or researched (1-2 sentences)</investigated>
  <learned>Key insights or discoveries (1-2 sentences)</learned>
  <completed>What was actually accomplished (1-2 sentences)</completed>
  <next_steps>What should happen next (1-2 sentences)</next_steps>
</summary>

Rules:
- Be concise and specific
- Focus on outcomes, not process
- If a section has nothing relevant, write "None"`;

// =============================================================================
// Transcript Preparation
// =============================================================================

function prepareTranscript(messages: TranscriptMessage[]): string {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines: string[] = [];
  let charCount = 0;
  const charBudget = MAX_TRANSCRIPT_TOKENS * 4; // ~4 chars per token

  for (const msg of recent) {
    if (charCount >= charBudget) break;

    const maxChars = msg.role === "user" ? MAX_USER_MSG_CHARS : MAX_ASSISTANT_MSG_CHARS;
    const content = msg.content.length > maxChars
      ? msg.content.slice(0, maxChars) + "..."
      : msg.content;

    const line = `[${msg.role}]: ${content}`;
    lines.push(line);
    charCount += line.length;
  }

  return lines.join("\n");
}

// =============================================================================
// XML Parsers
// =============================================================================

const VALID_OBSERVATION_TYPES = new Set([
  "decision", "bugfix", "feature", "refactor", "discovery", "change",
  "preference", "milestone", "problem",
]);

const VALID_CONCEPTS = new Set([
  "how-it-works", "why-it-exists", "what-changed", "problem-solution",
  "gotcha", "pattern", "trade-off",
]);

// Canonical SPO predicate vocabulary — parser rejects anything outside this set.
// Must stay in sync with the predicate list in OBSERVATION_SYSTEM_PROMPT.
export const VALID_PREDICATES = new Set([
  "adopted", "migrated_to",
  "deployed_to", "runs_on",
  "replaced",
  "depends_on", "integrates_with", "uses",
  "prefers", "avoids",
  "caused_by", "resolved_by",
  "owned_by",
]);

// Predicates whose <object> should be stored as a literal (not resolved to an entity).
export const LITERAL_PREDICATES = new Set(["prefers", "avoids"]);

// Exact placeholder strings that must never be persisted as facts or triple components.
// Defense-in-depth: even though the prompt no longer places example text inside
// <fact>/<subject>/<object> tags, a weak model could still echo these phrases.
const SCHEMA_PLACEHOLDER_STRINGS = new Set([
  "individual atomic fact",
  "atomic fact",
  "one atomic claim per fact element",
  "brief descriptive title",
  "canonical entity name",
]);

// Regex for template placeholder markers: {{...}}, <!--...-->, ${...}.
// Intentionally narrow — earlier drafts rejected any line starting with
// "example:" / "placeholder:", which false-positived legitimate facts like
// "Example: QMD switched to Bun in v0.2". Shape-only matching avoids that
// drift; the exact-string blocklist above handles known echoed placeholders.
const PLACEHOLDER_REGEX = /^(\{\{.*\}\}|<!--.*-->|\$\{.*\})/;

function isSchemaPlaceholder(text: string): boolean {
  if (!text) return true;
  const normalized = text.trim().toLowerCase();
  if (SCHEMA_PLACEHOLDER_STRINGS.has(normalized)) return true;
  if (PLACEHOLDER_REGEX.test(normalized)) return true;
  return false;
}

export function parseObservationXml(xml: string): Observation | null {
  const typeMatch = xml.match(/<type>\s*(.*?)\s*<\/type>/s);
  const titleMatch = xml.match(/<title>\s*(.*?)\s*<\/title>/s);
  const narrativeMatch = xml.match(/<narrative>\s*(.*?)\s*<\/narrative>/s);

  if (!typeMatch?.[1] || !titleMatch?.[1]) return null;

  const type = typeMatch[1].trim().toLowerCase();
  if (!VALID_OBSERVATION_TYPES.has(type)) return null;

  const rawTitle = titleMatch[1].trim();
  if (isSchemaPlaceholder(rawTitle)) return null;

  const facts = extractMultiple(xml, "fact")
    .filter(f => f.length >= 5)
    .filter(f => !isSchemaPlaceholder(f));

  const concepts = extractMultiple(xml, "concept")
    .filter(c => VALID_CONCEPTS.has(c.toLowerCase()))
    .map(c => c.toLowerCase());
  const filesRead = extractMultiple(xml, "file", "files_read");
  const filesModified = extractMultiple(xml, "file", "files_modified");

  // Parse triples (Fix A): strict validation against canonical predicate vocabulary.
  // Missing/malformed triples are silently dropped — fail-closed on ambiguity.
  const triples = extractTriples(xml);

  return {
    type: type as Observation["type"],
    title: rawTitle.slice(0, 80),
    facts,
    narrative: narrativeMatch?.[1]?.trim() || "",
    concepts,
    filesRead,
    filesModified,
    triples: triples.length > 0 ? triples : undefined,
  };
}

function extractTriples(xml: string): ParsedTriple[] {
  const parentMatch = xml.match(/<triples>([\s\S]*?)<\/triples>/s);
  if (!parentMatch?.[1]) return [];

  const blockRegex = /<triple>([\s\S]*?)<\/triple>/g;
  const results: ParsedTriple[] = [];
  let match;
  while ((match = blockRegex.exec(parentMatch[1])) !== null) {
    const block = match[1] ?? "";
    const subject = block.match(/<subject>\s*(.*?)\s*<\/subject>/s)?.[1]?.trim();
    const rawPredicate = block.match(/<predicate>\s*(.*?)\s*<\/predicate>/s)?.[1]?.trim();
    const object = block.match(/<object>\s*(.*?)\s*<\/object>/s)?.[1]?.trim();

    if (!subject || !rawPredicate || !object) continue;

    const predicate = rawPredicate.toLowerCase().replace(/\s+/g, "_");
    if (!VALID_PREDICATES.has(predicate)) continue;

    // Length bounds — guards against sentence-shaped subjects/objects that the
    // regex-era tests expected. Subject and object should be short canonical names.
    if (subject.length < 2 || subject.length > 80) continue;
    if (object.length < 2 || object.length > 120) continue;

    if (isSchemaPlaceholder(subject) || isSchemaPlaceholder(object)) continue;

    results.push({ subject, predicate, object });

    if (results.length >= 5) break; // cap per observation
  }
  return results;
}

export function parseSummaryXml(xml: string): SessionSummary | null {
  const request = extractSingle(xml, "request");
  const investigated = extractSingle(xml, "investigated");
  const learned = extractSingle(xml, "learned");
  const completed = extractSingle(xml, "completed");
  const nextSteps = extractSingle(xml, "next_steps");

  if (!request && !completed) return null;

  return {
    request: request || "Unknown",
    investigated: investigated || "None",
    learned: learned || "None",
    completed: completed || "None",
    nextSteps: nextSteps || "None",
  };
}

function extractSingle(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, "s"));
  return match?.[1]?.trim() || null;
}

function extractMultiple(xml: string, tag: string, parentTag?: string): string[] {
  let scope = xml;
  if (parentTag) {
    const parentMatch = xml.match(new RegExp(`<${parentTag}>([\\s\\S]*?)</${parentTag}>`, "s"));
    if (!parentMatch?.[1]) return [];
    scope = parentMatch[1];
  }

  const results: string[] = [];
  const regex = new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, "gs");
  let match;
  while ((match = regex.exec(scope)) !== null) {
    const text = match[1]?.trim();
    if (text) results.push(text);
  }
  return results;
}

// =============================================================================
// Core Extraction Functions
// =============================================================================

export async function extractObservations(
  messages: TranscriptMessage[]
): Promise<Observation[]> {
  if (messages.length < 4) return [];

  const transcript = prepareTranscript(messages);
  const prompt = `${OBSERVATION_SYSTEM_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---\n\nExtract observations:`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_LLM_GENERATE_TIMEOUT_MS);
  try {
    const llm = getDefaultLlamaCpp();
    const result = await llm.generate(prompt, {
      maxTokens: GENERATION_MAX_TOKENS,
      temperature: GENERATION_TEMPERATURE,
      signal: controller.signal,
    });

    if (!result?.text) return [];

    // Parse all <observation>...</observation> blocks
    const observations: Observation[] = [];
    const regex = /<observation>([\s\S]*?)<\/observation>/g;
    let match;
    while ((match = regex.exec(result.text)) !== null) {
      const obs = parseObservationXml(match[1]!);
      if (obs) observations.push(obs);
    }

    return observations;
  } catch (err) {
    console.error("Observer: observation extraction failed:", err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function extractSummary(
  messages: TranscriptMessage[]
): Promise<SessionSummary | null> {
  if (messages.length < 4) return null;

  const transcript = prepareTranscript(messages);
  const prompt = `${SUMMARY_SYSTEM_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---\n\nGenerate summary:`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_LLM_GENERATE_TIMEOUT_MS);
  try {
    const llm = getDefaultLlamaCpp();
    const result = await llm.generate(prompt, {
      maxTokens: 500,
      temperature: GENERATION_TEMPERATURE,
      signal: controller.signal,
    });

    if (!result?.text) return null;

    const summaryMatch = result.text.match(/<summary>([\s\S]*?)<\/summary>/);
    if (!summaryMatch?.[1]) return null;

    return parseSummaryXml(summaryMatch[1]);
  } catch (err) {
    console.error("Observer: summary extraction failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
