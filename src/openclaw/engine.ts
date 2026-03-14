/**
 * ClawMem ContextEngine — OpenClaw integration
 *
 * Implements the ContextEngine interface for OpenClaw's plugin system.
 * Phase 1: thin shim that shells out to `clawmem hook <name>` for lifecycle operations.
 *
 * Architecture (per GPT 5.4 High review):
 * - assemble(): minimal pass-through (real retrieval happens in before_prompt_build hook)
 * - afterTurn(): shells out to decision-extractor, handoff-generator, feedback-loop
 * - compact(): shells out to precompact-extract, then delegates to legacy compaction (ownsCompaction: false)
 * - ingest(): no-op (ClawMem captures at turn boundaries, not per-message)
 * - bootstrap(): session registration only (context injection via before_prompt_build hook)
 */

import type { ClawMemConfig } from "./shell.js";
import { execHook, parseHookOutput } from "./shell.js";

// =============================================================================
// Types (matching OpenClaw's ContextEngine interface without importing it)
// =============================================================================

type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
};

type AssembleResult = {
  messages: unknown[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

type IngestResult = { ingested: boolean };
type IngestBatchResult = { ingestedCount: number };
type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
};

type SubagentSpawnPreparation = { rollback: () => void | Promise<void> };
type SubagentEndReason = "deleted" | "completed" | "swept" | "released";

// =============================================================================
// Logger interface
// =============================================================================

type Logger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// =============================================================================
// ClawMem ContextEngine
// =============================================================================

export class ClawMemContextEngine {
  readonly info: ContextEngineInfo = {
    id: "clawmem",
    name: "ClawMem Memory System",
    version: "0.2.0",
    ownsCompaction: false, // Delegate compaction to legacy engine
  };

  private bootstrappedSessions = new Set<string>();

  constructor(
    private readonly cfg: ClawMemConfig,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // bootstrap — register session, no context injection (P1 finding: bootstrap
  // return type has no prompt injection field)
  // ---------------------------------------------------------------------------

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    this.bootstrappedSessions.add(params.sessionId);

    // Fire session-bootstrap hook for session registration + side effects
    // (profile refresh, session_log entry). Context is NOT injected here —
    // that happens in the before_prompt_build plugin hook.
    const result = await execHook(this.cfg, "session-bootstrap", {
      session_id: params.sessionId,
      transcript_path: params.sessionFile,
    });

    if (result.exitCode !== 0) {
      this.logger.warn(`clawmem: bootstrap hook failed: ${result.stderr}`);
    }

    return { bootstrapped: true };
  }

  // ---------------------------------------------------------------------------
  // ingest — no-op (ClawMem captures at turn boundaries via afterTurn)
  // ---------------------------------------------------------------------------

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  // ---------------------------------------------------------------------------
  // ingestBatch — no-op
  // ---------------------------------------------------------------------------

  async ingestBatch?(_params: {
    sessionId: string;
    sessionKey?: string;
    messages: unknown[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    return { ingestedCount: 0 };
  }

  // ---------------------------------------------------------------------------
  // assemble — minimal pass-through (P1 finding: assemble() lacks the user
  // prompt, so retrieval must happen in before_prompt_build hook instead)
  // ---------------------------------------------------------------------------

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: unknown[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Pass-through: retrieval already injected via before_prompt_build hook
    return {
      messages: params.messages,
      estimatedTokens: 0, // Caller handles estimation
    };
  }

  // ---------------------------------------------------------------------------
  // afterTurn — run extraction hooks (decision-extractor, handoff-generator,
  // feedback-loop) in parallel. These process the completed turn and persist
  // decisions, handoff notes, and confidence boosts.
  // ---------------------------------------------------------------------------

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: unknown[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
  }): Promise<void> {
    // Skip extraction for heartbeat turns
    if (params.isHeartbeat) return;

    // Skip if too few messages (no meaningful content to extract)
    const newMessages = params.messages.length - params.prePromptMessageCount;
    if (newMessages < 2) return;

    const hookInput = {
      session_id: params.sessionId,
      transcript_path: params.sessionFile,
    };

    // Fire all three Stop hooks in parallel (independent operations)
    const [decisionResult, handoffResult, feedbackResult] = await Promise.allSettled([
      execHook(this.cfg, "decision-extractor", hookInput),
      execHook(this.cfg, "handoff-generator", hookInput),
      execHook(this.cfg, "feedback-loop", hookInput),
    ]);

    // Log failures but don't throw (fail-open)
    for (const [name, result] of [
      ["decision-extractor", decisionResult],
      ["handoff-generator", handoffResult],
      ["feedback-loop", feedbackResult],
    ] as const) {
      if (result.status === "rejected") {
        this.logger.warn(`clawmem: afterTurn ${name} failed: ${result.reason}`);
      } else if (result.value.exitCode !== 0) {
        this.logger.warn(`clawmem: afterTurn ${name} error: ${result.value.stderr}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // compact — run precompact-extract for state preservation, then return
  // ownsCompaction: false so OpenClaw's legacy compaction still runs.
  // P1 finding: compact() must still perform real compaction; precompact-extract
  // is a side effect, not a compactor. We delegate real compaction to legacy.
  // ---------------------------------------------------------------------------

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
  }): Promise<CompactResult> {
    // Run precompact-extract to preserve state before compaction
    const extractResult = await execHook(this.cfg, "precompact-extract", {
      session_id: params.sessionId,
      transcript_path: params.sessionFile,
    });

    if (extractResult.exitCode !== 0) {
      this.logger.warn(`clawmem: precompact-extract failed: ${extractResult.stderr}`);
    }

    // Return not-compacted — let legacy engine handle actual compaction
    // (ownsCompaction: false means OpenClaw will call legacy compact() after us)
    return {
      ok: true,
      compacted: false,
      reason: "clawmem-precompact-only",
    };
  }

  // ---------------------------------------------------------------------------
  // prepareSubagentSpawn — placeholder for future per-subagent memory scoping
  // ---------------------------------------------------------------------------

  async prepareSubagentSpawn?(_params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined> {
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // onSubagentEnded — placeholder
  // ---------------------------------------------------------------------------

  async onSubagentEnded?(_params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void> {
    // No-op for now
  }

  // ---------------------------------------------------------------------------
  // dispose — cleanup
  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.bootstrappedSessions.clear();
  }

  // ---------------------------------------------------------------------------
  // Helper: check if session has been bootstrapped (used by prompt hook)
  // ---------------------------------------------------------------------------

  isBootstrapped(sessionId: string): boolean {
    return this.bootstrappedSessions.has(sessionId);
  }
}
