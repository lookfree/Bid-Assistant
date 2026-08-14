"""表单章模板渲染（零模型）：招标模板原文 → 线上稿 HTML。

用户口径：招标给了格式的表单（响应函/授权书/报价表…），投标必须一模一样，「多一个字都不行」
——线上和导出都是。2026-08-14 终局：表单章模型彻底退场，线上稿由这里的 template_html
零模型渲染＋form_copier 同值填空，导出由复印机搬招标 XML——两侧同构同值。
此前的路线（模型稿→固定片段保真检→拒稿纠偏）随模型退场整体退役：那套机制只查
固定文字与顺序，"插入"（自加编号/编造小节）是放行的，拦不住画蛇添足，还制造了
四轮误杀冤案（全半角/编号/合并格行头/章标题）。_norm/_plain/_WIDTH 留作共享工具
（导出 pristine 判定与填空标签归一在用）。
"""

from __future__ import annotations

import html as html_mod
import re

from agent.agents.bidding_agent.nodes.form_locate import is_form_title_line

# 空位：连续下划线（半/全角）、点线、长空白。三者都是纸质表单里「此处填写」的写法。
_BLANK = re.compile(r"[_＿]{2,}|[.．·]{4,}|[ \t　]{4,}")
_TAG = re.compile(r"<[^>]+>")
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

    2026-08-14 起这是表单章线上稿的**唯一**产出方式（零模型时代）：交付招标原格式
    ＋代码填空，比交付一份措辞被模型改写、看着很完整的表单安全得多——后者要到
    评标现场才发现对不上。
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
