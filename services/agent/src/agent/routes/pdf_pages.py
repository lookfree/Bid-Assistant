"""资料库 PDF 转页图(spec 2026-08-08-library-pdf-pages)。

同步工具路由(参照 routes/chapters.py 的形态):App API 中转调用,agent 只做
"MinIO 取 PDF → 渲染 → 页图写回 MinIO",不建文件记录、不碰计费(money-blind)。
"""
from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.agents.bidding_agent.render.preview import (
    TooManyPages, UnrenderablePdf, render_pdf_pages)
from agent.parsing.storage_read import storage

router = APIRouter()


class PdfPagesBody(BaseModel):
    key: str          # MinIO 对象键(App API 已做归属校验,这里只管渲染)


@router.post("/tools/pdf-pages")
async def pdf_pages(body: PdfPagesBody):
    """PDF → 逐页 PNG 写回 MinIO(derived/<uuid>/page-N.png),返回页键与尺寸。
    渲染是 CPU 活,丢线程池,别卡事件循环(本进程还serving改写/审核表)。"""
    pdf = await storage.read_bytes(body.key)
    try:
        pages = await asyncio.to_thread(render_pdf_pages, pdf)
    except TooManyPages:
        return JSONResponse({"error": "too_many_pages"}, status_code=422)
    except UnrenderablePdf:
        return JSONResponse({"error": "unrenderable"}, status_code=422)
    batch = uuid.uuid4()
    out = []
    for i, (png, w, h) in enumerate(pages, start=1):
        key = f"derived/{batch}/page-{i}.png"
        await storage.put_bytes(key, png, content_type="image/png")
        out.append({"key": key, "width": w, "height": h})
    return {"pages": out}
