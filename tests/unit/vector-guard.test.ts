import { describe, it, expect } from "bun:test";
import {
  storableVector, storedVector, assertStorableTyped, usableDistance, usableSelfDistance, cosineSimilarityStrict,
  VecPoisonError, EmbedEnvelopeError, FatalVectorError, isRefusedEmbedResponse,
} from "../../src/vector-guard.ts";
import * as storeModule from "../../src/store.ts";

/** BACKLOG 82.2, D1 / D4: the validator alone. The response-boundary tests are in `embed-response-boundary.test.ts`. */

const ctx = { context: "probe" };
const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof VecPoisonError) return e.reason; throw e; }
  return "accepted";
};
const blob = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);

describe("storableVector — an endpoint vector is judged RAW", () => {
  it("accepts a healthy vector and returns it converted", () => {
    const out = storableVector([0.6, 0.8], ctx);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    const typed = new Float32Array([1, 0]);
    expect(storableVector(typed, ctx)).toBe(typed);   // a validated typed array is passed on, not copied
  });

  it("refuses every element that is not a number BEFORE conversion — alone or mixed with good elements", () => {
    expect(reasonOf(() => storableVector([null, null], ctx))).toBe("non-number");       // would convert to zeros
    expect(reasonOf(() => storableVector([null, 1], ctx))).toBe("non-number");          // would convert to [0, 1]
    expect(reasonOf(() => storableVector(["0.5", 1], ctx))).toBe("non-number");         // a numeric string
    expect(reasonOf(() => storableVector([true, 1], ctx))).toBe("non-number");          // a boolean
    expect(reasonOf(() => storableVector([1, undefined], ctx))).toBe("non-number");
  });

  it("refuses a non-finite number, a float32 overflow and a norm outside [1e-6, 1e6]", () => {
    expect(reasonOf(() => storableVector(JSON.parse("[1e400, 1]"), ctx))).toBe("non-finite");   // JSON 1e400 is Infinity
    expect(reasonOf(() => storableVector([NaN, 1], ctx))).toBe("non-finite");
    expect(reasonOf(() => storableVector([1e300, 0], ctx))).toBe("float32-overflow");           // finite as a double
    expect(reasonOf(() => storableVector([0, 0, 0], ctx))).toBe("norm");                        // all-zero
    expect(reasonOf(() => storableVector([1e38, 0], ctx))).toBe("norm");                        // sqlite-vec cannot compute it
    expect(reasonOf(() => storableVector([1e-40, 0], ctx))).toBe("norm");                       // subnormal
  });

  it("refuses what is not an array, and an empty one", () => {
    expect(reasonOf(() => storableVector("[1,0]", ctx))).toBe("not-an-array");
    expect(reasonOf(() => storableVector({ 0: 1, length: 1 }, ctx))).toBe("not-an-array");
    expect(reasonOf(() => storableVector(undefined, ctx))).toBe("not-an-array");
    expect(reasonOf(() => storableVector([], ctx))).toBe("empty");
  });

  it("the error is fatal, typed, and carries its context", () => {
    try { storableVector([1, null], { context: "abc123_2", index: 3 }); throw new Error("accepted"); }
    catch (e) {
      expect(e).toBeInstanceOf(VecPoisonError);
      expect(e).toBeInstanceOf(FatalVectorError);
      const p = e as VecPoisonError;
      expect([p.reason, p.source, p.context, p.index, p.elementIndex]).toEqual(["non-number", "endpoint", "abc123_2", 3, 1]);
      expect(isRefusedEmbedResponse(e)).toBe(true);
    }
    expect(isRefusedEmbedResponse(new EmbedEnvelopeError("no data array", ctx))).toBe(true);
    expect(isRefusedEmbedResponse(new FatalVectorError("x"))).toBe(false);
  });

  it("store.ts exports the same classes beside its other fatal vector errors", () => {
    expect(storeModule.FatalVectorError).toBe(FatalVectorError);
    expect((storeModule as Record<string, unknown>).VecPoisonError).toBe(VecPoisonError);
    expect((storeModule as Record<string, unknown>).EmbedEnvelopeError).toBe(EmbedEnvelopeError);
    expect(new storeModule.VecDimensionMismatchError(2, 3)).toBeInstanceOf(FatalVectorError);
  });
});

describe("assertStorableTyped — the backstop on what a writer stores", () => {
  it("passes a healthy typed array and refuses poison", () => {
    expect(() => assertStorableTyped(new Float32Array([1, 0]), ctx)).not.toThrow();
    expect(reasonOf(() => assertStorableTyped(new Float32Array([0, 0]), ctx))).toBe("norm");
    expect(reasonOf(() => assertStorableTyped(new Float32Array([Infinity, 0]), ctx))).toBe("float32-overflow");
    expect(reasonOf(() => assertStorableTyped(new Float32Array([NaN, 1]), ctx))).toBe("float32-overflow");
    expect(reasonOf(() => assertStorableTyped([1, 0], ctx))).toBe("not-an-array");
  });
});

describe("storedVector — a vector read from the database", () => {
  it("decodes the blob Bun returns (a Uint8Array) instead of reading its bytes as floats", () => {
    const out = storedVector(blob([0.25, -0.5]), 2, ctx);
    expect(Array.from(out)).toEqual([0.25, -0.5]);
    // A blob at an odd offset inside a larger buffer decodes the same.
    const big = new Uint8Array(9); big.set(blob([0.25, -0.5]), 1);
    expect(Array.from(storedVector(big.subarray(1), 2, ctx))).toEqual([0.25, -0.5]);
  });

  it("refuses a wrong length, a non-finite element, and a norm outside the interval", () => {
    expect(reasonOf(() => storedVector(new Uint8Array(7), undefined, ctx))).toBe("blob-length");
    expect(reasonOf(() => storedVector(blob([1, 0, 0]), 2, ctx))).toBe("blob-length");
    expect(reasonOf(() => storedVector(new Uint8Array(0), undefined, ctx))).toBe("empty");
    expect(reasonOf(() => storedVector(blob([Infinity, 0]), 2, ctx))).toBe("non-finite");
    expect(reasonOf(() => storedVector(blob([NaN, 0]), 2, ctx))).toBe("non-finite");
    expect(reasonOf(() => storedVector(blob([1e38, 0]), 2, ctx))).toBe("norm");       // half of the -Infinity pair
    expect(reasonOf(() => storedVector(blob([1e-40, 0]), 2, ctx))).toBe("norm");      // the subnormal vector
    expect(reasonOf(() => storedVector(blob([0, 0]), 2, ctx))).toBe("norm");
    expect(reasonOf(() => storedVector(new Float32Array([1, 0]), 2, ctx))).toBe("not-an-array");  // typed, not decoded
    try { storedVector(blob([0, 0]), 2, ctx); } catch (e) { expect((e as VecPoisonError).source).toBe("stored"); }
  });
});

describe("usableDistance — one predicate for every returned distance", () => {
  it("accepts [0, 2], clamps inside the tolerance, and refuses everything else", () => {
    expect(usableDistance(0)).toBe(0);
    expect(usableDistance(1.7071)).toBe(1.7071);
    expect(usableDistance(2)).toBe(2);
    expect(usableDistance(-2.048e-9)).toBe(0);            // two healthy collinear vectors
    expect(usableDistance(2 + 5e-5)).toBe(2);
    expect(usableDistance(-0.1547)).toBeNull();           // the subnormal vector's finite negative distance
    expect(usableDistance(2.01)).toBeNull();
    expect(usableDistance(null)).toBeNull();
    expect(usableDistance(undefined)).toBeNull();
    expect(usableDistance(NaN)).toBeNull();
    expect(usableDistance(-Infinity)).toBeNull();
    expect(usableDistance(Infinity)).toBeNull();
    expect(usableDistance("0.5")).toBeNull();
  });

  it("a self-distance is usable only within 1e-4 of zero", () => {
    expect(usableSelfDistance(0)).toBe(true);
    expect(usableSelfDistance(-5e-5)).toBe(true);
    expect(usableSelfDistance(2e-4)).toBe(false);
    expect(usableSelfDistance(null)).toBe(false);
    expect(usableSelfDistance(NaN)).toBe(false);
  });
});

describe("cosineSimilarityStrict", () => {
  it("throws on a length difference instead of reading the shorter length", () => {
    expect(cosineSimilarityStrict([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarityStrict(new Float32Array([1, 0]), new Float32Array([-1, 1]))).toBeCloseTo(-0.7071, 4);
    expect(() => cosineSimilarityStrict([1, 0], [1, 0, 0])).toThrow();
  });
});
