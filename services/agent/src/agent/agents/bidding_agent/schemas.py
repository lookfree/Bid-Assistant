from __future__ import annotations
import logging
import re
from typing import Literal
from pydantic import BaseModel, Field, model_validator

from agent.agents.bidding_agent.render.sanitize import clean_internal_ids, mentions_system_note

logger = logging.getLogger(__name__)

CategoryKey = Literal["overview", "qualification", "commercial", "technical", "scoring", "format"]


class ReadItem(BaseModel):
    title: str
    value: str
    clause_ids: list[str] = Field(default_factory=list)  # 条款 id（${secId}-cN，对齐原型 clauseIds），供前端定位
    source_quote: str = ""                        # 原文摘录，可选补充

    @model_validator(mode="after")
    def _no_internal_ids(self) -> "ReadItem":
        """条目标题/取值是读标页直接显示的文字，不该带内部条款 id
        （2026-08-08 全库实测 26 处：「报价含税，为完成本项目的所有费用，包干价（sec-16-c49）」）。
        clause_ids 字段本身保留——前端靠它点回原文定位；source_quote 是原文摘录，逐字不动。"""
        self.title = clean_internal_ids(self.title)
        self.value = clean_internal_ids(self.value)
        return self
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
    def _clean_ids(self) -> "ReadResult":
        """废标红线汇总是直接展示给用户的文字，不该带内部条款 id
        （2026-08-08 实测：「★条款不允许负偏离…（sec-33-c28, sec-75-c2）」）。
        categories/scoring 里的 clause_ids **字段本身要保留**——前端靠它点回原文定位，
        这里只清洗给人看的自然语言。"""
        self.risk_summary = [clean_internal_ids(x) for x in self.risk_summary]
        return self

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
# 字段说明写全的理由（2026-08-01 生产事故）：主模型换成客户本地的 Qwen3.6-35B-A3B-W4A8 后，
# 整份提纲只剩章节标题——模型把没标 required、没写 description 的 items **整个字段省略**，
# pydantic 默认值补成 [] 后校验照样通过（`outcome: ok`，无任何报错）。同期 deepseek 会照系统
# 提示词补全，于是问题被掩盖到换模型才暴露。**弱模型只认工具 schema**：提纲的层级/编号/id 用法
# 这些提示词里的硬要求必须同时写进字段说明，承载内容的字段必须 required。
_DESC_HAND_WRITTEN = "留空。该字段由用户在页面上手写，模型不要填写"
_CLAUSE_IDS_DESC = "招标依据条款 id，形如 sec-3-c2（第 N 章第 M 段）；对齐读标结论里的 clause_ids，没有直接依据给空数组"
_ID_DESC = "内部键，用「章id-序号」形如 t3-1。**只是键、绝不是编号**：不要写进 label，更不要出现在正文标题里"


class OutlineLeafItem(BaseModel):
    """五级（明细）：封顶层，无 children。"""
    id: str = Field(..., description=_ID_DESC)
    label: str = Field(..., description="五级明细标题，带本层编号前缀，如「① 值班安排」")
    # 用户在「添加/编辑标题」弹窗里手写的写作说明（这一节要写什么），随提纲保存并进入正文生成提示词。
    # **模型产提纲时必须留空**（提示词已明写）：写手把 desc 当作用户的明确要求、优先级高于自身判断，
    # 模型往里填等于把自己的话冒充成用户指令，用户还会在编辑弹窗里看到一段自己没写过的文字。
    desc: str = Field(default="", description=_DESC_HAND_WRITTEN)
    clause_ids: list[str] = Field(default_factory=list, description=_CLAUSE_IDS_DESC)
    is_new: bool = False


class OutlineGrandChildItem(BaseModel):
    """四级（细分）：如「（1）人员配置」。"""
    id: str = Field(..., description=_ID_DESC)
    label: str = Field(..., description="四级细分标题，带本层编号前缀，如「（1）人员配置」（右括号后不留空格）")
    desc: str = Field(default="", description=_DESC_HAND_WRITTEN)   # 见 OutlineLeafItem.desc
    clause_ids: list[str] = Field(default_factory=list, description=_CLAUSE_IDS_DESC)
    is_new: bool = False
    children: list[OutlineLeafItem] = Field(
        default_factory=list,
        description="本细分下的五级明细（「① xxx」）。仅特别复杂的技术方案局部才用，其余给空数组 []")


class OutlineChildItem(BaseModel):
    """三级（小节）：如「1. 项目背景分析」。"""
    id: str = Field(..., description=_ID_DESC)
    label: str = Field(..., description="三级小节标题，带本层编号前缀，如「1. 项目背景分析」（「1.」后留一个空格）")
    desc: str = Field(default="", description=_DESC_HAND_WRITTEN)   # 见 OutlineLeafItem.desc
    clause_ids: list[str] = Field(default_factory=list, description=_CLAUSE_IDS_DESC)
    is_new: bool = False
    children: list[OutlineGrandChildItem] = Field(
        default_factory=list,
        description="本小节下的四级细分（「（1）xxx」）。内容确需再拆时才给，否则空数组 []")


class OutlineItem(BaseModel):
    """二级（节）：如「一、项目理解」。"""
    id: str = Field(..., description=_ID_DESC)
    label: str = Field(..., description="二级节标题，带本层编号前缀，如「一、项目理解」（顿号后不留空格）")
    desc: str = Field(default="", description=_DESC_HAND_WRITTEN)   # 见 OutlineLeafItem.desc
    clause_ids: list[str] = Field(default_factory=list, description=_CLAUSE_IDS_DESC)
    is_new: bool = Field(default=False, description="招标文件无直接来源的加分/补强项=true")
    children: list[OutlineChildItem] = Field(
        default_factory=list,
        description="本节下的三级小节（「1. xxx」）。分值高、条款条目多的节应继续往下拆；程序性/表单类节给空数组 []")


class OutlineChapter(BaseModel):
    id: str                                       # t1..t5 / b1..b5
    no: str                                       # 第一章…
    title: str
    group: Literal["tech", "business"]
    sourced: bool = True                          # 能否在招标文件索引到来源
    desc: str = Field(default="", description=_DESC_HAND_WRITTEN)
    # required（不是 default_factory）：这是全章唯一承载内容的字段，可省略 = 整份提纲退化成一串标题。
    items: list[OutlineItem] = Field(
        ..., description="本章的二级节（「一、xxx」）**必填**：除纯表单/承诺函类占位章节外，每章通常 3 个左右；"
                         "确实无可拆分内容时给空数组 []，但**绝不可省略本字段**")
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
    # 标题与整改建议都**必填非空**：2026-08-06 用户截图里三张高风险卡片的标题断在
    # 「响应文件构成缺漏——缺少」，整改建议一片空白——这样的卡片对用户毫无价值。
    # 此前 advice 是可选带默认值（顾虑"漏填让整单被拒"多一种失败模式），代价是空建议直接发给
    # 付费用户。_forced_submit 会把校验错误喂回模型重试 3 轮，正是为这种漏填准备的。
    title: str = Field(
        ..., min_length=2,
        description=("风险点标题：一句话说清缺什么/哪里不符，必须写完整。"
                     "用业务语言，**不得出现 required_structure、clause_ids、sec-8-c95 这类内部字段名与编号**"))
    chapter_title: str = Field(default="", description="对应的标书章节标题，用于把问题落到具体章节")
    tender_ref: str = Field(
        default="",
        description=('对应的招标条款，写成"对应：第X章 xxx（★不可偏离）"。'
                     "**只写人看得懂的条款出处**：不要带 sec-8-c95 这类内部条款 id，"
                     "也不要出现 required_structure、clause_ids 这类字段名——用户看不懂，只会以为是乱码"))
    advice: str = Field(..., min_length=2,
                        description="整改建议**必填**：具体怎么改、补什么材料、放到哪一章，一句话讲清；不得留空")
    target_tab: Literal["tech", "business"]
    # 必须用**投标文件的章节 id**（如 t3/b4，见提纲 chapters[].id）。此前无描述，模型自造
    # s1/s2… 这类编号，前端匹配不上就静默回落第一章——用户点哪条都跳到第一章（2026-08-06 反馈）。
    target_id: str = Field(..., description="点击定位用的章节 id：必须取自提纲 chapters[].id（形如 t3、b4），不可自行编号")
    # 章内定位锚点。只到章还不够：实测一份报告 63 条里 31 条都指向同一章（偏离表），
    # 逐条点过去都落在章节顶部，用户看到的就是"点哪条都跳同一个地方"（2026-08-07 反馈）。
    # 必填但允许空串：缺失类问题未必有可引用的原文，强行编一段反而会定位到错的地方。
    anchor_text: str = Field(
        ...,
        description=(
            "章内定位锚点：从该章正文里**原样摘抄**一小段（10–30 字），用来把用户带到出问题的那一处。"
            "问题是'缺少某内容'时，摘抄应当补写位置的邻近原文（如所在表格的标题行）。"
            "必须是正文里真实出现的文字，不可改写、不可自己编；实在没有可摘的就给空字符串。"
        ),
    )
    # 【这里为什么没有条款 id 字段】审查载荷在喂给模型之前，clause_ids / evidence_clause_ids
    # 两个键已被整个剥掉（提纲、构成清单、读标三处，见 nodes/review 与 nodes/common.strip_clause_ids）。
    # 起因：模型把 sec-8-c95 这类内部编号抄进给评委看的结论，转头又被我们自己的过滤当成
    # "投标文件里的多余编号"报成一条风险（2026-08-11 生产实测）。模型手上既然没有 id 可引用，
    # 留一个 clause_ids 字段只有两种结局——恒为空（毫无用处），或者被逼着凭空编一个
    # （不展示、不清洗，却会落库，还让去重键假装更"唯一"、把去重放宽）。故整个摘掉。
    # 章节 id（target_id）不在此列：它是模型能看见、也必须填的定位键，前端靠它跳转。
    # 将来若要恢复条款级引用：**先给审查载荷带回一套模型看得见、能对上原文的定位口径**
    # （可引用的编号或摘录），再据此加字段——而不是先加一个模型填不出来的字段。

    @model_validator(mode="after")
    def _strip_blank(self):
        """全空白等同于没填：min_length 挡不住 "   "。顺带抹掉泄露的内部标识。"""
        if not self.title.strip() or not self.advice.strip():
            raise ValueError("风险项的标题与整改建议都不能为空白")
        self.title = clean_internal_ids(self.title)
        self.advice = clean_internal_ids(self.advice)
        self.tender_ref = clean_internal_ids(self.tender_ref)
        self.chapter_title = clean_internal_ids(self.chapter_title)
        return self


class RiskReport(BaseModel):
    score: int = Field(ge=0, le=100)              # 体检分 0–100
    high: int = 0                                 # 高风险数（按 items 推导，见下）
    mid: int = 0                                  # 中风险数（同上）
    passed: int = 0                               # 通过项数（= len(passed_items)）
    # 这两个字段是审查步的**全部产出**，缺一个就等于交付垃圾——而且是最危险的那种垃圾：
    # 漏填后默认值补成 []，前端显示"0 项风险"，看起来像"这份标书没问题"而不像失败，
    # 用户会带着一份没体检过的标书去投。故必填（空数组仍合法：真干净的标书就是没有发现），
    # 与提纲 items 同一范式（2026-08-01：Qwen3.6-35B 把可选且无描述的字段整个省略）。
    items: list[RiskFinding] = Field(
        ..., description="查出的风险项**必填**：确实没查出问题时给空数组 []，但绝不可省略本字段")
    passed_items: list[str] = Field(
        ..., description="通过项（已满足的要求）**必填**：一条一句话；确实没有时给空数组 []，但绝不可省略本字段")

    @model_validator(mode="after")
    def _derive_counts(self):
        """去重后再计数。计数一律从 items/passed_items 推导，不信模型口头报数（两处口径必然漂移）。
        去重：用户截图里同一条发现重复出现三张一模一样的卡片——重复是噪音，且会把风险数虚报高。"""
        # 通过项与风险项一样是给用户看的整句（2026-08-08 实测 12 处：
        # 「响应函已提供，含90天有效期承诺…（sec-8-c10）」）。风险项在 RiskFinding 里已清，
        # 这个平级列表当时漏了。
        # 通过项同样可能是在说我们自己的注记（「文档整洁、无 sec-xxx 一类的残留标记」）——
        # 判据与风险项共用，同样只认注记前缀与编号占位符，不认真条款 id。
        self.passed_items = [c for c in (clean_internal_ids(p) for p in self.passed_items)
                             if c and not mentions_system_note(c)]
        seen: set[tuple[str, str, str, str]] = set()
        uniq = []
        for i in self.items:
            # 标题清洗前非空、清洗后变空——说明整个标题就是个内部 id/字段名（如「sec-8-c95」），
            # 不是真发现。min_length 挡的是清洗前的原值，挡不住这种；丢弃这一条，不拖累整份报告。
            if not i.title.strip():
                logger.warning("risk finding dropped: title became empty after id cleanup (advice=%r)",
                               i.advice[:40])
                continue
            # 这条发现说的是**我们自己**加进送审材料里的东西（系统注记、编号占位符），不是用户
            # 文件里的内容。2026-08-11 生产实测：「投标文件多处出现章节编号(如 sec-xxx)和内嵌图片
            # 标记，未作清理，影响文件整洁性和专业性」——用户的 .docx 里一个都没有。留着就是拿
            # 我们自己的实现细节去冤枉用户，还顺带把它泄露出去。提示词里已明令（见
            # prompts/review._SYSTEM_NOTE_RULE），但那只是"请模型配合"，这里是确定性的那一半。
            # 只问 title/advice（这条发现在说什么），不问 tender_ref/chapter_title（出处与章节名，
            # 里面出现编号是模型照提示词办事）；判据本身也只认占位符、不认真 id，见 mentions_system_note。
            if mentions_system_note(i.title, i.advice):
                logger.warning("risk finding dropped: 该发现指向系统注记/编号占位符而非投标文件内容 (title=%r)",
                               i.title[:60])
                continue
            # 位置不同的两条发现，标题/建议文字可能撞车（同类问题分别命中多处）——去重键要能
            # 分得开，否则会把它们错误地塌缩成一条，漏报剩下的那些位置。
            # 能分辨它们的**只有位置**：审查载荷里没有任何内部条款 id（见 RiskFinding 上的说明），
            # 发现本身也就不带条款 id；同一条问题落在不同章、或同章内不同处，就是不同的发现。
            key = (i.title.strip(), i.advice.strip(), i.target_id.strip(), i.anchor_text.strip())
            if key in seen:
                continue
            seen.add(key)
            uniq.append(i)
        self.items = uniq
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


    @model_validator(mode="after")
    def _no_internal_ids(self):
        """抹掉内部条款 id：2026-08-08 线上实测述标页写着「所有★关键条款（sec-54-c1、sec-58-c1）
        均完全满足」——那是要投到评委面前的 PPT。喂给模型的读标结论里带 clause_ids，模型顺手抄了。"""
        self.title = clean_internal_ids(self.title)
        self.scoring = clean_internal_ids(self.scoring)
        self.bullets = [clean_internal_ids(b) for b in self.bullets]
        self.notes = clean_internal_ids(self.notes)
        return self

class QA(BaseModel):
    q: str
    a: str


class DeckSpec(BaseModel):
    title: str = ""                                # 述标主题（项目名）
    duration: Literal[10, 15, 20] = 15             # 讲标时长档（分钟）
    template: Literal["blue", "tech", "gov"] = "blue"  # 对齐前端 StyleId（商务提案/技术方案/党政庄重）
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
    stats: list[StatItem] = Field(
        default_factory=list,
        description="comparison 版式右栏的数字卡片，1–2 张：value 是展示用短文本（如「7×24」「较限价低 8%」），"
                    "label 是对该数字的一句话说明；其余版式给空数组 []")
    chart: SlideChart | None = None

    # 顺序要紧：pydantic 的 after 校验器按定义顺序跑，layout 必须先按数据纠正，
    # 否则模型漏给 layout 的图表页会在下面被误判成「缺少 bullets」而遭拒。
    @model_validator(mode="after")
    def _derive_layout(self):
        derive_layout(self)
        return self

    @model_validator(mode="after")
    def _content_needs_substance(self):
        """content 页必须有实质内容；**修得动的机械修，修不动的才拒**。
        2026-08-01 生产实测：Qwen 选了 comparison 版式却不给 stats，纠错反馈喂回三轮原样重交，
        5 次耗尽整步报废退款——用户什么都拿不到。「宣称对比页但没有对比数据」的可靠证据就是
        bullets 页，降级即合格品（与 derive_layout「数据才是意图的可靠证据」同一哲学，方向相反）：
        - 版式宣称与数据不符：chart 无 chart 数据 / comparison 无 stats → 有要点就降级 bullets；
          stats 超 2 张 → 截前 2 张。均 warn 留痕。
        - 真空页（连一条非空要点都没有）→ 仍拒：不拦就等于交付垃圾——bullets 原是「可选带默认
          空列表」时，模型只给标题静默通过，14 页全空 PPT 照扣 80 积分（实测在前）。
        cover/section/end 不要求（section 是过渡页，标题即内容）。校验失败仍触发强制提交重试。"""
        if self.kind != "content":
            return self
        has_bullets = bool([b for b in self.bullets if b.strip()])
        if self.layout == "chart" and self.chart is None:
            if not has_bullets:
                raise ValueError(f"「{self.title}」选了 chart 版式却没给 chart 数据，也没有要点可降级")
            logger.warning("slide %r: chart layout without chart data, downgraded to bullets", self.title)
            self.layout = "bullets"
        elif self.layout == "comparison":
            if not has_bullets:
                raise ValueError(f"「{self.title}」选了 comparison 版式，左栏 bullets 不能为空")
            if not self.stats:
                logger.warning("slide %r: comparison layout without stats, downgraded to bullets", self.title)
                self.layout = "bullets"
            elif len(self.stats) > 2:
                logger.warning("slide %r: %d stats trimmed to 2", self.title, len(self.stats))
                self.stats = self.stats[:2]
        elif self.layout == "bullets" and not has_bullets:
            raise ValueError(f"content 页「{self.title}」缺少 bullets：每页必须给 3–5 条要点")
        return self


class DeckDraft(BaseModel):
    """述标骨架：DeckSpec 去掉每页 notes，两段式第一段提交对象。"""
    title: str = Field(default="", description="述标主题，一般用项目名（会原样印在封面页上）")
    duration: Literal[10, 15, 20] = 15
    template: Literal["blue", "tech", "gov"] = "blue"
    enterprise_template_id: str | None = None
    slides: list[SlideDraft]
    # 必填（空数组仍合法）：问答是述标的组成部分，漏填后默认值补成 [] 就静默少了一个环节，
    # 与 bullets 同一类根因（有默认值的字段模型会跳过）。空数组保留给确实不需要问答的短 deck。
    qa: list[QA] = Field(
        ..., description="评委可能追问的问题与回答**必填**：一般 4–6 组，围绕★项与报价、工期、售后；"
                         "确实不需要时给空数组 []，但绝不可省略本字段")

    @model_validator(mode="after")
    def _structure_is_sound(self):
        # 凑数分隔页机械修复而非拒（2026-08-01：Qwen 第 5 次提交把「总结与致谢」做成尾部空分隔页
        # 被拒,恰好耗尽重试整步报废）——丢分隔页本身,正文一张不动,必然产出合格结构。
        self.slides = _drop_padding_sections(self.slides)
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


def _drop_padding_sections(slides: list) -> list:
    """分隔页后不足 2 张 content 页 = 拿分隔页凑数（生产实测：14 页里 5 页纯标题分隔页，
    评委翻两页就撞一张大蓝页）。此前整单拒——2026-08-01 实测 Qwen 恰在最后一轮踩这条规则，
    重试耗尽整步报废退款。凑数分隔页可机械修复：丢分隔页本身，正文一张不动。warn 留痕。"""
    out = []
    for i, sl in enumerate(slides):
        if sl.kind == "section":
            following = 0
            for nxt in slides[i + 1:]:
                if nxt.kind != "content":
                    break
                following += 1
            if following < 2:
                logger.warning("deck: padding section %r dropped (%d content slides after)",
                               sl.title, following)
                continue
        out.append(sl)
    return out


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


# 标书分类（spec334）：货物 / 服务 / 工程。**刻意不是 ReadResult 的字段**——它是读标收尾另一次
# 独立调用的产物，挂进 ReadResult 就等于混进 submit_read_result 的工具 schema，重蹈「大 schema 里
# 的字段被小模型静默跳过」的覆辙。落地方式沿用 doc_sections 的成例：并进 read result 的 dict。
BidCategoryValue = Literal["goods", "services", "engineering"]


class BidCategory(BaseModel):
    """分类判定结果。value 是 1–2 个值的**有序**数组，首元素为主类别；判据不足给空数组，不猜。

    **四个字段一律必填（没有默认值）**——全带默认值时 `submit_bid_category({})` 也能通过校验，
    模型调了工具却什么都没填，产出与「判据不足」逐字节相同，整个功能静默失效而没有任何报错
    （生产首次运行即中招）。必填不妨碍表达「判不出来」：键必须在，值仍可以是空数组，
    「没回答」与「回答：判不出来」这才分得开。"""
    value: list[BidCategoryValue] = Field(
        ...,
        description="货物 goods / 服务 services / 工程 engineering。横跨两类时给 2 个、主类别在前；判据不足给空数组，不要猜")
    confidence: Literal["high", "medium", "low"] = Field(
        ..., description="判据充分且唯一 high；能判但材料单薄或存在混合 medium；勉强或判不出 low")
    reason: str = Field(
        ..., description="一句话判据（≤50字），写给用户看，让他一眼判断该不该改判；判不出时写明为什么判不出")
    evidence_clause_ids: list[str] = Field(
        ..., description="支撑判定的条款 id，只能填用户消息里出现过的，最多 5 个；没有可引用的就给空数组")

    @model_validator(mode="after")
    def _normalize(self) -> "BidCategory":
        """去重保序、截到 2 个。模型偶尔会把三类全列上或重复同一类——这里收敛成不变量，
        免得下游「首元素为主类别、最多两类」的约定要在每个消费点各防一次。"""
        seen: list[str] = []
        for v in self.value:
            if v not in seen:
                seen.append(v)
        self.value = seen[:2]  # type: ignore[assignment]
        return self
