/**
 * BACKLOG 82.2, D5 — the health of a STORED vector, and the doctor's scan of them.
 *  - Health = the strict reader accepts the blob (finite elements, the norm interval) AND the native self-distance
 *    is usable and at most 1e-4 from zero. The kinds are reported apart.
 *  - The scan is bounded on a cursor that exists: keys come from `content_vectors` by keyset on its primary key, each
 *    key is examined by a point lookup in `vectors_vec`. A sampled run says "among N examined of M".
 *  - `full` examines every key and then finds vector rows that have no `content_vectors` row (orphans).
 *  - One view: everything one scan reads belongs to one state of the database.
 */
import { describe, it, expect } from "bun:test";
import { createStore } from "../../src/store.ts";
import {
  classifyStoredVector, examineStoredVector, scanVectorHealth, describeVectorScan,
  VECTOR_KEY_PAGE_SQL, VECTOR_POINT_SQL,
} from "../../src/vector-health.ts";
import { BAD, HEALTHY, addDocument, fileVault, keyOf, hashOf, memoryVault, setVector, now } from "../helpers/vector-health-vault.ts";

const blob = (v: readonly number[]) => new Uint8Array(new Float32Array(v).buffer);

describe("the health of one stored vector", () => {
  it("a vector the embed path would store is healthy", () => {
    expect(classifyStoredVector(blob(HEALTHY), 0, 2)).toBeNull();
    expect(classifyStoredVector(blob([3e5, 4e5]), 0, 2)).toBeNull();          // norm 5e5: inside the interval
    expect(classifyStoredVector(blob(HEALTHY), -2.048e-9, 2)).toBeNull();     // inside the tolerance
  });

  it("the strict reader's refusals are reported by kind", () => {
    expect(classifyStoredVector(blob(BAD.nan), null, 2)).toBe("non-finite");
    expect(classifyStoredVector(blob(BAD.infinite), null, 2)).toBe("non-finite");
    expect(classifyStoredVector(blob(BAD.zero), null, 2)).toBe("unsupported-norm");
    expect(classifyStoredVector(blob(BAD.subnormal), 0, 2)).toBe("unsupported-norm");   // its self-distance can read 0
    expect(classifyStoredVector(blob(BAD.huge), 0, 2)).toBe("unsupported-norm");
  });

  it("a blob that is not a vector of the table's dimension is its own kind", () => {
    expect(classifyStoredVector(new Uint8Array(3), 0, 2)).toBe("malformed-blob");
    expect(classifyStoredVector(new Uint8Array(0), 0, 2)).toBe("malformed-blob");
    expect(classifyStoredVector(blob([1, 0, 0]), 0, 2)).toBe("malformed-blob");
    expect(classifyStoredVector("text" as never, 0, 2)).toBe("malformed-blob");
  });

  it("a vector the reader accepts and sqlite-vec cannot compute is `native-uncomputable`", () => {
    for (const self of [null, NaN, -Infinity, Infinity, 0.5, -0.001, "0", undefined]) {
      expect(classifyStoredVector(blob(HEALTHY), self, 2)).toBe("native-uncomputable");
    }
  });

  it("is read by a point lookup: healthy, each bad kind, and a key with no vector row", () => {
    const { store } = memoryVault({ good: [HEALTHY], zero: [BAD.zero], nan: [BAD.nan] });
    expect(examineStoredVector(store.db, keyOf("good"), 2)).toEqual({ state: "healthy" });
    expect(examineStoredVector(store.db, keyOf("zero"), 2)).toEqual({ state: "bad", kind: "unsupported-norm" });
    expect(examineStoredVector(store.db, keyOf("nan"), 2)).toEqual({ state: "bad", kind: "non-finite" });
    expect(examineStoredVector(store.db, "no-such-hash_0", 2)).toEqual({ state: "absent" });
  });
});

describe("the scan", () => {
  it("runs on a healthy vault of the real schema and finds nothing", () => {
    const { store } = memoryVault({ a: [HEALTHY], b: [HEALTHY, HEALTHY], c: [[1, 0]] });
    const report = scanVectorHealth(store.db, { full: true });
    expect(report).toMatchObject({ table: true, full: true, metadataRows: 4, vectorRows: 4, examined: 4, bad: 0, missing: 0, orphans: 0 });
    expect(report.findings).toEqual([]);
    expect(describeVectorScan(report)).toEqual({ ok: true, lines: ["0 bad among 4 examined of 4"] });
  });

  it("counts each kind apart and names the keys", () => {
    const { store } = memoryVault({
      good: [HEALTHY], zero: [BAD.zero], sub: [BAD.subnormal], nan: [BAD.nan], inf: [BAD.infinite],
      mixed: [HEALTHY, BAD.huge],
    });
    const report = scanVectorHealth(store.db, { full: true });
    expect(report.examined).toBe(7);
    expect(report.bad).toBe(5);
    expect(report.byKind).toEqual({ "non-finite": 2, "unsupported-norm": 3, "native-uncomputable": 0, "malformed-blob": 0 });
    expect(report.findings.map(f => f.hashSeq).sort()).toEqual(
      [keyOf("zero"), keyOf("sub"), keyOf("nan"), keyOf("inf"), keyOf("mixed", 1)].sort());
    expect(report.findings.every(f => f.orphan === false)).toBe(true);
    const said = describeVectorScan(report);
    expect(said.ok).toBe(false);
    expect(said.lines[0]).toBe("5 bad among 7 examined of 7 — non-finite 2, unsupported-norm 3");
    expect(said.lines.join("\n")).toContain("clawmem repair vectors");
  });

  it("a sampled run examines at most its bound and says so — never a statement about the whole vault", () => {
    const docs: Record<string, number[][]> = {};
    for (let i = 0; i < 7; i++) docs[`d${i}`] = [HEALTHY];
    const { store } = memoryVault(docs);
    const report = scanVectorHealth(store.db, { sample: 3 });
    expect(report).toMatchObject({ full: false, examined: 3, metadataRows: 7, vectorRows: 7, bad: 0, orphans: null });
    const said = describeVectorScan(report);
    expect(said.lines[0]).toBe("0 bad among 3 examined of 7");
    expect(said.lines.join("\n")).toContain("--full");
    // the default bound
    expect(scanVectorHealth(store.db).examined).toBe(7);
    expect(scanVectorHealth(store.db).full).toBe(false);
  });

  it("a sampled run reports the two row counts and says when they differ", () => {
    const { store } = memoryVault({ a: [HEALTHY], b: [HEALTHY] });
    setVector(store, "stray-hash_0", HEALTHY);                               // a vector row with no metadata row
    const report = scanVectorHealth(store.db, { sample: 10 });
    expect(report).toMatchObject({ metadataRows: 2, vectorRows: 3, orphans: null });
    expect(describeVectorScan(report).lines.join("\n")).toContain("2 metadata rows, 3 vector rows");
  });

  it("`full` finds a vector row that has no metadata row, and examines it the same way", () => {
    const { store } = memoryVault({ a: [HEALTHY] });
    setVector(store, "stray-good_0", HEALTHY);
    setVector(store, "stray-bad_3", BAD.zero);
    const report = scanVectorHealth(store.db, { full: true });
    expect(report.orphans).toBe(2);
    expect(report.examined).toBe(3);                                         // one key and two orphans
    expect(report.findings).toEqual([{ hashSeq: "stray-bad_3", kind: "unsupported-norm", orphan: true }]);
    expect(describeVectorScan(report).lines.join("\n")).toContain("2 orphan");
  });

  it("a metadata row whose vector row is gone is counted as missing, not as bad", () => {
    const { store } = memoryVault({ a: [HEALTHY], b: [HEALTHY] });
    store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(keyOf("b"));
    const report = scanVectorHealth(store.db, { full: true });
    expect(report).toMatchObject({ examined: 2, bad: 0, missing: 1 });
  });

  it("a vault with no vector table has nothing to examine", () => {
    const store = createStore(":memory:");
    const report = scanVectorHealth(store.db, { full: true });
    expect(report).toMatchObject({ table: false, examined: 0, bad: 0 });
    expect(describeVectorScan(report).ok).toBe(true);
  });

  it("pages by keyset: a page size of one examines every key once", () => {
    const { store } = memoryVault({ a: [HEALTHY, BAD.zero], b: [HEALTHY], c: [BAD.nan] });
    const pages: number[] = [];
    const report = scanVectorHealth(store.db, { full: true, pageSize: 1, betweenPages: page => { pages.push(page); } });
    expect(report.examined).toBe(4);
    expect(report.bad).toBe(2);
    expect(pages.length).toBeGreaterThanOrEqual(3);
  });

  it("the key page uses the primary-key index and the vector read is the point form", () => {
    const { store } = memoryVault({ a: [HEALTHY] });
    const plan = (sql: string, ...params: (string | number)[]) =>
      (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(r => r.detail).join(" | ");
    const keys = plan(VECTOR_KEY_PAGE_SQL, "", -1, 1000);
    expect(keys).toContain("SEARCH content_vectors USING COVERING INDEX sqlite_autoindex_content_vectors_1 ((hash,seq)>(?,?))");
    expect(keys).not.toContain("TEMP B-TREE");
    expect(VECTOR_KEY_PAGE_SQL).not.toMatch(/OFFSET/i);
    const point = plan(VECTOR_POINT_SQL, keyOf("a"));
    const whole = plan(`SELECT hash_seq FROM vectors_vec`);
    expect(point).toMatch(/vectors_vec VIRTUAL TABLE INDEX 3:/);             // sqlite-vec's point query
    expect(whole).toMatch(/vectors_vec VIRTUAL TABLE INDEX 0:/);             // its full scan, for contrast
  });

  it("an error of the schema is thrown — it is never a finding", () => {
    const store = createStore(":memory:");
    store.db.exec(`CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, other TEXT)`);
    expect(() => scanVectorHealth(store.db, { full: true })).toThrow();
  });
});

describe("one view", () => {
  it("a vector inserted behind the cursor, one replaced and one deleted ahead of it, between two pages, change nothing in the report", () => {
    const docs: Record<string, number[][]> = {};
    for (let i = 0; i < 6; i++) docs[`doc${i}`] = [HEALTHY];
    const vault = fileVault(docs);
    try {
      const reader = createStore(vault.path, { readonly: true });
      const before = scanVectorHealth(reader.db, { full: true, pageSize: 2 });
      expect(before).toMatchObject({ examined: 6, bad: 0, metadataRows: 6, vectorRows: 6, orphans: 0 });

      const keys = (vault.store.db.prepare(`SELECT hash FROM content_vectors ORDER BY hash`).all() as { hash: string }[]).map(r => r.hash);
      let changed = false;
      const during = scanVectorHealth(reader.db, {
        full: true, pageSize: 2,
        betweenPages: page => {
          if (page !== 1 || changed) return;
          changed = true;
          // behind the cursor: a key that sorts before every existing one, with a bad vector
          vault.store.db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES ('0000', 0, 0, 'm1', ?)`).run(now());
          setVector(vault.store, "0000_0", BAD.zero);
          // ahead of the cursor: one replaced by a bad vector, one deleted; and an orphan for the last pass
          setVector(vault.store, `${keys[4]}_0`, BAD.nan);
          vault.store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${keys[5]}_0`);
          vault.store.db.prepare(`DELETE FROM content_vectors WHERE hash = ?`).run(keys[5]!);
          setVector(vault.store, "zzzz-stray_0", BAD.zero);
        },
      });
      expect(changed).toBe(true);
      expect(during).toEqual(before);

      // and the changes are real: the next scan sees them
      const after = scanVectorHealth(reader.db, { full: true, pageSize: 2 });
      expect(after).toMatchObject({ metadataRows: 6, vectorRows: 7, bad: 3, orphans: 1 });
      reader.close();
    } finally { vault.done(); }
  });

  it("the helper vault is what it says", () => {
    const { store } = memoryVault();
    const id = addDocument(store, "x", [HEALTHY]);
    expect(id).toBeGreaterThan(0);
    expect(keyOf("x")).toBe(`${hashOf("x")}_0`);
  });
});
