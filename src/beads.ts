/**
 * Beads Integration - Dolt-backed task dependency graph
 *
 * Queries Beads via `bd` CLI (v0.58.0+, Dolt backend) and syncs issues to ClawMem.
 * Replaces legacy JSONL parser — Dolt is now source of truth.
 *
 * Reference: https://github.com/steveyegge/beads
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// =============================================================================
// Types (matches bd list --json output: IssueWithCounts)
// =============================================================================

export interface BeadsDependency {
  issue_id: string;
  depends_on_id: string;
  type: string;         // blocks, parent-child, waits-for, discovered-from, relates-to, etc.
  created_at: string;
  created_by?: string;
  metadata?: string;
  thread_id?: string;
}

export interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  status: string;         // open, in_progress, blocked, deferred, closed
  priority: number;       // 0-4
  issue_type?: string;    // task, bug, feature, epic, chore, decision, etc.
  assignee?: string;
  owner?: string;
  created_at: string;
  updated_at?: string;
  closed_at?: string;
  close_reason?: string;
  external_ref?: string;
  metadata?: Record<string, unknown>;
  labels?: string[];
  dependencies?: BeadsDependency[];
  quality_score?: number;
  // Computed counts from bd list --json
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  parent?: string;
  // Legacy compat fields (mapped from new schema)
  type: string;           // alias for issue_type
  tags: string[];         // alias for labels
  blocks: string[];       // extracted from dependencies
}

// =============================================================================
// CLI Interface
// =============================================================================

/**
 * Find the `bd` binary. Checks PATH, common locations.
 */
function findBdBinary(): string | null {
  // Check PATH first
  try {
    const path = execSync("which bd 2>/dev/null", { encoding: "utf-8" }).trim();
    if (path) return path;
  } catch { /* not on PATH */ }

  // Check common locations
  const candidates = [
    join(process.env.HOME || "", "go/bin/bd"),
    "/usr/local/bin/bd",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Run a bd CLI command and return stdout.
 * Executes in the project directory containing .beads/.
 */
function runBd(projectDir: string, args: string[], timeoutMs = 10000): string | null {
  const bd = findBdBinary();
  if (!bd) {
    console.warn("[beads] bd binary not found — cannot sync from Dolt backend");
    return null;
  }

  try {
    return execSync(`${bd} ${args.join(" ")}`, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    console.warn(`[beads] bd ${args[0]} failed: ${err.message?.slice(0, 200)}`);
    return null;
  }
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Query all beads from Dolt via `bd list --json`.
 * Returns parsed issues with labels and dependencies populated.
 */
export function queryBeadsList(projectDir: string): BeadsIssue[] {
  const output = runBd(projectDir, ["list", "--json"]);
  if (!output) return [];

  try {
    const raw = JSON.parse(output);
    if (!Array.isArray(raw)) return [];

    return raw.map((item: any) => normalizeBeadsIssue(item));
  } catch (err) {
    console.warn(`[beads] Failed to parse bd list output: ${err}`);
    return [];
  }
}

/**
 * Normalize a Beads JSON issue into our BeadsIssue type.
 * Maps new Dolt schema fields to legacy compat fields.
 */
function normalizeBeadsIssue(raw: any): BeadsIssue {
  const deps: BeadsDependency[] = raw.dependencies || [];

  // Extract "blocks" relationships for legacy compat
  const blocks = deps
    .filter((d: BeadsDependency) => d.type === "blocks" && d.issue_id === raw.id)
    .map((d: BeadsDependency) => d.depends_on_id);

  return {
    id: raw.id,
    title: raw.title || "",
    description: raw.description,
    notes: raw.notes,
    status: raw.status || "open",
    priority: raw.priority ?? 2,
    issue_type: raw.issue_type,
    assignee: raw.assignee,
    owner: raw.owner,
    created_at: raw.created_at || new Date().toISOString(),
    updated_at: raw.updated_at,
    closed_at: raw.closed_at,
    close_reason: raw.close_reason,
    external_ref: raw.external_ref,
    metadata: raw.metadata,
    labels: raw.labels || [],
    dependencies: deps,
    quality_score: raw.quality_score,
    dependency_count: raw.dependency_count,
    dependent_count: raw.dependent_count,
    comment_count: raw.comment_count,
    parent: raw.parent,
    // Legacy compat
    type: raw.issue_type || "task",
    tags: raw.labels || [],
    blocks,
  };
}

// =============================================================================
// Detection
// =============================================================================

/**
 * Detect if a directory contains a Beads project (Dolt-backed).
 * Returns the project directory path if found, null otherwise.
 *
 * Checks for .beads/ directory (Dolt backend).
 * Falls back to checking .beads/beads.jsonl for legacy installations.
 */
export function detectBeadsProject(cwd: string): string | null {
  const beadsDir = join(cwd, ".beads");
  if (existsSync(beadsDir)) return cwd;
  return null;
}

// =============================================================================
// Markdown Formatting
// =============================================================================

/**
 * Format a Beads issue as markdown for ClawMem indexing.
 */
export function formatBeadsIssueAsMarkdown(issue: BeadsIssue): string {
  const lines = [
    `# ${issue.title}`,
    ``,
    `**ID**: ${issue.id}`,
    `**Type**: ${issue.type || issue.issue_type || "task"}`,
    `**Status**: ${issue.status}`,
    `**Priority**: P${issue.priority}`,
  ];

  if (issue.assignee) lines.push(`**Assignee**: ${issue.assignee}`);
  if (issue.owner) lines.push(`**Owner**: ${issue.owner}`);
  if (issue.parent) lines.push(`**Parent**: ${issue.parent}`);
  if (issue.tags && issue.tags.length > 0) lines.push(`**Tags**: ${issue.tags.join(", ")}`);
  if (issue.labels && issue.labels.length > 0 && !issue.tags?.length) {
    lines.push(`**Labels**: ${issue.labels.join(", ")}`);
  }
  if (issue.blocks && issue.blocks.length > 0) lines.push(`**Blocks**: ${issue.blocks.join(", ")}`);
  if (issue.external_ref) lines.push(`**External Ref**: ${issue.external_ref}`);
  if (issue.quality_score != null) lines.push(`**Quality Score**: ${issue.quality_score}`);

  if (issue.description) {
    lines.push("", "## Description", "", issue.description);
  }

  if (issue.notes) {
    lines.push("", "## Notes", "", issue.notes);
  }

  // Include dependency details
  if (issue.dependencies && issue.dependencies.length > 0) {
    lines.push("", "## Dependencies", "");
    for (const dep of issue.dependencies) {
      const dir = dep.issue_id === issue.id ? `→ ${dep.depends_on_id}` : `← ${dep.issue_id}`;
      lines.push(`- ${dep.type}: ${dir}`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Legacy Compat (parseBeadsJsonl — kept for migration, not active use)
// =============================================================================

/**
 * @deprecated Use queryBeadsList() instead. Beads v0.58.0+ uses Dolt backend.
 * Kept only for one-time migration of pre-Dolt installations.
 */
export function parseBeadsJsonl(path: string): BeadsIssue[] {
  console.warn("[beads] parseBeadsJsonl is deprecated — Beads v0.58.0+ uses Dolt backend. Use queryBeadsList() instead.");
  const { readFileSync } = require("node:fs");
  const content = readFileSync(path, "utf-8");
  const lines = content.trim().split("\n");

  return lines
    .filter((line: string) => line.trim())
    .map((line: string) => {
      try {
        const raw = JSON.parse(line);
        return normalizeBeadsIssue(raw);
      } catch {
        return null;
      }
    })
    .filter((issue: BeadsIssue | null): issue is BeadsIssue => issue !== null);
}
