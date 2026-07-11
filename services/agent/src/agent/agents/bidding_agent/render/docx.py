from __future__ import annotations
import io
from bs4 import BeautifulSoup
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

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


def _cover_line(doc: Document, text: str, size: int) -> None:
    """封面居中一行：统一走 run 设字号，标题行调用方另设加粗。"""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(text)
    run.font.size = Pt(size)


def _style_cover(doc: Document, meta: dict, package: dict | None = None) -> None:
    """封面：居中大标题（项目名）+ 信息块（采购人/编号/日期占位）+ 投标人盖章占位。
    package 存在（选包，spec324）⇒ 项目名下加「包件：《name》」一行；未选包时逐字节不变。"""
    _cover_line(doc, meta.get("name", "投标文件"), 26)
    doc.paragraphs[-1].runs[0].bold = True
    doc.add_paragraph()
    if package and package.get("name"):
        _cover_line(doc, f"包件：《{package['name']}》", 14)
    if meta.get("buyer"):
        _cover_line(doc, f"采购人：{meta['buyer']}", 14)
    if meta.get("code"):
        _cover_line(doc, f"招标编号：{meta['code']}", 14)
    _cover_line(doc, f"日期：{meta.get('date', '____年__月__日')}", 14)
    doc.add_paragraph()
    _cover_line(doc, "投标人：____________________（盖章）", 14)
    doc.add_page_break()


def _add_field(paragraph, instr_text: str) -> None:
    """在段落里插入一个 Word 域（fldChar begin/instrText/separate/end 四件套 OXML）；
    TOC 域与页脚 PAGE 域复用同一拼接逻辑。"""
    run = paragraph.add_run()
    r = run._r
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = instr_text
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instr, separate, end):
        r.append(node)


def _add_toc_field(doc: Document) -> None:
    """真目录域（非静态文本）：TOC \\o "1-3" \\h \\z \\u。目录页码只有 Word 排版引擎知道，
    导出域交由 Word 打开时按 F9 更新，比人工维护的静态占位准确。"""
    doc.add_heading("目录", level=1)
    doc.add_paragraph("（在 Word 中按 F9 更新目录）")
    field_p = doc.add_paragraph()
    _add_field(field_p, 'TOC \\o "1-3" \\h \\z \\u')
    doc.add_page_break()


def _add_page_number_footer(doc: Document, project_name: str) -> None:
    """默认节：页眉写项目名、页脚居中 PAGE 域页码（逐页连续编码，招标方常见硬要求）。"""
    section = doc.sections[0]
    header_p = section.header.paragraphs[0]
    header_p.text = project_name
    footer_p = section.footer.paragraphs[0]
    footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _add_field(footer_p, "PAGE")


def _append_credentials(doc: Document, credentials: list[dict]) -> None:
    """资格证明文件附录（spec325）：分页 + 一级标题 + 逐条目二级标题 title + 逐图插入。
    单图 data=None（取图失败）或 add_picture 抛错（坏图）→ 占位一行「（图片加载失败：name）」，
    不影响同条目其余图片，也不影响导出整体（best-effort）。"""
    doc.add_page_break()
    doc.add_heading("资格证明文件", level=1)
    for cred in credentials:
        doc.add_heading(cred.get("title", ""), level=2)
        for img in cred.get("images", []):
            name = img.get("name", "")
            data = img.get("data")
            if data is None:
                doc.add_paragraph(f"（图片加载失败：{name}）")
                continue
            try:
                doc.add_picture(io.BytesIO(data), width=Inches(6))
            except Exception:
                doc.add_paragraph(f"（图片加载失败：{name}）")


def render_docx(outline: dict, chapters: dict, *, meta: dict | None = None,
                 package: dict | None = None,
                 credentials: list[dict] | None = None) -> bytes:
    """完整标书 .docx：封面 + 真目录域页 + 按 outline 顺序各章正文 + 资格证明文件附录（可选）
    + 签章页。确定性，无 LLM。package（选包，spec324）存在时封面项目名下加一行包件名。
    credentials（资质证照，spec325）非空时在签章页之前追加附录；缺省 None 时输出与今天一致。"""
    meta = meta or {}
    doc = Document()
    _style_cover(doc, meta, package)
    _add_toc_field(doc)
    _add_page_number_footer(doc, meta.get("name", "投标文件"))
    # 章节正文：按 outline 顺序（缺正文出占位，不报错）
    for ch in outline.get("chapters", []):
        group = "技术标" if ch.get("group") == "tech" else "商务标"
        doc.add_heading(f"{ch.get('no', '')} {ch.get('title', '')}（{group}）", level=1)
        body = chapters.get(ch.get("id", ""), "")
        if body:
            _emit_html(doc, body)
        else:
            doc.add_paragraph("（本章正文待生成）")
    if credentials:
        _append_credentials(doc, credentials)
    # 签章页
    doc.add_page_break()
    doc.add_heading("投标人承诺与签章", level=1)
    doc.add_paragraph("法定代表人/授权代表（签字）：____________   日期：__________")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()
