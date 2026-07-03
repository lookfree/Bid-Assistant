from __future__ import annotations

from typing import Annotated, TypedDict
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import tools_condition
from langgraph.graph.message import add_messages
from agent.framework.hooks import run_turn, BuildMessagesHook, DropMalformedToolCallsHook
from agent.framework.resilient import resilient_tool_node
from agent.framework.structured import make_submit_tool
from agent.models.usage import record_ctx_usage


class GraphState(TypedDict):
    """消息式图状态：单循环（BaseAgent）与 create_agent 子图共用。"""
    messages: Annotated[list, add_messages]


def add_tools_loop(g, tools: list) -> None:
    """给已有 agent 节点的图接上 resilient tools 循环（无工具则 agent 直达 END）。"""
    if tools:
        g.add_node("tools", resilient_tool_node(tools))
        g.add_conditional_edges("agent", tools_condition, {"tools": "tools", END: END})
        g.add_edge("tools", "agent")
    else:
        g.add_edge("agent", END)


def make_agent_node(ctx, hooks: list, tools: list):
    """构造图的 agent 节点：run_turn 出一轮 → best-effort 记 token 用量 → 写回 messages。
    BaseAgent 单循环与 build_create_agent 子图共用（唯一差异是外围拓扑/checkpointer）。"""
    llm = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
    llm_with_tools = llm.bind_tools(tools) if (llm and tools) else llm

    async def agent_node(state, config=None):
        turn = await run_turn(hooks, llm_with_tools, state, config)
        # agent_node 走 get_chat(...).ainvoke 绕过 gateway.invoke，这里补记用量（否则 settle 汇总 0）。
        record_ctx_usage(ctx, turn.result, node="agent", model=getattr(llm, "model_name", None))
        return {"messages": [turn.result]}

    return agent_node


def build_create_agent(prompt: str, tools: list, ctx):
    """把「提示词 + 工具」编成一个可 ainvoke 的确定性子图（agent_node + resilient tools 循环），
    不带 checkpointer/interrupt——供工作流图节点内部跑确定性子 agent（读标/审查/提纲等，§4.2）。"""
    hooks = [BuildMessagesHook(prompt), DropMalformedToolCallsHook()]
    g = StateGraph(GraphState)
    g.add_node("agent", make_agent_node(ctx, hooks, tools))
    g.add_edge(START, "agent")
    add_tools_loop(g, tools)
    return g.compile()   # 无 checkpointer/interrupt：确定性子图


async def run_submit_agent(ctx, prompt: str, user_msg: str,
                           tool_name: str, schema, desc: str, extra_tools: list | None = None):
    """跑一个「必须用 submit 工具提交 schema 结构化结果」的子 agent，返回校验后的实例。
    模型没提交（含提交但校验失败）就抛错 → run 落 failed 而非把空结果当成功；
    checkpoint 停在节点前，客户端重发 run 即重试本节点。工作流各 submit 节点共用。
    只有 submit 一个工具时走 tool_choice 强制路径（模型自由发挥不调工具是真实高频失败模式）。"""
    submit, get_result = make_submit_tool(tool_name, schema, desc)
    if extra_tools:
        sub = build_create_agent(prompt, [*extra_tools, submit], ctx)
        await sub.ainvoke({"messages": [{"role": "user", "content": user_msg}]})
    else:
        await _forced_submit(ctx, prompt, user_msg, submit, tool_name)
    result = get_result()
    if result is None:
        raise RuntimeError(f"模型未通过 {tool_name} 提交结构化结果")
    return result


async def _forced_submit(ctx, prompt: str, user_msg: str, submit, tool_name: str, attempts: int = 3) -> None:
    """纯 submit 节点：tool_choice 锁定提交工具，模型无法只回文字；
    Pydantic 校验失败把错误喂回，最多重试 attempts 轮。"""
    llm = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
    forced = llm.bind_tools([submit], tool_choice=tool_name)
    messages: list = [SystemMessage(content=prompt), HumanMessage(content=user_msg)]
    for _ in range(attempts):
        msg = await forced.ainvoke(messages)
        record_ctx_usage(ctx, msg, node="agent", model=getattr(llm, "model_name", None))
        call = next((c for c in (getattr(msg, "tool_calls", None) or []) if c["name"] == tool_name), None)
        if call is None:
            return                       # 模型没产出提交调用（如 fake 模型）：交给上层抛"未提交"
        try:
            await submit.ainvoke(call["args"])
            return                       # 校验通过，结果已被 make_submit_tool 捕获
        except Exception as e:  # noqa: BLE001 校验错误喂回模型修正
            messages = [*messages, msg,
                        ToolMessage(content=f"提交被拒绝：{e}。请修正字段后重新提交。", tool_call_id=call["id"])]
