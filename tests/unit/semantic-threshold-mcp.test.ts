/**
 * BACKLOG 82.2, D5 — the MCP tool `build_graphs` refuses a `semantic_threshold` outside its documented domain [0, 1]
 * and builds nothing. (A negative threshold is the only way a negative similarity was ever stored as a weight.)
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, type Store } from "../../src/store.ts";
import { addDocument } from "../helpers/vector-health-vault.ts";

type Reply = { structuredContent?: any; content?: { type: string; text?: string }[]; isError?: boolean };
const DB = `/tmp/clawmem-822-threshold-${process.pid}.sqlite`;
let store: Store;
let client: Client;
let built: ReturnType<typeof buildMcpServer>;
const relations = () => (store.db.prepare(`SELECT COUNT(*) AS n FROM memory_relations`).get() as { n: number }).n;

beforeAll(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
  Bun.env.INDEX_PATH = DB;
  store = createStore(DB);
  store.ensureVecTable(2);
  addDocument(store, "a", [[1, 0]]);
  addDocument(store, "b", [[1, 0.01]]);
  addDocument(store, "far", [[-1, 0]]);
  built = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "threshold-tests", version: "0.0.0" });
  await client.connect(clientTransport);
});
afterAll(() => {
  try { built.closeAllStores(); } catch { /* closed */ }
  store.close();
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
});

async function build(threshold: number): Promise<{ refused: boolean; text: string }> {
  try {
    const reply = await client.callTool({ name: "build_graphs", arguments: { graph_types: ["semantic"], semantic_threshold: threshold } }) as Reply;
    return { refused: reply.isError === true, text: (reply.content ?? []).map(c => c.text ?? "").join("\n") };
  } catch (e) {
    return { refused: true, text: (e as Error).message };
  }
}

describe("build_graphs", () => {
  it("refuses a threshold outside [0, 1] and builds nothing", async () => {
    for (const threshold of [-0.9, 1.5, -0.0001, 1.0001]) {
      const r = await build(threshold);
      expect({ threshold, refused: r.refused }).toEqual({ threshold, refused: true });
      // refused by the tool's own input schema — it names the input — before the builder is reached
      expect(r.text).toContain("semantic_threshold");
      expect(r.text).not.toContain("semantic threshold must be a number");
      expect(relations()).toBe(0);
    }
  });

  it("builds with a threshold inside the domain", async () => {
    const r = await build(0.7);
    expect(r.refused).toBe(false);
    expect(relations()).toBeGreaterThan(0);
    expect((store.db.prepare(`SELECT MIN(weight) AS w FROM memory_relations`).get() as { w: number }).w).toBeGreaterThanOrEqual(0);
  });
});
