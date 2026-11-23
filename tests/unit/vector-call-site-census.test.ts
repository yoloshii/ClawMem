/**
 * BACKLOG 82.2, D4 — the call-site census. Every call under `src/` of a vector search, of the fatal-vector rethrow,
 * and every DIRECT embedding call outside `llm.ts`, is listed in `tests/vector-call-sites.json` with the row of the
 * design's route table that says what the site does when the QUERY vector is refused. A call that is not in the
 * table — or a table entry with no call — fails here, so a new vector route cannot be added without deciding its
 * outcome.
 *
 * The table lists, per file and per callee, the route of each call IN SOURCE ORDER.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const TABLE = JSON.parse(readFileSync(join(ROOT, "tests", "vector-call-sites.json"), "utf8")) as {
  routes: Record<string, string>;
  search: Record<string, Record<string, string[]>>;
  embedding: Record<string, Record<string, string[]>>;
};

const SEARCH_CALLEES = [
  "searchVec", "searchVecWithFaults", "searchVecDetailed", "searchVecDetailedWithVector", "searchVecMatch", "searchVecBounded",
  "searchVecDaemonRequired", "daemonVecMatch", "rethrowIfFatalVectorError", "restVectorLeg", "cliVectorLeg",
];
const EMBED_CALLEES = ["embed", "embedBatch", "getEmbedding"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith(".ts") ? [path] : [];
  }).sort();
}

/** Code lines only: block and line comments are blanked (a call named in a comment is not a call). */
function code(text: string): string[] {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
  return withoutBlocks.split("\n").map(line => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, ""));
}

/** `callee(` as a CALL: not its own definition, not a type member, not a method shorthand of the store object. */
function calls(lines: string[], callee: string, method: boolean): number[] {
  const call = new RegExp(method ? `\\.${callee}\\(` : `(?<![A-Za-z0-9_$])${callee}\\(`);
  const definition = new RegExp(
    `function\\s+${callee}\\(|^\\s*(async\\s+)?${callee}\\([^)]*\\)\\s*[:{]|^\\s*${callee}:\\s*\\(|^\\s*${callee}\\(.*\\):\\s*Promise<`);
  const found: number[] = [];
  lines.forEach((line, i) => { if (call.test(line) && !definition.test(line)) found.push(i + 1); });
  return found;
}

function census(callees: string[], method: (callee: string) => boolean, skip: (file: string) => boolean) {
  const out: Record<string, Record<string, number[]>> = {};
  for (const path of sourceFiles(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    if (skip(file)) continue;
    const lines = code(readFileSync(path, "utf8"));
    for (const callee of callees) {
      const at = calls(lines, callee, method(callee));
      if (at.length) (out[file] ??= {})[callee] = at;
    }
  }
  return out;
}

function compare(found: Record<string, Record<string, number[]>>, table: Record<string, Record<string, string[]>>): string[] {
  const problems: string[] = [];
  const keys = new Set([...Object.keys(found), ...Object.keys(table)]);
  for (const file of keys) {
    const callees = new Set([...Object.keys(found[file] ?? {}), ...Object.keys(table[file] ?? {})]);
    for (const callee of callees) {
      const at = found[file]?.[callee] ?? [];
      const listed = table[file]?.[callee] ?? [];
      if (at.length !== listed.length) {
        problems.push(`${file}: ${at.length} call(s) of ${callee} (lines ${at.join(", ") || "-"}), ${listed.length} listed`);
      }
      for (const route of listed) if (!(route in TABLE.routes)) problems.push(`${file}: ${callee} names an unknown route "${route}"`);
    }
  }
  return problems;
}

describe("vector call-site census (D4)", () => {
  it("every vector search call and every fatal-vector rethrow under src/ is listed with its route", () => {
    const found = census(SEARCH_CALLEES, () => false, () => false);
    expect(compare(found, TABLE.search)).toEqual([]);
  });

  it("every direct embedding call outside llm.ts is listed with its route", () => {
    const found = census(EMBED_CALLEES, callee => callee !== "getEmbedding", file => file === "src/llm.ts");
    expect(compare(found, TABLE.embedding)).toEqual([]);
  });

  it("the census finds the calls it is meant to find (it cannot pass by finding nothing)", () => {
    const found = census(SEARCH_CALLEES, () => false, () => false);
    expect(found["src/mcp.ts"]?.["searchVecDetailed"]?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(found["src/server.ts"]?.["restVectorLeg"]?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(calls(code("  // searchVec(x)\n  /* searchVec(y) */\n  await s.searchVec(q);\n"), "searchVec", false)).toEqual([3]);
    expect(calls(code("export async function searchVec(db) {\n"), "searchVec", false)).toEqual([]);
  });

  it("no source route calls the plain `searchVec`, which drops the fault count (operator ruling 16 B)", () => {
    const found = census(["searchVec"], () => false, () => false);
    // `store.ts` holds the one call: the compatibility wrapper's own member on the store object.
    expect(Object.keys(found).filter(file => file !== "src/store.ts")).toEqual([]);
  });

  it("every route of the table is used, and every route has an outcome", () => {
    const used = new Set([...Object.values(TABLE.search), ...Object.values(TABLE.embedding)].flatMap(byCallee => Object.values(byCallee).flat()));
    expect(Object.keys(TABLE.routes).filter(route => !used.has(route))).toEqual([]);
    expect(Object.values(TABLE.routes).every(outcome => typeof outcome === "string" && outcome.length > 20)).toBe(true);
  });
});
