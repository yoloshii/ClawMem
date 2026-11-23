/**
 * BACKLOG 82.3, Codex code-review Turn 2 — Standards 1–3, rulings 80 A and 84 A at the writers.
 *
 * 1. A save that DEDUPLICATES onto a memory whose body row an older version stored with a lone surrogate repairs that
 *    row too (84 A), not only a save that inserts.
 * 2. 84 A's rewrite and its search-row refresh are one unit: a failure between them leaves neither, and it nests in a
 *    caller's transaction.
 * 3. A normalised field truncated AFTER normalising never ends in half of a surrogate pair (80 A): the judge heads
 *    (200), the causal event detail (300) and the hook-dedupe prompt preview (120), at and around each boundary.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { createTestStore } from "../helpers/test-store.ts";
import { saveMemory } from "../../src/store.ts";
import { insertContent } from "../../src/content-insert.ts";
import { normalizedContent } from "../../src/text-policy.ts";
import { scanBodyHashes } from "../../src/body-hash-check.ts";
import { insertJudgeEvent, insertJudgeRun } from "../../src/judge-audit.ts";
import { insertCausalEvent, insertCausalRun } from "../../src/causal-writer.ts";
import { wasPromptSeenRecently } from "../../src/hooks.ts";

const HIGH = String.fromCharCode(0xd800);
const EMOJI = String.fromCharCode(0xd83d, 0xde00);          // one whole pair
const shaBytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** The bytes an older version stored for `body`: each U+FFFD written as the lone surrogate's bytes ED A0 80. */
const legacyBytes = (body: string) =>
  Buffer.concat(body.split("�").flatMap((p, i) => (i === 0 ? [Buffer.from(p)] : [Buffer.from("EDA080", "hex"), Buffer.from(p)])));
/** True when the stored TEXT reads back as exactly its bytes (well-formed UTF-8 of the string). */
const readsBack = (t: string, b: Uint8Array) => Buffer.compare(Buffer.from(t, "utf-8"), Buffer.from(b)) === 0;

describe("T2 S1: a deduplicated save repairs the body row it lands on (84 A)", () => {
  test("a dedup-eligible memory whose row holds the legacy bytes: the second save deduplicates AND rewrites the row and its search row", () => {
    const store = createTestStore();
    const text = "note " + HIGH + " end";
    const first = saveMemory(store.db, { collection: "_clawmem", path: "memories/d.md", title: "d", body: text, contentType: "note" });
    const { body, hash } = normalizedContent(text);
    store.db.prepare(`UPDATE content SET doc = CAST(? AS TEXT) WHERE hash = ?`).run(legacyBytes(body), hash);   // as an older version left it
    store.db.prepare(`UPDATE documents SET title = title WHERE path = 'memories/d.md'`).run();                // its search row follows the old bytes
    expect(scanBodyHashes(store.db).found.length).toBe(1);
    const second = saveMemory(store.db, { collection: "_clawmem", path: "memories/d2.md", title: "d", body: text, contentType: "note" });
    expect(second.action).toBe("deduplicated");
    expect(second.docId).toBe(first.docId);
    const row = store.db.prepare(`SELECT doc AS t, CAST(doc AS BLOB) AS b FROM content WHERE hash = ?`).get(hash) as { t: string; b: Uint8Array };
    expect(row.t).toBe(body);
    expect(shaBytes(row.b)).toBe(hash);
    const fts = store.db.prepare(`SELECT hex(body) AS h FROM documents_fts WHERE rowid = ?`).get(first.docId) as { h: string };
    expect(fts.h).toBe(Buffer.from(body).toString("hex").toUpperCase());
    expect(scanBodyHashes(store.db).found).toEqual([]);
    store.close();
  });
});

describe("T2 S2: 84 A's rewrite and its search-row refresh are one unit", () => {
  function legacy() {
    const store = createTestStore();
    const { body, hash } = normalizedContent("text " + HIGH + " here");
    store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, CAST(? AS TEXT), '2026-01-01')`).run(hash, legacyBytes(body));
    store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, last_accessed_at, active, origin)
                      VALUES ('_clawmem', 'memories/o.md', 'o', ?, '2026-01-01', '2026-01-01', '2026-01-01', 1, 'api')`).run(hash);
    const id = (store.db.prepare(`SELECT id FROM documents WHERE path = 'memories/o.md'`).get() as { id: number }).id;
    const state = () => JSON.stringify([
      store.db.prepare(`SELECT hex(doc) h FROM content WHERE hash = ?`).get(hash),
      store.db.prepare(`SELECT hex(body) h FROM documents_fts WHERE rowid = ?`).get(id),
    ]);
    return { store, body, hash, id, state };
  }
  /** The store's handle, with the search-row refresh failing once. */
  const failingFts = (db: Database) => new Proxy(db, {
    get(t, p) {
      if (p === "prepare") return (sql: string) => {
        if (/INSERT OR REPLACE INTO documents_fts/.test(sql)) throw new Error("injected: the refresh failed");
        return t.prepare(sql);
      };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Database;

  test("a failure at the refresh leaves the row AND the search row as they were; a retry then repairs both", () => {
    const { store, body, hash, id, state } = legacy();
    const before = state();
    expect(() => insertContent(failingFts(store.db), hash, body, "2026-11-24T00:00:00.000Z")).toThrow(/injected/);
    expect(state()).toBe(before);
    insertContent(store.db, hash, body, "2026-11-24T00:00:00.000Z");
    expect((store.db.prepare(`SELECT doc AS t FROM content WHERE hash = ?`).get(hash) as { t: string }).t).toBe(body);
    expect((store.db.prepare(`SELECT hex(body) h FROM documents_fts WHERE rowid = ?`).get(id) as { h: string }).h).toBe(Buffer.from(body).toString("hex").toUpperCase());
    store.close();
  });

  test("it nests: inside a caller's transaction that later rolls back, nothing stays; inside one that commits, both stay", () => {
    const { store, body, hash, state } = legacy();
    const before = state();
    expect(() => store.db.transaction(() => { insertContent(store.db, hash, body, "2026-11-24T00:00:00.000Z"); throw new Error("caller fails"); })()).toThrow(/caller fails/);
    expect(state()).toBe(before);
    store.db.transaction(() => insertContent(store.db, hash, body, "2026-11-24T00:00:00.000Z"))();
    expect(state()).not.toBe(before);
    expect((store.db.prepare(`SELECT doc AS t FROM content WHERE hash = ?`).get(hash) as { t: string }).t).toBe(body);
    store.close();
  });
});

describe("T2 S3: a field cut after normalising never ends in half of a pair", () => {
  test.each([
    ["judge reasoning_head / evidence_head (200)", 200],
    ["causal event detail (300)", 300],
    ["hook-dedupe prompt preview (120)", 120],
  ])("%s: at, just under and just over the boundary", (name, max) => {
    for (const pad of [max - 2, max - 1, max]) {
      const store = createTestStore();
      const value = "A".repeat(pad) + EMOJI + "tail";
      let row: { t: string; b: Uint8Array };
      if (name.startsWith("judge")) {
        const runId = insertJudgeRun(store.db, { consumer: "merge-phase2", lane: "heuristic", outcome: "ok" });
        const id = insertJudgeEvent(store.db, { runId, eventType: "verdict", reasoningHead: value, evidenceHead: value });
        row = store.db.prepare(`SELECT reasoning_head t, CAST(reasoning_head AS BLOB) b FROM judge_events WHERE id = ?`).get(id) as typeof row;
        const ev = store.db.prepare(`SELECT evidence_head t, CAST(evidence_head AS BLOB) b FROM judge_events WHERE id = ?`).get(id) as typeof row;
        expect(readsBack(ev.t, ev.b), `${name} evidence pad ${pad}`).toBe(true);
      } else if (name.startsWith("causal")) {
        const runId = insertCausalRun(store.db, { runKey: `r-${pad}`, source: "stop_hook", mode: "shadow", outcome: "in_progress" });
        insertCausalEvent(store.db, runId, { scope: "pair", eventType: "e", detail: value });
        row = store.db.prepare(`SELECT detail t, CAST(detail AS BLOB) b FROM causal_run_events WHERE run_id = ?`).get(runId) as typeof row;
      } else {
        wasPromptSeenRecently(store, "context-surfacing", value);
        row = store.db.prepare(`SELECT prompt_preview t, CAST(prompt_preview AS BLOB) b FROM hook_dedupe`).get() as typeof row;
      }
      expect(readsBack(row.t, row.b), `${name} pad ${pad}`).toBe(true);
      expect(row.t.length, `${name} pad ${pad}`).toBeLessThanOrEqual(max);
      expect(row.t.startsWith("A".repeat(Math.min(pad, max))), `${name} pad ${pad}`).toBe(true);
      if (pad + 2 <= max) expect(row.t.includes(EMOJI), `${name} pad ${pad}: a pair that fits is kept`).toBe(true);
      store.close();
    }
  });
});
