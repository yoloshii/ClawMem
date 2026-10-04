/**
 * s342 causal reader — directed edge records with witness evidence, per the
 * rev-7 design's verification plan (§3): eligibility on anchor AND every
 * expansion, invariant edge identity with separate traversal provenance, the
 * combined 50-edge budget with a truthful overflow probe, 3-witness projection
 * with strongestAt ≠ lastSeenAt, lazy legacy read-through, and the combined
 * serialized wire ceiling applied symmetrically to MCP (text + structured) and
 * the REST body.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { startServer } from "../../src/server.ts";

// The REST server needs a token on every request and a JSON Content-Type on every POST (BACKLOG 62.4).
const REST_TOKEN = "rest-test-token-62-4-0000000000000000000000";
const AUTH = { Authorization: `Bearer ${REST_TOKEN}` };
import { createStore, findCausalLinks, CAUSAL_READER_MAX_EDGES, type Store } from "../../src/store.ts";
import { capCausalWire, CAUSAL_READER_MAX_BYTES } from "../../src/causal-reader.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { createHash, randomUUID } from "node:crypto";

let store: Store;
let dir: string;
let client: Client;
let closeAllStores: (() => void) | undefined;
let restServer: ReturnType<typeof startServer> | null = null;
let restPort = 0;

/** Docids resolve by hash prefix (findDocumentByDocid); mkDoc derives the hash
 *  deterministically from the path so tests can address docs via hashOf(). */
function hashOf(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function mkDoc(path: string, opts?: { active?: boolean; invalidated?: boolean }): number {
  const hash = hashOf(path);
  const ts = "2026-08-01T00:00:00.000Z";
  (store as any).insertContent(hash, `body of ${path}`, ts);
  (store as any).insertDocument("_clawmem", path, path, hash, ts, ts);
  const id = ((store.db.prepare(`SELECT id FROM documents WHERE collection = '_clawmem' AND path = ?`).get(path)) as { id: number }).id;
  if (opts?.active === false) store.db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(id);
  if (opts?.invalidated) store.db.prepare(`UPDATE documents SET invalidated_at = '2026-08-02T00:00:00.000Z' WHERE id = ?`).run(id);
  return id;
}

function edge(s: number, t: number, opts?: { weight?: number; metadata?: string | null }): void {
  store.db.prepare(
    `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
     VALUES (?, ?, 'causal', ?, ?, '2026-07-15T00:00:00.000Z')`,
  ).run(s, t, opts?.weight ?? 0.8, opts?.metadata ?? null);
}

function sighting(s: number, t: number, opts: {
  so: number; to: number; conf: number; createdAt: string; reasoning?: string; runKey?: string;
}): void {
  store.db.prepare(
    `INSERT INTO causal_witness_sightings (source_id, target_id, source_fact_ordinal, target_fact_ordinal,
       source_fact, target_fact, reasoning, confidence, model_identity, prompt_version, run_key, legacy, created_at)
     VALUES (?, ?, ?, ?, 'src fact', 'tgt fact', ?, ?, 'model-x', 'v1', ?, 0, ?)`,
  ).run(s, t, opts.so, opts.to, opts.reasoning ?? `r-${opts.so}-${opts.to}`, opts.conf, opts.runKey ?? randomUUID(), opts.createdAt);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "clawmem-causal-reader-"));
  const dbPath = join(dir, "vault.sqlite");
  Bun.env.INDEX_PATH = dbPath;
  setDefaultLlamaCpp({
    embed: async () => { throw new Error("no embedder"); },
    rerank: async () => ({ results: [] }),
    generate: async () => null,
  } as any);
  store = createStore(dbPath);

  const built = buildMcpServer();
  closeAllStores = (built as any).closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "causal-reader-test", version: "0.0.0" });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);

  restServer = startServer(store, 0, "127.0.0.1", { token: REST_TOKEN });
  restPort = (restServer as any).port;
});

afterAll(async () => {
  try { await client?.close(); } catch { /* best-effort */ }
  try { (restServer as any)?.stop?.(true); } catch { /* best-effort */ }
  try { closeAllStores?.(); } catch { /* best-effort */ }
  try { (store as any).close?.(); } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
});

// ─── Traversal semantics (store layer) ───────────────────────────────────────

describe("findCausalLinks traversal", () => {
  test("eligibility gates TRAVERSAL, not just output: A → invalidated B → C stops at B", () => {
    const a = mkDoc("observations/elig-a.md");
    const b = mkDoc("observations/elig-b.md", { invalidated: true });
    const c = mkDoc("observations/elig-c.md");
    edge(a, b);
    edge(b, c);

    const { edges } = findCausalLinks(store.db, a, "causes", 5);
    expect(edges).toHaveLength(0);   // B is ineligible → the A→B edge is not returned and C is unreachable THROUGH it
  });

  test("an invalidated anchor yields nothing", () => {
    const a = mkDoc("observations/anchor-inv.md", { invalidated: true });
    const b = mkDoc("observations/anchor-tgt.md");
    edge(a, b);
    expect(findCausalLinks(store.db, a, "causes", 5).edges).toHaveLength(0);
  });

  test("edge records carry invariant sourceDocId/targetDocId with SEPARATE traversal provenance", () => {
    const a = mkDoc("observations/dir-a.md");
    const b = mkDoc("observations/dir-b.md");
    edge(a, b, { weight: 0.9 });

    const outbound = findCausalLinks(store.db, a, "causes", 5).edges;
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      sourceDocId: a, targetDocId: b, docId: b, predecessorDocId: a, depth: 1, direction: "causes",
    });

    const inbound = findCausalLinks(store.db, b, "caused_by", 5).edges;
    expect(inbound).toHaveLength(1);
    // The PHYSICAL edge identity is identical from either side — no field inversion.
    expect(inbound[0]).toMatchObject({
      sourceDocId: a, targetDocId: b, docId: a, predecessorDocId: b, depth: 1, direction: "caused_by",
    });
  });

  test("'both' keeps distinct inbound and outbound edges to the same document (the old docId-dedup discard is dead)", () => {
    const a = mkDoc("observations/cycle-a.md");
    const b = mkDoc("observations/cycle-b.md");
    edge(a, b, { weight: 0.8 });
    edge(b, a, { weight: 0.7 });

    const { edges } = findCausalLinks(store.db, a, "both", 5);
    // Two distinct physical edges, one per direction — both preserved with their evidence.
    const keys = edges.map(e => `${e.sourceDocId}:${e.targetDocId}:${e.direction}`).sort();
    expect(keys).toContain(`${a}:${b}:causes`);
    expect(keys).toContain(`${b}:${a}:caused_by`);
  });

  test("diamond paths surface every real edge (per-edge evidence, not one path)", () => {
    const a = mkDoc("observations/dia-a.md");
    const b = mkDoc("observations/dia-b.md");
    const c = mkDoc("observations/dia-c.md");
    const d = mkDoc("observations/dia-d.md");
    edge(a, b); edge(a, c); edge(b, d); edge(c, d);

    const { edges } = findCausalLinks(store.db, a, "causes", 5);
    expect(edges).toHaveLength(4);   // B→D and C→D are DISTINCT edges, both returned
  });

  test("combined 50-edge budget across both directions with a truthful overflow probe", () => {
    const anchor = mkDoc("observations/budget-anchor.md");
    for (let i = 0; i < 40; i++) {
      const t = mkDoc(`observations/budget-out-${i}.md`);
      edge(anchor, t, { weight: 0.5 + (i % 40) / 100 });
    }
    for (let i = 0; i < 20; i++) {
      const s = mkDoc(`observations/budget-in-${i}.md`);
      edge(s, anchor, { weight: 0.5 + (i % 40) / 100 });
    }

    const result = findCausalLinks(store.db, anchor, "both", 1);
    expect(result.edges).toHaveLength(CAUSAL_READER_MAX_EDGES);
    expect(result.truncated).toBe(true);

    // Deterministic total order: (depth, weight DESC, sourceDocId, targetDocId, direction).
    const sorted = [...result.edges].sort((x, y) =>
      x.depth - y.depth || y.weight - x.weight || x.sourceDocId - y.sourceDocId ||
      x.targetDocId - y.targetDocId || x.direction.localeCompare(y.direction));
    expect(result.edges).toEqual(sorted);
  });

  test("with MORE than 51 edges in one direction, the retained 50 are the GLOBAL top by weight — never an ID-order sample", () => {
    const anchor = mkDoc("observations/global-anchor.md");
    // 60 outbound edges; the HIGHEST weights are assigned to the LAST-created
    // (highest-ID) targets, so an arrival-order truncation would drop exactly
    // the edges the total order requires.
    const weights: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = mkDoc(`observations/global-t${i}.md`);
      const w = 0.30 + i * 0.01;   // strictly increasing with i (and with target id)
      weights.push(w);
      edge(anchor, t, { weight: w });
    }
    const result = findCausalLinks(store.db, anchor, "causes", 1);
    expect(result.edges).toHaveLength(CAUSAL_READER_MAX_EDGES);
    expect(result.truncated).toBe(true);
    const keptWeights = result.edges.map(e => e.weight);
    const expectedTop = [...weights].sort((a, b) => b - a).slice(0, CAUSAL_READER_MAX_EDGES);
    expect(keptWeights.map(w => w.toFixed(2))).toEqual(expectedTop.map(w => w.toFixed(2)));
  });

  test("below the budget, truncated is false", () => {
    const a = mkDoc("observations/small-a.md");
    const b = mkDoc("observations/small-b.md");
    edge(a, b);
    const result = findCausalLinks(store.db, a, "both", 5);
    expect(result.truncated).toBe(false);
  });
});

// ─── Witness projection ──────────────────────────────────────────────────────

describe("witness projection", () => {
  test("per ordinal pair: max confidence wins, tie → latest; strongestAt ≠ lastSeenAt; top-3 cap with honest evidenceCount", () => {
    const a = mkDoc("observations/wit-a.md");
    const b = mkDoc("observations/wit-b.md");
    edge(a, b, { weight: 0.9 });
    // Pair (0,1): 0.6 early, then 0.9, then a LATER weaker 0.7 — projection shows
    // 0.9 (strongestAt = its own created_at) while lastSeenAt is the latest sighting.
    sighting(a, b, { so: 0, to: 1, conf: 0.6, createdAt: "2026-08-01T00:00:00.000Z" });
    sighting(a, b, { so: 0, to: 1, conf: 0.9, createdAt: "2026-08-02T00:00:00.000Z", reasoning: "the strongest" });
    sighting(a, b, { so: 0, to: 1, conf: 0.7, createdAt: "2026-08-03T00:00:00.000Z" });
    // Three more distinct pairs — 4 total, only 3 surface.
    sighting(a, b, { so: 2, to: 3, conf: 0.7, createdAt: "2026-08-01T00:00:00.000Z" });
    sighting(a, b, { so: 4, to: 5, conf: 0.65, createdAt: "2026-08-01T00:00:00.000Z" });
    sighting(a, b, { so: 6, to: 7, conf: 0.61, createdAt: "2026-08-01T00:00:00.000Z" });

    const { edges } = findCausalLinks(store.db, a, "causes", 5);
    expect(edges).toHaveLength(1);
    const rec = edges[0]!;
    expect(rec.evidenceCount).toBe(4);
    expect(rec.witnesses).toHaveLength(3);
    expect(rec.witnesses.map(w => w.confidence)).toEqual([0.9, 0.7, 0.65]);
    const top = rec.witnesses[0]!;
    expect(top.reasoning).toBe("the strongest");
    expect(top.strongestAt).toBe("2026-08-02T00:00:00.000Z");
    expect(top.lastSeenAt).toBe("2026-08-03T00:00:00.000Z");
    expect(rec.legacy).toBe(false);
  });

  test("zero sightings + valid old-writer metadata → ONE synthesized legacy display witness, never written", () => {
    const a = mkDoc("observations/leg-a.md");
    const b = mkDoc("observations/leg-b.md");
    edge(a, b, {
      weight: 0.85,
      metadata: JSON.stringify({ reasoning: "old writer said so", source_fact: "old sf", target_fact: "old tf" }),
    });

    const { edges } = findCausalLinks(store.db, a, "causes", 5);
    const rec = edges[0]!;
    expect(rec.legacy).toBe(true);
    expect(rec.evidenceCount).toBe(1);
    expect(rec.witnesses[0]).toMatchObject({
      sourceFactOrdinal: -1, targetFactOrdinal: -1, legacy: true,
      reasoning: "old writer said so", confidence: 0.85,
    });
    // Read-through synthesizes in memory only.
    expect(store.db.prepare(`SELECT COUNT(*) n FROM causal_witness_sightings`).get()).toMatchObject({ n: expect.any(Number) });
    expect((store.db.prepare(`SELECT COUNT(*) n FROM causal_witness_sightings WHERE source_id = ? AND target_id = ?`).get(a, b) as { n: number }).n).toBe(0);
  });

  test("zero sightings + unprovable metadata (Beads / null) → NO witness, evidenceCount 0", () => {
    const a = mkDoc("observations/nb-a.md");
    const b = mkDoc("observations/nb-b.md");
    edge(a, b, { weight: 1.0, metadata: JSON.stringify({ origin: "beads", dep_type: "blocks" }) });

    const { edges } = findCausalLinks(store.db, a, "causes", 5);
    const rec = edges[0]!;
    expect(rec.legacy).toBe(true);
    expect(rec.evidenceCount).toBe(0);
    expect(rec.witnesses).toHaveLength(0);
  });

  test("legacy validity is THE shared rule: an out-of-range weight yields NO synthesized witness (exactly as the writer/census refuse it)", () => {
    const a = mkDoc("observations/oow-a.md");
    const b = mkDoc("observations/oow-b.md");
    // Metadata fields are valid old-writer shape, but the weight is not a
    // confidence — the reader must not display 3.5 while the census calls the
    // same edge unresolved.
    edge(a, b, {
      weight: 3.5,
      metadata: JSON.stringify({ reasoning: "valid-looking", source_fact: "sf", target_fact: "tf" }),
    });
    const { edges } = findCausalLinks(store.db, a, "causes", 5);
    const rec = edges[0]!;
    expect(rec.legacy).toBe(true);
    expect(rec.evidenceCount).toBe(0);
    expect(rec.witnesses).toHaveLength(0);
  });
});

// ─── Wire ceiling (unit) ─────────────────────────────────────────────────────

describe("capCausalWire", () => {
  test("drops whole edges from the tail until the COMPLETE serialized value fits", () => {
    const bigEdges = Array.from({ length: 10 }, (_, i) => ({
      sourceDocId: i, targetDocId: i + 1, docId: i + 1, title: `t${i}`, filepath: `f${i}`,
      predecessorDocId: i, depth: 1, direction: "causes" as const, weight: 0.9,
      evidenceCount: 1, legacy: false,
      witnesses: [{
        sourceFactOrdinal: 0, targetFactOrdinal: 0, sourceFact: "s", targetFact: "t",
        reasoning: "x".repeat(20_000), confidence: 0.9,
        strongestAt: "2026-08-01", lastSeenAt: "2026-08-01", legacy: false,
      }],
    }));
    const result = capCausalWire(bigEdges, false, (kept, truncated) => ({ kept, truncated }),
      () => ({ kept: [] as typeof bigEdges, truncated: true }));
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(CAUSAL_READER_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.kept.length).toBeLessThan(10);
    expect(result.kept.length).toBeGreaterThan(0);
  });

  test("the ceiling is unconditional: an oversized BASE envelope is replaced by the overflow value", () => {
    // No edges to drop — the builder's base alone exceeds the cap (an unbounded
    // base field slipping past the callers' display bounds must not ship).
    const result = capCausalWire(
      [],
      false,
      (kept, truncated) => ({ kept, truncated, base: "b".repeat(200_000) }),
      () => ({ kept: [], truncated: true, base: "overflow" }),
    );
    expect(result.base).toBe("overflow");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(CAUSAL_READER_MAX_BYTES);
  });

  test("the ceiling is HARD: when no edge fits, the result keeps zero edges and still fits", () => {
    const oversized = [{
      sourceDocId: 1, targetDocId: 2, docId: 2, title: "t", filepath: "f",
      predecessorDocId: 1, depth: 1, direction: "causes" as const, weight: 0.9,
      evidenceCount: 1, legacy: false,
      witnesses: [{
        sourceFactOrdinal: 0, targetFactOrdinal: 0, sourceFact: "s", targetFact: "t",
        reasoning: "z".repeat(100_000), confidence: 0.9,
        strongestAt: "2026-08-01", lastSeenAt: "2026-08-01", legacy: false,
      }],
    }];
    const result = capCausalWire(oversized, false, (kept, truncated) => ({ kept, truncated }),
      () => ({ kept: [] as typeof oversized, truncated: true }));
    expect(result.kept).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(CAUSAL_READER_MAX_BYTES);
  });

  test("an OVERSIZED overflow fallback is a caller bug and throws loudly", () => {
    expect(() => capCausalWire(
      [],
      false,
      (kept, truncated) => ({ kept, truncated, base: "b".repeat(200_000) }),
      () => ({ kept: [], truncated: true, base: "c".repeat(200_000) }),
    )).toThrow(/overflowBuild/);
  });

  test("under the ceiling, nothing is dropped and the budget flag passes through", () => {
    const small = [{
      sourceDocId: 1, targetDocId: 2, docId: 2, title: "t", filepath: "f",
      predecessorDocId: 1, depth: 1, direction: "causes" as const, weight: 0.9,
      evidenceCount: 0, legacy: false, witnesses: [],
    }];
    const overflow = () => ({ kept: [] as typeof small, truncated: true });
    expect(capCausalWire(small, false, (kept, truncated) => ({ kept, truncated }), overflow))
      .toEqual({ kept: small, truncated: false });
    expect(capCausalWire(small, true, (kept, truncated) => ({ kept, truncated }), overflow).truncated).toBe(true);
  });
});

// ─── Production boundaries: MCP tool + REST route ────────────────────────────

describe("MCP + REST boundaries", () => {
  test("find_causal_links returns edge records with witnesses; text and structured share ONE retained set under the byte cap", async () => {
    const a = mkDoc("observations/mcp-a.md");
    // Enough heavy edges to force wire truncation: 8 edges × ~20KB reasoning.
    for (let i = 0; i < 8; i++) {
      const t = mkDoc(`observations/mcp-t${i}.md`);
      edge(a, t, { weight: 0.9 - i / 100 });
      sighting(a, t, {
        so: 0, to: 0, conf: 0.9 - i / 100, createdAt: "2026-08-01T00:00:00.000Z",
        reasoning: `edge-${i} ` + "y".repeat(20_000),
      });
    }

    const result = await client.callTool({
      name: "find_causal_links",
      arguments: { docid: `#${hashOf("observations/mcp-a.md")}`, direction: "causes" },
    }) as { content: Array<{ type: string; text?: string }>; structuredContent?: any };

    const total = Buffer.byteLength(JSON.stringify({
      content: result.content, structuredContent: result.structuredContent,
    }), "utf8");
    expect(total).toBeLessThanOrEqual(CAUSAL_READER_MAX_BYTES);
    expect(result.structuredContent.truncated).toBe(true);

    const links = result.structuredContent.links as any[];
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThan(8);
    expect(links[0]).toHaveProperty("sourceDocId");
    expect(links[0]).toHaveProperty("targetDocId");
    expect(links[0]).toHaveProperty("direction");
    expect(links[0].witnesses.length).toBeGreaterThan(0);

    // Same retained edge set in both representations: every structured edge is
    // named in the text, and the text names no edge beyond them.
    const text = result.content[0]!.text!;
    for (const link of links) {
      expect(text).toContain(`edge ${link.sourceDocId}→${link.targetDocId}`);
    }
    expect((text.match(/\[depth /g) ?? []).length).toBe(links.length);
  });

  test("MCP hard ceiling with zero edges fitting: the capped path reports truncated with an empty link set", async () => {
    const a = mkDoc("observations/mcp-huge.md");
    const t = mkDoc("observations/mcp-huge-t.md");
    edge(a, t, { weight: 0.9 });
    sighting(a, t, {
      so: 0, to: 0, conf: 0.9, createdAt: "2026-08-01T00:00:00.000Z",
      reasoning: "w".repeat(120_000),   // a single edge no response can carry
    });

    const result = await client.callTool({
      name: "find_causal_links",
      arguments: { docid: `#${hashOf("observations/mcp-huge.md")}`, direction: "causes" },
    }) as { content: Array<{ type: string; text?: string }>; structuredContent?: any };

    const total = Buffer.byteLength(JSON.stringify({
      content: result.content, structuredContent: result.structuredContent,
    }), "utf8");
    expect(total).toBeLessThanOrEqual(CAUSAL_READER_MAX_BYTES);
    expect(result.structuredContent.links).toHaveLength(0);
    expect(result.structuredContent.truncated).toBe(true);
    expect(result.content[0]!.text).toContain("none fit the response ceiling");
  });

  test("MCP not-found path is byte-bounded: an oversized docid comes back sliced, response under the ceiling", async () => {
    const hugeDocid = "z".repeat(200_000);
    const result = await client.callTool({
      name: "find_causal_links",
      arguments: { docid: hugeDocid, direction: "causes" },
    }) as { content: Array<{ type: string; text?: string }> };
    const text = result.content[0]!.text!;
    expect(text).toContain("Document not found");
    expect(text.length).toBeLessThan(400);   // 256-char echo + message prefix
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(CAUSAL_READER_MAX_BYTES);
  });

  test("REST not-found path is byte-bounded: an oversized docid comes back sliced", async () => {
    const hugeDocid = "y".repeat(8_000);
    const res = await fetch(`http://127.0.0.1:${restPort}/graph/causal/${hugeDocid}?direction=causes`, { headers: AUTH });
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(1_000);
    expect(raw).toContain("Document not found");
  });

  test("docid structural validation: LIKE wildcards, non-hex, and undersized prefixes never resolve", async () => {
    const a = mkDoc("observations/valid-anchor.md");
    const b = mkDoc("observations/valid-target.md");
    edge(a, b);

    // `_`/`%` are SQL LIKE wildcards that used to match ARBITRARY documents;
    // short and non-hex prefixes are ambiguity/injection surface. All must be
    // not-found on every docid tool.
    for (const bad of ["_", "%", "ab", "abc12", "not-hex-zzzzzz", "#_"]) {
      const result = await client.callTool({
        name: "find_causal_links",
        arguments: { docid: bad, direction: "causes" },
      }) as { content: Array<{ type: string; text?: string }> };
      expect(result.content[0]!.text).toContain("Document not found");
    }

    // A well-formed 6+ hex prefix still resolves.
    const good = await client.callTool({
      name: "find_causal_links",
      arguments: { docid: `#${hashOf("observations/valid-anchor.md").slice(0, 8)}`, direction: "causes" },
    }) as { structuredContent?: any };
    expect(good.structuredContent.links).toHaveLength(1);
  });

  test("destructive REST boundary: /documents/_/forget deactivates NOTHING", async () => {
    const path = "observations/forget-victim.md";
    mkDoc(path);
    const res = await fetch(`http://127.0.0.1:${restPort}/documents/_/forget`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" } });
    expect(res.status).toBe(404);
    const active = store.db.prepare(
      `SELECT active FROM documents WHERE collection = '_clawmem' AND path = ?`,
    ).get(path) as { active: number };
    expect(active.active).toBe(1);
  });

  test("MCP anchor eligibility: an invalidated anchor is not found", async () => {
    const inv = mkDoc("observations/mcp-inv.md", { invalidated: true });
    const t = mkDoc("observations/mcp-inv-t.md");
    edge(inv, t);
    const result = await client.callTool({
      name: "find_causal_links",
      arguments: { docid: `#${hashOf("observations/mcp-inv.md")}`, direction: "causes" },
    }) as { content: Array<{ type: string; text?: string }> };
    expect(result.content[0]!.text).toContain("Document not found");
  });

  test("REST /graph/causal returns the same capped edge-record body", async () => {
    const a = mkDoc("observations/rest-a.md");
    const b = mkDoc("observations/rest-b.md");
    edge(a, b, { weight: 0.77 });
    sighting(a, b, { so: 1, to: 2, conf: 0.77, createdAt: "2026-08-01T00:00:00.000Z", reasoning: "rest evidence" });

    const res = await fetch(`http://127.0.0.1:${restPort}/graph/causal/${hashOf("observations/rest-a.md")}?direction=causes`, { headers: AUTH });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(CAUSAL_READER_MAX_BYTES);
    const body = JSON.parse(raw);
    expect(body.truncated).toBe(false);
    expect(body.count).toBe(1);
    expect(body.links[0]).toMatchObject({
      sourceDocId: a, targetDocId: b, direction: "causes", weight: 0.77,
    });
    expect(body.links[0].witnesses[0].reasoning).toBe("rest evidence");
  });
});
