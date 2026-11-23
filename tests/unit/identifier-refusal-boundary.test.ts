/**
 * BACKLOG 82.3, D7 — the identifier policy at the BOUNDARY: a selector, a collection name or a vault name that starts
 * with a byte-order mark is refused with the typed error, as user input. An MCP tool answers with a tool error that
 * names the field; REST answers 400. Neither ever answers with the document whose name is the text after the mark.
 *
 * Operator ruling 46 A: REST does not percent-decode a path component, so an ENCODED mark there is literal text and
 * names nothing (404). The MCP resource reader decodes, and refuses after decoding.
 *
 * Real handlers: the MCP server over an in-memory transport, the REST server on a local port. No mark is typed here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { canonicalDocId, createStore, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { startServer } from "../../src/server.ts";
import { normalizedContent } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];
const ENCODED: Record<string, string> = { [FEFF]: "%EF%BB%BF", [FFFE]: "%EF%BF%BE" };

const DB = `/tmp/clawmem-identifier-boundary-${process.pid}.sqlite`;
const MODEL = "boundary-fake";
const TOKEN = "identifier-boundary-token-82-3-00000000000000";
const PORT = 17468;
const SECRET = "THE REAL X";                                                // the body of notes/x.md: must never be in a refusal

const fakeLlm = {
  embed: async () => ({ embedding: new Float32Array([1, 0, 0, 0]), model: MODEL }),
  query: async () => null,
  expandQuery: async () => [],
} as any;

let client: Client;
let closeAllStores: () => void;
let store: Store;
let rest: ReturnType<typeof startServer>;
let xHash = "";

function add(path: string, text: string, vector: number[]): string {
  const now = new Date().toISOString();
  const { body, hash } = normalizedContent(text);
  store.insertContent(hash, body, now);
  store.insertDocument("notes", path, path, hash, now, now);
  store.ensureVecTable(4);
  store.insertEmbedding(hash, 0, 0, new Float32Array(vector), MODEL, now, "full", undefined, canonicalDocId("notes", path));
  store.markEmbedSynced(hash);
  return hash;
}

beforeAll(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
  Bun.env.INDEX_PATH = DB;
  setDefaultLlamaCpp(fakeLlm);
  store = createStore(DB);
  xHash = add("x.md", `${SECRET}: the real body of x, about tank filters.`, [1, 0, 0, 0]);
  add("y.md", "The body of y, about pumps and tank filters.", [0.9, 0.1, 0, 0]);
  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "identifier-boundary-tests", version: "0.0.0" });
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

type ToolResult = { structuredContent?: any; content?: { type: string; text?: string; resource?: { text?: string } }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map(c => c.text ?? c.resource?.text ?? "").join("\n");

/** A tool error that is the typed refusal of `field`, and carries neither the mark nor x.md's body. */
function expectRefusal(r: ToolResult, field: string, mark: string): void {
  const said = text(r) + JSON.stringify(r.structuredContent ?? {});
  expect({ isError: r.isError === true, said }).toMatchObject({ isError: true });
  expect(said).toContain(`the ${field} starts with a byte-order mark`);
  expect(said).not.toContain(SECRET);
  expect(said).not.toContain(mark);
}

describe("MCP: a marked selector is a tool error, never the document after the mark", () => {
  test("the sound calls work (so a refusal below is not a tool that fails anyway)", async () => {
    expect(text(await call("get", { file: "notes/x.md" }))).toContain(SECRET);
    expect(text(await call("multi_get", { pattern: "notes/x.md,notes/y.md" }))).toContain(SECRET);
    expect((await call("find_similar", { file: "notes/x.md" })).isError === true).toBe(false);
    expect((await call("timeline", { docid: "#" + xHash.slice(0, 6) })).isError === true).toBe(false);
    expect(text(await call("search", { query: "tank filters", collection: "notes, other" }))).toContain("x.md");
  });

  test.each(MARKS)("get: %s", async (_name, mark) => {
    expectRefusal(await call("get", { file: mark + "x.md" }), "selector", mark);
    expectRefusal(await call("get", { file: "notes/" + mark + "x.md" }), "path", mark);
    expectRefusal(await call("get", { file: "clawmem://" + mark + "notes/x.md:4" }), "collection", mark);
  });

  test.each(MARKS)("multi_get: %s — a list with one marked element, and a glob", async (_name, mark) => {
    expectRefusal(await call("multi_get", { pattern: mark + "x.md,missing.md" }), "selector", mark);
    expectRefusal(await call("multi_get", { pattern: "notes/y.md, notes/" + mark + "x.md" }), "path", mark);
    expectRefusal(await call("multi_get", { pattern: mark + "*.md" }), "selector", mark);
  });

  test.each(MARKS)("find_similar and timeline: %s", async (_name, mark) => {
    expectRefusal(await call("find_similar", { file: mark + "x.md" }), "selector", mark);
    expectRefusal(await call("timeline", { docid: mark + xHash.slice(0, 6) }), "docid", mark);
  });

  test.each(MARKS)("the document resource: %s, percent-encoded, is refused after decoding", async (_name, mark) => {
    for (const uri of [`clawmem://notes/${ENCODED[mark]}x.md`, `clawmem://${ENCODED[mark]}notes/x.md`]) {
      let thrown: unknown, got: unknown;
      try { got = await client.readResource({ uri }); } catch (e) { thrown = e; }
      expect(JSON.stringify(got ?? "")).not.toContain(SECRET);
      expect(String((thrown as Error)?.message ?? "no error")).toContain("starts with a byte-order mark");
    }
    const sound = await client.readResource({ uri: "clawmem://notes/x.md" });
    expect(JSON.stringify(sound)).toContain(SECRET);
  });
});

describe("MCP: a marked collection or vault name is a tool error", () => {
  for (const tool of ["search", "vsearch", "query", "memory_rank"]) {
    test.each(MARKS)(`${tool}: a collection list with one marked name — %s`, async (_name, mark) => {
      expectRefusal(await call(tool, { query: "tank filters", collection: mark + "notes,other" }), "collection", mark);
      expectRefusal(await call(tool, { query: "tank filters", collection: "other, " + mark + "notes" }), "collection", mark);
    });
  }

  test.each(MARKS)("lifecycle_restore and memory_stats: one collection name led by %s", async (_name, mark) => {
    expectRefusal(await call("lifecycle_restore", { collection: mark + "notes" }), "collection", mark);
    expectRefusal(await call("memory_stats", { collection: mark + "notes" }), "collection", mark);
  });

  test.each(MARKS)("a vault name led by %s", async (_name, mark) => {
    expectRefusal(await call("search", { query: "tank filters", vault: mark + "skill" }), "vault", mark);
    expectRefusal(await call("get", { file: "notes/x.md", vault: mark + "skill" }), "vault", mark);
    // the two tools that look the vault name up themselves, before they open it
    expectRefusal(await call("memory_stats", { vault: mark + "skill" }), "vault", mark);
    expectRefusal(await call("memory_rank", { query: "tank filters", vault: mark + "skill" }), "vault", mark);
    expectRefusal(await call("vault_sync", { vault: mark + "skill", content_root: "/tmp" }), "vault", mark);
  });
});

describe("REST: 400 for a marked selector or collection; an encoded mark in a path names nothing", () => {
  const send = async (method: string, path: string, body?: object) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, raw: await res.text() };
  };
  const expect400 = (r: { status: number; raw: string }, field: string, mark: string) => {
    expect({ status: r.status, raw: r.raw }).toMatchObject({ status: 400 });
    expect(r.raw).toContain(`the ${field} starts with a byte-order mark`);
    expect(r.raw).not.toContain(SECRET);
    expect(r.raw).not.toContain(mark);
  };

  test("the sound requests work", async () => {
    expect((await send("GET", "/documents?pattern=" + encodeURIComponent("notes/x.md,notes/y.md"))).raw).toContain(SECRET);
    expect((await send("GET", "/documents/" + xHash.slice(0, 6))).raw).toContain(SECRET);
    expect((await send("POST", "/search", { query: "tank filters", mode: "keyword", collection: "notes" })).status).toBe(200);
  });

  test.each(MARKS)("GET /documents?pattern= with a marked element: %s", async (_name, mark) => {
    expect400(await send("GET", "/documents?pattern=" + encodeURIComponent(mark + "x.md,missing.md")), "selector", mark);
    expect400(await send("GET", "/documents?pattern=" + encodeURIComponent("notes/y.md,notes/" + mark + "x.md")), "path", mark);
  });

  test.each(MARKS)("POST /search and /retrieve with a marked collection: %s", async (_name, mark) => {
    for (const path of ["/search", "/retrieve"]) {
      expect400(await send("POST", path, { query: "tank filters", mode: "keyword", collection: mark + "notes" }), "collection", mark);
      expect400(await send("POST", path, { query: "tank filters", mode: "keyword", collection: "other, " + mark + "notes" }), "collection", mark);
    }
  });

  test.each(MARKS)("POST /reindex and /lifecycle/restore with a marked collection: %s", async (_name, mark) => {
    expect400(await send("POST", "/reindex", { collection: mark + "notes" }), "collection", mark);
    expect400(await send("POST", "/lifecycle/restore", { collection: mark + "notes" }), "collection", mark);
  });

  // Ruling 46 A: no decoding is added. The component stays `%EF%BB%BFx.md`, which is no document's name.
  test.each(MARKS)("GET /documents/<encoded %s>x.md is not found, and is not x.md", async (_name, mark) => {
    const r = await send("GET", `/documents/${ENCODED[mark]}x.md`);
    expect(r.status).toBe(404);
    expect(r.raw).not.toContain(SECRET);
  });
});

describe("MCP vault_sync: its collection_name is an identifier (found while writing the 82.3 docs)", () => {
  test.each(MARKS)("a collection_name led by %s is the typed refusal, before any vault is opened", async (_name, mark) => {
    expectRefusal(await call("vault_sync", { vault: "skill", content_root: "/tmp", collection_name: mark + "notes" }), "collection_name", mark);
  });
});
