#!/usr/bin/env bun
/**
 * BACKLOG 82.3, D7 — the whole-suite binding census check (operator ruling 49 A: writing statements only, classed
 * per table column). Record a census, then compare it with `tests/binding-census.json`:
 *
 *   CLAWMEM_TEST_BINDING_CENSUS=1 CLAWMEM_TEST_BINDING_CENSUS_FILE=/tmp/census.jsonl bun test
 *   bun scripts/check-binding-census.ts /tmp/census.jsonl
 *
 * Exit 1 when a written column of a vault table has no class, a classed column was not written by any test, or a
 * writing statement could not be read. A run of only part of the suite reaches only part of the columns: compare
 * a recording of the WHOLE suite (several `bun test` runs may append to one file).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore } from "../src/store.ts";
import { compareCensus, readCensus, vaultColumnsOf, type CensusTable } from "../tests/helpers/binding-census.ts";

const file = process.argv[2];
if (!file) { console.error("usage: bun scripts/check-binding-census.ts <census.jsonl>"); process.exit(2); }

const root = new URL("..", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const sources = walk(join(root, "src")).map(p => readFileSync(p, "utf-8"));
const table = JSON.parse(readFileSync(join(root, "tests/binding-census.json"), "utf-8")) as CensusTable;

const dir = mkdtempSync(join(tmpdir(), "clawmem-census-"));
const store = createStore(join(dir, "vault.sqlite"));
let failed = false;
try {
  store.ensureVecTable(4);
  const fresh = (t: string) => (store.db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all() as { name: string }[]).map(r => r.name);
  const out = compareCensus(readCensus(readFileSync(file, "utf-8")), table, vaultColumnsOf(fresh, sources));
  console.log(`written vault columns reached: ${out.reached.length}; classed: ${Object.keys(table.columns).length}`);
  if (out.outsideVault.length) console.log(`not vault tables (test scaffolding), not compared: ${out.outsideVault.join(", ")}`);
  if (out.testOnly.length) console.log(`written only by tests' own SQL (not counted as reached): ${out.testOnly.join(", ")}`);
  for (const u of out.unclassed) console.log(`UNCLASSED ${u.column}  ← ${u.statement.slice(0, 160)}`);
  for (const c of out.unreached) console.log(`UNREACHED ${c} (classed, but no test wrote it)`);
  for (const u of out.unreadable) console.log(`UNREADABLE (${u.reason}) ${u.statement.slice(0, 160)}`);
  failed = out.unclassed.length + out.unreached.length + out.unreadable.length > 0;
  console.log(failed ? "binding census: FAIL" : "binding census: OK");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
