"""自建 BGE-M3 嵌入服务（客户验证环境）。
OpenAI 兼容 /v1/embeddings：请求 {"input": [文本...]}，返回 data[].embedding（dense 1024，已归一化）。
/health 就绪返回 200，供 agent 侧 Embedder 探活降级。与仓库 rag/embedder.py 契约一致。
"""
import os
from fastapi import FastAPI, Response
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
app = FastAPI(title="bge-embed")
_model: SentenceTransformer | None = None


@app.on_event("startup")
def _load() -> None:
    global _model
    # 首次启动从 HF 镜像下载权重（HF_ENDPOINT），缓存到挂载卷 HF_HOME
    _model = SentenceTransformer(MODEL_NAME, device="cpu")


@app.get("/health")
def health(response: Response):
    if _model is None:
        response.status_code = 503
        return {"status": "loading"}
    return {"status": "ok", "model": MODEL_NAME}


class EmbedRequest(BaseModel):
    input: list[str]


@app.post("/v1/embeddings")
def embeddings(req: EmbedRequest):
    vecs = _model.encode(req.input, normalize_embeddings=True, batch_size=16)
    return {
        "object": "list",
        "model": MODEL_NAME,
        "data": [
            {"object": "embedding", "index": i, "embedding": v.tolist()}
            for i, v in enumerate(vecs)
        ],
    }
