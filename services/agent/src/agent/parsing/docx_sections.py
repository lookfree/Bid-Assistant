"""从 .docx 抽章节结构：**优先用 Word 自己标的大纲层级**，其次才回退编号/短行启发式。

2026-08-10 生产实测根因：一份 9 万字的技术文件在 Word 里有清晰的多级标题（导航窗格能看到
`1.技术偏离表 / 1.1 总体技术规范偏离表 / 1.1.2 核心架构要求偏离表 / 2.项目概况`），我们却
**一条标题都没认出来**——旧判据只认「第N章」和「一、」两种写法，整本 9 万字聚成 1 节连续文本
喂给模型。后果是审查在文档里明明写着的内容上报「未响应」（用户实例：偏离表里的「身份集成」
「终端接入」）。取证已排除截断：关键词在文本里，预算砍到 40% 仍在。

判据顺序照抄作者的意图：
① 段落样式（Heading N / 标题 N / 基于它们的自定义样式）与 `w:outlineLvl` 是作者**自己标注**
   的层级，比任何正则都可靠；
② 整份文档一个大纲层级都没有时，才退回编号模式（`1.` / `1.1` / `一、` / `第X章`）的猜测；
   **加粗短行不作数**——仓库里 18 份真实标书实测，封面上「报 / 名 / 材 / 料」是四个各自成段的
   加粗大字、「日期：    年   月   日」也是加粗，认它们当标题只会凭空造出一堆一个字的节；
③ 表格里的段落一律不参与标题判定——偏离表首行「招标文件的要求」是表头不是章节，
   放行的话一张偏离表就能切出几十个假节。

节的口径与 parsers._split_clauses 保持一致：标题**另存 headings、不进 clauses**（进了就会挤掉
条款序号，clause_id 口径一变，前端定位与偏离表引用全线受影响）；一个标题都认不出来时整份
退化为 sec-1（今天的行为）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# 自定义样式常「基于」内置标题样式而自己不带层级信息，沿 basedOn 链上溯；
# 加深度上限纯粹是防坏文档里的环，正常样式表两三层就到顶。
_MAX_BASED_ON_DEPTH = 10

# 内置标题样式在 OOXML 里的名字恒为英文小写（`heading 1`），Word 只在界面上本地化；
# 「标题 1」这种写法出现在自定义样式里。两种都认。
_HEADING_STYLE_NAME = re.compile(r"^\s*(?:heading|标题)\s*([1-9])\s*$", re.I)

# 标题一般很短：长句即便以编号开头也是条款正文（启发式回退时用）。
_MAX_HEADING_CHARS = 40
# 「第X章/节/篇/部分」= 顶层；「一、」式中文编号 = 次级（与既有 _heading_level 口径一致）。
_CHAPTER = re.compile(r"^第\s*[一二三四五六七八九十百零〇\d]+\s*[章节篇部分]")
_CN_NUMBER = re.compile(r"^[一二三四五六七八九十]+\s*[、．.]")
# `1.` / `1.1` / `1.1.2` 式多级编号：层级 = 编号段数。分隔符后必须真有标题文字，
# 否则「100.00」这类金额也会被当成标题。
_DOTTED_NUMBER = re.compile(r"^(\d+(?:\.\d+)*)\s*[.、\s]\s*(.+)$")
_HAS_WORD = re.compile(r"[一-鿿A-Za-z]")
# 标题不会以句读收尾。实测真实标书里「1、提供投标须知规定的全部投标文件：正本1份，副本4份。」
# 这类编号**列表项**短得过得了长度门槛，不看收尾就会被当成章节。
_SENTENCE_END = "。；;，,、：:."


@dataclass(frozen=True)
class Block:
    """文档顺序上的一个正文块（段落或表格行）。

    level 是 Word 自己标的大纲层级（1..9），None = 正文；table 标记它来自表格
    （表格块永不参与标题判定）；synthetic 标记这块不是文档自己的内容，而是我们插进去的
    （内嵌图片的识别文字，见 parsers.splice_docx_images）——识别误差不该改写文档结构，
    故与表格行同待遇：永不成标题。"""

    text: str
    level: int | None = None
    table: bool = False
    synthetic: bool = False


def _outline_level(pPr) -> int | None:
    """`w:outlineLvl` → 1..9；val=9 是 Word 明确声明的「正文」，返回 None。"""
    from docx.oxml.ns import qn
    el = None if pPr is None else pPr.find(qn("w:outlineLvl"))
    if el is None:
        return None
    try:
        v = int(el.get(qn("w:val")))
    except (TypeError, ValueError):
        return None
    return v + 1 if 0 <= v <= 8 else None


def _level_from_name(name: str | None) -> int | None:
    m = _HEADING_STYLE_NAME.match(name or "")
    return int(m.group(1)) if m else None


def heading_style_levels(document) -> dict[str, int]:
    """styleId → 大纲层级。样式名（heading N / 标题 N）、样式自带的 `w:outlineLvl`、
    以及沿 basedOn 继承来的层级都算——真实标书里作者自建「正文标题一」这类样式极常见。"""
    from docx.oxml.ns import qn
    levels: dict[str, int] = {}
    based: dict[str, str] = {}
    for st in document.styles.element.findall(qn("w:style")):
        sid = st.get(qn("w:styleId"))
        if not sid:
            continue
        name = st.find(qn("w:name"))
        lvl = (_level_from_name(name.get(qn("w:val")) if name is not None else None)
               or _outline_level(st.find(qn("w:pPr"))))
        if lvl:
            levels[sid] = lvl
        parent = st.find(qn("w:basedOn"))
        if parent is not None and parent.get(qn("w:val")):
            based[sid] = parent.get(qn("w:val"))
    for sid in based:
        if sid not in levels:
            _inherit_level(sid, based, levels)
    return levels


def _inherit_level(sid: str, based: dict[str, str], levels: dict[str, int]) -> None:
    """沿 basedOn 链上溯，找到第一个带层级的祖先样式就继承它。"""
    cur, hops = based.get(sid), 0
    while cur and hops < _MAX_BASED_ON_DEPTH:
        if cur in levels:
            levels[sid] = levels[cur]
            return
        cur, hops = based.get(cur), hops + 1


def paragraph_level(p_el, style_levels: dict[str, int]) -> int | None:
    """这一段的大纲层级：段落上的直接格式优先于样式（作者就是在这一段上标的）。"""
    from docx.oxml.ns import qn
    pPr = p_el.find(qn("w:pPr"))
    if pPr is None:
        return None
    if pPr.find(qn("w:outlineLvl")) is not None:
        return _outline_level(pPr)
    style = pPr.find(qn("w:pStyle"))
    sid = style.get(qn("w:val")) if style is not None else None
    return style_levels.get(sid) if sid else None


def _fallback_level(b: Block) -> int | None:
    """作者没标够大纲层级时才走这里：短行 + 编号模式。表格行与插进来的识别文字一律不判。

    前两种编号（第X章 / 一、）是既有判据，**逐字节沿用**，免得今天切得出来的文档反而变少；
    阿拉伯编号是本次新增的，噪声也集中在它身上（列表项常常就是「1、xxx。」），故只对它
    加一道收尾守卫。"""
    t = b.text.strip()
    # 无字的块（如纯图片段）不是标题；synthetic 见 Block 的注释（识别文字永不成标题）
    if b.table or b.synthetic or not t or len(t) > _MAX_HEADING_CHARS:
        return None
    if _CHAPTER.match(t):
        return 1
    if _CN_NUMBER.match(t):
        return 2
    m = _DOTTED_NUMBER.match(t)
    if not m or not _HAS_WORD.search(m.group(2)) or t[-1] in _SENTENCE_END:
        return None
    return m.group(1).count(".") + 1


# 并小节的门槛。**只在启发式回退时生效**：Word 自己标的标题是作者的意图，再短也不并。
# 启发式则可能把成百上千条编号列表项当标题（「1.需求项」「2.需求项」…），那种碎法会让
# 审查按上千个「章」逐个体检，既慢又每章都看不到上下文。
_MIN_SECTION_CHARS = 200
# 节数没到这个量级就不并：小文档里的短节是真章节（「第一章 采购公告」下面就一句话），
# 并掉反而把结构丢了。只有节数已经多到不正常，才说明启发式猜错了。
_MERGE_SECTIONS_OVER = 100


def _group(blocks: list[Block], levels: list[int | None]) -> list[dict]:
    """按标题把块分组 → [{title, level, texts}]。标题前的正文自成第一组（无标题）。"""
    secs: list[dict] = [{"title": None, "level": 0, "texts": []}]
    for b, lv in zip(blocks, levels):
        if lv:
            secs.append({"title": b.text.strip(), "level": lv, "texts": []})
        else:
            # 条款文本去首尾空白：与既有 _split_clauses 同口径。前端把审查发现定位回原文时
            # 拿的就是这段文本去比对，留着首行缩进的全角空格会比对不上。
            secs[-1]["texts"].append(b.text.strip())
    if secs[0]["title"] is None and not secs[0]["texts"]:
        secs.pop(0)          # 文档以标题开头 → 首个标题即 sec-1（与既有口径一致）
    return secs


def _merge_tiny_sections(secs: list[dict]) -> list[dict]:
    """过小的节并入前一节；标题文字转成前一节的条款，一个字都不丢。
    空节（下面直接是子标题）不并——它本来就不产出章，留着标题还能给前端定位。"""
    if len(secs) <= _MERGE_SECTIONS_OVER:
        return secs
    out: list[dict] = []
    for s in secs:
        size = sum(len(t) for t in s["texts"])
        if out and 0 < size < _MIN_SECTION_CHARS:
            out[-1]["texts"].extend(([s["title"]] if s["title"] else []) + s["texts"])
            continue
        out.append(s)
    return out


def _emit(secs: list[dict]) -> tuple[list[dict], list[dict]]:
    """分组 → (clauses, headings)。节内非空块顺序编号成 `sec-N-cM`。"""
    clauses: list[dict] = []
    headings: list[dict] = []
    for i, s in enumerate(secs, 1):
        sec_id = f"sec-{i}"
        if s["title"]:
            headings.append({"sec": sec_id, "title": s["title"], "level": s["level"]})
        for n, text in enumerate(s["texts"], 1):
            clauses.append({"id": f"{sec_id}-c{n}", "text": text})
    return clauses, headings


# 「作者自己把结构标好了」的认定门槛。按**覆盖度**判而不是 any()：中文标书的封面常用内置
# 「标题 1」排一两行、正文章节却是手打的「第一章」，按 any() 判的话整本就为了那一行封面放弃
# 编号启发式——构造实证 11 节塌成 1 节，正是本次要治的故障形态换了扇门进来。
# 判据两条都要过：带层级的段落既要够多（一两条可能只是封面/页眉套了个样式），
# 也不能被启发式命中数压倒（差得太远说明作者只标了零头）。
_MIN_STYLED_HEADINGS = 3
# 4 倍是拿真实语料挑的：仓库 18 份标书里样式标题相对最少的两份（49 条样式 vs 114 条启发式、
# 29 vs 85）仍判为 styled——它们的启发式命中大半是目录行（「一、磋商响应函\t5」）与日期落款，
# 认了只会把目录切成几十个假节。倍数再小就会把这两份翻到并用模式上去。
_STYLED_OVER_HEURISTIC = 4


def split_docx_blocks(blocks: list[Block]) -> tuple[list[dict], list[dict]]:
    """docx 正文块 → ([{id, text}], [{sec, title, level}])。见模块头的判据顺序。
    覆盖度不够时两种信号并用：段落自己标了层级的照用，没标的才拿编号去猜。"""
    guesses = [_fallback_level(b) for b in blocks]
    n_styled = sum(1 for b in blocks if b.level)
    styled = (n_styled >= _MIN_STYLED_HEADINGS
              and n_styled * _STYLED_OVER_HEURISTIC >= sum(1 for g in guesses if g))
    levels = ([b.level for b in blocks] if styled
              else [b.level or g for b, g in zip(blocks, guesses)])
    secs = _group(blocks, levels)
    if not styled:
        secs = _merge_tiny_sections(secs)
    return _emit(secs)
