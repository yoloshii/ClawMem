import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * HORMA-1 offline eval harness (BACKLOG Source 35, P1 first build).
 *
 * End-to-end runs drive the REAL `query` tool handler over an in-memory MCP
 * transport against a seeded vault with a keyword-steered fake embedder — the
 * same fixture discipline as mcp-routes.test.ts — so every metric assertion is
 * deterministic. Covers: pure metric math; strict gold parsing (bad JSON /
 * schema / duplicate ids = hard error); strict resolution (any unresolved ref
 * excludes the example — partial gold must never inflate recall); hash-pin
 * drift warnings; mode/profile skip accounting; include_internal flow-through;
 * trust gates; artifact writing; and the replay-is-read-only invariant
 * (context_usage / recall_events / memory_relations untouched).
 */

import { unlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { createHash } from "crypto";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";
import { computeDocMetrics, mean, p95 } from "../../src/eval/metrics.ts";
import { parseGoldFile, resolveGoldExamples, GoldFileError } from "../../src/eval/gold.ts";
import { runEval, resolveRetrievedDocId, EvalIntegrityError } from "../../src/eval/run.ts";

const TEST_DB = "/tmp/clawmem-eval-harness-test.sqlite";
const OUT_DIR = "/tmp/clawmem-eval-harness-out";
const MODEL = "eval-fake";

const goldFiles: string[] = [];
function writeGold(name: string, lines: unknown[]): string {
  const p = `/tmp/clawmem-eval-harness-gold-${name}.jsonl`;
  writeFileSync(p, lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  goldFiles.push(p);
  return p;
}

// Keyword-steered fake embedder: "sealed"/"acceptance" cluster together,
// "deduction junk" sits apart, everything else is near-orthogonal.
function fakeVec(text: string): Float32Array {
  const t = text.toLowerCase();
  if (t.includes("sealed") || t.includes("acceptance")) return new Float32Array([1, 0.05, 0, 0]);
  if (t.includes("deduction junk")) return new Float32Array([0.8, 0.6, 0, 0]);
  const j = (createHash("sha256").update(text).digest()[0]! / 255) * 0.2;
  return new Float32Array([j, 0.1, 1, 0]);
}
const fakeLlm = {
  embed: async (text: string) => ({ embedding: fakeVec(text), model: MODEL }),
  query: async () => null,
  expandQuery: async () => [],
} as any;

let store: Store;

function seedDoc(col: string, path: string, body: string, opts?: { contentType?: string; noVector?: boolean }): string {
  const hash = hashContent(body + col + path);
  const now = new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument(col, path, path, hash, now, now);
  if (opts?.contentType) {
    const row = store.db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1`).get(hash) as { id: number };
    store.updateDocumentMeta(row.id, { content_type: opts.contentType, confidence: 0.85 });
  }
  store.markEmbedSynced(hash);
  if (!opts?.noVector) {
    store.ensureVecTable(4);
    store.insertEmbedding(hash, 0, 0, fakeVec(body), MODEL, now, "full", undefined, canonicalDocId(col, path));
  }
  return hash;
}

const docId = (col: string, path: string): number =>
  (store.db.prepare(`SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1`).get(col, path) as { id: number }).id;

let alphaHash: string;

beforeAll(() => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  try { rmSync(OUT_DIR, { recursive: true }); } catch { /* absent */ }
  Bun.env.INDEX_PATH = TEST_DB;
  setDefaultLlamaCpp(fakeLlm);

  store = createStore(TEST_DB);
  alphaHash = seedDoc("user", "alpha.md", "the sealed acceptance script cannot live under the git directory because the sandbox denies reads");
  seedDoc("user", "charlie.md", "second sealed acceptance appendix describing the sandbox denial follow-up");
  seedDoc("user", "bravo.md", "unrelated cooking notes about bread crumb structure");
  seedDoc("_clawmem", "deductions/junk.md", "deduction junk moved successfully to another folder", { contentType: "deductive" });
  // Archived doc: labels pointing here must resolve to "unresolved", not score.
  seedDoc("user", "old.md", "sealed acceptance draft that was later archived");
  store.db.prepare(`UPDATE documents SET active = 0 WHERE collection = 'user' AND path = 'old.md'`).run();
  // Path-composition collision pair: (collection "a", path "b/c.md") and
  // (collection "a/b", path "c.md") both compose to displayPath "a/b/c.md".
  // Nothing validates collection names against "/" (cmdMine accepts them), so
  // retrieved-identity inversion must refuse to guess. FTS-only (orthogonal
  // vocabulary, no vectors) so these never surface for the other fixtures.
  seedDoc("a", "b/c.md", "zulu collision probe first variant", { noVector: true });
  seedDoc("a/b", "c.md", "zulu collision probe second variant", { noVector: true });
});

afterAll(() => {
  try { store.close(); } catch { /* closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  try { unlinkSync(TEST_DB); } catch { /* gone */ }
  try { rmSync(OUT_DIR, { recursive: true }); } catch { /* gone */ }
  for (const p of goldFiles) { try { unlinkSync(p); } catch { /* gone */ } }
});

describe("computeDocMetrics", () => {
  it("perfect retrieval scores 1 across the board", () => {
    const m = computeDocMetrics([1, 2], new Set([1, 2]));
    expect(m).toEqual({ jaccard: 1, precision: 1, recall: 1, hit: 1, mrr: 1 });
  });

  it("disjoint retrieval scores 0 across the board", () => {
    const m = computeDocMetrics([3, 4], new Set([1, 2]));
    expect(m).toEqual({ jaccard: 0, precision: 0, recall: 0, hit: 0, mrr: 0 });
  });

  it("partial overlap: J uses the union, MRR the first-hit rank", () => {
    // C=[9,8,1], E={1,2}: hits=1, union=4 → J .25; P 1/3; R .5; first hit at rank 3.
    const m = computeDocMetrics([9, 8, 1], new Set([1, 2]));
    expect(m.jaccard).toBeCloseTo(0.25, 10);
    expect(m.precision).toBeCloseTo(1 / 3, 10);
    expect(m.recall).toBeCloseTo(0.5, 10);
    expect(m.hit).toBe(1);
    expect(m.mrr).toBeCloseTo(1 / 3, 10);
  });

  it("duplicate retrieved ids cannot inflate precision or push MRR rank", () => {
    // Dedup: C set {7,1}; gold hit is the 2nd DISTINCT doc → mrr 1/2, precision 1/2.
    const m = computeDocMetrics([7, 7, 1], new Set([1]));
    expect(m.precision).toBeCloseTo(0.5, 10);
    expect(m.mrr).toBeCloseTo(0.5, 10);
  });

  it("empty retrieval scores 0 (no division blowups)", () => {
    const m = computeDocMetrics([], new Set([1]));
    expect(m).toEqual({ jaccard: 0, precision: 0, recall: 0, hit: 0, mrr: 0 });
  });

  it("mean/p95 return null on empty input and nearest-rank p95 otherwise", () => {
    expect(mean([])).toBeNull();
    expect(p95([])).toBeNull();
    expect(mean([1, 2, 3])).toBeCloseTo(2, 10);
    expect(p95([5])).toBe(5);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1); // p95 = 19th value
    expect(p95(twenty)).toBe(19);
  });
});

describe("gold parsing (strict)", () => {
  it("parses a valid file, applies defaults, and skips blank lines", () => {
    const p = writeGold("valid", [
      { id: "a", query: "q one", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      "",
      { id: "b", query: "q two", mode: "intent_search", include_internal: true, tags: ["x"], gold_evidence: [{ collection: "user", path: "bravo.md", hash: null, chunk_seq: null, weight: 1.0, span: { start_line: 1, end_line: 3 } }] },
    ]);
    const examples = parseGoldFile(p);
    expect(examples.length).toBe(2);
    expect(examples[0]!.mode).toBe("query");
    expect(examples[0]!.include_internal).toBe(false);
    expect(examples[0]!.tags).toEqual([]);
    expect(examples[1]!.mode).toBe("intent_search");
    expect(examples[1]!.include_internal).toBe(true);
  });

  it("rejects invalid JSON with the offending line number", () => {
    const p = writeGold("badjson", [
      { id: "a", query: "q", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      "{not json",
    ]);
    expect(() => parseGoldFile(p)).toThrow(GoldFileError);
    try { parseGoldFile(p); } catch (e) {
      expect((e as GoldFileError).errors).toEqual([expect.objectContaining({ line: 2 })]);
    }
  });

  it("rejects schema violations (empty gold_evidence, missing query)", () => {
    const p = writeGold("badschema", [
      { id: "a", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      { id: "b", query: "q", gold_evidence: [] },
    ]);
    try {
      parseGoldFile(p);
      throw new Error("should have thrown");
    } catch (e) {
      const errs = (e as GoldFileError).errors;
      expect(errs.length).toBe(2);
      expect(errs[0]!.line).toBe(1);
      expect(errs[1]!.line).toBe(2);
      expect(errs[1]!.message).toContain("gold_evidence");
    }
  });

  it("rejects duplicate example ids, citing both lines", () => {
    const p = writeGold("dupid", [
      { id: "same", query: "q", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      { id: "same", query: "q2", gold_evidence: [{ collection: "user", path: "bravo.md" }] },
    ]);
    try {
      parseGoldFile(p);
      throw new Error("should have thrown");
    } catch (e) {
      const errs = (e as GoldFileError).errors;
      expect(errs.length).toBe(1);
      expect(errs[0]!.line).toBe(2);
      expect(errs[0]!.message).toContain("first seen on line 1");
    }
  });

  it("rejects unknown keys at every level — a typo'd knob must not silently change the evaluated route", () => {
    const p = writeGold("unknownkeys", [
      { id: "a", query: "q", includeInternal: true, gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      { id: "b", query: "q", gold_evidence: [{ collection: "user", path: "alpha.md", Path: "alpha.md" }] },
      { id: "c", query: "q", gold_evidence: [{ collection: "user", path: "alpha.md", span: { start_line: 1, end_line: 2, extra: 9 } }] },
    ]);
    try {
      parseGoldFile(p);
      throw new Error("should have thrown");
    } catch (e) {
      const errs = (e as GoldFileError).errors;
      expect(errs.length).toBe(3);
      expect(errs[0]!.message).toContain("includeInternal");
      expect(errs[1]!.message).toContain("Path");
      expect(errs[2]!.message).toContain("extra");
    }
  });

  it("dedupes repeated tags so an example cannot double-count in by_tag", () => {
    const p = writeGold("duptags", [
      { id: "t", query: "q", tags: ["dup", "dup", "other"], gold_evidence: [{ collection: "user", path: "alpha.md" }] },
    ]);
    const [ex] = parseGoldFile(p);
    expect(ex!.tags).toEqual(["dup", "other"]);
  });
});

describe("retrieved-identity inversion (strict)", () => {
  it("maps an unambiguous displayPath to its document id", () => {
    expect(resolveRetrievedDocId(store, "user/alpha.md")).toBe(docId("user", "alpha.md"));
  });

  it("hard-fails on a displayPath that maps to no active document", () => {
    expect(() => resolveRetrievedDocId(store, "user/ghost.md")).toThrow(EvalIntegrityError);
    expect(() => resolveRetrievedDocId(store, "user/ghost.md")).toThrow(/did not map/);
  });

  it("hard-fails on a collision-ambiguous displayPath instead of guessing", () => {
    expect(() => resolveRetrievedDocId(store, "a/b/c.md")).toThrow(EvalIntegrityError);
    expect(() => resolveRetrievedDocId(store, "a/b/c.md")).toThrow(/ambiguous/);
  });
});

describe("gold resolution (strict, active-only)", () => {
  it("resolves active docs, dedupes repeated refs, flags missing and archived docs", () => {
    const p = writeGold("resolve", [
      { id: "ok", query: "q", gold_evidence: [
        { collection: "user", path: "alpha.md" },
        { collection: "user", path: "alpha.md" },
        { collection: "user", path: "ghost.md" },
        { collection: "user", path: "old.md" },
      ] },
    ]);
    const [r] = resolveGoldExamples(store, parseGoldFile(p));
    expect(r!.goldDocIds).toEqual([docId("user", "alpha.md")]);
    expect(r!.unresolved.length).toBe(2);
    expect(r!.unresolved.map(u => u.path).sort()).toEqual(["ghost.md", "old.md"]);
    for (const u of r!.unresolved) expect(u.reason).toContain("no active document");
  });

  it("a mismatched gold hash pin resolves WITH a warning (identity holds, content drifted)", () => {
    const p = writeGold("hashpin", [
      { id: "pinned", query: "q", gold_evidence: [{ collection: "user", path: "alpha.md", hash: "deadbeef" }] },
      { id: "pinned-ok", query: "q", gold_evidence: [{ collection: "user", path: "alpha.md", hash: "__ALPHA__" }] },
    ]);
    const examples = parseGoldFile(p);
    examples[1]!.gold_evidence[0]!.hash = alphaHash;
    const resolved = resolveGoldExamples(store, examples);
    expect(resolved[0]!.goldDocIds.length).toBe(1);
    expect(resolved[0]!.warnings).toEqual([expect.stringContaining("label may be stale")]);
    expect(resolved[1]!.warnings).toEqual([]);
  });
});

describe("runEval end-to-end (real query handler over in-memory MCP)", () => {
  it("scores a hit and a miss deterministically at k=1 and aggregates them", async () => {
    const p = writeGold("e2e", [
      { id: "hit-top", query: "sealed acceptance sandbox", tags: ["sealed"], gold_evidence: [
        { collection: "user", path: "alpha.md" }, { collection: "user", path: "charlie.md" },
      ] },
      { id: "miss-1", query: "sealed acceptance sandbox", tags: ["miss", "sealed"], gold_evidence: [
        { collection: "user", path: "bravo.md" },
      ] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 2, audited: true, store });

    expect(report.examples_total).toBe(2);
    expect(report.examples_scored).toBe(2);
    expect(report.profile).toBe("query");
    expect(report.limit).toBe(1);
    expect(report.audit_attested).toBe(true);

    const hit = report.examples.find(e => e.id === "hit-top")!;
    // k=1 against 2 gold docs: top-1 is one of the sealed docs → P 1, R .5, J .5, MRR 1.
    expect(hit.metrics.hit).toBe(1);
    expect(hit.metrics.precision).toBeCloseTo(1, 10);
    expect(hit.metrics.recall).toBeCloseTo(0.5, 10);
    expect(hit.metrics.jaccard).toBeCloseTo(0.5, 10);
    expect(hit.metrics.mrr).toBeCloseTo(1, 10);
    expect(hit.retrieved.length).toBe(1);
    expect(hit.gold.length).toBe(2);
    expect(hit.elapsed_ms).toBeGreaterThanOrEqual(0);

    const miss = report.examples.find(e => e.id === "miss-1")!;
    expect(miss.metrics).toEqual({ jaccard: 0, precision: 0, recall: 0, hit: 0, mrr: 0 });

    const a = report.aggregate;
    expect(a.jaccard_mean).toBeCloseTo(0.25, 10);
    expect(a.recall_mean).toBeCloseTo(0.25, 10);
    expect(a.precision_mean).toBeCloseTo(0.5, 10);
    expect(a.hit_at_k).toBeCloseTo(0.5, 10);
    expect(a.mrr).toBeCloseTo(0.5, 10);
    expect(a.elapsed_ms_p95).not.toBeNull();
    // Token axis belongs to the context-profile replay — null under query profile.
    expect(a.tokens_mean).toBeNull();
    expect(a.recall_per_1k_tokens).toBeNull();

    expect(report.by_tag["sealed"]!.count).toBe(2);
    expect(report.by_tag["sealed"]!.hit_at_k).toBeCloseTo(0.5, 10);
    expect(report.by_tag["miss"]!.count).toBe(1);
    expect(report.by_tag["miss"]!.hit_at_k).toBeCloseTo(0, 10);

    expect(report.gates.pass).toBe(true);
    expect(report.gates.reasons).toEqual([]);
    expect(report.clawmem_version).toBe(JSON.parse(readFileSync(`${import.meta.dir}/../../package.json`, "utf8")).version);
  });

  it("include_internal flows through: _clawmem gold is reachable only when the example opts in", async () => {
    const p = writeGold("internal", [
      { id: "internal-on", query: "deduction junk", include_internal: true, gold_evidence: [
        { collection: "_clawmem", path: "deductions/junk.md" },
      ] },
      { id: "internal-off", query: "deduction junk", include_internal: false, gold_evidence: [
        { collection: "_clawmem", path: "deductions/junk.md" },
      ] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 2, store });

    const on = report.examples.find(e => e.id === "internal-on")!;
    expect(on.metrics.hit).toBe(1);
    expect(on.metrics.mrr).toBeCloseTo(1, 10);

    const off = report.examples.find(e => e.id === "internal-off")!;
    expect(off.metrics.hit).toBe(0);
    expect(off.metrics.recall).toBe(0);
  });

  it("strict resolution: an example with ANY unresolved ref is excluded and fails the gate", async () => {
    const p = writeGold("strict", [
      { id: "clean", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      { id: "partial", query: "sealed acceptance sandbox", gold_evidence: [
        { collection: "user", path: "alpha.md" }, { collection: "user", path: "ghost.md" },
      ] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, audited: true, store });

    expect(report.examples_total).toBe(2);
    expect(report.examples_scored).toBe(1);
    expect(report.examples.map(e => e.id)).toEqual(["clean"]);
    expect(report.unresolved_gold).toEqual([
      { example_id: "partial", refs: [expect.objectContaining({ collection: "user", path: "ghost.md" })] },
    ]);
    expect(report.gates.pass).toBe(false);
    expect(report.gates.reasons.join(" ")).toContain("unresolved");
  });

  it("unresolved refs in a mode-skipped example still fail the trust gate — they never vanish into skipped", async () => {
    const p = writeGold("skipped-unresolved", [
      { id: "q-ok", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      { id: "i-stale", query: "why sealed", mode: "intent_search", gold_evidence: [{ collection: "user", path: "ghost.md" }] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, audited: true, store });
    expect(report.examples_scored).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.unresolved_gold).toEqual([
      { example_id: "i-stale", refs: [expect.objectContaining({ path: "ghost.md" })] },
    ]);
    expect(report.gates.pass).toBe(false);
    expect(report.gates.reasons.join(" ")).toContain("unresolved");
  });

  it("a run that retrieves a collision-ambiguous path hard-fails instead of scoring a guess", async () => {
    const p = writeGold("ambig", [
      { id: "z", query: "zulu collision probe", gold_evidence: [{ collection: "a", path: "b/c.md" }] },
    ]);
    await expect(runEval({ goldPath: p, profile: "query", limit: 5, minExamples: 1, audited: true, store }))
      .rejects.toThrow(EvalIntegrityError);
  });

  it("the trust gate requires the operator label-audit attestation", async () => {
    const p = writeGold("audit", [
      { id: "only", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
    ]);
    const un = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, store });
    expect(un.report.audit_attested).toBe(false);
    expect(un.report.gates.pass).toBe(false);
    expect(un.report.gates.reasons.join(" ")).toContain("audit");
    const at = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, audited: true, store });
    expect(at.report.audit_attested).toBe(true);
    expect(at.report.gates.pass).toBe(true);
  });

  it("mode filter: examples labeled for other surfaces are skipped with accounting, never silently dropped", async () => {
    const p = writeGold("modes", [
      { id: "q1", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      { id: "i1", query: "why sealed", mode: "intent_search", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, audited: true, store });
    expect(report.examples_scored).toBe(1);
    expect(report.skipped).toEqual([
      { example_id: "i1", reason: expect.stringContaining('mode "intent_search"') },
    ]);
    expect(report.gates.pass).toBe(true);
  });

  it("trust gate fails below min_examples", async () => {
    const p = writeGold("gate", [
      { id: "only", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 30, audited: true, store });
    expect(report.gates.pass).toBe(false);
    expect(report.gates.reasons).toEqual([expect.stringContaining("examples_scored 1 < min_examples 30")]);
  });

  it("zero scored examples yields an all-null aggregate, not NaNs", async () => {
    const p = writeGold("empty", [
      { id: "ghost-only", query: "anything", gold_evidence: [{ collection: "user", path: "ghost.md" }] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, store });
    expect(report.examples_scored).toBe(0);
    expect(report.aggregate.jaccard_mean).toBeNull();
    expect(report.aggregate.mrr).toBeNull();
    expect(report.aggregate.elapsed_ms_p95).toBeNull();
    expect(report.gates.pass).toBe(false);
  });

  it("hash-pin drift surfaces as a per-example warning in the report", async () => {
    const p = writeGold("warn", [
      { id: "pinned", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md", hash: "deadbeef" }] },
    ]);
    const { report } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, store });
    expect(report.examples[0]!.warnings).toEqual([expect.stringContaining("label may be stale")]);
  });

  it("writes run.json + report.md artifacts that round-trip", async () => {
    const p = writeGold("artifacts", [
      { id: "hit-top", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }, { collection: "user", path: "charlie.md" }] },
    ]);
    const { report, artifacts } = await runEval({ goldPath: p, profile: "query", limit: 1, minExamples: 1, outDir: OUT_DIR, store });
    expect(artifacts).not.toBeNull();
    expect(existsSync(artifacts!.runJsonPath)).toBe(true);
    expect(existsSync(artifacts!.reportMdPath)).toBe(true);
    const roundTrip = JSON.parse(readFileSync(artifacts!.runJsonPath, "utf8"));
    expect(roundTrip.run_id).toBe(report.run_id);
    expect(roundTrip.gates).toEqual(report.gates);
    expect(roundTrip.audit_attested).toBe(false);
    expect(roundTrip.aggregate.hit_at_k).toBeCloseTo(1, 10);
    const md = readFileSync(artifacts!.reportMdPath, "utf8");
    expect(md).toContain(report.run_id);
    expect(md).toContain("hit-top");
  });

  it("replay is read-only: telemetry and relation tables are untouched", async () => {
    const count = (table: string): number =>
      (store.db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
    const before = {
      usage: count("context_usage"),
      recall: count("recall_events"),
      relations: count("memory_relations"),
    };
    const p = writeGold("readonly", [
      { id: "hit-top", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
      { id: "internal-on", query: "deduction junk", include_internal: true, gold_evidence: [{ collection: "_clawmem", path: "deductions/junk.md" }] },
    ]);
    await runEval({ goldPath: p, profile: "query", limit: 5, minExamples: 1, store });
    expect(count("context_usage")).toBe(before.usage);
    expect(count("recall_events")).toBe(before.recall);
    expect(count("memory_relations")).toBe(before.relations);
  });
});

describe("eval CLI (subprocess)", () => {
  const REPO_ROOT = `${import.meta.dir}/../..`;
  // Unroutable endpoints: the subprocess uses the real llm.ts, and the host may
  // run genuine inference servers on the default ports — a 4-dim fake-model vec
  // table queried through a real embedder would poison the run. Refused
  // connections exercise the documented fail-open degraded path instead.
  const cliEnv = {
    ...process.env,
    INDEX_PATH: TEST_DB,
    CLAWMEM_NO_LOCAL_MODELS: "true",
    CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
    CLAWMEM_LLM_URL: "http://127.0.0.1:1",
    CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
  };
  const runCli = (args: string[]) =>
    Bun.spawnSync({ cmd: ["bun", "src/clawmem.ts", "eval", "run", ...args], cwd: REPO_ROOT, env: cliEnv, stdout: "pipe", stderr: "pipe" });

  it("exits 1 when the trust gate fails (text mode) and 0 when it passes — automation must see the gate", () => {
    const p = writeGold("cli-gate", [
      { id: "only", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
    ]);
    const fail = runCli(["--gold", p, "--limit", "1", "--min-examples", "30", "--out", `${OUT_DIR}/cli-fail`]);
    expect(fail.exitCode).toBe(1);
    expect(fail.stdout.toString()).toContain("FAIL");
    const pass = runCli(["--gold", p, "--limit", "1", "--min-examples", "1", "--audited", "--out", `${OUT_DIR}/cli-pass`]);
    expect(pass.stderr.toString()).not.toContain("Error:");
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout.toString()).toContain("PASS");
  }, 90000);

  it("exits 1 on gate failure in --json mode too, with parseable run.json on stdout", () => {
    const p = writeGold("cli-json", [
      { id: "only", query: "sealed acceptance sandbox", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
    ]);
    const res = runCli(["--gold", p, "--limit", "1", "--min-examples", "30", "--json", "--out", `${OUT_DIR}/cli-json`]);
    expect(res.exitCode).toBe(1);
    const parsed = JSON.parse(res.stdout.toString());
    expect(parsed.gates.pass).toBe(false);
  }, 60000);

  it("rejects malformed integers and a missing --db snapshot up front", () => {
    const p = writeGold("cli-bad", [
      { id: "only", query: "q", gold_evidence: [{ collection: "user", path: "alpha.md" }] },
    ]);
    const badLimit = runCli(["--gold", p, "--limit", "10x"]);
    expect(badLimit.exitCode).toBe(1);
    expect(badLimit.stderr.toString()).toContain("positive integer");
    const fracLimit = runCli(["--gold", p, "--limit", "1.5"]);
    expect(fracLimit.exitCode).toBe(1);
    expect(fracLimit.stderr.toString()).toContain("positive integer");
    const badDb = runCli(["--gold", p, "--db", "/tmp/clawmem-eval-no-such-snapshot.sqlite"]);
    expect(badDb.exitCode).toBe(1);
    expect(badDb.stderr.toString()).toContain("snapshot not found");
  }, 60000);
});
