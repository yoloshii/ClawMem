/**
 * 76.3 `clawmem repair entities` — the command line (a subprocess): which vault an invocation reaches, and the report.
 *
 * Bugs these tests catch:
 * - an apply or restore without --vault, or one that writes a vault other than the one it names;
 * - `--vault general` reaching the default index while the config names another file "general";
 * - one database listed, planned and selectable twice under two names;
 * - a report that hides a triple's old → new endpoints, or an applied new triple's id.
 *
 * Every run gets its own config directory with no config.yaml, so only CLAWMEM_VAULTS names vaults.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, type Store } from "../../src/store.ts";
import { seedDocuments } from "../helpers/test-store.ts";
import { makeEntityId } from "../../src/entity.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "clawmem-763-cli-"));
  dirs.push(d);
  return d;
}

function entity(s: Store, name: string, type: string): string {
  const id = makeEntityId(name, type);
  s.db.prepare(`
    INSERT INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
    VALUES (?, ?, ?, NULL, datetime('now'), 0, datetime('now'), 'default')
  `).run(id, type, name);
  s.db.prepare(`INSERT INTO entities_fts (entity_id, name, entity_type) VALUES (?, ?, ?)`).run(id, name.toLowerCase(), type);
  return id;
}

/** A vault holding one wrong link: the fact "Node 200 runs_on Linux" filed under `into`. */
function vaultFile(dir: string, name: string, into = "Node 202"): { path: string; t: number } {
  const path = join(dir, `${name}.sqlite`);
  const s = createStore(path);
  try {
    const wrong = entity(s, into, "service");
    const linux = entity(s, "Linux", "concept");
    const [doc] = seedDocuments(s, [{ path: `notes/${name}.md`, title: name, body: `notes on ${name}` }]);
    return { path, t: s.addTriple(wrong, "runs_on", linux, null, { sourceDocId: doc, sourceFact: "Node 200 runs_on Linux" }) };
  } finally {
    s.db.close();
  }
}

function cli(env: { index: string; vaults: Record<string, string> }, ...args: string[]) {
  const { CLAWMEM_VAULTS: _ignored, ...inherited } = Bun.env;
  const r = Bun.spawnSync({
    cmd: ["bun", "src/clawmem.ts", "repair", "entities", ...args],
    cwd: REPO_ROOT,
    env: {
      ...inherited,
      INDEX_PATH: env.index,
      CLAWMEM_CONFIG_DIR: scratch(),
      CLAWMEM_VAULTS: JSON.stringify(env.vaults),
      CLAWMEM_NO_LOCAL_MODELS: "true",
      CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
      CLAWMEM_LLM_URL: "http://127.0.0.1:1",
      CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function subjectOf(path: string, t: number): string {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`SELECT subject_entity_id AS s FROM entity_triples WHERE id = ?`).get(t) as { s: string }).s;
  } finally {
    db.close();
  }
}

type DryJson = { vaults: { vault: string; plan: { digest: string; answers: { from: string; to: string }[] } }[] };
const n200 = makeEntityId("Node 200", "service");
const n202 = makeEntityId("Node 202", "service");
const n203 = makeEntityId("Node 203", "service");

describe("repair entities: which vault", () => {
  it("--apply and --restore need --vault, and write nothing without it", () => {
    const a = vaultFile(scratch(), "a");
    for (const args of [["--apply"], ["--restore", "er-none"]]) {
      const r = cli({ index: a.path, vaults: {} }, ...args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--vault");
    }
    expect(subjectOf(a.path, a.t)).toBe(n202);
  }, 30_000);

  it("two vaults get two plans; an apply writes only the vault it names", () => {
    const dir = scratch();
    const a = vaultFile(dir, "a", "Node 202");
    const b = vaultFile(dir, "b", "Node 203");
    const env = { index: a.path, vaults: { b: b.path } };
    const dry = cli(env, "--json");
    expect(dry.code).toBe(0);
    const plans = (JSON.parse(dry.out) as DryJson).vaults;
    expect(plans.map(p => [p.vault, p.plan.answers.map(x => [x.from, x.to])])).toEqual([["general", [[n202, n200]]], ["b", [[n203, n200]]]]);
    expect(plans[0]!.plan.digest).not.toBe(plans[1]!.plan.digest);
    const applied = cli(env, "--apply", "--vault", "b", "--expect", plans[1]!.plan.digest);
    expect(applied.code).toBe(0);
    expect(subjectOf(b.path, b.t)).toBe(n200);
    expect(subjectOf(a.path, a.t)).toBe(n202);
  }, 30_000);

  it("--vault general reaches the vault the config names general; the default index is then default-index", () => {
    const dir = scratch();
    const a = vaultFile(dir, "a", "Node 202");
    const c = vaultFile(dir, "c", "Node 203");
    const env = { index: a.path, vaults: { general: c.path } };
    const dry = cli(env, "--json");
    expect(dry.code).toBe(0);
    const plans = (JSON.parse(dry.out) as DryJson).vaults;
    expect(plans.map(p => [p.vault, p.plan.answers.map(x => x.from)])).toEqual([["default-index", [n202]], ["general", [n203]]]);
    expect(cli(env, "--apply", "--vault", "general", "--expect", plans[1]!.plan.digest).code).toBe(0);
    expect(subjectOf(c.path, c.t)).toBe(n200);
    expect(subjectOf(a.path, a.t)).toBe(n202);
    expect(cli(env, "--apply", "--vault", "default-index", "--expect", plans[0]!.plan.digest).code).toBe(0);
    expect(subjectOf(a.path, a.t)).toBe(n200);
  }, 30_000);

  it("the default index's name never takes a configured vault's", () => {
    const dir = scratch();
    const a = vaultFile(dir, "a");
    const c = vaultFile(dir, "c");
    const d = vaultFile(dir, "d");
    const dry = cli({ index: a.path, vaults: { general: c.path, "default-index": d.path } }, "--json");
    expect(dry.code).toBe(0);
    expect((JSON.parse(dry.out) as DryJson).vaults.map(p => p.vault)).toEqual(["default-index-2", "general", "default-index"]);
  }, 30_000);

  it("a configured name for the default index lists that database once, and selects it", () => {
    const a = vaultFile(scratch(), "a");
    const env = { index: a.path, vaults: { main: a.path } };
    const dry = cli(env, "--json");
    expect(dry.code).toBe(0);
    const plans = (JSON.parse(dry.out) as DryJson).vaults;
    expect(plans.map(p => p.vault)).toEqual(["general"]);
    expect(cli(env, "--apply", "--vault", "main", "--expect", plans[0]!.plan.digest).code).toBe(0);
    expect(subjectOf(a.path, a.t)).toBe(n200);
  }, 30_000);
});

describe("repair entities: the report", () => {
  it("shows each triple's old → new endpoints, the links acted on and held, and an applied new triple's id", () => {
    const path = join(scratch(), "split.sqlite");
    const s = createStore(path);
    let t = 0;
    try {
      const wrong = entity(s, "Node 202", "service");
      const linux = entity(s, "Linux", "concept");
      const [d1, d2] = seedDocuments(s, [{ path: "notes/a.md", title: "a", body: "a" }, { path: "notes/b.md", title: "b", body: "b" }]);
      t = s.addTriple(wrong, "runs_on", linux, null, { sourceDocId: d1, sourceFact: "Node 200 runs_on Linux" });
      s.addTriple(wrong, "runs_on", linux, null, { sourceDocId: d2, sourceFact: "Node 201 runs_on Linux" });
      s.db.prepare(`UPDATE entity_triple_provenance SET created_at = '2026-10-01T08:00:00.000Z' WHERE source_fact LIKE 'Node 200%'`).run(); // first in sighting order
      s.db.prepare(`UPDATE entity_triple_provenance SET created_at = '2026-10-02T08:00:00.000Z' WHERE source_fact LIKE 'Node 201%'`).run();
    } finally {
      s.db.close();
    }
    const env = { index: path, vaults: {} };
    const n201 = makeEntityId("Node 201", "service");
    const linux = makeEntityId("Linux", "concept");
    const dry = cli(env);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("links acted on R1 2 (digits differ), R2 0 (another exact name), held 0");
    expect(dry.out).toContain(`triple re-point #${t} (runs_on): #${t} subject ${n202} → ${n200}, object ${linux}`);
    expect(dry.out).toContain(`triple new from #${t} (runs_on): #${t} subject ${n202} → ${n201}, object ${linux}`);
    const applied = cli(env, "--apply", "--vault", "general");
    expect(applied.code).toBe(0);
    const db = new Database(path, { readonly: true });
    const fresh = (db.prepare(`SELECT id FROM entity_triples WHERE subject_entity_id = ?`).get(n201) as { id: number }).id;
    db.close();
    expect(applied.out).toContain(`triple new #${fresh} from #${t} (runs_on): #${t} subject ${n202} → ${n201}, object ${linux}`);
  }, 30_000);
});
