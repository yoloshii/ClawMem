/**
 * BACKLOG 82.2, D4 — the causal rows as the REPLIES carry them. The causal pipeline no longer rethrows a refused
 * QUERY vector, so every route that runs it must say so: MCP `memory_retrieve` (causal mode), MCP `intent_search`
 * and REST `POST /retrieve` (causal mode). A healthy run is not marked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { startServer } from "../../src/server.ts";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";
import { VecPoisonError } from "../../src/vector-guard.ts";

import { seedContent } from "../helpers/seed-content.ts";
const DB = `/tmp/clawmem-822-causal-replies-${process.pid}.sqlite`;
const TOKEN = "causal-replies-test-token-82-2-0000000000000000";
const PORT = 17463;
const MODEL = "route-fake";
const QUERY = "why is the tank filter cleaned";
const NOTE = "malformed vector";
const healthy = async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: MODEL });
/** As the real client does on a malformed reply (`tests/unit/embed-response-boundary.test.ts`). */
const refused = async () => { throw new VecPoisonError("non-finite", "endpoint", { context: "query" } as never, { elementIndex: 0 }); };

let embed: () => Promise<unknown> = healthy;
let client: Client;
let closeAllStores: () => void;
let restStore: Store;
let rest: ReturnType<typeof startServer>;

beforeAll(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
  Bun.env.INDEX_PATH = DB;
  setDefaultLlamaCpp({
    embed: async () => embed(), query: async () => null, expandQuery: async () => [],
    rerank: async () => ({ results: [] as { file: string; score: number }[] }),       // the rerank stage runs when anchors exist
  } as any);
  restStore = createStore(DB);
  const now = new Date().toISOString();
  for (const [path, body, vector] of [
    ["tank.md", "The tank filter is cleaned every week because the water turns cloudy.", [1, 0, 0, 0]],
    ["pump.md", "A pump moves water through the filter of the tank at night.", [0.9, 0.1, 0, 0]],
  ] as const) {
    const hash = hashContent(body + path);
    seedContent(restStore.db, hash, body, now);
    restStore.insertDocument("user", path, path.replace(/\.md$/, ""), hash, now, now);
    restStore.ensureVecTable(4);
    restStore.insertEmbedding(hash, 0, 0, new Float32Array(vector), MODEL, now, "full", undefined, canonicalDocId("user", path));
    restStore.markEmbedSynced(hash);
  }
  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "causal-reply-tests", version: "0.0.0" });
  await client.connect(clientTransport);
  rest = startServer(restStore, PORT, "127.0.0.1", { token: TOKEN });
});
afterAll(() => {
  rest.stop();
  try { closeAllStores(); } catch { /* already closed */ }
  restStore.close();
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
});
beforeEach(() => { embed = healthy; });

type ToolResult = { structuredContent?: any; content?: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map(c => c.text ?? "").join("\n");
const post = async (body: object) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/retrieve`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, any> };
};

describe("a refused query vector in the causal pipeline is said by every reply that runs it", () => {
  it("MCP memory_retrieve, causal mode: not an error; the flat degraded fields and the note", async () => {
    embed = refused;
    const res = await call("memory_retrieve", { query: QUERY, mode: "causal" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ mode: "causal", degraded: true, degradedReason: "vector-fault" });
    expect(text(res)).toContain(NOTE);
  });

  it("MCP intent_search: not an error; the legs are listed", async () => {
    embed = refused;
    const res = await call("intent_search", { query: QUERY });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.degraded).toBe(true);
    expect(res.structuredContent.degradedLegs).toContainEqual({ leg: "causal:vector", reason: "vector-fault" });
    for (const leg of res.structuredContent.degradedLegs) expect(leg.reason).toBe("vector-fault");
    expect(text(res)).toContain(NOTE);
  });

  it("REST POST /retrieve, causal mode: 200; `degraded` and the legs", async () => {
    embed = refused;
    const res = await post({ query: QUERY, mode: "causal" });
    expect(res.status).toBe(200);
    expect(res.json.degraded).toBe(true);
    expect(res.json.degradedLegs).toContainEqual({ leg: "causal:vector", reason: "vector-fault" });
  });

  it("the lexical anchors still answer: a query whose terms match comes back with results AND the mark", async () => {
    embed = refused;
    const KEYWORDS = "tank filter cleaned";                     // every term is in tank.md
    const retrieve = await call("memory_retrieve", { query: KEYWORDS, mode: "causal" });
    expect(retrieve.structuredContent).toMatchObject({ degraded: true, degradedReason: "vector-fault" });
    expect(retrieve.structuredContent.results.some((r: any) => r.path.endsWith("tank.md"))).toBe(true);
    const intent = await call("intent_search", { query: KEYWORDS, force_intent: "WHY" });
    expect(intent.isError).toBeFalsy();
    expect(intent.structuredContent.degraded).toBe(true);
    expect(intent.structuredContent.results.some((r: any) => r.file.endsWith("tank.md"))).toBe(true);
    const restReply = await post({ query: KEYWORDS, mode: "causal" });
    expect(restReply.json.degraded).toBe(true);
    expect(restReply.json.results.some((r: any) => r.path.endsWith("tank.md"))).toBe(true);
  });

  it("a healthy run: none of the three is marked", async () => {
    const retrieve = await call("memory_retrieve", { query: QUERY, mode: "causal" });
    const intent = await call("intent_search", { query: QUERY });
    const restReply = await post({ query: QUERY, mode: "causal" });
    for (const sc of [retrieve.structuredContent, intent.structuredContent, restReply.json]) {
      expect(sc.degraded).toBeUndefined();
      expect(sc.degradedLegs).toBeUndefined();
    }
    expect(text(retrieve)).not.toContain(NOTE);
    expect(text(intent)).not.toContain(NOTE);
  });
});
