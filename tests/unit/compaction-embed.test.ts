/**
 * 62.2 (codex T9 #2; CR-3) — no legacy pre-compaction snapshot is sent to an embedding model: not by
 * `clawmem embed` (a normal run or `--force`), run through the real CLI against an embedding server that
 * records its inputs, and not by the doctor's sampled vector validation. The needs-embedding counts mirror
 * the worklist, so an unembedded copy never reads as pending. The vault holds active copies (fs, a
 * fileless NULL one with CRLF, api) next to real notes.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { hashContent, parseDocument } from "../../src/indexer.ts";
import { splitDocument } from "../../src/splitter.ts";
import { formatDocForEmbedding } from "../../src/llm.ts";
import { runSampledVectorValidation } from "../../src/canary.ts";

import { seedContent } from "../helpers/seed-content.ts";
const ROOT = join(import.meta.dir, "../..");
const CANARY = "CANARY-EMBED";
const LEGACY = `# Pre-Compaction State\n\n_Extracted 2026-09-01T10:00:00 before auto-compaction. This is authoritative._\n\n## Last User Request\n\nzephyrinth gantry ${CANARY} from another session\n`;
const COPIES: [string, string, string | null][] = [
  ["-u-fs/memory/precompact-state.md", LEGACY, "fs"],
  ["-u-null/memory/precompact-state.md", LEGACY.replace(/\n/g, "\r\n"), null],
  ["-u-api/memory/precompact-state.md", LEGACY, "api"],
];
const NOTES: [string, string][] = [
  ["anchor.md", "zephyrinth project anchor note about the gantry rig"],
  ["gantry-note.md", "calibration log for the gantry rig, written by the lab"],
];

/** A deterministic vector per text: the same text always embeds the same way. */
function vecFor(text: string): number[] {
  const h = createHash("sha256").update(text).digest();
  return Array.from({ length: 8 }, (_, i) => (h[i]! - 127.5) / 127.5);
}

let home: string;
let vault: string;
let inputs: string[];
let server: ReturnType<typeof Bun.serve>;
let deadPort: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-622-embed-"));
  vault = resolve(home, "vault.sqlite");
  inputs = [];
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname !== "/v1/embeddings") return new Response("not found", { status: 404 });
      const body = await req.json() as { input: string | string[] };
      const list = Array.isArray(body.input) ? body.input : [body.input];
      inputs.push(...list);
      return Response.json({ data: list.map((t, index) => ({ embedding: vecFor(t), index })), model: "fake-embed" });
    },
  });
  const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
  deadPort = dead.port!;
  dead.stop(true);
});

afterEach(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

function seed(st: Store): void {
  const now = new Date().toISOString();
  const put = (path: string, body: string, origin: string | null, title: string) => {
    const hash = hashContent(body + path);
    seedContent(st.db, hash, body, now);
    st.insertDocument("agent-memory", path, title, hash, now, now);
    st.db.prepare("UPDATE documents SET origin = ? WHERE collection = 'agent-memory' AND path = ?").run(origin, path);
    return hash;
  };
  for (const [path, body, origin] of COPIES) put(path, body, origin, "Pre-Compaction State");
  for (const [path, body] of NOTES) put(path, body, "fs", path);
}

async function clawmemEmbed(...flags: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "embed", ...flags], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"),
      INDEX_PATH: vault,
      CLAWMEM_EMBED_URL: `http://127.0.0.1:${server.port}`,
      CLAWMEM_LLM_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_RERANK_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_NO_LOCAL_MODELS: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return out + err;
}

const embeddedNote = () => inputs.some(t => t.includes("zephyrinth project anchor note"));
const embeddedCopy = () => inputs.filter(t => t.includes(CANARY) || t.includes("Pre-Compaction State"));

describe("62.2 (codex T9 #2) — no legacy snapshot reaches an embedding model", () => {
  it("clawmem embed, and embed --force, embed the real notes and never a copy; nothing reads as pending", async () => {
    const st = createStore(vault);
    seed(st);
    st.close();

    const log = await clawmemEmbed("--force-geometry");  // the fake server's vectors fail the geometry canary
    expect(embeddedNote()).toBe(true);                     // the pipeline ran (positive control)
    expect(embeddedCopy()).toEqual([]);
    const after = createStore(vault);
    try {
      expect(after.getHashesNeedingEmbedding()).toBe(0);   // the unembedded copies are not "needing"
      expect(after.getVectorConsistency().pending).toBe(0);
    } finally { after.close(); }

    inputs = [];
    await clawmemEmbed("--force", "--force-geometry");
    expect(embeddedNote()).toBe(true);
    expect(embeddedCopy()).toEqual([]);
    expect(log).not.toContain(CANARY);
  }, 60_000);

  it("the doctor's sampled vector validation never re-embeds a copy a pre-upgrade run embedded", async () => {
    // Every row is embedded as `clawmem embed` does it, copies included (a v0.39 vault's state).
    const st = createStore(vault);
    try {
      seed(st);
      st.ensureVecTable(8);
      const rows = st.db.prepare("SELECT collection, path, title, hash FROM documents WHERE active = 1").all() as { collection: string; path: string; title: string; hash: string }[];
      for (const r of rows) {
        const body = (st.db.prepare("SELECT doc FROM content WHERE hash = ?").get(r.hash) as { doc: string }).doc;
        let meta: Record<string, any> | undefined;
        try { meta = parseDocument(body, r.path).meta as any; } catch { /* no frontmatter */ }
        splitDocument(body, meta).forEach((frag, seq) => {
          const text = formatDocForEmbedding(frag.content, frag.label || r.title);
          const fp = createHash("sha256").update(text, "utf8").digest("hex");
          st.insertEmbedding(r.hash, seq, frag.startLine, new Float32Array(vecFor(text)), "fake-embed", new Date().toISOString(),
            frag.type, frag.label ?? undefined, canonicalDocId(r.collection, r.path), undefined, fp);
        });
        st.markEmbedSynced(r.hash);
      }
      const summary = await runSampledVectorValidation(st, async (t: string) => {
        inputs.push(t);
        return { embedding: vecFor(t), model: "fake-embed" };
      });
      expect(summary.validated).toBeGreaterThan(0);        // the sampler re-embedded real rows (positive control)
      expect(embeddedNote()).toBe(true);
      expect(embeddedCopy()).toEqual([]);
      expect(summary.eligible).toBe(NOTES.length);          // one fragment per real note; no copy is eligible
    } finally { st.close(); }
  });
});
