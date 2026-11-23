/**
 * BACKLOG 82.2 D4, Codex T1 P2 — the raw vector scan (`searchVecMatch`) keeps its fault count across refill rounds.
 *
 * A scan that met a fault refills deeper (ruling 18 A). The rows a later round returns can differ from the first round's
 * (a concurrent `repair vectors` can remove the faulty row between the two statements), so a later round can see no
 * fault at all. The design requires the count to be STICKY: the result reports the faults met in any round and the
 * first one met, as the detailed path already does. The MATCH replies here are scripted, round by round, so the rounds
 * really differ — a vault that returns the bad row every round cannot show stickiness.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, searchVecMatch } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

const MODEL = "m1";
afterEach(() => setDefaultLlamaCpp(null));

/** The store's handle, with the MATCH statement answered from `rounds` (one reply per call; the last repeats). */
function scripted(rounds: { hash_seq: string; distance: unknown }[][]) {
  const store = createStore(":memory:");
  store.ensureVecTable(2);
  store.insertEmbedding("h", 0, 0, new Float32Array([1, 0]), MODEL, new Date().toISOString());
  let call = 0;
  const asked: number[] = [];
  const db = new Proxy(store.db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => /embedding MATCH/.test(sql)
          ? { all: (_v: unknown, k: number) => { asked.push(k); return rounds[Math.min(call++, rounds.length - 1)]!; } }
          : target.prepare(sql);
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  setDefaultLlamaCpp({ embed: async () => ({ embedding: new Float32Array([1, 0]), model: MODEL }) } as never);
  return { db: db as typeof store.db, asked };
}

describe("P2: searchVecMatch's fault count is sticky across refill rounds", () => {
  it("a fault in round 1 and none in round 2: the result still reports 1 fault and the first one", async () => {
    const { db, asked } = scripted([
      [{ hash_seq: "bad_0", distance: Number.NaN }, { hash_seq: "a_0", distance: 0.1 }, { hash_seq: "b_0", distance: 0.2 }],
      [{ hash_seq: "a_0", distance: 0.1 }, { hash_seq: "b_0", distance: 0.2 }, { hash_seq: "c_0", distance: 0.3 }],
    ]);
    const scan = await searchVecMatch(db, "q", MODEL, 1);
    expect(asked).toEqual([3, 9]);                                     // it did refill
    expect(scan.hits.map(h => h.hash_seq)).toEqual(["a_0", "b_0", "c_0"]);
    expect(scan.vectorFaults).toBe(1);
    expect(scan.firstFault).toBe("bad_0");
  });

  it("faults in two rounds: the larger count is kept, and the FIRST fault met", async () => {
    const { db } = scripted([
      [{ hash_seq: "bad1_0", distance: Number.NaN }, { hash_seq: "bad2_0", distance: -Infinity }, { hash_seq: "a_0", distance: 0.1 }],
      [{ hash_seq: "bad3_0", distance: Number.NaN }, { hash_seq: "a_0", distance: 0.1 }, { hash_seq: "b_0", distance: 0.2 }, { hash_seq: "c_0", distance: 0.3 }],
    ]);
    const scan = await searchVecMatch(db, "q", MODEL, 1);
    expect(scan.vectorFaults).toBe(2);
    expect(scan.firstFault).toBe("bad1_0");
  });

  it("control: no fault in any round — one round, no fault reported", async () => {
    const { db, asked } = scripted([[{ hash_seq: "a_0", distance: 0.1 }, { hash_seq: "b_0", distance: 0.2 }, { hash_seq: "c_0", distance: 0.3 }]]);
    const scan = await searchVecMatch(db, "q", MODEL, 1);
    expect(asked).toEqual([3]);
    expect(scan.vectorFaults).toBe(0);
    expect(scan.firstFault).toBeUndefined();
  });
});
