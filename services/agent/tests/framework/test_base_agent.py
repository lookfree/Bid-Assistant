import asyncio
import uuid
from langchain_core.messages import AIMessage
from agent.framework.base_agent import BaseAgent, AgentBuild
from agent.runtime.registry import RunContext, get_agent
from agent.telemetry.recorder import Recorder
from agent.db import get_pool


class _FakeChat:
    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        return AIMessage(content="你好，我是示例 agent")


class _FakeGateway:
    def get_chat(self, provider=None, model=None, **kw):
        return _FakeChat()


class EchoFrameworkAgent(BaseAgent):
    agent_type = "echo_fw"

    def build(self, ctx):
        return AgentBuild(prompt="你是示例", tools=[])


def test_framework_agent_streams_via_graph(cleanup_run):
    agent = get_agent("echo_fw")                       # __init_subclass__ 已注册
    run_id = cleanup_run(str(uuid.uuid4()))            # 真 uuid：agent_node 会 record_usage 到真库
    ctx = RunContext(run_id=run_id, agent_type="echo_fw", thread_id=str(uuid.uuid4()),
                     recorder=Recorder(get_pool()), gateway=_FakeGateway())

    async def run():
        return [ev async for ev in agent.astream({"text": "hi"}, ctx)]

    evs = asyncio.run(run())
    chunks = [e for e in evs if e["type"] == "chunk"]
    assert any("示例 agent" in (c["data"]["delta"] or "") for c in chunks)
