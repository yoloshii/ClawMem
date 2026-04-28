/**
 * A-MEM: Self-Evolving Memory System
 *
 * Constructs memory notes, generates typed links, and tracks memory evolution.
 * All operations are non-fatal and log errors with [amem] prefix.
 */

import type { Database } from "bun:sqlite";
import type { LlamaCpp } from "./llm.ts";
import type { Store } from "./store.ts";
import { enrichDocumentEntities } from "./entity.ts";

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
    // Get document info
    const doc = store.db.prepare(`
      SELECT d.collection, d.path, d.title, c.doc as body
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.id = ? AND d.active = 1
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

    const result = await llm.generate(prompt, {
      temperature: 0.3,
      maxTokens: 300,
    });

    if (!result) {
      console.log(`[amem] LLM returned null for docId ${docId}`);
      return EMPTY_NOTE;
    }

    const parsed = parseMemoryNoteFromLLM(result.text);

    if (!parsed) {
      console.log(`[amem] RAW memory note output for docId ${docId}:`);
      console.log(result.text);
      console.log(`[amem] Invalid/unparseable JSON for docId ${docId}`);
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
 * Store memory note in the documents table.
 * Updates amem_keywords, amem_tags, and amem_context columns.
 *
 * @param store - Store instance
 * @param docId - Document numeric ID
 * @param note - Memory note to store
 */
export function storeMemoryNote(
  store: Store,
  docId: number,
  note: MemoryNote
): void {
  try {
    store.db.prepare(`
      UPDATE documents
      SET amem_keywords = ?,
          amem_tags = ?,
          amem_context = ?
      WHERE id = ?
    `).run(
      JSON.stringify(note.keywords),
      JSON.stringify(note.tags),
      note.context,
      docId
    );
  } catch (err) {
    console.log(`[amem] Error storing memory note for docId ${docId}:`, err);
  }
}

export interface MemoryLink {
  target_id: number;
  link_type: 'semantic' | 'supporting' | 'contradicts';
  confidence: number;
  reasoning: string;
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
    // Get source document info
    const sourceDoc = store.db.prepare(`
      SELECT d.id, d.hash, d.title, d.collection, d.path, d.amem_context
      FROM documents d
      WHERE d.id = ? AND d.active = 1
    `).get(docId) as { id: number; hash: string; title: string; collection: string; path: string; amem_context: string | null } | null;

    if (!sourceDoc) {
      console.log(`[amem] Source document ${docId} not found or inactive`);
      return 0;
    }

    // Find k-nearest neighbors using vector similarity
    const neighbors = store.db.prepare(`
      SELECT
        d2.id as target_id,
        d2.title as target_title,
        d2.amem_context as target_context,
        vec_distance_cosine(v1.embedding, v2.embedding) as distance
      FROM vectors_vec v1, vectors_vec v2
      JOIN documents d2 ON v2.hash_seq = d2.hash || '_0'
      WHERE v1.hash_seq = ? || '_0'
        AND d2.id != ?
        AND d2.active = 1
      ORDER BY distance
      LIMIT ?
    `).all(sourceDoc.hash, sourceDoc.id, kNeighbors) as {
      target_id: number;
      target_title: string;
      target_context: string | null;
      distance: number;
    }[];

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

    const result = await llm.generate(prompt, {
      temperature: 0.3,
      maxTokens: 500,
    });

    if (!result) {
      console.log(`[amem] LLM returned null for link generation docId ${docId}`);
      return 0;
    }

    const parsed = parseLinkGenerationFromLLM(result.text);

    if (!parsed) {
      console.log(`[amem] RAW link generation output for docId ${docId}:`);
      console.log(result.text);
      console.log(`[amem] Invalid/unparseable JSON for link generation docId ${docId}`);
      return 0;
    }


    // Insert links into memory_relations
    let linksCreated = 0;
    const now = new Date().toISOString();
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
  try {
    // Get current memory state
    const memory = store.db.prepare(`
      SELECT id, title, amem_keywords, amem_tags, amem_context
      FROM documents
      WHERE id = ? AND active = 1
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
        mr.weight
      FROM memory_relations mr
      JOIN documents d ON d.id = mr.target_id
      WHERE mr.source_id = ?
        AND d.active = 1
        AND d.amem_context IS NOT NULL
      ORDER BY mr.weight DESC
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

    const result = await llm.generate(prompt, {
      temperature: 0.4,
      maxTokens: 400,
    });

    if (!result) {
      console.log(`[amem] LLM returned null for evolution of memory ${memoryId}`);
      return false;
    }

    const evolution = extractJsonFromLLM(result.text) as MemoryEvolution | null;

    if (!evolution || typeof evolution.should_evolve !== 'boolean') {
      console.log(`[amem] Invalid evolution JSON for memory ${memoryId}`);
      return false;
    }

    if (!evolution.should_evolve) {
      console.log(`[amem] No evolution needed for memory ${memoryId}`);
      return false;
    }

    // Validate evolution data
    if (!Array.isArray(evolution.new_keywords) ||
        !Array.isArray(evolution.new_tags) ||
        typeof evolution.new_context !== 'string' ||
        typeof evolution.reasoning !== 'string') {
      console.log(`[amem] Invalid evolution data for memory ${memoryId}`);
      return false;
    }

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

    const historyStmt = store.db.prepare(`
      INSERT INTO memory_evolution (
        memory_id,
        triggered_by,
        version,
        previous_keywords,
        new_keywords,
        previous_context,
        new_context,
        reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      store.db.exec("BEGIN TRANSACTION");

      updateStmt.run(
        JSON.stringify(evolution.new_keywords),
        JSON.stringify(evolution.new_tags),
        evolution.new_context,
        memoryId
      );

      historyStmt.run(
        memoryId,
        triggeredBy,
        nextVersion,
        memory.amem_keywords,
        JSON.stringify(evolution.new_keywords),
        memory.amem_context,
        evolution.new_context,
        evolution.reasoning
      );

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
export async function postIndexEnrich(
  store: Store,
  llm: LlamaCpp,
  docId: number,
  isNew: boolean
): Promise<void> {
  try {
    // Check feature flag
    if (Bun.env.CLAWMEM_ENABLE_AMEM === 'false') {
      return;
    }

    console.log(`[amem] Starting enrichment for docId ${docId} (isNew=${isNew})`);

    // Step 1: Construct and store memory note (always)
    const note = await constructMemoryNote(store, llm, docId);
    storeMemoryNote(store, docId, note);

    // For updated documents, stop here to avoid churn
    if (!isNew) {
      console.log(`[amem] Completed note refresh for docId ${docId}`);
      return;
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
  } catch (err) {
    console.log(`[amem] Error in postIndexEnrich for docId ${docId}:`, err);
  }
}

/**
 * Observation with document ID for causal inference and SPO triple extraction.
 *
 * Populated by the decision-extractor hook after an observation is successfully
 * persisted. Consumed by:
 *   - `inferCausalLinks` (A-MEM) — uses docId + facts
 *   - `insertObservationTriples` (decision-extractor) — uses docId + obsType + triples
 */
export interface ObservationWithDoc {
  docId: number;
  facts: string[];
  obsType?: string;
  triples?: Array<{ subject: string; predicate: string; object: string }>;
}

/**
 * Causal link identified by LLM
 */
interface CausalLink {
  source_fact_idx: number;
  target_fact_idx: number;
  confidence: number;
  reasoning: string;
}

/**
 * Infer causal relationships between facts from observations.
 * Analyzes facts using LLM and creates causal edges in memory_relations.
 *
 * @param store - Store instance
 * @param llm - LLM instance
 * @param observations - Array of observations with docId and facts
 * @returns Number of causal links created
 */
export async function inferCausalLinks(
  store: Store,
  llm: LlamaCpp,
  observations: ObservationWithDoc[]
): Promise<number> {
  try {
    // Build flat list of facts with source document mapping
    const factMap: Array<{ fact: string; docId: number }> = [];
    for (const obs of observations) {
      for (const fact of obs.facts) {
        factMap.push({ fact, docId: obs.docId });
      }
    }

    // Need at least 2 facts to infer causality
    if (factMap.length < 2) {
      console.log(`[amem] Insufficient facts (${factMap.length}) for causal inference`);
      return 0;
    }

    console.log(`[amem] Inferring causal links from ${factMap.length} facts across ${observations.length} observations`);

    // Build LLM prompt
    const factsText = factMap.map((f, idx) =>
      `${idx}. ${f.fact}`
    ).join('\n');

    const prompt = `Analyze the following facts from a session and identify causal relationships.

Facts:
${factsText}

Identify cause-effect relationships where one fact directly or indirectly caused another.
Consider:
- Temporal ordering (causes precede effects)
- Logical dependencies (one fact enables or triggers another)
- Problem-solution patterns (a discovery leads to an action)

Return ONLY valid JSON array in this exact format:
[
  {
    "source_fact_idx": 0,
    "target_fact_idx": 2,
    "confidence": 0.85,
    "reasoning": "Brief explanation of causal relationship"
  },
  {
    "source_fact_idx": 1,
    "target_fact_idx": 3,
    "confidence": 0.72,
    "reasoning": "Brief explanation of causal relationship"
  }
]

Only include relationships with confidence >= 0.6. Return empty array [] if no causal relationships found.`;

    const result = await llm.generate(prompt, {
      temperature: 0.3,
      maxTokens: 600,
    });

    if (!result) {
      console.log(`[amem] LLM returned null for causal inference`);
      return 0;
    }

    const links = extractJsonFromLLM(result.text) as CausalLink[] | null;

    if (!Array.isArray(links)) {
      console.log(`[amem] Invalid JSON for causal inference (not an array)`);
      return 0;
    }

    // Filter by confidence threshold and insert causal links
    let linksCreated = 0;
    const timestamp = new Date().toISOString();
    const insertStmt = store.db.prepare(`
      INSERT OR IGNORE INTO memory_relations (
        source_id, target_id, relation_type, weight, metadata, created_at
      ) VALUES (?, ?, 'causal', ?, ?, ?)
    `);

    for (const link of links) {
      // Validate link structure
      if (typeof link.source_fact_idx !== 'number' ||
          typeof link.target_fact_idx !== 'number' ||
          typeof link.confidence !== 'number' ||
          typeof link.reasoning !== 'string') {
        console.log(`[amem] Invalid causal link structure, skipping`);
        continue;
      }

      // Filter by confidence threshold
      if (link.confidence < 0.6) {
        continue;
      }

      // Validate indices
      if (link.source_fact_idx < 0 || link.source_fact_idx >= factMap.length ||
          link.target_fact_idx < 0 || link.target_fact_idx >= factMap.length) {
        console.log(`[amem] Invalid fact indices: ${link.source_fact_idx} -> ${link.target_fact_idx}`);
        continue;
      }

      // Get document IDs (bounds already validated above)
      const sourceEntry = factMap[link.source_fact_idx]!;
      const targetEntry = factMap[link.target_fact_idx]!;

      // Skip self-links (same document)
      if (sourceEntry.docId === targetEntry.docId) {
        continue;
      }

      // Insert causal relation
      const metadata = JSON.stringify({
        reasoning: link.reasoning,
        source_fact: sourceEntry.fact,
        target_fact: targetEntry.fact,
      });

      insertStmt.run(sourceEntry.docId, targetEntry.docId, link.confidence, metadata, timestamp);
      linksCreated++;
    }

    console.log(`[amem] Created ${linksCreated} causal links from ${links.length} identified relationships`);
    return linksCreated;
  } catch (err) {
    console.log(`[amem] Error in inferCausalLinks:`, err);
    return 0;
  }
}
