from __future__ import annotations

import re

from fastapi import APIRouter
from pydantic import BaseModel, Field

from agent.agents.bidding_agent.nodes.common import fetch_master_bytes
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.parsing.storage_read import storage

# POST /render/deck：从 App 存库的 deck 确定性重渲述标 .pptx，落回 present 节点用的同一个 key。
# 无 LLM、不进 thread、不涉计费，与 /render/checklist 同范式（agent 落 MinIO 返 key，App 预签名）。
#
# 为什么需要它：述标页的「导出」只是取预签名 URL 直下已存对象，编辑器里改完 deck 再导出仍是旧 PPT；
# 而「用户自己上传标书」那条（review-kind）连 export 步都被拒，没有任何路径能重渲。到这一层，标书
# 来自流水线正文还是用户上传已经无所谓——都只是一个 deck，所以两条入口共用这一个接口。

router = APIRouter()

_PPTX_CT = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
# thread_id 直接拼进对象 key，只放行「字母数字 . _ -」——'../' 或 '/' 能覆盖别人的对象。
_THREAD_ID = re.compile(r"^[A-Za-z0-9._-]+$")


class DeckRenderBody(BaseModel):
    thread_id: str                                  # 决定产物 key：artifacts/<thread_id>/present.pptx
    deck: dict                                      # DeckSpec 形状（snake_case），App 原样透传
    template: str | None = None                     # 覆盖 deck.template（blue/tech/gov）
    enterprise_template_key: str | None = Field(default=None)   # 企业自有母版 MinIO key


@router.post("/render/deck")
async def render_deck(body: DeckRenderBody):
    """渲染 → 覆盖 artifacts/<thread_id>/present.pptx → {key}。
    母版取不到/损坏由 render_pptx 自身回退空白设计，不阻断导出（与 present/export 既有兜底一致）。"""
    if not _THREAD_ID.match(body.thread_id):
        raise ValueError(f"非法 thread_id：{body.thread_id!r}")
    deck = DeckSpec(**body.deck)
    master = await fetch_master_bytes(body.enterprise_template_key)
    data = render_pptx(deck, template=body.template, master_bytes=master)
    key = f"artifacts/{body.thread_id}/present.pptx"
    await storage.put_bytes(key, data, content_type=_PPTX_CT)
    return {"key": key}
