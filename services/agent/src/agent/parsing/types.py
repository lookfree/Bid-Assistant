from __future__ import annotations
from dataclasses import dataclass, field


class UnsupportedDocument(Exception):
    pass


@dataclass
class ParsedDoc:
    text: str
    kind: str                                  # docx/pdf/xlsx
    pages: int | None = None
    tables: list[list[list[str]]] = field(default_factory=list)
    clauses: list[dict] = field(default_factory=list)  # [{id: "${secId}-cN", text}] 稳定条款 id，供读标/提纲定位
    # 章节标题 [{sec: "sec-N", title, level}]：与 clauses **并列**而不混入其中——标题一旦成为条款就会
    # 挤掉条款序号，既改了 clause_id 口径（定位/引用全线受影响），也让模型把标题当条款读。
    # level：1=第N章/节/篇/部分，2=「一、」式顶层编号。仅供左栏按层级渲染，读标提示词不消费。
    headings: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
