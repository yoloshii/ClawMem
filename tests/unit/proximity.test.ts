/**
 * §51.6 proximity-bucket re-rank — unit matrix for src/proximity.ts.
 *
 * Buckets are internal; every assertion observes them through ORDERING:
 * rows are fed in deliberately-wrong prior order and the test asserts where
 * the stable (bucket, prior-rank) sort puts them. Synthetic fixtures only —
 * the frozen s49.2 bundle is never touched here (pre-registration blindness).
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  proximityRerank,
  proximityRerankDetailed,
  proximityBuckets,
  PROXIMITY_WINDOW_SLACK,
  __proximityOracleForTests,
  type ProximityRow,
} from "../../scripts/proximity.ts";

const row = (displayPath: string, title: string | null, body: string | null): ProximityRow => ({
  displayPath,
  title,
  body,
});
const paths = (rows: ProximityRow[]) => rows.map(r => r.displayPath);

describe("proximityRerank — no-op guarantees", () => {
  test("single-token query preserves order exactly (donor invariant)", () => {
    const rows = [
      row("a/scattered.md", "x", "alpha here"),
      row("a/exact.md", "alpha", "alpha alpha"),
      row("a/none.md", "y", "unrelated"),
    ];
    const out = proximityRerank(rows, "alpha");
    expect(paths(out)).toEqual(["a/scattered.md", "a/exact.md", "a/none.md"]);
    expect(out).not.toBe(rows); // new array, same order
  });

  test("sub-2-row input and empty input are order-preserving copies", () => {
    const one = [row("a/x.md", "t", "alpha beta")];
    expect(paths(proximityRerank(one, "alpha beta"))).toEqual(["a/x.md"]);
    expect(proximityRerank([], "alpha beta")).toEqual([]);
  });

  test("symbol-only query (zero tokens) is a no-op", () => {
    const rows = [row("a/b.md", "t", "x"), row("a/c.md", "t", "y")];
    expect(paths(proximityRerank(rows, "-- // !!"))).toEqual(["a/b.md", "a/c.md"]);
  });

  test("slack constant is the donor value", () => {
    expect(PROXIMITY_WINDOW_SLACK).toBe(4);
  });
});

describe("proximityRerank — bucket ordering", () => {
  test("contiguous-in-order (bucket 0) beats reversed-order window (bucket 1)", () => {
    const windowed = row("a/reversed.md", null, "sync ledger setup notes");
    const phrase = row("a/phrase.md", null, "the ledger sync procedure");
    const out = proximityRerank([windowed, phrase], "ledger sync");
    expect(paths(out)).toEqual(["a/phrase.md", "a/reversed.md"]);
  });

  test("stems + prefix make 'synchronization egress' contiguous for query 'sync egress'", () => {
    const filler = "alpha bravo charlie delta echo foxtrot golf hotel";
    const scattered = row("a/decoy.md", null, `sync ${filler} egress`);
    const stemmed = row("a/stemmed.md", null, "synchronization egress tunnel");
    const out = proximityRerank([scattered, stemmed], "sync egress");
    expect(paths(out)).toEqual(["a/stemmed.md", "a/decoy.md"]);
  });

  test("query-side stemming: 'configurations tunnel' finds 'configure tunnel' contiguously", () => {
    const scattered = row("a/far.md", null, "configure the network and later the tunnel plus more words after");
    const target = row("a/near.md", null, "configure tunnel");
    const out = proximityRerank([scattered, target], "configurations tunnel");
    expect(paths(out)).toEqual(["a/near.md", "a/far.md"]);
  });

  test("window boundary: span n+slack is bucket 1, span n+slack+1 is bucket 2", () => {
    // n=2, slack=4 → spans of 6 vs 7 doc tokens.
    const inWindow = row("a/span6.md", null, "alpha w1 w2 w3 w4 beta");
    const outWindow = row("a/span7.md", null, "alpha w1 w2 w3 w4 w5 beta");
    const out = proximityRerank([outWindow, inWindow], "alpha beta");
    expect(paths(out)).toEqual(["a/span6.md", "a/span7.md"]);
  });

  test("absent token is bucket 2 even when the present token repeats", () => {
    const absent = row("a/absent.md", null, "alpha alpha alpha alpha");
    const windowed = row("a/win.md", null, "alpha w1 w2 beta");
    const out = proximityRerank([absent, windowed], "alpha beta");
    expect(paths(out)).toEqual(["a/win.md", "a/absent.md"]);
  });

  test("tokens split across columns with no single column holding all = bucket 2", () => {
    const split = row("a/split.md", "alpha only here", "beta only here");
    const together = row("a/together.md", null, "alpha beta");
    const out = proximityRerank([split, together], "alpha beta");
    expect(paths(out)).toEqual(["a/together.md", "a/split.md"]);
    // and the split row does NOT out-rank another bucket-2 row that came first
    const scattered = row("a/scat.md", null, `alpha ${"x ".repeat(9)}beta`);
    const out2 = proximityRerank([scattered, split, together], "alpha beta");
    expect(paths(out2)).toEqual(["a/together.md", "a/scat.md", "a/split.md"]);
  });

  test("filepath slug counts as a column: path phrase beats body window", () => {
    const slug = row("memory/ledger-sync-egress-tunnel.md", "Sync notes", "unrelated content");
    const bodyWin = row("notes/other.md", null, "ledger w1 w2 sync");
    const out = proximityRerank([bodyWin, slug], "ledger sync");
    expect(paths(out)).toEqual(["memory/ledger-sync-egress-tunnel.md", "notes/other.md"]);
  });

  test("duplicate query tokens canonicalize: 'sync sync tunnel' behaves as 'sync tunnel'", () => {
    // FTS's `"sync"* AND "sync"* AND "tunnel"*` is satisfied by ONE sync occurrence,
    // so the effective constraint set is [sync, tunnel] and both docs are bucket 0.
    const single = row("a/single.md", null, "sync tunnel");
    const doubled = row("a/doubled.md", null, "sync sync tunnel");
    const out = proximityRerank([single, doubled], "sync sync tunnel");
    expect(paths(out)).toEqual(["a/single.md", "a/doubled.md"]); // input order preserved
  });
});

describe("proximityRerank — effective-constraint canonicalization (ordered antichain)", () => {
  test("stem-collapsing token pair is a single effective constraint → no-op", () => {
    // "configure" and "configurations" both stem to `configur`; the AND is one
    // constraint, so proximity does not apply and the prior order is preserved
    // even though re-ranking would otherwise promote the second row.
    const scattered = row("a/far.md", null, `configure ${"x ".repeat(9)}end`);
    const tight = row("a/tight.md", null, "configuration here");
    const out = proximityRerank([scattered, tight], "configure configurations");
    expect(paths(out)).toEqual(["a/far.md", "a/tight.md"]);
  });

  test("a stem prefixing a more specific stem is dropped from the constraint set", () => {
    // Query "sync synchronization egress": `sync` prefixes `synchron`, so the
    // effective constraints are [synchron, egress]. A doc holding only the bare
    // token "sync" cannot satisfy `synchron` and buckets as scattered/absent.
    const bare = row("a/bare.md", null, "sync egress");
    const full = row("a/full.md", null, "synchronization egress");
    const out = proximityRerank([bare, full], "sync synchronization egress");
    expect(paths(out)).toEqual(["a/full.md", "a/bare.md"]);
  });

  test("structural filepath tokens (extension, directories) participate, as they do in MATCH", () => {
    // Query "notes md": the filepath column of "notes/other.md" tokenizes to
    // [note, other, md] — a window hit via filepath alone. Documented hazard
    // behavior: the re-ranker sees exactly what FTS matched, path tokens included.
    const pathOnly = row("notes/other.md", "unrelated", "unrelated");
    const absent = row("misc/thing.txt", "unrelated", "unrelated");
    const out = proximityRerank([absent, pathOnly], "notes md");
    expect(paths(out)).toEqual(["notes/other.md", "misc/thing.txt"]);
  });

  test("null title and body: filepath column alone can carry bucket 0", () => {
    const slugOnly = row("memory/ledger-sync-egress.md", null, null);
    const windowed = row("notes/w.md", null, "ledger w1 w2 sync");
    const out = proximityRerank([windowed, slugOnly], "ledger sync");
    expect(paths(out)).toEqual(["memory/ledger-sync-egress.md", "notes/w.md"]);
  });
});

describe("proximityRerank — permutation + stability", () => {
  test("output is a permutation: same rows, nothing dropped, added, or rescored", () => {
    const rows = [
      row("a/1.md", null, "beta alpha"),
      row("a/2.md", null, "alpha beta"),
      row("a/3.md", "alpha", "no second token"),
      row("a/4.md", null, `alpha ${"x ".repeat(10)}beta`),
      row("a/5.md", null, "alpha w beta"),
    ];
    const out = proximityRerank(rows, "alpha beta");
    expect(out.length).toBe(rows.length);
    expect([...paths(out)].sort()).toEqual([...paths(rows)].sort());
    for (const r of out) expect(rows).toContain(r); // same row objects, untouched
  });

  test("within a bucket, prior order is preserved (explicit index tie-break)", () => {
    const first = row("a/first.md", null, "alpha beta gamma");
    const second = row("a/second.md", null, "alpha beta delta");
    const out = proximityRerank([first, second], "alpha beta");
    expect(paths(out)).toEqual(["a/first.md", "a/second.md"]);
  });

  test("scratch state does not leak across invocations", () => {
    const call1 = proximityRerank(
      [row("a/reversed.md", null, "sync ledger"), row("a/phrase.md", null, "ledger sync")],
      "ledger sync"
    );
    expect(paths(call1)).toEqual(["a/phrase.md", "a/reversed.md"]);
    // second call with entirely different rows/query — then repeat call 1 verbatim
    proximityRerank([row("b/x.md", null, "alpha beta"), row("b/y.md", null, "beta alpha")], "alpha beta");
    const call3 = proximityRerank(
      [row("a/reversed.md", null, "sync ledger"), row("a/phrase.md", null, "ledger sync")],
      "ledger sync"
    );
    expect(paths(call3)).toEqual(["a/phrase.md", "a/reversed.md"]);
  });

  test("buckets expose the winning column for reporting", () => {
    const infos = proximityBuckets(
      [row("memory/ledger-sync.md", null, "unrelated body"), row("notes/w.md", null, "ledger w1 w2 sync")],
      "ledger sync"
    );
    expect(infos).not.toBeNull();
    expect(infos![0]).toEqual({ bucket: 0, col: "filepath" });
    expect(infos![1]).toEqual({ bucket: 1, col: "body" });
  });
});

describe("proximityRerankDetailed — status discrimination (eval must not confuse failure with no-op)", () => {
  const rows = () => [
    row("a/reversed.md", null, "sync ledger"),
    row("a/phrase.md", null, "ledger sync"),
  ];

  test("applied vs inapplicable are distinguished", () => {
    expect(proximityRerankDetailed(rows(), "ledger sync").status).toBe("applied");
    expect(proximityRerankDetailed(rows(), "ledger").status).toBe("inapplicable"); // single token
    expect(proximityRerankDetailed([rows()[0]!], "ledger sync").status).toBe("inapplicable"); // sub-2 rows
    expect(proximityRerankDetailed(rows(), "configure configurations").status).toBe("inapplicable"); // 1 effective constraint
  });

  test("applied outcome carries buckets aligned to INPUT order; others carry null", () => {
    const d = proximityRerankDetailed(rows(), "ledger sync");
    expect(d.buckets!.map(b => b.bucket)).toEqual([1, 0]); // input order, not output order
    expect(paths(d.rows)).toEqual(["a/phrase.md", "a/reversed.md"]);
    expect(proximityRerankDetailed(rows(), "ledger").buckets).toBeNull();
  });

  test("oracle failure reports status 'oracle-failure' with order preserved, then self-heals", () => {
    __proximityOracleForTests(new Database(":memory:")); // no scratch tables
    try {
      const d = proximityRerankDetailed(rows(), "ledger sync");
      expect(d.status).toBe("oracle-failure");
      expect(d.buckets).toBeNull();
      expect(paths(d.rows)).toEqual(["a/reversed.md", "a/phrase.md"]);
      expect(proximityRerankDetailed(rows(), "ledger sync").status).toBe("applied"); // self-healed
    } finally {
      __proximityOracleForTests(null); // hygiene only
    }
  });
});

describe("proximityRerank — oracle fail-open (search must never break)", () => {
  const reorderable = () => [
    row("a/reversed.md", null, "sync ledger"),
    row("a/phrase.md", null, "ledger sync"),
  ];

  test("oracle missing its scratch tables → fail-open, then SELF-recovers on the next call", () => {
    __proximityOracleForTests(new Database(":memory:")); // no px/pxq tables
    try {
      const out = proximityRerank(reorderable(), "ledger sync");
      expect(paths(out)).toEqual(["a/reversed.md", "a/phrase.md"]); // fail-open: unchanged
      // NO seam reset here — the catch path must have dropped the broken oracle
      // itself, so the very next call lazily recreates and functions.
      const recovered = proximityRerank(reorderable(), "ledger sync");
      expect(paths(recovered)).toEqual(["a/phrase.md", "a/reversed.md"]);
    } finally {
      __proximityOracleForTests(null); // hygiene only
    }
  });

  test("closed oracle connection → fail-open, then SELF-recovers on the next call", () => {
    const dead = new Database(":memory:");
    dead.close();
    __proximityOracleForTests(dead);
    try {
      const out = proximityRerank(reorderable(), "ledger sync");
      expect(paths(out)).toEqual(["a/reversed.md", "a/phrase.md"]);
      expect(proximityBuckets(reorderable(), "ledger sync")).not.toBeNull(); // self-healed already
      const recovered = proximityRerank(reorderable(), "ledger sync");
      expect(paths(recovered)).toEqual(["a/phrase.md", "a/reversed.md"]);
    } finally {
      __proximityOracleForTests(null); // hygiene only
    }
  });
});
