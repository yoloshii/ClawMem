/**
 * BACKLOG 82.2, D5 — the REAL commands: `clawmem repair vectors [--vault <name>] [--run] [--limit N] [--json]` and the
 * doctor's "Stored vectors" and "Canary baseline" lines.
 *  Exits of `repair vectors`: 0 nothing to do in either phase / both phases completed; 1 something to do (dry run),
 *  a run stopped by `--limit`, or a failed run; 2 usage.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, type Store } from "../../src/store.ts";
import { acquireWorkerLease } from "../../src/worker-lease.ts";
import { BAD, HEALTHY, addDocument, hashOf, keyOf, setVector, now } from "../helpers/vector-health-vault.ts";

const ROOT = join(import.meta.dir, "../..");
let home: string;
let vault: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "clawmem-822-repair-")); vault = join(home, "vault.sqlite"); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function withStore<T>(fn: (s: Store) => T): T { const s = createStore(vault); try { return fn(s); } finally { s.close(); } }
function seed(docs: Record<string, readonly (readonly number[])[]>): Record<string, number> {
  return withStore(s => {
    s.ensureVecTable(2);
    const ids: Record<string, number> = {};
    for (const [name, vectors] of Object.entries(docs)) ids[name] = addDocument(s, name, vectors);
    return ids;
  });
}
function relate(source: number, target: number, weight: unknown, type = "semantic"): void {
  withStore(s => s.db.prepare(`INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(source, target, type, weight as never, now()));
}
function clawmem(...args: string[]): { code: number; out: string; err: string } {
  const env = { ...process.env } as Record<string, string>;
  env.HOME = home;
  env.INDEX_PATH = vault;
  env.CLAWMEM_NO_LOCAL_MODELS = "true";
  env.CLAWMEM_EMBED_URL = "http://127.0.0.1:1";
  env.CLAWMEM_LLM_URL = "http://127.0.0.1:1";
  env.CLAWMEM_RERANK_URL = "http://127.0.0.1:1";
  env.NO_COLOR = "1";
  const proc = Bun.spawnSync([process.execPath, "src/clawmem.ts", ...args], { env, cwd: ROOT });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}
const state = () => withStore(s => ({
  vectors: (s.db.prepare(`SELECT hash_seq FROM vectors_vec ORDER BY hash_seq`).all() as { hash_seq: string }[]).map(r => r.hash_seq),
  metadata: (s.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get() as { n: number }).n,
  pending: (s.db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE embed_state = 'pending'`).get() as { n: number }).n,
  relations: (s.db.prepare(`SELECT COUNT(*) AS n FROM memory_relations`).get() as { n: number }).n,
}));

describe("clawmem repair vectors", () => {
  it("the dry run lists BOTH phases, changes nothing and exits 1", () => {
    const ids = seed({ good: [HEALTHY], zero: [BAD.zero], other: [HEALTHY] });
    relate(ids.good!, ids.other!, Infinity);
    const before = state();
    const r = clawmem("repair", "vectors");
    expect(r.code).toBe(1);
    expect(r.out).toContain("VECTORS");
    expect(r.out).toContain("RELATIONS");
    expect(r.out).toContain(`${keyOf("zero")}  unsupported-norm`);
    expect(r.out).toMatch(/1 document row\(s\)/);
    expect(r.out).toContain("Infinity");
    expect(r.out).toMatch(/Dry run: nothing was changed/);
    expect(state()).toEqual(before);
  });

  it("the dry run opens the vault read-only: no schema work is done on it", () => {
    seed({ zero: [BAD.zero] });
    const { Database } = require("bun:sqlite");
    const present = () => {
      const db = new Database(vault, { readonly: true });
      try { return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_flags'`).get(); } finally { db.close(); }
    };
    // `vault_flags` is a table every writable open of the store creates again; drop it through a raw handle
    const raw = new Database(vault);
    raw.exec(`DROP TABLE IF EXISTS vault_flags`);
    raw.close();
    expect(present()).toBe(false);
    expect(clawmem("repair", "vectors").code).toBe(1);
    expect(present()).toBe(false);
    expect(clawmem("repair", "vectors", "--json").code).toBe(1);
    expect(present()).toBe(false);
  });

  it("exits 1 on a dry run when only a bad relation exists, and 0 when nothing is to do", () => {
    const ids = seed({ a: [HEALTHY], b: [HEALTHY] });
    expect(clawmem("repair", "vectors").code).toBe(0);
    relate(ids.a!, ids.b!, 1.15);
    const r = clawmem("repair", "vectors");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/0 stored vector\(s\) not usable/);
  });

  it("`--json` is one object with both phases", () => {
    const ids = seed({ good: [HEALTHY], nan: [BAD.nan] });
    relate(ids.good!, ids.nan!, -0.5);
    const r = clawmem("repair", "vectors", "--json");
    expect(r.code).toBe(1);
    const reply = JSON.parse(r.out);
    expect(reply).toMatchObject({
      run: false, exit: 1,
      vectors: { status: "pending", bad: 1, documentsReset: 1, list: [{ hashSeq: keyOf("nan"), kind: "non-finite", orphan: false }] },
      relations: { status: "nothing", invalid: 0, negativeKept: 1, unresolved: 1 },
    });
    expect(typeof reply.vault).toBe("string");
  });

  it("`--run` removes the vector and its metadata row, sets the document pending, deletes the bad relation, exits 0", () => {
    const ids = seed({ good: [HEALTHY], zero: [BAD.zero], other: [HEALTHY] });
    relate(ids.good!, ids.other!, Infinity);
    relate(ids.good!, ids.zero!, 0.9);
    const r = clawmem("repair", "vectors", "--run");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deleted 1/);
    expect(r.out).toMatch(/clawmem embed/);
    const after = state();
    expect(after.vectors).toEqual([keyOf("good"), keyOf("other")].sort());
    expect(after.metadata).toBe(2);
    expect(after.pending).toBe(1);
    expect(after.relations).toBe(1);
    // the lease was released: a second run is not refused, and has nothing to do
    const again = clawmem("repair", "vectors", "--run");
    expect(again.code).toBe(0);
    expect(again.out).not.toMatch(/lease/i);
    expect(clawmem("repair", "vectors").code).toBe(0);
  });

  it("`--run --limit 1` with two bad vectors deletes one, does not run the relation phase, says so, exits 1", () => {
    const ids = seed({ a: [BAD.zero], b: [BAD.nan], good: [HEALTHY], other: [HEALTHY] });
    relate(ids.good!, ids.other!, Infinity);
    const r = clawmem("repair", "vectors", "--run", "--limit", "1");
    expect(r.code).toBe(1);
    expect(r.out).toContain("relations: not run — vector phase incomplete");
    const after = state();
    expect(after.vectors.length).toBe(3);
    expect(after.relations).toBe(1);
  });

  it("refuses to run while another process holds the embedding lease, and changes nothing", () => {
    seed({ zero: [BAD.zero] });
    withStore(s => { expect(acquireWorkerLease(s, "embedding", 600_000).acquired).toBe(true); });
    const before = state();
    const r = clawmem("repair", "vectors", "--run");
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/lease/i);
    expect(state()).toEqual(before);
    expect(clawmem("repair", "vectors").code).toBe(1);                       // the dry run needs no lease
  });

  it("usage errors exit 2 and change nothing", () => {
    seed({ zero: [BAD.zero] });
    const before = state();
    for (const args of [["--limit", "x"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "2"], ["--bogus"], ["extra"], ["--vault", "no-such-vault"]]) {
      const r = clawmem("repair", "vectors", ...args);
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
    }
    expect(state()).toEqual(before);
  });

  it("is in the help text", () => {
    expect(clawmem("help").out + clawmem("help").err).toContain("clawmem repair vectors");
  });
});

describe("clawmem doctor", () => {
  it("reports stored vectors that are not usable, among those examined, and counts the issue", () => {
    const issues = (out: string) => Number(/(\d+) issue\(s\) found/.exec(out)?.[1] ?? 0);
    seed({ good: [HEALTHY], zero: [BAD.zero] });
    withStore(s => setVector(s, keyOf("zero"), HEALTHY));
    const healthy = issues(clawmem("doctor").out);                           // what this bare vault counts without a bad vector
    withStore(s => setVector(s, keyOf("zero"), BAD.zero));
    const r = clawmem("doctor");
    expect(issues(r.out)).toBe(healthy + 1);
    expect(r.out).toMatch(/✗ Stored vectors: 1 bad among 2 examined of 2 — unsupported-norm 1/);
    expect(r.out).toContain(keyOf("zero"));
    expect(r.out).toContain("clawmem repair vectors");
    expect(r.code).not.toBe(0);
  });

  it("a healthy vault gets the count line of a sample", () => {
    seed({ good: [HEALTHY], other: [HEALTHY] });
    const r = clawmem("doctor");
    expect(r.out).toMatch(/✓ Stored vectors: 0 bad among 2 examined of 2/);
    expect(r.out).toContain("--full");
  });

  it("`--full` finds a vector row that has no metadata row", () => {
    seed({ good: [HEALTHY] });
    withStore(s => setVector(s, "stray-bad_0", BAD.nan));
    const sampled = clawmem("doctor");
    expect(sampled.out).toMatch(/Stored vectors: 0 bad among 1 examined of 1/);
    const full = clawmem("doctor", "--full");
    expect(full.out).toMatch(/✗ Stored vectors: 1 bad among 2 examined of 1 — non-finite 1/);
    expect(full.out).toContain("stray-bad_0  non-finite  (no metadata row)");
    expect(full.out).toMatch(/1 orphan vector row/);
  });

  it("a scan that cannot examine says so and counts the issue — it is not a finding", () => {
    seed({ good: [HEALTHY] });
    withStore(s => { s.db.exec(`DROP TABLE vectors_vec`); s.db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, other TEXT)`); });
    const r = clawmem("doctor");
    expect(r.out).toMatch(/✗ Stored vectors: could not examine/);
    expect(r.out).not.toMatch(/Stored vectors: \d+ bad/);
  });

  it("a damaged stored canary baseline is a failure line, not a crash", () => {
    seed({ good: [HEALTHY] });
    withStore(s => s.db.prepare(`INSERT INTO embed_canary (probe_id, profile_key, embedding, pair_margins, embedded_at) VALUES ('p1', 'profile-a', ?, '{}', ?)`)
      .run(new Float32Array([NaN, 1]), now()));
    const r = clawmem("doctor");
    expect(r.out).toMatch(/✗ Canary baseline: damaged/);
    expect(r.out).toContain("profile-a");
    expect(r.out).toContain("--recalibrate-canary");
    expect(r.out).toContain("Stored vectors:");                              // the doctor went on
    // a healthy baseline gets no failure line
    withStore(s => s.db.exec(`DELETE FROM embed_canary`));
    withStore(s => s.db.prepare(`INSERT INTO embed_canary (probe_id, profile_key, embedding, pair_margins, embedded_at) VALUES ('p1', 'profile-a', ?, '{"m":0.5}', ?)`)
      .run(new Float32Array([0.6, 0.8]), now()));
    expect(clawmem("doctor").out).not.toMatch(/Canary baseline: damaged/);
    expect(hashOf("good").length).toBeGreaterThan(8);
  });
});
