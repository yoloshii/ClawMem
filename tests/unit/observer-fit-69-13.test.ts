/**
 * BACKLOG 69.13 — the window fitter tries every smaller CONTEXT before it holds a window's first line as `capacity:`.
 *
 * Baseline (v0.41.4): `fitWindow` takes the FULLEST context that leaves MIN_TRANSCRIPT_TOKENS and fits lines under it;
 * when the window's first line alone does not fit there it returns `capacity: one message needs …` without trying the
 * next, smaller context — under which the line fits. A later window's context grows with the EARLIER tail, the turn's
 * anchor and the unit's own titles, so a window that fits holds instead, the same on every resume; a format retry's
 * feedback, added to the fullest context, holds a window the same way. Measured on v0.41.4 with this file's fake: a
 * 1,006-token line at a 4,096-token context is held with 551 tokens of room while the anchor-only context leaves 1,222.
 * Each test below fails on v0.41.4 for the reason its name gives, except the guard (marked), which holds on both.
 *
 * The geometry (line sizes against context sizes) is asserted from the counted prompts, so a later change to the prompt
 * text that moves the numbers fails a guard by name instead of testing nothing.
 */
import { describe, it, expect } from "bun:test";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { fakeBudgetLlm } from "../helpers/fake-budget-llm.ts";
import { extractObservationsWindowed, observerReplyReserve } from "../../src/observer.ts";
import type { TranscriptMessage } from "../../src/hooks.ts";

const B = { kind: "remote", root: "http://fake-llm" } as const;
const deadline = () => deadlineAfter(monoNow(), duration(600_000));
const MARGIN = 4;   // the fake's count margin
const ASK = "check the hashes in the manifest";
const OBS = (t: string) =>
  `<observation><type>discovery</type><title>${t}</title><facts><fact>${t} happened in the session</fact></facts><narrative>n</narrative></observation>`;
const transcriptOf = (p: string) => {
  const i = p.indexOf("--- TRANSCRIPT ---\n");
  return i < 0 ? "" : p.slice(i + "--- TRANSCRIPT ---\n".length, p.indexOf("\n--- END TRANSCRIPT ---", i));
};
const contextOf = (p: string) => p.slice(0, p.indexOf("--- TRANSCRIPT ---\n"));
/** A tool result of dense hex: ~330 fake tokens, 476 characters (under the 500-character tool cap). */
const hex = (i: number, turn = 0): TranscriptMessage => ({ role: "user", content: `[tool_result] sha ${i}: ${"0123456789abcdef".repeat(28)}`, turn });
/** The turn's final answer — a critical line of 1,000 digits (its cap): ~1,006 fake tokens. */
const BIG = "0123456789".repeat(100);
const big = (turn = 0): TranscriptMessage => ({ role: "assistant", content: BIG, turn });
/** One turn: the ask, `k` hex tool results, the 1,000-digit answer. */
const unit = (k: number): TranscriptMessage[] => [{ role: "user", content: ASK, turn: 0, opening: true }, ...Array.from({ length: k }, (_, i) => hex(i)), big()];
/** A counted prompt with no transcript lines: a window's fixed part (system prompt + CONTEXT [+ feedback]). */
const isFixed = (p: string) => p.includes("--- TRANSCRIPT ---\n\n--- END TRANSCRIPT ---");
const budgetAt = (nCtx: number) => nCtx - observerReplyReserve(nCtx);
const numbered = () => { let n = 0; return (p: string) => (p.includes("Extract observations:") ? OBS(`window ${++n}`) : ""); };

describe("BACKLOG 69.13 a window's first line that fits under a smaller CONTEXT is never held", () => {
  it("a later window: the line misses the fullest context but fits under the anchor-only one — it is sent there", async () => {
    // Three hex lines: the line's window starts past the turn's ask, so its contexts are EARLIER tail + anchor + titles,
    // anchor + titles, titles, none (the ask is outside the 1,100-character tail).
    const fake = fakeBudgetLlm({ reply: numbered(), nCtx: 4096 });
    const r = await extractObservationsWindowed(unit(3), { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    const last = fake.calls[fake.calls.length - 1]!.prompt;
    expect(transcriptOf(last)).toBe(`[assistant]: ${BIG}`);
    // The fullest context that fits: the turn's ask and the unit's titles stay; the EARLIER tail (the hex lines) goes.
    expect(contextOf(last)).toContain(`[user]: ${ASK}`);
    expect(contextOf(last)).toContain("- window 1");
    expect(contextOf(last)).not.toContain("sha 1:");
    expect(contextOf(last)).not.toContain("sha 2:");
    for (const c of fake.calls) expect(c.promptTokens + observerReplyReserve(4096)).toBeLessThanOrEqual(4096);
    // Geometry: the fullest context passes the 512-token minimum, yet leaves less room than the line takes.
    const budget = budgetAt(4096);
    const full = fake.counts.filter(isFixed).find(p => p.includes("sha 2:") && p.includes(`[user]: ${ASK}`));
    expect(full).toBeDefined();
    const fullFixed = fake.tokens(full!) + fake.overhead;
    expect(fullFixed + MARGIN + 512).toBeLessThanOrEqual(budget);
    const line = fake.tokens(last) - fake.tokens(last.replace(`[assistant]: ${BIG}`, ""));
    expect(line).toBeGreaterThan(budget - fullFixed - MARGIN);
  });

  it("a later window whose ask sits in the EARLIER tail: no anchor-only context exists, so the titles-only one takes the line", async () => {
    // One hex line: window 1 is the ask + that line, so the line's window shows the ask inside its tail — its contexts
    // are tail + titles, titles, none.
    const fake = fakeBudgetLlm({ reply: numbered(), nCtx: 4096 });
    const r = await extractObservationsWindowed(unit(1), { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    const last = fake.calls[fake.calls.length - 1]!.prompt;
    expect(transcriptOf(last)).toBe(`[assistant]: ${BIG}`);
    expect(contextOf(last)).toContain("--- ALREADY RECORDED (do not repeat) ---");
    expect(contextOf(last)).not.toContain("--- EARLIER IN THIS EXCHANGE");
    for (const c of fake.calls) expect(c.promptTokens + observerReplyReserve(4096)).toBeLessThanOrEqual(4096);
    // Geometry: the fullest context (the tail with the ask, and the titles) passes the 512-token minimum — so the
    // context choice takes it — yet leaves less room than the line takes.
    const budget = budgetAt(4096);
    const full = fake.counts.filter(isFixed).find(p => p.includes("sha 0:"));
    expect(full).toBeDefined();
    const fullFixed = fake.tokens(full!) + fake.overhead;
    expect(fullFixed + MARGIN + 512).toBeLessThanOrEqual(budget);
    const line = fake.tokens(last) - fake.tokens(last.replace(`[assistant]: ${BIG}`, ""));
    expect(line).toBeGreaterThan(budget - fullFixed - MARGIN);
  });

  it("no context leaves room: still `capacity:`, and the hold reports the emptiest context's room", async () => {
    const fake = fakeBudgetLlm({ reply: numbered(), nCtx: 2900 });
    const r = await extractObservationsWindowed(unit(1), { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("retryable");
    const empty = fake.counts.filter(isFixed).find(p => !p.includes("--- EARLIER") && !p.includes("--- ALREADY"));
    expect(empty).toBeDefined();
    const room = budgetAt(2900) - (fake.tokens(empty!) + fake.overhead) - MARGIN;
    if (r.status === "retryable") expect(r.reason).toMatch(new RegExp(`^capacity: one message needs \\d+ tokens; a window holds ${room}$`));
    expect(fake.calls.every(c => !transcriptOf(c.prompt).includes(BIG))).toBe(true);   // the line was never sent
  });

  it("a format retry whose feedback leaves no room under the fullest context is sent under a smaller one", async () => {
    const prior: TranscriptMessage[] = [
      { role: "user", content: "0123456789".repeat(11), turn: 0, opening: true },
      { role: "assistant", content: "0123456789".repeat(11), turn: 0 },
    ];
    const fake = fakeBudgetLlm({ replies: ["this is not an observation reply", OBS("the answer")], nCtx: 4096 });
    const r = await extractObservationsWindowed([big()], {
      llm: fake.llm as any, backend: B, deadline: deadline(), context: { priorMessages: prior, recordedTitles: ["an earlier observation"] },
    });
    expect(r.status).toBe("ok");
    expect(fake.calls).toHaveLength(2);
    const [first, retry] = fake.calls.map(c => c.prompt);
    expect(contextOf(first!)).toContain("0123456789".repeat(11));          // the first call: the fullest context
    expect(first).not.toContain("Your previous reply could not be used:");
    expect(retry).toContain("Your previous reply could not be used:");       // the retry: the feedback …
    expect(contextOf(retry!)).not.toContain("0123456789".repeat(11));        // … under the titles-only context
    expect(contextOf(retry!)).toContain("- an earlier observation");
    expect(transcriptOf(retry!)).toBe(`[assistant]: ${BIG}`);
    for (const c of fake.calls) expect(c.promptTokens + observerReplyReserve(4096)).toBeLessThanOrEqual(4096);
    // Geometry: under the fullest context the line fits without the feedback and misses with it.
    const budget = budgetAt(4096);
    const fixedFull = fake.counts.filter(isFixed).filter(p => p.includes("0123456789".repeat(11)));
    const withFb = fixedFull.find(p => p.includes("Your previous reply could not be used:"));
    const without = fixedFull.find(p => !p.includes("Your previous reply could not be used:"));
    expect(withFb).toBeDefined();
    expect(without).toBeDefined();
    const line = fake.tokens(first!) - fake.tokens(first!.replace(`[assistant]: ${BIG}`, ""));
    expect(line).toBeLessThanOrEqual(budget - (fake.tokens(without!) + fake.overhead) - MARGIN);
    expect(line).toBeGreaterThan(budget - (fake.tokens(withFb!) + fake.overhead) - MARGIN);
    // … and with the feedback the fullest context still passes the 512-token minimum, so the retry's context choice
    // takes it and only the fallback can reach the titles-only form.
    expect(fake.tokens(withFb!) + fake.overhead + MARGIN + 512).toBeLessThanOrEqual(budget);
  });

  it("(guard, holds on v0.41.4) a later window whose first line fits under the fullest context keeps that context", async () => {
    const fake = fakeBudgetLlm({ reply: numbered(), nCtx: 4096 });
    const msgs: TranscriptMessage[] = [{ role: "user", content: ASK, turn: 0, opening: true }, ...Array.from({ length: 5 }, (_, i) => hex(i))];
    msgs.push({ role: "assistant", content: "All hashes match the manifest.", turn: 0 });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    expect(fake.calls.length).toBeGreaterThan(1);
    for (const c of fake.calls.slice(1)) {
      expect(contextOf(c.prompt)).toContain("--- EARLIER IN THIS EXCHANGE");
      expect(contextOf(c.prompt)).toContain("[tool_result] sha ");             // the EARLIER tail: the fullest context
    }
    expect(fake.calls.flatMap(c => transcriptOf(c.prompt).split("\n")).length).toBe(msgs.length);
  });
});
