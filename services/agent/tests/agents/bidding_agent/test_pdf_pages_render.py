"""资料库 PDF 一键转页图(spec 2026-08-08):渲染层。
用 pypdfium2 现场造 PDF,不往仓库塞二进制夹具。"""
import pypdfium2 as pdfium
import pytest

from agent.agents.bidding_agent.render.preview import (
    TooManyPages, UnrenderablePdf, render_pdf_pages)


def _pdf_with_pages(n: int) -> bytes:
    doc = pdfium.PdfDocument.new()
    for _ in range(n):
        doc.new_page(595, 842)  # A4 点阵尺寸
    import io
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def test_renders_each_page_as_png_at_target_width():
    pages = render_pdf_pages(_pdf_with_pages(2))
    assert len(pages) == 2
    for png, w, h in pages:
        assert png[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG 字节"
        assert abs(w - 1600) <= 1 and h > w, "A4 竖版按宽 1600 等比,高应大于宽"


def test_more_than_max_pages_is_rejected_before_rendering():
    with pytest.raises(TooManyPages):
        render_pdf_pages(_pdf_with_pages(6))


def test_garbage_bytes_raise_unrenderable():
    with pytest.raises(UnrenderablePdf):
        render_pdf_pages(b"not a pdf at all")
