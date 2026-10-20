/**
 * v0.43.5 (BACKLOG 77.1) fixture for the real `clawmem embed` CLI: a bag-of-words `/v1/embeddings` server that
 * answers each request by a script (status, model name, dimension), and an optional raw-TCP front that RESETS chosen
 * requests — the client sees a transport error (ECONNRESET), exactly as from a server that went away.
 *
 * Requests are classified by what they carry: a geometry-canary probe (the end-of-run verification probe is the 9th
 * canary request), the dimension probe, a document fragment (its text carries `fragmentMark`), or "other" — the
 * v0.43.5 readiness probe is the only "other" request the CLI sends.
 */

import { createHash } from "crypto";
import { canaryProbeInputs } from "../../src/canary.ts";

/** Bag-of-words over hashed buckets: shared words → nearby vectors. At 64 dims it passes the real canary. */
export function bow(text: string, dim = 64): number[] {
  const v = new Array(dim).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[createHash("sha256").update(w).digest()[0]! % dim] += 1;
  return v;
}

export type Phase = "canary" | "dim" | "fragment" | "other";
/** `nth` counts requests of that phase from 1; `overall` counts every request the server saw from 1. */
export type Script = (phase: Phase, nth: number, overall: number) => { status?: number; model?: string; dim?: number } | undefined;

const PROBES = new Set(canaryProbeInputs().values());
const DIM_PROBE = "clawmem dimension probe";

export interface EmbedFixture {
  /** The URL the CLI is given: the front when one is used, else the server. */
  url: string;
  /** Every request the server answered, in order. Requests the front reset never reach it. */
  seen: { phase: Phase; status: number; model: string }[];
  count(phase: Phase): number;
  /**
   * HTTP requests through the front, how many it reset, which request it reset first, and how many answers the server
   * had sent back through the front before that first reset (all 0/null without a front).
   */
  front: FrontStats;
  stop(): void;
}

export function startEmbedFixture(opts: {
  fragmentMark: string;
  model?: string;
  script?: Script;
  /** Reset the n-th HTTP request (1-based, in arrival order) instead of passing it to the server. */
  resetRequest?: (n: number) => boolean;
}): EmbedFixture {
  const seen: EmbedFixture["seen"] = [];
  const perPhase: Record<Phase, number> = { canary: 0, dim: 0, fragment: 0, other: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname !== "/v1/embeddings") return new Response("not found", { status: 404 });
      const body = await req.json() as { input: string | string[] };
      const list = Array.isArray(body.input) ? body.input : [body.input];
      const phase: Phase = list.some(t => PROBES.has(t)) ? "canary"
        : list.some(t => t === DIM_PROBE) ? "dim"
        : list.some(t => t.includes(opts.fragmentMark)) ? "fragment"
        : "other";
      const nth = ++perPhase[phase];
      const r = opts.script?.(phase, nth, seen.length + 1) ?? {};
      const status = r.status ?? 200;
      const model = r.model ?? opts.model ?? "bow-embed";
      seen.push({ phase, status, model });
      if (status !== 200) return new Response(`scripted ${status}`, { status });
      return Response.json({ data: list.map((t, index) => ({ embedding: bow(t, r.dim ?? 64), index })), model });
    },
  });
  const front: FrontStats = { requests: 0, resets: 0, firstReset: null, answersBeforeFirstReset: null, answers: 0 };
  let stopFront = () => {};
  let port = server.port!;
  if (opts.resetRequest) {
    const f = startResetFront(server.port!, opts.resetRequest, front);
    port = f.port;
    stopFront = f.stop;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    count: (phase) => seen.filter(s => s.phase === phase).length,
    front,
    stop: () => { stopFront(); server.stop(true); },
  };
}

type Sock = { write(d: Uint8Array): number; end(): void; terminate(): void };

/** Writes all of `chunk`, keeping what the socket did not take until its next drain. */
function writer(sock: () => Sock | null) {
  let pending: Uint8Array[] = [];
  const flush = () => {
    const s = sock();
    if (!s) return;
    while (pending.length > 0) {
      const head = pending[0]!;
      const n = s.write(head);
      if (n >= head.length) { pending.shift(); continue; }
      pending[0] = head.subarray(Math.max(n, 0));
      return;
    }
  };
  return { push: (chunk: Uint8Array) => { pending.push(new Uint8Array(chunk)); flush(); }, flush };
}

export interface FrontStats {
  requests: number;
  resets: number;
  /** The number of the first request reset, or null. */
  firstReset: number | null;
  /** Answer chunks the front had relayed to clients when it made its first reset, or null. */
  answersBeforeFirstReset: number | null;
  /** Answer chunks relayed to clients so far. */
  answers: number;
}

/**
 * A TCP front that passes each connection through to `backendPort`, except that the bytes of a request it is told to
 * reset never leave it: it terminates the client connection instead.
 *
 * Requests are framed by turn, not by bytes: the client never pipelines, so on one connection a request is every byte
 * the client sends from the connection's start, or from the server's last answer, until the server answers again.
 * TCP keeps no write boundaries, so a request line split across chunks still counts once, at its first chunk.
 */
export function startResetFront(backendPort: number, resetRequest: (n: number) => boolean, stats: FrontStats) {
  type Conn = { up: Sock | null; dead: boolean; awaitingRequest: boolean; toUp: ReturnType<typeof writer>; toClient: ReturnType<typeof writer> };
  const listener = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        const conn: Conn = {
          up: null,
          dead: false,
          awaitingRequest: true,
          toUp: writer(() => conn.up),
          toClient: writer(() => (conn.dead ? null : client as unknown as Sock)),
        };
        client.data = conn;
        Bun.connect({
          hostname: "127.0.0.1",
          port: backendPort,
          socket: {
            open(up) {
              if (conn.dead) { up.end(); return; }
              conn.up = up as unknown as Sock;
              conn.toUp.flush();
            },
            data(_up, chunk) {
              stats.answers++;
              conn.awaitingRequest = true;   // the next client byte opens the next request
              conn.toClient.push(chunk);
            },
            drain() { conn.toUp.flush(); },
            close() { if (!conn.dead) client.end(); },
            error() { if (!conn.dead) client.end(); },
          },
        }).catch(() => { if (!conn.dead) client.end(); });
      },
      data(client, chunk) {
        const conn = client.data;
        if (conn.dead) return;
        if (conn.awaitingRequest) {
          conn.awaitingRequest = false;
          stats.requests++;
          if (resetRequest(stats.requests)) {
            stats.resets++;
            if (stats.firstReset === null) {
              stats.firstReset = stats.requests;
              stats.answersBeforeFirstReset = stats.answers;
            }
            conn.dead = true;
            conn.up?.end();
            client.terminate();
            return;
          }
        }
        conn.toUp.push(chunk);
      },
      drain(client) { client.data.toClient.flush(); },
      close(client) { client.data.dead = true; client.data.up?.end(); },
      error(client) { client.data.dead = true; client.data.up?.end(); },
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
}

/** A port nothing listens on (bound, read, released). */
export function deadPort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const p = s.port!;
  s.stop(true);
  return p;
}
