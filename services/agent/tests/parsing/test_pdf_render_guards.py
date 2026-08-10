"""PDF 渲染的两道护栏：PDFium 全局串行化 + 单页像素帽。

**为什么要串行化**：pypdfium2 底下是同一个 C 库的进程级全局状态，两个线程同时进入会原生
段错误——进程直接消失，没有 Python 异常也没有日志。本进程有两条互不相干的渲染路径会落到
不同的线程池线程上（扫描页 OCR 的 render_many、述标预览/资料库转页图的渲染循环），
agent_worker_concurrency=5 下它们同时开工是常态。

测试不去赌段错误（赌不出来，也没法在 CI 里稳定复现），而是直接验「锁真的被持有」：
从**另一个线程**非阻塞试探那把模块级锁，拿不到就说明渲染线程正持着它。
"""
import threading
import time

import pytest
from PIL import Image

from agent.parsing import pdf_render
from agent.parsing.pdf_render import PdfPageRenderer, page_image


def _lock_is_held() -> bool:
    """从**另一个线程**非阻塞试探 PDFIUM_LOCK：拿不到 = 当前线程正持锁。
    必须换线程试——可重入锁对持有者永远 acquire 成功，同线程试探什么都测不出来。"""
    got: list[bool] = []

    def _probe() -> None:
        ok = pdf_render.PDFIUM_LOCK.acquire(blocking=False)
        if ok:
            pdf_render.PDFIUM_LOCK.release()
        got.append(ok)

    t = threading.Thread(target=_probe)
    t.start()
    t.join()
    return not got[0]


class _FakeBitmap:
    def to_pil(self):
        return Image.new("RGB", (4, 3))


class _FakePage:
    """只实现 pdfium 页面被用到的三个方法：记下 scale、按需在渲染中回调/阻塞。"""

    def __init__(self, width=595.0, height=842.0, delay=0.0, on_render=None):
        self._w, self._h = width, height
        self._delay, self._on_render = delay, on_render
        self.scales: list[float] = []

    def get_width(self):
        return self._w

    def get_height(self):
        return self._h

    def render(self, scale):
        self.scales.append(scale)
        if self._on_render:
            self._on_render()
        if self._delay:
            time.sleep(self._delay)
        return _FakeBitmap()


# ---- 串行化 ----

def test_page_image_renders_while_holding_the_global_pdfium_lock():
    """渲染那一跳必须在模块级锁内：锁没了 → 探针拿得到锁 → 本条红。"""
    seen: list[bool] = []
    page = _FakePage(on_render=lambda: seen.append(_lock_is_held()))
    page_image(page, 1600, "JPEG")
    assert seen == [True]


def test_two_threads_never_render_at_the_same_time():
    """两个线程同时渲染（OCR 与述标预览的真实并发形状）必须被挡成串行：
    没有锁时两条 render 会重叠，峰值并发 2 —— 这就是原生段错误的触发条件。"""
    guard = threading.Lock()
    live = 0
    peak = 0

    def _enter():
        nonlocal live, peak
        with guard:
            live += 1
            peak = max(peak, live)

    def _leave():
        nonlocal live
        with guard:
            live -= 1

    def _render():
        page = _FakePage(delay=0.05, on_render=_enter)
        try:
            page_image(page, 1600, "JPEG")
        finally:
            _leave()

    threads = [threading.Thread(target=_render) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak == 1, f"两个线程同时进了 pdfium（峰值并发 {peak}）"


def test_render_many_holds_the_lock_across_the_whole_chunk(monkeypatch):
    """OCR 的分块渲染整段持锁：块内每页都在锁里，中途不放手让别的线程插进来。"""
    seen: list[bool] = []
    monkeypatch.setattr(pdf_render, "page_image",
                        lambda page, w, fmt="PNG": (seen.append(_lock_is_held()), (b"x", 1, 1))[1])
    r = object.__new__(PdfPageRenderer)      # 绕开 pdfium：本条测的是持锁，不是解码
    r._doc = {0: _FakePage(), 1: _FakePage()}
    r._width_px = 1600
    assert len(r.render_many([0, 1])) == 2
    assert seen == [True, True]


def test_preview_pdf_pages_render_loop_holds_the_lock(monkeypatch):
    """资料库 PDF 转页图（render/preview.py）同样要持锁——它与 OCR 渲染跑在不同线程上。"""
    import pypdfium2 as pdfium

    from agent.agents.bidding_agent.render import preview

    seen: list[bool] = []
    monkeypatch.setattr(pdf_render, "page_image",
                        lambda page, w, fmt="PNG": (seen.append(_lock_is_held()), (b"x", 1, 1))[1])
    doc = pdfium.PdfDocument.new()
    doc.new_page(595, 842)
    import io
    buf = io.BytesIO()
    doc.save(buf)
    preview.render_pdf_pages(buf.getvalue())
    assert seen == [True]


def test_deck_preview_render_loop_holds_the_lock(monkeypatch):
    """述标预览（render_deck_previews）是另一条 pdfium 入口，漏掉它等于没锁。"""
    import io

    import pypdfium2 as pdfium

    from agent.agents.bidding_agent.render import preview

    doc = pdfium.PdfDocument.new()
    doc.new_page(595, 842)
    buf = io.BytesIO()
    doc.save(buf)

    def _fake_pptx_to_pdf(data, workdir):
        path = f"{workdir}/deck.pdf"
        with open(path, "wb") as f:
            f.write(buf.getvalue())
        return path

    seen: list[bool] = []
    monkeypatch.setattr(preview, "_pptx_to_pdf", _fake_pptx_to_pdf)
    monkeypatch.setattr(pdf_render, "page_image",
                        lambda page, w, fmt="PNG": (seen.append(_lock_is_held()), (b"x", 1, 1))[1])
    assert preview.render_deck_previews(b"fake pptx") == [b"x"]
    assert seen == [True]


# ---- 像素帽 ----

def test_degenerate_narrow_page_gets_its_scale_clamped():
    """10pt 宽的畸形页（裁切页/条码页，扫描件里真实存在）：scale = 1600/10 = 160，
    渲成 10×792×160² ≈ 2 亿像素的位图——几 GB 内存 + 十几分钟 CPU，而 to_thread 里的
    渲染既取消不掉也不会超时，心跳泵还一直说这个 run 活着。必须按总像素帽反算 scale。"""
    page = _FakePage(width=10.0, height=792.0)
    page_image(page, 1600, "JPEG")
    scale = page.scales[0]
    assert scale < 160, "scale 没被夹"
    # 反算出来的 scale 恰好把位图压在帽上（浮点意义上），而不是 2 亿像素
    assert 10 * 792 * scale * scale == pytest.approx(pdf_render._MAX_PIXELS)


def test_normal_page_scale_is_untouched_by_the_cap():
    """正常 A4 页（1600px 宽 ≈ 360 万像素）远在帽下：口径逐字节不变。"""
    page = _FakePage(width=595.0, height=842.0)
    page_image(page, 1600, "PNG")
    assert page.scales[0] == pytest.approx(1600 / 595)


def test_pixel_cap_is_a_named_constant():
    """帽是常量、不许悄悄放大：2000 万像素 ≈ 5000×4000，够任何真实页面用。"""
    assert pdf_render._MAX_PIXELS == 20_000_000
