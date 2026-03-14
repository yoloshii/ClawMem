/**
 * ClawMem Configuration — Vault routing, lifecycle policy, performance profiles.
 *
 * Multi-vault support: ClawMem can manage multiple independent SQLite vaults,
 * each with its own documents, embeddings, and graphs. The default (unnamed)
 * vault lives at ~/.cache/clawmem/index.sqlite. Named vaults are configured
 * via config.yaml or environment variables.
 *
 * Single vault is the default. Multi-vault is opt-in.
 *
 * Configuration sources (highest priority first):
 *   1. Environment variables (CLAWMEM_VAULTS JSON map)
 *   2. Config file (~/.config/clawmem/config.yaml, vaults section)
 *
 * Example config.yaml with multiple vaults:
 *   vaults:
 *     work: ~/.cache/clawmem/work.sqlite
 *     personal: ~/.cache/clawmem/personal.sqlite
 *
 * When no vaults are configured, ClawMem operates as a single-vault system.
 * All tools work without the vault parameter — it's always optional.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultConfig {
  /** Vault name → absolute path to SQLite file */
  [name: string]: string;
}

export interface LifecyclePolicy {
  archive_after_days: number;
  type_overrides: Record<string, number | null>;
  purge_after_days: number | null;
  exempt_collections: string[];
  dry_run: boolean;
}

export interface ClawMemConfig {
  /** Named vault paths (empty = single-vault mode) */
  vaults: VaultConfig;
  /** Lifecycle management policy */
  lifecycle?: LifecyclePolicy;
}

// ---------------------------------------------------------------------------
// Performance Profiles
// ---------------------------------------------------------------------------

export type PerformanceProfile = "speed" | "balanced" | "deep";

export interface ProfileConfig {
  tokenBudget: number;
  maxResults: number;
  useVector: boolean;
  vectorTimeout: number;
  minScore: number;
}

export const PROFILES: Record<PerformanceProfile, ProfileConfig> = {
  speed:    { tokenBudget: 400,  maxResults: 5,  useVector: false, vectorTimeout: 0,    minScore: 0.55 },
  balanced: { tokenBudget: 800,  maxResults: 10, useVector: true,  vectorTimeout: 900,  minScore: 0.45 },
  deep:     { tokenBudget: 1200, maxResults: 15, useVector: true,  vectorTimeout: 2000, minScore: 0.35 },
};

export function getActiveProfile(): ProfileConfig {
  const profileName = (process.env.CLAWMEM_PROFILE || "balanced") as PerformanceProfile;
  return PROFILES[profileName] || PROFILES.balanced;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

let _cachedConfig: ClawMemConfig | null = null;

/**
 * Load vault configuration from env vars and config file.
 * Priority: env vars override config file values.
 */
export function loadVaultConfig(): ClawMemConfig {
  if (_cachedConfig) return _cachedConfig;

  const vaults: VaultConfig = {};

  // 1. Load from config.yaml (vaults section)
  const configDir = process.env.CLAWMEM_CONFIG_DIR || join(homedir(), ".config", "clawmem");
  const configPath = join(configDir, "config.yaml");

  let parsedYaml: any = null;
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      parsedYaml = YAML.parse(content);
      if (parsedYaml?.vaults && typeof parsedYaml.vaults === "object") {
        for (const [name, path] of Object.entries(parsedYaml.vaults)) {
          if (typeof path === "string") {
            vaults[name] = resolve(path);
          }
        }
      }
    } catch {
      // Config parse failure — continue with env vars only
    }
  }

  // 2. Override with env vars (higher priority)
  if (process.env.CLAWMEM_VAULTS) {
    try {
      const envVaults = JSON.parse(process.env.CLAWMEM_VAULTS);
      if (typeof envVaults === "object") {
        for (const [name, path] of Object.entries(envVaults)) {
          if (typeof path === "string") {
            vaults[name] = resolve(path as string);
          }
        }
      }
    } catch {
      // Invalid JSON — ignore
    }
  }

  // 3. Lifecycle policy (optional)
  let lifecycle: LifecyclePolicy | undefined;
  if (parsedYaml?.lifecycle && typeof parsedYaml.lifecycle === "object") {
    const lc = parsedYaml.lifecycle;
    lifecycle = {
      archive_after_days: typeof lc.archive_after_days === "number" ? lc.archive_after_days : 90,
      type_overrides: typeof lc.type_overrides === "object" && lc.type_overrides !== null ? lc.type_overrides : {},
      purge_after_days: typeof lc.purge_after_days === "number" ? lc.purge_after_days : null,
      exempt_collections: Array.isArray(lc.exempt_collections) ? lc.exempt_collections : [],
      dry_run: lc.dry_run !== false,
    };
  }

  _cachedConfig = { vaults, lifecycle };
  return _cachedConfig;
}

/**
 * Get the SQLite path for a named vault.
 * Returns undefined if vault is not configured.
 */
export function getVaultPath(vaultName: string): string | undefined {
  const config = loadVaultConfig();
  return config.vaults[vaultName];
}

/**
 * List all configured vault names.
 */
export function listVaults(): string[] {
  const config = loadVaultConfig();
  return Object.keys(config.vaults);
}

/**
 * Clear cached config (for testing or after env var changes).
 */
export function clearConfigCache(): void {
  _cachedConfig = null;
}
