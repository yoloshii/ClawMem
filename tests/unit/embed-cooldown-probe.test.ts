/**
 * v0.43.5 (BACKLOG 77.1) — the readiness primitives (DESIGN-77.1 rev 3.2 §3, tests 10–12): `probeRemoteEmbed`,
 * `markRemoteEmbedReady`, `waitForRemoteEmbed`, the readiness messages and the wait options. New APIs, so these
 * cannot run on v0.43.4; the CLI behaviour they serve is covered by embed-cooldown-cli.test.ts.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { LlamaCpp, type RemoteEmbedProbeResult } from "../../src/llm.ts";
import {
  waitForRemoteEmbed,
  resolveEmbedWaitOptions,
  parseWaitFlag,
  readinessWaitApplies,
  formatNotReadyMessage,
  formatInstantTripMessage,
} from "../../src/embed-readiness.ts";
import { bow, deadPort, startEmbedFixture } from "../helpers/embed-readiness-fixture.ts";

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

/** A server whose every `/v1/embeddings` reply comes from `reply`; counts requests. */
function serve(reply: () => Response) {
  const hits = { n: 0 };
  const s = Bun.serve({ port: 0, fetch: () => { hits.n++; return reply(); } });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}`, hits };
}
const ok = () => Response.json({ data: [{ embedding: bow("x"), index: 0 }], model: "bow-embed" });

type Internals = { remoteEmbedDownUntil: number; remoteEmbedHttpErrorStreak: number; remoteEmbedFallbackNotifiedUntil: number };
const internals = (llm: LlamaCpp) => llm as unknown as Internals;

describe("10: probeRemoteEmbed — one request, a classified result, no side effects", () => {
  const probe = (url: string, ms = 1_000) => new LlamaCpp({ remoteEmbedUrl: url }).probeRemoteEmbed({ signal: AbortSignal.timeout(ms) });

  it("classifies ok, transport, http, instant-trip and malformed", async () => {
    expect(await probe(serve(ok).url)).toEqual({ kind: "ok", dim: 64, model: "bow-embed" });
    expect((await probe(`http://127.0.0.1:${deadPort()}`)).kind).toBe("transport");
    expect(await probe(serve(() => new Response("busy", { status: 503 })).url)).toMatchObject({ kind: "http", status: 503 });
    expect(await probe(serve(() => new Response("no", { status: 405 })).url)).toMatchObject({ kind: "instant-trip", status: 405 });
    expect(await probe(serve(() => new Response("no", { status: 501 })).url)).toMatchObject({ kind: "instant-trip", status: 501 });
    expect((await probe(serve(() => new Response("not json", { status: 200 })).url)).kind).toBe("malformed");
    expect((await probe(serve(() => Response.json({ data: [] })).url)).kind).toBe("malformed");
    expect((await probe(serve(() => Response.json({ data: [{ embedding: ["a"] }] })).url)).kind).toBe("malformed");
  });

  it("a body that never finishes is a timeout, bounded by the caller's signal", async () => {
    const hanging = serve(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":')); } })));
    const t0 = performance.now();
    expect((await probe(hanging.url, 300)).kind).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(3_000);
  });

  it("sends during an active cooldown and leaves the cooldown, the HTTP-error streak and the notify-once field as they were", async () => {
    for (const reply of [ok, () => new Response("busy", { status: 503 }), () => new Response("no", { status: 405 })]) {
      const srv = serve(reply);
      const llm = new LlamaCpp({ remoteEmbedUrl: srv.url });
      const until = Date.now() + 60_000;
      Object.assign(internals(llm), { remoteEmbedDownUntil: until, remoteEmbedHttpErrorStreak: 2, remoteEmbedFallbackNotifiedUntil: until + 7 });
      await llm.probeRemoteEmbed({ signal: AbortSignal.timeout(1_000) });
      expect(srv.hits.n).toBe(1);
      const after = internals(llm);
      expect({ down: after.remoteEmbedDownUntil, streak: after.remoteEmbedHttpErrorStreak, notified: after.remoteEmbedFallbackNotifiedUntil })
        .toEqual({ down: until, streak: 2, notified: until + 7 });
    }
  });

  it("markRemoteEmbedReady clears the cooldown and the streak and leaves the notify-once field", () => {
    const llm = new LlamaCpp({ remoteEmbedUrl: "http://127.0.0.1:1" });
    const until = Date.now() + 60_000;
    Object.assign(internals(llm), { remoteEmbedDownUntil: until, remoteEmbedHttpErrorStreak: 2, remoteEmbedFallbackNotifiedUntil: until + 7 });
    llm.markRemoteEmbedReady();
    const after = internals(llm);
    expect(after.remoteEmbedDownUntil).toBeLessThanOrEqual(Date.now());
    expect(after.remoteEmbedHttpErrorStreak).toBe(0);
    expect(after.remoteEmbedFallbackNotifiedUntil).toBe(until + 7);
  });

  it("the messages: the expiry names the last kind and status; --wait 0 names the one probe; the instant trip carries no cooldown or fallback clause", () => {
    const url = "http://gpu:8088";
    expect(formatNotReadyMessage(url, 120_000, { kind: "http", status: 503 }))
      .toBe("Embed server http://gpu:8088 did not become ready within 120 s (last: http, HTTP 503); embedding skipped before cleanup or any document attempt.");
    expect(formatNotReadyMessage(url, 1_000, { kind: "transport" }))
      .toBe("Embed server http://gpu:8088 did not become ready within 1 s (last: transport); embedding skipped before cleanup or any document attempt.");
    expect(formatNotReadyMessage(url, 0, { kind: "timeout" }))
      .toBe("Embed server http://gpu:8088 was not ready (one probe: timeout); embedding skipped before cleanup or any document attempt.");
    const trip = formatInstantTripMessage(url, 405);
    expect(trip).toContain("answers HTTP but not the embeddings API");
    expect(trip).toContain("HTTP 405");
    expect(trip).toContain("CLAWMEM_EMBED_URL");
    expect(trip).not.toMatch(/60 ?s|fallback|cooldown/i);
  });
});

/** A scripted stand-in for the LlamaCpp readiness surface: each probe takes the next result ("hang" = until aborted). */
function fake(results: (RemoteEmbedProbeResult | "hang")[]) {
  const starts: number[] = [];
  const t0 = performance.now();
  let ready = 0;
  return {
    starts,
    get ready() { return ready; },
    probeRemoteEmbed: async ({ signal }: { signal: AbortSignal }): Promise<RemoteEmbedProbeResult> => {
      starts.push(performance.now() - t0);
      const next = results.length > 1 ? results.shift()! : results[0]!;
      if (next !== "hang") return next;
      await new Promise<void>(res => (signal.aborted ? res() : signal.addEventListener("abort", () => res(), { once: true })));
      return { kind: "timeout" };
    },
    markRemoteEmbedReady: () => { ready++; },
  };
}
const OK: RemoteEmbedProbeResult = { kind: "ok", dim: 64, model: "m" };
const DOWN: RemoteEmbedProbeResult = { kind: "transport" };

describe("11: waitForRemoteEmbed — one deadline, a probe at once, then one per interval", () => {
  it("probes at once; ok → ready and the cooldown handoff runs once", async () => {
    const f = fake([OK]);
    const r = await waitForRemoteEmbed(f, { budgetMs: 5_000, intervalMs: 1_000, probeTimeoutMs: 1_000 });
    expect(r.status).toBe("ready");
    expect(f.starts.length).toBe(1);
    expect(f.starts[0]!).toBeLessThan(100);
    expect(f.ready).toBe(1);
  });

  it("keeps probing every interval through transport, timeout, http and malformed results until ok", async () => {
    const f = fake([DOWN, { kind: "http", status: 503 }, { kind: "malformed" }, { kind: "timeout" }, OK]);
    const r = await waitForRemoteEmbed(f, { budgetMs: 5_000, intervalMs: 100, probeTimeoutMs: 1_000 });
    expect(r.status).toBe("ready");
    expect(f.starts.length).toBe(5);
    for (let i = 1; i < f.starts.length; i++) expect(f.starts[i]! - f.starts[i - 1]!).toBeGreaterThanOrEqual(90);
    expect(f.ready).toBe(1);
  });

  it("an instant-trip status stops at once", async () => {
    const f = fake([{ kind: "instant-trip", status: 405 }]);
    const t0 = performance.now();
    const r = await waitForRemoteEmbed(f, { budgetMs: 10_000, intervalMs: 100, probeTimeoutMs: 1_000 });
    expect(r).toMatchObject({ status: "instant-trip", last: { kind: "instant-trip", status: 405 } });
    expect(f.starts.length).toBe(1);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(f.ready).toBe(0);
  });

  it("expires at the deadline with the last result", async () => {
    const f = fake([DOWN]);
    const t0 = performance.now();
    const r = await waitForRemoteEmbed(f, { budgetMs: 500, intervalMs: 100, probeTimeoutMs: 1_000 });
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ status: "expired", last: { kind: "transport" } });
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(2_000);
    expect(f.starts.length).toBeGreaterThanOrEqual(4);
    expect(f.starts.length).toBeLessThanOrEqual(7);
  });

  it("a probe is bounded by the time left, not only by the probe timeout", async () => {
    const f = fake(["hang"]);
    const t0 = performance.now();
    const r = await waitForRemoteEmbed(f, { budgetMs: 300, intervalMs: 100, probeTimeoutMs: 10_000 });
    expect(r.status).toBe("expired");
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(f.starts.length).toBe(1);
  });

  it("a sleep is bounded by the time left", async () => {
    const f = fake([DOWN]);
    const t0 = performance.now();
    const r = await waitForRemoteEmbed(f, { budgetMs: 250, intervalMs: 10_000, probeTimeoutMs: 1_000 });
    expect(r.status).toBe("expired");
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(f.starts.length).toBe(1);
  });

  it("shouldAbort ends the wait (the lease was lost)", async () => {
    const f = fake([DOWN]);
    const r = await waitForRemoteEmbed(f, { budgetMs: 10_000, intervalMs: 50, probeTimeoutMs: 1_000, shouldAbort: () => f.starts.length >= 2 });
    expect(r.status).toBe("aborted");
    expect(f.starts.length).toBe(2);
  });

  it("the lease lost while a probe that answers ok is in flight → aborted, and the cooldown handoff does not run", async () => {
    let lost = false;
    const f = fake([OK]);
    const probe = f.probeRemoteEmbed;
    f.probeRemoteEmbed = async (o) => { const r = await probe(o); lost = true; return r; };
    const r = await waitForRemoteEmbed(f, { budgetMs: 5_000, intervalMs: 100, probeTimeoutMs: 1_000, shouldAbort: () => lost });
    expect({ status: r.status, probes: f.starts.length, handoffs: f.ready }).toEqual({ status: "aborted", probes: 1, handoffs: 0 });
  });

  it("--wait 0 makes exactly one probe, bounded by the probe timeout", async () => {
    const down = fake([DOWN]);
    expect(await waitForRemoteEmbed(down, { budgetMs: 0, intervalMs: 100, probeTimeoutMs: 1_000 })).toMatchObject({ status: "expired", last: { kind: "transport" } });
    expect(down.starts.length).toBe(1);

    const hang = fake(["hang"]);
    const t0 = performance.now();
    expect((await waitForRemoteEmbed(hang, { budgetMs: 0, intervalMs: 100, probeTimeoutMs: 200 })).status).toBe("expired");
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(180);
    expect(ms).toBeLessThan(2_000);
    expect(hang.starts.length).toBe(1);

    const up = fake([OK]);
    expect((await waitForRemoteEmbed(up, { budgetMs: 0, intervalMs: 100, probeTimeoutMs: 1_000 })).status).toBe("ready");
  });

  it("other timers keep firing during a wait (the lease heartbeat)", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    try {
      await waitForRemoteEmbed(fake([DOWN]), { budgetMs: 300, intervalMs: 100, probeTimeoutMs: 1_000 });
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe("12: wait options — precedence and validation", () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

  it("defaults, then the env knobs, then --wait", () => {
    expect(resolveEmbedWaitOptions(undefined, env({}))).toEqual({ budgetMs: 120_000, intervalMs: 5_000, probeTimeoutMs: 15_000 });
    expect(resolveEmbedWaitOptions(undefined, env({ CLAWMEM_EMBED_WAIT_SEC: "30", CLAWMEM_EMBED_WAIT_INTERVAL_MS: "250", CLAWMEM_EMBED_PROBE_TIMEOUT_MS: "900" })))
      .toEqual({ budgetMs: 30_000, intervalMs: 250, probeTimeoutMs: 900 });
    expect(resolveEmbedWaitOptions(10, env({ CLAWMEM_EMBED_WAIT_SEC: "30" }))).toMatchObject({ budgetMs: 10_000 });
    expect(resolveEmbedWaitOptions(0, env({ CLAWMEM_EMBED_WAIT_SEC: "30" }))).toMatchObject({ budgetMs: 0 });
    expect(resolveEmbedWaitOptions(undefined, env({ CLAWMEM_EMBED_WAIT_SEC: "0" }))).toMatchObject({ budgetMs: 0 });
    expect(resolveEmbedWaitOptions(undefined, env({ CLAWMEM_EMBED_WAIT_SEC: "" }))).toMatchObject({ budgetMs: 120_000 });   // empty = unset
  });

  it("rejects a negative, non-integer or non-numeric value, and a zero interval or probe timeout", () => {
    for (const bad of ["-1", "1.5", "abc", "", " 5", "1e3", "Infinity"]) expect(parseWaitFlag(bad)).toHaveProperty("error");
    expect(parseWaitFlag("0")).toBe(0);
    expect(parseWaitFlag("45")).toBe(45);
    expect(parseWaitFlag(undefined)).toBeUndefined();
    for (const bad of ["-5", "2.5", "x"]) expect(resolveEmbedWaitOptions(undefined, env({ CLAWMEM_EMBED_WAIT_SEC: bad }))).toHaveProperty("error");
    for (const bad of ["0", "-1", "1.5", "x"]) {
      expect(resolveEmbedWaitOptions(undefined, env({ CLAWMEM_EMBED_WAIT_INTERVAL_MS: bad }))).toHaveProperty("error");
      expect(resolveEmbedWaitOptions(undefined, env({ CLAWMEM_EMBED_PROBE_TIMEOUT_MS: bad }))).toHaveProperty("error");
    }
  });

  it("the wait applies only to a URL with no API key and local fallback forbidden", () => {
    const URL = "http://gpu:8088";
    expect(readinessWaitApplies(env({ CLAWMEM_EMBED_URL: URL, CLAWMEM_NO_LOCAL_MODELS: "true" }))).toBe(true);
    expect(readinessWaitApplies(env({ CLAWMEM_EMBED_URL: URL }))).toBe(false);
    expect(readinessWaitApplies(env({ CLAWMEM_EMBED_URL: URL, CLAWMEM_NO_LOCAL_MODELS: "false" }))).toBe(false);
    expect(readinessWaitApplies(env({ CLAWMEM_EMBED_URL: URL, CLAWMEM_NO_LOCAL_MODELS: "true", CLAWMEM_EMBED_API_KEY: "k" }))).toBe(false);
    expect(readinessWaitApplies(env({ CLAWMEM_EMBED_URL: "", CLAWMEM_NO_LOCAL_MODELS: "true" }))).toBe(false);
    expect(readinessWaitApplies(env({ CLAWMEM_NO_LOCAL_MODELS: "true" }))).toBe(false);
  });
});

describe("fixture: the reset front frames requests by turn, not by TCP chunk", () => {
  /** One raw HTTP/1.1 request over its own connection, its bytes split at `cut`; resolves to the reply, or "closed". */
  async function rawRequest(port: number, cut: number): Promise<string> {
    const body = JSON.stringify({ input: "segmented request" });
    const req = `POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    let reply = "";
    let done: (v: string) => void = () => {};
    const result = new Promise<string>(res => { done = res; });
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_s, chunk) { reply += new TextDecoder().decode(chunk); },
        close() { done(reply === "" ? "closed" : reply); },
        error() { done(reply === "" ? "closed" : reply); },
      },
    });
    sock.write(req.slice(0, cut));
    await Bun.sleep(50);
    sock.write(req.slice(cut));
    return result;
  }

  it("a request line split inside its method counts once; the first request is the one reset, before any answer", async () => {
    const fx = startEmbedFixture({ fragmentMark: "unused", resetRequest: n => n === 1 });
    try {
      const port = Number(new URL(fx.url).port);
      expect(await rawRequest(port, 2)).toBe("closed");               // "PO" | "ST /v1/embeddings …"
      expect(await rawRequest(port, 7)).toContain("HTTP/1.1 200");     // "POST /v" | "1/embeddings …"
      expect(fx.front).toMatchObject({ requests: 2, resets: 1, firstReset: 1, answersBeforeFirstReset: 0 });
      expect(fx.seen.length).toBe(1);                                  // only the second reached the server
    } finally { fx.stop(); }
  });
});
