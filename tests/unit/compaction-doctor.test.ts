/**
 * 62.2 (codex T1 #11) — the doctor advisories are wired into the REAL `clawmem doctor`: a
 * postcompact-inject installed under a non-"compact" matcher, and legacy precompact-state.md files
 * nested in several Claude Code project memory dirs. Runs the CLI as a subprocess with an isolated
 * HOME; inference endpoints point at a dead port so those sections take their fast non-fatal paths.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

import { seedContent } from "../helpers/seed-content.ts";
const ROOT = join(import.meta.dir, "../..");
let home: string;
let deadPort: number;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-622-doctor-"));
  const t = Bun.serve({ port: 0, fetch: () => new Response("x") });
  deadPort = t.port!;
  t.stop(true);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

async function doctor(): Promise<string> {
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "doctor"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"),
      INDEX_PATH: resolve(home, "scratch.sqlite"),
      CLAWMEM_EMBED_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_LLM_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_RERANK_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_NO_LOCAL_MODELS: "true",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return out + err;
}

describe("62.2 — clawmem doctor reports the v0.39 compaction leftovers", () => {
  it("flags postcompact-inject under matcher \"\" and lists nested legacy state files", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "", hooks: [
        { type: "command", command: "/x/bin/clawmem hook postcompact-inject", timeout: 5 },
        { type: "command", command: "/x/bin/clawmem hook curator-nudge", timeout: 5 },
      ] }] },
    }));
    const legacy = "# Pre-Compaction State\n\n_Extracted 2026-09-01T10:00:00 before auto-compaction. This is authoritative._\n\n## Last User Request\n\nx\n";
    for (const proj of ["-work-a", "-work-b"]) {
      mkdirSync(join(home, ".claude", "projects", proj, "memory"), { recursive: true });
      writeFileSync(join(home, ".claude", "projects", proj, "memory", "precompact-state.md"), legacy);
    }
    mkdirSync(join(home, ".claude", "projects", "-work-c", "memory"), { recursive: true }); // no legacy file
    mkdirSync(join(home, ".claude", "projects", "-work-d", "memory"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-work-d", "memory", "precompact-state.md"), "# My own notes\n"); // same name, user's content

    const out = await doctor();
    expect(out).toContain('postcompact-inject is installed under SessionStart matcher ""');
    expect(out).toContain("Legacy pre-compaction state: 2 precompact-state.md file(s)");
    // codex T13 #4: the advice matches what reads the files (the doctor, the indexer, an older ClawMem).
    expect(out).toContain("Upgraded compaction hooks no longer use them; the doctor and the indexer only look at them, while an older ClawMem still running may still write and read them.");
    expect(out).not.toContain("Nothing reads or writes them");
    expect(out).toContain(join(home, ".claude", "projects", "-work-a", "memory", "precompact-state.md"));
    expect(out).toContain(join(home, ".claude", "projects", "-work-b", "memory", "precompact-state.md"));
    expect(out).not.toContain(join(home, ".claude", "projects", "-work-d", "memory", "precompact-state.md"));
  }, 60_000);

  it("flags red a legacy file written AFTER this vault was upgraded (an older ClawMem is still running)", async () => {
    await doctor(); // this version's first open of the vault records the upgrade time
    const f = join(home, ".claude", "projects", "-work-a", "memory", "precompact-state.md");
    const later = Date.now() / 1000 + 120;
    utimesSync(f, later, later); // an old process rewrote it after the upgrade
    const out = await doctor();
    expect(out).toContain("written after this vault was upgraded, so an older ClawMem process is still running");
    expect(out).toContain(f);
  }, 60_000);

  it("codex T5 #5 / T6 #1: lists a still-active indexed copy, marking a pre-v0.34 (NULL-origin) one", async () => {
    const { createStore } = await import("../../src/store.ts");
    const { hashContent } = await import("../../src/indexer.ts");
    const st = createStore(resolve(home, "scratch.sqlite"));
    try {
      const body = "# Pre-Compaction State\n\n_Extracted 2026-03-20T10:00:00 before auto-compaction. This is authoritative._\n\nx\n";
      const now = new Date().toISOString();
      seedContent(st.db, hashContent(body), body, now);
      st.insertDocument("agent-memory", "-gone/memory/precompact-state.md", "t", hashContent(body), now, now);
      st.db.prepare("UPDATE documents SET origin = NULL WHERE path = '-gone/memory/precompact-state.md'").run();
    } finally {
      st.close();
    }
    let out = "";
    try {
      out = await doctor();
    } finally {
      const s2 = createStore(resolve(home, "scratch.sqlite"));
      try {
        s2.db.prepare("UPDATE documents SET active = 0, deactivated_reason = 'forget' WHERE path = '-gone/memory/precompact-state.md'").run();
      } finally {
        s2.close();
      }
    }
    expect(out).toContain("1 indexed copy of an old snapshot is still active. Search and retrieval never return it");
    expect(out).toContain("agent-memory/-gone/memory/precompact-state.md  (pre-v0.34)");
  }, 60_000);

  it("is quiet about both once the layout is fixed and the files are gone", async () => {
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [
        { matcher: "compact", hooks: [{ type: "command", command: "/x/bin/clawmem hook postcompact-inject", timeout: 5 }] },
        { matcher: "", hooks: [
          { type: "command", command: "/x/bin/clawmem hook curator-nudge", timeout: 5 },
          { type: "command", command: "/usr/local/bin/clawmem-backup.sh hook postcompact-inject", timeout: 3 }, // not ClawMem's
        ] },
      ] },
    }));
    rmSync(join(home, ".claude", "projects"), { recursive: true, force: true });
    const out = await doctor();
    expect(out).not.toContain("postcompact-inject is installed under SessionStart matcher");
    expect(out).not.toContain("Legacy pre-compaction state");
  }, 60_000);
});
