/**
 * BACKLOG 82.2, D4 — the lifecycle row of the route table: the candidate discovery behind `memory_forget`,
 * `memory_pin` and `memory_snooze`, on the REAL tool handlers over an in-memory transport.
 *
 * The discovery is a cascade — path, lexical, title, and only then the vector source. So:
 *  - a candidate from the first three is used with NO embedding call and no degraded mark;
 *  - when the vector source IS reached and its query vector is refused, the reply is the stated "no match — vector
 *    search was unavailable" error, distinct from the plain not-found, and nothing is changed;
 *  - an endpoint that is down stays the plain not-found; a dimension error is still raised.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, canonicalDocId, VecDimensionMismatchError, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const TEST_DB = "/tmp/clawmem-822-lifecycle-route-test.sqlite";
const MODEL = "route-fake";
const UNAVAILABLE = "No match — vector search was unavailable (the embedding endpoint returned a malformed vector)";
const TOOLS = ["memory_forget", "memory_pin", "memory_snooze"] as const;

let client: Client;
let closeAllStores: () => void;
let seedStore: Store;
let embedCalls: string[] = [];
let embedAnswer: (text: string) => unknown = () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: MODEL });
const fakeLlm = {
  embed: async (text: string) => { embedCalls.push(text); return embedAnswer(text); },
  query: async () => null,
  expandQuery: async () => [],
} as any;

beforeAll(async () => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  Bun.env.INDEX_PATH = TEST_DB;
  setDefaultLlamaCpp(fakeLlm);
  seedStore = createStore(TEST_DB);
  const now = new Date().toISOString();
  const add = (path: string, body: string, vector: number[]) => {
    const hash = hashContent(body + path);
    seedContent(seedStore.db, hash, body, now);
    seedStore.insertDocument("user", path, path.replace(/\.md$/, ""), hash, now, now);
    seedStore.ensureVecTable(4);
    seedStore.insertEmbedding(hash, 0, 0, new Float32Array(vector), MODEL, now, "full", undefined, canonicalDocId("user", path));
    seedStore.markEmbedSynced(hash);
  };
  add("zanzibar.md", "zanzibar protocol reference. The zanzibar protocol governs handshake ordering.", [1, 0, 0, 0]);
  add("other.md", "unrelated cooking notes about bread", [0, 1, 0, 0]);
  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "lifecycle-route-tests", version: "0.0.0" });
  await client.connect(clientTransport);
});
afterAll(() => {
  try { closeAllStores(); } catch { /* already closed */ }
  try { seedStore.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  try { unlinkSync(TEST_DB); } catch { /* gone */ }
});
beforeEach(() => { embedCalls = []; embedAnswer = () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: MODEL }); });

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map(c => c.text ?? "").join("\n");
const args = (tool: string, query: string) => (tool === "memory_forget" ? { query, confirm: false } : tool === "memory_snooze" ? { query, until: "2099-01-01" } : { query });
/** What the lifecycle tools can change: active, pinned, snoozed — of every document. */
const state = () => JSON.stringify(seedStore.db.prepare(`SELECT path, active, pinned, snoozed_until FROM documents ORDER BY path`).all());
/** A query no path, no lexical term and no title matches: the discovery reaches the vector source. */
const ONLY_VECTOR = "qwxzv plorth";

describe("lifecycle candidate discovery — the vector source is the last of a cascade", () => {
  it("a lexical candidate is used with NO embedding call and no error", async () => {
    const before = state();
    const res = await call("memory_forget", { query: "zanzibar protocol", confirm: false });
    expect(embedCalls).toEqual([]);
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("zanzibar");
    expect(text(res)).not.toContain("vector search was unavailable");
    expect(state()).toBe(before);
  });

  it("a lexical candidate is used even when the endpoint would refuse: nothing is asked of it", async () => {
    embedAnswer = () => ({ embedding: new Float32Array([NaN, 0, 0, 0]), model: MODEL });
    const res = await call("memory_pin", { query: "zanzibar protocol" });
    expect(embedCalls).toEqual([]);
    expect(res.isError).toBeFalsy();
    await call("memory_pin", { query: "zanzibar protocol", unpin: true });
  });

  for (const tool of TOOLS) {
    it(`${tool}: the vector source reached and its query vector refused — the stated error, nothing changed`, async () => {
      embedAnswer = () => ({ embedding: new Float32Array([NaN, 0, 0, 0]), model: MODEL });
      const before = state();
      const res = await call(tool, args(tool, ONLY_VECTOR));
      expect(embedCalls.length).toBe(1);
      expect(text(res)).toBe(UNAVAILABLE);
      expect(res.isError).toBe(true);
      expect(state()).toBe(before);
    });

    it(`${tool}: an endpoint that is down stays the plain not-found`, async () => {
      embedAnswer = () => { throw new Error("embed endpoint down"); };
      const before = state();
      const res = await call(tool, args(tool, ONLY_VECTOR));
      expect(text(res)).toBe(`No matching memory found for "${ONLY_VECTOR}"`);
      expect(state()).toBe(before);
    });
  }

  it("a healthy vector source still finds a candidate", async () => {
    const res = await call("memory_forget", { query: ONLY_VECTOR, confirm: false });
    expect(embedCalls.length).toBe(1);
    expect(text(res)).not.toBe(`No matching memory found for "${ONLY_VECTOR}"`);
    expect(text(res)).not.toContain("vector search was unavailable");
  });

  it("a dimension error is still raised, not turned into the unavailable reply", async () => {
    embedAnswer = () => { throw new VecDimensionMismatchError(4, 8); };
    const res = await call("memory_forget", { query: ONLY_VECTOR, confirm: false }).catch(e => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] }) as ToolResult);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Embedding dimension changed");
    expect(text(res)).not.toContain("vector search was unavailable");
  });
});
