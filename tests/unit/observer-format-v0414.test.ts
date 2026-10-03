/**
 * v0.41.4 (BACKLOG 69.3) — the observer's replies parse, and a non-answer is never "nothing" (DESIGN-v0414.md r7).
 *
 * Baseline (v0.41.3, prod 2026-10-03): on the documented observer model (qmd-query-expansion-1.7B) 34 replies to three
 * held ranges gave 2 valid answers: `<type>tool_use</type>` copied from the transcript, `<type>...</type>` copied from
 * the prompt, query-expansion lines taken as "nothing" (a short markup-free reply was `[]`), and a format retry whose
 * feedback named a nonexistent `<content>` tag and echoed the bad reply. Each test here fails on v0.41.3 for the reason
 * its name gives, except those named "(guard)", which pin a behaviour v0.41.3 already has and v0.41.4 must keep. New
 * exports are read through the module namespace so a missing one fails its own test, not the file.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { fakeBudgetLlm } from "../helpers/fake-budget-llm.ts";
import { extractObservationsWindowed, extractSummaryFitted, parseObservationReply, renderObserverLines } from "../../src/observer.ts";
import type { TranscriptMessage } from "../../src/hooks.ts";

const observerModule = () => import("../../src/observer.ts") as Promise<Record<string, any>>;
const B = { kind: "remote", root: "http://fake-llm" } as const;
const deadline = () => deadlineAfter(monoNow(), duration(600_000));
const any = (x: unknown) => x as any;

/** A valid block; `parts` override single elements. */
function block(parts: { type?: string; title?: string; facts?: string[]; triples?: string; narrative?: string } = {}): string {
  const facts = (parts.facts ?? ["The parser rejects copied tool roles"]).map(f => `<fact>${f}</fact>`).join("");
  return `<observation><type>${parts.type ?? "discovery"}</type><title>${parts.title ?? "Observer replies parse"}</title>`
    + `<facts>${facts}</facts>${parts.triples ?? ""}<narrative>${parts.narrative ?? "The model copied a role from the transcript."}</narrative></observation>`;
}
const triple = (s: string, p: string, o: string) => `<triples><triple><subject>${s}</subject><predicate>${p}</predicate><object>${o}</object></triple></triples>`;

/** Two short turns: enough for one window. */
const msgs: TranscriptMessage[] = [
  { role: "user", content: "fix the observer parser", turn: 0, opening: true },
  { role: "assistant", content: "I updated src/observer.ts so a copied tool role is rejected.", turn: 0 },
];

/** An in-memory OverheadStore with the atomic `update` the v0.41.4 records need. */
function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => { m.set(k, v); },
    delete: (k: string) => { m.delete(k); },
    update: (k: string, fn: (old: string | null) => string | null) => {
      const next = fn(m.get(k) ?? null);
      if (next === null) m.delete(k); else m.set(k, next);
    },
  };
}

/** The fake, with the grammar each call carried recorded and an optional HTTP status for grammar requests. */
function grammarFake(o: Parameters<typeof fakeBudgetLlm>[0] & { refuseGrammar?: boolean; onCall?: (grammar: string | undefined) => void }) {
  const base = fakeBudgetLlm(o);
  const grammars: (string | undefined)[] = [];
  const llm = {
    ...base.llm,
    generateDetailed: async (prompt: string, opts: any) => {
      grammars.push(opts.grammar);
      o.onCall?.(opts.grammar);
      if (opts.grammar && o.refuseGrammar) return { ok: false, reason: "http", status: 400, backend: opts.backend };
      return base.llm.generateDetailed(prompt, opts);
    },
  };
  return { ...base, llm, grammars };
}

afterEach(() => { delete process.env.CLAWMEM_OBSERVER_GRAMMAR; });

describe("v0.41.4 only <none/> is nothing (G1, §2.1)", () => {
  it("query-expansion lines are a failure (no-blocks), not [] — v0.41.3 committed them as empty", () => {
    const r = any(parseObservationReply(". skill: designed-elements\n. skill: designed-elements usage"));
    expect(r.ok).toBe(false);
    expect(r.failure?.reason).toBe("no-blocks");
  });

  it("an empty reply is a failure (empty-reply), not []", () => {
    const r = any(parseObservationReply("   \n"));
    expect(r.ok).toBe(false);
    expect(r.failure?.reason).toBe("empty-reply");
  });

  it("<none/> (also fenced) is []", () => {
    for (const t of ["<none/>", "  <none/>\n", "```xml\n<none/>\n```"]) {
      const r = any(parseObservationReply(t));
      expect(r.ok).toBe(true);
      expect(r.value).toEqual([]);
    }
  });

  it("valid blocks beside <none/> win (guard)", () => {
    const r = any(parseObservationReply(`<none/>\n${block()}`));
    expect(r.ok).toBe(true);
    expect(r.value.length).toBe(1);
  });
});

describe("v0.41.4 a rejected block says why, in classes (§2.3)", () => {
  it("<type>tool_use</type> → type-not-allowed (tool-role)", () => {
    const r = any(parseObservationReply(block({ type: "tool_use" })));
    expect(r.ok).toBe(false);
    expect(r.failure?.rejections?.[0]).toMatchObject({ field: "type", reason: "type-not-allowed", valueClass: "tool-role" });
  });

  it("<type>tool_use name=\"Bash\"</type> → tool-role; <type>...</type> → placeholder; a pasted type list → type-list", () => {
    expect(any(parseObservationReply(block({ type: 'tool_use name="Bash"' }))).failure?.rejections?.[0]?.valueClass).toBe("tool-role");
    expect(any(parseObservationReply(block({ type: "..." }))).failure?.rejections?.[0]?.valueClass).toBe("placeholder");
    expect(any(parseObservationReply(block({ type: "decision | bugfix" }))).failure?.rejections?.[0]?.valueClass).toBe("type-list");
    expect(any(parseObservationReply(block({ type: "decision, bugfix, feature" }))).failure?.rejections?.[0]?.valueClass).toBe("type-list");
  });

  it("a block whose only fact is too short after decoding and trimming → facts-empty", () => {
    const r = any(parseObservationReply(block({ facts: ["A    "] })));
    expect(r.ok).toBe(false);
    expect(r.failure?.rejections?.[0]?.reason).toBe("facts-empty");
  });

  it("a blank title is title-empty (content), an absent one title-missing", () => {
    const blank = any(parseObservationReply(block({ title: "   " })));
    expect(blank.failure?.rejections?.[0]?.reason).toBe("title-empty");
    const absent = any(parseObservationReply("<observation><type>discovery</type><facts><fact>A fact that is long</fact></facts></observation>"));
    expect(absent.failure?.rejections?.[0]?.reason).toBe("title-missing");
  });
});

describe("v0.41.4 units and decoding (§2.4)", () => {
  it("a 41-letter astral subject keeps its triple (bounds in code points, not UTF-16 units)", () => {
    const subject = "𝐀".repeat(41);
    const r = any(parseObservationReply(block({ triples: triple(subject, "uses", "Bun") })));
    expect(r.ok).toBe(true);
    expect(r.value[0].triples?.[0]?.subject).toBe(subject);
  });

  it("a title of 100 astral letters is cut to 80 letters, never splitting a pair", () => {
    const r = any(parseObservationReply(block({ title: "𝐀".repeat(100) })));
    expect(Array.from(r.value[0].title).length).toBe(80);
  });

  it("one decode of &lt; &gt; &amp;: a fact `Array&lt;T&gt;` reads `Array<T>`, `&amp;lt;` reads `&lt;`", () => {
    const r = any(parseObservationReply(block({ facts: ["Use Array&lt;T&gt; for the window lines", "The literal &amp;lt; stays escaped once"] })));
    expect(r.value[0].facts).toEqual(["Use Array<T> for the window lines", "The literal &lt; stays escaped once"]);
  });

  it("`A&amp;B` is three characters after decoding — too short for a fact", () => {
    const r = any(parseObservationReply(block({ facts: ["A&amp;B", "A second fact that is long enough"] })));
    expect(r.value[0].facts).toEqual(["A second fact that is long enough"]);
  });
});

describe("v0.41.4 guards (§5)", () => {
  it("identical facts collapse within a block; case-distinct ones stay", () => {
    const r = any(parseObservationReply(block({ facts: ["Use Foo for requests", "Use Foo for requests", "Use foo for requests"] })));
    expect(r.value[0].facts).toEqual(["Use Foo for requests", "Use foo for requests"]);
  });

  it("a triple naming a tool-call id, or one whose subject equals its object, is dropped", () => {
    const r1 = any(parseObservationReply(block({ triples: triple("toolu_01NiKPR3x4gz6xV9Q4d7XQYd", "uses", "SERVING-CONFIG.md") })));
    expect(r1.value[0].triples).toBeUndefined();
    const r2 = any(parseObservationReply(block({ triples: triple("observer", "uses", "observer") })));
    expect(r2.value[0].triples).toBeUndefined();
  });

  it("an echoed {{entity}} skeleton token is dropped as an identifier; {{user.name}} is kept", () => {
    const echoed = any(parseObservationReply(block({ triples: triple("{{entity}}", "uses", "Bun") })));
    expect(echoed.value[0].triples).toBeUndefined();
    const real = any(parseObservationReply(block({ triples: triple("{{user.name}}", "uses", "Handlebars") })));
    expect(real.value[0].triples?.[0]?.subject).toBe("{{user.name}}");
  });

  it("a fact restating a prompt clause is kept and counted, never dropped", () => {
    const r = any(parseObservationReply(block({ facts: ["brief descriptive title, max 80 chars"] })));
    expect(r.ok).toBe(true);
    expect(r.value[0].facts).toEqual(["brief descriptive title, max 80 chars"]);
    expect(r.advisories?.instructionEcho).toBe(1);
  });
});

describe("v0.41.4 feedback that can repair (§3.1)", () => {
  it("names the field, the class and the allowed values; no <content>; no echo of the reply", async () => {
    const m = await observerModule();
    expect(typeof m.observationFeedback).toBe("function");
    const failure = any(parseObservationReply(block({ type: "tool_use", narrative: "DISTINCTIVE-NARRATIVE-TEXT" }))).failure;
    const fb: string = m.observationFeedback(failure);
    expect(fb).toContain("<type>");
    expect(fb).toContain("decision, bugfix, feature");
    expect(fb).toContain("<none/>");
    expect(fb).not.toContain("<content>");
    expect(fb).not.toContain("DISTINCTIVE-NARRATIVE-TEXT");
  });

  it("the feedback stays within the retry reserve whatever the rejections (OBSERVER_RETRY_FEEDBACK_MAX_CHARS)", async () => {
    const m = await observerModule();
    const reasons = ["type-not-allowed", "type-missing", "title-missing", "title-empty", "title-placeholder", "facts-empty"];
    const rejections = [...reasons, ...reasons].map(reason => ({ field: "type", reason, valueClass: reason === "type-not-allowed" ? "type-list" : undefined }));
    for (const failure of [{ reason: "blocks-rejected", rejections }, { reason: "no-blocks", rejections: [] }, { reason: "empty-reply", rejections: [] }]) {
      expect(m.observationFeedback(failure).length + 2).toBeLessThanOrEqual(m.OBSERVER_RETRY_FEEDBACK_MAX_CHARS);
    }
  });

  it("the windowed loop's retry carries that feedback, not v0.41.3's", async () => {
    const fake = grammarFake({ replies: [block({ type: "tool_use", narrative: "DISTINCTIVE-NARRATIVE-TEXT" }), block()], nCtx: 8192 });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    const retry = fake.calls[1]!.prompt;
    expect(retry).not.toContain("<content>");
    expect(retry).not.toContain("DISTINCTIVE-NARRATIVE-TEXT");
    expect(retry).toContain("<none/>");
  });

  it("the handoff summary's malformed-reply retry keeps v0.41.3's feedback, byte for byte (guard)", async () => {
    const fake = grammarFake({ replies: ["no summary here", "<summary><request>Fix the parser</request><completed>Fixed</completed></summary>"], nCtx: 8192 });
    const digest = { request: "fix the observer parser", outcome: "fixed", files: [] };
    const r = await extractSummaryFitted(null, [digest], "", { deadline: deadline(), llm: fake.llm as any });
    expect(r.status).toBe("ok");
    expect(fake.calls[1]!.prompt.endsWith([
      "The previous response did not match the expected structure.", "Error:",
      "No <summary>...</summary> block found in the response. Wrap the summary in <summary> tags.", "",
      "Previous response (first 500 chars):", "no summary here", "", "Return only the expected structure this time.",
    ].join("\n"))).toBe(true);
    expect(fake.grammars.every(g => g === undefined)).toBe(true);   // only the observer's windowed calls carry a grammar
  });

  it("the prompt names the types, uses {{…}} skeletons and asks for <none/> (§1)", async () => {
    const fake = grammarFake({ replies: ["<none/>"], nCtx: 8192 });
    await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    const p = fake.calls[0]!.prompt;
    // r8 (live check): the list lives in the type rule; written into the structure's <type> line, the model copied it.
    expect(p).toContain("- <type>: exactly one of: decision, bugfix, feature, refactor, discovery, change, preference, milestone, problem — never a transcript role or tool name such as tool_use or tool_result");
    expect(p).toContain("<type>{{type}}</type>");
    expect(p).toContain("<title>{{title}}</title>");
    expect(p).not.toContain("<type>...</type>");
    expect(p).toContain("output exactly <none/>");
  });
});

describe("v0.41.4 retries end inside the invocation (§3.2)", () => {
  it("a one-call invocation whose reply is unparseable ends retryable with its class — v0.41.3 returned partial", async () => {
    const fake = grammarFake({ replies: [block({ type: "tool_use" })], nCtx: 8192 });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline(), maxCalls: 1 });
    expect(r.status).toBe("retryable");
    if (r.status === "retryable") expect(r.reason).toBe("no parseable response: type-not-allowed (tool-role)");
  });

  it("two corrective retries per window: bad, bad, good → ok in three calls", async () => {
    const fake = grammarFake({ replies: [block({ type: "tool_use" }), block({ type: "..." }), block()], nCtx: 8192 });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    expect(fake.calls.length).toBe(3);
  });

  it("prose 'nothing' is recovered by the retry that names <none/>", async () => {
    const fake = grammarFake({ replies: ["No significant observations.", "<none/>"], nCtx: 8192 });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("empty");
    expect(fake.calls.length).toBe(2);
  });

  it("after a format failure, a retry whose capacity read cannot be verified ends retryable, not a continuation", async () => {
    let reads = 0;
    const fake = grammarFake({ replies: [block({ type: "tool_use" }), block()], nCtx: 8192, strength: () => (++reads <= 1 ? "strong" : "weak") });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("retryable");
  });

  it("a cut reply with no call left ends retryable and persists the halved window bound", async () => {
    const lines = renderObserverLines(msgs).length;
    expect(lines).toBe(2);
    const fake = grammarFake({ replies: [{ text: "<observation><type>disc", finish: "length" }], nCtx: 8192 });
    const progress: any[] = [];
    const r = await extractObservationsWindowed(msgs, {
      llm: fake.llm as any, backend: B, deadline: deadline(), maxCalls: 1, onProgress: (p: any) => { progress.push(p); return true; },
    });
    expect(r.status).toBe("retryable");
    expect(progress.at(-1)?.windowBound).toEqual({ start: 0, maxLines: 1 });
  });

  it("a persisted window bound is honoured by the next invocation", async () => {
    const fake = grammarFake({ replies: [block()], nCtx: 8192 });
    await extractObservationsWindowed(msgs, {
      llm: fake.llm as any, backend: B, deadline: deadline(),
      resume: { doneThroughLine: 0, observations: [], titles: [], windowBound: { start: 0, maxLines: 1 } } as any,
    });
    const first = fake.calls[0]!.prompt;
    expect(first).toContain("[user]: fix the observer parser");
    expect(first).not.toContain("[assistant]: I updated src/observer.ts");
  });
});

describe("v0.41.4 a validated context ceiling persists per /props value (§3.3a)", () => {
  it("an oversize with no call left records the ceiling; the next invocation's first call fits", async () => {
    const store = memStore();
    const serverCtx = 4096;   // the server's real context; /props keeps claiming 8192
    const props = fakeBudgetLlm({ replies: [block()], nCtx: 8192 });
    const sent: number[] = [];
    const llm = {
      ...props.llm,
      generateDetailed: async (prompt: string, o: any) => {
        const t = props.tokens(prompt) + props.overhead;
        sent.push(t);
        if (t > serverCtx) return { ok: false, reason: "context_exceeded", nCtx: serverCtx, promptTokens: t, backend: o.backend };
        return props.llm.generateDetailed(prompt, o);
      },
    };
    // 81 lines of ~68 tokens: a window sized for 8192 overflows 4096; one sized for 4096 holds a dozen lines.
    const long: TranscriptMessage[] = [msgs[0]!, ...Array.from({ length: 80 }, (_, i) => ({
      role: "assistant" as const, content: `step ${i}: ` + "the observer fix carried more detail here. ".repeat(5), turn: 0,
    }))];
    const r1 = await extractObservationsWindowed(long, { llm: llm as any, backend: B, deadline: deadline(), maxCalls: 1, overheadStore: store as any });
    expect(sent.length).toBe(1);
    expect(sent[0]!).toBeGreaterThan(serverCtx);
    expect(r1.status).toBe("retryable");
    if (r1.status === "retryable") expect(r1.reason).toBe("capacity: the corrected window was not tried");
    const keys = [...store.m.keys()].filter(k => k.startsWith("observer-nctx:"));
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/:8192$/);
    expect(JSON.parse(store.m.get(keys[0]!)!).ceiling).toBe(serverCtx);
    // The next one-call invocation reads /props 8192 again, applies the 4096 ceiling, and its first call fits.
    const r2 = await extractObservationsWindowed(long, { llm: llm as any, backend: B, deadline: deadline(), maxCalls: 1, overheadStore: store as any });
    expect(sent.length).toBe(2);
    expect(sent[1]!).toBeLessThanOrEqual(serverCtx);
    expect(r2.status).toBe("partial");
    if (r2.status === "partial") expect(r2.doneThroughLine).toBeGreaterThan(0);
  });

  it("two writers for one /props value keep the minimum, in either order", async () => {
    const m = await observerModule();
    expect(typeof m.mergeContextCeiling).toBe("function");
    const now = Date.now();
    const a = m.mergeContextCeiling(null, 6144, now);
    const b = m.mergeContextCeiling(a, 4096, now + 1);
    const c = m.mergeContextCeiling(b, 6144, now + 2);
    expect(JSON.parse(c).ceiling).toBe(4096);
  });

  it("an expired lower ceiling does not hold back a newly validated higher one", async () => {
    const m = await observerModule();
    const old = JSON.stringify({ ceiling: 2048, at: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    expect(JSON.parse(m.mergeContextCeiling(old, 4096, Date.now())).ceiling).toBe(4096);
  });
});

describe("v0.41.4 grammar-constrained decoding (§4)", () => {
  it("a strong-fingerprint backend gets the grammar: every type, predicate and concept enumerated", async () => {
    const fake = grammarFake({ replies: [block()], nCtx: 8192 });
    await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    const g = fake.grammars[0];
    expect(typeof g).toBe("string");
    for (const v of ["decision", "skill_usage", "milestone", "integrates_with", "owned_by", "trade-off", "<none/>"]) {
      if (v === "skill_usage") continue;   // canonical has no skill types
      expect(g).toContain(v);
    }
  });

  it("a weak fingerprint, or CLAWMEM_OBSERVER_GRAMMAR=off, sends no grammar (guard)", async () => {
    const weak = grammarFake({ replies: [block()], nCtx: 8192, strength: () => "weak" });
    await extractObservationsWindowed(msgs, { llm: weak.llm as any, backend: B, deadline: deadline() });
    expect(weak.grammars[0]).toBeUndefined();
    process.env.CLAWMEM_OBSERVER_GRAMMAR = "off";
    const off = grammarFake({ replies: [block()], nCtx: 8192 });
    await extractObservationsWindowed(msgs, { llm: off.llm as any, backend: B, deadline: deadline() });
    expect(off.grammars[0]).toBeUndefined();
  });

  it("a grammar request's 400 writes the grammar-off record and the next call is grammarless", async () => {
    const store = memStore();
    const fake = grammarFake({ replies: [block()], nCtx: 8192, refuseGrammar: true });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline(), overheadStore: store as any });
    expect(r.status).toBe("ok");
    expect(typeof fake.grammars[0]).toBe("string");
    expect(fake.grammars[1]).toBeUndefined();
    const key = [...store.m.keys()].find(k => k.startsWith("observer-grammar:"));
    const rec = JSON.parse(store.m.get(key!)!);
    expect(rec.count).toBe(1);
    expect(rec.pending).toBe(false);   // the grammarless call got a response with the generation unchanged
    expect(Date.parse(rec.offUntil)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("an obligation survives a 400 that lands while the grammarless call is in flight (generation compare)", async () => {
    const store = memStore();
    let keyOf = "";
    const fake = grammarFake({
      replies: [block()], nCtx: 8192, refuseGrammar: true,
      onCall: (grammar) => {
        if (grammar !== undefined) return;
        keyOf = [...store.m.keys()].find(k => k.startsWith("observer-grammar:")) ?? "";
        if (keyOf === "") return;
        const rec = JSON.parse(store.m.get(keyOf)!);
        store.m.set(keyOf, JSON.stringify({ ...rec, count: rec.count + 1, pending: true }));   // a concurrent 400
      },
    });
    await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline(), overheadStore: store as any });
    expect(typeof fake.grammars[0]).toBe("string");
    expect(keyOf).not.toBe("");
    expect(JSON.parse(store.m.get(keyOf)!).pending).toBe(true);
  });

  it("a pending obligation keeps calls grammarless after offUntil has passed", async () => {
    const store = memStore();
    const probe = grammarFake({ replies: [block()], nCtx: 8192, refuseGrammar: true });
    const p = await extractObservationsWindowed(msgs, { llm: probe.llm as any, backend: B, deadline: deadline(), overheadStore: store as any, maxCalls: 1 });
    expect(typeof probe.grammars[0]).toBe("string");
    expect(p.status).toBe("retryable");
    if (p.status === "retryable") expect(p.reason).toBe("grammar: HTTP 400 on a grammar request; the grammarless retry was not reached");
    const key = [...store.m.keys()].find(k => k.startsWith("observer-grammar:")) ?? "";
    expect(key).not.toBe("");
    const rec = JSON.parse(store.m.get(key)!);
    expect(rec.pending).toBe(true);
    store.m.set(key, JSON.stringify({ ...rec, offUntil: new Date(Date.now() - 60_000).toISOString(), pending: true }));
    const next = grammarFake({ replies: [block()], nCtx: 8192 });
    await extractObservationsWindowed(msgs, { llm: next.llm as any, backend: B, deadline: deadline(), overheadStore: store as any });
    expect(next.grammars[0]).toBeUndefined();
    // Its response cleared the obligation; with offUntil passed, the next grammar request re-tests the server.
    expect(JSON.parse(store.m.get(key)!).pending).toBe(false);
    const again = grammarFake({ replies: [block()], nCtx: 8192 });
    await extractObservationsWindowed(msgs, { llm: again.llm as any, backend: B, deadline: deadline(), overheadStore: store as any });
    expect(typeof again.grammars[0]).toBe("string");
  });

  it("a completed grammar reply that fails structurally is counted; a cut one is not", async () => {
    const m = await observerModule();
    expect(typeof m.takeObserverStats).toBe("function");
    m.takeObserverStats();
    const fake = grammarFake({ replies: [{ text: "<observation><type>disc", finish: "length" }, "plain prose despite the grammar", block()], nCtx: 8192 });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline() });
    expect(r.status).toBe("ok");
    expect(fake.grammars.slice(0, 3).every(g => typeof g === "string")).toBe(true);
    expect(m.takeObserverStats().grammarStructural).toBe(1);
  });
});
