/**
 * Vector-query daemon (BACKLOG Source 46) — HARD cap on the cold synchronous sqlite-vec MATCH.
 *
 * The context-surfacing UserPromptSubmit hook runs a SYNCHRONOUS sqlite-vec MATCH (searchVecMatch).
 * bun:sqlite exposes no interrupt/progress handler, so a cold scan on a large vault blocks the hook's
 * single event loop past its 8-15s budget — an in-thread `Promise.race(vectorTimeout)` cannot fire
 * while a synchronous call runs. This daemon relocates the MATCH — and, since v0.38's hydrated-v1
 * protocol (codex #28 t83–t88), the hydration + snippet PROJECTION too — onto the long-lived
 * watcher process: the hook sends the query + presentation inputs over a per-vault unix socket and
 * races the reply against a REAL setTimeout (its own event loop stays free); the daemon answers with
 * fully projected results, so the hook performs ZERO synchronous sqlite inside its vector deadline.
 * Client-side hydration survives only on the raw-hit path: a request that never asked for hydration,
 * answered by a current daemon that attested the budget it enforced. A legacy daemon's raw answer to
 * a hydrated request carries no deadline attestation and is classified `skew` (FTS) — O1 §4
 * superseded the t84 raw-hit negotiation.
 *
 * The daemon is a strict OPTIMIZATION LAYER, never a dependency:
 *   - daemon absent/refused  → the hook uses the in-process searchVec path UNCHANGED (today's behavior;
 *                              users who don't run the watcher lose nothing).
 *   - daemon busy/error/timeout → the hook returns [] and falls back to FTS (it must NOT re-run the scan
 *                              in-process, which would reintroduce the very block this exists to avoid).
 *
 * Design record: BACKLOG.md Source 46 "DESIGN-gate outcome + build contract" (2026-07-05, codex-cleared).
 */

import { existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Socket } from "bun";
import { searchVecMatch, hydrateVecResults, projectVecResults, screenVecHits, HydratedBodyOversizedError, VecReadModelMismatchError, type Store, type SearchResult, type ProjectedVecResult, type VecHit, type VecScan } from "./store.ts";
import { VecPoisonError, EmbedEnvelopeError, isRefusedEmbedResponse, type VecPoisonReason, type VectorSource } from "./vector-guard.ts";
import { monoNow, deadlineAfter, duration, isExpired, remainingForTimeout, wireBudget, deadlineTimer, elapsed, evidenceMs, type MonoDeadline, type MonoInstant } from "./clock.ts";
import { HYDRATED_PROTOCOL, HYDRATED_MAX_RESULTS, HYDRATED_MAX_ENTRY_BYTES, HYDRATED_MAX_FRAME_BYTES, HYDRATED_MAX_SOURCE_BODY_BYTES, HYDRATED_SNIPPET_LENS, HYDRATED_RERANK_TEXT_LEN, HYDRATED_GATE_TEXT_LEN, DEADLINE_PROTOCOL, MAX_LEG_BUDGET_MS, VECTOR_FAULT_PROTOCOL } from "./vector-protocol.ts";

// Newline-delimited JSON, one request/response per connection. A query string and a list of
// {hash_seq, distance} are both small; anything over this cap is a protocol violation, so both sides
// reject it rather than buffer unbounded on a runaway/hostile peer.
const MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_IPC_TIMEOUT_MS = 5000;
// A stray/hostile `limit` (same-user socket) must not become an unbounded `k = limit * 3` scan. The
// hook only ever asks for ~5-10; clamp anything outside a sane range.
const MAX_VEC_LIMIT = 500;

/** Per-connection server reader state — RAW BYTES (t87 F3): the cap is enforced on received
 * UTF-8 bytes, the newline is located at the byte level, and each complete line is decoded with
 * a FATAL TextDecoder — a code point split across socket chunks can never corrupt, and invalid
 * UTF-8 is refused (`bad_request`), never U+FFFD-substituted into query text. */
type DaemonSocketData = { pending: Uint8Array; total: number };

/** Decode one complete line strictly; null = invalid UTF-8 (fail-closed, t87 CR-6). */
function decodeLineStrict(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

// Env-gated phase timing (CLAWMEM_VEC_TIMING=1): logs each hook vector leg's outcome + elapsed to
// stderr so a future `UserPromptSubmit hook timed out` is attributable — daemon engaged & fast, vs
// daemon-absent in-process fallback (the old slow path), vs daemon busy/error → FTS. Off by default.
const VEC_TIMING = process.env.CLAWMEM_VEC_TIMING === "1" || process.env.CLAWMEM_VEC_TIMING === "true";

let daemonSkewWarned = false;
/** O1 §4 (new client / old daemon, production hook): the vector leg degrades to FTS and a health
 * warning names the socket — once per process. Surfacing never crashes. */
function warnOnceOnDaemonSkew(dbPath: string, missing: string): void {
  if (daemonSkewWarned) return;
  daemonSkewWarned = true;
  console.error(`[clawmem] vector daemon on ${vecDaemonSocketPath(dbPath)} does not implement ${missing} (a watcher on an older build) — vector legs degrade to FTS until 'clawmem watch' is restarted on this build`);
}

type VecReq = {
  query: string; model: string; limit: number;
  /** O1 (deadline-rel-v1): whole milliseconds still available to the leg, filled in by
   * `daemonVecMatch` IMMEDIATELY before the socket write (never earlier — connect latency has
   * already been spent). Integer in [1, MAX_LEG_BUDGET_MS] or the daemon refuses the request as
   * skew (`bad_request`). REQUIRED on a hydrated request — a hydrated-v1 request without it is
   * `bad_request`; a raw request may omit it for compatibility and is then answered WITHOUT the
   * `deadlineProtocol` attestation: the daemon attests only a budget it enforced (codex migration
   * r1 P2). The daemon's ADVISORY deadline is anchored at FRAME RECEIPT — the socket event that
   * delivered the terminating newline, sampled before decode and validation (codex migration r1
   * P3) — so it trails the client's authoritative timer by one-way transit only. The pre-O1
   * absolute wall-clock `deadlineMs` is REJECTED by field presence (`version_skew`) — never decoded. */
  remainingBudgetMs?: number;
  // hydrated-v1 (codex #28 t83–t88, projection-complete daemon hydration). A request carrying
  // `responseProtocol` asks the daemon to hydrate + project server-side and answer with the
  // multi-line hydrated response (header + n entry lines + end line). The projection params are
  // an ATTESTATION of the exact protocol constants — the daemon validates them EXACTLY and
  // refuses anything else as `bad_request` (t87 F1), so a version-skewed peer fails loudly
  // instead of computing a divergent projection. An old daemon ignores the unknown fields and
  // answers raw hits WITHOUT the deadline attestation — the client classifies that leg `skew`
  // (FTS): O1 §4 superseded the t84 raw-hit negotiation, because such a daemon ran under no
  // deadline of its own.
  responseProtocol?: string;
  /** The RAW CURRENT PROMPT — snippet construction input on EVERY leg (t87 F4: the prior leg
   * searches with joined priors and deep legs with expansion variants, but buildContext always
   * extracts snippets against the current prompt + session topic). */
  presentationQuery?: string;
  /** The resolved session topic (buildContext's intent input). */
  intent?: string;
  snippetLens?: number[];
  rerankTextLen?: number;
  gateTextLen?: number;
  collectionId?: number;
  collections?: string[];
  dateRange?: { start: string; end: string };
};
type VecResp =
  // `deadlineProtocol` (O1 §4): the daemon's per-response attestation that it implemented the
  // relative budget the request carried. A response WITHOUT it came from a pre-O1 daemon that
  // silently ignored the field, or answers a raw request that carried no budget (nothing was
  // enforced, so nothing is attested) — an O1 client classifies the leg `skew` (FTS), never `ok`.
  // `vectorFaultProtocol` + `vectorFaults` (82.2 D4): the daemon screened every returned distance and counted
  // what it dropped. Present on every scan answer of a `vf1` daemon; the count is omitted when it is zero.
  | { results: VecHit[]; deadlineProtocol?: string; vectorFaultProtocol?: string; vectorFaults?: number }
  // `vec_poison` (82.2 D4): the daemon's own embedding refused the QUERY vector — typed, as the model mismatch is.
  | { error: string; storedModels?: string[]; activeModel?: string; kind?: string; reason?: string; source?: string; context?: string; elementIndex?: number; norm?: number; index?: number }
  // Readiness/identity probe answer (eval daemon child, codex t76 constraint 3): the exact DB path
  // this daemon serves and the pid that owns the socket — a parent verifies both before trusting.
  // `protocols` (v0.38 hydrated daemon) advertises the response protocols this daemon can serve —
  // the watcher-preflight capability attestation (t84: only a `live` daemon attesting hydrated-v1
  // makes a daemon-required run authoritative; old clients ignore the extra field).
  | { pong: true; db: string; pid: number; protocols?: string[] }
  // Hydrated response lines (each is its own newline-delimited frame):
  | { protocol: typeof HYDRATED_PROTOCOL; count: number; deadlineProtocol?: string; vectorFaultProtocol?: string; vectorFaults?: number }
  | { entry: ProjectedVecResult }
  | { end: true };

/** Classified outcome of one daemon-routed vector leg — recorded per leg in the surfacing trace.
 * `oversized` (t84/t87): the daemon refused hydrated projection on a size cap (source-body ceiling,
 * entry cap, or frame cap) — the hook falls back to FTS with the vector candidates LOST for the
 * turn; traced distinctly from generic `error` so the degradation is attributable.
 * `skew` (O1 §4): the daemon answered WITHOUT attesting `deadline-rel-v1` — a pre-O1 watcher that
 * ignored the relative budget and ran with no deadline of its own; the leg degrades to FTS (the
 * client's timer still bounded it) and a once-per-process health warning names the socket.
 * `deadline` (codex migration r1 S1): the CLIENT's authoritative deadline ended the leg — its timer
 * fired, the window closed before a connection or before a whole transmissible millisecond, or a
 * monotonic check around a response-line parse found it crossed. Distinct from `error` (a daemon
 * that misbehaved): the surfacing trace records it with terminal kind `abandonment`.
 * `vector-fault` (82.2 D4): the embedding endpoint answered the QUERY with a vector that must not be
 * used (`VecPoisonError` / `EmbedEnvelopeError`) — in the daemon (a typed `vec_poison` frame) or in
 * the in-process path. The leg is lexical only. */
export type VecExecStatus = "ok" | "busy" | "error" | "absent" | "model_mismatch" | "oversized" | "skew" | "deadline" | "vector-fault";

/** Which response protocol actually served an `ok` leg (run-identity input, t84 CR-5/t85):
 * "hydrated-v1" = daemon-side projection; "raw-hit" = raw VecHit list + client-side hydration (a
 * request that never asked for hydration, answered by an attesting daemon — a legacy daemon's raw
 * answer is `skew`, never an ok leg, since O1 §4). */
export type VecResponseProtocol = typeof HYDRATED_PROTOCOL | "raw-hit";

/**
 * Strict structural validation of one hydrated entry (t89 S1): the wire is a same-user
 * socket, but a half-written peer, a version skew, or a corrupted frame must degrade to
 * FTS — never flow a malformed object into the hook's consumer branches as if it were a
 * projection. Every field the five consumer sites read is checked.
 */
export function isValidProjectedEntry(e: unknown): e is ProjectedVecResult {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return r.projected === true
    && typeof r.filepath === "string" && typeof r.displayPath === "string" && typeof r.title === "string"
    && typeof r.hash === "string" && typeof r.docid === "string" && typeof r.collectionName === "string"
    && typeof r.modifiedAt === "string"
    && typeof r.bodyLength === "number" && Number.isInteger(r.bodyLength) && r.bodyLength >= 0
    && typeof r.score === "number" && Number.isFinite(r.score)
    && r.source === "vec"
    && (r.chunkPos === undefined || (typeof r.chunkPos === "number" && Number.isFinite(r.chunkPos)))
    && (r.fragmentType === undefined || typeof r.fragmentType === "string")
    && (r.fragmentLabel === undefined || typeof r.fragmentLabel === "string")
    && (r.context === null || typeof r.context === "string")
    && !!r.snippets && typeof r.snippets === "object" && !Array.isArray(r.snippets)
    && HYDRATED_SNIPPET_LENS.every(l => typeof (r.snippets as Record<number, unknown>)[l] === "string")
    && typeof r.rerankText === "string"
    && typeof r.noise === "boolean" && typeof r.hasBody === "boolean" && typeof r.sanitizeFiltered === "boolean"
    && Array.isArray(r.gateTokens) && (r.gateTokens as unknown[]).every(t => typeof t === "string");
}

/** Strict shape check for one raw VecHit (t89 S1) — a malformed hit list degrades to FTS. */
export function isValidVecHit(h: unknown): h is VecHit {
  if (!h || typeof h !== "object") return false;
  const r = h as Record<string, unknown>;
  return typeof r.hash_seq === "string" && typeof r.distance === "number" && Number.isFinite(r.distance);
}

const POISON_REASONS: readonly VecPoisonReason[] = ["not-an-array", "empty", "non-number", "non-finite", "float32-overflow", "norm", "blob-length"];
const optionalInt = (v: unknown): v is number | undefined => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0);

/** The `vec_poison` frame for a refused query vector (82.2 D4). */
export function vecPoisonFrame(e: VecPoisonError | EmbedEnvelopeError): Record<string, unknown> {
  return e instanceof VecPoisonError
    ? { error: "vec_poison", kind: "vector", reason: e.reason, source: e.source, context: e.context,
        ...(e.elementIndex !== undefined ? { elementIndex: e.elementIndex } : {}),
        ...(e.norm !== undefined && Number.isFinite(e.norm) ? { norm: e.norm } : {}),
        ...(e.index !== undefined ? { index: e.index } : {}) }
    : { error: "vec_poison", kind: "envelope", reason: e.reason, context: e.context, ...(e.index !== undefined ? { index: e.index } : {}) };
}

/** Rebuild the typed error from a `vec_poison` frame; null for a frame that is not one (the leg is then `error`). */
export function vecPoisonFromFrame(frame: Record<string, unknown>): VecPoisonError | EmbedEnvelopeError | null {
  if (frame.error !== "vec_poison" || typeof frame.reason !== "string" || typeof frame.context !== "string" || !optionalInt(frame.index)) return null;
  const ctx = { context: frame.context, ...(frame.index !== undefined ? { index: frame.index } : {}) };
  if (frame.kind === "envelope") return new EmbedEnvelopeError(frame.reason, ctx);
  if (frame.kind !== "vector" || !POISON_REASONS.includes(frame.reason as VecPoisonReason)) return null;
  if (frame.source !== "endpoint" && frame.source !== "stored") return null;
  if (!optionalInt(frame.elementIndex) || !(frame.norm === undefined || (typeof frame.norm === "number" && Number.isFinite(frame.norm)))) return null;
  return new VecPoisonError(frame.reason as VecPoisonReason, frame.source as VectorSource, ctx, {
    ...(frame.elementIndex !== undefined ? { elementIndex: frame.elementIndex } : {}),
    ...(frame.norm !== undefined ? { norm: frame.norm as number } : {}),
  });
}

/** The fault count of a scan answer: absent = zero (the attestation was checked first); anything but a
 *  non-negative integer is a protocol error (`null`). */
function wireVectorFaults(v: unknown): number | null {
  if (v === undefined) return 0;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS): a SYNCHRONOUS busy-wait standing in for
 * the duration of the blocking sqlite-vec MATCH, applied wherever that scan would run — the eval
 * daemon child's scan and the in-process fallback below — so the CR-3 production-boundary test can
 * make the scan deterministically exceed a profile timeout in EITHER topology and prove that only
 * the daemon-backed one returns within budget. A no-op unless the env is set to a positive number.
 */
export function testSyncScanDelay(): void {
  const raw = process.env.CLAWMEM_TEST_VEC_SCAN_SYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = deadlineAfter(monoNow(), duration(ms));
  while (!isExpired(until)) { /* synchronous — the caller's race timer cannot fire, by design */ }
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_HYDRATE_SYNC_DELAY_MS): a SYNCHRONOUS busy-wait standing in for
 * a cold hydration first-touch. Under hydrated-v1 (the primary path) it runs inside the DAEMON's
 * projection — modeling a cold sqlite first-touch there so the CR-3 locks can prove the CLIENT's
 * deadline timer wins while the daemon is mid-projection. On the raw-hit COMPAT path it runs before
 * the client-side hydrate — the pre-v0.38 shape whose synchronous client hydration produced the
 * observed 1235/2906/3130ms late-`ok` daemon-required legs (codex t80 P1).
 */
export function testSyncHydrateDelay(): void {
  const raw = process.env.CLAWMEM_TEST_VEC_HYDRATE_SYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = deadlineAfter(monoNow(), duration(ms));
  while (!isExpired(until)) { /* synchronous — models a cold hydration first-touch (daemon-side projection under hydrated-v1; client-side hydrate on the raw-hit compat path) */ }
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_ENTRY_DECODE_SYNC_DELAY_MS): a SYNCHRONOUS busy-wait injected
 * before ONE hydrated entry line's JSON.parse — the t88 lock-(b) shape: a synchronous intra-entry
 * decode stall must NEVER produce a late `ok` (the per-entry before/after absolute-deadline checks
 * reclassify to error → FTS), and when its measured overrun exceeds the tolerance the independent
 * hard vector_deadline_ok gate FAILS the member. Not deadline-adherent by design — the protocol's
 * 64 KiB per-line bound is what makes a REAL parse slice sub-ms.
 */
export function testSyncEntryDecodeDelay(): void {
  const raw = process.env.CLAWMEM_TEST_VEC_ENTRY_DECODE_SYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = deadlineAfter(monoNow(), duration(ms));
  while (!isExpired(until)) { /* synchronous — models a pathologically slow single-line decode */ }
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_REQUEST_DECODE_SYNC_DELAY_MS): a SYNCHRONOUS busy-wait at the
 * start of the DAEMON's request handling, before the request line is decoded and validated —
 * server-side decode/validation time made deterministic, so the codex migration r1 P3 lock can
 * prove the advisory deadline is anchored at frame RECEIPT (the delay is spent inside the budget)
 * rather than after validation (where it would be granted on top of it). A no-op unless set.
 */
export function testSyncRequestDecodeDelay(): void {
  const raw = process.env.CLAWMEM_TEST_VEC_REQUEST_DECODE_SYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = deadlineAfter(monoNow(), duration(ms));
  while (!isExpired(until)) { /* synchronous — models a slow server-side decode/validation */ }
}

/**
 * TEST-ONLY seam (CLAWMEM_TEST_VEC_INTER_ENTRY_ASYNC_DELAY_MS): an AWAITED delay between hydrated
 * entry parses — the t88 lock-(a) shape: an inter-entry stall yields the event loop, so the IPC
 * deadline timer WINS within tolerance and the remaining entries are never parsed (decode
 * cancelled mid-stream).
 */
export async function testInterEntryAsyncDelay(): Promise<void> {
  const raw = process.env.CLAWMEM_TEST_VEC_INTER_ENTRY_ASYNC_DELAY_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise<void>(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket path — shared by daemon + hook client, keyed per vault DB path
// ─────────────────────────────────────────────────────────────────────────────

/** Parent dir for all clawmem daemon sockets ($XDG_RUNTIME_DIR/clawmem, fallback tmpdir). */
export function vecDaemonSocketDir(): string {
  const base = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(base, "clawmem");
}

/**
 * Per-vault socket path, keyed by a short hash of the vault DB path so multiple vaults
 * (general/work/personal) never collide on one socket. The daemon and the hook client both derive
 * the SAME path from the SAME `store.dbPath`, so they rendezvous without any shared registry.
 */
/**
 * Cheap PRE-CHECK heuristic: a daemon socket file exists for this vault.
 * This is an optimization to skip supplementary legs fast when no daemon was
 * ever started — it is NOT the correctness guard. A stale socket file passes
 * this check, so callers that must never run the in-process synchronous MATCH
 * (the hook's prior-turns leg, BUILD-1) route through searchVecDaemonRequired,
 * whose refused/absent outcome returns [] instead of falling back in-process
 * (codex turn-7 STANDARDS-1).
 */
export function vectorDaemonLikelyAvailable(dbPath: string): boolean {
  try {
    return existsSync(vecDaemonSocketPath(dbPath));
  } catch {
    return false;
  }
}

export function vecDaemonSocketPath(dbPath: string): string {
  const key = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  return join(vecDaemonSocketDir(), `vec-${key}.sock`);
}

/** Brief liveness probe: true if a listener accepts a connection on `sockPath`, false if refused/timeout. */
function isSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish(false), 250);
    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        // Resolve BEFORE ending the probe connection: end() can dispatch `close`
        // synchronously, and a close-first settle would report a LIVE daemon as
        // dead — whereupon the caller unlinks its socket and strands it.
        open(s) { finish(true); try { s.end(); } catch { /* ignore */ } },
        // Bun REQUIRES a data (or drain) handler: without one Bun.connect throws
        // synchronously ("Expected at least data or drain callback"), which the
        // caller's try/catch turned into "socket dir prep failed" — so any STALE
        // socket file silently prevented the watcher's daemon from ever binding
        // (codex t76 arc; caught by the eval child's foreign-daemon refusal test).
        data() { /* the probe sends nothing and reads nothing */ },
        close() { finish(false); },
        connectError() { finish(false); },
        error() { finish(false); },
      },
    }).catch(() => finish(false));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon (server) — hosted in the long-lived watcher (cmdWatch)
// ─────────────────────────────────────────────────────────────────────────────

export type VectorDaemonHandle = { close: () => void };

/**
 * Start the vector-query daemon on `store`'s DB. Returns a handle whose close() stops the listener and
 * unlinks the socket, or null if the socket could not be bound (best-effort — the hook's in-process
 * fallback still works, so a bind failure degrades to today's behavior, it never breaks the hook).
 *
 * SINGLE-FLIGHT: at most one MATCH runs at a time per vault. A request arriving while a scan is in
 * flight gets {error:"busy"} immediately (→ hook falls to FTS), never queues — this is what stops
 * abandoned cold scans from serializing and starving the watcher. Paired with a deadline check on
 * receipt: a request whose deadline already elapsed is rejected WITHOUT scanning, so requests that
 * piled up behind a cold-scan freeze are dropped (their hooks already gave up) instead of each
 * triggering a fresh wasted scan.
 */
export async function startVectorDaemon(
  store: Store,
  log: (msg: string) => void = () => {},
  // The Step-1 scan is injectable so tests can exercise the socket/single-flight/framing logic without
  // a live embedding server. Production omits it → the real searchVecMatch on the watcher's warm store.
  // It returns the scan WITH its fault count (82.2 D4). A bare hit list (an older injected scan) is
  // screened here, so nothing reaches the wire or the projection that the predicate did not judge.
  scan: (query: string, model: string, limit: number, deadline?: MonoDeadline) => Promise<VecScan | VecHit[]> =
    (query, model, limit, deadline) => searchVecMatch(store.db, query, model, limit, deadline),
): Promise<VectorDaemonHandle | null> {
  const sockPath = vecDaemonSocketPath(store.dbPath);
  try {
    // 0700 dir is the real access control (UnixSocketOptions has no `mode` field); the socket chmod
    // below is defense-in-depth. mkdir's `mode` only applies on CREATE, so chmod an existing dir too.
    mkdirSync(vecDaemonSocketDir(), { recursive: true, mode: 0o700 });
    try { chmodSync(vecDaemonSocketDir(), 0o700); } catch { /* best-effort */ }
    if (existsSync(sockPath)) {
      // A socket file already exists. If a LIVE daemon (another watcher for this vault) owns it, do NOT
      // clobber it — unlinking a live socket only makes the old listener unreachable-by-path while it
      // keeps running, stranding it. Probe first: bind only over a stale (dead) socket.
      if (await isSocketAlive(sockPath)) {
        log(`[vec-daemon] a live daemon already owns ${sockPath}; not starting a second`);
        return { close() { /* not ours — nothing to stop or unlink */ } };
      }
      rmSync(sockPath, { force: true }); // stale socket from a crashed watcher
    }
  } catch (e) {
    log(`[vec-daemon] socket dir prep failed: ${(e as Error).message}`);
    return null;
  }

  let scanInFlight = false;
  // v0.38.1: a pre-O1 client maps `version_skew` to its generic FTS fallback without a word, so
  // this daemon's log is the only place a mixed-build deployment can show. Logged once per daemon
  // (the watcher hosts one per process), never per request — an old hook sends one every prompt.
  let skewRefusalLogged = false;

  const respond = (socket: Socket<DaemonSocketData>, resp: VecResp) => {
    try {
      socket.write(JSON.stringify(resp) + "\n");
      socket.end();
    } catch { /* peer already gone — nothing to send */ }
  };

  /**
   * Hydrated multi-line response (t86): header + n entry lines + end line, each its own
   * newline-delimited JSON frame. Every entry is serialized INDIVIDUALLY and byte-accounted
   * (UTF-8 via TextEncoder) BEFORE anything is written: an entry over HYDRATED_MAX_ENTRY_BYTES
   * or a cumulative total over HYDRATED_MAX_FRAME_BYTES aborts to a single `oversized` frame —
   * never a partial response. Per-entry bounding is what makes the client's per-line parse a
   * bounded synchronous slice (t87 F2). The header's `deadlineProtocol` attestation is TRUE by
   * construction: a hydrated request without a relative budget is refused before any scan (codex
   * migration r1 P2), so every hydrated answer ran under an enforced advisory deadline.
   */
  const faultFields = (vectorFaults: number) => ({ vectorFaultProtocol: VECTOR_FAULT_PROTOCOL, ...(vectorFaults > 0 ? { vectorFaults } : {}) });

  const respondHydrated = (socket: Socket<DaemonSocketData>, results: ProjectedVecResult[], vectorFaults: number) => {
    const enc = new TextEncoder();
    const header = JSON.stringify({ protocol: HYDRATED_PROTOCOL, count: results.length, deadlineProtocol: DEADLINE_PROTOCOL, ...faultFields(vectorFaults) });
    const endLine = JSON.stringify({ end: true });
    let total = enc.encode(header).length + 1 + enc.encode(endLine).length + 1;
    const entryLines: string[] = [];
    for (const r of results) {
      const line = JSON.stringify({ entry: r });
      const bytes = enc.encode(line).length + 1;
      if (bytes > HYDRATED_MAX_ENTRY_BYTES || total + bytes > HYDRATED_MAX_FRAME_BYTES) {
        respond(socket, { error: "oversized" });
        return;
      }
      total += bytes;
      entryLines.push(line);
    }
    try {
      socket.write(header + "\n" + entryLines.map(l => l + "\n").join("") + endLine + "\n");
      socket.end();
    } catch { /* peer already gone */ }
  };

  const handleRequest = async (socket: Socket<DaemonSocketData>, line: string, receivedAt: MonoInstant) => {
    testSyncRequestDecodeDelay(); // TEST-ONLY: server-side decode/validation time, spent inside the window (P3 lock)
    let req: VecReq;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown> | null;
      // Ping: answered WITHOUT scanning and outside single-flight — a readiness/identity probe must
      // not be starved by an in-flight cold scan, and it must name the process + DB behind the socket.
      // `protocols` is the capability attestation (t84): this daemon serves hydrated-v1 AND, since
      // O1 activation, the relative-budget deadline protocol (§4: NEVER advertised while any
      // deadline path read wall time — both O1 ratchets are at zero in this build).
      if (parsed && typeof parsed === "object" && parsed.ping === true) {
        respond(socket, { pong: true, db: store.dbPath, pid: process.pid, protocols: [HYDRATED_PROTOCOL, DEADLINE_PROTOCOL, VECTOR_FAULT_PROTOCOL] });
        return;
      }
      // O1 §4 version skew, detected by FIELD PRESENCE before anything is decoded: a pre-O1
      // client's absolute wall-clock `deadlineMs` is never turned into a deadline of any kind. The
      // old client maps the unknown error to its generic FTS fallback and reconnects on the new
      // contract after its own restart (zero-debt activation needs no compatibility window).
      if (parsed && typeof parsed === "object" && "deadlineMs" in parsed) {
        respond(socket, { error: "version_skew" });
        if (!skewRefusalLogged) {
          // Only a line the sink ACCEPTED spends the once. A throwing sink is contained here: it
          // must never reach this request's error path (the answer above is final), and the next
          // refusal tries the line again.
          try {
            log(`[vec-daemon] refused a request from a pre-v0.38 client on ${sockPath} (absolute deadlineMs → version_skew) — its vector legs degrade to FTS until it runs this build (usually the hook, from another install); further refusals are not logged`);
            skewRefusalLogged = true;
          } catch { /* sink unavailable — the refusal stands; retry on the next one */ }
        }
        return;
      }
      req = parsed as VecReq;
      // t90 S1 (O1): remainingBudgetMs is a CONTROL field — a string/NaN/Infinity would bypass the
      // advisory deadline and defeat the daemon's deadline contract; validate its TYPE on EVERY
      // request (raw and hydrated) before anything else can consult it. Its RANGE is the contract
      // check below (`bad_request` — skew, never clamp).
      if (!req || typeof req.query !== "string" || typeof req.model !== "string" || typeof req.limit !== "number" || !Number.isFinite(req.limit)
        || (req.remainingBudgetMs !== undefined && !(typeof req.remainingBudgetMs === "number" && Number.isFinite(req.remainingBudgetMs)))) {
        throw new Error("bad request shape");
      }
    } catch {
      respond(socket, { error: "malformed" });
      return;
    }
    // O1 §2 budget validation — the t89 P3 refusal convention: a non-integer or out-of-range
    // remaining budget is version/config skew, refused BEFORE the scan, never clamped.
    if (req.remainingBudgetMs !== undefined && (!Number.isInteger(req.remainingBudgetMs) || req.remainingBudgetMs < 1 || req.remainingBudgetMs > MAX_LEG_BUDGET_MS)) {
      respond(socket, { error: "bad_request" });
      return;
    }
    // The daemon's ADVISORY deadline (O1 §2): monotonic, anchored at FRAME RECEIPT (codex migration
    // r1 P3) — the instant the socket event delivering the terminating newline began, sampled
    // before the decode and validation above — so it trails the client's authoritative timer by
    // one-way transit only (documented, not corrected); server-side decode/validation time is spent
    // INSIDE the window, never granted on top of it. Re-checked immediately BEFORE and AFTER each
    // synchronous phase; work already inside the MATCH or the projection is uninterruptible
    // (check-before / check-after, never cancellation).
    const advisoryDeadline = req.remainingBudgetMs !== undefined ? deadlineAfter(receivedAt, duration(req.remainingBudgetMs)) : undefined;
    const hydrated = req.responseProtocol !== undefined;
    // Codex migration r1 P2: hydrated-v1 is served ONLY under an enforced relative budget — a
    // hydrated request without `remainingBudgetMs` is contract skew, refused before any scan, so
    // every hydrated answer's `deadlineProtocol` attestation is true.
    if (hydrated && advisoryDeadline === undefined) {
      respond(socket, { error: "bad_request" });
      return;
    }
    // hydrated-v1 exact-constant validation (t87 F1): the request's projection params must equal
    // the protocol constants EXACTLY — never compute "what was asked" for arbitrary integers.
    if (hydrated && (
      req.responseProtocol !== HYDRATED_PROTOCOL
      || typeof req.presentationQuery !== "string"
      || JSON.stringify(req.snippetLens) !== JSON.stringify([...HYDRATED_SNIPPET_LENS])
      || req.rerankTextLen !== HYDRATED_RERANK_TEXT_LEN
      || req.gateTextLen !== HYDRATED_GATE_TEXT_LEN
      // t89 P3: hydrated-v1 REFUSES an out-of-contract limit — a non-integer or
      // out-of-range value is version/config skew, never a value to silently
      // clamp into a different candidate-count contract.
      || !Number.isInteger(req.limit) || req.limit < 1 || req.limit > HYDRATED_MAX_RESULTS
      // t89 S1: structural validation of the optional projection inputs — a
      // malformed shape must never reach the scan or the projection.
      || (req.intent !== undefined && typeof req.intent !== "string")
      || (req.collectionId !== undefined && !(typeof req.collectionId === "number" && Number.isFinite(req.collectionId)))
      || (req.collections !== undefined && !(Array.isArray(req.collections) && req.collections.every(c => typeof c === "string")))
      || (req.dateRange !== undefined && !(req.dateRange !== null && typeof req.dateRange === "object" && typeof req.dateRange.start === "string" && typeof req.dateRange.end === "string"))
    )) {
      respond(socket, { error: "bad_request" });
      return;
    }
    // Deadline-before-scan: drop an already-expired request without scanning (the pile-up guard).
    if (advisoryDeadline !== undefined && isExpired(advisoryDeadline)) {
      respond(socket, { error: "expired" });
      return;
    }
    if (scanInFlight) {
      respond(socket, { error: "busy" });
      return;
    }
    // Hydrated limits were validated EXACTLY above (t89 P3); only legacy raw requests keep the
    // compatibility clamp (a stray/hostile value must not drive an unbounded k = limit*3 scan).
    const safeLimit = hydrated ? req.limit : Math.min(Math.max(1, Math.trunc(req.limit)), MAX_VEC_LIMIT);
    scanInFlight = true;
    try {
      const scanned = await scan(req.query, req.model, safeLimit, advisoryDeadline);
      const { hits: results, vectorFaults } = Array.isArray(scanned) ? screenVecHits(scanned) : scanned;
      // t89 P4: a scan that finished past the advisory deadline must not proceed into projection —
      // the hook has already fallen back to FTS; answering `expired` releases single-flight for the
      // next request without touching a single body.
      if (advisoryDeadline !== undefined && isExpired(advisoryDeadline)) {
        respond(socket, { error: "expired" });
        return;
      }
      if (hydrated) {
        // The projection compute is the daemon-side analogue of the old client hydrate — the
        // test seam models a cold first-touch here so the CR-3 locks can prove the CLIENT's
        // IPC timer wins at its deadline while the daemon is mid-projection (t86).
        testSyncHydrateDelay();
        const projected = projectVecResults(store.db, results, {
          limit: safeLimit,
          presentationQuery: req.presentationQuery!,
          intent: req.intent,
          snippetLens: [...HYDRATED_SNIPPET_LENS],
          rerankTextLen: HYDRATED_RERANK_TEXT_LEN,
          gateTextLen: HYDRATED_GATE_TEXT_LEN,
          maxSourceBodyBytes: HYDRATED_MAX_SOURCE_BODY_BYTES,
          collectionId: req.collectionId,
          collections: req.collections,
          dateRange: req.dateRange,
        });
        respondHydrated(socket, projected, vectorFaults);
      } else {
        // Codex migration r1 P2: attest ONLY a budget this daemon enforced. A raw request without
        // `remainingBudgetMs` (a compatibility caller) ran under no deadline, so its answer carries
        // no attestation — an O1 client would (correctly) classify it `skew`.
        respond(socket, advisoryDeadline !== undefined ? { results, deadlineProtocol: DEADLINE_PROTOCOL, ...faultFields(vectorFaults) } : { results, ...faultFields(vectorFaults) });
      }
    } catch (e) {
      // Preserve the v0.18 read-model-mismatch "warn loudly once" contract across the wire: return a
      // TYPED error the client reconstructs into VecReadModelMismatchError so the hook's
      // warnOnceOnVectorModelMismatch (an instanceof check) still fires. Other errors stay generic.
      if (e instanceof VecReadModelMismatchError) {
        respond(socket, { error: "read_model_mismatch", storedModels: e.storedModels, activeModel: e.activeModel });
      } else if (isRefusedEmbedResponse(e)) {
        // 82.2 D4: the embedding endpoint answered the QUERY with a vector that must not be used. Typed, so
        // the client rebuilds the same error the in-process path throws and one route table covers both.
        respond(socket, vecPoisonFrame(e) as VecResp);
      } else if (e instanceof HydratedBodyOversizedError) {
        // t87 F1: a selected result's stored body exceeded the source ceiling — refused BEFORE
        // its body was fetched. Distinct outcome so the hook traces the candidate loss.
        respond(socket, { error: "oversized" });
      } else {
        respond(socket, { error: `internal: ${(e as Error).message}` });
      }
    } finally {
      scanInFlight = false;
    }
  };

  let server: { stop: (closeActiveConnections?: boolean) => void };
  try {
    server = Bun.listen<DaemonSocketData>({
      unix: sockPath,
      socket: {
        open(socket) { socket.data = { pending: new Uint8Array(0), total: 0 }; },
        data(socket, chunk) {
          // Codex migration r1 P3: the receipt instant, sampled FIRST — before byte accounting,
          // decode and validation — and the advisory deadline's anchor if this chunk completes
          // the frame.
          const receivedAt = monoNow();
          // Byte-accurate framing (t87 F3): accumulate RAW BYTES, cap on byte count, locate 0x0A
          // at the byte level, decode the complete line strictly. chunk.toString()+.length was
          // UTF-16 units and could split a code point across chunks.
          const u8 = chunk as unknown as Uint8Array;
          socket.data.total += u8.byteLength;
          if (socket.data.total > MAX_FRAME_BYTES) { respond(socket, { error: "oversized" }); return; }
          const merged = new Uint8Array(socket.data.pending.byteLength + u8.byteLength);
          merged.set(socket.data.pending, 0);
          merged.set(u8, socket.data.pending.byteLength);
          const nl = merged.indexOf(0x0A);
          if (nl < 0) { socket.data.pending = merged; return; } // partial frame — wait for the newline
          const line = decodeLineStrict(merged.subarray(0, nl));
          socket.data.pending = new Uint8Array(0); // one request per connection
          if (line === null) { respond(socket, { error: "bad_request" }); return; } // invalid UTF-8 — fail closed
          void handleRequest(socket, line, receivedAt);
        },
        error(_socket, err) { log(`[vec-daemon] socket error: ${err.message}`); },
      },
    });
  } catch (e) {
    log(`[vec-daemon] bind failed: ${(e as Error).message}`);
    return null;
  }

  try { chmodSync(sockPath, 0o600); } catch { /* best-effort; 0700 dir already restricts to owner */ }
  log(`[vec-daemon] listening on ${sockPath}`);

  return {
    close() {
      try { server.stop(true); } catch { /* already stopped */ }
      try { if (existsSync(sockPath)) rmSync(sockPath, { force: true }); } catch { /* best-effort */ }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook client + bounded search — used by BOTH context-surfacing vector legs
// ─────────────────────────────────────────────────────────────────────────────

type DaemonOutcome =
  | { status: "ok"; results: VecHit[]; vectorFaults: number }                      // attested raw hits for a raw request → client hydrates ("raw-hit" path)
  | { status: "ok-hydrated"; results: ProjectedVecResult[]; vectorFaults: number } // daemon-side projection (hydrated-v1) → zero client-side sqlite on the timed path
  | { status: "vector-fault"; error: VecPoisonError | EmbedEnvelopeError }          // 82.2 D4: the daemon's embedding refused the QUERY vector (typed `vec_poison` frame)
  | { status: "oversized" }                                  // daemon refused on a size cap → FTS with vector-candidate LOSS (traced distinctly)
  | { status: "busy" }    // daemon busy/expired → hook falls to FTS (do NOT re-run in-process)
  | { status: "error" }   // daemon present but timed out/misbehaving → fall to FTS
  | { status: "skew"; missing: string } // O1 §4: the answer lacks a protocol the request REQUIRES — no deadline-rel-v1 attestation (pre-O1 watcher), or raw hits to a hydrated request (codex migration r2 #1) → FTS + health warning naming it
  | { status: "deadline" } // codex migration r1 S1: the CLIENT's own deadline ended the leg (timer, pre-connect expiry, sub-ms remainder, parse-boundary check) → FTS; traced as abandonment
  | { status: "absent" }  // daemon not running → hook uses the in-process path
  | { status: "model_mismatch"; storedModels: string[]; activeModel: string }; // typed → hook warns once

/**
 * Send one Step-1 request to the daemon and classify the outcome. Self-bounds to `deadline` — the
 * CLIENT's authoritative monotonic timer (O1 §2): the request carries the remaining budget sampled
 * immediately before the write, the daemon's own deadline is advisory, and IPC transit is inside
 * the observable leg budget (which is what the gate has always measured). Every failure mode
 * resolves — this promise never rejects. A leg ended by that client deadline resolves `deadline`,
 * never `error` (codex migration r1 S1): the surfacing trace must tell an abandonment at the
 * deadline from a daemon that misbehaved.
 */
export async function daemonVecMatch(dbPath: string, req: VecReq, deadline: MonoDeadline): Promise<DaemonOutcome> {
  const sockPath = vecDaemonSocketPath(dbPath);
  if (!existsSync(sockPath)) return { status: "absent" };
  if (remainingForTimeout(deadline) === null) return { status: "deadline" }; // no budget left — don't even connect
  const hydratedReq = req.responseProtocol !== undefined;
  // Byte caps (t86/t87): a hydrated response may total up to HYDRATED_MAX_FRAME_BYTES with each
  // line ≤ HYDRATED_MAX_ENTRY_BYTES (the per-parse-slice bound); raw/legacy responses keep the
  // original single-frame cap. A legacy daemon answering a hydrated request sends one raw-hit
  // line (≤ ~30 KB at the 500-hit clamp) — under the entry cap, so the stricter line bound is
  // safe in hydrated mode.
  const frameCap = hydratedReq ? HYDRATED_MAX_FRAME_BYTES : MAX_FRAME_BYTES;
  const lineCap = hydratedReq ? HYDRATED_MAX_ENTRY_BYTES : MAX_FRAME_BYTES;

  return await new Promise<DaemonOutcome>((resolve) => {
    let settled = false;
    let opened = false;
    let closed = false;
    let sock: Socket<undefined> | null = null;
    // Byte-accurate framing (t87 F3): accumulate RAW bytes, locate 0x0A at the byte level,
    // enforce caps on byte counts BEFORE decode, strict-decode each complete line.
    let pending: Uint8Array = new Uint8Array(0);
    let totalBytes = 0;
    const lineQueue: Uint8Array[] = [];
    // Hydrated state machine: header → `count` entries → end line.
    let mode: "unknown" | "hydrated" = "unknown";
    let expected = 0;
    const entries: ProjectedVecResult[] = [];
    let hydratedFaults = 0;
    let pumping = false;

    let cancelTimer: () => void = () => {};
    const finish = (o: DaemonOutcome) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      try { sock?.end(); } catch { /* ignore */ }
      resolve(o);
    };
    // The authoritative leg timer: the client decides the leg outcome (O1 §2).
    cancelTimer = deadlineTimer(deadline, () => finish({ status: "deadline" }));

    const mapError = (resp: { error: string; storedModels?: string[]; activeModel?: string }): DaemonOutcome => {
      if (resp.error === "vec_poison") {
        const rebuilt = vecPoisonFromFrame(resp as Record<string, unknown>);
        return rebuilt ? { status: "vector-fault", error: rebuilt } : { status: "error" };
      }
      return mapPlainError(resp);
    };
    const mapPlainError = (resp: { error: string; storedModels?: string[]; activeModel?: string }): DaemonOutcome =>
      resp.error === "busy" || resp.error === "expired" ? { status: "busy" }
        : resp.error === "read_model_mismatch" ? { status: "model_mismatch", storedModels: resp.storedModels ?? [], activeModel: resp.activeModel ?? "" }
        : resp.error === "oversized" ? { status: "oversized" }
        : { status: "error" };

    // Incremental YIELDING decode (t86 CR-3 / t87 F2 / t88): one bounded line (≤ lineCap, enforced
    // pre-parse) per synchronous slice; an awaited macrotask between entries so the deadline timer
    // gets a scheduling slot; and a MONOTONIC deadline check BEFORE and AFTER every parse — a
    // decode completing past `deadline` is never classified ok, and entries after a deadline
    // crossing are never parsed (decode cancelled mid-stream).
    const pump = async (): Promise<void> => {
      if (pumping || settled) return;
      pumping = true;
      try {
        while (lineQueue.length > 0 && !settled) {
          if (isExpired(deadline)) { finish({ status: "deadline" }); return; }
          const lineBytes = lineQueue.shift()!;
          testSyncEntryDecodeDelay(); // t88 lock (b): a sync intra-entry stall — caught by the check below, never a late ok
          let obj: VecResp;
          try {
            obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lineBytes)) as VecResp;
          } catch { finish({ status: "error" }); return; } // invalid UTF-8 or malformed JSON — fail closed (t87 CR-6)
          if (isExpired(deadline)) { finish({ status: "deadline" }); return; }
          if (process.env.CLAWMEM_TEST_VEC_PARSE_TRACE === "1") console.error(`[vec-parse] line mode=${mode} n=${entries.length}`);
          if (mode === "unknown") {
            if (obj && typeof obj === "object" && "protocol" in obj && obj.protocol === HYDRATED_PROTOCOL) {
              // O1 §4: a header without the deadline attestation is a pre-O1 daemon — it ran the
              // scan with NO deadline of its own. The leg is `skew` (FTS), never ok.
              if (obj.deadlineProtocol !== DEADLINE_PROTOCOL) { finish({ status: "skew", missing: DEADLINE_PROTOCOL }); return; }
              // 82.2 D4: a header without the fault attestation is a daemon that never screened a distance —
              // its count is unknown, never zero. Capability skew, checked on the answer consumed.
              if (obj.vectorFaultProtocol !== VECTOR_FAULT_PROTOCOL) { finish({ status: "skew", missing: VECTOR_FAULT_PROTOCOL }); return; }
              const headerFaults = wireVectorFaults(obj.vectorFaults);
              if (headerFaults === null) { finish({ status: "error" }); return; }
              hydratedFaults = headerFaults;
              mode = "hydrated";
              expected = obj.count;
              // t89 S1: integer counts only — a fractional/NaN count is a malformed peer.
              if (!Number.isInteger(expected) || expected < 0 || expected > HYDRATED_MAX_RESULTS) { finish({ status: "error" }); return; }
            } else if (obj && "results" in obj) {
              // A raw-hit answer — a raw request answered by a current daemon (the caller hydrates
              // client-side). O1 §4: a LEGACY daemon ignoring the hydrated ask also answers raw
              // hits, but WITHOUT the deadline attestation — since it ran under no deadline, the
              // t84 raw-hit compatibility path is now `skew` (FTS); a legacy daemon is restarted,
              // not negotiated with.
              if (obj.deadlineProtocol !== DEADLINE_PROTOCOL) { finish({ status: "skew", missing: DEADLINE_PROTOCOL }); return; }
              // Codex migration r2 #1: a deadline attestation does not establish PROJECTION capability. Raw hits
              // answering a HYDRATED request would be hydrated synchronously on the hook's event loop (the
              // pre-v0.38 blocking shape hydrated-v1 exists to remove) — refused as capability skew before any
              // client-side hydration, never `ok`.
              if (hydratedReq) { finish({ status: "skew", missing: HYDRATED_PROTOCOL }); return; }
              // 82.2 D4: raw hits without the fault attestation were never screened — skew, as above.
              if (obj.vectorFaultProtocol !== VECTOR_FAULT_PROTOCOL) { finish({ status: "skew", missing: VECTOR_FAULT_PROTOCOL }); return; }
              const rawFaults = wireVectorFaults(obj.vectorFaults);
              // t89 S1: validate every hit; a malformed/mixed list degrades to FTS, never ok.
              if (rawFaults === null || !Array.isArray(obj.results) || !obj.results.every(isValidVecHit)) { finish({ status: "error" }); return; }
              // The daemon's hit check, again on this side: a `vf1` daemon never sends an unusable distance, so one
              // on the wire is a protocol error — it is not silently dropped and it is never hydrated.
              const screened = screenVecHits(obj.results);
              if (screened.vectorFaults > 0) { finish({ status: "error" }); return; }
              finish({ status: "ok", results: screened.hits, vectorFaults: rawFaults }); return;
            } else if (obj && "error" in obj) { finish(mapError(obj)); return; }
            else { finish({ status: "error" }); return; } // a pong (or anything else) is not a scan answer
          } else {
            if (obj && "entry" in obj) {
              // t89 S1: strict per-entry validation — a malformed entry can never become
              // ok-hydrated; the leg degrades to FTS.
              if (!isValidProjectedEntry(obj.entry)) { finish({ status: "error" }); return; }
              entries.push(obj.entry);
              if (entries.length > expected) { finish({ status: "error" }); return; }
            } else if (obj && "end" in obj) {
              if (entries.length !== expected) { finish({ status: "error" }); return; }
              finish({ status: "ok-hydrated", results: entries, vectorFaults: hydratedFaults }); return;
            } else if (obj && "error" in obj) { finish(mapError(obj)); return; }
            else { finish({ status: "error" }); return; }
          }
          await testInterEntryAsyncDelay(); // t88 lock (a): an inter-entry stall lets the timer WIN
          await new Promise<void>(r => setTimeout(r, 0)); // macrotask yield — the deadline timer can fire here
        }
        // The daemon half-closed and every queued line is consumed without a conclusive frame.
        if (closed && !settled && lineQueue.length === 0) finish(opened ? { status: "error" } : { status: "absent" });
      } finally { pumping = false; }
    };

    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        open(socket) {
          opened = true;
          sock = socket;
          // The remaining budget is sampled IMMEDIATELY before the write, never earlier (O1 §2):
          // connect latency has already been spent. A sub-millisecond remainder takes the fallback
          // LOCALLY — the client never transmits a request the daemon must reject.
          const left = remainingForTimeout(deadline);
          const budget = left === null ? null : wireBudget(left);
          if (budget === null) { finish({ status: "deadline" }); return; }
          try { socket.write(JSON.stringify({ ...req, remainingBudgetMs: budget }) + "\n"); }
          catch { finish({ status: "error" }); }
        },
        data(_socket, chunk) {
          if (settled) return;
          const u8 = chunk as unknown as Uint8Array;
          totalBytes += u8.byteLength;
          if (totalBytes > frameCap) { finish({ status: "error" }); return; } // cumulative byte cap, pre-parse
          // Cheap byte-level line extraction — NO decode, NO parse on this path.
          const merged = new Uint8Array(pending.byteLength + u8.byteLength);
          merged.set(pending, 0);
          merged.set(u8, pending.byteLength);
          let start = 0;
          for (let i = 0; i < merged.byteLength; i++) {
            if (merged[i] === 0x0A) {
              if (i - start > lineCap) { finish({ status: "error" }); return; } // per-line byte bound, pre-parse
              lineQueue.push(merged.slice(start, i));
              start = i + 1;
            }
          }
          pending = merged.slice(start);
          if (pending.byteLength > lineCap) { finish({ status: "error" }); return; } // an unterminated over-cap line never buffers on
          void pump();
        },
        // Connection refused / stale socket file (no live listener) → daemon effectively absent.
        connectError() { finish({ status: "absent" }); },
        // A close/error BEFORE the connection ever opened is a refused/stale socket
        // (absent — no listener); after open it is a listener that hung up (error).
        error() { finish(opened ? { status: "error" } : { status: "absent" }); },
        close() {
          // The daemon half-closes after writing its frames; lines may still sit in the local
          // queue. Let the pump drain them (it self-finishes on the end line) — conclude error
          // only when nothing conclusive remains in flight.
          closed = true;
          if (!settled && lineQueue.length === 0 && !pumping) finish(opened ? { status: "error" } : { status: "absent" });
        },
      },
    }).catch(() => finish({ status: "absent" })); // belt-and-suspenders for connect rejection
  });
}

/**
 * Readiness/identity probe (eval daemon child): one `{ping:true}` round trip. Resolves
 * `ok` with the DB path + pid the daemon reports, `absent` when no listener accepts (missing or
 * stale socket), `error` on timeout/malformed reply. Never rejects.
 */
export type DaemonPingResult =
  | { status: "ok"; db: string; pid: number; protocols: string[] }
  /** A LIVE clawmem daemon that predates the ping protocol (pre-v0.38): it answered the frame with its exact `malformed` refusal, so a listener speaking the daemon protocol serves this vault's path-keyed socket — but it cannot attest DB/pid. */
  | { status: "legacy" }
  | { status: "absent" | "error" };

export async function daemonPing(dbPath: string, timeoutMs: number): Promise<DaemonPingResult> {
  const sockPath = vecDaemonSocketPath(dbPath);
  if (!existsSync(sockPath)) return { status: "absent" };
  return await new Promise((resolve) => {
    let settled = false;
    let opened = false;
    // Byte-accurate framing here too (t89 S2): the pong carries the daemon's DB PATH — a
    // multibyte path split across socket chunks must never corrupt, and invalid UTF-8 is
    // refused, never U+FFFD-substituted into an identity comparison.
    let pending: Uint8Array = new Uint8Array(0);
    let totalBytes = 0;
    let sock: Socket<undefined> | null = null;
    const finish = (o: DaemonPingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.end(); } catch { /* ignore */ }
      resolve(o);
    };
    const timer = setTimeout(() => finish({ status: "error" }), Math.max(1, timeoutMs));
    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        open(socket) {
          opened = true;
          sock = socket;
          try { socket.write(JSON.stringify({ ping: true }) + "\n"); } catch { finish({ status: "error" }); }
        },
        data(_socket, chunk) {
          const u8 = chunk as unknown as Uint8Array;
          totalBytes += u8.byteLength;
          if (totalBytes > MAX_FRAME_BYTES) { finish({ status: "error" }); return; }
          const merged = new Uint8Array(pending.byteLength + u8.byteLength);
          merged.set(pending, 0);
          merged.set(u8, pending.byteLength);
          const nl = merged.indexOf(0x0A);
          if (nl < 0) { pending = merged; return; }
          const line = decodeLineStrict(merged.subarray(0, nl));
          if (line === null) { finish({ status: "error" }); return; } // invalid UTF-8 — fail closed
          try {
            const resp = JSON.parse(line) as VecResp;
            // t90 S1: the pong is an IDENTITY frame — validate it fail-closed. A malformed
            // protocols array or a non-integer pid is a malformed peer (error), never
            // silently coerced/filtered into an attestation. `protocols` ABSENT is the
            // valid pre-capability shape (→ [] → live-raw tiering).
            if ("pong" in resp && resp.pong === true && typeof resp.db === "string"
              && typeof resp.pid === "number" && Number.isInteger(resp.pid) && resp.pid > 0
              && (resp.protocols === undefined || (Array.isArray(resp.protocols) && resp.protocols.every((p) => typeof p === "string")))) {
              finish({ status: "ok", db: resp.db, pid: resp.pid, protocols: (resp.protocols as string[] | undefined) ?? [] });
            }
            else if ("error" in resp && resp.error === "malformed" && Object.keys(resp).length === 1) finish({ status: "legacy" });
            else finish({ status: "error" });
          } catch { finish({ status: "error" }); }
        },
        connectError() { finish({ status: "absent" }); },
        error() { finish(opened ? { status: "error" } : { status: "absent" }); },
        // Closed before a frame arrived: a refused/stale socket that never opened is
        // ABSENT (no listener); a listener that opened then hung up is an error.
        close() { finish(opened ? { status: "error" } : { status: "absent" }); },
      },
    }).catch(() => finish({ status: "absent" }));
  });
}

/** Operational liveness/ownership state of a vault's vector daemon (codex t77 F5). */
export type VectorDaemonHealth =
  | { status: "live"; socket: string; db: string; pid: number; protocols: string[] }
  /** Attested (exact DB + pid) but WITHOUT hydrated-v1, deadline-rel-v1 or (since v0.43.7) vf1 (t84/t89 P1, O1 §4, 82.2 D4): live, NOT Path-A authoritative — the v0.38 hook classifies its answers `skew` and falls back to FTS. */
  | { status: "live-raw"; socket: string; db: string; pid: number; protocols: string[] }
  /** A live clawmem daemon predating the ping protocol (pre-v0.38 watcher): serves this vault's path-keyed socket, cannot attest DB/pid — liveness is established, attestation is not. */
  | { status: "live-legacy"; socket: string }
  | { status: "absent" | "stale" | "unresponsive"; socket: string }
  | { status: "foreign-db"; socket: string; db: string; pid: number };

/**
 * Deployed-vault health check used by `clawmem doctor` and `clawmem
 * vec-daemon-health`: a REAL round trip, never a socket-file glob. "absent" =
 * no socket file; "stale" = a file nobody listens on (a crashed watcher);
 * "unresponsive" = a listener that did not answer within `timeoutMs`;
 * "foreign-db" = a listener serving a different DB path; "live" = the
 * watcher's daemon serving exactly `dbPath` AND attesting BOTH capabilities
 * the deadline contract certifies — hydrated-v1 projection and the O1
 * deadline-rel-v1 relative budget; "live-raw" = attested DB/pid but lacking
 * at least one of them (no daemon-side projection, or no relative budget);
 * "live-legacy" = a pre-v0.38 daemon (answers the frame protocol, has no
 * ping) on this vault's path-keyed socket — live, unattested. ONLY "live"
 * makes the context-surfacing hook's vector deadline authoritative on this
 * host (t89 P1): against a live-raw or live-legacy daemon the v0.38 hook
 * classifies every vector answer `skew` and falls back to FTS — it never
 * hydrates raw hits client-side (codex migration r2 #1).
 */
export async function vectorDaemonHealth(dbPath: string, timeoutMs = 2000): Promise<VectorDaemonHealth> {
  const socket = vecDaemonSocketPath(dbPath);
  if (!existsSync(socket)) return { status: "absent", socket };
  const pong = await daemonPing(dbPath, timeoutMs);
  if (pong.status === "legacy") return { status: "live-legacy", socket };
  if (pong.status !== "ok") return pong.status === "absent" ? { status: "stale", socket } : { status: "unresponsive", socket };
  if (pong.db !== dbPath) return { status: "foreign-db", socket, db: pong.db, pid: pong.pid };
  // t89 P1 + O1 §4: `live` is reserved for the Path-A-authoritative daemon — exact DB/pid AND
  // BOTH capabilities. An attested daemon without hydrated-v1 cannot answer the hook's hydrated
  // requests (its raw hits are `skew` → FTS); one without deadline-rel-v1 ignores the relative
  // budget and runs under no deadline of its own: live, but NOT what the deadline contract
  // certifies.
  // 82.2 D4: and the vector-fault protocol — a daemon without `vf1` answers scans the new clients class as
  // `skew`, so certifying it `live` would say the opposite of what every reply does.
  return pong.protocols.includes(HYDRATED_PROTOCOL) && pong.protocols.includes(DEADLINE_PROTOCOL) && pong.protocols.includes(VECTOR_FAULT_PROTOCOL)
    ? { status: "live", socket, db: pong.db, pid: pong.pid, protocols: pong.protocols }
    : { status: "live-raw", socket, db: pong.db, pid: pong.pid, protocols: pong.protocols };
}

/**
 * Bounded vector search for the hook path. Tries the daemon (hydrated-v1: scan + hydration +
 * projection ALL daemon-side) and degrades cleanly per the design contract:
 *   - ok-hydrated      → return the daemon's projected results (zero client-side sqlite)
 *   - ok (raw-hit)     → an attesting daemon answered a raw (non-hydrated) request — hydrate client-side
 *   - absent/refused   → in-process searchVec (today's self-bounded behavior; daemon not deployed)
 *   - model_mismatch   → throw VecReadModelMismatchError (mirrors in-process; the leg warns once → FTS)
 *   - busy/error/deadline/oversized/skew → return [] so the caller falls back to FTS
 *
 * Used by BOTH the primary and deep-escalation vector legs in context-surfacing, so every hook vector
 * call is bounded — not just the first.
 */
export async function searchVecBounded(
  store: Store,
  query: string,
  model: string,
  limit: number,
  collectionId?: number,
  collections?: string[],
  dateRange?: { start: string; end: string },
  deadline?: MonoDeadline,
  /** Optional per-leg outcome recorder (the surfacing trace's vectorLegs) — called before any
   * fallback runs. `protocol` names which response protocol served an ok leg (t84 CR-5):
   * "hydrated-v1" = daemon-side projection; "raw-hit" = raw hits + client-side hydration. */
  onOutcome?: (status: VecExecStatus, protocol?: VecResponseProtocol, vectorFaults?: number) => void,
  /** Hydrated-v1 request inputs (t87 F4): the RAW CURRENT PROMPT (snippet construction on every
   * leg) + the resolved session topic. Present → the leg requests daemon-side projection (a legacy
   * daemon's unattested raw answer is `skew` → FTS, since O1 §4). Absent → a raw request, answered
   * with raw hits the client hydrates (the raw-hit path). */
  hydration?: { presentationQuery: string; intent?: string },
): Promise<(SearchResult | ProjectedVecResult)[]> {
  const startedAt = monoNow();
  // The leg's authoritative deadline: the caller's, else the IPC default from now (O1 §2).
  const legDeadline = deadline ?? deadlineAfter(startedAt, duration(DEFAULT_IPC_TIMEOUT_MS));
  const req: VecReq = hydration
    ? { query, model, limit, responseProtocol: HYDRATED_PROTOCOL, presentationQuery: hydration.presentationQuery, intent: hydration.intent, snippetLens: [...HYDRATED_SNIPPET_LENS], rerankTextLen: HYDRATED_RERANK_TEXT_LEN, gateTextLen: HYDRATED_GATE_TEXT_LEN, collectionId, collections, dateRange }
    : { query, model, limit };
  const outcome = await daemonVecMatch(store.dbPath, req, legDeadline);
  const traceStatus: VecExecStatus = outcome.status === "ok-hydrated" ? "ok" : outcome.status;
  const protocol: VecResponseProtocol | undefined = outcome.status === "ok-hydrated" ? HYDRATED_PROTOCOL : outcome.status === "ok" ? "raw-hit" : undefined;
  if (outcome.status === "skew") warnOnceOnDaemonSkew(store.dbPath, outcome.missing);
  const legFaults = outcome.status === "ok" || outcome.status === "ok-hydrated" ? outcome.vectorFaults : undefined;
  if (onOutcome) { try { onOutcome(traceStatus, protocol, legFaults); } catch { /* recorder must never break the leg */ } }
  let results: (SearchResult | ProjectedVecResult)[];
  switch (outcome.status) {
    case "ok-hydrated":
      // Projection-complete daemon hydration (t83–t88): ZERO synchronous sqlite on this event
      // loop — the daemon computed every body-derived field the hook consumes.
      results = outcome.results;
      break;
    case "ok":
      // Raw-hit path (a raw request — no hydration asked — answered by an attesting daemon): the daemon bounded the SCAN;
      // hydration is a SYNCHRONOUS client-side sqlite read the caller's race timer cannot
      // interrupt (codex t80 P1). The seam models a cold hydrate.
      testSyncHydrateDelay();
      results = hydrateVecResults(store.db, outcome.results, limit, collectionId, collections, dateRange);
      break;
    case "absent":
      // In-process path: the synchronous MATCH runs on THIS event loop (the caller's race timer
      // cannot fire during it). The test seam models that scan's duration deterministically.
      testSyncScanDelay();
      {
        // 82.2 D4: the fault-carrying form — the count reaches the leg recorder here too.
        const found = await store.searchVecWithFaults(query, model, limit, collectionId, collections, dateRange, deadline);
        results = found.results;
        if (found.vectorFaults > 0 && onOutcome) { try { onOutcome(traceStatus, protocol, found.vectorFaults); } catch { /* recorder must never break the leg */ } }
      }
      break;
    case "model_mismatch":
      // Mirror the in-process path: throw the typed error so the leg's catch fires
      // warnOnceOnVectorModelMismatch (a persistent config error, warned loudly once), then FTS.
      throw new VecReadModelMismatchError(outcome.storedModels, outcome.activeModel);
    case "vector-fault":
      // 82.2 D4: the same typed error the in-process path throws, so the caller's route row applies to both.
      throw outcome.error;
    default: // "busy" | "error" | "oversized" | "skew" | "deadline" → let the caller's FTS fallback take over
      results = [];
      break;
  }
  if (VEC_TIMING) {
    console.error(`[vec-timing] path=${traceStatus}${protocol ? ` protocol=${protocol}` : ""} elapsedMs=${evidenceMs(elapsed(startedAt))} results=${results.length}`);
  }
  return results;
}

/**
 * Daemon-REQUIRED bounded vector search for SUPPLEMENTARY hook legs (the
 * prior-turns leg, BUILD-1). Unlike searchVecBounded it NEVER falls back to
 * the in-process synchronous MATCH: absent — including a STALE socket file
 * whose connect is refused — busy, error, and timeout all return [] so the
 * caller's FTS lanes carry the turn (codex turn-7 STANDARDS-1: the
 * existsSync pre-check alone let a stale socket route a supplementary leg
 * into the uninterruptible in-process scan).
 *   - ok             → hydrate the daemon's hits and return
 *   - model_mismatch → throw VecReadModelMismatchError (persistent config
 *                      error — same loud-once handling as the primary leg)
 *   - anything else  → []
 */
export async function searchVecDaemonRequired(
  store: Store,
  query: string,
  model: string,
  limit: number,
  collectionId?: number,
  collections?: string[],
  dateRange?: { start: string; end: string },
  deadline?: MonoDeadline,
  /** Optional per-leg outcome recorder (the surfacing trace's vectorLegs). `protocol` names which
   * response protocol served an ok leg (t84 CR-5). */
  onOutcome?: (status: VecExecStatus, protocol?: VecResponseProtocol, vectorFaults?: number) => void,
  /** Hydrated-v1 request inputs (t87 F4) — see searchVecBounded. */
  hydration?: { presentationQuery: string; intent?: string },
): Promise<(SearchResult | ProjectedVecResult)[]> {
  const startedAt = monoNow();
  // The leg's authoritative deadline: the caller's, else the IPC default from now (O1 §2).
  const legDeadline = deadline ?? deadlineAfter(startedAt, duration(DEFAULT_IPC_TIMEOUT_MS));
  const req: VecReq = hydration
    ? { query, model, limit, responseProtocol: HYDRATED_PROTOCOL, presentationQuery: hydration.presentationQuery, intent: hydration.intent, snippetLens: [...HYDRATED_SNIPPET_LENS], rerankTextLen: HYDRATED_RERANK_TEXT_LEN, gateTextLen: HYDRATED_GATE_TEXT_LEN, collectionId, collections, dateRange }
    : { query, model, limit };
  const outcome = await daemonVecMatch(store.dbPath, req, legDeadline);
  const traceStatus: VecExecStatus = outcome.status === "ok-hydrated" ? "ok" : outcome.status;
  const protocol: VecResponseProtocol | undefined = outcome.status === "ok-hydrated" ? HYDRATED_PROTOCOL : outcome.status === "ok" ? "raw-hit" : undefined;
  if (outcome.status === "skew") warnOnceOnDaemonSkew(store.dbPath, outcome.missing);
  const legFaults = outcome.status === "ok" || outcome.status === "ok-hydrated" ? outcome.vectorFaults : undefined;
  if (onOutcome) { try { onOutcome(traceStatus, protocol, legFaults); } catch { /* recorder must never break the leg */ } }
  let results: (SearchResult | ProjectedVecResult)[] = [];
  if (outcome.status === "ok-hydrated") {
    // Projection-complete daemon hydration — zero synchronous sqlite on this event loop.
    results = outcome.results;
  } else if (outcome.status === "ok") {
    // Raw-hit path: synchronous client-side hydrate — the daemon-required deadline bounds the
    // SCAN, not this rowid hydration (codex t80 P1); the seam models a cold hydrate.
    testSyncHydrateDelay();
    results = hydrateVecResults(store.db, outcome.results, limit, collectionId, collections, dateRange);
  } else if (outcome.status === "model_mismatch") {
    throw new VecReadModelMismatchError(outcome.storedModels, outcome.activeModel);
  } else if (outcome.status === "vector-fault") {
    throw outcome.error; // 82.2 D4: typed, as in searchVecBounded
  }
  if (VEC_TIMING) {
    console.error(`[vec-timing] path=${traceStatus}${protocol ? ` protocol=${protocol}` : ""} (daemon-required) elapsedMs=${evidenceMs(elapsed(startedAt))} results=${results.length}`);
  }
  return results;
}
