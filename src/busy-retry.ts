/**
 * SQLITE_BUSY detection + bounded ASYNC retry (VSEARCH-TRUST-HARDENING (f).2).
 *
 * The awaits between attempts let the event loop breathe so the embed-lease heartbeat
 * (a setInterval on the same loop) fires; the caller's leaseLost flag is re-checked
 * between attempts so a reclaimed lease ABORTS instead of writing as a zombie holder.
 * Retry scope is SQLITE_BUSY only — every other error (including FatalVectorError
 * dimension/model/schema aborts) propagates unchanged on the first throw.
 */
import { EmbedLeaseLostError } from "./store.ts";

const SQLITE_BUSY_RE = /database is locked|SQLITE_BUSY/i;

export function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && SQLITE_BUSY_RE.test(err.message);
}

export async function retryOnBusyAsync<T>(
  fn: () => T,
  label: string,
  isLeaseLost: () => boolean,
  opts?: { delaysMs?: number[]; onRetry?: (label: string, attempt: number, delayMs: number) => void }
): Promise<T> {
  const delays = opts?.delaysMs ?? [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try { return fn(); }
    catch (err) {
      if (!isSqliteBusyError(err) || attempt >= delays.length) throw err;
      opts?.onRetry?.(label, attempt + 1, delays[attempt]!);
      await new Promise(res => setTimeout(res, delays[attempt]!));
      if (isLeaseLost()) throw new EmbedLeaseLostError();
    }
  }
}
