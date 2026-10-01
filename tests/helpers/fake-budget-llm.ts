/**
 * v0.41.2 (BACKLOG 68.5) test helper: an LLM with the token-budget layer that behaves like the measured llama.cpp
 * server (DESIGN-v0412.md E2–E4, E9–E11) — template-inclusive counts equal to what "generation" sees, a validated
 * oversize answer when a prompt exceeds the context, and a reply cut (`finish: "length"`) when it outgrows the room
 * the prompt left. Install with `setDefaultLlamaCpp(fake.llm as any)`.
 */

import type { LlmBackendId, LlmCapacity, ChatTokenCount, GenerateDetail } from "../../src/llm.ts";

/** A realistic two-class tokenizer: dense characters (digits, punctuation, non-ASCII) ≈ 1 token, other text ≈ 4 chars. */
export function fakeTokens(text: string): number {
  let dense = 0;
  let other = 0;
  for (const ch of text) {
    if (/[0-9!-\/:-@\[-`{-~]|[^\x00-\x7F]/u.test(ch)) dense++;
    else other++;
  }
  return Math.ceil(dense + other / 4);
}

export type FakeReply =
  | string
  | null
  | { text: string; finish?: "stop" | "length" | "other" }
  | { error: "unavailable" | "http" };

export type FakeCall = { prompt: string; maxTokens: number; promptTokens: number; backend: LlmBackendId };

export function fakeBudgetLlm(opts: {
  replies?: FakeReply[];
  /** Answer from the prompt instead of a fixed list (takes precedence). */
  reply?: (prompt: string) => FakeReply;
  /** The context the fake server has — a function to change it between calls. */
  nCtx?: number | (() => number);
  templateOverhead?: number;
  source?: LlmCapacity["source"];
  method?: ChatTokenCount["method"];
  fingerprint?: () => string;
  /** "weak" models a `/props` that did not answer (default "strong"). */
  strength?: () => LlmCapacity["fingerprintStrength"];
  available?: () => boolean;
  tokens?: (text: string) => number;
}) {
  const nCtx = () => (typeof opts.nCtx === "function" ? opts.nCtx() : opts.nCtx ?? 4096);
  const overhead = opts.templateOverhead ?? 8;
  const tok = opts.tokens ?? fakeTokens;
  const backend: LlmBackendId = { kind: "remote", root: "http://fake-llm" };
  const calls: FakeCall[] = [];
  const counts: string[] = [];
  /** Every capacity read, in order. */
  const capacityReads: number[] = [];
  /** Fingerprints whose measured template overhead the caller invalidated. */
  const invalidated: string[] = [];
  let i = 0;
  const llm = {
    activeLlmBackend: (): LlmBackendId | null => ((opts.available?.() ?? true) ? backend : null),
    isConfiguredBackend: (b: LlmBackendId) => b.kind === "remote" && b.root === backend.root,
    isBackendAvailable: (b: LlmBackendId) => b.kind === "remote" && b.root === backend.root && (opts.available?.() ?? true),
    llmCapacity: async (b: LlmBackendId): Promise<LlmCapacity> => {
      capacityReads.push(nCtx());
      return {
        backend: b, nCtx: nCtx(), source: opts.source ?? "measured",
        fingerprint: opts.fingerprint?.() ?? "fp-1", fingerprintStrength: opts.strength?.() ?? "strong",
      };
    },
    invalidateOverhead: (fingerprint: string) => { invalidated.push(fingerprint); },
    countChatTokens: async (content: string): Promise<ChatTokenCount> => {
      counts.push(content);
      return { tokens: tok(content) + overhead, method: opts.method ?? "template", margin: 4 };
    },
    outboundChatContent: (prompt: string) => prompt,
    generateDetailed: async (prompt: string, o: { maxTokens: number; backend: LlmBackendId }): Promise<GenerateDetail> => {
      const promptTokens = tok(prompt) + overhead;
      calls.push({ prompt, maxTokens: o.maxTokens, promptTokens, backend: o.backend });
      if (promptTokens > nCtx()) return { ok: false, reason: "context_exceeded", nCtx: nCtx(), promptTokens, backend: o.backend };
      const list = opts.replies ?? [""];
      const r = opts.reply ? opts.reply(prompt) : list[Math.min(i++, list.length - 1)];
      if (r === null || r === undefined) return { ok: false, reason: "unavailable", backend: o.backend };
      if (typeof r === "object" && "error" in r) return { ok: false, reason: r.error, backend: o.backend };
      const text = typeof r === "string" ? r : r.text;
      const room = Math.min(o.maxTokens, nCtx() - promptTokens);
      // A reply longer than the room left is cut, as the server does (E2).
      if (tok(text) > room || (typeof r === "object" && r.finish === "length")) {
        let cut = "";
        for (const ch of text) { if (tok(cut + ch) > room) break; cut += ch; }
        return { ok: true, text: cut, model: "fake", finish: "length", promptTokens, completionTokens: tok(cut), backend: o.backend };
      }
      const finish = typeof r === "object" && r.finish === "other" ? "other" : "stop";
      return { ok: true, text, model: "fake", finish, promptTokens, completionTokens: tok(text), backend: o.backend };
    },
    // The legacy contract, for callers that still use it.
    generate: async (prompt: string) => {
      const r = await llm.generateDetailed(prompt, { maxTokens: 2000, backend });
      return r.ok ? { text: r.text, model: r.model, done: true } : null;
    },
  };
  return { llm, calls, counts, capacityReads, invalidated, nCtx, overhead, tokens: tok };
}
