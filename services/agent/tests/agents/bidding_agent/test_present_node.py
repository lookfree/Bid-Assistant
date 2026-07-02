import asyncio
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import present as present_mod
from agent.agents.bidding_agent.nodes.present import make_present_node


_DECK_ARGS = {"title": "述标", "duration": 15, "template": "gov", "slides": [
    {"id": "s0", "title": "封面", "kind": "cover"},
    {"id": "s1", "title": "运维体系", "bullets": ["7×24"], "notes": "讲稿", "kind": "content"},
], "qa": [{"q": "可用性？", "a": "99.9%"}]}


def test_present_node_produces_deck_and_pptx_key(monkeypatch, submit_gateway):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"] = key, len(data)

    monkeypatch.setattr(present_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck": _DECK_ARGS}))
    node = make_present_node(ctx)
    out = asyncio.run(node({"chapters": {"t3": "<h3>SLA</h3>"}, "read": {}}))
    assert out["deck"]["template"] == "gov"
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"
    assert saved["key"] == "artifacts/proj-1/present.pptx" and saved["len"] > 0   # 真渲染了 .pptx 字节
