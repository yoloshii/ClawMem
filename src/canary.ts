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

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
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
}

export function canaryProfileKey(model: string, dim: number): string {
  return `v${CANARY_PROBE_VERSION}:${model || "unknown"}:${dim}`;
}

/**
 * Run the full battery: embed every probe, compute margins, evaluate
 * sanity (pair separation vs baseline-calibrated or absolute floors) and
 * drift (vs stored baseline vectors, when available).
 */
export async function runCanaryBattery(
  embed: (text: string) => Promise<{ embedding: number[] | Float32Array; model?: string } | null>,
  getBaseline: (profileKey: string) => { probes: Map<string, Float32Array>; pairMargins: Record<string, number> } | null,
  opts?: {
    /** Recalibration mode (T9-M3): evaluate INTRINSIC sanity only (absolute floors +
     *  mixed-endpoint) — skip every baseline-relative check, since the point of
     *  recalibrating is that the old baseline no longer applies. */
    ignoreBaseline?: boolean;
  }
): Promise<CanaryCheckResult | { unavailable: true; reason: string }> {
  const inputs = canaryProbeInputs();
  const vectors = new Map<string, Float32Array>();
  const modelsSeen = new Set<string>();
  const dimsSeen = new Set<number>();
  let model = "";
  for (const [id, text] of inputs) {
    let r: { embedding: number[] | Float32Array; model?: string } | null = null;
    try { r = await embed(text); } catch { r = null; }
    if (!r || !r.embedding || r.embedding.length === 0) {
      return { unavailable: true, reason: `probe '${id}' could not be embedded (endpoint unreachable?)` };
    }
    vectors.set(id, r.embedding instanceof Float32Array ? r.embedding : new Float32Array(r.embedding));
    dimsSeen.add(r.embedding.length);
    if (r.model) modelsSeen.add(r.model);
    if (!model && r.model) model = r.model;
  }
  const dim = vectors.get("rel_a")!.length;
  const profileKey = canaryProfileKey(model, dim);
  const baseline = opts?.ignoreBaseline ? null : getBaseline(profileKey);
  const margins = canaryMargins(vectors);

  const failures: string[] = [];
  // A flapping endpoint answering with mixed dimensions or models across ONE battery is a
  // hard failure (T8-H1): such a server must never be allowed to feed a rebuild.
  if (dimsSeen.size > 1) failures.push(`mixed dimensions across probes (${[...dimsSeen].join(", ")}) — flapping endpoint`);
  if (modelsSeen.size > 1) failures.push(`mixed models across probes (${[...modelsSeen].join(", ")}) — flapping endpoint`);
  for (const [name, value] of Object.entries(margins)) {
    const baseMargin = baseline?.pairMargins?.[name];
    const floor = baseMargin !== undefined && baseMargin > 0
      ? Math.max(CANARY_ABSOLUTE_MARGIN_FLOOR, baseMargin * CANARY_BASELINE_RATIO_FLOOR)
      : CANARY_ABSOLUTE_MARGIN_FLOOR;
    if (value < floor) {
      failures.push(`${name} = ${value.toFixed(3)} < floor ${floor.toFixed(3)}${baseMargin !== undefined ? ` (baseline ${baseMargin.toFixed(3)})` : ""}`);
    }
  }

  let driftChecked = false;
  if (baseline) {
    driftChecked = true;
    for (const [id, storedVec] of baseline.probes) {
      const fresh = vectors.get(id);
      if (!fresh) continue; // probe set changed (version bump) — baseline is stale, sanity floors govern
      if (fresh.length !== storedVec.length) {
        failures.push(`drift:${id} dimension changed (${storedVec.length} → ${fresh.length})`);
        continue;
      }
      const sim = cosineSim(storedVec, fresh);
      if (sim < CANARY_DRIFT_FLOOR) {
        failures.push(`drift:${id} cos(stored, fresh) = ${sim.toFixed(4)} < ${CANARY_DRIFT_FLOOR} — server geometry changed since last embed`);
      }
    }
  }

  return { pass: failures.length === 0, failures, margins, vectors, profileKey, driftChecked };
}

/**
 * Preflight gate decision (T8-H1: the gate must FAIL CLOSED before a destructive clear).
 *
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
  outcome: CanaryCheckResult | { unavailable: true; reason: string },
  opts: { force: boolean; forceGeometry: boolean }
): { action: "proceed" | "warn" | "abort"; reason: string } {
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
  embed: (text: string) => Promise<{ embedding: number[] | Float32Array; model?: string } | null>
): Promise<{
  eligible: number; target: number; nMin: number; validated: number;
  validatedSeq0: number; seq0Target: number;
  legacyTier: number; unreconstructable: number; inconclusiveLegacy: number; attempts: number;
  definitiveFailures: string[];
}> {
  type MetaRow = { hash: string; seq: number; fragment_label: string | null; embed_input_fp: string | null; canonical_id: string | null };
  // Metadata-only eligibility — one row per (hash,seq), NO document join (alias docs must
  // not multiply eligibility), NO body hydration.
  const eligibleRows = s.db.prepare(`
    SELECT cv.hash, cv.seq, cv.fragment_label, cv.embed_input_fp, cv.canonical_id
    FROM content_vectors cv
    WHERE EXISTS (
      SELECT 1 FROM documents d
      WHERE d.hash = cv.hash AND d.active = 1 AND d.invalidated_at IS NULL AND d.embed_state = 'synced'
    )
  `).all() as MetaRow[];
  const eligible = eligibleRows.length;
  const target = Math.min(16, eligible);
  const nMin = Math.min(8, eligible);
  const seq0Pool = eligibleRows.filter(r => r.seq === 0);
  const seq0Target = Math.min(4, seq0Pool.length);
  const result = {
    eligible, target, nMin, validated: 0, validatedSeq0: 0, seq0Target,
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
    const storedBuf = new Uint8Array(stored.embedding);
    const storedVec = new Float32Array(storedBuf.buffer, storedBuf.byteOffset, storedBuf.byteLength / 4);

    if (row.embed_input_fp) {
      const fp = createHash("sha256").update(fragText, "utf8").digest("hex");
      if (fp !== row.embed_input_fp) {
        result.definitiveFailures.push(`stale-input: ${canonical.collection}/${canonical.path}#${row.seq} — embed input changed since embed (fingerprint mismatch); re-embed required`);
        return result; // definitive → nonzero regardless of coverage; stop spending embeds (T8-H2)
      }
      const fresh = await embed(fragText).catch(() => null);
      if (!fresh || fresh.embedding.length !== storedVec.length) { result.unreconstructable++; continue; }
      const sim = cosineSim(storedVec, fresh.embedding instanceof Float32Array ? fresh.embedding : new Float32Array(fresh.embedding));
      if (sim < 0.98) {
        result.definitiveFailures.push(`corruption/drift: ${canonical.collection}/${canonical.path}#${row.seq} — fingerprint matches but cos(stored, fresh) = ${sim.toFixed(4)} < 0.98`);
        return result;
      }
      result.validated++;
      if (row.seq === 0) result.validatedSeq0++;
    } else {
      const fresh = await embed(fragText).catch(() => null);
      if (!fresh || fresh.embedding.length !== storedVec.length) { result.unreconstructable++; continue; }
      const sim = cosineSim(storedVec, fresh.embedding instanceof Float32Array ? fresh.embedding : new Float32Array(fresh.embedding));
      if (sim < 0.98) { result.inconclusiveLegacy++; continue; }
      result.legacyTier++;
      result.validated++;
      if (row.seq === 0) result.validatedSeq0++;
    }
  }
  return result;
}
