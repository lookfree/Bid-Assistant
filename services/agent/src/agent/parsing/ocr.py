"""看不见的材料的 OCR（审查 / 废标体检流）：PDF 扫描页 + docx 正文内嵌图片。

第一步（71f519d）只做到「诚实分级」：提不出文字的页报个数、判成「无法核验」。
这一步让审查模型**真的看见**——扫描页逐页转成图送本地 OCR 服务识别，文本按页拼回该文件正文，
身份证、盖章报价表、法定代表人授权书从此参与审查（2026-08-09 实测样本：366 页里 139 页是扫描件）。

**配置驱动降级**：`OCR_BASE_URL` 未配置 = 这套环境没部署 OCR 服务，整段跳过，行为与第一步
逐字节一致。这不是「按错误猜回退」，是环境的明确表态（App 侧 apps/api/src/services/ocr.ts 同口径）。

**绝不抛穿审查节点**：取不到字节、PDF 打不开、某页超时或 500，一律只是少识别几页，
那些页照旧算「还看不见」，审查按第一步的口径出「无法核验」——识别是加分项，不是前置条件。

**不落库不缓存**：重跑就重识别。省下一整套失效/清理逻辑，也不会因为提示词或阈值改了还吃旧结果。

**两条链路共用一套韧性**（2026-08-10 补上 docx 那条）：线下标书里更常见的形态是 .docx 正文
贴着证照图（实测康恒环境那单三份文件内嵌图 156/106/5 张，商务文件正文只有 11950 字，
营业执照/银行资信证明/审计报告全在图里）。扫描页与内嵌图共用进程级并发闸、单请求总帽、
熔断与 run 级 deadline——各开一套的话两条路一起把 2 线程的 OCR 容器打爆。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import logging
import time
from collections.abc import Awaitable, Callable

import httpx

from agent.config import settings
from agent.parsing.parsers import (
    DocxImage, docx_body_images, scanned_page_indices, splice_docx_images, splice_ocr_pages,
)
from agent.parsing.pdf_render import PdfPageRenderer, image_for_ocr
from agent.parsing.storage_read import read_bytes
from agent.parsing.types import ParsedDoc

logger = logging.getLogger(__name__)

# 并发路数。OCR 是**纯 CPU 推理**的独立容器（231 上限 3 核、OCR_THREADS=2），2 路即打满它的
# 线程数；再多只是在容器里排队，还会把同机的 PG/Redis 一起挤慢。
_CONCURRENCY = 2
# 闸门是**模块级/进程级**的（同 rag/embedder.py 的 _GLOBAL_SEM）：worker 一次跑 5 个审查
# （agent_worker_concurrency=5），每个 run 各开 2 路就是 10 路在途打同一个 2 线程的容器——
# 排队变深后每页都撞每请求总帽（_PAGE_TIMEOUT_S），识别成功率整体塌下去。
# 按 run 各开一份信号量等于没开闸，所以它必须是模块级单例。
_GLOBAL_SEM = asyncio.Semaphore(_CONCURRENCY)
# 单页超时（秒）。231 实测单张 1200×850 证照 0.7–0.9s，整版扫描页更重；20s 是数量级的余量，
# 到点即跳过该页，绝不让一页把整份文件拖住。
# 这个口径**同时**盖住一页的两段活：渲染（asyncio.wait_for 包住 to_thread）与 HTTP 请求
# （asyncio.wait_for 包住 client.post）。httpx 自己的 timeout 是**分相**超时、read 那一相
# 每收到一片字节就重新计时，慢滴响应一次都不会触发它，所以请求级总帽必须自己绑。
_PAGE_TIMEOUT_S = 20
# 连续失败几页就放弃该文件剩余页（熔断）。OCR 容器挂了/被打爆时，剩下的页只是把同一个错误
# 重复几百遍：每页都要先渲染（CPU）再等满一个总帽，300 页就是几十分钟的白等，
# 而结果与直接放弃完全一样（都不进正文 → 照旧算「还看不见」→ 审查说「无法核验」）。
# 口径 = **这一页什么都没拿到**：OCR 请求真失败（超时/非 200/连不上），或整块页图压根没渲出来
# （渲染超时，见 _render_chunk）——两路都是「重复同一个错误」，都得让熔断看得见。
# 识别出空文本（真的是空白分隔页）不算故障，否则一叠空白页就能把后面真有内容的证照页全掐掉。
# 5 次给零星抖动留了余量。
_MAX_CONSECUTIVE_FAILS = 5
# 识别单元数帽是**每文件**的（PDF 论页、docx 论张，同一个口径）。实测样本 139 页 / 156 张图；
# 300 封顶，挡的是"单份上千页的扫描册"这一种文件。
_MAX_PAGES = 300
# docx 内嵌图能送 OCR 的格式：OCR 服务吃的是位图（PIL 解码 → RapidOCR）。emf/wmf 是矢量
# （Word 里粘贴的 Visio/流程图/公式常见），服务端解不出来，白花一个请求还占着并发闸。
# 跳过的图**仍计入 embedded_images**——它们照旧是"看不见"的东西，诚实注记不该因此缩水。
# tiff/gif/webp 一并收下：扫描仪默认存 TIFF 的不少，PIL 解得开、image_for_ocr 也转得成 JPEG，
# 在扩展名这关丢掉就是「营业执照仍然看不见」而日志里查不出原因。
_OCR_IMAGE_EXTS = {"png", "jpg", "jpeg", "bmp", "tif", "tiff", "gif", "webp"}
# 送识别的最小像素面积。页眉 logo、项目符号、装饰线、签章角标都落在这条线以下，而证照/资信证明/
# 审计报告的扫描图没有这么小的（A4 按 96dpi 缩到最小也有 800×1100）。按**面积**而不是按宽高各判：
# 宽而扁的签字条（1200×150）是有信息量的，按最小边判会把它误杀。
# 不设这道闸，实测那份 156 张图的商务文件里大半预算会烧在没有信息量的装饰图上。
_MIN_IMAGE_PIXELS = 300 * 300
# 时长帽是**每次审查**的（跨该次受审的全部文件共享一条 deadline，由 parse_bid_docs 起一次）。
# 独立审查一次最多收 10 份标书（apps/api 的 keyList max(10)），若每份各开 20 分钟，
# 最坏就是 200 分钟——用户在一个已预扣积分的步上干等几小时，而心跳泵还一直说它活着。
# 20 分钟 = 300 页 × 2 路并发 × 单页数秒的量级，正常识别用不到，它是防挂死的兜底。
# **口径 = 识别本身 + 各扫描文件为识别做的二次下载**（ocr_scanned_pages 进门要把字节重新取一次），
# 但**不含第一份要识别的文件到手之前的下载与解析**：那一段单份就能顶到分钟级（.doc 走
# LibreOffice 转换，单份最多 60s），10 份文件从循环前起算的话，第一次识别还没发出去预算就被
# 啃光了，日志却报「OCR 预算已用光」——张冠李戴。故起算点是**第一份真要发 OCR 的文件**（见
# needs_ocr）；它之后的下载与识别一律吃在这条预算里。
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


def _splices_docx_images(key: str) -> bool:
    """这个 key 的内嵌图会不会真被送去识别。**只认 .docx**：.doc 存的是旧格式字节，
    解析时那份 docx 是 LibreOffice 转出来的临时产物，识别侧要用就得再转一次。
    判据单点在此——起算预算与真发请求必须同口径，否则 .doc 会白起一张 20 分钟的表
    （首份是 .doc、后面跟着 9 份大 PDF 时，预算被它之后的下载啃掉）。"""
    return key.lower().endswith(".docx")


def needs_ocr(doc: ParsedDoc, key: str) -> bool:
    """这份文件要不要真发 OCR（部署了识别服务 + 确实有看得见的活可干：扫描页或 .docx 内嵌图）。
    调用方据此**惰性**起算时长预算：不含第一份要识别的文件到手之前的下载与解析
    （之后的二次下载与识别都吃在预算内，见 _TOTAL_BUDGET_S）。"""
    return ocr_configured() and bool(scanned_page_indices(doc)
                                     or (doc.embedded_images and _splices_docx_images(key)))


def new_deadline() -> float:
    """OCR 的截止时刻（monotonic）。**一次审查建一次、其后所有受审文件共享**——
    见 _TOTAL_BUDGET_S 的注释：按文件各开一份，10 份标书就是 200 分钟。
    建的时机是第一份真要识别的文件到手时，不是取文件之前（那一段下载解析不进预算）。"""
    return time.monotonic() + _TOTAL_BUDGET_S


async def ocr_scanned_pages(doc: ParsedDoc, key: str,
                            on_progress: ProgressFn | None = None,
                            deadline: float | None = None) -> ParsedDoc:
    """把 doc 里的扫描页识别成文字并按页拼回，返回新的 ParsedDoc。

    未配置 OCR / 没有扫描页 / 预算已用光 → **原样返回**（零 HTTP 调用、零字节读取）。
    deadline 缺省时自建一条（单文件直调/测试）；多文件必须由调用方传同一条进来。
    字节要重新取一次（解析时的 bytes 已经释放）：这条路本来就是几分钟量级的重活，
    多一次 MinIO 读取可以忽略，换来的是解析入口 read_and_parse 一个字都不用动。
    这次重下载**吃在 deadline 里**（它建于本函数之前），预算口径见 _TOTAL_BUDGET_S。
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


async def ocr_docx_images(doc: ParsedDoc, key: str,
                          on_progress: ProgressFn | None = None,
                          deadline: float | None = None) -> ParsedDoc:
    """把 docx 正文内嵌图片识别成文字并按图片位置拼回，返回新的 ParsedDoc。

    未配置 OCR / 没有内嵌图 / 预算已用光 → **原样返回**（零 HTTP 调用、零字节读取）。
    deadline 与扫描页那条链路**共用一条**（缺省时自建，仅供单文件直调/测试）。

    **只认 .docx**：.doc 存的是旧格式字节，解析时那份 docx 是 LibreOffice 转出来的临时产物，
    这里要用就得再转一次（单份最多 60s，还要多占一个 soffice 实例）。先不做——那些图照旧
    计入注记，行为与改前一致，审查说「无法核验」而不是「缺少」。
    字节要重新取一次、docx 也重解析一次（解析时的 bytes 与图片字节都已释放）：156 张图的
    标书若把字节留在 ParsedDoc 里，就是几十上百 MB 跟着整个 run 的状态走；而识别本来
    就是分钟量级的重活，多一次 MinIO 读取 + 一次解析可以忽略。
    """
    if not ocr_configured() or not doc.embedded_images or not _splices_docx_images(key):
        return doc
    if deadline is None:
        deadline = new_deadline()
    elif time.monotonic() >= deadline:
        logger.warning("内嵌图片 OCR 预算已用光，跳过该文件 key=%s", key)
        return doc
    try:
        data = await asyncio.to_thread(read_bytes, key)
        blocks, images = await asyncio.to_thread(docx_body_images, data)
        reps, groups = _ocr_image_indices(images)
        if not reps:
            # 全是矢量图/装饰小图：一次请求都不该发，也别打「识别 0/0 张」的假完成日志
            logger.info("内嵌图片无一张够格送识别 key=%s（正文共 %d 张）", key, doc.embedded_images)
            return doc
        _release_unused(images, groups)
        picked = await _ocr_stream(lambda chunk: _encode_chunk(images, chunk),
                                   reps, on_progress, deadline, "内嵌图片")
        # 去重的结果回填给共用同一张图的每一处，正文各处照样有字
        texts = {j: t for i, t in picked.items() for j in groups[i]}
        spliced = splice_docx_images(doc, blocks, images, texts)
    except Exception:  # noqa: BLE001 兜到最外层：识别是加分项，出什么意外都不该让审查步失败
        logger.warning("内嵌图片 OCR 失败，退回「无法核验」口径 key=%s", key, exc_info=True)
        return doc
    # 张数按**真正进了正文**的算：拿到文字不等于够读（见 parsers._recognized，那道门槛挂着退款闸），
    # 报 len(texts) 的话，全是印章碎字时日志写「识别 N/N 张」而文档里一个字都没多，
    # 事后查起来会把方向引到模型上去。
    logger.info("内嵌图片 OCR 完成 key=%s 识别 %d/%d 张（发出 %d 张，正文共 %d 张）",
                key, doc.embedded_images - spliced.embedded_images, len(texts),
                len(reps), doc.embedded_images)
    return spliced


def _ocr_image_indices(images: list[DocxImage]) -> tuple[list[int], dict[int, list[int]]]:
    """哪些内嵌图值得送 OCR → (要发请求的图, {它 → 共用这次结果的所有图})。

    筛：位图格式（_OCR_IMAGE_EXTS）+ 够大（_MIN_IMAGE_PIXELS）。跳过的图仍计在
    embedded_images 里，只是不花识别预算。
    **同一张图只识别一次**：公章、抬头图、页脚二维码会贴在几十处，python-docx 那边本来就
    只存一份媒体部件（几处指向同一份字节），逐处各发一次请求就是把 300 张的额度和 20 分钟里的
    位子让给同一张图，真正要紧的证照被挤掉。识别结果回填给它的每一处，正文各处照样有字。
    数帽按**去重后的张数**算（口径与扫描页共用 _MAX_PAGES）。"""
    picks = [i for i, img in enumerate(images)
             if img.ext in _OCR_IMAGE_EXTS and _big_enough(img.data)]
    reps: list[int] = []
    groups: dict[int, list[int]] = {}
    first: dict[bytes, int] = {}
    for i in picks:
        key = hashlib.blake2b(images[i].data, digest_size=16).digest()
        if key in first:
            groups[first[key]].append(i)
            continue
        first[key] = i
        reps.append(i)
        groups[i] = [i]
    if len(reps) > _MAX_PAGES:
        logger.warning("内嵌图片 %d 张（去重后）超过单文件帽 %d，只识别前 %d 张",
                       len(reps), _MAX_PAGES, _MAX_PAGES)
        reps = reps[:_MAX_PAGES]
    return reps, {i: groups[i] for i in reps}


def _release_unused(images: list[DocxImage], groups: dict[int, list[int]]) -> None:
    """不送识别的图立刻放掉字节。156 张图的标书原始字节几十上百 MB，而这份列表要在整段
    识别（分钟量级）里一直活着；worker 一次跑 5 个审查，全留着就是几百 MB 常驻。
    留下的只有真要发出去的那些——拼回只用得到它们的 block_index。"""
    keep = {j for g in groups.values() for j in g}
    for i, img in enumerate(images):
        if i not in keep:
            img.data = b""


def _big_enough(data: bytes) -> bool:
    """图片像素面积够不够识别的门槛。只读图头（PIL 的 size 不解码像素），上百张也就毫秒级。
    读不出尺寸（截断/损坏/伪装扩展名）→ 不送识别：解码这一步在 OCR 服务里同样会失败。"""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as im:
            return im.width * im.height >= _MIN_IMAGE_PIXELS
    except Exception:  # noqa: BLE001 见 docstring：判不出来就不送，绝不抛给识别循环
        return False


async def _encode_chunk(images: list[DocxImage], chunk: list[int]) -> list[tuple[int, bytes]]:
    """一块内嵌图 → 送 OCR 的 JPEG。解码/缩放/编码是 CPU 活，跑在线程里并绑一层单张口径的
    总帽（与扫描页渲染同理，见 _render_chunk）：畸形巨图能把一份文件的识别拖死。
    单张解不开（截断的 PNG、改了扩展名的怪文件）只跳过那一张。"""
    def _many() -> list[tuple[int, bytes]]:
        out: list[tuple[int, bytes]] = []
        for i in chunk:
            try:
                out.append((i, image_for_ocr(images[i].data, _RENDER_WIDTH_PX)))
            except Exception:  # noqa: BLE001 单张坏图不阻断其余
                logger.warning("内嵌图片编码失败，跳过第 %d 张", i + 1, exc_info=True)
        return out

    try:
        return await asyncio.wait_for(asyncio.to_thread(_many), _PAGE_TIMEOUT_S * len(chunk))
    except TimeoutError:
        logger.warning("内嵌图片编码超时，跳过第 %s 张", [i + 1 for i in chunk])
        return []


async def _ocr_pages(data: bytes, indices: list[int],
                     on_progress: ProgressFn | None, deadline: float) -> dict[int, str]:
    """扫描页那条链路的取图方式：打开 PDF、逐块渲染，识别本身交给 _ocr_stream。

    渲染串行（pdfium 非线程安全），并发只放在 HTTP 那一段；同时块内只驻留 _CONCURRENCY 张页图，
    内存不随页数增长。
    """
    try:
        renderer = await asyncio.to_thread(PdfPageRenderer, data, _RENDER_WIDTH_PX)
    except Exception:  # noqa: BLE001 PDF 打不开（加密/损坏）→ 不识别，交回「无法核验」口径
        logger.warning("扫描页 OCR：PDF 无法渲染，跳过识别", exc_info=True)
        return {}
    try:
        return await _ocr_stream(lambda chunk: _render_chunk(renderer, chunk),
                                 indices, on_progress, deadline, "扫描页")
    finally:
        await asyncio.to_thread(renderer.close)


# 取一块图：给定这一块的序号 → [(序号, 图片字节)]。取不到的跳过（调用方按整块空计熔断）。
FetchFn = Callable[[list[int]], Awaitable[list[tuple[int, bytes]]]]


async def _ocr_stream(fetch: FetchFn, indices: list[int], on_progress: ProgressFn | None,
                      deadline: float, what: str) -> dict[int, str]:
    """逐块（每块 _CONCURRENCY 张）取图 + 识别 → {序号: 识别文字}。识别不出/失败的不进结果。

    **扫描页与 docx 内嵌图共用这一套**：分块并发、跨文件 deadline、连续失败熔断、进度播报
    只该有一份口径——两条路各写一遍，改了一处忘另一处就是"某类文件悄悄绕过熔断"。
    deadline 到点即停手（它是**跨文件**的，见 new_deadline），已识别的照样拼回。
    """
    base = (settings.ocr_base_url or "").strip().rstrip("/")
    out: dict[int, str] = {}
    fails = 0                       # 连续失败数（口径见 _MAX_CONSECUTIVE_FAILS）
    async with httpx.AsyncClient(timeout=_PAGE_TIMEOUT_S) as client:
        for start in range(0, len(indices), _CONCURRENCY):
            if time.monotonic() >= deadline:
                logger.warning("%s OCR 超过本次审查的时长帽 %ds，停在 %d/%d",
                               what, _TOTAL_BUDGET_S, start, len(indices))
                # 提前收手也要把最后一帧发出去，否则横幅永远停在上一个 10 的倍数
                await _report(on_progress, start, len(indices), what, force=True)
                break
            chunk = indices[start:start + _CONCURRENCY]
            done = start + len(chunk)
            items = await fetch(chunk)
            if not items:
                # 整块一张都没取出来（渲染/解码超时、整块坏图）也是**连续失败**：不计的话熔断只认
                # HTTP 那一路，一份卡住的文件会逐块重试到时长帽耗尽——20 分钟一无所获，
                # 而 deadline 是跨文件共享的，后面所有受审文件直接「预算已用光」跳过。
                # 只数整块失败：块内单张坏图（取图函数自己跳过）是常态，不该攒成熔断。
                fails += len(chunk)
            for idx, text in await asyncio.gather(
                    *[_ocr_one(client, base, i, img, what) for i, img in items]):
                if text is None:            # 请求本身失败（超时/非 200/连不上）
                    fails += 1
                    continue
                fails = 0
                if text:
                    out[idx] = text
            if fails >= _MAX_CONSECUTIVE_FAILS:
                logger.warning("%s OCR 连续失败 %d 次，放弃该文件剩余部分（停在 %d/%d）",
                               what, fails, done, len(indices))
                await _report(on_progress, done, len(indices), what, force=True)
                break
            await _report(on_progress, done, len(indices), what)
    return out


async def _render_chunk(renderer: PdfPageRenderer, chunk: list[int]) -> list[tuple[int, bytes]]:
    """一块页图。渲染跑在线程里，**既不会自己超时也取消不掉**（pdfium 在原生代码里），
    所以外面绑一层单页口径的总帽把循环放出来；超时的这几页当渲染失败处理（不发 HTTP、
    照旧算「还看不见」，且由调用方计入连续失败——见 _MAX_CONSECUTIVE_FAILS）。落单的那个线程
    仍会跑完，但页图有像素帽兜着（pdf_render._MAX_PIXELS），不至于变成几小时的巨图。"""
    try:
        return await asyncio.wait_for(asyncio.to_thread(renderer.render_many, chunk),
                                      _PAGE_TIMEOUT_S * len(chunk))
    except TimeoutError:
        logger.warning("扫描页渲染超时，跳过第 %s 页", [i + 1 for i in chunk])
        return []


async def _post_ocr(client: httpx.AsyncClient, base: str, image: bytes) -> str:
    """一次 /ocr 调用 → 识别文字。"""
    resp = await client.post(f"{base}/ocr", json={
        "image": base64.b64encode(image).decode(),
        "max_chars": _MAX_CHARS_PER_PAGE,
        # 整页扫描件按**行**取回。服务端默认口径是把识别行用空格拼成一行——那是给 App 侧
        # 写 <img alt> 用的（一张小图一句话）；整页表格照这么拼就成了一坨连续文字，
        # 审查再也判不出「★条款有没有逐条登进偏离表」这类按行的结论。
        # 旧版 OCR 服务不认这个键会原样忽略（pydantic 丢弃多余字段）→ 退回一行文本，不报错。
        "mode": "lines"})
    resp.raise_for_status()
    return (resp.json().get("text") or "").strip()


async def _ocr_one(client: httpx.AsyncClient, base: str, index: int, image: bytes,
                   what: str = "扫描页") -> tuple[int, str | None]:
    """单张（页 / 内嵌图）送 OCR。超时/非 200/连不上/返回不合形状——任何失败都只是这一张跳过，
    返回 **None** 让调用方数「连续失败」；识别出空串是正常应答（空白页），返回 ""。

    总帽必须自己绑（见 _PAGE_TIMEOUT_S）：httpx 的 timeout 是分相超时，慢滴响应下
    read 那一相每收到一片字节就重新计时，单页能拖上几分钟而它一次都不会触发。

    进程级信号量在这里持有（不在渲染那一段）：闸门守的是 OCR 容器的 CPU，渲染是本进程的活。
    等闸的时间不该计入单页总帽，故 acquire 在 wait_for 之外。"""
    try:
        async with _GLOBAL_SEM:
            return index, await asyncio.wait_for(_post_ocr(client, base, image), _PAGE_TIMEOUT_S)
    except Exception:  # noqa: BLE001 单张失败不牵连其余，更不该抛穿审查节点
        logger.warning("%s OCR 失败，跳过第 %d 个", what, index + 1, exc_info=True)
        return index, None


async def _report(on_progress: ProgressFn | None, done: int, total: int, what: str,
                  force: bool = False) -> None:
    """每 _PROGRESS_EVERY 页（以及最后一页）播报一次进度；播报失败不影响识别。
    force=True 用于提前收手的路径：不满一个间隔也要把当前进度发出去。
    what 跟着调用方走（扫描页 / 内嵌图片）：两条链路共用这一份，写死一条的话日志会指错路。"""
    if not on_progress or (not force and done % _PROGRESS_EVERY and done < total):
        return
    try:
        await on_progress(min(done, total), total)
    except Exception:  # noqa: BLE001 进度 best-effort
        logger.warning("%s OCR 进度播报失败", what, exc_info=True)
