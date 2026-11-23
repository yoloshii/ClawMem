/**
 * BACKLOG 82.3, D7 — SELECTORS (what names a document or a set) follow the identifier policy: parsed without loss,
 * then REFUSED when the whole selector, its collection or its path starts with a byte-order mark. Never stripped:
 * neither U+FEFF + `x.md` nor U+FFFE + `x.md` may ever read `x.md`.
 *
 * Store level: `findDocument`, `findDocuments` (a comma list, a glob), `findDocumentByDocid`.
 * Operator ruling 46 A: `collection/path` is split at the FIRST slash, so the bare selector `sub/<mark>x.md` is
 * refused although such a path can be stored; `collection/sub/<mark>x.md` and the docid still reach the document.
 *
 * No mark is typed into this file: each is built with `String.fromCharCode`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createStore, type Store } from "../../src/store.ts";
import { BomLeadingIdentifierError, normalizedContent } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const NBSP = String.fromCharCode(0xa0);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];

const ROOT = "/tmp/clawmem-selector-wiring-test";
const NOW = "2026-11-22T00:00:00.000Z";
let store: Store;
let savedConfigDir: string | undefined;

const add = (collection: string, path: string, text: string): string => {
  const { body, hash } = normalizedContent(text);
  store.insertContent(hash, body, NOW);
  store.insertDocument(collection, path, path, hash, NOW, NOW);
  return hash;
};

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${ROOT}/config`, { recursive: true });
  mkdirSync(`${ROOT}/notes-root`, { recursive: true });
  writeFileSync(`${ROOT}/config/config.yaml`, `collections:\n  notes:\n    path: ${ROOT}/notes-root\n    pattern: "**/*.md"\n`);
  savedConfigDir = process.env.CLAWMEM_CONFIG_DIR;
  process.env.CLAWMEM_CONFIG_DIR = `${ROOT}/config`;
  store = createStore(`${ROOT}/vault.sqlite`);
  add("notes", "x.md", "THE REAL X: the body of x.md");
  add("notes", "y.md", "the body of y.md");
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  if (savedConfigDir === undefined) delete process.env.CLAWMEM_CONFIG_DIR; else process.env.CLAWMEM_CONFIG_DIR = savedConfigDir;
  rmSync(ROOT, { recursive: true, force: true });
});

/** The typed refusal, with its field; anything else (a result, another error class) fails the test. */
function refused(run: () => unknown, field?: string): void {
  let thrown: unknown, got: unknown;
  try { got = run(); } catch (e) { thrown = e; }
  expect(got === undefined ? "nothing returned" : JSON.stringify(got).slice(0, 200)).toBe("nothing returned");
  expect(thrown).toBeInstanceOf(BomLeadingIdentifierError);
  if (field) expect((thrown as BomLeadingIdentifierError).field).toBe(field);
}

describe("findDocument refuses a marked selector in every form", () => {
  test.each(MARKS)("%s: a bare path, a display path, a virtual path — the whole, the collection or the path marked", (_name, mark) => {
    refused(() => store.findDocument(mark + "x.md", { includeBody: true }), "selector");
    refused(() => store.findDocument(mark + "notes/x.md"), "selector");
    refused(() => store.findDocument("notes/" + mark + "x.md"), "path");
    refused(() => store.findDocument("clawmem://notes/" + mark + "x.md"), "path");
    refused(() => store.findDocument("clawmem://" + mark + "notes/x.md"), "collection");
    refused(() => store.findDocument("//notes/" + mark + "x.md"), "path");
    refused(() => store.findDocument("clawmem:////" + mark + "notes/x.md"), "collection");
    refused(() => store.findDocument(mark + "clawmem://notes/x.md"), "selector");
    refused(() => store.findDocument(mark + mark + "x.md"), "selector");
  });

  test.each(MARKS)("%s: with a line suffix, and as an absolute path inside a collection root", (_name, mark) => {
    refused(() => store.findDocument(mark + "x.md:12"), "selector");
    refused(() => store.findDocument("notes/" + mark + "x.md:3"), "path");
    refused(() => store.findDocument(`${ROOT}/notes-root/${mark}x.md`), "path");
  });

  test("the sound selectors still find x.md", () => {
    for (const selector of ["notes/x.md", "clawmem://notes/x.md", "//notes/x.md", "x.md", "notes/x.md:2", `${ROOT}/notes-root/x.md`]) {
      const got = store.findDocument(selector, { includeBody: true });
      expect("error" in got ? `not found: ${selector}` : got.displayPath).toBe("notes/x.md");
    }
  });

  // Ruling 46 A — the stated side effect, and the two ways that still reach such a document.
  test.each(MARKS)("%s: a stored path with the mark after a folder — refused as a bare selector, found by its full name and its docid", (_name, mark) => {
    const hash = add("notes", `sub/${mark}inner.md`, "the body of the inner file");
    refused(() => store.findDocument(`sub/${mark}inner.md`), "path");               // read as collection `sub`, path marked
    const full = store.findDocument(`notes/sub/${mark}inner.md`);
    expect("error" in full ? "not found" : full.displayPath).toBe(`notes/sub/${mark}inner.md`);
    const virtual = store.findDocument(`clawmem://notes/sub/${mark}inner.md`);
    expect("error" in virtual ? "not found" : virtual.displayPath).toBe(`notes/sub/${mark}inner.md`);
    const byId = store.findDocument("#" + hash.slice(0, 6));
    expect("error" in byId ? "not found" : byId.displayPath).toBe(`notes/sub/${mark}inner.md`);
  });

  test.each(MARKS)("%s: a mark in the middle of a name is an ordinary character", (_name, mark) => {
    add("notes", `mid${mark}dle.md`, "the body of the middle file");
    const got = store.findDocument(`notes/mid${mark}dle.md`);
    expect("error" in got ? "not found" : got.displayPath).toBe(`notes/mid${mark}dle.md`);
  });
});

describe("findDocuments refuses a marked element of a list, and a marked glob", () => {
  test.each(MARKS)("%s: one marked element, first or last, padded or not — never x.md", (_name, mark) => {
    refused(() => store.findDocuments(mark + "x.md,missing.md", { includeBody: true }), "selector");
    refused(() => store.findDocuments("missing.md, " + mark + "x.md"), "selector");
    refused(() => store.findDocuments(" \t" + mark + "x.md ,y.md"), "selector");
    refused(() => store.findDocuments("notes/y.md,notes/" + mark + "x.md"), "path");
    refused(() => store.findDocuments("clawmem://notes/y.md,clawmem://" + mark + "notes/x.md"), "collection");
  });

  test.each(MARKS)("%s: a glob", (_name, mark) => {
    refused(() => store.findDocuments(mark + "*.md"), "selector");
    refused(() => store.findDocuments("notes/" + mark + "*.md"), "path");
    refused(() => store.findDocuments("clawmem://notes/" + mark + "*.md"), "path");
  });

  test("a sound list and a sound glob work as before; ASCII padding is stripped, other white space is not", () => {
    const list = store.findDocuments(" notes/x.md ,\tnotes/y.md\n", { includeBody: true });
    expect(list.errors).toEqual([]);
    expect(list.docs.map(d => d.doc.displayPath).sort()).toEqual(["notes/x.md", "notes/y.md"]);
    const glob = store.findDocuments("*.md");
    expect(glob.docs.length).toBe(2);
    const padded = store.findDocuments(NBSP + "notes/x.md,notes/y.md");            // a no-break space is not padding: it names nothing
    expect(padded.docs.map(d => d.doc.displayPath)).toEqual(["notes/y.md"]);
    expect(padded.errors.length).toBe(1);
  });
});

describe("findDocumentByDocid refuses a marked docid", () => {
  test.each(MARKS)("%s", (_name, mark) => {
    const hash = normalizedContent("THE REAL X: the body of x.md").hash;
    refused(() => store.findDocumentByDocid(mark + hash.slice(0, 6)), "docid");
    refused(() => store.findDocumentByDocid(mark + "#" + hash.slice(0, 6)), "docid");
    expect(store.findDocumentByDocid("#" + hash.slice(0, 6))?.filepath).toBe("clawmem://notes/x.md");
    expect(store.findDocumentByDocid("#" + mark + hash.slice(0, 6))).toBeNull();     // not a docid: not found, as before
  });
});
