/**
 * SPO Extraction Pipeline Tests
 *
 * Covers the BACKLOG.md §1.6 fix stack:
 * - Observer-emitted <triples> parsing in parseObservationXml
 * - Placeholder filtering (Bug 4) in parseObservationXml
 * - Canonical entity ID resolution via ensureEntityCanonical (ID namespace bug)
 * - Ambiguity-safe type inheritance via resolveEntityTypeExact
 * - Literal predicate handling for prefers/avoids
 * - entity_type='auto' never written via the new path (Bug 3)
 * - source_doc_id provenance on addTriple (missing-sourceDocId bug)
 *
 * Complements spo-triples.test.ts (which tests store.addTriple DAL directly).
 * This file tests the NEW population pipeline: observer → parser → entity
 * resolution → addTriple.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createTestStore, seedDocuments } from "../helpers/test-store.ts";
import type { Store } from "../../src/store.ts";
import {
  parseObservationXml,
  VALID_PREDICATES,
  LITERAL_PREDICATES,
} from "../../src/observer.ts";
import {
  ensureEntityCanonical,
  resolveEntityTypeExact,
  upsertEntity,
} from "../../src/entity.ts";
import { persistObservationDoc } from "../../src/hooks/decision-extractor.ts";
import type { Observation } from "../../src/observer.ts";

let store: Store;

beforeEach(() => {
  store = createTestStore();
});

// =============================================================================
// Parser — triple extraction
// =============================================================================

describe("parseObservationXml — triple extraction", () => {
  it("parses a valid triple with canonical predicate", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Deployed ClawMem to VM 202</title>
        <facts>
          <fact>ClawMem now runs on VM 202</fact>
        </facts>
        <triples>
          <triple>
            <subject>ClawMem</subject>
            <predicate>deployed_to</predicate>
            <object>VM 202</object>
          </triple>
        </triples>
        <narrative>Deployed v0.8.4 to prod.</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).not.toBeNull();
    expect(obs!.triples).toBeDefined();
    expect(obs!.triples).toHaveLength(1);
    expect(obs!.triples![0]!.subject).toBe("ClawMem");
    expect(obs!.triples![0]!.predicate).toBe("deployed_to");
    expect(obs!.triples![0]!.object).toBe("VM 202");
  });

  it("rejects triples with unknown predicates", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts><fact>some real fact worth keeping</fact></facts>
        <triples>
          <triple>
            <subject>ClawMem</subject>
            <predicate>frobulates</predicate>
            <object>VM 202</object>
          </triple>
        </triples>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).not.toBeNull();
    expect(obs!.triples).toBeUndefined();
  });

  it("rejects triples missing subject/predicate/object", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts><fact>some real fact worth keeping</fact></facts>
        <triples>
          <triple><subject>ClawMem</subject><predicate>uses</predicate></triple>
          <triple><predicate>uses</predicate><object>Bun</object></triple>
          <triple><subject>A</subject><object>B</object></triple>
        </triples>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).not.toBeNull();
    expect(obs!.triples).toBeUndefined();
  });

  it("rejects oversized subject/object", () => {
    const oversize = "x".repeat(200);
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts><fact>some real fact worth keeping</fact></facts>
        <triples>
          <triple>
            <subject>${oversize}</subject>
            <predicate>uses</predicate>
            <object>Bun</object>
          </triple>
        </triples>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.triples).toBeUndefined();
  });

  it("rejects placeholder-like subjects/objects", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts><fact>some real fact worth keeping</fact></facts>
        <triples>
          <triple>
            <subject>{{canonical entity name}}</subject>
            <predicate>uses</predicate>
            <object>Bun</object>
          </triple>
          <triple>
            <subject>ClawMem</subject>
            <predicate>uses</predicate>
            <object>canonical entity name</object>
          </triple>
        </triples>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.triples).toBeUndefined();
  });

  it("caps triples at 5 per observation", () => {
    const tripleBlocks = Array.from({ length: 10 }, (_, i) =>
      `<triple><subject>Sub${i}</subject><predicate>uses</predicate><object>Obj${i}</object></triple>`
    ).join("\n");
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts><fact>some real fact worth keeping</fact></facts>
        <triples>${tripleBlocks}</triples>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.triples).toHaveLength(5);
  });

  it("returns undefined triples when the block is absent", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>No triples here</title>
        <facts><fact>some real fact worth keeping</fact></facts>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.triples).toBeUndefined();
  });

  it("lowercases and normalizes predicate whitespace", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts><fact>some real fact worth keeping</fact></facts>
        <triples>
          <triple>
            <subject>ClawMem</subject>
            <predicate>DEPLOYED_TO</predicate>
            <object>VM 202</object>
          </triple>
        </triples>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.triples![0]!.predicate).toBe("deployed_to");
  });
});

// =============================================================================
// Parser — placeholder filtering (Bug 4 regression)
// =============================================================================

describe("parseObservationXml — placeholder filtering", () => {
  it("filters 'Individual atomic fact' from facts", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Some real title</title>
        <facts>
          <fact>Individual atomic fact</fact>
          <fact>A real fact about the system</fact>
        </facts>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.facts).toEqual(["A real fact about the system"]);
  });

  it("filters 'atomic fact' and 'one atomic claim per fact element'", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts>
          <fact>atomic fact</fact>
          <fact>one atomic claim per fact element</fact>
          <fact>A real claim about the system</fact>
        </facts>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.facts).toEqual(["A real claim about the system"]);
  });

  it("filters template placeholder shapes via regex", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts>
          <fact>{{some template placeholder}}</fact>
          <fact>&lt;!-- fill this in --&gt;</fact>
          <fact>\${VAR_NAME}</fact>
          <fact>Real content here matters</fact>
        </facts>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.facts).toContain("Real content here matters");
    expect(obs!.facts.some(f => f.includes("template placeholder"))).toBe(false);
    expect(obs!.facts.some(f => f.includes("<!--"))).toBe(false);
    expect(obs!.facts.some(f => f.startsWith("${"))).toBe(false);
  });

  it("preserves legitimate facts that START with 'Example:' (Codex Turn 3 false-positive fix)", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Real title</title>
        <facts>
          <fact>Example: QMD switched to Bun in v0.2</fact>
          <fact>placeholder: this is just ambiguous prose</fact>
        </facts>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs!.facts).toContain("Example: QMD switched to Bun in v0.2");
    expect(obs!.facts).toContain("placeholder: this is just ambiguous prose");
  });

  it("rejects an observation whose title is a placeholder", () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>brief descriptive title</title>
        <facts><fact>A real fact worth keeping</fact></facts>
        <narrative>...</narrative>
      </observation>
    `;
    const obs = parseObservationXml(xml);
    expect(obs).toBeNull();
  });
});

// =============================================================================
// Predicate vocabulary sanity
// =============================================================================

describe("VALID_PREDICATES vocabulary", () => {
  it("contains the tightened Codex-recommended core set", () => {
    const core = [
      "adopted", "migrated_to",
      "deployed_to", "runs_on",
      "replaced",
      "depends_on", "integrates_with", "uses",
      "prefers", "avoids",
      "caused_by", "resolved_by",
      "owned_by",
    ];
    for (const p of core) {
      expect(VALID_PREDICATES.has(p)).toBe(true);
    }
  });

  it("does not include predicates dropped in Codex Turn 2 review", () => {
    const dropped = [
      "chose", "selected", "switched_to", "installed_on", "hosted_on",
      "superseded", "deprecated", "connects_to", "led_to",
      "maintained_by", "contributed_by",
    ];
    for (const p of dropped) {
      expect(VALID_PREDICATES.has(p)).toBe(false);
    }
  });

  it("marks prefers/avoids as literal-object predicates", () => {
    expect(LITERAL_PREDICATES.has("prefers")).toBe(true);
    expect(LITERAL_PREDICATES.has("avoids")).toBe(true);
    expect(LITERAL_PREDICATES.has("deployed_to")).toBe(false);
    expect(LITERAL_PREDICATES.has("uses")).toBe(false);
  });
});

// =============================================================================
// Entity resolution — ensureEntityCanonical
// =============================================================================

describe("ensureEntityCanonical", () => {
  it("creates a new canonical vault:type:slug entity when none exists", () => {
    const id = ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    expect(id).toBe("default:project:clawmem");
  });

  it("does not bump mention_count (distinct from upsertEntity)", () => {
    ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    ensureEntityCanonical(store.db, "ClawMem", "project", "default");

    const row = store.db.prepare(
      "SELECT mention_count FROM entity_nodes WHERE entity_id = ?"
    ).get("default:project:clawmem") as { mention_count: number };
    expect(row.mention_count).toBe(0);
  });

  it("reuses an existing canonical entity via resolveEntityCanonical", () => {
    const id1 = upsertEntity(store.db, "ClawMem", "project", "default");
    const id2 = ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    expect(id2).toBe(id1);
  });

  it("does not inflate mention_count on existing entities", () => {
    upsertEntity(store.db, "ClawMem", "project", "default");
    const before = store.db.prepare(
      "SELECT mention_count FROM entity_nodes WHERE entity_id = ?"
    ).get("default:project:clawmem") as { mention_count: number };

    ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    ensureEntityCanonical(store.db, "ClawMem", "project", "default");

    const after = store.db.prepare(
      "SELECT mention_count FROM entity_nodes WHERE entity_id = ?"
    ).get("default:project:clawmem") as { mention_count: number };

    expect(after.mention_count).toBe(before.mention_count);
  });

  it("creates entities that never have entity_type='auto'", () => {
    ensureEntityCanonical(store.db, "ClawMem", "concept", "default");
    ensureEntityCanonical(store.db, "VM 202", "service", "default");
    ensureEntityCanonical(store.db, "Bun", "tool", "default");

    const autoRows = store.db.prepare(
      "SELECT COUNT(*) as n FROM entity_nodes WHERE entity_type = 'auto'"
    ).get() as { n: number };
    expect(autoRows.n).toBe(0);
  });

  it("scopes by vault — different vaults get different canonical IDs", () => {
    const id1 = ensureEntityCanonical(store.db, "ClawMem", "project", "vault-a");
    const id2 = ensureEntityCanonical(store.db, "ClawMem", "project", "vault-b");
    expect(id1).toBe("vault-a:project:clawmem");
    expect(id2).toBe("vault-b:project:clawmem");
    expect(id1).not.toBe(id2);
  });
});

// =============================================================================
// Entity resolution — resolveEntityTypeExact (ambiguity-safe)
// =============================================================================

describe("resolveEntityTypeExact", () => {
  it("returns the type when exactly one active entity shares the name", () => {
    upsertEntity(store.db, "ClawMem", "project", "default");
    expect(resolveEntityTypeExact(store.db, "ClawMem", "default")).toBe("project");
  });

  it("is case-insensitive on name lookup", () => {
    upsertEntity(store.db, "ClawMem", "project", "default");
    expect(resolveEntityTypeExact(store.db, "clawmem", "default")).toBe("project");
    expect(resolveEntityTypeExact(store.db, "CLAWMEM", "default")).toBe("project");
  });

  it("returns null when no match exists", () => {
    expect(resolveEntityTypeExact(store.db, "Unknown", "default")).toBeNull();
  });

  it("returns null on ambiguous multi-type match (safety net)", () => {
    // Insert two entities with the same display name but different types, simulating
    // the cross-bucket ambiguity case the safety net is designed to catch.
    store.db.prepare(`
      INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
      VALUES (?, ?, ?, datetime('now'), 0, datetime('now'), 'default')
    `).run("default:person:alice", "person", "Alice");
    store.db.prepare(`
      INSERT INTO entity_nodes (entity_id, entity_type, name, created_at, mention_count, last_seen, vault)
      VALUES (?, ?, ?, datetime('now'), 0, datetime('now'), 'default')
    `).run("default:project:alice", "project", "Alice");

    expect(resolveEntityTypeExact(store.db, "Alice", "default")).toBeNull();
  });

  it("scopes by vault — same name in a different vault does not leak", () => {
    upsertEntity(store.db, "ClawMem", "project", "vault-a");
    expect(resolveEntityTypeExact(store.db, "ClawMem", "vault-b")).toBeNull();
  });
});

// =============================================================================
// End-to-end: canonical entity resolution → addTriple → queryEntityTriples
// =============================================================================

describe("end-to-end triple insertion via canonical IDs", () => {
  it("inserts a triple with canonical subject/object IDs", () => {
    const ids = seedDocuments(store, [
      { path: "observations/test-1.md", title: "Test obs", body: "Test body" },
    ]);
    const docId = ids[0]!;
    const subjectId = ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    const objectId = ensureEntityCanonical(store.db, "Bun", "tool", "default");

    store.addTriple(subjectId, "depends_on", objectId, null, {
      confidence: 0.9,
      sourceFact: "ClawMem depends_on Bun",
      sourceDocId: docId,
    });

    const triples = store.db.prepare(
      "SELECT * FROM entity_triples"
    ).all() as any[];
    expect(triples).toHaveLength(1);
    expect(triples[0].subject_entity_id).toBe("default:project:clawmem");
    expect(triples[0].object_entity_id).toBe("default:tool:bun");
    expect(triples[0].predicate).toBe("depends_on");
    expect(triples[0].source_doc_id).toBe(docId);
    expect(triples[0].source_fact).toBe("ClawMem depends_on Bun");
  });

  it("stores literal object for prefers/avoids predicates", () => {
    const ids = seedDocuments(store, [
      { path: "observations/test-2.md", title: "Test obs", body: "Test body" },
    ]);
    const docId = ids[0]!;
    const subjectId = ensureEntityCanonical(store.db, "user", "person", "default");

    store.addTriple(subjectId, "prefers", null, "single PRs for refactors", {
      confidence: 0.9,
      sourceFact: "user prefers single PRs for refactors",
      sourceDocId: docId,
    });

    const row = store.db.prepare(
      "SELECT * FROM entity_triples WHERE predicate = 'prefers'"
    ).get() as any;
    expect(row.object_entity_id).toBeNull();
    expect(row.object_literal).toBe("single PRs for refactors");
  });

  it("queryEntityTriples returns triples inserted via canonical IDs", () => {
    const ids = seedDocuments(store, [
      { path: "observations/test-3.md", title: "Test obs", body: "Test body" },
    ]);
    const docId = ids[0]!;
    const subjectId = ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    const objectId = ensureEntityCanonical(store.db, "Bun", "tool", "default");

    store.addTriple(subjectId, "depends_on", objectId, null, {
      confidence: 0.9,
      sourceDocId: docId,
    });

    const triples = store.queryEntityTriples("default:project:clawmem");
    expect(triples).toHaveLength(1);
    expect(triples[0]!.predicate).toBe("depends_on");
  });

  it("never writes entity_type='auto' via the ensure path", () => {
    ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    ensureEntityCanonical(store.db, "Bun", "tool", "default");
    ensureEntityCanonical(store.db, "VM 202", "service", "default");

    const autoRows = store.db.prepare(
      "SELECT COUNT(*) as n FROM entity_nodes WHERE entity_type = 'auto'"
    ).get() as { n: number };
    expect(autoRows.n).toBe(0);
  });

  it("provenance: addTriple stores sourceDocId end-to-end", () => {
    const ids = seedDocuments(store, [
      { path: "observations/test-4.md", title: "Test obs", body: "Test body" },
    ]);
    const docId = ids[0]!;
    const subjectId = ensureEntityCanonical(store.db, "ClawMem", "project", "default");
    const objectId = ensureEntityCanonical(store.db, "Bun", "tool", "default");

    store.addTriple(subjectId, "uses", objectId, null, {
      confidence: 0.9,
      sourceFact: "ClawMem uses Bun",
      sourceDocId: docId,
    });

    const row = store.db.prepare(
      "SELECT source_doc_id FROM entity_triples WHERE predicate = 'uses'"
    ).get() as { source_doc_id: number };
    expect(row.source_doc_id).toBe(docId);
  });
});

// =============================================================================
// persistObservationDoc — Codex Turn 3 HIGH fix
// Multiple observations of the same type in one session must not collide on
// filename. Prior to the fix, the path was `${date}-${session}-${type}.md`
// and the 2nd+ `insertDocument()` threw on UNIQUE(collection, path), was
// silently caught, and the observation's triples never reached `entity_triples`.
// =============================================================================

describe("persistObservationDoc — multi-observation same-type collision", () => {
  function makeObservation(overrides: Partial<Observation> & { title: string; facts: string[] }): Observation {
    return {
      type: overrides.type ?? "discovery",
      title: overrides.title,
      facts: overrides.facts,
      narrative: overrides.narrative ?? "",
      concepts: overrides.concepts ?? [],
      filesRead: overrides.filesRead ?? [],
      filesModified: overrides.filesModified ?? [],
      triples: overrides.triples,
    };
  }

  it("persists two different `discovery` observations in the same session without collision", () => {
    const sessionId = "abc12345-0000-0000-0000-000000000000";
    const dateStr = "2026-04-13";
    const timestamp = "2026-04-13T10:00:00.000Z";

    const obs1 = makeObservation({
      title: "Observed A",
      facts: ["Fact about A"],
      narrative: "First discovery of the session.",
      triples: [{ subject: "ClawMem", predicate: "depends_on", object: "Bun" }],
    });
    const obs2 = makeObservation({
      title: "Observed B",
      facts: ["Fact about B"],
      narrative: "Second discovery of the session — different content.",
      triples: [{ subject: "ClawMem", predicate: "uses", object: "SQLite" }],
    });

    const wit1 = persistObservationDoc(store, obs1, sessionId, dateStr, timestamp);
    const wit2 = persistObservationDoc(store, obs2, sessionId, dateStr, timestamp);

    expect(wit1).not.toBeNull();
    expect(wit2).not.toBeNull();
    expect(wit1!.docId).not.toBe(wit2!.docId);

    const rows = store.db.prepare(
      "SELECT path FROM documents WHERE collection = '_clawmem' AND active = 1 ORDER BY path"
    ).all() as Array<{ path: string }>;
    expect(rows).toHaveLength(2);
    const paths = rows.map(r => r.path);
    expect(paths[0]).not.toBe(paths[1]);
    for (const p of paths) {
      expect(p).toMatch(/^observations\/2026-04-13-abc12345-discovery-[a-f0-9]{8}\.md$/);
    }
  });

  it("two identical observations converge on the same path (idempotent)", () => {
    const sessionId = "deadbeef-0000-0000-0000-000000000000";
    const dateStr = "2026-04-13";
    const timestamp = "2026-04-13T10:00:00.000Z";

    const obs = makeObservation({ title: "Same", facts: ["Same fact"] });
    const wit1 = persistObservationDoc(store, obs, sessionId, dateStr, timestamp);
    const wit2 = persistObservationDoc(store, obs, sessionId, dateStr, timestamp);

    expect(wit1).not.toBeNull();
    expect(wit2).toBeNull();

    const rows = store.db.prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE collection = '_clawmem' AND active = 1"
    ).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("returns null when an observation has no facts", () => {
    const sessionId = "cafed00d-0000-0000-0000-000000000000";
    const dateStr = "2026-04-13";
    const timestamp = "2026-04-13T10:00:00.000Z";

    const obs = makeObservation({ title: "Empty", facts: [] });
    const wit = persistObservationDoc(store, obs, sessionId, dateStr, timestamp);
    expect(wit).toBeNull();
  });
});
