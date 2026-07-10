import uuid

import pytest
from langchain_core.messages import AIMessage
from pydantic import BaseModel

from agent.framework.create_agent import run_submit_agent
from agent.runtime.registry import RunContext


class Toy(BaseModel):
    x: int


class _ScriptedChat:
    """按脚本逐轮返回 AIMessage 的 fake chat：验证 _forced_submit 的重试/放弃路径。
    replies 用尽后重复最后一条（防止实现 bug 导致超轮调用时立刻 IndexError 掩盖真实断言）。"""

    def __init__(self, replies: list[AIMessage]):
        self.replies = replies
        self.n = 0

    def bind_tools(self, tools, **kw):          # 兼容 tool_choice 强制路径
        return self

    async def ainvoke(self, messages):
        i = min(self.n, len(self.replies) - 1)
        self.n += 1
        return self.replies[i]


class _ScriptedGateway:
    """每次 get_chat 返回同一个可计数 chat 实例，保证跨轮次的编排/计数不丢失。"""

    def __init__(self, chat):
        self.chat = chat

    def get_chat(self, **kw):
        return self.chat


def _ctx(gateway):
    return RunContext(run_id=str(uuid.uuid4()), agent_type="t", thread_id=str(uuid.uuid4()), gateway=gateway)


def _valid_call(x: int = 1, call_id: str = "c2") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {"x": x}, "id": call_id}])


def _invalid_call(call_id: str = "c1") -> AIMessage:
    return AIMessage(content="", tool_calls=[],
                      invalid_tool_calls=[{"name": "submit_x", "args": "{bad json",
                                           "error": "Extra data", "id": call_id}])


async def test_invalid_tool_call_retries_and_succeeds():
    """第 1 轮 invalid_tool_calls，第 2 轮合法调用 → 应成功，且 ainvoke 被调 2 次（证明重试而非放弃）。"""
    chat = _ScriptedChat([_invalid_call(), _valid_call(x=1)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert isinstance(result, Toy) and result.x == 1
    assert chat.n == 2


async def test_invalid_tool_call_exhausts_retries_and_raises():
    """连续 3 轮都是 invalid_tool_calls → 用尽预算后抛 RuntimeError（未提交结构化结果），ainvoke 被调 3 次。"""
    chat = _ScriptedChat([_invalid_call(), _invalid_call(), _invalid_call()])
    ctx = _ctx(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert chat.n == 3


async def test_pydantic_validation_failure_still_retries():
    """回归：第 1 轮合法 tool_calls 但缺字段过不了 schema，第 2 轮合法通过 → 成功，调 2 次。"""
    bad_args_call = AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {}, "id": "c1"}])
    chat = _ScriptedChat([bad_args_call, _valid_call(x=2)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert isinstance(result, Toy) and result.x == 2
    assert chat.n == 2


async def test_no_tool_call_at_all_gives_up_immediately():
    """回归：模型完全没产出提交调用（纯文本）→ 立即放弃，抛 RuntimeError（未提交结构化结果），只调 1 次。"""
    chat = _ScriptedChat([AIMessage(content="我拒绝回答")])
    ctx = _ctx(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert chat.n == 1
