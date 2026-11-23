/**
 * BACKLOG 82.2, D4 — the causal rows of the route table, on `runCausalRetrieval` itself:
 *  - the two vector-anchor lookups: a refused QUERY vector leaves the anchors to the lexical side, is recorded as
 *    `vector-fault`, and is not rethrown; stored vectors the scan skipped are recorded with the count;
 *  - the graph expansion (it embeds the query itself): a refused query vector skips the graph legs, returns the
 *    fused anchors — as for an endpoint that is down — and is MARKED (`causal:graph`, `vector-fault`); an endpoint
 *    that is down stays unmarked, as before.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createStore, canonicalDocId, VecDimensionMismatchError, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";
import { runCausalRetrieval, type CausalRetrievalOptions } from "../../src/causal-retrieval.ts";
import { VecPoisonError } from "../../src/vector-guard.ts";

import { seedContent } from "../helpers/seed-content.ts";
const MODEL = "route-fake";
/** Every term is in `tank.md`: the lexical anchor lookup finds it alone (the intent is forced, not read from the text). */
const QUERY = "tank filter cleaned";
const healthy = async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: MODEL });
const refused = async () => { throw new VecPoisonError("non-finite", "endpoint", { context: "query" } as never, { elementIndex: 0 }); };
const down = async () => { throw new Error("embed endpoint down"); };

let store: Store;
/** The embedder the STORE uses for the anchor lookups (the process default). */
let anchorEmbed: () => Promise<unknown> = healthy;
/** The embedder handed to the pipeline: the graph expansion embeds the query with it. */
let graphEmbed: () => Promise<unknown> = healthy;
const llmOf = (embed: () => Promise<unknown>) => ({ embed: async () => embed(), query: async () => null, expandQuery: async () => [] }) as any;
const OPTS: CausalRetrievalOptions = {
  forceIntent: "WHY",
  stages: { traversal: true, mpfp: false, entityExpansion: false, rerank: false, causalOneHop: false },
  baseEligibility: { excludeCollections: ["_clawmem"] },
  whyObservationLane: false,
};
const run = (opts: Partial<CausalRetrievalOptions> = {}) => runCausalRetrieval(store, llmOf(() => graphEmbed()), QUERY, { ...OPTS, ...opts });

function add(collection: string, path: string, body: string, vector: number[], raw = false): void {
  const now = new Date().toISOString();
  const hash = hashContent(body + path);
  seedContent(store.db, hash, body, now);
  store.insertDocument(collection, path, path.replace(/\.md$/, ""), hash, now, now);
  store.ensureVecTable(4);
  store.insertEmbedding(hash, 0, 0, new Float32Array(raw ? [1, 0, 0, 0] : vector), MODEL, now, "full", undefined, canonicalDocId(collection, path));
  if (raw) {
    store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_0`);
    store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(vector));
  }
  store.markEmbedSynced(hash);
}

beforeAll(() => {
  store = createStore(":memory:");
  setDefaultLlamaCpp(llmOf(() => anchorEmbed()));
  add("user", "tank.md", "The tank filter is cleaned every week because the water turns cloudy.", [1, 0, 0, 0]);
  add("user", "pump.md", "A pump moves water through the filter of the tank at night.", [0.9, 0.1, 0, 0]);
  add("user", "bread.md", "Unrelated cooking notes about bread ovens and flour.", [0, 1, 0, 0]);
});
afterAll(() => { setDefaultLlamaCpp(null); store.close(); });
beforeEach(() => { anchorEmbed = healthy; graphEmbed = healthy; });

const titles = (r: { results: { displayPath: string }[] }) => r.results.map(x => x.displayPath);

describe("causal retrieval — a refused query vector", () => {
  it("a healthy run records nothing", async () => {
    const result = await run();
    expect(result.degraded).toEqual([]);
    expect(titles(result).some(p => p.endsWith("tank.md"))).toBe(true);
  });

  it("the anchor lookup: lexical anchors only, recorded as vector-fault, not rethrown", async () => {
    anchorEmbed = refused;
    const result = await run();
    expect(result.degraded).toContainEqual({ leg: "causal:vector", reason: "vector-fault" });
    expect(titles(result).some(p => p.endsWith("tank.md"))).toBe(true);
    expect(titles(result).some(p => p.endsWith("bread.md"))).toBe(false);     // no lexical term matches it
  });

  it("the observation-lane lookup is recorded too when the lane is active", async () => {
    anchorEmbed = refused;
    const result = await run({ whyObservationLane: true });
    expect(result.degraded).toContainEqual({ leg: "causal:vector", reason: "vector-fault" });
    expect(result.degraded).toContainEqual({ leg: "causal:observation-vector", reason: "vector-fault" });
  });

  it("the graph expansion: the graph legs are skipped, the fused anchors are returned, and it is MARKED", async () => {
    graphEmbed = refused;
    const result = await run();
    expect(result.degraded).toEqual([{ leg: "causal:graph", reason: "vector-fault" }]);
    expect(titles(result).some(p => p.endsWith("tank.md"))).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("the graph expansion with an endpoint that is down: skipped and NOT marked, as before", async () => {
    graphEmbed = down;
    const result = await run();
    expect(result.degraded).toEqual([]);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("a dimension error in the anchor lookup is still raised", async () => {
    anchorEmbed = async () => { throw new VecDimensionMismatchError(4, 8); };
    await expect(run()).rejects.toThrow("Embedding dimension changed");
  });
});

describe("causal retrieval — stored vectors the scan skipped", () => {
  beforeAll(() => add("user", "bad.md", "A note whose stored vector is all zeros.", [0, 0, 0, 0], true));

  it("the anchor lookup records vector-fault with the count; the results stand", async () => {
    const result = await run();
    expect(result.degraded).toEqual([{ leg: "causal:vector", reason: "vector-fault", vectorFaults: 1 }]);
    expect(titles(result).some(p => p.endsWith("tank.md"))).toBe(true);
    expect(titles(result).some(p => p.endsWith("bad.md"))).toBe(false);
  });
});
