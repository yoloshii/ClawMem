/**
 * Loaded before every test file (bunfig.toml `[test] preload`): the suite never reads the user's ClawMem configuration
 * or opens the user's vaults (v0.41.1). Without it, `loadVaultConfig()` fell back to `~/.config/clawmem/config.yaml`,
 * and a test that fans out to the configured vaults (a `feedbackLoop` call without explicit vaults) opened a real named
 * vault writable and migrated it. The launcher's variables are cleared too: `bin/clawmem` may export the real paths.
 * A test that needs a config directory, named vaults or an INDEX_PATH sets its own, as before.
 *
 * Every test file runs in this one process, so a test that deletes CLAWMEM_CONFIG_DIR instead of restoring it would
 * expose the real configuration to every test after it: the hooks below point it back here, before and after every
 * test (a test's own value is left alone), and drop a configuration cached meanwhile.
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearConfigCache } from "../src/config.ts";

const configDir = mkdtempSync(join(tmpdir(), "clawmem-test-config-"));
process.env.CLAWMEM_CONFIG_DIR = configDir;
delete process.env.CLAWMEM_VAULTS;
delete process.env.INDEX_PATH;
// The REST server's token and allowlists (BACKLOG 62.4): a test that serves passes its own, never the shell's.
delete process.env.CLAWMEM_API_TOKEN;
delete process.env.CLAWMEM_ALLOWED_HOSTS;
delete process.env.CLAWMEM_ALLOWED_ORIGINS;
(globalThis as { __clawmemTestConfigDir?: string }).__clawmemTestConfigDir = configDir;

const keepIsolated = () => {
  if (process.env.CLAWMEM_CONFIG_DIR) return;
  process.env.CLAWMEM_CONFIG_DIR = configDir;
  clearConfigCache();
};
beforeEach(keepIsolated);
afterEach(keepIsolated);

process.on("exit", () => {
  try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
