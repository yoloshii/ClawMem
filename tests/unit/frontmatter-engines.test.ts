/**
 * 82.1 — executable frontmatter (`---js` runs code through gray-matter's eval engine) and YAML memory amplification.
 * DESIGN-82.1.md rev 7 §4: T1–T11. Written BEFORE the fix; every test that guards new behaviour fails on ea92fa0.
 *
 * `src/indexer.ts` is imported as a NAMESPACE so the baseline run reaches every test: a named import of an export the
 * base lacks (`makeFrontmatterYamlEngine`, `frontmatterGuardStatus`) would fail the whole module at link time.
 *
 * Payloads are harmless: an in-process sentinel counter, or (across a process boundary) a marker file the payload
 * writes into the test's temp dir with `Bun.write`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import matter from "gray-matter";
import jsyaml from "js-yaml";
import * as indexer from "../../src/indexer.ts";
import { createStore, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { runSampledVectorValidation } from "../../src/canary.ts";
import ts from "typescript";
import { bow, deadPort, startEmbedFixture, type EmbedFixture } from "../helpers/embed-readiness-fixture.ts";

const { parseDocument, hashContent, indexCollection } = indexer;
const ROOT = resolve(import.meta.dir, "../..");
const SENTINEL = "__clawmem_82_1_sentinel";
const g = globalThis as any;

/** The exec payload: bumps the in-process sentinel, evaluates to a `title`. */
const EXEC = `{ title: (globalThis.${SENTINEL} = (globalThis.${SENTINEL} || 0) + 1, 'x') }`;
const ran = () => (g[SENTINEL] ?? 0) as number;
const resetSentinel = () => { g[SENTINEL] = 0; };

/** What parseDocument returns for text that is NOT frontmatter: the whole text as body, the inferred type only. */
const plain = (content: string, path = "note.md") => ({ body: content, meta: { content_type: parseDocument("plain text\n", path).meta.content_type } });

const expectPlainText = (content: string, path = "note.md") => {
  const r = parseDocument(content, path);
  expect(r).toEqual(plain(content, path));
};

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "clawmem-821-")); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

// ─── T1 exec spellings ────────────────────────────────────────────────────────────────────────────────────────────
describe("T1 — every spelling that reaches gray-matter's javascript engine is read as plain text", () => {
  const spellings: Record<string, string> = {
    "---js": `---js\n${EXEC}\n---\nbody\n`,
    "---javascript": `---javascript\n${EXEC}\n---\nbody\n`,
    "--- js ": `--- js \n${EXEC}\n---\nbody\n`,
    "---\\t js  ": `---\t js  \n${EXEC}\n---\nbody\n`,
    "---JS": `---JS\n${EXEC}\n---\nbody\n`,
    "---jS": `---jS\n${EXEC}\n---\nbody\n`,
    "---JavaScript": `---JavaScript\n${EXEC}\n---\nbody\n`,
    "---JAVASCRIPT": `---JAVASCRIPT\n${EXEC}\n---\nbody\n`,
    "CRLF ---js": `---js\r\n${EXEC}\r\n---\r\nbody\r\n`,
    "BOM ---js": `﻿---js\n${EXEC}\n---\nbody\n`,
  };
  // every input is distinct AFTER BOM stripping (§4: gray-matter's cache keys on the stripped text), so no spelling can
  // be served from an earlier one's cache entry on the baseline — a marker comment in the payload differs per case
  for (const [name, raw] of Object.entries(spellings)) {
    const content = raw.replace(EXEC, `${EXEC} /* ${name.replace(/[^\w]/g, "_")} */`);
    it(`${name}: no code runs, body === content, meta = {content_type}`, () => {
      resetSentinel();
      expectPlainText(content);
      expect(ran()).toBe(0);
    });
  }
  it("an EMPTY ---js block is plain text (not empty frontmatter)", () => {
    expectPlainText("---js\n---\nbody\n");
  });
  it("a comment-only ---js block is plain text", () => {
    expectPlainText("---js\n# just a comment\n---\nbody\n");
  });
});

// ─── T2 refused tags ──────────────────────────────────────────────────────────────────────────────────────────────
describe("T2 — a language tag outside yaml/yml/json takes the catch path", () => {
  for (const tag of ["coffee", "toml", "constructor", "toString", "valueOf", "__proto__"]) {
    it(`---${tag} (nonempty) → plain text`, () => expectPlainText(`---${tag}\ntitle: T\n---\nbody\n`));
  }
  it("---JSON (nonempty; gray-matter does not lowercase json) → plain text", () => {
    expectPlainText(`---JSON\n{"title":"T"}\n---\nbody\n`);
  });
  it("---JSON EMPTY block (skips engine lookup) → plain text", () => expectPlainText("---JSON\n---\nbody\n"));
  it("---JSON comment-only block → plain text", () => expectPlainText("---JSON\n# c\n---\nbody\n"));
});

// ─── T3 allowed input unchanged (guards) ──────────────────────────────────────────────────────────────────────────
describe("T3 — allowed frontmatter is unchanged (guards; pass on the baseline)", () => {
  it("plain --- YAML with every field", () => {
    const r = parseDocument("---\ntitle: T\ntags: [a, b]\ndomain: d\nworkstream: w\nreview_by: r\ncontent_type: decision\n---\nbody\n", "n.md");
    expect(r.body).toBe("body\n");
    expect(r.meta.title).toBe("T");
    expect(r.meta.tags).toEqual(["a", "b"]);
    expect(r.meta.domain).toBe("d");
    expect(r.meta.workstream).toBe("w");
    expect(r.meta.review_by).toBe("r");
    expect(r.meta.content_type).toBe("decision");
  });
  it("---yaml, ---yml, ---json", () => {
    expect(parseDocument("---yaml\ntitle: Y\n---\nb\n", "n.md").meta.title).toBe("Y");
    expect(parseDocument("---yml\ntitle: Y2\n---\nb\n", "n.md").meta.title).toBe("Y2");
    expect(parseDocument(`---json\n{"title":"J"}\n---\nb\n`, "n.md").meta.title).toBe("J");
  });
  it("a whitespace-only tag is yaml", () => {
    expect(parseDocument("---   \ntitle: W\n---\nb\n", "n.md").meta.title).toBe("W");
  });
  // No frontmatter and a `----` first line are NOT the catch path: gray-matter returns the text with empty data, so
  // the normal branch runs — body is the whole text and authored_at is null (a declared absence), not undefined.
  const expectNotFrontmatter = (content: string) => {
    const r = parseDocument(content, "n.md");
    expect(r.body).toBe(content);
    expect(r.meta.title).toBeUndefined();
    expect(r.meta.authored_at).toBeNull();
  };
  it("no frontmatter → whole text, empty data", () => expectNotFrontmatter("just a note\nwith lines\n"));
  it("---- first line is not frontmatter", () => expectNotFrontmatter("----\ntitle: T\n---\nb\n"));
  it("an empty --- block parses as empty frontmatter", () => {
    const r = parseDocument("---\n---\nbody\n", "n.md");
    expect(r.body).toBe("body\n");
    expect(r.meta.title).toBeUndefined();
  });
  it("a first line with no newline: ---yaml → the `yam` quirk → catch path; bare --- does not throw", () => {
    expectPlainText("---yaml");
    const r = parseDocument("---", "n.md");
    expect(typeof r.body).toBe("string");
  });
  it("a YAML date in authored_at", () => {
    expect(parseDocument("---\nauthored_at: 2025-03-01\n---\nb\n", "n.md").meta.authored_at).toBe("2025-03-01T00:00:00.000Z");
  });
  it("malformed YAML → catch path", () => expectPlainText("---\ntitle: [unclosed\n---\nb\n"));
  it("!!js/function → catch path (safe schema)", () => expectPlainText("---\nf: !!js/function 'function () {}'\n---\nb\n"));
});

// ─── T4 empty input ───────────────────────────────────────────────────────────────────────────────────────────────
describe("T4 — the empty document", () => {
  it("parseDocument('') returns body '' with authored_at null (a declared absence, not a parse failure)", () => {
    const r = parseDocument("", "x.md");
    expect(r.body).toBe("");
    expect(r.meta.authored_at).toBeNull();
    expect(r.meta.content_type).toBe(plain("", "x.md").meta.content_type);
  });
  it("through indexCollection: emptying a dated file clears its authored_at", async () => {
    const db = join(tmp, "t4.sqlite");
    Bun.env.INDEX_PATH = db;
    setDefaultLlamaCpp({ embed: async () => null, query: async () => null, generate: async () => "not json", expandQuery: async () => [] } as any);
    const store: Store = createStore();
    try {
      const coll = join(tmp, "t4coll");
      mkdirSync(coll, { recursive: true });
      writeFileSync(join(coll, "d.md"), `---\ntitle: D\nauthored_at: "2025-03-01T00:00:00.000Z"\n---\n\nbody\n`);
      await indexCollection(store, "t4", coll, "**/*.md");
      const row = () => store.db.prepare(`SELECT authored_at FROM documents WHERE collection = 't4' AND path = 'd.md' AND active = 1`).get() as { authored_at: string | null };
      expect(row().authored_at).toBe("2025-03-01T00:00:00.000Z");
      writeFileSync(join(coll, "d.md"), "");
      await indexCollection(store, "t4", coll, "**/*.md");
      expect(row().authored_at).toBeNull();
    } finally { store.close(); }
  });
});

// ─── T5 cache ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("T5 — parseDocument never uses gray-matter's module cache", () => {
  const cache = (matter as any).cache as Record<string, any>;
  it("a parse leaves matter.cache unchanged", () => {
    const before = Object.keys(cache).length;
    parseDocument("---\ntitle: cache-probe-82-1-a\n---\nb\n", "n.md");
    expect(Object.keys(cache).length).toBe(before);
  });
  it("a poisoned cache entry for the exact stripped input is ignored", () => {
    const input = "---\ntitle: real-82-1\n---\nreal body\n";
    cache[input] = { data: { title: "POISON" }, content: "poison body", orig: input, language: "", matter: "", excerpt: "" };
    try {
      const r = parseDocument(input, "n.md");
      expect(r.meta.title).toBe("real-82-1");
      expect(r.body).toBe("real body\n");
    } finally { delete cache[input]; }
  });
  it("the same malformed input parsed twice takes the catch path both times", () => {
    const bad = "---\ntitle: [unclosed-82-1\n---\nb\n";
    expectPlainText(bad);
    expectPlainText(bad);
  });
  it("81.2 handoff case: two identical files with a nested-object excerpt_separator parse the same, title kept", () => {
    const input = "---\ntitle: T\nexcerpt_separator:\n  toString: invalid\n---\nbody\n";
    const a = parseDocument(input, "n.md");
    const b = parseDocument(input, "n.md");
    expect(a).toEqual(b);
    expect(a.meta.title).toBe("T");
    expect(a.body).toBe("body\n");
  });
});

// ─── fixtures shared by T6 / T11 ──────────────────────────────────────────────────────────────────────────────────
const inner128 = "{" + Array.from({ length: 128 }, (_, i) => `k${i}: ${i}`).join(", ") + "}";
const aliasBomb = (() => {           // depth 6, branching 8: 8^6 = 262,144 leaves if expanded
  let s = "a0: &a0 [x, x, x, x, x, x, x, x]\n";
  for (let d = 1; d <= 6; d++) s += `a${d}: &a${d} [${Array(8).fill(`*a${d - 1}`).join(", ")}]\n`;
  return s;
})();
const mergeFixture = "base: &b " + inner128 + "\n" + Array.from({ length: 128 }, (_, i) => `m${i}: {<<: *b}`).join("\n") + "\n";
const arrayKeyFixture = "s: &s " + "x".repeat(1024) + "\n? [" + Array(128).fill("*s").join(", ") + "]\n: v\n";
const omap1024 = "o: !!omap\n" + Array.from({ length: 1024 }, (_, i) => `  - k${i}: ${i}`).join("\n") + "\n";
const nestedMerge = (levels: number) => "m: " + "{<<: ".repeat(levels) + inner128 + "}".repeat(levels);
const nestedSeq = (n: number) => "a: " + "[".repeat(n) + "1" + "]".repeat(n);

/** Node count by the design's own measure — `open` events of js-yaml's listener — read from the REAL loader. */
function countNodes(src: string): number {
  let n = 0;
  jsyaml.safeLoad(src, { listener: (ev: string) => { if (ev === "open") n++; } } as any);
  return n;
}
/** A flow sequence under one key whose listener node count is exactly `nodes`. */
function seqWithNodes(nodes: number): string {
  const base = countNodes("a: [1]");            // nodes for one scalar
  return "a: [" + Array(nodes - base + 1).fill("1").join(", ") + "]";
}

const engine = () => (indexer as any).makeFrontmatterYamlEngine(jsyaml) as { parse(s: string): unknown; status(): { broken: boolean; reason?: string } };
/** The engine REFUSED the input: it threw, and not because the API is missing (a baseline without the API must not pass). */
const expectRefused = (fn: () => unknown) => {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(Error);
  expect(String((err as Error).message)).not.toMatch(/is not a function|undefined/);
};

// ─── T6 amplification ─────────────────────────────────────────────────────────────────────────────────────────────
describe("T6 — YAML amplification is refused, tags are bounded", () => {
  it("(a) an alias bomb → catch path", () => expectPlainText(`---\n${aliasBomb}---\nbody\n`));
  it("(b) merge amplification → catch path", () => expectPlainText(`---\n${mergeFixture}---\nbody\n`));
  it("(c) array-key amplification → catch path", () => expectPlainText(`---\n${arrayKeyFixture}---\nbody\n`));
  it("(d) an anchor that is never aliased → catch path (no title)", () => expectPlainText("---\nx: &nm 1\ntitle: T\n---\nbody\n"));
  it("(e) excerpt_separator {toString: false} with a title → title kept, body extracted", () => {
    const r = parseDocument("---\ntitle: T\nexcerpt_separator:\n  toString: false\n---\nbody\n", "n.md");
    expect(r.meta.title).toBe("T");
    expect(r.body).toBe("body\n");
  });
  it("(f) tags: ≤ 64 scalars, each ≤ 256 characters; nested lists and objects dropped", () => {
    const list = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const r = parseDocument(`---\ntags: [${list.join(", ")}, ${"L".repeat(300)}, [n1, n2], {o: 1}, 7, true]\n---\nb\n`, "n.md");
    expect(r.meta.tags).toEqual(list.slice(0, 64));
    const r2 = parseDocument(`---\ntags: [a, ${"L".repeat(300)}, [n1, n2], {o: 1}, 7, true]\n---\nb\n`, "n.md");
    expect(r2.meta.tags).toEqual(["a", "7", "true"]);
  });
  describe("through the exported yaml engine (deterministic, no timing)", () => {
    it("(g) an anchor-free 20-level nested merge parses with `<<` as a literal key; 128 levels throws (depth)", () => {
      const r = engine().parse(nestedMerge(20)) as any;
      expect(Object.keys(r.m)).toEqual(["<<"]);
      expect(r.m.k0).toBeUndefined();
      expectRefused(() => engine().parse(nestedMerge(128)));
    });
    it("(h) a 1,024-entry !!omap throws", () => expectRefused(() => engine().parse(omap1024)));
    it("(i) 30 nested sequences (depth 32) parse; 31 (depth 33) throw", () => {
      expect(engine().parse(nestedSeq(30))).toBeDefined();
      expectRefused(() => engine().parse(nestedSeq(31)));
    });
    it("(j) 4,096 nodes parse; 4,097 throw", () => {
      expect(countNodes(seqWithNodes(4096))).toBe(4096);
      expect(engine().parse(seqWithNodes(4096))).toBeDefined();
      expectRefused(() => engine().parse(seqWithNodes(4097)));
    });
    it("(k) 65,536 characters of valid YAML parse; 65,537 throw", () => {
      const ok = "title: " + "x".repeat(65536 - 7);
      expect(ok.length).toBe(65536);
      expect((engine().parse(ok) as any).title.length).toBe(65536 - 7);
      expectRefused(() => engine().parse(ok + "x"));
    });
    it("(l) &__proto__ on a scalar, a mapping, a sequence and an empty node throws", () => {
      for (const s of ["title: &__proto__ kept", "a: &__proto__ {b: 1}", "a: &__proto__ [1]", "a: &__proto__\nb: 1"]) {
        expectRefused(() => engine().parse(s));
      }
    });
  });
});

// ─── T11 block bounds BEFORE gray-matter ─────────────────────────────────────────────────────────────────────────
describe("T11 — the block is measured before gray-matter sees it (C9)", () => {
  // The spy: gray-matter calls `matter.language(str, opts)` exactly once per `matter()` call whose input passes
  // `matter.test` (every input below starts with `---x`), so its call count IS the matter() call count (T5 L3).
  let calls = 0;
  const real = (matter as any).language;
  const spyOn = () => { calls = 0; (matter as any).language = (...a: any[]) => { calls++; return real(...a); }; };
  const spyOff = () => { (matter as any).language = real; };
  const over = (content: string) => { spyOn(); try { expectPlainText(content); expect(calls).toBe(0); } finally { spyOff(); } };
  const atCap = (content: string) => { spyOn(); try { const r = parseDocument(content, "n.md"); expect(calls).toBe(1); return r; } finally { spyOff(); } };

  it("a comment-only block of 65,537 characters → plain text, zero matter() calls", () => {
    const block = "\n# " + "c".repeat(65537 - 3);         // the span starts right after `---`
    expect(block.length).toBe(65537);
    over(`---${block}\n---\nbody\n`);
  });
  /** Lines the way the design counts them: every CR, LF, U+2028, U+2029 is a terminator, CRLF once; lines = terminators + 1. */
  const lineCount = (block: string) => {
    let n = 0;
    for (let i = 0; i < block.length; i++) {
      const c = block.charCodeAt(i);
      if (c === 0x0a || c === 0x2028 || c === 0x2029) n++;
      else if (c === 0x0d) { n++; if (block.charCodeAt(i + 1) === 0x0a) i++; }
    }
    return n + 1;
  };
  for (const [name, sep] of [["LF", "\n"], ["CR", "\r"], ["CRLF", "\r\n"], ["U+2028", "\u2028"], ["U+2029", "\u2029"]] as const) {
    it(`exactly 1,025 lines separated by ${name} → plain text, zero matter() calls`, () => {
      const block = "\n" + Array.from({ length: 1024 }, (_, i) => `k${i}: 1`).join(sep);
      expect(lineCount(block)).toBe(1025);                 // asserted independently of the implementation
      over(`---${block}\n---\nbody\n`);
    });
  }
  it("an unclosed block over 65,536 characters → plain text, zero matter() calls", () => {
    over("---\n" + "x".repeat(70000));
  });
  it("a YAML block of exactly 65,536 characters parses with ONE matter() call", () => {
    const block = "\ntitle: " + "y".repeat(65536 - 8);
    expect(block.length).toBe(65536);
    const r = atCap(`---${block}\n---\nbody\n`);
    expect(r.meta.title?.length).toBe(65536 - 8);
    expect(r.body).toBe("body\n");
  });
  it("a JSON block of exactly 65,536 characters (the label counts) parses with ONE matter() call", () => {
    const head = `json\n{"title": "`;
    const tail = `"}`;
    const block = head + "j".repeat(65536 - head.length - tail.length) + tail;
    expect(block.length).toBe(65536);
    const r = atCap(`---${block}\n---\nbody\n`);
    expect(r.meta.title?.length).toBe(65536 - head.length - tail.length);
  });
  it("exactly 1,024 lines (LF) parses with ONE matter() call", () => {
    const block = "\n" + Array.from({ length: 1023 }, (_, i) => `k${i}: 1`).join("\n");
    expect(lineCount(block)).toBe(1024);
    const r = atCap(`---${block}\n---\nbody\n`);
    expect(r.body).toBe("body\n");
  });
  it("exactly 1,024 CRLF lines parses (CRLF counts once) with ONE matter() call", () => {
    const block = "\n" + Array.from({ length: 1023 }, (_, i) => `k${i}: 1`).join("\r\n");
    expect(lineCount(block)).toBe(1024);
    const r = atCap(`---${block}\n---\nbody\n`);
    expect(r.body).toBe("body\n");
  });
  it("a JSON block of exactly 1,024 lines parses with ONE matter() call", () => {
    // `json` label on line 1, `{` on line 2, 1,021 entries, `}` on line 1,024
    const entries = Array.from({ length: 1021 }, (_, i) => `"k${i}": "v"${i < 1020 ? "," : ""}`);
    const block = "json\n{\n" + entries.join("\n") + "\n}";
    expect(lineCount(block)).toBe(1024);
    const r = atCap(`---${block}\n---\nbody\n`);
    expect(r.body).toBe("body\n");
  });
  it("a JSON block of exactly 1,025 lines → plain text, zero matter() calls", () => {
    const entries = Array.from({ length: 1022 }, (_, i) => `"k${i}": "v"${i < 1021 ? "," : ""}`);
    const block = "json\n{\n" + entries.join("\n") + "\n}";
    expect(lineCount(block)).toBe(1025);
    over(`---${block}\n---\nbody\n`);
  });
  it("---- first line is not frontmatter (unchanged)", () => {
    const content = "----\n" + "x".repeat(70000);
    const r = parseDocument(content, "n.md");
    expect(r.body).toBe(content);
    expect(r.meta.title).toBeUndefined();
  });
  it("base-60 inside the cap parses", () => {
    const r = atCap("---\na: 1" + ":1".repeat(32000) + "\n---\nbody\n");
    expect(r.body).toBe("body\n");
  });
});

// ─── T10 self-check ───────────────────────────────────────────────────────────────────────────────────────────────
describe("T10 — the guard checks itself at first use (C10)", () => {
  /** Captures stderr lines written while `fn` runs. */
  const withStderr = (fn: () => void): string[] => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => { lines.push(String(chunk)); return true; };
    try { fn(); } finally { (process.stderr as any).write = orig; }
    return lines;
  };
  const anchored = "a: &x 1\nb: 2";

  it("(i) the real js-yaml passes the self-test; the engine parses and reports not broken", () => {
    const e = engine();
    expect((e.parse("title: T") as any).title).toBe("T");
    expect(e.status().broken).toBe(false);
    expect((indexer as any).frontmatterGuardStatus().broken).toBe(false);
  });
  it("(ii) a js-yaml whose safeLoad ignores `listener` → broken: yaml reads as plain text, ONE stderr line", () => {
    const fake = { ...jsyaml, safeLoad: (s: string, o: any) => jsyaml.safeLoad(s, { schema: o?.schema }) };
    const e = (indexer as any).makeFrontmatterYamlEngine(fake);
    const lines = withStderr(() => { expect(() => e.parse("title: T")).toThrow(); });
    expect(e.status().broken).toBe(true);
    expect(lines.length).toBe(1);
    withStderr(() => { expect(() => e.parse("title: T")).toThrow(); });   // still closed, no second line
    expect(withStderr(() => { try { e.parse("x: 1"); } catch { /* closed */ } }).length).toBe(0);
  });
  it("(iii) a js-yaml forwarding only the ROOT node's events → the trace check fails → broken", () => {
    const fake = {
      ...jsyaml,
      safeLoad: (s: string, o: any) => {
        let d = 0;
        return jsyaml.safeLoad(s, { ...o, listener: (ev: string, st: any) => {
          if (ev === "open") { d++; if (d === 1) o.listener?.(ev, st); }
          else { if (d === 1) o.listener?.(ev, st); d--; }
        } });
      },
    };
    const e = (indexer as any).makeFrontmatterYamlEngine(fake);
    withStderr(() => { expect(() => e.parse("title: T")).toThrow(); });
    expect(e.status().broken).toBe(true);
  });
  it("(iv) a js-yaml that hides anchors from anchorMap AND state.anchor → the anchored canary parses → broken", () => {
    const fake = {
      ...jsyaml,
      safeLoad: (s: string, o: any) => jsyaml.safeLoad(s, { ...o, listener: (ev: string, st: any) => o.listener?.(ev, { ...st, anchorMap: {}, anchor: null }) }),
    };
    const e = (indexer as any).makeFrontmatterYamlEngine(fake);
    withStderr(() => { expect(() => e.parse(anchored)).toThrow(); });
    expect(e.status().broken).toBe(true);
  });
  it("the production engine refuses the anchored canary and parses it without the anchor", () => {
    const e = engine();
    expectRefused(() => e.parse(anchored));
    expect(e.parse("a: 1\nb: 2")).toEqual({ a: 1, b: 2 });
  });
  it("clawmem doctor prints a ✗ line for a broken guard (test hook CLAWMEM_TEST_FRONTMATTER_GUARD=broken)", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawmem-821-doctor-"));
    try {
      // the model probes get dead ports and local models are off, as the 62.2 doctor test does — otherwise the doctor
      // waits on the real endpoints
      const dead = `http://127.0.0.1:${deadPort()}`;
      const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "doctor"], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"), INDEX_PATH: join(home, "v.sqlite"),
               CLAWMEM_EMBED_URL: dead, CLAWMEM_LLM_URL: dead, CLAWMEM_RERANK_URL: dead, CLAWMEM_NO_LOCAL_MODELS: "true",
               NO_COLOR: "1", CLAWMEM_TEST_FRONTMATTER_GUARD: "broken" },
        stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text() + await new Response(proc.stderr).text();
      await proc.exited;
      const line = out.split("\n").find(l => l.includes("✗") && /frontmatter/i.test(l));
      expect(line).toBeDefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});

// ─── T9 pins ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe("T9 — pins (C8)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const installed = (name: string) => JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version as string;
  it("package.json pins gray-matter exactly 4.0.3 and js-yaml ~3.14.2 as a direct dependency", () => {
    expect(pkg.dependencies["gray-matter"]).toBe("4.0.3");
    expect(pkg.dependencies["js-yaml"]).toBe("~3.14.2");
  });
  it("the installed gray-matter is 4.0.3 and js-yaml 3.14.x", () => {
    expect(installed("gray-matter")).toBe("4.0.3");
    expect(installed("js-yaml")).toMatch(/^3\.14\./);
  });
  it("canary: a YAML block with one anchor is refused, the same block without it parses (C7 present)", () => {
    expectPlainText("---\nx: &a 1\ntitle: T\n---\nb\n");
    expect(parseDocument("---\nx: 1\ntitle: T\n---\nb\n", "n.md").meta.title).toBe("T");
  });
});

// ─── T7 paths ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("T7 — every production parse site is protected", () => {
  const MARK = "oriolefeather";
  const fakeLlm = { embed: async () => null, query: async () => null, generate: async () => "not json", expandQuery: async () => [] } as any;

  it("(i) indexCollection over a ---js file: no code runs, the stored body is the whole text", async () => {
    const db = join(tmp, "t7i.sqlite");
    Bun.env.INDEX_PATH = db;
    setDefaultLlamaCpp(fakeLlm);
    const store = createStore();
    try {
      const coll = join(tmp, "t7coll");
      mkdirSync(coll, { recursive: true });
      const content = `---js\n${EXEC}\n---\nbody of the ${MARK} note\n`;
      writeFileSync(join(coll, "exec.md"), content);
      resetSentinel();
      await indexCollection(store, "t7", coll, "**/*.md");
      expect(ran()).toBe(0);
      const row = store.db.prepare(`SELECT c.doc FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = 't7' AND d.path = 'exec.md' AND d.active = 1`).get() as { doc: string };
      expect(row.doc).toBe(content);
    } finally { store.close(); }
  });

  describe("(ii) + (iii) a stored ---js row through `clawmem embed` (child process) and the canary (in-process)", () => {
    let home: string; let vault: string; let marker: string; let fixture: EmbedFixture | undefined;
    const payload = (m: string) => `---js\n{ title: (globalThis.Bun.write(${JSON.stringify(m)}, "ran"), 'x') }\n---\nThe ${MARK} pipeline batches its writes in groups of five hundred to cut the fsync cost.\n`;
    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), "clawmem-821-embed-"));
      vault = join(home, "vault.sqlite");
      marker = join(home, "marker.txt");
      mkdirSync(join(home, ".cache", "qmd", "models"), { recursive: true });
      writeFileSync(join(home, ".cache", "qmd", "models", "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"), "not a model");
      const st = createStore(vault);
      try {
        const body = payload(marker);
        const now = new Date().toISOString();
        const hash = hashContent(body);
        st.insertContent(hash, body, now);
        st.insertDocument("notes", "exec.md", "exec", hash, now, now);
      } finally { st.close(); }
    });
    afterAll(() => { fixture?.stop(); rmSync(home, { recursive: true, force: true }); });

    it("positive control: the same payload through an UNPROTECTED matter() in a child DOES write its marker", async () => {
      const ctl = join(home, "control.txt");
      const script = `import matter from ${JSON.stringify(join(ROOT, "node_modules/gray-matter/index.js"))}; matter(${JSON.stringify(payload(ctl))}); await Bun.sleep(50);`;
      const p = Bun.spawn([process.execPath, "-e", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      await p.exited;
      expect(existsSync(ctl)).toBe(true);
    });

    it("(ii) `clawmem embed` completes and the payload never runs", async () => {
      fixture = startEmbedFixture({ fragmentMark: MARK });
      const dead = `http://127.0.0.1:${deadPort()}`;
      const base: Record<string, string | undefined> = { ...process.env };
      for (const k of ["CLAWMEM_EMBED_API_KEY", "CLAWMEM_EMBED_MODEL", "CLAWMEM_EMBED_WAIT_SEC", "CLAWMEM_EMBED_WAIT_INTERVAL_MS", "CLAWMEM_EMBED_PROBE_TIMEOUT_MS"]) delete base[k];
      const proc = Bun.spawn([process.execPath, "src/clawmem.ts", "embed"], {
        cwd: ROOT,
        env: { ...base, HOME: home, CLAWMEM_CONFIG_DIR: join(home, ".config", "clawmem"), INDEX_PATH: vault, CLAWMEM_EMBED_URL: fixture.url, CLAWMEM_LLM_URL: dead, CLAWMEM_RERANK_URL: dead, NO_COLOR: "1", CLAWMEM_NO_LOCAL_MODELS: "true" },
        stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text() + await new Response(proc.stderr).text();
      const code = await proc.exited;
      expect({ code, marker: existsSync(marker), fragments: fixture.count("fragment") > 0 }).toEqual({ code: 0, marker: false, fragments: true });
      expect(out).not.toContain("Error:");
    }, 120_000);

    it("(iii) the sampled canary reconstructs the ---js document without running it", async () => {
      try { unlinkSync(marker); } catch { /* absent */ }
      const st = createStore(vault);
      try {
        const r = await runSampledVectorValidation(st, async (t) => ({ embedding: bow(t, 64), model: "bow-embed" }));
        expect(r.eligible).toBeGreaterThan(0);       // the embed run above left vectors to sample — never vacuous
        expect(r.unreconstructable).toBe(0);
        await Bun.sleep(50);
        expect(existsSync(marker)).toBe(false);
      } finally { st.close(); }
    }, 60_000);
  });
});

// ─── T8 source guard ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * C6 — the binding is guarded, not just the call. `files` = { repo-relative path → source }. Returns the violations
 * (empty = pass).
 *
 * The source is tokenised by the TypeScript compiler's own parser (`ts.createSourceFile`, a devDependency) and the
 * predicate works on the token sequence: strings and template-literal text are `str` tokens (a template's `${…}`
 * expressions are code and contribute their own tokens, in source order); identifiers and keywords are `id` tokens;
 * everything else (punctuation, numbers, regex literals) is `punct`; comments and JSDoc are trivia and never tokens.
 * So a package name inside a comment or a string is never read as a binding, `-matter(` is the identifier like any
 * other, and no hand-rolled lexing edge (template braces, regex braces, comment terminators) exists to get wrong —
 * three Codex turns (C1 Low 1, C2 Low 1, C3 Lows 1–2) each found one in the regex/lexer versions this replaces. A
 * source the parser cannot parse is itself a violation (fail closed).
 */
type Tok = { kind: "id" | "str" | "punct"; value: string };
function tokenize(src: string, path = "src/indexer.ts"): { toks: Tok[]; errors: number } {
  const kind = /\.ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const errors = (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length;
  const out: Tok[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;   // trivia
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const children = node.getChildren(sf);
    if (children.length > 0 && node.kind !== ts.SyntaxKind.Identifier) { for (const c of children) visit(c); return; }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) { out.push({ kind: "id", value: node.text }); return; }
    if (node.kind >= ts.SyntaxKind.FirstKeyword && node.kind <= ts.SyntaxKind.LastKeyword) { out.push({ kind: "id", value: ts.tokenToString(node.kind)! }); return; }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) { out.push({ kind: "str", value: node.text }); return; }
    out.push({ kind: "punct", value: node.getText(sf) });
  };
  visit(sf);
  return { toks: out, errors };
}

function sourceGuard(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [path, raw] of Object.entries(files)) {
    const { toks, errors } = tokenize(raw, path);
    if (errors > 0) { out.push(`${path}: ${errors} parse error(s) — unparseable source is not shippable`); continue; }
    const strs = toks.filter(t => t.kind === "str").map(t => t.value);
    const mentions = (pkg: string) => strs.filter(s => s === pkg || s.startsWith(pkg + "/")).length;
    if (path !== "src/indexer.ts") {
      if (mentions("gray-matter")) out.push(`${path}: binds gray-matter`);
      if (mentions("js-yaml")) out.push(`${path}: binds js-yaml`);
      continue;
    }
    const seq = toks.map(t => (t.kind === "str" ? `"${t.value}"` : t.value));
    // gray-matter: exactly one string mention, and it is the default import `import matter from "gray-matter";`
    if (mentions("gray-matter") !== 1) out.push(`indexer: gray-matter named ${mentions("gray-matter")} times (expected 1: the default import)`);
    const importIdx = seq.findIndex((v, k) => v === "import" && seq[k + 1] === "matter" && seq[k + 2] === "from" && seq[k + 3] === '"gray-matter"' && seq[k + 4] === ";");
    if (importIdx === -1) out.push('indexer: gray-matter must be bound by exactly `import matter from "gray-matter";`');
    // the identifier `matter`: exactly twice — the import and the ONE guarded call `matter(content, FRONTMATTER_OPTIONS)`
    const matterIdx = seq.map((v, k) => (v === "matter" ? k : -1)).filter(k => k >= 0);
    if (matterIdx.length !== 2) out.push(`indexer: identifier matter appears ${matterIdx.length} times (expected 2)`);
    const isGuardedCall = (k: number) => seq.slice(k, k + 6).join(" ") === "matter ( content , FRONTMATTER_OPTIONS )";
    const calls = matterIdx.filter(k => k !== importIdx + 1);
    if (!calls.some(isGuardedCall)) out.push("indexer: the call must be exactly matter(content, FRONTMATTER_OPTIONS)");
    for (const k of calls) if (!isGuardedCall(k)) out.push(`indexer: matter used other than the guarded call (token ${k})`);
    // js-yaml: one default import; its identifier is used exactly once more — as `makeFrontmatterYamlEngine(<id>)`, the
    // library itself and nothing derived from it
    if (mentions("js-yaml") !== 1) out.push(`indexer: js-yaml named ${mentions("js-yaml")} times (expected 1: the default import)`);
    const jyImport = seq.findIndex((v, k) => v === "import" && seq[k + 2] === "from" && seq[k + 3] === '"js-yaml"' && seq[k + 4] === ";");
    if (jyImport === -1) out.push("indexer: js-yaml must be bound by exactly one default import");
    else {
      const jy = seq[jyImport + 1]!;
      const uses = seq.map((v, k) => (v === jy ? k : -1)).filter(k => k >= 0 && k !== jyImport + 1);
      if (uses.length !== 1) out.push(`indexer: js-yaml identifier ${jy} used ${uses.length} times (expected 1)`);
      // the argument is the identifier itself, closed by `)`; a TypeScript `as <Type>` chain is type-only (erased at
      // runtime, derives nothing) and is the one thing allowed between them — `.`, `(`, `[` are derivations and fail
      const closesArg = (k: number) => { let j = k + 1; while (seq[j] === "as" && /^[A-Za-z_$][\w$]*$/.test(seq[j + 1] ?? "")) j += 2; return seq[j] === ")"; };
      for (const k of uses) if (!(seq[k - 2] === "makeFrontmatterYamlEngine" && seq[k - 1] === "(" && closesArg(k))) out.push(`indexer: js-yaml identifier ${jy} used other than as makeFrontmatterYamlEngine(${jy})`);
    }
  }
  return out;
}

function shippedCode(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      if (rel.includes("node_modules")) return;
      for (const e of readdirSync(abs)) walk(join(rel, e));
    } else if (/\.(ts|js|mjs|cjs)$/.test(rel) && !/\.d\.ts$/.test(rel)) files[rel] = readFileSync(abs, "utf8");
  };
  for (const f of pkg.files as string[]) walk(f.replace(/\/$/, ""));
  return files;
}

describe("T8 — source guard (C6)", () => {
  it("the real shipped tree passes", () => {
    expect(sourceGuard(shippedCode())).toEqual([]);
  });
  const good = `import matter from "gray-matter";\nimport jsYaml from "js-yaml";\nconst E = makeFrontmatterYamlEngine(jsYaml);\nconst f = matter(content, FRONTMATTER_OPTIONS);\n`;
  it("the predicate accepts the intended shape and its counterexamples each fail", () => {
    expect(sourceGuard({ "src/indexer.ts": good })).toEqual([]);
    const bad: Record<string, string> = {
      "matter.stringify": good + "matter.stringify(x);\n",
      "matter.read": good + "matter.read(p);\n",
      "alias": good + "const m = matter;\n",
      "bare call": good.replace("matter(content, FRONTMATTER_OPTIONS)", "matter(content)"),
      "namespace import": good.replace('import matter from "gray-matter";', 'import * as matter from "gray-matter";'),
      "require": good + 'const gm = require("gray-matter");\n',
      "subpath import": good + 'import engines from "gray-matter/lib/engines.js";\n',
      "re-export": good + 'export { default as matter2 } from "gray-matter";\n',
      "js-yaml used twice": good + "jsYaml.safeLoad(s);\n",
      "js-yaml used instead of the builder": good.replace("makeFrontmatterYamlEngine(jsYaml)", "jsYaml.safeLoad(content)"),
      "unary minus before matter": good + "const score = -matter(content).data.score;\n",
      "comment markers inside strings": good + 'const a = "/*"; matter(content); const b = "*/";\n',
      "matter inside a template expression": good + "const title = `${matter(content).data.title}`;\n",
      "js-yaml inside a template expression": good + "const value = `${jsYaml.safeLoad(content)}`;\n",
      "a quoted brace inside the template expression": good + "const t = `${\"}\" + matter(content).data.title}`;\n",
      "a quoted brace and a comment inside the expression": good + "const u = `${'}' /* } */ + jsYaml.safeLoad(content)}`;\n",
      "builder receives a parser call, not the library": good.replace("makeFrontmatterYamlEngine(jsYaml)", "makeFrontmatterYamlEngine(jsYaml.safeLoad(content))"),
      "builder receives a cast parser call": good.replace("makeFrontmatterYamlEngine(jsYaml)", "makeFrontmatterYamlEngine(jsYaml.safeLoad(content) as unknown as Lib)"),
      "builder receives an indexed member": good.replace("makeFrontmatterYamlEngine(jsYaml)", "makeFrontmatterYamlEngine(jsYaml[\"safeLoad\"])"),
      "regex braces inside a template expression, call after the template": good + "const s = `${/[{]/.test(\"x\")}`; matter(content);\n",
      "line comment ended by CR hides a derivation": good.replace("makeFrontmatterYamlEngine(jsYaml)", "makeFrontmatterYamlEngine(jsYaml // note\r.safeLoad(content) as unknown as FrontmatterYamlLib\n)"),
      "line comment ended by U+2028 hides a derivation": good.replace("makeFrontmatterYamlEngine(jsYaml)", "makeFrontmatterYamlEngine(jsYaml // note\u2028.safeLoad(content) as unknown as FrontmatterYamlLib\n)"),
      "line comment ended by U+2029 hides a derivation": good.replace("makeFrontmatterYamlEngine(jsYaml)", "makeFrontmatterYamlEngine(jsYaml // note\u2029.safeLoad(content) as unknown as FrontmatterYamlLib\n)"),
      "a regex literal that looks like a comment opener hides nothing": good + "const r = /\\/*/; matter(content); const q = /x*\\//;\n",
      "unparseable source": good + "const = ;\n",
      "second file binds gray-matter": good,
    };
    for (const [name, src] of Object.entries(bad)) {
      const files: Record<string, string> = name === "second file binds gray-matter" ? { "src/indexer.ts": src, "src/other.ts": 'import m from "gray-matter";\n' } : { "src/indexer.ts": src };
      expect({ name, violations: sourceGuard(files).length > 0 }).toEqual({ name, violations: true });
    }
    expect(sourceGuard({ "src/indexer.ts": good, "src/store.ts": "// gray-matter coerces values — a comment only\n" })).toEqual([]);
    expect(sourceGuard({ "src/indexer.ts": good, "src/other.ts": 'const note = "see gray-matter docs"; /* js-yaml */\n' })).toEqual([]);   // names, never bindings
    expect(sourceGuard({ "src/indexer.ts": good + "const s = `a ${x} b ${`c ${y}`}`;\n" })).toEqual([]);                             // benign template expressions, nested
    expect(sourceGuard({ "src/indexer.ts": good + "const q = `${\"}\"}${'{'} ${`${\"}\"}`}`;\n" })).toEqual([]);                        // quoted braces never end the expression early
    expect(sourceGuard({ "src/indexer.ts": good.replace("makeFrontmatterYamlEngine(jsYaml)", "makeFrontmatterYamlEngine(jsYaml as unknown as FrontmatterYamlLib)") })).toEqual([]);   // the real tree's type-only cast
    expect(sourceGuard({ "src/indexer.ts": good + "const r = /[{}]`'\"/g; const t = `${r.test('{')}`;\n" })).toEqual([]);                  // regex braces and quotes are not code
    expect(sourceGuard({ "src/indexer.ts": good + "/** gray-matter in JSDoc */ const j = 1; // js-yaml here\r const k = 2;\n" })).toEqual([]);   // comments of every kind are trivia
  });
});
