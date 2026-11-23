/**
 * BACKLOG 82.2, D4 — the CLI rows of the route table, on the REAL `clawmem vsearch` and `clawmem query` against a
 * scripted `/v1/embeddings`:
 *  - `vsearch` promises a cosine ranking: a refused QUERY vector is an explicit "vector search unavailable" error
 *    (exit 1), never lexical scores under a cosine label;
 *  - `query` is hybrid: a refused query vector leaves the vector lists empty, the lexical results print, ONE warning
 *    line goes to stderr, exit 0; `--json` stays a bare array when nothing was degraded and is an object
 *    `{ degraded, degradedReason, results }` when something was (operator ruling 25 A);
 *  - stored vectors the scan skipped as unusable are counted and reported (rulings 16 B and 17 A).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { bow, deadPort, startEmbedFixture, type EmbedFixture, type Phase } from "../helpers/embed-readiness-fixture.ts";
import { cliVectorLeg, cliVectorReport, VECTOR_SEARCH_UNAVAILABLE } from "../../src/cli-vector-leg.ts";
import { VecPoisonError, EmbedEnvelopeError } from "../../src/vector-guard.ts";

import { seedContent } from "../helpers/seed-content.ts";
const ROOT = join(import.meta.dir, "../..");
const MODEL = "bow-embed";
const POISON = [null, ...new Array(63).fill(1)];
const UNAVAILABLE = "vector search unavailable: the embedding endpoint returned a malformed vector";
const DOCS: Record<string, string> = {
  "tank.md": "The tank filter is cleaned every week and the tank water is changed.",
  "pump.md": "A pump moves water through the filter of the tank at night.",
  "garden.md": "The garden beds are watered in the morning before the sun is high.",
};

let home: string;
let vault: string;
let dead: number;
const fixtures: EmbedFixture[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "clawmem-822-cli-")); vault = resolve(home, "vault.sqlite"); dead = deadPort(); });
afterEach(() => { for (const f of fixtures.splice(0)) f.stop(); rmSync(home, { recursive: true, force: true }); });

function fixture(item?: (at: { phase: Phase; nth: number; text: string; index: number }) => unknown): EmbedFixture {
  const f = startEmbedFixture({ fragmentMark: "no-fragment-here", model: MODEL, item });
  fixtures.push(f);
  return f;
}
function withStore<T>(fn: (s: Store) => T): T { const s = createStore(vault); try { return fn(s); } finally { s.close(); } }

/** Three embedded documents; `faulty` more documents whose stored vector is all zeros (its distance is NULL). */
function seed(faulty = 0): void {
  withStore(s => {
    const now = new Date().toISOString();
    s.ensureVecTable(64);
    const add = (path: string, body: string, vector: number[]) => {
      const hash = hashContent(body);
      seedContent(s.db, hash, body, now);
      s.insertDocument("notes", path, path.replace(/\.md$/, ""), hash, now, now);
      s.insertEmbedding(hash, 0, 0, new Float32Array(bow(body)), MODEL, now, "full", undefined, canonicalDocId("notes", path));
      s.markEmbedSynced(hash);
      if (vector !== undefined && vector.length) {
        s.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_0`);
        s.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(vector));
      }
    };
    for (const [path, body] of Object.entries(DOCS)) add(path, body, []);
    for (let i = 0; i < faulty; i++) add(`bad${i}.md`, `An unrelated note number ${i} about nothing in particular.`, new Array(64).fill(0));
  });
}

async function cli(url: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", ...args], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"), INDEX_PATH: vault,
      CLAWMEM_EMBED_URL: url, CLAWMEM_LLM_URL: `http://127.0.0.1:${dead}`, CLAWMEM_RERANK_URL: `http://127.0.0.1:${dead}`,
      CLAWMEM_NO_LOCAL_MODELS: "true", CLAWMEM_EMBED_WAIT: "0", NO_COLOR: "1",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}
const refuseQuery = (at: { phase: Phase }) => (at.phase === "other" ? POISON : undefined);
const warnings = (err: string) => err.split("\n").filter(line => /vector/i.test(line));

describe("CLI `vsearch` — a cosine ranking or an explicit error", () => {
  it("a healthy run prints a bare array and no warning", async () => {
    seed();
    const r = await cli(fixture().url, ["vsearch", "tank filter", "--json", "--min-score", "0"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((row: { file: string }) => row.file).some((file: string) => file.endsWith("tank.md"))).toBe(true);
    expect(warnings(r.err)).toEqual([]);
  }, 30_000);

  it("a refused query vector is an explicit error: exit 1, no result, the stated text", async () => {
    seed();
    const r = await cli(fixture(refuseQuery).url, ["vsearch", "tank filter", "--json", "--min-score", "0"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(UNAVAILABLE);
    expect(r.out.trim()).toBe("");
    expect(r.err).not.toContain("    at ");                     // an error line, not a stack trace
  }, 30_000);

  it("stored vectors that are not usable are skipped, counted and reported", async () => {
    seed(2);
    const fx = fixture();
    const json = await cli(fx.url, ["vsearch", "tank filter", "--json", "--min-score", "0"]);
    expect(json.code).toBe(0);
    const reply = JSON.parse(json.out);
    expect(reply).toMatchObject({ degraded: true, degradedReason: "vector-fault", vectorFaults: 2 });
    expect(reply.results.map((row: { file: string }) => row.file).some((file: string) => file.endsWith("tank.md"))).toBe(true);
    expect(reply.results.every((row: { file: string }) => !/bad\d\.md$/.test(row.file))).toBe(true);
    expect(warnings(json.err).length).toBe(1);
    expect(warnings(json.err)[0]).toContain("2 stored vector");           // the scan's own line, once per process
    const plain = await cli(fx.url, ["vsearch", "tank filter", "--min-score", "0"]);
    expect(plain.code).toBe(0);
    expect(warnings(plain.err).length).toBe(1);
    expect(plain.out).toContain("tank");
  }, 30_000);
});

describe("CLI `query` — hybrid: the lexical leg answers when the vector leg cannot", () => {
  it("a healthy run prints a bare array and no warning", async () => {
    seed();
    const r = await cli(fixture().url, ["query", "tank filter", "--json"]);
    expect(r.code).toBe(0);
    expect(Array.isArray(JSON.parse(r.out))).toBe(true);
    expect(warnings(r.err)).toEqual([]);
  }, 30_000);

  it("a refused query vector: exit 0, the lexical results, ONE warning line, `--json` carries the reason", async () => {
    seed();
    const fx = fixture(refuseQuery);
    const json = await cli(fx.url, ["query", "tank filter", "--json"]);
    expect(json.code).toBe(0);
    const reply = JSON.parse(json.out);
    expect(reply).toMatchObject({ degraded: true, degradedReason: "vector-fault" });
    expect(reply.vectorFaults).toBeUndefined();                 // no stored vector was at fault
    const files = reply.results.map((row: { file: string }) => row.file);
    expect(files.some((file: string) => file.endsWith("tank.md"))).toBe(true);
    expect(files.some((file: string) => file.endsWith("garden.md"))).toBe(false);   // lexical only: no term matches it
    expect(warnings(json.err).length).toBe(1);
    expect(warnings(json.err)[0]).toContain("malformed vector");
    const plain = await cli(fx.url, ["query", "tank filter"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("tank");
    expect(warnings(plain.err).length).toBe(1);
  }, 30_000);

  it("stored vectors that are not usable: the results stand, the count is in the reply and in ONE warning", async () => {
    seed(2);
    const r = await cli(fixture().url, ["query", "tank filter", "--json"]);
    expect(r.code).toBe(0);
    const reply = JSON.parse(r.out);
    expect(reply).toMatchObject({ degraded: true, degradedReason: "vector-fault", vectorFaults: 2 });
    expect(reply.results.length).toBeGreaterThan(0);
    expect(warnings(r.err).length).toBe(1);
  }, 30_000);
});

describe("an endpoint that is down is not a refused vector", () => {
  it("both commands behave as before this change (measured on v0.43.6): exit 0, a bare array, no degraded mark", async () => {
    seed();
    const down = `http://127.0.0.1:${dead}`;
    const query = await cli(down, ["query", "tank filter", "--json"]);
    expect(query.code).toBe(0);
    const rows = JSON.parse(query.out);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((row: { file: string }) => row.file.endsWith("tank.md"))).toBe(true);     // the lexical results
    const vsearch = await cli(down, ["vsearch", "tank filter", "--json", "--min-score", "0"]);
    expect(vsearch.code).toBe(0);
    expect(JSON.parse(vsearch.out)).toEqual([]);
    for (const r of [query, vsearch]) expect(r.err).not.toContain("malformed vector");
  }, 60_000);
});

describe("the legs of a multi-leg `query` (original and expanded legs each embed their own text)", () => {
  const hit = (name: string) => ({ filepath: `/v/${name}.md`, title: name, score: 0.5 }) as never;
  const poison = () => new VecPoisonError("non-finite", "endpoint", { context: "query" } as never);
  /** A store whose vector search answers per query text. */
  const store = (answers: Record<string, () => unknown>) => ({
    searchVecWithFaults: async (query: string) => answers[query]!() as never,
  });

  it("a refused leg is dropped alone: the other legs answer, and the report counts it", async () => {
    const s = store({
      original: () => ({ results: [hit("a")], vectorFaults: 0 }),
      expanded: () => { throw poison(); },
      hyde: () => { throw new EmbedEnvelopeError("no data", { context: "query" } as never); },
    });
    const legs = [await cliVectorLeg(s, "original", 20), await cliVectorLeg(s, "expanded", 20), await cliVectorLeg(s, "hyde", 20)];
    expect(legs.map(leg => [leg.refused, leg.results.length])).toEqual([[false, 1], [true, 0], [true, 0]]);
    const report = cliVectorReport(legs);
    expect(report.degraded).toEqual({ degraded: true, degradedReason: "vector-fault" });
    expect(report.warning).toContain(VECTOR_SEARCH_UNAVAILABLE);
    expect(report.warning).toContain("2 of 3 vector legs");
    expect(report.warning).toContain("the other legs answered");
    expect(report.warning!.split("\n").length).toBe(1);
  });

  it("every leg refused: the results are lexical only", async () => {
    const s = store({ original: () => { throw poison(); } });
    const report = cliVectorReport([await cliVectorLeg(s, "original", 20)]);
    expect(report.warning).toContain("1 of 1 vector leg)");
    expect(report.warning).toContain("the results are lexical only");
  });

  it("the legs scan the same stored vectors: the count is the largest any leg met, not the sum", async () => {
    const s = store({
      original: () => ({ results: [hit("a")], vectorFaults: 2 }),
      expanded: () => ({ results: [hit("b")], vectorFaults: 3 }),
    });
    const report = cliVectorReport([await cliVectorLeg(s, "original", 20), await cliVectorLeg(s, "expanded", 20)]);
    expect(report.degraded).toEqual({ degraded: true, degradedReason: "vector-fault", vectorFaults: 3 });
    expect(report.warning).toBeUndefined();                     // the scan wrote its own line
  });

  it("nothing degraded: no field, no warning", async () => {
    const s = store({ original: () => ({ results: [hit("a")], vectorFaults: 0 }) });
    expect(cliVectorReport([await cliVectorLeg(s, "original", 20)])).toEqual({});
  });

  it("any other error is thrown, as before this change", async () => {
    const s = store({ original: () => { throw new Error("dimension mismatch"); } });
    await expect(cliVectorLeg(s, "original", 20)).rejects.toThrow("dimension mismatch");
  });
});
