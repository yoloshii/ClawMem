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
 * {{...}} skeleton tokens (caught by shape via isMarkerOnly for claim fields, and by consumer-scoped exact sets for identifier fields) rather than copyable
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

/**
 * Consumer-scoped residue. Deliberately NOT in the global set above: these strings are
 * residue only in the field of the consumer that emitted the skeleton. In a coding-memory
 * system the literal text `update|contradiction|same` is legitimate content for an
 * observation ABOUT this defect, so globally denylisting it would suppress real memory.
 */
export const CAUSAL_RESIDUE = new Set([
  "brief explanation of causal relationship",
]);

/**
 * Contradiction residue, scoped to the REASONING field.
 *
 * The prompt's relation skeleton (`"update|contradiction|same"`) is deliberately NOT here:
 * it is a `relation` value, and that field is already rejected independently by exact enum
 * membership. Putting it here matched nothing while leaving the field this set actually
 * guards — `"reasoning": "..."` — unprotected.
 */
export const CONTRADICTION_RESIDUE = new Set([
  "...",
]);

/**
 * conversation-synthesis identifier residue, one set per field, naming the EXACT skeleton that
 * field's prompt emits. Shape-based rejection is wrong for identifiers — `{{user.name}}` is a
 * legitimate Handlebars path — so these name the literal residue instead of guessing.
 */
export const ALIAS_RESIDUE = new Set([
  "{{optional alternative title}}",
]);

export const LINK_TARGET_RESIDUE = new Set([
  // The live skeleton. Deliberately apostrophe-free: the previous `{{another fact's title}}`
  // had a typographic variant (`{{Another Fact’s Title}}`) that canonicalization does not fold
  // onto it, because internal punctuation is preserved on purpose. Removing the apostrophe from
  // the PROMPT closes that at the source instead of weakening the guard for everything else.
  "{{target fact title}}",
  // Retained so the previous skeleton's exact ASCII form is still caught.
  "{{another fact's title}}",
]);

/**
 * A value that IS a template marker, in whole. Retained as a compatibility export and test
 * surface; `isSchemaPlaceholder` routes through `isMarkerOnly` instead.
 *
 * Anchored at BOTH ends deliberately. Start-anchoring alone rejected legitimate sentences that
 * merely begin with a marker — `"${HOME} is the user home directory"` is documentation, not
 * residue. `[\s\S]*` rather than `.*` so a marker spanning newlines is still recognised.
 */
export const PLACEHOLDER_REGEX = /^(\{\{[\s\S]*\}\}|<!--[\s\S]*-->|\$\{[\s\S]*\})$/;

/**
 * Invisible characters that split a word without changing how it reads: zero-width space and
 * joiners, bidi overrides, the combining grapheme joiner, variation selectors. One of these
 * inside an echoed phrase defeated exact matching entirely while looking identical on screen.
 * `Default_Ignorable_Code_Point` covers the class; enumerating members would not.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * What KIND of field is being guarded.
 *
 * `claim` — must be an assertion: observation facts, narratives, deductions, contradiction
 * reasoning. A value made only of template markers asserts nothing and is rejected.
 *
 * `identifier` — a name or literal value: conversation-synthesis aliases and link targets,
 * SPO subjects and objects. These are not assertions, so NO marker shape is rejected on shape
 * alone. `${VAR}`, `{{user.name}}` (Mustache/Handlebars/Jinja/Angular) and `<!--more-->` are
 * all legitimate identifiers in a coding vault. Residue is caught here the way the rest of
 * this module catches it — by CONSUMER-SCOPED exact sets naming what that consumer's own
 * prompt actually emitted, not by guessing from shape.
 */
export type ResidueScope = "claim" | "identifier";

/** The same three marker shapes, findable anywhere rather than only as the whole value. */
const MARKER_ANYWHERE = /(\{\{[\s\S]*?\}\}|<!--[\s\S]*?-->|\$\{[\s\S]*?\})/g;

/**
 * True when the value carries no assertable content outside template markers.
 *
 * Replaces an enumerated list of wrapper characters, which leaked indefinitely — quotes and
 * asterisks were covered, markdown bullets, blockquotes, pipes and Unicode brackets `【】`
 * were not, and the next unlisted wrapper would have leaked too. Testing what remains after
 * the markers, rather than what the wrapper is made of, ends that class.
 *
 * THE POLICY THIS ENCODES, stated explicitly because it is a judgement call: a value whose
 * every letter and digit lives inside a template marker — `${HOME}`, `|${HOME}|`,
 * `${HOME}/${_}`, `{{a}} + {{_}}` — asserts nothing. It has no subject and no claim, so it
 * cannot serve as an observation fact, a narrative, a deduction, or contradiction reasoning,
 * whether it is echoed prompt residue or a genuine bare code fragment.
 *
 * That reasoning holds ONLY for fields required to be claims. It does NOT hold for identifier
 * fields — conversation-synthesis aliases and LINK TARGETS, and SPO subjects/objects, are names
 * and literal values, not assertions. `${HOME}` is a perfectly good object of `uses`, and
 * `{{user.name}}` is a Handlebars path. This function is therefore called for claim scope only;
 * identifier residue is caught by consumer-scoped exact sets. See `ResidueScope`.
 *
 * What it must NOT filter in EITHER scope is content that merely CONTAINS a marker:
 * `"${HOME} is the user home directory"` and `"the log path is ${HOME}/${_}"` both carry
 * letters outside their markers and are ordinary documentation.
 *
 * ALL markers are removed, not just the first. Removing one left a second marker in the
 * remainder, where it read as punctuation — which both mis-filtered and contradicted the
 * function's own stated contract.
 */
function isMarkerOnly(value: string): boolean {
  let sawMarker = false;
  const outside = value.replace(MARKER_ANYWHERE, () => {
    sawMarker = true;
    return "";
  });
  return sawMarker && !/[\p{L}\p{N}]/u.test(outside);
}

/**
 * Canonical form for EXACT residue matching: NFKC-fold, drop invisibles, lowercase, collapse
 * WHITESPACE runs, strip outer punctuation.
 *
 * Deliberately does NOT convert internal punctuation to spaces. An earlier version did, which
 * mapped plausible code identifiers onto residue phrases — `canonical_entity_name` and
 * `atomic-fact` both became blocklist members. In a coding-memory vault those are real content.
 * Whitespace-only collapse still absorbs the reformatting that matters: doubled spaces,
 * newlines, fullwidth characters, and trailing punctuation.
 */
function canonicalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

// Canonicalized on each call rather than memoized per set. A WeakMap keyed on the set object
// was invisible to later mutation of that set — a latent correctness trap for a few
// microseconds saved over sets of fewer than ten short strings.
function residueHas(set: ReadonlySet<string>, canonical: string): boolean {
  for (const entry of set) {
    if (canonicalizeForMatch(entry) === canonical) return true;
  }
  return false;
}

/**
 * True when `text` is residue a model echoed from its prompt rather than real extracted
 * content: empty, a known schema-placeholder string, consumer-scoped residue, or — in `claim`
 * scope only — a value carrying no assertable content outside template markers.
 *
 * A template marker is NOT universally residue. In `identifier` scope it may be the content:
 * `{{user.name}}` and `${HOME}` are legitimate names. See `ResidueScope`.
 */
export function isSchemaPlaceholder(
  text: string,
  extraResidue?: ReadonlySet<string>,
  scope: ResidueScope = "claim",
): boolean {
  if (!text) return true;
  const raw = text.trim().toLowerCase();
  if (!raw) return true; // whitespace-only is effectively empty content
  // Content carrying no letter and no number is not content — it is quoting/punctuation
  // residue. Testing for the ABSENCE of letters/numbers beats enumerating punctuation,
  // which was ASCII-only and admitted `…`, `“...”`, `(...)`, `***`, and `。`.
  if (!/[\p{L}\p{N}]/u.test(raw)) return true;

  // Marker detection. NFKC runs HERE too, not only during exact matching — without it a
  // fullwidth `｛｛x｝｝` never reached the marker shapes at all.
  // Shape-based marker rejection applies to CLAIM fields only. An identifier may legitimately
  // BE a marker — `{{user.name}}` is a Handlebars path, not residue — so identifier residue is
  // caught by the consumer-scoped sets below instead of by shape.
  if (scope === "claim" && isMarkerOnly(raw.normalize("NFKC").replace(IGNORABLE, ""))) {
    return true;
  }

  // Exact residue, compared canonical-to-canonical.
  const canonical = canonicalizeForMatch(text);
  if (residueHas(SCHEMA_PLACEHOLDER_STRINGS, canonical)) return true;
  if (extraResidue && residueHas(extraResidue, canonical)) return true;

  return false;
}
