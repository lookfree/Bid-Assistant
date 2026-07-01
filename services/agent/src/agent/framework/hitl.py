from __future__ import annotations

from enum import StrEnum
from typing import Any
from dataclasses import asdict, is_dataclass
from langgraph.types import interrupt


class ReviewType(StrEnum):
    """投标场景的人审类型（前端按此选渲染模板）。"""
    OUTLINE_CONFIRM = "outline_confirm"      # 读标→提纲后，确认大纲再写正文
    CHAPTER_REVIEW = "chapter_review"        # 关键章节回审
    GENERIC_CONFIRM = "generic_confirm"      # 通用确认


def human_review(review_type: ReviewType | str, details: Any, *, timeout_seconds: int | None = None,
                 default_action: str = "approve") -> dict:
    """在图节点内调用：interrupt 暂停 run、发 hitl.required 给前端、等 /resume 回灌。
    resume 协议：{"action":"approve"} | {"action":"modify","feedback":"...","data":{...}}。
    返回前端 resume 的 dict。"""
    payload = {
        "type": "hitl.required",
        "review_type": str(review_type),
        "details": asdict(details) if is_dataclass(details) else details,
        "timeout_seconds": timeout_seconds,
        "default_action": default_action,
    }
    return interrupt(payload)
