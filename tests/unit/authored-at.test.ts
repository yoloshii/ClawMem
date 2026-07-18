import { describe, it, expect, beforeAll, afterAll } from "bun:test";

/**
 * §51.1 authored_at — authorship time vs filing time (design v6, codex-cleared).
 *
 * Covers the in-process D14 groups: strict timestamp adapters (D3), per-parser
 * capture, exchange-max chunk policy with the anti-fallback pin (D4), the
 * frontmatter adapter incl. quoting-independent date-only (D5), null-safe
 * monotonic saveMemory advancement on both branches (D6), synthesis
 * inheritance via the param (D7), effective-time scoring with the backfill
 * sentinel on filing time (D8), temporal predicates on COALESCE (§3), the
 * getDocumentsByType time-axis option (D13), raw-route group invariants with
 * authored-aware exact-tie ordering (D12), and the indexer's dated-only
 * transition + unchanged-row adoption + authoritative clearing (D11/D5).
 * The mine/backfill CLI lane lives in authored-at-cli.test.ts.
 */

import { unlinkSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { createStore, canonicalDocId, type Store } from "../../src/store.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";
import {
  normalizeIsoTimestamp,
  epochSecondsToIso,
  normalizeFile,
  chunkConversation,
  type NormalizedConversation,
} from "../../src/normalize.ts";
import {
  authoredAtFromFrontmatter,
  parseDocument,
  indexCollection,
  hashContent,
} from "../../src/indexer.ts";
import { applyCompositeScoring, confidenceScore, type EnrichedResult } from "../../src/memory.ts";
import { rankRawPrimary } from "../../src/scoring-regime.ts";
import { postcompactInject } from "../../src/hooks/postcompact-inject.ts";
import { sessionBootstrap } from "../../src/hooks/session-bootstrap.ts";
import { buildDynamicProfile, buildStaticProfile, isProfileStale } from "../../src/profile.ts";
import { generateDirectoryBlock, getDecisionsForDirectory } from "../../src/directory-context.ts";
import { createEvalSession } from "../../src/eval/replay.ts";
import type { DocumentRow } from "../../src/store.ts";

const TEST_DB = "/tmp/clawmem-authored-at-test.sqlite";
const TMP = `/tmp/clawmem-authored-at-fixtures-${Date.now()}`;
const MODEL = "authored-fake";

function fakeVec(text: string): Float32Array {
  const j = (createHash("sha256").update(text).digest()[0]! / 255) * 0.2;
  return new Float32Array([j, 0.1, 1, 0]);
}
// generate is a spy: A-MEM enrichment attempts call it, so its call count is a
// direct observable for "enrichment was (not) enqueued" (D11). Returns non-JSON
// so enrichment always fails open without creating notes.
let generateCalls = 0;
const fakeLlm = {
  embed: async (text: string) => ({ embedding: fakeVec(text), model: MODEL }),
  query: async () => null,
  generate: async () => { generateCalls++; return "not json"; },
  expandQuery: async () => [],
} as any;

let store: Store;

function seedDoc(
  col: string,
  path: string,
  body: string,
  opts?: { contentType?: string; modifiedAt?: string; authoredAt?: string | null }
): number {
  const hash = hashContent(body + col + path);
  const now = new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument(col, path, path, hash, now, opts?.modifiedAt ?? now);
  const row = store.db.prepare(`SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1`)
    .get(col, path) as { id: number };
  if (opts?.contentType) store.updateDocumentMeta(row.id, { content_type: opts.contentType });
  if (opts?.authoredAt !== undefined) store.updateDocumentMeta(row.id, { authored_at: opts.authoredAt });
  store.markEmbedSynced(hash);
  return row.id;
}

function writeTemp(rel: string, content: string): string {
  const p = join(TMP, rel);
  writeFileSync(p, content);
  return p;
}

beforeAll(() => {
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  Bun.env.INDEX_PATH = TEST_DB;
  mkdirSync(TMP, { recursive: true });
  setDefaultLlamaCpp(fakeLlm);
  store = createStore();
});

afterAll(() => {
  try { store?.close(); } catch { /* already closed */ }
  try { unlinkSync(TEST_DB); } catch { /* absent */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* absent */ }
});

// ─── D3: strict timestamp adapters ─────────────────────────────────

describe("normalizeIsoTimestamp (D3 strict RFC3339)", () => {
  it("accepts Z-suffixed timestamps and normalizes to UTC ISO", () => {
    expect(normalizeIsoTimestamp("2025-03-01T12:30:45Z")).toBe("2025-03-01T12:30:45.000Z");
  });

  it("accepts numeric offsets and applies them (valid +10:00 input must NOT be rejected)", () => {
    // The wall-clock components are validated as written, THEN the offset applies:
    // 12:00+10:00 legitimately normalizes to 02:00Z.
    expect(normalizeIsoTimestamp("2025-01-01T12:00:00+10:00")).toBe("2025-01-01T02:00:00.000Z");
  });

  it("accepts fractional seconds and lowercase t/z", () => {
    expect(normalizeIsoTimestamp("2025-03-01t06:00:00.250z")).toBe("2025-03-01T06:00:00.250Z");
  });

  it("REJECTS timezone-less values (never host-timezone-interpreted)", () => {
    expect(normalizeIsoTimestamp("2025-03-01T12:30:45")).toBeNull();
  });

  it("REJECTS impossible calendar dates instead of normalizing them", () => {
    expect(normalizeIsoTimestamp("2025-02-30T00:00:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2025-13-01T00:00:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2025-04-31T00:00:00Z")).toBeNull();
  });

  it("accepts Feb 29 only in leap years", () => {
    expect(normalizeIsoTimestamp("2024-02-29T00:00:00Z")).toBe("2024-02-29T00:00:00.000Z");
    expect(normalizeIsoTimestamp("2025-02-29T00:00:00Z")).toBeNull();
  });

  it("rejects out-of-range time fields and offsets", () => {
    expect(normalizeIsoTimestamp("2025-03-01T24:00:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2025-03-01T12:60:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2025-03-01T12:00:00+25:00")).toBeNull();
  });

  it("rejects non-strings and garbage", () => {
    expect(normalizeIsoTimestamp(1234567890)).toBeNull();
    expect(normalizeIsoTimestamp(null)).toBeNull();
    expect(normalizeIsoTimestamp("yesterday")).toBeNull();
    expect(normalizeIsoTimestamp("")).toBeNull();
  });

  it("preserves years 0000-0099 literally (Date.UTC would map them to 1900-1999)", () => {
    expect(normalizeIsoTimestamp("0001-01-01T00:00:00Z")).toBe("0001-01-01T00:00:00.000Z");
    expect(normalizeIsoTimestamp("0099-12-31T23:59:59Z")).toBe("0099-12-31T23:59:59.000Z");
    // Year 0000 is divisible by 400 → leap; the mapped 1900 is NOT — Feb 29 must survive.
    expect(normalizeIsoTimestamp("0000-02-29T00:00:00Z")).toBe("0000-02-29T00:00:00.000Z");
  });
});

describe("epochSecondsToIso (D3 epoch adapters)", () => {
  it("converts epoch seconds", () => {
    expect(epochSecondsToIso(1700000000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("guards the Date range — finite input alone must not throw in toISOString", () => {
    expect(epochSecondsToIso(1e15)).toBeNull();
    expect(epochSecondsToIso(-1e15)).toBeNull();
  });

  it("rejects non-finite and non-number input", () => {
    expect(epochSecondsToIso(NaN)).toBeNull();
    expect(epochSecondsToIso(Infinity)).toBeNull();
    expect(epochSecondsToIso("1700000000" as any)).toBeNull();
  });
});

// ─── D3: per-parser capture ────────────────────────────────────────

describe("parser timestamp capture (D3)", () => {
  it("claude-code JSONL: per-line ISO timestamps captured; malformed omitted", () => {
    const jsonl = [
      JSON.stringify({ type: "human", timestamp: "2025-03-01T10:00:00Z", message: { content: "First question here" } }),
      JSON.stringify({ type: "assistant", timestamp: "2025-03-01T10:05:00Z", message: { content: "First answer here" } }),
      JSON.stringify({ type: "human", timestamp: "not-a-date", message: { content: "Second question here" } }),
      JSON.stringify({ type: "assistant", message: { content: "Second answer, no timestamp" } }),
    ].join("\n");
    const conv = normalizeFile(writeTemp("cc.jsonl", jsonl))!;
    expect(conv.format).toBe("claude-code");
    expect(conv.messages[0]!.timestamp).toBe("2025-03-01T10:00:00.000Z");
    expect(conv.messages[1]!.timestamp).toBe("2025-03-01T10:05:00.000Z");
    expect(conv.messages[2]!.timestamp).toBeUndefined();
    expect(conv.messages[3]!.timestamp).toBeUndefined();
  });

  it("chatgpt mapping: create_time epoch seconds converted; invalid omitted", () => {
    const mapping: any = {
      root: { parent: null, message: null, children: ["m1"] },
      m1: { parent: "root", children: ["m2"], message: { author: { role: "user" }, create_time: 1700000000.5, content: { parts: ["Question about widgets"] } } },
      m2: { parent: "m1", children: [], message: { author: { role: "assistant" }, create_time: "soon", content: { parts: ["Answer about widgets"] } } },
    };
    const conv = normalizeFile(writeTemp("cg.json", JSON.stringify({ mapping })))!;
    expect(conv.format).toBe("chatgpt");
    expect(conv.messages[0]!.timestamp).toBe("2023-11-14T22:13:20.500Z");
    expect(conv.messages[1]!.timestamp).toBeUndefined();
  });

  it("slack: ts epoch strings converted; wrong-shape rejected", () => {
    const data = [
      { type: "message", user: "U1", ts: "1700000000.000100", text: "hello from user one" },
      { type: "message", user: "U2", ts: "17000.5", text: "reply from user two" },
    ];
    const conv = normalizeFile(writeTemp("slack.json", JSON.stringify(data)))!;
    expect(conv.format).toBe("slack");
    expect(conv.messages[0]!.timestamp).toBe("2023-11-14T22:13:20.000Z");
    expect(conv.messages[1]!.timestamp).toBeUndefined();
  });

  it("plain text: never carries timestamps", () => {
    const txt = "User: alpha question\nAssistant: alpha answer\nUser: beta question\nAssistant: beta answer";
    const conv = normalizeFile(writeTemp("plain.txt", txt))!;
    expect(conv.format).toBe("plain-text");
    for (const m of conv.messages) expect(m.timestamp).toBeUndefined();
  });

  it("codex JSONL: per-line ISO timestamps captured; out-of-order and partial coverage preserved", () => {
    const jsonl = [
      JSON.stringify({ type: "session_meta", payload: {} }),
      JSON.stringify({ type: "event_msg", timestamp: "2025-06-02T10:00:00Z", payload: { type: "user_message", message: "codex user question body" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2025-06-01T10:00:00Z", payload: { type: "agent_message", message: "codex agent answer body (earlier clock)" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "codex second question, no timestamp" } }),
      JSON.stringify({ type: "event_msg", timestamp: "not a date", payload: { type: "agent_message", message: "codex second answer, bad timestamp" } }),
    ].join("\n");
    const conv = normalizeFile(writeTemp("codex.jsonl", jsonl))!;
    expect(conv.format).toBe("codex-cli");
    expect(conv.messages[0]!.timestamp).toBe("2025-06-02T10:00:00.000Z");
    expect(conv.messages[1]!.timestamp).toBe("2025-06-01T10:00:00.000Z");
    expect(conv.messages[2]!.timestamp).toBeUndefined();
    expect(conv.messages[3]!.timestamp).toBeUndefined();
    // Out-of-order timestamps: the exchange max still picks the later one.
    const chunks = chunkConversation(conv);
    expect(chunks[0]!.authoredAt).toBe("2025-06-02T10:00:00.000Z");
  });

  it("claude.ai JSON: per-message created_at captured in both privacy-export and flat shapes", () => {
    const privacy = [{
      chat_messages: [
        { role: "human", created_at: "2025-02-01T08:00:00Z", content: "privacy export question body" },
        { role: "assistant", created_at: "2025-02-01T08:04:00Z", content: "privacy export answer body" },
      ],
    }];
    const p = normalizeFile(writeTemp("claude-privacy.json", JSON.stringify(privacy)))!;
    expect(p.format).toBe("claude-ai");
    expect(p.messages[0]!.timestamp).toBe("2025-02-01T08:00:00.000Z");
    expect(p.messages[1]!.timestamp).toBe("2025-02-01T08:04:00.000Z");

    const flat = { messages: [
      { role: "user", created_at: "2025-02-02T08:00:00Z", content: "flat export question body" },
      { role: "assistant", content: "flat export answer body, undated" },
    ] };
    const f = normalizeFile(writeTemp("claude-flat.json", JSON.stringify(flat)))!;
    expect(f.format).toBe("claude-ai");
    expect(f.messages[0]!.timestamp).toBe("2025-02-02T08:00:00.000Z");
    expect(f.messages[1]!.timestamp).toBeUndefined();
  });
});

// ─── D4: exchange-max chunk policy ─────────────────────────────────

describe("chunkConversation authoredAt (D4)", () => {
  it("uses the max timestamp within the exchange (split assistant replies included)", () => {
    const conv: NormalizedConversation = {
      source: "s.jsonl", format: "claude-code",
      messages: [
        { role: "user", content: "long enough user question for the chunk", timestamp: "2025-03-01T10:00:00.000Z" },
        { role: "assistant", content: "part one of the answer", timestamp: "2025-03-01T10:05:00.000Z" },
        { role: "assistant", content: "part two of the answer", timestamp: "2025-03-01T10:09:00.000Z" },
      ],
    };
    const chunks = chunkConversation(conv);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.authoredAt).toBe("2025-03-01T10:09:00.000Z");
  });

  it("an exchange with NO timestamps stays null even when sibling exchanges are dated (anti-fallback pin)", () => {
    const conv: NormalizedConversation = {
      source: "s.jsonl", format: "claude-code",
      messages: [
        { role: "user", content: "dated exchange user message content", timestamp: "2025-03-01T10:00:00.000Z" },
        { role: "assistant", content: "dated exchange assistant reply", timestamp: "2025-03-01T10:05:00.000Z" },
        { role: "user", content: "undated exchange user message content" },
        { role: "assistant", content: "undated exchange assistant reply" },
      ],
    };
    const chunks = chunkConversation(conv);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.authoredAt).toBe("2025-03-01T10:05:00.000Z");
    expect(chunks[1]!.authoredAt).toBeNull();
  });
});

// ─── D5: frontmatter adapter ───────────────────────────────────────

describe("authoredAtFromFrontmatter (D5)", () => {
  it("accepts quoted RFC3339 strings", () => {
    expect(authoredAtFromFrontmatter("2025-03-01T10:00:00Z")).toBe("2025-03-01T10:00:00.000Z");
  });

  it("accepts date-only STRINGS as UTC midnight (quoting-independence)", () => {
    expect(authoredAtFromFrontmatter("2025-03-01")).toBe("2025-03-01T00:00:00.000Z");
  });

  it("accepts Date instances (gray-matter coercion) via finite-valid check", () => {
    expect(authoredAtFromFrontmatter(new Date("2025-03-01T00:00:00.000Z"))).toBe("2025-03-01T00:00:00.000Z");
    expect(authoredAtFromFrontmatter(new Date("invalid"))).toBeNull();
  });

  it("rejects timezone-less datetimes, impossible date-only values, and garbage", () => {
    expect(authoredAtFromFrontmatter("2025-03-01T10:00:00")).toBeNull();
    expect(authoredAtFromFrontmatter("2025-02-30")).toBeNull();
    expect(authoredAtFromFrontmatter(42)).toBeNull();
    expect(authoredAtFromFrontmatter(undefined)).toBeNull();
  });

  it("parseDocument: unquoted YAML date-only (Date coercion) and quoted string are equivalent", () => {
    const unquoted = parseDocument(`---\ntitle: T\nauthored_at: 2025-03-01\n---\nbody`, "a.md");
    const quoted = parseDocument(`---\ntitle: T\nauthored_at: "2025-03-01"\n---\nbody`, "a.md");
    expect(unquoted.meta.authored_at).toBe("2025-03-01T00:00:00.000Z");
    expect(quoted.meta.authored_at).toBe(unquoted.meta.authored_at);
  });

  it("parseDocument: absent or invalid authored_at parses to null (clears on the changed path)", () => {
    expect(parseDocument(`---\ntitle: T\n---\nbody`, "a.md").meta.authored_at).toBeNull();
    expect(parseDocument(`---\ntitle: T\nauthored_at: garbage\n---\nbody`, "a.md").meta.authored_at).toBeNull();
  });
});

// ─── D6: saveMemory null-safe monotonic advancement ────────────────

describe("saveMemory authoredAt (D6)", () => {
  const col = "d6";
  const base = { collection: col, contentType: "note", confidence: 0.6, qualityScore: 0.6 };
  const authoredOf = (docId: number): string | null =>
    (store.db.prepare(`SELECT authored_at FROM documents WHERE id = ?`).get(docId) as any).authored_at;

  it("insert sets authored_at; dedup branch advances monotonically and never regresses", () => {
    const first = store.saveMemory({ ...base, path: "mono.md", title: "Mono", body: "monotonic body", authoredAt: "2025-03-01T00:00:00.000Z" });
    expect(first.action).toBe("inserted");
    expect(authoredOf(first.docId)).toBe("2025-03-01T00:00:00.000Z");

    // Same content within the 30-min window → dedup; NEWER authorship advances.
    const newer = store.saveMemory({ ...base, path: "mono-2.md", title: "Mono", body: "monotonic body", authoredAt: "2025-04-01T00:00:00.000Z" });
    expect(newer.action).toBe("deduplicated");
    expect(newer.docId).toBe(first.docId);
    expect(authoredOf(first.docId)).toBe("2025-04-01T00:00:00.000Z");

    // OLDER authorship never regresses.
    const older = store.saveMemory({ ...base, path: "mono-3.md", title: "Mono", body: "monotonic body", authoredAt: "2024-01-01T00:00:00.000Z" });
    expect(older.action).toBe("deduplicated");
    expect(authoredOf(first.docId)).toBe("2025-04-01T00:00:00.000Z");

    // Absent incoming leaves the column untouched.
    const absent = store.saveMemory({ ...base, path: "mono-4.md", title: "Mono", body: "monotonic body" });
    expect(absent.action).toBe("deduplicated");
    expect(authoredOf(first.docId)).toBe("2025-04-01T00:00:00.000Z");
  });

  it("dedup branch POPULATES an initially-NULL row (MAX(NULL, x) would not)", () => {
    const first = store.saveMemory({ ...base, path: "nullpop.md", title: "NullPop", body: "null population body" });
    expect(first.action).toBe("inserted");
    expect(authoredOf(first.docId)).toBeNull();
    store.saveMemory({ ...base, path: "nullpop-2.md", title: "NullPop", body: "null population body", authoredAt: "2025-05-01T00:00:00.000Z" });
    expect(authoredOf(first.docId)).toBe("2025-05-01T00:00:00.000Z");
  });

  it("path-conflict update branch applies the same monotonic rule", () => {
    const first = store.saveMemory({ ...base, path: "conflict.md", title: "V1", body: "conflict body v1", authoredAt: "2025-03-01T00:00:00.000Z" });
    expect(first.action).toBe("inserted");
    // Same path, different content (different normalized hash) → UNIQUE-conflict update.
    const upd = store.saveMemory({ ...base, path: "conflict.md", title: "V2", body: "conflict body v2 changed", authoredAt: "2025-06-01T00:00:00.000Z" });
    expect(upd.action).toBe("updated");
    expect(authoredOf(first.docId)).toBe("2025-06-01T00:00:00.000Z");
    const upd2 = store.saveMemory({ ...base, path: "conflict.md", title: "V3", body: "conflict body v3 changed again", authoredAt: "2024-06-01T00:00:00.000Z" });
    expect(upd2.action).toBe("updated");
    expect(authoredOf(first.docId)).toBe("2025-06-01T00:00:00.000Z");
  });

  it("invalid authoredAt is treated as absent; the dedup window itself still keys on created_at", () => {
    const first = store.saveMemory({ ...base, path: "invalid.md", title: "Inv", body: "invalid input body", authoredAt: "2025-02-30T00:00:00Z" });
    expect(first.action).toBe("inserted");
    expect(authoredOf(first.docId)).toBeNull();
    // Different authoredAt must NOT defeat the dedup window (created_at-keyed).
    const dedup = store.saveMemory({ ...base, path: "invalid-2.md", title: "Inv", body: "invalid input body", authoredAt: "2020-01-01T00:00:00.000Z" });
    expect(dedup.action).toBe("deduplicated");
  });
});

// ─── D8: effective-time scoring ────────────────────────────────────

function enriched(over: Partial<EnrichedResult>): EnrichedResult {
  return {
    filepath: "clawmem://c/x.md", displayPath: "c/x.md", title: "X", score: 0.5,
    contentType: "note", modifiedAt: new Date().toISOString(), accessCount: 0,
    confidence: 0.5, qualityScore: 0.5, pinned: false, context: null, hash: "h",
    docid: "h", collectionName: "c", bodyLength: 500, source: "fts",
    duplicateCount: 1, revisionCount: 1,
    ...over,
  } as EnrichedResult;
}

describe("applyCompositeScoring effective time (D8)", () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const fresh = now.toISOString();
  const yearOld = "2025-07-18T00:00:00.000Z";

  it("a historical authoredAt decays recency even when modifiedAt is fresh", () => {
    const [historical] = applyCompositeScoring(
      [enriched({ modifiedAt: fresh, authoredAt: yearOld })], "query terms", undefined, { now });
    const [freshDoc] = applyCompositeScoring(
      [enriched({ modifiedAt: fresh, authoredAt: null })], "query terms", undefined, { now });
    expect(historical!.recencyScore).toBeLessThan(0.05);
    expect(freshDoc!.recencyScore).toBe(1.0);
    expect(historical!.compositeScore).toBeLessThan(freshDoc!.compositeScore);
  });

  it("null/absent authoredAt is byte-identical to pre-§51.1 behavior", () => {
    const withNull = applyCompositeScoring([enriched({ authoredAt: null })], "q", undefined, { now });
    const without = applyCompositeScoring([enriched({})], "q", undefined, { now });
    expect(withNull[0]!.compositeScore).toBe(without[0]!.compositeScore);
    expect(withNull[0]!.recencyScore).toBe(without[0]!.recencyScore);
  });

  it("HEADLINE — recency-intent queries (70% recency weight) stop ranking historical mined content as fresh", () => {
    const historical = enriched({ filepath: "clawmem://c/hist.md", displayPath: "c/hist.md", score: 0.5, modifiedAt: fresh, authoredAt: yearOld });
    const current = enriched({ filepath: "clawmem://c/cur.md", displayPath: "c/cur.md", score: 0.5, modifiedAt: fresh, authoredAt: null });
    // "recent decisions" trips hasRecencyIntent → RECENCY_WEIGHTS (0.10/0.70/0.20).
    const ranked = applyCompositeScoring([historical, current], "recent decisions", undefined, { now });
    const hist = ranked.find(r => r.displayPath === "c/hist.md")!;
    const cur = ranked.find(r => r.displayPath === "c/cur.md")!;
    expect(cur.compositeScore).toBeGreaterThan(hist.compositeScore * 2);
    expect(hist.recencyScore).toBeLessThan(0.05);
  });
});

describe("confidenceScore three time inputs (D8)", () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const filing = "2026-06-18T00:00:00.000Z";     // 30 days ago
  const authored = "2025-01-01T00:00:00.000Z";   // old content

  it("decayAt drives the internal recency term", () => {
    const old = confidenceScore("note", authored, 0, now, null, filing);
    const recent = confidenceScore("note", filing, 0, now, null, filing);
    expect(old).toBeLessThan(recent);
  });

  it("the backfill sentinel compares lastAccessedAt against FILING time, not decayAt", () => {
    // lastAccessedAt === modifiedAtForBackfill → backfilled → attention decay skipped,
    // even though decayAt is a different (older) axis.
    const withSentinel = confidenceScore("note", authored, 0, now, filing, filing);
    // Without the explicit filing axis the sentinel would compare against decayAt
    // (authored ≠ lastAccessed) and apply 30 days of attention decay.
    const withoutSentinel = confidenceScore("note", authored, 0, now, filing);
    expect(withSentinel).toBeGreaterThan(withoutSentinel);
  });
});

// ─── §3: temporal predicates on effective time ─────────────────────

describe("dateRange predicates use COALESCE(authored_at, modified_at)", () => {
  it("a historical mined doc is found by its authored period, not its filing week", () => {
    seedDoc("temporal", "historic.md", "zanzibar historical planning discussion", {
      modifiedAt: "2026-07-18T00:00:00.000Z",
      authoredAt: "2025-03-15T00:00:00.000Z",
    });
    const marchWindow = { start: "2025-03-01T00:00:00.000Z", end: "2025-03-31T23:59:59.000Z" };
    const thisWeek = { start: "2026-07-12T00:00:00.000Z", end: "2026-07-19T00:00:00.000Z" };

    const inMarch = store.searchFTS("zanzibar", 10, undefined, ["temporal"], marchWindow);
    expect(inMarch.some(r => r.displayPath === "temporal/historic.md")).toBe(true);

    const inThisWeek = store.searchFTS("zanzibar", 10, undefined, ["temporal"], thisWeek);
    expect(inThisWeek.some(r => r.displayPath === "temporal/historic.md")).toBe(false);
  });

  it("docs without authored_at keep filing-time temporal behavior", () => {
    seedDoc("temporal", "undated.md", "quixote undated note content", {
      modifiedAt: "2026-07-18T00:00:00.000Z",
      authoredAt: null,
    });
    const thisWeek = { start: "2026-07-12T00:00:00.000Z", end: "2026-07-19T00:00:00.000Z" };
    const hits = store.searchFTS("quixote", 10, undefined, ["temporal"], thisWeek);
    expect(hits.some(r => r.displayPath === "temporal/undated.md")).toBe(true);
  });

  it("the VECTOR dateRange predicate also runs on effective time", async () => {
    const body = "xylophone vector temporal probe content";
    const docId = seedDoc("temporal", "vec-historic.md", body, {
      modifiedAt: "2026-07-18T00:00:00.000Z",
      authoredAt: "2025-03-15T00:00:00.000Z",
    });
    const hash = (store.db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(docId) as any).hash;
    store.ensureVecTable(4);
    store.insertEmbedding(hash, 0, 0, fakeVec(body), MODEL, new Date().toISOString(), "full", undefined, canonicalDocId("temporal", "vec-historic.md"));

    const marchWindow = { start: "2025-03-01T00:00:00.000Z", end: "2025-03-31T23:59:59.000Z" };
    const thisWeek = { start: "2026-07-12T00:00:00.000Z", end: "2026-07-19T00:00:00.000Z" };
    const inMarch = await store.searchVec(body, MODEL, 10, undefined, ["temporal"], marchWindow);
    expect(inMarch.some(r => r.displayPath === "temporal/vec-historic.md")).toBe(true);
    const inThisWeek = await store.searchVec(body, MODEL, 10, undefined, ["temporal"], thisWeek);
    expect(inThisWeek.some(r => r.displayPath === "temporal/vec-historic.md")).toBe(false);
  });
});

// ─── D13: getDocumentsByType time axis ─────────────────────────────

// Relative timestamps — the hook callers below use the REAL clock for their
// recency windows, so fixed calendar dates would rot (codex Turn-2 finding).
const d13Now = new Date().toISOString();
const d13DayAgo = new Date(Date.now() - 86400000).toISOString();
const d13YearAgo = new Date(Date.now() - 365 * 86400000).toISOString();

describe("getDocumentsByType orderBy option (D13)", () => {
  it("effective mode orders by COALESCE and returns effectiveAt/authoredAt; default stays operational", () => {
    // A: filed NOW but authored a year ago. B: filed yesterday, no authorship.
    seedDoc("d13", "a.md", "decision alpha body", {
      contentType: "decision", modifiedAt: d13Now, authoredAt: d13YearAgo,
    });
    seedDoc("d13", "b.md", "decision beta body", {
      contentType: "decision", modifiedAt: d13DayAgo,
    });

    const operational = store.getDocumentsByType("decision", 10);
    const opOrder = operational.filter(d => d.collection === "d13").map(d => d.path);
    expect(opOrder).toEqual(["a.md", "b.md"]);

    const effective = store.getDocumentsByType("decision", 10, { orderBy: "effective" });
    const effRows = effective.filter(d => d.collection === "d13");
    expect(effRows.map(d => d.path)).toEqual(["b.md", "a.md"]);
    expect(effRows[1]!.authoredAt).toBe(d13YearAgo);
    expect(effRows[1]!.effectiveAt).toBe(d13YearAgo);
    expect(effRows[0]!.authoredAt).toBeNull();
    expect(effRows[0]!.effectiveAt).toBe(d13DayAgo);
  });
});

// ─── D12: raw-route group invariants ───────────────────────────────

describe("rankRawPrimary authored-aware exact-tie ordering (D12)", () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const fresh = now.toISOString();

  it("unequal raw scores are untouched by authorship (cross-group invariant)", () => {
    const hi = enriched({ filepath: "clawmem://c/hi.md", displayPath: "c/hi.md", score: 0.9, authoredAt: "2020-01-01T00:00:00.000Z", modifiedAt: fresh });
    const lo = enriched({ filepath: "clawmem://c/lo.md", displayPath: "c/lo.md", score: 0.5, authoredAt: null, modifiedAt: fresh });
    const ranked = rankRawPrimary([lo, hi], "query", undefined, { now });
    expect(ranked.map(r => r.displayPath)).toEqual(["c/hi.md", "c/lo.md"]);
    expect(ranked[0]!.compositeScore).toBe(0.9);
  });

  it("within an exact-score group with every other signal equalized, the recently-authored doc wins the tie", () => {
    const oldDoc = enriched({ filepath: "clawmem://c/old.md", displayPath: "c/old.md", score: 0.7, modifiedAt: fresh, authoredAt: "2024-01-01T00:00:00.000Z" });
    const newDoc = enriched({ filepath: "clawmem://c/new.md", displayPath: "c/new.md", score: 0.7, modifiedAt: fresh, authoredAt: "2026-07-01T00:00:00.000Z" });
    const ranked = rankRawPrimary([oldDoc, newDoc], "query", undefined, { now });
    expect(ranked.map(r => r.displayPath)).toEqual(["c/new.md", "c/old.md"]);
    // Raw scores preserved on both.
    expect(ranked[0]!.compositeScore).toBe(0.7);
    expect(ranked[1]!.compositeScore).toBe(0.7);
  });
});

// ─── D11 + D5: indexer transitions (e2e over a temp collection) ────

describe("indexer dated-only transition / adoption / clearing (D11, D5)", () => {
  const COLL_DIR = join(TMP, "coll");
  const colRow = (path: string) =>
    store.db.prepare(`SELECT id, modified_at, authored_at, confidence, content_hash, hash FROM documents WHERE collection = 'idx51' AND path = ? AND active = 1`)
      .get(path) as { id: number; modified_at: string; authored_at: string | null; confidence: number; content_hash: string; hash: string };

  it("dated-only frontmatter change: authored_at set, modified_at + stored confidence preserved, stat = dated", async () => {
    mkdirSync(COLL_DIR, { recursive: true });
    writeFileSync(join(COLL_DIR, "doc.md"), `---\ntitle: Doc\n---\n\nbody of the transition test doc`);
    const s1 = await indexCollection(store, "idx51", COLL_DIR, "**/*.md");
    expect(s1.added).toBe(1);
    const before = colRow("doc.md");
    expect(before.authored_at).toBeNull();

    writeFileSync(join(COLL_DIR, "doc.md"), `---\ntitle: Doc\nauthored_at: "2025-03-01T00:00:00.000Z"\n---\n\nbody of the transition test doc`);
    const genBefore = generateCalls;
    const s2 = await indexCollection(store, "idx51", COLL_DIR, "**/*.md");
    expect(s2.dated).toBe(1);
    expect(s2.updated).toBe(0);
    expect(generateCalls).toBe(genBefore);                    // A-MEM NOT enqueued (direct spy)

    const after = colRow("doc.md");
    expect(after.authored_at).toBe("2025-03-01T00:00:00.000Z");
    expect(after.modified_at).toBe(before.modified_at);       // filing time preserved
    expect(after.confidence).toBe(before.confidence);         // stored confidence untouched
    expect(after.content_hash).not.toBe(before.content_hash); // incremental check advanced
  });

  it("unchanged-row adoption: a NULL row whose file already declares authored_at adopts it metadata-only", async () => {
    const row = colRow("doc.md");
    store.db.prepare(`UPDATE documents SET authored_at = NULL WHERE id = ?`).run(row.id); // simulate pre-upgrade row
    const genBefore = generateCalls;
    const s3 = await indexCollection(store, "idx51", COLL_DIR, "**/*.md");
    expect(s3.unchanged).toBe(1);
    expect(s3.dated).toBe(1);
    expect(generateCalls).toBe(genBefore);                    // A-MEM NOT enqueued (direct spy)
    const adopted = colRow("doc.md");
    expect(adopted.authored_at).toBe("2025-03-01T00:00:00.000Z");
    expect(adopted.modified_at).toBe(row.modified_at);
    expect(adopted.confidence).toBe(row.confidence);          // lane uniformity: adoption never touches stored confidence
  });

  it("combined edits take the normal update path; removing the frontmatter clears authoritatively", async () => {
    // Title AND body change alongside the date → normal update.
    writeFileSync(join(COLL_DIR, "doc.md"), `---\ntitle: Doc Renamed\nauthored_at: "2025-03-01T00:00:00.000Z"\n---\n\nbody of the transition test doc, now edited`);
    const genBefore = generateCalls;
    const s4 = await indexCollection(store, "idx51", COLL_DIR, "**/*.md");
    expect(s4.updated).toBe(1);
    expect(s4.dated).toBe(0);
    expect(generateCalls).toBeGreaterThan(genBefore);         // normal updates DO enqueue A-MEM (spy control)
    expect(colRow("doc.md").authored_at).toBe("2025-03-01T00:00:00.000Z");

    // Frontmatter removed on a changed doc → cleared (file is authoritative).
    writeFileSync(join(COLL_DIR, "doc.md"), `---\ntitle: Doc Renamed\n---\n\nbody of the transition test doc, edited once more`);
    const s5 = await indexCollection(store, "idx51", COLL_DIR, "**/*.md");
    expect(s5.updated).toBe(1);
    expect(colRow("doc.md").authored_at).toBeNull();
  });
});

// ─── D7: synthesis inheritance (param-level) ───────────────────────

describe("saveMemory authoredAt inheritance shape (D7)", () => {
  it("a fact saved with its source doc's authorship carries it; null source falls back to filing behavior", () => {
    const dated = store.saveMemory({
      collection: "synth", path: "fact-dated.md", title: "Fact A", body: "synthesized fact alpha",
      contentType: "deductive", authoredAt: "2025-02-01T00:00:00.000Z",
    });
    const undated = store.saveMemory({
      collection: "synth", path: "fact-undated.md", title: "Fact B", body: "synthesized fact beta",
      contentType: "deductive",
    });
    const a = store.db.prepare(`SELECT authored_at FROM documents WHERE id = ?`).get(dated.docId) as any;
    const b = store.db.prepare(`SELECT authored_at FROM documents WHERE id = ?`).get(undated.docId) as any;
    expect(a.authored_at).toBe("2025-02-01T00:00:00.000Z");
    expect(b.authored_at).toBeNull();
  });
});

// ─── D14.7: caller-level pins (candidate cutoffs + rendered dates) ─

describe("caller pins: cutoffs and displayed dates run on effectiveAt (D14.7)", () => {
  // Uses the d13 seeds: a.md = decision filed now / authored a year ago
  // (historical — must be EXCLUDED from recency windows despite fresh filing),
  // b.md = decision filed yesterday / no authorship (current — included,
  // displayed by its effective date). All timestamps are relative to the real
  // clock, so these pins cannot rot.

  it("postcompactInject: historical-authored decision excluded from 'last 7 days'; dates render as effectiveAt", async () => {
    const out = await postcompactInject(store, { sessionId: "s511-pc", transcriptPath: "/tmp/nonexistent-s511" } as any);
    const text = JSON.stringify(out);
    // seedDoc uses the path as the title, so rendered lines carry "b.md"/"a.md".
    expect(text).toContain(`**b.md** (${d13DayAgo.slice(0, 10)})`);
    expect(text).not.toContain("**a.md**");
  });

  it("sessionBootstrap current focus: same exclusion + effectiveAt dates", async () => {
    const out = await sessionBootstrap(store, { sessionId: "s511-bootstrap" } as any);
    const text = JSON.stringify(out);
    expect(text).toContain(`b.md** (${d13DayAgo.slice(0, 10)})`);
    expect(text).not.toContain("**a.md**");
  });

  it("getDecisionsForDirectory: effective-time cutoff excludes historical-authored, includes current", () => {
    const dir = "/s511/target-dir";
    seedDoc("dirdec", "hist-dir.md", `decision touching ${dir}/file.ts — historical`, {
      contentType: "decision", modifiedAt: d13Now, authoredAt: d13YearAgo,
    });
    seedDoc("dirdec", "cur-dir.md", `decision touching ${dir}/other.ts — current`, {
      contentType: "decision", modifiedAt: d13Now, authoredAt: d13DayAgo,
    });
    const picked = getDecisionsForDirectory(store, dir).map(d => `${d.collection}/${d.path}`);
    expect(picked).toContain("dirdec/cur-dir.md");
    expect(picked).not.toContain("dirdec/hist-dir.md");
  });

  it("buildStaticProfile: static decisions feed facts in effective order (recent authorship first)", () => {
    seedDoc("sprof", "hist-sp.md", "- zulu historical bullet fact", {
      contentType: "decision", modifiedAt: d13Now, authoredAt: d13YearAgo,
    });
    seedDoc("sprof", "cur-sp.md", "- yankee current bullet fact", {
      contentType: "decision", modifiedAt: d13DayAgo, authoredAt: d13DayAgo,
    });
    const facts = buildStaticProfile(store);
    const cur = facts.findIndex(f => f.includes("yankee current bullet fact"));
    const hist = facts.findIndex(f => f.includes("zulu historical bullet fact"));
    expect(cur).toBeGreaterThanOrEqual(0);
    expect(hist).toBeGreaterThanOrEqual(0);
    expect(cur).toBeLessThan(hist);
  });

  it("isProfileStale stays on OPERATIONAL modifiedAt (explicitly not effective)", () => {
    // Profile filed NOW but authored years ago; six sessions all started before
    // the filing. Operational comparison → zero sessions since → NOT stale.
    // An (incorrect) effective comparison would count all six → stale.
    seedDoc("_clawmem", "profile.md", "# User Profile\n\n- fact", {
      contentType: "hub", modifiedAt: d13Now, authoredAt: "2020-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 6; i++) {
      store.insertSession(`s511-stale-${i}`, new Date(Date.now() - (i + 2) * 3600_000).toISOString(), "testhost");
    }
    expect(isProfileStale(store)).toBe(false);
  });

  it("buildDynamicProfile: progress cutoff and display on effectiveAt", () => {
    seedDoc("prof", "hist-progress.md", "historical progress body content", {
      contentType: "progress", modifiedAt: new Date().toISOString(), authoredAt: "2025-04-01T00:00:00.000Z",
    });
    const recentIso = new Date(Date.now() - 2 * 86400000).toISOString();
    seedDoc("prof", "recent-progress.md", "recent progress body content", {
      contentType: "progress", modifiedAt: new Date().toISOString(), authoredAt: recentIso,
    });
    const items = buildDynamicProfile(store);
    const joined = items.join("\n");
    expect(joined).toContain("recent-progress.md");
    expect(joined).toContain(`(${recentIso.slice(0, 10)})`);
    expect(joined).not.toContain("hist-progress.md");
  });

  it("generateDirectoryBlock renders effectiveAt, not modifiedAt", () => {
    const row = {
      id: 1, collection: "c", path: "p.md", title: "Dir Decision", hash: "h",
      modifiedAt: "2026-07-18T00:00:00.000Z", authoredAt: "2025-03-01T00:00:00.000Z",
      effectiveAt: "2025-03-01T00:00:00.000Z", domain: null, workstream: null, tags: null,
      contentType: "decision", reviewBy: null, confidence: 0.5, accessCount: 0, bodyLength: 100, pinned: 0,
    } satisfies DocumentRow;
    const block = generateDirectoryBlock([row], [], "/some/dir")!;
    expect(block).toContain("(2025-03-01)");
    expect(block).not.toContain("(2026-07-18)");
  });
});

// ─── §3: MCP temporal-proximity channel + metadata propagation ─────
// Placed last: closing the eval session closes all registered stores.

describe("query tool: temporal-proximity on effective time + authored_at metadata (§3/D9)", () => {
  it("a dateRange query surfaces the historical doc via its authored period and carries authored_at metadata", async () => {
    const session = await createEvalSession();
    try {
      const res = await session.client.callTool({
        name: "query",
        arguments: { query: "zanzibar historical planning in march 2025", limit: 10, compact: true },
      }) as any;
      const items = (res.structuredContent?.results ?? []) as Array<{ path: string; authored_at?: string | null }>;
      const hit = items.find(i => i.path === "temporal/historic.md");
      expect(hit).toBeDefined();
      expect(hit!.authored_at).toBe("2025-03-15T00:00:00.000Z");
    } finally {
      await session.close();
    }
  }, 30000);
});
