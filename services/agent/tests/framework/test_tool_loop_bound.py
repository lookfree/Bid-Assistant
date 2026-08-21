"""图路径（agent ↔ tools 循环）必须有轮数上限。

背景：resilient_tool_node 把工具异常转成 status=error 的 ToolMessage 回喂（不炸图），
模型可以对同一个失败工具无限重试。而 LangGraph 1.x 的默认 recursion_limit 是 **10007**
（langgraph/_internal/_config.py，不是老版的 25）——不显式设限等于没有上限，
每一轮都是一次带整份招标文件的真实模型调用。
"""
import asyncio
import uuid

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.errors import GraphRecursionError
from pydantic import BaseModel

from agent.framework.create_agent import TOOL_LOOP_RECURSION_LIMIT, run_submit_agent
from agent.runtime.registry import RunContext


class _Result(BaseModel):
    ok: bool


@tool
def boom_tool() -> str:
    """一个恒失败的工具（模拟 parse_document 对坏文件的持续报错）。"""
    raise RuntimeError("解析失败")


class _NopRec:
    def record_usage(self, *a, **k):
        pass

    def log_event(self, *a, **k):
        pass


class _ScriptedChat:
    """按脚本产出 AIMessage 的假模型；calls 记录被调用次数。"""

    def __init__(self, script, calls):
        self.script = script
        self.calls = calls

    def bind_tools(self, tools, **kw):
        return self

    async def ainvoke(self, messages, **kw):
        i = len(self.calls)
        self.calls.append(i)
        return self.script(i)


class _Gateway:
    def __init__(self, script, calls):
        self.script = script
        self.calls = calls

    def get_chat(self, provider=None, model=None, **kw):
        return _ScriptedChat(self.script, self.calls)


def _ctx(script, calls) -> RunContext:
    return RunContext(run_id=str(uuid.uuid4()), agent_type="t", thread_id=str(uuid.uuid4()),
                      recorder=_NopRec(), gateway=_Gateway(script, calls))


def _tool_call(name: str, args: dict, i: int) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"c{i}"}])


def _run(ctx):
    return asyncio.run(run_submit_agent(
        ctx, "prompt", "user", "submit_x", _Result, "提交",
        extra_tools=[boom_tool],
    ))


def test_endless_tool_retry_stops_at_the_limit():
    """模型每轮都调那个恒失败的工具 → 必须在有限轮内抛 GraphRecursionError，而不是转到天荒地老。"""
    calls: list[int] = []
    ctx = _ctx(lambda i: _tool_call("boom_tool", {}, i), calls)

    with pytest.raises(GraphRecursionError):
        _run(ctx)

    # 超步 = 2×工具轮 + 1 ⇒ 模型被调用次数 ≈ (limit+1)//2，绝不能是 5000 量级
    assert len(calls) <= (TOOL_LOOP_RECURSION_LIMIT + 1) // 2 + 1


def test_normal_path_is_unaffected():
    """正常路径（先调一次工具，再提交）只占 5 个超步，远在上限内，不能被这道闸误杀。"""
    calls: list[int] = []

    def script(i):
        if i == 0:
            return _tool_call("boom_tool", {}, i)       # 第一轮调工具（失败也无妨）
        if i == 1:
            return _tool_call("submit_x", {"ok": True}, i)
        return AIMessage(content="已提交")               # 收尾轮：无 tool_call → END

    result = _run(_ctx(script, calls))
    assert result.ok is True
    assert len(calls) == 3
