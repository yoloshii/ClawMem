/**
 * BACKLOG 82.2, D1 — a source guard: nothing under `src/` builds its own `Float32Array` from data outside
 * `vector-guard.ts`. An embedding response is converted ONLY by `storableVector`, a stored blob ONLY by
 * `storedVector`. Every `new Float32Array(` elsewhere must be one of the listed forms (a fixed-size or empty
 * array that holds no outside data); a new site fails here until it is listed with its reason.
 * Fails on v0.43.6 (seven conversions of responses and blobs at the callers).
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(import.meta.dir, "../../src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
/** file → the exact constructions it may hold, each with why it holds no outside data. */
const ALLOWED: Record<string, Record<string, string>> = {
  "store.ts": { "new Float32Array(dim)": "prewarmVectors: an all-zero query of the table's dimension, never stored" },
  "graph-traversal.ts": { "new Float32Array(0)": "an empty array = no usable vector (affinity 0)" },
};

describe("no unvalidated vector conversion under src/", () => {
  it("every `new Float32Array(` outside vector-guard.ts is a listed, data-free form", () => {
    const found: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      if (rel === "vector-guard.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/new Float32Array\(([^)]*)\)?/g)) {
        const form = `new Float32Array(${m[1]})`;
        if (!ALLOWED[rel]?.[form]) found.push(`${rel}: ${form}`);
      }
      // The other ways to build one: none is used under src/, and none may appear.
      for (const m of text.matchAll(/Float32Array\s*\.\s*(from|of)\s*\(|new\s+Float32Array\s*\(/g)) {
        if (m[0] !== "new Float32Array(") found.push(`${rel}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the allowlist names only forms that still exist", () => {
    for (const [rel, forms] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(SRC, rel), "utf8");
      for (const form of Object.keys(forms)) expect(text.includes(form) ? form : `${rel}: ${form} is gone`).toBe(form);
    }
  });
});
