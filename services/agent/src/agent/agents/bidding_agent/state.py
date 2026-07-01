from __future__ import annotations
from typing import Annotated, Any, TypedDict
from langgraph.graph.message import add_messages


class BiddingState(TypedDict, total=False):
    """投标工作流贯穿状态：一本标书一个 thread_id，靠 checkpointer 续（§4.7）。
    Phase 1 只用到 messages / file_key / read；Phase 2 续加 outline / chapters / risk / deck。"""
    messages: Annotated[list, add_messages]
    file_key: str            # 招标文件 MinIO key
    read: dict[str, Any]      # ReadResult.model_dump()（read 节点产出）
    # —— Phase 2 增（占位，勿删注释，标明生长点）——
    # outline: dict[str, Any]   # Outline.model_dump()
    # chapters: dict[str, str]  # {chapter_id: body_html}
    # risk: dict[str, Any]      # RiskReport.model_dump()
    # deck: dict[str, Any]      # DeckSpec.model_dump()
