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
  embed: async (text: string) => ({ embedding: fakeVec(text), model: MODEL }),
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

  it("incident composite inversion exists WITH internals and is fixed by the default exclusion", async () => {
    // The incident rows (T8-M7): with internals included, the RECENT decay-exempt
    // deduction composite-OUTRANKS the older true match — the measured 2026-07-10
    // inversion. The default (excluded) route restores the true match on top.
    const inc = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0, includeInternal: true });
    const incPaths = paths(inc);
    expect(incPaths[0]!.startsWith("_clawmem/")).toBe(true); // junk composite-outranks the true match
    expect(incPaths).toContain("user/r8-note.md");            // which IS in the pool below it
    const def = await call("vsearch", { query: "sealed acceptance script sandbox", compact: true, minScore: 0 });
    expect(paths(def)[0]).toBe("user/r8-note.md");
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
