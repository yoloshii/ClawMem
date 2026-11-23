/**
 * Hydrated vector-daemon wire protocol constants (codex #28 t83–t88 design).
 *
 * ONE shared module imported by the daemon (server), the hook client, the
 * store projection scan, and the tests — so the two ends of the wire can
 * never skew. Under `responseProtocol: "hydrated-v1"` the daemon accepts
 * ONLY these exact values (t86 CR-6): the request carries them as an
 * attestation of what the client expects, and a mismatch is a loud
 * `bad_request`, never a divergent projection.
 *
 * Zero imports on purpose — everything may import this.
 */

/** Version tag of the projection-complete response protocol. */
export const HYDRATED_PROTOCOL = "hydrated-v1";

/**
 * Hard cap on projected results per response (t85). The hook's largest ask is
 * the deep profile's maxResults=15; a hydrated-v1 request whose limit is not
 * an integer in [1, HYDRATED_MAX_RESULTS] is REFUSED as `bad_request` (t89
 * P3) — an out-of-contract value is version/config skew, never something to
 * silently clamp into a different candidate-count contract. (Legacy raw
 * requests keep their compatibility clamp.)
 */
export const HYDRATED_MAX_RESULTS = 16;

/**
 * Per-entry serialized cap (t87): each projected entry is one newline-framed
 * JSON line; the reader rejects a longer line BEFORE parsing it, so a single
 * synchronous parse slice is bounded by construction — the enforced
 * supported-platform decode bound (t86 CR-3), not a host benchmark.
 * Worst-case arithmetic: 2000+4000+450 chars of body-derived text at 6
 * bytes/char JSON escaping ≈ 40 KB, plus metadata.
 */
export const HYDRATED_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * Cumulative response cap across header + entries + end line (t86). Raw-hit
 * and legacy frames keep the original 256 KiB MAX_FRAME_BYTES.
 */
export const HYDRATED_MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Phase-1 admission ceiling on a SOURCE body (t87 F1): a selected result
 * whose stored body exceeds this is rejected BEFORE its body is fetched
 * (`oversized` → client FTS fallback, distinct trace) — the genuine finite
 * bound on daemon peak allocation. 3× the observed corpus maximum (1.36 MB).
 * UTF-8 BYTES via `length(CAST(content.doc AS BLOB))` — used ONLY for this
 * admission check, never as the projected `bodyLength` (t87 F3: bodyLength
 * stays UTF-16 `body.length`, byte-identical to in-process hydration).
 */
export const HYDRATED_MAX_SOURCE_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The snippet lengths the daemon precomputes per result — exactly the hook's
 * injection tiers (HOT 300 / WARM 150; COLD injects no snippet). The hook
 * picks one at the FINAL tier and smart-truncates, exactly as it does today.
 */
export const HYDRATED_SNIPPET_LENS = [300, 150] as const;

/** Rerank transmitted-text slice — `body.slice(0, 2000)`, the hook's exact slice. */
export const HYDRATED_RERANK_TEXT_LEN = 2000;

/** Gate-token source slice — `body.slice(0, 4000)`, passesCurrentQueryGate's exact slice. */
export const HYDRATED_GATE_TEXT_LEN = 4000;

// ─── O1: relative deadline propagation (O1-DESIGN-monotonic-deadlines.md §2, §4) ──

/**
 * Version tag of the RELATIVE-BUDGET deadline protocol on the daemon wire. A
 * request carries `remainingBudgetMs` (a whole count of milliseconds still
 * available to the leg, sampled immediately before the write) instead of an
 * absolute wall-clock `deadlineMs`; `performance.now()` origins are
 * per-process, so an absolute monotonic instant is meaningless to the
 * receiver, and an absolute wall instant is exactly the steppable quantity O1
 * removes. The CLIENT holds the authoritative timer; the daemon's deadline is
 * ADVISORY and trails the client by one-way transit (documented, not
 * corrected). A request still carrying `deadlineMs` is version skew and is
 * REFUSED without constructing a deadline from it.
 *
 * Orthogonal to `hydrated-v1` (daemon-side projection): both are advertised in
 * the readiness pong's `protocols`, and every scan response attests
 * `deadlineProtocol` so a client can tell a daemon that implements the
 * relative budget from one that silently ignored the field.
 */
export const DEADLINE_PROTOCOL = "deadline-rel-v1";

/**
 * The vector-fault protocol (v0.43.7, BACKLOG 82.2 D4). A daemon that implements it screens every
 * returned distance, counts the rows it dropped, and says so on EVERY scan answer: the hydrated
 * header and the raw reply carry `vectorFaultProtocol: "vf1"` and, when the count is not zero,
 * `vectorFaults: n`. Attestation present and no count = zero faults. Attestation ABSENT = a daemon
 * that never screened: the count is unknown, never zero, and the client classes the answer `skew`.
 * A query vector the daemon's own embedding refused travels as the typed error frame
 * `{ error: "vec_poison", ... }`. Advertised in the readiness pong's `protocols`; `live` requires it.
 */
export const VECTOR_FAULT_PROTOCOL = "vf1";

/**
 * Contract ceiling on `remainingBudgetMs` (O1 §2, codex rev-6 F4): a
 * non-integer or out-of-range value is version/config skew, refused before
 * the scan, never clamped (the t89 P3 convention). EQUAL to the context-
 * surfacing hook's supported maximum internal budget (`MAX_HOOK_BUDGET_MS`
 * re-exports it): a deep leg can inherit nearly the whole work window, so
 * a protocol ceiling below the largest supported hook budget would reject a
 * previously valid configuration as skew — the ceiling therefore covers
 * every supported budget, and an unsupported budget is refused BEFORE the
 * handler runs (`assertHookBudgetConfig`). 25_000 is a NEWLY SELECTED
 * interactive maximum borrowing the value of a shipped, model-bearing
 * DEFAULT (`DEFAULT_STOP_BUDGET_MS`), not an inherited repository maximum
 * (the Stop lane's implemented maximum is 300_000); the production default
 * stays 6000. Opting into the ceiling can block prompt submission for up to
 * the derived host timeout, ceil((1500 + 25000) / 1000) = 27 s.
 */
export const MAX_LEG_BUDGET_MS = 25_000;

/**
 * The top-level run-identity value for the handler / evaluator timing
 * contract (O1 §4): every deadline decision, the finalization/trust timing,
 * expansion and rerank cancellation derive from one monotonic anchor and
 * relative windows. Recorded as `deadline_protocol` for EVERY run (speed-only
 * and in-process included — the handler's timing changed in all of them);
 * absent ⇒ comparison surfaces fail closed. DEFINING this constant is inert;
 * STAMPING it into run identity and advertising `DEADLINE_PROTOCOL` in the
 * pong is the activation, permitted only once both O1 ratchets hold zero
 * entries (O1 §6 step 4).
 */
export const DEADLINE_PROTOCOL_IDENTITY = "monotonic-relative-v1";
