/**
 * ClawMem OpenClaw Plugin — Transcript path resolver
 *
 * Why this exists: the typed `PluginHookName` events that ClawMem subscribes
 * to (`before_prompt_build`, `agent_end`) do NOT carry a `sessionFile` field
 * in their event payload. ClawMem's hooks (precompact-extract,
 * decision-extractor, handoff-generator, feedback-loop) all require a
 * `transcript_path` to read the session JSONL — they call
 * `validateTranscriptPath(input.transcriptPath ?? "")` and return empty on
 * failure (no session_id fallback).
 *
 * Codex Turn N+2 caught this: §14.11's design fix moved precompact off
 * `agent_end` (fire-and-forget) onto `before_prompt_build` (awaited), but
 * neither event delivers `sessionFile`, so the load-bearing precompact
 * path AND the eventually-consistent extractors were both no-ops.
 *
 * The fix: derive the transcript path from `sessionId` + `agentId` using
 * OpenClaw's canonical layout from `src/config/sessions/paths.ts`:
 *
 *   <state-dir>/agents/<agentId>/sessions/<sessionId>.jsonl
 *
 * where:
 *   - state-dir defaults to ~/.openclaw, overridable via OPENCLAW_STATE_DIR
 *     or OPENCLAW_HOME env vars (mirrors `src/config/paths.ts:resolveStateDir`)
 *   - agentId defaults to "main" (mirrors
 *     `src/routing/session-key.ts:DEFAULT_AGENT_ID`)
 *
 * Events that DO carry `sessionFile` (`before_compaction`, `before_reset`,
 * `after_compaction`, `session_end`) should pass that explicit value
 * instead — the resolver is a fallback, not a replacement.
 *
 * The resolver is fail-open: returns undefined when the resolved path does
 * not exist, the sessionId is invalid, or any underlying step throws.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * OpenClaw's default agent id (mirrors
 * `openclaw/src/routing/session-key.ts:20` `DEFAULT_AGENT_ID = "main"`).
 */
export const DEFAULT_AGENT_ID = "main";

/**
 * Mirror of OpenClaw's session-id validation regex from
 * `openclaw/src/config/sessions/paths.ts:61` `SAFE_SESSION_ID_RE`.
 *
 * Keeping the validation client-side prevents us from constructing
 * paths with `..` or other separators when the upstream sessionId is
 * malformed.
 */
const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/**
 * Mirror of OpenClaw's agent-id validation/normalization from
 * `openclaw/src/routing/session-key.ts:25` (`VALID_ID_RE`,
 * `INVALID_CHARS_RE`, `LEADING_DASH_RE`, `TRAILING_DASH_RE`).
 *
 * Codex Turn N+3 caught that a simple `.toLowerCase()` is not equivalent
 * to OpenClaw's full normalization: invalid characters must collapse to
 * `-`, leading/trailing dashes get stripped, and the result is bounded
 * to 64 characters. Mirroring this faithfully is critical because
 * ClawMem's resolver MUST produce the same path string OpenClaw's
 * `resolveSessionTranscriptPathInDir` would produce — otherwise the
 * extractor hooks read the wrong file (or no file at all) for sessions
 * whose agent id requires sanitization.
 */
const AGENT_ID_VALID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const AGENT_ID_INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const AGENT_ID_LEADING_DASH_RE = /^-+/;
const AGENT_ID_TRAILING_DASH_RE = /-+$/;

/**
 * Faithful mirror of `openclaw/src/routing/session-key.ts:91 normalizeAgentId`.
 *
 * - empty / whitespace → `DEFAULT_AGENT_ID` ("main")
 * - already-valid id (case-insensitive) → returned lowercased
 * - otherwise: lowercase, collapse invalid runs to `-`, strip leading +
 *   trailing dashes, slice to 64 chars, fall back to `DEFAULT_AGENT_ID`
 *   when the sanitized form is empty
 */
export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  const lowered = trimmed.toLowerCase();
  if (AGENT_ID_VALID_RE.test(trimmed)) {
    return lowered;
  }
  const sanitized = lowered
    .replace(AGENT_ID_INVALID_CHARS_RE, "-")
    .replace(AGENT_ID_LEADING_DASH_RE, "")
    .replace(AGENT_ID_TRAILING_DASH_RE, "")
    .slice(0, 64);
  return sanitized || DEFAULT_AGENT_ID;
}

/**
 * Legacy state-directory names that OpenClaw still falls back to when the
 * new `.openclaw` directory does not exist on disk. Mirrors
 * `openclaw/src/config/paths.ts:21` `LEGACY_STATE_DIRNAMES`.
 *
 * Codex Turn N+4 caught that the prior implementation always synthesized
 * `~/.openclaw` and never checked whether OpenClaw was actually running
 * from the legacy state root. This array preserves OpenClaw's pre-rebrand
 * compatibility for installs that haven't been migrated.
 */
const LEGACY_STATE_DIRNAMES = [".clawdbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";

/**
 * Resolve OpenClaw's state directory using the same precedence as
 * `openclaw/src/config/paths.ts:resolveStateDir`:
 *
 *   1. `$OPENCLAW_STATE_DIR` if set (env override, no further fallback)
 *   2. `$OPENCLAW_HOME` if set (replaces homedir; appends `.openclaw`)
 *   3. `<home>/.openclaw` if the directory exists
 *   4. `<home>/.clawdbot` (legacy) if it exists and `.openclaw` does not
 *   5. `<home>/.openclaw` as the synthesized default
 *
 * Honors `OPENCLAW_TEST_FAST=1` to skip the existence checks (mirrors
 * OpenClaw's behavior at `paths.ts:70-72`).
 *
 * Codex Turn N+4 fix: prior version skipped step 4 entirely. Upgraded-but-
 * not-migrated installs would then point at a synthesized `.openclaw` path
 * that doesn't exist, while OpenClaw itself runs from `.clawdbot`.
 */
export function resolveOpenClawStateDir(
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return resolveHomeRelative(stateOverride, home);
  }

  // OPENCLAW_HOME replaces the homedir entirely (mirrors
  // `openclaw/src/infra/home-dir.ts:resolveRawHomeDir`). The state dir
  // then becomes `<OPENCLAW_HOME>/.openclaw`.
  const effectiveHome = (() => {
    const homeOverride = env.OPENCLAW_HOME?.trim();
    if (homeOverride) return resolveHomeRelative(homeOverride, home);
    return home();
  })();

  const newDir = join(effectiveHome, NEW_STATE_DIRNAME);

  if (env.OPENCLAW_TEST_FAST === "1") {
    return newDir;
  }

  // Prefer the new dir when it exists.
  try {
    if (existsSync(newDir)) return newDir;
  } catch {
    // Fall through to legacy detection
  }

  // Legacy fallback: check each legacy name in order; first existing wins.
  for (const legacyName of LEGACY_STATE_DIRNAMES) {
    const legacyDir = join(effectiveHome, legacyName);
    try {
      if (existsSync(legacyDir)) return legacyDir;
    } catch {
      // Ignore and continue
    }
  }

  // Synthesized default — OpenClaw bootstraps the new dir on first run.
  return newDir;
}

function resolveHomeRelative(input: string, home: () => string): string {
  if (input === "~") return home();
  if (input.startsWith("~/")) return join(home(), input.slice(2));
  return resolve(input);
}

/**
 * Minimal SessionEntry shape ClawMem cares about. The full type lives in
 * `openclaw/src/config/sessions/types.ts:111` and has many more fields,
 * but the resolver only needs `sessionId` and `sessionFile`. Treating
 * the rest of the JSON as `unknown` keeps ClawMem decoupled from
 * OpenClaw's internal session model.
 */
type MinimalSessionEntry = {
  sessionId?: unknown;
  sessionFile?: unknown;
  [key: string]: unknown;
};

/**
 * Read `<sessionsDir>/sessions.json` and look up the entry whose
 * `sessionFile` ClawMem should use. Mirrors OpenClaw's authoritative
 * source of truth at `openclaw/src/config/sessions/store-read.ts:10`.
 *
 * Resolution order:
 *   1. Exact key match `store[sessionKey]` (when caller has the full
 *      session-store key like `agent:main:abc123`)
 *   2. Scan entries for one whose `entry.sessionId === sessionId`
 *
 * Returns the resolved `sessionFile` path (made absolute against
 * `sessionsDir` when stored as a relative basename) or undefined when:
 *   - sessions.json does not exist or fails to parse
 *   - no matching entry has a `sessionFile` field
 *
 * Fail-open: never throws. Codex Turn N+5 fix — sessions.json is the
 * only authoritative way to disambiguate between base and topic-scoped
 * transcript files when both exist for the same sessionId.
 */
function lookupSessionFileFromStore(params: {
  sessionsDir: string;
  sessionId: string;
  sessionKey?: string;
}): string | undefined {
  const storePath = join(params.sessionsDir, "sessions.json");
  let raw: string;
  try {
    raw = readFileSync(storePath, "utf-8");
  } catch {
    return undefined;
  }
  if (!raw.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const store = parsed as Record<string, unknown>;

  const resolveEntryFile = (entry: MinimalSessionEntry | undefined): string | undefined => {
    const file = entry?.sessionFile;
    if (typeof file !== "string" || !file.trim()) return undefined;
    const trimmed = file.trim();
    return isAbsolute(trimmed) ? trimmed : join(params.sessionsDir, trimmed);
  };

  // 1. Exact sessionKey match
  if (params.sessionKey) {
    const directEntry = store[params.sessionKey];
    if (directEntry && typeof directEntry === "object" && !Array.isArray(directEntry)) {
      const candidate = resolveEntryFile(directEntry as MinimalSessionEntry);
      if (candidate) return candidate;
    }
  }

  // 2. Scan for entry whose sessionId matches
  for (const value of Object.values(store)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as MinimalSessionEntry;
    if (typeof entry.sessionId === "string" && entry.sessionId === params.sessionId) {
      const candidate = resolveEntryFile(entry);
      if (candidate) return candidate;
    }
  }

  return undefined;
}

/**
 * Build the session-file basename. Mirrors the filename-construction
 * branch in `openclaw/src/config/sessions/paths.ts:248-251`:
 *
 *   - no topicId: `<sessionId>.jsonl`
 *   - topicId (string): `<sessionId>-topic-<encodeURIComponent(topicId)>.jsonl`
 *   - topicId (number): `<sessionId>-topic-<topicId>.jsonl`
 */
function buildTranscriptFileName(sessionId: string, topicId?: string | number): string {
  if (topicId === undefined || topicId === null || topicId === "") {
    return `${sessionId}.jsonl`;
  }
  const encoded =
    typeof topicId === "string" ? encodeURIComponent(topicId) : String(topicId);
  return `${sessionId}-topic-${encoded}.jsonl`;
}

/**
 * Derive the canonical OpenClaw session transcript path for a given
 * (sessionId, agentId, sessionKey, topicId) tuple. Mirrors
 * `openclaw/src/config/sessions/paths.ts:resolveSessionTranscriptPathInDir`
 * including the topic-id filename branch and `resolveSessionFilePath`'s
 * `entry.sessionFile` lookup against `sessions.json`.
 *
 * Resolution order (Codex Turn N+5 fix):
 *   1. **Authoritative source-of-truth**: read `sessions.json` and look
 *      up `entry.sessionFile` by sessionKey (exact match) or by scanning
 *      for an entry whose `sessionId` matches. This is the same path
 *      OpenClaw uses internally at
 *      `openclaw/src/config/sessions/paths.ts:resolveSessionFilePath` —
 *      the entry's sessionFile is the truth, regardless of whether the
 *      transcript is base or topic-scoped.
 *   2. If `params.topicId` is provided explicitly, use it:
 *      `<sessionId>-topic-<encodeURIComponent(topicId)>.jsonl`
 *   3. Try the base filename `<sessionId>.jsonl` if AND ONLY IF no
 *      topic-scoped variants coexist. This prevents ClawMem from
 *      silently picking the wrong transcript when both base and topic
 *      files exist for the same sessionId without sessions.json metadata.
 *   4. If only topic-scoped variants exist, return the single match
 *      (unambiguous). Two or more topic variants without metadata is
 *      ambiguous → fail-open.
 *
 * Returns undefined when:
 *   - sessionId is missing or fails the SAFE_SESSION_ID_RE check
 *   - none of the resolution steps find a file on disk
 *   - the filesystem fallback is ambiguous (base + topic coexist, or
 *     multiple topic variants exist) and sessions.json could not
 *     disambiguate
 *
 * Fail-open: never throws. Each filesystem check is wrapped in a
 * try/catch and ignored.
 */
export function resolveOpenClawSessionFile(params: {
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  topicId?: string | number;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) return undefined;
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return undefined;

  // Use the full normalizeAgentId mirror — NOT a simple .toLowerCase().
  const agentId = normalizeAgentId(params.agentId);

  let stateDir: string;
  try {
    stateDir = resolveOpenClawStateDir(params.env);
  } catch {
    return undefined;
  }

  const sessionsDir = join(stateDir, "agents", agentId, "sessions");

  // 1. AUTHORITATIVE: sessions.json lookup. This is OpenClaw's source
  // of truth for which transcript file is active for a given session.
  const fromStore = lookupSessionFileFromStore({
    sessionsDir,
    sessionId,
    sessionKey: params.sessionKey,
  });
  if (fromStore) {
    try {
      if (existsSync(fromStore)) return fromStore;
    } catch {
      // Fall through to filesystem fallback
    }
  }

  // 2. Explicit topic-id from caller wins (rare — typed-hook events
  // don't carry topicId, but the API surface still supports it for
  // tests and future callers).
  if (params.topicId !== undefined && params.topicId !== null && params.topicId !== "") {
    const explicitTopic = join(
      sessionsDir,
      buildTranscriptFileName(sessionId, params.topicId),
    );
    try {
      if (existsSync(explicitTopic)) return explicitTopic;
    } catch {
      // Fall through
    }
    // Don't fall back to the base filename if caller asked for a specific
    // topic — they explicitly want THAT file or nothing.
    return undefined;
  }

  // 3 + 4. Filesystem fallback when sessions.json could not resolve.
  // We need to enumerate the sessions dir to detect the base+topic
  // coexistence case (Codex Turn N+5 finding) before deciding which
  // file to return.
  let baseExists = false;
  try {
    baseExists = existsSync(join(sessionsDir, `${sessionId}.jsonl`));
  } catch {
    baseExists = false;
  }

  let topicMatches: string[] = [];
  try {
    const topicPrefix = `${sessionId}-topic-`;
    const entries = readdirSync(sessionsDir);
    topicMatches = entries.filter(
      (name) => name.startsWith(topicPrefix) && name.endsWith(".jsonl"),
    );
  } catch {
    topicMatches = [];
  }

  // Codex Turn N+5 fix: when BOTH base and topic variants exist, the
  // resolver cannot tell which is the active transcript without
  // sessions.json metadata. Fail-open instead of preferring base.
  if (baseExists && topicMatches.length > 0) {
    return undefined;
  }

  // Base only → return base
  if (baseExists && topicMatches.length === 0) {
    return join(sessionsDir, `${sessionId}.jsonl`);
  }

  // Single topic-scoped variant → unambiguous, return it
  if (!baseExists && topicMatches.length === 1) {
    return join(sessionsDir, topicMatches[0]!);
  }

  // 0 matches → no transcript exists yet (new session)
  // 2+ topic variants without base → ambiguous, fail-open
  return undefined;
}

/**
 * Pure-function variant of `resolveOpenClawSessionFile` that skips the
 * filesystem existence check. Useful for unit tests that want to verify
 * the path-construction logic without setting up a real OpenClaw state
 * tree on disk.
 */
export function buildOpenClawSessionFilePath(params: {
  sessionId: string;
  agentId?: string;
  topicId?: string | number;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  if (!sessionId || !SAFE_SESSION_ID_RE.test(sessionId)) return undefined;
  const agentId = normalizeAgentId(params.agentId);
  let stateDir: string;
  try {
    stateDir = resolveOpenClawStateDir(params.env);
  } catch {
    return undefined;
  }
  const fileName = buildTranscriptFileName(sessionId, params.topicId);
  return join(stateDir, "agents", agentId, "sessions", fileName);
}
