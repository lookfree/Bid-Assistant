from __future__ import annotations

import asyncio
import json
import time
from json_repair import repair_json
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
from agent.telemetry.tool_recorder import ToolCallRecorder

# 单条 submit 事件里存的提交内容上限（字符）：足够看清结构/定位坏字段，又不让单行 jsonb 失控膨胀。
_SUBMIT_LOG_MAX = 40_000


def _clip(v: Any) -> str:
    """把任意提交内容/输入规整成有界字符串（超限截断加省略号），防单行 jsonb 失控膨胀。"""
    text = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return text if len(text) <= _SUBMIT_LOG_MAX else text[:_SUBMIT_LOG_MAX] + f"…[截断，共{len(text)}字]"


def _repair_submit_args(raw: Any) -> dict | None:
    """容错修复模型产出的非法 JSON args（读标格式/红线轮高频失效：中文串值内嵌未转义的英文双引号，
    模型照抄招标原文短语如 "开标时间以前不得开封"，首个引号提前闭合字符串→整段 args 解析失败）。
    json_repair 重新转义/补全后返回 dict；修不动或结果非对象则 None（退回常规重试）。best-effort。"""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        obj = repair_json(raw, return_objects=True)
        return obj if isinstance(obj, dict) else None
    except Exception:  # noqa: BLE001 修复失败不能拖垮提交主流程
        return None


def _incomplete_args(msg: Any, tool_name: str) -> bool:
    """这次提交的 args 原文是不是**没写完**（模型输出被长度上限截断）。

    流式下 langchain 用 parse_partial_json 把没写完的 args 补成"看似合法"的 dict，
    于是截断的提交照样落进 msg.tool_calls，与正常提交长得一模一样。
    2026-08-11 生产实测（康恒环境审查报告）：一条发现的标题是
    「…项目名称与投标产品名称不一致（如合同写的是」——句子断在半截、括号没闭合，
    正是模型要写引号里的项目名时被截断、被补全器收了尾；截断点之后的发现整批丢失。
    唯一的挡板本是 finish_reason == "length"，但那要**服务商回**才有：本地复现三种收尾
    （length / tool_calls / 干脆不回）下 tool_calls 都被补成合法 dict，只有第一种拦得住。

    判据改成看 args 原文能不能 json.loads——聚合消息的 tool_call_chunks 里存的是逐片
    拼起来的**原文**，没写完就必然是非法 JSON，与服务商回不回 finish_reason 无关。

    **strict=False 不能少**：langchain 把 args 落进 tool_calls 用的是
    parse_partial_json(..., strict=False)，比它严就会把**写完的**提交判成截断。差集正是
    串值里的裸控制字符（裸换行、裸制表符）——模型写长中文字段时的高频形态，而后果是
    压缩重试三轮、整步失败、全额退款，用户什么都拿不到。检出力不受影响：真截断的三种形态
    （串/数组/对象未闭合）在 strict=False 下照样非法。判据必须与**落 tool_calls 的那个解析器**
    同口径，否则每换一家服务商就会冒出一种新的分歧形态。
    误伤担心两处，都不成立：
      · 中文串值里未转义的英文双引号（读标高频）——那种 parse_partial_json 直接抛，消息落进
        invalid_tool_calls、msg.tool_calls 为空，被下面第一行挡掉（仍由 _repair_submit_args 兜）；
      · 非流式 ainvoke（思考模型）——AIMessage 没有 tool_call_chunks，恒回 False，
        仍由 finish_reason 那条挡板负责。
    """
    if not any(c.get("name") == tool_name for c in (getattr(msg, "tool_calls", None) or [])):
        return False        # 压根没解析出提交调用（非法 JSON / 没提交）——那是别的分支的事
    for tc in getattr(msg, "tool_call_chunks", None) or []:
        if tc.get("name") not in (tool_name, None):
            continue
        raw = tc.get("args")
        if not isinstance(raw, str) or not raw.strip():
            continue        # 契约是 str | None；真遇到别的形状就当"判不了"，绝不因此毙掉一次提交
        try:
            json.loads(raw, strict=False)
        except (ValueError, TypeError):
            return True
    return False


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
        latency = round(time.monotonic() - t0, 3)
        # agent_node 走 get_chat(...).ainvoke 绕过 gateway.invoke，这里补记用量（否则 settle 汇总 0）。
        record_ctx_usage(ctx, turn.result, node="agent",
                         model=getattr(llm, "model_name", None), latency_s=latency)
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
                           tool_name: str, schema, desc: str, extra_tools: list | None = None,
                           attempts: int = 3, temperature: float | None = None):
    """跑一个「必须用 submit 工具提交 schema 结构化结果」的子 agent，返回校验后的实例。
    模型没提交（含提交但校验失败）就抛错 → run 落 failed 而非把空结果当成功；
    checkpoint 停在节点前，客户端重发 run 即重试本节点。工作流各 submit 节点共用。
    只有 submit 一个工具时走 tool_choice 强制路径（模型自由发挥不调工具是真实高频失败模式）。

    attempts：约束越多的 schema 越需要更多轮次收敛。一次耗尽等于白烧掉前几轮的 token 且整步失败
    退款、用户什么都拿不到——多给一两轮的成本远低于整轮报废（述标骨架实测 3 轮会翻车）。"""
    submit, get_result = make_submit_tool(tool_name, schema, desc)
    if extra_tools:
        sub = build_create_agent(prompt, [*extra_tools, submit], ctx)
        # 工具调用埋点：这条带工具的图路径此前没挂回调，agent_tool_call 全无记录——
        # 而它恰恰是出问题才会走到的兜底路径（预解析失败让模型自己调 parse_document），
        # 排查时最需要「调了哪个工具、参数是什么、报了什么错」，只能靠 token 表反推（2026-08-05）。
        await sub.ainvoke({"messages": [{"role": "user", "content": user_msg}]},
                          config={"callbacks": [ToolCallRecorder(ctx, desc)]})
    else:
        await _forced_submit(ctx, prompt, user_msg, submit, tool_name, label=desc,
                             attempts=attempts, temperature=temperature)
    result = get_result()
    if result is None:
        raise RuntimeError(f"模型未通过 {tool_name} 提交结构化结果")
    return result


# 提交被截断后喂回去的重试指令。**必须对所有 submit 节点都成立**：这条路以前只有服务商
# 明说 finish_reason=length 时才走得到（几乎只在读标那几轮），现在审查/提纲/述标一并会走到，
# 只讲读标字段的话，别的节点收到的是一段与自己无关的指令。读标专属的量化要求留在括注里。
_TRUNCATED_RETRY = (
    "你上一次的提交因输出超过长度上限被截断，未能送达。请大幅压缩后重新提交同一结构："
    "每条的文字逐条精炼、长引用只留关键句，但条目本身一条都不能少。"
    "（读标：value ≤50字；source_quote 只保留★/▲/废标风险条目的关键句、≤40字，其余条目留空。）")


def _reject_msg(msg, call_id: str, reason: str) -> list:
    """把一次被拒绝的提交（Pydantic 校验失败 / JSON 非法）追加进对话，供下一轮模型修正。"""
    return [msg, ToolMessage(content=reason, tool_call_id=call_id)]


async def _forced_submit(ctx, prompt: str, user_msg: str, submit, tool_name: str,
                         attempts: int = 3, label: str | None = None,
                         temperature: float | None = None) -> None:
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
        msg = await forced_stream_submit(ctx, messages, submit, tool_name, label,
                                         temperature=temperature)
        # 截断必须先于 tool_calls 判定：流式下 langchain 用 parse_partial_json 把被截断的 args
        # 补成"看似合法"的 dict → 截断输出也会落进 tool_calls。若先接受，要么校验失败空耗预算、
        # 要么静默把残缺结果当成功交付（大标书读标漏条款）。故 finish_reason=length 一律走压缩重试。
        finish = (getattr(msg, "response_metadata", None) or {}).get("finish_reason")
        if finish == "length" or _incomplete_args(msg, tool_name):
            await _log_submit(ctx, tool_name, label, "truncated", role="ai",
                              reason=("finish_reason=length，输出超长被截断" if finish == "length"
                                      else "提交的 JSON 没写完，输出被长度上限截断（服务商未回 finish_reason）"))
            messages = [*messages, HumanMessage(content=_TRUNCATED_RETRY)]
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
            raw = invalid.get("args")
            # 先容错修复再判失败：中文串值内未转义英文双引号是高频失效形态（读标格式/红线轮照抄原文短语），
            # 修得动就直接过——省一次昂贵重试，且通用"请输出合法 JSON"提示实测纠正不了这种错（连挂 3 轮）。
            repaired = _repair_submit_args(raw)
            if repaired is not None:
                try:
                    await submit.ainvoke(repaired)
                    await _log_submit(ctx, tool_name, label, "repaired", role="ai", content=repaired)
                    return                # 修复后校验通过，结果已被 make_submit_tool 捕获
                except Exception as e:  # noqa: BLE001 修复后仍不过 schema：退回常规重试喂回错误
                    await _log_submit(ctx, tool_name, label, "rejected", role="ai",
                                      content=repaired, reason=e)
                    messages = [*messages, *_reject_msg(msg, invalid.get("id") or "invalid",
                                f"提交被拒绝：{e}。请修正字段后重新提交。")]
                    continue
            await _log_submit(ctx, tool_name, label, "invalid_json", role="ai",
                              content=raw, reason=invalid.get("error"))
            reason = ('submit 参数不是合法 JSON（引用招标原文时，值内的英文双引号必须转义为 \\" 或改用中文引号「」）。'
                      "只输出一个合法 JSON 对象，一次性提交，不要多余包装键或注释。")
            messages = [*messages, *_reject_msg(msg, invalid.get("id") or "invalid", reason)]
            continue
        await _log_submit(ctx, tool_name, label, "no_submit", role="ai")
        return                           # 模型完全没产出提交调用（如 fake 模型）：交给上层抛"未提交"
