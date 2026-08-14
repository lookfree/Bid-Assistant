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
    # 顶层段落的段内 sectPr 在抽取时已剥离（_strip_inline_sectpr）；走到这条说明它藏在
    # 表格等异常位置——不敢碰结构，照拒。
    _SECTPR: "段内分节符（sectPr）",
}


_MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
_R_ATTR_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_O_RELID = "{urn:schemas-microsoft-com:office:office}relid"


def _rel_free(el) -> bool:
    """子树里一个关系引用都没有（r:id / r:embed / r:link…；VML 的 o:relid 同算——
    老 Word 常只写它不写 r:id，评审三轮 F5）。"""
    return not any(k.startswith(_R_ATTR_NS) or k == _O_RELID
                   for node in el.iter() for k in node.attrib)


def _check_portable(el) -> None:
    """节点能不能安全搬运；不能则抛 CopierUnsupported（原因进异常文本，观测事件要用）。

    mc:Fallback 豁免（2026-08-14 云上 b2 授权书实测）：身份证粘贴框的 v:imagedata 全在
    兼容降级层里——Word 只读 mc:Choice——且不引用任何图片部件，此前被当悬空引用白拒。
    豁免只豁**无引用的图片壳**（评审三轮 F4 收窄）：numPr/脚注这类按 ID 悬空引用的
    照拒——WPS/LibreOffice 啃不动 Choice 时会读降级层，ID 悬空同样烂版。"""
    stack = [(el, False)]
    while stack:
        node, in_fb = stack.pop()
        if not in_fb and node.tag == _MC_FALLBACK and _rel_free(node):
            in_fb = True
        reason = _UNPORTABLE.get(node.tag)
        if reason and not (in_fb and node.tag in (_V_IMAGEDATA, _A_BLIP)):
            raise CopierUnsupported(f"含{reason}")
        stack.extend((c, in_fb) for c in node)


def body_children(tender_docx: bytes) -> list:
    """招标 docx 字节 → body 子节点列表。多章复印时**只开一次文档**（评审 2026-08-14 F8：
    每章重开一次 ~MB 级 docx 的完整解析，纯浪费）。"""
    from docx import Document

    return list(Document(io.BytesIO(tender_docx)).element.body.iterchildren())


_PGSZ = _W_NS + "pgSz"


def _same_page_geometry(sect, ref) -> bool:
    """段内 sectPr 的页面尺寸与文档级是否一致。段内没写 pgSz＝继承，视为一致；
    文档级拿不到而段内声明了尺寸，宁可当不一致。"""
    pg = sect.find(_PGSZ)
    if pg is None:
        return True
    rg = ref.find(_PGSZ) if ref is not None else None
    if rg is None:
        return False
    return (pg.get(_W_NS + "w"), pg.get(_W_NS + "h")) == \
           (rg.get(_W_NS + "w"), rg.get(_W_NS + "h"))


def _strip_inline_sectpr(el, ref) -> None:
    """顶层段落的段内分节符剥离（2026-08-14 云上 b2 授权书实测）：表单末行常挂着
    「本节到此为止」标记，页面几何与文档级完全相同，只是带着指向招标页脚的引用。
    原样搬＝悬空引用＋招标页面设置改写全书；剥掉它，表单内容并入输出文档当前节。
    只剥**页面几何与文档级相同**的（评审三轮 F6）：横版表单剥了会把按横版宽度写死的
    表格塞进竖版页，留着走黑名单拒收，HTML 退路重排适配页面。藏在表格里的同样照拒。"""
    if el.tag != _P_TAG:
        return
    ppr = el.find(_W_PPR)
    sect = ppr.find(_SECTPR) if ppr is not None else None
    if sect is not None and _same_page_geometry(sect, ref):
        ppr.remove(sect)


def extract_span(kids: list, span: FormSpan) -> list:
    """body 子节点列表 + 区间 → 深拷贝出的内容节点（只收 w:p / w:tbl）。
    可修复的不可搬因素先修（段内 sectPr 剥离，只动拷贝不动原文档），修不了的诚实拒收。"""
    if not (0 <= span.start <= span.end < len(kids)):
        raise CopierUnsupported(f"区间越界（{span.start}-{span.end}/{len(kids)}）")
    ref = kids[-1] if kids and kids[-1].tag == _SECTPR else None   # 文档级页面设置
    nodes = []
    for el in kids[span.start:span.end + 1]:
        if el.tag not in (_P_TAG, _TBL_TAG):
            continue                      # 书签等非内容节点不搬
        c = copy.deepcopy(el)
        _strip_inline_sectpr(c, ref)
        _check_portable(c)
        nodes.append(c)
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
_W_U = _W_NS + "u"


def _is_underlined_blank(r, text: str) -> bool:
    """下划线格式的纯空格 run＝手写留空线（2026-08-14 云上授权书实证，V1 预留形态）：
    整个 run 是一个空位。放宽到任意长空格不敢——缩进/对齐空格遍地都是，
    下划线格式才是「在此线上填写」的凭证。"""
    if text.strip() or len(text) < 2:
        return False
    rpr = r.find(_W_RPR)
    u = rpr.find(_W_U) if rpr is not None else None
    return u is not None and u.get(_W_NS + "val") != "none"


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
        if _is_underlined_blank(r, text):
            val = lut.get(_lab_norm(label_buf))
            if not val:
                nxt = _run_text(runs[i + 1]) if i + 1 < len(runs) else ""
                tm = _TRAILING_LABEL.match(nxt)
                if tm:
                    val = lut.get(_lab_norm(tm.group(1)))
            if val:
                _set_run_text(r, val)   # 值写回原 run，rPr（含下划线）原样＝字在横线上
                filled += 1
            label_buf = ""
            continue
        if not _BLANK.search(text):
            label_buf += text
            continue
        out, pos, changed = "", 0, False
        for m in _BLANK.finditer(text):
            seg = text[pos:m.start()]
            val = lut.get(_lab_norm(label_buf + seg))
            if not val:
                # 后括注标签：先看同 run 空位之后，再看下一个 run 的开头。
                # 精确查表不走子串别名（评审三轮 F3：「分供应商名称」被子串配上自家名）
                after = text[m.end():] or (_run_text(runs[i + 1]) if i + 1 < len(runs) else "")
                tm = _TRAILING_LABEL.match(after)
                if tm:
                    val = lut.get(_lab_norm(tm.group(1)))
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
    """表格型空位：标签格 → 右侧**空**格写值；格内段落的下划线空位照段落规则填。
    直查不中时试**行头+子标签**组合（2026-08-14 云上 b7 截图实证：「法定代表人|姓名|_」
    的值标签在行头，格子只写「姓名」）——组合同样走名单查表，查不到照旧留白，
    「技术负责人|姓名」这类库里没人的行自然不受影响。"""
    filled = 0
    for tr in tbl.findall(_W_TR):
        tcs = tr.findall(_W_TC)
        head = _lab_norm(_cell_text(tcs[0])) if tcs else ""
        for i, tc in enumerate(tcs[:-1]):
            lab = _lab_norm(_cell_text(tc))
            val = lut.get(lab)
            if not val and i > 0 and head and lab:
                val = lut.get(head + lab)
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
    """占位标签 → 值：先按 _SLOT_KEYS 别名（「供应商全称」→单位名称），再按字面查表。
    子串匹配**只服务槽位**——「XX公司[采购人名称]」这类复合占位文本非子串配不上；
    行尾冒号/尾括注是纯标签，一律精确查表（评审三轮 F3：子串会把「分供应商名称」
    误配成自家名，比留白更糟）。"""
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


_W_RPR = _W_NS + "rPr"
# 行尾冒号空位（2026-08-14 云上导出实测）：招标落款「供应商名称：」冒号后**什么都没有**
# ——不是下划线形态，此前 XML 填空无落点（filled=0），审查页模型填了值、导出却是空标签，
# 同值原则被反向打破。整行归一后必须是**短**标签（≤14 字）才候选：长句引导语
# （「我方承诺如下内容：」）天然出局，再由查表命中把关——名单查不到一律留白。
_MAX_LINE_LABEL = 14


def _fill_line_end(p, lut: dict[str, str]) -> int:
    """整段=「标签：」的行 → 冒号后追加值 run（沿用末 run 的 rPr，值与标签同格式）。
    只在**顶层段落**上跑：表格标签格的值走右侧空格（_fill_table），标签格自身再追加就是双份。"""
    from lxml import etree

    text = "".join(t.text or "" for t in p.iter(_W_T))
    s = text.rstrip(" \t　")
    if not s.endswith(("：", ":")) or _BLANK.search(text):
        return 0
    label = s[:-1]
    if not label or len(_lab_norm(label)) > _MAX_LINE_LABEL:
        return 0
    # 精确查表（别名已折进 lut）不走 _alias_value 子串——「分供应商名称：」不是我方名称槽
    # （评审三轮 F3）
    val = lut.get(_lab_norm(label))
    if not val:
        return 0
    runs = p.findall(_W_R)
    r = etree.SubElement(p, _W_R)
    rpr = runs[-1].find(_W_RPR) if runs else None
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    t = etree.SubElement(r, _W_T)
    t.set(_XML_SPACE, "preserve")
    t.text = val
    return 1


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
            n += _fill_paragraph(el, lut) + _fill_slots(el, lut) + _fill_line_end(el, lut)
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
_INVISIBLE = re.compile(r"(?:<[^>]*>|&nbsp;|\s)+")
_TAG_RE = re.compile(r"<[^>]+>")
# 标签格遍按行切并**逐格配对**（2026-08-14 三批实测）：此前用正则对扫 </td><td>，
# 非重叠消耗让「行头|姓名|空」里的「姓名|空」永远配不出来。行是组合查表的语境边界。
_TR_BLOCK = re.compile(r"<tr\b.*?</tr>", re.S | re.I)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)


def _fill_row_cells(row: str, lut: dict[str, str]) -> tuple[str, int]:
    """一行内的标签格 → 右邻**空**格写值（HTML 版，与 XML _fill_table 同规则）。
    格宽容度沿袭评审 F2 口径：th 也算格、格内允许内联标签（剥标签查表）、
    剥标签与 &nbsp; 后看不见字才算空。直查不中试行头+子标签组合（「法定代表人|姓名|_」），
    行头格自身不组合；标签取自原格文本，插进去的值不参与后续配对。"""
    cells = list(_CELL.finditer(row))
    if not cells:
        return row, 0
    head = _lab_norm(_TAG_RE.sub("", cells[0].group(1)))
    fills: dict[int, str] = {}
    for i in range(len(cells) - 1):
        lab = _lab_norm(_TAG_RE.sub("", cells[i].group(1)))
        val = lut.get(lab) or (lut.get(head + lab)
                               if head and lab and lab != head else None)
        if val and i + 1 not in fills and _INVISIBLE.fullmatch(cells[i + 1].group(1) or " "):
            fills[i + 1] = val
    if not fills:
        return row, 0
    out: list[str] = []
    last = 0
    for j, c in enumerate(cells):
        if j in fills:
            out += [row[last:c.start(1)], html_mod.escape(fills[j])]
            last = c.end(1)
    out.append(row[last:])
    return "".join(out), len(fills)
# 行尾冒号段落（与 XML 版 _fill_line_end 同形态同规则）：<p>供应商名称：</p> → 冒号后插值。
# 只认**纯文本**段落——内容里有任何标签就不动，避免命中已插过值/结构复杂的块。
# 冒号后的 &nbsp;/空白不挡填（评审三轮 F8：XML 版 rstrip 后能填，HTML 不填就是同值缝）。
_P_LINE = re.compile(r"(<p[^>]*>)([^<>]{1,24}[：:])((?:&nbsp;|\s)*)(</p>)")
_TABLE_BLOCK = re.compile(r"<table\b.*?</table>", re.S | re.I)
# HTML 侧空位在下划线之外加**长空格串**（评审三轮 F2）：模板退路的授权书空位是空格串，
# 下划线格式不进文本层，HTML 引擎认不出＝审查留白导出有值的反向同值缝。
# 查表命中才填，普通句子凑不出连续 4 个空格＋已知标签，误配面可控。
_HTML_BLANK = re.compile(r"[_＿]{2,}|[ \t　]{4,}")


# 标签别名（2026-08-14 云上导出实测 filled=0 的另一半原因）：招标落款写「供应商名称」，
# 资料库标签是「单位名称」——槽位路径有别名而普通查表路径没有。别名统一进查表本身，
# 段落/表格/HTML 三条路径一次修齐；用户自录同名标签优先（setdefault 不覆盖）。
_LABEL_ALIASES = {"供应商名称": "单位名称", "供应商全称": "单位名称", "投标人名称": "单位名称",
                  "地址": "注册地址", "联系地址": "注册地址", "电话": "联系电话",
                  # 三证合一后营业执照号=统一社会信用代码（2026-08-14 云上 b7 截图立案）
                  "营业执照号": "统一社会信用代码",
                  # 行头组合标签（「法定代表人|姓名|_」→ 法定代表人姓名）落到档案字段
                  "法定代表人姓名": "法定代表人"}


def build_lut(fields: list[tuple[str, str]], meta: dict) -> dict[str, str]:
    """字段对+项目信息 → 归一化查表（XML 填空与 HTML 填空共用同一份）。"""
    lut: dict[str, str] = {}
    for label, value in list(fields or []) + _meta_fields(meta or {}):
        key = _lab_norm(label)
        if key and value and key not in lut:
            lut[key] = str(value)
    for alias, src in _LABEL_ALIASES.items():
        val = lut.get(_lab_norm(src))
        if val:
            lut.setdefault(_lab_norm(alias), val)
    # 「联系地址和电话：」一行装两个字段（承诺函实测形态）：有啥拼啥，缺一半也比留白强
    both = [lut.get(_lab_norm(k)) for k in ("注册地址", "联系电话")]
    if any(both):
        lut.setdefault(_lab_norm("联系地址和电话"), " ".join(v for v in both if v))
    return lut


def _fill_text_token(text: str, label_buf: str, nxt: str, lut: dict[str, str]) -> tuple[str, str, int]:
    """一个文本 token 里的下划线空位/冒号槽 →（新文本, 新标签缓冲, 填空数）。
    **单遍从左到右**：空位与冒号槽按出现序合并处理，插进去的值只追加进输出、
    绝不回扫（评审 F6 实证：值里自带的【】/____ 会被后续 pass 再改写）。
    值一律 html 转义（评审 F1 实证：值里的 <>& 会碎成伪标签，编辑器 innerHTML 直接吃进去）。"""
    filled = 0
    out, pos, buf = "", 0, label_buf
    events = sorted([(m.start(), "blank", m) for m in _HTML_BLANK.finditer(text)]
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
                    val = lut.get(_lab_norm(tm.group(1)))   # 精确查表，同 XML（三轮 F3）
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

    def _tr_sub(m: "re.Match[str]") -> str:
        nonlocal filled
        new_row, n = _fill_row_cells(m.group(0), lut)
        filled += n
        return new_row

    html = _TR_BLOCK.sub(_tr_sub, html)

    def _p_line_sub(m: "re.Match[str]") -> str:
        # 本遍能看到前面遍插过值的段落，但闸在查表：整段文本（含插入值）归一后
        # 必须恰好是已知短标签才动手——已填过值的行不可能再命中，模板字符零改动不破。
        # 冒号后的空白（group 3）原样保留在值后（评审三轮 F11）。
        nonlocal filled
        label = m.group(2)[:-1]
        if not label or len(_lab_norm(label)) > _MAX_LINE_LABEL:
            return m.group(0)
        val = lut.get(_lab_norm(label))     # 精确查表，不子串（三轮 F3）
        if not val:
            return m.group(0)
        filled += 1
        return m.group(1) + m.group(2) + html_mod.escape(val) + m.group(3) + m.group(4)

    # 行尾冒号段只在**表格之外**跑（评审三轮 F1）：格内 <p>标签：</p> 的值走标签格遍
    # 邻格，这里再补一份就是双份——与 XML 版「只跑顶层段落」同一条界。
    parts: list[str] = []
    last = 0
    for m in _TABLE_BLOCK.finditer(html):
        parts += [_P_LINE.sub(_p_line_sub, html[last:m.start()]), m.group(0)]
        last = m.end()
    parts.append(_P_LINE.sub(_p_line_sub, html[last:]))
    return "".join(parts), filled
