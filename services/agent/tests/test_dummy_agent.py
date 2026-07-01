import asyncio

from agent.runtime.registry import get_agent, RunContext
import agent.runtime.dummy_agent  # noqa: F401 触发注册


def test_dummy_streams_chunks_and_result():
    agent = get_agent("dummy")
    ctx = RunContext(run_id="r", agent_type="dummy", thread_id="t", recorder=None)

    async def run():
        return [ev async for ev in agent.astream({"text": "hi"}, ctx)]

    evs = asyncio.run(run())
    assert evs[0]["type"] == "node.start"
    chunks = [e for e in evs if e["type"] == "chunk"]
    assert "".join(c["data"]["delta"] for c in chunks) == "hi"
    assert evs[-1]["data"]["result"] == {"echo": "hi", "len": 2}
