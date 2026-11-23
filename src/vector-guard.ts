/**
 * Vector guard (BACKLOG 82.2): the ONE place an embedding vector is judged.
 *
 *  - `storableVector`  — an endpoint's embedding AS RECEIVED (raw JSON), validated before any conversion.
 *  - `assertStorableTyped` — the backstop on a typed array a writer is about to store.
 *  - `storedVector`    — a vector READ from the database (a blob), decoded and validated.
 *  - `usableDistance`  — the one predicate for a distance returned by sqlite-vec.
 *
 * Why raw: `new Float32Array([null, 1])` is `[0, 1]` and JSON `1e400` parses to `Infinity`. A check made
 * after the conversion passes the first; a check made only before it passes a value that overflows float32.
 * So the element type and finiteness are checked BEFORE conversion, finiteness again AFTER it, and the float32
 * L2 norm must lie in [1e-6, 1e6] (the 81.2 worker's rules).
 *
 * This module imports nothing, so `llm.ts` and `store.ts` can both use it.
 */

/**
 * Fatal, non-recoverable vector-store errors. These abort the embed run rather than being swallowed as
 * per-fragment failures. (Defined here so `llm.ts` can throw its subclasses; re-exported by `store.ts`.)
 */
export class FatalVectorError extends Error {}

export const VECTOR_NORM_MIN = 1e-6;
export const VECTOR_NORM_MAX = 1e6;
/** Tolerance of `usableDistance` around the cosine-distance interval [0, 2]. */
export const DISTANCE_TOLERANCE = 1e-4;

export type VecPoisonReason = "not-an-array" | "empty" | "non-number" | "non-finite" | "float32-overflow" | "norm" | "blob-length";
export type VectorSource = "endpoint" | "stored";

/** Where a vector came from, for the error: a fragment `hash_seq`, a probe name, or `query`. */
export type VectorContext = { context: string; index?: number };

/** An embedding vector that must not be stored or searched with. */
export class VecPoisonError extends FatalVectorError {
  readonly reason: VecPoisonReason;
  /** The element that was refused, when one element was. */
  readonly elementIndex?: number;
  readonly norm?: number;
  readonly source: VectorSource;
  readonly context: string;
  /** The batch item the vector was, when it came in a batch. */
  readonly index?: number;
  constructor(reason: VecPoisonReason, source: VectorSource, ctx: VectorContext, detail: { elementIndex?: number; norm?: number; note?: string } = {}) {
    const where = source === "endpoint" ? "the embedding endpoint returned" : "the vault holds";
    const what =
      reason === "not-an-array" ? "a vector that is not an array of numbers"
      : reason === "empty" ? "an empty vector"
      : reason === "non-number" ? `a vector whose element ${detail.elementIndex} is not a number`
      : reason === "non-finite" ? `a vector whose element ${detail.elementIndex} is not finite`
      : reason === "float32-overflow" ? `a vector whose element ${detail.elementIndex} overflows float32`
      : reason === "blob-length" ? `a vector blob of the wrong length${detail.note ? ` (${detail.note})` : ""}`
      : `a vector whose L2 norm ${detail.norm} is outside [${VECTOR_NORM_MIN}, ${VECTOR_NORM_MAX}]`;
    const item = ctx.index !== undefined ? `, batch item ${ctx.index}` : "";
    super(`Malformed embedding vector: ${where} ${what} (${ctx.context}${item}). Nothing was stored from it.`);
    this.name = "VecPoisonError";
    this.reason = reason;
    this.elementIndex = detail.elementIndex;
    this.norm = detail.norm;
    this.source = source;
    this.context = ctx.context;
    this.index = ctx.index;
  }
}

/** A 2xx embedding reply that is not the expected shape. Handled wherever `VecPoisonError` is. */
export class EmbedEnvelopeError extends FatalVectorError {
  readonly reason: string;
  readonly index?: number;
  readonly context: string;
  constructor(reason: string, ctx: VectorContext) {
    const item = ctx.index !== undefined ? `, batch item ${ctx.index}` : "";
    super(`Malformed embedding response: ${reason} (${ctx.context}${item}). Nothing was stored from it.`);
    this.name = "EmbedEnvelopeError";
    this.reason = reason;
    this.index = ctx.index;
    this.context = ctx.context;
  }
}

/** True for the two classes that mean "the endpoint answered, and the answer must not be used". */
export function isRefusedEmbedResponse(e: unknown): e is VecPoisonError | EmbedEnvelopeError {
  return e instanceof VecPoisonError || e instanceof EmbedEnvelopeError;
}

function checkTyped(f32: Float32Array, source: VectorSource, ctx: VectorContext): void {
  if (f32.length === 0) throw new VecPoisonError("empty", source, ctx);
  let sq = 0;
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i]!;
    if (!Number.isFinite(v)) throw new VecPoisonError(source === "endpoint" ? "float32-overflow" : "non-finite", source, ctx, { elementIndex: i });
    sq += v * v;
  }
  const norm = Math.sqrt(sq);
  if (!Number.isFinite(norm) || norm < VECTOR_NORM_MIN || norm > VECTOR_NORM_MAX) {
    throw new VecPoisonError("norm", source, ctx, { norm });
  }
}

/**
 * Validate an endpoint's embedding AS RECEIVED and return it converted. A caller passes the returned array on and
 * never builds its own `Float32Array` from the response.
 */
export function storableVector(raw: unknown, ctx: VectorContext): Float32Array {
  if (!(Array.isArray(raw) || raw instanceof Float32Array)) throw new VecPoisonError("not-an-array", "endpoint", ctx);
  const arr = raw as ArrayLike<unknown>;
  if (arr.length === 0) throw new VecPoisonError("empty", "endpoint", ctx);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v !== "number") throw new VecPoisonError("non-number", "endpoint", ctx, { elementIndex: i });
    if (!Number.isFinite(v)) throw new VecPoisonError("non-finite", "endpoint", ctx, { elementIndex: i });
  }
  const f32 = raw instanceof Float32Array ? raw : new Float32Array(arr as ArrayLike<number>);
  checkTyped(f32, "endpoint", ctx);
  return f32;
}

/** The backstop on a typed array about to be stored: finite elements, the norm interval. */
export function assertStorableTyped(vec: unknown, ctx: VectorContext): asserts vec is Float32Array {
  if (!(vec instanceof Float32Array)) throw new VecPoisonError("not-an-array", "endpoint", ctx);
  checkTyped(vec, "endpoint", ctx);
}

/**
 * Decode and validate a vector READ from the database. Bun returns a blob column as `Uint8Array`; typing it as
 * `Float32Array` without decoding computes on bytes.
 */
export function storedVector(blob: unknown, expectedDim: number | undefined, ctx: VectorContext): Float32Array {
  if (!(blob instanceof Uint8Array)) throw new VecPoisonError("not-an-array", "stored", ctx);
  if (blob.byteLength === 0) throw new VecPoisonError("empty", "stored", ctx);
  if (blob.byteLength % 4 !== 0) throw new VecPoisonError("blob-length", "stored", ctx, { note: `${blob.byteLength} bytes` });
  if (expectedDim !== undefined && blob.byteLength !== 4 * expectedDim) {
    throw new VecPoisonError("blob-length", "stored", ctx, { note: `${blob.byteLength} bytes, expected ${4 * expectedDim}` });
  }
  // Copy: the blob's own offset may not be 4-byte aligned, and the caller must not see later changes of the buffer.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  const f32 = new Float32Array(copy.buffer, 0, copy.byteLength / 4);
  checkTyped(f32, "stored", ctx);
  return f32;
}

/**
 * The one predicate for a distance sqlite-vec returned: a finite number in [-1e-4, 2 + 1e-4], clamped into [0, 2].
 * Anything else — NULL, NaN, an infinity, a finite value outside the interval — is a FAULT (`null`).
 */
export function usableDistance(d: unknown): number | null {
  if (typeof d !== "number" || !Number.isFinite(d)) return null;
  if (d < -DISTANCE_TOLERANCE || d > 2 + DISTANCE_TOLERANCE) return null;
  return d < 0 ? 0 : d > 2 ? 2 : d;
}

/** A native self-distance that shows sqlite-vec can compute the vector: usable and at most 1e-4 from zero. */
export function usableSelfDistance(d: unknown): boolean {
  return typeof d === "number" && Number.isFinite(d) && Math.abs(d) <= DISTANCE_TOLERANCE;
}

/** Cosine similarity of two vectors of EQUAL length; throws on a length difference (never reads the shorter one). */
export function cosineSimilarityStrict(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`cosine similarity of vectors of different lengths (${a.length}, ${b.length})`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
