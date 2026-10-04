/**
 * 62.2 (codex T6 #1, T7 #1, #2, #4, T8 #3, #4; CR-3) — the legacy pre-compaction snapshot never reaches
 * a model through the REAL MCP tools, resources, REST endpoints or hooks. The vault holds active copies
 * of it (origin fs, a fileless NULL one, api) that are linked to real notes every way retrieval can
 * travel: shared terms, vectors, an entity co-occurrence, semantic and causal relations, adjacent
 * timestamps, a due review date, an evolution trigger, and paths a glob or a suffix matches.
 * Deliberate access by exact path or docid still reaches a copy.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { hashContent } from "../../src/indexer.ts";
import { stalenessCheck } from "../../src/hooks/staleness-check.ts";
import { sessionBootstrap } from "../../src/hooks/session-bootstrap.ts";
import { startServer } from "../../src/server.ts";

// The REST server needs a token on every request and a JSON Content-Type on every POST (BACKLOG 62.4).
const REST_TOKEN = "rest-test-token-62-4-0000000000000000000000";
const AUTH = { Authorization: `Bearer ${REST_TOKEN}` };
import { EVOLUTION_WRITER_FLOOR_FLAG } from "../../src/compaction-state.ts";

const MODEL = "quarantine-mcp-fake";
const vec = () => new Float32Array([0.1, 0.1, 1, 0]);
const CANARY = "CANARY-MCPQ";
const LEGACY = `# Pre-Compaction State\n\n_Extracted 2026-09-01T10:00:00 before auto-compaction. This is authoritative._\n\n## Last User Request\n\nzephyrinth project ${CANARY} from another session\n`;
const COPIES = ["-u-fs/memory/precompact-state.md", "-u-null/memory/precompact-state.md", "-u-api/memory/precompact-state.md"];

let root: string;
let seedStore: Store;
let client: Client;
let closeAllStores: () => void;
let rest: ReturnType<typeof startServer>;
const docs: Record<string, { id: number; hash: string }> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "clawmem-622-mcp-"));
  Bun.env.INDEX_PATH = join(root, "vault.sqlite");
  setDefaultLlamaCpp({
    embed: async () => ({ embedding: vec(), model: MODEL }),
    query: async () => null,
    expandQuery: async () => [],
    rerank: async (_q: string, documents: { file: string }[]) => ({ results: documents.map((d, index) => ({ file: d.file, score: 0.5, index })), model: MODEL }),
  } as any);

  seedStore = createStore(Bun.env.INDEX_PATH);
  const t0 = Date.parse("2026-09-20T12:00:00.000Z");
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const seed = (path: string, body: string, origin: string | null, modifiedAt: string) => {
    const hash = hashContent(body + path);
    seedStore.insertContent(hash, body, modifiedAt);
    seedStore.insertDocument("agent-memory", path, path, hash, modifiedAt, modifiedAt);
    seedStore.db.prepare("UPDATE documents SET origin = ? WHERE collection = 'agent-memory' AND path = ?").run(origin, path);
    seedStore.markEmbedSynced(hash);
    seedStore.ensureVecTable(4);
    seedStore.insertEmbedding(hash, 0, 0, vec(), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("agent-memory", path));
    docs[path] = { id: (seedStore.db.prepare("SELECT id FROM documents WHERE collection = 'agent-memory' AND path = ?").get(path) as { id: number }).id, hash };
  };
  seed("anchor.md", "zephyrinth project anchor note about the gantry rig", "fs", at(0));
  seed(COPIES[0]!, LEGACY, "fs", at(1));
  seed(COPIES[1]!, LEGACY.replace(/\n/g, "\r\n"), null, at(-1));
  seed(COPIES[2]!, LEGACY, "api", at(2));
  seed("gantry-note.md", "calibration log for the gantry rig, written by the lab", "fs", at(3));
  seed("review-me.md", "a note whose review date has passed", "fs", at(-30));

  // Entity link: the anchor mentions E1, which co-occurs with E2; the note and every copy mention E2.
  const now = new Date().toISOString();
  const node = seedStore.db.prepare("INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count) VALUES (?, 'project', ?, ?, 1)");
  node.run("e1", "zephyrinth", now);
  node.run("e2", "gantry", now);
  const mention = seedStore.db.prepare("INSERT INTO entity_mentions (entity_id, doc_id, mention_text, created_at) VALUES (?, ?, ?, ?)");
  mention.run("e1", docs["anchor.md"]!.id, "zephyrinth", now);
  mention.run("e2", docs["gantry-note.md"]!.id, "gantry", now);
  for (const p of COPIES) mention.run("e2", docs[p]!.id, "gantry", now);
  seedStore.db.prepare("INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred) VALUES ('e1', 'e2', 5, ?)").run(now);

  // Relations from the anchor to every copy and to the note.
  const rel = seedStore.db.prepare("INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, ?, 1.0, ?)");
  for (const p of [...COPIES, "gantry-note.md"]) {
    rel.run(docs["anchor.md"]!.id, docs[p]!.id, "semantic", now);
    rel.run(docs["anchor.md"]!.id, docs[p]!.id, "causal", now);
  }

  // Due for review: every copy, and one real note.
  seedStore.db.prepare("UPDATE documents SET review_by = '2026-01-01' WHERE collection = 'agent-memory' AND (path = 'review-me.md' OR path LIKE '%/precompact-state.md')").run();

  // The anchor's A-MEM evolution history: an entry the real note triggered, then one a copy triggered.
  const evo = seedStore.db.prepare("INSERT INTO memory_evolution (memory_id, triggered_by, version, previous_context, new_context, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  evo.run(docs["anchor.md"]!.id, docs["gantry-note.md"]!.id, 1, "before", "gantry evolved context", "gantry reasoning", at(5));
  evo.run(docs["anchor.md"]!.id, docs[COPIES[0]!]!.id, 2, "gantry evolved context", `${CANARY} evolved context`, `${CANARY} reasoning`, at(10));
  // The gantry note's chain (codex T9 #3): a copy's entry writes the canary into its note, and a later
  // ordinary entry carries it forward, as its previous and its new context.
  evo.run(docs["gantry-note.md"]!.id, docs[COPIES[1]!]!.id, 1, "before", `${CANARY} context`, "copy evidence", at(11));
  evo.run(docs["gantry-note.md"]!.id, docs["anchor.md"]!.id, 2, `${CANARY} context`, `${CANARY} carried forward`, "ordinary evidence", at(12));
  seedStore.db.prepare("UPDATE documents SET amem_keywords = '[\"k\"]', amem_tags = '[\"t\"]', amem_context = ? WHERE id = ?")
    .run(`${CANARY} carried forward`, docs["gantry-note.md"]!.id);

  // Path collisions for lifecycle target search (codex T10 #4): one relative path in two collections, and a
  // relative path in another collection equal to a real note's display path.
  const plain = (collection: string, path: string, body: string) => {
    const hash = hashContent(body + collection + path);
    seedStore.insertContent(hash, body, at(20));
    seedStore.insertDocument(collection, path, path, hash, at(20), at(20));
  };
  plain("agent-memory", "shared.md", "a shared name in the agent memory collection");
  plain("other", "shared.md", "a shared name in another collection");
  plain("other", "agent-memory/review-me.md", "another collection's file whose relative path is a display path");

  // The seeded history predates the upgrade, in a vault as v0.39.1 left it (no evolution `writer` column, no
  // floor): the MCP server's open below is this version's first writable open, which adds both, the floor
  // above the seeded history (codex T11 #1, T12 #1).
  seedStore.db.exec("ALTER TABLE memory_evolution DROP COLUMN writer");
  seedStore.db.prepare("DELETE FROM vault_flags WHERE flag = ?").run(EVOLUTION_WRITER_FLOOR_FLAG);

  rest = startServer(seedStore, 0, "127.0.0.1", { token: REST_TOKEN });

  const built = buildMcpServer();
  closeAllStores = built.closeAllStores;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  client = new Client({ name: "quarantine-tests", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => {
  try { rest.stop(true); } catch { /* already stopped */ }
  try { closeAllStores(); } catch { /* already closed */ }
  try { seedStore.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  delete Bun.env.INDEX_PATH;
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
  JSON.stringify(await client.callTool({ name, arguments: args }));
const hookText = (out: unknown) => JSON.stringify(out);
const restGet = async (path: string): Promise<string> =>
  (await fetch(`http://127.0.0.1:${rest.port}${path}`, { headers: AUTH })).text();
const docid = (path: string) => docs[path]!.hash.slice(0, 6);

describe("62.2 — no MCP tool or hook returns the legacy snapshot", () => {
  it("codex T7 #1: query's entity branch reaches the linked note, never a copy", async () => {
    const out = await call("query", { query: "zephyrinth project", compact: false, limit: 20 });
    expect(out).toContain("gantry-note.md");            // the entity route ran (positive control)
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain("precompact-state.md");
  });

  it("codex T7 #1: intent_search's entity expansion reaches the linked note, never a copy", async () => {
    const out = await call("intent_search", { query: "zephyrinth project", force_intent: "ENTITY", limit: 20 });
    expect(out).toContain("gantry-note.md");
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain("precompact-state.md");
  });

  for (const [tool, args] of [
    ["search", { query: "zephyrinth project", compact: false }],
    ["vsearch", { query: "zephyrinth project", compact: false }],
    ["memory_retrieve", { query: "zephyrinth project", compact: false }],
    ["memory_retrieve", { query: "who worked on the zephyrinth project", mode: "causal", compact: false }],
    ["query_plan", { query: "zephyrinth project and also the gantry rig", compact: false }],
    ["find_similar", { file: "agent-memory/anchor.md" }],
  ] as const) {
    it(`${tool}${"mode" in args ? ` (${args.mode})` : ""} never returns a copy`, async () => {
      const out = await call(tool, args);
      expect(out).not.toContain(CANARY);
      expect(out).not.toContain("precompact-state.md");
    });
  }

  it("find_causal_links from the anchor never steps onto a copy", async () => {
    const out = await call("find_causal_links", { docid: docid("anchor.md"), direction: "causes", depth: 2 });
    expect(out).toContain("gantry-note.md");
    expect(out).not.toContain("precompact-state.md");
  });

  it("codex T7 #4: timeline neighbours of an ordinary document exclude every copy; a copy named as the focus is returned", async () => {
    const around = await call("timeline", { docid: docid("anchor.md"), before: 5, after: 5 });
    expect(around).toContain("gantry-note.md");
    expect(around).not.toContain("precompact-state.md");
    const focus = await call("timeline", { docid: docid(COPIES[0]!), before: 5, after: 5 });
    expect(focus).toContain(COPIES[0]!);                  // deliberate access by docid
  });

  it("deliberate access by path still returns a copy (get)", async () => {
    const out = await call("get", { file: `agent-memory/${COPIES[1]!}` });
    expect(out).toContain(CANARY);
  });

  it("codex T7 #2: the staleness hook and session bootstrap list the due note, never a copy", async () => {
    // staleness-check's context is dropped by makeContextOutput (it has no host event mapping, as in
    // v0.39.1); what it lists is observable in the context_usage row it logs.
    await stalenessCheck(seedStore, { sessionId: "sess-stale", hookEventName: "SessionStart" } as any);
    const logged = seedStore.db.prepare("SELECT injected_paths FROM context_usage WHERE session_id = 'sess-stale' AND hook_name = 'staleness-check'").get() as { injected_paths: string };
    expect(logged.injected_paths).toContain("review-me.md");
    expect(logged.injected_paths).not.toContain("precompact-state.md");
    const boot = hookText(await sessionBootstrap(seedStore, { sessionId: "sess-boot", hookEventName: "SessionStart" } as any));
    expect(boot).not.toContain("precompact-state.md");
    expect(boot).not.toContain(CANARY);
  });

  it("codex T8 #3: multi_get by glob or suffix never returns a copy, even one spelling its name; an exact list still does", async () => {
    const broad = await call("multi_get", { pattern: "**/*.md", maxBytes: 100_000 });
    expect(broad).toContain("gantry-note.md");                          // the glob matched (positive control)
    expect(broad).not.toContain(CANARY);
    expect(broad).not.toContain("precompact-state.md");
    expect(await call("multi_get", { pattern: "**/precompact-state.md" })).not.toContain(CANARY);
    const suffixes = await call("multi_get", { pattern: "memory/precompact-state.md, anchor.md" });
    expect(suffixes).toContain("zephyrinth project anchor note");          // a suffix still resolves a real note
    expect(suffixes).not.toContain(CANARY);
    expect(await call("multi_get", { pattern: `agent-memory/${COPIES[2]!}, agent-memory/anchor.md` })).toContain(CANARY); // exact paths
  });

  it("codex T8 #3: get by suffix and its did-you-mean list never reach a copy; get by docid does", async () => {
    expect(await call("get", { file: "memory/precompact-state.md" })).not.toContain(CANARY);
    const nearMiss = await call("get", { file: "-u-fs/memory/precompact-statx.md" });
    expect(nearMiss).not.toContain("precompact-state.md");                // not suggested
    expect(await call("get", { file: `#${docid(COPIES[0]!)}` })).toContain(CANARY);
  });

  it("codex T8 #3: the clawmem:// resource resolves a copy only by its exact path", async () => {
    const read = async (uri: string) => JSON.stringify(await client.readResource({ uri }));
    expect(await read("clawmem://agent-memory/memory/precompact-state.md")).not.toContain(CANARY);
    expect(await read("clawmem://agent-memory/anchor.md")).toContain("zephyrinth project anchor note");
    expect(await read(`clawmem://agent-memory/${COPIES[2]!}`)).toContain(CANARY);
  });

  it("codex T8 #3 / T9 #5: REST multi-get by glob and the default export never return a copy (the export counts them; ?full=true includes them); REST get by docid does", async () => {
    const glob = await restGet(`/documents?pattern=${encodeURIComponent("**/*.md")}`);
    expect(glob).toContain("gantry-note.md");
    expect(glob).not.toContain(CANARY);
    const exported = await restGet("/export");
    expect(exported).toContain("anchor.md");
    expect(exported).not.toContain(CANARY);
    expect(exported).not.toContain("precompact-state.md");
    expect(JSON.parse(exported).legacy_snapshots_excluded).toBe(COPIES.length); // the omission is reported
    const full = JSON.parse(await restGet("/export?full=true"));                 // T9 #5: the explicit backup mode
    expect(full.legacy_snapshots_excluded).toBe(0);
    expect(full.documents.filter((d: { body: string }) => d.body.includes(CANARY)).length).toBe(COPIES.length);
    expect(await restGet(`/documents/${docid(COPIES[1]!)}`)).toContain(CANARY);
  });

  it("codex T8 #4: an ordinary note's evolution history never shows an entry a copy triggered (MCP and REST)", async () => {
    const mcp = await call("memory_evolution_status", { docid: docid("anchor.md") });
    expect(mcp).toContain("gantry evolved context");                    // the history is read (positive control)
    expect(mcp).not.toContain(CANARY);
    expect(mcp).not.toContain("precompact-state.md");
    const viaRest = await restGet(`/graph/evolution/${docid("anchor.md")}`);
    expect(viaRest).toContain("gantry evolved context");
    expect(viaRest).not.toContain(CANARY);
  });

  it("codex T9 #3: a note a copy shaped was reset at open, and neither its note nor its history carries the copy's text (MCP and REST)", async () => {
    // The MCP server's store opened after the seed: that open reset the gantry note.
    const note = seedStore.db.prepare("SELECT amem_keywords, amem_context FROM documents WHERE id = ?").get(docs["gantry-note.md"]!.id);
    expect(note).toEqual({ amem_keywords: null, amem_context: null });   // cleared for a rebuild from its own text
    const mcp = await call("memory_evolution_status", { docid: docid("gantry-note.md") });
    expect(mcp).toContain("reset:");                                    // the reset marker is shown
    expect(mcp).not.toContain(CANARY);                                  // the copy's entry and the one that carried it are not
    expect(await restGet(`/graph/evolution/${docid("gantry-note.md")}`)).not.toContain(CANARY);
  });

  it("codex T9 #4: lifecycle target search reaches a copy only by its exact path", async () => {
    const pinnedCopies = () => (seedStore.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE path LIKE '%/precompact-state.md' AND pinned = 1").get() as { n: number }).n;
    // A path substring, and title tokens that match the copies' title.
    for (const query of ["memory/precompact-state", "compaction state pre"]) {
      const out = await call("memory_pin", { query });
      expect(out).not.toContain("/memory/precompact-state.md");
      expect(pinnedCopies()).toBe(0);
      if (out.includes("Pinned:")) await call("memory_pin", { query, unpin: true });   // leave the shared vault as found
    }
    const exact = await call("memory_pin", { query: `agent-memory/${COPIES[2]!}` });
    expect(exact).toContain(`Pinned: agent-memory/${COPIES[2]!}`);                     // named exactly: deliberate
    await call("memory_pin", { query: `agent-memory/${COPIES[2]!}`, unpin: true });
    expect(pinnedCopies()).toBe(0);
  });

  it("codex T10 #4: an exact lifecycle path is one document: the display path first, and a relative path shared by two collections is an ambiguity", async () => {
    const pinned = () => (seedStore.db.prepare("SELECT collection || '/' || path AS p FROM documents WHERE pinned = 1 ORDER BY p").all() as { p: string }[]).map(r => r.p);
    const shared = JSON.parse(await call("memory_pin", { query: "shared.md" }));
    expect(shared.isError).toBe(true);
    expect(JSON.stringify(shared)).toContain("agent-memory/shared.md");
    expect(JSON.stringify(shared)).toContain("other/shared.md");
    expect(pinned()).toEqual([]);                                              // nothing chosen for the caller
    const display = await call("memory_pin", { query: "agent-memory/review-me.md" });
    expect(display).toContain("Pinned: agent-memory/review-me.md");            // not other/agent-memory/review-me.md
    expect(pinned()).toEqual(["agent-memory/review-me.md"]);
    await call("memory_pin", { query: "agent-memory/review-me.md", unpin: true });
    expect(pinned()).toEqual([]);
  });
});
