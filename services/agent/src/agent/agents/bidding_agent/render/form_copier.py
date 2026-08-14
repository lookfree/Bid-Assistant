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
import io
import re

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


def _check_portable(el) -> None:
    """节点能不能安全搬运；不能则抛 CopierUnsupported（原因进异常文本，观测事件要用）。"""
    for node in el.iter():
        if node.tag == _NUMPR:
            raise CopierUnsupported("含编号列表引用（numPr）")
        if node.tag in (_A_BLIP, _V_IMAGEDATA):
            raise CopierUnsupported("含图片引用（blip/imagedata）")


def extract_form_nodes(tender_docx: bytes, span: FormSpan) -> list:
    """招标 docx 字节 + 节点区间 → 深拷贝出的 body 节点列表（只收 w:p / w:tbl）。"""
    from docx import Document

    d = Document(io.BytesIO(tender_docx))
    kids = list(d.element.body.iterchildren())
    if not (0 <= span.start <= span.end < len(kids)):
        raise CopierUnsupported(f"区间越界（{span.start}-{span.end}/{len(kids)}）")
    nodes = []
    for el in kids[span.start:span.end + 1]:
        if el.tag not in (_P_TAG, _TBL_TAG):
            continue                      # sectPr/书签等非内容节点不搬
        _check_portable(el)
        nodes.append(copy.deepcopy(el))
    if not nodes:
        raise CopierUnsupported("区间内没有可搬运的内容节点")
    return nodes


def graft_nodes(doc, nodes: list) -> None:
    """把节点接进输出文档 body 末尾（调用方先写完章标题再嫁接，顺序即版面顺序）。
    sectPr 必须留在 body 最后——插到它后面 Word 直接打不开文档。"""
    body = doc.element.body
    sect = body.find(_SECTPR)
    for el in nodes:
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
_LAB_WIDTH = str.maketrans("：（）", ":()")


def _lab_norm(text: str) -> str:
    """标签比对归一：去空白、全角冒号/括号归半角、去括注、去尾冒号。
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


def _fill_paragraph(p, lut: dict[str, str]) -> int:
    """段落型空位：「标签：」＋下划线 run（分 run 或同 run）。
    标签取**自段首或上一个空位以来**的文字——「电话：__ 传真：__」一行两位各认各的。"""
    filled = 0
    label_buf = ""
    for r in p.findall(_W_R):
        text = _run_text(r)
        if not text:
            continue
        m = _BLANK.search(text)
        if m is None:
            label_buf += text
            continue
        val = lut.get(_lab_norm(label_buf + text[:m.start()]))
        if val:
            _set_run_text(r, text[:m.start()] + val + text[m.end():])
            filled += 1
        label_buf = text[m.end():]     # 空位之后另起一段标签（无论填没填）
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


def fill_blanks(nodes: list, fields: list[tuple[str, str]], meta: dict) -> int:
    """在深拷贝出的表单节点上填空 → 命中数。值来源=资料库企业信息（用户录什么标签
    匹配什么标签，见 bidder_profile）＋项目信息白名单；同名标签先到先得；
    匹配不上一律留白——代码不虚构，这正是它比模型填空可靠的地方。"""
    lut: dict[str, str] = {}
    for label, value in list(fields or []) + _meta_fields(meta or {}):
        key = _lab_norm(label)
        if key and value and key not in lut:
            lut[key] = str(value)
    if not lut:
        return 0
    n = 0
    for el in nodes:
        if el.tag == _P_TAG:
            n += _fill_paragraph(el, lut)
        elif el.tag == _TBL_TAG:
            n += _fill_table(el, lut)
    return n
