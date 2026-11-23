/**
 * BACKLOG 82.3, D6 — the source guard: in the shipped roots (`package.json` "files": bin/, src/, extras/) a database
 * handle is made in ONE place, `src/sqlite-guard.ts`. A constructor call, a static opener or a native handle
 * anywhere else is a handle the guard does not cover.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "../..");
const SHIPPED = ["bin", "src", "extras"];
const FACTORY = "src/sqlite-guard.ts";
const FORBIDDEN: [string, RegExp][] = [
  ["a Database constructor call", /\bnew\s+(?:Guarded)?Database\s*\(/],
  ["the static opener Database.open", /\bDatabase\s*\.\s*open\s*\(/],
  ["the static opener Database.deserialize", /\bDatabase\s*\.\s*deserialize\s*\(/],
  ["a native handle", /\.\s*(?:native|handle)\b(?!\s*:)/],
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__pycache__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) || dir.endsWith("/bin")) out.push(path);
  }
  return out;
}

describe("database handles in the shipped roots", () => {
  const all = SHIPPED.flatMap(root => files(join(ROOT, root))).map(path => relative(ROOT, path));

  it("the roots are the package's shipped code roots, and the scan reads them", () => {
    const shipped = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files as string[])
      .filter(entry => entry.endsWith("/") && entry !== "docs/").map(entry => entry.slice(0, -1)).sort();
    expect(shipped).toEqual([...SHIPPED].sort());
    expect(all).toContain(FACTORY);
    expect(all).toContain("src/store.ts");
    expect(all.length).toBeGreaterThan(50);
  });

  it("no file but the factory makes a handle or reaches a native one", () => {
    const hits: string[] = [];
    for (const file of all) {
      if (file === FACTORY) continue;
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        for (const [what, pattern] of FORBIDDEN) if (pattern.test(code)) hits.push(`${file}:${i + 1}: ${what}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the patterns see what they are for", () => {
    const sample = ["const db = new Database(path);", "new GuardedDatabase(p)", "Database.open(p)", "Database .deserialize(buf)", "st.native", "db.handle"];
    for (const line of sample) expect(FORBIDDEN.some(([, pattern]) => pattern.test(line))).toBe(true);
    for (const line of ["openDatabase(path)", "import { Database } from \"bun:sqlite\";", "function handle(req) {}", "{ native: true }"]) {
      expect(FORBIDDEN.some(([, pattern]) => pattern.test(line))).toBe(false);
    }
  });
});
