import os
import pytest
from agent.framework.deepagent import DeepAgent, DeepBuild
from agent.runtime.registry import get_agent, RunContext
from agent.telemetry.recorder import Recorder
from agent.db import get_pool


class DemoDeepAgent(DeepAgent):
    agent_type = "demo_deep"

    def deep_build(self, ctx):
        return DeepBuild(instructions="你是一个会规划的助手。", tools=[])


def test_deepagent_registers():
    assert get_agent("demo_deep").__class__.__name__ == "DemoDeepAgent"   # 子类化即注册


def test_deepagent_compiles_to_graph():
    # 结构性：能编译成带 astream 的图（不发真实模型请求）
    from langchain_core.language_models.fake_chat_models import FakeListChatModel

    class _GW:
        def get_chat(self, provider=None, model=None, **kw):
            return FakeListChatModel(responses=["规划完成"])

    ctx = RunContext(run_id="r", agent_type="demo_deep", thread_id="t",
                     recorder=Recorder(get_pool()), gateway=_GW())
    graph = get_agent("demo_deep")._compile(ctx)   # checkpointer 取自 ctx（此处 None）
    assert hasattr(graph, "astream")


@pytest.mark.skipif(not os.getenv("DEEPSEEK_API_KEY"), reason="需要真实模型 Key")
def test_deepagent_real_smoke():
    # 可选：配了 Key 时跑一次真实 deepagent（规划+回答）
    ...
