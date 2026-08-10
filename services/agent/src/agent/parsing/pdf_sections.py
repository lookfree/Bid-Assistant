"""从 .pdf 抽章节结构：**优先用 PDF 自己带的书签树与排版字号**，最后才回退编号启发式。

2026-08-11 生产实测根因：一份 366 页 / 12.9 万字 / 4947 条条款的商务技术标，只切出 **4 节 5 个
标题**，其中两条还是承诺函正文被编号骗进来的（「五、保证不将上述任何相关内容泄露给第三方」
「六、以上如有违反…」）；另一份 8 页的经济标切出 1 节。整本无结构大坨文本喂给模型，
模型在里面找不到具体条款——与 docx 那半边（见 parsing/docx_sections.py）是同一类故障。

PDF 没有 Word 的大纲层级，但它有自己的信号，判据按可靠性分层：

① **书签树（outline）**：作者导出 PDF 时留下的目录树，等价于 docx 的大纲层级，最可靠；
② **字号/字重**：标题在版面上显著大于正文（中文标书惯例：三号黑体章标题、四号节标题、
   小四正文）。这是把「承诺函第五条」与「真章节」分开的**唯一**可靠信号——两者都是
   `五、xxx` 的短行，字面上分不出来，字号上一眼就分得出来；
③ **编号启发式**：前两条都没有（一号字通篇、无书签）时才用，并按 docx 那边的同一套
   正则收紧（金额/日期不成标题、句读收尾的列表项不成标题），碎节再按同一套门槛合并。

**页眉页脚不参与标题判定**：每页重复的那行（项目名/公司名）在正文里出现几百次，
放它进标题判定就是几百个假节。判据是「同一行文字出现在足够多的页上」，而**版面上显著
大于正文的行豁免**——有些排版把当前章名印在页眉里，那一族文档的真章标题会跟着躺枪。

节的口径与 parsers._split_clauses / docx_sections 完全一致：标题另存 headings、不进 clauses；
一个标题都认不出来时整份退化为 sec-1（今天的行为）。分组/合并/编号三步直接复用 docx 那边
**同一份实现**（下面的私有导入），免得两条链路的 sec-id 口径各走各的。
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

# 复用 docx 那边**同一份**实现，不另起炉灶：
# · Block/_group/_merge_tiny_sections/_emit = 「块 → 节 → clauses/headings」的口径与 sec-id 生成，
#   两条链路必须逐字节一致，否则前端定位、偏离表出处、merge_parsed 的节号重排会按格式分叉；
# · 编号正则 = 中文标书编号写法的同一份领域知识（含金额/日期/列表项那几道实测出来的守卫），
#   各写一份必然漂移。
from agent.parsing.docx_sections import (
    _CHAPTER, _CN_NUMBER, _DOTTED_NUMBER, _HAS_WORD, _MAX_HEADING_CHARS, _SENTENCE_END,
    Block, _emit, _group, _merge_tiny_sections,
)


@dataclass(frozen=True)
class PdfLine:
    """PDF 里的一行文本（= extract_text 输出按 \\n 切出来的一行）。

    page/index 是它在「第几页的第几行」——OCR 把扫描页的识别文字拼回来之后要按这个坐标
    还原标题判定（见 resplit_marked），而识别文字本身一个字都不参与判定。
    size = 这一行最大的有效字号（0 = 取不到）；bold = 整行都是粗体/黑体字；
    outline = 书签树给这一行的层级（None = 书签里没有这条）。"""

    text: str
    page: int
    index: int
    size: float = 0.0
    bold: bool = False
    outline: int | None = None


# 书签树最深认到第几级（再深的层级前端左栏也排不下，统一收口）。
_MAX_OUTLINE_DEPTH = 6
# 字号「显著大于正文」的倍数。1.12：中文标书正文小四(12)/五号(10.5)，节标题四号(14)、
# 章标题三号(16)以上，都远在线外；而同一段里偶尔大半号的强调字（12 → 12.5）不算标题。
_PROMINENT_RATIO = 1.12
# 认定「这份 PDF 的版面确实用字号分了层」所需的最少标题数。太少就是噪声，不足以当信号。
_MIN_HEADINGS = 3
# 视觉标题占全文行数的上限：超过这个比例说明判据没判出层次（整篇都是「大字」），信号作废。
_MAX_HEADING_SHARE = 0.2
# 整行粗体的行占比上限：超过它说明这份文档正文本来就是粗的，字重不再有区分度。
_MAX_BOLD_SHARE = 0.3
# 页眉页脚判定：同一行文字出现在这么多页上就算版式重复行（两条取大的那个）。
_BOILERPLATE_MIN_PAGES = 4
_BOILERPLATE_PAGE_SHARE = 0.05
# 判定「已有信号切得够细」的两道线：标题之间最长的一段普通行，既不能超过全文的一半
# （docx 同款覆盖度判据），也不能超过这个绝对行数——366 页只切 4 节时覆盖度是过得了的，
# 而那正是本次要治的故障。200 行 ≈ 5000 字，是下游一章还读得动的上限。
_MAX_UNCOVERED_SHARE = 0.5
_MAX_GAP_LINES = 200

# 通篇只有数字与日期/金额/页码符号的行不是标题（「2026年8月1日」「￥1,234.00元」「共366页」）。
# 中文数字一并列入：「二〇二六年八月」这类落款同理。
_NUMERIC_ONLY = re.compile(
    r"^[\s\d,，.。、:：;；~～\-—/()（）%¥￥$第共页元角分年月日号"
    r"零〇一二三四五六七八九十百千万亿]+$")
# 目录行不是标题：它与真标题字面一模一样，放行就是开头几十个假节（还都排在正文之前）。
# 两种排法都认：点线牵引「第一章 投标邀请……5」；以及只用空格拉开的「第一章 投标邀请    5」。
_TOC_LEADER = re.compile(r"[.．·…]{4,}|[.．·…\s]{3,}\d{1,4}$")
# 粗体/黑体字的 BaseFont 名。中文标题惯用黑体（SimHei/STHeiti/黑体），它在字体名里不带 Bold。
_BOLD_FONT = re.compile(r"bold|black|heavy|semib|hei\b|heiti|simhei|黑体", re.I)


def _norm(text: str) -> str:
    """行文字的比对口径：去掉全部空白。PDF 抽出来的同一行在不同页/不同来源上空格数常不同。"""
    return "".join(text.split())


def _yscale(matrix) -> float:
    """变换矩阵 [a,b,c,d,e,f] 的纵向缩放 = hypot(b, d)。取不到就当 1（不缩放）。"""
    try:
        return math.hypot(float(matrix[1]), float(matrix[3])) or 1.0
    except (TypeError, ValueError, IndexError):
        return 1.0


def _effective_size(font_size, tm, cm) -> float:
    """版面上真正看到的字号 = Tf 字号 × 文本矩阵纵向缩放 × 当前变换矩阵纵向缩放。
    不少导出器把 Tf 设成 1、缩放全交给矩阵，只看 Tf 会让整份文档的字号看起来都一样。"""
    try:
        return abs(float(font_size)) * _yscale(tm) * _yscale(cm)
    except (TypeError, ValueError):
        return 0.0


def _is_bold(font_dict) -> bool:
    try:
        return bool(_BOLD_FONT.search(str(font_dict.get("/BaseFont") or "")))
    except Exception:      # noqa: BLE001 字重是加分信号，坏字体字典不该把解析拖垮
        return False


def page_lines(page) -> tuple[str, list[tuple[float, bool]]]:
    """一页 → (页文本, 逐行 (最大有效字号, 整行加粗))。行与 `页文本.split("\\n")` 一一对应。

    字号信息**跟着既有的 extract_text 顺手取回**，不另开一遍解析：pypdf 每往结果里追加一段
    文本就回调一次 visitor（追加与回调在同一处，故 `"".join(各段) == extract_text()`），
    因此按段里的 \\n 断行就能精确还原「第几行是什么字号」，零额外开销。
    visitor 出任何意外都退回朴素抽取（只是没有字号信号），绝不让解析入口炸掉。"""
    styles: list[list] = [[0.0, True, False]]      # [最大字号, 是否整行粗体, 这行有没有字]

    def visit(text, cm, tm, font_dict, font_size) -> None:
        if not text:
            return
        size, bold = _effective_size(font_size, tm, cm), _is_bold(font_dict)
        for i, part in enumerate(text.split("\n")):
            if i:
                styles.append([0.0, True, False])
            if part.strip():
                cur = styles[-1]
                cur[0], cur[1], cur[2] = max(cur[0], size), cur[1] and bold, True
    try:
        out = page.extract_text(visitor_text=visit) or ""
    except Exception:      # noqa: BLE001 见 docstring：字号取不到就不要，正文照常抽
        out = page.extract_text() or ""
        return out, [(0.0, False)] * len(out.split("\n"))
    return out, [(s[0] if s[2] else 0.0, s[1] and s[2]) for s in styles]


def outline_titles(reader) -> dict[str, int]:
    """PDF 书签树 → {标准化标题: 层级}。同名书签取最浅的一层；无书签/书签坏掉一律空字典。"""
    titles: dict[str, int] = {}
    try:
        _walk_outline(reader.outline, 1, titles)
    except Exception:      # noqa: BLE001 书签是加分信号，坏 xref/坏目的地不该把解析拖垮
        pass
    return titles


def _walk_outline(items, depth: int, out: dict[str, int]) -> None:
    """pypdf 的书签树：子级以**嵌套 list** 紧跟在父级之后，深度即层级。"""
    for it in items or ():
        if isinstance(it, list):
            _walk_outline(it, depth + 1, out)
            continue
        title = _norm(str(getattr(it, "title", "") or ""))
        if title and title not in out:
            out[title] = min(depth, _MAX_OUTLINE_DEPTH)


def pdf_lines(page_no: int, text: str, styles: list[tuple[float, bool]],
              outline: dict[str, int]) -> list[PdfLine]:
    """一页的文本 + 字号 + 书签 → 这一页的非空行。index 记的是**含空行**的原始行号，
    OCR 拼回后要靠它对上位置（见 resplit_marked）。

    字号只有在**逐行对得上号**时才要：条数对不上（换个 pypdf 版本、页里有竖排/双向文本）
    说明这一页的字号错位了，宁可这一页没有字号信号，也不能拿隔壁行的字号去判标题。"""
    raw_lines = text.split("\n")
    if len(styles) != len(raw_lines):
        styles = [(0.0, False)] * len(raw_lines)
    out: list[PdfLine] = []
    for i, raw in enumerate(raw_lines):
        t = raw.strip()
        if not t:
            continue
        size, bold = styles[i]
        out.append(PdfLine(text=t, page=page_no, index=i, size=size, bold=bold,
                           outline=outline.get(_norm(t))))
    return out


def _may_head(text: str) -> bool:
    """这一行**有没有资格**当标题（与判据无关的通用守卫，视觉信号与编号信号共用）。
    长行是正文；句读收尾的是列表项（「1、提供投标须知规定的全部投标文件。」）；
    纯数字/日期/金额不是标题；目录点线行不是标题。"""
    t = text.strip()
    return bool(t and len(t) <= _MAX_HEADING_CHARS and t[-1] not in _SENTENCE_END
                and _HAS_WORD.search(t) and not _NUMERIC_ONLY.match(t)
                and not _TOC_LEADER.search(t))


def _boilerplate(lines: list[PdfLine]) -> set[str]:
    """版式重复行（页眉/页脚/骑缝标注）的标准化文字。页数太少时不判——8 页的文件里
    一句话出现 4 次完全可能是真章节。"""
    pages = {ln.page for ln in lines}
    if len(pages) < _BOILERPLATE_MIN_PAGES:
        return set()
    seen: dict[str, set[int]] = {}
    for ln in lines:
        seen.setdefault(_norm(ln.text), set()).add(ln.page)
    limit = max(_BOILERPLATE_MIN_PAGES, len(pages) * _BOILERPLATE_PAGE_SHARE)
    return {t for t, ps in seen.items() if len(ps) >= limit}


def _body_size(lines: list[PdfLine]) -> float:
    """正文字号 = 按**字数**加权最常见的那个字号。按行数加权会被满篇的短标题带偏。"""
    weight: Counter = Counter()
    for ln in lines:
        if ln.size:
            weight[round(ln.size, 1)] += len(ln.text)
    return weight.most_common(1)[0][0] if weight else 0.0


def _visual_levels(lines: list[PdfLine], boiler: set[str]) -> list[int | None]:
    """字号/字重信号 → 逐行层级（None = 不是标题）。层级按字号从大到小排名。

    字号先行、字重只作救急：真实标书里靠字号分层是主流，而**加粗短行的噪声极大**
    （封面上「报 名 材 料」四个各自成段的大字、落款日期都是粗体，见 docx 那边的实测），
    只有字号一个层次都分不出来时才把整行粗体也算进去。
    版式重复行（页眉）只在「不比正文大」时排除：有些排版把当前章名印在页眉里，
    一刀切会把那一族文档的真章标题一起毙掉。"""
    body = _body_size(lines)
    if not body:
        return [None] * len(lines)
    cand = _prominent(lines, boiler, body, bold_ok=False)
    if len(cand) < _MIN_HEADINGS and _bold_usable(lines):
        cand = _prominent(lines, boiler, body, bold_ok=True)
    if not _MIN_HEADINGS <= len(cand) <= len(lines) * _MAX_HEADING_SHARE:
        return [None] * len(lines)
    ranks = {s: min(i + 1, _MAX_OUTLINE_DEPTH)
             for i, s in enumerate(sorted(set(cand.values()), reverse=True))}
    return [ranks[cand[i]] if i in cand else None for i in range(len(lines))]


def _prominent(lines: list[PdfLine], boiler: set[str], body: float,
               bold_ok: bool) -> dict[int, float]:
    """版面上比正文醒目的行 → {行号: 字号}。"""
    out: dict[int, float] = {}
    for i, ln in enumerate(lines):
        big = ln.size >= body * _PROMINENT_RATIO
        if not ln.size or not _may_head(ln.text) or (_norm(ln.text) in boiler and not big):
            continue
        if big or (bold_ok and ln.bold and ln.size >= body):
            out[i] = round(ln.size, 1)
    return out


def _bold_usable(lines: list[PdfLine]) -> bool:
    """整行粗体的行少到还有区分度时，字重才作数。"""
    n = sum(1 for ln in lines if ln.bold)
    return 0 < n <= len(lines) * _MAX_BOLD_SHARE


def _number_levels(lines: list[PdfLine], boiler: set[str]) -> list[int | None]:
    """编号启发式 → 逐行层级。判据与 docx 回退路径同源，只是 PDF 这边**对三种编号一律**
    施加 _may_head 的守卫（docx 只对阿拉伯编号施加）：PDF 抽出来的是物理行，一行 40 字上下，
    正文行几乎条条过得了长度门槛，不收紧的话承诺函「五、…」这种正文就是假标题。"""
    out: list[int | None] = []
    for ln in lines:
        t = ln.text.strip()
        if not _may_head(t) or _norm(t) in boiler:
            out.append(None)
            continue
        if _CHAPTER.match(t):
            out.append(1)
        elif _CN_NUMBER.match(t):
            out.append(2)
        else:
            m = _DOTTED_NUMBER.match(t)
            out.append(m.group(1).count(".") + 1 if m and _HAS_WORD.search(m.group(2)) else None)
    return out


def _covers(levels: list[int | None]) -> bool:
    """已认出的标题切得够不够细：条数够 + 标题之间最长的一段普通行既不过全文一半、
    也不超过 _MAX_GAP_LINES。366 页只认出 4 条时覆盖度是过得了的，绝对行数过不了。"""
    at = [i for i, lv in enumerate(levels) if lv]
    if len(at) < _MIN_HEADINGS:
        return False
    gaps = [at[0], len(levels) - 1 - at[-1]] + [at[i + 1] - at[i] - 1 for i in range(len(at) - 1)]
    return max(gaps) < min(len(levels) * _MAX_UNCOVERED_SHARE, _MAX_GAP_LINES)


def split_pdf_lines(lines: list[PdfLine]) -> tuple[list[dict], list[dict], list[dict]]:
    """PDF 正文行 → (clauses, headings, heading_marks)。判据顺序见模块头。

    heading_marks 记下「第几页第几行是标题」，供扫描页 OCR 拼回后原样复用
    （见 resplit_marked）——那时候字号与书签都已经不在手边了。"""
    boiler = _boilerplate(lines)
    levels: list[int | None] = [ln.outline if ln.outline and _norm(ln.text) not in boiler else None
                                for ln in lines]
    levels = [o or v for o, v in zip(levels, _visual_levels(lines, boiler))]
    if not _covers(levels):
        levels = [lv or n for lv, n in zip(levels, _number_levels(lines, boiler))]
    marks = [{"page": ln.page, "line": ln.index, "text": _norm(ln.text), "level": lv,
              "fixed": bool(ln.outline)}
             for ln, lv in zip(lines, levels) if lv]
    blocks = [Block(ln.text, level=ln.outline) for ln in lines]
    clauses, headings = _sections(blocks, levels)
    return clauses, headings, marks


def resplit_marked(page_texts: list[str], marks: list[dict]) -> tuple[list[dict], list[dict]]:
    """已定下的标题坐标 + （OCR 拼回后的）逐页文本 → (clauses, headings)。

    **只认原来那批标题坐标**，识别出来的文字一个字都不参与标题判定（口径同 docx 的
    splice_docx_images）：证照 OCR 出来的行大量长成「1、法定代表人：张三」，正是启发式眼里的
    章节标题，放行的话那一行会被丢出 clauses，后面的原文还会被重挂到一个由识别噪声命名的假节下。
    坐标之外再核对一遍行文字：纯扫描页的原文是被**整页替换**掉的，只认坐标会把
    「[第N页·扫描件识别]」这行标记认成标题。"""
    at = {(m["page"], m["line"]): m for m in marks}
    blocks: list[Block] = []
    levels: list[int | None] = []
    for p, page_text in enumerate(page_texts):
        for i, raw in enumerate(page_text.split("\n")):
            t = raw.strip()
            if not t:
                continue
            m = at.get((p, i))
            hit = m if m and m.get("text") == _norm(t) else None
            blocks.append(Block(t, level=hit["level"] if hit and hit.get("fixed") else None))
            levels.append(hit["level"] if hit else None)
    return _sections(blocks, levels)


def _sections(blocks: list[Block], levels: list[int | None]) -> tuple[list[dict], list[dict]]:
    """分组 → 并碎节 → 编号。三步全部走 docx 那边同一份实现，sec-id 口径单点在那里。
    书签给的标题（Block.level 非空）在合并里享有与 Word 大纲层级同等的豁免：作者标了就不并。"""
    return _emit(_merge_tiny_sections(_group(blocks, levels)))
