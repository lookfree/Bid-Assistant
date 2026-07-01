from __future__ import annotations

from typing import Annotated, Any, AsyncIterator, TypedDict
from dataclasses import dataclass, field
from langchain_core.messages import HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import tools_condition
from langgraph.graph.message import add_messages
from agent.framework.hooks import AgentHook, run_turn, BuildMessagesHook, DropMalformedToolCallsHook
from agent.framework.resilient import resilient_tool_node
from agent.runtime.registry import register, RunContext
from agent.models.usage import extract_usage


class GraphState(TypedDict):
    messages: Annotated[list, add_messages]


@dataclass
class AgentBuild:
    """子类 build() 返回：提示词 + 工具 + 额外钩子 + 可选压缩节点。"""
    prompt: str
    tools: list = field(default_factory=list)
    extra_hooks: list[AgentHook] = field(default_factory=list)
    compressor: Any = None


class BaseAgent:
    agent_type: str = ""

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        if getattr(cls, "agent_type", ""):
            register(cls.agent_type, cls)        # 子类即注册一个 agent_type

    def build(self, ctx: RunContext) -> AgentBuild:
        raise NotImplementedError

    def _compile(self, ctx: RunContext, checkpointer):
        b = self.build(ctx)
        llm = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
        llm_with_tools = llm.bind_tools(b.tools) if (llm and b.tools) else llm
        hooks = [BuildMessagesHook(b.prompt), DropMalformedToolCallsHook(), *b.extra_hooks]

        async def agent_node(state, config=None):
            turn = await run_turn(hooks, llm_with_tools, state, config)
            # 框架统一埋点：agent_node 走 get_chat(...).ainvoke 绕过了 gateway.invoke，
            # 这里补记 token 用量，否则真实 run 不上报、spec108 settle 永远汇总 0。
            if ctx.recorder is not None and ctx.run_id:
                u = extract_usage(turn.result)
                _s = getattr(ctx.gateway, "s", None) if ctx.gateway else None
                ctx.recorder.record_usage(
                    ctx.run_id, ctx.agent_type,
                    provider=getattr(_s, "model_default_provider", None),
                    model=getattr(llm, "model_name", None),
                    input_tokens=u["input"], output_tokens=u["output"], cached_tokens=u["cached"],
                    reasoning_tokens=u["reasoning"], total_tokens=u["total"], node="agent",
                    ttft_ms=None,                         # 流式接入后填
                    finish_reason=u["finish_reason"], thread_id=ctx.thread_id,
                )
            return {"messages": [turn.result]}

        g = StateGraph(GraphState)
        if b.compressor:
            g.add_node("compressor", b.compressor)
            g.add_edge(START, "compressor")
            g.add_edge("compressor", "agent")
        else:
            g.add_edge(START, "agent")
        g.add_node("agent", agent_node)
        if b.tools:
            g.add_node("tools", resilient_tool_node(b.tools))
            g.add_conditional_edges("agent", tools_condition, {"tools": "tools", END: END})
            g.add_edge("tools", "agent")
        else:
            g.add_edge("agent", END)
        return g.compile(checkpointer=checkpointer)

    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        from agent.checkpointer import get_checkpointer
        graph = self._compile(ctx, await get_checkpointer())
        config = {"configurable": {"thread_id": ctx.thread_id}}
        init = {"messages": [HumanMessage(content=str(input.get("text", input)))]}
        async for mode, chunk in graph.astream(init, config=config, stream_mode=["updates", "messages"]):
            if mode == "messages":
                msg, _meta = chunk
                if getattr(msg, "content", ""):
                    yield {"type": "chunk", "node": "agent", "data": {"delta": msg.content}}
            elif mode == "updates":
                if "__interrupt__" in chunk:                  # HITL
                    intr = chunk["__interrupt__"][0]
                    yield {"type": "hitl.required", "data": getattr(intr, "value", intr)}
                    return
                for node, val in chunk.items():
                    yield {"type": "node.end", "node": node,
                           "data": {"result": _final_text(val)}}

    async def aresume(self, value: Any, ctx: RunContext) -> AsyncIterator[dict]:
        from agent.checkpointer import get_checkpointer
        from langgraph.types import Command
        graph = self._compile(ctx, await get_checkpointer())
        config = {"configurable": {"thread_id": ctx.thread_id}}
        async for mode, chunk in graph.astream(Command(resume=value), config=config, stream_mode=["updates", "messages"]):
            if mode == "messages":
                msg, _ = chunk
                if getattr(msg, "content", ""):
                    yield {"type": "chunk", "node": "agent", "data": {"delta": msg.content}}


def _final_text(val: Any) -> Any:
    if isinstance(val, dict):
        msgs = val.get("messages")
        if msgs:
            return getattr(msgs[-1], "content", None)
    return None
