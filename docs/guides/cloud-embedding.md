# Cloud Embedding

By default, ClawMem uses a local `llama-server` for embeddings. If you don't have a GPU, you can use a cloud embedding provider instead.

## Supported providers

| Provider | URL | Model | Dimensions |
|----------|-----|-------|-----------|
| OpenAI | `https://api.openai.com` | `text-embedding-3-small` | 1536 |
| Voyage AI | `https://api.voyageai.com` | `voyage-4-large` | 1024 |
| Jina AI | `https://api.jina.ai` | `jina-embeddings-v3` | 1024 |
| Cohere | `https://api.cohere.com` | `embed-v4.0` | 1024 |

All providers use the OpenAI-compatible `/v1/embeddings` endpoint with Bearer token auth.

## Configuration

Set three environment variables:

```bash
export CLAWMEM_EMBED_URL=https://api.openai.com
export CLAWMEM_EMBED_API_KEY=sk-your-key-here
export CLAWMEM_EMBED_MODEL=text-embedding-3-small
```

Or in `.env`:

```bash
CLAWMEM_EMBED_URL=https://api.openai.com
CLAWMEM_EMBED_API_KEY=sk-your-key-here
CLAWMEM_EMBED_MODEL=text-embedding-3-small
```

## Truncation behavior

- **Local embedding** (no API key): Input truncated to `CLAWMEM_EMBED_MAX_CHARS` (default 6000) before sending. This prevents oversized inputs from exceeding the model's token context.
- **Cloud embedding** (API key set): Client-side truncation is skipped. Cloud providers handle truncation server-side.

To override the local truncation limit:

```bash
export CLAWMEM_EMBED_MAX_CHARS=4000  # for models with smaller context
```

## Localhost warning

If you set `CLAWMEM_EMBED_API_KEY` but your `CLAWMEM_EMBED_URL` points to localhost or 127.0.0.1, ClawMem prints a one-time warning. This catches accidental configurations where an API key is sent to a local server. If you're using a local API gateway intentionally, the warning is safe to ignore.

## Mixing local and cloud

The LLM (query expansion) and reranker always use local `llama-server` or in-process `node-llama-cpp` fallback. Only embedding supports cloud providers. This means:

- **Embedding** — local GPU or cloud API (no in-process fallback)
- **LLM** — local GPU, falls back to in-process CPU
- **Reranker** — local GPU, falls back to in-process CPU

## Model recommendations

For local GPU embedding, use **EmbeddingGemma-300M** (768 dimensions, 2048-token context, ~400MB VRAM):

```bash
llama-server -m embeddinggemma-300M-Q8_0.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 2048
```

For cloud, any of the providers above work well. Choose based on your existing API relationships and pricing preferences.
