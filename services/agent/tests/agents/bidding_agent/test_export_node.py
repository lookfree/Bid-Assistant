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


def test_artifacts_reducer_keeps_pptx_and_docx():
    """spec201 state.artifacts 合并 reducer：present(pptx) 与 export(docx) 并存不互相覆盖。"""
    from agent.agents.bidding_agent.state import _merge_dict
    merged = _merge_dict({"pptx": "artifacts/p/present.pptx"}, {"docx": "artifacts/p/bid.docx"})
    assert merged == {"pptx": "artifacts/p/present.pptx", "docx": "artifacts/p/bid.docx"}
