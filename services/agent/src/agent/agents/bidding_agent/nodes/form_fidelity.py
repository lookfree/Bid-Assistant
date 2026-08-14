"""表单章保真：模型只许填空，改没改原文由**代码**判，不靠提示词请求。

用户口径：招标给了格式的表单（响应函/授权书/报价表…），投标必须一模一样，「多一个字都不行」。
提示词里写「严禁自创格式」只是请求——2026-08-11 潍坊那单实测，招标 7 条固定条款被写成 6 条
全新措辞。所以这里把它变成**可判定的**：把模板切成固定片段，逐片检查是否原序出现在产出里，
任何一片对不上就丢弃产出、直接拿招标原文渲染。

什么算「可以变的」：
  · 下划线/长空白/点线 —— 本来就是留给投标人填的空
  · 括注占位（「（投标人名称）」「（盖章）」）—— 投标人要替换掉的占位符
其余每一个字都是固定文字。占位括注一律豁免是**故意放宽**：宁可漏判一处括注里的改写，
也不要因为模型正常地把「（投标人名称）」换成真名就把整章判死、退回一张空表。
"""

from __future__ import annotations

import html as html_mod
import re

from agent.agents.bidding_agent.nodes.form_locate import is_form_title_line

# 空位：连续下划线（半/全角）、点线、长空白。三者都是纸质表单里「此处填写」的写法。
_BLANK = re.compile(r"[_＿]{2,}|[.．·]{4,}|[ \t　]{4,}")
# 占位括注：短括注才算占位，长括注多半是条款正文里的说明（如「（含税，大写与小写不一致时以大写为准）」）。
# 【】括注同是占位（2026-08-14 云上实测：响应函模板「致：【XX公司[采购人名称]】：」被模型
# 正确替换成真实采购人名，反被判「改写」退回留白）。
_PLACEHOLDER = re.compile(r"[（(][^（）()]{0,14}[）)]|【[^【】]{0,16}】")
_TAG = re.compile(r"<[^>]+>")
# 少于 6 个字的片段不作数：标点、编号、「致：」这类碎片到处都是，拿它们比对只会误判
_MIN_SEG = 6

# 标点全半角归一（2026-08-14 云上实测：模板句里是半角「,」「(」——OCR/录入噪声——模型按中文
# 习惯写全角，一字之差整章判死退回留白）。只归比对，交付内容一个字不动。数字一并归：
# 「（元）」里混入全角数字同理。
_WIDTH = str.maketrans("：（），；？！＿．％－０１２３４５６７８９", ":(),;?!_.%-0123456789")


def _norm(text: str) -> str:
    """比对用的归一化：去空白 + 标点/数字全半角归一。HTML 重排（换行、缩进）与
    全半角书写习惯都不该被当成改写。"""
    return re.sub(r"\s+", "", text or "").translate(_WIDTH)


def _plain(html: str) -> str:
    """HTML → 纯文字（去标签 + 反转义实体）。表格改成 <td> 分列不算改写，字没变就行。"""
    return _norm(html_mod.unescape(_TAG.sub("", html or "")))


def fixed_segments(template: str, title: str = "") -> list[str]:
    """模板 → 必须原样保留的固定片段（按出现顺序），**逐行切**。

    与章标题同文的片段（含去段首编号后同文）**剔除**（2026-08-14 云上 b7 实测）：
    模板首行往往就是表单名（「供应商情况一览表」，≥6 字入片段），而模型正文从不
    重复章标题——标题由渲染层出。留着它等于每章必拒、退回碎版式模板。

    为什么按行而不是把整份模板连成一条：连起来的话，模型在两行之间多写一个章标题
    （表单章本来就需要标题）就会让跨行的片段找不到，整章被判死、退回一张空表。
    保真机制天天误伤比不做还糟。按行切之后：改写、漏行、乱序照样逮得住，
    行与行之间插了别的东西则放过——插入远不如改写危险，而且肉眼一看就发现。

    行内**连续重复的表格格**先折叠成一个（「合计（大写）：\\t合计（大写）：」）：
    重复文本来自解析层摊平合并单元格，把 N 份都当固定片段，等于禁止任何一方
    （模型或零模型渲染）把它还原成合并格——正确的还原反而过不了检（2026-08-13
    云上江西版式返工实证）。折叠后：合并渲染与摊平渲染都能通过，顺序约束不变。
    """
    out: list[str] = []
    prev_first = ""
    for line in (template or "").splitlines():
        cells = line.split("\t")
        # 竖向合并格摊平的重复行头（「联系方式|联系人…」「联系方式|传真…」）：模型用
        # rowspan 正确还原时第二行不再有「联系方式」，粘着它的固定段必然断——重复行头
        # 当空格子断段（2026-08-14 云上实测：供应商情况一览表整章冤死在「联系方式传真」）。
        first_norm = _norm(cells[0]) if cells else ""
        if len(cells) > 1 and first_norm and first_norm == prev_first:
            cells[0] = ""
        prev_first = first_norm if len(cells) > 1 else ""
        cells = [c for i, c in enumerate(cells) if i == 0 or _norm(c) != _norm(cells[i - 1]) or not _norm(c)]
        # 空格子＝填空位：固定段在空格子处断开。不断的话「联系人\t\t联系电话」折成一条
        # 「联系人联系电话」，模型往空格子里填了值段就断——填空反被判改写
        # （2026-08-14 云上实测：供应商情况一览表整章因此退回留白）。
        joined = "\t".join(c if _norm(c) else "\x00" for c in cells)
        marked = _PLACEHOLDER.sub("\x00", _BLANK.sub("\x00", joined))
        out += [seg for raw in marked.split("\x00") if len(seg := _norm(raw)) >= _MIN_SEG]
    # 标题变体一并豁免（评审三轮 F7）：提纲标题常带编号/尾括注（「7.供应商情况一览表」
    # 「供应商情况一览表（格式一）」），只比精确同文的话换个标题写法冤案就复发。
    # 片段侧的括注在上面已被 _PLACEHOLDER 断段，只需归一标题侧。
    ntitle = re.sub(r"\([^()]{0,14}\)$", "", _SEG_NO.sub("", _norm(title)))
    if ntitle:
        out = [s for s in out if _SEG_NO.sub("", s) != ntitle]
    return out


# 段首编号（「1.」「4-2」「3、」）：模型把编号条款写成 <ol><li> 时数字由渲染器生成，
# 纯文本抽取里编号消失——「1.具有独立承担民事责任的能力」找不到，实为语义等价
# （2026-08-14 云上实测：承诺函六项资格条件全走 <ol>，整章冤死）。
_SEG_NO = re.compile(r"^\d+(?:[-.]\d+)*[.、．]?")


def first_missing_segment(html: str, template: str, title: str = "") -> str | None:
    """第一个在产出里找不到（或顺序不对）的固定片段；全都在则 None。

    被拒的模型稿此前直接丢弃——填空稿被误杀时无从诊断到底哪一行「改写」了
    （2026-08-13 云上实测：企业信息齐全、模型填了空，交付却退回留白模板，黑箱）。
    这个函数是拒稿观测的诊断核心：拒一次，记下第一处对不上的片段与稿件头部。
    段首编号豁免（见 _SEG_NO）：原文找不到时去掉编号再找一次——HTML 有序列表的编号
    不在文本层，行内其余每个字仍逐字校验，顺序约束不变。"""
    segments = fixed_segments(template, title)
    hay = _plain(html)
    pos = 0
    for seg in segments:
        found = hay.find(seg, pos)
        if found < 0:
            bare = _SEG_NO.sub("", seg)
            if len(bare) >= _MIN_SEG and bare != seg:
                found = hay.find(bare, pos)
                if found >= 0:
                    pos = found + len(bare)
                    continue
            return seg
        pos = found + len(seg)
    return None


def keeps_template(html: str, template: str, title: str = "") -> bool:
    """产出有没有原样保留模板的固定文字（顺序也要对）。

    顺序必须一起查：条款被打乱顺序重排，同样是「与招标格式不一致」。
    模板切不出任何固定片段（整份都是空位）时视为通过——没有可判定的东西，不该冤杀产出。
    """
    return first_missing_segment(html, template, title) is None


# 表行间的裸行号/空位行（「1」「2」「____」）：原表里是一格行号带一整行空格的空白行，
# 解析摊平后制表符丢了。不归回表里，表格会被它们切成两张、行号成了表外的孤立段落
# （2026-08-13 云上江西报价一览表实测：用户口径「格式和招标文件不一样」）。
_ROW_FRAGMENT = re.compile(r"^\d{1,3}$|^[_＿]+$")
# 落款行：签字/签章/盖章。招标表单里这些行靠右（原文前导空格被解析层剥掉，只能按惯例回排）。
# 「日期：」不收——响应函的日期在左侧落款块里，靠右反而错。
# 编号开头的不收——「3、本响应函须由法定代表人签字：」是表单正文条款，在原文里靠左
# （评审 2026-08-13 CONFIRMED：正文条款被甩到右边距，恰是本渲染承诺保住的版式）。
_SIGN_LINE = re.compile(r"(签字|签章|盖章)\s*[:：]")
_NUMBERED_CLAUSE = re.compile(r"^\d{1,2}[、.．]|^[（(][一二三四五六七八九十0-9]{1,3}[）)]")


def _rows_html(rows: list[list[str]]) -> str:
    """表行组 → 一张表。连续同文本的格并成 colspan（解析层把合并单元格摊平成重复文本，
    这里还原回去）；合并行的尾格补满整行列宽（「合计（大写）」在原表横贯整行）；
    短行（裸行号）右侧补空格——不补的话每行列数不一，Word 里表格参差不齐。"""
    cols = max(len(r) for r in rows)
    trs: list[str] = []
    for r in rows:
        tds: list[str] = []
        used, i = 0, 0
        while i < len(r):
            j = i
            # 空位格（____）相邻同文不并——那是每列各一个的填空格，不是摊平的合并格
            # （评审 2026-08-13 CONFIRMED：两个独立填空并成一格横贯两列）
            while j + 1 < len(r) and r[j + 1] == r[i] and r[i] and not _BLANK.fullmatch(r[i]):
                j += 1
            span = j - i + 1
            if j == len(r) - 1 and span > 1:
                span += cols - len(r)
            tds.append(f'<td colspan="{span}">{html_mod.escape(r[i])}</td>' if span > 1
                       else f"<td>{html_mod.escape(r[i])}</td>")
            used += span
            i = j + 1
        tds += ["<td></td>"] * (cols - used)
        trs.append(f"<tr>{''.join(tds)}</tr>")
    return f"<table>{''.join(trs)}</table>"


def template_html(template: str, title: str = "") -> str:
    """招标模板原文 → 章正文 HTML（**零模型**）。制表符分列的行还原成表格行，
    夹在表行间的裸行号/空位行归回同一张表，落款行靠右，表单抬头居中；
    首行就是抬头时不再另出一个章名标题（一左一中两个标题，2026-08-13 实测反馈）。

    这是模型改写模板时的退路：交付一份**留着空位**的招标原格式，比交付一份措辞被改写、
    看着很完整的表单安全得多——后者要到评标现场才发现对不上。
    """
    lines = (template or "").splitlines()
    first = next((ln.strip() for ln in lines if ln.strip()), "")
    # 章名 h3 只有在首行**会渲染成居中抬头**且同名时才省——首行同名但渲染不了抬头
    # （带括注/超长，is_form_title_line 拒收）时省掉章名，整章就一个标题都没有了
    # （评审 2026-08-13 CONFIRMED）。
    dup_title = title and is_form_title_line(first) and _norm(first) == _norm(title)
    out: list[str] = [f"<h3>{html_mod.escape(title)}</h3>"] if title and not dup_title else []
    rows: list[list[str]] = []

    def flush() -> None:
        if rows:
            out.append(_rows_html(rows))
            rows.clear()

    for line in lines:
        s = line.strip()
        if not s:
            continue   # 空行不冲表：表行组里夹着空行是解析常态，冲掉表又碎回孤立段落
        if "\t" in line:
            rows.append([c.strip() for c in line.split("\t")])
            continue
        if rows and _ROW_FRAGMENT.match(s):
            rows.append([s])
            continue
        flush()
        if is_form_title_line(line):
            # 表单抬头（「响   应   函」）居中——招标表单的抬头都是居中的，
            # 排成左对齐正文就是「格式跟招标书不一样」（2026-08-13 用户实测反馈）
            out.append(f'<h3 style="text-align:center">{html_mod.escape(s)}</h3>')
        elif len(s) <= 24 and _SIGN_LINE.search(s) and not _NUMBERED_CLAUSE.match(s):
            out.append(f'<p style="text-align:right">{html_mod.escape(s)}</p>')
        else:
            # 行首空格串保留（2026-08-14 零模型线上稿实测）：授权书首个空位在行首
            # （缩进+长空格），strip 会把它连同缩进一起吃掉——填空引擎从此无处落笔，
            # 供应商全称槽线上永远留白。浏览器渲染时多余空白自然折叠，不碍观感。
            out.append(f"<p>{html_mod.escape(line.rstrip())}</p>")
    flush()
    return "".join(out)
