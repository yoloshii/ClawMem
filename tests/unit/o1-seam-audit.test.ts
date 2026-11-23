import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test";

// Every test here builds one or more TypeScript programs over the real tree (~3-5 s each);
// bun test's default 5 s per-test timeout SIGTERMs the spawned CLI mid-build.
setDefaultTimeout(180_000);
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

import { audit, buildProgram, loadRatchet, scopedFiles, LEGACY_SINK_ALLOWLIST, SOURCE_EXTENSIONS, type Finding, type SeamRatchet } from "../../scripts/o1-seam-audit.ts";
import { compilerOptionsFrom } from "../../scripts/o1-tsconfig.ts";

/**
 * The seam audit is the enforcement boundary for every O1 brand — the type
 * does not carry credit it cannot hold, the audit does. So these tests are
 * mostly proof that each check BITES on a synthetic fixture, including every
 * laundering path three code reviews named, then that the real tree passes and
 * the closure reproduces the falsifier sites.
 *
 * Fixtures copy the real `src/clock.ts` into a temp root so the brands under
 * test are the brands that ship, and WRITE the retired legacy brand module from
 * the text below: `src/clock-legacy.ts` left the real tree at the O1 migration
 * (step 2, delta 4 — zero debt entries), but the audit's C5 value-flow closure
 * is still exercised here against that brand, exactly as the migration relied
 * on it. Every `.ts`, `.d.ts` and JS file of the fixture is a program root,
 * exactly as `scopedFiles()` does.
 */

/** The retired `src/clock-legacy.ts`, verbatim in what matters: a NON-EXPORTED unique symbol keys the brand. */
const LEGACY_MODULE_TEXT = `/**
 * LEGACY — the one O1 debt type (RETIRED from the real tree at the migration; fixture copy).
 * An absolute wall-clock deadline at a seam that had not yet migrated to MonoDeadline.
 * Constructing one is ALWAYS debt (an erased assertion with an O1-DEBT marker); there is no
 * constructor, by design. Keyed on a non-exported unique symbol.
 */
declare const LEGACY_WALL_DEADLINE: unique symbol;
export type LegacyWallDeadline = number & { readonly [LEGACY_WALL_DEADLINE]: true };
`;

const REPO = resolve(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts/o1-seam-audit.ts");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const LEG = 'import type { LegacyWallDeadline } from "./clock-legacy.ts";\n';
const CLK = 'import type { DurationMs } from "./clock.ts";\nimport { duration } from "./clock.ts";\n';

function fixture(files: Record<string, string>): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "o1-seam-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  copyFileSync(join(REPO, "src/clock.ts"), join(root, "src/clock.ts"));
  writeFileSync(join(root, "src/clock-legacy.ts"), LEGACY_MODULE_TEXT);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return { root, files: ["src/clock.ts", "src/clock-legacy.ts", ...Object.keys(files).filter((f) => /^(src|scripts)\//.test(f) && SOURCE_EXTENSIONS.some((e) => f.endsWith(e)))] };
}

function run(files: Record<string, string>, r: SeamRatchet | null = null) {
  const { root, files: names } = fixture(files);
  return audit(names, root, r);
}
/** What `--init` would write for this fixture. */
function ratchetFor(files: Record<string, string>): SeamRatchet {
  const r = run(files, null);
  return { generated: "t", note: "t", entries: r.entries, knownDiagnostics: r.diagnostics };
}
function edited(files: Record<string, string>, edit: (r: SeamRatchet) => SeamRatchet): SeamRatchet { return edit(ratchetFor(files)); }
const checks = (x: Finding[] | { findings: Finding[] }) => (Array.isArray(x) ? x : x.findings).map((f) => f.check);
const cli = (args: string[], ratchet: string) =>
  spawnSync("bun", [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", timeout: 400_000, env: { ...process.env, O1_SEAM_RATCHET: ratchet } });

const CLEAN = LEG + `
export function seam(d?: LegacyWallDeadline): void { void d; }
export function caller(now: number): void {
  const d = now + 100 as LegacyWallDeadline /* O1-DEBT-0001 */;
  seam(d);
  const remaining = d - now;   // legacy arithmetic: by design
  if (now >= d) return;        // legacy comparison: by design
  void Number.isFinite(d);     // allowlisted TERMINAL lib sink
  void remaining;
}
`;

describe("clean fixture", () => {
  it("passes, lists the seam in the closure, and its one marker in the entries", () => {
    const r = run({ "src/a.ts": CLEAN }, ratchetFor({ "src/a.ts": CLEAN }));
    expect(r.findings).toEqual([]);
    expect(r.closure.some((c) => c.file === "src/a.ts" && c.owner === "seam" && c.name === "d")).toBe(true);
    expect(r.entries.map((e) => [e.id, e.kind])).toEqual([["O1-DEBT-0001", "construction"]]);
  });
});

// ─── C0: every first-party file is type-gated; the baseline is a multiset ──

describe("C0 — the compiler as a gate", () => {
  it("a bare number into a branded seam from a file that imports NO brand fails in that file", () => {
    const r = run({
      "src/seam.ts": LEG + "export function seam(d?: LegacyWallDeadline): void { void d; }\n",
      "src/caller.ts": 'import { seam } from "./seam.ts";\nseam(12345);\n',
    });
    expect(r.findings.some((f) => f.check === "C0" && f.file === "src/caller.ts")).toBe(true);
  });

  it("a baselined diagnostic is tolerated; a new one is not", () => {
    const bad = { "src/x.ts": "export const n: number = 'oops';\n" };
    expect(checks(run(bad, ratchetFor(bad)))).toEqual([]);
    expect(checks(run(bad, edited(bad, (r) => ({ ...r, knownDiagnostics: [] }))))).toEqual(["C0"]);
  });

  it("MULTISET: a second identical error in the same scope is NOT covered by a baseline holding one", () => {
    const one = { "src/x.ts": "{ const a: number = 'x'; }\nexport {};\n" };
    const two = { "src/x.ts": "{ const a: number = 'x'; }\n{ const a: number = 'x'; }\nexport {};\n" };
    expect(checks(run(two, ratchetFor(one)))).toEqual(["C0"]);
    expect(checks(run(two, ratchetFor(two)))).toEqual([]);
  });

  it("FINGERPRINT: fixing the error and re-introducing it in another scope of the same file is NOT covered", () => {
    const base = { "src/x.ts": "export const n: number = 'oops';\n" };
    const moved = { "src/x.ts": "export const n: number = 0;\nexport function g(): void { const n: number = 'oops'; void n; }\n" };
    expect(checks(run(moved, ratchetFor(base)))).toEqual(["C0"]);
  });

  it("CONTROL-FLOW CONTEXT (round 3): the same statement moved from a dead branch to the live one is NOT covered", () => {
    const dead = { "src/x.ts": "export function f(x: boolean): void { if (x) { const n: number = 'oops'; void n; } else { void 0; } }\n" };
    const live = { "src/x.ts": "export function f(x: boolean): void { if (x) { void 0; } else { const n: number = 'oops'; void n; } }\n" };
    expect(checks(run(live, ratchetFor(dead)))).toEqual(["C0"]);
    const loop = { "src/x.ts": "export function f(x: boolean): void { while (x) { const n: number = 'oops'; void n; } }\n" };
    expect(checks(run(loop, ratchetFor(dead)))).toEqual(["C0"]);
    expect(run(dead, ratchetFor(dead)).diagnostics[0]!.context).toBe("if(x):then");
  });

  it("ACCEPTED RESIDUAL: the same statement moving within its scope AND context stays covered", () => {
    const base = { "src/x.ts": "export const n: number = 'oops';\nexport const m = 1;\n" };
    const shifted = { "src/x.ts": "// moved down\nexport const m = 1;\nexport const n: number = 'oops';\n" };
    expect(checks(run(shifted, ratchetFor(base)))).toEqual([]);
  });

  it("a first-party `.d.ts` root is gated: an ambient LegacyWallDeadline without a marker is C1", () => {
    const r = run({ "src/ambient.d.ts": 'import type { LegacyWallDeadline } from "./clock-legacy.ts";\nexport declare const conjured: LegacyWallDeadline;\n' });
    expect(r.findings.map((f) => [f.check, f.file])).toEqual([["C1", "src/ambient.d.ts"]]);
  });

  it("first-party JavaScript is gated too: checkJs errors are C0, a JSDoc cast to a brand is C1", () => {
    expect(run({ "src/j.js": "export function f(a) { return a; }\n" }).findings.map((f) => [f.check, f.file])).toEqual([["C0", "src/j.js"]]);
    const cast = { "src/j.js": 'export const d = /** @type {import("./clock-legacy.ts").LegacyWallDeadline} */ (5);\n' };
    expect(run(cast).findings.map((f) => [f.check, f.file])).toEqual([["C1", "src/j.js"]]);
    const marked = { "src/j.js": 'export const d = /** @type {import("./clock-legacy.ts").LegacyWallDeadline} */ (5) /* O1-DEBT-0001 */;\n' };
    expect(run(marked, ratchetFor(marked)).findings).toEqual([]);
  });

  it("EVERY compiler extension is a root (round 4): .tsx, .mts, .cts, .jsx — a construction in any of them is C1", () => {
    expect(SOURCE_EXTENSIONS).toEqual(expect.arrayContaining([".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs"]));
    expect(SOURCE_EXTENSIONS).not.toContain(".json");
    const r = run({
      "src/x.tsx": LEG + "export const El = () => <div>{5 as LegacyWallDeadline}</div>;\n",
      "src/m.mts": 'import type { LegacyWallDeadline } from "./clock-legacy.ts";\nexport const d = 6 as LegacyWallDeadline;\n',
      "src/c.cts": 'import type { LegacyWallDeadline } from "./clock-legacy.ts";\nexport const d = 7 as LegacyWallDeadline;\n',
      "src/j.jsx": 'export const El = () => <div>{/** @type {import("./clock-legacy.ts").LegacyWallDeadline} */ (8)}</div>;\n',
    });
    expect(r.findings.filter((f) => f.check === "C1").map((f) => f.file).sort()).toEqual(["src/c.cts", "src/j.jsx", "src/m.mts", "src/x.tsx"]);
    expect(scopedFiles(REPO).every((f) => SOURCE_EXTENSIONS.some((e) => f.endsWith(e)))).toBe(true);
  });

  it("scripts/ is in scope", () => {
    const r = run({ "scripts/tool.ts": 'import type { LegacyWallDeadline } from "../src/clock-legacy.ts";\n' + "export const d = 5 as LegacyWallDeadline;\n" });
    expect(r.findings.some((f) => f.check === "C1" && f.file === "scripts/tool.ts")).toBe(true);
  });

  it("THE REPOSITORY'S CONTRACT (round 5): options come from tsconfig.json — module Preserve, moduleDetection force, noImplicitOverride — with only the audit's keys overridden", () => {
    const o = buildProgram(["src/clock.ts", "src/clock-legacy.ts"]).program.getCompilerOptions();
    expect([o.module, o.moduleDetection, o.noImplicitOverride, o.noFallthroughCasesInSwitch]).toEqual([ts.ModuleKind.Preserve, ts.ModuleDetectionKind.Force, true, true]);
    expect([o.noEmit, o.allowJs, o.checkJs]).toEqual([true, true, true]);
    // the contract is the repository's whatever the root: noImplicitOverride bites in a fixture …
    expect(checks(run({ "src/x.ts": "class B { m(): void {} }\nexport class C extends B { m(): void {} }\n" }))).toEqual(["C0"]);
    // … and under moduleDetection: force two import-free files are two modules, never one colliding script scope
    expect(run({ "src/p.ts": "const x = 1; void x;\n", "src/q.ts": "const x = 1; void x;\n" }).findings).toEqual([]);
    // the loader reads the file it is given, and refuses a contract it cannot parse
    const dir = mkdtempSync(join(tmpdir(), "o1-tsconfig-")); dirs.push(dir);
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": { "strict": false, "target": "ES2020" } }');
    const loose = compilerOptionsFrom(join(dir, "tsconfig.json"));
    expect([loose.strict, loose.target]).toEqual([false, ts.ScriptTarget.ES2020]);
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": { "nonsense": 1 } }');
    expect(() => compilerOptionsFrom(join(dir, "tsconfig.json"))).toThrow();
  });
});

// ─── C1: construction is always debt ────────────────────────────────

describe("C1 — brand construction without a marker", () => {
  it("bare assertion", () => {
    expect(checks(run({ "src/a.ts": LEG + "export const d = 5 as LegacyWallDeadline;\n" }))).toEqual(["C1"]);
  });
  it("decoder-shaped assertion, brand ONE level deep (the VecReq case)", () => {
    expect(checks(run({ "src/a.ts": LEG + "type Req = { q: string; deadlineMs?: LegacyWallDeadline };\ndeclare const line: string;\nexport const req = JSON.parse(line) as Req;\n" }))).toEqual(["C1"]);
  });
  it("decoder-shaped assertion, brand THREE levels deep, through an array and a type argument", () => {
    const src = LEG + "type Inner = { opts: { deadlineAt?: LegacyWallDeadline } };\ntype Env = { batch: Array<Promise<Inner>> };\ndeclare const line: string;\nexport const e = JSON.parse(line) as Env;\n";
    expect(checks(run({ "src/a.ts": src }))).toEqual(["C1"]);
  });
  it("NO DEPTH CAP: brand TWELVE levels deep, and through a recursive type, and through a mutually recursive pair queried in both orders", () => {
    const deep = LEG + Array.from({ length: 12 }, (_, i) => `type L${i + 1} = { a: ${i === 0 ? "LegacyWallDeadline" : `L${i}`} };`).join("\n") + "\ndeclare const line: string;\nexport const x = JSON.parse(line) as L12;\n";
    expect(checks(run({ "src/a.ts": deep }))).toEqual(["C1"]);
    const rec = LEG + "type Node = { next?: Node; d?: LegacyWallDeadline };\ndeclare const line: string;\nexport const n = JSON.parse(line) as Node;\n";
    expect(checks(run({ "src/a.ts": rec }))).toEqual(["C1"]);
    const pair = LEG + "type A = { b?: B; d?: LegacyWallDeadline };\ntype B = { a?: A };\ndeclare const line: string;\nexport const b = JSON.parse(line) as B;\nexport const a = JSON.parse(line) as A;\nexport const b2 = JSON.parse(line) as B;\n";
    expect(checks(run({ "src/a.ts": pair }))).toEqual(["C1", "C1", "C1"]);
  });
  it("a type predicate is a construction", () => {
    expect(checks(run({ "src/a.ts": LEG + "export function isDeadline(x: unknown): x is LegacyWallDeadline { return typeof x === 'number'; }\n" }))).toEqual(["C1"]);
  });
  it("an ambient declaration is a construction", () => {
    expect(checks(run({ "src/a.ts": LEG + "declare const fromNowhere: LegacyWallDeadline;\nexport const d = fromNowhere;\n" }))).toEqual(["C1"]);
    expect(checks(run({ "src/a.ts": LEG + "declare function conjure(): LegacyWallDeadline;\nexport const d = conjure();\n" }))).toEqual(["C1"]);
  });
  it("target brands too, outside the clock module", () => {
    expect(checks(run({ "src/a.ts": CLK + "export const d = 5 as DurationMs;\n" }))).toEqual(["C1"]);
  });
  it("src/clock.ts's own constructors are exempt", () => {
    expect(run({}).findings).toEqual([]);
  });
});

// ─── C2: bijection + identity ───────────────────────────────────────

describe("C2 — marker <-> ratchet bijection", () => {
  const A = { "src/a.ts": CLEAN };
  it("marker with no entry — the ratchet only tightens", () => {
    expect(checks(run(A, edited(A, (r) => ({ ...r, entries: [] }))))).toEqual(["C2"]);
  });
  it("an entry with no marker is RETIRED debt — progress, reported, never a failure", () => {
    const r = run(A, edited(A, (x) => ({ ...x, entries: [...x.entries, { ...x.entries[0]!, id: "O1-DEBT-0002" }] })));
    expect(r.findings).toEqual([]);
    expect(r.retired.entries.map((e) => e.id)).toEqual(["O1-DEBT-0002"]);
  });
  it("duplicate marker id", () => {
    const dup = { "src/a.ts": CLEAN + "export const e = 1 as LegacyWallDeadline /* O1-DEBT-0001 */;\n" };
    expect(run(dup, ratchetFor(dup)).findings.some((f) => f.check === "C2" && f.message.includes("duplicate"))).toBe(true);
  });
  it("orphan marker", () => {
    const orphan = { "src/a.ts": CLEAN + "export const n = 1; /* O1-DEBT-0002 */\n" };
    expect(run(orphan, ratchetFor(orphan)).findings.some((f) => f.check === "C2" && f.message.includes("orphan"))).toBe(true);
  });
  it("relocation across scope or file", () => {
    expect(run(A, edited(A, (r) => ({ ...r, entries: [{ ...r.entries[0]!, scope: "elsewhere" }] }))).findings.some((f) => f.message.includes("relocated"))).toBe(true);
    expect(run(A, edited(A, (r) => ({ ...r, entries: [{ ...r.entries[0]!, file: "src/b.ts" }] }))).findings.some((f) => f.message.includes("relocated"))).toBe(true);
  });
  it("IDENTITY: the expression, the brand set, or the kind changing under the same marker fails", () => {
    const base = ratchetFor(A);
    const otherExpr = { "src/a.ts": CLEAN.replace("now + 100 as LegacyWallDeadline", "now + 200 as LegacyWallDeadline") };
    expect(run(otherExpr, base).findings.some((f) => f.check === "C2" && f.message.includes("changed under the same id"))).toBe(true);
    const otherBrand = { "src/a.ts": CLEAN.replace("now + 100 as LegacyWallDeadline", "now + 100 as LegacyWallDeadline | undefined") };
    expect(run(otherBrand, base).findings.some((f) => f.check === "C2" && f.message.includes("changed under the same id"))).toBe(true);
    expect(run(A, edited(A, (r) => ({ ...r, entries: [{ ...r.entries[0]!, kind: "erasure" }] }))).findings.some((f) => f.message.includes("changed under the same id"))).toBe(true);
    // whitespace is not identity
    const reflowed = { "src/a.ts": CLEAN.replace("now + 100 as LegacyWallDeadline", "now   +\n    100 as LegacyWallDeadline") };
    expect(run(reflowed, base).findings).toEqual([]);
  });
  it("IDENTITY is the COMPLETE expression (round 3): a change past the 120th character is a change", () => {
    const long = (tail: string) => ({ "src/a.ts": LEG + `declare const a: number; declare const b: number;\nexport const d = Math.max(a, b, a + b, a - b, a * 2, b * 2, a + 1, b + 1, a + 2, b + 2, a + 3, b + 3, a + 4, b + 4, a + 5, b + 5, ${tail}) as LegacyWallDeadline /* O1-DEBT-0001 */;\n` });
    const base = ratchetFor(long("a + 6"));
    expect(base.entries[0]!.text.length).toBeLessThanOrEqual(120);
    expect(run(long("a + 6"), base).findings).toEqual([]);
    expect(run(long("a + 7"), base).findings.some((f) => f.check === "C2" && f.message.includes("changed under the same id"))).toBe(true);
  });
});

// ─── C3: any / unknown ──────────────────────────────────────────────

describe("C3 — any/unknown reaching a brand-carrying sink", () => {
  const SEAM = LEG + "export function seam(d?: LegacyWallDeadline): void { void d; }\ntype Opts = { deadlineAt?: LegacyWallDeadline; note?: string };\nexport function seamOpts(o: Opts): void { void o; }\nexport function seamArr(xs: LegacyWallDeadline[]): void { void xs; }\n";
  it("into a branded parameter", () => {
    expect(checks(run({ "src/a.ts": SEAM + "declare const a: any;\nseam(a);\n" }))).toEqual(["C3"]);
  });
  it("into a brand-CARRYING options parameter (the whole object is any)", () => {
    expect(checks(run({ "src/a.ts": SEAM + "declare const a: any;\nseamOpts(a);\n" }))).toEqual(["C3"]);
  });
  it("into a branded property", () => {
    expect(checks(run({ "src/a.ts": SEAM + "declare const a: any;\nseamOpts({ deadlineAt: a });\n" }))).toEqual(["C3"]);
  });
  it("STRUCTURAL (round 3): any INSIDE an inferred container whose sink shape carries the brand", () => {
    expect(checks(run({ "src/a.ts": SEAM + "declare const a: any;\nconst o = { deadlineAt: a };\nseamOpts(o);\n" }))).toEqual(["C3"]);
    expect(checks(run({ "src/a.ts": SEAM + "declare const a: any;\nconst xs = [a];\nseamArr(xs);\n" }))).toEqual(["C3"]);
    expect(checks(run({ "src/a.ts": SEAM + "declare const a: any;\nconst box = { inner: { deadlineAt: a } };\ndeclare function nested(b: { inner: Opts }): void;\nnested(box);\n" }))).toEqual(["C3"]); // `unknown` would be a compile error; `any` launders silently
    // any in an UNBRANDED position of the same container is not a brand leak
    expect(run({ "src/a.ts": SEAM + "declare const a: any;\nexport function f(d: LegacyWallDeadline): void { const o = { deadlineAt: d, note: a }; seamOpts(o); }\n" }).findings).toEqual([]);
  });
  it("through a generic instantiated with any", () => {
    expect(checks(run({ "src/a.ts": SEAM + "function id<T>(x: T): T { return x; }\ndeclare const a: any;\nseam(id(a));\n" }))).toEqual(["C3"]);
  });
  it("into a CONSTRAINED generic parameter called with any — the declared sink, not the instantiated one", () => {
    expect(checks(run({ "src/a.ts": SEAM + "function f<T extends LegacyWallDeadline>(x: T): T { return x; }\ndeclare const a: any;\nf(a);\n" }))).toEqual(["C3"]);
    expect(checks(run({ "src/a.ts": SEAM + "function g<T extends { deadlineAt?: LegacyWallDeadline }>(x: T): T { return x; }\ndeclare const a: any;\ng(a);\n" }))).toEqual(["C3"]);
  });
  it("into a return and an assignment", () => {
    expect(checks(run({ "src/a.ts": LEG + "declare const a: any;\nexport function f(): LegacyWallDeadline { return a; }\n" }))).toEqual(["C3"]);
    expect(checks(run({ "src/a.ts": LEG + "declare const a: any;\nlet d: LegacyWallDeadline | undefined;\nd = a;\nexport { d };\n" }))).toEqual(["C3"]);
  });

  describe("through SIGNATURES (round 5): a sink whose method takes or returns the brand is brand-carrying", () => {
    const I = LEG + "interface I { m(d: LegacyWallDeadline): void }\n";
    const R = LEG + "interface R { m(): LegacyWallDeadline }\n";
    it("an `any` VALUE assigned to a shape whose METHOD takes the brand — by annotation, by parameter, by member", () => {
      expect(checks(run({ "src/a.ts": I + "declare const x: any;\nexport const i: I = x;\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": I + "declare const x: any;\ndeclare function use(i: I): void;\nuse(x);\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": I + "declare const x: any;\nexport const i: I = { m: x };\n" }))).toEqual(["C3"]);
    });
    it("an implementation RETURNING any behind a branded return — annotated and inferred, class, object literal, structural, interface", () => {
      expect(checks(run({ "src/a.ts": R + "export class C implements R { m(): any { return 0; } }\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": R + "declare const x: any;\nexport class C implements R { m() { return x; } }\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": R + "export const r: R = { m(): any { return 0; } };\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": R + "class C { m(): any { return 0; } }\nexport const r: R = new C();\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": R + "interface Wide extends R { m(): any }\nexport const w: Wide | null = null;\n" }))).toEqual(["C3"]);
    });
    it("an any PARAMETER inferred from a default initializer, behind a branded callback type", () => {
      expect(checks(run({ "src/a.ts": LEG + "declare const a: any;\nconst g = (d = a) => { void d; };\nexport const f: (d: LegacyWallDeadline) => void = g;\n" }))).toEqual(["C3"]);
    });
    it("a NARROWER return is not a laundering and not a drop (covariance)", () => {
      expect(run({ "src/a.ts": LEG + "interface N { m(): LegacyWallDeadline | null }\nexport class C implements N { m(): null { return null; } }\n" }).findings).toEqual([]);
    });
  });
});

// ─── C4: target brands never erase or enter raw arithmetic ──────────

describe("C4 — target-brand erasure and arithmetic", () => {
  const D = CLK + "declare function timer(cb: () => void, ms: number): void;\n";
  it("into a bare-number timer parameter", () => {
    expect(checks(run({ "src/a.ts": D + "timer(() => {}, duration(5));\n" }))).toEqual(["C4"]);
  });
  it("direct and COMPOUND arithmetic", () => {
    expect(checks(run({ "src/a.ts": D + "export const n = duration(5) + 1;\n" }))).toEqual(["C4"]);
    expect(checks(run({ "src/a.ts": D + "let n = 0; n += duration(5); export { n };\n" }))).toEqual(["C4"]);
  });
  it("by annotation, by return, by assignment, by property write", () => {
    expect(checks(run({ "src/a.ts": D + "export const n: number = duration(5);\n" }))).toEqual(["C4"]);
    expect(checks(run({ "src/a.ts": D + "export function f(): number { return duration(5); }\n" }))).toEqual(["C4"]);
    expect(checks(run({ "src/a.ts": D + "let n = 0; n = duration(5); export { n };\n" }))).toEqual(["C4"]);
    expect(checks(run({ "src/a.ts": D + "const o = { ms: 0 }; o.ms = duration(5); export { o };\n" }))).toEqual(["C4"]);
  });
  it("inside a container: an array literal and an object literal into unbranded shapes", () => {
    expect(checks(run({ "src/a.ts": D + "export const xs: number[] = [duration(5)];\n" }))).toEqual(["C4"]);
    expect(checks(run({ "src/a.ts": D + "declare function takes(o: { ms: number }): void;\nconst o = { ms: duration(5) };\ntakes(o);\n" }))).toEqual(["C4"]);
  });
  it("DROPPED by an implementation: a class method declaring `number` behind an interface's DurationMs", () => {
    expect(checks(run({ "src/a.ts": CLK + "interface Sleeper { sleep(ms: DurationMs): void }\nexport class S implements Sleeper { sleep(ms: number): void { void ms; } }\n" }))).toEqual(["C4"]);
  });
  it("is covered by a debt-marked assertion around it", () => {
    const covered = { "src/a.ts": LEG + CLK + "export const d = Date.now() + duration(5) as LegacyWallDeadline /* O1-DEBT-0001 */;\n" };
    expect(run(covered, ratchetFor(covered)).findings).toEqual([]);
  });
});

// ─── C5: the value-flow closure ─────────────────────────────────────

describe("C5 — a LegacyWallDeadline may not reach a sink typed without it", () => {
  const F = (body: string) => ({ "src/a.ts": LEG + `export function outer(d: LegacyWallDeadline): void {\n${body}\n}\n` });

  it("MUTATION LOCK: removing the brand from an implementation fails", () => {
    const r = run({ "src/a.ts": LEG + "function inner(d?: number): void { void d; }\nexport function outer(d?: LegacyWallDeadline): void { inner(d); }\n" });
    expect(checks(r)).toEqual(["C5"]);
    expect(r.findings[0]!.message).toContain("UNBRANDED SEAM");
  });
  it("an unbranded first-party property, return, and assignment", () => {
    expect(checks(run({ "src/a.ts": LEG + "type Req = { deadlineMs?: number };\nexport function f(d: LegacyWallDeadline): Req { return { deadlineMs: d }; }\n" }))).toEqual(["C5"]);
    expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): number { return d; }\n" }))).toEqual(["C5"]);
    expect(checks(run({ "src/a.ts": LEG + "let n = 0;\nexport function f(d: LegacyWallDeadline): void { n = d; }\nexport { n };\n" }))).toEqual(["C5"]);
  });

  describe("ALLOWLIST (rounds 2–3): only default-lib TERMINALS are exempt", () => {
    it("setTimeout, JSON.stringify, new Date, console.log, Array.push — each is an erasure", () => {
      for (const body of ["setTimeout(() => {}, d);", "void JSON.stringify(d);", "void new Date(d);", "console.log(d);", "const xs: number[] = []; xs.push(d);"]) {
        const r = run(F(body));
        expect(checks(r)).toEqual(["C5"]);
        expect(r.findings[0]!.message).toContain("not a LEGACY_SINK_ALLOWLIST terminal");
      }
    });
    it("ARITHMETIC IS NOT A TERMINAL (round 3): Math.min / Math.floor launder the epoch into a bare number", () => {
      expect(checks(run(F("void Math.min(d, 1);")))).toEqual(["C5"]);
      expect(checks(run(F("const n = Math.floor(d); setTimeout(() => {}, n);")))).toEqual(["C5"]); // caught at the Math.floor sink, before n exists
      expect([...LEGACY_SINK_ALLOWLIST].some((s) => s.startsWith("Math."))).toBe(false);
      const reasserted = F("const m = Math.min(d, 1) as LegacyWallDeadline /* O1-DEBT-0002 */; void m;");
      expect(run(reasserted, ratchetFor(reasserted)).findings).toEqual([]);
    });
    it("boolean predicates are terminals; String is SERIALIZATION (round 4) and needs a marker", () => {
      expect(run(F("void Number.isFinite(d); void Number.isInteger(d); void isFinite(d); void isNaN(d);")).findings).toEqual([]);
      expect(checks(run(F("void Number(String(d));")))).toEqual(["C5"]);
      expect([...LEGACY_SINK_ALLOWLIST].some((s) => s.startsWith("String"))).toBe(false);
      const marked = F("void String(d /* O1-DEBT-0002 */);");
      expect(run(marked, ratchetFor(marked)).findings).toEqual([]);
    });
    it("a MARKED erasure is a ratchet entry of kind `erasure`, bijective like any other", () => {
      const marked = F("void JSON.stringify(d /* O1-DEBT-0002 */);");
      const r = run(marked, ratchetFor(marked));
      expect(r.findings).toEqual([]);
      expect(r.entries.find((e) => e.id === "O1-DEBT-0002")).toMatchObject({ kind: "erasure", brands: ["LegacyWallDeadline"], text: "d" });
      expect(checks(run(marked, edited(marked, (x) => ({ ...x, entries: x.entries.filter((e) => e.id !== "O1-DEBT-0002") }))))).toEqual(["C2"]);
    });
    it("IDENTITY IS THE DEFAULT LIB (round 3): a dependency declaring an allowlisted NAME is not exempt", () => {
      const r = run({
        "node_modules/spoof/package.json": '{ "name": "spoof", "types": "index.d.ts" }\n',
        "node_modules/spoof/index.d.ts": "export declare function isFinite(n: number): boolean;\n",
        "src/a.ts": LEG + 'import { isFinite as isF } from "spoof";\nexport function outer(d: LegacyWallDeadline): void { void isF(d); }\n',
      });
      expect(checks(r)).toEqual(["C5"]);
    });
    it("a first-party `.d.ts` sink is first-party (path ownership), not lib", () => {
      const r = run({
        "src/sink.d.ts": "export declare function sink(n: number): void;\n",
        "src/a.ts": LEG + 'import { sink } from "./sink.ts";\nexport function outer(d: LegacyWallDeadline): void { sink(d); }\n',
      });
      expect(checks(r)).toEqual(["C5"]);
      expect(r.findings[0]!.message).toContain("UNBRANDED SEAM");
    });
  });

  describe("FIRST-PARTY DECLARATION FILES (round 5): a shape declared in a first-party `.d.ts` is descended — path ownership, not `isDeclarationFile`", () => {
    const DTS = 'import type { LegacyWallDeadline } from "./clock-legacy.ts";\nexport interface I { m(d: LegacyWallDeadline): void }\nexport interface Req { deadlineMs?: LegacyWallDeadline }\n';
    it("a branded METHOD declared in a `.d.ts`, structurally implemented with `number`, is a drop", () => {
      expect(checks(run({ "src/i.d.ts": DTS, "src/a.ts": 'import type { I } from "./i.ts";\nclass C { m(d: number): void { void d; } }\nexport const i: I = new C();\n' }))).toEqual(["C5"]);
    });
    it("a branded PROPERTY declared in a `.d.ts` carries the brand as a value: the closure lists it, an unbranded sink is a seam", () => {
      const r = run({ "src/i.d.ts": DTS, "src/a.ts": 'import type { Req } from "./i.ts";\nfunction inner(o: { deadlineMs?: number }): void { void o; }\nexport function outer(r: Req): void { inner(r); }\n' });
      expect(checks(r)).toEqual(["C5"]);
      expect(r.closure.some((c) => c.file === "src/a.ts" && c.owner === "outer" && c.name === "r")).toBe(true);
    });
    it("a LIB mapped type over a first-party shape is followed to that shape's members", () => {
      expect(checks(run({ "src/a.ts": LEG + "type Req = { deadlineMs?: LegacyWallDeadline };\nfunction inner(o: { deadlineMs?: number }): void { void o; }\nexport function outer(r: Partial<Req>): void { inner(r); }\n" }))).toEqual(["C5"]);
    });
  });

  describe("CLOSURE (rounds 2–3): containers, spreads, callbacks, generics, generators, compound assignment", () => {
    it("element assignment into a number[]", () => {
      expect(checks(run(F("const xs: number[] = []; xs[0] = d;")))).toEqual(["C5"]);
    });
    it("an inferred array crossing into an unbranded parameter", () => {
      expect(checks(run({ "src/a.ts": LEG + "function inner(xs: number[]): void { void xs; }\nexport function outer(d: LegacyWallDeadline): void { const box = [d]; inner(box); }\n" }))).toEqual(["C5"]);
    });
    it("an inferred object crossing into an unbranded shape, and an object spread", () => {
      expect(checks(run({ "src/a.ts": LEG + "function inner(o: { at: number }): void { void o; }\nexport function outer(d: LegacyWallDeadline): void { const box = { at: d }; inner(box); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "function inner(o: { at: number }): void { void o; }\nexport function outer(d: LegacyWallDeadline): void { const src = { at: d }; inner({ ...src }); }\n" }))).toEqual(["C5"]);
    });
    it("STRING, COMPUTED and NUMERIC property names (round 3)", () => {
      const I = "function inner(o: { at: number }): void { void o; }\n";
      expect(checks(run({ "src/a.ts": LEG + I + 'export function outer(d: LegacyWallDeadline): void { inner({ "at": d }); }\n' }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + I + 'export function outer(d: LegacyWallDeadline): void { inner({ ["at"]: d }); }\n' }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "function inner(o: { 0: number }): void { void o; }\nexport function outer(d: LegacyWallDeadline): void { inner({ 0: d }); }\n" }))).toEqual(["C5"]);
    });
    it("ACCESSORS and METHODS of an object literal (round 3): their returns are checked against the contextual member", () => {
      expect(checks(run(F("const o: { at: number } = { get at() { return d; } }; void o;")))).toEqual(["C5"]);
      expect(checks(run(F("const o: { at(): number } = { at() { return d; } }; void o;")))).toEqual(["C5"]);
      expect(checks(run(F("void JSON.stringify({ get at() { return d; } });")))).toEqual(["C5"]); // the contextual type is `any`: a sink
    });
    it("a spread argument into unbranded parameters — fixed and rest", () => {
      expect(checks(run({ "src/a.ts": LEG + "function inner(a: number, b: number): void { void a; void b; }\nexport function outer(d: LegacyWallDeadline): void { inner(...[d, d] as [LegacyWallDeadline, LegacyWallDeadline]); }\n" }))).toEqual(["C1", "C5", "C5"]); // positional (round 12): each tuple element meets its own parameter
      expect(checks(run({ "src/a.ts": LEG + "function inner(...xs: number[]): void { void xs; }\nexport function outer(d: LegacyWallDeadline): void { const xs = [d]; inner(...xs); }\n" }))).toEqual(["C5"]);
    });
    it("a callback's CONTEXTUAL return type is a sink when concrete; an inference type parameter and void are not", () => {
      expect(checks(run(F("const f: () => number = () => d; void f;")))).toEqual(["C5"]);
      expect(checks(run(F("const g: () => number = () => { return d; }; void g;")))).toEqual(["C5"]);
      expect(run(F("const same = [d].map((x) => x); void same;")).findings).toEqual([]);       // inferred: carries the brand
      expect(run(F("const discard: () => void = () => d; void discard;")).findings).toEqual([]); // void discards
    });
    it("COMPOUND ASSIGNMENT (round 3): ??=, ||=, &&= are assignments", () => {
      expect(checks(run(F("let n: number | undefined; n ??= d; void n;")))).toEqual(["C5"]);
      expect(checks(run(F("let n = 0; n ||= d; void n;")))).toEqual(["C5"]);
      expect(checks(run(F("let n = 1; n &&= d; void n;")))).toEqual(["C5"]);
    });
    it("GENERATORS (round 3): yield against the declared yield type, return against the declared return type", () => {
      expect(checks(run({ "src/a.ts": LEG + "export function* g(d: LegacyWallDeadline): Generator<number> { yield d; }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "export function* g(d: LegacyWallDeadline): Generator<void, number> { return d; }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "export async function f(d: LegacyWallDeadline): Promise<number> { return d; }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "export function* g(d: LegacyWallDeadline): Generator<LegacyWallDeadline> { yield d; }\n" }).findings).toEqual([]);
    });
    it("INDEX SIGNATURES (round 6): a Record of deadlines carries the brand — closure, seam, any, and literals into it", () => {
      const r = run({ "src/a.ts": LEG + "function inner(o: { [k: string]: number }): void { void o; }\nexport function outer(rs: Record<string, LegacyWallDeadline>): void { inner(rs); }\n" });
      expect(checks(r)).toEqual(["C5"]);
      expect(r.closure.some((c) => c.owner === "outer" && c.name === "rs")).toBe(true);
      const T = LEG + "declare function take(rs: Record<string, LegacyWallDeadline>): void;\n";
      expect(checks(run({ "src/a.ts": T + "declare const a: any;\ntake({ x: a });\nconst o = { y: a }; take(o);\n" }))).toEqual(["C3", "C3"]);
      expect(run({ "src/a.ts": T + "export function outer(d: LegacyWallDeadline): void { take({ x: d }); const o = { y: d }; take(o); }\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": LEG + "declare function takeN(rs: Record<string, number>): void;\nexport function outer(d: LegacyWallDeadline): void { takeN({ x: d }); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "declare function takeArr(xs: { [i: number]: number }): void;\nexport function outer(d: LegacyWallDeadline): void { takeArr({ 0: d }); }\n" }))).toEqual(["C5"]);
    });
    it("PARAMETER DEFAULTS and PROPERTY INITIALIZERS are edges (round 7): a value flows into the declared or contextual type", () => {
      expect(checks(run({ "src/a.ts": LEG + "declare const a: any;\nexport function f(d: LegacyWallDeadline = a): void { void d; }\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": LEG + "export function g(leg: LegacyWallDeadline, n: number = leg): void { void n; }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "interface I { m(d: LegacyWallDeadline): void }\ndeclare const a: any;\nexport const i: I = { m(d = a) { void d; } };\n" }))).toEqual(["C3"]); // contextual: the default launders into the branded parameter
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { class C { at: number = d; } void C; }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "declare const a: any;\nexport class C { at: LegacyWallDeadline = a; }\n" }))).toEqual(["C3"]);
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { class C { at = d; } const g = (x = d) => x; void C; void g; }\n" }).findings).toEqual([]); // inferred: carries the brand
    });
    it("TEMPLATE-LITERAL and SYMBOL index signatures (round 7): paired by KEY DOMAIN — laundering and erasure alike", () => {
      const T = LEG + "declare function takeT(o: { [k: `x-${string}`]: LegacyWallDeadline }): void;\ndeclare function takeS(o: { [k: symbol]: LegacyWallDeadline }): void;\n";
      expect(checks(run({ "src/a.ts": T + "declare const a: { [k: `x-${string}`]: any };\ntakeT(a);\ndeclare const b: { [k: symbol]: any };\ntakeS(b);\n" }))).toEqual(["C3", "C3"]);
      expect(checks(run({ "src/a.ts": T + "declare const a: { [k: string]: any };\ntakeT(a);\n" }))).toEqual(["C3"]); // a string index covers `x-${string}` keys
      expect(checks(run({ "src/a.ts": LEG + "declare function takeN(o: { [k: `${number}`]: LegacyWallDeadline }): void;\ndeclare const a: { [k: number]: any };\ntakeN(a);\n" }))).toEqual(["C3"]); // a number index covers `${number}` keys (the checker's numericStringType)
      expect(checks(run({ "src/a.ts": LEG + "declare function num(o: { [k: `x-${string}`]: number }): void;\nexport function outer(d: LegacyWallDeadline): void { num({ \"x-1\": d }); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "const sym: unique symbol = Symbol();\ndeclare function num(o: { [k: symbol]: number }): void;\nexport function outer(d: LegacyWallDeadline): void { num({ [sym]: d }); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "const sym: unique symbol = Symbol();\ndeclare function num(o: { [k: symbol]: number }): void;\nexport function outer(d: LegacyWallDeadline): void { const o = { [sym]: d }; num(o); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": T + "const sym: unique symbol = Symbol();\nexport function outer(d: LegacyWallDeadline): void { takeT({ \"x-1\": d }); takeS({ [sym]: d }); }\n" }).findings).toEqual([]);
    });
    it("INDEX ↔ PROPERTY pairing in BOTH directions (round 8): a mapped numeric or symbol key the value answers only through an index — the compiler skips the optional property, the runtime reads through the index", () => {
      const V = "declare const v: { [k: number]: any };\n";
      expect(checks(run({ "src/a.ts": LEG + V + "type S = Partial<Record<-1, LegacyWallDeadline>>;\nexport const s: S = v;\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": LEG + V + "type S = Partial<Record<1.5 | -2, LegacyWallDeadline>>;\nexport const s: S = v;\n" }))).toEqual(["C3"]);
      expect(run({ "src/a.ts": LEG + V + 'type S = Partial<Record<"01" | "1e21", LegacyWallDeadline>>;\nexport const s: S = v;\n' }).findings).toEqual([]);            // not numeric names: a number index does not answer them…
      expect(checks(run({ "src/a.ts": LEG + 'declare const v: { [k: string]: any };\ntype S = Partial<Record<"01", LegacyWallDeadline>>;\nexport const s: S = v;\n' }))).toEqual(["C3"]); // …a string index does
      const SYM = LEG + "const sym: unique symbol = Symbol();\ntype S = Partial<Record<typeof sym, LegacyWallDeadline>>;\n";
      expect(checks(run({ "src/a.ts": SYM + "declare const v: { [k: symbol]: any };\nexport const s: S = v;\n" }))).toEqual(["C3"]);
      expect(run({ "src/a.ts": SYM + "declare const v: { [k: string]: any };\nexport const s: S = v;\n" }).findings).toEqual([]);                                     // a symbol key is outside the string domain
      expect(checks(run({ "src/a.ts": SYM + "declare const v: { [sym]: any };\nexport const s: S = v;\n" }))).toEqual(["C3"]);                                       // the same-named SYMBOL property, resolved by its escaped name
      expect(checks(run({ "src/a.ts": LEG + "function g(d: number): void { void d; }\ndeclare const v: { [k: number]: typeof g };\ntype S = Partial<Record<-1, (d: LegacyWallDeadline) => void>>;\nexport const s: S = v;\n" }))).toEqual(["C5"]); // the drop lock through the index
      expect(run({ "src/a.ts": LEG + "type S = Partial<Record<-1, LegacyWallDeadline>>;\nexport function f(w: { [k: number]: LegacyWallDeadline }): void { const s: S = w; void s; }\n" }).findings).toEqual([]); // carries the brand through the index
      // the checker's preference: a `string` index is consulted only when no other applies — the number index carries the brand here
      // the `any` string index WRITES the same runtime property the optional sink property reads (round 10): every value index answering the key is paired — no preference here either
      expect(checks(run({ "src/a.ts": LEG + "type S = Partial<Record<-1, LegacyWallDeadline>>;\nexport function f(v: { [k: string]: any; [k: number]: LegacyWallDeadline }): S { const key: string = \"-1\"; v[key] = \"not a deadline\"; return v; }\n" }))).toEqual(["C3"]);
    });
    it("sink INDEX ← value INDEXES pairs EVERY applicable value index in BOTH applicability directions (round 9): the checker relates one by preference (getApplicableIndexInfo) or every narrower one (membersRelatedToIndexInfo) — the audit pairs the union and never suppresses a `string` index", () => {
      const T = LEG + "declare function take(x: { [k: string]: LegacyWallDeadline }): void;\n";
      expect(checks(run({ "src/a.ts": T + "export function f(v: { [k: string]: any; [k: number]: LegacyWallDeadline }): void { take(v); }\n" }))).toEqual(["C3"]);                                              // the `any` string index answers every non-numeric key
      expect(checks(run({ "src/a.ts": T + "declare const v: { [k: number]: any };\ntake(v);\n" }))).toEqual(["C3"]);                                                                                          // no string index: the number index's keys fall within the sink's domain
      expect(checks(run({ "src/a.ts": T + "declare const v: { [k: `a-${string}`]: any };\ntake(v);\n" }))).toEqual(["C3"]);                                                                                   // a template index likewise
      expect(checks(run({ "src/a.ts": LEG + "declare function takeN(x: { [k: number]: LegacyWallDeadline }): void;\nexport function f(v: { [k: string]: any; [k: number]: LegacyWallDeadline }): void { takeN(v); }\n" }))).toEqual(["C3"]); // the checker relates only the number index; the `any` string index still answers numeric keys — paired, fail closed
      expect(run({ "src/a.ts": LEG + "export function f(v: { [k: string]: LegacyWallDeadline; [k: number]: LegacyWallDeadline }): void { const t: { [k: string]: LegacyWallDeadline } = v; void t; }\n" }).findings).toEqual([]);
    });
    it("TypeScript's EXACT numeric rules (round 8): `${number}` is the single-placeholder template only; a literal name is numeric iff it round-trips through ToNumber", () => {
      const N = LEG + "declare const v: { [k: number]: any };\n";
      expect(checks(run({ "src/a.ts": N + "declare function take(o: { [k: `${number}`]: LegacyWallDeadline }): void;\ntake(v);\n" }))).toEqual(["C3"]);
      expect(run({ "src/a.ts": N + "declare function take(o: { [k: `${number}${number}`]: LegacyWallDeadline }): void;\ntake(v);\n" }).findings).toEqual([]); // another template type: the checker relates nothing
      expect(run({ "src/a.ts": N + "declare function take(o: { [k: `${bigint}`]: LegacyWallDeadline }): void;\ntake(v);\n" }).findings).toEqual([]);
      const A = LEG + "declare function takeArr(xs: { [i: number]: number; [k: string]: LegacyWallDeadline | number }): void;\n";
      expect(checks(run({ "src/a.ts": A + 'export function outer(d: LegacyWallDeadline): void { takeArr({ "-1": d }); takeArr({ "1.5": d }); takeArr({ 0x10: d }); }\n' }))).toEqual(["C5", "C5", "C5"]); // numeric names reach the number index
      expect(run({ "src/a.ts": A + 'export function outer(d: LegacyWallDeadline): void { takeArr({ "01": d }); takeArr({ "1e21": d }); }\n' }).findings).toEqual([]);                  // not numeric names: the string index (branded) receives them
      expect(checks(run({ "src/a.ts": LEG + "declare function pref(o: { [k: string]: number; [k: number]: LegacyWallDeadline }): void;\nexport function outer(d: LegacyWallDeadline): void { pref({ 1: d }); }\n" }))).toEqual(["C5"]); // the checker routes the literal's key to the number index, but the slot stays readable through the string-index view as a plain number (round 11)
    });
    it("a runtime SLOT has every declared VIEW (round 11): a same-named property does not exclude an applicable index, and a literal's property is checked against each view independently — never against their union", () => {
      // F1: the `any` string index writes the slot the branded named property declares
      expect(checks(run({ "src/a.ts": LEG + "type S = Partial<Record<-1, LegacyWallDeadline>>;\nexport function f(v: { [k: string]: any; \"-1\": LegacyWallDeadline }): S { const key: string = \"-1\"; v[key] = \"not a deadline\"; return v; }\n" }))).toEqual(["C3"]);
      // F2: after the literal enters the sink, the same property is readable through the string-index view as a plain number
      const T = LEG + "function take(x: { [k: string]: number; [k: number]: LegacyWallDeadline }): void { const key: string = \"1\"; const erased: number | undefined = x[key]; void erased; }\n";
      expect(checks(run({ "src/a.ts": T + "export function f(d: LegacyWallDeadline): void { take({ 1: d }); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "declare function ok(x: { [k: string]: LegacyWallDeadline | number; [k: number]: LegacyWallDeadline }): void;\nexport function f(d: LegacyWallDeadline): void { ok({ 1: d }); }\n" }).findings).toEqual([]); // every view carries the brand
      // a computed key of UNION type is split into its runtime alternatives: "x" lands on the string index (number), 1 on the number index (branded) — one report for the property
      expect(checks(run({ "src/a.ts": LEG + "declare function take(x: { [k: string]: number; [k: number]: LegacyWallDeadline }): void;\ndeclare const k: \"x\" | 1;\nexport function f(d: LegacyWallDeadline): void { take({ [k]: d }); }\n" }))).toEqual(["C5"]);
      // an unnarrowable key meets every property in its domain: `at` is a view
      expect(checks(run({ "src/a.ts": LEG + "declare function take(x: { at?: number; [k: string]: number | LegacyWallDeadline | undefined }): void;\ndeclare const s: string;\nexport function f(d: LegacyWallDeadline): void { take({ [s]: d }); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "declare function take(x: { at?: LegacyWallDeadline; [k: string]: number | LegacyWallDeadline | undefined }): void;\ndeclare const s: string;\nexport function f(d: LegacyWallDeadline): void { take({ [s]: d }); }\n" }).findings).toEqual([]);
    });
    it("a UNION sink is split into the constituents the literal can inhabit (round 12): the branch the literal lands in is the view — an unrelated brand elsewhere in the union cannot mask it", () => {
      expect(checks(run({ "src/a.ts": LEG + "declare function take(x: { at: number } | { deadline: LegacyWallDeadline }): void;\nexport function f(d: LegacyWallDeadline): void { take({ at: d }); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "declare function take(x: { at: LegacyWallDeadline } | { deadline: number }): void;\nexport function f(d: LegacyWallDeadline): void { take({ at: d }); }\n" }).findings).toEqual([]);
      expect(run({ "src/a.ts": LEG + "declare function take(x: { at: number; must: string } | { at: LegacyWallDeadline }): void;\nexport function f(d: LegacyWallDeadline): void { take({ at: d }); }\n" }).findings).toEqual([]); // the checker rules the first constituent out (`must` is missing); so does the audit
      expect(checks(run({ "src/a.ts": LEG + "declare function take(x: { at: number } | { at: LegacyWallDeadline }): void;\nexport function f(d: LegacyWallDeadline): void { take({ at: d }); }\n" }))).toEqual(["C5"]); // both viable: the callee may read `at` as a plain number
    });
    it("EVERY reachable view is a destination (round 12): a first-party generic's declared type beside its instantiation, each parameter a spread feeds — never a union of alternatives", () => {
      expect(checks(run({ "src/a.ts": LEG + "function generic<T extends number>(x: T): void { const erased: number = x; void erased; }\nexport function f(d: LegacyWallDeadline): void { generic(d); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "function id<T>(x: T): T { return x; }\nexport function f(d: LegacyWallDeadline): void { void id(d); }\n" }))).toEqual(["C5"]);            // a first-party bare `T`: the body is audited without the brand (round 6 finding 1)
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void Promise.resolve(d); void [d].includes(d); }\n" }).findings).toEqual([]); // a library generic: its declared `T` is its own abstraction — stated policy
      const SP = LEG + "function spread(a: LegacyWallDeadline, b: number): void { void a; void b; }\n";
      expect(checks(run({ "src/a.ts": SP + "export function f(xs: [LegacyWallDeadline, LegacyWallDeadline]): void { spread(...xs); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": SP + "export function f(xs: [LegacyWallDeadline, number]): void { spread(...xs); }\n" }).findings).toEqual([]);                        // positional: the number lands in `b`
      expect(run({ "src/a.ts": SP + "export function f(d: LegacyWallDeadline): void { spread(...[d, 5]); }\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": SP + "export function f(d: LegacyWallDeadline): void { spread(...[d, d]); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "function rest(a: string, ...ns: number[]): void { void a; void ns; }\nexport function f(xs: [string, ...LegacyWallDeadline[]]): void { rest(...xs); }\n" }))).toEqual(["C5"]); // the rest element reaches the rest parameter
    });
    it("a viable constituent WITHOUT a view is a view itself (round 13): `{}` beside a branded branch erases", () => {
      expect(checks(run({ "src/a.ts": LEG + "declare function take(x: {} | { at: LegacyWallDeadline }): void;\nexport function f(d: LegacyWallDeadline): void { take({ at: d }); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "declare function takeA(x: {} | [LegacyWallDeadline]): void;\nexport function f(d: LegacyWallDeadline): void { takeA([d]); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "declare function take(x: { at: LegacyWallDeadline } | { at: LegacyWallDeadline; more: string }): void;\nexport function f(d: LegacyWallDeadline): void { take({ at: d }); }\n" }).findings).toEqual([]);
    });
    it("NESTED spreads are placed positionally (round 13): inside an array literal and inside a call spread — one routine for every spread", () => {
      expect(checks(run({ "src/a.ts": LEG + "declare function takeTuple(x: [LegacyWallDeadline, number]): void;\nexport function f(d: LegacyWallDeadline, xs: [LegacyWallDeadline]): void { takeTuple([d, ...xs]); }\n" }))).toEqual(["C5"]);   // xs[0] lands in slot 1: number
      expect(run({ "src/a.ts": LEG + "declare function takeTuple(x: [LegacyWallDeadline, number, LegacyWallDeadline]): void;\nexport function f(d: LegacyWallDeadline, t: [number, LegacyWallDeadline]): void { takeTuple([d, ...t]); }\n" }).findings).toEqual([]);
      const CALL = LEG + "declare function call(a: LegacyWallDeadline, b: number, c: LegacyWallDeadline): void;\n";
      expect(run({ "src/a.ts": CALL + "export function f(d: LegacyWallDeadline, t: [number, LegacyWallDeadline]): void { call(...[d, ...t]); }\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": CALL + "export function f(d: LegacyWallDeadline, u: [LegacyWallDeadline, LegacyWallDeadline]): void { call(...[d, ...u]); }\n" }))).toEqual(["C5"]); // u[0] lands in `b`
      expect(checks(run({ "src/a.ts": LEG + "declare function rest(...ns: number[]): void;\nexport function f(d: LegacyWallDeadline, ns: number[]): void { rest(...[...ns, d]); }\n" }))).toEqual(["C5"]);                 // after an array of unknown length, `d` reaches the rest parameter's element
    });
    it("a library generic's DECLARED view counts when its declaration states a capability (round 13): a constrained type parameter consumes the value; an unconstrained one only holds it", () => {
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void [[1]].flat(d); }\n" }))).toEqual(["C5"]);   // `flat<A, D extends number>(depth?: D)`: the depth is consumed as a number
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void [d].fill(d, d); }\n" }))).toEqual(["C5"]);  // `value: T` holds it; `start: number` (declared as instantiated) erases
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void Promise.resolve(d); void [d].includes(d); void new Map<string, LegacyWallDeadline>().set(\"k\", d); void [d].indexOf(d); }\n" }).findings).toEqual([]);
    });
    it("a DECLARED view is read POSITION BY POSITION (round 14): a constraint consumes what it can reach, never a nested brand it cannot", () => {
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void Object.assign({ deadline: d }, {}); }\n" }).findings).toEqual([]);          // `T extends {}` reads the outer object; `.deadline` is out of its reach
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void [[1]].flat(d); }\n" }))).toEqual(["C5"]);                              // `D extends number` reads the value itself as a number
      expect(run({ "src/a.ts": LEG + "function keep<T extends {}>(x: T): T { return x; }\nexport function f(d: LegacyWallDeadline): void { void keep({ deadline: d }); }\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": LEG + "function keep<T extends {}>(x: T): T { return x; }\nexport function f(d: LegacyWallDeadline): void { void keep(d); }\n" }))).toEqual(["C5"]);   // the value itself, read as `{}`: `toString` is a number method
      expect(checks(run({ "src/a.ts": LEG + "function els<T extends number>(xs: T[]): void { void xs; }\nexport function f(d: LegacyWallDeadline): void { els([d]); }\n" }))).toEqual(["C5"]);  // the element position
      expect(run({ "src/a.ts": LEG + "function els<T extends { at: LegacyWallDeadline }>(xs: T[]): void { void xs; }\nexport function f(d: LegacyWallDeadline): void { els([{ at: d }]); }\n" }).findings).toEqual([]);
    });
    it("a call's RECEIVER is an edge (round 14): read as the explicit `this` parameter, else as the type that declares the method", () => {
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): string { return d.toString(); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): number { return d.valueOf(); }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): string { return d.toFixed(1); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline, m: Map<string, LegacyWallDeadline>): void { void m.set(\"k\", d); void m.get(\"k\"); void [d].includes(d); void [d].map((x) => x); }\n" }).findings).toEqual([]); // deadlines in type arguments stay deadlines
      expect(checks(run({ "src/a.ts": LEG + "interface S { at: LegacyWallDeadline; show(this: { at: number }): string }\nexport function f(s: S): string { return s.show(); }\n" }))).toEqual(["C5"]);            // an explicit `this`
      expect(checks(run({ "src/a.ts": LEG + "interface S { at: LegacyWallDeadline; show<T extends { at: number }>(this: T): string }\nexport function f(s: S): string { return s.show(); }\n" }))).toEqual(["C5"]); // a constrained generic `this`
      expect(run({ "src/a.ts": LEG + "interface Req { deadline: LegacyWallDeadline; touch(): void }\nexport function f(r: Req): void { r.touch(); }\n" }).findings).toEqual([]);                                   // the declaring owner carries the brand
    });
    it("a VALUE that is a type parameter reads as its constraint (round 15 finding 1): a brand carried through `T` — or through `this` — is lost where the concrete value's would be", () => {
      expect(checks(run({ "src/a.ts": LEG + "export function f<T extends LegacyWallDeadline>(d: T): void { void [[1]].flat(d); }\n" }))).toEqual(["C5"]);       // `D extends number` reads `T`'s constraint as a number
      expect(checks(run({ "src/a.ts": LEG + "export function f<T extends LegacyWallDeadline>(d: T): string { return d.toString(); }\n" }))).toEqual(["C5"]);  // the receiver, through `T`
      expect(run({ "src/a.ts": LEG + "export function f<T extends LegacyWallDeadline>(d: T, m: Map<string, T>): void { void m.set(\"k\", d); void [d].includes(d); }\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": LEG + "class B { at = 0; m(): number { return this.at; } }\nexport class C extends B { constructor(override at: LegacyWallDeadline) { super(); } n(): number { return this.m(); } }\n" }))).toEqual(["C5"]); // `this` is a type parameter constrained to `C`, whose `at` the base method reads as a number
    });
    it("every invocation form has its receiver (round 15 finding 2): `super.m()` is the CURRENT instance, a tagged template invokes its tag with a receiver and its substitutions as arguments, an optional call is a call, `new` has none", () => {
      const BASE = "class B { at = 0; m(): number { return this.at; } }\n";
      expect(checks(run({ "src/a.ts": LEG + BASE + "export class C extends B { constructor(override at: LegacyWallDeadline) { super(); } n(): number { return super.m(); } }\n" }))).toEqual(["C5"]);   // the checker types `super` as `B`; the instance is a `C`
      expect(run({ "src/a.ts": LEG + BASE + "export class C extends B { constructor(public d: LegacyWallDeadline) { super(); } n(): number { return super.m(); } }\n" }).findings).toEqual([]);         // a property `B` does not declare is out of `B`'s reach
      expect(checks(run({ "src/a.ts": LEG + "declare function tag(s: TemplateStringsArray, ...vs: number[]): string;\nexport function f(d: LegacyWallDeadline): string { return tag`at ${d}`; }\n" }))).toEqual(["C5"]);              // a substitution is an argument from position 1 on
      expect(run({ "src/a.ts": LEG + "declare function tag(s: TemplateStringsArray, ...vs: LegacyWallDeadline[]): string;\nexport function f(d: LegacyWallDeadline): string { return tag`at ${d}`; }\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": LEG + "interface S { at: LegacyWallDeadline; tag(this: { at: number }, s: TemplateStringsArray): string }\nexport function f(s: S): string { return s.tag`x`; }\n" }))).toEqual(["C5"]);          // the tag's receiver, read as its explicit `this`
      expect(run({ "src/a.ts": LEG + "interface S { at: LegacyWallDeadline; tag(s: TemplateStringsArray): string }\nexport function f(s: S): string { return s.tag`x`; }\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void d?.toString(); }\n" }))).toEqual(["C5"]);                                                                // an optional call is a call
      expect(run({ "src/a.ts": LEG + "class K { constructor(public at: LegacyWallDeadline) {} }\nexport function f(d: LegacyWallDeadline): K { return new K(d); }\n" }).findings).toEqual([]);                // `new` has no receiver
    });
    it("an unconstrained LIBRARY type parameter is a fail-closed read (round 15 finding 3): a `.d.ts` proves nothing about the body behind it; only a LIBRARY_GENERIC_TRUST declaration — default-lib identity — reads nothing", () => {
      const DEP = { "node_modules/dep/package.json": '{ "name": "dep", "types": "index.d.ts" }\n', "node_modules/dep/index.d.ts": "export declare function coerce<T>(x: T): number;\nexport declare function keep<T>(x: T): T;\nexport interface PromiseConstructor { resolve<T>(x: T): T }\nexport declare const P: PromiseConstructor;\n" };
      expect(checks(run({ ...DEP, "src/a.ts": LEG + 'import { coerce } from "dep";\nexport function f(d: LegacyWallDeadline): number { return coerce(d); }\n' }))).toEqual(["C5"]);   // `Number(x)` is type-correct behind an unconstrained `T`
      expect(checks(run({ ...DEP, "src/a.ts": LEG + 'import { keep } from "dep";\nexport function f(d: LegacyWallDeadline): void { void keep(d); }\n' }))).toEqual(["C5"]);         // identity by SIGNATURE is not identity by contract
      expect(checks(run({ ...DEP, "src/a.ts": LEG + 'import { P } from "dep";\nexport function f(d: LegacyWallDeadline): void { void P.resolve(d); }\n' }))).toEqual(["C5"]);     // a dependency spelling a trusted name is not the default lib
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void { void Promise.resolve(d); void [d].includes(d); }\n" }).findings).toEqual([]);           // trusted: settled with / compared by contract
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): string { return [d].join(); }\n" }))).toEqual(["C5"]);                                      // `Array.join` serializes `T` — never trusted
    });
    it("a callback into a library generic is a value like any other (round 15): the instantiated callback type carries the brand in its parameters, so a wider or `any` parameter is caught at the edge — a library callable included", () => {
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): string[] { return [d].map(String); }\n" }))).toEqual(["C3"]);                                          // `(value?: any) => string` launders the element
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): unknown[] { return [d].map((x: any) => x); }\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): number[] { return [d].map((x: number) => x); }\n" }))).toEqual(["C5"]);                                 // declared wider than the element
      expect(checks(run({ "src/a.ts": LEG + "function fmt(x: number): number { return x; }\nexport function f(d: LegacyWallDeadline): number[] { return [d].map(fmt); }\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): LegacyWallDeadline[] { return [d].map((x) => x); }\n" }).findings).toEqual([]);                                // contextually typed: the element as it is
    });
    it("branded sinks that CARRY the brand at depth are not seams", () => {
      const ok = LEG + "type Req = { deadlineMs?: LegacyWallDeadline };\nfunction send(r: Req): void { void r; }\nfunction sendAll(rs: Req[]): void { void rs; }\nexport function outer(d: LegacyWallDeadline): void { send({ deadlineMs: d }); sendAll([{ deadlineMs: d }]); const rs = [{ deadlineMs: d }]; sendAll([...rs]); }\n";
      expect(run({ "src/a.ts": ok }).findings).toEqual([]);
    });
  });

  describe("PRODUCTION-BOUNDARY LOCKS (round 3): an implementation wider than its public signature", () => {
    it("an overload's implementation declaring `number` behind a LegacyWallDeadline overload", () => {
      const r = run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void;\nexport function f(d: number): void { void d; }\n" });
      expect(checks(r)).toEqual(["C5"]);
      expect(r.findings[0]!.message).toContain("behind overload");
      // the SAME shape with the implementation typed correctly is clean, and so is an unannotated one
      expect(run({ "src/a.ts": LEG + "export function f(d: LegacyWallDeadline): void;\nexport function f(d: LegacyWallDeadline | number): void { void d; }\n" }).findings).toEqual([]);
    });
    it("a class method behind an `implements` member, and behind an `extends` member", () => {
      expect(checks(run({ "src/a.ts": LEG + "interface I { m(d: LegacyWallDeadline): void }\nexport class C implements I { m(d: number): void { void d; } }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "class B { m(d: LegacyWallDeadline): void { void d; } }\nexport class C extends B { override m(d: number): void { void d; } }\n" }))).toEqual(["C5"]);
      const setter = { "src/a.ts": LEG + "interface I { at: LegacyWallDeadline }\nexport class C implements I { private v = 0 as LegacyWallDeadline /* O1-DEBT-0001 */; get at(): LegacyWallDeadline { return this.v; } set at(d: number) { void d; } }\n" };
      expect(checks(run(setter, ratchetFor(setter)))).toEqual(["C5"]);
    });
    it("STRUCTURAL assignment WITHOUT `implements` (round 4): a class instance, a function value, a nested member", () => {
      const I = "interface I { m(d: LegacyWallDeadline): void }\n";
      expect(checks(run({ "src/a.ts": LEG + I + "class C { m(d: number): void { void d; } }\nexport const i: I = new C();\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + I + "class C { m(d: number): void { void d; } }\ndeclare function use(i: I): void;\nuse(new C());\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "function g(d: number): void { void d; }\nexport const f: (d: LegacyWallDeadline) => void = g;\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "type Svc = { inner: { m(d: LegacyWallDeadline): void } };\nconst impl = { inner: { m(d: number) { void d; } } };\nexport const s: Svc = impl;\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + I + "class C { m(d: LegacyWallDeadline): void { void d; } }\nexport const i: I = new C();\n" }).findings).toEqual([]);
      expect(run({ "src/a.ts": LEG + "function g(d: LegacyWallDeadline | number): void { void d; }\nexport const f: (d: LegacyWallDeadline) => void = g;\n" }).findings).toEqual([]);
    });
    it("an INTERFACE redeclaring an inherited branded member wider (round 4) — before any class implements it", () => {
      const r = run({ "src/a.ts": LEG + "interface Base { m(d: LegacyWallDeadline): void }\ninterface Wide extends Base { m(d: number): void }\nexport class C implements Wide { m(d: number): void { void d; } }\n" });
      expect(checks(r)).toEqual(["C5"]);
      expect(r.findings[0]!.message).toContain("redeclaring");
      expect(checks(run({ "src/a.ts": LEG + "interface Base { cb: (d: LegacyWallDeadline) => void }\ninterface Wide extends Base { cb: (d: number) => void }\nexport const w: Wide | null = null;\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "interface Base { m(d: LegacyWallDeadline): void }\ninterface Same extends Base { m(d: LegacyWallDeadline): void }\nexport const s: Same | null = null;\n" }).findings).toEqual([]);
    });
    it("an object literal's method, function property and setter under a contextual type", () => {
      expect(checks(run({ "src/a.ts": LEG + "interface I { m(d: LegacyWallDeadline): void }\nexport const i: I = { m(d: number) { void d; } };\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "type F = { m: (d: LegacyWallDeadline) => void };\nexport const f: F = { m: (d: number) => { void d; } };\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "type S = { at: LegacyWallDeadline };\nexport const s: S = { set at(d: number) { void d; }, get at() { return 0 as LegacyWallDeadline /* O1-DEBT-0001 */; } };\n" }, ratchetFor({ "src/a.ts": LEG + "type S = { at: LegacyWallDeadline };\nexport const s: S = { set at(d: number) { void d; }, get at() { return 0 as LegacyWallDeadline /* O1-DEBT-0001 */; } };\n" })))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "interface I { m(d: LegacyWallDeadline): void }\nexport const i: I = { m(d) { void d; } };\n" }).findings).toEqual([]); // contextually typed
    });
    it("OVERLOAD CORRESPONDENCE (round 5): an identical overload set is matched pairwise, never as a Cartesian product", () => {
      const I = LEG + "interface I { m(d: LegacyWallDeadline): void; m(s: string): void }\n";
      expect(run({ "src/a.ts": I + "class C { m(d: LegacyWallDeadline): void; m(s: string): void; m(x: LegacyWallDeadline | string): void { void x; } }\nexport const i: I = new C();\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": I + "class C { m(d: number): void; m(s: string): void; m(x: number | string): void { void x; } }\nexport const i: I = new C();\n" }))).toEqual(["C5"]);
    });
    it("a bare type parameter behind a branded parameter IS a drop (round 6): `T` carries no brand, so a laundering body is invisible — the lock at the boundary is the only guard", () => {
      const r = run({ "src/a.ts": LEG + "function g<T>(d: T): number { return Number(String(d)); }\nexport const f: (d: LegacyWallDeadline) => number = g;\n" });
      expect(r.findings.map((f) => [f.check, f.line])).toEqual([["C5", 2]]); // at the boundary; nothing inside g is a seam
      expect(checks(run({ "src/a.ts": LEG + "declare function h<T extends number>(d: T): void;\nexport const f: (d: LegacyWallDeadline) => void = h;\n" }))).toEqual(["C5"]);
      expect(run({ "src/a.ts": LEG + "declare function ok<T extends LegacyWallDeadline>(d: T): void;\nexport const f: (d: LegacyWallDeadline) => void = ok;\n" }).findings).toEqual([]);
    });
    it("`this` PARAMETERS are in the closure (round 6): a wider `this` behind a branded one is a drop — at the declaration and structurally; `this: any` launders", () => {
      const T = LEG + "type F = (this: { d: LegacyWallDeadline }) => void;\n";
      expect(checks(run({ "src/a.ts": T + "function g(this: { d: number }): void { void this.d; }\nexport const f: F = g;\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": LEG + "interface I { m(this: { d: LegacyWallDeadline }): void }\nexport class C implements I { m(this: { d: number }): void { void this.d; } }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": T + "function g(this: any): void { void this; }\nexport const f: F = g;\n" }))).toEqual(["C3"]);
      expect(run({ "src/a.ts": T + "function g(this: { d: LegacyWallDeadline }): void { void this.d; }\nexport const f: F = g;\n" }).findings).toEqual([]);
    });
    it("an annotated `any` parameter behind a branded signature is reported ONCE, as a laundering (C3) — at the declaration and structurally", () => {
      const I = LEG + "interface I { m(d: LegacyWallDeadline): void }\n";
      expect(checks(run({ "src/a.ts": I + "export class C implements I { m(d: any): void { void d; } }\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": I + "class C { m(d: any): void { void d; } }\nexport const i: I = new C();\n" }))).toEqual(["C3"]);
    });
    it("an INTERFACE redeclaring an inherited branded PROPERTY as an accessor or `any` (round 6): getter return, setter parameter, property type — and a class property declared `any`", () => {
      const B = LEG + "interface Base { deadline: LegacyWallDeadline }\n";
      expect(checks(run({ "src/a.ts": B + "interface Wide extends Base { get deadline(): any }\nexport const w: Wide | null = null;\n" }))).toEqual(["C3"]);
      expect(checks(run({ "src/a.ts": B + "interface Wide extends Base { get deadline(): LegacyWallDeadline; set deadline(v: number) }\nexport const w: Wide | null = null;\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": B + "interface Wide extends Base { deadline: any }\nexport const w: Wide | null = null;\n" }))).toEqual(["C3"]);
      expect(run({ "src/a.ts": B + "interface Same extends Base { get deadline(): LegacyWallDeadline; set deadline(v: LegacyWallDeadline) }\nexport const s: Same | null = null;\n" }).findings).toEqual([]);
      expect(checks(run({ "src/a.ts": B + "export class C implements Base { deadline: any = 0; }\n" }))).toEqual(["C3"]);
    });
    it("a brand in a PARAMETER of the RETURNED type drops through a wider return — the structural lock applied to the return, at the declaration and structurally", () => {
      const P = LEG + "interface P { m(): (d: LegacyWallDeadline) => void }\n";
      expect(checks(run({ "src/a.ts": P + "export class C implements P { m(): (d: number) => void { return (d) => { void d; }; } }\n" }))).toEqual(["C5"]);
      expect(checks(run({ "src/a.ts": P + "function g(d: number): void { void d; }\nclass C { m(): (d: number) => void { return g; } }\nexport const p: P = new C();\n" }))).toEqual(["C5"]);
    });
  });

  it("comparisons and arithmetic are the legacy paths — NOT findings", () => {
    expect(run({ "src/a.ts": CLEAN }, ratchetFor({ "src/a.ts": CLEAN })).findings).toEqual([]);
  });
});

// ─── write modes, end-to-end against the real tree ──────────────────

describe("ratchet write modes (real tree, temp ratchet)", () => {
  const real = join(REPO, "o1-seam-debt.json");
  it("--init refuses when a ratchet exists; check passes on the checked-in one", () => {
    const dir = mkdtempSync(join(tmpdir(), "o1-seam-cli-")); dirs.push(dir);
    const tmp = join(dir, "r.json"); copyFileSync(real, tmp);
    expect(cli(["--init"], tmp).status).toBe(2);
    const r = cli([], tmp); expect(r.stdout).toContain("OK —"); expect(r.status).toBe(0);
  });
  it("--write RETIRES a stale entry (the real tree holds ZERO markers after the O1 migration, so an entry the tree no longer carries is exactly what retirement removes)", () => {
    // The REFUSAL half (a live marker missing from the baseline) is locked by the C2 fixture tests
    // above: with no marker left in the real tree it cannot be exercised end-to-end here.
    const dir = mkdtempSync(join(tmpdir(), "o1-seam-cli-")); dirs.push(dir);
    const tmp = join(dir, "r.json");
    const base = JSON.parse(readFileSync(real, "utf8")) as SeamRatchet;
    expect(base.entries).toHaveLength(0);
    const stale = { id: "O1-DEBT-9999", kind: "construction" as const, file: "src/store.ts", scope: "gone", brands: ["MonoDeadline"], hash: "00000000", text: "retired" };
    writeFileSync(tmp, JSON.stringify({ ...base, entries: [stale] }));
    expect(cli([], tmp).status).toBe(0); // a stale entry is progress, not a finding
    const w = cli(["--write"], tmp); expect(w.stdout).toContain("retired 1 debt"); expect(w.status).toBe(0);
    expect((JSON.parse(readFileSync(tmp, "utf8")) as SeamRatchet).entries).toHaveLength(0);
  });
});

// ─── the real tree ──────────────────────────────────────────────────

describe("repository state", () => {
  const r = audit(scopedFiles(REPO), REPO, loadRatchet());
  const has = (file: string, owner: string, name: string) => r.closure.some((c) => c.file === file && c.owner === owner && c.name === name);
  it("zero findings against the checked-in ratchet", () => { expect(r.findings).toEqual([]); });
  it("FALSIFIER: the closure reproduces every site codex named, from the roots alone — now on the MIGRATED seams (O1 step 2: `deadline: MonoDeadline`)", () => {
    expect(has("src/store.ts", "searchVecMatch", "deadline")).toBe(true);
    expect(has("src/store.ts", "searchVec", "deadline")).toBe(true);
    expect(has("src/store.ts", "VecSearchDetailedOpts", "deadline")).toBe(true);
    expect(has("src/store.ts", "searchVecDetailed", "opts")).toBe(true);
    expect(has("src/store.ts", "getEmbedding", "deadline")).toBe(true);          // PRIVATE
    expect(has("src/store.ts", "expandQuery", "opts")).toBe(true);
    expect(has("src/store.ts", "RerankProbeOptions", "deadline")).toBe(true);
    expect(has("src/llm.ts", "LlamaCpp.expandQuery", "options")).toBe(true);
    expect(has("src/vector-daemon.ts", "startVectorDaemon", "deadline")).toBe(true); // INTERNAL callback
    expect(has("src/vector-daemon.ts", "daemonVecMatch", "deadline")).toBe(true);
    expect(has("src/vector-daemon.ts", "searchVecBounded", "deadline")).toBe(true);
    expect(has("src/vector-daemon.ts", "searchVecDaemonRequired", "deadline")).toBe(true);
    expect(has("src/eval/vec-daemon-child.ts", "childMain", "deadline")).toBe(true); // no sweep listed it
    // The WIRE carries a plain integer (`remainingBudgetMs`), constructed daemon-side only after
    // validation: the request type is NOT a branded seam any more (the legacy `deadlineMs` seam is gone).
    expect(r.closure.some((c) => c.file === "src/vector-daemon.ts" && c.owner === "VecReq")).toBe(false);
  });
  it("ROUND 2, finding 7: the Stop-hook deadline seam codex named is inside the closure (migrated: `deadline`)", () => {
    expect(has("src/causal-writer.ts", "runCausalStep", "deadline")).toBe(true);
    // 62.1: the contradiction judge moved to stop-judge.ts (Phase A carries the Stop deadline).
    expect(has("src/stop-judge.ts", "judgePhaseA", "deadline")).toBe(true);
    // 62.1: checkMergePolicy was deleted (D4); the batched extraction carries the Stop deadline instead.
    expect(has("src/stop-extract.ts", "ExtractionArgs", "deadline")).toBe(true);
    expect(has("src/hooks/decision-extractor.ts", "decisionExtractor", "deadline")).toBe(true);
  });
  it("every deadline seam is MonoDeadline and the relative seam is DurationMs — the legacy brand is gone from the closure", () => {
    const at = (owner: string, name: string) => r.closure.find((c) => c.owner === owner && c.name === name)?.brands ?? [];
    expect(at("RerankProbeOptions", "deadline")).toEqual(["MonoDeadline"]);
    expect(at("RerankProbeOptions", "timeoutMs")).toEqual(["DurationMs"]);
    expect(at("searchVecMatch", "deadline")).toEqual(["MonoDeadline"]);
    expect(r.closure.every((c) => !c.brands.includes("LegacyWallDeadline"))).toBe(true);
  });
  it("ZERO debt entries after the migration (activation precondition, O1 §6 step 4) and the two baselined diagnostics", () => {
    expect(r.entries).toEqual([]);
    // v0.43.7 (82.2 D4): the third baselined diagnostic — `src/consolidation.ts`, the untyped MATCH seed of the
    // surprisal scan — is RETIRED: the seed is now read through `storedVector` (a Float32Array). Two remain.
    expect(r.diagnostics).toHaveLength(2);
    expect(r.diagnostics.find((d) => d.file === "src/consolidation.ts")).toBeUndefined();
    expect(r.diagnostics.map((d) => d.file)).toEqual(["src/conversation-synthesis.ts", "src/conversation-synthesis.ts"]);
  });
});
