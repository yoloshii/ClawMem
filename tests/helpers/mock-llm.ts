/**
 * Mock LLM for tests — satisfies the LLM interface without GPU.
 */
import { mock } from "bun:test";
import type {
  LLM,
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  Queryable,
  RerankDocument,
  RerankOptions,
  RerankResult,
} from "../../src/llm.ts";

/**
 * Deterministic 768-dim embedding from text hash.
 * Same input always produces the same embedding.
 */
function hashEmbed(text: string): number[] {
  const dims = 768;
  const embedding = new Array<number>(dims);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dims; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    embedding[i] = ((hash & 0xffff) / 0xffff) * 2 - 1; // [-1, 1]
  }
  return embedding;
}

export interface MockLLM extends LLM {
  embed: ReturnType<typeof mock>;
  generate: ReturnType<typeof mock>;
  rerank: ReturnType<typeof mock>;
  expandQuery: ReturnType<typeof mock>;
  modelExists: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
}

export function createMockLLM(): MockLLM {
  const llm: MockLLM = {
    embed: mock(async (text: string, _opts?: EmbedOptions): Promise<EmbeddingResult | null> => {
      return { embedding: hashEmbed(text), model: "mock-embed" };
    }),

    generate: mock(async (_prompt: string, _opts?: GenerateOptions): Promise<GenerateResult | null> => {
      return { text: "WHAT", model: "mock-llm", done: true };
    }),

    rerank: mock(async (_query: string, documents: RerankDocument[], _opts?: RerankOptions): Promise<RerankResult> => {
      return {
        results: documents.map((d, i) => ({
          file: d.file,
          score: 1.0 - i * 0.1,
          index: i,
        })),
        model: "mock-rerank",
      };
    }),

    expandQuery: mock(async (query: string, _opts?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> => {
      return [
        { type: "lex", text: query },
        { type: "vec", text: query },
      ];
    }),

    modelExists: mock(async (_model: string): Promise<ModelInfo> => {
      return { name: "mock", exists: true };
    }),

    dispose: mock(async (): Promise<void> => {}),
  };

  return llm;
}
