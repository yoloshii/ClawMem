/**
 * BACKLOG 82.3, Codex T1 S3, operator ruling 79 A — kg_query's `entity` is split by form.
 *
 * `entity` is either a name (free text: a leading byte-order mark is stripped, ruling 45 A) or a canonical entity id
 * (`vault:type:slug`), which is an IDENTIFIER: a leading mark before an id is refused, never stripped, or a marked id
 * would return the facts of the unmarked one. An argument is taken as an id when, without its marks, it is id-shaped or
 * equals a stored entity id. `resolveEntityQuery` trims only whitespace: JavaScript's `trim()` also removes U+FEFF.
 * No mark is typed into this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, type Store } from "../../src/store.ts";
import { resolveEntityQuery, upsertEntity } from "../../src/entity.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { BomLeadingTextError } from "../../src/sqlite-guard.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];
const DB = `/tmp/clawmem-kg-marked-id-${process.pid}.sqlite`;
const LEGACY_ID = "Legacy:Thing:x";   // a stored id that is not of the canonical shape (an older writer's)

let store: Store, client: Client, closeAllStores: () => void, id: string;

beforeAll(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* none */ } }
  Bun.env.INDEX_PATH = DB;
  setDefaultLlamaCpp({ embed: async () => null, query: async () => null, expandQuery: async () => [], generate: async () => null } as any);
  store = createStore(DB);
  id = upsertEntity(store.db, "Aquarium", "project");
  store.addTriple(id, "uses", null, "a canister filter", { sourceFact: "The aquarium uses a canister filter." });
  store.db.prepare(`INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
                    VALUES (?, 'thing', 'Legacy Thing', datetime('now'), 0, datetime('now'), 'default')`).run(LEGACY_ID);
  store.addTriple(LEGACY_ID, "holds", null, "an old fact", { sourceFact: "Legacy Thing holds an old fact." });
  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await built.server.connect(st);
  client = new Client({ name: "kg-marked-id-tests", version: "0.0.0" });
  await client.connect(ct);
});

afterAll(() => {
  try { closeAllStores(); } catch { /* closed */ }
  try { store.close(); } catch { /* closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(DB + s); } catch { /* gone */ } }
});

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };
const kg = async (entity: string) => await client.callTool({ name: "kg_query", arguments: { entity } }) as ToolResult;
const text = (r: ToolResult) => (r.content ?? []).map(c => c.text ?? "").join("\n");

describe("79 A: kg_query refuses a mark before a canonical id, and still strips one before a name", () => {
  test("controls: the id, the name and the stored non-canonical id each find their facts", async () => {
    expect(id).toMatch(/^[a-z][a-z0-9-]*:[a-z_]+:[a-z0-9_]+$/);
    for (const q of [id, "Aquarium", "  " + id + "  "]) {
      const r = await kg(q);
      expect(r.isError === true, q).toBe(false);
      expect(text(r), q).toContain("canister filter");
    }
    expect(text(await kg(LEGACY_ID))).toContain("an old fact");
  });

  test.each(MARKS)("%s before the canonical id: a tool error naming the field; no facts", async (_n, mark) => {
    for (const q of [mark + id, mark + mark + id, " " + mark + id, mark + " " + id]) {
      const r = await kg(q);
      expect(r.isError, JSON.stringify(q)).toBe(true);
      expect(text(r)).toContain("byte-order mark");
      expect(text(r)).toContain("entity");
      expect(text(r)).not.toContain("canister filter");
      expect(text(r)).not.toContain(mark);
    }
  });

  test.each(MARKS)("%s before an id-shaped argument that names no entity: refused as well", async (_n, mark) => {
    const r = await kg(mark + "default:project:nothing_here");
    expect(r.isError).toBe(true);
  });

  test.each(MARKS)("%s before a stored id that is not of the canonical shape: refused", async (_n, mark) => {
    const r = await kg(mark + LEGACY_ID);
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain("an old fact");
  });

  test.each(MARKS)("%s before a NAME: stripped (45 A) — the same facts as the plain name, spaces before or between the marks included", async (_n, mark) => {
    for (const q of [mark + "Aquarium", " " + mark + "Aquarium", mark + " " + mark + "Aquarium  "]) {
      const r = await kg(q);
      expect(r.isError === true, JSON.stringify(q)).toBe(false);
      expect(text(r), JSON.stringify(q)).toContain("canister filter");
    }
  });
});

describe("79 A: resolveEntityQuery trims whitespace only", () => {
  test.each(MARKS)("%s before an id is not removed by the trim: the lookup binds it and the guard refuses it — never the unmarked id", (_n, mark) => {
    expect(() => resolveEntityQuery(store.db, mark + id)).toThrow(BomLeadingTextError);
    expect(() => resolveEntityQuery(store.db, " " + mark + id)).toThrow(BomLeadingTextError);
  });
  test("surrounding whitespace is still trimmed", () => {
    expect(resolveEntityQuery(store.db, " \t" + id + "\n").via).toBe("canonical-id");
  });
});
