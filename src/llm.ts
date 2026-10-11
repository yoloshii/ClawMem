/**
 * llm.ts - LLM abstraction layer for QMD using node-llama-cpp
 *
 * Provides embeddings, text generation, and reranking using local GGUF models.
 * Embeddings can use a remote server (CLAWMEM_EMBED_URL), cloud API, or local node-llama-cpp fallback.
 */

// node-llama-cpp is loaded lazily to avoid ~630ms import cost when all
// operations route to remote GPU servers. Only loaded if a local fallback
// is actually needed (GPU server down).
let _nodeLlamaCpp: typeof import("node-llama-cpp") | null = null;
async function getNodeLlamaCpp() {
  if (!_nodeLlamaCpp) {
    _nodeLlamaCpp = await import("node-llama-cpp");
  }
  return _nodeLlamaCpp;
}

// Re-export type aliases for internal use (structural, no runtime cost)
type Llama = any;
type LlamaModel = any;
type LlamaEmbeddingContext = any;
type LlamaToken = any;

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { timeoutSignal, type MonoDeadline, epochNow, epochMs, monoNow, deadlineAfter, duration, earliest } from "./clock.ts";

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Prompt format applied around queries and documents before embedding (`CLAWMEM_EMBED_FORMAT`):
 *   gemma (default) — EmbeddingGemma task prefixes (`task: search result | query: …`, `title: … | text: …`)
 *   qwen3          — Qwen3-Embedding: instruction on the query side only, raw passage text
 *   plain          — no wrapping (BGE-M3, most BERT-family models)
 * Changing it changes the vector geometry: run `clawmem embed --force` afterwards.
 */
export type EmbedFormat = "gemma" | "qwen3" | "plain";
export function embedFormat(): EmbedFormat {
  const v = (process.env.CLAWMEM_EMBED_FORMAT || "").trim().toLowerCase();
  return v === "qwen3" || v === "plain" ? v : "gemma";
}
const QWEN3_QUERY_INSTRUCTION = "Given a search query, retrieve relevant notes and passages that answer the query";

/**
 * Format a query for embedding.
 * Uses task prefix format for embedding models.
 */
export function formatQueryForEmbedding(query: string): string {
  switch (embedFormat()) {
    case "qwen3": return `Instruct: ${QWEN3_QUERY_INSTRUCTION}\nQuery: ${query}`;
    case "plain": return query;
    default: return `task: search result | query: ${query}`;
  }
}

/**
 * Format a document for embedding.
 * Uses title + text format for embedding models.
 */
export function formatDocForEmbedding(text: string, title?: string): string {
  switch (embedFormat()) {
    case "qwen3":
    case "plain": return title && title !== "none" ? `${title}\n${text}` : text;
    default: return `title: ${title || "none"} | text: ${text}`;
  }
}

// =============================================================================
// Types
// =============================================================================

/**
 * Token with log probability
 */
export type TokenLogProb = {
  token: string;
  logprob: number;
};

/**
 * Embedding result
 */
export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

/**
 * Generation result with optional logprobs
 */
export type GenerateResult = {
  text: string;
  model: string;
  logprobs?: TokenLogProb[];
  done: boolean;
};

/**
 * v0.41.2 (BACKLOG 68.5): the backend one Stop-pipeline call is pinned to — the remote server by its root URL, or the
 * in-process model by its file. A call never falls through from one to the other.
 */
export type LlmBackendId = { kind: "remote"; root: string } | { kind: "local"; modelPath: string };

/** v0.41.2: a generation that reports WHY it stopped. `finish: "length"` is a reply the server cut. */
export type GenerateDetail =
  | {
    ok: true; text: string; model: string; finish: "stop" | "length" | "other";
    promptTokens?: number; completionTokens?: number; backend: LlmBackendId;
  }
  | {
    /** v0.41.4: `grammar_rejected` — the in-process model could not compile the request's grammar; nothing was generated. */
    ok: false; reason: "unavailable" | "context_exceeded" | "http" | "aborted" | "grammar_rejected";
    nCtx?: number; promptTokens?: number; backend: LlmBackendId;
    /** v0.41.4: the HTTP status the server answered (`http`) — a grammar request's 400 is told from any other failure. */
    status?: number;
  };

/** v0.41.2: a backend's per-request context, and where the number came from. */
export type LlmCapacity = {
  backend: LlmBackendId;
  nCtx: number;
  source: "measured" | "configured" | "assumed";
  /** sha256 of what identifies the serving model + template + build (strong) or only the configuration (weak). */
  fingerprint: string;
  fingerprintStrength: "strong" | "weak";
};

/**
 * v0.41.2: a prompt's token count as the chat endpoint will see it. `template` = the server rendered and tokenized
 * the exact chat prompt; `content` = the content's tokens plus `margin` for the template; `estimate` = no tokenizer.
 */
export type ChatTokenCount = { tokens: number; method: "template" | "content" | "estimate"; margin: number };

/** v0.41.2: where a measured chat-template overhead is kept between processes (the Stop pipeline: `vault_flags`). */
export type OverheadStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  /**
   * v0.41.4: an atomic read-modify-write of one key (the Stop pipeline: one immediate transaction) — `fn` gets the
   * stored value (null when absent) and returns the new one (null deletes). The observer's shared records merge through
   * it; a store without it is read and written in two steps.
   */
  update?(key: string, fn: (old: string | null) => string | null): void;
  /** v0.41.4: every key under `prefix` with its value (the observer prunes its per-backend records). */
  entries?(prefix: string): { key: string; value: string }[];
  /** v0.41.4: run `fn` as one immediate transaction — its get/set/delete/update/entries calls inside it. */
  transaction?<T>(fn: () => T): T;
};

/**
 * Rerank result for a single document
 */
export type RerankDocumentResult = {
  file: string;
  score: number;
  index: number;
};

/**
 * Batch rerank result
 */
export type RerankResult = {
  results: RerankDocumentResult[];
  model: string;
};

/**
 * Model info
 */
export type ModelInfo = {
  name: string;
  exists: boolean;
  path?: string;
};

/**
 * Options for embedding
 */
export type EmbedOptions = {
  model?: string;
  isQuery?: boolean;
  title?: string;
  /**
   * Abort signal for the remote embed fetch AND its 429-retry backoff (B4).
   * The query path passes AbortSignal.timeout(<remaining budget>) so a slow or
   * rate-limited embed cannot outlive the caller's deadline. Without it, the
   * hook's Promise.race only ABANDONS the embed promise — the underlying fetch
   * and retry sleeps keep running; the signal actually CANCELS them.
   */
  signal?: AbortSignal;
};

/**
 * Options for text generation
 */
export type GenerateOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

/**
 * Judge-only chat request/result (v0.29.0). Consumed by generateJudgeChat — the
 * judge factory's openai lane. Deliberately NOT part of GenerateOptions: the
 * legacy generate() wire shape must stay byte-identical for existing consumers.
 */
export type JudgeChatRequest = {
  system: string;
  user: string;
  /** JSON schema for a response_format json_schema constraint; omitted → prompt-only. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
};

export type JudgeChatResult =
  | { ok: true; text: string; model: string; truncated: boolean }
  | { ok: false; reason: "unavailable" | "http" | "timeout" | "aborted"; detail: string };

/**
 * Options for reranking
 */
export type RerankOptions = {
  model?: string;
};

/**
 * Supported query types for different search backends
 */
export type QueryType = 'lex' | 'vec' | 'hyde';

/**
 * A single query and its target backend type
 */
export type Queryable = {
  type: QueryType;
  text: string;
};

/**
 * Template-residue / leak patterns that indicate an expansion line is NOT a real
 * query. The qmd-query-expansion finetune, when prompted out of distribution,
 * echoed the old verbose prompt's format hints and leaked Qwen3 thinking tags;
 * these never belong in a search query. Kept as a defensive guard even though the
 * terse QMD-faithful prompt (expandQueryRemote, 2026-06-23) fixed generation.
 */
const EXPANSION_JUNK_PATTERNS: RegExp[] = [
  /<\/?think>/i,
  /keyword search terms \(/i,
  /semantic search queries \(/i,
  /hypothetical document passage that answers the query/i,
];

/** True if an expansion text is empty or matches a known template-residue pattern. */
export function isJunkExpansion(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return EXPANSION_JUNK_PATTERNS.some(re => re.test(t));
}

/**
 * Strip stray Qwen3 `/no_think` / `/think` control tokens the model sometimes
 * echoes mid-line (generateRemote appends ` /no_think`, and the finetune can copy
 * it into a hyde passage). Only matches the token when it stands alone (start/space
 * bounded) so real paths like `src/think.ts` are never touched. Unlike the `<think>`
 * tag (which signals reasoning leakage → whole line rejected), a stray control token
 * just gets cleaned out so the otherwise-good line survives.
 */
function stripControlTokens(text: string): string {
  return text.replace(/(?:^|\s)\/(?:no_)?think(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * Shared guard for query-expansion output. Drops empty / template-residue /
 * think-tag lines and de-duplicates by (type, text). Used by BOTH the llm.ts
 * parsers and the store.ts wrapper (defense-in-depth across every provider).
 * Does NOT inject a fallback — callers decide what to do with an empty result,
 * and does NOT require the original query terms to appear (that would reject
 * legitimate synonyms and keyword-only expansions, e.g. a future zegen lex leg).
 */
export function sanitizeExpandedQueries(items: Queryable[]): Queryable[] {
  const seen = new Set<string>();
  const out: Queryable[] = [];
  for (const q of items) {
    const text = stripControlTokens(q.text);
    if (isJunkExpansion(text)) continue;
    const key = `${q.type}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: q.type, text });
  }
  return out;
}

/**
 * Typed fallback expansion set, used when generation fails or sanitization leaves
 * nothing usable. lex+vec reuse the original query; hyde gets a minimal stub so the
 * vector leg still has a hypothetical-document signal.
 */
export function expansionFallback(query: string, includeLexical: boolean = true): Queryable[] {
  const out: Queryable[] = [
    { type: 'vec', text: query },
    { type: 'hyde', text: `Information about ${query}` },
  ];
  if (includeLexical) out.unshift({ type: 'lex', text: query });
  return out;
}

/**
 * True if `items` is exactly the typed fallback set for `query` — i.e. what every
 * llm.expandQuery failure path returns. The store wrapper uses this to detect a
 * leaked generation failure so it can return an expansions-only form WITHOUT
 * caching it (a transient failure must not poison the cache). Compares against the
 * default (lexical-included) fallback, which is what the store always requests.
 */
export function isFallbackExpansion(items: Queryable[], query: string): boolean {
  const fb = expansionFallback(query);
  return items.length === fb.length
    && items.every((q, i) => q.type === fb[i]!.type && q.text === fb[i]!.text);
}

/**
 * Document to rerank
 */
export type RerankDocument = {
  file: string;
  text: string;
  title?: string;
};

// =============================================================================
// Model Configuration
// =============================================================================

// HuggingFace model URIs for node-llama-cpp
// Format: hf:<user>/<repo>/<file>
const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const DEFAULT_RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const DEFAULT_GENERATE_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

// Local model cache directory
const MODEL_CACHE_DIR = join(homedir(), ".cache", "qmd", "models");

// =============================================================================
// LLM Interface
// =============================================================================

/**
 * Abstract LLM interface - implement this for different backends
 */
export interface LLM {
  /**
   * Get embeddings for text
   */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;

  /**
   * Generate text completion
   */
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;

  /**
   * Check if a model exists/is available
   */
  modelExists(model: string): Promise<ModelInfo>;

  /**
   * Expand a search query into multiple variations for different backends.
   * Returns a list of Queryable objects. `deadline` (BUILD-3a, O1): the
   * caller's MONOTONIC deadline — the remote generation gets a real abort and
   * unabortable local inference is structurally skipped (codex turn-25
   * finding 1: the concrete class carried the option; the interface must
   * expose the contract to typed consumers).
   */
  expandQuery(query: string, options?: { context?: string, includeLexical?: boolean, intent?: string, deadline?: MonoDeadline }): Promise<Queryable[]>;

  /**
   * Rerank documents by relevance to a query
   * Returns list of documents with relevance scores (higher = more relevant)
   */
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;

  /**
   * Dispose of resources
   */
  dispose(): Promise<void>;
}

// =============================================================================
// node-llama-cpp Implementation
// =============================================================================

export type LlamaCppConfig = {
  embedModel?: string;
  generateModel?: string;
  rerankModel?: string;
  modelCacheDir?: string;
  /**
   * Remote embedding server URL (e.g. "http://your-gpu-server:8088").
   * When set, embed() uses HTTP POST to /v1/embeddings instead of local node-llama-cpp.
   * Env: CLAWMEM_EMBED_URL
   */
  remoteEmbedUrl?: string;
  /**
   * API key for remote embedding service (e.g. OpenAI, Voyage AI, Jina AI, Cohere).
   * When set, sent as Authorization: Bearer header with embedding requests.
   * Env: CLAWMEM_EMBED_API_KEY
   */
  remoteEmbedApiKey?: string;
  /**
   * Model name to send with embedding requests (e.g. "text-embedding-3-small",
   * "voyage-4-large", "jina-embeddings-v3", "embed-v4.0").
   * Defaults to "embedding" (llama-server convention).
   * Env: CLAWMEM_EMBED_MODEL
   */
  remoteEmbedModel?: string;
  /**
   * Remote LLM server URL for text generation (e.g. http://localhost:8089).
   * When set, generate() calls /v1/chat/completions instead of local node-llama-cpp.
   */
  remoteLlmUrl?: string;
  /**
   * API key for the remote LLM service (independent of the embed/rerank keys —
   * the LLM endpoint may point at a different authenticated host than embedding).
   * When set, sent as Authorization: Bearer header with chat completion requests.
   * Env: CLAWMEM_LLM_API_KEY
   */
  remoteLlmApiKey?: string;
  /**
   * Remote LLM model name to send with chat completion requests.
   * Env: CLAWMEM_LLM_MODEL
   */
  remoteLlmModel?: string;
  /**
   * Optional top-level reasoning_effort field for Chat Completions endpoints that support it.
   * Example values: none, minimal, low, medium, high, xhigh.
   * Env: CLAWMEM_LLM_REASONING_EFFORT
   */
  remoteLlmReasoningEffort?: string;
  /**
   * Whether to append /no_think to remote LLM prompts.
   * Defaults to true to preserve current behavior with Qwen3-compatible endpoints.
   * Env: CLAWMEM_LLM_NO_THINK
   */
  remoteLlmNoThink?: boolean;
  /**
   * When true, generate() never falls back to in-process node-llama-cpp — a remote
   * failure quietly returns null instead. Set by the v0.29.0 judge factory so a
   * judge-scoped instance can never auto-download or run the stock local model.
   * Per-instance and quiet by design, distinct from the global
   * CLAWMEM_NO_LOCAL_MODELS download block.
   */
  noLocalFallback?: boolean;
  /**
   * Inactivity timeout in ms before unloading contexts (default: 2 minutes, 0 to disable).
   *
   * Per node-llama-cpp lifecycle guidance, we prefer keeping models loaded and only disposing
   * contexts when idle, since contexts (and their sequences) are the heavy per-session objects.
   * @see https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
   */
  inactivityTimeoutMs?: number;
  /**
   * Whether to dispose models on inactivity (default: false).
   *
   * Keeping models loaded avoids repeated VRAM thrash; set to true only if you need aggressive
   * memory reclaim.
   */
  disposeModelsOnInactivity?: boolean;
};

/**
 * LLM implementation using node-llama-cpp
 */
// Default inactivity timeout: 2 minutes
const DEFAULT_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const ALLOWED_REMOTE_LLM_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Exported so run-identity fingerprints record the SAME normalized value the
 * inference layer honors (an unsupported effort normalizes to null here and
 * must not fingerprint as a distinct topology — codex turn-10 finding 4).
 */
export function normalizeRemoteLlmReasoningEffort(value?: string): string | null {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return null;
  if (!ALLOWED_REMOTE_LLM_REASONING_EFFORTS.has(raw)) {
    console.warn(`[clawmem] Ignoring unsupported remoteLlmReasoningEffort=${raw}`);
    return null;
  }
  return raw;
}

/**
 * The no-think normalization getDefaultLlamaCpp applies to
 * CLAWMEM_LLM_NO_THINK — exported for the same identity-fingerprint reason:
 * "1"/"true"/"yes" (and any other non-negative string) all normalize to the
 * SAME runtime behavior and must fingerprint identically.
 */
export function normalizeRemoteLlmNoThink(value?: string): boolean | undefined {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return undefined;
  return !["0", "false", "no", "off"].includes(raw);
}

export function buildRemoteChatCompletionsUrl(remoteLlmUrl: string): string {
  const baseUrl = remoteLlmUrl.replace(/\/+$/, "");
  if (baseUrl.endsWith("/chat/completions")) return baseUrl;
  const endpoint = baseUrl.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
  return `${baseUrl}${endpoint}`;
}

/**
 * v0.41.2: the server root a configured LLM URL names — the three shapes `buildRemoteChatCompletionsUrl` accepts (a
 * root, `…/v1`, or a full `…/chat/completions`) — where llama.cpp serves `/props`, `/tokenize` and `/apply-template`.
 */
export function remoteLlmRoot(remoteLlmUrl: string): string {
  let url = remoteLlmUrl.replace(/\/+$/, "");
  if (url.endsWith("/chat/completions")) url = url.slice(0, -"/chat/completions".length).replace(/\/+$/, "");
  if (url.endsWith("/v1")) url = url.slice(0, -"/v1".length).replace(/\/+$/, "");
  return url;
}

/** Runs of 8+ hex digits — hashes, ids, addresses — tokenize at about one character per token. */
const HEX_RUN = /[0-9a-fA-F]{8,}/g;
/** A digit, an ASCII punctuation mark or symbol, or any non-ASCII character. */
const DENSE_CHAR = /[0-9!-\/:-@\[-`{-~]|[^\x00-\x7F]/u;

/**
 * v0.41.2: a conservative token estimate for a backend with no tokenizer (design §1.2): dense characters — digits,
 * hex-like runs, punctuation, non-ASCII — at 1 character per token (measured: pure hex 1.13, CJK 1.25), the rest at 3
 * (measured: prose 5.7). The factor a caller learns may only raise it.
 */
export function estimateTokens(text: string): number {
  let dense = 0;
  let other = 0;
  const rest = text.replace(HEX_RUN, run => { dense += run.length; return ""; });
  for (const ch of rest) {
    if (DENSE_CHAR.test(ch)) dense++;
    else other++;
  }
  return Math.ceil(dense + other / 3);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** v0.41.2: what the Stop pipeline's observer and summary calls need from an LLM (ClawMem's `LlamaCpp` has all of it). */
export type BudgetLlm = Pick<
  LlamaCpp,
  "activeLlmBackend" | "isConfiguredBackend" | "isBackendAvailable" | "llmCapacity" | "countChatTokens" | "outboundChatContent" | "generateDetailed"
> & Partial<Pick<LlamaCpp, "invalidateOverhead" | "requestIdentity">>;

/**
 * v0.41.2 (codex T11-3, T13-1): what a fresh capacity read says about the server a run or a checkpoint was pinned to.
 * Two strong fingerprints compare. A strong one against a weak read is `unverified`, whatever made the read weak (no
 * answer, an error status, a 404, a body that is not llama.cpp's `/props`): it gives nothing to compare, the server may
 * be the same one, so its progress is kept and the work waits, however long. Only a verified differing fingerprint
 * resets it (or the operator dropping the range). A weak one against a strong read is a `changed` identity (it was
 * never verified); two weak ones compare (the configured URL and model).
 */
export function fingerprintVerdict(
  expected: { fingerprint: string; strength: LlmCapacity["fingerprintStrength"] },
  cap: Pick<LlmCapacity, "fingerprint" | "fingerprintStrength">,
): "same" | "changed" | "unverified" {
  if (expected.strength === "strong" && cap.fingerprintStrength === "weak") return "unverified";
  if (expected.strength !== cap.fingerprintStrength) return "changed";
  return expected.fingerprint === cap.fingerprint ? "same" : "changed";
}

/**
 * The token-budget layer of `llm` (v0.41.2). ClawMem's own `LlamaCpp` is returned as is. An LLM injected through
 * `setDefaultLlamaCpp` that implements only the `generate()` contract gets one `custom` backend with a context of
 * `CLAWMEM_LLM_CONTEXT_TOKENS`, else an assumed 32768, estimated counts, and every reply read as complete: it cannot
 * report a cut, so fits through it are best-effort. At the assumed 32768 most units go in one prompt; the largest the
 * observer takes (100 lines of dense tool output) goes in two windows, and a smaller configured context windows more
 * (codex T12-7).
 */
export function budgetLayerOf(llm: LlamaCpp): BudgetLlm {
  const full = llm as Partial<BudgetLlm>;
  if (typeof full.generateDetailed === "function" && typeof full.llmCapacity === "function" && typeof full.countChatTokens === "function"
    && typeof full.activeLlmBackend === "function") return llm;
  const backend: LlmBackendId = { kind: "local", modelPath: "custom-llm" };
  const configured = Number.parseInt(process.env.CLAWMEM_LLM_CONTEXT_TOKENS ?? "", 10);
  const nCtx = Number.isFinite(configured) && configured > 0 ? configured : 32768;
  return {
    activeLlmBackend: () => backend,
    isConfiguredBackend: (b) => b.kind === "local" && b.modelPath === backend.modelPath,
    isBackendAvailable: (b) => b.kind === "local" && b.modelPath === backend.modelPath,
    llmCapacity: async () => ({
      backend, nCtx, source: Number.isFinite(configured) && configured > 0 ? "configured" : "assumed",
      fingerprint: sha256Hex("custom-llm"), fingerprintStrength: "weak",
    }),
    countChatTokens: async (content) => ({ tokens: estimateTokens(content), method: "estimate", margin: 32 }),
    outboundChatContent: (prompt) => prompt,
    invalidateOverhead: () => { /* estimate counting keeps no measured overhead */ },
    generateDetailed: async (prompt, o) => {
      const r = await llm.generate(prompt, { maxTokens: o.maxTokens, temperature: o.temperature, signal: o.signal });
      return r ? { ok: true, text: r.text, model: r.model, finish: "stop", backend } : { ok: false, reason: "unavailable", backend };
    },
  };
}

export class LlamaCpp implements LLM {
  private llama: Llama | null = null;
  private embedModel: LlamaModel | null = null;
  private embedContext: LlamaEmbeddingContext | null = null;
  private generateModel: LlamaModel | null = null;
  private rerankModel: LlamaModel | null = null;
  private rerankContext: Awaited<ReturnType<LlamaModel["createRankingContext"]>> | null = null;

  private embedModelUri: string;
  private generateModelUri: string;
  private rerankModelUri: string;
  private modelCacheDir: string;
  private remoteEmbedUrl: string | null;
  private remoteEmbedApiKey: string | null;
  private remoteEmbedModel: string;
  private remoteLlmUrl: string | null;
  private remoteLlmApiKey: string | null;
  private remoteLlmModel: string;
  private remoteLlmReasoningEffort: string | null;
  private remoteLlmNoThink: boolean;
  private noLocalFallback: boolean;

  // Ensure we don't load the same model concurrently (which can allocate duplicate VRAM).
  private embedModelLoadPromise: Promise<LlamaModel> | null = null;
  private generateModelLoadPromise: Promise<LlamaModel> | null = null;
  private rerankModelLoadPromise: Promise<LlamaModel> | null = null;

  // Inactivity timer for auto-unloading models
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeoutMs: number;
  private disposeModelsOnInactivity: boolean;

  // Track disposal state to prevent double-dispose
  private disposed = false;

  // Cooldown-based down-cache for remote services.
  // Timestamps (ms since epoch) until which we skip remote and use local fallback.
  // Resets after cooldown expires — one network hiccup doesn't permanently disable GPU.
  private remoteEmbedDownUntil = 0;
  private remoteLlmDownUntil = 0;
  private remoteEmbedFallbackNotifiedUntil = 0;
  private remoteLlmFallbackNotifiedUntil = 0;
  private static readonly REMOTE_COOLDOWN_MS = 60_000; // 60s cooldown on transport failure

  // HTTP-shape failure accounting for the self-hosted remote lanes (issue #24)
  // — see noteRemoteHttpError.
  private remoteLlmHttpErrorStreak = 0;
  private remoteEmbedHttpErrorStreak = 0;
  /** Consecutive non-2xx (non-429) responses that trip the down-cache. */
  private static readonly REMOTE_HTTP_TRIP_STREAK = 3;
  /**
   * Statuses a correctly-routed OpenAI-compatible endpoint cannot return for
   * these POSTs (method not allowed / not implemented) — the signature of an
   * unrelated service squatting the port. Instant trip. 404 is deliberately
   * NOT here (codex turn-1 finding 1): cloud/gateway endpoints return 404 for
   * an unknown model or deployment while the route itself is correct, so a
   * mis-set CLAWMEM_LLM_MODEL must not instantly cost the lane — 404 rides
   * the consecutive-failure streak instead (a genuinely squatted port 404s
   * every call and still trips within REMOTE_HTTP_TRIP_STREAK calls).
   */
  private static readonly REMOTE_HTTP_INSTANT_TRIP = new Set([405, 501]);

  // ── v0.41.2 (BACKLOG 68.5): the token-budget layer the Stop pipeline's observer and summary calls use ──────────
  /** Scales `estimateTokens` up when a reply's own count shows it was low; it never comes down (design §1.2). */
  private estimateFactor = 1;
  /** One validated oversize answer per endpoint is exempt from the HTTP-error streak; a repeat that is not smaller is not. */
  private oversizeExemption: { nPromptTokens: number; at: number } | null = null;
  /** Per process: whether the remote serves `/apply-template` and `/tokenize` (null = not yet known). */
  private templateServed: boolean | null = null;
  private tokenizeServed: boolean | null = null;
  /** The chat-template overhead measured on a `/tokenize`-only remote, by fingerprint (in-process copy). */
  private measuredOverhead: { fingerprint: string; overhead: number; at: number } | null = null;
  /** The doctor's capacity read (10 min); the Stop pipeline always reads fresh. */
  private capacityForDoctor: { at: number; cap: LlmCapacity } | null = null;
  /** Once per process: a remote reply the context (not `max_tokens`) cut, through the legacy `generate()`. */
  private contextCutWarned = false;
  /** Once per process: a remote reply with no `finish_reason`, through `generateDetailed()`. */
  private noFinishReasonWarned = false;
  private static readonly OVERSIZE_EXEMPTION_TTL_MS = 10 * 60_000;
  private static readonly AUX_REQUEST_MAX_MS = 2_000;
  private static readonly CAPACITY_CACHE_MS = 10 * 60_000;
  private static readonly ASSUMED_CONTEXT_TOKENS = 4096;
  /** The context the in-process fallback creates for a fitted call (min with the model's own training context). */
  private static readonly LOCAL_FIT_CONTEXT_TOKENS = 8192;
  private static readonly OVERHEAD_TTL_MS = 24 * 60 * 60_000;

  constructor(config: LlamaCppConfig = {}) {
    this.embedModelUri = config.embedModel || DEFAULT_EMBED_MODEL;
    this.generateModelUri = config.generateModel || DEFAULT_GENERATE_MODEL;
    this.rerankModelUri = config.rerankModel || DEFAULT_RERANK_MODEL;
    this.modelCacheDir = config.modelCacheDir || MODEL_CACHE_DIR;
    this.remoteEmbedUrl = config.remoteEmbedUrl || null;
    this.remoteEmbedApiKey = config.remoteEmbedApiKey || null;
    this.remoteEmbedModel = config.remoteEmbedModel || "embedding";
    this.remoteLlmUrl = config.remoteLlmUrl || null;
    this.remoteLlmApiKey = config.remoteLlmApiKey || null;
    const normalizedRemoteLlmModel = config.remoteLlmModel?.trim();
    this.remoteLlmModel = normalizedRemoteLlmModel || "qwen3";
    this.remoteLlmReasoningEffort = normalizeRemoteLlmReasoningEffort(config.remoteLlmReasoningEffort);
    this.remoteLlmNoThink = config.remoteLlmNoThink ?? true;
    this.noLocalFallback = config.noLocalFallback ?? false;
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.disposeModelsOnInactivity = config.disposeModelsOnInactivity ?? false;
  }

  /**
   * Reset the inactivity timer. Called after each model operation.
   * When timer fires, models are unloaded to free memory.
   */
  private touchActivity(): void {
    // Clear existing timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Only set timer if we have disposable contexts and timeout is enabled
    if (this.inactivityTimeoutMs > 0 && this.hasLoadedContexts()) {
      this.inactivityTimer = setTimeout(() => {
        this.unloadIdleResources().catch(err => {
          console.error("Error unloading idle resources:", err);
        });
      }, this.inactivityTimeoutMs);
      // Don't keep process alive just for this timer
      this.inactivityTimer.unref();
    }
  }

  /**
   * Check if any contexts are currently loaded (and therefore worth unloading on inactivity).
   */
  private hasLoadedContexts(): boolean {
    return !!this.embedContext || !!this.rerankContext;
  }

  /**
   * Unload idle resources but keep the instance alive for future use.
   *
   * By default, this disposes contexts (and their dependent sequences), while keeping models loaded.
   * This matches the intended lifecycle: model → context → sequence, where contexts are per-session.
   */
  async unloadIdleResources(): Promise<void> {
    // Don't unload if already disposed
    if (this.disposed) {
      return;
    }

    // Clear timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Dispose contexts first
    if (this.embedContext) {
      await this.embedContext.dispose();
      this.embedContext = null;
    }
    if (this.rerankContext) {
      await this.rerankContext.dispose();
      this.rerankContext = null;
    }

    // Optionally dispose models too (opt-in)
    if (this.disposeModelsOnInactivity) {
      if (this.embedModel) {
        await this.embedModel.dispose();
        this.embedModel = null;
      }
      if (this.generateModel) {
        await this.generateModel.dispose();
        this.generateModel = null;
      }
      if (this.rerankModel) {
        await this.rerankModel.dispose();
        this.rerankModel = null;
      }
      // Reset load promises so models can be reloaded later
      this.embedModelLoadPromise = null;
      this.generateModelLoadPromise = null;
      this.rerankModelLoadPromise = null;
    }

    // Note: We keep llama instance alive - it's lightweight
  }

  /**
   * Ensure model cache directory exists
   */
  private ensureModelCacheDir(): void {
    if (!existsSync(this.modelCacheDir)) {
      mkdirSync(this.modelCacheDir, { recursive: true });
    }
  }

  /**
   * Initialize the llama instance (lazy)
   */
  private async ensureLlama(): Promise<Llama> {
    if (!this.llama) {
      const { getLlama, LlamaLogLevel } = await getNodeLlamaCpp();
      this.llama = await getLlama({ logLevel: LlamaLogLevel.error });
    }
    return this.llama;
  }

  /**
   * Resolve a model URI to a local path, downloading if needed.
   * Set CLAWMEM_NO_LOCAL_MODELS=true to prevent auto-downloads (GPU-only mode).
   */
  private async resolveModel(modelUri: string): Promise<string> {
    if (process.env.CLAWMEM_NO_LOCAL_MODELS === "true") {
      throw new Error(`Local model download blocked (CLAWMEM_NO_LOCAL_MODELS=true). Model: ${modelUri}. Set CLAWMEM_EMBED_URL / CLAWMEM_LLM_URL / CLAWMEM_RERANK_URL to use GPU endpoints.`);
    }
    this.ensureModelCacheDir();
    const { resolveModelFile } = await getNodeLlamaCpp();
    return await resolveModelFile(modelUri, this.modelCacheDir);
  }

  /**
   * Load embedding model (lazy) — used for in-process CPU fallback when no remote embed server.
   * Auto-downloads EmbeddingGemma-300M from HuggingFace on first use (~300MB).
   */
  private async ensureEmbedModel(): Promise<LlamaModel> {
    if (this.embedModel) {
      return this.embedModel;
    }
    if (this.embedModelLoadPromise) {
      return await this.embedModelLoadPromise;
    }

    this.embedModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.embedModelUri);
      const model = await llama.loadModel({ modelPath });
      this.embedModel = model;
      this.touchActivity();
      return model;
    })();

    try {
      return await this.embedModelLoadPromise;
    } finally {
      this.embedModelLoadPromise = null;
    }
  }

  /**
   * Get or create a single embedding context (lazy).
   */
  private async ensureEmbedContext(): Promise<LlamaEmbeddingContext> {
    if (this.embedContext) {
      this.touchActivity();
      return this.embedContext;
    }
    const model = await this.ensureEmbedModel();
    this.embedContext = await model.createEmbeddingContext();
    this.touchActivity();
    return this.embedContext;
  }

  /**
   * Load generation model (lazy) - context is created fresh per call
   */
  private async ensureGenerateModel(): Promise<LlamaModel> {
    if (!this.generateModel) {
      if (this.generateModelLoadPromise) {
        return await this.generateModelLoadPromise;
      }

      this.generateModelLoadPromise = (async () => {
        const llama = await this.ensureLlama();
        const modelPath = await this.resolveModel(this.generateModelUri);
        const model = await llama.loadModel({ modelPath });
        this.generateModel = model;
        return model;
      })();

      try {
        await this.generateModelLoadPromise;
      } finally {
        this.generateModelLoadPromise = null;
      }
    }
    this.touchActivity();
    if (!this.generateModel) {
      throw new Error("Generate model not loaded");
    }
    return this.generateModel;
  }

  /**
   * Load rerank model (lazy)
   */
  private async ensureRerankModel(): Promise<LlamaModel> {
    if (this.rerankModel) {
      return this.rerankModel;
    }
    if (this.rerankModelLoadPromise) {
      return await this.rerankModelLoadPromise;
    }

    this.rerankModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.rerankModelUri);
      const model = await llama.loadModel({ modelPath });
      this.rerankModel = model;
      return model;
    })();

    try {
      return await this.rerankModelLoadPromise;
    } finally {
      this.rerankModelLoadPromise = null;
    }
  }

  /**
   * Load rerank context (lazy). Context can be disposed and recreated without reloading the model.
   */
  private async ensureRerankContext(): Promise<Awaited<ReturnType<LlamaModel["createRankingContext"]>>> {
    if (!this.rerankContext) {
      const model = await this.ensureRerankModel();
      this.rerankContext = await model.createRankingContext();
    }
    this.touchActivity();
    return this.rerankContext;
  }

  // ==========================================================================
  // Tokenization
  // ==========================================================================

  /**
   * Tokenize text using the generate model's tokenizer
   * Returns tokenizer tokens (opaque type from node-llama-cpp)
   */
  async tokenize(text: string): Promise<readonly LlamaToken[]> {
    const model = await this.ensureGenerateModel();
    return model.tokenize(text);
  }

  /**
   * Count tokens in text using the generate model's tokenizer
   */
  async countTokens(text: string): Promise<number> {
    const tokens = await this.tokenize(text);
    return tokens.length;
  }

  /**
   * Detokenize token IDs back to text
   */
  async detokenize(tokens: readonly LlamaToken[]): Promise<string> {
    const model = await this.ensureGenerateModel();
    return model.detokenize(tokens);
  }

  // ==========================================================================
  // Core API methods
  // ==========================================================================

  async embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    // Remote server or cloud API — preferred path
    if (this.remoteEmbedUrl && !this.isRemoteEmbedDown()) {
      const extraParams = this.getCloudEmbedParams(!!options.isQuery);
      const result = await this.embedRemote(text, extraParams, undefined, options.signal);
      if (result) return result;
      // Cloud providers don't fall back — if API key is set, the user chose cloud
      if (this.isCloudEmbedding()) return null;
      // HTTP/API errors mean the endpoint is reachable; only transport
      // failures set cooldown and fall through to local fallback.
      if (!this.isRemoteEmbedDown()) return null;
      // Transport failure already set cooldown in embedRemote — fall through
    }

    // Remote is in cooldown or was never configured — try local fallback
    if (this.remoteEmbedUrl && this.isRemoteEmbedDown()) {
      if (process.env.CLAWMEM_NO_LOCAL_MODELS === "true") return null;
      // Medium-fix (B4): a deadline-bounded caller (query path, signal set)
      // cannot afford a local model load/download during a remote cooldown —
      // embedLocal ignores the abort signal and can run for seconds/minutes.
      // Skip the local fallback and let the caller degrade (searchVec → [] →
      // FTS). Pure-local mode (no remoteEmbedUrl) never enters this branch, so
      // local-only deployments still embed.
      if (options.signal) return null;
      this.noteRemoteFallback(
        "embed",
        this.isLoopbackUrl(this.remoteEmbedUrl)
          ? "[embed] Local embedding endpoint unavailable; using in-process fallback during cooldown"
          : "[embed] Remote embed in cooldown, using in-process fallback"
      );
    }

    // In-process fallback via node-llama-cpp (auto-downloads EmbeddingGemma on first use)
    return this.embedLocal(text);
  }

  /**
   * Batch embed multiple texts efficiently.
   * Remote: single HTTP request with up to 50 texts.
   * Local: sequential via node-llama-cpp embedding context.
   */
  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];

    // Remote server or cloud API
    if (this.remoteEmbedUrl && !this.isRemoteEmbedDown()) {
      const extraParams = this.getCloudEmbedParams(false);
      const results = await this.embedRemoteBatch(texts, extraParams);
      // If we got at least one result, remote is working
      if (results.some(r => r !== null)) return results;
      // Cloud providers don't fall back
      if (this.isCloudEmbedding()) return results;
      // HTTP/API errors mean the endpoint is reachable; only transport
      // failures set cooldown and fall through to local fallback.
      if (!this.isRemoteEmbedDown()) return results;
      // Transport failure already set cooldown in embedRemoteBatch — fall through
    }

    // Remote is in cooldown or was never configured — try local fallback
    if (this.remoteEmbedUrl && this.isRemoteEmbedDown()) {
      if (process.env.CLAWMEM_NO_LOCAL_MODELS === "true") return texts.map(() => null);
      this.noteRemoteFallback(
        "embed",
        this.isLoopbackUrl(this.remoteEmbedUrl)
          ? "[embed] Local embedding endpoint unavailable; using in-process fallback during cooldown"
          : "[embed] Remote embed in cooldown, using in-process fallback"
      );
    }

    // In-process fallback via node-llama-cpp
    return this.embedLocalBatch(texts);
  }

  /** In-process embedding via node-llama-cpp with truncation guard */
  private async embedLocal(text: string): Promise<EmbeddingResult | null> {
    try {
      const context = await this.ensureEmbedContext();
      const safeText = this.truncateForLocalEmbed(text);
      const embedding = await context.getEmbeddingFor(safeText);
      return {
        embedding: Array.from(embedding.vector),
        model: this.embedModelUri,
      };
    } catch (error) {
      console.error("[embed] Local embedding error:", error);
      return null;
    }
  }

  /** In-process batch embedding via node-llama-cpp with truncation guard */
  private async embedLocalBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    try {
      const context = await this.ensureEmbedContext();
      const results: (EmbeddingResult | null)[] = [];
      for (const text of texts) {
        try {
          const safeText = this.truncateForLocalEmbed(text);
          const embedding = await context.getEmbeddingFor(safeText);
          results.push({ embedding: Array.from(embedding.vector), model: this.embedModelUri });
        } catch (err) {
          console.error("[embed] Local batch embedding error:", err);
          results.push(null);
        }
      }
      return results;
    } catch (error) {
      console.error("[embed] Failed to initialize local embedding:", error);
      return texts.map(() => null);
    }
  }

  /** Truncate text to maxRemoteEmbedChars for local in-process embedding (prevents context overflow crash) */
  private truncateForLocalEmbed(text: string): string {
    if (text.length <= this.maxRemoteEmbedChars) return text;
    return text.slice(0, this.maxRemoteEmbedChars);
  }

  // ---------- Remote failure classification ----------

  /**
   * Classify whether an error is a transport failure (server unreachable)
   * vs an HTTP error (server received request but rejected it) or abort.
   * Only transport failures should trigger the down-cache cooldown.
   */
  private isTransportError(error: unknown): boolean {
    if (error instanceof TypeError && String(error.message).includes("fetch")) return true; // fetch network error
    const code = (error as any)?.code || (error as any)?.cause?.code;
    if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND" ||
        code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ECONNRESET" ||
        code === "UND_ERR_CONNECT_TIMEOUT") return true;
    const msg = String((error as any)?.message || "").toLowerCase();
    if (msg.includes("econnrefused") || msg.includes("etimedout") || msg.includes("enotfound") ||
        msg.includes("ehostunreach") || msg.includes("enetunreach") ||
        msg.includes("unable to connect") || msg.includes("connectionrefused") ||
        msg.includes("connection refused")) return true;
    return false;
  }

  private isAbortError(error: unknown): boolean {
    return (error instanceof DOMException && error.name === "AbortError") ||
           (error as any)?.name === "AbortError";
  }

  private isRemoteLlmDown(): boolean {
    return epochMs(epochNow()) < this.remoteLlmDownUntil;
  }

  private isRemoteEmbedDown(): boolean {
    return epochMs(epochNow()) < this.remoteEmbedDownUntil;
  }

  private isLoopbackUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    } catch {
      const lower = url.toLowerCase();
      return lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("[::1]");
    }
  }

  private noteRemoteFallback(kind: "embed" | "llm", message: string): void {
    const now = epochMs(epochNow());
    if (kind === "embed") {
      if (now < this.remoteEmbedFallbackNotifiedUntil) return;
      this.remoteEmbedFallbackNotifiedUntil = this.remoteEmbedDownUntil || (now + LlamaCpp.REMOTE_COOLDOWN_MS);
      if (this.isLoopbackUrl(this.remoteEmbedUrl)) console.warn(message);
      else console.error(message);
      return;
    }

    if (now < this.remoteLlmFallbackNotifiedUntil) return;
    this.remoteLlmFallbackNotifiedUntil = this.remoteLlmDownUntil || (now + LlamaCpp.REMOTE_COOLDOWN_MS);
    if (this.isLoopbackUrl(this.remoteLlmUrl)) console.warn(message);
    else console.error(message);
  }

  private markRemoteLlmDown(): void {
    this.remoteLlmDownUntil = epochMs(epochNow()) + LlamaCpp.REMOTE_COOLDOWN_MS;
    this.remoteLlmFallbackNotifiedUntil = 0;
    this.noteRemoteFallback(
      "llm",
      this.isLoopbackUrl(this.remoteLlmUrl)
        ? "[generate] Local LLM endpoint unavailable, cooldown 60s before retry"
        : "[generate] Remote LLM unreachable, cooldown 60s before retry"
    );
  }

  private markRemoteEmbedDown(): void {
    this.remoteEmbedDownUntil = epochMs(epochNow()) + LlamaCpp.REMOTE_COOLDOWN_MS;
    this.remoteEmbedFallbackNotifiedUntil = 0;
    this.noteRemoteFallback(
      "embed",
      this.isLoopbackUrl(this.remoteEmbedUrl)
        ? "[embed] Local embedding endpoint unavailable, cooldown 60s before retry"
        : "[embed] Remote embed server unreachable, cooldown 60s before retry"
    );
  }

  /**
   * HTTP-level (non-2xx) failure accounting for the self-hosted remote lanes
   * (issue #24). One HTTP error is a reachable server misbehaving — never a
   * reason to abandon the GPU lane. But a port squatted by an unrelated
   * service answers HTTP errors FOREVER, and through v0.36.0 that state never
   * tripped the down-cache, so the local fallback never engaged and enrichment
   * failed silently on every call while indexing kept reporting success. Two
   * triggers flip the lane into the normal 60s cooldown (after which the
   * existing fallback + notify-once machinery takes over):
   *   - an endpoint-shape status (REMOTE_HTTP_INSTANT_TRIP) that a correctly
   *     routed endpoint cannot return — instant, or
   *   - REMOTE_HTTP_TRIP_STREAK consecutive non-2xx responses (429 is excluded
   *     by the callers — rate limiting is a healthy endpoint).
   * The cooldown self-heals: a real server that recovers gets its lane back on
   * the first attempt after expiry. Known limit: through `generate()` and the
   * embed lane, a squatter that answers 200 with a body that is not a
   * completion is not counted (the parse failure surfaces in the callers'
   * catch as a logged error); non-2xx is the observed squatted-port signature
   * and the conservative trigger. `generateDetailed()` (v0.41.2) does count a
   * 200 without a completion choice.
   */
  private noteRemoteHttpError(kind: "embed" | "llm", status: number, statusText: string): void {
    // Idempotent under concurrency (codex turn-1 finding 2): several requests
    // can pass the pre-fetch cooldown check together and each come back with
    // an HTTP error. The FIRST trip owns the transition — once the lane is
    // already down, later in-flight responses are swallowed (streak cleared,
    // no second actionable line, and notifiedUntil is NOT reset again, which
    // would defeat the notify-once contract downstream).
    const alreadyDown = kind === "llm" ? this.isRemoteLlmDown() : this.isRemoteEmbedDown();
    if (alreadyDown) {
      if (kind === "llm") this.remoteLlmHttpErrorStreak = 0;
      else this.remoteEmbedHttpErrorStreak = 0;
      return;
    }
    const streak = kind === "llm" ? ++this.remoteLlmHttpErrorStreak : ++this.remoteEmbedHttpErrorStreak;
    const instant = LlamaCpp.REMOTE_HTTP_INSTANT_TRIP.has(status);
    if (!instant && streak < LlamaCpp.REMOTE_HTTP_TRIP_STREAK) return;
    const url = kind === "llm" ? this.remoteLlmUrl : this.remoteEmbedUrl;
    const envVar = kind === "llm" ? "CLAWMEM_LLM_URL" : "CLAWMEM_EMBED_URL";
    const tag = kind === "llm" ? "[generate]" : "[embed]";
    const api = kind === "llm" ? "chat-completions" : "embeddings";
    const reason = instant
      ? `HTTP ${status}${statusText ? ` ${statusText}` : ""} — a correctly-routed ${api} endpoint never returns this status; another service is likely listening at that address`
      : `${streak} consecutive HTTP error(s) (last: ${status}${statusText ? ` ${statusText}` : ""}) — the endpoint is reachable but persistently refusing this API (squatted port, wrong route, or a misconfigured model name)`;
    console.error(
      `${tag} Remote endpoint at ${url} answers HTTP but not the ${api} API: ${reason}. ` +
      `Treating it as down for 60s so the fallback path engages — check ${envVar}.`
    );
    if (kind === "llm") {
      this.remoteLlmHttpErrorStreak = 0;
      this.remoteLlmDownUntil = epochMs(epochNow()) + LlamaCpp.REMOTE_COOLDOWN_MS;
      this.remoteLlmFallbackNotifiedUntil = 0;
    } else {
      this.remoteEmbedHttpErrorStreak = 0;
      this.remoteEmbedDownUntil = epochMs(epochNow()) + LlamaCpp.REMOTE_COOLDOWN_MS;
      this.remoteEmbedFallbackNotifiedUntil = 0;
    }
  }

  /**
   * One-shot shape probe for a remote chat-completions endpoint (doctor
   * section 12; extracted so the probe itself is directly testable against
   * real fixture servers — codex turn-1 finding 4). Sends a minimal
   * completion and classifies the outcome. Honors the same no-think policy
   * normalization the runtime uses (codex turn-1 finding 3): an endpoint
   * configured with CLAWMEM_LLM_NO_THINK=false must not be probed with a
   * Qwen-specific control token it may reject.
   */
  static async probeChatCompletionsShape(opts: {
    url: string;
    apiKey?: string;
    model?: string;
    noThink?: boolean;
    timeoutMs?: number;
  }): Promise<
    | { status: "ok"; model: string }
    | { status: "http"; httpStatus: number }
    | { status: "shape"; detail: string }
    | { status: "transport"; detail: string }
  > {
    const endpoint = buildRemoteChatCompletionsUrl(opts.url);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
    const noThink = opts.noThink ?? true;
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: opts.model?.trim() || "qwen3",
          messages: [{ role: "user", content: noThink ? "Reply with OK /no_think" : "Reply with OK" }],
          max_tokens: 8,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (!resp.ok) return { status: "http", httpStatus: resp.status };
      const data = await resp.json().catch(() => null) as {
        choices?: { message?: { content?: unknown } }[];
        model?: string;
      } | null;
      // Deep shape check (codex turn-1 finding 4): {"choices":[]} or a choices
      // array without a string message.content proves nothing about the API.
      if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
        return { status: "shape", detail: "no choices array (or it is empty)" };
      }
      if (typeof data.choices[0]?.message?.content !== "string") {
        return { status: "shape", detail: "choices[0].message.content is not a string" };
      }
      return { status: "ok", model: data.model || "unnamed" };
    } catch (err) {
      return { status: "transport", detail: (err as Error).message };
    }
  }

  // ---------- Remote embedding (GPU server or cloud API via /v1/embeddings) ----------

  // Default: 6000 chars for EmbeddingGemma-300M (2048-token context).
  // At ~3 chars/token (mixed code+prose), 6000 chars ≈ 2000 tokens — safely under 2048.
  // Pure code tokenizes at ~2 chars/token (3000 tokens) but chunks are pre-split
  // at 900 tokens so this only applies to the formatting wrapper.
  // Override via CLAWMEM_EMBED_MAX_CHARS (e.g. 1100 for granite-278m, 512-token context).
  // Cloud providers (API key set) skip truncation entirely.
  private readonly maxRemoteEmbedChars: number =
    parseInt(process.env.CLAWMEM_EMBED_MAX_CHARS || "6000", 10);

  private isCloudEmbedding(): boolean {
    return !!this.remoteEmbedApiKey;
  }

  /** Detect cloud provider from embed URL and return provider-specific request params */
  private getCloudEmbedParams(isQuery: boolean): Record<string, unknown> {
    if (!this.isCloudEmbedding() || !this.remoteEmbedUrl) return {};
    const url = this.remoteEmbedUrl.toLowerCase();
    if (url.includes("jina.ai")) {
      return { task: isQuery ? "retrieval.query" : "retrieval.passage", truncate: true };
    }
    if (url.includes("voyageai.com")) {
      return { input_type: isQuery ? "query" : "document" };
    }
    if (url.includes("cohere.")) {
      return { input_type: isQuery ? "search_query" : "search_document", truncate: "END" };
    }
    if (url.includes("openai.com")) {
      const dims = parseInt(process.env.CLAWMEM_EMBED_DIMENSIONS || "", 10);
      return dims > 0 ? { dimensions: dims } : {};
    }
    return {};
  }

  private getEmbedHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.remoteEmbedApiKey) {
      headers["Authorization"] = `Bearer ${this.remoteEmbedApiKey}`;
    }
    return headers;
  }

  private getLlmHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.remoteLlmApiKey) {
      headers["Authorization"] = `Bearer ${this.remoteLlmApiKey}`;
    }
    return headers;
  }

  private truncateForEmbed(text: string): string {
    // Cloud providers handle their own context window limits
    if (this.isCloudEmbedding()) return text;
    return text.length > this.maxRemoteEmbedChars
      ? text.slice(0, this.maxRemoteEmbedChars) : text;
  }

  /** Parse Retry-After header (seconds or HTTP-date) into milliseconds to wait */
  private parseRetryAfter(resp: Response): number | null {
    const header = resp.headers.get("retry-after");
    if (!header) return null;
    const secs = parseInt(header, 10);
    if (!isNaN(secs)) return secs * 1000;
    const date = Date.parse(header);
    if (!isNaN(date)) return Math.max(0, date - epochMs(epochNow()));
    return null;
  }

  /** Add ±25% jitter to a delay to prevent synchronized retries */
  private jitter(delayMs: number): number {
    return Math.floor(delayMs * (0.75 + Math.random() * 0.5));
  }

  /**
   * Sleep for `ms`, resolving early if `signal` aborts. Returns true if the
   * wait was cut short by an abort (caller should stop retrying), false if it
   * slept the full duration. Without this, a 429 backoff (up to 30s) would run
   * to completion even after the caller's deadline elapsed (B4).
   */
  private async abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return true;
    if (!signal) {
      await new Promise(r => setTimeout(r, ms));
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      const onAbort = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async embedRemote(text: string, extraParams: Record<string, unknown> = {}, retries = 5, signal?: AbortSignal): Promise<EmbeddingResult | null> {
    if (this.isRemoteEmbedDown()) return null;
    const input = this.truncateForEmbed(text);
    for (let attempt = 0; attempt < retries; attempt++) {
      if (signal?.aborted) return null; // caller deadline already elapsed — do not start another attempt
      try {
        const body: Record<string, unknown> = { input, model: this.remoteEmbedModel, ...extraParams };
        const resp = await fetch(`${this.remoteEmbedUrl}/v1/embeddings`, {
          method: "POST",
          headers: this.getEmbedHeaders(),
          body: JSON.stringify(body),
          signal,
        });
        if (resp.status === 429) {
          const retryAfter = this.parseRetryAfter(resp);
          const delay = retryAfter ?? Math.min(1000 * 2 ** attempt, 30000);
          const jittered = this.jitter(delay);
          console.error(`Remote embed rate-limited, retry ${attempt + 1}/${retries} in ${jittered}ms`);
          if (await this.abortableDelay(jittered, signal)) return null; // deadline elapsed during backoff
          continue;
        }
        if (!resp.ok) {
          console.error(`Remote embed HTTP ${resp.status}: ${await resp.text()}`);
          // Cloud lanes (API key set) never fall back by design — an auth/quota
          // HTTP error must stay a per-call error, not flip the vault onto a
          // different local model mid-run. The squatted-port trip (issue #24)
          // applies to the self-hosted lane only.
          if (!this.isCloudEmbedding()) this.noteRemoteHttpError("embed", resp.status, resp.statusText);
          return null;
        }
        this.remoteEmbedHttpErrorStreak = 0;
        const data = await resp.json() as {
          data: { embedding: number[] }[];
          model?: string;
        };
        return {
          embedding: data.data[0]!.embedding,
          model: data.model || this.remoteEmbedUrl!,
        };
      } catch (error) {
        // An abort/timeout is an intentional caller-driven cancellation (the
        // query-path deadline), NOT a transport failure — do not trip the 60s
        // remote-down cooldown, which would needlessly force local fallback.
        const name = (error as { name?: string })?.name;
        if (signal?.aborted || name === "AbortError" || name === "TimeoutError") {
          return null;
        }
        if (this.isTransportError(error)) {
          this.markRemoteEmbedDown();
        } else {
          console.error("[embed] Remote embed error:", error);
        }
        return null;
      }
    }
    console.error("[embed] Remote embed: max retries exceeded (rate limit)");
    return null;
  }

  /** Token usage from the last successful batch embed call (for adaptive pacing) */
  lastBatchTokens = 0;

  private async embedRemoteBatch(texts: string[], extraParams: Record<string, unknown> = {}, retries = 3): Promise<(EmbeddingResult | null)[]> {
    if (this.isRemoteEmbedDown()) return texts.map(() => null);
    const truncated = texts.map(t => this.truncateForEmbed(t));
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const body: Record<string, unknown> = { input: truncated, model: this.remoteEmbedModel, ...extraParams };
        const resp = await fetch(`${this.remoteEmbedUrl}/v1/embeddings`, {
          method: "POST",
          headers: this.getEmbedHeaders(),
          body: JSON.stringify(body),
        });
        if (resp.status === 429) {
          const retryAfter = this.parseRetryAfter(resp);
          const delay = retryAfter ?? Math.min(5000 * 2 ** attempt, 60000);
          const jittered = this.jitter(delay);
          console.error(`Remote batch embed rate-limited, retry ${attempt + 1}/${retries} in ${(jittered / 1000).toFixed(1)}s${retryAfter ? ` (Retry-After: ${Math.ceil(retryAfter / 1000)}s)` : ""}`);
          await new Promise(r => setTimeout(r, jittered));
          continue;
        }
        if (!resp.ok) {
          console.error(`Remote batch embed HTTP ${resp.status}: ${await resp.text()}`);
          // Same self-hosted-lane trip as embedRemote (issue #24); cloud lanes exempt.
          if (!this.isCloudEmbedding()) this.noteRemoteHttpError("embed", resp.status, resp.statusText);
          return texts.map(() => null);
        }
        this.remoteEmbedHttpErrorStreak = 0;
        const data = await resp.json() as {
          data: { embedding: number[]; index: number }[];
          model?: string;
          usage?: { total_tokens?: number; prompt_tokens?: number };
        };
        this.lastBatchTokens = data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0;
        const modelName = data.model || this.remoteEmbedUrl!;
        const results: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);
        for (const item of data.data) {
          results[item.index] = { embedding: item.embedding, model: modelName };
        }
        return results;
      } catch (error) {
        if (this.isTransportError(error)) {
          this.markRemoteEmbedDown();
        } else {
          console.error("[embed] Remote batch embed error:", error);
        }
        return texts.map(() => null);
      }
    }
    console.error("[embed] Remote batch embed: max retries exceeded (rate limit)");
    return texts.map(() => null);
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult | null> {
    const maxTokens = options.maxTokens ?? 150;
    const temperature = options.temperature ?? 0;

    // Remote LLM server (GPU) — preferred path
    if (this.remoteLlmUrl && !this.isRemoteLlmDown()) {
      const result = await this.generateRemote(prompt, maxTokens, temperature, options.signal);
      if (result) return result;
      // If remote failed but NOT transport error (HTTP 400/500, abort), don't fall through
      if (!this.isRemoteLlmDown()) return null;
      // Transport failure set cooldown — fall through to local
    }

    // Judge-scoped instances never run local inference (v0.29.0) — quiet null,
    // typed diagnostics live at the judge layer.
    if (this.noLocalFallback) return null;

    // Remote is in cooldown or was never configured — try local fallback
    if (this.remoteLlmUrl && this.isRemoteLlmDown()) {
      if (process.env.CLAWMEM_NO_LOCAL_MODELS === "true") return null;
      this.noteRemoteFallback(
        "llm",
        this.isLoopbackUrl(this.remoteLlmUrl)
          ? "[generate] Local LLM endpoint unavailable; using in-process generation during cooldown"
          : "[generate] Remote LLM in cooldown, falling back to in-process generation"
      );
    }

    // Local fallback via node-llama-cpp (CPU)
    await this.ensureGenerateModel();

    const context = await this.generateModel!.createContext();
    const sequence = context.getSequence();
    const { LlamaChatSession } = await getNodeLlamaCpp();
    const session = new LlamaChatSession({ contextSequence: sequence });

    let result = "";
    try {
      await session.prompt(prompt, {
        maxTokens,
        temperature,
        signal: options.signal,
        stopOnAbortSignal: true,
        onTextChunk: (text) => {
          result += text;
        },
      });

      return {
        text: result,
        model: this.generateModelUri,
        done: true,
      };
    } finally {
      await context.dispose();
    }
  }

  /**
   * Append ` /no_think` only when the prompt does not already carry it, so a prompt written
   * with an inline suffix (for the local fallback, which gets the prompt verbatim) is not sent
   * a doubled control token.
   */
  private applyNoThinkSuffix(prompt: string): string {
    if (!this.remoteLlmNoThink) return prompt;
    // Detect the control token as a standalone token ANYWHERE, not only terminally: the
    // query-expansion prompt deliberately leads with `/no_think`, so a suffix-only test
    // still doubled it. Requiring a line/whitespace boundary on both sides keeps a path
    // fragment like `foo/no_think` from counting as the control token.
    return /(^|\s)\/no_think(\s|$)/.test(prompt) ? prompt : `${prompt} /no_think`;
  }

  private async generateRemote(
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): Promise<GenerateResult | null> {
    // Re-check: concurrent call may have set cooldown while we were awaited
    if (this.isRemoteLlmDown()) return null;
    try {
      const body = this.buildRemoteChatBody(prompt, maxTokens, temperature);
      const resp = await fetch(buildRemoteChatCompletionsUrl(this.remoteLlmUrl!), {
        method: "POST",
        headers: this.getLlmHeaders(),
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        console.error(`[generate] Remote LLM HTTP ${resp.status}: ${resp.statusText}`);
        // A SINGLE HTTP error means the server IS reachable — a healthy endpoint
        // having a bad moment must not lose its GPU lane to one 500. But an
        // endpoint that ONLY answers HTTP errors is indistinguishable from a
        // squatted port (issue #24: an unrelated service on :8089 disabled
        // enrichment silently for months), so a streak — or an endpoint-shape
        // status a real chat-completions route can never return — trips the
        // down-cache and lets the fallback engage. 429 is a healthy-but-limited
        // endpoint: never counted.
        if (resp.status !== 429) this.noteRemoteHttpError("llm", resp.status, resp.statusText);
        return null;
      }
      this.remoteLlmHttpErrorStreak = 0;

      const data = await resp.json() as {
        choices: { message: { content: string }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // v0.41.2: a reply the CONTEXT cut (not this call's max_tokens) is said once per process; the result is unchanged.
      const completion = data.usage?.completion_tokens;
      if (!this.contextCutWarned && data.choices[0]?.finish_reason === "length" && typeof completion === "number" && completion < maxTokens) {
        this.contextCutWarned = true;
        console.warn(
          `[generate] The LLM server cut a reply at its context limit (prompt ${data.usage?.prompt_tokens ?? "?"} tokens, ` +
          `reply ${completion} of ${maxTokens}); raise the server's context (llama-server -c) — see docs/troubleshooting.md`,
        );
      }

      return {
        text: data.choices[0]?.message?.content || "",
        model: data.model || this.remoteLlmUrl!,
        done: true,
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        // User/caller cancelled — don't cache as "down"
        return null;
      }
      if (this.isTransportError(error)) {
        this.markRemoteLlmDown();
      } else {
        console.error("[generate] Remote LLM error:", error);
      }
      return null;
    }
  }

  /**
   * The remote chat-completions body — ONE builder for `generate()` and `generateDetailed()`, so both send byte-
   * identical requests (`tests/unit/judge.test.ts` pins the bytes). v0.41.4: `extra.grammar` (the observer's windowed
   * calls only) adds llama-server's GBNF `grammar` field; without it the body is unchanged.
   */
  private buildRemoteChatBody(prompt: string, maxTokens: number, temperature: number, extra?: { grammar?: string }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.remoteLlmModel,
      // Idempotent: several prompts already end with a literal `/no_think` (as of v0.29.0:
      // consolidation x2, entity, intent, deductive-guardrails — decision-extractor and
      // merge-guards moved to the judge module, which owns the token for judge traffic)
      // because the LOCAL fallback receives the prompt directly and needs it inline.
      // Appending unconditionally sent those a doubled suffix. Do not strip the
      // prompt-local ones instead — the local path needs them.
      messages: [{ role: "user", content: this.applyNoThinkSuffix(prompt) }],
      max_tokens: maxTokens,
      temperature,
    };
    if (this.remoteLlmReasoningEffort) {
      body.reasoning_effort = this.remoteLlmReasoningEffort;
    }
    if (extra?.grammar !== undefined) body.grammar = extra.grammar;
    return body;
  }

  /**
   * v0.41.4: what a request to `backend` is sent to — the server root and the model the body names, or the local model
   * file. The observer keys its grammar-off record by it (with the server's fingerprint): another requested model at the
   * same root is another record.
   */
  requestIdentity(backend: LlmBackendId): string {
    return backend.kind === "remote" ? `remote\u0000${backend.root}\u0000${this.remoteLlmModel}` : `local\u0000${backend.modelPath}`;
  }

  /** v0.41.4: the local chat session one generation runs in (a seam the tests replace). */
  private async localChatSession(context: { getSequence(): unknown }): Promise<{
    promptWithMeta(prompt: string, o: Record<string, unknown>): Promise<{ responseText: string; stopReason: string }>;
  }> {
    const { LlamaChatSession } = await getNodeLlamaCpp();
    return new LlamaChatSession({ contextSequence: context.getSequence() as any }) as any;
  }

  /**
   * v0.41.4: a GBNF grammar compiled for the in-process model, kept per grammar text (the observer sends a handful).
   * One that does not compile throws: the call fails `grammar_rejected`, never a reply generated without it (codex
   * T7-7), and the observer's grammar-off record (§4.4), not a process-wide memory, decides when it is tried again.
   */
  private localGrammars = new Map<string, unknown>();
  private async localGrammar(gbnf: string): Promise<unknown> {
    const known = this.localGrammars.get(gbnf);
    if (known !== undefined) return known;
    const llama = await this.ensureLlama();
    const grammar = await llama.createGrammar({ grammar: gbnf });
    if (this.localGrammars.size >= 8) this.localGrammars.delete(this.localGrammars.keys().next().value!);
    this.localGrammars.set(gbnf, grammar);
    return grammar;
  }

  // ── v0.41.2 (BACKLOG 68.5): the token-budget layer ───────────────────────────────────────────────────────────────

  /** The content a remote call sends for `prompt` (the ` /no_think` suffix applied) — what a count must measure. */
  outboundChatContent(prompt: string, backend: LlmBackendId): string {
    return backend.kind === "remote" ? this.applyNoThinkSuffix(prompt) : prompt;
  }

  /** The backend a new Stop-pipeline unit starts on: the remote when configured and not in cooldown, else local when allowed. */
  activeLlmBackend(): LlmBackendId | null {
    if (this.remoteLlmUrl && !this.isRemoteLlmDown()) return { kind: "remote", root: remoteLlmRoot(this.remoteLlmUrl) };
    if (!this.localGenerationAllowed()) return null;
    return { kind: "local", modelPath: this.generateModelUri };
  }

  /** Whether `backend` is still this instance's configuration (design §1.4, the backend pin). */
  isConfiguredBackend(backend: LlmBackendId): boolean {
    if (backend.kind === "remote") return !!this.remoteLlmUrl && remoteLlmRoot(this.remoteLlmUrl) === backend.root;
    return this.localGenerationAllowed() && backend.modelPath === this.generateModelUri;
  }

  /** Whether a configured `backend` can be called now (a remote in its failure cooldown cannot). */
  isBackendAvailable(backend: LlmBackendId): boolean {
    if (!this.isConfiguredBackend(backend)) return false;
    return backend.kind === "local" || !this.isRemoteLlmDown();
  }

  private localGenerationAllowed(): boolean {
    return !this.noLocalFallback && process.env.CLAWMEM_NO_LOCAL_MODELS !== "true";
  }

  /** An aux request's signal: the phase deadline, capped at AUX_REQUEST_MAX_MS. Null when the deadline has passed. */
  private auxSignal(deadline: MonoDeadline): AbortSignal | null {
    const cap = deadlineAfter(monoNow(), duration(LlamaCpp.AUX_REQUEST_MAX_MS));
    return timeoutSignal(earliest(cap, deadline));
  }

  /**
   * `GET <root>/props` → the slot context, with a strong fingerprint only when the answer names the model path, the chat
   * template AND the build (codex T14-1: a body that gives the context alone verifies nothing); null when absent, failed,
   * or without `n_ctx`.
   */
  private async fetchProps(root: string, deadline: MonoDeadline): Promise<{ nCtx: number; fingerprint: string | null } | null> {
    const signal = this.auxSignal(deadline);
    if (!signal) return null;
    try {
      const resp = await fetch(`${root}/props`, { headers: this.getLlmHeaders(), signal });
      if (!resp.ok) return null;
      const data = await resp.json() as {
        default_generation_settings?: { n_ctx?: unknown };
        model_path?: unknown; chat_template?: unknown; build_info?: unknown;
      };
      const nCtx = data.default_generation_settings?.n_ctx;
      if (typeof nCtx !== "number" || !Number.isFinite(nCtx) || nCtx <= 0) return null;
      const identity = [data.model_path, data.chat_template, data.build_info];
      if (!identity.every((v): v is string => typeof v === "string" && v.length > 0)) return { nCtx, fingerprint: null };
      return { nCtx, fingerprint: sha256Hex(identity.join("\u0000")) };
    } catch {
      return null;
    }
  }

  /**
   * A backend's per-request context (design §1.2). Remote: `/props` read FRESH (measured) → `CLAWMEM_LLM_CONTEXT_TOKENS`
   * (configured) → 4096 (assumed); the fingerprint is strong only when `/props` names the model, template and build.
   * Local: the context a fitted call creates (measured). Never inferred from a reply.
   */
  async llmCapacity(backend: LlmBackendId, opts: { deadline: MonoDeadline }): Promise<LlmCapacity> {
    if (backend.kind === "local") {
      const nCtx = await this.localFitContextSize();
      return { backend, nCtx, source: "measured", fingerprint: sha256Hex(`local\u0000${backend.modelPath}`), fingerprintStrength: "strong" };
    }
    const props = await this.fetchProps(backend.root, opts.deadline);
    if (props?.fingerprint) return { backend, nCtx: props.nCtx, source: "measured", fingerprint: props.fingerprint, fingerprintStrength: "strong" };
    const weak = sha256Hex(`weak\u0000${backend.root}\u0000${this.remoteLlmModel}`);
    if (props) return { backend, nCtx: props.nCtx, source: "measured", fingerprint: weak, fingerprintStrength: "weak" };
    const configured = Number.parseInt(process.env.CLAWMEM_LLM_CONTEXT_TOKENS ?? "", 10);
    if (Number.isFinite(configured) && configured > 0) {
      return { backend, nCtx: configured, source: "configured", fingerprint: weak, fingerprintStrength: "weak" };
    }
    return { backend, nCtx: LlamaCpp.ASSUMED_CONTEXT_TOKENS, source: "assumed", fingerprint: weak, fingerprintStrength: "weak" };
  }

  /** The doctor's capacity read for the active backend, cached CAPACITY_CACHE_MS (the Stop pipeline never uses it). */
  async llmCapacityForDoctor(opts: { deadline: MonoDeadline }): Promise<LlmCapacity | null> {
    const now = epochMs(epochNow());
    const backend = this.activeLlmBackend();
    if (!backend) return null;
    const hit = this.capacityForDoctor;
    if (hit && now - hit.at < LlamaCpp.CAPACITY_CACHE_MS && JSON.stringify(hit.cap.backend) === JSON.stringify(backend)) return hit.cap;
    const cap = await this.llmCapacity(backend, opts);
    this.capacityForDoctor = { at: now, cap };
    return cap;
  }

  private async localFitContextSize(): Promise<number> {
    const model = await this.ensureGenerateModel();
    const train = model.trainContextSize;
    return typeof train === "number" && train > 0 ? Math.min(train, LlamaCpp.LOCAL_FIT_CONTEXT_TOKENS) : LlamaCpp.LOCAL_FIT_CONTEXT_TOKENS;
  }

  /** `POST <root>/apply-template` → the exact chat prompt, or null (absent → remembered for the process; failed). */
  private async applyTemplateRemote(root: string, content: string, deadline: MonoDeadline): Promise<string | null> {
    const signal = this.auxSignal(deadline);
    if (!signal) return null;
    try {
      const resp = await fetch(`${root}/apply-template`, {
        method: "POST", headers: this.getLlmHeaders(), signal,
        body: JSON.stringify({ messages: [{ role: "user", content }] }),
      });
      if (resp.status === 404 || resp.status === 405 || resp.status === 501) { this.templateServed = false; return null; }
      if (!resp.ok) return null;
      const data = await resp.json() as { prompt?: unknown };
      if (typeof data.prompt !== "string") { this.templateServed = false; return null; }
      this.templateServed = true;
      return data.prompt;
    } catch {
      return null;
    }
  }

  /** `POST <root>/tokenize {content}` → the token count, or null (absent → remembered for the process; failed). */
  private async tokenizeRemote(root: string, content: string, deadline: MonoDeadline): Promise<number | null> {
    const signal = this.auxSignal(deadline);
    if (!signal) return null;
    try {
      const resp = await fetch(`${root}/tokenize`, {
        method: "POST", headers: this.getLlmHeaders(), signal, body: JSON.stringify({ content }),
      });
      if (resp.status === 404 || resp.status === 405 || resp.status === 501) { this.tokenizeServed = false; return null; }
      if (!resp.ok) return null;
      const data = await resp.json() as { tokens?: unknown };
      if (!Array.isArray(data.tokens)) { this.tokenizeServed = false; return null; }
      this.tokenizeServed = true;
      return data.tokens.length;
    } catch {
      return null;
    }
  }

  private overheadKey(fingerprint: string): string {
    return `llm-template-overhead:${fingerprint}`;
  }

  /** A measured template overhead for `fingerprint` younger than 24 h: this process's, else the store's. */
  private knownOverhead(fingerprint: string, store?: OverheadStore): number | null {
    const now = epochMs(epochNow());
    const mem = this.measuredOverhead;
    if (mem?.fingerprint === fingerprint && now - mem.at <= LlamaCpp.OVERHEAD_TTL_MS) return mem.overhead;
    if (!store) return null;
    try {
      const raw = store.get(this.overheadKey(fingerprint));
      if (!raw) return null;
      const v = JSON.parse(raw) as { overhead?: unknown; at?: unknown };
      if (typeof v.overhead !== "number" || typeof v.at !== "number") return null;
      if (now - v.at > LlamaCpp.OVERHEAD_TTL_MS) return null;
      this.measuredOverhead = { fingerprint, overhead: v.overhead, at: v.at };
      return v.overhead;
    } catch {
      return null;
    }
  }

  /**
   * Forget the measured template overhead for `fingerprint`, in this process and in `store` (design §1.2: a validated
   * oversize means the count it fed was low). The next content count measures it again.
   */
  invalidateOverhead(fingerprint: string, store?: OverheadStore): void {
    if (this.measuredOverhead?.fingerprint === fingerprint) this.measuredOverhead = null;
    try { store?.delete(this.overheadKey(fingerprint)); } catch { /* best-effort */ }
  }

  /**
   * Measure the chat template's overhead on a `/tokenize`-only remote with a one-token probe (design §1.2): the chat
   * endpoint's `prompt_tokens` minus the content's own count. Best-effort; null when either side is missing.
   */
  private async probeOverhead(cap: LlmCapacity, deadline: MonoDeadline, store?: OverheadStore): Promise<number | null> {
    if (cap.backend.kind !== "remote" || !this.remoteLlmUrl) return null;
    const probe = "ok";
    const content = this.applyNoThinkSuffix(probe);
    const counted = await this.tokenizeRemote(cap.backend.root, content, deadline);
    if (counted === null) return null;
    const r = await this.generateDetailed(probe, { maxTokens: 1, temperature: 0, signal: this.auxSignal(deadline) ?? undefined, backend: cap.backend });
    if (!r.ok || typeof r.promptTokens !== "number") return null;
    const overhead = Math.max(0, r.promptTokens - counted);
    const at = epochMs(epochNow());
    this.measuredOverhead = { fingerprint: cap.fingerprint, overhead, at };
    try { store?.set(this.overheadKey(cap.fingerprint), JSON.stringify({ overhead, at })); } catch { /* best-effort */ }
    return overhead;
  }

  /**
   * A prompt's tokens as the chat endpoint will count them (design §1.2), strongest method first: the server's own
   * rendered template (`/apply-template` + `/tokenize`: exact — E11 measured it equal to the chat endpoint's own count —
   * so margin 0); the content's count + a measured overhead (margin overhead + 8) or + 32; the estimate (margin 32).
   * `content` is what the call sends.
   */
  async countChatTokens(content: string, cap: LlmCapacity, opts: { deadline: MonoDeadline; overheadStore?: OverheadStore }): Promise<ChatTokenCount> {
    if (cap.backend.kind === "local") {
      try {
        const model = await this.ensureGenerateModel();
        return { tokens: model.tokenize(content).length, method: "content", margin: 32 };
      } catch {
        return { tokens: Math.ceil(estimateTokens(content) * this.estimateFactor), method: "estimate", margin: 32 };
      }
    }
    const root = cap.backend.root;
    if (this.templateServed !== false) {
      const rendered = await this.applyTemplateRemote(root, content, opts.deadline);
      if (rendered !== null) {
        const n = await this.tokenizeRemote(root, rendered, opts.deadline);
        if (n !== null) return { tokens: n, method: "template", margin: 0 };
      }
    }
    if (this.tokenizeServed !== false) {
      const n = await this.tokenizeRemote(root, content, opts.deadline);
      if (n !== null) {
        const overhead = this.knownOverhead(cap.fingerprint, opts.overheadStore)
          ?? await this.probeOverhead(cap, opts.deadline, opts.overheadStore);
        return { tokens: n, method: "content", margin: overhead !== null ? overhead + 8 : 32 };
      }
    }
    return { tokens: Math.ceil(estimateTokens(content) * this.estimateFactor), method: "estimate", margin: 32 };
  }

  /** A validated oversize answer's numbers (HTTP 400 `exceed_context_size_error` with both counts), or null. */
  private async readOversize(resp: Response): Promise<{ nCtx: number; nPromptTokens: number } | null> {
    try {
      const data = await resp.json() as { error?: { type?: unknown; n_ctx?: unknown; n_prompt_tokens?: unknown } };
      const e = data.error;
      if (!e || e.type !== "exceed_context_size_error") return null;
      if (typeof e.n_ctx !== "number" || e.n_ctx <= 0 || typeof e.n_prompt_tokens !== "number" || e.n_prompt_tokens <= 0) return null;
      return { nCtx: e.n_ctx, nPromptTokens: e.n_prompt_tokens };
    } catch {
      return null;
    }
  }

  /**
   * The per-endpoint oversize exemption (design §1.2): with none open, a validated oversize opens one and does not
   * strike; a further one for a request NOT smaller in tokens strikes like any HTTP error (issue #24's streak); a
   * success closes it; it expires after OVERSIZE_EXEMPTION_TTL_MS.
   */
  private noteOversize(nPromptTokens: number, status: number, statusText: string): void {
    const now = epochMs(epochNow());
    const open = this.oversizeExemption;
    if (open && now - open.at < LlamaCpp.OVERSIZE_EXEMPTION_TTL_MS && nPromptTokens >= open.nPromptTokens) {
      this.noteRemoteHttpError("llm", status, statusText);
      return;
    }
    this.oversizeExemption = { nPromptTokens, at: now };
  }

  /** The estimate factor only rises: a reply whose own prompt count exceeds the estimate raises it to that ratio. */
  private observeEstimate(content: string, promptTokens: number | undefined): void {
    if (typeof promptTokens !== "number" || promptTokens <= 0) return;
    const base = estimateTokens(content);
    if (base > 0 && promptTokens > base * this.estimateFactor) this.estimateFactor = promptTokens / base;
  }

  /**
   * One generation pinned to `backend` (design §1.2): no remote → local fall-through inside the call — a remote
   * transport failure returns `unavailable` (and marks the remote down, as `generate()` does); the caller re-fits.
   */
  async generateDetailed(
    prompt: string,
    opts: {
      maxTokens: number; temperature?: number; signal?: AbortSignal; backend: LlmBackendId;
      /** v0.41.4: a GBNF grammar the reply must follow (llama-server's `grammar` field; node-llama-cpp's LlamaGrammar). */
      grammar?: string;
    },
  ): Promise<GenerateDetail> {
    const backend = opts.backend;
    const temperature = opts.temperature ?? 0;
    if (backend.kind === "remote") {
      if (!this.isBackendAvailable(backend)) return { ok: false, reason: "unavailable", backend };
      try {
        const body = this.buildRemoteChatBody(prompt, opts.maxTokens, temperature, opts.grammar !== undefined ? { grammar: opts.grammar } : undefined);
        const resp = await fetch(buildRemoteChatCompletionsUrl(this.remoteLlmUrl!), {
          method: "POST", headers: this.getLlmHeaders(), body: JSON.stringify(body), signal: opts.signal,
        });
        if (!resp.ok) {
          if (resp.status === 400) {
            const over = await this.readOversize(resp);
            if (over) {
              this.noteOversize(over.nPromptTokens, resp.status, resp.statusText);
              return { ok: false, reason: "context_exceeded", nCtx: over.nCtx, promptTokens: over.nPromptTokens, backend };
            }
          }
          console.error(`[generate] Remote LLM HTTP ${resp.status}: ${resp.statusText}`);
          if (resp.status !== 429) this.noteRemoteHttpError("llm", resp.status, resp.statusText);
          return { ok: false, reason: "http", backend, status: resp.status };
        }
        // A 200 that is not JSON (a non-JSON body reads as null here; an abort or a dropped connection still throws).
        const data = await resp.json().catch((e: unknown) => { if (e instanceof SyntaxError) return null; throw e; }) as {
          choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        } | null;
        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        // codex T11-2: a 200 without a completion is not an answer — never an empty one. codex T12-1: nor a success —
        // it strikes like any HTTP error, so a squatter answering 200 trips the cooldown and the fallback engages.
        if (!data || !choice || typeof content !== "string") {
          console.error(`[generate] Remote LLM answered HTTP ${resp.status} without a completion choice`);
          this.noteRemoteHttpError("llm", resp.status, "without a completion choice");
          return { ok: false, reason: "http", backend, status: resp.status };
        }
        this.remoteLlmHttpErrorStreak = 0;
        this.oversizeExemption = null;
        // `stop` is a complete reply, `length` a cut one; any other reason (`content_filter`, `tool_calls`, …) did not
        // finish as an answer. codex T12-4: a server that reports NO reason gets a best-effort reading — a reply that used
        // its whole allowance is cut, any other complete (a reply its context cut can be misread there).
        const fr = choice.finish_reason;
        let finish: "stop" | "length" | "other";
        if (fr === "stop" || fr === "length") finish = fr;
        else if (fr === undefined || fr === null) {
          const used = data.usage?.completion_tokens;
          finish = typeof used === "number" && used >= opts.maxTokens ? "length" : "stop";
          if (!this.noFinishReasonWarned) {
            this.noFinishReasonWarned = true;
            console.warn(
              `[generate] The LLM server's replies carry no finish_reason: a reply that uses its whole allowance counts as cut, ` +
              `any other as complete (best-effort) — see docs/troubleshooting.md`,
            );
          }
        } else finish = "other";
        this.observeEstimate(this.applyNoThinkSuffix(prompt), data.usage?.prompt_tokens);
        return {
          ok: true, text: content, model: data.model || this.remoteLlmUrl!, finish,
          promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens, backend,
        };
      } catch (error) {
        if (this.isAbortError(error)) return { ok: false, reason: "aborted", backend };
        if (this.isTransportError(error)) this.markRemoteLlmDown();
        else console.error("[generate] Remote LLM error:", error);
        return { ok: false, reason: "unavailable", backend };
      }
    }
    if (!this.isBackendAvailable(backend)) return { ok: false, reason: "unavailable", backend };
    try {
      const model = await this.ensureGenerateModel();
      let grammar: unknown;
      if (opts.grammar !== undefined) {
        try {
          grammar = await this.localGrammar(opts.grammar);
        } catch (error) {
          console.warn(`[generate] The in-process model could not compile the request's grammar: ${error instanceof Error ? error.message : String(error)}`);
          return { ok: false, reason: "grammar_rejected", backend };
        }
      }
      const context = await model.createContext({ contextSize: await this.localFitContextSize() });
      try {
        const session = await this.localChatSession(context);
        const r = await session.promptWithMeta(prompt, {
          maxTokens: opts.maxTokens, temperature, signal: opts.signal, stopOnAbortSignal: true, ...(grammar !== undefined ? { grammar } : {}),
        });
        if (r.stopReason === "abort") return { ok: false, reason: "aborted", backend };
        const finish = r.stopReason === "maxTokens" ? "length"
          : r.stopReason === "eogToken" || r.stopReason === "stopGenerationTrigger" || r.stopReason === "customStopTrigger" ? "stop" : "other";
        return { ok: true, text: r.responseText, model: this.generateModelUri, finish, backend };
      } finally {
        await context.dispose();
      }
    } catch (error) {
      if (this.isAbortError(error)) return { ok: false, reason: "aborted", backend };
      console.error("[generate] Local generation error:", error);
      return { ok: false, reason: "unavailable", backend };
    }
  }

  /**
   * Judge-only chat request (v0.29.0). A SEPARATE body builder from generateRemote:
   * system+user role split and optional response_format json_schema. The legacy
   * generateRemote body (one user message + scalars) stays byte-identical for every
   * existing generate() consumer — guarded by a snapshot test. Reuses this instance's
   * transport (URL normalization, Bearer headers, down-cache) only.
   */
  async generateJudgeChat(req: JudgeChatRequest, opts: { signal?: AbortSignal } = {}): Promise<JudgeChatResult> {
    if (!this.remoteLlmUrl) {
      return { ok: false, reason: "unavailable", detail: "no remote LLM URL configured on this instance" };
    }
    if (this.isRemoteLlmDown()) {
      return { ok: false, reason: "unavailable", detail: "remote LLM in failure cooldown" };
    }
    const body: Record<string, unknown> = {
      model: this.remoteLlmModel,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: this.remoteLlmNoThink ? this.applyNoThinkSuffix(req.user) : req.user },
      ],
      max_tokens: req.maxTokens,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (this.remoteLlmReasoningEffort) body.reasoning_effort = this.remoteLlmReasoningEffort;
    if (req.schema) {
      body.response_format = { type: "json_schema", json_schema: { name: "judge_verdicts", schema: req.schema } };
    }
    try {
      const resp = await fetch(buildRemoteChatCompletionsUrl(this.remoteLlmUrl), {
        method: "POST",
        headers: this.getLlmHeaders(),
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!resp.ok) {
        return { ok: false, reason: "http", detail: `HTTP ${resp.status}: ${resp.statusText}` };
      }
      const data = await resp.json() as {
        choices: { message: { content: string }; finish_reason?: string }[];
        model?: string;
      };
      const choice = data.choices?.[0];
      return {
        ok: true,
        text: choice?.message?.content || "",
        model: data.model || this.remoteLlmUrl,
        truncated: choice?.finish_reason === "length",
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        const timedOut =
          (error as { name?: string })?.name === "TimeoutError" ||
          ((opts.signal?.reason as { name?: string } | undefined)?.name === "TimeoutError");
        return { ok: false, reason: timedOut ? "timeout" : "aborted", detail: String(error) };
      }
      if (this.isTransportError(error)) this.markRemoteLlmDown();
      return { ok: false, reason: "unavailable", detail: String(error) };
    }
  }

  private async expandQueryRemote(query: string, includeLexical: boolean, context?: string, intent?: string, signal?: AbortSignal): Promise<Queryable[]> {
    // QMD-faithful terse prompt. The qmd-query-expansion-1.7B finetune was trained
    // on "/no_think Expand this search query: X" (cf. QMD src/llm.ts:1467). The prior
    // verbose prose prompt was out-of-distribution: the model echoed the template
    // ("lex: keyword search terms (") and leaked </think> (verified live 2026-06-23).
    let prompt = intent
      ? `/no_think Expand this search query: ${query}\nQuery intent: ${intent}`
      : `/no_think Expand this search query: ${query}`;
    if (context) prompt += `\nContext: ${context}`;

    const result = await this.generateRemote(prompt, 500, 0.7, signal);
    if (!result?.text) {
      return expansionFallback(query, includeLexical);
    }

    const lines = result.text.trim().split("\n");
    const parsed: Queryable[] = lines.map(line => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return null;
      const type = line.slice(0, colonIdx).trim();
      if (type !== 'lex' && type !== 'vec' && type !== 'hyde') return null;
      const text = line.slice(colonIdx + 1).trim();
      if (!text) return null;
      return { type: type as QueryType, text };
    }).filter((q): q is Queryable => q !== null);

    // Drop template residue / <think> leaks / dups, then scope to requested types.
    const cleaned = sanitizeExpandedQueries(parsed);
    const scoped = includeLexical ? cleaned : cleaned.filter(q => q.type !== 'lex');
    if (scoped.length === 0) return expansionFallback(query, includeLexical);
    return scoped;
  }

  async modelExists(modelUri: string): Promise<ModelInfo> {
    // For HuggingFace URIs, we assume they exist
    // For local paths, check if file exists
    if (modelUri.startsWith("hf:")) {
      return { name: modelUri, exists: true };
    }

    const exists = existsSync(modelUri);
    return {
      name: modelUri,
      exists,
      path: exists ? modelUri : undefined,
    };
  }

  // ==========================================================================
  // High-level abstractions
  // ==========================================================================

  async expandQuery(query: string, options: { context?: string, includeLexical?: boolean, intent?: string, deadline?: MonoDeadline } = {}): Promise<Queryable[]> {
    const includeLexical = options.includeLexical ?? true;
    const context = options.context;
    const intent = options.intent;
    // BUILD-3a (codex turn-24 finding 3): a deadline-carrying caller (the
    // context-surfacing hook) gets a REAL abort on the remote fetch — an
    // abandoned race does not stop the transport, and the pending work
    // holds the hook PROCESS alive past its budget (the host waits on the
    // process, not the handler's return). O1: the signal is bounded by the
    // monotonic remainder; an already-passed deadline skips the remote call
    // outright (the typed fallback) instead of starting a fetch to abort it.
    const deadline = options.deadline;
    const expandSignal = deadline !== undefined ? timeoutSignal(deadline) : undefined;
    if (deadline !== undefined && expandSignal === null) return expansionFallback(query, includeLexical);

    // Remote LLM path — no grammar constraint, parse output instead
    if (this.remoteLlmUrl && !this.isRemoteLlmDown()) {
      const result = await this.expandQueryRemote(query, includeLexical, context, intent, expandSignal ?? undefined);
      // Check if transport failure set cooldown during this call
      if (!this.isRemoteLlmDown()) return result;
      // Transport failure — fall through to local grammar path
    }

    // A deadline-carrying caller must NEVER start unabortable local
    // inference (codex turn-24 finding 3 — structural, not launcher-
    // dependent): return the typed passthrough set instead.
    if (deadline !== undefined) {
      return expansionFallback(query, includeLexical);
    }

    // Remote is in cooldown (pre-existing or just set) — fall through to local
    if (this.remoteLlmUrl && this.isRemoteLlmDown()) {
      if (process.env.CLAWMEM_NO_LOCAL_MODELS === "true") {
        // Can't fall back to local inference — return the typed passthrough set
        return expansionFallback(query, includeLexical);
      }
      this.noteRemoteFallback(
        "llm",
        this.isLoopbackUrl(this.remoteLlmUrl)
          ? "[expandQuery] Local LLM endpoint unavailable; using in-process grammar expansion during cooldown"
          : "[expandQuery] Remote LLM in cooldown, falling back to in-process grammar expansion"
      );
    }

    const llama = await this.ensureLlama();
    await this.ensureGenerateModel();

    const grammar = await llama.createGrammar({
      grammar: `
        root ::= line+
        line ::= type ": " content "\\n"
        type ::= "lex" | "vec" | "hyde"
        content ::= [^\\n]+
      `
    });

    const prompt = `You are a search query optimization expert. Your task is to improve retrieval by rewriting queries and generating hypothetical documents.

Original Query: ${query}
${intent ? `\nQuery intent: ${intent}` : ""}
${context ? `Additional Context, ONLY USE IF RELEVANT:\n\n<context>${context}</context>` : ""}

## Step 1: Query Analysis
Identify entities, search intent, and missing context.

## Step 2: Generate Hypothetical Document
Write a focused sentence passage that would answer the query. Include specific terminology and domain vocabulary.

## Step 3: Query Rewrites
Generate 2-3 alternative search queries that resolve ambiguities. Use terminology from the hypothetical document.

## Step 4: Final Retrieval Text
Output exactly 1-3 'lex' lines, 1-3 'vec' lines, and MAX ONE 'hyde' line.

<format>
lex: {single search term}
vec: {single vector query}
hyde: {complete hypothetical document passage from Step 2 on a SINGLE LINE}
</format>

<example>
Example (FOR FORMAT ONLY - DO NOT COPY THIS CONTENT):
lex: example keyword 1
lex: example keyword 2
vec: example semantic query
hyde: This is an example of a hypothetical document passage that would answer the example query. It contains multiple sentences and relevant vocabulary.
</example>

<rules>
- DO NOT repeat the same line.
- Each 'lex:' line MUST be a different keyword variation based on the ORIGINAL QUERY.
- Each 'vec:' line MUST be a different semantic variation based on the ORIGINAL QUERY.
- The 'hyde:' line MUST be the full sentence passage from Step 2, but all on one line.
- DO NOT use the example content above.
${!includeLexical ? "- Do NOT output any 'lex:' lines" : ""}
</rules>

Final Output:`;

    // Create fresh context for each call
    const genContext = await this.generateModel!.createContext();
    const sequence = genContext.getSequence();
    const { LlamaChatSession } = await getNodeLlamaCpp();
    const session = new LlamaChatSession({ contextSequence: sequence });

    try {
      const result = await session.prompt(prompt, {
        grammar,
        maxTokens: 1000,
        temperature: 1,
      });

      const lines = result.trim().split("\n");
      const parsed: Queryable[] = lines.map(line => {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) return null;
        const type = line.slice(0, colonIdx).trim();
        if (type !== 'lex' && type !== 'vec' && type !== 'hyde') return null;
        const text = line.slice(colonIdx + 1).trim();
        return { type: type as QueryType, text };
      }).filter((q): q is Queryable => q !== null);

      // Same guard as the remote path — drop residue/dups, scope to requested types.
      const cleaned = sanitizeExpandedQueries(parsed);
      const scoped = includeLexical ? cleaned : cleaned.filter(q => q.type !== 'lex');
      if (scoped.length === 0) return expansionFallback(query, includeLexical);
      return scoped;
    } catch (error) {
      console.error("Structured query expansion failed:", error);
      return expansionFallback(query, includeLexical);
    } finally {
      await genContext.dispose();
    }
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {}
  ): Promise<RerankResult> {
    const context = await this.ensureRerankContext();

    // Build a map from document text to original indices (for lookup after sorting)
    const textToDoc = new Map<string, { file: string; index: number }>();
    documents.forEach((doc, index) => {
      textToDoc.set(doc.text, { file: doc.file, index });
    });

    // Extract just the text for ranking
    const texts = documents.map((doc) => doc.text);

    // Use the proper ranking API - returns [{document: string, score: number}] sorted by score
    const ranked = await context.rankAndSort(query, texts);

    // Map back to our result format using the text-to-doc map
    const results: RerankDocumentResult[] = ranked.map((item: { document: string; score: number }) => {
      const docInfo = textToDoc.get(item.document)!;
      return {
        file: docInfo.file,
        score: item.score,
        index: docInfo.index,
      };
    });

    return {
      results,
      model: this.rerankModelUri,
    };
  }

  async dispose(): Promise<void> {
    // Prevent double-dispose
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Clear inactivity timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Disposing llama cascades to models and contexts automatically
    // See: https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
    // Note: llama.dispose() can hang indefinitely, so we use a timeout
    if (this.llama) {
      const disposePromise = this.llama.dispose();
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 1000));
      await Promise.race([disposePromise, timeoutPromise]);
    }

    // Clear references
    this.embedContext = null;
    this.embedModel = null;
    this.rerankContext = null;
    this.generateModel = null;
    this.rerankModel = null;
    this.llama = null;

    // Clear any in-flight load promises
    this.embedModelLoadPromise = null;
    this.generateModelLoadPromise = null;
    this.rerankModelLoadPromise = null;
  }
}

// =============================================================================
// Singleton for default LlamaCpp instance
// =============================================================================

let defaultLlamaCpp: LlamaCpp | null = null;

/**
 * Get the default LlamaCpp instance (creates one if needed).
 * Reads CLAWMEM_EMBED_URL, CLAWMEM_EMBED_API_KEY, CLAWMEM_EMBED_MODEL env vars.
 *
 * Cloud embedding providers (set CLAWMEM_EMBED_API_KEY + CLAWMEM_EMBED_URL):
 *   OpenAI:   CLAWMEM_EMBED_URL=https://api.openai.com  CLAWMEM_EMBED_MODEL=text-embedding-3-small
 *   Voyage:   CLAWMEM_EMBED_URL=https://api.voyageai.com CLAWMEM_EMBED_MODEL=voyage-4-large
 *   Jina:     CLAWMEM_EMBED_URL=https://api.jina.ai     CLAWMEM_EMBED_MODEL=jina-embeddings-v3
 *   Cohere:   CLAWMEM_EMBED_URL=https://api.cohere.com   CLAWMEM_EMBED_MODEL=embed-v4.0
 */
let _apiKeyLocalhostWarned = false;

export function getDefaultLlamaCpp(): LlamaCpp {
  if (!defaultLlamaCpp) {
    const embedUrl = process.env.CLAWMEM_EMBED_URL || undefined;
    const embedApiKey = process.env.CLAWMEM_EMBED_API_KEY || undefined;

    // Warn once if API key is set but URL points to localhost
    if (embedApiKey && embedUrl && !_apiKeyLocalhostWarned) {
      const lower = embedUrl.toLowerCase();
      if (lower.includes("localhost") || lower.includes("127.0.0.1")) {
        console.warn(
          "[clawmem] Warning: CLAWMEM_EMBED_API_KEY is set but CLAWMEM_EMBED_URL points to " +
          `${embedUrl}. API key will be sent as Bearer token to local server. ` +
          "If this is intentional (local gateway), ignore this warning."
        );
        _apiKeyLocalhostWarned = true;
      }
    }

    defaultLlamaCpp = new LlamaCpp({
      remoteEmbedUrl: embedUrl,
      remoteEmbedApiKey: embedApiKey,
      remoteEmbedModel: process.env.CLAWMEM_EMBED_MODEL || undefined,
      remoteLlmUrl: process.env.CLAWMEM_LLM_URL || undefined,
      remoteLlmApiKey: process.env.CLAWMEM_LLM_API_KEY || undefined,
      remoteLlmModel: process.env.CLAWMEM_LLM_MODEL?.trim() || undefined,
      remoteLlmReasoningEffort: process.env.CLAWMEM_LLM_REASONING_EFFORT || undefined,
      remoteLlmNoThink: normalizeRemoteLlmNoThink(process.env.CLAWMEM_LLM_NO_THINK),
    });
  }
  return defaultLlamaCpp;
}

/**
 * Set a custom default LlamaCpp instance (useful for testing)
 */
export function setDefaultLlamaCpp(llm: LlamaCpp | null): void {
  defaultLlamaCpp = llm;
}

/**
 * Dispose the default LlamaCpp instance if it exists.
 * Call this before process exit to prevent NAPI crashes.
 */
export async function disposeDefaultLlamaCpp(): Promise<void> {
  if (defaultLlamaCpp) {
    await defaultLlamaCpp.dispose();
    defaultLlamaCpp = null;
  }
}
