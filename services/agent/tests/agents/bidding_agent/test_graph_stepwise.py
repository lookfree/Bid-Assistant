import asyncio
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from agent.runtime.registry import get_agent, RunContext
import agent.agents.bidding_agent  # noqa: F401 注册


class _ReadSubmitChat:
    def __init__(self):
        self.n = 0

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_read_result",
                "args": {"categories": [{"key": "qualification", "title": "资格", "items":
                [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
                "risk_summary": ["缺 ISO27001 即废标"]}, "id": "c1"}])
        return AIMessage(content="done")


class _GW:
    def get_chat(self, **kw):
        return _ReadSubmitChat()


def test_run1_produces_read_then_stops():
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=_GW(), checkpointer=MemorySaver())

    async def run():
        return [e async for e in agent.astream({"file_key": "uploads/x/tender.pdf"}, ctx)]

    evs = asyncio.run(run())
    done = [e for e in evs if e["type"] == "step.done"][-1]
    assert done["node"] == "read"
    assert done["data"]["result"]["risk_summary"] == ["缺 ISO27001 即废标"]


def test_run2_resumes_to_outline_stub():
    """同 thread_id 第二个 run：checkpointer 续状态，推进到 outline（stub）。"""
    agent = get_agent("bidding_agent")
    cp = MemorySaver()
    ctx1 = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="proj-2", gateway=_GW(), checkpointer=cp)
    ctx2 = RunContext(run_id="r2", agent_type="bidding_agent", thread_id="proj-2", gateway=_GW(), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx1):
            pass                                  # run1 → read，停在断点
        return [e async for e in agent.astream({}, ctx2)]   # run2 → 续到 outline

    evs = asyncio.run(go())
    nodes = [e["node"] for e in evs if e["type"] == "step.done"]
    assert "outline" in nodes                     # 续跑推进到了下一节点
