"""扫描件页的 OCR（审查 / 废标体检流）。

第一步（71f519d）只做到「诚实分级」：提不出文字的页报个数、判成「无法核验」。
这一步让审查模型**真的看见**——扫描页逐页转成图送本地 OCR 服务识别，文本按页拼回该文件正文，
身份证、盖章报价表、法定代表人授权书从此参与审查（2026-08-09 实测样本：366 页里 139 页是扫描件）。

**配置驱动降级**：`OCR_BASE_URL` 未配置 = 这套环境没部署 OCR 服务，整段跳过，行为与第一步
逐字节一致。这不是「按错误猜回退」，是环境的明确表态（App 侧 apps/api/src/services/ocr.ts 同口径）。

**绝不抛穿审查节点**：取不到字节、PDF 打不开、某页超时或 500，一律只是少识别几页，
那些页照旧算「还看不见」，审查按第一步的口径出「无法核验」——识别是加分项，不是前置条件。

**不落库不缓存**：重跑就重识别。省下一整套失效/清理逻辑，也不会因为提示词或阈值改了还吃旧结果。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from collections.abc import Awaitable, Callable

import httpx

from agent.config import settings
from agent.parsing.parsers import scanned_page_indices, splice_ocr_pages
from agent.parsing.pdf_render import PdfPageRenderer
from agent.parsing.storage_read import read_bytes
from agent.parsing.types import ParsedDoc

logger = logging.getLogger(__name__)

# 并发路数。OCR 是**纯 CPU 推理**的独立容器（231 上限 3 核、OCR_THREADS=2），2 路即打满它的
# 线程数；再多只是在容器里排队，还会把同机的 PG/Redis 一起挤慢。
_CONCURRENCY = 2
# 单页超时（秒）。231 实测单张 1200×850 证照 0.7–0.9s，整版扫描页更重；20s 是数量级的余量，
# 到点即跳过该页，绝不让一页把整份文件拖住。
_PAGE_TIMEOUT_S = 20
# 页数帽是**每文件**的。实测样本 139 页；300 封顶，挡的是"单份上千页的扫描册"这一种文件。
_MAX_PAGES = 300
# 时长帽是**每次审查**的（跨该次受审的全部文件共享一条 deadline，由 parse_bid_docs 起一次）。
# 独立审查一次最多收 10 份标书（apps/api 的 keyList max(10)），若每份各开 20 分钟，
# 最坏就是 200 分钟——用户在一个已预扣积分的步上干等几小时，而心跳泵还一直说它活着。
# 20 分钟 = 300 页 × 2 路并发 × 单页数秒的量级，正常识别用不到，它是防挂死的兜底。
_TOTAL_BUDGET_S = 20 * 60
# 单页取回字数上限。OCR 服务自身的上限就是 5000（services/ocr/app.py 的 max_chars le=5000）。
_MAX_CHARS_PER_PAGE = 5000
# 页图渲染宽度。证照与盖章表格上的小字要够 OCR 认得出，与资料库证书页同口径（1600px）。
_RENDER_WIDTH_PX = 1600
# 进度播报间隔（页）。长识别期间前端横幅不能一动不动。
# run 的存活心跳与此无关：runtime/executor.py 的 _heartbeat_pump 是独立泵，节点内不产事件也照续期。
_PROGRESS_EVERY = 10

ProgressFn = Callable[[int, int], Awaitable[None]]


def ocr_configured() -> bool:
    """OCR 服务地址是否配置。未配置 = 这套环境没部署它，整段跳过（不是错误、不记警告）。"""
    return bool((settings.ocr_base_url or "").strip())


def new_deadline() -> float:
    """本次审查的 OCR 截止时刻（monotonic）。**一次审查建一次、所有受审文件共享**——
    见 _TOTAL_BUDGET_S 的注释：按文件各开一份，10 份标书就是 200 分钟。"""
    return time.monotonic() + _TOTAL_BUDGET_S


async def ocr_scanned_pages(doc: ParsedDoc, key: str,
                            on_progress: ProgressFn | None = None,
                            deadline: float | None = None) -> ParsedDoc:
    """把 doc 里的扫描页识别成文字并按页拼回，返回新的 ParsedDoc。

    未配置 OCR / 没有扫描页 / 预算已用光 → **原样返回**（零 HTTP 调用、零字节读取）。
    deadline 缺省时自建一条（单文件直调/测试）；多文件必须由调用方传同一条进来。
    字节要重新取一次（解析时的 bytes 已经释放）：这条路本来就是几分钟量级的重活，
    多一次 MinIO 读取可以忽略，换来的是解析入口 read_and_parse 一个字都不用动。
    """
    indices = scanned_page_indices(doc)
    if not ocr_configured() or not indices:
        return doc
    if deadline is None:
        deadline = new_deadline()
    elif time.monotonic() >= deadline:
        # 前面的文件已经把这次审查的 OCR 预算用光：连字节都不用取（可能是几百 MB）
        logger.warning("扫描页 OCR 预算已用光，跳过该文件 key=%s", key)
        return doc
    if len(indices) > _MAX_PAGES:
        logger.warning("扫描页 %d 页超过单文件页数帽 %d，只识别前 %d 页 key=%s",
                       len(indices), _MAX_PAGES, _MAX_PAGES, key)
        indices = indices[:_MAX_PAGES]
    try:
        data = await asyncio.to_thread(read_bytes, key)
        texts = await _ocr_pages(data, indices, on_progress, deadline)
        # 拼回也在保护圈内：畸形识别文本让条款重切炸掉，同样不该变成一次全额退款的失败 run
        spliced = splice_ocr_pages(doc, texts)
    except Exception:  # noqa: BLE001 兜到最外层：识别是加分项，出什么意外都不该让审查步失败
        logger.warning("扫描页 OCR 失败，退回「无法核验」口径 key=%s", key, exc_info=True)
        return doc
    logger.info("扫描页 OCR 完成 key=%s 识别 %d/%d 页", key, len(texts), len(indices))
    return spliced


async def _ocr_pages(data: bytes, indices: list[int],
                     on_progress: ProgressFn | None, deadline: float) -> dict[int, str]:
    """逐块（每块 _CONCURRENCY 页）渲染 + 识别 → {页序号: 识别文字}。识别不出/失败的页不进结果。

    渲染串行（pdfium 非线程安全），并发只放在 HTTP 那一段；同时块内只驻留 _CONCURRENCY 张页图，
    内存不随页数增长。deadline 到点即停手（它是**跨文件**的，见 new_deadline），已识别的页照样拼回。
    """
    try:
        renderer = await asyncio.to_thread(PdfPageRenderer, data, _RENDER_WIDTH_PX)
    except Exception:  # noqa: BLE001 PDF 打不开（加密/损坏）→ 不识别，交回「无法核验」口径
        logger.warning("扫描页 OCR：PDF 无法渲染，跳过识别", exc_info=True)
        return {}
    base = (settings.ocr_base_url or "").strip().rstrip("/")
    out: dict[int, str] = {}
    try:
        async with httpx.AsyncClient(timeout=_PAGE_TIMEOUT_S) as client:
            for start in range(0, len(indices), _CONCURRENCY):
                if time.monotonic() >= deadline:
                    logger.warning("扫描页 OCR 超过本次审查的时长帽 %ds，停在 %d/%d 页",
                                   _TOTAL_BUDGET_S, start, len(indices))
                    # 提前收手也要把最后一帧发出去，否则横幅永远停在上一个 10 的倍数
                    await _report(on_progress, start, len(indices), force=True)
                    break
                chunk = indices[start:start + _CONCURRENCY]
                pages = await asyncio.to_thread(renderer.render_many, chunk)
                for idx, text in await asyncio.gather(
                        *[_ocr_one(client, base, i, img) for i, img in pages]):
                    if text:
                        out[idx] = text
                await _report(on_progress, start + len(chunk), len(indices))
    finally:
        await asyncio.to_thread(renderer.close)
    return out


async def _ocr_one(client: httpx.AsyncClient, base: str,
                   index: int, image: bytes) -> tuple[int, str]:
    """单页送 OCR。超时/非 200/连不上/返回不合形状——任何失败都只是这一页跳过。"""
    try:
        resp = await client.post(f"{base}/ocr", json={
            "image": base64.b64encode(image).decode(),
            "max_chars": _MAX_CHARS_PER_PAGE})
        resp.raise_for_status()
        return index, (resp.json().get("text") or "").strip()
    except Exception:  # noqa: BLE001 单页失败不牵连其余页，更不该抛穿审查节点
        logger.warning("扫描页 OCR 失败，跳过第 %d 页", index + 1, exc_info=True)
        return index, ""


async def _report(on_progress: ProgressFn | None, done: int, total: int,
                  force: bool = False) -> None:
    """每 _PROGRESS_EVERY 页（以及最后一页）播报一次进度；播报失败不影响识别。
    force=True 用于提前收手的路径：不满一个间隔也要把当前进度发出去。"""
    if not on_progress or (not force and done % _PROGRESS_EVERY and done < total):
        return
    try:
        await on_progress(min(done, total), total)
    except Exception:  # noqa: BLE001 进度 best-effort
        logger.warning("扫描页 OCR 进度播报失败", exc_info=True)
