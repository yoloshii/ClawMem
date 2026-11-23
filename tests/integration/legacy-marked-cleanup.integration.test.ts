/**
 * BACKLOG 82.3, D7 — the documented cleanup of a legacy document whose path starts with a byte-order mark, RUN BY HAND
 * in the test, with a session handoff path that names the document (DESIGN §7, the recovery end to end):
 *  - the operator renames the file without the mark;
 *  - the DOCUMENT statement, by numeric id:   UPDATE documents SET active = 0, deactivated_reason = 'forget' WHERE id = <id>
 *    → the searches succeed; session bootstrap, profile construction AND `update` still fail while the reference
 *      remains — `update` ends with a profile refresh that reads the handoff by its path (ruling 66 A: the documented
 *      cleanup runs BOTH statements, then `update`);
 *  - the REFERENCE statement, by rowid:        UPDATE session_log SET handoff_path = NULL WHERE rowid = <rowid>
 *    → they succeed too, and the renamed file is a new document;
 *  - a `feedback_ledger` row with the SAME rowid and a marked display path is untouched by both statements.
 * "Fails" and "succeeds" are read from the guard's warning (one per refusing process) and the exit code.
 * No mark is typed into this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { BODY_MARKED, MARKS, QUERY, hexOf, makeTwinVault, twinEnv, twinLlm, type TwinVault } from "../helpers/twin-vault.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const REFUSAL_LINE = "A statement was refused";
function child(t: TwinVault, argv: string[], stdin?: unknown): { code: number | null; warnings: number; out: string } {
  const env = twinEnv(t);
  env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  const p = Bun.spawnSync([process.execPath, "src/clawmem.ts", ...argv], {
    env, cwd: ROOT, stdin: stdin === undefined ? undefined : Buffer.from(JSON.stringify(stdin)),
  });
  const err = p.stderr.toString();
  return { code: p.exitCode, warnings: err.split("\n").filter(l => l.includes(REFUSAL_LINE)).length, out: p.stdout.toString() };
}
const bootstrap = (t: TwinVault) => child(t, ["hook", "session-bootstrap"], { session_id: "sess-plain", hook_event_name: "SessionStart", source: "startup", cwd: t.dir });

for (const [markName, mark] of MARKS) {
  describe(`the cleanup by hand — ${markName}`, () => {
    let t: TwinVault;
    let sessionRowid: number;
    const ledgerRow = () => {
      const db = new Database(t.vault, { readonly: true });
      const r = db.prepare(`SELECT rowid, usage_id, vault, hex(display_path) p, vault_doc_id, displayed_title, created_at FROM feedback_ledger WHERE rowid = ?`).get(sessionRowid);
      db.close();
      return r;
    };
    let ledgerBefore: unknown;

    beforeAll(() => {
      t = makeTwinVault(mark, { lifecycle: false, ageDays: 0 });
      const db = new Database(t.vault);
      sessionRowid = (db.prepare(`SELECT rowid r FROM session_log WHERE hex(session_id) = ?`).get(hexOf(t.markedSession)) as { r: number }).r;
      db.prepare(`INSERT INTO feedback_ledger (rowid, usage_id, vault, display_path, vault_doc_id, displayed_title, created_at)
                  VALUES (?, 1, '', CAST(? AS TEXT), ?, 'Marked twin', '2026-11-23T00:00:00.000Z')`)
        .run(sessionRowid, new TextEncoder().encode("notes/" + t.markedPath), t.markedId);
      db.close();
      ledgerBefore = ledgerRow();
      renameSync(join(t.notes, t.markedPath), join(t.notes, "a-renamed.md"));   // the operator renames the file
    });
    afterAll(() => { rmSync(t.dir, { recursive: true, force: true }); });

    test("before any statement: a search is refused (the degraded state), and the doctor's identifier check fails", () => {
      expect(child(t, ["search", QUERY, "--json"]).warnings).toBe(1);
      expect(child(t, ["doctor"]).out).toMatch(/✗ Stored identifiers/);
    }, 60_000);

    test("the DOCUMENT statement by id: searches succeed; bootstrap, profile construction and update still fail (66 A)", () => {
      const db = new Database(t.vault);
      db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'forget' WHERE id = ?`).run(t.markedId);
      db.close();
      const search = child(t, ["search", QUERY, "--json"]);
      expect({ code: search.code, warnings: search.warnings }).toEqual({ code: 0, warnings: 0 });
      const update = child(t, ["update"]);
      expect({ code: update.code, warnings: update.warnings }).toEqual({ code: 1, warnings: 1 });   // its profile refresh reads the handoff
      expect(bootstrap(t).warnings).toBe(1);
      expect(child(t, ["profile", "rebuild"]).warnings).toBe(1);
      expect(ledgerRow()).toEqual(ledgerBefore);
    }, 120_000);

    test("the REFERENCE statement by rowid: bootstrap and profile construction succeed; the renamed file is a new document", () => {
      const db = new Database(t.vault);
      db.prepare(`UPDATE session_log SET handoff_path = NULL WHERE rowid = ?`).run(sessionRowid);
      db.close();
      expect(bootstrap(t).warnings).toBe(0);
      const profile = child(t, ["profile", "rebuild"]);
      expect({ code: profile.code, warnings: profile.warnings }).toEqual({ code: 0, warnings: 0 });
      const search = child(t, ["search", QUERY, "--json"]);
      expect(search.warnings).toBe(0);
      const update = child(t, ["update"]);
      expect({ code: update.code, warnings: update.warnings }).toEqual({ code: 0, warnings: 0 });
      const ro = new Database(t.vault, { readonly: true });
      const renamed = ro.prepare(`SELECT d.active, c.doc FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = 'notes' AND d.path = 'a-renamed.md'`).get();
      const old = ro.prepare(`SELECT active, deactivated_reason, hex(path) p FROM documents WHERE id = ?`).get(t.markedId);
      ro.close();
      expect(renamed).toEqual({ active: 1, doc: BODY_MARKED });
      expect(old).toEqual({ active: 0, deactivated_reason: "forget", p: hexOf(t.markedPath) });   // the old row stays, by its bytes
      expect(ledgerRow()).toEqual(ledgerBefore);
    }, 120_000);

    test("after both statements: the counter recompute copies the ledger path byte for byte; the doctor lists every kept value as INERT and its check passes (71 A, 72 A, 73 A)", () => {
      const rc = child(t, ["repair", "counters", "--apply"]);
      expect({ code: rc.code, warnings: rc.warnings }).toEqual({ code: 0, warnings: 0 });
      const ro = new Database(t.vault, { readonly: true });
      const signal = ro.prepare(`SELECT hex(path) h FROM utility_signals WHERE hex(path) = ?`).get(hexOf("notes/" + t.markedPath));
      ro.close();
      expect(signal).toEqual({ h: hexOf("notes/" + t.markedPath) });
      const out = child(t, ["doctor"]).out;
      // the forgotten row's path, the session id, the ledger display path, the utility signal copied from it, and the
      // counter repair log's key for that signal (73 A)
      expect(out).toMatch(/✓ Stored identifiers: 5 stored value\(s\) start with a byte-order mark, all inert/);
      expect(out.split("\n").filter(l => l.includes("[inert — kept as a record]")).length).toBe(5);
    }, 60_000);

    test("after both statements no MCP route is refused: what the doctor calls inert is not bound again", async () => {
      process.env.INDEX_PATH = t.vault;
      process.env.CLAWMEM_CONFIG_DIR = t.cfgDir;
      setDefaultLlamaCpp(twinLlm);
      const built = buildMcpServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await built.server.connect(st);
      const client = new Client({ name: "cleanup", version: "0" });
      await client.connect(ct);
      try {
        const calls: [string, Record<string, unknown>][] = [
          ["search", { query: QUERY }], ["vsearch", { query: QUERY }], ["query", { query: QUERY }], ["intent_search", { query: QUERY }],
          ["memory_retrieve", { query: QUERY }], ["query_plan", { query: QUERY }], ["find_similar", { file: "notes/a.md" }],
          ["get", { file: "notes/a.md" }], ["multi_get", { pattern: "*.md" }], ["session_log", { limit: 10 }], ["profile", {}],
          ["lifecycle_status", {}], ["lifecycle_sweep", { dry_run: true }], ["lifecycle_restore", { query: "tank" }],
          ["memory_pin", { query: "tank filter weekly" }], ["kg_query", { entity: "tank" }], ["status", {}],
        ];
        const refused: string[] = [];
        for (const [name, args] of calls) {
          const r = JSON.stringify(await client.callTool({ name, arguments: args }));
          if (/bound string starts with|BomLeadingTextError/.test(r)) refused.push(name);
        }
        expect(refused).toEqual([]);
      } finally {
        try { built.closeAllStores(); } catch { /* closed */ }
        setDefaultLlamaCpp(null);
        delete process.env.INDEX_PATH;
        delete process.env.CLAWMEM_CONFIG_DIR;
      }
    }, 120_000);
  });
}
