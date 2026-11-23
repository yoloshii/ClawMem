/**
 * BACKLOG 82.3, D7 — identity-preserving parsing is held by a census: every comma split under `src/` is listed in
 * `tests/list-splits.json` with what it splits. A caller-supplied list of selectors or collection names is split in
 * ONE place (`src/selector.ts`). A new split fails this test until someone classes it — and a split of such a list
 * that trims with `String.trim()` (which removes U+FEFF) cannot be added unseen.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const SPLIT = /\.split\(\s*(","|','|\/,\/)/;

const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);

type Entry = { file: string; code: string; kind: string; why: string };
const table = JSON.parse(readFileSync(join(ROOT, "tests/list-splits.json"), "utf-8")) as { splits: Entry[] };
const key = (file: string, code: string) => `${file} :: ${code}`;

describe("the census of comma splits under src/", () => {
  const found: string[] = [];
  for (const file of sources("src")) {
    for (const line of readFileSync(join(ROOT, file), "utf-8").split("\n")) {
      if (SPLIT.test(line)) found.push(key(file, line.trim()));
    }
  }

  test("every split in the source is listed, and every listed split is in the source", () => {
    expect(found.sort()).toEqual(table.splits.map(e => key(e.file, e.code)).sort());
  });

  test("every entry says what it splits", () => {
    for (const e of table.splits) {
      expect(e.kind.length, e.code).toBeGreaterThan(0);
      expect(e.why.length, e.code).toBeGreaterThan(20);
    }
  });

  test("only src/selector.ts splits a caller-supplied list of selectors or collection names", () => {
    const parsers = table.splits.filter(e => e.kind === "identity-preserving parser");
    expect(parsers.map(e => e.file)).toEqual(["src/selector.ts"]);
    // no other entry may name a collection or a selector argument
    for (const e of table.splits) {
      if (e.kind === "identity-preserving parser") continue;
      expect(/collection\.split|pattern\.split\(',?'?\)|body\.collection/.test(e.code), e.code).toBe(false);
    }
  });
});
