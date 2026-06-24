#!/usr/bin/env python3
"""Shared formatting + token-budgeting for the zerank-2 seq-cls reranker.
Imported by BOTH build_and_verify.py (the gate) and server.py (serving) so the gated path and the
served path are identical BY CONSTRUCTION.

Guarantees the assistant-generation prefix is NEVER truncated: truncating it would move the scored/pooled
position off the assistant prefix -> wrong score. We right-truncate the DOCUMENT
tail (then the QUERY tail if needed) BEFORE templating, leaving room for the template scaffold + assistant
prefix, with a final left-truncation belt so the prefix (always at the end) survives any re-encode overshoot."""

ASSISTANT_PREFIX = "<|im_start|>assistant\n"


def format_pair(tok, query, document):
    return tok.apply_chat_template(
        [{"role": "query", "content": query}, {"role": "document", "content": document}],
        tokenize=False, add_generation_prompt=True)


def _ids(tok, text):
    return tok(text, add_special_tokens=False)["input_ids"]


def encode_pair(tok, query, document, max_total_tokens=8192, device="cpu", safety=16):
    """Return a tokenized (query, document) pair whose total length <= max_total_tokens and whose tail is
    always the assistant prefix. Truncates document tail first, then query tail, then (belt) left-truncates."""
    scaffold = len(_ids(tok, format_pair(tok, "", "")))
    avail = max(2, max_total_tokens - scaffold - safety)
    q_ids = _ids(tok, query)
    if len(q_ids) > avail - 1:                      # cap query so a document always has room
        q_ids = q_ids[:avail - 1]
        query = tok.decode(q_ids)
    d_budget = max(1, avail - len(q_ids))
    d_ids = _ids(tok, document)
    if len(d_ids) > d_budget:                        # truncate the document TAIL (least-important part)
        d_ids = d_ids[:d_budget]
        document = tok.decode(d_ids)
    text = format_pair(tok, query, document)
    enc = tok(text, return_tensors="pt", add_special_tokens=False)
    if enc["input_ids"].shape[1] > max_total_tokens:  # belt: keep the LAST tokens -> assistant prefix survives
        enc = {k: v[:, -max_total_tokens:] for k, v in enc.items()}
        return {k: v.to(device) for k, v in enc.items()}
    return enc.to(device)
