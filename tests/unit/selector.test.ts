/**
 * BACKLOG 82.3, D7 — identity-preserving parsing. Between the caller's argument and the refusal, a selector or a
 * collection name passes through no operation that can remove a code point other than the four ASCII ones a list
 * may be padded with. `.trim()` removes U+FEFF: `"<U+FEFF>x.md,missing.md"` read `x.md` before this.
 */
import { describe, expect, test } from "bun:test";
import { parseCollectionList, parseSelectorList, trimAsciiSpace } from "../../src/selector.ts";
import { BomLeadingIdentifierError } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const NBSP = String.fromCharCode(0xa0);

describe("trimAsciiSpace", () => {
  test("strips space, tab, CR and LF from both ends, and nothing else", () => {
    expect(trimAsciiSpace(" \t\r\n x.md \n\r\t ")).toBe("x.md");
    expect(trimAsciiSpace("a b")).toBe("a b");
    expect(trimAsciiSpace(" \t ")).toBe("");
    expect(trimAsciiSpace("")).toBe("");
  });

  test("keeps every other white-space character and both marks — `.trim()` would not", () => {
    for (const c of [FEFF, FFFE, NBSP, String.fromCharCode(0x0b), String.fromCharCode(0x0c), String.fromCharCode(0x2028), String.fromCharCode(0x3000)]) {
      expect(trimAsciiSpace(c + "x" + c)).toBe(c + "x" + c);
      expect(trimAsciiSpace(" " + c + "x" + c + " ")).toBe(c + "x" + c);
    }
    expect((FEFF + "x").trim()).toBe("x");                 // the reason this helper exists
  });
});

describe("parseSelectorList", () => {
  test("splits on commas, strips ASCII padding, drops empty elements", () => {
    expect(parseSelectorList("a.md, notes/b.md ,\t#abc123\n")).toEqual(["a.md", "notes/b.md", "#abc123"]);
    expect(parseSelectorList("a.md,, ,b.md,")).toEqual(["a.md", "b.md"]);
    expect(parseSelectorList("")).toEqual([]);
    expect(parseSelectorList(" , ")).toEqual([]);
    expect(parseSelectorList("one")).toEqual(["one"]);
  });

  test("an element is given as it came: a glob, a virtual path, inner spaces", () => {
    expect(parseSelectorList("notes/*.md,clawmem://notes/a b.md")).toEqual(["notes/*.md", "clawmem://notes/a b.md"]);
  });

  test("an element that starts with a mark is refused, wherever it stands in the list", () => {
    for (const mark of [FEFF, FFFE]) {
      for (const arg of [mark + "x.md", mark + "x.md,missing.md", "missing.md," + mark + "x.md", "a.md, " + mark + "x.md ,b.md", " \t" + mark + "x.md"]) {
        expect(() => parseSelectorList(arg)).toThrow(BomLeadingIdentifierError);
      }
    }
  });

  test("the refusal names the selector field", () => {
    let caught: unknown;
    try { parseSelectorList(FEFF + "x.md,missing.md"); } catch (e) { caught = e; }
    expect((caught as BomLeadingIdentifierError).field).toBe("selector");
  });

  test("a mark that is not first in its element is kept — it is part of a name", () => {
    expect(parseSelectorList("x" + FEFF + ".md")).toEqual(["x" + FEFF + ".md"]);
    expect(parseSelectorList("notes/" + FFFE + "x.md")).toEqual(["notes/" + FFFE + "x.md"]);   // refused later, by component
  });

  test("an element padded with another white-space character is not trimmed and names nothing else", () => {
    expect(parseSelectorList(NBSP + "x.md")).toEqual([NBSP + "x.md"]);
    expect(parseSelectorList("x.md" + NBSP + ",y.md")).toEqual(["x.md" + NBSP, "y.md"]);
  });
});

describe("parseCollectionList", () => {
  test("splits, strips ASCII padding and drops empty elements like the selector list", () => {
    expect(parseCollectionList("notes, research ,")).toEqual(["notes", "research"]);
    expect(parseCollectionList("")).toEqual([]);
  });

  test("a mark-led collection name is refused and never read as the name without it", () => {
    for (const mark of [FEFF, FFFE]) {
      for (const arg of [mark + "notes,other", "other, " + mark + "notes"]) {
        let caught: unknown;
        try { parseCollectionList(arg); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(BomLeadingIdentifierError);
        expect((caught as BomLeadingIdentifierError).field).toBe("collection");
      }
    }
  });

  test("a single name is a list of one", () => {
    expect(parseCollectionList("notes")).toEqual(["notes"]);
    expect(parseCollectionList("  notes\n")).toEqual(["notes"]);
  });
});
