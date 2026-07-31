from __future__ import annotations
import re
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


# 提纲层级（投标文件通行写法，最多五级）：
#   一级 章    第一章 投标函
#   二级 节    一、项目理解
#   三级 小节  1. 项目背景分析
#   四级 细分  （1）人员配置
#   五级 明细  ① 值班安排        ← 仅特别复杂的技术标局部使用
# **逐级显式建模、不用自引用**（评审修正）：自引用 schema 经 langchain 转 LLM tool schema 时
# 递归 $ref 被抹平成空对象，模型对下级结构零引导、易产垃圾 children 烧尽 submit 重试；
# 显式到第五级同时把「五级封顶」变成 schema 硬约束——更深的数据在校验时被静默剪掉，下游天然安全。
class OutlineLeafItem(BaseModel):
    """五级（明细）：封顶层，无 children。"""
    id: str
    label: str                                    # 如 "① 值班安排"
    # 用户在「添加标题」弹窗里填的写作说明（这一节要写什么），随提纲保存并进入正文生成提示词。
    # 模型自己产提纲时不必填；它主要承载**人的意图**，是用户唯一能指导某一节怎么写的地方。
    desc: str = ""
    clause_ids: list[str] = Field(default_factory=list)
    is_new: bool = False


class OutlineGrandChildItem(BaseModel):
    """四级（细分）：如「（1）人员配置」。"""
    id: str
    label: str
    desc: str = ""   # 用户填写的该节写作说明（见 OutlineLeafItem.desc）
    clause_ids: list[str] = Field(default_factory=list)
    is_new: bool = False
    children: list[OutlineLeafItem] = Field(default_factory=list)


class OutlineChildItem(BaseModel):
    """三级（小节）：如「1. 项目背景分析」。"""
    id: str
    label: str
    desc: str = ""   # 用户填写的该节写作说明（见 OutlineLeafItem.desc）
    clause_ids: list[str] = Field(default_factory=list)
    is_new: bool = False
    children: list[OutlineGrandChildItem] = Field(default_factory=list)


class OutlineItem(BaseModel):
    """二级（节）：如「一、项目理解」。"""
    id: str
    label: str
    desc: str = ""   # 用户填写的该节写作说明（见 OutlineLeafItem.desc）
    clause_ids: list[str] = Field(default_factory=list)  # 招标依据条款 id（${secId}-cN，对齐原型 clauseIds）
    is_new: bool = False                          # 提纲新增（招标无直接来源）
    children: list[OutlineChildItem] = Field(default_factory=list)


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


# 类别名尾部的单位标注，如「质保期(月)」「合同额（万元）」；半角/全角括号都认。
_UNIT_RE = re.compile(r"[（(]([^（()）]*)[)）]\s*$")


class ChartSeries(BaseModel):
    name: str
    values: list[float]


class SlideChart(BaseModel):
    """述标图表页数据（layout=chart 专用）：团队构成/历史业绩规模/报价构成/实施进度这类
    "跨类别可比数字"，交给 python-pptx 渲染成真实可编辑的 PowerPoint 图表对象（不是图片）。"""
    type: Literal["column", "bar", "pie", "line"] = "column"
    categories: list[str]
    series: list[ChartSeries]

    def declared_units(self) -> set[str]:
        """类别名里显式标注的单位集合（未标注的类别不计入）。"""
        return {m.group(1).strip() for c in self.categories
                if (m := _UNIT_RE.search(c)) and m.group(1).strip()}

    def degenerate_reason(self) -> str | None:
        """这张图是否「画出来没信息」：单类别，或所有系列内部数值都一样（几根等高的柱子）。
        **只作判据不在此处抛错**——SlideChart 被 Slide/DeckSpec 共用，在这里拦会让库里已有的
        退化图表再也导不出来（混合单位那条就是这么踩的，实测 /render/deck 500）。
        多系列时只要有一个系列内部有差异就算合格（招标要求 vs 我方承诺可能某几项持平）。"""
        if len(self.categories) < 2:
            return "只有一个类别，没有可比性——改用数字卡片（comparison 版式）"
        if all(len(set(sr.values)) <= 1 for sr in self.series):
            return ("每个系列的数值都一样，没有可比性——几根等高的柱子传达不了任何信息。"
                    "换一个真有差异的维度（金额/周期/数量占比），或改用要点/数字卡片")
        return None

    @model_validator(mode="after")
    def _shape_consistent(self):
        if not self.categories:
            raise ValueError("图表 categories 不能为空")
        if not self.series:
            raise ValueError("图表 series 不能为空")
        if self.type == "pie" and len(self.series) != 1:
            raise ValueError("饼图（pie）只能有一个 series，多个系列请用 column/bar")
        for s in self.series:
            if len(s.values) != len(self.categories):
                raise ValueError(
                    f"series「{s.name}」的 values 长度({len(s.values)}) 与 categories 长度"
                    f"({len(self.categories)}) 不一致"
                )
        return self


class StatItem(BaseModel):
    """关键数字卡片（layout=comparison 专用）：value 是展示用短文本（可带单位/符号，不要求纯数字，
    如"7×24""较限价低 8%""12 年"），label 是对该数字的一句话说明。
    两者都不许为空：空卡片在 PPT 上就是一个没内容的方框，且渲染层历史上会因此崩过
    （空串产生不出 run）——与 App PATCH 的 slideSchema 同集。"""
    value: str = Field(min_length=1)
    label: str = Field(min_length=1)


def derive_layout(slide) -> None:
    """按模型实际给出的数据纠正 layout（就地改 slide）。
    生产事故（2026-07-30 step 41a13d7f）：模型给足了 chart 数据与 stats 卡片却没给 layout 键 →
    默认值 "bullets" → 渲染层按 layout 分派，图表与数字卡片被静默丢弃，用户拿到"一个图表都没有"
    的 PPT，而数据其实好好存在库里。与 bullets 同一类根因（有默认值的字段模型会跳过），但这里
    不能靠改必填解决——layout 漏填就整单拒会凭空多一种失败模式。数据本身才是可靠的意图证据：
    带了 chart 就是图表页，带了 stats + 左栏要点就是对比页。
    只在 layout 仍是默认值时纠正，模型显式选了版式一律尊重；非 content 页不动（封面/分隔页
    不该因为带了残留数据变成图表页）。放在 Slide 上，存量 deck 重新导出即自愈。"""
    if slide.kind != "content" or slide.layout != "bullets":
        return
    if slide.chart is not None:
        slide.layout = "chart"
    elif slide.stats and any(b.strip() for b in slide.bullets):
        # comparison 左栏要点必填：没要点就别升级成对比页，留在 bullets 让空内容校验照常拦下
        slide.layout = "comparison"


class Slide(BaseModel):
    id: str
    title: str
    scoring: str = ""                              # 本页对应评分点（可空）
    bullets: list[str] = Field(default_factory=list)
    notes: str = ""                                # 口播稿/讲稿
    kind: Literal["cover", "section", "content", "end"] = "content"
    # 述标结构性升级（三种 content 版式，见 prompts/present.py 的选择准则）：
    # bullets（默认，程序性说明）/ chart（跨类别可比数字，真实图表对象）/
    # comparison（招标要求 vs 承诺、传统方案 vs 本方案，左栏要点+右栏数字大卡片）。
    layout: Literal["bullets", "chart", "comparison"] = "bullets"
    stats: list[StatItem] = Field(default_factory=list)   # comparison 版式的右栏数字卡片
    chart: SlideChart | None = None                        # chart 版式的图表数据

    @model_validator(mode="after")
    def _derive_layout(self):
        derive_layout(self)
        return self


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
    # bullets 必填、scoring 带 description：模型读工具 schema 比读提示词认真得多。
    # 生产事故（run 61e62f63）：这两个字段原是「可选且无描述」，模型连续 3 次提交的 14 页 deck 里
    # 两个键各出现 0 次，只给标题 —— 而同期 stats/chart（有嵌套 docstring + 提示词 JSON 示例）每页都给。
    # 其它节点承载内容的字段（ReadItem.title/value、RiskFinding.title/level）本就都是必填，从没这毛病。
    # bullets 本就被下方 _content_needs_substance 强制非空，改必填只是让模型看见这条既有要求，
    # 不新增失败模式；scoring 无校验器强制，故仍留默认值，只补描述（改必填会把漏填升级成整单被拒）。
    scoring: str = Field(default="", description="本页对应的评分点（含★项优先标出）；section/cover/end 页给空串")
    bullets: list[str] = Field(
        description="本页要点，每条一句话讲清一个具体做法/参数/指标。"
                    "content 页必填 3–5 条（chart 版式可只给 1–2 条结论式说明）；"
                    "cover/section/end 页给空数组 []")
    kind: Literal["cover", "section", "content", "end"] = "content"
    layout: Literal["bullets", "chart", "comparison"] = Field(
        default="bullets",
        description="本页版式：bullets=纯要点；chart=图表页（同时给 chart 字段）；"
                    "comparison=左要点右数字卡片（同时给 stats 字段）。给了 chart/stats 就要选对应版式")
    stats: list[StatItem] = Field(default_factory=list)
    chart: SlideChart | None = None

    # 顺序要紧：pydantic 的 after 校验器按定义顺序跑，layout 必须先按数据纠正，
    # 否则模型漏给 layout 的图表页会在下面被误判成「缺少 bullets」而遭拒。
    @model_validator(mode="after")
    def _derive_layout(self):
        derive_layout(self)
        return self

    @model_validator(mode="after")
    def _content_needs_substance(self):
        """content 页必须有实质内容——不同版式的「实质内容」形状不同,只判断「有没有」，
        「对不对」交给各自的 model_validator（SlideChart 已校验 categories/series 一致性）：
        - bullets（默认）：至少 1 条非空要点；
        - chart：必须给 chart 数据；
        - comparison：左栏 bullets + 右栏 1-2 张 stats 缺一不可。
        cover/section/end 不要求（section 是过渡页，标题即内容）。
        生产实测教训：bullets 原是「可选带默认空列表」，模型只给标题就静默通过——
        14 页全空，用户拿到一份只有标题的 PPT，80 积分照扣。校验失败会触发强制提交重试，
        与 SlideNotes.notes 的 min_length=1 同一范式。"""
        if self.kind != "content":
            return self
        has_bullets = bool([b for b in self.bullets if b.strip()])
        if self.layout == "chart":
            if self.chart is None:
                raise ValueError(f"「{self.title}」选了 chart 版式却没给 chart 数据")
        elif self.layout == "comparison":
            if not has_bullets:
                raise ValueError(f"「{self.title}」选了 comparison 版式，左栏 bullets 不能为空")
            if not (1 <= len(self.stats) <= 2):
                raise ValueError(
                    f"「{self.title}」选了 comparison 版式，右栏 stats 需要 1-2 项，实际 {len(self.stats)} 项"
                )
        elif not has_bullets:
            raise ValueError(f"content 页「{self.title}」缺少 bullets：每页必须给 3–5 条要点")
        return self


class DeckDraft(BaseModel):
    """述标骨架：DeckSpec 去掉每页 notes，两段式第一段提交对象。"""
    title: str = ""
    duration: Literal[10, 15, 20] = 15
    template: Literal["blue", "tech", "gov"] = "blue"
    enterprise_template_id: str | None = None
    slides: list[SlideDraft]
    qa: list[QA] = Field(default_factory=list)

    @model_validator(mode="after")
    def _structure_is_sound(self):
        _sections_have_content(self.slides)
        _charts_use_one_unit(self.slides)
        _charts_are_comparable(self.slides)
        _layouts_are_varied(self.slides)
        # 页数上限只写在提示词里，不做硬校验：多两页属于「不够好」而非「不能用」，
        # 而每多一条硬约束就多一种「三轮收敛不了 → 整步失败退款、用户什么都拿不到」的失败模式。
        # 判据：只有「不拦就等于交付垃圾」的才配当校验器（缺 bullets、图表数据被丢弃属于此类）。
        return self


def _charts_use_one_unit(slides: list) -> None:
    """同一张图的类别单位必须一致。生产实测：响应时限(h)=1、质保期(月)=36 画在同一根轴上，
    36 的柱子把 1 小时那根压成看不见的线，评委实际只看得到一项，另外三项白画。
    **只在生成阶段判**：这条曾放在 SlideChart 上，而 SlideChart 被 Slide 共用 → DeckSpec 一起收紧
    → 库里已有的混单位图表再也导不出来（2026-07-31 实测 /render/deck 500）。新规则只拦新产出的坏图。"""
    for sl in slides:
        units = sl.chart.declared_units() if sl.chart is not None else set()
        if len(units) > 1:
            raise ValueError(
                f"「{sl.title}」的图表类别单位不一致（{'、'.join(sorted(units))}）：量纲不同画在一根轴上，"
                "大数会把小数压成看不见的线。请拆成两张图，或改用 comparison 版式的数字卡片")


def _layouts_are_varied(slides: list) -> None:
    """长 deck 不能通篇一个版式。生产实测（DeepSeek v4，2026-07-31）：14 页正文里 13 页纯要点、
    一张图表都没有——内容量够了但评委翻到后面全是项目符号列表。
    提示词早写了「同一版式连续超 3 页视为偷懒」，没有执行等于没写。
    按正文页数成比例要求：6 页起至少 1 页非要点，12 页起至少 2 页。模型把最该画图的那页
    改成 chart 即可满足，代价极小；短 deck 不强求（3–5 页本来就没必要凑版式）。"""
    content = [s for s in slides if s.kind == "content"]
    if len(content) < 6:
        return
    need = 2 if len(content) >= 12 else 1
    varied = sum(1 for s in content if s.layout != "bullets")
    if varied < need:
        raise ValueError(
            f"{len(content)} 页正文里只有 {varied} 页用了非要点版式，至少要 {need} 页："
            "凡是团队构成、历史业绩、报价构成、实施进度这类可比数字，用 chart；"
            "招标要求 vs 我方承诺这类对照，用 comparison。通篇要点评委翻到后面就麻木了")


def _charts_are_comparable(slides: list) -> None:
    """生产实测（DeepSeek v4 pro）：为满足「必须有非要点版式」硬凑出四项值全为 1 的柱状图——
    加约束就得同时堵住敷衍满足它的走法，否则约束本身制造了新的垃圾产出。只在生成阶段拦。"""
    for sl in slides:
        why = sl.chart.degenerate_reason() if sl.chart is not None else None
        if why:
            raise ValueError(f"「{sl.title}」的图表{why}")


def _sections_have_content(slides: list) -> None:
    """每张 section 后面必须跟至少 2 张 content 页。
    生产实测：14 页里 5 页是纯标题分隔页、内容页只有 7 张，评委翻两页就撞见一张大蓝页。
    提示词早写了页数区间，模型照做了总页数却拿分隔页凑数——页数约束管不住结构，得单独判。"""
    for i, sl in enumerate(slides):
        if sl.kind != "section":
            continue
        following = 0
        for nxt in slides[i + 1:]:
            if nxt.kind != "content":
                break
            following += 1
        if following < 2:
            raise ValueError(
                f"分隔页「{sl.title}」后面只有 {following} 张正文页，至少 2 张——"
                "分隔页不承载内容，不能拿它凑页数；请合并章节或给这一章补足正文页")


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
