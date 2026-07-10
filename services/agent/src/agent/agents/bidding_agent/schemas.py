from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field, model_validator

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
    level: Literal["高风险", "中风险"]              # 前端按此渲染，收紧取值
    tone: Literal["destructive", "warning"]
    title: str
    chapter_title: str = ""                       # 对应标书章节标题
    tender_ref: str = ""                          # 对应招标条款（"对应：第X章…★…"）
    advice: str = ""                              # 整改建议
    target_tab: Literal["tech", "business"]
    target_id: str                                # 章节 id（点击定位）


class RiskReport(BaseModel):
    score: int = Field(ge=0, le=100)              # 体检分 0–100
    high: int = 0                                 # 高风险数（按 items 推导，见下）
    mid: int = 0                                  # 中风险数（同上）
    passed: int = 0                               # 通过项数（= len(passed_items)）
    items: list[RiskFinding] = Field(default_factory=list)
    passed_items: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _derive_counts(self):
        """计数一律从 items/passed_items 推导，不信模型口头报数（两处口径必然漂移）。"""
        self.high = sum(1 for i in self.items if i.level == "高风险")
        self.mid = sum(1 for i in self.items if i.level == "中风险")
        self.passed = len(self.passed_items)
        return self


class Slide(BaseModel):
    id: str
    title: str
    scoring: str = ""                              # 本页对应评分点（可空）
    bullets: list[str] = Field(default_factory=list)
    notes: str = ""                                # 口播稿/讲稿
    kind: Literal["cover", "content", "end"] = "content"


class QA(BaseModel):
    q: str
    a: str


class DeckSpec(BaseModel):
    title: str = ""                                # 述标主题（项目名）
    duration: Literal[10, 15, 20] = 15             # 讲标时长档（分钟）
    template: Literal["blue", "tech", "gov"] = "blue"  # 对齐原型 StyleId（商务蓝/科技感/政务红）
    enterprise_template_id: str | None = None      # 企业自有模板（如 pe1/pe2），优先于 template
    slides: list[Slide]
    qa: list[QA] = Field(default_factory=list)


class SlideDraft(BaseModel):
    """述标骨架页：Slide 去掉 notes（最大最易崩的自由文本字段），两段式第一段产出（spec205.1 Fix2）。"""
    id: str
    title: str
    scoring: str = ""
    bullets: list[str] = Field(default_factory=list)
    kind: Literal["cover", "content", "end"] = "content"


class DeckDraft(BaseModel):
    """述标骨架：DeckSpec 去掉每页 notes，两段式第一段提交对象。"""
    title: str = ""
    duration: Literal[10, 15, 20] = 15
    template: Literal["blue", "tech", "gov"] = "blue"
    enterprise_template_id: str | None = None
    slides: list[SlideDraft]
    qa: list[QA] = Field(default_factory=list)


class SlideNote(BaseModel):
    id: str                                        # 对应 SlideDraft.id
    notes: str


class SlideNotes(BaseModel):
    """两段式第二段提交对象：逐页口播稿，按 id 与骨架合并。
    notes 必填且 min_length=1：模型整段放弃（提交 {} 缺字段，或 {"notes": []} 空列表）都应触发
    校验失败 → 强制提交重试，而非静默通过让全 deck notes 置空（缺个别页由合并处兜底空串，整段缺失属高危失败）。"""
    notes: list[SlideNote] = Field(min_length=1)
