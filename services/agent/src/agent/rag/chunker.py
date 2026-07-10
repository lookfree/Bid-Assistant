"""spec316 A1: 按段落切块——纯函数，无副作用。

语义：先按段落（空行/换行）拆分，贪心把整段落合并进当前块（不超过 MAX_CHARS，
不从段落中间断开，除非单段落本身超长才硬切）；再给相邻块之间补 OVERLAP 字符的
重叠前缀，方便向量检索时不因块边界丢上下文。因此最终块长度上限是
MAX_CHARS + OVERLAP（首块没有重叠前缀，恰好 <= MAX_CHARS）。
"""
from __future__ import annotations

import re

MAX_CHARS = 500
OVERLAP = 50


def chunk(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    segments = _raw_segments(paragraphs)
    return _apply_overlap(segments)


def _raw_segments(paragraphs: list[str]) -> list[str]:
    """贪心合并段落到 <=MAX_CHARS 的块；单段落超长时硬切成若干 <=MAX_CHARS 的片段。"""
    segments: list[str] = []
    current = ""
    for para in paragraphs:
        pieces = _split_long(para)
        for piece in pieces:
            candidate = f"{current}\n{piece}" if current else piece
            if len(candidate) <= MAX_CHARS:
                current = candidate
            else:
                if current:
                    segments.append(current)
                current = piece
    if current:
        segments.append(current)
    return segments


def _split_long(para: str) -> list[str]:
    if len(para) <= MAX_CHARS:
        return [para]
    return [para[i:i + MAX_CHARS] for i in range(0, len(para), MAX_CHARS)]


def _apply_overlap(segments: list[str]) -> list[str]:
    """从第二块起，前缀补上前一块末尾 OVERLAP 个字符。"""
    if len(segments) <= 1:
        return list(segments)
    result = [segments[0]]
    for i in range(1, len(segments)):
        tail = segments[i - 1][-OVERLAP:]
        result.append(tail + segments[i])
    return result
