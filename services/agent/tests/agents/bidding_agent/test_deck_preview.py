"""述标预览图：把真实 PPT 渲染成逐页位图给前端显示。

述标页此前用一套手写 CSS 近似地画幻灯片，与导出的 PPT 是两套渲染器。两套并存必然漂移——
2026-08-07 拿客户实际产物逐页比对，评分点标签位置、要点编号样式、页码、标题分隔线四处都不一致，
用户反馈「相差太大」。显示真实渲染图是根除，而不是把当下这四处对齐了事。

这里钉住的是**边界**：预览是增强，任何失败都不能反噬述标交付——PPT 本身已经生成好了。
"""
import asyncio

from agent.agents.bidding_agent.nodes import present as mod


class _Ctx:
    thread_id = "t"


class _Recorder:
    def __init__(self):
        self.uploaded: list[tuple[str, bytes, str]] = []

    async def upload(self, ctx, filename, data, content_type):
        self.uploaded.append((filename, data, content_type))
        return f"artifacts/t/{filename}"


def _patch(monkeypatch, render, rec: _Recorder):
    monkeypatch.setattr(mod, "render_deck_previews", render)
    monkeypatch.setattr(mod, "upload_artifact", rec.upload)


def test_pages_are_uploaded_in_order(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, lambda b: [b"png1", b"png2", b"png3"], rec)
    keys = asyncio.run(mod._upload_previews(_Ctx(), b"pptx"))
    assert keys == ["artifacts/t/preview-01.png", "artifacts/t/preview-02.png", "artifacts/t/preview-03.png"]
    assert [f for f, _, _ in rec.uploaded] == ["preview-01.png", "preview-02.png", "preview-03.png"]
    assert {c for _, _, c in rec.uploaded} == {"image/png"}


def test_render_failure_does_not_break_delivery(monkeypatch):
    """soffice 缺失/超时/PDF 渲染炸了——PPT 已经生成好，不能因为"图没渲出来"就让整步失败。"""
    def _boom(_b):
        raise RuntimeError("soffice 不在")

    rec = _Recorder()
    _patch(monkeypatch, _boom, rec)
    assert asyncio.run(mod._upload_previews(_Ctx(), b"pptx")) == []
    assert rec.uploaded == []


def test_partial_upload_failure_discards_the_whole_set(monkeypatch):
    """半套图比没有更糟：页码会错位，用户看第 3 页其实是第 5 页的图。"""
    rec = _Recorder()

    async def _flaky(ctx, filename, data, content_type):
        if filename == "preview-02.png":
            raise RuntimeError("MinIO 抖了")
        return f"artifacts/t/{filename}"

    monkeypatch.setattr(mod, "render_deck_previews", lambda b: [b"a", b"b", b"c"])
    monkeypatch.setattr(mod, "upload_artifact", _flaky)
    assert asyncio.run(mod._upload_previews(_Ctx(), b"pptx")) == []


def test_zero_pages_yields_no_previews(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, lambda b: [], rec)
    assert asyncio.run(mod._upload_previews(_Ctx(), b"pptx")) == []


def test_render_runs_off_the_event_loop(monkeypatch):
    """LibreOffice 是同步阻塞进程，必须丢线程池——直接在事件循环上跑会卡住同进程所有并发 run。"""
    seen = {}
    real_to_thread = asyncio.to_thread

    async def _spy(fn, *a, **kw):
        seen["used"] = True
        return await real_to_thread(fn, *a, **kw)

    monkeypatch.setattr(mod.asyncio, "to_thread", _spy)
    _patch(monkeypatch, lambda b: [b"x"], _Recorder())
    asyncio.run(mod._upload_previews(_Ctx(), b"pptx"))
    assert seen.get("used"), "渲染没有走线程池，会阻塞事件循环"
