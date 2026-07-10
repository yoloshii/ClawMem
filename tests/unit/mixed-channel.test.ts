/**
 * S49.1 U5 — concrete mixed-channel behavior at the real sites.
 *
 * FTS-transform scores and vector cosines are independent monotonic signals on an
 * uncalibrated common range. These tests pin the CONCRETE intended behavior at the
 * places where the two channels actually mix — the context-surfacing hook (FTS
 * supplement pool + deep-escalation sort/blend) and the REST hybrid max-score
 * merge — without claiming general cross-channel comparability. Pre-fix, every
 * FTS-sourced entry carried searchScore 1.0 and unconditionally dominated all of
 * these sites.
 *
 * (The hook's other FTS lanes — supplement, file-aware, deep-escalation expansion —
 * are `seen`-guarded at insertion, so the final max-score dedup at
 * context-surfacing.ts:382 is a belt-and-braces guard; the supplement-pool test here
 * exercises the composite pool those lanes feed.)
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createStore, insertContent, insertDocument, canonicalDocId, type Store } from "../../src/store.ts";
import { contextSurfacing } from "../../src/hooks/context-surfacing.ts";
import { startServer } from "../../src/server.ts";
import { setDefaultLlamaCpp } from "../../src/llm.ts";

const MODEL = "mixed-fake";
const savedProfile = Bun.env.CLAWMEM_PROFILE;
const savedRerankUrl = Bun.env.CLAWMEM_RERANK_URL;

// Keyword-steered 4-dim unit vectors. Only QUERY embeds go through this fake —
// document vectors are seeded directly with the constructed values below.
function fakeVec(text: string): Float32Array {
  const t = text.toLowerCase();
  if (t.includes("vortalcrest") || t.includes("calibration")) return new Float32Array([1, 0, 0, 0]);
  return new Float32Array([0, 0, 1, 0]);
}
const V_VEC = new Float32Array([0.9, Math.sqrt(1 - 0.81), 0, 0]);   // cosine 0.90 vs query
const X_VEC = new Float32Array([0.5, Math.sqrt(1 - 0.25), 0, 0]);   // cosine 0.50
const G_VEC = new Float32Array([0.75, Math.sqrt(1 - 0.5625), 0, 0]); // cosine 0.75
const F_VEC = new Float32Array([0.6, 0.8, 0, 0]);                    // cosine 0.60

const fakeLlm = {
  embed: async (text: string) => ({ embedding: fakeVec(text), model: MODEL }),
  query: async () => null,
  expandQuery: async () => [],
} as any;
setDefaultLlamaCpp(fakeLlm);

let store: Store;

function addDoc(path: string, body: string, vec?: Float32Array) {
  const hash = `hash_${path}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  insertContent(store.db, hash, body, now);
  insertDocument(store.db, "user", path, path, hash, now, now);
  if (vec) {
    store.ensureVecTable(4);
    store.insertEmbedding(hash, 0, 0, vec, MODEL, now, "full", undefined, canonicalDocId("user", path));
  }
}

// Prompt tokens are AND'd by FTS — W must contain every token; V must not.
const PROMPT = "vortalcrest configuration setup notes";

function seedHookFixture() {
  // V: vector-strong (0.9), no FTS match (its body omits "vortalcrest").
  addDoc("v-doc.md", "vortalhub design overview for the semantic hub component and its internal layout considerations.", V_VEC);
  // W: FTS-supplement only (no vector) — matches every prompt token once, buried in
  // filler so the transformed score stays weak. Body kept under 500 chars so the
  // composite length-norm multiplier is 1.0 and channel ordering is score-driven.
  addDoc("w-doc.md",
    `Somewhere in these notes there is a passing mention of vortalcrest configuration during setup. ${"Unrelated filler prose about errands, reading lists, and small chores stacking up across the week. ".repeat(3)}A final line links someone's notes about an unrelated archive.`);
  // X: vector-mid third doc so the deep-escalation rerank branch (needs >= 3 results) runs.
  addDoc("x-doc.md", "vortalmid auxiliary reference sheet describing adjacent tooling.", X_VEC);
}

beforeEach(() => {
  store = createStore(":memory:");
  delete Bun.env.CLAWMEM_PROFILE;
  delete Bun.env.CLAWMEM_RERANK_URL;
});

afterAll(() => {
  if (savedProfile === undefined) delete Bun.env.CLAWMEM_PROFILE; else Bun.env.CLAWMEM_PROFILE = savedProfile;
  if (savedRerankUrl === undefined) delete Bun.env.CLAWMEM_RERANK_URL; else Bun.env.CLAWMEM_RERANK_URL = savedRerankUrl;
  setDefaultLlamaCpp(null);
});

describe("hook mixed-channel pool (S49.1 U5)", () => {
  it("a weak FTS supplement no longer outranks a strong vector hit in the injected context", async () => {
    seedHookFixture();
    const out = await contextSurfacing(store, { prompt: PROMPT });
    const ctx = out.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("v-doc.md");
    expect(ctx).toContain("w-doc.md");
    // Pre-fix W carried searchScore 1.0 (vs V's 0.9 cosine) and led the injection.
    expect(ctx.indexOf("v-doc.md")).toBeLessThan(ctx.indexOf("w-doc.md"));
  });

  it("deep-escalation sort/blend consumes the transformed scale (flat-1.0 FTS would invert the order)", async () => {
    seedHookFixture();
    // Regression-sensitive arithmetic: the blend is 0.6·score + 0.4·rerank.
    //   Post-fix:  W ≈ 0.6·0.55 + 0.4·0.6 = 0.57  <  V = 0.6·0.9 + 0.4·0.5 = 0.74 → V leads.
    //   Pre-fix (W's FTS score flat 1.0): W = 0.6·1.0 + 0.4·0.6 = 0.84 > 0.74 → W would lead.
    // So asserting V-before-W FAILS against the old constant-score defect, and the
    // stub hit-counter proves the blend path actually executed (a silently skipped
    // rerank would leave the ordering correct for the wrong reason).
    let stubHits = 0;
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        stubHits++;
        const body = await req.json() as { documents: string[] };
        return Response.json({
          results: body.documents.map((d, i) => ({
            index: i,
            relevance_score: d.includes("vortalcrest") ? 0.6 : d.includes("vortalhub") ? 0.5 : 0.1,
          })),
        });
      },
    });
    try {
      Bun.env.CLAWMEM_PROFILE = "deep";
      Bun.env.CLAWMEM_RERANK_URL = `http://127.0.0.1:${stub.port}`;
      const out = await contextSurfacing(store, { prompt: PROMPT });
      const ctx = out.hookSpecificOutput?.additionalContext ?? "";
      expect(stubHits).toBeGreaterThan(0);
      expect(ctx).toContain("w-doc.md");
      expect(ctx).toContain("v-doc.md");
      expect(ctx.indexOf("v-doc.md")).toBeLessThan(ctx.indexOf("w-doc.md"));
    } finally {
      stub.stop(true);
    }
  });
});

describe("REST hybrid max-score merge (S49.1 U5)", () => {
  it("an FTS-weak/vector-mid doc no longer unconditionally beats a vector-only doc", async () => {
    // F: in BOTH channels — weak FTS match (buried terms) + 0.60 cosine.
    // G: vector-only (0.75 cosine), no FTS match for the query terms.
    // The merge keeps the max variant per doc: F survives as its 0.60 vector variant,
    // so G (0.75) outranks it. Pre-fix F's FTS variant carried 1.0 and always won.
    addDoc("f-doc.md",
      `Long operational log with many entries. ${"Routine remarks about schedules, chores, and follow-ups without any particular focus. ".repeat(8)}One line notes a vortalfair calibration pass among other minor items.`,
      F_VEC);
    addDoc("g-doc.md", "vortalgold reference for the adjacent subsystem with concise structure.", G_VEC);

    const server = startServer(store, 0);
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "vortalfair calibration", mode: "hybrid", compact: true }),
      });
      expect(resp.ok).toBe(true);
      const data = await resp.json() as { results: { path: string }[] };
      const order = data.results.map(r => r.path);
      expect(order).toContain("user/f-doc.md");
      expect(order).toContain("user/g-doc.md");
      expect(order.indexOf("user/g-doc.md")).toBeLessThan(order.indexOf("user/f-doc.md"));
    } finally {
      server.stop(true);
    }
  });
});
