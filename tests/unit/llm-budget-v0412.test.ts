/**
 * v0.41.2 (BACKLOG 68.5) — the LLM layer's token budget against a fake llama.cpp server (DESIGN-v0412.md §1.2; tests T5,
 * T8, T9, T12, T20). The fake serves the shapes measured on the deployed build (E2–E4, E9–E11): `/props` with the slot
 * context, `/apply-template`, `/tokenize`, chat completions with `finish_reason` + `usage`, and the 400
 * `exceed_context_size_error` body.
 *
 * Baseline (v0.41.1): `generateRemote` dropped `finish_reason` and `usage`, nothing read the server's context, and an
 * oversize 400 struck the HTTP-error streak like a broken endpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LlamaCpp, remoteLlmRoot, estimateTokens, type OverheadStore } from "../../src/llm.ts";
import { monoNow, deadlineAfter, duration, setWallJumpForTest } from "../../src/clock.ts";
import { extractObservationsWindowed } from "../../src/observer.ts";
import type { TranscriptMessage } from "../../src/hooks.ts";

/** Exports added after codex T12, read through the namespace so a missing one fails its own test, not the file. */
const llmModule = () => import("../../src/llm.ts") as Promise<Record<string, any>>;

/** Characters → tokens on the fake server: 1 per 3 characters, rounded up. */
const tok = (s: string) => Math.ceil(s.length / 3);
const TEMPLATE = (content: string) => `<|im_start|>user\n${content}<|im_end|>\n<|im_start|>assistant\n`;

type Behaviour = {
  props: boolean; applyTemplate: boolean; tokenize: boolean; nCtx: number; chatTemplate: string;
  /** How `/props` fails when `props` is false: 404 (the default), a 500, or a 200 that is not llama.cpp's `/props`. */
  propsFailure?: "404" | "500" | "html";
  /** Identity fields a (successful) `/props` leaves out. */
  propsOmit?: ("model_path" | "chat_template" | "build_info")[];
  next: "stop" | "length" | "oversize" | "http400" | "http500" | "nochoice" | "content_filter" | "nofinish"
    | "nonjson" | "nofinish_full" | "nullfinish_full" | "nofinish_nousage";
  oversizeTokens?: number;
};
let b: Behaviour;
let server: ReturnType<typeof Bun.serve>;
let chatBodies: { max_tokens: number; messages: { content: string }[] }[];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  b = { props: true, applyTemplate: true, tokenize: true, nCtx: 8192, chatTemplate: "qwen3", next: "stop" };
  chatBodies = [];
  for (const k of ["CLAWMEM_LLM_CONTEXT_TOKENS", "CLAWMEM_NO_LOCAL_MODELS"]) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.CLAWMEM_NO_LOCAL_MODELS = "true";
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/props") {
        if (!b.props) {
          if (b.propsFailure === "500") return new Response("busy", { status: 500 });
          if (b.propsFailure === "html") return new Response("<html>another service</html>", { status: 200, headers: { "content-type": "text/html" } });
          return new Response("nf", { status: 404 });
        }
        const full: Record<string, unknown> = { default_generation_settings: { n_ctx: b.nCtx }, model_path: "/m/qmd.gguf", chat_template: b.chatTemplate, build_info: "b17" };
        for (const k of b.propsOmit ?? []) delete full[k];
        return Response.json(full);
      }
      if (path === "/apply-template") {
        if (!b.applyTemplate) return new Response("nf", { status: 404 });
        const body = await req.json() as { messages: { content: string }[] };
        return Response.json({ prompt: TEMPLATE(body.messages[0]!.content) });
      }
      if (path === "/tokenize") {
        if (!b.tokenize) return new Response("nf", { status: 404 });
        const body = await req.json() as { content: string };
        return Response.json({ tokens: new Array(tok(body.content)).fill(1) });
      }
      if (path === "/v1/chat/completions") {
        const body = await req.json() as { max_tokens: number; messages: { content: string }[] };
        chatBodies.push(body);
        const prompt = tok(TEMPLATE(body.messages[0]!.content));
        if (b.next === "oversize") {
          return Response.json({ error: { code: 400, message: "too big", type: "exceed_context_size_error", n_prompt_tokens: b.oversizeTokens ?? prompt, n_ctx: b.nCtx } }, { status: 400 });
        }
        if (b.next === "http400") return Response.json({ error: { code: 400, message: "bad", type: "invalid_request_error" } }, { status: 400 });
        if (b.next === "http500") return new Response("boom", { status: 500 });
        if (b.next === "nochoice") return Response.json({ choices: [], model: "qmd" });
        if (b.next === "nonjson") return new Response("<html>another service</html>", { status: 200, headers: { "content-type": "text/html" } });
        if (b.next === "nofinish_full" || b.next === "nullfinish_full") {
          // No finish reason, and a reply that used its whole allowance: cut mid-sentence, as the server cuts at max_tokens.
          return Response.json({
            choices: [{ message: { content: "Looking at the transcript, I" }, ...(b.next === "nullfinish_full" ? { finish_reason: null } : {}) }],
            model: "qmd", usage: { prompt_tokens: prompt, completion_tokens: body.max_tokens, total_tokens: prompt + body.max_tokens },
          });
        }
        if (b.next === "nofinish_nousage") return Response.json({ choices: [{ message: { content: "nothing" } }], model: "qmd" });
        if (b.next === "content_filter" || b.next === "nofinish") {
          return Response.json({
            choices: [{ message: { content: "" }, ...(b.next === "content_filter" ? { finish_reason: "content_filter" } : {}) }],
            model: "qmd", usage: { prompt_tokens: prompt, completion_tokens: 0, total_tokens: prompt },
          });
        }
        const completion = b.next === "length" ? Math.max(1, b.nCtx - prompt) : 3;
        return Response.json({
          choices: [{ message: { content: b.next === "length" ? "<observation><ty" : "done" }, finish_reason: b.next }],
          model: "qmd", usage: { prompt_tokens: prompt, completion_tokens: Math.min(completion, body.max_tokens), total_tokens: prompt + completion },
        });
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
const deadline = () => deadlineAfter(monoNow(), duration(30_000));
const client = (u = url()) => new LlamaCpp({ remoteLlmUrl: u });
const memStore = (): OverheadStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => { data.set(k, v); }, delete: (k) => { data.delete(k); } };
};

describe("v0.41.2 LLM layer: where the context comes from (T9)", () => {
  it("the server root for the three URL shapes", () => {
    expect(remoteLlmRoot("http://h:8089")).toBe("http://h:8089");
    expect(remoteLlmRoot("http://h:8089/v1/")).toBe("http://h:8089");
    expect(remoteLlmRoot("http://h:8089/v1/chat/completions")).toBe("http://h:8089");
  });

  it("/props → measured, with a strong fingerprint that moves with the chat template", async () => {
    const llm = client(`${url()}/v1/chat/completions`);
    const backend = llm.activeLlmBackend()!;
    const a = await llm.llmCapacity(backend, { deadline: deadline() });
    expect(a).toMatchObject({ nCtx: 8192, source: "measured", fingerprintStrength: "strong" });
    b.chatTemplate = "another template";
    const c = await llm.llmCapacity(backend, { deadline: deadline() });
    expect(c.fingerprint).not.toBe(a.fingerprint);
    b.nCtx = 4096;
    expect((await llm.llmCapacity(backend, { deadline: deadline() })).nCtx).toBe(4096);   // read fresh: a restart is seen at once
  });

  it("no /props → CLAWMEM_LLM_CONTEXT_TOKENS (configured), else 4096 (assumed); both weak", async () => {
    b.props = false;
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    expect(await llm.llmCapacity(backend, { deadline: deadline() })).toMatchObject({ nCtx: 4096, source: "assumed", fingerprintStrength: "weak" });
    process.env.CLAWMEM_LLM_CONTEXT_TOKENS = "6000";
    expect(await llm.llmCapacity(backend, { deadline: deadline() })).toMatchObject({ nCtx: 6000, source: "configured", fingerprintStrength: "weak" });
  });
});

describe("v0.41.2 LLM layer: counting (T20)", () => {
  it("/apply-template + /tokenize → template-exact, margin 0 (r10 §1.2), equal to the chat endpoint's own prompt count", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const cap = await llm.llmCapacity(backend, { deadline: deadline() });
    const content = llm.outboundChatContent("Extract observations from this", backend);
    const c = await llm.countChatTokens(content, cap, { deadline: deadline() });
    expect(c).toEqual({ tokens: tok(TEMPLATE(content)), method: "template", margin: 0 });
    const r = await llm.generateDetailed("Extract observations from this", { maxTokens: 50, backend });
    expect(r.ok && r.promptTokens).toBe(c.tokens);
  });

  it("no /apply-template → the content's count + an overhead measured by a one-token probe, persisted per fingerprint", async () => {
    b.applyTemplate = false;
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const cap = await llm.llmCapacity(backend, { deadline: deadline() });
    const store = memStore();
    const content = llm.outboundChatContent("Extract observations from this", backend);
    const c = await llm.countChatTokens(content, cap, { deadline: deadline(), overheadStore: store });
    expect(c.method).toBe("content");
    const overhead = tok(TEMPLATE(llm.outboundChatContent("ok", backend))) - tok(llm.outboundChatContent("ok", backend));
    expect(c.margin).toBe(overhead + 8);
    expect([...store.data.keys()][0]).toBe(`llm-template-overhead:${cap.fingerprint}`);
    expect(chatBodies.some(x => x.max_tokens === 1)).toBe(true);   // the probe
  });

  it("no /tokenize → the conservative estimate, margin 32", async () => {
    b.applyTemplate = false;
    b.tokenize = false;
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const cap = await llm.llmCapacity(backend, { deadline: deadline() });
    const c = await llm.countChatTokens("0123456789".repeat(10), cap, { deadline: deadline() });
    expect(c).toEqual({ tokens: estimateTokens("0123456789".repeat(10)), method: "estimate", margin: 32 });
  });

  it("the estimate counts dense text at ~1 char/token and prose at 3; it never learns downward", async () => {
    expect(estimateTokens("3f9a1c0e7b2d4a6f".repeat(10))).toBe(160);                    // a hash: 1 per character
    const prose = "the quick brown fox jumps over the lazy dog ".repeat(10);           // letters and spaces only
    expect(estimateTokens(prose)).toBe(Math.ceil(prose.length / 3));
    b.applyTemplate = false;
    b.tokenize = false;
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const cap = await llm.llmCapacity(backend, { deadline: deadline() });
    // A reply whose own count is LOWER than the estimate (digits: the server counts 1 per 3, the estimate 1 per 1) leaves it.
    const digits = "0123456789".repeat(30);
    const d0 = (await llm.countChatTokens(digits, cap, { deadline: deadline() })).tokens;
    await llm.generateDetailed(digits, { maxTokens: 10, backend });
    expect((await llm.countChatTokens(digits, cap, { deadline: deadline() })).tokens).toBe(d0);
    // A reply whose count is HIGHER (prose + the template's tokens) raises it.
    const text = "the quick brown fox jumps over the lazy dog ".repeat(10);
    const before = (await llm.countChatTokens(text, cap, { deadline: deadline() })).tokens;
    await llm.generateDetailed(text, { maxTokens: 10, backend });
    const after = (await llm.countChatTokens(text, cap, { deadline: deadline() })).tokens;
    expect(after).toBeGreaterThan(before);
  });
});

describe("v0.41.2 LLM layer: generateDetailed (T5, T8, T12)", () => {
  it("reports why the reply stopped: stop / length, with the server's usage", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const ok = await llm.generateDetailed("hi", { maxTokens: 50, backend });
    expect(ok).toMatchObject({ ok: true, finish: "stop", completionTokens: 3 });
    b.next = "length";
    const cut = await llm.generateDetailed("hi", { maxTokens: 50, backend });
    expect(cut).toMatchObject({ ok: true, finish: "length" });
  });

  it("a validated oversize does not strike the first time; a repeat that is not smaller does; three trip the cooldown", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    b.next = "oversize";
    b.oversizeTokens = 9000;
    const r1 = await llm.generateDetailed("x", { maxTokens: 10, backend });
    expect(r1).toMatchObject({ ok: false, reason: "context_exceeded", nCtx: 8192, promptTokens: 9000 });
    for (let i = 0; i < 2; i++) await llm.generateDetailed("x", { maxTokens: 10, backend });
    expect(llm.isBackendAvailable(backend)).toBe(true);    // exempt, then two strikes
    await llm.generateDetailed("x", { maxTokens: 10, backend });
    expect(llm.isBackendAvailable(backend)).toBe(false);   // the third strike: issue #24's cooldown
  });

  it("oversize answers for ever-smaller requests never strike; a success closes the exemption", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    b.next = "oversize";
    for (const n of [9000, 8800, 8600, 8400, 8300]) { b.oversizeTokens = n; await llm.generateDetailed("x", { maxTokens: 10, backend }); }
    expect(llm.isBackendAvailable(backend)).toBe(true);
    b.next = "stop";
    expect((await llm.generateDetailed("x", { maxTokens: 10, backend })).ok).toBe(true);
  });

  it("another 400 strikes as before; legacy generate() strikes on ANY 400, the oversize one included (T12)", async () => {
    const a = client();
    const backend = a.activeLlmBackend()!;
    b.next = "http400";
    for (let i = 0; i < 3; i++) await a.generateDetailed("x", { maxTokens: 10, backend });
    expect(a.isBackendAvailable(backend)).toBe(false);
    const legacy = client();
    b.next = "oversize";
    for (let i = 0; i < 3; i++) expect(await legacy.generate("x", { maxTokens: 10 })).toBeNull();
    expect(legacy.isBackendAvailable(legacy.activeLlmBackend() ?? backend)).toBe(false);
  });

  it("pinned to its backend: a transport failure returns `unavailable` and never falls through to local (T8)", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadUrl = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const llm = client(deadUrl);
    const backend = llm.activeLlmBackend()!;
    const r = await llm.generateDetailed("x", { maxTokens: 10, backend });
    expect(r).toMatchObject({ ok: false, reason: "unavailable" });
    expect(llm.activeLlmBackend()).toBeNull();   // the remote is in cooldown and local models are disabled
  });
});

describe("v0.41.2 codex T11 regressions — the LLM layer", () => {
  it("a 200 without a completion choice is not a reply; a finish other than stop/length reads `other`; none reads `stop` (T11-2)", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    b.next = "nochoice";
    expect(await llm.generateDetailed("hi", { maxTokens: 50, backend })).toMatchObject({ ok: false, reason: "http" });
    b.next = "content_filter";
    expect(await llm.generateDetailed("hi", { maxTokens: 50, backend })).toMatchObject({ ok: true, finish: "other" });
    b.next = "nofinish";
    expect(await llm.generateDetailed("hi", { maxTokens: 50, backend })).toMatchObject({ ok: true, finish: "stop" });
  });

  it("the measured overhead expires after 24 h in memory as in the store, and an invalidation drops both (T11-7)", async () => {
    b.applyTemplate = false;
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const cap = await llm.llmCapacity(backend, { deadline: deadline() });
    const store = memStore();
    const content = llm.outboundChatContent("Extract observations from this", backend);
    const probes = () => chatBodies.filter(x => x.max_tokens === 1).length;
    await llm.countChatTokens(content, cap, { deadline: deadline(), overheadStore: store });
    await llm.countChatTokens(content, cap, { deadline: deadline(), overheadStore: store });
    expect(probes()).toBe(1);                                   // measured once, then reused
    setWallJumpForTest({ at: monoNow(), deltaMs: 25 * 60 * 60_000 });
    try {
      await llm.countChatTokens(content, cap, { deadline: deadline(), overheadStore: store });
      expect(probes()).toBe(2);                                 // a day later: measured again
    } finally {
      setWallJumpForTest(null);
    }
    (llm as any).invalidateOverhead(cap.fingerprint, store);
    expect(store.data.size).toBe(0);
    await llm.countChatTokens(content, cap, { deadline: deadline(), overheadStore: store });
    expect(probes()).toBe(3);                                   // invalidated: measured again
  });
});

describe("v0.41.2 codex T12 regressions — the LLM layer", () => {
  it("a 200 without a completion builds the endpoint's failure streak: the third trips the cooldown and the fallback engages (T12-1)", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    b.next = "nochoice";
    for (let i = 0; i < 2; i++) expect(await llm.generateDetailed("x", { maxTokens: 10, backend })).toMatchObject({ ok: false, reason: "http" });
    expect(llm.isBackendAvailable(backend)).toBe(true);
    expect(await llm.generateDetailed("x", { maxTokens: 10, backend })).toMatchObject({ ok: false, reason: "http" });
    expect(llm.isBackendAvailable(backend)).toBe(false);   // the third: issue #24's cooldown
    delete process.env.CLAWMEM_NO_LOCAL_MODELS;
    expect(llm.activeLlmBackend()?.kind).toBe("local");   // the fallback is reachable while the remote cools down
    process.env.CLAWMEM_NO_LOCAL_MODELS = "true";

    // A 200 that is not JSON at all counts the same.
    const squatted = client();
    b.next = "nonjson";
    for (let i = 0; i < 3; i++) expect(await squatted.generateDetailed("x", { maxTokens: 10, backend })).toMatchObject({ ok: false, reason: "http" });
    expect(squatted.isBackendAvailable(backend)).toBe(false);

    // A real reply between malformed ones clears the streak.
    const other = client();
    b.next = "nochoice";
    for (let i = 0; i < 2; i++) await other.generateDetailed("x", { maxTokens: 10, backend });
    b.next = "stop";
    expect((await other.generateDetailed("x", { maxTokens: 10, backend })).ok).toBe(true);
    b.next = "nochoice";
    for (let i = 0; i < 2; i++) await other.generateDetailed("x", { maxTokens: 10, backend });
    expect(other.isBackendAvailable(backend)).toBe(true);
  });

  it("no finish_reason: a reply that used its whole allowance reads `length`; any other reads `stop` (best-effort) (T12-4)", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    b.next = "nofinish_full";
    expect(await llm.generateDetailed("hi", { maxTokens: 40, backend })).toMatchObject({ ok: true, finish: "length" });
    b.next = "nullfinish_full";
    expect(await llm.generateDetailed("hi", { maxTokens: 40, backend })).toMatchObject({ ok: true, finish: "length" });
    b.next = "nofinish";           // the reply left room
    expect(await llm.generateDetailed("hi", { maxTokens: 40, backend })).toMatchObject({ ok: true, finish: "stop" });
    b.next = "nofinish_nousage";   // nothing to judge by: read as complete, the documented best-effort case
    expect(await llm.generateDetailed("hi", { maxTokens: 40, backend })).toMatchObject({ ok: true, finish: "stop" });
  });

  it("end to end: a server that sends no finish_reason cuts a reply at its allowance — the observer halves the window, never commits `empty` (T12-4)", async () => {
    b.next = "nofinish_full";
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const msgs: TranscriptMessage[] = [{ role: "user", content: "rename the config loader and update its callers", turn: 0, opening: true }];
    for (let i = 0; i < 3; i++) msgs.push({ role: "assistant", content: `Updated caller ${i} to the renamed loader.`, turn: 0 });
    const r = await extractObservationsWindowed(msgs, { llm, backend, deadline: deadline() });
    expect(r.status).not.toBe("empty");
    expect(r.status).toBe("retryable");
    const sizes = chatBodies.filter(x => x.max_tokens > 1).map(x => x.messages[0]!.content.length);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes[1]!).toBeLessThan(sizes[0]!);   // the window was halved after the first reply
  });

  it("a `/props` that gives no comparable fingerprint — a 404, a 200 that is not llama.cpp's, a 500 — leaves a strong pin UNVERIFIED, never changed (T13-1)", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const pin = await llm.llmCapacity(backend, { deadline: deadline() });
    expect(pin.fingerprintStrength).toBe("strong");
    const { fingerprintVerdict } = await llmModule();
    b.props = false;
    for (const failure of ["404", "html", "500"] as const) {
      b.propsFailure = failure;
      const read = await llm.llmCapacity(backend, { deadline: deadline() });
      expect(read.fingerprintStrength).toBe("weak");
      expect(fingerprintVerdict({ fingerprint: pin.fingerprint, strength: "strong" }, read)).toBe("unverified");
    }
    b.props = true;   // the original /props again: the same server
    expect(fingerprintVerdict({ fingerprint: pin.fingerprint, strength: "strong" }, await llm.llmCapacity(backend, { deadline: deadline() }))).toBe("same");
  });
});

describe("v0.41.2 codex T14 regressions — the LLM layer", () => {
  it("a `/props` that gives the context but not the full identity is MEASURED but weak, so a strong pin reads it unverified (T14-1)", async () => {
    const llm = client();
    const backend = llm.activeLlmBackend()!;
    const pin = await llm.llmCapacity(backend, { deadline: deadline() });
    expect(pin.fingerprintStrength).toBe("strong");
    const { fingerprintVerdict } = await llmModule();
    const omissions: ("model_path" | "chat_template" | "build_info")[][] = [["model_path", "chat_template", "build_info"], ["model_path"], ["chat_template"], ["build_info"]];
    for (const omit of omissions) {
      b.propsOmit = omit;
      const read = await llm.llmCapacity(backend, { deadline: deadline() });
      expect(read).toMatchObject({ nCtx: 8192, source: "measured", fingerprintStrength: "weak" });
      expect(fingerprintVerdict({ fingerprint: pin.fingerprint, strength: "strong" }, read)).toBe("unverified");
    }
    b.propsOmit = undefined;   // the full /props again: the same server
    expect(fingerprintVerdict({ fingerprint: pin.fingerprint, strength: "strong" }, await llm.llmCapacity(backend, { deadline: deadline() }))).toBe("same");
  });
});
