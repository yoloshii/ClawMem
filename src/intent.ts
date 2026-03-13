/**
 * Intent Classification for MAGMA Multi-Graph Memory
 *
 * Classifies queries into intent types to route to appropriate graph structures:
 * - WHY: Causal reasoning (use causal graph)
 * - WHEN: Temporal queries (use temporal graph)
 * - ENTITY: Entity-focused (use entity graph)
 * - WHAT: General factual (balanced approach)
 */

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import type { LlamaCpp } from "./llm.ts";

export type IntentType = 'WHY' | 'WHEN' | 'ENTITY' | 'WHAT';

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  temporal_start?: string;
  temporal_end?: string;
}

// Heuristic patterns for fast classification (no LLM needed)
const WHY_PATTERNS = /\b(why|cause[ds]?|because|reason|led to|result(?:ed)? (?:in|from)|depend|block|chose|decision|trade-?off|instead of)\b/i;
const WHEN_PATTERNS = /\b(when|timeline|chronolog|date|yesterday|last (?:week|month|year|night)|ago|before \d|after \d|(?:in|since|during|until) (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}))\b/i;
const ENTITY_PATTERNS = /\b(who|person|team|project|(?:@|#)\w+|relationship|mention|organization|company)\b/i;

// Temporal extraction patterns
type TemporalExtractor = (now: Date, match?: RegExpMatchArray) => { start?: string; end?: string };

const TEMPORAL_RELATIVE: [RegExp, TemporalExtractor][] = [
  [/\blast week\b/i, (now: Date) => {
    const s = new Date(now); s.setDate(s.getDate() - 7);
    return { start: s.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
  }],
  [/\blast month\b/i, (now: Date) => {
    const s = new Date(now); s.setMonth(s.getMonth() - 1);
    return { start: s.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
  }],
  [/\byesterday\b/i, (now: Date) => {
    const s = new Date(now); s.setDate(s.getDate() - 1);
    return { start: s.toISOString().slice(0, 10), end: s.toISOString().slice(0, 10) };
  }],
  [/\b(\d+)\s*days?\s*ago\b/i, (now: Date, m?: RegExpMatchArray) => {
    const s = new Date(now); s.setDate(s.getDate() - parseInt(m?.[1] ?? "1"));
    return { start: s.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
  }],
  [/\bin\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{4})?\b/i, (_now: Date, m?: RegExpMatchArray) => {
    const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mo = months[(m?.[1] ?? "jan").slice(0, 3).toLowerCase()] ?? 0;
    const yr = m?.[2] ? parseInt(m[2]) : new Date().getFullYear();
    const s = new Date(yr, mo, 1);
    const e = new Date(yr, mo + 1, 0);
    return { start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) };
  }],
];

/**
 * Fast heuristic intent classification (no LLM, instant).
 */
function classifyIntentHeuristic(query: string): IntentResult {
  const q = query.toLowerCase();

  // Extract temporal info
  let temporal_start: string | undefined;
  let temporal_end: string | undefined;
  const now = new Date();
  for (const [pattern, extractor] of TEMPORAL_RELATIVE) {
    const match = q.match(pattern);
    if (match) {
      const result = extractor(now, match);
      temporal_start = result.start;
      temporal_end = result.end;
      break;
    }
  }

  // Score each intent
  const scores: Record<IntentType, number> = { WHY: 0, WHEN: 0, ENTITY: 0, WHAT: 0 };

  if (WHY_PATTERNS.test(q)) scores.WHY += 3;
  if (WHEN_PATTERNS.test(q)) scores.WHEN += 3;
  if (ENTITY_PATTERNS.test(q)) scores.ENTITY += 3;
  if (temporal_start) scores.WHEN += 2;
  if (/^why\b/i.test(q)) scores.WHY += 2;
  if (/^when\b/i.test(q)) scores.WHEN += 2;
  if (/^who\b/i.test(q)) scores.ENTITY += 2;

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) {
    return { intent: 'WHAT', confidence: 0.6, temporal_start, temporal_end };
  }

  const intent = (Object.entries(scores) as [IntentType, number][])
    .sort((a, b) => b[1] - a[1])[0]![0];
  const confidence = Math.min(0.95, 0.6 + maxScore * 0.1);

  return { intent, confidence, temporal_start, temporal_end };
}

/**
 * Classify query intent using heuristics (fast) with optional LLM refinement.
 * Results are cached for 1 hour.
 */
export async function classifyIntent(
  query: string,
  llm: LlamaCpp,
  db: Database
): Promise<IntentResult> {
  // Check cache first (1 hour TTL)
  const queryHash = createHash('sha256').update(query).digest('hex');
  const cached = db.prepare(`
    SELECT intent, confidence, temporal_start, temporal_end
    FROM intent_classifications
    WHERE query_hash = ? AND cached_at > datetime('now', '-1 hour')
  `).get(queryHash) as IntentResult | undefined;

  if (cached) return cached;

  // Fast heuristic classification (instant, no LLM)
  const heuristic = classifyIntentHeuristic(query);

  // If heuristic is confident (score >= 0.8), use it directly
  if (heuristic.confidence >= 0.8) {
    cacheIntent(db, queryHash, query, heuristic);
    return heuristic;
  }

  // Try LLM refinement for ambiguous cases
  const prompt = `Classify intent of this query as one word: WHY, WHEN, ENTITY, or WHAT.
Query: "${query}"
Intent:`;

  try {
    const result = await llm.generate(prompt, {
      maxTokens: 10,
      temperature: 0.0,
    });

    if (result) {
      const text = result.text.trim().toUpperCase();
      const match = text.match(/\b(WHY|WHEN|ENTITY|WHAT)\b/);
      if (match) {
        const refined: IntentResult = {
          intent: match[1] as IntentType,
          confidence: 0.85,
          temporal_start: heuristic.temporal_start,
          temporal_end: heuristic.temporal_end,
        };
        cacheIntent(db, queryHash, query, refined);
        return refined;
      }
    }
  } catch {
    // LLM failed — use heuristic result
  }

  cacheIntent(db, queryHash, query, heuristic);
  return heuristic;
}

function cacheIntent(db: Database, queryHash: string, query: string, result: IntentResult): void {
  db.prepare(`
    INSERT OR REPLACE INTO intent_classifications (
      query_hash, query_text, intent, confidence, temporal_start, temporal_end, cached_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    queryHash,
    query,
    result.intent,
    result.confidence,
    result.temporal_start || null,
    result.temporal_end || null,
    new Date().toISOString()
  );
}

// =============================================================================
// Query Decomposition (OpenViking-inspired QueryPlan)
// =============================================================================

export type QueryClause = {
  type: 'bm25' | 'vector' | 'graph';
  query: string;
  collections?: string[];
  priority: 1 | 2 | 3 | 4 | 5;
};

/**
 * Decompose a complex query into multiple typed retrieval clauses.
 * Uses heuristics first, LLM only for genuinely ambiguous multi-topic queries.
 * Graph-first, planner-second design (per GPT 5.4 validation).
 */
export async function decomposeQuery(
  query: string,
  llm: LlamaCpp,
  db: Database,
  sessionContext?: string
): Promise<QueryClause[]> {
  // Short queries still need intent classification — "why did this fail?" is 4 words but needs graph
  const words = query.split(/\s+/).filter(w => w.length > 2);
  if (words.length <= 5) {
    const intent = await classifyIntent(query, llm, db);
    const type = intent.intent === 'WHY' || intent.intent === 'ENTITY' ? 'graph' : 'bm25';
    return [
      { type, query, priority: 1 },
      { type: 'vector', query, priority: 3 },
    ];
  }

  // Heuristic: detect multi-topic queries (conjunctions, "and also", multiple questions)
  const multiTopicSignals = [
    /\band\s+(?:also|what|how|why)\b/i,
    /\bboth\s+.+\s+and\s+/i,
    /\?.*\?/,
    /\b(?:plus|additionally|as well as|along with)\b/i,
  ];
  const isMultiTopic = multiTopicSignals.some(p => p.test(query));

  if (!isMultiTopic) {
    // Single-topic: classify intent and route appropriately
    const intent = await classifyIntent(query, llm, db);
    const type = intent.intent === 'WHY' || intent.intent === 'ENTITY' ? 'graph' : 'bm25';
    return [
      { type, query, priority: 1 },
      { type: 'vector', query, priority: 3 },
    ];
  }

  // Multi-topic: use LLM to decompose
  const contextBlock = sessionContext ? `\nSession context: ${sessionContext.slice(0, 300)}` : '';
  const prompt = `Decompose this query into 2-4 retrieval sub-queries. Each should target one specific topic.
${contextBlock}
Query: "${query}"

Return JSON array: [{"query": "sub-query text", "type": "bm25|vector|graph", "priority": 1-5}]
Rules:
- type "graph" for causal/entity questions (why, who, relationships)
- type "bm25" for keyword-specific factual lookups
- type "vector" for conceptual/fuzzy similarity
- priority 1 = most important, 5 = least
Return ONLY the JSON array. /no_think`;

  try {
    const result = await llm.generate(prompt, { temperature: 0.3, maxTokens: 300 });
    if (result) {
      const text = result.text.trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as QueryClause[];
        if (Array.isArray(parsed) && parsed.length >= 1 && parsed.length <= 4) {
          return parsed
            .filter(c => c.query && c.type && c.priority)
            .map(c => ({
              type: ['bm25', 'vector', 'graph'].includes(c.type) ? c.type : 'bm25',
              query: c.query,
              collections: c.collections,
              priority: Math.min(5, Math.max(1, c.priority)) as 1 | 2 | 3 | 4 | 5,
            }));
        }
      }
    }
  } catch {
    // LLM failed — fallback to dual-mode
  }

  // Fallback: dual-mode search on original query
  return [
    { type: 'bm25', query, priority: 1 },
    { type: 'vector', query, priority: 2 },
  ];
}

/**
 * Get intent-specific weights for graph traversal.
 */
export function getIntentWeights(intent: IntentType): {
  causal: number;
  semantic: number;
  temporal: number;
  entity: number;
} {
  switch (intent) {
    case 'WHY':
      return { causal: 5.0, semantic: 2.0, temporal: 0.5, entity: 1.0 };
    case 'WHEN':
      return { temporal: 5.0, semantic: 2.0, causal: 1.0, entity: 0.5 };
    case 'ENTITY':
      return { entity: 6.0, semantic: 3.0, temporal: 1.0, causal: 2.0 };
    case 'WHAT':
      return { semantic: 5.0, entity: 2.0, temporal: 1.0, causal: 1.0 };
  }
}
