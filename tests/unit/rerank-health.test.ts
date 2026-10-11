// Reranker-health guard — bug-first tests. These assert CORRECT behavior; the failures they would
// catch are the exact ones that shipped before: a reranker returning HTTP 200 + finite positive
// ~1e-11 scores that passed liveness yet silently collapsed ranking to RRF, and partial endpoint
// output that zero-fills into a false-pass. See RERANKER-HEALTH-GUARD-DESIGN.md.
import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { createStore, RerankCoverageError, RerankMalformedResponseError, rerankCacheKey, rerankTextHash, rerankTransmittedText, rerankProviderNamespace, writeRerankProviderFingerprint, revokeRerankProviderFingerprint, isRerankProviderRevoked, readRerankProviderFingerprint, rerankIdentityState, _setRerankStateReadHook, RERANK_PROVIDER_ATTESTATION_TTL_MS } from "../../src/store.ts";
import { blendRerank, RERANK_DEGENERATE_FLOOR } from "../../src/search-utils.ts";
import { probeRerankHealth, assessRerankDegeneracy, RERANK_CALIB_FLOOR, RERANK_DISCRIM_MARGIN, RERANK_REQUEST_SPREAD_FLOOR, rerankDiscrimMargin, type GoldenTriple } from "../../src/health/rerank-health.ts";

/**
 * A store whose configured rerank endpoint is already ATTESTED. Remote
 * caching is off until a durable identity exists (codex turn-30 SPEC-1) and a
 * declared provider id alone is not one (codex turn-33 SPEC-2), so any test
 * asserting cache BEHAVIOR has to stand up an identity first.
 */
function attestedStore(fp = "behavioral:testfixture0000") {
  const st = createStore(":memory:");
  const url = process.env.CLAWMEM_RERANK_URL?.trim();
  if (url) writeRerankProviderFingerprint(st.db, url, fp);
  return st;
}

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
  const originalApiKey = process.env.CLAWMEM_RERANK_API_KEY;

  const originalProviderId = process.env.CLAWMEM_RERANK_PROVIDER_ID;
  beforeEach(() => {
    process.env.CLAWMEM_RERANK_URL = "http://rerank.test:8090";
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    // The remote cache is off without a durable provider identity (codex
    // turn-30 SPEC-1); the cache-behavior assertions below declare one.
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "probe-seam-provider";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CLAWMEM_RERANK_URL;
    else process.env.CLAWMEM_RERANK_URL = originalUrl;
    if (originalNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = originalNoLocal;
    if (originalApiKey === undefined) delete process.env.CLAWMEM_RERANK_API_KEY;
    else process.env.CLAWMEM_RERANK_API_KEY = originalApiKey;
    if (originalProviderId === undefined) delete process.env.CLAWMEM_RERANK_PROVIDER_ID;
    else process.env.CLAWMEM_RERANK_PROVIDER_ID = originalProviderId;
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
    const store = attestedStore();
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

  // W3 remote-reranker auth — the remote GPU reranker may sit behind an authenticated gateway.
  test("sends Authorization: Bearer to the remote reranker when CLAWMEM_RERANK_API_KEY is set", async () => {
    process.env.CLAWMEM_RERANK_API_KEY = "test-rerank-key";
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.2 }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    await store.rerank("q", docs, "m", undefined, { noCache: true });
    expect(seenHeaders?.["Authorization"]).toBe("Bearer test-rerank-key");
    expect(seenHeaders?.["Content-Type"]).toBe("application/json");
  });

  test("omits Authorization to the remote reranker when CLAWMEM_RERANK_API_KEY is unset (backward compatible)", async () => {
    delete process.env.CLAWMEM_RERANK_API_KEY;
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.2 }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    await store.rerank("q", docs, "m", undefined, { noCache: true });
    expect(seenHeaders?.["Authorization"]).toBeUndefined();
    expect(seenHeaders?.["Content-Type"]).toBe("application/json");
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

  test("rerankDiscrimMargin: default, valid override, invalid values fall back", () => {
    expect(rerankDiscrimMargin(undefined)).toBe(RERANK_DISCRIM_MARGIN);
    expect(rerankDiscrimMargin("")).toBe(RERANK_DISCRIM_MARGIN);
    expect(rerankDiscrimMargin("0.1")).toBe(0.1);
    for (const bad of ["abc", "0", "-0.2", "1", "2", "NaN"]) expect(rerankDiscrimMargin(bad)).toBe(RERANK_DISCRIM_MARGIN);
  });

  test("CLAWMEM_RERANK_DISCRIM_MARGIN: a saturating-but-correct reranker (1.0 vs 0.86) passes at 0.1, fails at the default", async () => {
    const sat = fakeStore((f) => (f.endsWith("-rel") ? 1.0 : 0.86));
    const prev = Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN;
    try {
      delete Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN;
      expect((await probeRerankHealth(sat, { triples })).ok).toBe(false);
      Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN = "0.1";
      expect((await probeRerankHealth(sat, { triples })).ok).toBe(true);
    } finally {
      if (prev === undefined) delete Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN; else Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN = prev;
    }
  });

  test("a lowered margin still rejects inverted and constant rerankers", async () => {
    const prev = Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN;
    try {
      Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN = "0.1";
      expect((await probeRerankHealth(fakeStore((f) => (f.endsWith("-rel") ? 0.2 : 0.9)), { triples })).ok).toBe(false); // inverted
      expect((await probeRerankHealth(fakeStore(() => 0.5), { triples })).ok).toBe(false); // constant
      expect((await probeRerankHealth(fakeStore(() => 1e-11), { triples })).ok).toBe(false); // collapse
    } finally {
      if (prev === undefined) delete Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN; else Bun.env.CLAWMEM_RERANK_DISCRIM_MARGIN = prev;
    }
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

describe("store.rerank deadline (BUILD-3a, O1: no untimed local fallback, bounded batches)", () => {
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

  const docs = [
    { file: "a", text: "alpha document about one topic" },
    { file: "b", text: "beta document about another topic" },
  ];

  test("an already-expired deadline: no remote batch is attempted, the local fallback is skipped, coverage error surfaces", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true, deadline: deadlineAfter(monoNow(), duration(0)) }),
    ).rejects.toBeInstanceOf(RerankCoverageError);
    expect(calls).toBe(0); // the pre-batch deadline check ran before any fetch
  });

  test("an open deadline behaves like the normal path (control)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [
        { index: 0, relevance_score: 0.7 },
        { index: 1, relevance_score: 0.2 },
      ] }), { status: 200 })) as unknown as typeof fetch;
    const store = createStore(":memory:");
    const out = await store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true, deadline: deadlineAfter(monoNow(), duration(10_000)) });
    expect(out[0]!.file).toBe("a");
    expect(out[0]!.score).toBe(0.7);
  });

  test("deadline expiring BETWEEN batches: batch 2 is never started, its docs surface as a coverage error", async () => {
    // 6 docs → 2 batches. Batch 1's mock takes ~80ms against a ~50ms deadline,
    // returns valid scores; the pre-batch check then stops batch 2.
    const docs6 = Array.from({ length: 6 }, (_, i) => ({ file: `d${i}`, text: `text number ${i}` }));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 80));
      return new Response(
        JSON.stringify({ results: [0, 1, 2, 3].map((index) => ({ index, relevance_score: 0.5 })) }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    await expect(
      store.rerank("q", docs6, "m", undefined, { noCache: true, requireLiveCoverage: true, deadline: deadlineAfter(monoNow(), duration(50)) }),
    ).rejects.toBeInstanceOf(RerankCoverageError);
    expect(calls).toBe(1); // batch 1 attempted; batch 2 stopped by the deadline
  });

  test("codex migration r2 #3: batch 1 finishes INSIDE the window, so batch 2 starts — and aborts on the REMAINING window, never a fresh full timeout", async () => {
    // 6 docs → 2 batches under a 300 ms deadline (the hook's form). Batch 1 answers at ~150 ms; batch 2 honors its
    // signal and hangs until it aborts. Remainder-bounded: batch 2 aborts at ~300 ms total. A fresh
    // per-batch timeout would let it run to ~450 ms (150 + 300).
    const docs6 = Array.from({ length: 6 }, (_, i) => ({ file: `d${i}`, text: `text number ${i}` }));
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 150));
        return new Response(JSON.stringify({ results: [0, 1, 2, 3].map((index) => ({ index, relevance_score: 0.5 })) }), { status: 200 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return reject(new Error("batch 2 was dispatched without a signal"));
        if (sig.aborted) return reject(sig.reason);
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    const t0 = performance.now();
    await expect(
      store.rerank("q", docs6, "m", undefined, { noCache: true, requireLiveCoverage: true, deadline: deadlineAfter(monoNow(), duration(300)) }),
    ).rejects.toBeInstanceOf(RerankCoverageError);
    const took = performance.now() - t0;
    expect(calls).toBe(2);                    // batch 1 finished inside the window, so batch 2 was started
    expect(took).toBeGreaterThanOrEqual(280); // batch 2 ran on what was left…
    expect(took).toBeLessThan(400);           // …and aborted at the ORIGINAL deadline, not 150 + 300
  });

  test("remote fails under a deadline: the local fallback is NOT taken (deadline callers fail to the guard, never to unbounded CPU inference)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("err", { status: 500 });
    }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    // Without `deadline` this path would reach getDefaultLlamaCpp(); with it,
    // the fallback is skipped and coverage throws instead.
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true, deadline: deadlineAfter(monoNow(), duration(10_000)) }),
    ).rejects.toBeInstanceOf(RerankCoverageError);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// BUILD-3b — content-true rerank cache identity (the turn-18 F2 full contract)
// ---------------------------------------------------------------------------
describe("BUILD-3b: rerank cache key is content-true", () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.CLAWMEM_RERANK_URL;
  const originalNoLocal = process.env.CLAWMEM_NO_LOCAL_MODELS;
  const originalProvider = process.env.CLAWMEM_RERANK_PROVIDER_ID;

  beforeEach(() => {
    process.env.CLAWMEM_RERANK_URL = "http://rerank.test:8090";
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    // A durable provider identity is what ENABLES the remote cache at all
    // (codex turn-30 SPEC-1); these tests are about the key's CONTENT member,
    // so they declare one and hold it fixed.
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "fixed-provider-for-content-tests";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CLAWMEM_RERANK_URL;
    else process.env.CLAWMEM_RERANK_URL = originalUrl;
    if (originalNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = originalNoLocal;
    if (originalProvider === undefined) delete process.env.CLAWMEM_RERANK_PROVIDER_ID;
    else process.env.CLAWMEM_RERANK_PROVIDER_ID = originalProvider;
  });

  /** Mock returning a FIXED score per call, so a served score is distinguishable from a cached one. */
  function mockScore(score: number): () => number {
    let calls = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: score })) }), { status: 200 });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  test("the transmitted text IS the 400-char projection, and the hash identifies exactly that", () => {
    const head = "x".repeat(400);
    expect(rerankTransmittedText(head + "TAIL")).toBe(head);
    // Content past the transmission boundary cannot change the score, so it
    // must not change the identity either (a false miss on every long doc).
    expect(rerankTextHash(head + "one tail")).toBe(rerankTextHash(head + "another tail"));
    // A change WITHIN the transmitted window is a different request.
    expect(rerankTextHash("alpha")).not.toBe(rerankTextHash("alpba"));
  });

  test("the revision, the content, and the PROVIDER are each part of the key", () => {
    const P = "remote:http://rerank-a.test:8090";
    // revision: a request-construction change invalidates every cached score
    expect(rerankCacheKey("q", "a", "m", "body", P, 1)).not.toBe(rerankCacheKey("q", "a", "m", "body", P, 2));
    // content: the content-true member (BUILD-3b)
    expect(rerankCacheKey("q", "a", "m", "body", P)).not.toBe(rerankCacheKey("q", "a", "m", "other", P));
    // provider: the service that actually scores (codex turn-29 SPEC-4)
    expect(rerankCacheKey("q", "a", "m", "body", P)).not.toBe(rerankCacheKey("q", "a", "m", "body", "local:m"));
  });

  test("THE STALE-SCORE HAZARD: same path + same query, EDITED content ⇒ the endpoint is re-asked (never the old score)", async () => {
    const store = createStore(":memory:");
    const calls1 = mockScore(0.11);
    const first = await store.rerank("q", [{ file: "notes/a.md", text: "the original body text" }], "m");
    expect(first[0]!.score).toBeCloseTo(0.11, 5);
    expect(calls1()).toBe(1);

    // Same file, same query, same model — only the CONTENT changed. Under the
    // pre-BUILD-3b key ({query, file, model}) this returned 0.11 with ZERO
    // fetches: a score for text the reranker never saw.
    const calls2 = mockScore(0.93);
    const second = await store.rerank("q", [{ file: "notes/a.md", text: "a completely rewritten body" }], "m");
    expect(second[0]!.score).toBeCloseTo(0.93, 5);
    expect(calls2()).toBe(1);
  });

  test("unchanged content still HITS the cache (the key is content-true, not cache-disabling)", async () => {
    const store = attestedStore();
    const calls1 = mockScore(0.42);
    await store.rerank("q", [{ file: "notes/a.md", text: "stable body" }], "m");
    expect(calls1()).toBe(1);
    const calls2 = mockScore(0.99); // would win if the endpoint were consulted
    const again = await store.rerank("q", [{ file: "notes/a.md", text: "stable body" }], "m");
    expect(again[0]!.score).toBeCloseTo(0.42, 5); // served from cache
    expect(calls2()).toBe(0);
  });

  test("an edit BEYOND the transmitted window keeps the cache hit (identity tracks what was actually sent)", async () => {
    const store = attestedStore();
    const head = "h".repeat(400);
    const calls1 = mockScore(0.5);
    await store.rerank("q", [{ file: "notes/b.md", text: head + " original tail" }], "m");
    expect(calls1()).toBe(1);
    const calls2 = mockScore(0.8);
    const again = await store.rerank("q", [{ file: "notes/b.md", text: head + " EDITED tail" }], "m");
    expect(again[0]!.score).toBeCloseTo(0.5, 5);
    expect(calls2()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Codex turn-29 SPEC-4 — the cache key must name the service that SCORES
// ---------------------------------------------------------------------------
describe("rerank cache key: provider identity (codex turn-29 SPEC-4)", () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.CLAWMEM_RERANK_URL;
  const originalProvider = process.env.CLAWMEM_RERANK_PROVIDER_ID;
  const originalNoLocal = process.env.CLAWMEM_NO_LOCAL_MODELS;

  beforeEach(() => {
    process.env.CLAWMEM_RERANK_URL = "http://rerank-a.test:8090";
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
    delete process.env.CLAWMEM_RERANK_PROVIDER_ID;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CLAWMEM_RERANK_URL;
    else process.env.CLAWMEM_RERANK_URL = originalUrl;
    if (originalProvider === undefined) delete process.env.CLAWMEM_RERANK_PROVIDER_ID;
    else process.env.CLAWMEM_RERANK_PROVIDER_ID = originalProvider;
    if (originalNoLocal === undefined) delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    else process.env.CLAWMEM_NO_LOCAL_MODELS = originalNoLocal;
  });

  function mockScore(score: number): () => number {
    let calls = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: score })) }), { status: 200 });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  test("remote and local fallback never share a namespace (they are different scorers)", () => {
    const store = createStore(":memory:");
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "id-a";
    expect(rerankProviderNamespace("remote", "m", store.db)).not.toBe(rerankProviderNamespace("local", "m", store.db));
    expect(rerankProviderNamespace("local", "m", store.db)).toContain("local:");
    // Without a db the revocation state is unknowable, so remote fails closed.
    expect(rerankProviderNamespace("remote", "m")).toBeNull();
  });

  test("REVOCATION overrides a DECLARED provider id, not just the observed fingerprint (codex turn-32 SPEC-3)", async () => {
    const store = attestedStore();
    const url = "http://rerank-a.test:8090";
    const doc = [{ file: "notes/a.md", text: "declared id under revocation" }];
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "declared-v1";
    const c1 = mockScore(0.11);
    await store.rerank("q", doc, "m");
    expect(c1()).toBe(1);
    const c2 = mockScore(0.99);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.11, 5); // declared id ⇒ cached
    expect(c2()).toBe(0);

    // A failed health run revokes. Pre-fix this deleted only the OBSERVED
    // fingerprint, so a declared id kept caching enabled and the revocation
    // contract was false.
    revokeRerankProviderFingerprint(store.db, url);
    expect(isRerankProviderRevoked(store.db, url)).toBe(true);
    expect(rerankProviderNamespace("remote", "m", store.db)).toBeNull();
    const c3 = mockScore(0.77);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.77, 5); // re-asked despite the declared id
    expect(c3()).toBe(1);

    // Only a successful re-attestation clears the tombstone.
    writeRerankProviderFingerprint(store.db, url, "behavioral:6666666666666666");
    expect(isRerankProviderRevoked(store.db, url)).toBe(false);
  });

  test("a revocation that does not persist THROWS instead of reporting success (codex turn-32 CR-4)", () => {
    const store = createStore(":memory:");
    // Simulate a busy/read-only failure: the tombstone write is swallowed by
    // the storage layer. Revocation must not report success.
    const realPrepare = store.db.prepare.bind(store.db);
    (store.db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      if (sql.includes("INSERT OR REPLACE INTO vault_flags")) return { run: () => undefined } as never;
      return realPrepare(sql);
    };
    try {
      expect(() => revokeRerankProviderFingerprint(store.db, "http://rerank-a.test:8090"))
        .toThrow(/failed to revoke the rerank provider identity/);
    } finally {
      (store.db as unknown as { prepare: unknown }).prepare = realPrepare;
    }
  });

  test("a DIFFERENT endpoint is a different namespace — scores never cross URLs", async () => {
    const store = createStore(":memory:");
    const doc = [{ file: "notes/a.md", text: "same body, two endpoints" }];
    const c1 = mockScore(0.25);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.25, 5);
    expect(c1()).toBe(1);

    process.env.CLAWMEM_RERANK_URL = "http://rerank-b.test:8090";
    const c2 = mockScore(0.75);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.75, 5); // endpoint B re-asked
    expect(c2()).toBe(1);
  });

  test("NO durable identity ⇒ NO remote cache — an unidentified endpoint scores but never caches (codex turn-30 SPEC-1)", async () => {
    const store = createStore(":memory:");
    const doc = [{ file: "notes/a.md", text: "unidentified endpoint" }];
    // No provider id declared and no health-probe fingerprint recorded.
    const c1 = mockScore(0.4);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.4, 5);
    expect(c1()).toBe(1);
    // A second call re-asks: nothing was written, so nothing can be served
    // later under a different model. Stale cross-provider scores are
    // structurally impossible, not merely documented.
    const c2 = mockScore(0.6);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.6, 5);
    expect(c2()).toBe(1);
    expect(store.db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get()).toEqual({ n: 0 });
  });

  test("a PERSISTED health-probe fingerprint turns caching on, and a swap behind the same url re-asks", async () => {
    const store = createStore(":memory:");
    const url = "http://rerank-a.test:8090";
    const doc = [{ file: "notes/a.md", text: "identified endpoint" }];
    writeRerankProviderFingerprint(store.db, url, "behavioral:1111111111111111");
    const c1 = mockScore(0.2);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.2, 5);
    expect(c1()).toBe(1);
    const c2 = mockScore(0.9);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.2, 5); // cached under the identity
    expect(c2()).toBe(0);

    // The next health run observes a DIFFERENT model behind the same url.
    writeRerankProviderFingerprint(store.db, url, "behavioral:2222222222222222");
    const c3 = mockScore(0.9);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.9, 5); // new namespace, re-asked
    expect(c3()).toBe(1);
  });

  test("an EXPIRED attestation stops caching until a fresh probe re-attests (codex turn-31 SPEC-2)", async () => {
    const store = createStore(":memory:");
    const url = "http://rerank-a.test:8090";
    const doc = [{ file: "notes/a.md", text: "aging attestation" }];
    writeRerankProviderFingerprint(store.db, url, "behavioral:3333333333333333");
    const c1 = mockScore(0.3);
    await store.rerank("q", doc, "m");
    expect(c1()).toBe(1);
    const c2 = mockScore(0.7);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.3, 5); // fresh attestation ⇒ cached
    expect(c2()).toBe(0);

    // Age the attestation past its TTL: a behavioral observation is evidence
    // about the deployment that answered it, and nothing stops a later swap
    // nobody re-probes.
    const stale = new Date(Date.now() - RERANK_PROVIDER_ATTESTATION_TTL_MS - 60_000).toISOString();
    store.db.prepare(`UPDATE vault_flags SET updated_at = ? WHERE flag = ?`).run(stale, `rerank_provider:${url}`);
    const c3 = mockScore(0.7);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.7, 5); // expired ⇒ no cache
    expect(c3()).toBe(1);
  });

  test("REVOKING the identity disables caching immediately (a failed probe must not leave the old flag standing)", async () => {
    const store = createStore(":memory:");
    const url = "http://rerank-a.test:8090";
    const doc = [{ file: "notes/a.md", text: "revoked identity" }];
    writeRerankProviderFingerprint(store.db, url, "behavioral:4444444444444444");
    const c1 = mockScore(0.15);
    await store.rerank("q", doc, "m");
    expect(c1()).toBe(1);

    revokeRerankProviderFingerprint(store.db, url);
    const c2 = mockScore(0.85);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.85, 5); // re-asked, not served
    expect(c2()).toBe(1);
    // ...and the score produced while revoked was never filed under the old
    // identity: re-attesting the SAME fingerprint (an endpoint that behaves
    // identically again) serves the ORIGINAL 0.15, not the 0.85 scored during
    // the revoked window.
    writeRerankProviderFingerprint(store.db, url, "behavioral:4444444444444444");
    const c3 = mockScore(0.99);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.15, 5);
    expect(c3()).toBe(0);
  });

  test("requireRemote: a DEAD remote is never rescued by local inference (codex turn-32 F1)", async () => {
    // The attestation must be about the endpoint being attested. Without
    // requireRemote, a dead remote falls through to the in-process model and
    // the probe would report a "healthy" identity derived from a completely
    // different scorer — then persist it under the remote URL.
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("gone", { status: 502 }); }) as unknown as typeof fetch;
    const store = createStore(":memory:");
    const docs = [{ file: "a", text: "alpha" }, { file: "b", text: "beta" }];
    await expect(
      store.rerank("q", docs, "m", undefined, { noCache: true, requireLiveCoverage: true, requireRemote: true }),
    ).rejects.toBeInstanceOf(RerankCoverageError);
    expect(calls).toBeGreaterThanOrEqual(1);
    // Nothing was scored, so nothing could be attested.
    expect(store.db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get()).toEqual({ n: 0 });
  });

  test("a MID-CALL re-attestation discards cached scores instead of mixing providers (codex turn-34 SPEC-2)", async () => {
    const url = "http://rerank-a.test:8090";
    const store = attestedStore("behavioral:mid0000000000000");
    const docA = { file: "notes/a.md", text: "doc a" };
    const docB = { file: "notes/b.md", text: "doc b" };
    // Warm the cache for doc A only.
    mockScore(0.10);
    await store.rerank("q", [docA], "m");
    expect(store.db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get()).toEqual({ n: 1 });

    // Now a two-doc call: A hits the cache, B needs the endpoint — and the
    // provider is RE-ATTESTED mid-call (as `rerank-health` would). Pre-fix
    // this returned A's old-provider score alongside B's new-provider one.
    let fetches = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (fetches === 0) writeRerankProviderFingerprint(store.db, url, "behavioral:mid1111111111111");
      fetches++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: 0.9 - i * 0.1 })) }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await store.rerank("q", [docA, docB], "m");
    const scores = new Map(out.map(r => [r.file, r.score]));
    // A's stale 0.10 must NOT survive. The change lands DURING the live
    // phase, so the post-live check drops A rather than re-scoring it — the
    // stale old-provider score is gone either way, which is the property that
    // matters. (A change landing BEFORE the live phase is caught by the
    // pre-live check, which re-scores the complete set instead; that window
    // belongs to a genuinely concurrent `rerank-health` PROCESS and has no
    // in-process seam to trigger deterministically — declared, not claimed
    // as tested.)
    expect(scores.get("notes/a.md")).not.toBeCloseTo(0.10, 5);
  });

  test("a strict caller gets a COVERAGE ERROR rather than a mixed-provider result", async () => {
    const url = "http://rerank-a.test:8090";
    const store = attestedStore("behavioral:strict0000000000");
    const docA = { file: "notes/a.md", text: "doc a" };
    const docB = { file: "notes/b.md", text: "doc b" };
    mockScore(0.10);
    await store.rerank("q", [docA], "m");

    let fetches = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (fetches === 0) writeRerankProviderFingerprint(store.db, url, "behavioral:strict1111111111");
      fetches++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: 0.9 })) }), { status: 200 });
    }) as unknown as typeof fetch;

    // The hook is a strict caller: an incomplete, identity-consistent result
    // surfaces as a coverage error and its failure guard arbitrates — never a
    // silently mixed ordering.
    await expect(store.rerank("q", [docA, docB], "m", undefined, { requireLiveCoverage: true }))
      .rejects.toBeInstanceOf(RerankCoverageError);
  });

  test("an ALL-LIVE multi-batch pool re-attested between batches is never returned as a mixed ordering (codex turn-35 SPEC-2)", async () => {
    const url = "http://rerank-a.test:8090";
    const store = attestedStore("behavioral:batch000000000000");
    // 6 docs ⇒ 2 batches of 4 + 2, nothing cached.
    const docs = Array.from({ length: 6 }, (_, i) => ({ file: `d${i}`, text: `text ${i}` }));
    let batch = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      batch++;
      // Batch 1 is answered by provider A; the re-attestation lands on the
      // SECOND fetch, so batch 2 genuinely comes from B (codex turn-36:
      // rewriting before the first response proved detection, not straddling).
      if (batch === 2) writeRerankProviderFingerprint(store.db, url, "behavioral:batch111111111111");
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: 0.5 })) }), { status: 200 });
    }) as unknown as typeof fetch;

    // cacheServed is EMPTY here, so the old cache-conditional guards did
    // nothing and a strict caller accepted the fully-covered mixed result.
    await expect(store.rerank("q", docs, "m", undefined, { requireLiveCoverage: true }))
      .rejects.toBeInstanceOf(RerankCoverageError);
    expect(batch).toBeGreaterThan(1); // batch 1 from A, batch 2 from B — a real straddle
  });

  test("an UNIDENTIFIED→ATTESTED transition mid-invocation is caught too (codex turn-36 SPEC-1)", async () => {
    const url = "http://rerank-a.test:8090";
    const store = createStore(":memory:");   // deliberately NOT attested: the state token is `absent`
    const docs = Array.from({ length: 6 }, (_, i) => ({ file: `d${i}`, text: `text ${i}` }));
    let batch = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      batch++;
      // A concurrent health workflow attests the endpoint between batches.
      if (batch === 2) writeRerankProviderFingerprint(store.db, url, "behavioral:late000000000000");
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: 0.5 })) }), { status: 200 });
    }) as unknown as typeof fetch;

    // Pre-fix the guard returned "unchanged" purely because the invocation
    // STARTED with a null namespace, so a strict caller accepted results that
    // straddled the transition.
    await expect(store.rerank("q", docs, "m", undefined, { requireLiveCoverage: true }))
      .rejects.toBeInstanceOf(RerankCoverageError);
    expect(batch).toBeGreaterThan(1);
  });

  test("the identity STATE TOKEN distinguishes absent, revoked, and expired — none of which is 'identity irrelevant'", () => {
    const url = "http://rerank-a.test:8090";
    const store = createStore(":memory:");
    const tok = () => rerankIdentityState("remote", "m", store.db).token;
    const absent = tok();
    expect(absent).toContain("absent:");
    writeRerankProviderFingerprint(store.db, url, "behavioral:tok0000000000000");
    const attested = tok();
    expect(attested).not.toBe(absent);
    expect(rerankIdentityState("remote", "m", store.db).namespace).toBe(attested.split("|g")[0]!); // the token carries a generation the namespace does not
    revokeRerankProviderFingerprint(store.db, url);
    expect(tok()).toContain("revoked:");
    expect(tok()).not.toBe(absent);          // revoked is NOT the same state as never-attested
    writeRerankProviderFingerprint(store.db, url, "behavioral:tok0000000000000");
    store.db.prepare(`UPDATE vault_flags SET updated_at = ? WHERE flag = ?`)
      .run(new Date(Date.now() - RERANK_PROVIDER_ATTESTATION_TTL_MS - 60_000).toISOString(), `rerank_provider:${url}`);
    expect(tok()).toContain("expired:");
    expect(rerankIdentityState("remote", "m", store.db).namespace).toBeNull();
  });

  test("an A→B→A sequence is NOT 'unchanged' — the attestation generation never returns (codex turn-37 SPEC-1)", async () => {
    const url = "http://rerank-a.test:8090";
    const store = attestedStore("behavioral:aaaa000000000000");
    const before = rerankIdentityState("remote", "m", store.db);
    writeRerankProviderFingerprint(store.db, url, "behavioral:bbbb000000000000");
    writeRerankProviderFingerprint(store.db, url, "behavioral:aaaa000000000000"); // back to A
    const after = rerankIdentityState("remote", "m", store.db);
    // The NAMESPACE legitimately returns (content-addressed cache reuse)...
    expect(after.namespace).toBe(before.namespace);
    // ...but the invocation-state TOKEN does not.
    expect(after.token).not.toBe(before.token);
  });

  test("an invocation scored across A→B→A is refused, not silently accepted", async () => {
    const url = "http://rerank-a.test:8090";
    const store = attestedStore("behavioral:aaaa000000000000");
    const docs = Array.from({ length: 6 }, (_, i) => ({ file: `d${i}`, text: `text ${i}` }));
    let batch = 0;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      batch++;
      if (batch === 2) {
        // Provider swapped to B and back to A between the batches — the
        // namespace ends where it started, which a namespace-derived token
        // reported as "unchanged" while the pool spanned two providers.
        writeRerankProviderFingerprint(store.db, url, "behavioral:bbbb000000000000");
        writeRerankProviderFingerprint(store.db, url, "behavioral:aaaa000000000000");
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
      return new Response(JSON.stringify({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: 0.5 })) }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(store.rerank("q", docs, "m", undefined, { requireLiveCoverage: true }))
      .rejects.toBeInstanceOf(RerankCoverageError);
    expect(batch).toBeGreaterThan(1);
  });

  test("the identity state is ONE snapshot — a write interleaved with the read cannot forge 'unchanged' (codex turn-38)", () => {
    const url = "http://rerank-a.test:8090";
    const store = attestedStore("behavioral:aaaa000000000000");
    const before = rerankIdentityState("remote", "m", store.db);

    // Fire a full A→B→A cycle at the instant the state query returns. With
    // separate reads for generation and fingerprint, a cycle landing between
    // them reconstructed the ORIGINAL token from an old generation and the
    // final-A fingerprint. From a single snapshot there is no such window.
    let fired = 0;
    _setRerankStateReadHook(() => {
      if (fired++ > 0) return;
      writeRerankProviderFingerprint(store.db, url, "behavioral:bbbb000000000000");
      writeRerankProviderFingerprint(store.db, url, "behavioral:aaaa000000000000");
    });
    try {
      const during = rerankIdentityState("remote", "m", store.db);
      // The snapshot predates the cycle, so this read still reports the OLD
      // token — it must NOT have absorbed the mutation into a fresh-looking
      // "unchanged" verdict...
      expect(during.token).toBe(before.token);
    } finally {
      _setRerankStateReadHook(null);
    }
    // ...and the very next read sees the cycle, so the guard fires.
    expect(rerankIdentityState("remote", "m", store.db).token).not.toBe(before.token);
  });

  test("a health probe (noCache) never writes the scores it is judging", async () => {
    const store = createStore(":memory:");
    writeRerankProviderFingerprint(store.db, "http://rerank-a.test:8090", "behavioral:5555555555555555");
    mockScore(0.5);
    await store.rerank("q", [{ file: "notes/a.md", text: "probe" }], "m", undefined, { noCache: true });
    expect(store.db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get()).toEqual({ n: 0 });
  });

  test("a healthy re-attestation INVALIDATES the old namespace even when the declared id never moves (codex turn-33 SPEC-2)", async () => {
    const store = createStore(":memory:");
    const url = "http://rerank-a.test:8090";
    const doc = [{ file: "notes/a.md", text: "declared id, swapped model" }];
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "v1";              // never changes
    writeRerankProviderFingerprint(store.db, url, "behavioral:aaaaaaaaaaaaaaaa");
    const c1 = mockScore(0.21);
    await store.rerank("q", doc, "m");
    expect(c1()).toBe(1);
    const c2 = mockScore(0.81);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.21, 5); // cached
    expect(c2()).toBe(0);

    // The URL now serves a DIFFERENT healthy model; rerank-health records the
    // new behavioral fingerprint while the operator's declared id is stale.
    // Pre-fix the declared id outranked the observation and the old scores
    // kept being served.
    writeRerankProviderFingerprint(store.db, url, "behavioral:bbbbbbbbbbbbbbbb");
    const c3 = mockScore(0.81);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.81, 5);
    expect(c3()).toBe(1);
  });

  test("expiry applies even WITH a declared id — no observed fingerprint means no remote cache", async () => {
    const store = createStore(":memory:");
    const url = "http://rerank-a.test:8090";
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "v1";
    // Never attested: a declared id alone is not an identity.
    expect(rerankProviderNamespace("remote", "m", store.db)).toBeNull();
    writeRerankProviderFingerprint(store.db, url, "behavioral:cccccccccccccccc");
    expect(rerankProviderNamespace("remote", "m", store.db)).toContain("#v1@behavioral:cccccccccccccccc");
    const stale = new Date(Date.now() - RERANK_PROVIDER_ATTESTATION_TTL_MS - 60_000).toISOString();
    store.db.prepare(`UPDATE vault_flags SET updated_at = ? WHERE flag = ?`).run(stale, `rerank_provider:${url}`);
    expect(rerankProviderNamespace("remote", "m", store.db)).toBeNull(); // expiry is universal
  });

  test("the COMMAND and CHECK workflows the CLI delegates to enforce remote-only and attest/revoke (codex turn-35 F1)", async () => {
    const { runRerankHealthWorkflow, runDoctorRerankCheck } = await import("../../src/health/rerank-health.ts");
    const url = "http://rerank-a.test:8090";
    const triples = [{ query: "q", relevant: "r", hardNegative: "n" }] as never;
    const seen: Record<string, unknown>[] = [];
    const mkStore = (scores: [number, number]) => {
      const st = createStore(":memory:");
      (st as unknown as { rerank: unknown }).rerank = async (
        _q: string, docs: { file: string; text: string }[], _m: string, _i: unknown, opts: Record<string, unknown>,
      ) => { seen.push(opts); return docs.map((d, i) => ({ file: d.file, score: scores[i] ?? 0 })); };
      return st;
    };

    // HEALTHY: the workflow probes remote-only AND attests the identity.
    const good = mkStore([0.9, 0.1]);
    const ok = await runRerankHealthWorkflow(good as never, { triples, rerankUrl: url });
    expect(seen[0]!.requireRemote).toBe(true);           // remote-only reached the store
    expect(ok.health.ok).toBe(true);
    expect(ok.attested).toBe(ok.health.fingerprint);
    expect(readRerankProviderFingerprint(good.db, url)).toBe(ok.attested);

    // DEGENERATE: the same workflow REVOKES instead of attesting.
    seen.length = 0;
    const bad = mkStore([0.5, 0.5]);                      // no discrimination
    writeRerankProviderFingerprint(bad.db, url, "behavioral:stale00000000000");
    const revoked = await runRerankHealthWorkflow(bad as never, { triples, rerankUrl: url });
    expect(revoked.health.ok).toBe(false);
    expect(revoked.revoked).toBe(true);
    expect(isRerankProviderRevoked(bad.db, url)).toBe(true);

    // The doctor CHECK workflow probes under the same policy and never attests.
    seen.length = 0;
    const doc = mkStore([0.9, 0.1]);
    await runDoctorRerankCheck(doc as never, { rerankUrl: url, triples } as never);
    expect(seen[0]!.requireRemote).toBe(true);
    expect(readRerankProviderFingerprint(doc.db, url)).toBeNull(); // doctor is read-only
  });

  test("the PRODUCTION policy function both callers use enforces remote-only (codex turn-34 F1)", async () => {
    // doctor and `clawmem rerank-health` both delegate to
    // probeConfiguredRerankHealth, so driving IT with a fake store locks the
    // policy at the production boundary without enabling local inference.
    const { probeConfiguredRerankHealth } = await import("../../src/health/rerank-health.ts");
    const seen: Record<string, unknown>[] = [];
    const fakeStore = {
      rerank: async (_q: string, docs: { file: string; text: string }[], _m: string, _i: unknown, opts: Record<string, unknown>) => {
        seen.push(opts);
        return docs.map((d, i) => ({ file: d.file, score: i === 0 ? 0.9 : 0.1 }));
      },
    };
    const triples = [{ query: "q", relevant: "r", hardNegative: "n" }] as never;
    await probeConfiguredRerankHealth(fakeStore as never, { triples, rerankUrl: "http://rerank.test:8090" });
    expect(seen[0]!.requireRemote).toBe(true);      // a configured remote ⇒ remote-only
    seen.length = 0;
    await probeConfiguredRerankHealth(fakeStore as never, { triples, rerankUrl: undefined });
    expect(seen[0]!.requireRemote).toBeUndefined(); // no remote ⇒ local-capable probe still works
  });

  test("probeRerankHealth FORWARDS requireRemote to the store (codex turn-33 F1)", async () => {
    const { probeRerankHealth } = await import("../../src/health/rerank-health.ts");
    const seen: Record<string, unknown>[] = [];
    const fakeStore = {
      rerank: async (_q: string, docs: { file: string; text: string }[], _m: string, _i: unknown, opts: Record<string, unknown>) => {
        seen.push(opts);
        return docs.map((d, i) => ({ file: d.file, score: i === 0 ? 0.9 : 0.1 }));
      },
    };
    await probeRerankHealth(fakeStore as never, { requireRemote: true, triples: [{ query: "q", relevant: "r", hardNegative: "n" }] as never });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.requireRemote).toBe(true);
    // ...and omitted when not asked for, so local-capable probes still work.
    seen.length = 0;
    await probeRerankHealth(fakeStore as never, { triples: [{ query: "q", relevant: "r", hardNegative: "n" }] as never });
    expect(seen[0]!.requireRemote).toBeUndefined();
  });

  test("CLAWMEM_RERANK_PROVIDER_ID declares a model swapped behind an UNCHANGED url", async () => {
    const store = attestedStore();
    const doc = [{ file: "notes/a.md", text: "same body, swapped model" }];
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "zerank-v1";
    const c1 = mockScore(0.31);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.31, 5);
    expect(c1()).toBe(1);

    // Same URL, same nominal model constant — only the operator's declared
    // provider identity changed, which is the ONLY hot-path-affordable signal
    // that the endpoint now serves something else.
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "zerank-v2";
    const c2 = mockScore(0.88);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.88, 5);
    expect(c2()).toBe(1);

    // Declaring the ORIGINAL provider again serves the original cached score.
    process.env.CLAWMEM_RERANK_PROVIDER_ID = "zerank-v1";
    const c3 = mockScore(0.99);
    expect((await store.rerank("q", doc, "m"))[0]!.score).toBeCloseTo(0.31, 5);
    expect(c3()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// assessRerankDegeneracy — the per-request gate's verdict function (BUILD-3d)
// ---------------------------------------------------------------------------
describe("assessRerankDegeneracy", () => {
  test("a discriminating mixed-pool set is not degenerate", () => {
    const r = assessRerankDegeneracy([0.92, 0.31, 0.12]);
    expect(r.degenerate).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.maxScore).toBeCloseTo(0.92, 10);
    expect(r.spread).toBeCloseTo(0.8, 10);
  });

  test("the documented broken-GGUF regime (every score <= 8.03e-7) is 'collapse'", () => {
    const r = assessRerankDegeneracy([8.03e-7, 4e-7, 1e-11]);
    expect(r.degenerate).toBe(true);
    expect(r.reason).toBe("collapse");
  });

  test("constant output is 'inert' (spread 0) even when the band is healthy", () => {
    const r = assessRerankDegeneracy([0.5, 0.5, 0.5, 0.5]);
    expect(r.degenerate).toBe(true);
    expect(r.reason).toBe("inert");
    expect(r.spread).toBe(0);
  });

  test("a homogeneous high pool below the spread floor is 'inert' — the DELIBERATE policy: a low-information ordering yields to the guard", () => {
    // 0.91..0.95: a healthy reranker judging genuinely-equivalent docs. The
    // gate discards the ordering (spread 0.04 < 0.05); every firing is
    // traced so the judged runs measure this rate rather than assume it.
    const r = assessRerankDegeneracy([0.95, 0.93, 0.91]);
    expect(r.degenerate).toBe(true);
    expect(r.reason).toBe("inert");
  });

  test("boundary: max exactly AT the calib floor passes the band; spread exactly AT the floor passes spread", () => {
    // max = 0.05 (not < floor), spread = 0.05 (not < floor) — both boundaries inclusive-pass.
    const r = assessRerankDegeneracy([0.05, 0.0]);
    expect(r.degenerate).toBe(false);
  });

  test("collapse is judged before spread — a sub-band set with spread is named 'collapse', not 'inert'", () => {
    const r = assessRerankDegeneracy([0.04, 0.001]);
    expect(r.reason).toBe("collapse");
  });

  test("fewer than two scores is inert by construction (an ordering over <2 candidates carries no information)", () => {
    expect(assessRerankDegeneracy([0.9]).reason).toBe("inert");
  });

  test("an empty set or any non-finite score is 'invalid' (fail-closed — cannot arise behind requireLiveCoverage)", () => {
    expect(assessRerankDegeneracy([]).reason).toBe("invalid");
    expect(assessRerankDegeneracy([0.9, NaN]).reason).toBe("invalid");
    expect(assessRerankDegeneracy([0.9, Infinity]).reason).toBe("invalid");
    expect(assessRerankDegeneracy([]).degenerate).toBe(true);
  });

  test("the floors PARTICIPATE (mutation check): overriding them flips the verdict on the same set", () => {
    const set = [0.5, 0.44, 0.42]; // spread 0.08 — passes the default 0.05 floor
    expect(assessRerankDegeneracy(set).degenerate).toBe(false);
    expect(assessRerankDegeneracy(set, { spreadFloor: 0.1 }).degenerate).toBe(true);
    expect(assessRerankDegeneracy(set, { spreadFloor: 0.1 }).reason).toBe("inert");
    expect(assessRerankDegeneracy(set, { calibFloor: 0.6 }).reason).toBe("collapse");
    // The verdict records the thresholds it judged under.
    expect(assessRerankDegeneracy(set).thresholds).toEqual({ calibFloor: RERANK_CALIB_FLOOR, spreadFloor: RERANK_REQUEST_SPREAD_FLOOR });
  });

  test("the request spread floor derives from the probe margin (DISCRIM_MARGIN / 5) and sits between the regimes", () => {
    expect(RERANK_REQUEST_SPREAD_FLOOR).toBeCloseTo(RERANK_DISCRIM_MARGIN / 5, 12);
    // Far above the degenerate regimes, below the labeled-pair margin.
    expect(RERANK_REQUEST_SPREAD_FLOOR).toBeGreaterThan(8.03e-7);
    expect(RERANK_REQUEST_SPREAD_FLOOR).toBeLessThan(RERANK_DISCRIM_MARGIN);
  });
});
