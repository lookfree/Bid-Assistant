from __future__ import annotations
import io
from bs4 import BeautifulSoup
from docx import Document

_CONTAINERS = ("div", "section", "article", "body")


def _emit_el(doc: Document, el) -> None:
    """单个 HTML 元素 → docx：h1–h4→Heading2、p→段落、ul/li→项目符号、table→表格；
    容器标签（div 等）递归展开，防止整块被 get_text 压扁成一段。"""
    name = getattr(el, "name", None)
    if name in ("h1", "h2", "h3", "h4"):
        doc.add_heading(el.get_text(strip=True), level=2)
    elif name == "p":
        doc.add_paragraph(el.get_text(strip=True))
    elif name == "ul":
        for li in el.find_all("li", recursive=False):
            doc.add_paragraph(li.get_text(strip=True), style="List Bullet")
    elif name == "table":
        rows = el.find_all("tr")
        if rows:
            # 列数取所有行最大值：模型产出的表格行列可能参差，固定取首行会越界
            cols = max(len(r.find_all(["td", "th"])) for r in rows)
            t = doc.add_table(rows=len(rows), cols=cols)
            for i, r in enumerate(rows):
                for j, c in enumerate(r.find_all(["td", "th"])):
                    t.rows[i].cells[j].text = c.get_text(strip=True)
    elif name in _CONTAINERS:
        for child in el.children:
            _emit_el(doc, child)
    elif text := el.get_text(strip=True):
        doc.add_paragraph(text)


def _emit_html(doc: Document, html: str) -> None:
    """HTML 最小映射到 docx。复杂样式（行内富文本等）为后续加固项。"""
    soup = BeautifulSoup(html or "", "html.parser")
    for el in soup.children:
        _emit_el(doc, el)


def render_docx(outline: dict, chapters: dict, *, meta: dict | None = None) -> bytes:
    """完整标书 .docx：封面 + 目录占位 + 按 outline 顺序各章正文 + 签章页。确定性，无 LLM。"""
    meta = meta or {}
    doc = Document()
    # 封面
    doc.add_heading(meta.get("name", "投标文件"), level=0)
    if meta.get("buyer"):
        doc.add_paragraph(f"采购人：{meta['buyer']}")
    if meta.get("code"):
        doc.add_paragraph(f"招标编号：{meta['code']}")
    doc.add_paragraph("投标人：____________________（盖章）")
    doc.add_page_break()
    # 目录占位
    doc.add_heading("目录", level=1)
    doc.add_paragraph("（请在 Word 中更新域以生成目录）")
    doc.add_page_break()
    # 章节正文：按 outline 顺序（缺正文出占位，不报错）
    for ch in outline.get("chapters", []):
        group = "技术标" if ch.get("group") == "tech" else "商务标"
        doc.add_heading(f"{ch.get('no', '')} {ch.get('title', '')}（{group}）", level=1)
        body = chapters.get(ch.get("id", ""), "")
        if body:
            _emit_html(doc, body)
        else:
            doc.add_paragraph("（本章正文待生成）")
    # 签章页
    doc.add_page_break()
    doc.add_heading("投标人承诺与签章", level=1)
    doc.add_paragraph("法定代表人/授权代表（签字）：____________   日期：__________")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()
