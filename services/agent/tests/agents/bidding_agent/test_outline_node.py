import asyncio
from langchain_core.messages import AIMessage
from agent.agents.bidding_agent.nodes.outline import make_outline_node


_OUTLINE_ARGS = {"chapters": [
    {"id": "t1", "no": "第一章", "title": "项目理解与整体方案", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 需求理解"}]},
    {"id": "b1", "no": "第一章", "title": "投标函", "group": "business", "sourced": True,
     "items": [{"id": "b1-1", "label": "1.1 投标函"}]},
]}


class _OutlineChat:
    def __init__(self):
        self.n = 0

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_outline", "args": _OUTLINE_ARGS, "id": "o1"}])
        return AIMessage(content="提纲完成")


class _GW:
    def get_chat(self, **kw):
        return _OutlineChat()


class _Ctx:
    gateway = _GW()

    def __getattr__(self, k):
        return None


def test_outline_node_reads_read_produces_outline():
    node = make_outline_node(_Ctx())
    out = asyncio.run(node({"read": {"risk_summary": ["缺 ISO27001"]}}))
    assert "outline" in out
    ids = [c["id"] for c in out["outline"]["chapters"]]
    assert ids == ["t1", "b1"]
