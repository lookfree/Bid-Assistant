import asyncio
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import export as export_mod
from agent.agents.bidding_agent.nodes.export import make_export_node


def test_export_node_writes_docx_key(monkeypatch):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"], saved["ct"] = key, len(data), content_type

    monkeypatch.setattr(export_mod, "storage", _Storage())
    node = make_export_node(RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-7"))
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<h3>1.1</h3><p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
    }))
    assert out["artifacts"]["docx"] == "artifacts/proj-7/bid.docx"
    assert saved["len"] > 0 and "wordprocessingml" in saved["ct"]
