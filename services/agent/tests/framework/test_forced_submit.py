import json
import uuid

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk
from pydantic import BaseModel

from agent.framework.create_agent import run_submit_agent
from agent.runtime.registry import RunContext


class Toy(BaseModel):
    x: int


def _as_chunk(msg: AIMessage) -> AIMessageChunk:
    """把脚本里的 AIMessage 转成等价的流式 chunk（_forced_submit 已改走 astream）：
    合法 tool_calls→args 序列化为 JSON（可解析→tool_calls）；invalid→原样 bad JSON 串（解析失败→invalid_tool_calls）；
    finish_reason 等 response_metadata 原样带上（截断路径靠它判定）。"""
    kw: dict = {"content": msg.content or ""}
    if getattr(msg, "response_metadata", None):
        kw["response_metadata"] = msg.response_metadata
    tcc = [{"name": tc["name"], "args": json.dumps(tc["args"]), "id": tc.get("id"), "index": 0}
           for tc in (msg.tool_calls or [])]
    tcc += [{"name": ic.get("name"), "args": ic.get("args"), "id": ic.get("id"), "index": 0}
            for ic in (getattr(msg, "invalid_tool_calls", None) or [])]
    if tcc:
        kw["tool_call_chunks"] = tcc
    return AIMessageChunk(**kw)


class _ScriptedChat:
    """按脚本逐轮返回 AIMessage 的 fake chat：验证 _forced_submit 的重试/放弃路径。
    replies 用尽后重复最后一条（防止实现 bug 导致超轮调用时立刻 IndexError 掩盖真实断言）。"""

    def __init__(self, replies: list[AIMessage]):
        self.replies = replies
        self.n = 0

    def bind_tools(self, tools, **kw):          # 兼容 tool_choice 强制路径
        return self

    async def astream(self, messages, **kw):    # _forced_submit 走流式：每轮吐一个等价 chunk
        i = min(self.n, len(self.replies) - 1)
        self.n += 1
        yield _as_chunk(self.replies[i])


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


async def test_truncated_output_retries_with_compression_hint():
    """回归（南瑞 4 文件标实测）：输出撞 max_tokens（finish_reason=length）且 tool_calls/
    invalid_tool_calls 双空——此前被当"没提交"一次放弃；应喂回压缩指令重试。"""
    truncated = AIMessage(content="……（被截断的长输出", response_metadata={"finish_reason": "length"})
    chat = _ScriptedChat([truncated, _valid_call(x=7)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert isinstance(result, Toy) and result.x == 7
    assert chat.n == 2


async def test_truncated_output_exhausts_attempts_then_raises():
    """连续截断用尽预算 → 仍抛"未提交"（不无限重试）。"""
    truncated = AIMessage(content="x", response_metadata={"finish_reason": "length"})
    chat = _ScriptedChat([truncated, truncated, truncated])
    ctx = _ctx(_ScriptedGateway(chat))

    with pytest.raises(RuntimeError, match="未通过.*提交"):
        await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert chat.n == 3


async def test_length_truncation_beats_salvaged_tool_call():
    """流式回归（关键）：截断的 tool-call args 会被 langchain parse_partial_json 补成"看似合法"的
    dict，于是 tool_calls 非空且恰好过 schema。必须凭 finish_reason=length 先走压缩重试，
    绝不能把残缺结果当成功交付（否则大标书读标会静默丢条款）。"""
    salvaged = AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {"x": 1}, "id": "c1"}],
                         response_metadata={"finish_reason": "length"})
    chat = _ScriptedChat([salvaged, _valid_call(x=2)])
    ctx = _ctx(_ScriptedGateway(chat))

    result = await run_submit_agent(ctx, "sys", "user", "submit_x", Toy, "desc")

    assert result.x == 2      # 来自压缩重试，而非被接受的截断结果（x==1）
    assert chat.n == 2
