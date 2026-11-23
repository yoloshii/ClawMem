/**
 * BACKLOG 82.2, D1 — an endpoint vector is validated RAW, once, at the response boundary, THROUGH THE REAL RESPONSE
 * PARSING (a stub HTTP endpoint), not the validator alone. Three classes are told apart at the handler:
 *   (a) no response      — a transport error, a non-2xx status: `null`, as before;
 *   (b) malformed envelope — a 2xx whose body is not the expected shape: `EmbedEnvelopeError`;
 *   (c) poison           — an item the validator refuses: `VecPoisonError`.
 * (b) and (c) carry the batch item index and the caller's context, and never trip the endpoint-down cooldown.
 * Every test here fails on v0.43.6, which returns the endpoint's array as received.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { LlamaCpp } from "../../src/llm.ts";
import { VecPoisonError, EmbedEnvelopeError, FatalVectorError } from "../../src/vector-guard.ts";
import { deadPort } from "../helpers/embed-readiness-fixture.ts";

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

/** A server whose every `/v1/embeddings` reply is `body` (raw text, so `1e400` can be sent). */
function serve(body: string | (() => Response)) {
  const hits = { n: 0 };
  const s = Bun.serve({
    port: 0,
    fetch: () => { hits.n++; return typeof body === "string" ? new Response(body, { headers: { "content-type": "application/json" } }) : body(); },
  });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}`, hits };
}
const llmFor = (url: string) => new LlamaCpp({ remoteEmbedUrl: url });
type Internals = { remoteEmbedDownUntil: number; remoteEmbedHttpErrorStreak: number };
const internals = (llm: LlamaCpp) => llm as unknown as Internals;
const caught = async (p: Promise<unknown>): Promise<unknown> => { try { await p; } catch (e) { return e; } return "resolved"; };
const single = (embedding: string, extra = "") => `{"data":[{"embedding":${embedding},"index":0}],"model":"m1"${extra}}`;

describe("single response", () => {
  it("a healthy reply is returned as a validated Float32Array", async () => {
    const r = await llmFor(serve(single("[0.6,0.8]")).url).embed("x", { context: "query" });
    expect(r!.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(r!.embedding)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(r!.model).toBe("m1");
  });

  it("a single reply WITHOUT `index` is accepted as item 0 (operator ruling 2026-11-20; batches stay strict)", async () => {
    const srv = serve('{"data":[{"embedding":[0.6,0.8]}],"model":"m1"}');
    const r = await llmFor(srv.url).embed("x", { context: "query" });
    expect(Array.from(r!.embedding)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(srv.hits.n).toBe(1);
    // The vector of such a reply is still validated.
    const e = await caught(llmFor(serve('{"data":[{"embedding":[null,1]}],"model":"m1"}').url).embed("x", { context: "query" }));
    expect(e).toBeInstanceOf(VecPoisonError);
  });

  const poisoned: [string, string, string][] = [
    ["[null,null]", "non-number", "all null — would be stored as zeros"],
    ["[null,1]", "non-number", "mixed null — would be stored as [0, 1]"],
    ['["0.5",1]', "non-number", "a numeric string"],
    ["[true,1]", "non-number", "a boolean"],
    ["[1e400,1]", "non-finite", "JSON 1e400 parses to Infinity"],
    ["[0,0,0]", "norm", "all-zero"],
    ["[1e300,0]", "float32-overflow", "the 1e300 probe"],
    ["[1e38,0]", "norm", "a vector sqlite-vec cannot compute"],
    ["[]", "empty", "an empty embedding"],
    ['"abc"', "not-an-array", "not an array"],
  ];
  for (const [embedding, reason, label] of poisoned) {
    it(`poison is a VecPoisonError(${reason}) with the caller's context: ${label}`, async () => {
      const srv = serve(single(embedding));
      const llm = llmFor(srv.url);
      const e = await caught(llm.embed("x", { context: "abc123_4" }));
      expect(e).toBeInstanceOf(VecPoisonError);
      expect(e).toBeInstanceOf(FatalVectorError);
      expect([(e as VecPoisonError).reason, (e as VecPoisonError).source, (e as VecPoisonError).context]).toEqual([reason, "endpoint", "abc123_4"]);
      // The endpoint answered: no cooldown, no HTTP-error streak, and no retry of the same request.
      expect(internals(llm).remoteEmbedDownUntil).toBe(0);
      expect(internals(llm).remoteEmbedHttpErrorStreak).toBe(0);
      expect(srv.hits.n).toBe(1);
    });
  }

  const envelopes: [string, string][] = [
    ['{"model":"m1"}', "no data array"],
    ['{"data":{"embedding":[1,0]},"model":"m1"}', "data is not an array"],
    ['{"data":[],"model":"m1"}', "no item"],
    ['{"data":[{"index":0}],"model":"m1"}', "an item without embedding"],
    ['{"data":[{"embedding":[1,0],"index":0},{"embedding":[0,1],"index":1}],"model":"m1"}', "more items than requested"],
    ['{"data":[{"embedding":[1,0],"index":1}],"model":"m1"}', "an index out of range"],
    ['{"data":[null],"model":"m1"}', "an item that is not an object"],
    ['{"data":[{"embedding":[1,0],"index":"0"}],"model":"m1"}', "an index that is present and not an integer"],
    ['{"data":[{"embedding":[1,0],"index":null}],"model":"m1"}', "an index that is present and null"],
    ["not json", "a 2xx body that is not JSON"],
    ['{"data":[{"embedding":[1,0],"index":0}],"model":"\\ufeffm1"}', "a model name that starts with a byte-order mark"],
    ['{"data":[{"embedding":[1,0],"index":0}],"model":"\\ufffem1"}', "a model name that starts with U+FFFE"],
  ];
  for (const [body, label] of envelopes) {
    it(`a malformed envelope is an EmbedEnvelopeError: ${label}`, async () => {
      const srv = serve(body);
      const llm = llmFor(srv.url);
      const e = await caught(llm.embed("x", { context: "probe:rel_a" }));
      expect(e).toBeInstanceOf(EmbedEnvelopeError);
      expect(e).toBeInstanceOf(FatalVectorError);
      expect((e as EmbedEnvelopeError).context).toBe("probe:rel_a");
      expect(internals(llm).remoteEmbedDownUntil).toBe(0);
      expect(internals(llm).remoteEmbedHttpErrorStreak).toBe(0);
      expect(srv.hits.n).toBe(1);
    });
  }

  it("a transport error and a non-2xx status still read as no response", async () => {
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    try {
      expect(await llmFor(`http://127.0.0.1:${deadPort()}`).embed("x")).toBeNull();
      expect(await llmFor(serve(() => new Response("busy", { status: 503 })).url).embed("x")).toBeNull();
      expect(await llmFor(serve(() => new Response("no", { status: 400 })).url).embed("x")).toBeNull();
    } finally { delete process.env.CLAWMEM_NO_LOCAL_MODELS; }
  });

  it("the context defaults to a named placeholder when the caller gives none", async () => {
    const e = await caught(llmFor(serve(single("[null,1]")).url).embed("x"));
    expect((e as VecPoisonError).context).toBe("unspecified");
  });
});

describe("batch response", () => {
  const batch = (items: string, model = '"m1"') => `{"data":[${items}],"model":${model}}`;
  const item = (i: number, embedding = "[1,0]") => `{"embedding":${embedding},"index":${i}}`;

  it("a healthy batch is returned in request order, each validated", async () => {
    const out = await llmFor(serve(batch([item(1, "[0,1]"), item(0, "[1,0]")].join(","))).url).embedBatch(["a", "b"], ["h_0", "h_1"]);
    expect(out.map(r => Array.from(r!.embedding))).toEqual([[1, 0], [0, 1]]);
    expect(out.every(r => r!.embedding instanceof Float32Array)).toBe(true);
  });

  it("a poisoned THIRD item refuses the whole batch, naming its index and its context", async () => {
    const srv = serve(batch([item(0), item(1), item(2, "[null,1]")].join(",")));
    const llm = llmFor(srv.url);
    const e = await caught(llm.embedBatch(["a", "b", "c"], ["h_0", "h_1", "h_2"]));
    expect(e).toBeInstanceOf(VecPoisonError);
    expect([(e as VecPoisonError).reason, (e as VecPoisonError).index, (e as VecPoisonError).context]).toEqual(["non-number", 2, "h_2"]);
    expect(internals(llm).remoteEmbedDownUntil).toBe(0);
    expect(internals(llm).remoteEmbedHttpErrorStreak).toBe(0);
    expect(srv.hits.n).toBe(1);
  });

  const envelopes: [string, string][] = [
    ['{"model":"m1"}', "no data array"],
    [batch([item(0), item(1)].join(",")), "a short count"],
    [batch([item(0), item(1), item(1)].join(",")), "a repeated index"],
    [batch([item(0), item(1), item(3)].join(",")), "an index out of range"],
    [batch([item(0), item(1), '{"embedding":[1,0]}'].join(",")), "a missing index"],
    [batch([item(0), item(1), '{"embedding":[1,0],"index":"2"}'].join(",")), "an index that is not an integer"],
    [batch([item(0), item(1), '{"index":2}'].join(",")), "an item without embedding"],
    [batch([item(0), item(1), item(2), item(3)].join(",")), "more items than requested"],
    [batch([item(0), item(1), item(2)].join(","), '"\\ufeffm1"'), "a mark-led model name"],
  ];
  for (const [body, label] of envelopes) {
    it(`a malformed batch envelope is an EmbedEnvelopeError: ${label}`, async () => {
      const srv = serve(body);
      const llm = llmFor(srv.url);
      const e = await caught(llm.embedBatch(["a", "b", "c"], ["h_0", "h_1", "h_2"]));
      expect(e).toBeInstanceOf(EmbedEnvelopeError);
      expect(internals(llm).remoteEmbedDownUntil).toBe(0);
      expect(internals(llm).remoteEmbedHttpErrorStreak).toBe(0);
      expect(srv.hits.n).toBe(1);
    });
  }

  it("a transport error and a non-2xx status still read as no response for every item", async () => {
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    try {
      expect(await llmFor(`http://127.0.0.1:${deadPort()}`).embedBatch(["a", "b"])).toEqual([null, null]);
      expect(await llmFor(serve(() => new Response("busy", { status: 503 })).url).embedBatch(["a", "b"])).toEqual([null, null]);
    } finally { delete process.env.CLAWMEM_NO_LOCAL_MODELS; }
  });
});

describe("local (in-process) handlers", () => {
  /** A LlamaCpp whose in-process embedding context is a stub: no model is loaded. */
  function localLlm(vectorFor: (text: string) => unknown) {
    const llm = new LlamaCpp({});
    (llm as unknown as { ensureEmbedContext: () => Promise<unknown> }).ensureEmbedContext =
      async () => ({ getEmbeddingFor: async (text: string) => ({ vector: vectorFor(text) }) });
    return llm;
  }

  it("a healthy local vector is validated and returned typed", async () => {
    const r = await localLlm(() => [0.6, 0.8]).embed("x");
    expect(r!.embedding).toBeInstanceOf(Float32Array);
  });

  it("a poisoned local vector is a VecPoisonError — single and batch — not a silent null", async () => {
    const one = await caught(localLlm(() => [NaN, 1]).embed("x", { context: "query" }));
    expect(one).toBeInstanceOf(VecPoisonError);
    expect((one as VecPoisonError).context).toBe("query");
    const many = await caught(localLlm(t => (t === "c" ? [0, 0] : [1, 0])).embedBatch(["a", "b", "c"], ["h_0", "h_1", "h_2"]));
    expect(many).toBeInstanceOf(VecPoisonError);
    expect([(many as VecPoisonError).reason, (many as VecPoisonError).index, (many as VecPoisonError).context]).toEqual(["norm", 2, "h_2"]);
  });

  it("a local failure that is not a refused vector is still no response", async () => {
    const llm = new LlamaCpp({});
    (llm as unknown as { ensureEmbedContext: () => Promise<unknown> }).ensureEmbedContext = async () => { throw new Error("model file missing"); };
    expect(await llm.embed("x")).toBeNull();
    expect(await llm.embedBatch(["a", "b"])).toEqual([null, null]);
  });
});
