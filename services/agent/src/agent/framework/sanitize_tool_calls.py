"""喂模型前把历史里被拼坏的工具调用参数无害化（deepagents 路线的 DropMalformedToolCallsHook）。

2026-08-08 生产事故链：正文某一轮 write_todos 的参数 JSON 被拼坏（malformed）→ 带着坏参数的
消息被 checkpointer 存进历史 → 之后每次调用把历史原样发回端点，vLLM 渲染对话模板时要
json.loads 历史里每条工具调用的 arguments，在坏参数的固定字符位炸出
`400 "Expecting ',' delimiter"` —— 流式非流式都一样，因为病根已经在库里。

create_agent 那条路早有同款防护（framework/hooks.py 的 DropMalformedToolCallsHook），
读标/审查从来不怕这个；正文走 deepagents，没挂 hook，就中招了。

做法是**替换成空对象而不是删消息**：把坏的 arguments 换成 "{}"，保住它与后面
ToolMessage（"could not be executed"）的配对——端点能正常渲染，模型看到的是
"我调了 write_todos、参数错了被拒"，于是重发一次正确的调用。删整条消息反而会留下
孤儿 ToolMessage，端点同样拒收。**只改喂出去的请求，不动检查点里的历史**（审计要看原样）。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ModelRequest

logger = logging.getLogger(__name__)

_EMPTY = "{}"


def _fixed_raw_calls(raw_calls: list) -> tuple[list, bool]:
    """openai 原始形态（additional_kwargs.tool_calls）：arguments 必须是合法 JSON 字符串。"""
    out, changed = [], False
    for tc in raw_calls:
        fn = (tc or {}).get("function") or {}
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                json.loads(args)
            except Exception:  # noqa: BLE001 任何解析失败都视为坏参数
                tc = {**tc, "function": {**fn, "arguments": _EMPTY}}
                changed = True
        out.append(tc)
    return out, changed


def sanitize_messages(messages: list) -> list:
    """返回一份"发出去安全"的消息列表；没有坏参数时原样返回（零拷贝）。"""
    out, changed_any = [], False
    for m in messages:
        raw = (getattr(m, "additional_kwargs", None) or {}).get("tool_calls")
        invalid = getattr(m, "invalid_tool_calls", None) or []
        fixed_raw, raw_changed = _fixed_raw_calls(raw) if raw else (raw, False)
        if not raw_changed and not invalid:
            out.append(m)
            continue
        changed_any = True
        update: dict[str, Any] = {}
        if raw_changed:
            update["additional_kwargs"] = {**m.additional_kwargs, "tool_calls": fixed_raw}
        if invalid:
            # langchain 把解析失败的调用放进 invalid_tool_calls，序列化时 args **原串**照发——
            # 一并转成参数为空的正常调用，坏串绝不能出网。
            update["invalid_tool_calls"] = []
            update["tool_calls"] = list(getattr(m, "tool_calls", None) or []) + [
                {"name": c.get("name") or "unknown_tool", "args": {}, "id": c.get("id"),
                 "type": "tool_call"} for c in invalid]
        out.append(m.model_copy(update=update))
        logger.warning("已无害化一条坏工具调用参数（发送前替换为空对象），tool=%s",
                       [((c.get("function") or {}).get("name")) for c in (raw or [])] or
                       [c.get("name") for c in invalid])
    return out if changed_any else messages


class SanitizeToolCallsMiddleware(AgentMiddleware):
    """deepagents/langchain agents 的 middleware 形态：每次调模型前清洗 request.messages。"""

    async def awrap_model_call(self, request: ModelRequest, handler):
        clean = sanitize_messages(list(request.messages))
        if clean is not request.messages:
            request = request.override(messages=clean)
        return await handler(request)
