/**
 * BACKLOG 82.3, D7 — the two policies for a leading byte-order mark.
 *
 * SQLite stores a string bound with a leading U+FEFF without that character, and one with a leading U+FFFE with its
 * bytes read the other way round. So a NORMALISED field (a body, a title, free text) loses every leading mark before
 * it is hashed or stored, and an IDENTIFIER (a path, a collection, a session id, a doc key, a selector) that starts
 * with one is REFUSED — never stripped: `x.md` and a mark followed by `x.md` are two names, and stripping would make
 * them one key.
 */
import { createHash } from "node:crypto";

/** The first code unit that marks a string: U+FEFF, or U+FFFE (its bytes swapped). */
export type LeadingMark = 0xfeff | 0xfffe;

const isMark = (code: number): code is LeadingMark => code === 0xfeff || code === 0xfffe;

/** True when the first code unit is U+FEFF or U+FFFE. */
export function startsWithMark(text: string): boolean {
  return isMark(text.charCodeAt(0));
}

/**
 * The policy of a normalised field: the text without ANY leading U+FEFF / U+FFFE, and with each lone UTF-16 surrogate
 * (half of a pair, standing alone) replaced by U+FFFD (operator ruling 80 A). Nothing else is changed.
 *
 * A lone surrogate is hashed as U+FFFD by Node but stored by SQLite as other bytes, which Bun then reads back lossily
 * (sometimes as an empty string); replacing it first makes what is hashed, what is stored and what is read the same text.
 */
export function stripLeadingMarks(text: string): string {
  let at = 0;
  while (at < text.length && isMark(text.charCodeAt(at))) at++;
  const stripped = at === 0 ? text : text.slice(at);
  return stripped.isWellFormed() ? stripped : stripped.toWellFormed();
}

/**
 * A normalised field cut to at most `max` UTF-16 code units WITHOUT splitting a surrogate pair (Codex T2 S3, ruling
 * 80 A): a cut that would end in the first half of a pair ends before it. Normalise first, then cut with this.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The refusal of an identifier or a selector that starts with a mark. It is USER INPUT, not a fault of the program:
 * REST answers 400, an MCP tool returns a tool error, the CLI exits 2 — each names the field. The message holds
 * neither the mark nor the value.
 */
export class BomLeadingIdentifierError extends Error {
  constructor(
    /** What the value is: "path", "collection", "selector", "session id" … */
    public readonly field: string,
    /** The mark the value starts with. */
    public readonly first: LeadingMark,
  ) {
    super(`the ${field} starts with a byte-order mark (U+${first.toString(16).toUpperCase()}); such a name is refused, not stripped. ` +
      `Rename it without the mark, or pass the name as it is stored.`);
    this.name = "BomLeadingIdentifierError";
  }
}

/** The policy of an identifier: the SAME string when it is sound; `BomLeadingIdentifierError` when it starts with a mark. */
export function refuseLeadingMark(value: string, field: string): string {
  const first = value.charCodeAt(0);
  if (isMark(first)) throw new BomLeadingIdentifierError(field, first);
  return value;
}

/**
 * The ONE producer of a body hash for stored text: normalise, then hash. `body` is what is stored and `hash` is the
 * SHA-256 of its UTF-8 bytes, so the hash of a row is the hash of what the row holds. `insertContent` asserts this
 * pair and normalises nothing itself.
 */
export function normalizedContent(text: string): { body: string; hash: string } {
  const body = stripLeadingMarks(text);
  return { body, hash: createHash("sha256").update(body, "utf-8").digest("hex") };
}

/** For a message: the text with each LEADING mark written as `<U+FEFF>` / `<U+FFFE>`, so no mark is printed. */
export function showLeadingMarks(text: string): string {
  let at = 0, shown = "";
  while (at < text.length && isMark(text.charCodeAt(at))) shown += `<U+${text.charCodeAt(at++).toString(16).toUpperCase()}>`;
  return shown + text.slice(at);
}
