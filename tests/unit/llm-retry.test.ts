import { describe, expect, it, mock } from "bun:test";
import { withRetryAndFeedback, type ParseOutcome } from "../../src/llm-retry.ts";

function makeLlm(responses: Array<string | null | Error>) {
  const generate = mock(async (_prompt: string, _opts: unknown) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === null || next === undefined) return null;
    return { text: next, model: "mock-llm", done: true };
  });
  return { generate };
}

const parseJsonArray = (text: string): ParseOutcome<unknown[]> => {
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) return { ok: false, error: "Not a JSON array." };
    return { ok: true, value };
  } catch {
    return { ok: false, error: "Invalid JSON." };
  }
};

describe("withRetryAndFeedback", () => {
  it("returns the parsed value on first-attempt success with a single call", async () => {
    const llm = makeLlm(['["a","b"]']);
    const result = await withRetryAndFeedback({
      initialPrompt: "PROMPT",
      llm,
      maxTokens: 100,
      parse: parseJsonArray,
    });
    expect(result).toEqual(["a", "b"]);
    expect(llm.generate).toHaveBeenCalledTimes(1);
    expect(llm.generate.mock.calls[0]?.[0]).toBe("PROMPT");
  });

  it("feeds the parse error and a response excerpt back into the retry prompt", async () => {
    const llm = makeLlm(["not json at all", '["ok"]']);
    const result = await withRetryAndFeedback({
      initialPrompt: "ORIGINAL PROMPT",
      llm,
      maxTokens: 100,
      parse: parseJsonArray,
    });
    expect(result).toEqual(["ok"]);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    const retryPrompt = llm.generate.mock.calls[1]?.[0] as string;
    expect(retryPrompt).toContain("ORIGINAL PROMPT");
    expect(retryPrompt).toContain("did not match the expected structure");
    expect(retryPrompt).toContain("Invalid JSON.");
    expect(retryPrompt).toContain("not json at all");
  });

  it("fails open to null after maxAttempts parse failures", async () => {
    const llm = makeLlm(["bad", "worse", "worst"]);
    const result = await withRetryAndFeedback({
      initialPrompt: "P",
      llm,
      maxTokens: 100,
      maxAttempts: 3,
      parse: parseJsonArray,
    });
    expect(result).toBeNull();
    expect(llm.generate).toHaveBeenCalledTimes(3);
  });

  it("treats a null LLM result as a failed attempt and retries", async () => {
    const llm = makeLlm([null, '["recovered"]']);
    const result = await withRetryAndFeedback({
      initialPrompt: "P",
      llm,
      maxTokens: 100,
      parse: parseJsonArray,
    });
    expect(result).toEqual(["recovered"]);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    const retryPrompt = llm.generate.mock.calls[1]?.[0] as string;
    expect(retryPrompt).toContain("empty response");
  });

  it("retries with the SAME prompt when generate throws (no output to feed back)", async () => {
    const llm = makeLlm([new Error("boom"), '["after-throw"]']);
    const result = await withRetryAndFeedback({
      initialPrompt: "STABLE PROMPT",
      llm,
      maxTokens: 100,
      parse: parseJsonArray,
    });
    expect(result).toEqual(["after-throw"]);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    expect(llm.generate.mock.calls[1]?.[0]).toBe("STABLE PROMPT");
  });

  it("stops retrying when the overall timeout budget is exhausted", async () => {
    // The first attempt outlives the whole budget, so the deadline race
    // terminates the helper mid-attempt — attempt 2 never starts.
    const generate = mock(async (_prompt: string, _opts: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { text: "bad", model: "mock-llm", done: true };
    });
    const result = await withRetryAndFeedback({
      initialPrompt: "P",
      llm: { generate },
      maxTokens: 100,
      maxAttempts: 3,
      timeoutMs: 5,
      parse: parseJsonArray,
    });
    expect(result).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("rebuilds every retry prompt from the ORIGINAL prompt (stateless — no accumulation)", async () => {
    const llm = makeLlm(["bad1", "bad2", '["done"]']);
    const result = await withRetryAndFeedback({
      initialPrompt: "ROOT",
      llm,
      maxTokens: 100,
      maxAttempts: 3,
      parse: parseJsonArray,
    });
    expect(result).toEqual(["done"]);
    const thirdPrompt = llm.generate.mock.calls[2]?.[0] as string;
    // The third prompt embeds ROOT exactly once — not the second prompt nested
    // inside itself — and carries only the LATEST failure's excerpt.
    expect(thirdPrompt.split("ROOT").length - 1).toBe(1);
    expect(thirdPrompt).toContain("bad2");
    expect(thirdPrompt).not.toContain("bad1");
  });

  it("passes maxTokens, temperature, and an abort signal through to generate", async () => {
    const llm = makeLlm(['["x"]']);
    await withRetryAndFeedback({
      initialPrompt: "P",
      llm,
      maxTokens: 321,
      temperature: 0.7,
      parse: parseJsonArray,
    });
    const opts = llm.generate.mock.calls[0]?.[1] as {
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    };
    expect(opts.maxTokens).toBe(321);
    expect(opts.temperature).toBe(0.7);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not start any attempt when the budget is already exhausted (pre-attempt deadline check)", async () => {
    const llm = makeLlm(['["never-consumed"]']);
    const result = await withRetryAndFeedback({
      initialPrompt: "P",
      llm,
      maxTokens: 100,
      timeoutMs: 0,
      parse: parseJsonArray,
    });
    expect(result).toBeNull();
    expect(llm.generate).toHaveBeenCalledTimes(0);
  });

  it("hard-caps wall-clock when the backend IGNORES the abort signal", async () => {
    // The backend receives the signal but keeps running for 500ms regardless.
    // The deadline race must terminate the helper at the budget (~30ms), not
    // at backend completion.
    let sawAbort = false;
    const generate = mock(async (_prompt: string, opts: { signal?: AbortSignal }) => {
      opts.signal?.addEventListener("abort", () => {
        sawAbort = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { text: '["too-late"]', model: "mock-llm", done: true };
    });
    const started = Date.now();
    const result = await withRetryAndFeedback({
      initialPrompt: "P",
      llm: { generate },
      maxTokens: 100,
      maxAttempts: 3,
      timeoutMs: 30,
      parse: parseJsonArray,
    });
    const elapsed = Date.now() - started;
    expect(result).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(400);
    expect(sawAbort).toBe(true);
  });

  it("aborts an abort-aware backend at the deadline and fails open without further attempts", async () => {
    let sawAbort = false;
    const generate = mock((_prompt: string, opts: { signal?: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted by signal"));
        });
      });
    });
    const started = Date.now();
    const result = await withRetryAndFeedback({
      initialPrompt: "P",
      llm: { generate },
      maxTokens: 100,
      maxAttempts: 3,
      timeoutMs: 30,
      parse: parseJsonArray,
    });
    const elapsed = Date.now() - started;
    expect(result).toBeNull();
    expect(sawAbort).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(400);
  });
});
