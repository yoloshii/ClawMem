/**
 * BACKLOG 82.3, D7 — the hash contract: a stored body is normalised FIRST and hashed SECOND, so the hash of a row is
 * the hash of what is stored.
 *
 * - `normalizedContent(text)` is the one producer of a body hash: it removes every leading U+FEFF / U+FFFE, then
 *   hashes what is left.
 * - `insertContent` normalises nothing. It ASSERTS: the body has no leading mark, and the hash it was given is the
 *   hash of that body. Otherwise it throws `ContentContractError` and stores nothing.
 * - `parseDocument` normalises the body in both of its branches and the frontmatter scalars, and says whether IT
 *   removed a mark (`leadingMarkRemoved`).
 * - The indexer and `saveMemory` store the normalised text under its own hash. The raw-file `content_hash` keeps
 *   hashing the file as it was read: its question is "did the file change".
 *
 * No mark is typed into this file: each is built with `String.fromCharCode`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { ContentContractError, createStore, insertContent, type Store } from "../../src/store.ts";
import { extractTitle, indexCollection, parseDocument } from "../../src/indexer.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { normalizedContent } from "../../src/text-policy.ts";

const FEFF = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const MARKS: [string, string][] = [["U+FEFF", FEFF], ["U+FFFE", FFFE]];

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");
const hexOf = (text: string): string => Buffer.from(text, "utf-8").toString("hex").toUpperCase();

const ROOT = "/tmp/clawmem-hash-contract-test";
const CONTENT = `${ROOT}/content`;
const NOW = "2026-11-22T00:00:00.000Z";

/** Enrichment is unavailable: the indexer and `saveMemory` need no model for what is asserted here. */
const deadLlm = {
  embed: async () => { throw new Error("no embedding endpoint in test"); },
  query: async () => null,
  expandQuery: async () => [],
} as any;

let store: Store;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(CONTENT, { recursive: true });
  setDefaultLlamaCpp(deadLlm);
  store = createStore(`${ROOT}/vault.sqlite`);
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  setDefaultLlamaCpp(null);
  rmSync(ROOT, { recursive: true, force: true });
});

/** The stored body of a hash, as text and as the hex of its bytes. */
const storedBody = (hash: string) =>
  store.db.prepare(`SELECT doc, hex(CAST(doc AS BLOB)) AS bytes FROM content WHERE hash = ?`).get(hash) as
    { doc: string; bytes: string } | null;
const contentRows = (): number =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM content`).get() as { n: number }).n;

describe("normalizedContent — normalise, then hash", () => {
  test("a body without a mark is returned as it is, with its hash", () => {
    const out = normalizedContent("# Title\n\nbody\n");
    expect(out).toEqual({ body: "# Title\n\nbody\n", hash: sha("# Title\n\nbody\n") });
  });

  test.each(MARKS)("a body led by %s loses the mark, and the hash is the hash of what is left", (_name, mark) => {
    const out = normalizedContent(mark + "body text");
    expect(out.body).toBe("body text");
    expect(out.hash).toBe(sha("body text"));
    expect(out.hash).not.toBe(sha(mark + "body text"));
  });

  test("every mark of a mixed prefix is removed; a mark inside the text stays", () => {
    const inside = "a" + FEFF + "b" + FFFE;
    expect(normalizedContent(FEFF + FFFE + FEFF + inside)).toEqual({ body: inside, hash: sha(inside) });
    expect(normalizedContent(inside)).toEqual({ body: inside, hash: sha(inside) });
    expect(normalizedContent(FFFE + FEFF)).toEqual({ body: "", hash: sha("") });
  });
});

describe("insertContent — it asserts, it does not normalise", () => {
  test("a sound body with its own hash is stored", () => {
    const body = "sound body";
    insertContent(store.db, sha(body), body, NOW);
    expect(storedBody(sha(body))).toEqual({ doc: body, bytes: hexOf(body) });
    insertContent(store.db, sha(body), body, NOW);                       // the same pair again: still one row
    expect(contentRows()).toBe(1);
  });

  test.each(MARKS)("a body led by %s is refused, with its own hash and with the hash of the rest", (_name, mark) => {
    const marked = mark + "body";
    for (const hash of [sha(marked), sha("body")]) {
      let thrown: unknown;
      try { insertContent(store.db, hash, marked, NOW); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(ContentContractError);
      expect((thrown as ContentContractError).reason).toBe("leading-mark");
    }
    expect(contentRows()).toBe(0);
  });

  test("a hash that is not the hash of the body is refused", () => {
    let thrown: unknown;
    try { insertContent(store.db, sha("another body"), "this body", NOW); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ContentContractError);
    expect((thrown as ContentContractError).reason).toBe("hash-mismatch");
    expect(contentRows()).toBe(0);
  });

  test("the store's own method asserts the same, and the error carries no part of the body", () => {
    const secret = "a private sentence of the body";
    let thrown: unknown;
    try { store.insertContent(sha("x"), secret, NOW); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ContentContractError);
    expect((thrown as Error).message).not.toContain("private");
    expect(() => store.insertContent(sha(FFFE + secret), FFFE + secret, NOW)).toThrow(ContentContractError);
    expect(contentRows()).toBe(0);
  });
});

describe("parseDocument — both branches give a normalised body", () => {
  test.each(MARKS)("no frontmatter, a body led by %s after the file's own mark", (_name, mark) => {
    const out = parseDocument(FEFF + mark + "plain body\n", "a.md");       // gray-matter removes the FILE's first U+FEFF
    expect(out.body).toBe("plain body\n");
    expect(out.leadingMarkRemoved).toBe(true);
  });

  test("no frontmatter, a file led by U+FFFE (no reader removes that one)", () => {
    const out = parseDocument(FFFE + "plain body\n", "a.md");
    expect(out.body).toBe("plain body\n");
    expect(out.leadingMarkRemoved).toBe(true);
  });

  test.each(MARKS)("frontmatter, then a body led by %s", (_name, mark) => {
    const out = parseDocument(`---\ntitle: Kept\n---\n${mark}# Head\n\nbody\n`, "a.md");
    expect(out.body).toBe("# Head\n\nbody\n");
    expect(out.leadingMarkRemoved).toBe(true);
    expect(out.meta.title).toBe("Kept");
  });

  test("a mixed prefix is removed whole", () => {
    const out = parseDocument(`---\ntitle: Kept\n---\n${FEFF}${FFFE}${FEFF}text`, "a.md");
    expect(out.body).toBe("text");
    expect(out.leadingMarkRemoved).toBe(true);
  });

  test("the branch for frontmatter that is not accepted: the whole file is the body, without its mark", () => {
    const file = "---js\nmodule.exports = {}\n---\nbody\n";                 // a language that is not accepted
    const out = parseDocument(FEFF + file, "a.md");
    expect(out.body).toBe(file);
    expect(out.leadingMarkRemoved).toBe(true);
    expect(parseDocument(file, "a.md")).toMatchObject({ body: file, leadingMarkRemoved: false });
  });

  test("nothing to remove: the signal is false", () => {
    expect(parseDocument("plain body\n", "a.md")).toMatchObject({ body: "plain body\n", leadingMarkRemoved: false });
    expect(parseDocument("---\ntitle: T\n---\nbody\n", "a.md")).toMatchObject({ body: "body\n", leadingMarkRemoved: false });
    const inside = "a" + FEFF + "b\n";
    expect(parseDocument(inside, "a.md")).toMatchObject({ body: inside, leadingMarkRemoved: false });
  });

  // QUESTION 41 (open with the operator, built as recommended): the mark at the very start of a FILE is removed by
  // the frontmatter reader, as it was before this release. That removal is not counted: the signal says what
  // `parseDocument` itself removed from the body.
  test("a file that starts with U+FEFF and has a sound body: the body is clean and the signal is false", () => {
    expect(parseDocument(FEFF + "plain body\n", "a.md")).toMatchObject({ body: "plain body\n", leadingMarkRemoved: false });
    expect(parseDocument(FEFF + "---\ntitle: T\n---\nbody\n", "a.md"))
      .toMatchObject({ body: "body\n", leadingMarkRemoved: false, meta: { title: "T" } });
  });

  test.each(MARKS)("frontmatter scalars led by %s are normalised", (_name, mark) => {
    const out = parseDocument([
      "---",
      `title: "${mark}Marked title"`,
      `domain: "${mark}${mark}infra"`,
      `workstream: "${mark}release"`,
      `content_type: "${mark}decision"`,
      `review_by: "${mark}2027-01-01"`,
      "---",
      "body",
    ].join("\n"), "notes/a.md");
    expect(out.meta.title).toBe("Marked title");
    expect(out.meta.domain).toBe("infra");
    expect(out.meta.workstream).toBe("release");
    expect(out.meta.content_type).toBe("decision");
    expect(out.meta.review_by).toBe("2027-01-01");
    expect(out.leadingMarkRemoved).toBe(false);                            // the BODY had no mark
  });

  test("a scalar that is only marks is read as absent", () => {
    const out = parseDocument(`---\ntitle: "${FEFF}${FFFE}"\ndomain: "${FFFE}"\n---\nbody`, "a.md");
    expect(out.meta.title).toBeUndefined();
    expect(out.meta.domain).toBeUndefined();
  });
});

describe("the indexer stores the normalised body under its own hash", () => {
  const rowOf = (path: string) =>
    store.db.prepare(`SELECT id, title, hash, content_hash, domain, active FROM documents WHERE collection = 'docs' AND path = ?`)
      .get(path) as { id: number; title: string; hash: string; content_hash: string; domain: string | null; active: number } | null;
  const index = () => indexCollection(store, "docs", CONTENT, "**/*.md");

  test("mark-led files, with and without frontmatter", async () => {
    const files: Record<string, { raw: string; body: string; title: string }> = {
      "swapped.md": { raw: FFFE + "# Swapped\n\nbody one\n", body: "# Swapped\n\nbody one\n", title: "Swapped" },
      "mixed.md": { raw: FEFF + FFFE + FEFF + "# Mixed\n\nbody two\n", body: "# Mixed\n\nbody two\n", title: "Mixed" },
      "front.md": {
        raw: `---\ntitle: "${FFFE}Marked title"\ndomain: "${FEFF}infra"\n---\n${FEFF}# Head\n\nbody three\n`,
        body: "# Head\n\nbody three\n", title: "Marked title",
      },
      "plain.md": { raw: "# Plain\n\nbody four\n", body: "# Plain\n\nbody four\n", title: "Plain" },
    };
    for (const [name, f] of Object.entries(files)) writeFileSync(`${CONTENT}/${name}`, f.raw);
    await index();

    for (const [name, f] of Object.entries(files)) {
      const row = rowOf(name);
      expect(row, name).not.toBeNull();
      expect(row!.active).toBe(1);
      expect(row!.hash, name).toBe(sha(f.body));                           // the hash of what is stored
      expect(storedBody(row!.hash), name).toEqual({ doc: f.body, bytes: hexOf(f.body) });
      expect(row!.title, name).toBe(f.title);
      expect(row!.content_hash, name).toBe(sha(f.raw));                    // the raw-file hash: the file as it was read
    }
    expect(rowOf("front.md")!.domain).toBe("infra");
  });

  test("an unchanged mark-led file is not written again by a second pass", async () => {
    writeFileSync(`${CONTENT}/swapped.md`, FFFE + "# Swapped\n\nbody\n");
    await index();
    const first = rowOf("swapped.md")!;
    const second = await index();
    expect(second.unchanged).toBe(1);
    expect(second.added + second.updated).toBe(0);
    expect(rowOf("swapped.md")).toEqual(first);
    expect(contentRows()).toBe(1);
  });

  test("the file's body changes behind the same mark: the new body is stored normalised", async () => {
    writeFileSync(`${CONTENT}/swapped.md`, FFFE + "# Swapped\n\nfirst\n");
    await index();
    writeFileSync(`${CONTENT}/swapped.md`, FFFE + "# Swapped\n\nsecond\n");
    await index();
    const row = rowOf("swapped.md")!;
    expect(row.hash).toBe(sha("# Swapped\n\nsecond\n"));
    expect(storedBody(row.hash)!.doc).toBe("# Swapped\n\nsecond\n");
  });
});

describe("saveMemory stores the normalised body and title", () => {
  const docOf = (path: string) =>
    store.db.prepare(`SELECT id, title, hash, normalized_hash, duplicate_count FROM documents WHERE collection = '_clawmem' AND path = ?`)
      .get(path) as { id: number; title: string; hash: string; normalized_hash: string; duplicate_count: number } | null;

  test.each(MARKS)("a body and a title led by %s", (_name, mark) => {
    const body = "A decision that was taken, with its reason.";
    const res = store.saveMemory({ collection: "_clawmem", path: "decisions/one.md", title: mark + "The title", body: mark + body, contentType: "decision" });
    expect(res.action).toBe("inserted");
    const row = docOf("decisions/one.md")!;
    expect(row.hash).toBe(sha(body));
    expect(storedBody(row.hash)).toEqual({ doc: body, bytes: hexOf(body) });
    expect(row.title).toBe("The title");
  });

  test.each(MARKS)("the dedup key is built from the normalised text: %s does not make a second memory", (_name, mark) => {
    const body = "The same statement, said twice within the window.";
    const first = store.saveMemory({ collection: "_clawmem", path: "decisions/a.md", title: "t", body, contentType: "decision" });
    const again = store.saveMemory({ collection: "_clawmem", path: "decisions/b.md", title: "t", body: mark + body, contentType: "decision" });
    expect(first.action).toBe("inserted");
    expect(again).toMatchObject({ action: "deduplicated", docId: first.docId });
    expect(docOf("decisions/b.md")).toBeNull();
    expect(docOf("decisions/a.md")!.duplicate_count).toBe(2);
  });

  test.each(MARKS)("a semantic payload led by %s gives the key of the payload without it", (_name, mark) => {
    const first = store.saveMemory({ collection: "_clawmem", path: "decisions/a.md", title: "t", body: "body one", contentType: "decision", semanticPayload: "the payload" });
    const again = store.saveMemory({ collection: "_clawmem", path: "decisions/b.md", title: "t", body: "body two", contentType: "decision", semanticPayload: mark + "the payload" });
    expect(again).toMatchObject({ action: "deduplicated", docId: first.docId });
  });

  test("a path conflict update stores the normalised body too", () => {
    store.saveMemory({ collection: "_clawmem", path: "decisions/one.md", title: "t", body: "first text of the memory", contentType: "decision" });
    const res = store.saveMemory({ collection: "_clawmem", path: "decisions/one.md", title: FEFF + "t2", body: FFFE + "a wholly different second text", contentType: "decision" });
    expect(res.action).toBe("updated");
    const row = docOf("decisions/one.md")!;
    expect(row.hash).toBe(sha("a wholly different second text"));
    expect(storedBody(row.hash)!.doc).toBe("a wholly different second text");
    expect(row.title).toBe("t2");
  });
});

describe("a title is a normalised field at every writer", () => {
  const titleOf = (path: string): string =>
    (store.db.prepare(`SELECT title FROM documents WHERE collection = 'docs' AND path = ?`).get(path) as { title: string }).title;
  const seed = (path: string, title: string): number => {
    const { body, hash } = normalizedContent(`body of ${path}`);
    store.insertContent(hash, body, NOW);
    store.insertDocument("docs", path, title, hash, NOW, NOW);
    return (store.db.prepare(`SELECT id FROM documents WHERE collection = 'docs' AND path = ?`).get(path) as { id: number }).id;
  };

  test.each(MARKS)("a title derived from a heading or from the file name, led by %s", (_name, mark) => {
    expect(extractTitle(`# ${mark}Heading title\n\nbody\n`, "a.md")).toBe("Heading title");
    expect(extractTitle(`## ${mark}${mark}Second level\n`, "a.md")).toBe("Second level");
    expect(extractTitle("no heading here\n", `sub/${mark}named.md`)).toBe("named");
    expect(extractTitle("# Plain\n", "a.md")).toBe("Plain");
  });

  test.each(MARKS)("insertDocument, updateDocument, updateDocumentTitle and reactivateDocument given a title led by %s", (_name, mark) => {
    const id = seed("one.md", mark + "Inserted");
    expect(titleOf("one.md")).toBe("Inserted");

    const next = normalizedContent("a second body");
    store.insertContent(next.hash, next.body, NOW);
    store.updateDocument(id, mark + mark + "Updated", next.hash, NOW);
    expect(titleOf("one.md")).toBe("Updated");

    store.updateDocumentTitle(id, mark + "Renamed", NOW);
    expect(titleOf("one.md")).toBe("Renamed");

    store.db.prepare(`UPDATE documents SET active = 0, deactivated_reason = 'absent' WHERE id = ?`).run(id);
    expect(store.reactivateDocument(id, mark + "Back again", next.hash, NOW)).toBe(true);
    expect(titleOf("one.md")).toBe("Back again");
  });

  test.each(MARKS)("the indexer: a heading led by %s, and a file name led by it inside a folder", async (_name, mark) => {
    mkdirSync(`${CONTENT}/sub`, { recursive: true });
    writeFileSync(`${CONTENT}/heading.md`, `# ${mark}From the heading\n\nbody\n`);
    writeFileSync(`${CONTENT}/sub/${mark}named.md`, "a body without a heading\n");
    await indexCollection(store, "docs", CONTENT, "**/*.md");
    expect(titleOf("heading.md")).toBe("From the heading");
    expect(titleOf(`sub/${mark}named.md`)).toBe("named");                   // the PATH is stored as it is; only the title is normalised
  });
});

describe("one statement writes a body row", () => {
  /** Every `.ts` file under `src/`. */
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);

  test("the only INSERT or UPDATE of the `content` table under src/ is in content-insert.ts (the insert, and ruling 84 A's rewrite of a row stored with other bytes)", () => {
    const SRC = join(import.meta.dir, "../../src");
    const writes: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf-8");
      // `content` as a whole table name: not `content_vectors`, not a column list.
      for (const m of text.matchAll(/\b(?:INTO|UPDATE)\s+content\b(?!_)/gi)) writes.push(`${file.slice(SRC.length + 1)}: ${m[0]}`);
    }
    expect(writes).toEqual(["content-insert.ts: INTO content", "content-insert.ts: UPDATE content"]);
  });
});
