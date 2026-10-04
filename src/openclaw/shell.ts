/**
 * ClawMem OpenClaw Plugin — Shell-out utilities
 *
 * Phase 1 transport: spawn `clawmem hook <name>` as a Bun subprocess.
 * All hook handlers accept JSON on stdin and return JSON on stdout.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ESM equivalent of CommonJS __dirname. This package declares
// "type": "module", so __dirname is not defined when loaded by a plain
// Node.js ESM loader (e.g. OpenClaw's plugin host). Bun shims __dirname
// in ESM, which is why this regression is invisible under `bun test`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// The REST token (BACKLOG 62.4) — mirrored from src/server-guard.ts to keep this directory self-contained
// =============================================================================

/** A managed serve's token: set by the plugin's REST service once `clawmem serve-token` answered; tools read it per call. */
export type ServeAuth = { token: string | null };

const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const TOKEN_RULE = "32-4096 characters of A-Z a-z 0-9 - . _ ~ + / with optional trailing =";
export const validServeToken = (t: string): boolean => t.length >= 32 && t.length <= 4096 && B64TOKEN.test(t);

/** `readSync`'s shape for one buffer slice: returns how many bytes it read, which may be fewer than asked. */
export type ReadFn = (fd: number, buf: Buffer, offset: number, length: number, position: number) => number;
const readFd: ReadFn = (fd, buf, offset, length, position) => readSync(fd, buf, offset, length, position);

/**
 * The token `clawmem serve` generated at `path`, under the rules serve applies: the directory is this user's and not
 * group- or world-writable (or another user could replace the file), and the file is opened without following a
 * symlink and checked on that descriptor. Exported for the tests, which pass a `read` that returns short counts.
 */
export function readServeTokenFile(path: string, read: ReadFn = readFd): string | null {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (uid !== null) {
    let dst;
    try {
      dst = statSync(realpathSync(dirname(path)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`cannot read the config directory ${dirname(path)}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
    if (!dst.isDirectory() || dst.uid !== uid || (dst.mode & 0o022) !== 0) {
      throw new Error(`the config directory ${dirname(path)} is not this user's alone (another user could replace the token file)`);
    }
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot open the token file ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 4096) throw new Error(`the token file ${path} is not a regular file of at most 4 KiB`);
    if (uid !== null && (st.uid !== uid || (st.mode & 0o077) !== 0)) {
      throw new Error(`the token file ${path} is not this user's alone (chmod 600 it, or remove it so serve makes another)`);
    }
    // A read may return fewer bytes than asked before the end of the file: read until all of it is in.
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = read(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString("utf-8").trim();
    if (!validServeToken(text)) throw new Error(`the token file ${path} does not hold a valid token (${TOKEN_RULE})`);
    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * The REST client's token under its effective environment — `{ ...process.env, ...cfg.env }`, the overlay
 * `spawnBackground` gives a managed serve, so `cfg.env.CLAWMEM_API_TOKEN = ""` means unset on both ends: a non-empty
 * CLAWMEM_API_TOKEN, else serve's token file under CLAWMEM_CONFIG_DIR. A problem names what is wrong, never the value.
 */
export function clientServeToken(cfg: ClawMemConfig): { token: string | null; problem?: string } {
  const env: Record<string, string | undefined> = { ...process.env, ...cfg.env };
  const fromEnv = env.CLAWMEM_API_TOKEN ?? "";
  if (fromEnv !== "") {
    return validServeToken(fromEnv) ? { token: fromEnv } : { token: null, problem: `CLAWMEM_API_TOKEN is not a valid token (${TOKEN_RULE})` };
  }
  try {
    return { token: readServeTokenFile(join(env.CLAWMEM_CONFIG_DIR || join(homedir(), ".config", "clawmem"), "serve-token")) };
  } catch (e) {
    return { token: null, problem: (e as Error).message };
  }
}

/**
 * The token a managed serve starts with: `clawmem serve-token` through the same binary and environment as the serve, so
 * the checkout's .env (the wrapper applies it to unset variables only) reaches both alike.
 */
export function runServeToken(cfg: ClawMemConfig): Promise<{ token: string } | { problem: string }> {
  return new Promise((done) => {
    execFile(cfg.clawmemBin, ["serve-token"], { env: { ...process.env, ...cfg.env }, timeout: 30_000 }, (err, stdout, stderr) => {
      const token = String(stdout ?? "").trim();
      if (!err && validServeToken(token)) return done({ token });
      const why = String(stderr ?? "").trim().slice(-500);
      done({ problem: (token ? why.split(token).join("<redacted>") : why) || `exit ${(err as { code?: unknown } | null)?.code ?? "?"}` });
    });
  });
}

// =============================================================================
// Types
// =============================================================================

export type ClawMemConfig = {
  clawmemBin: string;
  tokenBudget: number;
  profile: string;
  enableTools: boolean;
  servePort: number;
  /**
   * The context-surfacing hook's authoritative wall-clock budget in ms. It is
   * handed to the child as CLAWMEM_HOOK_BUDGET_MS (honored from ClawMem v0.38;
   * older hooks ignore it), and every outer timeout derives from it — see
   * contextSurfacingKillTimeoutMs / hostHookTimeoutMs.
   */
  hookBudgetMs?: number;
  env: Record<string, string>;
};

// =============================================================================
// Hook budget contract
// =============================================================================
//
// One number, three layers, always ordered inner < middle < outer:
//   hookBudgetMs                 the hook schedules its own legs against this
//   + HOOK_KILL_MARGIN_MS        process start-up and JSON finalization
//   = child kill timeout         execFile kills the child here
//   + HOST_TIMEOUT_MARGIN_MS     the host's own timer must fire AFTER our kill
//   = before_prompt_build timeoutMs passed to the OpenClaw registration
// Raising hookBudgetMs alone is pointless when the operator's OpenClaw hook
// policy (plugins.entries.clawmem.hooks.timeouts) is lower than the outer value.

export const DEFAULT_HOOK_BUDGET_MS = 6000;
export const MIN_HOOK_BUDGET_MS = 1000;
/**
 * The hook's own ceiling. From v0.38 the context-surfacing hook refuses to run
 * when CLAWMEM_HOOK_BUDGET_MS is above MAX_LEG_BUDGET_MS (src/vector-protocol.ts,
 * 25 s), so the plugin clamps to the same number and never hands it a value it
 * refuses. Mirrored rather than imported to keep this directory self-contained
 * (link mode loads it as source); tests/unit/openclaw-hook-budget.test.ts pins
 * the two equal. OpenClaw's own hook-timeout policy tops out at
 * OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS, and the outer host timeout (budget + both
 * margins) must stay below it so the manifest's advice to set a matching policy
 * is always satisfiable.
 */
export const MAX_HOOK_BUDGET_MS = 25_000;
export const HOOK_KILL_MARGIN_MS = 2000;
export const HOST_TIMEOUT_MARGIN_MS = 2000;
export const OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS = 600_000;
if (MAX_HOOK_BUDGET_MS + HOOK_KILL_MARGIN_MS + HOST_TIMEOUT_MARGIN_MS > OPENCLAW_HOOK_TIMEOUT_POLICY_MAX_MS) {
  throw new Error("hook budget contract: host timeout at MAX budget exceeds OpenClaw's policy maximum");
}

/** Coerce a configured budget: non-numeric or non-positive → default; clamp to [MIN, MAX]. */
export function resolveHookBudgetMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOOK_BUDGET_MS;
  return Math.min(MAX_HOOK_BUDGET_MS, Math.max(MIN_HOOK_BUDGET_MS, Math.floor(n)));
}

/** When execFile kills the context-surfacing child. */
export function contextSurfacingKillTimeoutMs(cfg: Pick<ClawMemConfig, "hookBudgetMs">): number {
  return resolveHookBudgetMs(cfg.hookBudgetMs) + HOOK_KILL_MARGIN_MS;
}

/** The timeoutMs handed to OpenClaw for the before_prompt_build registration. */
export function hostHookTimeoutMs(cfg: Pick<ClawMemConfig, "hookBudgetMs">): number {
  return contextSurfacingKillTimeoutMs(cfg) + HOST_TIMEOUT_MARGIN_MS;
}

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
  if (configured) {
    // An explicit path is authoritative: a configured binary that has gone
    // missing is an error to surface, never a cue to run some other clawmem
    // found on a search path (the bundled plugin's source-relative fallback
    // does not even point at a checkout). A directory at that path is not a
    // binary either: execFile would fail on it at the first hook.
    if (!existsSync(configured)) throw new Error(`clawmem: configured clawmemBin does not exist: ${configured}`);
    if (!isRegularFile(configured)) throw new Error(`clawmem: configured clawmemBin is not a regular file: ${configured}`);
    if (!isExecutable(configured)) throw new Error(`clawmem: configured clawmemBin is not executable: ${configured}`);
    return configured;
  }

  for (const p of SEARCH_PATHS) {
    if (isRegularFile(p) && isExecutable(p)) return p;
  }

  // Fallback: assume it's on PATH
  return "clawmem";
}

/** access(2) X_OK for this process: false for a file without an execute bit this user can use. */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Follows symlinks; false for a missing path or anything but a regular file. */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
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
            ? `timeout after ${hookTimeout}ms (hook=${hookName}, profile=${cfg.profile}, hookBudgetMs=${resolveHookBudgetMs(cfg.hookBudgetMs)})`
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
