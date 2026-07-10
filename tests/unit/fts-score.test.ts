/**
 * S49.1 — monotonic BM25 exposed score (ftsScoreFromBm25) + its consumers.
 *
 * Pre-fix, searchFTS exposed `1 / (1 + Math.max(0, bm25))` ≡ 1.0 for every match
 * (FTS5 bm25() is negative-is-better, ≤ 0 on every real row), so composite scoring,
 * the strong-signal bypass, and every threshold gate operated on a constant. These
 * tests pin the corrected behavior: the transform's shape, the shared bypass helper,
 * and the search-handler pipeline ordering that the flat score used to scramble.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createStore,
  insertContent,
  insertDocument,
  searchFTS,
  ftsScoreFromBm25,
  type Store,
  type SearchResult,
} from "../../src/store.ts";
import { applyCompositeScoring } from "../../src/memory.ts";
import { enrichResults, hasStrongFtsSignal, attachRrfScores, type RankedResult } from "../../src/search-utils.ts";

// ─── Pure transform ──────────────────────────────────────────────────────────

describe("ftsScoreFromBm25", () => {
  it("is monotonic in match strength (more negative bm25 → higher score)", () => {
    expect(ftsScoreFromBm25(-16.9)).toBeGreaterThan(ftsScoreFromBm25(-10));
    expect(ftsScoreFromBm25(-10)).toBeGreaterThan(ftsScoreFromBm25(-5));
    expect(ftsScoreFromBm25(-5)).toBeGreaterThan(ftsScoreFromBm25(-1));
    expect(ftsScoreFromBm25(-1)).toBeGreaterThan(ftsScoreFromBm25(-0.1));
    expect(ftsScoreFromBm25(-0.1)).toBeGreaterThan(ftsScoreFromBm25(0));
  });

  it("is bounded [0, 1)", () => {
    for (const b of [-1000, -16.9, -5.67, -2.33, -0.5, 0]) {
      const s = ftsScoreFromBm25(b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });

  it("maps the design anchor points", () => {
    // 0.70 gate ⇔ |bm25| = 2.333…; 0.85 bypass gate ⇔ |bm25| = 5.667…
    expect(ftsScoreFromBm25(-7 / 3)).toBeCloseTo(0.7, 5);
    expect(ftsScoreFromBm25(-17 / 3)).toBeCloseTo(0.85, 5);
    expect(ftsScoreFromBm25(0)).toBe(0);
  });

  it("clamps a hypothetical positive bm25 to 0 instead of inverting the ordering", () => {
    expect(ftsScoreFromBm25(3)).toBe(0);
    expect(ftsScoreFromBm25(0.001)).toBe(0);
  });
});

// ─── Shared strong-signal bypass helper ──────────────────────────────────────

function ranked(scores: number[]): SearchResult[] {
  return scores.map((score, i) => ({ score, filepath: `clawmem://t/d${i}.md` }) as SearchResult);
}

describe("hasStrongFtsSignal", () => {
  it("fires on a strong, clearly separated top hit", () => {
    expect(hasStrongFtsSignal(ranked([0.92, 0.6]))).toBe(true);
  });

  it("does NOT fire when the top two are strong but close", () => {
    expect(hasStrongFtsSignal(ranked([0.92, 0.9]))).toBe(false);
  });

  it("does NOT fire on a lone weak hit (pre-fix pathology: constant 1.0 vs missing #2 always fired)", () => {
    expect(hasStrongFtsSignal(ranked([0.14]))).toBe(false);
    expect(hasStrongFtsSignal(ranked([0.84]))).toBe(false);
  });

  it("fires on a lone strong hit", () => {
    expect(hasStrongFtsSignal(ranked([0.9]))).toBe(true);
  });

  it("is false on empty results", () => {
    expect(hasStrongFtsSignal([])).toBe(false);
  });
});

// ─── attachRrfScores (S49.1 U2) ──────────────────────────────────────────────

describe("attachRrfScores", () => {
  const orig = (filepath: string, score: number, source: "fts" | "vec" = "fts"): SearchResult =>
    ({ filepath, displayPath: filepath.replace("clawmem://", ""), title: filepath, score, source }) as SearchResult;
  const fusedEntry = (file: string, score: number): RankedResult =>
    ({ file, displayPath: file, title: file, body: "", score });

  it("carries the RRF-fused score, not the raw channel score (graph-anchor regression)", () => {
    // Raw channel scores are 0.6–1.0; RRF-scale scores are ≤ ~0.13. Pre-fix the
    // query_plan graph clause returned the originals untouched, anchoring traversal
    // on the raw values.
    const originals = [orig("clawmem://u/a.md", 0.95), orig("clawmem://u/b.md", 0.78)];
    const fused = [fusedEntry("clawmem://u/b.md", 0.116), fusedEntry("clawmem://u/a.md", 0.066)];
    const out = attachRrfScores(fused, originals);
    expect(out.map(r => r.filepath)).toEqual(["clawmem://u/b.md", "clawmem://u/a.md"]);
    expect(out[0]!.score).toBeCloseTo(0.116, 6);
    expect(out[1]!.score).toBeCloseTo(0.066, 6);
    for (const r of out) expect(r.score).toBeLessThan(0.3);
  });

  it("keeps the first occurrence when a doc appears in multiple channels", () => {
    const originals = [orig("clawmem://u/a.md", 0.9, "fts"), orig("clawmem://u/a.md", 0.5, "vec")];
    const out = attachRrfScores([fusedEntry("clawmem://u/a.md", 0.1)], originals);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("fts");
    expect(out[0]!.score).toBeCloseTo(0.1, 6);
  });

  it("originals order controls duplicate-channel preference (query_plan passes vec first)", () => {
    // The query_plan graph clause historically preferred the vector variant on duplicate
    // paths (Map construction let later entries overwrite); it preserves that by passing
    // [...vec, ...bm25]. The other four sites pass FTS first, matching their old .find().
    const fts = orig("clawmem://u/a.md", 0.9, "fts");
    const vec = orig("clawmem://u/a.md", 0.5, "vec");
    const vecFirst = attachRrfScores([fusedEntry("clawmem://u/a.md", 0.1)], [vec, fts]);
    expect(vecFirst[0]!.source).toBe("vec");
    const ftsFirst = attachRrfScores([fusedEntry("clawmem://u/a.md", 0.1)], [fts, vec]);
    expect(ftsFirst[0]!.source).toBe("fts");
  });

  it("drops fused entries with no originating SearchResult", () => {
    const out = attachRrfScores([fusedEntry("clawmem://u/ghost.md", 0.08)], [orig("clawmem://u/a.md", 0.9)]);
    expect(out).toHaveLength(0);
  });
});

// ─── searchFTS exposed scores + handler-pipeline goldens ─────────────────────

let store: Store;

function addDoc(collection: string, path: string, title: string, body: string, opts?: { modifiedAt?: string; qualityScore?: number }) {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const now = opts?.modifiedAt || new Date().toISOString();
  insertContent(store.db, hash, body, now);
  insertDocument(store.db, collection, path, title, hash, now, now);
  if (opts?.qualityScore !== undefined) {
    const doc = store.findActiveDocument(collection, path);
    if (doc) store.updateDocumentMeta(doc.id, { quality_score: opts.qualityScore });
  }
}

const FILLER = [
  "General notes about the weekly planning cadence and how meetings are scheduled across the team calendar.",
  "A short summary of the deployment checklist covering rollback steps and verification of service health.",
  "Reference material describing the onboarding guide for new contributors and repository conventions.",
  "Observations about database maintenance windows and the backup rotation policy for the archive host.",
  "Notes on the documentation style guide, heading conventions, and the review checklist for edits.",
  "A digest of the support rotation schedule and escalation contacts for the on-call handbook.",
];

beforeEach(() => {
  store = createStore(":memory:");
  FILLER.forEach((body, i) => addDoc("user", `filler-${i}.md`, `Filler ${i}`, body));
});

describe("searchFTS exposed score (S49.1)", () => {
  it("exposes varying scores in [0, 1) that follow the SQL BM25 order", () => {
    addDoc("user", "strong.md", "Quorble Widget Manual", "The quorble widget manual explains the quorble calibration steps.");
    addDoc("user", "weak.md", "Misc Journal", "Somewhere in this journal there is one mention of a quorble among many other unrelated words about gardening, travel, recipes, and weather patterns observed through the season.");

    const results = searchFTS(store.db, "quorble");
    expect(results.length).toBe(2);
    // Order follows SQL BM25 (title-weighted match first), scores strictly follow order
    expect(results[0]!.displayPath).toBe("user/strong.md");
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("search-handler pipeline ranks a strong stale match above a weak fresh match (flat scores invert it)", () => {
    const old = new Date(Date.now() - 21 * 86400_000).toISOString();
    // Strong: title match on both terms, 21 days old (raw ≈ 0.78). Weak: both terms
    // buried once in a fresh doc (raw ≈ 0.54). Both bodies < 500 chars so the
    // length-norm multiplier stays 1.0 and the flip is purely relevance vs recency.
    addDoc("user", "flumox-runbook.md", "Flumox Integration Runbook",
      "The flumox integration runbook covers flumox calibration, flumox install order, and validation of the flumox integration bridge across integration environments.",
      { modifiedAt: old });
    addDoc("user", "fresh-notes.md", "Fresh Notes",
      "Daily notes from today about errands, a dentist appointment, and two phone calls to return. There was one aside where someone mentioned the word flumox during standup, and much later a separate remark about an unrelated integration ticket assigned to another team.",
      { modifiedAt: new Date().toISOString() });

    const query = "flumox integration";
    const results = searchFTS(store.db, query);
    expect(results.length).toBe(2);
    expect(results[0]!.displayPath).toBe("user/flumox-runbook.md");
    // The raw signal is discriminating, not flat
    expect(results[0]!.score - results[1]!.score).toBeGreaterThan(0.15);

    // Same pipeline as the MCP `search` handler: enrich → composite → sort.
    // With real searchScores the strong match wins…
    const scored = applyCompositeScoring(enrichResults(store, results, query), query);
    expect(scored[0]!.displayPath).toBe("user/flumox-runbook.md");

    // …and the pre-fix counterfactual (searchScore flattened to the old constant 1.0)
    // inverts the ordering: metadata alone ranks the fresh weak match first.
    const flat = results.map(r => ({ ...r, score: 1.0 }));
    const flatScored = applyCompositeScoring(enrichResults(store, flat, query), query);
    expect(flatScored[0]!.displayPath).toBe("user/fresh-notes.md");
  });

  it("a weak FTS hit no longer auto-outranks a strong vector hit in composite (mixed-channel pool)", () => {
    const now = new Date().toISOString();
    addDoc("user", "weak-fts.md", "Scrap Notes", "A very long scrapbook of mixed notes where the term zibblet appears exactly once surrounded by paragraphs of unrelated filler text about maps, trains, gardens, letters, and archived clippings from various sources collected over the years.", { modifiedAt: now });
    addDoc("user", "vec-hit.md", "Zibblet Design", "Semantically central document for the concept.", { modifiedAt: now });

    const ftsResults = searchFTS(store.db, "zibblet");
    const weakFts = ftsResults.find(r => r.displayPath === "user/weak-fts.md")!;
    expect(weakFts.score).toBeLessThan(0.85);

    // Synthetic vector hit for the same query (channels are independent monotonic
    // signals — this asserts the concrete pre-fix inversion is gone, not calibration)
    const vecBase = searchFTS(store.db, "zibblet design").find(r => r.displayPath === "user/vec-hit.md")!;
    const vecHit: SearchResult = { ...vecBase, score: 0.82, source: "vec" as const };

    const query = "zibblet";
    const scored = applyCompositeScoring(enrichResults(store, [weakFts, vecHit], query), query);
    expect(scored[0]!.displayPath).toBe("user/vec-hit.md");
  });

  it("curator BM25 probe threshold (0.3) is live, not vacuous", () => {
    addDoc("user", "adr.md", "Architecture Decision Record", "This architecture decision record explains the decision to split the service.");
    const results = searchFTS(store.db, "architecture decision", 3);
    expect(results.length).toBeGreaterThan(0);
    // Real matching doc clears the probe honestly (|bm25| > 0.43)
    expect(results[0]!.score).toBeGreaterThan(0.3);
  });

  it("consolidation dup-gate (score >= 0.7) discriminates near-dup titles from weak matches", () => {
    addDoc("user", "jwt-a.md", "JWT Auth Notes", "JWT auth notes: JWT token authentication system design patterns and best practices for secure APIs.");
    addDoc("user", "jwt-b.md", "JWT Auth Notes", "JWT auth notes: JWT token authentication system design patterns and best practices for secure APIs, with an extra sentence.");
    // Weak doc must match ALL AND'd title terms (jwt, auth, notes) — once each, buried
    // in a long body — so it enters the result set and actually exercises the gate.
    addDoc("user", "mention.md", "Reading List",
      `A long collection of reading material gathered over months. ${"Assorted paragraphs about frontend rendering, browser pipelines, conference recaps, and tooling digressions that have nothing to do with the main topic. ".repeat(5)}One entry mentions a jwt library in passing, another links auth talks from a meetup, and a third points at somebody's notes on unrelated database tuning. ${"Further filler about newsletters, podcasts, and long-form articles queued for weekends. ".repeat(5)}`);

    // Title-as-query (what cmdConsolidate does): the sibling dup clears the gate
    const similar = searchFTS(store.db, "JWT Auth Notes", 5);
    const sibling = similar.find(r => r.displayPath === "user/jwt-b.md");
    expect(sibling).toBeDefined();
    expect(sibling!.score).toBeGreaterThanOrEqual(0.7);
    // The weak buried mention is IN the pool and rejected by the gate
    const weak = similar.find(r => r.displayPath === "user/mention.md");
    expect(weak).toBeDefined();
    expect(weak!.score).toBeLessThan(0.7);
  });
});
