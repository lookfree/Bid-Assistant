"""spec316 A1: OpenAI 兼容 /v1/embeddings HTTP 客户端——纯 HTTP，不引入 torch 等重依赖。
探活失败/持续出错时由调用方（路由/节点）据 health() 结果降级，不在此处兜底吞错。
"""
from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)

BATCH_SIZE = 16
EMBED_TIMEOUT_S = 10
HEALTH_TIMEOUT_S = 3


class Embedder:
    def __init__(self, endpoint: str):
        self.endpoint = endpoint
        # endpoint 形如 http://host:port/v1/embeddings，探活打同源 /health
        self._health_url = endpoint.rsplit("/v1/embeddings", 1)[0] + "/health"

    async def health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=HEALTH_TIMEOUT_S) as client:
                resp = await client.get(self._health_url)
                return resp.status_code == 200
        except Exception:  # noqa: BLE001 探活失败一律视为不可用，不向上抛
            logger.warning("rag embedder health probe failed url=%s", self._health_url, exc_info=True)
            return False

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """批量 <=BATCH_SIZE 条/请求；超出自动分批。失败原样抛出，由调用方 best-effort 兜。"""
        if not texts:
            return []
        vectors: list[list[float]] = []
        async with httpx.AsyncClient(timeout=EMBED_TIMEOUT_S) as client:
            for i in range(0, len(texts), BATCH_SIZE):
                batch = texts[i:i + BATCH_SIZE]
                resp = await client.post(self.endpoint, json={"input": batch})
                resp.raise_for_status()
                data = resp.json()["data"]
                vectors.extend(item["embedding"] for item in data)
        return vectors
