from __future__ import annotations
from typing import Annotated, Any, TypedDict


def _merge_dict(a: dict | None, b: dict | None) -> dict:
    return {**(a or {}), **(b or {})}


class BiddingState(TypedDict, total=False):
    """投标工作流贯穿状态：一本标书一个 thread_id，靠 checkpointer 续（§4.7）。
    各节点在自己的 create_agent 子图内持有消息，父图只透传结构化产物，故无 messages 通道。"""
    file_key: str                  # 招标文件 MinIO key
    read: dict[str, Any]           # ReadResult.model_dump()      ← read（spec107）
    outline: dict[str, Any]        # Outline.model_dump()         ← outline（spec202）
    chapters: dict[str, str]       # {chapter_id: body_html}      ← content（spec203）
    risk: dict[str, Any]           # RiskReport.model_dump()      ← review（spec204）
    deck: dict[str, Any]           # DeckSpec.model_dump()        ← present（spec205）
    # {"docx": key, "pptx": key} ← export/present（spec205/206）；合并 reducer 让二者并存
    artifacts: Annotated[dict[str, str], _merge_dict]
