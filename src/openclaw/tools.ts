/**
 * ClawMem OpenClaw Plugin — Tool registrations
 *
 * Registers a subset of ClawMem's retrieval tools as OpenClaw agent tools.
 * Tools call the ClawMem REST API (clawmem serve) for efficient access.
 *
 * Registered tools (retrieval subset per GPT 5.4 recommendation):
 * - clawmem_search: Unified search (keyword/semantic/hybrid)
 * - clawmem_get: Get document by docid
 * - clawmem_session_log: Recent session summaries
 * - clawmem_timeline: Temporal context around a document
 * - clawmem_similar: Find similar documents
 */

import type { ClawMemConfig } from "./shell.js";

// =============================================================================
// Types (matching OpenClaw's tool interface without importing it)
// =============================================================================

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

type Logger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// =============================================================================
// REST API Client
// =============================================================================

async function apiCall(
  cfg: ClawMemConfig,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `http://127.0.0.1:${cfg.servePort}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // Add auth token if configured
  const token = cfg.env.CLAWMEM_API_TOKEN || process.env.CLAWMEM_API_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: { error: `ClawMem API unreachable at ${url}: ${String(err)}` },
    };
  }
}

// =============================================================================
// Tool Definitions
// =============================================================================

type ToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

export function createTools(cfg: ClawMemConfig, logger: Logger): ToolDef[] {
  return [
    // --- Unified Search ---
    {
      name: "clawmem_search",
      label: "ClawMem Search",
      description:
        "Search long-term memory for relevant context. Supports keyword, semantic, and hybrid modes. " +
        "Use for recalling past decisions, preferences, session history, and learned patterns.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          mode: {
            type: "string",
            enum: ["auto", "keyword", "semantic", "hybrid"],
            description: "Search mode (default: auto)",
          },
          collection: { type: "string", description: "Limit to specific collection" },
          limit: { type: "number", description: "Max results (default: 10, max: 50)" },
          compact: { type: "boolean", description: "Return compact results (default: true)" },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        const result = await apiCall(cfg, "POST", "/search", {
          query: params.query as string,
          mode: params.mode ?? "auto",
          collection: params.collection,
          limit: params.limit ?? 10,
          compact: params.compact ?? true,
        });

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Search failed: ${result.data?.error || "unknown error"}` }],
          };
        }

        const data = result.data;
        if (!data.results || data.results.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: { count: 0 },
          };
        }

        const text = data.results
          .map((r: any, i: number) =>
            `${i + 1}. [${r.contentType || "note"}] ${r.title || r.path} (score: ${r.score})${r.snippet ? `\n   ${r.snippet}` : ""}`
          )
          .join("\n");

        return {
          content: [{ type: "text", text: `Found ${data.count} results:\n\n${text}` }],
          details: { count: data.count, query: data.query, mode: data.mode },
        };
      },
    },

    // --- Get Document ---
    {
      name: "clawmem_get",
      label: "ClawMem Get",
      description:
        "Retrieve full content of a specific memory document by its docid (6-char hex prefix).",
      parameters: {
        type: "object",
        properties: {
          docid: { type: "string", description: "Document ID (6-char hex prefix from search results)" },
        },
        required: ["docid"],
      },
      async execute(_id, params) {
        const docid = params.docid as string;
        const result = await apiCall(cfg, "GET", `/documents/${docid}`);

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Document not found: ${docid}` }],
          };
        }

        const d = result.data;
        return {
          content: [{
            type: "text",
            text: `# ${d.title || d.path}\n\nCollection: ${d.collection}\nModified: ${d.modifiedAt}\n\n${d.body}`,
          }],
          details: { docid: d.docid, path: d.path },
        };
      },
    },

    // --- Session Log ---
    {
      name: "clawmem_session_log",
      label: "ClawMem Sessions",
      description:
        "List recent session summaries. Use when asked about past work, previous conversations, or session history.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of sessions to return (default: 5)" },
        },
      },
      async execute(_id, params) {
        const limit = (params.limit as number) || 5;
        const result = await apiCall(cfg, "GET", `/sessions?limit=${limit}`);

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Failed to retrieve sessions: ${result.data?.error}` }],
          };
        }

        const sessions = result.data.sessions;
        if (!sessions || sessions.length === 0) {
          return { content: [{ type: "text", text: "No session history found." }] };
        }

        const text = sessions
          .map((s: any, i: number) =>
            `${i + 1}. [${s.started_at}] ${s.session_id?.slice(0, 8)}... — ${s.prompt_count || 0} prompts`
          )
          .join("\n");

        return {
          content: [{ type: "text", text: `Recent sessions:\n\n${text}` }],
          details: { count: sessions.length },
        };
      },
    },

    // --- Timeline ---
    {
      name: "clawmem_timeline",
      label: "ClawMem Timeline",
      description:
        "Show temporal context around a document — what was created before and after it.",
      parameters: {
        type: "object",
        properties: {
          docid: { type: "string", description: "Document ID (6-char hex prefix)" },
          before: { type: "number", description: "Documents before (default: 5)" },
          after: { type: "number", description: "Documents after (default: 5)" },
          same_collection: { type: "boolean", description: "Limit to same collection (default: false)" },
        },
        required: ["docid"],
      },
      async execute(_id, params) {
        const docid = params.docid as string;
        const before = params.before ?? 5;
        const after = params.after ?? 5;
        const sameCol = params.same_collection ?? false;
        const qs = `before=${before}&after=${after}&same_collection=${sameCol}`;
        const result = await apiCall(cfg, "GET", `/timeline/${docid}?${qs}`);

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Timeline failed: ${result.data?.error}` }],
          };
        }

        const d = result.data;
        const lines: string[] = [];
        if (d.before?.length) {
          lines.push("**Before:**");
          for (const e of d.before) lines.push(`  - [${e.modifiedAt}] ${e.title} (${e.collection})`);
        }
        lines.push(`**→ ${d.anchor?.title || docid}** [${d.anchor?.modifiedAt}]`);
        if (d.after?.length) {
          lines.push("**After:**");
          for (const e of d.after) lines.push(`  - [${e.modifiedAt}] ${e.title} (${e.collection})`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { docid, before: d.before?.length, after: d.after?.length },
        };
      },
    },

    // --- Similar ---
    {
      name: "clawmem_similar",
      label: "ClawMem Similar",
      description:
        "Find documents semantically similar to a given document. Use for discovery and context expansion.",
      parameters: {
        type: "object",
        properties: {
          docid: { type: "string", description: "Document ID (6-char hex prefix)" },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["docid"],
      },
      async execute(_id, params) {
        const docid = params.docid as string;
        const limit = params.limit ?? 5;
        const result = await apiCall(cfg, "GET", `/graph/similar/${docid}?limit=${limit}`);

        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Similar search failed: ${result.data?.error}` }],
          };
        }

        const similar = result.data.similar;
        if (!similar || similar.length === 0) {
          return { content: [{ type: "text", text: "No similar documents found." }] };
        }

        const text = similar
          .map((s: any, i: number) => `${i + 1}. ${s.title || s.path} (similarity: ${s.score})`)
          .join("\n");

        return {
          content: [{ type: "text", text: `Similar documents:\n\n${text}` }],
          details: { count: similar.length },
        };
      },
    },
  ];
}
