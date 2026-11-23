/**
 * BACKLOG 82.3, D6 — the guard must not crash a hook. A hook whose input carries a session id that starts with a
 * byte-order mark reaches a binding the guard refuses; the hook's fail-open handling turns that into a non-fatal
 * outcome: exit 0, output a host can read, and the guard's one warning on stderr.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";

import { seedContent } from "../helpers/seed-content.ts";
const ROOT = join(import.meta.dir, "../..");
const MARK = String.fromCharCode(0xfeff);
let home: string;
let vault: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-823-hook-"));
  vault = join(home, "vault.sqlite");
  const s = createStore(vault);
  const now = new Date().toISOString();
  const body = "The tank filter is cleaned every week and the tank water is changed on Sunday.";
  const hash = hashContent(body);
  seedContent(s.db, hash, body, now);
  s.insertDocument("notes", "tank.md", "tank", hash, now, now);
  s.close();
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

function hook(name: string, input: Record<string, unknown>): { code: number; out: string; err: string } {
  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.INDEX_PATH = vault;
  env.XDG_RUNTIME_DIR = home;
  env.CLAWMEM_NO_LOCAL_MODELS = "true";
  env.CLAWMEM_EMBED_URL = "http://127.0.0.1:1";
  env.CLAWMEM_LLM_URL = "http://127.0.0.1:1";
  env.CLAWMEM_RERANK_URL = "http://127.0.0.1:1";
  env.CLAWMEM_HOOK_DEDUP_WINDOW_SEC = "0";
  const proc = Bun.spawnSync([process.execPath, "src/clawmem.ts", "hook", name], { env, cwd: ROOT, stdin: Buffer.from(JSON.stringify(input)) });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("a refusal of the guard inside a hook", () => {
  it("context-surfacing: exit 0 and readable output with an ordinary session id (the control)", () => {
    const r = hook("context-surfacing", { session_id: "sess-plain", prompt: "when is the tank filter cleaned and the water changed?", hook_event_name: "UserPromptSubmit", cwd: home });
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("byte-order mark");
  });

  it("context-surfacing: a mark-led session id is refused at the guard, and the hook still exits 0", () => {
    const r = hook("context-surfacing", { session_id: MARK + "sess-marked", prompt: "when is the tank filter cleaned and the water changed?", hook_event_name: "UserPromptSubmit", cwd: home });
    expect(r.code).toBe(0);
    if (r.out.trim()) expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.err).toContain("byte-order mark");                              // the guard's one warning: a refusal did happen
    expect(r.err.split("\n").filter(line => line.includes("A statement was refused")).length).toBe(1);
  });
});
