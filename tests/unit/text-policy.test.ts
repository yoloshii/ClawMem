/**
 * BACKLOG 82.3, D7 — the two policies for a leading byte-order mark. A normalised field loses every leading
 * U+FEFF / U+FFFE; an identifier that starts with one is refused with a typed error and is never stripped.
 * No mark is typed into this file: each is built with `String.fromCharCode`.
 */
import { describe, expect, test } from "bun:test";
import { BomLeadingIdentifierError, refuseLeadingMark, startsWithMark, stripLeadingMarks } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);

describe("stripLeadingMarks — the normalised fields", () => {
  test("removes one leading mark of either kind", () => {
    expect(stripLeadingMarks(FEFF + "title")).toBe("title");
    expect(stripLeadingMarks(FFFE + "title")).toBe("title");
  });

  test("removes every leading mark of a mixed prefix", () => {
    expect(stripLeadingMarks(FEFF + FFFE + FEFF + "text")).toBe("text");
    expect(stripLeadingMarks(FFFE + FFFE + FEFF)).toBe("");
  });

  test("leaves a mark that is not at the start, and every other character", () => {
    const inside = "a" + FEFF + "b" + FFFE;
    expect(stripLeadingMarks(inside)).toBe(inside);
    expect(stripLeadingMarks("")).toBe("");
    expect(stripLeadingMarks(" " + FEFF + "x")).toBe(" " + FEFF + "x");          // a space first: the mark is not leading
    const replacement = String.fromCharCode(0xfffd) + "x";                         // U+FFFD is not a mark
    expect(stripLeadingMarks(replacement)).toBe(replacement);
    const zeroWidth = String.fromCharCode(0x200b) + "x";                           // nor is another zero-width character
    expect(stripLeadingMarks(zeroWidth)).toBe(zeroWidth);
  });

  test("the result never starts with a mark", () => {
    for (const s of [FEFF, FFFE, FEFF + FEFF + "x", FFFE + FEFF + FFFE + "y"]) expect(startsWithMark(stripLeadingMarks(s))).toBe(false);
  });
});

describe("startsWithMark", () => {
  test("is true for a first code unit of U+FEFF or U+FFFE only", () => {
    expect(startsWithMark(FEFF + "x")).toBe(true);
    expect(startsWithMark(FFFE)).toBe(true);
    expect(startsWithMark("x" + FEFF)).toBe(false);
    expect(startsWithMark("")).toBe(false);
    expect(startsWithMark(String.fromCharCode(0xfffd))).toBe(false);
    expect(startsWithMark(String.fromCharCode(0xffff))).toBe(false);
  });
});

describe("refuseLeadingMark — the identifiers", () => {
  test("returns a sound identifier unchanged — the same string, nothing trimmed", () => {
    for (const s of ["notes/x.md", "  padded  ", "x" + FEFF, "", String.fromCharCode(0xa0) + "x.md"]) expect(refuseLeadingMark(s, "path")).toBe(s);
  });

  test("throws the typed error for each mark, naming the field and the mark", () => {
    for (const [mark, code] of [[FEFF, 0xfeff], [FFFE, 0xfffe]] as const) {
      let caught: unknown;
      try { refuseLeadingMark(mark + "x.md", "path"); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(BomLeadingIdentifierError);
      const err = caught as BomLeadingIdentifierError;
      expect(err.name).toBe("BomLeadingIdentifierError");
      expect(err.field).toBe("path");
      expect(err.first).toBe(code);
      expect(err.message).toContain("path");
      expect(err.message).toContain("U+" + code.toString(16).toUpperCase());
    }
  });

  test("the message carries no mark and not the value", () => {
    let message = "";
    try { refuseLeadingMark(FEFF + "secret-name.md", "collection"); } catch (e) { message = (e as Error).message; }
    expect(message.length).toBeGreaterThan(0);
    expect(message.includes(FEFF)).toBe(false);
    expect(message).not.toContain("secret-name");
  });

  test("it is not the guard's error: one is user input, the other a missed normalisation", async () => {
    const { BomLeadingTextError } = await import("../../src/sqlite-guard.ts");
    let caught: unknown;
    try { refuseLeadingMark(FFFE + "x", "session id"); } catch (e) { caught = e; }
    expect(caught instanceof BomLeadingTextError).toBe(false);
  });
});
