from __future__ import annotations

from typing import Any
from langchain_core.messages import SystemMessage


def _size(messages: list) -> int:
    return sum(len(str(getattr(m, "content", "") or "")) for m in messages)


def make_compressor_node(gateway: Any, *, max_tokens: int = 60_000, keep_recent: int = 6):
    """超阈值时：保留最近 keep_recent 条，把更早的摘要成一条 SystemMessage 放最前。
    Phase 1 用字符数近似 token（阈值名 max_tokens 与调用方 spec203 对齐）；后续可换真实 tokenizer。"""
    async def _node(state: dict) -> dict:
        msgs = list(state.get("messages") or [])
        if _size(msgs) <= max_tokens or len(msgs) <= keep_recent:
            return {}
        head, recent = msgs[:-keep_recent], msgs[-keep_recent:]
        summary = gateway.invoke(
            [SystemMessage(content="把以下对话压成要点摘要，保留关键事实/决定："), *head]
        )
        compacted = [SystemMessage(content=f"[历史摘要] {summary.content}"), *recent]
        return {"messages": compacted}
    return _node
