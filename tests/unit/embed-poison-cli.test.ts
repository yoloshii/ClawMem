/**
 * BACKLOG 82.2, D2 + D3 — the REAL `clawmem embed` CLI against a scripted `/v1/embeddings`:
 * one binding per run; a poisoned response stops the run (exit 1); before anything destructive ONE admission rule;
 * what a stopped run leaves is defined. Each test fails on v0.43.6, which stores the poisoned vector and exits 0,
 * or clears the index after a dimension probe nobody validated.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { splitDocument } from "../../src/splitter.ts";
import { bow, deadPort, startEmbedFixture, type EmbedFixture, type Phase, type Script } from "../helpers/embed-readiness-fixture.ts";

import { seedContent } from "../helpers/seed-content.ts";
const ROOT = join(import.meta.dir, "../..");
const TAINT = "embed_geometry_taint";
const MARK = "zebrafish";
const SMALL = `A short note about the ${MARK} tank and its filter.`;
const section = (n: number) => `## Section ${n}\n\nThe ${MARK} in tank ${n} are fed twice a day and the water is changed weekly, every week.\n`;
const MULTI = `# Tank log\n\n${[1, 2, 3, 4].map(section).join("\n")}`;
const POISON = [null, ...new Array(63).fill(1)];

let home: string;
let vault: string;
let dead: number;
const fixtures: EmbedFixture[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "clawmem-822-")); vault = resolve(home, "vault.sqlite"); dead = deadPort(); });
afterEach(() => { for (const f of fixtures.splice(0)) f.stop(); rmSync(home, { recursive: true, force: true }); });

function fixture(opts: { script?: Script; item?: (at: { phase: Phase; nth: number; text: string; index: number }) => unknown }): EmbedFixture {
  const f = startEmbedFixture({ fragmentMark: MARK, ...opts });
  fixtures.push(f);
  return f;
}
function withStore<T>(fn: (s: Store) => T): T { const s = createStore(vault); try { return fn(s); } finally { s.close(); } }
function seedDoc(path: string, body: string, opts: { embedded?: boolean } = {}): string {
  return withStore(s => {
    const now = new Date().toISOString();
    const hash = hashContent(body);
    seedContent(s.db, hash, body, now);
    s.insertDocument("notes", path, path.replace(/\.md$/, ""), hash, now, now);
    if (opts.embedded) {
      s.ensureVecTable(64);
      s.insertEmbedding(hash, 0, 0, new Float32Array(bow(body)), "bow-embed", now, "full", undefined, canonicalDocId("notes", path));
      s.markEmbedSynced(hash);
    }
    return hash;
  });
}
async function embed(url: string, flags: string[] = [], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "embed", ...flags], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"), INDEX_PATH: vault,
      CLAWMEM_EMBED_URL: url, CLAWMEM_LLM_URL: `http://127.0.0.1:${dead}`, CLAWMEM_RERANK_URL: `http://127.0.0.1:${dead}`,
      CLAWMEM_NO_LOCAL_MODELS: "true", CLAWMEM_EMBED_WAIT: "0", ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}
const vectorKeys = () => withStore(s => (s.db.prepare(`SELECT hash || '_' || seq AS k FROM content_vectors ORDER BY 1`).all() as { k: string }[]).map(r => r.k));
const vecRows = () => withStore(s => s.getVectorConsistency().vvCount);
const taint = () => withStore(s => s.getVaultFlag(TAINT));
const doc = (path: string) => withStore(s => s.db.prepare(`SELECT embed_state, COALESCE(embed_attempts, 0) AS embed_attempts, embed_error FROM documents WHERE path = ?`).get(path) as
  { embed_state: string | null; embed_attempts: number; embed_error: string | null });
const baseline = () => withStore(s => JSON.stringify(s.db.prepare(`SELECT * FROM embed_canary ORDER BY 1, 2`).values()));
const worklist = () => withStore(s => s.getHashesNeedingFragments().map(h => h.path));

describe("before anything destructive — one admission rule", () => {
  it("--force with healthy canaries and a POISONED dimension probe: exit 1, the index is NOT cleared", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    const fx = fixture({ item: at => (at.phase === "dim" ? POISON : undefined) });
    const r = await embed(fx.url, ["--force"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Nothing was cleared");
    expect(vecRows()).toBe(1);
    expect(fx.count("fragment")).toBe(0);
    expect(taint()).toBeNull();
    // ...and no flag overrides a refused response.
    const forced = await embed(fx.url, ["--force", "--force-geometry"]);
    expect(forced.code).toBe(1);
    expect(vecRows()).toBe(1);
  }, 60_000);

  it("a model change between the canary probes and the dimension probe is fatal; nothing is cleared", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    const fx = fixture({ script: phase => (phase === "dim" ? { model: "other-model" } : undefined) });
    const r = await embed(fx.url, ["--force"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("model");
    expect(vecRows()).toBe(1);
    expect(fx.count("fragment")).toBe(0);
  }, 60_000);

  it("a dimension probe of another dimension than the canary probes' is fatal; nothing is cleared", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    const fx = fixture({ script: phase => (phase === "dim" ? { dim: 32 } : undefined) });
    const r = await embed(fx.url, ["--force"]);
    expect(r.code).toBe(1);
    expect(vecRows()).toBe(1);
    expect(fx.count("fragment")).toBe(0);
  }, 60_000);

  it("battery answered IN PART (unavailable) + a validated dimension probe + --force --force-geometry → clears, bound to the answered probes, and starts tainted", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    const fx = fixture({ script: (phase, nth) => (phase === "canary" && nth >= 4 ? { status: 503 } : undefined) });
    const r = await embed(fx.url, ["--force", "--force-geometry"]);
    expect(r.out).toContain("3 of 8");
    expect(fx.count("fragment")).toBeGreaterThan(0);
    expect(vecRows()).toBe(1);                               // cleared and rebuilt
    expect(taint()).toContain("no preflight validation");
    expect(r.code).toBe(1);                                  // an unverified rebuild is never success
  }, 60_000);

  it("the same without --force-geometry → aborts, nothing cleared", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    const fx = fixture({ script: (phase, nth) => (phase === "canary" && nth >= 4 ? { status: 503 } : undefined) });
    const r = await embed(fx.url, ["--force"]);
    expect(r.code).toBe(1);
    expect(fx.count("fragment")).toBe(0);
    expect(fx.count("dim")).toBe(0);
    expect(vecRows()).toBe(1);
    expect(taint()).toBeNull();
  }, 60_000);

  it("battery answered in part, then a dimension probe of ANOTHER dimension under --force --force-geometry → fatal mismatch, nothing cleared", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    const fx = fixture({ script: (phase, nth) => (phase === "canary" && nth >= 4 ? { status: 503 } : phase === "dim" ? { dim: 32 } : undefined) });
    const r = await embed(fx.url, ["--force", "--force-geometry"]);
    expect(r.code).toBe(1);
    expect(fx.count("fragment")).toBe(0);
    expect(vecRows()).toBe(1);
  }, 60_000);

  const malformedBatteries: [string, Parameters<typeof fixture>[0]][] = [
    ["a refused canary answer", { item: at => (at.phase === "canary" && at.nth === 3 ? POISON : undefined) }],
    ["a refused answer, then no answer", {
      item: at => (at.phase === "canary" && at.nth === 2 ? POISON : undefined),
      script: (phase, nth) => (phase === "canary" && nth >= 3 ? { status: 503 } : undefined),
    }],
    ["two answers of different dimensions, then no answer", {
      script: (phase, nth) => (phase === "canary" && nth === 2 ? { dim: 32 } : phase === "canary" && nth >= 3 ? { status: 503 } : undefined),
    }],
  ];
  for (const [label, opts] of malformedBatteries) {
    it(`${label} → malformed: --force-geometry does NOT proceed, with or without --force`, async () => {
      seedDoc("a.md", SMALL, { embedded: true });
      seedDoc("b.md", `Another note about the ${MARK} pond, still pending.`);
      for (const flags of [["--force", "--force-geometry"], ["--force-geometry"], ["--force", "--force-geometry", "--recalibrate-canary"]]) {
        const fx = fixture(opts);                       // a new endpoint per run: its request counters start at 1
        const r = await embed(fx.url, flags);
        expect(r.code).toBe(1);
        expect(r.out).toContain("malformed");
        expect(fx.count("fragment")).toBe(0);
        expect(fx.count("dim")).toBe(0);
      }
      expect(vecRows()).toBe(1);
      expect(taint()).toBeNull();
    }, 90_000);
  }
});

describe("a poisoned fragment stops the run — what it leaves is defined", () => {
  it("SINGLE-response mode, third fragment refused: exit 1, the two earlier fragments stay, the document is pending with its error and its attempt count as before, the taint is set, the old baseline is unchanged; after four such runs it is still in the worklist; a healthy retry leaves the taint set", async () => {
    expect(splitDocument(MULTI).length).toBeGreaterThanOrEqual(4);
    // A first healthy run over one small document: a verified end, a first baseline.
    const small = seedDoc("small.md", SMALL);
    const healthy = fixture({});
    expect((await embed(healthy.url)).code).toBe(0);
    const baselineBefore = baseline();
    expect(JSON.parse(baselineBefore).length).toBeGreaterThan(0);
    expect(taint()).toBeNull();

    const multi = seedDoc("multi.md", MULTI);
    const before = doc("multi.md");
    for (let run = 1; run <= 4; run++) {
      const fx = fixture({ item: at => (at.phase === "fragment" && at.nth === 3 ? POISON : undefined) });
      const r = await embed(fx.url);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Malformed embedding vector");
      expect(fx.count("fragment")).toBe(3);                                  // the run stopped at the refused one
      expect(vectorKeys()).toEqual([`${multi}_0`, `${multi}_1`, `${small}_0`].sort());   // the third was NOT stored
      const after = doc("multi.md");
      expect(after.embed_state).toBe("pending");
      expect(after.embed_error).toContain("Malformed embedding vector");
      expect(after.embed_attempts).toBe(before.embed_attempts);              // not charged: the endpoint failed
      expect(taint()).toContain("aborted");
      expect(baseline()).toBe(baselineBefore);
      expect(worklist()).toContain("multi.md");
    }
    // A plain retry against a healthy endpoint completes the document and does NOT clear the taint.
    const retry = await embed(healthy.url);
    expect(doc("multi.md").embed_state).toBe("synced");
    expect(taint()).toContain("aborted");
    expect(retry.out).not.toContain("Malformed");
  }, 180_000);

  it("BATCH mode, the third item of the SECOND batch refused: none of that batch is stored, the first batch stays; the same bookkeeping", async () => {
    const big = `# Big log\n\n${Array.from({ length: 55 }, (_, i) => section(i + 1)).join("\n")}`;
    const fragments = splitDocument(big).length;
    expect(fragments).toBeGreaterThan(52);
    const hash = seedDoc("big.md", big);
    const fx = fixture({ item: at => (at.phase === "fragment" && at.nth === 2 && at.index === 2 ? POISON : undefined) });
    const r = await embed(fx.url, [], { CLAWMEM_EMBED_API_KEY: "test-key", CLAWMEM_NO_LOCAL_MODELS: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Malformed embedding vector");
    expect(r.out).toContain("batch item 2");
    expect(fx.count("fragment")).toBe(2);
    const keys = vectorKeys();
    expect(keys.length).toBe(50);                                            // batch 1 stays, batch 2 stored nothing
    expect(keys.every(k => k.startsWith(hash))).toBe(true);
    expect(keys).not.toContain(`${hash}_50`);
    const after = doc("big.md");
    expect([after.embed_state, after.embed_attempts]).toEqual(["pending", 0]);
    expect(after.embed_error).toContain("Malformed embedding vector");
    expect(taint()).toContain("aborted");
    expect(worklist()).toContain("big.md");
  }, 120_000);

  it("the FIRST write of a refused run leaves both vector tables unchanged and sets no taint", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    seedDoc("multi.md", MULTI);
    const before = vectorKeys();
    const fx = fixture({ item: at => (at.phase === "fragment" && at.nth === 1 ? POISON : undefined) });
    const r = await embed(fx.url);
    expect(r.code).toBe(1);
    expect(vectorKeys()).toEqual(before);
    expect(vecRows()).toBe(1);
    expect(taint()).toBeNull();
    expect(doc("multi.md")).toMatchObject({ embed_state: "pending", embed_attempts: 0 });
  }, 60_000);

  it("a refused END-of-run probe: the vectors stay, the run exits 1 and the vault is marked unverified", async () => {
    seedDoc("small.md", SMALL);
    // The end-of-run verification probe is the 9th canary request.
    const fx = fixture({ item: at => (at.phase === "canary" && at.nth === 9 ? POISON : undefined) });
    const r = await embed(fx.url);
    expect(r.code).toBe(1);
    expect(vecRows()).toBe(1);
    expect(taint()).not.toBeNull();
    expect(JSON.parse(baseline()).length).toBe(0);            // no baseline is saved from an unverified run
  }, 60_000);

  it("a short vector still exits 1 by the old rule (compatibility control)", async () => {
    seedDoc("a.md", SMALL, { embedded: true });
    seedDoc("b.md", `Another note about the ${MARK} pond, still pending.`);
    const fx = fixture({ script: phase => (phase === "fragment" ? { dim: 32 } : undefined) });
    const r = await embed(fx.url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("dimension");
    expect(vecRows()).toBe(1);
  }, 60_000);
});
