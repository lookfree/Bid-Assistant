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

logger = logging.getLogger(__name__)

# 送 OCR 的页图用 JPEG：同一页 PNG 常有数 MB，base64 再涨三成，而 OCR 服务默认只收 8MB
# （services/ocr/app.py 的 OCR_MAX_BYTES），体积也直接换成传输时间。85 对印刷体识别无损。
_JPEG_QUALITY = 85


def page_image(page, width_px: int, fmt: str = "PNG") -> tuple[bytes, int, int]:
    """单页 → 按宽等比缩放的位图 (bytes, width, height)。fmt: PNG（无损预览）/ JPEG（送 OCR）。"""
    scale = width_px / max(page.get_width(), 1)
    pil = page.render(scale=scale).to_pil()
    buf = io.BytesIO()
    if fmt == "JPEG":
        pil = pil.convert("RGB")            # 渲染结果可能带 alpha 通道，JPEG 不接受
        pil.save(buf, "JPEG", quality=_JPEG_QUALITY, optimize=True)
    else:
        pil.save(buf, "PNG", optimize=True)
    return buf.getvalue(), pil.width, pil.height


class PdfPageRenderer:
    """打开一次 PDF、按页序号挑页渲染成 JPEG。

    **非线程安全**：pdfium 的文档对象只能单线程使用，调用方必须串行调用 render_many
    （OCR 的并发放在 HTTP 那一段，见 parsing/ocr.py 的分块）。
    """

    def __init__(self, pdf_bytes: bytes, width_px: int):
        import pypdfium2 as pdfium

        self._doc = pdfium.PdfDocument(pdf_bytes)
        self._width_px = width_px

    def render_many(self, indices: list[int]) -> list[tuple[int, bytes]]:
        """按给定页序号渲染 → [(页序号, JPEG 字节)]。
        单页渲染失败只跳过该页——一页坏图不该让整份文件的识别泡汤。"""
        out: list[tuple[int, bytes]] = []
        for i in indices:
            try:
                data, _w, _h = page_image(self._doc[i], self._width_px, "JPEG")
            except Exception:  # noqa: BLE001 单页损坏/超大不阻断其余页
                logger.warning("扫描页渲染失败，跳过第 %d 页", i + 1, exc_info=True)
                continue
            out.append((i, data))
        return out

    def close(self) -> None:
        self._doc.close()
