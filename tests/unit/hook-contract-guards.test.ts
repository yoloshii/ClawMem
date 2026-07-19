/**
 * Regression coverage for the hook structured-output contract guards.
 *
 * These branches became meaningful when causal inference and contradiction detection were
 * found to have been silently no-op since 2026-03: the extraction model echoes its prompt's
 * skeleton, that residue is structurally valid, and it passed every existing check. The
 * observer / consolidation / conversation-synthesis paths have shared an anti-parrot guard
 * since the 1.7B mining failure; these two paths never adopted it.
 *
 * Each test asserts the CORRECT behavior, not the behavior that shipped.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, buildTemporalBackbone, searchFTS, type Store } from "../../src/store.ts";
import { inferCausalLinks } from "../../src/amem.ts";
import {
  validateContradictionEntry,
  admitContradictionEntries,
  unwrapContradictionArray,
  applyContradictionOutcomes,
  applyContradictionResponse,
  INVALIDATION_ELIGIBLE_CONTENT_TYPE,
} from "../../src/hooks/decision-extractor.ts";
import {
  isSchemaPlaceholder,
  CAUSAL_RESIDUE,
  CONTRADICTION_RESIDUE,
  ALIAS_RESIDUE,
  LINK_TARGET_RESIDUE,
} from "../../src/schema-placeholder.ts";
import { createHash } from "node:crypto";

let store: Store;
let dir: string;

function stubLlm(payload: unknown): any {
  return { generate: async () => ({ text: JSON.stringify(payload), model: "stub", done: true }) };
}

function mkDoc(path: string): number {
  const hash = createHash("sha256").update(path).digest("hex");
  const ts = "2026-07-19T00:00:00.000Z";
  (store as any).insertContent(hash, `body of ${path}`, ts);
  (store as any).insertDocument("_clawmem", path, path, hash, ts, ts);
  return (store as any).findActiveDocument("_clawmem", path)!.id;
}

const causalRows = () =>
  (store as any).db.prepare(
    `SELECT source_id, target_id, weight, metadata FROM memory_relations WHERE relation_type='causal'`,
  ).all() as Array<{ source_id: number; target_id: number; weight: number | null; metadata: string }>;

// Per-test temporary directory + explicit close, so runs never share a fixed database file
// and the handle is released before the tree is removed.
//
// Installed per-describe rather than file-globally: as a global hook it built a vault for the
// pure marker/validator/admission tests too, so a read-only environment failed all 38 at
// mkdtempSync before a single test body ran. Only the three database-backed blocks call this.
function withStore(): void {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clawmem-guards-"));
    store = createStore(join(dir, "vault.sqlite"));
  });

  afterEach(() => {
    try { (store as any).close?.(); } catch { /* close is best-effort */ }
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("anti-parrot guard — causal inference", () => {
  withStore();
  test("rejects the prompt-skeleton residue the deployed model actually returns", async () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");

    const written = await inferCausalLinks(store as any, stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.85,
        reasoning: "Brief explanation of causal relationship" },
    ]), [{ docId: a, facts: ["fact one"] }, { docId: b, facts: ["fact two"] }]);

    expect(written).toBe(0);
    expect(causalRows()).toHaveLength(0);
  });

  test("rejects that residue with trailing punctuation — exact-string matching missed it", async () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");

    const written = await inferCausalLinks(store as any, stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.9,
        reasoning: "Brief explanation of causal relationship." },
    ]), [{ docId: a, facts: ["fact one"] }, { docId: b, facts: ["fact two"] }]);

    expect(written).toBe(0);
    expect(causalRows()).toHaveLength(0);
  });

  test("non-finite confidence never reaches the writer, by either route", async () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");

    // Two distinct routes, both of which must end in zero rows:
    //   - over the wire, `1e309` serializes to JSON `null`, so the parse closure's
    //     `typeof confidence === "number"` test rejects it and retries exhaust;
    //   - injected directly (as an in-process caller or a non-JSON transport could),
    //     Infinity IS typeof "number" and clears `>= 0.6`, previously inserting a row
    //     whose weight column landed as NULL. The range check covers that route.
    const viaJson = await inferCausalLinks(store as any, stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 1e309,
        reasoning: "the deploy caused the outage" },
    ]), [{ docId: a, facts: ["deploy"] }, { docId: b, facts: ["outage"] }]);
    expect(viaJson).toBe(0);

    // Raw-text route: `JSON.parse` turns the literal `1e309` into Infinity, which reaches
    // the loop as a genuine number and is stopped only by the range check.
    const rawLlm: any = {
      generate: async () => ({
        text: '[{"source_fact_idx":0,"target_fact_idx":1,"confidence":1e309,'
          + '"reasoning":"the deploy caused the outage"}]',
        model: "stub",
        done: true,
      }),
    };
    const viaRaw = await inferCausalLinks(store as any, rawLlm,
      [{ docId: a, facts: ["deploy"] }, { docId: b, facts: ["outage"] }]);
    expect(viaRaw).toBe(0);

    expect(causalRows()).toHaveLength(0);
  });

  test("rejects confidence above the unit interval", async () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");

    const written = await inferCausalLinks(store as any, stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 42,
        reasoning: "the deploy caused the outage" },
    ]), [{ docId: a, facts: ["deploy"] }, { docId: b, facts: ["outage"] }]);

    expect(written).toBe(0);
    expect(causalRows()).toHaveLength(0);
  });

  test("accepts genuine reasoning across two documents", async () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");

    const written = await inferCausalLinks(store as any, stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.85,
        reasoning: "The invalid nginx config caused the 502 responses" },
    ]), [
      { docId: a, facts: ["deploy wrote an invalid nginx config"] },
      { docId: b, facts: ["nginx returned 502"] },
    ]);

    expect(written).toBe(1);
    const rows = causalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.weight).toBe(0.85);
  });

  test("the returned count reflects rows written, not candidates attempted", async () => {
    const a = mkDoc("observations/a.md");
    const b = mkDoc("observations/b.md");
    // Causally coherent facts, so a future evidence-alignment validator does not have to
    // break this counter test to become correct.
    const llm = stubLlm([
      { source_fact_idx: 0, target_fact_idx: 1, confidence: 0.9,
        reasoning: "The migration dropped the index, so login queries began table scans" },
    ]);
    const args: any = [
      { docId: a, facts: ["a migration dropped the users index"] },
      { docId: b, facts: ["login queries began doing full table scans"] },
    ];

    expect(await inferCausalLinks(store as any, llm, args)).toBe(1);
    // Identical edge again: INSERT OR IGNORE suppresses it on the composite PK, so a
    // candidate is attempted but no row is written. Counting attempts here is what let a
    // total failure of this path report success for four months.
    expect(await inferCausalLinks(store as any, llm, args)).toBe(0);
    expect(causalRows()).toHaveLength(1);
  });
});

describe("graph builders count insertions, not attempts", () => {
  withStore();
  test("an idempotent second temporal build reports 0 new edges, graph still populated", () => {
    mkDoc("observations/t1.md");
    mkDoc("observations/t2.md");
    mkDoc("observations/t3.md");

    const first = buildTemporalBackbone((store as any).db);
    expect(first).toBeGreaterThan(0);
    expect(buildTemporalBackbone((store as any).db)).toBe(0);

    const total = ((store as any).db.prepare(
      `SELECT COUNT(*) c FROM memory_relations WHERE relation_type='temporal'`,
    ).get() as { c: number }).c;
    expect(total).toBe(first);
  });
});

describe("residue sets are consumer-scoped, not global", () => {
  test("causal residue is recognised only when the causal set is supplied", () => {
    const residue = "Brief explanation of causal relationship";
    expect(isSchemaPlaceholder(residue, CAUSAL_RESIDUE)).toBe(true);
    // Globally this string is ordinary content — an observation ABOUT this defect may
    // legitimately quote it, and must not be suppressed vault-wide.
    expect(isSchemaPlaceholder(residue)).toBe(false);
  });

  test("contradiction residue guards REASONING; the relation skeleton is not its job", () => {
    // The prompt's reasoning skeleton is `"..."`, and that is what this set guards.
    expect(isSchemaPlaceholder("...", CONTRADICTION_RESIDUE)).toBe(true);
    // The relation skeleton is a `relation` VALUE, rejected by exact enum membership in
    // validateContradictionEntry. Holding it here matched nothing while leaving the
    // reasoning field — the one this set is passed to validate — unprotected.
    expect(validateContradictionEntry(
      { relation: "update|contradiction|same", reasoning: "real", confidence: 0.9, old_idx: 0, new_idx: 0 },
      1, 1,
    )).toBe("invalid-relation");
    // Globally, that literal text is ordinary content: an observation ABOUT this defect
    // may quote it, and must not be suppressed vault-wide.
    expect(isSchemaPlaceholder("update|contradiction|same")).toBe(false);
  });

  test("punctuation and quoting variants of residue are still caught", () => {
    expect(isSchemaPlaceholder("Brief explanation of causal relationship.", CAUSAL_RESIDUE)).toBe(true);
    expect(isSchemaPlaceholder('"Brief explanation of causal relationship"', CAUSAL_RESIDUE)).toBe(true);
  });

  test("does not false-positive on real reasoning that merely mentions causality", () => {
    expect(isSchemaPlaceholder("The rollback caused the outage to end", CAUSAL_RESIDUE)).toBe(false);
    expect(isSchemaPlaceholder("Chose update over contradiction after review", CONTRADICTION_RESIDUE)).toBe(false);
  });

  test("quote AND punctuation together normalize — sequential stripping missed this", () => {
    // Stripping quotes then punctuation left a trailing quote behind, so this survived.
    expect(isSchemaPlaceholder('"Brief explanation of causal relationship".', CAUSAL_RESIDUE)).toBe(true);
    expect(isSchemaPlaceholder('"Brief explanation of causal relationship."', CAUSAL_RESIDUE)).toBe(true);
  });

  test("content that is entirely quotes or punctuation is residue, not content", () => {
    // `"reasoning": "..."` is the contradiction prompt's own skeleton. Normalizing it to
    // empty previously caused the empty candidate to be skipped and false returned.
    for (const value of ["...", '"..."', '""', "   "]) {
      expect(isSchemaPlaceholder(value)).toBe(true);
    }
  });

  test("non-ASCII punctuation-only content is residue too", () => {
    // Enumerating ASCII punctuation admitted all of these. Testing for the ABSENCE of any
    // letter or number covers scripts the enumeration never anticipated.
    for (const value of ["…", "“...”", "“…”", "(...) ", "***", "。"]) {
      expect(isSchemaPlaceholder(value)).toBe(true);
    }
  });

  test("short but real content carrying digits or letters is NOT residue", () => {
    // The letter/number rule must not swallow legitimately terse content.
    for (const value of ["v2.1", "42", "n/a — superseded"]) {
      expect(isSchemaPlaceholder(value)).toBe(false);
    }
  });
});

describe("contradiction entry validation — the real decision boundary", () => {
  // 2 candidates, 2 new facts, so indices 0-1 are in range for both.
  const ok = (over: Record<string, unknown> = {}) =>
    validateContradictionEntry(
      { relation: "contradiction", reasoning: "The new decision reverses the prior one",
        confidence: 0.9, old_idx: 0, new_idx: 0, ...over },
      2, 2,
    );

  test("accepts a well-formed entry", () => {
    expect(ok()).toBe("ok");
  });

  test("rejects the enum skeleton echoed as the relation VALUE", () => {
    expect(ok({ relation: "update|contradiction|same" })).toBe("invalid-relation");
  });

  test("rejects the prompt's own reasoning skeleton alongside a VALID relation", () => {
    // The bypass: relation clears the enum check, so only the reasoning guard can stop it.
    // Previously the contradiction residue set held the relation skeleton instead of this,
    // leaving the field it actually guards unprotected.
    expect(ok({ relation: "contradiction", reasoning: "..." })).toBe("placeholder-reasoning");
    expect(ok({ relation: "update", reasoning: '"..."' })).toBe("placeholder-reasoning");
    expect(ok({ relation: "same", reasoning: "" })).toBe("placeholder-reasoning");
  });

  test("rejects non-string reasoning instead of coercing it", () => {
    // `String(rel.reasoning ?? "")` turned each of these into a plausible string that
    // cleared the residue check and proceeded toward mutation.
    for (const value of [123, {}, true, ["real"], null, undefined]) {
      expect(ok({ reasoning: value })).toBe("invalid-reasoning");
    }
  });

  test("rejects a non-string relation without coercing it", () => {
    expect(ok({ relation: 1 })).toBe("invalid-relation");
    expect(ok({ relation: null })).toBe("invalid-relation");
  });

  test("rejects non-finite and out-of-unit-interval confidence", () => {
    expect(ok({ confidence: Infinity })).toBe("invalid-confidence");
    expect(ok({ confidence: Number.NaN })).toBe("invalid-confidence");
    expect(ok({ confidence: 42 })).toBe("invalid-confidence");
    expect(ok({ confidence: -1 })).toBe("invalid-confidence");
    expect(ok({ confidence: "0.9" })).toBe("invalid-confidence");
  });

  test("rejects an out-of-range new_idx that would otherwise mutate the prior document", () => {
    expect(ok({ new_idx: 7 })).toBe("index-out-of-range");
    expect(ok({ new_idx: -1 })).toBe("index-out-of-range");
    expect(ok({ old_idx: 2 })).toBe("index-out-of-range");
    expect(ok({ old_idx: 1.5 })).toBe("index-out-of-range");
  });
});

// ---------------------------------------------------------------------------
// Coverage added after the turn-6 adversarial pass, which found these contracts
// shipped but unlocked — a fix nothing asserts is a fix that silently regresses.
// ---------------------------------------------------------------------------

describe("residue survives reformatting and wrapping", () => {
  // The edge-trim introduced in phase 1 stripped EVERY leading/trailing non-alphanumeric
  // run, which destroyed the marker it was meant to expose: `"{{x}}"` normalized to `x`.
  test("template markers are caught through quotes, parens and brackets", () => {
    for (const wrapped of ['"{{x}}"', "({{x}})", '"${x}"', '"<!--x-->"', "[{{x}}]"]) {
      expect(isSchemaPlaceholder(wrapped)).toBe(true);
    }
  });

  // Exact-set membership missed trivially reformatted copies of the same echoed string.
  test("residue is caught through whitespace, newline and fullwidth reformatting", () => {
    for (const variant of [
      "Brief  explanation of causal relationship",
      "Brief\nexplanation of causal relationship",
      "Ｂｒｉｅｆ explanation of causal relationship",
      "  Brief explanation of causal relationship.  ",
    ]) {
      expect(isSchemaPlaceholder(variant, CAUSAL_RESIDUE)).toBe(true);
    }
  });

  // Detection removes ALL markers and then asks whether any letter or digit remains. Content
  // that merely MENTIONS a marker keeps its letters and stays content — which is the failure
  // an unconditional "contains a marker" test would produce in a coding vault.
  test("content that merely MENTIONS a template marker is not residue", () => {
    expect(isSchemaPlaceholder("the config uses ${HOME} for the path")).toBe(false);
    expect(isSchemaPlaceholder("use {{name}} in the template")).toBe(false);
  });
});

// Bug-first status, established by reconstructing the prior first-wins pre-pass and running
// it against each scenario: the differing-confidence, differing-reasoning and mixture tests
// FAIL against it and are true regression locks. The identical-repeat, conflicting-label and
// distinct-pair-order tests PASS against it — they are contract coverage for behavior that was
// already correct, kept so a future rewrite cannot silently drop it.
describe("contradiction array-level admission", () => {
  const entry = (old_idx: number, new_idx: number, over: Record<string, unknown> = {}) =>
    ({ old_idx, new_idx, relation: "contradiction",
       reasoning: "genuine conflicting claim", confidence: 0.9, ...over });

  test("a byte-identical repeat is collapsed, leaving one mutation", () => {
    const b = admitContradictionEntries([entry(0, 0), entry(0, 0)], 1, 1);
    expect(b.accepted).toHaveLength(1);
    expect(b.duplicates).toBe(1);
    expect(b.inconsistent).toBe(0);
  });

  // First-wins made the outcome depend on array order: [0.69, 0.99] kept the sub-threshold
  // entry and mutated nothing; [0.99, 0.69] mutated. Same classification, different result.
  test("same pair and label but differing confidence drops the pair, in either order", () => {
    const asc = admitContradictionEntries([entry(0, 0, { confidence: 0.69 }), entry(0, 0, { confidence: 0.99 })], 1, 1);
    const desc = admitContradictionEntries([entry(0, 0, { confidence: 0.99 }), entry(0, 0, { confidence: 0.69 })], 1, 1);
    for (const b of [asc, desc]) {
      expect(b.accepted).toHaveLength(0);
      expect(b.inconsistent).toBe(1);
    }
  });

  test("same pair and label but differing reasoning is inconsistent, not duplicate", () => {
    const b = admitContradictionEntries(
      [entry(0, 0, { reasoning: "weak evidence" }), entry(0, 0, { reasoning: "strong evidence" })], 1, 1);
    expect(b.accepted).toHaveLength(0);
    expect(b.inconsistent).toBe(1);
    expect(b.duplicates).toBe(0);
  });

  test("conflicting relation labels drop the pair whole", () => {
    const b = admitContradictionEntries(
      [entry(0, 0, { relation: "contradiction" }), entry(0, 0, { relation: "update" })], 1, 1);
    expect(b.accepted).toHaveLength(0);
    expect(b.inconsistent).toBe(1);
  });

  test("distinct pairs are unaffected and keep first-seen order", () => {
    const b = admitContradictionEntries([entry(0, 0), entry(1, 1), entry(0, 1)], 2, 2);
    expect(b.accepted).toHaveLength(3);
    expect(b.accepted.map((e: any) => `${e.old_idx}:${e.new_idx}`)).toEqual(["0:0", "1:1", "0:1"]);
    expect(b.duplicates).toBe(0);
    expect(b.inconsistent).toBe(0);
  });

  test("a three-entry mixture is admitted, collapsed and dropped independently", () => {
    const b = admitContradictionEntries([
      entry(0, 0),                              // pair A, kept
      entry(0, 0),                              // pair A, identical repeat -> collapsed
      entry(1, 1, { confidence: 0.8 }),         // pair B
      entry(1, 1, { confidence: 0.95 }),        // pair B varies -> pair dropped whole
      { relation: "update|contradiction|same", reasoning: "x", confidence: 0.9, old_idx: 0, new_idx: 0 },
    ], 2, 2);
    expect(b.accepted.map((e: any) => `${e.old_idx}:${e.new_idx}`)).toEqual(["0:0"]);
    expect(b.duplicates).toBe(1);
    expect(b.inconsistent).toBe(1);
    expect(b.rejected).toBe(1);
  });
});

describe("/no_think is applied idempotently", () => {
  // The pre-existing assertion used `.toContain("/no_think")`, which passes just as happily
  // on a DOUBLED token — so the doubling bug it was meant to cover was invisible to it.
  const occurrences = (s: string) => (s.match(/(?:^|\s)\/no_think(?=\s|$)/g) ?? []).length;

  test("a prompt already carrying the token is not given a second one", async () => {
    const { LlamaCpp } = await import("../../src/llm.ts");
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      seen.push(body.messages[0]!.content);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const llm = new LlamaCpp({ remoteLlmUrl: "http://localhost:8089" });
      await llm.generate("already ends with it /no_think");
      await llm.generate("/no_think leads this one");
      await llm.generate("carries no token at all");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(3);
    for (const content of seen) expect(occurrences(content)).toBe(1);
  });
});

describe("graph totals count the ACTIVE graph", () => {
  withStore();
  // A raw COUNT(*) over memory_relations reported edges the builders no longer operate on:
  // deactivating one endpoint left the reported total unchanged while the live graph shrank.
  test("an edge stops counting once either endpoint is deactivated", () => {
    const a = mkDoc("notes/a.md");
    const b = mkDoc("notes/b.md");
    (store as any).db.prepare(
      `INSERT INTO memory_relations (source_id, target_id, relation_type, weight, created_at)
       VALUES (?, ?, 'temporal', 1.0, ?)`,
    ).run(a, b, "2026-07-19T00:00:00.000Z");

    expect(store.countActiveRelations("temporal")).toBe(1);

    (store as any).db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(b);
    expect(store.countActiveRelations("temporal")).toBe(0);

    // ...and the SOURCE endpoint independently, which the earlier version claimed but never ran.
    (store as any).db.prepare(`UPDATE documents SET active = 1 WHERE id = ?`).run(b);
    expect(store.countActiveRelations("temporal")).toBe(1);
    (store as any).db.prepare(`UPDATE documents SET active = 0 WHERE id = ?`).run(a);
    expect(store.countActiveRelations("temporal")).toBe(0);
    (store as any).db.prepare(`UPDATE documents SET active = 1 WHERE id = ?`).run(a);

    // The row itself is untouched — this is a reporting contract, not a deletion.
    const stored = (store as any).db.prepare(
      `SELECT COUNT(*) c FROM memory_relations WHERE relation_type='temporal'`,
    ).get() as { c: number };
    expect(stored.c).toBe(1);
  });
});

// Bug-first status against the turn-8 implementation: the arbitrary-envelope and fullwidth
// tests FAIL against it (regression locks); "letters outside the marker" PASSES against it
// (contract coverage for behavior that was already correct).
describe("marker detection is envelope-based, not wrapper-enumerated", () => {
  // Enumerating wrapper characters leaked indefinitely: quotes and asterisks were covered,
  // markdown bullets, blockquotes, pipes and Unicode brackets were not. The contract is now
  // "a marker surrounded by nothing that has letters or digits".
  test("arbitrary punctuation-only envelopes around a marker are residue", () => {
    for (const s of ["> {{x}}", "- {{x}}", "|{{x}}|", "【{{x}}】", "***(([[{{x}}]]))***",
                     '___~~"${x}"~~___', "###<!--a\nb-->###", "**{{x}}**", "<${x}>"]) {
      expect(isSchemaPlaceholder(s)).toBe(true);
    }
  });

  // NFKC must run before marker detection too, or a fullwidth marker never reaches the shapes.
  test("a fullwidth marker is still a marker", () => {
    expect(isSchemaPlaceholder("｛｛x｝｝")).toBe(true);
  });

  // The "one template marker" contract was false: removing only the first match left a second
  // marker in the remainder, where it read as punctuation.
  test("multi-marker values are handled, not just the first match", () => {
    expect(isSchemaPlaceholder("${HOME}/${_}")).toBe(true);
    expect(isSchemaPlaceholder("{{a}} + {{_}}")).toBe(true);
    expect(isSchemaPlaceholder("the log path is ${HOME}/${_}")).toBe(false);
  });

  test("letters outside the marker make it content, not residue", () => {
    expect(isSchemaPlaceholder("${HOME} is the user home directory")).toBe(false);
    expect(isSchemaPlaceholder("{{a}} and {{b}} are both set")).toBe(false);
  });
});

describe("residue scope is field-sensitive", () => {
  // A marker-only value asserts nothing, so it cannot be a claim. But an identifier may
  // legitimately BE a marker: `${HOME}` is an object of `uses`, `{{user.name}}` is a
  // Handlebars path. Identifier residue is caught by consumer-scoped exact sets naming what
  // that prompt actually emitted — never by shape.
  test("marker-shaped values are rejected as claims, accepted as identifiers", () => {
    for (const v of ["${HOME}", "|${HOME}|", "{{user.name}}", "{{config_key}}", "<!--more-->"]) {
      expect(isSchemaPlaceholder(v)).toBe(true);
      expect(isSchemaPlaceholder(v, undefined, "identifier")).toBe(false);
    }
  });

  test("identifier scope rejects the exact skeleton its own prompt emits", () => {
    expect(isSchemaPlaceholder("{{optional alternative title}}", ALIAS_RESIDUE, "identifier")).toBe(true);
    expect(isSchemaPlaceholder("{{another fact's title}}", LINK_TARGET_RESIDUE, "identifier")).toBe(true);
    // ...and does not reject the OTHER consumer's skeleton — sets stay scoped.
    expect(isSchemaPlaceholder("{{another fact's title}}", ALIAS_RESIDUE, "identifier")).toBe(false);
  });

  test("identifier scope still rejects known residue strings and empty content", () => {
    expect(isSchemaPlaceholder("canonical entity name", undefined, "identifier")).toBe(true);
    expect(isSchemaPlaceholder("   ", undefined, "identifier")).toBe(true);
    expect(isSchemaPlaceholder("...", undefined, "identifier")).toBe(true);
  });

  // Normalization boundary: the live skeleton is removed in every form canonicalization folds
  // together, while a legitimate Handlebars path with the same shape survives.
  test("the link-target skeleton is caught across recasing and reformatting", () => {
    for (const v of ["{{target fact title}}", "{{Target Fact Title}}", "target fact title",
                     "  {{target  fact\ntitle}}  ", "{{another fact's title}}"]) {
      expect(isSchemaPlaceholder(v, LINK_TARGET_RESIDUE, "identifier")).toBe(true);
    }
    for (const v of ["{{user.name}}", "{{target}}", "the target fact title is X"]) {
      expect(isSchemaPlaceholder(v, LINK_TARGET_RESIDUE, "identifier")).toBe(false);
    }
  });

  test("real identifiers survive in identifier scope", () => {
    for (const v of ["ClawMem", "store.ts", "v0.28.0", "$HOME"]) {
      expect(isSchemaPlaceholder(v, ALIAS_RESIDUE, "identifier")).toBe(false);
    }
  });
});

// Bug-first status against the turn-8 implementation: the permutation test FAILS against it
// (regression lock); the three-identical-entries test PASSES against it (contract coverage).
describe("admission telemetry is permutation-invariant", () => {
  const e = (confidence: number) =>
    ({ old_idx: 0, new_idx: 0, relation: "contradiction", reasoning: "r", confidence });

  // Comparing each later entry against only the FIRST made counts depend on array order:
  // [0.9, 0.9, 0.8] reported one duplicate, [0.8, 0.9, 0.9] reported none — same multiset.
  test("every permutation of one inconsistent pair reports identically", () => {
    for (const perm of [[0.9, 0.9, 0.8], [0.8, 0.9, 0.9], [0.9, 0.8, 0.9]]) {
      const b = admitContradictionEntries(perm.map(e), 1, 1);
      expect({ acc: b.accepted.length, dup: b.duplicates, inc: b.inconsistent })
        .toEqual({ acc: 0, dup: 0, inc: 1 });
    }
  });

  test("three identical entries collapse to one acceptance and two duplicates", () => {
    const b = admitContradictionEntries([e(0.9), e(0.9), e(0.9)], 1, 1);
    expect(b.accepted).toHaveLength(1);
    expect(b.duplicates).toBe(2);
    expect(b.inconsistent).toBe(0);
  });
});

describe("identifier guards are wired into the production extraction path", () => {
  // The scope tests above call isSchemaPlaceholder directly, so deleting or mis-scoping the
  // production call sites would leave every one of them green — the same decision-boundary
  // failure this arc already hit once. This exercises the real normalization boundary.
  test("residue aliases and link targets are stripped; marker-shaped real ones survive", async () => {
    const { extractFactsFromConversation } = await import("../../src/conversation-synthesis.ts");

    const payload = [{
      title: "Switched the extractor to Bun",
      contentType: "decision",
      narrative: "The extraction pipeline moved to Bun for startup time.",
      facts: ["startup time dropped"],
      aliases: ["{{optional alternative title}}", "{{user.name}}", "Bun migration"],
      links: [
        { targetTitle: "{{target fact title}}", relationType: "semantic", weight: 0.6 },
        { targetTitle: "{{another fact's title}}", relationType: "semantic", weight: 0.6 },
        { targetTitle: "{{user.name}}", relationType: "semantic", weight: 0.6 },
        { targetTitle: "Runtime selection", relationType: "semantic", weight: 0.6 },
      ],
    }];

    const facts = await extractFactsFromConversation(stubLlm(payload) as any, "some conversation", 1);
    expect(facts).not.toBeNull();
    expect(facts).toHaveLength(1);
    const fact = facts?.[0];
    if (!fact) throw new Error("expected exactly one extracted fact");

    // Residue removed, legitimate marker-shaped identifiers kept.
    expect(fact.aliases).toEqual(["{{user.name}}", "Bun migration"]);
    expect(fact.links?.map(l => l.targetTitle)).toEqual(["{{user.name}}", "Runtime selection"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — the contradiction WRITE path.
//
// Everything above guards what reaches the mutation boundary. These cover the boundary itself,
// which had no coverage at all because it was only reachable through a live model call. Two
// contract defects sat there: the parse gate rejected the deployed model's response envelope,
// and the document lookup was handed a `clawmem://` URI where it matched a bare `path` column,
// so no classification could resolve a row in any shipped version.
// ---------------------------------------------------------------------------

describe("contradiction parse gate accepts the model's response envelope", () => {
  test("bare array passes through unchanged", () => {
    const arr = [{ old_idx: 0, new_idx: 0, relation: "contradiction" }];
    expect(unwrapContradictionArray(arr)).toBe(arr);
  });

  test("{result: [...]} is unwrapped to the inner array", () => {
    const inner = [{ old_idx: 0, new_idx: 0, relation: "contradiction" }];
    expect(unwrapContradictionArray({ result: inner })).toBe(inner);
  });

  test("empty wrapped array unwraps — an explicit 'no contradictions' is not malformed", () => {
    expect(unwrapContradictionArray({ result: [] })).toEqual([]);
  });

  // The caller decides malformed-ness with `!Array.isArray(parsed)`. Anything this helper cannot
  // unwrap must therefore come back UNCHANGED, or a genuinely broken response would be swallowed
  // as an empty classification instead of reported.
  test.each([
    ["object with no result key", { foo: 1 }],
    ["result present but not an array", { result: "nope" }],
    ["result explicitly null", { result: null }],
    ["nested one level too deep", { result: { result: [] } }],
    ["bare string", "not json at all"],
    ["null", null],
  ])("%s is returned unchanged so the caller still rejects it", (_label, input) => {
    const out = unwrapContradictionArray(input);
    expect(out).toEqual(input as any);
    expect(Array.isArray(out)).toBe(false);
  });
});

describe("contradiction write path — target resolution and eligibility", () => {
  withStore();

  const ARMED = "CLAWMEM_CONTRADICTION_INVALIDATE";

  function mkTypedDoc(path: string, contentType: string, confidence: number): number {
    const id = mkDoc(path);
    (store as any).updateDocumentMeta(id, { content_type: contentType, confidence });
    return id;
  }

  /**
   * Candidates come from the REAL search projection, not a hand-built literal — the defect was a
   * mismatch between what `searchFTS` emits as `filepath` and what `findActiveDocument` matches,
   * so a test that constructs the URI itself would only assert my reading of the contract.
   */
  function candidateFor(path: string) {
    const hit = searchFTS((store as any).db, "body", 50)
      .find(r => r.filepath.endsWith(`/${path}`));
    if (!hit) throw new Error(`searchFTS did not return a candidate for ${path}`);
    return hit;
  }

  const entry = (overrides: Record<string, unknown> = {}) => ({
    old_idx: 0, new_idx: 0, relation: "contradiction", confidence: 0.9, reasoning: "r", ...overrides,
  });

  const invalidatedAt = (id: number) =>
    ((store as any).db.prepare(`SELECT invalidated_at FROM documents WHERE id = ?`)
      .get(id) as { invalidated_at: string | null }).invalidated_at;

  const confidenceOf = (id: number) =>
    ((store as any).db.prepare(`SELECT confidence FROM documents WHERE id = ?`)
      .get(id) as { confidence: number }).confidence;

  test("a NESTED virtual path resolves to the intended row and lowers its confidence", () => {
    // Multi-segment path: the collection boundary is the FIRST slash, everything after is the
    // bare path. Handing the whole URI to findActiveDocument matched nothing — that was the bug.
    const id = mkTypedDoc("observations/2026/07/alpha.md", "observation", 0.8);
    const cand = candidateFor("observations/2026/07/alpha.md");
    expect(cand.filepath).toStartWith("clawmem://");

    const out = applyContradictionOutcomes(store, [entry()], [cand], ["new fact"], [null, null]);

    expect(out.contradictions).toBe(1);
    expect(out.unparseableTarget).toBe(0);
    expect(out.missingTarget).toBe(0);
    expect(confidenceOf(id)).toBeCloseTo(0.55, 5);
  });

  test("unarmed: an eligible doc reaches the floor but is NOT invalidated", () => {
    delete process.env[ARMED];
    const id = mkTypedDoc("observations/beta.md", INVALIDATION_ELIGIBLE_CONTENT_TYPE, 0.45);
    const out = applyContradictionOutcomes(
      store, [entry()], [candidateFor("observations/beta.md")], ["f"], [null, null]);

    expect(confidenceOf(id)).toBeCloseTo(0.2, 5);
    expect(invalidatedAt(id)).toBeNull();
    expect(out.shadowInvalidations).toBe(1);
    expect(out.invalidated).toBe(0);
  });

  test("armed: exactly one eligible row is invalidated", () => {
    process.env[ARMED] = "true";
    try {
      const id = mkTypedDoc("observations/gamma.md", INVALIDATION_ELIGIBLE_CONTENT_TYPE, 0.45);
      const out = applyContradictionOutcomes(
        store, [entry()], [candidateFor("observations/gamma.md")], ["f"], [null, null]);

      expect(out.invalidated).toBe(1);
      expect(out.shadowInvalidations).toBe(0);
      expect(out.invalidationNoOp).toBe(0);
      expect(invalidatedAt(id)).not.toBeNull();
    } finally {
      delete process.env[ARMED];
    }
  });

  test("any value other than exactly 'true' leaves the writer unarmed", () => {
    process.env[ARMED] = "TRUE";
    try {
      const id = mkTypedDoc("observations/delta.md", INVALIDATION_ELIGIBLE_CONTENT_TYPE, 0.45);
      const out = applyContradictionOutcomes(
        store, [entry()], [candidateFor("observations/delta.md")], ["f"], [null, null]);
      expect(out.shadowInvalidations).toBe(1);
      expect(invalidatedAt(id)).toBeNull();
    } finally {
      delete process.env[ARMED];
    }
  });

  // The defect this locks: candidates are selected by PATHNAME, but only one content_type can
  // ever be invalidated. Reporting an intent the armed writer cannot honour would aim shadow-mode
  // calibration at the wrong population — on the reference vault, ~2/3 of candidates.
  test("an ineligible content_type at the floor is neither shadowed nor invalidated — armed OR not", () => {
    for (const armed of [false, true]) {
      if (armed) process.env[ARMED] = "true"; else delete process.env[ARMED];
      try {
        const path = `observations/decision-${armed}.md`;
        const id = mkTypedDoc(path, "decision", 0.45);
        const out = applyContradictionOutcomes(
          store, [entry()], [candidateFor(path)], ["f"], [null, null]);

        expect(out.floorIneligible).toBe(1);
        expect(out.shadowInvalidations).toBe(0);
        expect(out.invalidated).toBe(0);
        expect(invalidatedAt(id)).toBeNull();
        // Erosion is NOT gated on eligibility — the ranking signal still applies.
        expect(confidenceOf(id)).toBeCloseTo(0.2, 5);
      } finally {
        delete process.env[ARMED];
      }
    }
  });

  test("a malformed virtual path and a missing row are counted separately", () => {
    mkTypedDoc("observations/eps.md", "observation", 0.8);
    const cand = candidateFor("observations/eps.md");

    const unparseable = { ...candidateFor("observations/eps.md"), filepath: "not-a-virtual-path" };
    const missing = { ...cand, filepath: "clawmem://_clawmem/observations/never-existed.md" };

    const out = applyContradictionOutcomes(
      store,
      [entry({ old_idx: 0 }), entry({ old_idx: 1 })],
      [unparseable as any, missing as any],
      ["f"],
      [null, null],
    );

    // Collapsing these into one counter would hide a URI-contract regression behind an
    // ordinary archived-document race.
    expect(out.unparseableTarget).toBe(1);
    expect(out.missingTarget).toBe(1);
    expect(out.contradictions).toBe(0);
  });

  test("the 'update' relation uses its own 0.3 floor and never invalidates", () => {
    process.env[ARMED] = "true";
    try {
      const id = mkTypedDoc("observations/zeta.md", INVALIDATION_ELIGIBLE_CONTENT_TYPE, 0.35);
      const out = applyContradictionOutcomes(
        store, [entry({ relation: "update" })], [candidateFor("observations/zeta.md")], ["f"], [null, null]);

      expect(confidenceOf(id)).toBeCloseTo(0.3, 5);
      expect(out.invalidated).toBe(0);
      expect(invalidatedAt(id)).toBeNull();
    } finally {
      delete process.env[ARMED];
    }
  });

  test("a second contradiction against an already-invalidated row is a no-op, not a double write", () => {
    process.env[ARMED] = "true";
    try {
      const id = mkTypedDoc("observations/eta.md", INVALIDATION_ELIGIBLE_CONTENT_TYPE, 0.45);
      const cand = candidateFor("observations/eta.md");
      applyContradictionOutcomes(store, [entry()], [cand], ["f"], [null, null]);
      const firstStamp = invalidatedAt(id);
      expect(firstStamp).not.toBeNull();

      const second = applyContradictionOutcomes(store, [entry()], [cand], ["f"], [null, null]);
      // isInvalidationEligible excludes already-invalidated rows, so this stops before the write.
      expect(second.invalidated).toBe(0);
      expect(second.floorIneligible).toBe(1);
      expect(invalidatedAt(id)).toBe(firstStamp);
    } finally {
      delete process.env[ARMED];
    }
  });
});

describe("contradiction response — the production-wired unwrap → admit → apply path", () => {
  withStore();

  // The pure-helper tests above would stay green if the unwrap call were deleted from the
  // production path entirely. These drive the seam production actually calls, so the wiring
  // itself is under test — not just the function it is supposed to call.
  function seed(path: string, confidence: number) {
    const id = mkDoc(path);
    (store as any).updateDocumentMeta(id, {
      content_type: INVALIDATION_ELIGIBLE_CONTENT_TYPE, confidence,
    });
    const cand = searchFTS((store as any).db, "body", 50).find(r => r.filepath.endsWith(`/${path}`))!;
    return { id, cand };
  }
  const conf = (id: number) =>
    ((store as any).db.prepare(`SELECT confidence FROM documents WHERE id = ?`)
      .get(id) as { confidence: number }).confidence;

  const REL = [{ old_idx: 0, new_idx: 0, relation: "contradiction", confidence: 0.9, reasoning: "r" }];

  test("a WRAPPED response reaches the mutation and lowers confidence", () => {
    const { id, cand } = seed("observations/wrapped.md", 0.8);
    const out = applyContradictionResponse(store, { result: REL }, [cand], ["f"], [null]);

    expect(out.parseFailed).toBe(false);
    expect(out.outcomes.contradictions).toBe(1);
    expect(conf(id)).toBeCloseTo(0.55, 5);
  });

  test("a BARE-array response behaves identically", () => {
    const { id, cand } = seed("observations/bare.md", 0.8);
    const out = applyContradictionResponse(store, REL, [cand], ["f"], [null]);

    expect(out.parseFailed).toBe(false);
    expect(out.outcomes.contradictions).toBe(1);
    expect(conf(id)).toBeCloseTo(0.55, 5);
  });

  test("an unwrappable root mutates nothing and reports its shape", () => {
    const { id, cand } = seed("observations/broken.md", 0.8);
    const out = applyContradictionResponse(store, { nope: 1 }, [cand], ["f"], [null]);

    expect(out.parseFailed).toBe(true);
    expect(out.parsedCategory).toBe("object");
    expect(out.outcomes.contradictions).toBe(0);
    expect(conf(id)).toBeCloseTo(0.8, 5);
  });

  test("invalidated_by names the fact's OWN source document, not the newest in the session", () => {
    process.env.CLAWMEM_CONTRADICTION_INVALIDATE = "true";
    try {
      const srcA = mkDoc("observations/src-a.md");
      const srcB = mkDoc("observations/src-b.md");
      const { id, cand } = seed("observations/victim.md", 0.45);

      // new_idx=1 → the SECOND fact, whose source is srcB. The previous implementation ignored
      // new_idx and took the newest session document, so both facts attributed to the same row.
      applyContradictionResponse(
        store,
        [{ old_idx: 0, new_idx: 1, relation: "contradiction", confidence: 0.9, reasoning: "r" }],
        [cand], ["fact from A", "fact from B"], [srcA, srcB],
      );

      const row = (store as any).db.prepare(
        `SELECT invalidated_by FROM documents WHERE id = ?`).get(id) as { invalidated_by: number | null };
      expect(row.invalidated_by).toBe(srcB);
      expect(row.invalidated_by).not.toBe(srcA);
    } finally {
      delete process.env.CLAWMEM_CONTRADICTION_INVALIDATE;
    }
  });

  test("an unattributable fact records a null source rather than guessing one", () => {
    process.env.CLAWMEM_CONTRADICTION_INVALIDATE = "true";
    try {
      const { id, cand } = seed("observations/orphan.md", 0.45);
      applyContradictionResponse(store, REL, [cand], ["f"], [null]);

      const row = (store as any).db.prepare(
        `SELECT invalidated_at, invalidated_by FROM documents WHERE id = ?`)
        .get(id) as { invalidated_at: string | null; invalidated_by: number | null };
      expect(row.invalidated_at).not.toBeNull();
      expect(row.invalidated_by).toBeNull();
    } finally {
      delete process.env.CLAWMEM_CONTRADICTION_INVALIDATE;
    }
  });
});

describe("contradiction write path — armed-write failure branches", () => {
  withStore();

  // `invalidationNoOp` and `invalidationErrors` are only reachable when the row changes under
  // the write, or the write throws. Both are races against a live database, so they are driven
  // through a store whose UPDATE behaves that way rather than by contriving vault state.
  function storeWithUpdate(run: () => { changes: number }) {
    const real = store as any;
    return {
      ...real,
      db: {
        prepare: (sql: string) => {
          if (sql.includes("SET invalidated_at")) return { run, get: () => undefined };
          return real.db.prepare(sql);
        },
      },
      findActiveDocument: real.findActiveDocument.bind(real),
      updateDocumentMeta: real.updateDocumentMeta.bind(real),
    } as any;
  }

  const REL = [{ old_idx: 0, new_idx: 0, relation: "contradiction", confidence: 0.9, reasoning: "r" }];

  function seededCandidate(path: string, confidence = 0.45) {
    const id = mkDoc(path);
    (store as any).updateDocumentMeta(id, {
      content_type: INVALIDATION_ELIGIBLE_CONTENT_TYPE, confidence,
    });
    const cand = searchFTS((store as any).db, "body", 50).find(r => r.filepath.endsWith(`/${path}`))!;
    return { id, cand };
  }
  const confOf = (id: number) =>
    ((store as any).db.prepare(`SELECT confidence FROM documents WHERE id = ?`)
      .get(id) as { confidence: number }).confidence;

  test("a zero-row armed write is counted, not read as a success", () => {
    process.env.CLAWMEM_CONTRADICTION_INVALIDATE = "true";
    try {
      const { cand } = seededCandidate("observations/raced.md");
      const out = applyContradictionOutcomes(
        storeWithUpdate(() => ({ changes: 0 })), REL, [cand], ["f"], [null]);

      expect(out.invalidationNoOp).toBe(1);
      expect(out.invalidated).toBe(0);
    } finally {
      delete process.env.CLAWMEM_CONTRADICTION_INVALIDATE;
    }
  });

  test("a throwing armed write is counted and the REST of the batch still runs", () => {
    process.env.CLAWMEM_CONTRADICTION_INVALIDATE = "true";
    try {
      // Two verdicts: the first drives an invalidation that throws, the second is an ordinary
      // update on a different document. Asserting only the first would leave a `return out` in
      // the catch block undetected — the error would be counted while the batch silently aborted.
      const first = seededCandidate("observations/throws.md", 0.45);
      const second = seededCandidate("observations/survivor.md", 0.8);

      const out = applyContradictionOutcomes(
        storeWithUpdate(() => { throw new Error("database is locked"); }),
        [
          { old_idx: 0, new_idx: 0, relation: "contradiction", confidence: 0.9, reasoning: "r" },
          { old_idx: 1, new_idx: 0, relation: "update", confidence: 0.9, reasoning: "r" },
        ],
        [first.cand, second.cand], ["f"], [null],
      );

      expect(out.invalidationErrors).toBe(1);
      expect(out.invalidated).toBe(0);
      // The erosion ahead of the failed write stands...
      expect(out.contradictions).toBe(1);
      expect(confOf(first.id)).toBeCloseTo(0.2, 5);
      // ...and the SECOND verdict was still applied, which is what proves the loop continued.
      expect(confOf(second.id)).toBeCloseTo(0.65, 5);
    } finally {
      delete process.env.CLAWMEM_CONTRADICTION_INVALIDATE;
    }
  });
});
