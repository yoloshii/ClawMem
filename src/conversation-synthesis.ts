/**
 * conversation-synthesis.ts — Post-import conversation synthesis pipeline (v0.7.2, Ext 4)
 *
 * Runs AFTER `clawmem mine` completes indexing. Operates on imported conversation
 * docs to extract structured knowledge facts (decisions / preferences / milestones /
 * problems) and cross-document relations via a two-pass LLM pipeline.
 *
 * Pass 1 — Extract facts:
 *   - For each conversation doc in the target collection, ask the LLM for structured
 *     facts with {title, contentType, narrative, facts, aliases, links}
 *   - Save each fact via the dedup-aware saveMemory API
 *   - Populate a localMap keyed by normalized title + aliases → docId
 *
 * Pass 2 — Resolve links:
 *   - For each extracted fact, resolve its links[] targetTitle via localMap first,
 *     fall back to SQL lookup scoped to the same collection
 *   - Insert memory_relations via existing upsert (INSERT OR IGNORE for idempotency)
 *
 * Failure modes are all non-fatal:
 *   - null LLM call → increment nullCalls, continue
 *   - invalid JSON → skip doc, continue
 *   - unresolved link target → increment linksUnresolved, continue
 *   - any error inside the pipeline never bubbles to the mine import
 *
 * Invoked only when `clawmem mine <dir> --synthesize` is passed (off by default).
 */

import type { Store } from "./store.ts";
import type { LlamaCpp } from "./llm.ts";
import { extractJsonFromLLM } from "./amem.ts";
import type { ContentType } from "./memory.ts";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_DOCS = 20;
const DEFAULT_CONTENT_TYPE_FILTER: ContentType[] = ["conversation"];
const DEFAULT_LINK_WEIGHT = 0.6;
const DEFAULT_CONFIDENCE = 0.7;
const DEFAULT_QUALITY_SCORE = 0.6;
const CONVERSATION_TRUNCATE_CHARS = 3000;
const LLM_MAX_TOKENS = 1200;
const LLM_TEMPERATURE = 0.3;

/** Content types that the extractor is allowed to emit for synthesized facts. */
const VALID_EXTRACTED_TYPES = new Set<ContentType>([
  "decision",
  "preference",
  "milestone",
  "problem",
]);

/** Relation types the extractor may propose — must match the post-P0 taxonomy. */
const VALID_RELATION_TYPES = new Set<string>([
  "semantic",
  "supporting",
  "contradicts",
  "causal",
  "temporal",
  "entity",
]);

// =============================================================================
// Public types (per THOTH_EXTRACTION_PLAN.md Ext 4 spec)
// =============================================================================

export type SynthesizeOptions = {
  /** Required — only operate on this imported collection. */
  collection: string;
  /** Log what would happen but don't insert facts or relations. */
  dryRun?: boolean;
  /** Cap total conversation docs scanned per run (default 20). */
  maxDocs?: number;
  /** Content types to target for synthesis (default ["conversation"]). */
  contentTypeFilter?: ContentType[];
};

export type ExtractedFactLink = {
  targetTitle: string;
  relationType: string;
  weight?: number;
};

export type ExtractedFact = {
  title: string;
  contentType: ContentType;
  narrative: string;
  facts?: string[];
  aliases?: string[];
  sourceDocId: number;
  links?: ExtractedFactLink[];
};

export type SynthesisResult = {
  docsScanned: number;
  factsExtracted: number;
  factsSaved: number;
  linksResolved: number;
  /**
   * Links where the target could not be resolved to a single unique docId.
   * Includes unknown targets AND ambiguous multi-match targets (Turn 13 fix).
   */
  linksUnresolved: number;
  /**
   * Docs where the LLM path itself failed — null response, thrown error,
   * or invalid JSON that couldn't be parsed into an array.
   */
  llmFailures: number;
  /**
   * Docs where the LLM responded with a valid but empty (or all-invalid)
   * extraction — distinct from LLM failures so operators can diagnose
   * "LLM is broken" vs "conversation had no structured facts".
   */
  docsWithNoFacts: number;
};

// =============================================================================
// Helpers
// =============================================================================

/** Normalize a title or alias for localMap keying. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Slugify a title for stable synthesized path generation. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "untitled";
}

/** Render an extracted fact as markdown for the body field. */
export function renderFactBody(fact: ExtractedFact): string {
  const lines: string[] = [
    `# ${fact.title}`,
    "",
    fact.narrative,
  ];

  if (fact.facts && fact.facts.length > 0) {
    lines.push("", "## Supporting facts");
    for (const f of fact.facts) {
      lines.push(`- ${f}`);
    }
  }

  if (fact.aliases && fact.aliases.length > 0) {
    lines.push("", `**Aliases:** ${fact.aliases.join(", ")}`);
  }

  lines.push("", `_Synthesized from conversation doc #${fact.sourceDocId}._`);
  return lines.join("\n");
}

/**
 * Build the LLM prompt for conversation fact extraction.
 * Exported for test inspection.
 */
export function buildExtractionPrompt(conversationText: string): string {
  const content = conversationText.slice(0, CONVERSATION_TRUNCATE_CHARS);
  return `Analyze this conversation and extract structured knowledge facts.

Conversation:
${content}

Extract discrete facts as a JSON array. Each fact should represent ONE of:
- "decision": a choice made, architectural decision, tool selection
- "preference": a stated preference, convention, or style rule
- "milestone": a completed deliverable, version release, or event
- "problem": a bug, issue, or constraint discovered

For each fact provide:
- title: concise 3-8 word title (becomes the fact identity)
- contentType: one of [decision, preference, milestone, problem]
- narrative: 1-3 sentence description of the fact in context
- facts: optional array of supporting fact strings (evidence)
- aliases: optional alternative titles for linking (e.g., ["OAuth choice"] for "Use OAuth 2.0")
- links: optional array of cross-fact references. Each link is
  {targetTitle, relationType, weight}
  - targetTitle may refer to another fact extracted from this conversation OR from
    any other conversation in the same imported batch. Prefer an exact title, and
    if you have multiple candidates use a canonical alias.
  - relationType MUST be one of: semantic, supporting, contradicts, causal, temporal, entity
  - weight is 0.0-1.0 (default 0.6)

Only extract facts the conversation clearly supports. Do NOT fabricate.
Return ONLY valid JSON array. Return empty array [] if no structured facts found.

Example output:
[
  {
    "title": "Use OAuth 2.0 with PKCE",
    "contentType": "decision",
    "narrative": "Team decided to use OAuth 2.0 with PKCE for user authentication, replacing session cookies.",
    "facts": ["PKCE chosen for mobile support", "Legacy session auth to be deprecated Q2"],
    "aliases": ["OAuth decision", "switch to OAuth"],
    "links": [
      { "targetTitle": "Deprecate session auth", "relationType": "causal", "weight": 0.8 }
    ]
  }
]`;
}

/**
 * Validate + normalize a single raw fact object from LLM output.
 * Returns null if the fact is malformed or uses a disallowed content/relation type.
 */
function normalizeExtractedFact(
  raw: unknown,
  sourceDocId: number,
): ExtractedFact | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;

  const contentType = obj.contentType;
  if (typeof contentType !== "string") return null;
  if (!VALID_EXTRACTED_TYPES.has(contentType as ContentType)) return null;

  const narrative = typeof obj.narrative === "string" ? obj.narrative.trim() : "";
  if (!narrative) return null;

  const facts: string[] = Array.isArray(obj.facts)
    ? obj.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];

  const aliases: string[] = Array.isArray(obj.aliases)
    ? obj.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];

  const links: ExtractedFactLink[] = Array.isArray(obj.links)
    ? (obj.links as unknown[])
        .map((l) => {
          if (!l || typeof l !== "object") return null;
          const link = l as Record<string, unknown>;
          const targetTitle =
            typeof link.targetTitle === "string" ? link.targetTitle.trim() : "";
          const relationType =
            typeof link.relationType === "string" ? link.relationType : "";
          if (!targetTitle || !VALID_RELATION_TYPES.has(relationType)) return null;
          const weight =
            typeof link.weight === "number" && Number.isFinite(link.weight)
              ? Math.max(0, Math.min(1, link.weight))
              : DEFAULT_LINK_WEIGHT;
          return { targetTitle, relationType, weight };
        })
        .filter((l): l is ExtractedFactLink => l !== null)
    : [];

  return {
    title,
    contentType: contentType as ContentType,
    narrative,
    facts,
    aliases,
    sourceDocId,
    links,
  };
}

/**
 * Extract facts from a single conversation doc via LLM.
 *
 * Return value discriminates failure mode (Turn 13 fix):
 *   - `null`     → LLM itself failed: null response, thrown error, or non-array JSON
 *   - `[]`       → LLM responded with a valid but empty extraction (or all facts rejected by normalize)
 *   - `[fact..]` → at least one valid fact extracted
 *
 * Callers use this distinction to split `llmFailures` from `docsWithNoFacts`.
 *
 * Exported for unit testing.
 */
export async function extractFactsFromConversation(
  llm: LlamaCpp,
  conversationText: string,
  sourceDocId: number,
): Promise<ExtractedFact[] | null> {
  const prompt = buildExtractionPrompt(conversationText);

  let result;
  try {
    result = await llm.generate(prompt, {
      temperature: LLM_TEMPERATURE,
      maxTokens: LLM_MAX_TOKENS,
    });
  } catch (err) {
    console.log(`[synthesis] LLM generate threw for doc ${sourceDocId}:`, err);
    return null;
  }

  if (!result || typeof result.text !== "string") return null;

  const parsed = extractJsonFromLLM(result.text);
  if (!Array.isArray(parsed)) return null;

  const facts: ExtractedFact[] = [];
  for (const raw of parsed) {
    const fact = normalizeExtractedFact(raw, sourceDocId);
    if (fact) facts.push(fact);
  }
  return facts;
}

/**
 * Resolve a link target to a UNIQUE docId via localMap first, then a SQL
 * fallback scoped to the same collection.
 *
 * Ambiguity handling (Turn 13 fix):
 *  - localMap stores a Set<number> per normalized title/alias. If a key maps
 *    to more than one docId (two different synthesized facts share the same
 *    title or alias), the resolver returns `null` — the caller counts this
 *    as unresolved/ambiguous instead of silently binding to one candidate.
 *  - SQL fallback issues a LIMIT 2 query and returns `null` if more than
 *    one row matches.
 *
 * Exported for unit testing.
 */
export function resolveLinkTarget(
  store: Store,
  localMap: Map<string, Set<number>>,
  titleOrAlias: string,
  collection: string,
): number | null {
  const normalized = normalizeTitle(titleOrAlias);
  if (!normalized) return null;

  const localHits = localMap.get(normalized);
  if (localHits && localHits.size > 0) {
    if (localHits.size === 1) {
      // localHits.values().next().value is the sole docId
      const first = localHits.values().next().value;
      return typeof first === "number" ? first : null;
    }
    // Ambiguous — two or more synthesized facts claim this title/alias
    console.log(
      `[synthesis] Ambiguous local target "${titleOrAlias}" — ${localHits.size} candidates, treated as unresolved`,
    );
    return null;
  }

  try {
    const rows = store.db
      .prepare(
        `SELECT id
         FROM documents
         WHERE collection = ?
           AND active = 1
           AND LOWER(TRIM(title)) = ?
         ORDER BY created_at DESC
         LIMIT 2`,
      )
      .all(collection, normalized) as Array<{ id: number }>;

    if (rows.length === 0) return null;
    if (rows.length > 1) {
      console.log(
        `[synthesis] Ambiguous SQL target "${titleOrAlias}" in collection '${collection}' — multiple matches, treated as unresolved`,
      );
      return null;
    }
    return rows[0]!.id;
  } catch (err) {
    console.log(`[synthesis] SQL lookup failed for "${titleOrAlias}":`, err);
    return null;
  }
}

// =============================================================================
// Main orchestrator
// =============================================================================

/**
 * Helper: add a docId to the localMap under `key`. Uses Set<number> so we can
 * detect ambiguous collisions (two different facts claiming the same title/alias).
 * Turn 13 fix — previous implementation silently overwrote on collision.
 */
function addToLocalMap(
  localMap: Map<string, Set<number>>,
  key: string,
  docId: number,
): void {
  if (!key) return;
  const existing = localMap.get(key);
  if (existing) {
    existing.add(docId);
  } else {
    localMap.set(key, new Set([docId]));
  }
}

/**
 * Build a stable synthesized path for a fact (Turn 14 fix).
 *
 * The path is a pure function of (sourceDocId, slug(title), hash(normalized title)),
 * with NO dependence on extraction order. This means:
 *   - Reruns over the same conversation batch hit saveMemory's
 *     UNIQUE(collection, path) update branch and keep the same synthesized
 *     document in place, even when the LLM's fact order changes.
 *   - Two different facts with the same slug (e.g., "Use OAuth." and
 *     "Use OAuth!" both slugify to "use-oauth") get distinct hash suffixes
 *     because the full normalized title differs, so they do not clobber
 *     each other in the UNIQUE(collection, path) constraint.
 *
 * Turn 13 used a per-run encounter counter which was order-dependent: if the
 * LLM re-emitted the two same-slug facts in reversed order on a subsequent
 * run, the `-2` suffix would land on the other fact and saveMemory would
 * overwrite each row with the wrong body. The hash version is stable.
 */
function buildSynthesizedPath(sourceDocId: number, title: string): string {
  const baseSlug = slugify(title);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(normalizeTitle(title));
  const shortHash = hasher.digest("hex").slice(0, 8);
  return `synthesized/${baseSlug}-src${sourceDocId}-${shortHash}.md`;
}

/**
 * Run the two-pass conversation synthesis pipeline over a collection's
 * imported conversation documents.
 *
 * Failure of this pipeline NEVER aborts or rolls back an upstream mine import —
 * the caller should invoke this AFTER indexCollection has committed its changes.
 */
export async function runConversationSynthesis(
  store: Store,
  llm: LlamaCpp,
  opts: SynthesizeOptions,
): Promise<SynthesisResult> {
  const {
    collection,
    dryRun = false,
    maxDocs = DEFAULT_MAX_DOCS,
    contentTypeFilter = DEFAULT_CONTENT_TYPE_FILTER,
  } = opts;

  const result: SynthesisResult = {
    docsScanned: 0,
    factsExtracted: 0,
    factsSaved: 0,
    linksResolved: 0,
    linksUnresolved: 0,
    llmFailures: 0,
    docsWithNoFacts: 0,
  };

  if (!collection) {
    console.log(`[synthesis] No collection specified — skipping`);
    return result;
  }
  if (contentTypeFilter.length === 0) {
    console.log(`[synthesis] Empty contentTypeFilter — skipping`);
    return result;
  }

  let docs: Array<{ id: number; title: string; body: string }>;
  try {
    const placeholders = contentTypeFilter.map(() => "?").join(",");
    docs = store.db
      .prepare(
        `SELECT d.id, d.title, c.doc as body
         FROM documents d
         JOIN content c ON c.hash = d.hash
         WHERE d.collection = ?
           AND d.active = 1
           AND d.content_type IN (${placeholders})
         ORDER BY d.created_at ASC, d.id ASC
         LIMIT ?`,
      )
      .all(collection, ...contentTypeFilter, maxDocs) as Array<{
      id: number;
      title: string;
      body: string;
    }>;
  } catch (err) {
    console.log(`[synthesis] Query failed for collection '${collection}':`, err);
    return result;
  }

  if (docs.length === 0) {
    console.log(
      `[synthesis] No matching docs in collection '${collection}' (types=${contentTypeFilter.join(",")})`,
    );
    return result;
  }

  console.log(
    `[synthesis] Pass 1 — extracting facts from ${docs.length} doc(s) in '${collection}'${dryRun ? " (dry run)" : ""}`,
  );

  // Pass 1 — extract + save + populate localMap
  // Each fact carries its resolved docId so Pass 2 can reference it without
  // re-querying. In dryRun mode we only count, we do not persist anything.
  type SavedFact = ExtractedFact & { _savedDocId: number };
  const saved: SavedFact[] = [];
  const localMap = new Map<string, Set<number>>();

  for (const doc of docs) {
    result.docsScanned++;

    const extracted = await extractFactsFromConversation(llm, doc.body, doc.id);

    if (extracted === null) {
      // LLM path failed (null / thrown / non-array)
      result.llmFailures++;
      continue;
    }

    if (extracted.length === 0) {
      // LLM returned a valid response but there were no structured facts
      // to extract (or all candidates were rejected by normalize).
      result.docsWithNoFacts++;
      continue;
    }

    for (const fact of extracted) {
      result.factsExtracted++;

      if (dryRun) continue;

      try {
        const saveResult = store.saveMemory({
          collection,
          path: buildSynthesizedPath(doc.id, fact.title),
          title: fact.title,
          body: renderFactBody(fact),
          contentType: fact.contentType,
          confidence: DEFAULT_CONFIDENCE,
          qualityScore: DEFAULT_QUALITY_SCORE,
          semanticPayload: `${fact.title}\n${fact.narrative}`,
        });

        if (!saveResult.docId || saveResult.docId < 0) continue;

        if (saveResult.action === "inserted" || saveResult.action === "updated") {
          result.factsSaved++;
        }

        // Populate localMap with the canonical title and every alias. Using
        // Set<number> means a second fact claiming the same title/alias will
        // make the key ambiguous and the resolver returns null instead of
        // silently picking one. (Turn 13 fix.)
        addToLocalMap(localMap, normalizeTitle(fact.title), saveResult.docId);
        for (const alias of fact.aliases ?? []) {
          addToLocalMap(localMap, normalizeTitle(alias), saveResult.docId);
        }

        saved.push({ ...fact, _savedDocId: saveResult.docId });
      } catch (err) {
        console.log(`[synthesis] saveMemory error for "${fact.title}":`, err);
      }
    }
  }

  if (dryRun) {
    console.log(
      `[synthesis] Dry run complete — docsScanned=${result.docsScanned} factsExtracted=${result.factsExtracted} llmFailures=${result.llmFailures} docsWithNoFacts=${result.docsWithNoFacts}`,
    );
    return result;
  }

  // Pass 2 — resolve links against localMap first, then collection-scoped SQL
  console.log(
    `[synthesis] Pass 2 — resolving links for ${saved.length} saved fact(s)`,
  );

  for (const fact of saved) {
    if (!fact.links || fact.links.length === 0) continue;
    const sourceDocId = fact._savedDocId;

    for (const link of fact.links) {
      const targetId = resolveLinkTarget(
        store,
        localMap,
        link.targetTitle,
        collection,
      );

      if (targetId === null || targetId === sourceDocId) {
        result.linksUnresolved++;
        if (targetId !== sourceDocId) {
          console.log(
            `[synthesis] Unresolved link "${link.targetTitle}" from doc ${sourceDocId}`,
          );
        }
        continue;
      }

      try {
        // Idempotent-yet-evidence-preserving upsert (Turn 13 fix):
        //   INSERT OR IGNORE under-accumulated — it discarded later runs that
        //     had stronger evidence for the same triple.
        //   store.insertRelation over-accumulated (weight += excluded.weight) —
        //     it inflated weights linearly with rerun count.
        // `ON CONFLICT DO UPDATE SET weight = MAX(weight, excluded.weight)`
        // is idempotent on reruns with equal weight AND monotonically accepts
        // later-discovered stronger evidence for the same (source, target, type)
        // triple without double-counting.
        store.db
          .prepare(
            `INSERT INTO memory_relations
               (source_id, target_id, relation_type, weight, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_id, target_id, relation_type)
             DO UPDATE SET weight = MAX(weight, excluded.weight)`,
          )
          .run(
            sourceDocId,
            targetId,
            link.relationType,
            link.weight ?? DEFAULT_LINK_WEIGHT,
            JSON.stringify({ origin: "conversation-synthesis" }),
            new Date().toISOString(),
          );
        result.linksResolved++;
      } catch (err) {
        console.log(
          `[synthesis] insertRelation failed ${sourceDocId}->${targetId} (${link.relationType}):`,
          err,
        );
        result.linksUnresolved++;
      }
    }
  }

  console.log(
    `[synthesis] Complete — docsScanned=${result.docsScanned} factsExtracted=${result.factsExtracted} factsSaved=${result.factsSaved} linksResolved=${result.linksResolved} linksUnresolved=${result.linksUnresolved} llmFailures=${result.llmFailures} docsWithNoFacts=${result.docsWithNoFacts}`,
  );

  return result;
}
