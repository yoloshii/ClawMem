/**
 * Vector-query daemon (BACKLOG Source 46) — HARD cap on the cold synchronous sqlite-vec MATCH.
 *
 * The context-surfacing UserPromptSubmit hook runs a SYNCHRONOUS sqlite-vec MATCH (searchVecMatch).
 * bun:sqlite exposes no interrupt/progress handler, so a cold scan on a large vault blocks the hook's
 * single event loop past its 8-15s budget — an in-thread `Promise.race(vectorTimeout)` cannot fire
 * while a synchronous call runs. This daemon relocates JUST Step 1 (the MATCH) onto the long-lived
 * watcher process: the hook sends the query string over a per-vault unix socket and races the reply
 * against a REAL setTimeout (its own event loop is now free), then hydrates locally (Step 2).
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
import { searchVecMatch, hydrateVecResults, VecReadModelMismatchError, type Store, type SearchResult } from "./store.ts";

// Newline-delimited JSON, one request/response per connection. A query string and a list of
// {hash_seq, distance} are both small; anything over this cap is a protocol violation, so both sides
// reject it rather than buffer unbounded on a runaway/hostile peer.
const MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_IPC_TIMEOUT_MS = 5000;
// A stray/hostile `limit` (same-user socket) must not become an unbounded `k = limit * 3` scan. The
// hook only ever asks for ~5-10; clamp anything outside a sane range.
const MAX_VEC_LIMIT = 500;

// Env-gated phase timing (CLAWMEM_VEC_TIMING=1): logs each hook vector leg's outcome + elapsed to
// stderr so a future `UserPromptSubmit hook timed out` is attributable — daemon engaged & fast, vs
// daemon-absent in-process fallback (the old slow path), vs daemon busy/error → FTS. Off by default.
const VEC_TIMING = process.env.CLAWMEM_VEC_TIMING === "1" || process.env.CLAWMEM_VEC_TIMING === "true";

type VecHit = { hash_seq: string; distance: number };
type VecReq = { query: string; model: string; limit: number; deadlineMs?: number };
type VecResp = { results: VecHit[] } | { error: string; storedModels?: string[]; activeModel?: string };

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
        open(s) { try { s.end(); } catch { /* ignore */ } finish(true); },
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
  scan: (query: string, model: string, limit: number, deadlineMs?: number) => Promise<VecHit[]> =
    (query, model, limit, deadlineMs) => searchVecMatch(store.db, query, model, limit, deadlineMs),
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

  const respond = (socket: Socket<{ buf: string }>, resp: VecResp) => {
    try {
      socket.write(JSON.stringify(resp) + "\n");
      socket.end();
    } catch { /* peer already gone — nothing to send */ }
  };

  const handleRequest = async (socket: Socket<{ buf: string }>, line: string) => {
    let req: VecReq;
    try {
      req = JSON.parse(line) as VecReq;
      if (typeof req.query !== "string" || typeof req.model !== "string" || typeof req.limit !== "number" || !Number.isFinite(req.limit)) {
        throw new Error("bad request shape");
      }
    } catch {
      respond(socket, { error: "malformed" });
      return;
    }
    // Deadline-on-receipt: drop already-expired requests without scanning (the pile-up guard).
    if (req.deadlineMs !== undefined && Date.now() >= req.deadlineMs) {
      respond(socket, { error: "expired" });
      return;
    }
    if (scanInFlight) {
      respond(socket, { error: "busy" });
      return;
    }
    // Clamp limit so a stray/hostile value can't drive an unbounded k = limit*3 scan.
    const safeLimit = Math.min(Math.max(1, Math.trunc(req.limit)), MAX_VEC_LIMIT);
    scanInFlight = true;
    try {
      const results = await scan(req.query, req.model, safeLimit, req.deadlineMs);
      respond(socket, { results });
    } catch (e) {
      // Preserve the v0.18 read-model-mismatch "warn loudly once" contract across the wire: return a
      // TYPED error the client reconstructs into VecReadModelMismatchError so the hook's
      // warnOnceOnVectorModelMismatch (an instanceof check) still fires. Other errors stay generic.
      if (e instanceof VecReadModelMismatchError) {
        respond(socket, { error: "read_model_mismatch", storedModels: e.storedModels, activeModel: e.activeModel });
      } else {
        respond(socket, { error: `internal: ${(e as Error).message}` });
      }
    } finally {
      scanInFlight = false;
    }
  };

  let server: { stop: (closeActiveConnections?: boolean) => void };
  try {
    server = Bun.listen<{ buf: string }>({
      unix: sockPath,
      socket: {
        open(socket) { socket.data = { buf: "" }; },
        data(socket, chunk) {
          socket.data.buf += chunk.toString();
          if (socket.data.buf.length > MAX_FRAME_BYTES) { respond(socket, { error: "oversized" }); return; }
          const nl = socket.data.buf.indexOf("\n");
          if (nl < 0) return; // partial frame — wait for the newline
          const line = socket.data.buf.slice(0, nl);
          socket.data.buf = ""; // one request per connection
          void handleRequest(socket, line);
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
  | { status: "ok"; results: VecHit[] }
  | { status: "busy" }    // daemon busy/expired → hook falls to FTS (do NOT re-run in-process)
  | { status: "error" }   // daemon present but timed out/misbehaving → fall to FTS
  | { status: "absent" }  // daemon not running → hook uses the in-process path
  | { status: "model_mismatch"; storedModels: string[]; activeModel: string }; // typed → hook warns once

/**
 * Send one Step-1 request to the daemon and classify the outcome. Self-bounds to `ipcTimeoutMs`
 * (the caller passes the remaining wall-clock budget) so the client cleans up its own socket well
 * before the hook's outer timer fires. Every failure mode resolves — this promise never rejects.
 */
export async function daemonVecMatch(dbPath: string, req: VecReq, ipcTimeoutMs: number): Promise<DaemonOutcome> {
  const sockPath = vecDaemonSocketPath(dbPath);
  if (!existsSync(sockPath)) return { status: "absent" };
  if (ipcTimeoutMs <= 0) return { status: "error" }; // no budget left — don't even connect

  return await new Promise<DaemonOutcome>((resolve) => {
    let settled = false;
    let buf = "";
    let sock: Socket<undefined> | null = null;
    const finish = (o: DaemonOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.end(); } catch { /* ignore */ }
      resolve(o);
    };
    const timer = setTimeout(() => finish({ status: "error" }), ipcTimeoutMs);

    Bun.connect<undefined>({
      unix: sockPath,
      socket: {
        open(socket) {
          sock = socket;
          try { socket.write(JSON.stringify(req) + "\n"); }
          catch { finish({ status: "error" }); }
        },
        data(_socket, chunk) {
          buf += chunk.toString();
          if (buf.length > MAX_FRAME_BYTES) { finish({ status: "error" }); return; }
          const nl = buf.indexOf("\n");
          if (nl < 0) return; // partial frame — keep reading
          try {
            const resp = JSON.parse(buf.slice(0, nl)) as VecResp;
            if ("results" in resp) finish({ status: "ok", results: resp.results });
            else if (resp.error === "busy" || resp.error === "expired") finish({ status: "busy" });
            else if (resp.error === "read_model_mismatch") finish({ status: "model_mismatch", storedModels: resp.storedModels ?? [], activeModel: resp.activeModel ?? "" });
            else finish({ status: "error" });
          } catch { finish({ status: "error" }); }
        },
        // Connection refused / stale socket file (no live listener) → daemon effectively absent.
        connectError() { finish({ status: "absent" }); },
        error() { finish({ status: "error" }); },
        close() { finish({ status: "error" }); }, // closed before a full frame arrived
      },
    }).catch(() => finish({ status: "absent" })); // belt-and-suspenders for connect rejection
  });
}

/**
 * Bounded vector search for the hook path. Tries the daemon (Step-1 MATCH off the hook's event loop),
 * hydrates locally (Step-2), and degrades cleanly per the design contract:
 *   - ok               → hydrate the daemon's hits and return
 *   - absent/refused   → in-process searchVec (today's self-bounded behavior; daemon not deployed)
 *   - model_mismatch   → throw VecReadModelMismatchError (mirrors in-process; the leg warns once → FTS)
 *   - busy/error/timeout → return [] so the caller falls back to FTS
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
  deadlineMs?: number,
): Promise<SearchResult[]> {
  const startedAt = VEC_TIMING ? Date.now() : 0;
  const ipcTimeoutMs = deadlineMs !== undefined ? deadlineMs - Date.now() : DEFAULT_IPC_TIMEOUT_MS;
  const outcome = await daemonVecMatch(store.dbPath, { query, model, limit, deadlineMs }, ipcTimeoutMs);
  let results: SearchResult[];
  switch (outcome.status) {
    case "ok":
      results = hydrateVecResults(store.db, outcome.results, limit, collectionId, collections, dateRange);
      break;
    case "absent":
      results = await store.searchVec(query, model, limit, collectionId, collections, dateRange, deadlineMs);
      break;
    case "model_mismatch":
      // Mirror the in-process path: throw the typed error so the leg's catch fires
      // warnOnceOnVectorModelMismatch (a persistent config error, warned loudly once), then FTS.
      throw new VecReadModelMismatchError(outcome.storedModels, outcome.activeModel);
    default: // "busy" | "error" → let the caller's FTS fallback take over
      results = [];
      break;
  }
  if (VEC_TIMING) {
    console.error(`[vec-timing] path=${outcome.status} elapsedMs=${Date.now() - startedAt} results=${results.length}`);
  }
  return results;
}
