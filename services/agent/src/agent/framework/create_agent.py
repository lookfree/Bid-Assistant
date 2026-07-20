from __future__ import annotations

import asyncio
import json
import time
from typing import Annotated, Any, TypedDict
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import tools_condition
from langgraph.graph.message import add_messages
from agent.framework.hooks import run_turn, BuildMessagesHook, DropMalformedToolCallsHook
from agent.framework.model_stream import forced_stream_submit
from agent.framework.resilient import resilient_tool_node
from agent.framework.structured import make_submit_tool
from agent.models.usage import record_ctx_usage

# 单条 submit 事件里存的提交内容上限（字符）：足够看清结构/定位坏字段，又不让单行 jsonb 失控膨胀。
_SUBMIT_LOG_MAX = 40_000


def _clip(v: Any) -> str:
    """把任意提交内容/输入规整成有界字符串（超限截断加省略号），防单行 jsonb 失控膨胀。"""
    text = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return text if len(text) <= _SUBMIT_LOG_MAX else text[:_SUBMIT_LOG_MAX] + f"…[截断，共{len(text)}字]"


async def _log_submit(ctx: Any, tool_name: str, label: str | None, outcome: str,
                      *, role: str, content: Any = None, reason: Any = None) -> None:
    """把每次 submit 的输入/输出记入 agent.agent_event_log：
    - event_type = "submit"（沿用既有事件类型记法，不改）；
    - role       = human（模型输入）/ ai（模型提交输出）——agent_event_log 专用列；
    - data       = 纯文本内容（人输入或 AI 提交内容本身；SELECT data #>> '{}' 直读，无需剥字段）；
    - event_meta = {tool, outcome: 结果, reason: 校验原因} 等元数据。
    仅覆盖 _forced_submit 的强制提交路径（读标各轮 / 提纲 / 审查 / 述标等走 run_submit_agent 无 extra_tools
    分支的提交）；run_submit_agent 带 extra_tools 的分支与 content(正文, deepagent) 节点不经此路径，暂不记录。
    提交内容此前只活在内存、任何表都查不到，现按 role(列)/data(内容)/event_meta(元数据) 落库供排查。
    best-effort，绝不挡主流程。"""
    rec = getattr(ctx, "recorder", None)
    if rec is None:
        return
    meta: dict = {"tool": tool_name, "outcome": outcome}
    if reason is not None:
        meta["reason"] = str(reason)[:1000]
    try:
        await asyncio.to_thread(
            rec.log_event, ctx.run_id, ctx.agent_type, "submit",
            node=label, level=("warning" if role == "ai" and outcome != "ok" else "info"),
            role=role, data=(_clip(content) if content is not None else None),
            event_meta=meta, thread_id=getattr(ctx, "thread_id", None),
        )
    except Exception:  # noqa: BLE001 观测写入 best-effort，PG 断连等不影响提交主流程
        pass


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
        t0 = time.monotonic()
        turn = await run_turn(hooks, llm_with_tools, state, config)
        latency = int((time.monotonic() - t0) * 1000)
        # agent_node 走 get_chat(...).ainvoke 绕过 gateway.invoke，这里补记用量（否则 settle 汇总 0）。
        record_ctx_usage(ctx, turn.result, node="agent",
                         model=getattr(llm, "model_name", None), latency_ms=latency)
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
        await _forced_submit(ctx, prompt, user_msg, submit, tool_name, label=desc)
    result = get_result()
    if result is None:
        raise RuntimeError(f"模型未通过 {tool_name} 提交结构化结果")
    return result


def _reject_msg(msg, call_id: str, reason: str) -> list:
    """把一次被拒绝的提交（Pydantic 校验失败 / JSON 非法）追加进对话，供下一轮模型修正。"""
    return [msg, ToolMessage(content=reason, tool_call_id=call_id)]


async def _forced_submit(ctx, prompt: str, user_msg: str, submit, tool_name: str,
                         attempts: int = 3, label: str | None = None) -> None:
    """纯 submit 节点：tool_choice 锁定提交工具，模型无法只回文字（e2e 实测：自由发挥不调工具
    是真实高频失败模式）；Pydantic 校验失败、或大嵌套 JSON 写成非法语法（langchain 归入
    invalid_tool_calls，此前被当"没提交"直接放弃——是 bug）都把错误喂回，最多重试 attempts 轮。
    仅当模型这一轮真的完全没产出提交调用（tool_calls 与 invalid_tool_calls 均空）才 fail-closed 放弃。
    不走 build_create_agent：强制 tool_choice 下图循环永不停机（每轮都被迫调工具），单轮循环才可控。
    模型调用走 forced_stream_submit：流式 + 空闲超时降级重试（大标书单块慢生成不误杀，真挂死秒级降级）。"""
    if ctx.gateway is None:
        return                           # 无 gateway（异常装配）：交给上层抛"未提交"
    messages: list = [SystemMessage(content=prompt), HumanMessage(content=user_msg)]
    # 轮开始即记输入（role=human，content=system prompt + user_msg）——无论本轮成败，输入都留痕供排查/复现。
    await _log_submit(ctx, tool_name, label, "input", role="human",
                      content=f"{prompt}\n\n=== user ===\n{user_msg}")
    for _ in range(attempts):
        msg = await forced_stream_submit(ctx, messages, submit, tool_name, label)
        # 截断必须先于 tool_calls 判定：流式下 langchain 用 parse_partial_json 把被截断的 args
        # 补成"看似合法"的 dict → 截断输出也会落进 tool_calls。若先接受，要么校验失败空耗预算、
        # 要么静默把残缺结果当成功交付（大标书读标漏条款）。故 finish_reason=length 一律走压缩重试。
        finish = (getattr(msg, "response_metadata", None) or {}).get("finish_reason")
        if finish == "length":
            await _log_submit(ctx, tool_name, label, "truncated", role="ai",
                              reason="finish_reason=length，输出超长被截断")
            messages = [*messages, HumanMessage(content=(
                "你上一次的提交因输出超过长度上限被截断，未能送达。请大幅压缩后重新提交同一结构："
                "value 逐条精炼（≤50字）；source_quote 只保留★/▲/废标风险条目的关键句（≤40字），"
                "其余条目一律留空；不要遗漏条目本身。"))]
            continue
        call = next((c for c in (getattr(msg, "tool_calls", None) or []) if c["name"] == tool_name), None)
        if call is not None:
            try:
                await submit.ainvoke(call["args"])
                await _log_submit(ctx, tool_name, label, "ok", role="ai", content=call["args"])
                return                   # 校验通过，结果已被 make_submit_tool 捕获
            except Exception as e:  # noqa: BLE001 校验错误喂回模型修正
                await _log_submit(ctx, tool_name, label, "rejected", role="ai",
                                  content=call["args"], reason=e)
                reason = f"提交被拒绝：{e}。请修正字段后重新提交。"
                messages = [*messages, *_reject_msg(msg, call["id"], reason)]
                continue
        invalid = next((ic for ic in (getattr(msg, "invalid_tool_calls", None) or [])
                        if ic.get("name") == tool_name), None)
        if invalid is not None:
            await _log_submit(ctx, tool_name, label, "invalid_json", role="ai",
                              content=invalid.get("args"), reason=invalid.get("error"))
            reason = (f"submit 参数不是合法 JSON（{invalid.get('error')}）。"
                      "只输出一个合法 JSON 对象，一次性提交，不要多余包装键或注释。")
            messages = [*messages, *_reject_msg(msg, invalid.get("id") or "invalid", reason)]
            continue
        await _log_submit(ctx, tool_name, label, "no_submit", role="ai")
        return                           # 模型完全没产出提交调用（如 fake 模型）：交给上层抛"未提交"
