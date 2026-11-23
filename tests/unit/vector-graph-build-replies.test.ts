/**
 * BACKLOG 82.2, D4 — the graph-build replies carry the count of neighbour rows the similarity-link builder skipped
 * (operator ruling 28 A, 2026-11-21): MCP `build_graphs` and REST `POST /graphs/build` gain `semanticSkipped`, only
 * when the count is above zero. Before, the count reached a log line and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { startServer } from "../../src/server.ts";
import { createStore, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const TOKEN = "graph-build-reply-test-token-82-2-00000000000000";
type Reply = { structuredContent?: any; content?: { type: string; text?: string }[]; isError?: boolean };

function seed(store: Store, name: string, vector: number[]): void {
  const now = new Date().toISOString();
  const body = `body of ${name}`;
  const hash = hashContent(body + name);
  seedContent(store.db, hash, body, now);
  store.insertDocument("c", `${name}.md`, name, hash, now, now);
  store.ensureVecTable(2);
  store.insertEmbedding(hash, 0, 0, new Float32Array([0.6, 0.8]), "m1", now);
  store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_0`);
  store.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${hash}_0`, new Float32Array(vector));
}

/** One vault file, an MCP server and a REST server over it. */
async function rig(name: string, port: number, vectors: Record<string, number[]>) {
  const db = `/tmp/clawmem-822-graph-build-${name}-${process.pid}.sqlite`;
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(db + s); } catch { /* none */ } }
  Bun.env.INDEX_PATH = db;
  const store = createStore(db);
  for (const [doc, vector] of Object.entries(vectors)) seed(store, doc, vector);
  const built = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  const client = new Client({ name: "graph-build-tests", version: "0.0.0" });
  await client.connect(clientTransport);
  const rest = startServer(store, port, "127.0.0.1", { token: TOKEN });
  return {
    store,
    mcp: async () => await client.callTool({ name: "build_graphs", arguments: { graph_types: ["semantic"] } }) as Reply,
    rest: async () => {
      const res = await fetch(`http://127.0.0.1:${port}/graphs/build`, {
        method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ temporal: false }),
      });
      return await res.json() as Record<string, unknown>;
    },
    clear: () => store.db.exec(`DELETE FROM memory_relations`),
    close: () => {
      rest.stop(); try { built.closeAllStores(); } catch { /* closed */ } store.close();
      for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(db + s); } catch { /* none */ } }
    },
  };
}
const text = (r: Reply) => (r.content ?? []).map(c => c.text ?? "").join("\n");

describe("graph-build replies and skipped neighbour rows", () => {
  let faulty: Awaited<ReturnType<typeof rig>>;
  let healthy: Awaited<ReturnType<typeof rig>>;
  beforeAll(async () => {
    faulty = await rig("faulty", 17465, { a: [1, 0], b: [1, 0.01], sub: [1e-40, 0] });   // -Infinity: returned by SQL, refused
  });
  afterAll(() => { faulty?.close(); healthy?.close(); delete Bun.env.INDEX_PATH; });

  it("MCP build_graphs: the reply carries `semanticSkipped` and says so in its text", async () => {
    const res = await faulty.mcp();
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.semantic).toBe(2);
    expect(res.structuredContent.semanticSkipped).toBeGreaterThan(0);
    expect(text(res)).toContain("skipped");
    expect(text(res)).toContain("clawmem doctor");
  });

  it("REST POST /graphs/build: the reply carries `semanticSkipped` beside its four keys", async () => {
    faulty.clear();
    const json = await faulty.rest();
    expect(json).toMatchObject({ temporal: 0, semantic: 2, semanticTotal: 2 });
    expect(json.semanticSkipped as number).toBeGreaterThan(0);
  });

  it("a healthy vault: neither reply has the field", async () => {
    faulty.close();
    healthy = await rig("healthy", 17466, { a: [1, 0], b: [1, 0.01] });
    const res = await healthy.mcp();
    expect(res.structuredContent.semantic).toBe(2);
    expect("semanticSkipped" in res.structuredContent).toBe(false);
    expect(text(res)).not.toContain("skipped");
    healthy.clear();
    const json = await healthy.rest();
    expect(json.semantic).toBe(2);
    expect("semanticSkipped" in json).toBe(false);
  });
});
