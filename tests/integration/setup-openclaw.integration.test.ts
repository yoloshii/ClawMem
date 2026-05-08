/**
 * Integration tests for `clawmem setup openclaw` (§28.1, issue #11).
 *
 * Spawns the real ClawMem CLI as a subprocess so we exercise the actual
 * shell.spawn boundary, env inheritance, and exit codes. A per-test temp
 * directory hosts a stub `openclaw` shell script on PATH that records its
 * argv + env + cwd as JSONL for later assertions.
 *
 * Strategy:
 *   - Stub binary supports per-command behavior:
 *       `--version`         → always exits 0
 *       `plugins install`   → exits per STUB_INSTALL_EXIT_CODE (default 0)
 *       `plugins uninstall` → exits per STUB_UNINSTALL_EXIT_CODE (default 0)
 *       `config get`        → prints "" and exits 0 (covers §14.3 migration)
 *       `config set/unset`  → exits 0
 *   - Each invocation appends one JSONL line to $STUB_LOG. Tests assert
 *     "contains invocation" rather than "argv equals X" because setup may
 *     spawn the stub multiple times (--version probe + config get + install).
 *   - Tests run with HOME pointed at a temp directory so direct-copy
 *     fallback writes there, not the real $HOME.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";

const REPO_ROOT = pathResolve(import.meta.dir, "..", "..");
const CLAWMEM_ENTRY = pathResolve(REPO_ROOT, "src", "clawmem.ts");

// =============================================================================
// Stub openclaw binary
// =============================================================================

/**
 * Per-command stub. Records every invocation as a JSONL line containing
 * argv + selected env vars. `--version` always succeeds. Behavior for
 * `plugins install` and `plugins uninstall` is controlled by env vars so
 * tests can assert success / failure paths independently.
 */
const STUB_SCRIPT = `#!/usr/bin/env bash
set -e
LOG="\${STUB_LOG:-/tmp/stub-openclaw.jsonl}"
ARGS_JSON="["
for a in "$@"; do
  esc=$(printf '%s' "$a" | sed 's/"/\\\\"/g')
  ARGS_JSON+="\\"$esc\\","
done
ARGS_JSON="\${ARGS_JSON%,}]"

# Capture the env vars relevant to §28.1
ENV_JSON="{"
for v in OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_HOME HOME USERPROFILE; do
  val=\${!v:-}
  esc=$(printf '%s' "$val" | sed 's/"/\\\\"/g')
  ENV_JSON+="\\"$v\\":\\"$esc\\","
done
ENV_JSON="\${ENV_JSON%,}}"

printf '{"argv":%s,"env":%s}\\n' "$ARGS_JSON" "$ENV_JSON" >> "$LOG"

# Per-command behavior
if [ "$1" = "--version" ]; then
  echo "openclaw 2026.4.30 (stub)"
  exit 0
fi

if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  exit "\${STUB_INSTALL_EXIT_CODE:-0}"
fi

if [ "$1" = "plugins" ] && [ "$2" = "uninstall" ]; then
  exit "\${STUB_UNINSTALL_EXIT_CODE:-0}"
fi

if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  # Empty config — keeps §14.3 migration block from triggering
  exit 0
fi

if [ "$1" = "config" ] && { [ "$2" = "set" ] || [ "$2" = "unset" ]; }; then
  exit 0
fi

# Unknown command — exit 0 to avoid breaking unrelated probes
exit 0
`;

interface StubInvocation {
  argv: string[];
  env: Record<string, string>;
}

interface TestEnv {
  tmpDir: string;
  stubDir: string;
  stubLog: string;
  pluginPath: string;
  cleanup: () => void;
}

function setupTestEnv(): TestEnv {
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), "clawmem-s28-"));
  const stubDir = pathJoin(tmpDir, "bin");
  mkdirSync(stubDir, { recursive: true });
  const stubBin = pathJoin(stubDir, "openclaw");
  writeFileSync(stubBin, STUB_SCRIPT, { mode: 0o755 });
  chmodSync(stubBin, 0o755);
  const stubLog = pathJoin(tmpDir, "stub-invocations.jsonl");
  writeFileSync(stubLog, "");
  // Direct-copy fallback writes into <home>/.openclaw or wherever the env
  // vars point; we'll reuse tmpDir for that too.
  const pluginPath = pathJoin(tmpDir, ".openclaw", "extensions", "clawmem");
  return {
    tmpDir,
    stubDir,
    stubLog,
    pluginPath,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function readStubInvocations(stubLog: string): StubInvocation[] {
  if (!existsSync(stubLog)) return [];
  const content = readFileSync(stubLog, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as StubInvocation);
}

function containsInvocation(
  invocations: StubInvocation[],
  matcher: (argv: string[]) => boolean,
): StubInvocation | undefined {
  return invocations.find((inv) => matcher(inv.argv));
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const BUN_EXECUTABLE = process.execPath;

async function runClawmemSetupOpenClaw(
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  // Use absolute path to bun; the env we pass to Bun.spawn replaces the
  // entire environment, so a relative `bun` lookup would fail PATH
  // resolution. Subprocess PATH is whatever the test sets, which is the
  // contract under test (only `openclaw` lookup should depend on PATH).
  const proc = Bun.spawn(
    [BUN_EXECUTABLE, CLAWMEM_ENTRY, "setup", "openclaw", ...args],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// =============================================================================
// Tests
// =============================================================================

describe("§28.1 setup openclaw — integration", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  test("I1 — copy mode delegates with --force", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      // No OPENCLAW_STATE_DIR — we want to verify --force is passed,
      // independent of env-var pass-through.
    });
    expect(result.exitCode).toBe(0);

    const invocations = readStubInvocations(env.stubLog);
    const installInvocation = containsInvocation(
      invocations,
      (argv) =>
        argv[0] === "plugins" &&
        argv[1] === "install" &&
        argv.includes("--force"),
    );
    expect(installInvocation).toBeDefined();
    // Must NOT include -l in copy mode
    expect(installInvocation!.argv).not.toContain("-l");
  });

  test("I2 — link mode delegates with -l, no --force", async () => {
    const result = await runClawmemSetupOpenClaw(["--link"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(result.exitCode).toBe(0);

    const invocations = readStubInvocations(env.stubLog);
    const installInvocation = containsInvocation(
      invocations,
      (argv) =>
        argv[0] === "plugins" &&
        argv[1] === "install" &&
        argv.includes("-l"),
    );
    expect(installInvocation).toBeDefined();
    // Must NOT include --force in link mode (OpenClaw rejects the combination)
    expect(installInvocation!.argv).not.toContain("--force");
  });

  test("I3 — install failure aborts (no silent fallback to direct copy)", async () => {
    const result = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_INSTALL_EXIT_CODE: "1",
    });
    expect(result.exitCode).not.toBe(0);

    // No direct-copy artifact should have been written (fallback must NOT run
    // when the CLI is present-but-failing).
    expect(existsSync(env.pluginPath)).toBe(false);

    // Error message must specifically reference the failure mode (Turn 3 F4
    // tightening — "openclaw plugins install" alone was too loose).
    const combined = result.stderr + result.stdout;
    expect(combined).toContain("aborting setup");
    expect(combined).toContain("--force failed");
  });

  test("I4 — --remove with managed install: CLI uninstall succeeds + constrained stale cleanup", async () => {
    // Pre-populate the legacy direct-copy directory at the resolved path so
    // we can verify the constrained stale cleanup runs even after a
    // successful CLI uninstall (managed-link + unmanaged-copy side-by-side).
    mkdirSync(pathJoin(env.tmpDir, ".openclaw", "extensions"), {
      recursive: true,
    });
    mkdirSync(env.pluginPath, { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "stale.txt"), "legacy install");

    const result = await runClawmemSetupOpenClaw(["--remove"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(result.exitCode).toBe(0);

    // CLI uninstall was invoked
    const invocations = readStubInvocations(env.stubLog);
    const uninstallInvocation = containsInvocation(
      invocations,
      (argv) =>
        argv[0] === "plugins" &&
        argv[1] === "uninstall" &&
        argv[2] === "clawmem",
    );
    expect(uninstallInvocation).toBeDefined();

    // AND the stale legacy directory was removed
    expect(existsSync(env.pluginPath)).toBe(false);
  });

  test("I5 — --remove with legacy-only install: CLI uninstall fails → manual fallback + warning", async () => {
    // Pre-populate the unmanaged install directory.
    mkdirSync(pathJoin(env.tmpDir, ".openclaw", "extensions"), {
      recursive: true,
    });
    mkdirSync(env.pluginPath, { recursive: true });
    writeFileSync(pathJoin(env.pluginPath, "legacy.txt"), "unmanaged install");

    const result = await runClawmemSetupOpenClaw(["--remove"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
      STUB_UNINSTALL_EXIT_CODE: "1",
    });
    expect(result.exitCode).toBe(0);

    // Warning text must surface (R1 — never silently mask managed-uninstall failure)
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("openclaw plugins uninstall clawmem failed");
    expect(combined).toContain("config and install records may still");

    // Manual cleanup ran
    expect(existsSync(env.pluginPath)).toBe(false);
  });

  test("I7 — dual next-steps messaging: delegated path omits 'plugins enable', fallback path includes it", async () => {
    // Path 1 (delegated): openclaw plugins install --force auto-enables, so
    // ClawMem must NOT print "openclaw plugins enable clawmem" in the next
    // steps. Otherwise users will run a redundant command and possibly hit
    // a slot-validation error.
    const delegatedResult = await runClawmemSetupOpenClaw([], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(delegatedResult.exitCode).toBe(0);
    expect(delegatedResult.stdout).not.toContain(
      "openclaw plugins enable clawmem",
    );

    // Path 3 (CLI absent, direct copy): user must enable manually, so the
    // step text MUST appear.
    const fallbackEnv = setupTestEnv();
    try {
      const sandboxedPath = buildBunOnlyPath(fallbackEnv.tmpDir);
      const fallbackResult = await runClawmemSetupOpenClaw([], {
        PATH: sandboxedPath,
        HOME: fallbackEnv.tmpDir,
      });
      // If openclaw is somehow on the system PATH and breaks the test,
      // skip rather than produce a misleading failure (mirrors I6).
      if (
        fallbackResult.stdout.includes("openclaw plugins install --force") &&
        !fallbackResult.stdout.includes("openclaw CLI not on PATH")
      ) {
        console.warn(
          "I7 fallback half skipped: real `openclaw` binary on PATH",
        );
        return;
      }
      expect(fallbackResult.exitCode).toBe(0);
      expect(fallbackResult.stdout).toContain("openclaw plugins enable clawmem");
    } finally {
      fallbackEnv.cleanup();
    }
  });

  test("I8 — --help short-circuits before any subprocess spawn", async () => {
    const result = await runClawmemSetupOpenClaw(["--help"], {
      PATH: `${env.stubDir}:${process.env.PATH ?? ""}`,
      HOME: env.tmpDir,
      STUB_LOG: env.stubLog,
    });
    expect(result.exitCode).toBe(0);

    // Help text was printed
    expect(result.stdout).toContain("clawmem setup openclaw");
    expect(result.stdout).toContain("OPENCLAW_STATE_DIR");

    // Critical: NO stub invocation should have happened. If the short-circuit
    // failed, we'd see at least the `openclaw --version` probe in the JSONL.
    const invocations = readStubInvocations(env.stubLog);
    expect(invocations).toHaveLength(0);
  });

  test("I6 — CLI absent: direct-copy honors OPENCLAW_STATE_DIR", async () => {
    // Use a PATH that contains bun (so the subprocess can start) but NOT
    // openclaw. The system PATH almost always omits a real openclaw
    // because it's not yet a package on this dev box; we still defensively
    // sandbox by routing through a curated bun-only bin dir.
    const customStateDir = pathJoin(env.tmpDir, "custom-profile");
    const expectedInstallPath = pathJoin(
      customStateDir,
      "extensions",
      "clawmem",
    );

    const sandboxedPath = buildBunOnlyPath(env.tmpDir);
    const result = await runClawmemSetupOpenClaw([], {
      PATH: sandboxedPath,
      HOME: env.tmpDir,
      OPENCLAW_STATE_DIR: customStateDir,
    });

    // If openclaw IS present on the system PATH, this test cannot run
    // meaningfully. Skip in that case rather than producing a confusing
    // fail. (No assertion for the absent-skip; we just early-return.)
    if (result.stdout.includes("openclaw plugins install") &&
        !result.stdout.includes("openclaw CLI not on PATH")) {
      // openclaw was somehow on PATH — abort the test with a hint.
      console.warn(
        "I6 skipped: real `openclaw` binary appears to be on PATH. " +
        "Test environment cannot exercise the CLI-absent fallback.",
      );
      return;
    }

    expect(result.exitCode).toBe(0);

    // The direct-copy install should have written the plugin into the
    // custom state dir, not the default ~/.openclaw.
    expect(existsSync(expectedInstallPath)).toBe(true);
    expect(existsSync(pathJoin(env.tmpDir, ".openclaw"))).toBe(false);

    // Output should mention CLI absence
    expect(result.stdout).toContain("openclaw CLI not on PATH");
  });
});

/**
 * Build a PATH that contains the bun binary's directory (so the spawned
 * subprocess can resolve `bun`) but isolates the test from any real
 * openclaw binary on the system. We construct a per-test sandbox bin
 * containing only a symlink to bun.
 */
function buildBunOnlyPath(tmpDir: string): string {
  const sandbox = pathJoin(tmpDir, "bun-only-bin");
  mkdirSync(sandbox, { recursive: true });
  const bunSrc = process.execPath;
  const bunLink = pathJoin(sandbox, "bun");
  if (!existsSync(bunLink)) {
    try {
      symlinkSync(bunSrc, bunLink);
    } catch {
      // Fall back to writing a wrapper script if symlinks aren't supported
      writeFileSync(bunLink, `#!/usr/bin/env bash\nexec "${bunSrc}" "$@"\n`, {
        mode: 0o755,
      });
      chmodSync(bunLink, 0o755);
    }
  }
  return sandbox;
}
