from __future__ import annotations
import io
import logging
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt
from agent.agents.bidding_agent.schemas import DeckSpec, Slide, SlideChart, StatItem

logger = logging.getLogger(__name__)

# 共用色（不随模板变化）；模板专属色见 _TEMPLATE_TOKENS。
_SHARED = {
    "text": RGBColor(31, 41, 55),
    "muted": RGBColor(107, 114, 128),
    "white": RGBColor(255, 255, 255),
}
# 模板 → 设计 token（主色/强调色/浅底色）。企业自有母版走 render_pptx(master_bytes=...)：
# 强调色/评分点角标/页码仍取这套 token，让自绘部分和母版主题不违和。
_TEMPLATE_TOKENS = {
    "blue": {"primary": RGBColor(31, 78, 155), "accent": RGBColor(59, 130, 246), "tint": RGBColor(234, 241, 251)},
    "tech": {"primary": RGBColor(15, 118, 110), "accent": RGBColor(20, 184, 166), "tint": RGBColor(230, 246, 244)},
    "gov": {"primary": RGBColor(153, 27, 27), "accent": RGBColor(220, 38, 38), "tint": RGBColor(252, 235, 235)},
}

_SLIDE_W, _SLIDE_H = Inches(13 + 1 / 3), Inches(7.5)  # 12192000 / 6858000 EMU：标准 16:9
_MARGIN = Inches(0.7)
_CONTENT_W = _SLIDE_W - 2 * _MARGIN


def _slide_size(slide) -> tuple[int, int]:
    """该幻灯片所属演示文稿的真实页面尺寸（EMU）。
    企业母版路径**沿用客户自己的页面尺寸**（_render_on_master 不改 slide_width/height），
    死写 16:9 常量在 4:3 母版（10in 宽）上会把图表推出页面 2.63in——约四分之一被裁掉
    （评审实测复现）。取不到就退回 16:9 常量，与空白设计路径一致。"""
    try:
        pres = slide.part.package.presentation_part.presentation
        return pres.slide_width, pres.slide_height
    except Exception:      # noqa: BLE001 拿不到尺寸绝不能让整份述标渲染失败
        logger.warning("读取母版页面尺寸失败，按 16:9 常量绘制", exc_info=True)
        return _SLIDE_W, _SLIDE_H


def _content_box(slide) -> tuple[int, int, int]:
    """(左边距, 正文可用宽, 页高)：新增版式（分隔页/图表/对比）统一用它算几何，别再取全局常量。"""
    w, h = _slide_size(slide)
    return _MARGIN, w - 2 * _MARGIN, h


def _tokens_for(template: str | None, deck_template: str) -> dict:
    """模板名 → 完整 token 表（含共用色）；非法模板名回退 deck.template，再回退 blue。"""
    key = template if template in _TEMPLATE_TOKENS else deck_template
    return {**_SHARED, **_TEMPLATE_TOKENS.get(key, _TEMPLATE_TOKENS["blue"])}


def _blend_toward(base: RGBColor, target: RGBColor, ratio: float) -> RGBColor:
    """按比例把 base 色向 target 混合（无法用 pptx 做透明度，用混色近似“80% 透明白”视觉效果）。"""
    return RGBColor(*(round(b * (1 - ratio) + t * ratio) for b, t in zip(base, target)))


def _rect(slide, left, top, width, height, fill_rgb, *, line_rgb=None, line_pt=None):
    """无框（或指定描边）的纯色矩形，封面色带/分隔线/强调条/标题小方块共用。"""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_rgb
    if line_rgb is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line_rgb
        shape.line.width = line_pt or Pt(0.75)
    return shape


def _textbox(slide, left, top, width, height, lines, *, size, color, bold=False, align=None):
    """单个文本框，lines 逐行成段；每段单 run（够用且最稳），字号/颜色/加粗/对齐统一设置。"""
    tf = slide.shapes.add_textbox(left, top, width, height).text_frame
    tf.word_wrap = True
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        if align is not None:
            p.alignment = align
        run = p.runs[0] if p.runs else p.add_run()
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
    return tf


def _accent_bar(slide, accent_rgb):
    """封面/结束页底部的通栏细强调条（0.06in）。"""
    _rect(slide, 0, _SLIDE_H - Inches(0.06), _SLIDE_W, Inches(0.06), accent_rgb)


def _render_cover(slide, s: Slide, tokens: dict) -> None:
    """封面页：上部 62% 主色色带（标题 40pt 加粗白 + “述标演示” 强调白），色带下方 bullets 作副标题/元信息行。"""
    band_h = _SLIDE_H * 0.62
    _rect(slide, 0, 0, _SLIDE_W, band_h, tokens["primary"])
    _textbox(slide, Inches(0.9), Inches(1.0), _SLIDE_W - Inches(1.8), Inches(1.8),
              [s.title], size=40, color=tokens["white"], bold=True)
    kicker_color = _blend_toward(tokens["white"], tokens["accent"], 0.25)
    _textbox(slide, Inches(0.9), Inches(2.85), Inches(6), Inches(0.5),
              ["述标演示"], size=18, color=kicker_color)
    if s.bullets:
        _textbox(slide, Inches(0.9), band_h + Inches(0.25), _SLIDE_W - Inches(1.8), Inches(2.0),
                  s.bullets, size=14, color=tokens["muted"])
    _accent_bar(slide, tokens["accent"])


def _title_row(slide, title: str, tokens: dict) -> None:
    """正文页标题行：左侧主色小方块 + 标题文字，下接一条强调色分隔线。"""
    _rect(slide, _MARGIN, Inches(0.62), Inches(0.18), Inches(0.18), tokens["primary"])
    _textbox(slide, _MARGIN + Inches(0.3), Inches(0.5), _CONTENT_W - Inches(0.3), Inches(0.55),
              [title], size=24, color=tokens["text"], bold=True)
    _rect(slide, _MARGIN, Inches(1.15), _CONTENT_W, Pt(1), tokens["accent"])


_CARD_GAP = Inches(0.16)
_CARD_MAX_H = Inches(1.3)
_BADGE = Inches(0.34)


def _body_band(slide) -> tuple[int, int]:
    """正文区上下沿：下沿按页高算，给底部的评分点角标/页码留出 1.2in（母版页高不同也不会压住）。"""
    _, _, sh = _content_box(slide)
    return Inches(1.45), sh - Inches(1.2)


def _card_geometry(n: int, top: int, bottom: int) -> tuple[int, int]:
    """n 张卡片在 [top, bottom] 内的 (高度, 起始 y)：等分但封顶，整体垂直居中。
    封顶是为了 2 条要点时不出现两张 2.4in 的巨块；居中是为了消灭「内容挤在顶部、下面 60%
    全白」——用户原话「太素」，一半原因就是这片空白（4 条要点只占顶部约 25%）。"""
    area = bottom - top
    h = min(_CARD_MAX_H, int((area - (n - 1) * _CARD_GAP) / n))
    stack = n * h + (n - 1) * _CARD_GAP
    return h, top + int((area - stack) / 2)


def _bullet_card(slide, left, top, width, height, idx: int, text: str, tokens: dict) -> None:
    """单条要点卡片：浅底圆角块 + 左侧强调色序号徽章 + 垂直居中的要点文字。
    比裸文字列表多出层次与节奏，且全部是原生形状——用户仍可在 PowerPoint 里逐个改。"""
    card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    card.fill.solid()
    card.fill.fore_color.rgb = tokens["tint"]
    card.line.fill.background()
    badge = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left + Inches(0.18),
                                   top + int((height - _BADGE) / 2), _BADGE, _BADGE)
    badge.fill.solid()
    badge.fill.fore_color.rgb = tokens["accent"]
    badge.line.fill.background()
    btf = badge.text_frame
    btf.margin_left = btf.margin_right = btf.margin_top = btf.margin_bottom = 0
    bp = btf.paragraphs[0]
    bp.text = str(idx)
    bp.alignment = PP_ALIGN.CENTER
    brun = bp.runs[0] if bp.runs else bp.add_run()
    brun.font.size = Pt(13)
    brun.font.bold = True
    brun.font.color.rgb = tokens["white"]
    tf = card.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left, tf.margin_right = Inches(0.72), Inches(0.2)
    p = tf.paragraphs[0]
    p.text = text
    p.alignment = PP_ALIGN.LEFT
    run = p.runs[0] if p.runs else p.add_run()
    run.font.size = Pt(14)
    run.font.color.rgb = tokens["text"]


def _bullets_box(slide, bullets: list[str], tokens: dict, *, left=None, width=None) -> None:
    """要点区：逐条渲成编号卡片，等距铺开并整体垂直居中（对比页左栏传 left/width 复用同款卡片）。"""
    items = [b for b in bullets if b.strip()]
    if not items:
        return
    box_left, box_w, _ = _content_box(slide)
    left = box_left if left is None else left
    width = box_w if width is None else width
    top, bottom = _body_band(slide)
    h, y0 = _card_geometry(len(items), top, bottom)
    for i, text in enumerate(items):
        _bullet_card(slide, left, y0 + i * (h + _CARD_GAP), width, h, i + 1, text, tokens)


def _chip_width(text: str) -> int:
    """评分点角标自适应宽度。
    原按 0.11in/字符估算，中文下少算三分之一：12pt 中文字符实际约 0.167in 宽，30 字标签
    估 3.3in、实需 ~4.7in——文字比框宽 1.4in，而形状文字默认居中且 word_wrap=False，
    多出的部分往两边各溢出 0.7in，左边正好顶着页边距把「评」字推出画面（用户实测每页都被裁）。
    改为按字符类型估宽（CJK/全角 0.17in、ASCII 0.085in）再留 0.4in 内边距。"""
    w = sum(0.17 if ord(c) > 0x2E80 else 0.085 for c in text)
    return int(Inches(max(2.5, min(9.0, w + 0.4))))


def _scoring_chip(slide, scoring: str, tokens: dict) -> None:
    """底部左侧圆角矩形评分点角标：浅底色 + 细强调边框 + 强调色文字。
    宽度夹到正文可用宽以内、纵向按页高定位——死写 6.55in 在页高不同的客户母版上会漂。"""
    text = f"评分点｜{scoring}"
    left, content_w, sh = _content_box(slide)
    width = min(_chip_width(text), content_w)
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, sh - Inches(0.95), width, Inches(0.5))
    shape.fill.solid()
    shape.fill.fore_color.rgb = tokens["tint"]
    shape.line.color.rgb = tokens["accent"]
    shape.line.width = Pt(0.75)
    tf = shape.text_frame
    tf.word_wrap = False
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = Inches(0.15)
    tf.margin_right = Inches(0.15)
    p = tf.paragraphs[0]
    p.text = text
    p.alignment = PP_ALIGN.LEFT   # 居中会让溢出往两边跑，左侧首字被推出画面
    run = p.runs[0] if p.runs else p.add_run()
    run.font.size = Pt(12)
    run.font.color.rgb = tokens["accent"]


def _page_number(slide, n: int, total: int, tokens: dict) -> None:
    """底部右侧页码 “n / total”，10pt 弱化灰。
    位置按幻灯片真实尺寸算：原来死写 16:9 常量，在 4:3 客户母版（10in 宽）上每一页的页码都被
    推出页面右侧近 3in（本次结构升级的三种版式都带页码，问题从"偶发"变成"每页必现"）。"""
    sw, sh = _slide_size(slide)
    _textbox(slide, sw - Inches(1.6), sh - Inches(0.85), Inches(1.2), Inches(0.4),
              [f"{n} / {total}"], size=10, color=tokens["muted"], align=PP_ALIGN.RIGHT)


def _render_section(slide, s: Slide, tokens: dict, n: int, total: int, seq: int = 1) -> None:
    """章节分隔页（述标结构性升级）：满屏主色块 + 居中大标题 + 可选一句过渡副标题（取 bullets[0]）。
    评审实测教训：所有正文页长得一模一样，评委翻到第 8 页都不知道"讲到哪个部分了"——
    按评分维度分组（项目理解/技术方案/团队业绩/服务承诺与报价/风险防控）时每组开头插一张，
    给整套述标制造视觉节奏。不对应具体评分点，不挂 scoring 角标。"""
    sw, sh = _slide_size(slide)
    _rect(slide, 0, 0, sw, sh, tokens["primary"])
    # 大号序号：只有一行居中标题时整页太空（用户反馈「太素」），用一个压在标题上方的
    # 淡色大数字撑住版面，同时给评委一个"第几部分"的强锚点。
    _textbox(slide, Inches(1.2), sh * 0.28, Inches(3.0), Inches(1.6),
              [f"{seq:02d}"], size=72, color=_blend_toward(tokens["primary"], tokens["white"], 0.38),
              bold=True)
    _rect(slide, Inches(1.25), sh * 0.545, Inches(0.9), Pt(3), tokens["accent"])
    _textbox(slide, Inches(1.2), sh * 0.575, sw - Inches(2.4), Inches(1.2),
              [s.title], size=34, color=tokens["white"], bold=True)
    if s.bullets:
        kicker_color = _blend_toward(tokens["white"], tokens["accent"], 0.25)
        # 同图表页：分隔页的过渡语也全部渲染，不静默丢弃第二句
        _textbox(slide, Inches(1.25), sh * 0.72, sw - Inches(2.5), Inches(0.8),
                  s.bullets, size=15, color=kicker_color)
    _page_number(slide, n, total, tokens)


_CHART_TYPE_MAP = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "pie": XL_CHART_TYPE.PIE,
    "line": XL_CHART_TYPE.LINE_MARKERS,
}


def _chart_colors(tokens: dict, n: int) -> list[RGBColor]:
    """图表配色取模板 token（主色/强调色），不用 Office 默认彩虹色——保持和封面/标题条同一套
    视觉语言。third+ 色用主色向白混合出的浅色阶。
    混合比例必须封顶：ratio > 1 会算出 >255 的通道值让 RGBColor 直接抛错——报价构成、岗位分布
    这类饼图 7 个类别很常见，不封顶就是「渲染整个 run 失败」（评审实测复现）。
    封顶后色阶会重复，仍比崩掉强；类别再多本来也该合并小项，不是配色问题。"""
    colors = [tokens["primary"], tokens["accent"]]
    i = 0
    while len(colors) < n:
        colors.append(_blend_toward(tokens["primary"], _SHARED["white"], min(0.85, 0.25 + 0.2 * i)))
        i += 1
    return colors[:n]


def _render_chart_body(slide, chart: SlideChart, tokens: dict) -> None:
    """图表页主体：真实 PowerPoint 图表对象（python-pptx add_chart），不是图片——评委可在
    PowerPoint 里直接编辑数值/改样式，这是"原生深度"而非"糊一张图上去"的关键差异。
    数据标签常开：评委扫一眼数字就懂，不用眯眼看坐标轴刻度。"""
    data = CategoryChartData()
    data.categories = chart.categories
    for series in chart.series:
        data.add_series(series.name, series.values)
    chart_type = _CHART_TYPE_MAP.get(chart.type, XL_CHART_TYPE.COLUMN_CLUSTERED)
    left, content_w, _ = _content_box(slide)
    area_top, area_h = Inches(1.4), Inches(4.15)
    frame = slide.shapes.add_chart(chart_type, left, area_top, content_w, area_h, data)
    gchart = frame.chart
    plot = gchart.plots[0]
    plot.has_data_labels = True
    plot.data_labels.font.size = Pt(11)
    plot.data_labels.font.color.rgb = tokens["text"]
    if chart.type == "pie":
        # 饼图只有一个 series，逐扇区（point）上色；多系列图逐 series 上色
        colors = _chart_colors(tokens, len(chart.categories))
        for i, point in enumerate(plot.series[0].points):
            point.format.fill.solid()
            point.format.fill.fore_color.rgb = colors[i % len(colors)]
        gchart.has_legend = True
    else:
        colors = _chart_colors(tokens, len(chart.series))
        for i, series in enumerate(plot.series):
            series.format.fill.solid()
            series.format.fill.fore_color.rgb = colors[i % len(colors)]
        gchart.has_legend = len(chart.series) > 1
    if gchart.has_legend:
        gchart.legend.position = XL_LEGEND_POSITION.BOTTOM
        gchart.legend.include_in_layout = False


def _stat_card(slide, left, top, width, height, item: StatItem, tokens: dict) -> None:
    """关键数字大卡片：浅底色圆角矩形，大字号数字（主色）+ 一行说明（弱化灰）。
    comparison 版式的右栏专用——把最有冲击力的对比数字从要点文字里摘出来放大，
    比埋在项目符号列表里更有说服力。"""
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = tokens["tint"]
    shape.line.color.rgb = tokens["accent"]
    shape.line.width = Pt(0.75)
    tf = shape.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = tf.margin_right = Inches(0.15)
    # 空串赋给 paragraph.text 不会产生 run，直接取 runs[0] 会 IndexError——编辑器「添加卡片」
    # 的初始值就是空串，用户没填就保存，之后每次导出都确定性崩（评审实测复现）。
    # 与 _textbox 同一防御写法：没有 run 就补一个。渲染层只保证不崩，「不许留空」由入口校验负责。
    def _line(text: str, size: int, bold: bool, color: RGBColor, first: bool) -> None:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        p.text = text
        p.alignment = PP_ALIGN.CENTER
        run = p.runs[0] if p.runs else p.add_run()
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color

    _line(item.value, 30, True, tokens["primary"], first=True)
    _line(item.label, 12, False, tokens["muted"], first=False)


def _render_comparison_body(slide, s: Slide, tokens: dict) -> None:
    """对比页主体：左栏要点（招标要求/传统方案的说明）+ 右栏 1-2 张数字大卡片（我方承诺/本方案的
    冲击力数字）。招标要求 vs 我方承诺、传统方案 vs 本方案这类内容用它，比堆一排项目符号更有说服力。"""
    left, content_w, _ = _content_box(slide)
    left_w = content_w * 0.56
    gap = Inches(0.3)
    right_left = left + left_w + gap
    right_w = content_w - left_w - gap
    _bullets_box(slide, s.bullets, tokens, left=left, width=left_w)   # 左栏与要点页同款编号卡片
    n = len(s.stats)
    card_h = Inches(2.1) if n == 2 else Inches(3.0)
    gap_v = Inches(0.3)
    top0 = Inches(1.4)
    for i, item in enumerate(s.stats):
        _stat_card(slide, right_left, top0 + i * (card_h + gap_v), right_w, card_h, item, tokens)


def _render_content(slide, s: Slide, tokens: dict, n: int, total: int) -> None:
    """正文页：标题行 + 版式化主体（bullets/chart/comparison）+ 评分点角标（可空）+ 页码。"""
    _title_row(slide, s.title, tokens)
    if s.layout == "chart" and s.chart:
        _render_chart_body(slide, s.chart, tokens)
        if s.bullets:
            # 全部渲染而非只取 [0]：提示词允许图表页带 1-2 句结论式说明，编辑器也保存全部要点，
            # 只画第一条等于用户写的第二句在 PPT 里凭空消失且毫无提示（评审）。
            note_left, note_w, _ = _content_box(slide)
            _textbox(slide, note_left, Inches(5.6), note_w, Inches(0.6),
                      s.bullets, size=13, color=tokens["muted"])
    elif s.layout == "comparison" and s.stats:
        _render_comparison_body(slide, s, tokens)
    elif s.bullets:
        _bullets_box(slide, s.bullets, tokens)
    if s.scoring:
        _scoring_chip(slide, s.scoring, tokens)
    _page_number(slide, n, total, tokens)


_AI_NOTICE = "本内容由 AI 辅助生成，仅供参考，请人工复核后使用"


def _ai_notice(slide, tokens: dict) -> None:
    """结束页底部小字（spec326 算法备案）：强调条上方一行，10pt 弱化灰、居中，两条渲染路径共用。"""
    _textbox(slide, Inches(1.0), _SLIDE_H - Inches(0.4), _SLIDE_W - Inches(2.0), Inches(0.3),
              [_AI_NOTICE], size=10, color=tokens["muted"], align=PP_ALIGN.CENTER)


def _render_end(slide, s: Slide, deck: DeckSpec, tokens: dict, n: int, total: int) -> None:
    """结束页：居中致谢标题（34pt 加粗主色）+ 项目名副标题（弱化灰）+ 底部强调条 + 页码 + AI 生成提示。"""
    title = s.title or "感谢聆听"
    _textbox(slide, Inches(1.5), Inches(3.1), _SLIDE_W - Inches(3.0), Inches(1.0),
              [title], size=34, color=tokens["primary"], bold=True, align=PP_ALIGN.CENTER)
    if deck.title:
        _textbox(slide, Inches(1.5), Inches(4.1), _SLIDE_W - Inches(3.0), Inches(0.5),
                  [deck.title], size=14, color=tokens["muted"], align=PP_ALIGN.CENTER)
    _accent_bar(slide, tokens["accent"])
    _page_number(slide, n, total, tokens)
    _ai_notice(slide, tokens)


def render_pptx(deck: DeckSpec, *, template: str | None = None,
                 master_bytes: bytes | None = None) -> bytes:
    """DeckSpec → .pptx 字节（确定性，无 LLM，§4.2.1 两段式的渲染段）。
    master_bytes=None（默认）→ 走 _render_blank，行为和产物与改造前逐字节一致。
    master_bytes 给定（企业自有 .pptx/.potx 母版）→ 尝试 _render_on_master，套用母版自身的
    主题/母版/版式/logo；母版加载或渲染过程任何异常（损坏文件、版式异常等）一律吞掉只记警告，
    回退 _render_blank——保证流水线里述标产物总能生成，不因客户母版问题整体失败。"""
    if master_bytes is not None:
        try:
            return _render_on_master(deck, template, master_bytes)
        except Exception:
            logger.warning("企业母版渲染失败，回退空白设计", exc_info=True)
    return _render_blank(deck, template)


def _render_blank(deck: DeckSpec, template: str | None) -> bytes:
    """空白设计路径（改造前的 render_pptx 原样保留）：16:9，模板色系（blue/tech/gov）决定封面色带/
    标题小方块/分隔线/评分点角标/底部强调条的配色；页码统计 content+end 页（封面不计分母/不显示页码）；
    口播稿写入备注页。"""
    tokens = _tokens_for(template, deck.template)
    prs = Presentation()
    prs.slide_width, prs.slide_height = _SLIDE_W, _SLIDE_H
    blank = prs.slide_layouts[6]
    total = sum(1 for s in deck.slides if s.kind != "cover")
    n = sec = 0
    for s in deck.slides:
        slide = prs.slides.add_slide(blank)
        if s.kind == "cover":
            _render_cover(slide, s, tokens)
        elif s.kind == "section":
            n += 1
            sec += 1
            _render_section(slide, s, tokens, n, total, sec)
        elif s.kind == "end":
            n += 1
            _render_end(slide, s, deck, tokens, n, total)
        else:
            n += 1
            _render_content(slide, s, tokens, n, total)
        if s.notes:
            slide.notes_slide.notes_text_frame.text = s.notes
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def _clear_slides(prs: Presentation) -> None:
    """删掉母版自带的示例页：既摘除 sldIdLst 引用也 drop 对应关系，让 slide part 在包里彻底
    不可达（只摘 sldIdLst 会留下孤儿 part，新增页可能复用同一 partname 导致 zip 内重名）。
    masters/layouts/theme 不在这条关系链上，不受影响。"""
    sld_id_lst = prs.slides._sldIdLst
    for sld_id in list(sld_id_lst):
        prs.part.drop_rel(sld_id.rId)
        sld_id_lst.remove(sld_id)


def _pick_content_layout(layouts: list) -> object:
    """内容版式启发式：优先名字含“Title and Content”/“content”；否则 index 1；
    否则名字含“blank”；否则 index 5/6；否则退回 index 0（layouts 非空由调用方保证）。"""
    for layout in layouts:
        if "content" in (layout.name or "").lower():
            return layout
    if len(layouts) > 1:
        return layouts[1]
    for layout in layouts:
        if "blank" in (layout.name or "").lower():
            return layout
    for idx in (5, 6):
        if len(layouts) > idx:
            return layouts[idx]
    return layouts[0]


def _pick_layouts(prs: Presentation) -> tuple:
    """从母版版式里选（标题版式, 内容版式）：标题版式优先 index 0（封面/结束页共用）。"""
    layouts = list(prs.slide_layouts)
    if not layouts:
        raise ValueError("母版没有可用版式")
    return layouts[0], _pick_content_layout(layouts)


_BODY_PLACEHOLDER_TYPES = (PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT, PP_PLACEHOLDER.SUBTITLE)


def _title_placeholder(slide):
    """母版标题占位符（idx=0/TITLE 类型），没有则 None。"""
    return slide.shapes.title


def _body_placeholder(slide):
    """母版正文/副标题占位符（非标题的 BODY/OBJECT/SUBTITLE 类型），没有则 None。"""
    for ph in slide.placeholders:
        if ph.placeholder_format.idx != 0 and ph.placeholder_format.type in _BODY_PLACEHOLDER_TYPES:
            return ph
    return None


def _fill_body_bullets(ph, bullets: list[str]) -> None:
    """把要点逐条写进母版正文占位符，一条一段（不加“• ”前缀，列表符号交给母版自身样式）。"""
    tf = ph.text_frame
    tf.clear()
    for i, bullet in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = bullet


def _render_cover_on_master(slide, s: Slide, tokens: dict) -> None:
    """封面页（母版路径）：有标题占位符就写标题（+ 正文/副标题占位符写 bullets）；
    没有占位符则整页退回空白设计的封面绘制（色带+标题+副标题+强调条），版式换汤不换药。"""
    title_ph = _title_placeholder(slide)
    if title_ph is None:
        _render_cover(slide, s, tokens)
        return
    title_ph.text_frame.text = s.title
    body_ph = _body_placeholder(slide)
    if body_ph is not None and s.bullets:
        _fill_body_bullets(body_ph, s.bullets)


def _render_content_on_master(slide, s: Slide, tokens: dict, n: int, total: int) -> None:
    """正文页（母版路径）：标题优先落母版占位符，缺失则退回空白设计同款绘制。
    图表/对比版式的主体客户母版不会自带对应占位符，恒定自绘（同评分点角标/页码的既有做法）；
    只有 bullets 版式才尝试母版正文占位符，缺失同样退回空白设计同款绘制。"""
    title_ph = _title_placeholder(slide)
    if title_ph is not None:
        title_ph.text_frame.text = s.title
    else:
        _title_row(slide, s.title, tokens)
    if s.layout == "chart" and s.chart:
        _render_chart_body(slide, s.chart, tokens)
        if s.bullets:
            # 全部渲染而非只取 [0]：提示词允许图表页带 1-2 句结论式说明，编辑器也保存全部要点，
            # 只画第一条等于用户写的第二句在 PPT 里凭空消失且毫无提示（评审）。
            note_left, note_w, _ = _content_box(slide)
            _textbox(slide, note_left, Inches(5.6), note_w, Inches(0.6),
                      s.bullets, size=13, color=tokens["muted"])
    elif s.layout == "comparison" and s.stats:
        _render_comparison_body(slide, s, tokens)
    elif s.bullets:
        body_ph = _body_placeholder(slide)
        if body_ph is not None:
            _fill_body_bullets(body_ph, s.bullets)
        else:
            _bullets_box(slide, s.bullets, tokens)
    if s.scoring:
        _scoring_chip(slide, s.scoring, tokens)
    _page_number(slide, n, total, tokens)


def _render_end_on_master(slide, s: Slide, tokens: dict, n: int, total: int) -> None:
    """结束页（母版路径）：标题占位符写致谢语；缺失则退回空白设计的居中致谢绘制。
    页码恒定自绘；AI 生成提示恒定自绘（母版版式不会自带，两路径视觉一致）。"""
    title = s.title or "感谢聆听"
    title_ph = _title_placeholder(slide)
    if title_ph is not None:
        title_ph.text_frame.text = title
    else:
        _textbox(slide, Inches(1.5), Inches(3.1), _SLIDE_W - Inches(3.0), Inches(1.0),
                  [title], size=34, color=tokens["primary"], bold=True, align=PP_ALIGN.CENTER)
    _page_number(slide, n, total, tokens)
    _ai_notice(slide, tokens)


def _render_on_master(deck: DeckSpec, template: str | None, master_bytes: bytes) -> bytes:
    """企业母版路径：加载客户 .pptx/.potx，清空母版自带示例页只留 masters/layouts/theme，
    再用母版自身版式承载我们的封面/正文/结束页（标题/正文占位符优先，缺失退回空白设计同款绘制）。
    不强制 16:9——沿用母版自身的页面尺寸（prs.slide_width/height 不改）。"""
    tokens = _tokens_for(template, deck.template)
    prs = Presentation(io.BytesIO(master_bytes))
    _clear_slides(prs)
    title_layout, content_layout = _pick_layouts(prs)
    total = sum(1 for s in deck.slides if s.kind != "cover")
    n = sec = 0
    for s in deck.slides:
        if s.kind == "cover":
            slide = prs.slides.add_slide(title_layout)
            _render_cover_on_master(slide, s, tokens)
        elif s.kind == "section":
            # 章节分隔页需要整页满色块自绘，客户母版的占位符不适合这种版式——沿用 title_layout
            # 只借它的页面尺寸/主题环境，视觉内容完全自绘（与空白设计路径一致）。
            n += 1
            sec += 1
            slide = prs.slides.add_slide(title_layout)
            _render_section(slide, s, tokens, n, total, sec)
        elif s.kind == "end":
            n += 1
            slide = prs.slides.add_slide(title_layout)
            _render_end_on_master(slide, s, tokens, n, total)
        else:
            n += 1
            slide = prs.slides.add_slide(content_layout)
            _render_content_on_master(slide, s, tokens, n, total)
        if s.notes:
            slide.notes_slide.notes_text_frame.text = s.notes
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()
