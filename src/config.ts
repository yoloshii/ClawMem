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
// Helpers
// ---------------------------------------------------------------------------

/** Expand leading ~ to user home directory */
function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

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

export interface RetrievalConfig {
  /**
   * SUPERSEDED as of v0.22.0 and no longer consumed anywhere: the direct-pipeline
   * eval this knob was gated on measured tuned weights at 1/19 hit@1 (BACKLOG
   * Source 48), and the direct vector routes now rank by raw similarity instead
   * (VSEARCH-RAW-PRIMARY-DESIGN.md). Still parsed so existing configs don't break;
   * setting it warns once per process.
   */
  mcp_direct_tuned_weights: boolean;
  /**
   * Whether the context-surfacing hook also queries configured secondary vaults
   * and merges their results into the injected context (v0.35.0). Default FALSE:
   * out of the box, automatic surfacing reads only the general vault, so each
   * vault's content stays isolated unless deliberately queried (explicit
   * `vault`-parameter MCP calls are unaffected by this gate). Enable via
   * `retrieval.surface_secondary_vaults: true` or
   * CLAWMEM_SURFACE_SECONDARY_VAULTS=true (env wins).
   */
  surface_secondary_vaults: boolean;
  /**
   * Cross-agent context injection (cross-agent memory PR). When TRUE, the
   * context-surfacing hook additionally queries facts written by OTHER agents
   * for entities mentioned in the task prompt and injects them as a distinct,
   * marked `[cross-agent fact ...]` block. Default FALSE (opt-in). Enable via
   * `retrieval.cross_agent_inject: true` or CLAWMEM_CROSS_AGENT_INJECT=true (env wins).
   */
  cross_agent_inject: boolean;
  /**
   * Minimum confidence for facts surfaced by cross-agent injection. Default 0.7.
   * CLAWMEM_CROSS_AGENT_CONFIDENCE (env) overrides YAML.
   */
  cross_agent_confidence: number;
}

export interface ClawMemConfig {
  /** Named vault paths (empty = single-vault mode) */
  vaults: VaultConfig;
  /** Lifecycle management policy */
  lifecycle?: LifecyclePolicy;
  /** Retrieval behavior knobs */
  retrieval?: RetrievalConfig;
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
  /** Legacy absolute threshold — used by MCP tools and as fallback when thresholdMode="absolute" */
  minScore: number;
  /** Adaptive: keep results within this ratio of best score (e.g., 0.55 = top 55%) */
  minScoreRatio: number;
  /** Adaptive: never surface below this regardless of ratio */
  absoluteFloor: number;
  /** Adaptive: if best result is below this, return empty (prevents all-weak surfacing) */
  activationFloor: number;
  /** "adaptive" uses ratio-based filtering; "absolute" uses legacy minScore */
  thresholdMode: "adaptive" | "absolute";
  /** Budget-aware escalation: if fast path finishes early, spend remaining time on expansion + reranking */
  deepEscalation: boolean;
  /** Max time (ms) allowed for the fast path before escalation is considered */
  escalationBudgetMs: number;
  /**
   * §11.1 (v0.9.0): sub-budget for the `<vault-facts>` KG injection block.
   * Dedicated token allowance so `<vault-facts>` cannot steal budget from
   * the existing `<facts>` / `<relationships>` blocks. `speed` profile is
   * gated off (factsTokens=0 → stage skipped entirely). `balanced` / `deep`
   * get 200 / 250 respectively. If the serialized facts would exceed this
   * sub-budget, truncation happens at the triple boundary. If the total
   * hook output would push past `tokenBudget + factsTokens`, the whole
   * `<vault-facts>` block is dropped (established blocks take priority).
   */
  factsTokens: number;
  /**
   * Cross-agent memory PR: sub-budget for the `<cross-agent-facts>` injection
   * block. The block is produced ONLY when both (a) the global toggle
   * `retrieval.cross_agent_inject` / CLAWMEM_CROSS_AGENT_INJECT is true, AND
   * (b) this sub-budget is > 0. `speed` is gated off by default. `balanced` /
   * `deep` get a modest dedicated allowance that can never steal budget from
   * `<facts>` / `<vault-facts>`. Default keeps injection OFF end-to-end.
   */
  crossAgentTokens: number;
}

export const PROFILES: Record<PerformanceProfile, ProfileConfig> = {
  speed:    { tokenBudget: 400,  maxResults: 5,  useVector: false, vectorTimeout: 0,    minScore: 0.55, minScoreRatio: 0.65, absoluteFloor: 0.18, activationFloor: 0.24, thresholdMode: "adaptive", deepEscalation: false, escalationBudgetMs: 0,    factsTokens: 0,   crossAgentTokens: 0   },
  balanced: { tokenBudget: 800,  maxResults: 10, useVector: true,  vectorTimeout: 900,  minScore: 0.45, minScoreRatio: 0.55, absoluteFloor: 0.15, activationFloor: 0.20, thresholdMode: "adaptive", deepEscalation: false, escalationBudgetMs: 0,    factsTokens: 200, crossAgentTokens: 200 },
  deep:     { tokenBudget: 1200, maxResults: 15, useVector: true,  vectorTimeout: 2000, minScore: 0.25, minScoreRatio: 0.45, absoluteFloor: 0.12, activationFloor: 0.16, thresholdMode: "adaptive", deepEscalation: true,  escalationBudgetMs: 4000, factsTokens: 250, crossAgentTokens: 250 },
};

export function getActiveProfile(): ProfileConfig {
  const profileName = (process.env.CLAWMEM_PROFILE || "balanced") as PerformanceProfile;
  return PROFILES[profileName] || PROFILES.balanced;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

let _cachedConfig: ClawMemConfig | null = null;
// Once-per-process compatibility warning for the superseded tuned-weights knob (v0.22.0).
let _warnedTunedWeightsKnob = false;

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
            vaults[name] = resolve(expandHome(path));
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
            vaults[name] = resolve(expandHome(path as string));
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
      // INERT since v0.30.0 — ClawMem no longer physically deletes rows on any path.
      // Still parsed so existing configs load, but only a positive finite value is
      // accepted: `-1` or `Infinity` would previously have produced a future cutoff that
      // deleted every archived row, including ones archived moments earlier.
      purge_after_days:
        typeof lc.purge_after_days === "number" &&
        Number.isFinite(lc.purge_after_days) &&
        lc.purge_after_days > 0
          ? lc.purge_after_days
          : null,
      exempt_collections: Array.isArray(lc.exempt_collections) ? lc.exempt_collections : [],
      dry_run: lc.dry_run !== false,
    };
  }

  // 4. Retrieval knobs (optional). Parsed for backward compatibility only —
  // mcp_direct_tuned_weights is superseded as of v0.22.0 and has no effect.
  let retrieval: RetrievalConfig | undefined;
  const envTuned = process.env.CLAWMEM_MCP_DIRECT_TUNED_WEIGHTS;
  const yamlHasTuned = !!(parsedYaml?.retrieval && typeof parsedYaml.retrieval === "object"
    && parsedYaml.retrieval.mcp_direct_tuned_weights !== undefined);
  const yamlTuned = yamlHasTuned ? parsedYaml.retrieval.mcp_direct_tuned_weights === true : false;
  // Secondary-vault surfacing gate (v0.35.0): env overrides yaml; anything but the
  // literal "true" (env) / boolean true (yaml) resolves to the default OFF.
  const envSurface = process.env.CLAWMEM_SURFACE_SECONDARY_VAULTS;
  const yamlSurface = !!(parsedYaml?.retrieval && typeof parsedYaml.retrieval === "object"
    && parsedYaml.retrieval.surface_secondary_vaults === true);
  // Cross-agent injection gate (default OFF) + confidence floor (default 0.7).
  const envInject = process.env.CLAWMEM_CROSS_AGENT_INJECT;
  const yamlInject = !!(parsedYaml?.retrieval && typeof parsedYaml.retrieval === "object"
    && parsedYaml.retrieval.cross_agent_inject === true);
  const envConf = Number(process.env.CLAWMEM_CROSS_AGENT_CONFIDENCE);
  const yamlConf = (parsedYaml?.retrieval && typeof parsedYaml.retrieval === "object"
    && typeof parsedYaml.retrieval.cross_agent_confidence === "number")
    ? parsedYaml.retrieval.cross_agent_confidence as number : 0.7;
  const resolvedConf = Number.isFinite(envConf) && envConf > 0 && envConf <= 1 ? envConf
    : (Number.isFinite(yamlConf) && yamlConf > 0 && yamlConf <= 1 ? yamlConf : 0.7);
  retrieval = {
    mcp_direct_tuned_weights: envTuned !== undefined ? envTuned === "true" : yamlTuned,
    surface_secondary_vaults: envSurface !== undefined ? envSurface === "true" : yamlSurface,
    cross_agent_inject: envInject !== undefined ? envInject === "true" : yamlInject,
    cross_agent_confidence: resolvedConf,
  };
  if ((envTuned !== undefined || yamlHasTuned) && !_warnedTunedWeightsKnob) {
    _warnedTunedWeightsKnob = true;
    console.warn("[clawmem] retrieval.mcp_direct_tuned_weights / CLAWMEM_MCP_DIRECT_TUNED_WEIGHTS is superseded as of v0.22.0 and has no effect — the direct vector routes rank by raw similarity.");
  }

  _cachedConfig = { vaults, lifecycle, retrieval };
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
 * Whether automatic context surfacing may query configured secondary vaults
 * (`retrieval.surface_secondary_vaults` / CLAWMEM_SURFACE_SECONDARY_VAULTS).
 * Default false — vault isolation is the out-of-the-box posture (v0.35.0).
 * Explicit `vault`-parameter MCP calls are not governed by this gate.
 */
export function surfaceSecondaryVaults(): boolean {
  const config = loadVaultConfig();
  return config.retrieval?.surface_secondary_vaults === true;
}

/**
 * Whether cross-agent context injection is enabled
 * (`retrieval.cross_agent_inject` / CLAWMEM_CROSS_AGENT_INJECT). Default false.
 */
export function crossAgentInjectEnabled(): boolean {
  const config = loadVaultConfig();
  return config.retrieval?.cross_agent_inject === true;
}

/**
 * Minimum confidence for facts surfaced by cross-agent injection.
 * Default 0.7.
 */
export function crossAgentInjectConfidence(): number {
  const config = loadVaultConfig();
  return config.retrieval?.cross_agent_confidence ?? 0.7;
}

/**
 * Clear cached config (for testing or after env var changes).
 */
export function clearConfigCache(): void {
  _cachedConfig = null;
}
