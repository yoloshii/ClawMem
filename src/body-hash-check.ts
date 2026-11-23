/**
 * BACKLOG 82.3, operator rulings 74 A, 76 A, 77 A — stored BODIES that the old string binding altered: found and
 * reported, never repaired.
 *
 * Every version before 82.3 hashed a body WITH its leading byte-order mark and then stored it through the string
 * binding, which changed it: a leading U+FEFF was dropped (of two, one was kept); after a leading U+FFFE every later
 * UTF-16 code unit was stored byte-swapped. Every writer hashes exactly the text it stores, so such a row is the one
 * whose hash is not the hash of its text — measured on a 76,505-body vault copy, no other row differs. Paths and titles
 * carry no hash: their damage cannot be found this way.
 *
 * Read-only: SELECT statements on the caller's handle. Every body is examined on every run (76 A). The check fails while
 * an ACTIVE document holds a damaged body (77 A); a body held only by inactive documents, or by none, stays listed as a
 * record. `clawmem reindex --force` rewrites an active file-backed holder from its file; nothing else recovers the text.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "crypto";

export type BodyDamage = "feff-dropped" | "fffe-swapped" | "other";
export type BodyHolder = { id: number; active: number; reason: string | null; origin: string | null };
export type MismatchedBody = { hash: string; pattern: BodyDamage; documents: BodyHolder[] };
export type BodyHashScan = {
  /** Content rows read. */
  examined: number;
  /** The damaged bodies listed, at most `listLimit`. */
  found: MismatchedBody[];
  /** Every damaged body by pattern, listed or not. */
  counts: Record<BodyDamage, number>;
  /** Damaged bodies held by at least one ACTIVE document, listed or not. */
  heldActive: number;
  /** True when more damaged bodies exist than are listed. */
  limited: boolean;
};

const FEFF_UTF8 = new Uint8Array([0xef, 0xbb, 0xbf]);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Which alteration explains the row: its hash is the hash of the stored text with one U+FEFF put back in front, or of
 *  a U+FFFE followed by the stored text with each code unit's bytes swapped back. */
function classify(hash: string, stored: Uint8Array): BodyDamage {
  const withFeff = new Uint8Array(FEFF_UTF8.length + stored.length);
  withFeff.set(FEFF_UTF8);
  withFeff.set(stored, FEFF_UTF8.length);
  if (sha256(withFeff) === hash) return "feff-dropped";
  const text = new TextDecoder().decode(stored);
  const units: number[] = [0xfffe];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    units.push(((c & 0xff) << 8) | (c >> 8));
  }
  let original = "";
  for (let i = 0; i < units.length; i += 4096) original += String.fromCharCode(...units.slice(i, i + 4096));
  if (sha256(new TextEncoder().encode(original)) === hash) return "fffe-swapped";
  return "other";
}

/** Every content row whose hash is not the SHA-256 of its stored bytes, with the documents that hold it. */
export function scanBodyHashes(db: Database, opts: { listLimit?: number } = {}): BodyHashScan {
  const listLimit = opts.listLimit ?? 50;
  const counts: Record<BodyDamage, number> = { "feff-dropped": 0, "fffe-swapped": 0, other: 0 };
  const found: MismatchedBody[] = [];
  let examined = 0, heldActive = 0, total = 0;
  const holders = db.prepare(`SELECT id, active, deactivated_reason AS reason, origin FROM documents WHERE hash = ? ORDER BY id`);
  const rows = db.prepare(`SELECT hash, CAST(doc AS BLOB) AS body FROM content`);
  for (const row of rows.iterate() as Iterable<{ hash: string; body: Uint8Array | null }>) {
    examined++;
    const stored = row.body ?? new Uint8Array();
    if (sha256(stored) === row.hash) continue;
    const pattern = classify(row.hash, stored);
    counts[pattern]++;
    total++;
    const documents = holders.all(row.hash) as BodyHolder[];
    if (documents.some(d => d.active === 1)) heldActive++;
    if (found.length < listLimit) found.push({ hash: row.hash, pattern, documents });
  }
  return { examined, found, counts, heldActive, limited: total > found.length };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The doctor's block: one headline, then one line per listed body. `ok` is false while an active document holds one. */
export function describeBodyHashes(scan: BodyHashScan): { ok: boolean; lines: string[] } {
  const total = scan.counts["feff-dropped"] + scan.counts["fffe-swapped"] + scan.counts.other;
  if (total === 0) return { ok: true, lines: [`every body's hash is the hash of its text (${scan.examined} examined)`] };
  const SEE = `See "Stored bodies whose hash is not the hash of their text" in docs/troubleshooting.md.`;
  const head = `${plural(total, "stored body whose hash is not the hash of its text", "stored bodies whose hash is not the hash of their text")}` +
    ` (${scan.examined} examined): ` +
    `${scan.counts["feff-dropped"]} with a leading U+FEFF dropped, ${scan.counts["fffe-swapped"]} byte-swapped after a leading U+FFFE ` +
    `(the two ways versions before 0.43.7 altered a body that started with a mark), ` +
    `${scan.counts.other} other, of unknown cause. `;
  const tail = scan.heldActive > 0
    ? `${scan.heldActive} held by an active document: \`clawmem reindex --force\` rewrites a file-backed one from its file ` +
      `(after any stored-identifier cleanup); an API-born one has no source. ${SEE}`
    : `none held by an active document — kept as a record. ${SEE}`;
  const lines = [head + tail];
  for (const f of scan.found) {
    const who = f.documents.length === 0 ? "held by no document"
      : "documents " + f.documents.map(d => `id ${d.id} (${d.active === 1 ? "active" : `inactive${d.reason ? `: ${d.reason}` : ""}`}, ${d.origin ?? "no origin"})`).join(", ");
    lines.push(`content ${f.hash.slice(0, 16)}… (${f.pattern}): ${who}`);
  }
  if (scan.limited) lines.push("more bodies exist than are listed here (the counts above cover every one)");
  return { ok: scan.heldActive === 0, lines };
}
