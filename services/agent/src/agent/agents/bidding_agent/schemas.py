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
    packages: list[str] = Field(default_factory=list)  # 包件归属（spec324 优化）：空=全包通用，["p1"]=仅包1


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
    packages: list[str] = Field(default_factory=list)  # 包件归属（spec324 优化）：空=全包通用，["p1"]=仅包1


class StructureItem(BaseModel):
    """投标文件构成清单条目（spec321）：机器可读的必备构成，供 outline/review 对齐用；与
    ReadCategory(key=format) 允许内容重叠——format 供人读，本结构供机器比对。"""
    id: str                                       # s1, s2...
    title: str                                    # 如「开标一览表」「技术偏离表」「资格证明文件（分册）」
    kind: Literal["volume", "chapter", "form", "rule"]  # 分册/章节/表单/程序性要求(份数密封签章)
    required: bool = True                         # 招标文件强制=true；可选项=false
    notes: str = ""                                # 份数/密封/签章/装订等操作说明（kind=rule 为主）
    clause_ids: list[str] = Field(default_factory=list)
    source_quote: str = ""
    packages: list[str] = Field(default_factory=list)  # 包件归属（spec324 优化）：空=全包通用，["p1"]=仅包1


class PackageInfo(BaseModel):
    """包件/标段信息（spec324）：多包件招标逐包抽取（id/名称/预算或限价/关键差异 notes）；
    单包标书留空，不臆造。"""
    id: str                                       # p1, p2...
    name: str
    budget: str = ""                               # 该包预算或最高限价
    notes: str = ""                                # 该包关键差异（范围/资质要求等，简要）
    clause_ids: list[str] = Field(default_factory=list)


class ReadResult(BaseModel):
    project_meta: dict = Field(default_factory=dict)        # name/code/buyer/budget/deadline...
    categories: list[ReadCategory]
    scoring: list[ScoringRow] = Field(default_factory=list)
    risk_summary: list[str] = Field(default_factory=list)   # 废标红线汇总
    required_structure: list[StructureItem] = Field(default_factory=list)  # 投标文件构成清单（spec321）
    packages: list[PackageInfo] = Field(default_factory=list)  # 包件划分（spec324），单包标书留空

    @model_validator(mode="after")
    def _dedup_categories(self) -> "ReadResult":
        """按 key 合并同类 categories（items 顺序拼接，保留首见 title）。key 是 Literal 但 list 不约束唯一，
        单轮读标直接用模型原始输出，模型可能把同一类拆成多个同 key 块。前端按 key 过滤渲染，重复 key 会让
        一次点击展示多类内容（对不上号）；下游提纲/正文/导出也按类迭代会重复处理。在数据模型层收敛
        「categories 按 key 唯一」这一不变量，所有消费方统一受益。"""
        merged: dict[str, ReadCategory] = {}
        for c in self.categories:
            if c.key in merged:
                merged[c.key].items.extend(c.items)
            else:
                merged[c.key] = c
        self.categories = list(merged.values())
        return self


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
    structure_ref: str | None = None              # 对应 required_structure 项 id（spec321，可空）


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
    enterprise_template_id: str | None = None      # 企业自有模板（如 pe1/pe2）标识元数据，优先于
    # template；渲染层不直接用它——节点按它解析出 MinIO key 后取 master_bytes 传给 render_pptx
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


class ChecklistGenGroup(BaseModel):
    """投递前审核表的一个分组。id 不由模型给（路由层按序归一化 A/B/C…，保证 key 干净唯一）。"""
    title: str                                     # 分组名，如「资格与资质」「实质性响应★项」
    items: list[str] = Field(min_length=1)         # 该组核对项文案，每条一句、可勾选


class ChecklistGen(BaseModel):
    """依据读标结论生成的定制审核表（spec333）。分组核对项，条目紧扣本招标文件的具体要求。
    groups min_length=1：模型整段放弃应触发校验失败强制重试，而非静默产空表（空表由 App 层回落默认 36）。"""
    groups: list[ChecklistGenGroup] = Field(min_length=1)
