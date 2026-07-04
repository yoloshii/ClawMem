import { afterEach, describe, expect, it } from "bun:test";

import {
  disposeDefaultLlamaCpp,
  getDefaultLlamaCpp,
  LlamaCpp,
  setDefaultLlamaCpp,
} from "../../src/llm.ts";

const originalFetch = globalThis.fetch;

describe("remote LLM model selection", () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.CLAWMEM_LLM_URL;
    delete process.env.CLAWMEM_LLM_MODEL;
    delete process.env.CLAWMEM_LLM_NO_THINK;
    delete process.env.CLAWMEM_LLM_REASONING_EFFORT;
    await disposeDefaultLlamaCpp();
    setDefaultLlamaCpp(null);
  });

  it("defaults remote chat completions to qwen3 when no model override is set", async () => {
    let seenBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({ remoteLlmUrl: "http://localhost:8089" });
    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("qwen3");
    expect((seenBody?.messages as { content: string }[])[0]?.content).toContain("/no_think");
  });

  it("uses remoteLlmModel when the override is configured on the instance", async () => {
    let seenBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "http://localhost:8089",
      remoteLlmModel: "gpt-5.4-mini",
    });

    const result = await llm.generate("test prompt");
    expect(seenBody?.model).toBe("gpt-5.4-mini");
    expect(result?.model).toBe("gpt-5.4-mini");
  });

  it("normalizes remoteLlmUrl when it already includes a /v1 suffix", async () => {
    let seenUrl: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      const seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "https://api.example.com/v1/",
      remoteLlmModel: "gpt-5.4-mini",
    });

    await llm.generate("test prompt");

    expect(seenUrl).toBe("https://api.example.com/v1/chat/completions");
  });

  it("passes a full /chat/completions URL through without appending /v1", async () => {
    let seenUrl: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      const seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "https://api.z.ai/api/paas/v4/chat/completions",
      remoteLlmModel: "glm-4.5-flash",
    });

    await llm.generate("test prompt");

    expect(seenUrl).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });

  it("strips a trailing slash before the /chat/completions passthrough", async () => {
    let seenUrl: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      const seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "https://api.z.ai/api/paas/v4/chat/completions/",
      remoteLlmModel: "glm-4.5-flash",
    });

    await llm.generate("test prompt");

    expect(seenUrl).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });

  it("uses CLAWMEM_LLM_MODEL when bootstrapping the default LLM instance from env", async () => {
    let seenBody: Record<string, unknown> | undefined;
    process.env.CLAWMEM_LLM_URL = "http://localhost:8089";
    process.env.CLAWMEM_LLM_MODEL = "gpt-5.4-mini";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("gpt-5.4-mini");
  });

  it("trims CLAWMEM_LLM_MODEL when bootstrapping the default LLM instance from env", async () => {
    let seenBody: Record<string, unknown> | undefined;
    process.env.CLAWMEM_LLM_URL = "http://localhost:8089";
    process.env.CLAWMEM_LLM_MODEL = "  gpt-5.4-mini  ";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("gpt-5.4-mini");
  });

  it("trims remoteLlmModel when the override is configured on the instance", async () => {
    let seenBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "http://localhost:8089",
      remoteLlmModel: "  gpt-5.4-mini  ",
    });

    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("gpt-5.4-mini");
  });

  it("omits /no_think when CLAWMEM_LLM_NO_THINK disables it", async () => {
    let seenBody: Record<string, unknown> | undefined;
    process.env.CLAWMEM_LLM_URL = "http://localhost:8089";
    process.env.CLAWMEM_LLM_MODEL = "gpt-5.4-mini";
    process.env.CLAWMEM_LLM_NO_THINK = "false";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("gpt-5.4-mini");
    expect((seenBody?.messages as { content: string }[])[0]?.content).toBe("test prompt");
  });

  it("sends top-level reasoning_effort only when CLAWMEM_LLM_REASONING_EFFORT is configured", async () => {
    let seenBody: Record<string, unknown> | undefined;
    process.env.CLAWMEM_LLM_URL = "http://localhost:8089";
    process.env.CLAWMEM_LLM_MODEL = "gpt-5.4-mini";
    process.env.CLAWMEM_LLM_REASONING_EFFORT = "minimal";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("gpt-5.4-mini");
    expect(seenBody?.reasoning_effort).toBe("minimal");
    expect(seenBody?.reasoning).toBeUndefined();
  });

  it("accepts 'none' as a reasoning effort override", async () => {
    let seenBody: Record<string, unknown> | undefined;
    process.env.CLAWMEM_LLM_URL = "http://localhost:8089";
    process.env.CLAWMEM_LLM_MODEL = "gpt-5.4-mini";
    process.env.CLAWMEM_LLM_REASONING_EFFORT = "none";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("gpt-5.4-mini");
    expect(seenBody?.reasoning_effort).toBe("none");
  });

  it("accepts 'xhigh' as a reasoning effort override", async () => {
    let seenBody: Record<string, unknown> | undefined;
    process.env.CLAWMEM_LLM_URL = "http://localhost:8089";
    process.env.CLAWMEM_LLM_MODEL = "gpt-5.4-mini";
    process.env.CLAWMEM_LLM_REASONING_EFFORT = "xhigh";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");

    expect(seenBody?.model).toBe("gpt-5.4-mini");
    expect(seenBody?.reasoning_effort).toBe("xhigh");
  });

  it("normalizes and validates instance-level remoteLlmReasoningEffort overrides", async () => {
    let seenBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "http://localhost:8089",
      remoteLlmModel: "gpt-5.4-mini",
      remoteLlmReasoningEffort: "  HIGH  ",
    });
    await llm.generate("test prompt");
    expect(seenBody?.reasoning_effort).toBe("high");

    seenBody = undefined;
    const nextLlm = new LlamaCpp({
      remoteLlmUrl: "http://localhost:8089",
      remoteLlmModel: "gpt-5.4-mini",
      remoteLlmReasoningEffort: "unsupported-tier",
    });
    await nextLlm.generate("test prompt");
    expect(seenBody?.reasoning_effort).toBeUndefined();
  });

  it("normalizes and validates CLAWMEM_LLM_REASONING_EFFORT before sending it", async () => {
    let seenBody: Record<string, unknown> | undefined;
    process.env.CLAWMEM_LLM_URL = "http://localhost:8089";
    process.env.CLAWMEM_LLM_MODEL = "gpt-5.4-mini";
    process.env.CLAWMEM_LLM_REASONING_EFFORT = "  LOW  ";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        model: seenBody.model,
      }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");
    expect(seenBody?.reasoning_effort).toBe("low");

    seenBody = undefined;
    process.env.CLAWMEM_LLM_REASONING_EFFORT = "unsupported-tier";
    await disposeDefaultLlamaCpp();
    setDefaultLlamaCpp(null);

    const nextLlm = getDefaultLlamaCpp();
    await nextLlm.generate("test prompt");
    expect(seenBody?.reasoning_effort).toBeUndefined();
  });
});

describe("remote LLM auth header", () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.CLAWMEM_LLM_URL;
    delete process.env.CLAWMEM_LLM_API_KEY;
    await disposeDefaultLlamaCpp();
    setDefaultLlamaCpp(null);
  });

  it("sends Authorization: Bearer when remoteLlmApiKey is configured on the instance", async () => {
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "https://api.example.com/v1",
      remoteLlmApiKey: "test-llm-key",
    });
    await llm.generate("test prompt");

    expect(seenHeaders?.["Authorization"]).toBe("Bearer test-llm-key");
    expect(seenHeaders?.["Content-Type"]).toBe("application/json");
  });

  it("omits Authorization when no remoteLlmApiKey is set (backward compatible)", async () => {
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({ remoteLlmUrl: "http://localhost:8089" });
    await llm.generate("test prompt");

    expect(seenHeaders?.["Authorization"]).toBeUndefined();
    expect(seenHeaders?.["Content-Type"]).toBe("application/json");
  });

  it("reads CLAWMEM_LLM_API_KEY when bootstrapping the default LLM instance from env", async () => {
    let seenHeaders: Record<string, string> | undefined;
    process.env.CLAWMEM_LLM_URL = "https://api.example.com/v1";
    process.env.CLAWMEM_LLM_API_KEY = "env-llm-key";

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;

    const llm = getDefaultLlamaCpp();
    await llm.generate("test prompt");

    expect(seenHeaders?.["Authorization"]).toBe("Bearer env-llm-key");
  });

  it("carries the LLM key on generate, never the embed key (keys are independent)", async () => {
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;

    const llm = new LlamaCpp({
      remoteLlmUrl: "https://llm.example.com/v1",
      remoteLlmApiKey: "llm-only-key",
      remoteEmbedUrl: "https://embed.example.com",
      remoteEmbedApiKey: "embed-only-key",
    });
    await llm.generate("test prompt");

    expect(seenHeaders?.["Authorization"]).toBe("Bearer llm-only-key");
  });
});
