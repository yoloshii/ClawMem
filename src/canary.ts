/**
 * Embedding-geometry canary (VSEARCH-TRUST-HARDENING (d)).
 *
 * Detects two failure classes the model-name check cannot see (the server may report a
 * literal placeholder name like "embedding"):
 *
 *  1. WRONG geometry (2026-07-10 incident class): the server is stable but produces
 *     non-discriminating vectors — e.g. a last-token model served without its EOS anchor.
 *     Self-similarity stays ~1.0 throughout, so only PAIR-SEPARATION checks catch it.
 *  2. DRIFTED geometry (2026-06-22 class): the serving stack changed since the vault was
 *     embedded (model/quant/pooling swap behind an unchanged name) — caught by comparing
 *     stored baseline probe vectors against fresh embeds of the same probes.
 *
 * Probes are formatted through the PRODUCTION templates so the canary measures the geometry
 * retrieval actually uses, and include a terminus control (near-identical texts differing
 * only near the end — an unanchored last-token regime scores these LOW) and a truncation
 * control (prefix vs full text — unstable under the broken geometry). Register coverage
 * matters: the incident's basic-English pairs looked healthy while technical text collapsed.
 *
 * Versioned: changing any probe text bumps CANARY_PROBE_VERSION and invalidates baselines
 * (the profile key embeds the version).
 */
import { formatDocForEmbedding, formatQueryForEmbedding } from "./llm.ts";
import { basename } from "path";
import { createHash } from "crypto";
import { parseDocument } from "./indexer.ts";
import { splitDocument } from "./splitter.ts";
import { canonicalDocId, type Store } from "./store.ts";
import { notLegacyArtifactSql } from "./compaction-state.ts";
import { storableVector, storedVector, isRefusedEmbedResponse, cosineSimilarityStrict, VecPoisonError } from "./vector-guard.ts";

export const CANARY_PROBE_VERSION = 1;

// Probe texts — generic register, deliberately vault-agnostic.
const REL_A = "the cat sat on the mat";
const REL_B = "a cat is sitting on a mat";
const UNREL = "quarterly financial report for fiscal year 2024";
const TECH_QUERY = "sandbox policy denies manifest read during the verification profile";
const TECH_ECHO = "The sandbox policy uses a syscall filter so the manifest is unreadable during the verification profile.";
const TERM_A = "the deploy pipeline reads the manifest file and validates its signature";
const TERM_B = "the deploy pipeline reads the manifest file and validates its checksum";
const TRUNC_FULL = `${TECH_ECHO} The filter is compiled at startup and applied to every worker process before any user code runs.`;

/** probeId → the exact embed input (production-formatted). */
export function canaryProbeInputs(): Map<string, string> {
  return new Map<string, string>([
    ["rel_a", formatDocForEmbedding(REL_A)],
    ["rel_b", formatDocForEmbedding(REL_B)],
    ["unrel", formatDocForEmbedding(UNREL)],
    ["tech_query", formatQueryForEmbedding(TECH_QUERY)],
    ["tech_echo", formatDocForEmbedding(TECH_ECHO)],
    ["term_a", formatDocForEmbedding(TERM_A)],
    ["term_b", formatDocForEmbedding(TERM_B)],
    ["trunc_full", formatDocForEmbedding(TRUNC_FULL)],
  ]);
}

/** v0.43.7 (BACKLOG 82.2): throws on a length difference — through v0.43.6 it read only the shorter length. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  return cosineSimilarityStrict(a, b);
}

/** Pair-separation margins — each must clear the floor in a healthy geometry. */
export function canaryMargins(vecs: Map<string, Float32Array>): Record<string, number> {
  const v = (id: string) => vecs.get(id)!;
  const unrelBase = (id: string) => cosineSim(v(id), v("unrel"));
  return {
    // related-pair separation: paraphrases must beat the unrelated pair
    m_rel: cosineSim(v("rel_a"), v("rel_b")) - unrelBase("rel_a"),
    // technical echo separation: a query must land nearer its echo than unrelated text
    m_echo: cosineSim(v("tech_query"), v("tech_echo")) - unrelBase("tech_query"),
    // terminus control: near-identical texts (different ending) must beat unrelated —
    // an unanchored last-token readout fails exactly this
    m_term: cosineSim(v("term_a"), v("term_b")) - unrelBase("term_a"),
    // truncation control: a prefix must stay near its full text
    m_trunc: cosineSim(v("trunc_full"), v("tech_echo")) - unrelBase("trunc_full"),
  };
}

/** Absolute backstop for every margin when no baseline exists (design (d).3). */
export const CANARY_ABSOLUTE_MARGIN_FLOOR = 0.10;
/** Relative alert: a margin below this fraction of its baseline is a failure. */
export const CANARY_BASELINE_RATIO_FLOOR = 0.5;
/** Self-drift floor: stored baseline probe vs fresh embed of the same input. */
export const CANARY_DRIFT_FLOOR = 0.98;

export interface CanaryCheckResult {
  pass: boolean;
  failures: string[];
  margins: Record<string, number>;
  vectors: Map<string, Float32Array>;
  profileKey: string;
  /** Present only when a stored baseline existed for the profile. */
  driftChecked: boolean;
  /** v0.43.7 (BACKLOG 82.2): the one (dimension, model) every probe of a complete battery answered with — the run binds to it. */
  binding?: { dim: number; model: string };
}

export function canaryProfileKey(model: string, dim: number): string {
  return `v${CANARY_PROBE_VERSION}:${model || "unknown"}:${dim}`;
}

/**
 * v0.43.7 (BACKLOG 82.2): a probe did not answer. `answered` of `total` did, none of them malformed, and they agree
 * on `binding` (null when none answered) — the run binds to it.
 */
export type CanaryUnavailable = { unavailable: true; reason: string; answered: number; total: number; binding: { dim: number; model: string } | null };
/**
 * v0.43.7 (BACKLOG 82.2): an answered probe was refused by the vector validator, or the answered probes disagree on
 * dimension or model. It keeps the shape of a failed battery (`pass: false`, `failures`), with no margins.
 * No flag overrides it.
 */
export type CanaryMalformed = CanaryCheckResult & { malformed: true; pass: false; reason: string; answered: number; total: number };
export type CanaryOutcome = CanaryCheckResult | CanaryUnavailable | CanaryMalformed;

type EmbedFn = (text: string) => Promise<{ embedding: unknown; model?: string } | null>;
type CanaryBaseline = { probes: Map<string, Float32Array>; pairMargins: Record<string, number> };

/**
 * The failure lines of a COMPLETE, single-geometry battery: pair separation against baseline-calibrated or absolute
 * floors, and drift against the stored baseline probes. A margin or a drift similarity that is not finite is a
 * failure that names it — `NaN < floor` is false, so a comparison alone would pass it.
 */
export function canaryFailures(
  margins: Record<string, number>,
  vectors: Map<string, Float32Array>,
  baseline: CanaryBaseline | null,
  similarity: (a: Float32Array, b: Float32Array) => number = cosineSim,
): string[] {
  const failures: string[] = [];
  for (const [name, value] of Object.entries(margins)) {
    if (!Number.isFinite(value)) { failures.push(`${name} = ${value} is not finite`); continue; }
    const baseMargin = baseline?.pairMargins?.[name];
    const calibrated = typeof baseMargin === "number" && Number.isFinite(baseMargin) && baseMargin > 0;
    const floor = calibrated
      ? Math.max(CANARY_ABSOLUTE_MARGIN_FLOOR, baseMargin * CANARY_BASELINE_RATIO_FLOOR)
      : CANARY_ABSOLUTE_MARGIN_FLOOR;
    if (value < floor) {
      failures.push(`${name} = ${value.toFixed(3)} < floor ${floor.toFixed(3)}${calibrated ? ` (baseline ${baseMargin.toFixed(3)})` : ""}`);
    }
  }
  if (baseline) {
    for (const [id, storedVec] of baseline.probes) {
      const fresh = vectors.get(id);
      if (!fresh) continue; // probe set changed (version bump) — baseline is stale, sanity floors govern
      if (fresh.length !== storedVec.length) {
        failures.push(`drift:${id} dimension changed (${storedVec.length} → ${fresh.length})`);
        continue;
      }
      const sim = similarity(storedVec, fresh);
      if (!Number.isFinite(sim)) {
        failures.push(`drift:${id} cos(stored, fresh) = ${sim} is not finite`);
      } else if (sim < CANARY_DRIFT_FLOOR) {
        failures.push(`drift:${id} cos(stored, fresh) = ${sim.toFixed(4)} < ${CANARY_DRIFT_FLOOR} — server geometry changed since last embed`);
      }
    }
  }
  return failures;
}

/**
 * Run the full battery: embed every probe, compute margins, evaluate
 * sanity (pair separation vs baseline-calibrated or absolute floors) and
 * drift (vs stored baseline vectors, when available).
 *
 * v0.43.7 (BACKLOG 82.2) — the order is fixed: every answer is VALIDATED as it arrives (`storableVector`, raw) →
 * the dimension and model sets are compared → only then margins. The battery still stops at the first probe that
 * does not answer, and then JUDGES WHAT WAS ANSWERED before it returns: `malformed` first (so a timeout after a
 * malformed or mixed answer cannot hide it), else `unavailable`.
 */
export async function runCanaryBattery(
  embed: EmbedFn,
  getBaseline: (profileKey: string) => CanaryBaseline | null,
  opts?: {
    /** Recalibration mode (T9-M3): evaluate INTRINSIC sanity only (absolute floors +
     *  mixed-endpoint) — skip every baseline-relative check, since the point of
     *  recalibrating is that the old baseline no longer applies. */
    ignoreBaseline?: boolean;
  }
): Promise<CanaryOutcome> {
  const inputs = canaryProbeInputs();
  const total = inputs.size;
  const vectors = new Map<string, Float32Array>();
  const modelsSeen = new Set<string>();
  const dimsSeen = new Set<number>();
  let model = "";
  const malformed = (reason: string, failures: string[]): CanaryMalformed => ({
    malformed: true, pass: false, reason, answered: vectors.size, total,
    failures, margins: {}, vectors, profileKey: "", driftChecked: false,
  });
  // A flapping endpoint answering with mixed dimensions or models across ONE battery is a
  // hard failure (T8-H1): such a server must never be allowed to feed a rebuild.
  const mixed = (): string[] => {
    const lines: string[] = [];
    if (dimsSeen.size > 1) lines.push(`mixed dimensions across probes (${[...dimsSeen].join(", ")}) — flapping endpoint`);
    if (modelsSeen.size > 1) lines.push(`mixed models across probes (${[...modelsSeen].join(", ")}) — flapping endpoint`);
    return lines;
  };
  for (const [id, text] of inputs) {
    let r: { embedding: unknown; model?: string } | null = null;
    let refused: unknown = null;
    try { r = await embed(text); } catch (e) { if (isRefusedEmbedResponse(e)) refused = e; else r = null; }
    if (!refused && r && r.embedding !== undefined && r.embedding !== null) {
      try { vectors.set(id, storableVector(r.embedding, { context: `canary probe ${id}` })); }
      catch (e) { if (e instanceof VecPoisonError) refused = e; else throw e; }
    }
    if (refused) {
      const why = `probe '${id}' returned a malformed answer: ${(refused as Error).message}`;
      return malformed(why, [why, ...mixed()]);
    }
    if (!vectors.has(id)) {
      // No answer. Judge what WAS answered: a mixed answer before the silence is `malformed`.
      const lines = mixed();
      if (lines.length > 0) return malformed(`the probes answered before '${id}' disagree: ${lines.join("; ")}`, lines);
      const binding = vectors.size > 0 ? { dim: [...dimsSeen][0]!, model } : null;
      return {
        unavailable: true, answered: vectors.size, total, binding,
        reason: `probe '${id}' could not be embedded (endpoint unreachable?) — ${vectors.size} of ${total} probes answered`,
      };
    }
    dimsSeen.add(vectors.get(id)!.length);
    if (r!.model) modelsSeen.add(r!.model);
    if (!model && r!.model) model = r!.model;
  }
  // Every probe answered. Dimension and model sets BEFORE any margin: a mixed battery is the structured failure,
  // and no margin is computed for it (`cosineSim` no longer accepts two lengths).
  const lines = mixed();
  if (lines.length > 0) return malformed(lines.join("; "), lines);

  const dim = vectors.get("rel_a")!.length;
  const profileKey = canaryProfileKey(model, dim);
  const baseline = opts?.ignoreBaseline ? null : getBaseline(profileKey);
  const margins = canaryMargins(vectors);
  const failures = canaryFailures(margins, vectors, baseline);
  return { pass: failures.length === 0, failures, margins, vectors, profileKey, driftChecked: !!baseline, binding: { dim, model } };
}

/**
 * Preflight gate decision (T8-H1: the gate must FAIL CLOSED before a destructive clear).
 *
 *   malformed                     → abort, ALWAYS (v0.43.7, BACKLOG 82.2): neither --force-geometry nor
 *                                   --recalibrate-canary overrides an endpoint that returned a malformed vector
 *   pass                          → proceed
 *   fail + !forceGeometry         → abort (any run — nothing is written against bad geometry)
 *   fail + forceGeometry          → warn (explicit operator override)
 *   unavailable + force           → abort unless forceGeometry — a `--force` clear must never
 *                                   proceed on an UNVALIDATED endpoint (the later dimension
 *                                   probe alone can pass a flaky server far enough to destroy
 *                                   the old index and then die on the first fragment)
 *   unavailable + !force          → warn (incremental runs write nothing destructive first;
 *                                   their embeds fail naturally if the endpoint is down)
 */
export function canaryGate(
  outcome: CanaryCheckResult | CanaryMalformed | { unavailable: true; reason: string },
  opts: { force: boolean; forceGeometry: boolean }
): { action: "proceed" | "warn" | "abort"; reason: string } {
  if ("malformed" in outcome) {
    return { action: "abort", reason: `geometry canary got a malformed answer (${outcome.reason}) — nothing was cleared or written, and no flag overrides this` };
  }
  if ("unavailable" in outcome) {
    if (opts.force && !opts.forceGeometry) {
      return { action: "abort", reason: `geometry canary unavailable (${outcome.reason}) — refusing a destructive --force clear against an unvalidated endpoint (override: --force-geometry)` };
    }
    return { action: "warn", reason: outcome.reason };
  }
  if (!outcome.pass) {
    if (opts.forceGeometry) return { action: "warn", reason: "canary FAILED — continuing under --force-geometry" };
    return { action: "abort", reason: "canary FAILED" };
  }
  return { action: "proceed", reason: "canary passed" };
}

/**
 * Persist the canary baseline ONLY as a first-healthy calibration (T8-M3): repeated
 * healthy runs must not roll the reference (repeated sub-threshold drift could otherwise
 * walk it arbitrarily far). `recalibrate` is the explicit replacement operation.
 */
export function persistCanaryBaselineIfFirst(
  store: Store,
  state: CanaryCheckResult,
  opts: { recalibrate: boolean; leaseGuard?: { workerName: string; token: string } }
): boolean {
  if (!opts.recalibrate && store.getCanaryBaseline(state.profileKey) !== null) return false;
  store.saveCanaryBaseline(
    state.profileKey,
    [...state.vectors.entries()].map(([probeId, embedding]) => ({ probeId, embedding })),
    state.margins,
    opts.leaseGuard
  );
  return true;
}

// Sampled persisted-vs-fresh vector validation (doctor section 11). Reconstructs each
// sampled fragment from its CANONICAL document via the production pipeline
// (parseDocument → splitDocument → seq/label alignment → formatDocForEmbedding), then:
//   - fingerprinted rows: fp match → FULL validation (cos ≥ 0.98; below = DEFINITIVE
//     corruption/drift); fp mismatch → DEFINITIVE stale-input. The first definitive
//     failure returns IMMEDIATELY (T8-H2) — doctor is nonzero either way, and continuing
//     could approach a full re-embed's worth of calls on a large corrupt vault.
//   - legacy rows (no fp): STRUCTURAL validation; low cos is INCONCLUSIVE (title
//     provenance is universally unavailable for the tier) — never silently passed.
// Operational bounds (T8-H2): eligibility is metadata-only (no bodies); bodies hydrate
// lazily per sampled row; total attempts are capped at target + SAMPLE_REPLACEMENT_BUDGET.
// Canonical identity (T8-H3): rows are unique per (hash,seq) — alias documents sharing a
// content hash do NOT multiply eligibility — and reconstruction uses the document whose
// canonicalDocId matches the stored cv.canonical_id (falling back to a single active
// alias for null-canonical legacy rows; ambiguity → unreconstructable, never condemned).
// Contract checks (T8-M4): the reconstructed fragment COUNT must equal the persisted
// per-hash row count, and the seq-0 quota is tracked through VALIDATED samples.

export const SAMPLE_REPLACEMENT_BUDGET = 8;

export async function runSampledVectorValidation(
  s: Store,
  embed: EmbedFn
): Promise<{
  /** v0.43.7 (BACKLOG 82.2): fresh responses the validator refused — a failure of the ENDPOINT, not of a stored row. */
  refusedFresh: number;
  eligible: number; target: number; nMin: number; validated: number;
  validatedSeq0: number; seq0Target: number;
  legacyTier: number; unreconstructable: number; inconclusiveLegacy: number; attempts: number;
  definitiveFailures: string[];
}> {
  type MetaRow = { hash: string; seq: number; fragment_label: string | null; embed_input_fp: string | null; canonical_id: string | null };
  // Metadata-only eligibility — one row per (hash,seq), NO document join (alias docs must
  // not multiply eligibility), NO body hydration.
  // A sampled row is re-embedded from its reconstructed input: the legacy pre-compaction snapshot is
  // never eligible (62.2), so its text never reaches the embedding model here either.
  const eligibleRows = s.db.prepare(`
    SELECT cv.hash, cv.seq, cv.fragment_label, cv.embed_input_fp, cv.canonical_id
    FROM content_vectors cv
    WHERE EXISTS (
      SELECT 1 FROM documents d
      WHERE d.hash = cv.hash AND d.active = 1 AND d.invalidated_at IS NULL AND d.embed_state = 'synced'
        AND ${notLegacyArtifactSql("d")}
    )
  `).all() as MetaRow[];
  const eligible = eligibleRows.length;
  const target = Math.min(16, eligible);
  const nMin = Math.min(8, eligible);
  const seq0Pool = eligibleRows.filter(r => r.seq === 0);
  const seq0Target = Math.min(4, seq0Pool.length);
  const result = {
    refusedFresh: 0, eligible, target, nMin, validated: 0, validatedSeq0: 0, seq0Target,
    legacyTier: 0, unreconstructable: 0, inconclusiveLegacy: 0, attempts: 0,
    definitiveFailures: [] as string[],
  };
  if (eligible === 0) return result;

  const shuffle = <T,>(arr: T[]) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!]; } return arr; };
  // seq-0 rows first until the VALIDATED seq-0 quota is met, then the rest (T8-M4).
  const seq0Order = shuffle([...seq0Pool]);
  const restOrder = shuffle(eligibleRows.filter(r => r.seq !== 0));
  let seq0Idx = 0, restIdx = 0;
  const nextRow = (): MetaRow | null => {
    if (result.validatedSeq0 < seq0Target && seq0Idx < seq0Order.length) return seq0Order[seq0Idx++]!;
    if (restIdx < restOrder.length) return restOrder[restIdx++]!;
    if (seq0Idx < seq0Order.length) return seq0Order[seq0Idx++]!;
    return null;
  };

  const maxAttempts = target + SAMPLE_REPLACEMENT_BUDGET;
  const bodyStmt = s.db.prepare(`SELECT doc FROM content WHERE hash = ?`);
  // Canonical RESOLUTION consults ALL aliases including inactive ones (T9-M1) — the
  // stored canonical identity may name a since-deactivated alias while an active twin
  // keeps the row eligible; condemning it as unreconstructable would be false. The
  // active-document EXISTS guard above still gates ELIGIBILITY.
  const aliasStmt = s.db.prepare(`SELECT collection, path, title, active FROM documents WHERE hash = ? ORDER BY active DESC, collection, path`);
  const fragCountStmt = s.db.prepare(`SELECT count(*) as c FROM content_vectors WHERE hash = ?`);
  const vecStmt = s.db.prepare(`SELECT embedding FROM vectors_vec WHERE hash_seq = ?`);

  while (result.validated < target && result.attempts < maxAttempts) {
    const row = nextRow();
    if (!row) break;
    result.attempts++;

    // Canonical resolution (T8-H3 / T9-M1): the document whose canonicalDocId matches the
    // stored id — searched across ALL aliases (active first). Null-canonical legacy rows
    // fall back to a single ACTIVE alias; ambiguity → unreconstructable, never condemned.
    const aliases = aliasStmt.all(row.hash) as { collection: string; path: string; title: string; active: number }[];
    let canonical = row.canonical_id
      ? aliases.find(a => canonicalDocId(a.collection, a.path) === row.canonical_id)
      : undefined;
    if (!canonical && !row.canonical_id) {
      const activeAliases = aliases.filter(a => a.active === 1);
      if (activeAliases.length === 1) canonical = activeAliases[0];
    }
    if (!canonical) { result.unreconstructable++; continue; }

    // Reconstruct through the production pipeline (lazy body hydration).
    let fragText: string;
    try {
      const bodyRow = bodyStmt.get(row.hash) as { doc: string } | undefined;
      if (!bodyRow) { result.unreconstructable++; continue; }
      let frontmatter: Record<string, any> | undefined;
      try { frontmatter = parseDocument(bodyRow.doc, canonical.path).meta as any; } catch { /* no frontmatter */ }
      const frags = splitDocument(bodyRow.doc, frontmatter);
      // Per-hash fragment-count contract (T8-M4): splitter output must match what was persisted.
      const persistedCount = (fragCountStmt.get(row.hash) as { c: number }).c;
      if (frags.length !== persistedCount) { result.unreconstructable++; continue; }
      const frag = frags[row.seq];
      if (!frag) { result.unreconstructable++; continue; }
      if ((frag.label ?? null) !== (row.fragment_label ?? null)) { result.unreconstructable++; continue; }
      const docTitle = canonical.title || basename(canonical.path).replace(/\.(md|txt)$/i, "");
      fragText = formatDocForEmbedding(frag.content, frag.label || docTitle);
    } catch { result.unreconstructable++; continue; }

    const stored = vecStmt.get(`${row.hash}_${row.seq}`) as { embedding: Uint8Array } | undefined;
    if (!stored?.embedding) { result.unreconstructable++; continue; }
    // v0.43.7 (BACKLOG 82.2): the stored row is decoded and judged first. One that is not a usable vector is a
    // DEFINITIVE failure of the row — no embed call is spent on it.
    let storedVec: Float32Array;
    try { storedVec = storedVector(stored.embedding, undefined, { context: `${row.hash}_${row.seq}` }); }
    catch (e) {
      if (!(e instanceof VecPoisonError)) throw e;
      result.definitiveFailures.push(`stored-vector: ${canonical.collection}/${canonical.path}#${row.seq} — ${e.message} Run 'clawmem repair vectors'.`);
      return result;
    }
    // The fresh response is judged raw. A refused one is a DEFINITIVE failure of the ENDPOINT (counted apart, never
    // `validated`, never blamed on the row); no answer stays "unreconstructable".
    const freshVector = async (): Promise<Float32Array | null | "refused"> => {
      let fresh: { embedding: unknown } | null;
      try { fresh = await embed(fragText); }
      catch (e) { if (!isRefusedEmbedResponse(e)) return null; fresh = { embedding: e }; }
      if (!fresh || fresh.embedding === undefined || fresh.embedding === null) return null;
      try {
        if (fresh.embedding instanceof Error) throw fresh.embedding;
        return storableVector(fresh.embedding, { context: `${row.hash}_${row.seq}` });
      } catch (e) {
        if (!isRefusedEmbedResponse(e)) throw e;
        result.refusedFresh++;
        result.definitiveFailures.push(`endpoint: the embedding endpoint returned a malformed answer while validating ${canonical.collection}/${canonical.path}#${row.seq} — ${e.message}`);
        return "refused";
      }
    };

    if (row.embed_input_fp) {
      const fp = createHash("sha256").update(fragText, "utf8").digest("hex");
      if (fp !== row.embed_input_fp) {
        result.definitiveFailures.push(`stale-input: ${canonical.collection}/${canonical.path}#${row.seq} — embed input changed since embed (fingerprint mismatch); re-embed required`);
        return result; // definitive → nonzero regardless of coverage; stop spending embeds (T8-H2)
      }
      const fresh = await freshVector();
      if (fresh === "refused") return result;
      if (!fresh || fresh.length !== storedVec.length) { result.unreconstructable++; continue; }
      const sim = cosineSim(storedVec, fresh);
      if (!(sim >= 0.98)) {
        result.definitiveFailures.push(`corruption/drift: ${canonical.collection}/${canonical.path}#${row.seq} — fingerprint matches but cos(stored, fresh) = ${sim.toFixed(4)} < 0.98`);
        return result;
      }
      result.validated++;
      if (row.seq === 0) result.validatedSeq0++;
    } else {
      const fresh = await freshVector();
      if (fresh === "refused") return result;
      if (!fresh || fresh.length !== storedVec.length) { result.unreconstructable++; continue; }
      const sim = cosineSim(storedVec, fresh);
      if (!(sim >= 0.98)) { result.inconclusiveLegacy++; continue; }
      result.legacyTier++;
      result.validated++;
      if (row.seq === 0) result.validatedSeq0++;
    }
  }
  return result;
}
