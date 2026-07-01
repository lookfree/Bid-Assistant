import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
from agent.framework.hooks import AgentHook, run_turn, BuildMessagesHook


class _FakeLLM:
    async def ainvoke(self, messages):
        from langchain_core.messages import AIMessage
        return AIMessage(content="ok")


class _OrderHook(AgentHook):
    def __init__(self, log):
        self.log = log

    async def pre_invoke(self, ctx):
        self.log.append("pre")

    async def post_invoke(self, ctx):
        self.log.append("post")


def test_run_turn_order_and_system_prompt():
    log = []
    state = {"messages": [HumanMessage(content="hi")]}
    hooks = [BuildMessagesHook("SYS"), _OrderHook(log)]
    ctx = asyncio.run(run_turn(hooks, _FakeLLM(), state, None))
    assert log == ["pre", "post"]                       # pre 全跑→LLM→post 全跑
    assert isinstance(ctx.messages[0], SystemMessage)    # 系统提示注入
    assert ctx.result.content == "ok"                    # LLM 结果在 ctx
