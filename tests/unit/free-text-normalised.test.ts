/**
 * BACKLOG 82.3, D7 — FREE TEXT is a normalised field at the tool boundary: a query (or an entity name) that starts
 * with a byte-order mark is read as the text after the mark. Operator ruling 45 A: every free-text input of the MCP
 * server — all twelve, not only the five search tools the design names — and the `query` of REST `/search` and
 * `/retrieve`.
 *
 * Each tool is called on the REAL handler over an in-memory transport, once with the plain text and once with the
 * marked text; the two replies must be the same. No mark is typed into this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { canonicalDocId, createStore, type Store } from "../../src/store.ts";
import { upsertEntity } from "../../src/entity.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { startServer } from "../../src/server.ts";
import { normalizedContent } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];

const DB = `/tmp/clawmem-free-text-normalised-${process.pid}.sqlite`;
const MODEL = "free-text-fake";
const TOKEN = "free-text-test-token-82-3-0000000000000000000";
const PORT = 17467;

const fakeLlm = {
  embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: MODEL }),
  query: async () => null,
  expandQuery: async () => [],
} as any;

let client: Client;
let closeAllStores: () => void;
let store: Store;
let rest: ReturnType<typeof startServer>;

function add(path: string, title: string, text: string, vector: number[]): number {
  const now = new Date().toISOString();
  const { body, hash } = normalizedContent(text);
  store.insertContent(hash, body, now);
  store.insertDocument("user", path, title, hash, now, now);
  store.ensureVecTable(4);
  store.insertEmbedding(hash, 0, 0, new Float32Array(vector), MODEL, now, "full", undefined, canonicalDocId("user", path));
  store.markEmbedSynced(hash);
  return (store.db.prepare(`SELECT id FROM documents WHERE collection = 'user' AND path = ?`).get(path) as { id: number }).id;
}

beforeAll(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
  Bun.env.INDEX_PATH = DB;
  setDefaultLlamaCpp(fakeLlm);
  store = createStore(DB);
  add("tank.md", "Tank filter schedule", "The tank filter is cleaned every week and the tank water is changed.", [1, 0, 0, 0]);
  add("pump.md", "Pump at night", "A pump moves water through the filter of the tank at night.", [0.9, 0.1, 0, 0]);
  add("bread.md", "Bread ovens", "Unrelated cooking notes about bread ovens and flour.", [0, 1, 0, 0]);
  const archived = add("kiln.md", "Kiln firing log", "The kiln firing log lists every glaze firing of the kiln.", [0, 0, 1, 0]);
  store.db.prepare(`UPDATE documents SET active = 0, archived_at = '2026-11-01T00:00:00.000Z', deactivated_reason = 'archive' WHERE id = ?`).run(archived);
  const subject = upsertEntity(store.db, "Aquarium", "project");
  store.addTriple(subject, "uses", null, "a canister filter", { sourceFact: "The aquarium uses a canister filter." });

  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "free-text-tests", version: "0.0.0" });
  await client.connect(clientTransport);
  rest = startServer(store, PORT, "127.0.0.1", { token: TOKEN });
});

afterAll(() => {
  try { rest.stop(); } catch { /* not started */ }
  try { closeAllStores(); } catch { /* already closed */ }
  try { store.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* gone */ } }
});

type ToolResult = { structuredContent?: any; content?: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map(c => c.text ?? "").join("\n");
/** What a reply says, without what differs between two calls for another reason (a time, a duration). */
const said = (r: ToolResult) => ({ isError: r.isError === true, text: text(r).replace(/\d+(\.\d+)?\s?ms\b/g, "<ms>") });

/** The read-only tools: the marked call must say what the plain call says. */
const READ_TOOLS: [string, string, Record<string, unknown>][] = [
  ["memory_retrieve", "query", { query: "tank filter water" }],
  ["search", "query", { query: "tank filter water" }],
  ["vsearch", "query", { query: "tank filter water" }],
  ["query", "query", { query: "tank filter water" }],
  ["memory_rank", "query", { query: "tank filter water" }],
  ["intent_search", "query", { query: "why is the tank filter cleaned" }],
  ["query_plan", "query", { query: "tank filter water and the pump at night" }],
  ["kg_query", "entity", { entity: "Aquarium" }],
  ["memory_forget", "query", { query: "bread ovens flour", confirm: false }],   // a preview: nothing is changed
];

describe("MCP: a free-text input that starts with a mark is read without it", () => {
  for (const [tool, field, args] of READ_TOOLS) {
    test.each(MARKS)(`${tool}: %s`, async (_name, mark) => {
      const plain = await call(tool, args);
      const marked = await call(tool, { ...args, [field]: mark + mark + (args[field] as string) });
      expect(said(marked)).toEqual(said(plain));
      expect(text(plain).length).toBeGreaterThan(0);
      expect(text(marked)).not.toContain(mark);
    });
  }

  test("the plain calls found what they were meant to find (so the comparison above is not empty against empty)", async () => {
    expect(text(await call("search", { query: "tank filter water" }))).toContain("tank.md");
    expect(text(await call("kg_query", { entity: "Aquarium" }))).toContain("canister filter");
    expect(text(await call("memory_forget", { query: "bread ovens flour", confirm: false }))).toContain("Would forget: user/bread.md");
  });

  test.each(MARKS)("memory_pin and memory_snooze find their memory by a query led by %s", async (_name, mark) => {
    const pinned = await call("memory_pin", { query: mark + "pump moves water at night" });
    expect(said(pinned)).toEqual({ isError: false, text: "Pinned: user/pump.md (Pump at night)" });
    await call("memory_pin", { query: "pump moves water at night", unpin: true });
    const snoozed = await call("memory_snooze", { query: mark + "pump moves water at night", until: "2027-01-01" });
    expect(snoozed.isError === true).toBe(false);
    expect(text(snoozed)).toContain("user/pump.md");
    await call("memory_snooze", { query: "pump moves water at night" });      // unsnooze: the next case starts clean
  });

  test.each(MARKS)("lifecycle_restore finds an archived document by a query led by %s", async (_name, mark) => {
    const restored = await call("lifecycle_restore", { query: mark + "kiln firing log" });
    expect(text(restored)).toContain("Restored 1");
    expect(text(restored)).toContain("user/kiln.md");
    store.db.prepare(`UPDATE documents SET active = 0, archived_at = '2026-11-01T00:00:00.000Z', deactivated_reason = 'archive' WHERE collection = 'user' AND path = 'kiln.md'`).run();
  });
});

describe("REST: the query of /search and /retrieve is read without a leading mark", () => {
  const post = async (path: string, body: object) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as { results?: { path: string }[]; query?: string } };
  };

  for (const path of ["/search", "/retrieve"]) {
    test.each(MARKS)(`POST ${path}: %s`, async (_name, mark) => {
      const plain = await post(path, { query: "tank filter water", mode: "keyword" });
      const marked = await post(path, { query: mark + "tank filter water", mode: "keyword" });
      expect(plain.status).toBe(200);
      expect(plain.json.results!.map(r => r.path)).toContain("user/tank.md");
      expect(marked.status).toBe(200);
      expect(marked.json.results!.map(r => r.path)).toEqual(plain.json.results!.map(r => r.path));
      expect(JSON.stringify(marked.json)).not.toContain(mark);
    });
  }
});
