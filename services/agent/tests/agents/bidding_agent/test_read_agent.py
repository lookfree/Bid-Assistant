import asyncio
import os
import uuid
import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from agent.runtime.registry import get_agent, RunContext
from agent.telemetry.recorder import Recorder
from agent.db import get_pool
import agent.agents.bidding_agent  # noqa: F401 触发 register("bidding_agent")


_RESULT_ARGS = {
    "categories": [{"key": "qualification", "title": "资格要求",
                    "items": [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
    "risk_summary": ["ISO27001 缺失即废标"],
}


class _ToolThenDoneChat:
    """第 1 次回 submit_read_result 的 tool_call，第 2 次回结束语。"""
    def __init__(self):
        self.n = 0

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_read_result", "args": _RESULT_ARGS, "id": "c1"}])
        return AIMessage(content="读标完成")


class _GW:
    def get_chat(self, provider=None, model=None, **kw):
        return _ToolThenDoneChat()


def test_read_agent_captures_structured_result(cleanup_run):
    agent = get_agent("bidding_agent")                      # BiddingAgent 已注册
    ctx = RunContext(run_id=cleanup_run(str(uuid.uuid4())), agent_type="bidding_agent",
                     thread_id=str(uuid.uuid4()), recorder=Recorder(get_pool()), gateway=_GW(),
                     checkpointer=MemorySaver())

    async def run():
        return [ev async for ev in agent.astream({"file_key": "uploads/x/tender.pdf"}, ctx)]

    evs = asyncio.run(run())
    # spec201 后：read 是工作流首节点，产出走 step.done（跑到 read 后 interrupt 停）
    finals = [e for e in evs if e["type"] == "step.done" and e["node"] == "read"]
    assert finals, "应产出 read 结构化结果"
    res = finals[-1]["data"]["result"]
    assert res["categories"][0]["items"][0]["risk"] is True
    assert res["risk_summary"] == ["ISO27001 缺失即废标"]


@pytest.mark.skipif(not os.getenv("DEEPSEEK_API_KEY"), reason="需真实模型")
def test_read_agent_real_smoke():
    """可选：配了 Key + 上传过招标文件时，真实读标产出六大分类。"""
    ...
