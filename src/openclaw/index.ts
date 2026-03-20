/**
 * ClawMem OpenClaw Plugin — Entry Point
 *
 * Registers ClawMem as an OpenClaw ContextEngine plugin with:
 * 1. ContextEngine (engine.ts) — lifecycle: afterTurn, compact, bootstrap
 * 2. Plugin hooks — before_prompt_build (retrieval), session_start/end, before_reset
 * 3. Agent tools — clawmem_search, clawmem_get, clawmem_session_log, clawmem_timeline, clawmem_similar
 * 4. Service — starts clawmem serve (REST API) for tool HTTP calls
 *
 * Architecture per GPT 5.4 High review:
 * - Prompt-aware retrieval goes through before_prompt_build (has the user prompt)
 * - Post-turn extraction goes through ContextEngine.afterTurn() (has messages[])
 * - Compaction goes through ContextEngine.compact() → precompact-extract → delegate to legacy
 * - assemble() is minimal pass-through (retrieval already injected via hook)
 */

import { ClawMemContextEngine } from "./engine.js";
import { resolveClawMemBin, execHook, parseHookOutput, extractContext } from "./shell.js";
import type { ClawMemConfig } from "./shell.js";
import { createTools } from "./tools.js";

// =============================================================================
// Prompt Cleaning (strips OpenClaw noise for better retrieval)
// Pattern extracted from memory-core-plus (MIT, aloong-planet)
// =============================================================================

/**
 * Strip OpenClaw-specific noise from the user prompt before using it as a
 * search query. Gateway prompts contain metadata, system events, timestamps,
 * and previously injected context that degrade embedding/BM25 quality.
 */
function cleanPromptForSearch(prompt: string): string {
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
// Plugin Definition
// =============================================================================

const PROFILE_BUDGETS: Record<string, number> = {
  speed: 400,
  balanced: 800,
  deep: 1200,
};

const clawmemPlugin = {
  id: "clawmem",
  name: "ClawMem",
  description: "On-device hybrid memory system with composite scoring, graph traversal, and lifecycle management",
  version: "0.2.0",
  kind: "context-engine" as const,

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
        ...(pluginCfg.gpuRerank ? { CLAWMEM_RERANK_URL: pluginCfg.gpuRerank as string } : {}),
        CLAWMEM_PROFILE: profile,
      },
    };

    const logger = api.logger;
    logger.info(`clawmem: plugin registered (bin: ${cfg.clawmemBin}, profile: ${profile}, budget: ${tokenBudget})`);

    // ----- Register ContextEngine -----
    const engine = new ClawMemContextEngine(cfg, logger);
    api.registerContextEngine("clawmem", () => engine);

    // ----- Track first-turn per session -----
    const surfacedSessions = new Set<string>();

    // ----- Plugin Hook: before_prompt_build -----
    // This is WHERE retrieval happens (P1 finding: assemble() lacks the user prompt)
    api.on("before_prompt_build", async (
      event: { prompt: string; messages?: unknown[] },
      ctx: { sessionId?: string; sessionKey?: string }
    ) => {
      if (!event.prompt || event.prompt.length < 5) return;

      const sessionId = ctx.sessionId || "unknown";
      const isFirstTurn = !surfacedSessions.has(sessionId);

      let context = "";

      // On first turn: run session-bootstrap for profile + handoff + decisions + stale
      if (isFirstTurn) {
        surfacedSessions.add(sessionId);

        const bootstrapResult = await execHook(cfg, "session-bootstrap", {
          session_id: sessionId,
        });

        if (bootstrapResult.exitCode === 0) {
          const parsed = parseHookOutput(bootstrapResult.stdout);
          // Session-bootstrap outputs context directly to stdout (not via hookSpecificOutput)
          // It uses the system_message field for SessionStart hooks
          const bootstrapContext = (parsed?.systemMessage as string) || "";
          if (bootstrapContext) {
            context += bootstrapContext + "\n\n";
          }
        } else {
          logger.warn(`clawmem: session-bootstrap failed: ${bootstrapResult.stderr}`);
        }
      }

      // Every turn: run context-surfacing for prompt-aware retrieval
      // Clean the prompt to remove OpenClaw noise before search
      const searchPrompt = cleanPromptForSearch(event.prompt);
      const surfacingResult = await execHook(cfg, "context-surfacing", {
        session_id: sessionId,
        prompt: searchPrompt,
      });

      if (surfacingResult.exitCode === 0) {
        const parsed = parseHookOutput(surfacingResult.stdout);
        const surfacedContext = extractContext(parsed);
        if (surfacedContext) {
          context += surfacedContext;
        }
      } else {
        logger.warn(`clawmem: context-surfacing failed: ${surfacingResult.stderr}`);
      }

      if (!context.trim()) return;

      return { prependContext: context.trim() };
    }, { priority: 10 }); // Run early to prepend context before other hooks

    // ----- Plugin Hook: session_start -----
    api.on("session_start", async (
      event: { sessionId: string; sessionKey?: string },
      _ctx: unknown
    ) => {
      logger.info?.(`clawmem: session started ${event.sessionId}`);
    });

    // ----- Plugin Hook: session_end -----
    api.on("session_end", async (
      event: { sessionId: string; sessionKey?: string; messageCount: number },
      _ctx: unknown
    ) => {
      // Cleanup tracked state
      surfacedSessions.delete(event.sessionId);
      logger.info?.(`clawmem: session ended ${event.sessionId} (${event.messageCount} messages)`);
    });

    // ----- Plugin Hook: before_reset -----
    // Safety net for /new and /reset — ensure extraction runs before session clears
    api.on("before_reset", async (
      event: { sessionFile?: string; messages?: unknown[]; reason?: string },
      ctx: { sessionId?: string; sessionKey?: string }
    ) => {
      if (!event.sessionFile || !ctx.sessionId) return;

      // Run extraction hooks before reset clears the session
      const hookInput = {
        session_id: ctx.sessionId,
        transcript_path: event.sessionFile,
      };

      await Promise.allSettled([
        execHook(cfg, "decision-extractor", hookInput),
        execHook(cfg, "handoff-generator", hookInput),
        execHook(cfg, "feedback-loop", hookInput),
      ]);

      surfacedSessions.delete(ctx.sessionId);
    });

    // ----- Plugin Hook: before_compaction -----
    // Fire precompact-extract before compaction starts (additional safety — compact()
    // also runs it, but before_compaction fires earlier in the pipeline)
    api.on("before_compaction", async (
      event: { sessionFile?: string; messageCount: number },
      ctx: { sessionId?: string }
    ) => {
      if (!event.sessionFile || !ctx.sessionId) return;

      await execHook(cfg, "precompact-extract", {
        session_id: ctx.sessionId,
        transcript_path: event.sessionFile,
      });
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
          { name: tool.name }
        );
      }
      logger.info(`clawmem: registered ${tools.length} agent tools`);
    }

    // ----- Register Service (REST API) -----
    let serveChild: import("node:child_process").ChildProcess | null = null;

    api.registerService({
      id: "clawmem-api",
      async start(svcCtx: { logger: typeof logger }) {
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
