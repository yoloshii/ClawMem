/**
 * v0.41.4 (DESIGN-v0414.md §7.2; codex T7-10): which rows each Stop-pipeline queue's worker may take, as SQL shared by
 * the worker's own query and by `clawmem repair stop-queue --run`'s report of what remains due (`stopQueueNextDue`,
 * `stop-worker.ts`), so the report cannot disagree with the worker. Each fragment is parenthesized and says what it binds.
 */

/** `stop_retries` rows the replay may claim — due, or claimed by a processor whose lease expired. Binds `now` twice. */
export const RETRY_DUE_SQL = "((state = 'queued' AND next_retry_at <= ?) OR (state = 'claimed' AND lease_expires_at < ?))";
/** When a `stop_retries` row that is not due yet becomes claimable. */
export const RETRY_DUE_AT_SQL = "CASE state WHEN 'queued' THEN next_retry_at WHEN 'claimed' THEN lease_expires_at END";

/** `causal_due` markers the causal step may claim. Binds `now` twice. */
export const CAUSAL_DUE_SQL = "((state = 'queued' OR (state = 'claimed' AND lease_expires_at < ?)) AND (next_retry_at IS NULL OR next_retry_at <= ?))";
/** When a `causal_due` marker that is not due yet becomes claimable: its lease's end and its retry time, whichever is later. */
export const CAUSAL_DUE_AT_SQL = "CASE WHEN state = 'claimed' THEN MAX(lease_expires_at, COALESCE(next_retry_at, lease_expires_at)) ELSE next_retry_at END";

/** `judge_deferred` rows the rejudge takes. Binds `now` once. */
export const REJUDGE_DUE_SQL = "(state = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?))";

/** An open `feedback_turns f` row — pending, or provisionally attributed (attribution and the mirrors). Binds nothing. */
export const FEEDBACK_OPEN_ROW_SQL = "(f.state = 'pending' OR (f.state = 'attributed' AND f.reason = 'provisional'))";
/** `feedback_turns f JOIN context_usage u` rows the attribution pass examines — every pass, on no schedule. Binds nothing. */
export const FEEDBACK_OPEN_SQL = `(${FEEDBACK_OPEN_ROW_SQL} AND u.session_id IS NOT NULL AND u.transcript_key IS NOT NULL)`;

/** The latest turn digest of a handoff's transcript (`session_docs d`). */
export const RENDER_LAST_DIGEST_SQL = `(
         SELECT MAX(i.created_at) FROM stop_items i
         WHERE i.session_id = d.session_id AND i.transcript_key = d.transcript_key AND i.kind = 'turn-digest')`;
/** `session_docs d` handoffs the render step takes — the session ended, or its digests have been quiet. Binds the quiet cutoff once. */
export const RENDER_DUE_SQL = `(d.kind = 'handoff' AND d.render_needed = 1 AND (d.ended_at IS NOT NULL OR COALESCE(${RENDER_LAST_DIGEST_SQL}, '') <= ?))`;
