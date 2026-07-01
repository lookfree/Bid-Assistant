from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from langchain_core.messages import SystemMessage


@dataclass
class AgentTurnContext:
    state: dict
    config: Any = None
    messages: list = field(default_factory=list)
    llm: Any = None
    result: Any = None                       # LLM 调用后的 AIMessage
    output_extras: dict = field(default_factory=dict)


class AgentHook:
    async def pre_invoke(self, ctx: AgentTurnContext) -> None: ...
    async def post_invoke(self, ctx: AgentTurnContext) -> None: ...


class BuildMessagesHook(AgentHook):
    """注入系统提示 + 用历史拼消息。"""
    def __init__(self, prompt: str | None = None):
        self._prompt = prompt

    async def pre_invoke(self, ctx: AgentTurnContext) -> None:
        history = list(ctx.state.get("messages", []))
        ctx.messages = ([SystemMessage(content=self._prompt)] + history) if self._prompt else history


class DropMalformedToolCallsHook(AgentHook):
    """丢弃模型产出的畸形 tool call（无 name/args），避免下游崩。"""
    async def post_invoke(self, ctx: AgentTurnContext) -> None:
        res = ctx.result
        calls = getattr(res, "tool_calls", None)
        if calls:
            good = [c for c in calls if c.get("name")]
            if len(good) != len(calls):
                res.tool_calls = good


async def run_turn(hooks: list[AgentHook], llm: Any, state: dict, config: Any) -> AgentTurnContext:
    ctx = AgentTurnContext(state=state, config=config, llm=llm)
    for h in hooks:
        await h.pre_invoke(ctx)
    ctx.result = await ctx.llm.ainvoke(ctx.messages)   # 钩子可在 pre 改 ctx.llm（如绑 tool_choice）
    for h in hooks:
        await h.post_invoke(ctx)
    return ctx
