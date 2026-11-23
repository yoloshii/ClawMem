/**
 * BACKLOG 82.3, operator ruling 74 A — the doctor's "Stored bodies" check.
 *
 * Older versions hashed a body WITH its leading byte-order mark and stored it through the string binding, which
 * altered it: a U+FEFF was dropped; after a U+FFFE every code unit was stored byte-swapped. Every writer hashes exactly
 * what it stores, so such a row is the one whose hash is not the hash of its text. The check finds those rows, names
 * the pattern, and lists the documents that hold each; it fails only while an ACTIVE document holds one.
 * No mark is typed into this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { createStore } from "../../src/store.ts";
import { describeBodyHashes, scanBodyHashes } from "../../src/body-hash-check.ts";

const FEFF = String.fromCharCode(0xfeff), FFFE = String.fromCharCode(0xfffe);
const sha = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
const swapped = (text: string) => [...text].map(ch => { const c = ch.charCodeAt(0); return String.fromCharCode(((c & 0xff) << 8) | (c >> 8)); }).join("");
const TEXT = "BODYTEXT the pump is primed monthly.";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function vault(): { path: string; raw: (fn: (db: Database) => void) => void } {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-bodyhash-")); dirs.push(dir);
  const path = join(dir, "v.sqlite");
  createStore(path).close();
  return { path, raw: fn => { const db = new Database(path); try { fn(db); } finally { db.close(); } } };
}
/** A content row as older versions left it, and the documents that hold it. */
function seedBody(db: Database, hash: string, stored: string, docs: { path: string; active: number; reason?: string; origin?: string }[]): void {
  db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, CAST(? AS TEXT), '2026-01-01')`).run(hash, new TextEncoder().encode(stored));
  for (const d of docs) db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, last_accessed_at, active, deactivated_reason, origin)
    VALUES ('notes', ?, 't', ?, '2026-01-01', '2026-01-01', '2026-01-01', ?, ?, ?)`).run(d.path, hash, d.active, d.reason ?? null, d.origin ?? "fs");
}
const scan = (path: string) => { const db = new Database(path, { readonly: true }); try { return scanBodyHashes(db); } finally { db.close(); } };

describe("scanBodyHashes", () => {
  test("a healthy vault: every body's hash is the hash of its text — nothing found, the check passes", () => {
    const v = vault();
    v.raw(db => seedBody(db, sha(TEXT), TEXT, [{ path: "a.md", active: 1 }]));
    v.raw(db => seedBody(db, sha("mid" + FEFF + "string"), "mid" + FEFF + "string", [{ path: "m.md", active: 1 }]));   // a mark inside: sound
    const s = scan(v.path);
    expect(s.found).toEqual([]);
    expect(s.examined).toBe(2);
    const said = describeBodyHashes(s);
    expect(said.ok).toBe(true);
    expect(said.lines[0]).toContain("every body's hash is the hash of its text (2 examined)");
  });

  test("a U+FEFF dropped: found, named feff-dropped, with its documents; held by an active document → the check fails", () => {
    const v = vault();
    v.raw(db => seedBody(db, sha(FEFF + TEXT), TEXT, [{ path: "a.md", active: 1 }, { path: "b.md", active: 0, reason: "forget" }]));
    const s = scan(v.path);
    expect(s.found.map(f => ({ hash: f.hash, pattern: f.pattern }))).toEqual([{ hash: sha(FEFF + TEXT), pattern: "feff-dropped" }]);
    expect(s.found[0]!.documents.map(d => ({ active: d.active, reason: d.reason }))).toEqual([{ active: 1, reason: null }, { active: 0, reason: "forget" }]);
    const said = describeBodyHashes(s);
    expect(said.ok).toBe(false);
    expect(said.lines[0]).toMatch(/^1 stored body whose hash is not the hash of its text/);
    expect(said.lines[0]).toContain("1 with a leading U+FEFF dropped");
    expect(said.lines[0]).toContain('"Stored bodies whose hash is not the hash of their text"');
    expect(said.lines.slice(1).join("\n")).toContain("(active, fs)");
  });

  test("two leading U+FEFF, one kept by the old binding: still feff-dropped", () => {
    const v = vault();
    v.raw(db => seedBody(db, sha(FEFF + FEFF + TEXT), FEFF + TEXT, [{ path: "a.md", active: 1 }]));
    expect(scan(v.path).found.map(f => f.pattern)).toEqual(["feff-dropped"]);
  });

  test("text after a U+FFFE byte-swapped: found, named fffe-swapped", () => {
    const v = vault();
    v.raw(db => seedBody(db, sha(FFFE + TEXT), swapped(TEXT), [{ path: "a.md", active: 1 }]));
    const s = scan(v.path);
    expect(s.found.map(f => f.pattern)).toEqual(["fffe-swapped"]);
    expect(describeBodyHashes(s).lines[0]).toContain("1 byte-swapped after a leading U+FFFE");
  });

  test("a mismatch that neither pattern explains is listed as other", () => {
    const v = vault();
    v.raw(db => seedBody(db, sha("something else"), TEXT, [{ path: "a.md", active: 1 }]));
    const s = scan(v.path);
    expect(s.found.map(f => f.pattern)).toEqual(["other"]);
    expect(describeBodyHashes(s).lines[0]).toContain("1 other");
  });

  test("held only by inactive documents, or by none: listed as a record, and the check passes", () => {
    const v = vault();
    v.raw(db => seedBody(db, sha(FEFF + TEXT), TEXT, [{ path: "a.md", active: 0, reason: "archive" }]));
    v.raw(db => seedBody(db, sha(FFFE + TEXT), swapped(TEXT), []));
    const s = scan(v.path);
    expect(s.found.length).toBe(2);
    const said = describeBodyHashes(s);
    expect(said.ok).toBe(true);
    expect(said.lines[0]).toContain("none held by an active document");
    expect(said.lines.slice(1).join("\n")).toContain("held by no document");
  });

  test("the list is cut at the limit and says so; the counts still cover every row", () => {
    const v = vault();
    v.raw(db => { for (let i = 0; i < 5; i++) seedBody(db, sha(FEFF + TEXT + i), TEXT + i, [{ path: `a${i}.md`, active: 1 }]); });
    const db = new Database(v.path, { readonly: true });
    let s;
    try { s = scanBodyHashes(db, { listLimit: 3 }); } finally { db.close(); }
    expect(s.found.length).toBe(3);
    expect(s.limited).toBe(true);
    expect(s.counts).toEqual({ "feff-dropped": 5, "fffe-swapped": 0, other: 0 });
    const said = describeBodyHashes(s);
    expect(said.lines[0]).toMatch(/^5 stored bodies whose hash/);
    expect(said.lines.at(-1)).toContain("more bodies exist than are listed here");
  });
});
