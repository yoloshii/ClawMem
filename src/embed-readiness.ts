/**
 * v0.43.5 (BACKLOG 77.1): the startup readiness wait of `clawmem embed` (DESIGN-77.1 §2 (a)).
 *
 * It applies to a self-hosted embed server with local fallback forbidden: `CLAWMEM_EMBED_URL` set,
 * `CLAWMEM_EMBED_API_KEY` not set, `CLAWMEM_NO_LOCAL_MODELS=true`. Through v0.43.4 such a run, started while its server
 * was still down, tripped the 60 s cooldown on the first request, failed every later one at once, charged every
 * pending document an attempt and wrote 0 vectors. The wait probes the server before the canary, the stale cleanup and
 * any document attempt, and skips the embedding when the server does not become ready in time.
 *
 * Every other shape (fallback allowed, cloud, no URL) skips the wait; its routing is unchanged (BACKLOG 77.2). The
 * budget bounds startup readiness only — after it, requests keep their own timeouts and the cooldown (BACKLOG 77.3).
 * Kept out of clawmem.ts so it can be tested: importing that module runs the CLI.
 */

import type { RemoteEmbedProbeResult } from "./llm.ts";
import { monoNow, deadlineAfter, remainingForTimeout, duration, shorter, sleep, signalAfter } from "./clock.ts";

export const DEFAULT_EMBED_WAIT_SEC = 120;
export const DEFAULT_EMBED_WAIT_INTERVAL_MS = 5_000;
export const DEFAULT_EMBED_PROBE_TIMEOUT_MS = 15_000;

export interface EmbedWaitOptions {
  /** 0 = exactly one probe, bounded by the probe timeout, no waiting. */
  budgetMs: number;
  intervalMs: number;
  probeTimeoutMs: number;
}

/** The two `LlamaCpp` methods the wait uses. */
export interface ReadinessTarget {
  probeRemoteEmbed(opts: { signal: AbortSignal }): Promise<RemoteEmbedProbeResult>;
  markRemoteEmbedReady(): void;
}

/** A probe that did not find the server ready. */
export type ProbeFailure = Exclude<RemoteEmbedProbeResult, { kind: "ok" }>;

export type ReadinessOutcome =
  | { status: "ready"; probes: number; result: Extract<RemoteEmbedProbeResult, { kind: "ok" }> }
  | { status: "instant-trip" | "expired"; probes: number; last: ProbeFailure }
  | { status: "aborted"; probes: number; last: ProbeFailure | null };

/** Whether `clawmem embed` waits for its server: a URL, no API key, local fallback forbidden. */
export function readinessWaitApplies(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.CLAWMEM_EMBED_URL && !env.CLAWMEM_EMBED_API_KEY && env.CLAWMEM_NO_LOCAL_MODELS === "true";
}

const WHOLE_NUMBER = /^(0|[1-9][0-9]*)$/;

function wholeNumber(raw: string, min: number): number | null {
  if (!WHOLE_NUMBER.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/** `--wait <seconds>`: a whole number ≥ 0. Checked on every run — a flag is explicit even where no wait applies. */
export function parseWaitFlag(value: string | undefined): number | undefined | { error: string } {
  if (value === undefined) return undefined;
  const n = wholeNumber(value, 0);
  return n === null ? { error: `--wait takes whole seconds, 0 or more (got "${value}")` } : n;
}

/**
 * Budget: `--wait` > `CLAWMEM_EMBED_WAIT_SEC` > 120 s. Interval: `CLAWMEM_EMBED_WAIT_INTERVAL_MS` > 5000. Probe
 * timeout: `CLAWMEM_EMBED_PROBE_TIMEOUT_MS` > 15000. An empty env value counts as unset. Called only where the wait
 * applies, so a mistyped knob never stops a run that does not wait.
 */
export function resolveEmbedWaitOptions(waitSec: number | undefined, env: NodeJS.ProcessEnv = process.env): EmbedWaitOptions | { error: string } {
  const knob = (name: string, min: number, fallback: number): number | { error: string } => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = wholeNumber(raw, min);
    return n === null ? { error: `${name} must be a whole number${min > 0 ? " greater than 0" : ", 0 or more"} (got "${raw}")` } : n;
  };
  const sec = waitSec ?? knob("CLAWMEM_EMBED_WAIT_SEC", 0, DEFAULT_EMBED_WAIT_SEC);
  const intervalMs = knob("CLAWMEM_EMBED_WAIT_INTERVAL_MS", 1, DEFAULT_EMBED_WAIT_INTERVAL_MS);
  const probeTimeoutMs = knob("CLAWMEM_EMBED_PROBE_TIMEOUT_MS", 1, DEFAULT_EMBED_PROBE_TIMEOUT_MS);
  for (const v of [sec, intervalMs, probeTimeoutMs]) if (typeof v === "object") return v;
  return { budgetMs: (sec as number) * 1_000, intervalMs: intervalMs as number, probeTimeoutMs: probeTimeoutMs as number };
}

/**
 * Wait for the server. ONE deadline, created before the first probe. Probe at once, then one probe per interval while
 * the deadline lasts; each probe's timeout and each sleep is the smaller of its own and the time left. Sleeps are
 * async, so the caller's lease heartbeat keeps firing. `ok` → the cooldown handoff (`markRemoteEmbedReady`), ready.
 * An instant-trip status stops at once. Transport, timeout, other HTTP statuses (a server mid-start may answer 503)
 * and malformed replies keep waiting. A zero budget makes exactly one probe, bounded by the probe timeout.
 */
export async function waitForRemoteEmbed(
  target: ReadinessTarget,
  opts: EmbedWaitOptions & { shouldAbort?: () => boolean },
): Promise<ReadinessOutcome> {
  const single = opts.budgetMs === 0;
  const deadline = deadlineAfter(monoNow(), duration(opts.budgetMs));
  const probeTimeout = duration(opts.probeTimeoutMs);
  let probes = 0;
  let last: ProbeFailure | null = null;
  for (;;) {
    if (opts.shouldAbort?.()) return { status: "aborted", probes, last };
    const left = single ? probeTimeout : remainingForTimeout(deadline);
    if (left === null) return { status: "expired", probes, last: last ?? { kind: "timeout" } };
    probes++;
    const result = await target.probeRemoteEmbed({ signal: signalAfter(shorter(probeTimeout, left)) });
    // The lease can be lost while a probe is in flight: check before accepting any result or clearing the cooldown.
    if (opts.shouldAbort?.()) return { status: "aborted", probes, last: result.kind === "ok" ? last : result };
    if (result.kind === "ok") {
      target.markRemoteEmbedReady();
      return { status: "ready", probes, result };
    }
    last = result;
    if (last.kind === "instant-trip") return { status: "instant-trip", probes, last };
    if (single) return { status: "expired", probes, last };
    const rest = remainingForTimeout(deadline);
    if (rest === null) return { status: "expired", probes, last };
    await sleep(shorter(duration(opts.intervalMs), rest));
  }
}

const SKIPPED = "embedding skipped before cleanup or any document attempt.";

function describe(r: ProbeFailure): string {
  return r.status !== undefined ? `${r.kind}, HTTP ${r.status}` : r.kind;
}

/** The expiry message; with a zero budget it names the one probe. */
export function formatNotReadyMessage(url: string, budgetMs: number, last: ProbeFailure): string {
  return budgetMs === 0
    ? `Embed server ${url} was not ready (one probe: ${describe(last)}); ${SKIPPED}`
    : `Embed server ${url} did not become ready within ${Math.round(budgetMs / 1_000)} s (last: ${describe(last)}); ${SKIPPED}`;
}

/** A squatted port: the endpoint answers HTTP but not the embeddings API. No cooldown or fallback applies here. */
export function formatInstantTripMessage(url: string, status: number): string {
  return `Embed server ${url} answers HTTP but not the embeddings API: HTTP ${status} — a correctly-routed embeddings ` +
    `endpoint never returns this status; another service is likely listening at that address. Check ` +
    `CLAWMEM_EMBED_URL. Embedding skipped before cleanup or any document attempt.`;
}
