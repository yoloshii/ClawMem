/**
 * 62.1 D3/D4: the observer's status-returning form (design tests 7, 8 at the observer layer).
 *
 * Baseline (8e2579a): `extractObservations` returns [] below 4 messages AND on every failure (`parsed ?? []`,
 * `withRetryAndFeedback` → null), so a Stop cannot tell "nothing to record" from "the model was down" — a failed
 * turn is silently committed as empty and never retried. An empty completion ("output nothing", as the prompt asks)
 * is itself treated as an error and retried.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import { duration } from "../../src/clock.ts";
import { fakeBudgetLlm } from "../helpers/fake-budget-llm.ts";

const obsMod = () => import("../../src/observer.ts");

function fakeLlm(responses: (string | null)[]) {
  const prompts: string[] = [];
  let i = 0;
  const llm = {
    generate: async (prompt: string) => {
      prompts.push(prompt);
      const r = responses[Math.min(i++, responses.length - 1)];
      return r === null ? null : { text: r, model: "fake", done: true };
    },
  };
  setDefaultLlamaCpp(llm as any);
  return prompts;
}
afterEach(() => setDefaultLlamaCpp(null));

const OBS = `<observation><type>decision</type><title>Batch writes in the ingest pipeline</title>
<facts><fact>The ingest pipeline batches writes in groups of 500</fact></facts>
<narrative>Batching cuts fsync cost.</narrative></observation>`;
const msgs = [
  { role: "user" as const, content: "should we batch the writes?" },
  { role: "assistant" as const, content: "Yes, batch them in groups of 500 to cut fsync cost." },
];

describe("D3 extractObservationsResult", () => {
  it("ok: parsed observations, with no minimum message count (admission is the caller's)", async () => {
    const { extractObservationsResult } = await obsMod();
    fakeLlm([OBS]);
    const r = await extractObservationsResult(msgs);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.observations.map(o => o.title)).toEqual(["Batch writes in the ingest pipeline"]);
  });

  it("empty: an empty completion or a short plain 'nothing' is a valid answer, not a failure", async () => {
    const { extractObservationsResult } = await obsMod();
    let prompts = fakeLlm([""]);
    expect((await extractObservationsResult(msgs)).status).toBe("empty");
    expect(prompts.length).toBe(1);   // accepted at once, never retried
    prompts = fakeLlm(["No significant observations."]);
    expect((await extractObservationsResult(msgs)).status).toBe("empty");
    expect(prompts.length).toBe(1);
  });

  it("retryable: the model unavailable, or output that never parses, is reported as such (never as empty)", async () => {
    const { extractObservationsResult } = await obsMod();
    fakeLlm([null]);
    const down = await extractObservationsResult(msgs);
    expect(down.status).toBe("retryable");
    if (down.status === "retryable") expect(down.reason).toContain("unavailable");
    fakeLlm(["<observation><type>bogus</type></observation>"]);
    expect((await extractObservationsResult(msgs)).status).toBe("retryable");
  });

  it("the CONTEXT section carries prior turns and recorded titles, marked as already recorded", async () => {
    const { extractObservationsResult } = await obsMod();
    const prompts = fakeLlm([""]);
    await extractObservationsResult(msgs, {
      context: { priorMessages: [{ role: "user", content: "earlier question about caching" }], recordedTitles: ["Cache keys use sha256"] },
    });
    const p = prompts[0]!;
    expect(p).toContain("CONTEXT (already recorded — do not extract)");
    expect(p).toContain("earlier question about caching");
    expect(p).toContain("Cache keys use sha256");
    expect(p.indexOf("CONTEXT (already recorded")).toBeLessThan(p.indexOf("should we batch the writes?"));
  });
});

/**
 * v0.41.1: the prompt fits the context the observer is documented to run with (`-c 4096`).
 *
 * Baseline (v0.41.0): the CONTEXT section rendered its prior turns through `prepareTranscript` with that function's
 * whole 8,000-character budget and listed up to 30 titles, on top of the batch's own 8,000 — about 6,600 tokens at
 * worst against v0.40's 3,400. On the prescribed 4,096-token model the server answered HTTP 400, the range was
 * quarantined, and every replay sent the same prompt again.
 */
describe("v0.41.1 the observer prompt stays inside its input bound", () => {
  const between = (p: string, from: string, to: string) => {
    const i = p.indexOf(from);
    return i < 0 ? "" : p.slice(i, p.indexOf(to, i));
  };
  /** The CONTEXT section (from its header to the transcript header). */
  const contextOf = (p: string) => between(p, "--- CONTEXT", "--- TRANSCRIPT ---");
  /** The transcript body (between its markers). */
  const transcriptOf = (p: string) => between(p, "--- TRANSCRIPT ---\n", "\n--- END TRANSCRIPT ---").slice("--- TRANSCRIPT ---\n".length);
  const filled = (tag: string, i: number) => `${tag} ${i} ` + "w".repeat(2000);
  const msgs = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "assistant" | "user", content: filled(tag, i) }));
  // Every part at its largest: a batch that alone fills the render budget, long prior turns, 30 long titles.
  const bigContext = {
    priorMessages: msgs("prior message", 40),
    recordedTitles: Array.from({ length: 30 }, (_, i) => `Recorded title ${i} ` + "t".repeat(150)),
  };

  // v0.41.2 (BACKLOG 68.5) replaces v0.41.1's character bound with a token budget: the character bound let a dense
  // prompt fill 4,072 of 4,096 tokens and starve the reply (prod 2026-10-01). These two assert the token invariant.
  it("v0.41.2: every prompt + its reply reserve fits the context in TOKENS, and every line reaches the model exactly once", async () => {
    const { extractObservationsResult, observerReplyReserve, renderObserverLines } = await obsMod();
    const fake = fakeBudgetLlm({ replies: [""], nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const batch = msgs("batch message", 40);
    const r = await extractObservationsResult(batch, { context: bigContext, timeoutMs: duration(600_000) });
    expect(r.status).toBe("empty");
    const reserve = observerReplyReserve(4096);
    expect(fake.calls.length).toBeGreaterThan(1);   // this batch cannot fit one 4,096-token window
    for (const c of fake.calls) expect(c.promptTokens + reserve).toBeLessThanOrEqual(4096);
    const seen = fake.calls.flatMap(c => transcriptOf(c.prompt).split("\n"));
    expect(seen).toEqual(renderObserverLines(batch).map(l => l.text));
  });

  it("v0.41.2: one invocation makes at most MAX_OBSERVER_CALLS calls; a unit past them is reported, never cut to fit", async () => {
    const { extractObservationsResult, MAX_OBSERVER_CALLS } = await obsMod();
    const fake = fakeBudgetLlm({ replies: [""], nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    const r = await extractObservationsResult(msgs("batch message", 100), { context: bigContext, timeoutMs: duration(600_000) });
    expect(r.status).toBe("retryable");
    if (r.status === "retryable") expect(r.reason).toContain("observer budget exhausted");
    expect(fake.calls.length).toBe(MAX_OBSERVER_CALLS);
  });

  it("the CONTEXT keeps its bound and its latest material: the last prior message and the newest titles", async () => {
    const { extractObservationsResult, OBSERVER_CONTEXT_MAX_CHARS } = await obsMod();
    expect(typeof OBSERVER_CONTEXT_MAX_CHARS).toBe("number");
    const prompts = fakeLlm([""]);
    await extractObservationsResult(msgs("batch message", 100), { context: bigContext });
    const ctx = contextOf(prompts[0]!);
    expect(ctx.length).toBeLessThanOrEqual(OBSERVER_CONTEXT_MAX_CHARS);
    expect(ctx).toContain("CONTEXT (already recorded — do not extract)");
    expect(ctx).toContain("--- END CONTEXT ---");
    expect(ctx).toContain("prior message 39");
    expect(ctx).toContain("Recorded title 29");
    expect(ctx).not.toContain("Recorded title 0 ");
  });

  // A parse failure with the longest error the observer reports and a response longer than the excerpt the retry
  // quotes: the largest retry feedback block.
  const UNPARSEABLE = "<observation><type>bogus</type></observation>" + "j".repeat(700);
  /** Everything after "Extract observations:" — a retry's feedback block and the blank line before it. */
  const feedbackOf = (p: string) => p.slice(p.indexOf("Extract observations:") + "Extract observations:".length);

  it("v0.41.2: a format retry's prompt, its feedback included, still fits the context in tokens", async () => {
    const { extractObservationsResult, observerReplyReserve } = await obsMod();
    const fake = fakeBudgetLlm({ replies: [UNPARSEABLE, ""], nCtx: 4096 });
    setDefaultLlamaCpp(fake.llm as any);
    await extractObservationsResult(msgs("batch message", 100), { context: bigContext, timeoutMs: duration(600_000) });
    const retry = fake.calls[1]!;
    expect(retry.prompt).toContain("did not match the expected structure");
    expect(feedbackOf(retry.prompt).length).toBeGreaterThan(0);
    for (const c of fake.calls) expect(c.promptTokens + observerReplyReserve(4096)).toBeLessThanOrEqual(4096);
  });

  it("a batch within the packing bound (render budget less OBSERVER_BATCH_RESERVED_CHARS) reaches the model whole, on a retry too", async () => {
    const { extractObservationsResult, observerRenderChars, OBSERVER_MAX_RENDER_CHARS, OBSERVER_BATCH_RESERVED_CHARS } = await obsMod();
    expect(typeof OBSERVER_BATCH_RESERVED_CHARS).toBe("number");
    const batch: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 200; i++) {
      const turn = [
        { role: "user" as const, content: `question ${i}` },
        { role: "assistant" as const, content: `answer ${i} ` + "a".repeat(460) + ` (end ${i})` },
      ];
      if (observerRenderChars([...batch, ...turn]) > OBSERVER_MAX_RENDER_CHARS - OBSERVER_BATCH_RESERVED_CHARS) break;
      batch.push(...turn);
    }
    const prompts = fakeLlm([UNPARSEABLE, ""]);
    await extractObservationsResult(batch, { context: bigContext });
    expect(prompts.length).toBe(2);
    for (const p of prompts) {
      const tr = transcriptOf(p);
      for (let i = 0; i < batch.length / 2; i++) expect(tr).toContain(`(end ${i})`);
    }
  });

  it("the CONTEXT's own cuts never leave half a surrogate pair (llama-server refuses a lone surrogate: HTTP 500)", async () => {
    const { extractObservationsResult } = await obsMod();
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // Messages under their per-message caps, so the only cuts are the section's: the front cut of the prior turns
    // (their first request and final response alone exceed its share; it lands in the request's emoji) and the title
    // clip. Both parities of each.
    for (const pad of ["", "x"]) {
      const prompts = fakeLlm([""]);
      await extractObservationsResult([{ role: "user", content: "q" }], {
        context: {
          priorMessages: [{ role: "user", content: "🔴".repeat(195) }, { role: "assistant", content: pad + "a".repeat(990) }],
          recordedTitles: [pad + "🟢".repeat(60)],
        },
      });
      const ctx = contextOf(prompts[0]!);
      expect(ctx).toContain("…🔴");   // the front cut happened, inside the emoji
      expect(lone.test(ctx)).toBe(false);
    }
  });

  it("prepareTranscript never returns more than the budget it is given, keeping the latest text", async () => {
    const { prepareTranscript } = await obsMod();
    // The first request and the final response alone exceed 300 characters: the render is cut from the front.
    const out = prepareTranscript(msgs("m", 4), 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.startsWith("…")).toBe(true);
    expect(out).not.toContain("[user]: m 0");
    expect(out.endsWith("w...")).toBe(true);   // the final response's capped end
    expect(prepareTranscript([{ role: "user", content: "short" }], 300)).toBe("[user]: short");
  });
});

describe("D4 observerRenderChars (batch packing)", () => {
  it("measures a batch the way the observer renders it: per-message caps, one line each", async () => {
    const { observerRenderChars } = await obsMod();
    const small = observerRenderChars([{ role: "user", content: "hi" }]);
    expect(small).toBe("[user]: hi".length + 1);
    const long = observerRenderChars([{ role: "assistant", content: "x".repeat(5000) }]);
    expect(long).toBeLessThan(5000);   // capped like prepareTranscript caps it
  });
});
