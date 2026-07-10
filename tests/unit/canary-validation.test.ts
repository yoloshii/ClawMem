import { describe, it, expect } from "bun:test";

/**
 * VSEARCH-TRUST-HARDENING (d) + (f) regressions:
 *   - geometry canary: healthy pass / collapsed fail (WRONG-but-stable geometry — the
 *     2026-07-10 class a self-similarity check cannot see) / drift fail (2026-06-22 class)
 *     / unavailable endpoint / baseline-calibrated floors
 *   - sampled vector validation: fingerprinted full tier (pass, stale-input, corruption),
 *     legacy structural tier (pass, inconclusive — never silently green), small-vault
 *     population scaling, definitive failures nonzero regardless of coverage
 *   - busy-retry helper: retries SQLITE_BUSY only, bounded, lease-loss aborts
 *   - lease-fenced embed-state markers: stale token rejected
 */

import {
  runCanaryBattery,
  canaryProbeInputs,
  canaryMargins,
  canaryProfileKey,
  canaryGate,
  persistCanaryBaselineIfFirst,
  runSampledVectorValidation,
  cosineSim,
} from "../../src/canary.ts";
import { retryOnBusyAsync, isSqliteBusyError } from "../../src/busy-retry.ts";
import { createStore, canonicalDocId, EmbedLeaseLostError, type Store } from "../../src/store.ts";
import { acquireWorkerLease } from "../../src/worker-lease.ts";
import { hashContent } from "../../src/indexer.ts";
import { formatDocForEmbedding } from "../../src/llm.ts";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Canary battery
// ---------------------------------------------------------------------------

/** Healthy fake embedder: related/echo/term/trunc pairs close, unrelated far. */
function healthyEmbed(text: string): { embedding: Float32Array; model: string } {
  // Deterministic direction per SEMANTIC bucket, tiny per-text jitter.
  const inputs = canaryProbeInputs();
  let bucket = 0; // default
  for (const [id, t] of inputs) {
    if (t === text) {
      bucket = id === "unrel" ? 1 : id.startsWith("rel") ? 2 : 3; // unrel orthogonal; rel + tech/term/trunc two clusters
      break;
    }
  }
  const jitter = (createHash("sha256").update(text).digest()[0]! / 255) * 0.05;
  const base = bucket === 1 ? [0, 1, 0, 0] : bucket === 2 ? [1, 0, 0, 0] : [0.9, 0, 0.45, 0];
  const v = new Float32Array([base[0]! + jitter, base[1]!, base[2]!, base[3]! + jitter * 0.5]);
  return { embedding: v, model: "fake" };
}

/** Collapsed fake embedder: EVERY text maps to (nearly) the same vector — self-sim stays ~1.0. */
function collapsedEmbed(text: string): { embedding: Float32Array; model: string } {
  const jitter = (createHash("sha256").update(text).digest()[0]! / 255) * 0.0001;
  return { embedding: new Float32Array([1, jitter, 0, 0]), model: "fake" };
}

describe("geometry canary battery", () => {
  it("passes on healthy separation and reports margins", async () => {
    const out = await runCanaryBattery(async t => healthyEmbed(t), () => null);
    if ("unavailable" in out) throw new Error("unexpected unavailable");
    expect(out.pass).toBe(true);
    expect(out.margins.m_rel!).toBeGreaterThan(0.1);
    expect(out.profileKey).toBe(canaryProfileKey("fake", 4));
    expect(out.driftChecked).toBe(false);
  });

  it("FAILS on collapsed (wrong-but-stable) geometry — the class self-similarity cannot see", async () => {
    const out = await runCanaryBattery(async t => collapsedEmbed(t), () => null);
    if ("unavailable" in out) throw new Error("unexpected unavailable");
    expect(out.pass).toBe(false);
    expect(out.failures.length).toBeGreaterThan(0);
  });

  it("FAILS drift when the server changed since the stored baseline", async () => {
    const healthy = await runCanaryBattery(async t => healthyEmbed(t), () => null);
    if ("unavailable" in healthy) throw new Error("unavailable");
    // New server: healthy separation but a ROTATED space (drifted vs baseline).
    const rotated = (t: string) => {
      const v = healthyEmbed(t).embedding;
      return { embedding: new Float32Array([v[1]!, v[0]!, v[3]!, v[2]!]), model: "fake" };
    };
    const out = await runCanaryBattery(async t => rotated(t), key => key === healthy.profileKey ? { probes: healthy.vectors, pairMargins: healthy.margins } : null);
    if ("unavailable" in out) throw new Error("unavailable");
    expect(out.driftChecked).toBe(true);
    expect(out.pass).toBe(false);
    expect(out.failures.some(f => f.startsWith("drift:"))).toBe(true);
  });

  it("reports unavailable (not failure) when the endpoint cannot embed", async () => {
    const out = await runCanaryBattery(async () => null, () => null);
    expect("unavailable" in out).toBe(true);
  });

  it("FAILS on mixed dimensions/models across one battery (flapping endpoint, T8-H1)", async () => {
    let n = 0;
    const flapping = async (t: string) => {
      n++;
      return n % 2 === 0
        ? { embedding: new Float32Array(4).fill(1), model: "model-a" }
        : { embedding: new Float32Array(8).fill(1), model: "model-b" };
    };
    const out = await runCanaryBattery(flapping, () => null);
    if ("unavailable" in out) throw new Error("unexpected unavailable");
    expect(out.pass).toBe(false);
    expect(out.failures.some(f => f.includes("mixed dimensions") || f.includes("mixed models"))).toBe(true);
  });
});

describe("canaryGate — fail-closed for destructive runs (T8-H1)", () => {
  const unavailable = { unavailable: true as const, reason: "down" };
  const failed = { pass: false, failures: ["m_rel low"], margins: {}, vectors: new Map(), profileKey: "p", driftChecked: false };
  const passed = { ...failed, pass: true, failures: [] };

  it("unavailable + --force → abort (a clear must never proceed unvalidated)", () => {
    expect(canaryGate(unavailable, { force: true, forceGeometry: false }).action).toBe("abort");
  });
  it("unavailable + --force + --force-geometry → warn (explicit override)", () => {
    expect(canaryGate(unavailable, { force: true, forceGeometry: true }).action).toBe("warn");
  });
  it("unavailable + incremental → warn (nothing destructive happens first)", () => {
    expect(canaryGate(unavailable, { force: false, forceGeometry: false }).action).toBe("warn");
  });
  it("failed battery → abort on ANY run unless --force-geometry", () => {
    expect(canaryGate(failed, { force: false, forceGeometry: false }).action).toBe("abort");
    expect(canaryGate(failed, { force: true, forceGeometry: false }).action).toBe("abort");
    expect(canaryGate(failed, { force: true, forceGeometry: true }).action).toBe("warn");
  });
  it("pass → proceed", () => {
    expect(canaryGate(passed, { force: true, forceGeometry: false }).action).toBe("proceed");
  });
});

describe("recalibration mode — intrinsic sanity only (T9-M3)", () => {
  it("a healthy NEW geometry drift-fails against the old baseline but passes with ignoreBaseline", async () => {
    const healthy = await runCanaryBattery(async t => healthyEmbed(t), () => null);
    if ("unavailable" in healthy) throw new Error("unavailable");
    // Rotated space: intrinsically healthy, but drifted relative to the stored baseline.
    const rotated = (t: string) => {
      const v = healthyEmbed(t).embedding;
      return { embedding: new Float32Array([v[1]!, v[0]!, v[3]!, v[2]!]), model: "fake" };
    };
    const baselineResolver = (key: string) => key === healthy.profileKey ? { probes: healthy.vectors, pairMargins: healthy.margins } : null;

    const normal = await runCanaryBattery(async t => rotated(t), baselineResolver);
    if ("unavailable" in normal) throw new Error("unavailable");
    expect(normal.pass).toBe(false); // drift vs old baseline — the recalibration blocker

    const recal = await runCanaryBattery(async t => rotated(t), baselineResolver, { ignoreBaseline: true });
    if ("unavailable" in recal) throw new Error("unavailable");
    expect(recal.pass).toBe(true); // intrinsic sanity governs; old baseline ignored
    expect(recal.driftChecked).toBe(false);
  });
});

describe("baseline persistence — first-healthy calibration only (T8-M3)", () => {
  it("persists when absent, refuses to roll, replaces only under recalibrate", async () => {
    const store = createStore(":memory:");
    const healthy = await runCanaryBattery(async t => healthyEmbed(t), () => null);
    if ("unavailable" in healthy) throw new Error("unavailable");

    expect(persistCanaryBaselineIfFirst(store, healthy, { recalibrate: false })).toBe(true);
    const first = store.getCanaryBaseline(healthy.profileKey)!;
    expect(first).not.toBeNull();

    // A later healthy state must NOT roll the stored reference.
    const shifted = { ...healthy, margins: { ...healthy.margins, m_rel: (healthy.margins.m_rel ?? 0) + 0.01 } };
    expect(persistCanaryBaselineIfFirst(store, shifted, { recalibrate: false })).toBe(false);
    expect(store.getCanaryBaseline(healthy.profileKey)!.pairMargins.m_rel).toBe(first.pairMargins.m_rel!);

    // Explicit recalibration replaces it.
    expect(persistCanaryBaselineIfFirst(store, shifted, { recalibrate: true })).toBe(true);
    expect(store.getCanaryBaseline(healthy.profileKey)!.pairMargins.m_rel).toBe(shifted.margins.m_rel!);
  });
});

// ---------------------------------------------------------------------------
// Sampled vector validation
// ---------------------------------------------------------------------------

function seedSyncedDoc(store: Store, col: string, path: string, body: string): string {
  const hash = hashContent(body + col + path);
  const now = new Date().toISOString();
  store.insertContent(hash, body, now);
  store.insertDocument(col, path, path, hash, now, now);
  store.markEmbedSynced(hash);
  return hash;
}

/** Deterministic per-text embedder shared by seeding and validation. */
function textEmbed(text: string): Float32Array {
  const d = createHash("sha256").update(text).digest();
  const v = new Float32Array([d[0]! + 1, d[1]! + 1, d[2]! + 1, d[3]! + 1]);
  return v;
}

/** Seed a doc + its seq-0 vector exactly as cmdEmbed would (production reconstruction succeeds),
 *  including the PRODUCTION canonicalDocId shape (T8-H3 — the earlier helper used a
 *  nonproduction id, which let the canonical-resolution defect escape). */
function seedEmbedded(store: Store, col: string, path: string, body: string, opts?: { fp?: "correct" | "wrong" | "none"; corruptVector?: boolean }) {
  const hash = seedSyncedDoc(store, col, path, body);
  store.ensureVecTable(4);
  // Production seq-0 fragment of a small doc = the whole body, label undefined → title.
  const embedText = formatDocForEmbedding(body, path);
  const fpMode = opts?.fp ?? "correct";
  const fp = fpMode === "none" ? undefined : fpMode === "correct"
    ? createHash("sha256").update(embedText, "utf8").digest("hex")
    : "0".repeat(64);
  const vector = opts?.corruptVector ? new Float32Array([0, 0, 0, 1]) : textEmbed(embedText);
  store.insertEmbedding(hash, 0, 0, vector, "fake", new Date().toISOString(), "full", undefined, canonicalDocId(col, path), undefined, fp);
  return hash;
}

const validationEmbed = async (t: string) => ({ embedding: textEmbed(t), model: "fake" });

describe("sampled vector validation (doctor section 11)", () => {
  it("validates a healthy fingerprinted vault (small population scales, green)", async () => {
    const store = createStore(":memory:");
    for (let i = 0; i < 3; i++) seedEmbedded(store, "user", `d${i}.md`, `healthy document number ${i}`);
    const r = await runSampledVectorValidation(store, validationEmbed);
    expect(r.eligible).toBe(3);
    expect(r.target).toBe(3);
    expect(r.nMin).toBe(3);
    expect(r.validated).toBe(3);
    expect(r.definitiveFailures.length).toBe(0);
  });

  it("fingerprint mismatch on a synced doc is a DEFINITIVE stale-input failure", async () => {
    const store = createStore(":memory:");
    seedEmbedded(store, "user", "ok.md", "fine document");
    seedEmbedded(store, "user", "stale.md", "edited document", { fp: "wrong" });
    const r = await runSampledVectorValidation(store, validationEmbed);
    expect(r.definitiveFailures.some(f => f.startsWith("stale-input:") && f.includes("stale.md"))).toBe(true);
  });

  it("fingerprint match + low cosine is a DEFINITIVE corruption failure — coverage cannot mask it, and it returns immediately", async () => {
    const store = createStore(":memory:");
    for (let i = 0; i < 8; i++) seedEmbedded(store, "user", `ok${i}.md`, `healthy document ${i}`);
    seedEmbedded(store, "user", "corrupt.md", "corrupted document", { corruptVector: true });
    const r = await runSampledVectorValidation(store, validationEmbed);
    expect(r.definitiveFailures.some(f => f.startsWith("corruption/drift:") && f.includes("corrupt.md"))).toBe(true);
    // T8-H2: the run STOPS at the first definitive failure — attempts stay bounded.
    expect(r.attempts).toBeLessThanOrEqual(r.target + 8);
  });

  it("alias documents sharing one content hash do NOT multiply eligibility (T8-H3)", async () => {
    const store = createStore(":memory:");
    const body = "shared content body";
    const hash = seedEmbedded(store, "user", "canonical.md", body);
    // Second ACTIVE alias doc with the SAME hash under a different path.
    const now = new Date().toISOString();
    store.insertDocument("user", "alias-copy.md", "alias-copy.md", hash, now, now);
    store.markEmbedSynced(hash);
    const r = await runSampledVectorValidation(store, validationEmbed);
    expect(r.eligible).toBe(1); // one (hash,seq) row — not one per alias
    expect(r.validated).toBe(1); // canonical resolution picks canonical.md, no false stale-input
    expect(r.definitiveFailures.length).toBe(0);
  });

  it("attempts are hard-capped on an all-legacy-inconclusive vault (T8-H2 bound)", async () => {
    const store = createStore(":memory:");
    for (let i = 0; i < 30; i++) seedEmbedded(store, "user", `bad${i}.md`, `legacy corrupt doc ${i}`, { fp: "none", corruptVector: true });
    const r = await runSampledVectorValidation(store, validationEmbed);
    expect(r.attempts).toBeLessThanOrEqual(r.target + 8); // target 16 + replacement budget 8
    expect(r.validated).toBe(0);
    expect(r.inconclusiveLegacy).toBeGreaterThan(0);
  });

  it("legacy rows (no fingerprint) with low cosine are INCONCLUSIVE, never silently passed", async () => {
    const store = createStore(":memory:");
    seedEmbedded(store, "user", "legacy-bad.md", "legacy document", { fp: "none", corruptVector: true });
    const r = await runSampledVectorValidation(store, validationEmbed);
    expect(r.inconclusiveLegacy).toBe(1);
    expect(r.definitiveFailures.length).toBe(0); // not definitive — title provenance unavailable for the tier
    expect(r.validated).toBe(0); // and NOT validated either → coverage-degraded, not green
  });

  it("legacy rows with healthy cosine validate at the structural tier", async () => {
    const store = createStore(":memory:");
    seedEmbedded(store, "user", "legacy-ok.md", "legacy healthy document", { fp: "none" });
    const r = await runSampledVectorValidation(store, validationEmbed);
    expect(r.validated).toBe(1);
    expect(r.legacyTier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Busy retry + lease-fenced markers
// ---------------------------------------------------------------------------

describe("retryOnBusyAsync (design (f).2)", () => {
  const busyErr = () => new Error("SQLiteError: database is locked (SQLITE_BUSY)");

  it("retries SQLITE_BUSY and succeeds", async () => {
    let calls = 0;
    const out = await retryOnBusyAsync(() => {
      calls++;
      if (calls < 3) throw busyErr();
      return "ok";
    }, "test", () => false, { delaysMs: [1, 1, 1] });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does NOT retry non-busy errors (FatalVectorError semantics preserved)", async () => {
    let calls = 0;
    await expect(retryOnBusyAsync(() => { calls++; throw new Error("dimension mismatch"); }, "test", () => false, { delaysMs: [1] }))
      .rejects.toThrow("dimension mismatch");
    expect(calls).toBe(1);
  });

  it("exhausts the bounded budget and rethrows the busy error", async () => {
    let calls = 0;
    await expect(retryOnBusyAsync(() => { calls++; throw busyErr(); }, "test", () => false, { delaysMs: [1, 1] }))
      .rejects.toThrow(/database is locked/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("aborts with EmbedLeaseLostError when the lease is reclaimed mid-retry", async () => {
    await expect(retryOnBusyAsync(() => { throw busyErr(); }, "test", () => true, { delaysMs: [1, 1] }))
      .rejects.toBeInstanceOf(EmbedLeaseLostError);
  });

  it("isSqliteBusyError matches busy shapes only", () => {
    expect(isSqliteBusyError(busyErr())).toBe(true);
    expect(isSqliteBusyError(new Error("no such table: foo"))).toBe(false);
  });
});

describe("no-work run end verification (T10-M1)", () => {
  it("a fully-embedded vault with an unavailable preflight exits NONZERO and persists taint", async () => {
    const dbPath = `/tmp/clawmem-nowork-taint-${process.pid}.sqlite`;
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(dbPath); } catch { /* absent */ }
    // Seed: one synced doc WITH a vector — a no-work run (nothing pending).
    const store = createStore(dbPath);
    const hash = seedSyncedDoc(store, "user", "a.md", "fully embedded doc");
    store.ensureVecTable(4);
    store.insertEmbedding(hash, 0, 0, textEmbed("x"), "m", new Date().toISOString(), "full", undefined, canonicalDocId("user", "a.md"));
    store.close();

    // Run the REAL CLI with an unreachable embed endpoint and local fallback disabled:
    // canary unavailable → non-force warn → no work → shared finalization must taint + exit 1.
    const proc = Bun.spawnSync(["bun", "src/clawmem.ts", "embed"], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        INDEX_PATH: dbPath,
        CLAWMEM_EMBED_URL: "http://127.0.0.1:9",
        CLAWMEM_NO_LOCAL_MODELS: "true",
      },
    });
    expect(proc.exitCode).not.toBe(0);

    const check = createStore(dbPath);
    expect(check.getVaultFlag("embed_geometry_taint")).toContain("no preflight validation");
    check.close();
    try { unlinkSync(dbPath); } catch { /* gone */ }
  }, 30_000);
});

describe("lease-fenced embed-state markers (design (f).5)", () => {
  it("rejects a stale token — a reclaimed old holder cannot overwrite a successor's state", () => {
    const store = createStore(":memory:");
    const hash = seedSyncedDoc(store, "user", "a.md", "doc");
    const lease = acquireWorkerLease(store, "embedding", 60_000);
    expect(lease.acquired).toBe(true);
    const goodGuard = { workerName: "embedding", token: lease.token! };
    const staleGuard = { workerName: "embedding", token: "stale-token" };

    expect(() => store.markEmbedStart(hash, goodGuard)).not.toThrow();
    expect(() => store.markEmbedSynced(hash, goodGuard)).not.toThrow();
    expect(() => store.markEmbedStart(hash, staleGuard)).toThrow(EmbedLeaseLostError);
    expect(() => store.markEmbedFailed(hash, "x", staleGuard)).toThrow(EmbedLeaseLostError);
    // Unfenced calls (no guard) remain valid for non-lease contexts.
    expect(() => store.markEmbedSynced(hash)).not.toThrow();
  });
});
