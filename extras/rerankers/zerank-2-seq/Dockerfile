# ClawMem zerank-2 seq-cls reranker sidecar.
# Serves zeroentropy/zerank-2-reranker as a faithful Qwen3ForSequenceClassification cross-encoder
# (the llama.cpp GGUF route drops zerank's score head; this serves the real one via transformers).
#
# LICENSE: this image bundles only the MIT recipe code. zerank-2's WEIGHTS are Apache-2.0
# (relicensed by ZeroEntropy on 2026-07-24) and are downloaded at convert time — never bundled here.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

RUN pip install --no-cache-dir \
      "transformers>=4.51" \
      "huggingface_hub>=0.24" \
      "uvicorn[standard]" \
      fastapi \
      safetensors \
      accelerate

WORKDIR /app
COPY zr_common.py build_and_verify.py server.py /app/

ENV ZR_OUT=/models/zerank-2-seq \
    ZR_PORT=8090 \
    ZR_TEMP=5.0 \
    ZR_MAXLEN=8192

EXPOSE 8090
CMD ["python3", "server.py"]
