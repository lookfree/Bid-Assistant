from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field

CategoryKey = Literal["overview", "qualification", "commercial", "technical", "scoring", "format"]


class ReadItem(BaseModel):
    title: str
    value: str
    clause_ids: list[str] = Field(default_factory=list)  # 条款 id（${secId}-cN，对齐原型 clauseIds），供前端定位
    source_quote: str = ""                        # 原文摘录，可选补充
    status: Literal["found", "missing"] = "found"  # 文件未明确 -> missing
    risk: bool = False                             # 废标风险点
    star: bool = False                             # ★不可偏离


class ReadCategory(BaseModel):
    key: CategoryKey
    title: str
    items: list[ReadItem] = Field(default_factory=list)


class ScoringRow(BaseModel):
    id: str                                        # 评分点 id（对齐原型 ScoringRow.id）
    category: str                                  # 技术方案/商务条款/投标报价
    name: str
    score: float
    star: bool = False
    desc: str = ""
    clause_ids: list[str] = Field(default_factory=list)  # 条款 id（对齐原型 clauseIds）
    chapter_id: str = ""                           # 评分点 → 标书章节映射（对齐原型 chapterId）


class ReadResult(BaseModel):
    project_meta: dict = Field(default_factory=dict)        # name/code/buyer/budget/deadline...
    categories: list[ReadCategory]
    scoring: list[ScoringRow] = Field(default_factory=list)
    risk_summary: list[str] = Field(default_factory=list)   # 废标红线汇总
