# zerank-2 seq-cls reranker sidecar (SOTA, non-commercial)

A drop-in `/v1/rerank` sidecar that serves **ZeroEntropy [zerank-2](https://huggingface.co/zeroentropy/zerank-2-reranker)** — a state-of-the-art cross-encoder (NDCG@10 ≈ 0.671, ahead of Cohere rerank-3.5 and Gemini-2.5-Flash listwise) — **faithfully**, via transformers, with a reproducible correctness gate.

Point ClawMem at it and nothing else changes:

```bash
export CLAWMEM_RERANK_URL=http://<this-host>:8090
```

ClawMem's `query` and `intent_search` pipelines call `/v1/rerank` on that URL exactly as before.

---

## Why this exists (and why the GGUF is deprecated)

The previously-recommended `zerank-2-Q4_K_M.gguf` reranker is **broken** and is deprecated. zerank-2 is a `Qwen3ForCausalLM` that scores a `(query, document)` pair on the logit of a single relevance token (`"Yes"`, id `9454`) via a sentence-transformers `LogitScore` head. llama.cpp's `convert_hf_to_gguf.py` only synthesizes a rerank head when it finds the literal string `# Qwen3-Reranker` in the model card — zerank-2's card lacks it, so the previously-recommended GGUF (and anything built by the current/standard llama.cpp converter path) is a **headless causal LM**. Served under `--reranking` it produces near-zero, uninformative scores → reranking degrades to an inert RRF-dominated passthrough, silently.

This recipe sidesteps GGUF entirely. Because zerank-2 uses **tied embeddings**, the relevance logit `hidden · embed_tokens.weight[9454]` is reproduced **exactly** by a standard `Qwen3ForSequenceClassification` whose `num_labels=1` score head is that one embedding row. We convert to that form, **prove** the conversion is bit-exact, and serve it with the model's real chat template and `sigmoid(logit/5)` calibration.

> **License:** zerank-2 is **CC-BY-NC-4.0 (non-commercial)**. This recipe is MIT code; it **never bundles the weights** — `build_and_verify.py` downloads them for *your own* non-commercial use. ClawMem's default reranker stays the permissively-licensed `qwen3-reranker-0.6B`; this is an opt-in upgrade.

---

## Requirements

- An NVIDIA GPU with **~9 GiB free VRAM** (bf16) for the reranker. A 12 GB card is comfortable for the sidecar **alone**; budget **16 GB+** for the full co-located SOTA stack (embedding + LLM + reranker).
- **NVIDIA Container Toolkit** (for `--gpus`/`docker compose` GPU access).
- A Hugging Face account that has **accepted the zerank-2 license**, and an `HF_TOKEN` for the one-off convert step.

---

## Quick start (Docker Compose)

```bash
cd extras/rerankers/zerank-2-seq
docker compose build

# One-off: download + convert + run ALL correctness gates into ./models/zerank-2-seq
HF_TOKEN=hf_xxx docker compose run --rm convert

# Serve on :8090 (boot-persistent)
docker compose up -d reranker

# Verify
curl -s localhost:8090/health
curl -s -X POST localhost:8090/v1/rerank -H 'Content-Type: application/json' \
  -d '{"query":"capital of France","documents":["Paris is the capital of France.","Bananas grow in the tropics."]}'
# -> relevant ~0.96, irrelevant ~0.08
```

Then set `CLAWMEM_RERANK_URL=http://<this-host>:8090` for ClawMem (see the main README's *GPU Services*).

The convert step **refuses to finish unless every gate passes** (`RESULT PASS`, exit 0). If a gate fails it exits non-zero and does not leave a half-baked model serving.

---

## What the gate proves

`build_and_verify.py` is the correctness proof — it converts, then asserts:

| Gate | Asserts |
|---|---|
| **GATE 1** | the score-head row equals `lm_head[9454]` in fp32, saved as bf16 (no silent fp16 downcast) |
| **GATE 1.5** | the served tokenizer == the source tokenizer (formatted strings + token ids + `encode_pair` through truncation); the transformers `fix_mistral_regex` warning is benign |
| **GATE-AP** | the assistant-generation prefix survives even a near-`MAXLEN` input (truncating it would move the scored position) |
| **GATE 2** | the seq-cls logit equals the causal model's token-9454 logit **bit-exactly** over the real served path, incl. batched right-padded pooling and empty/whitespace-doc edges |

It runs against the source model, so it verifies **any** copy of the weights — see the two source paths below.

---

## Two ways to get the weights

1. **Reproduce (trustless, default).** `build_and_verify.py` downloads `zeroentropy/zerank-2-reranker` and performs the conversion itself, then gates it. You trust only ZeroEntropy's official weights + this MIT code.
2. **Pull a pre-converted upload, then verify it.** A community conversion exists at [`baseten-admin/zerank-2-reranker-seq`](https://huggingface.co/baseten-admin/zerank-2-reranker-seq). Download it into `./models/zerank-2-seq`, then run the gate in **verify-only** mode — it skips conversion but still downloads the official `ZR_SRC` to prove the seq-cls logits match: `ZR_VERIFY_ONLY=1 HF_TOKEN=hf_xxx docker compose run --rm convert`. The gate verifies whatever you point `ZR_OUT` at, and **fails a bad upload** (e.g. one converted on the wrong token).

---

## How it works

- **Conversion** (`build_and_verify.py`): copy `embed_tokens.weight[9454]` into a `Linear(hidden, 1, bias=False)` score head of `Qwen3ForSequenceClassification(num_labels=1)`, in **bf16**. Tied embeddings make this logit identical to the native causal score by construction.
- **Serving** (`server.py`): `batch=1` (deterministic, no padding drift), applies zerank's chat template (`query`→system, `document`→user, assistant prefix), returns `sigmoid(logit/5)` — the native calibration.
- **Shared encoder** (`zr_common.py`): the gate and the server import the *same* `encode_pair`, so served scores == gated scores by construction, and the assistant prefix is never truncated.

---

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `ZR_SRC` | `zeroentropy/zerank-2-reranker` | source model to convert |
| `ZR_OUT` | `/models/zerank-2-seq` | converted seq-cls model path (mounted volume) |
| `ZR_PORT` | `8090` | sidecar port |
| `ZR_TEMP` | `5.0` | calibration temperature → `sigmoid(logit/ZR_TEMP)` |
| `ZR_MAXLEN` | `8192` | max tokens per pair (doc tail truncated to fit; prefix preserved) |
| `HF_TOKEN` | — | required for the convert download (gated model) |

---

## Rollback

This sidecar only occupies `:8090` and speaks the standard contract, so reverting is just pointing `CLAWMEM_RERANK_URL` back at your previous reranker (e.g. a `qwen3-reranker-0.6B` `llama-server`) and stopping the container:

```bash
docker compose down
```
