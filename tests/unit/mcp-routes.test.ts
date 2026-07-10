import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * Route-level MCP regressions (T8-M7 / design (b) route contracts + the incident rows):
 * the REAL tool handlers driven over an in-memory transport against a seeded vault that
 * reproduces the 2026-07-10 incident shape — a recent, decay-exempt `_clawmem` deduction
 * that composite-outranks an older true match unless excluded.
 *
 * Covers: includeInternal on/off for all six retrieval routes; the explicit-collection
 * override; flat vs multi-leg degraded schemas absent on healthy paths; causal-mode graph
 * hydration + traversal guard; find_similar's internal-reference auto-exception; the
 * incident composite-ranking fixture (exclusion restores true-match ordering).
 */

import { unlinkSync } from "fs";
import { createHash } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";

const TEST_DB = "/tmp/clawmem-mcp-routes-test.sqlite";
const MODEL = "route-fake";

// Keyword-steered fake embedder: queries/docs about "sealed acceptance" cluster together;
// the junk deduction sits at mid similarity; unrelated content is orthogonal.
function fakeVec(text: string): Float32Array {
  const t = text.toLowerCase();
  if (t.includes("captest")) return new Float32Array([0, 0, 0, 1]);
  if (t.includes("sealed") || t.includes("acceptance")) return new Float32Array([1, 0.05, 0, 0]);
  if (t.includes("deduction junk")) return new Float32Array([0.8, 0.6, 0, 0]);
  const j = (createHash("sha256").update(text).digest()[0]! / 255) * 0.2;
  return new Float32Array([j, 0.1, 1, 0]);
}
const fakeLlm = {
  embed: async (text: string) => {
    // "fallbackprobe" simulates an unavailable embed endpoint (non-fatal error class) —
    // exercises memory_retrieve semantic's FTS fallback, which must stay composite.
    if (text.includes("fallbackprobe")) throw new Error("embed endpoint down (fallback probe)");
    return { embedding: fakeVec(text), model: MODEL };
  },
  // Production LlamaCpp degrades gracefully on endpoint failure (null / typed fallbacks,
  // never throws to callers) — the fake mirrors that so expansion/intent behave as live.
  query: async () => null,
  expandQuery: async () => [],
} as any;

let client: Client;
let closeAllStores: () => void;
let seedStore: Store;

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

function seedVector(store: Store, hash: string, col: string, path: string, text: string) {
  store.ensureVecTable(4);
  store.insertEmbedding(hash, 0, 0, fakeVec(text), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId(col, path));
}

beforeAll(async () => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  Bun.env.INDEX_PATH = TEST_DB;
  setDefaultLlamaCpp(fakeLlm);

  // Seed BEFORE building the server (same DB file; the server opens its own handle).
  seedStore = createStore(TEST_DB);
  const old = new Date(Date.now() - 90 * 86400_000).toISOString();
  // True match: older user doc about the sealed acceptance script.
  const trueHash = seedDoc(seedStore, "user", "r8-note.md", "the sealed acceptance script cannot live under the git directory because the sandbox denies reads", { modifiedAt: old });
  seedVector(seedStore, trueHash, "user", "r8-note.md", "sealed acceptance sandbox");
  // Junk: RECENT _clawmem deduction (deductive → ∞ half-life + decay-exempt confidence).
  const junkHash = seedDoc(seedStore, "_clawmem", "deductions/junk.md", "deduction junk moved successfully to another folder", { contentType: "deductive" });
  seedVector(seedStore, junkHash, "_clawmem", "deductions/junk.md", "deduction junk");
  // A second internal doc NEAR the first — find_similar's auto-exception must return it.
  const junk2Hash = seedDoc(seedStore, "_clawmem", "deductions/junk2.md", "deduction junk twin note in the same folder", { contentType: "deductive" });
  seedVector(seedStore, junk2Hash, "_clawmem", "deductions/junk2.md", "deduction junk");
  // A second user doc for list-shape assertions.
  const otherHash = seedDoc(seedStore, "user", "other.md", "unrelated cooking notes about bread", { modifiedAt: old });
  seedVector(seedStore, otherHash, "user", "other.md", "unrelated cooking bread");
  // Engineered low-composite doc for the recency-floor contract: very old, zero quality,
  // long body — its recency composite lands far below the 0.3 floor while its vector
  // similarity keeps it inside the candidate pool.
  const veryOld = new Date(Date.now() - 600 * 86400_000).toISOString();
  const staleHash = seedDoc(seedStore, "user", "stale-low.md", "filler ".repeat(600), { modifiedAt: veryOld });
  seedStore.db.prepare(`UPDATE documents SET quality_score = 0.0 WHERE hash = ?`).run(staleHash);
  seedVector(seedStore, staleHash, "user", "stale-low.md", "deduction junk");
  // FTS-only doc (no vector) for the semantic FTS-fallback carve-out.
  seedDoc(seedStore, "user", "fallback-doc.md", "fallbackprobe cooking guide for bread ovens");
  // Causal-mode graph edge: user doc → internal deduction (traversal + hydration guard).
  seedStore.db.exec(`CREATE TABLE IF NOT EXISTS memory_relations (source_id INTEGER, target_id INTEGER, relation_type TEXT, weight REAL)`);
  const idOf = (h: string) => (seedStore.db.prepare(`SELECT id FROM documents WHERE hash = ? AND active = 1`).get(h) as { id: number }).id;
  seedStore.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight) VALUES (?, ?, 'semantic', 1.0)`).run(idOf(trueHash), idOf(junkHash));

  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "route-tests", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => {
  try { closeAllStores(); } catch { /* already closed */ }
  try { seedStore.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  try { unlinkSync(TEST_DB); } catch { /* gone */ }
});

type ToolResult = { structuredContent?: any; content?: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  await client.callTool({ name, arguments: args }) as ToolResult;

const paths = (r: ToolResult): string[] =>
  (r.structuredContent?.results ?? []).map((x: any) => x.path ?? x.file ?? x.displayPath ?? "");

describe("visibility exclusion — all six retrieval routes", () => {
  it("search excludes _clawmem by default, includes on includeInternal, and on explicit collection", async () => {
    const def = await call("search", { query: "deduction junk", compact: true });
    expect(paths(def).some(p => p.startsWith("_clawmem/"))).toBe(false);
    const inc = await call("search", { query: "deduction junk", compact: true, includeInternal: true });
    expect(paths(inc).some(p => p.startsWith("_clawmem/"))).toBe(true);
    const explicit = await call("search", { query: "deduction junk", compact: true, collection: "_clawmem" });
    expect(paths(explicit).some(p => p.startsWith("_clawmem/"))).toBe(true);
  });

  it("vsearch excludes _clawmem by default and restores the true match on top (incident rows)", async () => {
    const def = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0 });
    const ps = paths(def);
    expect(ps.some(p => p.startsWith("_clawmem/"))).toBe(false);
    expect(ps[0]).toBe("user/r8-note.md");
    expect(def.structuredContent?.degraded).toBeUndefined(); // healthy small vault: no marker
    const inc = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0, includeInternal: true });
    expect(paths(inc).some(p => p.startsWith("_clawmem/"))).toBe(true);
  });

  it("incident inversion cannot recur on vsearch: raw ordering ships even WITH internals (v0.22.0)", async () => {
    // The incident rows (T8-M7) under the v0.21.0 composite ranked the RECENT decay-exempt
    // deduction ABOVE the older true match when internals were included. v0.22.0 ranks the
    // raw route by raw cosine (VSEARCH-RAW-PRIMARY-DESIGN.md R1), so even the opted-in
    // internal view cannot invert: the true match leads on raw similarity, the junk
    // deduction is VISIBLE but below it.
    const inc = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0, includeInternal: true });
    const incPaths = paths(inc);
    expect(incPaths[0]).toBe("user/r8-note.md");                         // raw winner on top
    expect(incPaths.some(p => p.startsWith("_clawmem/"))).toBe(true);    // junk visible when asked
    expect(inc.structuredContent?.scoreBasis).toBe("vector-cosine");
    const def = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0 });
    expect(paths(def)[0]).toBe("user/r8-note.md");
    expect(paths(def).some(p => p.startsWith("_clawmem/"))).toBe(false); // default exclusion intact
  });

  it("query (hybrid) excludes _clawmem by default and exposes no degraded marker on the healthy path", async () => {
    const def = await call("query", { query: "sealed acceptance script sandbox", compact: true });
    expect(paths(def).some(p => p.startsWith("_clawmem/"))).toBe(false);
    expect(def.structuredContent?.degraded).toBeUndefined();
    const inc = await call("query", { query: "deduction junk folder", compact: true, includeInternal: true });
    expect(paths(inc).some(p => p.startsWith("_clawmem/"))).toBe(true);
  });

  it("query_plan excludes _clawmem by default (T6-H1 closure)", async () => {
    const def = await call("query_plan", { query: "sealed acceptance script and also cooking bread notes", compact: true });
    expect(paths(def).some(p => p.startsWith("_clawmem/"))).toBe(false);
    const inc = await call("query_plan", { query: "deduction junk folder and also cooking bread", compact: true, includeInternal: true });
    expect(paths(inc).some(p => p.startsWith("_clawmem/"))).toBe(true);
  });

  it("memory_retrieve keyword/semantic modes exclude by default; flat degraded schema only", async () => {
    for (const mode of ["keyword", "semantic"] as const) {
      const def = await call("memory_retrieve", { query: "deduction junk", mode, compact: true });
      expect(paths(def).some(p => p.startsWith("_clawmem/"))).toBe(false);
      expect(def.structuredContent?.degradedLegs).toBeUndefined(); // single-vector modes: flat shape only
      const inc = await call("memory_retrieve", { query: "deduction junk", mode, compact: true, includeInternal: true });
      expect(paths(inc).some(p => p.startsWith("_clawmem/"))).toBe(true);
    }
  });

  it("memory_retrieve causal mode: internal nodes neither surface via search nor via graph hydration; flat schema (T8-M5)", async () => {
    const res = await call("memory_retrieve", { query: "why did the sealed acceptance script move", mode: "causal", compact: true });
    expect(paths(res).some(p => p.startsWith("_clawmem/"))).toBe(false);
    expect(res.structuredContent?.degradedLegs).toBeUndefined();
  });

  it("find_similar: internal neighbors excluded for a user reference, auto-included for an internal reference", async () => {
    const userRef = await call("find_similar", { file: "user/r8-note.md", limit: 5 });
    const userPaths = (userRef.structuredContent?.results ?? []).map((x: any) => x.file ?? "");
    expect(userPaths.some((p: string) => p.startsWith("_clawmem/"))).toBe(false);

    const internalRef = await call("find_similar", { file: "_clawmem/deductions/junk.md", limit: 5 });
    const internalPaths = (internalRef.structuredContent?.results ?? []).map((x: any) => x.file ?? "");
    // Auto-exception ACTIVE (T9-M5): an internal reference must actually RETURN an
    // internal neighbor (the twin deduction), not merely not-crash.
    expect(internalPaths.some((p: string) => p.startsWith("_clawmem/"))).toBe(true);
  });
});

describe("degraded-marker propagation at the handler level (T9-M5)", () => {
  it("vsearch reports excluded-dominant through structuredContent when the hard cap prevents fill", async () => {
    // Push the vector table past the 4096 hard cap with internal-only nearest neighbors:
    // the handler cannot inject a test cap, so this exercises the REAL production cap.
    // Seeded RAW inside ONE transaction — 4,100 individual insertEmbedding() calls each
    // carry an .immediate() fsync and blow the test budget.
    seedStore.ensureVecTable(4);
    const now = new Date().toISOString();
    const insDoc = seedStore.db.prepare(`INSERT OR IGNORE INTO documents (collection, path, title, hash, created_at, modified_at, active, embed_state) VALUES (?, ?, ?, ?, ?, ?, 1, 'synced')`);
    const insContent = seedStore.db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`);
    const insVec = seedStore.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
    const insCv = seedStore.db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at, fragment_type, fragment_label, canonical_id) VALUES (?, 0, 0, ?, ?, 'full', NULL, ?)`);
    seedStore.db.transaction(() => {
      for (let i = 0; i < 4100; i++) {
        const body = `captest internal filler ${i}`;
        const hash = hashContent(body);
        insContent.run(hash, body, now);
        insDoc.run("_clawmem", `captest/f${i}.md`, `f${i}`, hash, now, now);
        const angle = 0.0002 * i;
        insVec.run(`${hash}_0`, new Float32Array([0, Math.sin(angle), 0, Math.cos(angle)]));
        insCv.run(hash, MODEL, now, canonicalDocId("_clawmem", `captest/f${i}.md`));
      }
      for (let i = 0; i < 2; i++) {
        const body = `captest user needle ${i}`;
        const hash = hashContent(body);
        insContent.run(hash, body, now);
        insDoc.run("user", `captest-user${i}.md`, `needle${i}`, hash, now, now);
        insVec.run(`${hash}_0`, new Float32Array([0, Math.sin(1.2 + i * 0.01), 0, Math.cos(1.2 + i * 0.01)]));
        insCv.run(hash, MODEL, now, canonicalDocId("user", `captest-user${i}.md`));
      }
    })();

    const res = await call("vsearch", { query: "captest probe", compact: true, minScore: 0, limit: 5 });
    expect(res.structuredContent?.degraded).toBe(true);
    expect(res.structuredContent?.degradedReason).toBe("excluded-dominant");
    const note = (res.content ?? []).map(cnt => cnt.text ?? "").join("\n");
    expect(note).toContain("includeInternal");
  }, 30_000);
});

describe("raw-primary regime at the handler level (v0.22.0)", () => {
  it("vsearch non-recency: scoreBasis vector-cosine, NO default floor, explicit minScore filters raw", async () => {
    // Omitted minScore = no filter: the low-cosine cooking doc stays in the list.
    const open = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true });
    expect(open.structuredContent?.scoreBasis).toBe("vector-cosine");
    expect(paths(open)[0]).toBe("user/r8-note.md");
    expect(paths(open)).toContain("user/other.md");
    // Explicit 0 is honored (nullish handling — not treated as "unset").
    const zero = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0 });
    expect(paths(zero)).toEqual(paths(open));
    // A raw-cosine floor filters on the raw scale.
    const tight = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0.9 });
    expect(paths(tight)).toEqual(["user/r8-note.md"]);
  });

  it("vsearch recency-intent keeps the composite regime and its default floor", async () => {
    const res = await call("vsearch", { query: "latest sealed acceptance changes", compact: true, minScore: 0 });
    expect(res.structuredContent?.scoreBasis).toBe("composite");
  });

  it("memory_retrieve semantic ships raw; keyword stays composite", async () => {
    const sem = await call("memory_retrieve", { query: "sealed acceptance script sandbox", mode: "semantic", compact: true });
    expect(sem.structuredContent?.scoreBasis).toBe("vector-cosine");
    expect(paths(sem)[0]).toBe("user/r8-note.md");
    const kw = await call("memory_retrieve", { query: "sealed acceptance", mode: "keyword", compact: true });
    expect(kw.structuredContent?.scoreBasis).toBe("composite");
  });

  it("vsearch recency regime preserves the v0.21 floor: explicit 0 still applies 0.3 (|| semantics)", async () => {
    const omitted = await call("vsearch", { query: "latest sealed acceptance changes", compact: true });
    const zero = await call("vsearch", { query: "latest sealed acceptance changes", compact: true, minScore: 0 });
    expect(omitted.structuredContent?.scoreBasis).toBe("composite");
    expect(paths(zero)).toEqual(paths(omitted));                 // explicit 0 == omitted — the v0.21 `||` contract
    expect(paths(omitted).length).toBeGreaterThan(0);
    expect(paths(omitted)).not.toContain("user/stale-low.md");   // below the preserved 0.3 floor
    const floored = await call("vsearch", { query: "latest sealed acceptance changes", compact: true, minScore: 0.01 });
    expect(paths(floored)).toContain("user/stale-low.md");       // truthy floor moves — it was floor-filtered, not pool-missing
  });

  it("memory_retrieve: recency query stays composite; discovery mode ships raw", async () => {
    const rec = await call("memory_retrieve", { query: "latest sealed acceptance changes", mode: "semantic", compact: true });
    expect(rec.structuredContent?.scoreBasis).toBe("composite");
    const disc = await call("memory_retrieve", { query: "sealed acceptance script sandbox", mode: "discovery", compact: true });
    expect(disc.structuredContent?.scoreBasis).toBe("vector-cosine");
    expect(paths(disc)[0]).toBe("user/r8-note.md");
  });

  it("semantic FTS fallback keeps composite (vector leg unavailable — scores are not cosine)", async () => {
    const res = await call("memory_retrieve", { query: "fallbackprobe cooking", mode: "semantic", compact: true });
    expect(res.structuredContent?.scoreBasis).toBe("composite");
    expect(paths(res)).toContain("user/fallback-doc.md");
  });
});
