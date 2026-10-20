/**
 * v0.43.5 (BACKLOG 77.1) — an embed run that meets an unreachable embed server (DESIGN-77.1 rev 3.2 §3, tests 1–9).
 *
 * Baseline (v0.43.4): a scheduled embed that starts while its embedding server is still down, with local fallback
 * off, puts the lane into the 60 s cooldown on the first failed request; every later request fails at once, the run
 * charges every pending document an attempt and writes 0 vectors. These run the REAL CLI against a scripted
 * `/v1/embeddings` server (tests/helpers/embed-readiness-fixture.ts).
 *
 * Tests 1–7 failed on v0.43.4's code on their target assertions; 8 and 9 are guards (unchanged behaviour). Each
 * test checks one object, so a failure shows every field that differs: the fixture-sequence fields (the scripted
 * failure happened) must hold on both versions and never count as the change under test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { hashContent } from "../../src/indexer.ts";
import { bow, deadPort, startEmbedFixture, type EmbedFixture } from "../helpers/embed-readiness-fixture.ts";

const ROOT = join(import.meta.dir, "../..");
const MARK = "quillfeather";
const BODY_A = `The ${MARK} ingest pipeline batches its writes in groups of five hundred to cut the fsync cost.`;
const BODY_B = `The ${MARK} scheduler retries failed jobs with exponential backoff and a jittered ceiling.`;
const BODY_E = `The ${MARK} archive keeps one compressed copy of every weekly report for two years.`;
const BODY_F = `The ${MARK} router sends read traffic to the nearest replica and writes to the primary.`;

let home: string;
let vault: string;
let fixtures: EmbedFixture[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "clawmem-771-"));
  vault = resolve(home, "vault.sqlite");
  fixtures = [];
  // Tests 4 and 9 allow the in-process fallback. Should a bug send a run there, this placeholder makes the model load
  // fail at once instead of downloading the default embedding model into the temp HOME.
  mkdirSync(join(home, ".cache", "qmd", "models"), { recursive: true });
  writeFileSync(join(home, ".cache", "qmd", "models", "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"), "not a model");
});

afterEach(() => {
  for (const f of fixtures) f.stop();
  rmSync(home, { recursive: true, force: true });
});

function fixture(opts: Parameters<typeof startEmbedFixture>[0]): EmbedFixture {
  const f = startEmbedFixture(opts);
  fixtures.push(f);
  return f;
}

function withStore<T>(fn: (st: Store) => T): T {
  const st = createStore(vault);
  try { return fn(st); } finally { st.close(); }
}

function putDoc(st: Store, path: string, body: string): string {
  const now = new Date().toISOString();
  const hash = hashContent(body);
  st.insertContent(hash, body, now);
  st.insertDocument("notes", path, path.replace(/\.md$/, ""), hash, now, now);
  return hash;
}

/** A document the worklist selects, already charged `attempts` failed runs. */
function seedPending(path: string, body: string, attempts = 0): void {
  withStore(st => {
    const hash = putDoc(st, path, body);
    st.db.prepare("UPDATE documents SET embed_state = 'pending', embed_attempts = ? WHERE hash = ?").run(attempts, hash);
  });
}

/** A synced document with one stored vector from `model` at `dim`. */
function seedEmbedded(path: string, body: string, model: string, dim = 64): void {
  withStore(st => {
    const hash = putDoc(st, path, body);
    st.ensureVecTable(dim);
    st.insertEmbedding(hash, 0, 0, new Float32Array(bow(body, dim)), model, new Date().toISOString(), "full", undefined, canonicalDocId("notes", path));
    st.db.prepare("UPDATE documents SET embed_state = 'synced', embed_attempts = 0 WHERE hash = ?").run(hash);
  });
}

/** A vector whose document is gone — the stale cleanup removes it. */
function seedStale(dim = 64): void {
  withStore(st => {
    st.ensureVecTable(dim);
    st.insertEmbedding("0".repeat(64), 0, 0, new Float32Array(bow("gone", dim)), "bow-embed", new Date().toISOString(), "full", undefined, canonicalDocId("notes", "gone.md"));
  });
}

function state() {
  return withStore(st => {
    const n = (sql: string) => (st.db.prepare(sql).get() as { n: number }).n;
    let baselines = 0;
    try { baselines = n("SELECT COUNT(*) AS n FROM embed_canary"); } catch { /* table absent: none */ }
    const docs = st.db.prepare("SELECT path, embed_state, embed_attempts FROM documents ORDER BY path").all() as
      { path: string; embed_state: string; embed_attempts: number }[];
    return {
      vectors: n("SELECT COUNT(*) AS n FROM content_vectors"),
      models: (st.db.prepare("SELECT DISTINCT model FROM content_vectors ORDER BY model").all() as { model: string }[]).map(r => r.model),
      baselines,
      attempts: (path: string) => docs.find(d => d.path === path)?.embed_attempts,
      synced: docs.filter(d => d.embed_state === "synced").length,
    };
  });
}

const STRIP = ["CLAWMEM_EMBED_API_KEY", "CLAWMEM_EMBED_MODEL", "CLAWMEM_EMBED_WAIT_SEC", "CLAWMEM_EMBED_WAIT_INTERVAL_MS", "CLAWMEM_EMBED_PROBE_TIMEOUT_MS", "CLAWMEM_NO_LOCAL_MODELS"];

async function embed(url: string, env: Record<string, string>, ...flags: string[]): Promise<{ code: number; out: string; ms: number }> {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of STRIP) delete base[k];
  const dead = `http://127.0.0.1:${deadPort()}`;
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "embed", ...flags], {
    cwd: ROOT,
    env: {
      ...base, HOME: home, CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"), INDEX_PATH: vault,
      CLAWMEM_EMBED_URL: url, CLAWMEM_LLM_URL: dead, CLAWMEM_RERANK_URL: dead, NO_COLOR: "1",
      ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out + err, ms: performance.now() - t0 };
}

const occurrences = (s: string, needle: string) => s.split(needle).length - 1;
/** A self-hosted server with local fallback forbidden — the shape the readiness wait applies to. */
const FALLBACK_OFF = { CLAWMEM_NO_LOCAL_MODELS: "true" };

describe("77.1 (a) startup readiness — self-hosted lane, local fallback off", () => {
  it("1: the server stays down for the whole budget → exit 1, 'did not become ready (last: transport)', nothing charged or cleaned", async () => {
    seedPending("a.md", BODY_A, 1);
    seedStale();
    const r = await embed(`http://127.0.0.1:${deadPort()}`, { ...FALLBACK_OFF, CLAWMEM_EMBED_WAIT_SEC: "1", CLAWMEM_EMBED_WAIT_INTERVAL_MS: "200" });
    const s = state();
    expect({
      code: r.code,
      notReady: /did not become ready within 1 s \(last: transport\)/.test(r.out),
      attempts: s.attempts("a.md"),
      staleKept: s.vectors,
      baselines: s.baselines,
    }).toEqual({ code: 1, notReady: true, attempts: 1, staleKept: 1, baselines: 0 });
  }, 60_000);

  it("2: the FIRST contact is reset, then the server answers → every document synced with the server's model, exit 0", async () => {
    seedPending("a.md", BODY_A);
    seedPending("b.md", BODY_B);
    const fx = fixture({ fragmentMark: MARK, resetRequest: n => n === 1 });
    const r = await embed(fx.url, { ...FALLBACK_OFF, CLAWMEM_EMBED_WAIT_SEC: "3", CLAWMEM_EMBED_WAIT_INTERVAL_MS: "200" });
    const s = state();
    expect({
      // fixture sequence — holds on both versions: one reset, of request 1, before the server had answered anything
      firstContactReset: fx.front.resets === 1 && fx.front.firstReset === 1 && fx.front.answersBeforeFirstReset === 0,
      code: r.code,
      synced: s.synced,
      models: s.models,
    }).toEqual({ firstContactReset: true, code: 0, synced: 2, models: ["bow-embed"] });
  }, 60_000);

  for (const status of [405, 501]) {
    it(`3: the endpoint answers HTTP ${status} (a squatted port) → stops at once, squatted-port wording once, no cooldown clause, no attempt charged`, async () => {
      seedPending("a.md", BODY_A, 1);
      const fx = fixture({ fragmentMark: MARK, script: () => ({ status }) });
      const r = await embed(fx.url, { ...FALLBACK_OFF, CLAWMEM_EMBED_WAIT_SEC: "20", CLAWMEM_EMBED_WAIT_INTERVAL_MS: "200" });
      expect({
        answered: fx.seen.length > 0 && fx.seen.every(x => x.status === status),   // fixture sequence
        code: r.code,
        fast: r.ms < 8_000,
        squattedLines: occurrences(r.out, "answers HTTP but not the embeddings API"),
        cooldownClause: r.out.includes("so the fallback path engages"),
        attempts: state().attempts("a.md"),
      }).toEqual({ answered: true, code: 1, fast: true, squattedLines: 1, cooldownClause: false, attempts: 1 });
    }, 60_000);
  }
});

describe("77.1 (b) a non-force run binds the vault's one stored model", () => {
  it("4: fallback allowed; the dimension probe gets one 503, then the server serves another model at the same dimension → exit 1, nothing of it stored", async () => {
    seedEmbedded("e.md", BODY_E, "bow-a");
    seedPending("a.md", BODY_A);
    const fx = fixture({
      fragmentMark: MARK,
      script: (phase, nth) => phase === "canary" ? { model: "bow-a" } : phase === "dim" && nth === 1 ? { status: 503 } : { model: "bow-b" },
    });
    const r = await embed(fx.url, { CLAWMEM_NO_LOCAL_MODELS: "false" });
    expect({
      dim503: fx.seen.some(x => x.phase === "dim" && x.status === 503),   // fixture sequence
      localFallback: r.out.includes("in-process fallback"),              // never taken here, on either version
      code: r.code,
      mismatch: r.out.includes("Embedding model changed mid-run") && r.out.includes("bow-b"),
      storedB: state().models.includes("bow-b"),
    }).toEqual({ dim503: true, localFallback: false, code: 1, mismatch: true, storedB: false });
  }, 60_000);
});

describe("77.1 (c) exit codes", () => {
  const drift = [
    { name: "dimension drift (32 → 64)", said: "Embedding dimension changed (32 → 64)", model: undefined as string | undefined,
      seed: () => seedEmbedded("e.md", BODY_E, "bow-embed", 32) },
    { name: "model drift (bow-a → bow-b)", said: "Embedding model changed (bow-a → bow-b)", model: "bow-b",
      seed: () => seedEmbedded("e.md", BODY_E, "bow-a") },
    { name: "mixed stored models", said: "Vault already contains mixed embedding models", model: "bow-a",
      seed: () => { seedEmbedded("e.md", BODY_E, "bow-a"); seedEmbedded("f.md", BODY_F, "bow-c"); } },
  ];
  for (const d of drift) {
    it(`5: non-force ${d.name} → exit 1, nothing cleared or written`, async () => {
      d.seed();
      seedPending("a.md", BODY_A);
      const before = state().vectors;
      const fx = fixture({ fragmentMark: MARK, model: d.model });
      const r = await embed(fx.url, FALLBACK_OFF);
      const s = state();
      expect({
        said: r.out.includes(d.said),
        code: r.code,
        vectors: s.vectors,
        attempts: s.attempts("a.md"),
        fragments: fx.count("fragment"),
      }).toEqual({ said: true, code: 1, vectors: before, attempts: 0, fragments: 0 });
    }, 60_000);
  }

  it("6: --force, the canary passes, the dimension probe gets HTTP 503 → exit 1, nothing cleared", async () => {
    seedEmbedded("e.md", BODY_E, "bow-embed");
    seedPending("a.md", BODY_A);
    const fx = fixture({ fragmentMark: MARK, script: (phase, nth) => (phase === "dim" && nth === 1 ? { status: 503 } : undefined) });
    const r = await embed(fx.url, FALLBACK_OFF, "--force");
    expect({
      dim503: fx.seen.some(x => x.phase === "dim" && x.status === 503),   // fixture sequence
      said: r.out.includes("Force re-embed aborted"),
      code: r.code,
      vectors: state().vectors,
    }).toEqual({ dim503: true, said: true, code: 1, vectors: 1 });
  }, 60_000);

  it("7: work scheduled, its only fragment gets HTTP 413, the canary and the end probe pass → exit 1, 'No documents were embedded'", async () => {
    seedPending("a.md", BODY_A);
    const fx = fixture({ fragmentMark: MARK, script: (phase, nth) => (phase === "fragment" && nth === 1 ? { status: 413 } : undefined) });
    const r = await embed(fx.url, FALLBACK_OFF);
    expect({
      frag413: fx.seen.some(x => x.phase === "fragment" && x.status === 413),   // fixture sequence
      endProbe: fx.count("canary") === 9,                                       // the battery's 8 + the end probe
      readiness: fx.count("other"),                                             // positive control for test 9's classifier
      said: r.out.includes("No documents were embedded: 1 scheduled, 0 vectors written."),
      code: r.code,
    }).toEqual({ frag413: true, endProbe: true, readiness: 1, said: true, code: 1 });
  }, 60_000);
});

describe("77.1 guards (unchanged behaviour)", () => {
  it("8: a verified no-work run exits 0; a no-work run whose end verification fails exits 1", async () => {
    seedEmbedded("e.md", BODY_E, "bow-embed");
    const ok = await embed(fixture({ fragmentMark: MARK }).url, FALLBACK_OFF);
    expect({ code: ok.code, noWork: ok.out.includes("All documents already embedded") }).toEqual({ code: 0, noWork: true });

    const fx = fixture({ fragmentMark: MARK, script: (phase, nth) => (phase === "canary" && nth === 9 ? { status: 500 } : undefined) });
    const bad = await embed(fx.url, FALLBACK_OFF);
    expect({
      endFailed: fx.seen.some(x => x.phase === "canary" && x.status === 500),   // fixture sequence
      code: bad.code,
      said: bad.out.includes("end-of-run geometry verification FAILED"),
    }).toEqual({ endFailed: true, code: 1, said: true });
  }, 60_000);

  it("9: no readiness request on the stock lane (fallback allowed) or the cloud lane; a bad wait knob there changes nothing", async () => {
    seedPending("a.md", BODY_A);
    const stock = fixture({ fragmentMark: MARK });
    const r1 = await embed(stock.url, { CLAWMEM_NO_LOCAL_MODELS: "false", CLAWMEM_EMBED_WAIT_SEC: "abc" });
    expect({ code: r1.code, fragments: stock.count("fragment") > 0, readiness: stock.count("other"), localFallback: r1.out.includes("in-process fallback") })
      .toEqual({ code: 0, fragments: true, readiness: 0, localFallback: false });

    seedPending("b.md", BODY_B);
    const cloud = fixture({ fragmentMark: MARK });
    const r2 = await embed(cloud.url, { ...FALLBACK_OFF, CLAWMEM_EMBED_API_KEY: "test-key", CLAWMEM_EMBED_WAIT_INTERVAL_MS: "0" });
    expect({ code: r2.code, fragments: cloud.count("fragment") > 0, readiness: cloud.count("other") })
      .toEqual({ code: 0, fragments: true, readiness: 0 });
  }, 60_000);
});
