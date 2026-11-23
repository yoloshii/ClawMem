/**
 * BACKLOG 82.3, D7 — the identifier policy at the COMMAND LINE: a collection name that starts with a byte-order mark
 * is refused as user input — the message names the field and the process exits 2 (not 1: nothing in the program
 * failed). Free text (the query of `search`) is a normalised field here too: the mark is dropped and the search runs.
 *
 * The REAL CLI, as a child process, on a scratch vault and a scratch config. No mark is typed into this file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createStore } from "../../src/store.ts";
import { normalizedContent } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = `/tmp/clawmem-identifier-cli-test-${process.pid}`;
const DB = `${ROOT}/vault.sqlite`;
const CONFIG = `${ROOT}/config/config.yaml`;
const NOW = "2026-11-22T00:00:00.000Z";

const env = {
  ...Bun.env,
  INDEX_PATH: DB,
  CLAWMEM_CONFIG_DIR: `${ROOT}/config`,
  CLAWMEM_NO_LOCAL_MODELS: "true",
  CLAWMEM_EMBED_URL: "http://127.0.0.1:1",
  CLAWMEM_LLM_URL: "http://127.0.0.1:1",
  CLAWMEM_RERANK_URL: "http://127.0.0.1:1",
  NO_COLOR: "1",
};
const cli = (...args: string[]) => {
  const res = Bun.spawnSync({ cmd: ["bun", "src/clawmem.ts", ...args], cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
};
const configFor = (name: string) => `collections:\n  ${JSON.stringify(name)}:\n    path: ${ROOT}/notes-root\n    pattern: "**/*.md"\n`;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${ROOT}/config`, { recursive: true });
  mkdirSync(`${ROOT}/notes-root`, { recursive: true });
  writeFileSync(CONFIG, configFor("notes"));
  writeFileSync(`${ROOT}/notes-root/tank.md`, "# Tank\n\nThe tank filter is cleaned every week.\n");
  const store = createStore(DB);
  const { body, hash } = normalizedContent("# Tank\n\nThe tank filter is cleaned every week.\n");
  store.insertContent(hash, body, NOW);
  store.insertDocument("notes", "tank.md", "Tank", hash, NOW, NOW, "fs");
  store.close();
});
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); });

/** Exit 2, the typed message for `field`, and no mark in what was printed. */
function expectRefused(r: { code: number | null; out: string; err: string }, field: string, mark: string): void {
  expect({ code: r.code, err: r.err.slice(0, 400) }).toMatchObject({ code: 2 });
  expect(r.err).toContain(`the ${field} starts with a byte-order mark`);
  expect(r.out + r.err).not.toContain(mark);
}

describe("the CLI refuses a marked collection name with exit 2", () => {
  test.each(MARKS)("list -c, lifecycle restore --collection, mine -c: %s", (_name, mark) => {
    expectRefused(cli("list", "-c", mark + "notes"), "collection", mark);
    expectRefused(cli("lifecycle", "restore", "--collection", mark + "notes"), "collection", mark);
    mkdirSync(`${ROOT}/exports`, { recursive: true });
    expectRefused(cli("mine", `${ROOT}/exports`, "-c", mark + "convos"), "collection", mark);
  });

  test.each(MARKS)("collection add --name: %s — nothing is written to the config", (_name, mark) => {
    const before = readFileSync(CONFIG, "utf-8");
    expectRefused(cli("collection", "add", `${ROOT}/notes-root`, "--name", mark + "other"), "collection", mark);
    expect(readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  test.each(MARKS)("update with a marked collection name in the config: %s — nothing is indexed under it", (_name, mark) => {
    writeFileSync(CONFIG, configFor(mark + "notes"));
    const r = cli("update");                                               // the config reader's own warning quotes the name as written
    expect({ code: r.code, err: r.err.slice(-300) }).toMatchObject({ code: 2 });
    expect(r.err).toContain("the collection starts with a byte-order mark");
    const store = createStore(DB);
    const rows = store.db.prepare(`SELECT collection, path FROM documents ORDER BY id`).all();
    store.close();
    expect(rows).toEqual([{ collection: "notes", path: "tank.md" }]);
  });

  test("the sound commands work", () => {
    expect(cli("list", "-c", "notes").code).toBe(0);
    const upd = cli("update");
    expect({ code: upd.code, err: upd.err.slice(0, 300) }).toMatchObject({ code: 0 });
    expect(existsSync(DB)).toBe(true);
  });
});

describe("the CLI reads a marked query as the text after the mark", () => {
  test.each(MARKS)("search: %s", (_name, mark) => {
    const plain = cli("search", "tank filter");
    const marked = cli("search", mark + "tank filter");
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("tank.md");
    expect({ code: marked.code, out: marked.out }).toEqual({ code: plain.code, out: plain.out });
  });
});

describe("clawmem doctor lists stored identifiers that start with a mark", () => {
  test("a healthy vault: the line says none, and nothing about identifiers is an issue", () => {
    const r = cli("doctor");
    expect(r.out).toContain("Stored identifiers: none starts with a byte-order mark");
  });

  test.each(MARKS)("a document path led by %s: table, rowid, column and hex, and the warning that results may be incomplete", (_name, mark) => {
    const store = createStore(DB);
    const { body, hash } = normalizedContent("the body of the marked one");
    store.insertContent(hash, body, NOW);
    store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, origin) VALUES ('notes', CAST(? AS TEXT), 't', ?, ?, ?, 1, 'fs')`)
      .run(Buffer.from(mark + "a.md", "utf-8"), hash, NOW, NOW);
    const id = (store.db.prepare(`SELECT max(id) AS id FROM documents`).get() as { id: number }).id;
    store.close();
    const r = cli("doctor");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("results may be INCOMPLETE");
    expect(r.out).toContain(`documents rowid ${id} column path: hex ${Buffer.from(mark + "a.md", "utf-8").toString("hex").toUpperCase()}`);
    expect(r.out + r.err).not.toContain(mark);
  });
});
