/**
 * BACKLOG 82.3, D7b — recovery of existing rows by a FORCED re-index, through the real CLI (`clawmem reindex --force`),
 * on unchanged files. Older versions hashed a body that started with a byte-order mark WITH the mark, and stored it
 * through the string binding, which altered it: a U+FEFF was dropped; after a U+FFFE every code unit was stored
 * byte-swapped. Where such a body came from: a mark straight after a frontmatter block (either mark), or a U+FFFE at
 * the very start of a file; the frontmatter reader already removed a U+FEFF at the very start of a file before 82.3.
 * The rows below are written in that legacy form (the hash of the marked body, the altered body) after an ordinary
 * index of the same files, so the raw-file `content_hash` still matches the file. The first test of each group checks
 * the form itself; on `284b55a` the ordinary index alone produces it.
 *
 * Stated consequences (DESIGN D7b), each asserted here:
 *  - an ordinary `update` does NOT rewrite such a row (the `content_hash` shortcut skips the unchanged file);
 *  - `reindex --force` rewrites an ACTIVE file-backed row: new body without the mark, new hash; its embeddings are
 *    invalidated by the existing hash-change trigger; `origin` is kept; rows that shared the old hash follow their own
 *    files, and an API-born row on that hash has no source and keeps it;
 *  - a FORGOTTEN and an ARCHIVED row keep their lifecycle state AND keep their stored body and hash (content is NOT
 *    claimed recovered) — the two properties asserted apart;
 *  - a file whose NAME starts with a mark, stored by older versions under the altered name (U+FEFF dropped; after a
 *    U+FFFE, byte-swapped): the indexer now refuses the file, so the old row goes absent once and stays absent until
 *    the file is renamed;
 *  - an archived row restored later is still altered (an ordinary update skips its unchanged file) until a forced
 *    re-index after the restore;
 *  - a vault that still holds a stored marked identifier refuses the forced re-index at that collection (here the only
 *    one, so nothing is repaired; with several, earlier collections stay committed and later ones are not reached);
 *    after the documented cleanup the same command repairs the body — so the cleanup comes first;
 *  - mined imports: a mark inside a conversation never reaches the start of the stored body (the staging content puts a
 *    frontmatter block and a blank line before it), so the date backfill's two hashes agree before and after 82.3.
 * No mark is typed into this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { createStore } from "../../src/store.ts";
import { MARKS, hexOf, makeTwinVault, snapshot, changedTables, twinEnv, type TwinVault } from "../helpers/twin-vault.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const REFUSAL_LINE = "A statement was refused";
const sha = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
/** What the string binding of older versions stored for a body that started with `mark`. */
function legacyStored(mark: string, text: string): string {
  if (mark.charCodeAt(0) === 0xfeff) return text;
  return [...text].map(ch => { const c = ch.charCodeAt(0); return String.fromCharCode(((c & 0xff) << 8) | (c >> 8)); }).join("");
}

type Vault = { dir: string; vault: string; cfgDir: string; notes: string };
function makeVault(): Vault {
  const dir = mkdtempSync(join(tmpdir(), "clawmem-d7b-"));
  const notes = join(dir, "notes"), cfgDir = join(dir, "cfg");
  mkdirSync(notes); mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, "config.yaml"), `collections:\n  notes:\n    path: ${notes}\n    pattern: "**/*.md"\n`);
  return { dir, vault: join(dir, "vault.sqlite"), cfgDir, notes };
}
function envOf(v: Vault): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: v.dir, INDEX_PATH: v.vault, CLAWMEM_CONFIG_DIR: v.cfgDir, XDG_RUNTIME_DIR: v.dir,
    CLAWMEM_NO_LOCAL_MODELS: "true", CLAWMEM_EMBED_URL: "http://127.0.0.1:1", CLAWMEM_LLM_URL: "http://127.0.0.1:1",
    CLAWMEM_RERANK_URL: "http://127.0.0.1:1", NO_COLOR: "1",
  };
}
function cli(env: Record<string, string>, argv: string[]): { code: number | null; warnings: number; out: string; err: string } {
  const p = Bun.spawnSync([process.execPath, "src/clawmem.ts", ...argv], { env, cwd: ROOT });
  const err = p.stderr.toString();
  return { code: p.exitCode, warnings: err.split("\n").filter(l => l.includes(REFUSAL_LINE)).length, out: p.stdout.toString(), err };
}

/** Rewrite the row at `path` to its legacy form: the hash of the marked body, the altered body; embeddings synced. */
function makeLegacy(vault: string, path: string, markedBody: string, stored: string): void {
  const db = new Database(vault);
  try {
    db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, CAST(? AS TEXT), '2026-01-01T00:00:00.000Z')`)
      .run(sha(markedBody), bytes(stored));
    db.prepare(`UPDATE documents SET hash = ? WHERE collection = 'notes' AND path = ?`).run(sha(markedBody), path);
    db.prepare(`UPDATE documents SET embed_state = 'synced', embed_attempts = 2 WHERE collection = 'notes' AND path = ?`).run(path);
  } finally { db.close(); }
}
type Row = { id: number; active: number; reason: string | null; archived_at: string | null; origin: string | null;
  hash: string; embed_state: string | null; embed_attempts: number; bodyHex: string | null };
function rowAt(vault: string, collection: string, path: string): Row | null {
  const db = new Database(vault, { readonly: true });
  try {
    return db.prepare(`SELECT d.id, d.active, d.deactivated_reason reason, d.archived_at, d.origin, d.hash, d.embed_state, d.embed_attempts,
      (SELECT hex(doc) FROM content c WHERE c.hash = d.hash) bodyHex FROM documents d WHERE d.collection = ? AND d.path = ?`)
      .get(collection, path) as Row | null;
  } finally { db.close(); }
}
const rowsAt = (vault: string, path: string): number => {
  const db = new Database(vault, { readonly: true });
  try { return (db.prepare(`SELECT count(*) n FROM documents WHERE collection = 'notes' AND path = ?`).get(path) as { n: number }).n; }
  finally { db.close(); }
};

for (const [markName, mark] of MARKS) {
  describe(`forced re-index of legacy bodies — ${markName}`, () => {
    const TEXT = "LEGACYBODY the pump is primed monthly by the legacy row.";
    const file = (title: string) => `---\ntitle: ${title}\n---\n${mark}${TEXT}`;
    const markedBody = mark + TEXT, stored = legacyStored(mark, TEXT);
    const oldHash = sha(markedBody), newHash = sha(TEXT);
    let v: Vault, env: Record<string, string>;

    beforeAll(() => {
      v = makeVault(); env = envOf(v);
      for (const [p, t] of [["m1.md", "Legacy"], ["m2.md", "Legacy"], ["forgot.md", "Forgotten"], ["arch.md", "Archived"]] as const) {
        writeFileSync(join(v.notes, p), file(t));
      }
      writeFileSync(join(v.notes, "plain.md"), "# Plain\n\nA plain control body.\n");
      const first = cli(env, ["update"]);
      if (first.code !== 0) throw new Error(`seed update failed:\n${first.err}`);
      for (const p of ["m1.md", "m2.md", "forgot.md", "arch.md"]) makeLegacy(v.vault, p, markedBody, stored);
      const db = new Database(v.vault);
      try {
        db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'forget' WHERE collection = 'notes' AND path = 'forgot.md'`).run();
        db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'archive', archived_at = '2026-02-02T00:00:00.000Z'
                    WHERE collection = 'notes' AND path = 'arch.md'`).run();
        // An API-born row on the same (legacy) hash: no file is its source. (Not under decisions/, antipatterns/,
        // handoffs/ or observations/: an unstamped insert there is dropped by the stop-hook fence.)
        db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, origin)
                    VALUES ('_clawmem', 'memories/legacy-api.md', 'Legacy observation', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 'api')`)
          .run(oldHash);
      } finally { db.close(); }
    });
    afterAll(() => { rmSync(v.dir, { recursive: true, force: true }); });

    test("the seed is the legacy form: the row's hash is the hash WITH the mark, its stored body is the altered one", () => {
      const r = rowAt(v.vault, "notes", "m1.md")!;
      expect(r.hash).toBe(oldHash);
      expect(r.bodyHex).toBe(hexOf(stored));
      expect(r.hash).not.toBe(sha(stored));          // the hash does not describe what the row holds
    });

    test("an ordinary update does NOT rewrite it: the unchanged file is skipped before it is parsed", () => {
      const r = cli(env, ["update"]);
      expect({ code: r.code, warnings: r.warnings }).toEqual({ code: 0, warnings: 0 });
      for (const p of ["m1.md", "m2.md"]) {
        const row = rowAt(v.vault, "notes", p)!;
        expect({ hash: row.hash, embed_state: row.embed_state }).toEqual({ hash: oldHash, embed_state: "synced" });
      }
    }, 60_000);

    test("reindex --force rewrites each ACTIVE file-backed row from its own file; the API-born row keeps the old hash", () => {
      const r = cli(env, ["reindex", "--force"]);
      expect({ code: r.code, warnings: r.warnings }).toEqual({ code: 0, warnings: 0 });
      for (const p of ["m1.md", "m2.md"]) {
        const row = rowAt(v.vault, "notes", p)!;
        expect(row.hash).toBe(newHash);
        expect(row.bodyHex).toBe(hexOf(TEXT));                                  // the mark is gone from the stored body
        expect({ active: row.active, origin: row.origin }).toEqual({ active: 1, origin: "fs" });
        expect({ embed_state: row.embed_state, embed_attempts: row.embed_attempts })   // the hash-change trigger
          .toEqual({ embed_state: "pending", embed_attempts: 0 });
      }
      const api = rowAt(v.vault, "_clawmem", "memories/legacy-api.md")!;
      expect({ hash: api.hash, bodyHex: api.bodyHex, active: api.active }).toEqual({ hash: oldHash, bodyHex: hexOf(stored), active: 1 });
    }, 60_000);

    test("the forgotten and the archived row keep their LIFECYCLE STATE (no second row at their paths)", () => {
      const f = rowAt(v.vault, "notes", "forgot.md")!, a = rowAt(v.vault, "notes", "arch.md")!;
      expect({ active: f.active, reason: f.reason, archived_at: f.archived_at }).toEqual({ active: 0, reason: "forget", archived_at: null });
      expect({ active: a.active, reason: a.reason, archived_at: a.archived_at })
        .toEqual({ active: 0, reason: "archive", archived_at: "2026-02-02T00:00:00.000Z" });
      expect(rowsAt(v.vault, "forgot.md")).toBe(1);
      expect(rowsAt(v.vault, "arch.md")).toBe(1);
    });

    test("the forgotten and the archived row keep their STORED BODY AND HASH: their content is NOT recovered", () => {
      for (const p of ["forgot.md", "arch.md"]) {
        const row = rowAt(v.vault, "notes", p)!;
        expect({ hash: row.hash, bodyHex: row.bodyHex }).toEqual({ hash: oldHash, bodyHex: hexOf(stored) });
      }
    });

    test("an archived row RESTORED after the forced re-index stays altered under an ordinary update; a second forced re-index repairs it", () => {
      const s = createStore(v.vault);
      try { expect(s.restoreArchivedDocuments({ collection: "notes" })).toBe(1); } finally { s.close(); }
      const u = cli(env, ["update"]);
      expect({ code: u.code, warnings: u.warnings }).toEqual({ code: 0, warnings: 0 });
      expect(rowAt(v.vault, "notes", "arch.md")!.hash).toBe(oldHash);          // the unchanged file is skipped
      const f = cli(env, ["reindex", "--force"]);
      expect({ code: f.code, warnings: f.warnings }).toEqual({ code: 0, warnings: 0 });
      const row = rowAt(v.vault, "notes", "arch.md")!;
      expect({ active: row.active, hash: row.hash, bodyHex: row.bodyHex }).toEqual({ active: 1, hash: newHash, bodyHex: hexOf(TEXT) });
      expect(rowAt(v.vault, "notes", "forgot.md")!.hash).toBe(oldHash);       // the forgotten one is still as stored
    }, 120_000);
  });
}

for (const [markName, mark] of MARKS) {
  describe(`a file whose NAME starts with ${markName}, stored by older versions under an altered name`, () => {
    // Older versions bound the name as a string: a U+FEFF was dropped (`x.md`), after a U+FFFE every code unit was
    // stored byte-swapped. The row is made by an ordinary index of `x.md`, moved to that altered name, and the file
    // gets the name it really has on disk. (A file AT the byte-swapped name would not match `**/*.md`.)
    // On `284b55a` (Bun 1.3.14) the old row also goes absent and stays absent through `update`: the stays-absent test
    // guards that; what is new here is the refusal — the file is named in a warning, and no row is written for it.
    const legacyName = legacyStored(mark, "x.md");
    const sameRowComesBack = legacyName === "x.md";
    const BODY = "# X\n\nXBODY the valve is checked yearly.\n";
    let v: Vault, env: Record<string, string>, oldId: number;

    beforeAll(() => {
      v = makeVault(); env = envOf(v);
      writeFileSync(join(v.notes, "x.md"), BODY);
      const first = cli(env, ["update"]);
      if (first.code !== 0) throw new Error(`seed update failed:\n${first.err}`);
      const db = new Database(v.vault);
      try { db.prepare(`UPDATE documents SET path = ? WHERE collection = 'notes' AND path = 'x.md'`).run(legacyName); }
      finally { db.close(); }
      oldId = rowAt(v.vault, "notes", legacyName)!.id;
      renameSync(join(v.notes, "x.md"), join(v.notes, mark + "x.md"));
    });
    afterAll(() => { rmSync(v.dir, { recursive: true, force: true }); });

    const noMarkedRow = () => {
      const db = new Database(v.vault, { readonly: true });
      try { return (db.prepare(`SELECT count(*) n FROM documents WHERE hex(path) = ?`).get(hexOf(mark + "x.md")) as { n: number }).n; }
      finally { db.close(); }
    };

    test("update refuses the file (named, not stripped) and the old row goes absent; no row is stored at the marked name", () => {
      const r = cli(env, ["update"]);
      expect({ code: r.code, warnings: r.warnings }).toEqual({ code: 0, warnings: 0 });
      expect(r.err).toContain(`[indexer] refused: notes/<${markName}>x.md`);
      const row = rowAt(v.vault, "notes", legacyName)!;
      expect({ id: row.id, active: row.active, reason: row.reason }).toEqual({ id: oldId, active: 0, reason: "absent" });
      expect(noMarkedRow()).toBe(0);
    }, 60_000);

    test("it STAYS absent on the next passes — update, then reindex --force (no flip between active and absent)", () => {
      for (const argv of [["update"], ["reindex", "--force"], ["update"]]) {
        const r = cli(env, argv);
        expect({ argv, code: r.code, warnings: r.warnings }).toEqual({ argv, code: 0, warnings: 0 });
        const row = rowAt(v.vault, "notes", legacyName)!;
        expect({ active: row.active, reason: row.reason }).toEqual({ active: 0, reason: "absent" });
      }
      expect(noMarkedRow()).toBe(0);
    }, 120_000);

    test(sameRowComesBack
      ? "after the file is renamed without the mark, the same row comes back"
      : "after the file is renamed without the mark, it is a new row; the byte-swapped row stays absent", () => {
      renameSync(join(v.notes, mark + "x.md"), join(v.notes, "x.md"));
      const r = cli(env, ["update"]);
      expect({ code: r.code, warnings: r.warnings }).toEqual({ code: 0, warnings: 0 });
      const row = rowAt(v.vault, "notes", "x.md")!;
      expect({ active: row.active, reason: row.reason }).toEqual({ active: 1, reason: null });
      expect(row.id === oldId).toBe(sameRowComesBack);
      if (!sameRowComesBack) {
        const old = rowAt(v.vault, "notes", legacyName)!;
        expect({ active: old.active, reason: old.reason }).toEqual({ active: 0, reason: "absent" });
      }
    }, 60_000);
  });
}

for (const [markName, mark] of MARKS) {
  describe(`the cleanup comes first — a vault that still holds a stored marked identifier — ${markName}`, () => {
    const TEXT = "LEGACYBODY the hose is replaced each spring.";
    const markedBody = mark + TEXT;
    let t: TwinVault, env: Record<string, string>;

    beforeAll(() => {
      t = makeTwinVault(mark, { lifecycle: false, ageDays: 0 });
      env = { ...twinEnv(t), NO_COLOR: "1" };
      const raw = `---\ntitle: Hose\n---\n${markedBody}`;
      writeFileSync(join(t.notes, "l.md"), raw);
      const db = new Database(t.vault);
      try {
        db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, CAST(? AS TEXT), '2026-01-01T00:00:00.000Z')`)
          .run(sha(markedBody), bytes(legacyStored(mark, TEXT)));
        // last_accessed_at is set as on any row a store has opened before: otherwise the open-time backfill writes it.
        db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, last_accessed_at, active, origin, content_hash)
                    VALUES ('notes', 'l.md', 'Hose', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 'fs', ?)`)
          .run(sha(markedBody), sha(raw));
      } finally { db.close(); }
    });
    afterAll(() => { rmSync(t.dir, { recursive: true, force: true }); });

    test("before the cleanup: reindex --force is refused — exit 1, one warning, no table changed", () => {
      const before = snapshot(t.vault);
      const r = cli(env, ["reindex", "--force"]);
      expect({ code: r.code, warnings: r.warnings }).toEqual({ code: 1, warnings: 1 });
      expect(changedTables(before, snapshot(t.vault))).toEqual({});
      expect(rowAt(t.vault, "notes", "l.md")!.hash).toBe(sha(markedBody));
    }, 60_000);

    test("after the documented cleanup (rename, the document statement, the reference statement): the same command repairs the body", () => {
      renameSync(join(t.notes, t.markedPath), join(t.notes, "a-renamed.md"));
      const db = new Database(t.vault);
      try {
        db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'forget' WHERE id = ?`).run(t.markedId);
        const s = db.prepare(`SELECT rowid r FROM session_log WHERE hex(session_id) = ?`).get(hexOf(t.markedSession)) as { r: number };
        db.prepare(`UPDATE session_log SET handoff_path = NULL WHERE rowid = ?`).run(s.r);
      } finally { db.close(); }
      const r = cli(env, ["reindex", "--force"]);
      expect({ code: r.code, warnings: r.warnings }).toEqual({ code: 0, warnings: 0 });
      const row = rowAt(t.vault, "notes", "l.md")!;
      expect({ hash: row.hash, bodyHex: row.bodyHex }).toEqual({ hash: sha(TEXT), bodyHex: hexOf(TEXT) });
      const ro = new Database(t.vault, { readonly: true });
      try {
        const kept = ro.prepare(`SELECT active, deactivated_reason r, hash FROM documents WHERE id = ?`).get(t.markedId);
        expect(kept).toEqual({ active: 0, r: "forget", hash: t.markedHash });   // kept as stored: not rewritten
      } finally { ro.close(); }
    }, 60_000);
  });
}

for (const [markName, mark] of MARKS) {
  // Codex T1 S7: the refusal is per COLLECTION, not per command. Each collection commits on its own; the refused one
  // rolls back, the ones indexed before it stay committed, and the command stops there (later ones are not reached).
  describe(`a refused forced re-index stops at the collection that binds the value — ${markName}`, () => {
    const TEXT = "LEGACYBODY the valve is greased each autumn.";
    const markedBody = mark + TEXT;
    let t: TwinVault, env: Record<string, string>;
    const seedLegacy = (col: string, dir: string) => {
      const raw = `---\ntitle: Valve\n---\n${markedBody}`;
      writeFileSync(join(dir, "l.md"), raw);
      const db = new Database(t.vault);
      try {
        db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, CAST(? AS TEXT), '2026-01-01T00:00:00.000Z')`)
          .run(sha(markedBody), bytes(legacyStored(mark, TEXT)));
        db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, last_accessed_at, active, origin, content_hash)
                    VALUES (?, 'l.md', 'Valve', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 'fs', ?)`)
          .run(col, sha(markedBody), sha(raw));
      } finally { db.close(); }
    };

    beforeAll(() => {
      t = makeTwinVault(mark, { lifecycle: false, ageDays: 0 });
      env = { ...twinEnv(t), NO_COLOR: "1" };
      const before = join(t.dir, "before"), after = join(t.dir, "after");
      mkdirSync(before); mkdirSync(after);
      writeFileSync(join(t.cfgDir, "config.yaml"),
        `collections:\n  before:\n    path: ${before}\n    pattern: "**/*.md"\n` +
        `  notes:\n    path: ${t.notes}\n    pattern: "**/*.md"\n` +
        `  after:\n    path: ${after}\n    pattern: "**/*.md"\n`);
      seedLegacy("before", before);
      seedLegacy("after", after);
    });
    afterAll(() => { rmSync(t.dir, { recursive: true, force: true }); });

    test("exit 1, one warning; the collection before it is repaired and committed; the one after it is not reached", () => {
      const r = cli(env, ["reindex", "--force"]);
      expect({ code: r.code, warnings: r.warnings }).toEqual({ code: 1, warnings: 1 });
      const first = rowAt(t.vault, "before", "l.md")!, last = rowAt(t.vault, "after", "l.md")!;
      expect({ hash: first.hash, bodyHex: first.bodyHex }).toEqual({ hash: sha(TEXT), bodyHex: hexOf(TEXT) });
      expect(last.hash).toBe(sha(markedBody));
      expect(r.out).toContain("Indexing before");
      expect(r.out).not.toContain("Indexing after");
      const ro = new Database(t.vault, { readonly: true });
      try {   // the refused collection rolled back: its marked row is as seeded
        expect(ro.prepare(`SELECT active, hash FROM documents WHERE id = ?`).get(t.markedId)).toEqual({ active: 1, hash: t.markedHash });
      } finally { ro.close(); }
    }, 60_000);
  });
}

describe("mined imports — the date backfill's two hashes agree for a conversation that holds a mark", () => {
  for (const [markName, mark] of MARKS) {
    test(`${markName}: mine, clear the date, backfill: the row is matched (no body mismatch) and dated; the mark is never first in the stored body`, () => {
      const dir = mkdtempSync(join(tmpdir(), "clawmem-d7b-mine-"));
      try {
        const src = join(dir, "src"); mkdirSync(src);
        const cfgDir = join(dir, "cfg"); mkdirSync(cfgDir);
        writeFileSync(join(cfgDir, "config.yaml"), "collections: {}\n");
        const line = (type: string, ts: string, content: string) => JSON.stringify({ type, timestamp: ts, message: { content } });
        writeFileSync(join(src, "talk.jsonl"), [
          line("human", "2025-05-01T08:00:00Z", mark + "how often is the pump primed in the legacy row"),
          line("assistant", "2025-05-01T08:10:00Z", mark + "monthly, by the legacy row, as the note says"),
        ].join("\n") + "\n");
        const vault = join(dir, "vault.sqlite");
        const env = envOf({ dir, vault, cfgDir, notes: src });
        const mine = (...a: string[]) => cli(env, ["mine", src, "-c", "convos", ...a]);
        const m = mine();
        expect({ code: m.code, warnings: m.warnings }).toEqual({ code: 0, warnings: 0 });
        const db = new Database(vault);
        let row: { id: number; hash: string; doc: string; authored_at: string | null };
        try {
          row = db.prepare(`SELECT d.id, d.hash, c.doc, d.authored_at FROM documents d JOIN content c ON c.hash = d.hash
                            WHERE d.collection = 'convos' AND d.active = 1`).get() as typeof row;
          expect(row.authored_at).toBe("2025-05-01T08:10:00.000Z");
          db.prepare(`UPDATE documents SET authored_at = NULL WHERE id = ?`).run(row.id);
        } finally { db.close(); }
        expect(row.doc.charCodeAt(0)).not.toBe(mark.charCodeAt(0));     // the mark is never first in a mined body ...
        // ... and where it survives it is kept: the transcript reader trims each message, and JavaScript's trim counts
        // U+FEFF as white space (not U+FFFE) — as before 82.3.
        expect(row.doc.includes(mark)).toBe(mark.charCodeAt(0) === 0xfffe);
        expect(row.hash).toBe(sha(row.doc));                             // the row's hash is the hash of what it holds
        const b = mine("--backfill-dates", "--apply");
        expect({ code: b.code, warnings: b.warnings }).toEqual({ code: 0, warnings: 0 });
        expect(b.out).toMatch(/1 to update/);
        expect(b.out).toMatch(/0 body-mismatch skipped/);
        const ro = new Database(vault, { readonly: true });
        try {
          expect((ro.prepare(`SELECT authored_at a FROM documents WHERE id = ?`).get(row.id) as { a: string }).a).toBe("2025-05-01T08:10:00.000Z");
        } finally { ro.close(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 90_000);
  }
});

for (const [markName, mark] of MARKS) {
  describe(`the doctor's Stored-bodies check through the CLI (rulings 74 A, 77 A) — ${markName}`, () => {
    const TEXT = "LEGACYBODY the filter is rinsed weekly.";
    const markedBody = mark + TEXT, stored = legacyStored(mark, TEXT);
    const pattern = mark.charCodeAt(0) === 0xfeff ? "feff-dropped" : "fffe-swapped";
    let v: Vault, env: Record<string, string>;
    const bodiesLine = () => cli(env, ["doctor"]).out.split("\n").find(l => l.includes("Stored bodies:")) ?? "(no line)";

    beforeAll(() => {
      v = makeVault(); env = envOf(v);
      writeFileSync(join(v.notes, "l.md"), `---\ntitle: Filter\n---\n${markedBody}`);
      const first = cli(env, ["update"]);
      if (first.code !== 0) throw new Error(`seed update failed:\n${first.err}`);
      makeLegacy(v.vault, "l.md", markedBody, stored);
    });
    afterAll(() => { rmSync(v.dir, { recursive: true, force: true }); });

    test("a healthy vault passes; the altered body held by an active file-backed document FAILS the check, named by its pattern", () => {
      const line = bodiesLine();
      expect(line).toContain("✗ Stored bodies: 1 stored body whose hash is not the hash of its text");
      expect(line).toContain("1 held by an active document");
      const all = cli(env, ["doctor"]).out;
      expect(all).toContain(`(${pattern}): documents id`);
    }, 60_000);

    test("after reindex --force no active document holds it: listed as a record, the check passes", () => {
      expect(cli(env, ["reindex", "--force"]).code).toBe(0);
      const line = bodiesLine();
      expect(line).toContain("✓ Stored bodies: 1 stored body whose hash is not the hash of its text");
      expect(line).toContain("none held by an active document — kept as a record");
    }, 60_000);

    test("an ACTIVE API-born memory on that body fails the check again (77 A): it has no file to re-index from", () => {
      const db = new Database(v.vault);
      try {
        db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, last_accessed_at, active, origin)
                    VALUES ('_clawmem', 'memories/filter.md', 'Filter memory', ?, '2026-01-01', '2026-01-01', '2026-01-01', 1, 'api')`).run(sha(markedBody));
      } finally { db.close(); }
      expect(bodiesLine()).toContain("✗ Stored bodies: 1 stored body whose hash is not the hash of its text");
    }, 60_000);
  });
}
