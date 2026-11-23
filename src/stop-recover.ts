/**
 * 62.1 D9: antipattern recovery. Through v0.40.x the antipatterns merge policy overwrote the most recent antipattern
 * document of the last 7 days at every Stop, whichever session wrote it, leaving every earlier body as an orphaned
 * content row (and nothing deletes orphaned content). Those bodies are preserved in
 * `recovered_antipattern_bodies` by a resumable step (chunked by content rowid; it moved out of the at-open migration,
 * where it cost 10 s on a large cold vault), run by the watcher at start, by `repair counters` and by
 * `recover antipatterns` itself. `clawmem recover antipatterns` lists the de-duplicated `- **Avoid:** …` assertions
 * with occurrence counts and first/last-seen dates; `--apply [--min-occurrences N]` writes the accepted set as
 * `_clawmem/antipatterns/recovered-<YYYY-MM>.md` (stamped, `api`). Nothing is applied automatically.
 */

import type { Database } from "bun:sqlite";
import { isoNow } from "./clock.ts";
import { freshStamp, lastChanges, stopPipelineReady } from "./stop-schema.ts";
import { insertContent } from "./content-insert.ts";
import { normalizedContent } from "./text-policy.ts";
import { runExact } from "./stored-copy.ts";

const PRESERVE_FLAG = "stop-pipeline:antipattern-bodies-v1";
const PRESERVE_PROGRESS = `${PRESERVE_FLAG}:after`;
/** Content rowids per chunk: each chunk's scan blocks the watcher's event loop for its I/O (~0.4 s cold on a 2.8 GB vault). */
const CHUNK = 1_000;
const AVOID_RE = /^- \*\*Avoid:\*\* (.+)$/;

function flag(db: Database, name: string): string | null {
  return (db.prepare(`SELECT value FROM vault_flags WHERE flag = ?`).get(name) as { value: string } | null)?.value ?? null;
}
function setFlag(db: Database, name: string, value: string): void {
  db.prepare(`INSERT INTO vault_flags (flag, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(name, value, isoNow());
}

export function antipatternBodiesPreserved(db: Database): boolean {
  return flag(db, PRESERVE_FLAG) !== null;
}

/**
 * Copy every orphaned `# Antipatterns …` body (a content row no document points at) into
 * `recovered_antipattern_bodies`, in chunks, resuming from its progress marker. Returns the bodies copied this run.
 */
export async function preserveAntipatternBodies(db: Database, opts?: { maxChunks?: number; pause?: () => Promise<void> }): Promise<number> {
  if (!stopPipelineReady(db) || antipatternBodiesPreserved(db)) return 0;
  const max = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM content`).get() as { m: number }).m;
  let after = Number(flag(db, PRESERVE_PROGRESS) ?? 0);
  let copied = 0;
  let chunks = 0;
  // Only the matching bodies leave SQLite; each chunk covers a rowid range of the content table.
  const read = db.prepare(
    `SELECT hash, doc, created_at FROM content WHERE rowid > ? AND rowid <= ? AND substr(doc, 1, 14) = '# Antipatterns'
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.hash = content.hash)`
  );
  // 82.3 D7 (ruling 56 A): the body and its time are copies of stored text — bound as their bytes (`?T`)
  const ins = `INSERT OR IGNORE INTO recovered_antipattern_bodies (hash, body, created_at) VALUES (?, ?T, ?T)`;
  while (after < max) {
    if (opts?.maxChunks !== undefined && chunks >= opts.maxChunks) return copied;
    const to = Math.min(after + CHUNK, max);
    db.transaction(() => {
      for (const r of read.all(after, to) as { hash: string; doc: string; created_at: string }[]) {
        runExact(db, ins, [r.hash, r.doc, r.created_at]);
        copied += lastChanges(db);
      }
      setFlag(db, PRESERVE_PROGRESS, String(to));
    }).immediate();
    after = to;
    chunks++;
    await opts?.pause?.();
  }
  db.transaction(() => {
    setFlag(db, PRESERVE_FLAG, isoNow());
    db.prepare(`DELETE FROM vault_flags WHERE flag = ?`).run(PRESERVE_PROGRESS);
  }).immediate();
  return copied;
}

export type RecoveredAssertion = { text: string; occurrences: number; firstSeen: string; lastSeen: string };

function normalize(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The de-duplicated `- **Avoid:** …` assertions of the preserved bodies, most frequent first. */
export function listRecoveredAntipatterns(db: Database): RecoveredAssertion[] {
  const byKey = new Map<string, RecoveredAssertion>();
  const rows = db.prepare(`SELECT body, created_at FROM recovered_antipattern_bodies ORDER BY created_at`).all() as { body: string; created_at: string }[];
  for (const r of rows) {
    const seen = new Set<string>();
    for (const line of r.body.split("\n")) {
      const m = AVOID_RE.exec(line.trim());
      if (!m) continue;
      const text = normalize(m[1]!);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const a = byKey.get(key);
      if (!a) byKey.set(key, { text, occurrences: 1, firstSeen: r.created_at, lastSeen: r.created_at });
      else {
        a.occurrences++;
        if (r.created_at < a.firstSeen) a.firstSeen = r.created_at;
        if (r.created_at > a.lastSeen) a.lastSeen = r.created_at;
      }
    }
  }
  return [...byKey.values()].sort((x, y) => y.occurrences - x.occurrences || x.firstSeen.localeCompare(y.firstSeen));
}

export type RecoveryWrite = { path: string; action: "inserted" | "updated" | "unchanged" | "refused"; assertions: number };

/** Write the accepted assertions as this month's recovered-antipatterns document (stamped, api-owned). */
export function applyRecoveredAntipatterns(db: Database, opts?: { minOccurrences?: number; now?: string }): RecoveryWrite {
  const now = opts?.now ?? isoNow();
  const accepted = listRecoveredAntipatterns(db).filter(a => a.occurrences >= (opts?.minOccurrences ?? 1));
  const month = now.slice(0, 7);
  const path = `antipatterns/recovered-${month}.md`;
  const lines = [
    `# Antipatterns — recovered ${month}`, ``,
    `_Recovered from earlier antipattern documents that later ones overwrote (ClawMem ≤ v0.40)._`, ``,
    ...accepted.map(a => `- **Avoid:** ${a.text}\n  > Seen ${a.occurrences}× (${a.firstSeen.slice(0, 10)} … ${a.lastSeen.slice(0, 10)})`),
  ];
  const { body, hash } = normalizedContent(lines.join("\n"));
  let action: RecoveryWrite["action"] = "unchanged";
  db.transaction(() => {
    const doc = db.prepare(`SELECT id, hash, active, origin FROM documents WHERE collection = '_clawmem' AND path = ?`).get(path) as
      { id: number; hash: string; active: number; origin: string | null } | null;
    if (doc && (doc.origin === "fs" || doc.active !== 1)) { action = "refused"; return; }
    if (doc && doc.hash === hash) return;
    insertContent(db, hash, body, now);
    if (doc) {
      db.prepare(`UPDATE documents SET hash = ?, modified_at = ?, revision_count = revision_count + 1, last_seen_at = ?, doc_stamp = ? WHERE id = ?`)
        .run(hash, now, now, freshStamp(), doc.id);
      action = "updated";
    } else {
      db.prepare(
        `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active, content_type, confidence,
           duplicate_count, revision_count, last_seen_at, origin, doc_stamp)
         VALUES ('_clawmem', ?, ?, ?, ?, ?, 1, 'antipattern', 0.75, 1, 1, ?, 'api', ?)`
      ).run(path, `Antipatterns recovered ${month}`, hash, now, now, now, freshStamp());
      action = "inserted";
    }
  }).immediate();
  return { path, action, assertions: accepted.length };
}
