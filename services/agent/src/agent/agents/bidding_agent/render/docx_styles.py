"""导出 .docx 的样式设定（2026-08-15 自 docx.py 拆出，纯搬运——该文件触到 800 行上限）：
标书排版惯例（_apply_bid_styles）与 spec330 用户输出格式覆盖（_apply_custom_format）。"""
from docx import Document
from docx.enum.text import WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# H1-H5 → 磅值（章/节/小节/细分/明细五级，见 _apply_bid_styles）。五级都必须入表：
# 未配置的 Word 内建标题样式会继承主题蓝/西文字体（三级提纲落地时 h4 首次可达，五级后 h5 同理）。
_HEADING_SIZES = {
    "Heading 1": Pt(16), "Heading 2": Pt(14), "Heading 3": Pt(12), "Heading 4": Pt(12), "Heading 5": Pt(12),
}


def _strip_theme_fonts(style) -> None:
    """摘掉样式 rFonts 上的主题字体属性（asciiTheme/hAnsiTheme/eastAsiaTheme/cstheme）。
    OOXML 规则：主题属性**优先于**同元素上的显式 ascii/eastAsia——python-docx 默认模板的
    Heading 样式带 majorEastAsia，查看器顺着主题的日文脚本映射把章节标题解析成
    ＭＳ ゴシック（2026-08-15 用户实测：标题字体与正文不一致），显式设的黑体/宋体
    形同虚设。设字体必须同时拔掉主题引线，显式字体才真正生效。"""
    rfonts = style.element.rPr.rFonts
    for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        rfonts.attrib.pop(qn(f"w:{attr}"), None)


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
    _strip_theme_fonts(normal)
    for style_name, size in _HEADING_SIZES.items():
        style = doc.styles[style_name]
        style.font.name = "黑体"
        style.font.size = size
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.element.rPr.rFonts.set(qn("w:eastAsia"), "黑体")
        _strip_theme_fonts(style)


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
    _strip_theme_fonts(normal)
    # 首行缩进 N 字符 = N × 字号;行距设在 Normal 段落格式上,全文（含标题继承前的基准）统一。
    # 缩进溢入表格/封面/页脚的问题由各发射点显式置零解决（_emit_table 单元格、_cover_line、页脚）。
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
        _strip_theme_fonts(style)
        style.paragraph_format.first_line_indent = Pt(0)  # 标题首行缩进 0 字符、左对齐
        _set_line_spacing(style.paragraph_format, f["line_spacing"])
