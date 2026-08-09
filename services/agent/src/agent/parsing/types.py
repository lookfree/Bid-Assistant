from __future__ import annotations
from dataclasses import dataclass, field


class UnsupportedDocument(Exception):
    pass


@dataclass
class ParsedDoc:
    text: str
    kind: str                                  # docx/pdf/xlsx
    pages: int | None = None
    # 提不出可见文字的页数（扫描图片页）。PDF 才有意义，其余格式恒为 0。
    # 2026-08-09 生产实测：366 页的投标文件有 139 页是扫描件（身份证、授权书、盖章报价表），
    # 这些页的内容对模型完全不可见；审查据此把「文本里找不到」诚实报成「无法核验」，
    # 而不是断言「缺少」——那一批假阳性高风险的根因就在这里。
    image_pages: int = 0
    # 逐页文本（PDF 才有，其余格式为空）。text 是它按页拼起来的结果，之所以另存一份：
    # 扫描页 OCR 要知道**哪一页**看不见、并把识别文字插回**那一页原来的位置**（见 parsing/ocr.py）。
    page_texts: list[str] = field(default_factory=list)
    tables: list[list[list[str]]] = field(default_factory=list)
    clauses: list[dict] = field(default_factory=list)  # [{id: "${secId}-cN", text}] 稳定条款 id，供读标/提纲定位
    # 章节标题 [{sec: "sec-N", title, level}]：与 clauses **并列**而不混入其中——标题一旦成为条款就会
    # 挤掉条款序号，既改了 clause_id 口径（定位/引用全线受影响），也让模型把标题当条款读。
    # level：1=第N章/节/篇/部分，2=「一、」式顶层编号。仅供左栏按层级渲染，读标提示词不消费。
    headings: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
