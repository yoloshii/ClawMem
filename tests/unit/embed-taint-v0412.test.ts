/**
 * v0.41.2 (BACKLOG 68.3) — an embed run that stored no vector leaves the geometry taint alone; a destructive run and a
 * run that stored vectors keep today's rules; only a PASSING preflight clears the taint (DESIGN-v0412.md §2, T13).
 *
 * Baseline (v0.41.1, prod 2026-09-30): the timer's incremental `clawmem embed` ran while the embedding server was
 * down — every fragment failed, 0 vectors were written — and it still set `embed_geometry_taint`, which only a 99-minute
 * `embed --force` cleared. These run the REAL CLI against a fake `/v1/embeddings`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { createStore, canonicalDocId } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { canaryProbeInputs } from "../../src/canary.ts";

const ROOT = join(import.meta.dir, "../..");
const TAINT = "embed_geometry_taint";

/** Bag-of-words over 64 hashed buckets: shared words → nearby vectors. It passes the real canary (m_rel ≈ 0.14). */
function bow(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[createHash("sha256").update(w).digest()[0]! % 64] += 1;
  return v;
}

type Mode = { canary: "ok" | "fail" | "unavailable"; fragments: "ok" | "fail" };
let mode: Mode;
let home: string;
let vault: string;
let server: ReturnType<typeof Bun.serve>;
let deadPort: number;
const PROBES = new Set(canaryProbeInputs().values());

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-683-"));
  vault = resolve(home, "vault.sqlite");
  mode = { canary: "ok", fragments: "ok" };
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname !== "/v1/embeddings") return new Response("not found", { status: 404 });
      const body = await req.json() as { input: string | string[] };
      const list = Array.isArray(body.input) ? body.input : [body.input];
      const isProbe = list.some(t => PROBES.has(t));
      const isDim = list.some(t => t === "clawmem dimension probe");
      if (isProbe && mode.canary === "unavailable") return new Response("down", { status: 500 });
      if (!isProbe && !isDim && mode.fragments === "fail") return new Response("down", { status: 500 });
      // A FAILED canary: every text embeds to the same vector — no separation at all, perfectly stable.
      const embed = (t: string) => (isProbe && mode.canary === "fail" ? new Array(64).fill(1) : bow(t));
      return Response.json({ data: list.map((t, index) => ({ embedding: embed(t), index })), model: "bow-embed" });
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

/** One pending document (needs embedding); optionally a stale vector (no document) and a standing taint. */
function seed(opts: { stale?: boolean; taint?: string; embedded?: boolean } = {}): void {
  const st = createStore(vault);
  const now = new Date().toISOString();
  const body = "The ingest pipeline batches its writes in groups of five hundred to cut the fsync cost.";
  const hash = hashContent(body);
  st.insertContent(hash, body, now);
  st.insertDocument("notes", "pipeline.md", "pipeline", hash, now, now);
  if (opts.embedded) {
    st.ensureVecTable(64);
    st.insertEmbedding(hash, 0, 0, new Float32Array(bow(body)), "bow-embed", now, "full", undefined, canonicalDocId("notes", "pipeline.md"));
  }
  if (opts.stale) {
    st.ensureVecTable(64);
    st.insertEmbedding("0".repeat(64), 0, 0, new Float32Array(bow("gone")), "bow-embed", now, "full", undefined, canonicalDocId("notes", "gone.md"));
  }
  if (opts.taint) st.setVaultFlag(TAINT, opts.taint);
  st.close();
}

async function embed(url: string, ...flags: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "embed", ...flags], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"), INDEX_PATH: vault,
      CLAWMEM_EMBED_URL: url, CLAWMEM_LLM_URL: `http://127.0.0.1:${deadPort}`, CLAWMEM_RERANK_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_NO_LOCAL_MODELS: "true",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out + err };
}

const taintOf = () => {
  const st = createStore(vault);
  try { return st.getVaultFlag(TAINT); } finally { st.close(); }
};
const vectors = () => {
  const st = createStore(vault);
  try { return (st.db.prepare("SELECT COUNT(*) AS n FROM content_vectors").get() as { n: number }).n; } finally { st.close(); }
};

describe("v0.41.2 (BACKLOG 68.3) an embed run that wrote nothing leaves the taint alone", () => {
  it("work pending, the endpoint unreachable: every fragment fails, 0 written → exit 1, NO taint, stale removals reported", async () => {
    seed({ stale: true });
    const r = await embed(`http://127.0.0.1:${deadPort}`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("wrote 0 vectors");
    expect(r.out).toContain("removed 1 stale");
    expect(taintOf()).toBeNull();
  }, 60_000);

  it("the canary unavailable but fragments embed: ≥ 1 vector stored unvalidated → taint (today's rule)", async () => {
    seed();
    mode = { canary: "unavailable", fragments: "ok" };
    const r = await embed(`http://127.0.0.1:${server.port}`);
    expect(r.code).not.toBe(0);
    expect(vectors()).toBeGreaterThan(0);
    expect(taintOf()).toContain("no preflight validation");
  }, 60_000);

  it("a destructive --force --force-geometry run that cleared the index and stored nothing → taint (an incomplete rebuild)", async () => {
    seed({ embedded: true });
    mode = { canary: "unavailable", fragments: "fail" };
    const r = await embed(`http://127.0.0.1:${server.port}`, "--force", "--force-geometry");
    expect(r.code).not.toBe(0);
    expect(vectors()).toBe(0);
    expect(taintOf()).toContain("no preflight validation");
  }, 60_000);

  it("an overridden FAILED canary (--force --force-geometry) with a verified end does NOT clear a standing taint", async () => {
    seed({ taint: "old taint" });
    mode = { canary: "fail", fragments: "ok" };
    await embed(`http://127.0.0.1:${server.port}`, "--force", "--force-geometry");
    expect(vectors()).toBeGreaterThan(0);
    expect(taintOf()).toBe("old taint");
  }, 60_000);

  it("a passing --force with no failed fragment clears it", async () => {
    seed({ taint: "old taint" });
    mode = { canary: "ok", fragments: "ok" };
    const r = await embed(`http://127.0.0.1:${server.port}`, "--force");
    expect(r.code).toBe(0);
    expect(taintOf()).toBeNull();
  }, 60_000);
});
