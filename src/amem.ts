/**
 * A-MEM: Self-Evolving Memory System
 *
 * Constructs memory notes, generates typed links, and tracks memory evolution.
 * All operations are non-fatal and log errors with [amem] prefix.
 */

import { stripLeadingMarks } from "./text-policy.ts";
import type { Database } from "bun:sqlite";
import { isoNow } from "./clock.ts";
import type { LlamaCpp } from "./llm.ts";
import { withRetryAndFeedback } from "./llm-retry.ts";
import type { Store } from "./store.ts";
import { enrichDocumentEntities } from "./entity.ts";
import { EVOLUTION_WRITER, notLegacyArtifactSql, notLegacyTaintedNoteSql } from "./compaction-state.ts";
import { relWeightSql } from "./relation-weight.ts";
import { usableDistance } from "./vector-guard.ts";
import { runExact } from "./stored-copy.ts";

export interface MemoryNote {
  keywords: string[];
  tags: string[];
  context: string;
}

const EMPTY_NOTE: MemoryNote = {
  keywords: [],
  tags: [],
  context: ""
};

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

type LinkRelationType = 'semantic' | 'supporting' | 'contradicts';

type ParsedLinkGeneration = {
  target_idx: number;
  link_type: LinkRelationType;
  confidence: number;
  reasoning: string;
};


function isLinkRelationType(value: unknown): value is LinkRelationType {
  return value === 'semantic' || value === 'supporting' || value === 'contradicts';
}

function isUnitIntervalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isParsedLinkGeneration(value: unknown): value is ParsedLinkGeneration {
  if (!value || typeof value !== 'object') return false;
  const link = value as Record<string, unknown>;
  return Number.isInteger(link.target_idx) &&
    (link.target_idx as number) > 0 &&
    isLinkRelationType(link.link_type) &&
    isUnitIntervalNumber(link.confidence) &&
    typeof link.reasoning === 'string';
}

export function parseMemoryNoteFromLLM(raw: string): MemoryNote | null {
  const parsed = extractJsonFromLLM(raw) as Partial<MemoryNote> | null;
  if (parsed && Array.isArray(parsed.keywords)) {
    return {
      keywords: parsed.keywords.filter((v): v is string => typeof v === 'string'),
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((v): v is string => typeof v === 'string') : [],
      context: typeof parsed.context === 'string' ? parsed.context : '',
    };
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const keywords = uniqueStrings(lines.filter((line) => line.startsWith('lex:')).map((line) => line.slice(4).trim()));
  const context = lines.find((line) => line.startsWith('hyde:'))?.slice(5).trim() ?? '';
  if (keywords.length === 0 && !context) {
    return null;
  }

  return {
    keywords,
    tags: [],
    context,
  };
}

export function parseLinkGenerationFromLLM(raw: string): ParsedLinkGeneration[] | null {
  const parsed = extractJsonFromLLM(raw) as { result?: unknown } | unknown[] | null;
  const wrapped = parsed && typeof parsed === 'object' ? parsed as { result?: unknown } : null;
  const items = Array.isArray(parsed)
    ? parsed
    : wrapped && Array.isArray(wrapped.result)
      ? wrapped.result
      : null;

  if (!items) return null;
  const validItems = items.filter(isParsedLinkGeneration);
  return validItems.length === items.length ? validItems : null;
}

function tryParseJsonWithCommaRepair(text: string): any | null {
  // Repair missing commas between object fields without rewriting adjacent array strings.
  const repaired = text.replace(
    /(\]|\}|"(?:[^"\\]|\\.)*"|-?\d(?:[\d.eE+-])*|true|false|null)(\s*"[^"\n]+"\s*:)/g,
    '$1,$2'
  );
  if (repaired === text) return null;
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

function extractBalancedJsonCandidate(text: string): string | null {
  if (text[0] !== '{' && text[0] !== '[') return null;

  const stack: string[] = [text[0]!];
  let inString = false;
  let escaped = false;

  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }

    if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== expected) return null;
      stack.pop();
      if (stack.length === 0) return text.slice(0, i + 1);
    }
  }

  return null;
}

function parseBalancedJsonValue(candidate: string): any | null {
  try {
    return JSON.parse(candidate);
  } catch {
    return tryParseJsonWithCommaRepair(candidate);
  }
}

function jsonStartsAtTrimmedLineStart(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return text.slice(lineStart, index).trim().length === 0;
}

function findLineStartJsonAfter(text: string, index: number): number {
  for (let i = index; i < text.length; i++) {
    if ((text[i] === '{' || text[i] === '[') && jsonStartsAtTrimmedLineStart(text, i)) return i;
  }
  return -1;
}

function isLikelyInlineProseLiteral(text: string, index: number): boolean {
  return !jsonStartsAtTrimmedLineStart(text, index) && !hasPayloadCueBefore(text, index);
}

function collectParseableBalancedJsonCandidates(
  text: string,
  startIndex: number
): Array<{ start: number; parsed: any }> {
  const candidates: Array<{ start: number; parsed: any }> = [];
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;

    const balancedCandidate = extractBalancedJsonCandidate(text.slice(i));
    if (!balancedCandidate) continue;

    const parsed = parseBalancedJsonValue(balancedCandidate);
    if (parsed !== null) candidates.push({ start: i, parsed });

    i += balancedCandidate.length - 1;
  }
  return candidates;
}

function selectBalancedJsonCandidate(text: string, candidates: Array<{ start: number; parsed: any }>): any | null {
  if (candidates.length === 0) return null;

  const payloadCandidate = candidates.find((candidate) => hasPayloadCueBefore(text, candidate.start));
  if (payloadCandidate) return payloadCandidate.parsed;

  const first = candidates[0]!;
  if (candidates.length > 1 && (hasExampleCueBefore(text, first.start) || isLikelyInlineProseLiteral(text, first.start))) {
    const laterPayload = candidates.find((candidate) =>
      !hasExampleCueBefore(text, candidate.start) && !isLikelyInlineProseLiteral(text, candidate.start)
    );
    if (laterPayload) return laterPayload.parsed;
  }

  return first.parsed;
}

function parseJsonCandidate(raw: string): any | null {
  const trimmed = raw.trim();
  const arrStart = trimmed.indexOf('[');
  const objStart = trimmed.indexOf('{');
  if (arrStart === -1 && objStart === -1) return null;

  const start = arrStart === -1 ? objStart : objStart === -1 ? arrStart : Math.min(arrStart, objStart);
  const text = trimmed.slice(start);

  try {
    return JSON.parse(text);
  } catch {
    // Try extracting balanced JSON values before lighter repairs.
  }

  const firstBalancedCandidate = extractBalancedJsonCandidate(text);
  if (firstBalancedCandidate) {
    if (hasExampleCueBefore(trimmed, start) || isLikelyInlineProseLiteral(trimmed, start)) {
      const laterLineStartJson = findLineStartJsonAfter(trimmed, start + firstBalancedCandidate.length);
      if (laterLineStartJson !== -1) {
        const laterParsed = parseJsonCandidate(trimmed.slice(laterLineStartJson));
        if (laterParsed !== null) return laterParsed;
      }
    }
    const balancedParsed = selectBalancedJsonCandidate(
      trimmed,
      collectParseableBalancedJsonCandidates(trimmed, start)
    );
    if (balancedParsed !== null) return balancedParsed;
  }

  const commaRepaired = tryParseJsonWithCommaRepair(text);
  if (commaRepaired !== null) return commaRepaired;

  if (text.startsWith('[')) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > 0) {
      const repaired = text.slice(0, lastBrace + 1) + ']';
      try { return JSON.parse(repaired); } catch { /* continue */ }
    }
    try { return JSON.parse(text.replace(/,\s*$/, '') + ']'); } catch { /* continue */ }
  }

  if (text.startsWith('{')) {
    for (let i = text.length - 1; i > 0; i--) {
      if (text[i] === '}' || text[i] === '"' || text[i] === '0' || text[i] === '1' ||
          text[i] === '2' || text[i] === '3' || text[i] === '4' || text[i] === '5' ||
          text[i] === '6' || text[i] === '7' || text[i] === '8' || text[i] === '9' ||
          text[i] === 'e' || text[i] === 'l') {
        const candidate = text.slice(0, i + 1) + '}';
        try { return JSON.parse(candidate); } catch { /* continue */ }
      }
    }
  }

  return null;
}

function collectFenceBlocks(text: string): Array<{ start: number; end: number; tag: string | null; body: string }> {
  const lines = text.split('\n');
  const fences: Array<{ start: number; end: number; tag: string | null; body: string }> = [];
  let offset = 0;
  let open: { start: number; tag: string | null; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const lineStart = offset;
    const lineEnd = offset + line.length;

    if (!open) {
      const match = trimmed.match(/^```([^\s`]*)?\s*$/);
      if (match) {
        open = { start: lineStart, tag: match[1] || null, bodyLines: [] };
      }
    } else if (trimmed === '```') {
      fences.push({
        start: open.start,
        end: Math.min(text.length, lineEnd + 1),
        tag: open.tag,
        body: open.bodyLines.join('\n').trim(),
      });
      open = null;
    } else {
      open.bodyLines.push(line);
    }

    offset = lineEnd + 1;
  }

  if (open) {
    fences.push({
      start: open.start,
      end: text.length,
      tag: open.tag,
      body: open.bodyLines.join('\n').trim(),
    });
  }

  return fences;
}

function stripAnyFences(text: string): string {
  const ranges = collectAnyFenceRanges(text);
  if (ranges.length === 0) return text.trim();

  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  out += text.slice(cursor);
  return out.trim();
}

function collectStructuralFences(text: string): Array<{ body: string; isJson: boolean; start: number; end: number }> {
  return collectFenceBlocks(text)
    .filter((fence) => fence.tag === null || fence.tag === 'json')
    .map((fence) => ({
      body: fence.body,
      isJson: fence.tag === 'json',
      start: fence.start,
      end: fence.end,
    }));
}

function collectAnyFenceRanges(text: string): Array<{ start: number; end: number }> {
  return collectFenceBlocks(text).map((fence) => ({ start: fence.start, end: fence.end }));
}

function findFirstJsonStartOutsideFences(
  text: string,
  fences: Array<{ start: number; end: number }>
 ): number {
  let fenceIndex = 0;
  for (let i = 0; i < text.length; i++) {
    while (fenceIndex < fences.length && i >= fences[fenceIndex]!.end) {
      fenceIndex++;
    }
    if (fenceIndex < fences.length) {
      const fence = fences[fenceIndex]!;
      if (i >= fence.start && i < fence.end) {
        i = fence.end - 1;
        continue;
      }
    }
    if (text[i] === '[' || text[i] === '{') return i;
  }
  return -1;
}

function hasExampleCueBefore(text: string, index: number): boolean {
  let end = index;
  while (end > 0 && /\s/.test(text[end - 1]!)) end--;
  const lineStart = text.lastIndexOf('\n', end - 1) + 1;
  const cue = text.slice(lineStart, end).toLowerCase();
  return cue.includes('example') || cue.includes('e.g.') || cue.includes('schema');
}

function hasPayloadCueBefore(text: string, index: number): boolean {
  let end = index;
  while (end > 0 && /\s/.test(text[end - 1]!)) end--;
  const lineStart = text.lastIndexOf('\n', end - 1) + 1;
  const cue = text.slice(lineStart, end).trim().toLowerCase();
  return /^(actual|result|final|answer)(?:\s+(json|answer|response|payload))?[:\-]?$/.test(cue);
}
/**
 * Extract and parse JSON from LLM output, handling:
 * - Markdown code blocks (```json ... ```)
 * - Leading/trailing prose around JSON
 * - Truncated JSON from token limits (repairs arrays/objects)
 */
export function extractJsonFromLLM(raw: string): any | null {
  const text = raw.trim();
  if (!text) return null;

  const fences = collectStructuralFences(text);
  const jsonFences = fences.filter((fence) => fence.isJson);
  const anyFenceRanges = collectAnyFenceRanges(text);
  const outsideJsonStart = findFirstJsonStartOutsideFences(text, anyFenceRanges);
  const outsideLooksLikeExample = outsideJsonStart !== -1 && hasExampleCueBefore(text, outsideJsonStart);
  const outsideLooksLikePayload = outsideJsonStart !== -1 && hasPayloadCueBefore(text, outsideJsonStart);
  const preferredJsonFences = jsonFences.filter((fence) =>
    !hasExampleCueBefore(text, fence.start) &&
    !(text.startsWith('```') && fence.start === fences[0]?.start && outsideLooksLikePayload)
  );
  const preferredUntaggedFences = fences.filter((fence) => !fence.isJson && !hasExampleCueBefore(text, fence.start));
  const firstPreferredJsonFence = preferredJsonFences[0] ?? null;
  const firstPreferredUntaggedFence = preferredUntaggedFences[0] ?? null;
  const untaggedFenceLooksLikeExample = firstPreferredUntaggedFence ? hasExampleCueBefore(text, firstPreferredUntaggedFence.start) : false;
  const outsidePrecedesPreferredJsonFence = !!firstPreferredJsonFence && outsideJsonStart < firstPreferredJsonFence.start;
  const tryOutsideBeforeJsonFences = outsideJsonStart !== -1 &&
    !outsideLooksLikeExample &&
    (!outsidePrecedesPreferredJsonFence || outsideLooksLikePayload);

  if (text.startsWith('```') && fences[0]?.start === 0 && !outsideLooksLikePayload && (fences[0]!.isJson || preferredJsonFences.length === 0)) {
    const parsedLeadingFence = parseJsonCandidate(fences[0]!.body);
    if (parsedLeadingFence !== null) return parsedLeadingFence;
  }

  const tryOutsideFences = () => {
    const withoutFences = stripAnyFences(text);
    if (!withoutFences || withoutFences === text) return null;
    return parseJsonCandidate(withoutFences);
  };

  if (!text.startsWith('```') && !firstPreferredJsonFence && firstPreferredUntaggedFence && outsideLooksLikeExample && !untaggedFenceLooksLikeExample) {
    const parsedUntaggedFence = parseJsonCandidate(firstPreferredUntaggedFence.body);
    if (parsedUntaggedFence !== null) return parsedUntaggedFence;
  }

  if (tryOutsideBeforeJsonFences) {
    const parsedOutsideFences = tryOutsideFences();
    if (parsedOutsideFences !== null) return parsedOutsideFences;
  }

  for (const fence of preferredJsonFences) {
    const parsedJsonFence = parseJsonCandidate(fence.body);
    if (parsedJsonFence !== null) return parsedJsonFence;
  }

  if (!tryOutsideBeforeJsonFences) {
    const parsedOutsideFences = tryOutsideFences();
    if (parsedOutsideFences !== null) return parsedOutsideFences;
  }

  if (fences.length === 0) {
    const parsedRaw = parseJsonCandidate(text);
    if (parsedRaw !== null) return parsedRaw;
  }

  const fallbackFences = preferredJsonFences.length === 0
    ? [
        ...preferredUntaggedFences,
        ...jsonFences.filter((fence) => hasExampleCueBefore(text, fence.start)),
        ...(text.startsWith('```')
          ? fences.slice(1).filter((fence) => !fence.isJson && hasExampleCueBefore(text, fence.start))
          : fences.filter((fence) => !fence.isJson && hasExampleCueBefore(text, fence.start))),
      ]
    : [
        ...jsonFences.filter((fence) => hasExampleCueBefore(text, fence.start)),
        ...(text.startsWith('```')
          ? fences.slice(1).filter((fence) => !fence.isJson)
          : fences.filter((fence) => !fence.isJson)),
      ];
  for (const fence of fallbackFences) {
    const parsedFence = parseJsonCandidate(fence.body);
    if (parsedFence !== null) return parsedFence;
  }

  return null;
}

/**
 * Construct a memory note for a document using LLM analysis.
 * Extracts keywords, tags, and context summary.
 *
 * @param store - Store instance
 * @param llm - LLM instance
 * @param docId - Document numeric ID
 * @returns Memory note with keywords, tags, and context
 */
export async function constructMemoryNote(
  store: Store,
  llm: LlamaCpp,
  docId: number
): Promise<MemoryNote> {
  try {
    // Get document info. The legacy pre-compaction snapshot is never an enrichment input (62.2).
    const doc = store.db.prepare(`
      SELECT d.collection, d.path, d.title, c.doc as body
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.id = ? AND d.active = 1 AND ${notLegacyArtifactSql("d", "c.doc")}
    `).get(docId) as { collection: string; path: string; title: string; body: string } | null;

    if (!doc) {
      console.log(`[amem] Document ${docId} not found or inactive`);
      return EMPTY_NOTE;
    }

    // Truncate content to 2000 chars
    const content = doc.body.slice(0, 2000);

    // LLM prompt for memory note construction
    const prompt = `Analyze this document and extract structured memory metadata.

Title: ${doc.title}
Path: ${doc.collection}/${doc.path}

Content:
${content}

Extract:
1. keywords: 3-7 key concepts or terms
2. tags: 2-5 categorical labels
3. context: 1-2 sentence summary of what this document is about

Return ONLY valid JSON in this exact format:
{
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "tags": ["tag1", "tag2"],
  "context": "Brief summary of the document."
}`;

    const parsed = await withRetryAndFeedback({
      initialPrompt: prompt,
      llm,
      maxTokens: 300,
      temperature: 0.3,
      label: `amem.constructMemoryNote(doc ${docId})`,
      parse: (text) => {
        const note = parseMemoryNoteFromLLM(text);
        if (!note) {
          return {
            ok: false,
            error:
              "Response was not the expected JSON object with keywords/tags/context. Return ONLY that JSON object.",
          };
        }
        return { ok: true, value: note };
      },
    });

    if (!parsed) {
      console.log(`[amem] Invalid/unparseable JSON for docId ${docId} after retries`);
      return EMPTY_NOTE;
    }

    return {
      keywords: parsed.keywords,
      tags: parsed.tags,
      context: parsed.context
    };
  } catch (err) {
    console.log(`[amem] Error constructing memory note for docId ${docId}:`, err);
    return EMPTY_NOTE;
  }
}

/**
 * A note carrying no information. Blank entries do not count: the parser preserves
 * whitespace-only strings inside the arrays, so `{keywords: [" "], tags: [], context: " "}`
 * would otherwise be written over NULL and permanently mask the row from backfill.
 * A note with ONE real keyword, tag, or context is information and is kept.
 */
function isEmptyNote(note: MemoryNote): boolean {
  const hasText = (xs: string[]) => xs.some(x => typeof x === "string" && x.trim().length > 0);
  return !hasText(note.keywords) && !hasText(note.tags) && !note.context.trim();
}

/**
 * Store memory note in the documents table.
 * Updates amem_keywords, amem_tags, and amem_context columns.
 *
 * §55.6 D8.2 — FAIL-CLOSED. An empty note is never written, whatever the row currently holds:
 *
 *  - Over a learned note, the empty write destroyed it. `constructMemoryNote` fails OPEN to an
 *    empty note when inference is unavailable, and this write used to be unconditional, so a
 *    transient outage during a routine reindex blanked A-MEM on every document it touched
 *    (measured: `["LEARNED"]` -> `[]` on a reactivation with an identical body).
 *  - Over a NULL row it was worse in a quieter way: it makes a FAILURE indistinguishable from
 *    completed enrichment, and `backfillAmem`'s `amem_keywords IS NULL` predicate then never
 *    retries it. NULL is the retryable state and must survive a failed attempt.
 *
 * @returns whether the note was actually written — so callers cannot report success after a no-op.
 */
export function storeMemoryNote(
  store: Store,
  docId: number,
  note: MemoryNote
): boolean {
  if (isEmptyNote(note)) return false;
  try {
    const result = store.db.prepare(`
      UPDATE documents
      SET amem_keywords = ?,
          amem_tags = ?,
          amem_context = ?
      WHERE id = ?
    `).run(
      JSON.stringify(note.keywords),
      JSON.stringify(note.tags),
      stripLeadingMarks(note.context),                                 // 82.3 D7: a normalised field (model output)
      docId
    );
    // `.changes` is inflated by the documents_fts triggers and is NOT a row count — but zero
    // is still unambiguous: no row matched, so nothing landed.
    return result.changes > 0;
  } catch (err) {
    console.log(`[amem] Error storing memory note for docId ${docId}:`, err);
    return false;
  }
}

export interface MemoryLink {
  target_id: number;
  link_type: 'semantic' | 'supporting' | 'contradicts';
  confidence: number;
  reasoning: string;
}

function isVectorIndexUnavailable(error: unknown): boolean {
  const message = String((error as any)?.message ?? error).toLowerCase();
  return message.includes("no such table: vectors_vec") ||
    message.includes("no such column: hash_seq") ||
    message.includes("no such column: embedding") ||
    message.includes("no such column: v1.embedding") ||
    message.includes("no such column: v2.embedding") ||
    message.includes("no such function: vec_distance_cosine") ||
    message.includes("no such module: vec0");
}

function isSqlSchemaError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error).toLowerCase();
  return message.includes("no such column:") ||
    message.includes("no such table:") ||
    message.includes("no such function:") ||
    message.includes("no such module:");
}

/**
 * Generate typed memory links for a document based on semantic similarity.
 * Finds k-nearest neighbors and uses LLM to determine relationship types.
 *
 * @param store - Store instance
 * @param llm - LLM instance
 * @param docId - Source document numeric ID
 * @param kNeighbors - Number of neighbors to find (default 8)
 * @returns Number of links created
 */
export async function generateMemoryLinks(
  store: Store,
  llm: LlamaCpp,
  docId: number,
  kNeighbors: number = 8
): Promise<number> {
  try {
    // Get source document info. The legacy pre-compaction snapshot is never linked, and a note it shaped
    // lends no context until its reset rebuilds it (62.2).
    const sourceDoc = store.db.prepare(`
      SELECT d.id, d.hash, d.title, d.collection, d.path,
        CASE WHEN ${notLegacyTaintedNoteSql("d")} THEN d.amem_context END AS amem_context
      FROM documents d
      WHERE d.id = ? AND d.active = 1 AND ${notLegacyArtifactSql("d")}
    `).get(docId) as { id: number; hash: string; title: string; collection: string; path: string; amem_context: string | null } | null;

    if (!sourceDoc) {
      console.log(`[amem] Source document ${docId} not found or inactive`);
      return 0;
    }

    // Indexing may run before vector tables/embeddings are ready.
    // Degrade quietly here instead of surfacing misleading SQL errors.
    const vecTableExists = !!store.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
    ).get();
    if (!vecTableExists) return 0;

    // Find k-nearest neighbors using vector similarity
    let neighbors: {
      target_id: number;
      target_title: string;
      target_context: string | null;
      distance: number;
    }[] = [];
    try {
      const sourceVectorExists = !!store.db.prepare(
        `SELECT 1 FROM vectors_vec WHERE hash_seq = ? LIMIT 1`
      ).get(`${sourceDoc.hash}_0`);
      if (!sourceVectorExists) return 0;

      neighbors = store.db.prepare(`
        SELECT
          d2.id as target_id,
          d2.title as target_title,
          CASE WHEN ${notLegacyTaintedNoteSql("d2")} THEN d2.amem_context END as target_context,
          vec_distance_cosine(v1.embedding, v2.embedding) as distance
        FROM vectors_vec v1, vectors_vec v2
        JOIN documents d2 ON v2.hash_seq = d2.hash || '_0'
        WHERE v1.hash_seq = ? || '_0'
          AND d2.id != ?
          AND d2.active = 1
          AND ${notLegacyArtifactSql("d2")}
          AND vec_distance_cosine(v1.embedding, v2.embedding) IS NOT NULL
        ORDER BY distance
        LIMIT ?
      `).all(sourceDoc.hash, sourceDoc.id, kNeighbors) as {
        target_id: number;
        target_title: string;
        target_context: string | null;
        distance: number;
      }[];
      // v0.43.7 (82.2 D4): a NULL distance takes no place (the query excludes it). A row SQL returned whose
      // distance is not usable (an infinity, a value outside [0, 2]) is not a neighbour: skipped and counted.
      const returned = neighbors.length;
      neighbors = neighbors.filter(n => usableDistance(n.distance) !== null);
      if (neighbors.length < returned) {
        console.warn(`[amem] skipped ${returned - neighbors.length} neighbour row(s) of docId ${docId} whose distance is not usable; \`clawmem doctor\` lists the stored vectors`);
      }
    } catch (error) {
      if (isVectorIndexUnavailable(error)) return 0;
      throw error;
    }

    if (neighbors.length === 0) {
      console.log(`[amem] No neighbors found for docId ${docId}`);
      return 0;
    }

    // Build LLM prompt to analyze relationships
    const neighborsText = neighbors.map((n, idx) =>
      `${idx + 1}. "${n.target_title}": ${n.target_context || 'No context available'}`
    ).join('\n');

    const prompt = `Analyze the relationship between a source document and its semantic neighbors.

Source Document:
Title: ${sourceDoc.title}
Context: ${sourceDoc.amem_context || 'No context available'}

Semantically Similar Documents:
${neighborsText}

For each neighbor, determine the relationship type:
- "semantic": General topical similarity, related concepts
- "supporting": Provides evidence, examples, or elaboration for the source
- "contradicts": Presents conflicting information or opposing views

Also assign a confidence score (0.0-1.0) for each relationship.

Return ONLY valid JSON array in this exact format:
[
  {
    "target_idx": 1,
    "link_type": "semantic",
    "confidence": 0.85,
    "reasoning": "Brief explanation"
  },
  {
    "target_idx": 2,
    "link_type": "supporting",
    "confidence": 0.92,
    "reasoning": "Brief explanation"
  }
]

Include all ${neighbors.length} neighbors in your response.`;

    const parsed = await withRetryAndFeedback({
      initialPrompt: prompt,
      llm,
      maxTokens: 500,
      temperature: 0.3,
      label: `amem.generateMemoryLinks(doc ${docId})`,
      parse: (text) => {
        const linkGen = parseLinkGenerationFromLLM(text);
        if (!linkGen) {
          return {
            ok: false,
            error:
              "Response was not the expected JSON array of link objects (target_idx, link_type, confidence, reasoning). Return ONLY that JSON array.",
          };
        }
        return { ok: true, value: linkGen };
      },
    });

    if (!parsed) {
      console.log(`[amem] Invalid/unparseable JSON for link generation docId ${docId} after retries`);
      return 0;
    }


    // Insert links into memory_relations
    let linksCreated = 0;
    const now = isoNow();
    const linkedTargetIndexes = new Set<number>();

    for (const link of parsed) {
      const neighbor = neighbors[link.target_idx - 1];
      if (!neighbor) {
        console.log(`[amem] Skipping out-of-range link target ${link.target_idx} for docId ${docId}`);
        continue;
      }
      if (linkedTargetIndexes.has(link.target_idx)) {
        console.log(`[amem] Skipping duplicate link target ${link.target_idx} for docId ${docId}`);
        continue;
      }
      linkedTargetIndexes.add(link.target_idx);

      // Insert link with INSERT OR IGNORE for idempotency
      store.db.prepare(`
        INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, weight, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        sourceDoc.id,
        neighbor.target_id,
        link.link_type,
        link.confidence,
        JSON.stringify({ reasoning: link.reasoning }),
        now
      );
      linksCreated++;
    }

    console.log(`[amem] Created ${linksCreated} links for docId ${docId}`);
    return linksCreated;
  } catch (err) {
    if (isSqlSchemaError(err) && !isVectorIndexUnavailable(err)) {
      throw err;
    }
    console.log(`[amem] Error generating memory links for docId ${docId}:`, err);
    return 0;
  }
}

export interface MemoryEvolution {
  should_evolve: boolean;
  new_keywords: string[];
  new_tags: string[];
  new_context: string;
  reasoning: string;
}

/**
 * Evolve a memory note based on new evidence from linked neighbors.
 * Tracks evolution history in memory_evolution table.
 *
 * @param store - Store instance
 * @param llm - LLM instance
 * @param memoryId - Memory document numeric ID
 * @param triggeredBy - Document ID that triggered this evolution
 * @returns True if evolution occurred, false otherwise
 */
export async function evolveMemories(
  store: Store,
  llm: LlamaCpp,
  memoryId: number,
  triggeredBy: number
): Promise<boolean> {
  // A note is never evidence for itself (62.2: a self-triggered entry is also the shape a reset marker takes).
  if (memoryId === triggeredBy) return false;
  try {
    // Get current memory state. Neither the memory nor any evidence below is the legacy
    // pre-compaction snapshot, or a note it shaped that no reset has rebuilt yet (62.2).
    const memory = store.db.prepare(`
      SELECT id, title, amem_keywords, amem_tags, amem_context
      FROM documents
      WHERE id = ? AND active = 1 AND ${notLegacyArtifactSql("documents")} AND ${notLegacyTaintedNoteSql("documents")}
    `).get(memoryId) as {
      id: number;
      title: string;
      amem_keywords: string | null;
      amem_tags: string | null;
      amem_context: string | null;
    } | null;

    if (!memory || !memory.amem_context) {
      console.log(`[amem] Memory ${memoryId} not found or has no context`);
      return false;
    }

    // Get linked neighbors for context
    const neighbors = store.db.prepare(`
      SELECT
        d.id,
        d.title,
        d.amem_context,
        mr.relation_type,
        ${relWeightSql("mr")} AS weight
      FROM memory_relations mr
      JOIN documents d ON d.id = mr.target_id
      WHERE mr.source_id = ?
        AND d.active = 1
        AND d.amem_context IS NOT NULL
        AND ${notLegacyArtifactSql("d")}
        AND ${notLegacyTaintedNoteSql("d")}
      ORDER BY ${relWeightSql("mr")} DESC
      LIMIT 5
    `).all(memoryId) as Array<{
      id: number;
      title: string;
      amem_context: string;
      relation_type: string;
      weight: number;
    }>;

    if (neighbors.length === 0) {
      console.log(`[amem] No linked neighbors for memory ${memoryId}`);
      return false;
    }

    // Build LLM prompt for evolution analysis
    const currentKeywords = memory.amem_keywords ? JSON.parse(memory.amem_keywords) : [];
    const currentTags = memory.amem_tags ? JSON.parse(memory.amem_tags) : [];

    const neighborsText = neighbors.map((n, idx) =>
      `${idx + 1}. [${n.relation_type}, conf=${n.weight.toFixed(2)}] "${n.title}": ${n.amem_context}`
    ).join('\n');

    const prompt = `Analyze if a memory note should evolve based on new evidence from linked documents.

Current Memory:
Title: ${memory.title}
Keywords: ${JSON.stringify(currentKeywords)}
Tags: ${JSON.stringify(currentTags)}
Context: ${memory.amem_context}

Linked Evidence:
${neighborsText}

Determine if the memory should evolve based on:
1. New contradictory information that changes understanding
2. Supporting evidence that strengthens or refines the context
3. New concepts that should be incorporated

If evolution is warranted, provide:
- new_keywords: Updated keyword list (maintain 3-7 items)
- new_tags: Updated tags (maintain 2-5 items)
- new_context: Refined context incorporating new evidence
- reasoning: Why this evolution is necessary

Return ONLY valid JSON in this exact format:
{
  "should_evolve": true,
  "new_keywords": ["keyword1", "keyword2", "keyword3"],
  "new_tags": ["tag1", "tag2"],
  "new_context": "Updated context summary.",
  "reasoning": "Explanation of why evolution occurred."
}

If no evolution is needed:
{
  "should_evolve": false,
  "new_keywords": [],
  "new_tags": [],
  "new_context": "",
  "reasoning": "No significant new information."
}`;

    const evolution = await withRetryAndFeedback<MemoryEvolution>({
      initialPrompt: prompt,
      llm,
      maxTokens: 400,
      temperature: 0.4,
      label: `amem.evolveMemories(memory ${memoryId})`,
      parse: (text) => {
        const value = extractJsonFromLLM(text) as MemoryEvolution | null;
        if (!value || typeof value.should_evolve !== "boolean") {
          return {
            ok: false,
            error:
              'Response was not the expected JSON object with a boolean "should_evolve" field. Return ONLY that JSON object.',
          };
        }
        // Structural validation of the evolution payload lives INSIDE the
        // parse closure so a malformed should_evolve=true response triggers a
        // corrective retry instead of a silent post-loop rejection.
        if (value.should_evolve &&
            (!Array.isArray(value.new_keywords) ||
             !Array.isArray(value.new_tags) ||
             typeof value.new_context !== "string" ||
             typeof value.reasoning !== "string")) {
          return {
            ok: false,
            error:
              'When "should_evolve" is true, the object must include "new_keywords" (array), "new_tags" (array), "new_context" (string), and "reasoning" (string). Return ONLY the corrected JSON object.',
          };
        }
        return { ok: true, value };
      },
    });

    if (!evolution) {
      console.log(`[amem] Invalid evolution JSON for memory ${memoryId} after retries`);
      return false;
    }

    if (!evolution.should_evolve) {
      console.log(`[amem] No evolution needed for memory ${memoryId}`);
      return false;
    }

    // Payload structure already validated inside the parse closure (§13.1).

    // Get current version number
    const versionRow = store.db.prepare(`
      SELECT COALESCE(MAX(version), 0) as max_version
      FROM memory_evolution
      WHERE memory_id = ?
    `).get(memoryId) as { max_version: number } | null;

    const nextVersion = (versionRow?.max_version || 0) + 1;

    // Perform transactional update
    const updateStmt = store.db.prepare(`
      UPDATE documents
      SET amem_keywords = ?,
          amem_tags = ?,
          amem_context = ?
      WHERE id = ?
    `);

    // Stamped with this version's writer (62.2): an unstamped entry after the upgrade marks an older writer.
    // 82.3 D7 (ruling 56 A): previous_context is a copy of the stored context — bound as its bytes (`?T`)
    const historySql = `
      INSERT INTO memory_evolution (
        memory_id,
        triggered_by,
        version,
        previous_keywords,
        new_keywords,
        previous_context,
        new_context,
        reasoning,
        writer
      ) VALUES (?, ?, ?, ?, ?, ?T, ?, ?, '${EVOLUTION_WRITER}')
    `;

    // 82.3 D7: the context and the reasoning are normalised fields (model output): no leading byte-order mark.
    const newContext = stripLeadingMarks(evolution.new_context);
    try {
      store.db.exec("BEGIN TRANSACTION");

      updateStmt.run(
        JSON.stringify(evolution.new_keywords),
        JSON.stringify(evolution.new_tags),
        newContext,
        memoryId
      );

      runExact(store.db, historySql, [
        memoryId,
        triggeredBy,
        nextVersion,
        memory.amem_keywords,
        JSON.stringify(evolution.new_keywords),
        memory.amem_context,
        newContext,
        stripLeadingMarks(evolution.reasoning),
      ]);

      store.db.exec("COMMIT");
      console.log(`[amem] Evolved memory ${memoryId} to version ${nextVersion}`);
      return true;
    } catch (err) {
      store.db.exec("ROLLBACK");
      console.log(`[amem] Transaction failed for memory ${memoryId}:`, err);
      return false;
    }
  } catch (err) {
    console.log(`[amem] Error evolving memory ${memoryId}:`, err);
    return false;
  }
}

/**
 * Post-index enrichment orchestrator.
 * Runs A-MEM processing after document indexing.
 *
 * For new documents:
 *   - Construct memory note
 *   - Generate memory links
 *   - Evolve memories based on new evidence
 *
 * For updated documents:
 *   - Refresh memory note only (skip links/evolution to avoid churn)
 *
 * All operations are non-fatal and gated by CLAWMEM_ENABLE_AMEM feature flag.
 *
 * @param store - Store instance
 * @param llm - LLM instance
 * @param docId - Document numeric ID
 * @param isNew - True if this is a new document, false if update
 */
/**
 * Outcome of one post-index enrichment attempt. The metric is the NOTE WRITE
 * — the one phase every enrichment attempt runs — and callers label it as
 * such ("✎stored/attempted notes"), never as whole-pipeline success (codex
 * turn-2 finding 1). "stored" means the note was durably written, and holds
 * even when a LATER phase (entities/links/evolution) fails — those failures
 * keep their own log lines. "empty" means the note phase produced nothing
 * usable (outage, squatted endpoint, refused empty note) — the state issue
 * #24 showed can persist invisibly, so callers aggregate these into the
 * update summary instead of letting per-doc log lines be the only trace.
 * "error" is reserved for a failure BEFORE a note could be stored.
 */
export type EnrichOutcome = "stored" | "empty" | "disabled" | "error";

export async function postIndexEnrich(
  store: Store,
  llm: LlamaCpp,
  docId: number,
  isNew: boolean
): Promise<EnrichOutcome> {
  // Hoisted so the outer catch can report a durably-stored note as "stored"
  // even when a later phase throws — the metric describes the note write.
  let noteStored = false;
  try {
    // Check feature flag
    if (Bun.env.CLAWMEM_ENABLE_AMEM === 'false') {
      return "disabled";
    }

    console.log(`[amem] Starting enrichment for docId ${docId} (isNew=${isNew})`);

    // Step 1: Construct and store memory note (always attempted)
    const note = await constructMemoryNote(store, llm, docId);
    // §55.6 D8.2: report what actually happened. An empty note is refused, and saying
    // "Completed note refresh" after a refused write is how a silent inference outage used to
    // read as success in the logs.
    noteStored = storeMemoryNote(store, docId, note);
    if (!noteStored) {
      // "note phase", not "enrichment": for new documents the entity and link
      // phases still run below and can succeed — the note-write metric must
      // not be narrated as whole-pipeline failure (codex turn-3 finding 1).
      console.log(`[amem] No note stored for docId ${docId} (note phase produced nothing — existing note, if any, left intact)`);
    }

    // For updated documents, stop here to avoid churn
    if (!isNew) {
      console.log(
        noteStored
          ? `[amem] Completed note refresh for docId ${docId}`
          : `[amem] Note refresh for docId ${docId} made no change`,
      );
      return noteStored ? "stored" : "empty";
    }

    // Step 2: Entity extraction + resolution + co-occurrence (new documents only)
    try {
      const entityCount = await enrichDocumentEntities(store.db, llm, docId);
      if (entityCount > 0) {
        console.log(`[amem] Resolved ${entityCount} entities for docId ${docId}`);
      }
    } catch (err) {
      console.log(`[amem] Entity enrichment failed for docId ${docId}:`, err);
    }

    // Step 3: Generate memory links (new documents only)
    const linksCreated = await generateMemoryLinks(store, llm, docId);
    console.log(`[amem] Created ${linksCreated} links for docId ${docId}`);

    // Step 4: Evolve memories based on new evidence (new documents only)
    // The new document triggers evolution of its linked neighbors
    if (linksCreated > 0) {
      // Get neighbors this new document links to (outbound links from generateMemoryLinks)
      const neighbors = store.db.prepare(`
        SELECT DISTINCT target_id
        FROM memory_relations
        WHERE source_id = ?
      `).all(docId) as Array<{ target_id: number }>;

      for (const neighbor of neighbors) {
        await evolveMemories(store, llm, neighbor.target_id, docId);
      }
    }

    console.log(`[amem] Completed full enrichment for docId ${docId}`);
    return noteStored ? "stored" : "empty";
  } catch (err) {
    console.log(`[amem] Error in postIndexEnrich for docId ${docId}:`, err);
    // A stored note stays "stored": the metric is the note write, and a
    // later-phase failure must not erase a durable write from the count
    // (codex turn-2 finding 1). "error" = nothing was stored before the throw.
    return noteStored ? "stored" : "error";
  }
}

/**
 * Observation with document ID for causal inference and SPO triple extraction.
 *
 * Populated by the decision-extractor hook after an observation is successfully
 * persisted. Consumed by:
 *   - `runCausalStep` (causal-writer) — uses docId + facts
 *   - `insertObservationTriples` (decision-extractor) — uses docId + obsType + triples
 */
export interface ObservationWithDoc {
  docId: number;
  facts: string[];
  obsType?: string;
  triples?: Array<{ subject: string; predicate: string; object: string }>;
}
