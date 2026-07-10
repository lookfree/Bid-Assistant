"""spec316 A1: 资料库 RAG 索引路由——App CRUD 钩子 best-effort 调用,失败绝不阻塞调用方。"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.config import settings
from agent.db import get_pool
from agent.rag import store
from agent.rag.chunker import chunk
from agent.rag.embedder import Embedder

logger = logging.getLogger(__name__)

router = APIRouter()

embedder = Embedder(settings.rag_embed_endpoint)


class IndexBody(BaseModel):
    user_id: str
    source_type: str
    source_id: str
    title: str = ""
    text: str


@router.post("/rag/index")
async def index_source(body: IndexBody):
    """删旧 chunks -> 切块 -> embed -> upsert -> {chunks:n}；禁用态 {chunks:0,disabled:true}（200）。"""
    if not await embedder.health():
        return {"chunks": 0, "disabled": True}
    content = f"{body.title}\n{body.text}" if body.title else body.text
    chunks = chunk(content)
    if not chunks:
        return {"chunks": 0}
    try:
        vectors = await embedder.embed(chunks)
        metas = [{} for _ in chunks]
        # store.upsert 是同步的（DELETE + 逐 chunk INSERT），大文档丢线程池避免卡 event loop（SSE 断流）。
        n = await asyncio.to_thread(store.upsert, get_pool(), body.user_id,
                                     body.source_type, body.source_id, chunks, vectors, metas)
    except Exception as e:  # noqa: BLE001 embed/store 故障对调用方可读,不裸崩
        logger.warning("rag index failed source_type=%s source_id=%s",
                        body.source_type, body.source_id, exc_info=True)
        return JSONResponse({"chunks": 0, "error": str(e)[:200]}, status_code=500)
    return {"chunks": n}


@router.delete("/rag/index/{source_type}/{source_id}")
async def delete_index(source_type: str, source_id: str, user_id: str):
    """按属主删除；user_id 不匹配的行不受影响（store.delete 内已带 user_id 条件）。"""
    await asyncio.to_thread(store.delete, get_pool(), user_id, source_type, source_id)
    return {"ok": True}
