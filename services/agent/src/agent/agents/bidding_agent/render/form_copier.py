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
