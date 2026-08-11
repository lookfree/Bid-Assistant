"""资料库附件正文解析(spec 2026-08-11-library-attachment-rag)。

同步工具路由(参照 routes/pdf_pages.py 的形态):App API 中转调用,agent 只做
「MinIO 取件 → 解析(必要时 OCR) → 回纯文本」,不落库、不建索引、不碰计费(money-blind)。
拿到文本后写回附件并进 RAG 索引是 App 的事(apps/api/src/services/library-text.ts)。

**扫描版 PDF 也识别**:复用审查链那套 `parsing.ocr.ocr_scanned_pages`——进程级并发闸(2 路)、
单页总帽、连续失败熔断、300 页帽,一条都不绕过。与审查链的差别只有两处,都在本文件里显式给出:
时长预算(_OCR_BUDGET_S,资料库自己的一条,不蹭审查的 run 级 deadline)与排队闸
(_LIBRARY_OCR_SEM,见其注释:让付了费、有人干等的审查步永远抢得到位子)。

**返回的文本里绝不夹带系统注记**(截断/识别/提不出文字都只用响应字段表达):这段文本会进 RAG
索引,被正文生成当「参考资料」喂给写手——注记一旦被抄进标书,审查就会报「有未清理的编辑残留」
(见 parsing/types.SYSTEM_NOTE_PREFIX 记下的 2026-08-11 生产实测)。故 OCR 拼回时的页首注记
在出门前逐行剔掉。
"""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.parsing.ocr import ocr_configured, ocr_scanned_pages
from agent.parsing.parsers import is_image_page, parse_bytes, scanned_page_indices
from agent.parsing.storage_read import read_bytes
from agent.parsing.types import SYSTEM_NOTE_PREFIX, ParsedDoc, UnsupportedDocument

logger = logging.getLogger(__name__)

router = APIRouter()

# 单次返回文本的硬顶。真正的预算由 App 侧按条目下发 max_chars(services/library-text.ts),
# 这里只兜住「调用方漏传/传了个天文数字」:一份 366 页标书的纯文本可达数十万字,
# 整篇过网既撑大 App 的 jsonb 列,也把这条目的检索信号稀释光。
_MAX_CHARS_CAP = 200_000

# 单个附件的 OCR 时长预算(秒),**进门即起算**(含在 _LIBRARY_OCR_SEM 上排队的时间)。
# 资料库自己的一条,不蹭审查那套 run 级 deadline(那是「一次审查最多 10 份文件共享 20 分钟」的
# 语义,与「一次保存一个附件」对不上)。到点即收手:已识别的页照常拼回入索引,剩下的记为未提取,
# **绝不整条失败**——ocr_scanned_pages/_ocr_stream 本来就是这个行为。
# 10 分钟 = 300 页帽 × 2 路并发 × 单页数秒的量级,正常识别用不到,它是防挂死的兜底。
# App 侧的 HTTP 超时必须**大于**它(services/agent-client.ts parseAttachmentText 给了 720s),
# 否则识别刚要收尾就被我们自己掐断,改这里必须同步复核那边。
_OCR_BUDGET_S = 10 * 60

# 资料库这条路的排队闸(进程级,与 parsing.ocr._GLOBAL_SEM 叠加而非替代)。
# 为什么还要一道:OCR 容器是 CPU 推理、只有 2 线程,_GLOBAL_SEM 也就 2 个位子且是 **FIFO**。
# 资料库保存是后台 fire-and-forget,用户一次批量存 10 份扫描件就会有 10 份文件各自 2 路
# 往全局闸上挤——排在后面的审查页请求要等前面几十个资料库页做完,而审查是**预扣了积分、
# 用户正在干等**的步,还压着自己的 20 分钟总帽。这道闸把资料库的在途请求钉死在 1,
# 全局 2 个位子里永远至少留 1 个给审查,最坏排队深度从「几十页」降到「一页」(数秒)。
# 代价是资料库多份扫描件串行识别——它本来就是后台活,慢一点没人看见。
_LIBRARY_OCR_SEM = asyncio.Semaphore(1)


class ParseTextBody(BaseModel):
    key: str                    # MinIO 对象键(属主校验在 App API,这里只管解析)
    max_chars: int = 50_000     # 截断上限,与 _MAX_CHARS_CAP 取较小值
    ocr: bool = True            # 扫描页是否送 OCR(未部署 OCR 服务时该开关无意义,整段自动跳过)


def _drop_system_notes(text: str) -> str:
    """剔掉系统注记行(OCR 拼回时的页首注记)。见模块 docstring:这段文本要进 RAG 索引。
    注记独占一行(parsers.splice_ocr_pages 拼的是 f"{mark}\\n{text}"),按行剔干净即可。"""
    return "\n".join(ln for ln in text.split("\n")
                     if not ln.lstrip().startswith(SYSTEM_NOTE_PREFIX))


async def _ocr_scanned(doc: ParsedDoc, key: str, deadline: float) -> ParsedDoc:
    """扫描页识别(复用审查链那套韧性,见模块 docstring)。

    未配置 OCR / 没有扫描页 → **原样返回,零调用**:文字版 PDF 不会白跑一趟 OCR,
    判据直接用既有的 scanned_page_indices(逐页,混合页也认得出)。
    排队等到预算已尽 → 同样原样返回(只入文字层),下次保存会重试。
    ocr_scanned_pages 内部任何异常都不外抛,这里无需再兜。"""
    if not ocr_configured() or not scanned_page_indices(doc):
        return doc
    async with _LIBRARY_OCR_SEM:
        if time.monotonic() >= deadline:
            logger.warning("资料库附件 OCR 排队耗尽时长预算,只入文字层 key=%s", key)
            return doc
        return await ocr_scanned_pages(doc, key, deadline=deadline)


def _shape(doc: ParsedDoc, limit: int, before_image_pages: int) -> dict:
    """ParsedDoc → 响应体(剔注记 → 截断)。

    「提不出文字」沿用扫描页那套口径(parsers.is_image_page,阈值单点在 _MIN_VISIBLE_CHARS):
    识别之后**仍**低于一页的门槛(没部署 OCR / 识别不出) → 如实报空,App 据此记「未提取到文字」。
    """
    text = _drop_system_notes(doc.text).strip()
    ocr_pages = max(0, before_image_pages - doc.image_pages)   # 真正被识别出来的页数
    common = {"kind": doc.kind, "image_pages": doc.image_pages, "ocr_pages": ocr_pages}
    if is_image_page(text):
        return {"text": "", "chars": 0, "truncated": False, "no_text": True, **common}
    return {"text": text[:limit], "chars": min(len(text), limit),
            "truncated": len(text) > limit, "no_text": False, **common}


@router.post("/tools/parse-text")
async def parse_text(body: ParseTextBody):
    """文档附件 → 纯文本(供 App 写回附件并建索引)。
    不支持的类型/解析失败一律 422:对调用方是同一件事——这个附件没有可索引的正文,
    不是服务故障(App 侧据此静默跳过该附件,不影响条目保存与既有索引)。"""
    limit = max(1, min(body.max_chars, _MAX_CHARS_CAP))
    deadline = time.monotonic() + _OCR_BUDGET_S      # 进门即起算,见 _OCR_BUDGET_S
    try:
        # 解析是同步 CPU 活(大 PDF 可跑数十秒),丢线程池,别卡事件循环(本进程还 serving 审查)
        doc = await asyncio.to_thread(lambda: parse_bytes(read_bytes(body.key), body.key))
    except UnsupportedDocument:
        return JSONResponse({"error": "unsupported"}, status_code=422)
    except Exception:  # noqa: BLE001 取件/解析失败对调用方是同一件事:这个附件没正文
        logger.exception("parse-text 解析失败 key=%s", body.key)
        return JSONResponse({"error": "parse_failed"}, status_code=422)
    image_pages = doc.image_pages
    if body.ocr:
        doc = await _ocr_scanned(doc, body.key, deadline)
    shaped = _shape(doc, limit, image_pages)
    logger.info("parse-text key=%s kind=%s 字数=%d 截断=%s 识别页=%d 仍看不见=%d",
                body.key, shaped["kind"], shaped["chars"], shaped["truncated"],
                shaped["ocr_pages"], shaped["image_pages"])
    return shaped
