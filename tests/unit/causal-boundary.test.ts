import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * #343 remediation — production-boundary tests for the shared causal pipeline (v0.32.0):
 * route-drift unification, the WHY observation lane, the bounded bidirectional one-hop
 * causal step, per-leg candidate eligibility, and entity-triple provenance.
 *
 * Design of record: .codex-review/s343-defects-design-2026-08-04.md (DESIGN CLEARED).
 * Real MCP handlers over an in-memory transport + the real REST server on an ephemeral
 * port, plus store-level provenance units on throwaway DBs.
 */

import { unlinkSync } from "fs";
import { createHash } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { startServer } from "../../src/server.ts";

// The REST server needs a token on every request and a JSON Content-Type on every POST (BACKLOG 62.4).
const REST_TOKEN = "rest-test-token-62-4-0000000000000000000000";
const AUTH = { Authorization: `Bearer ${REST_TOKEN}` };
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";
import { adaptiveTraversal, mpfpTraversal } from "../../src/graph-traversal.ts";
import { runCausalRetrieval, hasCausalSignal, hasTimelineSignal, baseAdmissible } from "../../src/causal-retrieval.ts";

const TEST_DB = "/tmp/clawmem-causal-boundary-test.sqlite";
const MODEL = "causal-fake";

// Keyword-steered fake embedder (mcp-routes pattern): query/doc clusters by marker word.
function fakeVec(text: string): Float32Array {
  const t = text.toLowerCase();
  if (t.includes("starve")) return new Float32Array([1, 0.02, 0, 0]);   // NEARER to the query than l1
  if (t.includes("lanevec")) return new Float32Array([0.9, 0.2, 0, 0]); // the observation, slightly farther
  if (t.includes("pipeline") || t.includes("deploy")) return new Float32Array([1, 0.05, 0, 0]);
  if (t.includes("fanout")) return new Float32Array([0, 1, 0.05, 0]);
  const j = (createHash("sha256").update(text).digest()[0]! / 255) * 0.2;
  return new Float32Array([j, 0.1, 1, 0]);
}
const fakeLlm = {
  embed: async (text: string) => {
    // "ember probe" simulates an unavailable embedding service (nonfatal error class) —
    // exercises the pipeline's per-leg containment (T6-F1): anchors must survive.
    if (text.includes("ember probe")) throw new Error("embed endpoint down (containment probe)");
    return { embedding: fakeVec(text), model: MODEL };
  },
  // No `generate`: classifyIntent's LLM refinement throws and the heuristic decides —
  // deterministic for the strongly-signaled phrasings used below.
  // rerank returns zero scores → store.rerank's zero-fill path (graceful degrade).
  rerank: async () => ({ results: [] as { file: string; score: number }[] }),
  query: async () => null,
  expandQuery: async () => [],
} as any;

let client: Client;
let closeAllStores: () => void;
let seedStore: Store;
let restServer: ReturnType<typeof startServer> | null = null;

const WHY_QUERY = "why did the pipeline deploy fail after the cache migration";

function seedDoc(store: Store, col: string, path: string, body: string, opts?: { contentType?: string; modifiedAt?: string }): string {
  const hash = hashContent(body + col + path);
  const now = opts?.modifiedAt ?? new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument(col, path, path, hash, now, now);
  if (opts?.contentType) {
    const row = store.db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1`).get(hash) as { id: number };
    store.updateDocumentMeta(row.id, { content_type: opts.contentType, confidence: 0.85 });
  }
  store.markEmbedSynced(hash);
  return hash;
}

function seedObservation(store: Store, path: string, body: string, obsType: string): string {
  const contentType = ["decision", "preference", "milestone", "problem"].includes(obsType) ? obsType : "observation";
  const hash = seedDoc(store, "_clawmem", path, body, { contentType });
  store.updateObservationFields(path, "_clawmem", { observation_type: obsType });
  return hash;
}

function idOf(store: Store, hash: string): number {
  return (store.db.prepare(`SELECT id FROM documents WHERE hash = ?`).get(hash) as { id: number }).id;
}

function causalEdge(store: Store, fromId: number, toId: number, weight: number) {
  store.db.prepare(`INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'causal', ?, datetime('now'))`).run(fromId, toId, weight);
}

function semanticEdge(store: Store, fromId: number, toId: number, weight: number) {
  store.db.prepare(`INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, 'semantic', ?, datetime('now'))`).run(fromId, toId, weight);
}

type ToolResult = { structuredContent?: any; content?: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  await client.callTool({ name, arguments: args }) as ToolResult;

const itemPaths = (r: ToolResult): string[] =>
  (r.structuredContent?.results ?? []).map((x: any) => x.path ?? x.file ?? "");

beforeAll(async () => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  Bun.env.INDEX_PATH = TEST_DB;
  setDefaultLlamaCpp(fakeLlm);

  seedStore = createStore(TEST_DB);
  seedStore.ensureVecTable(4);

  // Anchor: user doc containing the WHY query's every token (FTS ANDs terms).
  const anchorHash = seedDoc(seedStore, "user", "deploy-note.md",
    "why did the pipeline deploy fail after the cache migration — incident record. the pipeline deploy failed once the cache migration toggled.");
  seedStore.insertEmbedding(anchorHash, 0, 0, fakeVec("pipeline deploy"), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("user", "deploy-note.md"));
  const anchorId = idOf(seedStore, anchorHash);

  // CAUSE: a DECISION-typed observation (F1: the lane predicate must admit decision-typed
  // observations — content_type='decision', observation_type set). No query tokens in the
  // body: reachable ONLY through the backward causal hop.
  const causeHash = seedObservation(seedStore, "observations/2026-08-01-aaaa-decision-c1.md",
    "chose to enable the cache migration for the build system", "decision");
  causalEdge(seedStore, idOf(seedStore, causeHash), anchorId, 0.9);

  // EFFECT: a problem-typed observation downstream of the anchor.
  const effectHash = seedObservation(seedStore, "observations/2026-08-02-bbbb-problem-e1.md",
    "rollback problem recorded for the release train", "problem");
  causalEdge(seedStore, anchorId, idOf(seedStore, effectHash), 0.8);

  // LANE: an observation whose body matches the WHY query directly (internal anchor lane).
  seedObservation(seedStore, "observations/2026-08-03-cccc-observation-l1.md",
    "why did the pipeline deploy fail after the cache migration — observed the deploy failure follow the migration decision", "observation");

  // NON-OBSERVATION internal artifacts with the same matching body — the lane must never
  // admit them (handoffs/deductions are excluded by the structural predicate).
  seedDoc(seedStore, "_clawmem", "handoffs/h1.md",
    "why did the pipeline deploy fail after the cache migration — handoff summary");
  seedDoc(seedStore, "_clawmem", "deductions/d1.md",
    "why did the pipeline deploy fail after the cache migration — deduction note");
  // Each lane predicate must hold INDEPENDENTLY: an untyped doc under observations/ (partial
  // write shape) and a typed doc outside observations/ are both refused.
  seedDoc(seedStore, "_clawmem", "observations/zz-untyped.md",
    "why did the pipeline deploy fail after the cache migration — untyped observation shell");
  const untypedHash = hashContent("why did the pipeline deploy fail after the cache migration — untyped observation shell" + "_clawmem" + "observations/zz-untyped.md");
  // Vector near the WHY query: the vec-side lane predicate must refuse this untyped doc too.
  seedStore.insertEmbedding(untypedHash, 0, 0, fakeVec("pipeline deploy untyped"), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("_clawmem", "observations/zz-untyped.md"));
  const typedHandoffHash = seedDoc(seedStore, "_clawmem", "handoffs/typed-h2.md",
    "why did the pipeline deploy fail after the cache migration — typed handoff");
  seedStore.updateObservationFields("handoffs/typed-h2.md", "_clawmem", { observation_type: "observation" });
  // Causal edges INTO the refused artifacts: the one-hop admission predicate must refuse them
  // independently of the anchor-lane predicate (a weakened hop admission is otherwise invisible).
  causalEdge(seedStore, anchorId, idOf(seedStore, untypedHash), 0.85);
  causalEdge(seedStore, anchorId, idOf(seedStore, typedHandoffHash), 0.85);

  // Lane-starvation fixture (T6-F4 / T7-F1): 16 handoffs that FTS-match the WHY query and
  // outrank the observation inside _clawmem, AND carry vectors NEARER to the query than the
  // observation's — starving both channels' first pass. The structural predicate in the search
  // SQL (FTS) and the escalation loop (vector) must still surface the observation.
  for (let i = 0; i < 16; i++) {
    const p = `handoffs/starve-${String(i).padStart(2, "0")}.md`;
    const h = seedDoc(seedStore, "_clawmem", p,
      "why did the pipeline deploy fail after the cache migration — why did the pipeline deploy fail starvation filler");
    seedStore.insertEmbedding(h, 0, 0, fakeVec("starve"), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("_clawmem", p));
  }
  const l1Hash = hashContent("why did the pipeline deploy fail after the cache migration — observed the deploy failure follow the migration decision" + "_clawmem" + "observations/2026-08-03-cccc-observation-l1.md");
  seedStore.insertEmbedding(l1Hash, 0, 0, fakeVec("lanevec"), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("_clawmem", "observations/2026-08-03-cccc-observation-l1.md"));

  // Second WHY anchor with a causal edge INTO the same cause endpoint (T6-F7): one endpoint,
  // two associations, one global slot.
  const anchor2Hash = seedDoc(seedStore, "user", "deploy-note-2.md",
    "why did the pipeline deploy fail after the cache migration — second incident record");
  causalEdge(seedStore, idOf(seedStore, anchor2Hash), idOf(seedStore, causeHash), 0.7);

  // Invalidated semantic neighbor (T6-F3): must never surface through production-caller traversal.
  const invalidHash = seedDoc(seedStore, "user", "invalid-neighbor.md", "invalidated semantics target for traversal checks");
  semanticEdge(seedStore, anchorId, idOf(seedStore, invalidHash), 0.95);
  seedStore.db.prepare(`UPDATE documents SET invalidated_at = ? WHERE hash = ?`).run(new Date().toISOString(), invalidHash);

  // Containment fixture (T6-F1): only FTS can find this; the embedder throws on its tokens.
  seedDoc(seedStore, "user", "embertest.md", "why did the ember probe collapse — ember probe collapse record");

  // Collection-policy fixture (T6-F3): traversal-only reachable doc in a non-'user' collection.
  const auxHash = seedDoc(seedStore, "aux", "aux-neighbor.md", "unrelated aux semantics target");
  semanticEdge(seedStore, anchorId, idOf(seedStore, auxHash), 0.85);

  // Seed-fence fixture (T6-F5): a user doc reachable ONLY via a semantic edge FROM the lane
  // observation. If lane results ever seed traversal, this leaks into filtered-caller output.
  const laneLeakHash = seedDoc(seedStore, "user", "lane-leak-target.md", "reachable only through the lane observation");
  const l1Id = (seedStore.db.prepare(`SELECT id FROM documents WHERE collection = '_clawmem' AND path = 'observations/2026-08-03-cccc-observation-l1.md'`).get() as { id: number }).id;
  semanticEdge(seedStore, l1Id, idOf(seedStore, laneLeakHash), 0.95);

  // Semantic neighbor with no query tokens: reachable only via adaptive traversal.
  const semHash = seedDoc(seedStore, "user", "sem-neighbor.md", "unrelated semantics target for traversal checks");
  semanticEdge(seedStore, anchorId, idOf(seedStore, semHash), 0.9);

  // High-degree fixture: one anchor with 20 causal effects (breadth caps).
  const fanHash = seedDoc(seedStore, "user", "fanout.md",
    "why did the fanout probe alpha fail — fanout probe alpha incident record");
  seedStore.insertEmbedding(fanHash, 0, 0, fakeVec("fanout"), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("user", "fanout.md"));
  const fanId = idOf(seedStore, fanHash);
  for (let i = 0; i < 20; i++) {
    const w = 0.05 + i * 0.045; // weights rise with i → the cap must keep i=19,18,17
    const h = seedObservation(seedStore, `observations/fan-${String(i).padStart(2, "0")}.md`,
      `fan effect number ${i} recorded`, "observation");
    causalEdge(seedStore, fanId, idOf(seedStore, h), w);
  }

  // Entity-expansion contrast fixture: target doc reachable ONLY via co-occurrence.
  const entTargetHash = seedDoc(seedStore, "user", "entity-only.md", "entity expansion target document");
  const now = new Date().toISOString();
  seedStore.db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, created_at) VALUES (?, 'concept', ?, ?)`).run("default:concept:e1", "e1", now);
  seedStore.db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, created_at) VALUES (?, 'concept', ?, ?)`).run("default:concept:e2", "e2", now);
  seedStore.db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, 'e1', ?)`).run("default:concept:e1", anchorId, now);
  seedStore.db.prepare(`INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, 'e2', ?)`).run("default:concept:e2", idOf(seedStore, entTargetHash), now);
  seedStore.db.prepare(`INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES (?, ?, 5, ?)`).run("default:concept:e1", "default:concept:e2", now);

  // kg_query provenance fixture: canonical-ID entity with three unique evidence sources,
  // one of them unattributed (fact-only).
  seedStore.db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, created_at) VALUES (?, 'concept', ?, ?)`).run("default:concept:brontal", "brontalxyz", now);
  const evDoc1 = idOf(seedStore, anchorHash);
  const evDoc2 = idOf(seedStore, semHash);
  seedStore.addTriple("default:concept:brontal", "governs", null, "handshake ordering", { sourceDocId: evDoc1, sourceFact: "brontal governs handshake ordering" });
  seedStore.addTriple("default:concept:brontal", "governs", null, "handshake ordering", { sourceDocId: evDoc1, sourceFact: "brontal governs handshake ordering" }); // exact dup — ignored
  seedStore.addTriple("default:concept:brontal", "governs", null, "handshake ordering", { sourceDocId: evDoc2, sourceFact: "second sighting" });
  seedStore.addTriple("default:concept:brontal", "governs", null, "handshake ordering", { sourceFact: "unattributed corpus note" });

  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "causal-boundary-tests", version: "0.0.0" });
  await client.connect(clientTransport);

  restServer = startServer(seedStore, 0, "127.0.0.1", { token: REST_TOKEN });
});

afterAll(() => {
  try { restServer?.stop(true); } catch { /* stopped */ }
  try { closeAllStores(); } catch { /* closed */ }
  try { seedStore.close(); } catch { /* closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  try { unlinkSync(TEST_DB); } catch { /* gone */ }
});

// =============================================================================
// Shared classifier signals
// =============================================================================

describe("shared causal/timeline signals (route-drift F6)", () => {
  it("recognizes the phrasings the REST copy used to miss", () => {
    expect(hasCausalSignal("why were the deploys failing")).toBe(true);
    expect(hasCausalSignal("because we chose the smaller cache")).toBe(true);
    expect(hasCausalSignal("what is the cache size")).toBe(false);
    expect(hasTimelineSignal("what did we do last session")).toBe(true);
  });
});

// =============================================================================
// memory_retrieve causal — WHY observation lane + bidirectional one-hop
// =============================================================================

describe("memory_retrieve causal (filtered caller, lane on)", () => {
  it("reaches a cause backward along a causal edge — a DECISION-typed observation (F1+F2)", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 15 });
    expect(res.structuredContent?.intent?.intent).toBe("WHY");
    const paths = itemPaths(res);
    expect(paths).toContain("_clawmem/observations/2026-08-01-aaaa-decision-c1.md");
    const causeItem = (res.structuredContent?.results ?? []).find((x: any) => x.path === "_clawmem/observations/2026-08-01-aaaa-decision-c1.md");
    expect(causeItem?.causal?.some((a: any) => a.direction === "cause")).toBe(true);
  });

  it("reaches an effect forward along a causal edge, labeled 'effect'", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 15 });
    const effectItem = (res.structuredContent?.results ?? []).find((x: any) => x.path === "_clawmem/observations/2026-08-02-bbbb-problem-e1.md");
    expect(effectItem).toBeDefined();
    expect(effectItem?.causal?.some((a: any) => a.direction === "effect")).toBe(true);
  });

  it("surfaces a matching observation through the internal anchor lane", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 15 });
    expect(itemPaths(res)).toContain("_clawmem/observations/2026-08-03-cccc-observation-l1.md");
  });

  it("never surfaces handoffs or deductions through the lane, even with matching bodies", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 25 });
    const paths = itemPaths(res);
    expect(paths.filter(p => p.includes("/handoffs/") || p.includes("/deductions/"))).toEqual([]);
  });

  it("survives lane starvation: 16 outranking handoffs cannot hide the observation (T6-F4)", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 25 });
    const paths = itemPaths(res);
    expect(paths).toContain("_clawmem/observations/2026-08-03-cccc-observation-l1.md");
    expect(paths.filter(p => p.includes("handoffs/starve-"))).toEqual([]);
  });

  it("survives VECTOR lane starvation: escalation probes past 16 nearer non-observations (T7-F1)", async () => {
    const det = await seedStore.searchVecDetailed(WHY_QUERY, MODEL, 5, { collections: ["_clawmem"], observationsOnly: true });
    const paths = det.results.map(r => r.displayPath);
    expect(paths).toContain("_clawmem/observations/2026-08-03-cccc-observation-l1.md");
    expect(paths.filter(p => p.includes("handoffs/"))).toEqual([]);
  });

  it("accumulates associations on one endpoint: two anchors, one slot, both directions (T6-F7)", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 25 });
    const items = (res.structuredContent?.results ?? []).filter((x: any) => x.path === "_clawmem/observations/2026-08-01-aaaa-decision-c1.md");
    expect(items.length).toBe(1);
    const causal = items[0]?.causal ?? [];
    expect(causal.length).toBeGreaterThanOrEqual(2);
    expect(causal.some((a: any) => a.direction === "cause")).toBe(true);
    expect(causal.some((a: any) => a.direction === "effect")).toBe(true);
  });

  it("degrades to fused anchors when the embedding service is down (T6-F1)", async () => {
    const res = await call("memory_retrieve", { query: "why did the ember probe collapse", mode: "causal", limit: 10 });
    expect(itemPaths(res)).toContain("user/embertest.md");
  });

  it("prunes invalidated neighbors in production-caller traversal (T6-F3)", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 25 });
    const paths = itemPaths(res);
    expect(paths).not.toContain("user/invalid-neighbor.md");
    expect(paths).toContain("user/sem-neighbor.md");
  });

  it("lane results never seed graph expansion (T6-F5): the lane-only-reachable doc stays out", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 50 });
    expect(itemPaths(res)).not.toContain("user/lane-leak-target.md");
  });

  it("each lane predicate holds independently: untyped-in-observations and typed-outside both refused", async () => {
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 25 });
    const paths = itemPaths(res);
    expect(paths).not.toContain("_clawmem/observations/zz-untyped.md");
    expect(paths).not.toContain("_clawmem/handoffs/typed-h2.md");
  });

  it("enforces the GLOBAL one-hop cap independently of the per-anchor cap", async () => {
    const result = await runCausalRetrieval(seedStore, fakeLlm, "why did the fanout probe alpha fail", {
      stages: { traversal: false, mpfp: false, entityExpansion: false, rerank: false, causalOneHop: true },
      budgets: { oneHopGlobal: 2 },
      baseEligibility: { excludeCollections: ["_clawmem"] },
      whyObservationLane: true,
    });
    const fanHits = result.results.filter(r => r.displayPath.startsWith("_clawmem/observations/fan-"));
    expect(fanHits.length).toBeLessThanOrEqual(2);
    expect(fanHits.length).toBeGreaterThan(0);
  });

  it("gives non-WHY intents no observation exception (E)", async () => {
    const res = await call("memory_retrieve", { query: "who worked on the pipeline deploy team roster", mode: "causal", limit: 25 });
    expect(res.structuredContent?.intent?.intent).not.toBe("WHY");
    const paths = itemPaths(res);
    expect(paths.filter(p => p.startsWith("_clawmem/"))).toEqual([]);
  });

  it("bounds one-hop breadth: a 20-edge anchor contributes at most 3 hits (T3-F2)", async () => {
    const res = await call("memory_retrieve", { query: "why did the fanout probe alpha fail", mode: "causal", limit: 30 });
    const fanHits = itemPaths(res).filter(p => p.startsWith("_clawmem/observations/fan-"));
    expect(fanHits.length).toBeGreaterThan(0);
    expect(fanHits.length).toBeLessThanOrEqual(3);
    // Highest-weight edges win the per-anchor cap (weights rise with the index).
    expect(fanHits).toContain("_clawmem/observations/fan-19.md");
  });

  it("keeps includeInternal semantics: internal anchors stay excluded for non-lane content", async () => {
    // Handoff bodies match the query; includeInternal:true lifts the anchor filter.
    const res = await call("memory_retrieve", { query: WHY_QUERY, mode: "causal", limit: 50, includeInternal: true });
    expect(itemPaths(res).some(p => p.includes("/handoffs/"))).toBe(true);
  });
});

// =============================================================================
// intent_search — unfiltered contract + the graph master switch (F3)
// =============================================================================

describe("intent_search (unfiltered caller)", () => {
  it("enable_graph_traversal=false disables EVERY graph stage including the one-hop (F3)", async () => {
    const res = await call("intent_search", { query: WHY_QUERY, enable_graph_traversal: false, limit: 25 });
    const files = (res.structuredContent?.results ?? []).map((x: any) => x.file ?? "");
    expect(files.some((f: string) => f.includes("observations/2026-08-01-aaaa-decision-c1.md"))).toBe(false);
    expect(files.some((f: string) => f.includes("sem-neighbor.md"))).toBe(false);
  });

  it("with traversal on, the one-hop cause arrives (pure capability, no visibility change)", async () => {
    const res = await call("intent_search", { query: WHY_QUERY, enable_graph_traversal: true, limit: 25 });
    const files = (res.structuredContent?.results ?? []).map((x: any) => x.file ?? "");
    expect(files.some((f: string) => f.includes("observations/2026-08-01-aaaa-decision-c1.md"))).toBe(true);
  });

  it("remains unfiltered by design: internal docs reachable as plain anchors", async () => {
    const res = await call("intent_search", { query: WHY_QUERY, enable_graph_traversal: false, limit: 25 });
    const files = (res.structuredContent?.results ?? []).map((x: any) => x.file ?? "");
    expect(files.some((f: string) => f.includes("_clawmem/"))).toBe(true);
  });
});

// =============================================================================
// Entity expansion — legacy stage confinement (T3-F1 / T4-F1)
// =============================================================================

describe("entity expansion confinement", () => {
  it("intent_search (its only home) reaches the co-occurrence-only target under ENTITY", async () => {
    const res = await call("intent_search", { query: "pipeline deploy incident record", force_intent: "ENTITY", limit: 30 });
    const files = (res.structuredContent?.results ?? []).map((x: any) => x.file ?? "");
    expect(files.some((f: string) => f.includes("entity-only.md"))).toBe(true);
  });

  it("the filtered pipeline never runs entity expansion", async () => {
    const result = await runCausalRetrieval(seedStore, fakeLlm, "pipeline deploy incident record", {
      forceIntent: "ENTITY",
      stages: { traversal: true, mpfp: true, entityExpansion: false, rerank: false, causalOneHop: true },
      baseEligibility: { excludeCollections: ["_clawmem"] },
      whyObservationLane: true,
    });
    expect(result.results.some(r => r.displayPath.includes("entity-only.md"))).toBe(false);
  });
});

// =============================================================================
// query_plan graph clause — real handler (T6-F3 / T6-F10)
// =============================================================================

describe("query_plan graph clause (real handler)", () => {
  it("runs the lane + one-hop through the clause and attaches causal associations", async () => {
    const res = await call("query_plan", { query: WHY_QUERY, limit: 30 });
    const items = (res.structuredContent?.results ?? []) as any[];
    const cause = items.find(x => (x.path ?? x.file ?? "").includes("observations/2026-08-01-aaaa-decision-c1.md"));
    expect(cause).toBeDefined();
    expect(cause?.causal?.some((a: any) => a.direction === "cause" || a.direction === "effect")).toBe(true);
  });

  it("keeps the default internal exclusion through the clause path", async () => {
    const res = await call("query_plan", { query: WHY_QUERY, limit: 30 });
    const paths = (res.structuredContent?.results ?? []).map((x: any) => x.path ?? x.file ?? "");
    expect(paths.filter((p: string) => p.includes("/handoffs/") || p.includes("/deductions/"))).toEqual([]);
  });
});

// =============================================================================
// Hydration admission guard — independent of traversal SQL (T7-F2)
// =============================================================================

describe("baseAdmissible (defense-in-depth guard)", () => {
  const range = { start: "2026-08-01T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z" };

  it("enforces the time window on the effective-time axis, failing CLOSED on unknown time", () => {
    const base = { timeRange: range };
    expect(baseAdmissible({ collectionName: "user" }, base, "2026-08-10T00:00:00.000Z")).toBe(true);
    expect(baseAdmissible({ collectionName: "user" }, base, "2026-07-10T00:00:00.000Z")).toBe(false);
    expect(baseAdmissible({ collectionName: "user" }, base, null)).toBe(false);
    expect(baseAdmissible({ collectionName: "user" }, base, undefined)).toBe(false);
  });

  it("enforces collection allow/exclude before time", () => {
    expect(baseAdmissible({ collectionName: "aux" }, { allowCollections: ["user"] })).toBe(false);
    expect(baseAdmissible({ collectionName: "_clawmem" }, { excludeCollections: ["_clawmem"] })).toBe(false);
    expect(baseAdmissible({ collectionName: "user" }, {})).toBe(true);
  });
});

// =============================================================================
// baseEligibility collection policy through the pipeline (T6-F3)
// =============================================================================

describe("collection policy threading", () => {
  // Both cases exclude _clawmem so the WHY-weighted causal fan-out cannot crowd the beam;
  // the ONLY difference between them is the allowCollections axis under test. (Unrestricted,
  // 20+ causal fan candidates outrank both semantic neighbors at any reasonable beam — that
  // would make these assertions about beam pressure, not collection policy.)
  it("allowCollections constrains traversal discoveries, not just anchors", async () => {
    const result = await runCausalRetrieval(seedStore, fakeLlm, WHY_QUERY, {
      stages: { traversal: true, mpfp: false, entityExpansion: false, rerank: false, causalOneHop: false },
      baseEligibility: { allowCollections: ["user"] },
      whyObservationLane: false,
    });
    const paths = result.results.map(r => r.displayPath);
    expect(paths.some(p => p.includes("aux-neighbor.md"))).toBe(false);
    expect(paths.some(p => p.includes("sem-neighbor.md"))).toBe(true);
  });

  it("with only the internal exclusion, the aux-collection neighbor is traversal-reachable (fixture guard)", async () => {
    const result = await runCausalRetrieval(seedStore, fakeLlm, WHY_QUERY, {
      stages: { traversal: true, mpfp: false, entityExpansion: false, rerank: false, causalOneHop: false },
      baseEligibility: { excludeCollections: ["_clawmem"] },
      whyObservationLane: false,
    });
    const paths = result.results.map(r => r.displayPath);
    expect(paths.some(p => p.includes("aux-neighbor.md"))).toBe(true);
    expect(paths.some(p => p.includes("sem-neighbor.md"))).toBe(true);
  });
});

// =============================================================================
// Eligibility legs (F3): inactive/invalidated/time never consume budget
// =============================================================================

describe("candidate eligibility in traversal legs", () => {
  it("an INACTIVE high-weight neighbor neither appears nor consumes the beam slot", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const anchor = seedDoc(store, "user", "a.md", "anchor");
    const hot = seedDoc(store, "user", "hot.md", "hot neighbor");
    const cold = seedDoc(store, "user", "cold.md", "cold neighbor");
    semanticEdge(store, idOf(store, anchor), idOf(store, hot), 1.0);
    semanticEdge(store, idOf(store, anchor), idOf(store, cold), 0.4);
    store.deactivateDocument("user", "hot.md", "forget");

    const nodes = adaptiveTraversal(store.db, [{ hash: anchor, score: 1 }], {
      maxDepth: 1, beamWidth: 1, budget: 10, intent: "WHAT", queryEmbedding: [1, 0, 0, 0], eligibility: {},
    });
    expect(nodes.some(n => n.docId === idOf(store, hot))).toBe(false);
    expect(nodes.some(n => n.docId === idOf(store, cold))).toBe(true);
    store.close();
  });

  it("an INVALIDATED high-weight neighbor neither appears nor consumes the beam slot", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const anchor = seedDoc(store, "user", "a.md", "anchor");
    const hot = seedDoc(store, "user", "hot.md", "hot neighbor");
    const cold = seedDoc(store, "user", "cold.md", "cold neighbor");
    semanticEdge(store, idOf(store, anchor), idOf(store, hot), 1.0);
    semanticEdge(store, idOf(store, anchor), idOf(store, cold), 0.4);
    store.db.prepare(`UPDATE documents SET invalidated_at = ? WHERE hash = ?`).run(new Date().toISOString(), hot);

    const nodes = adaptiveTraversal(store.db, [{ hash: anchor, score: 1 }], {
      maxDepth: 1, beamWidth: 1, budget: 10, intent: "WHAT", queryEmbedding: [1, 0, 0, 0], eligibility: {},
    });
    expect(nodes.some(n => n.docId === idOf(store, hot))).toBe(false);
    expect(nodes.some(n => n.docId === idOf(store, cold))).toBe(true);
    store.close();
  });

  it("a time-windowed traversal drops out-of-range neighbors on the effective-time axis", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const anchor = seedDoc(store, "user", "a.md", "anchor");
    const fresh = seedDoc(store, "user", "fresh.md", "fresh neighbor");
    const stale = seedDoc(store, "user", "stale.md", "stale neighbor", { modifiedAt: "2020-01-01T00:00:00.000Z" });
    semanticEdge(store, idOf(store, anchor), idOf(store, fresh), 0.5);
    semanticEdge(store, idOf(store, anchor), idOf(store, stale), 1.0);

    const nodes = adaptiveTraversal(store.db, [{ hash: anchor, score: 1 }], {
      maxDepth: 1, beamWidth: 2, budget: 10, intent: "WHAT", queryEmbedding: [1, 0, 0, 0],
      eligibility: { timeRange: { start: new Date(Date.now() - 86400_000).toISOString(), end: new Date().toISOString() } },
    });
    expect(nodes.some(n => n.docId === idOf(store, stale))).toBe(false);
    expect(nodes.some(n => n.docId === idOf(store, fresh))).toBe(true);
    store.close();
  });

  it("MPFP propagates no mass to ineligible rows", () => {
    const store = createStore(":memory:");
    store.ensureVecTable(4);
    const anchor = seedDoc(store, "user", "a.md", "anchor");
    const gone = seedDoc(store, "user", "gone.md", "inactive target");
    const kept = seedDoc(store, "user", "kept.md", "active target");
    semanticEdge(store, idOf(store, anchor), idOf(store, gone), 1.0);
    semanticEdge(store, idOf(store, anchor), idOf(store, kept), 0.9);
    store.deactivateDocument("user", "gone.md", "forget");

    const nodes = mpfpTraversal(store.db, [{ hash: anchor, score: 1 }], "WHY", 20, {});
    expect(nodes.some(n => n.docId === idOf(store, gone))).toBe(false);
    expect(nodes.some(n => n.docId === idOf(store, kept))).toBe(true);
    store.close();
  });
});

// =============================================================================
// REST /retrieve causal — shared pipeline, allowAll posture, classifier parity
// =============================================================================

describe("REST /retrieve causal", () => {
  const rest = async (body: Record<string, unknown>) => {
    const resp = await fetch(`http://127.0.0.1:${restServer!.port}/retrieve`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await resp.json() as any;
  };

  it("classifier parity: 'why were' routes causal over REST now", async () => {
    const out = await rest({ query: "why were the pipeline deploy failures after the cache migration", mode: "auto" });
    expect(out.mode).toBe("causal");
  });

  it("still surfaces internal docs (allowAll posture preserved) and gains the one-hop", async () => {
    const out = await rest({ query: WHY_QUERY, mode: "causal", limit: 25, compact: true });
    const paths: string[] = (out.results ?? []).map((r: any) => r.path ?? r.file ?? r.displayPath ?? "");
    expect(paths.some(p => p.includes("_clawmem/"))).toBe(true);
    expect(paths.some(p => p.includes("observations/2026-08-01-aaaa-decision-c1.md"))).toBe(true);
  });

  it("contains no entity-expansion results (stage off for REST)", async () => {
    const out = await rest({ query: "pipeline deploy incident record", mode: "causal", limit: 30 });
    const paths: string[] = (out.results ?? []).map((r: any) => r.path ?? r.file ?? r.displayPath ?? "");
    expect(paths.some(p => p.includes("entity-only.md"))).toBe(false);
  });
});

// =============================================================================
// kg_query provenance surfacing (D-C)
// =============================================================================

describe("kg_query evidence", () => {
  it("surfaces evidenceCount + bounded sources in structuredContent and text, unattributed rendered", async () => {
    const res = await call("kg_query", { entity: "default:concept:brontal" });
    const fact = (res.structuredContent as any)?.facts?.[0];
    expect(fact?.evidenceCount).toBe(3);
    expect(fact?.sources?.length).toBe(3);
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain("evidence ×3");
    expect(text).toContain("unattributed");
    expect(text).toContain("user/deploy-note.md");
  });
});

// =============================================================================
// Store-level provenance (D-C): dedup, ordering, migration, atomicity
// =============================================================================

describe("entity_triple_provenance store contract", () => {
  function freshStore(): Store {
    const store = createStore(":memory:");
    store.db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, created_at) VALUES (?, 'concept', 'x', ?)`).run("default:concept:x", new Date().toISOString());
    return store;
  }

  it("accumulates unique evidence; identical re-sightings and null-evidence dupes collapse (F8/T2-F6)", () => {
    const store = freshStore();
    const doc = seedDoc(store, "user", "s1.md", "source one");
    const docId = idOf(store, doc);
    const t1 = store.addTriple("default:concept:x", "governs", null, "y", { sourceDocId: docId, sourceFact: "f1" });
    const t2 = store.addTriple("default:concept:x", "governs", null, "y", { sourceDocId: docId, sourceFact: "f1" }); // exact dup
    const t3 = store.addTriple("default:concept:x", "governs", null, "y", { sourceFact: "orphan fact" });
    const t4 = store.addTriple("default:concept:x", "governs", null, "y", { sourceFact: "orphan fact" }); // null-doc dup
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
    expect(t3).toBe(t4);
    const rows = store.db.prepare(`SELECT COUNT(*) AS n FROM entity_triple_provenance WHERE triple_id = ?`).get(t1) as { n: number };
    expect(rows.n).toBe(2);
    const [fact] = store.queryEntityTriples("default:concept:x", { includeProvenance: true });
    expect(fact?.evidenceCount).toBe(2);
    expect(fact?.sources?.some(s => s.docId === null && s.fact === "orphan fact")).toBe(true);
    store.close();
  });

  it("bounds sources at provenanceLimit with deterministic recency ordering (T1-F8 index)", () => {
    const store = freshStore();
    const doc = seedDoc(store, "user", "s1.md", "source one");
    const docId = idOf(store, doc);
    let tripleId = 0;
    for (let i = 0; i < 7; i++) {
      tripleId = store.addTriple("default:concept:x", "governs", null, "y", { sourceDocId: docId, sourceFact: `fact-${i}` });
    }
    const [fact] = store.queryEntityTriples("default:concept:x", { includeProvenance: true, provenanceLimit: 5 });
    expect(fact?.evidenceCount).toBe(7);
    expect(fact?.sources?.length).toBe(5);
    // Same-timestamp ties break by id DESC — the LAST inserted evidence leads.
    expect(fact?.sources?.[0]?.fact).toBe("fact-6");
    expect(tripleId).toBeGreaterThan(0);
    store.close();
  });

  it("backfills legacy inline evidence across reopen, idempotently (migration)", () => {
    const file = "/tmp/clawmem-causal-migration-test.sqlite";
    try { unlinkSync(file); } catch { /* absent */ }
    let store = createStore(file);
    store.db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, created_at) VALUES (?, 'concept', 'x', ?)`).run("default:concept:x", new Date().toISOString());
    // Legacy row shape: inline evidence only, no provenance row (pre-v0.32.0).
    store.db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_literal, confidence, source_doc_id, source_fact, created_at) VALUES (?, 'governs', 'y', 1.0, NULL, 'legacy fact', ?)`).run("default:concept:x", new Date().toISOString());
    store.db.exec(`DELETE FROM entity_triple_provenance`);
    store.close();

    store = createStore(file);
    const afterFirst = (store.db.prepare(`SELECT COUNT(*) AS n FROM entity_triple_provenance`).get() as { n: number }).n;
    expect(afterFirst).toBe(1);
    store.close();

    store = createStore(file);
    const afterSecond = (store.db.prepare(`SELECT COUNT(*) AS n FROM entity_triple_provenance`).get() as { n: number }).n;
    expect(afterSecond).toBe(1);
    store.close();
    try { unlinkSync(file); } catch { /* gone */ }
  });

  it("gives an entirely-unattributed sighting ONE null-normalized evidence row (T6-F8)", () => {
    const store = freshStore();
    const t1 = store.addTriple("default:concept:x", "governs", null, "y");
    const t2 = store.addTriple("default:concept:x", "governs", null, "y"); // repeat — collapses
    expect(t1).toBe(t2);
    const rows = store.db.prepare(`SELECT COUNT(*) AS n FROM entity_triple_provenance WHERE triple_id = ?`).get(t1) as { n: number };
    expect(rows.n).toBe(1);
    const [fact] = store.queryEntityTriples("default:concept:x", { includeProvenance: true });
    expect(fact?.evidenceCount).toBe(1);
    expect(fact?.sources?.[0]?.docId).toBeNull();
    expect(fact?.sources?.[0]?.fact).toBeNull();
    store.close();
  });

  it("backfills an entirely-null legacy triple with one unattributed row across reopen (T6-F8)", () => {
    const file = "/tmp/clawmem-causal-nullmigration-test.sqlite";
    try { unlinkSync(file); } catch { /* absent */ }
    let store = createStore(file);
    store.db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, created_at) VALUES (?, 'concept', 'x', ?)`).run("default:concept:x", new Date().toISOString());
    store.db.prepare(`INSERT INTO entity_triples (subject_entity_id, predicate, object_literal, confidence, source_doc_id, source_fact, created_at) VALUES (?, 'governs', 'y', 1.0, NULL, NULL, ?)`).run("default:concept:x", new Date().toISOString());
    store.db.exec(`DELETE FROM entity_triple_provenance`);
    store.close();

    store = createStore(file);
    const after = (store.db.prepare(`SELECT COUNT(*) AS n FROM entity_triple_provenance`).get() as { n: number }).n;
    expect(after).toBe(1);
    const row = store.db.prepare(`SELECT source_doc_id, source_fact FROM entity_triple_provenance`).get() as { source_doc_id: number | null; source_fact: string | null };
    expect(row.source_doc_id).toBeNull();
    expect(row.source_fact).toBeNull();
    store.close();

    store = createStore(file);
    const again = (store.db.prepare(`SELECT COUNT(*) AS n FROM entity_triple_provenance`).get() as { n: number }).n;
    expect(again).toBe(1);
    store.close();
    try { unlinkSync(file); } catch { /* gone */ }
  });

  it("rolls the base insert back when the evidence write fails (F8 atomicity)", () => {
    const store = freshStore();
    const doc = seedDoc(store, "user", "s1.md", "source one");
    const docId = idOf(store, doc);
    store.db.exec(`DROP TABLE entity_triple_provenance`);
    expect(() => store.addTriple("default:concept:x", "governs", null, "y", { sourceDocId: docId, sourceFact: "f1" })).toThrow();
    const rows = store.db.prepare(`SELECT COUNT(*) AS n FROM entity_triples`).get() as { n: number };
    expect(rows.n).toBe(0);
    store.close();
  });
});
