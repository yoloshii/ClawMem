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
});
