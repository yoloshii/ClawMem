import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * S49.3 H2 — CLAWMEM_DISABLE_FTS_BYPASS escape hatch, all three predeclared tests:
 *   1. ftsBypassEnabled() env parsing (unit)
 *   2. MCP route-level: an expandQuery spy proves the knob forces the expansion path
 *      on a strong-signal fixture (and that the bypass skips it when enabled)
 *   3. CLI behavioral: a subprocess `clawmem query` run against a local
 *      chat-completions stub — expansion traffic reaches the stub ONLY when the knob
 *      disables the bypass (clawmem.ts call site wiring, not just env parsing)
 * Plus the S49.3 H3 dependency: expandQueryCacheKey round-trip — a successful
 * expansion is cached at EXACTLY the exported key (the freeze protocol deletes and
 * verifies rows by this key).
 */

import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, expandQueryCacheKey, type Store } from "../../src/store.ts";
import { hasStrongFtsSignal, ftsBypassEnabled } from "../../src/search-utils.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";

const TEST_DB = "/tmp/clawmem-fts-bypass-knob-test.sqlite";
const REPO_ROOT = new URL("../..", import.meta.url).pathname;

let expandCalls = 0;
const fakeLlm = {
  embed: async (text: string) => ({ embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]), model: "knob-fake" }),
  query: async () => null,
  expandQuery: async (q: string) => {
    expandCalls++;
    // Valid, non-echo, non-fallback-shaped variants — survives sanitization and CACHES.
    return [
      { type: "lex", text: `${q} alternate` },
      { type: "vec", text: "related concept probe" },
    ];
  },
} as any;

let client: Client;
let closeAllStores: () => void;
let seedStore: Store;
let savedKnob: string | undefined;
let savedIndexPath: string | undefined;

function seedDoc(store: Store, col: string, path: string, body: string) {
  const hash = hashContent(body + col + path);
  const now = new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument(col, path, path, hash, now, now);
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) { try { unlinkSync(TEST_DB + suffix); } catch { /* absent */ } }
  savedKnob = process.env.CLAWMEM_DISABLE_FTS_BYPASS;
  savedIndexPath = Bun.env.INDEX_PATH;
  delete process.env.CLAWMEM_DISABLE_FTS_BYPASS;
  Bun.env.INDEX_PATH = TEST_DB;
  setDefaultLlamaCpp(fakeLlm);

  seedStore = createStore(TEST_DB);
  // Strong-signal fixtures: both query terms in the title (weight 10) of exactly one
  // doc each. The 0.85 threshold ⇔ |bm25| ≥ 5.67 needs real IDF headroom — a
  // five-doc corpus caps |bm25| around 2-4 (idf ≈ ln 4) and never reads "strong",
  // so seed ~50 filler docs (idf ≈ ln 34) like a real vault.
  seedDoc(seedStore, "user", "zanzibar-protocol.md", "zanzibar protocol reference. The zanzibar protocol governs handshake ordering.");
  seedDoc(seedStore, "user", "quorbital-matrix.md", "quorbital matrix reference. The quorbital matrix governs rotation invariants.");
  for (let i = 0; i < 50; i++) {
    seedDoc(seedStore, "user", `filler-${i}.md`, `assorted planning notes number ${i} about schedules, follow-ups, cooking, travel bookings, and reading lists`);
  }

  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "knob-tests", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => {
  try { closeAllStores(); } catch { /* already closed */ }
  try { seedStore.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  if (savedKnob === undefined) delete process.env.CLAWMEM_DISABLE_FTS_BYPASS; else process.env.CLAWMEM_DISABLE_FTS_BYPASS = savedKnob;
  if (savedIndexPath === undefined) delete Bun.env.INDEX_PATH; else Bun.env.INDEX_PATH = savedIndexPath;
  for (const suffix of ["", "-wal", "-shm"]) { try { unlinkSync(TEST_DB + suffix); } catch { /* gone */ } }
});

describe("ftsBypassEnabled — env parsing", () => {
  it("enabled when unset, disabled only on the literal 'true'", () => {
    delete process.env.CLAWMEM_DISABLE_FTS_BYPASS;
    expect(ftsBypassEnabled()).toBe(true);
    process.env.CLAWMEM_DISABLE_FTS_BYPASS = "true";
    expect(ftsBypassEnabled()).toBe(false);
    process.env.CLAWMEM_DISABLE_FTS_BYPASS = "1"; // only the literal "true" disables
    expect(ftsBypassEnabled()).toBe(true);
    delete process.env.CLAWMEM_DISABLE_FTS_BYPASS;
  });
});

describe("expandQueryCacheKey — freeze-protocol round-trip", () => {
  it("a successful expansion is cached at exactly the exported key; intent varies the key", async () => {
    const q = "solmarine cadence";
    const before = seedStore.db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(expandQueryCacheKey(q));
    expect(before).toBeNull();
    const variants = await seedStore.expandQuery(q);
    expect(variants.length).toBe(2);
    const row = seedStore.db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(expandQueryCacheKey(q)) as { result: string } | null;
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.result)).toEqual(variants);
    expect(expandQueryCacheKey(q)).not.toBe(expandQueryCacheKey(q, undefined, "some intent"));
    expect(expandQueryCacheKey(q)).not.toBe(expandQueryCacheKey("other query"));
  });
});

describe("MCP query pipeline — knob forces the expansion path", () => {
  const call = async (args: Record<string, unknown>) =>
    await client.callTool({ name: "query", arguments: args });

  it("fixture guard: the query has a strong separated FTS signal", () => {
    expect(hasStrongFtsSignal(seedStore.searchFTS("zanzibar protocol", 20))).toBe(true);
  });

  it("bypass fires by default (no expansion), knob forces expansion, unsetting restores the bypass", async () => {
    delete process.env.CLAWMEM_DISABLE_FTS_BYPASS;
    const base = expandCalls;
    await call({ query: "zanzibar protocol", compact: true });
    expect(expandCalls).toBe(base); // bypass fired — expansion never invoked

    process.env.CLAWMEM_DISABLE_FTS_BYPASS = "true";
    await call({ query: "zanzibar protocol", compact: true });
    expect(expandCalls).toBe(base + 1); // knob disabled the bypass — expansion ran

    delete process.env.CLAWMEM_DISABLE_FTS_BYPASS;
    await call({ query: "zanzibar protocol", compact: true });
    expect(expandCalls).toBe(base + 1); // bypass fires again — no new expansion
  });
});

describe("CLI query — knob wiring at the clawmem.ts call site (subprocess)", () => {
  it("expansion traffic reaches the LLM endpoint only when the knob disables the bypass", async () => {
    let hits = 0;
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "POST" && new URL(req.url).pathname.endsWith("/chat/completions")) hits++;
        return Response.json({ choices: [{ message: { content: "" } }] });
      },
    });
    try {
      const runCli = async (knob: boolean): Promise<{ code: number; stderr: string; hits: number }> => {
        const start = hits;
        const env: Record<string, string> = {
          ...process.env as Record<string, string>,
          INDEX_PATH: TEST_DB,
          CLAWMEM_LLM_URL: `http://127.0.0.1:${stub.port}`,
          CLAWMEM_NO_LOCAL_MODELS: "true",
        };
        delete (env as Record<string, unknown>).CLAWMEM_DISABLE_FTS_BYPASS;
        if (knob) env.CLAWMEM_DISABLE_FTS_BYPASS = "true";
        const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "query", "quorbital matrix"], {
          cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe",
        });
        const code = await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        return { code, stderr, hits: hits - start };
      };

      const off = await runCli(false); // bypass active → ZERO expansion traffic
      expect(off.code, `knob-off CLI failed: ${off.stderr}`).toBe(0);
      const on = await runCli(true); // bypass disabled → expansion hits the stub
      expect(on.code, `knob-on CLI failed: ${on.stderr}`).toBe(0);
      expect(off.hits).toBe(0);
      expect(on.hits).toBeGreaterThan(0);
    } finally {
      stub.stop(true);
    }
  }, 60_000);
});
