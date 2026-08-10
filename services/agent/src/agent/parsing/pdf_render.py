"""PDF → 位图（pypdfium2）。两类用法共用同一套缩放与编码：

· **整本渲染**：述标预览、资料库证书页，见 agents/bidding_agent/render/preview.py；
· **按页挑着渲染**：扫描件 OCR（本文件的 PdfPageRenderer）。366 页的标书只有 139 页需要识别，
  整本渲成位图既白烧 CPU，又把每页 1–2MB 的位图一次性堆到 GB 级内存。

放在 parsing/ 而不是 agent 包里：渲染是与具体智能体无关的文档能力，解析层用得上它，
反过来让解析层去 import 某个智能体的 render 包才是把依赖方向拧反了。
"""
from __future__ import annotations

import io
import logging
import math
import threading

logger = logging.getLogger(__name__)

# 送 OCR 的页图用 JPEG：同一页 PNG 常有数 MB，base64 再涨三成，而 OCR 服务默认只收 8MB
# （services/ocr/app.py 的 OCR_MAX_BYTES），体积也直接换成传输时间。85 对印刷体识别无损。
_JPEG_QUALITY = 85

# 单页位图的总像素帽（2000 万 ≈ 5000×4000，任何真实页面都用不到）。
# scale 是**按宽**算的（width_px / 页宽），而页宽没有下限：一张 10pt 宽、A4 高的畸形页
# （裁切页/条码页，扫描件里真实存在）会算出 scale≈160，渲成 10×792×160² ≈ 2 亿像素的位图——
# 几 GB 内存 + 十几分钟 CPU，而 to_thread 里的渲染既取消不掉也不会自己超时，
# 心跳泵还一直在说这个 run 活着。超帽就按帽反算 scale：图小一点，总好过把一步挂死几小时。
_MAX_PIXELS = 20_000_000

# PDFium **进程级非线程安全**：pypdfium2 底下是同一个 C 库的全局状态，两个线程同时进入会
# 直接原生段错误——整个进程消失，没有 Python 异常也没有日志。
# 本进程有两条互不相干的渲染路径，会落到不同的线程池线程上：
#   · 扫描页 OCR 的 asyncio.to_thread(renderer.render_many)（parsing/ocr.py）
#   · 述标预览 / 资料库 PDF 转页图的渲染循环（agents/bidding_agent/render/preview.py）
# agent_worker_concurrency=5 下多个 run 并行，两条路径同时开工是常态，所以**所有** pdfium
# 调用（开文档、渲染、关文档）一律在这把模块级锁内执行。
# 用 RLock：render_many 已持锁，其中调用的 page_image 还要再持一次。
PDFIUM_LOCK = threading.RLock()


def _scale_for(page, width_px: int) -> float:
    """按宽等比的缩放系数，夹在 _MAX_PIXELS 之内。读页面尺寸也是 pdfium 调用，须在锁内使用。"""
    w = max(page.get_width(), 1)
    h = max(page.get_height(), 1)
    scale = width_px / w
    if w * h * scale * scale > _MAX_PIXELS:
        scale = math.sqrt(_MAX_PIXELS / (w * h))
        logger.warning("页面尺寸畸形（%.1f×%.1f），缩放按像素帽收到 %.2f", w, h, scale)
    return scale


def page_image(page, width_px: int, fmt: str = "PNG") -> tuple[bytes, int, int]:
    """单页 → 按宽等比缩放的位图 (bytes, width, height)。fmt: PNG（无损预览）/ JPEG（送 OCR）。
    渲染在 PDFIUM_LOCK 内；编码是纯 PIL 的活，放在锁外，临界区只留真正碰 pdfium 的那一段。"""
    with PDFIUM_LOCK:
        pil = page.render(scale=_scale_for(page, width_px)).to_pil()
    buf = io.BytesIO()
    if fmt == "JPEG":
        pil = pil.convert("RGB")            # 渲染结果可能带 alpha 通道，JPEG 不接受
        pil.save(buf, "JPEG", quality=_JPEG_QUALITY, optimize=True)
    else:
        pil.save(buf, "PNG", optimize=True)
    return buf.getvalue(), pil.width, pil.height


def _flatten_on_white(raw):
    """透明底先合成到**白底**再转 RGB。

    直接 `convert("RGB")` 会把透明像素当成黑色：Word 里贴的印章、手写签名、抠好底的证照
    大多是「透明底 + 深色笔画」，压出来就是黑底黑字，OCR 一个字都读不出来——图照旧计入
    「看不见」的张数，那次请求与它占的并发/预算白烧。调色板图（P）带 transparency 同理。"""
    from PIL import Image

    if raw.mode in ("RGBA", "LA") or (raw.mode == "P" and "transparency" in raw.info):
        rgba = raw.convert("RGBA")
        white = Image.new("RGB", rgba.size, (255, 255, 255))
        white.paste(rgba, mask=rgba.split()[-1])
        return white
    return raw.convert("RGB")


def image_for_ocr(data: bytes, width_px: int) -> bytes:
    """任意位图字节 → 送 OCR 的 JPEG（按宽收到 width_px 之内，绝不放大）。

    放在这里而不是 parsing/ocr.py：「送 OCR 的位图长什么样」只该有一份定义——
    扫描页走 page_image、docx 内嵌图走这里，质量口径同为 _JPEG_QUALITY。
    重编码不是可选项：docx 正文里贴的原扫描图动辄十几 MB，而 OCR 服务单请求上限 8MB
    （services/ocr/app.py 的 OCR_MAX_BYTES）；且 RapidOCR 的耗时随像素走，4000px 的原图
    比 1600px 慢好几倍，而实测那份文件有 156 张图，必须落在 20 分钟总帽内。
    缩放用 LANCZOS：证照上的小字缩过头会糊成一团，识别率直接塌。"""
    from PIL import Image

    with Image.open(io.BytesIO(data)) as raw:
        im = _flatten_on_white(raw)         # 带 alpha / 调色板图 JPEG 不接受
    if im.width > width_px:
        im = im.resize((width_px, max(1, round(im.height * width_px / im.width))),
                       Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=_JPEG_QUALITY, optimize=True)
    return buf.getvalue()


class PdfPageRenderer:
    """打开一次 PDF、按页序号挑页渲染成 JPEG。

    **非线程安全**：pdfium 的文档对象只能单线程使用，调用方必须串行调用 render_many
    （OCR 的并发放在 HTTP 那一段，见 parsing/ocr.py 的分块）。
    进程内与别的 pdfium 使用者（述标预览）之间的互斥由 PDFIUM_LOCK 负责，见其注释。
    """

    def __init__(self, pdf_bytes: bytes, width_px: int):
        import pypdfium2 as pdfium

        with PDFIUM_LOCK:
            self._doc = pdfium.PdfDocument(pdf_bytes)
        self._width_px = width_px

    def render_many(self, indices: list[int]) -> list[tuple[int, bytes]]:
        """按给定页序号渲染 → [(页序号, JPEG 字节)]。
        单页渲染失败只跳过该页——一页坏图不该让整份文件的识别泡汤。
        整块持锁：块内取页对象、渲染都碰 pdfium，中途放手就给了别的线程插进来的机会。"""
        out: list[tuple[int, bytes]] = []
        with PDFIUM_LOCK:
            for i in indices:
                try:
                    data, _w, _h = page_image(self._doc[i], self._width_px, "JPEG")
                except Exception:  # noqa: BLE001 单页损坏/超大不阻断其余页
                    logger.warning("扫描页渲染失败，跳过第 %d 页", i + 1, exc_info=True)
                    continue
                out.append((i, data))
        return out

    def close(self) -> None:
        with PDFIUM_LOCK:
            self._doc.close()
