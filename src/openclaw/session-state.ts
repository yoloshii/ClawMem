/**
 * ClawMem OpenClaw Plugin — Session-scoped state
 *
 * Module-level state previously owned by the deleted `ClawMemContextEngine`
 * instance (engine.ts). After §14.3 migration to `kind: "memory"`, the engine
 * class is gone but per-session bookkeeping is still needed for two flows:
 *
 *   - bootstrapContexts: cached `session-bootstrap` hook output keyed by
 *     sessionId. Written from `session_start`, consumed once on the first
 *     `before_prompt_build` for that session, then cleared.
 *
 *   - surfacedSessions: tracks which sessions have already received their
 *     first-turn bootstrap injection. Keyed by sessionId.
 *
 * Cleared together via `clearSessionState(sessionId)` from `session_end` and
 * `before_reset` event handlers.
 */

const bootstrapContexts = new Map<string, string>();
const surfacedSessions = new Set<string>();

export function setBootstrapContext(sessionId: string, ctx: string): void {
  bootstrapContexts.set(sessionId, ctx);
}

/**
 * One-shot read: returns the cached bootstrap context and removes it from
 * the cache. Subsequent calls for the same sessionId return undefined.
 */
export function takeBootstrapContext(sessionId: string): string | undefined {
  const ctx = bootstrapContexts.get(sessionId);
  if (ctx !== undefined) bootstrapContexts.delete(sessionId);
  return ctx;
}

export function markSessionSurfaced(sessionId: string): void {
  surfacedSessions.add(sessionId);
}

export function isSessionSurfaced(sessionId: string): boolean {
  return surfacedSessions.has(sessionId);
}

export function clearSessionState(sessionId: string): void {
  bootstrapContexts.delete(sessionId);
  surfacedSessions.delete(sessionId);
}

/**
 * Test-only helper: wipes all module state. Production code MUST NOT call this.
 */
export function _resetAllSessionStateForTests(): void {
  bootstrapContexts.clear();
  surfacedSessions.clear();
}
