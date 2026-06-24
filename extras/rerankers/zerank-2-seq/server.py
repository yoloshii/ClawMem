#!/usr/bin/env python3
"""ClawMem zerank-2 seq-cls reranker sidecar. Drop-in for CLAWMEM_RERANK_URL.
POST /v1/rerank {query, documents:[...]} -> {results:[{index, relevance_score}]}.
Uses zr_common.encode_pair (the SAME path the build gate verified) -> served scores == gated scores by
construction, and the assistant prefix is never truncated. batch=1 -> deterministic, drift-free scores."""
import os, sys, math, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from zr_common import encode_pair

MODEL = os.environ.get("ZR_OUT", "/models/zerank-2-seq")
TEMP = float(os.environ.get("ZR_TEMP", "5.0"))
MAXLEN = int(os.environ.get("ZR_MAXLEN", "8192"))
DEV = "cuda" if torch.cuda.is_available() else "cpu"

tok = AutoTokenizer.from_pretrained(MODEL); tok.padding_side = "right"
model = AutoModelForSequenceClassification.from_pretrained(MODEL, num_labels=1, torch_dtype=torch.bfloat16).to(DEV).eval()
if model.config.pad_token_id is None:
    model.config.pad_token_id = tok.pad_token_id or tok.convert_tokens_to_ids("<|endoftext|>")

app = FastAPI()

class RerankReq(BaseModel):
    query: str
    documents: list[str]

@app.post("/v1/rerank")
@torch.no_grad()
def rerank(req: RerankReq):
    results = []
    for i, d in enumerate(req.documents):                       # batch=1: deterministic, no padding drift
        enc = encode_pair(tok, req.query, d, max_total_tokens=MAXLEN, device=DEV)
        lg = model(**enc).logits.reshape(-1)[0].float().item()
        results.append({"index": i, "relevance_score": 1.0 / (1.0 + math.exp(-lg / TEMP))})
    return {"results": results}

@app.get("/v1/models")
def models():
    return {"models": [{"id": "zerank-2-seq", "object": "model"}]}

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL, "device": DEV}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ZR_PORT", "8090")))
