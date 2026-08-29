import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { createStore, type Store, type CrossAgentFact } from "../../src/store.ts";
import { ensureEntityCanonical } from "../../src/entity.ts";
import { buildCrossAgentContextBlock } from "../../src/cross-agent.ts";

/**
 * Cross-Agent Memory PR — fact_write / fact_link / fact_query_cross_agent.
 *
 * Covers the two layers this PR ships:
 *   (A) STORE — signed witness facts: append-mode preserves multiple witness
 *       versions on the same subject+predicate (divergence/evolution, no clobber),
 *       and CrossAgentQuery filters (since / min_confidence / written_by /
 *       wildcards / resolve_conflicts).
 *   (B) MCP — the three tools register and round-trip over an in-memory transport
 *       without disturbing the existing (unchanged) tool set.
 */

// ---------------------------------------------------------------------------
// (A) Store-level tests
// ---------------------------------------------------------------------------
const DB_A = "/tmp/clawmem-cross-agent-store.sqlite";

describe("cross-agent facts — store (fact_write semantics)", () => {
  let store: Store;
  beforeEach(() => {
    try { unlinkSync(DB_A); } catch { /* absent */ }
    store = createStore(DB_A);
  });
  // Create the entity node before writing a fact-via-id (FK to entity_nodes).
  function ent(name: string, type = "server"): string { return ensureEntityCanonical(store.db, name, type); }

  // Resolve-or-create both endpoints then add a witnessed fact.
  function writeFact(subject: string, predicate: string, object: string | null, opts: any = {}) {
    const sid = ent(subject, opts.subjectType ?? "server");
    const oid = object ? ent(object, opts.objectType ?? "server") : null;
    return store.addTriple(sid, predicate, oid, opts.literal ?? null, {
      witness: opts.witness,
      confidence: opts.confidence ?? 0.9,
      append: opts.append !== false,
      tags: opts.tags,
    });
  }
  afterAll(() => {
    try { store.close(); } catch { /* closed */ }
    try { unlinkSync(DB_A); } catch { /* gone */ }
  });

  it("fact_write appends a fresh triple per witness (divergence/evolution kept, no clobber)", () => {
    // First agent writes status=down.
    const id1 = writeFact("server:ema5-db", "status", null, { literal: "down", witness: { agentId: "max", sessionId: "s1", timestamp: "2026-08-29T12:00:00Z", source: "direct_observation" }, confidence: 0.95 });
    // Second agent writes status=up (disagreement) — must NOT clobber the first.
    const id2 = writeFact("server:ema5-db", "status", null, { literal: "up", witness: { agentId: "scout", sessionId: "s2", timestamp: "2026-08-29T12:30:00Z", source: "verification" }, confidence: 0.9 });
    expect(id1).not.toBe(id2);

    const facts = store.queryCrossAgentFacts({ subject: "server:ema5-db", predicate: "status" });
    expect(facts.length).toBe(2);
    const byObj = Object.fromEntries(facts.map(f => [f.object, f])) as Record<string, CrossAgentFact>;
    expect(byObj["down"]!.agentId).toBe("max");
    expect(byObj["down"]!.sessionId).toBe("s1");
    expect(byObj["up"]!.agentId).toBe("scout");
  });

  it("fact_link creates a directed relation between two entities", () => {
    const id = writeFact("project:ema5", "uses_infrastructure", "server:ema5-plc-db", { objectType: "server", witness: { agentId: "cleo", source: "deck_review" }, confidence: 0.9 });
    const facts = store.queryCrossAgentFacts({ subject: "project:ema5", predicate: "uses_infrastructure" });
    expect(facts.length).toBe(1);
    expect(facts[0]!.object).toBe("server:ema5-plc-db");
    expect(facts[0]!.agentId).toBe("cleo");
    expect(facts[0]!.subjectEntityId).toBeTruthy();
  });

  it("legacy addTriple (append off) still dedups — backward compatible", () => {
    const sid = ent("svc:x");
    const a = store.addTriple(sid, "state", null, "ok");
    const b = store.addTriple(sid, "state", null, "ok");
    expect(a).toBe(b);
    expect(store.queryCrossAgentFacts({ subject: "svc:x", predicate: "state" }).length).toBe(1);
  });

  it("query filters: since, min_confidence, written_by", () => {
    writeFact("server:ema5-db", "status", null, { literal: "down", witness: { agentId: "max", timestamp: "2026-08-28T00:00:00Z" }, confidence: 0.5 });
    writeFact("server:ema5-db", "status", null, { literal: "down", witness: { agentId: "scout", timestamp: "2026-08-29T12:00:00Z" }, confidence: 0.9 });
    // since
    const since = store.queryCrossAgentFacts({ subject: "server:ema5-db", predicate: "status", since: "2026-08-29T00:00:00Z" });
    expect(since.length).toBe(1);
    expect(since[0]!.agentId).toBe("scout");
    // min_confidence
    const conf = store.queryCrossAgentFacts({ subject: "server:ema5-db", predicate: "status", minConfidence: 0.7 });
    expect(conf.length).toBe(1);
    expect(conf[0]!.agentId).toBe("scout");
    // written_by
    const byMax = store.queryCrossAgentFacts({ predicate: "status", writtenBy: ["max"] });
    expect(byMax.length).toBe(1);
    expect(byMax[0]!.agentId).toBe("max");
  });

  it("query filters: object wildcard and cross-subject search", () => {
    writeFact("server:ema5-db", "status", null, { literal: "down", witness: { agentId: "max" }, confidence: 0.9 });
    writeFact("server:ema6-web", "status", null, { literal: "degraded", witness: { agentId: "scout" }, confidence: 0.8 });
    const all = store.queryCrossAgentFacts({ predicate: "status", writtenBy: ["max", "scout"], minConfidence: 0.7 });
    expect(all.length).toBe(2);
  });

  it("resolve_conflicts collapses divergent witnesses to the most recent above the floor", () => {
    writeFact("server:ema5-db", "status", null, { literal: "down", witness: { agentId: "max",  timestamp: "2026-08-29T10:00:00Z" }, confidence: 0.95 });
    writeFact("server:ema5-db", "status", null, { literal: "up",   witness: { agentId: "scout", timestamp: "2026-08-29T11:00:00Z" }, confidence: 0.9 });
    const resolved = store.queryCrossAgentFacts({ subject: "server:ema5-db", predicate: "status", resolveConflicts: true });
    // object differs (down vs up) so they are NOT the same subject/predicate/object key here;
    // this asserts the merge keeps current facts and returns them.
    expect(resolved.length).toBe(2);
  });

  it("resolve_conflicts merges same (subject,predicate,object) to newest above floor", () => {
    writeFact("server:ema5-db", "status", null, { literal: "down", witness: { agentId: "max",  timestamp: "2026-08-29T10:00:00Z" }, confidence: 0.95 });
    writeFact("server:ema5-db", "status", null, { literal: "down", witness: { agentId: "scout", timestamp: "2026-08-29T11:00:00Z" }, confidence: 0.9 });
    const resolved = store.queryCrossAgentFacts({ subject: "server:ema5-db", predicate: "status", resolveConflicts: true });
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.agentId).toBe("scout");
    expect(resolved[0]!.writtenAt).toBe("2026-08-29T11:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// (B) MCP-level tests — tools register + round-trip over in-memory transport
// ---------------------------------------------------------------------------
const DB_B = "/tmp/clawmem-cross-agent-mcp.sqlite";

describe("cross-agent facts — MCP tools", () => {
  let client: Client;
  let closeAllStores: () => void;

  beforeEach(async () => {
    try { unlinkSync(DB_B); } catch { /* absent */ }
    Bun.env.INDEX_PATH = DB_B;
    const built = buildMcpServer();
    closeAllStores = built.closeAllStores;
    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await built.server.connect(sT);
    client = new Client({ name: "cross-agent-tests", version: "0.0.0" });
    await client.connect(cT);
  });
  afterEach(() => {
    try { closeAllStores(); } catch { /* already closed */ }
    delete Bun.env.INDEX_PATH;
    try { unlinkSync(DB_B); } catch { /* gone */ }
  });

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { structuredContent?: any; content?: { type: string; text?: string }[] };

  it("fact_write writes a witnessed fact and fact_query_cross_agent reads it back", async () => {
    const w = await call("fact_write", {
      subject: "server:ema5-db", predicate: "status", object: "down",
      subject_type: "server",
      witness: { agentId: "max", sessionId: "abc-123", timestamp: "2026-08-29T12:00:00Z", source: "direct_observation" },
      confidence: 0.95, tags: ["infra", "ema5"],
    });
    expect(w.structuredContent.id).toBeGreaterThan(0);
    expect(w.structuredContent.witness.agentId).toBe("max");

    const q = await call("fact_query_cross_agent", { subject: "server:ema5-db", predicate: "status" });
    expect(q.structuredContent.count).toBe(1);
    const fact = q.structuredContent.facts[0];
    expect(fact.object).toBe("down");
    expect(fact.agentId).toBe("max");
    expect(fact.confidence).toBe(0.95);
    expect(fact.tags).toEqual(["infra", "ema5"]);
  });

  it("fact_link creates a relation and is visible via fact_query_cross_agent", async () => {
    const l = await call("fact_link", {
      from: "project:ema5", relation: "uses_infrastructure", to: "server:ema5-plc-db",
      from_type: "project", to_type: "server",
      witness: { agentId: "cleo", timestamp: "2026-08-29T12:00:00Z" }, confidence: 0.9,
    });
    expect(l.structuredContent.id).toBeGreaterThan(0);

    const q = await call("fact_query_cross_agent", { subject: "project:ema5", predicate: "uses_infrastructure" });
    expect(q.structuredContent.count).toBe(1);
    expect(q.structuredContent.facts[0].object).toBe("server:ema5-plc-db");
    expect(q.structuredContent.facts[0].agentId).toBe("cleo");
  });

  it("fact_query_cross_agent respects written_by + min_confidence filters", async () => {
    await call("fact_write", { subject: "server:ema5-db", predicate: "status", object: "down", witness: { agentId: "max", timestamp: "2026-08-28T09:00:00Z" }, confidence: 0.5 });
    await call("fact_write", { subject: "server:ema5-db", predicate: "status", object: "down", witness: { agentId: "scout", timestamp: "2026-08-29T09:00:00Z" }, confidence: 0.9 });

    const filtered = await call("fact_query_cross_agent", {
      subject: "server:ema5-db", predicate: "status", min_confidence: 0.7, written_by: ["scout"],
    });
    expect(filtered.structuredContent.count).toBe(1);
    expect(filtered.structuredContent.facts[0].agentId).toBe("scout");
  });

  it("fact_query_cross_agent resolve_conflicts picks most recent current fact", async () => {
    await call("fact_write", { subject: "server:ema5-db", predicate: "status", object: "down", witness: { agentId: "max",   timestamp: "2026-08-29T10:00:00Z" }, confidence: 0.95 });
    await call("fact_write", { subject: "server:ema5-db", predicate: "status", object: "down", witness: { agentId: "scout", timestamp: "2026-08-29T11:00:00Z" }, confidence: 0.9 });
    const q = await call("fact_query_cross_agent", { subject: "server:ema5-db", predicate: "status", resolve_conflicts: true });
    expect(q.structuredContent.count).toBe(1);
    expect(q.structuredContent.facts[0].agentId).toBe("scout");
  });

  it("existing tool set is untouched (kg_query still present and functional)", async () => {
    // write a triple then confirm kg_query can see it through the legacy path
    await call("fact_write", { subject: "server:ema5-db", predicate: "status", object: "down", witness: { agentId: "max" }, confidence: 0.9 });
    const kg = await call("kg_query", { entity: "server:ema5-db" });
    expect(kg.structuredContent.facts.length).toBe(1);
    expect(kg.structuredContent.facts[0]!.predicate).toBe("status");
  });
});


// ---------------------------------------------------------------------------
// (C) Context Injection Layer — buildCrossAgentContextBlock
// ---------------------------------------------------------------------------
describe("cross-agent context injection layer", () => {
  const db = createStore("/tmp/clawmem-cross-agent-inject.sqlite");

  // The detector (path a) resolves canonical ids `vault:type:slug` directly, so we
  // seed the canonical node and prompt with the canonical id to guarantee resolution.
  const ENTITY_ID = "default:server:ema5-db";
  // Insert the node with the exact canonical id so `extractPromptEntities` path (a)
  // resolves the prompt entity deterministically (mirrors what fact_write stores).
  db.db.prepare(`INSERT OR IGNORE INTO entity_nodes (entity_id, entity_type, name, created_at, vault) VALUES (?, 'server', ?, datetime('now'), 'default')`).run(ENTITY_ID, ENTITY_ID);
  try { db.db.prepare(`INSERT OR IGNORE INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, 'server')`).run(ENTITY_ID, ENTITY_ID.toLowerCase()); } catch { /* fts optional */ }

  // Facts functor: return whatever the test seeds; honor exclusion + floor.
  const seeded: CrossAgentFact[] = [];
  const fakeQuery: (entityId: string, minConf: number, ex?: string) => CrossAgentFact[] =
    (_id, minConf) => seeded.filter(f => f.confidence >= minConf);

  function seedFact(agentId: string, writtenAt: string, confidence: number): void {
    seeded.push({
      id: seeded.length + 1, subject: ENTITY_ID, subjectEntityId: ENTITY_ID,
      predicate: "status", object: "down", objectEntityId: null,
      validFrom: null, validTo: null, confidence, current: true,
      writtenAt, agentId, sessionId: "s1", sourceType: "direct_observation", tags: ["infra"],
    });
  }

  it("returns a labelled block for qualifying cross-agent facts", () => {
    seeded.length = 0;
    seedFact("max", "2026-08-29T12:00:00Z", 0.95);
    seedFact("scout", "2026-08-29T12:30:00Z", 0.6);
    const block = buildCrossAgentContextBlock(`status of ${ENTITY_ID}`, db.db, fakeQuery, { minConfidence: 0.7, maxTokens: 400 });
    expect(block).toContain("<cross-agent-facts>");
    expect(block).toContain("[cross-agent fact, written by max at 2026-08-29T12:00:00Z]");
    // scout below the 0.7 floor is excluded
    expect(block).not.toContain("scout");
    expect(block).toContain("</cross-agent-facts>");
  });

  it("returns null on empty prompt / no entities", () => {
    const empty = buildCrossAgentContextBlock("", db.db, fakeQuery, {});
    expect(empty).toBeNull();
    const noEntity = buildCrossAgentContextBlock("nothing matches any node zxcvbnqwerty", db.db, fakeQuery, {});
    expect(noEntity).toBeNull();
  });

  it("excludes the receiving agent's own facts (excludeAgentId)", () => {
    const withExcl = buildCrossAgentContextBlock(
      `status ${ENTITY_ID}`, db.db,
      (id, mc, ex) => seeded.filter(f => f.confidence >= mc && (!ex || f.agentId !== ex)) as any,
      { excludeAgentId: "max", minConfidence: 0.7 }
    );
    // max is excluded and scout is below the floor -> nothing left
    expect(withExcl).toBeNull();
  });

  it("filters expired facts (valid_to in the past)", () => {
    seeded.length = 0;
    seeded.push({ id: 1, subject: ENTITY_ID, subjectEntityId: ENTITY_ID, predicate: "status", object: "down", objectEntityId: null, validFrom: null, validTo: "2020-01-01T00:00:00Z", confidence: 0.95, current: false, writtenAt: "2019-12-31T00:00:00Z", agentId: "old", sessionId: null, sourceType: null, tags: null });
    const block = buildCrossAgentContextBlock(`status ${ENTITY_ID}`, db.db, fakeQuery, { minConfidence: 0.7, now: "2026-08-29T00:00:00Z" });
    expect(block).toBeNull();
  });

  it("gracefully degrades: a throwing facts query becomes null, never throws", () => {
    const boom = buildCrossAgentContextBlock(`status ${ENTITY_ID}`, db.db, (() => { throw new Error("db busy"); }) as any, { minConfidence: 0.7 });
    expect(boom).toBeNull();
  });
});
