// Reranker-health guard — bug-first tests. These assert CORRECT behavior; the failures they would
// catch are the exact ones that shipped before: a reranker returning HTTP 200 + finite positive
// ~1e-11 scores that passed liveness yet silently collapsed ranking to RRF, and partial endpoint
// output that zero-fills into a false-pass. See RERANKER-HEALTH-GUARD-DESIGN.md.
import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { createStore, RerankCoverageError, RerankMalformedResponseError } from "../../src/store.ts";
import { blendRerank, RERANK_DEGENERATE_FLOOR } from "../../src/search-utils.ts";
import { probeRerankHealth, type GoldenTriple } from "../../src/health/rerank-health.ts";

// ---------------------------------------------------------------------------
// blendRerank — degenerate-floor trip, onFallback emit, options overload
// ---------------------------------------------------------------------------
describe("blendRerank", () => {
  const candidates = [
    { file: "a", score: 3 },
    { file: "b", score: 2 },
    { file: "c", score: 1 },
  ]; // RRF order: a, b, c

  test("degenerate reranker (~1e-11) falls back to RRF order AND fires onFallback", () => {
    // The historical bug: these finite positive scores passed the old `> 0` check, contributed
    // ~nothing at weight 0.9, and silently produced RRF order with NO signal that the reranker died.
    const reranked = [
      { file: "c", score: 1e-11 },
      { file: "b", score: 5e-12 },
      { file: "a", score: 2e-11 },
    ];
    let reason = "";
    const out = blendRerank(candidates, reranked, { onFallback: (r) => (reason = r) });
    expect(out.map((o) => o.file)).toEqual(["a", "b", "c"]); // RRF order preserved
    expect(reason).toContain("degenerate floor"); // the degrade is now VISIBLE
  });

  test("healthy reranker can promote a doc over RRF #1, and does NOT fire onFallback", () => {
    const reranked = [
      { file: "c", score: 0.95 }, // c is RRF-last but reranker-best
      { file: "a", score: 0.2 },
      { file: "b", score: 0.1 },
    ];
    let fired = false;
    const out = blendRerank(candidates, reranked, { onFallback: () => (fired = true) });
    expect(out[0]!.file).toBe("c"); // reranker promoted c over RRF #1 (a)
    expect(fired).toBe(false);
  });

  test("empty rerank output falls back and reports 'no scores'", () => {
    let reason = "";
    const out = blendRerank(candidates, [], { onFallback: (r) => (reason = r) });
    expect(out.map((o) => o.file)).toEqual(["a", "b", "c"]);
    expect(reason).toContain("no scores");
  });

  test("numeric 3rd arg (back-compat) still sets rerankWeight", () => {
    const reranked = [
      { file: "b", score: 0.9 },
      { file: "a", score: 0.1 },
    ];
    const out = blendRerank([{ file: "a", score: 3 }, { file: "b", score: 1 }], reranked, 0.9);
    expect(out[0]!.file).toBe("b"); // reranker-dominant at weight 0.9
  });

  test("2-arg call still works (default weight, no options)", () => {
    const out = blendRerank(
      [{ file: "a", score: 2 }, { file: "b", score: 1 }],
      [{ file: "b", score: 0.9 }, { file: "a", score: 0.1 }],
    );
    expect(out[0]!.file).toBe("b");
  });

  test("custom degenerateFloor is respected", () => {
    // 0.001 scores are above the default 1e-4 floor but below a custom 0.01 floor → fallback.
    let fired = false;
    const out = blendRerank(
      [{ file: "a", score: 2 }, { file: "b", score: 1 }],
      [{ file: "b", score: 0.001 }, { file: "a", score: 0.001 }],
      { degenerateFloor: 0.01, onFallback: () => (fired = true) },
    );
    expect(fired).toBe(true);
    expect(out.map((o) => o.file)).toEqual(["a", "b"]); // RRF order
  });

  test("the default degenerate floor sits above the broken regime and below working scores", () => {
    expect(RERANK_DEGENERATE_FLOOR).toBeGreaterThan(8.03e-7); // broken zerank-2 GGUF max-ever
    expect(RERANK_DEGENERATE_FLOOR).toBeLessThan(0.1); // weakest working score observed
  });
});

// ---------------------------------------------------------------------------
// store.rerank seam — coverage-before-zero-fill + noCache (the H1/M4/H2 mechanics)
// ---------------------------------------------------------------------------
describe("store.rerank probe seam", () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.CLAWMEM_RERANK_URL;
  const originalNoLocal = process.env.CLAWMEM_NO_LOCAL_MODELS;

  beforeEach(() => {
    process.env.CLAWMEM_RERANK_URL = "http://rerank.test:8090";
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CLAWMEM_RERANK_URL;
    else process.env.CLAWMEM_RERANK_URL = originalUrl;
    if (originalNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = originalNoLocal;
  });

  function mockRerank(results: { index: number; relevance_score: number }[]): () => number {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ results }), { status: 200 });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  const docs = [
    { file: "a", text: "alpha document about one topic" },
    { file: "b", text: "beta document about another topic" },
  ];

  test("requireLiveCoverage THROWS (malformed) when the endpoint returns fewer results than the batch", async () => {
    mockRerank([{ index: 0, relevance_score: 0.7 }]); // 1 result for a 2-doc batch — wrong count
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankMalformedResponseError);
  });

  test("requireLiveCoverage THROWS (coverage) when a later batch fails after an earlier one scored", async () => {
    // 6 docs → 2 batches (4 + 2). Batch 1 returns 4 valid results (scored=true → local skipped);
    // batch 2 returns HTTP 500 → break → docs 4,5 never scored → end-of-fn coverage error.
    const docs6 = Array.from({ length: 6 }, (_, i) => ({ file: `d${i}`, text: `text number ${i}` }));
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ results: [0, 1, 2, 3].map((index) => ({ index, relevance_score: 0.5 })) }),
          { status: 200 },
        );
      }
      return new Response("err", { status: 500 }); // batch 2 fails
    }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs6, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankCoverageError);
  });

  test("full coverage returns real scores sorted descending, no throw", async () => {
    mockRerank([
      { index: 0, relevance_score: 0.7 },
      { index: 1, relevance_score: 0.2 },
    ]);
    const store = createStore(":memory:");
    const out = await store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true });
    expect(out[0]!.file).toBe("a");
    expect(out[0]!.score).toBe(0.7);
  });

  test("WITHOUT requireLiveCoverage, partial output silently zero-fills (documents the bug coverage defends against)", async () => {
    mockRerank([{ index: 0, relevance_score: 0.7 }]); // b omitted
    const store = createStore(":memory:");
    const out = await store.rerank("q", docs, "m", undefined, { noCache: true });
    const b = out.find((r) => r.file === "b");
    expect(b!.score).toBe(0); // omitted score is indistinguishable from a true 0 after the map
  });

  test("noCache forces a live call every time (no cache read)", async () => {
    const calls = mockRerank([
      { index: 0, relevance_score: 0.7 },
      { index: 1, relevance_score: 0.2 },
    ]);
    const store = createStore(":memory:");
    await store.rerank("q", docs, "m", undefined, { noCache: true });
    await store.rerank("q", docs, "m", undefined, { noCache: true });
    expect(calls()).toBe(2); // both calls hit the endpoint
  });

  test("without noCache, an identical second call is served from cache (no second fetch)", async () => {
    const calls = mockRerank([
      { index: 0, relevance_score: 0.7 },
      { index: 1, relevance_score: 0.2 },
    ]);
    const store = createStore(":memory:");
    await store.rerank("q", docs, "m"); // populates cache
    await store.rerank("q", docs, "m"); // cache hit
    expect(calls()).toBe(1);
  });

  // Malformed-response contract under requireLiveCoverage (impl-review High) — a responding-but-
  // garbage reranker must surface, not false-pass or crash.
  test("requireLiveCoverage throws on a duplicate index", async () => {
    mockRerank([
      { index: 0, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.8 }, // duplicate; doc b never scored
    ]);
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankMalformedResponseError);
  });

  test("requireLiveCoverage throws on an out-of-range index", async () => {
    mockRerank([
      { index: 0, relevance_score: 0.9 },
      { index: 5, relevance_score: 0.1 }, // out of range for a 2-doc batch
    ]);
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankMalformedResponseError);
  });

  test("requireLiveCoverage throws on a wrong result count", async () => {
    mockRerank([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.2 },
      { index: 0, relevance_score: 0.5 }, // 3 results for a 2-doc batch
    ]);
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankMalformedResponseError);
  });

  test("requireLiveCoverage throws on a non-numeric (string) score", async () => {
    mockRerank([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: "0.2" as unknown as number }, // string survives JSON
    ]);
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankMalformedResponseError);
  });

  test("requireLiveCoverage throws on an invalid-JSON body from a 200 response", async () => {
    globalThis.fetch = (async () => new Response("not json at all", { status: 200 })) as unknown as typeof fetch;
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankMalformedResponseError);
  });

  test("requireLiveCoverage throws on a null/primitive JSON body", async () => {
    globalThis.fetch = (async () => new Response("null", { status: 200 })) as unknown as typeof fetch;
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true }),
    ).rejects.toBeInstanceOf(RerankMalformedResponseError);
  });

  test("non-probe path skips an out-of-range entry instead of crashing (defensive)", async () => {
    mockRerank([
      { index: 0, relevance_score: 0.9 },
      { index: 5, relevance_score: 0.1 }, // out of range — must not crash
    ]);
    const store = createStore(":memory:");
    const out = await store.rerank("q", docs, "m", undefined, { noCache: true }); // no requireLiveCoverage
    expect(out.find((r) => r.file === "a")!.score).toBe(0.9);
    expect(out.find((r) => r.file === "b")!.score).toBe(0); // b skipped → zero-filled, no crash
  });
});

// ---------------------------------------------------------------------------
// probeRerankHealth — calibration band + per-pair discrimination + coverage
// ---------------------------------------------------------------------------
describe("probeRerankHealth", () => {
  const triples: GoldenTriple[] = [
    { query: "q1", relevant: "r1", hardNegative: "n1" },
    { query: "q2", relevant: "r2", hardNegative: "n2" },
  ];

  // Fake store whose rerank scores each doc by a supplied function — no network, deterministic.
  function fakeStore(scoreOf: (file: string) => number) {
    return {
      rerank: async (_q: string, d: { file: string; text: string }[]) =>
        d.map((x) => ({ file: x.file, score: scoreOf(x.file) })).sort((a, b) => b.score - a.score),
    } as unknown as Parameters<typeof probeRerankHealth>[0];
  }

  test("healthy reranker (rel high, neg low) → ok", async () => {
    const res = await probeRerankHealth(fakeStore((f) => (f.endsWith("-rel") ? 0.9 : 0.1)), { triples });
    expect(res.ok).toBe(true);
    expect(res.coverageOk).toBe(true);
    expect(res.failures).toEqual([]);
  });

  test("degenerate reranker (~1e-11 everywhere) → fails the calibration band", async () => {
    const res = await probeRerankHealth(fakeStore(() => 1e-11), { triples });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.includes("calibration"))).toBe(true);
  });

  test("constant-output reranker (0.5 everywhere) → band passes but per-pair margin fails", async () => {
    const res = await probeRerankHealth(fakeStore(() => 0.5), { triples });
    expect(res.ok).toBe(false);
    expect(res.maxScore).toBe(0.5); // calibration band is satisfied...
    expect(res.failures.some((f) => f.includes("margin"))).toBe(true); // ...but discrimination is not
  });

  test("coverage failure (RerankCoverageError) surfaces as a probe failure", async () => {
    const throwing = {
      rerank: async () => {
        throw new RerankCoverageError(["x"]);
      },
    } as unknown as Parameters<typeof probeRerankHealth>[0];
    const res = await probeRerankHealth(throwing, { triples });
    expect(res.ok).toBe(false);
    expect(res.coverageOk).toBe(false);
    expect(res.failures.some((f) => f.includes("coverage"))).toBe(true);
  });
});
