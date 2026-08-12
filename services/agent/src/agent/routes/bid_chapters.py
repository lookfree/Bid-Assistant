"""线下标书正文分章（#97 ②：审查报告点回标书原文）。

同步工具路由（形态同 routes/parse_text.py）：App API 中转调用，agent 只做
「MinIO 取件 → 解析分章 → 回章节列表」，不落库、不计费（money-blind）。

**为什么要按需解析而不是审查时存下来**：审查结论（RiskReport）只有分数与风险项，
存的就不含标书正文；而正文动辄几十万字，塞进 project_steps.result 会让每次拉取
审查报告都背上这份传输税（读标结果曾因此达 1MB，才有了 `?slim=1`）。这条路径是
用户点「定位到标书原文」时才走的显式动作，按需解析更划算。

**不跑 OCR**（复用 parse_bid_chapters 的既有口径）：要的是可跳转的正文章节，
证照/签字页那些扫描件对定位没有信息量，却要花掉整份文件的识别时间——用户点一下
要等好几分钟是不可接受的。扫描页在这里表现为该章正文偏少，不影响其余章跳转。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.agents.bidding_agent.nodes.common import parse_bid_chapters

logger = logging.getLogger(__name__)

router = APIRouter()

# 单次返回的硬顶。一份 366 页标书纯文本可达数十万字，整篇过网既慢又没人读得完；
# 超出即按章截断（前端只用它做定位与就近阅读，不是阅读器）。
_MAX_TOTAL_CHARS = 400_000
_MAX_CHAPTER_CHARS = 20_000


class BidChaptersBody(BaseModel):
    keys: list[str]             # 投标文件的 MinIO 键（属主校验在 App API，这里只管解析）


def _shape(raw: dict[str, str]) -> tuple[list[dict], bool]:
    """{章标题: 正文} → [{title, text}]，逐章截断 + 总量封顶。保序（= 文件与章节的原始顺序）。"""
    out: list[dict] = []
    total = 0
    truncated = False
    for title, text in raw.items():
        body = (text or "").strip()
        if len(body) > _MAX_CHAPTER_CHARS:
            body, truncated = body[:_MAX_CHAPTER_CHARS], True
        if total + len(body) > _MAX_TOTAL_CHARS:
            truncated = True
            break
        total += len(body)
        out.append({"title": title, "text": body})
    return out, truncated


@router.post("/tools/bid-chapters")
async def bid_chapters(body: BidChaptersBody):
    """投标文件 → 分章正文（供前端做只读视图与定位）。

    解析失败一律 422：对调用方是同一件事——这份文件给不出可跳转的正文，不是服务故障
    （前端据此退回「无法展示原文」而不是报错弹窗）。
    """
    if not body.keys:
        return JSONResponse({"error": "no_keys"}, status_code=422)
    try:
        # 解析是同步 CPU 活（大 PDF 可跑数十秒），丢线程池，别卡事件循环（本进程还 serving 审查）
        raw = await asyncio.to_thread(parse_bid_chapters, body.keys)
    except Exception:  # noqa: BLE001 取件/解析失败对调用方是同一件事：这份标书没有可跳转的正文
        logger.exception("bid-chapters 解析失败 keys=%s", body.keys)
        return JSONResponse({"error": "parse_failed"}, status_code=422)
    chapters, truncated = _shape(raw)
    logger.info("bid-chapters keys=%d 章数=%d 截断=%s", len(body.keys), len(chapters), truncated)
    return {"chapters": chapters, "truncated": truncated}
