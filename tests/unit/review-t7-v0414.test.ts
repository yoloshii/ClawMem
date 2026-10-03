/**
 * v0.41.4 — the codex implementation review, turn 7 (15 findings; DESIGN-v0414.md r9, Appendix H). Each test fails on
 * the lane as reviewed at T7 for the reason its name gives, except those named "(guard)", which pin a behaviour the T7
 * lane already has and the fix must keep. T7-11 (docs), T7-12 (the live harness) and T7-15 (the mutation runner) are
 * not code under test here.
 */
import { describe, it, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { monoNow, deadlineAfter, duration } from "../../src/clock.ts";
import { fakeBudgetLlm } from "../helpers/fake-budget-llm.ts";
import { createTestStore } from "../helpers/test-store.ts";
import { extractObservationsWindowed, parseObservationReply } from "../../src/observer.ts";
import { generateDeductiveObservations } from "../../src/consolidation.ts";
import { freshStamp } from "../../src/stop-schema.ts";
import type { TranscriptMessage } from "../../src/hooks.ts";
import type { Store } from "../../src/store.ts";

const observerModule = () => import("../../src/observer.ts") as Promise<Record<string, any>>;
const replyModule = () => import("../../src/observer-reply.ts") as Promise<Record<string, any>>;
const dueModule = () => import("../../src/stop-worker.ts") as Promise<Record<string, any>>;
const B = { kind: "remote", root: "http://fake-llm" } as const;
const deadline = () => deadlineAfter(monoNow(), duration(600_000));
const any = (x: unknown) => x as any;

function block(parts: { type?: string; title?: string; facts?: string[]; triples?: string } = {}): string {
  const facts = (parts.facts ?? ["The parser rejects copied tool roles"]).map(f => `<fact>${f}</fact>`).join("");
  return `<observation><type>${parts.type ?? "discovery"}</type><title>${parts.title ?? "Observer replies parse"}</title>`
    + `<facts>${facts}</facts>${parts.triples ?? ""}<narrative>The model copied a role from the transcript.</narrative></observation>`;
}
const triple = (s: string, p: string, o: string) => `<triples><triple><subject>${s}</subject><predicate>${p}</predicate><object>${o}</object></triple></triples>`;

const msgs: TranscriptMessage[] = [
  { role: "user", content: "fix the observer parser", turn: 0, opening: true },
  { role: "assistant", content: "I updated src/observer.ts so a copied tool role is rejected.", turn: 0 },
];
/** 81 lines of ~68 tokens: a window sized for 8192 overflows 4096 (the format tests' ceiling transcript). */
const long: TranscriptMessage[] = [msgs[0]!, ...Array.from({ length: 80 }, (_, i) => ({
  role: "assistant" as const, content: `step ${i}: ` + "the observer fix carried more detail here. ".repeat(5), turn: 0,
}))];

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

/** A store with `transaction` and `entries` but no `update`; every access logs the transaction it ran in. Nesting throws. */
function txStore() {
  const m = new Map<string, string>();
  let tx: number | null = null;
  let seq = 0;
  const log: { op: "get" | "set" | "delete"; key: string; tx: number | null }[] = [];
  return {
    m, log,
    get: (k: string) => { log.push({ op: "get", key: k, tx }); return m.get(k) ?? null; },
    set: (k: string, v: string) => { log.push({ op: "set", key: k, tx }); m.set(k, v); },
    delete: (k: string) => { log.push({ op: "delete", key: k, tx }); m.delete(k); },
    entries: (prefix: string) => [...m].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    transaction: <T>(fn: () => T): T => {
      if (tx !== null) throw new Error("nested transaction");
      tx = ++seq;
      try { return fn(); } finally { tx = null; }
    },
  };
}

/** The fake; a grammar request is refused with HTTP 400 (`refuseGrammar`) or as a grammar the backend cannot compile (`rejectGrammar`). */
function grammarFake(o: Parameters<typeof fakeBudgetLlm>[0] & { refuseGrammar?: boolean; rejectGrammar?: boolean; onCall?: (grammar: string | undefined) => void }) {
  const base = fakeBudgetLlm(o);
  const grammars: (string | undefined)[] = [];
  const llm = {
    ...base.llm,
    generateDetailed: async (prompt: string, opts: any) => {
      grammars.push(opts.grammar);
      o.onCall?.(opts.grammar);
      if (opts.grammar && o.refuseGrammar) return { ok: false, reason: "http", status: 400, backend: opts.backend };
      if (opts.grammar && o.rejectGrammar) return { ok: false, reason: "grammar_rejected", backend: opts.backend };
      return base.llm.generateDetailed(prompt, opts);
    },
  };
  return { ...base, llm, grammars };
}

/** Generation against a server whose real context is `serverCtx()` while `/props` keeps claiming the fake's nCtx. */
function oversizing(props: ReturnType<typeof fakeBudgetLlm>, serverCtx: () => number) {
  const sent: number[] = [];
  const llm = {
    ...props.llm,
    generateDetailed: async (prompt: string, o: any) => {
      const t = props.tokens(prompt) + props.overhead;
      sent.push(t);
      const ctx = serverCtx();
      if (t > ctx) return { ok: false, reason: "context_exceeded", nCtx: ctx, promptTokens: t, backend: o.backend };
      return props.llm.generateDetailed(prompt, o);
    },
  };
  return { llm, sent };
}

/** The monotonic clock moved forward by `skew()` ms (the deadline tests). */
function skewedClock() {
  const real = performance.now.bind(performance);
  let skew = 0;
  const spy = spyOn(performance, "now").mockImplementation(() => real() + skew);
  return { advance: (ms: number) => { skew += ms; }, restore: () => spy.mockRestore() };
}

afterEach(() => { delete process.env.CLAWMEM_OBSERVER_GRAMMAR; delete process.env.CLAWMEM_CAUSAL_WRITER; });

describe("T7-1 (§2.1): the sentinel alone, or inside one complete fence", () => {
  it("a stray opening or closing fence around <none/> is no-blocks — the T7 pattern made each fence optional on its own", () => {
    for (const t of ["<none/>\n```", "```\n<none/>", "```xml\n<none/>", "<none/>```"]) {
      expect(any(parseObservationReply(t)).failure?.reason).toBe("no-blocks");
    }
    for (const t of ["<none/>", " <none/>\n", "```\n<none/>\n```", "```xml\n<none/>\n```"]) {
      expect(any(parseObservationReply(t)).none).toBe(true);
    }
  });
});

describe("T7-2 (§3.2(b)): an exit before the retry's own reply keeps that reply's class", () => {
  /** The fake, whose server shrinks to 500 tokens at the retry's capacity read (the first call saw 8192). */
  function shrinkingAtRetry(o: Parameters<typeof grammarFake>[0]) {
    let ctx = 8192;
    const fake = grammarFake({ ...o, nCtx: () => ctx });
    let reads = 0;
    const llm = { ...fake.llm, llmCapacity: async (b: any) => { if (++reads === 2) ctx = 500; return fake.llm.llmCapacity(b); } };
    return { fake, llm };
  }

  it("after a grammar 400, a retry whose fresh capacity leaves no room ends with the grammar reason, not capacity", async () => {
    const { fake, llm } = shrinkingAtRetry({ replies: [block()], refuseGrammar: true });
    const r = await extractObservationsWindowed(msgs, { llm: llm as any, backend: B, deadline: deadline(), overheadStore: memStore() as any });
    expect(fake.grammars.length).toBe(1);
    expect(r).toEqual({ status: "retryable", reason: "grammar: HTTP 400 on a grammar request; the grammarless retry was not reached" });
  });

  it("after a cut reply, a retry whose fresh capacity leaves no room ends with the cut reason", async () => {
    const { fake, llm } = shrinkingAtRetry({ replies: [{ text: "<observation><type>disc", finish: "length" }] });
    const r = await extractObservationsWindowed(msgs, { llm: llm as any, backend: B, deadline: deadline() });
    expect(fake.grammars.length).toBe(1);
    expect(r).toEqual({ status: "retryable", reason: "capacity: the reply was cut and the halved window was not tried" });
  });
});

describe("T7-3 (§3.3a): every validated oversize below /props lowers its record", () => {
  it("two oversizes reporting 4096 then 2048 under /props 8192 leave the ceiling at 2048, not the first correction's 4096", async () => {
    const store = memStore();
    const props = fakeBudgetLlm({ replies: [block()], nCtx: 8192 });
    const reported = [4096, 2048];
    let k = 0;
    const { llm, sent } = oversizing(props, () => reported[Math.min(k++, reported.length - 1)]!);
    const r = await extractObservationsWindowed(long, { llm: llm as any, backend: B, deadline: deadline(), overheadStore: store as any, maxCalls: 2 });
    expect(sent.length).toBe(2);
    expect(sent[1]!).toBeGreaterThan(2048);
    expect(r.status).toBe("retryable");
    const key = [...store.m.keys()].find(x => x.startsWith("observer-nctx:"))!;
    expect(key).toMatch(/:8192$/);
    expect(JSON.parse(store.m.get(key)!).ceiling).toBe(2048);
  });
});

describe("T7-4 (§3.3a): retention keeps four records per backend", () => {
  it("after a backward clock step (four future-dated records) a new /props value's record replaces the oldest — four remain, the new one among them", async () => {
    const m = await observerModule();
    const store = txStore();
    const props = fakeBudgetLlm({ replies: [block()], nCtx: 8192 });
    const bk: string = m.observerBackendKey(props.llm, B);
    for (const [n, days] of [[1024, 1], [2048, 2], [3072, 3], [6144, 4]] as const) {
      store.m.set(`observer-nctx:${bk}:${n}`, JSON.stringify({ ceiling: n / 2, at: new Date(Date.now() + days * 86_400_000).toISOString() }));
    }
    const { llm } = oversizing(props, () => 4096);
    await extractObservationsWindowed(long, { llm: llm as any, backend: B, deadline: deadline(), overheadStore: store as any, maxCalls: 1 });
    const keys = [...store.m.keys()].filter(x => x.startsWith(`observer-nctx:${bk}:`)).sort();
    expect(keys).toEqual([`observer-nctx:${bk}:2048`, `observer-nctx:${bk}:3072`, `observer-nctx:${bk}:6144`, `observer-nctx:${bk}:8192`]);
    expect(JSON.parse(store.m.get(`observer-nctx:${bk}:8192`)!).ceiling).toBe(4096);
  });
});

/** The code points a GBNF negated class `[^…]` excludes (the escapes llama.cpp's grammar parser reads). */
function gbnfClass(body: string): (c: number) => boolean {
  const ranges: [number, number][] = [];
  let i = 0;
  const one = (): number => {
    if (body[i] !== "\\") return body.codePointAt(i++)!;
    const e = body[i + 1]!;
    i += 2;
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, "\\": 92, "]": 93, "[": 91, '"': 34 };
    if (e in simple) return simple[e]!;
    const len = e === "x" ? 2 : e === "u" ? 4 : e === "U" ? 8 : 0;
    if (len === 0) throw new Error(`unknown escape \\${e}`);
    const v = parseInt(body.slice(i, i + len), 16);
    i += len;
    return v;
  };
  while (i < body.length) {
    const lo = one();
    if (body[i] === "-" && i + 1 < body.length) { i++; ranges.push([lo, one()]); } else ranges.push([lo, lo]);
  }
  return c => ranges.some(([a, b]) => c >= a && c <= b);
}

describe("T7-5 (§4.2): the grammar's boundary atoms match the parser's trimming", () => {
  it("`ns` excludes every character String.prototype.trim removes — NBSP, ideographic space, BOM … — so 5 atoms trim to 5", async () => {
    const m = await replyModule();
    const g: string = m.observerGrammar(1);
    const ns = g.split("\n").find(l => l.startsWith("ns ::= "))!;
    const excluded = gbnfClass(ns.match(/^ns ::= \[\^((?:\\.|[^\]\\])*)\]/)![1]!);
    const trimmed: number[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (String.fromCodePoint(c).trim() === "") trimmed.push(c);
    }
    expect(trimmed.length).toBeGreaterThan(20);
    expect(trimmed.filter(c => !excluded(c)).map(c => c.toString(16))).toEqual([]);
    for (const c of [0x3c, 0x3e, 0x26, 0x0a]) expect(excluded(c)).toBe(true);   // and still no raw markup or newline
  });
});

describe("T7-6 (§4.4): a pending obligation is cleared whatever made the call grammarless", () => {
  it("with CLAWMEM_OBSERVER_GRAMMAR=off, the grammarless call's response clears the obligation", async () => {
    const store = memStore();
    const probe = grammarFake({ replies: [block()], nCtx: 8192, refuseGrammar: true });
    await extractObservationsWindowed(msgs, { llm: probe.llm as any, backend: B, deadline: deadline(), overheadStore: store as any, maxCalls: 1 });
    const key = [...store.m.keys()].find(k => k.startsWith("observer-grammar:")) ?? "";
    expect(JSON.parse(store.m.get(key)!).pending).toBe(true);
    process.env.CLAWMEM_OBSERVER_GRAMMAR = "off";
    const next = grammarFake({ replies: [block()], nCtx: 8192 });
    const r = await extractObservationsWindowed(msgs, { llm: next.llm as any, backend: B, deadline: deadline(), overheadStore: store as any });
    expect(r.status).toBe("ok");
    expect(next.grammars[0]).toBeUndefined();
    expect(JSON.parse(store.m.get(key)!).pending).toBe(false);
  });
});

describe("T7-7 (§4.1/§4.4): a grammar the in-process model cannot compile is a refusal, never an unconstrained reply", () => {
  it("the record (cause compile) at once, a grammarless retry, and no reply counted as a reply to a grammar request", async () => {
    const m = await observerModule();
    m.takeObserverStats();
    const store = memStore();
    const fake = grammarFake({ replies: [block()], nCtx: 8192, rejectGrammar: true });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline(), overheadStore: store as any });
    expect(r.status).toBe("ok");
    expect(typeof fake.grammars[0]).toBe("string");
    expect(fake.grammars[1]).toBeUndefined();
    const rec = JSON.parse(store.m.get([...store.m.keys()].find(k => k.startsWith("observer-grammar:"))!)!);
    expect(rec).toMatchObject({ count: 1, pending: false, cause: "compile" });
    const stats = m.takeObserverStats();
    expect(stats.grammarRefusals).toBe(1);
    expect(stats.grammarStructural + stats.grammarContent).toBe(0);
  });

  it("a one-call invocation whose grammar does not compile ends retryable with the compile reason", async () => {
    const fake = grammarFake({ replies: [block()], nCtx: 8192, rejectGrammar: true });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline(), maxCalls: 1, overheadStore: memStore() as any });
    expect(r).toEqual({ status: "retryable", reason: "grammar: the in-process model could not compile the grammar; the grammarless retry was not reached" });
  });
});

describe("T7-8 (§5.2): a tool-call id or rendering is the whole value, not a substring", () => {
  it("entities that merely contain an id-like or rendering-like string keep their triples", () => {
    for (const [s, p, o] of [["toolu_abcdef.ts", "depends_on", "SQLite"], ["tool_result_cache", "uses", "Redis"], ["src/tool_result.ts", "uses", "zod"]] as const) {
      const r = any(parseObservationReply(block({ triples: triple(s, p, o) })));
      expect(r.value[0].triples?.[0]?.subject).toBe(s);
    }
  });

  it("an id (bare, quoted or as id=…) and a copied rendering are still dropped (guard)", () => {
    for (const s of ["toolu_01NiKPR3x4gz6xV9Q4d7XQYd", '"toolu_01NiKPR3x4gz6x"', 'id="toolu_01NiKPR3x4gz"', '[tool_use name="Bash"', "tool_result", '[tool_result id="toolu_01NiKPR3"]']) {
      const r = any(parseObservationReply(block({ triples: triple(s, "uses", "Bun") })));
      expect(r.value[0].triples).toBeUndefined();
      expect(r.drops.tripleToolId).toBe(1);
    }
  });
});

describe("T7-9 (§6.1): the deductive statistics count what the model was shown", () => {
  let store: Store;
  beforeEach(() => { store = createTestStore(); });

  it("when no two sources fit, `considered` is 0 and no call is made — T7 kept the selection count (20)", async () => {
    for (let i = 0; i < 20; i++) seedObservation(store, `d${i}.md`, `Decision ${i}`);
    const fake = fakeBudgetLlm({ nCtx: 500, reply: () => "[]" });
    const stats = await generateDeductiveObservations(store, fake.llm as any);
    expect(fake.calls.length).toBe(0);
    expect(stats.considered).toBe(0);
    expect(stats.nullCalls).toBe(0);
  });
});

function seedObservation(store: Store, path: string, title: string): void {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const facts = `${title} carried a long fact about the observer and its windows. `.repeat(6);
  store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, `# ${title}\n${facts}`, now);
  store.db.prepare(
    `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, content_type, observation_type, facts, narrative)
     VALUES ('test', ?, ?, ?, ?, ?, 1, 'decision', 'decision', ?, ?)`
  ).run(path, title, hash, now, now, facts, "A narrative that explains why the change was made.");
}

describe("T7-10 (§7.2): --run's next-due report uses each worker's own eligibility", () => {
  let store: Store;
  beforeEach(() => { store = createTestStore(); });
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  let n = 0;
  const retry = (state: string, nextRetryAt: string, lease: string | null) => store.db.prepare(
    `INSERT INTO stop_retries (session_id, transcript_key, hook, transcript_path, from_offset, to_offset, range_key, range_sha,
       first_failed_at, next_retry_at, state, claim_token, lease_expires_at)
     VALUES ('s', 'k', 'decision-extractor', '/nowhere', 0, 10, ?, 'sha', ?, ?, ?, ?, ?)`
  ).run(`r${++n}`, iso(-3_600_000), nextRetryAt, state, lease ? "tok" : null, lease);

  it("a claimed range whose lease expired is due now, and a live lease's expiry is the next due time — T7 counted queued rows only", async () => {
    const m = await dueModule();
    retry("claimed", iso(-600_000), iso(-60_000));
    const leaseEnd = iso(300_000);
    retry("claimed", iso(-600_000), leaseEnd);
    expect(m.stopQueueNextDue(store.db)).toContain(`quarantined ranges ${leaseEnd} (1 due now)`);
  });

  it("a causal step whose claimant's lease expired is due now while the writer runs", async () => {
    process.env.CLAWMEM_CAUSAL_WRITER = "shadow";
    const m = await dueModule();
    store.db.prepare(
      `INSERT INTO causal_due (session_id, transcript_key, range_key, run_key, obs_doc_ids, window_at, mode, state, claim_token, lease_expires_at, created_at)
       VALUES ('s', 'k', 'r1', 'run1', '[]', ?, 'shadow', 'claimed', 'tok', ?, ?)`
    ).run(iso(-600_000), iso(-60_000), iso(-600_000));
    expect(m.stopQueueNextDue(store.db)).toContain("causal steps none (1 due now)");
  });

  it("a provisional feedback attribution, which the worker re-examines, is counted as open", async () => {
    const m = await dueModule();
    store.db.prepare(`INSERT INTO context_usage (session_id, transcript_key, timestamp, hook_name, writer_stamp) VALUES ('s', 'k', ?, 'context-surfacing', ?)`)
      .run(iso(-60_000), freshStamp());
    const usage = (store.db.prepare(`SELECT MAX(id) AS id FROM context_usage`).get() as { id: number }).id;
    store.db.prepare(`INSERT INTO feedback_turns (usage_id, state, reason, updated_at) VALUES (?, 'attributed', 'provisional', ?)`).run(usage, iso(-60_000));
    expect(m.stopQueueNextDue(store.db)).toContain("feedback turns 1 open");
  });

  it("a handoff render waits for the worker's quiet window; under --run (quiet 0) it is due now", async () => {
    const m = await dueModule();
    const digestAt = iso(-60_000);
    store.db.prepare(`INSERT INTO session_docs (session_id, transcript_key, kind, path, render_needed, created_at) VALUES ('s', 'k', 'handoff', 'h.md', 1, ?)`).run(digestAt);
    store.db.prepare(`INSERT INTO stop_items (session_id, transcript_key, kind, fp, payload, created_at) VALUES ('s', 'k', 'turn-digest', 'fp1', '{}', ?)`).run(digestAt);
    const quiet = new Date(Date.parse(digestAt) + 600_000).toISOString();
    expect(m.stopQueueNextDue(store.db, { quietMs: 600_000 })).toContain(`handoff renders ${quiet}`);
    expect(m.stopQueueNextDue(store.db, { quietMs: 0 })).toContain("handoff renders none (1 due now)");
  });
});

describe("T7-13: an expired deadline never becomes a call without a timeout", () => {
  it("a retry whose capacity read outlasts the deadline makes no call and keeps the failed reply's reason", async () => {
    const clock = skewedClock();
    try {
      const fake = grammarFake({ replies: [block({ type: "tool_use" }), block()], nCtx: 8192 });
      const read = fake.llm.llmCapacity;
      let reads = 0;
      const llm = { ...fake.llm, llmCapacity: async (b: any) => { if (++reads === 2) clock.advance(700_000); return read(b); } };
      const r = await extractObservationsWindowed(msgs, { llm: llm as any, backend: B, deadline: deadline() });
      expect(fake.grammars.length).toBe(1);
      expect(r).toEqual({ status: "retryable", reason: "no parseable response: type-not-allowed (tool-role)" });
    } finally {
      clock.restore();
    }
  });

  it("a deductive pass whose fitting outlasts its deadline makes no call and shows nothing", async () => {
    const store = createTestStore();
    for (let i = 0; i < 20; i++) seedObservation(store, `d${i}.md`, `Decision ${i}`);
    const clock = skewedClock();
    try {
      const fake = fakeBudgetLlm({ nCtx: 2048, reply: () => "[]" });
      const count = fake.llm.countChatTokens;
      const llm = { ...fake.llm, countChatTokens: async (c: string) => { clock.advance(200_000); return count(c); } };
      const stats = await generateDeductiveObservations(store, llm as any);
      expect(fake.calls.length).toBe(0);
      expect(stats.considered).toBe(0);
    } finally {
      clock.restore();
    }
  });
});

describe("T7-14: a store with a transaction but no update keeps every read-modify-write atomic", () => {
  it("the grammar-off record's write and its obligation's clear each read and write inside one transaction", async () => {
    const store = txStore();
    const fake = grammarFake({ replies: [block()], nCtx: 8192, refuseGrammar: true });
    const r = await extractObservationsWindowed(msgs, { llm: fake.llm as any, backend: B, deadline: deadline(), overheadStore: store as any });
    expect(r.status).toBe("ok");
    const writes = store.log.filter(e => e.op !== "get" && e.key.startsWith("observer-grammar:"));
    expect(writes.length).toBe(2);
    for (const w of writes) {
      expect(w.tx).not.toBeNull();
      const before = store.log.slice(0, store.log.indexOf(w));
      expect(before.some(e => e.op === "get" && e.key === w.key && e.tx === w.tx)).toBe(true);
    }
  });

  it("a ceiling's merge and retention run in one transaction, never nested (guard)", async () => {
    const store = txStore();
    const props = fakeBudgetLlm({ replies: [block()], nCtx: 8192 });
    const { llm } = oversizing(props, () => 4096);
    await extractObservationsWindowed(long, { llm: llm as any, backend: B, deadline: deadline(), overheadStore: store as any, maxCalls: 1 });
    const writes = store.log.filter(e => e.op === "set" && e.key.startsWith("observer-nctx:"));
    expect(writes.length).toBe(1);
    expect(writes[0]!.tx).not.toBeNull();
  });
});

// =============================================================================
// codex implementation review, turn 8 (5 findings; DESIGN-v0414.md r10). Each fails on the turn-8 lane for the reason
// its name gives.
// =============================================================================

describe("T8-1 (§2.1): a fence's content starts on the line after the opening fence", () => {
  it("the sentinel inline with a fence, in its info string, or on the closing fence's line is no-blocks — T8 accepted them", () => {
    for (const t of ["```xml<none/>```", "```xml<none/>\n```", "```<none/>\n```", "```\n<none/>```"]) {
      expect(any(parseObservationReply(t)).failure?.reason).toBe("no-blocks");
    }
    for (const t of ["```\n<none/>\n```", "```xml\r\n<none/>\r\n```", "  ```\n  <none/>\n  ```  ", "```xml\n\n<none/>\n```"]) {
      expect(any(parseObservationReply(t)).none).toBe(true);
    }
  });
});

describe("T8-2 (§3.2): the deadline is read before a fit's capacity result", () => {
  /** Counts that move the clock past the deadline at the first count after `armed()`, then never fit. */
  function expiringCounts(fake: ReturnType<typeof grammarFake>, clock: ReturnType<typeof skewedClock>, armed: () => boolean) {
    const count = fake.llm.countChatTokens;
    let gone = false;
    return async (content: string) => {
      if (!gone && armed()) { gone = true; clock.advance(700_000); }
      return gone ? { tokens: 1_000_000_000, method: "template" as const, margin: 4 } : count(content);
    };
  }

  it("a window whose first fit outlasts the deadline and finds no room is partial, not a capacity failure", async () => {
    const clock = skewedClock();
    try {
      const fake = grammarFake({ replies: [block()], nCtx: 8192 });
      const llm = { ...fake.llm, countChatTokens: expiringCounts(fake, clock, () => true) };
      const r = await extractObservationsWindowed(msgs, { llm: llm as any, backend: B, deadline: deadline() });
      expect(fake.grammars.length).toBe(0);
      expect(r).toEqual({ status: "partial", doneThroughLine: 0, totalLines: 2 });
    } finally {
      clock.restore();
    }
  });

  it("a format retry whose re-fit outlasts the deadline and finds no room keeps the failed reply's reason", async () => {
    const clock = skewedClock();
    try {
      const fake = grammarFake({ replies: [block({ type: "tool_use" }), block()], nCtx: 8192 });
      let reads = 0;
      const llm = {
        ...fake.llm,
        llmCapacity: async (b: any) => { reads++; return fake.llm.llmCapacity(b); },
        countChatTokens: expiringCounts(fake, clock, () => reads >= 2),
      };
      const r = await extractObservationsWindowed(msgs, { llm: llm as any, backend: B, deadline: deadline() });
      expect(fake.grammars.length).toBe(1);
      expect(r).toEqual({ status: "retryable", reason: "no parseable response: type-not-allowed (tool-role)" });
    } finally {
      clock.restore();
    }
  });
});

describe("T8-3 (§7.2): the report counts the named vaults' mirrors the worker would apply", () => {
  it("a mirror whose general verdict is ready is due; one already holding that revision is not — T8 read the general vault only", async () => {
    const m = await dueModule();
    const general = createTestStore();
    const vault = createTestStore();
    const at = new Date(Date.now() - 60_000).toISOString();
    const usage = (s: Store, source: number | null) => {
      s.db.prepare(`INSERT INTO context_usage (session_id, transcript_key, timestamp, hook_name, writer_stamp, source_usage_id) VALUES ('s', 'k', ?, 'context-surfacing', ?, ?)`)
        .run(at, freshStamp(), source);
      return (s.db.prepare(`SELECT MAX(id) AS id FROM context_usage`).get() as { id: number }).id;
    };
    const g1 = usage(general, null);
    const g2 = usage(general, null);
    general.db.prepare(`INSERT INTO feedback_turns (usage_id, state, reason, updated_at, revision) VALUES (?, 'attributed', NULL, ?, 1), (?, 'attributed', NULL, ?, 1)`).run(g1, at, g2, at);
    vault.db.prepare(`INSERT INTO feedback_turns (usage_id, state, updated_at) VALUES (?, 'pending', ?)`).run(usage(vault, g1), at);
    vault.db.prepare(`INSERT INTO feedback_turns (usage_id, state, reason, updated_at, source_revision) VALUES (?, 'attributed', 'provisional', ?, 1)`).run(usage(vault, g2), at);
    expect(m.stopQueueNextDue(general.db, { vaults: [{ name: "work", store: vault }] })).toContain("vault mirrors 1 due");
  });
});
