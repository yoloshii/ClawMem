/**
 * BACKLOG 82.3, D7 — identity-preserving parsing of caller-supplied lists.
 *
 * Between the caller's argument and the refusal, a selector or a collection name passes through NO operation that
 * can remove or change a code point other than the four ASCII ones a list may be padded with. `String.trim()` is
 * not such an operation: it removes U+FEFF, so a mark-led name would be read as the name without it.
 */
import { refuseLeadingMark } from "./text-policy.ts";

const SPACE = 0x20, TAB = 0x09, LF = 0x0a, CR = 0x0d;
const isAsciiPad = (code: number): boolean => code === SPACE || code === TAB || code === LF || code === CR;

/** The text without U+0020, tab, CR and LF at its two ends. No other character is removed. */
export function trimAsciiSpace(text: string): string {
  let start = 0, end = text.length;
  while (start < end && isAsciiPad(text.charCodeAt(start))) start++;
  while (end > start && isAsciiPad(text.charCodeAt(end - 1))) end--;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

function parseList(text: string, field: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(",")) {
    const element = trimAsciiSpace(piece);
    if (element.length === 0) continue;
    out.push(refuseLeadingMark(element, field));
  }
  return out;
}

/**
 * The comma list of `multi_get`: paths, `collection/path`, virtual paths, `#docid`, globs. Each element has its ASCII
 * padding stripped; an empty one is dropped; one that starts with a mark is refused. A component of an element (the
 * collection and the path of `collection/path`, a percent-decoded REST part) is refused AGAIN by its own reader.
 */
export function parseSelectorList(text: string): string[] {
  return parseList(text, "selector");
}

/**
 * Collection names, from every tool and REST parameter that takes them: one comma list (a single name is a list of
 * one). Every such argument is ONE string in MCP, REST and the CLI; there is no list form.
 */
export function parseCollectionList(names: string): string[] {
  return parseList(names, "collection");
}

/**
 * The identifier policy on ONE selector — a bare path, `collection/path`, a virtual path (`clawmem://collection/path`,
 * `//collection/path`), a `#docid`, a glob — with or without a `:line` suffix. Nothing is changed: the same string
 * comes back, or `BomLeadingIdentifierError` is thrown, naming what starts with the mark:
 *
 *  - `selector` — the whole text;
 *  - `collection` — what follows an explicit scheme;
 *  - `path` — what follows the FIRST slash of `collection/path`.
 *
 * Stated side effect of the first-slash rule: the bare selector `sub/<mark>x.md` is refused although a file can be
 * stored under that path — it reads as collection `sub`, path `<mark>x.md`. `collection/sub/<mark>x.md` and the
 * docid reach that document. A filesystem path (`/…`, `~/…`) is checked by its reader, on the part that is relative
 * to a collection root.
 */
export function refuseMarkedSelector(selector: string): string {
  refuseLeadingMark(selector, "selector");
  const text = selector.replace(/:\d+$/, "");
  if (text.startsWith("#")) return selector;                             // a docid: validated as hex by its reader
  let rest: string;
  if (text.startsWith("clawmem:")) rest = skipSlashes(text, 8);
  else if (text.startsWith("//")) rest = skipSlashes(text, 0);
  else if (text.startsWith("/") || text.startsWith("~/")) return selector;
  else rest = text;
  if (rest !== text) refuseLeadingMark(rest, "collection");
  const slash = rest.indexOf("/");
  if (slash >= 0) refuseLeadingMark(skipSlashes(rest, slash), "path");
  return selector;
}

/** `text` from `from` on, without the slashes that stand there. */
function skipSlashes(text: string, from: number): string {
  let at = from;
  while (at < text.length && text.charCodeAt(at) === 0x2f) at++;
  return text.slice(at);
}
