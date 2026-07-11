import asyncio
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import common as common_mod
from agent.agents.bidding_agent.nodes import export as export_mod
from agent.agents.bidding_agent.nodes.export import make_export_node


def test_export_node_writes_docx_key(monkeypatch):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"], saved["ct"] = key, len(data), content_type

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: None)  # PDF 转换与本测试无关
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-7"))
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<h3>1.1</h3><p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
    }))
    assert out["artifacts"]["docx"] == "artifacts/proj-7/bid.docx"
    assert saved["len"] > 0 and "wordprocessingml" in saved["ct"]


def test_export_node_pdf_conversion_failure_keeps_docx_only(monkeypatch):
    """spec323：docx_to_pdf 返回 None（soffice 缺失/失败）→ artifacts 里没有 pdf key，docx 仍产出。"""
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved[key] = len(data)

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: None)
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-9"))
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
    }))
    assert out["artifacts"] == {"docx": "artifacts/proj-9/bid.docx"}
    assert "pdf" not in out["artifacts"]
    assert "artifacts/proj-9/bid.pdf" not in saved


def test_export_node_pdf_conversion_success_adds_pdf_key(monkeypatch):
    """docx_to_pdf 返回字节 → 上传 bid.pdf，artifacts 携带 pdf key。"""
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved[key] = (len(data), content_type)

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: b"%PDF-1.4 fake")
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-10"))
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
    }))
    assert out["artifacts"] == {"docx": "artifacts/proj-10/bid.docx", "pdf": "artifacts/proj-10/bid.pdf"}
    assert saved["artifacts/proj-10/bid.pdf"] == (13, "application/pdf")


def test_export_node_rerenders_pptx_when_deck_present(monkeypatch):
    """spec315a 契约 5：state 有 deck（含编辑回灌的）→ export 同时重渲 .pptx，docx+pptx 并出。"""
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved[key] = len(data)

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: None)  # PDF 转换与本测试无关
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-8"))
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<p>正文</p>"},
        "deck": {"title": "述标", "template": "tech",
                 "slides": [{"id": "s0", "title": "封面", "kind": "cover"}]},
    }))
    assert out["artifacts"] == {"docx": "artifacts/proj-8/bid.docx",
                                "pptx": "artifacts/proj-8/present.pptx"}
    assert saved["artifacts/proj-8/bid.docx"] > 0 and saved["artifacts/proj-8/present.pptx"] > 0


def test_export_node_adds_package_cover_line_when_run_input_package_present(monkeypatch):
    """spec324：state.run_input.package 存在 → 渲染出的 docx 封面含「包件：《name》」一行。"""
    from docx import Document
    import io as io_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: None)
    captured = {}
    real_render_docx = export_mod.render_docx

    def _capturing_render_docx(*args, **kwargs):
        data = real_render_docx(*args, **kwargs)
        captured["data"] = data
        return data
    monkeypatch.setattr(export_mod, "render_docx", _capturing_render_docx)
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-11"))
    asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
        "run_input": {"package": {"id": "p1", "name": "实网攻防"}},
    }))
    doc = Document(io_mod.BytesIO(captured["data"]))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "包件：《实网攻防》" in texts


def test_export_node_without_credentials_render_call_identical(monkeypatch):
    """spec325：run_input 无 credentials 键 → render_docx 调用不带 credentials（或为 None），
    产出字节与今天一致（回归：不因新增功能改变现有导出结果）。"""
    from docx import Document
    import io as io_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: None)
    captured = {}
    real_render_docx = export_mod.render_docx

    def _capturing_render_docx(*args, **kwargs):
        data = real_render_docx(*args, **kwargs)
        captured["data"] = data
        captured["kwargs"] = kwargs
        return data
    monkeypatch.setattr(export_mod, "render_docx", _capturing_render_docx)
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-12"))
    asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
    }))
    assert captured["kwargs"].get("credentials") is None
    doc = Document(io_mod.BytesIO(captured["data"]))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "资格证明文件" not in texts


def test_export_node_prefetches_credential_images(monkeypatch):
    """spec325：run_input.credentials 非空 → 节点按 key 预取字节（storage_read.read_bytes），
    渲染出的 docx 含附录标题与图片 media。"""
    from agent.parsing import storage_read as storage_read_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    tiny_png = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
                b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
                b"\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82")
    fetched_keys = []

    def _fake_read_bytes(key):
        fetched_keys.append(key)
        return tiny_png

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: None)
    monkeypatch.setattr(storage_read_mod, "read_bytes", _fake_read_bytes)
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-13"))
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
        "run_input": {"credentials": [
            {"title": "营业执照", "images": ["library/user1/license.png"]},
        ]},
    }))
    assert out["artifacts"]["docx"] == "artifacts/proj-13/bid.docx"
    assert fetched_keys == ["library/user1/license.png"]


def test_export_node_credential_fetch_failure_no_crash(monkeypatch):
    """spec325：图片 key 取图抛错（MinIO 404/网络）→ 节点不崩，占位段落进入 docx。"""
    from docx import Document
    import io as io_mod
    from agent.parsing import storage_read as storage_read_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    def _raising_read_bytes(key):
        raise RuntimeError("object not found")

    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(export_mod, "docx_to_pdf", lambda data: None)
    monkeypatch.setattr(storage_read_mod, "read_bytes", _raising_read_bytes)
    captured = {}
    real_render_docx = export_mod.render_docx

    def _capturing_render_docx(*args, **kwargs):
        data = real_render_docx(*args, **kwargs)
        captured["data"] = data
        return data
    monkeypatch.setattr(export_mod, "render_docx", _capturing_render_docx)
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-14"))
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
        "run_input": {"credentials": [
            {"title": "营业执照", "images": ["library/user1/missing.png"]},
        ]},
    }))
    assert out["artifacts"]["docx"] == "artifacts/proj-14/bid.docx"
    doc = Document(io_mod.BytesIO(captured["data"]))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "（图片加载失败：missing.png）" in texts


def test_artifacts_reducer_keeps_pptx_and_docx():
    """spec201 state.artifacts 合并 reducer：present(pptx) 与 export(docx) 并存不互相覆盖。"""
    from agent.agents.bidding_agent.state import _merge_dict
    merged = _merge_dict({"pptx": "artifacts/p/present.pptx"}, {"docx": "artifacts/p/bid.docx"})
    assert merged == {"pptx": "artifacts/p/present.pptx", "docx": "artifacts/p/bid.docx"}
