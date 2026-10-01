# Inference services — choosing and running your stack

ClawMem uses three inference services: **embedding**, **LLM** (query expansion / intent classification / A-MEM enrichment / the Stop hooks' observer), and **reranker** (cross-encoder). In the **default** stack all three run as `llama-server` (llama.cpp) instances, each with an in-process `node-llama-cpp` fallback that auto-downloads on first use — so ClawMem works with no manual setup and no dedicated GPU. The `bin/clawmem` wrapper points the three endpoint vars at `localhost:8088` (embedding), `localhost:8089` (LLM), `localhost:8090` (reranker) by default.

> **Always run ClawMem via the `bin/clawmem` wrapper.** It exports the endpoint defaults. Invoking `bun run src/clawmem.ts` directly skips them and silently falls back to in-process inference through `node-llama-cpp` (slow without a GPU it can use). For remote GPU, add the same vars to your systemd units — see [systemd-services.md](systemd-services.md).

## Choosing your inference stack

Three stacks, picked by hardware, license, and quality needs. This is the decision; the rest of this guide is how to run each.

| Stack | Models | VRAM | License | Retrieval quality / context | Pick when |
|---|---|---|---|---|---|
| **QMD native** (default) | EmbeddingGemma-300M (768d) + qmd-query-expansion-1.7B + qwen3-reranker-0.6B | ~4 GB total, or **in-process** (Metal/Vulkan/CPU) | **Permissive — commercial OK** | Good · 2K embed context | Any GPU **or no GPU**; **commercial use**; zero-config start (auto-downloads) |
| **z / SOTA** | zembed-1 (2560d, zELO-distilled from zerank-2) + qmd-query-expansion-1.7B + zerank-2 seq-cls **sidecar** (bf16) | ~16 GB (4.4 + 2.2 + 9) | **CC-BY-NC-4.0 — non-commercial only** | Best (zerank-2 NDCG@10 ahead of Cohere rerank-3.5) · 32K embed context | 16 GB+ GPU **and** non-commercial; want top recall |
| **Cloud embedding** | Jina v5-text-small (1024d, rec.) / OpenAI / Voyage / Cohere — **embedding only** | none (embedding) | provider ToS | provider-dependent · up to 128K (Cohere) | No local GPU for embedding, or prefer managed. **LLM + reranker still run local/in-process.** |

**Decision axes:** VRAM budget · license (commercial vs non-commercial) · retrieval quality · context length. The default native stack is the right starting point for most users and the only stack with no licensing restriction; upgrade to the z-stack only with a 16 GB+ GPU and a non-commercial use case; use cloud embedding when you have no local GPU to spare for embeddings.

## Landmines (read before serving)

- **The zerank-2 GGUF is deprecated and inert.** llama.cpp's converter drops zerank's CrossEncoder/LogitScore head, so under `--reranking` it returns HTTP 200 with near-zero, non-discriminating scores — the final ordering silently collapses to RRF. Serve the SOTA reranker via the **seq-cls sidecar** (`extras/rerankers/zerank-2-seq/`), never as a GGUF. Run `clawmem rerank-health` to confirm a reranker actually discriminates (liveness ≠ correctness). Since v0.38.0 a passing probe also **attests the served provider's behavioral fingerprint**, which is what enables remote rerank-score caching (`CLAWMEM_RERANK_PROVIDER_ID` optionally refines the identity; attestations expire after 7 days, and a failed or unfingerprintable probe revokes them — see [configuration](../reference/configuration.md)).
- **`-ub` must equal `-b`** for embedding/reranking models (non-causal attention) or `llama-server` asserts (`non-causal attention requires n_ubatch >= n_tokens`). The zerank-2 sidecar is transformers-served and exempt; the qwen3-reranker GGUF does not need it. See [llama.cpp#12836](https://github.com/ggml-org/llama.cpp/issues/12836).
- **Changing embedding dimensions requires a full re-embed:** `clawmem embed --force` (idempotent, safe to interrupt/resume).
- **Set `CLAWMEM_NO_LOCAL_MODELS=true`** for remote-only / dedicated-server setups to fail fast on an unreachable endpoint instead of silently auto-downloading multi-GB GGUFs and running them in-process.
- **A squatted port is not a healthy endpoint.** If an unrelated service occupies a configured port (the default range 8088–8090 is popular), it answers HTTP while serving nothing — through v0.36.0 that disabled enrichment silently and permanently. Since v0.37.0 persistent HTTP errors trip the same 60s cooldown as transport failures (405/501 instantly, other non-2xx after 3 consecutive), and `clawmem doctor` POSTs a real completion to `CLAWMEM_LLM_URL` and validates the response shape — reachability is not correctness.

## Default stack — QMD native (any GPU or in-process)

Total ~4 GB VRAM, or runs in-process via `node-llama-cpp` (Metal on Apple Silicon, Vulkan where available, CPU as last resort — fast with GPU acceleration, significantly slower CPU-only). All three auto-download on first use if no server is running. In-process Metal on Apple Silicon needs `node-llama-cpp` 3.20.0 or newer (bundled llama.cpp b10361): 3.15.1 (llama.cpp b7836) was observed to fail its Metal shader compile on macOS 26.6.2 with an M5 Pro and then ran without the GPU. See [troubleshooting](../troubleshooting.md#embedding--gpu).

| Service | Port | Model | VRAM | Purpose |
|---|---|---|---|---|
| Embedding | 8088 | [EmbeddingGemma-300M-Q8_0](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF) (314 MB, 768d, 2K ctx) | ~400 MB | Vector search, indexing, context-surfacing |
| LLM | 8089 | [qmd-query-expansion-1.7B-q4_k_m](https://huggingface.co/tobil/qmd-query-expansion-1.7B-gguf) (~1.1 GB) | ~2.2 GB | Intent classification, query expansion, A-MEM, Stop-hook observer |
| Reranker | 8090 | [qwen3-reranker-0.6B-Q8_0](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) (~600 MB) | ~1.3 GB | Cross-encoder reranking |

```bash
# Embedding (--embeddings flag required)
llama-server -m embeddinggemma-300M-Q8_0.gguf \
  --embeddings --port 8088 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 2048

# LLM (QMD finetuned model). -c 8192: room for the Stop-hook observer's prompt AND its answer (see "LLM server")
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf \
  --port 8089 --host 0.0.0.0 -ngl 99 -c 8192 --batch-size 512

# Reranker
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 512
```

On CPU, omit `-ngl 99`. If the LLM endpoint (self-hosted or cloud) or the self-hosted embedding server is unreachable (ECONNREFUSED/ETIMEDOUT), or keeps answering HTTP errors (405 or 501 at once; any other non-2xx except 429 after three in a row, since v0.37.0), ClawMem pauses that endpoint for 60 seconds and uses in-process inference meanwhile, except with `CLAWMEM_NO_LOCAL_MODELS=true` and for a query-path embedding or expansion that carries its own deadline. A user-cancelled request does not start a pause, and the reranker has no such pause.

## SOTA stack — z models (16 GB+ GPU, CC-BY-NC-4.0, non-commercial only)

ZeroEntropy's distillation-paired stack — best retrieval quality, total ~16 GB VRAM. zembed-1 is distilled from zerank-2 via [zELO](https://docs.zeroentropy.dev), so the pair is mutually optimal.

| Service | Port | Model | VRAM | Purpose |
|---|---|---|---|---|
| Embedding | 8088 | [zembed-1-Q4_K_M](https://huggingface.co/Abhiray/zembed-1-Q4_K_M-GGUF) (2.4 GB, 2560d, 32K ctx) | ~4.4 GB | SOTA embedding |
| LLM | 8089 | qmd-query-expansion-1.7B-q4_k_m | ~2.2 GB | (same as default) |
| Reranker | 8090 | [zerank-2 seq-cls sidecar](../../extras/rerankers/zerank-2-seq/) (transformers, bf16) | ~9 GB | SOTA reranker — **not** a GGUF |

```bash
# Embedding (zembed-1) — -ub MUST equal -b for non-causal attention.
# --pooling last: zembed-1 is a last-token model; declare it explicitly.
# --override-kv ...add_eos_token: last-token models read the embedding at their EOS
# anchor. If the GGUF conversion lost add_eos_token, the server never appends the
# terminator and similarity collapses to last-token identity (see troubleshooting →
# "Vector search returns weak or irrelevant results"). The override restores it and
# is a no-op when the metadata is already correct. Do NOT add these two flags to
# mean-pooling models like the default EmbeddingGemma.
llama-server -m zembed-1-Q4_K_M.gguf \
  --embeddings --pooling last \
  --override-kv tokenizer.ggml.add_eos_token=bool:true \
  --port 8088 --host 0.0.0.0 -ngl 99 -c 8192 -b 2048 -ub 2048

# Reranker (zerank-2) — seq-cls SIDECAR (transformers, bf16), NOT a llama-server GGUF:
cd extras/rerankers/zerank-2-seq
docker compose build
HF_TOKEN=hf_xxx docker compose run --rm convert   # download + convert + verify (all gates must pass)
docker compose up -d reranker                      # serves /v1/rerank on :8090
```

## Embedding (detail)

ClawMem calls the OpenAI-compatible `/v1/embeddings` endpoint for all embedding operations — works with local `llama-server` and cloud providers alike.

- **GPU with VRAM to spare:** zembed-1 (Option above) — SOTA, multilingual out of the box.
- **No GPU / limited VRAM:** EmbeddingGemma-300M-Q8_0 (Option above). For a lightweight multilingual alternative use [granite-embedding-278m-multilingual-Q6_K](https://huggingface.co/bartowski/granite-embedding-278m-multilingual-GGUF) (314 MB; set `CLAWMEM_EMBED_MAX_CHARS=1100` for its 512-token context).
- **Cloud:** any OpenAI-compatible `/v1/embeddings` provider — Jina (recommended `jina-embeddings-v5-text-small`, 1024d), OpenAI, Voyage, Cohere. Full provider matrix, batch/TPM behavior, and per-provider params are in [cloud-embedding.md](cloud-embedding.md).

```bash
# Verify an embedding endpoint is reachable
curl $CLAWMEM_EMBED_URL/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLAWMEM_EMBED_API_KEY" \
  -d "{\"input\":\"test\",\"model\":\"$CLAWMEM_EMBED_MODEL\"}"
```

## LLM server

Intent classification, query expansion, A-MEM extraction and the Stop hooks' observer (`decision-extractor`'s observations, `handoff-generator`'s summary) use [qmd-query-expansion-1.7B](https://huggingface.co/tobil/qmd-query-expansion-1.7B-gguf) — a Qwen3-1.7B finetuned by QMD for generating search-expansion terms (hyde, lexical, vector variants). ~1.1 GB at q4_k_m, served on port 8089. If `CLAWMEM_LLM_URL` is unset, `node-llama-cpp` auto-downloads it.

- **Performance (RTX 3090):** intent classification ~27 ms; query expansion ~333 tok/s; VRAM ~2.2–2.8 GB.
- **Qwen3 `/no_think`:** Qwen3 emits thinking tokens by default; ClawMem appends `/no_think` to all prompts automatically for structured output.
- **Dual-path intent:** a heuristic regex classifier handles strong why/when/who signals instantly (0.8+ confidence); the LLM refines only ambiguous queries below that threshold.
- **Context size (`-c`) — 8192 recommended (v0.41.2).** The Stop hooks' observer sizes its prompts in TOKENS against the server's own context: before each call it reads `-c` from the server's `/props` (the per-request slot context, `-c` divided by `--parallel`), counts the exact prompt the chat endpoint will see (`/apply-template`, then `/tokenize`), and keeps room for the answer — 40% of the context, at least 768 tokens, at most the 2,000 the observer allows. A turn too large for one prompt is read in several windows, each with its own answer room, and a window's progress is kept, so a later Stop or the watcher resumes it. Measured on this model's server, the fixed part of the prompt is 684 tokens, so at `-c 4096` a window holds 1,350–1,770 tokens of transcript (less the context section's share) and a tool-heavy turn takes several calls; at `-c 8192` it holds 5,090–5,500, and most turns take one. One observation's answer measured 360 tokens. Measured cost of 8192 over 4096 for this model: about +470 MiB of VRAM (2,144 → 2,612 MiB). `clawmem doctor` reports the context it read, how it counts, and how much transcript one window holds. Through v0.41.1 the prompt was bounded in characters (8,000), and a dense turn — paths, hashes, tool output — filled 4,072 of 4,096 tokens, so the answer was cut after a few words (see [troubleshooting](../troubleshooting.md#hooks)).
- **A server without `/props`, `/tokenize` or `/apply-template`** (another OpenAI-compatible server, a cloud endpoint): set `CLAWMEM_LLM_CONTEXT_TOKENS` to its context, or ClawMem assumes 4096. Without `/apply-template` the chat template's tokens are measured once from a one-token probe; without `/tokenize`, prompts are estimated conservatively (dense characters at one token each). Fits are then best-effort — a refusal for size, or an answer cut short, makes the next attempt smaller — and the doctor says so.

```bash
llama-server -m qmd-query-expansion-1.7B-q4_k_m.gguf \
  --port 8089 --host 0.0.0.0 -ngl 99 -c 8192 --batch-size 512
```

For better entity-extraction quality during `reindex --enrich`, point `CLAWMEM_LLM_URL` at a 7B+ model or cloud API (see [../internals/entity-resolution.md](../internals/entity-resolution.md)).

## Contradiction judge

**Capability floor, stated plainly:** the stock query-expansion model above cannot do
contradiction classification. Verified with a live contract probe at the production seam,
it returns an object where the contract requires an array, echoes the schema's enum text
back as a value, and fabricates confident relations between unrelated facts. That failure is
deterministic, not a tuning issue — the model is a search-expansion finetune, and judging is
a different task.

ClawMem therefore ships contradiction analysis **disabled until you configure a judge**
(v0.29.0). Without one, the `decision-extractor` hook writes an audited `no_judge_configured` run and
mutates nothing, and the merge-time gate's LLM layer is off — its deterministic heuristic
still runs (audited as `lane='heuristic'` runs), constrained to the non-deactivating `link`
policy. Nothing ever falls
back to the stock model for judging.

| Variable | Default | Effect |
|---|---|---|
| `CLAWMEM_JUDGE_URL` | (none) | Endpoint base URL. Setting it activates the judge (`openai` lane unless `_PROVIDER` says otherwise). |
| `CLAWMEM_JUDGE_PROVIDER` | `openai` when `_URL` set | `openai` \| `anthropic` \| `claude-cli`. |
| `CLAWMEM_JUDGE_MODEL` | provider-specific | **Required** on `openai`; defaults to `claude-haiku-4-5` on `anthropic`/`claude-cli`. |
| `CLAWMEM_JUDGE_API_KEY` | (none) | Bearer / `x-api-key`. On `anthropic`, falls back to `ANTHROPIC_API_KEY`. |
| `CLAWMEM_JUDGE_NO_THINK` | `false` | Judge-lane `/no_think` — only useful for a local Qwen-family judge. |
| `CLAWMEM_JUDGE_STRUCTURED` | `false` on `openai`, `true` otherwise | Schema-constrained output where the lane supports it. |

Three lanes:

```bash
# 1. Any OpenAI-compatible endpoint — cloud (OpenRouter, OpenAI, Groq, …) or
#    self-hosted (vLLM, ollama, llama-server serving a capable instruct model):
export CLAWMEM_JUDGE_URL=https://openrouter.ai/api
export CLAWMEM_JUDGE_MODEL=your-chosen-model
export CLAWMEM_JUDGE_API_KEY=YOUR_KEY_PLACEHOLDER

# 2. Anthropic Messages API directly:
export CLAWMEM_JUDGE_PROVIDER=anthropic
export CLAWMEM_JUDGE_API_KEY=YOUR_KEY_PLACEHOLDER   # or rely on ANTHROPIC_API_KEY

# 3. Your Claude Code subscription — no API key. Runs a sandboxed headless
#    `claude -p` (--safe-mode, no tools, no MCP, no session persistence):
export CLAWMEM_JUDGE_PROVIDER=claude-cli
```

**Recommended judge: `claude-haiku-4-5`** (the `anthropic`/`claude-cli` default) — the task
is a short pairwise classification (~1.5K tokens in, a few hundred out; roughly $0.003 per
evaluation at API list pricing), and the recommendation is backed by the judge evaluation
suite, not parameter count. If your `judge_runs`/`judge_events` audit rows show borderline
verdicts, `claude-sonnet-5` is the natural one-variable upgrade candidate — **use the
`anthropic` API lane for it**: the `claude-cli` lane's 20-second spawn budget (sized to fit
the Stop-hook window) suits Haiku, while Sonnet-class models with adaptive thinking can
exceed it on long candidate texts. Honest status: the preserved Sonnet artifact (CLI lane)
shows zero fabricated verdicts; contradiction recall 3/4 (one 20-second spawn timeout on
the numeric case); long-input 0/2 (one borderline `update` label, one timeout) — **no
passing API-lane artifact exists yet**, so treat Sonnet as an unverified upgrade and validate it on your own key with
the shipped harness (`eval-bundles/judge-override-2026-08-01/tooling/capability-eval.ts`).
Any sufficiently capable instruct model works through the `openai` lane — run
`clawmem doctor` to smoke-test whatever you configure.

**What configuring a judge activates:** confidence erosion on contradicted/superseded
decisions (−0.25 / −0.15, floored, reversible) goes live. Removing documents from retrieval
(`invalidated_at`) stays separately opt-in behind `CLAWMEM_CONTRADICTION_INVALIDATE`, and
`supersede` merge policy becomes available. Every mutation-authorizing evaluation commits its
audit rows in the same transaction as the mutation; Phase-3 deductive checks commit a
precondition audit first, and non-mutating outcomes write standalone rows —
[calibration guide](contradiction-invalidation.md).

**Data egress:** a cloud or subscription judge receives the new decisions and the retrieved
candidate snippets for each evaluation. Untrusted vault content travels JSON-encoded inside
per-request nonce fencing and is never passed as instructions, but it does leave the machine
— use a self-hosted `openai`-lane judge if that is unacceptable.

`clawmem doctor` runs a three-scenario **smoke test** against the configured judge (a
designed contradiction must be detected, an unrelated control must come back empty, the
merge single-pair contract must be actionable). It is an installation check, not capability
certification — precision is measured from your vault's audit rows.

## Reranker server

Cross-encoder reranking for the `query` (4000-char context, deep) and `intent_search` (200-char context, fast) pipelines on port 8090, via the `/v1/rerank` endpoint.

- **GPU with VRAM to spare:** the zerank-2 seq-cls sidecar (recipe above). **CC-BY-NC-4.0.**
- **CPU / limited VRAM:** qwen3-reranker-0.6B-Q8_0 (~600 MB, ~1.3 GB VRAM), the QMD native reranker — auto-downloaded if no server is running.

```bash
llama-server -m Qwen3-Reranker-0.6B-Q8_0.gguf \
  --reranking --port 8090 --host 0.0.0.0 -ngl 99 -c 2048 --batch-size 512
```

See the landmines above: the zerank-2 **GGUF is inert** (use the sidecar), and verify discrimination with `clawmem rerank-health`.

## Remote GPU

If the GPU lives on a separate machine, point the env vars at it and disable local fallback:

```bash
export CLAWMEM_EMBED_URL=http://gpu-host:8088
export CLAWMEM_LLM_URL=http://gpu-host:8089
export CLAWMEM_LLM_MODEL=qwen3
export CLAWMEM_RERANK_URL=http://gpu-host:8090
export CLAWMEM_NO_LOCAL_MODELS=true   # fail fast instead of auto-downloading multi-GB GGUFs
```

## Verify endpoints

```bash
curl http://host:8088/v1/embeddings -d '{"input":"test","model":"embedding"}' -H 'Content-Type: application/json'
curl http://host:8089/v1/models
curl http://host:8090/v1/models
```

## See also

- **Cloud embedding** — provider matrix, batch embedding, TPM-aware pacing, per-provider params → [cloud-embedding.md](cloud-embedding.md)
- **All environment variables** (endpoints, profiles, consolidation, merge gates) → [../reference/configuration.md](../reference/configuration.md)
- **Keeping servers up** (systemd units, GPU env in services) → [systemd-services.md](systemd-services.md)
- **Reranker health** — the degenerate-reranker failure mode and `clawmem rerank-health` → [../troubleshooting.md](../troubleshooting.md)
