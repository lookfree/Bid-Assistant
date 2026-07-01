from __future__ import annotations

from langchain_core.messages import ToolMessage


def _fmt(exc: Exception) -> str:
    return f"工具执行失败: {type(exc).__name__}: {exc}"


def resilient_tool_node(tools: list):
    """工具节点：逐个执行最后一条 AIMessage 的 tool_calls，异常转 status=error 的 ToolMessage
    （不让异常炸图）。支持 config.configurable.allowed_tools / disallowed_tools 工具门（None=全允许）。
    自己执行工具而非用 langgraph ToolNode——ToolNode 需在图运行时注入 runtime，无法脱离图单测。"""
    by_name = {getattr(t, "name", ""): t for t in tools}

    async def _invoke(state, config=None):
        conf = (config or {}).get("configurable", {}) if config else {}
        allowed = conf.get("allowed_tools")
        disallowed = set(conf.get("disallowed_tools") or [])
        allow = (set(by_name) if allowed is None else set(allowed)) - disallowed

        msgs = state.get("messages") or []
        calls = list(getattr(msgs[-1], "tool_calls", []) or []) if msgs else []
        out = []
        for c in calls:
            name = c.get("name")
            cid = c.get("id") or ""
            if name not in allow:
                out.append(ToolMessage(content=_fmt(PermissionError(f"tool '{name}' not allowed")),
                                       tool_call_id=cid, name=name or "", status="error"))
                continue
            tool = by_name.get(name)
            if tool is None:
                out.append(ToolMessage(content=_fmt(KeyError(f"unknown tool '{name}'")),
                                       tool_call_id=cid, name=name or "", status="error"))
                continue
            try:
                result = await tool.ainvoke(c.get("args") or {})
                out.append(ToolMessage(content=str(result), tool_call_id=cid, name=name))
            except Exception as e:  # noqa: BLE001 工具失败不炸图，转 error ToolMessage
                out.append(ToolMessage(content=_fmt(e), tool_call_id=cid, name=name or "", status="error"))
        return {"messages": out}

    return _invoke
