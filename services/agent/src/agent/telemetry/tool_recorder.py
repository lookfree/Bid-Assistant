"""工具调用埋点（LangChain 回调）→ agent.agent_tool_call。

该表自建成起全库 0 行：recorder.record_tool 写好了但没有任何调用点——deepagent 直驱的工具
（write_file/write_todos/task/read_file…）不经 make_agent_node，正文步跑一小时事后连"调过哪些
工具"都查不到（2026-08-01 空转事故的排查盲区之一）。挂到 config.callbacks 后逐次落行：
工具名/节点/耗时/成败/参数摘要。埋点 best-effort，任何失败都不影响工具执行。"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler

_SUMMARY_CHARS = 200   # 单个参数值的摘要上限：write_file 的 content 是整章 HTML，只记长度不进库


def _summarize(inputs: Any, input_str: str) -> dict[str, str]:
    """参数摘要：优先结构化 inputs（每个值截断，超长只记 "<N chars>"）；无结构化时截 input_str。"""
    out: dict[str, str] = {}
    if isinstance(inputs, dict) and inputs:
        for k, v in list(inputs.items())[:8]:
            s = str(v)
            out[str(k)] = s if len(s) <= _SUMMARY_CHARS else f"<{len(s)} chars>"
    elif input_str:
        s = str(input_str)
        out["input"] = s if len(s) <= _SUMMARY_CHARS else s[:_SUMMARY_CHARS] + "…"
    return out


class ToolCallRecorder(AsyncCallbackHandler):
    """每次工具调用（start→end/error 配对）落一行 agent_tool_call。按 langchain run_id 配对计时。"""

    def __init__(self, ctx: Any, node: str):
        self.ctx = ctx
        self.node = node
        self._starts: dict[Any, tuple[float, str, dict]] = {}   # lc run_id -> (t0, tool, summary)

    async def on_tool_start(self, serialized: Any, input_str: str, *,
                            run_id: Any = None, inputs: Any = None, **kwargs: Any) -> None:
        name = (serialized or {}).get("name") if isinstance(serialized, dict) else None
        self._starts[run_id] = (time.monotonic(), name or "unknown", _summarize(inputs, input_str))

    async def on_tool_end(self, output: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        await self._record(run_id, ok=True, error=None)

    async def on_tool_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        await self._record(run_id, ok=False, error=str(error)[:300])

    async def _record(self, run_id: Any, *, ok: bool, error: str | None) -> None:
        start = self._starts.pop(run_id, None)
        recorder = getattr(self.ctx, "recorder", None)
        if start is None or recorder is None or not getattr(self.ctx, "run_id", None):
            return
        t0, tool, summary = start
        try:
            await asyncio.to_thread(
                recorder.record_tool, self.ctx.run_id, getattr(self.ctx, "agent_type", "unknown"),
                tool, ok=ok, duration_s=round(time.monotonic() - t0, 3),
                args_summary=summary or None, error=error, node=self.node,
                thread_id=getattr(self.ctx, "thread_id", None))
        except Exception:  # noqa: BLE001 埋点 best-effort，绝不影响工具执行
            pass
