from __future__ import annotations

from typing import Annotated, Any, AsyncIterator, TypedDict
from dataclasses import dataclass, field
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import tools_condition
from langgraph.graph.message import add_messages
from agent.framework.hooks import AgentHook, run_turn, BuildMessagesHook, DropMalformedToolCallsHook
from agent.framework.resilient import resilient_tool_node
from agent.runtime.registry import register, RunContext
from agent.models.usage import record_llm_usage


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

    def build_graph(self, ctx: RunContext):
        """可选：子类返回已编译的 CompiledStateGraph（多节点工作流）则用之；
        默认 None → 退回 build() 的单 create_agent 循环（Phase 1 行为）。"""
        return None

    def _compile(self, ctx: RunContext):
        graph = self.build_graph(ctx)
        if graph is not None:
            return graph
        return self._compile_single_loop(ctx)

    def _compile_single_loop(self, ctx: RunContext):
        b = self.build(ctx)
        llm = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
        llm_with_tools = llm.bind_tools(b.tools) if (llm and b.tools) else llm
        hooks = [BuildMessagesHook(b.prompt), DropMalformedToolCallsHook(), *b.extra_hooks]

        async def agent_node(state, config=None):
            turn = await run_turn(hooks, llm_with_tools, state, config)
            # 框架统一埋点：agent_node 走 get_chat(...).ainvoke 绕过了 gateway.invoke，
            # 这里补记 token 用量（否则真实 run 不上报、spec108 settle 汇总 0）。best-effort：
            # 埋点/DB 失败不能拖垮已成功的这一轮（与 gateway.invoke 共用 record_llm_usage）。
            _s = getattr(ctx.gateway, "s", None) if ctx.gateway else None
            record_llm_usage(ctx.recorder, run_id=ctx.run_id, agent_type=ctx.agent_type,
                             provider=getattr(_s, "model_default_provider", None),
                             model=getattr(llm, "model_name", None),
                             msg=turn.result, node="agent", thread_id=ctx.thread_id)
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
        return g.compile(checkpointer=ctx.checkpointer)

    async def _ensure_checkpointer(self, ctx: RunContext) -> None:
        # 真实 run 的 executor 不给 checkpointer；测试可直接注入 MemorySaver。缺则取 Postgres 单例。
        if ctx.checkpointer is None:
            from agent.checkpointer import get_checkpointer
            ctx.checkpointer = await get_checkpointer()

    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        await self._ensure_checkpointer(ctx)
        graph = self._compile(ctx)
        config = {"configurable": {"thread_id": ctx.thread_id}}
        init = {"messages": [HumanMessage(content=str(input.get("text", input)))]}
        stream = graph.astream(init, config=config, stream_mode=["updates", "messages"])
        async for ev in _decode_stream(stream):
            yield ev

    async def aresume(self, value: Any, ctx: RunContext) -> AsyncIterator[dict]:
        from langgraph.types import Command
        await self._ensure_checkpointer(ctx)
        graph = self._compile(ctx)
        config = {"configurable": {"thread_id": ctx.thread_id}}
        # resume 与首跑走同一解码：否则 executor 收不到 resume 段的 node.end.result，
        # 也漏掉 resume 段内的第二次 interrupt（hitl.required）。
        stream = graph.astream(Command(resume=value), config=config, stream_mode=["updates", "messages"])
        async for ev in _decode_stream(stream):
            yield ev


async def _decode_stream(stream) -> AsyncIterator[dict]:
    """把 langgraph 的 (mode, chunk) 流解成框架事件 {type, node?, data}；astream/aresume 共用。
    messages 模式只流 AIMessage 内容——工具节点的 ToolMessage/错误串不当作 agent 文本吐给前端。"""
    async for mode, chunk in stream:
        if mode == "messages":
            msg, _meta = chunk
            if isinstance(msg, AIMessage) and getattr(msg, "content", ""):
                yield {"type": "chunk", "node": "agent", "data": {"delta": msg.content}}
        elif mode == "updates":
            if "__interrupt__" in chunk:                  # HITL
                intr = chunk["__interrupt__"][0]
                yield {"type": "hitl.required", "data": getattr(intr, "value", intr)}
                return
            for node, val in chunk.items():
                yield {"type": "node.end", "node": node, "data": {"result": _final_text(val)}}


def _final_text(val: Any) -> Any:
    if isinstance(val, dict):
        msgs = val.get("messages")
        if msgs:
            return getattr(msgs[-1], "content", None)
    return None
