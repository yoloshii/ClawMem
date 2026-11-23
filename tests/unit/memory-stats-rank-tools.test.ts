import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * Route-level contracts for the v0.36.0 diagnostics pair, driven through the REAL
 * MCP handlers over an in-memory transport against a seeded vault:
 *
 * memory_stats — exact per-collection aggregates (counts + origin×active cross-tabs
 * over ALL rows; access/confidence/quality/effective-age distributions over ACTIVE
 * rows only), deactivation-reason breakdown, the collection filter, the structured
 * unknown-collection AND unknown-vault errors carrying available names (fail-loud:
 * no partial stats), and n/a rendering for inactive-only collections.
 *
 * memory_rank — breakdown present per result and consistent with compositeScore,
 * raw ranks keyed by path (same-content docs share a docid and must not collide),
 * raw ordering from the production rankRawPrimary contract, the union view keeping
 * demoted raw winners visible, pin delta visibility, the _clawmem default exclusion
 * with includeInternal opt-in, the weightProfile switch, and schema-level limit
 * validation. Vault config is hermetic (empty CLAWMEM_CONFIG_DIR, CLAWMEM_VAULTS
 * cleared) so the unknown-vault contract is deterministic.
 */

import { unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";
import { clearConfigCache } from "../../src/config.ts";

import { seedContent } from "../helpers/seed-content.ts";
const TEST_DB = "/tmp/clawmem-memory-stats-rank-test.sqlite";

const fakeLlm = {
  embed: async () => ({ embedding: new Float32Array([0, 0, 0, 1]), model: "stats-fake" }),
  query: async () => null,
  expandQuery: async () => [],
} as any;

let client: Client;
let closeAllStores: () => void;
let seedStore: Store;
let prevIndexPath: string | undefined;
let prevConfigDir: string | undefined;
let prevVaults: string | undefined;
let tmpConfigDir: string | undefined;

const NOW_MS = Date.now();
const iso = (daysAgo: number) => new Date(NOW_MS - daysAgo * 86400_000).toISOString();

function seedDoc(
  store: Store, col: string, path: string, body: string,
  opts: { createdAt?: string; origin?: "fs" | "api" | null; active?: number; reason?: string | null; access?: number; pinned?: number } = {}
): void {
  const hash = hashContent(body + col + path);
  const created = opts.createdAt ?? iso(0);
  seedContent(store.db, hash, body, created);
  store.insertDocument(col, path, path, hash, created, created);
  // 62.1 D9: a counter write carries a fresh counter stamp (an unstamped one is an older ClawMem's and is ignored).
  store.db.prepare(
    `UPDATE documents SET origin = ?, active = ?, deactivated_reason = ?, access_count = ?, pinned = ?,
       counter_stamp = lower(hex(randomblob(8))) WHERE collection = ? AND path = ?`
  ).run(opts.origin ?? null, opts.active ?? 1, opts.reason ?? null, opts.access ?? 0, opts.pinned ?? 0, col, path);
}

beforeAll(async () => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  prevIndexPath = Bun.env.INDEX_PATH;
  prevConfigDir = Bun.env.CLAWMEM_CONFIG_DIR;
  prevVaults = Bun.env.CLAWMEM_VAULTS;
  Bun.env.INDEX_PATH = TEST_DB;
  tmpConfigDir = mkdtempSync(join(tmpdir(), "clawmem-stats-cfg-"));
  Bun.env.CLAWMEM_CONFIG_DIR = tmpConfigDir;
  delete Bun.env.CLAWMEM_VAULTS;
  clearConfigCache();
  setDefaultLlamaCpp(fakeLlm);

  seedStore = createStore(TEST_DB);
  // Collection "alpha": 6 rows — 4 active (access 0/0/5/100 → max 100, mean 26.25,
  // median 2.5, nonzero 2), 2 inactive (one 'absent', one pre-v0.31.0 NULL reason).
  // Origin×active cross-tab: fs 2+1, api 1+0, legacy 1+1. The inactive access=999 row
  // must NOT reach the active-only distributions. Effective ages of the active rows
  // (authored_at NULL → modified_at = createdAt): ≈ [2, 15, 90, 90] days.
  seedDoc(seedStore, "alpha", "a1.md", "flumaroon fresh note", { createdAt: iso(2), origin: "fs" });
  seedDoc(seedStore, "alpha", "a2.md", "flumaroon api-born note", { createdAt: iso(15), origin: "api" });
  seedDoc(seedStore, "alpha", "a3.md", "flumaroon legacy note", { createdAt: iso(90), origin: null, access: 5 });
  seedDoc(seedStore, "alpha", "a4.md", "flumaroon hot pinned note", { createdAt: iso(90), origin: "fs", access: 100, pinned: 1 });
  seedDoc(seedStore, "alpha", "a5.md", "flumaroon removed note", { createdAt: iso(90), origin: "fs", active: 0, reason: "absent", access: 999 });
  seedDoc(seedStore, "alpha", "a6.md", "flumaroon ancient tombstone", { createdAt: iso(90), origin: null, active: 0, reason: null });
  // Collection "beta": 1 active row (filter + reason-scoping assertions).
  seedDoc(seedStore, "beta", "b1.md", "unrelated basil note", { createdAt: iso(1), origin: "api" });
  // Collection "gamma": inactive-only — distributions must be null, text must say n/a.
  seedDoc(seedStore, "gamma", "g1.md", "gamma lone tombstone", { createdAt: iso(10), origin: "fs", active: 0, reason: "absent" });
  // Internal collection: carries the rank token — excluded from memory_rank by default.
  seedDoc(seedStore, "_clawmem", "observations/o1.md", "flumaroon internal observation", { createdAt: iso(1), origin: "api" });
  // Collection "dupcol": IDENTICAL content at two paths — the docs share a content-hash
  // docid, so ranks keyed by docid would collide; ranks must be keyed by path. Inserted
  // in REVERSE lexical order so a stable sort of insertion (or composite) order gives a
  // DIFFERENT answer than rankRawPrimary's documented tie contract (raw DESC → pinned
  // DESC → legacy composite DESC → displayPath ASC) — the tie assert below pins the
  // production contract, not incidental ordering.
  const dupBody = "duplicontent twin body";
  const dupHash = hashContent(dupBody);
  seedContent(seedStore.db, dupHash, dupBody, iso(1));
  seedStore.insertDocument("dupcol", "dup-two.md", "dup-two.md", dupHash, iso(1), iso(1));
  seedStore.insertDocument("dupcol", "dup-one.md", "dup-one.md", dupHash, iso(1), iso(1));
  // Collection "pincap": engineered NEGATIVE pin delta — fresh decision, quality 1.0
  // (×1.3), access 10 (confidence at cap), revisions 5 (freq boost) push the pre-pin
  // composite above 1.0, so min(1.0, +0.3) CLAMPS it and the applied delta is negative.
  seedDoc(seedStore, "pincap", "clamped.md", "clampex clampex clampex", { createdAt: iso(0), origin: "api", access: 10, pinned: 1 });
  seedStore.db.prepare(
    `UPDATE documents SET content_type = 'decision', quality_score = 1.0, revision_count = 5 WHERE collection = 'pincap' AND path = 'clamped.md'`
  ).run();
  // Collection "delta": relevance-inversion fixture — a dense short exact match that is
  // very old with quality 0 (raw #1, composite tail) vs five fresh weak mentions.
  seedDoc(seedStore, "delta", "raw-winner.md", "demotrix demotrix demotrix", { createdAt: iso(600) });
  seedStore.db.prepare(`UPDATE documents SET quality_score = 0.0 WHERE collection = 'delta' AND path = 'raw-winner.md'`).run();
  for (let i = 1; i <= 5; i++) {
    seedDoc(seedStore, "delta", `fresh-${i}.md`, `notes item ${i} mentioning demotrix once among many other unrelated planning words and filler prose`, { createdAt: iso(1) });
  }

  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "stats-rank-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);
});

afterAll(async () => {
  await client.close();
  closeAllStores();
  seedStore.close();
  if (prevIndexPath === undefined) delete Bun.env.INDEX_PATH; else Bun.env.INDEX_PATH = prevIndexPath;
  if (prevConfigDir === undefined) delete Bun.env.CLAWMEM_CONFIG_DIR; else Bun.env.CLAWMEM_CONFIG_DIR = prevConfigDir;
  if (prevVaults === undefined) delete Bun.env.CLAWMEM_VAULTS; else Bun.env.CLAWMEM_VAULTS = prevVaults;
  clearConfigCache();
  try { unlinkSync(TEST_DB); } catch { /* already gone */ }
  if (tmpConfigDir) rmSync(tmpConfigDir, { recursive: true, force: true });
});

type ToolResult = { structuredContent?: any; isError?: boolean; content: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  await client.callTool({ name, arguments: args }) as ToolResult;
const textOf = (res: ToolResult): string => res.content.find(c => c.type === "text")?.text ?? "";

describe("memory_stats", () => {
  it("reports exact per-collection aggregates with origin×active cross-tabs; distributions are active-only", async () => {
    const res = await call("memory_stats", {});
    expect(res.isError).toBeFalsy();
    const alpha = res.structuredContent.collections.find((c: any) => c.collection === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha.total).toBe(6);
    expect(alpha.active).toBe(4);
    expect(alpha.inactive).toBe(2);
    expect(alpha.origins).toEqual({
      fs: { total: 3, active: 2, inactive: 1 },
      api: { total: 1, active: 1, inactive: 0 },
      legacy: { total: 2, active: 1, inactive: 1 },
    });
    expect(alpha.pinned).toBe(1);
    expect(alpha.accrual.created7d).toBe(1);
    expect(alpha.accrual.created30d).toBe(2);
    expect(alpha.span.firstCreated <= alpha.span.lastCreated).toBe(true);
    // Active rows only: the inactive access=999 row is invisible here.
    expect(alpha.accessCount.max).toBe(100);
    expect(alpha.accessCount.mean).toBe(26.25);
    expect(alpha.accessCount.median).toBe(2.5);
    expect(alpha.accessCount.nonzero).toBe(2);
    // Seeded defaults: confidence and quality are 0.5 across active rows.
    expect(alpha.confidence.mean).toBe(0.5);
    expect(alpha.confidence.median).toBe(0.5);
    expect(alpha.quality.mean).toBe(0.5);
    expect(alpha.quality.median).toBe(0.5);
    // Effective ages ≈ [2, 15, 90, 90] days (authored_at NULL → modified_at axis).
    expect(alpha.effectiveAgeDays.median).toBeGreaterThan(52.3);
    expect(alpha.effectiveAgeDays.median).toBeLessThan(52.7);
    expect(alpha.effectiveAgeDays.mean).toBeGreaterThan(49.0);
    expect(alpha.effectiveAgeDays.mean).toBeLessThan(49.5);
    expect(alpha.effectiveAgeDays.max).toBeGreaterThan(89.8);
    expect(alpha.effectiveAgeDays.max).toBeLessThan(90.2);
  });

  it("collection filter narrows to one collection and scopes the reason breakdown", async () => {
    const res = await call("memory_stats", { collection: "alpha" });
    expect(res.structuredContent.collections).toHaveLength(1);
    const reasons = res.structuredContent.deactivationReasons as { reason: string | null; count: number }[];
    expect(reasons.find(r => r.reason === "absent")?.count).toBe(1);
    expect(reasons.find(r => r.reason === null)?.count).toBe(1);
    const beta = await call("memory_stats", { collection: "beta" });
    expect(beta.structuredContent.collections[0].total).toBe(1);
    expect(beta.structuredContent.deactivationReasons).toHaveLength(0);
  });

  it("inactive-only collection reports null distributions and renders n/a", async () => {
    const res = await call("memory_stats", { collection: "gamma" });
    const gamma = res.structuredContent.collections[0];
    expect(gamma.total).toBe(1);
    expect(gamma.active).toBe(0);
    expect(gamma.accessCount.max).toBeNull();
    expect(gamma.accessCount.median).toBeNull();
    expect(gamma.effectiveAgeDays.median).toBeNull();
    expect(textOf(res)).toContain("access max n/a");
  });

  it("unknown collection is a structured error carrying the available list", async () => {
    const res = await call("memory_stats", { collection: "nope" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toBe("unknown_collection");
    expect(res.structuredContent.available).toContain("alpha");
    expect(res.structuredContent.available).toContain("beta");
    expect(res.structuredContent.available).toContain("_clawmem");
  });

  it("unknown vault is a structured error on BOTH tools (hermetic: no vaults configured)", async () => {
    const statsRes = await call("memory_stats", { vault: "ghostvault" });
    expect(statsRes.isError).toBe(true);
    expect(statsRes.structuredContent.error).toBe("unknown_vault");
    expect(statsRes.structuredContent.requested).toBe("ghostvault");
    expect(statsRes.structuredContent.available).toEqual([]);
    const rankRes = await call("memory_rank", { query: "flumaroon", vault: "ghostvault" });
    expect(rankRes.isError).toBe(true);
    expect(rankRes.structuredContent.error).toBe("unknown_vault");
    expect(rankRes.structuredContent.available).toEqual([]);
  });
});

describe("lifecycle_status", () => {
  it("forgotten counts only forget; the deactivation reasons partition every inactive row", async () => {
    const res = await call("lifecycle_status", {});
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    // The fixture's inactive rows: alpha/a5 + gamma/g1 'absent', alpha/a6 with no recorded reason.
    // The old count ("inactive without archived_at") reported all three as forgotten.
    expect(text).toContain("Forgotten (manual): 0");
    expect(text).toContain("Deactivation reasons: absent 2, forget 0, archive 0, unknown-legacy 1");
  });
});

describe("memory_rank", () => {
  it("returns per-result breakdowns consistent with compositeScore, with a valid raw-rank permutation", async () => {
    const res = await call("memory_rank", { query: "flumaroon", limit: 10 });
    expect(res.isError).toBeFalsy();
    const items = res.structuredContent.results as any[];
    expect(items.length).toBeGreaterThanOrEqual(4);
    const rawRanks = new Set<number>();
    for (const it_ of items) {
      expect(it_.breakdown).toBeDefined();
      // structuredContent rounds compositeScore to 3dp; the breakdown keeps full precision.
      expect(Math.abs(it_.breakdown.finalComposite - it_.compositeScore)).toBeLessThanOrEqual(0.0005 + 1e-9);
      expect(it_.rankShift).toBe(it_.rawRank - it_.compositeRank);
      expect(it_.rawRank).toBeGreaterThanOrEqual(1);
      expect(it_.rawRank).toBeLessThanOrEqual(res.structuredContent.candidateCount);
      expect(rawRanks.has(it_.rawRank)).toBe(false);
      rawRanks.add(it_.rawRank);
    }
    // Composite ranks strictly increase through the union view (composite order).
    for (let i = 1; i < items.length; i++) {
      expect(items[i].compositeRank).toBeGreaterThan(items[i - 1].compositeRank);
    }
    expect(res.structuredContent.scoreBasis).toBe("composite-explain");
    expect(res.structuredContent.view).toBe("composite-top ∪ raw-top");
  });

  it("same-content documents at different paths get distinct ranks (path-keyed, not docid-keyed)", async () => {
    const res = await call("memory_rank", { query: "duplicontent", limit: 10, collection: "dupcol" });
    const items = (res.structuredContent.results as any[]).filter(r => r.path.startsWith("dupcol/"));
    expect(items).toHaveLength(2);
    expect(items[0].docid).toBe(items[1].docid); // shared content-hash docid — the collision hazard
    expect(items[0].rawRank).not.toBe(items[1].rawRank);
    expect(items[0].compositeRank).not.toBe(items[1].compositeRank);
    // Regression-pin the PRODUCTION raw tie contract: equal raw score, both unpinned,
    // equal legacy composite → displayPath ASC decides. The docs were inserted in
    // reverse lexical order, so insertion-stable (or composite-circular) ordering
    // would put dup-two first and fail here.
    const one = items.find(r => r.path === "dupcol/dup-one.md")!;
    const two = items.find(r => r.path === "dupcol/dup-two.md")!;
    expect(one.rawRank).toBeLessThan(two.rawRank);
  });

  it("renders a NEGATIVE pinΔ when the 1.0 cap clamps a pinned doc down", async () => {
    const res = await call("memory_rank", { query: "clampex", limit: 5, collection: "pincap" });
    const clamped = (res.structuredContent.results as any[]).find(r => r.path === "pincap/clamped.md");
    expect(clamped).toBeDefined();
    expect(clamped.breakdown.pinBoost).toBeLessThan(0);
    expect(clamped.compositeScore).toBe(1.0);
    // The previous `pinBoost > 0` rendering would hide this — the text must carry the
    // negative delta (the pin-cap inversion, RANKING-DEFECT-HANDOFF §Addendum).
    expect(textOf(res)).toMatch(/pinΔ -0\./);
  });

  it("keeps demoted raw winners visible via the union view", async () => {
    const res = await call("memory_rank", { query: "demotrix", limit: 3, collection: "delta" });
    const items = res.structuredContent.results as any[];
    const winner = items.find(r => r.path === "delta/raw-winner.md");
    expect(winner).toBeDefined();
    expect(winner.rawRank).toBe(1);
    expect(winner.compositeRank).toBeGreaterThan(3);
    expect(winner.demotedRawWinner).toBe(true);
    expect(winner.rankShift).toBeLessThan(0);
    expect(textOf(res)).toContain("demoted raw winner");
  });

  it("shows the pin delta on the pinned doc", async () => {
    const res = await call("memory_rank", { query: "flumaroon", limit: 10 });
    const pinned = (res.structuredContent.results as any[]).find(r => r.path === "alpha/a4.md");
    expect(pinned).toBeDefined();
    expect(pinned.pinned).toBe(true);
    expect(pinned.breakdown.pinBoost).toBeGreaterThan(0);
    expect(textOf(res)).toContain("pinΔ");
  });

  it("excludes _clawmem by default; includeInternal admits it", async () => {
    const byPath = (res: ToolResult) => (res.structuredContent.results as any[]).map(r => r.path);
    const excluded = await call("memory_rank", { query: "flumaroon", limit: 20 });
    expect(byPath(excluded)).not.toContain("_clawmem/observations/o1.md");
    const included = await call("memory_rank", { query: "flumaroon", limit: 20, includeInternal: true });
    expect(byPath(included)).toContain("_clawmem/observations/o1.md");
  });

  it("weightProfile 'query' explains with the query-tool weights on non-recency queries", async () => {
    const res = await call("memory_rank", { query: "flumaroon", limit: 5, weightProfile: "query" });
    expect(res.structuredContent.weightProfile).toBe("query");
    const b = (res.structuredContent.results as any[])[0].breakdown;
    expect(b.weights).toEqual({ search: 0.7, recency: 0.15, confidence: 0.15 });
    expect(b.recencyIntent).toBe(false);
  });

  it("rejects out-of-range limit at the schema", async () => {
    const zero = await call("memory_rank", { query: "flumaroon", limit: 0 });
    expect(zero.isError).toBe(true);
    const frac = await call("memory_rank", { query: "flumaroon", limit: 2.5 });
    expect(frac.isError).toBe(true);
  });
});
