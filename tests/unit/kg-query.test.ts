import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * Source 76.2 — `kg_query` resolves its argument through the REAL MCP handler, over an
 * in-memory transport against a seeded vault.
 *
 * Bug-first: the handler took `searchEntities(entity, 1)`, an exact-token FTS search ranked by
 * mention count, before anything else. So `kg_query("Node 200")` answered with Node 202's
 * facts (116 mentions vs 0), `kg_query("Atlas Two")` with an entity
 * that shares the token "two", and `kg_query("default:project:node_200")` with ClawMem's facts
 * (the ID's tokens "default"/"project" match every entity). The fixed order: an existing ID,
 * every entity with exactly this name, then the name search, which never runs for an
 * ID-shaped argument and never lands on a name whose numbers differ. Vault config is hermetic
 * (empty CLAWMEM_CONFIG_DIR, CLAWMEM_VAULTS cleared).
 */

import { unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { clearConfigCache } from "../../src/config.ts";

const TEST_DB = join(tmpdir(), `clawmem-kg-query-test-${process.pid}.sqlite`);

const fakeLlm = {
  embed: async () => ({ embedding: new Float32Array([0, 0, 0, 1]), model: "kg-fake" }),
  query: async () => null,
  expandQuery: async () => [],
} as any;

let client: Client;
let closeAllStores: () => void;
let seedStore: Store;
let prevIndexPath: string | undefined;
let prevConfigDir: string | undefined;
let prevVaults: string | undefined;
let tmpConfigDir: string | undefined;

function seedEntity(store: Store, entityId: string, name: string, type: string, mentions: number): void {
  store.db.prepare(
    `INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
     VALUES (?, ?, ?, NULL, datetime('now'), ?, datetime('now'), 'default')`
  ).run(entityId, type, name, mentions);
  store.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`)
    .run(entityId, name.toLowerCase(), type);
}

beforeAll(async () => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) { try { unlinkSync(f); } catch { /* absent */ } }
  prevIndexPath = Bun.env.INDEX_PATH;
  prevConfigDir = Bun.env.CLAWMEM_CONFIG_DIR;
  prevVaults = Bun.env.CLAWMEM_VAULTS;
  Bun.env.INDEX_PATH = TEST_DB;
  tmpConfigDir = mkdtempSync(join(tmpdir(), "clawmem-kg-query-cfg-"));
  Bun.env.CLAWMEM_CONFIG_DIR = tmpConfigDir;
  delete Bun.env.CLAWMEM_VAULTS;
  clearConfigCache();
  setDefaultLlamaCpp(fakeLlm);

  seedStore = createStore(TEST_DB);
  seedEntity(seedStore, "default:service:clawmem", "ClawMem", "service", 500);
  seedEntity(seedStore, "default:tool:bun", "Bun", "tool", 40);
  seedEntity(seedStore, "default:project:node_202", "Node 202", "project", 116);
  seedEntity(seedStore, "default:location:node_202", "Node 202", "location", 1);
  seedEntity(seedStore, "default:concept:postgres", "Postgres", "concept", 2);
  seedEntity(seedStore, "default:concept:datacenter", "Datacenter", "concept", 3);
  seedEntity(seedStore, "default:project:node_200", "Node 200", "project", 0);
  seedEntity(seedStore, "default:concept:driver_580", "Driver 580", "concept", 0);
  seedEntity(seedStore, "default:concept:atlas_two", "Atlas Two", "concept", 0);
  seedEntity(seedStore, "default:concept:report_9_two_axes", "Report 9 two axes", "concept", 5);

  const add = (s: string, p: string, o: string, fact: string) =>
    seedStore.addTriple(s, p, o, null, { confidence: 0.9, sourceFact: fact });
  add("default:service:clawmem", "depends_on", "default:tool:bun", "ClawMem depends_on Bun");
  add("default:project:node_202", "hosts", "default:concept:postgres", "Node 202 hosts Postgres");
  add("default:location:node_202", "part_of", "default:concept:datacenter", "Node 202 part_of Datacenter");
  add("default:project:node_200", "runs_on", "default:concept:driver_580", "Node 200 runs_on Driver 580");
  add("default:concept:atlas_two", "integrates_with", "default:project:node_200", "Atlas Two integrates_with Node 200");
  add("default:concept:report_9_two_axes", "relates_to", "default:service:clawmem", "Report 9 two axes relates_to ClawMem");

  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "kg-query-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);
});

afterAll(async () => {
  await client.close();
  closeAllStores();
  seedStore.close();
  if (prevIndexPath === undefined) delete Bun.env.INDEX_PATH; else Bun.env.INDEX_PATH = prevIndexPath;
  if (prevConfigDir === undefined) delete Bun.env.CLAWMEM_CONFIG_DIR; else Bun.env.CLAWMEM_CONFIG_DIR = prevConfigDir;
  if (prevVaults === undefined) delete Bun.env.CLAWMEM_VAULTS; else Bun.env.CLAWMEM_VAULTS = prevVaults;
  clearConfigCache();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) { try { unlinkSync(f); } catch { /* already gone */ } }
  if (tmpConfigDir) rmSync(tmpConfigDir, { recursive: true, force: true });
});

type ToolResult = { structuredContent?: any; isError?: boolean; content: { type: string; text?: string }[] };
const kg = async (entity: string): Promise<ToolResult> =>
  await client.callTool({ name: "kg_query", arguments: { entity } }) as ToolResult;
const text = (r: ToolResult) => r.content.map(c => c.text ?? "").join("\n");
const factIds = (r: ToolResult) => [...new Set((r.structuredContent?.facts ?? []).map((f: any) => f.entityId))];

describe("kg_query resolution (76.2)", () => {
  // Each test asserts WHICH facts come back first (the old handler's text carries them too), so
  // on the unfixed handler it fails on the resolution itself; the new header and structured
  // fields are asserted after. "an ordinary name" is a regression guard, not a bug-first test.
  it("an exact name answers at 0 mentions, not the much-mentioned Node 202", async () => {
    const r = await kg("Node 200");
    expect(text(r)).toContain("runs_on");
    expect(text(r)).not.toContain("hosts");
    expect(r.structuredContent.resolution).toEqual({
      via: "exact-name",
      entities: [{ entityId: "default:project:node_200", name: "Node 200", type: "project", facts: 2 }],
    });
    expect(text(r)).toContain(`Knowledge graph for "Node 200" [default:project:node_200] (2 facts):`);
    expect(factIds(r)).toEqual(["default:project:node_200"]);
  });

  it("matches the exact name case-insensitively", async () => {
    const r = await kg("node 200");
    expect(text(r)).toContain("runs_on");
    expect(text(r)).not.toContain("hosts");
    expect(factIds(r)).toEqual(["default:project:node_200"]);
  });

  it("an exact two-word name beats an entity sharing one of its tokens", async () => {
    const r = await kg("Atlas Two");
    expect(text(r)).toContain("integrates_with");
    expect(text(r)).not.toContain("relates_to");
    expect(r.structuredContent.resolution.entities.map((e: any) => e.entityId)).toEqual(["default:concept:atlas_two"]);
  });

  it("a canonical ID answers for itself, not for the entity its tokens match most", async () => {
    const r = await kg("default:project:node_200");
    expect(text(r)).toContain("runs_on");
    expect(text(r)).not.toContain("depends_on");
    expect(r.structuredContent.resolution.via).toBe("canonical-id");
    expect(factIds(r)).toEqual(["default:project:node_200"]);
  });

  it("an unknown ID is used as given, even when another entity shares its slug", async () => {
    // a slug is lossy ("C++" and "C#" both slug to "c"), so no other entity stands in for an ID
    const r = await kg("default:concept:node_200");
    expect(text(r)).not.toContain("depends_on");
    expect(text(r)).toContain(`No knowledge graph facts found for "default:concept:node_200" (resolved to default:concept:node_200)`);
    expect(r.structuredContent).toBeUndefined();
  });

  it("an unknown ID-shaped argument is used as given and never borrows another entity's facts", async () => {
    const r = await kg("default:project:node_999");
    expect(text(r)).not.toContain("depends_on");
    expect(text(r)).toContain(`No knowledge graph facts found for "default:project:node_999" (resolved to default:project:node_999)`);
    expect(r.structuredContent).toBeUndefined();
  });

  it("lists each entity that shares the name, with its own facts", async () => {
    const r = await kg("Node 202");
    const t = text(r);
    expect(t).toContain("hosts");
    expect(t).toContain("part_of");
    expect(r.structuredContent.resolution).toEqual({
      via: "exact-name",
      entities: [
        { entityId: "default:project:node_202", name: "Node 202", type: "project", facts: 1 },
        { entityId: "default:location:node_202", name: "Node 202", type: "location", facts: 1 },
      ],
    });
    expect(t).toContain(`Knowledge graph for "Node 202": 2 entities share this name (2 facts):`);
    expect(t).toContain("default:project:node_202 (project, 1 fact):");
    expect(t).toContain("default:location:node_202 (location, 1 fact):");
    expect(t.indexOf("hosts")).toBeGreaterThan(t.indexOf("default:project:node_202 (project"));
    expect(t.indexOf("part_of")).toBeGreaterThan(t.indexOf("default:location:node_202 (location"));
    expect(factIds(r)).toEqual(["default:project:node_202", "default:location:node_202"]);
  });

  it("the name search finds a partial name and says which entity it chose", async () => {
    const r = await kg("Atlas");
    expect(text(r)).toContain("integrates_with");
    expect(text(r)).toContain(`Knowledge graph for "Atlas": no entity has that exact name, so this is "Atlas Two" [default:concept:atlas_two], the most-mentioned entity with a word of "Atlas" in its name (1 fact):`);
    expect(r.structuredContent.resolution.via).toBe("name-word");
  });

  it("the name search never lands on a name with a different number", async () => {
    const r = await kg("Node 207");
    expect(text(r)).not.toContain("hosts");
    expect(text(r)).toContain(`No entity found matching "Node 207"`);
    expect(r.structuredContent).toBeUndefined();
  });

  it("the name search reads names only: a type or vault word finds no entity", async () => {
    // entities_fts also indexes entity_type and entity_id, where "project" matches every project
    const r = await kg("project");
    expect(text(r)).not.toContain("hosts");
    expect(text(r)).toContain(`No entity found matching "project"`);
  });

  it("an ordinary name still answers as before", async () => {
    const r = await kg("ClawMem");
    expect(text(r)).toContain("depends_on");
    expect(factIds(r)).toEqual(["default:service:clawmem"]);
  });
});
