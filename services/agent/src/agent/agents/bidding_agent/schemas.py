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


class OutlineItem(BaseModel):
    id: str
    label: str                                    # 如 "1.1 项目背景与需求理解"
    clause_ids: list[str] = Field(default_factory=list)  # 招标依据条款 id（${secId}-cN，对齐原型 clauseIds）
    is_new: bool = False                          # 提纲新增（招标无直接来源）


class OutlineChapter(BaseModel):
    id: str                                       # t1..t5 / b1..b5
    no: str                                       # 第一章…
    title: str
    group: Literal["tech", "business"]
    sourced: bool = True                          # 能否在招标文件索引到来源
    items: list[OutlineItem] = Field(default_factory=list)


class Outline(BaseModel):
    chapters: list[OutlineChapter]

    @property
    def tech(self) -> list[OutlineChapter]:
        return [c for c in self.chapters if c.group == "tech"]

    @property
    def business(self) -> list[OutlineChapter]:
        return [c for c in self.chapters if c.group == "business"]


class RiskFinding(BaseModel):
    level: str                                    # 高风险 / 中风险
    tone: Literal["destructive", "warning"]
    title: str
    chapter_title: str = ""                       # 对应标书章节标题
    tender_ref: str = ""                          # 对应招标条款（"对应：第X章…★…"）
    advice: str = ""                              # 整改建议
    target_tab: Literal["tech", "business"]
    target_id: str                                # 章节 id（点击定位）


class RiskReport(BaseModel):
    score: int                                    # 体检分 0–100
    high: int = 0                                 # 高风险数
    mid: int = 0                                  # 中风险数
    passed: int = 0                               # 通过项数
    items: list[RiskFinding] = Field(default_factory=list)
    passed_items: list[str] = Field(default_factory=list)
