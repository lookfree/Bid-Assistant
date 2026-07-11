from __future__ import annotations
import re

from agent.parsing.types import ParsedDoc

_SEC_ID = re.compile(r"^sec-(\d+)(-c\d+)$")


def merge_parsed(docs: list[tuple[str, ParsedDoc]]) -> tuple[list[dict], list[dict]]:
    """合并多份已解析招标文件的 clauses（spec320）：按文件顺序拼接，文件 j≥2 的
    `sec-{N}-c{M}` 章节号 N 整体偏移前面所有文件的最大章节号累计和——条款 id 格式不变，
    单文件调用即恒等变换。返回 (clauses, file_ranges)，file_ranges 记录每个文件占用的章节区间，
    供 read 节点拼 prompt 文件清单。"""
    clauses: list[dict] = []
    file_ranges: list[dict] = []
    offset = 0
    for name, doc in docs:
        max_sec = 0
        for c in doc.clauses:
            m = _SEC_ID.match(c["id"])
            if not m:
                clauses.append(c)
                continue
            sec_n = int(m.group(1))
            max_sec = max(max_sec, sec_n)
            clauses.append({**c, "id": f"sec-{sec_n + offset}{m.group(2)}"})
        file_ranges.append({"name": name, "sec_from": offset + 1, "sec_to": offset + max_sec})
        offset += max_sec
    return clauses, file_ranges
