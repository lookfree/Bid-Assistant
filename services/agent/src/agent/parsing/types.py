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
    meta: dict = field(default_factory=dict)
