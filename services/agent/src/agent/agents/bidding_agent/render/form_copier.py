"""表单章复印机（spec 2026-08-14-form-xml-copier）：招标 docx 的表单节点区间**原样搬运**。

「格式和招标书一样」此前走重建路线：解析降维成纯文本 → 模型填空 → 保真闸 → HTML 渲染，
版式在第一步就丢了，后面全在凭残影逆向重建——每份新标书都暴露新细节（表格聚合、合并格、
标点全半角、空格子……），修复收敛但封不了顶。复印机把这一族问题从机制上关掉：
表格/合并格/下划线/居中长在 XML 节点属性里，深拷贝即保真，因为它是复制不是重建。

搬不动的诚实拒收（CopierUnsupported），调用方回退现有 HTML 渲染路线，失败面不扩大：
  · 编号列表（w:numPr）——引用 numbering.xml 的编号定义，光搬节点是悬空引用，Word 里
    编号会错乱或丢失；表单极少用编号列表，V1 不为它搬 numbering；
  · 图片引用（a:blip / v:imagedata）——指向源文档的媒体部件，目标文档没有那个关系 id。
样式引用（w:pStyle 指向的 styleId）不拒：目标缺样式时 Word 回退默认样式，表单版式
绝大多数长在内联属性里，可接受（见 spec 风险表）。
"""

from __future__ import annotations

import copy
import html as html_mod
import io
import re

from agent.agents.bidding_agent.nodes.form_fidelity import _WIDTH as _LAB_WIDTH
from agent.agents.bidding_agent.nodes.form_locate import FormSpan

# 悬空引用的探测标签（命名空间写死：python-docx 的 nsmap 没有 a/v 前缀，qn 会抛）
_A_BLIP = "{http://schemas.openxmlformats.org/drawingml/2006/main}blip"
_V_IMAGEDATA = "{urn:schemas-microsoft-com:vml}imagedata"
_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_NUMPR = _W_NS + "numPr"
_P_TAG = _W_NS + "p"
_TBL_TAG = _W_NS + "tbl"
_SECTPR = _W_NS + "sectPr"


class CopierUnsupported(Exception):
    """区间搬不动（悬空引用/区间越界/抽不出内容）——回退 HTML 渲染路线的信号。"""


# 悬空引用黑名单（评审 2026-08-14 F4 扩容）：这些节点引用目标文档没有的关系/部件/编号定义，
# 深拷贝过去 Word 轻则弹修复、重则版面结构断裂。段内 sectPr（横版报价表切回竖版的常见写法）
# 同拒——分节属性嫁接进别人的分节序列会改写整本的页面设置。
_UNPORTABLE = {
    _NUMPR: "编号列表引用（numPr）",
    _A_BLIP: "图片引用（blip）",
    _V_IMAGEDATA: "图片引用（imagedata）",
    _W_NS + "hyperlink": "超链接引用（hyperlink）",
    _W_NS + "footnoteReference": "脚注引用",
    _W_NS + "endnoteReference": "尾注引用",
    _W_NS + "commentReference": "批注引用",
    _W_NS + "object": "OLE 对象",
    _SECTPR: "段内分节符（sectPr）",
}


def _check_portable(el) -> None:
    """节点能不能安全搬运；不能则抛 CopierUnsupported（原因进异常文本，观测事件要用）。"""
    for node in el.iter():
        reason = _UNPORTABLE.get(node.tag)
        if reason:
            raise CopierUnsupported(f"含{reason}")


def body_children(tender_docx: bytes) -> list:
    """招标 docx 字节 → body 子节点列表。多章复印时**只开一次文档**（评审 2026-08-14 F8：
    每章重开一次 ~MB 级 docx 的完整解析，纯浪费）。"""
    from docx import Document

    return list(Document(io.BytesIO(tender_docx)).element.body.iterchildren())


def extract_span(kids: list, span: FormSpan) -> list:
    """body 子节点列表 + 区间 → 深拷贝出的内容节点（只收 w:p / w:tbl）。"""
    if not (0 <= span.start <= span.end < len(kids)):
        raise CopierUnsupported(f"区间越界（{span.start}-{span.end}/{len(kids)}）")
    nodes = []
    for el in kids[span.start:span.end + 1]:
        if el.tag not in (_P_TAG, _TBL_TAG):
            continue                      # 书签等非内容节点不搬
        _check_portable(el)
        nodes.append(copy.deepcopy(el))
    if not nodes:
        raise CopierUnsupported("区间内没有可搬运的内容节点")
    return nodes


def extract_form_nodes(tender_docx: bytes, span: FormSpan) -> list:
    """单区间便捷入口（测试/单章用）；多章走 copy_forms。"""
    return extract_span(body_children(tender_docx), span)


_W_PPR = _W_NS + "pPr"
_W_IND = _W_NS + "ind"


def _immunize_indent(el) -> None:
    """嫁接段落的缩进免疫（2026-08-14 生产实证）：输出文档配置了导出格式时 Normal 带
    首行缩进，招标表单段落没写显式缩进就会被顶成缩进两字符——标签列全体右移。
    给没有 w:ind 的段落补 firstLine=0；已有显式缩进的（招标自己的排版）一个不动。
    字体/行距不免疫：随全书格式统一正是用户配置导出格式的意图。"""
    from lxml import etree

    for para in ([el] if el.tag == _P_TAG else []) + [n for n in el.iter(_P_TAG)]:
        ppr = para.find(_W_PPR)
        if ppr is None:
            ppr = etree.SubElement(para, _W_PPR)
            para.insert(0, ppr)
        if ppr.find(_W_IND) is None:
            ind = etree.SubElement(ppr, _W_IND)
            ind.set(_W_NS + "firstLine", "0")


def graft_nodes(doc, nodes: list) -> None:
    """把节点接进输出文档 body 末尾（调用方先写完章标题再嫁接，顺序即版面顺序）。
    sectPr 必须留在 body 最后——插到它后面 Word 直接打不开文档。"""
    body = doc.element.body
    sect = body.find(_SECTPR)
    for el in nodes:
        _immunize_indent(el)
        if sect is not None:
            sect.addprevious(el)
        else:
            body.append(el)


# ---------- T4 代码填空：确定性匹配，匹配不上留白，模板固定字符零改动 ----------

_W_R = _W_NS + "r"
_W_T = _W_NS + "t"
_W_TR = _W_NS + "tr"
_W_TC = _W_NS + "tc"
_W_P = _W_NS + "p"
_XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
# 空位：连续下划线（半/全角）。与保真闸的 _BLANK 同族；V1 只认下划线形态，
# 「下划线格式的空格 run」这类形态出现实证再扩。
_BLANK = re.compile(r"[_＿]{2,}")
# 宽度归一表**与保真闸同一份**（评审 2026-08-14 F15：两处各养一张表已经漂移——
# 「联系电话（＋８６）：」这类全角数字标签过得了闸却查不到值，改一处忘另一处是必然结局）。


def _lab_norm(text: str) -> str:
    """标签比对归一：去空白、标点/数字全半角归一（同保真闸）、去括注、去尾冒号。
    「单位名称(自然人姓名)：」与资料库标签「单位名称」要能对上；
    比对宽、写入零改动——归一只用于查表，落在纸上的模板字符原样。"""
    t = re.sub(r"[\s　]+", "", text or "").translate(_LAB_WIDTH)
    t = re.sub(r"\([^()]*\)", "", t)
    return t.rstrip(":")


def _meta_fields(meta: dict) -> list[tuple[str, str]]:
    """项目信息白名单（read 的 project_meta 固定英文键）→ 可填标签对。
    只放三项确定性字段；预算/工期这类含义多歧的**不放**——填错比留白更贵。"""
    pairs = [("项目名称", meta.get("name")), ("项目编号", meta.get("code")),
             ("采购人", meta.get("buyer")), ("采购人名称", meta.get("buyer"))]
    return [(k, str(v)) for k, v in pairs if v]


def _run_text(r) -> str:
    return "".join(t.text or "" for t in r.findall(_W_T))


def _set_run_text(r, text: str) -> None:
    """整 run 换文本，**格式部件（rPr，含下划线）原样保留**——填的字写在横线上。"""
    from lxml import etree

    ts = r.findall(_W_T)
    for t in ts[1:]:
        r.remove(t)
    t = ts[0] if ts else etree.SubElement(r, _W_T)
    t.set(_XML_SPACE, "preserve")
    t.text = text


# 空位**后面**的括注标签：「____（供应商全称）」——纸质表单常把"填什么"写在横线后的括注里
# （授权书正是这形态）。前看无标签时按它查值；括注本身是模板文字，原样保留。
_TRAILING_LABEL = re.compile(r"^[（(]([^（）()]{2,14})[）)]")


def _fill_paragraph(p, lut: dict[str, str]) -> int:
    """段落型空位：「标签：」＋下划线 run（分 run 或同 run，一 run 多空位逐个处理——
    「电话：__ 传真：__」打在同一个 run 里第二个空位也要各认各的，评审 2026-08-14 F14）。
    标签先取**自段首或上一个空位以来**的前文；前文查不到再看空位后紧跟的括注。"""
    filled = 0
    label_buf = ""
    runs = p.findall(_W_R)
    for i, r in enumerate(runs):
        text = _run_text(r)
        if not text:
            continue
        if not _BLANK.search(text):
            label_buf += text
            continue
        out, pos, changed = "", 0, False
        for m in _BLANK.finditer(text):
            seg = text[pos:m.start()]
            val = lut.get(_lab_norm(label_buf + seg))
            if not val:
                # 后括注标签：先看同 run 空位之后，再看下一个 run 的开头
                after = text[m.end():] or (_run_text(runs[i + 1]) if i + 1 < len(runs) else "")
                tm = _TRAILING_LABEL.match(after)
                if tm:
                    val = _alias_value(tm.group(1), lut)
            out += seg + (val if val else m.group(0))
            if val:
                filled += 1
                changed = True
            label_buf = ""             # 空位之后另起一段标签（无论填没填）
            pos = m.end()
        tail = text[pos:]
        out += tail
        label_buf = tail
        if changed:
            _set_run_text(r, out)
    return filled


def _cell_text(tc) -> str:
    return "".join(t.text or "" for t in tc.iter(_W_T))


def _write_cell(tc, text: str) -> None:
    from lxml import etree

    p = tc.find(_W_P)
    if p is None:
        p = etree.SubElement(tc, _W_P)   # w:tc 至少要有一个 w:p，Word 才认
    r = etree.SubElement(p, _W_R)
    t = etree.SubElement(r, _W_T)
    t.set(_XML_SPACE, "preserve")
    t.text = text


def _fill_table(tbl, lut: dict[str, str]) -> int:
    """表格型空位：标签格 → 右侧**空**格写值；格内段落的下划线空位照段落规则填。"""
    filled = 0
    for tr in tbl.findall(_W_TR):
        tcs = tr.findall(_W_TC)
        for i, tc in enumerate(tcs[:-1]):
            val = lut.get(_lab_norm(_cell_text(tc)))
            if val and not _cell_text(tcs[i + 1]).strip():
                _write_cell(tcs[i + 1], val)
                filled += 1
    for p in tbl.iter(_W_P):
        filled += _fill_paragraph(p, lut)
    return filled


# 占位括注**只在「冒号之后」的槽位替换**（评审 2026-08-14 F5 收窄裁量）：
# 「致：【XX公司[采购人名称]】：」冒号后的括注是明确的值槽，替掉是对的；
# 「致（采购人）：」的括注是标签限定语、「____（供应商全称）」的括注是空位说明——
# 替掉它们就是改模板固定文字。宁可少填不错填，非冒号槽一律不动。
_SLOT_KEYS = {"单位名称": "单位名称", "供应商名称": "单位名称", "供应商全称": "单位名称",
              "采购人名称": "采购人", "项目名称": "项目名称", "项目编号": "项目编号"}
_SLOT = re.compile(r"(?<=[：:])\s*([（(][^（）()]{2,14}[）)]|【[^【】]{2,16}】)")


def _alias_value(label: str, lut: dict[str, str]) -> str | None:
    """占位标签 → 值：先按 _SLOT_KEYS 别名（「供应商全称」→单位名称），再按字面查表。"""
    for key, field in _SLOT_KEYS.items():
        if key in label and lut.get(_lab_norm(field)):
            return lut[_lab_norm(field)]
    return lut.get(_lab_norm(label))


def _fill_slots(p, lut: dict[str, str]) -> int:
    """冒号后的占位括注 → 值（整个括注含括号一起替换）。"""
    filled = 0
    for r in p.findall(_W_R):
        text = _run_text(r)
        if not text or "：" not in text and ":" not in text:
            continue
        def _sub(m, _lut=lut):
            return _alias_value(m.group(1)[1:-1], _lut) or m.group(0)
        new_text = _SLOT.sub(_sub, text)
        if new_text != text:
            _set_run_text(r, new_text)
            filled += 1
    return filled


def copy_forms(tender_docx: bytes, spans: dict[str, FormSpan], fields: list[tuple[str, str]],
               meta: dict) -> tuple[dict[str, tuple[list, int]], dict[str, str]]:
    """批量抽取+填空（同步重活，调用方丢线程池）→ ({章: (节点, 填空数)}, {章: 失败原因})。
    文档只开一次；单章失败不牵连其余章。"""
    kids = body_children(tender_docx)
    ok: dict[str, tuple[list, int]] = {}
    fail: dict[str, str] = {}
    for cid, span in spans.items():
        try:
            nodes = extract_span(kids, span)
            ok[cid] = (nodes, fill_blanks(nodes, fields, meta))
        except CopierUnsupported as e:
            fail[cid] = str(e)
        except Exception as e:  # noqa: BLE001 单章意外不牵连其余章
            fail[cid] = f"意外:{e}"
    return ok, fail


def fill_blanks(nodes: list, fields: list[tuple[str, str]], meta: dict) -> int:
    """在深拷贝出的表单节点上填空 → 命中数。值来源=资料库企业信息（用户录什么标签
    匹配什么标签，见 bidder_profile）＋项目信息白名单；同名标签先到先得；
    匹配不上一律留白——代码不虚构，这正是它比模型填空可靠的地方。"""
    lut = build_lut(fields, meta)
    if not lut:
        return 0
    n = 0
    for el in nodes:
        if el.tag == _P_TAG:
            n += _fill_paragraph(el, lut) + _fill_slots(el, lut)
        elif el.tag == _TBL_TAG:
            n += _fill_table(el, lut)
    return n


# ---------- HTML 版填空（2026-08-14 用户口径：审查材料必须与最终交付同值）----------
# 复印机只在导出时作用于 XML；正文步交付的 HTML（审查/编辑器都看它）若留白，
# 审查结论描述的就不是用户最终拿到的文件。同一套查表在正文收尾先填 HTML，
# 导出再填招标 XML——三处同值，版式各自最优。
# 结构性债务（评审 2026-08-14 F9，显式接受）：HTML 与 XML 两套填空适配器并存，规则以
# XML 版为准绳、共用 build_lut/_lab_norm/_SLOT/_TRAILING_LABEL；后续规则改动两处都要动，
# 彻底统一（单规则核+双适配器）待表单链路稳定后再做，先不为它冒重构险。

# 裸「<」必须自成 token（评审 F5 实证：findall 丢弃不匹配片段，「x < y」的 < 被静默吞掉）
_HTML_TOKEN = re.compile(r"<[^>]*>|[^<]+|<")
_BLOCK_OPEN = re.compile(r"^<(?:p|h[1-6]|tr|li|table|div)\b", re.I)
# 标签格→右侧空格（评审 F2 放宽到与 XML 版同宽容度）：格内允许内联标签（<strong>加粗
# 标签格）、th 也算格、空格判定剥标签与 &nbsp; 后看不见字才算空。
_TD_PAIR = re.compile(r"(<t[dh][^>]*>)(.{0,120}?)(</t[dh]>\s*<t[dh][^>]*>)(.{0,40}?)(</t[dh]>)",
                      re.S)
_INVISIBLE = re.compile(r"(?:<[^>]*>|&nbsp;|\s)+")
_TAG_RE = re.compile(r"<[^>]+>")


def build_lut(fields: list[tuple[str, str]], meta: dict) -> dict[str, str]:
    """字段对+项目信息 → 归一化查表（XML 填空与 HTML 填空共用同一份）。"""
    lut: dict[str, str] = {}
    for label, value in list(fields or []) + _meta_fields(meta or {}):
        key = _lab_norm(label)
        if key and value and key not in lut:
            lut[key] = str(value)
    return lut


def _fill_text_token(text: str, label_buf: str, nxt: str, lut: dict[str, str]) -> tuple[str, str, int]:
    """一个文本 token 里的下划线空位/冒号槽 →（新文本, 新标签缓冲, 填空数）。
    **单遍从左到右**：空位与冒号槽按出现序合并处理，插进去的值只追加进输出、
    绝不回扫（评审 F6 实证：值里自带的【】/____ 会被后续 pass 再改写）。
    值一律 html 转义（评审 F1 实证：值里的 <>& 会碎成伪标签，编辑器 innerHTML 直接吃进去）。"""
    filled = 0
    out, pos, buf = "", 0, label_buf
    events = sorted([(m.start(), "blank", m) for m in _BLANK.finditer(text)]
                    + [(m.start(), "slot", m) for m in _SLOT.finditer(text)])
    for _at, kind, m in events:
        if m.start() < pos:
            continue                     # 与已处理片段重叠（理论上不发生，防御）
        seg = text[pos:m.start()]
        if kind == "blank":
            val = lut.get(_lab_norm(buf + seg))
            if not val:
                after = text[m.end():] or nxt
                tm = _TRAILING_LABEL.match(after)
                if tm:
                    val = _alias_value(tm.group(1), lut)
            buf = ""
        else:
            val = _alias_value(m.group(1)[1:-1], lut)
            buf = buf + seg              # 槽不重置标签段（槽在冒号后，本就自带语境）
        out += seg + (html_mod.escape(val) if val else m.group(0))
        if val:
            filled += 1
        pos = m.end()
    tail = text[pos:]
    out += tail
    buf = (buf + tail) if not events else tail
    return out, buf, filled


def fill_blanks_html(html: str, fields: list[tuple[str, str]], meta: dict) -> tuple[str, int]:
    """正文 HTML 上的确定性填空 →（新 HTML, 命中数）。匹配不上留白、模板字符零改动，
    与 XML 版同一套查表与规则；标签只当块边界，一个不动。
    顺序：先文本 token 遍（原文上扫，值不回扫），后标签格遍（td 内插值同样不再被扫）。"""
    lut = build_lut(fields, meta)
    if not lut or not html:
        return html or "", 0
    filled = 0
    tokens = _HTML_TOKEN.findall(html)
    out: list[str] = []
    label_buf = ""
    for i, tok in enumerate(tokens):
        if tok.startswith("<"):
            if _BLOCK_OPEN.match(tok):
                label_buf = ""              # 块边界重开标签段
            out.append(tok)
            continue
        nxt = next((t for t in tokens[i + 1:i + 4] if not t.startswith("<")), "")
        new, label_buf, n = _fill_text_token(tok, label_buf, nxt, lut)
        filled += n
        out.append(new)
    html = "".join(out)

    def _td_sub(m: "re.Match[str]") -> str:
        nonlocal filled
        label = _TAG_RE.sub("", m.group(2))
        val = lut.get(_lab_norm(label))
        if val and _INVISIBLE.fullmatch(m.group(4) or " "):
            filled += 1
            return m.group(1) + m.group(2) + m.group(3) + html_mod.escape(val) + m.group(5)
        return m.group(0)

    html = _TD_PAIR.sub(_td_sub, html)
    return html, filled
