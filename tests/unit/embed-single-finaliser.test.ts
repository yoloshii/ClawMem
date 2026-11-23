/**
 * BACKLOG 82.2 D2, Codex T1 P5, operator ruling 81 A — ONE finaliser ends every embed run.
 *
 * The design: the run's bookkeeping (the taint, the canary baseline, the refund) lives in `cmdEmbed`'s scope "behind
 * ONE finaliser that both the normal end and the fatal catch call". This is a STRUCTURE requirement — the behaviour of
 * each ending is held by embed-abort, embed-poison-cli, embed-taint-v0412 and canary-validation tests — so it is read
 * from the source: `cmdEmbed` declares `finaliseRun` once, both endings call it, and every taint or baseline write of
 * the command happens inside it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const SRC = readFileSync(new URL("../../src/clawmem.ts", import.meta.url), "utf-8");
/** The text of `cmdEmbed`, up to the next top-level function. */
const body = (() => {
  const at = SRC.indexOf("async function cmdEmbed(");
  const end = SRC.indexOf("\nasync function ", at + 10);
  return SRC.slice(at, end);
})();
/** The text of `finaliseRun`: from its declaration to the first line that closes it at its own indentation. */
const finaliser = (() => {
  const m = /\n( *)const finaliseRun = async \(/.exec(body);
  if (!m) return "";
  const close = body.indexOf(`\n${m[1]}};`, m.index);
  return body.slice(m.index, close);
})();
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe("81 A: cmdEmbed has one finaliser for both endings", () => {
  test("finaliseRun is declared once, before the run's try, in the command's scope", () => {
    expect(count(body, /const finaliseRun = async \(/g)).toBe(1);
    expect(body.indexOf("const finaliseRun = async (")).toBeLessThan(body.indexOf("\n  try {"));
  });

  test("the normal end and the fatal catch both call it; nothing else ends a run", () => {
    const tryAt = body.indexOf("\n  try {"), catchAt = body.indexOf("\n  } catch (err) {"), finallyAt = body.indexOf("\n  } finally {");
    expect(count(body.slice(tryAt, catchAt), /finaliseRun\(\{ kind: "completed"/g)).toBeGreaterThanOrEqual(2);   // the no-work end and the full end
    expect(count(body.slice(catchAt, finallyAt), /finaliseRun\(\{ kind: "aborted"/g)).toBeGreaterThanOrEqual(1);
    expect(count(body.slice(catchAt, finallyAt), /finaliseEmbedAbort\(/g)).toBe(0);
    expect(count(body, /finaliseEmbedAbort\(/g)).toBe(1);                         // inside finaliseRun only
    expect(finaliser).toContain("finaliseEmbedAbort(");
  });

  test("every taint and baseline write of cmdEmbed is inside finaliseRun", () => {
    const outside = body.replace(finaliser, "");
    for (const write of [/setVaultFlag\(/g, /clearVaultFlag\(/g, /persistCanaryBaselineIfFirst\(/g, /setTaint\(/g]) {
      expect(count(outside, write), String(write)).toBe(0);
    }
    expect(finaliser).toMatch(/setVaultFlag\(|setTaint\(/);
    expect(finaliser).toContain("clearVaultFlag(");
    expect(finaliser).toContain("persistCanaryBaselineIfFirst(");
  });
});
