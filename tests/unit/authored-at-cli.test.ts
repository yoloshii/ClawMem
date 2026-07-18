import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * §51.1 D10 — mine identity + backfill CLI lane (subprocess, real pipeline).
 *
 * Covers: per-source collision suffixing with no silent overwrite; legacy
 * (non-colliding) names preserved; authored_at captured from exchange
 * timestamps through staging→index; SOURCE-level suffix persistence (partner
 * removed + transcript grown → new chunks still suffixed); the recoverable-only
 * backfill (dry-run default, --apply metadata-only, idempotent, body-mismatch
 * skip); and --backfill-dates exclusivity. Subprocess endpoints are unroutable
 * on purpose — the host runs real inference servers on the default ports.
 */

import { mkdirSync, rmSync, writeFileSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { createStore } from "../../src/store.ts";
import { enrichResults } from "../../src/search-utils.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const TEST_DB = "/tmp/clawmem-authored-cli-test.sqlite";
const SRC = `/tmp/clawmem-authored-cli-src-${Date.now()}`;

const cliEnv = {
  ...Bun.env,
  INDEX_PATH: TEST_DB,
  CLAWMEM_NO_LOCAL_MODELS: "true",
  CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
  CLAWMEM_LLM_URL: "http://127.0.0.1:1",
  CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
};

const runMine = (...args: string[]) =>
  Bun.spawnSync({ cmd: ["bun", "src/clawmem.ts", "mine", SRC, "-c", "convos", ...args], cwd: REPO_ROOT, env: cliEnv, stdout: "pipe", stderr: "pipe" });

function ccLine(type: "human" | "assistant", ts: string | null, content: string): string {
  return JSON.stringify({ type, ...(ts ? { timestamp: ts } : {}), message: { content } });
}

function ccTranscript(exchanges: Array<{ q: string; a: string; qTs?: string; aTs?: string }>): string {
  const lines: string[] = [];
  for (const e of exchanges) {
    lines.push(ccLine("human", e.qTs ?? null, e.q));
    lines.push(ccLine("assistant", e.aTs ?? null, e.a));
  }
  return lines.join("\n") + "\n";
}

const hash8 = (relPosix: string) => createHash("sha256").update(relPosix).digest("hex").slice(0, 8);

const dbRows = (): Array<{ path: string; authored_at: string | null; modified_at: string; active: number }> => {
  const db = new Database(TEST_DB, { readonly: true });
  try {
    return db.prepare(`SELECT path, authored_at, modified_at, active FROM documents WHERE collection = 'convos' ORDER BY path`).all() as any;
  } finally { db.close(); }
};

beforeAll(() => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  rmSync(SRC, { recursive: true, force: true });
  mkdirSync(join(SRC, "a"), { recursive: true });

  // Colliding pair: both sanitize to "a_b".
  writeFileSync(join(SRC, "a", "b.jsonl"), ccTranscript([
    { q: "nested source first question body", a: "nested source first answer body", qTs: "2025-03-01T10:00:00Z", aTs: "2025-03-01T10:05:00Z" },
  ]));
  writeFileSync(join(SRC, "a_b.jsonl"), ccTranscript([
    { q: "flat source first question body", a: "flat source first answer body", qTs: "2025-04-01T09:00:00Z", aTs: "2025-04-01T09:02:00Z" },
  ]));
  // Non-colliding, dated (two exchanges) — keeps its legacy staging name.
  writeFileSync(join(SRC, "solo.jsonl"), ccTranscript([
    { q: "solo exchange zero question body", a: "solo exchange zero answer body", qTs: "2025-05-01T08:00:00Z", aTs: "2025-05-01T08:10:00Z" },
    { q: "solo exchange one question body", a: "solo exchange one answer body", qTs: "2025-05-02T08:00:00Z", aTs: "2025-05-02T08:05:00Z" },
  ]));
  // Undated transcript — chunks stay NULL.
  writeFileSync(join(SRC, "nodate.jsonl"), ccTranscript([
    { q: "undated exchange question body here", a: "undated exchange answer body here" },
  ]));
});

afterAll(() => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  rmSync(SRC, { recursive: true, force: true });
});

describe("mine identity + authored_at capture (D10/D3/D4 e2e)", () => {
  it("suffixes colliding sources (no silent overwrite), keeps legacy names for the rest, and dates chunks from exchange timestamps", () => {
    const res = runMine();
    expect(res.exitCode).toBe(0);

    const rows = dbRows();
    const paths = rows.map(r => r.path);

    // Both collision members exist under DISTINCT suffixed names; the bare name never appears.
    const nestedBase = `a_b-h${hash8("a/b.jsonl")}`;
    const flatBase = `a_b-h${hash8("a_b.jsonl")}`;
    expect(paths).toContain(`${nestedBase}_0000.md`);
    expect(paths).toContain(`${flatBase}_0000.md`);
    expect(paths.some(p => /^a_b_\d{4}\.md$/.test(p))).toBe(false);

    // Non-colliding sources keep the legacy namespace.
    expect(paths).toContain("solo_0000.md");
    expect(paths).toContain("solo_0001.md");
    expect(paths).toContain("nodate_0000.md");

    // authored_at = max timestamp within each exchange; undated stays NULL.
    const byPath = new Map(rows.map(r => [r.path, r]));
    expect(byPath.get("solo_0000.md")!.authored_at).toBe("2025-05-01T08:10:00.000Z");
    expect(byPath.get("solo_0001.md")!.authored_at).toBe("2025-05-02T08:05:00.000Z");
    expect(byPath.get(`${nestedBase}_0000.md`)!.authored_at).toBe("2025-03-01T10:05:00.000Z");
    expect(byPath.get("nodate_0000.md")!.authored_at).toBeNull();
  }, 90000);

  it("suffix persistence is SOURCE-level: partner removed + transcript grown → the new chunk is still suffixed", () => {
    unlinkSync(join(SRC, "a_b.jsonl"));
    appendFileSync(join(SRC, "a", "b.jsonl"), ccTranscript([
      { q: "nested source second question body", a: "nested source second answer body", qTs: "2025-03-02T10:00:00Z", aTs: "2025-03-02T10:03:00Z" },
    ]));

    const res = runMine();
    expect(res.exitCode).toBe(0);

    const paths = dbRows().filter(r => r.active === 1).map(r => r.path);
    const nestedBase = `a_b-h${hash8("a/b.jsonl")}`;
    expect(paths).toContain(`${nestedBase}_0000.md`);
    expect(paths).toContain(`${nestedBase}_0001.md`);       // grown chunk matches its siblings
    expect(paths.some(p => /^a_b_\d{4}\.md$/.test(p))).toBe(false); // never flips back to legacy
  }, 90000);

  it("staging→index→search→hydration: a MINED doc's authoredAt reaches enriched results", () => {
    Bun.env.INDEX_PATH = TEST_DB;
    const s = createStore();
    try {
      const hits = s.searchFTS("solo exchange", 10);
      const enrichedHits = enrichResults(s, hits, "solo exchange");
      const solo = enrichedHits.find(r => r.displayPath === "convos/solo_0001.md");
      expect(solo).toBeDefined();
      expect(solo!.authoredAt).toBe("2025-05-02T08:05:00.000Z");
    } finally {
      s.close();
    }
  }, 30000);
});

describe("backfill-dates lane (D10)", () => {
  it("dry-run reports without writing; --apply is metadata-only and idempotent", () => {
    // Simulate pre-§51.1 rows: strip the dates the mine just wrote.
    {
      const db = new Database(TEST_DB);
      db.prepare(`UPDATE documents SET authored_at = NULL WHERE collection = 'convos'`).run();
      db.close();
    }
    const before = new Map(dbRows().map(r => [r.path, r]));
    expect(before.get("solo_0000.md")!.authored_at).toBeNull();

    // Dry run: reports, writes nothing.
    const dry = runMine("--backfill-dates");
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout.toString()).toContain("DRY RUN");
    expect(dbRows().find(r => r.path === "solo_0000.md")!.authored_at).toBeNull();

    // Capture stored confidence pre-apply — the backfill lane must never touch it
    // (lane uniformity: backfilled docs stay identical to mine-new docs).
    const confBefore = (() => {
      const db = new Database(TEST_DB, { readonly: true });
      try { return (db.prepare(`SELECT confidence FROM documents WHERE collection = 'convos' AND path = 'solo_0000.md'`).get() as any).confidence; }
      finally { db.close(); }
    })();

    // Apply: authored_at restored; modified_at and stored confidence untouched.
    const apply = runMine("--backfill-dates", "--apply");
    expect(apply.exitCode).toBe(0);
    const after = new Map(dbRows().map(r => [r.path, r]));
    expect(after.get("solo_0000.md")!.authored_at).toBe("2025-05-01T08:10:00.000Z");
    expect(after.get("solo_0000.md")!.modified_at).toBe(before.get("solo_0000.md")!.modified_at);
    expect(after.get("nodate_0000.md")!.authored_at).toBeNull(); // nothing recoverable
    {
      const db = new Database(TEST_DB, { readonly: true });
      try {
        expect((db.prepare(`SELECT confidence FROM documents WHERE collection = 'convos' AND path = 'solo_0000.md'`).get() as any).confidence).toBe(confBefore);
      } finally { db.close(); }
    }

    // Idempotent: second apply reports zero to update.
    const again = runMine("--backfill-dates", "--apply");
    expect(again.exitCode).toBe(0);
    expect(again.stdout.toString()).toMatch(/0(\x1b\[\d*m)? to update/);
  }, 90000);

  it("body-hash mismatch is skipped, never guessed", () => {
    // Drift the source content (timestamps intact) so the re-derived chunk body
    // no longer matches what was indexed.
    writeFileSync(join(SRC, "solo.jsonl"), ccTranscript([
      { q: "solo exchange zero question body EDITED", a: "solo exchange zero answer body EDITED", qTs: "2025-05-01T08:00:00Z", aTs: "2025-05-01T08:10:00Z" },
      { q: "solo exchange one question body", a: "solo exchange one answer body", qTs: "2025-05-02T08:00:00Z", aTs: "2025-05-02T08:05:00Z" },
    ]));
    {
      const db = new Database(TEST_DB);
      db.prepare(`UPDATE documents SET authored_at = NULL WHERE collection = 'convos' AND path LIKE 'solo%'`).run();
      db.close();
    }
    const res = runMine("--backfill-dates", "--apply");
    expect(res.exitCode).toBe(0);
    const rows = new Map(dbRows().map(r => [r.path, r]));
    expect(rows.get("solo_0000.md")!.authored_at).toBeNull();                      // mismatched chunk skipped
    expect(rows.get("solo_0001.md")!.authored_at).toBe("2025-05-02T08:05:00.000Z"); // intact chunk backfilled
    expect(res.stdout.toString()).toMatch(/1(\x1b\[\d*m)? body-mismatch skipped/);
  }, 90000);

  it("clawmem reflect counts and dates decisions by effectiveAt (historical-authored excluded)", () => {
    // Seed decision + antipattern rows directly (the mined collection is
    // conversation-typed; reflect reads decision/antipattern types).
    const now = new Date().toISOString();
    const recentAuthored = new Date(Date.now() - 2 * 86400000).toISOString();
    const db = new Database(TEST_DB);
    try {
      const mkDoc = (path: string, type: string, authored: string | null) => {
        const hash = createHash("sha256").update(path).digest("hex");
        db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, `body of ${path}`, now);
        db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, content_type, authored_at) VALUES ('refl', ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(path, path, hash, now, now, type, authored);
      };
      mkDoc("current-dec.md", "decision", recentAuthored);
      mkDoc("historic-dec.md", "decision", "2025-01-01T00:00:00.000Z"); // fresh filing, old authorship
      mkDoc("recent-anti.md", "antipattern", recentAuthored);
    } finally { db.close(); }

    const res = Bun.spawnSync({ cmd: ["bun", "src/clawmem.ts", "reflect", "14"], cwd: REPO_ROOT, env: cliEnv, stdout: "pipe", stderr: "pipe" });
    expect(res.exitCode).toBe(0);
    const out = res.stdout.toString();
    expect(out).toContain("1 decisions");                       // historic-dec excluded by effectiveAt
    expect(out).toContain(`(${recentAuthored.slice(0, 10)})`);  // antipattern dated by effectiveAt
  }, 90000);

  it("--backfill-dates is exclusive: combining with --embed / --synthesize / --dry-run is a usage error", () => {
    for (const bad of [["--embed"], ["--synthesize"], ["--dry-run"]]) {
      const res = runMine("--backfill-dates", ...bad);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr.toString()).toContain("exclusive mode");
    }
    const applyAlone = runMine("--apply");
    expect(applyAlone.exitCode).not.toBe(0);
    expect(applyAlone.stderr.toString()).toContain("--apply only applies to --backfill-dates");
  }, 90000);
});
