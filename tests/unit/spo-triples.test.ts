import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createStore, type Store } from "../../src/store.ts";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

const TEST_DB = join(tmpdir(), `clawmem-spo-test-${Date.now()}.sqlite`);
let store: Store;

beforeEach(() => {
  try { rmSync(TEST_DB); } catch {}
  store = createStore(TEST_DB);
});

afterAll(() => {
  store?.close();
  try { rmSync(TEST_DB); } catch {}
});

// ─── addTriple ─────────────────────────────────────────────────────

describe("addTriple", () => {
  it("inserts a basic entity triple", () => {
    // Create subject and object entities first
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("clawmem", "ClawMem", "project", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("sqlite", "SQLite", "technology", new Date().toISOString());

    const id = store.addTriple("clawmem", "uses", "sqlite", null);
    expect(id).toBeGreaterThan(0);

    const stats = store.getTripleStats();
    expect(stats.totalTriples).toBe(1);
    expect(stats.currentFacts).toBe(1);
  });

  it("inserts a literal triple", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("user", "user", "person", new Date().toISOString());

    const id = store.addTriple("user", "prefers", null, "single PRs for refactors");
    expect(id).toBeGreaterThan(0);
  });

  it("deduplicates identical entity triples", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("b", "B", "auto", new Date().toISOString());

    const id1 = store.addTriple("a", "depends on", "b", null);
    const id2 = store.addTriple("a", "depends on", "b", null);
    expect(id1).toBe(id2); // same triple returned
    expect(store.getTripleStats().totalTriples).toBe(1);
  });

  it("deduplicates identical literal triples", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("user", "user", "person", new Date().toISOString());

    const id1 = store.addTriple("user", "prefers", null, "dark mode");
    const id2 = store.addTriple("user", "prefers", null, "dark mode");
    expect(id1).toBe(id2);
    expect(store.getTripleStats().totalTriples).toBe(1);
  });

  it("does NOT dedup entity vs literal with same string", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("x", "X", "auto", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("foo", "foo", "auto", new Date().toISOString());

    const id1 = store.addTriple("x", "uses", "foo", null);       // entity
    const id2 = store.addTriple("x", "uses", null, "foo");       // literal
    expect(id1).not.toBe(id2);
    expect(store.getTripleStats().totalTriples).toBe(2);
  });

  it("normalizes predicate to lowercase with underscores", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());
    store.addTriple("a", "Switched To", null, "some tool");

    const triples = store.queryEntityTriples("a");
    expect(triples[0]!.predicate).toBe("switched_to");
  });
});

// ─── invalidateTriple ──────────────────────────────────────────────

describe("invalidateTriple", () => {
  it("invalidates entity triple", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("b", "B", "auto", new Date().toISOString());

    store.addTriple("a", "uses", "b", null);
    const changed = store.invalidateTriple("a", "uses", "b", null, "2026-04-08");
    expect(changed).toBe(1);
    expect(store.getTripleStats().currentFacts).toBe(0);
    expect(store.getTripleStats().expiredFacts).toBe(1);
  });

  it("invalidates literal triple", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("user", "user", "person", new Date().toISOString());

    store.addTriple("user", "prefers", null, "vim keybindings");
    const changed = store.invalidateTriple("user", "prefers", null, "vim keybindings", "2026-04-08");
    expect(changed).toBe(1);
    expect(store.getTripleStats().currentFacts).toBe(0);
  });

  it("does not invalidate entity triple when literal is specified", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("b", "B", "auto", new Date().toISOString());

    store.addTriple("a", "uses", "b", null); // entity triple
    const changed = store.invalidateTriple("a", "uses", null, "b", "2026-04-08"); // try literal
    expect(changed).toBe(0); // should not match
    expect(store.getTripleStats().currentFacts).toBe(1);
  });
});

// ─── queryEntityTriples ────────────────────────────────────────────

describe("queryEntityTriples", () => {
  it("returns outgoing triples", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("b", "B", "auto", new Date().toISOString());

    store.addTriple("a", "uses", "b", null);
    const results = store.queryEntityTriples("a", { direction: "outgoing" });
    expect(results).toHaveLength(1);
    expect(results[0]!.direction).toBe("outgoing");
    expect(results[0]!.predicate).toBe("uses");
  });

  it("returns incoming triples", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("b", "B", "auto", new Date().toISOString());

    store.addTriple("a", "uses", "b", null);
    const results = store.queryEntityTriples("b", { direction: "incoming" });
    expect(results).toHaveLength(1);
    expect(results[0]!.direction).toBe("incoming");
  });

  it("filters by as_of date", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("x", "X", "auto", new Date().toISOString());

    store.addTriple("x", "uses", null, "postgres", { validFrom: "2025-01-01", validTo: "2025-12-31" });
    store.addTriple("x", "uses", null, "sqlite", { validFrom: "2026-01-01" });

    const results2025 = store.queryEntityTriples("x", { asOf: "2025-06-01" });
    expect(results2025).toHaveLength(1);
    expect(results2025[0]!.object).toBe("postgres");

    const results2026 = store.queryEntityTriples("x", { asOf: "2026-06-01" });
    expect(results2026).toHaveLength(1);
    expect(results2026[0]!.object).toBe("sqlite");
  });

  it("returns both directions by default", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("b", "B", "auto", new Date().toISOString());

    store.addTriple("a", "uses", "b", null);
    store.addTriple("b", "needs", "a", null);

    const results = store.queryEntityTriples("a");
    expect(results).toHaveLength(2);
    const directions = results.map(r => r.direction).sort();
    expect(directions).toEqual(["incoming", "outgoing"]);
  });
});

// ─── getTripleStats ────────────────────────────────────────────────

describe("getTripleStats", () => {
  it("returns correct counts", () => {
    store.db.prepare("INSERT INTO entity_nodes (entity_id, name, entity_type, created_at) VALUES (?, ?, ?, ?)").run("a", "A", "auto", new Date().toISOString());

    store.addTriple("a", "uses", null, "X");
    store.addTriple("a", "needs", null, "Y");
    store.addTriple("a", "chose", null, "Z", { validTo: "2025-01-01" }); // expired

    const stats = store.getTripleStats();
    expect(stats.totalTriples).toBe(3);
    expect(stats.currentFacts).toBe(2);
    expect(stats.expiredFacts).toBe(1);
    expect(stats.predicateTypes).toContain("uses");
    expect(stats.predicateTypes).toContain("needs");
    expect(stats.predicateTypes).toContain("chose");
  });
});
