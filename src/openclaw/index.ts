/**
 * ClawMem OpenClaw Plugin — Entry Point (§14.3 pure-memory migration)
 *
 * Registers ClawMem as an OpenClaw `kind: "memory"` plugin. The previous
 * `kind: "context-engine"` registration is gone — ClawMem no longer
 * implements the `ContextEngine` interface and OpenClaw's built-in
 * `LegacyContextEngine` (or any third-party LCM plugin the user installs)
 * now owns compaction.
 *
 * What ClawMem provides under the memory slot:
 *   1. MemoryPluginCapability via `api.registerMemoryCapability()` — gives
 *      OpenClaw a `MemoryPluginRuntime.resolveMemoryBackendConfig()` so the
 *      runtime knows ClawMem owns memory for this agent. The
 *      `getMemorySearchManager` slot is a stub (ClawMem retrieval flows
 *      through the existing hook + REST API path, not OpenClaw's memory
 *      search manager).
 *
 *   2. PluginHookName event subscriptions via `api.on()` for the lifecycle
 *      work that the deleted ContextEngine class used to handle:
 *
 *        before_prompt_build — context surfacing + pre-emptive precompact
 *                              (the only awaited correctness path for
 *                              precompact-extract on the per-turn lifecycle)
 *        agent_end           — decision-extractor, handoff-generator,
 *                              feedback-loop (eventually-consistent vault
 *                              writes; fire-and-forget context is OK)
 *        before_compaction   — fire-and-forget precompact-extract fallback
 *                              (defense-in-depth only, never load-bearing)
 *        session_start       — session-bootstrap hook + cache result for
 *                              first-turn before_prompt_build consumption
 *        session_end         — clearSessionState
 *        before_reset        — extraction one last time + clearSessionState
 *
 *   3. Agent tools registration (clawmem_search, clawmem_get, etc.) when
 *      enableTools is set in plugin config — unchanged from prior version.
 *
 *   4. REST API service (`clawmem serve`) lifecycle — unchanged.
 *
 * §14.3 critical correctness contract: `agent_end` is fire-and-forget at
 * `attempt.ts:2470-2496`. Precompact-extract MUST run inside
 * `handleBeforePromptBuild` (which IS awaited at `attempt.ts:1873`), gated
 * by the proximity heuristic in `compaction-threshold.ts`. See `engine.ts`
 * top-of-file comment for the full rationale.
 */

import { resolveClawMemBin } from "./shell.js";
import type { ClawMemConfig } from "./shell.js";
import { createTools } from "./tools.js";
import {
  handleAgentEnd,
  handleBeforeCompaction,
  handleBeforePromptBuild,
  handleBeforeReset,
  handleSessionEnd,
  handleSessionStart,
  type AgentEndContext,
  type AgentEndEvent,
  type BeforeCompactionContext,
  type BeforeCompactionEvent,
  type BeforePromptBuildContext,
  type BeforePromptBuildEvent,
  type BeforeResetContext,
  type BeforeResetEvent,
  type Logger,
  type SessionEndEvent,
  type SessionStartContext,
  type SessionStartEvent,
} from "./engine.js";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_RESERVE_TOKENS_FLOOR,
  DEFAULT_SOFT_THRESHOLD_TOKENS,
  PRECOMPACT_PROXIMITY_RATIO_DEFAULT,
  type CompactionThresholdConfig,
} from "./compaction-threshold.js";

// =============================================================================
// Plugin definition
// =============================================================================

const PROFILE_BUDGETS: Record<string, number> = {
  speed: 400,
  balanced: 800,
  deep: 1200,
};

const clawmemPlugin = {
  id: "clawmem",
  name: "ClawMem",
  description:
    "On-device hybrid memory layer for OpenClaw — composite scoring, graph traversal, lifecycle management, and pre-emptive compaction state extraction",
  version: "0.10.1",
  kind: "memory" as const,

  register(api: any) {
    // ----- Resolve config -----
    const pluginCfg = (api.pluginConfig || {}) as Record<string, unknown>;
    const profile = (pluginCfg.profile as string) || "balanced";
    const tokenBudget = (pluginCfg.tokenBudget as number) || PROFILE_BUDGETS[profile] || 800;

    const cfg: ClawMemConfig = {
      clawmemBin: resolveClawMemBin(pluginCfg.clawmemBin as string | undefined),
      tokenBudget,
      profile,
      enableTools: pluginCfg.enableTools !== false,
      servePort: (pluginCfg.servePort as number) || 7438,
      env: {
        ...(pluginCfg.gpuEmbed ? { CLAWMEM_EMBED_URL: pluginCfg.gpuEmbed as string } : {}),
        ...(pluginCfg.gpuLlm ? { CLAWMEM_LLM_URL: pluginCfg.gpuLlm as string } : {}),
        ...(pluginCfg.gpuLlmModel ? { CLAWMEM_LLM_MODEL: pluginCfg.gpuLlmModel as string } : {}),
        ...(pluginCfg.gpuLlmReasoningEffort
          ? { CLAWMEM_LLM_REASONING_EFFORT: pluginCfg.gpuLlmReasoningEffort as string }
          : {}),
        ...(pluginCfg.gpuLlmNoThink !== undefined
          ? { CLAWMEM_LLM_NO_THINK: String(pluginCfg.gpuLlmNoThink) }
          : {}),
        ...(pluginCfg.gpuRerank ? { CLAWMEM_RERANK_URL: pluginCfg.gpuRerank as string } : {}),
        CLAWMEM_PROFILE: profile,
      },
    };

    const thresholdCfg: CompactionThresholdConfig = {
      contextWindowTokens:
        (pluginCfg.compactionContextWindow as number | undefined) ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      precompactProximityRatio:
        (pluginCfg.precompactProximityRatio as number | undefined) ??
        PRECOMPACT_PROXIMITY_RATIO_DEFAULT,
      softThresholdTokens:
        (pluginCfg.softThresholdTokens as number | undefined) ?? DEFAULT_SOFT_THRESHOLD_TOKENS,
      reserveTokensFloor:
        (pluginCfg.reserveTokensFloor as number | undefined) ?? DEFAULT_RESERVE_TOKENS_FLOOR,
    };

    const logger = api.logger as Logger;
    logger.info(
      `clawmem: plugin registered (kind=memory, bin=${cfg.clawmemBin}, profile=${profile}, budget=${tokenBudget})`,
    );

    // ----- Register memory capability -----
    // ClawMem owns the memory slot for this agent. The runtime stub returns
    // null for getMemorySearchManager because ClawMem retrieval flows through
    // the before_prompt_build hook + REST API path, not OpenClaw's memory
    // search manager interface. resolveMemoryBackendConfig signals "builtin"
    // so OpenClaw's auto-reply memory-flush path treats this agent as
    // memory-managed.
    api.registerMemoryCapability({
      runtime: {
        async getMemorySearchManager(_params: {
          cfg: unknown;
          agentId: string;
          purpose?: "default" | "status";
        }) {
          return { manager: null };
        },
        resolveMemoryBackendConfig(_params: { cfg: unknown; agentId: string }) {
          return { backend: "builtin" as const };
        },
      },
    });

    // ----- Plugin Hook: before_prompt_build (AWAITED — load-bearing path) -----
    // Both context-surfacing retrieval injection and pre-emptive precompact
    // extraction live here. handleBeforePromptBuild is async and the OpenClaw
    // attempt path awaits the result at attempt.ts:1873 before building the
    // effective prompt. precompact-extract therefore runs strictly before
    // the LLM call that could trigger compaction on this turn.
    api.on(
      "before_prompt_build",
      async (event: BeforePromptBuildEvent, ctx: BeforePromptBuildContext) => {
        return handleBeforePromptBuild(cfg, thresholdCfg, logger, event, ctx);
      },
      { priority: 10 },
    );

    // ----- Plugin Hook: agent_end (FIRE-AND-FORGET in core) -----
    // Decision-extractor, handoff-generator, and feedback-loop run here.
    // These writes are eventually-consistent (saveMemory dedupes), so the
    // fire-and-forget context at attempt.ts:2470-2496 is acceptable.
    // precompact-extract is intentionally NOT in this handler — it lives
    // in handleBeforePromptBuild for correctness reasons.
    api.on("agent_end", async (event: AgentEndEvent, ctx: AgentEndContext) => {
      await handleAgentEnd(cfg, logger, event, ctx);
    });

    // ----- Plugin Hook: before_compaction (FIRE-AND-FORGET fallback only) -----
    // Defense-in-depth only — the load-bearing precompact path is in
    // before_prompt_build above. This handler races with compaction itself
    // and offers no correctness guarantee on its own.
    api.on(
      "before_compaction",
      async (event: BeforeCompactionEvent, ctx: BeforeCompactionContext) => {
        await handleBeforeCompaction(cfg, thresholdCfg, logger, event, ctx);
      },
    );

    // ----- Plugin Hook: session_start -----
    api.on("session_start", async (event: SessionStartEvent, ctx: SessionStartContext) => {
      await handleSessionStart(cfg, logger, event, ctx);
    });

    // ----- Plugin Hook: session_end -----
    api.on("session_end", async (event: SessionEndEvent, _ctx: unknown) => {
      handleSessionEnd(logger, event);
    });

    // ----- Plugin Hook: before_reset -----
    api.on("before_reset", async (event: BeforeResetEvent, ctx: BeforeResetContext) => {
      await handleBeforeReset(cfg, logger, event, ctx);
    });

    // ----- Register Tools -----
    if (cfg.enableTools) {
      const tools = createTools(cfg, logger);
      for (const tool of tools) {
        api.registerTool(
          {
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            async execute(toolCallId: string, params: Record<string, unknown>) {
              return tool.execute(toolCallId, params);
            },
          },
          { name: tool.name },
        );
      }
      logger.info(`clawmem: registered ${tools.length} agent tools`);
    }

    // ----- Register Service (REST API) -----
    let serveChild: import("node:child_process").ChildProcess | null = null;

    api.registerService({
      id: "clawmem-api",
      async start(svcCtx: { logger: Logger }) {
        const { spawnBackground } = await import("./shell.js");
        serveChild = spawnBackground(cfg, ["serve", "--port", String(cfg.servePort)], svcCtx.logger);
        svcCtx.logger.info(`clawmem: REST API spawned (pid=${serveChild.pid})`);
      },
      stop() {
        if (serveChild && !serveChild.killed) {
          serveChild.kill("SIGTERM");
          logger.info("clawmem: REST API service stopped");
        }
        serveChild = null;
      },
    });
  },
};

export default clawmemPlugin;
