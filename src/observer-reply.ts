/**
 * v0.41.4 (BACKLOG 69.3, DESIGN-v0414.md r9 §1, §2, §3.1, §4.2, §5) — the observer's reply contract: the prompt that
 * asks for `<observation>` blocks, the GBNF grammar that constrains them on llama.cpp backends, the parser that reads a
 * reply, and the feedback a format retry carries. Kept apart from `observer.ts` (which runs the windows) so the four
 * change together.
 *
 * Measured on the documented observer model (qmd-query-expansion-1.7B, 34 replies): types copied from the transcript
 * (`tool_use`), placeholders copied from the prompt (`...`), query-expansion lines read as "nothing", and a retry whose
 * feedback named a `<content>` tag the schema lacks. Only the sentinel `<none/>` is "nothing" now; a rejected block
 * says why in classes, never in transcript text.
 */

import type { Observation, ParsedTriple } from "./observer.ts";
import { isSchemaPlaceholder, canonicalizeForMatch, isObserverIdentifierResidue } from "./schema-placeholder.ts";

export const VALID_OBSERVATION_TYPES: ReadonlySet<string> = new Set([
  "decision", "bugfix", "feature", "refactor", "discovery", "change",
  "preference", "milestone", "problem",
]);

export const VALID_CONCEPTS: ReadonlySet<string> = new Set([
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

/** The field limits in code points (§1.4): the prompt states them, the grammar and the parser enforce them. */
const TITLE_MAX = 80;
const FACT_MIN = 5;
const FACT_MAX = 300;
const SUBJECT_MIN = 2;
const SUBJECT_MAX = 80;
const OBJECT_MIN = 2;
const OBJECT_MAX = 120;
const NARRATIVE_MAX = 600;
const FILE_MAX = 300;
/** The parser's own cap on triples per observation (the prompt and the grammar ask for at most 3). */
const PARSER_MAX_TRIPLES = 5;

/**
 * The allowed types as the prompt's type rule names them. r8 (live check, 2026-10-03): with the list written INTO the
 * structure's `<type>` line, the documented model copied the whole line as the type in 26 of 28 grammarless replies;
 * with `<type>{{type}}</type>` and the list in the rule, none did. The grammar enumerates them either way.
 */
const TYPE_LIST = [...VALID_OBSERVATION_TYPES].join(", ");

/** The observer's system prompt; `{N}` is the requested count (`observationSystemPrompt`). */
export const OBSERVATION_SYSTEM_PROMPT = `You are an observer analyzing a coding session transcript. Extract structured observations.
For each significant action, decision, or discovery, output an <observation> XML element with the structure below.

Structure (each {{…}} stands for real content from the transcript — never write a {{…}} token itself):
<observation>
  <type>{{type}}</type>
  <title>{{title}}</title>
  <facts>
    <fact>{{fact}}</fact>
  </facts>
  <triples>
    <triple>
      <subject>{{entity}}</subject>
      <predicate>{{predicate}}</predicate>
      <object>{{entity}}</object>
    </triple>
  </triples>
  <narrative>{{why}}</narrative>
  <concepts>
    <concept>{{concept}}</concept>
  </concepts>
  <files_read><file>{{path}}</file></files_read>
  <files_modified><file>{{path}}</file></files_modified>
</observation>

Field rules:
- <type>: exactly one of: ${TYPE_LIST} — never a transcript role or tool name such as tool_use or tool_result
- <title>: brief descriptive title, max 80 chars
- <facts>: 1-5 <fact> elements, each a standalone atomic claim about what happened or what is true (concrete, specific, 5-300 chars, no schema placeholders or template text)
- <triples>: 0-3 <triple> elements for structural relationships between named entities (see predicate vocabulary below). Omit entirely if no relational claims apply. Do NOT emit triples for descriptive facts — only for explicit S-P-O relations.
- <narrative>: 2-3 sentences explaining WHY something was done, not just WHAT (max 600 chars)
- <concepts>: 0-3 <concept> elements from: ${[...VALID_CONCEPTS].join(", ")}
- <files_read>, <files_modified>: only files explicitly mentioned in the transcript (each path max 300 chars)

Predicate vocabulary (use EXACTLY these predicates in <predicate>, nothing else):
- adopted, migrated_to — switching to a new tool/framework/approach
- deployed_to, runs_on — where something runs
- replaced — when one thing supersedes another
- depends_on, integrates_with, uses — structural dependencies
- prefers, avoids — user preferences (use for <subject>user</subject>)
- caused_by, resolved_by — causal relationships between problems and fixes
- owned_by — responsibility / ownership

<subject> (2-80 chars) and <object> (2-120 chars) must be short canonical entity names. No sentences. No placeholder text. If you cannot fit a claim into this vocabulary, keep it in <facts> instead and omit the triple.

Inside a field write <, > and & as &lt;, &gt; and &amp;. Lengths count characters after decoding.

Observation rules:
- Output 1-{N} observations, focusing on the MOST significant events
- If nothing significant happened, output exactly <none/>
- Never use schema example text or template placeholders in <fact>, <subject>, or <object> — emit only real content extracted from the transcript

Type guidance:
- preference: user expresses a preference, habit, or way of working (e.g., "don't use subagents for this", "I prefer single PRs")
- milestone: significant completion point, version release, deployment, or phase transition
- problem: persistent issue, recurring bug, architectural limitation, or unresolved blocker`;

// =============================================================================
// Decoding and units (§2.4)
// =============================================================================

/** One non-recursive decode of exactly `&lt;`, `&gt;`, `&amp;`: `&amp;lt;` reads `&lt;`. */
export function decodeObserverEntities(s: string): string {
  return s.replace(/&(lt|gt|amp);/g, (_m, e: string) => (e === "lt" ? "<" : e === "gt" ? ">" : "&"));
}

const codePoints = (s: string): number => Array.from(s).length;

/** At most `max` code points, cut by code points — never half of a surrogate pair. (The shared `cutAt` stays UTF-16.) */
function cutCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join("") : s;
}

// =============================================================================
// Reply classification (§2.1–§2.3)
// =============================================================================

export type BlockRejection = {
  field: "type" | "title" | "facts";
  reason: "type-not-allowed" | "type-missing" | "title-missing" | "title-empty" | "title-placeholder" | "facts-empty";
  valueClass?: "tool-role" | "placeholder" | "type-list" | "other";
  /** The rejected raw type, at most 40 code points — for the transient retry prompt only, never persisted. */
  value?: string;
};

export type ReplyFailure = { reason: "empty-reply" | "no-blocks" | "blocks-rejected"; rejections: BlockRejection[] };

/** §5.1: prompt clauses a reply restated (kept, counted). */
export type ParseAdvisories = { instructionEcho: number; eventDefinitionEcho: number };

/** §1.1 / §5.2 / §5.3: residue the guards dropped. */
export type GuardDrops = { tripleToolId: number; tripleSelf: number; identifierResidue: number; repeatedFact: number };

/** What the window showed the model — canonical TRANSCRIPT + EARLIER text, for the echo check (§5.1). */
export type ParseContext = { evidence?: string };

export type ParsedReply =
  | { ok: true; value: Observation[]; none: boolean; rejections: BlockRejection[]; advisories: ParseAdvisories; drops: GuardDrops }
  | { ok: false; error: string; failure: ReplyFailure; advisories: ParseAdvisories; drops: GuardDrops };

/** Structural rejections (the element absent, or a type outside the set) vs content ones (§4.5). */
const STRUCTURAL_REASONS: ReadonlySet<BlockRejection["reason"]> = new Set(["type-not-allowed", "type-missing", "title-missing"]);

function typeValueClass(v: string): NonNullable<BlockRejection["valueClass"]> {
  const t = v.trim().toLowerCase();
  if (/^tool_(use|result|call)\b/.test(t)) return "tool-role";
  if (!/[\p{L}\p{N}]/u.test(t) || /\{\{[\s\S]*\}\}/.test(t)) return "placeholder";
  if (t.includes("|") || t.includes(",")) return "type-list";
  return "other";
}

/**
 * `<none/>` alone — whitespace around it allowed — or as the content of one complete markdown code fence: a line break
 * after the opening fence and its info string, and another before the closing fence (§2.1; codex T7-1, T8-1).
 */
const NONE_RE = /^\s*(?:<none\/>|```[a-zA-Z]*[ \t]*\r?\n\s*<none\/>[ \t]*\r?\n\s*```)\s*$/;
const BLOCK_RE = /<observation>([\s\S]*?)<\/observation>/g;

function scoped(xml: string, scope: string | undefined): string | null {
  if (!scope) return xml;
  const m = xml.match(new RegExp(`<${scope}>([\\s\\S]*?)</${scope}>`, "s"));
  return m?.[1] ?? null;
}
/** Every `<tag>` value in `scope` (or the whole block), decoded once and trimmed (§2.4). */
function extractDecoded(xml: string, tag: string, scope?: string): string[] {
  const s = scoped(xml, scope);
  if (s === null) return [];
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gs");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(decodeObserverEntities(m[1] ?? "").trim());
  return out;
}
function elementPresent(xml: string, tag: string): boolean {
  return new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "s").test(xml);
}

// =============================================================================
// Prompt-clause echoes (§5.1) — counted, never dropped
// =============================================================================

type Clause = { canonical: string; kind: "instruction" | "event" };
/** The definition clauses of the Field rules (`- <tag>: …`) and the Type guidance (`- type: …`), examples removed. */
const PROMPT_CLAUSES: Clause[] = (() => {
  const out: Clause[] = [];
  let section: "field" | "type" | null = null;
  for (const line of OBSERVATION_SYSTEM_PROMPT.split("\n")) {
    if (line === "Field rules:") { section = "field"; continue; }
    if (line === "Type guidance:") { section = "type"; continue; }
    if (!line.startsWith("- ")) { if (line.trim() !== "") section = null; continue; }
    const m = section === "field" ? line.match(/^- <[^>]+>(?:, <[^>]+>)*: (.+)$/) : section === "type" ? line.match(/^- [a-z_]+: (.+)$/) : null;
    if (!m) continue;
    const text = m[1]!.replace(/\([^)]*\)/g, " ").replace(/"[^"]*"/g, " ");
    const canonical = canonicalizeForMatch(text);
    if (canonical) out.push({ canonical, kind: section === "field" ? "instruction" : "event" });
  }
  return out;
})();

function noteEcho(value: string, ctx: ParseContext | undefined, adv: ParseAdvisories): void {
  const c = canonicalizeForMatch(value);
  if (!c) return;
  for (const clause of PROMPT_CLAUSES) {
    if (clause.canonical !== c) continue;
    if (ctx?.evidence && ctx.evidence.includes(clause.canonical)) return;   // the transcript says it too: not an echo
    if (clause.kind === "instruction") adv.instructionEcho++;
    else adv.eventDefinitionEcho++;
    return;
  }
}

// =============================================================================
// One block (§2.3, §2.4, §5)
// =============================================================================

type BlockResult = { ok: true; value: Observation } | { ok: false; rejection: BlockRejection };

/**
 * A tool-call id or a tool-call rendering copied as an entity (§5.2) — the WHOLE value: an id bare, quoted or as
 * `id="…"`, or a value that opens with a rendering as the transcript writes it (`[tool_use name="…" id="…"]`,
 * `[tool_result id="…"]`). An entity that merely contains one is kept: `toolu_abcdef.ts` names a file and
 * `tool_result_cache` a module (codex T7-8).
 */
const TOOL_ID_RE = /^(?:id=)?["'`]?toolu_[A-Za-z0-9]{6,}["'`]?$/;
const TOOL_RENDERING_RE = /^\[?(?:tool_use name=|tool_result(?:$|[\s\]]))/;

function parseTriples(xml: string, drops: GuardDrops): ParsedTriple[] {
  const parent = scoped(xml, "triples");
  if (!parent) return [];
  const results: ParsedTriple[] = [];
  const blockRegex = /<triple>([\s\S]*?)<\/triple>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(parent)) !== null) {
    const block = match[1] ?? "";
    const subject = extractDecoded(block, "subject")[0];
    const rawPredicate = extractDecoded(block, "predicate")[0];
    const object = extractDecoded(block, "object")[0];
    if (!subject || !rawPredicate || !object) continue;
    const predicate = rawPredicate.toLowerCase().replace(/\s+/g, "_");
    if (!VALID_PREDICATES.has(predicate)) continue;
    // Bounds in code points (§2.4): a 41-letter astral subject is 41, not 82.
    const s = codePoints(subject);
    const o = codePoints(object);
    if (s < SUBJECT_MIN || s > SUBJECT_MAX || o < OBJECT_MIN || o > OBJECT_MAX) continue;
    // Identifier scope: a name or literal value, not an assertion — `${HOME}` and `{{user.name}}` are legitimate.
    if (isSchemaPlaceholder(subject, undefined, "identifier") || isSchemaPlaceholder(object, undefined, "identifier")) continue;
    if (isObserverIdentifierResidue(subject) || isObserverIdentifierResidue(object)) { drops.identifierResidue++; continue; }
    if (TOOL_ID_RE.test(subject) || TOOL_ID_RE.test(object) || TOOL_RENDERING_RE.test(subject) || TOOL_RENDERING_RE.test(object)) {
      drops.tripleToolId++;
      continue;
    }
    if (subject.toLowerCase() === object.toLowerCase()) { drops.tripleSelf++; continue; }
    results.push({ subject, predicate, object });
    if (results.length >= PARSER_MAX_TRIPLES) break;
  }
  return results;
}

function parseFiles(xml: string, scope: string, drops: GuardDrops): string[] {
  const out: string[] = [];
  for (const f of extractDecoded(xml, "file", scope)) {
    if (!f || codePoints(f) > FILE_MAX) continue;
    if (isObserverIdentifierResidue(f)) { drops.identifierResidue++; continue; }
    out.push(f);
  }
  return out;
}

/**
 * One `<observation>` block's content: an observation, or why it was rejected (§2.3). Each value is decoded once, then
 * trimmed, then checked; bounds count code points (§2.4).
 */
export function parseObservationBlock(xml: string, ctx: ParseContext | undefined, adv: ParseAdvisories, drops: GuardDrops): BlockResult {
  if (!elementPresent(xml, "type")) return { ok: false, rejection: { field: "type", reason: "type-missing" } };
  const rawType = extractDecoded(xml, "type")[0] ?? "";
  const type = rawType.toLowerCase();
  if (!VALID_OBSERVATION_TYPES.has(type)) {
    return { ok: false, rejection: { field: "type", reason: "type-not-allowed", valueClass: typeValueClass(rawType), value: cutCodePoints(rawType, 40) } };
  }
  if (!elementPresent(xml, "title")) return { ok: false, rejection: { field: "title", reason: "title-missing" } };
  const rawTitle = extractDecoded(xml, "title")[0] ?? "";
  if (rawTitle === "") return { ok: false, rejection: { field: "title", reason: "title-empty" } };
  if (isSchemaPlaceholder(rawTitle)) return { ok: false, rejection: { field: "title", reason: "title-placeholder" } };

  const seen = new Set<string>();
  const facts: string[] = [];
  for (const f of extractDecoded(xml, "fact")) {
    if (codePoints(f) < FACT_MIN || isSchemaPlaceholder(f)) continue;
    const fact = cutCodePoints(f, FACT_MAX);
    if (seen.has(fact)) { drops.repeatedFact++; continue; }   // exact, case kept (§5.3)
    seen.add(fact);
    facts.push(fact);
  }
  if (facts.length === 0) return { ok: false, rejection: { field: "facts", reason: "facts-empty" } };

  noteEcho(rawTitle, ctx, adv);
  for (const f of facts) noteEcho(f, ctx, adv);
  const rawNarrative = extractDecoded(xml, "narrative")[0] ?? "";
  const narrative = rawNarrative !== "" && !isSchemaPlaceholder(rawNarrative) ? cutCodePoints(rawNarrative, NARRATIVE_MAX) : "";
  if (narrative) noteEcho(narrative, ctx, adv);

  const concepts = extractDecoded(xml, "concept").map(c => c.toLowerCase()).filter(c => VALID_CONCEPTS.has(c));
  const triples = parseTriples(xml, drops);
  return {
    ok: true,
    value: {
      type: type as Observation["type"],
      title: cutCodePoints(rawTitle, TITLE_MAX),
      facts,
      narrative,
      concepts,
      filesRead: parseFiles(xml, "files_read", drops),
      filesModified: parseFiles(xml, "files_modified", drops),
      triples: triples.length > 0 ? triples : undefined,
    },
  };
}

const emptyAdvisories = (): ParseAdvisories => ({ instructionEcho: 0, eventDefinitionEcho: 0 });
const emptyDrops = (): GuardDrops => ({ tripleToolId: 0, tripleSelf: 0, identifierResidue: 0, repeatedFact: 0 });

/** A block's observation or null (the pre-v0.41.4 form; its callers are all in `src/observer.ts`). */
export function parseObservationXml(xml: string): Observation | null {
  const r = parseObservationBlock(xml, undefined, emptyAdvisories(), emptyDrops());
  return r.ok ? r.value : null;
}

/** A failure's class as held reasons name it: `type-not-allowed (tool-role)`, `no-blocks`, … (§3.2, §7.3). */
export function observerFailureClass(failure: ReplyFailure): string {
  if (failure.reason !== "blocks-rejected") return failure.reason;
  const first = failure.rejections[0];
  if (!first) return "blocks-rejected";
  return first.valueClass ? `${first.reason} (${first.valueClass})` : first.reason;
}

/**
 * A COMPLETE observer reply (`finish: "stop"`) as observations (§2.1–§2.3): the valid blocks (invalid ones beside them
 * are dropped), or `[]` for exactly `<none/>`, or a classified failure — an empty reply, no block, or blocks all
 * rejected. Never applied to a reply the server cut. `ctx` carries the window's canonical text for the echo check.
 */
export function parseObservationReply(text: string, ctx?: ParseContext): ParsedReply {
  const advisories = emptyAdvisories();
  const drops = emptyDrops();
  const fail = (failure: ReplyFailure): ParsedReply => ({ ok: false, error: observerFailureClass(failure), failure, advisories, drops });
  if (text.trim() === "") return fail({ reason: "empty-reply", rejections: [] });
  const observations: Observation[] = [];
  const rejections: BlockRejection[] = [];
  let blocks = 0;
  for (const match of text.matchAll(BLOCK_RE)) {
    blocks++;
    const r = parseObservationBlock(match[1]!, ctx, advisories, drops);
    if (r.ok) observations.push(r.value);
    else rejections.push(r.rejection);
  }
  if (observations.length > 0) return { ok: true, value: observations, none: false, rejections, advisories, drops };
  if (blocks === 0) {
    if (NONE_RE.test(text)) return { ok: true, value: [], none: true, rejections, advisories, drops };
    return fail({ reason: "no-blocks", rejections: [] });
  }
  return fail({ reason: "blocks-rejected", rejections });
}

/** A raw `<` or an `&` outside the three escapes inside a field — impossible under the grammar (§4.5). */
const RAW_IN_FIELD_RE = /<(title|fact|subject|object|narrative|file)>([\s\S]*?)<\/\1>/g;
function rawMarkupInField(text: string): boolean {
  for (const m of text.matchAll(RAW_IN_FIELD_RE)) if (/<|&(?!lt;|gt;|amp;)/.test(m[2] ?? "")) return true;
  return false;
}

/**
 * How a COMPLETED reply to a grammar request bears on enforcement (§4.5): `structural` when the parser rejects it with
 * a structural class or a field holds raw markup — a server honouring the grammar cannot produce either; `content` for a
 * reply rejected only on content; null otherwise. Partial: element order and every bound are not checked.
 */
export function grammarReplyClass(parsed: ParsedReply, text: string): "structural" | "content" | null {
  if (rawMarkupInField(text)) return "structural";
  if (parsed.ok) return null;
  const f = parsed.failure;
  if (f.reason !== "blocks-rejected" || f.rejections.some(r => STRUCTURAL_REASONS.has(r.reason))) return "structural";
  return "content";
}

// =============================================================================
// Feedback that can repair (§3.1)
// =============================================================================

/** Every fixed string the observer's retry feedback is built from (hashed into the contract). */
export const OBSERVATION_FEEDBACK_TEXT = {
  head: "Your previous reply could not be used:",
  emptyReply: "- it was empty",
  noBlocks: "- it held no <observation> block, and it was not exactly <none/>",
  typeNotAllowed: "- a block's <type> was not one of the allowed words",
  typeMissing: "- a block had no <type> element",
  titleMissing: "- a block had no <title> element",
  titleEmpty: "- a block's <title> was blank",
  titlePlaceholder: "- a block's <title> was template text, not a title taken from the transcript",
  factsEmpty: "- a block had no usable <fact> (each needs 5-300 characters of real content from the transcript)",
  more: "- and more blocks were rejected the same way",
  typeRule: `<type> is exactly one of: ${TYPE_LIST} — never a transcript role or a tool name.`,
  tail: "Write each observation in the structure above. If nothing significant happened, output exactly <none/> and nothing else.",
} as const;

const CLASS_TEXT: Record<NonNullable<BlockRejection["valueClass"]>, string> = {
  "tool-role": "a transcript tool role", placeholder: "template text", "type-list": "the whole list of types", other: "another word",
};

/** What a format retry tells the model (§3.1): the failing field, its class and the allowed values — never the reply. */
export function observationFeedback(failure: ReplyFailure): string {
  const T = OBSERVATION_FEEDBACK_TEXT;
  const lines: string[] = [T.head];
  let typeRule = false;
  if (failure.reason === "empty-reply") lines.push(T.emptyReply);
  else if (failure.reason === "no-blocks") lines.push(T.noBlocks);
  else {
    const seen = new Set<string>();
    for (const r of failure.rejections) {
      let line: string;
      switch (r.reason) {
        case "type-not-allowed":
          typeRule = true;
          line = `${T.typeNotAllowed} (it was ${CLASS_TEXT[r.valueClass ?? "other"]})`;
          break;
        case "type-missing": typeRule = true; line = T.typeMissing; break;
        case "title-missing": line = T.titleMissing; break;
        case "title-empty": line = T.titleEmpty; break;
        case "title-placeholder": line = T.titlePlaceholder; break;
        case "facts-empty": line = T.factsEmpty; break;
      }
      if (seen.has(line)) continue;
      if (seen.size === 3) { lines.push(T.more); break; }
      seen.add(line);
      lines.push(line);
    }
  }
  if (typeRule) lines.push(T.typeRule);
  lines.push(T.tail);
  return lines.join("\n");
}

// =============================================================================
// The grammar (§4.2)
// =============================================================================

/** Bump with any change to `observerGrammar` (the grammar-off record and the contract both include it). */
export const OBSERVER_GRAMMAR_VERSION = 1;

/**
 * What `String.prototype.trim` removes — ECMAScript WhiteSpace and LineTerminator — as a GBNF class body: never a
 * field's first or last atom (codex T7-5: a fact of NBSP + three letters + NBSP met five atoms and trimmed to three).
 */
const TRIMMED_CLASS = "\\t\\n\\x0B\\x0C\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";

const gbnfAlt = (values: Iterable<string>) => [...values].map(v => JSON.stringify(v)).join(" | ");

/**
 * The GBNF grammar for a reply of 1–`n` observations or `<none/>` (§4.2), in the prompt's layout and element order:
 * enumerated `<type>`, `<predicate>` and `<concept>`; 1–5 facts, 0–3 triples, 0–3 concepts, 0–5 files per list. Field
 * text is atoms — any code point but `<`, `>`, `&` and newline, or one of the three escapes — and every bound counts
 * atoms, i.e. decoded code points. A title runs 1–80 atoms and a fact 5–300; a field's first and last atoms are never a
 * character the parser's trimming removes, so its trimmed length is its atom count. Structure only: the parser stays
 * the authority on content.
 */
export function observerGrammar(n: number): string {
  const count = Math.max(1, Math.min(5, Math.floor(n)));
  const obsList = count === 1 ? "obs" : `obs ( "\\n" obs ){0,${count - 1}}`;
  return [
    `root ::= ( ${obsList} | "<none/>" ) "\\n"?`,
    `obs ::= "<observation>\\n" type title facts triples? narrative concepts? files-read? files-modified? "</observation>"`,
    `type ::= "  <type>" ( ${gbnfAlt(VALID_OBSERVATION_TYPES)} ) "</type>\\n"`,
    `title ::= "  <title>" ns ( a{0,${TITLE_MAX - 2}} ns )? "</title>\\n"`,
    `facts ::= "  <facts>\\n" fact fact? fact? fact? fact? "  </facts>\\n"`,
    `fact ::= "    <fact>" ns a{${FACT_MIN - 2},${FACT_MAX - 2}} ns "</fact>\\n"`,
    `triples ::= "  <triples>\\n" triple triple? triple? "  </triples>\\n"`,
    `triple ::= "    <triple>\\n      <subject>" ns a{${SUBJECT_MIN - 2},${SUBJECT_MAX - 2}} ns "</subject>\\n      <predicate>" pred "</predicate>\\n      <object>" ns a{${OBJECT_MIN - 2},${OBJECT_MAX - 2}} ns "</object>\\n    </triple>\\n"`,
    `pred ::= ${gbnfAlt(VALID_PREDICATES)}`,
    `narrative ::= "  <narrative>" ns ( a{0,${NARRATIVE_MAX - 2}} ns )? "</narrative>\\n"`,
    `concepts ::= "  <concepts>\\n" concept concept? concept? "  </concepts>\\n"`,
    `concept ::= "    <concept>" ( ${gbnfAlt(VALID_CONCEPTS)} ) "</concept>\\n"`,
    `files-read ::= "  <files_read>" file file? file? file? file? "</files_read>\\n"`,
    `files-modified ::= "  <files_modified>" file file? file? file? file? "</files_modified>\\n"`,
    `file ::= "<file>" ns ( a{0,${FILE_MAX - 2}} ns )? "</file>"`,
    `a ::= [^<>&\\n] | "&lt;" | "&gt;" | "&amp;"`,
    `ns ::= [^<>&${TRIMMED_CLASS}] | "&lt;" | "&gt;" | "&amp;"`,
  ].join("\n");
}
