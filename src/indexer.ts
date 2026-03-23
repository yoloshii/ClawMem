/**
 * ClawMem Indexer - Vault walking, frontmatter parsing, SAME metadata extraction
 *
 * Combines QMD's document indexing with SAME's frontmatter metadata system.
 */

import { Glob } from "bun";
import { readFileSync, statSync } from "fs";
import { basename, relative } from "path";
import matter from "gray-matter";
import { createHash } from "crypto";
import type { Store } from "./store.ts";
import { inferContentType, confidenceScore, type ContentType } from "./memory.ts";
import { getDefaultLlamaCpp } from "./llm.ts";

// =============================================================================
// Types
// =============================================================================

export interface DocumentMeta {
  title?: string;
  tags?: string[];
  domain?: string;
  workstream?: string;
  content_type?: ContentType;
  review_by?: string;
}

export interface IndexStats {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

// =============================================================================
// Exclusion Rules
// =============================================================================

const EXCLUDED_DIRS = new Set([
  "_PRIVATE",
  ".clawmem",
  ".git",
  ".obsidian",
  ".logseq",
  ".foam",
  ".dendron",
  ".trash",
  ".stversions",
  "node_modules",
  ".cache",
  "vendor",
  "dist",
  "build",
  "gits",
  "scraped",
]);

export function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some(s => EXCLUDED_DIRS.has(s) || (s.startsWith(".") && s !== "."));
}

// =============================================================================
// Content Hashing
// =============================================================================

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// =============================================================================
// Title Extraction
// =============================================================================

export function extractTitle(content: string, filename: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(/^#+\s+(.+)/);
    if (match?.[1]) return match[1].trim();
  }
  return basename(filename).replace(/\.(md|txt)$/i, "");
}

// =============================================================================
// Frontmatter Parsing
// =============================================================================

export function parseDocument(content: string, relativePath: string): { body: string; meta: DocumentMeta } {
  try {
    const { data, content: body } = matter(content);
    return {
      body,
      meta: {
        title: data.title as string | undefined,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
        domain: data.domain as string | undefined,
        workstream: data.workstream as string | undefined,
        content_type: (data.content_type as ContentType) || inferContentType(relativePath),
        review_by: data.review_by as string | undefined,
      },
    };
  } catch {
    // If frontmatter parsing fails, treat entire content as body
    return {
      body: content,
      meta: {
        content_type: inferContentType(relativePath),
      },
    };
  }
}

// =============================================================================
// Quality Scoring
// =============================================================================

export function computeQualityScore(body: string, meta: DocumentMeta): number {
  let score = 0.3; // Base

  // Length signals
  if (body.length > 200) score += 0.1;
  if (body.length > 500) score += 0.1;

  // Structure signals
  if (/^##\s+/m.test(body)) score += 0.1;
  if (/^[-*]\s+/m.test(body)) score += 0.05;

  // Decision/commitment keywords
  if (/\b(decided?\s+to|chose|will\s+use|switching\s+to|going\s+with|selected|adopted)\b/i.test(body)) {
    score += 0.15;
  }

  // Correction keywords
  if (/\b(fix(ed)?|bug|resolved|corrected|patched|root\s+cause)\b/i.test(body)) {
    score += 0.1;
  }

  // Frontmatter richness: +0.05 per populated field, max +0.15
  let metaBonus = 0;
  if (meta.tags && meta.tags.length > 0) metaBonus += 0.05;
  if (meta.domain) metaBonus += 0.05;
  if (meta.workstream) metaBonus += 0.05;
  score += Math.min(0.15, metaBonus);

  // Penalty for trivial stubs
  if (body.length < 50) score -= 0.1;

  return Math.max(0, Math.min(1.0, score));
}

// =============================================================================
// Collection Indexing
// =============================================================================

// Expand top-level brace patterns into individual glob strings.
// e.g. "{MEMORY.md,memory/x.md}" => ["MEMORY.md", "memory/x.md"]
// Patterns without braces pass through unchanged.
function expandBraces(pattern: string): string[] {
  const match = pattern.match(/^\{(.+)\}$/);
  if (!match) return [pattern];
  return match[1]!.split(",").map(s => s.trim());
}

export async function indexCollection(
  store: Store,
  collectionName: string,
  collectionPath: string,
  pattern: string = "**/*.md",
  options?: { forceEnrich?: boolean }
): Promise<IndexStats> {
  const stats: IndexStats = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const activePaths = new Set<string>();

  // Get LLM instance for A-MEM enrichment
  const llm = getDefaultLlamaCpp();

  // Bun.Glob doesn't support brace expansion {a,b,c} — expand manually
  const patterns = expandBraces(pattern);
  const seen = new Set<string>();
  const allEntries: string[] = [];
  for (const p of patterns) {
    const glob = new Glob(p);
    for (const f of glob.scanSync({ cwd: collectionPath, followSymlinks: false, absolute: false })) {
      if (!seen.has(f)) {
        seen.add(f);
        allEntries.push(f);
      }
    }
  }

  // Collect doc IDs that need post-index enrichment (deferred until after commit)
  const enrichQueue: { docId: number; isNew: boolean }[] = [];

  // Wrap all DB writes in a transaction for atomicity
  store.db.exec("BEGIN");
  try {
    for (const relativePath of allEntries) {
      if (shouldExclude(relativePath)) continue;

      activePaths.add(relativePath);
      const absolutePath = `${collectionPath}/${relativePath}`;

      let content: string;
      let mtime: Date;
      try {
        content = readFileSync(absolutePath, "utf-8");
        mtime = statSync(absolutePath).mtime;
      } catch {
        continue; // File may have been deleted between scan and read
      }

      const contentHash = hashContent(content);
      const now = new Date().toISOString();

      // Check if document already exists
      const existing = store.findActiveDocument(collectionName, relativePath);

      if (existing) {
        // Check if content changed via content hash
        const existingRow = store.db.prepare(
          "SELECT content_hash FROM documents WHERE id = ?"
        ).get(existing.id) as { content_hash: string | null } | null;

        if (existingRow?.content_hash === contentHash) {
          stats.unchanged++;
          continue;
        }

        // Content changed — update
        const { body, meta } = parseDocument(content, relativePath);
        const title = meta.title || extractTitle(body, relativePath);
        const docHash = hashContent(body);

        store.insertContent(docHash, body, now);
        store.updateDocument(existing.id, title, docHash, mtime.toISOString());

        // Update SAME metadata
        const contentType = meta.content_type || inferContentType(relativePath);
        store.updateDocumentMeta(existing.id, {
          domain: meta.domain,
          workstream: meta.workstream,
          tags: meta.tags ? JSON.stringify(meta.tags) : undefined,
          content_type: contentType,
          review_by: meta.review_by,
          confidence: confidenceScore(contentType, mtime, 0),
          quality_score: computeQualityScore(body, meta),
        });

        // Update content_hash for next incremental check
        store.db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?").run(contentHash, existing.id);

        // Defer A-MEM enrichment until after commit
        enrichQueue.push({ docId: existing.id, isNew: false });

        stats.updated++;
      } else {
        // Check for inactive (previously removed) doc at same path — reactivate instead of inserting
        const inactive = store.db.prepare(
          "SELECT id, hash FROM documents WHERE collection = ? AND path = ? AND active = 0"
        ).get(collectionName, relativePath) as { id: number; hash: string } | null;

        const { body, meta } = parseDocument(content, relativePath);
        const title = meta.title || extractTitle(body, relativePath);
        const docHash = hashContent(body);
        const contentType = meta.content_type || inferContentType(relativePath);

        store.insertContent(docHash, body, now);

        if (inactive) {
          // Reactivate existing row
          store.db.prepare("UPDATE documents SET active = 1, hash = ?, title = ?, modified_at = ?, content_hash = ? WHERE id = ?")
            .run(docHash, title, mtime.toISOString(), contentHash, inactive.id);
          store.updateDocumentMeta(inactive.id, {
            domain: meta.domain,
            workstream: meta.workstream,
            tags: meta.tags ? JSON.stringify(meta.tags) : undefined,
            content_type: contentType,
            review_by: meta.review_by,
            confidence: confidenceScore(contentType, mtime, 0),
            quality_score: computeQualityScore(body, meta),
          });
          enrichQueue.push({ docId: inactive.id, isNew: false });
        } else {
          // Truly new document
          store.insertDocument(collectionName, relativePath, title, docHash, now, mtime.toISOString());
          const newDoc = store.findActiveDocument(collectionName, relativePath);
          if (newDoc) {
            store.updateDocumentMeta(newDoc.id, {
              domain: meta.domain,
              workstream: meta.workstream,
              tags: meta.tags ? JSON.stringify(meta.tags) : undefined,
              content_type: contentType,
              review_by: meta.review_by,
              confidence: confidenceScore(contentType, mtime, 0),
              quality_score: computeQualityScore(body, meta),
            });
            store.db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?").run(contentHash, newDoc.id);
            enrichQueue.push({ docId: newDoc.id, isNew: true });
          }
        }

        stats.added++;
      }
    }

    // Deactivate documents that no longer exist on disk
    const storedPaths = store.getActiveDocumentPaths(collectionName);
    for (const storedPath of storedPaths) {
      if (!activePaths.has(storedPath)) {
        store.deactivateDocument(collectionName, storedPath);
        stats.removed++;
      }
    }

    store.db.exec("COMMIT");
  } catch (err) {
    store.db.exec("ROLLBACK");
    throw err;
  }

  // A-MEM enrichment runs after successful commit (LLM calls should not block transaction)
  // forceEnrich overrides isNew to true — triggers full pipeline (entity extraction, links, evolution)
  for (const { docId, isNew } of enrichQueue) {
    await store.postIndexEnrich(llm, docId, options?.forceEnrich ? true : isNew);
  }

  return stats;
}
