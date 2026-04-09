import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";

/**
 * P0 Taxonomy regression guard (per THOTH_EXTRACTION_PLAN.md P0).
 *
 * ClawMem standardizes on `'contradicts'` (PLURAL) as the `relation_type`
 * for contradiction edges in `memory_relations`. This matches the A-MEM
 * convention used throughout `src/amem.ts` (the only writer of
 * contradiction relations at time of writing).
 *
 * These tests lock in the plural convention and prevent a future edit
 * from silently introducing `'contradict'` (singular) as either a write
 * target or a validation whitelist entry. A drift between plural/singular
 * would create orphan relation types and silent query mismatches in
 * `intent_search` / `kg_query` / graph-traversal paths.
 *
 * Out of scope for this taxonomy check (do NOT "fix" these):
 *  - `contradict_confidence` — column name on memory_relations (store.ts)
 *  - `detectContradictions` / `contradictionCount` — function and variable names
 *  - Comments containing the word "contradiction" / "contradictory"
 *  - The LLM prompt label `"contradiction"` in decision-extractor.ts — that
 *    is a classification label in a prompt, not a memory_relations write
 */

describe("contradict taxonomy — P0", () => {
  it("stores and retrieves 'contradicts' (plural) via memory_relations", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "Alpha fact" },
      { path: "b.md", title: "B", body: "Beta fact that contradicts Alpha" },
    ]);
    expect(ids).toHaveLength(2);
    const sourceId = ids[0]!;
    const targetId = ids[1]!;

    // Simulate the amem.ts write path, using the canonical PLURAL form.
    store.db
      .prepare(
        `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
         VALUES (?, ?, ?, 0.85, '{}', datetime('now'))`
      )
      .run(sourceId, targetId, "contradicts");

    // Query by the canonical plural relation type
    const rows = store.db
      .prepare(
        `SELECT source_id, target_id, relation_type
           FROM memory_relations
          WHERE relation_type = 'contradicts'`
      )
      .all() as { source_id: number; target_id: number; relation_type: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe(sourceId);
    expect(rows[0]!.target_id).toBe(targetId);
    expect(rows[0]!.relation_type).toBe("contradicts");
  });

  it("singular 'contradict' returns zero matches — non-canonical", () => {
    const store = createTestStore();
    const ids = seedDocuments(store, [
      { path: "a.md", title: "A", body: "A" },
      { path: "b.md", title: "B", body: "B" },
    ]);

    // Write using the canonical plural form
    store.db
      .prepare(
        `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
         VALUES (?, ?, ?, 0.85, '{}', datetime('now'))`
      )
      .run(ids[0], ids[1], "contradicts");

    // A query for the singular form must return zero rows
    const countRow = store.db
      .prepare(
        `SELECT COUNT(*) as n
           FROM memory_relations
          WHERE relation_type = 'contradict'`
      )
      .get() as { n: number };
    expect(countRow.n).toBe(0);
  });

  it("amem.ts whitelist contains 'contradicts' (plural) and no singular form", () => {
    // Source-level guard: if someone refactors amem.ts and introduces
    // 'contradict' (singular) as a validation whitelist entry or a relation
    // type literal, this test fails loudly. `contradict_confidence` is the
    // column name and is NOT a string literal `'contradict'`, so it is
    // unaffected by the regex checks below.
    const amemSrc = readFileSync(
      join(import.meta.dir, "../../src/amem.ts"),
      "utf-8"
    );

    // The plural form must appear (it is the canonical relation type)
    expect(amemSrc).toContain("'contradicts'");

    // Singular string literal must never appear. Both single- and double-
    // quoted forms are checked. These regexes do NOT match 'contradicts'
    // (plural) because the closing quote immediately follows `t` in the
    // singular form; the plural form has `s'` instead.
    expect(amemSrc).not.toMatch(/'contradict'/);
    expect(amemSrc).not.toMatch(/"contradict"/);
  });

  it("repo-wide source scan: no 'contradict' singular literal in any src/**/*.ts (incl. backticks)", () => {
    // Broader guard than the amem.ts-only check above. Scans every
    // TypeScript source file under `src/` for a singular `'contradict'`,
    // `"contradict"`, or `` `contradict` `` literal. This catches
    // regressions introduced in files the original audit didn't cover
    // (e.g. a new writer in consolidation.ts, entity.ts, or any new
    // module) and catches backtick template literals the original
    // amem.ts-only check would miss.
    //
    // Intentionally excluded from matching:
    //  - `contradict_confidence` (column name — no surrounding quotes)
    //  - `detectContradictions`, `contradictionCount`, etc. (function /
    //    variable names — no surrounding quotes around the EXACT word
    //    `contradict`)
    //  - The word "contradiction" / "contradictory" in comments or
    //    prompt text (no closing quote immediately after `contradict`)
    //  - The plural literal `'contradicts'` / `"contradicts"` /
    //    `` `contradicts` `` (closing quote is preceded by `s`, not `t`)
    const srcDir = join(import.meta.dir, "../../src");
    const files = walkTypeScriptSources(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const patterns: Array<{ name: string; regex: RegExp }> = [
      { name: "single-quoted", regex: /'contradict'/ },
      { name: "double-quoted", regex: /"contradict"/ },
      // eslint-disable-next-line no-template-curly-in-string
      { name: "backtick", regex: /`contradict`/ },
    ];

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const { name, regex } of patterns) {
        if (regex.test(content)) {
          violations.push(`${file}: matches ${name} /${regex.source}/`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

/**
 * Recursively walk a directory and return all `.ts` files excluding
 * `.test.ts` and `.d.ts`. Skips `node_modules`, `dist`, `build`, and
 * any directory beginning with `.`.
 */
function walkTypeScriptSources(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules" || name === "dist" || name === "build") continue;
    const full = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkTypeScriptSources(full));
    } else if (
      stat.isFile() &&
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}
