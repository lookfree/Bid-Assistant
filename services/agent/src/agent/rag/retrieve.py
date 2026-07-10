"""spec316 A2: RAG 检索——从 library(+可选 tender)取相关片段拼参考资料段，
供 content/rewrite 节点注入生成提示词。所有失败均降级为空字符串/False（best-effort，
绝不阻塞生成主链路——这是本模块唯一的硬约束）。"""
from __future__ import annotations

import asyncio
import logging

from agent.config import settings
from agent.db import get_pool
from agent.rag import store
from agent.rag.embedder import Embedder

logger = logging.getLogger(__name__)

REF_HEADER = "【参考资料·仅供撰写引用】"
_TENDER_TOP_K = 2

embedder = Embedder(settings.rag_embed_endpoint)


async def rag_enabled(user_id: str | None, run_input: dict | None) -> bool:
    """RAG 生效前置：run_input.rag.enabled 配置开 + user_id 存在 + embedder 健康，三者皆满足才生效；
    任一不满足 → False（调用方据此跳过 RAG，生成照常，降级铁律）。"""
    if not user_id or not (run_input or {}).get("rag", {}).get("enabled"):
        return False
    return await embedder.health()


async def build_reference_block(user_id: str, queries: list[str], top_k: int,
                                 budget: int = 2000, tender_thread_id: str | None = None) -> str:
    """检索 library(+可选 tender)命中，拼成【参考资料·仅供撰写引用】段（总字数 <=budget）。
    embed 失败/无命中 → 返回 ""（不注入）。整个函数 try/except 兜底返回 ""——
    检索故障绝不能阻塞生成主流程（best-effort）。"""
    try:
        return await _build(user_id, queries, top_k, budget, tender_thread_id)
    except Exception:  # noqa: BLE001 best-effort：任何异常都降级为空块，不向上抛
        logger.warning("rag build_reference_block degraded to empty", exc_info=True)
        return ""


async def _build(user_id: str, queries: list[str], top_k: int,
                  budget: int, tender_thread_id: str | None) -> str:
    # 逐 query 各 embed 一个向量（一次批量请求返回 N 个）：多章文档要跨章检索广度，
    # 合成一个平均向量会把相关性拉平。
    clean = [q for q in queries if q and q.strip()]
    if not clean:
        return ""
    vectors = await embedder.embed(clean)
    if not vectors:
        return ""
    pool = get_pool()
    # library 逐向量各查、UNION（source_id=None 取该用户全部资料库）；_format_block 统一去重+排序+截断。
    hits: list[dict] = []
    for vec in vectors:
        hits += await asyncio.to_thread(store.search, pool, user_id, "library", vec, top_k)
    # tender 只查一次、按 thread 隔离（per-project source_id）：招标原文取首个 query 向量作代表即可。
    if tender_thread_id:
        hits += await asyncio.to_thread(
            store.search, pool, user_id, "tender", vectors[0], _TENDER_TOP_K, tender_thread_id)
    return _format_block(hits, budget)


def _format_block(hits: list[dict], budget: int) -> str:
    """按 score 降序去重拼行；累计字数（含表头）不超过 budget，超出即截断不再往下拼。"""
    seen: set[str] = set()
    lines: list[str] = []
    total = len(REF_HEADER)
    for hit in sorted(hits, key=lambda h: h.get("score") or 0, reverse=True):
        text = (hit.get("text") or "").strip()
        if not text or text in seen:
            continue
        line = f"- {text}"
        if total + len(line) + 1 > budget:
            break
        seen.add(text)
        lines.append(line)
        total += len(line) + 1
    if not lines:
        return ""
    return "\n".join([REF_HEADER, *lines])
