import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

/**
 * Tests for LLM remote fallback behavior:
 * - Transport errors trigger cooldown + local fallback
 * - HTTP errors do NOT trigger cooldown
 * - AbortError does NOT trigger cooldown
 * - Cooldown expires and retries remote
 * - NO_LOCAL_MODELS blocks fallback
 *
 * We test the LlamaCpp class directly by constructing it with remote URLs
 * and mocking global fetch. Local fallback paths are tested by checking
 * that the correct code path is entered (they'll fail at model download
 * since CLAWMEM_NO_LOCAL_MODELS=true, but that's expected).
 */

// Access internals via the class — we need the private helpers
// Since these are private, we test them via the public API behavior

import { LlamaCpp, type LlamaCppConfig } from "../../src/llm.ts";

function createLlm(overrides: Partial<LlamaCppConfig> = {}): LlamaCpp {
  return new LlamaCpp({
    remoteLlmUrl: "http://localhost:8089",
    remoteEmbedUrl: "http://localhost:8088",
    ...overrides,
  });
}

// Save/restore fetch
const originalFetch = globalThis.fetch;

describe("LLM Remote Fallback", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLAWMEM_NO_LOCAL_MODELS;
  });

  // ─── generateRemote failure classification ─────────────────────────

  describe("generate() failure classification", () => {
    it("transport error (ECONNREFUSED) triggers cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:8089");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      const result = await llm.generate("test prompt");
      // With NO_LOCAL_MODELS=true, should return null (no fallback available)
      expect(result).toBeNull();

      // Second call should skip remote entirely (cooldown active)
      let fetchCalled = false;
      globalThis.fetch = (() => { fetchCalled = true; return new Response("ok"); }) as any;
      await llm.generate("test prompt 2");
      expect(fetchCalled).toBe(false); // Remote skipped due to cooldown
    });

    it("HTTP 400 does NOT trigger cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() =>
        Promise.resolve(new Response("Bad Request", { status: 400 }))
      ) as any;

      const result = await llm.generate("test prompt");
      expect(result).toBeNull();

      // Second call should still try remote (no cooldown set)
      let fetchCalled = false;
      globalThis.fetch = (() => {
        fetchCalled = true;
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "response" } }],
        }), { status: 200 }));
      }) as any;

      const result2 = await llm.generate("test prompt 2");
      expect(fetchCalled).toBe(true); // Remote was retried
      expect(result2?.text).toBe("response");
    });

    it("HTTP 500 does NOT trigger cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 }))
      ) as any;

      await llm.generate("test prompt");

      // Should still try remote next time
      let fetchCalled = false;
      globalThis.fetch = (() => {
        fetchCalled = true;
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }), { status: 200 }));
      }) as any;

      await llm.generate("second call");
      expect(fetchCalled).toBe(true);
    });

    it("reachable HTTP errors do not fall through to local generation", async () => {
      const llm = createLlm();
      const ensureGenerateModel = spyOn(llm as any, "ensureGenerateModel").mockImplementation(
        () => {
          throw new Error("should not fall through to local generation");
        }
      );

      globalThis.fetch = (() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 }))
      ) as any;

      const result = await llm.generate("test prompt");
      expect(result).toBeNull();
      expect(ensureGenerateModel).not.toHaveBeenCalled();
      ensureGenerateModel.mockRestore();
    });

    it("transport cooldown still logs once in remote-only mode", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      await llm.generate("test prompt");
      await llm.generate("test prompt 2");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("cooldown 60s");
      warnSpy.mockRestore();
    });
    it("AbortError does NOT trigger cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() => {
        throw new DOMException("The operation was aborted", "AbortError");
      }) as any;

      const result = await llm.generate("test prompt");
      expect(result).toBeNull();

      // Next call should still try remote
      let fetchCalled = false;
      globalThis.fetch = (() => {
        fetchCalled = true;
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }), { status: 200 }));
      }) as any;

      await llm.generate("second call");
      expect(fetchCalled).toBe(true);
    });

    it("successful remote call works normally", async () => {
      const llm = createLlm();

      globalThis.fetch = (() =>
        Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "generated text" } }],
          model: "qwen3",
        }), { status: 200 }))
      ) as any;

      const result = await llm.generate("test prompt");
      expect(result).toBeDefined();
      expect(result!.text).toBe("generated text");
      expect(result!.done).toBe(true);
    });
  });

  // ─── Cooldown expiry ───────────────────────────────────────────────

  describe("cooldown expiry", () => {
    it("retries remote after cooldown expires", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      // Trigger transport error
      globalThis.fetch = (() => {
        const err = new Error("connect ETIMEDOUT");
        (err as any).code = "ETIMEDOUT";
        throw err;
      }) as any;

      await llm.generate("test");

      // Manually expire the cooldown by setting it to the past
      // Access private field — TypeScript won't let us, but JS will
      (llm as any).remoteLlmDownUntil = Date.now() - 1;

      // Now remote should be retried
      let fetchCalled = false;
      globalThis.fetch = (() => {
        fetchCalled = true;
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "back up" } }],
        }), { status: 200 }));
      }) as any;

      const result = await llm.generate("test after cooldown");
      expect(fetchCalled).toBe(true);
      expect(result?.text).toBe("back up");
    });
  });

  // ─── NO_LOCAL_MODELS guard ─────────────────────────────────────────

  describe("CLAWMEM_NO_LOCAL_MODELS guard", () => {
    it("generate returns null when remote down and NO_LOCAL_MODELS=true", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      const result = await llm.generate("test");
      expect(result).toBeNull();
    });

    it("embed returns null when remote down and NO_LOCAL_MODELS=true", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      const result = await llm.embed("test text");
      expect(result).toBeNull();
    });

    it("embedBatch returns nulls when remote down and NO_LOCAL_MODELS=true", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      const results = await llm.embedBatch(["a", "b", "c"]);
      expect(results).toEqual([null, null, null]);
    });

    it("expandQuery returns passthrough on first transport failure when NO_LOCAL_MODELS=true", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      // First call: transport error in generateRemote sets cooldown,
      // expandQuery detects cooldown was set, falls through to NO_LOCAL_MODELS guard
      const result = await llm.expandQuery("test query");
      // Should get passthrough (lex + vec of original query)
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.some(q => q.text === "test query")).toBe(true);
    });

    it("expandQuery skips remote on second call during cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      // Trigger transport error to set cooldown
      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      await llm.expandQuery("test query");

      // Second call should skip remote entirely (cooldown active)
      let fetchCalled = false;
      globalThis.fetch = (() => { fetchCalled = true; }) as any;

      const result = await llm.expandQuery("test query 2");
      expect(fetchCalled).toBe(false);
      expect(result.some(q => q.text === "test query 2")).toBe(true);
    });
  });

  // ─── Embed failure classification ──────────────────────────────────

  describe("embed() failure classification", () => {
    it("transport error triggers embed cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() => {
        const err = new Error("connect ECONNREFUSED");
        (err as any).code = "ECONNREFUSED";
        throw err;
      }) as any;

      await llm.embed("test");

      // Verify cooldown is active — next call should skip fetch
      let fetchCalled = false;
      globalThis.fetch = (() => { fetchCalled = true; }) as any;

      await llm.embed("test 2");
      expect(fetchCalled).toBe(false);
    });

    it("HTTP error does NOT trigger embed cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = (() =>
        Promise.resolve(new Response("Bad Request", { status: 400 }))
      ) as any;

      await llm.embed("test");

      // Next call should still try remote
      let fetchCalled = false;
      globalThis.fetch = (() => {
        fetchCalled = true;
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ embedding: [0.1, 0.2] }],
        }), { status: 200 }));
      }) as any;

      const result = await llm.embed("test 2");
      expect(fetchCalled).toBe(true);
    });

    it("reachable HTTP embed errors do not fall through to local embedding", async () => {
      const llm = createLlm();

      const embedLocalSpy = spyOn(llm as any, "embedLocal").mockImplementation(async () => {
        throw new Error("should not fall through to local embedding");
      });
      const embedLocalBatchSpy = spyOn(llm as any, "embedLocalBatch").mockImplementation(async () => {
        throw new Error("should not fall through to local batch embedding");
      });

      globalThis.fetch = (() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 }))
      ) as any;

      try {
        const single = await llm.embed("test");
        expect(single).toBeNull();
        expect(embedLocalSpy).not.toHaveBeenCalled();

        const batch = await llm.embedBatch(["a", "b"]);
        expect(batch).toEqual([null, null]);
        expect(embedLocalBatchSpy).not.toHaveBeenCalled();
      } finally {
        embedLocalSpy.mockRestore();
        embedLocalBatchSpy.mockRestore();
      }
    });
  });

  // ─── Cross-service isolation ───────────────────────────────────────

  describe("cross-service isolation", () => {
    it("LLM cooldown does not affect embed", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      // Trigger LLM transport error
      globalThis.fetch = ((url: string) => {
        if (url.includes("/v1/chat/completions")) {
          const err = new Error("connect ECONNREFUSED");
          (err as any).code = "ECONNREFUSED";
          throw err;
        }
        // Embed calls should succeed
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ embedding: [0.1, 0.2] }],
        }), { status: 200 }));
      }) as any;

      await llm.generate("test");

      // Embed should still try remote (different cooldown) — same fetch mock handles both
      const result = await llm.embed("test");
      expect(result).toBeDefined();
      expect(result!.embedding).toEqual([0.1, 0.2]);
    });

    it("embed cooldown does not affect LLM", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      // Trigger embed transport error
      globalThis.fetch = ((url: string) => {
        if (url.includes("/v1/embeddings")) {
          const err = new Error("connect ECONNREFUSED");
          (err as any).code = "ECONNREFUSED";
          throw err;
        }
        // LLM calls should succeed
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }), { status: 200 }));
      }) as any;

      await llm.embed("test");

      // LLM should still try remote (different cooldown)
      const result = await llm.generate("test");
      expect(result?.text).toBe("ok");
    });
  });

  // ─── B4: embed() honors AbortSignal across fetch + 429 backoff ─────────
  describe("embed() honors AbortSignal (B4)", () => {
    it("aborts during the 429 retry backoff instead of sleeping through all retries", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      let fetchCount = 0;
      // Always 429 → embedRemote enters exponential backoff (1s, 2s, 4s, 8s, 16s).
      // The abortable backoff must cut this off when the caller's signal fires.
      globalThis.fetch = (() => {
        fetchCount++;
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }) as any;

      const t0 = Date.now();
      const result = await llm.embed("some query text", { signal: AbortSignal.timeout(150) });
      const elapsed = Date.now() - t0;

      expect(result).toBeNull();
      // Bug-first: the abortable backoff must bail DURING the sleep (~150ms),
      // not after it. Without it, the non-abortable first backoff is >=750ms
      // (jitter of 1000ms) before the top-of-loop abort check can bail on the
      // next attempt — and a late abort would wait out a backoff up to 16s.
      // 500ms cleanly separates the two: abortable ~150ms vs non-abortable
      // >=750ms.
      expect(elapsed).toBeLessThan(500);
      expect(fetchCount).toBeGreaterThanOrEqual(1);
    }, 10000);

    it("aborts a hung fetch via the threaded signal (returns null, does not hang)", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      // A fetch that ONLY settles when its abort signal fires. Bug-first: if the
      // signal is not threaded into the fetch call, opts.signal is undefined and
      // this never resolves — the embed hangs and the test times out.
      globalThis.fetch = ((_url: any, opts: any) =>
        new Promise((_resolve, reject) => {
          const s: AbortSignal | undefined = opts?.signal;
          if (!s) return; // no signal threaded → hang forever (the bug)
          if (s.aborted) return reject(s.reason ?? new DOMException("aborted", "AbortError"));
          s.addEventListener("abort", () => reject(s.reason ?? new DOMException("aborted", "AbortError")), { once: true });
        })) as any;

      const t0 = Date.now();
      const result = await llm.embed("some query text", { signal: AbortSignal.timeout(150) });
      const elapsed = Date.now() - t0;

      expect(result).toBeNull();
      expect(elapsed).toBeLessThan(900); // aborted at ~150ms, did not hang
    }, 10000);

    it("an aborted embed does NOT trip the remote-down cooldown", async () => {
      const llm = createLlm();
      process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

      globalThis.fetch = ((_url: any, opts: any) =>
        new Promise((_resolve, reject) => {
          const s: AbortSignal | undefined = opts?.signal;
          if (!s) return;
          if (s.aborted) return reject(s.reason ?? new DOMException("aborted", "AbortError"));
          s.addEventListener("abort", () => reject(s.reason ?? new DOMException("aborted", "AbortError")), { once: true });
        })) as any;

      await llm.embed("q", { signal: AbortSignal.timeout(100) });

      // If the abort had been misclassified as a transport failure, the 60s
      // cooldown would skip remote on the next call. It must still try remote.
      let fetchCalled = false;
      globalThis.fetch = (() => {
        fetchCalled = true;
        return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }));
      }) as any;
      const next = await llm.embed("q2");
      expect(fetchCalled).toBe(true);
      expect(next?.embedding).toEqual([0.1, 0.2]);
    }, 10000);

    it("skips the LOCAL embed fallback when a deadline signal is set (remote in cooldown) — Medium fix", async () => {
      const llm = createLlm();
      // NB: NO CLAWMEM_NO_LOCAL_MODELS — local fallback WOULD normally run.
      const embedLocalSpy = spyOn(llm as any, "embedLocal").mockResolvedValue({ embedding: [9, 9], model: "local" });

      // Drive the remote embed into cooldown via a transport error (no signal).
      globalThis.fetch = (() => {
        const e = new Error("connect ECONNREFUSED 127.0.0.1:8088");
        (e as any).code = "ECONNREFUSED";
        throw e;
      }) as any;
      await llm.embed("warm"); // remote now marked down; this call DID fall to local
      expect(embedLocalSpy).toHaveBeenCalled();
      embedLocalSpy.mockClear();

      // Now embed WITH a deadline signal while remote is in cooldown. Bug-first:
      // without the fix, embed() falls through to embedLocal (which ignores the
      // signal and can load/download a model past the deadline). With the fix,
      // a signal suppresses the local fallback → returns null → caller degrades.
      const result = await llm.embed("q", { signal: AbortSignal.timeout(1000) });
      expect(result).toBeNull();
      expect(embedLocalSpy).not.toHaveBeenCalled();
    }, 10000);
  });
});
