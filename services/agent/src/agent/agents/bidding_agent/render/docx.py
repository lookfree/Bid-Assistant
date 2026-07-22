from __future__ import annotations
import base64
import io
from bs4 import BeautifulSoup
from docx import Document
from agent.agents.bidding_agent.render.sanitize import strip_document_shell
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.text import WD_LINE_SPACING
from docx.shared import Cm, Inches, Pt, RGBColor

_CONTAINERS = ("div", "section", "article", "body")

# H1/H2/H3 → (磅值, 中文习惯字号名，仅注释用) 见 _apply_bid_styles
_HEADING_SIZES = {"Heading 1": Pt(16), "Heading 2": Pt(14), "Heading 3": Pt(12)}


def _apply_bid_styles(doc: Document) -> None:
    """标书排版惯例（一次性设在 Document 的样式上，覆盖 python-docx 默认模板）：
    正文宋体小四(12pt)；一/二/三级标题黑体加粗黑色——Word 默认标题走主题色蓝，
    投标文件要求严肃的黑白配色，不能保留默认蓝。
    注：服务端镜像目前只装了 fonts-noto-cjk（没有宋体/黑体字体文件），LibreOffice
    转 PDF 时找不到这两个字体名会退回 Noto CJK 渲染；用户在 Word 里打开 .docx 本身
    是原生渲染，不受影响。"""
    normal = doc.styles["Normal"]
    normal.font.name = "宋体"
    normal.font.size = Pt(12)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
    for style_name, size in _HEADING_SIZES.items():
        style = doc.styles[style_name]
        style.font.name = "黑体"
        style.font.size = size
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.element.rPr.rFonts.set(qn("w:eastAsia"), "黑体")


def _emit_el(doc: Document, el) -> None:
    """单个 HTML 元素 → docx：h1/h2→Heading2、h3/h4→Heading3、p→段落、ul/li→项目符号、
    table→表格；容器标签（div 等）递归展开，防止整块被 get_text 压扁成一段。"""
    name = getattr(el, "name", None)
    if name in ("h1", "h2", "h3", "h4"):
        # 章内小节分级：章标题占 Heading 1（目录一级），内层 h1/h2→二级、h3/h4→三级——
        # TOC 域是 \o "1-3"，此前全压成二级导致目录里章内层级不可辨。
        doc.add_heading(el.get_text(strip=True), level=2 if name in ("h1", "h2") else 3)
    elif name == "p":
        doc.add_paragraph(el.get_text(strip=True))
        for img in el.find_all("img"):  # 光标处插图常嵌在段落里，只取文字会把图整个丢掉
            _emit_el(doc, img)
    elif name == "ul":
        for li in el.find_all("li", recursive=False):
            doc.add_paragraph(li.get_text(strip=True), style="List Bullet")
    elif name == "table":
        rows = el.find_all("tr")
        if rows:
            # 列数取所有行最大值：模型产出的表格行列可能参差，固定取首行会越界
            cols = max(len(r.find_all(["td", "th"])) for r in rows)
            t = doc.add_table(rows=len(rows), cols=cols)
            t.style = "Table Grid"   # 网格线：偏差表/报价表没有边框不可读（e2e PDF 实测）
            for i, r in enumerate(rows):
                for j, c in enumerate(r.find_all(["td", "th"])):
                    t.rows[i].cells[j].text = c.get_text(strip=True)
    elif name == "img":
        # 用户在编辑器插入的图片（data URL 内嵌，spec 无外链图）：解码落图；坏图跳过不阻断整本渲染
        src = el.get("src", "")
        if src.startswith("data:image/"):
            try:
                doc.add_picture(io.BytesIO(base64.b64decode(src.split(",", 1)[1])), width=Inches(5.5))
            except Exception:  # noqa: BLE001 base64 破损/格式不支持——丢图保文
                pass
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


# project_meta 键名归一：读标 schema 里是自由 dict,历史数据用中文键(项目名称/采购编号/采购人),
# 渲染读英文键(name/code/buyer)导致封面/页眉落兜底(e2e 实测)。取值时按别名依次找。
_META_ALIASES = {
    "name": ("name", "项目名称", "项目名"),
    "code": ("code", "采购编号", "招标编号", "项目编号"),
    "buyer": ("buyer", "采购人", "招标人", "采购单位"),
}


def _norm_meta(meta: dict) -> dict:
    out = dict(meta)
    for key, aliases in _META_ALIASES.items():
        if not out.get(key):
            val = next((meta[a] for a in aliases if meta.get(a)), None)
            if val:
                out[key] = val
    return out


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


def _add_ai_notice(doc: Document) -> None:
    """文档末尾生成说明：备案要求的显式标识，导出环节自动写入（用户定稿时可自行删除）。"""
    doc.add_paragraph()
    p = doc.add_paragraph("本内容由智启元投标助手生成合成类算法辅助生成，仅供投标文件编制参考，请结合招标文件原文和企业实际情况复核确认后使用。")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for run in p.runs:
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)


# spec330 输出格式：GB 字号 → 磅值;默认参数=用户 2026-07-23 提供的口径。
# fmt=None（不传）→ 维持现行样式,与既有导出一致;传 fmt（含空 dict）→ 以默认值起底逐项覆盖。
_GB_PT = {"三号": 16, "四号": 14, "小四": 12, "五号": 10.5}
_FMT_DEFAULT = {
    "margin_cm": {"top": 2.2, "bottom": 2.2, "left": 2.3, "right": 2.3},
    "heading_font": "宋体", "heading_size": "四号", "heading_bold": True,
    "body_font": "宋体", "body_size": "小四", "body_indent_chars": 2,
    "line_spacing": 1.5,  # 1 / 1.5 / "fixed22"（固定 22 磅）
}


def _set_line_spacing(pf, spacing) -> None:
    if spacing == "fixed22":
        pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        pf.line_spacing = Pt(22)
    else:
        pf.line_spacing = float(spacing)


def _apply_custom_format(doc: Document, fmt: dict) -> None:
    """按用户输出格式覆盖样式（spec330）：A4 纵向 + 页边距 + 正文/标题字体字号缩进行距。
    只在显式传 fmt 时调用;逐项以 _FMT_DEFAULT 起底,用户改哪项覆盖哪项。"""
    f = {**_FMT_DEFAULT, **{k: v for k, v in fmt.items() if v is not None}}
    m = {**_FMT_DEFAULT["margin_cm"], **(f.get("margin_cm") or {})}
    for sec in doc.sections:
        sec.page_width, sec.page_height = Cm(21), Cm(29.7)  # A4 纵向
        sec.top_margin, sec.bottom_margin = Cm(float(m["top"])), Cm(float(m["bottom"]))
        sec.left_margin, sec.right_margin = Cm(float(m["left"])), Cm(float(m["right"]))
    body_pt = _GB_PT.get(f["body_size"], 12)
    normal = doc.styles["Normal"]
    normal.font.name = f["body_font"]
    normal.font.size = Pt(body_pt)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), f["body_font"])
    # 首行缩进 N 字符 = N × 字号;行距设在 Normal 段落格式上,全文（含标题继承前的基准）统一
    normal.paragraph_format.first_line_indent = Pt(body_pt * int(f["body_indent_chars"]))
    _set_line_spacing(normal.paragraph_format, f["line_spacing"])
    head_pt = _GB_PT.get(f["heading_size"], 14)
    for style_name in _HEADING_SIZES:
        style = doc.styles[style_name]
        style.font.name = f["heading_font"]
        style.font.size = Pt(head_pt)
        style.font.bold = bool(f["heading_bold"])
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.element.rPr.rFonts.set(qn("w:eastAsia"), f["heading_font"])
        style.paragraph_format.first_line_indent = Pt(0)  # 标题首行缩进 0 字符、左对齐
        _set_line_spacing(style.paragraph_format, f["line_spacing"])


def render_docx(outline: dict, chapters: dict, *, meta: dict | None = None,
                 package: dict | None = None,
                 credentials: list[dict] | None = None,
                 fmt: dict | None = None) -> bytes:
    """完整标书 .docx：封面 + 真目录域页 + 按 outline 顺序各章正文 + 资格证明文件附录（可选）
    + 签章页 + AI 生成提示（spec326 算法备案，恒定追加，见 _add_ai_notice）。确定性，无 LLM。
    package（选包，spec324）存在时封面项目名下加一行包件名。
    credentials（资质证照，spec325）非空时在签章页之前追加附录；缺省 None 时输出与今天一致。"""
    meta = _norm_meta(meta or {})
    doc = Document()
    _apply_bid_styles(doc)
    if fmt is not None:  # spec330 输出格式：显式配置才覆盖,缺省与既有导出一致
        _apply_custom_format(doc, fmt)
    _style_cover(doc, meta, package)
    _add_toc_field(doc)
    _add_page_number_footer(doc, meta.get("name", "投标文件"))
    # 章节正文：按 outline 顺序（缺正文出占位，不报错）
    for ch in outline.get("chapters", []):
        group = "技术标" if ch.get("group") == "tech" else "商务标"
        doc.add_heading(f"{ch.get('no', '')} {ch.get('title', '')}（{group}）", level=1)
        # 防御清洗：库存章节可能带完整文档壳（<head><style>...），不剥会把样式文本吐进正文
        body = strip_document_shell(chapters.get(ch.get("id", ""), ""))
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
    _add_ai_notice(doc)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()
