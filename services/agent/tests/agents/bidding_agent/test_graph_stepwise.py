import asyncio
from langgraph.checkpoint.memory import MemorySaver
from agent.runtime.registry import get_agent, RunContext
import agent.agents.bidding_agent  # noqa: F401 注册


_READ_ARGS = {
    "categories": [{"key": "qualification", "title": "资格", "items":
                    [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
    "risk_summary": ["缺 ISO27001 即废标"],
}
_OUTLINE_ARGS = {"chapters": [
    {"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 需求理解"}]},
]}
_ARGS_BY_TOOL = {"submit_read_result": _READ_ARGS, "submit_outline": _OUTLINE_ARGS}


def test_run1_produces_read_then_stops(submit_gateway):
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway(_ARGS_BY_TOOL), checkpointer=MemorySaver())

    async def run():
        return [e async for e in agent.astream({"file_key": "uploads/x/tender.pdf"}, ctx)]

    evs = asyncio.run(run())
    done = [e for e in evs if e["type"] == "step.done"][-1]
    assert done["node"] == "read"
    assert done["data"]["result"]["risk_summary"] == ["缺 ISO27001 即废标"]


def test_run2_resumes_to_outline(submit_gateway):
    """同 thread_id 第二个 run：checkpointer 续状态，推进到 outline 并产出真实提纲。"""
    agent = get_agent("bidding_agent")
    cp = MemorySaver()
    gw = submit_gateway(_ARGS_BY_TOOL)
    ctx1 = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="proj-2", gateway=gw, checkpointer=cp)
    ctx2 = RunContext(run_id="r2", agent_type="bidding_agent", thread_id="proj-2", gateway=gw, checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx1):
            pass                                  # run1 → read，停在断点
        return [e async for e in agent.astream({}, ctx2)]   # run2 → 续到 outline

    evs = asyncio.run(go())
    done = [e for e in evs if e["type"] == "step.done"][-1]
    assert done["node"] == "outline"              # 续跑推进到了下一节点
    assert [c["id"] for c in done["data"]["result"]["chapters"]] == ["t1"]
