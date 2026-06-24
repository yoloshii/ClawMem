#!/usr/bin/env python3
"""Reproduce zerank-2 -> Qwen3ForSequenceClassification(num_labels=1), bf16, token 9454, then GATE.
GATE1   : fp32 weight-equality (score row == lm_head[9454], bf16 preserved).
GATE1.5 : served-tokenizer path identity  -> OUT tok == SRC tok: (a) formatted-string + ids,
          (b) encode_pair(SRC)==encode_pair(OUT) INCLUDING the truncation path,
          (c) fix_mistral_regex default-vs-flag token-id identity (persisted).
GATE-AP : assistant-prefix preserved under near-MAXLEN via encode_pair.
GATE2   : runtime FIDELITY (seq-cls logit == causal token-9454 logit) over the EXACT served path
          (OUT tokenizer + encode_pair, batch=1) + a batched right-padded pooling check + edge cases.
Exit 0 only if every gate passes. Runs in the provided Dockerfile image (torch + transformers + CUDA)."""
import os, sys, gc, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch
from transformers import AutoModelForCausalLM, AutoModelForSequenceClassification, AutoTokenizer
from zr_common import format_pair, encode_pair, ASSISTANT_PREFIX

SRC = os.environ.get("ZR_SRC", "zeroentropy/zerank-2-reranker")
OUT = os.environ.get("ZR_OUT", "/models/zerank-2-seq")
TOKEN_ID = 9454
TEMP = 5.0
MAXLEN = int(os.environ.get("ZR_MAXLEN", "8192"))
DEV = "cuda" if torch.cuda.is_available() else "cpu"
VERIFY_ONLY = os.environ.get("ZR_VERIFY_ONLY", "").lower() in ("1", "true", "yes")  # gate an existing OUT (e.g. a pulled upload) without re-converting
def log(*a): print("[build]", *a, flush=True)

# ---- Phase A: convert (CPU, bf16, explicit token 9454) — skipped under ZR_VERIFY_ONLY ----
if VERIFY_ONLY:
    if not os.path.isdir(OUT):
        log(f"ZR_VERIFY_ONLY set but {OUT} does not exist — nothing to verify"); sys.exit(2)
    log(f"ZR_VERIFY_ONLY: skipping conversion; gating the existing model at {OUT} against {SRC}")
else:
    log(f"loading causal {SRC} (bf16, cpu)")
    causal = AutoModelForCausalLM.from_pretrained(SRC, torch_dtype=torch.bfloat16)
    assert causal.lm_head.bias is None
    assert getattr(causal.config, "tie_word_embeddings", False)
    hidden = causal.lm_head.in_features
    row = causal.lm_head.weight[TOKEN_ID].detach().clone()
    log(f"extracted lm_head row {TOKEN_ID}: shape={tuple(row.shape)} dtype={row.dtype}")
    del causal; gc.collect()

    log("loading seq-cls backbone (bf16, cpu, num_labels=1)")
    seq = AutoModelForSequenceClassification.from_pretrained(SRC, num_labels=1, torch_dtype=torch.bfloat16)
    lin = torch.nn.Linear(hidden, 1, bias=False, dtype=torch.bfloat16)
    with torch.no_grad():
        lin.weight.copy_(row.unsqueeze(0))
    seq.score = lin
    seq.config.num_labels = 1
    seq.config.id2label = {0: "relevant"}; seq.config.label2id = {"relevant": 0}
    tok = AutoTokenizer.from_pretrained(SRC)
    pad_id = tok.pad_token_id if tok.pad_token_id is not None else tok.convert_tokens_to_ids("<|endoftext|>")
    seq.config.pad_token_id = pad_id
    tok.padding_side = "right"
    log(f"pad_token_id={pad_id} padding_side=right score.weight.dtype={seq.score.weight.dtype}")
    os.makedirs(OUT, exist_ok=True)
    seq.save_pretrained(OUT); tok.save_pretrained(OUT)
    log(f"saved seq-cls -> {OUT}")
    del seq; gc.collect()

# ---- GATE 1: fp32 weight equality ----
log("GATE1: reload + fp32 weight equality")
c2 = AutoModelForCausalLM.from_pretrained(SRC, torch_dtype=torch.bfloat16)
src_row = c2.lm_head.weight[TOKEN_ID].float().cpu(); del c2; gc.collect()
s2 = AutoModelForSequenceClassification.from_pretrained(OUT, num_labels=1, torch_dtype=torch.bfloat16)
saved_dtype = s2.score.weight.dtype
saved_row = s2.score.weight[0].float().cpu(); del s2; gc.collect()
maxd1 = (src_row - saved_row).abs().max().item()
gate1 = maxd1 < 1e-7
log(f"GATE1 saved_score_dtype={saved_dtype} weight_maxdiff(fp32)={maxd1:.3e} -> {'PASS' if gate1 else 'FAIL'}")
if not gate1:
    log("GATE1 FAIL — aborting."); sys.exit(2)

PAIRS = [
    ("What is the capital of France?", "The capital of France is Paris."),
    ("What is the capital of France?", "Bananas are rich in potassium and grow in tropical climates."),
    ("How do I configure TLS in nginx?", "In nginx set ssl_certificate and ssl_certificate_key in the server block on 443, then reload."),
    ("python async database connection pooling", "asyncpg exposes create_pool; set min_size/max_size and acquire via 'async with pool.acquire()'."),
    ("short q", "x"),
    ("distributed consensus and leader election in raft", ("Raft elects a leader via randomized election timeouts. " * 12)[:400]),
    ("empty doc edge", ""),
    ("whitespace doc edge", "   "),
]

# ---- GATE 1.5: served-tokenizer path identity (OUT == SRC) ----
src_tok = AutoTokenizer.from_pretrained(SRC); src_tok.padding_side = "right"
out_tok = AutoTokenizer.from_pretrained(OUT); out_tok.padding_side = "right"
pad_id = out_tok.pad_token_id if out_tok.pad_token_id is not None else out_tok.convert_tokens_to_ids("<|endoftext|>")  # set here so GATE2 has it under ZR_VERIFY_ONLY too
# (a) formatted-string + token-id identity
tokpath_ok = True
for q, d in PAIRS:
    s_str, o_str = format_pair(src_tok, q, d), format_pair(out_tok, q, d)
    if (s_str != o_str) or (src_tok(s_str, add_special_tokens=False)["input_ids"] != out_tok(o_str, add_special_tokens=False)["input_ids"]):
        tokpath_ok = False; log(f"  GATE1.5a MISMATCH q={q!r}")
log(f"GATE1.5a served==source tokenizer (string+ids) -> {'PASS' if tokpath_ok else 'FAIL'}")
# (b) encode_pair(SRC) == encode_pair(OUT) INCLUDING the truncation path (gate path == served path)
ep_ok = True
ep_pairs = PAIRS + [("very long query " + "stress " * 3000, "document body " + "lorem ipsum " * 6000)]
for q, d in ep_pairs:
    a = encode_pair(src_tok, q, d, max_total_tokens=MAXLEN)["input_ids"].tolist()
    b = encode_pair(out_tok, q, d, max_total_tokens=MAXLEN)["input_ids"].tolist()
    if a != b: ep_ok = False; log(f"  GATE1.5b encode_pair MISMATCH q[:30]={q[:30]!r} lens {len(a[0])} vs {len(b[0])}")
log(f"GATE1.5b encode_pair(SRC)==encode_pair(OUT) incl truncation -> {'PASS' if ep_ok else 'FAIL'}")
# (c) fix_mistral_regex default-vs-flag token-id identity (the transformers warning is benign if 0 diffs)
try:
    fix_tok = AutoTokenizer.from_pretrained(OUT, fix_mistral_regex=True); fix_flag = "supported"
except TypeError as e:
    fix_tok = None; fix_flag = f"UNSUPPORTED({type(e).__name__})"
regex_diffs = 0
for q, d in PAIRS:
    base = out_tok(format_pair(out_tok, q, d), add_special_tokens=False)["input_ids"]
    cmp = (fix_tok or out_tok)(format_pair((fix_tok or out_tok), q, d), add_special_tokens=False)["input_ids"]
    if base != cmp: regex_diffs += 1
mixed = "cafe naive 2026 x=1;y=2 https://a.b/c?q=1 path/to::thing emoji"
mixed_diff = out_tok(mixed, add_special_tokens=False)["input_ids"] != (fix_tok or out_tok)(mixed, add_special_tokens=False)["input_ids"]
regex_ok = (regex_diffs == 0) and (not mixed_diff)
log(f"GATE1.5c fix_mistral_regex flag={fix_flag} pair_id_diffs={regex_diffs} mixed_diff={mixed_diff} -> {'BENIGN/PASS' if regex_ok else 'MATERIAL/FAIL'}")

# ---- GATE-AP: assistant-prefix preserved under near-MAXLEN input ----
ap_ids = out_tok(ASSISTANT_PREFIX, add_special_tokens=False)["input_ids"]
long_doc = "lorem ipsum dolor sit amet consectetur " * 4000
enc_long = encode_pair(out_tok, "very long reranking stress-test query " * 200, long_doc, max_total_tokens=MAXLEN, device="cpu")
long_ids = enc_long["input_ids"][0].tolist()
ap_ok = (len(long_ids) <= MAXLEN) and (long_ids[-len(ap_ids):] == ap_ids)
log(f"GATE-AP near-MAXLEN: len={len(long_ids)}<= {MAXLEN} and tail==assistant_prefix -> {'PASS' if ap_ok else 'FAIL'}")

# ---- GATE 2: runtime fidelity over the EXACT served path (OUT tokenizer + encode_pair) + batched pooling ----
log("GATE2: loading causal on GPU")
c3 = AutoModelForCausalLM.from_pretrained(SRC, torch_dtype=torch.bfloat16).to(DEV).eval()
causal_served, causal_single, causal_batched = [], [], []
with torch.no_grad():
    for q, d in PAIRS:
        enc = encode_pair(out_tok, q, d, max_total_tokens=MAXLEN, device=DEV)     # EXACT served path (OUT tok)
        li = int(enc["attention_mask"][0].sum().item()) - 1
        causal_served.append(c3(**enc).logits[0, li, TOKEN_ID].float().item())
    texts = [format_pair(out_tok, q, d) for q, d in PAIRS]
    for t in texts:
        e = out_tok(t, return_tensors="pt", add_special_tokens=False).to(DEV)
        causal_single.append(c3(**e).logits[0, -1, TOKEN_ID].float().item())
    eb = out_tok(texts, return_tensors="pt", padding=True, add_special_tokens=False).to(DEV)
    ob = c3(**eb).logits; last = eb["attention_mask"].sum(1) - 1
    causal_batched = [ob[i, last[i], TOKEN_ID].float().item() for i in range(len(texts))]
del c3; gc.collect(); torch.cuda.empty_cache()

log("GATE2: loading seq-cls on GPU")
s3 = AutoModelForSequenceClassification.from_pretrained(OUT, num_labels=1, torch_dtype=torch.bfloat16).to(DEV).eval()
s3.config.pad_token_id = pad_id
seq_served, seq_single, seq_batched = [], [], []
with torch.no_grad():
    for q, d in PAIRS:
        enc = encode_pair(out_tok, q, d, max_total_tokens=MAXLEN, device=DEV)     # EXACT served path (OUT tok)
        seq_served.append(s3(**enc).logits.reshape(-1)[0].float().item())
    for t in texts:
        e = out_tok(t, return_tensors="pt", add_special_tokens=False).to(DEV)
        seq_single.append(s3(**e).logits.reshape(-1)[0].float().item())
    eb = out_tok(texts, return_tensors="pt", padding=True, add_special_tokens=False).to(DEV)
    seq_batched = s3(**eb).logits.reshape(-1).float().tolist()
del s3; gc.collect(); torch.cuda.empty_cache()

def sig(x): return 1.0 / (1.0 + math.exp(-x / TEMP))
max_served = max_eqB = max_eqS = max_dS = max_dC = 0.0
log("idx servd(prod) seqServd eqServed eqB|seqB-causalB| eqS|seq1-causal1| driftSeq driftCausal score")
for i, (q, d) in enumerate(PAIRS):
    eqSrv = abs(seq_served[i] - causal_served[i])      # PRODUCTION path fidelity (OUT tok + encode_pair, batch=1)
    eqB = abs(seq_batched[i] - causal_batched[i]); eqS = abs(seq_single[i] - causal_single[i])
    dS = abs(seq_batched[i] - seq_single[i]); dC = abs(causal_batched[i] - causal_single[i])
    max_served = max(max_served, eqSrv); max_eqB = max(max_eqB, eqB); max_eqS = max(max_eqS, eqS)
    max_dS = max(max_dS, dS); max_dC = max(max_dC, dC)
    log(f"{i:>3} {causal_served[i]:+8.3f} {seq_served[i]:+8.3f}  {eqSrv:.1e}    {eqB:.1e}        {eqS:.1e}    {dS:.1e}  {dC:.1e}  {sig(seq_served[i]):.4f}")

TOL = 1e-3
gate2 = (max_served < TOL) and (max_eqB < TOL) and (max_eqS < TOL)
log(f"GATE2 FIDELITY served={max_served:.2e} batched={max_eqB:.2e} single={max_eqS:.2e} TOL={TOL} -> {'PASS' if gate2 else 'FAIL'}")
log(f"INFO backbone padding drift max|seqB-seq1|={max_dS:.2e} ~= max|causalB-causal1|={max_dC:.2e} (shared bf16 right-pad)")
log(f"SANITY relevant>irrelevant: {sig(seq_served[0]):.4f} > {sig(seq_served[1]):.4f} -> {'OK' if seq_served[0] > seq_served[1] else 'WARN'}")
allpass = gate1 and tokpath_ok and ep_ok and regex_ok and ap_ok and gate2
log(f"GATES gate1={gate1} tokpath={tokpath_ok} encode_pair_id={ep_ok} fix_mistral_regex={regex_ok} assistant_prefix={ap_ok} gate2={gate2}")
print("RESULT", "PASS" if allpass else "FAIL", flush=True)
sys.exit(0 if allpass else 3)
