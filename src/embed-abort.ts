/**
 * v0.43.7 (BACKLOG 82.2, D2): the bookkeeping of a FATAL `clawmem embed` abort — one finaliser, called from the
 * command's fatal `catch`. No whole-run rollback exists: fragments committed earlier in the run stay (each was
 * validated and is its own transaction). What the finaliser decides:
 *
 *  - REFUND, conditional and applied once. When the abort was caused by a refused RESPONSE (the endpoint's failure,
 *    not the document's) and the document in hand has a charge receipt, the attempt `markEmbedStart` charged is given
 *    back and the error text recorded — for exactly the receipt's rows. So repeated poisoned runs cannot exhaust a
 *    document's three attempts. No receipt (the start marker did not commit) → no refund. Any other fatal error
 *    keeps the old accounting.
 *  - TAINT. When the run cleared the index or committed any vector and end verification did not run, the existing
 *    unverified taint is set; the previous canary baseline is left untouched. A plain retry does not clear it.
 *  - LEASE LOSS. Every write asserts ownership. If the lease was lost, NOTHING is written (the successor owns the
 *    state) and the report says so.
 *  - A write still busy after its retries is reported as NOT recorded — never implied done.
 */
import { EmbedLeaseLostError, type LeaseGuard, type Store } from "./store.ts";
import { isRefusedEmbedResponse } from "./vector-guard.ts";
import { retryOnBusyAsync, isSqliteBusyError } from "./busy-retry.ts";
import { isoNow } from "./clock.ts";

export type EmbedChargeReceipt = { hash: string; chargedIds: number[] };

export type EmbedAbortState = {
  err: Error;
  /** The document being embedded when the run stopped, with the rows its start marker charged; null when none, or when the marker did not commit. */
  docInHand: EmbedChargeReceipt | null;
  clearedIndex: boolean;
  vectorsCommitted: number;
  /** True once the end-of-run verification reached its own verdict (it handles the taint itself). */
  endVerificationRan: boolean;
  leaseLost: boolean;
  leaseGuard?: LeaseGuard;
};

export type EmbedAbortReport = {
  refund: "refunded" | "none" | "not-recorded" | "skipped-lease-lost";
  taint: "set" | "not-needed" | "not-recorded" | "skipped-lease-lost";
  /** What to tell the operator, one line per state that applies. */
  lines: string[];
};

export const EMBED_TAINT_FLAG = "embed_geometry_taint";

export async function finaliseEmbedAbort(
  s: Store, st: EmbedAbortState, opts?: { delaysMs?: number[] },
): Promise<EmbedAbortReport> {
  const lostLine = "The embedding lease was lost: no bookkeeping was written (the process that took the lease owns the state).";
  if (st.leaseLost || st.err instanceof EmbedLeaseLostError) {
    return { refund: "skipped-lease-lost", taint: "skipped-lease-lost", lines: [lostLine] };
  }
  const lines: string[] = [];
  let leaseLost = false;
  /** One bookkeeping write: "done", "lost" (the lease is gone — stop writing), or "busy" (not recorded). */
  const write = async (label: string, fn: () => void): Promise<"done" | "lost" | "busy"> => {
    try { await retryOnBusyAsync(fn, label, () => false, { delaysMs: opts?.delaysMs }); return "done"; }
    catch (e) {
      if (e instanceof EmbedLeaseLostError) return "lost";
      if (isSqliteBusyError(e)) return "busy";
      throw e;
    }
  };

  let refund: EmbedAbortReport["refund"] = "none";
  if (isRefusedEmbedResponse(st.err) && st.docInHand && st.docInHand.chargedIds.length > 0) {
    const doc = st.docInHand;
    const outcome = await write("refundEmbedAttempt", () => { s.refundEmbedAttempt(doc.hash, doc.chargedIds, st.err.message, st.leaseGuard); });
    if (outcome === "done") {
      refund = "refunded";
      lines.push("The document being embedded stays pending; its attempt was not charged (the endpoint failed, not the document) and the error is recorded on it.");
    } else if (outcome === "busy") {
      refund = "not-recorded";
      lines.push("The refund of the document's attempt was NOT recorded (the database was still busy after the retries).");
    } else { leaseLost = true; }
  }
  if (leaseLost) return { refund: "skipped-lease-lost", taint: "skipped-lease-lost", lines: [lostLine] };

  let taint: EmbedAbortReport["taint"] = "not-needed";
  if ((st.clearedIndex || st.vectorsCommitted > 0) && !st.endVerificationRan) {
    const what = st.clearedIndex ? "the index was cleared" : `${st.vectorsCommitted} vector(s) were stored`;
    const outcome = await write("setVaultFlag(taint)", () => s.setVaultFlag(EMBED_TAINT_FLAG, `aborted run at ${isoNow()}: ${what} and the end of the run was not verified`, st.leaseGuard));
    if (outcome === "done") {
      taint = "set";
      lines.push(`The vault is marked UNVERIFIED (${what} before the abort, and the end of the run was not verified). A plain retry does not clear that mark: only a verified full rebuild ('clawmem embed --force') does. The previous canary baseline was left as it was.`);
    } else if (outcome === "busy") {
      taint = "not-recorded";
      lines.push(`The UNVERIFIED mark was NOT recorded (the database was still busy after the retries) although ${what} before the abort.`);
    } else {
      return { refund: refund === "refunded" ? refund : "skipped-lease-lost", taint: "skipped-lease-lost", lines: [...lines, lostLine] };
    }
  }
  if (lines.length === 0) lines.push("Nothing was stored or cleared by this run, and no bookkeeping was needed.");
  return { refund, taint, lines };
}
