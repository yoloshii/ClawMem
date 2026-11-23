/**
 * BACKLOG 82.3, D7 — an IDENTIFIER that starts with a byte-order mark is refused, never stripped. The indexer:
 * a file whose relative path starts with U+FEFF or U+FFFE is skipped with one warning line and counted
 * (`stats.refused`); a collection name that starts with one is refused with the typed error before anything is
 * read. `x.md` and a mark followed by `x.md` are two files: the row of `x.md` is never touched for the other one.
 *
 * No mark is typed into this file: each is built with `String.fromCharCode`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createStore, type Store } from "../../src/store.ts";
import { indexCollection, resetRefusedPathWarnings } from "../../src/indexer.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { BomLeadingIdentifierError } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];

const ROOT = "/tmp/clawmem-identifier-refusal-indexer-test";
const CONTENT = `${ROOT}/content`;

const deadLlm = {
  embed: async () => { throw new Error("no embedding endpoint in test"); },
  query: async () => null,
  expandQuery: async () => [],
} as any;

let store: Store;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(CONTENT, { recursive: true });
  setDefaultLlamaCpp(deadLlm);
  store = createStore(`${ROOT}/vault.sqlite`);
  warn = spyOn(console, "warn").mockImplementation(() => {});
  resetRefusedPathWarnings();                                              // each test sees the first warning of its file
});

afterEach(() => {
  warn.mockRestore();
  try { store.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  rmSync(ROOT, { recursive: true, force: true });
});

type Row = { id: number; path: string; hash: string; title: string; active: number; origin: string | null; deactivated_reason: string | null; archived_at: string | null; content_hash: string | null; modified_at: string };
const rows = (): Row[] =>
  store.db.prepare(`SELECT id, path, hash, title, active, origin, deactivated_reason, archived_at, content_hash, modified_at FROM documents WHERE collection = 'docs' ORDER BY id`).all() as Row[];
const contentRows = (): number => (store.db.prepare(`SELECT COUNT(*) AS n FROM content`).get() as { n: number }).n;
/** The warning lines that speak of a byte-order mark. */
const markWarnings = (): string[] =>
  warn.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).filter((line: string) => line.includes("byte-order mark"));

describe("a file whose path starts with a mark is skipped and counted", () => {
  test.each(MARKS)("%s: beside x.md, the marked file is refused and x.md is indexed alone", async (_name, mark) => {
    writeFileSync(`${CONTENT}/x.md`, "# The real one\n\nbody of x\n");
    writeFileSync(`${CONTENT}/${mark}x.md`, "# The other one\n\na different body\n");
    const stats = await indexCollection(store, "docs", CONTENT, "**/*.md");

    expect(stats.refused).toBe(1);
    expect(stats.added).toBe(1);
    expect(rows().map(r => r.path)).toEqual(["x.md"]);
    expect(rows()[0]!.title).toBe("The real one");
    expect(contentRows()).toBe(1);                                         // the other body was never stored
    const lines = markWarnings();
    expect(lines.length).toBe(1);                                          // ONE line for the one file
    expect(lines[0]).toContain("x.md");
    expect(lines[0]).not.toContain(mark);                                  // the mark is named, not printed
  });

  // The two files reach the loop in either order: an explicit list gives each order.
  test.each(MARKS)("%s: the same in both processing orders", async (_name, mark) => {
    for (const pattern of ["{x.md,*.md}", "{?x.md,x.md}"]) {
      rmSync(ROOT, { recursive: true, force: true });
      mkdirSync(CONTENT, { recursive: true });
      try { store.close(); } catch { /* already closed */ }
      store = createStore(`${ROOT}/vault.sqlite`);
      writeFileSync(`${CONTENT}/x.md`, "# The real one\n\nbody of x\n");
      writeFileSync(`${CONTENT}/${mark}x.md`, "# The other one\n\na different body\n");
      const stats = await indexCollection(store, "docs", CONTENT, pattern);
      expect(stats.refused, pattern).toBe(1);
      expect(rows().map(r => [r.path, r.title]), pattern).toEqual([["x.md", "The real one"]]);
    }
  });

  test.each(MARKS)("%s: a second pass leaves x.md's row as it was, and refuses again", async (_name, mark) => {
    writeFileSync(`${CONTENT}/x.md`, "# The real one\n\nbody of x\n");
    await indexCollection(store, "docs", CONTENT, "**/*.md");
    const before = rows();
    writeFileSync(`${CONTENT}/${mark}x.md`, "# The other one\n\na different body\n");
    const stats = await indexCollection(store, "docs", CONTENT, "**/*.md");
    expect(stats).toMatchObject({ refused: 1, added: 0, updated: 0, removed: 0, unchanged: 1 });
    expect(rows()).toEqual(before);
  });

  test.each(MARKS)("%s: x.md forgotten, or archived — its row and state stay, and no row is made for the other", async (_name, mark) => {
    for (const state of ["forget", "archive"] as const) {
      rmSync(ROOT, { recursive: true, force: true });
      mkdirSync(CONTENT, { recursive: true });
      try { store.close(); } catch { /* already closed */ }
      store = createStore(`${ROOT}/vault.sqlite`);
      writeFileSync(`${CONTENT}/x.md`, "# The real one\n\nbody of x\n");
      await indexCollection(store, "docs", CONTENT, "**/*.md");
      if (state === "forget") store.db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'forget' WHERE path = 'x.md'`).run();
      else store.db.prepare(`UPDATE documents SET active = 0, archived_at = '2026-11-01T00:00:00.000Z', deactivated_reason = 'archive' WHERE path = 'x.md'`).run();
      const before = rows();
      writeFileSync(`${CONTENT}/${mark}x.md`, "# The other one\n\na different body\n");
      const stats = await indexCollection(store, "docs", CONTENT, "**/*.md");
      expect(stats.refused, state).toBe(1);
      expect(rows(), state).toEqual(before);
      expect(contentRows(), state).toBe(1);
    }
  });

  // Ruling 44 A: under the watcher a pass runs on every change in the collection.
  test.each(MARKS)("%s: every pass counts the file; the process warns about it once", async (_name, mark) => {
    writeFileSync(`${CONTENT}/${mark}x.md`, "# The other one\n\nbody\n");
    writeFileSync(`${CONTENT}/${mark}y.md`, "# A second one\n\nbody\n");
    for (let pass = 1; pass <= 3; pass++) {
      const stats = await indexCollection(store, "docs", CONTENT, "**/*.md");
      expect(stats.refused, `pass ${pass}`).toBe(2);
      expect(markWarnings().length, `pass ${pass}`).toBe(2);               // one line per FILE, not per pass
    }
    await indexCollection(store, "other", CONTENT, "**/*.md");             // the same file name in another collection
    expect(markWarnings().length).toBe(4);
  });

  test.each(MARKS)("%s: the marked file alone — nothing is written", async (_name, mark) => {
    writeFileSync(`${CONTENT}/${mark}${mark}only.md`, "# Alone\n\nbody\n");   // two marks: SQLite would store this path with one
    const stats = await indexCollection(store, "docs", CONTENT, "**/*.md");
    expect(stats).toMatchObject({ refused: 1, added: 0 });
    expect(rows()).toEqual([]);
    expect(contentRows()).toBe(0);
  });

  test.each(MARKS)("%s: a mark that is NOT at the start of the path is an ordinary name", async (_name, mark) => {
    mkdirSync(`${CONTENT}/sub`, { recursive: true });
    writeFileSync(`${CONTENT}/sub/${mark}inner.md`, "# Inner\n\nbody\n");
    writeFileSync(`${CONTENT}/mid${mark}dle.md`, "# Middle\n\nbody two\n");
    const stats = await indexCollection(store, "docs", CONTENT, "**/*.md");
    expect(stats).toMatchObject({ refused: 0, added: 2 });
    expect(rows().map(r => r.path).sort()).toEqual([`mid${mark}dle.md`, `sub/${mark}inner.md`].sort());
    expect(markWarnings()).toEqual([]);
  });
});

describe("a collection name that starts with a mark is refused before anything is read", () => {
  test.each(MARKS)("%s", async (_name, mark) => {
    writeFileSync(`${CONTENT}/x.md`, "# The real one\n\nbody of x\n");
    let thrown: unknown;
    try { await indexCollection(store, mark + "docs", CONTENT, "**/*.md"); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BomLeadingIdentifierError);
    expect((thrown as BomLeadingIdentifierError).field).toBe("collection");
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM documents`).get() as { n: number }).n).toBe(0);
    expect(contentRows()).toBe(0);
  });
});
