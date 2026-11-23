/**
 * BACKLOG 82.3, D7, Codex T1 P3 — three more identifier boundaries at the COMMAND LINE: `collection remove <name>`,
 * `repair entities --vault <name>` and `repair vectors --vault <name>`. A name that starts with a byte-order mark is
 * refused before any lookup or config edit — exit 2, the field named, the mark not printed — whether or not something
 * of that name exists. The REAL CLI, as a child process, on a scratch vault and config. No mark is typed into this file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createStore } from "../../src/store.ts";

const MARKS: [string, string][] = [["U+FEFF", String.fromCharCode(0xfeff)], ["U+FFFE", String.fromCharCode(0xfffe)]];
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = `/tmp/clawmem-identifier-cli-more-${process.pid}`;
const DB = `${ROOT}/vault.sqlite`;
const CONFIG = `${ROOT}/config/config.yaml`;
const env = {
  ...Bun.env, INDEX_PATH: DB, CLAWMEM_CONFIG_DIR: `${ROOT}/config`, CLAWMEM_NO_LOCAL_MODELS: "true",
  CLAWMEM_EMBED_URL: "http://127.0.0.1:1", CLAWMEM_LLM_URL: "http://127.0.0.1:1", CLAWMEM_RERANK_URL: "http://127.0.0.1:1", NO_COLOR: "1",
};
const cli = (...args: string[]) => {
  const res = Bun.spawnSync({ cmd: ["bun", "src/clawmem.ts", ...args], cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
};
const collection = (name: string) => `  ${JSON.stringify(name)}:\n    path: ${ROOT}/notes-root\n    pattern: "**/*.md"\n`;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${ROOT}/config`, { recursive: true });
  mkdirSync(`${ROOT}/notes-root`, { recursive: true });
  writeFileSync(CONFIG, `collections:\n${collection("notes")}`);
  createStore(DB).close();
});
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); });

function expectRefused(r: { code: number | null; out: string; err: string }, field: string, mark: string): void {
  expect({ code: r.code, err: r.err.slice(0, 400) }).toMatchObject({ code: 2 });
  expect(r.err).toContain(`the ${field} starts with a byte-order mark`);
  expect(r.out + r.err).not.toContain(mark);
}

describe("P3: the CLI refuses a marked name at three more boundaries, exit 2", () => {
  test.each(MARKS)("collection remove: %s + an existing name's text — refused; the config is unchanged", (_n, mark) => {
    const before = readFileSync(CONFIG, "utf-8");
    expectRefused(cli("collection", "remove", mark + "notes"), "collection", mark);
    expect(readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  test.each(MARKS)("collection remove: %s-led name that IS configured — refused, not removed (the config is edited by hand)", (_n, mark) => {
    writeFileSync(CONFIG, `collections:\n${collection("notes")}${collection(mark + "notes")}`);
    const before = readFileSync(CONFIG, "utf-8");
    expectRefused(cli("collection", "remove", mark + "notes"), "collection", mark);
    expect(readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  test.each(MARKS)("repair entities --vault: %s + a known vault name, and + an unknown one — refused", (_n, mark) => {
    expectRefused(cli("repair", "entities", "--vault", mark + "general"), "vault", mark);
    expectRefused(cli("repair", "entities", "--vault", mark + "nosuch"), "vault", mark);
    expectRefused(cli("repair", "entities", "--vault", mark + "general", "--apply"), "vault", mark);
  });

  test.each(MARKS)("repair vectors --vault: %s + a known vault name, and + an unknown one — refused", (_n, mark) => {
    expectRefused(cli("repair", "vectors", "--vault", mark + "general"), "vault", mark);
    expectRefused(cli("repair", "vectors", "--vault", mark + "nosuch", "--run"), "vault", mark);
  });

  test.each(MARKS)("bootstrap --name: %s-led name — refused before the collection is added (found beside P3)", (_n, mark) => {
    const before = readFileSync(CONFIG, "utf-8");
    mkdirSync(`${ROOT}/boot`, { recursive: true });
    expectRefused(cli("bootstrap", `${ROOT}/boot`, "--name", mark + "boot", "--skip-embed"), "collection", mark);
    expect(readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  test.each(MARKS)("budget --session: %s-led session id — refused (exit 2), not bound for the guard to refuse (exit 1)", (_n, mark) => {
    expectRefused(cli("budget", "--session", mark + "s-1"), "session id", mark);
  });

  test("controls: the plain names still work (remove an existing collection; both repairs' dry runs on the default vault)", () => {
    expect(cli("repair", "entities", "--vault", "general").code).toBe(0);
    expect(cli("repair", "vectors", "--vault", "general").code).toBe(0);
    const r = cli("collection", "remove", "notes");
    expect(r.code).toBe(0);
    expect(readFileSync(CONFIG, "utf-8")).not.toContain("notes-root");
  });
});
