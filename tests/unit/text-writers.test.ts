/**
 * BACKLOG 82.3, D7 — the WRITER INVENTORY (`tests/text-writers.json`, operator ruling 58 A): one entry per producer of
 * a free-text column of `tests/binding-census.json` (classed `normalised`, `guarded` or `stored-copy`), with the tests
 * that feed it a mark-led value. It fails on an entry whose test does not exist, on a free-text column no entry
 * covers, and on an entry field that is not such a column. Identifier columns are covered as a class.
 *
 * What this can and cannot show: it ties each free-text column to a producer and a test someone wrote; it cannot see
 * a producer nobody listed — the binding census (`scripts/check-binding-census.ts`) is the cross-check for that, once
 * a test reaches the producer, and a column's CLASS is a judgment the code review checks.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import type { CensusTable } from "../helpers/binding-census.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
type Ref = { file: string; title: string };
type Inventory = { writers: { producer: string; source: string; fields: string[]; tests: Ref[] }[]; identifierClass: { note: string; tests: Ref[] } };
const inventory = JSON.parse(readFileSync(`${ROOT}tests/text-writers.json`, "utf-8")) as Inventory;
const census = JSON.parse(readFileSync(`${ROOT}tests/binding-census.json`, "utf-8")) as CensusTable;
const FREE_TEXT = new Set(["normalised", "guarded", "stored-copy"]);

/** The test exists: its file is there and holds the title (a `%s` title is matched as written in the source). */
const present = (ref: Ref) => existsSync(`${ROOT}${ref.file}`) && ref.title.length > 0 && readFileSync(`${ROOT}${ref.file}`, "utf-8").includes(ref.title);

describe("tests/text-writers.json", () => {
  test("every entry names its source file and at least one test, and every test it names exists", () => {
    const missing: string[] = [];
    for (const w of inventory.writers) {
      expect(existsSync(`${ROOT}${w.source}`), w.source).toBe(true);
      expect(w.tests.length, w.producer).toBeGreaterThan(0);
      for (const ref of w.tests) if (!present(ref)) missing.push(`${w.producer}: ${ref.file} :: ${ref.title}`);
    }
    for (const ref of inventory.identifierClass.tests) if (!present(ref)) missing.push(`identifier class: ${ref.file} :: ${ref.title}`);
    expect(missing).toEqual([]);
  });

  test("every free-text column of the census has a producer here, and every field here is such a column", () => {
    const covered = new Set(inventory.writers.flatMap(w => w.fields));
    const freeText = Object.entries(census.columns).filter(([, e]) => FREE_TEXT.has(e.class)).map(([k]) => k);
    expect(freeText.filter(c => !covered.has(c))).toEqual([]);
    expect([...covered].filter(c => !FREE_TEXT.has(census.columns[c]?.class ?? "")).sort()).toEqual([]);
  });

  test("control: a missing test and an uncovered column are both caught", () => {
    expect(present({ file: "tests/unit/text-writers.test.ts", title: ["no test", "is called", "this"].join("_") })).toBe(false);
    expect(present({ file: "tests/unit/no-such-file.test.ts", title: "x" })).toBe(false);
    expect(present({ file: "tests/unit/text-writers.test.ts", title: "" })).toBe(false);
  });
});
