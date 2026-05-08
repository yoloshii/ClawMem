/**
 * Unit tests for src/openclaw-paths.ts (§28.1, issue #11).
 *
 * Covers the CLI-absent fallback resolver semantics + printSetupOpenClawHelp
 * output. These helpers are pure (take injected env + homedir) so we don't
 * need to touch process.env at all for U1-U7.
 *
 * U8 captures stdout from printSetupOpenClawHelp — uses console.log
 * monkey-patching scoped to the test, restored in afterEach.
 *
 * Source-text regression gates for the rewritten cmdSetupOpenClaw live in
 * tests/integration/setup-openclaw.integration.test.ts (which exercises the
 * actual CLI surface via subprocess + stub binary).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolve as pathResolve } from "node:path";

import {
  expandHome,
  printSetupOpenClawHelp,
  resolveExtensionsDirNoOpenClaw,
  resolveHomeForOpenClaw,
  trim,
} from "../../src/openclaw-paths.ts";

const STATIC_HOME = "/home/test-user";
const staticHomedir = () => STATIC_HOME;

describe("§28.1 trim — home-resolution env value normalization", () => {
  test("returns undefined for empty / whitespace / 'undefined' / 'null'", () => {
    expect(trim(undefined)).toBeUndefined();
    expect(trim("")).toBeUndefined();
    expect(trim("   ")).toBeUndefined();
    expect(trim("\t")).toBeUndefined();
    // "undefined" / "null" literal strings are filtered (matches OpenClaw's
    // home-dir.ts normalize for OPENCLAW_HOME / HOME / USERPROFILE)
    expect(trim("undefined")).toBeUndefined();
    expect(trim("null")).toBeUndefined();
  });
  test("returns trimmed value for real strings", () => {
    expect(trim("  /tmp/foo  ")).toBe("/tmp/foo");
    expect(trim("/tmp/foo")).toBe("/tmp/foo");
  });
});

describe("§28.1 U1 — default extensions dir with empty env", () => {
  test("returns <home>/.openclaw/extensions when no env vars set", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: {},
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, ".openclaw", "extensions"));
  });
});

describe("§28.1 U2 — OPENCLAW_STATE_DIR override", () => {
  test("returns <STATE_DIR>/extensions when set", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "/custom/state" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("/custom/state", "extensions"));
  });
});

describe("§28.1 U3 — OPENCLAW_CONFIG_PATH precedence", () => {
  test("config root = dirname(config file); extensions hangs off root", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_CONFIG_PATH: "/custom/configs/openclaw.json" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("/custom/configs", "extensions"));
  });
});

describe("§28.1 U4 — OPENCLAW_STATE_DIR wins over OPENCLAW_CONFIG_PATH", () => {
  test("STATE_DIR takes precedence when both set", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: {
        OPENCLAW_STATE_DIR: "/winner",
        OPENCLAW_CONFIG_PATH: "/other/openclaw.json",
      },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("/winner", "extensions"));
  });
});

describe("§28.1 U5 — tilde expansion in env values", () => {
  test("OPENCLAW_STATE_DIR=~/foo expands against home", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "~/foo" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, "foo", "extensions"));
  });
  test("bare ~ in OPENCLAW_STATE_DIR expands to home", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "~" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, "extensions"));
  });
  test("OPENCLAW_CONFIG_PATH tilde expands before dirname", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_CONFIG_PATH: "~/profiles/dev/openclaw.json" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, "profiles/dev", "extensions"));
  });
  test("expandHome leaves non-home tilde forms untouched (no ~user expansion)", () => {
    expect(
      expandHome("~bob/foo", { env: {}, homedir: staticHomedir }),
    ).toBe("~bob/foo");
  });
});

describe("§28.1 U6 — empty / whitespace state-dir/config-path falls through; literal 'undefined'/'null' do NOT", () => {
  test("OPENCLAW_STATE_DIR='' falls through to default", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, ".openclaw", "extensions"));
  });
  test("OPENCLAW_STATE_DIR='   ' falls through", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "   " },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve(STATIC_HOME, ".openclaw", "extensions"));
  });
  test("OPENCLAW_STATE_DIR='undefined' is treated as a LITERAL directory name (matches OpenClaw resolveConfigDir)", () => {
    // OpenClaw's resolveConfigDir applies only `.trim()` to OPENCLAW_STATE_DIR
    // — it does NOT filter "undefined"/"null" literal strings. ClawMem's
    // fallback resolver mirrors that exactly; diverging here would mean
    // Path 1 (delegation) and Path 3 (fallback) install into different
    // directories for the same env, which is the bug class §28.1 set out
    // to fix.
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_STATE_DIR: "undefined" },
      homedir: staticHomedir,
    });
    expect(result).toBe(pathResolve("undefined", "extensions"));
  });
  test("OPENCLAW_CONFIG_PATH='null' is treated as a LITERAL config file path", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_CONFIG_PATH: "null" },
      homedir: staticHomedir,
    });
    // dirname("null") on POSIX is "."
    expect(result).toBe(pathResolve(".", "extensions"));
  });
});

describe("§28.1 U7 — home resolution priority + cwd fallback", () => {
  test("OPENCLAW_HOME overrides HOME for default path", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { OPENCLAW_HOME: "/openclaw-home", HOME: "/regular-home" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(pathResolve("/openclaw-home", ".openclaw", "extensions"));
  });
  test("HOME wins over USERPROFILE when OPENCLAW_HOME is unset", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { HOME: "/posix-home", USERPROFILE: "C:\\Users\\test" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(pathResolve("/posix-home", ".openclaw", "extensions"));
  });
  test("USERPROFILE wins over os.homedir() when HOME is unset", () => {
    const result = resolveExtensionsDirNoOpenClaw({
      env: { USERPROFILE: "C:\\Users\\test" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(
      pathResolve("C:\\Users\\test", ".openclaw", "extensions"),
    );
  });
  test("os.homedir() is consulted when no env vars set", () => {
    const result = resolveHomeForOpenClaw({
      env: {},
      homedir: () => "/from-os-homedir",
    });
    expect(result).toBe(pathResolve("/from-os-homedir"));
  });
  test("os.homedir() throwing falls through to cwd", () => {
    const result = resolveHomeForOpenClaw({
      env: {},
      homedir: () => {
        throw new Error("homedir unavailable");
      },
    });
    // cwd-resolved path is process.cwd() — assert it's an absolute path
    // and not the empty string. We don't assert exact value because the
    // test runner controls cwd.
    expect(result).toBe(pathResolve(process.cwd()));
  });
  test("OPENCLAW_HOME with leading tilde expands against next priority", () => {
    const result = resolveHomeForOpenClaw({
      env: { OPENCLAW_HOME: "~/profiles", HOME: "/regular-home" },
      homedir: () => "/os-homedir",
    });
    expect(result).toBe(pathResolve("/regular-home", "profiles"));
  });
});

describe("§28.1 U8 — printSetupOpenClawHelp output content", () => {
  let capturedLogs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
    capturedLogs = [];
  });

  test("prints usage line, all flags, and env vars consulted", () => {
    capturedLogs = [];
    console.log = (msg?: any) => {
      capturedLogs.push(typeof msg === "string" ? msg : String(msg));
    };
    printSetupOpenClawHelp();
    const output = capturedLogs.join("\n");

    // Usage line
    expect(output).toContain(
      "clawmem setup openclaw [--link] [--remove] [--help|-h]",
    );

    // All four flags documented
    expect(output).toContain("--link");
    expect(output).toContain("--remove");
    expect(output).toContain("--help, -h");

    // All env vars consulted (matches the four BACKLOG §28.1 docs)
    expect(output).toContain("OPENCLAW_STATE_DIR");
    expect(output).toContain("OPENCLAW_CONFIG_PATH");
    expect(output).toContain("OPENCLAW_HOME");
    expect(output).toContain("HOME / USERPROFILE");

    // Delegation behavior is mentioned (so users understand v0.10.4 change)
    expect(output).toContain("openclaw CLI is on PATH");
    expect(output).toContain("openclaw plugins install");

    // At least one example shows OPENCLAW_STATE_DIR usage
    expect(output).toContain("OPENCLAW_STATE_DIR=~/.openclaw-dev");
  });
});
