from __future__ import annotations
import re

from agent.parsing.types import ParsedDoc

_SEC_ID = re.compile(r"^sec-(\d+)(-c\d+)$")
_SEC_ONLY = re.compile(r"^sec-(\d+)$")


def merge_parsed(docs: list[tuple[str, ParsedDoc]]) -> tuple[list[dict], list[dict], list[dict]]:
    """合并多份已解析招标文件的 clauses（spec320）：按文件顺序拼接，文件 j≥2 的
    `sec-{N}-c{M}` 章节号 N 整体偏移前面所有文件的最大章节号累计和——条款 id 格式不变，
    单文件调用即恒等变换。返回 (clauses, file_ranges, headings)：file_ranges 记录每个文件占用的
    章节区间供 read 节点拼 prompt 文件清单；**headings 用同一套偏移重排**——不重排的话，第 2 份起的
    标题会挂到前一份的节上，左栏标题与其下正文对不上号，而这种错看着只像「标题写错了」，很难查。

    偏移量取 **clauses 与 headings 两边节号的最大值**：切分给「只有标题、没有正文」的节
    照样编号（末尾一个「附件清单」标题后面直接结束，docx 认出大纲层级之后这是常态），
    只看 clauses 的话那种尾节整个被忽略，下一份文件的首节撞上同一个节号——偏离表「出处」列
    印的是另一份文件的标题（_clause_source 取第一个匹配的 heading），file_ranges 也划错。"""
    clauses: list[dict] = []
    file_ranges: list[dict] = []
    headings: list[dict] = []
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
        for h in doc.headings:
            m = _SEC_ONLY.match(h.get("sec", ""))
            if m:
                max_sec = max(max_sec, int(m.group(1)))
            headings.append({**h, "sec": f"sec-{int(m.group(1)) + offset}"} if m else h)
        file_ranges.append({"name": name, "sec_from": offset + 1, "sec_to": offset + max_sec})
        offset += max_sec
    return clauses, file_ranges, headings
