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
import re
from html import unescape

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


# parse_bid_chapters 回的是 {"sec-1": "<h3>标题</h3><p>正文</p>…"}：**键是节 id、值是转义后的
# HTML**，不是 {标题: 正文}。节 id 正是审查结论里 target_id 要求原样照抄的那个键（schemas
# RiskFinding.target_id），所以必须原样带给前端做精确定位；HTML 则要在这里还原成结构化的
# 标题 + 段落——直接丢给前端会被 React 转义成一屏裸标签，而按 \n 切段更是切不出东西（这串
# 里一个换行都没有）。还原（unescape）与 html_to_review_text / present._plain 同一口径。
_H3 = re.compile(r"^<h3>(.*?)</h3>", re.S)
_P = re.compile(r"<p>(.*?)</p>", re.S)


def _split_chapter(raw_html: str) -> tuple[str, list[str]]:
    """一章的 HTML → (标题, 段落列表)，全部反转义。无 <h3> 即无标题（解析不出标题的节）。"""
    head = _H3.match(raw_html or "")
    title = unescape(head.group(1)).strip() if head else ""
    body = raw_html[head.end():] if head else (raw_html or "")
    return title, [t for p in _P.findall(body) if (t := unescape(p).strip())]


def _shape(raw: dict[str, str]) -> tuple[list[dict], bool]:
    """{节 id: 章 HTML} → [{sec, title, paragraphs}]。逐章截断 + 总量封顶；保序。"""
    out: list[dict] = []
    total = 0
    truncated = False
    for sec, html in raw.items():
        title, paragraphs = _split_chapter(html)
        kept: list[str] = []
        used = 0
        for para in paragraphs:
            if used + len(para) > _MAX_CHAPTER_CHARS or total + used + len(para) > _MAX_TOTAL_CHARS:
                truncated = True
                break
            kept.append(para)
            used += len(para)
        total += used
        # **超限的章也要留下（哪怕正文空）**：整章丢掉的话，落在它里面的风险项就永远跳不过去，
        # 前端还会显示「未能定位」——那是假消息，章根本没送到。
        out.append({"sec": sec, "title": title, "paragraphs": kept})
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
