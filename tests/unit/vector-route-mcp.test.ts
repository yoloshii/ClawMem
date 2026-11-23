/**
 * BACKLOG 82.2, D4 — the MCP rows of the route table, on the REAL tool handlers over an in-memory transport:
 * what each vector route does when the QUERY vector is refused (the embedding endpoint answered with a malformed
 * vector), and how each reports stored vectors the scan skipped as unusable (operator ruling 17 A).
 *
 *  - `memory_retrieve` semantic / discovery / hybrid: handled before the fatal rethrow, then as the path treats a
 *    non-fatal vector error today (the lexical fallback, or the lexical leg alone); the reply is marked
 *    `vector-fault` and its scores are not labelled cosine;
 *  - `memory_retrieve` complex, `query`, `query_plan` (multi-leg): the refused leg is dropped alone and listed;
 *  - `vsearch`, `find_similar` (they promise a cosine ranking): an explicit "vector search unavailable" error.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, vectorLegEntries, flatDegraded } from "../../src/mcp.ts";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const TEST_DB = "/tmp/clawmem-822-mcp-route-test.sqlite";
const MODEL = "route-fake";
const UNAVAILABLE = "vector search unavailable: the embedding endpoint returned a malformed vector";
const healthy = () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: MODEL });
const refused = () => ({ embedding: new Float32Array([NaN, 0, 0, 0]), model: MODEL });

let client: Client;
let closeAllStores: () => void;
let seedStore: Store;
let embedAnswer: (text: string) => unknown = healthy;
/** What the fake expansion model returns. An empty list makes the store use its own typed fallback; a list is CACHED per query text, so each test below asks its own query. */
let expansions: { type: string; text: string }[] = [];
const fakeLlm = {
  embed: async (text: string) => embedAnswer(text),
  query: async () => null,
  expandQuery: async () => expansions,
} as any;

function add(path: string, body: string, vector: number[], raw = false): void {
  const now = new Date().toISOString();
  const hash = hashContent(body + path);
  seedContent(seedStore.db, hash, body, now);
  seedStore.insertDocument("user", path, path.replace(/\.md$/, ""), hash, now, now);
  seedStore.ensureVecTable(4);
  seedStore.insertEmbedding(hash, 0, 0, new Float32Array(raw ? [1, 0, 0, 0] : vector), MODEL, now, "full", undefined, canonicalDocId("user", path));
  if (raw) {
    seedStore.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_0`);
    seedStore.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(vector));
  }
  seedStore.markEmbedSynced(hash);
}

beforeAll(async () => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  Bun.env.INDEX_PATH = TEST_DB;
  setDefaultLlamaCpp(fakeLlm);
  seedStore = createStore(TEST_DB);
  add("tank.md", "The tank filter is cleaned every week and the tank water is changed.", [1, 0, 0, 0]);
  add("pump.md", "A pump moves water through the filter of the tank at night.", [0.9, 0.1, 0, 0]);
  add("bread.md", "Unrelated cooking notes about bread ovens and flour.", [0, 1, 0, 0]);
  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "mcp-vector-route-tests", version: "0.0.0" });
  await client.connect(clientTransport);
});
afterAll(() => {
  try { closeAllStores(); } catch { /* already closed */ }
  try { seedStore.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  try { unlinkSync(TEST_DB); } catch { /* gone */ }
});
beforeEach(() => { embedAnswer = healthy; expansions = []; });

type ToolResult = { structuredContent?: any; content?: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map(c => c.text ?? "").join("\n");
const paths = (r: ToolResult): string[] => (r.structuredContent?.results ?? []).map((row: any) => row.path ?? row.file);
const NOTE = "malformed vector";

describe("the degraded entries of one vector leg (operator ruling 17 A)", () => {
  it("the older reason stays; skipped stored vectors are an entry of their own, with the count", () => {
    expect(vectorLegEntries("vector:original", { degraded: false, vectorFaults: 0 })).toEqual([]);
    expect(vectorLegEntries("vector:original", { degraded: true, degradedReason: "vector-fault", vectorFaults: 2 }))
      .toEqual([{ leg: "vector:original", reason: "vector-fault", vectorFaults: 2 }]);
    expect(vectorLegEntries("vector:original", { degraded: true, degradedReason: "cap-truncation", vectorFaults: 0 }))
      .toEqual([{ leg: "vector:original", reason: "cap-truncation" }]);
    expect(vectorLegEntries("vector:original", { degraded: true, degradedReason: "excluded-dominant", vectorFaults: 3 }))
      .toEqual([{ leg: "vector:original", reason: "excluded-dominant" }, { leg: "vector:original", reason: "vector-fault", vectorFaults: 3 }]);
  });

  it("a single-leg reply keeps the older reason in its field and carries the count", () => {
    expect(flatDegraded([])).toEqual({});
    expect(flatDegraded([{ leg: "vsearch", reason: "vector-fault" }])).toEqual({ degraded: true, degradedReason: "vector-fault" });
    expect(flatDegraded([{ leg: "vsearch", reason: "vector-fault", vectorFaults: 2 }])).toEqual({ degraded: true, degradedReason: "vector-fault", vectorFaults: 2 });
    expect(flatDegraded([{ leg: "vsearch", reason: "cap-truncation" }, { leg: "vsearch", reason: "vector-fault", vectorFaults: 2 }]))
      .toEqual({ degraded: true, degradedReason: "cap-truncation", vectorFaults: 2 });
  });
});

describe("a refused QUERY vector, by route", () => {
  for (const mode of ["semantic", "discovery"]) {
    it(`memory_retrieve ${mode}: the lexical fallback answers, marked vector-fault, not labelled cosine`, async () => {
      embedAnswer = refused;
      const res = await call("memory_retrieve", { query: "tank filter", mode });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ degraded: true, degradedReason: "vector-fault" });
      expect(res.structuredContent.vectorFaults).toBeUndefined();
      expect(res.structuredContent.scoreBasis).not.toBe("vector-cosine");
      expect(paths(res).some(p => p.endsWith("tank.md"))).toBe(true);
      expect(paths(res).some(p => p.endsWith("bread.md"))).toBe(false);       // lexical: no term matches it
      expect(text(res)).toContain(NOTE);
    });
  }

  it("memory_retrieve hybrid: the vector leg is empty, the lexical leg answers, marked vector-fault", async () => {
    embedAnswer = refused;
    const res = await call("memory_retrieve", { query: "tank filter", mode: "hybrid" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ degraded: true, degradedReason: "vector-fault" });
    expect(paths(res).some(p => p.endsWith("tank.md"))).toBe(true);
    expect(text(res)).toContain(NOTE);
  });

  it("memory_retrieve complex: the refused clause is dropped alone and listed; the other clauses answer", async () => {
    embedAnswer = refused;
    const res = await call("memory_retrieve", { query: "tank filter and also cooking bread ovens", mode: "complex" });
    expect(res.isError).toBeFalsy();
    const legs = res.structuredContent?.degradedLegs ?? [];
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) expect(leg).toMatchObject({ leg: expect.stringMatching(/^complex:clause\d+:vector$/), reason: "vector-fault" });
    expect(res.structuredContent.degraded).toBe(true);
    expect(text(res)).toContain(NOTE);
  });

  it("vsearch: an explicit error — never lexical scores under a cosine label", async () => {
    embedAnswer = refused;
    const res = await call("vsearch", { query: "tank filter" });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(UNAVAILABLE);
    expect(res.structuredContent?.results).toBeUndefined();
  });

  it("find_similar: the same explicit error", async () => {
    embedAnswer = refused;
    const res = await call("find_similar", { file: "user/tank.md" });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(UNAVAILABLE);
  });

  it("query, original leg refused: the lexical lists answer; the leg is listed", async () => {
    embedAnswer = refused;
    expansions = [{ type: "lex", text: "tank" }];                 // the original leg is the only vector leg
    const res = await call("query", { query: "tank filter weekly" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.degradedLegs).toEqual([{ leg: "vector:original", reason: "vector-fault" }]);
    expect(res.structuredContent.degraded).toBe(true);
    expect(paths(res).some(p => p.endsWith("tank.md"))).toBe(true);
    expect(text(res)).toContain(NOTE);
  });

  it("query, an expanded leg refused: that leg alone is dropped and listed; the original leg answers", async () => {
    expansions = [{ type: "vec", text: "EXPANDED water pump" }, { type: "lex", text: "pump" }];
    embedAnswer = t => (t.includes("EXPANDED") ? refused() : healthy());
    const res = await call("query", { query: "tank filter water" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.degradedLegs).toEqual([{ leg: "vector:expansion0", reason: "vector-fault" }]);
    expect(paths(res).some(p => p.endsWith("tank.md"))).toBe(true);
  });

  it("query_plan: the refused vector clause is dropped alone and listed", async () => {
    embedAnswer = refused;
    const res = await call("query_plan", { query: "tank filter and also cooking bread ovens" });
    expect(res.isError).toBeFalsy();
    const legs = (res.structuredContent?.degradedLegs ?? []).filter((leg: any) => /^clause\d+:vector$/.test(leg.leg));
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) expect(leg.reason).toBe("vector-fault");
    expect(text(res)).toContain(NOTE);
  });

  it("vsearch, find_similar with an endpoint error that is NOT a refused vector: the error as before (measured on v0.43.6)", async () => {
    embedAnswer = () => { throw new Error("embed endpoint down"); };
    for (const [tool, args] of [["vsearch", { query: "tank filter" }], ["find_similar", { file: "user/tank.md" }]] as const) {
      const res = await call(tool, args);
      expect(res.isError).toBe(true);
      expect(text(res)).toBe("embed endpoint down");
    }
  });

  it("a healthy endpoint: no route is marked", async () => {
    for (const [tool, args] of [["memory_retrieve", { query: "tank filter", mode: "semantic" }], ["memory_retrieve", { query: "tank filter", mode: "hybrid" }],
      ["vsearch", { query: "tank filter" }], ["find_similar", { file: "user/tank.md" }], ["query", { query: "tank filter" }]] as const) {
      const res = await call(tool, args);
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.degraded).toBeUndefined();
      expect(res.structuredContent?.degradedLegs).toBeUndefined();
      expect(text(res)).not.toContain(NOTE);
    }
  });
});

describe("stored vectors the scan skipped as unusable, by route", () => {
  beforeAll(() => add("bad.md", "A note whose stored vector is all zeros.", [0, 0, 0, 0], true));

  it("vsearch: the results stand, the reply carries the reason and the count", async () => {
    const res = await call("vsearch", { query: "tank filter" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ degraded: true, degradedReason: "vector-fault", vectorFaults: 1 });
    expect(paths(res).some(p => p.endsWith("tank.md"))).toBe(true);
    expect(paths(res).some(p => p.endsWith("bad.md"))).toBe(false);
    expect(text(res)).toContain(NOTE);
  });

  it("memory_retrieve semantic: the vector leg served (cosine), marked with the count", async () => {
    const res = await call("memory_retrieve", { query: "tank filter", mode: "semantic" });
    expect(res.structuredContent).toMatchObject({ degraded: true, degradedReason: "vector-fault", vectorFaults: 1, scoreBasis: "vector-cosine" });
  });

  it("memory_retrieve hybrid, find_similar: marked with the count", async () => {
    const hybrid = await call("memory_retrieve", { query: "tank filter", mode: "hybrid" });
    expect(hybrid.structuredContent).toMatchObject({ degraded: true, degradedReason: "vector-fault", vectorFaults: 1 });
    const similar = await call("find_similar", { file: "user/tank.md" });
    expect(similar.structuredContent).toMatchObject({ degraded: true, degradedReason: "vector-fault", vectorFaults: 1 });
  });

  it("query: each leg that met them lists `vector-fault` with the count", async () => {
    expansions = [{ type: "vec", text: "water pump" }];
    const res = await call("query", { query: "tank filter cleaned" });
    expect(res.structuredContent.degradedLegs).toEqual([
      { leg: "vector:original", reason: "vector-fault", vectorFaults: 1 },
      { leg: "vector:expansion0", reason: "vector-fault", vectorFaults: 1 },
    ]);
  });
});
