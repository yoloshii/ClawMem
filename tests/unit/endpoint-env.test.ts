import { describe, it, expect } from "bun:test";
import { normalizeEndpointRoot, normalizeEndpointEnv } from "../../src/endpoint-env.ts";

describe("normalizeEndpointRoot", () => {
  const embed = ["/v1/embeddings", "/v1"];
  it("keeps a bare root", () => {
    expect(normalizeEndpointRoot("http://localhost:11434", embed)).toBe("http://localhost:11434");
  });
  it("strips trailing slashes", () => {
    expect(normalizeEndpointRoot("http://localhost:8088///", embed)).toBe("http://localhost:8088");
  });
  it("strips a pasted /v1/embeddings path", () => {
    expect(normalizeEndpointRoot("http://localhost:11434/v1/embeddings", embed)).toBe("http://localhost:11434");
  });
  it("strips /v1 (cloud bases)", () => {
    expect(normalizeEndpointRoot("https://api.jina.ai/v1/", embed)).toBe("https://api.jina.ai");
  });
  it("is case-insensitive on the suffix and keeps the host case", () => {
    expect(normalizeEndpointRoot("http://Host:1/V1/Embeddings", embed)).toBe("http://Host:1");
  });
  it("keeps a gateway sub-path", () => {
    expect(normalizeEndpointRoot("https://gw.example.com/openai/v1", embed)).toBe("https://gw.example.com/openai");
  });
});

describe("normalizeEndpointEnv", () => {
  it("rewrites only the endpoint vars and reports each rewrite", () => {
    const env: Record<string, string | undefined> = {
      CLAWMEM_EMBED_URL: "http://127.0.0.1:8005/v1/embeddings",
      CLAWMEM_RERANK_URL: "http://127.0.0.1:8005/v1/rerank",
      CLAWMEM_LLM_URL: "http://127.0.0.1:8005/v1/chat/completions",
    };
    const notes = normalizeEndpointEnv(env);
    expect(env.CLAWMEM_EMBED_URL).toBe("http://127.0.0.1:8005");
    expect(env.CLAWMEM_RERANK_URL).toBe("http://127.0.0.1:8005");
    expect(env.CLAWMEM_LLM_URL).toBe("http://127.0.0.1:8005/v1/chat/completions");
    expect(notes.length).toBe(2);
  });
  it("is idempotent and silent for roots", () => {
    const env: Record<string, string | undefined> = { CLAWMEM_EMBED_URL: "http://localhost:8088" };
    expect(normalizeEndpointEnv(env)).toEqual([]);
    expect(env.CLAWMEM_EMBED_URL).toBe("http://localhost:8088");
  });
});
