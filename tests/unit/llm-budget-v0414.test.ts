/**
 * v0.41.4 (BACKLOG 69.3) — the LLM layer's part of the observer fix (DESIGN-v0414.md r7 §4.1, §4.3, §4.4).
 *
 * Baseline (v0.41.3): `generateDetailed` had no way to carry a GBNF grammar, an HTTP failure did not say which status
 * the server answered (a grammar request's 400 cannot be told from a 500), nothing named the request's identity (root +
 * requested model) for the grammar-off record, and the local path could not pass a grammar to node-llama-cpp. Each test
 * here fails on v0.41.3 for the reason its name gives. The body without a grammar stays byte-identical
 * (`tests/unit/judge.test.ts` pins the bytes).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { LlamaCpp } from "../../src/llm.ts";

type Next = "stop" | "http400" | "http500" | "nochoice";
let next: Next;
let server: ReturnType<typeof Bun.serve>;
let chatBodies: Record<string, unknown>[];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  next = "stop";
  chatBodies = [];
  for (const k of ["CLAWMEM_NO_LOCAL_MODELS"]) savedEnv[k] = process.env[k];
  process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/chat/completions") {
        chatBodies.push(await req.json() as Record<string, unknown>);
        if (next === "http400") return Response.json({ error: { code: 400, message: "grammar parse failed", type: "invalid_request_error" } }, { status: 400 });
        if (next === "http500") return new Response("boom", { status: 500 });
        if (next === "nochoice") return Response.json({ choices: [], model: "qmd" });
        return Response.json({ choices: [{ message: { content: "<none/>" }, finish_reason: "stop" }], model: "qmd", usage: { prompt_tokens: 5, completion_tokens: 3 } });
      }
      return new Response("nf", { status: 404 });
    },
  });
});
afterEach(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const url = () => `http://127.0.0.1:${server.port}`;
const GRAMMAR = `root ::= "<none/>"`;

describe("v0.41.4 a grammar rides only the observer's request (§4.3)", () => {
  it("generateDetailed({ grammar }) adds the body's `grammar` field; without it the body has v0.41.3's fields only", async () => {
    const llm = new LlamaCpp({ remoteLlmUrl: url() });
    const backend = llm.activeLlmBackend()!;
    const r = await llm.generateDetailed("hi", { maxTokens: 50, backend, grammar: GRAMMAR } as any);
    expect(r.ok).toBe(true);
    expect(chatBodies[0]!.grammar).toBe(GRAMMAR);
    await llm.generateDetailed("hi", { maxTokens: 50, backend });
    expect(Object.keys(chatBodies[1]!).sort()).toEqual(["max_tokens", "messages", "model", "temperature"]);
  });
});

describe("v0.41.4 an HTTP failure says which status the server answered (§4.4)", () => {
  it("a non-oversize 400 → http + 400; a 500 → http + 500; a 200 without a completion → http + 200", async () => {
    const llm = new LlamaCpp({ remoteLlmUrl: url() });
    const backend = llm.activeLlmBackend()!;
    const silence = spyOn(console, "error").mockImplementation(() => {});
    try {
      next = "http400";
      expect(await llm.generateDetailed("x", { maxTokens: 10, backend })).toMatchObject({ ok: false, reason: "http", status: 400 });
      next = "http500";
      expect(await llm.generateDetailed("x", { maxTokens: 10, backend })).toMatchObject({ ok: false, reason: "http", status: 500 });
      next = "nochoice";
      expect(await llm.generateDetailed("x", { maxTokens: 10, backend })).toMatchObject({ ok: false, reason: "http", status: 200 });
    } finally {
      silence.mockRestore();
    }
  });
});

describe("v0.41.4 the grammar-off record's request identity (§4.4)", () => {
  it("names the server root and the requested model: another model at the same root is another identity", async () => {
    const a = new LlamaCpp({ remoteLlmUrl: url(), remoteLlmModel: "qmd" });
    const b = new LlamaCpp({ remoteLlmUrl: url(), remoteLlmModel: "qwen3-4b" });
    const a2 = new LlamaCpp({ remoteLlmUrl: url(), remoteLlmModel: "qmd" });
    expect(typeof (a as any).requestIdentity).toBe("function");
    const id = (l: LlamaCpp) => (l as any).requestIdentity(l.activeLlmBackend()!) as string;
    expect(id(a)).toBe(id(a2));
    expect(id(a)).not.toBe(id(b));
    expect(id(a)).toContain(url());
  });
});

describe("v0.41.4 the local path passes the grammar to node-llama-cpp (§4.1)", () => {
  it("promptWithMeta gets a LlamaGrammar compiled from the GBNF; without a grammar it gets none", async () => {
    const llm = new LlamaCpp({});
    expect(typeof (llm as any).localChatSession).toBe("function");
    const backend = { kind: "local" as const, modelPath: "fake.gguf" };
    const compiled: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const spies = [
      spyOn(llm as any, "isBackendAvailable").mockImplementation(() => true),
      spyOn(llm as any, "ensureGenerateModel").mockImplementation(async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      })),
      spyOn(llm as any, "localFitContextSize").mockImplementation(async () => 4096),
      spyOn(llm as any, "ensureLlama").mockImplementation(async () => ({
        createGrammar: async (o: { grammar: string }) => { compiled.push(o.grammar); return { gbnf: o.grammar }; },
      })),
      spyOn(llm as any, "localChatSession").mockImplementation(async () => ({
        promptWithMeta: async (_p: string, o: Record<string, unknown>) => { seen.push(o); return { responseText: "<none/>", stopReason: "eogToken" }; },
      })),
    ];
    try {
      const r = await llm.generateDetailed("p", { maxTokens: 20, backend, grammar: GRAMMAR } as any);
      expect(r).toMatchObject({ ok: true, text: "<none/>", finish: "stop" });
      expect(compiled).toEqual([GRAMMAR]);
      expect(seen[0]!.grammar).toEqual({ gbnf: GRAMMAR });
      await llm.generateDetailed("p", { maxTokens: 20, backend });
      expect(seen[1]!.grammar).toBeUndefined();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("a grammar the in-process model cannot compile fails the call (grammar_rejected) — never an unconstrained reply — and is compiled afresh next time (codex T7-7)", async () => {
    const llm = new LlamaCpp({});
    const backend = { kind: "local" as const, modelPath: "fake.gguf" };
    const seen: Record<string, unknown>[] = [];
    let compiles = 0;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const spies = [
      spyOn(llm as any, "isBackendAvailable").mockImplementation(() => true),
      spyOn(llm as any, "ensureGenerateModel").mockImplementation(async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      })),
      spyOn(llm as any, "localFitContextSize").mockImplementation(async () => 4096),
      spyOn(llm as any, "ensureLlama").mockImplementation(async () => ({
        createGrammar: async () => { compiles++; throw new Error("Failed to parse grammar"); },
      })),
      spyOn(llm as any, "localChatSession").mockImplementation(async () => ({
        promptWithMeta: async (_p: string, o: Record<string, unknown>) => { seen.push(o); return { responseText: "<none/>", stopReason: "eogToken" }; },
      })),
    ];
    try {
      for (let i = 0; i < 2; i++) {
        expect(await llm.generateDetailed("p", { maxTokens: 20, backend, grammar: GRAMMAR } as any)).toMatchObject({ ok: false, reason: "grammar_rejected" });
      }
      expect(seen.length).toBe(0);              // no generation ran: the observer retries grammarless, counted (§4.4)
      expect(compiles).toBe(2);                 // no process-wide memory: the observer's grammar-off record decides when to try again
    } finally {
      for (const s of spies) s.mockRestore();
      warn.mockRestore();
    }
  });
});
