from __future__ import annotations

from typing import Annotated, TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import tools_condition
from langgraph.graph.message import add_messages
from agent.framework.hooks import run_turn, BuildMessagesHook, DropMalformedToolCallsHook
from agent.framework.resilient import resilient_tool_node
from agent.models.usage import record_llm_usage


class _State(TypedDict):
    messages: Annotated[list, add_messages]


def make_agent_node(ctx, hooks: list, tools: list):
    """构造图的 agent 节点：run_turn 出一轮 → best-effort 记 token 用量 → 写回 messages。
    BaseAgent 单循环与 build_create_agent 子图共用（唯一差异是外围拓扑/checkpointer）。"""
    llm = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
    llm_with_tools = llm.bind_tools(tools) if (llm and tools) else llm

    async def agent_node(state, config=None):
        turn = await run_turn(hooks, llm_with_tools, state, config)
        # agent_node 走 get_chat(...).ainvoke 绕过 gateway.invoke，这里补记用量（否则 settle 汇总 0）。
        _s = getattr(ctx.gateway, "s", None) if ctx.gateway else None
        record_llm_usage(ctx.recorder, run_id=ctx.run_id, agent_type=ctx.agent_type,
                         provider=getattr(_s, "model_default_provider", None),
                         model=getattr(llm, "model_name", None),
                         msg=turn.result, node="agent", thread_id=ctx.thread_id)
        return {"messages": [turn.result]}

    return agent_node


def build_create_agent(prompt: str, tools: list, ctx):
    """把「提示词 + 工具」编成一个可 ainvoke 的确定性子图（agent_node + resilient tools 循环），
    不带 checkpointer/interrupt——供工作流图节点内部跑确定性子 agent（读标/审查/提纲等，§4.2）。"""
    hooks = [BuildMessagesHook(prompt), DropMalformedToolCallsHook()]
    g = StateGraph(_State)
    g.add_node("agent", make_agent_node(ctx, hooks, tools))
    g.add_edge(START, "agent")
    if tools:
        g.add_node("tools", resilient_tool_node(tools))
        g.add_conditional_edges("agent", tools_condition, {"tools": "tools", END: END})
        g.add_edge("tools", "agent")
    else:
        g.add_edge("agent", END)
    return g.compile()   # 无 checkpointer/interrupt：确定性子图
