/**
 * ClawMem OpenClaw Plugin — Shell-out utilities
 *
 * Phase 1 transport: spawn `clawmem hook <name>` as a Bun subprocess.
 * All hook handlers accept JSON on stdin and return JSON on stdout.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export type ClawMemConfig = {
  clawmemBin: string;
  tokenBudget: number;
  profile: string;
  enableTools: boolean;
  servePort: number;
  env: Record<string, string>;
};

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

// =============================================================================
// Binary Resolution
// =============================================================================

const SEARCH_PATHS = [
  // Relative to this plugin (ClawMem repo layout)
  resolve(__dirname, "../../bin/clawmem"),
  // Common install locations
  "/usr/local/bin/clawmem",
  resolve(process.env.HOME || "/tmp", "Projects/forge-stack/skill-forge/clawmem/bin/clawmem"),
  resolve(process.env.HOME || "/tmp", "clawmem/bin/clawmem"),
];

export function resolveClawMemBin(configured?: string): string {
  if (configured && existsSync(configured)) return configured;

  for (const p of SEARCH_PATHS) {
    if (existsSync(p)) return p;
  }

  // Fallback: assume it's on PATH
  return "clawmem";
}

// =============================================================================
// Shell Execution
// =============================================================================

const DEFAULT_TIMEOUT = 10_000; // 10s for most hooks
const EXTRACTION_TIMEOUT = 30_000; // 30s for LLM-based extraction

/**
 * Execute a clawmem hook with JSON on stdin, capture JSON stdout.
 * Fail-open: returns empty result on timeout or error.
 */
export function execHook(
  cfg: ClawMemConfig,
  hookName: string,
  input: Record<string, unknown>,
  timeout?: number
): Promise<ShellResult> {
  const hookTimeout = timeout ?? (
    hookName === "decision-extractor" || hookName === "handoff-generator"
      ? EXTRACTION_TIMEOUT
      : DEFAULT_TIMEOUT
  );

  return new Promise((resolve) => {
    const child = execFile(
      cfg.clawmemBin,
      ["hook", hookName],
      {
        timeout: hookTimeout,
        env: { ...process.env, ...cfg.env },
        maxBuffer: 1024 * 1024, // 1MB
      },
      (error, stdout, stderr) => {
        if (error) {
          // Fail-open: log but don't throw
          const msg = (error as any).killed
            ? `timeout after ${hookTimeout}ms`
            : String(error.message || error);
          resolve({
            stdout: "",
            stderr: `[clawmem-plugin] hook ${hookName} failed: ${msg}\n${stderr}`,
            exitCode: (error as any).code ?? 1,
          });
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: 0 });
      }
    );

    // Send hook input on stdin
    if (child.stdin) {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  });
}

/**
 * Execute a clawmem CLI command (non-hook).
 */
export function execCommand(
  cfg: ClawMemConfig,
  args: string[],
  timeout: number = DEFAULT_TIMEOUT
): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      cfg.clawmemBin,
      args,
      {
        timeout,
        env: { ...process.env, ...cfg.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            stdout: "",
            stderr: `[clawmem-plugin] command failed: ${String(error.message || error)}\n${stderr}`,
            exitCode: (error as any).code ?? 1,
          });
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: 0 });
      }
    );
  });
}

/**
 * Spawn a long-lived background process (e.g., `clawmem serve`).
 * Returns the child process handle for lifecycle management.
 * The child is detached from the parent's event loop via unref().
 */
export function spawnBackground(
  cfg: ClawMemConfig,
  args: string[],
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void }
): ChildProcess {
  const child = spawn(cfg.clawmemBin, args, {
    env: { ...process.env, ...cfg.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    logger?.info(`[clawmem-serve] ${data.toString().trim()}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    logger?.warn(`[clawmem-serve] ${data.toString().trim()}`);
  });

  child.on("exit", (code, signal) => {
    logger?.warn(`[clawmem-serve] exited (code=${code}, signal=${signal})`);
  });

  child.unref();
  return child;
}

/**
 * Parse hook output JSON. Returns null on parse failure.
 */
export function parseHookOutput(stdout: string): Record<string, unknown> | null {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    // Hook output may have non-JSON preamble (stderr leak)
    // Try to find the last JSON object
    const lastBrace = stdout.lastIndexOf("}");
    const firstBrace = stdout.indexOf("{");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Extract additionalContext from hook output.
 * Hooks return: { hookSpecificOutput: { additionalContext: "..." } }
 */
export function extractContext(hookOutput: Record<string, unknown> | null): string {
  if (!hookOutput) return "";
  const hso = hookOutput.hookSpecificOutput as Record<string, unknown> | undefined;
  return (hso?.additionalContext as string) || "";
}
