# Cloud Embedding

By default, ClawMem uses local embedding (via `llama-server` or in-process `node-llama-cpp` fallback — Metal on Apple Silicon, Vulkan/CPU otherwise). As an alternative, you can use a cloud embedding provider.

## Supported providers

| Provider | URL | Model | Dimensions |
|----------|-----|-------|-----------|
| Jina AI | `https://api.jina.ai` | `jina-embeddings-v5-text-small` | 1024 |
| OpenAI | `https://api.openai.com` | `text-embedding-3-small` | 1536 |
| Voyage AI | `https://api.voyageai.com` | `voyage-4-large` | 1024 |
| Cohere | `https://api.cohere.com` | `embed-v4.0` | 1024 |

All providers use the OpenAI-compatible `/v1/embeddings` endpoint with Bearer token auth.

## Configuration

Copy `.env.example` to `.env` and set your provider credentials:

```bash
cp .env.example .env
# Edit .env:
CLAWMEM_EMBED_URL=https://api.jina.ai
CLAWMEM_EMBED_API_KEY=jina_your-key-here
CLAWMEM_EMBED_MODEL=jina-embeddings-v5-text-small
```

Or export them in your shell before running `clawmem`.

**Precedence:** shell environment > `.env` file > `bin/clawmem` wrapper defaults. The wrapper sources `.env` from the project root before applying its defaults, so `.env` values override defaults but explicit shell exports still win.

## Cloud mode features

When `CLAWMEM_EMBED_API_KEY` is set, cloud mode activates:

- **Batch embedding** — 50 fragments per API request (vs 1 per request for local). Reduces total API calls ~50×.
- **Provider-specific retrieval params** — Auto-detected from your `CLAWMEM_EMBED_URL`. Documents and queries get different params for optimal retrieval quality (see table below).
- **Server-side truncation** — Provider-appropriate truncation params sent automatically. Oversized inputs are truncated server-side instead of returning errors.
- **Adaptive TPM-aware pacing** — Delays between batches computed from actual token usage to stay within your tier's tokens-per-minute limit. No hardcoded tier assumptions.
- **Retry with jitter** — 429 responses trigger retries with exponential backoff (5s → 10s → 20s, max 3 retries) plus random jitter to prevent synchronized retry storms.

### Provider-specific parameters

ClawMem auto-detects your provider from the URL and sends the right params:

| Provider | Document embedding | Query embedding | Truncation | Extra |
|----------|-------------------|-----------------|------------|-------|
| Jina AI | `task: "retrieval.passage"` | `task: "retrieval.query"` | `truncate: true` | |
| Voyage AI | `input_type: "document"` | `input_type: "query"` | Default (true) | |
| Cohere | `input_type: "search_document"` | `input_type: "search_query"` | `truncate: "END"` | |
| OpenAI | Symmetric (none) | Symmetric (none) | None (8192 max) | `dimensions` via `CLAWMEM_EMBED_DIMENSIONS` |

No configuration needed — just set `CLAWMEM_EMBED_URL` to the provider and the correct params are applied. For OpenAI's `text-embedding-3-*` models, optionally set `CLAWMEM_EMBED_DIMENSIONS` to reduce output dimensions (e.g. `512` or `1024`).

**Note on OpenAI truncation:** OpenAI does not auto-truncate — inputs exceeding 8192 tokens return an error. ClawMem's default chunk size is ~800 tokens, well under this limit, so this is not an issue in practice.

## Rate limiting

Cloud providers enforce rate limits on both requests-per-minute (RPM) and tokens-per-minute (TPM). TPM is typically the binding constraint for embedding.

Set `CLAWMEM_EMBED_TPM_LIMIT` to match your provider tier:

| Tier | RPM | TPM | `CLAWMEM_EMBED_TPM_LIMIT` |
|------|-----|-----|--------------------------|
| Jina Free | 100 | 100,000 | `100000` (default) |
| Jina Paid | 500 | 2,000,000 | `2000000` |
| Jina Premium | 5,000 | 50,000,000 | `50000000` |

```bash
# Example: paid tier
export CLAWMEM_EMBED_TPM_LIMIT=2000000
```

The adaptive pacer computes delay as `(batchTokens / (TPM_LIMIT × 0.85)) × 60s`, using actual token counts from the API response when available, falling back to character-based estimation. The 0.85 safety factor leaves headroom for retries.

## Truncation behavior

- **Local embedding** (no API key): Input truncated to `CLAWMEM_EMBED_MAX_CHARS` (default 6000) before sending. This prevents oversized inputs from exceeding the model's token context.
- **Cloud embedding** (API key set): Client-side truncation is skipped. Server-side truncation is requested via `truncate: true`.

To override the local truncation limit:

```bash
export CLAWMEM_EMBED_MAX_CHARS=4000  # for models with smaller context
```

## Localhost warning

If you set `CLAWMEM_EMBED_API_KEY` but your `CLAWMEM_EMBED_URL` points to localhost or 127.0.0.1, ClawMem prints a one-time warning. This catches accidental configurations where an API key is sent to a local server. If you're using a local API gateway intentionally, the warning is safe to ignore.

## Mixing local and cloud

The LLM (query expansion) and reranker always use local `llama-server` or in-process `node-llama-cpp` fallback. Only embedding supports cloud providers. This means:

- **Embedding** — local GPU, cloud API, or in-process via `node-llama-cpp` (Metal/Vulkan/CPU)
- **LLM** — local GPU, falls back to in-process `node-llama-cpp`
- **Reranker** — local GPU, falls back to in-process `node-llama-cpp`

**Note:** In-process fallback is silent — if a GPU server crashes, there is no warning. Set `CLAWMEM_NO_LOCAL_MODELS=true` to fail fast instead, or use [systemd services](systemd-services.md) to keep servers running.

## Model recommendations

**Default (QMD native combo, any GPU or CPU):** EmbeddingGemma-300M-Q8_0 (314MB, 768d) + qwen3-reranker-0.6B (600MB) + qmd-query-expansion-1.7B (~1.1GB). All three auto-download via `node-llama-cpp` if no server is running (Metal on Apple Silicon, Vulkan/CPU otherwise).

```bash
llama-server -m embeddinggemma-300M-Q8_0.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 2048
```

**SOTA upgrade (12GB+ GPU):** **ZeroEntropy zembed-1** (2560 dimensions, 32K context, SOTA retrieval quality, ~4.4GB VRAM) paired with **zerank-2** reranker (distillation-paired via zELO). **CC-BY-NC-4.0** — non-commercial only.

```bash
llama-server -m zembed-1-Q4_K_M.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 8192 -b 2048 -ub 2048

llama-server -m zerank-2-Q4_K_M.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 -b 2048 -ub 2048
```

For cloud, **Jina AI `jina-embeddings-v5-text-small`** is recommended (1024 dimensions, 32K context, task-specific LoRA adapters for retrieval).

## Switching embedding models

When changing to a model with different output dimensions (e.g. 768d → 2560d), a full re-embed is required:

```bash
clawmem embed --force
```

This clears all existing vectors and rebuilds with the new model's dimensions. The vector table is automatically recreated with the correct dimension size on the first embedded fragment.

**Important notes:**
- `--force` is safe to interrupt and resume — embed is idempotent and skips already-embedded documents
- `-ub` must equal `-b` on `llama-server` for embedding/reranking models (non-causal attention). Omitting `-ub` causes assertion crashes.
- Set `-c` (context) high enough for your largest fragments. zembed-1 supports 32K; `-c 8192` is recommended.
