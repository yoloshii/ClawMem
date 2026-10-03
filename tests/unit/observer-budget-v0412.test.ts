/**
 * v0.41.2 (BACKLOG 68.5) — the observer's token budget, windows and reply handling (DESIGN-v0412.md §1.3–§1.5; tests T1,
 * T2, T3b, T7, T10 and the corrective paths).
 *
 * Baseline (v0.41.1, prod 2026-10-01): a dense prompt filled 4,072 of the server's 4,096 tokens, the reply was cut after
 * 16 tokens (`finish_reason: "length"`), and either every retry failed the same way or a cut reply with no `<` was read
 * as "nothing to record". These run the windowed extractor against a fake that counts and cuts like that server.
 */
import { describe, it, expect } from "bun:test";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { fakeBudgetLlm } from "../helpers/fake-budget-llm.ts";
import {
  extractObservationsWindowed, extractObservationsResult, extractSummaryFitted, observerReplyReserve, observerRequestedCount,
  renderObserverLines, capSummary, type SessionSummary,
} from "../../src/observer.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import type { TranscriptMessage } from "../../src/hooks.ts";

/** Exports added after codex T11, read through the namespace so a missing one fails its own test, not the file. */
const observerModule = () => import("../../src/observer.ts") as Promise<Record<string, any>>;
const B = { kind: "remote", root: "http://fake-llm" } as const;

const deadline = () => deadlineAfter(monoNow(), duration(600_000));
const OBS = (t: string) => `<observation><type>discovery</type><title>${t}</title><facts><fact>${t} happened in the session</fact></facts><narrative>n</narrative></observation>`;
const transcriptOf = (p: string) => {
  const i = p.indexOf("--- TRANSCRIPT ---\n");
  return i < 0 ? "" : p.slice(i + "--- TRANSCRIPT ---\n".length, p.indexOf("\n--- END TRANSCRIPT ---", i));
};
/** A turn of `n` tool results of dense hex (≈ 1 token per character — E11 measured 1.13). */
function hexTurn(n: number, turn = 0): TranscriptMessage[] {
  const out: TranscriptMessage[] = [{ role: "user", content: "check the hashes in the manifest", turn, opening: true }];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `[tool_result] sha ${i}: ${"0123456789abcdef".repeat(28)}`, turn });
  }
  out.push({ role: "assistant", content: "All hashes match the manifest.", turn });
  return out;
}

describe("v0.41.2 the reply gets room", () => {
  it("N follows the reply reserve: 4 at a 4,096-token context, 5 at 8,192 (T1)", () => {
    expect(observerReplyReserve(4096)).toBe(1638);
    expect(observerReplyReserve(8192)).toBe(2000);
    expect(observerRequestedCount(observerReplyReserve(4096))).toBe(4);
    expect(observerRequestedCount(observerReplyReserve(8192))).toBe(5);
  });

  it("every window of DENSE hex fits: prompt tokens + the reply reserve ≤ the context, and the prompt asks for N (T1)", async () => {
    const fake = fakeBudgetLlm({ replies: [OBS("hash check")], nCtx: 4096 });
    const msgs = hexTurn(8);
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline() });
    expect(r.status).toBe("ok");
    expect(fake.calls.length).toBeGreaterThan(1);
    for (const c of fake.calls) {
      expect(c.promptTokens + observerReplyReserve(4096)).toBeLessThanOrEqual(4096);
      expect(c.prompt).toContain("Output 1-4 observations");
    }
    expect(fake.calls.flatMap(c => transcriptOf(c.prompt).split("\n"))).toEqual(renderObserverLines(msgs).map(l => l.text));
  });
});

describe("v0.41.2 a cut reply is never success", () => {
  it("a cut reply with no markup is NOT empty: the window is halved and redone; nothing from the cut reply commits (T2)", async () => {
    const fake = fakeBudgetLlm({ replies: [{ text: "Here are the observ", finish: "length" }, OBS("after halving")], nCtx: 8192 });
    const msgs = hexTurn(6);
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline() });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.observations.map(o => o.title)).not.toContain("Here are the observ");
    const [first, second] = fake.calls;
    expect(second!.promptTokens).toBeLessThan(first!.promptTokens);   // the next attempt is smaller
  });

  it("one line whose observations still cannot fit the reply → retryable `capacity:`, never empty (T2)", async () => {
    const fake = fakeBudgetLlm({ replies: [{ text: "x", finish: "length" }], nCtx: 8192 });
    const msgs: TranscriptMessage[] = [{ role: "user", content: "one request", turn: 0, opening: true }];
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline() });
    expect(r.status).toBe("retryable");
    if (r.status === "retryable") expect(r.reason).toMatch(/^capacity: one message's observations exceed/);
  });
});

describe("v0.41.2 windows", () => {
  it("a window that starts inside a turn shows EARLIER lines + the turn's opening request, and ALREADY RECORDED titles (T3b)", async () => {
    let n = 0;
    const fake = fakeBudgetLlm({ reply: (p) => (p.includes("Extract observations:") ? OBS(`window ${++n}`) : ""), nCtx: 4096 });
    const msgs = hexTurn(20);
    await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline() });
    const second = fake.calls[1]!.prompt;
    expect(second).toContain("--- EARLIER IN THIS EXCHANGE");
    expect(second).toContain("[user]: check the hashes in the manifest");   // the anchor
    expect(second).toContain("--- ALREADY RECORDED (do not repeat) ---");
    expect(second).toContain("- window 1");
  });

  it("resume starts at the checkpoint's line, carries its observations, and reports progress after each window", async () => {
    const fake = fakeBudgetLlm({ reply: (p) => (p.includes("Extract observations:") ? OBS("resumed") : ""), nCtx: 4096 });
    const msgs = hexTurn(20);
    const lines = renderObserverLines(msgs);
    const progress: number[] = [];
    // v0.41.4: the system prompt grew (the type list, the escape rule, `<none/>`), so a 4,096-token window holds fewer
    // dense hex lines and these ten take more than six calls; the cap is raised — the subject here is the resume line,
    // the carried observations and the progress order, not the call count.
    const r = await extractObservationsWindowed(msgs, {
      llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline(), maxCalls: 12,
      resume: { doneThroughLine: 10, observations: [{ type: "discovery", title: "earlier", facts: ["f"], narrative: "n", concepts: [], filesRead: [], filesModified: [] }], titles: ["earlier"] },
      onProgress: (p) => { progress.push(p.doneThroughLine); return true; },
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.observations[0]!.title).toBe("earlier");
    expect(transcriptOf(fake.calls[0]!.prompt).split("\n")[0]).toBe(lines[10]!.text);
    expect(progress.every((v, i) => i === 0 || v > progress[i - 1]!)).toBe(true);
  });

  it("a lost compare-and-swap in onProgress → overtaken; a fingerprint change mid-run → server_changed", async () => {
    const fake = fakeBudgetLlm({ reply: (p) => (p.includes("Extract observations:") ? OBS("w") : ""), nCtx: 4096 });
    const msgs = hexTurn(20);
    const lost = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline(), onProgress: () => false });
    expect(lost.status).toBe("overtaken");
    let fp = "fp-1";
    const moving = fakeBudgetLlm({ reply: (p) => { fp = "fp-2"; return p.includes("Extract observations:") ? OBS("w") : ""; }, nCtx: 4096, fingerprint: () => fp });
    const changed = await extractObservationsWindowed(msgs, { llm: moving.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline(), expectFingerprint: "fp-1" });
    expect(changed.status).toBe("server_changed");
  });

  it("an oversize answer (the count was low) re-sizes the window once from the server's own count, then succeeds", async () => {
    // The counter under-reports by 60%: the first prompt the observer believes fits is refused as oversize.
    const fake = fakeBudgetLlm({ replies: [OBS("after correction")], nCtx: 4096, templateOverhead: 8 });
    const honest = fake.llm.countChatTokens;
    fake.llm.countChatTokens = async (content: string) => { const c = await honest(content); return { ...c, tokens: Math.floor(c.tokens * 0.4) }; };
    const r = await extractObservationsWindowed(hexTurn(20), { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline() });
    expect(["ok", "partial"]).toContain(r.status);
    expect(fake.calls.some(c => c.promptTokens > 4096)).toBe(true);           // it was refused once …
    expect(fake.calls.some(c => c.promptTokens <= 4096)).toBe(true);          // … and then fit
  });
});

describe("v0.41.2 capacity", () => {
  it("the fixed part alone cannot fit (F + 512 > B) → `capacity:`, and no model call (T7)", async () => {
    const fake = fakeBudgetLlm({ replies: [OBS("never")], nCtx: 1500 });
    const r = await extractObservationsWindowed(hexTurn(2), { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline() });
    expect(r.status).toBe("retryable");
    if (r.status === "retryable") expect(r.reason).toMatch(/^capacity: the observer's prompt needs \d+ tokens; the context is 1500 \(measured\)/);
    expect(fake.calls.length).toBe(0);
  });

  it("a single line over a window's allowance → `capacity:`, and no model call (T7)", async () => {
    const fake = fakeBudgetLlm({ replies: [OBS("never")], nCtx: 2900 });
    const msgs: TranscriptMessage[] = [{ role: "assistant", content: "0123456789".repeat(110), turn: 0 }];   // a 1,000-char critical line of digits ≈ 1,000 tokens
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: { kind: "remote", root: "http://fake-llm" }, deadline: deadline() });
    expect(r.status).toBe("retryable");
    if (r.status === "retryable") expect(r.reason).toMatch(/^capacity: one message needs \d+ tokens; a window holds -?\d+/);
    expect(fake.calls.length).toBe(0);
  });
});

describe("v0.41.2 the summary step (T10)", () => {
  const S = (x: string): SessionSummary => ({ request: x, investigated: x, learned: x, completed: x, nextSteps: x });
  const SUMMARY = "<summary><request>R</request><investigated>I</investigated><learned>L</learned><completed>C</completed><next_steps>N</next_steps></summary>";
  const digest = (i: number) => ({ request: `request ${i} ` + "0123456789".repeat(30), outcome: `outcome ${i}`, files: [] as string[] });

  it("fits the context: the recent text goes first, then digests from the end; digestsUsed says how far", async () => {
    const fake = fakeBudgetLlm({ replies: [SUMMARY], nCtx: 2600 });
    const r = await extractSummaryFitted(null, Array.from({ length: 12 }, (_, i) => digest(i)), "recent " + "0123456789".repeat(200), { deadline: deadline(), llm: fake.llm as any });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.digestsUsed).toBeLessThan(12);
    for (const c of fake.calls) expect(c.promptTokens + 500).toBeLessThanOrEqual(2600);
    expect(fake.calls[0]!.prompt).not.toContain("--- RECENT TRANSCRIPT ---");
  });

  it("a cut summary reply gets ONE brevity retry; cut again → retryable", async () => {
    const fake = fakeBudgetLlm({ replies: [{ text: "<summary><request>R", finish: "length" }, { text: "<summary>", finish: "length" }], nCtx: 8192 });
    const r = await extractSummaryFitted(null, [digest(0)], "", { deadline: deadline(), llm: fake.llm as any });
    expect(r.status).toBe("retryable");
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[1]!.prompt).toContain("Keep each field under 120 words");
  });

  it("one digest that alone cannot fit → `capacity:`", async () => {
    const fake = fakeBudgetLlm({ replies: [SUMMARY], nCtx: 900 });
    const r = await extractSummaryFitted(null, [digest(0)], "", { deadline: deadline(), llm: fake.llm as any });
    expect(r.status).toBe("retryable");
    if (r.status === "retryable") expect(r.reason).toMatch(/^capacity: /);
  });

  it("a summary reply that did not finish normally is retryable; every retry re-reads the capacity (T11-2, T11-8)", async () => {
    const odd = fakeBudgetLlm({ replies: [{ text: "", finish: "other" }], nCtx: 8192 });
    const r = await extractSummaryFitted(null, [digest(0)], "", { deadline: deadline(), llm: odd.llm as any });
    expect(r.status).toBe("retryable");
    const cut = fakeBudgetLlm({ replies: [{ text: "<summary><request>R", finish: "length" }, SUMMARY], nCtx: 8192 });
    const ok = await extractSummaryFitted(null, [digest(0)], "", { deadline: deadline(), llm: cut.llm as any });
    expect(ok.status).toBe("ok");
    expect(cut.capacityReads.length).toBe(cut.calls.length);   // one fresh read before each of the two calls
  });

  it("the stored summary is bounded — the preserved opening request included", async () => {
    const fake = fakeBudgetLlm({ replies: [SUMMARY], nCtx: 8192 });
    const r = await extractSummaryFitted(S("x".repeat(5000)), [digest(0)], "", { deadline: deadline(), llm: fake.llm as any });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.summary.request.length).toBeLessThanOrEqual(600);
      expect(r.summary.request.startsWith("xxx")).toBe(true);   // the opening request survives, capped
    }
    const c = capSummary(S("y".repeat(5000)));
    expect(c.request.length).toBeLessThanOrEqual(600);
    expect(c.learned.length).toBeLessThanOrEqual(800);
  });
});

describe("v0.41.2 codex T11 regressions — the observer", () => {
  it("a large line that fits a window alone is never held as `capacity:` behind many small lines (T11-1)", async () => {
    // A tokenizer that charges each line by its marker: the BIG line leaves the window one token, a small line costs 2.
    const tokens = (text: string) => {
      let t = 20;
      for (const line of text.split("\n")) {
        if (line.startsWith("[user]: [tool_result] BIG")) t += 799;
        else if (line.startsWith("[user]: [tool_result] s")) t += 2;
      }
      return t;
    };
    const fake = fakeBudgetLlm({ reply: (p) => (p.includes("Extract observations:") ? OBS("w") : ""), nCtx: 1600, tokens });
    const msgs: TranscriptMessage[] = [{ role: "user", content: "[tool_result] BIG " + "x".repeat(100), turn: 0 }];
    for (let i = 0; i < 98; i++) msgs.push({ role: "user", content: `[tool_result] s${i}`, turn: 0 });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    const windows = fake.calls.map(c => transcriptOf(c.prompt).split("\n"));
    expect(windows[0]).toEqual([renderObserverLines(msgs)[0]!.text]);   // the big line, alone
    expect(windows.flat()).toEqual(renderObserverLines(msgs).map(l => l.text));
  });

  it("a reply that did not finish normally is never parsed: empty text with finish `other` is retryable, not empty (T11-2)", async () => {
    const fake = fakeBudgetLlm({ replies: [{ text: "", finish: "other" }], nCtx: 8192 });
    const r = await extractObservationsWindowed(hexTurn(2), { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("retryable");
  });

  it("a /props that stops answering mid-run leaves the run UNVERIFIED with its progress; weak → strong is a change (T11-3)", async () => {
    let propsUp = true;
    const fake = fakeBudgetLlm({
      reply: (p) => { propsUp = false; return p.includes("Extract observations:") ? OBS("w") : ""; },
      nCtx: 4096, fingerprint: () => (propsUp ? "fp-1" : "weak-fp"), strength: () => (propsUp ? "strong" : "weak"),
    });
    const r = await extractObservationsWindowed(hexTurn(20), {
      llm: fake.llm as any, backend: B, deadline: deadline(), expectFingerprint: "fp-1", onProgress: () => true,
    });
    expect(r.status).toBe("unverified");
    if (r.status === "unverified") expect(r.doneThroughLine).toBeGreaterThan(0);
    const strong = fakeBudgetLlm({ reply: (p) => (p.includes("Extract observations:") ? OBS("w") : ""), nCtx: 4096 });
    const verified = await extractObservationsWindowed(hexTurn(20), {
      llm: strong.llm as any, backend: B, deadline: deadline(), expectFingerprint: "weak-fp", expectStrength: "weak",
    } as any);
    expect(verified.status).toBe("server_changed");
  });

  it("the measured call time is per model call: a window with a format retry adds TWO samples (T11-4)", async () => {
    const obs = await observerModule();
    obs.resetObserverCallStatsForTest?.();
    const fake = fakeBudgetLlm({ replies: ["<observation><type>bogus</type></observation>", OBS("after retry")], nCtx: 8192 });
    await extractObservationsWindowed(hexTurn(2), { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(fake.calls.length).toBe(2);
    expect(obs.observerCallStats?.().samples).toBe(2);
  });

  it("a validated oversize invalidates the measured template overhead the count used (T11-7)", async () => {
    const fake = fakeBudgetLlm({ replies: [OBS("after correction")], nCtx: 4096, method: "content" });
    const honest = fake.llm.countChatTokens;
    fake.llm.countChatTokens = async (content: string) => { const c = await honest(content); return { ...c, tokens: Math.floor(c.tokens * 0.4) }; };
    await extractObservationsWindowed(hexTurn(20), { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(fake.calls.some(c => c.promptTokens > 4096)).toBe(true);
    expect(fake.invalidated).toContain("fp-1");
  });

  it("the capacity is read before EVERY call: a retry re-fits to a context that shrank in between (T11-8)", async () => {
    let ctx = 8192;
    let first = true;
    const fake = fakeBudgetLlm({
      nCtx: () => ctx,
      reply: (p) => {
        if (!p.includes("Extract observations:")) return "";
        const out = first ? "<observation><type>bogus</type></observation>" : OBS("after retry");
        first = false;
        ctx = 4096;
        return out;
      },
    });
    const r = await extractObservationsWindowed(hexTurn(6), { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    // v0.41.4 §3.1: the observer's own retry feedback (v0.41.3's generic text named a `<content>` tag and echoed the reply).
    expect(fake.calls[1]!.prompt).toContain("Your previous reply could not be used:");
    expect(fake.calls[1]!.promptTokens + observerReplyReserve(4096)).toBeLessThanOrEqual(4096);
    expect(fake.capacityReads.length).toBeGreaterThanOrEqual(fake.calls.length);
  });

  it("an injected generate()-only LLM: a six-line dense unit is one prompt at the assumed 32,768 tokens; CLAWMEM_LLM_CONTEXT_TOKENS windows it (T11-9)", async () => {
    const prompts: string[] = [];
    const saved = process.env.CLAWMEM_LLM_CONTEXT_TOKENS;
    delete process.env.CLAWMEM_LLM_CONTEXT_TOKENS;
    setDefaultLlamaCpp({ generate: async (p: string) => { prompts.push(p); return { text: OBS("x"), model: "injected", done: true }; } } as any);
    try {
      const msgs = hexTurn(6);   // three windows at 4,096 — inside the 6-call cap
      expect((await extractObservationsResult(msgs, { timeoutMs: duration(600_000) })).status).toBe("ok");
      expect(prompts.length).toBe(1);
      process.env.CLAWMEM_LLM_CONTEXT_TOKENS = "4096";
      prompts.length = 0;
      expect((await extractObservationsResult(msgs, { timeoutMs: duration(600_000) })).status).toBe("ok");
      expect(prompts.length).toBeGreaterThan(1);
    } finally {
      if (saved === undefined) delete process.env.CLAWMEM_LLM_CONTEXT_TOKENS; else process.env.CLAWMEM_LLM_CONTEXT_TOKENS = saved;
      setDefaultLlamaCpp(null);
    }
  });

  it("the checkpoint contract covers the format-retry text and the CONTEXT sizes (T11-11)", async () => {
    const obs = await observerModule();
    const inputs = JSON.stringify(obs.observerContractInputs?.() ?? {});
    // v0.41.4 §1.5: the observer's own feedback strings (and its grammar) are what a checkpoint's contract hashes now.
    expect(inputs).toContain("Your previous reply could not be used:");
    expect(inputs).toContain("output exactly <none/> and nothing else");
    expect(inputs).toContain('"contextMaxChars":2000');
  });
});

describe("v0.41.2 codex T12 regressions — the observer", () => {
  /** Charges each transcript line by its marker; `heavyLast` makes a line cost 900 more when it ends the transcript. */
  const markerTokens = (costs: Record<string, number>, heavyLast?: string) => (text: string) => {
    let t = 20;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const [marker, cost] of Object.entries(costs)) {
        if (!line.startsWith(`[user]: [tool_result] ${marker}`)) continue;
        t += cost;
        if (marker === heavyLast && lines[i + 1] === "--- END TRANSCRIPT ---") t += 900;
      }
    });
    return t;
  };
  /** A one-line turn A, then `mid`, then one-line turns of 1 token up to the observer's 100 messages: the density guesses
   *  all fail, so the binary search decides. */
  function skewed(mid: TranscriptMessage[]): TranscriptMessage[] {
    const msgs: TranscriptMessage[] = [{ role: "user", content: "[tool_result] A0", turn: 0 }, ...mid];
    while (msgs.length < 100) msgs.push({ role: "user", content: `[tool_result] c${msgs.length}`, turn: 100 + msgs.length });
    return msgs;
  }

  it("a one-line turn ahead of a turn that fits a window alone: the window ends at the boundary after the first line (T12-2)", async () => {
    // At n_ctx 1,600 a window holds 800 marker tokens: A 300, then turn 1's ten lines of 60 (600 — whole alone, not after A).
    const turn1: TranscriptMessage[] = [];
    for (let i = 0; i < 10; i++) turn1.push({ role: "user", content: `[tool_result] B${i}`, turn: 1 });
    const msgs = skewed(turn1);
    const fake = fakeBudgetLlm({ reply: (p) => (p.includes("Extract observations:") ? OBS("w") : ""), nCtx: 1600, tokens: markerTokens({ A: 300, B: 60, c: 1 }) });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    const all = renderObserverLines(msgs).map(l => l.text);
    const windows = fake.calls.map(c => transcriptOf(c.prompt).split("\n"));
    expect(windows[0]).toEqual([all[0]!]);                       // turn 0 alone…
    expect(windows[1]!.slice(0, 10)).toEqual(all.slice(1, 11));  // …so turn 1 goes whole into the next window
    expect(windows.flat()).toEqual(all);
  });

  it("a snapped window is counted before it is sent: a shorter window the tokenizer charges more is never sent over budget (T12-2)", async () => {
    // Turn 1 is one line Z that costs 900 more when it ENDS the transcript: the boundary after it does not fit, though
    // the longer window cut inside turn 2 does. The snap must step down to the next boundary that fits.
    const mid: TranscriptMessage[] = [{ role: "user", content: "[tool_result] Z", turn: 1 }];
    for (let i = 0; i < 10; i++) mid.push({ role: "user", content: `[tool_result] B${i}`, turn: 2 });
    const msgs = skewed(mid);
    const fake = fakeBudgetLlm({
      reply: (p) => (p.includes("Extract observations:") ? OBS("w") : ""), nCtx: 1600, tokens: markerTokens({ A: 300, Z: 1, B: 60, c: 1 }, "Z"),
    });
    expect(renderObserverLines(msgs)[0]!.text).toBe("[user]: [tool_result] A0");
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    for (const c of fake.calls) expect(c.promptTokens + observerReplyReserve(1600)).toBeLessThanOrEqual(1600);
    expect(fake.calls.flatMap(c => transcriptOf(c.prompt).split("\n"))).toEqual(renderObserverLines(msgs).map(l => l.text));
  });

  it("an injected generate()-only LLM: the largest unit the observer takes (100 dense tool lines) is two windows at the assumed 32,768 tokens (T12-7)", async () => {
    const prompts: string[] = [];
    const saved = process.env.CLAWMEM_LLM_CONTEXT_TOKENS;
    delete process.env.CLAWMEM_LLM_CONTEXT_TOKENS;
    setDefaultLlamaCpp({ generate: async (p: string) => { prompts.push(p); return { text: OBS("x"), model: "injected", done: true }; } } as any);
    try {
      // The opening request, 98 dense tool results cut at the 500-character cap, the answer: 100 lines of dense hex.
      const msgs: TranscriptMessage[] = [{ role: "user", content: "check the hashes in the manifest", turn: 0, opening: true }];
      for (let i = 0; i < 98; i++) msgs.push({ role: "user", content: `[tool_result] ${"0123456789abcdef".repeat(40)}`, turn: 0 });
      msgs.push({ role: "assistant", content: "All hashes match the manifest.", turn: 0 });
      const lines = renderObserverLines(msgs);
      expect(lines.length).toBe(100);
      expect(lines.filter(l => l.text.endsWith("...")).length).toBe(98);
      expect((await extractObservationsResult(msgs, { timeoutMs: duration(600_000) })).status).toBe("ok");
      expect(prompts.length).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.CLAWMEM_LLM_CONTEXT_TOKENS; else process.env.CLAWMEM_LLM_CONTEXT_TOKENS = saved;
      setDefaultLlamaCpp(null);
    }
  });
});
