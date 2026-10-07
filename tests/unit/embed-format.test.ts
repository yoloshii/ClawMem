import { describe, it, expect, afterEach } from "bun:test";
import { formatQueryForEmbedding, formatDocForEmbedding, embedFormat } from "../../src/llm.ts";

const saved = process.env.CLAWMEM_EMBED_FORMAT;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAWMEM_EMBED_FORMAT;
  else process.env.CLAWMEM_EMBED_FORMAT = saved;
});

describe("CLAWMEM_EMBED_FORMAT", () => {
  it("defaults to the EmbeddingGemma prefixes (unchanged behaviour)", () => {
    delete process.env.CLAWMEM_EMBED_FORMAT;
    expect(embedFormat()).toBe("gemma");
    expect(formatQueryForEmbedding("q")).toBe("task: search result | query: q");
    expect(formatDocForEmbedding("t")).toBe("title: none | text: t");
    expect(formatDocForEmbedding("t", "T")).toBe("title: T | text: t");
  });
  it("qwen3 puts the instruction on the query side only", () => {
    process.env.CLAWMEM_EMBED_FORMAT = "Qwen3";
    expect(formatQueryForEmbedding("嵌入模型")).toMatch(/^Instruct: .+\nQuery: 嵌入模型$/);
    expect(formatDocForEmbedding("正文")).toBe("正文");
    expect(formatDocForEmbedding("正文", "标题")).toBe("标题\n正文");
  });
  it("plain wraps nothing", () => {
    process.env.CLAWMEM_EMBED_FORMAT = "plain";
    expect(formatQueryForEmbedding("q")).toBe("q");
    expect(formatDocForEmbedding("t", "none")).toBe("t");
  });
  it("unknown values fall back to gemma", () => {
    process.env.CLAWMEM_EMBED_FORMAT = "bogus";
    expect(embedFormat()).toBe("gemma");
  });
});
