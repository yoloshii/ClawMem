/**
 * Offline eval harness — replay against the REAL tool handlers (HORMA-1).
 *
 * The replay drives the actual registered MCP tool handlers over an in-memory
 * transport (`buildMcpServer` + `InMemoryTransport`) — the exact code path an
 * agent's `query` call takes, including expansion, RRF, rerank blending,
 * composite scoring, and MMR diversity at their tool defaults. It never
 * mirrors pipeline internals: a mirror measures a copy that drifts, not the
 * product. (The frozen `scripts/eval-*.ts` route-local harnesses are mirrors
 * by design, for decision-specific freeze bundles — different tool.)
 *
 * The replayed retrieval path writes no retrieval, lifecycle, or telemetry
 * state: the `query` handler touches neither `context_usage` /
 * `recall_events` nor `memory_relations` — the harness must never contaminate
 * the observational tables it may later mine for gold candidates. It is NOT
 * byte-level read-only: expansion and reranking may populate the normal
 * inference cache (`llm_cache`) exactly as any live query would.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../mcp.ts";
import type { GoldExample } from "./types.ts";

export interface EvalSession {
  client: Client;
  close: () => Promise<void>;
}

/** Build an in-process MCP client/server pair against the configured vault. */
export async function createEvalSession(): Promise<EvalSession> {
  const built = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  const client = new Client({ name: "clawmem-eval", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      try { await client.close(); } catch { /* transport already down */ }
      try { built.closeAllStores(); } catch { /* already closed */ }
    },
  };
}

export interface ReplayOutcome {
  /** Ordered displayPaths (`collection/path`) exactly as the tool returned them. */
  orderedPaths: string[];
  elapsedMs: number;
}

/**
 * Replay one gold example through the `query` tool (compact mode — same scored
 * result set as full mode, lighter payload). Per-example knobs that an agent
 * would set (`include_internal`, `collection`) flow through; everything else
 * stays at tool defaults so the run measures the default agent experience.
 */
export async function replayQueryExample(
  client: Pick<Client, "callTool">,
  example: GoldExample,
  limit: number
): Promise<ReplayOutcome> {
  const args: Record<string, unknown> = {
    query: example.query,
    limit,
    compact: true,
    includeInternal: example.include_internal,
  };
  if (example.collection) args.collection = example.collection;

  const t0 = performance.now();
  const res = await client.callTool({ name: "query", arguments: args }) as {
    structuredContent?: { results?: { path?: string }[] };
  };
  const elapsedMs = performance.now() - t0;

  const orderedPaths = (res.structuredContent?.results ?? [])
    .map(r => r.path ?? "")
    .filter(p => p.length > 0);
  return { orderedPaths, elapsedMs };
}
