/**
 * Entity Resolution + Co-occurrence Graph
 *
 * Extracts entities from documents, resolves to canonical forms,
 * tracks mentions and co-occurrences for entity-aware retrieval.
 *
 * Pattern F from ENHANCEMENT-PLAN.md (source: Hindsight entity_resolver.py)
 */

import type { Database } from "bun:sqlite";
import type { LlamaCpp } from "./llm.ts";
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
// Entity Extraction (LLM-based)
// =============================================================================

/**
 * Extract named entities from document content using LLM.
 * Returns a list of (name, type) pairs.
 */
export async function extractEntities(
  llm: LlamaCpp,
  title: string,
  content: string
): Promise<ExtractedEntity[]> {
  const truncated = content.slice(0, 2000);

  const prompt = `Extract named entities from this document. Include people, projects, services, tools, organizations, and specific technical components.

Title: ${title}

Content:
${truncated}

Return ONLY valid JSON array:
[
  {"name": "Entity Name", "type": "person|project|service|tool|concept|org|location"}
]

Rules:
- Only include specific, named entities (not generic concepts like "database" or "testing")
- Normalize names: "VM 202" not "vm202", "ClawMem" not "clawmem"
- 3-15 entities maximum
- Include the most specific type for each entity
Return ONLY the JSON array. /no_think`;

  try {
    const result = await llm.generate(prompt, {
      temperature: 0.2,
      maxTokens: 400,
    });

    if (!result) return [];

    const parsed = extractJsonFromLLM(result.text) as ExtractedEntity[] | null;
    if (!Array.isArray(parsed)) return [];

    // Validate and filter
    return parsed
      .filter(e =>
        typeof e.name === 'string' &&
        typeof e.type === 'string' &&
        e.name.length >= 2 &&
        e.name.length <= 100 &&
        ['person', 'project', 'service', 'tool', 'concept', 'org', 'location'].includes(e.type)
      )
      .slice(0, 15);
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
 * Scoped per vault (via vault parameter) to prevent cross-vault false merges.
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

  // Step 1: FTS5 candidate lookup — join to entity_nodes for vault scoping
  let candidates: { entity_id: string; name: string; entity_type: string }[] = [];
  try {
    candidates = db.prepare(`
      SELECT f.entity_id, f.name, f.entity_type
      FROM entities_fts f
      JOIN entity_nodes e ON e.entity_id = f.entity_id
      WHERE entities_fts MATCH ? AND f.entity_type = ? AND e.vault = ?
      LIMIT 20
    `).all(normalizedName.split(/\s+/).map(w => `"${w}"`).join(' OR '), type, vault) as typeof candidates;
  } catch {
    // FTS5 match may fail on special chars — fall back to LIKE on entity_nodes directly
    candidates = db.prepare(`
      SELECT entity_id, name, entity_type
      FROM entity_nodes
      WHERE LOWER(name) LIKE ? AND entity_type = ? AND vault = ?
      LIMIT 20
    `).all(`%${normalizedName}%`, type, vault) as typeof candidates;
  }

  if (candidates.length === 0) return null;

  // Step 2: Fuzzy rank candidates by Levenshtein similarity
  let bestMatch: { entity_id: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = similarityRatio(normalizedName, candidate.name.toLowerCase());
    if (score >= threshold && (!bestMatch || score > bestMatch.score)) {
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
 * Full entity enrichment for a document:
 * 1. Extract entities via LLM
 * 2. Resolve each to canonical form
 * 3. Record mentions
 * 4. Track co-occurrences
 *
 * @returns Number of entities resolved
 */
export async function enrichDocumentEntities(
  db: Database,
  llm: LlamaCpp,
  docId: number,
  vault: string = 'default'
): Promise<number> {
  try {
    // Get document content
    const doc = db.prepare(`
      SELECT d.title, c.doc as body
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.id = ? AND d.active = 1
    `).get(docId) as { title: string; body: string } | null;

    if (!doc) {
      console.log(`[entity] Document ${docId} not found or inactive`);
      return 0;
    }

    // Skip if already enriched with current content (idempotent across multiple --enrich runs)
    // Check document hash against existing mentions — if content changed, re-extract
    const docHash = db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(docId) as { hash: string } | undefined;
    if (docHash) {
      const existingMention = db.prepare(
        `SELECT em.created_at, d.hash as doc_hash
         FROM entity_mentions em
         JOIN documents d ON d.id = em.doc_id
         WHERE em.doc_id = ? LIMIT 1`
      ).get(docId) as { created_at: string; doc_hash: string } | undefined;

      if (existingMention && existingMention.doc_hash === docHash.hash) {
        return 0; // Same content, already enriched — skip
      }

      // Content changed since last enrichment — clear old mentions before re-extracting
      if (existingMention) {
        db.prepare(`DELETE FROM entity_mentions WHERE doc_id = ?`).run(docId);
      }
    }

    // Step 1: Extract entities
    const entities = await extractEntities(llm, doc.title, doc.body);
    if (entities.length === 0) {
      console.log(`[entity] No entities found in docId ${docId}`);
      return 0;
    }

    // Step 2-3: Deduplicate entities by name+type, then resolve and record mentions
    const seenKeys = new Set<string>();
    const uniqueEntities: ExtractedEntity[] = [];
    for (const entity of entities) {
      const key = `${entity.type}:${entity.name.toLowerCase().trim()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueEntities.push(entity);
      }
    }

    const resolvedIds: string[] = [];
    for (const entity of uniqueEntities) {
      const entityId = upsertEntity(db, entity.name, entity.type, vault);
      resolvedIds.push(entityId);
      recordEntityMention(db, entityId, docId, entity.name);
    }

    // Step 4: Track co-occurrences (deduplicated IDs prevent inflated pair counts)
    trackCoOccurrences(db, resolvedIds);

    // Step 5: Create entity edges in memory_relations
    for (const entityId of resolvedIds) {
      // Find other documents mentioning this entity
      const otherDocs = db.prepare(`
        SELECT doc_id FROM entity_mentions
        WHERE entity_id = ? AND doc_id != ?
        LIMIT 10
      `).all(entityId, docId) as { doc_id: number }[];

      for (const other of otherDocs) {
        // Insert entity relation (unidirectional; graph traversal handles inbound for entity/semantic types)
        db.prepare(`
          INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
          VALUES (?, ?, 'entity', 0.7, ?, datetime('now'))
        `).run(docId, other.doc_id, JSON.stringify({ entity: entityId }));
      }
    }

    console.log(`[entity] Enriched docId ${docId}: ${resolvedIds.length} entities, ${entities.length} extracted`);
    return resolvedIds.length;
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
