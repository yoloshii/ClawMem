/**
 * BACKLOG 82.3, Codex T1 S2, operator ruling 80 A — a lone UTF-16 surrogate in a normalised field.
 *
 * A JavaScript string can hold half of a surrogate pair (JSON "\ud800" from a REST or MCP client). Node's hash encodes
 * it as U+FFFD (EF BF BD), but SQLite stores it as ED A0 80 — so the hash of a body was not the hash of what was stored,
 * and Bun then reads those bytes back lossily (on Bun 1.3.14 a short value like these as an empty string, on 1.4.2 with U+FFFD). The normalisation of a free-text field (`stripLeadingMarks`,
 * and so `normalizedContent`) replaces each lone surrogate with U+FFFD before hashing and storing; a whole pair is kept.
 * `insertContent` refuses a body that is not already normalised, the length unchanged included.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createStore, saveMemory } from "../../src/store.ts";
import { normalizedContent, stripLeadingMarks } from "../../src/text-policy.ts";
import { insertContent, ContentContractError } from "../../src/content-insert.ts";
import { scanBodyHashes, describeBodyHashes } from "../../src/body-hash-check.ts";
import { openDatabase } from "../../src/sqlite-guard.ts";

const HIGH = String.fromCharCode(0xd800), LOW = String.fromCharCode(0xdc00), FFFD = String.fromCharCode(0xfffd);
const FEFF = String.fromCharCode(0xfeff);
const PAIR = String.fromCharCode(0xd83d, 0xde00);   // one whole pair: kept
const shaBytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratchStore = () => { const d = mkdtempSync(join(tmpdir(), "clawmem-80a-")); dirs.push(d); return createStore(join(d, "v.sqlite")); };

describe("80 A: lone surrogates become U+FFFD in a normalised field", () => {
  test.each([
    ["a lone high surrogate", "a" + HIGH + "b", "a" + FFFD + "b"],
    ["a lone low surrogate", "a" + LOW + "b", "a" + FFFD + "b"],
    ["one alone", HIGH, FFFD],
    ["two highs in a row", HIGH + HIGH, FFFD + FFFD],
    ["a mark, then a lone surrogate", FEFF + HIGH + "x", FFFD + "x"],
  ])("%s", (_name, input, want) => {
    expect(stripLeadingMarks(input)).toBe(want);
    expect(normalizedContent(input).body).toBe(want);
  });

  test("a whole pair, and ordinary text, are unchanged (the same string back)", () => {
    for (const s of ["x" + PAIR + "y", "plain text", "été", ""]) expect(stripLeadingMarks(s)).toBe(s);
  });

  test("normalizedContent: the hash is the hash of the bytes SQLite stores for the body", () => {
    const s = scratchStore();
    const { body, hash } = normalizedContent("note " + HIGH + " end");
    insertContent(s.db, hash, body, "2026-11-24T00:00:00.000Z");
    const raw = (s.db.prepare(`SELECT CAST(doc AS BLOB) AS b, doc AS t FROM content WHERE hash = ?`).get(hash) as { b: Uint8Array; t: string });
    expect(shaBytes(raw.b)).toBe(hash);
    expect(raw.t).toBe("note " + FFFD + " end");     // and Bun reads it back as written
    s.close();
  });

  test("insertContent refuses a body that still holds a lone surrogate, though its length is unchanged and the hash is the normalised one", () => {
    const s = scratchStore();
    const raw = "note " + HIGH;
    const { hash } = normalizedContent(raw);
    expect(() => insertContent(s.db, hash, raw, "2026-11-24T00:00:00.000Z")).toThrow(ContentContractError);
    expect((s.db.prepare(`SELECT COUNT(*) AS n FROM content`).get() as { n: number }).n).toBe(0);
    s.close();
  });

  test("saveMemory (the REST / MCP memory writer) with a lone surrogate in body and title: hash = hash of stored bytes; the doctor's check is clean", () => {
    const s = scratchStore();
    const r = saveMemory(s.db, { collection: "_clawmem", path: "memories/s2.md", title: "t " + HIGH, body: "body " + HIGH + " text", contentType: "note" });
    expect(r).toBeTruthy();
    const row = s.db.prepare(`SELECT d.title AS title, d.hash AS hash, CAST(c.doc AS BLOB) AS b FROM documents d JOIN content c ON c.hash = d.hash WHERE d.path = 'memories/s2.md'`).get() as { title: string; hash: string; b: Uint8Array };
    expect(shaBytes(row.b)).toBe(row.hash);
    expect(row.title).toBe("t " + FFFD);
    s.close();
    const ro = openDatabase(join(dirs.at(-1)!, "v.sqlite"), { readonly: true });
    try { expect(describeBodyHashes(scanBodyHashes(ro)).ok).toBe(true); expect(scanBodyHashes(ro).found).toEqual([]); } finally { ro.close(); }
  });
});

describe("80 A: the Stored-bodies check reports a mismatch without asserting its cause", () => {
  test("a mismatch neither known alteration explains is counted as other, of unknown cause — the headline names no version for it", () => {
    const s = scratchStore();
    s.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, CAST(? AS TEXT), '2026-01-01')`).run("0".repeat(64), Buffer.from("EDA080", "hex"));
    s.close();
    const ro = openDatabase(join(dirs.at(-1)!, "v.sqlite"), { readonly: true });
    try {
      const line = describeBodyHashes(scanBodyHashes(ro)).lines[0]!;
      expect(line).toContain("1 other, of unknown cause");
      expect(line).not.toMatch(/altered when a version before 0\.43\.7 stored them/);
    } finally { ro.close(); }
  });
});

describe("84 A: a write whose hash is stored with other bytes rewrites that row", () => {
  /** What an older version left for a REST/MCP body with a lone surrogate: the hash of its U+FFFD form, other bytes. */
  function legacy(text: string) {
    const s = scratchStore();
    const { body, hash } = normalizedContent(text);                        // body = the U+FFFD form
    const bad = Buffer.concat(body.split(FFFD).flatMap((part, i) => i === 0 ? [Buffer.from(part)] : [Buffer.from("EDA080", "hex"), Buffer.from(part)]));
    s.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, CAST(? AS TEXT), '2026-01-01')`).run(hash, bad);
    s.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, last_accessed_at, active, origin)
                  VALUES ('_clawmem', 'memories/old.md', 'old', ?, '2026-01-01', '2026-01-01', '2026-01-01', 1, 'api')`).run(hash);
    const oldId = (s.db.prepare(`SELECT id FROM documents WHERE path = 'memories/old.md'`).get() as { id: number }).id;
    return { s, body, hash, bad, oldId };
  }

  test("saveMemory of the same text: the row now holds the body (hash = hash of its bytes), the new memory reads it, and the OLD document's search row follows", () => {
    const { s, body, hash, bad, oldId } = legacy("note " + HIGH + " end");
    const old = s.db.prepare(`SELECT doc AS t, CAST(doc AS BLOB) AS b FROM content WHERE hash = ?`).get(hash) as { t: string; b: Uint8Array };
    expect(Buffer.from(old.b).equals(bad)).toBe(true);
    expect(old.t).not.toBe(body);   // the old row does not read as the body ("" on Bun 1.3.14, U+FFFD on 1.4.2)
    saveMemory(s.db, { collection: "_clawmem", path: "memories/new.md", title: "new", body: "note " + HIGH + " end", contentType: "note" });
    const row = s.db.prepare(`SELECT doc AS t, CAST(doc AS BLOB) AS b FROM content WHERE hash = ?`).get(hash) as { t: string; b: Uint8Array };
    expect(row.t).toBe(body);
    expect(shaBytes(row.b)).toBe(hash);
    const fts = s.db.prepare(`SELECT hex(body) AS h FROM documents_fts WHERE rowid = ?`).get(oldId) as { h: string };
    expect(fts.h).toBe(Buffer.from(body, "utf-8").toString("hex").toUpperCase());
    expect(Buffer.compare(Buffer.from(bad), Buffer.from(row.b))).not.toBe(0);
    s.close();
  });

  test("control: a hash already stored with the SAME bytes is left alone (no write)", () => {
    const s = scratchStore();
    const { body, hash } = normalizedContent("same text");
    insertContent(s.db, hash, body, "2026-01-01T00:00:00.000Z");
    s.db.exec(`CREATE TEMP TRIGGER no_update BEFORE UPDATE ON content BEGIN SELECT RAISE(ABORT, 'content was rewritten'); END`);
    expect(() => insertContent(s.db, hash, body, "2026-11-24T00:00:00.000Z")).not.toThrow();
    expect((s.db.prepare(`SELECT created_at AS c FROM content WHERE hash = ?`).get(hash) as { c: string }).c).toBe("2026-01-01T00:00:00.000Z");
    s.close();
  });
});

