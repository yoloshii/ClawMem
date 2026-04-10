/**
 * Entity Resolution + Co-occurrence Graph
 *
 * Extracts entities from documents, resolves to canonical forms,
 * tracks mentions and co-occurrences for entity-aware retrieval.
 *
 * Pattern F from ENHANCEMENT-PLAN.md (source: Hindsight entity_resolver.py)
 */

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import type { LLM } from "./llm.ts";
import { extractJsonFromLLM } from "./amem.ts";

// =============================================================================
// Types
// =============================================================================

export interface ExtractedEntity {
  name: string;
  type: string; // person, project, service, tool, concept, org, location
}

export interface ResolvedEntity {
  entity_id: string;
  name: string;
  entity_type: string;
  canonical_id: string | null; // points to canonical form if this is an alias
}

export interface EntityCooccurrence {
  entity_a: string;
  entity_b: string;
  count: number;
  last_cooccurred: string;
}

// =============================================================================
// Levenshtein Distance (for fuzzy entity matching)
// =============================================================================

function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const matrix: number[][] = [];
  for (let i = 0; i <= la; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= lb; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,       // deletion
        matrix[i]![j - 1]! + 1,       // insertion
        matrix[i - 1]![j - 1]! + cost // substitution
      );
    }
  }

  return matrix[la]![lb]!;
}

/**
 * Normalized similarity ratio (0.0 = no match, 1.0 = exact match).
 * Equivalent to Python's SequenceMatcher.ratio().
 */
function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}

// =============================================================================
// Quality Filters
// =============================================================================

const ENTITY_BLOCKLIST = new Set([
  'entity name', 'entity type', 'description', 'example',
  'name', 'type', 'value', 'item',
  'exampletool', 'jane smith', // prompt examples the LLM echoes
]);

/**
 * Check if an extracted entity is low quality and should be rejected.
 * Catches: title-as-entity, long names, template placeholders, heading labels.
 */
function isLowQualityEntity(name: string, type: string, docTitle: string): boolean {
  const normalized = name.toLowerCase().trim();
  const normalizedTitle = docTitle.toLowerCase().trim();

  // Exact or near-exact title match (Levenshtein > 0.85)
  if (normalizedTitle.length > 0 && similarityRatio(normalized, normalizedTitle) > 0.85) return true;

  // Too long — likely a title or sentence fragment
  if (name.length > 60) return true;

  // Template placeholders / generic words
  if (ENTITY_BLOCKLIST.has(normalized)) return true;

  // Heading labels (trailing colon)
  if (name.endsWith(':')) return true;

  // Location low-trust: if type is location, validate it
  if (type === 'location' && !isValidLocation(name)) return true;

  return false;
}

/**
 * Validate that a location entity is actually geographic / infrastructure.
 * Rejects long non-geographic names that the LLM mistyped as location.
 */
function isValidLocation(name: string): boolean {
  // IP addresses
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(name)) return true;
  // VM identifiers (e.g., "VM 202", "VM 200")
  if (/^VM\s+\d+/i.test(name)) return true;
  // Positive-signal only — no length-based or FQDN fallback
  return false;
}

// =============================================================================
// Compatibility Buckets (for type-agnostic canonical resolution)
// =============================================================================

// Each bucket contains types that are semantically interchangeable for merging.
// Types in the same bucket can merge; cross-bucket merges are rejected.
// The 'tech' bucket captures the common LLM confusion between project/service/tool/concept.
// Unknown types default to their own isolated bucket (no false merges).
const ENTITY_BUCKETS: Record<string, string> = {
  person: 'person',
  org: 'org',
  location: 'location',
  project: 'tech',
  service: 'tech',
  tool: 'tech',
  concept: 'tech',
};

function getEntityBucket(type: string): string {
  return ENTITY_BUCKETS[type] ?? type; // unknown types form their own bucket
}

// =============================================================================
// Entity ID Generation
// =============================================================================

/**
 * Generate a stable entity ID from name, type, and vault.
 * Vault-qualified to prevent cross-vault entity merges.
 */
function makeEntityId(name: string, type: string, vault: string = 'default'): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${vault}:${type}:${normalized}`;
}

// =============================================================================
// Entity Cap (content-type-aware, §1.5 v0.8.3)
// =============================================================================

/**
 * Per-content-type entity cap applied to LLM extraction output.
 *
 * Long-form content (research dumps, conversation synthesis, hub/index docs)
 * legitimately mentions more distinct entities than short decision records or
 * handoff notes. A flat cap of 10 silently dropped real entities on long-form
 * documents. This map lets each content type keep its full entity set up to a
 * type-appropriate ceiling, while short types stay tight to suppress LLM noise.
 *
 * Unknown or untyped documents fall through to the default cap of 10 (matches
 * pre-v0.8.3 behavior — backward compatible for any caller that doesn't pass
 * a contentType).
 */
const ENTITY_CAP_BY_TYPE: Record<string, number> = {
  research: 15,       // long-form research dumps
  hub: 12,            // architecture docs, indexes
  conversation: 12,   // synthesized conversation exports
  decision: 8,        // short decision records
  deductive: 8,       // inferred observations
  note: 8,            // session notes
  handoff: 8,         // session handoffs
  progress: 8,        // progress logs
  project: 10,        // generic project content
};

/**
 * Return the entity cap for a given content type. Falls back to 10 for
 * undefined or unknown types (pre-v0.8.3 behavior).
 *
 * Input is trimmed + lowercased before lookup so values from hand-authored
 * frontmatter or older imported docs (e.g. "Research", " conversation ") map
 * cleanly to the canonical lowercase keys in `ENTITY_CAP_BY_TYPE`. The DB
 * `documents.content_type` column is not normalized at the write boundary,
 * so normalization has to happen here to avoid silent fall-through to the
 * default cap of 10.
 */
export function entityCapForContentType(contentType?: string): number {
  if (!contentType) return 10;
  const key = contentType.trim().toLowerCase();
  if (!key) return 10;
  return ENTITY_CAP_BY_TYPE[key] ?? 10;
}

// =============================================================================
// Entity Extraction (LLM-based)
// =============================================================================

/**
 * Extract named entities from document content using LLM.
 * Returns a list of (name, type) pairs.
 *
 * @param contentType Optional document content_type. When provided, caps the
 *   returned entity list using `entityCapForContentType`. When omitted, uses
 *   the default cap of 10 (backward compatible).
 */
export async function extractEntities(
  llm: LLM,
  title: string,
  content: string,
  contentType?: string
): Promise<ExtractedEntity[]> {
  const truncated = content.slice(0, 2000);

  // v0.8.3 (§1.5): compute the cap up front so we can thread it into BOTH
  // the prompt ("0-N entities") and the post-LLM slice. Without the dynamic
  // prompt, a compliant model stops at the hardcoded 10 even when we'd
  // accept 15 — the slice becomes a no-op and §1.5 is only half-effective.
  const cap = entityCapForContentType(contentType);

  const prompt = `Extract named entities from this document. Include people, projects, services, tools, organizations, and specific technical components.

Title: ${title}

Content:
${truncated}

Return ONLY valid JSON array:
[{"name": "...", "type": "person|project|service|tool|concept|org|location"}]

Rules:
- Only include specific, named entities (not generic concepts like "database" or "testing")
- Normalize names: "VM 202" not "vm202", "ClawMem" not "clawmem"
- 0-${cap} entities. Return empty array [] if no specific entities found
- Include the most specific type for each entity
- Do NOT extract the document's title as an entity
- Do NOT extract heading labels, section names, or sentence fragments
- Only extract entities that could meaningfully appear in OTHER documents
Return ONLY the JSON array. /no_think`;

  try {
    const result = await llm.generate(prompt, {
      temperature: 0.2,
      maxTokens: 400,
    });

    if (!result) return [];

    const parsed = extractJsonFromLLM(result.text) as ExtractedEntity[] | null;
    if (!Array.isArray(parsed)) return [];

    // Validate, filter, and quality-check
    return parsed
      .filter(e =>
        typeof e.name === 'string' &&
        typeof e.type === 'string' &&
        e.name.length >= 2 &&
        e.name.length <= 100 &&
        ['person', 'project', 'service', 'tool', 'concept', 'org', 'location'].includes(e.type)
      )
      .filter(e => !isLowQualityEntity(e.name, e.type, title))
      .slice(0, cap);
  } catch (err) {
    console.log(`[entity] LLM extraction failed:`, err);
    return [];
  }
}

// =============================================================================
// Entity Resolution (canonical normalization)
// =============================================================================

/**
 * Resolve an entity name to its canonical form.
 * Uses FTS5 candidate lookup + Levenshtein fuzzy matching.
 *
 * Type-agnostic within compatibility buckets:
 * - person: only merges with person
 * - org: only merges with org
 * - location: only merges with location
 * - tech (project/service/tool/concept): merges freely within bucket
 *
 * Scoped per vault to prevent cross-vault false merges.
 *
 * @returns entity_id of canonical match, or null if no match (new entity)
 */
export function resolveEntityCanonical(
  db: Database,
  name: string,
  type: string,
  vault: string = 'default',
  threshold: number = 0.75
): string | null {
  const normalizedName = name.toLowerCase().trim();
  const inputBucket = getEntityBucket(type);

  // Use lower threshold for person names (enables "Andre (Dre) Konrad" ↔ "Dre Konrad")
  const effectiveThreshold = inputBucket === 'person' ? 0.65 : threshold;

  // Step 1: FTS5 candidate lookup — type-agnostic, vault-scoped
  let candidates: { entity_id: string; name: string; entity_type: string }[] = [];
  try {
    candidates = db.prepare(`
      SELECT f.entity_id, f.name, f.entity_type
      FROM entities_fts f
      JOIN entity_nodes e ON e.entity_id = f.entity_id
      WHERE entities_fts MATCH ? AND e.vault = ?
      LIMIT 20
    `).all(normalizedName.split(/\s+/).map(w => `"${w}"`).join(' OR '), vault) as typeof candidates;
  } catch {
    // FTS5 match may fail on special chars — fall back to LIKE on entity_nodes directly
    candidates = db.prepare(`
      SELECT entity_id, name, entity_type
      FROM entity_nodes
      WHERE LOWER(name) LIKE ? AND vault = ?
      LIMIT 20
    `).all(`%${normalizedName}%`, vault) as typeof candidates;
  }

  if (candidates.length === 0) return null;

  // Step 2: Fuzzy rank candidates, filtering by bucket compatibility
  let bestMatch: { entity_id: string; score: number } | null = null;
  for (const candidate of candidates) {
    // Reject cross-bucket matches (e.g., don't merge "Andrea" person with "Andrea" project)
    if (getEntityBucket(candidate.entity_type) !== inputBucket) continue;

    const score = similarityRatio(normalizedName, candidate.name.toLowerCase());
    if (score >= effectiveThreshold && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { entity_id: candidate.entity_id, score };
    }
  }

  return bestMatch?.entity_id ?? null;
}

// =============================================================================
// Entity Storage + Mentions + Co-occurrences
// =============================================================================

/**
 * Upsert an entity into entity_nodes and entities_fts.
 * Returns the entity_id (canonical or new).
 */
export function upsertEntity(
  db: Database,
  name: string,
  type: string,
  vault: string = 'default'
): string {
  // Check for canonical match first
  const canonicalId = resolveEntityCanonical(db, name, type, vault);

  if (canonicalId) {
    // Existing canonical entity — update mention count and last_seen
    db.prepare(`
      UPDATE entity_nodes
      SET mention_count = mention_count + 1,
          last_seen = datetime('now')
      WHERE entity_id = ?
    `).run(canonicalId);
    return canonicalId;
  }

  // New entity — insert (vault-qualified ID prevents cross-vault merges)
  const entityId = makeEntityId(name, type, vault);

  db.prepare(`
    INSERT OR IGNORE INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
    VALUES (?, ?, ?, NULL, datetime('now'), 1, datetime('now'), ?)
  `).run(entityId, type, name, vault);

  // Insert into FTS index
  try {
    db.prepare(`
      INSERT OR IGNORE INTO entities_fts (entity_id, name, entity_type)
      VALUES (?, ?, ?)
    `).run(entityId, name.toLowerCase(), type);
  } catch {
    // FTS insert may fail if table doesn't exist yet — non-fatal
  }

  return entityId;
}

/**
 * Record an entity mention for a document.
 */
export function recordEntityMention(
  db: Database,
  entityId: string,
  docId: number,
  mentionText?: string
): void {
  db.prepare(`
    INSERT OR IGNORE INTO entity_mentions (entity_id, doc_id, mention_text, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(entityId, docId, mentionText || null);
}

/**
 * Track co-occurrence between entity pairs that appear in the same document.
 */
export function trackCoOccurrences(
  db: Database,
  entityIds: string[]
): void {
  if (entityIds.length < 2) return;

  const stmt = db.prepare(`
    INSERT INTO entity_cooccurrences (entity_a, entity_b, count, last_cooccurred)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(entity_a, entity_b) DO UPDATE SET
      count = count + 1,
      last_cooccurred = datetime('now')
  `);

  // All pairs, sorted for consistent key order
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      const sorted = [entityIds[i]!, entityIds[j]!].sort();
      stmt.run(sorted[0]!, sorted[1]!);
    }
  }
}

// =============================================================================
// Entity Enrichment Pipeline (called during A-MEM postIndexEnrich)
// =============================================================================

/**
 * Compute extraction input hash from title + body.
 * Captures the actual input to the LLM prompt — changes to either trigger re-extraction.
 */
function computeInputHash(title: string, body: string): string {
  return createHash('sha256').update(title + '\0' + body).digest('hex');
}

/**
 * Clear all derived entity state for a document:
 * mentions, co-occurrence contributions, entity edges, and mention counts.
 */
function clearDocEntityState(db: Database, docId: number): void {
  // Get entity IDs this doc mentions (before deletion)
  const oldMentions = db.prepare(
    `SELECT entity_id FROM entity_mentions WHERE doc_id = ?`
  ).all(docId) as { entity_id: string }[];

  // Delete mentions
  db.prepare(`DELETE FROM entity_mentions WHERE doc_id = ?`).run(docId);

  // Decrement mention_count for each entity
  for (const m of oldMentions) {
    db.prepare(`
      UPDATE entity_nodes SET mention_count = MAX(0, mention_count - 1) WHERE entity_id = ?
    `).run(m.entity_id);
  }

  // Remove entity edges involving this doc
  db.prepare(`
    DELETE FROM memory_relations WHERE (source_id = ? OR target_id = ?) AND relation_type = 'entity'
  `).run(docId, docId);

  // Decrement co-occurrence counts for entity pairs from this doc
  if (oldMentions.length >= 2) {
    const ids = oldMentions.map(m => m.entity_id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const sorted = [ids[i]!, ids[j]!].sort();
        db.prepare(`
          UPDATE entity_cooccurrences SET count = MAX(0, count - 1)
          WHERE entity_a = ? AND entity_b = ?
        `).run(sorted[0]!, sorted[1]!);
      }
    }
    // Clean up zero-count rows
    db.prepare(`DELETE FROM entity_cooccurrences WHERE count <= 0`).run();
  }
}

/**
 * Full entity enrichment for a document:
 * 1. Check enrichment state (skip if input unchanged)
 * 2. Extract entities via LLM
 * 3. Resolve each to canonical form
 * 4. Record mentions + co-occurrences + entity edges
 * 5. Persist enrichment state for idempotency
 *
 * @returns Number of entities resolved
 */
export async function enrichDocumentEntities(
  db: Database,
  llm: LLM,
  docId: number,
  vault: string = 'default'
): Promise<number> {
  try {
    // Get document content (snapshot for extraction)
    // v0.8.3 (§1.5): fetch content_type so extractEntities can apply a
    // content-type-aware cap instead of the flat slice(0, 10).
    const doc = db.prepare(`
      SELECT d.title, d.content_type, c.doc as body
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.id = ? AND d.active = 1
    `).get(docId) as { title: string; content_type: string | null; body: string } | null;

    if (!doc) {
      console.log(`[entity] Document ${docId} not found or inactive`);
      return 0;
    }

    // Compute extraction input hash (title + body — the actual LLM prompt input)
    const inputHash = computeInputHash(doc.title, doc.body);

    // Check enrichment state — skip if already enriched with same input
    const existingState = db.prepare(
      `SELECT input_hash FROM entity_enrichment_state WHERE doc_id = ?`
    ).get(docId) as { input_hash: string } | undefined;

    if (existingState?.input_hash === inputHash) {
      return 0; // Same input, already enriched — skip
    }

    // Step 1: Extract entities via LLM (cap is content-type-aware as of v0.8.3 §1.5)
    const entities = await extractEntities(llm, doc.title, doc.body, doc.content_type ?? undefined);

    // Recheck input hash before writing — abort if content changed during LLM call
    const recheckHash = db.prepare(`
      SELECT d.title, c.doc as body FROM documents d
      JOIN content c ON c.hash = d.hash WHERE d.id = ? AND d.active = 1
    `).get(docId) as { title: string; body: string } | null;

    if (!recheckHash || computeInputHash(recheckHash.title, recheckHash.body) !== inputHash) {
      console.log(`[entity] Document ${docId} changed during extraction — aborting`);
      return 0;
    }

    // Step 3: Deduplicate entities by surface form, then resolve canonical IDs
    // Done BEFORE transaction to avoid calling upsertEntity (which mutates counters) for dupes
    const seenKeys = new Set<string>();
    const uniqueEntities: ExtractedEntity[] = [];
    for (const entity of entities) {
      const key = `${entity.type}:${entity.name.toLowerCase().trim()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueEntities.push(entity);
      }
    }

    // Resolve canonical IDs first (read-only lookups, no counter mutation yet)
    const resolvedPairs: { entity: ExtractedEntity; canonicalId: string }[] = [];
    const seenCanonicalIds = new Set<string>();
    for (const entity of uniqueEntities) {
      const canonicalId = resolveEntityCanonical(db, entity.name, entity.type, vault)
        || makeEntityId(entity.name, entity.type, vault);
      if (!seenCanonicalIds.has(canonicalId)) {
        seenCanonicalIds.add(canonicalId);
        resolvedPairs.push({ entity, canonicalId });
      }
    }

    // All writes in a transaction — partial failure rolls back cleanly
    try {
      db.exec("BEGIN");

      // Re-check enrichment state inside transaction (prevents concurrent overcount)
      const txState = db.prepare(
        `SELECT input_hash FROM entity_enrichment_state WHERE doc_id = ?`
      ).get(docId) as { input_hash: string } | undefined;

      if (txState?.input_hash === inputHash) {
        db.exec("ROLLBACK");
        return 0; // Another worker already committed this exact enrichment
      }

      // Clear old derived state if re-enriching (content changed or state was externally wiped)
      const hasOldMentions = db.prepare(
        `SELECT 1 FROM entity_mentions WHERE doc_id = ? LIMIT 1`
      ).get(docId);
      if (txState || existingState || hasOldMentions) {
        clearDocEntityState(db, docId);
      }

      if (entities.length === 0) {
        db.prepare(`
          INSERT OR REPLACE INTO entity_enrichment_state (doc_id, input_hash, enriched_at)
          VALUES (?, ?, datetime('now'))
        `).run(docId, inputHash);
        db.exec("COMMIT");
        console.log(`[entity] No entities found in docId ${docId}`);
        return 0;
      }

      // Mutate counters using precomputed canonical IDs (no redundant re-resolution)
      const resolvedIds: string[] = [];
      for (const { entity, canonicalId } of resolvedPairs) {
        // Check if canonical entity already exists
        const existing = db.prepare(
          `SELECT entity_id FROM entity_nodes WHERE entity_id = ?`
        ).get(canonicalId) as { entity_id: string } | undefined;

        if (existing) {
          // Existing canonical — increment count
          db.prepare(`
            UPDATE entity_nodes SET mention_count = mention_count + 1, last_seen = datetime('now')
            WHERE entity_id = ?
          `).run(canonicalId);
        } else {
          // New entity — insert
          db.prepare(`
            INSERT OR IGNORE INTO entity_nodes (entity_id, entity_type, name, description, created_at, mention_count, last_seen, vault)
            VALUES (?, ?, ?, NULL, datetime('now'), 1, datetime('now'), ?)
          `).run(canonicalId, entity.type, entity.name, vault);
          try {
            db.prepare(`
              INSERT OR IGNORE INTO entities_fts (entity_id, name, entity_type)
              VALUES (?, ?, ?)
            `).run(canonicalId, entity.name.toLowerCase(), entity.type);
          } catch { /* FTS insert non-fatal */ }
        }

        resolvedIds.push(canonicalId);
        recordEntityMention(db, canonicalId, docId, entity.name);
      }

      // Step 4: Track co-occurrences (deduplicate resolvedIds to prevent self-pairs)
      const uniqueResolvedIds = [...new Set(resolvedIds)];
      trackCoOccurrences(db, uniqueResolvedIds);

      // Step 5: Create entity edges with IDF-based specificity scoring
      // Rare entities justify edges; ubiquitous entities alone cannot
      const totalDocs = (db.prepare(`SELECT COUNT(*) as cnt FROM documents WHERE active = 1`).get() as { cnt: number }).cnt;

      // Collect candidate target docs and their shared entities
      const targetEntityMap = new Map<number, string[]>(); // docId → [entityIds]
      for (const entityId of resolvedIds) {
        const otherDocs = db.prepare(`
          SELECT doc_id FROM entity_mentions
          WHERE entity_id = ? AND doc_id != ?
          LIMIT 20
        `).all(entityId, docId) as { doc_id: number }[];

        for (const other of otherDocs) {
          const existing = targetEntityMap.get(other.doc_id) || [];
          existing.push(entityId);
          targetEntityMap.set(other.doc_id, existing);
        }
      }

      // Compute IDF per entity (cache for this enrichment)
      const entityIdf = new Map<string, number>();
      for (const entityId of resolvedIds) {
        if (!entityIdf.has(entityId)) {
          const docFreq = (db.prepare(
            `SELECT COUNT(DISTINCT doc_id) as cnt FROM entity_mentions WHERE entity_id = ?`
          ).get(entityId) as { cnt: number }).cnt;
          entityIdf.set(entityId, Math.log((totalDocs + 1) / (docFreq + 1)));
        }
      }

      // Create edges only when max entity IDF exceeds threshold
      const idfThreshold = 3.0; // ln-based: filters entities in >5% of docs (e.g., 13+ docs in 262-doc corpus)
      for (const [targetDocId, sharedEntities] of targetEntityMap) {
        const maxIdf = Math.max(...sharedEntities.map(eid => entityIdf.get(eid) || 0));
        if (maxIdf < idfThreshold) continue; // Skip — only ubiquitous entities shared

        // Weight: IDF specificity + shared-count bonus (multi-entity overlap outranks single)
        const sharedBonus = Math.min(0.15, 0.05 * (sharedEntities.length - 1));
        const weight = Math.min(1.0, 0.3 + 0.12 * maxIdf + sharedBonus);
        const bestEntity = sharedEntities.reduce((best, eid) =>
          (entityIdf.get(eid) || 0) > (entityIdf.get(best) || 0) ? eid : best
        );

        db.prepare(`
          INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
          VALUES (?, ?, 'entity', ?, ?, datetime('now'))
        `).run(docId, targetDocId, weight, JSON.stringify({ entity: bestEntity, shared: sharedEntities.length }));
      }

      // Persist enrichment state LAST — only after all derived data written
      db.prepare(`
        INSERT OR REPLACE INTO entity_enrichment_state (doc_id, input_hash, enriched_at)
        VALUES (?, ?, datetime('now'))
      `).run(docId, inputHash);

      db.exec("COMMIT");
      console.log(`[entity] Enriched docId ${docId}: ${resolvedIds.length} entities, ${entities.length} extracted`);
      return resolvedIds.length;
    } catch (txErr) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw txErr; // re-throw to outer catch
    }
  } catch (err) {
    console.log(`[entity] Error enriching docId ${docId}:`, err);
    return 0;
  }
}

// =============================================================================
// Entity Graph Traversal (for intent_search ENTITY queries)
// =============================================================================

/**
 * Get entity co-occurrence neighbors for a set of seed entities.
 * Returns document IDs reachable via entity co-occurrence graph.
 */
export function getEntityGraphNeighbors(
  db: Database,
  seedDocIds: number[],
  limit: number = 20
): { docId: number; score: number; viaEntity: string }[] {
  if (seedDocIds.length === 0) return [];

  // Step 1: Find entities mentioned in seed documents
  const placeholders = seedDocIds.map(() => '?').join(',');
  const seedEntities = db.prepare(`
    SELECT DISTINCT entity_id FROM entity_mentions
    WHERE doc_id IN (${placeholders})
  `).all(...seedDocIds) as { entity_id: string }[];

  if (seedEntities.length === 0) return [];

  // Step 2: Find co-occurring entities
  const entityIds = seedEntities.map(e => e.entity_id);
  const entityPlaceholders = entityIds.map(() => '?').join(',');

  const cooccurring = db.prepare(`
    SELECT
      CASE WHEN entity_a IN (${entityPlaceholders}) THEN entity_b ELSE entity_a END as neighbor_entity,
      count
    FROM entity_cooccurrences
    WHERE entity_a IN (${entityPlaceholders}) OR entity_b IN (${entityPlaceholders})
    ORDER BY count DESC
    LIMIT 30
  `).all(...entityIds, ...entityIds, ...entityIds) as { neighbor_entity: string; count: number }[];

  if (cooccurring.length === 0) return [];

  // Step 3: Find documents mentioning co-occurring entities
  const results: { docId: number; score: number; viaEntity: string }[] = [];
  const seen = new Set(seedDocIds);

  for (const co of cooccurring) {
    const docs = db.prepare(`
      SELECT doc_id FROM entity_mentions
      WHERE entity_id = ?
      LIMIT 10
    `).all(co.neighbor_entity) as { doc_id: number }[];

    for (const doc of docs) {
      if (!seen.has(doc.doc_id)) {
        seen.add(doc.doc_id);
        // Score: normalized co-occurrence count (log scale)
        const score = Math.min(1.0, Math.log1p(co.count) / 5);
        results.push({ docId: doc.doc_id, score, viaEntity: co.neighbor_entity });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Search for entities by name (for MCP tool exposure).
 */
export function searchEntities(
  db: Database,
  query: string,
  limit: number = 10
): { entity_id: string; name: string; type: string; mention_count: number; cooccurrence_count: number }[] {
  const normalizedQuery = query.toLowerCase().trim();

  // Try FTS first
  let results: { entity_id: string; name: string; entity_type: string; mention_count: number }[] = [];
  try {
    results = db.prepare(`
      SELECT e.entity_id, e.name, e.entity_type, e.mention_count
      FROM entities_fts f
      JOIN entity_nodes e ON e.entity_id = f.entity_id
      WHERE entities_fts MATCH ?
      ORDER BY e.mention_count DESC
      LIMIT ?
    `).all(normalizedQuery.split(/\s+/).map(w => `"${w}"`).join(' OR '), limit) as typeof results;
  } catch {
    // Fallback to LIKE
    results = db.prepare(`
      SELECT entity_id, name, entity_type, mention_count
      FROM entity_nodes
      WHERE LOWER(name) LIKE ?
      ORDER BY mention_count DESC
      LIMIT ?
    `).all(`%${normalizedQuery}%`, limit) as typeof results;
  }

  // Enrich with co-occurrence count
  return results.map(r => {
    const coCount = db.prepare(`
      SELECT COALESCE(SUM(count), 0) as total
      FROM entity_cooccurrences
      WHERE entity_a = ? OR entity_b = ?
    `).get(r.entity_id, r.entity_id) as { total: number };

    return {
      entity_id: r.entity_id,
      name: r.name,
      type: r.entity_type,
      mention_count: r.mention_count || 0,
      cooccurrence_count: coCount.total,
    };
  });
}
