/**
 * 62.1 D4: session documents — the decisions, antipatterns and handoff documents of one (session id, transcript) —
 * rendered from the pipeline's items, never merged or overwritten with a window of the transcript.
 *
 * Items (`stop_items`) are the durable record: one row per item, fingerprinted over its FULL persisted content, so an
 * exact re-emission is dropped and any changed evidence kept (paraphrases stay a named limit). A session document is
 * a RENDER of all of its items in transcript order, written by `upsertSessionDoc` at a canonical path fixed at first
 * creation (`<prefix>/<first render date>-<sid8>.md`; a second transcript of the same session id, or a path already
 * held by a document this pipeline did not create, gets `-<tk6>`). The write is path-authoritative: an active
 * API-owned row has its body replaced (revision + 1, no hash-window dedup), an absent one is inserted, a
 * filesystem-owned one is refused, an inactive one is left alone with its items kept — the reconciler re-renders it
 * when it is restored. Every write carries a doc stamp (D9).
 */

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { isoNow } from "./clock.ts";
import { freshStamp, lastChanges } from "./stop-schema.ts";
import { insertContent } from "./content-insert.ts";
import { normalizedContent, stripLeadingMarks } from "./text-policy.ts";

export type SessionDocKind = "decisions" | "antipatterns" | "handoff";
export type StopItemKind = "decision" | "antipattern" | "turn-digest" | "handoff-summary";

const PATH_PREFIX: Record<SessionDocKind, string> = { decisions: "decisions", antipatterns: "antipatterns", handoff: "handoffs" };
const CONTENT_TYPE: Record<SessionDocKind, string> = { decisions: "decision", antipatterns: "antipattern", handoff: "handoff" };
const DEFAULT_CONFIDENCE: Record<SessionDocKind, number> = { decisions: 0.85, antipatterns: 0.75, handoff: 0.6 };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeValue(v: unknown): unknown {
  if (typeof v === "string") return v.normalize("NFC").replace(/\s+/g, " ").trim();
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = normalizeValue((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** sha256 over the item's full content, normalized (key order, NFC, whitespace) — lexical identity, by design. */
export function itemFingerprint(payload: unknown): string {
  return sha256(JSON.stringify(normalizeValue(payload)));
}

export type StopItemInput = {
  sessionId: string;
  transcriptKey: string;
  kind: StopItemKind;
  fp: string;
  payload: unknown;
  anchorEpoch: number;
  rangeFrom?: number | null;
  rangeTo?: number | null;
  rangeSha?: string | null;
  seq?: number | null;
  docId?: number | null;
};

/** Record an item once; false when an item with the same fingerprint already exists for this transcript. */
export function insertStopItem(db: Database, it: StopItemInput): boolean {
  db.prepare(
    `INSERT OR IGNORE INTO stop_items (session_id, transcript_key, kind, fp, anchor_epoch, range_from, range_to, range_sha, seq, payload, doc_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(it.sessionId, it.transcriptKey, it.kind, it.fp, it.anchorEpoch, it.rangeFrom ?? null, it.rangeTo ?? null,
    it.rangeSha ?? null, it.seq ?? null, JSON.stringify(it.payload), it.docId ?? null, isoNow());
  return lastChanges(db) === 1;
}

type ItemRow = { payload: string };
function itemsOf(db: Database, sessionId: string, transcriptKey: string, kind: StopItemKind): unknown[] {
  return (db.prepare(
    `SELECT payload FROM stop_items WHERE session_id = ? AND transcript_key = ? AND kind = ?
     ORDER BY anchor_epoch, range_from, created_at, fp`
  ).all(sessionId, transcriptKey, kind) as ItemRow[]).map(r => JSON.parse(r.payload));
}

export type SessionDocRow = {
  path: string;
  docId: number | null;
  renderedFp: string | null;
  renderNeeded: boolean;
  endedAt: string | null;
  createdAt: string;
};

export function readSessionDoc(db: Database, sessionId: string, transcriptKey: string, kind: SessionDocKind): SessionDocRow | null {
  const r = db.prepare(
    `SELECT path, doc_id, rendered_fp, render_needed, ended_at, created_at FROM session_docs WHERE session_id = ? AND transcript_key = ? AND kind = ?`
  ).get(sessionId, transcriptKey, kind) as { path: string; doc_id: number | null; rendered_fp: string | null; render_needed: number; ended_at: string | null; created_at: string } | null;
  return r ? { path: r.path, docId: r.doc_id, renderedFp: r.rendered_fp, renderNeeded: r.render_needed === 1, endedAt: r.ended_at, createdAt: r.created_at } : null;
}

/** The session document's canonical path, fixed at first creation. Null when no path can be claimed. */
function claimSessionDocPath(db: Database, sessionId: string, transcriptKey: string, kind: SessionDocKind, now: string): string | null {
  const existing = readSessionDoc(db, sessionId, transcriptKey, kind);
  if (existing) return existing.path;
  const base = `${PATH_PREFIX[kind]}/${now.slice(0, 10)}-${sessionId.slice(0, 8)}`;
  const suffixed = `${base}-${transcriptKey.slice(0, 6)}.md`;
  const taken = (p: string) =>
    !!db.prepare(`SELECT 1 FROM documents WHERE collection = '_clawmem' AND path = ?`).get(p)
    || !!db.prepare(`SELECT 1 FROM session_docs WHERE path = ?`).get(p);
  const otherTranscript = !!db.prepare(
    `SELECT 1 FROM session_docs WHERE session_id = ? AND kind = ? AND transcript_key <> ?`
  ).get(sessionId, kind, transcriptKey);
  const path = !otherTranscript && !taken(`${base}.md`) ? `${base}.md` : !taken(suffixed) ? suffixed : null;
  if (!path) return null;
  db.prepare(
    `INSERT OR IGNORE INTO session_docs (session_id, transcript_key, kind, path, render_needed, created_at) VALUES (?, ?, ?, ?, 0, ?)`
  ).run(sessionId, transcriptKey, kind, path, now);
  return readSessionDoc(db, sessionId, transcriptKey, kind)?.path ?? null;
}

/**
 * Mark a session document for re-render (D5: the handoff after new digests), claiming its canonical path first so the
 * marker has a row. Call inside the caller's transaction. False when no path can be claimed.
 */
export function markSessionDocRenderNeeded(db: Database, sessionId: string, transcriptKey: string, kind: SessionDocKind, now = isoNow()): boolean {
  if (!claimSessionDocPath(db, sessionId, transcriptKey, kind, now)) return false;
  db.prepare(`UPDATE session_docs SET render_needed = 1 WHERE session_id = ? AND transcript_key = ? AND kind = ?`)
    .run(sessionId, transcriptKey, kind);
  return true;
}

export type SessionDocWrite =
  | { action: "inserted" | "updated" | "unchanged"; docId: number; path: string }
  | { action: "refused-fs" | "inactive" | "no-path"; docId: number | null; path: string | null };

/**
 * Write a session document's render (D4). Call inside the caller's transaction (Phase B). `body` is the complete
 * render; an unchanged render is not rewritten (no revision).
 */
export function upsertSessionDoc(
  db: Database,
  p: { sessionId: string; transcriptKey: string; kind: SessionDocKind; title: string; body: string; confidence?: number; now?: string },
): SessionDocWrite {
  const now = p.now ?? isoNow();
  const path = claimSessionDocPath(db, p.sessionId, p.transcriptKey, p.kind, now);
  if (!path) {
    console.warn(`[clawmem] session document for ${p.kind} of ${p.sessionId.slice(0, 8)}: no free path — nothing written, items kept`);
    return { action: "no-path", docId: null, path: null };
  }
  const row = readSessionDoc(db, p.sessionId, p.transcriptKey, p.kind)!;
  const doc = db.prepare(`SELECT id, active, origin FROM documents WHERE collection = '_clawmem' AND path = ?`).get(path) as
    { id: number; active: number; origin: string | null } | null;
  if (doc && doc.origin === "fs") {
    console.warn(`[clawmem] session document _clawmem/${path} is filesystem-owned — refused, items kept`);
    return { action: "refused-fs", docId: doc.id, path };
  }
  if (doc && doc.active !== 1) {
    // A lifecycle decision (forget/archive): not overwritten, not resurrected. Its items are kept; restoring it
    // re-renders (reconcileRestoredSessionDocs).
    return { action: "inactive", docId: doc.id, path };
  }
  // 82.3 D7: the render and its title are normalised fields; the fingerprint is the hash of what is stored.
  const { body, hash } = normalizedContent(p.body);
  const title = stripLeadingMarks(p.title);
  const fp = hash;
  if (doc && row.renderedFp === fp && row.docId === doc.id) return { action: "unchanged", docId: doc.id, path };
  insertContent(db, hash, body, now);
  let docId: number;
  let action: "inserted" | "updated";
  if (doc) {
    db.prepare(
      `UPDATE documents SET hash = ?, title = ?, modified_at = ?, revision_count = revision_count + 1, last_seen_at = ?,
         origin = 'api', doc_stamp = ? WHERE id = ? AND active = 1`
    ).run(hash, title, now, now, freshStamp(), doc.id);
    docId = doc.id;
    action = "updated";
  } else {
    db.prepare(
      `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, content_type, confidence,
         duplicate_count, revision_count, last_seen_at, origin, doc_stamp)
       VALUES ('_clawmem', ?, ?, ?, ?, ?, 1, ?, ?, 1, 1, ?, 'api', ?)`
    ).run(path, title, hash, now, now, CONTENT_TYPE[p.kind], p.confidence ?? DEFAULT_CONFIDENCE[p.kind], now, freshStamp());
    docId = (db.prepare(`SELECT id FROM documents WHERE collection = '_clawmem' AND path = ?`).get(path) as { id: number }).id;
    action = "inserted";
  }
  db.prepare(
    `UPDATE session_docs SET doc_id = ?, rendered_fp = ? WHERE session_id = ? AND transcript_key = ? AND kind = ?`
  ).run(docId, fp, p.sessionId, p.transcriptKey, p.kind);
  return { action, docId, path };
}

// ── Renders ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ObservedDecisionItem = {
  source: "observer";
  title: string;
  facts: string[];
  narrative: string;
  filesModified: string[];
};
export type RegexDecisionItem = { source: "regex"; text: string; context: string };
export type AntipatternItem = { text: string; context: string };

function renderDate(db: Database, sessionId: string, transcriptKey: string, kind: SessionDocKind, now: string): string {
  return (readSessionDoc(db, sessionId, transcriptKey, kind)?.createdAt ?? now).slice(0, 10);
}

/** The decisions document of one transcript: every decision item, in transcript order. Null without items. */
export function renderDecisions(db: Database, sessionId: string, transcriptKey: string, now = isoNow()): { title: string; body: string } | null {
  const items = itemsOf(db, sessionId, transcriptKey, "decision") as (ObservedDecisionItem | RegexDecisionItem)[];
  if (items.length === 0) return null;
  const date = renderDate(db, sessionId, transcriptKey, "decisions", now);
  const lines = [
    `---`, `content_type: decision`, `tags: [auto-extracted]`, `---`, ``,
    `# Decisions — ${date}`, ``, `Session: \`${sessionId.slice(0, 8)}\``, ``,
  ];
  for (const it of items) {
    if (it.source === "observer") {
      lines.push(`## ${it.title}`, ``);
      if (it.narrative) lines.push(it.narrative, ``);
      if (it.facts.length > 0) lines.push(`**Facts:**`, ...it.facts.map(f => `- ${f}`), ``);
      if (it.filesModified.length > 0) lines.push(`**Files:** ${it.filesModified.map(f => `\`${f}\``).join(", ")}`, ``);
    } else {
      lines.push(`- ${it.text}`);
      if (it.context) lines.push(`  > Context: ${it.context.split("\n")[0]}`);
      lines.push(``);
    }
  }
  return { title: `Decisions ${date}`, body: lines.join("\n") };
}

/** The antipatterns document of one transcript (`- **Avoid:** …` lines, the format `recover antipatterns` reads). */
export function renderAntipatterns(db: Database, sessionId: string, transcriptKey: string, now = isoNow()): { title: string; body: string } | null {
  const items = itemsOf(db, sessionId, transcriptKey, "antipattern") as AntipatternItem[];
  if (items.length === 0) return null;
  const date = renderDate(db, sessionId, transcriptKey, "antipatterns", now);
  const lines = [`# Antipatterns ${date}`, ``, `_Session: ${sessionId.slice(0, 8)}_`, ``];
  for (const a of items) {
    const ctx = a.context ? `\n  > Context: ${a.context.slice(0, 150)}` : "";
    lines.push(`- **Avoid:** ${a.text}${ctx}`);
  }
  return { title: `Antipatterns ${date}`, body: lines.join("\n") };
}

/**
 * Re-render this transcript's decisions and antipatterns documents whose render is stale — a write skipped earlier
 * (inactive at the time, a failed Phase B) or a restore. Call inside the Phase B transaction. Returns the documents
 * written.
 */
export function reconcileSessionDocs(db: Database, sessionId: string, transcriptKey: string, now = isoNow()): number {
  let written = 0;
  for (const [kind, render] of [["decisions", renderDecisions], ["antipatterns", renderAntipatterns]] as const) {
    const r = render(db, sessionId, transcriptKey, now);
    if (!r) continue;
    const w = upsertSessionDoc(db, { sessionId, transcriptKey, kind, title: r.title, body: r.body, now });
    if (w.action === "inserted" || w.action === "updated") written++;
  }
  return written;
}

/**
 * After a restore (`restoreArchivedDocuments`): each restored session document is brought up to date — decisions and
 * antipatterns re-rendered from their items, a handoff marked `render_needed` (only its own renderers write it, D5).
 */
export function reconcileRestoredSessionDocs(db: Database, docIds: readonly number[]): number {
  if (docIds.length === 0) return 0;
  const rows = db.prepare(
    `SELECT session_id, transcript_key, kind FROM session_docs WHERE doc_id IN (${docIds.map(() => "?").join(",")})`
  ).all(...docIds) as { session_id: string; transcript_key: string; kind: SessionDocKind }[];
  let touched = 0;
  for (const r of rows) {
    if (r.kind === "handoff") {
      db.prepare(`UPDATE session_docs SET render_needed = 1 WHERE session_id = ? AND transcript_key = ? AND kind = 'handoff'`)
        .run(r.session_id, r.transcript_key);
      touched++;
    } else {
      touched += reconcileSessionDocs(db, r.session_id, r.transcript_key);
    }
  }
  return touched;
}
