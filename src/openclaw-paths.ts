/**
 * OpenClaw path-resolution helpers + setup help text for `clawmem setup openclaw`.
 *
 * §28.1 (issue #11): historically `cmdSetupOpenClaw` hardcoded
 * `~/.openclaw/extensions/clawmem` and ignored `OPENCLAW_STATE_DIR`. v0.10.4
 * delegates to `openclaw plugins install` when the CLI is on PATH (which
 * inherits OpenClaw's own `resolveConfigDir(env)` semantics) and falls back
 * to a direct-copy install otherwise. The fallback path needs to mirror
 * OpenClaw's `resolveConfigDir` precisely for env-var-honoring custom
 * profile installs to land in the expected directory.
 *
 * Mirrors: openclaw/src/utils.ts:119 (resolveConfigDir) and
 *          openclaw/src/infra/home-dir.ts (home resolution).
 *
 * Helpers take injected `env` + `homedir` so they are testable in isolation
 * without needing to touch process.env or the real os.homedir.
 */

import { homedir as defaultHomedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export type EnvLike = Record<string, string | undefined>;
export type HomedirFn = () => string;

export interface PathResolverOpts {
  env?: EnvLike;
  homedir?: HomedirFn;
}

// =============================================================================
// Trim / normalize
// =============================================================================

/**
 * Plain trim — used for OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH so the
 * fallback resolver mirrors OpenClaw's `resolveConfigDir` (utils.ts:119)
 * EXACTLY. OpenClaw applies only `.trim()` to those env vars, so a value
 * of `"undefined"` or `"null"` is treated as a literal directory name (the
 * user shot themselves in the foot, but ClawMem must agree with OpenClaw
 * about WHERE the foot is shot — diverging here would mean Path 1 and
 * Path 3 install into different locations for the same env, which is
 * exactly the bug class §28.1 set out to fix).
 */
export function plainTrim(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  return t || undefined;
}

/**
 * Mirrors OpenClaw's `home-dir.ts:normalize`. Treats empty strings,
 * whitespace-only strings, and the literal strings "undefined" / "null" as
 * unset. Used ONLY for home-resolution env vars (OPENCLAW_HOME, HOME,
 * USERPROFILE) to match OpenClaw's home-dir helper; do NOT use this for
 * OPENCLAW_STATE_DIR or OPENCLAW_CONFIG_PATH (see plainTrim).
 */
export function trim(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  if (!t || t === "undefined" || t === "null") return undefined;
  return t;
}

// =============================================================================
// Home resolution
// =============================================================================

/**
 * Mirrors `openclaw/src/infra/home-dir.ts` resolution priority:
 *   OPENCLAW_HOME → HOME → USERPROFILE → os.homedir() → path.resolve(cwd())
 *
 * `OPENCLAW_HOME` itself can begin with a tilde, in which case we expand it
 * against the *next* fallback (HOME / USERPROFILE / os.homedir).
 */
export function resolveHomeForOpenClaw(opts: PathResolverOpts = {}): string {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? defaultHomedir;

  const explicitHome = trim(env.OPENCLAW_HOME);
  if (explicitHome) {
    if (
      explicitHome === "~" ||
      explicitHome.startsWith("~/") ||
      explicitHome.startsWith("~\\")
    ) {
      const fallback = resolveOsHome(env, homedir);
      if (fallback) {
        return pathResolve(explicitHome.replace(/^~(?=$|[\\/])/, fallback));
      }
      // No fallback available; fall through to other priorities below.
    } else {
      return pathResolve(explicitHome);
    }
  }

  const osHome = resolveOsHome(env, homedir);
  if (osHome) return pathResolve(osHome);

  // Last-resort: cwd. Matches `resolveRequiredHomeDir` in OpenClaw.
  return pathResolve(process.cwd());
}

function resolveOsHome(env: EnvLike, homedir: HomedirFn): string | undefined {
  const homeEnv = trim(env.HOME);
  if (homeEnv) return homeEnv;
  const userProfile = trim(env.USERPROFILE);
  if (userProfile) return userProfile;
  try {
    const safe = trim(homedir());
    if (safe) return safe;
  } catch {
    // os.homedir() can throw on misconfigured systems
  }
  return undefined;
}

// =============================================================================
// Tilde expansion
// =============================================================================

/**
 * Expands a leading `~`, `~/`, or `~\` against the OpenClaw home resolver.
 * Does NOT support `~user/...` (other-user expansion) — neither does
 * OpenClaw's `expandHomePrefix`.
 */
export function expandHome(input: string, opts: PathResolverOpts = {}): string {
  if (!input.startsWith("~")) return input;
  if (
    input !== "~" &&
    !input.startsWith("~/") &&
    !input.startsWith("~\\")
  ) {
    // Looks like `~user` or some other non-home tilde form; leave untouched.
    return input;
  }
  const home = resolveHomeForOpenClaw(opts);
  return input.replace(/^~(?=$|[\\/])/, home);
}

// =============================================================================
// Extensions directory resolver (CLI-absent fallback)
// =============================================================================

/**
 * Resolves the `extensions/` directory we should write into when `openclaw`
 * CLI is not on PATH. Mirrors `openclaw/src/utils.ts:119 resolveConfigDir`:
 *   1. OPENCLAW_STATE_DIR overrides everything
 *   2. OPENCLAW_CONFIG_PATH → config root = dirname(file)
 *   3. <home>/.openclaw
 *
 * The result is `pathResolve`d so callers can compare against equally
 * normalized paths.
 */
export function resolveExtensionsDirNoOpenClaw(
  opts: PathResolverOpts = {},
): string {
  const env = opts.env ?? process.env;

  // OPENCLAW_STATE_DIR + OPENCLAW_CONFIG_PATH use plainTrim (no
  // "undefined"/"null" filtering) to match OpenClaw's resolveConfigDir
  // exactly. See plainTrim docstring.
  const stateDir = plainTrim(env.OPENCLAW_STATE_DIR);
  if (stateDir) {
    return pathResolve(expandHome(stateDir, opts), "extensions");
  }

  const configPath = plainTrim(env.OPENCLAW_CONFIG_PATH);
  if (configPath) {
    return pathResolve(dirname(expandHome(configPath, opts)), "extensions");
  }

  return pathResolve(resolveHomeForOpenClaw(opts), ".openclaw", "extensions");
}

// =============================================================================
// `clawmem setup openclaw --help` text
// =============================================================================

/**
 * Prints help for `clawmem setup openclaw`. Documents flags, env vars
 * consulted, and the CLI-delegation behavior introduced in v0.10.4 (§28.1).
 */
export function printSetupOpenClawHelp(): void {
  const lines = [
    "",
    "clawmem setup openclaw [--link] [--remove] [--help|-h]",
    "",
    "  Install ClawMem as an OpenClaw memory plugin.",
    "",
    "  When the openclaw CLI is on PATH, this command delegates to",
    "  `openclaw plugins install <pluginDir>`, which auto-enables the plugin,",
    "  writes install records, and applies slot selection. Otherwise it falls",
    "  back to a direct-copy install honoring OPENCLAW_STATE_DIR.",
    "",
    "Flags:",
    "  --link        Install in load-path mode instead of copying files.",
    "                When openclaw is on PATH, delegates to `openclaw plugins",
    "                install -l <path>` which records the source in",
    "                plugins.load.paths (NOT a filesystem symlink). When",
    "                openclaw is absent, falls back to a real symlink at",
    "                <extensions>/clawmem (note: OpenClaw v2026.4.11+",
    "                discovery silently skips symlinked plugins in the",
    "                fallback path, so prefer the delegated path).",
    "  --remove      Uninstall ClawMem from the OpenClaw extensions dir.",
    "                Tries `openclaw plugins uninstall clawmem --force` first;",
    "                falls back to manual cleanup at the resolved extensions",
    "                path for legacy unmanaged installs.",
    "  --help, -h    Print this message and exit.",
    "",
    "Environment variables (consulted by the CLI-absent fallback path and",
    "inherited by the openclaw subprocess in the delegation path):",
    "  OPENCLAW_STATE_DIR      Override the OpenClaw config root. Plugin",
    "                          installs into <OPENCLAW_STATE_DIR>/extensions/",
    "                          clawmem.",
    "  OPENCLAW_CONFIG_PATH    Override the OpenClaw config file path; root",
    "                          becomes dirname(OPENCLAW_CONFIG_PATH).",
    "  OPENCLAW_HOME           Override the home directory used to resolve",
    "                          the default ~/.openclaw root.",
    "  HOME / USERPROFILE      Standard home-dir env vars; consulted in that",
    "                          order when OPENCLAW_HOME is unset.",
    "",
    "Examples:",
    "  clawmem setup openclaw",
    "      Install with default profile.",
    "",
    "  OPENCLAW_STATE_DIR=~/.openclaw-dev clawmem setup openclaw",
    "      Install into the `dev` profile (~/.openclaw-dev/extensions/clawmem).",
    "",
    "  clawmem setup openclaw --link",
    "      Load-path mode (delegated install) or symlink (fallback) — local",
    "      development workflow where edits to the source dir take effect.",
    "",
    "  clawmem setup openclaw --remove",
    "      Uninstall ClawMem and reset OpenClaw memory slot.",
    "",
  ];
  for (const line of lines) {
    console.log(line);
  }
}
