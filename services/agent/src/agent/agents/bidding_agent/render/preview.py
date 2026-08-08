"""把渲染好的 .pptx 转成逐页位图，供述标页**直接显示真实效果**。

**为什么要它**：述标页此前用一套手写 CSS 近似地画幻灯片，与真正导出的 PPT 是两套渲染器。
两套并存就必然漂移——2026-08-07 拿客户实际产物逐页比对，评分点标签位置、要点编号样式、
页码、标题分隔线四处都不一致，用户反馈「相差太大」。对齐这四处只是把当下的差异抹平，
新的差异迟早再冒出来；直接显示真实渲染图才是根除。

预览画布本来就是**纯展示**（slide-preview.tsx 里没有任何 contentEditable/onClick），
用户改内容走的是旁边的表单，所以换成图片不损失任何编辑能力。
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile

logger = logging.getLogger(__name__)

# 预览图宽度（像素）。述标页画布按 16:9 显示，实测 1280 宽在常见屏上足够清晰，
# 再大只是徒增体积——17 页的量级下每页几百 KB 与几 MB 是完全不同的体验。
_WIDTH_PX = 1280
# 单次转换超时。17 页实测 LibreOffice 转 PDF 约 4 秒，给足余量但不容许无限等待——
# 预览失败绝不能拖住述标交付（见 render_deck_previews 的吞错约定）。
_SOFFICE_TIMEOUT_S = 120


def _pptx_to_pdf(data: bytes, workdir: str) -> str:
    """.pptx → .pdf（LibreOffice headless）。返回 pdf 路径。"""
    if shutil.which("soffice") is None:
        raise RuntimeError("缺少 soffice，无法渲染预览图")
    src = os.path.join(workdir, "deck.pptx")
    with open(src, "wb") as f:
        f.write(data)
    # 独立 UserInstallation profile：默认 profile 带单实例锁，并发转换会互相拿不到锁而静默失败
    # （parsing/parsers.py 的旧格式转换踩过同一个坑）。
    profile = os.path.join(workdir, "lo-profile")
    subprocess.run(
        ["soffice", "--headless", f"-env:UserInstallation=file://{profile}",
         "--convert-to", "pdf", "--outdir", workdir, src],
        timeout=_SOFFICE_TIMEOUT_S, check=True, capture_output=True,
    )
    pdf = os.path.join(workdir, "deck.pdf")
    if not os.path.exists(pdf):
        raise RuntimeError("LibreOffice 未产出 PDF")
    return pdf


def render_deck_previews(pptx_bytes: bytes) -> list[bytes]:
    """.pptx → 每页一张 PNG（顺序与幻灯片一致）。失败抛错，由调用方决定是否降级。"""
    import pypdfium2 as pdfium

    with tempfile.TemporaryDirectory() as tmp:
        pdf_path = _pptx_to_pdf(pptx_bytes, tmp)
        doc = pdfium.PdfDocument(pdf_path)
        out: list[bytes] = []
        try:
            for i in range(len(doc)):
                page = doc[i]
                scale = _WIDTH_PX / max(page.get_width(), 1)
                pil = page.render(scale=scale).to_pil()
                import io

                buf = io.BytesIO()
                pil.save(buf, "PNG", optimize=True)
                out.append(buf.getvalue())
        finally:
            doc.close()
    return out


# ---- 资料库 PDF 转页图(spec 2026-08-08-library-pdf-pages) ----

_PDF_PAGE_MAX = 5          # 只服务证书类小 PDF;超页数明示"暂不支持",不做选页界面(用户拍板)
_PDF_PAGE_WIDTH_PX = 1600  # 证书文字对 OCR 可读;前端插入时自会压到 1200 JPEG 内嵌


class TooManyPages(Exception):
    """页数超上限——路由层映射为 422 too_many_pages。"""


class UnrenderablePdf(Exception):
    """加密/损坏/非 PDF——路由层映射为 422 unrenderable。"""


def render_pdf_pages(pdf_bytes: bytes, max_pages: int = _PDF_PAGE_MAX,
                     width_px: int = _PDF_PAGE_WIDTH_PX) -> list[tuple[bytes, int, int]]:
    """PDF → 每页一张 PNG(按页序)。返回 [(png_bytes, width, height)]。
    渲染循环与 render_deck_previews 同源:按宽等比缩放、PIL 存 PNG。
    先查页数再渲染——6 页的文件不该白渲 5 页才发现超限。"""
    import io

    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(pdf_bytes)
    except Exception as e:  # noqa: BLE001 pdfium 对加密/损坏抛自家异常,统一归为不可渲染
        raise UnrenderablePdf(str(e)) from e
    try:
        if len(doc) > max_pages:
            raise TooManyPages(f"{len(doc)} pages > {max_pages}")
        out: list[tuple[bytes, int, int]] = []
        for i in range(len(doc)):
            page = doc[i]
            scale = width_px / max(page.get_width(), 1)
            pil = page.render(scale=scale).to_pil()
            buf = io.BytesIO()
            pil.save(buf, "PNG", optimize=True)
            out.append((buf.getvalue(), pil.width, pil.height))
        return out
    finally:
        doc.close()
