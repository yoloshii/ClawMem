/**
 * BACKLOG 82.3, Codex T1 P1 (rulings 71 A–73 A) — the "Stored identifiers" check and its display cap.
 *
 * The list is cut per column for display, but whether the check fails, and the counts in its headline, must not
 * depend on that cut: inert values never fail it, an actionable value always does, and an actionable row is listed
 * before inert ones so the cut never hides it. No mark is typed into this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createStore } from "../../src/store.ts";
import { describeMarkedIdentifiers, scanMarkedIdentifiers } from "../../src/identifier-columns.ts";

const FEFF = String.fromCharCode(0xfeff);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A vault whose documents table holds `inactive` mark-led paths, then `active` mark-led ones (higher rowids). */
function vault(inactive: number, active: number): string {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-p1-")); dirs.push(dir);
  const path = join(dir, "v.sqlite");
  createStore(path).close();
  const db = new Database(path);
  try {
    const ins = db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, last_accessed_at, active)
                            VALUES ('notes', CAST(? AS TEXT), 't', 'h', '2026-01-01', '2026-01-01', '2026-01-01', ?)`);
    for (let i = 0; i < inactive; i++) ins.run(Buffer.from(FEFF + `in${i}.md`), 0);
    for (let i = 0; i < active; i++) ins.run(Buffer.from(FEFF + `act${i}.md`), 1);
  } finally { db.close(); }
  return path;
}
const check = (path: string, limitPerColumn = 50) => {
  const db = new Database(path, { readonly: true });
  try { const scan = scanMarkedIdentifiers(db, { limitPerColumn }); return { scan, said: describeMarkedIdentifiers(scan) }; } finally { db.close(); }
};

describe("P1: the identifier check's verdict and counts do not depend on the display cap", () => {
  test("51 inert values past a cap of 50: the check PASSES, the headline counts all 51 as inert, the cut is said", () => {
    const { scan, said } = check(vault(51, 0));
    expect(said.ok).toBe(true);
    expect(said.lines[0]).toMatch(/^51 stored value\(s\) start with a byte-order mark, all inert/);
    expect(scan.limited).toBe(true);
    expect(said.lines.at(-1)).toContain("more rows exist than are listed here");
  });

  test("50 inert values and ONE actionable at row 51: the check FAILS, the headline counts 1 actionable and 50 inert, the actionable row is listed", () => {
    const { scan, said } = check(vault(50, 1));
    expect(said.ok).toBe(false);
    expect(said.lines[0]).toMatch(/^1 stored value\(s\) start with a byte-order mark — results may be INCOMPLETE/);
    expect(said.lines[0]).toContain("50 more are inert");
    const listed = scan.found.filter(f => !f.inert);
    expect(listed.length).toBe(1);
    expect(said.lines[1]).not.toContain("[inert");                     // actionable rows come first
  });

  test("a cap of 3 over 2 actionable and 5 inert: both actionable rows listed first; exact counts", () => {
    const { scan, said } = check(vault(5, 2), 3);
    expect(scan.found.slice(0, 2).every(f => !f.inert)).toBe(true);
    expect(said.lines[0]).toMatch(/^2 stored value\(s\) start/);
    expect(said.lines[0]).toContain("5 more are inert");
    expect(said.ok).toBe(false);
  });

  test("control: under the cap, nothing is said about a cut", () => {
    const { scan, said } = check(vault(2, 0));
    expect(scan.limited).toBe(false);
    expect(said.ok).toBe(true);
    expect(said.lines.join("\n")).not.toContain("more rows exist");
  });
});
