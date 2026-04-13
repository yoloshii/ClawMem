/**
 * ClawMem OpenClaw Plugin — Event handlers (§14.3 pure-memory migration)
 *
 * After the §14.3 migration to `kind: "memory"`, ClawMem no longer
 * implements the `ContextEngine` interface. Lifecycle work now hangs off
 * `PluginHookName` events via `api.on()`, with state owned by
 * `session-state.ts` instead of an engine instance.
 *
 * Critical correctness contract for precompact:
 *
 *   `agent_end` (the typed PluginHookName event) is FIRE-AND-FORGET in
 *   OpenClaw core (`src/agents/pi-embedded-runner/run/attempt.ts:2226-2249`,
 *   literal comment "This is fire-and-forget, so we don't await"). The
 *   only awaited slot in the per-turn lifecycle that runs BEFORE compaction
 *   can fire is `before_prompt_build` (awaited at `attempt.ts:1661` because
 *   its return value `prependContext` is used to build the final prompt).
 *
 *   Therefore precompact-extract MUST run inside `handleBeforePromptBuild`,
 *   gated by the proximity heuristic in `compaction-threshold.ts`. The
 *   `handleAgentEnd` extractors (decision-extractor, handoff-generator,
 *   feedback-loop) are eventually-consistent vault writes and can tolerate
 *   the fire-and-forget context. `handleBeforeCompaction` exists only as
 *   a fire-and-forget defense-in-depth fallback for the rare case where
 *   `before_prompt_build` was skipped.
 */

import type { ClawMemConfig, ShellResult } from "./shell.js";
import {
  execHook as realExecHook,
  parseHookOutput as realParseHookOutput,
  extractContext as realExtractContext,
} from "./shell.js";
import {
  setBootstrapContext,
  takeBootstrapContext,
  markSessionSurfaced,
  isSessionSurfaced,
  clearSessionState,
} from "./session-state.js";

// =============================================================================
// Test seam — swappable hook execution
// =============================================================================
//
// Bun's `mock.module` is process-wide (not file-scoped) and leaks across
// test files in the same `bun test` invocation, contaminating shell-utility
// tests that need the real implementations. Instead of fighting the module
// mock semantics, the handlers route all hook execution through a small
// indirection that tests can swap via `setHookRunnerForTests`. Production
// callers never touch the swap — the default delegates to the real
// shell.ts implementations.

export type ExecHookFn = (
  cfg: ClawMemConfig,
  hookName: string,
  input: Record<string, unknown>,
  timeout?: number,
) => Promise<ShellResult>;

export type ParseHookOutputFn = (stdout: string) => Record<string, unknown> | null;

export type ExtractContextFn = (hookOutput: Record<string, unknown> | null) => string;

type HookRunner = {
  execHook: ExecHookFn;
  parseHookOutput: ParseHookOutputFn;
  extractContext: ExtractContextFn;
};

const defaultHookRunner: HookRunner = {
  execHook: realExecHook,
  parseHookOutput: realParseHookOutput,
  extractContext: realExtractContext,
};

let activeHookRunner: HookRunner = defaultHookRunner;

/**
 * Test-only seam: swap the default shell-out runner for a stub. Production
 * code MUST NOT call this. Tests should restore the default in `afterEach`
 * via `restoreHookRunnerForTests()`.
 */
export function setHookRunnerForTests(runner: Partial<HookRunner>): void {
  activeHookRunner = {
    execHook: runner.execHook ?? defaultHookRunner.execHook,
    parseHookOutput: runner.parseHookOutput ?? defaultHookRunner.parseHookOutput,
    extractContext: runner.extractContext ?? defaultHookRunner.extractContext,
  };
}

/**
 * Test-only seam: restore the default shell-out runner.
 */
export function restoreHookRunnerForTests(): void {
  activeHookRunner = defaultHookRunner;
}

// =============================================================================
// Test seam — swappable transcript-path resolver
// =============================================================================
//
// Mirrors the shell-runner indirection above but for the transcript-path
// resolver. Tests need to inject a stub that returns deterministic paths
// without touching the real OpenClaw state directory on disk.

export type ResolveSessionFileFn = (params: {
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
}) => string | undefined;

const defaultResolveSessionFile: ResolveSessionFileFn = (params) =>
  resolveOpenClawSessionFile(params);

let activeResolveSessionFile: ResolveSessionFileFn = defaultResolveSessionFile;

/**
 * Test-only seam: swap the default transcript-path resolver. Production
 * code MUST NOT call this. Tests should restore the default in `afterEach`
 * via `restoreSessionFileResolverForTests()`.
 */
export function setSessionFileResolverForTests(resolver: ResolveSessionFileFn): void {
  activeResolveSessionFile = resolver;
}

/**
 * Test-only seam: restore the default transcript-path resolver.
 */
export function restoreSessionFileResolverForTests(): void {
  activeResolveSessionFile = defaultResolveSessionFile;
}
import {
  estimateTokensFromMessages,
  isWithinPrecompactProximity,
  resolveCompactionThreshold,
  resolveProximityRatio,
  type CompactionThresholdConfig,
} from "./compaction-threshold.js";
import { resolveOpenClawSessionFile } from "./transcript-resolver.js";

// =============================================================================
// Logger interface (mirrors the OpenClaw plugin api.logger shape)
// =============================================================================

export type Logger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// =============================================================================
// Prompt cleaning (strips OpenClaw noise from the user prompt before search)
// =============================================================================

/**
 * Strip OpenClaw-specific noise from the user prompt before using it as a
 * search query. Gateway prompts contain metadata, system events, timestamps,
 * and previously injected context that degrade embedding/BM25 quality.
 */
export function cleanPromptForSearch(prompt: string): string {
  let cleaned = prompt;
  // Strip previously injected vault-context (avoid re-searching our own output)
  cleaned = cleaned.replace(/<vault-context>[\s\S]*?<\/vault-context>/g, "");
  cleaned = cleaned.replace(/<vault-routing>[\s\S]*?<\/vault-routing>/g, "");
  cleaned = cleaned.replace(/<vault-session>[\s\S]*?<\/vault-session>/g, "");
  // Strip OpenClaw sender metadata block
  cleaned = cleaned.replace(/Sender\s*\(untrusted metadata\)\s*:\s*```json\n[\s\S]*?```/g, "");
  cleaned = cleaned.replace(/Sender\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}\s*/g, "");
  // Strip OpenClaw runtime context blocks
  cleaned = cleaned.replace(/OpenClaw runtime context \(internal\):[\s\S]*?(?=\n\n|\n?$)/g, "");
  // Strip "System: ..." single-line event entries
  cleaned = cleaned.replace(/^System:.*$/gm, "");
  // Strip timestamp prefixes e.g. "[Sat 2026-03-14 16:19 GMT+8] "
  cleaned = cleaned.replace(/^\[.*?GMT[+-]\d+\]\s*/gm, "");
  // Collapse excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || prompt;
}

// =============================================================================
// Event payload shapes (mirror PluginHookName event types from OpenClaw core)
// =============================================================================

export type BeforePromptBuildEvent = {
  prompt: string;
  messages?: unknown[];
};

export type BeforePromptBuildContext = {
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  agentId?: string;
};

export type BeforePromptBuildResult = {
  prependContext?: string;
  systemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

export type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type AgentEndContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

export type BeforeCompactionEvent = {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
  messages?: unknown[];
  sessionFile?: string;
};

export type BeforeCompactionContext = {
  sessionKey?: string;
};

export type SessionStartEvent = {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
};

export type SessionStartContext = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
};

export type SessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
  reason?: string;
  sessionFile?: string;
};

export type BeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};

export type BeforeResetContext = {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
};

// =============================================================================
// Handler implementations
// =============================================================================

/**
 * before_prompt_build handler — the load-bearing path.
 *
 * Two responsibilities, both synchronous (this handler's promise is awaited
 * by core at `attempt.ts:1661`):
 *
 *   1. Surface relevant memory context via `context-surfacing` hook (and
 *      consume cached bootstrap context on the first turn for the session).
 *
 *   2. PRE-EMPTIVE PRECOMPACT: if the messages buffer is at or above the
 *      proximity ratio of the compaction threshold, run precompact-extract
 *      synchronously. This guarantees `precompact-state.md` is written
 *      BEFORE the LLM call begins on this turn — and the LLM call is what
 *      can trigger compaction. There is no race because `before_prompt_build`
 *      is awaited and runs strictly before any compaction trigger.
 *
 * Returns a `prependContext` so OpenClaw can insert the surfaced context
 * into the effective prompt at `attempt.ts:1670`.
 */
export async function handleBeforePromptBuild(
  cfg: ClawMemConfig,
  thresholdCfg: CompactionThresholdConfig,
  logger: Logger,
  event: BeforePromptBuildEvent,
  ctx: BeforePromptBuildContext,
): Promise<BeforePromptBuildResult | undefined> {
  if (!event.prompt || event.prompt.length < 5) return undefined;

  const sessionId = ctx.sessionId || "unknown";
  const isFirstTurn = !isSessionSurfaced(sessionId);

  let context = "";

  // First turn: consume cached bootstrap context (set during session_start)
  if (isFirstTurn) {
    markSessionSurfaced(sessionId);
    const bootstrapContext = takeBootstrapContext(sessionId);
    if (bootstrapContext) {
      context += bootstrapContext + "\n\n";
    }
  }

  // Every turn: prompt-aware retrieval via context-surfacing hook
  const searchPrompt = cleanPromptForSearch(event.prompt);
  const surfacingResult = await activeHookRunner.execHook(cfg, "context-surfacing", {
    session_id: sessionId,
    prompt: searchPrompt,
  });

  if (surfacingResult.exitCode === 0) {
    const parsed = activeHookRunner.parseHookOutput(surfacingResult.stdout);
    const surfacedContext = activeHookRunner.extractContext(parsed);
    if (surfacedContext) {
      context += surfacedContext;
    }
  } else {
    logger.warn(`clawmem: context-surfacing failed: ${surfacingResult.stderr}`);
  }

  // PRE-EMPTIVE PRECOMPACT (synchronous, awaited)
  // This is the load-bearing correctness path — must run BEFORE the LLM call
  // that could trigger compaction on this turn. Resolve the transcript path
  // via the resolver, which consults sessions.json (authoritative) and falls
  // back to filesystem probing. Pass sessionKey so the resolver can do exact
  // store lookups when available.
  const sessionFile = activeResolveSessionFile({
    sessionId,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
  });
  await maybeRunPrecompactExtract(cfg, thresholdCfg, logger, {
    sessionId,
    sessionFile,
    messages: event.messages,
  });

  if (!context.trim()) return undefined;
  return { prependContext: context.trim() };
}

/**
 * Run precompact-extract synchronously when the proximity heuristic indicates
 * compaction is imminent. Idempotent — over-firing is cheap (regex-only).
 *
 * Exported for the `before_compaction` defense-in-depth fallback handler.
 */
export async function maybeRunPrecompactExtract(
  cfg: ClawMemConfig,
  thresholdCfg: CompactionThresholdConfig,
  logger: Logger,
  params: {
    sessionId: string;
    sessionFile?: string;
    messages?: unknown[];
    force?: boolean;
  },
): Promise<void> {
  const force = params.force === true;
  if (!force) {
    const estimatedTokens = estimateTokensFromMessages(params.messages);
    const threshold = resolveCompactionThreshold(thresholdCfg);
    const proximityRatio = resolveProximityRatio(thresholdCfg);
    const within = isWithinPrecompactProximity({
      estimatedTokens,
      threshold,
      proximityRatio,
    });
    if (!within) return;
    logger.debug?.(
      `clawmem: precompact gate fired (tokens=${estimatedTokens} threshold=${threshold} ratio=${proximityRatio})`,
    );
  }

  // Hard precondition for the underlying hook: precompact-extract validates
  // `transcript_path` and returns empty if missing. Skip the shell-out
  // entirely when the resolver could not find a session file (fail-open).
  if (!params.sessionFile) {
    logger.debug?.(
      `clawmem: precompact-extract skipped — no transcript path resolved for session=${params.sessionId}`,
    );
    return;
  }

  const result = await activeHookRunner.execHook(cfg, "precompact-extract", {
    session_id: params.sessionId,
    transcript_path: params.sessionFile,
  });

  if (result.exitCode !== 0) {
    logger.warn(`clawmem: precompact-extract failed: ${result.stderr}`);
  }
}

/**
 * agent_end handler — eventually-consistent vault writes.
 *
 * Runs decision-extractor, handoff-generator, and feedback-loop in parallel
 * to persist the just-finished turn's observations. These writes are
 * idempotent via `saveMemory()` dedup and do NOT need to complete before
 * the next turn starts, so the fire-and-forget context at
 * `attempt.ts:2226-2249` is acceptable for them. (precompact-extract is
 * NOT in this handler — it lives in `handleBeforePromptBuild` for
 * correctness reasons documented at the top of this file.)
 */
export async function handleAgentEnd(
  cfg: ClawMemConfig,
  logger: Logger,
  event: AgentEndEvent,
  ctx: AgentEndContext,
): Promise<void> {
  if (!ctx.sessionId) return;
  // Skip when there's no meaningful content (heartbeats, empty turns)
  if (!Array.isArray(event.messages) || event.messages.length < 2) return;

  // PluginHookAgentEndEvent does NOT carry sessionFile — resolve the
  // transcript path via the resolver. Pass sessionKey so the resolver
  // can do an exact sessions.json lookup when available, which is the
  // only authoritative way to disambiguate base vs topic-scoped
  // transcripts when both coexist for the same sessionId.
  const sessionFile = activeResolveSessionFile({
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
  });
  if (!sessionFile) {
    logger.debug?.(
      `clawmem: agent_end extractors skipped — no transcript path resolved for session=${ctx.sessionId}`,
    );
    return;
  }

  const hookInput: Record<string, unknown> = {
    session_id: ctx.sessionId,
    transcript_path: sessionFile,
  };

  const [decisionResult, handoffResult, feedbackResult] = await Promise.allSettled([
    activeHookRunner.execHook(cfg, "decision-extractor", hookInput),
    activeHookRunner.execHook(cfg, "handoff-generator", hookInput),
    activeHookRunner.execHook(cfg, "feedback-loop", hookInput),
  ]);

  for (const [name, result] of [
    ["decision-extractor", decisionResult],
    ["handoff-generator", handoffResult],
    ["feedback-loop", feedbackResult],
  ] as const) {
    if (result.status === "rejected") {
      logger.warn(`clawmem: agent_end ${name} failed: ${String(result.reason)}`);
    } else if (result.value.exitCode !== 0) {
      logger.warn(`clawmem: agent_end ${name} error: ${result.value.stderr}`);
    }
  }
}

/**
 * before_compaction handler — defense-in-depth fallback only.
 *
 * Fire-and-forget at the OpenClaw call site (`pi-embedded-subscribe.handlers
 * .compaction.ts:25-38`), so this handler races with compaction and offers
 * no correctness guarantee on its own. It exists to catch the rare case
 * where `before_prompt_build` did not fire the precompact gate (e.g., the
 * proximity heuristic missed a sudden token-count jump). Forces precompact
 * regardless of proximity since by the time this runs, compaction is
 * already happening.
 */
export async function handleBeforeCompaction(
  cfg: ClawMemConfig,
  thresholdCfg: CompactionThresholdConfig,
  logger: Logger,
  event: BeforeCompactionEvent,
  ctx: BeforeCompactionContext,
): Promise<void> {
  // We can't reliably extract sessionId here — beforeCompactionEvent doesn't
  // carry it. Use sessionKey (or the sessionFile path stem) as a best-effort
  // fallback for the precompact-extract hook. precompact-extract reads the
  // transcript from the path so the session_id field is informational only.
  const sessionId = ctx.sessionKey || "compaction-fallback";
  await maybeRunPrecompactExtract(cfg, thresholdCfg, logger, {
    sessionId,
    sessionFile: event.sessionFile,
    messages: event.messages,
    force: true,
  });
}

/**
 * session_start handler — fires the `session-bootstrap` hook to gather
 * first-turn context and caches it for one-shot consumption by the next
 * `before_prompt_build` for this session.
 */
export async function handleSessionStart(
  cfg: ClawMemConfig,
  logger: Logger,
  event: SessionStartEvent,
  _ctx: SessionStartContext,
): Promise<void> {
  const result = await activeHookRunner.execHook(cfg, "session-bootstrap", {
    session_id: event.sessionId,
  });

  if (result.exitCode === 0) {
    const parsed = activeHookRunner.parseHookOutput(result.stdout);
    const bootstrapCtx = activeHookRunner.extractContext(parsed);
    if (bootstrapCtx) {
      setBootstrapContext(event.sessionId, bootstrapCtx);
    }
  } else {
    logger.warn(`clawmem: session-bootstrap failed: ${result.stderr}`);
  }

  logger.info(`clawmem: session started ${event.sessionId}`);
}

/**
 * session_end handler — clears per-session state.
 */
export function handleSessionEnd(
  logger: Logger,
  event: SessionEndEvent,
): void {
  clearSessionState(event.sessionId);
  logger.info(`clawmem: session ended ${event.sessionId} (${event.messageCount} messages)`);
}

/**
 * before_reset handler — runs extraction one last time before the session
 * clears, then wipes the per-session state. Mirrors the prior implementation's
 * "safety net for /new and /reset" behavior.
 */
export async function handleBeforeReset(
  cfg: ClawMemConfig,
  logger: Logger,
  event: BeforeResetEvent,
  ctx: BeforeResetContext,
): Promise<void> {
  if (!ctx.sessionId) return;

  // Prefer the explicit sessionFile from the event payload (PluginHookBeforeResetEvent
  // DOES carry it). Fall back to resolving via OpenClaw's canonical layout
  // when the event payload is missing the field. Skip the extractor sweep
  // entirely when neither path is available — extractors silently no-op
  // without transcript_path anyway.
  const sessionFile =
    event.sessionFile ??
    activeResolveSessionFile({
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
    });
  if (!sessionFile) {
    clearSessionState(ctx.sessionId);
    logger.debug?.(
      `clawmem: before_reset extractor sweep skipped — no transcript path resolved for session=${ctx.sessionId}`,
    );
    return;
  }

  const hookInput: Record<string, unknown> = {
    session_id: ctx.sessionId,
    transcript_path: sessionFile,
  };

  await Promise.allSettled([
    activeHookRunner.execHook(cfg, "decision-extractor", hookInput),
    activeHookRunner.execHook(cfg, "handoff-generator", hookInput),
    activeHookRunner.execHook(cfg, "feedback-loop", hookInput),
  ]);

  clearSessionState(ctx.sessionId);
  logger.info(`clawmem: before_reset cleanup for ${ctx.sessionId}`);
}
