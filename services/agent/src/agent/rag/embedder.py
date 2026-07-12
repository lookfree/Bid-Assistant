"""spec316 A1: OpenAI 兼容 /v1/embeddings HTTP 客户端——纯 HTTP，不引入 torch 等重依赖。
探活失败/持续出错时由调用方（路由/节点）据 health() 结果降级，不在此处兜底吞错。
"""
from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)

BATCH_SIZE = 16
EMBED_TIMEOUT_S = 10
HEALTH_TIMEOUT_S = 3
# 批间并发上限:9273 条款的大标书 = 580 批,串行打 HK 端点(WireGuard RTT ~1s+)实测拖满 ~10 分钟,
# 读标结果因此迟迟不交付。8 路并发把墙钟压到 ~1.5 分钟;上限防打爆嵌入服务。
EMBED_CONCURRENCY = 8


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
        """批量 <=BATCH_SIZE 条/请求，批间 EMBED_CONCURRENCY 路并发（gather 保序，向量与输入一一对应）。
        失败原样抛出，由调用方 best-effort 兜。"""
        if not texts:
            return []
        batches = [texts[i:i + BATCH_SIZE] for i in range(0, len(texts), BATCH_SIZE)]
        sem = asyncio.Semaphore(EMBED_CONCURRENCY)
        async with httpx.AsyncClient(timeout=EMBED_TIMEOUT_S) as client:
            async def _one(batch: list[str]) -> list[list[float]]:
                async with sem:
                    resp = await client.post(self.endpoint, json={"input": batch})
                    resp.raise_for_status()
                    return [item["embedding"] for item in resp.json()["data"]]
            results = await asyncio.gather(*[_one(b) for b in batches])
        return [vec for r in results for vec in r]
