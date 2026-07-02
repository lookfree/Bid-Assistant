import asyncio
import pytest
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import content as content_mod


class _FakeDeep:
    """桩 deepagent：ainvoke 直接回预置 files（v2 结构，路径带前导斜杠），绕过真实 LLM 规划。"""

    def __init__(self, files):
        self.files = files

    async def ainvoke(self, _input, config=None):
        return {"messages": [], "files": self.files}


def _ctx():
    return RunContext(run_id="r", agent_type="bidding_agent", thread_id="t")


def test_content_node_collects_chapters(monkeypatch):
    files = {"/chapters/t1.html": {"content": "<h3>1.1 需求理解</h3><p>…</p>", "encoding": "utf-8"},
             "/chapters/b1.html": {"content": "<h3>1.1 投标函</h3><p>…</p>"},
             "/todos.txt": {"content": "无关 key，验证前缀过滤"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _FakeDeep(files))
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": {"chapters": [{"id": "t1"}, {"id": "b1"}]}, "read": {}}))
    assert set(out["chapters"]) == {"t1", "b1"}
    assert out["chapters"]["t1"].startswith("<h3>")


def test_content_node_fails_loud_when_no_chapters(monkeypatch):
    """deepagent 一章都没写 → 抛错（run 落 failed 可重试），不产假空 chapters。"""
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _FakeDeep({}))
    node = content_mod.make_content_node(_ctx())
    with pytest.raises(RuntimeError, match="chapters"):
        asyncio.run(node({"outline": {}, "read": {}}))
