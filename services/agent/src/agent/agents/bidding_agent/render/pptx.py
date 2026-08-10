from __future__ import annotations
import io
import logging
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt
from agent.agents.bidding_agent.render.pptx_blocks import (
    SLIDE_H, SLIDE_W, accent_bar, blend_toward, body_band, bullets_box, content_box,
    paint_surface, rect, render_cover, rounded_rect, slide_size, textbox, title_row,
)
from agent.agents.bidding_agent.render.styles import is_dark, on_primary, tokens_for
from agent.agents.bidding_agent.schemas import DeckSpec, Slide, SlideChart, StatItem

logger = logging.getLogger(__name__)

# 本模块只管 deck 的组装与「每套模板长得一样」的那些部件（图表/数字卡/评分点角标/页码/
# 分隔页/结束页）。模板之间真正不同的封面、标题行、要点卡三族画法在 render/pptx_blocks.py，
# 配色与结构开关在 render/styles.py。企业自有母版走 render_pptx(master_bytes=...)：
# 强调色/评分点角标/页码仍取这套 token，让自绘部分和母版主题不违和。


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
    left, content_w, sh = content_box(slide)
    width = min(_chip_width(text), content_w)
    shape = rounded_rect(slide, left, sh - Inches(0.95), width, Inches(0.5), tokens["tint"],
                         line_rgb=tokens["accent"], line_pt=Pt(0.75))
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
    推出页面右侧近 3in（三种版式都带页码，问题从"偶发"变成"每页必现"）。"""
    sw, sh = slide_size(slide)
    textbox(slide, sw - Inches(1.6), sh - Inches(0.85), Inches(1.2), Inches(0.4),
            [f"{n} / {total}"], size=10, color=tokens["muted"], align=PP_ALIGN.RIGHT)


def _render_section(slide, s: Slide, tokens: dict, n: int, total: int, seq: int = 1) -> None:
    """章节分隔页（述标结构性升级）：满屏主色块 + 居中大标题 + 可选一句过渡副标题（取 bullets[0]）。
    评审实测教训：所有正文页长得一模一样，评委翻到第 8 页都不知道"讲到哪个部分了"——
    按评分维度分组（项目理解/技术方案/团队业绩/服务承诺与报价/风险防控）时每组开头插一张，
    给整套述标制造视觉节奏。不对应具体评分点，不挂 scoring 角标。
    深色模板换一套底：它的 primary 是亮青绿，整页铺满就是一张刺眼的荧光页夹在深色正文页之间
    （实测投影下更糟），改用卡片底色当分隔页的地，强调色只留给短线和序号。"""
    sw, sh = slide_size(slide)
    dark = is_dark(tokens)
    ground = tokens["tint"] if dark else tokens["primary"]
    fg = tokens["text"] if dark else tokens["white"]
    rect(slide, 0, 0, sw, sh, ground)
    # 大号序号：只有一行居中标题时整页太空（用户反馈「太素」），用一个压在标题上方的
    # 淡色大数字撑住版面，同时给评委一个"第几部分"的强锚点。
    textbox(slide, Inches(1.2), sh * 0.28, Inches(3.0), Inches(1.6),
            [f"{seq:02d}"], size=72, color=blend_toward(ground, fg, 0.38), bold=True)
    rect(slide, Inches(1.25), sh * 0.545, Inches(0.9), Pt(3), tokens["accent"])
    textbox(slide, Inches(1.2), sh * 0.575, sw - Inches(2.4), Inches(1.2),
            [s.title], size=34, color=fg, bold=True)
    if s.bullets:
        # 同图表页：分隔页的过渡语也全部渲染，不静默丢弃第二句
        textbox(slide, Inches(1.25), sh * 0.72, sw - Inches(2.5), Inches(0.8),
                s.bullets, size=15, color=blend_toward(fg, tokens["accent"], 0.25))
    _page_number(slide, n, total, tokens)


_CHART_TYPE_MAP = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "pie": XL_CHART_TYPE.PIE,
    "line": XL_CHART_TYPE.LINE_MARKERS,
}


def _chart_colors(tokens: dict, n: int) -> list[RGBColor]:
    """图表配色取模板 token（主色/强调色），不用 Office 默认彩虹色——保持和封面/标题条同一套
    视觉语言。third+ 色是主色向白混出的色阶，混合比例按底色封顶：
      浅底模板封顶 0.45——扇区要一直够深，压在上面的白色数值标签才看得见；
      深底模板封顶 0.70——扇区要一直够亮，压在上面的深色数值标签才看得见。
    （封顶还有一条硬理由：ratio > 1 会算出 >255 的通道值让 RGBColor 直接抛错，报价构成、
    岗位分布这类 7 个类别的饼图很常见，不封顶就是「渲染整个 run 失败」，评审实测复现。）
    封顶后色阶会重复，仍比崩掉或糊掉强；类别再多本来也该合并小项，不是配色问题。"""
    colors = [tokens["primary"], tokens["accent"]]
    cap = 0.70 if is_dark(tokens) else 0.45
    i = 0
    while len(colors) < n:
        colors.append(blend_toward(tokens["primary"], tokens["white"], min(cap, 0.25 + 0.2 * i)))
        i += 1
    return colors[:n]


def _paint_pie(plot, tokens: dict, n_categories: int) -> None:
    """饼图逐扇区（point）上色；数值标签压在扇区上，整张图统一用 on_primary 当字色。
    为什么不逐扇区配字色、也不把标签移到扇区外：这两种写法 PowerPoint 认，预览用的渲染器
    都不认（实测逐扇区字色被整体忽略、outEnd 照样画在扇区里）。既然只能有一种字色，
    就靠 _chart_colors 把扇区限制在同一明度带里，让这一种字色在每个扇区上都压得住。"""
    colors = _chart_colors(tokens, n_categories)
    for i, point in enumerate(plot.series[0].points):
        point.format.fill.solid()
        point.format.fill.fore_color.rgb = colors[i % len(colors)]
    plot.data_labels.font.color.rgb = on_primary(tokens)


def _chart_title(gchart, chart: SlideChart, tokens: dict) -> None:
    """单系列图（饼图/单柱图）显式写图表标题并配色。
    两个渲染器都会给单系列图自动补一个黑色标题，而"不要自动标题"的开关只有 PowerPoint 认，
    预览渲染器照画不误——深色模板下就是一行黑压黑的字。干脆自己写一个受控的。"""
    if len(chart.series) != 1:
        gchart.has_title = False
        return
    gchart.has_title = True
    p = gchart.chart_title.text_frame.paragraphs[0]
    p.text = chart.series[0].name
    run = p.runs[0] if p.runs else p.add_run()
    run.font.size = Pt(12)
    run.font.bold = False
    run.font.color.rgb = tokens["muted"]


def _render_chart_body(slide, chart: SlideChart, tokens: dict, *, has_note: bool = False) -> None:
    """图表页主体：真实 PowerPoint 图表对象（python-pptx add_chart），不是图片——评委可在
    PowerPoint 里直接编辑数值/改样式，这是"原生深度"而非"糊一张图上去"的关键差异。
    数据标签常开：评委扫一眼数字就懂，不用眯眼看坐标轴刻度。
    图表撑满整个正文带（没有结论说明时连那 0.8in 也一并吃掉）：原来固定 4.05in 高，
    图表下方到评分点角标之间空出近 1in 死白，一页里最该看的东西反而缩在上半页。"""
    data = CategoryChartData()
    data.categories = chart.categories
    for series in chart.series:
        data.add_series(series.name, series.values)
    chart_type = _CHART_TYPE_MAP.get(chart.type, XL_CHART_TYPE.COLUMN_CLUSTERED)
    left, content_w, _ = content_box(slide)
    area_top, bottom = body_band(slide)
    area_h = bottom - area_top - (Inches(0.8) if has_note else 0)
    frame = slide.shapes.add_chart(chart_type, left, area_top, content_w, area_h, data)
    gchart = frame.chart
    # 坐标轴文字统一走模板正文色：Office 默认黑字，深色模板下整套刻度直接黑压黑看不见
    gchart.font.color.rgb = tokens["text"]
    _chart_title(gchart, chart, tokens)
    plot = gchart.plots[0]
    plot.has_data_labels = True
    plot.data_labels.font.size = Pt(11)
    plot.data_labels.font.color.rgb = tokens["text"]
    if chart.type == "pie":
        _paint_pie(plot, tokens, len(chart.categories))
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
        # 图例字色必须单独设：它不继承图表级 txPr，深色模板下整排图例是黑字（实测糊在底色里）
        gchart.legend.font.size = Pt(11)
        gchart.legend.font.color.rgb = tokens["text"]


def _stat_card(slide, left, top, width, height, item: StatItem, tokens: dict) -> None:
    """关键数字大卡片：浅底色圆角矩形，大字号数字（主色）+ 一行说明（弱化灰）。
    comparison 版式的右栏专用——把最有冲击力的对比数字从要点文字里摘出来放大，
    比埋在项目符号列表里更有说服力。深色模板的数字取强调色：主色本身就是亮青绿，
    但在深底卡片上仍是最跳的一档。"""
    shape = rounded_rect(slide, left, top, width, height, tokens["tint"],
                         line_rgb=tokens["accent"], line_pt=Pt(0.75))
    tf = shape.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = tf.margin_right = Inches(0.15)
    # 空串赋给 paragraph.text 不会产生 run，直接取 runs[0] 会 IndexError——编辑器「添加卡片」
    # 的初始值就是空串，用户没填就保存，之后每次导出都确定性崩（评审实测复现）。
    # 与 textbox 同一防御写法：没有 run 就补一个。渲染层只保证不崩，「不许留空」由入口校验负责。
    def _line(text: str, size: int, bold: bool, color: RGBColor, first: bool) -> None:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        p.text = text
        p.alignment = PP_ALIGN.CENTER
        run = p.runs[0] if p.runs else p.add_run()
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color

    _line(item.value, 30, True, tokens["accent"] if is_dark(tokens) else tokens["primary"], first=True)
    _line(item.label, 12, False, tokens["muted"], first=False)


def _render_comparison_body(slide, s: Slide, tokens: dict) -> None:
    """对比页主体：左栏要点（招标要求/传统方案的说明）+ 右栏 1-2 张数字大卡片（我方承诺/本方案的
    冲击力数字）。招标要求 vs 我方承诺、传统方案 vs 本方案这类内容用它，比堆一排项目符号更有说服力。"""
    left, content_w, _ = content_box(slide)
    left_w = content_w * 0.56
    gap = Inches(0.3)
    right_left = left + left_w + gap
    right_w = content_w - left_w - gap
    bullets_box(slide, s.bullets, tokens, left=left, width=left_w)   # 左栏与要点页同款卡片
    n = len(s.stats)
    card_h = Inches(2.1) if n == 2 else Inches(3.0)
    gap_v = Inches(0.3)
    top0 = Inches(1.5)
    for i, item in enumerate(s.stats):
        _stat_card(slide, right_left, top0 + i * (card_h + gap_v), right_w, card_h, item, tokens)


def _chart_note(slide, bullets: list[str], tokens: dict) -> None:
    """图表下方的结论式说明：全部渲染而非只取 [0]——提示词允许图表页带 1-2 句结论，编辑器也
    保存全部要点，只画第一条等于用户写的第二句在 PPT 里凭空消失且毫无提示（评审）。
    纵向按正文带下沿定位，母版页高不同也不会压在图表上。"""
    left, width, _ = content_box(slide)
    _, bottom = body_band(slide)
    textbox(slide, left, bottom - Inches(0.7), width, Inches(0.6), bullets,
            size=13, color=tokens["muted"])


def _render_content(slide, s: Slide, tokens: dict, n: int, total: int, kicker: str = "") -> None:
    """正文页：标题行 + 版式化主体（bullets/chart/comparison）+ 评分点角标（可空）+ 页码。"""
    title_row(slide, s.title, tokens, index=n, kicker=kicker)
    if s.layout == "chart" and s.chart:
        _render_chart_body(slide, s.chart, tokens, has_note=bool(s.bullets))
        if s.bullets:
            _chart_note(slide, s.bullets, tokens)
    elif s.layout == "comparison" and s.stats:
        _render_comparison_body(slide, s, tokens)
    elif s.bullets:
        bullets_box(slide, s.bullets, tokens)
    if s.scoring:
        _scoring_chip(slide, s.scoring, tokens)
    _page_number(slide, n, total, tokens)


_AI_NOTICE = "本内容由 AI 辅助生成，仅供参考，请人工复核后使用"


def _ai_notice(slide, tokens: dict) -> None:
    """结束页底部小字（spec326 算法备案）：强调条上方一行，10pt 弱化灰、居中，两条渲染路径共用。"""
    sw, sh = slide_size(slide)
    textbox(slide, sw * 0.1, sh - Inches(0.4), sw * 0.8, Inches(0.3),
            [_AI_NOTICE], size=10, color=tokens["muted"], align=PP_ALIGN.CENTER)


def _render_end(slide, s: Slide, deck: DeckSpec, tokens: dict, n: int, total: int) -> None:
    """结束页：居中致谢标题（34pt 加粗主色）+ 项目名副标题（弱化灰）+ 底部强调条 + 页码 + AI 生成提示。"""
    sw, sh = slide_size(slide)
    title = s.title or "感谢聆听"
    textbox(slide, sw * 0.12, sh * 0.41, sw * 0.76, Inches(1.0),
            [title], size=34, color=tokens["primary"], bold=True, align=PP_ALIGN.CENTER)
    if deck.title:
        textbox(slide, sw * 0.12, sh * 0.55, sw * 0.76, Inches(0.5),
                [deck.title], size=14, color=tokens["muted"], align=PP_ALIGN.CENTER)
    accent_bar(slide, tokens["accent"])
    _page_number(slide, n, total, tokens)
    _ai_notice(slide, tokens)


def render_pptx(deck: DeckSpec, *, template: str | None = None,
                 master_bytes: bytes | None = None) -> bytes:
    """DeckSpec → .pptx 字节（确定性，无 LLM，§4.2.1 两段式的渲染段）。
    master_bytes=None（默认）→ 走 _render_blank。
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
    """空白设计路径：16:9，模板（blue/tech/gov）决定封面骨架/标题行/要点卡/配色；
    页码统计 content+end 页（封面不计分母/不显示页码）；口播稿写入备注页。"""
    tokens = tokens_for(template, deck.template)
    prs = Presentation()
    prs.slide_width, prs.slide_height = SLIDE_W, SLIDE_H
    blank = prs.slide_layouts[6]
    total = sum(1 for s in deck.slides if s.kind != "cover")
    n = sec = 0
    for s in deck.slides:
        slide = prs.slides.add_slide(blank)
        paint_surface(slide, tokens)      # 底色必须最先画，后续形状才叠在它上面
        if s.kind == "cover":
            render_cover(slide, s, tokens)
        elif s.kind == "section":
            n += 1
            sec += 1
            _render_section(slide, s, tokens, n, total, sec)
        elif s.kind == "end":
            n += 1
            _render_end(slide, s, deck, tokens, n, total)
        else:
            n += 1
            _render_content(slide, s, tokens, n, total, deck.title)
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
    没有占位符则整页退回空白设计的封面绘制（模板自己的封面骨架），版式换汤不换药。"""
    title_ph = _title_placeholder(slide)
    if title_ph is None:
        render_cover(slide, s, tokens)
        return
    title_ph.text_frame.text = s.title
    body_ph = _body_placeholder(slide)
    if body_ph is not None and s.bullets:
        _fill_body_bullets(body_ph, s.bullets)


def _render_content_on_master(slide, s: Slide, tokens: dict, n: int, total: int,
                              kicker: str = "") -> None:
    """正文页（母版路径）：标题优先落母版占位符，缺失则退回空白设计同款绘制。
    图表/对比版式的主体客户母版不会自带对应占位符，恒定自绘（同评分点角标/页码的既有做法）；
    只有 bullets 版式才尝试母版正文占位符，缺失同样退回空白设计同款绘制。"""
    title_ph = _title_placeholder(slide)
    if title_ph is not None:
        title_ph.text_frame.text = s.title
    else:
        title_row(slide, s.title, tokens, index=n, kicker=kicker)
    if s.layout == "chart" and s.chart:
        _render_chart_body(slide, s.chart, tokens, has_note=bool(s.bullets))
        if s.bullets:
            _chart_note(slide, s.bullets, tokens)
    elif s.layout == "comparison" and s.stats:
        _render_comparison_body(slide, s, tokens)
    elif s.bullets:
        body_ph = _body_placeholder(slide)
        if body_ph is not None:
            _fill_body_bullets(body_ph, s.bullets)
        else:
            bullets_box(slide, s.bullets, tokens)
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
        sw, sh = slide_size(slide)
        textbox(slide, sw * 0.12, sh * 0.41, sw * 0.76, Inches(1.0),
                [title], size=34, color=tokens["primary"], bold=True, align=PP_ALIGN.CENTER)
    _page_number(slide, n, total, tokens)
    _ai_notice(slide, tokens)


def _render_on_master(deck: DeckSpec, template: str | None, master_bytes: bytes) -> bytes:
    """企业母版路径：加载客户 .pptx/.potx，清空母版自带示例页只留 masters/layouts/theme，
    再用母版自身版式承载我们的封面/正文/结束页（标题/正文占位符优先，缺失退回空白设计同款绘制）。
    不强制 16:9——沿用母版自身的页面尺寸（prs.slide_width/height 不改）。"""
    tokens = tokens_for(template, deck.template)
    prs = Presentation(io.BytesIO(master_bytes))
    _clear_slides(prs)
    title_layout, content_layout = _pick_layouts(prs)
    total = sum(1 for s in deck.slides if s.kind != "cover")
    n = sec = 0
    # 母版路径不铺底色：客户母版自带背景/底纹/logo，盖上去等于把人家的设计糊掉。
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
            _render_content_on_master(slide, s, tokens, n, total, deck.title)
        if s.notes:
            slide.notes_slide.notes_text_frame.text = s.notes
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()
